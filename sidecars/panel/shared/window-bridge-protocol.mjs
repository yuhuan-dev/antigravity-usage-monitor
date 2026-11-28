import {
  normalizeVsCodeMountMode,
  normalizeWindowMountMode,
} from './settings-normalization.mjs';

export const WINDOW_BRIDGE_KEY = '__AGUsageMonitorBridge';
export const WINDOW_BRIDGE_ROUTE_KEY = 'hostRouteCascadeId';
export const WINDOW_BRIDGE_ENDPOINT_KEY = 'endpointId';
export const WINDOW_BRIDGE_ENDPOINT_HEADER = 'X-Usage-Monitor-Endpoint';
export const BRIDGE_ROUTE_PING_PATH = '/api/bridge-route-ping';
export const LOCAL_ENDPOINT_ID = 'local';
export const WINDOW_OVERLAY_KEY = '__AGUsageMonitorOverlay';
export const CONTEXT_WINDOWS_GLOBAL_KEY = '__AGUsageMonitorContextWindows';

export const WINDOW_OVERLAY_METHODS = Object.freeze({
  ensureAlive: 'ensureAlive',
  getDockKind: 'getDockKind',
  getMountMode: 'getMountMode',
  updateBridge: 'updateBridge',
  applyMountMode: 'applyMountMode',
  syncHostRoute: 'syncHostRoute',
  deliverRpc: 'deliverRpc',
  dispose: 'dispose',
});

export const BRIDGE_API_ROUTE_DEFS = Object.freeze([
  Object.freeze({ path: '/api/telemetry', method: 'GET', action: 'telemetry' }),
  Object.freeze({ path: '/api/settings', method: 'POST', action: 'settings' }),
  Object.freeze({ path: '/api/accounts', method: 'GET', action: 'accounts_get' }),
  Object.freeze({ path: '/api/accounts/update', method: 'POST', action: 'accounts_update' }),
  Object.freeze({ path: '/api/context-window', method: 'POST', action: 'context_window' }),
  Object.freeze({ path: '/api/settings/reset', method: 'POST', action: 'settings_reset' }),
  Object.freeze({ path: '/api/cache/rebuild', method: 'POST', action: 'cache_rebuild' }),
  Object.freeze({ path: '/api/cloud-sync', method: 'POST', action: 'cloud_sync' }),
  Object.freeze({ path: '/api/fx-sync', method: 'POST', action: 'fx_sync' }),
  Object.freeze({ path: '/api/plugin-update', method: 'POST', action: 'plugin_update' }),
  Object.freeze({ path: '/api/bridge/relaunch', method: 'POST', action: 'bridge_relaunch' }),
  Object.freeze({
    path: '/api/session-migration/catalog',
    method: 'GET',
    action: 'session_migration_catalog',
  }),
  Object.freeze({
    path: '/api/session-migration/migrate',
    method: 'POST',
    action: 'session_migration_migrate',
  }),
  Object.freeze({ path: '/api/export-file', method: 'POST', action: 'export_file' }),
  Object.freeze({ path: '/api/reveal-file', method: 'POST', action: 'reveal_file' }),
  Object.freeze({
    path: '/api/quota-reservation/log',
    method: 'GET',
    action: 'quota_reservation_log',
  }),
  Object.freeze({ path: '/api/host-i18n', method: 'GET', action: 'host_i18n_get' }),
  Object.freeze({ path: '/api/host-i18n', method: 'POST', action: 'host_i18n_action' }),
  Object.freeze({ path: '/api/sessions/list', method: 'GET', action: 'sessions_list' }),
  Object.freeze({
    path: '/api/sessions/cleanup-preview',
    method: 'POST',
    action: 'sessions_cleanup_preview',
  }),
  Object.freeze({ path: '/api/sessions/delete', method: 'POST', action: 'sessions_delete' }),
  Object.freeze({
    path: '/api/sessions/redact-ledger',
    method: 'POST',
    action: 'sessions_redact_ledger',
  }),
  Object.freeze({ path: '/api/sessions/reveal', method: 'POST', action: 'sessions_reveal' }),
]);

export const BRIDGE_API_PATHS = Object.freeze(BRIDGE_API_ROUTE_DEFS.map((r) => r.path));

export function readInjectedWindowBridge() {
  return typeof window === 'undefined' ? undefined : window[WINDOW_BRIDGE_KEY];
}

/**
 * 判断 URL 是否归属于标准 VS Code / VS Code Insiders 宿主或 VS Code 官方 Antigravity 扩展子视图，
 * 覆盖 macOS (`Visual Studio Code.app`)、Windows (`Microsoft VS Code`)、Linux (`/usr/share/code/resources/app/`)
 * 与 `extensionVariant=vs-code`，同时显式排除 Antigravity 2.0 / Antigravity IDE。
 *
 * @param {unknown} rawUrl
 * @returns {boolean}
 */
export function isVsCodeHostUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return false;
  if (/[?&]extensionVariant=vs-code(?:[&#]|$)/i.test(url)) {
    return true;
  }
  const pathOnly = url.split(/[?#]/, 1)[0];
  let decodedPath = pathOnly;
  try {
    decodedPath = decodeURIComponent(pathOnly);
  } catch {
    decodedPath = pathOnly.replace(/%20/gi, ' ');
  }
  if (/antigravity/i.test(decodedPath)) {
    return false;
  }
  const normalized = decodedPath.replace(/\\/g, '/');
  if (/(?:visual[\s-]+studio[\s-]+code|microsoft\s+vs\s+code|code\s*-?\s*insiders)/i.test(normalized)) {
    return true;
  }
  if (/(?:^|\/)(?:code|code-insiders|vscode(?:-[a-z0-9._-]+)?)\/resources\/app\//i.test(normalized)) {
    return true;
  }
  return false;
}

/**
 * 从 VS Code 窗口 URL 路径识别具体发行通道（`'insiders'` 或 `'stable'`）。
 *
 * @param {unknown} rawUrl
 * @returns {'insiders'|'stable'}
 */
export function detectVsCodeVariantFromUrl(rawUrl) {
  const pathOnly = String(rawUrl || '').trim().split(/[?#]/, 1)[0];
  let decodedPath = pathOnly;
  try {
    decodedPath = decodeURIComponent(pathOnly);
  } catch {
    decodedPath = pathOnly.replace(/%20/gi, ' ');
  }
  const normalized = decodedPath.replace(/\\/g, '/');
  if (/(?:code\s*-\s*insiders|code-insiders|vscode-insiders|visual[\s-]+studio[\s-]+code[\s-]+insiders)/i.test(normalized)) {
    return 'insiders';
  }
  return 'stable';
}

export function isVsCodeExtensionHost(bridge = readInjectedWindowBridge()) {
  if (bridge?.isVsCodeHost === true) return true;
  if (bridge?.isVsCodeHost === false) return false;
  if (typeof window !== 'undefined') {
    const href = String(window.location?.href || '');
    const search = String(window.location?.search || '');
    if (isVsCodeHostUrl(href) || /[?&]extensionVariant=vs-code(?:[&#]|$)/i.test(search)) {
      return true;
    }
  }
  return false;
}

export function isForceTopbarOverlay(bridge = readInjectedWindowBridge()) {
  return bridge?.forceTopbarMode === true;
}

/**
 * 统一解析客户端浮层当前生效的挂载模式（`WindowOverlayShell.js` 与 `overlayHostAnchors.js` 单一事实来源）：
 * 1. `forceTopbarMode === true`（如仅装 `agy` CLI 插件无扩展聊天框）强制 `'dual'`（顶部栏）；
 * 2. 标准 VS Code 宿主遵循 `vsCodeMountMode`（默认 `'composer'`，可选 `'dual'`，永不落入 `'sidebar'`）；
 * 3. Antigravity Desktop / IDE 遵循 `windowMountMode` / `enableWindowOverlay`。
 *
 * @param {Record<string, unknown>|null|undefined} settings
 * @param {Record<string, unknown>|null|undefined} [bridge]
 * @returns {'dual'|'composer'|'sidebar'}
 */
export function resolveClientEffectiveOverlayMountMode(
  settings,
  bridge = readInjectedWindowBridge()
) {
  if (isForceTopbarOverlay(bridge)) {
    return 'dual';
  }
  if (isVsCodeExtensionHost(bridge)) {
    if (settings && settings.vsCodeMountMode !== undefined) {
      return normalizeVsCodeMountMode(settings.vsCodeMountMode);
    }
    if (bridge?.mountMode !== undefined) {
      return normalizeVsCodeMountMode(bridge.mountMode);
    }
    return 'composer';
  }
  const rawMode = settings?.windowMountMode ?? bridge?.mountMode;
  return normalizeWindowMountMode(rawMode, settings?.enableWindowOverlay);
}
