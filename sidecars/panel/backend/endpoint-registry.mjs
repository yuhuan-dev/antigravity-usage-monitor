/**
 * @fileoverview 多窗口 / SSH 远端端点注册表与按端点隔离的运行时状态存储。
 *
 * 职责：
 * 1. 管理 `'local'`（委托既有本机全局状态，100% 向后兼容）与每个 SSH/远端窗口的独立端点上下文；
 * 2. 为每个远端端点维护隔离的轨迹缓存、配额缓存、模型目录缓存、扫描冷却表与实时活动缓存；
 * 3. 对具备稳定主机标识的 SSH 端点按 `<prefix>-<sha256_12>.json` 原子持久化至 `DATA_DIR/remote_caches/`，
 *    临时端口端点仅驻留内存，防止磁盘残留垃圾文件；
 * 4. 维护同一远端主机的多窗口 CDP `targets` 映射、Tier-1 失败熔断器与 `inFlightCount` 防误回收保护。
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { LOCAL_ENDPOINT_ID } from '../shared/window-bridge-protocol.mjs';
import {
  DATA_DIR,
  clearRuntimeCaches,
  flushTrajectoryCacheNow,
  getCachedTrajectory,
  getCachedTrajectoryEntryByLower,
  getHydratedTrajectory,
  getHydratedTrajectoryEntryByLower,
  getLocalTrajectoryCacheStore,
  hasPendingTrajectoryCacheSave,
  listCachedTrajectoryEntries,
  loadJson,
  lsRuntimeEndpoint,
  persistTrajectoryCacheIfNeeded,
  quotaSummaryCache,
  removeCachedTrajectory,
  setCachedTrajectory,
} from './config.mjs';
import { createTrajectoryCacheStore } from './trajectory-cache-store.mjs';

const ENDPOINT_ID_REMOTE_RE = /^remote:[a-zA-Z0-9._:@-]{1,120}$/;
const ENDPOINT_STALE_TTL_MS = 60_000;
const ENDPOINT_TIER2_COOLDOWN_MS = 60_000;
const ENDPOINT_REMOTE_CACHE_DIR = join(DATA_DIR, 'remote_caches');

const remoteEndpointRegistry = new Map();
let nextEndpointInstanceId = 0;
let registeredWindowRpcInvoker = null;

/**
 * 校验并归一化 `endpointId`；空值默认回退 `'local'`，非法格式返回 `null`。
 *
 * @param {unknown} rawId
 * @returns {string|null}
 */
export function normalizeEndpointId(rawId) {
  if (rawId === undefined || rawId === null || rawId === '') {
    return LOCAL_ENDPOINT_ID;
  }
  const text = String(rawId).trim();
  if (!text || text === LOCAL_ENDPOINT_ID) {
    return LOCAL_ENDPOINT_ID;
  }
  if (!ENDPOINT_ID_REMOTE_RE.test(text)) {
    return null;
  }
  return text;
}

/**
 * 根据稳定主机名或回环 origin 构造确定性的远端 `endpointId` 与磁盘持久化标识。
 *
 * @param {{ origin?: string, hostLabel?: string, stableHostKey?: string }} info
 * @returns {{ id: string, label: string, stableHostKey: string, hasStableHostKey: boolean }}
 */
export function buildRemoteEndpointIdentity({ origin = '', hostLabel = '', stableHostKey = '' } = {}) {
  const cleanStable = String(stableHostKey || '').trim();
  const cleanLabel = String(hostLabel || cleanStable || '').trim();
  const cleanOrigin = String(origin || '').trim();

  let parsedHostPort = '';
  if (cleanOrigin) {
    try {
      const parsed = new URL(cleanOrigin);
      parsedHostPort = parsed.host;
    } catch {
      // 忽略非法 URL
    }
  }

  if (cleanStable) {
    const safePrefix = cleanStable
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'ssh';
    const hash = createHash('sha256').update(cleanStable.toLowerCase()).digest('hex').slice(0, 12);
    return {
      id: `remote:ssh-${safePrefix}-${hash}`,
      label: cleanLabel || cleanStable,
      stableHostKey: cleanStable.toLowerCase(),
      hasStableHostKey: true,
    };
  }

  const originBasis = (parsedHostPort || cleanOrigin || 'unknown').toLowerCase();
  const safeOrigin = originBasis
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'unknown';
  const hash = createHash('sha256').update(originBasis).digest('hex').slice(0, 8);
  return {
    id: `remote:${safeOrigin}-${hash}`,
    label: cleanLabel || parsedHostPort || 'SSH',
    stableHostKey: '',
    hasStableHostKey: false,
  };
}

function buildRemoteCacheFilePaths(stableHostKey) {
  if (!stableHostKey) return { cacheFilePath: '', sqliteFilePath: '' };
  const safePrefix = stableHostKey
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'ssh';
  const hash = createHash('sha256').update(stableHostKey.toLowerCase()).digest('hex').slice(0, 12);
  // 前缀加上 `ssh-` 可彻底规避 Windows 保留文件名（CON/NUL/PRN/AUX/COM1 等）
  return {
    cacheFilePath: join(ENDPOINT_REMOTE_CACHE_DIR, `ssh-${safePrefix}-${hash}.json`),
    sqliteFilePath: join(ENDPOINT_REMOTE_CACHE_DIR, `ssh-${safePrefix}-${hash}.sqlite`),
  };
}

function createRemoteQuotaCache() {
  return {
    ts: 0,
    lastAttemptTs: 0,
    accountName: '',
    accountGeneration: 0,
    data: null,
    error: null,
  };
}

function createRemoteEndpointStore(cacheFilePath, sqliteFilePath = '') {
  return createTrajectoryCacheStore({
    cacheFilePath,
    sqliteFilePath,
    loadJsonFn: loadJson,
    shouldBypassThrottleFn: (allowThrottleInTest) =>
      lsRuntimeEndpoint.addr === 'test.invalid' && !allowThrottleInTest,
  });
}

const LOOPBACK_HTTP_ORIGIN_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/i;

/**
 * 注册或更新一个 SSH / 远端窗口端点（幂等；同一远端主机多窗口共享端点并分离保活 UI 目标与可发起同源 RPC 的回环目标）。
 *
 * @param {{
 *   id?: string,
 *   origin?: string,
 *   baseUrl?: string,
 *   csrfToken?: string,
 *   wsUrl?: string,
 *   canInvokeRpc?: boolean,
 *   rpcWsUrls?: string[],
 *   clearRpcTargets?: boolean,
 *   tier1Verified?: boolean,
 *   tier1Only?: boolean,
 *   clearConnection?: boolean,
 *   onDisposeKey?: string,
 *   onDispose?: (() => void)|null,
 *   label?: string,
 *   stableHostKey?: string,
 * }} info
 */
export function registerRemoteEndpoint(info = {}) {
  const identity = info.id && ENDPOINT_ID_REMOTE_RE.test(info.id)
    ? {
        id: info.id,
        label: String(info.label || info.stableHostKey || 'SSH').trim() || 'SSH',
        stableHostKey: String(info.stableHostKey || '').trim().toLowerCase(),
        hasStableHostKey: Boolean(String(info.stableHostKey || '').trim()),
      }
    : buildRemoteEndpointIdentity({
        origin: info.origin || info.baseUrl,
        hostLabel: info.label,
        stableHostKey: info.stableHostKey,
      });

  const nowMs = Date.now();
  const cleanOrigin = String(info.origin || '').trim().replace(/\/+$/, '');
  const cleanBaseUrl = String(info.baseUrl || cleanOrigin).trim().replace(/\/+$/, '');
  const cleanCsrf = String(info.csrfToken || '').trim();
  const cleanWsUrl = String(info.wsUrl || '').trim();
  const inferredCanRpc =
    typeof info.canInvokeRpc === 'boolean'
      ? info.canInvokeRpc
      : LOOPBACK_HTTP_ORIGIN_RE.test(cleanOrigin || cleanBaseUrl);

  let entry = remoteEndpointRegistry.get(identity.id);
  if (!entry) {
    const { cacheFilePath, sqliteFilePath } = identity.hasStableHostKey
      ? buildRemoteCacheFilePaths(identity.stableHostKey)
      : { cacheFilePath: '', sqliteFilePath: '' };
    entry = {
      id: identity.id,
      instanceId: ++nextEndpointInstanceId,
      isRemote: true,
      label: identity.label,
      stableHostKey: identity.stableHostKey,
      hasStableHostKey: identity.hasStableHostKey,
      origin: cleanOrigin,
      baseUrl: cleanBaseUrl,
      csrfToken: cleanCsrf,
      tier1Verified: Boolean(info.tier1Verified),
      tier1Only: info.tier1Only === true,
      targets: new Map(),
      disposeCallbacks: new Map(),
      lastSeenMs: nowMs,
      preferTier2UntilMs: 0,
      inFlightCount: 0,
      store: createRemoteEndpointStore(cacheFilePath, sqliteFilePath),
      quotaSummaryCache: createRemoteQuotaCache(),
      contextModelCatalog: null,
      failedFetchCooldownMap: new Map(),
      liveActivityMemo: new Map(),
      lastKnownLiveCascadeIds: null,
    };
    remoteEndpointRegistry.set(identity.id, entry);
  } else {
    entry.lastSeenMs = nowMs;
    if (identity.label) entry.label = identity.label;
    if (info.clearConnection === true && !cleanOrigin && !cleanBaseUrl) {
      entry.origin = '';
      entry.baseUrl = '';
      entry.csrfToken = '';
      entry.preferTier2UntilMs = 0;
    } else {
      if (cleanOrigin) entry.origin = cleanOrigin;

      const existingTarget = cleanWsUrl ? entry.targets.get(cleanWsUrl) : null;
      const isAlreadyKnownPair = Array.from(entry.targets.values()).some(
        (t) =>
          (!cleanBaseUrl || t.baseUrl === cleanBaseUrl) &&
          (!cleanCsrf || t.csrfToken === cleanCsrf)
      );
      const baseUrlChanged = Boolean(cleanBaseUrl && entry.baseUrl && entry.baseUrl !== cleanBaseUrl);

      if (cleanBaseUrl) {
        if (baseUrlChanged && !isAlreadyKnownPair) {
          entry.preferTier2UntilMs = 0;
          if (!cleanCsrf) {
            // 远端隧道换端口重连且 2.33.0+ 未暴露 csrfToken 时清除旧端口残留令牌
            entry.csrfToken = '';
          }
          if (typeof info.tier1Verified !== 'boolean') {
            entry.tier1Verified = false;
          }
        }
        entry.baseUrl = cleanBaseUrl;
      }
      if (cleanCsrf) {
        if (entry.csrfToken !== cleanCsrf && !isAlreadyKnownPair) {
          entry.preferTier2UntilMs = 0;
        }
        entry.csrfToken = cleanCsrf;
      } else if (existingTarget && baseUrlChanged && !isAlreadyKnownPair) {
        entry.csrfToken = '';
      }
    }
    if (typeof info.tier1Verified === 'boolean') {
      entry.tier1Verified = info.tier1Verified;
    }
    if (typeof info.tier1Only === 'boolean') {
      entry.tier1Only = info.tier1Only;
    }
  }

  if (typeof info.onDispose === 'function') {
    const disposeKey = String(info.onDisposeKey || 'default');
    entry.disposeCallbacks.set(disposeKey, info.onDispose);
  }

  if (info.clearRpcTargets === true) {
    for (const [k, rec] of entry.targets.entries()) {
      if (rec?.canInvokeRpc === true && k !== cleanWsUrl) {
        entry.targets.delete(k);
      }
    }
  }

  if (cleanWsUrl) {
    entry.targets.set(cleanWsUrl, {
      wsUrl: cleanWsUrl,
      origin: cleanOrigin || entry.origin,
      baseUrl: cleanBaseUrl || entry.baseUrl,
      csrfToken: cleanCsrf,
      canInvokeRpc: inferredCanRpc,
      lastSeenMs: nowMs,
    });
  }

  if (Array.isArray(info.rpcWsUrls)) {
    for (const rawRpcWs of info.rpcWsUrls) {
      const rpcWs = String(rawRpcWs || '').trim();
      if (!rpcWs) continue;
      entry.targets.set(rpcWs, {
        wsUrl: rpcWs,
        origin: cleanOrigin || entry.origin,
        baseUrl: cleanBaseUrl || entry.baseUrl,
        csrfToken: cleanCsrf || entry.csrfToken,
        canInvokeRpc: true,
        lastSeenMs: nowMs,
      });
    }
  }

  return entry;
}

/**
 * 获取已注册的远端端点对象；`'local'` 或未注册时返回 `null`。
 *
 * @param {string} endpointId
 */
export function getRegisteredRemoteEndpoint(endpointId) {
  const norm = normalizeEndpointId(endpointId);
  if (!norm || norm === LOCAL_ENDPOINT_ID) return null;
  return remoteEndpointRegistry.get(norm) || null;
}

/**
 * 解析并校验请求目标端点：
 * - `'local'` 返回 `{ ok: true, isRemote: false, id: 'local', endpoint: null }`；
 * - 已注册远端返回 `{ ok: true, isRemote: true, id, endpoint }`；
 * - 非法格式返回 `{ ok: false, status: 400, error: 'Invalid endpointId' }`；
 * - 合法但暂未注册的远端返回 `{ ok: false, status: 503, retryable: true, error: 'Remote endpoint initializing' }`。
 *
 * @param {unknown} rawEndpointId
 */
export function resolveEndpointContext(rawEndpointId) {
  const norm = normalizeEndpointId(rawEndpointId);
  if (norm === null) {
    return { ok: false, status: 400, retryable: false, error: 'Invalid endpointId' };
  }
  if (norm === LOCAL_ENDPOINT_ID) {
    return { ok: true, isRemote: false, id: LOCAL_ENDPOINT_ID, label: '', endpoint: null };
  }
  const entry = remoteEndpointRegistry.get(norm);
  if (!entry) {
    return {
      ok: false,
      status: 503,
      retryable: true,
      error: 'Remote endpoint initializing',
    };
  }
  return {
    ok: true,
    isRemote: true,
    id: entry.id,
    label: entry.label || 'SSH',
    endpoint: entry,
  };
}

/**
 * 返回目标端点对应的统一轨迹缓存读写适配器（`'local'` 委托给 `config.mjs` 原生缓存）。
 *
 * @param {object|string|null} [endpointOrId=null]
 */
export function getEndpointCacheStore(endpointOrId = null) {
  const ep =
    typeof endpointOrId === 'string'
      ? getRegisteredRemoteEndpoint(endpointOrId)
      : endpointOrId && typeof endpointOrId === 'object' && endpointOrId.isRemote
        ? endpointOrId
        : null;
  if (ep?.store) {
    return {
      isRemote: true,
      endpointId: ep.id,
      ...ep.store,
    };
  }
  const localStore = getLocalTrajectoryCacheStore();
  return {
    isRemote: false,
    endpointId: LOCAL_ENDPOINT_ID,
    isSqliteBacked: Boolean(localStore?.isSqliteBacked),
    getCachedTrajectory,
    getCachedTrajectoryEntryByLower,
    getHydratedTrajectory,
    getHydratedTrajectoryEntryByLower,
    listCachedTrajectoryEntries,
    setCachedTrajectory,
    removeCachedTrajectory,
    hasPendingTrajectoryCacheSave,
    persistTrajectoryCacheIfNeeded,
    flushTrajectoryCacheNow,
    getDirtySessionCount: () => localStore.getDirtySessionCount(),
    getHotSessionCount: () => localStore.getHotSessionCount(),
    isConversationCold: (cid) => localStore.isConversationCold(cid),
    clearCache: clearRuntimeCaches,
  };
}

/**
 * 返回目标端点对应的配额缓存容器。
 *
 * @param {object|string|null} [endpointOrId=null]
 */
export function getEndpointQuotaCache(endpointOrId = null) {
  const ep =
    typeof endpointOrId === 'string'
      ? getRegisteredRemoteEndpoint(endpointOrId)
      : endpointOrId && typeof endpointOrId === 'object' && endpointOrId.isRemote
        ? endpointOrId
        : null;
  return ep?.quotaSummaryCache || quotaSummaryCache;
}

/**
 * 清空目标远端端点的内存与持久化缓存（包含配额、模型目录、扫描冷却表与实时活动缓存）。
 *
 * @param {string} endpointId
 * @param {{ liveCascadeIds?: Iterable<string> | null }} [options]
 * @returns {boolean}
 */
export function clearRemoteEndpointCaches(endpointId, options = {}) {
  const ep = getRegisteredRemoteEndpoint(endpointId);
  if (!ep) return false;
  const liveCascadeIds =
    options && Object.prototype.hasOwnProperty.call(options, 'liveCascadeIds')
      ? options.liveCascadeIds
      : ep.lastKnownLiveCascadeIds;
  const ok = ep.store.clearCache({ liveCascadeIds });
  if (!ok) return false;
  ep.failedFetchCooldownMap.clear();
  ep.liveActivityMemo.clear();
  ep.lastKnownLiveCascadeIds = null;
  ep.contextModelCatalog = null;
  ep.quotaSummaryCache.ts = 0;
  ep.quotaSummaryCache.lastAttemptTs = 0;
  ep.quotaSummaryCache.accountName = '';
  ep.quotaSummaryCache.accountGeneration += 1;
  ep.quotaSummaryCache.data = null;
  ep.quotaSummaryCache.error = null;
  return true;
}

/**
 * 为远端端点挑选存活的 CDP `wsUrl` 列表（按最近活跃时间倒序，便于多窗口故障转移）。
 *
 * @param {object|null} endpoint
 * @returns {string[]}
 */
export function getRemoteEndpointTargetWsUrls(endpoint) {
  if (!endpoint?.targets || !(endpoint.targets instanceof Map)) return [];
  return Array.from(endpoint.targets.values())
    .filter((t) => Boolean(t?.wsUrl) && t.canInvokeRpc !== false)
    .sort((a, b) => (b.lastSeenMs || 0) - (a.lastSeenMs || 0))
    .map((t) => t.wsUrl);
}

/**
 * 当 Tier-1 回环直连失败（如 401/403/TLS/连接错误）时启用 60 秒熔断，优先改走 Tier-2 窗口同源通道。
 */
export function markRemoteEndpointPreferTier2(endpoint, cooldownMs = ENDPOINT_TIER2_COOLDOWN_MS) {
  if (endpoint && typeof endpoint === 'object') {
    endpoint.preferTier2UntilMs = Date.now() + Math.max(1000, Number(cooldownMs) || ENDPOINT_TIER2_COOLDOWN_MS);
  }
}

export function shouldRemoteEndpointPreferTier2(endpoint) {
  return Boolean(endpoint && Number(endpoint.preferTier2UntilMs || 0) > Date.now());
}

/**
 * 标记端点正在执行请求，避免并发 pruning 期间提前销毁。
 */
export function trackEndpointRequestStart(endpoint) {
  if (endpoint && typeof endpoint === 'object') {
    endpoint.inFlightCount = Math.max(0, Number(endpoint.inFlightCount || 0)) + 1;
  }
}

export function trackEndpointRequestEnd(endpoint) {
  if (endpoint && typeof endpoint === 'object') {
    endpoint.inFlightCount = Math.max(0, Number(endpoint.inFlightCount || 0) - 1);
  }
}

/**
 * 清理已关闭且超过宽限期（默认 60 秒）且无在途请求的远端端点；清理前刷盘并取消定时器。
 *
 * @param {Set<string>} activeRemoteWsUrls
 * @param {number} [ttlMs=60000]
 */
function runEndpointDisposeHooks(ep) {
  if (!ep?.disposeCallbacks) return;
  const fns =
    ep.disposeCallbacks instanceof Map
      ? Array.from(ep.disposeCallbacks.values())
      : ep.disposeCallbacks instanceof Set
        ? Array.from(ep.disposeCallbacks)
        : [];
  ep.disposeCallbacks.clear?.();
  for (const fn of fns) {
    try {
      fn();
    } catch {
      // 忽略单个清理回调异常
    }
  }
}

export function pruneStaleRemoteEndpoints(activeRemoteWsUrls, ttlMs = ENDPOINT_STALE_TTL_MS) {
  const nowMs = Date.now();
  const activeSet = activeRemoteWsUrls instanceof Set ? activeRemoteWsUrls : new Set();

  for (const [id, ep] of remoteEndpointRegistry.entries()) {
    for (const [wsUrl, tInfo] of ep.targets.entries()) {
      if (!activeSet.has(wsUrl) && nowMs - (tInfo.lastSeenMs || 0) >= ttlMs) {
        ep.targets.delete(wsUrl);
      }
    }
    const stillActive = Array.from(ep.targets.keys()).some((wsUrl) => activeSet.has(wsUrl));
    if (stillActive) {
      ep.lastSeenMs = nowMs;
      continue;
    }
    if (ep.inFlightCount > 0) continue;
    if (nowMs - (ep.lastSeenMs || 0) >= ttlMs) {
      if (ep.store.hasPendingTrajectoryCacheSave()) {
        ep.store.flushTrajectoryCacheNow();
      }
      ep.store.cancelFlushTimer();
      runEndpointDisposeHooks(ep);
      remoteEndpointRegistry.delete(id);
    }
  }
}

export function listRegisteredRemoteEndpoints() {
  return Array.from(remoteEndpointRegistry.values());
}

export function clearRemoteEndpointRegistry() {
  for (const ep of remoteEndpointRegistry.values()) {
    ep.store.cancelFlushTimer();
    runEndpointDisposeHooks(ep);
  }
  remoteEndpointRegistry.clear();
}

/**
 * 注册 Tier-2 窗口同源 RPC 执行器（由 `window-bridge.mjs` 绑定 CDP `evaluateOnTarget`）。
 *
 * @param {((endpoint: object, method: string, body: object, timeoutMs: number) => Promise<object>)|null} invoker
 */
export function setRemoteWindowRpcInvoker(invoker) {
  registeredWindowRpcInvoker = typeof invoker === 'function' ? invoker : null;
}

export function getRemoteWindowRpcInvoker() {
  return registeredWindowRpcInvoker;
}

export function flushAllEndpointCachesNow() {
  try {
    if (hasPendingTrajectoryCacheSave()) {
      flushTrajectoryCacheNow();
    }
  } catch {
    // 忽略关闭阶段本机刷盘异常
  }
  for (const ep of remoteEndpointRegistry.values()) {
    try {
      if (ep.store.hasPendingTrajectoryCacheSave()) {
        ep.store.flushTrajectoryCacheNow();
      }
      ep.store.cancelFlushTimer();
    } catch {
      // 忽略关闭阶段远端端点刷盘异常
    }
  }
}

if (typeof process !== 'undefined' && typeof process?.once === 'function') {
  process.once('exit', () => {
    flushAllEndpointCachesNow();
  });
}
