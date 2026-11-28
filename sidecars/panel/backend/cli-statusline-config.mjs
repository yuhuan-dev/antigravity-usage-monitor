/**
 * @fileoverview Antigravity CLI (`agy`) 底部状态栏胶囊 (`statusLine`) 配置管理与终端 ANSI 渲染器。
 *
 * 负责两部分纯逻辑与安全落盘职责：
 * 1. 无损维护 `~/.gemini/antigravity-cli/settings.json` 中的 `statusLine` 配置：
 *    - 仅当 `~/.gemini/antigravity-cli` 目录已存在时生效；
 *    - 若用户已自行配置第三方 `statusLine.command`（非本插件 `cli-statusline.mjs`），严格原样保留绝不覆盖；
 *    - 开启时默认以 `stack_with_default: false` 单行内联接管底栏（左侧保留 `? for shortcuts`，中间渲染无底色监控指标，右侧保留 `auto · Model · effort`）；关闭时干净移除本插件托管项；
 * 2. 将 13 项胶囊槽位（`TOPBAR_SLOT_KEYS`）与多会话状态渲染为兼容 Windows `cmd.exe` (CP936) /
 *    PowerShell / Windows Terminal / macOS / Linux 的单行无底色 24-bit ANSI 状态条（仅使用标准前景 CSI SGR，
 *    避免深色背景色块突兀及 OSC 序列干扰 Bubble Tea 宽度计算）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeTextFileAtomicSync } from './fs-atomic.mjs';
import {
  HERE,
  lsRuntimeEndpoint,
  normalizeCliStatusLineSlots,
  normalizeLanguageSetting,
  normalizeTopbarCapsuleSlots,
} from './config.mjs';
import {
  isTopbarMultiSessionVisible,
  normalizeTopbarMultiSessionMode,
  resolveLocaleFromLanguageTag,
} from '../shared/settings-normalization.mjs';
import {
  classifyCacheTier,
  classifySpeedTier,
  classifyStepCostTier,
  classifyTtftTier,
  formatCompactCapsuleCost,
  formatCompactCapsuleTtft,
  formatCompactTokens,
  hasArgonWeeklyQuotaPool,
  resolveCapsuleQuotaSlotPct,
} from '../shared/telemetry-display-rules.mjs';

export const CLI_STATUSLINE_GAUGE_STYLES = Object.freeze(['pill', 'bar', 'compact']);

/**
 * 归一化 CLI 进度指示器样式（`pill` 底色胶囊 / `bar` 透明盲文条 / `compact` 极简纯文本）。
 *
 * @param {unknown} raw
 * @returns {'pill'|'bar'|'compact'}
 */
export function normalizeCliStatusLineGaugeStyle(raw) {
  const val = String(raw || '').trim().toLowerCase();
  if (val === 'bar' || val === 'braille') return 'bar';
  if (val === 'compact' || val === 'text' || val === 'plain') return 'compact';
  return 'pill';
}

// 24-bit ANSI SGR 调色板（和桌面端语义色阶及 CLI 原生底栏对齐；上下文和配额槽位采用 24-bit 底色胶囊填充，零 OSC 序列）
const SGR_RESET = '\x1b[0m';
const SGR_BOLD = '\x1b[1m';
const SGR_FG_BRIGHT = '\x1b[38;2;226;232;240m';
const SGR_FG_NORMAL = '\x1b[38;2;203;213;225m';
const SGR_FG_MUTED = '\x1b[38;2;148;163;184m';
const SGR_FG_DIM = '\x1b[38;2;120;133;155m';
const SGR_FG_CHROME = '\x1b[38;2;136;142;150m';
const SGR_FG_SEP = '\x1b[38;2;110;122;140m';
const SGR_FG_DOT_IDLE = '\x1b[38;2;100;116;139m';
const SGR_FG_ACCENT = '\x1b[38;2;96;165;250m';
const SGR_FG_GOOD = '\x1b[38;2;52;211;153m';
const SGR_FG_INFO = '\x1b[38;2;56;189;248m';
const SGR_FG_WARN = '\x1b[38;2;251;191;36m';
const SGR_FG_DANGER = '\x1b[38;2;248;113;113m';
const SGR_FG_MODE_AUTO = '\x1b[38;2;234;179;8m';
const SGR_FG_MODE_VIOLET = '\x1b[38;2;192;132;252m';

// 底色胶囊专用 24-bit 背景和前景对比色（深灰暗轨 + 四档低刺眼饱和填充底色 + 亮白数字）
const SGR_BG_PILL_TRACK = '\x1b[48;2;36;40;50m';
const SGR_BG_PILL_BLUE = '\x1b[48;2;36;72;128m';
const SGR_BG_PILL_GREEN = '\x1b[48;2;24;96;68m';
const SGR_BG_PILL_WARN = '\x1b[48;2;116;84;22m';
const SGR_BG_PILL_DANGER = '\x1b[48;2;124;42;48m';
const SGR_FG_PILL_LABEL_TRACK = '\x1b[38;2;176;186;202m';
const SGR_FG_PILL_VAL_TRACK = `${SGR_BOLD}\x1b[38;2;238;242;248m`;
const SGR_FG_PILL_LABEL_BLUE = '\x1b[38;2;216;230;250m';
const SGR_FG_PILL_LABEL_GREEN = '\x1b[38;2;210;244;228m';
const SGR_FG_PILL_LABEL_WARN = '\x1b[38;2;254;240;199m';
const SGR_FG_PILL_LABEL_DANGER = '\x1b[38;2;254;222;224m';
const SGR_FG_PILL_VAL_FILLED = `${SGR_BOLD}\x1b[38;2;248;250;252m`;

function isCliStatusPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 解析 `~/.gemini/antigravity-cli/settings.json` 路径（支持 `ANTIGRAVITY_GEMINI_DIR` 覆盖）。
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @param {string} [homeDir=homedir()]
 * @returns {string}
 */
export function resolveCliSettingsPath(env = process.env, homeDir = homedir()) {
  const geminiBase = String(env?.ANTIGRAVITY_GEMINI_DIR || '').trim() || join(homeDir, '.gemini');
  return join(geminiBase, 'antigravity-cli', 'settings.json');
}

/**
 * 优先解析本机已安装插件目录下的 `cli-statusline.mjs`，不存在时回退至当前运行目录 `HERE`。
 *
 * @param {{ env?: Record<string, string|undefined>, homeDir?: string, fallbackHere?: string }} [options]
 * @returns {string}
 */
export function resolvePreferredCliStatusLineScriptPath({
  env = process.env,
  homeDir = homedir(),
  fallbackHere = HERE,
} = {}) {
  const geminiBase = String(env?.ANTIGRAVITY_GEMINI_DIR || '').trim() || join(homeDir, '.gemini');
  const installedCandidate = join(
    geminiBase,
    'config',
    'plugins',
    'usage-monitor',
    'sidecars',
    'panel',
    'cli-statusline.mjs'
  );
  if (existsSync(installedCandidate)) {
    return installedCandidate;
  }
  return join(fallbackHere, 'cli-statusline.mjs');
}

/**
 * 检测当前环境变量 `PATH` 中是否可直接定位 `node` 可执行文件。
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @param {string} [platform=process.platform]
 * @returns {boolean}
 */
export function detectNodeOnSystemPath(env = process.env, platform = process.platform) {
  const rawPath = String(env?.PATH || env?.Path || env?.path || '').trim();
  if (!rawPath) return false;
  const binNames = platform === 'win32' ? ['node.exe', 'node.cmd', 'node'] : ['node'];
  const sep = platform === 'win32' ? ';' : delimiter;
  for (const rawDir of rawPath.split(sep)) {
    const cleanDir = rawDir.trim().replace(/^"+|"+$/g, '');
    if (!cleanDir) continue;
    for (const bin of binNames) {
      try {
        if (existsSync(join(cleanDir, bin))) return true;
      } catch {
        // 忽略无权限目录
      }
    }
  }
  return false;
}

function toPercentEncodedFileUrl(winOrPosixPath) {
  const clean = String(winOrPosixPath || '').trim().replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(clean)) {
    const encoded = clean
      .split('/')
      .map((seg, idx) => (idx === 0 ? seg : encodeURIComponent(seg)))
      .join('/');
    return `file:///${encoded}#autorun`;
  }
  try {
    return `${pathToFileURL(clean).href}#autorun`;
  } catch {
    return `file://${encodeURI(clean)}#autorun`;
  }
}

/**
 * 构造跨平台安全的 `statusLine.command` 字符串：
 * - Windows 下 `agy.exe` 通过 Go `exec.Command("cmd", "/c", command)` 执行：Go 的 `syscall.EscapeArg`
 *   会把 `command` 内的任何双引号 `"` 转义成 `\"`，而 `cmd.exe` 不消费 `\"` 会将其原样传给 `node.exe`，
 *   导致 `argv[1]` 混入字面量双引号而找不到模块。因此 Windows 下严格避免在 `command` 中出现双引号 `"`：
 *   - 路径无空格时直接生成 `node C:/.../cli-statusline.mjs`；
 *   - 路径含空格时生成零双引号、零空格参数的 `node --input-type=module -e import('file:///C:/...%20.../cli-statusline.mjs#autorun')`；
 * - macOS / Linux 下由 `sh -c` 解析，正常使用标准引号包裹。
 *
 * @param {string} scriptPath
 * @param {{ platform?: string, execPath?: string, nodeOnPath?: boolean }} [options]
 * @returns {string}
 */
export function buildCliStatusLineCommand(
  scriptPath,
  {
    platform = process.platform,
    execPath = process.execPath,
    nodeOnPath = true,
    extraFlags = '',
  } = {}
) {
  const normScript = String(scriptPath || '').trim().replace(/\\/g, '/');
  const cleanFlags = String(extraFlags || '').trim().replace(/"/g, '');
  if (platform === 'win32') {
    const normExec = String(execPath || 'node').trim().replace(/\\/g, '/');
    const runner = nodeOnPath || /\s/.test(normExec) ? 'node' : normExec;
    if (!/\s/.test(normScript)) {
      return cleanFlags ? `${runner} ${normScript} ${cleanFlags}` : `${runner} ${normScript}`;
    }
    const fileUrl = toPercentEncodedFileUrl(normScript).replace(/'/g, '%27');
    const base = `${runner} --input-type=module -e import('${fileUrl}')`;
    return cleanFlags ? `${base} -- ${cleanFlags}` : base;
  }
  if (nodeOnPath) {
    const base = `node "${normScript.replace(/"/g, '\\"')}"`;
    return cleanFlags ? `${base} ${cleanFlags}` : base;
  }
  const escapedExec = String(execPath || 'node').replace(/"/g, '\\"');
  const escapedScript = normScript.replace(/"/g, '\\"');
  const base = `"${escapedExec}" "${escapedScript}"`;
  return cleanFlags ? `${base} ${cleanFlags}` : base;
}

/**
 * 判断一条 `statusLine.command` 是否由本插件托管（指向 `cli-statusline.mjs`）。
 *
 * @param {unknown} cmd
 * @returns {boolean}
 */
export function isManagedCliStatusLineCommand(cmd) {
  if (typeof cmd !== 'string') return false;
  const trimmed = cmd.trim();
  if (!trimmed) return false;
  return /(?:^|[\\/\s"'])cli-statusline\.mjs(?:#autorun)?(?:["')\s]|$)/i.test(trimmed);
}

/**
 * 提取用户通过 `/statusline` 追加在托管命令末尾的参数（如 `--slots tps,cost,context --no-multi`）。
 *
 * @param {unknown} cmd
 * @returns {string}
 */
export function extractManagedCliStatusLineFlags(cmd) {
  if (!isManagedCliStatusLineCommand(cmd)) return '';
  const trimmed = String(cmd || '').trim();
  const m = trimmed.match(/cli-statusline\.mjs(?:#autorun)?(?:["')]+)?\s+(--[\s\S]+)$/i);
  if (!m) return '';
  return m[1].replace(/^--\s+/, '').trim();
}

/**
 * 探测本机是否已安装并初始化 Antigravity CLI（`~/.gemini/antigravity-cli`），
 * 及当前 CLI `settings.json` 中的 `statusLine` 托管状态（零子进程、纯本地文件探测）。
 *
 * @param {{ env?: Record<string, string|undefined>, homeDir?: string }} [options]
 * @returns {{ installed: boolean, configured: boolean, preservedCustom: boolean, managedFlags: string }}
 */
export function getCliStatusLineRuntimeStatus({
  env = process.env,
  homeDir = homedir(),
} = {}) {
  const settingsPath = resolveCliSettingsPath(env, homeDir);
  const cliDir = dirname(settingsPath);
  let installed = false;
  try {
    installed = existsSync(cliDir);
  } catch {
    installed = false;
  }
  if (!installed) {
    return {
      installed: false,
      configured: false,
      preservedCustom: false,
      managedFlags: '',
    };
  }

  let configured = false;
  let preservedCustom = false;
  let managedFlags = '';
  try {
    if (existsSync(settingsPath)) {
      const raw = readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '').trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        const sl = parsed?.statusLine;
        if (isCliStatusPlainObject(sl)) {
          const cmd = typeof sl.command === 'string' ? sl.command.trim() : '';
          if (cmd) {
            if (isManagedCliStatusLineCommand(cmd)) {
              configured = sl.enabled !== false;
              managedFlags = extractManagedCliStatusLineFlags(cmd);
            } else {
              preservedCustom = true;
            }
          }
        } else if (sl !== undefined && sl !== null) {
          preservedCustom = true;
        }
      }
    }
  } catch {
    // 忽略损坏或无权限读取的 CLI settings.json
  }

  return {
    installed: true,
    configured,
    preservedCustom,
    managedFlags,
  };
}

/**
 * 在纯对象层面更新或移除本插件托管的 `statusLine` 配置，绝不覆盖用户自定义的第三方脚本，
 * 并在未显式覆盖参数时保留用户在 `/statusline` 命令末尾附加的定制参数。
 *
 * @param {unknown} rawObj
 * @param {{ enabled?: boolean, command?: string, stackWithDefault?: boolean, preserveManagedFlags?: boolean }} [options]
 */
export function applyCliStatusLineToSettingsObject(
  rawObj,
  {
    enabled = true,
    command = '',
    stackWithDefault = false,
    preserveManagedFlags = true,
    forceReplaceCustom = false,
  } = {}
) {
  const baseObj = isCliStatusPlainObject(rawObj) ? rawObj : {};
  const existing = baseObj.statusLine;
  let existingCmd = '';

  if (isCliStatusPlainObject(existing)) {
    existingCmd = typeof existing.command === 'string' ? existing.command.trim() : '';
    if (existingCmd && !isManagedCliStatusLineCommand(existingCmd) && !forceReplaceCustom) {
      return {
        changed: false,
        preservedCustom: true,
        reason: 'custom_command_preserved',
        object: baseObj,
      };
    }
  } else if (existing !== undefined && existing !== null && !forceReplaceCustom) {
    return {
      changed: false,
      preservedCustom: true,
      reason: 'custom_statusline_preserved',
      object: baseObj,
    };
  }

  if (!enabled) {
    if (!Object.prototype.hasOwnProperty.call(baseObj, 'statusLine')) {
      return {
        changed: false,
        alreadyRemoved: true,
        object: baseObj,
      };
    }
    const nextObj = { ...baseObj };
    delete nextObj.statusLine;
    return {
      changed: true,
      removed: true,
      object: nextObj,
    };
  }

  let cleanCmd = String(command || '').trim();
  if (!cleanCmd) {
    return {
      changed: false,
      reason: 'empty_command',
      object: baseObj,
    };
  }
  if (preserveManagedFlags && !extractManagedCliStatusLineFlags(cleanCmd)) {
    const prevFlags = extractManagedCliStatusLineFlags(existingCmd);
    if (prevFlags) {
      const isAutorun = cleanCmd.includes('--input-type=module -e import(');
      cleanCmd = isAutorun ? `${cleanCmd} -- ${prevFlags}` : `${cleanCmd} ${prevFlags}`;
    }
  }

  const prevBlock = isCliStatusPlainObject(existing) ? existing : {};
  const desiredPadding =
    Number.isInteger(prevBlock.padding) && prevBlock.padding >= 0 ? prevBlock.padding : 0;
  const desiredStack = typeof stackWithDefault === 'boolean' ? stackWithDefault : false;

  const nextStatusLine = {
    ...prevBlock,
    type: 'command',
    command: cleanCmd,
    enabled: true,
    padding: desiredPadding,
    stack_with_default: desiredStack,
  };

  const unchanged =
    isCliStatusPlainObject(existing) &&
    existing.type === nextStatusLine.type &&
    existing.command === nextStatusLine.command &&
    existing.enabled === nextStatusLine.enabled &&
    existing.padding === nextStatusLine.padding &&
    existing.stack_with_default === nextStatusLine.stack_with_default;

  if (unchanged) {
    return {
      changed: false,
      alreadyConfigured: true,
      object: baseObj,
    };
  }

  return {
    changed: true,
    configured: true,
    object: {
      ...baseObj,
      statusLine: nextStatusLine,
    },
  };
}

/**
 * 同步本插件在 `~/.gemini/antigravity-cli/settings.json` 中的托管 `statusLine` 配置。
 *
 * @param {{
 *   enabled?: boolean,
 *   env?: Record<string, string|undefined>,
 *   homeDir?: string,
 *   scriptPath?: string,
 *   platform?: string,
 *   execPath?: string,
 *   nodeOnPath?: boolean,
 * }} [options]
 */
export function ensureCliStatusLineConfigured({
  enabled = true,
  env = process.env,
  homeDir = homedir(),
  scriptPath = '',
  platform = process.platform,
  execPath = process.execPath,
  nodeOnPath,
  extraFlags = '',
  preserveManagedFlags = true,
  forceReplaceCustom = false,
} = {}) {
  if (
    lsRuntimeEndpoint.addr === 'test.invalid' &&
    String(env?.USAGE_MONITOR_ALLOW_TEST_CLI_SETTINGS || '') !== '1'
  ) {
    return { checked: false, updated: false, reason: 'test_sandbox_skipped' };
  }

  const settingsPath = resolveCliSettingsPath(env, homeDir);
  try {
    const cliDir = dirname(settingsPath);
    if (!existsSync(cliDir)) {
      return { checked: true, updated: false, reason: 'cli_dir_missing', settingsPath };
    }

    let currentObj = {};
    let eol = platform === 'win32' ? '\r\n' : '\n';
    if (existsSync(settingsPath)) {
      const rawText = readFileSync(settingsPath, 'utf8');
      if (rawText.includes('\r\n')) eol = '\r\n';
      else if (rawText.includes('\n')) eol = '\n';
      const trimmed = rawText.replace(/^\uFEFF/, '').trim();
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed);
          if (!isCliStatusPlainObject(parsed)) {
            return { checked: true, updated: false, reason: 'non_object_json', settingsPath };
          }
          currentObj = parsed;
        } catch {
          return { checked: true, updated: false, reason: 'invalid_json', settingsPath };
        }
      }
    } else if (!enabled) {
      return { checked: true, updated: false, alreadyRemoved: true, settingsPath };
    }

    const resolvedScript =
      scriptPath || resolvePreferredCliStatusLineScriptPath({ env, homeDir });
    const hasNodePath =
      typeof nodeOnPath === 'boolean' ? nodeOnPath : detectNodeOnSystemPath(env, platform);
    const command = buildCliStatusLineCommand(resolvedScript, {
      platform,
      execPath,
      nodeOnPath: hasNodePath,
      extraFlags,
    });

    const applied = applyCliStatusLineToSettingsObject(currentObj, {
      enabled,
      command,
      preserveManagedFlags: extraFlags ? false : preserveManagedFlags,
      forceReplaceCustom,
    });
    if (!applied.changed) {
      return {
        checked: true,
        updated: false,
        ...applied,
        command,
        settingsPath,
      };
    }

    const serialized = `${JSON.stringify(applied.object, null, 2).replace(/\n/g, eol)}${eol}`;
    writeTextFileAtomicSync(settingsPath, serialized);

    return {
      checked: true,
      updated: true,
      ...applied,
      command,
      settingsPath,
    };
  } catch (err) {
    return {
      checked: true,
      updated: false,
      reason: 'io_error',
      error: err?.message || String(err),
      settingsPath,
    };
  }
}

// ---------------------------------------------------------------------------
// 胶囊槽位纯格式化与终端 ANSI 渲染（与前端 `metricRegistry.js` 语义阈值 1:1 对齐）
// ---------------------------------------------------------------------------

function cliStatusSpeedSgr(tokPerSec) {
  const tier = classifySpeedTier(tokPerSec);
  if (tier === 'good') return SGR_FG_GOOD;
  if (tier === 'info') return SGR_FG_INFO;
  if (tier === 'warn') return SGR_FG_WARN;
  if (tier === 'danger') return SGR_FG_DANGER;
  return SGR_FG_MUTED;
}

function cliStatusCacheSgr(cacheHitPct, promptTokens = null) {
  const tier = classifyCacheTier(cacheHitPct, promptTokens);
  if (tier === 'good') return SGR_FG_GOOD;
  if (tier === 'info') return SGR_FG_INFO;
  if (tier === 'warn') return SGR_FG_WARN;
  if (tier === 'danger') return SGR_FG_DANGER;
  return SGR_FG_MUTED;
}

function cliStatusCostSgr(costUsd) {
  const tier = classifyStepCostTier(costUsd);
  if (tier === 'danger') return SGR_FG_DANGER;
  if (tier === 'warn') return SGR_FG_WARN;
  return SGR_FG_NORMAL;
}

function cliStatusTtftSgr(ttftSec) {
  const tier = classifyTtftTier(ttftSec);
  if (tier === 'muted') return SGR_FG_MUTED;
  if (tier === 'danger') return SGR_FG_DANGER;
  if (tier === 'warn') return SGR_FG_WARN;
  return SGR_FG_NORMAL;
}

const cliFormatCompactCost = formatCompactCapsuleCost;
const cliFormatCompactTtft = formatCompactCapsuleTtft;
const cliFormatTokens = formatCompactTokens;
const cliResolveQuotaPct = resolveCapsuleQuotaSlotPct;

/**
 * 计算终端可见列宽（剥离 CSI SGR 转义序列，CJK 全角字符按 2 列、`●`/`◎`/`·` 与 ASCII 按 1 列计算）。
 *
 * @param {string} rawStr
 * @returns {number}
 */
export function cliDisplayWidth(rawStr) {
  const plain = String(rawStr || '').replace(/\x1b\[[0-9;]*m/g, '');
  let cols = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) || 0;
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || (cp >= 0x0300 && cp <= 0x036f)) {
      continue;
    }
    const isWide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3040 && cp <= 0x33bf) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe6f) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f000 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    cols += isWide ? 2 : 1;
  }
  return cols;
}

/**
 * 拆分 CLI 模型显示名与推理档位（例如将 `"Gemini 4 Hydrogen (Medium)"` 拆为 `"Gemini 4 Hydrogen"` + `"medium"`，
 * 与 `agy` 原生 `stripEffortSuffix` 显示效果一致）。
 *
 * @param {unknown} rawModelName
 * @param {unknown} [rawEffort]
 * @returns {{ modelName: string, effort: string }}
 */
export function parseCliModelAndEffort(rawModelName, rawEffort = '') {
  const cleanModel = String(rawModelName || '').trim();
  let modelName = cleanModel;
  let inferredEffort = '';
  const suffixMatch = cleanModel.match(/^(.*?)\s*\((minimal|low|medium|high|max|xhigh)\)\s*$/i);
  if (suffixMatch) {
    modelName = suffixMatch[1].trim();
    inferredEffort = suffixMatch[2].toLowerCase();
  }
  const explicitEffort = String(rawEffort || '')
    .trim()
    .replace(/^EFFORT_/i, '')
    .toLowerCase();
  return {
    modelName,
    effort: explicitEffort || inferredEffort,
  };
}

function normalizeCliCycleMode(rawMode) {
  const trimmed = String(rawMode || '')
    .trim()
    .replace(/^(?:AGENT_MODE_|PERMISSION_MODE_)/i, '')
    .toLowerCase();
  if (!trimmed || trimmed === 'none' || trimmed === 'default' || trimmed === 'unspecified') {
    return '';
  }
  return trimmed.replace(/_/g, '-');
}

function cliModeSgr(normMode) {
  if (normMode === 'auto') return SGR_FG_MODE_AUTO;
  if (normMode === 'plan') return SGR_FG_ACCENT;
  if (normMode === 'accept-edits' || normMode === 'edit') return SGR_FG_GOOD;
  if (normMode === 'best-of-n' || normMode === 'battle') return SGR_FG_MODE_VIOLET;
  return SGR_FG_CHROME;
}

function cliBuildLeftSegment({ vimMode = '', short = false, useColor = true } = {}) {
  const cleanVim = String(vimMode || '').trim().toUpperCase();
  const baseText = short
    ? '?'
    : cleanVim
      ? `${cleanVim} · ? for shortcuts`
      : '? for shortcuts';
  if (!useColor) return baseText;
  return `${SGR_FG_CHROME}${baseText}${SGR_RESET}`;
}

function cliBuildRightSegment({
  cycleMode = '',
  modelDisplayName = '',
  modelEffort = '',
  includeEffort = true,
  useColor = true,
} = {}) {
  const normMode = normalizeCliCycleMode(cycleMode);
  const { modelName, effort } = parseCliModelAndEffort(modelDisplayName, modelEffort);
  const plainParts = [];
  const styledParts = [];

  if (normMode) {
    plainParts.push(normMode);
    styledParts.push(useColor ? `${cliModeSgr(normMode)}${normMode}${SGR_RESET}` : normMode);
  }
  if (modelName) {
    plainParts.push(modelName);
    styledParts.push(useColor ? `${SGR_FG_CHROME}${modelName}${SGR_RESET}` : modelName);
  }
  if (includeEffort && effort) {
    plainParts.push(effort);
    styledParts.push(useColor ? `${SGR_FG_CHROME}${effort}${SGR_RESET}` : effort);
  }
  if (plainParts.length === 0) return '';
  if (!useColor) return plainParts.join(' · ');
  const dotSep = `${SGR_FG_CHROME} · ${SGR_RESET}`;
  return styledParts.join(dotSep);
}

function cliComposeBalancedThreeColumn(leftStr, centerStr, rightStr, maxWidth) {
  const lw = cliDisplayWidth(leftStr);
  const cw = cliDisplayWidth(centerStr);
  const rw = cliDisplayWidth(rightStr);
  if (leftStr && rightStr) {
    const free = maxWidth - lw - cw - rw;
    if (free < 4) return '';
    const leftGap = Math.floor(free / 2);
    const rightGap = free - leftGap;
    return `${leftStr}${' '.repeat(leftGap)}${centerStr}${' '.repeat(rightGap)}${rightStr}`;
  }
  if (leftStr && !rightStr) {
    if (lw + cw + 2 > maxWidth) return '';
    const idealCenterStart = Math.max(lw + 2, Math.floor((maxWidth - cw) / 2));
    const leftGap = Math.min(maxWidth - lw - cw, idealCenterStart - lw);
    return `${leftStr}${' '.repeat(leftGap)}${centerStr}`;
  }
  if (!leftStr && rightStr) {
    const free = maxWidth - cw - rw;
    if (free < 2) return '';
    return `${centerStr}${' '.repeat(free)}${rightStr}`;
  }
  return cw <= maxWidth ? centerStr : '';
}

/**
 * 将标签和百分比渲染为从左往右按占比填充背景的 24-bit 底色胶囊（如 ` 上下文 17% ` / ` G5h 83% `）。
 * 百分比按 3-4 列右对齐以防数值变化引起整行抖动，CJK 全角字符按 2 列中点判定归属。
 */
function cliBuildPillGauge(
  label,
  pct,
  {
    fillBg = SGR_BG_PILL_BLUE,
    fillLabelFg = SGR_FG_PILL_LABEL_BLUE,
    fillValFg = SGR_FG_PILL_VAL_FILLED,
    trackBg = SGR_BG_PILL_TRACK,
    trackLabelFg = SGR_FG_PILL_LABEL_TRACK,
    trackValFg = SGR_FG_PILL_VAL_TRACK,
  } = {}
) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  const valStr = `${Math.round(clamped)}%`.padStart(3, ' ');
  const prefixText = ` ${label} `;
  const valText = `${valStr} `;

  const cells = [];
  let totalCols = 0;
  for (const ch of prefixText) {
    const w = cliDisplayWidth(ch) || 1;
    cells.push({ ch, w, col: totalCols, isVal: false });
    totalCols += w;
  }
  for (const ch of valText) {
    const w = cliDisplayWidth(ch) || 1;
    cells.push({ ch, w, col: totalCols, isVal: true });
    totalCols += w;
  }

  const exactFill = (clamped / 100) * totalCols;
  const lastIdx = cells.length - 1;
  let out = '';
  let curStyle = '';

  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i];
    let isFilled = clamped > 0 && cell.col + cell.w / 2 <= exactFill;
    if (i === 0 && clamped > 0) isFilled = true;
    if (i === lastIdx && clamped < 96) isFilled = false;
    if (clamped >= 100) isFilled = true;

    const bg = isFilled ? fillBg : trackBg;
    const fg = isFilled
      ? cell.isVal
        ? fillValFg
        : fillLabelFg
      : cell.isVal
        ? trackValFg
        : trackLabelFg;
    const style = `${bg}${fg}`;
    if (style !== curStyle) {
      // 切换样式时若此前带粗体而目标不带粗体，先重置再写入避免粗体残留
      const prevBold = curStyle.includes(SGR_BOLD);
      const nextBold = style.includes(SGR_BOLD);
      out += prevBold && !nextBold ? `${SGR_RESET}${style}` : style;
      curStyle = style;
    }
    out += cell.ch;
  }
  return `${out}${SGR_RESET}`;
}

const CLI_BAR_PARTIAL_GLYPHS = Object.freeze([' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█']);
const CLI_BAR_TRACK_GLYPH = '⢕';

/**
 * 渲染零背景色的透明迷你进度条（如 `上下文 ██▌⢕⢕ 42%` / `G5h █████ 95%`），适配浅色/透明终端及老旧 SSH 复用器。
 */
function cliBuildBarGauge(label, pct, { fillFg = SGR_FG_ACCENT, valFg = SGR_FG_BRIGHT } = {}) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  const width = 5;
  const exactEighths = Math.round((clamped / 100) * width * 8);
  const fullCells = Math.floor(exactEighths / 8);
  const remEighths = exactEighths % 8;
  const filledPart =
    '█'.repeat(Math.min(width, fullCells)) +
    (fullCells < width && remEighths > 0 ? CLI_BAR_PARTIAL_GLYPHS[remEighths] : '');
  const emptyCount = Math.max(0, width - fullCells - (remEighths > 0 ? 1 : 0));
  const emptyPart = CLI_BAR_TRACK_GLYPH.repeat(emptyCount);
  const valStr = `${Math.round(clamped)}%`.padStart(3, ' ');
  return `${SGR_FG_MUTED}${label} ${fillFg}${filledPart}${emptyPart ? `${SGR_FG_DIM}${emptyPart}` : ''} ${valFg}${valStr}${SGR_RESET}`;
}

export const CLI_STATUS_COPY = Object.freeze({
  'zh-CN': {
    ctx: '上下文',
    gen: '生成中...',
    idle: '空闲',
    avg: '均 ',
    sum: '总 ',
    cache: '缓 ',
    quotaAuto: '余',
    quotaEmpty: '余 --%',
    wk: '周',
    activeSub: (r, s) => `${r} 运行中 · ${s} 子`,
    active: (r) => `${r} 运行中`,
    idleZero: '0 运行中',
    anom: {
      capacity: (n) => (n === 1 ? '503' : `503×${n}`),
      upstream: (n) => (n === 1 ? '500' : `500×${n}`),
      rate_limit: (n) => `限流${n}`,
      timeout: (n) => `超时${n}`,
      disconnect: (n) => `断连${n}`,
      model_output: (n) => `纠偏${n}`,
      safety: (n) => `过滤${n}`,
      auth_or_model: (n) => `受限${n}`,
      mixed: (n) => `异常${n}`,
      error: (n) => `报错${n}`,
    },
  },
  'zh-TW': {
    ctx: '上下文',
    gen: '生成中...',
    idle: '閒置',
    avg: '均 ',
    sum: '總 ',
    cache: '快取 ',
    quotaAuto: '餘',
    quotaEmpty: '餘 --%',
    wk: '週',
    activeSub: (r, s) => `${r} 執行中 · ${s} 子`,
    active: (r) => `${r} 執行中`,
    idleZero: '0 執行中',
    anom: {
      capacity: (n) => (n === 1 ? '503' : `503×${n}`),
      upstream: (n) => (n === 1 ? '500' : `500×${n}`),
      rate_limit: (n) => `限流${n}`,
      timeout: (n) => `逾時${n}`,
      disconnect: (n) => `斷線${n}`,
      model_output: (n) => `糾偏${n}`,
      safety: (n) => `過濾${n}`,
      auth_or_model: (n) => `受限${n}`,
      mixed: (n) => `異常${n}`,
      error: (n) => `錯誤${n}`,
    },
  },
  'en-US': {
    ctx: 'Ctx',
    gen: 'Gen...',
    idle: 'Idle',
    avg: 'avg ',
    sum: 'sum ',
    cache: 'cache ',
    quotaAuto: '5h',
    quotaEmpty: 'Quota --',
    wk: 'w',
    activeSub: (r, s) => `${r} active · ${s} sub`,
    active: (r) => `${r} active`,
    idleZero: '0 active',
    anom: {
      capacity: (n) => (n === 1 ? '503' : `503x${n}`),
      upstream: (n) => (n === 1 ? '500' : `500x${n}`),
      rate_limit: (n) => `429x${n}`,
      timeout: (n) => `TO${n}`,
      disconnect: (n) => `Drop${n}`,
      model_output: (n) => `Fix${n}`,
      safety: (n) => `Safe${n}`,
      auth_or_model: (n) => `Err${n}`,
      mixed: (n) => `Warn${n}`,
      error: (n) => `Err${n}`,
    },
  },
  'ja-JP': {
    ctx: 'Ctx',
    gen: '生成中...',
    idle: '待機',
    avg: '平均 ',
    sum: '計 ',
    cache: 'キャッシュ ',
    quotaAuto: '残',
    quotaEmpty: '残 --%',
    wk: '週',
    activeSub: (r, s) => `${r} 実行中 · ${s} 子`,
    active: (r) => `${r} 実行中`,
    idleZero: '0 実行中',
    anom: {
      capacity: (n) => (n === 1 ? '503' : `503×${n}`),
      upstream: (n) => (n === 1 ? '500' : `500×${n}`),
      rate_limit: (n) => `429×${n}`,
      timeout: (n) => `TO${n}`,
      disconnect: (n) => `切断${n}`,
      model_output: (n) => `補正${n}`,
      safety: (n) => `制限${n}`,
      auth_or_model: (n) => `拒否${n}`,
      mixed: (n) => `警告${n}`,
      error: (n) => `異常${n}`,
    },
  },
  'ko-KR': {
    ctx: 'Ctx',
    gen: '생성중...',
    idle: '대기',
    avg: '평균 ',
    sum: '합 ',
    cache: '캐시 ',
    quotaAuto: '잔여',
    quotaEmpty: '잔여 --%',
    wk: '주',
    activeSub: (r, s) => `${r} 실행 · ${s} 서브`,
    active: (r) => `${r} 실행`,
    idleZero: '0 실행',
    anom: {
      capacity: (n) => (n === 1 ? '503' : `503×${n}`),
      upstream: (n) => (n === 1 ? '500' : `500×${n}`),
      rate_limit: (n) => `429×${n}`,
      timeout: (n) => `TO${n}`,
      disconnect: (n) => `끊김${n}`,
      model_output: (n) => `보정${n}`,
      safety: (n) => `필터${n}`,
      auth_or_model: (n) => `제한${n}`,
      mixed: (n) => `경고${n}`,
      error: (n) => `오류${n}`,
    },
  },
  'de-DE': {
    ctx: 'Ctx',
    gen: 'Gen...',
    idle: 'Leerlauf',
    avg: 'Ø ',
    sum: 'Σ ',
    cache: 'Cache ',
    quotaAuto: '5h',
    quotaEmpty: 'Kontingent --',
    wk: 'W',
    activeSub: (r, s) => `${r} aktiv · ${s} Sub`,
    active: (r) => `${r} aktiv`,
    idleZero: '0 aktiv',
    anom: {
      capacity: (n) => (n === 1 ? '503' : `503x${n}`),
      upstream: (n) => (n === 1 ? '500' : `500x${n}`),
      rate_limit: (n) => `429x${n}`,
      timeout: (n) => `TO${n}`,
      disconnect: (n) => `Drop${n}`,
      model_output: (n) => `Fix${n}`,
      safety: (n) => `Safe${n}`,
      auth_or_model: (n) => `Err${n}`,
      mixed: (n) => `Warn${n}`,
      error: (n) => `Err${n}`,
    },
  },
  'fr-FR': {
    ctx: 'Ctx',
    gen: 'Gén...',
    idle: 'Inactif',
    avg: 'moy. ',
    sum: 'tot. ',
    cache: 'cache ',
    quotaAuto: '5h',
    quotaEmpty: 'Quota --',
    wk: 'S',
    activeSub: (r, s) => `${r} actif · ${s} sous`,
    active: (r) => `${r} actif`,
    idleZero: '0 actif',
    anom: {
      capacity: (n) => (n === 1 ? '503' : `503x${n}`),
      upstream: (n) => (n === 1 ? '500' : `500x${n}`),
      rate_limit: (n) => `429x${n}`,
      timeout: (n) => `TO${n}`,
      disconnect: (n) => `Drop${n}`,
      model_output: (n) => `Fix${n}`,
      safety: (n) => `Safe${n}`,
      auth_or_model: (n) => `Err${n}`,
      mixed: (n) => `Warn${n}`,
      error: (n) => `Err${n}`,
    },
  },
  'vi-VN': {
    ctx: 'Ctx',
    gen: 'Đang chạy...',
    idle: 'Chờ',
    avg: 'TB ',
    sum: 'tổng ',
    cache: 'cache ',
    quotaAuto: '5g',
    quotaEmpty: 'Quota --',
    wk: 'T',
    activeSub: (r, s) => `${r} chạy · ${s} sub`,
    active: (r) => `${r} chạy`,
    idleZero: '0 chạy',
    anom: {
      capacity: (n) => (n === 1 ? '503' : `503x${n}`),
      upstream: (n) => (n === 1 ? '500' : `500x${n}`),
      rate_limit: (n) => `429x${n}`,
      timeout: (n) => `TO${n}`,
      disconnect: (n) => `Drop${n}`,
      model_output: (n) => `Fix${n}`,
      safety: (n) => `Safe${n}`,
      auth_or_model: (n) => `Err${n}`,
      mixed: (n) => `Warn${n}`,
      error: (n) => `Err${n}`,
    },
  },
});

function getCliCopy(locale) {
  return CLI_STATUS_COPY[locale] || CLI_STATUS_COPY['en-US'];
}

function cliResolveQuotaSlotPrefix(metricKey, locale) {
  const copy = getCliCopy(locale);
  if (metricKey === 'gemini_5h') return 'G5h';
  if (metricKey === 'gemini_weekly') return `G${copy.wk}`;
  if (metricKey === 'argon_weekly') return `A${copy.wk}`;
  if (metricKey === 'claude_5h') return 'C5h';
  if (metricKey === 'claude_weekly') return `C${copy.wk}`;
  return copy.quotaAuto;
}

/**
 * 将单槽位指标格式化为纯文本及 24-bit 终端语义 SGR 片段（上下文和配额支持底色胶囊填充）。
 */
function cliRenderSingleSlot(
  metricKey,
  slotCtx,
  { locale = 'zh-CN', useColor = true, slotSet, usePill = true, gaugeStyle = '' } = {}
) {
  const copy = getCliCopy(locale);
  const hasTelemetry = slotCtx.hasTelemetry !== false;
  const resolvedStyle = gaugeStyle
    ? normalizeCliStatusLineGaugeStyle(gaugeStyle)
    : usePill
      ? 'pill'
      : 'compact';

  if (metricKey === 'context') {
    const valid = hasTelemetry && slotCtx.usedPct != null && Number.isFinite(Number(slotCtx.usedPct));
    const pctNum = valid ? Math.max(0, Math.min(100, Math.round(Number(slotCtx.usedPct)))) : null;
    const label = copy.ctx;
    const textVal = pctNum != null ? `${pctNum}%` : '--%';
    if (!useColor) {
      return `${label} ${textVal}`;
    }
    const isDanger = pctNum != null && pctNum >= 88;
    const isWarn = !isDanger && pctNum != null && pctNum >= 70;
    if (resolvedStyle === 'pill' && pctNum != null) {
      const fillBg = isDanger
        ? SGR_BG_PILL_DANGER
        : isWarn
          ? SGR_BG_PILL_WARN
          : SGR_BG_PILL_BLUE;
      const fillLabelFg = isDanger
        ? SGR_FG_PILL_LABEL_DANGER
        : isWarn
          ? SGR_FG_PILL_LABEL_WARN
          : SGR_FG_PILL_LABEL_BLUE;
      return cliBuildPillGauge(label, pctNum, { fillBg, fillLabelFg });
    }
    const valColor = isDanger
      ? `${SGR_BOLD}${SGR_FG_DANGER}`
      : isWarn
        ? `${SGR_BOLD}${SGR_FG_WARN}`
        : pctNum != null
          ? `${SGR_BOLD}${SGR_FG_BRIGHT}`
          : SGR_FG_MUTED;
    if (resolvedStyle === 'bar' && pctNum != null) {
      const fillFg = isDanger ? SGR_FG_DANGER : isWarn ? SGR_FG_WARN : SGR_FG_ACCENT;
      return cliBuildBarGauge(label, pctNum, { fillFg, valFg: valColor });
    }
    return `${SGR_FG_MUTED}${label} ${valColor}${textVal}${SGR_RESET}`;
  }

  if (metricKey === 'tps') {
    const valid = hasTelemetry && Number.isFinite(Number(slotCtx.tps)) && Number(slotCtx.tps) > 0;
    const numVal = valid ? Number(slotCtx.tps) : 0;
    const textVal = valid
      ? `${numVal >= 100 ? Math.round(numVal) : numVal.toFixed(1)} t/s`
      : slotCtx.isRunning
        ? copy.gen
        : copy.idle;
    if (!useColor) return textVal;
    const color = valid
      ? `${SGR_BOLD}${cliStatusSpeedSgr(numVal)}`
      : slotCtx.isRunning
        ? SGR_FG_INFO
        : SGR_FG_MUTED;
    return `${color}${textVal}${SGR_RESET}`;
  }

  if (metricKey === 'avg_tps') {
    const valid =
      hasTelemetry && Number.isFinite(Number(slotCtx.avgTps)) && Number(slotCtx.avgTps) > 0;
    const numVal = valid ? Number(slotCtx.avgTps) : 0;
    const needPrefix = slotSet?.has('tps');
    const prefix = needPrefix ? copy.avg : '';
    const textVal = valid
      ? `${prefix}${numVal >= 100 ? Math.round(numVal) : numVal.toFixed(1)} t/s`
      : `${prefix}-- t/s`;
    if (!useColor) return textVal;
    const color = valid ? cliStatusSpeedSgr(numVal) : SGR_FG_MUTED;
    return `${color}${textVal}${SGR_RESET}`;
  }

  if (metricKey === 'ttft') {
    const valid =
      hasTelemetry && slotCtx.ttft != null && Number.isFinite(Number(slotCtx.ttft)) && Number(slotCtx.ttft) >= 0;
    const textVal = valid ? cliFormatCompactTtft(Number(slotCtx.ttft)) : '--s';
    if (!useColor) return textVal;
    const color = valid ? cliStatusTtftSgr(Number(slotCtx.ttft)) : SGR_FG_MUTED;
    return `${color}${textVal}${SGR_RESET}`;
  }

  if (metricKey === 'cost' || metricKey === 'session_cost') {
    const rawVal = !hasTelemetry
      ? null
      : metricKey === 'session_cost'
        ? slotCtx.sessionCost
        : slotCtx.stepCost;
    const needPrefix = metricKey === 'session_cost' && slotSet?.has('cost') ? copy.sum : '';
    const textVal = `${needPrefix}${hasTelemetry ? cliFormatCompactCost(rawVal) : '--'}`;
    if (!useColor) return textVal;
    const color =
      metricKey === 'cost' && hasTelemetry && rawVal != null
        ? cliStatusCostSgr(rawVal)
        : rawVal != null
          ? SGR_FG_NORMAL
          : SGR_FG_MUTED;
    return `${color}${textVal}${SGR_RESET}`;
  }

  if (metricKey === 'cache_hit') {
    const valid =
      hasTelemetry && slotCtx.cacheHitPct != null && Number.isFinite(Number(slotCtx.cacheHitPct));
    const numVal = valid ? Math.max(0, Math.min(100, Math.round(Number(slotCtx.cacheHitPct)))) : 0;
    const prefix = copy.cache;
    const textVal = valid ? `${prefix}${numVal}%` : `${prefix}--%`;
    if (!useColor) return textVal;
    const color = valid
      ? cliStatusCacheSgr(Number(slotCtx.cacheHitPct), slotCtx.latestPromptTokens)
      : SGR_FG_MUTED;
    return `${color}${textVal}${SGR_RESET}`;
  }

  if (metricKey === 'session_tokens') {
    const valid =
      hasTelemetry &&
      slotCtx.sessionTokens != null &&
      Number.isFinite(Number(slotCtx.sessionTokens)) &&
      Number(slotCtx.sessionTokens) >= 0;
    const textVal = valid ? `${cliFormatTokens(Number(slotCtx.sessionTokens))} tok` : '-- tok';
    if (!useColor) return textVal;
    return `${valid ? SGR_FG_NORMAL : SGR_FG_MUTED}${textVal}${SGR_RESET}`;
  }

  const quotaPct = hasTelemetry ? cliResolveQuotaPct(slotCtx.quotas, metricKey) : null;
  const prefix = cliResolveQuotaSlotPrefix(metricKey, locale);
  const isDanger = quotaPct != null && quotaPct <= 15;
  const isWarn = !isDanger && quotaPct != null && quotaPct <= 30;
  const pctSgr = isDanger
    ? `${SGR_BOLD}${SGR_FG_DANGER}`
    : isWarn
      ? `${SGR_BOLD}${SGR_FG_WARN}`
      : quotaPct != null
        ? SGR_FG_GOOD
        : SGR_FG_MUTED;

  if (quotaPct == null) {
    const emptyText = metricKey === 'quota_auto' ? copy.quotaEmpty : `${prefix} --%`;
    return useColor ? `${SGR_FG_MUTED}${emptyText}${SGR_RESET}` : emptyText;
  }

  if (!useColor) {
    return `${prefix} ${quotaPct}%`;
  }

  if (resolvedStyle === 'pill') {
    const fillBg = isDanger
      ? SGR_BG_PILL_DANGER
      : isWarn
        ? SGR_BG_PILL_WARN
        : SGR_BG_PILL_GREEN;
    const fillLabelFg = isDanger
      ? SGR_FG_PILL_LABEL_DANGER
      : isWarn
        ? SGR_FG_PILL_LABEL_WARN
        : SGR_FG_PILL_LABEL_GREEN;
    return cliBuildPillGauge(prefix, quotaPct, { fillBg, fillLabelFg });
  }

  if (resolvedStyle === 'bar') {
    const fillFg = isDanger ? SGR_FG_DANGER : isWarn ? SGR_FG_WARN : SGR_FG_GOOD;
    return cliBuildBarGauge(prefix, quotaPct, { fillFg, valFg: pctSgr });
  }

  return `${SGR_FG_MUTED}${prefix} ${pctSgr}${quotaPct}%${SGR_RESET}`;
}

/**
 * 渲染单行无背景 CLI 底部状态条（传入 `terminalWidth > 0` 时自动合成「左快捷键提示 + 居中指标 + 右模式与模型」三栏单行布局）。
 *
 * @param {{
 *   hasTelemetry?: boolean,
 *   usedPct?: number|null,
 *   isRunning?: boolean,
 *   hasWaiting?: boolean,
 *   runningCount?: number,
 *   runningSubCount?: number,
 *   tps?: number|null,
 *   avgTps?: number|null,
 *   ttft?: number|null,
 *   stepCost?: number|null,
 *   sessionCost?: number|null,
 *   cacheHitPct?: number|null,
 *   latestPromptTokens?: number|null,
 *   sessionTokens?: number|null,
 *   quotas?: object|null,
 * }} slotCtx
 * @param {{
 *   slots?: string[],
 *   showMultiSession?: boolean,
 *   language?: string,
 *   color?: boolean,
 *   terminalWidth?: number,
 *   cycleMode?: string,
 *   modelDisplayName?: string,
 *   modelEffort?: string,
 *   vimMode?: string,
 * }} [options]
 * @returns {string}
 */
function detectCliHostLocale() {
  const envLang = String(
    process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || ''
  ).trim();
  if (envLang) {
    return resolveLocaleFromLanguageTag(envLang, 'en-US');
  }
  try {
    const navLang = globalThis.navigator?.language;
    if (navLang) {
      return resolveLocaleFromLanguageTag(navLang, 'en-US');
    }
  } catch {
    // 忽略无 navigator 环境
  }
  return 'zh-CN';
}

const CLI_STATUS_SLOT_KEEP_PRIORITY = Object.freeze({
  context: 100,
  tps: 90,
  quota_auto: 80,
  gemini_5h: 78,
  claude_5h: 76,
  ttft: 70,
  session_cost: 60,
  cost: 58,
  cache_hit: 50,
  avg_tps: 45,
  session_tokens: 40,
  gemini_weekly: 35,
  argon_weekly: 33,
  claude_weekly: 30,
});

function cliStatusHasRenderableValue(metricKey, slotCtx) {
  if (slotCtx.hasTelemetry === false) return false;
  if (metricKey === 'context') {
    return slotCtx.usedPct != null && Number.isFinite(Number(slotCtx.usedPct));
  }
  if (metricKey === 'tps') {
    return Number.isFinite(Number(slotCtx.tps)) && Number(slotCtx.tps) > 0;
  }
  if (metricKey === 'avg_tps') {
    return Number.isFinite(Number(slotCtx.avgTps)) && Number(slotCtx.avgTps) > 0;
  }
  if (metricKey === 'ttft') {
    return (
      slotCtx.ttft != null &&
      Number.isFinite(Number(slotCtx.ttft)) &&
      Number(slotCtx.ttft) >= 0
    );
  }
  if (metricKey === 'cost') {
    return slotCtx.stepCost != null && Number.isFinite(Number(slotCtx.stepCost));
  }
  if (metricKey === 'session_cost') {
    return slotCtx.sessionCost != null && Number.isFinite(Number(slotCtx.sessionCost));
  }
  if (metricKey === 'cache_hit') {
    return slotCtx.cacheHitPct != null && Number.isFinite(Number(slotCtx.cacheHitPct));
  }
  if (metricKey === 'session_tokens') {
    return (
      slotCtx.sessionTokens != null &&
      Number.isFinite(Number(slotCtx.sessionTokens)) &&
      Number(slotCtx.sessionTokens) >= 0
    );
  }
  return cliResolveQuotaPct(slotCtx.quotas, metricKey) != null;
}

function cliStatusFormatAnomalyTag(anomaly, { locale = 'zh-CN', useColor = true } = {}) {
  if (!anomaly || !(Number(anomaly.count) > 0)) return '';
  const n = Math.max(1, Math.floor(Number(anomaly.count) || 1));
  const kind = String(anomaly.primaryKind || 'error');
  const copy = getCliCopy(locale);
  const fmt = copy.anom[kind] || copy.anom.error;
  const label = fmt(n);
  const plain = `! ${label}`;
  if (!useColor) return plain;
  const color =
    anomaly.severity === 'danger' || kind === 'rate_limit' || kind === 'auth_or_model'
      ? `${SGR_BOLD}${SGR_FG_DANGER}`
      : `${SGR_BOLD}${SGR_FG_WARN}`;
  return `${color}${plain}${SGR_RESET}`;
}

function cliStatusShedLowestPrioritySlot(slotKeys) {
  if (!Array.isArray(slotKeys) || slotKeys.length <= 1) return slotKeys;
  let dropIdx = slotKeys.length - 1;
  let lowestPrio = Infinity;
  for (let i = 0; i < slotKeys.length; i += 1) {
    const prio = CLI_STATUS_SLOT_KEEP_PRIORITY[slotKeys[i]] ?? 50;
    if (prio <= lowestPrio) {
      lowestPrio = prio;
      dropIdx = i;
    }
  }
  return slotKeys.filter((_, idx) => idx !== dropIdx);
}

export function formatCliStatusLineCapsule(slotCtx = {}, options = {}) {
  const normalizedCliSlots = normalizeCliStatusLineSlots(options.slots);
  const rawSlots = normalizedCliSlots || normalizeTopbarCapsuleSlots(options.slots);
  const runningCount = Math.max(0, Math.floor(Number(slotCtx.runningCount) || 0));
  const multiSessionMode =
    options.multiSessionMode !== undefined
      ? normalizeTopbarMultiSessionMode(options.multiSessionMode, options.showMultiSession)
      : typeof options.showMultiSession === 'string'
        ? normalizeTopbarMultiSessionMode(options.showMultiSession)
        : options.showMultiSession === false
          ? 'hide'
          : 'show';
  const showMulti = isTopbarMultiSessionVisible(multiSessionMode, runningCount);
  const showAnomaly = options.showAnomaly !== false;
  const normLang = normalizeLanguageSetting(options.language);
  const locale = normLang === 'auto' ? detectCliHostLocale() : normLang;
  const copy = getCliCopy(locale);
  const useColor = options.color !== false;

  // 新会话尚无任何完成步骤（stepCount === 0）时，隐藏纯占位性的 "--s" / "--" 槽位，避免刚启动显得满屏缺数据
  let activeSlots = rawSlots;
  if (slotCtx.hasTelemetry !== false && activeSlots.includes('argon_weekly') && !hasArgonWeeklyQuotaPool(slotCtx.quotas)) {
    const withoutArgon = activeSlots.filter((key) => key !== 'argon_weekly');
    if (withoutArgon.length > 0) {
      activeSlots = withoutArgon;
    }
  }
  if (slotCtx.stepCount === 0) {
    const filtered = activeSlots.filter(
      (key) => key === 'tps' || cliStatusHasRenderableValue(key, slotCtx)
    );
    if (filtered.length > 0) {
      activeSlots = filtered;
    }
  }

  const runningSubCount = Math.max(0, Math.floor(Number(slotCtx.runningSubCount) || 0));
  const hasWaiting = Boolean(slotCtx.hasWaiting);

  let multiCore = '';
  if (showMulti) {
    const labelText =
      runningCount > 0
        ? runningSubCount > 0
          ? copy.activeSub(runningCount, runningSubCount)
          : copy.active(runningCount)
        : copy.idleZero;
    if (!useColor) {
      multiCore = `● ${labelText}`;
    } else {
      const dotSgr =
        runningCount > 0
          ? hasWaiting
            ? SGR_FG_WARN
            : SGR_FG_GOOD
          : SGR_FG_DOT_IDLE;
      const textSgr = runningCount > 0 ? SGR_FG_NORMAL : SGR_FG_DIM;
      multiCore = `${dotSgr}● ${textSgr}${labelText}${SGR_RESET}`;
    }
  }

  const sep = useColor ? `${SGR_FG_SEP} | ${SGR_RESET}` : ' | ';
  const anomalyBadge = showAnomaly
    ? cliStatusFormatAnomalyTag(slotCtx.latestAnomaly, { locale, useColor })
    : '';

  const primaryGaugeStyle =
    options.gaugeStyle != null && String(options.gaugeStyle).trim()
      ? normalizeCliStatusLineGaugeStyle(options.gaugeStyle)
      : options.showProgressBars === false
        ? 'compact'
        : 'pill';
  const defaultUseGauge = primaryGaugeStyle !== 'compact';

  const buildCapsulesForSlots = (
    slotList,
    includeAnomaly = true,
    gaugeStyle = primaryGaugeStyle
  ) => {
    const slotSet = new Set(slotList);
    const rendered = slotList.map((key) =>
      cliRenderSingleSlot(key, slotCtx, { locale, useColor, slotSet, gaugeStyle })
    );
    if (includeAnomaly && anomalyBadge) {
      rendered.push(anomalyBadge);
    }
    const body = rendered.join(sep);
    return {
      slotsBody: body,
      fullCapsule: multiCore ? `${multiCore}   ${body}` : body,
      compactCapsule: multiCore ? `${multiCore}  ${body}` : body,
    };
  };

  const baseCapsules = buildCapsulesForSlots(activeSlots, true, primaryGaugeStyle);
  const rawWidth = Number(options.terminalWidth);
  if (!Number.isFinite(rawWidth) || rawWidth <= 0) {
    return baseCapsules.fullCapsule;
  }

  // 预留右侧 1 列安全边距，和 `agy` 原生底栏右边缘对齐并避免 Windows `conhost`/`cmd.exe` 末列自动折行
  const maxWidth = Math.max(1, Math.floor(rawWidth) - 1);
  const fullLeft = cliBuildLeftSegment({ vimMode: options.vimMode, short: false, useColor });
  const shortLeft = cliBuildLeftSegment({ vimMode: '', short: true, useColor });
  const fullRight = cliBuildRightSegment({
    cycleMode: options.cycleMode,
    modelDisplayName: options.modelDisplayName,
    modelEffort: options.modelEffort,
    includeEffort: true,
    useColor,
  });
  const compactRight = cliBuildRightSegment({
    cycleMode: options.cycleMode,
    modelDisplayName: options.modelDisplayName,
    modelEffort: options.modelEffort,
    includeEffort: false,
    useColor,
  });

  const tryCompose = (cap) =>
    cliComposeBalancedThreeColumn(fullLeft, cap.fullCapsule, fullRight, maxWidth) ||
    cliComposeBalancedThreeColumn(shortLeft, cap.fullCapsule, fullRight, maxWidth) ||
    cliComposeBalancedThreeColumn(shortLeft, cap.compactCapsule, compactRight, maxWidth) ||
    cliComposeBalancedThreeColumn('', cap.compactCapsule, compactRight, maxWidth);

  const fullPrimary = cliComposeBalancedThreeColumn(
    fullLeft,
    baseCapsules.fullCapsule,
    fullRight,
    maxWidth
  );
  if (fullPrimary) return fullPrimary;

  const primaryComposed = tryCompose(baseCapsules);
  if (primaryComposed) return primaryComposed;

  if (defaultUseGauge) {
    const noGaugeCapsules = buildCapsulesForSlots(activeSlots, true, 'compact');
    const noGaugeComposed = tryCompose(noGaugeCapsules);
    if (noGaugeComposed) return noGaugeComposed;
  }

  let reducedSlots = [...activeSlots];
  while (reducedSlots.length > 1) {
    reducedSlots = cliStatusShedLowestPrioritySlot(reducedSlots);
    const reducedCap = buildCapsulesForSlots(reducedSlots, true, primaryGaugeStyle);
    const composed = tryCompose(reducedCap);
    if (composed) return composed;
    if (defaultUseGauge) {
      const reducedPlain = buildCapsulesForSlots(reducedSlots, true, 'compact');
      const composedPlain = tryCompose(reducedPlain);
      if (composedPlain) return composedPlain;
    }
  }

  if (cliDisplayWidth(baseCapsules.fullCapsule) <= maxWidth) {
    return baseCapsules.fullCapsule;
  }
  const minimalCap = buildCapsulesForSlots(reducedSlots, false, 'compact');
  if (cliDisplayWidth(minimalCap.fullCapsule) <= maxWidth) {
    return minimalCap.fullCapsule;
  }
  return minimalCap.slotsBody;
}

/**
 * 构建供外部终端提示符（Starship / Oh-My-Posh / tmux / Waybar）或脚本消费的结构化单行 JSON 遥测快照，
 * 内含压缩线对齐后的上下文占比及各配额池剩余额度状态。
 *
 * @param {object} slotCtx
 * @param {{ modelDisplayName?: string, modelEffort?: string, cycleMode?: string, nowMs?: number }} [meta]
 * @returns {object}
 */
export function buildCliJsonStatusOutput(
  slotCtx = {},
  { modelDisplayName = '', modelEffort = '', cycleMode = '', nowMs = Date.now() } = {}
) {
  const parsedModel = parseCliModelAndEffort(modelDisplayName, modelEffort);
  const pools = Array.isArray(slotCtx?.quotas?.pools) ? slotCtx.quotas.pools : [];
  const quotaPools = pools.map((p) => ({
    poolKey: p?.poolKey || p?.family || '',
    remaining5hPct: p?.remainingPct ?? null,
    remainingWeeklyPct: p?.weeklyRemainingPct ?? null,
    reset5h: p?.resetTime || null,
    resetWeekly: p?.weeklyResetTime || null,
  }));

  return {
    timestamp: new Date(nowMs).toISOString(),
    hasTelemetry: slotCtx.hasTelemetry !== false,
    isRunning: Boolean(slotCtx.isRunning),
    hasWaiting: Boolean(slotCtx.hasWaiting),
    runningCount: Math.max(0, Math.floor(Number(slotCtx.runningCount) || 0)),
    runningSubCount: Math.max(0, Math.floor(Number(slotCtx.runningSubCount) || 0)),
    stepCount: slotCtx.stepCount ?? null,
    model: {
      displayName: parsedModel.modelName || '',
      effort: parsedModel.effort || '',
      cycleMode: String(cycleMode || '').trim(),
    },
    speed: {
      tps: slotCtx.tps ?? null,
      avgTps: slotCtx.avgTps ?? null,
      ttftSec: slotCtx.ttft ?? null,
    },
    cost: {
      stepUsd: slotCtx.stepCost ?? null,
      sessionUsd: slotCtx.sessionCost ?? null,
    },
    cache: {
      hitPct: slotCtx.cacheHitPct ?? null,
      latestPromptTokens: slotCtx.latestPromptTokens ?? null,
      sessionTokens: slotCtx.sessionTokens ?? null,
    },
    context: {
      usedPct: slotCtx.usedPct ?? null,
    },
    quotas: {
      autoRemainingPct: resolveCapsuleQuotaSlotPct(slotCtx.quotas, 'quota_auto'),
      pools: quotaPools,
    },
    latestAnomaly: slotCtx.latestAnomaly || null,
  };
}
