/**
 * @fileoverview `DevToolsActivePort` 双行解析器、防碰撞 `/json/version` 快速探活与陈旧端口有界负缓存。
 *
 * 解决宿主崩溃、升级或无参重启后残留陈旧 `DevToolsActivePort` 文件引发的三类问题：
 * 1. Windows 回环死端口连接每次白等 ~1–1.5s TCP SYN 重传超时；
 * 2. 陈旧端口文件明确标出 `stalePortDetected`（供 UI 展示「陈旧端口一键重启恢复」引导，避免误导为防火墙拦截）；
 * 3. 旧端口号恰巧被其他本地开发服务（Vite / Webpack / 另一 Chromium 实例）复用时的身份碰撞。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';

const DEVTOOLS_PROBE_DEFAULT_TIMEOUT_MS = 1000;
const DEVTOOLS_PROBE_TIMEOUT_NEG_TTL_MS = 15_000;
const DEVTOOLS_PROBE_MAX_NEGATIVE_CACHE = 64;
const DEVTOOLS_PROBE_MAX_BODY_BYTES = 16 * 1024;
const DEVTOOLS_PROBE_MAX_LIST_BODY_BYTES = 256 * 1024;

let cachedDevToolsNodeHttpPromise = null;

async function getDevToolsProbeHttpModule() {
  if (!cachedDevToolsNodeHttpPromise) {
    cachedDevToolsNodeHttpPromise = import('node:http').then((mod) => mod.default || mod);
  }
  return cachedDevToolsNodeHttpPromise;
}

/**
 * 根据 `DevToolsActivePort` 候选路径识别其所属宿主产品（`'ide'`、`'vscode'` 或 `'desktop'`）。
 *
 * @param {unknown} filePath
 * @returns {'ide'|'vscode'|'desktop'}
 */
export function classifyDevToolsPortProduct(filePath) {
  const norm = String(filePath || '').replace(/\\/g, '/');
  if (/(?:^|\/)antigravity[\s_-]*ide(?:\/|$)/i.test(norm) || /\.antigravity-ide(?:\/|$)/i.test(norm)) {
    return 'ide';
  }
  if (
    /(?:^|\/)(?:code|code\s*-\s*insiders|code-insiders)\/devtoolsactiveport$/i.test(norm) ||
    /(?:^|\/)\.vscode(?:-insiders)?(?:\/|$)/i.test(norm)
  ) {
    return 'vscode';
  }
  return 'desktop';
}

/**
 * 解析 `DevToolsActivePort` 文件内容（第 1 行本地调试端口，第 2 行可选 `/devtools/browser/<id>` 路径）。
 *
 * @param {unknown} rawText
 * @returns {{ port: number, browserWsPath: string }|null}
 */
export function parseDevToolsActivePortDescriptor(rawText) {
  if (typeof rawText !== 'string' || !rawText) return null;
  const lines = rawText.split(/\r?\n/);
  const firstLine = String(lines[0] || '').trim();
  if (!/^\d+$/.test(firstLine)) return null;
  const port = Number(firstLine);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const secondLine = String(lines[1] || '').trim();
  const browserWsPath = secondLine.startsWith('/') ? secondLine : '';
  return { port, browserWsPath };
}

/**
 * 校验 `/json/version` 返回体是否为合法的 Chromium DevTools 实例，并在提供 `expectedBrowserWsPath` 时防端口复用碰撞。
 *
 * @param {unknown} versionPayload
 * @param {string} [expectedBrowserWsPath='']
 * @returns {{ valid: boolean, reason: string }}
 */
export function verifyDevToolsBrowserIdentity(versionPayload, expectedBrowserWsPath = '') {
  if (!versionPayload || typeof versionPayload !== 'object' || Array.isArray(versionPayload)) {
    return { valid: false, reason: 'invalid_version_payload' };
  }
  const wsUrl = String(versionPayload.webSocketDebuggerUrl || '').trim();
  const browserLabel = String(versionPayload.Browser || versionPayload['Protocol-Version'] || '').trim();
  if (!wsUrl && !browserLabel) {
    return { valid: false, reason: 'not_devtools_endpoint' };
  }
  const cleanExpectedPath = String(expectedBrowserWsPath || '').trim();
  if (cleanExpectedPath && wsUrl) {
    try {
      const parsed = new URL(wsUrl);
      if (parsed.pathname !== cleanExpectedPath) {
        return { valid: false, reason: 'browser_ws_path_mismatch' };
      }
    } catch {
      if (!wsUrl.endsWith(cleanExpectedPath)) {
        return { valid: false, reason: 'browser_ws_path_mismatch' };
      }
    }
  } else if (cleanExpectedPath && !wsUrl) {
    return { valid: false, reason: 'missing_browser_ws_url' };
  }
  return { valid: true, reason: 'ok' };
}

/**
 * 校验 `/json/list` 回退探活响应是否为合法的 Chromium DevTools 目标列表（用于仅实现 `/json/list` 的精简调试代理）。
 *
 * @param {unknown} listPayload
 * @returns {boolean}
 */
export function isValidDevToolsTargetList(listPayload) {
  if (!Array.isArray(listPayload)) return false;
  for (const item of listPayload) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const hasCdpShape =
      typeof item.url === 'string' ||
      typeof item.webSocketDebuggerUrl === 'string' ||
      typeof item.type === 'string';
    if (!hasCdpShape) return false;
  }
  return true;
}

async function defaultFetchLocalDevToolsJson(
  port,
  urlPath,
  timeoutMs = DEVTOOLS_PROBE_DEFAULT_TIMEOUT_MS,
  maxBodyBytes = DEVTOOLS_PROBE_MAX_BODY_BYTES
) {
  const http = await getDevToolsProbeHttpModule();
  return new Promise((resolve, reject) => {
    let settled = false;
    let hardTimer = null;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      if (hardTimer) {
        clearTimeout(hardTimer);
        hardTimer = null;
      }
      if (err) reject(err);
      else resolve(val);
    };
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        timeout: timeoutMs,
      },
      (res) => {
        res.on('error', (err) => finish(err));
        if (res.statusCode !== 200) {
          res.resume();
          finish(new Error(`HTTP_${res.statusCode || 0}`));
          return;
        }
        let raw = '';
        let bytes = 0;
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          bytes += Buffer.byteLength(chunk, 'utf8');
          if (bytes > maxBodyBytes) {
            req.destroy(new Error('RESPONSE_TOO_LARGE'));
            return;
          }
          raw += chunk;
        });
        res.on('end', () => {
          try {
            finish(null, JSON.parse(raw));
          } catch {
            finish(new Error('INVALID_JSON'));
          }
        });
      }
    );
    hardTimer = setTimeout(() => {
      req.destroy(new Error('PROBE_TIMEOUT'));
      finish(new Error('PROBE_TIMEOUT'));
    }, timeoutMs + 50);
    hardTimer.unref?.();
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('PROBE_TIMEOUT'));
    });
    req.on('error', (err) => finish(err));
  });
}

async function defaultFetchDevToolsVersion(port, timeoutMs = DEVTOOLS_PROBE_DEFAULT_TIMEOUT_MS) {
  return defaultFetchLocalDevToolsJson(
    port,
    '/json/version',
    timeoutMs,
    DEVTOOLS_PROBE_MAX_BODY_BYTES
  );
}

async function defaultFetchDevToolsList(port, timeoutMs = DEVTOOLS_PROBE_DEFAULT_TIMEOUT_MS) {
  return defaultFetchLocalDevToolsJson(
    port,
    '/json/list',
    timeoutMs,
    DEVTOOLS_PROBE_MAX_LIST_BODY_BYTES
  );
}

/**
 * 创建带陈旧端口文件有界负缓存（默认 64 条）的 `DevToolsActivePort` 快速探活器。
 *
 * @param {{
 *   timeoutMs?: number,
 *   maxNegativeCacheEntries?: number,
 *   fetchVersionFn?: ((port: number, timeoutMs: number) => Promise<any>)|null,
 *   fetchListFn?: ((port: number, timeoutMs: number) => Promise<any>)|null,
 *   fsOps?: { existsSync?: typeof existsSync, readFileSync?: typeof readFileSync, statSync?: typeof statSync }|null,
 * }} [options]
 */
export function createDevToolsPortProber(options = {}) {
  const timeoutMs = Math.max(80, Number(options.timeoutMs) || DEVTOOLS_PROBE_DEFAULT_TIMEOUT_MS);
  const timeoutNegTtlMs = Math.max(
    100,
    Number(options.timeoutNegativeTtlMs) || DEVTOOLS_PROBE_TIMEOUT_NEG_TTL_MS
  );
  const nowFn = options.nowFn || Date.now;
  const maxCache = Math.max(8, Number(options.maxNegativeCacheEntries) || DEVTOOLS_PROBE_MAX_NEGATIVE_CACHE);
  const fetchVersion = options.fetchVersionFn || defaultFetchDevToolsVersion;
  const fetchList =
    options.fetchListFn ||
    (options.fetchVersionFn
      ? async () => {
          throw new Error('HTTP_404');
        }
      : defaultFetchDevToolsList);
  const fsExists = options.fsOps?.existsSync || existsSync;
  const fsRead = options.fsOps?.readFileSync || readFileSync;
  const fsStat = options.fsOps?.statSync || statSync;

  /** @type {Map<string, { mtimeMs: number, size: number, port: number, browserWsPath: string, reason: string, cachedAtMs?: number }>} */
  const negativeCache = new Map();
  /** @type {Map<string, { mtimeMs: number, size: number, port: number, browserWsPath: string }>} */
  const verifiedLiveFiles = new Map();

  function rememberNegative(filePath, entry) {
    if (!filePath) return;
    negativeCache.delete(filePath);
    if (negativeCache.size >= maxCache) {
      const oldestKey = negativeCache.keys().next().value;
      if (oldestKey !== undefined) negativeCache.delete(oldestKey);
    }
    negativeCache.set(filePath, entry);
  }

  function rememberVerifiedLive(filePath, entry) {
    if (!filePath) return;
    verifiedLiveFiles.delete(filePath);
    if (verifiedLiveFiles.size >= maxCache) {
      const oldestKey = verifiedLiveFiles.keys().next().value;
      if (oldestKey !== undefined) verifiedLiveFiles.delete(oldestKey);
    }
    verifiedLiveFiles.set(filePath, entry);
  }

  function matchesVerifiedLive(filePath, item) {
    if (!filePath || !item) return false;
    const prev = verifiedLiveFiles.get(filePath);
    return Boolean(
      prev &&
        prev.mtimeMs === item.mtimeMs &&
        prev.size === item.size &&
        prev.port === item.port &&
        prev.browserWsPath === item.browserWsPath
    );
  }

  /**
   * 扫描并并发探活候选 `DevToolsActivePort` 文件与显式环境变量端口。
   *
   * @param {{
   *   candidateFiles?: string[],
   *   explicitPortsRaw?: string,
   * }} [params]
   */
  async function probeActiveDevToolsPorts({ candidateFiles = [], explicitPortsRaw = '' } = {}) {
    const staleFiles = [];
    const transientTimeoutFiles = [];
    const staleProductsSet = new Set();
    const liveProductsSet = new Set();
    /** @type {Array<{ source: 'file'|'env', filePath: string, product: 'ide'|'desktop', port: number, browserWsPath: string, mtimeMs: number, size: number }>} */
    const toProbe = [];

    for (const rawFile of Array.isArray(candidateFiles) ? candidateFiles : []) {
      const filePath = String(rawFile || '').trim();
      if (!filePath) continue;
      let rawText = '';
      let mtimeMs = 0;
      let size = 0;
      try {
        if (!fsExists(filePath)) {
          negativeCache.delete(filePath);
          verifiedLiveFiles.delete(filePath);
          continue;
        }
        const st = fsStat(filePath);
        mtimeMs = Number(st?.mtimeMs || 0);
        size = Number(st?.size || 0);
        rawText = String(fsRead(filePath, 'utf8') || '');
      } catch {
        continue;
      }

      const desc = parseDevToolsActivePortDescriptor(rawText);
      if (!desc) {
        negativeCache.delete(filePath);
        verifiedLiveFiles.delete(filePath);
        continue;
      }

      const product = classifyDevToolsPortProduct(filePath);
      const cachedNeg = negativeCache.get(filePath);
      const isTimeoutNegExpired =
        cachedNeg?.reason === 'PROBE_TIMEOUT' &&
        nowFn() - Number(cachedNeg.cachedAtMs || 0) >= timeoutNegTtlMs;
      if (
        cachedNeg &&
        !isTimeoutNegExpired &&
        cachedNeg.mtimeMs === mtimeMs &&
        cachedNeg.size === size &&
        cachedNeg.port === desc.port &&
        cachedNeg.browserWsPath === desc.browserWsPath
      ) {
        // 刷新 LRU 顺序并零网络开销跳过已知陈旧死端口文件
        rememberNegative(filePath, cachedNeg);
        staleFiles.push({ filePath, port: desc.port, product, reason: cachedNeg.reason });
        staleProductsSet.add(product);
        continue;
      }
      if (isTimeoutNegExpired) {
        negativeCache.delete(filePath);
      }

      toProbe.push({
        source: 'file',
        filePath,
        product,
        port: desc.port,
        browserWsPath: desc.browserWsPath,
        mtimeMs,
        size,
      });
    }

    const rawEnvPorts = String(explicitPortsRaw || '').trim();
    if (rawEnvPorts) {
      for (const token of rawEnvPorts.split(/[\s,]+/)) {
        if (!/^\d+$/.test(token)) continue;
        const p = Number(token);
        if (Number.isInteger(p) && p > 0 && p <= 65535) {
          toProbe.push({
            source: 'env',
            filePath: '',
            product: 'desktop',
            port: p,
            browserWsPath: '',
            mtimeMs: 0,
            size: 0,
          });
        }
      }
    }

    /** @type {Map<number, Promise<{ ok: boolean, mode?: 'version'|'list_fallback', payload?: any, errorReason?: string }>>} */
    const inflightByPort = new Map();
    for (const item of toProbe) {
      if (!inflightByPort.has(item.port)) {
        inflightByPort.set(
          item.port,
          Promise.resolve()
            .then(() => fetchVersion(item.port, timeoutMs))
            .then((payload) => ({ ok: true, mode: /** @type {const} */ ('version'), payload }))
            .catch(async (err) => {
              const codeOrMsg = String(err?.code || err?.message || 'unreachable');
              if (codeOrMsg === 'HTTP_404') {
                try {
                  const listPayload = await fetchList(item.port, timeoutMs);
                  if (isValidDevToolsTargetList(listPayload)) {
                    return {
                      ok: true,
                      mode: /** @type {const} */ ('list_fallback'),
                      payload: listPayload,
                    };
                  }
                } catch {
                  // `/json/list` 也失败或非 JSON 时判定为非 DevTools 服务
                }
                return { ok: false, errorReason: 'not_devtools_endpoint' };
              }
              return {
                ok: false,
                errorReason: codeOrMsg,
              };
            })
        );
      }
    }

    const livePorts = [];
    const seenLivePorts = new Set();
    const vsCodeLivePortsSet = new Set();
    let explicitPortUnreachable = false;

    for (const item of toProbe) {
      const probeRes = await inflightByPort.get(item.port);
      if (probeRes && probeRes.ok) {
        const identity =
          probeRes.mode === 'list_fallback'
            ? { valid: true, reason: 'ok_list_fallback' }
            : verifyDevToolsBrowserIdentity(probeRes.payload, item.browserWsPath);
        if (identity.valid) {
          if (item.filePath) {
            negativeCache.delete(item.filePath);
            rememberVerifiedLive(item.filePath, {
              mtimeMs: item.mtimeMs,
              size: item.size,
              port: item.port,
              browserWsPath: item.browserWsPath,
            });
          }
          if (item.source === 'file') {
            liveProductsSet.add(item.product);
            if (item.product === 'vscode') {
              vsCodeLivePortsSet.add(item.port);
            }
          }
          if (!seenLivePorts.has(item.port)) {
            seenLivePorts.add(item.port);
            livePorts.push(item.port);
          }
          continue;
        }
        if (item.source === 'file') {
          verifiedLiveFiles.delete(item.filePath);
          rememberNegative(item.filePath, {
            mtimeMs: item.mtimeMs,
            size: item.size,
            port: item.port,
            browserWsPath: item.browserWsPath,
            reason: identity.reason,
            cachedAtMs: nowFn(),
          });
          staleFiles.push({
            filePath: item.filePath,
            port: item.port,
            product: item.product,
            reason: identity.reason,
          });
          staleProductsSet.add(item.product);
        } else {
          explicitPortUnreachable = true;
        }
        continue;
      }

      const failReason = probeRes?.errorReason || 'unreachable';
      if (item.source === 'file') {
        const isTransientBusyLivePort =
          failReason === 'PROBE_TIMEOUT' && matchesVerifiedLive(item.filePath, item);
        if (isTransientBusyLivePort) {
          // 已经成功连通的活端口在高负载下单次超时绝不封禁 15 秒，下一轮立即复测
          transientTimeoutFiles.push({
            filePath: item.filePath,
            port: item.port,
            product: item.product,
            reason: failReason,
          });
        } else {
          verifiedLiveFiles.delete(item.filePath);
          rememberNegative(item.filePath, {
            mtimeMs: item.mtimeMs,
            size: item.size,
            port: item.port,
            browserWsPath: item.browserWsPath,
            reason: failReason,
            cachedAtMs: nowFn(),
          });
          staleFiles.push({
            filePath: item.filePath,
            port: item.port,
            product: item.product,
            reason: failReason,
          });
          staleProductsSet.add(item.product);
        }
      } else {
        explicitPortUnreachable = true;
      }
    }

    return {
      livePorts,
      vsCodeLivePorts: Array.from(vsCodeLivePortsSet),
      liveProducts: Array.from(liveProductsSet),
      staleFiles,
      transientTimeoutFiles,
      hasTransientTimeout: transientTimeoutFiles.length > 0,
      staleProducts: Array.from(staleProductsSet),
      stalePortDetected: staleFiles.length > 0,
      explicitPortUnreachable,
    };
  }

  return {
    probeActiveDevToolsPorts,
    clearCache: () => {
      negativeCache.clear();
      verifiedLiveFiles.clear();
    },
    getNegativeCacheSize: () => negativeCache.size,
  };
}
