/**
 * @fileoverview 轻量级跨进程桥接租约与活跃 Sidecar 数据目录定位工具 (`bridge-paths.mjs`).
 *
 * 零重型依赖（仅使用 Node 内置模块），供 `config.mjs`、`window-bridge.mjs`、
 * `host-theme-store.mjs`、`http-helpers.mjs` 与 `mcp-entry.mjs` 共享同一事实源：
 * 1. 将 `window-bridge-lease.json` 存放于脱离 `DATA_DIR` 的用户级共享路径（按 `ANTIGRAVITY_GEMINI_DIR`
 *    / `homedir()` 哈希隔离于 `os.tmpdir()`），避免 Antigravity 2.36.0 下 Sidecar 与 MCP 守护进程
 *    因 `DATA_DIR` 解析不一致而看不到彼此租约、引发双 Leader 争抢顶栏胶囊；
 * 2. 在共享租约中记录并读取活跃 Sidecar 的 `sidecarDataDir`，使未获宿主注入
 *    `ANTIGRAVITY_EXECUTABLE_DATA_DIR` 的 MCP `bridge-daemon` 自动对齐至同一份 `settings.json` 与缓存目录。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export function resolveSharedGeminiBaseDir(env = process.env, homeDir = homedir()) {
  const envGemini = String(env?.ANTIGRAVITY_GEMINI_DIR || '').trim();
  return envGemini || join(homeDir, '.gemini');
}

function normalizeScopeKey(dirPath, platform = process.platform) {
  const clean = String(dirPath || '').trim();
  if (!clean) return '';
  return platform === 'win32'
    ? clean.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
    : clean.replace(/\/+$/, '') || '/';
}

/**
 * 解析脱离 `DATA_DIR` 的跨进程共享桥接租约路径。
 * - 显式配置 `USAGE_MONITOR_BRIDGE_LEASE_FILE` 时直接采用；
 * - 测试沙箱（`ANTIGRAVITY_LS_ADDRESS=test.invalid`）维持 `DATA_DIR/window-bridge-lease.json` 隔离；
 * - 生产环境按规范化的 `ANTIGRAVITY_GEMINI_DIR` 计算 12 位 SHA-256 哈希落于 `os.tmpdir()`，
 *   确保同用户同环境下的 Sidecar 与 MCP `bridge-daemon` 永远读写同一份租约文件。
 *
 * @param {object} [options]
 * @returns {string}
 */
export function resolveBridgeLeaseFilePath({
  env = process.env,
  dataDir = '',
  tmpDir = tmpdir(),
  homeDir = homedir(),
  platform = process.platform,
} = {}) {
  const explicitLease = String(env?.USAGE_MONITOR_BRIDGE_LEASE_FILE || '').trim();
  if (explicitLease) {
    return explicitLease;
  }
  if (String(env?.ANTIGRAVITY_LS_ADDRESS || '').trim() === 'test.invalid') {
    const cleanDataDir = String(dataDir || '').trim();
    return cleanDataDir ? join(cleanDataDir, 'window-bridge-lease.json') : '';
  }
  const geminiBase = resolveSharedGeminiBaseDir(env, homeDir);
  const scopeKey = normalizeScopeKey(geminiBase, platform) || 'default';
  const scopeHash = createHash('sha256').update(scopeKey).digest('hex').slice(0, 12);
  return join(tmpDir, `antigravity-usage-monitor-lease-${scopeHash}.json`);
}

/**
 * 静默读取并解析桥接租约 JSON；文件缺失或损坏时返回 `null`。
 *
 * @param {string} leaseFilePath
 * @param {{ existsSyncFn?: typeof existsSync, readFileSyncFn?: typeof readFileSync }} [options]
 * @returns {Record<string, any> | null}
 */
export function readBridgeLeaseSync(
  leaseFilePath,
  { existsSyncFn = existsSync, readFileSyncFn = readFileSync } = {}
) {
  try {
    if (!leaseFilePath || !existsSyncFn(leaseFilePath)) return null;
    const parsed = JSON.parse(readFileSyncFn(leaseFilePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 从共享桥接租约中提取活跃 Sidecar 记录的持久化数据目录（`sidecarDataDir`）。
 * 仅当目录字符串有效且实际存在于磁盘时返回，供 MCP 进程在缺少 `ANTIGRAVITY_EXECUTABLE_DATA_DIR` 时对齐目录。
 *
 * @param {object} [options]
 * @returns {string}
 */
export function resolveSharedSidecarDataDir({
  env = process.env,
  leaseFilePath = '',
  existsSyncFn = existsSync,
  readFileSyncFn = readFileSync,
  tmpDir = tmpdir(),
  homeDir = homedir(),
  platform = process.platform,
} = {}) {
  if (String(env?.ANTIGRAVITY_LS_ADDRESS || '').trim() === 'test.invalid' && !leaseFilePath) {
    return '';
  }
  const targetLease =
    String(leaseFilePath || '').trim() ||
    resolveBridgeLeaseFilePath({ env, tmpDir, homeDir, platform });
  const lease = readBridgeLeaseSync(targetLease, { existsSyncFn, readFileSyncFn });
  if (!lease) return '';
  const candidate = String(
    lease.sidecarDataDir || (lease.role === 'sidecar' ? lease.dataDir : '') || ''
  ).trim();
  if (!candidate) return '';
  try {
    return existsSyncFn(candidate) ? candidate : '';
  } catch {
    return '';
  }
}
