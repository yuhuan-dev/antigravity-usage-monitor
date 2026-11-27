/**
 * @fileoverview 跨端会话按需迁移器 (`session-migrator.mjs`)。
 *
 * 支持两种显式模式：
 * 1. `move`（默认「完整迁移」）：为目标端分配独立的新 `cascade_id` / `trajectory_id`（避免撞上桌面端/CLI
 *    跨端摘要镜像同步导致被自动删行或覆盖），先将源 `.db` 一致性快照备份归档，再把目标库中属于源会话的步骤
 *    `sourceTrajectoryStepInfo.cascadeId` 及 `gen_metadata` 归属 ID 结构化改写为新 ID，随后安全移出源端
 *    `.db` 及摘要行——迁入后完整保留全部历史步序（#1/#3/#5…）、上下文和调用明细，且全局仅存一份天然零重复计费；
 * 2. `clone`（可选「克隆副本」）：生成全新 UUID，源端 100% 保持不动；保留历史步骤原有的 `originCascadeId`，
 *    由 `cli-sqlite-reader.mjs` 自动跳过克隆历史步，仅统计迁入后新产生的步骤（避免跨端双倍计费）。
 *
 * 支持方向：`CLI -> App / IDE`、`App / IDE -> CLI` 以及 `旧版 IDE (.db) -> App / CLI`。
 */

import { randomUUID } from 'node:crypto';
import { extractShortPromptTitle } from '../shared/prompt-clean.mjs';
import {
  parseWorkspaceDisplayLabel,
  parseWorkspaceUrisColumn,
  toDesktopEncodedWorkspaceUri,
  toRawWorkspaceFileUri,
} from '../shared/workspace-uri.mjs';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { parseIsoMs } from '../trajectory-metrics.mjs';
import { getLocalTrajectoryCacheStore } from './config.mjs';
import { writeJsonAtomicSync } from './fs-atomic.mjs';
import {
  hasBuiltinNodeSqlite,
  normalizeSqliteIsoTime,
  withReadOnlySqliteDb,
} from './sqlite-client.mjs';
import {
  encodeProtoBytesField,
  encodeProtoStringField,
  encodeProtoTimestamp,
  encodeProtoVarintField,
  filterSummaryProtoIndex,
  patchProtoMessageFields,
  readProtoString,
  readProtoVarint,
  readSubEnd,
  skipProtoField,
  splitProtoRawFields,
  toUint8Array,
} from './proto-wire.mjs';
import { parseAnnotationPbtxtTitle } from './cli-sqlite-reader.mjs';
import {
  MAX_SIDECAR_LOG_BYTES,
  acquireStoreLock,
  expandStoreCascadeTargets,
  filterHistoryJsonlBuffer,
  filterLogLinesContainingIds,
  findMatchingSidecarEventRelPaths,
} from './session-cleaner.mjs';
import {
  SESSION_CLIENT_DEFS,
  SESSION_UUID_RE,
  decodeMetaBlobLight,
  deleteConversationParentsByIds,
  detectRunningClients,
  extractDesktopProjectsFromSummaryMap,
  getSessionClientDef,
  isDbLightSubagent,
  isSummarySubagent,
  normalizeSessionUuid,
  recordMigrationProtectionLink,
  resolveGeminiDir,
  resolveMigrationBackupRoot,
  resolveNoFollowFile,
  resolveNoFollowPath,
  resolveScopedTrajectoryCacheStore,
  sumVerifiedDirTreeBytes,
  withWritableSqliteDb,
} from './session-store.mjs';

const MIGRATOR_MAX_SESSIONS_PER_CLIENT = 5000;
const MIGRATOR_MAX_COLD_DB_INSPECTS = 120;
const MIGRATOR_MAX_BATCH_SIZE = 50;
const MIGRATOR_MAX_BACKUPS = 5;
const MIGRATOR_MAX_ARCHIVED_SOURCES = 20;
const MIGRATOR_OUTSIDE_PROJECT_ID = 'outside-of-project';
const MIGRATOR_CLI_PROJECT_ID = 'default-cli-project';

function migratorFormatSqliteUtcTime(epochMs) {
  const date = new Date(Number.isFinite(Number(epochMs)) && Number(epochMs) > 0 ? Number(epochMs) : Date.now());
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.` +
    `${pad(date.getUTCMilliseconds(), 3)}0000+00:00`
  );
}

/**
 * 将 `file://` URI 或本地路径规整为未转义冒号的原始 `file:///` URI（供 Workspace `fn 1`/`fn 2` 及 CLI 摘要使用）。
 *
 * @param {string} rawInput
 * @returns {string}
 */
export function migratorToRawFileUri(rawInput) {
  return toRawWorkspaceFileUri(rawInput);
}

export function migratorToDesktopEncodedUri(rawInput) {
  return toDesktopEncodedWorkspaceUri(rawInput);
}

export function migratorParseWorkspaceLabel(rawUri) {
  return parseWorkspaceDisplayLabel(rawUri);
}

function migratorParseWorkspaceUrisColumn(rawVal) {
  return parseWorkspaceUrisColumn(rawVal);
}

function migratorEscapePbtxtString(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function migratorCleanPromptTitle(rawText, maxChars = 72) {
  return extractShortPromptTitle(rawText, maxChars);
}

function migratorDecodeUserPromptFromStepPayload(rawBlob) {
  const buf = toUint8Array(rawBlob);
  if (!buf || buf.byteLength === 0) return '';
  const state = { off: 0 };
  const end = buf.byteLength;
  while (state.off < end) {
    const tag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 19 && wt === 2) {
      const uiEnd = readSubEnd(buf, state, end);
      let query = '';
      let userResponse = '';
      const items = [];
      while (state.off < uiEnd) {
        const uTag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, uiEnd)));
        const uFn = uTag >>> 3;
        const uWt = uTag & 7;
        if (uFn === 1 && uWt === 2) {
          query = readProtoString(buf, state, uiEnd);
        } else if (uFn === 2 && uWt === 2) {
          userResponse = readProtoString(buf, state, uiEnd);
        } else if (uFn === 3 && uWt === 2) {
          const itEnd = readSubEnd(buf, state, uiEnd);
          while (state.off < itEnd) {
            const iTag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, itEnd)));
            if ((iTag >>> 3) === 1 && (iTag & 7) === 2) {
              const txt = readProtoString(buf, state, itEnd);
              if (txt) items.push(txt);
            } else {
              skipProtoField(buf, state, iTag & 7, itEnd);
            }
          }
          state.off = itEnd;
        } else {
          skipProtoField(buf, state, uWt, uiEnd);
        }
      }
      state.off = uiEnd;
      const merged = userResponse || items.join(' ') || query;
      if (merged) return migratorCleanPromptTitle(merged);
    } else {
      skipProtoField(buf, state, wt, end);
    }
  }
  return '';
}

function migratorInspectConversationDbLight(dbPath, { needPromptTitle = false } = {}) {
  try {
    return withReadOnlySqliteDb(dbPath, (db) => {
      let trajectoryType = 0;
      let sourceNum = 0;
      try {
        const metaRow = db
          .prepare('SELECT trajectory_type, source FROM trajectory_meta LIMIT 1')
          .get();
        trajectoryType = Number(metaRow?.trajectory_type || 0);
        sourceNum = Number(metaRow?.source || 0);
      } catch {
        // 兼容最小表结构
      }

      let stepCount = 0;
      let lastUserInputStepIndex = -1;
      let firstPromptTitle = '';
      try {
        const cntRow = db.prepare('SELECT count(*) AS cnt FROM steps').get();
        stepCount = Math.max(0, Number(cntRow?.cnt || 0));
        const lastUiRow = db
          .prepare('SELECT max(idx) AS max_idx FROM steps WHERE step_type = 14')
          .get();
        if (lastUiRow && lastUiRow.max_idx != null) {
          lastUserInputStepIndex = Number(lastUiRow.max_idx);
        }
        if (needPromptTitle && stepCount > 0) {
          const uiRows = db
            .prepare('SELECT step_payload FROM steps WHERE step_type = 14 ORDER BY idx ASC LIMIT 3')
            .all();
          for (const row of uiRows || []) {
            if (!row?.step_payload) continue;
            const extracted = migratorDecodeUserPromptFromStepPayload(row.step_payload);
            if (extracted) {
              firstPromptTitle = extracted;
              break;
            }
          }
        }
      } catch {
        // 忽略步骤读取异常
      }

      let metaBlobInfo = {
        workspaceUri: '',
        projectId: '',
        parentConversationId: '',
        rootConversationId: '',
        nestingDepth: 0,
        hasSubagentSpec: false,
        createdMs: 0,
      };
      try {
        const blobRow = db
          .prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main' LIMIT 1")
          .get();
        if (blobRow?.data) {
          metaBlobInfo = decodeMetaBlobLight(blobRow.data);
        }
      } catch {
        // 忽略 blob 缺失
      }

      return {
        trajectoryType,
        sourceNum,
        stepCount,
        lastUserInputStepIndex,
        firstPromptTitle,
        ...metaBlobInfo,
      };
    });
  } catch {
    return null;
  }
}

function migratorReadClientSummaryMap(clientRoot, expectedAppDataDir) {
  const sumDbPath = join(clientRoot, 'conversation_summaries.db');
  const map = new Map();
  if (!existsSync(sumDbPath)) {
    return { hasSummaryDb: false, map };
  }
  try {
    withReadOnlySqliteDb(sumDbPath, (db) => {
      let rows = [];
      try {
        rows = db
          .prepare(
            `SELECT
               conversation_id,
               title,
               preview,
               step_count,
               last_modified_time,
               workspace_uris,
               status,
               source,
               project_id,
               agent_name,
               parent_conversation_id,
               nesting_depth,
               not_fully_idle,
               killed,
               last_user_input_time,
               last_user_input_step_index,
               app_data_dir,
               raw_summary
             FROM conversation_summaries`
          )
          .all();
      } catch {
        rows = db
          .prepare(
            `SELECT
               conversation_id,
               title,
               step_count,
               last_modified_time,
               workspace_uris,
               status,
               project_id,
               parent_conversation_id,
               nesting_depth,
               not_fully_idle,
               killed,
               app_data_dir
             FROM conversation_summaries`
          )
          .all();
      }
      for (const row of rows || []) {
        const cid = String(row?.conversation_id || '').trim().toLowerCase();
        if (!cid || !SESSION_UUID_RE.test(cid)) continue;
        const rowDir = String(row?.app_data_dir || '').trim().toLowerCase();
        const isNative = !rowDir || rowDir === expectedAppDataDir;
        const prev = map.get(cid);
        if (!prev || (isNative && !prev._isNative)) {
          map.set(cid, { ...row, _isNative: isNative });
        }
      }
    });
    return { hasSummaryDb: true, map };
  } catch {
    return { hasSummaryDb: true, map };
  }
}

function migratorExtractDesktopProjects(summaryMap) {
  return extractDesktopProjectsFromSummaryMap(summaryMap);
}

function migratorReadAnnotationTitle(clientRoot, cid) {
  const annCheck = resolveNoFollowFile(clientRoot, ['annotations', `${cid}.pbtxt`]);
  if (!annCheck.ok || !annCheck.exists) return '';
  try {
    return parseAnnotationPbtxtTitle(readFileSync(annCheck.path, 'utf8'));
  } catch {
    return '';
  }
}

function migratorComputeDbFileInfo(clientRoot, cid, walSet = null, shmSet = null) {
  const dbCheck = resolveNoFollowFile(clientRoot, ['conversations', `${cid}.db`]);
  if (!dbCheck.ok || !dbCheck.exists || !dbCheck.stat) return null;
  const dbPath = dbCheck.path;
  try {
    const dbStat = dbCheck.stat;
    let dbSizeBytes = Number(dbStat.size || 0);
    let mtimeMs = Number(dbStat.mtimeMs || 0);
    let hasNonEmptyWal = false;
    const hasWal = walSet ? walSet.has(`${cid}.db-wal`) : existsSync(`${dbPath}-wal`);
    if (hasWal) {
      const walCheck = resolveNoFollowFile(clientRoot, ['conversations', `${cid}.db-wal`]);
      if (walCheck.ok && walCheck.exists && walCheck.stat) {
        const walSize = Number(walCheck.stat.size || 0);
        dbSizeBytes += walSize;
        // 0 字节的空 .db-wal 仅由只读打开/checkpoint 残留，不含真实写入，忽略其 mtime 避免拉平老会话时间
        if (walSize > 0) {
          hasNonEmptyWal = true;
          mtimeMs = Math.max(mtimeMs, Number(walCheck.stat.mtimeMs || 0));
        }
      }
    }
    const hasShm = shmSet ? shmSet.has(`${cid}.db-shm`) : existsSync(`${dbPath}-shm`);
    if (hasShm) {
      const shmCheck = resolveNoFollowFile(clientRoot, ['conversations', `${cid}.db-shm`]);
      if (shmCheck.ok && shmCheck.exists && shmCheck.stat) {
        dbSizeBytes += Number(shmCheck.stat.size || 0);
      }
    }
    return { dbPath, dbSizeBytes, sizeBytes: dbSizeBytes, mtimeMs, hasNonEmptyWal };
  } catch {
    return null;
  }
}

function migratorReadDirNameSet(dirPath) {
  const set = new Set();
  try {
    for (const name of readdirSync(dirPath)) {
      set.add(String(name).toLowerCase());
    }
  } catch {
    // 目录不存在或不可读时返回空集合
  }
  return set;
}

function migratorListClientSessions(clientDef, clientRoot, summaryMap, runningSet) {
  const convDir = join(clientRoot, 'conversations');
  if (!existsSync(convDir)) return [];
  let entries = [];
  try {
    entries = readdirSync(convDir);
  } catch {
    return [];
  }

  const walSet = new Set();
  const shmSet = new Set();
  for (const name of entries) {
    const lower = name.toLowerCase();
    if (lower.endsWith('.db-wal')) {
      walSet.add(lower);
    } else if (lower.endsWith('.db-shm')) {
      shmSet.add(lower);
    }
  }
  const brainIdSet = migratorReadDirNameSet(join(clientRoot, 'brain'));
  const annFileSet = migratorReadDirNameSet(join(clientRoot, 'annotations'));

  const dbCandidates = [];
  for (const name of entries) {
    if (!name.endsWith('.db')) continue;
    const cid = name.slice(0, -3).toLowerCase();
    if (!SESSION_UUID_RE.test(cid)) continue;
    const info = migratorComputeDbFileInfo(clientRoot, cid, walSet, shmSet);
    if (!info) continue;
    const summary = summaryMap.get(cid) || null;
    const summaryLastModMs = summary
      ? parseIsoMs(normalizeSqliteIsoTime(summary.last_modified_time)) || 0
      : 0;
    const effectiveLastModMs =
      summaryLastModMs > 0
        ? info.hasNonEmptyWal
          ? Math.max(summaryLastModMs, info.mtimeMs)
          : summaryLastModMs
        : info.mtimeMs;
    dbCandidates.push({
      cid,
      summary,
      info,
      sortMs: effectiveLastModMs,
    });
  }

  dbCandidates.sort((a, b) => b.sortMs - a.sortMs);

  const sessions = [];
  let coldDbInspectCount = 0;
  for (const cand of dbCandidates) {
    if (sessions.length >= MIGRATOR_MAX_SESSIONS_PER_CLIENT) break;
    const { cid, summary, info } = cand;

    if (isSummarySubagent(summary)) continue;

    const annTitle = annFileSet.has(`${cid}.pbtxt`)
      ? migratorReadAnnotationTitle(clientRoot, cid)
      : '';
    const sumTitle = String(summary?.title || '').trim();
    const sumPreview = String(summary?.preview || '').trim();
    const summaryStepCount = summary ? Math.max(0, Number(summary.step_count || 0)) : -1;
    if (summary && summaryStepCount === 0 && !runningSet.has(cid)) {
      continue;
    }

    const needDbInspect = !summary || (!annTitle && !sumTitle && !sumPreview);
    let dbLight = null;
    if (needDbInspect && coldDbInspectCount < MIGRATOR_MAX_COLD_DB_INSPECTS) {
      coldDbInspectCount += 1;
      dbLight = migratorInspectConversationDbLight(info.dbPath, {
        needPromptTitle: !annTitle && !sumTitle && !sumPreview,
      });
    }

    if (isDbLightSubagent(dbLight)) continue;

    const stepCount =
      summaryStepCount >= 0 ? summaryStepCount : Math.max(0, Number(dbLight?.stepCount || 0));
    if (stepCount === 0) continue;

    const title =
      annTitle ||
      sumTitle ||
      sumPreview ||
      String(dbLight?.firstPromptTitle || '').trim() ||
      cid.slice(0, 8);

    const uris = summary ? migratorParseWorkspaceUrisColumn(summary.workspace_uris) : [];
    const workspaceUri = uris[0] || String(dbLight?.workspaceUri || '').trim();
    const { name: workspaceName, displayPath: workspacePath } =
      migratorParseWorkspaceLabel(workspaceUri);

    const rawStatus = String(summary?.status || '').trim();
    const killed = Boolean(Number(summary?.killed || 0));
    const notFullyIdle = Boolean(Number(summary?.not_fully_idle || 0));
    const isRunning =
      runningSet.has(cid) ||
      (!killed &&
        (rawStatus === 'CASCADE_RUN_STATUS_RUNNING' ||
          (notFullyIdle && rawStatus !== 'CASCADE_RUN_STATUS_IDLE')));

    const hasBrain = brainIdSet.has(cid);
    let totalSizeBytes = Number(info.dbSizeBytes || info.sizeBytes || 0);
    if (hasBrain) {
      const brCheck = resolveNoFollowPath(clientRoot, ['brain', cid]);
      if (brCheck.ok && brCheck.exists && brCheck.stat?.isDirectory()) {
        totalSizeBytes += sumVerifiedDirTreeBytes(brCheck.path).sizeBytes;
      }
    }
    if (annFileSet.has(`${cid}.pbtxt`)) {
      const annCheck = resolveNoFollowFile(clientRoot, ['annotations', `${cid}.pbtxt`]);
      if (annCheck.ok && annCheck.exists && annCheck.stat) {
        totalSizeBytes += Number(annCheck.stat.size || 0);
      }
    }

    sessions.push({
      cascadeId: cid,
      clientId: clientDef.id,
      title,
      stepCount,
      lastModifiedMs: cand.sortMs,
      workspaceUri,
      workspaceName,
      workspacePath,
      projectId: String(summary?.project_id || dbLight?.projectId || '').trim(),
      sizeBytes: totalSizeBytes,
      dbSizeBytes: Number(info.dbSizeBytes || info.sizeBytes || 0),
      hasBrain,
      isRunning,
    });
  }

  return sessions;
}

/**
 * 探测本机多端 Antigravity 目录、各端可迁移根会话列表及桌面端目标项目列表。
 *
 * @param {{
 *   geminiDir?: string,
 *   runningCascadeIds?: Iterable<string>,
 * }} [options={}]
 */
export function getSessionMigrationCatalog(options = {}) {
  const sqliteSupported = hasBuiltinNodeSqlite();
  const geminiDir = resolveGeminiDir(options.geminiDir);
  const runningSet = new Set();
  if (options.runningCascadeIds) {
    for (const id of options.runningCascadeIds) {
      const norm = String(id || '').trim().toLowerCase();
      if (norm) runningSet.add(norm);
    }
  }

  const clients = [];
  const sessionsByClient = {};
  let desktopProjects = [];

  for (const def of SESSION_CLIENT_DEFS) {
    const root = join(geminiDir, def.dirName);
    const convDir = join(root, 'conversations');
    const sumDbPath = join(root, 'conversation_summaries.db');
    const rootExists = existsSync(root);
    const convExists = rootExists && existsSync(convDir);
    const hasSummaryDb = rootExists && existsSync(sumDbPath);

    let summaryMap = new Map();
    if (sqliteSupported && hasSummaryDb) {
      summaryMap = migratorReadClientSummaryMap(root, def.appDataDir).map;
    }

    if (def.id === 'desktop') {
      desktopProjects = migratorExtractDesktopProjects(summaryMap);
    }

    const sessions =
      sqliteSupported && convExists
        ? migratorListClientSessions(def, root, summaryMap, runningSet)
        : [];

    const hasUsableData = convExists && (hasSummaryDb || sessions.length > 0);
    const canBeTarget = Boolean(def.allowTarget && rootExists && convExists && hasSummaryDb);
    const canBeSource = Boolean(convExists && sessions.length > 0);

    sessionsByClient[def.id] = sessions;
    clients.push({
      id: def.id,
      dirName: def.dirName,
      rootPath: root,
      exists: hasUsableData,
      hasSummaryDb,
      canBeSource,
      canBeTarget,
      sessionCount: sessions.length,
    });
  }

  const detectedClients = clients.filter((c) => c.exists);
  const hasAnyTarget = detectedClients.some((c) => c.canBeTarget);
  const available = Boolean(sqliteSupported && detectedClients.length >= 2 && hasAnyTarget);

  return {
    available,
    sqliteSupported,
    clients,
    sessionsByClient,
    desktopProjects,
  };
}

function migratorBackupSummaryDb(targetSumDbPath, targetClientId, backupRoot) {
  if (!existsSync(targetSumDbPath)) return '';
  mkdirSync(backupRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = `conversation_summaries_${targetClientId}_${stamp}.db`;
  const dstPath = join(backupRoot, baseName);
  cpSync(targetSumDbPath, dstPath, { force: true });
  const walPath = `${targetSumDbPath}-wal`;
  if (existsSync(walPath)) {
    try {
      cpSync(walPath, `${dstPath}-wal`, { force: true });
    } catch {
      // 忽略瞬时 WAL 拷贝异常
    }
  }

  // 滚动清理超出上限的旧备份，防止磁盘无限增长
  try {
    const prefix = `conversation_summaries_${targetClientId}_`;
    const backupFiles = readdirSync(backupRoot)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.db'))
      .sort()
      .reverse();
    for (const stale of backupFiles.slice(MIGRATOR_MAX_BACKUPS)) {
      const staleDb = join(backupRoot, stale);
      try {
        rmSync(staleDb, { force: true });
        rmSync(`${staleDb}-wal`, { force: true });
      } catch {
        // 忽略旧备份删除异常
      }
    }
  } catch {
    // 忽略备份目录列举异常
  }

  return dstPath;
}

function migratorBuildWorkspaceSubmessage(rawUri, targetClientId) {
  if (!rawUri) return Buffer.alloc(0);
  if (targetClientId === 'cli') {
    return Buffer.concat([encodeProtoStringField(1, rawUri), encodeProtoStringField(3, '')]);
  }
  return Buffer.concat([encodeProtoStringField(1, rawUri), encodeProtoStringField(2, rawUri)]);
}

function migratorBuildSummaryMetaBlob(
  sourceMetaBlob,
  { newCid, targetClientId, targetProjectId, rawUri, encodedUri }
) {
  const wsBytes = migratorBuildWorkspaceSubmessage(rawUri, targetClientId);
  const primaryUri = targetClientId === 'cli' ? rawUri : encodedUri;
  const replacements = new Map([
    [1, wsBytes.length > 0 ? encodeProtoBytesField(1, wsBytes) : null],
    [6, encodeProtoStringField(6, newCid)],
    [7, primaryUri ? encodeProtoStringField(7, primaryUri) : null],
    [15, null], // 摘要中的 trajectoryMetadata 不必携带庞大实验配置块
    [18, encodeProtoStringField(18, targetProjectId)],
  ]);
  if (sourceMetaBlob && sourceMetaBlob.byteLength > 0) {
    return patchProtoMessageFields(sourceMetaBlob, replacements);
  }
  const parts = [];
  if (wsBytes.length > 0) parts.push(encodeProtoBytesField(1, wsBytes));
  parts.push(encodeProtoStringField(6, newCid));
  if (primaryUri) parts.push(encodeProtoStringField(7, primaryUri));
  parts.push(encodeProtoStringField(18, targetProjectId));
  return Buffer.concat(parts);
}

/**
 * 在「完整迁移」模式下，仅定向改写单步 `metadata` 中的 `sourceTrajectoryStepInfo`（`fn 20`）
 * 的 `cascadeId`（`fn 4`）及 `trajectoryId`（`fn 1`），绝不触碰工具参数路径或外部父会话 ID。
 *
 * @param {Uint8Array | Buffer} rawBlob
 * @param {{ srcCid: string, newCid: string, srcTid?: string, newTid?: string }} ids
 * @returns {Buffer | null} 若无需改写则返回 `null`
 */
function migratorPatchStepMetadataOwnership(rawBlob, { srcCid, newCid, srcTid = '', newTid = '' }) {
  const u8 = toUint8Array(rawBlob);
  if (!u8 || u8.byteLength === 0) return null;
  const buf = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
  const hasCid = srcCid && buf.includes(srcCid);
  const hasTid = srcTid && newTid && buf.includes(srcTid);
  if (!hasCid && !hasTid) return null;

  const topFields = splitProtoRawFields(buf);
  const fn20 = topFields.find((f) => f.fn === 20 && f.wt === 2);
  if (!fn20) return null;

  const subFields = splitProtoRawFields(fn20.payload);
  const subReplacements = new Map();
  for (const sf of subFields) {
    if (sf.fn === 4 && sf.wt === 2 && srcCid) {
      if (sf.payload.toString('utf8').trim().toLowerCase() === srcCid) {
        subReplacements.set(4, encodeProtoStringField(4, newCid));
      }
    } else if (sf.fn === 1 && sf.wt === 2 && srcTid && newTid) {
      if (sf.payload.toString('utf8').trim().toLowerCase() === srcTid) {
        subReplacements.set(1, encodeProtoStringField(1, newTid));
      }
    }
  }
  if (subReplacements.size === 0) return null;

  const patchedSub = patchProtoMessageFields(fn20.payload, subReplacements);
  return patchProtoMessageFields(buf, new Map([[20, encodeProtoBytesField(20, patchedSub)]]));
}

/**
 * 在「完整迁移」模式下，仅定向改写 `gen_metadata.data` 中 `chatModel`（`fn 1`）的 `extraMeta`
 * 重复映射字段（`fn 20`）里 `cascade_id` / `root_cascade_id` 等于 `srcCid` 的值，保留其余全部字段和提示词原文。
 *
 * @param {Uint8Array | Buffer} rawBlob
 * @param {string} srcCid
 * @param {string} newCid
 * @returns {Buffer | null} 若无需改写则返回 `null`
 */
function migratorPatchGenMetadataOwnership(rawBlob, srcCid, newCid) {
  const u8 = toUint8Array(rawBlob);
  if (!u8 || u8.byteLength === 0 || !srcCid) return null;
  const buf = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
  if (!buf.includes(srcCid)) return null;

  const topFields = splitProtoRawFields(buf);
  let topChanged = false;
  const rebuiltTop = [];

  for (const field of topFields) {
    if (field.fn === 1 && field.wt === 2 && field.payload.includes(srcCid)) {
      const chatFields = splitProtoRawFields(field.payload);
      let chatChanged = false;
      const rebuiltChat = [];
      for (const cf of chatFields) {
        if (cf.fn === 20 && cf.wt === 2 && cf.payload.includes(srcCid)) {
          const kvFields = splitProtoRawFields(cf.payload);
          const keyField = kvFields.find((item) => item.fn === 1 && item.wt === 2);
          const valField = kvFields.find((item) => item.fn === 2 && item.wt === 2);
          const keyStr = keyField ? keyField.payload.toString('utf8').trim() : '';
          const valStr = valField ? valField.payload.toString('utf8').trim().toLowerCase() : '';
          if (
            (keyStr === 'cascade_id' || keyStr === 'root_cascade_id') &&
            valStr === srcCid
          ) {
            const patchedEntry = patchProtoMessageFields(
              cf.payload,
              new Map([[2, encodeProtoStringField(2, newCid)]])
            );
            rebuiltChat.push(encodeProtoBytesField(20, patchedEntry));
            chatChanged = true;
            continue;
          }
        }
        rebuiltChat.push(cf.raw);
      }
      if (chatChanged) {
        rebuiltTop.push(encodeProtoBytesField(1, Buffer.concat(rebuiltChat)));
        topChanged = true;
        continue;
      }
    }
    rebuiltTop.push(field.raw);
  }

  return topChanged ? Buffer.concat(rebuiltTop) : null;
}

function migratorBuildPatchedRawSummary({
  sourceRawSummary,
  sourceMetaBlob,
  newCid,
  newTid,
  title,
  stepCount,
  nowMs,
  createdMs,
  lastUserInputMs,
  lastUserInputStepIndex,
  trajectoryType,
  targetClientId,
  targetProjectId,
  rawUri,
  encodedUri,
}) {
  const wsBytes = migratorBuildWorkspaceSubmessage(rawUri, targetClientId);
  const nowTsBytes = encodeProtoTimestamp(nowMs);
  const annSub = Buffer.concat([
    encodeProtoStringField(1, title),
    ...(targetClientId === 'desktop' ? [encodeProtoBytesField(7, nowTsBytes)] : []),
  ]);

  if (sourceRawSummary && sourceRawSummary.byteLength > 0) {
    const rawFields = splitProtoRawFields(sourceRawSummary);
    const fn17 = rawFields.find((f) => f.fn === 17 && f.wt === 2);
    const patchedFn17 = migratorBuildSummaryMetaBlob(fn17?.payload || sourceMetaBlob, {
      newCid,
      targetClientId,
      targetProjectId,
      rawUri,
      encodedUri,
    });
    return patchProtoMessageFields(
      sourceRawSummary,
      new Map([
        [1, encodeProtoStringField(1, title)],
        [2, encodeProtoVarintField(2, stepCount)],
        [3, encodeProtoBytesField(3, nowTsBytes)],
        [4, encodeProtoStringField(4, newTid)],
        [5, encodeProtoVarintField(5, 1)], // CASCADE_RUN_STATUS_IDLE
        [9, wsBytes.length > 0 ? encodeProtoBytesField(9, wsBytes) : null],
        [15, encodeProtoBytesField(15, annSub)],
        [17, encodeProtoBytesField(17, patchedFn17)],
        [20, null], // 清除来源覆盖标记，交由目标端原生识别
        [21, null], // 清除未空闲标志
        [23, null], // 清除终止标志
        [26, null], // 清除运行中附加状态标志
      ])
    );
  }

  // 源端不含 conversation_summaries.db（如旧版 antigravity-ide）时从实体库元数据合成标准 raw_summary
  const createdTsBytes = encodeProtoTimestamp(createdMs || nowMs);
  const lastUiTsBytes = encodeProtoTimestamp(lastUserInputMs || nowMs);
  const synthMeta = migratorBuildSummaryMetaBlob(sourceMetaBlob, {
    newCid,
    targetClientId,
    targetProjectId,
    rawUri,
    encodedUri,
  });
  const parts = [
    encodeProtoStringField(1, title),
    encodeProtoVarintField(2, stepCount),
    encodeProtoBytesField(3, nowTsBytes),
    encodeProtoStringField(4, newTid),
    encodeProtoVarintField(5, 1),
    encodeProtoBytesField(7, createdTsBytes),
  ];
  if (wsBytes.length > 0) {
    parts.push(encodeProtoBytesField(9, wsBytes));
  }
  parts.push(
    encodeProtoBytesField(10, lastUiTsBytes),
    encodeProtoBytesField(15, annSub),
    ...(lastUserInputStepIndex >= 0 ? [encodeProtoVarintField(16, lastUserInputStepIndex)] : []),
    encodeProtoBytesField(17, synthMeta),
    encodeProtoVarintField(22, trajectoryType || 4),
    encodeProtoVarintField(28, 4)
  );
  return Buffer.concat(parts);
}

function migratorWriteBufferAtomic(filePath, buf) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  let renamed = false;
  try {
    writeFileSync(tmpPath, buf);
    renameSync(tmpPath, filePath);
    renamed = true;
  } catch {
    if (!renamed) {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        // 忽略临时文件清理异常
      }
    }
    writeFileSync(filePath, buf);
  }
}

function migratorPruneArchivedSourceDbs(archiveSrcDir) {
  if (!archiveSrcDir || !existsSync(archiveSrcDir)) return;
  let dbFiles = [];
  try {
    dbFiles = readdirSync(archiveSrcDir)
      .filter((name) => name.toLowerCase().endsWith('.db'))
      .map((name) => {
        const full = join(archiveSrcDir, name);
        let mtimeMs = 0;
        try {
          mtimeMs = Number(statSync(full).mtimeMs || 0);
        } catch {
          mtimeMs = 0;
        }
        return { name, full, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  } catch {
    return;
  }
  if (dbFiles.length <= MIGRATOR_MAX_ARCHIVED_SOURCES) return;
  for (const oldItem of dbFiles.slice(MIGRATOR_MAX_ARCHIVED_SOURCES)) {
    const cidMatch = oldItem.name.match(
      /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_/i
    );
    if (cidMatch) {
      const cid = cidMatch[1].toLowerCase();
      const markerPath = join(archiveSrcDir, `${cid}.protected.json`);
      if (!existsSync(markerPath)) {
        try {
          writeFileSync(
            markerPath,
            `${JSON.stringify({ cascadeId: cid, prunedAtMs: Date.now() })}\n`,
            'utf8'
          );
        } catch {
          // 忽略标记写入异常
        }
      }
    }
    try {
      rmSync(oldItem.full, { force: true });
    } catch {
      // 忽略超额归档淘汰异常
    }
  }
}

/**
 * 在 `move` 模式下彻底清理源端残留索引、级联嵌套子代理、CLI 历史与 sidecar 事件，
 * 防止源客户端列表出现「仅索引」幽灵条目或失去父会话折叠的孤儿嵌套子代理。
 * 故意保留源端主会话 `brain/<cid>/` 媒体目录及 `archived-sources/` 归档保护。
 *
 * @param {string} srcRoot
 * @param {typeof SESSION_CLIENT_DEFS[number]} srcDef
 * @param {string[]} movedIds
 * @param {string[]} cascadeSubagentIds
 * @param {string[]} warnings
 */
function migratorCleanupMovedSourceIndexes(
  srcRoot,
  srcDef,
  movedIds,
  cascadeSubagentIds,
  warnings
) {
  if (!srcRoot || !srcDef || !Array.isArray(movedIds) || movedIds.length === 0) return;
  const movedSet = new Set();
  for (const id of movedIds) {
    const norm = normalizeSessionUuid(id);
    if (norm) movedSet.add(norm);
  }
  const subSet = new Set();
  for (const subId of cascadeSubagentIds || []) {
    const norm = normalizeSessionUuid(subId);
    if (norm && !movedSet.has(norm)) subSet.add(norm);
  }
  const allRemovedSet = new Set([...movedSet, ...subSet]);
  if (allRemovedSet.size === 0) return;

  // 0. 清理失去父会话的同源嵌套子代理实体文件（绝不触碰 /fork 独立会话）
  for (const subCid of subSet) {
    for (const relSegs of [
      ['conversations', `${subCid}.db`],
      ['conversations', `${subCid}.db-wal`],
      ['conversations', `${subCid}.db-shm`],
      ['conversations', `${subCid}.db-journal`],
      ['conversations', `${subCid}.pb`],
      ['annotations', `${subCid}.pbtxt`],
      ['presence', `${subCid}.lock`],
    ]) {
      const fCheck = resolveNoFollowFile(srcRoot, relSegs);
      if (fCheck.ok && fCheck.exists) {
        try {
          rmSync(fCheck.path, { force: true });
        } catch {
          // 忽略子代理文件移除异常
        }
      }
    }
    const subBrainCheck = resolveNoFollowPath(srcRoot, ['brain', subCid]);
    if (subBrainCheck.ok && subBrainCheck.exists) {
      try {
        rmSync(subBrainCheck.path, { recursive: true, force: true });
      } catch {
        // 忽略子代理 brain 移除异常
      }
    }
  }

  // 1. 清理源端 conversation_summaries.db（含 conversation_parents + FTS5 rebuild）
  const srcSumDbPath = join(srcRoot, 'conversation_summaries.db');
  if (existsSync(srcSumDbPath)) {
    try {
      withWritableSqliteDb(srcSumDbPath, (srcSumDb) => {
        const delSum = srcSumDb.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?');
        let delFts = null;
        try {
          delFts = srcSumDb.prepare('DELETE FROM conversations_fts WHERE conversation_id = ?');
        } catch {
          delFts = null;
        }
        srcSumDb.exec('BEGIN IMMEDIATE');
        try {
          for (const cid of allRemovedSet) {
            delSum.run(cid);
            if (delFts) delFts.run(cid);
          }
          deleteConversationParentsByIds(srcSumDb, allRemovedSet);
          if (delFts) {
            try {
              srcSumDb.exec("INSERT INTO conversations_fts(conversations_fts) VALUES ('rebuild')");
            } catch {
              // 非 FTS5 表或无 rebuild 触发时忽略
            }
          }
          srcSumDb.exec('COMMIT');
        } catch (txErr) {
          try {
            srcSumDb.exec('ROLLBACK');
          } catch {
            // 忽略回滚异常
          }
          throw txErr;
        }
      });
    } catch (err) {
      warnings.push(`source_summary_cleanup_failed: ${err?.message || 'unknown'}`);
    }
  }

  // 2. 清理 presence/<cid>.lock
  for (const cid of movedSet) {
    const lockCheck = resolveNoFollowFile(srcRoot, ['presence', `${cid}.lock`]);
    if (lockCheck.ok && lockCheck.exists) {
      try {
        rmSync(lockCheck.path, { force: true });
      } catch {
        // 忽略锁文件移除异常
      }
    }
  }

  // 3. 过滤源端 .pb 摘要索引（agyhub_summaries_proto.pb / jetbox_summaries_proto.pb）
  if (srcDef.summaryProtoFile) {
    const protoCheck = resolveNoFollowFile(srcRoot, [srcDef.summaryProtoFile]);
    if (protoCheck.ok && protoCheck.exists) {
      try {
        const rawBuf = readFileSync(protoCheck.path);
        const filtered = filterSummaryProtoIndex(rawBuf, allRemovedSet, {
          isDesktop: Boolean(srcDef.isDesktopProto),
        });
        if (filtered.changed) {
          migratorWriteBufferAtomic(protoCheck.path, filtered.buffer);
        }
      } catch (err) {
        warnings.push(`source_proto_cleanup_failed: ${err?.message || 'unknown'}`);
      }
    }
  }

  // 4. 清理 cache/last_conversations.json
  const lastConvCheck = resolveNoFollowFile(srcRoot, ['cache', 'last_conversations.json']);
  if (lastConvCheck.ok && lastConvCheck.exists) {
    try {
      const parsed = JSON.parse(readFileSync(lastConvCheck.path, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        let changed = false;
        const nextObj = {};
        for (const [wsKey, val] of Object.entries(parsed)) {
          const normId = normalizeSessionUuid(val);
          if (normId && allRemovedSet.has(normId)) {
            changed = true;
            continue;
          }
          nextObj[wsKey] = val;
        }
        if (changed) {
          writeJsonAtomicSync(lastConvCheck.path, nextObj);
        }
      }
    } catch (err) {
      warnings.push(`source_last_conversations_cleanup_failed: ${err?.message || 'unknown'}`);
    }
  }

  // 5. 清理 cache/conversation_metadata.json
  const metaCacheCheck = resolveNoFollowFile(srcRoot, ['cache', 'conversation_metadata.json']);
  if (metaCacheCheck.ok && metaCacheCheck.exists) {
    try {
      const parsed = JSON.parse(readFileSync(metaCacheCheck.path, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.conversations && typeof parsed.conversations === 'object') {
        let changed = false;
        const nextConvs = {};
        for (const [k, v] of Object.entries(parsed.conversations)) {
          const normId = normalizeSessionUuid(k);
          if (normId && allRemovedSet.has(normId)) {
            changed = true;
            continue;
          }
          nextConvs[k] = v;
        }
        if (changed) {
          writeJsonAtomicSync(metaCacheCheck.path, { ...parsed, conversations: nextConvs });
        }
      }
    } catch (err) {
      warnings.push(`source_metadata_cache_cleanup_failed: ${err?.message || 'unknown'}`);
    }
  }

  // 6. 清理源端 history.jsonl（如 CLI 明文历史提问）
  const histCheck = resolveNoFollowFile(srcRoot, ['history.jsonl']);
  if (histCheck.ok && histCheck.exists) {
    try {
      const rawHist = readFileSync(histCheck.path);
      const filteredHist = filterHistoryJsonlBuffer(rawHist, allRemovedSet);
      if (filteredHist.changed) {
        migratorWriteBufferAtomic(histCheck.path, filteredHist.buffer);
      }
    } catch (err) {
      warnings.push(`source_history_cleanup_failed: ${err?.message || 'unknown'}`);
    }
  }

  // 7. 清理源端归属已迁出会话及嵌套子代理的 sidecar_data 事件（自动保护 /fork）
  for (const relSegments of findMatchingSidecarEventRelPaths(srcRoot, allRemovedSet)) {
    const evtCheck = resolveNoFollowFile(srcRoot, relSegments);
    if (evtCheck.ok && evtCheck.exists) {
      try {
        rmSync(evtCheck.path, { force: true });
      } catch {
        // 忽略事件文件移除异常
      }
    }
  }

  // 8. 过滤源端 logs/sidecar.log 中的残留会话 ID 行
  const logCheck = resolveNoFollowFile(srcRoot, ['logs', 'sidecar.log']);
  if (logCheck.ok && logCheck.exists && Number(logCheck.stat?.size || 0) <= MAX_SIDECAR_LOG_BYTES) {
    try {
      const rawLog = readFileSync(logCheck.path);
      const filteredLog = filterLogLinesContainingIds(rawLog, Array.from(allRemovedSet));
      if (filteredLog.changed) {
        migratorWriteBufferAtomic(logCheck.path, filteredLog.buffer);
      }
    } catch {
      // 忽略日志行过滤异常
    }
  }
}

function migratorIsFileLockError(err) {
  const code = String(err?.code || '').toUpperCase();
  const msg = String(err?.message || '');
  return (
    code === 'EBUSY' ||
    code === 'EPERM' ||
    code === 'EACCES' ||
    /EBUSY|EPERM|resource busy|locked/i.test(msg)
  );
}

function migratorCleanupTargetArtifacts({ dstDbPath, dstAnnPath, dstBrainDir, removeBrain = true }) {
  for (const cleanupPath of [dstDbPath, `${dstDbPath}-wal`, `${dstDbPath}-shm`, dstAnnPath]) {
    try {
      if (cleanupPath && existsSync(cleanupPath)) rmSync(cleanupPath, { force: true });
    } catch {
      // 忽略清理异常
    }
  }
  if (removeBrain && dstBrainDir) {
    try {
      if (existsSync(dstBrainDir)) rmSync(dstBrainDir, { recursive: true, force: true });
    } catch {
      // 忽略目录清理异常
    }
  }
}

/**
 * 将用户选定的单条或多条会话按选定模式（默认 `move` 完整迁移，可选 `clone` 新 UUID 克隆）迁移到目标端目录。
 *
 * @param {{
 *   sourceClient: string,
 *   targetClient: string,
 *   mode?: 'move' | 'clone',
 *   cascadeIds: string[],
 *   targetProjectId?: string,
 *   targetWorkspaceUri?: string,
 *   titlePrefix?: string,
 * }} params
 * @param {{
 *   geminiDir?: string,
 *   backupDir?: string,
 *   runningCascadeIds?: Iterable<string>,
 * }} [options={}]
 */
export function migrateSessions(params = {}, options = {}) {
  if (!hasBuiltinNodeSqlite()) {
    return { ok: false, status: 503, error: 'sqlite_unavailable', results: [] };
  }

  const mode = String(params.mode || '').trim().toLowerCase() === 'clone' ? 'clone' : 'move';
  const srcDef = getSessionClientDef(params.sourceClient);
  const dstDef = getSessionClientDef(params.targetClient);
  if (!srcDef || !dstDef || srcDef.id === dstDef.id || !dstDef.allowTarget) {
    return { ok: false, status: 400, error: 'invalid_client_direction', results: [] };
  }

  const rawIds = Array.isArray(params.cascadeIds) ? params.cascadeIds : [];
  const uniqueIds = [];
  const seenIds = new Set();
  for (const item of rawIds) {
    const cid = String(item || '').trim().toLowerCase();
    if (!SESSION_UUID_RE.test(cid) || seenIds.has(cid)) continue;
    seenIds.add(cid);
    uniqueIds.push(cid);
    if (uniqueIds.length >= MIGRATOR_MAX_BATCH_SIZE) break;
  }
  if (uniqueIds.length === 0) {
    return { ok: false, status: 400, error: 'no_sessions_selected', results: [] };
  }

  const geminiDir = resolveGeminiDir(options.geminiDir);
  const srcRoot = join(geminiDir, srcDef.dirName);
  const dstRoot = join(geminiDir, dstDef.dirName);
  const srcConvDir = join(srcRoot, 'conversations');
  const dstConvDir = join(dstRoot, 'conversations');
  const srcSumDbPath = join(srcRoot, 'conversation_summaries.db');
  const dstSumDbPath = join(dstRoot, 'conversation_summaries.db');

  if (!existsSync(srcConvDir) || !existsSync(dstRoot) || !existsSync(dstSumDbPath)) {
    return { ok: false, status: 400, error: 'client_storage_missing', results: [] };
  }

  // 移动模式进程守卫：真实本机目录或显式传入进程探测配置时，禁止从正在运行的源端直接拆走会话
  const shouldCheckProcesses = Boolean(
    options.runningClientsOverride ||
      typeof options.processListProvider === 'function' ||
      options.enforceRunningClients === true ||
      !options.geminiDir
  );
  if (mode === 'move' && shouldCheckProcesses) {
    const runningClients = detectRunningClients(options);
    if (runningClients.checked && runningClients[srcDef.id]) {
      return { ok: false, status: 409, error: 'source_locked', results: [] };
    }
    if (
      !runningClients.checked &&
      (options.runningClientsOverride || options.enforceRunningClients === true)
    ) {
      return { ok: false, status: 409, error: 'process_check_failed', results: [] };
    }
  }

  // 按规范字典序获取客户端目录互斥锁，防止与会话清理器或反向迁移并发交错/死锁
  const lockRoots = mode === 'move' ? [srcRoot, dstRoot].sort() : [dstRoot];
  const releaseLocks = [];
  try {
    for (const rootToLock of lockRoots) {
      releaseLocks.push(acquireStoreLock(rootToLock));
    }
  } catch (lockErr) {
    while (releaseLocks.length > 0) {
      releaseLocks.pop()?.();
    }
    return {
      ok: false,
      status: 409,
      error: lockErr?.code === 'STORE_LOCKED' ? 'store_locked' : lockErr?.message || 'store_locked',
      results: [],
    };
  }

  try {
    mkdirSync(dstConvDir, { recursive: true });

  const runningSet = new Set();
  if (options.runningCascadeIds) {
    for (const id of options.runningCascadeIds) {
      const norm = String(id || '').trim().toLowerCase();
      if (norm) runningSet.add(norm);
    }
  }

  const srcSummaryMap = migratorReadClientSummaryMap(srcRoot, srcDef.appDataDir).map;
  const dstSummaryMap = migratorReadClientSummaryMap(dstRoot, dstDef.appDataDir).map;
  const desktopProjects =
    dstDef.id === 'desktop' ? migratorExtractDesktopProjects(dstSummaryMap) : [];

  const requestedProjectId = String(params.targetProjectId || '').trim();
  const matchedProject =
    dstDef.id === 'desktop' && requestedProjectId
      ? desktopProjects.find((p) => p.projectId === requestedProjectId) || null
      : null;

  const resolvedProjectId =
    dstDef.id === 'cli'
      ? MIGRATOR_CLI_PROJECT_ID
      : matchedProject
        ? matchedProject.projectId
        : requestedProjectId || MIGRATOR_OUTSIDE_PROJECT_ID;

  const explicitTargetWsUri = String(params.targetWorkspaceUri || '').trim();
  const titlePrefix = String(params.titlePrefix || '').trim();

  // 写入目标摘要库前自动留存滚动备份（移动模式同时备份源摘要库）
  const backupRoot = resolveMigrationBackupRoot(options.backupDir, options.geminiDir);
  let backupPath = '';
  const warnings = [];
  try {
    backupPath = migratorBackupSummaryDb(dstSumDbPath, dstDef.id, backupRoot);
    if (mode === 'move' && existsSync(srcSumDbPath)) {
      migratorBackupSummaryDb(srcSumDbPath, srcDef.id, backupRoot);
    }
  } catch (bakErr) {
    backupPath = '';
    warnings.push(`summary_backup_failed: ${bakErr?.message || 'unknown'}`);
  }

  const archiveSrcDir = join(backupRoot, 'archived-sources', srcDef.id);
  if (mode === 'move') {
    mkdirSync(archiveSrcDir, { recursive: true });
  }

  mkdirSync(join(dstRoot, 'annotations'), { recursive: true });
  mkdirSync(join(dstRoot, 'brain'), { recursive: true });

  const results = [];
  const pendingSummaryInserts = [];
  const baseNowMs = Date.now();
  const batchStamp = new Date(baseNowMs).toISOString().replace(/[:.]/g, '-');

  for (let i = 0; i < uniqueIds.length; i += 1) {
    const srcCid = uniqueIds[i];
    const srcDbCheck = resolveNoFollowFile(srcRoot, ['conversations', `${srcCid}.db`]);
    if (!srcDbCheck.ok) {
      results.push({ ok: false, sourceCascadeId: srcCid, error: srcDbCheck.error || 'unsafe_source_path' });
      continue;
    }
    if (!srcDbCheck.exists) {
      results.push({ ok: false, sourceCascadeId: srcCid, error: 'source_not_found' });
      continue;
    }
    const srcAnnCheck = resolveNoFollowFile(srcRoot, ['annotations', `${srcCid}.pbtxt`]);
    if (!srcAnnCheck.ok) {
      results.push({ ok: false, sourceCascadeId: srcCid, error: srcAnnCheck.error || 'unsafe_source_path' });
      continue;
    }
    const srcBrainCheck = resolveNoFollowPath(srcRoot, ['brain', srcCid]);
    if (!srcBrainCheck.ok) {
      results.push({ ok: false, sourceCascadeId: srcCid, error: srcBrainCheck.error || 'unsafe_source_path' });
      continue;
    }
    const srcDbPath = srcDbCheck.path;

    const srcSummary = srcSummaryMap.get(srcCid) || null;
    const rawStatus = String(srcSummary?.status || '').trim();
    const killed = Boolean(Number(srcSummary?.killed || 0));
    const notFullyIdle = Boolean(Number(srcSummary?.not_fully_idle || 0));
    const isRunning =
      runningSet.has(srcCid) ||
      (!killed &&
        (rawStatus === 'CASCADE_RUN_STATUS_RUNNING' ||
          (notFullyIdle && rawStatus !== 'CASCADE_RUN_STATUS_IDLE')));
    if (isRunning) {
      results.push({ ok: false, sourceCascadeId: srcCid, error: 'session_running' });
      continue;
    }

    const annTitle = migratorReadAnnotationTitle(srcRoot, srcCid);
    const dbLight = migratorInspectConversationDbLight(srcDbPath, {
      needPromptTitle: !annTitle && !srcSummary?.title && !srcSummary?.preview,
    });
    if (isSummarySubagent(srcSummary) || isDbLightSubagent(dbLight)) {
      results.push({ ok: false, sourceCascadeId: srcCid, error: 'non_root_session' });
      continue;
    }
    const stepCount = Math.max(
      0,
      Number(srcSummary?.step_count ?? dbLight?.stepCount ?? 0)
    );
    if (stepCount === 0) {
      results.push({ ok: false, sourceCascadeId: srcCid, error: 'empty_session' });
      continue;
    }

    const baseTitle =
      annTitle ||
      String(srcSummary?.title || '').trim() ||
      String(srcSummary?.preview || '').trim() ||
      String(dbLight?.firstPromptTitle || '').trim() ||
      srcCid.slice(0, 8);
    const finalTitle = titlePrefix ? `${titlePrefix} ${baseTitle}`.trim() : baseTitle;

    const srcUris = srcSummary ? migratorParseWorkspaceUrisColumn(srcSummary.workspace_uris) : [];
    const srcPrimaryUri = srcUris[0] || String(dbLight?.workspaceUri || '').trim();

    let effectiveWsInput = '';
    if (dstDef.id === 'desktop') {
      if (resolvedProjectId === MIGRATOR_OUTSIDE_PROJECT_ID) {
        effectiveWsInput = explicitTargetWsUri || '';
      } else {
        effectiveWsInput = explicitTargetWsUri || matchedProject?.workspaceUri || srcPrimaryUri;
      }
    } else {
      effectiveWsInput = explicitTargetWsUri || srcPrimaryUri;
    }

    const rawUri = migratorToRawFileUri(effectiveWsInput);
    const encodedUri = migratorToDesktopEncodedUri(effectiveWsInput);

    // 两种模式统一分配全新 UUID：Antigravity 桌面端和 CLI 会互相镜像对方的 conversation_summaries.db，
    // 复用原 UUID 会在移除源摘要行时触发目标端 language_server 将同 ID 行反手删掉或覆盖回 CLI 镜像。
    const newCid = randomUUID();
    const newTid = randomUUID();
    const dstDbPath = join(dstConvDir, `${newCid}.db`);
    const itemNowMs = baseNowMs + i;
    const itemNowSql = migratorFormatSqliteUtcTime(itemNowMs);
    const dstBrainDir = join(dstRoot, 'brain', newCid);
    const dstBrainExistedBefore = existsSync(dstBrainDir);
    const dstAnnPath = join(dstRoot, 'annotations', `${newCid}.pbtxt`);
    const srcAnnPath = join(srcRoot, 'annotations', `${srcCid}.pbtxt`);
    const archivedSrcDbPath =
      mode === 'move' ? join(archiveSrcDir, `${srcCid}_${batchStamp}.db`) : '';
    const cascadeSubagentIds =
      mode === 'move'
        ? expandStoreCascadeTargets(srcRoot, new Set([srcCid])).cascadeSubagentIds
        : [];

    try {
      // 1. SQLite VACUUM INTO 一致性脱机快照（移动模式先留一份完整归档备份，再写入目标端）
      withReadOnlySqliteDb(srcDbPath, (srcDb) => {
        if (mode === 'move' && archivedSrcDbPath) {
          const escapedArchive = archivedSrcDbPath.replace(/'/g, "''");
          srcDb.exec(`VACUUM INTO '${escapedArchive}'`);
        }
        const escapedDst = dstDbPath.replace(/'/g, "''");
        srcDb.exec(`VACUUM INTO '${escapedDst}'`);
      });

      // 2. 在目标库中改写 trajectory_meta 和 trajectory_metadata_blob；
      //    移动模式同步把属于源会话的历史步 metadata 及 gen_metadata 归属 ID 重写为 newCid，
      //    使迁入后的全部历史步序（#1/#3/#5…）在目标端完整连贯呈现且不撞跨端摘要镜像。
      let sourceMetaBlob = null;
      withWritableSqliteDb(dstDbPath, (dstDb) => {
        const origMeta = dstDb.prepare('SELECT trajectory_id FROM trajectory_meta LIMIT 1').get();
        const srcTid = String(origMeta?.trajectory_id || '').trim().toLowerCase();

        dstDb.exec('BEGIN IMMEDIATE');
        try {
          dstDb
            .prepare('UPDATE trajectory_meta SET trajectory_id = ?, cascade_id = ?, source = ?')
            .run(newTid, newCid, dstDef.trajectorySourceNum);

          const metaRow = dstDb
            .prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main' LIMIT 1")
            .get();
          if (metaRow?.data) {
            sourceMetaBlob = Buffer.from(metaRow.data);
            const wsBytes = migratorBuildWorkspaceSubmessage(rawUri, dstDef.id);
            const primaryMetaUri = dstDef.id === 'cli' ? rawUri : encodedUri;
            const metaReplacements = new Map([
              [1, wsBytes.length > 0 ? encodeProtoBytesField(1, wsBytes) : null],
              [6, encodeProtoStringField(6, newCid)],
              [7, primaryMetaUri ? encodeProtoStringField(7, primaryMetaUri) : null],
              [18, encodeProtoStringField(18, resolvedProjectId)],
            ]);
            const patchedMeta = patchProtoMessageFields(sourceMetaBlob, metaReplacements);
            dstDb
              .prepare("UPDATE trajectory_metadata_blob SET data = ? WHERE id = 'main'")
              .run(patchedMeta);
          }

          if (mode === 'move') {
            try {
              const stepRows = dstDb
                .prepare('SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL')
                .all();
              const updStep = dstDb.prepare('UPDATE steps SET metadata = ? WHERE idx = ?');
              for (const row of stepRows || []) {
                const patched = migratorPatchStepMetadataOwnership(row.metadata, {
                  srcCid,
                  newCid,
                  srcTid,
                  newTid,
                });
                if (patched) {
                  updStep.run(patched, row.idx);
                }
              }
            } catch {
              // 兼容不含 steps 表的最小结构
            }

            try {
              const genRows = dstDb
                .prepare('SELECT idx, data FROM gen_metadata WHERE data IS NOT NULL')
                .all();
              const updGen = dstDb.prepare('UPDATE gen_metadata SET data = ?, size = ? WHERE idx = ?');
              for (const row of genRows || []) {
                const patched = migratorPatchGenMetadataOwnership(row.data, srcCid, newCid);
                if (patched) {
                  updGen.run(patched, patched.length, row.idx);
                }
              }
            } catch {
              // 兼容不含 gen_metadata 表的最小结构
            }
          }

          dstDb.exec('COMMIT');
        } catch (txErr) {
          try {
            dstDb.exec('ROLLBACK');
          } catch {
            // 忽略回滚异常
          }
          throw txErr;
        }
      });

      // 3. 拷贝 brain/<srcCid> -> brain/<newCid>（严格跳过任何嵌套符号链接）
      //    - move：完整拷贝至目标端，源端随后剥离整个 .system_generated 与 scratch，仅留媒体附件；
      //    - clone：仅拷贝媒体与人工制品，排除源会话 .system_generated / scratch，杜绝无归属 transcript 触发克隆双计费。
      const srcBrainDir = srcBrainCheck.path;
      if (srcBrainCheck.exists && srcBrainCheck.stat?.isDirectory()) {
        cpSync(srcBrainDir, dstBrainDir, {
          recursive: true,
          force: true,
          filter: (srcPath) => {
            try {
              if (lstatSync(srcPath).isSymbolicLink()) return false;
            } catch {
              return false;
            }
            if (mode === 'clone') {
              const leaf = basename(srcPath);
              return leaf !== '.system_generated' && leaf !== 'scratch';
            }
            return true;
          },
        });
      }

      // 4. 写入 annotations/<newCid>.pbtxt，保障标题立即可见
      const escapedTitle = migratorEscapePbtxtString(finalTitle);
      const annContent =
        dstDef.id === 'desktop'
          ? `title:"${escapedTitle}" last_user_view_time:{seconds:${Math.floor(itemNowMs / 1000)} nanos:0}\n`
          : `title:"${escapedTitle}"\n`;
      writeFileSync(dstAnnPath, annContent, 'utf8');

      // 5. 移动模式下，在写入摘要库之前先移除源 `.db`（若被原端锁定则立即干净回滚，不留双份脑裂）
      if (mode === 'move') {
        try {
          rmSync(srcDbPath, { force: true });
          for (const suffix of ['.db-wal', '.db-shm', '.db-journal']) {
            const scCheck = resolveNoFollowFile(srcRoot, ['conversations', `${srcCid}${suffix}`]);
            if (scCheck.ok && scCheck.exists) {
              rmSync(scCheck.path, { force: true });
            }
          }
          if (srcAnnCheck.exists) {
            try {
              rmSync(srcAnnCheck.path, { force: true });
            } catch {
              // 忽略源注释清理失败
            }
          }
          // 移动模式下日志与运行产物已完整拷入目标端 brain/<newCid>，逐级防软链移除源端整个 .system_generated 与 scratch 明文目录
          for (const subSeg of ['.system_generated', 'scratch']) {
            const subCheck = resolveNoFollowPath(srcRoot, ['brain', srcCid, subSeg]);
            if (subCheck.ok && subCheck.exists) {
              try {
                rmSync(subCheck.path, { recursive: true, force: true });
              } catch {
                // 忽略源临时运行目录清理异常
              }
            }
          }
        } catch (unlinkErr) {
          migratorCleanupTargetArtifacts({
            dstDbPath,
            dstAnnPath,
            dstBrainDir,
            removeBrain: !dstBrainExistedBefore,
          });
          if (archivedSrcDbPath && existsSync(archivedSrcDbPath)) {
            try {
              rmSync(archivedSrcDbPath, { force: true });
            } catch {
              // ignore
            }
          }
          results.push({
            ok: false,
            sourceCascadeId: srcCid,
            error: migratorIsFileLockError(unlinkErr)
              ? 'source_locked'
              : unlinkErr?.message || 'source_remove_failed',
          });
          continue;
        }
      }

      // 6. 准备摘要库写入记录
      const lastUserInputSql =
        String(srcSummary?.last_user_input_time || '').trim() || itemNowSql;
      const lastUserInputMs = parseIsoMs(normalizeSqliteIsoTime(lastUserInputSql)) || itemNowMs;
      const lastUserInputStepIndex =
        srcSummary?.last_user_input_step_index != null
          ? Number(srcSummary.last_user_input_step_index)
          : Number(dbLight?.lastUserInputStepIndex ?? -1);

      const patchedRawSummary = migratorBuildPatchedRawSummary({
        sourceRawSummary: srcSummary?.raw_summary || null,
        sourceMetaBlob,
        newCid,
        newTid,
        title: finalTitle,
        stepCount,
        nowMs: itemNowMs,
        createdMs: dbLight?.createdMs || lastUserInputMs,
        lastUserInputMs,
        lastUserInputStepIndex,
        trajectoryType: dbLight?.trajectoryType || 4,
        targetClientId: dstDef.id,
        targetProjectId: resolvedProjectId,
        rawUri,
        encodedUri,
      });

      const workspaceUrisCol =
        dstDef.id === 'cli'
          ? rawUri
            ? JSON.stringify([rawUri])
            : '[]'
          : encodedUri
            ? JSON.stringify([encodedUri])
            : '';

      pendingSummaryInserts.push({
        srcCid,
        newCid,
        newTid,
        title: finalTitle,
        stepCount,
        nowSql: itemNowSql,
        workspaceUrisCol,
        projectId: resolvedProjectId,
        lastUserInputSql,
        lastUserInputStepIndex,
        appDataDir: dstDef.appDataDir,
        patchedRawSummary,
        srcDbPath,
        archivedSrcDbPath,
        cascadeSubagentIds,
        dstDbPath,
        dstBrainDir,
        dstBrainExistedBefore,
        dstAnnPath,
      });
    } catch (err) {
      migratorCleanupTargetArtifacts({
        dstDbPath,
        dstAnnPath,
        dstBrainDir,
        removeBrain: !dstBrainExistedBefore,
      });
      results.push({
        ok: false,
        sourceCascadeId: srcCid,
        error: err?.message || 'migrate_failed',
      });
    }
  }

  // 7. 在单事务中把成功迁移的会话摘要写入目标 conversation_summaries.db（移动模式同步从源摘要库移除）
  if (pendingSummaryInserts.length > 0) {
    try {
      withWritableSqliteDb(dstSumDbPath, (dstSumDb) => {
        const tableCols = new Set(
          (dstSumDb.prepare('PRAGMA table_info(conversation_summaries)').all() || []).map((c) =>
            String(c?.name || '').trim().toLowerCase()
          )
        );
        const allColBuilders = [
          ['conversation_id', (it) => it.newCid],
          ['title', (it) => it.title],
          ['preview', (it) => it.title],
          ['step_count', (it) => it.stepCount],
          ['last_modified_time', (it) => it.nowSql],
          ['workspace_uris', (it) => it.workspaceUrisCol],
          ['status', () => 'CASCADE_RUN_STATUS_IDLE'],
          ['source', () => ''],
          ['project_id', (it) => it.projectId],
          ['agent_name', () => ''],
          ['parent_conversation_id', () => ''],
          ['nesting_depth', () => 0],
          ['battle_id', () => ''],
          ['winning_conversation_id', () => ''],
          ['not_fully_idle', () => 0],
          ['killed', () => 0],
          ['last_user_input_time', (it) => it.lastUserInputSql],
          ['last_user_input_step_index', (it) => it.lastUserInputStepIndex],
          ['app_data_dir', (it) => it.appDataDir],
          ['raw_summary', (it) => it.patchedRawSummary],
          ['group_id', () => ''],
        ];
        const activeBuilders =
          tableCols.size > 0
            ? allColBuilders.filter(([col]) => tableCols.has(col))
            : allColBuilders;
        const colSql = activeBuilders.map(([col]) => col).join(', ');
        const placeholdersSql = activeBuilders.map(() => '?').join(', ');
        const insertStmt = dstSumDb.prepare(
          `INSERT OR REPLACE INTO conversation_summaries (${colSql}) VALUES (${placeholdersSql})`
        );
        dstSumDb.exec('BEGIN IMMEDIATE');
        try {
          for (const item of pendingSummaryInserts) {
            insertStmt.run(...activeBuilders.map(([, getVal]) => getVal(item)));
          }
          dstSumDb.exec('COMMIT');
        } catch (txErr) {
          try {
            dstSumDb.exec('ROLLBACK');
          } catch {
            // 忽略回滚异常
          }
          throw txErr;
        }
      });

      if (mode === 'move') {
        const allCascadeSubs = [];
        for (const item of pendingSummaryInserts) {
          if (Array.isArray(item.cascadeSubagentIds)) {
            allCascadeSubs.push(...item.cascadeSubagentIds);
          }
        }
        migratorCleanupMovedSourceIndexes(
          srcRoot,
          srcDef,
          pendingSummaryInserts.map((item) => item.srcCid),
          allCascadeSubs,
          warnings
        );
        for (const item of pendingSummaryInserts) {
          recordMigrationProtectionLink({
            backupDir: backupRoot,
            geminiDir,
            sourceClientId: srcDef.id,
            sourceSessionId: item.srcCid,
            targetClientId: dstDef.id,
            targetSessionId: item.newCid,
          });
        }
        migratorPruneArchivedSourceDbs(archiveSrcDir);

        const ledgerStore = resolveScopedTrajectoryCacheStore(options, getLocalTrajectoryCacheStore);
        if (ledgerStore && typeof ledgerStore.rekeyConversations === 'function') {
          try {
            ledgerStore.rekeyConversations(
              pendingSummaryInserts.map((item) => ({
                fromCascadeId: item.srcCid,
                toCascadeId: item.newCid,
                patchMeta: { title: item.title, archived: false },
              }))
            );
          } catch (rekeyErr) {
            warnings.push(`ledger_rekey_failed: ${rekeyErr?.message || 'unknown'}`);
          }
        }
      }

      for (const item of pendingSummaryInserts) {
        results.push({
          ok: true,
          mode,
          sourceCascadeId: item.srcCid,
          newCascadeId: item.newCid,
          title: item.title,
          stepCount: item.stepCount,
          projectId: item.projectId,
          ...(item.archivedSrcDbPath ? { archivedSourcePath: item.archivedSrcDbPath } : {}),
          ...(dstDef.id === 'cli' ? { resumeCommand: `agy --conversation ${item.newCid}` } : {}),
        });
      }
    } catch (sumErr) {
      // 摘要库写入失败时完整回滚本批次已创建的副本文件，并在移动模式下恢复源 `.db`
      for (const item of pendingSummaryInserts) {
        migratorCleanupTargetArtifacts({
          dstDbPath: item.dstDbPath,
          dstAnnPath: item.dstAnnPath,
          dstBrainDir: item.dstBrainDir,
          removeBrain: !item.dstBrainExistedBefore,
        });
        if (mode === 'move' && item.archivedSrcDbPath && existsSync(item.archivedSrcDbPath)) {
          try {
            cpSync(item.archivedSrcDbPath, item.srcDbPath, { force: true });
          } catch {
            // 忽略恢复异常（归档备份仍保留在 backupDir）
          }
        }
        results.push({
          ok: false,
          sourceCascadeId: item.srcCid,
          error: sumErr?.message || 'summary_write_failed',
        });
      }
    }
  }

  const migratedCount = results.filter((r) => r.ok).length;
  const failedCount = results.length - migratedCount;
  const firstError = migratedCount === 0 ? results.find((r) => !r.ok)?.error || 'migrate_failed' : '';
    return {
      ok: migratedCount > 0,
      status: migratedCount > 0 ? 200 : 400,
      ...(firstError ? { error: firstError } : {}),
      mode,
      sourceClient: srcDef.id,
      targetClient: dstDef.id,
      targetProjectId: resolvedProjectId,
      migratedCount,
      failedCount,
      backupPath,
      ...(warnings.length > 0 ? { warnings } : {}),
      needsWindowReload: dstDef.id === 'desktop' && migratedCount > 0,
      results,
    };
  } finally {
    while (releaseLocks.length > 0) {
      releaseLocks.pop()?.();
    }
  }
}
