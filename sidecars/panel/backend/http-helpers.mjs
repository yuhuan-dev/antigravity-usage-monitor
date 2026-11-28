/**
 * @fileoverview 零业务状态依赖的静态资源读取与本机回环请求来源校验工具。
 *
 * 独立于 `./config.mjs` 与 `./api-actions.mjs`，使宿主入口 `main.mjs` 在生产环境下无需加载完整后端图谱与轨迹缓存。
 */

import { existsSync, readFileSync, promises as fsPromises } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeHostThemeSnapshot } from '../shared/host-theme.mjs';
import {
  readBridgeLeaseSync,
  resolveBridgeLeaseFilePath,
  resolveSharedSidecarDataDir,
} from './bridge-paths.mjs';

function resolveHttpHelperPanelDir() {
  const modDir = dirname(fileURLToPath(import.meta.url));
  return /[\\/]backend$/i.test(modDir) ? dirname(modDir) : modDir;
}

function resolveHttpHelperDataDir() {
  const explicitDataDir = String(process?.env?.USAGE_MONITOR_DATA_DIR || '').trim();
  if (explicitDataDir) return explicitDataDir;
  if (process?.env?.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    return process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  }
  const sharedSidecarDir = resolveSharedSidecarDataDir();
  if (sharedSidecarDir) return sharedSidecarDir;
  const geminiBase = String(process?.env?.ANTIGRAVITY_GEMINI_DIR || '').trim() || join(homedir(), '.gemini');
  const candidates = [
    join(geminiBase, 'antigravity', 'sidecar_data', 'usage-monitor', 'panel', 'data'),
    join(geminiBase, 'antigravity', 'sidecar_data', 'usage-monitor', 'data'),
    join(geminiBase, 'antigravity-cli', 'sidecar_data', 'usage-monitor', 'panel', 'data'),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return '';
}

/**
 * 轻量同步读取最近一次采集到的宿主主题快照（优先新鲜的桥接租约，其次持久化缓存），
 * 供 `main.mjs` 在 `GET /` 阶段零延迟注入首帧兜底样式，不引入重型后端依赖。
 *
 * @param {{ dataDir?: string, nowMs?: number }} [options]
 */
export function readCachedHostThemeSnapshotSync({
  dataDir = '',
  nowMs = Date.now(),
} = {}) {
  const explicitDir = String(dataDir || '').trim();
  const baseDir = explicitDir || resolveHttpHelperDataDir();

  const leaseCandidates = explicitDir
    ? [join(explicitDir, 'window-bridge-lease.json')]
    : [
        resolveBridgeLeaseFilePath({ dataDir: baseDir }),
        ...(baseDir ? [join(baseDir, 'window-bridge-lease.json')] : []),
      ];
  for (const leasePath of leaseCandidates) {
    const lease = readBridgeLeaseSync(leasePath);
    if (!lease) continue;
    const updatedAtMs = Number(lease?.updatedAtMs || 0);
    if (updatedAtMs > 0 && nowMs - updatedAtMs >= -5000 && nowMs - updatedAtMs <= 45_000) {
      const leaseTheme = normalizeHostThemeSnapshot(lease?.hostTheme);
      if (leaseTheme) return leaseTheme;
    }
  }

  if (!baseDir) return null;

  try {
    const cachePath = join(baseDir, 'host-theme-cache.json');
    if (existsSync(cachePath)) {
      return normalizeHostThemeSnapshot(JSON.parse(readFileSync(cachePath, 'utf8')));
    }
  } catch {
    // 忽略缓存文件损坏或不存在
  }

  return null;
}

/**
 * 判断输入值是否为非数组普通对象（Plain Object）。
 *
 * @param {unknown} v
 * @returns {boolean}
 */
export function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 异步读取 `sidecars/panel` 目录下的静态资源文件（兼容单元测试同步沙箱）。
 *
 * @param {string} relPath 相对路径
 * @returns {Promise<string>}
 */
export const readLocalAsync = async (relPath) => {
  const fullPath = join(resolveHttpHelperPanelDir(), relPath);
  if (typeof fsPromises !== 'undefined' && fsPromises?.readFile) {
    return fsPromises.readFile(fullPath, 'utf8');
  }
  return readFileSync(fullPath, 'utf8');
};

/**
 * 校验请求是否来自本机回环同端口地址 (`127.0.0.1` / `localhost` / `[::1]`) 或受信 Webview Origin，
 * 阻止跨端口本地服务（如本地其他端口的开发服务器）或跨站 DNS Rebinding 访问 API。
 *
 * @param {object} req
 * @returns {boolean}
 */
export function isLocalHostRequest(req) {
  if (!req?.headers) return true;
  const host = String(req.headers.host || '').trim().toLowerCase();
  const hostMatch = host.match(/^(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/);
  if (host && !hostMatch) {
    return false;
  }
  const origin = String(req.headers.origin || '').trim().toLowerCase();
  if (origin && /^vscode-webview:\/\/[a-z0-9._-]+$/.test(origin)) {
    return true;
  }
  const secFetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (secFetchSite === 'cross-site') {
    return false;
  }
  if (origin) {
    const originMatch = origin.match(
      /^(https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/
    );
    if (!originMatch) {
      return false;
    }
    if (hostMatch) {
      const defaultPort = originMatch[1] === 'https' ? '443' : '80';
      const originPort = originMatch[3] || defaultPort;
      const hostPort = hostMatch[2] || defaultPort;
      if (originPort !== hostPort) {
        return false;
      }
    }
  }
  return true;
}
