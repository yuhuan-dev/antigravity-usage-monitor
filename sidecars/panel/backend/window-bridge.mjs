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
  statSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeTextFileAtomicSync } from './fs-atomic.mjs';
import {
  BRIDGE_API_PATHS,
  BRIDGE_ROUTE_PING_PATH,
  CONTEXT_WINDOWS_GLOBAL_KEY,
  LOCAL_ENDPOINT_ID,
  WINDOW_BRIDGE_ENDPOINT_HEADER,
  WINDOW_BRIDGE_ENDPOINT_KEY,
  WINDOW_BRIDGE_KEY,
  WINDOW_BRIDGE_ROUTE_KEY,
  WINDOW_OVERLAY_KEY,
  WINDOW_OVERLAY_METHODS,
  detectVsCodeVariantFromUrl,
  isVsCodeHostUrl,
} from '../shared/window-bridge-protocol.mjs';
import { HOST_I18N_GLOBAL_KEY } from '../shared/host-i18n-protocol.mjs';
import {
  HOST_THEME_CSS_VARS,
  getHostThemeSignature,
  normalizeHostThemeSnapshot,
} from '../shared/host-theme.mjs';
import { parseIdeRemoteAuthority } from '../shared/workspace-uri.mjs';
import {
  DATA_DIR,
  SHARED_BRIDGE_LEASE_FILE,
  computeRuntimeCodeVersion,
  isContextWindowFeatureActive,
  loadJson,
  loadSettings,
  lsRuntimeEndpoint,
  normalizeAutoConfigureLaunch,
  normalizeEnableRemoteSshTelemetry,
  normalizeVsCodeMountMode,
  normalizeWindowMountMode,
  saveJson,
} from './config.mjs';
import { recordLiveCdpHostTheme } from './host-theme-store.mjs';
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
import { createDevToolsPortProber } from './devtools-port-probe.mjs';
import {
  ensureDesktopLaunchEntriesConfigured,
  inspectMacOsLaunchWrapperStatus,
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
import { createIdeRemoteSshCoordinator } from './ide-remote-ssh.mjs';
import {
  VSCODE_HOST_VARIANTS,
  createLocalVsCodeSupportCache,
  hasAnyLocalVsCodeAntigravityExtension,
  hasLocalAgyCli,
  hasLocalAgyCliPlugin,
  hasVsCodeAntigravityExtension,
  hasVsCodeAntigravitySupport,
  hasVsCodeRemoteSshExtension,
  resolveVsCodeDevToolsPortCandidates,
} from './vscode-host-support.mjs';
import { getLocalHubPorts } from './ls-discovery.mjs';
import { callLsRpc, getContextModelCatalog } from './ls-rpc.mjs';
import { getDefaultCloudCodeProxy } from './cloudcode-proxy.mjs';

export {
  hasAnyLocalVsCodeAntigravityExtension,
  hasLocalAgyCli,
  hasLocalAgyCliPlugin,
  hasVsCodeAntigravityExtension,
  hasVsCodeAntigravitySupport,
  hasVsCodeRemoteSshExtension,
  resolveVsCodeDevToolsPortCandidates,
};

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
    const isExtView = /[?&]extension(?:View|Variant)=/i.test(String(window.location?.search || ''));
    const pathMatch = String(window.location?.pathname || '').match(/^\\/c\\/([0-9a-f-]{36})(?:\\/|$)/i);
    const pathId = pathMatch && uuidRe.test(pathMatch[1]) ? pathMatch[1] : '';
    if (!isExtView && pathId) return pathId;
    if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
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
    }
    if (pathId) return pathId;
    return '';
  })()`;
}

/**
 * 构建运行在宿主主窗口（Antigravity 2.0 或 Antigravity IDE）内的只读主题令牌采集 IIFE 片段。
 * 优先提取原生 `--background` / `--card` / `--foreground` 等 CSS 变量，IDE 环境下自动映射 `--vscode-*`，
 * 并通过显式类名属性或实际渲染色探针判定 `'dark' | 'light'` 极性。
 *
 * @returns {string}
 */
export function buildHostThemeProbeSnippet() {
  const varNamesJson = JSON.stringify(HOST_THEME_CSS_VARS);
  return `(() => {
    try {
      if (typeof document === 'undefined' || typeof window === 'undefined') return null;
      const root = document.documentElement;
      const body = document.body;
      const wb = typeof document.querySelector === 'function' ? document.querySelector('.monaco-workbench') : null;
      const getCs = (el) => {
        if (!el || typeof window.getComputedStyle !== 'function') return null;
        try { return window.getComputedStyle(el); } catch { return null; }
      };
      const rootCs = getCs(root);
      const bodyCs = getCs(body);
      const wbCs = getCs(wb);
      const readCssVar = (name) => {
        for (const cs of [rootCs, bodyCs, wbCs]) {
          const v = String(cs?.getPropertyValue?.(name) || '').trim();
          if (v) return v;
        }
        return '';
      };
      const vars = {};
      for (const name of ${varNamesJson}) {
        const val = readCssVar(name);
        if (val) vars[name] = val;
      }
      const pick = (...names) => {
        for (const n of names) {
          const v = readCssVar(n);
          if (v) return v;
        }
        return '';
      };
      if (!vars['--background']) {
        const mapped = [
          ['--background', pick('--vscode-sideBar-background', '--vscode-editor-background', '--vscode-panel-background')],
          ['--card', pick('--vscode-editorWidget-background', '--vscode-sideBar-background', '--vscode-editor-background')],
          ['--foreground', pick('--vscode-foreground', '--vscode-editor-foreground')],
          ['--muted-foreground', pick('--vscode-descriptionForeground', '--vscode-sideBarTitle-foreground')],
          ['--border', pick('--vscode-widget-border', '--vscode-panel-border', '--vscode-commandCenter-border', '--vscode-contrastBorder')],
          ['--primary', pick('--vscode-textLink-foreground', '--vscode-button-background', '--vscode-focusBorder')],
          ['--destructive', pick('--vscode-errorForeground', '--vscode-editorError-foreground')],
        ];
        for (const [k, v] of mapped) {
          if (v && !vars[k]) vars[k] = v;
        }
      }
      const isUsableFont = (raw) => {
        const v = String(raw || '').trim();
        if (!v) return false;
        const bare = v.replace(/["']/g, '').trim();
        return !/^(?:initial|inherit|unset|revert|serif|sans-serif|monospace|times new roman|arial)$/i.test(bare);
      };
      if (!vars['--font-sans']) {
        const bodyFont = String(bodyCs?.fontFamily || '').trim();
        const rootFont = String(rootCs?.fontFamily || '').trim();
        const mappedSans =
          (isUsableFont(vars['--font-family']) ? vars['--font-family'] : '') ||
          pick('--vscode-font-family') ||
          (isUsableFont(bodyFont) ? bodyFont : '') ||
          (isUsableFont(rootFont) ? rootFont : '');
        if (mappedSans) vars['--font-sans'] = mappedSans;
      }
      if (!vars['--font-mono']) {
        const mappedMono =
          (isUsableFont(vars['--editor-font-family']) ? vars['--editor-font-family'] : '') ||
          pick('--vscode-editor-font-family', '--font-code');
        if (mappedMono) vars['--font-mono'] = mappedMono;
      }

      let colorScheme = '';
      const lightClasses = { light: 1, 'vs-light': 1, 'vscode-light': 1, 'hc-light': 1, 'vscode-high-contrast-light': 1 };
      const darkClasses = { dark: 1, 'vs-dark': 1, 'vscode-dark': 1, 'hc-black': 1, 'vscode-high-contrast': 1 };
      for (const el of [body, root, wb]) {
        if (!el || colorScheme) continue;
        const vk = String(el.getAttribute?.('data-vscode-theme-kind') || '').trim().toLowerCase();
        if (vk) {
          if (vk.includes('light')) { colorScheme = 'light'; break; }
          if (vk.includes('dark') || vk.includes('high-contrast')) { colorScheme = 'dark'; break; }
        }
        const dt = String(el.getAttribute?.('data-theme') || el.getAttribute?.('data-color-mode') || '').trim().toLowerCase();
        if (dt === 'light' || dt.endsWith('-light')) { colorScheme = 'light'; break; }
        if (dt === 'dark' || dt.endsWith('-dark')) { colorScheme = 'dark'; break; }
        const cls = typeof el.className === 'string' ? el.className.trim().toLowerCase().split(/\\s+/) : [];
        for (const tok of cls) {
          if (lightClasses[tok]) { colorScheme = 'light'; break; }
          if (darkClasses[tok]) { colorScheme = 'dark'; break; }
        }
      }

      if (!colorScheme && typeof document.createElement === 'function' && typeof window.getComputedStyle === 'function') {
        const probeColor = vars['--background'] || vars['--card'] || String(bodyCs?.backgroundColor || rootCs?.backgroundColor || '').trim();
        if (probeColor && root && typeof root.appendChild === 'function') {
          let probe = null;
          try {
            probe = document.createElement('span');
            probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;color:' + probeColor;
            root.appendChild(probe);
            const resolved = String(window.getComputedStyle(probe)?.color || '').trim().toLowerCase();
            probe.remove();
            probe = null;
            const nums = (resolved.match(/[\\d.]+/g) || []).map(Number);
            if (nums.length >= 3) {
              const scale = resolved.startsWith('color(') ? 1 : 255;
              const r = nums[0] / scale;
              const g = nums[1] / scale;
              const b = nums[2] / scale;
              const lum = 0.299 * r + 0.587 * g + 0.114 * b;
              if (Number.isFinite(lum)) colorScheme = lum > 0.52 ? 'light' : 'dark';
            }
          } catch {
            try { probe?.remove?.(); } catch {}
          }
        }
      }

      if (!colorScheme && !vars['--background'] && !vars['--foreground'] && !vars['--card']) {
        return null;
      }
      return { colorScheme, vars, source: 'cdp' };
    } catch {
      return null;
    }
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
        prevCommaIdx: tokens[idx - 1]?.raw === ',' ? tokens[idx - 1].start : -1,
        nextCommaIdx: tokens[valLastIdx + 1]?.raw === ',' ? tokens[valLastIdx + 1].start : -1,
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
export function ensureRemoteDebuggingInArgvText(rawText, { enabled = true } = {}) {
  if (!enabled) {
    if (typeof rawText !== 'string' || !rawText.trim()) {
      return { changed: false, valid: true, text: String(rawText || '') };
    }
    const scanned = scanJsoncObject(rawText);
    if (!scanned) {
      return { changed: false, valid: false, reason: 'invalid_jsonc', text: rawText };
    }
    const existingVal = scanned.parsed['remote-debugging-port'];
    const isManagedZero =
      existingVal === 0 || (typeof existingVal === 'string' && existingVal.trim() === '0');
    if (!isManagedZero) {
      return {
        changed: false,
        valid: true,
        alreadyConfigured:
          (typeof existingVal === 'string' && existingVal.trim().length > 0) ||
          (typeof existingVal === 'number' &&
            Number.isInteger(existingVal) &&
            existingVal > 0 &&
            existingVal <= 65535),
        text: rawText,
      };
    }
    const propSpan = scanned.topProps.get('remote-debugging-port');
    if (!propSpan) {
      return { changed: false, valid: true, text: rawText };
    }
    let lineStart = propSpan.keyStart;
    while (lineStart > 0 && (rawText[lineStart - 1] === ' ' || rawText[lineStart - 1] === '\t')) {
      lineStart -= 1;
    }
    const ownsLineStart =
      lineStart === 0 || rawText[lineStart - 1] === '\n' || rawText[lineStart - 1] === '\r';
    const delStart = ownsLineStart ? lineStart : propSpan.keyStart;

    let nextText = rawText;
    if (propSpan.nextCommaIdx >= 0) {
      let delEnd = propSpan.nextCommaIdx + 1;
      let cursor = delEnd;
      while (cursor < rawText.length && (rawText[cursor] === ' ' || rawText[cursor] === '\t')) {
        cursor += 1;
      }
      if (ownsLineStart && (rawText[cursor] === '\r' || rawText[cursor] === '\n')) {
        delEnd = rawText[cursor] === '\r' && rawText[cursor + 1] === '\n' ? cursor + 2 : cursor + 1;
      }
      nextText = rawText.slice(0, delStart) + rawText.slice(delEnd);
    } else if (propSpan.prevCommaIdx >= 0) {
      let delEnd = propSpan.valEnd;
      let cursor = delEnd;
      while (cursor < rawText.length && (rawText[cursor] === ' ' || rawText[cursor] === '\t')) {
        cursor += 1;
      }
      if (ownsLineStart && (rawText[cursor] === '\r' || rawText[cursor] === '\n')) {
        delEnd = rawText[cursor] === '\r' && rawText[cursor + 1] === '\n' ? cursor + 2 : cursor + 1;
      }
      const withoutProp = rawText.slice(0, delStart) + rawText.slice(delEnd);
      nextText =
        withoutProp.slice(0, propSpan.prevCommaIdx) + withoutProp.slice(propSpan.prevCommaIdx + 1);
    } else {
      let delEnd = propSpan.valEnd;
      let cursor = delEnd;
      while (cursor < rawText.length && (rawText[cursor] === ' ' || rawText[cursor] === '\t')) {
        cursor += 1;
      }
      if (ownsLineStart && (rawText[cursor] === '\r' || rawText[cursor] === '\n')) {
        delEnd = rawText[cursor] === '\r' && rawText[cursor + 1] === '\n' ? cursor + 2 : cursor + 1;
      }
      nextText = rawText.slice(0, delStart) + rawText.slice(delEnd);
    }

    const verifyOff = scanJsoncObject(nextText);
    if (!verifyOff || Object.prototype.hasOwnProperty.call(verifyOff.parsed, 'remote-debugging-port')) {
      return { changed: false, valid: false, reason: 'post_check_failed', text: rawText };
    }
    return { changed: nextText !== rawText, valid: true, removed: true, text: nextText };
  }

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

function patchSingleHostArgvFile(
  argvPath,
  { enabled = true, createDir = false, missingReason = 'dir_missing' } = {}
) {
  try {
    const dirPath = dirname(argvPath);
    if (!existsSync(dirPath)) {
      if (!createDir || !enabled) {
        return { checked: true, updated: false, reason: missingReason, argvPath };
      }
      mkdirSync(dirPath, { recursive: true });
    }
    if (!enabled && !existsSync(argvPath)) {
      return { checked: true, updated: false, alreadyConfigured: false, argvPath };
    }
    const rawText = existsSync(argvPath) ? readFileSync(argvPath, 'utf8') : '';
    const patched = ensureRemoteDebuggingInArgvText(rawText, { enabled });
    if (!patched.valid) {
      return { checked: true, updated: false, reason: patched.reason || 'invalid_jsonc', argvPath };
    }
    if (!patched.changed) {
      return {
        checked: true,
        updated: false,
        alreadyConfigured: Boolean(patched.alreadyConfigured),
        portValue: patched.portValue,
        argvPath,
      };
    }
    writeTextFileAtomicSync(argvPath, patched.text);
    return {
      checked: true,
      updated: true,
      removed: Boolean(patched.removed),
      alreadyConfigured: Boolean(enabled),
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
 * `"remote-debugging-port": "0"`；显式关闭时剥离受管 `"0"` 端口并保留自定义配置与注释。
 *
 * @param {{ env?: Record<string, string|undefined>, homeDir?: string, enabled?: boolean }} [options]
 */
export function ensureIdeRemoteDebuggingArgv({
  env = process.env,
  homeDir = homedir(),
  enabled = true,
} = {}) {
  const argvPath = resolveIdeArgvPath(env, homeDir);
  return patchSingleHostArgvFile(argvPath, {
    enabled,
    createDir: false,
    missingReason: 'ide_dir_missing',
  });
}

/**
 * 独立维护标准 VS Code / VS Code Insiders 的 `~/.vscode/argv.json` 与 `~/.vscode-insiders/argv.json`：
 * - 开启时仅为已安装 Antigravity 扩展 / 本机 `agy` CLI 插件 /（在允许 Remote-SSH 时）Remote-SSH 的目录补齐 `"remote-debugging-port": "0"`；
 * - 关闭（如用户关闭 `autoConfigureLaunch`）时安全剥离受管 `"0"` 端口，保留用户自定义端口与 JSONC 注释；
 * - 与 Antigravity IDE / Desktop 状态分离，避免误触发桌面端重拉横幅。
 *
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   homeDir?: string,
 *   enabled?: boolean,
 *   enableRemoteSsh?: boolean,
 *   platform?: string,
 *   fsOps?: object|null,
 * }} [options]
 */
export function ensureVsCodeRemoteDebuggingArgv({
  env = process.env,
  homeDir = homedir(),
  enabled = true,
  enableRemoteSsh = true,
  stripUnsupported = false,
  platform = process.platform,
  fsOps = null,
} = {}) {
  let updated = false;
  let removed = false;
  let alreadyConfigured = false;
  const results = [];
  for (const variant of VSCODE_HOST_VARIANTS) {
    const root = join(homeDir, variant.rootName);
    const supported = enabled
      ? hasVsCodeAntigravitySupport(root, env, homeDir, fsOps, { enableRemoteSsh, platform })
      : false;
    if (enabled && !supported) {
      if (!stripUnsupported) {
        continue;
      }
      const stripRes = patchSingleHostArgvFile(join(root, 'argv.json'), {
        enabled: false,
        createDir: false,
        missingReason: 'vscode_dir_missing',
      });
      results.push(stripRes);
      if (stripRes.updated) updated = true;
      if (stripRes.removed) removed = true;
      continue;
    }
    const res = patchSingleHostArgvFile(join(root, 'argv.json'), {
      enabled,
      createDir: false,
      missingReason: 'vscode_dir_missing',
    });
    results.push(res);
    if (res.updated) updated = true;
    if (res.removed) removed = true;
    if (res.alreadyConfigured) alreadyConfigured = true;
  }
  return {
    checked: results.length > 0,
    updated,
    removed,
    alreadyConfigured,
    results,
  };
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
const LOOPBACK_WS_URL_RE = /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//i;
const SWARM_BOARD_TARGET_URL_RE = /^plugin:\/\/swarm--swarm_board-/i;

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
  if (!LOOPBACK_WS_URL_RE.test(wsUrl)) {
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

const ALLOWED_IDE_CHAT_EXTENSION_ID_RE = /(?:antigravity|codeium|jetski|gemini)/i;

function hasStrongIdeChatSignal(rawUrl, lsAddr = '') {
  const url = String(rawUrl || '').trim();
  if (!url) return false;
  if (/[?&]extension(?:View|Variant)=/i.test(url)) {
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
 * 判断 CDP 目标是否为 Antigravity IDE 内嵌扩展聊天视图（OOPIF `iframe` / `webview`），
 * 严格限定本机回环地址并排除顶层 `page` 目标，校验 `extensionView`/`extensionVariant` 参数、`/c/<uuid>` 路由或已发现的 LS Hub 端口。
 *
 * @param {object} target
 * @param {string} [lsAddr='']
 * @returns {boolean}
 */
export function isIdeExtensionChatTarget(target, lsAddr = '') {
  if (!target || typeof target !== 'object') return false;
  if (isAntigravityMainPageTarget(target)) return false;
  const type = String(target.type || '').trim().toLowerCase();
  if (type !== 'iframe' && type !== 'webview') return false;
  const url = String(target.url || '').trim();
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+(?:\/|$)/i.test(url)) {
    return false;
  }
  if (hasStrongIdeChatSignal(url, lsAddr)) {
    return true;
  }
  if (
    /\/c\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:[/?#]|$)/i.test(url)
  ) {
    return true;
  }
  return false;
}

/**
 * 判断 CDP 目标是否为 Antigravity 内置 Swarm 协作面板子页面（`plugin://swarm--swarm_board-*`）。
 * 该目标仅参与宿主 UI 汉化与未翻译词条采集，绝不挂载悬浮胶囊或上下文窗口 Hook。
 *
 * @param {object} target
 * @returns {boolean}
 */
export function isSwarmBoardTarget(target) {
  if (!target || typeof target !== 'object') return false;
  if (isAntigravityMainPageTarget(target)) return false;
  const type = String(target.type || '').trim().toLowerCase();
  if (type !== 'iframe' && type !== 'webview') return false;
  const url = String(target.url || '').trim();
  return SWARM_BOARD_TARGET_URL_RE.test(url);
}

/**
 * 从某调试端口 `/json/list` 原始目标中提取内置 Swarm 协作面板的本机回环 CDP WebSocket 地址列表。
 *
 * @param {Array<object>} rawTargets
 * @param {number} [cdpPort=0]
 * @returns {Array<string>}
 */
export function collectSwarmBoardDebuggerUrls(rawTargets, cdpPort = 0) {
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) return [];
  const port = Number(cdpPort || 0);
  const urls = [];
  const seen = new Set();
  for (const t of rawTargets) {
    if (!isSwarmBoardTarget(t)) continue;
    const rawWs = String(t.webSocketDebuggerUrl || '').trim();
    let wsUrl = '';
    if (LOOPBACK_WS_URL_RE.test(rawWs)) {
      wsUrl = rawWs;
    } else if (port > 0 && t.id) {
      wsUrl = `ws://127.0.0.1:${port}/devtools/page/${encodeURIComponent(String(t.id))}`;
    }
    if (wsUrl && !seen.has(wsUrl)) {
      seen.add(wsUrl);
      urls.push(wsUrl);
    }
  }
  return urls;
}

/**
 * 将同一调试端口下的扩展聊天子 iframe 会话路由与可注入聊天目标（按 `parentId` 树隔离 + 扩展 Webview 白名单校验）
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
    let ancestorRemoteAuthority = '';
    let isRejectedExtensionSubframe = false;
    let curId = String(t.parentId || '').trim();
    const visited = new Set();
    while (curId && !visited.has(curId)) {
      visited.add(curId);
      if (mainIdeIds.has(curId)) {
        matchedMainId = curId;
        break;
      }
      const parentTarget = byId.get(curId);
      const parentUrl = String(parentTarget?.url || '');
      const extIdMatch = parentUrl.match(/[?&]extensionId=([^&#?\s]+)/i);
      if (extIdMatch) {
        let extId = extIdMatch[1];
        try {
          extId = decodeURIComponent(extId);
        } catch {
          // 保留原始片段继续白名单校验
        }
        if (!ALLOWED_IDE_CHAT_EXTENSION_ID_RE.test(extId)) {
          isRejectedExtensionSubframe = true;
          break;
        }
      }
      if (!ancestorRemoteAuthority && parentUrl) {
        try {
          const parsedParentUrl = new URL(parentUrl);
          const auth = String(parsedParentUrl.searchParams.get('remoteAuthority') || '').trim();
          if (auth) ancestorRemoteAuthority = auth;
        } catch {
          // 忽略非标准父级 URL
        }
      }
      curId = parentTarget ? String(parentTarget.parentId || '').trim() : '';
    }
    if (isRejectedExtensionSubframe) continue;

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
      let remoteKind = '';
      try {
        const parsedChatUrl = new URL(rawUrl);
        origin = parsedChatUrl.origin;
        remoteKind = String(parsedChatUrl.searchParams.get('remoteKind') || '').trim().toLowerCase();
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
        remoteKind,
        remoteAuthority: ancestorRemoteAuthority,
        cascadeId: cascadeId || (fallbackUuidMatch ? fallbackUuidMatch[1] : ''),
        webSocketDebuggerUrl: wsUrl,
        isIdeChatFrame: true,
      };
      if (matchedMainId) {
        if (!chatTargetsByMainId.has(matchedMainId)) {
          chatTargetsByMainId.set(matchedMainId, []);
        }
        chatTargetsByMainId.get(matchedMainId).push(chatEntry);
      } else if (hasStrongIdeChatSignal(rawUrl, lsAddr)) {
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

const NON_SSH_IDE_REMOTE_PREFIX_RE =
  /^(?:vscode-remote:\/\/)?(?:wsl|dev-container|attached-container|codespaces|tunnel|k8s-container)\+/i;
const NON_SSH_IDE_TITLE_BADGE_RE =
  /\[(?:WSL|Dev Container|Container|Codespaces|Tunnel):\s*[^\]\r\n]+\]/i;

/**
 * 从 Antigravity IDE `workbench.html?config=...` 静态 URL 中提取远端权威域标识（无需等待 CDP 执行）。
 *
 * @param {unknown} rawUrl
 * @returns {{ rawAuthority: string, folderUri: string }}
 */
export function extractIdeWorkbenchUrlConfig(rawUrl) {
  const urlStr = String(rawUrl || '').trim();
  if (!urlStr) return { rawAuthority: '', folderUri: '' };
  try {
    const parsed = new URL(urlStr);
    const rawConfig = parsed.searchParams.get('config');
    if (!rawConfig) return { rawAuthority: '', folderUri: '' };
    const cfg = JSON.parse(rawConfig);
    if (!cfg || typeof cfg !== 'object') return { rawAuthority: '', folderUri: '' };
    const rawAuthority = String(cfg.remoteAuthority || '').trim();
    const folderUri = String(
      cfg.folderUri ||
        cfg.workspaceUri ||
        (typeof cfg.workspace === 'object' && cfg.workspace
          ? cfg.workspace.configPath || cfg.workspace.uri || ''
          : '') ||
        ''
    ).trim();
    return { rawAuthority, folderUri };
  } catch {
    return { rawAuthority: '', folderUri: '' };
  }
}

/**
 * 依据三级优先级严格区分本地窗口与 SSH / 远端窗口（同时覆盖 Desktop SSH 与 IDE Remote-SSH），
 * 避免 2.33.0+ 无 `csrfToken` 或无 `hub_*.json` 时误判本地窗口，并严格排除 WSL / Dev Container。
 *
 * @param {{
 *   target: object,
 *   probedInfo?: { origin?: string, csrfToken?: string, observedCsrfToken?: string, appConfig?: object, title?: string, ideRemoteAuthority?: string, ideFolderUri?: string }|null,
 *   localHubInfo?: { allPorts?: Set<number>, httpsPorts?: Set<number>, csrfTokens?: Set<string> }|null,
 *   confirmedLocalPorts?: Set<number>|null,
 *   enableRemoteSsh?: boolean,
 * }} params
 */
export function pickPrimaryIdeChatTarget(target) {
  const list = Array.isArray(target?.ideChatTargets) ? target.ideChatTargets : [];
  if (list.length === 0) return null;
  const remoteChat = list.find(
    (c) =>
      (c?.remoteKind && c.remoteKind !== 'none') ||
      Boolean(String(c?.remoteAuthority || '').trim())
  );
  if (remoteChat) return remoteChat;
  return list.find((c) => c?.webSocketDebuggerUrl || c?.origin) || list[0];
}

export function classifyWindowTargetEndpoint({
  target,
  probedInfo = null,
  localHubInfo = null,
  confirmedLocalPorts = null,
  enableRemoteSsh = true,
}) {
  if (!target) {
    return { isRemote: false, endpointId: LOCAL_ENDPOINT_ID, label: '', origin: '', csrfToken: '' };
  }

  if (target.isIdeWorkbench) {
    const primaryChat = pickPrimaryIdeChatTarget(target);
    const urlCfg = extractIdeWorkbenchUrlConfig(target.url);
    const candidates = [
      String(probedInfo?.ideRemoteAuthority || '').trim(),
      String(probedInfo?.ideFolderUri || '').trim(),
      String(probedInfo?.appConfig?.remoteAuthority || '').trim(),
      urlCfg.rawAuthority,
      urlCfg.folderUri,
      String(primaryChat?.remoteAuthority || '').trim(),
    ].filter(Boolean);
    const ideTitle = String(probedInfo?.title || target.title || '').trim();

    for (const cand of candidates) {
      if (NON_SSH_IDE_REMOTE_PREFIX_RE.test(cand)) {
        return {
          isRemote: false,
          isNonSshRemote: true,
          endpointId: LOCAL_ENDPOINT_ID,
          label: '',
          origin: '',
          csrfToken: '',
        };
      }
      if (!enableRemoteSsh) continue;
      const parsedAuth = parseIdeRemoteAuthority(cand);
      if (parsedAuth.isSshRemote) {
        return {
          isRemote: true,
          isIdeRemoteSsh: true,
          parsedIdeAuthority: parsedAuth,
          origin: '',
          originPort: 0,
          csrfToken: '',
          stableHostKey: parsedAuth.stableHostKey,
          hostLabel: parsedAuth.displayLabel,
        };
      }
    }

    if (NON_SSH_IDE_TITLE_BADGE_RE.test(ideTitle)) {
      return {
        isRemote: false,
        isNonSshRemote: true,
        endpointId: LOCAL_ENDPOINT_ID,
        label: '',
        origin: '',
        csrfToken: '',
      };
    }

    if (!enableRemoteSsh) {
      return { isRemote: false, endpointId: LOCAL_ENDPOINT_ID, label: '', origin: '', csrfToken: '' };
    }

    const sshTitleMatch = ideTitle.match(/\[SSH:\s*([^\]\r\n]+)\]/i);
    if (sshTitleMatch && sshTitleMatch[1]) {
      const parsedFromTitle = parseIdeRemoteAuthority(`ssh-remote+${sshTitleMatch[1].trim()}`);
      if (parsedFromTitle.isSshRemote) {
        return {
          isRemote: true,
          isIdeRemoteSsh: true,
          parsedIdeAuthority: parsedFromTitle,
          origin: '',
          originPort: 0,
          csrfToken: '',
          stableHostKey: parsedFromTitle.stableHostKey,
          hostLabel: parsedFromTitle.displayLabel,
        };
      }
    }

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
    dataDir = '',
    hostRole: explicitHostRole = '',
    autoConfigureIdeArgv = options?.env === undefined && options?.homeDir === undefined,
    launcherRecheckIntervalMs = 15 * 60 * 1000,
    launcherExecFileFn = null,
    launcherFsOps = null,
    allowDesktopLauncherInTest = false,
    existsHostFn = existsSync,
    WebSocketImpl = globalThis.WebSocket,
    bindRemoteRpcInvoker = false,
    getLocalHubPortsFn = getLocalHubPorts,
    cloudCodeProxy = null,
    manageCloudCodeProxy = false,
    resolveLocalContextRulesFn = null,
    hasOtherHostAliveFn = null,
    portProberOptions = null,
    ideRemoteSshOptions = null,
    activeTransientMissTolerance = 2,
    overlayHeartbeatGraceMs = 15_000,
    getHostI18nDescriptorFn =
      options?.env === undefined && options?.homeDir === undefined
        ? getHostI18nBridgeDescriptor
        : () => ({ active: false, revision: '', getPayload: null }),
  } = options || {};

  const activeCloudCodeProxy =
    cloudCodeProxy || (manageCloudCodeProxy ? getDefaultCloudCodeProxy() : null);
  const portProber = createDevToolsPortProber({
    ...(portProberOptions || {}),
    fsOps: {
      existsSync: portProberOptions?.fsOps?.existsSync || existsSync,
      readFileSync: portProberOptions?.fsOps?.readFileSync || readFileSync,
      statSync: portProberOptions?.fsOps?.statSync || statSync,
    },
  });
  const ideSshCoordinator = createIdeRemoteSshCoordinator(ideRemoteSshOptions || {});
  const localVsCodeSupportCache = createLocalVsCodeSupportCache();

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
  let routePingTimer = null;
  let stopped = false;
  let stopping = false;
  let syncInFlight = null;
  let pendingSyncOpts = null;
  let pendingSyncPromise = null;
  let hadInjectedTargets = false;
  const injectedChatFrameWsUrls = new Set();
  const rememberedVsCodePortFiles = new Set();
  const appliedContextWindowWsUrls = new Set();
  const appliedHostI18nWsUrls = new Set();
  let hadRouteWatchers = false;
  let activeIdeSshHostKeys = new Set();
  let cdpFallbackActive = false;
  let lastLauncherProvisionAtMs = 0;
  let lastVsCodeLauncherProvisionAtMs = 0;
  let vsCodeLauncherProvisioned = false;
  let hostLauncherPromise = null;
  let argvUpdatedThisBoot = false;
  let argvConfigured = false;
  let launcherConfigured = false;
  let hasReadOnlyShortcuts = false;
  let hasReadOnlySplit = false;
  let hasReadOnlyDesktop = false;
  let hasReadOnlyIde = false;
  let managedLaunchersActive = false;
  let lastObservedUserAutoLaunch = null;
  let lastStalePortDetected = false;
  const desktopExecInfo = resolveDesktopHostExecutable({
    env,
    platform,
    homeDir,
    existsFn: existsHostFn,
    preferredProduct: 'desktop',
  });
  const ideExecInfo = resolveDesktopHostExecutable({
    env,
    platform,
    homeDir,
    existsFn: existsHostFn,
    preferredProduct: 'ide',
  });
  const hostExecInfo = desktopExecInfo.found ? desktopExecInfo : ideExecInfo;
  let lastTargetProduct =
    !desktopExecInfo.found && ideExecInfo.found ? 'ide' : 'auto';
  // Windows / macOS / Linux 均支持从运行中宿主进程动态反查路径（含自定义盘符与 AppImage），自定义安装路径亦可一键重拉
  const canRelaunch = Boolean(
    hostExecInfo.found ||
      ((platform === 'win32' || platform === 'darwin' || platform === 'linux') &&
        options?.existsHostFn === undefined)
  );
  function resolveEffectiveReadOnlyShortcuts(targetProd = lastTargetProduct) {
    if (!hasReadOnlyShortcuts) return false;
    if (hasReadOnlySplit) {
      if (targetProd === 'ide') return hasReadOnlyIde;
      if (targetProd === 'desktop') return hasReadOnlyDesktop;
    }
    return hasReadOnlyShortcuts;
  }
  function readMacWrapperSnapshot() {
    if (platform !== 'darwin') {
      return { exists: false, desktopExists: false, ideExists: false, paths: [] };
    }
    const snap = inspectMacOsLaunchWrapperStatus({
      platform,
      homeDir,
      existsFn: launcherFsOps?.existsFn || existsHostFn,
      readFn: launcherFsOps?.readFn || readFileSync,
      ...(launcherFsOps?.lstatFn ? { lstatFn: launcherFsOps.lstatFn } : {}),
    });
    return {
      exists: Boolean(snap.exists),
      desktopExists: Boolean(snap.desktopExists),
      ideExists: Boolean(snap.ideExists),
      paths: snap.paths || [],
    };
  }
  function computeLeaseSignature(st, themeObj) {
    const hostThemeSig = getHostThemeSignature(themeObj);
    return `${st.state}:${st.aliveCount}:${st.targets}:${st.argvUpdatedThisBoot ? 1 : 0}:${st.launcherConfigured ? 1 : 0}:${st.hasReadOnlyShortcuts ? 1 : 0}:${st.stalePortDetected ? 1 : 0}:${st.targetProduct || 'auto'}:${st.canRelaunch ? 1 : 0}:${hostThemeSig}`;
  }
  function resolvePreferredTargetProduct(probeReport) {
    const staleList = (Array.isArray(probeReport?.staleProducts) ? probeReport.staleProducts : []).filter(
      (p) => p !== 'vscode'
    );
    const liveList = (Array.isArray(probeReport?.liveProducts) ? probeReport.liveProducts : []).filter(
      (p) => p !== 'vscode'
    );
    if (staleList.includes('ide') && !staleList.includes('desktop')) return 'ide';
    if (staleList.includes('desktop') && !staleList.includes('ide')) return 'desktop';
    if (liveList.includes('desktop') && !liveList.includes('ide') && (ideExecInfo.found || argvConfigured)) {
      return 'ide';
    }
    if (liveList.includes('ide') && !liveList.includes('desktop') && desktopExecInfo.found) {
      return 'desktop';
    }
    if (!desktopExecInfo.found && (ideExecInfo.found || argvConfigured)) return 'ide';
    if (desktopExecInfo.found && !ideExecInfo.found && !argvConfigured) return 'desktop';
    return 'auto';
  }
  const hostRole =
    explicitHostRole === 'sidecar' || explicitHostRole === 'daemon'
      ? explicitHostRole
      : env?.USAGE_MONITOR_HOST_PPID
        ? 'daemon'
        : 'sidecar';
  const effectiveDataDir = String(dataDir || '').trim();
  const LEASE_PEER_TTL_MS = 30_000;
  const LEASE_PEER_HEARTBEAT_MS = 10_000;
  const MAX_LEASE_PEERS = 32;
  let lastPeerTouchMs = 0;

  function resolveLeaseRole(lease) {
    if (!lease || typeof lease !== 'object') return '';
    if (lease.role === 'sidecar' || lease.role === 'daemon') return lease.role;
    const pidKey = String(Number(lease.pid || 0));
    const peerRole = lease?.peers?.[pidKey]?.role;
    if (peerRole === 'sidecar' || peerRole === 'daemon') return peerRole;
    return '';
  }

  function canPreemptExternalLeader(lease) {
    return hostRole === 'sidecar' && resolveLeaseRole(lease) === 'daemon';
  }

  function pruneLeasePeers(rawPeers, now = Date.now(), { excludePid = 0 } = {}) {
    if (!rawPeers || typeof rawPeers !== 'object') return {};
    const valid = [];
    for (const [key, entry] of Object.entries(rawPeers)) {
      const pid = Number(key);
      if (!Number.isInteger(pid) || pid <= 0 || pid === excludePid) continue;
      const updatedAtMs = Number(entry?.updatedAtMs || 0);
      const ageMs = now - updatedAtMs;
      if (!(updatedAtMs > 0 && ageMs >= 0 && ageMs < LEASE_PEER_TTL_MS)) continue;
      if (!isPidAlive(pid)) continue;
      valid.push([
        String(pid),
        {
          role: entry?.role === 'daemon' ? 'daemon' : 'sidecar',
          updatedAtMs,
        },
      ]);
    }
    if (valid.length > MAX_LEASE_PEERS) {
      valid.sort((a, b) => b[1].updatedAtMs - a[1].updatedAtMs);
      valid.length = MAX_LEASE_PEERS;
    }
    return Object.fromEntries(valid);
  }

  function buildMergedLeasePeers(baseLease = null, { includeSelf = true, now = Date.now() } = {}) {
    const diskLease = leaseFilePath ? loadJson(leaseFilePath, null) : null;
    const mergedRaw = {
      ...(baseLease?.peers && typeof baseLease.peers === 'object' ? baseLease.peers : {}),
      ...(diskLease?.peers && typeof diskLease.peers === 'object' ? diskLease.peers : {}),
    };
    const peers = pruneLeasePeers(mergedRaw, now, { excludePid: includeSelf ? 0 : process.pid });
    if (includeSelf) {
      peers[String(process.pid)] = { role: hostRole, updatedAtMs: now };
      lastPeerTouchMs = now;
    }
    return peers;
  }

  function saveLeaseWithPeers(payload, { includeSelf = true, baseLease = null } = {}) {
    if (!leaseFilePath) return;
    const now = Date.now();
    const diskLease = loadJson(leaseFilePath, null);
    const peers = buildMergedLeasePeers(baseLease, { includeSelf, now });
    const isSelfLeaderPayload = Number(payload?.pid || 0) === process.pid;
    const resolvedRole = isSelfLeaderPayload
      ? hostRole
      : resolveLeaseRole(payload) || resolveLeaseRole(baseLease) || resolveLeaseRole(diskLease);
    const sidecarDataDir =
      (hostRole === 'sidecar' && effectiveDataDir ? effectiveDataDir : '') ||
      String(
        payload?.sidecarDataDir || baseLease?.sidecarDataDir || diskLease?.sidecarDataDir || ''
      ).trim();
    saveJson(leaseFilePath, {
      ...payload,
      ...(resolvedRole ? { role: resolvedRole } : {}),
      ...(sidecarDataDir ? { sidecarDataDir } : {}),
      peers,
    });
  }

  function touchSelfPeerInLease({ force = false } = {}) {
    if (!leaseFilePath) return;
    const now = Date.now();
    const curLease = loadJson(leaseFilePath, null);
    const selfEntry = curLease?.peers?.[String(process.pid)];
    const selfAgeMs = selfEntry ? now - Number(selfEntry.updatedAtMs || 0) : Infinity;
    if (!force && selfAgeMs >= 0 && selfAgeMs < LEASE_PEER_HEARTBEAT_MS && now - lastPeerTouchMs < LEASE_PEER_HEARTBEAT_MS) {
      return;
    }
    try {
      saveLeaseWithPeers(curLease && typeof curLease === 'object' ? curLease : { pid: 0, updatedAtMs: 0 }, {
        includeSelf: true,
        baseLease: curLease,
      });
    } catch {
      // 忽略租约心跳写入失败
    }
  }

  function hasOtherLiveUsageMonitorHost(currentLease = null) {
    const lease = currentLease ?? (leaseFilePath ? loadJson(leaseFilePath, null) : null);
    const leasePid = Number(lease?.pid || 0);
    if (leasePid > 0 && leasePid !== process.pid && isPidAlive(leasePid)) {
      return true;
    }
    if (typeof hasOtherHostAliveFn === 'function') {
      try {
        return Boolean(hasOtherHostAliveFn());
      } catch {
        return false;
      }
    }
    if (!lease || typeof lease !== 'object') return false;
    const liveOtherPeers = pruneLeasePeers(lease.peers, Date.now(), { excludePid: process.pid });
    return Object.keys(liveOtherPeers).length > 0;
  }

  function hasActiveExternalLeaderLease(curBundleVersion = '') {
    if (!leaseFilePath) return false;
    const lease = loadJson(leaseFilePath, null);
    const leasePid = Number(lease?.pid || 0);
    const leaseAgeMs = Date.now() - Number(lease?.updatedAtMs || 0);
    if (!(leasePid > 0 && leasePid !== process.pid && leaseAgeMs >= 0 && leaseAgeMs < 9000 && isPidAlive(leasePid))) {
      return false;
    }
    const myVerStr = String(curBundleVersion || getBundleVersionFn() || '');
    const leaseVerStr = String(lease?.bundleVersion || '');
    const leaseVerNum = Number(leaseVerStr) || 0;
    const myVerNum = Number(myVerStr) || 0;
    if (leaseVerNum > 0 && myVerNum > 0 && leaseVerNum > myVerNum) {
      return true;
    }
    if (canPreemptExternalLeader(lease)) {
      return false;
    }
    if (leaseVerNum > 0 && myVerNum > 0) {
      return leaseVerNum >= myVerNum;
    }
    return Boolean(leaseVerStr && leaseVerStr === myVerStr);
  }
  let lastPersistedLeaseSig = '';
  const initialMacWrapper = readMacWrapperSnapshot();
  let lastBridgeStatus = {
    state: 'pending',
    enabled: true,
    aliveCount: 0,
    targets: 0,
    argvUpdatedThisBoot: false,
    argvConfigured: false,
    launcherConfigured: false,
    hasReadOnlyShortcuts: false,
    stalePortDetected: false,
    targetProduct: lastTargetProduct,
    macWrapperExists: initialMacWrapper.exists,
    macDesktopWrapperExists: initialMacWrapper.desktopExists,
    macIdeWrapperExists: initialMacWrapper.ideExists,
    macWrapperPaths: initialMacWrapper.paths,
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
  let lastDetectedHostTheme = null;
  let lastPassiveThemeProbeMs = 0;
  let lastBridgeHttpActivityMs = 0;
  let consecutiveActiveCdpMisses = 0;
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
            data: parsedBody,
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

        if (method === 'POST' && parsedUrl.pathname === BRIDGE_ROUTE_PING_PATH) {
          const pingToken = String(req.headers['x-usage-monitor-token'] || '');
          if (!verifyBridgeToken(pingToken, bridgeToken, crypto.timingSafeEqual)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid bridge token' }));
            return;
          }
          lastBridgeHttpActivityMs = Date.now();
          res.writeHead(204);
          res.end();
          scheduleRoutePingSync(80);
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
        lastBridgeHttpActivityMs = Date.now();

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
      if (leaseFilePath && bridgePort > 0 && !hasActiveExternalLeaderLease()) {
        saveLeaseWithPeers({
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

  function scheduleRoutePingSync(delayMs = 80) {
    if (stopped || stopping) return;
    if (routePingTimer) clearTimeout(routePingTimer);
    routePingTimer = setTimeout(() => {
      routePingTimer = null;
      if (!stopped && !stopping) {
        void syncAllWindows().catch(() => {});
      }
    }, Math.max(20, Number(delayMs) || 80));
    routePingTimer.unref?.();
  }

  function findActiveDevToolsPorts({ includeVsCode = true } = {}) {
    const curSettings = getSettingsFn() || {};
    const remoteSshEnabled = normalizeEnableRemoteSshTelemetry(
      curSettings.enableRemoteSshTelemetry
    );
    const primaryCandidates = resolveDevToolsPortCandidates(env, platform, homeDir);
    const vsCodeCandidates = includeVsCode
      ? Array.from(
          new Set([
            ...resolveVsCodeDevToolsPortCandidates(env, platform, homeDir, null, {
              enableRemoteSsh: remoteSshEnabled,
            }),
            ...rememberedVsCodePortFiles,
          ])
        )
      : [];
    const ports = [];
    const seen = new Set();
    for (const filePath of [...primaryCandidates, ...vsCodeCandidates]) {
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

  async function listMainWindowTargets(cdpPort, { isVsCodeHost = false } = {}) {
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
    if (!Array.isArray(parsed)) {
      return { mainTargets: [], hostI18nExtraWsUrls: [] };
    }
    const associated = associateIdeIframeRoutes(
      parsed,
      parsed.filter(isAntigravityMainPageTarget),
      { lsAddr: lsRuntimeEndpoint.addr, cdpPort }
    );
    const hostI18nExtraWsUrls = collectSwarmBoardDebuggerUrls(parsed, cdpPort);
    for (const mainT of associated) {
      mainT.isVsCodeHost = Boolean(isVsCodeHost || isVsCodeHostUrl(mainT?.url));
      mainT.vsCodeVariant = mainT.isVsCodeHost ? detectVsCodeVariantFromUrl(mainT?.url) : '';
      if (Array.isArray(mainT.ideChatTargets)) {
        for (const ct of mainT.ideChatTargets) {
          ct.isVsCodeHost = mainT.isVsCodeHost;
          ct.vsCodeVariant = mainT.vsCodeVariant;
          if (ct.origin && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/i.test(ct.origin)) {
            allowedDynamicOrigins.add(ct.origin);
          }
        }
      }
    }
    return { mainTargets: associated, hostI18nExtraWsUrls };
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

  function collectHostI18nTargetWsUrls(
    mainTargets,
    hostI18nExtraWsUrls = [],
    { skipDisabledOverlay = false, appliedWsUrls = null, skippedOut = null } = {}
  ) {
    const urls = new Set();
    for (const target of mainTargets) {
      if (target.isIdeWorkbench) continue;
      const wsUrl = String(target.webSocketDebuggerUrl || '').trim();
      if (wsUrl) urls.add(wsUrl);
    }
    for (const target of mainTargets) {
      if (!Array.isArray(target?.ideChatTargets)) continue;
      for (const ct of target.ideChatTargets) {
        const chatUrl = String(ct?.webSocketDebuggerUrl || '').trim();
        if (!chatUrl) continue;
        if (skipDisabledOverlay && target.skipOverlayInjection) {
          if (appliedWsUrls?.has?.(chatUrl)) {
            skippedOut?.add?.(chatUrl);
          }
        } else {
          urls.add(chatUrl);
        }
      }
    }
    for (const extraUrl of hostI18nExtraWsUrls) {
      const wsUrl = String(extraUrl || '').trim();
      if (wsUrl) urls.add(wsUrl);
    }
    return urls;
  }

  async function collectAllMainWindowTargets(cdpPorts, vsCodePortsSet = null) {
    const vsSet = vsCodePortsSet instanceof Set ? vsCodePortsSet : new Set();
    const settled = await Promise.allSettled(
      cdpPorts.map((p) => listMainWindowTargets(p, { isVsCodeHost: vsSet.has(p) }))
    );
    let reachableCount = 0;
    const merged = [];
    const seenWs = new Set();
    const mergedHostI18nExtraWs = [];
    const seenHostI18nExtraWs = new Set();
    for (const item of settled) {
      if (item.status === 'fulfilled') {
        reachableCount += 1;
        const mainTargets = Array.isArray(item.value?.mainTargets) ? item.value.mainTargets : [];
        for (const target of mainTargets) {
          const wsKey = String(target.webSocketDebuggerUrl || '');
          if (wsKey && !seenWs.has(wsKey)) {
            seenWs.add(wsKey);
            merged.push(target);
          }
        }
        const extraUrls = Array.isArray(item.value?.hostI18nExtraWsUrls)
          ? item.value.hostI18nExtraWsUrls
          : [];
        for (const extraWs of extraUrls) {
          if (extraWs && !seenHostI18nExtraWs.has(extraWs)) {
            seenHostI18nExtraWs.add(extraWs);
            mergedHostI18nExtraWs.push(extraWs);
          }
        }
      }
    }
    return { reachableCount, targets: merged, hostI18nExtraWsUrls: mergedHostI18nExtraWs };
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
    const macSnap = readMacWrapperSnapshot();
    const targetProd = lastTargetProduct || 'auto';
    const effectiveReadOnly = resolveEffectiveReadOnlyShortcuts(targetProd);
    lastBridgeStatus = {
      state: nextState,
      enabled: Boolean(enabled),
      aliveCount: Number(aliveCount || 0),
      targets: Number(targets || 0),
      argvUpdatedThisBoot: Boolean(argvUpdatedThisBoot),
      argvConfigured: Boolean(argvConfigured || launcherConfigured),
      launcherConfigured: Boolean(launcherConfigured || argvConfigured),
      hasReadOnlyShortcuts: Boolean(effectiveReadOnly),
      stalePortDetected: Boolean(lastStalePortDetected),
      targetProduct: targetProd,
      macWrapperExists: macSnap.exists,
      macDesktopWrapperExists: macSnap.desktopExists,
      macIdeWrapperExists: macSnap.ideExists,
      macWrapperPaths: macSnap.paths,
      canRelaunch: Boolean(canRelaunch),
      updatedAtMs: Date.now(),
    };
    if (leasedBySelf && leaseFilePath) {
      const sig = computeLeaseSignature(lastBridgeStatus, lastDetectedHostTheme);
      if (sig !== lastPersistedLeaseSig) {
        lastPersistedLeaseSig = sig;
        saveLeaseWithPeers(
          {
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
            stalePortDetected: lastBridgeStatus.stalePortDetected,
            targetProduct: lastBridgeStatus.targetProduct,
            canRelaunch: lastBridgeStatus.canRelaunch,
            ...(lastDetectedHostTheme ? { hostTheme: lastDetectedHostTheme } : {}),
            updatedAtMs: Date.now(),
          },
          { baseLease: prevLease }
        );
      }
    }
  }

  function provisionHostLaunchersOnce({ fastCheckIfActive = false, targetEnabled = true } = {}) {
    if (hostLauncherPromise) return hostLauncherPromise;
    hostLauncherPromise = (async () => {
      const ideRes = ensureIdeRemoteDebuggingArgv({ env, homeDir, enabled: targetEnabled });
      const desktopRes = await ensureDesktopLaunchEntriesConfigured({
        enabled: targetEnabled,
        fastCheckIfActive,
        product: 'both',
        env,
        platform,
        homeDir,
        execFileFn: launcherExecFileFn,
        fsOps: launcherFsOps,
        allowInTest: allowDesktopLauncherInTest,
      });
      if (targetEnabled) {
        managedLaunchersActive = true;
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
          hasReadOnlySplit = Boolean(desktopRes.readOnlySplitByProduct);
          hasReadOnlyDesktop = Array.isArray(desktopRes.readOnlyDesktopPaths)
            ? desktopRes.readOnlyDesktopPaths.length > 0
            : false;
          hasReadOnlyIde = Array.isArray(desktopRes.readOnlyIdePaths)
            ? desktopRes.readOnlyIdePaths.length > 0
            : false;
        }
        lastLauncherProvisionAtMs = Date.now();
      } else {
        managedLaunchersActive = false;
        argvConfigured = Boolean(ideRes.alreadyConfigured);
        launcherConfigured = false;
        hasReadOnlyShortcuts = false;
        hasReadOnlySplit = false;
        hasReadOnlyDesktop = false;
        hasReadOnlyIde = false;
        lastLauncherProvisionAtMs = 0;
      }
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
    if (stopped || stopping) return { ok: false, reason: 'stopped' };
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
    const vsCodeMountMode = normalizeVsCodeMountMode(curSettings.vsCodeMountMode);
    const enabled = Boolean(curSettings.enableWindowOverlay !== false && mountMode !== 'sidebar');
    const remoteSshEnabled = normalizeEnableRemoteSshTelemetry(
      curSettings.enableRemoteSshTelemetry
    );
    const localVsCodeSupport = localVsCodeSupportCache.getSnapshot({
      env,
      platform,
      homeDir,
      enableRemoteSsh: remoteSshEnabled,
    });
    const hasPendingVsCodeCleanup = Boolean(
      rememberedVsCodePortFiles.size > 0 &&
        (hadInjectedTargets ||
          injectedChatFrameWsUrls.size > 0 ||
          hadRouteWatchers ||
          appliedContextWindowWsUrls.size > 0 ||
          appliedHostI18nWsUrls.size > 0)
    );
    const contextWindowAllowed = isContextWindowFeatureActive(curSettings);
    const contextWindows = contextWindowAllowed ? curSettings.modelContextWindows || {} : {};
    const hasContextWindows = Object.keys(contextWindows).length > 0;
    const ctxMainEnabled = contextWindowAllowed && curSettings.contextWindowMainEnabled !== false;
    const ctxSwarmEnabled = contextWindowAllowed && curSettings.contextWindowSwarmEnabled === true;
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
    const antigravityNeedsCdp = Boolean(enabled || needsMainCdpContext || needsHostI18n);

    let leasedBySelf = false;
    let currentLease = null;
    if (
      (enabled ||
        localVsCodeSupport.hasAnySupport ||
        hasPendingVsCodeCleanup ||
        needsAnyCdpContext ||
        needsCloudCodeProxy ||
        needsHostI18n) &&
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
        if (
          (leaseVerNum === myVerNum || String(lease?.bundleVersion || '') === bundleVersion) &&
          !canPreemptExternalLeader(lease)
        ) {
          const hasLeaseConfiguredFlag =
            typeof lease?.launcherConfigured === 'boolean' ||
            typeof lease?.argvConfigured === 'boolean';
          const mergedConfigured = hasLeaseConfiguredFlag
            ? Boolean(lease?.launcherConfigured || lease?.argvConfigured)
            : Boolean(launcherConfigured || argvConfigured);
          const macFollowerSnap = readMacWrapperSnapshot();
          lastBridgeStatus = {
            state: String(lease?.syncState || 'active'),
            enabled: Boolean(enabled),
            aliveCount: Number(lease?.aliveCount || 0),
            targets: Number(lease?.targets || 0),
            argvUpdatedThisBoot:
              typeof lease?.argvUpdatedThisBoot === 'boolean'
                ? lease.argvUpdatedThisBoot
                : Boolean(argvUpdatedThisBoot),
            argvConfigured: mergedConfigured,
            launcherConfigured: mergedConfigured,
            hasReadOnlyShortcuts:
              typeof lease?.hasReadOnlyShortcuts === 'boolean'
                ? lease.hasReadOnlyShortcuts
                : Boolean(resolveEffectiveReadOnlyShortcuts()),
            stalePortDetected:
              typeof lease?.stalePortDetected === 'boolean'
                ? lease.stalePortDetected
                : Boolean(lastStalePortDetected),
            targetProduct: String(lease?.targetProduct || lastTargetProduct || 'auto'),
            macWrapperExists: macFollowerSnap.exists,
            macDesktopWrapperExists: macFollowerSnap.desktopExists,
            macIdeWrapperExists: macFollowerSnap.ideExists,
            macWrapperPaths: macFollowerSnap.paths,
            canRelaunch: Boolean(lease?.canRelaunch ?? canRelaunch),
            updatedAtMs: Date.now(),
          };
          if (lease?.hostTheme) {
            const hydratedTheme = recordLiveCdpHostTheme(lease.hostTheme, { persist: false });
            if (hydratedTheme) lastDetectedHostTheme = hydratedTheme;
          }
          touchSelfPeerInLease();
          return { ok: true, enabled: true, reason: 'follower_yield', leaderPid: leasePid, injected: 0 };
        }
      }
      leasedBySelf = true;
      const mergedLauncherConfigured = Boolean(argvConfigured || launcherConfigured);
      const effectiveTopReadOnly = resolveEffectiveReadOnlyShortcuts();
      const topLeaseStatus = {
        state: lastBridgeStatus.state,
        aliveCount: lastBridgeStatus.aliveCount,
        targets: lastBridgeStatus.targets,
        argvUpdatedThisBoot: Boolean(argvUpdatedThisBoot),
        launcherConfigured: mergedLauncherConfigured,
        hasReadOnlyShortcuts: Boolean(effectiveTopReadOnly),
        stalePortDetected: Boolean(lastStalePortDetected),
        targetProduct: lastTargetProduct || 'auto',
        canRelaunch: Boolean(canRelaunch),
      };
      const topSig = computeLeaseSignature(topLeaseStatus, lastDetectedHostTheme);
      if (
        leasePid !== process.pid ||
        leaseAgeMs >= 3500 ||
        topSig !== lastPersistedLeaseSig ||
        !lastPersistedLeaseSig
      ) {
        lastPersistedLeaseSig = topSig;
        saveLeaseWithPeers(
          {
            pid: process.pid,
            bundleVersion,
            bridgePort: bridgePort > 0 ? bridgePort : Number(lease?.bridgePort || 0) || undefined,
            bridgeToken: bridgeToken || String(lease?.bridgeToken || '') || undefined,
            syncState: topLeaseStatus.state,
            aliveCount: topLeaseStatus.aliveCount,
            targets: topLeaseStatus.targets,
            argvUpdatedThisBoot: topLeaseStatus.argvUpdatedThisBoot,
            argvConfigured: mergedLauncherConfigured,
            launcherConfigured: mergedLauncherConfigured,
            hasReadOnlyShortcuts: topLeaseStatus.hasReadOnlyShortcuts,
            stalePortDetected: topLeaseStatus.stalePortDetected,
            targetProduct: topLeaseStatus.targetProduct,
            canRelaunch: topLeaseStatus.canRelaunch,
            ...(lastDetectedHostTheme ? { hostTheme: lastDetectedHostTheme } : {}),
            updatedAtMs: Date.now(),
          },
          { baseLease: lease }
        );
      }
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

    const userAutoLaunch = normalizeAutoConfigureLaunch(curSettings.autoConfigureLaunch);
    if (!remoteSshEnabled) {
      ideSshCoordinator.disposeAll();
    }
    const transitionedAutoLaunchOff = lastObservedUserAutoLaunch === true && !userAutoLaunch;
    lastObservedUserAutoLaunch = userAutoLaunch;
    if (
      autoConfigureIdeArgv &&
      !userAutoLaunch &&
      (transitionedAutoLaunchOff || managedLaunchersActive) &&
      !hostLauncherPromise
    ) {
      void provisionHostLaunchersOnce({ fastCheckIfActive: false, targetEnabled: false }).catch(
        () => {}
      );
    }
    if (autoConfigureIdeArgv) {
      if (
        (!userAutoLaunch || !localVsCodeSupport.hasAnySupport) &&
        (transitionedAutoLaunchOff || vsCodeLauncherProvisioned || lastVsCodeLauncherProvisionAtMs > 0)
      ) {
        ensureVsCodeRemoteDebuggingArgv({
          env,
          homeDir,
          enabled: false,
          enableRemoteSsh: false,
          platform,
        });
        vsCodeLauncherProvisioned = false;
        lastVsCodeLauncherProvisionAtMs = 0;
      } else if (
        userAutoLaunch &&
        localVsCodeSupport.hasAnySupport &&
        (lastVsCodeLauncherProvisionAtMs === 0 ||
          Date.now() - lastVsCodeLauncherProvisionAtMs >= launcherRecheckIntervalMs)
      ) {
        const vsArgvRes = ensureVsCodeRemoteDebuggingArgv({
          env,
          homeDir,
          enabled: true,
          enableRemoteSsh: remoteSshEnabled,
          stripUnsupported: vsCodeLauncherProvisioned,
          platform,
        });
        if (vsArgvRes?.updated || vsArgvRes?.alreadyConfigured) {
          vsCodeLauncherProvisioned = true;
        }
        lastVsCodeLauncherProvisionAtMs = Date.now();
      }
    }
    const shouldCheckLaunchers =
      antigravityNeedsCdp &&
      autoConfigureIdeArgv &&
      userAutoLaunch &&
      (lastLauncherProvisionAtMs === 0 ||
        Date.now() - lastLauncherProvisionAtMs >= launcherRecheckIntervalMs);
    const isInitialLauncherPass = lastLauncherProvisionAtMs === 0;

    const antigravityPortFiles = resolveDevToolsPortCandidates(env, platform, homeDir);
    const effectiveVsCodePortFiles = Array.from(
      new Set([
        ...localVsCodeSupport.portCandidates,
        ...(hasPendingVsCodeCleanup ? rememberedVsCodePortFiles : []),
      ])
    );
    const candidatePortFiles = [...antigravityPortFiles, ...effectiveVsCodePortFiles];
    const probeReport = await portProber.probeActiveDevToolsPorts({
      candidateFiles: candidatePortFiles,
      explicitPortsRaw: String(env?.ANTIGRAVITY_DEVTOOLS_PORT || '').trim(),
    });
    const antigravityStaleFiles = (
      Array.isArray(probeReport.staleFiles) ? probeReport.staleFiles : []
    ).filter((f) => f?.product !== 'vscode');
    const antigravityTransientFiles = (
      Array.isArray(probeReport.transientTimeoutFiles) ? probeReport.transientTimeoutFiles : []
    ).filter((f) => f?.product !== 'vscode');
    const antigravityStaleDetected = antigravityStaleFiles.length > 0;
    const vsCodeLivePortsSet = new Set(
      Array.isArray(probeReport.vsCodeLivePorts) ? probeReport.vsCodeLivePorts : []
    );
    const hadDeadAntigravityPort = Boolean(
      antigravityStaleDetected ||
        antigravityTransientFiles.length > 0 ||
        probeReport.explicitPortUnreachable
    );
    const isHardPortFailureReason = (reason) =>
      reason === 'ECONNREFUSED' ||
      reason === 'browser_ws_path_mismatch' ||
      reason === 'not_devtools_endpoint' ||
      reason === 'missing_browser_ws_url' ||
      reason === 'invalid_version_payload';
    const tryHoldActiveOnTransientCdpMiss = ({ hardRefusal = false } = {}) => {
      if (!(antigravityNeedsCdp || localVsCodeSupport.hasAnySupport)) {
        return false;
      }
      if (hardRefusal) return false;
      const nowMs = Date.now();
      const hasRecentOverlayHeartbeat =
        lastBridgeHttpActivityMs > 0 && nowMs - lastBridgeHttpActivityMs < overlayHeartbeatGraceMs;
      const wasActive =
        lastBridgeStatus.state === 'active' && Number(lastBridgeStatus.aliveCount || 0) > 0;
      if (!wasActive && !hasRecentOverlayHeartbeat) return false;
      consecutiveActiveCdpMisses += 1;
      if (!hasRecentOverlayHeartbeat && consecutiveActiveCdpMisses > activeTransientMissTolerance) {
        return false;
      }
      updateBridgeStatus('active', {
        enabled: Boolean(enabled || localVsCodeSupport.hasAnySupport),
        aliveCount: Math.max(1, Number(lastBridgeStatus.aliveCount || 0)),
        targets: Math.max(1, Number(lastBridgeStatus.targets || 0)),
        leasedBySelf,
        bundleVersion,
        prevLease: currentLease,
      });
      return true;
    };

    const cdpPorts = probeReport.livePorts;
    if (!cdpPorts.length) {
      const hasTransientTimeout =
        antigravityTransientFiles.length > 0 ||
        antigravityStaleFiles.some((f) => f?.reason === 'PROBE_TIMEOUT');
      const hardRefusal =
        !hasTransientTimeout &&
        (antigravityStaleFiles.length === 0 ||
          antigravityStaleFiles.every((f) => isHardPortFailureReason(f?.reason)));
      if (tryHoldActiveOnTransientCdpMiss({ hardRefusal })) {
        return {
          ok: false,
          enabled,
          reason: 'cdp_transient_busy',
          transientHeld: true,
          stalePortDetected: lastStalePortDetected,
          injected: 0,
        };
      }
      lastStalePortDetected = Boolean(antigravityStaleDetected || hasTransientTimeout);
      lastTargetProduct = resolvePreferredTargetProduct(probeReport);
      activeIdeSshHostKeys = new Set();
      pruneStaleRemoteEndpoints(new Set());
      ideSshCoordinator.pruneInactiveHosts(activeIdeSshHostKeys);
      for (const p of Array.from(rememberedVsCodePortFiles)) {
        if (!localVsCodeSupport.portCandidates.includes(p)) rememberedVsCodePortFiles.delete(p);
      }
      const provPending = shouldCheckLaunchers
        ? provisionHostLaunchersOnce({ fastCheckIfActive: !isInitialLauncherPass })
        : hostLauncherPromise;
      if (provPending) {
        await provPending.catch(() => {});
      }
      const emptyReason = hadDeadAntigravityPort ? 'cdp_unreachable' : 'no_devtools_port';
      updateBridgeStatus(
        antigravityNeedsCdp ? emptyReason : 'disabled',
        {
          enabled,
          leasedBySelf,
          bundleVersion,
          prevLease: currentLease,
        }
      );
      return {
        ok: false,
        enabled,
        reason: emptyReason,
        stalePortDetected: lastStalePortDetected,
        injected: 0,
      };
    }

    lastStalePortDetected = Boolean(antigravityStaleDetected);
    lastTargetProduct = resolvePreferredTargetProduct(probeReport);
    const { reachableCount, targets, hostI18nExtraWsUrls } = await collectAllMainWindowTargets(
      cdpPorts,
      vsCodeLivePortsSet
    );
    if (reachableCount === 0) {
      if (tryHoldActiveOnTransientCdpMiss({ hardRefusal: false })) {
        return {
          ok: false,
          enabled,
          reason: 'cdp_transient_busy',
          transientHeld: true,
          injected: 0,
        };
      }
      activeIdeSshHostKeys = new Set();
      pruneStaleRemoteEndpoints(new Set());
      ideSshCoordinator.pruneInactiveHosts(activeIdeSshHostKeys);
      for (const p of Array.from(rememberedVsCodePortFiles)) {
        if (!localVsCodeSupport.portCandidates.includes(p)) rememberedVsCodePortFiles.delete(p);
      }
      const provPending = shouldCheckLaunchers
        ? provisionHostLaunchersOnce({ fastCheckIfActive: !isInitialLauncherPass })
        : hostLauncherPromise;
      if (provPending) {
        await provPending.catch(() => {});
      }
      updateBridgeStatus(
        antigravityNeedsCdp ? 'cdp_unreachable' : 'disabled',
        {
          enabled,
          leasedBySelf,
          bundleVersion,
          prevLease: currentLease,
        }
      );
      return { ok: false, enabled, reason: 'cdp_unreachable', injected: 0 };
    }

    const antigravityTargets = targets.filter((t) => !t.isVsCodeHost);
    const antigravityLivePorts = cdpPorts.filter((p) => !vsCodeLivePortsSet.has(p));
    if (shouldCheckLaunchers) {
      if (antigravityTargets.length === 0 && antigravityLivePorts.length === 0) {
        // 仅有 VS Code 调试端口连通、Antigravity Desktop/IDE 尚未接入时，不误走快检，确保桌面端快捷方式自愈及时落盘
        const provPending = provisionHostLaunchersOnce({
          fastCheckIfActive: !isInitialLauncherPass,
        });
        if (provPending) {
          await provPending.catch(() => {});
        }
      } else {
        // 调试端口已正常连通时走纯 Node.js 零子进程快检（<2ms），仅在发现未配参快捷方式时才拉起 PowerShell
        void provisionHostLaunchersOnce({ fastCheckIfActive: true }).catch(() => {});
      }
    }
    if (!targets.length && !hostI18nExtraWsUrls.length) {
      activeIdeSshHostKeys = new Set();
      pruneStaleRemoteEndpoints(new Set());
      ideSshCoordinator.pruneInactiveHosts(activeIdeSshHostKeys);
      const noTargetsState = antigravityNeedsCdp
        ? antigravityLivePorts.length === 0
          ? hadDeadAntigravityPort
            ? 'cdp_unreachable'
            : 'no_devtools_port'
          : 'no_targets'
        : 'disabled';
      updateBridgeStatus(noTargetsState, {
        enabled,
        leasedBySelf,
        bundleVersion,
        prevLease: currentLease,
      });
      return { ok: true, enabled, reason: 'no_targets', injected: 0 };
    }

    const hostThemeProbeExpr = buildHostThemeProbeSnippet();
    const hasAnyVsCodeTarget = targets.some((t) => t.isVsCodeHost);

    if (
      !enabled &&
      !hasAnyVsCodeTarget &&
      !hasPendingVsCodeCleanup &&
      !needsAnyCdpContext &&
      !hadContextWindows &&
      !needsHostI18n &&
      !hadHostI18n &&
      !hadInjectedTargets &&
      injectedChatFrameWsUrls.size === 0 &&
      !hadRouteWatchers &&
      !forceReinject
    ) {
      const nowPassiveMs = Date.now();
      const themeTarget = targets.find((t) => !t.isIdeWorkbench && t.webSocketDebuggerUrl) || targets.find((t) => t.webSocketDebuggerUrl);
      if (themeTarget?.webSocketDebuggerUrl && nowPassiveMs - lastPassiveThemeProbeMs >= 5000) {
        lastPassiveThemeProbeMs = nowPassiveMs;
        try {
          const themeRes = await evaluateOnTarget(themeTarget.webSocketDebuggerUrl, hostThemeProbeExpr, 1200);
          const recorded = recordLiveCdpHostTheme(themeRes?.result?.result?.value);
          if (recorded) lastDetectedHostTheme = recorded;
        } catch {
          // 忽略被动只读主题探测超时或断开异常
        }
      }
      activeIdeSshHostKeys = new Set();
      pruneStaleRemoteEndpoints(new Set());
      ideSshCoordinator.pruneInactiveHosts(activeIdeSshHostKeys);
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
          hostTheme: ${hostThemeProbeExpr},
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
        return { origin: '', title: '', csrfToken: '', observedCsrfToken: '', hostTheme: null, appConfig: null };
      }
    })()`;

    const ideClassifyExpr = `(() => {
      try {
        const vsCfg = typeof window !== 'undefined' && typeof window.vscode?.context?.configuration === 'function'
          ? window.vscode.context.configuration()
          : null;
        const appCfg = typeof window !== 'undefined' && window.__APP_CONFIG__ && typeof window.__APP_CONFIG__ === 'object'
          ? window.__APP_CONFIG__
          : null;
        const rawFolderObj = vsCfg?.folderUri || vsCfg?.workspace?.configPath || vsCfg?.workspace || null;
        const ideFolderUri = typeof rawFolderObj === 'string'
          ? rawFolderObj.trim()
          : String(rawFolderObj?.external || rawFolderObj?.path || '').trim();
        return {
          ideRemoteAuthority: String(vsCfg?.remoteAuthority || appCfg?.remoteAuthority || '').trim(),
          ideFolderUri,
          title: String((typeof document !== 'undefined' && document?.title) || '').trim(),
          hostTheme: ${hostThemeProbeExpr},
        };
      } catch {
        return { ideRemoteAuthority: '', ideFolderUri: '', title: '', hostTheme: null };
      }
    })()`;

    const nowClassifyMs = Date.now();
    const localHubInfo =
      typeof getLocalHubPortsFn === 'function' ? getLocalHubPortsFn() : { allPorts: new Set(), httpsPorts: new Set(), csrfTokens: new Set() };
    const probedByWsUrl = new Map();
    const desktopTargets = targets.filter((t) => !t.isIdeWorkbench && t.webSocketDebuggerUrl);
    const ideTargets = targets.filter((t) => t.isIdeWorkbench && t.webSocketDebuggerUrl);
    const remoteIdeChatProbeTargets = [];
    const seenRemoteIdeChatWs = new Set();
    for (const target of ideTargets) {
      const primaryChat = pickPrimaryIdeChatTarget(target);
      const chatWs = String(primaryChat?.webSocketDebuggerUrl || '').trim();
      if (!chatWs || seenRemoteIdeChatWs.has(chatWs)) continue;
      const preliminaryCls = classifyWindowTargetEndpoint({
        target,
        probedInfo: null,
        localHubInfo,
        confirmedLocalPorts: null,
        enableRemoteSsh: remoteSshEnabled,
      });
      if (preliminaryCls.isRemote && preliminaryCls.isIdeRemoteSsh) {
        seenRemoteIdeChatWs.add(chatWs);
        remoteIdeChatProbeTargets.push({
          webSocketDebuggerUrl: chatWs,
          url: String(primaryChat?.url || primaryChat?.origin || ''),
        });
      }
    }

    const remoteChatClassifyExpr = `(() => {
      try {
        const cfg = typeof window !== 'undefined' && window.__APP_CONFIG__ && typeof window.__APP_CONFIG__ === 'object'
          ? window.__APP_CONFIG__
          : null;
        const observedCsrf = String(
          (typeof window !== 'undefined' && window[${JSON.stringify(CONTEXT_WINDOWS_GLOBAL_KEY)}]?.observedCsrfToken) || ''
        ).trim();
        return {
          origin: String((typeof window !== 'undefined' && window.location?.origin) || '').trim(),
          csrfToken: String(cfg?.csrfToken || '').trim(),
          observedCsrfToken: observedCsrf,
        };
      } catch {
        return { origin: '', csrfToken: '', observedCsrfToken: '' };
      }
    })()`;

    await Promise.allSettled([
      ...desktopTargets.map(async (target) => {
        const wsUrl = String(target.webSocketDebuggerUrl || '');
        let targetOriginKey = '';
        try {
          targetOriginKey = new URL(String(target.url || '')).origin;
        } catch {
          targetOriginKey = String(target.url || '');
        }
        const cacheKey = `${wsUrl}::${targetOriginKey}`;
        const cached = targetClassifyCache.get(cacheKey);
        if (cached && nowClassifyMs - cached.ts < 6000) {
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
      }),
      ...ideTargets.map(async (target) => {
        const wsUrl = String(target.webSocketDebuggerUrl || '');
        const cacheKey = `ide::${wsUrl}::${String(target.url || '')}`;
        const cached = targetClassifyCache.get(cacheKey);
        if (cached && nowClassifyMs - cached.ts < 6000) {
          probedByWsUrl.set(wsUrl, cached.info);
          return;
        }
        try {
          const res = await evaluateOnTarget(wsUrl, ideClassifyExpr, 1500);
          const info = res?.result?.result?.value;
          if (info && typeof info === 'object') {
            probedByWsUrl.set(wsUrl, info);
            targetClassifyCache.set(cacheKey, { ts: nowClassifyMs, info });
          }
        } catch {
          if (cached?.info) probedByWsUrl.set(wsUrl, cached.info);
        }
      }),
      ...remoteIdeChatProbeTargets.map(async (chatTarget) => {
        const wsUrl = String(chatTarget.webSocketDebuggerUrl || '');
        const cacheKey = `ide-chat::${wsUrl}::${chatTarget.url}`;
        const cached = targetClassifyCache.get(cacheKey);
        if (cached && nowClassifyMs - cached.ts < 6000) {
          probedByWsUrl.set(wsUrl, cached.info);
          return;
        }
        try {
          const res = await evaluateOnTarget(wsUrl, remoteChatClassifyExpr, 1500);
          const info = res?.result?.result?.value;
          if (info && typeof info === 'object') {
            probedByWsUrl.set(wsUrl, info);
            targetClassifyCache.set(cacheKey, { ts: nowClassifyMs, info });
          }
        } catch {
          if (cached?.info) probedByWsUrl.set(wsUrl, cached.info);
        }
      }),
    ]);

    if (targetClassifyCache.size > 64) {
      for (const [k, rec] of targetClassifyCache.entries()) {
        if (nowClassifyMs - rec.ts > 30_000) targetClassifyCache.delete(k);
      }
    }

    // 两趟分类：第一趟确认明确归属本机的 Desktop 窗口端口，第二趟据此精准识别 SSH 远端窗口与 IDE Remote-SSH 窗口
    const confirmedLocalPorts = new Set();
    for (const target of desktopTargets) {
      const probedInfo = probedByWsUrl.get(String(target.webSocketDebuggerUrl || '')) || null;
      const firstPass = classifyWindowTargetEndpoint({
        target,
        probedInfo,
        localHubInfo,
        confirmedLocalPorts: null,
        enableRemoteSsh: remoteSshEnabled,
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
    const classifiedTargets = [];
    const ideSshGroupsByHostKey = new Map();

    for (const target of targets) {
      const wsUrl = String(target.webSocketDebuggerUrl || '');
      const probedInfo = probedByWsUrl.get(wsUrl) || null;
      const cls = classifyWindowTargetEndpoint({
        target,
        probedInfo,
        localHubInfo,
        confirmedLocalPorts,
        enableRemoteSsh: remoteSshEnabled,
      });
      const disabledSshRemote =
        !remoteSshEnabled &&
        target.isVsCodeHost &&
        target.isIdeWorkbench &&
        classifyWindowTargetEndpoint({
          target,
          probedInfo,
          localHubInfo,
          confirmedLocalPorts,
          enableRemoteSsh: true,
        }).isRemote;
      classifiedTargets.push({ target, wsUrl, cls, disabledSshRemote });
      if (cls.isRemote && wsUrl && cls.isIdeRemoteSsh && cls.parsedIdeAuthority) {
        let group = ideSshGroupsByHostKey.get(cls.stableHostKey);
        if (!group) {
          group = {
            stableHostKey: cls.stableHostKey,
            parsedIdeAuthority: cls.parsedIdeAuthority,
            forwardedOrigins: new Set(),
            rpcWsUrls: new Set(),
            hasVsCodeWithoutChat: false,
            hasNonVsCodeIde: false,
            directChatAuth: null,
            resolvedConn: null,
          };
          ideSshGroupsByHostKey.set(cls.stableHostKey, group);
        }
        const chatList = Array.isArray(target.ideChatTargets) ? target.ideChatTargets : [];
        if (target.isVsCodeHost) {
          if (chatList.length === 0) group.hasVsCodeWithoutChat = true;
        } else {
          group.hasNonVsCodeIde = true;
        }
        for (const ct of chatList) {
          const orig = String(ct?.origin || '').trim();
          if (orig) group.forwardedOrigins.add(orig);
          const chatWs = String(ct?.webSocketDebuggerUrl || '').trim();
          if (chatWs) {
            group.rpcWsUrls.add(chatWs);
            if (!group.directChatAuth) {
              const chatProbed = probedByWsUrl.get(chatWs) || null;
              const chatOrigin = String(chatProbed?.origin || orig || '').trim().replace(/\/+$/, '');
              const chatCsrf = String(
                chatProbed?.csrfToken || chatProbed?.observedCsrfToken || ''
              ).trim();
              if (
                chatOrigin &&
                /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/i.test(chatOrigin) &&
                chatCsrf
              ) {
                group.directChatAuth = { origin: chatOrigin, csrfToken: chatCsrf };
              }
            }
          }
        }
      }
    }

    if (ideSshGroupsByHostKey.size > 0) {
      const ideSshSyncWaitBudgetMs = Math.max(
        100,
        Math.min(4000, Number(ideRemoteSshOptions?.syncWaitBudgetMs) || 1800)
      );
      await Promise.all(
        Array.from(ideSshGroupsByHostKey.values()).map(async (group) => {
          if (group.directChatAuth) {
            group.resolvedConn = {
              ok: true,
              baseUrl: group.directChatAuth.origin,
              csrfToken: group.directChatAuth.csrfToken,
              mode: 'forwarded',
              capabilities: {
                known: true,
                hasCli: false,
                hasCliPlugin: false,
                hasVsCodeExt: true,
              },
            };
            return;
          }
          const requireCapabilities = Boolean(
            group.hasVsCodeWithoutChat &&
              !group.hasNonVsCodeIde &&
              group.forwardedOrigins.size === 0
          );
          const resolvePromise = ideSshCoordinator.resolveEndpointConnection({
            parsedAuthority: group.parsedIdeAuthority,
            forwardedOrigins: Array.from(group.forwardedOrigins),
            requireCapabilities,
          });
          let budgetTimer = null;
          let timedOut = false;
          try {
            group.resolvedConn = await Promise.race([
              resolvePromise,
              new Promise((resolve) => {
                budgetTimer = setTimeout(() => {
                  timedOut = true;
                  resolve({
                    ok: false,
                    reason: 'probe_pending',
                    baseUrl: '',
                    csrfToken: '',
                    mode: 'pending',
                    capabilities: {
                      known: false,
                      hasCli: false,
                      hasCliPlugin: false,
                      hasVsCodeExt: false,
                    },
                  });
                }, ideSshSyncWaitBudgetMs);
                budgetTimer.unref?.();
              }),
            ]);
          } finally {
            if (budgetTimer) {
              clearTimeout(budgetTimer);
              budgetTimer = null;
            }
          }
          if (timedOut) {
            resolvePromise
              .then((lateRes) => {
                if (
                  !stopped &&
                  (lateRes?.ok ||
                    lateRes?.capabilities?.hasCliPlugin ||
                    lateRes?.capabilities?.hasVsCodeExt)
                ) {
                  void syncAllWindows({ forceReinject: false }).catch(() => {});
                }
              })
              .catch(() => {});
          }
        })
      );
    }

    activeIdeSshHostKeys = new Set(
      Array.from(ideSshGroupsByHostKey.keys(), (k) => String(k || '').trim().toLowerCase()).filter(
        Boolean
      )
    );
    const createIdeSshDisposeCallback = (stableHostKey) => {
      const normKey = String(stableHostKey || '').trim().toLowerCase();
      return () => {
        if (!activeIdeSshHostKeys.has(normKey)) {
          ideSshCoordinator.disposeHost(normKey);
        }
      };
    };

    for (const { target, wsUrl, cls, disabledSshRemote } of classifiedTargets) {
      target.forceTopbarMode = false;
      target.skipOverlayInjection = false;
      const chatList = Array.isArray(target.ideChatTargets) ? target.ideChatTargets : [];
      if (cls.isRemote && wsUrl) {
        let ep = null;
        if (cls.isIdeRemoteSsh && cls.parsedIdeAuthority) {
          const group = ideSshGroupsByHostKey.get(cls.stableHostKey);
          const allForwarded = group ? Array.from(group.forwardedOrigins) : [];
          const sshConn = group?.resolvedConn || {
            ok: false,
            baseUrl: '',
            csrfToken: '',
            mode: 'none',
            capabilities: { known: false, hasCli: false, hasCliPlugin: false, hasVsCodeExt: false },
          };
          const caps = sshConn.capabilities || {
            known: false,
            hasCli: false,
            hasCliPlugin: false,
            hasVsCodeExt: false,
          };

          if (target.isVsCodeHost && chatList.length === 0) {
            if (caps.hasVsCodeExt) {
              const bestBaseUrl = String(sshConn.baseUrl || allForwarded[0] || '').trim();
              ep = registerRemoteEndpoint({
                origin: allForwarded[0] || bestBaseUrl,
                baseUrl: bestBaseUrl,
                csrfToken: sshConn.csrfToken || '',
                wsUrl,
                canInvokeRpc: false,
                rpcWsUrls: [],
                clearRpcTargets: true,
                tier1Verified: Boolean(sshConn.ok),
                onDisposeKey: 'ide-ssh',
                onDispose: createIdeSshDisposeCallback(cls.stableHostKey),
                label: cls.hostLabel,
                stableHostKey: cls.stableHostKey,
              });
            } else if (caps.hasCli && caps.hasCliPlugin) {
              target.forceTopbarMode = true;
              const tunBaseUrl = sshConn.ok ? String(sshConn.baseUrl || '').trim() : '';
              ep = registerRemoteEndpoint({
                origin: tunBaseUrl,
                baseUrl: tunBaseUrl,
                csrfToken: sshConn.ok ? String(sshConn.csrfToken || '').trim() : '',
                wsUrl,
                canInvokeRpc: false,
                rpcWsUrls: [],
                clearRpcTargets: true,
                tier1Verified: Boolean(sshConn.ok),
                tier1Only: true,
                clearConnection: !sshConn.ok,
                onDisposeKey: 'ide-ssh',
                onDispose: createIdeSshDisposeCallback(cls.stableHostKey),
                label: `${cls.hostLabel} (CLI)`,
                stableHostKey: `ssh-cli:${cls.stableHostKey}`,
              });
            } else {
              target.skipOverlayInjection = true;
              target.endpointId = LOCAL_ENDPOINT_ID;
              target.isRemoteEndpoint = false;
              target.endpointLabel = '';
            }
          } else {
            const useTunnel = Boolean(sshConn.ok && sshConn.mode === 'tunnel');
            const effectiveRpcWsUrls = useTunnel
              ? []
              : group
                ? Array.from(group.rpcWsUrls)
                : [];
            const bestBaseUrl = String(
              sshConn.baseUrl || group?.directChatAuth?.origin || allForwarded[0] || ''
            ).trim();
            const bestCsrf = String(
              sshConn.csrfToken || group?.directChatAuth?.csrfToken || ''
            ).trim();
            ep = registerRemoteEndpoint({
              origin: allForwarded[0] || bestBaseUrl,
              baseUrl: bestBaseUrl,
              csrfToken: bestCsrf,
              wsUrl,
              canInvokeRpc: false,
              rpcWsUrls: effectiveRpcWsUrls,
              clearRpcTargets: useTunnel,
              tier1Verified: Boolean(sshConn.ok || group?.directChatAuth),
              onDisposeKey: 'ide-ssh',
              onDispose: createIdeSshDisposeCallback(cls.stableHostKey),
              label: cls.hostLabel,
              stableHostKey: cls.stableHostKey,
            });
            for (const rpcWs of effectiveRpcWsUrls) {
              activeRemoteWsUrls.add(rpcWs);
            }
          }
        } else {
          ep = registerRemoteEndpoint({
            origin: cls.origin,
            baseUrl: cls.origin,
            csrfToken: cls.csrfToken,
            wsUrl,
            label: cls.hostLabel,
            stableHostKey: cls.stableHostKey,
          });
        }
        if (ep) {
          target.endpointId = ep.id;
          target.isRemoteEndpoint = true;
          target.endpointLabel = ep.label;
          activeRemoteWsUrls.add(wsUrl);
        }
        for (const ct of chatList) {
          ct.endpointId = target.endpointId;
          ct.isRemoteEndpoint = target.isRemoteEndpoint;
          ct.endpointLabel = target.endpointLabel;
        }
      } else if (target.isVsCodeHost) {
        if (disabledSshRemote || cls.isNonSshRemote) {
          target.skipOverlayInjection = true;
          target.forceTopbarMode = false;
        } else {
          const variantExt =
            target.vsCodeVariant === 'insiders'
              ? localVsCodeSupport.hasLocalExtByVariant?.insiders
              : target.vsCodeVariant === 'stable'
                ? localVsCodeSupport.hasLocalExtByVariant?.stable
                : localVsCodeSupport.hasLocalExt;
          const hasLocalExt = chatList.length > 0 || Boolean(variantExt);
          if (hasLocalExt) {
            target.skipOverlayInjection = false;
            target.forceTopbarMode = false;
          } else if (localVsCodeSupport.hasLocalCliPlugin) {
            target.skipOverlayInjection = false;
            target.forceTopbarMode = true;
          } else {
            target.skipOverlayInjection = true;
            target.forceTopbarMode = false;
          }
        }
        target.endpointId = LOCAL_ENDPOINT_ID;
        target.isRemoteEndpoint = false;
        target.endpointLabel = '';
        for (const ct of chatList) {
          ct.endpointId = LOCAL_ENDPOINT_ID;
          ct.isRemoteEndpoint = false;
          ct.endpointLabel = '';
        }
      } else {
        target.endpointId = LOCAL_ENDPOINT_ID;
        target.isRemoteEndpoint = false;
        target.endpointLabel = '';
        for (const ct of chatList) {
          ct.endpointId = LOCAL_ENDPOINT_ID;
          ct.isRemoteEndpoint = false;
          ct.endpointLabel = '';
        }
      }
    }

    let pickedHostTheme = null;
    for (const target of targets) {
      if (target.isIdeWorkbench || target.isRemoteEndpoint) continue;
      const candidate = normalizeHostThemeSnapshot(
        probedByWsUrl.get(String(target.webSocketDebuggerUrl || ''))?.hostTheme
      );
      if (candidate) {
        pickedHostTheme = candidate;
        break;
      }
    }
    if (!pickedHostTheme) {
      for (const target of desktopTargets) {
        const candidate = normalizeHostThemeSnapshot(
          probedByWsUrl.get(String(target.webSocketDebuggerUrl || ''))?.hostTheme
        );
        if (candidate) {
          pickedHostTheme = candidate;
          break;
        }
      }
    }
    if (!pickedHostTheme) {
      for (const target of ideTargets) {
        if (target.skipOverlayInjection) continue;
        const candidate = normalizeHostThemeSnapshot(
          probedByWsUrl.get(String(target.webSocketDebuggerUrl || ''))?.hostTheme
        );
        if (candidate) {
          pickedHostTheme = candidate;
          break;
        }
      }
    }
    if (pickedHostTheme) {
      const recordedTheme = recordLiveCdpHostTheme(pickedHostTheme);
      if (recordedTheme) lastDetectedHostTheme = recordedTheme;
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
          .filter((t) => t.isRemoteEndpoint && t.endpointId)
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
        if (needsAnyCdpContext) {
          appliedContextWindowWsUrls.add(wsUrl);
        } else {
          appliedContextWindowWsUrls.delete(wsUrl);
        }
      }
      for (const target of targets) {
        if (!Array.isArray(target?.ideChatTargets)) continue;
        for (const chatTarget of target.ideChatTargets) {
          const chatUrl = String(chatTarget?.webSocketDebuggerUrl || '').trim();
          if (!chatUrl || seenCtxUrls.has(chatUrl)) continue;
          seenCtxUrls.add(chatUrl);
          if (needsAnyCdpContext && target.skipOverlayInjection) {
            if (appliedContextWindowWsUrls.has(chatUrl)) {
              const clearExpr = createContextWindowSyncExpression(
                {},
                contextWindowBootId,
                {},
                false,
                null
              );
              ctxEvalTasks.push(evaluateOnTarget(chatUrl, clearExpr));
              appliedContextWindowWsUrls.delete(chatUrl);
            }
            continue;
          }
          const isRemoteChat = Boolean(chatTarget.isRemoteEndpoint && chatTarget.endpointId);
          const ideChatExpr = !needsAnyCdpContext
            ? createContextWindowSyncExpression({}, contextWindowBootId, {}, false, null)
            : pinMainBackToDefaults
              ? isRemoteChat
                ? createContextWindowSyncExpression({}, contextWindowBootId, {}, false, null)
                : createContextWindowSyncExpression(
                    contextWindows,
                    contextWindowBootId,
                    pinBackRules,
                    false,
                    pinBackRules
                  )
              : createContextWindowSyncExpression(
                  contextWindows,
                  contextWindowBootId,
                  isRemoteChat
                    ? remoteFallbackRulesById.get(chatTarget.endpointId) || localFallbackRules
                    : localFallbackRules,
                  false,
                  null
                );
          ctxEvalTasks.push(evaluateOnTarget(chatUrl, ideChatExpr));
          if (needsAnyCdpContext) {
            appliedContextWindowWsUrls.add(chatUrl);
          } else {
            appliedContextWindowWsUrls.delete(chatUrl);
          }
        }
      }
      await Promise.allSettled(ctxEvalTasks);
      if (!needsAnyCdpContext) {
        appliedContextWindowWsUrls.clear();
      } else {
        for (const ws of Array.from(appliedContextWindowWsUrls)) {
          if (!seenCtxUrls.has(ws)) appliedContextWindowWsUrls.delete(ws);
        }
      }
      hadContextWindows = needsAnyCdpContext;
    }

    if (needsHostI18n || hadHostI18n) {
      const skippedHostI18nChatUrls = new Set();
      const hostI18nWsUrls = collectHostI18nTargetWsUrls(targets, hostI18nExtraWsUrls, {
        skipDisabledOverlay: needsHostI18n,
        appliedWsUrls: appliedHostI18nWsUrls,
        skippedOut: skippedHostI18nChatUrls,
      });

      if (!needsHostI18n) {
        const disposeHostI18nExpr = createHostI18nDisposeExpression();
        await Promise.allSettled(
          Array.from(hostI18nWsUrls).map((wsUrl) => evaluateOnTarget(wsUrl, disposeHostI18nExpr))
        );
        appliedHostI18nWsUrls.clear();
        hadHostI18n = false;
        lastHostI18nAppliedCount = 0;
        cachedHostI18nApply = { revision: '', bootId: '', expr: '' };
      } else {
        const disposeTasks = [];
        if (skippedHostI18nChatUrls.size > 0) {
          const disposeHostI18nExpr = createHostI18nDisposeExpression();
          for (const wsUrl of skippedHostI18nChatUrls) {
            disposeTasks.push(evaluateOnTarget(wsUrl, disposeHostI18nExpr));
            appliedHostI18nWsUrls.delete(wsUrl);
          }
        }
        const heartbeatExpr = createHostI18nHeartbeatExpression(
          hostI18nBootId,
          hostI18nDesc.revision
        );
        let appliedTargets = 0;
        await Promise.allSettled([
          ...disposeTasks,
          ...Array.from(hostI18nWsUrls).map(async (wsUrl) => {
            try {
              const hbRes = await evaluateOnTarget(wsUrl, heartbeatExpr, 1800);
              const hbVal = hbRes?.result?.result?.value;
              if (hbVal?.alive === true && hbVal?.needsApply === false) {
                appliedHostI18nWsUrls.add(wsUrl);
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
              appliedHostI18nWsUrls.add(wsUrl);
              appliedTargets += 1;
            }
          }),
        ]);
        for (const ws of Array.from(appliedHostI18nWsUrls)) {
          if (!hostI18nWsUrls.has(ws)) appliedHostI18nWsUrls.delete(ws);
        }
        hadHostI18n = true;
        lastHostI18nAppliedCount = appliedTargets;
      }
    }

    const disposeExpr = `(() => {
      try {
        const existed = Boolean(${windowOverlayRef} || ${windowBridgeRef} || window.__agUsageMonitorRouteWatcher);
        window.__agUsageMonitorRouteWatcher?.dispose?.();
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
      injectedChatFrameWsUrls.delete(wsUrl);
      try {
        const res = await evaluateOnTarget(wsUrl, disposeExpr);
        return res?.result?.result?.value === true;
      } catch {
        return false;
      }
    }

    const hasActiveVsCodeTarget = targets.some((t) => t.isVsCodeHost && !t.skipOverlayInjection);
    if (!enabled && !hasActiveVsCodeTarget) {
      pruneStaleRemoteEndpoints(activeRemoteWsUrls);
      ideSshCoordinator.pruneInactiveHosts(activeIdeSshHostKeys);
      if (
        !hadInjectedTargets &&
        injectedChatFrameWsUrls.size === 0 &&
        !hadRouteWatchers &&
        !forceReinject
      ) {
        for (const p of Array.from(rememberedVsCodePortFiles)) {
          if (!localVsCodeSupport.portCandidates.includes(p)) rememberedVsCodePortFiles.delete(p);
        }
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
      injectedChatFrameWsUrls.clear();
      hadRouteWatchers = false;
      for (const p of Array.from(rememberedVsCodePortFiles)) {
        if (!localVsCodeSupport.portCandidates.includes(p)) rememberedVsCodePortFiles.delete(p);
      }
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
          isVsCodeHost: Boolean(br?.isVsCodeHost),
          forceTopbarMode: Boolean(br?.forceTopbarMode),
          endpointId: String(br?.[${windowBridgeEndpointKey}] || ${JSON.stringify(LOCAL_ENDPOINT_ID)}),
          endpointLabel: String(br?.endpointLabel || ''),
          hostRouteCascadeId: String(br?.[${windowBridgeRouteKey}] || ''),
          routeCascadeId,
          rpcBatch,
        };
      } catch {
        return { alive: false, dockKind: '', visible: true, bundleVersion: '', bridgePort: 0, hasToken: false, transportMode: 'http', isVsCodeHost: false, forceTopbarMode: false, endpointId: ${JSON.stringify(LOCAL_ENDPOINT_ID)}, endpointLabel: '', hostRouteCascadeId: '', routeCascadeId: '', rpcBatch: [] };
      }
    })()`;

    const ideChatRouteProbeExpr = `(() => {
      try {
        const readRouteId = () => ${domRouteExpr};
        const visible = ${WINDOW_VISIBLE_EXPR};
        const focused = Boolean(
          typeof document !== 'undefined' && typeof document.hasFocus === 'function' && document.hasFocus()
        );
        const routeCascadeId = readRouteId();
        try {
          const bridgePort = ${Number(port) || 0};
          const bridgeToken = ${JSON.stringify(String(token || ''))};
          const routePingPath = ${JSON.stringify(BRIDGE_ROUTE_PING_PATH)};
          if (bridgePort > 0 && bridgeToken && typeof window !== 'undefined' && typeof fetch === 'function') {
            const existing = window.__agUsageMonitorRouteWatcher;
            if (existing && typeof existing === 'object') {
              existing.port = bridgePort;
              existing.token = bridgeToken;
              existing.lastRouteId = routeCascadeId;
            } else {
              const watcher = {
                port: bridgePort,
                token: bridgeToken,
                lastRouteId: routeCascadeId,
                timer: null,
                origPush: null,
                origReplace: null,
                wrappedPush: null,
                wrappedReplace: null,
                ping(force = false) {
                  try {
                    const nextId = force ? null : readRouteId();
                    if (!force && nextId === watcher.lastRouteId) return;
                    if (!force) watcher.lastRouteId = nextId;
                    fetch('http://127.0.0.1:' + watcher.port + routePingPath, {
                      method: 'POST',
                      headers: { 'X-Usage-Monitor-Token': watcher.token },
                      keepalive: true,
                    }).catch(() => {});
                  } catch {
                    // 忽略路由通知异常
                  }
                },
                schedule(delayMs = 140, reset = true) {
                  if (typeof setTimeout !== 'function') return;
                  if (watcher.timer) {
                    if (!reset) return;
                    clearTimeout(watcher.timer);
                  }
                  watcher.timer = setTimeout(() => {
                    watcher.timer = null;
                    watcher.ping(false);
                  }, delayMs);
                },
                dispose() {
                  if (watcher.timer) {
                    clearTimeout(watcher.timer);
                    watcher.timer = null;
                  }
                  try { watcher.observer?.disconnect?.(); } catch {}
                  try {
                    if (typeof history !== 'undefined' && history) {
                      if (watcher.wrappedPush && history.pushState === watcher.wrappedPush && watcher.origPush) {
                        history.pushState = watcher.origPush;
                      }
                      if (watcher.wrappedReplace && history.replaceState === watcher.wrappedReplace && watcher.origReplace) {
                        history.replaceState = watcher.origReplace;
                      }
                      delete history.__agRouteWrapped;
                    }
                  } catch {}
                  try {
                    if (typeof window.removeEventListener === 'function') {
                      window.removeEventListener('popstate', watcher.onRoute);
                      window.removeEventListener('hashchange', watcher.onRoute);
                      window.removeEventListener('pagehide', watcher.onHide);
                    }
                    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
                      document.removeEventListener('visibilitychange', watcher.onRoute);
                    }
                  } catch {}
                  delete window.__agUsageMonitorRouteWatcher;
                },
              };
              watcher.onRoute = () => watcher.schedule(60, true);
              watcher.onHide = () => watcher.ping(true);
              if (typeof window.addEventListener === 'function') {
                window.addEventListener('popstate', watcher.onRoute);
                window.addEventListener('hashchange', watcher.onRoute);
                window.addEventListener('pagehide', watcher.onHide);
              }
              if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
                document.addEventListener('visibilitychange', watcher.onRoute);
              }
              if (typeof history !== 'undefined' && history && !history.__agRouteWrapped) {
                try {
                  const origPush = history.pushState;
                  const origReplace = history.replaceState;
                  if (typeof origPush === 'function') {
                    watcher.origPush = origPush;
                    watcher.wrappedPush = function (...args) {
                      const out = origPush.apply(this, args);
                      window.__agUsageMonitorRouteWatcher?.schedule?.(40, true);
                      return out;
                    };
                    history.pushState = watcher.wrappedPush;
                  }
                  if (typeof origReplace === 'function') {
                    watcher.origReplace = origReplace;
                    watcher.wrappedReplace = function (...args) {
                      const out = origReplace.apply(this, args);
                      window.__agUsageMonitorRouteWatcher?.schedule?.(40, true);
                      return out;
                    };
                    history.replaceState = watcher.wrappedReplace;
                  }
                  history.__agRouteWrapped = true;
                } catch {}
              }
              if (
                typeof MutationObserver === 'function' &&
                typeof document !== 'undefined' &&
                document.documentElement
              ) {
                try {
                  const mo = new MutationObserver((records) => {
                    if (!Array.isArray(records) || records.length === 0) return;
                    let hasAttr = false;
                    let hasElemChild = false;
                    for (let i = 0; i < records.length; i += 1) {
                      const rec = records[i];
                      if (rec.type === 'attributes') {
                        hasAttr = true;
                        break;
                      }
                      if (!hasElemChild && !watcher.timer) {
                        const added = rec.addedNodes;
                        for (let j = 0; added && j < added.length; j += 1) {
                          if (added[j]?.nodeType === 1) {
                            hasElemChild = true;
                            break;
                          }
                        }
                        if (!hasElemChild) {
                          const removed = rec.removedNodes;
                          for (let j = 0; removed && j < removed.length; j += 1) {
                            if (removed[j]?.nodeType === 1) {
                              hasElemChild = true;
                              break;
                            }
                          }
                        }
                      }
                    }
                    if (hasAttr) {
                      watcher.schedule(60, true);
                    } else if (hasElemChild) {
                      watcher.schedule(160, false);
                    }
                  });
                  mo.observe(document.documentElement, {
                    subtree: true,
                    childList: true,
                    attributes: true,
                    attributeFilter: ['data-cascade-id', 'data-selected', 'hidden'],
                  });
                  watcher.observer = mo;
                } catch {}
              }
              window.__agUsageMonitorRouteWatcher = watcher;
            }
          }
        } catch {
          // 忽略被动路由监听挂载异常
        }
        return { routeCascadeId, visible, focused };
      } catch {
        return { routeCascadeId: '', visible: false, focused: false };
      }
    })()`;

    const ideRouteProbeTimeoutMs = Math.max(
      500,
      Math.min(Number(cdpTimeoutMs) || IDE_ROUTE_PROBE_MAX_TIMEOUT_MS, IDE_ROUTE_PROBE_MAX_TIMEOUT_MS)
    );

    async function resolveIdeWorkbenchRouteState(targetObj) {
      const staticRouteId = sanitizeRouteCascadeId(targetObj?.ideRouteCascadeId);
      const chatList = Array.isArray(targetObj?.ideChatTargets) ? targetObj.ideChatTargets : [];
      const probeUrls = chatList
        .map((chatTarget) => String(chatTarget?.webSocketDebuggerUrl || '').trim())
        .filter(Boolean);
      if (probeUrls.length === 0) {
        return { resolved: true, routeId: staticRouteId };
      }
      hadRouteWatchers = true;

      if (probeUrls.length === 1) {
        try {
          const res = await evaluateOnTarget(probeUrls[0], ideChatRouteProbeExpr, ideRouteProbeTimeoutMs);
          const val = res?.result?.result?.value;
          if (res && !res.error && !res.result?.exceptionDetails && val && typeof val === 'object') {
            const rawCid = typeof val.routeCascadeId === 'string' ? val.routeCascadeId.trim() : '';
            const cid = sanitizeRouteCascadeId(rawCid);
            if (cid) return { resolved: true, routeId: cid };
            if (rawCid === '' && val.routeCascadeId === '') {
              return { resolved: true, routeId: '' };
            }
          }
          return { resolved: false, routeId: staticRouteId };
        } catch {
          return { resolved: false, routeId: staticRouteId };
        }
      }

      const abortCtrl = typeof AbortController === 'function' ? new AbortController() : null;
      const results = new Array(probeUrls.length).fill(null);
      let settledCount = 0;
      let anyExplicitEmpty = false;
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
          if (bestRouteId) {
            return { resolved: true, routeId: bestRouteId };
          }
          return anyExplicitEmpty
            ? { resolved: true, routeId: '' }
            : { resolved: false, routeId: staticRouteId };
        };

        const finishEarly = (routeId) => {
          if (resolved) return;
          resolved = true;
          try {
            abortCtrl?.abort();
          } catch {
            // 忽略中止异常
          }
          resolve({ resolved: true, routeId });
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
              if (res && !res.error && !res.result?.exceptionDetails && val && typeof val === 'object') {
                const rawCid = typeof val.routeCascadeId === 'string' ? val.routeCascadeId.trim() : '';
                const cid = sanitizeRouteCascadeId(rawCid);
                if (cid) {
                  const rank = val.focused && val.visible ? 3 : val.visible ? 2 : 1;
                  results[idx] = { cid, rank };
                  if (rank === 3) {
                    finishEarly(cid);
                  }
                } else if (rawCid === '' && val.routeCascadeId === '') {
                  anyExplicitEmpty = true;
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

    async function syncSingleTarget(
      targetObj,
      {
        ideRouteOverride = '',
        ideRouteResolved = false,
        isIdeChatFrame = false,
        effectiveMountMode = mountMode,
      } = {}
    ) {
      const wsUrl = String(targetObj?.webSocketDebuggerUrl || '').trim();
      if (!wsUrl) return { alive: false, dockKind: '', visible: false };
      let probedRouteId = '';
      const ideRouteId = ideRouteResolved
        ? sanitizeRouteCascadeId(ideRouteOverride)
        : sanitizeRouteCascadeId(ideRouteOverride || targetObj.ideRouteCascadeId);
      const targetEndpointId = String(targetObj.endpointId || LOCAL_ENDPOINT_ID);
      const targetIsRemote = Boolean(targetObj.isRemoteEndpoint && targetEndpointId !== LOCAL_ENDPOINT_ID);
      const targetEndpointLabel = targetIsRemote ? String(targetObj.endpointLabel || 'SSH') : '';
      const targetMountMode = effectiveMountMode || mountMode;
      const targetIsVsCodeHost = Boolean(targetObj.isVsCodeHost);
      const targetForceTopbarMode = Boolean(targetObj.forceTopbarMode);

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
              snapEndpointLabel !== targetEndpointLabel ||
              Boolean(snap.isVsCodeHost) !== targetIsVsCodeHost ||
              Boolean(snap.forceTopbarMode) !== targetForceTopbarMode
            ) {
              const rebindExpr = `${windowOverlayRef}?.[${overlayMethods.updateBridge}]?.(${JSON.stringify({
                port,
                token,
                isVsCodeHost: targetIsVsCodeHost,
                forceTopbarMode: targetForceTopbarMode,
                [WINDOW_BRIDGE_ENDPOINT_KEY]: targetEndpointId,
                isRemoteEndpoint: targetIsRemote,
                endpointLabel: targetEndpointLabel,
              })})`;
              await evaluateOnTarget(wsUrl, rebindExpr);
            }
            let effectiveDockKind = String(snap.dockKind || '');
            if (snap.clientMountMode && snap.clientMountMode !== targetMountMode) {
              const modeSyncExpr = `(() => {
                const overlay = ${windowOverlayRef};
                overlay?.[${overlayMethods.applyMountMode}]?.(${JSON.stringify(targetMountMode)});
                return String(overlay?.[${overlayMethods.getDockKind}]?.() || '');
              })()`;
              const modeRes = await evaluateOnTarget(wsUrl, modeSyncExpr);
              if (typeof modeRes?.result?.result?.value === 'string') {
                effectiveDockKind = modeRes.result.result.value;
              }
            }
            if (
              (targetObj.isIdeWorkbench || isIdeChatFrame) &&
              (ideRouteResolved || ideRouteId) &&
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
              injectedChatFrameWsUrls.add(wsUrl);
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
        mountMode: targetMountMode,
        isVsCodeHost: targetIsVsCodeHost,
        forceTopbarMode: targetForceTopbarMode,
        [WINDOW_BRIDGE_ENDPOINT_KEY]: targetEndpointId,
        isRemoteEndpoint: targetIsRemote,
        endpointLabel: targetEndpointLabel,
        [WINDOW_BRIDGE_ROUTE_KEY]: ideRouteId || '',
        isIdeChatFrame: Boolean(isIdeChatFrame),
        stylesCss: cachedAssets.stylesCss,
        initialTelemetry,
      });
      const injectionScript = `(() => {
        ${isIdeChatFrame ? 'window.__agUsageMonitorRouteWatcher?.dispose?.();' : ''}
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
          injectedChatFrameWsUrls.add(wsUrl);
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

    const resolveTargetMountMode = (t) => {
      if (t?.forceTopbarMode) return 'dual';
      if (t?.isVsCodeHost) return vsCodeMountMode;
      return mountMode;
    };

    if (injectedChatFrameWsUrls.size > 0 || hadRouteWatchers || forceReinject) {
      for (const t of targets) {
        const tMode = resolveTargetMountMode(t);
        const targetAllowed = !t.skipOverlayInjection && (enabled || t.isVsCodeHost);
        if (tMode === 'composer' && targetAllowed) {
          continue;
        }
        if (Array.isArray(t.ideChatTargets)) {
          for (const ct of t.ideChatTargets) {
            const chatWs = String(ct?.webSocketDebuggerUrl || '').trim();
            if (!chatWs) continue;
            if (!targetAllowed || forceReinject || injectedChatFrameWsUrls.has(chatWs)) {
              await disposeSingleTarget(chatWs);
            }
          }
        }
      }
      const liveChatWsSet = new Set(collectAllChatDebuggerUrls(targets));
      for (const ws of Array.from(injectedChatFrameWsUrls)) {
        if (!liveChatWsSet.has(ws)) injectedChatFrameWsUrls.delete(ws);
      }
    }

    let keptAnyRouteWatcher = false;
    let hasActiveVsCodeAttachment = false;
    for (const target of targets) {
      try {
        if (target.skipOverlayInjection || (!enabled && !target.isVsCodeHost)) {
          await disposeSingleTarget(target.webSocketDebuggerUrl);
          continue;
        }

        const targetMountMode = resolveTargetMountMode(target);
        if (targetMountMode === 'composer' && target.isIdeWorkbench) {
          const chatList = Array.isArray(target.ideChatTargets) ? target.ideChatTargets : [];
          let chatComposerActive = false;
          for (const chatTarget of chatList) {
            if (!chatTarget.webSocketDebuggerUrl) continue;
            try {
              const chatState = await syncSingleTarget(chatTarget, {
                ideRouteOverride: chatTarget.cascadeId || target.ideRouteCascadeId,
                ideRouteResolved: true,
                isIdeChatFrame: true,
                effectiveMountMode: 'composer',
              });
              if (chatState.alive && chatState.visible && chatState.dockKind === 'composer') {
                chatComposerActive = true;
              }
            } catch {
              // 单个聊天子视图异常不阻断主窗口兜底
            }
          }
          if (chatComposerActive || target.isVsCodeHost) {
            if (target.isVsCodeHost && chatComposerActive) {
              hasActiveVsCodeAttachment = true;
            }
            // VS Code 扩展在输入框模式下仅挂载于聊天输入框，扩展未打开时不污染顶栏
            await disposeSingleTarget(target.webSocketDebuggerUrl);
          } else {
            if (chatList.length > 0) keptAnyRouteWatcher = true;
            const routeState = await resolveIdeWorkbenchRouteState(target);
            await syncSingleTarget(target, {
              ideRouteOverride: routeState.routeId,
              ideRouteResolved: routeState.resolved,
              effectiveMountMode: targetMountMode,
            });
          }
          continue;
        }

        if (
          target.isIdeWorkbench &&
          Array.isArray(target.ideChatTargets) &&
          target.ideChatTargets.length > 0
        ) {
          keptAnyRouteWatcher = true;
        }
        const routeState = target.isIdeWorkbench
          ? await resolveIdeWorkbenchRouteState(target)
          : { resolved: false, routeId: '' };
        const syncedState = await syncSingleTarget(target, {
          ideRouteOverride: routeState.routeId,
          ideRouteResolved: routeState.resolved,
          effectiveMountMode: targetMountMode,
        });
        if (target.isVsCodeHost && syncedState?.alive) {
          hasActiveVsCodeAttachment = true;
        }
      } catch {
        // 单个窗口注入异常不阻断其他窗口
      }
    }
    if (!keptAnyRouteWatcher) {
      hadRouteWatchers = false;
    }

    if (hasActiveVsCodeAttachment || hasActiveVsCodeTarget) {
      for (const p of localVsCodeSupport.portCandidates) {
        rememberedVsCodePortFiles.add(p);
      }
    } else {
      for (const p of Array.from(rememberedVsCodePortFiles)) {
        if (!localVsCodeSupport.portCandidates.includes(p)) rememberedVsCodePortFiles.delete(p);
      }
    }

    pruneStaleRemoteEndpoints(activeRemoteWsUrls);
    ideSshCoordinator.pruneInactiveHosts(activeIdeSshHostKeys);
    cdpFallbackActive = sawCdpTransport;
    if (aliveCount > 0) {
      consecutiveActiveCdpMisses = 0;
    }
    const effectiveBridgeEnabled = Boolean(enabled || hasActiveVsCodeTarget);
    const finalBridgeState =
      antigravityNeedsCdp && antigravityTargets.length === 0 && antigravityLivePorts.length === 0
        ? hadDeadAntigravityPort
          ? 'cdp_unreachable'
          : 'no_devtools_port'
        : aliveCount > 0
          ? 'active'
          : 'no_targets';
    updateBridgeStatus(finalBridgeState, {
      enabled: effectiveBridgeEnabled,
      aliveCount,
      targets: targets.length,
      leasedBySelf,
      bundleVersion,
      prevLease: currentLease,
    });
    return {
      ok: true,
      enabled: effectiveBridgeEnabled,
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
    if (stopped || stopping) {
      return Promise.resolve({ ok: false, reason: 'stopped' });
    }
    const normalizedOpts = { forceReinject: Boolean(opts?.forceReinject) };
    if (syncInFlight) {
      pendingSyncOpts = {
        forceReinject: Boolean(pendingSyncOpts?.forceReinject || normalizedOpts.forceReinject),
      };
      if (!pendingSyncPromise) {
        const flushPending = () => {
          const nextOpts = pendingSyncOpts;
          pendingSyncOpts = null;
          pendingSyncPromise = null;
          if (stopped || stopping || !nextOpts) {
            return { ok: false, reason: 'stopped' };
          }
          return syncAllWindows(nextOpts);
        };
        pendingSyncPromise = syncInFlight.then(flushPending, flushPending);
      }
      return pendingSyncPromise;
    }
    syncInFlight = runSyncInternal(normalizedOpts).finally(() => {
      syncInFlight = null;
    });
    return syncInFlight;
  }

  function scheduleNextPoll() {
    if (stopped || stopping) return;
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
    stopping = false;
    contextWindowBootId = `${process.pid}:${Date.now()}`;
    if (bindRemoteRpcInvoker) {
      setRemoteWindowRpcInvoker(invokeRemoteWindowRpc);
    }
    if (initialTimer) clearTimeout(initialTimer);
    if (pollTimer) clearTimeout(pollTimer);

    if (leaseFilePath) {
      touchSelfPeerInLease({ force: true });
    }

    if (leaseFilePath && !hasActiveExternalLeaderLease()) {
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
    stopping = true;
    try {
      if (initialTimer) {
        clearTimeout(initialTimer);
        initialTimer = null;
      }
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      if (routePingTimer) {
        clearTimeout(routePingTimer);
        routePingTimer = null;
      }
      pendingSyncOpts = null;
      pendingSyncPromise = null;
      let shouldDisposeWindows = Boolean(
        disposeWindows &&
          (hadInjectedTargets ||
            injectedChatFrameWsUrls.size > 0 ||
            hadRouteWatchers ||
            hadContextWindows ||
            appliedContextWindowWsUrls.size > 0 ||
            hadHostI18n ||
            appliedHostI18nWsUrls.size > 0)
      );
      let leaseReleasedInStop = false;
      if (leaseFilePath) {
        const currentLease = loadJson(leaseFilePath, null);
        const leasePid = Number(currentLease?.pid || 0);
        const otherHostAlive = hasOtherLiveUsageMonitorHost(currentLease);
        if (otherHostAlive) {
          shouldDisposeWindows = false;
        }
        if (currentLease && typeof currentLease === 'object') {
          const isSelfLeader = leasePid === process.pid;
          const hadSelfPeer = Boolean(currentLease?.peers?.[String(process.pid)]);
          if (isSelfLeader || hadSelfPeer) {
            try {
              saveLeaseWithPeers(
                isSelfLeader ? { ...currentLease, pid: 0, updatedAtMs: 0 } : currentLease,
                { includeSelf: false, baseLease: currentLease }
              );
              leaseReleasedInStop = true;
            } catch {
              // 忽略租约释放失败
            }
          }
        }
      }
      if (shouldDisposeWindows) {
        const prevStopped = stopped;
        stopped = false;
        try {
          const cdpPorts = findActiveDevToolsPorts();
          if (cdpPorts.length) {
            const { targets, hostI18nExtraWsUrls } = await collectAllMainWindowTargets(
              cdpPorts
            ).catch(() => ({
              targets: [],
              hostI18nExtraWsUrls: [],
            }));
            const disposeExpr = `(() => {
              try {
                window.__agUsageMonitorRouteWatcher?.dispose?.();
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
            const allUrls = new Set([
              ...targets.map((t) => String(t.webSocketDebuggerUrl || '')).filter(Boolean),
              ...collectAllChatDebuggerUrls(targets),
            ]);
            for (const wsUrl of allUrls) {
              await evaluateOnTarget(wsUrl, disposeExpr).catch(() => {});
            }
            const disposeHostI18nExpr = createHostI18nDisposeExpression();
            for (const extraWsUrl of new Set(hostI18nExtraWsUrls)) {
              if (extraWsUrl && !allUrls.has(extraWsUrl)) {
                await evaluateOnTarget(extraWsUrl, disposeHostI18nExpr).catch(() => {});
              }
            }
          }
        } finally {
          stopped = prevStopped;
        }
      }
      stopped = true;
      hadInjectedTargets = false;
      injectedChatFrameWsUrls.clear();
      rememberedVsCodePortFiles.clear();
      appliedContextWindowWsUrls.clear();
      appliedHostI18nWsUrls.clear();
      hadRouteWatchers = false;
      activeIdeSshHostKeys = new Set();
      hadContextWindows = false;
      hadHostI18n = false;
      lastHostI18nAppliedCount = 0;
      cachedHostI18nApply = { revision: '', bootId: '', expr: '' };
      lastBridgeHttpActivityMs = 0;
      consecutiveActiveCdpMisses = 0;
      portProber.clearCache();
      localVsCodeSupportCache.clear();
      ideSshCoordinator.disposeAll();
      if (leaseFilePath && !leaseReleasedInStop) {
        const curLease = loadJson(leaseFilePath, null);
        if (curLease && Number(curLease.pid || 0) === process.pid) {
          saveLeaseWithPeers(
            {
              ...curLease,
              pid: 0,
              updatedAtMs: 0,
            },
            { includeSelf: false, baseLease: curLease }
          );
        }
      }
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
    } finally {
      stopped = true;
      stopping = false;
    }
  }

  function stripManagedLaunchersWhenIdle(cur) {
    if (!autoConfigureIdeArgv) return;
    const allowAuto = normalizeAutoConfigureLaunch(cur?.autoConfigureLaunch);
    const transitionedOff = lastObservedUserAutoLaunch === true && !allowAuto;
    lastObservedUserAutoLaunch = allowAuto;
    if (!allowAuto) {
      ensureVsCodeRemoteDebuggingArgv({
        env,
        homeDir,
        enabled: false,
        enableRemoteSsh: false,
        platform,
      });
      vsCodeLauncherProvisioned = false;
      lastVsCodeLauncherProvisionAtMs = 0;
    }
    if (!allowAuto && !transitionedOff && !managedLaunchersActive) {
      return;
    }
    lastLauncherProvisionAtMs = 0;
    void provisionHostLaunchersOnce({ fastCheckIfActive: false, targetEnabled: false }).catch(
      () => {}
    );
  }

  function notifySettingChanged(enabled) {
    const cur = getSettingsFn() || {};
    localVsCodeSupportCache.clear();
    if (!normalizeEnableRemoteSshTelemetry(cur.enableRemoteSshTelemetry)) {
      activeIdeSshHostKeys = new Set();
      ideSshCoordinator.disposeAll();
    }
    if (!enabled) {
      hadInjectedTargets = true;
      const hasCtx =
        isContextWindowFeatureActive(cur) &&
        Object.keys(cur.modelContextWindows || {}).length > 0 &&
        cur.contextWindowMainEnabled !== false;
      const hasHostI18n = Boolean(
        typeof getHostI18nDescriptorFn === 'function' && getHostI18nDescriptorFn()?.active
      );
      if (!hasCtx && !hasHostI18n) {
        stripManagedLaunchersWhenIdle(cur);
      }
      if (normalizeAutoConfigureLaunch(cur.autoConfigureLaunch)) {
        lastVsCodeLauncherProvisionAtMs = 0;
      }
    } else {
      if (!normalizeAutoConfigureLaunch(cur.autoConfigureLaunch)) {
        stripManagedLaunchersWhenIdle(cur);
      } else {
        lastLauncherProvisionAtMs = 0;
        lastVsCodeLauncherProvisionAtMs = 0;
      }
    }
    return syncAllWindows({ forceReinject: false }).catch(() => ({ ok: false }));
  }

  function notifyContextWindowsChanged() {
    const cur = getSettingsFn() || {};
    const mountMode = normalizeWindowMountMode(cur.windowMountMode, cur.enableWindowOverlay);
    const overlayOn = Boolean(cur.enableWindowOverlay !== false && mountMode !== 'sidebar');
    const hasCtx =
      isContextWindowFeatureActive(cur) &&
      Object.keys(cur.modelContextWindows || {}).length > 0 &&
      cur.contextWindowMainEnabled !== false;
    const hasHostI18n = Boolean(
      typeof getHostI18nDescriptorFn === 'function' && getHostI18nDescriptorFn()?.active
    );
    if (hasCtx) {
      if (normalizeAutoConfigureLaunch(cur.autoConfigureLaunch)) {
        lastLauncherProvisionAtMs = 0;
      }
    } else if (!overlayOn && !hasHostI18n) {
      stripManagedLaunchersWhenIdle(cur);
    }
    return syncAllWindows({ forceReinject: false }).catch(() => ({ ok: false }));
  }

  function notifyHostI18nChanged() {
    const cur = getSettingsFn() || {};
    const mountMode = normalizeWindowMountMode(cur.windowMountMode, cur.enableWindowOverlay);
    const overlayOn = Boolean(cur.enableWindowOverlay !== false && mountMode !== 'sidebar');
    const hasCtx =
      isContextWindowFeatureActive(cur) &&
      Object.keys(cur.modelContextWindows || {}).length > 0 &&
      cur.contextWindowMainEnabled !== false;
    const hasHostI18n = Boolean(
      typeof getHostI18nDescriptorFn === 'function' && getHostI18nDescriptorFn()?.active
    );
    if (hasHostI18n) {
      if (normalizeAutoConfigureLaunch(cur.autoConfigureLaunch)) {
        lastLauncherProvisionAtMs = 0;
      }
    } else {
      hadHostI18n = true;
      if (!overlayOn && !hasCtx) {
        stripManagedLaunchersWhenIdle(cur);
      }
    }
    return syncAllWindows({ forceReinject: false }).catch(() => ({ ok: false }));
  }

  async function collectHostI18nUntranslatedFromTargets() {
    const cdpPorts = findActiveDevToolsPorts();
    if (!cdpPorts.length) {
      return { targets: 0, items: [] };
    }
    const { targets, hostI18nExtraWsUrls } = await collectAllMainWindowTargets(cdpPorts).catch(
      () => ({ targets: [], hostI18nExtraWsUrls: [] })
    );
    const wsUrls = collectHostI18nTargetWsUrls(targets, hostI18nExtraWsUrls);
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
    const macSnap = inspectMacOsLaunchWrapperStatus();
    return {
      state: 'pending',
      enabled: true,
      aliveCount: 0,
      targets: 0,
      argvUpdatedThisBoot: false,
      argvConfigured: false,
      launcherConfigured: false,
      hasReadOnlyShortcuts: false,
      stalePortDetected: false,
      targetProduct: 'auto',
      macWrapperExists: Boolean(macSnap.exists),
      macDesktopWrapperExists: Boolean(macSnap.desktopExists),
      macIdeWrapperExists: Boolean(macSnap.ideExists),
      macWrapperPaths: macSnap.paths || [],
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
      leaseFilePath: SHARED_BRIDGE_LEASE_FILE,
      dataDir: DATA_DIR,
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
