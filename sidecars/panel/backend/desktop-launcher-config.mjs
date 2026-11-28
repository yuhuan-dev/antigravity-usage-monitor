/**
 * @fileoverview Antigravity Desktop 2.33.0+ 跨平台启动入口自动补齐与一键带参重拉控制器。
 *
 * 背景：
 * Antigravity Desktop (`Antigravity.exe` / `Antigravity.app` / `antigravity`) 自 `2.33.0` 起
 * 默认不再于启动时开启 `--remote-debugging-port=0`，且独立 Electron 桌面端不读取 VS Code 系的 `argv.json`。
 *
 * 本模块在不触碰任何宿主二进制与 `app.asar` 的前提下，提供两层恢复闭环：
 * 1. 日常全自动层 (`ensureDesktopLaunchEntriesConfigured`，后台零弹窗)：
 *    - Windows：自动为个人桌面（含子文件夹及并存的 OneDrive 桌面）、开始菜单、任务栏固定图标、启动文件夹中的
 *      `Antigravity.lnk`、`HKCU\...\Run` 自启项以及 `HKCU\Software\Classes` 下的 `antigravity://` 协议与文件关联
 *      补齐 `--remote-debugging-port=0`；若检测到 All-Users 公共桌面/开始菜单存在只读未修补快捷方式，如实上报
 *      `readOnlyPaths` 供用户点击重启按钮时按需触发 UAC 一次性修补（不在桌面制造双份重影图标）；
 *    - Linux：自动在 `~/.local/share/applications/antigravity.desktop` 与 `~/.config/autostart/antigravity.desktop`
 *      的 `Exec=`（兼容 `env` 前缀与 `.AppImage`）中补齐 `--remote-debugging-port=0`；
 *    - 当用户切回「仅侧边栏」且无上下文窗口覆写时，干净剥离本插件托管的 `--remote-debugging-port=0`，保留用户自定义端口；
 * 2. 当下裸启动会话一键重拉层 (`triggerDesktopHostRelaunch`)：
 *    - Windows 自适应当前权限层级（已提权走 WMI `Win32_Process.Create` 保权脱离 Job Object；普通权限走 `Shell.Application`
 *      并回退 WMI；若存在公共只读快捷方式或已提权的旧宿主进程驻留，则在用户点击重启后请求一次 `-Verb RunAs` UAC 授权完成修补与关闭，
 *      随后按宿主原有权限层级重拉以避免破坏资源管理器文件拖拽）；
 *    - macOS / Linux 通过独立后台会话关闭旧实例、清理陈旧 `DevToolsActivePort` 并追加 `--remote-debugging-port=0` 重开。
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  readlinkSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, win32 as pathWin32 } from 'node:path';
import { DATA_DIR, HERE, lsRuntimeEndpoint } from './config.mjs';
import { classifyDevToolsPortProduct } from './devtools-port-probe.mjs';
import { writeTextFileAtomicSync } from './fs-atomic.mjs';

export const REMOTE_DEBUG_LAUNCH_FLAG = '--remote-debugging-port=0';
export const MACOS_MANAGED_WRAPPER_KEY = 'com.yuhuan.usageMonitor.managedWrapper';

const REMOTE_DEBUG_ANY_RE = /(?:^|\s)--remote-debugging-port(?:=|\s|$)/i;
const REMOTE_DEBUG_MANAGED_ZERO_RE = /(?:^|\s+)--remote-debugging-port=(?:"0"|'0'|0)(?=\s|$)/gi;

function normalizeLauncherProduct(rawProduct, fallback = 'desktop') {
  const clean = String(rawProduct || '').trim().toLowerCase();
  if (clean === 'ide' || clean === 'desktop' || clean === 'both') return clean;
  return fallback;
}

function matchesWindowsExeLeafForProduct(exeLeaf, product = 'desktop') {
  const lower = String(exeLeaf || '').trim().toLowerCase();
  const normProd = normalizeLauncherProduct(product, 'desktop');
  if (normProd === 'ide') return lower === 'antigravity ide.exe';
  if (normProd === 'both') return lower === 'antigravity.exe' || lower === 'antigravity ide.exe';
  return lower === 'antigravity.exe';
}

/**
 * 解析 Windows PowerShell 5.1 可执行文件绝对路径（防止用户精简系统或异常 `PATH` 丢失裸 `powershell.exe`）。
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @param {(p: string) => boolean} [existsFn=existsSync]
 * @returns {string}
 */
export function resolveWindowsPowerShellExecutable(env = process.env, existsFn = existsSync) {
  const sysRoot = String(env?.SystemRoot || env?.WINDIR || 'C:\\Windows').trim();
  if (sysRoot) {
    const candidate = pathWin32.join(
      sysRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    );
    try {
      if (existsFn(candidate)) return candidate;
    } catch {
      // 忽略文件系统探测异常，回退命令名
    }
  }
  return 'powershell.exe';
}

/**
 * 在命令行参数字符串中幂等补齐或移除托管的 `--remote-debugging-port=0`，保留用户自定义的其它参数或自定义端口。
 *
 * @param {unknown} rawArgs
 * @param {{ enabled?: boolean }} [options]
 * @returns {{ changed: boolean, configured: boolean, alreadyConfigured?: boolean, removed?: boolean, args: string }}
 */
export function ensureRemoteDebugFlagInArgs(rawArgs, { enabled = true } = {}) {
  const current = String(rawArgs ?? '').trim();
  if (enabled) {
    if (REMOTE_DEBUG_ANY_RE.test(current)) {
      return {
        changed: false,
        configured: true,
        alreadyConfigured: true,
        args: current,
      };
    }
    const nextArgs = current
      ? `${current} ${REMOTE_DEBUG_LAUNCH_FLAG}`
      : REMOTE_DEBUG_LAUNCH_FLAG;
    return {
      changed: true,
      configured: true,
      args: nextArgs,
    };
  }

  if (!REMOTE_DEBUG_MANAGED_ZERO_RE.test(current)) {
    REMOTE_DEBUG_MANAGED_ZERO_RE.lastIndex = 0;
    return {
      changed: false,
      configured: REMOTE_DEBUG_ANY_RE.test(current),
      args: current,
    };
  }
  REMOTE_DEBUG_MANAGED_ZERO_RE.lastIndex = 0;
  const stripped = current.replace(REMOTE_DEBUG_MANAGED_ZERO_RE, ' ').replace(/\s{2,}/g, ' ').trim();
  return {
    changed: stripped !== current,
    configured: REMOTE_DEBUG_ANY_RE.test(stripped),
    removed: stripped !== current,
    args: stripped,
  };
}

/**
 * 解析并无损修补 Windows `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 自启命令行字符串。
 * 严格仅匹配目标可执行文件名为 `Antigravity.exe` 的项（排除 `Antigravity IDE.exe` 及无关程序）。
 *
 * @param {unknown} rawValue
 * @param {{ enabled?: boolean }} [options]
 * @returns {{ matched: boolean, changed: boolean, configured: boolean, value: string }}
 */
export function patchWindowsRunRegistryCommand(rawValue, { enabled = true, product = 'desktop' } = {}) {
  const raw = String(rawValue ?? '').trim();
  if (!raw) {
    return { matched: false, changed: false, configured: false, value: raw };
  }
  const m = raw.match(/^\s*(?:"([^"]+)"|([^\s"]+))([\s\S]*)$/);
  if (!m) {
    return { matched: false, changed: false, configured: false, value: raw };
  }
  const exePath = String(m[1] || m[2] || '').trim();
  const exeLeaf = exePath.split(/[\\/]/).pop() || '';
  if (!matchesWindowsExeLeafForProduct(exeLeaf, product)) {
    return { matched: false, changed: false, configured: false, value: raw };
  }
  const quotedExe = m[1] ? `"${exePath}"` : /\s/.test(exePath) ? `"${exePath}"` : exePath;
  const patchedArgs = ensureRemoteDebugFlagInArgs(m[3] || '', { enabled });
  const nextValue = patchedArgs.args ? `${quotedExe} ${patchedArgs.args}` : quotedExe;
  return {
    matched: true,
    changed: nextValue !== raw,
    configured: patchedArgs.configured,
    value: nextValue,
  };
}

/**
 * 解析并无损修补 Windows `HKCU\Software\Classes\...\shell\open\command` 协议与文件关联命令行。
 * 将 `--remote-debugging-port=0` 置于主程序路径之后、原有 `--` 或 `"%1"` 占位符之前，确保 Chromium 将其识别为开关而非文件路径。
 *
 * @param {unknown} rawValue
 * @param {{ enabled?: boolean, product?: 'desktop'|'ide'|'both' }} [options]
 * @returns {{ matched: boolean, changed: boolean, configured: boolean, value: string }}
 */
export function patchWindowsShellOpenCommand(rawValue, { enabled = true, product = 'desktop' } = {}) {
  const raw = String(rawValue ?? '').trim();
  if (!raw) {
    return { matched: false, changed: false, configured: false, value: raw };
  }
  const m = raw.match(/^\s*(?:"([^"]+)"|([^\s"]+))([\s\S]*)$/);
  if (!m) {
    return { matched: false, changed: false, configured: false, value: raw };
  }
  const exePath = String(m[1] || m[2] || '').trim();
  const exeLeaf = exePath.split(/[\\/]/).pop() || '';
  if (!matchesWindowsExeLeafForProduct(exeLeaf, product)) {
    return { matched: false, changed: false, configured: false, value: raw };
  }
  const quotedExe = m[1] ? `"${exePath}"` : /\s/.test(exePath) ? `"${exePath}"` : exePath;
  const rest = String(m[3] || '').trim();

  if (enabled) {
    if (REMOTE_DEBUG_ANY_RE.test(rest)) {
      return { matched: true, changed: false, configured: true, value: raw };
    }
    const nextValue = rest
      ? `${quotedExe} ${REMOTE_DEBUG_LAUNCH_FLAG} ${rest}`
      : `${quotedExe} ${REMOTE_DEBUG_LAUNCH_FLAG}`;
    return {
      matched: true,
      changed: nextValue !== raw,
      configured: true,
      value: nextValue,
    };
  }

  const stripped = ensureRemoteDebugFlagInArgs(rest, { enabled: false });
  const nextValue = stripped.args ? `${quotedExe} ${stripped.args}` : quotedExe;
  return {
    matched: true,
    changed: nextValue !== raw,
    configured: stripped.configured,
    value: nextValue,
  };
}

function isLinuxAntigravityDesktopLeaf(leaf) {
  const lower = String(leaf || '').trim().toLowerCase();
  if (!lower || lower.includes('ide')) return false;
  return /^(?:google[-_])?antigravity(?:$|[-_.\d]|(?:\.appimage$))/i.test(lower);
}

function isLinuxAntigravityIdeLeaf(leaf) {
  const lower = String(leaf || '').trim().toLowerCase();
  if (!lower) return false;
  return /^(?:google[-_])?antigravity[-_.\s]*ide(?:$|[-_.\d]|(?:\.appimage$))/i.test(lower);
}

function matchesLinuxExeLeafForProduct(leaf, product = 'desktop') {
  const normProd = normalizeLauncherProduct(product, 'desktop');
  if (normProd === 'ide') return isLinuxAntigravityIdeLeaf(leaf);
  if (normProd === 'both') {
    return isLinuxAntigravityDesktopLeaf(leaf) || isLinuxAntigravityIdeLeaf(leaf);
  }
  return isLinuxAntigravityDesktopLeaf(leaf);
}

function isWindowsVendorSubdirName(dirName) {
  const lower = String(dirName || '').trim().toLowerCase();
  if (!lower) return false;
  return lower.includes('antigravity') || /^google(?:\b|[\s_-]|$)/i.test(lower);
}

function splitLinuxExecTokens(cmdBody) {
  const tokens = [];
  const re = /(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"']+)+/g;
  let m;
  while ((m = re.exec(cmdBody)) !== null) {
    tokens.push({ raw: m[0], start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

function stripOuterQuotes(tok) {
  if (
    (tok.startsWith('"') && tok.endsWith('"')) ||
    (tok.startsWith("'") && tok.endsWith("'"))
  ) {
    return tok.slice(1, -1);
  }
  return tok;
}

/**
 * 修补 Linux XDG `.desktop` 文件文本中的 `Exec=` 启动行。
 * 兼容 `Exec=env VAR=1 ...` 前缀与 `Antigravity-*.AppImage` 可执行文件，严格排除 `antigravity-ide`。
 *
 * @param {string} rawText
 * @param {{ enabled?: boolean }} [options]
 * @returns {{ matched: boolean, changed: boolean, configured: boolean, text: string }}
 */
export function patchLinuxDesktopEntryText(rawText, { enabled = true, product = 'desktop' } = {}) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return { matched: false, changed: false, configured: false, text: String(rawText || '') };
  }
  const eol = rawText.includes('\r\n') ? '\r\n' : '\n';
  const lines = rawText.split(/\r?\n/);
  let matched = false;
  let changed = false;
  let configured = false;

  const nextLines = lines.map((line) => {
    const execMatch = line.match(/^(\s*Exec\s*=\s*)(.+)$/);
    if (!execMatch) return line;
    const prefix = execMatch[1];
    const cmdBody = execMatch[2].trim();
    const tokens = splitLinuxExecTokens(cmdBody);
    if (!tokens.length) return line;

    let binIdx = 0;
    const firstLeaf = (stripOuterQuotes(tokens[0].raw).split('/').pop() || '').toLowerCase();
    if (firstLeaf === 'env') {
      binIdx = 1;
      while (binIdx < tokens.length) {
        const unquoted = stripOuterQuotes(tokens[binIdx].raw);
        if (unquoted === '-u' || unquoted === '--unset') {
          binIdx += 2;
          continue;
        }
        if (
          unquoted === '-S' ||
          unquoted === '-i' ||
          unquoted === '--ignore-environment' ||
          unquoted.startsWith('--unset=') ||
          /^[A-Za-z_][A-Za-z0-9_]*=/.test(unquoted)
        ) {
          binIdx += 1;
          continue;
        }
        break;
      }
    }
    if (binIdx >= tokens.length) return line;

    const exeTok = tokens[binIdx];
    const exeLeaf = stripOuterQuotes(exeTok.raw).split('/').pop() || '';
    if (!matchesLinuxExeLeafForProduct(exeLeaf, product)) {
      return line;
    }

    matched = true;
    const headThroughExe = cmdBody.slice(0, exeTok.end).trim();
    const rest = cmdBody.slice(exeTok.end).trim();

    if (enabled) {
      if (REMOTE_DEBUG_ANY_RE.test(rest)) {
        configured = true;
        return line;
      }
      configured = true;
      changed = true;
      const doubleDashMatch = rest.match(/^(.*?)(?:^|\s)(--(?:\s+.*)?)$/);
      if (doubleDashMatch) {
        const beforeDash = doubleDashMatch[1].trim();
        const fromDash = doubleDashMatch[2].trim();
        const mid = beforeDash
          ? `${beforeDash} ${REMOTE_DEBUG_LAUNCH_FLAG}`
          : REMOTE_DEBUG_LAUNCH_FLAG;
        return `${prefix}${headThroughExe} ${mid} ${fromDash}`;
      }
      const fieldCodeMatch = rest.match(/^(.*?)\s*(%[fFuUdDnNickvm](?:\s+%[fFuUdDnNickvm])*)\s*$/);
      if (fieldCodeMatch) {
        const beforeCodes = fieldCodeMatch[1].trim();
        const codes = fieldCodeMatch[2].trim();
        const mid = beforeCodes
          ? `${beforeCodes} ${REMOTE_DEBUG_LAUNCH_FLAG}`
          : REMOTE_DEBUG_LAUNCH_FLAG;
        return `${prefix}${headThroughExe} ${mid} ${codes}`;
      }
      return rest
        ? `${prefix}${headThroughExe} ${rest} ${REMOTE_DEBUG_LAUNCH_FLAG}`
        : `${prefix}${headThroughExe} ${REMOTE_DEBUG_LAUNCH_FLAG}`;
    }

    const stripped = ensureRemoteDebugFlagInArgs(rest, { enabled: false });
    configured = configured || stripped.configured;
    if (!stripped.changed) return line;
    changed = true;
    return stripped.args ? `${prefix}${headThroughExe} ${stripped.args}` : `${prefix}${headThroughExe}`;
  });

  return {
    matched,
    changed,
    configured,
    text: changed ? nextLines.join(eol) : rawText,
  };
}

function stripAppImageMountPathEntries(rawVal, { omitIfEmpty = false } = {}) {
  const str = String(rawVal ?? '');
  if (!str || !str.includes('/.mount_')) {
    return str;
  }
  const parts = str.split(':').filter((entry) => {
    const trimmed = entry.trim();
    return trimmed && !trimmed.startsWith('/tmp/.mount_') && !trimmed.includes('/.mount_');
  });
  if (parts.length === 0 && omitIfEmpty) {
    return null;
  }
  return parts.join(':');
}

/**
 * 清理 Sidecar / MCP 子进程继承的宿主会话私有环境变量，确保重拉后的客户端运行于纯净桌面上下文。
 * 同时剔除 Linux AppImage 挂载期注入的临时变量与 `/tmp/.mount_*` 路径，防止旧挂载卸载后新进程加载失败。
 *
 * @param {Record<string, string|undefined>} [baseEnv=process.env]
 * @returns {Record<string, string>}
 */
export function buildSanitizedDesktopRelaunchEnv(baseEnv = process.env) {
  const clean = {};
  for (const [key, val] of Object.entries(baseEnv || {})) {
    if (val === undefined || val === null) continue;
    if (
      /^(?:ANTIGRAVITY_|CHROME_DEVTOOLS_MCP_|USAGE_MONITOR_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$|APPIMAGE$|APPDIR$|OWD$|ARGV0$|APPIMAGE_EXTRACT_AND_RUN$)/i.test(
        key
      )
    ) {
      continue;
    }
    if (key === 'LD_LIBRARY_PATH') {
      const cleanedLib = stripAppImageMountPathEntries(val, { omitIfEmpty: true });
      if (cleanedLib !== null) {
        clean[key] = cleanedLib;
      }
      continue;
    }
    if (key === 'PATH' && String(val).includes('/.mount_')) {
      const cleanedPath = stripAppImageMountPathEntries(val, { omitIfEmpty: false });
      if (cleanedPath) {
        clean[key] = cleanedPath;
      }
      continue;
    }
    clean[key] = String(val);
  }
  return clean;
}

/**
 * 自动定位本机 Antigravity Desktop（或 IDE）主程序路径（优先从 `USAGE_MONITOR_HOST_EXE` / `APPIMAGE` / `ANTIGRAVITY_AGENTAPI_EXE` 反推，回退标准安装目录）。
 *
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   platform?: string,
 *   homeDir?: string,
 *   existsFn?: (p: string) => boolean,
 * }} [options]
 * @returns {{ found: boolean, kind: 'desktop'|'ide'|'', executablePath: string, appBundlePath: string }}
 */
export function resolveDesktopHostExecutable({
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  existsFn = existsSync,
  preferredProduct = 'auto',
  envHintsOnly = false,
} = {}) {
  const pref = String(preferredProduct || 'auto').trim().toLowerCase();
  const allowsKind = (kind) => pref === 'auto' || pref === kind;
  const safeExists = (p) => {
    try {
      return Boolean(p && existsFn(p));
    } catch {
      return false;
    }
  };

  if (platform === 'linux') {
    const appImagePath = String(env?.APPIMAGE || '').trim();
    if (appImagePath && safeExists(appImagePath)) {
      const leaf = basename(appImagePath);
      if (allowsKind('desktop') && isLinuxAntigravityDesktopLeaf(leaf)) {
        return { found: true, kind: 'desktop', executablePath: appImagePath, appBundlePath: '' };
      }
      if (allowsKind('ide') && isLinuxAntigravityIdeLeaf(leaf)) {
        return { found: true, kind: 'ide', executablePath: appImagePath, appBundlePath: '' };
      }
    }
  }

  const hintPaths = [
    String(env?.USAGE_MONITOR_HOST_EXE || '').trim(),
    String(env?.ANTIGRAVITY_AGENTAPI_EXE || '').trim(),
    String(env?.CHROME_DEVTOOLS_MCP_JS || '').trim(),
  ].filter(Boolean);

  for (const rawHint of hintPaths) {
    if (platform === 'darwin') {
      const appIdx = rawHint.toLowerCase().indexOf('.app/');
      const bundleCand =
        appIdx >= 0
          ? rawHint.slice(0, appIdx + 4)
          : rawHint.toLowerCase().endsWith('.app')
            ? rawHint
            : '';
      if (bundleCand && safeExists(bundleCand)) {
        const isIde = /antigravity[\s_-]*ide\.app$/i.test(bundleCand);
        const kind = isIde ? 'ide' : 'desktop';
        if (allowsKind(kind)) {
          const macBin = join(
            bundleCand,
            'Contents',
            'MacOS',
            isIde ? 'Antigravity IDE' : 'Antigravity'
          );
          const electronBin = join(bundleCand, 'Contents', 'MacOS', 'Electron');
          return {
            found: true,
            kind,
            executablePath: safeExists(macBin)
              ? macBin
              : safeExists(electronBin)
                ? electronBin
                : bundleCand,
            appBundlePath: bundleCand,
          };
        }
      }
    }

    if (platform === 'win32' && /\.exe$/i.test(rawHint) && !/language_server/i.test(rawHint)) {
      if (safeExists(rawHint)) {
        const isIde = /antigravity\s*ide\.exe$/i.test(rawHint);
        const kind = isIde ? 'ide' : 'desktop';
        if (allowsKind(kind)) {
          return {
            found: true,
            kind,
            executablePath: rawHint,
            appBundlePath: '',
          };
        }
      }
    }

    let cur = rawHint;
    for (let depth = 0; depth < 8 && cur && dirname(cur) !== cur; depth += 1) {
      const base = basename(cur).toLowerCase();
      if (base === 'resources') {
        const installRoot = dirname(cur);
        if (platform === 'win32') {
          if (allowsKind('desktop')) {
            const desktopExe = join(installRoot, 'Antigravity.exe');
            if (safeExists(desktopExe)) {
              return { found: true, kind: 'desktop', executablePath: desktopExe, appBundlePath: '' };
            }
          }
          if (allowsKind('ide')) {
            const ideExe = join(installRoot, 'Antigravity IDE.exe');
            if (safeExists(ideExe)) {
              return { found: true, kind: 'ide', executablePath: ideExe, appBundlePath: '' };
            }
          }
        } else if (platform === 'linux') {
          if (allowsKind('desktop')) {
            for (const binName of ['antigravity', 'Antigravity']) {
              const linuxExe = join(installRoot, binName);
              if (safeExists(linuxExe) && !installRoot.startsWith('/tmp/.mount_')) {
                return { found: true, kind: 'desktop', executablePath: linuxExe, appBundlePath: '' };
              }
            }
          }
          if (allowsKind('ide')) {
            for (const binName of ['antigravity-ide', 'Antigravity IDE']) {
              const linuxIdeExe = join(installRoot, binName);
              if (safeExists(linuxIdeExe) && !installRoot.startsWith('/tmp/.mount_')) {
                return { found: true, kind: 'ide', executablePath: linuxIdeExe, appBundlePath: '' };
              }
            }
          }
        }
      }
      cur = dirname(cur);
    }
  }

  if (envHintsOnly) {
    return { found: false, kind: '', executablePath: '', appBundlePath: '' };
  }

  if (platform === 'win32') {
    const localAppData = env?.LOCALAPPDATA || join(homeDir, 'AppData', 'Local');
    const programFiles = env?.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = String(env?.['ProgramFiles(x86)'] || '').trim();
    const winDesktopCandidates = [
      join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'),
      join(programFiles, 'Antigravity', 'Antigravity.exe'),
      ...(programFilesX86 ? [join(programFilesX86, 'Antigravity', 'Antigravity.exe')] : []),
      join(localAppData, 'Antigravity', 'Antigravity.exe'),
    ];
    const winIdeCandidates = [
      join(localAppData, 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe'),
      join(programFiles, 'Antigravity IDE', 'Antigravity IDE.exe'),
      ...(programFilesX86
        ? [join(programFilesX86, 'Antigravity IDE', 'Antigravity IDE.exe')]
        : []),
      join(localAppData, 'Antigravity IDE', 'Antigravity IDE.exe'),
    ];
    const orderedGroups =
      pref === 'ide'
        ? [{ kind: 'ide', list: winIdeCandidates }]
        : pref === 'desktop'
          ? [{ kind: 'desktop', list: winDesktopCandidates }]
          : [
              { kind: 'desktop', list: winDesktopCandidates },
              { kind: 'ide', list: winIdeCandidates },
            ];
    for (const group of orderedGroups) {
      for (const cand of group.list) {
        if (safeExists(cand)) {
          return { found: true, kind: group.kind, executablePath: cand, appBundlePath: '' };
        }
      }
    }
  } else if (platform === 'darwin') {
    const macDesktopBundles = [
      join(homeDir, 'Applications', 'Antigravity.app'),
      '/Applications/Antigravity.app',
    ];
    const macIdeBundles = [
      join(homeDir, 'Applications', 'Antigravity IDE.app'),
      '/Applications/Antigravity IDE.app',
    ];
    const orderedMacGroups =
      pref === 'ide'
        ? [{ kind: 'ide', bin: 'Antigravity IDE', list: macIdeBundles }]
        : pref === 'desktop'
          ? [{ kind: 'desktop', bin: 'Antigravity', list: macDesktopBundles }]
          : [
              { kind: 'desktop', bin: 'Antigravity', list: macDesktopBundles },
              { kind: 'ide', bin: 'Antigravity IDE', list: macIdeBundles },
            ];
    for (const group of orderedMacGroups) {
      for (const bundlePath of group.list) {
        if (safeExists(bundlePath)) {
          const macBin = join(bundlePath, 'Contents', 'MacOS', group.bin);
          const electronBin = join(bundlePath, 'Contents', 'MacOS', 'Electron');
          return {
            found: true,
            kind: group.kind,
            executablePath: safeExists(macBin)
              ? macBin
              : safeExists(electronBin)
                ? electronBin
                : bundlePath,
            appBundlePath: bundlePath,
          };
        }
      }
    }
  } else {
    const linuxDesktopCandidates = [
      '/opt/Antigravity/antigravity',
      '/opt/Antigravity/Antigravity',
      '/opt/antigravity/antigravity',
      '/usr/share/antigravity/antigravity',
      '/usr/bin/antigravity',
      '/usr/bin/google-antigravity',
      '/usr/local/bin/antigravity',
      join(homeDir, '.local', 'bin', 'antigravity'),
    ];
    const linuxIdeCandidates = [
      '/opt/Antigravity IDE/antigravity-ide',
      '/opt/antigravity-ide/antigravity-ide',
      '/usr/share/antigravity-ide/antigravity-ide',
      '/usr/bin/antigravity-ide',
      '/usr/local/bin/antigravity-ide',
      join(homeDir, '.local', 'bin', 'antigravity-ide'),
    ];
    const orderedLinuxGroups =
      pref === 'ide'
        ? [{ kind: 'ide', list: linuxIdeCandidates }]
        : pref === 'desktop'
          ? [{ kind: 'desktop', list: linuxDesktopCandidates }]
          : [
              { kind: 'desktop', list: linuxDesktopCandidates },
              { kind: 'ide', list: linuxIdeCandidates },
            ];
    for (const group of orderedLinuxGroups) {
      for (const cand of group.list) {
        if (safeExists(cand)) {
          return { found: true, kind: group.kind, executablePath: cand, appBundlePath: '' };
        }
      }
    }
  }

  return { found: false, kind: '', executablePath: '', appBundlePath: '' };
}

async function runLauncherExecFile(file, args, options = {}) {
  const cpMod = await import('node:child_process');
  const execFileFn = cpMod.execFile || cpMod.default?.execFile;
  if (typeof execFileFn !== 'function') {
    throw new Error('child_process.execFile unavailable');
  }
  return new Promise((resolve, reject) => {
    execFileFn(
      file,
      args,
      {
        windowsHide: true,
        timeout: options.timeoutMs || 9000,
        maxBuffer: 1024 * 1024,
        env: options.env || process.env,
      },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(String(stdout || ''));
      }
    );
  });
}

async function spawnDetachedProcess(file, args, options = {}) {
  const cpMod = await import('node:child_process');
  const spawnFn = cpMod.spawn || cpMod.default?.spawn;
  if (typeof spawnFn !== 'function') {
    throw new Error('child_process.spawn unavailable');
  }
  const child = spawnFn(file, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: options.cwd || undefined,
    env: options.env || process.env,
  });
  child.unref?.();
  return { pid: Number(child?.pid || 0) };
}

function writeTextFileAtomically(filePath, content, fsOps) {
  writeTextFileAtomicSync(filePath, content, fsOps);
}

/**
 * 检查单个 Windows `.lnk` 二进制 Buffer 是否指向 `Antigravity.exe`（排除 `Antigravity IDE.exe`）及是否已包含调试端口参数。
 * 基于 `[MS-SHLLINK]` 原始字节扫描，纯内存耗时 `< 0.1ms`，无需拉起任何外部子进程或 COM 组件。
 *
 * @param {Buffer} buf
 * @returns {{ matched: boolean, hasDebugPort: boolean }}
 */
export function inspectWindowsLnkBuffer(buf, { product = 'desktop' } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 32 || buf.length > 65536) {
    return { matched: false, hasDebugPort: false };
  }
  const normProd = normalizeLauncherProduct(product, 'desktop');
  const ascii = buf.toString('latin1').toLowerCase();
  const utf16 = buf.toString('utf16le').toLowerCase();
  const hasIde =
    ascii.includes('\\antigravity ide.exe') ||
    utf16.includes('\\antigravity ide.exe') ||
    ascii.includes('/antigravity ide.exe') ||
    utf16.includes('/antigravity ide.exe') ||
    ascii.includes('antigravity ide.exe') ||
    utf16.includes('antigravity ide.exe');
  const hasDesktopExe =
    ascii.includes('\\antigravity.exe') ||
    utf16.includes('\\antigravity.exe') ||
    ascii.includes('/antigravity.exe') ||
    utf16.includes('/antigravity.exe');
  if (normProd === 'ide') {
    if (!hasIde) return { matched: false, hasDebugPort: false };
  } else if (normProd === 'both') {
    if (!hasIde && !hasDesktopExe) return { matched: false, hasDebugPort: false };
  } else {
    if (hasIde || !hasDesktopExe) return { matched: false, hasDebugPort: false };
  }
  const hasDebugPort =
    ascii.includes('--remote-debugging-port') || utf16.includes('--remote-debugging-port');
  return { matched: true, hasDebugPort };
}

/**
 * 纯 Node.js 零子进程快速扫描当前机器上的 `Antigravity.exe` / `Antigravity IDE.exe` 快捷方式配置状态（耗时通常 `< 2ms`）。
 * 桌面与任务栏严格仅扫描顶层 `.lnk`（绝不进入用户项目文件夹或 `node_modules`），开始菜单仅检查顶层及 Antigravity/Google 一级厂商子目录。
 *
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   homeDir?: string,
 *   extraDirs?: string[],
 *   product?: 'desktop'|'ide'|'both',
 *   fsOps?: {
 *     readdirFn?: typeof readdirSync,
 *     statFn?: typeof statSync,
 *     readFn?: typeof readFileSync,
 *   }|null,
 * }} [options]
 */
export function probeWindowsShortcutsFast({
  env = process.env,
  homeDir = homedir(),
  extraDirs = [],
  product = 'desktop',
  fsOps = null,
} = {}) {
  const readdirFn = fsOps?.readdirFn || readdirSync;
  const statFn = fsOps?.statFn || statSync;
  const readFn = fsOps?.readFn || readFileSync;

  const zhDesktop = '\u684C\u9762';
  const userProfile = String(env?.USERPROFILE || homeDir || '').trim();
  const appData = String(env?.APPDATA || (homeDir ? pathWin32.join(homeDir, 'AppData', 'Roaming') : '')).trim();
  const publicRoot = String(env?.PUBLIC || 'C:\\Users\\Public').trim();
  const programData = String(env?.ProgramData || 'C:\\ProgramData').trim();

  const flatDirs = [];
  if (Array.isArray(extraDirs)) {
    for (const d of extraDirs) {
      const clean = String(d || '').trim();
      if (clean) flatDirs.push(clean);
    }
  }
  if (userProfile) {
    flatDirs.push(pathWin32.join(userProfile, 'Desktop'), pathWin32.join(userProfile, zhDesktop));
  }
  for (const od of [env?.OneDrive, env?.OneDriveConsumer, env?.OneDriveCommercial]) {
    const cleanOd = String(od || '').trim();
    if (cleanOd) {
      flatDirs.push(pathWin32.join(cleanOd, 'Desktop'), pathWin32.join(cleanOd, zhDesktop));
    }
  }
  if (appData) {
    flatDirs.push(
      pathWin32.join(appData, 'Microsoft', 'Windows', 'Start Menu'),
      pathWin32.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
      pathWin32.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar')
    );
  }
  if (publicRoot) {
    flatDirs.push(pathWin32.join(publicRoot, 'Desktop'), pathWin32.join(publicRoot, zhDesktop));
  }

  const programRoots = [];
  if (appData) {
    programRoots.push(pathWin32.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  }
  if (programData) {
    programRoots.push(pathWin32.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  }

  const seenDirs = new Set();
  const candidateLnks = [];
  const seenLnks = new Set();

  const collectTopLevelLnks = (dirPath, expandVendorSubdirs = false) => {
    if (!dirPath) return;
    const normDir = dirPath.toLowerCase();
    if (seenDirs.has(normDir)) return;
    seenDirs.add(normDir);
    let entries = [];
    try {
      entries = readdirFn(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const name = String(ent?.name || '');
      if (!name) continue;
      if (ent.isFile?.() && name.toLowerCase().endsWith('.lnk')) {
        const full = pathWin32.join(dirPath, name);
        const key = full.toLowerCase();
        if (!seenLnks.has(key)) {
          seenLnks.add(key);
          candidateLnks.push(full);
        }
      } else if (
        expandVendorSubdirs &&
        ent.isDirectory?.() &&
        isWindowsVendorSubdirName(name)
      ) {
        collectTopLevelLnks(pathWin32.join(dirPath, name), false);
      }
    }
  };

  for (const d of flatDirs) collectTopLevelLnks(d, false);
  for (const p of programRoots) collectTopLevelLnks(p, true);

  const matchedPaths = [];
  const configuredPaths = [];
  const unconfiguredPaths = [];

  for (const lnkPath of candidateLnks) {
    try {
      const st = statFn(lnkPath);
      if (!st || st.size < 32 || st.size > 65536) continue;
      const buf = readFn(lnkPath);
      const res = inspectWindowsLnkBuffer(buf, { product });
      if (!res.matched) continue;
      matchedPaths.push(lnkPath);
      if (res.hasDebugPort) {
        configuredPaths.push(lnkPath);
      } else {
        unconfiguredPaths.push(lnkPath);
      }
    } catch {
      // 忽略单个无权限或损坏的快捷方式文件
    }
  }

  return {
    matchedPaths,
    configuredPaths,
    unconfiguredPaths,
    allConfigured: matchedPaths.length > 0 && unconfiguredPaths.length === 0,
  };
}

let cachedWinShortcutProvisionPs = '';

function getWinShortcutProvisionPs() {
  if (!cachedWinShortcutProvisionPs) {
    cachedWinShortcutProvisionPs = readFileSync(
      join(HERE, 'backend', 'windows-shortcut-provision.ps1'),
      'utf8'
    ).trim();
  }
  return cachedWinShortcutProvisionPs;
}

const cachedDiscoveredWinDirsByHome = new Map();

function getCachedWinDiscoveredDirs(homeDir) {
  const key = String(homeDir || '').trim().toLowerCase();
  return cachedDiscoveredWinDirsByHome.get(key) || [];
}

function rememberWinDiscoveredDirs(homeDir, dirs) {
  if (!Array.isArray(dirs) || dirs.length === 0) return;
  const key = String(homeDir || '').trim().toLowerCase();
  const seen = new Set();
  const list = [];
  for (const d of dirs) {
    const clean = String(d || '').trim();
    if (!clean) continue;
    const norm = clean.toLowerCase();
    if (!seen.has(norm)) {
      seen.add(norm);
      list.push(clean);
    }
  }
  if (list.length > 0) {
    cachedDiscoveredWinDirsByHome.set(key, list);
  }
}

function collectLinuxDesktopCandidates(dirPath, ops, { filterByName = false, fallbackNames = [] } = {}) {
  const files = [];
  const seen = new Set();
  const joinDir = (name) =>
    dirPath.startsWith('/')
      ? `${dirPath.replace(/\/+$/, '')}/${name}`
      : join(dirPath, name);
  const addName = (name) => {
    const clean = String(name || '').trim();
    if (!clean || !clean.toLowerCase().endsWith('.desktop')) return;
    if (filterByName && !clean.toLowerCase().includes('antigravity')) return;
    const full = joinDir(clean);
    if (!seen.has(full)) {
      seen.add(full);
      files.push({ name: clean, full });
    }
  };

  try {
    const rawEntries = ops.readdirFn(dirPath);
    if (Array.isArray(rawEntries)) {
      let count = 0;
      for (const entry of rawEntries) {
        const name = typeof entry === 'string' ? entry : String(entry?.name || '');
        if (!name || !name.toLowerCase().endsWith('.desktop')) continue;
        count += 1;
        if (count > 256) break;
        addName(name);
      }
    }
  } catch {
    // 目录不存在或无读取权限时退回显式候选探测
  }

  for (const fallback of fallbackNames) {
    const full = joinDir(fallback);
    if (!seen.has(full) && ops.existsFn(full)) {
      seen.add(full);
      files.push({ name: fallback, full });
    }
  }
  return files;
}

function isBlockedInTestSandbox(allowInTest = false) {
  if (allowInTest) return false;
  if (lsRuntimeEndpoint.addr === 'test.invalid') return true;
  return Boolean(typeof process !== 'undefined' && process?.env?.NODE_TEST_CONTEXT);
}

/**
 * 自动同步当前系统下用户空间启动入口（Windows `.lnk` / `HKCU:Run` / `HKCU:Classes`、Linux `.desktop`）中的 `--remote-debugging-port=0`。
 *
 * @param {{
 *   enabled?: boolean,
 *   fastCheckIfActive?: boolean,
 *   env?: Record<string, string|undefined>,
 *   platform?: string,
 *   homeDir?: string,
 *   execFileFn?: ((file: string, args: string[], opts?: object) => Promise<string>)|null,
 *   fsOps?: {
 *     existsFn?: typeof existsSync,
 *     readFn?: typeof readFileSync,
 *     writeFn?: typeof writeFileSync,
 *     mkdirFn?: typeof mkdirSync,
 *     renameFn?: typeof renameSync,
 *     unlinkFn?: typeof unlinkSync,
 *     readdirFn?: typeof readdirSync,
 *     statFn?: typeof statSync,
 *   }|null,
 *   allowInTest?: boolean,
 * }} [options]
 */
export async function ensureDesktopLaunchEntriesConfigured({
  enabled = true,
  fastCheckIfActive = false,
  product = 'desktop',
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  execFileFn = null,
  fsOps = null,
  allowInTest = false,
} = {}) {
  const normProd = normalizeLauncherProduct(product, 'desktop');
  if (isBlockedInTestSandbox(allowInTest)) {
    return {
      checked: false,
      updated: false,
      alreadyConfigured: false,
      configured: false,
      hasReadOnlyShortcuts: false,
      updatedPaths: [],
      configuredPaths: [],
      readOnlyPaths: [],
      reason: 'test_sandbox_skipped',
    };
  }

  const ops = {
    existsFn: fsOps?.existsFn || existsSync,
    readFn: fsOps?.readFn || readFileSync,
    writeFn: fsOps?.writeFn || writeFileSync,
    mkdirFn: fsOps?.mkdirFn || mkdirSync,
    renameFn: fsOps?.renameFn || renameSync,
    unlinkFn: fsOps?.unlinkFn || unlinkSync,
    readdirFn: fsOps?.readdirFn || readdirSync,
    statFn: fsOps?.statFn || statSync,
  };

  if (platform === 'win32') {
    // 稳态零子进程快检：当调试端口已活跃或处于周期复检且所有 `.lnk` 字节内均已含参数时，直接返回（<2ms，不拉起 PowerShell）
    if (!execFileFn && fastCheckIfActive) {
      const fast = probeWindowsShortcutsFast({
        env,
        homeDir,
        extraDirs: getCachedWinDiscoveredDirs(homeDir),
        product: normProd,
        fsOps: ops,
      });
      if (enabled && fast.allConfigured) {
        return {
          checked: true,
          fastPath: true,
          updated: false,
          alreadyConfigured: true,
          configured: true,
          hasReadOnlyShortcuts: false,
          updatedPaths: [],
          configuredPaths: fast.configuredPaths,
          readOnlyPaths: [],
        };
      }
      if (!enabled && fast.configuredPaths.length === 0) {
        return {
          checked: true,
          fastPath: true,
          updated: false,
          alreadyConfigured: false,
          configured: false,
          hasReadOnlyShortcuts: false,
          updatedPaths: [],
          configuredPaths: [],
          readOnlyPaths: [],
        };
      }
    }

    try {
      const runner = execFileFn || runLauncherExecFile;
      const psExe = execFileFn ? 'powershell.exe' : resolveWindowsPowerShellExecutable(env, ops.existsFn);
      const out = await runner(
        psExe,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', getWinShortcutProvisionPs()],
        {
          timeoutMs: 10000,
          env: {
            ...env,
            AGY_LAUNCH_ENABLED: enabled ? '1' : '0',
            AGY_LAUNCH_PRODUCT: normProd,
          },
        }
      );
      const trimmed = String(out || '').trim();
      const jsonLine = trimmed.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{')) || '';
      const parsed = jsonLine ? JSON.parse(jsonLine) : null;
      const updatedPaths = Array.isArray(parsed?.updatedPaths)
        ? parsed.updatedPaths.map(String).filter(Boolean)
        : [];
      const configuredPaths = Array.isArray(parsed?.configuredPaths)
        ? parsed.configuredPaths.map(String).filter(Boolean)
        : [];
      const readOnlyPaths = Array.isArray(parsed?.readOnlyPaths)
        ? parsed.readOnlyPaths.map(String).filter(Boolean)
        : [];
      const hasSplitReadOnly = Boolean(
        Array.isArray(parsed?.readOnlyDesktopPaths) || Array.isArray(parsed?.readOnlyIdePaths)
      );
      const readOnlyDesktopPaths = Array.isArray(parsed?.readOnlyDesktopPaths)
        ? parsed.readOnlyDesktopPaths.map(String).filter(Boolean)
        : [];
      const readOnlyIdePaths = Array.isArray(parsed?.readOnlyIdePaths)
        ? parsed.readOnlyIdePaths.map(String).filter(Boolean)
        : [];
      if (Array.isArray(parsed?.discoveredDirs) && parsed.discoveredDirs.length > 0) {
        rememberWinDiscoveredDirs(homeDir, parsed.discoveredDirs);
      }
      const hasReadOnlyShortcuts = enabled && readOnlyPaths.length > 0;
      return {
        checked: true,
        updated: updatedPaths.length > 0,
        alreadyConfigured: updatedPaths.length === 0 && configuredPaths.length > 0,
        configured: configuredPaths.length > 0,
        hasReadOnlyShortcuts,
        updatedPaths,
        configuredPaths,
        readOnlyPaths,
        readOnlyDesktopPaths,
        readOnlyIdePaths,
        readOnlySplitByProduct: hasSplitReadOnly,
      };
    } catch (err) {
      return {
        checked: true,
        updated: false,
        alreadyConfigured: false,
        configured: false,
        hasReadOnlyShortcuts: false,
        updatedPaths: [],
        configuredPaths: [],
        readOnlyPaths: [],
        reason: 'win_shortcut_error',
        error: err?.message || String(err),
      };
    }
  }

  if (platform === 'linux') {
    const dataHome = env?.XDG_DATA_HOME || join(homeDir, '.local', 'share');
    const configHome = env?.XDG_CONFIG_HOME || join(homeDir, '.config');
    const userAppsDir = join(dataHome, 'applications');
    const userAutostartDir = join(configHome, 'autostart');
    const systemAppsDirs = [];
    const seenSysDirs = new Set([userAppsDir]);
    const addSysAppsDir = (d) => {
      const clean = String(d || '').trim();
      if (!clean || seenSysDirs.has(clean)) return;
      seenSysDirs.add(clean);
      systemAppsDirs.push(clean);
    };
    addSysAppsDir('/usr/share/applications');
    addSysAppsDir('/usr/local/share/applications');
    const rawDataDirs = String(env?.XDG_DATA_DIRS || '').trim();
    if (rawDataDirs) {
      const dataDirParts = /^[A-Za-z]:[\\/]/.test(rawDataDirs)
        ? rawDataDirs.split(';')
        : rawDataDirs.split(':');
      for (const base of dataDirParts) {
        const cleanBase = base.trim();
        if (cleanBase) {
          addSysAppsDir(
            cleanBase.startsWith('/')
              ? `${cleanBase.replace(/\/+$/, '')}/applications`
              : join(cleanBase, 'applications')
          );
        }
      }
    }

    const updatedPaths = [];
    const configuredPaths = [];
    const handledUserFileNames = new Set();

    const readDesktopTextSafe = (filePath) => {
      try {
        const st = ops.statFn(filePath);
        if (st && Number(st.size) > 65536) return '';
      } catch {
        // 允许单测 mock 仅实现 existsFn/readFn 而不提供 statFn
      }
      try {
        return String(ops.readFn(filePath, 'utf8') || '');
      } catch {
        return '';
      }
    };

    const fallbackDesktopNames =
      normProd === 'ide'
        ? ['antigravity-ide.desktop']
        : normProd === 'both'
          ? ['antigravity.desktop', 'antigravity-ide.desktop']
          : ['antigravity.desktop'];

    try {
      const userCandidates = collectLinuxDesktopCandidates(userAppsDir, ops, {
        filterByName: false,
        fallbackNames: fallbackDesktopNames,
      });
      for (const cand of userCandidates) {
        const rawText = readDesktopTextSafe(cand.full);
        if (!rawText) continue;
        const patched = patchLinuxDesktopEntryText(rawText, { enabled, product: normProd });
        if (!patched.matched) continue;
        handledUserFileNames.add(cand.name.toLowerCase());
        if (patched.changed) {
          writeTextFileAtomically(cand.full, patched.text, ops);
          updatedPaths.push(cand.full);
        }
        if (patched.configured) {
          configuredPaths.push(cand.full);
        }
      }

      if (enabled) {
        for (const sysDir of systemAppsDirs) {
          const sysCandidates = collectLinuxDesktopCandidates(sysDir, ops, {
            filterByName: true,
            fallbackNames: fallbackDesktopNames,
          });
          for (const cand of sysCandidates) {
            const nameKey = cand.name.toLowerCase();
            if (handledUserFileNames.has(nameKey)) continue;
            const rawText = readDesktopTextSafe(cand.full);
            if (!rawText) continue;
            const patched = patchLinuxDesktopEntryText(rawText, {
              enabled: true,
              product: normProd,
            });
            if (!patched.matched) continue;
            handledUserFileNames.add(nameKey);
            if (patched.changed) {
              const targetUserFile = join(userAppsDir, cand.name);
              writeTextFileAtomically(targetUserFile, patched.text, ops);
              updatedPaths.push(targetUserFile);
              if (patched.configured) {
                configuredPaths.push(targetUserFile);
              }
            } else if (patched.configured) {
              configuredPaths.push(cand.full);
            }
          }
        }
      }

      const autostartCandidates = collectLinuxDesktopCandidates(userAutostartDir, ops, {
        filterByName: false,
        fallbackNames: fallbackDesktopNames,
      });
      for (const cand of autostartCandidates) {
        const autoRaw = readDesktopTextSafe(cand.full);
        if (!autoRaw) continue;
        const patchedAuto = patchLinuxDesktopEntryText(autoRaw, { enabled, product: normProd });
        if (!patchedAuto.matched) continue;
        if (patchedAuto.changed) {
          writeTextFileAtomically(cand.full, patchedAuto.text, ops);
          updatedPaths.push(cand.full);
        }
        if (patchedAuto.configured) {
          configuredPaths.push(cand.full);
        }
      }

      return {
        checked: true,
        updated: updatedPaths.length > 0,
        alreadyConfigured: updatedPaths.length === 0 && configuredPaths.length > 0,
        configured: configuredPaths.length > 0,
        hasReadOnlyShortcuts: false,
        updatedPaths,
        configuredPaths,
        readOnlyPaths: [],
      };
    } catch (err) {
      return {
        checked: true,
        updated: false,
        alreadyConfigured: false,
        configured: false,
        hasReadOnlyShortcuts: false,
        updatedPaths,
        configuredPaths,
        readOnlyPaths: [],
        reason: 'linux_desktop_error',
        error: err?.message || String(err),
      };
    }
  }

  // macOS `.app` 包具有 Apple 代码签名，不修改签名目录，交由一键重拉 (`open -a ... --args`) 处理
  return {
    checked: true,
    updated: false,
    alreadyConfigured: false,
    configured: false,
    hasReadOnlyShortcuts: false,
    updatedPaths: [],
    configuredPaths: [],
    readOnlyPaths: [],
    reason: 'macos_app_bundle_signed',
  };
}

/**
 * 当静态环境变量与默认安装目录均未命中（如用户自定义安装至 D:/E: 盘、Linux 自定义目录或 AppImage）时，
 * 直接从当前正在运行的宿主进程动态反查主程序绝对路径。
 */
async function discoverRunningHostExecutable({
  platform = process.platform,
  env = process.env,
  execFileFn = null,
  preferredProduct = 'auto',
} = {}) {
  const pref = String(preferredProduct || 'auto').trim().toLowerCase();
  const allowsKind = (kind) => pref === 'auto' || pref === kind;
  const runner = execFileFn || runLauncherExecFile;
  if (platform === 'win32') {
    try {
      const psExe = execFileFn ? 'powershell.exe' : resolveWindowsPowerShellExecutable(env);
      const winProcNames =
        pref === 'ide'
          ? "'Antigravity IDE'"
          : pref === 'desktop'
            ? "'Antigravity'"
            : "'Antigravity','Antigravity IDE'";
      const ps = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; @(Get-Process -Name ${winProcNames} -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1) | ForEach-Object { [pscustomobject]@{ path = [string]$_.Path; name = [string]$_.ProcessName } } | ConvertTo-Json -Compress`;
      const out = await runner(
        psExe,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
        { timeoutMs: 4000 }
      );
      const trimmed = String(out || '').trim();
      if (trimmed && trimmed.startsWith('{')) {
        const parsed = JSON.parse(trimmed);
        const exePath = String(parsed?.path || '').trim();
        if (exePath) {
          const isIde = /ide/i.test(String(parsed?.name || '')) || /antigravity\s*ide\.exe$/i.test(exePath);
          const kind = isIde ? 'ide' : 'desktop';
          if (allowsKind(kind)) {
            return {
              found: true,
              kind,
              executablePath: exePath,
              appBundlePath: '',
            };
          }
        }
      }
    } catch {
      // 忽略动态进程探测异常
    }
  } else if (platform === 'darwin') {
    try {
      const psOut = await runner('ps', ['-axo', 'comm='], { timeoutMs: 3000 });
      for (const rawLine of String(psOut || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        const m = line.match(/^(\/.+?\.app)\/Contents\/MacOS\/([^/]+)$/i);
        if (!m) continue;
        const bundlePath = m[1];
        const binLeaf = m[2];
        if (!/antigravity/i.test(bundlePath) && !/antigravity/i.test(binLeaf)) continue;
        if (/helper/i.test(binLeaf) || /\(monitor\)\.app$/i.test(bundlePath)) continue;
        const kind = /antigravity[\s_-]*ide\.app$/i.test(bundlePath) ? 'ide' : 'desktop';
        if (!allowsKind(kind)) continue;
        return {
          found: true,
          kind,
          executablePath: line,
          appBundlePath: bundlePath,
        };
      }
    } catch {
      // 忽略 ps 探测异常，继续回退 AppleScript 路径解析
    }
    const osaNames =
      pref === 'ide'
        ? ['Antigravity IDE']
        : pref === 'desktop'
          ? ['Antigravity']
          : ['Antigravity', 'Antigravity IDE'];
    for (const appQueryName of osaNames) {
      try {
        const out = await runner(
          'osascript',
          ['-e', `POSIX path of (path to application "${appQueryName}")`],
          { timeoutMs: 3000 }
        );
        const bundlePath = String(out || '').trim().replace(/\/+$/, '');
        if (bundlePath && /\.app$/i.test(bundlePath)) {
          const kind = /antigravity[\s_-]*ide\.app$/i.test(bundlePath) ? 'ide' : 'desktop';
          if (allowsKind(kind)) {
            return {
              found: true,
              kind,
              executablePath: bundlePath,
              appBundlePath: bundlePath,
            };
          }
        }
      } catch {
        // 忽略 AppleScript 探测异常
      }
    }
  } else if (platform === 'linux') {
    const linuxProd = pref === 'ide' ? 'ide' : pref === 'desktop' ? 'desktop' : 'both';
    if (!execFileFn && typeof process.getuid === 'function') {
      try {
        const myUid = process.getuid();
        for (const name of readdirSync('/proc')) {
          if (!/^\d+$/.test(name)) continue;
          const procDir = `/proc/${name}`;
          try {
            const st = statSync(procDir);
            if (st.uid !== myUid) continue;
            const exeTarget = String(readlinkSync(`${procDir}/exe`) || '')
              .trim()
              .replace(/\s+\(deleted\)$/, '');
            if (!exeTarget) continue;
            const leaf = basename(exeTarget);
            if (!matchesLinuxExeLeafForProduct(leaf, linuxProd)) continue;
            const kind = isLinuxAntigravityIdeLeaf(leaf) ? 'ide' : 'desktop';
            try {
              const envRaw = readFileSync(`${procDir}/environ`, 'utf8');
              for (const entry of envRaw.split('\0')) {
                if (entry.startsWith('APPIMAGE=')) {
                  const appImg = entry.slice('APPIMAGE='.length).trim();
                  if (appImg && existsSync(appImg)) {
                    return { found: true, kind, executablePath: appImg, appBundlePath: '' };
                  }
                }
              }
            } catch {
              // 忽略 environ 读取异常
            }
            if (exeTarget.startsWith('/tmp/.mount_')) continue;
            return { found: true, kind, executablePath: exeTarget, appBundlePath: '' };
          } catch {
            // 忽略单个瞬态退出的进程目录
          }
        }
      } catch {
        // 忽略 /proc 原生扫描异常，回退外部命令探测
      }
    }
    if (execFileFn) {
      try {
        const out = await runner('/bin/sh', ['-c', 'true'], { timeoutMs: 2000 });
        const foundLinuxExe = String(out || '').trim().split(/\r?\n/)[0]?.trim() || '';
        if (foundLinuxExe) {
          const kind = isLinuxAntigravityIdeLeaf(basename(foundLinuxExe)) ? 'ide' : 'desktop';
          if (allowsKind(kind)) {
            return {
              found: true,
              kind,
              executablePath: foundLinuxExe,
              appBundlePath: '',
            };
          }
        }
      } catch {
        // 忽略模拟探测异常
      }
    }
  }
  return { found: false, kind: '', executablePath: '', appBundlePath: '' };
}

function psSingleQuote(val) {
  return `'${String(val ?? '').replace(/'/g, "''")}'`;
}

/**
 * 构建 Windows 脱离宿主 Job Object 的隐藏重拉内层脚本（写入临时 UTF-8 BOM `.ps1` 文件后拉起）。
 *
 * 权限自适应策略：
 * 1. 若存在 All-Users 只读公共快捷方式（`$readOnlyShortcuts.Count -gt 0`）且当前未提权，先通过 `-Verb RunAs`
 *    请求用户 UAC 授权一次性修补公共 `.lnk`（用户若点取消仍继续执行当次重拉，不阻塞会话恢复）；
 * 2. 先尝试常规温和关闭（`CloseMainWindow` + `Stop-Process`）；
 * 3. 若等待后仍有旧宿主进程存活（例如旧宿主是以管理员身份运行的，普通权限无法关闭），再请求一次 `-Verb RunAs`
 *    关闭旧管理员宿主并以管理员身份带参重开；
 * 4. 若当前脚本自身因提权运行但原宿主并非管理员（`$wasHostElevated -eq $false`），通过 `Shell.Application`
 *    委托桌面 `explorer.exe` 以普通权限启动新客户端，确保资源管理器文件拖拽进窗口不被 UIPI 阻断。
 *
 * @param {string} executablePath
 * @param {string[]} stalePortFiles
 * @param {'desktop'|'ide'|''} kind
 * @param {{ readOnlyShortcutPaths?: string[], psExePath?: string }} [extra]
 * @returns {string}
 */
function buildReadonlyShortcutPatchPsBlock(kind = 'desktop') {
  const normKind = normalizeLauncherProduct(kind, 'desktop');
  const buildExeLeafExpr = (varExpr) =>
    normKind === 'ide'
      ? `([System.IO.Path]::GetFileName(${varExpr}) -ieq 'Antigravity IDE.exe')`
      : normKind === 'both'
        ? `([System.IO.Path]::GetFileName(${varExpr}) -ieq 'Antigravity.exe' -or [System.IO.Path]::GetFileName(${varExpr}) -ieq 'Antigravity IDE.exe')`
        : `([System.IO.Path]::GetFileName(${varExpr}) -ieq 'Antigravity.exe')`;
  const regExeCond = buildExeLeafExpr('$exeCand');
  const lnkExeCond = buildExeLeafExpr('$lnkTarget');
  const coreLines = [
    '$ws = $null',
    'foreach ($item in $targets) {',
    '  if (-not $item) { continue }',
    "  if ($item.StartsWith('HKLM:Run:')) {",
    '    try {',
    '      $restKey = $item.Substring(9)',
    "      $sepIdx = $restKey.IndexOf('|')",
    '      if ($sepIdx -gt 0) {',
    '        $subPath = $restKey.Substring(0, $sepIdx)',
    '        $valName = $restKey.Substring($sepIdx + 1)',
    '        $rk = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($subPath, $false)',
    '        if ($rk) {',
    "          $rawCmd = [string]$rk.GetValue($valName, '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
    '          $rk.Close()',
    '          if ($rawCmd -match \'^\\s*(?:"([^"]+)"|([^\\s"]+))(.*)$\') {',
    '            $exeCand = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }',
    '            $restPart = [string]$Matches[3]',
    `            if (${regExeCond} -and $restPart -notmatch '(?:^|\\s)--remote-debugging-port(?:=|\\s|$)') {`,
    '              $qExe = if ($Matches[1] -or $exeCand -match \'\\s\') { \'"\' + $exeCand + \'"\' } else { $exeCand }',
    "              $nextVal = ($qExe + ' ' + ($restPart.Trim() + ' --remote-debugging-port=0').Trim()).Trim()",
    '              $wk = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($subPath, $true)',
    '              if ($wk) { $wk.SetValue($valName, $nextVal, [Microsoft.Win32.RegistryValueKind]::String); $wk.Close() }',
    '            }',
    '          }',
    '        }',
    '      }',
    '    } catch {}',
    '    continue',
    '  }',
    "  if ($item.StartsWith('HKLM:Class:')) {",
    '    try {',
    '      $relKey = $item.Substring(11)',
    '      $rk = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($relKey, $false)',
    '        if ($rk) {',
    "        $rawOpen = [string]$rk.GetValue('', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
    '        $rk.Close()',
    '        if ($rawOpen -match \'^\\s*(?:"([^"]+)"|([^\\s"]+))(.*)$\') {',
    '          $exeCand = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }',
    '          $restOpen = ([string]$Matches[3]).Trim()',
    `          if (${regExeCond} -and $restOpen -notmatch '(?:^|\\s)--remote-debugging-port(?:=|\\s|$)') {`,
    '            $qExe = if ($Matches[1] -or $exeCand -match \'\\s\') { \'"\' + $exeCand + \'"\' } else { $exeCand }',
    "            $nextOpen = if ($restOpen) { $qExe + ' --remote-debugging-port=0 ' + $restOpen } else { $qExe + ' --remote-debugging-port=0' }",
    '            $wk = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($relKey, $true)',
    "            if ($wk) { $wk.SetValue('', $nextOpen, [Microsoft.Win32.RegistryValueKind]::String); $wk.Close() }",
    '          }',
    '        }',
    '      }',
    '    } catch {}',
    '    continue',
    '  }',
    '  if (Test-Path -LiteralPath $item) {',
    '    try {',
    '      if (-not $ws) { $ws = New-Object -ComObject WScript.Shell }',
    '      $sc = $ws.CreateShortcut($item)',
    '      $lnkTarget = [string]$sc.TargetPath',
    '      $cur = [string]$sc.Arguments',
    `      if (${lnkExeCond} -and $cur -notmatch '(?:^|\\s)--remote-debugging-port(?:=|\\s|$)') {`,
    "        $sc.Arguments = ($cur.Trim() + ' --remote-debugging-port=0').Trim()",
    '        $sc.Save()',
    '      }',
    '    } catch {}',
    '  }',
    '}',
  ];
  const fnLines = [
    'function Patch-ShortcutList($targets) {',
    '  if (-not $targets -or $targets.Count -eq 0) { return }',
    ...coreLines.map((line) => `  ${line}`),
    '}',
  ].join('\n');
  const quotedLines = coreLines
    .map((line) => `      '${line.replace(/'/g, "''")}',`)
    .join('\n');
  return { fnLines, quotedLines };
}

export function buildWindowsRelaunchInnerScript(
  executablePath,
  stalePortFiles = [],
  kind = 'desktop',
  extra = {}
) {
  const procName = kind === 'ide' ? 'Antigravity IDE' : 'Antigravity';
  const psExe = String(extra?.psExePath || 'powershell.exe').trim() || 'powershell.exe';
  const { fnLines, quotedLines } = buildReadonlyShortcutPatchPsBlock(kind);
  const portLiterals = (Array.isArray(stalePortFiles) ? stalePortFiles : [])
    .map((p) => String(p || '').trim())
    .filter(Boolean)
    .map(psSingleQuote)
    .join(', ');
  const roLiterals = (Array.isArray(extra?.readOnlyShortcutPaths) ? extra.readOnlyShortcutPaths : [])
    .map((p) => String(p || '').trim())
    .filter(Boolean)
    .map(psSingleQuote)
    .join(', ');

  return `
param([string]$HostElevated = '0')
if ($PSCommandPath) {
  try { [System.IO.File]::WriteAllText(($PSCommandPath + '.ack'), [string]$PID) } catch {}
}
Start-Sleep -Milliseconds 480
$exe = ${psSingleQuote(executablePath)}
$procName = ${psSingleQuote(procName)}
$psExe = ${psSingleQuote(psExe)}
$staleList = @(${portLiterals})
$readOnlyShortcuts = @(${roLiterals})
$wasHostElevated = ($HostElevated -eq '1') -or ($env:AGY_HOST_WAS_ELEVATED -eq '1')
$isSelfElevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$mySid = (Get-Process -Id $PID).SessionId

if (-not $exe -or -not (Test-Path -LiteralPath $exe)) {
  $livePath = Get-Process -Name $procName -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $mySid -and $_.Path } | Select-Object -First 1 -ExpandProperty Path
  if ($livePath) { $exe = [string]$livePath }
}

${fnLines}

if ($readOnlyShortcuts.Count -gt 0) {
  if ($isSelfElevated) {
    Patch-ShortcutList $readOnlyShortcuts
  } else {
    $elevPatchPs1 = Join-Path ([System.IO.Path]::GetTempPath()) ("agy-monitor-uac-lnk-" + $PID + ".ps1")
    $roJoined = ($readOnlyShortcuts | ForEach-Object { "'" + ($_.Replace("'", "''")) + "'" }) -join ', '
    $elevBody = @(
      ('$targets = @(' + $roJoined + ')'),
${quotedLines}
      'Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue'
    ) -join "\`r\`n"
    try {
      [System.IO.File]::WriteAllText($elevPatchPs1, $elevBody, (New-Object System.Text.UTF8Encoding($true)))
      Start-Process -FilePath $psExe -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $elevPatchPs1) -ErrorAction Stop
    } catch {
      if (Test-Path -LiteralPath $elevPatchPs1) { Remove-Item -LiteralPath $elevPatchPs1 -Force -ErrorAction SilentlyContinue }
    }
  }
}

$findTargets = {
  @(Get-Process -Name $procName -ErrorAction SilentlyContinue | Where-Object {
    $_.SessionId -eq $mySid -and (-not $_.Path -or -not $exe -or [string]::Equals($_.Path, $exe, [System.StringComparison]::OrdinalIgnoreCase))
  })
}

$initial = & $findTargets
foreach ($p in $initial) {
  try {
    if ($p.MainWindowHandle -ne 0) { [void]$p.CloseMainWindow() }
  } catch {}
}
Start-Sleep -Milliseconds 850

$remaining = & $findTargets
foreach ($p in $remaining) {
  try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
}

for ($i = 0; $i -lt 25; $i++) {
  if ((& $findTargets).Count -eq 0) { break }
  Start-Sleep -Milliseconds 200
}

if ((& $findTargets).Count -gt 0 -and -not $isSelfElevated -and $exe -and (Test-Path -LiteralPath $exe)) {
  $elevRelaunchPs1 = Join-Path ([System.IO.Path]::GetTempPath()) ("agy-monitor-uac-relaunch-" + $PID + ".ps1")
  $staleJoined = ($staleList | ForEach-Object { "'" + ($_.Replace("'", "''")) + "'" }) -join ', '
  $exeLit = "'" + $exe.Replace("'", "''") + "'"
  $procLit = "'" + $procName.Replace("'", "''") + "'"
  $elevKillBody = @(
    ('$exe = ' + $exeLit),
    ('$procName = ' + $procLit),
    ('$staleList = @(' + $staleJoined + ')'),
    '$mySid = (Get-Process -Id $PID).SessionId',
    '$findTargets = { @(Get-Process -Name $procName -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $mySid -and (-not $_.Path -or -not $exe -or [string]::Equals($_.Path, $exe, [System.StringComparison]::OrdinalIgnoreCase)) }) }',
    '& $findTargets | Stop-Process -Force -ErrorAction SilentlyContinue',
    'for ($i = 0; $i -lt 25; $i++) { if ((& $findTargets).Count -eq 0) { break }; Start-Sleep -Milliseconds 200 }',
    'foreach ($fp in $staleList) { if ($fp -and (Test-Path -LiteralPath $fp)) { Remove-Item -LiteralPath $fp -Force -ErrorAction SilentlyContinue } }',
    'foreach ($ev in @(''ELECTRON_RUN_AS_NODE'', ''ELECTRON_NO_ATTACH_CONSOLE'', ''VSCODE_IPC_HOOK'', ''CHROME_CRASHPAD_PIPE_NAME'')) { Remove-Item -Path (''Env:\\'' + $ev) -ErrorAction SilentlyContinue }',
    '$wd = Split-Path -Parent $exe',
    'Start-Process -FilePath $exe -ArgumentList ''--remote-debugging-port=0'' -WorkingDirectory $wd',
    'Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue'
  ) -join "\`r\`n"
  try {
    [System.IO.File]::WriteAllText($elevRelaunchPs1, $elevKillBody, (New-Object System.Text.UTF8Encoding($true)))
    Start-Process -FilePath $psExe -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $elevRelaunchPs1) -ErrorAction Stop
    if ($PSCommandPath) {
      $ackPath = $PSCommandPath + '.ack'
      if (Test-Path -LiteralPath $ackPath) { Remove-Item -LiteralPath $ackPath -Force -ErrorAction SilentlyContinue }
      if (Test-Path -LiteralPath $PSCommandPath) { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue }
    }
    exit 0
  } catch {
    if (Test-Path -LiteralPath $elevRelaunchPs1) { Remove-Item -LiteralPath $elevRelaunchPs1 -Force -ErrorAction SilentlyContinue }
  }
}

foreach ($fp in $staleList) {
  if ($fp -and (Test-Path -LiteralPath $fp)) {
    try { Remove-Item -LiteralPath $fp -Force -ErrorAction SilentlyContinue } catch {}
  }
}

if ($exe -and (Test-Path -LiteralPath $exe)) {
  foreach ($ev in @('ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'VSCODE_IPC_HOOK', 'CHROME_CRASHPAD_PIPE_NAME')) {
    Remove-Item -Path ('Env:\\' + $ev) -ErrorAction SilentlyContinue
  }
  $workDir = Split-Path -Parent $exe
  if ($isSelfElevated -and -not $wasHostElevated) {
    try {
      $shellApp = New-Object -ComObject Shell.Application
      $shellApp.ShellExecute($exe, '--remote-debugging-port=0', $workDir, 'open', 1)
    } catch {
      Start-Process -FilePath $exe -ArgumentList '--remote-debugging-port=0' -WorkingDirectory $workDir
    }
  } else {
    Start-Process -FilePath $exe -ArgumentList '--remote-debugging-port=0' -WorkingDirectory $workDir
  }
}

if ($PSCommandPath) {
  $ackPath = $PSCommandPath + '.ack'
  if (Test-Path -LiteralPath $ackPath) {
    Remove-Item -LiteralPath $ackPath -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $PSCommandPath) {
    Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
  }
}
`.trim();
}

const WIN_OUT_OF_JOB_DISPATCH_PS = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$psBin = if ($env:AGY_PS_EXE) { $env:AGY_PS_EXE } else { 'powershell.exe' }
$relaunchPs1 = [string]$env:AGY_RELAUNCH_PS1
$ackFile = if ($relaunchPs1) { $relaunchPs1 + '.ack' } else { '' }
if ($ackFile -and (Test-Path -LiteralPath $ackFile)) {
  Remove-Item -LiteralPath $ackFile -Force -ErrorAction SilentlyContinue
}
$curIdent = [Security.Principal.WindowsIdentity]::GetCurrent()
$isElev = ([Security.Principal.WindowsPrincipal]$curIdent).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$mySid = (Get-Process -Id $PID).SessionId
$elevFlag = if ($isElev) { '1' } else { '0' }
$env:AGY_HOST_WAS_ELEVATED = $elevFlag
$innerArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $relaunchPs1 + '" -HostElevated ' + $elevFlag
$fullCmd = '"' + $psBin + '" ' + $innerArgs

function Wait-RelaunchAck([int]$TimeoutMs = 1600, [int]$CandidatePid = 0) {
  if (-not $ackFile) { return $true }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
    if (Test-Path -LiteralPath $ackFile) { return $true }
    if ($CandidatePid -gt 0 -and -not (Get-Process -Id $CandidatePid -ErrorAction SilentlyContinue)) {
      Start-Sleep -Milliseconds 60
      return [bool](Test-Path -LiteralPath $ackFile)
    }
    Start-Sleep -Milliseconds 50
  }
  return [bool](Test-Path -LiteralPath $ackFile)
}

$shellPreservesElev = -not $isElev
if ($isElev) {
  try {
    $uacKey = Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -ErrorAction SilentlyContinue
    $luaOff = ($null -ne $uacKey) -and ($uacKey.EnableLUA -eq 0)
    $isBuiltInAdmin = ($null -ne $curIdent.User) -and $curIdent.User.Value.EndsWith('-500')
    $filterAdmin = ($null -ne $uacKey) -and ($uacKey.FilterAdministratorToken -eq 1)
    if ($luaOff -or ($isBuiltInAdmin -and -not $filterAdmin)) {
      $shellPreservesElev = $true
    }
  } catch {}
}

$triedWmi = $false
if ($isElev -and -not $shellPreservesElev) {
  $triedWmi = $true
  try {
    $wmiRes = ([wmiclass]'Win32_Process').Create($fullCmd)
    if ($wmiRes -and $wmiRes.ReturnValue -eq 0 -and (Wait-RelaunchAck 1600 ([int]$wmiRes.ProcessId))) {
      Write-Output '{"ok":true,"method":"wmi_elevated"}'
      exit 0
    }
  } catch {}
}

if (@(Get-Process -Name 'explorer' -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $mySid }).Count -gt 0) {
  try {
    $shellApp = New-Object -ComObject Shell.Application
    $shellApp.ShellExecute($psBin, $innerArgs, '', 'open', 0)
    if (Wait-RelaunchAck 1800 0) {
      Write-Output '{"ok":true,"method":"shell_application"}'
      exit 0
    }
  } catch {}
}

if (-not $triedWmi) {
  try {
    $wmiRes = ([wmiclass]'Win32_Process').Create($fullCmd)
    if ($wmiRes -and $wmiRes.ReturnValue -eq 0 -and (Wait-RelaunchAck 1600 ([int]$wmiRes.ProcessId))) {
      $wmiMethod = if ($isElev) { 'wmi_elevated' } else { 'wmi_fallback' }
      Write-Output ('{"ok":true,"method":"' + $wmiMethod + '"}')
      exit 0
    }
  } catch {}
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $psBin
$psi.Arguments = $innerArgs
$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$psi.UseShellExecute = $true
$sp = [System.Diagnostics.Process]::Start($psi)
$spPid = if ($sp) { [int]$sp.Id } else { 0 }
if (Wait-RelaunchAck 1800 $spPid) {
  $mName = if ($isElev) { 'start_process_elevated' } else { 'start_process' }
  Write-Output ('{"ok":true,"method":"' + $mName + '"}')
  exit 0
}
Write-Output '{"ok":false,"error":"relaunch_script_blocked"}'
exit 1
`.trim();

/**
 * 触发跨平台一键退出系统托盘后台并追加 `--remote-debugging-port=0` 重新拉起宿主客户端。
 *
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   platform?: string,
 *   homeDir?: string,
 *   stalePortFiles?: string[],
 *   readOnlyShortcutPaths?: string[],
 *   execFileFn?: ((file: string, args: string[], opts?: object) => Promise<string>)|null,
 *   spawnFn?: ((file: string, args: string[], opts?: object) => Promise<{ pid: number }>)|null,
 *   existsFn?: typeof existsSync,
 *   writeFileFn?: typeof writeFileSync,
 *   mkdirFn?: typeof mkdirSync,
 *   allowInTest?: boolean,
 * }} [options]
 */
function escapeXmlPlistText(raw) {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function shellSingleQuote(raw) {
  return `'${String(raw ?? '').replace(/'/g, "'\\''")}'`;
}

function getMacOsWrapperBundleSpec(product, homeDir = homedir()) {
  const kind = product === 'ide' ? 'ide' : 'desktop';
  const wrapperName = kind === 'ide' ? 'Antigravity IDE (Monitor).app' : 'Antigravity (Monitor).app';
  const displayName = kind === 'ide' ? 'Antigravity IDE (Monitor)' : 'Antigravity (Monitor)';
  const bundleId =
    kind === 'ide'
      ? 'com.yuhuan.usage-monitor.launcher.ide'
      : 'com.yuhuan.usage-monitor.launcher.desktop';
  return {
    kind,
    wrapperName,
    displayName,
    bundleId,
    wrapperPath: join(homeDir, 'Applications', wrapperName),
  };
}

function hasSymlinkInWrapperBundle(wrapperPath, lstatFn = lstatSync) {
  if (typeof lstatFn !== 'function') return false;
  const contentsDir = join(wrapperPath, 'Contents');
  const macOsDir = join(contentsDir, 'MacOS');
  const resourcesDir = join(contentsDir, 'Resources');
  const candidates = [
    wrapperPath,
    contentsDir,
    macOsDir,
    join(macOsDir, 'launcher'),
    resourcesDir,
    join(resourcesDir, 'launcher.icns'),
    join(contentsDir, 'Info.plist'),
  ];
  for (const p of candidates) {
    try {
      const st = lstatFn(p);
      if (st && typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) {
        return true;
      }
    } catch {
      // 路径尚不存在 (ENOENT) 时视为安全
    }
  }
  return false;
}

/**
 * 检查 macOS `~/Applications` 下是否已存在本插件受管生成的带参启动器 `.app`（严格校验 `Info.plist` 自管标记与符号链接防护）。
 *
 * @param {{
 *   platform?: string,
 *   homeDir?: string,
 *   existsFn?: typeof existsSync,
 *   readFn?: typeof readFileSync,
 *   lstatFn?: typeof lstatSync,
 * }} [options]
 */
export function inspectMacOsLaunchWrapperStatus({
  platform = process.platform,
  homeDir = homedir(),
  existsFn = existsSync,
  readFn = readFileSync,
  lstatFn = lstatSync,
} = {}) {
  if (platform !== 'darwin') {
    return {
      supported: false,
      exists: false,
      desktopExists: false,
      ideExists: false,
      paths: [],
    };
  }
  const paths = [];
  let desktopExists = false;
  let ideExists = false;
  for (const kind of ['desktop', 'ide']) {
    const spec = getMacOsWrapperBundleSpec(kind, homeDir);
    const plistPath = join(spec.wrapperPath, 'Contents', 'Info.plist');
    try {
      if (hasSymlinkInWrapperBundle(spec.wrapperPath, lstatFn)) continue;
      if (!existsFn(plistPath)) continue;
      const plistText = String(readFn(plistPath, 'utf8') || '');
      if (!plistText.includes(`<key>${MACOS_MANAGED_WRAPPER_KEY}</key>`)) continue;
      paths.push(spec.wrapperPath);
      if (kind === 'ide') ideExists = true;
      else desktopExists = true;
    } catch {
      // 忽略损坏或无权限的单个候选
    }
  }
  return {
    supported: true,
    exists: paths.length > 0,
    desktopExists,
    ideExists,
    paths,
  };
}

/**
 * 在 macOS 用户目录 `~/Applications/` 下按需创建轻量后台代理启动器 `.app`：
 * - 声明 `LSUIElement = true`，从 Spotlight / Raycast / Finder 启动时不额外占用 Dock 与 `Cmd+Tab` 图标槽；
 * - 自动拷贝原版应用 `.icns` 图标并写入自管标记 `com.yuhuan.usageMonitor.managedWrapper`；
 * - 绝不触碰原版 `/Applications/Antigravity*.app` 内部任何文件。
 *
 * @param {{
 *   product?: 'desktop'|'ide',
 *   env?: Record<string, string|undefined>,
 *   platform?: string,
 *   homeDir?: string,
 *   execFileFn?: ((file: string, args: string[], opts?: object) => Promise<string>)|null,
 *   fsOps?: {
 *     existsFn?: typeof existsSync,
 *     readFn?: typeof readFileSync,
 *     writeFn?: typeof writeFileSync,
 *     mkdirFn?: typeof mkdirSync,
 *     readdirFn?: typeof readdirSync,
 *     chmodFn?: ((p: string, mode: number) => void)|null,
 *   }|null,
 *   allowInTest?: boolean,
 * }} [options]
 */
export async function createMacOsLaunchWrapper({
  product = 'desktop',
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  execFileFn = null,
  fsOps = null,
  allowInTest = false,
} = {}) {
  if (isBlockedInTestSandbox(allowInTest)) {
    return { ok: false, status: 403, error: 'Disabled in test sandbox' };
  }
  if (platform !== 'darwin') {
    return { ok: false, status: 400, error: 'macOS wrapper is only supported on darwin' };
  }

  const targetKind = product === 'ide' ? 'ide' : 'desktop';
  const existsFn = fsOps?.existsFn || existsSync;
  const readFn = fsOps?.readFn || readFileSync;
  const writeFn = fsOps?.writeFn || writeFileSync;
  const mkdirFn = fsOps?.mkdirFn || mkdirSync;
  const readdirFn = fsOps?.readdirFn || readdirSync;
  const lstatFn = fsOps?.lstatFn || (fsOps?.existsFn ? null : lstatSync);

  let hostInfo = resolveDesktopHostExecutable({
    env,
    platform,
    homeDir,
    existsFn,
    preferredProduct: targetKind,
  });
  if (!hostInfo.found) {
    hostInfo = await discoverRunningHostExecutable({
      platform,
      env,
      execFileFn,
      preferredProduct: targetKind,
    });
  }
  const targetBundle = hostInfo.appBundlePath || hostInfo.executablePath;
  if (!hostInfo.found || !targetBundle) {
    return {
      ok: false,
      status: 404,
      error: `Unable to locate ${targetKind === 'ide' ? 'Antigravity IDE.app' : 'Antigravity.app'} on this Mac`,
    };
  }

  const spec = getMacOsWrapperBundleSpec(targetKind, homeDir);
  if (hasSymlinkInWrapperBundle(spec.wrapperPath, lstatFn)) {
    return {
      ok: false,
      status: 409,
      error: 'Refusing to operate on symbolic link at wrapper path',
    };
  }
  const contentsDir = join(spec.wrapperPath, 'Contents');
  const existingPlistPath = join(contentsDir, 'Info.plist');
  if (existsFn(spec.wrapperPath)) {
    let isManaged = false;
    try {
      if (existsFn(existingPlistPath)) {
        const prevPlist = String(readFn(existingPlistPath, 'utf8') || '');
        isManaged = prevPlist.includes(`<key>${MACOS_MANAGED_WRAPPER_KEY}</key>`);
      }
    } catch {
      isManaged = false;
    }
    if (!isManaged) {
      return {
        ok: false,
        status: 409,
        error: 'Refusing to overwrite existing unmanaged application bundle',
      };
    }
  }
  const macOsDir = join(contentsDir, 'MacOS');
  const resourcesDir = join(contentsDir, 'Resources');
  mkdirFn(macOsDir, { recursive: true });
  mkdirFn(resourcesDir, { recursive: true });

  let hasCopiedIcon = false;
  try {
    const srcResources = join(targetBundle, 'Contents', 'Resources');
    const srcPlistPath = join(targetBundle, 'Contents', 'Info.plist');
    let preferredIconName = '';
    if (existsFn(srcPlistPath)) {
      const srcPlist = String(readFn(srcPlistPath, 'utf8') || '');
      const iconMatch = srcPlist.match(
        /<key>\s*CFBundleIconFile\s*<\/key>\s*<string>\s*([^<\r\n]+?)\s*<\/string>/i
      );
      if (iconMatch && iconMatch[1]) {
        const rawIcon = iconMatch[1].trim();
        preferredIconName = /\.icns$/i.test(rawIcon) ? rawIcon : `${rawIcon}.icns`;
      }
    }
    let srcIconPath =
      preferredIconName && existsFn(join(srcResources, preferredIconName))
        ? join(srcResources, preferredIconName)
        : '';
    if (!srcIconPath && existsFn(srcResources)) {
      const entries = readdirFn(srcResources);
      const icnsEntry = (Array.isArray(entries) ? entries : [])
        .map((e) => (typeof e === 'string' ? e : String(e?.name || '')))
        .find((n) => /\.icns$/i.test(n));
      if (icnsEntry) {
        srcIconPath = join(srcResources, icnsEntry);
      }
    }
    if (srcIconPath && existsFn(srcIconPath)) {
      const iconBuf = readFn(srcIconPath);
      writeFn(join(resourcesDir, 'launcher.icns'), iconBuf);
      hasCopiedIcon = true;
    }
  } catch {
    // 图标复制失败不阻塞启动器生成
  }

  const launcherBinPath = join(macOsDir, 'launcher');
  const launcherScript = [
    '#!/bin/sh',
    `exec /usr/bin/open -a ${shellSingleQuote(targetBundle)} --args ${REMOTE_DEBUG_LAUNCH_FLAG} "$@"`,
    '',
  ].join('\n');
  writeFn(launcherBinPath, launcherScript, 'utf8');
  if (typeof fsOps?.chmodFn === 'function') {
    fsOps.chmodFn(launcherBinPath, 0o755);
  } else {
    try {
      const fsMod = await import('node:fs');
      (fsMod.chmodSync || fsMod.default?.chmodSync)?.(launcherBinPath, 0o755);
    } catch {
      // 忽略沙箱 chmod 异常
    }
  }

  const iconPlistLines = hasCopiedIcon
    ? ['  <key>CFBundleIconFile</key>', '  <string>launcher.icns</string>']
    : [];
  const infoPlist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>CFBundleExecutable</key>',
    '  <string>launcher</string>',
    '  <key>CFBundleIdentifier</key>',
    `  <string>${escapeXmlPlistText(spec.bundleId)}</string>`,
    '  <key>CFBundleName</key>',
    `  <string>${escapeXmlPlistText(spec.displayName)}</string>`,
    '  <key>CFBundleDisplayName</key>',
    `  <string>${escapeXmlPlistText(spec.displayName)}</string>`,
    '  <key>CFBundlePackageType</key>',
    '  <string>APPL</string>',
    '  <key>CFBundleShortVersionString</key>',
    '  <string>1.0.0</string>',
    '  <key>LSUIElement</key>',
    '  <true/>',
    ...iconPlistLines,
    `  <key>${MACOS_MANAGED_WRAPPER_KEY}</key>`,
    '  <true/>',
    '  <key>com.yuhuan.usageMonitor.targetBundle</key>',
    `  <string>${escapeXmlPlistText(targetBundle)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
  writeFn(join(contentsDir, 'Info.plist'), infoPlist, 'utf8');

  const lsregisterBin =
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
  const runner = execFileFn || runLauncherExecFile;
  try {
    if (execFileFn || existsFn(lsregisterBin)) {
      await runner(lsregisterBin, ['-f', spec.wrapperPath], { timeoutMs: 3000 });
    }
  } catch {
    // LaunchServices 索引刷新失败不阻断生成结果
  }

  return {
    ok: true,
    action: 'create_macos_wrapper',
    product: targetKind,
    wrapperPath: spec.wrapperPath,
    wrapperName: spec.wrapperName,
    targetBundle,
  };
}

/**
 * 安全移除 macOS `~/Applications` 下带本插件自管标记的启动器 `.app`（绝不删除无标记目录）。
 *
 * @param {{
 *   product?: 'desktop'|'ide'|'both',
 *   platform?: string,
 *   homeDir?: string,
 *   fsOps?: {
 *     existsFn?: typeof existsSync,
 *     readFn?: typeof readFileSync,
 *     rmFn?: typeof rmSync,
 *   }|null,
 *   allowInTest?: boolean,
 * }} [options]
 */
export function removeMacOsLaunchWrapper({
  product = 'both',
  platform = process.platform,
  homeDir = homedir(),
  fsOps = null,
  allowInTest = false,
} = {}) {
  if (isBlockedInTestSandbox(allowInTest)) {
    return { ok: false, status: 403, error: 'Disabled in test sandbox' };
  }
  if (platform !== 'darwin') {
    return { ok: false, status: 400, error: 'macOS wrapper is only supported on darwin' };
  }
  const existsFn = fsOps?.existsFn || existsSync;
  const readFn = fsOps?.readFn || readFileSync;
  const rmFn = fsOps?.rmFn || rmSync;
  const lstatFn = fsOps?.lstatFn || (fsOps?.existsFn ? null : lstatSync);
  const normProd = normalizeLauncherProduct(product, 'both');
  const kinds = normProd === 'ide' ? ['ide'] : normProd === 'desktop' ? ['desktop'] : ['desktop', 'ide'];
  const removedPaths = [];

  for (const kind of kinds) {
    const spec = getMacOsWrapperBundleSpec(kind, homeDir);
    if (hasSymlinkInWrapperBundle(spec.wrapperPath, lstatFn)) {
      return {
        ok: false,
        status: 409,
        error: 'Refusing to remove symbolic link at wrapper path',
      };
    }
    const plistPath = join(spec.wrapperPath, 'Contents', 'Info.plist');
    try {
      if (!existsFn(plistPath)) continue;
      const plistText = String(readFn(plistPath, 'utf8') || '');
      if (!plistText.includes(`<key>${MACOS_MANAGED_WRAPPER_KEY}</key>`)) continue;
      rmFn(spec.wrapperPath, { recursive: true, force: true });
      removedPaths.push(spec.wrapperPath);
    } catch {
      // 忽略单个删除异常
    }
  }

  return {
    ok: true,
    action: 'remove_macos_wrapper',
    removedPaths,
  };
}

export async function triggerDesktopHostRelaunch({
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  preferredProduct = 'auto',
  stalePortFiles = [],
  readOnlyShortcutPaths = [],
  execFileFn = null,
  spawnFn = null,
  existsFn = existsSync,
  writeFileFn = writeFileSync,
  mkdirFn = mkdirSync,
  allowInTest = false,
} = {}) {
  if (isBlockedInTestSandbox(allowInTest)) {
    return { ok: false, status: 403, error: 'Disabled in test sandbox' };
  }

  const normPref = String(preferredProduct || 'auto').trim().toLowerCase();
  let hostInfo = { found: false, kind: '', executablePath: '', appBundlePath: '' };
  if (normPref === 'auto') {
    hostInfo = resolveDesktopHostExecutable({
      env,
      platform,
      homeDir,
      existsFn,
      preferredProduct: 'auto',
      envHintsOnly: true,
    });
    if (!hostInfo.found) {
      const desktopStatic = resolveDesktopHostExecutable({
        env,
        platform,
        homeDir,
        existsFn,
        preferredProduct: 'desktop',
      });
      const ideStatic = resolveDesktopHostExecutable({
        env,
        platform,
        homeDir,
        existsFn,
        preferredProduct: 'ide',
      });
      if (desktopStatic.found && ideStatic.found) {
        const runningInfo = await discoverRunningHostExecutable({
          platform,
          env,
          execFileFn,
          preferredProduct: 'auto',
        });
        hostInfo = runningInfo.found ? runningInfo : desktopStatic;
      } else if (desktopStatic.found) {
        hostInfo = desktopStatic;
      } else if (ideStatic.found) {
        hostInfo = ideStatic;
      } else {
        hostInfo = await discoverRunningHostExecutable({
          platform,
          env,
          execFileFn,
          preferredProduct: 'auto',
        });
      }
    }
  } else {
    hostInfo = resolveDesktopHostExecutable({
      env,
      platform,
      homeDir,
      existsFn,
      preferredProduct: normPref,
    });
    if (!hostInfo.found) {
      hostInfo = await discoverRunningHostExecutable({
        platform,
        env,
        execFileFn,
        preferredProduct: normPref,
      });
    }
  }
  if (!hostInfo.found) {
    return {
      ok: false,
      status: 404,
      error: 'Unable to locate Antigravity executable on this machine',
    };
  }

  const cleanEnv = buildSanitizedDesktopRelaunchEnv(env);
  const targetKind = hostInfo.kind === 'ide' ? 'ide' : 'desktop';
  const cleanStaleFiles = (Array.isArray(stalePortFiles) ? stalePortFiles : [])
    .map((p) => String(p || '').trim())
    .filter((p) => Boolean(p) && classifyDevToolsPortProduct(p) === targetKind);
  const cleanReadOnlyPaths = (Array.isArray(readOnlyShortcutPaths) ? readOnlyShortcutPaths : [])
    .map((p) => String(p || '').trim())
    .filter(Boolean);

  if (platform === 'win32') {
    const psExe = execFileFn ? 'powershell.exe' : resolveWindowsPowerShellExecutable(env, existsFn);
    const innerScript = buildWindowsRelaunchInnerScript(
      hostInfo.executablePath,
      cleanStaleFiles,
      targetKind,
      {
        readOnlyShortcutPaths: cleanReadOnlyPaths,
        psExePath: psExe,
      }
    );
    const tempDir = String(env?.TEMP || env?.TMP || DATA_DIR || homeDir).trim();
    mkdirFn(tempDir, { recursive: true });
    const relaunchPs1Path = join(tempDir, `agy-monitor-relaunch-${process.pid}.ps1`);
    // UTF-8 with BOM ensures Windows PowerShell 5.1 parses non-ASCII paths accurately across all system locales
    writeFileFn(relaunchPs1Path, `\uFEFF${innerScript}\r\n`, 'utf8');

    const runner = execFileFn || runLauncherExecFile;
    try {
      const dispatchOut = await runner(
        psExe,
        [
          '-Sta',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          WIN_OUT_OF_JOB_DISPATCH_PS,
        ],
        {
          timeoutMs: 9000,
          env: {
            ...cleanEnv,
            AGY_PS_EXE: psExe,
            AGY_RELAUNCH_PS1: relaunchPs1Path,
          },
        }
      );
      const lastJsonLine =
        String(dispatchOut || '')
          .trim()
          .split(/\r?\n/)
          .reverse()
          .find((l) => l.trim().startsWith('{')) || '';
      if (lastJsonLine) {
        let parsedDispatch = null;
        try {
          parsedDispatch = JSON.parse(lastJsonLine);
        } catch {
          parsedDispatch = null;
        }
        if (parsedDispatch && parsedDispatch.ok === false) {
          throw new Error(parsedDispatch.error || 'Windows relaunch dispatch reported failure');
        }
      }
    } catch (err) {
      try {
        unlinkSync(relaunchPs1Path);
      } catch {
        // Ignore cleanup errors when custom writeFileFn was used in unit tests
      }
      try {
        unlinkSync(`${relaunchPs1Path}.ack`);
      } catch {
        // Ignore missing ack file
      }
      return {
        ok: false,
        status: 500,
        error: err?.message || 'Failed to dispatch Windows host relaunch',
      };
    }
    return {
      ok: true,
      relaunching: true,
      product: targetKind,
      platform,
      executablePath: hostInfo.executablePath,
    };
  }

  const spawner = spawnFn || spawnDetachedProcess;

  if (platform === 'darwin') {
    const appTarget = hostInfo.appBundlePath || hostInfo.executablePath;
    const bundleDerivedName = hostInfo.appBundlePath
      ? basename(hostInfo.appBundlePath).replace(/\.app$/i, '').trim()
      : '';
    const appName =
      bundleDerivedName || (targetKind === 'ide' ? 'Antigravity IDE' : 'Antigravity');
    const bundleMacOsPrefix = hostInfo.appBundlePath
      ? `${hostInfo.appBundlePath.replace(/\/+$/, '')}/Contents/MacOS/`
      : '';
    const shScript = [
      'sleep 0.45',
      'find_main_pids() { if [ -n "$AGY_BUNDLE_MACOS" ]; then ps -axo pid=,command= 2>/dev/null | awk -v self="$$" \'BEGIN { pat = ENVIRON["AGY_BUNDLE_MACOS"] } $1 != self && index($0, pat) > 0 && tolower($0) !~ /helper/ { print $1 }\'; else pgrep -ax "$AGY_APP_NAME" 2>/dev/null || true; fi; }',
      'find_bundle_pids() { if [ -n "$AGY_BUNDLE_MACOS" ]; then ps -axo pid=,command= 2>/dev/null | awk -v self="$$" \'BEGIN { pat = ENVIRON["AGY_BUNDLE_MACOS"] } $1 != self && index($0, pat) > 0 { print $1 }\'; else pgrep -ax "$AGY_APP_NAME" 2>/dev/null || true; fi; }',
      'is_alive() { [ -n "$(find_main_pids)" ]; }',
      'if osascript -e \'on run argv\' -e \'tell application (item 1 of argv) to quit\' -e \'end run\' -- "$AGY_RELAUNCH_APP" >/dev/null 2>&1 || osascript -e \'on run argv\' -e \'tell application (item 1 of argv) to quit\' -e \'end run\' -- "$AGY_APP_NAME" >/dev/null 2>&1; then i=0; while [ $i -lt 25 ] && is_alive; do sleep 0.2; i=$((i+1)); done; fi',
      'if is_alive; then pids="$(find_bundle_pids)"; if [ -n "$pids" ]; then kill -TERM $pids >/dev/null 2>&1 || true; elif [ -z "$AGY_BUNDLE_MACOS" ]; then pkill -TERM -ax "$AGY_APP_NAME" >/dev/null 2>&1 || killall -TERM "$AGY_APP_NAME" >/dev/null 2>&1 || true; fi; j=0; while [ $j -lt 20 ] && is_alive; do sleep 0.2; j=$((j+1)); done; fi',
      'if is_alive; then pids="$(find_bundle_pids)"; if [ -n "$pids" ]; then kill -KILL $pids >/dev/null 2>&1 || true; elif [ -z "$AGY_BUNDLE_MACOS" ]; then pkill -KILL -ax "$AGY_APP_NAME" >/dev/null 2>&1 || killall -KILL "$AGY_APP_NAME" >/dev/null 2>&1 || true; fi; k=0; while [ $k -lt 15 ] && is_alive; do sleep 0.2; k=$((k+1)); done; fi',
      'old_ifs="$IFS"; set -f; IFS=":"; for f in $AGY_STALE_PORT_FILES; do [ -n "$f" ] && rm -f "$f"; done; set +f; IFS="$old_ifs"',
      'sleep 0.4',
      'open -a "$AGY_RELAUNCH_APP" --args --remote-debugging-port=0 >/dev/null 2>&1',
    ].join('; ');
    await spawner('/bin/sh', ['-c', shScript], {
      env: {
        ...cleanEnv,
        AGY_APP_NAME: appName,
        AGY_RELAUNCH_APP: appTarget,
        AGY_BUNDLE_MACOS: bundleMacOsPrefix,
        AGY_STALE_PORT_FILES: cleanStaleFiles.join(':'),
      },
    });
    return {
      ok: true,
      relaunching: true,
      product: targetKind,
      platform,
      executablePath: appTarget,
    };
  }

  const procLeaf =
    basename(hostInfo.executablePath) || (targetKind === 'ide' ? 'antigravity-ide' : 'antigravity');
  const linuxScript = [
    'sleep 0.45',
    'uid="$(id -u)"',
    'real_exe="$(readlink -f "$AGY_RELAUNCH_EXE" 2>/dev/null || echo "$AGY_RELAUNCH_EXE")"',
    'collect_pids() { found=""; if [ -d /proc ]; then for d in /proc/[0-9]*; do p="${d#/proc/}"; [ "$p" = "$$" ] && continue; owner="$(stat -c %u "$d" 2>/dev/null || echo "")"; [ -n "$owner" ] && [ "$owner" != "$uid" ] && continue; exe="$(readlink -f "$d/exe" 2>/dev/null || readlink "$d/exe" 2>/dev/null | sed \'s/ (deleted)$//\')"; exe="$(printf "%s" "$exe" | sed \'s/ (deleted)$//\')"; if [ -n "$exe" ] && { [ "$exe" = "$AGY_RELAUNCH_EXE" ] || [ "$exe" = "$real_exe" ]; }; then found="$found $p"; continue; fi; if [ -r "$d/environ" ] && tr \'\\0\' \'\\n\' < "$d/environ" 2>/dev/null | grep -Fx -- "APPIMAGE=$AGY_RELAUNCH_EXE" >/dev/null 2>&1; then found="$found $p"; fi; done; fi; if [ -z "$found" ]; then found="$(pgrep -u "$uid" -f -- "$AGY_RELAUNCH_EXE" 2>/dev/null | grep -vw "$$" || true)"; fi; echo "$found"; }',
    'pids="$(collect_pids)"',
    'if [ -n "$pids" ]; then kill -TERM $pids >/dev/null 2>&1 || true; fi',
    'i=0; while [ $i -lt 25 ]; do pids="$(collect_pids)"; [ -z "$pids" ] && break; sleep 0.2; i=$((i+1)); done',
    'pids="$(collect_pids)"',
    'if [ -n "$pids" ]; then kill -KILL $pids >/dev/null 2>&1 || true; j=0; while [ $j -lt 15 ]; do pids="$(collect_pids)"; [ -z "$pids" ] && break; sleep 0.2; j=$((j+1)); done; fi',
    'old_ifs="$IFS"; set -f; IFS=":"; for f in $AGY_STALE_PORT_FILES; do [ -n "$f" ] && rm -f "$f"; done; set +f; IFS="$old_ifs"',
    'nohup "$AGY_RELAUNCH_EXE" --remote-debugging-port=0 >/dev/null 2>&1 &',
  ].join('; ');
  await spawner('/bin/sh', ['-c', linuxScript], {
    env: {
      ...cleanEnv,
      AGY_RELAUNCH_EXE: hostInfo.executablePath,
      AGY_PROC_NAME: procLeaf,
      AGY_STALE_PORT_FILES: cleanStaleFiles.join(':'),
    },
  });
  return {
    ok: true,
    relaunching: true,
    product: targetKind,
    platform,
    executablePath: hostInfo.executablePath,
  };
}
