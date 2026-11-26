/**
 * @fileoverview 双栖模式（Window Overlay）本地回环桥接服务与 CDP 多窗口自动挂载调度器。
 *
 * 职责边界：
 * 1. 在 Sidecar 进程内维护仅绑定 `127.0.0.1` 随机端口的受保护 HTTP 桥接端点，
 *    通过一次性 256-bit 随机令牌 (`X-Usage-Monitor-Token`)、严格 `Origin` 校验与 Private Network CORS 头，
 *    为主窗口 Shadow DOM 内的悬浮面板提供与辅助栏完全一致的 `/api/*` 遥测与控制接口；
 * 2. 周期性探测本机 `Antigravity/DevToolsActivePort`，发现所有打开的主聊天窗口（支持多窗口并存），
 *    按需将最新的 `styles.css` 与 `app.js` 热挂载至窗口顶栏，并在用户关闭双栖开关时立即清理卸载；
 * 3. 完全不触碰宿主 `app.asar` 文件，客户端升级或无调试端口时静默回退至右侧辅助栏。
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeTextFileAtomicSync } from './fs-atomic.mjs';
import {
  BRIDGE_API_PATHS,
  CONTEXT_WINDOWS_GLOBAL_KEY,
  LOCAL_ENDPOINT_ID,
  WINDOW_BRIDGE_ENDPOINT_HEADER,
  WINDOW_BRIDGE_ENDPOINT_KEY,
  WINDOW_BRIDGE_KEY,
  WINDOW_BRIDGE_ROUTE_KEY,
  WINDOW_OVERLAY_KEY,
  WINDOW_OVERLAY_METHODS,
} from '../shared/window-bridge-protocol.mjs';
import { HOST_I18N_GLOBAL_KEY } from '../shared/host-i18n-protocol.mjs';
import {
  DATA_DIR,
  computeRuntimeCodeVersion,
  loadJson,
  loadSettings,
  lsRuntimeEndpoint,
  normalizeWindowMountMode,
  saveJson,
} from './config.mjs';
import {
  createContextWindowSyncExpression,
  getContextWindowModels,
  resolveContextWindowRules,
} from './context-windows.mjs';
import {
  createHostI18nApplyExpression,
  createHostI18nCollectExpression,
  createHostI18nDisposeExpression,
  createHostI18nHeartbeatExpression,
  getHostI18nBridgeDescriptor,
} from './host-i18n/index.mjs';
import {
  ensureDesktopLaunchEntriesConfigured,
  maybeAutoRelaunchMacDesktopHost,
  resetMacAutoRelaunchState,
  resolveDesktopHostExecutable,
} from './desktop-launcher-config.mjs';
import {
  getRegisteredRemoteEndpoint,
  getRemoteEndpointTargetWsUrls,
  normalizeEndpointId,
  pruneStaleRemoteEndpoints,
  registerRemoteEndpoint,
  setRemoteWindowRpcInvoker,
} from './endpoint-registry.mjs';
import { getLocalHubPorts } from './ls-discovery.mjs';
import { callLsRpc, getContextModelCatalog } from './ls-rpc.mjs';
import { getDefaultCloudCodeProxy } from './cloudcode-proxy.mjs';

const windowBridgeRef = `window[${JSON.stringify(WINDOW_BRIDGE_KEY)}]`;
const windowOverlayRef = `window[${JSON.stringify(WINDOW_OVERLAY_KEY)}]`;
const windowContextWindowsRef = `window[${JSON.stringify(CONTEXT_WINDOWS_GLOBAL_KEY)}]`;
const windowHostI18nRef = `window[${JSON.stringify(HOST_I18N_GLOBAL_KEY)}]`;
const windowBridgeRouteKey = JSON.stringify(WINDOW_BRIDGE_ROUTE_KEY);
const windowBridgeEndpointKey = JSON.stringify(WINDOW_BRIDGE_ENDPOINT_KEY);
const overlayMethods = Object.fromEntries(
  Object.entries(WINDOW_OVERLAY_METHODS).map(([method, key]) => [method, JSON.stringify(key)])
);

const BRIDGE_MAX_BODY_BYTES = 64 * 1024;
// 8 MiB 原始导出文件经 Base64 (4/3x) 编码和 JSON 封装后约 10.7 MiB，预留 12 MiB 请求体上限
const BRIDGE_MAX_EXPORT_BODY_BYTES = 12 * 1024 * 1024;
const ALLOWED_BRIDGE_PATHS = new Set(BRIDGE_API_PATHS);
const CASCADE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDE_ROUTE_PROBE_MAX_TIMEOUT_MS = 1000;

function sanitizeRouteCascadeId(raw) {
  const id = String(raw || '').trim();
  return CASCADE_UUID_RE.test(id) ? id : '';
}

const WINDOW_VISIBLE_EXPR = `Boolean(
  (window.innerWidth === undefined || Number(window.innerWidth) > 80) &&
  (window.innerHeight === undefined || Number(window.innerHeight) > 80) &&
  !(typeof document !== 'undefined' && document?.hidden === true)
)`;

/**
 * 构建单一事实来源的页面内会话路由提取 IIFE 片段，供常规保活探测与 IDE 聊天 iframe 路由探测共用：
 * 优先解析 `/c/<uuid>`，其次在非隐藏且非零尺寸的 `conversation-view` 中按聚焦态、选中行交集及首个可见视图裁决。
 *
 * @returns {string}
 */
function buildDomRouteCascadeIdSnippet() {
  return `(() => {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const m = String(window.location?.pathname || '').match(/^\\/c\\/([0-9a-f-]{36})(?:\\/|$)/i);
    if (m && uuidRe.test(m[1])) return m[1];
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return '';
    const selectedRow = document.querySelector(
      '[data-testid^="conversation-row-"][data-selected="true"][data-cascade-id]'
    );
    const selectedRowId = String(selectedRow?.getAttribute?.('data-cascade-id') || '').trim();
    if (typeof document.querySelectorAll === 'function') {
      const views = document.querySelectorAll('[data-testid="conversation-view"][data-cascade-id]');
      const visibleIds = [];
      let focusedId = '';
      const activeEl = document.activeElement || null;
      for (const viewEl of views) {
        const cid = String(viewEl?.getAttribute?.('data-cascade-id') || '').trim();
        if (!uuidRe.test(cid)) continue;
        if (viewEl.hasAttribute?.('hidden')) continue;
        if (viewEl.getBoundingClientRect) {
          const r = viewEl.getBoundingClientRect();
          if (r.width <= 0 && r.height <= 0) continue;
        }
        visibleIds.push(cid);
        if (activeEl && viewEl.contains?.(activeEl)) {
          focusedId = cid;
        }
      }
      if (focusedId) return focusedId;
      if (
        selectedRowId &&
        uuidRe.test(selectedRowId) &&
        visibleIds.some((id) => id.toLowerCase() === selectedRowId.toLowerCase())
      ) {
        return selectedRowId;
      }
      if (visibleIds.length > 0) return visibleIds[0];
    }
    const singleView = document.querySelector('[data-testid="conversation-view"][data-cascade-id]');
    const singleViewId = String(singleView?.getAttribute?.('data-cascade-id') || '').trim();
    if (uuidRe.test(singleViewId)) return singleViewId;
    if (uuidRe.test(selectedRowId)) return selectedRowId;
    return '';
  })()`;
}

/**
 * 解析各操作系统下 Antigravity 2.0 与 Antigravity IDE 写入 `DevToolsActivePort` 的候选路径列表。
 * Linux 额外兼容全小写目录名、自定义 `XDG_CONFIG_HOME` 回退以及 Flatpak / Snap 一级容器配置目录。
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @param {string} [platform=process.platform]
 * @param {string} [homeDir=homedir()]
 * @param {{ readdirFn?: typeof readdirSync }|null} [fsOps=null]
 * @returns {string[]}
 */
export function resolveDevToolsPortCandidates(
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  fsOps = null
) {
  const explicitFile = String(env?.ANTIGRAVITY_DEVTOOLS_PORT_FILE || '').trim();
  if (explicitFile) {
    return [explicitFile];
  }
  const out = [];
  const seen = new Set();
  const pushUnique = (p) => {
    const clean = String(p || '').trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  };
  const portableRoot = String(env?.VSCODE_PORTABLE || '').trim();

  if (platform === 'win32') {
    const appData = env?.APPDATA || join(homeDir, 'AppData', 'Roaming');
    const localAppData = env?.LOCALAPPDATA || join(homeDir, 'AppData', 'Local');
    pushUnique(join(appData, 'Antigravity', 'DevToolsActivePort'));
    pushUnique(join(localAppData, 'Antigravity', 'DevToolsActivePort'));
    pushUnique(join(appData, 'Antigravity IDE', 'DevToolsActivePort'));
    pushUnique(join(localAppData, 'Antigravity IDE', 'DevToolsActivePort'));
    if (portableRoot) {
      pushUnique(join(portableRoot, 'user-data', 'DevToolsActivePort'));
    }
    return out;
  }
  if (platform === 'darwin') {
    pushUnique(join(homeDir, 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort'));
    pushUnique(
      join(homeDir, 'Library', 'Application Support', 'Antigravity IDE', 'DevToolsActivePort')
    );
    pushUnique(join(homeDir, 'Library', 'Application Support', 'antigravity', 'DevToolsActivePort'));
    pushUnique(
      join(homeDir, 'Library', 'Application Support', 'antigravity-ide', 'DevToolsActivePort')
    );
    pushUnique(join(homeDir, '.config', 'Antigravity', 'DevToolsActivePort'));
    pushUnique(join(homeDir, '.config', 'Antigravity IDE', 'DevToolsActivePort'));
    if (portableRoot) {
      pushUnique(join(portableRoot, 'user-data', 'DevToolsActivePort'));
    }
    return out;
  }

  const defaultConfigHome = join(homeDir, '.config');
  const configHome = env?.XDG_CONFIG_HOME || defaultConfigHome;
  pushUnique(join(configHome, 'Antigravity', 'DevToolsActivePort'));
  pushUnique(join(configHome, 'Antigravity IDE', 'DevToolsActivePort'));
  pushUnique(join(configHome, 'antigravity', 'DevToolsActivePort'));
  pushUnique(join(configHome, 'antigravity-ide', 'DevToolsActivePort'));
  if (configHome !== defaultConfigHome) {
    pushUnique(join(defaultConfigHome, 'Antigravity', 'DevToolsActivePort'));
    pushUnique(join(defaultConfigHome, 'Antigravity IDE', 'DevToolsActivePort'));
    pushUnique(join(defaultConfigHome, 'antigravity', 'DevToolsActivePort'));
    pushUnique(join(defaultConfigHome, 'antigravity-ide', 'DevToolsActivePort'));
  }
  if (portableRoot) {
    pushUnique(join(portableRoot, 'user-data', 'DevToolsActivePort'));
  }

  const readdirFn = fsOps?.readdirFn || readdirSync;
  const flatpakRoot = join(homeDir, '.var', 'app');
  try {
    for (const rawEntry of readdirFn(flatpakRoot) || []) {
      const appId = typeof rawEntry === 'string' ? rawEntry : String(rawEntry?.name || '');
      if (!appId || !/antigravity/i.test(appId)) continue;
      pushUnique(join(flatpakRoot, appId, 'config', 'Antigravity', 'DevToolsActivePort'));
      pushUnique(join(flatpakRoot, appId, 'config', 'antigravity', 'DevToolsActivePort'));
      pushUnique(join(flatpakRoot, appId, 'config', 'Antigravity IDE', 'DevToolsActivePort'));
    }
  } catch {
    // 宿主机未安装 Flatpak 或目录不可读时静默忽略
  }

  const snapRoot = join(homeDir, 'snap');
  try {
    for (const rawEntry of readdirFn(snapRoot) || []) {
      const snapName = typeof rawEntry === 'string' ? rawEntry : String(rawEntry?.name || '');
      if (!snapName || !/antigravity/i.test(snapName)) continue;
      pushUnique(join(snapRoot, snapName, 'current', '.config', 'Antigravity', 'DevToolsActivePort'));
      pushUnique(join(snapRoot, snapName, 'current', '.config', 'antigravity', 'DevToolsActivePort'));
      pushUnique(
        join(snapRoot, snapName, 'current', '.config', 'Antigravity IDE', 'DevToolsActivePort')
      );
    }
  } catch {
    // 宿主机未安装 Snap 或目录不可读时静默忽略
  }

  return out;
}

/**
 * 解析 Antigravity IDE 启动参数文件 `argv.json` 路径（兼容便携模式 `VSCODE_PORTABLE`）。
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @param {string} [homeDir=homedir()]
 * @returns {string}
 */
export function resolveIdeArgvPath(env = process.env, homeDir = homedir()) {
  const portableRoot = String(env?.VSCODE_PORTABLE || '').trim();
  if (portableRoot) {
    return join(portableRoot, 'argv.json');
  }
  return join(homeDir, '.antigravity-ide', 'argv.json');
}

/**
 * 词法扫描 JSONC 文本（支持 `//`、`/* ... * /` 注释与尾随逗号），提取纯 JSON 字符串及顶层键值坐标。
 *
 * @param {string} rawText
 */
function scanJsoncObject(rawText) {
  const text = rawText.startsWith('\uFEFF') ? rawText.slice(1) : rawText;
  const offsetDelta = rawText.length - text.length;
  const tokens = [];
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < len && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const closeIdx = text.indexOf('*/', i + 2);
      if (closeIdx < 0) return null;
      i = closeIdx + 2;
      continue;
    }
    if (ch === '"') {
      const start = i;
      i += 1;
      while (i < len) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      const rawToken = text.slice(start, i);
      let strVal = null;
      try {
        strVal = JSON.parse(rawToken);
      } catch {
        return null;
      }
      tokens.push({
        type: 'string',
        value: strVal,
        raw: rawToken,
        start: start + offsetDelta,
        end: i + offsetDelta,
      });
      continue;
    }
    if ('{}[]:,'.includes(ch)) {
      tokens.push({
        type: 'punct',
        raw: ch,
        start: i + offsetDelta,
        end: i + 1 + offsetDelta,
      });
      i += 1;
      continue;
    }
    const start = i;
    while (
      i < len &&
      !' \t\r\n{}[]:,"'.includes(text[i]) &&
      !(text[i] === '/' && (text[i + 1] === '/' || text[i + 1] === '*'))
    ) {
      i += 1;
    }
    tokens.push({
      type: 'primitive',
      raw: text.slice(start, i),
      start: start + offsetDelta,
      end: i + offsetDelta,
    });
  }

  if (tokens.length < 2 || tokens[0].raw !== '{' || tokens[tokens.length - 1].raw !== '}') {
    return null;
  }

  const cleanParts = [];
  for (let idx = 0; idx < tokens.length; idx += 1) {
    const tok = tokens[idx];
    const nextTok = tokens[idx + 1];
    if (tok.raw === ',' && nextTok && (nextTok.raw === '}' || nextTok.raw === ']')) {
      continue;
    }
    cleanParts.push(tok.raw);
  }

  let parsed = null;
  try {
    parsed = JSON.parse(cleanParts.join(''));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const topProps = new Map();
  let depth = 0;
  for (let idx = 0; idx < tokens.length; idx += 1) {
    const tok = tokens[idx];
    if (tok.raw === '{' || tok.raw === '[') {
      depth += 1;
      continue;
    }
    if (tok.raw === '}' || tok.raw === ']') {
      depth -= 1;
      continue;
    }
    if (depth === 1 && tok.type === 'string' && tokens[idx + 1]?.raw === ':') {
      const valFirst = tokens[idx + 2];
      if (!valFirst) break;
      let valLastIdx = idx + 2;
      if (valFirst.raw === '{' || valFirst.raw === '[') {
        let subDepth = 1;
        valLastIdx += 1;
        while (valLastIdx < tokens.length && subDepth > 0) {
          if (tokens[valLastIdx].raw === '{' || tokens[valLastIdx].raw === '[') subDepth += 1;
          else if (tokens[valLastIdx].raw === '}' || tokens[valLastIdx].raw === ']') subDepth -= 1;
          if (subDepth > 0) valLastIdx += 1;
        }
      }
      const valLast = tokens[valLastIdx] || valFirst;
      topProps.set(tok.value, {
        keyStart: tok.start,
        valStart: valFirst.start,
        valEnd: valLast.end,
      });
      idx = valLastIdx;
    }
  }

  const closeTok = tokens[tokens.length - 1];
  const prevTok = tokens[tokens.length - 2];
  return {
    parsed,
    topProps,
    closeBraceIdx: closeTok.start,
    lastSigEndIdx: prevTok.end,
    lastSigRaw: prevTok.raw,
  };
}

/**
 * 在保留全部 JSONC 注释、缩进与既有键的前提下，确保 `argv.json` 包含字符串类型的
 * `"remote-debugging-port"`（Antigravity IDE 主进程仅接受非空字符串值，数值 `0` 会被忽略）。
 *
 * @param {string} rawText
 * @returns {{ changed: boolean, valid: boolean, alreadyConfigured?: boolean, portValue?: string, reason?: string, text: string }}
 */
export function ensureRemoteDebuggingInArgvText(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    // 新建文件使用纯 JSON（无注释），同时兼容 VS Code/IDE JSONC 解析器与 Electron 严格 JSON.parse()
    const fresh = '{\n\t"remote-debugging-port": "0"\n}\n';
    return { changed: true, valid: true, portValue: '0', text: fresh };
  }

  const scanned = scanJsoncObject(rawText);
  if (!scanned) {
    return { changed: false, valid: false, reason: 'invalid_jsonc', text: rawText };
  }

  const existingVal = scanned.parsed['remote-debugging-port'];
  if (typeof existingVal === 'string' && existingVal.trim().length > 0) {
    return {
      changed: false,
      valid: true,
      alreadyConfigured: true,
      portValue: existingVal.trim(),
      text: rawText,
    };
  }

  const desiredPortStr =
    typeof existingVal === 'number' &&
    Number.isInteger(existingVal) &&
    existingVal >= 0 &&
    existingVal <= 65535
      ? String(existingVal)
      : '0';

  const eol = rawText.includes('\r\n') ? '\r\n' : '\n';
  const indentMatch = rawText.match(/^[ \t]+(?=")/m);
  const indent = indentMatch ? indentMatch[0] : '\t';

  let nextText = '';
  const propSpan = scanned.topProps.get('remote-debugging-port');
  if (propSpan) {
    nextText =
      rawText.slice(0, propSpan.valStart) +
      JSON.stringify(desiredPortStr) +
      rawText.slice(propSpan.valEnd);
  } else {
    let working = rawText;
    let closeIdx = scanned.closeBraceIdx;
    if (scanned.lastSigRaw !== '{' && scanned.lastSigRaw !== ',') {
      working =
        working.slice(0, scanned.lastSigEndIdx) + ',' + working.slice(scanned.lastSigEndIdx);
      closeIdx += 1;
    }
    let insertPos = closeIdx;
    while (insertPos > 0 && (working[insertPos - 1] === ' ' || working[insertPos - 1] === '\t')) {
      insertPos -= 1;
    }
    const hasNewlineBeforeClose =
      insertPos > 0 && (working[insertPos - 1] === '\n' || working[insertPos - 1] === '\r');
    const insertion = hasNewlineBeforeClose
      ? `${indent}"remote-debugging-port": ${JSON.stringify(desiredPortStr)}${eol}`
      : `${eol}${indent}"remote-debugging-port": ${JSON.stringify(desiredPortStr)}${eol}`;
    nextText = working.slice(0, insertPos) + insertion + working.slice(insertPos);
  }

  const verifyScan = scanJsoncObject(nextText);
  if (!verifyScan || verifyScan.parsed['remote-debugging-port'] !== desiredPortStr) {
    return { changed: false, valid: false, reason: 'post_check_failed', text: rawText };
  }

  return {
    changed: true,
    valid: true,
    portValue: desiredPortStr,
    text: nextText,
  };
}

function patchSingleHostArgvFile(argvPath, { createDir = false, missingReason = 'dir_missing' } = {}) {
  try {
    const dirPath = dirname(argvPath);
    if (!existsSync(dirPath)) {
      if (!createDir) {
        return { checked: true, updated: false, reason: missingReason, argvPath };
      }
      mkdirSync(dirPath, { recursive: true });
    }
    const rawText = existsSync(argvPath) ? readFileSync(argvPath, 'utf8') : '';
    const patched = ensureRemoteDebuggingInArgvText(rawText);
    if (!patched.valid) {
      return { checked: true, updated: false, reason: patched.reason || 'invalid_jsonc', argvPath };
    }
    if (!patched.changed) {
      return {
        checked: true,
        updated: false,
        alreadyConfigured: true,
        portValue: patched.portValue,
        argvPath,
      };
    }
    writeTextFileAtomicSync(argvPath, patched.text);
    return {
      checked: true,
      updated: true,
      portValue: patched.portValue,
      argvPath,
    };
  } catch (err) {
    return {
      checked: true,
      updated: false,
      reason: err?.code || 'io_error',
      argvPath,
    };
  }
}

/**
 * 当本机存在 `~/.antigravity-ide` 配置目录且开启双栖模式时，自动补齐 `argv.json` 中的
 * `"remote-debugging-port": "0"`，使 Antigravity IDE 下次启动时自动生成 `DevToolsActivePort`。
 *
 * @param {{ env?: Record<string, string|undefined>, homeDir?: string, enabled?: boolean }} [options]
 */
export function ensureIdeRemoteDebuggingArgv({
  env = process.env,
  homeDir = homedir(),
  enabled = true,
} = {}) {
  if (!enabled) {
    return { checked: false, updated: false, reason: 'disabled' };
  }
  const argvPath = resolveIdeArgvPath(env, homeDir);
  return patchSingleHostArgvFile(argvPath, {
    createDir: false,
    missingReason: 'ide_dir_missing',
  });
}

/**
 * 从 `DevToolsActivePort` 文件文本首行提取合法的本地调试端口号。
 *
 * @param {string} rawText
 * @returns {number|null}
 */
export function parseDevToolsPortFile(rawText) {
  if (typeof rawText !== 'string' || !rawText) return null;
  const firstLine = rawText.split(/\r?\n/)[0]?.trim() || '';
  if (!/^\d+$/.test(firstLine)) return null;
  const port = Number(firstLine);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

const IDE_WORKBENCH_URL_RE =
  /^vscode-file:\/\/vscode-app\/.+\/workbench(?:\.esm|-jetski-agent)?\.html(?:[?#]|$)/i;

/**
 * 判断 CDP `/json/list` 返回的目标是否为 Antigravity 2.0 或 Antigravity IDE 主窗口页面，
 * 严格排除 `vscode-webview://` 子视图、`sharedProcess.html`、DevTools 面板与非本机回环地址。
 *
 * @param {object} target
 * @returns {boolean}
 */
export function isAntigravityMainPageTarget(target) {
  if (!target || typeof target !== 'object') return false;
  if (target.type !== 'page') return false;
  const url = String(target.url || '').trim();
  const wsUrl = String(target.webSocketDebuggerUrl || '').trim();
  const isLoopbackAppPage = /^https:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+(?:\/|$)/i.test(url);
  const isIdeWorkbenchPage = IDE_WORKBENCH_URL_RE.test(url);
  if (!isLoopbackAppPage && !isIdeWorkbenchPage) {
    return false;
  }
  if (!/^ws:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//i.test(wsUrl)) {
    return false;
  }
  return true;
}

/**
 * 从 Antigravity IDE 内嵌扩展聊天 iframe 地址（如 `http://127.0.0.1:41362/c/<uuid>?extensionView=true`）
 * 中提取当前正在查看的会话 UUID。
 *
 * @param {unknown} rawUrl
 * @returns {string}
 */
export function extractIdeExtensionCascadeId(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return '';
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//i.test(url)) {
    return '';
  }
  if (!/[?&]extension(?:View|Variant)=/i.test(url)) {
    return '';
  }
  const m = url.match(
    /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i
  );
  return m ? m[1] : '';
}

/**
 * 判断 CDP 目标是否为 Antigravity IDE 内嵌扩展聊天视图（OOPIF `iframe`），
 * 严格限定本机回环地址并校验 `extensionView`/`extensionVariant` 参数、`/c/<uuid>` 路由或已发现的 LS Hub 端口。
 *
 * @param {object} target
 * @param {string} [lsAddr='']
 * @returns {boolean}
 */
export function isIdeExtensionChatTarget(target, lsAddr = '') {
  if (!target || typeof target !== 'object') return false;
  if (isAntigravityMainPageTarget(target)) return false;
  const type = String(target.type || '').trim().toLowerCase();
  if (type !== 'iframe' && type !== 'webview' && type !== 'page') return false;
  const url = String(target.url || '').trim();
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+(?:\/|$)/i.test(url)) {
    return false;
  }
  if (/[?&]extension(?:View|Variant)=/i.test(url)) {
    return true;
  }
  if (
    /\/c\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:[/?#]|$)/i.test(url)
  ) {
    return true;
  }
  const cleanLsAddr = String(lsAddr || '').trim().toLowerCase();
  if (cleanLsAddr) {
    try {
      const parsed = new URL(url);
      if (parsed.host.toLowerCase() === cleanLsAddr) {
        return true;
      }
    } catch {
      // 忽略非法 URL
    }
  }
  return false;
}

/**
 * 将同一调试端口下的扩展聊天子 iframe 会话路由与可注入聊天目标（按 `parentId` 树隔离，单窗口缺省时安全兜底）
 * 关联到对应的 Antigravity IDE `workbench.html` 主窗口目标上。
 *
 * @param {Array<object>} rawTargets
 * @param {Array<object>} mainTargets
 * @param {{ lsAddr?: string, cdpPort?: number }} [options]
 * @returns {Array<object>}
 */
export function associateIdeIframeRoutes(rawTargets, mainTargets, options = undefined) {
  if (!Array.isArray(mainTargets) || mainTargets.length === 0) return [];
  const lsAddr = String(options?.lsAddr || '').trim();
  const cdpPort = Number(options?.cdpPort || 0);
  const allList = Array.isArray(rawTargets) ? rawTargets : mainTargets;
  const byId = new Map();
  for (const t of allList) {
    if (t && typeof t === 'object' && t.id) {
      byId.set(String(t.id), t);
    }
  }

  const ideTargets = mainTargets.filter((t) =>
    IDE_WORKBENCH_URL_RE.test(String(t?.url || '').trim())
  );
  const mainIdeIds = new Set(ideTargets.map((t) => String(t?.id || '')).filter(Boolean));
  const routeByMainId = new Map();
  const unanchoredRoutes = [];
  const chatTargetsByMainId = new Map();
  const unanchoredChatTargets = [];

  for (const t of allList) {
    if (!t || typeof t !== 'object') continue;
    if (t.type !== 'iframe' && isAntigravityMainPageTarget(t)) continue;

    const isChatFrame = isIdeExtensionChatTarget(t, lsAddr);
    const cascadeId = extractIdeExtensionCascadeId(t.url);
    if (!cascadeId && !isChatFrame) continue;

    let matchedMainId = '';
    let curId = String(t.parentId || '').trim();
    const visited = new Set();
    while (curId && !visited.has(curId)) {
      visited.add(curId);
      if (mainIdeIds.has(curId)) {
        matchedMainId = curId;
        break;
      }
      const parentTarget = byId.get(curId);
      curId = parentTarget ? String(parentTarget.parentId || '').trim() : '';
    }

    if (cascadeId) {
      if (matchedMainId) {
        if (!routeByMainId.has(matchedMainId)) {
          routeByMainId.set(matchedMainId, cascadeId);
        }
      } else {
        unanchoredRoutes.push(cascadeId);
      }
    }

    if (isChatFrame) {
      const rawUrl = String(t.url || '').trim();
      const rawWs = String(t.webSocketDebuggerUrl || '').trim();
      let wsUrl = '';
      if (/^ws:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//i.test(rawWs)) {
        wsUrl = rawWs;
      } else if (cdpPort > 0 && t.id) {
        wsUrl = `ws://127.0.0.1:${cdpPort}/devtools/page/${encodeURIComponent(String(t.id))}`;
      }
      let origin = '';
      try {
        origin = new URL(rawUrl).origin;
      } catch {
        // 忽略非法 URL
      }
      const fallbackUuidMatch = rawUrl.match(
        /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i
      );
      const chatEntry = {
        id: String(t.id || ''),
        url: rawUrl,
        origin,
        cascadeId: cascadeId || (fallbackUuidMatch ? fallbackUuidMatch[1] : ''),
        webSocketDebuggerUrl: wsUrl,
        isIdeChatFrame: true,
      };
      if (matchedMainId) {
        if (!chatTargetsByMainId.has(matchedMainId)) {
          chatTargetsByMainId.set(matchedMainId, []);
        }
        chatTargetsByMainId.get(matchedMainId).push(chatEntry);
      } else {
        unanchoredChatTargets.push(chatEntry);
      }
    }
  }

  return mainTargets.map((t) => {
    const isIde = IDE_WORKBENCH_URL_RE.test(String(t?.url || '').trim());
    if (!isIde) {
      return {
        ...t,
        isIdeWorkbench: false,
        ideRouteCascadeId: '',
        ideChatTargets: [],
      };
    }
    const tid = String(t?.id || '');
    let routeId = (tid && routeByMainId.get(tid)) || '';
    if (!routeId && ideTargets.length === 1 && unanchoredRoutes.length > 0) {
      routeId = unanchoredRoutes[0];
    }
    let chatTargets = tid && chatTargetsByMainId.has(tid) ? [...chatTargetsByMainId.get(tid)] : [];
    if (chatTargets.length === 0 && ideTargets.length === 1 && unanchoredChatTargets.length > 0) {
      chatTargets = [...unanchoredChatTargets];
    }
    return {
      ...t,
      isIdeWorkbench: true,
      ideRouteCascadeId: routeId,
      ideChatTargets: chatTargets,
    };
  });
}

/**
 * 从窗口内的 `window.__APP_CONFIG__` 与标题提取远端 / SSH 主机标识元数据。
 *
 * @param {object|null|undefined} appConfig
 * @param {string} [title='']
 * @returns {{ hasExplicitRemoteFlag: boolean, stableHostKey: string, hostLabel: string }}
 */
export function extractRemoteHostMetadata(appConfig, title = '') {
  const cfg = appConfig && typeof appConfig === 'object' ? appConfig : {};
  const rawHost = String(
    cfg.sshHost ||
      cfg.sshHostName ||
      cfg.sshAlias ||
      cfg.sshTarget ||
      cfg.remoteHost ||
      cfg.remoteAuthority ||
      cfg.remoteName ||
      ''
  ).trim();
  const cleanHost = rawHost.replace(/^ssh(?:-remote)?\+/i, '').trim();
  const hasExplicitRemoteFlag = Boolean(
    cfg.isRemoteControl === true ||
      cfg.isRemote === true ||
      cfg.isSsh === true ||
      /^ssh/i.test(String(cfg.connectionType || cfg.windowMode || '').trim()) ||
      cleanHost
  );

  let bracketedTitleHost = '';
  const titleText = String(title || '').trim();
  if (titleText) {
    const m = titleText.match(/\[SSH:\s*([^\]\r\n]+)\]/i);
    if (m && m[1]) {
      bracketedTitleHost = String(m[1]).trim();
    }
  }

  const stableHostKey = cleanHost || bracketedTitleHost || '';
  const hostLabel = cleanHost || bracketedTitleHost || '';
  return { hasExplicitRemoteFlag, stableHostKey, hostLabel, bracketedTitleHost };
}

/**
 * 依据三级优先级严格区分本地窗口与 SSH / 远端窗口，避免 2.33.0+ 无 `csrfToken` 或无 `hub_*.json` 时误判本地桌面窗口。
 *
 * @param {{
 *   target: object,
 *   probedInfo?: { origin?: string, csrfToken?: string, observedCsrfToken?: string, appConfig?: object, title?: string }|null,
 *   localHubInfo?: { allPorts?: Set<number>, httpsPorts?: Set<number>, csrfTokens?: Set<string> }|null,
 *   confirmedLocalPorts?: Set<number>|null,
 * }} params
 */
export function classifyWindowTargetEndpoint({
  target,
  probedInfo = null,
  localHubInfo = null,
  confirmedLocalPorts = null,
}) {
  if (!target || target.isIdeWorkbench) {
    return { isRemote: false, endpointId: LOCAL_ENDPOINT_ID, label: '', origin: '', csrfToken: '' };
  }

  let origin = String(probedInfo?.origin || '').trim();
  if (!origin) {
    try {
      const parsed = new URL(String(target.url || ''));
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        origin = parsed.origin;
      }
    } catch {
      origin = '';
    }
  }

  let originPort = 0;
  if (origin) {
    try {
      originPort = Number(new URL(origin).port || 0);
    } catch {
      originPort = 0;
    }
  }

  const allLocalPorts = localHubInfo?.allPorts instanceof Set ? localHubInfo.allPorts : new Set();
  const localHttpsPorts = localHubInfo?.httpsPorts instanceof Set ? localHubInfo.httpsPorts : new Set();
  const localCsrfTokens = localHubInfo?.csrfTokens instanceof Set ? localHubInfo.csrfTokens : new Set();
  const knownLocalPorts = confirmedLocalPorts instanceof Set ? confirmedLocalPorts : new Set();

  const csrfToken = String(probedInfo?.csrfToken || probedInfo?.observedCsrfToken || '').trim();
  const remoteMeta = extractRemoteHostMetadata(probedInfo?.appConfig, probedInfo?.title || target.title || '');

  // 1. 明确命中本机特征（端口或 CSRF 令牌匹配本机 Hub）且无显式远程标记 -> 本地窗口
  const matchesLocalPort = originPort > 0 && (allLocalPorts.has(originPort) || knownLocalPorts.has(originPort));
  const matchesLocalCsrf = Boolean(csrfToken && localCsrfTokens.has(csrfToken));
  if ((matchesLocalPort || matchesLocalCsrf) && !remoteMeta.hasExplicitRemoteFlag) {
    return {
      isRemote: false,
      endpointId: LOCAL_ENDPOINT_ID,
      label: '',
      origin,
      originPort,
      csrfToken,
    };
  }

  // 2. 明确命中远端 / SSH 特征（显式 SSH/Remote 标记，或携带与本机不同的非空 CSRF 令牌）
  const hasDifferentCsrf = Boolean(csrfToken && localCsrfTokens.size > 0 && !localCsrfTokens.has(csrfToken));
  if (remoteMeta.hasExplicitRemoteFlag || hasDifferentCsrf) {
    return {
      isRemote: true,
      origin,
      originPort,
      csrfToken,
      stableHostKey: remoteMeta.stableHostKey,
      hostLabel: remoteMeta.hostLabel || (originPort > 0 ? `SSH:${originPort}` : 'SSH'),
    };
  }

  // 3. 2.33.0+ 省略 csrfToken 时的端口不匹配兜底：仅当存在已确认的本机 HTTPS 端口或已确认本地窗口端口时启用
  const hasConfirmedLocalDesktopPort = localHttpsPorts.size > 0 || knownLocalPorts.size > 0;
  if (originPort > 0 && hasConfirmedLocalDesktopPort && !matchesLocalPort) {
    return {
      isRemote: true,
      origin,
      originPort,
      csrfToken,
      stableHostKey: remoteMeta.stableHostKey,
      hostLabel: remoteMeta.hostLabel || `SSH:${originPort}`,
    };
  }

  return {
    isRemote: false,
    endpointId: LOCAL_ENDPOINT_ID,
    label: '',
    origin,
    originPort,
    csrfToken,
  };
}

/**
 * 构建无状态、按需执行的窗口内同源 LS RPC 表达式（Tier-2 传输，不常驻修改 `window.fetch`）。
 * 优先使用同源 `window.fetch` (`credentials: 'same-origin'`)；若被鉴权或协议阻断，防御性回退至同源 `/connect-websocket`。
 *
 * @param {string} method
 * @param {object} [body={}]
 * @param {number} [timeoutMs=5000]
 * @returns {string}
 */
export function buildWindowRemoteRpcExpression(method, body = {}, timeoutMs = 5000) {
  const safeTimeout = Math.max(1000, Math.min(30000, Number(timeoutMs) || 5000));
  return `(async () => {
    const methodName = ${JSON.stringify(String(method || ''))};
    const payloadObj = ${JSON.stringify(body && typeof body === 'object' ? body : {})};
    const timeoutMs = ${JSON.stringify(safeTimeout)};
    const servicePath = '/exa.language_server_pb.LanguageServerService/';
    const procedure = servicePath + methodName;
    const origin = String(window.location?.origin || '').replace(/\\/+$/, '');
    if (!origin || !/^https?:\\/\\/(127\\.0\\.0\\.1|localhost|\\[::1\\]):\\d+$/i.test(origin)) {
      return { ok: false, status: 0, error: 'Non-loopback window origin' };
    }
    const csrfToken = String(
      window.__APP_CONFIG__?.csrfToken ||
      window[${JSON.stringify(CONTEXT_WINDOWS_GLOBAL_KEY)}]?.observedCsrfToken ||
      ''
    ).trim();
    const deadlineMs = Date.now() + timeoutMs;

    let fetchErrMsg = '';
    let fetchStatus = 0;
    if (typeof window.fetch === 'function') {
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (csrfToken) headers['x-codeium-csrf-token'] = csrfToken;
        const fetchBudgetMs = Math.max(200, deadlineMs - Date.now());
        const init = {
          method: 'POST',
          credentials: 'same-origin',
          headers,
          body: JSON.stringify(payloadObj),
        };
        if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
          init.signal = AbortSignal.timeout(fetchBudgetMs);
        }
        const res = await window.fetch(origin + procedure, init);
        fetchStatus = Number(res?.status || 0);
        if (res?.ok) {
          const data = await res.json();
          return { ok: true, status: fetchStatus, transport: 'fetch', data };
        }
        fetchErrMsg = (await res?.text?.().catch(() => '')) || ('HTTP ' + fetchStatus);
      } catch (err) {
        fetchErrMsg = err?.message || 'fetch failed';
      }
    }

    const wsRemainingMs = deadlineMs - Date.now();
    if (wsRemainingMs >= 300 && typeof window.WebSocket === 'function' && window.location?.host) {
      try {
        const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = wsProto + '//' + window.location.host + '/connect-websocket';
        const streamId = 'um_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
        const wsResult = await new Promise((resolve, reject) => {
          let ws = null;
          let timer = null;
          let done = false;
          const finish = (ok, val) => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            try { ws?.close?.(); } catch {}
            if (ok) resolve(val);
            else reject(val instanceof Error ? val : new Error(String(val || 'ws failed')));
          };
          timer = setTimeout(() => finish(false, new Error('connect-websocket timeout')), wsRemainingMs);
          try {
            ws = new window.WebSocket(wsUrl);
          } catch (err) {
            finish(false, err);
            return;
          }
          ws.addEventListener('open', () => {
            try {
              ws.send(JSON.stringify({
                type: 'start',
                stream: false,
                procedure,
                streamId,
                payload: payloadObj,
              }));
            } catch (err) {
              finish(false, err);
            }
          }, { once: true });
          ws.addEventListener('message', (ev) => {
            try {
              const raw = typeof ev?.data === 'string' ? ev.data : String(ev?.data || '');
              const frame = JSON.parse(raw);
              if (!frame || typeof frame !== 'object') return;
              if (frame.streamId && frame.streamId !== streamId) return;
              if (frame.type === 'error' || frame.error) {
                const msg = typeof frame.error === 'string'
                  ? frame.error
                  : frame.error?.message || frame.message || 'connect-websocket error';
                finish(false, new Error(msg));
                return;
              }
              if (frame.payload !== undefined) {
                finish(true, frame.payload);
                return;
              }
              if (frame.response !== undefined) {
                finish(true, frame.response);
                return;
              }
              if (frame.data !== undefined && frame.type !== 'ping' && frame.type !== 'pong') {
                finish(true, frame.data);
                return;
              }
              if (frame.type === 'end') {
                finish(true, {});
              }
            } catch {
              // 忽略非 JSON 或无关帧
            }
          });
          ws.addEventListener('error', () => finish(false, new Error('connect-websocket error')), { once: true });
          ws.addEventListener('close', () => finish(false, new Error('connect-websocket closed')), { once: true });
        });
        return { ok: true, status: 200, transport: 'ws', data: wsResult };
      } catch (wsErr) {
        return {
          ok: false,
          status: fetchStatus,
          error: fetchErrMsg || wsErr?.message || 'Remote window RPC failed',
        };
      }
    }

    return { ok: false, status: fetchStatus, error: fetchErrMsg || 'Remote window RPC failed' };
  })()`;
}

/**
 * 校验桥接请求的 `Origin` 是否来自本机 Antigravity 2.0 HTTPS 回环源或 Antigravity IDE `vscode-file` 源。
 *
 * @param {unknown} origin
 * @returns {boolean}
 */
export function isAllowedBridgeOrigin(origin) {
  const text = String(origin || '').trim();
  return (
    /^https:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/i.test(text) ||
    /^vscode-file:\/\/vscode-app$/i.test(text)
  );
}

/**
 * 固定时间比较两个等长 ASCII 令牌字符串，避免时序侧信道泄露。
 *
 * @param {string} actual
 * @param {string} expected
 * @param {typeof import('node:crypto').timingSafeEqual|null} [timingSafeEqualFn=null]
 * @returns {boolean}
 */
function verifyBridgeToken(actual, expected, timingSafeEqualFn = null) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !expected) return false;
  if (actual.length !== expected.length) return false;
  if (typeof timingSafeEqualFn === 'function') {
    return timingSafeEqualFn(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8'));
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * 创建双栖模式桥接与 CDP 热挂载控制器实例。
 *
 * @param {{
 *   handleApiRequest: (pathname: string, method: string, data: Record<string, any>) => Promise<{ status: number, contentType?: string, headers?: Record<string, string>, body: string }>,
 *   readAssetFn: (relPath: string) => Promise<string>,
 *   getSettingsFn?: () => { enableWindowOverlay?: boolean },
 *   getBundleVersionFn?: () => string,
 *   env?: Record<string, string|undefined>,
 *   platform?: string,
 *   homeDir?: string,
 *   pollIntervalMs?: number,
 *   cdpTimeoutMs?: number,
 *   WebSocketImpl?: typeof WebSocket,
 * }} options
 */
export function createWindowBridgeController(options) {
  const {
    handleApiRequest,
    readAssetFn,
    getSettingsFn = loadSettings,
    getBundleVersionFn = computeRuntimeCodeVersion,
    env = process.env,
    platform = process.platform,
    homeDir = homedir(),
    pollIntervalMs = 3000,
    fastPollIntervalMs = 1500,
    cdpTimeoutMs = 3500,
    bootBundleVersion = '',
    onVersionDrift = null,
    leaseFilePath = '',
    autoConfigureIdeArgv = options?.env === undefined && options?.homeDir === undefined,
    launcherRecheckIntervalMs = 15 * 60 * 1000,
    launcherExecFileFn = null,
    launcherSpawnFn = null,
    launcherFsOps = null,
    allowDesktopLauncherInTest = false,
    macAutoRelaunchFn = maybeAutoRelaunchMacDesktopHost,
    resetMacAutoRelaunchStateFn = resetMacAutoRelaunchState,
    macAutoRelaunchStateFilePath = '',
    existsHostFn = existsSync,
    WebSocketImpl = globalThis.WebSocket,
    bindRemoteRpcInvoker = false,
    getLocalHubPortsFn = getLocalHubPorts,
    cloudCodeProxy = null,
    manageCloudCodeProxy = false,
    resolveLocalContextRulesFn = null,
    getHostI18nDescriptorFn =
      options?.env === undefined && options?.homeDir === undefined
        ? getHostI18nBridgeDescriptor
        : () => ({ active: false, revision: '', getPayload: null }),
  } = options || {};

  const activeCloudCodeProxy =
    cloudCodeProxy || (manageCloudCodeProxy ? getDefaultCloudCodeProxy() : null);

  function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (pid === process.pid) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err?.code === 'EPERM';
    }
  }

  let server = null;
  let serverStartPromise = null;
  let bridgePort = 0;
  let bridgeToken = '';
  let pollTimer = null;
  let initialTimer = null;
  let stopped = false;
  let syncInFlight = null;
  let hadInjectedTargets = false;
  let hadInjectedChatFrames = false;
  let cdpFallbackActive = false;
  let lastLauncherProvisionAtMs = 0;
  let hostLauncherPromise = null;
  let argvUpdatedThisBoot = false;
  let argvConfigured = false;
  let launcherConfigured = false;
  let hasReadOnlyShortcuts = false;
  let macAutoRelaunchCheckedThisProcess = false;
  let macAutoRelaunchResetThisProcess = false;
  const hostExecInfo = resolveDesktopHostExecutable({
    env,
    platform,
    homeDir,
    existsFn: existsHostFn,
  });
  // Windows / macOS / Linux 均支持从运行中宿主进程动态反查路径（含自定义盘符与 AppImage），自定义安装路径亦可一键重拉
  const canRelaunch = Boolean(
    hostExecInfo.found ||
      ((platform === 'win32' || platform === 'darwin' || platform === 'linux') &&
        options?.existsHostFn === undefined)
  );
  let lastPersistedLeaseSig = '';
  let lastBridgeStatus = {
    state: 'pending',
    enabled: true,
    aliveCount: 0,
    targets: 0,
    argvUpdatedThisBoot: false,
    argvConfigured: false,
    launcherConfigured: false,
    hasReadOnlyShortcuts: false,
    canRelaunch,
    updatedAtMs: 0,
  };
  let hadContextWindows = false;
  let contextWindowBootId = `${process.pid}:${Date.now()}`;
  let hadHostI18n = false;
  let hostI18nBootId = `hi18n:${process.pid}:${Date.now()}`;
  let lastHostI18nAppliedCount = 0;
  let cachedHostI18nApply = { revision: '', bootId: '', expr: '' };
  const cachedBackendCtxModelsByEndpoint = new Map();
  const targetClassifyCache = new Map();
  let nodeDepsPromise = null;
  const allowedDynamicOrigins = new Set();

  async function loadNodeDeps() {
    if (!nodeDepsPromise) {
      nodeDepsPromise = Promise.all([import('node:http'), import('node:crypto')]).then(
        ([httpMod, cryptoMod]) => ({
          http: httpMod.default || httpMod,
          crypto: cryptoMod.default || cryptoMod,
        })
      );
    }
    return nodeDepsPromise;
  }

  function applyCorsHeaders(res, origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      `Content-Type, X-Usage-Monitor-Token, ${WINDOW_BRIDGE_ENDPOINT_HEADER}`
    );
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cache-Control', 'no-store');
  }

  function invokeApiHandler(pathname, method, data, endpointId) {
    const authoritativeEndpointId = endpointId || LOCAL_ENDPOINT_ID;
    return handleApiRequest(pathname, method, data, { endpointId: authoritativeEndpointId });
  }

  async function executeRpcBatch(rpcBatch, authoritativeEndpointId = LOCAL_ENDPOINT_ID) {
    const responses = [];
    for (const item of rpcBatch) {
      const reqId = String(item?.id || '');
      if (!reqId) continue;
      try {
        const parsedUrl = new URL(String(item.path || '/'), 'http://127.0.0.1');
        if (!ALLOWED_BRIDGE_PATHS.has(parsedUrl.pathname)) {
          responses.push({ id: reqId, ok: false, status: 404, error: 'Not found' });
          continue;
        }
        const method = String(item.method || 'GET').toUpperCase();
        const reqData =
          method === 'GET'
            ? Object.fromEntries(parsedUrl.searchParams.entries())
            : item.body && typeof item.body === 'object'
              ? item.body
              : {};
        const out = await invokeApiHandler(
          parsedUrl.pathname,
          method,
          reqData,
          authoritativeEndpointId
        );
        const status = Number(out?.status || 200);
        const parsedBody = out?.body ? JSON.parse(out.body) : {};
        if (status >= 200 && status < 300) {
          responses.push({ id: reqId, ok: true, status, data: parsedBody });
        } else {
          responses.push({
            id: reqId,
            ok: false,
            status,
            error: parsedBody?.error || `HTTP ${status}`,
          });
        }
      } catch (err) {
        responses.push({
          id: reqId,
          ok: false,
          status: 500,
          error: err?.message || 'Internal bridge error',
        });
      }
    }
    return responses;
  }

  async function ensureBridgeServer() {
    if (server && bridgePort > 0) {
      return { port: bridgePort, token: bridgeToken };
    }
    if (serverStartPromise) {
      return serverStartPromise;
    }
    serverStartPromise = (async () => {
      const { http, crypto } = await loadNodeDeps();
      const persistedLease = leaseFilePath ? loadJson(leaseFilePath, null) : null;
      const persistedToken = String(persistedLease?.bridgeToken || '').trim();
      const persistedPort = Number(persistedLease?.bridgePort || 0);
      if (!bridgeToken) {
        bridgeToken = /^[0-9a-f]{64}$/i.test(persistedToken)
          ? persistedToken
          : crypto.randomBytes(32).toString('hex');
      }

      const srv = http.createServer((req, res) => {
        // 注意：主窗口为 https://127.0.0.1，桥接为 http://127.0.0.1，跨协议请求在 Chromium 中必然携带
        // Sec-Fetch-Site: cross-site；此处通过严格 Origin 白名单 + Host 校验 + 256-bit 随机令牌保障回环安全。
        const origin = String(req.headers.origin || '').trim();
        if (!isAllowedBridgeOrigin(origin) && !allowedDynamicOrigins.has(origin)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden origin' }));
          return;
        }

        const hostHeader = String(req.headers.host || '').trim().toLowerCase();
        if (
          hostHeader &&
          hostHeader !== `127.0.0.1:${bridgePort}` &&
          hostHeader !== `localhost:${bridgePort}` &&
          hostHeader !== `[::1]:${bridgePort}`
        ) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden host' }));
          return;
        }

        applyCorsHeaders(res, origin);

        const method = String(req.method || 'GET').toUpperCase();
        if (method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        let parsedUrl;
        try {
          parsedUrl = new URL(req.url || '/', `http://127.0.0.1:${bridgePort}`);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Malformed URL' }));
          return;
        }

        if (!ALLOWED_BRIDGE_PATHS.has(parsedUrl.pathname)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }

        const headerToken = String(req.headers['x-usage-monitor-token'] || '');
        if (!verifyBridgeToken(headerToken, bridgeToken, crypto.timingSafeEqual)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid bridge token' }));
          return;
        }

        const headerEndpointRaw = String(
          req.headers[WINDOW_BRIDGE_ENDPOINT_HEADER.toLowerCase()] || ''
        ).trim();
        const queryEndpointRaw = String(parsedUrl.searchParams.get('endpointId') || '').trim();
        const requestedEndpointRaw = headerEndpointRaw || queryEndpointRaw;
        const normalizedReqEndpoint = requestedEndpointRaw
          ? normalizeEndpointId(requestedEndpointRaw)
          : LOCAL_ENDPOINT_ID;
        if (normalizedReqEndpoint === null) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid endpointId' }));
          return;
        }

        if (method === 'GET') {
          const queryData = Object.fromEntries(parsedUrl.searchParams.entries());
          Promise.resolve(invokeApiHandler(parsedUrl.pathname, 'GET', queryData, normalizedReqEndpoint))
            .then((out) => {
              const hdrs = {
                'Content-Type': out.contentType || 'application/json',
                ...(out.headers || {}),
              };
              res.writeHead(out.status || 200, hdrs);
              res.end(out.body);
            })
            .catch((err) => {
              if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
              }
              res.end(
                JSON.stringify({
                  error: 'Internal bridge error',
                  detail: String(err?.message || err || ''),
                })
              );
            });
          return;
        }

        if (method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        let maxBodyBytes =
          parsedUrl.pathname === '/api/export-file'
            ? BRIDGE_MAX_EXPORT_BODY_BYTES
            : BRIDGE_MAX_BODY_BYTES;
        const chunks = [];
        let totalBytes = 0;
        let aborted = false;
        let checkedSettingsExportPrefix = false;
        req.on('data', (chunk) => {
          const nextTotal = totalBytes + chunk.length;
          if (
            nextTotal > maxBodyBytes &&
            !checkedSettingsExportPrefix &&
            parsedUrl.pathname === '/api/settings' &&
            nextTotal <= BRIDGE_MAX_EXPORT_BODY_BYTES
          ) {
            checkedSettingsExportPrefix = true;
            const sampleParts = chunks.length > 0 ? [...chunks, chunk] : [chunk];
            const headBuf = Buffer.concat(sampleParts, Math.min(nextTotal, 512));
            const headStr = headBuf.toString('utf8').trimStart();
            if (/^\{\s*"__exportFileAction"\s*:\s*"(?:save|reveal)"/.test(headStr)) {
              maxBodyBytes = BRIDGE_MAX_EXPORT_BODY_BYTES;
            }
          }
          totalBytes = nextTotal;
          if (totalBytes > maxBodyBytes) {
            aborted = true;
            chunks.length = 0;
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Payload too large' }));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on('end', () => {
          if (aborted) return;
          let bodyObj = {};
          try {
            const raw = Buffer.concat(chunks).toString('utf8').trim();
            bodyObj = raw ? JSON.parse(raw) : {};
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            return;
          }
          if (
            totalBytes > BRIDGE_MAX_BODY_BYTES &&
            parsedUrl.pathname === '/api/settings' &&
            (!bodyObj ||
              typeof bodyObj !== 'object' ||
              Array.isArray(bodyObj) ||
              typeof bodyObj.__exportFileAction !== 'string')
          ) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Payload too large' }));
            return;
          }
          Promise.resolve(invokeApiHandler(parsedUrl.pathname, 'POST', bodyObj, normalizedReqEndpoint))
            .then((out) => {
              const hdrs = {
                'Content-Type': out.contentType || 'application/json',
                ...(out.headers || {}),
              };
              res.writeHead(out.status || 200, hdrs);
              res.end(out.body);
            })
            .catch((err) => {
              if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
              }
              res.end(
                JSON.stringify({
                  error: 'Internal bridge error',
                  detail: String(err?.message || err || ''),
                })
              );
            });
        });
      });

      const listenOnLoopback = (targetPort) =>
        new Promise((resolve, reject) => {
          const onErr = (err) => {
            srv.removeListener('listening', onListening);
            reject(err);
          };
          const onListening = () => {
            srv.removeListener('error', onErr);
            resolve();
          };
          srv.once('error', onErr);
          srv.once('listening', onListening);
          srv.listen(targetPort, '127.0.0.1');
        });

      const preferredPort =
        Number.isInteger(persistedPort) && persistedPort >= 1024 && persistedPort <= 65535
          ? persistedPort
          : 0;
      if (preferredPort > 0) {
        try {
          await listenOnLoopback(preferredPort);
        } catch {
          await listenOnLoopback(0);
        }
      } else {
        await listenOnLoopback(0);
      }
      srv.unref?.();
      const addr = srv.address();
      bridgePort = typeof addr === 'object' && addr ? Number(addr.port || 0) : 0;
      server = srv;
      if (leaseFilePath && bridgePort > 0) {
        saveJson(leaseFilePath, {
          pid: process.pid,
          bundleVersion: String(getBundleVersionFn() || ''),
          bridgePort,
          bridgeToken,
          updatedAtMs: Date.now(),
        });
      }
      return { port: bridgePort, token: bridgeToken };
    })().finally(() => {
      serverStartPromise = null;
    });

    return serverStartPromise;
  }

  function findActiveDevToolsPorts() {
    const candidates = resolveDevToolsPortCandidates(env, platform, homeDir);
    const ports = [];
    const seen = new Set();
    for (const filePath of candidates) {
      try {
        if (!existsSync(filePath)) continue;
        const port = parseDevToolsPortFile(readFileSync(filePath, 'utf8'));
        if (port && !seen.has(port)) {
          seen.add(port);
          ports.push(port);
        }
      } catch {
        // 忽略不可读候选文件
      }
    }
    const rawExplicitPorts = String(env?.ANTIGRAVITY_DEVTOOLS_PORT || '').trim();
    if (rawExplicitPorts) {
      for (const token of rawExplicitPorts.split(/[\s,]+/)) {
        if (!/^\d+$/.test(token)) continue;
        const p = Number(token);
        if (Number.isInteger(p) && p > 0 && p <= 65535 && !seen.has(p)) {
          seen.add(p);
          ports.push(p);
        }
      }
    }
    return ports;
  }

  async function listMainWindowTargets(cdpPort) {
    const { http } = await loadNodeDeps();
    const rawBody = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${cdpPort}/json/list`, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`CDP HTTP ${res.statusCode}`));
          return;
        }
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => resolve(text));
      });
      req.setTimeout(1500, () => req.destroy(new Error('CDP list timeout')));
      req.on('error', reject);
    });
    const parsed = JSON.parse(rawBody);
    if (!Array.isArray(parsed)) return [];
    const associated = associateIdeIframeRoutes(
      parsed,
      parsed.filter(isAntigravityMainPageTarget),
      { lsAddr: lsRuntimeEndpoint.addr, cdpPort }
    );
    for (const mainT of associated) {
      if (Array.isArray(mainT.ideChatTargets)) {
        for (const ct of mainT.ideChatTargets) {
          if (ct.origin && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/i.test(ct.origin)) {
            allowedDynamicOrigins.add(ct.origin);
          }
        }
      }
    }
    return associated;
  }

  function collectAllChatDebuggerUrls(mainTargets) {
    const urls = [];
    const seen = new Set();
    for (const t of mainTargets) {
      if (!Array.isArray(t?.ideChatTargets)) continue;
      for (const ct of t.ideChatTargets) {
        const wsUrl = String(ct?.webSocketDebuggerUrl || '').trim();
        if (wsUrl && !seen.has(wsUrl)) {
          seen.add(wsUrl);
          urls.push(wsUrl);
        }
      }
    }
    return urls;
  }

  async function collectAllMainWindowTargets(cdpPorts) {
    const settled = await Promise.allSettled(cdpPorts.map((p) => listMainWindowTargets(p)));
    let reachableCount = 0;
    const merged = [];
    const seenWs = new Set();
    for (const item of settled) {
      if (item.status === 'fulfilled') {
        reachableCount += 1;
        for (const target of item.value) {
          const wsKey = String(target.webSocketDebuggerUrl || '');
          if (wsKey && !seenWs.has(wsKey)) {
            seenWs.add(wsKey);
            merged.push(target);
          }
        }
      }
    }
    return { reachableCount, targets: merged };
  }

  async function evaluateOnTarget(wsUrl, expression, timeoutMsOverride = 0, signal = null) {
    const WS = WebSocketImpl || globalThis.WebSocket;
    if (typeof WS !== 'function') {
      throw new Error('WebSocket runtime unavailable');
    }
    if (signal?.aborted) {
      throw new Error('CDP Runtime.evaluate aborted');
    }
    const effectiveTimeoutMs = Math.max(500, Number(timeoutMsOverride) || cdpTimeoutMs);
    let ws = null;
    let timer = null;
    let onAbort = null;
    try {
      ws = new WS(wsUrl);
      const evalResult = await new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('CDP Runtime.evaluate timeout'));
        }, effectiveTimeoutMs);

        if (signal && typeof signal.addEventListener === 'function') {
          onAbort = () => reject(new Error('CDP Runtime.evaluate aborted'));
          signal.addEventListener('abort', onAbort, { once: true });
        }

        const onOpen = () => {
          try {
            ws.send(
              JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: {
                  expression,
                  returnByValue: true,
                  awaitPromise: true,
                },
              })
            );
          } catch (err) {
            reject(err);
          }
        };

        const onMessage = (ev) => {
          try {
            const raw = typeof ev?.data === 'string' ? ev.data : String(ev?.data || '');
            const msg = JSON.parse(raw);
            if (msg && msg.id === 1) {
              resolve(msg);
            }
          } catch {
            // 忽略无关事件帧
          }
        };

        const onError = (err) => {
          reject(err instanceof Error ? err : new Error('CDP WebSocket error'));
        };

        ws.addEventListener('open', onOpen, { once: true });
        ws.addEventListener('message', onMessage);
        ws.addEventListener('error', onError, { once: true });
      });
      return evalResult;
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort && signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
      if (ws) {
        try {
          ws.close();
        } catch {
          // 忽略关闭异常
        }
      }
    }
  }

  function updateBridgeStatus(nextState, { enabled = true, aliveCount = 0, targets = 0, leasedBySelf = false, bundleVersion = '', prevLease = null } = {}) {
    lastBridgeStatus = {
      state: nextState,
      enabled: Boolean(enabled),
      aliveCount: Number(aliveCount || 0),
      targets: Number(targets || 0),
      argvUpdatedThisBoot: Boolean(argvUpdatedThisBoot),
      argvConfigured: Boolean(argvConfigured || launcherConfigured),
      launcherConfigured: Boolean(launcherConfigured || argvConfigured),
      hasReadOnlyShortcuts: Boolean(hasReadOnlyShortcuts),
      canRelaunch: Boolean(canRelaunch),
      updatedAtMs: Date.now(),
    };
    if (leasedBySelf && leaseFilePath) {
      const sig = `${nextState}:${lastBridgeStatus.aliveCount}:${lastBridgeStatus.targets}:${lastBridgeStatus.argvUpdatedThisBoot ? 1 : 0}:${lastBridgeStatus.launcherConfigured ? 1 : 0}:${lastBridgeStatus.hasReadOnlyShortcuts ? 1 : 0}:${lastBridgeStatus.canRelaunch ? 1 : 0}`;
      if (sig !== lastPersistedLeaseSig) {
        lastPersistedLeaseSig = sig;
        saveJson(leaseFilePath, {
          pid: process.pid,
          bundleVersion,
          bridgePort: bridgePort > 0 ? bridgePort : Number(prevLease?.bridgePort || 0) || undefined,
          bridgeToken: bridgeToken || String(prevLease?.bridgeToken || '') || undefined,
          syncState: lastBridgeStatus.state,
          aliveCount: lastBridgeStatus.aliveCount,
          targets: lastBridgeStatus.targets,
          argvUpdatedThisBoot: lastBridgeStatus.argvUpdatedThisBoot,
          argvConfigured: lastBridgeStatus.argvConfigured,
          launcherConfigured: lastBridgeStatus.launcherConfigured,
          hasReadOnlyShortcuts: lastBridgeStatus.hasReadOnlyShortcuts,
          canRelaunch: lastBridgeStatus.canRelaunch,
          updatedAtMs: Date.now(),
        });
      }
    }
  }

  function provisionHostLaunchersOnce({ fastCheckIfActive = false } = {}) {
    if (hostLauncherPromise) return hostLauncherPromise;
    hostLauncherPromise = (async () => {
      const ideRes = ensureIdeRemoteDebuggingArgv({ env, homeDir, enabled: true });
      const desktopRes = await ensureDesktopLaunchEntriesConfigured({
        enabled: true,
        fastCheckIfActive,
        env,
        platform,
        homeDir,
        execFileFn: launcherExecFileFn,
        fsOps: launcherFsOps,
        allowInTest: allowDesktopLauncherInTest,
      });
      if (ideRes.updated || desktopRes.updated) {
        argvUpdatedThisBoot = true;
      }
      if (ideRes.updated || ideRes.alreadyConfigured) {
        argvConfigured = true;
      }
      launcherConfigured = Boolean(
        desktopRes.updated || desktopRes.alreadyConfigured || desktopRes.configured
      );
      if (!desktopRes.fastPath) {
        hasReadOnlyShortcuts = Boolean(desktopRes.hasReadOnlyShortcuts);
      }
      lastLauncherProvisionAtMs = Date.now();
    })().finally(() => {
      hostLauncherPromise = null;
    });
    return hostLauncherPromise;
  }

  async function resolveFallbackRulesForEndpoint(endpointId, contextWindows) {
    if (!contextWindows || !Object.keys(contextWindows).length) {
      return { verified: false, rules: {}, catalog: null };
    }
    const epObj =
      endpointId && endpointId !== LOCAL_ENDPOINT_ID
        ? getRegisteredRemoteEndpoint(endpointId)
        : null;
    if (!epObj && typeof resolveLocalContextRulesFn === 'function') {
      try {
        const custom = await resolveLocalContextRulesFn(contextWindows);
        if (custom && typeof custom === 'object') {
          return {
            verified: custom.verified !== false,
            rules: custom.rules && typeof custom.rules === 'object' ? custom.rules : {},
            catalog: custom.catalog || null,
          };
        }
      } catch {
        return { verified: false, rules: {}, catalog: null };
      }
    }
    if (!epObj && (!lsRuntimeEndpoint.baseUrl || lsRuntimeEndpoint.addr === 'test.invalid')) {
      return { verified: false, rules: {}, catalog: null };
    }
    const cacheKey = epObj ? epObj.id : LOCAL_ENDPOINT_ID;
    let cached = cachedBackendCtxModelsByEndpoint.get(cacheKey) || {
      expiresAt: 0,
      verified: false,
      models: [],
      catalog: null,
    };
    if (Date.now() >= cached.expiresAt) {
      try {
        const [stRes, cat] = await Promise.all([
          callLsRpc('GetUserStatus', {}, 2000, epObj),
          getContextModelCatalog(epObj),
        ]);
        const cfgs = stRes?.userStatus?.cascadeModelConfigData?.clientModelConfigs;
        if (Array.isArray(cfgs)) {
          cached = {
            expiresAt: Date.now() + 10_000,
            verified: true,
            models: getContextWindowModels(cfgs, cat),
            catalog: cat || null,
          };
          cachedBackendCtxModelsByEndpoint.delete(cacheKey);
          if (cachedBackendCtxModelsByEndpoint.size >= 16) {
            const oldestKey = cachedBackendCtxModelsByEndpoint.keys().next().value;
            if (oldestKey !== undefined) cachedBackendCtxModelsByEndpoint.delete(oldestKey);
          }
          cachedBackendCtxModelsByEndpoint.set(cacheKey, cached);
        }
      } catch {
        // 忽略瞬态 LS 查询失败，保留上次缓存或交由调用方回退
      }
    }
    if (cached.verified) {
      return {
        verified: true,
        rules:
          cached.models.length > 0 ? resolveContextWindowRules(cached.models, contextWindows) : {},
        catalog: cached.catalog || null,
      };
    }
    return { verified: false, rules: {}, catalog: null };
  }

  async function runSyncInternal({ forceReinject = false } = {}) {
    if (stopped) return { ok: false, reason: 'stopped' };
    const bundleVersion = String(getBundleVersionFn() || '');
    if (bootBundleVersion && bundleVersion && bundleVersion !== String(bootBundleVersion)) {
      onVersionDrift?.();
      return { ok: false, reason: 'version_drift_restarting', injected: 0 };
    }

    const curSettings = getSettingsFn() || {};
    const mountMode = normalizeWindowMountMode(
      curSettings.windowMountMode,
      curSettings.enableWindowOverlay
    );
    const enabled = Boolean(curSettings.enableWindowOverlay !== false && mountMode !== 'sidebar');
    const contextWindows = curSettings.modelContextWindows || {};
    const hasContextWindows = Object.keys(contextWindows).length > 0;
    const ctxMainEnabled = curSettings.contextWindowMainEnabled !== false;
    const ctxSwarmEnabled = curSettings.contextWindowSwarmEnabled === true;
    const needsMainCdpContext = hasContextWindows && ctxMainEnabled;
    const needsCloudCodeProxy = hasContextWindows && ctxSwarmEnabled;
    const needsAnyCdpContext = hasContextWindows && (ctxMainEnabled || ctxSwarmEnabled);
    const hostI18nDesc =
      typeof getHostI18nDescriptorFn === 'function' ? getHostI18nDescriptorFn() : null;
    const needsHostI18n = Boolean(
      hostI18nDesc?.active &&
        hostI18nDesc?.revision &&
        typeof hostI18nDesc?.getPayload === 'function'
    );

    let leasedBySelf = false;
    let currentLease = null;
    if (
      (enabled || needsAnyCdpContext || needsCloudCodeProxy || needsHostI18n) &&
      leaseFilePath &&
      !forceReinject
    ) {
      const lease = loadJson(leaseFilePath, null);
      currentLease = lease;
      const leasePid = Number(lease?.pid || 0);
      const leaseAgeMs = Date.now() - Number(lease?.updatedAtMs || 0);
      if (leasePid > 0 && leasePid !== process.pid && leaseAgeMs >= 0 && leaseAgeMs < 9000 && isPidAlive(leasePid)) {
        const leaseVerNum = Number(lease?.bundleVersion) || 0;
        const myVerNum = Number(bundleVersion) || 0;
        if (leaseVerNum > myVerNum) {
          onVersionDrift?.();
          return { ok: false, enabled: true, reason: 'older_than_leader', injected: 0 };
        }
        if (leaseVerNum === myVerNum || String(lease?.bundleVersion || '') === bundleVersion) {
          const mergedConfigured = Boolean(
            lease?.launcherConfigured || lease?.argvConfigured || launcherConfigured || argvConfigured
          );
          lastBridgeStatus = {
            state: String(lease?.syncState || 'active'),
            enabled: Boolean(enabled),
            aliveCount: Number(lease?.aliveCount || 0),
            targets: Number(lease?.targets || 0),
            argvUpdatedThisBoot: Boolean(lease?.argvUpdatedThisBoot || argvUpdatedThisBoot),
            argvConfigured: mergedConfigured,
            launcherConfigured: mergedConfigured,
            hasReadOnlyShortcuts: Boolean(lease?.hasReadOnlyShortcuts || hasReadOnlyShortcuts),
            canRelaunch: Boolean(lease?.canRelaunch ?? canRelaunch),
            updatedAtMs: Date.now(),
          };
          return { ok: true, enabled: true, reason: 'follower_yield', leaderPid: leasePid, injected: 0 };
        }
      }
      leasedBySelf = true;
      const mergedLauncherConfigured = Boolean(argvConfigured || launcherConfigured);
      lastPersistedLeaseSig = `${lastBridgeStatus.state}:${lastBridgeStatus.aliveCount}:${lastBridgeStatus.targets}:${Boolean(argvUpdatedThisBoot) ? 1 : 0}:${mergedLauncherConfigured ? 1 : 0}:${Boolean(hasReadOnlyShortcuts) ? 1 : 0}:${Boolean(canRelaunch) ? 1 : 0}`;
      saveJson(leaseFilePath, {
        pid: process.pid,
        bundleVersion,
        bridgePort: bridgePort > 0 ? bridgePort : Number(lease?.bridgePort || 0) || undefined,
        bridgeToken: bridgeToken || String(lease?.bridgeToken || '') || undefined,
        syncState: lastBridgeStatus.state,
        aliveCount: lastBridgeStatus.aliveCount,
        targets: lastBridgeStatus.targets,
        argvUpdatedThisBoot: Boolean(argvUpdatedThisBoot),
        argvConfigured: mergedLauncherConfigured,
        launcherConfigured: mergedLauncherConfigured,
        hasReadOnlyShortcuts: Boolean(hasReadOnlyShortcuts),
        canRelaunch: Boolean(canRelaunch),
        updatedAtMs: Date.now(),
      });
    }

    let preResolvedLocalCtx = null;
    if (activeCloudCodeProxy) {
      if (needsCloudCodeProxy) {
        preResolvedLocalCtx = await resolveFallbackRulesForEndpoint(
          LOCAL_ENDPOINT_ID,
          contextWindows
        );
        await activeCloudCodeProxy.reconcile({
          enabled: true,
          rulesByModelId: preResolvedLocalCtx.rules,
          initialCatalogModels: preResolvedLocalCtx.catalog,
        });
      } else {
        await activeCloudCodeProxy.reconcile({ enabled: false, rulesByModelId: {} });
      }
    }

    const shouldCheckLaunchers =
      (enabled || needsMainCdpContext || needsHostI18n) &&
      autoConfigureIdeArgv &&
      (lastLauncherProvisionAtMs === 0 ||
        Date.now() - lastLauncherProvisionAtMs >= launcherRecheckIntervalMs);
    const isInitialLauncherPass = lastLauncherProvisionAtMs === 0;

    const needsCdp = Boolean(enabled || needsMainCdpContext || needsHostI18n);
    const tryMacColdStartAutoRelaunch = async () => {
      if (
        platform !== 'darwin' ||
        macAutoRelaunchCheckedThisProcess ||
        !needsCdp ||
        (leaseFilePath && !leasedBySelf)
      ) {
        return;
      }
      macAutoRelaunchCheckedThisProcess = true;
      if (curSettings?.autoRelaunchOnMissingDebugPort !== true) {
        return;
      }
      await macAutoRelaunchFn({
        enabled: true,
        env,
        platform,
        homeDir,
        stalePortFiles: resolveDevToolsPortCandidates(env, platform, homeDir),
        ...(macAutoRelaunchStateFilePath ? { stateFilePath: macAutoRelaunchStateFilePath } : {}),
        execFileFn: launcherExecFileFn,
        spawnFn: launcherSpawnFn,
        existsFn: existsHostFn,
        fsOps: launcherFsOps,
        allowInTest: allowDesktopLauncherInTest,
      }).catch(() => {});
    };

    const cdpPorts = findActiveDevToolsPorts();
    if (!cdpPorts.length) {
      pruneStaleRemoteEndpoints(new Set());
      const provPending = shouldCheckLaunchers
        ? provisionHostLaunchersOnce({ fastCheckIfActive: !isInitialLauncherPass })
        : hostLauncherPromise;
      if (provPending) {
        await provPending.catch(() => {});
      }
      await tryMacColdStartAutoRelaunch();
      updateBridgeStatus(
        needsCdp ? 'no_devtools_port' : 'disabled',
        {
          enabled,
          leasedBySelf,
          bundleVersion,
          prevLease: currentLease,
        }
      );
      return { ok: false, enabled, reason: 'no_devtools_port', injected: 0 };
    }

    const { reachableCount, targets } = await collectAllMainWindowTargets(cdpPorts);
    if (reachableCount === 0) {
      pruneStaleRemoteEndpoints(new Set());
      const provPending = shouldCheckLaunchers
        ? provisionHostLaunchersOnce({ fastCheckIfActive: !isInitialLauncherPass })
        : hostLauncherPromise;
      if (provPending) {
        await provPending.catch(() => {});
      }
      await tryMacColdStartAutoRelaunch();
      updateBridgeStatus(
        needsCdp ? 'cdp_unreachable' : 'disabled',
        {
          enabled,
          leasedBySelf,
          bundleVersion,
          prevLease: currentLease,
        }
      );
      return { ok: false, enabled, reason: 'cdp_unreachable', injected: 0 };
    }

    if (platform === 'darwin' && !macAutoRelaunchResetThisProcess && (!leaseFilePath || leasedBySelf)) {
      macAutoRelaunchResetThisProcess = true;
      try {
        resetMacAutoRelaunchStateFn({
          ...(macAutoRelaunchStateFilePath ? { stateFilePath: macAutoRelaunchStateFilePath } : {}),
          fsOps: launcherFsOps,
          allowInTest: allowDesktopLauncherInTest,
        });
      } catch {
        // 忽略重置状态文件异常
      }
    }

    if (shouldCheckLaunchers) {
      // 调试端口已正常连通时走纯 Node.js 零子进程快检（<2ms），仅在发现未配参快捷方式时才拉起 PowerShell
      void provisionHostLaunchersOnce({ fastCheckIfActive: true }).catch(() => {});
    }
    if (!targets.length) {
      pruneStaleRemoteEndpoints(new Set());
      updateBridgeStatus(enabled ? 'no_targets' : 'disabled', {
        enabled,
        leasedBySelf,
        bundleVersion,
        prevLease: currentLease,
      });
      return { ok: true, enabled, reason: 'no_targets', injected: 0 };
    }

    if (
      !enabled &&
      !needsAnyCdpContext &&
      !hadContextWindows &&
      !needsHostI18n &&
      !hadHostI18n &&
      !hadInjectedTargets &&
      !hadInjectedChatFrames &&
      !forceReinject
    ) {
      pruneStaleRemoteEndpoints(new Set());
      updateBridgeStatus('disabled', {
        enabled: false,
        targets: targets.length,
        leasedBySelf,
        bundleVersion,
        prevLease: currentLease,
      });
      return { ok: true, enabled: false, removed: 0 };
    }

    const classifyExpr = `(() => {
      try {
        const cfg = typeof window !== 'undefined' && window.__APP_CONFIG__ && typeof window.__APP_CONFIG__ === 'object'
          ? window.__APP_CONFIG__
          : null;
        const observedCsrf = String(
          (typeof window !== 'undefined' && window[${JSON.stringify(CONTEXT_WINDOWS_GLOBAL_KEY)}]?.observedCsrfToken) || ''
        ).trim();
        return {
          origin: String((typeof window !== 'undefined' && window.location?.origin) || '').trim(),
          title: String((typeof document !== 'undefined' && document?.title) || '').trim(),
          csrfToken: String(cfg?.csrfToken || '').trim(),
          observedCsrfToken: observedCsrf,
          appConfig: cfg ? {
            isRemoteControl: cfg.isRemoteControl === true,
            isRemote: cfg.isRemote === true,
            isSsh: cfg.isSsh === true,
            connectionType: String(cfg.connectionType || ''),
            windowMode: String(cfg.windowMode || ''),
            sshHost: String(cfg.sshHost || ''),
            sshHostName: String(cfg.sshHostName || ''),
            sshAlias: String(cfg.sshAlias || ''),
            sshTarget: String(cfg.sshTarget || ''),
            remoteHost: String(cfg.remoteHost || ''),
            remoteAuthority: String(cfg.remoteAuthority || ''),
            remoteName: String(cfg.remoteName || ''),
          } : null,
        };
      } catch {
        return { origin: '', title: '', csrfToken: '', observedCsrfToken: '', appConfig: null };
      }
    })()`;

    const nowClassifyMs = Date.now();
    const localHubInfo =
      typeof getLocalHubPortsFn === 'function' ? getLocalHubPortsFn() : { allPorts: new Set(), httpsPorts: new Set(), csrfTokens: new Set() };
    const probedByWsUrl = new Map();
    const desktopTargets = targets.filter((t) => !t.isIdeWorkbench && t.webSocketDebuggerUrl);

    await Promise.allSettled(
      desktopTargets.map(async (target) => {
        const wsUrl = String(target.webSocketDebuggerUrl || '');
        let targetOriginKey = '';
        try {
          targetOriginKey = new URL(String(target.url || '')).origin;
        } catch {
          targetOriginKey = String(target.url || '');
        }
        const cacheKey = `${wsUrl}::${targetOriginKey}`;
        const cached = targetClassifyCache.get(cacheKey);
        if (cached && nowClassifyMs - cached.ts < 4000) {
          probedByWsUrl.set(wsUrl, cached.info);
          return;
        }
        try {
          const res = await evaluateOnTarget(wsUrl, classifyExpr, 1800);
          const info = res?.result?.result?.value;
          if (info && typeof info === 'object') {
            probedByWsUrl.set(wsUrl, info);
            targetClassifyCache.set(cacheKey, { ts: nowClassifyMs, info });
          }
        } catch {
          if (cached?.info) probedByWsUrl.set(wsUrl, cached.info);
        }
      })
    );

    if (targetClassifyCache.size > 64) {
      for (const [k, rec] of targetClassifyCache.entries()) {
        if (nowClassifyMs - rec.ts > 30_000) targetClassifyCache.delete(k);
      }
    }

    // 两趟分类：第一趟确认明确归属本机的 Desktop 窗口端口，第二趟据此精准识别 SSH 远端窗口
    const confirmedLocalPorts = new Set();
    for (const target of desktopTargets) {
      const probedInfo = probedByWsUrl.get(String(target.webSocketDebuggerUrl || '')) || null;
      const firstPass = classifyWindowTargetEndpoint({
        target,
        probedInfo,
        localHubInfo,
        confirmedLocalPorts: null,
      });
      if (
        !firstPass.isRemote &&
        firstPass.originPort > 0 &&
        (localHubInfo?.allPorts?.has(firstPass.originPort) ||
          (firstPass.csrfToken && localHubInfo?.csrfTokens?.has(firstPass.csrfToken)))
      ) {
        confirmedLocalPorts.add(firstPass.originPort);
      }
    }

    const activeRemoteWsUrls = new Set();
    for (const target of targets) {
      const wsUrl = String(target.webSocketDebuggerUrl || '');
      const probedInfo = probedByWsUrl.get(wsUrl) || null;
      const cls = classifyWindowTargetEndpoint({
        target,
        probedInfo,
        localHubInfo,
        confirmedLocalPorts,
      });
      if (cls.isRemote && wsUrl) {
        const ep = registerRemoteEndpoint({
          origin: cls.origin,
          baseUrl: cls.origin,
          csrfToken: cls.csrfToken,
          wsUrl,
          label: cls.hostLabel,
          stableHostKey: cls.stableHostKey,
        });
        target.endpointId = ep.id;
        target.isRemoteEndpoint = true;
        target.endpointLabel = ep.label;
        activeRemoteWsUrls.add(wsUrl);
      } else {
        target.endpointId = LOCAL_ENDPOINT_ID;
        target.isRemoteEndpoint = false;
        target.endpointLabel = '';
      }
    }

    if (needsAnyCdpContext || hadContextWindows) {
      const localFallbackRes = needsAnyCdpContext
        ? preResolvedLocalCtx ||
          (await resolveFallbackRulesForEndpoint(LOCAL_ENDPOINT_ID, contextWindows))
        : { verified: false, rules: {}, catalog: null };
      const localFallbackRules = localFallbackRes.rules;
      const pinMainBackToDefaults = needsCloudCodeProxy && !ctxMainEnabled;
      const pinBackRules = {};
      if (pinMainBackToDefaults) {
        const upstreamDefaults = activeCloudCodeProxy?.getUpstreamDefaults?.() || {};
        for (const modelId of Object.keys(localFallbackRules)) {
          const defaultLimit = Number(upstreamDefaults[modelId]);
          if (Number.isSafeInteger(defaultLimit) && defaultLimit > 0) {
            pinBackRules[modelId] = defaultLimit;
          }
        }
      }

      const remoteFallbackRulesById = new Map();
      const uniqueRemoteIds = new Set(
        targets
          .filter((t) => !t.isIdeWorkbench && t.isRemoteEndpoint && t.endpointId)
          .map((t) => t.endpointId)
      );
      for (const cachedKey of Array.from(cachedBackendCtxModelsByEndpoint.keys())) {
        if (cachedKey !== LOCAL_ENDPOINT_ID && !getRegisteredRemoteEndpoint(cachedKey)) {
          cachedBackendCtxModelsByEndpoint.delete(cachedKey);
        }
      }
      if (needsMainCdpContext) {
        await Promise.allSettled(
          Array.from(uniqueRemoteIds).map(async (epId) => {
            const res = await resolveFallbackRulesForEndpoint(epId, contextWindows);
            // 仅在远端未能验证模型目录时安全回退本机规则；远端已验证但返回空规则时绝不套用本机高配规则
            remoteFallbackRulesById.set(epId, res.verified ? res.rules : localFallbackRules);
          })
        );
      }

      const ctxEvalTasks = [];
      const seenCtxUrls = new Set();
      for (const target of targets) {
        if (target.isIdeWorkbench) continue;
        const wsUrl = String(target.webSocketDebuggerUrl || '').trim();
        if (!wsUrl || seenCtxUrls.has(wsUrl)) continue;
        seenCtxUrls.add(wsUrl);
        let expr;
        if (!needsAnyCdpContext) {
          expr = createContextWindowSyncExpression({}, contextWindowBootId, {}, true, null);
        } else if (pinMainBackToDefaults) {
          // 仅启用子代理与蜂群时：本地主窗口显式回填上游默认上限把主代理钉回默认；远端主窗口不注入覆盖
          expr = target.isRemoteEndpoint
            ? createContextWindowSyncExpression({}, contextWindowBootId, {}, true, null)
            : createContextWindowSyncExpression(
                contextWindows,
                contextWindowBootId,
                pinBackRules,
                true,
                pinBackRules
              );
        } else {
          const epFallback =
            target.isRemoteEndpoint && target.endpointId
              ? remoteFallbackRulesById.get(target.endpointId) || localFallbackRules
              : localFallbackRules;
          expr = createContextWindowSyncExpression(
            contextWindows,
            contextWindowBootId,
            epFallback,
            true,
            null
          );
        }
        ctxEvalTasks.push(evaluateOnTarget(wsUrl, expr));
      }
      const ideChatExpr = !needsAnyCdpContext
        ? createContextWindowSyncExpression({}, contextWindowBootId, {}, false, null)
        : pinMainBackToDefaults
          ? createContextWindowSyncExpression(
              contextWindows,
              contextWindowBootId,
              pinBackRules,
              false,
              pinBackRules
            )
          : createContextWindowSyncExpression(
              contextWindows,
              contextWindowBootId,
              localFallbackRules,
              false,
              null
            );
      for (const chatUrl of collectAllChatDebuggerUrls(targets)) {
        if (!chatUrl || seenCtxUrls.has(chatUrl)) continue;
        seenCtxUrls.add(chatUrl);
        ctxEvalTasks.push(evaluateOnTarget(chatUrl, ideChatExpr));
      }
      await Promise.allSettled(ctxEvalTasks);
      hadContextWindows = needsAnyCdpContext;
    }

    if (needsHostI18n || hadHostI18n) {
      const hostI18nWsUrls = new Set();
      for (const target of targets) {
        if (target.isIdeWorkbench) continue;
        const wsUrl = String(target.webSocketDebuggerUrl || '').trim();
        if (wsUrl) hostI18nWsUrls.add(wsUrl);
      }
      for (const chatUrl of collectAllChatDebuggerUrls(targets)) {
        if (chatUrl) hostI18nWsUrls.add(chatUrl);
      }

      if (!needsHostI18n) {
        const disposeHostI18nExpr = createHostI18nDisposeExpression();
        await Promise.allSettled(
          Array.from(hostI18nWsUrls).map((wsUrl) => evaluateOnTarget(wsUrl, disposeHostI18nExpr))
        );
        hadHostI18n = false;
        lastHostI18nAppliedCount = 0;
        cachedHostI18nApply = { revision: '', bootId: '', expr: '' };
      } else {
        const heartbeatExpr = createHostI18nHeartbeatExpression(
          hostI18nBootId,
          hostI18nDesc.revision
        );
        let appliedTargets = 0;
        await Promise.allSettled(
          Array.from(hostI18nWsUrls).map(async (wsUrl) => {
            try {
              const hbRes = await evaluateOnTarget(wsUrl, heartbeatExpr, 1800);
              const hbVal = hbRes?.result?.result?.value;
              if (hbVal?.alive === true && hbVal?.needsApply === false) {
                appliedTargets += 1;
                return;
              }
            } catch {
              // 心跳异常时回退完整注入
            }
            if (
              !cachedHostI18nApply.expr ||
              cachedHostI18nApply.revision !== hostI18nDesc.revision ||
              cachedHostI18nApply.bootId !== hostI18nBootId
            ) {
              const payload = hostI18nDesc.getPayload();
              cachedHostI18nApply = {
                revision: hostI18nDesc.revision,
                bootId: hostI18nBootId,
                expr: createHostI18nApplyExpression(payload, hostI18nBootId),
              };
            }
            const applyRes = await evaluateOnTarget(wsUrl, cachedHostI18nApply.expr, 8000);
            if (applyRes?.result?.result?.value?.applied) {
              appliedTargets += 1;
            }
          })
        );
        hadHostI18n = true;
        lastHostI18nAppliedCount = appliedTargets;
      }
    }

    const disposeExpr = `(() => {
      try {
        const existed = Boolean(${windowOverlayRef} || ${windowBridgeRef});
        ${windowOverlayRef}?.[${overlayMethods.dispose}]?.();
        delete ${windowOverlayRef};
        delete ${windowBridgeRef};
        return existed;
      } catch {
        return false;
      }
    })()`;

    async function disposeSingleTarget(wsUrl) {
      if (!wsUrl) return false;
      try {
        const res = await evaluateOnTarget(wsUrl, disposeExpr);
        return res?.result?.result?.value === true;
      } catch {
        return false;
      }
    }

    if (!enabled) {
      pruneStaleRemoteEndpoints(activeRemoteWsUrls);
      if (!hadInjectedTargets && !hadInjectedChatFrames && !forceReinject) {
        updateBridgeStatus('disabled', {
          enabled: false,
          targets: targets.length,
          leasedBySelf,
          bundleVersion,
          prevLease: currentLease,
        });
        return { ok: true, enabled: false, removed: 0 };
      }
      let removed = 0;
      const allDisposeUrls = [
        ...targets.map((t) => String(t.webSocketDebuggerUrl || '')).filter(Boolean),
        ...collectAllChatDebuggerUrls(targets),
      ];
      for (const wsUrl of new Set(allDisposeUrls)) {
        if (await disposeSingleTarget(wsUrl)) removed += 1;
      }
      hadInjectedTargets = false;
      hadInjectedChatFrames = false;
      updateBridgeStatus('disabled', {
        enabled: false,
        targets: targets.length,
        leasedBySelf,
        bundleVersion,
        prevLease: currentLease,
      });
      return { ok: true, enabled: false, removed };
    }

    const { port, token } = await ensureBridgeServer();
    const domRouteExpr = buildDomRouteCascadeIdSnippet();
    const probeExpr = `(() => {
      try {
        const ov = ${windowOverlayRef};
        const br = ${windowBridgeRef};
        const alive = Boolean(ov && typeof ov[${overlayMethods.ensureAlive}] === 'function' && ov[${overlayMethods.ensureAlive}]());
        const dockKind = String(ov?.[${overlayMethods.getDockKind}]?.() || '');
        const clientMountMode = String(ov?.[${overlayMethods.getMountMode}]?.() || '');
        const visible = ${WINDOW_VISIBLE_EXPR};
        const rpcBatch = Array.isArray(br?.rpcQueue) && br.rpcQueue.length > 0
          ? br.rpcQueue.splice(0, 8)
          : [];
        const routeCascadeId = !alive ? ${domRouteExpr} : '';
        return {
          alive,
          dockKind,
          clientMountMode,
          visible,
          bundleVersion: String(ov?.bundleVersion || ''),
          bridgePort: Number(br?.port || 0),
          hasToken: Boolean(br?.token),
          transportMode: String(br?.transportMode || 'http'),
          endpointId: String(br?.[${windowBridgeEndpointKey}] || ${JSON.stringify(LOCAL_ENDPOINT_ID)}),
          endpointLabel: String(br?.endpointLabel || ''),
          hostRouteCascadeId: String(br?.[${windowBridgeRouteKey}] || ''),
          routeCascadeId,
          rpcBatch,
        };
      } catch {
        return { alive: false, dockKind: '', visible: true, bundleVersion: '', bridgePort: 0, hasToken: false, transportMode: 'http', endpointId: ${JSON.stringify(LOCAL_ENDPOINT_ID)}, endpointLabel: '', hostRouteCascadeId: '', routeCascadeId: '', rpcBatch: [] };
      }
    })()`;

    const ideChatRouteProbeExpr = `(() => {
      try {
        const visible = ${WINDOW_VISIBLE_EXPR};
        const focused = Boolean(
          typeof document !== 'undefined' && typeof document.hasFocus === 'function' && document.hasFocus()
        );
        const routeCascadeId = ${domRouteExpr};
        return { routeCascadeId, visible, focused };
      } catch {
        return { routeCascadeId: '', visible: false, focused: false };
      }
    })()`;

    const ideRouteProbeTimeoutMs = Math.max(
      500,
      Math.min(Number(cdpTimeoutMs) || IDE_ROUTE_PROBE_MAX_TIMEOUT_MS, IDE_ROUTE_PROBE_MAX_TIMEOUT_MS)
    );

    async function resolveIdeWorkbenchRouteId(targetObj) {
      const staticRouteId = sanitizeRouteCascadeId(targetObj?.ideRouteCascadeId);
      const chatList = Array.isArray(targetObj?.ideChatTargets) ? targetObj.ideChatTargets : [];
      const probeUrls = chatList
        .map((chatTarget) => String(chatTarget?.webSocketDebuggerUrl || '').trim())
        .filter(Boolean);
      if (probeUrls.length === 0) {
        return staticRouteId;
      }

      if (probeUrls.length === 1) {
        try {
          const res = await evaluateOnTarget(probeUrls[0], ideChatRouteProbeExpr, ideRouteProbeTimeoutMs);
          const cid = sanitizeRouteCascadeId(res?.result?.result?.value?.routeCascadeId);
          return cid || staticRouteId;
        } catch {
          return staticRouteId;
        }
      }

      const abortCtrl = typeof AbortController === 'function' ? new AbortController() : null;
      const results = new Array(probeUrls.length).fill(null);
      let settledCount = 0;
      let resolved = false;

      return new Promise((resolve) => {
        const pickBest = () => {
          let bestRouteId = '';
          let bestRank = 0;
          for (const item of results) {
            if (!item || !item.cid) continue;
            if (item.rank > bestRank) {
              bestRank = item.rank;
              bestRouteId = item.cid;
              if (bestRank === 3) break;
            }
          }
          return bestRouteId || staticRouteId;
        };

        const finishEarly = (routeId) => {
          if (resolved) return;
          resolved = true;
          try {
            abortCtrl?.abort();
          } catch {
            // 忽略中止异常
          }
          resolve(routeId);
        };

        probeUrls.forEach((chatWsUrl, idx) => {
          evaluateOnTarget(
            chatWsUrl,
            ideChatRouteProbeExpr,
            ideRouteProbeTimeoutMs,
            abortCtrl?.signal || null
          )
            .then((res) => {
              const val = res?.result?.result?.value;
              const cid = sanitizeRouteCascadeId(val?.routeCascadeId);
              if (cid) {
                const rank = val?.focused && val?.visible ? 3 : val?.visible ? 2 : 1;
                results[idx] = { cid, rank };
                if (rank === 3) {
                  finishEarly(cid);
                }
              }
            })
            .catch(() => {
              // 单个聊天子视图探测异常、超时或提前中止均不阻断其他视图及静态路由兜底
            })
            .finally(() => {
              settledCount += 1;
              if (!resolved && settledCount === probeUrls.length) {
                resolved = true;
                resolve(pickBest());
              }
            });
        });
      });
    }

    let cachedAssets = null;
    let injected = 0;
    let aliveCount = 0;
    let relayedRpcCount = 0;
    let sawCdpTransport = false;

    async function syncSingleTarget(targetObj, { ideRouteOverride = '', isIdeChatFrame = false } = {}) {
      const wsUrl = String(targetObj?.webSocketDebuggerUrl || '').trim();
      if (!wsUrl) return { alive: false, dockKind: '', visible: false };
      let probedRouteId = '';
      const ideRouteId = sanitizeRouteCascadeId(ideRouteOverride || targetObj.ideRouteCascadeId);
      const targetEndpointId = String(targetObj.endpointId || LOCAL_ENDPOINT_ID);
      const targetIsRemote = Boolean(targetObj.isRemoteEndpoint && targetEndpointId !== LOCAL_ENDPOINT_ID);
      const targetEndpointLabel = targetIsRemote ? String(targetObj.endpointLabel || 'SSH') : '';

      if (!forceReinject) {
        const probeRes = await evaluateOnTarget(wsUrl, probeExpr);
        const snap = probeRes?.result?.result?.value;
        probedRouteId = sanitizeRouteCascadeId(snap?.routeCascadeId);
        if (snap && snap.alive === true) {
          const snapVerNum = Number(snap.bundleVersion) || 0;
          const curVerNum = Number(bundleVersion) || 0;
          if (snapVerNum > 0 && curVerNum > 0 && snapVerNum > curVerNum) {
            onVersionDrift?.();
            aliveCount += 1;
            return {
              alive: true,
              dockKind: String(snap.dockKind || ''),
              visible: snap.visible !== false,
            };
          }
          if (snap.bundleVersion === bundleVersion) {
            const snapEndpointId = String(snap.endpointId || LOCAL_ENDPOINT_ID);
            const snapEndpointLabel = String(snap.endpointLabel || '');
            if (
              snap.bridgePort !== port ||
              snap.hasToken !== true ||
              snapEndpointId !== targetEndpointId ||
              snapEndpointLabel !== targetEndpointLabel
            ) {
              const rebindExpr = `${windowOverlayRef}?.[${overlayMethods.updateBridge}]?.(${JSON.stringify({
                port,
                token,
                [WINDOW_BRIDGE_ENDPOINT_KEY]: targetEndpointId,
                isRemoteEndpoint: targetIsRemote,
                endpointLabel: targetEndpointLabel,
              })})`;
              await evaluateOnTarget(wsUrl, rebindExpr);
            }
            let effectiveDockKind = String(snap.dockKind || '');
            if (snap.clientMountMode && snap.clientMountMode !== mountMode) {
              const modeSyncExpr = `(() => {
                const overlay = ${windowOverlayRef};
                overlay?.[${overlayMethods.applyMountMode}]?.(${JSON.stringify(mountMode)});
                return String(overlay?.[${overlayMethods.getDockKind}]?.() || '');
              })()`;
              const modeRes = await evaluateOnTarget(wsUrl, modeSyncExpr);
              if (typeof modeRes?.result?.result?.value === 'string') {
                effectiveDockKind = modeRes.result.result.value;
              }
            }
            if (
              (targetObj.isIdeWorkbench || isIdeChatFrame) &&
              ideRouteId &&
              String(snap.hostRouteCascadeId || '') !== ideRouteId
            ) {
              const routeSyncExpr = `(() => {
                const bridge = ${windowBridgeRef};
                if (bridge) bridge[${windowBridgeRouteKey}] = ${JSON.stringify(ideRouteId)};
                ${windowOverlayRef}?.[${overlayMethods.syncHostRoute}]?.();
              })()`;
              await evaluateOnTarget(wsUrl, routeSyncExpr);
            }
            aliveCount += 1;
            if (isIdeChatFrame) {
              hadInjectedChatFrames = true;
            } else {
              hadInjectedTargets = true;
            }
            if (snap.transportMode === 'cdp') {
              sawCdpTransport = true;
            }
            if (Array.isArray(snap.rpcBatch) && snap.rpcBatch.length > 0) {
              sawCdpTransport = true;
              const rpcResults = await executeRpcBatch(snap.rpcBatch, targetEndpointId);
              relayedRpcCount += rpcResults.length;
              const deliverExpr = `${windowOverlayRef}?.[${overlayMethods.deliverRpc}]?.(${JSON.stringify(rpcResults)})`;
              await evaluateOnTarget(wsUrl, deliverExpr);
            }
            return {
              alive: true,
              dockKind: effectiveDockKind,
              visible: snap.visible !== false,
            };
          }
        }
      }

      if (!cachedAssets) {
        const [stylesCss, appJs] = await Promise.all([
          readAssetFn('styles.css'),
          readAssetFn('app.js'),
        ]);
        cachedAssets = { stylesCss, appJs };
      }

      let initialTelemetry = null;
      try {
        const routeMatch = String(targetObj.url || '').match(/\/c\/([a-f0-9-]{36})(?:[/?#]|$)/i);
        const targetConvId = routeMatch ? routeMatch[1] : ideRouteId || probedRouteId;
        const initOut = await invokeApiHandler(
          '/api/telemetry',
          'GET',
          {
            conversationId: targetConvId,
            range: 'today',
            stepDetails: 'display',
            stepRevision: '',
          },
          targetEndpointId
        );
        if (Number(initOut?.status || 200) === 200 && initOut?.body) {
          initialTelemetry = JSON.parse(initOut.body);
        }
      } catch {
        // 预取首帧遥测异常不阻塞注入本身
      }

      const bridgeConfigJson = JSON.stringify({
        port,
        token,
        bundleVersion,
        platform: String(platform || ''),
        mountMode,
        [WINDOW_BRIDGE_ENDPOINT_KEY]: targetEndpointId,
        isRemoteEndpoint: targetIsRemote,
        endpointLabel: targetEndpointLabel,
        [WINDOW_BRIDGE_ROUTE_KEY]: ideRouteId || '',
        isIdeChatFrame: Boolean(isIdeChatFrame),
        stylesCss: cachedAssets.stylesCss,
        initialTelemetry,
      });
      const injectionScript = `(() => {
        ${windowBridgeRef} = ${bridgeConfigJson};
      })();
      ${cachedAssets.appJs}
      (() => {
        const ov = ${windowOverlayRef};
        const alive = Boolean(ov?.[${overlayMethods.ensureAlive}]?.());
        const visible = Boolean(
          (window.innerWidth === undefined || Number(window.innerWidth) > 80) &&
          (window.innerHeight === undefined || Number(window.innerHeight) > 80) &&
          !(typeof document !== 'undefined' && document?.hidden === true)
        );
        return { alive, dockKind: String(ov?.[${overlayMethods.getDockKind}]?.() || ''), visible };
      })();`;

      const evalRes = await evaluateOnTarget(wsUrl, injectionScript);
      const evalVal = evalRes?.result?.result?.value;
      const isInjectedAlive =
        Boolean(evalRes && !evalRes.error && !evalRes.result?.exceptionDetails) &&
        (evalVal === true || evalVal?.alive === true);
      if (isInjectedAlive) {
        injected += 1;
        aliveCount += 1;
        if (isIdeChatFrame) {
          hadInjectedChatFrames = true;
        } else {
          hadInjectedTargets = true;
        }
        return {
          alive: true,
          dockKind: typeof evalVal === 'object' && evalVal ? String(evalVal.dockKind || '') : '',
          visible: typeof evalVal === 'object' && evalVal ? evalVal.visible !== false : true,
        };
      }
      return { alive: false, dockKind: '', visible: false };
    }

    if (mountMode !== 'composer' && (hadInjectedChatFrames || forceReinject)) {
      for (const chatWsUrl of collectAllChatDebuggerUrls(targets)) {
        await disposeSingleTarget(chatWsUrl);
      }
      hadInjectedChatFrames = false;
    }

    for (const target of targets) {
      try {
        if (mountMode === 'composer' && target.isIdeWorkbench) {
          const chatList = Array.isArray(target.ideChatTargets) ? target.ideChatTargets : [];
          let chatComposerActive = false;
          for (const chatTarget of chatList) {
            if (!chatTarget.webSocketDebuggerUrl) continue;
            try {
              const chatState = await syncSingleTarget(chatTarget, {
                ideRouteOverride: chatTarget.cascadeId || target.ideRouteCascadeId,
                isIdeChatFrame: true,
              });
              if (chatState.alive && chatState.visible && chatState.dockKind === 'composer') {
                chatComposerActive = true;
              }
            } catch {
              // 单个聊天子视图异常不阻断主窗口兜底
            }
          }
          if (chatComposerActive) {
            await disposeSingleTarget(target.webSocketDebuggerUrl);
          } else {
            const ideRouteOverride = await resolveIdeWorkbenchRouteId(target);
            await syncSingleTarget(target, { ideRouteOverride });
          }
          continue;
        }

        const ideRouteOverride = target.isIdeWorkbench
          ? await resolveIdeWorkbenchRouteId(target)
          : '';
        await syncSingleTarget(target, { ideRouteOverride });
      } catch {
        // 单个窗口注入异常不阻断其他窗口
      }
    }

    pruneStaleRemoteEndpoints(activeRemoteWsUrls);
    cdpFallbackActive = sawCdpTransport;
    updateBridgeStatus(aliveCount > 0 ? 'active' : 'no_targets', {
      enabled: true,
      aliveCount,
      targets: targets.length,
      leasedBySelf,
      bundleVersion,
      prevLease: currentLease,
    });
    return {
      ok: true,
      enabled: true,
      port,
      targets: targets.length,
      injected,
      aliveCount,
      relayedRpcCount,
    };
  }

  async function invokeRemoteWindowRpc(endpoint, method, body, timeoutMs = 5000) {
    const wsUrls = getRemoteEndpointTargetWsUrls(endpoint);
    if (wsUrls.length === 0) {
      throw new Error(`No live CDP target for remote endpoint ${endpoint?.id || ''}`);
    }
    const expr = buildWindowRemoteRpcExpression(method, body, timeoutMs);
    const evalTimeoutMs = Math.max(cdpTimeoutMs, (Number(timeoutMs) || 5000) + 1500);
    let lastError = null;
    for (const wsUrl of wsUrls) {
      try {
        const res = await evaluateOnTarget(wsUrl, expr, evalTimeoutMs);
        if (res?.error || res?.result?.exceptionDetails) {
          lastError = new Error(
            res?.error?.message ||
              res?.result?.exceptionDetails?.text ||
              'CDP remote RPC evaluation exception'
          );
          continue;
        }
        const val = res?.result?.result?.value;
        if (val && val.ok === true) {
          return val.data ?? {};
        }
        lastError = new Error(val?.error || `Remote window RPC ${method} failed (${val?.status || 0})`);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error(`Remote window RPC ${method} failed`);
  }

  if (bindRemoteRpcInvoker) {
    setRemoteWindowRpcInvoker(invokeRemoteWindowRpc);
  }

  function syncAllWindows(opts = {}) {
    if (syncInFlight) {
      return syncInFlight.then(() => runSyncInternal(opts));
    }
    syncInFlight = runSyncInternal(opts).finally(() => {
      syncInFlight = null;
    });
    return syncInFlight;
  }

  function scheduleNextPoll() {
    if (stopped) return;
    if (pollTimer) clearTimeout(pollTimer);
    const delayMs = cdpFallbackActive ? fastPollIntervalMs : pollIntervalMs;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      syncAllWindows()
        .catch(() => {})
        .finally(() => {
          scheduleNextPoll();
        });
    }, delayMs);
    pollTimer.unref?.();
  }

  function start() {
    stopped = false;
    contextWindowBootId = `${process.pid}:${Date.now()}`;
    if (bindRemoteRpcInvoker) {
      setRemoteWindowRpcInvoker(invokeRemoteWindowRpc);
    }
    if (initialTimer) clearTimeout(initialTimer);
    if (pollTimer) clearTimeout(pollTimer);

    if (leaseFilePath) {
      const curSettings = getSettingsFn() || {};
      const mountMode = normalizeWindowMountMode(
        curSettings.windowMountMode,
        curSettings.enableWindowOverlay
      );
      if (curSettings.enableWindowOverlay !== false && mountMode !== 'sidebar') {
        ensureBridgeServer().catch(() => {});
      }
    }

    initialTimer = setTimeout(() => {
      initialTimer = null;
      syncAllWindows()
        .catch(() => {})
        .finally(() => {
          scheduleNextPoll();
        });
    }, 120);
    initialTimer.unref?.();
  }

  async function stop({ disposeWindows = false } = {}) {
    if (initialTimer) {
      clearTimeout(initialTimer);
      initialTimer = null;
    }
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (
      disposeWindows &&
      (hadInjectedTargets || hadInjectedChatFrames || hadContextWindows || hadHostI18n)
    ) {
      const prevStopped = stopped;
      stopped = false;
      try {
        const cdpPorts = findActiveDevToolsPorts();
        if (cdpPorts.length) {
          const { targets } = await collectAllMainWindowTargets(cdpPorts).catch(() => ({
            targets: [],
          }));
          const disposeExpr = `(() => {
            try {
              ${windowHostI18nRef}?.dispose?.();
              ${windowContextWindowsRef}?.dispose?.();
              ${windowOverlayRef}?.[${overlayMethods.dispose}]?.();
              delete ${windowOverlayRef};
              delete ${windowBridgeRef};
              return true;
            } catch {
              return false;
            }
          })()`;
          const allUrls = [
            ...targets.map((t) => String(t.webSocketDebuggerUrl || '')).filter(Boolean),
            ...collectAllChatDebuggerUrls(targets),
          ];
          for (const wsUrl of new Set(allUrls)) {
            await evaluateOnTarget(wsUrl, disposeExpr).catch(() => {});
          }
        }
      } finally {
        stopped = prevStopped;
      }
    }
    stopped = true;
    hadInjectedTargets = false;
    hadInjectedChatFrames = false;
    hadContextWindows = false;
    hadHostI18n = false;
    lastHostI18nAppliedCount = 0;
    cachedHostI18nApply = { revision: '', bootId: '', expr: '' };
    if (activeCloudCodeProxy) {
      await activeCloudCodeProxy.stop().catch(() => {});
    }
    if (bindRemoteRpcInvoker) {
      setRemoteWindowRpcInvoker(null);
    }
    if (server) {
      const srv = server;
      server = null;
      bridgePort = 0;
      await new Promise((resolve) => srv.close(() => resolve()));
    }
  }

  function notifySettingChanged(enabled) {
    if (!enabled) {
      hadInjectedTargets = true;
      hadInjectedChatFrames = true;
      const cur = getSettingsFn() || {};
      const hasCtx =
        Object.keys(cur.modelContextWindows || {}).length > 0 &&
        cur.contextWindowMainEnabled !== false;
      const hasHostI18n = Boolean(
        typeof getHostI18nDescriptorFn === 'function' && getHostI18nDescriptorFn()?.active
      );
      if (!hasCtx && !hasHostI18n && autoConfigureIdeArgv) {
        launcherConfigured = false;
        hasReadOnlyShortcuts = false;
        lastLauncherProvisionAtMs = 0;
        void ensureDesktopLaunchEntriesConfigured({
          enabled: false,
          env,
          platform,
          homeDir,
          execFileFn: launcherExecFileFn,
          fsOps: launcherFsOps,
          allowInTest: allowDesktopLauncherInTest,
        }).catch(() => {});
      }
    } else {
      lastLauncherProvisionAtMs = 0;
      hadInjectedChatFrames = true;
    }
    return syncAllWindows({ forceReinject: false }).catch(() => ({ ok: false }));
  }

  function notifyContextWindowsChanged() {
    const cur = getSettingsFn() || {};
    const mountMode = normalizeWindowMountMode(cur.windowMountMode, cur.enableWindowOverlay);
    const overlayOn = Boolean(cur.enableWindowOverlay !== false && mountMode !== 'sidebar');
    const hasCtx =
      Object.keys(cur.modelContextWindows || {}).length > 0 &&
      cur.contextWindowMainEnabled !== false;
    const hasHostI18n = Boolean(
      typeof getHostI18nDescriptorFn === 'function' && getHostI18nDescriptorFn()?.active
    );
    if (hasCtx) {
      lastLauncherProvisionAtMs = 0;
    } else if (!overlayOn && !hasHostI18n && autoConfigureIdeArgv) {
      launcherConfigured = false;
      hasReadOnlyShortcuts = false;
      lastLauncherProvisionAtMs = 0;
      void ensureDesktopLaunchEntriesConfigured({
        enabled: false,
        env,
        platform,
        homeDir,
        execFileFn: launcherExecFileFn,
        fsOps: launcherFsOps,
        allowInTest: allowDesktopLauncherInTest,
      }).catch(() => {});
    }
    return syncAllWindows({ forceReinject: false }).catch(() => ({ ok: false }));
  }

  function notifyHostI18nChanged() {
    const cur = getSettingsFn() || {};
    const mountMode = normalizeWindowMountMode(cur.windowMountMode, cur.enableWindowOverlay);
    const overlayOn = Boolean(cur.enableWindowOverlay !== false && mountMode !== 'sidebar');
    const hasCtx =
      Object.keys(cur.modelContextWindows || {}).length > 0 &&
      cur.contextWindowMainEnabled !== false;
    const hasHostI18n = Boolean(
      typeof getHostI18nDescriptorFn === 'function' && getHostI18nDescriptorFn()?.active
    );
    if (hasHostI18n) {
      lastLauncherProvisionAtMs = 0;
    } else {
      hadHostI18n = true;
      if (!overlayOn && !hasCtx && autoConfigureIdeArgv) {
        launcherConfigured = false;
        hasReadOnlyShortcuts = false;
        lastLauncherProvisionAtMs = 0;
        void ensureDesktopLaunchEntriesConfigured({
          enabled: false,
          env,
          platform,
          homeDir,
          execFileFn: launcherExecFileFn,
          fsOps: launcherFsOps,
          allowInTest: allowDesktopLauncherInTest,
        }).catch(() => {});
      }
    }
    return syncAllWindows({ forceReinject: false }).catch(() => ({ ok: false }));
  }

  async function collectHostI18nUntranslatedFromTargets() {
    const cdpPorts = findActiveDevToolsPorts();
    if (!cdpPorts.length) {
      return { targets: 0, items: [] };
    }
    const { targets } = await collectAllMainWindowTargets(cdpPorts).catch(() => ({ targets: [] }));
    const wsUrls = new Set();
    for (const target of targets) {
      if (target.isIdeWorkbench) continue;
      const wsUrl = String(target.webSocketDebuggerUrl || '').trim();
      if (wsUrl) wsUrls.add(wsUrl);
    }
    for (const chatUrl of collectAllChatDebuggerUrls(targets)) {
      if (chatUrl) wsUrls.add(chatUrl);
    }
    if (wsUrls.size === 0) {
      return { targets: 0, items: [] };
    }
    const collectExpr = createHostI18nCollectExpression();
    const settled = await Promise.allSettled(
      Array.from(wsUrls).map((wsUrl) => evaluateOnTarget(wsUrl, collectExpr, 3500))
    );
    const mergedCounts = new Map();
    const mergedKinds = new Map();
    let scannedTargets = 0;
    for (const res of settled) {
      if (res.status !== 'fulfilled') continue;
      const val = res.value?.result?.result?.value;
      if (!val || !Array.isArray(val.items)) continue;
      scannedTargets += 1;
      for (const item of val.items) {
        const text = String(item?.text || '').trim();
        if (!text) continue;
        mergedCounts.set(text, (mergedCounts.get(text) || 0) + (Number(item?.count || 1) || 1));
        if (!mergedKinds.has(text)) mergedKinds.set(text, String(item?.kind || 'text'));
      }
    }
    const items = Array.from(mergedCounts.entries())
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 200)
      .map(([text, count]) => ({ text, kind: mergedKinds.get(text) || 'text', count }));
    return { targets: scannedTargets, items };
  }

  return {
    ensureBridgeServer,
    syncAllWindows,
    invokeRemoteWindowRpc,
    notifySettingChanged,
    notifyContextWindowsChanged,
    notifyHostI18nChanged,
    collectHostI18nUntranslatedFromTargets,
    start,
    stop,
    getBridgeInfo: () => ({ port: bridgePort, token: bridgeToken, running: Boolean(server) }),
    getBridgeStatus: () => ({
      ...lastBridgeStatus,
      hostI18nAppliedCount: lastHostI18nAppliedCount,
    }),
  };
}

let defaultBridgeController = null;

/**
 * 读取进程级默认双栖桥接器的最新同步健康度快照（供 `/api/telemetry` 与偏好设置面板诊断使用）。
 */
export function getDefaultWindowBridgeStatus() {
  if (!defaultBridgeController) {
    return {
      state: 'pending',
      enabled: true,
      aliveCount: 0,
      targets: 0,
      argvUpdatedThisBoot: false,
      argvConfigured: false,
      launcherConfigured: false,
      hasReadOnlyShortcuts: false,
      canRelaunch: false,
      updatedAtMs: 0,
    };
  }
  return defaultBridgeController.getBridgeStatus();
}

/**
 * 启动进程级默认的双栖窗口桥接控制器（幂等）。
 *
 * @param {Parameters<typeof createWindowBridgeController>[0]} options
 */
export function startDefaultWindowBridge(options) {
  if (!defaultBridgeController) {
    defaultBridgeController = createWindowBridgeController({
      leaseFilePath: join(DATA_DIR, 'window-bridge-lease.json'),
      bindRemoteRpcInvoker: true,
      manageCloudCodeProxy: true,
      ...options,
    });
    defaultBridgeController.start();
  }
  return defaultBridgeController;
}

/**
 * 在用户保存设置切换 `enableWindowOverlay` 时立即同步所有打开的主窗口挂载状态。
 *
 * @param {boolean} enabled
 */
export function notifyWindowOverlaySetting(enabled) {
  if (!defaultBridgeController) return Promise.resolve({ ok: false });
  return defaultBridgeController.notifySettingChanged(enabled);
}

export function notifyModelContextWindowsChanged() {
  if (!defaultBridgeController) return Promise.resolve({ ok: false });
  return defaultBridgeController.notifyContextWindowsChanged();
}

export function notifyHostI18nChanged() {
  if (!defaultBridgeController) return Promise.resolve({ ok: false });
  return defaultBridgeController.notifyHostI18nChanged();
}

export function collectHostI18nUntranslatedFromActiveTargets() {
  if (!defaultBridgeController) {
    return Promise.resolve({ targets: 0, items: [] });
  }
  return defaultBridgeController.collectHostI18nUntranslatedFromTargets();
}
