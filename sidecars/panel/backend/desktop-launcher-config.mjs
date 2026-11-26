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
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  readlinkSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, win32 as pathWin32 } from 'node:path';
import { DATA_DIR, HERE, lsRuntimeEndpoint } from './config.mjs';
import { writeTextFileAtomicSync } from './fs-atomic.mjs';

export const REMOTE_DEBUG_LAUNCH_FLAG = '--remote-debugging-port=0';
export const MAC_AUTO_RELAUNCH_MAX_HOST_AGE_SEC = 60;
export const MAC_AUTO_RELAUNCH_COOLDOWN_MS = 120 * 1000;
export const MAC_AUTO_RELAUNCH_MAX_CONSECUTIVE_FAILURES = 2;
export const MAC_AUTO_RELAUNCH_STATE_FILE = join(DATA_DIR, 'macos-auto-relaunch-state.json');

const REMOTE_DEBUG_ANY_RE = /(?:^|\s)--remote-debugging-port(?:=|\s|$)/i;
const REMOTE_DEBUG_MANAGED_ZERO_RE = /(?:^|\s+)--remote-debugging-port=(?:"0"|'0'|0)(?=\s|$)/gi;
const CHROMIUM_SUBPROCESS_TYPE_RE = /(?:^|\s)--type=/i;

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
export function patchWindowsRunRegistryCommand(rawValue, { enabled = true } = {}) {
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
  if (exeLeaf.toLowerCase() !== 'antigravity.exe') {
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
 * @param {{ enabled?: boolean }} [options]
 * @returns {{ matched: boolean, changed: boolean, configured: boolean, value: string }}
 */
export function patchWindowsShellOpenCommand(rawValue, { enabled = true } = {}) {
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
  if (exeLeaf.toLowerCase() !== 'antigravity.exe') {
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
export function patchLinuxDesktopEntryText(rawText, { enabled = true } = {}) {
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
    if (!isLinuxAntigravityDesktopLeaf(exeLeaf)) {
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
} = {}) {
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
      if (isLinuxAntigravityDesktopLeaf(leaf)) {
        return { found: true, kind: 'desktop', executablePath: appImagePath, appBundlePath: '' };
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
        const isIde = /antigravity\s*ide\.app$/i.test(bundleCand);
        const macBin = join(
          bundleCand,
          'Contents',
          'MacOS',
          isIde ? 'Antigravity IDE' : 'Antigravity'
        );
        return {
          found: true,
          kind: isIde ? 'ide' : 'desktop',
          executablePath: safeExists(macBin) ? macBin : bundleCand,
          appBundlePath: bundleCand,
        };
      }
    }

    if (platform === 'win32' && /\.exe$/i.test(rawHint) && !/language_server/i.test(rawHint)) {
      if (safeExists(rawHint)) {
        const isIde = /antigravity\s*ide\.exe$/i.test(rawHint);
        return {
          found: true,
          kind: isIde ? 'ide' : 'desktop',
          executablePath: rawHint,
          appBundlePath: '',
        };
      }
    }

    let cur = rawHint;
    for (let depth = 0; depth < 8 && cur && dirname(cur) !== cur; depth += 1) {
      const base = basename(cur).toLowerCase();
      if (base === 'resources') {
        const installRoot = dirname(cur);
        if (platform === 'win32') {
          const desktopExe = join(installRoot, 'Antigravity.exe');
          if (safeExists(desktopExe)) {
            return { found: true, kind: 'desktop', executablePath: desktopExe, appBundlePath: '' };
          }
          const ideExe = join(installRoot, 'Antigravity IDE.exe');
          if (safeExists(ideExe)) {
            return { found: true, kind: 'ide', executablePath: ideExe, appBundlePath: '' };
          }
        } else if (platform === 'linux') {
          for (const binName of ['antigravity', 'Antigravity']) {
            const linuxExe = join(installRoot, binName);
            if (safeExists(linuxExe) && !installRoot.startsWith('/tmp/.mount_')) {
              return { found: true, kind: 'desktop', executablePath: linuxExe, appBundlePath: '' };
            }
          }
        }
      }
      cur = dirname(cur);
    }
  }

  if (platform === 'win32') {
    const localAppData = env?.LOCALAPPDATA || join(homeDir, 'AppData', 'Local');
    const programFiles = env?.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = String(env?.['ProgramFiles(x86)'] || '').trim();
    const winCandidates = [
      join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'),
      join(programFiles, 'Antigravity', 'Antigravity.exe'),
      ...(programFilesX86 ? [join(programFilesX86, 'Antigravity', 'Antigravity.exe')] : []),
      join(localAppData, 'Antigravity', 'Antigravity.exe'),
    ];
    for (const cand of winCandidates) {
      if (safeExists(cand)) {
        return { found: true, kind: 'desktop', executablePath: cand, appBundlePath: '' };
      }
    }
  } else if (platform === 'darwin') {
    const macBundles = [
      join(homeDir, 'Applications', 'Antigravity.app'),
      '/Applications/Antigravity.app',
    ];
    for (const bundlePath of macBundles) {
      if (safeExists(bundlePath)) {
        const macBin = join(bundlePath, 'Contents', 'MacOS', 'Antigravity');
        return {
          found: true,
          kind: 'desktop',
          executablePath: safeExists(macBin) ? macBin : bundlePath,
          appBundlePath: bundlePath,
        };
      }
    }
  } else {
    const linuxCandidates = [
      '/opt/Antigravity/antigravity',
      '/opt/Antigravity/Antigravity',
      '/opt/antigravity/antigravity',
      '/usr/share/antigravity/antigravity',
      '/usr/bin/antigravity',
      '/usr/bin/google-antigravity',
      '/usr/local/bin/antigravity',
      join(homeDir, '.local', 'bin', 'antigravity'),
    ];
    for (const cand of linuxCandidates) {
      if (safeExists(cand)) {
        return { found: true, kind: 'desktop', executablePath: cand, appBundlePath: '' };
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
        maxBuffer: options.maxBuffer || 1024 * 1024,
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
export function inspectWindowsLnkBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 32 || buf.length > 65536) {
    return { matched: false, hasDebugPort: false };
  }
  const ascii = buf.toString('latin1').toLowerCase();
  const utf16 = buf.toString('utf16le').toLowerCase();
  const hasIde = ascii.includes('antigravity ide.exe') || utf16.includes('antigravity ide.exe');
  if (hasIde) {
    return { matched: false, hasDebugPort: false };
  }
  const hasDesktopExe =
    ascii.includes('\\antigravity.exe') ||
    utf16.includes('\\antigravity.exe') ||
    ascii.includes('/antigravity.exe') ||
    utf16.includes('/antigravity.exe');
  if (!hasDesktopExe) {
    return { matched: false, hasDebugPort: false };
  }
  const hasDebugPort =
    ascii.includes('--remote-debugging-port') || utf16.includes('--remote-debugging-port');
  return { matched: true, hasDebugPort };
}

/**
 * 纯 Node.js 零子进程快速扫描当前机器上的 `Antigravity.exe` 快捷方式配置状态（耗时通常 `< 2ms`）。
 * 桌面与任务栏严格仅扫描顶层 `.lnk`（绝不进入用户项目文件夹或 `node_modules`），开始菜单仅检查顶层及 Antigravity/Google 一级厂商子目录。
 *
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   homeDir?: string,
 *   extraDirs?: string[],
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
      const res = inspectWindowsLnkBuffer(buf);
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
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  execFileFn = null,
  fsOps = null,
  allowInTest = false,
} = {}) {
  if (lsRuntimeEndpoint.addr === 'test.invalid' && !allowInTest) {
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

    try {
      const userCandidates = collectLinuxDesktopCandidates(userAppsDir, ops, {
        filterByName: false,
        fallbackNames: ['antigravity.desktop'],
      });
      for (const cand of userCandidates) {
        const rawText = readDesktopTextSafe(cand.full);
        if (!rawText) continue;
        const patched = patchLinuxDesktopEntryText(rawText, { enabled });
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
            fallbackNames: ['antigravity.desktop'],
          });
          for (const cand of sysCandidates) {
            const nameKey = cand.name.toLowerCase();
            if (handledUserFileNames.has(nameKey)) continue;
            const rawText = readDesktopTextSafe(cand.full);
            if (!rawText) continue;
            const patched = patchLinuxDesktopEntryText(rawText, { enabled: true });
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
        fallbackNames: ['antigravity.desktop'],
      });
      for (const cand of autostartCandidates) {
        const autoRaw = readDesktopTextSafe(cand.full);
        if (!autoRaw) continue;
        const patchedAuto = patchLinuxDesktopEntryText(autoRaw, { enabled });
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
} = {}) {
  const runner = execFileFn || runLauncherExecFile;
  if (platform === 'win32') {
    try {
      const psExe = execFileFn ? 'powershell.exe' : resolveWindowsPowerShellExecutable(env);
      const ps =
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; @(Get-Process -Name 'Antigravity','Antigravity IDE' -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1) | ForEach-Object { [pscustomobject]@{ path = [string]$_.Path; name = [string]$_.ProcessName } } | ConvertTo-Json -Compress";
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
          return {
            found: true,
            kind: isIde ? 'ide' : 'desktop',
            executablePath: exePath,
            appBundlePath: '',
          };
        }
      }
    } catch {
      // 忽略动态进程探测异常
    }
  } else if (platform === 'darwin') {
    try {
      const out = await runner(
        'osascript',
        ['-e', 'POSIX path of (path to application "Antigravity")'],
        { timeoutMs: 3000 }
      );
      const bundlePath = String(out || '').trim().replace(/\/+$/, '');
      if (bundlePath && /\.app$/i.test(bundlePath)) {
        return {
          found: true,
          kind: /antigravity\s*ide\.app$/i.test(bundlePath) ? 'ide' : 'desktop',
          executablePath: bundlePath,
          appBundlePath: bundlePath,
        };
      }
    } catch {
      // 忽略 AppleScript 探测异常（例如 TCC 限制），回退无权限依赖的 ps 扫描
    }
    try {
      const psOut = await runner('ps', ['-axo', 'comm='], { timeoutMs: 3000 });
      for (const rawLine of String(psOut || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        const m = line.match(/^(\/.+?\.app)\/Contents\/MacOS\/([^/]+)$/i);
        if (!m) continue;
        const bundlePath = m[1];
        const binLeaf = m[2];
        if (!/antigravity/i.test(bundlePath) && !/antigravity/i.test(binLeaf)) continue;
        if (/helper/i.test(binLeaf)) continue;
        return {
          found: true,
          kind: /antigravity\s*ide\.app$/i.test(bundlePath) ? 'ide' : 'desktop',
          executablePath: line,
          appBundlePath: bundlePath,
        };
      }
    } catch {
      // 忽略 ps 探测异常
    }
  } else if (platform === 'linux') {
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
            if (!isLinuxAntigravityDesktopLeaf(leaf)) continue;
            try {
              const envRaw = readFileSync(`${procDir}/environ`, 'utf8');
              for (const entry of envRaw.split('\0')) {
                if (entry.startsWith('APPIMAGE=')) {
                  const appImg = entry.slice('APPIMAGE='.length).trim();
                  if (appImg && existsSync(appImg)) {
                    return { found: true, kind: 'desktop', executablePath: appImg, appBundlePath: '' };
                  }
                }
              }
            } catch {
              // 忽略 environ 读取异常
            }
            if (exeTarget.startsWith('/tmp/.mount_')) continue;
            return { found: true, kind: 'desktop', executablePath: exeTarget, appBundlePath: '' };
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
          return {
            found: true,
            kind: 'desktop',
            executablePath: foundLinuxExe,
            appBundlePath: '',
          };
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
function buildReadonlyShortcutPatchPsBlock() {
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
    "            if ([System.IO.Path]::GetFileName($exeCand) -ieq 'Antigravity.exe' -and $restPart -notmatch '(?:^|\\s)--remote-debugging-port(?:=|\\s|$)') {",
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
    "          if ([System.IO.Path]::GetFileName($exeCand) -ieq 'Antigravity.exe' -and $restOpen -notmatch '(?:^|\\s)--remote-debugging-port(?:=|\\s|$)') {",
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
    '      $cur = [string]$sc.Arguments',
    "      if ($cur -notmatch '(?:^|\\s)--remote-debugging-port(?:=|\\s|$)') {",
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
  const { fnLines, quotedLines } = buildReadonlyShortcutPatchPsBlock();
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
    '$wd = Split-Path -Parent $exe',
    'Start-Process -FilePath $exe -ArgumentList ''--remote-debugging-port=0'' -WorkingDirectory $wd',
    'Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue'
  ) -join "\`r\`n"
  try {
    [System.IO.File]::WriteAllText($elevRelaunchPs1, $elevKillBody, (New-Object System.Text.UTF8Encoding($true)))
    Start-Process -FilePath $psExe -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $elevRelaunchPs1) -ErrorAction Stop
    if ($PSCommandPath -and (Test-Path -LiteralPath $PSCommandPath)) {
      Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
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

if ($PSCommandPath -and (Test-Path -LiteralPath $PSCommandPath)) {
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
`.trim();
}

const WIN_OUT_OF_JOB_DISPATCH_PS = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$psBin = if ($env:AGY_PS_EXE) { $env:AGY_PS_EXE } else { 'powershell.exe' }
$isElev = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$elevFlag = if ($isElev) { '1' } else { '0' }
$env:AGY_HOST_WAS_ELEVATED = $elevFlag
$innerArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $env:AGY_RELAUNCH_PS1 + '" -HostElevated ' + $elevFlag
$fullCmd = '"' + $psBin + '" ' + $innerArgs

if ($isElev) {
  try {
    $wmiRes = ([wmiclass]'Win32_Process').Create($fullCmd)
    if ($wmiRes -and $wmiRes.ReturnValue -eq 0) {
      Write-Output '{"ok":true,"method":"wmi_elevated"}'
      exit 0
    }
  } catch {}
  Start-Process -FilePath $psBin -ArgumentList $innerArgs -WindowStyle Hidden
  Write-Output '{"ok":true,"method":"start_process_elevated"}'
  exit 0
}

try {
  $shellApp = New-Object -ComObject Shell.Application
  $shellApp.ShellExecute($psBin, $innerArgs, '', 'open', 0)
  Write-Output '{"ok":true,"method":"shell_application"}'
  exit 0
} catch {}

try {
  $wmiRes = ([wmiclass]'Win32_Process').Create($fullCmd)
  if ($wmiRes -and $wmiRes.ReturnValue -eq 0) {
    Write-Output '{"ok":true,"method":"wmi_fallback"}'
    exit 0
  }
} catch {}

Start-Process -FilePath $psBin -ArgumentList $innerArgs -WindowStyle Hidden
Write-Output '{"ok":true,"method":"start_process"}'
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
export async function triggerDesktopHostRelaunch({
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  stalePortFiles = [],
  readOnlyShortcutPaths = [],
  execFileFn = null,
  spawnFn = null,
  existsFn = existsSync,
  writeFileFn = writeFileSync,
  mkdirFn = mkdirSync,
  allowInTest = false,
} = {}) {
  if (lsRuntimeEndpoint.addr === 'test.invalid' && !allowInTest) {
    return { ok: false, status: 403, error: 'Disabled in test sandbox' };
  }

  let hostInfo = resolveDesktopHostExecutable({ env, platform, homeDir, existsFn });
  if (!hostInfo.found) {
    hostInfo = await discoverRunningHostExecutable({ platform, env, execFileFn });
  }
  if (!hostInfo.found) {
    return {
      ok: false,
      status: 404,
      error: 'Unable to locate Antigravity executable on this machine',
    };
  }

  const cleanEnv = buildSanitizedDesktopRelaunchEnv(env);
  const cleanStaleFiles = (Array.isArray(stalePortFiles) ? stalePortFiles : [])
    .map((p) => String(p || '').trim())
    .filter(Boolean);
  const cleanReadOnlyPaths = (Array.isArray(readOnlyShortcutPaths) ? readOnlyShortcutPaths : [])
    .map((p) => String(p || '').trim())
    .filter(Boolean);

  if (platform === 'win32') {
    const psExe = execFileFn ? 'powershell.exe' : resolveWindowsPowerShellExecutable(env, existsFn);
    const innerScript = buildWindowsRelaunchInnerScript(
      hostInfo.executablePath,
      cleanStaleFiles,
      hostInfo.kind,
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
    await runner(
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
        timeoutMs: 6000,
        env: {
          ...cleanEnv,
          AGY_PS_EXE: psExe,
          AGY_RELAUNCH_PS1: relaunchPs1Path,
        },
      }
    );
    return {
      ok: true,
      relaunching: true,
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
      bundleDerivedName || (hostInfo.kind === 'ide' ? 'Antigravity IDE' : 'Antigravity');
    const shScript = [
      'sleep 0.45',
      'if osascript -e \'on run argv\' -e \'tell application (item 1 of argv) to quit\' -e \'end run\' -- "$AGY_APP_NAME" >/dev/null 2>&1; then i=0; while [ $i -lt 25 ] && pgrep -ax "$AGY_APP_NAME" >/dev/null 2>&1; do sleep 0.2; i=$((i+1)); done; fi',
      'if pgrep -ax "$AGY_APP_NAME" >/dev/null 2>&1; then pkill -TERM -ax "$AGY_APP_NAME" >/dev/null 2>&1 || killall -TERM "$AGY_APP_NAME" >/dev/null 2>&1 || true; j=0; while [ $j -lt 20 ] && pgrep -ax "$AGY_APP_NAME" >/dev/null 2>&1; do sleep 0.2; j=$((j+1)); done; fi',
      'if pgrep -ax "$AGY_APP_NAME" >/dev/null 2>&1; then pkill -KILL -ax "$AGY_APP_NAME" >/dev/null 2>&1 || killall -KILL "$AGY_APP_NAME" >/dev/null 2>&1 || true; k=0; while [ $k -lt 15 ] && pgrep -ax "$AGY_APP_NAME" >/dev/null 2>&1; do sleep 0.2; k=$((k+1)); done; fi',
      'old_ifs="$IFS"; set -f; IFS=":"; for f in $AGY_STALE_PORT_FILES; do [ -n "$f" ] && rm -f "$f"; done; set +f; IFS="$old_ifs"',
      'sleep 0.4',
      'open -a "$AGY_RELAUNCH_APP" --args --remote-debugging-port=0 >/dev/null 2>&1',
    ].join('; ');
    await spawner('/bin/sh', ['-c', shScript], {
      env: {
        ...cleanEnv,
        AGY_APP_NAME: appName,
        AGY_RELAUNCH_APP: appTarget,
        AGY_STALE_PORT_FILES: cleanStaleFiles.join(':'),
      },
    });
    return {
      ok: true,
      relaunching: true,
      platform,
      executablePath: appTarget,
    };
  }

  const procLeaf = basename(hostInfo.executablePath) || 'antigravity';
  const procComm = procLeaf.slice(0, 15);
  const linuxScript = [
    'sleep 0.45',
    'uid="$(id -u)"',
    'is_alive() { for pn in "$AGY_PROC_NAME" antigravity Antigravity "$AGY_PROC_COMM" google-antigravity; do [ -n "$pn" ] && pgrep -u "$uid" -x "$pn" >/dev/null 2>&1 && return 0; done; return 1; }',
    'for pn in "$AGY_PROC_NAME" antigravity Antigravity "$AGY_PROC_COMM" google-antigravity; do [ -n "$pn" ] && pkill -TERM -u "$uid" -x "$pn" >/dev/null 2>&1 || true; done',
    'i=0; while [ $i -lt 25 ] && is_alive; do sleep 0.2; i=$((i+1)); done',
    'if is_alive; then for pn in "$AGY_PROC_NAME" antigravity Antigravity "$AGY_PROC_COMM" google-antigravity; do [ -n "$pn" ] && pkill -KILL -u "$uid" -x "$pn" >/dev/null 2>&1 || true; done; j=0; while [ $j -lt 15 ] && is_alive; do sleep 0.2; j=$((j+1)); done; fi',
    'old_ifs="$IFS"; set -f; IFS=":"; for f in $AGY_STALE_PORT_FILES; do [ -n "$f" ] && rm -f "$f"; done; set +f; IFS="$old_ifs"',
    'nohup "$AGY_RELAUNCH_EXE" --remote-debugging-port=0 >/dev/null 2>&1 &',
  ].join('; ');
  await spawner('/bin/sh', ['-c', linuxScript], {
    env: {
      ...cleanEnv,
      AGY_RELAUNCH_EXE: hostInfo.executablePath,
      AGY_PROC_NAME: procLeaf,
      AGY_PROC_COMM: procComm,
      AGY_STALE_PORT_FILES: cleanStaleFiles.join(':'),
    },
  });
  return {
    ok: true,
    relaunching: true,
    platform,
    executablePath: hostInfo.executablePath,
  };
}

/**
 * 解析 BSD / macOS `ps -o etime=` 输出的进程运行时长（秒）。
 * 支持 `mm:ss`、`hh:mm:ss`、`dd-hh:mm:ss`；格式非法时返回 `null`（fail closed，绝不回退为 `0`）。
 *
 * @param {unknown} rawEtime
 * @returns {number|null}
 */
export function parsePsElapsedSeconds(rawEtime) {
  const text = String(rawEtime ?? '').trim();
  if (!text) return null;
  let m = text.match(/^(\d+)-(\d{1,2}):(\d{2}):(\d{2})$/);
  if (m) {
    const days = Number(m[1]);
    const hours = Number(m[2]);
    const mins = Number(m[3]);
    const secs = Number(m[4]);
    if (hours >= 24 || mins >= 60 || secs >= 60) return null;
    return days * 86400 + hours * 3600 + mins * 60 + secs;
  }
  m = text.match(/^(\d+):(\d{2}):(\d{2})$/);
  if (m) {
    const hours = Number(m[1]);
    const mins = Number(m[2]);
    const secs = Number(m[3]);
    if (mins >= 60 || secs >= 60) return null;
    return hours * 3600 + mins * 60 + secs;
  }
  m = text.match(/^(\d+):(\d{2})$/);
  if (m) {
    const mins = Number(m[1]);
    const secs = Number(m[2]);
    if (secs >= 60) return null;
    return mins * 60 + secs;
  }
  return null;
}

/**
 * 在 macOS 上通过 `ps -wwxo pid=,etime=,args=` 探测当前用户下运行中的 Antigravity Desktop 主进程。
 * - 使用 `-ww` 防止 80 列截断 `--remote-debugging-port=0` 参数；
 * - 省略 `-a` 避免跨用户进程串扰；
 * - 锚定可执行文件路径前缀并排除 `--type=` 与 `Helper` 子进程；
 * - 多匹配时取运行时长最长的最老主进程，确保冷启动年龄判断偏向保守（fail closed）。
 *
 * @param {{
 *   hostInfo?: { found?: boolean, kind?: string, appBundlePath?: string, executablePath?: string },
 *   execFileFn?: ((file: string, args: string[], opts?: object) => Promise<string>) | null,
 * }} [options]
 * @returns {Promise<{
 *   found: boolean,
 *   pid: number,
 *   elapsedSec: number|null,
 *   hasRemoteDebugFlag: boolean,
 *   appBundlePath: string,
 *   executablePath: string,
 * }>}
 */
export async function inspectMacDesktopHostProcess({ hostInfo = null, execFileFn = null } = {}) {
  const empty = {
    found: false,
    pid: 0,
    elapsedSec: null,
    hasRemoteDebugFlag: false,
    appBundlePath: '',
    executablePath: '',
  };
  const runner = execFileFn || runLauncherExecFile;
  let psOut = '';
  try {
    psOut = await runner('ps', ['-wwxo', 'pid=,etime=,args='], {
      timeoutMs: 3000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    return empty;
  }

  const targetBundle = String(hostInfo?.appBundlePath || '').trim().replace(/\/+$/, '');
  const targetPrefixLower = targetBundle ? `${targetBundle}/contents/macos/`.toLowerCase() : '';
  const rawTargetExec = String(hostInfo?.executablePath || '').trim();
  const targetExec =
    targetPrefixLower &&
    rawTargetExec.toLowerCase().startsWith(targetPrefixLower) &&
    !/helper/i.test(rawTargetExec.slice(targetPrefixLower.length))
      ? rawTargetExec
      : '';
  const targetExecLower = targetExec.toLowerCase();
  let best = null;

  for (const rawLine of String(psOut || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\s+(\S+)\s+([\s\S]+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const elapsedSec = parsePsElapsedSeconds(m[2]);
    if (elapsedSec === null) continue;
    const args = m[3].trim();
    if (!args || CHROMIUM_SUBPROCESS_TYPE_RE.test(args)) continue;

    let matchedBundle = '';
    let matchedExec = '';
    if (targetExecLower) {
      if (
        !args.toLowerCase().startsWith(targetExecLower) ||
        (args.length > targetExecLower.length && !/^\s/.test(args.slice(targetExecLower.length)))
      ) {
        continue;
      }
      matchedBundle = targetBundle;
      matchedExec = targetExec;
    } else if (targetPrefixLower) {
      if (!args.toLowerCase().startsWith(targetPrefixLower)) continue;
      const tail = args.slice(targetPrefixLower.length);
      const binLeaf = tail.split(/\s+(?=-|\S*\/)/)[0].trim();
      if (!binLeaf || binLeaf.includes('/') || /helper/i.test(binLeaf)) continue;
      matchedBundle = targetBundle;
      matchedExec = `${targetBundle}/Contents/MacOS/${binLeaf}`;
    } else {
      const bm = args.match(/^(\/.+?\.app)\/Contents\/MacOS\/([^/]+?)(?=\s+(?:-|\S*\/)|\s*$)/i);
      if (!bm) continue;
      const bundlePath = bm[1].replace(/\/+$/, '');
      const binLeaf = bm[2].trim();
      if (!/antigravity/i.test(bundlePath) && !/antigravity/i.test(binLeaf)) continue;
      if (/antigravity\s*ide\.app$/i.test(bundlePath)) continue;
      if (/helper/i.test(bundlePath) || /helper/i.test(binLeaf)) continue;
      matchedBundle = bundlePath;
      matchedExec = `${bundlePath}/Contents/MacOS/${binLeaf}`;
    }

    const candidate = {
      found: true,
      pid,
      elapsedSec,
      hasRemoteDebugFlag: REMOTE_DEBUG_ANY_RE.test(args),
      appBundlePath: matchedBundle,
      executablePath: matchedExec,
    };
    if (!best || candidate.elapsedSec > best.elapsedSec) {
      best = candidate;
    }
  }

  return best || empty;
}

function resolveMacStateFsOps(fsOps = null) {
  return {
    existsFn: fsOps?.existsFn || fsOps?.existsSync || existsSync,
    readFn: fsOps?.readFn || fsOps?.readFileSync || readFileSync,
    mkdirFn: fsOps?.mkdirFn || fsOps?.mkdirSync || mkdirSync,
    writeFn: fsOps?.writeFn || fsOps?.writeFileSync || writeFileSync,
    renameFn: fsOps?.renameFn || fsOps?.renameSync || renameSync,
    unlinkFn: fsOps?.unlinkFn || fsOps?.unlinkSync || unlinkSync,
  };
}

function readMacAutoRelaunchState({
  stateFilePath = MAC_AUTO_RELAUNCH_STATE_FILE,
  fsOps = null,
} = {}) {
  const { existsFn, readFn } = resolveMacStateFsOps(fsOps);
  const fallback = { lastHostPid: 0, lastAttemptAtMs: 0, consecutiveFailures: 0 };
  if (!stateFilePath) return fallback;
  try {
    if (!existsFn(stateFilePath)) return fallback;
    const parsed = JSON.parse(String(readFn(stateFilePath, 'utf8') || '{}'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    return {
      lastHostPid: Number.isInteger(Number(parsed.lastHostPid)) ? Number(parsed.lastHostPid) : 0,
      lastAttemptAtMs:
        Number.isFinite(Number(parsed.lastAttemptAtMs)) && Number(parsed.lastAttemptAtMs) > 0
          ? Number(parsed.lastAttemptAtMs)
          : 0,
      consecutiveFailures:
        Number.isInteger(Number(parsed.consecutiveFailures)) && Number(parsed.consecutiveFailures) > 0
          ? Number(parsed.consecutiveFailures)
          : 0,
    };
  } catch {
    return fallback;
  }
}

function writeMacAutoRelaunchState(
  state,
  { stateFilePath = MAC_AUTO_RELAUNCH_STATE_FILE, fsOps = null } = {}
) {
  const effectiveFs = resolveMacStateFsOps(fsOps);
  writeTextFileAtomically(stateFilePath, `${JSON.stringify(state, null, 2)}\n`, effectiveFs);
}

/**
 * 重置 macOS 自动重拉的连续失败熔断计数（在 CDP 恢复连通、用户手动重启或重新开启设置时调用）。
 * 文件不存在或计数已为 0 时零磁盘写入。
 */
export function resetMacAutoRelaunchState({
  stateFilePath = MAC_AUTO_RELAUNCH_STATE_FILE,
  fsOps = null,
  allowInTest = false,
} = {}) {
  if (lsRuntimeEndpoint.addr === 'test.invalid' && !allowInTest) {
    return { reset: false, reason: 'test_sandbox' };
  }
  const { existsFn } = resolveMacStateFsOps(fsOps);
  if (!stateFilePath) return { reset: false, reason: 'no_state_file' };
  try {
    if (!existsFn(stateFilePath)) return { reset: false, reason: 'absent' };
    const current = readMacAutoRelaunchState({ stateFilePath, fsOps });
    if (current.consecutiveFailures <= 0) {
      return { reset: false, reason: 'already_clean' };
    }
    writeMacAutoRelaunchState(
      {
        ...current,
        consecutiveFailures: 0,
      },
      { stateFilePath, fsOps }
    );
    return { reset: true, reason: 'cleared' };
  } catch {
    return { reset: false, reason: 'io_error' };
  }
}

/**
 * macOS 冷启动无调试端口自动带参重拉守卫。
 * 严格满足：opt-in 启用、Desktop 宿主、进程刚启动（`<= maxHostAgeSec`）、无 `--remote-debugging-port` 参数、
 * 未对同一 PID 重试过、冷却期已过（`cooldownMs > maxHostAgeSec * 1000`）、未触发连续失败熔断，
 * 且先落盘防环状态成功（fail closed）后再触发重拉。
 */
export async function maybeAutoRelaunchMacDesktopHost({
  enabled = false,
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  stalePortFiles = [],
  stateFilePath = MAC_AUTO_RELAUNCH_STATE_FILE,
  nowMs = Date.now(),
  maxHostAgeSec = MAC_AUTO_RELAUNCH_MAX_HOST_AGE_SEC,
  cooldownMs = MAC_AUTO_RELAUNCH_COOLDOWN_MS,
  maxConsecutiveFailures = MAC_AUTO_RELAUNCH_MAX_CONSECUTIVE_FAILURES,
  execFileFn = null,
  spawnFn = null,
  existsFn = existsSync,
  fsOps = null,
  allowInTest = false,
} = {}) {
  if (platform !== 'darwin') {
    return { attempted: false, ok: false, reason: 'unsupported_platform' };
  }
  if (!enabled) {
    return { attempted: false, ok: false, reason: 'disabled' };
  }
  if (lsRuntimeEndpoint.addr === 'test.invalid' && !allowInTest) {
    return { attempted: false, ok: false, reason: 'test_sandbox' };
  }

  const hostInfo = resolveDesktopHostExecutable({ env, platform, homeDir, existsFn });
  if (hostInfo.found && hostInfo.kind !== 'desktop') {
    return { attempted: false, ok: false, reason: 'not_desktop_host' };
  }

  const hostProc = await inspectMacDesktopHostProcess({
    hostInfo: hostInfo.found ? hostInfo : null,
    execFileFn,
  });
  if (!hostProc.found) {
    return { attempted: false, ok: false, reason: 'host_process_not_found' };
  }
  if (hostProc.hasRemoteDebugFlag) {
    return { attempted: false, ok: false, reason: 'already_has_debug_flag', pid: hostProc.pid };
  }
  if (hostProc.elapsedSec === null || hostProc.elapsedSec > maxHostAgeSec) {
    return {
      attempted: false,
      ok: false,
      reason: 'uptime_exceeded',
      pid: hostProc.pid,
      elapsedSec: hostProc.elapsedSec,
    };
  }

  const prevState = readMacAutoRelaunchState({ stateFilePath, fsOps });
  if (prevState.lastHostPid > 0 && prevState.lastHostPid === hostProc.pid) {
    return { attempted: false, ok: false, reason: 'already_attempted_for_pid', pid: hostProc.pid };
  }
  if (prevState.consecutiveFailures >= maxConsecutiveFailures) {
    return {
      attempted: false,
      ok: false,
      reason: 'circuit_open',
      pid: hostProc.pid,
      consecutiveFailures: prevState.consecutiveFailures,
    };
  }
  if (prevState.lastAttemptAtMs > 0 && nowMs - prevState.lastAttemptAtMs < cooldownMs) {
    return { attempted: false, ok: false, reason: 'cooldown', pid: hostProc.pid };
  }

  // 必须先持久化防环状态再触发重拉；若磁盘不可写则 fail closed 中止，绝不冒无限重启风险
  const nextState = {
    lastHostPid: hostProc.pid,
    lastAttemptAtMs: nowMs,
    consecutiveFailures: prevState.consecutiveFailures + 1,
  };
  try {
    writeMacAutoRelaunchState(nextState, { stateFilePath, fsOps });
  } catch (err) {
    return {
      attempted: false,
      ok: false,
      reason: 'state_persist_failed',
      error: err?.message || String(err),
    };
  }

  const relaunchEnv =
    !hostInfo.found && hostProc.appBundlePath
      ? { ...env, USAGE_MONITOR_HOST_EXE: hostProc.appBundlePath }
      : env;
  const relaunchRes = await triggerDesktopHostRelaunch({
    env: relaunchEnv,
    platform,
    homeDir,
    stalePortFiles,
    execFileFn,
    spawnFn,
    existsFn: !hostInfo.found && hostProc.appBundlePath
      ? (p) => p === hostProc.appBundlePath || existsFn(p)
      : existsFn,
    allowInTest,
  });
  return {
    attempted: true,
    ok: Boolean(relaunchRes?.ok),
    reason: relaunchRes?.ok ? 'triggered' : 'relaunch_failed',
    pid: hostProc.pid,
    elapsedSec: hostProc.elapsedSec,
    relaunchResult: relaunchRes,
  };
}
