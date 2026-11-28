/**
 * @fileoverview 标准 VS Code / VS Code Insiders 扩展与本机 `agy` CLI 插件支持探测及端口候选解析。
 *
 * 职责：
 * 1. 检测 `~/.vscode` / `~/.vscode-insiders` 是否安装 Google Antigravity 官方扩展或 Remote-SSH 扩展；
 * 2. 跨平台检测本机是否安装 `agy` CLI 及其 `usage-monitor` 插件（复用 `cli-statusline-config.mjs` 的配置解析）；
 * 3. 解析标准 VS Code / VS Code Insiders 的 `DevToolsActivePort` 与 `argv.json` 路径（与 Antigravity 桌面端隔离）；
 * 4. 提供有界 TTL 内存缓存，避免高频 CDP 同步循环重复遍历 `PATH` 与扩展目录。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  getCliStatusLineRuntimeStatus,
  isManagedCliStatusLineCommand,
} from './cli-statusline-config.mjs';

const VSCODE_ANTIGRAVITY_EXT_RE = /^google\.google-antigravity(?:[-.@]|$)/i;
const VSCODE_REMOTE_SSH_EXT_RE = /^ms-vscode-remote\.remote-ssh(?:[-.@]|$)/i;
const DEFAULT_LOCAL_SUPPORT_CACHE_TTL_MS = 15_000;

export const VSCODE_HOST_VARIANTS = Object.freeze([
  Object.freeze({ key: 'stable', rootName: '.vscode', dataDirName: 'Code' }),
  Object.freeze({ key: 'insiders', rootName: '.vscode-insiders', dataDirName: 'Code - Insiders' }),
]);

function hasExtensionMatching(vsCodeUserRoot, pattern, fsOps = null, env = null) {
  const cleanRoot = String(vsCodeUserRoot || '').trim();
  const readdirFn = fsOps?.readdirFn || readdirSync;
  const dirs = [];
  if (cleanRoot) dirs.push(join(cleanRoot, 'extensions'));
  const explicitExtDir = String(env?.VSCODE_EXTENSIONS || '').trim();
  if (explicitExtDir && !dirs.includes(explicitExtDir)) {
    dirs.push(explicitExtDir);
  }
  for (const extDir of dirs) {
    try {
      const entries = readdirFn(extDir) || [];
      for (const rawEntry of entries) {
        const name = typeof rawEntry === 'string' ? rawEntry : String(rawEntry?.name || '');
        if (pattern.test(name)) {
          return true;
        }
      }
    } catch {
      // 忽略不存在或不可读的扩展目录
    }
  }
  return false;
}

/**
 * 检查指定的 VS Code 用户配置目录（如 `~/.vscode`、`~/.vscode-insiders`）下是否已安装
 * Google Antigravity 官方扩展（`google.google-antigravity`）。
 *
 * @param {string} vsCodeUserRoot
 * @param {{ readdirFn?: typeof readdirSync }|null} [fsOps=null]
 * @param {Record<string, string|undefined>|null} [env=null]
 * @returns {boolean}
 */
export function hasVsCodeAntigravityExtension(vsCodeUserRoot, fsOps = null, env = null) {
  return hasExtensionMatching(vsCodeUserRoot, VSCODE_ANTIGRAVITY_EXT_RE, fsOps, env);
}

/**
 * 检查指定的 VS Code 用户配置目录下是否安装了 Remote-SSH 扩展。
 *
 * @param {string} vsCodeUserRoot
 * @param {{ readdirFn?: typeof readdirSync }|null} [fsOps=null]
 * @param {Record<string, string|undefined>|null} [env=null]
 * @returns {boolean}
 */
export function hasVsCodeRemoteSshExtension(vsCodeUserRoot, fsOps = null, env = null) {
  return hasExtensionMatching(vsCodeUserRoot, VSCODE_REMOTE_SSH_EXT_RE, fsOps, env);
}

/**
 * 检查本机是否安装了 Antigravity CLI（`~/.gemini/antigravity-cli` 目录或 `agy` 可执行文件）。
 * 兼容 Windows `Path`/`PATH`/`path` 大小写差异、带引号 PATH 项以及 `agy.exe` / `agy.cmd`。
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @param {string} [homeDir=homedir()]
 * @param {{ existsFn?: typeof existsSync }|null} [fsOps=null]
 * @param {string} [platform=process.platform]
 * @returns {boolean}
 */
export function hasLocalAgyCli(
  env = process.env,
  homeDir = homedir(),
  fsOps = null,
  platform = process.platform
) {
  const existsFn = fsOps?.existsFn || existsSync;
  const geminiBase = String(env?.ANTIGRAVITY_GEMINI_DIR || '').trim() || join(homeDir, '.gemini');
  try {
    if (existsFn(join(geminiBase, 'antigravity-cli'))) {
      return true;
    }
  } catch {
    // 忽略目录不可读
  }

  const exeNames = platform === 'win32' ? ['agy.exe', 'agy.cmd', 'agy'] : ['agy'];
  const binDirCandidates =
    platform === 'win32'
      ? [
          join(homeDir, '.local', 'bin'),
          join(homeDir, '.gemini', 'bin'),
          join(env?.LOCALAPPDATA || join(homeDir, 'AppData', 'Local'), 'Programs', 'agy'),
        ]
      : [
          join(homeDir, '.local', 'bin'),
          join(homeDir, '.gemini', 'bin'),
          '/usr/local/bin',
          '/opt/homebrew/bin',
        ];

  for (const dir of binDirCandidates) {
    for (const exe of exeNames) {
      try {
        if (existsFn(join(dir, exe))) return true;
      } catch {
        // 忽略不可读候选路径
      }
    }
  }

  const rawPath = String(env?.PATH || env?.Path || env?.path || '').trim();
  if (rawPath) {
    const sep = platform === 'win32' ? ';' : ':';
    for (const rawDir of rawPath.split(sep)) {
      const cleanDir = rawDir.trim().replace(/^"+|"+$/g, '');
      if (!cleanDir) continue;
      for (const exe of exeNames) {
        try {
          if (existsFn(join(cleanDir, exe))) return true;
        } catch {
          // 忽略不可读 PATH 目录
        }
      }
    }
  }
  return false;
}

/**
 * 检查本机是否同时安装了 `agy` CLI 及其 `usage-monitor` 插件。
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @param {string} [homeDir=homedir()]
 * @param {{ existsFn?: typeof existsSync, readFileFn?: typeof readFileSync }|null} [fsOps=null]
 * @param {string} [platform=process.platform]
 * @returns {boolean}
 */
export function hasLocalAgyCliPlugin(
  env = process.env,
  homeDir = homedir(),
  fsOps = null,
  platform = process.platform
) {
  if (!hasLocalAgyCli(env, homeDir, fsOps, platform)) return false;
  const existsFn = fsOps?.existsFn || existsSync;
  const readFileFn = fsOps?.readFileFn || readFileSync;
  const geminiBase = String(env?.ANTIGRAVITY_GEMINI_DIR || '').trim() || join(homeDir, '.gemini');
  const pluginManifestCandidates = [
    join(geminiBase, 'config', 'plugins', 'usage-monitor', 'plugin.json'),
    join(geminiBase, 'antigravity-cli', 'plugins', 'usage-monitor', 'plugin.json'),
  ];
  for (const manifestPath of pluginManifestCandidates) {
    try {
      if (existsFn(manifestPath)) return true;
    } catch {
      // 忽略不可读路径
    }
  }

  if (!fsOps) {
    const runtimeStatus = getCliStatusLineRuntimeStatus({ env, homeDir });
    if (runtimeStatus.configured) return true;
  }

  try {
    const cliSettingsPath = join(geminiBase, 'antigravity-cli', 'settings.json');
    if (existsFn(cliSettingsPath)) {
      const raw = String(readFileFn(cliSettingsPath, 'utf8') || '').replace(/^\uFEFF/, '').trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        const sl = parsed?.statusLine;
        if (
          sl &&
          typeof sl === 'object' &&
          sl.enabled !== false &&
          isManagedCliStatusLineCommand(sl.command)
        ) {
          return true;
        }
      }
    }
  } catch {
    // 忽略损坏或不可读配置
  }
  return false;
}

/**
 * 检查本机标准 VS Code / VS Code Insiders 是否安装了 Antigravity 官方扩展。
 *
 * @param {string} [homeDir=homedir()]
 * @param {{ readdirFn?: typeof readdirSync }|null} [fsOps=null]
 * @param {Record<string, string|undefined>|null} [env=null]
 * @returns {boolean}
 */
export function hasAnyLocalVsCodeAntigravityExtension(homeDir = homedir(), fsOps = null, env = null) {
  for (const variant of VSCODE_HOST_VARIANTS) {
    if (hasVsCodeAntigravityExtension(join(homeDir, variant.rootName), fsOps, env)) {
      return true;
    }
  }
  return false;
}

/**
 * 判断指定的标准 VS Code 目录是否应纳入 Antigravity 探测与 `argv.json` 维护范围：
 * 满足本机已装 `google.google-antigravity` 扩展、本机已装 `agy` CLI `usage-monitor` 插件，
 * 或（在 `enableRemoteSsh !== false` 时）已装 `ms-vscode-remote.remote-ssh` 扩展任一条件即启用。
 *
 * @param {string} vsCodeUserRoot
 * @param {Record<string, string|undefined>} [env=process.env]
 * @param {string} [homeDir=homedir()]
 * @param {{ readdirFn?: typeof readdirSync, existsFn?: typeof existsSync, readFileFn?: typeof readFileSync }|null} [fsOps=null]
 * @param {{ enableRemoteSsh?: boolean, platform?: string }} [options]
 * @returns {boolean}
 */
export function hasVsCodeAntigravitySupport(
  vsCodeUserRoot,
  env = process.env,
  homeDir = homedir(),
  fsOps = null,
  options = undefined
) {
  const enableRemoteSsh = options?.enableRemoteSsh !== false;
  const platform = options?.platform || process.platform;
  if (hasVsCodeAntigravityExtension(vsCodeUserRoot, fsOps, env)) {
    return true;
  }
  if (enableRemoteSsh && hasVsCodeRemoteSshExtension(vsCodeUserRoot, fsOps, env)) {
    return true;
  }
  if (hasLocalAgyCliPlugin(env, homeDir, fsOps, platform)) {
    return true;
  }
  return false;
}

/**
 * 解析符合条件的标准 VS Code / VS Code Insiders 的 `DevToolsActivePort` 候选路径。
 * 与 Antigravity 桌面端 / IDE 候选路径隔离，避免相互污染陈旧端口判定与重拉引导。
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @param {string} [platform=process.platform]
 * @param {string} [homeDir=homedir()]
 * @param {{ readdirFn?: typeof readdirSync, existsFn?: typeof existsSync, readFileFn?: typeof readFileSync }|null} [fsOps=null]
 * @param {{ enableRemoteSsh?: boolean }} [options]
 * @returns {string[]}
 */
export function resolveVsCodeDevToolsPortCandidates(
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  fsOps = null,
  options = undefined
) {
  if (String(env?.ANTIGRAVITY_DEVTOOLS_PORT_FILE || '').trim()) {
    return [];
  }
  const variants = VSCODE_HOST_VARIANTS.map((v) => ({
    userRoot: join(homeDir, v.rootName),
    dataDirName: v.dataDirName,
  })).filter((v) =>
    hasVsCodeAntigravitySupport(v.userRoot, env, homeDir, fsOps, {
      enableRemoteSsh: options?.enableRemoteSsh !== false,
      platform,
    })
  );

  if (variants.length === 0) {
    return [];
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

  for (const { dataDirName } of variants) {
    if (platform === 'win32') {
      const appData = env?.APPDATA || join(homeDir, 'AppData', 'Roaming');
      const localAppData = env?.LOCALAPPDATA || join(homeDir, 'AppData', 'Local');
      pushUnique(join(appData, dataDirName, 'DevToolsActivePort'));
      pushUnique(join(localAppData, dataDirName, 'DevToolsActivePort'));
      continue;
    }
    if (platform === 'darwin') {
      pushUnique(join(homeDir, 'Library', 'Application Support', dataDirName, 'DevToolsActivePort'));
      pushUnique(join(homeDir, '.config', dataDirName, 'DevToolsActivePort'));
      continue;
    }
    const defaultConfigHome = join(homeDir, '.config');
    const configHome = env?.XDG_CONFIG_HOME || defaultConfigHome;
    pushUnique(join(configHome, dataDirName, 'DevToolsActivePort'));
    if (configHome !== defaultConfigHome) {
      pushUnique(join(defaultConfigHome, dataDirName, 'DevToolsActivePort'));
    }
  }

  return out;
}

/**
 * 创建带 TTL 的本机 VS Code / CLI 支持探测缓存，避免每轮 CDP 轮询同步扫描 `PATH` 与扩展目录。
 *
 * @param {{ ttlMs?: number, nowFn?: () => number }} [options]
 */
export function createLocalVsCodeSupportCache(options = {}) {
  const ttlMs = Math.max(1000, Number(options.ttlMs) || DEFAULT_LOCAL_SUPPORT_CACHE_TTL_MS);
  const nowFn = options.nowFn || Date.now;
  let cachedKey = '';
  let cachedAtMs = 0;
  let cachedValue = null;

  function getSnapshot({
    env = process.env,
    platform = process.platform,
    homeDir = homedir(),
    enableRemoteSsh = true,
    fsOps = null,
    forceRefresh = false,
  } = {}) {
    const key = `${platform}::${homeDir}::${enableRemoteSsh ? '1' : '0'}::${String(env?.ANTIGRAVITY_GEMINI_DIR || '')}::${String(env?.ANTIGRAVITY_DEVTOOLS_PORT_FILE || '')}`;
    const now = nowFn();
    if (!forceRefresh && cachedValue && cachedKey === key && now - cachedAtMs < ttlMs) {
      return cachedValue;
    }
    const hasLocalExtByVariant = {};
    let hasLocalExt = false;
    for (const variant of VSCODE_HOST_VARIANTS) {
      const present = hasVsCodeAntigravityExtension(join(homeDir, variant.rootName), fsOps, env);
      hasLocalExtByVariant[variant.key] = present;
      if (present) hasLocalExt = true;
    }
    const hasLocalCliPlugin = hasLocalAgyCliPlugin(env, homeDir, fsOps, platform);
    const portCandidates = resolveVsCodeDevToolsPortCandidates(env, platform, homeDir, fsOps, {
      enableRemoteSsh,
    });
    const hasAnySupport = hasLocalExt || hasLocalCliPlugin || portCandidates.length > 0;
    cachedKey = key;
    cachedAtMs = now;
    cachedValue = {
      hasLocalExt,
      hasLocalExtByVariant,
      hasLocalCliPlugin,
      hasAnySupport,
      portCandidates,
    };
    return cachedValue;
  }

  return {
    getSnapshot,
    clear() {
      cachedKey = '';
      cachedAtMs = 0;
      cachedValue = null;
    },
  };
}
