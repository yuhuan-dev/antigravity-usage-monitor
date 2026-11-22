import {
  closeSync, fstatSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writevSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';

const MAX_TRACKED_CACHE_FILES = 16;
const lastWritesByPath = new Map();

function isSameFile(a, b) {
  return b.ino !== 0n && a.dev === b.dev && a.ino === b.ino &&
    a.size === b.size && a.mtimeNs === b.mtimeNs;
}

function readReusableBytes(filePath, expected) {
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const before = fstatSync(fd, { bigint: true });
    if (!isSameFile(before, expected) || before.ctimeNs !== expected.ctimeNs) return null;
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    return isSameFile(before, after) && before.ctimeNs === after.ctimeNs &&
      BigInt(bytes.length) === after.size ? bytes : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// 只复用上次确认写入的步骤字节。扫描器用新数组替换变更步骤，每次仍重新序列化会话元数据。
export function writeTrajectoryCacheFile(filePath, data) {
  const previous = lastWritesByPath.get(filePath) || null;
  const bytes = previous ? readReusableBytes(filePath, previous.file) : null;
  const ranges = new WeakMap();
  const parts = [];
  let position = 0;
  function append(part) {
    const buffer = typeof part === 'string' ? Buffer.from(part) : part;
    parts.push(buffer);
    position += buffer.length;
  }

  append('{');
  let separator = '';
  for (const [id, entry] of Object.entries(data)) {
    const wrapped = Array.isArray(entry);
    const { steps, ...metadata } = wrapped ? entry[0] : entry;
    const header = JSON.stringify(metadata);
    append(`${separator}${JSON.stringify(id)}:${wrapped ? '[' : ''}${header.slice(0, -1)}${header === '{}' ? '' : ','}"steps":`);
    const range = bytes && previous.ranges.get(steps);
    const start = position;
    append(range ? bytes.subarray(range.start, range.end) : JSON.stringify(steps));
    ranges.set(steps, { start, end: position });
    append(wrapped ? '}]' : '}');
    separator = ',';
  }
  append('}');

  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporaryPath, 'wx');
    try {
      // 按块写入，避免再复制一份完整缓存到连续缓冲区。
      const batchSize = 256;
      for (let i = 0; i < parts.length; i += batchSize) {
        const batch = parts.slice(i, i + batchSize);
        const length = batch.reduce((sum, part) => sum + part.length, 0);
        if (writevSync(fd, batch) !== length) throw new Error('Incomplete cache write');
      }
    } finally {
      closeSync(fd);
    }
    const written = statSync(temporaryPath, { bigint: true });
    renameSync(temporaryPath, filePath);
    const file = statSync(filePath, { bigint: true });
    lastWritesByPath.delete(filePath);
    if (isSameFile(written, file)) {
      if (lastWritesByPath.size >= MAX_TRACKED_CACHE_FILES) {
        const oldestPath = lastWritesByPath.keys().next().value;
        if (oldestPath !== undefined) lastWritesByPath.delete(oldestPath);
      }
      lastWritesByPath.set(filePath, { filePath, file, ranges });
    }
  } finally {
    try { unlinkSync(temporaryPath); } catch {}
  }
}
