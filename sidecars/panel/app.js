(() => {
'use strict';

// --- shared/settings-normalization.mjs ---
const { SUPPORTED_LANGUAGES, THEME_ACCENT_KEYS, FONT_SCALE_KEYS, TOPBAR_SLOT_KEYS, DEFAULT_TOPBAR_SLOTS, MIN_TOPBAR_SLOTS, MAX_TOPBAR_SLOTS, OVERVIEW_MODULE_KEYS, DEFAULT_OVERVIEW_MODULES, DEFAULT_HOVER_MODULES, OVERVIEW_METRIC_KEYS, DEFAULT_OVERVIEW_METRICS, STEP_TABLE_COLUMN_KEYS, DEFAULT_STEP_TABLE_COLUMNS, DEFAULT_STEP_TOKEN_COMBO_FORMAT, STEP_TOKEN_SEGMENT_ALIASES, POPOVER_WIDTH_MODES, MIN_POPOVER_WIDTH, MAX_POPOVER_WIDTH, DEFAULT_POPOVER_WIDTH, normalizeLanguageSetting, normalizeThemeAccent, normalizeFontScale, normalizeModelDisplayMode, normalizeOrchestratorIdMode, normalizePopoverWidthMode, normalizePopoverWidth, parseStepTokenComboSegments, normalizeStepTokenComboFormat, normalizePluginUpdateMode, normalizeWindowMountMode, normalizeWeeklyLimitMode, normalizeTopbarCapsuleSlots, normalizeOverviewMetrics, normalizeOverviewModules, normalizeHoverModules, normalizeStepTableColumns, normalizeStandalonePort, normalizeExperimentalModernUi } = (() => {
/**
 * @fileoverview 前后端与 CLI 共用的偏好设置枚举常量、默认值与无状态纯函数归一化规则。
 */

const SUPPORTED_LANGUAGES = Object.freeze(['auto', 'zh-CN', 'en-US']);

const THEME_ACCENT_KEYS = Object.freeze([
  'host',
  'blue',
  'emerald',
  'amber',
  'violet',
  'cyan',
  'rose',
]);

const FONT_SCALE_KEYS = Object.freeze(['sm', 'md', 'lg', 'xl']);

const TOPBAR_SLOT_KEYS = Object.freeze([
  'context',
  'tps',
  'ttft',
  'avg_tps',
  'cost',
  'session_cost',
  'cache_hit',
  'session_tokens',
  'quota_auto',
  'gemini_5h',
  'gemini_weekly',
  'claude_5h',
  'claude_weekly',
]);

const DEFAULT_TOPBAR_SLOTS = Object.freeze(['tps', 'ttft', 'context']);
const MIN_TOPBAR_SLOTS = 1;
const MAX_TOPBAR_SLOTS = 5;

const OVERVIEW_MODULE_KEYS = Object.freeze([
  'metrics',
  'context',
  'quotas',
  'live_tasks',
]);

const DEFAULT_OVERVIEW_MODULES = Object.freeze([
  'metrics',
  'context',
  'quotas',
  'live_tasks',
]);

const DEFAULT_HOVER_MODULES = Object.freeze(['metrics', 'context', 'quotas']);

const OVERVIEW_METRIC_KEYS = Object.freeze([
  'tps',
  'ttft',
  'avg_tps',
  'step_cost',
  'session_cost',
  'cache_hit',
  'session_tokens',
  'context_usage',
  'quota_tightest',
]);

const DEFAULT_OVERVIEW_METRICS = Object.freeze([
  'tps',
  'ttft',
  'avg_tps',
  'step_cost',
]);

const STEP_TABLE_COLUMN_KEYS = Object.freeze([
  'step',
  'time',
  'model',
  'tps',
  'ttft',
  'duration',
  'tokens_combo',
  'tokens_io_cache',
  'tokens_custom',
  'input_tokens',
  'cache_tokens',
  'output_tokens',
  'cache',
  'cost',
]);

const DEFAULT_STEP_TABLE_COLUMNS = Object.freeze([
  'step',
  'model',
  'tps',
  'ttft',
  'tokens_combo',
  'cache',
  'cost',
]);

const DEFAULT_STEP_TOKEN_COMBO_FORMAT = 'context:in:cache';

const STEP_TOKEN_SEGMENT_ALIASES = Object.freeze({
  context: 'context',
  ctx: 'context',
  '上下文': 'context',
  in: 'in',
  new: 'in',
  input: 'in',
  '输入': 'in',
  '新输入': 'in',
  out: 'out',
  output: 'out',
  '输出': 'out',
  '总输出': 'out',
  cache: 'cache',
  cached: 'cache',
  cache_read: 'cache',
  cacheread: 'cache',
  '缓存': 'cache',
  '缓存读': 'cache',
  think: 'think',
  thinking: 'think',
  '思考': 'think',
  reply: 'reply',
  body: 'reply',
  resp: 'reply',
  response: 'reply',
  text: 'reply',
  '正文': 'reply',
  '回复': 'reply',
  total: 'total',
  all: 'total',
  sum: 'total',
  '总计': 'total',
  '总token': 'total',
});

const POPOVER_WIDTH_MODES = Object.freeze(['auto', 'custom']);
const MIN_POPOVER_WIDTH = 440;
const MAX_POPOVER_WIDTH = 1080;
const DEFAULT_POPOVER_WIDTH = 580;

/**
 * 归一化界面语言枚举（默认 `'zh-CN'`，支持 `'auto'`/`'system'` 与 `'en-US'`）。
 *
 * @param {unknown} lang
 * @returns {'auto'|'zh-CN'|'en-US'}
 */
function normalizeLanguageSetting(lang) {
  const raw = String(lang ?? '').trim();
  if (!raw) return 'zh-CN';
  const lower = raw.toLowerCase();
  if (lower === 'auto' || lower === 'system') return 'auto';
  if (lower === 'en' || lower === 'en-us' || lower.startsWith('en-')) return 'en-US';
  if (lower === 'zh' || lower === 'zh-cn' || lower.startsWith('zh')) return 'zh-CN';
  return 'zh-CN';
}

/**
 * 归一化主题强调色预设键（默认 `'host'` 跟随宿主原生主题）。
 *
 * @param {unknown} accent
 * @returns {'host'|'blue'|'emerald'|'amber'|'violet'|'cyan'|'rose'}
 */
function normalizeThemeAccent(accent) {
  const clean = String(accent ?? '').trim().toLowerCase();
  return THEME_ACCENT_KEYS.includes(clean) ? /** @type {any} */ (clean) : 'host';
}

/**
 * 归一化面板字号档位（默认 `'md'` 标准 100%）。
 *
 * @param {unknown} scale
 * @returns {'sm'|'md'|'lg'|'xl'}
 */
function normalizeFontScale(scale) {
  const clean = String(scale ?? '').trim().toLowerCase();
  return FONT_SCALE_KEYS.includes(clean) ? /** @type {any} */ (clean) : 'md';
}

/**
 * 归一化模型名称展示模式（`'short'` | `'upstream_compact'` | `'upstream'`），兼容历史 `showUpstreamModel`。
 *
 * @param {unknown} mode
 * @param {unknown} [legacyShowUpstream]
 * @returns {'short'|'upstream_compact'|'upstream'}
 */
function normalizeModelDisplayMode(mode, legacyShowUpstream) {
  const m = String(mode ?? '').trim().toLowerCase();
  if (m === 'upstream' || m === 'raw' || m === 'full') return 'upstream';
  if (m === 'upstream_compact' || m === 'compact_upstream' || m === 'trimmed') {
    return 'upstream_compact';
  }
  if (m === 'short') return 'short';
  if (legacyShowUpstream === true) return 'upstream';
  return 'short';
}

/**
 * 归一化 Orchestrator 系列模型 ID 显示风格（`'compact'` vs `'full'`，默认 `'compact'`）。
 *
 * @param {unknown} mode
 * @returns {'compact'|'full'}
 */
function normalizeOrchestratorIdMode(mode) {
  return String(mode ?? '').trim().toLowerCase() === 'full' ? 'full' : 'compact';
}

/**
 * 归一化悬浮主面板宽度模式（`'auto'` | `'custom'`，默认 `'auto'`）。
 *
 * @param {unknown} mode
 * @returns {'auto'|'custom'}
 */
function normalizePopoverWidthMode(mode) {
  const m = String(mode ?? '').trim().toLowerCase();
  return m === 'custom' || m === 'fixed' ? 'custom' : 'auto';
}

/**
 * 归一化悬浮主面板自定义宽度像素值（范围 `440..1080`，默认 `580`）。
 *
 * @param {unknown} width
 * @returns {number}
 */
function normalizePopoverWidth(width) {
  const num = Number(width);
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_POPOVER_WIDTH;
  return Math.max(MIN_POPOVER_WIDTH, Math.min(MAX_POPOVER_WIDTH, Math.round(num)));
}

/**
 * 解析步骤表自定义 Token 组合表达式，支持 `:`、`/`、`,`、`|` 分隔与中英文别名（1~4 项不重复）。
 *
 * @param {unknown} raw
 * @returns {Array<'context'|'in'|'out'|'cache'|'think'|'reply'|'total'>}
 */
function parseStepTokenComboSegments(raw) {
  const str = String(raw ?? '').trim();
  const out = [];
  const seen = new Set();
  if (str) {
    for (const part of str.split(/[:/,|]+/)) {
      const key = part.trim().toLowerCase();
      if (!key) continue;
      const mapped = Object.prototype.hasOwnProperty.call(STEP_TOKEN_SEGMENT_ALIASES, key)
        ? STEP_TOKEN_SEGMENT_ALIASES[key]
        : null;
      if (!mapped || seen.has(mapped)) continue;
      seen.add(mapped);
      out.push(/** @type {any} */ (mapped));
      if (out.length >= 4) break;
    }
  }
  return out.length > 0 ? out : ['context', 'in', 'cache'];
}

/**
 * 归一化步骤表自定义 Token 组合格式字符串（如 `'context:new:cache'` -> `'context:in:cache'`）。
 *
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeStepTokenComboFormat(raw) {
  return parseStepTokenComboSegments(raw).join(':');
}

/**
 * 归一化插件更新策略枚举（兼容历史 `autoUpdatePlugin` 布尔开关，默认 `'manual'`）。
 *
 * @param {unknown} mode
 * @param {unknown} [legacyAutoUpdate]
 * @returns {'off'|'manual'|'auto'}
 */
function normalizePluginUpdateMode(mode, legacyAutoUpdate) {
  const m = String(mode ?? '').trim().toLowerCase();
  if (m === 'off' || m === 'manual' || m === 'auto') return m;
  if (legacyAutoUpdate === true) return 'auto';
  return 'manual';
}

/**
 * 归一化面板挂载方式枚举（`'dual'` | `'composer'` | `'sidebar'`），兼容历史 `enableWindowOverlay`。
 *
 * @param {unknown} mode
 * @param {unknown} [legacyEnableOverlay]
 * @returns {'dual'|'composer'|'sidebar'}
 */
function normalizeWindowMountMode(mode, legacyEnableOverlay) {
  const m = String(mode ?? '').trim().toLowerCase();
  if (m === 'composer' || m === 'input') return 'composer';
  if (m === 'sidebar' || m === 'sidebar_only' || m === 'off') return 'sidebar';
  if (m === 'dual' || m === 'topbar') return 'dual';
  if (legacyEnableOverlay === false) return 'sidebar';
  return 'dual';
}

/**
 * 归一化每周额度统计模式枚举（`'official'` | `'custom_tokens'` | `'custom_cost'`）。
 *
 * @param {unknown} mode
 * @returns {'official'|'custom_tokens'|'custom_cost'}
 */
function normalizeWeeklyLimitMode(mode) {
  const m = String(mode || '').trim().toLowerCase();
  if (m === 'custom_tokens' || m === 'tokens') return 'custom_tokens';
  if (m === 'custom_cost' || m === 'cost') return 'custom_cost';
  return 'official';
}

/**
 * 归一化顶栏/输入框胶囊槽位数组（1~5 项动态自添加，默认 3 项，自动清洗历史 `'none'` 与重复项）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeTopbarCapsuleSlots(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_TOPBAR_SLOTS];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const val = String(item ?? '').trim();
    if (!val || val === 'none') continue;
    const mapped = val === 'step_cost' ? 'cost' : val;
    if (!TOPBAR_SLOT_KEYS.includes(mapped) || seen.has(mapped)) continue;
    seen.add(mapped);
    out.push(mapped);
    if (out.length >= MAX_TOPBAR_SLOTS) break;
  }
  if (out.length < MIN_TOPBAR_SLOTS) {
    return ['context'];
  }
  return out;
}

/**
 * 归一化实时监控第一行指标矩阵的槽位与顺序（1~4 项，默认 4 项）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeOverviewMetrics(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_OVERVIEW_METRICS];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const rawVal = String(item ?? '').trim();
    const val = rawVal === 'cost' ? 'step_cost' : rawVal;
    if (!OVERVIEW_METRIC_KEYS.includes(val) || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
    if (out.length >= 4) break;
  }
  return out.length > 0 ? out : ['tps'];
}

/**
 * 归一化实时监控视图展示的模块及上下顺序（1~4 项，默认 4 项全开）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeOverviewModules(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_OVERVIEW_MODULES];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const val = String(item ?? '').trim();
    if (!OVERVIEW_MODULE_KEYS.includes(val) || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
    if (out.length >= OVERVIEW_MODULE_KEYS.length) break;
  }
  return out.length > 0 ? out : ['metrics'];
}

/**
 * 归一化鼠标悬停速览窗展示的模块及上下顺序（0~4 项，默认 3 项；显式空数组 `[]` 表示禁用悬停弹窗）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeHoverModules(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_HOVER_MODULES];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const val = String(item ?? '').trim();
    if (!OVERVIEW_MODULE_KEYS.includes(val) || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
    if (out.length >= OVERVIEW_MODULE_KEYS.length) break;
  }
  return out;
}

/**
 * 归一化调用明细「按步查看」表格列配置与左右顺序（2~14 列，默认保留现有 7 列）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeStepTableColumns(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_STEP_TABLE_COLUMNS];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const val = String(item ?? '').trim();
    if (!STEP_TABLE_COLUMN_KEYS.includes(val) || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
    if (out.length >= STEP_TABLE_COLUMN_KEYS.length) break;
  }
  if (out.length < 2) {
    for (const fallbackCol of ['step', 'model', 'tps']) {
      if (!seen.has(fallbackCol)) {
        seen.add(fallbackCol);
        out.push(fallbackCol);
      }
      if (out.length >= 2) break;
    }
  }
  return out;
}

/**
 * 归一化独立 Web 服务自动托管端口（`0` 表示关闭自动拉起，合法监听端口范围 `1024..65535`）。
 *
 * @param {unknown} port
 * @returns {number}
 */
function normalizeStandalonePort(port) {
  const num = Number(port);
  if (!Number.isInteger(num) || num <= 0) return 0;
  if (num >= 1024 && num <= 65535) return num;
  return 0;
}

/**
 * 归一化实验性现代化新 UI 开关（默认 `false`）。
 *
 * @param {unknown} val
 * @returns {boolean}
 */
function normalizeExperimentalModernUi(val) {
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    return lower === 'true' || lower === '1' || lower === 'on';
  }
  return Boolean(val);
}
return { SUPPORTED_LANGUAGES, THEME_ACCENT_KEYS, FONT_SCALE_KEYS, TOPBAR_SLOT_KEYS, DEFAULT_TOPBAR_SLOTS, MIN_TOPBAR_SLOTS, MAX_TOPBAR_SLOTS, OVERVIEW_MODULE_KEYS, DEFAULT_OVERVIEW_MODULES, DEFAULT_HOVER_MODULES, OVERVIEW_METRIC_KEYS, DEFAULT_OVERVIEW_METRICS, STEP_TABLE_COLUMN_KEYS, DEFAULT_STEP_TABLE_COLUMNS, DEFAULT_STEP_TOKEN_COMBO_FORMAT, STEP_TOKEN_SEGMENT_ALIASES, POPOVER_WIDTH_MODES, MIN_POPOVER_WIDTH, MAX_POPOVER_WIDTH, DEFAULT_POPOVER_WIDTH, normalizeLanguageSetting, normalizeThemeAccent, normalizeFontScale, normalizeModelDisplayMode, normalizeOrchestratorIdMode, normalizePopoverWidthMode, normalizePopoverWidth, parseStepTokenComboSegments, normalizeStepTokenComboFormat, normalizePluginUpdateMode, normalizeWindowMountMode, normalizeWeeklyLimitMode, normalizeTopbarCapsuleSlots, normalizeOverviewMetrics, normalizeOverviewModules, normalizeHoverModules, normalizeStepTableColumns, normalizeStandalonePort, normalizeExperimentalModernUi };
})();

// --- shared/telemetry-display-rules.mjs ---
const { THIRD_PARTY_POOL_RE, isThirdPartyPoolText, classifySpeedTier, classifyCacheTier, classifyStepCostTier, classifyTtftTier, formatCompactTokens, formatCompactCapsuleCost, formatCompactCapsuleTtft, resolveCapsuleQuotaSlotPct, scaleBucketsExact } = (() => {
/**
 * @fileoverview 跨 Backend / Frontend / CLI 共用的纯展示阈值、紧凑格式化、第三方配额分池与精确整数缩放规则。
 */

const THIRD_PARTY_POOL_RE =
  /3p|claude|anthropic|fable|gpt|openai|oss|sonnet|opus|haiku|third[-_\s]?party/i;

/**
 * 判断模型或配额桶文本是否归属第三方模型池（Claude & GPT / OSS / 3P）。
 *
 * @param {unknown} text
 * @returns {boolean}
 */
function isThirdPartyPoolText(text) {
  return THIRD_PARTY_POOL_RE.test(String(text || ''));
}

/**
 * 输出速度四档语义色阶分类（`'muted'|'good'|'info'|'warn'|'danger'`）。
 */
function classifySpeedTier(tokPerSec) {
  if (tokPerSec == null || !Number.isFinite(Number(tokPerSec)) || Number(tokPerSec) <= 0) {
    return 'muted';
  }
  const v = Number(tokPerSec);
  if (v >= 60) return 'good';
  if (v >= 35) return 'info';
  if (v >= 20) return 'warn';
  return 'danger';
}

/**
 * 缓存命中率四档语义色阶分类（`'muted'|'good'|'info'|'warn'|'danger'`）。
 */
function classifyCacheTier(cacheHitPct, promptTokens = null) {
  if (cacheHitPct == null || !Number.isFinite(Number(cacheHitPct))) {
    return 'muted';
  }
  const v = Number(cacheHitPct);
  if (promptTokens != null && Number(promptTokens) <= 0 && v <= 0) {
    return 'muted';
  }
  if (v >= 85) return 'good';
  if (v >= 65) return 'info';
  if (v >= 30) return 'warn';
  return 'danger';
}

/**
 * 单步费用告警色阶分类（`''|'warn'|'danger'`）。
 */
function classifyStepCostTier(costUsd) {
  if (costUsd == null || !Number.isFinite(Number(costUsd))) return '';
  const v = Number(costUsd);
  if (v >= 0.3) return 'danger';
  if (v >= 0.15) return 'warn';
  return '';
}

/**
 * 首字延迟告警色阶分类（`'muted'|''|'warn'|'danger'`）。
 */
function classifyTtftTier(ttftSec) {
  if (ttftSec == null || !Number.isFinite(Number(ttftSec)) || Number(ttftSec) < 0) {
    return 'muted';
  }
  const v = Number(ttftSec);
  if (v >= 30) return 'danger';
  if (v >= 18) return 'warn';
  return '';
}

function formatCompactTokens(num) {
  const n = Number(num || 0);
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function formatCompactCapsuleCost(costUsd) {
  if (costUsd == null || !Number.isFinite(Number(costUsd))) return '--';
  const val = Math.max(0, Number(costUsd));
  if (val === 0) return '$0.00';
  if (val < 0.001) return '<$0.001';
  if (val < 1) return `$${val.toFixed(3)}`;
  if (val < 100) return `$${val.toFixed(2)}`;
  return `$${Math.round(val)}`;
}

function formatCompactCapsuleTtft(ttftSec) {
  if (ttftSec == null || !Number.isFinite(Number(ttftSec)) || Number(ttftSec) < 0) return '--s';
  const val = Number(ttftSec);
  if (val < 1) return `${val.toFixed(2)}s`;
  if (val < 100) return `${val.toFixed(1)}s`;
  return `${Math.round(val)}s`;
}

/**
 * 解析胶囊指定配额槽位（`quota_auto` / `gemini_5h` / `gemini_weekly` / `claude_5h` / `claude_weekly`）的整数剩余百分比。
 *
 * @param {object|null|undefined} quotas
 * @param {string} slotKey
 * @returns {number|null}
 */
function resolveCapsuleQuotaSlotPct(quotas, slotKey) {
  if (!quotas || typeof quotas !== 'object') return null;
  const pools = Array.isArray(quotas.pools) ? quotas.pools : [];
  const activePool = quotas.activePool || null;
  const weekly = quotas.weekly || null;

  if (slotKey === 'quota_auto') {
    const candidates = [];
    if (activePool && Number.isFinite(Number(activePool.remainingPct))) {
      candidates.push(Number(activePool.remainingPct));
    }
    if (activePool && Number.isFinite(Number(activePool.weeklyRemainingPct))) {
      candidates.push(Number(activePool.weeklyRemainingPct));
    }
    if (!candidates.length && weekly && Number.isFinite(Number(weekly.remainingPct))) {
      candidates.push(Number(weekly.remainingPct));
    }
    if (!candidates.length && pools.length > 0) {
      for (const p of pools) {
        if (p && Number.isFinite(Number(p.remainingPct))) candidates.push(Number(p.remainingPct));
        if (p && Number.isFinite(Number(p.weeklyRemainingPct))) {
          candidates.push(Number(p.weeklyRemainingPct));
        }
      }
    }
    if (!candidates.length) return null;
    return Math.max(0, Math.min(100, Math.round(Math.min(...candidates))));
  }

  const isClaude = slotKey.startsWith('claude_');
  const isWeekly = slotKey.endsWith('_weekly');
  let rawPct = null;

  if (isClaude) {
    const claudePool =
      pools.find((p) => p?.poolKey === 'Claude & GPT') ||
      pools.find((p) => isThirdPartyPoolText(p?.poolKey || p?.poolLabel || ''));
    const cand = isWeekly ? claudePool?.weeklyRemainingPct : claudePool?.remainingPct;
    if (cand != null && Number.isFinite(Number(cand))) {
      rawPct = Number(cand);
    } else if (activePool && isThirdPartyPoolText(activePool.family || activePool.poolLabel || '')) {
      const fb = isWeekly ? activePool.weeklyRemainingPct : activePool.remainingPct;
      if (fb != null && Number.isFinite(Number(fb))) rawPct = Number(fb);
    }
  } else {
    const stdGemini =
      pools.find((p) => p?.poolKey === 'Gemini') ||
      pools.find(
        (p) =>
          /gemini/i.test(String(p?.poolKey || p?.poolLabel || '')) &&
          !/carbon|argon/i.test(String(p?.poolKey || ''))
      );
    const geminiFamilyPools = pools.filter((p) =>
      /gemini|carbon|argon/i.test(String(p?.poolKey || p?.poolLabel || ''))
    );
    const primaryCand = isWeekly ? stdGemini?.weeklyRemainingPct : stdGemini?.remainingPct;
    if (primaryCand != null && Number.isFinite(Number(primaryCand))) {
      rawPct = Number(primaryCand);
    } else {
      const familyVals = geminiFamilyPools
        .map((p) => (isWeekly ? p?.weeklyRemainingPct : p?.remainingPct))
        .filter((v) => v != null && Number.isFinite(Number(v)))
        .map(Number);
      if (familyVals.length > 0) {
        rawPct = Math.min(...familyVals);
      } else if (
        activePool &&
        !isThirdPartyPoolText(activePool.family || activePool.poolLabel || '')
      ) {
        const fb = isWeekly ? activePool.weeklyRemainingPct : activePool.remainingPct;
        if (fb != null && Number.isFinite(Number(fb))) rawPct = Number(fb);
      }
      if (
        rawPct == null &&
        isWeekly &&
        weekly &&
        !isThirdPartyPoolText(weekly.poolFamily || '') &&
        weekly.remainingPct != null &&
        Number.isFinite(Number(weekly.remainingPct))
      ) {
        rawPct = Number(weekly.remainingPct);
      }
    }
  }

  if (rawPct == null || !Number.isFinite(rawPct)) return null;
  return Math.max(0, Math.min(100, Math.round(rawPct)));
}

/**
 * 使用最大余数法（Hamilton 方法）将各非零分桶等比缩放至目标整数总和，
 * 保证 0 值通道绝不被凭空分配余数，且缩放后各分桶之和精确等于 `targetTotal`。
 *
 * @param {Record<string, number>} buckets
 * @param {readonly string[]} keys
 * @param {number} targetTotal
 * @returns {Record<string, number>}
 */
function scaleBucketsExact(buckets, keys, targetTotal) {
  const safeTarget = Math.max(0, Math.round(Number(targetTotal || 0)));
  const out = {};
  let currentSum = 0;
  for (const k of keys) {
    const val = Math.max(0, Number(buckets[k] || 0));
    out[k] = val;
    currentSum += val;
  }
  if (safeTarget === 0 || currentSum <= 0) {
    for (const k of keys) out[k] = 0;
    return out;
  }
  if (currentSum === safeTarget) {
    for (const k of keys) out[k] = Math.round(out[k]);
    return out;
  }
  const remainders = [];
  let assigned = 0;
  for (const k of keys) {
    const rawVal = out[k];
    if (rawVal <= 0) {
      out[k] = 0;
      continue;
    }
    const exact = (rawVal * safeTarget) / currentSum;
    const floored = Math.floor(exact);
    out[k] = floored;
    assigned += floored;
    remainders.push({ key: k, rem: exact - floored, orig: rawVal });
  }
  const diff = safeTarget - assigned;
  if (diff > 0 && remainders.length > 0) {
    remainders.sort((a, b) => b.rem - a.rem || b.orig - a.orig);
    for (let i = 0; i < diff; i++) {
      out[remainders[i % remainders.length].key] += 1;
    }
  }
  return out;
}
return { THIRD_PARTY_POOL_RE, isThirdPartyPoolText, classifySpeedTier, classifyCacheTier, classifyStepCostTier, classifyTtftTier, formatCompactTokens, formatCompactCapsuleCost, formatCompactCapsuleTtft, resolveCapsuleQuotaSlotPct, scaleBucketsExact };
})();

// --- shared/window-bridge-protocol.mjs ---
const { WINDOW_BRIDGE_KEY, WINDOW_BRIDGE_ROUTE_KEY, WINDOW_OVERLAY_KEY, CONTEXT_WINDOWS_GLOBAL_KEY, WINDOW_OVERLAY_METHODS, BRIDGE_API_ROUTE_DEFS, BRIDGE_API_PATHS, readInjectedWindowBridge } = (() => {
const WINDOW_BRIDGE_KEY = '__AGUsageMonitorBridge';
const WINDOW_BRIDGE_ROUTE_KEY = 'hostRouteCascadeId';
const WINDOW_OVERLAY_KEY = '__AGUsageMonitorOverlay';
const CONTEXT_WINDOWS_GLOBAL_KEY = '__AGUsageMonitorContextWindows';

const WINDOW_OVERLAY_METHODS = Object.freeze({
  ensureAlive: 'ensureAlive',
  getDockKind: 'getDockKind',
  getMountMode: 'getMountMode',
  updateBridge: 'updateBridge',
  applyMountMode: 'applyMountMode',
  syncHostRoute: 'syncHostRoute',
  deliverRpc: 'deliverRpc',
  dispose: 'dispose',
});

const BRIDGE_API_ROUTE_DEFS = Object.freeze([
  Object.freeze({ path: '/api/telemetry', method: 'GET', action: 'telemetry' }),
  Object.freeze({ path: '/api/settings', method: 'POST', action: 'settings' }),
  Object.freeze({ path: '/api/accounts', method: 'GET', action: 'accounts_get' }),
  Object.freeze({ path: '/api/accounts/update', method: 'POST', action: 'accounts_update' }),
  Object.freeze({ path: '/api/context-window', method: 'POST', action: 'context_window' }),
  Object.freeze({ path: '/api/settings/reset', method: 'POST', action: 'settings_reset' }),
  Object.freeze({ path: '/api/cache/rebuild', method: 'POST', action: 'cache_rebuild' }),
  Object.freeze({ path: '/api/cloud-sync', method: 'POST', action: 'cloud_sync' }),
  Object.freeze({ path: '/api/plugin-update', method: 'POST', action: 'plugin_update' }),
  Object.freeze({ path: '/api/bridge/relaunch', method: 'POST', action: 'bridge_relaunch' }),
]);

const BRIDGE_API_PATHS = Object.freeze(BRIDGE_API_ROUTE_DEFS.map((r) => r.path));

function readInjectedWindowBridge() {
  return typeof window === 'undefined' ? undefined : window[WINDOW_BRIDGE_KEY];
}
return { WINDOW_BRIDGE_KEY, WINDOW_BRIDGE_ROUTE_KEY, WINDOW_OVERLAY_KEY, CONTEXT_WINDOWS_GLOBAL_KEY, WINDOW_OVERLAY_METHODS, BRIDGE_API_ROUTE_DEFS, BRIDGE_API_PATHS, readInjectedWindowBridge };
})();

// --- src/icons/svgRegistry.js ---
const { SVG_ICON_DEFS } = (() => {
/**
 * @fileoverview Pure vector SVG icon registry (16x16 grid).
 * Strictly zero emoji characters anywhere in the codebase.
 */

const SVG_ICON_DEFS = Object.freeze({
  pulse: [
    { tag: 'path', attrs: { d: 'M1.5 8h2.5l2.2-5.5 3.6 11 2.2-5.5h2.5' } },
  ],
  bolt: [
    { tag: 'path', attrs: { d: 'M9.2 1.5L3.5 9h4.2l-.9 5.5L12.5 7H8.3l.9-5.5z' } },
  ],
  refresh: [
    { tag: 'path', attrs: { d: 'M13.5 8a5.5 5.5 0 1 1-1.4-3.7' } },
    { tag: 'path', attrs: { d: 'M13.5 2.2v2.6h-2.6' } },
  ],
  check: [
    { tag: 'path', attrs: { d: 'M3 8.5l3.2 3.2L13 4.8' } },
  ],
  warning: [
    { tag: 'path', attrs: { d: 'M8 2.2L1.8 13.2h12.4L8 2.2z' } },
    { tag: 'path', attrs: { d: 'M8 6.2v3.4' } },
    { tag: 'circle', attrs: { cx: '8', cy: '11.5', r: '0.6', fill: 'currentColor', stroke: 'none' } },
  ],
  'chevron-down': [
    { tag: 'path', attrs: { d: 'M4 6.2l4 4 4-4' } },
  ],
  'chevron-up': [
    { tag: 'path', attrs: { d: 'M4 9.8l4-4 4 4' } },
  ],
  'chevron-right': [
    { tag: 'path', attrs: { d: 'M6.2 4l4 4-4 4' } },
  ],
  'chevron-left': [
    { tag: 'path', attrs: { d: 'M9.8 4l-4 4 4 4' } },
  ],
  layers: [
    { tag: 'path', attrs: { d: 'M8 2L2 5.2 8 8.4l6-3.2L8 2z' } },
    { tag: 'path', attrs: { d: 'M2 8.2L8 11.4l6-3.2' } },
    { tag: 'path', attrs: { d: 'M2 11.2L8 14.4l6-3.2' } },
  ],
  'chart-bar': [
    { tag: 'path', attrs: { d: 'M2 13.5h12' } },
    { tag: 'path', attrs: { d: 'M4.5 13.5V7.5' } },
    { tag: 'path', attrs: { d: 'M8 13.5V2.5' } },
    { tag: 'path', attrs: { d: 'M11.5 13.5V5.2' } },
  ],
  table: [
    { tag: 'rect', attrs: { x: '2', y: '2.5', width: '12', height: '11', rx: '1.5' } },
    { tag: 'path', attrs: { d: 'M2 6.2h12' } },
    { tag: 'path', attrs: { d: 'M6.2 6.2v7.3' } },
  ],
  sliders: [
    { tag: 'path', attrs: { d: 'M2 3.5h2M7 3.5h7' } },
    { tag: 'path', attrs: { d: 'M2 8h7M12 8h2' } },
    { tag: 'path', attrs: { d: 'M2 12.5h3.3M8.3 12.5H14' } },
    { tag: 'circle', attrs: { cx: '5.5', cy: '3.5', r: '1.5' } },
    { tag: 'circle', attrs: { cx: '10.5', cy: '8', r: '1.5' } },
    { tag: 'circle', attrs: { cx: '6.8', cy: '12.5', r: '1.5' } },
  ],
  calendar: [
    { tag: 'rect', attrs: { x: '2.2', y: '3.2', width: '11.6', height: '10.6', rx: '1' } },
    { tag: 'path', attrs: { d: 'M5.2 1.8v2.4M10.8 1.8v2.4M2.2 6.5h11.6' } },
  ],
  clock: [
    { tag: 'circle', attrs: { cx: '8', cy: '8', r: '5.8' } },
    { tag: 'path', attrs: { d: 'M8 4.8v3.5l2.4 1.5' } },
  ],
  plus: [
    { tag: 'path', attrs: { d: 'M8 3.5v9M3.5 8h9' } },
  ],
  minus: [
    { tag: 'path', attrs: { d: 'M3.5 8h9' } },
  ],
  dot: [
    { tag: 'circle', attrs: { cx: '8', cy: '8', r: '5', fill: 'currentColor', stroke: 'none' } },
  ],
  'arrow-down': [
    { tag: 'path', attrs: { d: 'M8 2.8v10.4M4.2 9.4L8 13.2l3.8-3.8' } },
  ],
  'arrow-up': [
    { tag: 'path', attrs: { d: 'M8 13.2V2.8M4.2 6.6L8 2.8l3.8 3.8' } },
  ],
  dock: [
    { tag: 'rect', attrs: { x: '1.8', y: '2.5', width: '12.4', height: '11', rx: '1.5' } },
    { tag: 'path', attrs: { d: 'M1.8 6h12.4' } },
    { tag: 'path', attrs: { d: 'M9.2 4.25h3.2' } },
  ],
  close: [
    { tag: 'path', attrs: { d: 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6' } },
  ],
  copy: [
    { tag: 'rect', attrs: { x: '5.2', y: '5.2', width: '8.3', height: '8.3', rx: '1.3' } },
    { tag: 'path', attrs: { d: 'M3.5 10.8H2.8a1.3 1.3 0 0 1-1.3-1.3V3.3A1.3 1.3 0 0 1 2.8 2h6.2a1.3 1.3 0 0 1 1.3 1.3v.7' } },
  ],
  grip: [
    { tag: 'circle', attrs: { cx: '6', cy: '4', r: '1.05', fill: 'currentColor', stroke: 'none' } },
    { tag: 'circle', attrs: { cx: '10', cy: '4', r: '1.05', fill: 'currentColor', stroke: 'none' } },
    { tag: 'circle', attrs: { cx: '6', cy: '8', r: '1.05', fill: 'currentColor', stroke: 'none' } },
    { tag: 'circle', attrs: { cx: '10', cy: '8', r: '1.05', fill: 'currentColor', stroke: 'none' } },
    { tag: 'circle', attrs: { cx: '6', cy: '12', r: '1.05', fill: 'currentColor', stroke: 'none' } },
    { tag: 'circle', attrs: { cx: '10', cy: '12', r: '1.05', fill: 'currentColor', stroke: 'none' } },
  ],
});
return { SVG_ICON_DEFS };
})();

// --- src/icons/SvgIcon.js ---
const { SVG_NS, createSvgIcon, patchSvgIcon } = (() => {
/**
 * @fileoverview Dynamic SVG icon component and incremental icon patcher.
 */


const SVG_NS = 'http://www.w3.org/2000/svg';

function createSvgIcon(name, { size = 14, className = '' } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (className) {
    svg.setAttribute('class', `svg-icon ${className}`.trim());
  } else {
    svg.setAttribute('class', 'svg-icon');
  }
  patchSvgIcon(svg, name);
  return svg;
}

function patchSvgIcon(svgEl, name) {
  if (!svgEl || svgEl.dataset?.iconName === name) return false;
  if (svgEl.dataset) {
    svgEl.dataset.iconName = name;
  }
  while (svgEl.firstChild) {
    svgEl.removeChild(svgEl.firstChild);
  }
  const shapes = SVG_ICON_DEFS[name] || SVG_ICON_DEFS.dot;
  for (const shape of shapes) {
    const child = document.createElementNS(SVG_NS, shape.tag);
    for (const [k, v] of Object.entries(shape.attrs)) {
      child.setAttribute(k, v);
    }
    svgEl.appendChild(child);
  }
  return true;
}
return { SVG_NS, createSvgIcon, patchSvgIcon };
})();

// --- src/core/reactive.js ---
const { createReactiveStore } = (() => {
/**
 * @fileoverview Fine-grained reactive store with async microtask batching
 * and structural slice comparison to prevent full-page re-renders.
 */

const pendingJobs = new Set();
let isFlushPending = false;

function scheduleAsyncJob(job) {
  pendingJobs.add(job);
  if (!isFlushPending) {
    isFlushPending = true;
    queueMicrotask(flushAsyncJobs);
  }
}

function flushAsyncJobs() {
  isFlushPending = false;
  const jobs = Array.from(pendingJobs);
  pendingJobs.clear();
  for (const job of jobs) {
    job();
  }
}

function isShallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) return false;
    }
    return true;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !Object.is(a[k], b[k])) {
      return false;
    }
  }
  return true;
}

function createReactiveStore(initialState) {
  let state = { ...initialState };
  const subscribers = new Set();

  function getState() {
    return state;
  }

  function notifyAll() {
    for (const sub of Array.from(subscribers)) {
      if (!subscribers.has(sub)) continue;
      const nextSlice = sub.selector(state);
      const equal = sub.compare(sub.lastSlice, nextSlice);
      if (!equal) {
        const prevSlice = sub.lastSlice;
        sub.lastSlice = nextSlice;
        sub.listener(nextSlice, prevSlice);
      }
    }
  }

  function setState(patchOrUpdater, { sync = false } = {}) {
    const patch = typeof patchOrUpdater === 'function' ? patchOrUpdater(state) : patchOrUpdater;
    if (!patch || typeof patch !== 'object') return;

    let changed = false;
    const nextState = { ...state };
    for (const [k, v] of Object.entries(patch)) {
      if (!Object.is(state[k], v)) {
        nextState[k] = v;
        changed = true;
      }
    }
    if (!changed) {
      return;
    }
    state = nextState;

    if (sync) {
      notifyAll();
    } else {
      scheduleAsyncJob(notifyAll);
    }
  }

  function subscribe(selector, listener, { immediate = true, compare = isShallowEqual } = {}) {
    const initialSlice = selector(state);
    const sub = {
      selector,
      listener,
      compare,
      lastSlice: initialSlice,
    };
    subscribers.add(sub);
    if (immediate) {
      listener(initialSlice, undefined);
    }
    return () => {
      subscribers.delete(sub);
    };
  }

  return {
    getState,
    setState,
    subscribe,
  };
}
return { createReactiveStore };
})();

// --- src/i18n/zh-CN.js ---
const { I18N_MESSAGES_ZH_CN } = (() => {
/**
 * @fileoverview Simplified Chinese (zh-CN) dictionary for Antigravity Usage & Speed Monitor.
 * Matches 100% of the existing out-of-the-box UI copy. Zero emoji characters.
 */

const I18N_MESSAGES_ZH_CN = Object.freeze({
  'steps.diagnosticsHint': '原始计时诊断：点击首字延迟查看',
  'steps.diagnosticsDownload': '下载脱敏 JSON',
  'steps.diagnosticsSelected': '步骤 #{step} 的请求诊断',
  'steps.diagnosticsOpen': '查看原始计时并下载脱敏请求诊断',

  // Top Navigation
  'nav.overview': '实时监控',
  'nav.consumption': '用量统计',
  'nav.steps': '调用明细',
  'nav.settings': '偏好设置',

  // Top Session Header
  'header.followLatest': '跟随最新会话',
  'header.currentWindowNamed': '当前窗口 ({title})',
  'header.latestNamed': '最新 ({title})',
  'header.lockedSession': '已锁定会话 ({id})',
  'header.lockedMeta': '已锁定',
  'header.convMetaWithSubs': '主{main} · {subs}子 (共{total}步)',
  'header.convMetaWithSwarm': '主{main} · {swarm}蜂 (共{total}步)',
  'header.convMetaWithSwarmAndSubs': '主{main} · {swarm}蜂 · {subs}子 (共{total}步)',
  'header.convMetaSteps': '{count}步',
  'header.hasUpdate': '有新版本',
  'header.upgradeToVer': '升级 v{ver}',
  'header.upgrading': '升级中…',
  'header.ariaUpdate': '发现新版本，点击升级',
  'header.ariaRefresh': '刷新数据',
  'header.statusSyncing': '同步中',
  'header.statusSynced': '已刷新',
  'header.statusRetrying': '重试中',
  'header.statusGenerating': '生成中{suffix}',
  'header.statusQuotaCached': '额度缓存',
  'header.statusQuotaOffline': '额度离线',
  'header.statusLive': '实时 2s',

  // Formatters & Common Labels
  'fmt.pending': '待定',
  'fmt.speedIncomplete': '计时不完整',
  'fmt.speedCanceled': '已取消',
  'fmt.speedError': '调用报错',
  'fmt.speedInterrupted': '连接中断',
  'fmt.speedCompactionTimingUnavailable': '压缩无计时',
  'fmt.speedInvalidOutput': '无有效输出',
  'fmt.speedInconsistent': '耗时数据异常',
  'fmt.speedShort': '耗时过短 (<0.5s)',
  'fmt.speedLegacy': '旧版缓存记录',
  'fmt.sampleSteps': '{valid}/{total} 步',
  'fmt.resetUnknown': '未知重置时间',
  'fmt.resetSoon': '即将重置',
  'fmt.resetUnder1m': '<1分钟后重置',
  'fmt.resetDaysHours': '{d}天 {h}小时后重置',
  'fmt.resetHoursMins': '{h}小时 {m}分后重置',
  'fmt.resetMins': '{m}分钟后重置',
  'fmt.selectTime': '选择时间',
  'fmt.unknownModel': '模型未知',
  'fmt.compactionSuffix': '·压缩',
  'fmt.mainAgent': '主代理',
  'fmt.mainBadge': '主',
  'fmt.subAgent': '子代理',
  'fmt.subBadge': '子{index}',
  'fmt.subBadgeShort': '子',
  'fmt.swarmAgent': '蜂群',
  'fmt.swarmBadge': '蜂{index}',
  'fmt.swarmBadgeShort': '蜂',
  'fmt.swarmMonitorHint': '巡检',
  'fmt.swarmNarratorHint': '旁白',
  'fmt.sideQuestion': '旁路提问',
  'fmt.sideBadge': '旁{index}',
  'fmt.sideBadgeShort': '旁',
  'fmt.selectedCount': '已选 {count} {unit}',
  'fmt.selectedListTitle': '已选 ({count})：{names}',
  'fmt.selectPlaceholder': '请选择',

  // Capsule & Multi-Session Overlay
  'capsule.ariaMonitor': '用量与速度监控',
  'capsule.ariaMulti': '多会话实时信息',
  'capsule.multiZero': '0 运行中',
  'capsule.multiRunning': '{count} 运行中',
  'capsule.multiRunningWithSubs': '{count} 运行 · {subs} 子',
  'capsule.multiRunningWithSwarm': '{count} 运行 · {subs} 蜂',
  'capsule.tpsRunning': '生成中',
  'capsule.tpsIdle': '待命',
  'capsule.quotaLeft': '余 {pct}%',
  'capsule.quotaUnknown': '余 --%',
  'capsule.newVersion': '新版本',
  'capsule.updating': '更新中…',
  'capsule.ariaUpdateTitle': '发现新版本，点击立即更新',
  'capsule.hoverNewVer': '发现新版本 v{ver}',
  'capsule.hoverNewVerGeneric': '发现新版本可用',
  'capsule.hoverUpdateHintTopbar': '点击顶栏 v{ver} 即可更新',
  'capsule.hoverUpdateHintComposer': '点击版本胶囊 v{ver} 即可更新',
  'capsule.hoverUpdateHintTopbarGeneric': '点击顶栏版本胶囊即可更新',
  'capsule.hoverUpdateHintComposerGeneric': '点击版本胶囊即可更新',
  'multi.title': '实时运行会话',
  'multi.ariaDialog': '多会话实时信息面板',
  'multi.pinned': '已固定',
  'multi.loading': '读取中...',
  'multi.empty': '当前暂无在线运行的会话',
  'multi.allIdle': '全部待命',
  'multi.metaWithSubs': '{main} 主会话 · {subs} 子代理运行中',
  'multi.metaWithSwarm': '{main} 主会话 · {subs} 蜂群运行中',
  'multi.metaMainOnly': '{main} 个会话运行中',
  'multi.hereTag': '本窗',
  'multi.inspectSessionTitle': '点击在监控面板中检视会话：{title}',

  // Live Overview & Widgets
  'module.metrics': '实时指标',
  'module.context': '上下文窗口',
  'module.quotas': '可用额度',
  'module.live_tasks': '实时运行任务',

  // Capsule Slot Metric Options
  'capMetric.context': '上下文占用 (%)',
  'capMetric.tps': '输出速度 (TPS)',
  'capMetric.ttft': '首字延迟 (TTFT)',
  'capMetric.avg_tps': '会话均速 (Avg TPS)',
  'capMetric.cost': '本次费用 ($)',
  'capMetric.session_cost': '会话累计费用 ($)',
  'capMetric.cache_hit': '缓存命中率 (%)',
  'capMetric.session_tokens': '会话总 Token',
  'capMetric.quota_auto': '自动紧俏额度',
  'capMetric.gemini_5h': 'Gemini 5h 额度',
  'capMetric.gemini_weekly': 'Gemini 周额度',
  'capMetric.claude_5h': 'Claude 5h 额度',
  'capMetric.claude_weekly': 'Claude 周额度',

  // Overview Matrix Metric Options & Cells
  'ovMetric.tps': '输出速度',
  'ovMetric.ttft': '首字延迟',
  'ovMetric.avg_tps': '平均速度',
  'ovMetric.step_cost': '本次费用',
  'ovMetric.session_cost': '累计费用',
  'ovMetric.cache_hit': '缓存命中率',
  'ovMetric.session_tokens': '会话 Token',
  'ovMetric.context_usage': '上下文占用',
  'ovMetric.quota_tightest': '紧俏额度',
  'ovMetric.subAvgTtft': '均值 {val}',
  'ovMetric.subAvgCache': '均值 {val}',
  'ovMetric.subValidSamples': '有效 {samples}',
  'ovMetric.subTotalCost': '累计 {cost}',
  'ovMetric.subStepCost': '本次 {cost}',
  'ovMetric.subInOutTokens': '入 {inTok} · 出 {outTok}',
  'ovMetric.subCtxRatio': '{used} / {limit}',
  'ovMetric.subQuotaPool': '{label}',
  'ovMetric.subQuotaPending': '等待配额同步',

  // Context Window Widget
  'ctx.followActive': '跟随活跃 ({badge})',
  'ctx.followActiveTitle': '自动展示当前正在运行或最新活跃的代理上下文窗口',
  'ctx.expandMore': '+{count} 展开',
  'ctx.expandMoreTitle': '展开全部 {count} 个子代理的上下文窗口胶囊',
  'ctx.collapse': '收起',
  'ctx.collapseTitle': '折叠多余子代理胶囊',
  'ctx.ch.assistant': '模型回复',
  'ctx.ch.assistantTitle': '模型推理思考、回复正文与工具调用入参',
  'ctx.ch.toolResults': '工具结果',
  'ctx.ch.toolResultsTitle': '文件读取、终端输出与工具执行返回内容',
  'ctx.ch.userInput': '用户消息',
  'ctx.ch.userInputTitle': '用户提问文本与上传附件',
  'ctx.ch.subagent': '子代理通知',
  'ctx.ch.subagentTitle': '子代理完成汇报与后台任务系统通知',
  'ctx.ch.checkpoint': '压缩摘要',
  'ctx.ch.checkpointTitle': '自动上下文压缩生成的历史摘要检查点',
  'ctx.ch.systemPrompt': '系统提示词',
  'ctx.ch.systemPromptTitle': '核心身份、终端沙箱、制品与环境提示词',
  'ctx.ch.systemTools': '系统工具',
  'ctx.ch.systemToolsTitle': '内置系统工具 Schema 定义',
  'ctx.ch.mcpTools': 'MCP 工具',
  'ctx.ch.mcpToolsTitle': 'MCP 外部服务工具与资源定义',
  'ctx.ch.skills': 'Skill',
  'ctx.ch.skillsTitle': '已挂载的 Skills 技能索引与说明',
  'ctx.ch.userRules': '用户规则',
  'ctx.ch.userRulesTitle': '全局与工作区自定义规则 (user_rules)',

  // Quota Pools Widget
  'quota.weeklyShort': '周限',
  'quota.weeklyPool': '周限 ({pool})',
  'quota.loading': '读取中...',
  'quota.failed': '获取失败 (--%)',
  'quota.usedAndLeft': '{reset} · 已用 {used}% (余 {rem}%)',
  'quota.cycle5hTitle': '当前 5h 周期累计 ({pool})：{tok} Tokens · {cost} · {calls} 次调用',
  'quota.cycleWkCustomTitle': '本周自然周累计：{tok} Tokens · {cost} · {calls} 次调用',
  'quota.cycleWkPoolTitle': '当前周限周期累计 ({pool})：{tok} Tokens · {cost} · {calls} 次调用',
  'quota.footTokensCustom': '本周累计: {tok} ({cost})',
  'quota.footTokensCycle': '周期累计: {tok} ({cost})',
  'quota.footCredits': 'AI 积分: {credits}',
  'quota.footCallsCustom': '本周调用: {calls} 次',
  'quota.footCallsCycle': '周期调用: {calls} 次',
  'quota.footTipCustom': '按本机自然周（周一 00:00 起）统计',
  'quota.footTipCycle': '按各配额池独立周限重置周期分别统计并汇总',

  // Live Activity Widget
  'live.currentSession': '当前会话',
  'live.switchSessionTitle': '点击切换查看会话：{title}',
  'live.thinking': '推理中',
  'live.generating': '生成中',
  'live.running': '运行中',
  'live.waiting': '待命中',
  'live.killed': '已终止',
  'live.done': '已完成',
  'live.doneWithSteps': '已完成 ({steps} 步)',
  'live.waitingWithSteps': '待命中 ({steps} 步)',
  'live.killedWithSteps': '已终止 ({steps} 步)',
  'live.subToggleRunning': '子代理 {run}/{total}',
  'live.subToggleIdle': '子代理 ({total})',
  'live.swarmToggleRunning': '蜂群 {run}/{total}',
  'live.swarmToggleIdle': '蜂群 ({total})',
  'live.subCollapseTitle': '点击收起子代理列表',
  'live.subExpandTitle': '点击展开查看子代理缩略状态',

  // Consumption View
  'cons.rangeCycle': '周期',
  'cons.rangeToday': '今天',
  'cons.range24h': '1天',
  'cons.range7d': '7天',
  'cons.range14d': '14天',
  'cons.range30d': '30天',
  'cons.rangeAll': '全部',
  'cons.rangeCustom': '自定义',
  'cons.rangeAria': '消耗统计时间范围',
  'cons.applyFilter': '筛选',
  'cons.rangeTo': '至',
  'cons.overviewTitle': '用量总览',
  'cons.totalTokens': '总 Token',
  'cons.estCost': '预估费用',
  'cons.cacheHitRate': '缓存命中率',
  'cons.callsCount': '{calls} 次',
  'cons.cacheHitTokens': '命中 {tokens}',
  'cons.newInput': '新输入',
  'cons.uncachedInput': '未命中缓存输入',
  'cons.cacheRead': '缓存读取',
  'cons.savedCost': '节省 {cost}',
  'cons.outputUsage': '输出用量',
  'cons.replyAndThink': '回复 {resp} · 思考 {think}',
  'cons.trendTitle': '用量趋势',
  'cons.allTime': '全部时间',
  'cons.trendHeatmapHint': '按日 ({days}天) · 悬停查看',
  'cons.trendPointsHintHourly': '按小时 ({points}点) · 悬停查看',
  'cons.trendPointsHintDaily': '按日 ({points}点) · 悬停查看',
  'cons.topModels': '模型排行',
  'cons.clientSources': '客户端来源',
  'cons.monthlyTitle': '月度统计',
  'cons.monthLabel': '{m}月',
  'cons.monthFullLabel': '{year}年 {m}月',
  'cons.hoverModelsHint': '悬停查看模型',
  'cons.otherModelsCount': '其他 ({count})',
  'cons.legInput': '输入',
  'cons.legCache': '缓存',
  'cons.legOutput': '输出',
  'cons.legThinking': '思考',
  'cons.footInput': '输入 ',
  'cons.footCache': '缓存 ',
  'cons.footOutput': '输出 ',
  'cons.footThinking': '思考 ',
  'cons.footCalls': '调用 ',

  // Steps Detail View & Step Column Registry
  'steps.title': '调用记录',
  'steps.tabSteps': '按步查看 ({count})',
  'steps.tabStepsFiltered': '按步查看 ({filtered}/{total})',
  'steps.tabModels': '总汇总',
  'steps.allAgents': '全部汇总',
  'steps.allModels': '全部模型',
  'steps.selectModel': '选择模型',
  'steps.unitAgent': '代理',
  'steps.unitModel': '模型',
  'steps.lineTitle': '会话走势',
  'steps.fitTitle': '趋势拟合',
  'steps.modelsTitle': '模型总览',
  'steps.modelsEmpty': '当前范围暂无模型调用记录',
  'steps.metricTotalTokens': '总Token',
  'steps.metricContext': '上下文',
  'steps.metricTps': 'TPS',
  'steps.metricTtft': '首字',
  'steps.metricCache': '缓存',
  'steps.metricCost': '费用',
  'steps.badgeBackAll': '点击切回全部汇总',
  'steps.badgeFilterAgent': '点击仅过滤查看 {agent}（按住 Ctrl/Shift 可加减多选）',
  'steps.ctxTitle': '上下文 {ctx} · 思考 {think} · 正文 {resp}',
  'steps.ioCacheTitle': '新输入 {inPart} · 输出 {outPart} · 缓存读 {cachePart}',
  'steps.tokSeg.context.th': '上下文',
  'steps.tokSeg.context.tip': '上下文',
  'steps.tokSeg.in.th': '输入',
  'steps.tokSeg.in.tip': '新输入',
  'steps.tokSeg.out.th': '输出',
  'steps.tokSeg.out.tip': '输出',
  'steps.tokSeg.cache.th': '缓存',
  'steps.tokSeg.cache.tip': '缓存读',
  'steps.tokSeg.think.th': '思考',
  'steps.tokSeg.think.tip': '思考',
  'steps.tokSeg.reply.th': '正文',
  'steps.tokSeg.reply.tip': '正文',
  'steps.tokSeg.total.th': '总计',
  'steps.tokSeg.total.tip': '总计',
  'steps.modelCallsShare': '{calls}次 · {pct}%',
  'steps.modelCallsOnly': '{calls}次',
  'steps.modelsSummaryPrefix': '{count} 模型 · ',
  'steps.modelPerfFoot': '均速 {tps} · 首字 {ttft} · 缓存 {cache}%',
  'steps.modelSplitFoot': '入 {inTok} · 缓 {cacheTok} · 思 {thinkTok} · 正 {respTok}',
  'steps.fitActiveCardTitle': '{title}（已纳入上方趋势拟合，按住 Ctrl/Shift 点击可多选对比）',
  'steps.fitInactiveCardTitle': '点击在上方拟合图查看 {text}（按住 Ctrl/Shift 点击可多选同图对比）',
  'steps.turnMediaOnly': '[图片/附件提问]',
  'steps.turnMediaSuffix': '[附图]',
  'steps.anomalyTag.timeout': '超时{n}',
  'steps.anomalyTag.rate_limit': '限流{n}',
  'steps.anomalyTag.capacity': '503×{n}',
  'steps.anomalyTag.capacitySingle': '503',
  'steps.anomalyTag.disconnect': '断连{n}',
  'steps.anomalyTag.upstream': '500×{n}',
  'steps.anomalyTag.upstreamSingle': '500',
  'steps.anomalyTag.model_output': '纠偏{n}',
  'steps.anomalyTag.safety': '过滤{n}',
  'steps.anomalyTag.auth_or_model': '受限{n}',
  'steps.anomalyTag.error': '报错{n}',
  'steps.anomalyTag.mixed': '异常{n}',
  'steps.anomalyKind.timeout': '流空闲 / 连接超时',
  'steps.anomalyKind.rate_limit': '429 限流 / 配额耗尽',
  'steps.anomalyKind.capacity': '503 上游算力不足',
  'steps.anomalyKind.disconnect': '连接中断 / 断流',
  'steps.anomalyKind.upstream': '上游 5xx 内部错误',
  'steps.anomalyKind.model_output': '模型输出 / 工具参数无效',
  'steps.anomalyKind.safety': '内容安全过滤',
  'steps.anomalyKind.auth_or_model': '请求受限 / 模型不可用',
  'steps.anomalyKind.error': '调用异常',
  'steps.anomalyKind.canceled': '用户取消',
  'steps.anomalyStepTitle': '#{step} · 异常 {count} 次',
  'steps.anomalyDelayPart': '退避 {sec}s',
  'steps.anomalyTerminalTag': '中止',
  'steps.anomalyModelTitle': '{model} · 异常 {count} 次',
  'steps.anomalyModelSub': '涉及 {steps} 步',
  'steps.anomalyModelKindRow': '{kind}：{count} 次',
  'steps.anomalyModelClickHint': '点击前往「按步查看」筛选异常步',
  'steps.anomalySummaryMeta': '异常 {count} 次（{steps} 步）',
  'steps.anomalyFilterLabel': '仅看异常 ({count})',
  'steps.anomalyFilterAll': '返回全部步骤',

  // Step Table Columns (Headers & Option Labels)
  'stepCol.step.th': '步序',
  'stepCol.step.opt': '调用步序 (#)',
  'stepCol.time.th': '时间',
  'stepCol.time.opt': '调用时间 (HH:mm:ss)',
  'stepCol.model.th': '模型',
  'stepCol.model.opt': '调用模型',
  'stepCol.tps.th': '速度',
  'stepCol.tps.opt': '输出速度 (TPS)',
  'stepCol.ttft.th': '首字',
  'stepCol.ttft.opt': '首字延迟 (TTFT)',
  'stepCol.duration.th': '耗时',
  'stepCol.duration.opt': '端到端耗时 (s)',
  'stepCol.tokens_combo.th': '上下文 / 思考 / 正文',
  'stepCol.tokens_combo.opt': '上下文 / 思考 / 正文 (组合)',
  'stepCol.tokens_io_cache.th': '输入 / 输出 / 缓存',
  'stepCol.tokens_io_cache.opt': '输入 / 输出 / 缓存 (组合)',
  'stepCol.tokens_custom.opt': '自定义组合 ({fmt})',
  'stepCol.input_tokens.th': '新输入',
  'stepCol.input_tokens.opt': '新输入 Token',
  'stepCol.cache_tokens.th': '缓存读',
  'stepCol.cache_tokens.opt': '缓存读取 Token',
  'stepCol.output_tokens.th': '总输出',
  'stepCol.output_tokens.opt': '总输出 Token',
  'stepCol.cache.th': '缓存',
  'stepCol.cache.opt': '缓存命中率 (%)',
  'stepCol.cost.th': '费用',
  'stepCol.cost.opt': '单步费用 ($)',

  // Preferences (3-Tab Modular Settings)
  'settings.subTab.general': '常规',
  'settings.subTab.structure': '结构',
  'settings.subTab.account': '账号',
  'settings.subTab.other': '其他',
  'settings.subTab.aria': '偏好设置分类切换',
  'settings.account.current': '当前账号',
  'settings.account.signedOut': '未登录',
  'settings.account.unknown': '暂未获取账号状态',
  'settings.account.email': '账号邮箱',
  'settings.account.credential': 'OAuth 凭证',
  'settings.account.importHint': '粘贴 Antigravity 的刷新令牌或含 refresh_token 的 OAuth JSON。插件会验证账号邮箱，并在本机加密保存。',
  'settings.account.save': '导入凭证',
  'settings.account.capture': '保存当前凭证',
  'settings.account.reload': '刷新列表',
  'settings.account.switch': '切换',
  'settings.account.remove': '移除',
  'settings.account.active': '当前使用',
  'settings.account.written': '凭证已写入',
  'settings.account.pending': '已写入 {email} 的凭证，等待宿主更新。如果一直未更新，请重开当前 Antigravity。',
  'settings.account.savedCredentials': '已保存的凭证',
  'settings.account.empty': '暂无已保存的凭证。',
  'settings.account.loading': '正在读取已保存的凭证…',
  'settings.account.saved': '凭证已保存。',
  'settings.account.removed': '已移除保存的凭证。',
  'settings.account.switched': '已切换账号，正在刷新当前额度。',
  'settings.account.switching': '正在替换凭证并确认宿主账号…',
  'settings.account.verifying': '正在验证凭证所属账号…',
  'settings.account.loadQuota': '查额度',
  'settings.account.loadingQuota': '正在查询此凭证的额度…',
  'settings.account.emptyCredentialQuota': '这个账号暂无可显示的额度池。',
  'settings.account.quota': '额度池剩余',
  'settings.account.quota5h': '5 小时 {percent}%',
  'settings.account.quotaWeekly': '每周 {percent}%',
  'settings.account.noQuota': '暂未获取当前账号的额度池。',
  'settings.account.quotaStale': '额度刷新失败，显示的是当前账号上次获取的数据。',
  'settings.account.unsupported': '凭证切换目前支持 Windows 上的 Antigravity 共享登录。',
  'settings.account.invalidEmail': '请先选择一个已保存的账号。',
  'settings.account.invalidCredential': '请输入有效的 Antigravity 个人账号 OAuth 凭证。',
  'settings.account.credentialTooLarge': '凭证超过 Windows 凭据管理器的 2560 字节上限。',
  'settings.account.notFound': '该凭证已移除，请刷新列表。',
  'settings.account.noCurrentCredential': '暂时无法读取当前账号的共享凭证。',
  'settings.account.busy': '另一个窗口正在操作凭证，请稍后重试。',
  'settings.account.storeFailed': '凭证操作失败，请重试。',
  'settings.account.rollbackFailed': '凭证写入和回滚均失败。请在 Antigravity 中确认当前账号后再继续。',
  'settings.account.credentialAccessDenied': 'Windows 拒绝访问凭据管理器。请在当前 Windows 用户会话中打开 Antigravity 后重试。',
  'settings.account.credentialChanged': '这份凭证已在其他窗口更新，请刷新列表后重试。',
  'settings.account.credentialRejected': 'Google 未接受此凭证。请检查令牌是否属于 Antigravity 且仍然有效。',
  'settings.account.identityMismatch': '凭证所属账号与宿主或保存的账号不一致。请重新导入该凭证。',
  'settings.account.oauthClientUnavailable': '未能从本机 Antigravity 读取 OAuth 客户端配置。',
  'settings.account.oauthUnavailable': '暂时无法完成 Google OAuth 验证，请检查网络后重试。',
  'settings.account.quotaUnavailable': '暂时无法取得此账号的额度，请稍候重试。',
  'settings.saving': '保存中…',
  'settings.saved': '已保存',
  'settings.saveFailed': '保存失败',
  'settings.resetDone': '已恢复默认',
  'settings.resetBtn': '恢复默认',

  // Preferences -> General Tab
  'settings.gen.appearanceTitle': '界面与外观',
  'settings.gen.language': '界面语言',
  'settings.gen.langZh': '简体中文',
  'settings.gen.langEn': 'English',
  'settings.gen.langAuto': '跟随系统',
  'settings.gen.themeAccent': '主题色',
  'settings.gen.accentHost': '跟随宿主',
  'settings.gen.accentBlue': '经典蓝',
  'settings.gen.accentEmerald': '翡翠绿',
  'settings.gen.accentAmber': '琥珀橙',
  'settings.gen.accentViolet': '鸢尾紫',
  'settings.gen.accentCyan': '青碧色',
  'settings.gen.accentRose': '玫瑰红',
  'settings.gen.fontScale': '字体大小',
  'settings.gen.fontSm': '小',
  'settings.gen.fontMd': '标准',
  'settings.gen.fontLg': '大',
  'settings.gen.fontXl': '特大',
  'settings.gen.fontHint': '等比缩放侧边栏与展开面板字号，顶栏及输入框内嵌胶囊保持紧凑定高',
  'settings.gen.modernUi': '新 UI（实验性）',
  'settings.gen.modernUiOff': '关闭',
  'settings.gen.modernUiOn': '开启',
  'settings.gen.modernUiHint': '去除大部分线框，采用柔和分层底色与更流畅的现代过渡动画',
  'settings.gen.updateTitle': '版本更新',
  'settings.gen.updateMode': '更新方式',
  'settings.gen.updateManual': '仅提示新版本，手动更新',
  'settings.gen.updateAuto': '自动更新',
  'settings.gen.updateOff': '关闭更新',
  'settings.gen.pricingLabel': '价格表',
  'settings.gen.versionLabel': '当前版本',
  'settings.gen.modelCount': '{count} 个模型',
  'settings.gen.srcRemote': '云端同步',
  'settings.gen.srcLocal': '本地文件',
  'settings.gen.srcDefault': '内置默认',
  'settings.gen.syncAt': '更新于 {time}',
  'settings.gen.pubAt': '发布于 {date}',
  'settings.gen.defaultPricing': '默认价格',
  'settings.gen.syncBtn': '更新价格表',
  'settings.gen.syncingBtn': '更新中…',
  'settings.gen.syncingMsg': '正在同步价格表…',
  'settings.gen.syncedMsg': '价格表已更新 ({count} 个模型)',
  'settings.gen.syncFallbackMsg': '连接超时，使用本地价格表',
  'settings.gen.checkUpdateBtn': '检查更新',
  'settings.gen.checkingBtn': '检查中…',
  'settings.gen.checkingMsg': '正在检查新版本…',
  'settings.gen.checkFailedMsg': '检查失败：{err}',
  'settings.gen.upToDateMsg': '当前已是最新版本 (v{ver})',
  'settings.gen.downloadingMsg': '正在下载更新…',
  'settings.gen.updatedRestartMsg': '更新完成，正在重启面板…',
  'settings.gen.updateSkippedMsg': '未执行更新',
  'settings.gen.updateFailedMsg': '更新失败',
  'settings.gen.canUpgradeSub': '可升级至 v{ver} ({mode})',
  'settings.gen.upgradeToBtn': '升级至 v{ver}',
  'settings.gen.manualUpgradeBtn': '手动升级 v{ver}',
  'settings.gen.updateOffSub': '已关闭更新提醒 ({mode})',
  'settings.gen.latestSub': '已是最新 ({mode})',

  // Preferences -> Structure Tab
  'settings.str.thirdTabAria': '结构子菜单切换',
  'settings.str.tabMount': '挂载胶囊',
  'settings.str.tabHover': '鼠标悬浮窗',
  'settings.str.tabOverview': '实时监控布局',
  'settings.str.tabSteps': '调用明细字段',
  'settings.str.previewMountSidebarHint': '当前为仅侧边栏模式，主窗口不挂载胶囊；切回顶部栏或输入框挂载后将按上方样式呈现',
  'settings.str.mountSection': '挂载胶囊',
  'settings.str.mountBadge': '{count}/5 项',
  'settings.str.mountMode': '面板挂载方式',
  'settings.str.mountDual': '双栖挂载 (顶部栏 + 侧边栏)',
  'settings.str.mountComposer': '输入框挂载 (输入框 + 侧边栏)',
  'settings.str.mountSidebar': '仅侧边栏',
  'settings.bridge.restartTitle': '已自动补齐启动参数，重启一次即可启用悬浮胶囊',
  'settings.bridge.ctxRestartTitle': '已自动补齐启动参数，重启一次即可激活上下文覆写',
  'settings.bridge.restartBody': '已自动为快捷方式、自启项及协议关联写入 --remote-debugging-port=0（后续通过常规快捷方式打开均自动生效）。点击下方按钮即可退出后台进程并立即生效。',
  'settings.bridge.readOnlyTitle': '公共桌面快捷方式受权限保护，授权重启即可生效',
  'settings.bridge.ctxReadOnlyTitle': '公共桌面快捷方式受权限保护，授权重启即可激活上下文覆写',
  'settings.bridge.readOnlyBody': '个人启动项已配好，但公共桌面或开始菜单快捷方式需管理员权限修改。点击下方按钮并在系统弹窗中确认授权，即可一次性修补公共图标并带参重开（后续日常打开均自动生效）。',
  'settings.bridge.macTitle': '当前会话未开启调试端口，一键重开即可启用挂载',
  'settings.bridge.ctxMacTitle': '当前会话未开启调试端口，一键重开即可激活上下文覆写',
  'settings.bridge.noPortTitle': '未检测到本地调试端口，主窗口挂载暂未生效',
  'settings.bridge.unreachableTitle': '本地调试端口未就绪，主窗口挂载暂未生效',
  'settings.bridge.ctxTitle': '未连通本地调试通道，上下文窗口覆写暂未注入',
  'settings.bridge.guideWin': 'Antigravity 2.33.0+ 默认不再开启调试端口。点击「立即重启并启用挂载」即可自动补齐快捷方式参数、退出托盘后台并带参重启生效。',
  'settings.bridge.guideMac': '受 macOS 应用签名限制，从 Dock 直接冷启动默认不带调试端口参数。点击下方按钮即可一键带参重开恢复（日常仅关窗不完全退出 Cmd+Q 则持续有效）。',
  'settings.bridge.guideLinux': 'Antigravity 2.33.0+ 默认不再开启调试端口。点击「立即重启并启用挂载」即可自动写入 .desktop 启动器并重启生效。',
  'settings.bridge.relaunchBtn': '立即重启并启用挂载',
  'settings.bridge.relaunchAuthBtn': '授权修补并立即重启',
  'settings.bridge.relaunchingBtn': '正在重启客户端...',
  'settings.bridge.relaunchFailed': '自动重启失败，请从托盘退出后重试',
  'settings.bridge.dismissAria': '暂时关闭提示',
  'settings.bridge.copyFlagBtn': '复制 {cmd}',
  'settings.bridge.copiedBtn': '已复制启动参数',
  'settings.str.popoverWidthLabel': '悬浮面板宽度',
  'settings.str.popoverWidthAuto': '自适应',
  'settings.str.popoverWidthCustom': '指定宽度',
  'settings.str.popoverWidthHint': '自适应模式下在调用明细等宽表格视图自动撑宽免水平滚动；指定宽度范围 440~1080 px',
  'settings.str.multiToggle': '实时运行会话入口',
  'settings.str.cliCapsuleToggle': 'CLI 底部状态胶囊',
  'settings.str.show': '显示',
  'settings.str.hide': '隐藏',
  'settings.str.on': '开启',
  'settings.str.off': '关闭',
  'settings.str.capsuleSlotsLabel': '胶囊数值与顺序 (左 → 右，1~5 项，可拖拽)',
  'settings.str.addCapsuleSlot': '添加槽位 ({count}/{max})',
  'settings.str.hoverSection': '鼠标悬浮窗',
  'settings.str.hoverBadgeOff': '已关闭',
  'settings.str.hoverBadgeCount': '{count} 模块',
  'settings.str.hoverModulesLabel': '悬浮窗展示模块 (上 → 下，0~4 项，可拖拽)',
  'settings.str.hoverEmptyHint': '已关闭悬浮速览窗（点击胶囊仍可展开完整面板）',
  'settings.str.addHoverModule': '添加模块 ({count}/{max})',
  'settings.str.overviewSection': '实时监控布局',
  'settings.str.overviewBadge': '{modCount} 模块 · {metCount} 指标',
  'settings.str.overviewModulesLabel': '监控模块与顺序 (上 → 下，至少 1 项，可拖拽)',
  'settings.str.addOverviewModule': '添加模块 ({count}/{max})',
  'settings.str.overviewMetricsLabel': '第一行实时指标 (左 → 右，1~4 项，可拖拽)',
  'settings.str.overviewMetricsInactiveHint': '当前已移出「实时指标」模块，此配置将在悬浮窗启用或重新添加模块时生效',
  'settings.str.addOverviewMetric': '添加指标 ({count}/{max})',
  'settings.str.stepsSection': '调用明细字段',
  'settings.str.stepsBadge': '{count} 列',
  'settings.str.stepTurnRailToggle': '对话轮次导轨',
  'settings.str.stepAgentBadgeToggle': '主/子代理标识',
  'settings.str.stepSpeedColorToggle': '输出速度多色分级',
  'settings.str.stepTokenComboLabel': '自定义 Token 组合格式',
  'settings.str.stepTokenComboPlaceholder': '例如 context:new:cache 或 in:out:cache',
  'settings.str.stepTokenComboHint': '可用字段：context(上下文)、in/new(新输入)、out(输出)、cache(缓存)、think(思考)、reply(正文)、total(总计)，以 : 或 / 分隔（1~4 项）',
  'settings.str.stepsColsLabel': '「按步查看」显示列 (左 → 右，至少 2 列，可拖拽)',
  'settings.str.addStepCol': '添加字段 ({count}/{max})',
  'settings.slot.dragHint': '按住上下拖动调整顺序',
  'settings.slot.moveUp': '前移',
  'settings.slot.moveDown': '后移',
  'settings.slot.remove': '移除此项',
  'settings.slot.minReached': '至少保留 {min} 项',
  'settings.slot.alreadyAdded': '已添加',
  'settings.mock.sessionTitle': '重构鉴权中间件与会话缓存',
  'settings.mock.subRole': '接口审计',
  'settings.mock.turnPromptLatest': '排查并发刷新令牌时的竞态问题，补齐单元测试',
  'settings.mock.turnPromptPrev': '梳理路由守卫与过期会话清理逻辑',

  // Preferences -> Other Tab
  'settings.oth.modelTitle': '模型标识显示',
  'settings.oth.modelFormat': '模型名称格式',
  'settings.oth.modelShort': '精简代号 (如 argon-4-high)',
  'settings.oth.modelUpstream': '原始模型 ID (如 gemini-3.8-flash-n)',
  'settings.oth.modelUpstreamCompact': '去前缀原始 ID (如 3.8-flash-n / sonnet-4-6 / 5.4-mini)',
  'settings.oth.orchFormat': 'Orchestrator 系列 ID',
  'settings.oth.orchCompact': '精简代号 (如 orchestrator-argon)',
  'settings.oth.orchFull': '原始完整 ID (如 gemini-pro-orchestrator)',
  'settings.oth.baselineTitle': '模型上下文设置',
  'settings.oth.ctxRiskTitle': '非官方能力风险提示',
  'settings.oth.ctxRiskBody': 'Google 官方并未授权在 Antigravity App / IDE 中修改模型上下文上限。擅自修改可能导致 Antigravity 或 GCP 服务被禁用，甚至触发账号封禁；启用该功能即默认由你自行承担全部风险。你最好清楚自己在做什么！',
  'settings.oth.ctxRiskAcceptBtn': '我已知晓风险，继续使用',
  'settings.oth.ctxModel': '模型',
  'settings.oth.ctxBaselineLabel': '上下文窗口上限',
  'settings.oth.ctxChooseModel': '选择模型',
  'settings.oth.ctxDefault': '跟随宿主设置',
  'settings.oth.ctxExpensive': '{name}（消耗更多配额）',
  'settings.oth.ctxTokens': '{count} token',
  'settings.oth.ctxUnavailable': '{name}（当前不可用）',
  'settings.oth.ctxConfigured': '{name} · 已设置',
  'settings.oth.ctxConfiguredReported': '{name} · 已设置 / 最近 {reported}',
  'settings.oth.ctxPendingBridge': '{name} · 待重启生效',
  'settings.oth.ctxDefaultReported': '默认 · 最近 {name}',
  'settings.oth.ctxReported': '最近一次请求由宿主报告为 {name}。',
  'settings.oth.ctxMixed': '各推理档设置不同',
  'settings.oth.ctxMixedHint': '该模型的推理档保留了不同的旧设置。选择一个上限即可统一。',
  'settings.oth.ctxBaselineHint': '同一模型的推理档共享上限。插件会在启动后重新应用已保存的设置，用于之后发送的消息。',
  'settings.oth.ctxNoModels': '宿主暂未返回可用模型。',
  'settings.oth.ctxNoOptions': '宿主未提供此模型的上下文档位或容量，当前只能跟随宿主设置。',
  'settings.oth.maintTitle': '缓存与重置',
  'settings.oth.cacheLabel': '本地轨迹缓存',
  'settings.oth.cacheDesc': '清空内存与磁盘步骤解析缓存并立即重扫全部会话',
  'settings.oth.rebuildBtn': '重建本地轨迹缓存',
  'settings.oth.rebuildingBtn': '重建中…',
  'settings.oth.rebuildDone': '本地轨迹缓存已重建',
  'settings.oth.rebuildFailed': '缓存重建失败',
  'settings.oth.resetLabel': '恢复出厂偏好',
  'settings.oth.resetDesc': '将常规、结构与其他分页中的所有偏好设置还原为初始默认状态',
  'settings.oth.resetAllBtn': '恢复全部默认设置',
  'settings.oth.resetConfirmBtn': '再次点击确认重置',
  'settings.oth.resettingBtn': '重置中…',
  'settings.oth.resetAllDone': '已恢复全部默认设置',

  // Structured Live Activity Actions
  'live.act.run_command': '执行命令',
  'live.act.read_file': '读取文件',
  'live.act.edit_file': '修改文件',
  'live.act.write_file': '写入文件',
  'live.act.grep_search': '搜索代码',
  'live.act.find_file': '查找文件',
  'live.act.read_url': '读取网页',
  'live.act.search_web': '网页搜索',
  'live.act.invoke_subagent': '调用子代理',
  'live.act.send_message': '通信子代理',
  'live.act.manage_subagents': '管理子代理',
  'live.act.swarm_add': '派生工蜂',
  'live.act.swarm_title': '命名蜂群',
  'live.act.swarm_kill': '终止工蜂',
  'live.act.swarm_model': '切换工蜂模型',
  'live.act.swarm_channel': '蜂群频道',
  'live.act.swarm_status': '巡检蜂群',
  'live.act.post_message': '发布看板',
  'live.act.read_board': '读取看板',
  'live.act.swarm_wait': '看板待命',
  'live.act.manage_task': '后台任务',
  'live.act.schedule': '定时任务',
  'live.act.ask_question': '等待用户选择',
  'live.act.search_marketplace': '查询插件',
  'live.act.mcp_tool': '调用 MCP',
  'live.act.tool_call': '调用工具',
  'live.act.thinking': '推理中',
  'live.act.compacting': '上下文压缩',
  'live.act.responding': '正在输出回复',
  'live.act.waiting_subagent': '等待子代理',
  'live.act.waiting_swarm': '等待工蜂',
  'live.act.swarm_waiting': '待命中',
  'live.act.swarm_killed': '已终止',
  'live.act.starting': '启动中',
  'live.act.done': '已完成',
  'live.act.awaitingApproval': '等待确认 · {label}',
  'live.act.compactionResuming': '已完成压缩，正在恢复推理',

  // SVG Charts (SessionStepCharts & TrendAreaChart)
  'chart.step.empty': '当前范围暂无可绘制的调用步骤',
  'chart.step.excluded': '未纳入',
  'chart.step.zeroSteps': '0 步',
  'chart.step.stepAdd': '本步 +{tokens}',
  'chart.step.ioSplit': '入 {inTok} · 缓 {cacheTok} · 出 {outTok}',
  'chart.step.cacheShort': '缓存 {pct}%',
  'chart.step.compactionCheckpoint': '上下文自动压缩检查点',
  'chart.step.cacheHitOut': '缓存命中 {pct}% · 输出 +{outTok}',
  'chart.step.ttftShort': '首字 {sec}s',
  'chart.step.outAndCtx': '输出 {outTok} · 上下文 {ctxTok}',
  'chart.step.compactionStep': '上下文压缩步',
  'chart.step.noSpeedSample': '无测速样本',
  'chart.step.ctxAndCache': '上下文 {ctxTok} · 缓存 {pct}%',
  'chart.step.noTtftSample': '无首字计时样本',
  'chart.step.cumCost': '累计 {cost}',
  'chart.step.cacheAndStepTok': '缓存 {pct}% · 本步 {tokens}',
  'chart.step.noSamples': '无样本',
  'chart.step.peakShort': '峰 {val}',
  'chart.step.peakPill': '峰值 {tag} · {val}',
  'chart.step.stepsCount': '{count}步',
  'chart.step.multiPrefix': '{count} 模型 · ',
  'chart.step.sumTokens': '{prefix}累计 {tokens}',
  'chart.step.peakTokens': '{prefix}峰值 {tokens}',
  'chart.step.currentCtx': '当前 {tokens}',
  'chart.step.meanTps': '{prefix}均值 {val} tok/s',
  'chart.step.meanSec': '{prefix}均值 {val}s',
  'chart.step.noValidSamples': '暂无有效样本',
  'chart.step.sumCost': '{prefix}累计 {cost}',
  'chart.fit.empty': '该模型暂无有效拟合样本',
  'chart.fit.loess': 'LOESS 拟合',
  'chart.fit.olsLinear': 'OLS 线性',
  'chart.fit.olsReg': 'OLS 回归',
  'chart.fit.observed': '观测值',
  'chart.fit.tipFit': '拟合 {val}',
  'chart.fit.tipObs': '观测 {val}',
  'chart.fit.zeroSamples': '0 样本',
  'chart.fit.peerMean': '{label} 均 {val}',
  'chart.fit.peerCompare': '同图对比：{peers}',
  'chart.fit.curvesCount': '{count} 条拟合线',
  'chart.fit.multiBadge': '{steps}步 · {models} 模型对比',
  'chart.fit.singleBadge': '{steps}步 · 均 {mean}',
  'chart.fit.olsTitle': 'OLS: y = {slope}x + {intercept} · 样本标准差 SD = ±{sd}',
  'chart.trend.hmMonthYear': '{yy}年{month}月',
  'chart.trend.hmMonthOnly': '{month}月',
  'chart.trend.wdayMon': '一',
  'chart.trend.wdayWed': '三',
  'chart.trend.wdayFri': '五',
  'chart.trend.wdaySun': '日',
  'chart.trend.hmAria': '每日用量热力格子图',
  'chart.trend.hmLess': '少',
  'chart.trend.hmMore': '多',
  'chart.trend.hmActivePeak': '活跃 {active}/{total} 天 · 峰值 {label} · {tokens}',
  'chart.trend.hmActiveZero': '活跃 0/{total} 天',
  'chart.trend.peakPill': '峰值 {label} · {tokens}',
});
return { I18N_MESSAGES_ZH_CN };
})();

// --- src/i18n/en-US.js ---
const { I18N_MESSAGES_EN_US } = (() => {
/**
 * @fileoverview English (en-US) dictionary for Antigravity Usage & Speed Monitor.
 * Zero emoji characters.
 */

const I18N_MESSAGES_EN_US = Object.freeze({
  'steps.diagnosticsHint': 'Raw timing diagnostics: click a TTFT value',
  'steps.diagnosticsDownload': 'Download sanitized JSON',
  'steps.diagnosticsSelected': 'Request diagnostics for step #{step}',
  'steps.diagnosticsOpen': 'Inspect raw timing and download sanitized request diagnostics',

  // Top Navigation
  'nav.overview': 'Live',
  'nav.consumption': 'Usage',
  'nav.steps': 'Steps',
  'nav.settings': 'Settings',

  // Top Session Header
  'header.followLatest': 'Follow Latest Session',
  'header.currentWindowNamed': 'Current ({title})',
  'header.latestNamed': 'Latest ({title})',
  'header.lockedSession': 'Pinned Session ({id})',
  'header.lockedMeta': 'Pinned',
  'header.convMetaWithSubs': 'Main {main} · {subs} sub ({total} steps)',
  'header.convMetaWithSwarm': 'Main {main} · {swarm} swarm ({total} steps)',
  'header.convMetaWithSwarmAndSubs': 'Main {main} · {swarm} swarm · {subs} sub ({total} steps)',
  'header.convMetaSteps': '{count} steps',
  'header.hasUpdate': 'Update',
  'header.upgradeToVer': 'Update v{ver}',
  'header.upgrading': 'Updating…',
  'header.ariaUpdate': 'New version available, click to update',
  'header.ariaRefresh': 'Refresh telemetry',
  'header.statusSyncing': 'Syncing',
  'header.statusSynced': 'Synced',
  'header.statusRetrying': 'Retrying',
  'header.statusGenerating': 'Running{suffix}',
  'header.statusQuotaCached': 'Quota Cached',
  'header.statusQuotaOffline': 'Quota Offline',
  'header.statusLive': 'Live 2s',

  // Formatters & Common Labels
  'fmt.pending': 'N/A',
  'fmt.speedIncomplete': 'Incomplete timing',
  'fmt.speedCanceled': 'Canceled',
  'fmt.speedError': 'Call error',
  'fmt.speedInterrupted': 'Interrupted',
  'fmt.speedCompactionTimingUnavailable': 'Untimed compaction',
  'fmt.speedInvalidOutput': 'No valid output',
  'fmt.speedInconsistent': 'Invalid timing',
  'fmt.speedShort': 'Too brief (<0.5s)',
  'fmt.speedLegacy': 'Legacy cached',
  'fmt.sampleSteps': '{valid}/{total} steps',
  'fmt.resetUnknown': 'Unknown reset',
  'fmt.resetSoon': 'Resetting soon',
  'fmt.resetUnder1m': 'Resets in <1m',
  'fmt.resetDaysHours': 'Resets in {d}d {h}h',
  'fmt.resetHoursMins': 'Resets in {h}h {m}m',
  'fmt.resetMins': 'Resets in {m}m',
  'fmt.selectTime': 'Select time',
  'fmt.unknownModel': 'Unknown model',
  'fmt.compactionSuffix': '·compact',
  'fmt.mainAgent': 'Main Agent',
  'fmt.mainBadge': 'Main',
  'fmt.subAgent': 'Subagent',
  'fmt.subBadge': 'S{index}',
  'fmt.subBadgeShort': 'Sub',
  'fmt.swarmAgent': 'Swarm',
  'fmt.swarmBadge': 'W{index}',
  'fmt.swarmBadgeShort': 'Swarm',
  'fmt.swarmMonitorHint': 'Monitor',
  'fmt.swarmNarratorHint': 'Narrator',
  'fmt.sideQuestion': 'Side Question',
  'fmt.sideBadge': 'Q{index}',
  'fmt.sideBadgeShort': 'Q',
  'fmt.selectedCount': '{count} {unit} selected',
  'fmt.selectedListTitle': 'Selected ({count}): {names}',
  'fmt.selectPlaceholder': 'Select',

  // Capsule & Multi-Session Overlay
  'capsule.ariaMonitor': 'Usage & Speed Monitor',
  'capsule.ariaMulti': 'Active Sessions Overview',
  'capsule.multiZero': '0 active',
  'capsule.multiRunning': '{count} active',
  'capsule.multiRunningWithSubs': '{count} active · {subs} sub',
  'capsule.multiRunningWithSwarm': '{count} active · {subs} swarm',
  'capsule.tpsRunning': 'Running',
  'capsule.tpsIdle': 'Idle',
  'capsule.quotaLeft': '{pct}% left',
  'capsule.quotaUnknown': '--% left',
  'capsule.newVersion': 'Update',
  'capsule.updating': 'Updating…',
  'capsule.ariaUpdateTitle': 'New version available, click to update',
  'capsule.hoverNewVer': 'Update v{ver} available',
  'capsule.hoverNewVerGeneric': 'New version available',
  'capsule.hoverUpdateHintTopbar': 'Click v{ver} in titlebar to update',
  'capsule.hoverUpdateHintComposer': 'Click v{ver} badge to update',
  'capsule.hoverUpdateHintTopbarGeneric': 'Click update badge in titlebar',
  'capsule.hoverUpdateHintComposerGeneric': 'Click update badge to install',
  'multi.title': 'Active Sessions',
  'multi.ariaDialog': 'Active Sessions Panel',
  'multi.pinned': 'Pinned',
  'multi.loading': 'Loading...',
  'multi.empty': 'No active running sessions',
  'multi.allIdle': 'All idle',
  'multi.metaWithSubs': '{main} main · {subs} subagents active',
  'multi.metaWithSwarm': '{main} main · {subs} swarm active',
  'multi.metaMainOnly': '{main} sessions active',
  'multi.hereTag': 'Here',
  'multi.inspectSessionTitle': 'Inspect session in monitor: {title}',

  // Live Overview & Widgets
  'module.metrics': 'Live Metrics',
  'module.context': 'Context Window',
  'module.quotas': 'Available Quotas',
  'module.live_tasks': 'Live Running Tasks',

  // Capsule Slot Metric Options
  'capMetric.context': 'Context Usage (%)',
  'capMetric.tps': 'Output Speed (TPS)',
  'capMetric.ttft': 'First Token Latency (TTFT)',
  'capMetric.avg_tps': 'Avg Speed (Avg TPS)',
  'capMetric.cost': 'Step Cost ($)',
  'capMetric.session_cost': 'Session Cost ($)',
  'capMetric.cache_hit': 'Cache Hit Rate (%)',
  'capMetric.session_tokens': 'Session Tokens',
  'capMetric.quota_auto': 'Auto Tightest Quota',
  'capMetric.gemini_5h': 'Gemini 5h Quota',
  'capMetric.gemini_weekly': 'Gemini Weekly Quota',
  'capMetric.claude_5h': 'Claude 5h Quota',
  'capMetric.claude_weekly': 'Claude Weekly Quota',

  // Overview Matrix Metric Options & Cells
  'ovMetric.tps': 'Output Speed',
  'ovMetric.ttft': 'First Token',
  'ovMetric.avg_tps': 'Avg Speed',
  'ovMetric.step_cost': 'Step Cost',
  'ovMetric.session_cost': 'Session Cost',
  'ovMetric.cache_hit': 'Cache Hit',
  'ovMetric.session_tokens': 'Session Tokens',
  'ovMetric.context_usage': 'Context Usage',
  'ovMetric.quota_tightest': 'Tightest Quota',
  'ovMetric.subAvgTtft': 'Avg {val}',
  'ovMetric.subAvgCache': 'Avg {val}',
  'ovMetric.subValidSamples': 'Valid {samples}',
  'ovMetric.subTotalCost': 'Total {cost}',
  'ovMetric.subStepCost': 'Step {cost}',
  'ovMetric.subInOutTokens': 'In {inTok} · Out {outTok}',
  'ovMetric.subCtxRatio': '{used} / {limit}',
  'ovMetric.subQuotaPool': '{label}',
  'ovMetric.subQuotaPending': 'Waiting for quota sync',

  // Context Window Widget
  'ctx.followActive': 'Follow Active ({badge})',
  'ctx.followActiveTitle': 'Automatically inspect the active or running agent context window',
  'ctx.expandMore': '+{count} More',
  'ctx.expandMoreTitle': 'Expand all {count} subagent context pills',
  'ctx.collapse': 'Less',
  'ctx.collapseTitle': 'Collapse extra subagent pills',
  'ctx.ch.assistant': 'Assistant',
  'ctx.ch.assistantTitle': 'Model reasoning, responses, and tool call arguments',
  'ctx.ch.toolResults': 'Tool Results',
  'ctx.ch.toolResultsTitle': 'File reads, terminal outputs, and tool execution results',
  'ctx.ch.userInput': 'User Input',
  'ctx.ch.userInputTitle': 'User messages and uploaded attachments',
  'ctx.ch.subagent': 'Subagent',
  'ctx.ch.subagentTitle': 'Subagent reports and background task notifications',
  'ctx.ch.checkpoint': 'Checkpoint',
  'ctx.ch.checkpointTitle': 'Compacted conversation checkpoint summaries',
  'ctx.ch.systemPrompt': 'System Prompt',
  'ctx.ch.systemPromptTitle': 'Core identity, sandbox, artifact, and environment prompts',
  'ctx.ch.systemTools': 'System Tools',
  'ctx.ch.systemToolsTitle': 'Built-in tool schema declarations',
  'ctx.ch.mcpTools': 'MCP Tools',
  'ctx.ch.mcpToolsTitle': 'MCP external server tool and resource schemas',
  'ctx.ch.skills': 'Skills',
  'ctx.ch.skillsTitle': 'Installed Skills index and instructions',
  'ctx.ch.userRules': 'User Rules',
  'ctx.ch.userRulesTitle': 'Global and workspace custom user_rules',

  // Quota Pools Widget
  'quota.weeklyShort': 'Weekly',
  'quota.weeklyPool': 'Weekly ({pool})',
  'quota.loading': 'Loading...',
  'quota.failed': 'Unavailable (--%)',
  'quota.usedAndLeft': '{reset} · Used {used}% ({rem}% left)',
  'quota.cycle5hTitle': 'Current 5h cycle ({pool}): {tok} Tokens · {cost} · {calls} calls',
  'quota.cycleWkCustomTitle': 'Current calendar week: {tok} Tokens · {cost} · {calls} calls',
  'quota.cycleWkPoolTitle': 'Current weekly cycle ({pool}): {tok} Tokens · {cost} · {calls} calls',
  'quota.footTokensCustom': 'Week Total: {tok} ({cost})',
  'quota.footTokensCycle': 'Cycle Total: {tok} ({cost})',
  'quota.footCredits': 'AI Credits: {credits}',
  'quota.footCallsCustom': 'Week Calls: {calls}',
  'quota.footCallsCycle': 'Cycle Calls: {calls}',
  'quota.footTipCustom': 'Counted since Monday 00:00 local time',
  'quota.footTipCycle': 'Summed across each quota pool weekly reset window',

  // Live Activity Widget
  'live.currentSession': 'Current Session',
  'live.switchSessionTitle': 'Switch monitor to session: {title}',
  'live.thinking': 'Thinking',
  'live.generating': 'Generating',
  'live.running': 'Running',
  'live.waiting': 'Waiting',
  'live.killed': 'Killed',
  'live.done': 'Done',
  'live.doneWithSteps': 'Done ({steps} steps)',
  'live.waitingWithSteps': 'Waiting ({steps} steps)',
  'live.killedWithSteps': 'Killed ({steps} steps)',
  'live.subToggleRunning': 'Subagents {run}/{total}',
  'live.subToggleIdle': 'Subagents ({total})',
  'live.swarmToggleRunning': 'Swarm {run}/{total}',
  'live.swarmToggleIdle': 'Swarm ({total})',
  'live.subCollapseTitle': 'Collapse subagent list',
  'live.subExpandTitle': 'Expand subagent activity list',

  // Consumption View
  'cons.rangeCycle': 'Cycle',
  'cons.rangeToday': 'Today',
  'cons.range24h': '24h',
  'cons.range7d': '7d',
  'cons.range14d': '14d',
  'cons.range30d': '30d',
  'cons.rangeAll': 'All',
  'cons.rangeCustom': 'Custom',
  'cons.rangeAria': 'Usage statistics time range',
  'cons.applyFilter': 'Apply',
  'cons.rangeTo': 'to',
  'cons.overviewTitle': 'Usage Overview',
  'cons.totalTokens': 'Total Tokens',
  'cons.estCost': 'Est. Cost',
  'cons.cacheHitRate': 'Cache Hit Rate',
  'cons.callsCount': '{calls} calls',
  'cons.cacheHitTokens': 'Hit {tokens}',
  'cons.newInput': 'New Input',
  'cons.uncachedInput': 'Uncached input',
  'cons.cacheRead': 'Cache Read',
  'cons.savedCost': 'Saved {cost}',
  'cons.outputUsage': 'Output',
  'cons.replyAndThink': 'Reply {resp} · Think {think}',
  'cons.trendTitle': 'Usage Trend',
  'cons.allTime': 'All Time',
  'cons.trendHeatmapHint': 'Daily ({days}d) · Hover for details',
  'cons.trendPointsHintHourly': 'Hourly ({points} pts) · Hover for details',
  'cons.trendPointsHintDaily': 'Daily ({points} pts) · Hover for details',
  'cons.topModels': 'Top Models',
  'cons.clientSources': 'Client Sources',
  'cons.monthlyTitle': 'Monthly Breakdown',
  'cons.monthLabel': 'M{m}',
  'cons.monthFullLabel': 'M{m}, {year}',
  'cons.hoverModelsHint': 'Hover for models',
  'cons.otherModelsCount': 'Others ({count})',
  'cons.legInput': 'Input',
  'cons.legCache': 'Cache',
  'cons.legOutput': 'Output',
  'cons.legThinking': 'Think',
  'cons.footInput': 'In ',
  'cons.footCache': 'Cache ',
  'cons.footOutput': 'Out ',
  'cons.footThinking': 'Think ',
  'cons.footCalls': 'Calls ',

  // Steps Detail View & Step Column Registry
  'steps.title': 'Step Records',
  'steps.tabSteps': 'Steps ({count})',
  'steps.tabStepsFiltered': 'Steps ({filtered}/{total})',
  'steps.tabModels': 'Analytics',
  'steps.allAgents': 'All Agents',
  'steps.allModels': 'All Models',
  'steps.selectModel': 'Select Model',
  'steps.unitAgent': 'agents',
  'steps.unitModel': 'models',
  'steps.lineTitle': 'Session Timeline',
  'steps.fitTitle': 'Trend Fit',
  'steps.modelsTitle': 'Model Summary',
  'steps.modelsEmpty': 'No model calls in current scope',
  'steps.metricTotalTokens': 'Tokens',
  'steps.metricContext': 'Context',
  'steps.metricTps': 'TPS',
  'steps.metricTtft': 'TTFT',
  'steps.metricCache': 'Cache',
  'steps.metricCost': 'Cost',
  'steps.badgeBackAll': 'Click to return to All Agents',
  'steps.badgeFilterAgent': 'Click to filter {agent} (Ctrl/Shift-click to multi-select)',
  'steps.ctxTitle': 'Context {ctx} · Thinking {think} · Reply {resp}',
  'steps.ioCacheTitle': 'New In {inPart} · Out {outPart} · Cache Read {cachePart}',
  'steps.tokSeg.context.th': 'Ctx',
  'steps.tokSeg.context.tip': 'Context',
  'steps.tokSeg.in.th': 'In',
  'steps.tokSeg.in.tip': 'New In',
  'steps.tokSeg.out.th': 'Out',
  'steps.tokSeg.out.tip': 'Output',
  'steps.tokSeg.cache.th': 'Cache',
  'steps.tokSeg.cache.tip': 'Cache Read',
  'steps.tokSeg.think.th': 'Think',
  'steps.tokSeg.think.tip': 'Thinking',
  'steps.tokSeg.reply.th': 'Reply',
  'steps.tokSeg.reply.tip': 'Reply',
  'steps.tokSeg.total.th': 'Total',
  'steps.tokSeg.total.tip': 'Total',
  'steps.modelCallsShare': '{calls} calls · {pct}%',
  'steps.modelCallsOnly': '{calls} calls',
  'steps.modelsSummaryPrefix': '{count} models · ',
  'steps.modelPerfFoot': 'Avg {tps} · TTFT {ttft} · Cache {cache}%',
  'steps.modelSplitFoot': 'In {inTok} · Cache {cacheTok} · Think {thinkTok} · Out {respTok}',
  'steps.fitActiveCardTitle': '{title} (Active in Trend Fit; Ctrl/Shift-click to compare)',
  'steps.fitInactiveCardTitle': 'Click to inspect {text} in Trend Fit (Ctrl/Shift-click to compare)',
  'steps.turnMediaOnly': '[Media Attachment]',
  'steps.turnMediaSuffix': '[Media]',
  'steps.anomalyTag.timeout': 'TO{n}',
  'steps.anomalyTag.rate_limit': '429×{n}',
  'steps.anomalyTag.capacity': '503×{n}',
  'steps.anomalyTag.capacitySingle': '503',
  'steps.anomalyTag.disconnect': 'Drop{n}',
  'steps.anomalyTag.upstream': '500×{n}',
  'steps.anomalyTag.upstreamSingle': '500',
  'steps.anomalyTag.model_output': 'Fix{n}',
  'steps.anomalyTag.safety': 'Safe{n}',
  'steps.anomalyTag.auth_or_model': 'Err{n}',
  'steps.anomalyTag.error': 'Err{n}',
  'steps.anomalyTag.mixed': 'Warn{n}',
  'steps.anomalyKind.timeout': 'Stream Idle / Connect Timeout',
  'steps.anomalyKind.rate_limit': '429 Rate Limit / Quota Reached',
  'steps.anomalyKind.capacity': '503 No Capacity Available',
  'steps.anomalyKind.disconnect': 'Connection Reset / Stream Interrupted',
  'steps.anomalyKind.upstream': 'Upstream 5xx Internal Error',
  'steps.anomalyKind.model_output': 'Invalid Model Output / Tool Call',
  'steps.anomalyKind.safety': 'Content Safety Filter',
  'steps.anomalyKind.auth_or_model': 'Request / Model Rejected',
  'steps.anomalyKind.error': 'Call Error',
  'steps.anomalyKind.canceled': 'Canceled by User',
  'steps.anomalyStepTitle': '#{step} · {count} Retries / Errors',
  'steps.anomalyDelayPart': 'Backoff {sec}s',
  'steps.anomalyTerminalTag': 'Stopped',
  'steps.anomalyModelTitle': '{model} · {count} Retries / Errors',
  'steps.anomalyModelSub': '{steps} steps affected',
  'steps.anomalyModelKindRow': '{kind}: {count}',
  'steps.anomalyModelClickHint': 'Click to filter anomalous steps',
  'steps.anomalySummaryMeta': '{count} retries/errors ({steps} steps)',
  'steps.anomalyFilterLabel': 'Anomalies Only ({count})',
  'steps.anomalyFilterAll': 'Show All Steps',

  // Step Table Columns (Headers & Option Labels)
  'stepCol.step.th': 'Step',
  'stepCol.step.opt': 'Step Number (#)',
  'stepCol.time.th': 'Time',
  'stepCol.time.opt': 'Timestamp (HH:mm:ss)',
  'stepCol.model.th': 'Model',
  'stepCol.model.opt': 'Model',
  'stepCol.tps.th': 'Speed',
  'stepCol.tps.opt': 'Output Speed (TPS)',
  'stepCol.ttft.th': 'TTFT',
  'stepCol.ttft.opt': 'First Token (TTFT)',
  'stepCol.duration.th': 'Time(s)',
  'stepCol.duration.opt': 'Total Duration (s)',
  'stepCol.tokens_combo.th': 'Ctx / Think / Reply',
  'stepCol.tokens_combo.opt': 'Ctx / Think / Reply (Combo)',
  'stepCol.tokens_io_cache.th': 'In / Out / Cache',
  'stepCol.tokens_io_cache.opt': 'In / Out / Cache (Combo)',
  'stepCol.tokens_custom.opt': 'Custom Combo ({fmt})',
  'stepCol.input_tokens.th': 'Input',
  'stepCol.input_tokens.opt': 'New Input Tokens',
  'stepCol.cache_tokens.th': 'CacheTok',
  'stepCol.cache_tokens.opt': 'Cache Read Tokens',
  'stepCol.output_tokens.th': 'Output',
  'stepCol.output_tokens.opt': 'Total Output Tokens',
  'stepCol.cache.th': 'Cache',
  'stepCol.cache.opt': 'Cache Hit Rate (%)',
  'stepCol.cost.th': 'Cost',
  'stepCol.cost.opt': 'Step Cost ($)',

  // Preferences (3-Tab Modular Settings)
  'settings.subTab.general': 'General',
  'settings.subTab.structure': 'Structure',
  'settings.subTab.account': 'Account',
  'settings.subTab.other': 'Other',
  'settings.account.current': 'Current account',
  'settings.account.signedOut': 'Signed out',
  'settings.account.unknown': 'Account status unavailable',
  'settings.account.email': 'Account email',
  'settings.account.credential': 'OAuth credential',
  'settings.account.importHint': 'Paste an Antigravity refresh token or OAuth JSON containing a refresh_token. The account email is verified and the credential is encrypted on this device.',
  'settings.account.save': 'Import credential',
  'settings.account.capture': 'Save current credential',
  'settings.account.reload': 'Refresh list',
  'settings.account.switch': 'Switch',
  'settings.account.remove': 'Remove',
  'settings.account.active': 'In use',
  'settings.account.written': 'Credential written',
  'settings.account.pending': 'The credential for {email} was written. If Antigravity stays on the previous account, reopen it.',
  'settings.account.savedCredentials': 'Saved credentials',
  'settings.account.empty': 'No saved credentials.',
  'settings.account.loading': 'Loading saved credentials…',
  'settings.account.saved': 'Credential saved.',
  'settings.account.removed': 'Saved credential removed.',
  'settings.account.switched': 'Account switched. Refreshing the current quota.',
  'settings.account.switching': 'Replacing the credential and confirming the active account…',
  'settings.account.verifying': 'Verifying the credential owner…',
  'settings.account.loadQuota': 'Check quota',
  'settings.account.loadingQuota': 'Checking quota for this credential…',
  'settings.account.emptyCredentialQuota': 'There are no quota pools to display for this account.',
  'settings.account.quota': 'Quota remaining by pool',
  'settings.account.quota5h': '5 hours {percent}%',
  'settings.account.quotaWeekly': 'Weekly {percent}%',
  'settings.account.noQuota': 'Quota pools are unavailable for the current account.',
  'settings.account.quotaStale': 'Quota refresh failed. Showing the last data for the current account.',
  'settings.account.unsupported': 'Credential switching currently supports Antigravity shared sign-in on Windows.',
  'settings.account.invalidEmail': 'Select a saved account first.',
  'settings.account.invalidCredential': 'Enter a valid Antigravity OAuth credential for a personal account.',
  'settings.account.credentialTooLarge': 'The credential exceeds the Windows Credential Manager limit of 2560 bytes.',
  'settings.account.notFound': 'This credential was removed. Refresh the list.',
  'settings.account.noCurrentCredential': 'The shared credential for the current account is unavailable.',
  'settings.account.busy': 'Another window is updating credentials. Try again shortly.',
  'settings.account.storeFailed': 'The credential operation failed. Try again.',
  'settings.account.rollbackFailed': 'Writing and restoring the credential both failed. Check the active account in Antigravity before continuing.',
  'settings.account.credentialAccessDenied': 'Windows denied access to Credential Manager. Open Antigravity in your Windows user session and try again.',
  'settings.account.credentialChanged': 'This credential was updated in another window. Refresh the list and try again.',
  'settings.account.credentialRejected': 'Google rejected this credential. Check that the Antigravity refresh token is still valid.',
  'settings.account.identityMismatch': 'The credential belongs to a different account. Import the credential again.',
  'settings.account.oauthClientUnavailable': 'The local Antigravity OAuth client configuration could not be read.',
  'settings.account.oauthUnavailable': 'Google OAuth verification is unavailable. Check your network and try again.',
  'settings.account.quotaUnavailable': 'Quota for this account is unavailable. Try again shortly.',
  'settings.subTab.aria': 'Preferences category tabs',
  'settings.saving': 'Saving…',
  'settings.saved': 'Saved',
  'settings.saveFailed': 'Save failed',
  'settings.resetDone': 'Reset to default',
  'settings.resetBtn': 'Reset',

  // Preferences -> General Tab
  'settings.gen.appearanceTitle': 'Interface & Appearance',
  'settings.gen.language': 'Language',
  'settings.gen.langZh': '简体中文',
  'settings.gen.langEn': 'English',
  'settings.gen.langAuto': 'Follow System',
  'settings.gen.themeAccent': 'Accent Color',
  'settings.gen.accentHost': 'Host',
  'settings.gen.accentBlue': 'Blue',
  'settings.gen.accentEmerald': 'Emerald',
  'settings.gen.accentAmber': 'Amber',
  'settings.gen.accentViolet': 'Violet',
  'settings.gen.accentCyan': 'Cyan',
  'settings.gen.accentRose': 'Rose',
  'settings.gen.fontScale': 'Font Size',
  'settings.gen.fontSm': 'Small',
  'settings.gen.fontMd': 'Default',
  'settings.gen.fontLg': 'Large',
  'settings.gen.fontXl': 'XL',
  'settings.gen.fontHint': 'Scales sidebar and popover typography while keeping the inline capsule compact',
  'settings.gen.modernUi': 'Modern UI (Experimental)',
  'settings.gen.modernUiOff': 'Off',
  'settings.gen.modernUiOn': 'On',
  'settings.gen.modernUiHint': 'Removes most borders in favor of soft tonal surfaces and smoother animations',
  'settings.gen.updateTitle': 'Updates & Pricing',
  'settings.gen.updateMode': 'Update Policy',
  'settings.gen.updateManual': 'Notify only, update manually',
  'settings.gen.updateAuto': 'Auto update',
  'settings.gen.updateOff': 'Disable updates',
  'settings.gen.pricingLabel': 'Pricing Catalog',
  'settings.gen.versionLabel': 'Current Version',
  'settings.gen.modelCount': '{count} models',
  'settings.gen.srcRemote': 'Cloud synced',
  'settings.gen.srcLocal': 'Local file',
  'settings.gen.srcDefault': 'Built-in',
  'settings.gen.syncAt': 'Synced {time}',
  'settings.gen.pubAt': 'Published {date}',
  'settings.gen.defaultPricing': 'Default catalog',
  'settings.gen.syncBtn': 'Sync Pricing',
  'settings.gen.syncingBtn': 'Syncing…',
  'settings.gen.syncingMsg': 'Syncing pricing catalog…',
  'settings.gen.syncedMsg': 'Pricing updated ({count} models)',
  'settings.gen.syncFallbackMsg': 'Timed out, using local catalog',
  'settings.gen.checkUpdateBtn': 'Check Updates',
  'settings.gen.checkingBtn': 'Checking…',
  'settings.gen.checkingMsg': 'Checking for updates…',
  'settings.gen.checkFailedMsg': 'Check failed: {err}',
  'settings.gen.upToDateMsg': 'Already up to date (v{ver})',
  'settings.gen.downloadingMsg': 'Downloading update…',
  'settings.gen.updatedRestartMsg': 'Update complete, restarting panel…',
  'settings.gen.updateSkippedMsg': 'Update not applied',
  'settings.gen.updateFailedMsg': 'Update failed',
  'settings.gen.canUpgradeSub': 'v{ver} available ({mode})',
  'settings.gen.upgradeToBtn': 'Upgrade to v{ver}',
  'settings.gen.manualUpgradeBtn': 'Upgrade v{ver}',
  'settings.gen.updateOffSub': 'Notifications off ({mode})',
  'settings.gen.latestSub': 'Up to date ({mode})',

  // Preferences -> Structure Tab
  'settings.str.thirdTabAria': 'Structure section tabs',
  'settings.str.tabMount': 'Mount & Bar',
  'settings.str.tabHover': 'Hover View',
  'settings.str.tabOverview': 'Overview',
  'settings.str.tabSteps': 'Step Table',
  'settings.str.previewMountSidebarHint': 'Window capsule is disabled in Sidebar Only mode; switching back to Titlebar or Composer applies the capsule above',
  'settings.str.mountSection': 'Mount & Capsule Bar',
  'settings.str.mountBadge': '{count}/5 slots',
  'settings.str.mountMode': 'Panel Mount Mode',
  'settings.str.mountDual': 'Dual Mount (Titlebar + Sidebar)',
  'settings.str.mountComposer': 'Composer Mount (Input Box + Sidebar)',
  'settings.str.mountSidebar': 'Sidebar Only',
  'settings.bridge.restartTitle': 'Launch Flag Auto-Configured — Restart Once to Activate',
  'settings.bridge.ctxRestartTitle': 'Launch Flag Auto-Configured — Restart Once for Context Override',
  'settings.bridge.restartBody': 'Automatically added --remote-debugging-port=0 to your shortcuts, startup entries, and protocol handlers (subsequent shortcut launches mount automatically). Click below to close background processes and relaunch now.',
  'settings.bridge.readOnlyTitle': 'Public Shortcut Protected — Authorize & Relaunch to Activate',
  'settings.bridge.ctxReadOnlyTitle': 'Public Shortcut Protected — Authorize & Relaunch for Context Override',
  'settings.bridge.readOnlyBody': 'Personal launch entries are configured, but public shortcuts require administrator permission. Click below and approve the system prompt to patch public shortcuts once and relaunch.',
  'settings.bridge.macTitle': 'Debug Port Inactive — One-Click Relaunch to Enable Mount',
  'settings.bridge.ctxMacTitle': 'Debug Port Inactive — One-Click Relaunch for Context Override',
  'settings.bridge.noPortTitle': 'Local Debug Port Missing — Window Mount Inactive',
  'settings.bridge.unreachableTitle': 'Local Debug Port Not Ready — Window Mount Inactive',
  'settings.bridge.ctxTitle': 'Local Debug Port Inactive — Context Override Pending',
  'settings.bridge.guideWin': 'Antigravity 2.33.0+ no longer opens a debug port by default. Click "Relaunch & Enable Mount" to auto-configure shortcuts, close tray background processes, and relaunch.',
  'settings.bridge.guideMac': 'Due to macOS app code signing, cold launches from Dock omit the debug port flag. Click below to relaunch with the flag in one click (stays active until you fully Quit via Cmd+Q).',
  'settings.bridge.guideLinux': 'Antigravity 2.33.0+ no longer opens a debug port by default. Click "Relaunch & Enable Mount" to update your .desktop launcher and relaunch.',
  'settings.bridge.relaunchBtn': 'Relaunch & Enable Mount',
  'settings.bridge.relaunchAuthBtn': 'Authorize & Relaunch',
  'settings.bridge.relaunchingBtn': 'Relaunching Host...',
  'settings.bridge.relaunchFailed': 'Auto-relaunch failed — quit from tray and retry',
  'settings.bridge.dismissAria': 'Dismiss notice for now',
  'settings.bridge.copyFlagBtn': 'Copy {cmd}',
  'settings.bridge.copiedBtn': 'Copied to Clipboard',
  'settings.str.popoverWidthLabel': 'Popover Width',
  'settings.str.popoverWidthAuto': 'Auto Fit',
  'settings.str.popoverWidthCustom': 'Custom',
  'settings.str.popoverWidthHint': 'Auto Fit widens wide tables like Step Records to avoid horizontal scroll; Custom accepts 440–1080 px',
  'settings.str.multiToggle': 'Active Sessions Pill',
  'settings.str.cliCapsuleToggle': 'CLI Bottom Capsule',
  'settings.str.show': 'Show',
  'settings.str.hide': 'Hide',
  'settings.str.on': 'On',
  'settings.str.off': 'Off',
  'settings.str.capsuleSlotsLabel': 'Capsule Metrics & Order (Left → Right, 1–5, draggable)',
  'settings.str.addCapsuleSlot': 'Add Slot ({count}/{max})',
  'settings.str.hoverSection': 'Hover Quick-View',
  'settings.str.hoverBadgeOff': 'Off',
  'settings.str.hoverBadgeCount': '{count} modules',
  'settings.str.hoverModulesLabel': 'Hover Popup Modules (Top → Bottom, 0–4, draggable)',
  'settings.str.hoverEmptyHint': 'Hover quick-view disabled (click capsule to open full panel)',
  'settings.str.addHoverModule': 'Add Module ({count}/{max})',
  'settings.str.overviewSection': 'Live Overview Layout',
  'settings.str.overviewBadge': '{modCount} mod · {metCount} cells',
  'settings.str.overviewModulesLabel': 'Overview Modules & Order (Top → Bottom, min 1, draggable)',
  'settings.str.addOverviewModule': 'Add Module ({count}/{max})',
  'settings.str.overviewMetricsLabel': 'First-Row Metrics (Left → Right, 1–4, draggable)',
  'settings.str.overviewMetricsInactiveHint': '"Live Metrics" is hidden here; these cells still apply to Hover Quick-View or when re-added',
  'settings.str.addOverviewMetric': 'Add Metric ({count}/{max})',
  'settings.str.stepsSection': 'Step Table Columns',
  'settings.str.stepsBadge': '{count} cols',
  'settings.str.stepTurnRailToggle': 'Turn Rail & Preview',
  'settings.str.stepAgentBadgeToggle': 'Main/Sub Agent Badge',
  'settings.str.stepSpeedColorToggle': 'Speed Multi-Color',
  'settings.str.stepTokenComboLabel': 'Custom Token Combo Format',
  'settings.str.stepTokenComboPlaceholder': 'e.g. context:new:cache or in:out:cache',
  'settings.str.stepTokenComboHint': 'Tokens: context, in/new, out, cache, think, reply, total — separated by : or / (1–4 items)',
  'settings.str.stepsColsLabel': '"Steps" Visible Columns (Left → Right, min 2, draggable)',
  'settings.str.addStepCol': 'Add Column ({count}/{max})',
  'settings.slot.dragHint': 'Drag up or down to reorder',
  'settings.slot.moveUp': 'Move earlier',
  'settings.slot.moveDown': 'Move later',
  'settings.slot.remove': 'Remove item',
  'settings.slot.minReached': 'Keep at least {min}',
  'settings.slot.alreadyAdded': 'Added',
  'settings.mock.sessionTitle': 'Refactor Auth Middleware & Session Cache',
  'settings.mock.subRole': 'API Audit',
  'settings.mock.turnPromptLatest': 'Fix token refresh race condition under concurrent requests and add tests',
  'settings.mock.turnPromptPrev': 'Audit route guards and expired session cleanup logic',

  // Preferences -> Other Tab
  'settings.oth.modelTitle': 'Model Identity Display',
  'settings.oth.modelFormat': 'Model Name Format',
  'settings.oth.modelShort': 'Short Alias (e.g. argon-4-high)',
  'settings.oth.modelUpstream': 'Raw Upstream ID (e.g. gemini-3.8-flash-n)',
  'settings.oth.modelUpstreamCompact': 'Trimmed Raw ID (hide gemini- / claude- / gpt-)',
  'settings.oth.orchFormat': 'Orchestrator Series ID',
  'settings.oth.orchCompact': 'Compact Alias (e.g. orchestrator-argon)',
  'settings.oth.orchFull': 'Full Upstream ID (e.g. gemini-pro-orchestrator)',
  'settings.oth.baselineTitle': 'Model Context Settings',
  'settings.oth.ctxRiskTitle': 'Unofficial Override Risk Warning',
  'settings.oth.ctxRiskBody': 'Google has not authorized modifying model context limits in Antigravity App / IDE. Altering context limits may get your Antigravity access, GCP services, or Google account disabled or banned; enabling this feature means you assume all associated risks. Make sure you know what you are doing!',
  'settings.oth.ctxRiskAcceptBtn': 'I Understand the Risk, Unlock',
  'settings.oth.ctxModel': 'Model',
  'settings.oth.ctxBaselineLabel': 'Context Window Limit',
  'settings.oth.ctxChooseModel': 'Choose a model',
  'settings.oth.ctxDefault': 'Follow host settings',
  'settings.oth.ctxExpensive': '{name} (uses more quota)',
  'settings.oth.ctxTokens': '{count} tokens',
  'settings.oth.ctxUnavailable': '{name} (currently unavailable)',
  'settings.oth.ctxConfigured': '{name} · Set',
  'settings.oth.ctxConfiguredReported': '{name} · Set / Last seen {reported}',
  'settings.oth.ctxPendingBridge': '{name} · Pending Restart',
  'settings.oth.ctxDefaultReported': 'Default · Last seen {name}',
  'settings.oth.ctxReported': 'The host reported {name} on the latest request.',
  'settings.oth.ctxMixed': 'Different limits by thinking level',
  'settings.oth.ctxMixedHint': 'Thinking levels for this model have different saved limits. Choose a limit to apply it to all levels.',
  'settings.oth.ctxBaselineHint': 'Thinking levels for the same model share a limit. Saved limits are reapplied at plugin startup and used for future messages.',
  'settings.oth.ctxNoModels': 'The host has not returned any available models.',
  'settings.oth.ctxNoOptions': 'The host has not provided context options or a capacity for this model. Follow host settings is the only available option.',
  'settings.oth.maintTitle': 'Cache & Reset',
  'settings.oth.cacheLabel': 'Local Trajectory Cache',
  'settings.oth.cacheDesc': 'Clear cached step records and rescan all conversation transcripts immediately',
  'settings.oth.rebuildBtn': 'Rebuild Trajectory Cache',
  'settings.oth.rebuildingBtn': 'Rebuilding…',
  'settings.oth.rebuildDone': 'Trajectory cache rebuilt',
  'settings.oth.rebuildFailed': 'Failed to rebuild cache',
  'settings.oth.resetLabel': 'Factory Defaults',
  'settings.oth.resetDesc': 'Restore all preferences across General, Structure, and Other tabs to default values',
  'settings.oth.resetAllBtn': 'Reset All Defaults',
  'settings.oth.resetConfirmBtn': 'Click Again to Confirm',
  'settings.oth.resettingBtn': 'Resetting…',
  'settings.oth.resetAllDone': 'All preferences restored to defaults',

  // Structured Live Activity Actions
  'live.act.run_command': 'Run Command',
  'live.act.read_file': 'Read File',
  'live.act.edit_file': 'Edit File',
  'live.act.write_file': 'Write File',
  'live.act.grep_search': 'Search Code',
  'live.act.find_file': 'Find Files',
  'live.act.read_url': 'Read Web Page',
  'live.act.search_web': 'Search Web',
  'live.act.invoke_subagent': 'Invoke Subagent',
  'live.act.send_message': 'Message Subagent',
  'live.act.manage_subagents': 'Manage Subagents',
  'live.act.swarm_add': 'Spawn Worker',
  'live.act.swarm_title': 'Name Swarm',
  'live.act.swarm_kill': 'Kill Worker',
  'live.act.swarm_model': 'Switch Worker Model',
  'live.act.swarm_channel': 'Swarm Channel',
  'live.act.swarm_status': 'Check Swarm',
  'live.act.post_message': 'Post to Board',
  'live.act.read_board': 'Read Board',
  'live.act.swarm_wait': 'Parked on Board',
  'live.act.manage_task': 'Manage Task',
  'live.act.schedule': 'Schedule Task',
  'live.act.ask_question': 'Waiting for User Choice',
  'live.act.search_marketplace': 'Search Plugins',
  'live.act.mcp_tool': 'Call MCP Tool',
  'live.act.tool_call': 'Call Tool',
  'live.act.thinking': 'Thinking',
  'live.act.compacting': 'Compacting Context',
  'live.act.responding': 'Responding',
  'live.act.waiting_subagent': 'Waiting for Subagent',
  'live.act.waiting_swarm': 'Waiting for Swarm',
  'live.act.swarm_waiting': 'Waiting',
  'live.act.swarm_killed': 'Killed',
  'live.act.starting': 'Starting',
  'live.act.done': 'Completed',
  'live.act.awaitingApproval': 'Awaiting Approval · {label}',
  'live.act.compactionResuming': 'Compaction finished, resuming reasoning',

  // SVG Charts (SessionStepCharts & TrendAreaChart)
  'chart.step.empty': 'No plottable steps in current scope',
  'chart.step.excluded': 'Excluded',
  'chart.step.zeroSteps': '0 steps',
  'chart.step.stepAdd': 'Step +{tokens}',
  'chart.step.ioSplit': 'In {inTok} · Cache {cacheTok} · Out {outTok}',
  'chart.step.cacheShort': 'Cache {pct}%',
  'chart.step.compactionCheckpoint': 'Auto-compaction checkpoint',
  'chart.step.cacheHitOut': 'Cache hit {pct}% · Out +{outTok}',
  'chart.step.ttftShort': 'TTFT {sec}s',
  'chart.step.outAndCtx': 'Out {outTok} · Context {ctxTok}',
  'chart.step.compactionStep': 'Compaction step',
  'chart.step.noSpeedSample': 'No speed sample',
  'chart.step.ctxAndCache': 'Context {ctxTok} · Cache {pct}%',
  'chart.step.noTtftSample': 'No TTFT sample',
  'chart.step.cumCost': 'Total {cost}',
  'chart.step.cacheAndStepTok': 'Cache {pct}% · Step {tokens}',
  'chart.step.noSamples': 'No samples',
  'chart.step.peakShort': 'Peak {val}',
  'chart.step.peakPill': 'Peak {tag} · {val}',
  'chart.step.stepsCount': '{count} steps',
  'chart.step.multiPrefix': '{count} models · ',
  'chart.step.sumTokens': '{prefix}Total {tokens}',
  'chart.step.peakTokens': '{prefix}Peak {tokens}',
  'chart.step.currentCtx': 'Current {tokens}',
  'chart.step.meanTps': '{prefix}Avg {val} tok/s',
  'chart.step.meanSec': '{prefix}Avg {val}s',
  'chart.step.noValidSamples': 'No valid samples',
  'chart.step.sumCost': '{prefix}Total {cost}',
  'chart.fit.empty': 'No valid regression samples for this model',
  'chart.fit.loess': 'LOESS Fit',
  'chart.fit.olsLinear': 'OLS Linear',
  'chart.fit.olsReg': 'OLS Reg',
  'chart.fit.observed': 'Observed',
  'chart.fit.tipFit': 'Fit {val}',
  'chart.fit.tipObs': 'Obs {val}',
  'chart.fit.zeroSamples': '0 samples',
  'chart.fit.peerMean': '{label} Avg {val}',
  'chart.fit.peerCompare': 'Compare: {peers}',
  'chart.fit.curvesCount': '{count} fit curves',
  'chart.fit.multiBadge': '{steps} steps · {models} models',
  'chart.fit.singleBadge': '{steps} steps · Avg {mean}',
  'chart.fit.olsTitle': 'OLS: y = {slope}x + {intercept} · Sample SD = ±{sd}',
  'chart.trend.hmMonthYear': "{month}/{yy}",
  'chart.trend.hmMonthOnly': 'M{month}',
  'chart.trend.wdayMon': 'M',
  'chart.trend.wdayWed': 'W',
  'chart.trend.wdayFri': 'F',
  'chart.trend.wdaySun': 'S',
  'chart.trend.hmAria': 'Daily usage heatmap',
  'chart.trend.hmLess': 'Less',
  'chart.trend.hmMore': 'More',
  'chart.trend.hmActivePeak': 'Active {active}/{total}d · Peak {label} · {tokens}',
  'chart.trend.hmActiveZero': 'Active 0/{total}d',
  'chart.trend.peakPill': 'Peak {label} · {tokens}',
});
return { I18N_MESSAGES_EN_US };
})();

// --- src/i18n/index.js ---
const { I18N_DICTIONARIES, normalizeI18nLanguage, detectHostSystemLocale, i18nStore, setI18nLanguage, getEffectiveLocale, isEnglishLocale, t } = (() => {
/**
 * @fileoverview Reactive lightweight i18n engine (`zh-CN` / `en-US` / `auto`).
 * Default language is `'zh-CN'` so out-of-the-box UI matches existing behavior 100%.
 */


const I18N_DICTIONARIES = Object.freeze({
  'zh-CN': I18N_MESSAGES_ZH_CN,
  'en-US': I18N_MESSAGES_EN_US,
});

function normalizeI18nLanguage(raw) {
  return normalizeLanguageSetting(raw);
}

function detectHostSystemLocale() {
  try {
    if (typeof navigator !== 'undefined' && navigator.language) {
      return String(navigator.language).toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
    }
  } catch {
    // Ignore environment navigator read errors
  }
  return 'zh-CN';
}

const i18nStore = createReactiveStore({
  language: 'zh-CN',
  locale: 'zh-CN',
});

function setI18nLanguage(rawLang) {
  const language = normalizeI18nLanguage(rawLang);
  const locale = language === 'auto' ? detectHostSystemLocale() : language;
  const cur = i18nStore.getState();
  if (cur.language !== language || cur.locale !== locale) {
    i18nStore.setState({ language, locale });
  }
  return locale;
}

function getEffectiveLocale() {
  return i18nStore.getState().locale || 'zh-CN';
}

function isEnglishLocale() {
  return getEffectiveLocale() === 'en-US';
}

/**
 * Translate a message key with optional `{name}` variable interpolation.
 *
 * @param {string} key
 * @param {Record<string, string | number>} [vars]
 * @returns {string}
 */
function t(key, vars = undefined) {
  const locale = getEffectiveLocale();
  const dict = I18N_DICTIONARIES[locale] || I18N_MESSAGES_ZH_CN;
  const template = dict[key] ?? I18N_MESSAGES_ZH_CN[key] ?? key;
  if (!vars || typeof template !== 'string') return template;
  return template.replace(/\{(\w+)\}/g, (_, k) =>
    vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''
  );
}
return { I18N_DICTIONARIES, normalizeI18nLanguage, detectHostSystemLocale, i18nStore, setI18nLanguage, getEffectiveLocale, isEnglishLocale, t };
})();

// --- src/core/appearance.js ---
const { THEME_ACCENT_PRESETS, FONT_SCALE_FACTORS, PANEL_SCALE_FACTORS, normalizeClientThemeAccent, normalizeClientFontScale, normalizeClientModernUi, isModernUiActiveForElement, parseCssColorLuminance, detectHostColorScheme, applyAppearanceToRoot } = (() => {
/**
 * @fileoverview Theme accent palette & panel font-scale appearance engine.
 * Applies CSS custom properties cleanly to Sidebar `:root` and Shadow DOM hosts,
 * while strictly isolating `#ag-usage-monitor-capsule` from font scaling.
 */

const THEME_ACCENT_PRESETS = Object.freeze([
  { key: 'host', labelKey: 'settings.gen.accentHost', cssColor: '' },
  { key: 'blue', labelKey: 'settings.gen.accentBlue', cssColor: 'hsl(217 84% 53%)' },
  { key: 'emerald', labelKey: 'settings.gen.accentEmerald', cssColor: 'hsl(152 66% 39%)' },
  { key: 'amber', labelKey: 'settings.gen.accentAmber', cssColor: 'hsl(34 88% 46%)' },
  { key: 'violet', labelKey: 'settings.gen.accentViolet', cssColor: 'hsl(262 76% 58%)' },
  { key: 'cyan', labelKey: 'settings.gen.accentCyan', cssColor: 'hsl(191 82% 41%)' },
  { key: 'rose', labelKey: 'settings.gen.accentRose', cssColor: 'hsl(346 78% 54%)' },
]);

const FONT_SCALE_FACTORS = Object.freeze({
  sm: 0.92,
  md: 1,
  lg: 1.14,
  xl: 1.28,
});

const PANEL_SCALE_FACTORS = Object.freeze({
  sm: 1,
  md: 1,
  lg: 1.09,
  xl: 1.18,
});

function normalizeClientThemeAccent(raw) {
  const val = String(raw ?? '').trim().toLowerCase();
  return THEME_ACCENT_PRESETS.some((p) => p.key === val) ? val : 'host';
}

function normalizeClientFontScale(raw) {
  const val = String(raw ?? '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(FONT_SCALE_FACTORS, val) ? val : 'md';
}

function normalizeClientModernUi(raw) {
  if (typeof raw === 'string') {
    const lower = raw.trim().toLowerCase();
    return lower === 'true' || lower === '1' || lower === 'on';
  }
  return Boolean(raw);
}

/**
 * Check whether `el` (or its Shadow DOM host / document root) is currently under `[data-modern-ui="true"]`.
 *
 * @param {Node | null | undefined} el
 * @returns {boolean}
 */
function isModernUiActiveForElement(el) {
  let cur = el || null;
  while (cur) {
    if (typeof cur.getAttribute === 'function' && cur.getAttribute('data-modern-ui') === 'true') {
      return true;
    }
    if (cur.parentNode) {
      cur = cur.parentNode;
    } else if (cur.host) {
      cur = cur.host;
    } else {
      break;
    }
  }
  if (typeof document !== 'undefined' && document.documentElement) {
    return document.documentElement.getAttribute?.('data-modern-ui') === 'true';
  }
  return false;
}

const LIGHT_THEME_CLASSES = new Set([
  'light',
  'vs-light',
  'vscode-light',
  'hc-light',
  'vscode-high-contrast-light',
]);

const DARK_THEME_CLASSES = new Set([
  'dark',
  'vs-dark',
  'vscode-dark',
  'hc-black',
  'vscode-high-contrast',
]);

function hslToRgb(hDeg, sPct, lPct) {
  const h = (((hDeg % 360) + 360) % 360) / 360;
  const s = Math.max(0, Math.min(1, sPct / 100));
  const l = Math.max(0, Math.min(1, lPct / 100));
  if (s === 0) {
    const v = l * 255;
    return [v, v, v];
  }
  const hue2rgb = (p, q, t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    hue2rgb(p, q, h + 1 / 3) * 255,
    hue2rgb(p, q, h) * 255,
    hue2rgb(p, q, h - 1 / 3) * 255,
  ];
}

function parseAlphaToken(rawAlpha) {
  if (rawAlpha == null || rawAlpha === '') return 1;
  const str = String(rawAlpha).trim();
  if (!str) return 1;
  if (str.endsWith('%')) {
    const pct = parseFloat(str);
    return Number.isFinite(pct) ? pct / 100 : 1;
  }
  const num = parseFloat(str);
  return Number.isFinite(num) ? num : 1;
}

/**
 * Parse `#hex`, `rgb()/rgba()`, or `hsl()/hsla()` into perceptual luminance `[0, 1]`.
 * Returns `null` when transparent (`alpha <= 0.15`) or unparseable.
 *
 * @param {string | null | undefined} rawColor
 * @returns {number | null}
 */
function parseCssColorLuminance(rawColor) {
  const str = String(rawColor ?? '').trim().toLowerCase();
  if (!str || str === 'transparent' || str === 'none' || str === 'inherit' || str === 'initial') {
    return null;
  }

  if (str.startsWith('#')) {
    const hex = str.slice(1);
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 1;
    if (hex.length === 3 || hex.length === 4) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
      if (hex.length === 4) a = parseInt(hex[3] + hex[3], 16) / 255;
    } else if (hex.length === 6 || hex.length === 8) {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
      if (hex.length === 8) a = parseInt(hex.slice(6, 8), 16) / 255;
    } else {
      return null;
    }
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || a <= 0.15) {
      return null;
    }
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  const rgbMatch = str.match(/^rgba?\(([^)]+)\)$/);
  if (rgbMatch) {
    const body = rgbMatch[1].trim();
    const [channelsPart, slashAlpha] = body.split('/');
    const parts = channelsPart
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean);
    if (parts.length < 3) return null;
    const parseChan = (tok) =>
      tok.endsWith('%') ? (parseFloat(tok) / 100) * 255 : parseFloat(tok);
    const r = parseChan(parts[0]);
    const g = parseChan(parts[1]);
    const b = parseChan(parts[2]);
    const a = slashAlpha !== undefined ? parseAlphaToken(slashAlpha) : parseAlphaToken(parts[3]);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || a <= 0.15) {
      return null;
    }
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  const hslMatch = str.match(/^hsla?\(([^)]+)\)$/);
  if (hslMatch) {
    const body = hslMatch[1].trim();
    const [channelsPart, slashAlpha] = body.split('/');
    const parts = channelsPart
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean);
    if (parts.length < 3) return null;
    const h = parseFloat(parts[0]);
    const s = parseFloat(parts[1]);
    const l = parseFloat(parts[2]);
    const a = slashAlpha !== undefined ? parseAlphaToken(slashAlpha) : parseAlphaToken(parts[3]);
    if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(l) || a <= 0.15) {
      return null;
    }
    const [r, g, b] = hslToRgb(h, s, l);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  return null;
}

function readStyleProp(el, cs, prop) {
  if (prop.startsWith('--')) {
    const inlineVal =
      typeof el?.style?.getPropertyValue === 'function'
        ? el.style.getPropertyValue(prop)
        : el?.style?.[prop];
    if (inlineVal && String(inlineVal).trim()) return String(inlineVal).trim();
    const compVal = cs?.getPropertyValue?.(prop);
    return compVal ? String(compVal).trim() : '';
  }
  const inlineVal = el?.style?.[prop];
  if (inlineVal && String(inlineVal).trim()) return String(inlineVal).trim();
  const compVal = cs?.[prop];
  return compVal ? String(compVal).trim() : '';
}

/**
 * Detect whether the active host surface is `'light'` or `'dark'`.
 * Inspects explicit Antigravity / VS Code theme classes & attributes first,
 * then actual computed surface/text luminance, then `prefers-color-scheme`.
 *
 * @param {HTMLElement | null | undefined} [targetEl]
 * @returns {'light' | 'dark'}
 */
function detectHostColorScheme(targetEl = null) {
  const doc = typeof document !== 'undefined' ? document : null;
  const win = typeof window !== 'undefined' ? window : null;
  let workbenchEl = null;
  try {
    workbenchEl =
      typeof doc?.querySelector === 'function' ? doc.querySelector('.monaco-workbench') : null;
  } catch {
    workbenchEl = null;
  }

  const candidates = [];
  for (const el of [doc?.body, doc?.documentElement, workbenchEl, targetEl]) {
    if (el && !candidates.includes(el)) {
      candidates.push(el);
    }
  }

  // 1. Explicit host theme attributes & class tokens (never read our own data-color-scheme)
  for (const el of candidates) {
    const vscodeKind = String(el.getAttribute?.('data-vscode-theme-kind') || '')
      .trim()
      .toLowerCase();
    if (vscodeKind) {
      if (vscodeKind.includes('light')) return 'light';
      if (vscodeKind.includes('dark') || vscodeKind.includes('high-contrast')) return 'dark';
    }
    const dataTheme = String(
      el.getAttribute?.('data-theme') || el.getAttribute?.('data-color-mode') || ''
    )
      .trim()
      .toLowerCase();
    if (dataTheme === 'light' || dataTheme.endsWith('-light')) return 'light';
    if (dataTheme === 'dark' || dataTheme.endsWith('-dark')) return 'dark';

    const rawCls = typeof el.className === 'string' ? el.className : '';
    if (rawCls) {
      const tokens = rawCls.trim().toLowerCase().split(/\s+/);
      for (const tok of tokens) {
        if (LIGHT_THEME_CLASSES.has(tok)) return 'light';
        if (DARK_THEME_CLASSES.has(tok)) return 'dark';
      }
    }
  }

  // 2. Computed / inline surface background luminance
  const bgTargets = [];
  for (const el of [targetEl, doc?.body, doc?.documentElement, workbenchEl]) {
    if (el && !bgTargets.includes(el)) {
      bgTargets.push(el);
    }
  }
  const bgProps = [
    '--background',
    '--card',
    '--vscode-sideBar-background',
    '--vscode-editor-background',
    'backgroundColor',
  ];
  for (const el of bgTargets) {
    let cs = null;
    try {
      cs = typeof win?.getComputedStyle === 'function' ? win.getComputedStyle(el) : null;
    } catch {
      cs = null;
    }
    for (const prop of bgProps) {
      const lum = parseCssColorLuminance(readStyleProp(el, cs, prop));
      if (lum !== null) {
        return lum > 0.52 ? 'light' : 'dark';
      }
    }
  }

  // 3. Computed / inline foreground text luminance
  const fgProps = ['--foreground', '--vscode-foreground', '--vscode-editor-foreground', 'color'];
  for (const el of bgTargets) {
    let cs = null;
    try {
      cs = typeof win?.getComputedStyle === 'function' ? win.getComputedStyle(el) : null;
    } catch {
      cs = null;
    }
    for (const prop of fgProps) {
      const lum = parseCssColorLuminance(readStyleProp(el, cs, prop));
      if (lum !== null) {
        return lum < 0.48 ? 'light' : 'dark';
      }
    }
  }

  // 4. OS media query fallback
  try {
    if (win?.matchMedia?.('(prefers-color-scheme: dark)')?.matches) {
      return 'dark';
    }
  } catch {
    // ignore matchMedia errors
  }

  return 'light';
}

function setAttrIfChanged(el, name, value) {
  if (!el || typeof el.setAttribute !== 'function') return;
  if (typeof el.getAttribute === 'function' && el.getAttribute(name) === value) return;
  el.setAttribute(name, value);
}

function removeAttrIfPresent(el, name) {
  if (!el || typeof el.removeAttribute !== 'function') return;
  if (typeof el.hasAttribute === 'function' && !el.hasAttribute(name)) return;
  el.removeAttribute(name);
}

function setOrClearStyleVar(el, propName, value) {
  if (!el || !el.style) return;
  const cur =
    typeof el.style.getPropertyValue === 'function'
      ? el.style.getPropertyValue(propName)
      : el.style[propName] || '';
  if (value) {
    if (cur === value) return;
    if (typeof el.style.setProperty === 'function') {
      el.style.setProperty(propName, value);
    } else {
      el.style[propName] = value;
    }
  } else if (cur) {
    if (typeof el.style.removeProperty === 'function') {
      el.style.removeProperty(propName);
    } else if (typeof el.style.setProperty === 'function') {
      el.style.setProperty(propName, '');
    } else {
      el.style[propName] = '';
    }
  }
}

/**
 * Synchronize theme accent, host color scheme polarity, and (optionally) font scale tokens
 * onto a root/host element.
 *
 * @param {HTMLElement | null | undefined} targetEl
 * @param {object | null | undefined} settings
 * @param {{ includeFontScale?: boolean }} [options]
 */
function applyAppearanceToRoot(targetEl, settings, { includeFontScale = true } = {}) {
  if (!targetEl || !targetEl.style) return;
  const accentKey = normalizeClientThemeAccent(settings?.themeAccent);
  const preset = THEME_ACCENT_PRESETS.find((p) => p.key === accentKey) || THEME_ACCENT_PRESETS[0];

  if (preset.key !== 'host' && preset.cssColor) {
    setOrClearStyleVar(targetEl, '--user-accent-primary', preset.cssColor);
    setOrClearStyleVar(targetEl, '--user-accent-contrast', '#ffffff');
  } else {
    setOrClearStyleVar(targetEl, '--user-accent-primary', '');
    setOrClearStyleVar(targetEl, '--user-accent-contrast', '');
  }
  setAttrIfChanged(targetEl, 'data-accent', preset.key);

  const colorScheme = detectHostColorScheme(targetEl);
  setAttrIfChanged(targetEl, 'data-color-scheme', colorScheme);

  const isModernUi = normalizeClientModernUi(settings?.experimentalModernUi);
  if (isModernUi) {
    setAttrIfChanged(targetEl, 'data-modern-ui', 'true');
  } else {
    removeAttrIfPresent(targetEl, 'data-modern-ui');
  }

  if (includeFontScale) {
    const scaleKey = normalizeClientFontScale(settings?.fontScale);
    const factor = FONT_SCALE_FACTORS[scaleKey] ?? 1;
    const panelFactor = PANEL_SCALE_FACTORS[scaleKey] ?? 1;
    setOrClearStyleVar(targetEl, '--ui-font-scale', factor === 1 ? '' : String(factor));
    setOrClearStyleVar(targetEl, '--ui-panel-scale', panelFactor === 1 ? '' : String(panelFactor));
    setAttrIfChanged(targetEl, 'data-font-scale', scaleKey);
  } else {
    setOrClearStyleVar(targetEl, '--ui-font-scale', '');
    setOrClearStyleVar(targetEl, '--ui-panel-scale', '');
    removeAttrIfPresent(targetEl, 'data-font-scale');
  }
}
return { THEME_ACCENT_PRESETS, FONT_SCALE_FACTORS, PANEL_SCALE_FACTORS, normalizeClientThemeAccent, normalizeClientFontScale, normalizeClientModernUi, isModernUiActiveForElement, parseCssColorLuminance, detectHostColorScheme, applyAppearanceToRoot };
})();

// --- src/core/domPatch.js ---
const { h, patchText, patchAttr, patchClasses, patchStyleVar, isEventInside, patchKeyedList, positionAnchoredPopup } = (() => {
/**
 * @fileoverview Incremental DOM patching utilities and keyed list reconciler.
 * Prevents full innerHTML replacements and preserves active DOM element state.
 */

function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, val] of Object.entries(props)) {
      if (val === undefined || val === null || val === false) continue;
      if (key === 'className' || key === 'class') {
        el.className = String(val);
      } else if (key === 'dataset' && typeof val === 'object') {
        for (const [dk, dv] of Object.entries(val)) {
          if (dv !== undefined && dv !== null) {
            el.dataset[dk] = String(dv);
          }
        }
      } else if (key.startsWith('on') && typeof val === 'function') {
        const evt = key.slice(2).toLowerCase();
        el.addEventListener(evt, val);
      } else if (key === 'text') {
        el.textContent = String(val);
      } else if (val === true) {
        el.setAttribute(key, '');
      } else {
        el.setAttribute(key, String(val));
      }
    }
  }
  const childArray = Array.isArray(children) ? children : [children];
  for (const child of childArray) {
    if (child === null || child === undefined || child === false) continue;
    if (typeof child === 'string' || typeof child === 'number') {
      el.appendChild(document.createTextNode(String(child)));
    } else {
      el.appendChild(child);
    }
  }
  return el;
}

function patchText(el, nextValue) {
  if (!el) return false;
  const nextStr = String(nextValue ?? '');
  if (el.textContent === nextStr) {
    return false;
  }
  el.textContent = nextStr;
  return true;
}

function patchAttr(el, attrName, nextValue) {
  if (!el) return false;
  if (nextValue === null || nextValue === undefined || nextValue === false) {
    let mutated = false;
    if (el.hasAttribute(attrName)) {
      el.removeAttribute(attrName);
      mutated = true;
    }
    if (attrName === 'value' && 'value' in el && el.value !== '') {
      el.value = '';
      mutated = true;
    }
    return mutated;
  }
  const strVal = nextValue === true ? '' : String(nextValue);
  let mutated = false;
  if (el.getAttribute(attrName) !== strVal) {
    el.setAttribute(attrName, strVal);
    mutated = true;
  }
  if (attrName === 'value' && 'value' in el && el.value !== strVal) {
    el.value = strVal;
    mutated = true;
  }
  return mutated;
}

function patchClasses(el, classMap) {
  if (!el || !classMap) return false;
  let mutated = false;
  for (const [cls, active] of Object.entries(classMap)) {
    if (!cls) continue;
    const shouldHave = Boolean(active);
    const tokens = String(cls).split(/\s+/).filter(Boolean);
    for (const tok of tokens) {
      const has = el.classList.contains(tok);
      if (has !== shouldHave) {
        el.classList.toggle(tok, shouldHave);
        mutated = true;
      }
    }
  }
  return mutated;
}

function patchStyleVar(el, varName, nextValue) {
  if (!el) return false;
  const strVal = String(nextValue ?? '');
  const prev = el.style.getPropertyValue(varName);
  if (prev === strVal) {
    return false;
  }
  el.style.setProperty(varName, strVal);
  return true;
}

/**
 * 判断事件是否发生在目标节点内部（兼容 Shadow DOM 的 `composedPath()` 穿透）。
 *
 * @param {Event|null|undefined} event
 * @param {Node|null|undefined} element
 * @returns {boolean}
 */
function isEventInside(event, element) {
  if (!event || !element) return false;
  if (typeof event.composedPath === 'function') {
    const path = event.composedPath();
    if (Array.isArray(path) && path.includes(element)) {
      return true;
    }
  }
  const target = event.target;
  return Boolean(target && typeof element.contains === 'function' && element.contains(target));
}

const keyedListState = new WeakMap();

/**
 * Keyed incremental list reconciler.
 * Reuses existing DOM nodes by key and patches only changed items in-place.
 */
function patchKeyedList(
  container,
  items,
  { keyFn = (_, i) => i, sigFn, createRow, updateRow, destroyRow } = {}
) {
  if (!container) return;
  let map = keyedListState.get(container);
  if (!map) {
    map = new Map();
    keyedListState.set(container, map);
  }

  const nextKeys = new Set();
  const seenInPass = new Map();
  const orderedNodes = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const rawKey = String(keyFn(item, i));
    const dupIdx = seenInPass.get(rawKey) || 0;
    seenInPass.set(rawKey, dupIdx + 1);
    const key = dupIdx === 0 ? rawKey : `${rawKey}__dup_${dupIdx}`;
    const sig = sigFn ? String(sigFn(item, i)) : JSON.stringify(item);
    nextKeys.add(key);

    let record = map.get(key);
    if (!record) {
      const created = createRow(item, i);
      record = {
        el: created.el,
        refs: created.refs,
        sig,
      };
      updateRow(record.refs, item, i, record.el);
      map.set(key, record);
    } else if (record.sig !== sig) {
      record.sig = sig;
      updateRow(record.refs, item, i, record.el);
    }
    orderedNodes.push(record.el);
  }

  // Remove stale keys
  for (const [oldKey, record] of map.entries()) {
    if (!nextKeys.has(oldKey)) {
      if (record.el.parentNode === container) {
        container.removeChild(record.el);
      }
      destroyRow?.(record.refs, record.el);
      map.delete(oldKey);
    }
  }

  if (!container.firstChild && orderedNodes.length > 1 && typeof document.createDocumentFragment === 'function') {
    const fragment = document.createDocumentFragment();
    for (const node of orderedNodes) {
      fragment.appendChild(node);
    }
    container.appendChild(fragment);
    return;
  }

  // Reorder or insert nodes with minimal DOM moves
  for (let i = 0; i < orderedNodes.length; i++) {
    const targetNode = orderedNodes[i];
    const currentNode = container.children[i] || null;
    if (currentNode !== targetNode) {
      container.insertBefore(targetNode, currentNode);
    }
  }
}

const CLIPPING_OVERFLOW_RE = /(?:hidden|clip|auto|scroll)/i;

/**
 * 解析浮层所在的可视裁剪边界（兼容 Shadow DOM 悬浮窗 `.wm-popover-panel`、
 * 侧栏 `.app-shell`、自定义滚动容器 `.custom-scroll-content` 与窗口视口）。
 *
 * @param {HTMLElement} anchorRootEl
 * @returns {{ left: number, top: number, right: number, bottom: number, width: number, height: number } | null}
 */
function resolvePopupBoundaryRect(anchorRootEl) {
  if (!anchorRootEl) return null;
  const winW = typeof window !== 'undefined' ? Number(window.innerWidth || 0) : 0;
  const winH = typeof window !== 'undefined' ? Number(window.innerHeight || 0) : 0;
  let boundLeft = 0;
  let boundTop = 0;
  let boundRight = winW > 0 ? winW : Infinity;
  let boundBottom = winH > 0 ? winH : Infinity;
  let hasBoundary = winW > 0 && winH > 0;

  const getStyle =
    typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
      ? window.getComputedStyle
      : null;

  let cur = anchorRootEl.parentNode || null;
  while (cur) {
    if (cur.nodeType === 1 || typeof cur.getBoundingClientRect === 'function') {
      const cls = cur.classList;
      const isShell = Boolean(
        cls?.contains?.('wm-popover-panel') ||
          cls?.contains?.('wm-multi-panel') ||
          cls?.contains?.('app-shell') ||
          cls?.contains?.('custom-scroll-host') ||
          cls?.contains?.('custom-scroll-content')
      );
      let clipsX = isShell;
      let clipsY = isShell;
      if (!isShell && getStyle) {
        try {
          const cs = getStyle(cur);
          if (cs) {
            clipsX = CLIPPING_OVERFLOW_RE.test(cs.overflowX || cs.overflow || '');
            clipsY = CLIPPING_OVERFLOW_RE.test(cs.overflowY || cs.overflow || '');
          }
        } catch {
          // 忽略 Mock DOM 样式查询异常
        }
      }
      if (clipsX || clipsY) {
        const r = cur.getBoundingClientRect?.();
        if (r && r.width > 0 && r.height > 0) {
          hasBoundary = true;
          if (clipsX) {
            boundLeft = Math.max(boundLeft, r.left);
            boundRight = Math.min(boundRight, r.right);
          }
          if (clipsY) {
            boundTop = Math.max(boundTop, r.top);
            boundBottom = Math.min(boundBottom, r.bottom);
          }
        }
      }
    }
    // 到达 ShadowRoot 或文档顶层后停止，避免误受宿主页面外层容器干扰
    if (!cur.parentNode) break;
    cur = cur.parentNode;
  }

  if (!hasBoundary || !Number.isFinite(boundRight) || !Number.isFinite(boundBottom)) {
    return null;
  }
  const width = Math.max(0, boundRight - boundLeft);
  const height = Math.max(0, boundBottom - boundTop);
  if (width <= 0 || height <= 0) return null;
  return { left: boundLeft, top: boundTop, right: boundRight, bottom: boundBottom, width, height };
}

/**
 * 为锚定在触发器上的绝对定位下拉浮层执行水平/垂直碰撞检测与边界夹紧：
 * - 水平方向优先左对齐，右侧溢出时切右对齐，仍越界则直接夹紧在容器可视安全区内；
 * - 垂直方向底部空间不足且上方更宽裕时自动向上翻转（追加 `.is-above`），并按可用空间收紧 `max-height`。
 *
 * @param {HTMLElement} rootEl 定位基准容器 (`position: relative`)
 * @param {HTMLElement} triggerEl 触发按钮
 * @param {HTMLElement} popupEl 下拉浮层 (`position: absolute`)
 * @param {{ margin?: number, gap?: number, maxHeight?: number, minFlipSpace?: number }} [opts]
 */
function positionAnchoredPopup(
  rootEl,
  triggerEl,
  popupEl,
  { margin = 6, gap = 4, maxHeight = 220, minFlipSpace = 140 } = {}
) {
  if (!rootEl || !triggerEl || !popupEl || !popupEl.style) return;
  if (popupEl.hasAttribute?.('hidden')) return;

  const rootRect = rootEl.getBoundingClientRect?.();
  const triggerRect = triggerEl.getBoundingClientRect?.();
  if (
    !rootRect ||
    !triggerRect ||
    !(triggerRect.width > 0 && triggerRect.height > 0)
  ) {
    return;
  }

  const bound = resolvePopupBoundaryRect(rootEl);
  if (!bound) return;

  // 清除旧的动态夹紧值以便读取自然布局宽度
  popupEl.style.left = '';
  popupEl.style.right = '';
  popupEl.style.top = '';
  popupEl.style.bottom = '';
  popupEl.style.minWidth = '';
  popupEl.style.maxWidth = '';
  popupEl.style.maxHeight = '';

  const availWidth = Math.max(120, Math.floor(bound.width - margin * 2));
  popupEl.style.maxWidth = `${availWidth}px`;

  const rawRect = popupEl.getBoundingClientRect?.();
  // 优先读取 offsetWidth，避免入场动画 scale(0.975) 导致测宽偏小
  const naturalW = Math.max(
    Number(popupEl.offsetWidth || 0),
    Math.ceil(Number(rawRect?.width || 0))
  );
  if (naturalW > availWidth) {
    popupEl.style.minWidth = '0px';
  }
  const popupW = Math.min(availWidth, naturalW > 0 ? naturalW : Math.max(triggerRect.width, 210));

  const safeLeft = bound.left + margin;
  const safeRight = bound.right - margin;
  const rawLeft = Number(rawRect?.left);
  const rawRight = Number(rawRect?.right);
  const hasRawBox = Number.isFinite(rawLeft) && Number.isFinite(rawRight) && rawRight > rawLeft;
  // 若入场缩放动画（如 scale(0.975)）正在首帧生效，按对称补偿还原终态边界再判断是否越界
  const scalePadX = hasRawBox ? Math.max(0, (popupW - (rawRight - rawLeft)) / 2) : 0;
  const naturalLeft = hasRawBox ? rawLeft - scalePadX : triggerRect.left;
  const naturalRight = hasRawBox
    ? Math.max(rawRight + scalePadX, naturalLeft + popupW)
    : naturalLeft + popupW;
  const fitsAsDefault = hasRawBox && naturalLeft >= safeLeft && naturalRight <= safeRight;

  if (!fitsAsDefault) {
    let targetLeft = triggerRect.left;
    if (targetLeft + popupW > safeRight) {
      const rightAlignedLeft = triggerRect.right - popupW;
      if (rightAlignedLeft >= safeLeft) {
        targetLeft = rightAlignedLeft;
      } else {
        targetLeft = Math.max(safeLeft, safeRight - popupW);
      }
    }
    if (targetLeft < safeLeft) {
      targetLeft = safeLeft;
    }

    const offsetLeft = Math.round(targetLeft - rootRect.left);
    popupEl.style.left = `${offsetLeft}px`;
    popupEl.style.right = 'auto';
  }

  const spaceBelow = Math.max(0, bound.bottom - triggerRect.bottom - gap - margin);
  const spaceAbove = Math.max(0, triggerRect.top - bound.top - gap - margin);
  const naturalH = Math.max(
    Number(popupEl.scrollHeight || 0),
    Number(popupEl.offsetHeight || 0),
    Math.ceil(Number(rawRect?.height || 0))
  );
  const desiredH = maxHeight > 0 ? Math.min(maxHeight, naturalH || maxHeight) : naturalH || 240;
  const shouldOpenAbove =
    spaceBelow < Math.min(desiredH, minFlipSpace) && spaceAbove > spaceBelow;

  patchClasses(popupEl, { 'is-above': shouldOpenAbove });
  if (shouldOpenAbove) {
    popupEl.style.top = 'auto';
    popupEl.style.bottom = `calc(100% + ${gap}px)`;
    if (maxHeight > 0) {
      popupEl.style.maxHeight = `${Math.max(88, Math.floor(Math.min(maxHeight, spaceAbove)))}px`;
    }
  } else {
    popupEl.style.top = `calc(100% + ${gap}px)`;
    popupEl.style.bottom = 'auto';
    if (maxHeight > 0) {
      popupEl.style.maxHeight = `${Math.max(88, Math.floor(Math.min(maxHeight, spaceBelow)))}px`;
    }
  }
}
return { h, patchText, patchAttr, patchClasses, patchStyleVar, isEventInside, patchKeyedList, positionAnchoredPopup };
})();

// --- src/core/component.js ---
const { defineComponent } = (() => {
/**
 * @fileoverview Vue-inspired lightweight component kernel supporting
 * props, custom v-model value transmission (emit('update:modelValue', val)),
 * reactive subscriptions, and lifecycle cleanup.
 */

function defineComponent({ name, setup }) {
  return function createInstance(initialProps = {}) {
    const props = { ...initialProps };
    const cleanups = [];

    function emit(event, payload) {
      // Support Vue-style onUpdateModelValue / onChange prop callbacks
      if (event === 'update:modelValue') {
        if (typeof props.onUpdateModelValue === 'function') {
          props.onUpdateModelValue(payload);
        }
        if (typeof props.onChange === 'function') {
          props.onChange(payload);
        }
      }
    }

    function onCleanup(fn) {
      if (typeof fn === 'function') {
        cleanups.push(fn);
      }
    }

    let setupResult = null;

    function setProps(nextProps = {}) {
      Object.assign(props, nextProps);
      if (setupResult && typeof setupResult.onPropsChange === 'function') {
        setupResult.onPropsChange(props);
      }
    }

    function setValue(nextValue) {
      setProps({ modelValue: nextValue });
    }

    setupResult = setup({
      props,
      getProps: () => props,
      setProps,
      emit,
      onCleanup,
    });

    function destroy() {
      for (const fn of cleanups.splice(0)) {
        try {
          fn();
        } catch (err) {
          console.error(`[${name}] cleanup error:`, err);
        }
      }
      if (setupResult.el?.parentNode) {
        setupResult.el.parentNode.removeChild(setupResult.el);
      }
    }

    return {
      name,
      el: setupResult.el,
      refs: setupResult.refs || {},
      setProps,
      setValue,
      destroy,
      ...setupResult.methods,
    };
  };
}
return { defineComponent };
})();

// --- src/core/formatters.js ---
const { formatMetric, formatSpeedMetric, formatCachePct, getSpeedToneClass, getCacheToneClass, getStepCostToneClass, getTtftToneClass, formatTokens, formatTokensPrecise, formatCnyApprox, formatDateSpanBadge, formatUsd, speedReasonText, formatAnomalyKindLabel, formatAnomalyTagText, resolveModelAnomalySummary, formatStepAnomalyInlineSummary, buildStepAnomalyDiagnostic, buildModelAnomalyDiagnostic, sampleSummary, formatCountdown, formatCompactDateTime, formatElapsedSec, stripVendorModelPrefix, normalizeOrchestratorIdDisplayMode, resolveModelDisplayInfo, mergeModelsByDisplayName, getAgentBadgeClass, formatAgentBadgeText, formatAgentLabel, formatConversationMeta, formatLiveActivityLabel, formatLiveActivityDetail, getCanonicalModelColorSeed, resolveDeterministicModelColor, buildDeterministicModelColorMap } = (() => {
/**
 * @fileoverview Pure formatting utilities for speed metrics, token counts,
 * USD estimates, countdown timers, and custom datetime displays.
 */


const EN_MONTH_SHORT = Object.freeze([
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]);

function formatMetric(value, unit = '') {
  if (!Number.isFinite(value)) return '—';
  const numStr = Math.abs(value) >= 100 ? String(Math.round(value)) : value.toFixed(1);
  return `${numStr}${unit}`;
}

function formatSpeedMetric(value, unit = ' tok/s') {
  return formatMetric(value, unit);
}

function formatCachePct(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const num = Math.max(0, Math.min(100, +Number(value).toFixed(1)));
  return `${num}%`;
}

function getSpeedToneClass(tokPerSec) {
  return `tone-${classifySpeedTier(tokPerSec)}`;
}

function getCacheToneClass(cacheHitPct, promptTokens = null) {
  return `tone-${classifyCacheTier(cacheHitPct, promptTokens)}`;
}

function getStepCostToneClass(costUsd) {
  const tier = classifyStepCostTier(costUsd);
  return tier ? `tone-${tier}` : '';
}

function getTtftToneClass(ttftSec) {
  const tier = classifyTtftTier(ttftSec);
  return tier === 'warn' || tier === 'danger' ? `tone-${tier}` : '';
}

const formatTokens = formatCompactTokens;

function formatTokensPrecise(num) {
  const n = Number(num || 0);
  if (n <= 0) return '0';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function formatCnyApprox(usdAmount, rate = 7.2) {
  const rmb = Number(usdAmount || 0) * rate;
  if (rmb <= 0) return '≈ ¥0';
  if (rmb >= 10) return `≈ ¥${Math.round(rmb)}`;
  return `≈ ¥${rmb.toFixed(1)}`;
}

function formatDateSpanBadge(startMs, endMs) {
  const s = startMs && Number.isFinite(startMs) ? new Date(startMs) : new Date();
  const e = endMs && Number.isFinite(endMs) ? new Date(endMs) : new Date();
  if (isEnglishLocale()) {
    const sMon = EN_MONTH_SHORT[s.getMonth()] || '';
    const eMon = EN_MONTH_SHORT[e.getMonth()] || '';
    if (s.getFullYear() !== e.getFullYear()) {
      return `${sMon} ${s.getDate()}, ${s.getFullYear()} ~ ${eMon} ${e.getDate()}, ${e.getFullYear()}`;
    }
    return `${sMon} ${s.getDate()} ~ ${eMon} ${e.getDate()}`;
  }
  if (s.getFullYear() !== e.getFullYear()) {
    return `${s.getFullYear()}年${s.getMonth() + 1}月${s.getDate()}日 ~ ${e.getFullYear()}年${e.getMonth() + 1}月${e.getDate()}日`;
  }
  return `${s.getMonth() + 1}月${s.getDate()}日 ~ ${e.getMonth() + 1}月${e.getDate()}日`;
}

function formatUsd(amount, { precise = false } = {}) {
  if (amount == null || !Number.isFinite(Number(amount))) return t('fmt.pending');
  const val = Number(amount || 0);
  if (precise) {
    if (val > 0 && val < 0.001) return '<$0.001';
    return val >= 1 ? `$${val.toFixed(2)}` : `$${val.toFixed(3)}`;
  }
  return `$${val.toFixed(2)}`;
}

const SPEED_REASON_LABELS = {
  __proto__: null,
  incomplete_or_invalid_timing: 'fmt.speedIncomplete',
  canceled: 'fmt.speedCanceled',
  error: 'fmt.speedError',
  interrupted: 'fmt.speedInterrupted',
  compaction_timing_unavailable: 'fmt.speedCompactionTimingUnavailable',
  invalid_output_tokens: 'fmt.speedInvalidOutput',
  inconsistent_timing: 'fmt.speedInconsistent',
  short_timing: 'fmt.speedShort',
  legacy_cache: 'fmt.speedLegacy',
};

function speedReasonText(reason) {
  const label = SPEED_REASON_LABELS[reason];
  return label ? t(label) : '';
}

const ANOMALY_KIND_ORDER = Object.freeze([
  'rate_limit',
  'timeout',
  'capacity',
  'disconnect',
  'upstream',
  'model_output',
  'safety',
  'auth_or_model',
  'error',
]);

function formatAnomalyKindLabel(kind) {
  const k = String(kind || 'error');
  const key = `steps.anomalyKind.${k}`;
  const text = t(key);
  return text === key ? t('steps.anomalyKind.error') : text;
}

function formatAnomalyTagText(primaryKind, count = 1) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  const k = String(primaryKind || 'error');
  if (k === 'capacity' && n === 1) return t('steps.anomalyTag.capacitySingle');
  if (k === 'upstream' && n === 1) return t('steps.anomalyTag.upstreamSingle');
  const key = `steps.anomalyTag.${k}`;
  const formatted = t(key, { n });
  return formatted === key ? t('steps.anomalyTag.error', { n }) : formatted;
}

function resolveModelAnomalySummary(m) {
  const count = Math.max(0, Number(m?.anomalyCount || 0));
  const steps = Math.max(0, Number(m?.anomalySteps || 0));
  if (count <= 0 && steps <= 0) return null;
  const byKind = m?.anomalyByKind && typeof m.anomalyByKind === 'object' ? m.anomalyByKind : {};
  const entries = Object.entries(byKind)
    .map(([k, v]) => [k, Math.max(0, Number(v || 0))])
    .filter(([, v]) => v > 0)
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const pa = ANOMALY_KIND_ORDER.indexOf(a[0]);
      const pb = ANOMALY_KIND_ORDER.indexOf(b[0]);
      return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb);
    });
  const totalCount = count || entries.reduce((sum, [, v]) => sum + v, 0) || steps;
  const primaryKind = entries.length === 1 ? entries[0][0] : entries.length > 1 ? 'mixed' : 'error';
  const severity =
    Number(m?.anomalyDangerCount || 0) > 0 ||
    entries.some(([k]) => k === 'rate_limit' || k === 'auth_or_model')
      ? 'danger'
      : 'warn';
  return {
    count: totalCount,
    steps: steps || totalCount,
    totalDelaySec: Math.max(0, Number(m?.anomalyTotalDelaySec || 0)),
    primaryKind,
    severity,
    entries,
    tagText: formatAnomalyTagText(primaryKind, totalCount),
  };
}

function formatStepAnomalyInlineSummary(anomaly) {
  if (!anomaly || !(Number(anomaly.count) > 0)) return '';
  const tag = formatAnomalyTagText(anomaly.primaryKind, anomaly.count);
  const label = formatAnomalyKindLabel(anomaly.primaryKind);
  const delaySec = Number(anomaly.totalDelaySec || 0);
  const delayPart = delaySec > 0 ? ` · ${t('steps.anomalyDelayPart', { sec: delaySec })}` : '';
  return `${tag} · ${label}${delayPart}`;
}

function buildStepAnomalyDiagnostic(st) {
  const a = st?.anomaly;
  if (!a || !(Number(a.count) > 0)) return null;
  const title = t('steps.anomalyStepTitle', {
    step: Number(st.stepIndex ?? 0),
    count: Number(a.count),
  });
  const delaySec = Number(a.totalDelaySec || 0);
  const sub = delaySec > 0 ? t('steps.anomalyDelayPart', { sec: delaySec }) : '';
  const events = Array.isArray(a.events) ? a.events : [];
  const rows = events.map((ev, idx) => {
    const label = formatAnomalyKindLabel(ev.kind);
    const parts = [`#${ev.attempt || idx + 1} ${label}`];
    if (Number(ev.delaySec) > 0) {
      parts.push(t('steps.anomalyDelayPart', { sec: ev.delaySec }));
    }
    if (ev.terminal) {
      parts.push(t('steps.anomalyTerminalTag'));
    }
    return {
      text: parts.join(' · '),
      detail: ev.message || '',
      danger: Boolean(ev.terminal || ev.kind === 'rate_limit' || ev.kind === 'auth_or_model'),
    };
  });
  return {
    title,
    sub,
    rows,
    hint: '',
    severity: a.severity === 'danger' ? 'danger' : 'warn',
  };
}

function buildModelAnomalyDiagnostic(m) {
  const sum = resolveModelAnomalySummary(m);
  if (!sum) return null;
  const title = t('steps.anomalyModelTitle', {
    model: m?.displayText || m?.shortName || m?.label || '—',
    count: sum.count,
  });
  const subParts = [t('steps.anomalyModelSub', { steps: sum.steps })];
  if (sum.totalDelaySec > 0) {
    subParts.push(t('steps.anomalyDelayPart', { sec: sum.totalDelaySec }));
  }
  const rows = sum.entries.map(([k, v]) => ({
    text: t('steps.anomalyModelKindRow', { kind: formatAnomalyKindLabel(k), count: v }),
    detail: '',
    danger: k === 'rate_limit' || k === 'auth_or_model',
  }));
  return {
    title,
    sub: subParts.join(' · '),
    rows,
    hint: t('steps.anomalyModelClickHint'),
    severity: sum.severity,
  };
}

function sampleSummary(summary) {
  const valid = summary?.sampleCount || 0;
  const excluded = summary?.excludedCount || 0;
  return t('fmt.sampleSteps', { valid, total: valid + excluded });
}

function formatCountdown(isoTime, nowMs = Date.now()) {
  if (!isoTime) return t('fmt.resetUnknown');
  const targetMs = Date.parse(isoTime);
  if (!Number.isFinite(targetMs) || targetMs <= 0) return t('fmt.resetUnknown');
  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return t('fmt.resetSoon');
  if (diffMs < 60_000) return t('fmt.resetUnder1m');

  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return t('fmt.resetDaysHours', { d: days, h: hours });
  if (hours > 0) return t('fmt.resetHoursMins', { h: hours, m: minutes });
  return t('fmt.resetMins', { m: minutes });
}

function formatCompactDateTime(ms) {
  if (!ms || !Number.isFinite(ms)) return t('fmt.selectTime');
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatElapsedSec(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) {
    return `${m}m ${String(remS).padStart(2, '0')}s`;
  }
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
}


/**
 * 隐藏原始模型 ID 开头的 `gemini-`、`claude-`、`gpt-` 厂商前缀以节省单行表格空间（确保剥离后非空）。
 *
 * @param {string} rawText
 * @returns {string}
 */
function stripVendorModelPrefix(rawText) {
  return String(rawText || '')
    .trim()
    .replace(/^(?:gemini|claude|gpt)-(?=.+)/i, '');
}

function stripCompactionMarker(rawText) {
  return String(rawText || '')
    .replace(/(?:·(?:压缩|compact)|\[自动压缩\]|\[auto[- ]?compact\])\s*$/iu, '')
    .trim();
}

const normalizeOrchestratorIdDisplayMode = normalizeOrchestratorIdMode;

/**
 * 统一解析步骤、会话摘要或模型汇总行面向用户的模型显示文本与悬停提示。
 *
 * 规则：
 * - Orchestrator 系列（`Orchestrator (Carbon)`、`Orchestrator (Argon)`、`gemini-flash-worker-agy` / `M669`）
 *   独立遵循 `orchestratorIdMode`（`'compact'` 显示 `orchestrator-carbon` / `orchestrator-argon` / `worker-agy-hydrogen`；
 *   `'full'` 显示带括号标注的完整上游 ID），不受普通模型显示模式影响；
 * - 其余普通模型遵循 `modelDisplayMode`（`'short'` | `'upstream_compact'` | `'upstream'`，兼容旧版布尔 `showUpstreamModel`）；
 * - 独立拆分 `baseText` 与 `compactionSuffix`（`·压缩`），供步骤表单独保护压缩尾标永不截断。
 *
 * @param {object|null|undefined} target
 * @param {{ modelDisplayMode?: string, showUpstreamModel?: boolean, orchestratorIdMode?: string }|boolean} [settings]
 * @param {{ preferLabelInShort?: boolean, fallback?: string }} [options]
 * @returns {{ text: string, baseText: string, compactionSuffix: string, isCompaction: boolean, title: string, isOrchestratorSeries: boolean }}
 */
function resolveModelDisplayInfo(target, settings = {}, options = {}) {
  const modelDisplayMode =
    typeof settings === 'boolean'
      ? settings
        ? 'upstream'
        : 'short'
      : normalizeModelDisplayMode(settings?.modelDisplayMode, settings?.showUpstreamModel);
  const showUpstream = modelDisplayMode !== 'short';
  const orchestratorMode = normalizeOrchestratorIdDisplayMode(
    typeof settings === 'object' && settings ? settings.orchestratorIdMode : 'compact'
  );
  const preferLabelInShort = Boolean(options?.preferLabelInShort);
  const fallback = options?.fallback ?? t('fmt.unknownModel');

  if (!target || typeof target !== 'object') {
    return {
      text: fallback,
      baseText: fallback,
      compactionSuffix: '',
      isCompaction: false,
      title: fallback,
      isOrchestratorSeries: false,
    };
  }

  const shortText = String(
    target.activeBaseModelShort ??
      target.baseModelShort ??
      target.activeModelShort ??
      target.modelShort ??
      target.shortName ??
      ''
  ).trim();
  const labelText = String(
    target.activeBaseModelLabel ??
      target.baseModelLabel ??
      target.activeModelLabel ??
      target.modelLabel ??
      target.label ??
      ''
  ).trim();
  const upstreamText = String(
    target.baseModelUpstream ??
      target.activeModelUpstream ??
      target.modelUpstream ??
      target.upstreamName ??
      ''
  ).trim();
  const rawCompactionText = `${target.activeModelShort ?? target.modelShort ?? ''} ${target.activeModelLabel ?? target.modelLabel ?? ''} ${target.activeModelUpstream ?? target.modelUpstream ?? ''}`;
  const responseText = String(target.responseModel ?? '').trim();
  const modelKeyText = String(target.modelKey ?? '').trim();

  const isCompaction =
    Boolean(target.isCompactionStep) ||
    /·(?:压缩|compact)(?=\s|$)|\[自动压缩\]/iu.test(rawCompactionText);

  const compactionSuffix = isCompaction ? t('fmt.compactionSuffix') : '';

  const combined = `${modelKeyText} ${shortText} ${labelText} ${upstreamText} ${responseText}`;
  const isOrchWorker =
    /\bMODEL_PLACEHOLDER_M669\b|\b[a-z0-9.-]*worker-agy\b|\bworker-agy-hydrogen\b|\bOrchestrator\s+Worker\b/i.test(
      combined
    );
  const isOrchSeries =
    isOrchWorker ||
    /\bgemini-pro-orchestrator(?:-argon)?\b|\borchestrator-(?:carbon|argon)\b|\borch-(?:carbon|argon)(?:·压缩)?(?=\s|$)|Orchestrator\s*\((?:Carbon|Argon)\)|\bMODEL_PLACEHOLDER_M(?:667|681)\b/i.test(
      combined
    );

  if (isOrchSeries) {
    let compactId = 'orchestrator-carbon';
    let fullId = 'gemini-pro-orchestrator (carbon-4)';
    if (isOrchWorker) {
      compactId = 'worker-agy-hydrogen';
      fullId = 'gemini-flash-worker-agy (hydrogen-4)';
    } else if (/\bargon\b|\bMODEL_PLACEHOLDER_M681\b|\borch-argon\b/i.test(combined)) {
      compactId = 'orchestrator-argon';
      fullId = 'gemini-pro-orchestrator-argon (argon-4)';
    }
    const baseText = orchestratorMode === 'full' ? fullId : compactId;
    const text = `${baseText}${compactionSuffix}`;
    const multiUpstream =
      Array.isArray(target.upstreamModels) && target.upstreamModels.length > 1
        ? target.upstreamModels.join(' / ')
        : '';
    const title = multiUpstream || `${fullId}${compactionSuffix}`;
    return {
      text,
      baseText,
      compactionSuffix,
      isCompaction,
      title,
      isOrchestratorSeries: true,
    };
  }

  const rawSelected =
    (showUpstream
      ? upstreamText || responseText || shortText || labelText
      : preferLabelInShort
        ? labelText || shortText
        : shortText || labelText) || fallback;
  const cleanRawBase = stripCompactionMarker(rawSelected) || fallback;
  const baseText =
    modelDisplayMode === 'upstream_compact'
      ? stripVendorModelPrefix(cleanRawBase) || cleanRawBase
      : cleanRawBase;
  const text = `${baseText}${compactionSuffix}`;
  const fullUpstreamWithSuffix = `${cleanRawBase}${compactionSuffix}`;
  const standardTitle =
    showUpstream && Array.isArray(target.upstreamModels) && target.upstreamModels.length > 1
      ? target.upstreamModels.join(' / ')
      : showUpstream
        ? fullUpstreamWithSuffix
        : text;
  return {
    text,
    baseText,
    compactionSuffix,
    isCompaction,
    title: standardTitle,
    isOrchestratorSeries: false,
  };
}

/**
 * 按当前显示策略 (`resolveModelDisplayInfo`) 解析出的最终展示名称对模型统计列表执行二次去重归并，
 * 确保当多个外层模型槽位映射到同一展示名（例如切换至“原始模型 ID”后共享同一 `upstreamName`）时，
 * 不会在排行榜或总览中出现重复同名行，同时完整累加 Token、调用次数、未定价计数与速度/首字加权均值。
 *
 * @param {object[]} [models=[]]
 * @param {object|boolean} [settings={}]
 * @param {{ preferLabelInShort?: boolean, fallback?: string }} [options={}]
 * @returns {object[]}
 */
function mergeModelsByDisplayName(models = [], settings = {}, options = {}) {
  if (!Array.isArray(models) || models.length === 0) return [];
  const showUpstream =
    typeof settings === 'boolean'
      ? settings
      : normalizeModelDisplayMode(settings?.modelDisplayMode, settings?.showUpstreamModel) !== 'short';
  const byDisplay = new Map();

  for (const m of models) {
    if (!m || typeof m !== 'object') continue;
    const disp = resolveModelDisplayInfo(m, settings, options);
    const key = String(disp.text || options?.fallback || '—').trim() || '—';

    const calls = Math.max(0, Number(m.calls || 0));
    const inTok = Math.max(0, Number(m.inputTokens || 0));
    const cacheTok = Math.max(0, Number(m.cacheReadTokens || 0));
    const outTok = Math.max(0, Number(m.outputTokens || 0));
    const thinkTok = Math.max(0, Number(m.thinkingTokens || 0));
    const respTok =
      m.responseTokens != null
        ? Math.max(0, Number(m.responseTokens))
        : Math.max(0, outTok - thinkTok);
    const totTok = Math.max(0, Number(m.totalTokens ?? inTok + cacheTok + outTok));
    const costUsd = Number.isFinite(Number(m.costUsd)) ? Math.max(0, Number(m.costUsd)) : 0;
    const unpricedCalls = Math.max(0, Number(m.unpricedCalls || 0));

    const speedSampleCount = Math.max(0, Number(m.speedSummary?.sampleCount || 0));
    const speedExcludedCount = Math.max(0, Number(m.speedSummary?.excludedCount || 0));
    const speedWeight = speedSampleCount > 0 ? speedSampleCount : Math.max(1, outTok || calls || 1);
    const hasSpeed = m.avgTokPerSec != null && Number.isFinite(Number(m.avgTokPerSec)) && Number(m.avgTokPerSec) > 0;

    const ttftSampleCount = Math.max(0, Number(m.ttftSampleCount || 0));
    const ttftWeight = ttftSampleCount > 0 ? ttftSampleCount : Math.max(1, calls || 1);
    const hasTtft = m.avgTtftSec != null && Number.isFinite(Number(m.avgTtftSec)) && Number(m.avgTtftSec) >= 0;

    let acc = byDisplay.get(key);
    if (!acc) {
      acc = {
        baseItem: m,
        mergedCount: 1,
        displayText: key,
        firstTitle: disp.title || key,
        titleSet: new Set(disp.title ? [disp.title] : []),
        upstreamSet: new Set(
          Array.isArray(m.upstreamModels) ? m.upstreamModels.filter(Boolean) : []
        ),
        sourceLabels: m.label ? [m.label] : [],
        calls,
        inputTokens: inTok,
        cacheReadTokens: cacheTok,
        outputTokens: outTok,
        thinkingTokens: thinkTok,
        responseTokens: respTok,
        totalTokens: totTok,
        costUsd,
        unpricedCalls,
        speedWeightedSum: hasSpeed ? Number(m.avgTokPerSec) * speedWeight : 0,
        speedWeight: hasSpeed ? speedWeight : 0,
        speedSampleCount,
        speedExcludedCount,
        ttftWeightedSum: hasTtft ? Number(m.avgTtftSec) * ttftWeight : 0,
        ttftWeight: hasTtft ? ttftWeight : 0,
        ttftSampleCount,
        anomalySteps: Math.max(0, Number(m.anomalySteps || 0)),
        anomalyCount: Math.max(0, Number(m.anomalyCount || 0)),
        anomalyDangerCount: Math.max(0, Number(m.anomalyDangerCount || 0)),
        anomalyTotalDelaySec: Math.max(0, Number(m.anomalyTotalDelaySec || 0)),
        anomalyByKind:
          m.anomalyByKind && typeof m.anomalyByKind === 'object' ? { ...m.anomalyByKind } : {},
      };
      if (m.upstreamName) acc.upstreamSet.add(m.upstreamName);
      byDisplay.set(key, acc);
      continue;
    }

    acc.mergedCount += 1;
    if (disp.title) acc.titleSet.add(disp.title);
    if (Array.isArray(m.upstreamModels)) {
      for (const u of m.upstreamModels) {
        if (u) acc.upstreamSet.add(u);
      }
    }
    if (m.upstreamName) acc.upstreamSet.add(m.upstreamName);
    if (m.label && !acc.sourceLabels.includes(m.label)) {
      acc.sourceLabels.push(m.label);
    }

    acc.calls += calls;
    acc.inputTokens += inTok;
    acc.cacheReadTokens += cacheTok;
    acc.outputTokens += outTok;
    acc.thinkingTokens += thinkTok;
    acc.responseTokens += respTok;
    acc.totalTokens += totTok;
    acc.costUsd += costUsd;
    acc.unpricedCalls += unpricedCalls;

    acc.anomalySteps += Math.max(0, Number(m.anomalySteps || 0));
    acc.anomalyCount += Math.max(0, Number(m.anomalyCount || 0));
    acc.anomalyDangerCount += Math.max(0, Number(m.anomalyDangerCount || 0));
    acc.anomalyTotalDelaySec += Math.max(0, Number(m.anomalyTotalDelaySec || 0));
    if (m.anomalyByKind && typeof m.anomalyByKind === 'object') {
      for (const [ak, av] of Object.entries(m.anomalyByKind)) {
        const cnt = Math.max(0, Number(av || 0));
        if (cnt > 0) acc.anomalyByKind[ak] = (acc.anomalyByKind[ak] || 0) + cnt;
      }
    }

    if (hasSpeed) {
      acc.speedWeightedSum += Number(m.avgTokPerSec) * speedWeight;
      acc.speedWeight += speedWeight;
    }
    acc.speedSampleCount += speedSampleCount;
    acc.speedExcludedCount += speedExcludedCount;

    if (hasTtft) {
      acc.ttftWeightedSum += Number(m.avgTtftSec) * ttftWeight;
      acc.ttftWeight += ttftWeight;
    }
    acc.ttftSampleCount += ttftSampleCount;
  }

  return Array.from(byDisplay.values()).map((acc) => {
    if (acc.mergedCount === 1) {
      return {
        ...acc.baseItem,
        displayText: acc.displayText,
        displayTitle: acc.firstTitle,
        sourceLabels: acc.sourceLabels,
      };
    }
    const promptTok = acc.inputTokens + acc.cacheReadTokens;
    const cacheHitPct = promptTok > 0 ? +((acc.cacheReadTokens / promptTok) * 100).toFixed(1) : 0;
    const avgTokPerSec =
      acc.speedWeight > 0 ? +(acc.speedWeightedSum / acc.speedWeight).toFixed(1) : null;
    const avgTtftSec =
      acc.ttftWeight > 0 ? +(acc.ttftWeightedSum / acc.ttftWeight).toFixed(1) : null;
    const upstreamModels = Array.from(acc.upstreamSet);
    const displayTitle =
      showUpstream && upstreamModels.length > 1
        ? upstreamModels.join(' / ')
        : Array.from(acc.titleSet).join(' / ') || acc.displayText;

    return {
      ...acc.baseItem,
      calls: acc.calls,
      inputTokens: acc.inputTokens,
      cacheReadTokens: acc.cacheReadTokens,
      outputTokens: acc.outputTokens,
      thinkingTokens: acc.thinkingTokens,
      responseTokens: acc.responseTokens,
      totalTokens: acc.totalTokens,
      costUsd: +acc.costUsd.toFixed(6),
      unpricedCalls: acc.unpricedCalls,
      cacheHitPct,
      avgTokPerSec,
      avgTtftSec,
      ttftSampleCount: acc.ttftSampleCount,
      ...(acc.anomalyCount > 0
        ? {
            anomalySteps: acc.anomalySteps,
            anomalyCount: acc.anomalyCount,
            anomalyDangerCount: acc.anomalyDangerCount,
            anomalyTotalDelaySec: +acc.anomalyTotalDelaySec.toFixed(1),
            anomalyByKind: acc.anomalyByKind,
          }
        : {}),
      speedSummary: acc.baseItem.speedSummary
        ? {
            ...acc.baseItem.speedSummary,
            sampleCount: acc.speedSampleCount,
            excludedCount: acc.speedExcludedCount,
            avgTokPerSec,
          }
        : undefined,
      upstreamModels,
      displayText: acc.displayText,
      displayTitle,
      sourceLabels: acc.sourceLabels,
    };
  });
}

/**
 * 根据代理索引返回对应的微边框语义徽章样式类名。
 *
 * @param {number} [index=0]
 * @param {boolean} [isMain=false]
 * @returns {string}
 */
function getAgentBadgeClass(index = 0, isMain = false) {
  if (isMain || index <= 0) return 'badge-main';
  const slot = ((index - 1) % 3) + 1;
  return `badge-sub-${slot}`;
}

function resolveStructuredAgentKind(agent) {
  if (!agent) return 'main';
  if (agent.agentKind) return agent.agentKind;
  if (agent.isMain) return 'main';
  if (agent.isSideQuestion || agent.typeName === 'side_question') return 'side_question';
  if (
    agent.typeName === 'worker' ||
    agent.typeName === 'swarm_worker' ||
    /^Swarm\s+Worker\s*\(/i.test(String(agent.role || ''))
  ) {
    return 'swarm_worker';
  }
  return 'subagent';
}

function normalizeSwarmMemberHandle(rawText) {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) return '';
  const wrapper = trimmed.match(/^Swarm\s+Worker\s*\(([^)]+)\)\s*$/i);
  const inner = (wrapper ? wrapper[1] : trimmed).replace(/^@+/, '').trim();
  if (
    !inner ||
    inner === '蜂群' ||
    inner === '工蜂' ||
    inner.toLowerCase() === 'swarm' ||
    inner.toLowerCase() === 'worker' ||
    inner.toLowerCase() === 'swarm worker'
  ) {
    return '';
  }
  return `@${inner}`;
}

/**
 * 基于结构化 `agentKind` / `agentOrdinal` 格式化主/子代理、蜂群节点或旁路提问的紧凑徽章文本（零正则反拆中文）。
 *
 * @param {object|null|undefined} agent
 * @returns {string}
 */
function formatAgentBadgeText(agent) {
  if (!agent) return t('fmt.mainBadge');
  const kind = resolveStructuredAgentKind(agent);
  if (kind === 'all') return t('header.scopeAllShort');
  if (kind === 'main') return t('fmt.mainBadge');
  if (kind === 'side_question') {
    const ord = Number(agent.agentOrdinal || agent.sideIndex || 0);
    if (ord > 0) return t('fmt.sideBadge', { index: ord });
    if (!isEnglishLocale() && agent.badgeText) return String(agent.badgeText);
    return t('fmt.sideBadgeShort');
  }
  if (kind === 'swarm_worker') {
    const ord = Number(agent.agentOrdinal || agent.index || 0);
    if (ord > 0) return t('fmt.swarmBadge', { index: ord });
    if (!isEnglishLocale() && agent.badgeText) return String(agent.badgeText);
    return t('fmt.swarmBadgeShort');
  }
  const ord = Number(agent.agentOrdinal || agent.index || 0);
  if (ord > 0) return t('fmt.subBadge', { index: ord });
  if (!isEnglishLocale() && agent.badgeText) return String(agent.badgeText);
  return t('fmt.subBadgeShort');
}

/**
 * 基于结构化 `agentKind` / `agentOrdinal` / `customRole` 格式化代理完整显示名称（零正则反拆中文）。
 *
 * @param {object|null|undefined} agent
 * @returns {string}
 */
function formatAgentLabel(agent) {
  if (!agent) return t('fmt.mainAgent');
  const kind = resolveStructuredAgentKind(agent);
  if (kind === 'all') return t('header.scopeAll');
  if (kind === 'main') return t('fmt.mainAgent');

  const rawCustom =
    agent.customRole !== undefined
      ? String(agent.customRole || '').trim()
      : String(agent.role || '').trim();
  if (kind === 'side_question') {
    const ord = Number(agent.agentOrdinal || agent.sideIndex || 0);
    const baseLabel = ord > 0 ? `${t('fmt.sideQuestion')} #${ord}` : t('fmt.sideQuestion');
    const isGeneric =
      !rawCustom ||
      rawCustom === baseLabel ||
      rawCustom === agent.shortLabel ||
      rawCustom === t('fmt.sideQuestion') ||
      rawCustom === 'Side Question' ||
      rawCustom === 'side_question';
    return isGeneric ? baseLabel : `${baseLabel} · ${rawCustom}`;
  }

  if (kind === 'swarm_worker') {
    const ord = Number(agent.agentOrdinal || agent.index || 0);
    const baseLabel = ord > 0 ? `${t('fmt.swarmAgent')} #${ord}` : t('fmt.swarmAgent');
    const handle = normalizeSwarmMemberHandle(rawCustom || agent.role || '');
    if (!handle) return baseLabel;
    let auxSuffix = '';
    if (/^@monitor(?:-\d+)?$/i.test(handle)) {
      auxSuffix = ` (${t('fmt.swarmMonitorHint')})`;
    } else if (/^@narrator(?:-\d+)?$/i.test(handle)) {
      auxSuffix = ` (${t('fmt.swarmNarratorHint')})`;
    }
    return `${baseLabel} · ${handle}${auxSuffix}`;
  }

  const ord = Number(agent.agentOrdinal || agent.index || 0);
  const baseLabel = ord > 0 ? `${t('fmt.subAgent')} #${ord}` : t('fmt.subAgent');
  const isGeneric =
    !rawCustom ||
    rawCustom === baseLabel ||
    rawCustom === agent.shortLabel ||
    rawCustom === t('fmt.subAgent') ||
    rawCustom === 'Subagent';
  return isGeneric ? baseLabel : `${baseLabel} · ${rawCustom}`;
}

/**
 * 格式化会话选项右侧元信息（自适应区分纯蜂群、蜂群+子代理混合、常规子代理与单会话步数）。
 *
 * @param {object|null|undefined} conv
 * @returns {string}
 */
function formatConversationMeta(conv) {
  if (!conv) return '';
  const main = Number(conv.stepCount || 0);
  const totalSubs = Number(conv.subagentCount || 0);
  const swarm = Number(conv.swarmCount || 0);
  const otherSubs = Math.max(0, totalSubs - swarm);
  const total = Number(conv.totalStepCount ?? conv.totalStepsAllAgents ?? main);
  if (swarm > 0 && otherSubs > 0) {
    return t('header.convMetaWithSwarmAndSubs', { main, swarm, subs: otherSubs, total });
  }
  if (swarm > 0) {
    return t('header.convMetaWithSwarm', { main, swarm, total });
  }
  if (totalSubs > 0) {
    return t('header.convMetaWithSubs', { main, subs: totalSubs, total });
  }
  return t('header.convMetaSteps', { count: main });
}

/**
 * 基于后端结构化 `actionKey` + `waitingApproval` 渲染实时动作短标题（兼容自定义 `label` 回退）。
 *
 * @param {object|null|undefined} act
 * @param {string} [fallbackKey='live.thinking']
 * @returns {string}
 */
function formatLiveActivityLabel(act, fallbackKey = 'live.thinking') {
  if (!act || typeof act !== 'object') return t(fallbackKey);
  let baseLabel = '';
  if (act.actionKey) {
    const i18nKey = `live.act.${act.actionKey}`;
    const translated = t(i18nKey);
    if (translated && translated !== i18nKey) {
      baseLabel = translated;
    }
  }
  if (!baseLabel) {
    baseLabel = String(act.label || '').trim() || t(fallbackKey);
  }
  if (act.waitingApproval) {
    return t('live.act.awaitingApproval', { label: baseLabel });
  }
  return baseLabel;
}

/**
 * 基于后端结构化 `detailKey` 渲染实时动作补充说明（兼容自由文本 `detail`）。
 *
 * @param {object|null|undefined} act
 * @returns {string}
 */
function formatLiveActivityDetail(act) {
  if (!act || typeof act !== 'object') return '';
  if (act.detailKey === 'compaction_resuming') {
    return t('live.act.compactionResuming');
  }
  return String(act.detail || '');
}

/**
 * 20 色感知均匀色环（无特定模型绑定，兼顾亮/暗背景可读性，彻底消除标准 HSL 绿色/暗红区过度聚集撞色）。
 * 每项为 `[hue, saturationPct, lightnessPct]`。
 */
const PERCEPTUAL_MODEL_COLOR_RING = [
  [217, 82, 53], // Royal Blue
  [14, 80, 52], // Coral / Vermilion
  [162, 74, 41], // Teal / Jade
  [272, 74, 58], // Vivid Violet
  [36, 88, 47], // Rich Amber
  [336, 78, 53], // Rose / Raspberry
  [193, 84, 43], // Cerulean / Cyan
  [138, 66, 41], // Emerald Green
  [246, 74, 60], // Indigo
  [25, 86, 50], // Tangerine Orange
  [306, 70, 52], // Magenta / Orchid
  [177, 76, 39], // Deep Seafoam
  [355, 76, 54], // Crimson Red
  [205, 80, 48], // Ocean Blue
  [45, 88, 44], // Warm Gold
  [288, 68, 55], // Amethyst Purple
  [102, 60, 42], // Leaf Green
  [230, 76, 57], // Cobalt Blue
  [322, 74, 51], // Berry Pink
  [185, 72, 46], // Turquoise
];

/**
 * 提取跨平台、跨语言、同屏三栏（模型排行 / 客户端来源 / 月度统计）严格一致的模型颜色种子字符串。
 *
 * 优先取单模型稳定 `sourceLabels[0]`；若多个外层槽位已在当前显示策略下合并（如 `4-argon`），
 * 则以规范化 `displayText` 为种子，确保跨客户端与跨月份聚合子集不同时依然映射至完全相同的颜色。
 *
 * @param {object|string|null|undefined} model
 * @returns {string}
 */
function getCanonicalModelColorSeed(model) {
  if (typeof model === 'string') {
    return model.trim().toLowerCase().replace(/\s+/g, ' ');
  }
  if (!model || typeof model !== 'object') return '';
  if (
    Number(model.mergedCount || 0) <= 1 &&
    Array.isArray(model.sourceLabels) &&
    model.sourceLabels.length === 1 &&
    model.sourceLabels[0]
  ) {
    return String(model.sourceLabels[0]).trim().toLowerCase().replace(/\s+/g, ' ');
  }
  const raw =
    model.displayText ||
    model.label ||
    model.modelId ||
    model.baseItem?.modelId ||
    model.shortName ||
    model.name ||
    '';
  return String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
}

function hashModelSeed32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function formatRingSlotHsl(slotIdx, shiftLight = 0) {
  const [hue, sat, light] = PERCEPTUAL_MODEL_COLOR_RING[slotIdx % PERCEPTUAL_MODEL_COLOR_RING.length];
  const clampedLight = Math.min(66, Math.max(34, light + shiftLight));
  return `hsl(${hue} ${sat}% ${clampedLight}%)`;
}

/**
 * 基于模型标识通过 32 位雪崩哈希映射至 20 色感知均匀色环，确保跨电脑同模型同色且无需硬编码颜色表。
 *
 * @param {object|string|null|undefined} seedOrModel
 * @returns {string}
 */
function resolveDeterministicModelColor(seedOrModel) {
  const seed = getCanonicalModelColorSeed(seedOrModel);
  if (!seed) return 'var(--accent-primary)';
  const h = hashModelSeed32(seed);
  return formatRingSlotHsl(h % PERCEPTUAL_MODEL_COLOR_RING.length);
}

/**
 * 为一组模型构建确定性颜色映射表（双遍固有槽位保护）：
 * 1. 所有无槽位冲突的模型 100% 保持其纯哈希固有色，不受长尾模型增减影响；
 * 2. 仅当同屏两个模型恰好落入同一色环槽位时，按严格字典序以互质步长 `+7` 优先探查未被任何模型占用的空闲槽位。
 *
 * @param {Array<object|string>} [models=[]]
 * @returns {Map<string, string>} `canonicalSeed -> hsl(...)`
 */
function buildDeterministicModelColorMap(models = []) {
  const ringLen = PERCEPTUAL_MODEL_COLOR_RING.length;
  const uniqueSeeds = Array.from(
    new Set(
      (Array.isArray(models) ? models : [])
        .map((m) => getCanonicalModelColorSeed(m))
        .filter(Boolean)
    )
  ).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const naturalSlotCounts = new Map();
  for (const seed of uniqueSeeds) {
    const nat = hashModelSeed32(seed) % ringLen;
    naturalSlotCounts.set(nat, (naturalSlotCounts.get(nat) || 0) + 1);
  }

  const usedSlots = new Set();
  const colorMap = new Map();

  for (const seed of uniqueSeeds) {
    const h = hashModelSeed32(seed);
    const nat = h % ringLen;
    if (!usedSlots.has(nat)) {
      usedSlots.add(nat);
      colorMap.set(seed, formatRingSlotHsl(nat));
      continue;
    }

    let picked = -1;
    for (let k = 1; k < ringLen; k++) {
      const cand = (nat + k * 7) % ringLen;
      if (!usedSlots.has(cand) && !naturalSlotCounts.has(cand)) {
        picked = cand;
        break;
      }
    }
    if (picked < 0) {
      for (let k = 1; k < ringLen; k++) {
        const cand = (nat + k * 7) % ringLen;
        if (!usedSlots.has(cand)) {
          picked = cand;
          break;
        }
      }
    }

    if (picked >= 0) {
      usedSlots.add(picked);
      colorMap.set(seed, formatRingSlotHsl(picked));
    } else {
      const shift = (h >>> 8) & 1 ? 9 : -8;
      colorMap.set(seed, formatRingSlotHsl(nat, shift));
    }
  }

  return colorMap;
}
return { formatMetric, formatSpeedMetric, formatCachePct, getSpeedToneClass, getCacheToneClass, getStepCostToneClass, getTtftToneClass, formatTokens, formatTokensPrecise, formatCnyApprox, formatDateSpanBadge, formatUsd, speedReasonText, formatAnomalyKindLabel, formatAnomalyTagText, resolveModelAnomalySummary, formatStepAnomalyInlineSummary, buildStepAnomalyDiagnostic, buildModelAnomalyDiagnostic, sampleSummary, formatCountdown, formatCompactDateTime, formatElapsedSec, stripVendorModelPrefix, normalizeOrchestratorIdDisplayMode, resolveModelDisplayInfo, mergeModelsByDisplayName, getAgentBadgeClass, formatAgentBadgeText, formatAgentLabel, formatConversationMeta, formatLiveActivityLabel, formatLiveActivityDetail, getCanonicalModelColorSeed, resolveDeterministicModelColor, buildDeterministicModelColorMap };
})();

// --- src/core/requestDiagnostics.js ---
const { buildRequestDiagnostics } = (() => {
// Export only allowlisted timing and counts, never prompts, credentials or tool arguments.
function buildRequestDiagnostics(step) {
  const finite = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const text = (value) => typeof value === 'string' ? value.slice(0, 160) : null;
  const ttft = finite(step.nativeTtftSec ?? step.ttftSec);
  const total = finite(step.totalDurationSec);
  const raw = step.requestDiagnostics;
  const notes = [];
  if (ttft !== null && ttft >= 60) notes.push('long_first_token_wait');
  if (step.inputTokens > 0 && step.cacheReadTokens === 0) notes.push('zero_cache_read_recorded');
  if (ttft !== null && total !== null && total >= ttft && total - ttft < 0.5 && step.hasToolCalls) {
    notes.push('tool_call_returned_in_short_interval');
  }
  return {
    schemaVersion: 1,
    stepIndex: finite(step.stepIndex),
    model: text(step.responseModel || step.modelKey),
    timingSeconds: {
      timeToFirstToken: ttft,
      totalRequest: total,
      nativeStreaming: finite(step.nativeStreamSec),
      nativeThinking: finite(step.thinkingDurationSec),
      // This interval is not an independent network/GPU throughput measurement.
      afterFirstToken: total !== null && ttft !== null && total >= ttft
        ? +(total - ttft).toFixed(6) : null,
    },
    tokens: {
      input: finite(step.inputTokens), cacheRead: finite(step.cacheReadTokens),
      output: finite(step.outputTokens), thinking: finite(step.thinkingTokens),
    },
    rawMetadata: raw ? {
      createdAt: text(raw.createdAt), viewableAt: text(raw.viewableAt),
      finishedGeneratingAt: text(raw.finishedGeneratingAt), completedAt: text(raw.completedAt),
      status: text(raw.status), retryInfoCount: finite(raw.retryInfoCount),
      toolNames: Array.isArray(raw.toolNames) ? raw.toolNames.slice(0, 32).map(text) : [],
    } : null,
    anomalySummary: step.anomaly ? {
      primaryKind: text(step.anomaly.primaryKind), severity: text(step.anomaly.severity),
      count: finite(step.anomaly.count), totalDelaySec: finite(step.anomaly.totalDelaySec),
    } : null,
    notes,
    limitations: [
      'Native timing intervals may overlap; do not add them or infer causality from matching durations.',
      'DNS, TCP, TLS, server queue and prefill timings are unavailable.',
      'Missing retry metadata means unknown; entry counts are not necessarily retry attempts.',
      'Tool execution errors are separate from model request failures.',
      'The 60-second warning threshold is not an asserted service timeout.',
    ],
  };
}
return { buildRequestDiagnostics };
})();

// --- src/core/httpClient.js ---
const { abortSidecarApiKey, getWindowBridgeConfig, isWindowOverlayMode, deliverCdpBridgeResponses, callSidecarApi } = (() => {
/**
 * @fileoverview Async HTTP client with AbortController cancellation for stale
 * polling requests, concurrent GET deduplication, and dual-mode transport
 * (Sidecar Webview `window.sidecar.fetch` + Main Window Loopback Bridge).
 */


const inFlightGets = new Map();
const activeControllers = new Map();

function abortSidecarApiKey(abortKey) {
  if (!abortKey) return;
  const prev = activeControllers.get(abortKey);
  if (prev) {
    activeControllers.delete(abortKey);
    prev.abort();
  }
}

/**
 * 读取主窗口双栖模式下注入的本地桥接配置（`port`、`token`、`bundleVersion`、`stylesCss`）。
 *
 * @returns {{ port: number, token: string, bundleVersion?: string, stylesCss?: string } | null}
 */
function getWindowBridgeConfig() {
  const br = readInjectedWindowBridge();
  const port = Number(br?.port || 0);
  if (br && Number.isInteger(port) && port > 0 && typeof br.token === 'string' && br.token) {
    return br;
  }
  return null;
}

/**
 * 判断当前脚本是否以双栖悬浮模式运行在宿主主聊天窗口内（而非右侧辅助栏 Webview）。
 *
 * @returns {boolean}
 */
function isWindowOverlayMode() {
  if (typeof window === 'undefined') return false;
  if (window.sidecar?.fetch) return false;
  return Boolean(getWindowBridgeConfig());
}

/**
 * 接收 Sidecar 通过 CDP `Runtime.evaluate` 批量投递的 RPC 响应，完成因 CSP/代理解除 HTTP 直连时的兜底请求。
 *
 * @param {Array<{ id: string, ok: boolean, status?: number, data?: any, error?: string }>} responses
 * @returns {number}
 */
function deliverCdpBridgeResponses(responses) {
  const br = getWindowBridgeConfig();
  if (!br || !(br.rpcPending instanceof Map) || !Array.isArray(responses)) return 0;
  let delivered = 0;
  for (const item of responses) {
    const entry = br.rpcPending.get(item?.id);
    if (!entry) continue;
    br.rpcPending.delete(item.id);
    delivered += 1;
    if (item.ok) {
      entry.resolve(item.data);
    } else {
      entry.reject(new Error(item.error || `HTTP ${item.status || 500}`));
    }
  }
  return delivered;
}

function callViaCdpBridge(bridge, path, { method, body, signal, cdpTimeoutMs }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const abortErr = new Error('Request aborted');
      abortErr.name = 'AbortError';
      reject(abortErr);
      return;
    }
    if (!Array.isArray(bridge.rpcQueue)) bridge.rpcQueue = [];
    if (!(bridge.rpcPending instanceof Map)) bridge.rpcPending = new Map();

    const reqId = `rpc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const cleanupQueueItem = () => {
      if (!Array.isArray(bridge.rpcQueue)) return;
      const idx = bridge.rpcQueue.findIndex((item) => item?.id === reqId);
      if (idx >= 0) bridge.rpcQueue.splice(idx, 1);
    };

    const timeoutId = setTimeout(() => {
      bridge.rpcPending.delete(reqId);
      cleanupQueueItem();
      reject(new Error('CDP bridge timeout'));
    }, cdpTimeoutMs);

    const onAbort = () => {
      clearTimeout(timeoutId);
      bridge.rpcPending.delete(reqId);
      cleanupQueueItem();
      const abortErr = new Error('Request aborted');
      abortErr.name = 'AbortError';
      reject(abortErr);
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    bridge.rpcPending.set(reqId, {
      resolve: (data) => {
        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(data);
      },
      reject: (err) => {
        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    });

    if (bridge.rpcQueue.length >= 16) {
      const dropped = bridge.rpcQueue.shift();
      if (dropped?.id) {
        const stale = bridge.rpcPending.get(dropped.id);
        bridge.rpcPending.delete(dropped.id);
        stale?.reject(new Error('CDP queue superseded'));
      }
    }
    bridge.rpcQueue.push({ id: reqId, path, method, body });
  });
}

async function callSidecarApi(path, { method = 'GET', body, abortKey = '', cdpTimeoutMs = 3500 } = {}) {
  const upperMethod = method.toUpperCase();
  const dedupKey = upperMethod === 'GET' && !abortKey ? path : '';

  if (dedupKey && inFlightGets.has(dedupKey)) {
    return inFlightGets.get(dedupKey);
  }

  let signal;
  let requestController = null;
  if (abortKey && typeof AbortController !== 'undefined') {
    const prev = activeControllers.get(abortKey);
    if (prev) {
      prev.abort();
    }
    requestController = new AbortController();
    activeControllers.set(abortKey, requestController);
    signal = requestController.signal;
  }

  const execHttpOnce = async (activeBridge) => {
    const sidecar = typeof window !== 'undefined' ? window.sidecar : null;
    const fetchFn = sidecar?.fetch
      ? sidecar.fetch.bind(sidecar)
      : typeof window !== 'undefined' && typeof window.fetch === 'function'
        ? window.fetch.bind(window)
        : globalThis.fetch.bind(globalThis);
    const requestUrl = activeBridge ? `http://127.0.0.1:${activeBridge.port}${path}` : path;
    const headers = {};
    if (body !== undefined || !activeBridge) {
      headers['Content-Type'] = 'application/json';
    }
    if (activeBridge) {
      headers['X-Usage-Monitor-Token'] = activeBridge.token;
    }
    const res = await fetchFn(requestUrl, {
      method: upperMethod,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (signal?.aborted) {
      const abortErr = new Error('Request aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    const data = await res.json().catch(() => ({}));
    if (signal?.aborted) {
      const abortErr = new Error('Request aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    if (activeBridge) {
      activeBridge.transportMode = 'http';
    }
    return data;
  };

  const fallbackViaCdpWithRecovery = async (initialBridge) => {
    initialBridge.transportMode = 'cdp';
    try {
      return await callViaCdpBridge(initialBridge, path, {
        method: upperMethod,
        body,
        signal,
        cdpTimeoutMs,
      });
    } catch (cdpErr) {
      if (signal?.aborted || cdpErr?.name === 'AbortError') {
        throw cdpErr;
      }
      // 热更新或守护重启期间若 CDP 尚未轮询投递，自动重置回 HTTP 并用最新桥接端口重试一次
      const latestBridge = getWindowBridgeConfig() || initialBridge;
      latestBridge.transportMode = 'http';
      return execHttpOnce(latestBridge);
    }
  };

  const runRequest = async () => {
    const sidecar = typeof window !== 'undefined' ? window.sidecar : null;
    const bridge = !sidecar?.fetch ? getWindowBridgeConfig() : null;
    if (bridge && bridge.transportMode === 'cdp') {
      return fallbackViaCdpWithRecovery(bridge);
    }

    try {
      return await execHttpOnce(bridge);
    } catch (fetchErr) {
      if (signal?.aborted || fetchErr?.name === 'AbortError') {
        throw fetchErr;
      }
      if (!bridge) {
        // 辅助栏 Webview 在 Worker 热替换瞬间若有极短暂波动，延迟 180ms 自动无感重试一次
        if (upperMethod === 'GET') {
          await new Promise((r) => setTimeout(r, 180));
          if (!signal?.aborted) {
            return execHttpOnce(null);
          }
        }
        throw fetchErr;
      }
      // 当宿主环境的 CSP connect-src、混合内容策略或瞬态端口切换阻断直连时，切至带 HTTP 自愈恢复的 CDP 通道
      return fallbackViaCdpWithRecovery(bridge);
    }
  };

  const promise = runRequest().finally(() => {
    if (dedupKey) {
      inFlightGets.delete(dedupKey);
    }
    if (abortKey && requestController && activeControllers.get(abortKey) === requestController) {
      activeControllers.delete(abortKey);
    }
  });

  if (dedupKey) {
    inFlightGets.set(dedupKey, promise);
  }
  return promise;
}
return { abortSidecarApiKey, getWindowBridgeConfig, isWindowOverlayMode, deliverCdpBridgeResponses, callSidecarApi };
})();

// --- src/store/uiStore.js ---
const { getViewTabs, uiStore, getVisibleMonitorView } = (() => {
/**
 * @fileoverview UI navigation and view state store.
 */


function getViewTabs() {
  return [
    { value: 'overview', label: t('nav.overview'), icon: 'pulse' },
    { value: 'consumption', label: t('nav.consumption'), icon: 'chart-bar' },
    { value: 'steps', label: t('nav.steps'), icon: 'table' },
    { value: 'settings', label: t('nav.settings'), icon: 'sliders' },
  ];
}

const uiStore = createReactiveStore({
  activeView: 'overview',
  monitorVisible: true,
  stepsSubTab: 'steps', // 'steps' | 'models'
  settingsSubTab: 'general', // 'general' | 'structure' | 'account' | 'other'
  settingsStructureTab: 'mount', // 'mount' | 'hover' | 'overview' | 'steps'
  selectedAgentScope: 'all', // 'all' | 'main' | <subagent cascadeId>
  ctxInspectorAgentId: 'auto', // 'auto' | 'main' | <subagent cascadeId>
});

function getVisibleMonitorView(state = uiStore.getState()) {
  return state.monitorVisible ? state.activeView : null;
}
return { getViewTabs, uiStore, getVisibleMonitorView };
})();

// --- src/store/telemetryStore.js ---
const { extractHostRouteCascadeId, telemetryStore, clearConsumptionRangeCache, clearConversationViewCache, CLIENT_TOPBAR_SLOT_KEYS, DEFAULT_CLIENT_TOPBAR_SLOTS, CLIENT_OVERVIEW_MODULE_KEYS, DEFAULT_CLIENT_OVERVIEW_MODULES, DEFAULT_CLIENT_HOVER_MODULES, CLIENT_OVERVIEW_METRIC_KEYS, DEFAULT_CLIENT_OVERVIEW_METRICS, CLIENT_STEP_COLUMN_KEYS, DEFAULT_CLIENT_STEP_COLUMNS, DEFAULT_CLIENT_STEP_TOKEN_COMBO_FORMAT, MIN_CLIENT_POPOVER_WIDTH, MAX_CLIENT_POPOVER_WIDTH, DEFAULT_CLIENT_POPOVER_WIDTH, parseClientStepTokenComboSegments, normalizeClientStepTokenComboFormat, normalizeClientPopoverWidthMode, normalizeClientPopoverWidth, normalizeClientModelDisplayMode, normalizeClientTopbarSlots, normalizeClientHoverModules, normalizeClientOverviewModules, normalizeClientOverviewMetrics, normalizeClientStepColumns, normalizeClientUpdateMode, normalizeClientOrchestratorIdMode, normalizeClientWindowMountMode, isEquivalentTelemetry, fetchTelemetry, selectConversation, selectConsumptionTimeRange, prefetchConsumptionPresets, saveSettingsPatch, saveModelContextWindow, resetAllSettings, rebuildTrajectoryCache, triggerCloudSync, triggerBridgeHostRelaunch, triggerPluginUpdate, startAsyncTelemetryLoop, stopAsyncTelemetryLoop, resolveHostRouteMatch, resolveScopedConversation, isMacHostPlatform } = (() => {
/**
 * @fileoverview Reactive telemetry store with async non-overlapping poll scheduler
 * and granular slice updates.
 */


const CASCADE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 在主窗口双栖模式下，提取当前正在浏览的会话 ID：
 * 1. 优先解析 Antigravity 2.0 路由路径 `/c/<uuid>`；
 * 2. 在 Antigravity IDE (`workbench.html`) 无路径路由时，回退读取活跃对话视图
 *    `[data-testid="conversation-view"][data-cascade-id]` 或侧栏选中项。
 *
 * @returns {string}
 */
function extractHostRouteCascadeId() {
  if (typeof window === 'undefined' || !isWindowOverlayMode()) return '';
  const pathname = String(window.location?.pathname || '');
  const m = pathname.match(/^\/c\/([a-f0-9-]{36})(?:\/|$)/i);
  if (m && CASCADE_UUID_RE.test(m[1])) {
    return m[1];
  }
  const extBridgeRouteId = String(readInjectedWindowBridge()?.[WINDOW_BRIDGE_ROUTE_KEY] || '').trim();
  if (extBridgeRouteId && CASCADE_UUID_RE.test(extBridgeRouteId)) {
    return extBridgeRouteId;
  }
  try {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
      return '';
    }
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
        if (!CASCADE_UUID_RE.test(cid)) continue;
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
        CASCADE_UUID_RE.test(selectedRowId) &&
        visibleIds.some((id) => id.toLowerCase() === selectedRowId.toLowerCase())
      ) {
        return selectedRowId;
      }
      if (visibleIds.length > 0) return visibleIds[0];
    }

    const singleView = document.querySelector('[data-testid="conversation-view"][data-cascade-id]');
    const singleViewId = String(singleView?.getAttribute?.('data-cascade-id') || '').trim();
    if (CASCADE_UUID_RE.test(singleViewId)) {
      return singleViewId;
    }
    if (CASCADE_UUID_RE.test(selectedRowId)) {
      return selectedRowId;
    }
  } catch {
    // 忽略宿主 DOM 查询异常
  }
  return '';
}

const initialConversationId =
  (typeof window !== 'undefined' && window.sidecar?.conversationId) || '';

const telemetryStore = createReactiveStore({
  selectedConversationId: initialConversationId,
  hostRouteConversationId: extractHostRouteCascadeId(),
  selectedTimeRange: 'today',
  customStartMs: Date.now() - 24 * 3600 * 1000,
  customEndMs: Date.now(),
  syncState: 'idle', // 'idle' | 'syncing' | 'synced' | 'error'
  minuteTick: 0,
  telemetry: null,
});

let pollTimer = null;
let feedbackTimer = null;
let deferredConvSyncTimer = null;
let activeBundleVersion = 0;
let latestRequestSeq = 0;
let latestConsumptionReqSeq = 0;
let latestConversationSwitchSeq = 0;
let activeForceCount = 0;
let consecutivePollFailures = 0;
let inFlightTelemetryPoll = null;
let inFlightPresetsPrefetch = null;
let lastPrefetchedUsageRevision = 0;
let consumptionCacheScopeSig = '';
const MAX_CONSUMPTION_RANGE_CACHE = 12;
const MAX_CONVERSATION_VIEW_CACHE = 12;
const CONSUMPTION_PRESET_KEYS = ['cycle', 'today', '24h', '7d', '14d', '30d', 'all'];
const consumptionRangeCache = new Map();
const conversationViewCache = new Map();
let lastReceivedSteps = null;
let loopActive = false;
let loopIntervalMs = 2000;
let loopTickFn = null;
let settingsRevision = 0;
let settingsWriteChain = Promise.resolve();
const pendingSettingsMutations = new Map();
const recentCommittedSettings = new Map();

const TELEMETRY_RECOMPUTE_SETTING_KEYS = new Set([
  'weeklyLimitMode',
  'weeklyTokenBudget',
  'weeklyCostBudget',
  'windowMountMode',
  'enableWindowOverlay',
]);

function makeConsumptionRangeCacheKey(range, customStartMs = 0, customEndMs = 0) {
  const key = String(range || 'all');
  if (key === 'custom') {
    return `custom:${Number(customStartMs || 0)}:${Number(customEndMs || 0)}`;
  }
  return key;
}

function clearConsumptionRangeCache() {
  consumptionRangeCache.clear();
  lastPrefetchedUsageRevision = 0;
  inFlightPresetsPrefetch = null;
}

function clearConversationViewCache() {
  conversationViewCache.clear();
  if (deferredConvSyncTimer) {
    clearTimeout(deferredConvSyncTimer);
    deferredConvSyncTimer = null;
  }
}

function buildConsumptionScopeSig(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const acct = payload.account || {};
  const set = payload.settings || {};
  const cloud = payload.cloudStatus || {};
  return `${String(acct.status || '')}|${String(acct.email || acct.name || '').toLowerCase()}|${String(set.weeklyLimitMode || '')}|${String(cloud.catalogVersion || '')}`;
}

function syncConsumptionCacheScope(payload) {
  const nextSig = buildConsumptionScopeSig(payload);
  if (!nextSig) return;
  if (consumptionCacheScopeSig && consumptionCacheScopeSig !== nextSig) {
    clearConsumptionRangeCache();
    clearConversationViewCache();
  }
  consumptionCacheScopeSig = nextSig;
}

function recordConversationViewToCache(payload) {
  const active = payload?.activeConversation;
  const cidLower = String(active?.cascadeId || '').trim().toLowerCase();
  if (!cidLower || !Array.isArray(active?.recentSteps)) return;
  const entry = {
    cascadeId: active.cascadeId,
    activeConversation: active,
    activePool: payload.quotas?.activePool || null,
    weekly: payload.quotas?.weekly || null,
    sessionConsumption: payload.consumption?.session || null,
    sessionPresets:
      payload.consumption?.sessionPresets ||
      (payload.consumption?.presets
        ? Object.fromEntries(
            Object.entries(payload.consumption.presets).map(([k, v]) => [k, v?.session || null])
          )
        : null),
    stepRevision: String(payload.stepRevision || ''),
    cachedAtMs: Date.now(),
  };
  conversationViewCache.delete(cidLower);
  conversationViewCache.set(cidLower, entry);
  while (conversationViewCache.size > MAX_CONVERSATION_VIEW_CACHE) {
    conversationViewCache.delete(conversationViewCache.keys().next().value);
  }
}

function resolveCachedConversationRootId(telemetry, effectiveConvId) {
  const target = String(effectiveConvId || '').trim();
  const convs = Array.isArray(telemetry?.conversations) ? telemetry.conversations : [];
  if (!target) {
    return String(convs[0]?.cascadeId || '').trim().toLowerCase();
  }
  const lower = target.toLowerCase();
  if (conversationViewCache.has(lower)) return lower;
  const matchedRoot = convs.find(
    (c) =>
      String(c?.cascadeId || '').toLowerCase() === lower ||
      (Array.isArray(c?.memberCascadeIds) &&
        c.memberCascadeIds.some((m) => String(m || '').toLowerCase() === lower))
  );
  return String(matchedRoot?.cascadeId || lower).trim().toLowerCase();
}

function applyConversationSliceToTelemetry(baseTelemetry, slice) {
  if (!baseTelemetry || !slice?.activeConversation) return baseTelemetry;
  const activeCidLower = String(slice.activeConversation.cascadeId || '').toLowerCase();
  const prevQuotas = baseTelemetry.quotas || {};
  const nextQuotas =
    slice.activePool || slice.weekly
      ? {
          ...prevQuotas,
          ...(slice.activePool ? { activePool: slice.activePool } : {}),
          ...(slice.weekly ? { weekly: slice.weekly } : {}),
        }
      : prevQuotas;

  const prevCons = baseTelemetry.consumption || {};
  let nextPresets = prevCons.presets;
  if (slice.sessionPresets && prevCons.presets && typeof prevCons.presets === 'object') {
    nextPresets = { ...prevCons.presets };
    for (const [k, sBucket] of Object.entries(slice.sessionPresets)) {
      if (sBucket && nextPresets[k]) {
        nextPresets[k] = { ...nextPresets[k], session: sBucket };
      }
    }
  }
  const nextCons =
    slice.sessionConsumption || nextPresets !== prevCons.presets
      ? {
          ...prevCons,
          ...(slice.sessionConsumption ? { session: slice.sessionConsumption } : {}),
          ...(nextPresets !== prevCons.presets ? { presets: nextPresets } : {}),
        }
      : prevCons;

  const prevRunning = Array.isArray(baseTelemetry.runningConversations)
    ? baseTelemetry.runningConversations
    : null;
  let nextRunning = prevRunning;
  if (prevRunning && prevRunning.length > 0 && activeCidLower) {
    let anyChanged = false;
    const mapped = prevRunning.map((item) => {
      const shouldSelect = String(item?.cascadeId || '').toLowerCase() === activeCidLower;
      if (Boolean(item?.isCurrentSelected) === shouldSelect) return item;
      anyChanged = true;
      return { ...item, isCurrentSelected: shouldSelect };
    });
    if (anyChanged) nextRunning = mapped;
  }

  return {
    ...baseTelemetry,
    ...(slice.stepRevision ? { stepRevision: slice.stepRevision } : {}),
    activeConversation: slice.activeConversation,
    quotas: nextQuotas,
    consumption: nextCons,
    ...(nextRunning ? { runningConversations: nextRunning } : {}),
  };
}

function putConsumptionRangeCacheEntry(cacheKey, entry) {
  if (!cacheKey || !entry) return;
  consumptionRangeCache.delete(cacheKey);
  consumptionRangeCache.set(cacheKey, entry);
  while (consumptionRangeCache.size > MAX_CONSUMPTION_RANGE_CACHE) {
    consumptionRangeCache.delete(consumptionRangeCache.keys().next().value);
  }
}

function recordConsumptionSliceToCache(
  cons,
  modelBreakdown,
  { customStartMs = 0, customEndMs = 0, usageRevision = 0 } = {}
) {
  const rangeKey = String(cons?.selectedRange?.key || '');
  if (!rangeKey) return;
  const cacheKey = makeConsumptionRangeCacheKey(
    rangeKey,
    rangeKey === 'custom' ? customStartMs || cons.selectedRange?.startMs || 0 : 0,
    rangeKey === 'custom' ? customEndMs || cons.selectedRange?.endMs || 0 : 0
  );
  putConsumptionRangeCacheEntry(cacheKey, {
    revision: Number(cons.revision ?? usageRevision ?? 0),
    selectedRange: cons.selectedRange,
    session: cons.session,
    account: cons.account,
    trendSeries: Array.isArray(cons.trendSeries) ? cons.trendSeries : [],
    sourcesBreakdown: Array.isArray(cons.sourcesBreakdown) ? cons.sourcesBreakdown : [],
    modelBreakdown: Array.isArray(modelBreakdown) ? modelBreakdown : [],
  });
}

function applyCachedConsumptionSlice(baseTelemetry, cachedEntry, targetRevision = 0) {
  if (!baseTelemetry || !cachedEntry) return baseTelemetry;
  const prevCons = baseTelemetry.consumption || {};
  return {
    ...baseTelemetry,
    consumption: {
      ...prevCons,
      ...(targetRevision > 0 ? { revision: targetRevision } : {}),
      selectedRange: cachedEntry.selectedRange,
      session: cachedEntry.session ?? prevCons.session,
      account: cachedEntry.account ?? prevCons.account,
      trendSeries: cachedEntry.trendSeries,
      sourcesBreakdown: cachedEntry.sourcesBreakdown,
    },
    modelBreakdown: cachedEntry.modelBreakdown,
  };
}

function hasAllPresetRangesCached(expectedRevision) {
  for (const key of CONSUMPTION_PRESET_KEYS) {
    const entry = consumptionRangeCache.get(key);
    if (!entry) return false;
    if (expectedRevision > 0 && entry.revision !== expectedRevision) return false;
  }
  return true;
}

function enqueueSettingsWrite(task) {
  const run = settingsWriteChain.then(task, task);
  settingsWriteChain = run.catch(() => {});
  return run;
}

function extractReturnedSettings(res) {
  if (!res || typeof res !== 'object') return null;
  if (res.settings && typeof res.settings === 'object' && !Array.isArray(res.settings)) {
    return res.settings;
  }
  if (
    typeof res.language === 'string' ||
    typeof res.themeAccent === 'string' ||
    typeof res.windowMountMode === 'string'
  ) {
    return res;
  }
  return null;
}

function reconcileIncomingTelemetrySettings(payload, reqSettingsRev) {
  if (!payload?.settings || typeof payload.settings !== 'object') {
    return payload;
  }
  for (const [k, entry] of [...recentCommittedSettings.entries()]) {
    if (reqSettingsRev >= entry.rev) {
      recentCommittedSettings.delete(k);
    }
  }
  if (pendingSettingsMutations.size === 0 && recentCommittedSettings.size === 0) {
    return payload;
  }
  let merged = null;
  for (const [k, entry] of recentCommittedSettings.entries()) {
    if (reqSettingsRev < entry.rev) {
      merged ??= { ...payload.settings };
      merged[k] = entry.value;
    }
  }
  for (const [k, entry] of pendingSettingsMutations.entries()) {
    merged ??= { ...payload.settings };
    merged[k] = entry.value;
  }
  return merged ? { ...payload, settings: merged } : payload;
}

const CLIENT_TOPBAR_SLOT_KEYS = TOPBAR_SLOT_KEYS;
const DEFAULT_CLIENT_TOPBAR_SLOTS = DEFAULT_TOPBAR_SLOTS;
const CLIENT_OVERVIEW_MODULE_KEYS = OVERVIEW_MODULE_KEYS;
const DEFAULT_CLIENT_OVERVIEW_MODULES = DEFAULT_OVERVIEW_MODULES;
const DEFAULT_CLIENT_HOVER_MODULES = DEFAULT_HOVER_MODULES;
const CLIENT_OVERVIEW_METRIC_KEYS = OVERVIEW_METRIC_KEYS;
const DEFAULT_CLIENT_OVERVIEW_METRICS = DEFAULT_OVERVIEW_METRICS;
const CLIENT_STEP_COLUMN_KEYS = STEP_TABLE_COLUMN_KEYS;
const DEFAULT_CLIENT_STEP_COLUMNS = DEFAULT_STEP_TABLE_COLUMNS;
const DEFAULT_CLIENT_STEP_TOKEN_COMBO_FORMAT = DEFAULT_STEP_TOKEN_COMBO_FORMAT;
const MIN_CLIENT_POPOVER_WIDTH = MIN_POPOVER_WIDTH;
const MAX_CLIENT_POPOVER_WIDTH = MAX_POPOVER_WIDTH;
const DEFAULT_CLIENT_POPOVER_WIDTH = DEFAULT_POPOVER_WIDTH;

const parseClientStepTokenComboSegments = parseStepTokenComboSegments;
const normalizeClientStepTokenComboFormat = normalizeStepTokenComboFormat;
const normalizeClientPopoverWidthMode = normalizePopoverWidthMode;
const normalizeClientPopoverWidth = normalizePopoverWidth;
const normalizeClientModelDisplayMode = normalizeModelDisplayMode;
const normalizeClientTopbarSlots = normalizeTopbarCapsuleSlots;
const normalizeClientHoverModules = normalizeHoverModules;
const normalizeClientOverviewModules = normalizeOverviewModules;
const normalizeClientOverviewMetrics = normalizeOverviewMetrics;
const normalizeClientStepColumns = normalizeStepTableColumns;
const normalizeClientUpdateMode = normalizePluginUpdateMode;
const normalizeClientOrchestratorIdMode = normalizeOrchestratorIdMode;
const normalizeClientWindowMountMode = normalizeWindowMountMode;

function isEquivalentTelemetry(prev, next) {
  if (!prev || !next) return false;
  if (prev === next) return true;

  const sameArr = (a, b) => {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  };
  // 1. 比对系统设置项（外观语言/主题/字号、模型显示策略、更新策略、挂载与结构布局配置）
  const pAct = prev.activeConversation;
  const nAct = next.activeConversation;
  const pSet = prev.settings;
  const nSet = next.settings;

  if ((pSet?.language ?? 'zh-CN') !== (nSet?.language ?? 'zh-CN')) return false;
  if ((pSet?.themeAccent ?? 'host') !== (nSet?.themeAccent ?? 'host')) return false;
  if ((pSet?.fontScale ?? 'md') !== (nSet?.fontScale ?? 'md')) return false;
  if (Boolean(pSet?.experimentalModernUi) !== Boolean(nSet?.experimentalModernUi)) return false;
  if ((prev.hostPlatform || '') !== (next.hostPlatform || '')) return false;
  if (Boolean(pSet?.contextWindowRiskAccepted) !== Boolean(nSet?.contextWindowRiskAccepted)) {
    return false;
  }
  if (
    JSON.stringify(pSet?.modelContextWindows) !== JSON.stringify(nSet?.modelContextWindows) ||
    JSON.stringify(prev.contextWindowModels) !== JSON.stringify(next.contextWindowModels)
  ) {
    return false;
  }
  if (
    normalizeModelDisplayMode(pSet?.modelDisplayMode, pSet?.showUpstreamModel) !==
    normalizeModelDisplayMode(nSet?.modelDisplayMode, nSet?.showUpstreamModel)
  ) {
    return false;
  }
  if (pSet?.showUpstreamModel !== nSet?.showUpstreamModel) return false;
  if (normalizePopoverWidthMode(pSet?.popoverWidthMode) !== normalizePopoverWidthMode(nSet?.popoverWidthMode)) {
    return false;
  }
  if (normalizePopoverWidth(pSet?.popoverWidth) !== normalizePopoverWidth(nSet?.popoverWidth)) {
    return false;
  }
  if (
    String(pSet?.stepTokenComboFormat ?? DEFAULT_STEP_TOKEN_COMBO_FORMAT).trim() !==
    String(nSet?.stepTokenComboFormat ?? DEFAULT_STEP_TOKEN_COMBO_FORMAT).trim()
  ) {
    return false;
  }
  if (
    normalizeOrchestratorIdMode(pSet?.orchestratorIdMode) !==
    normalizeOrchestratorIdMode(nSet?.orchestratorIdMode)
  ) {
    return false;
  }
  if (pSet?.weeklyLimitMode !== nSet?.weeklyLimitMode) return false;
  if (pSet?.weeklyTokenBudget !== nSet?.weeklyTokenBudget) return false;
  if (pSet?.weeklyCostBudget !== nSet?.weeklyCostBudget) return false;
  if ((pSet?.pluginUpdateMode ?? '') !== (nSet?.pluginUpdateMode ?? '')) return false;
  if (pSet?.autoUpdatePlugin !== nSet?.autoUpdatePlugin) return false;
  if (
    normalizeClientWindowMountMode(pSet?.windowMountMode, pSet?.enableWindowOverlay) !==
    normalizeClientWindowMountMode(nSet?.windowMountMode, nSet?.enableWindowOverlay)
  ) {
    return false;
  }
  if (pSet?.enableWindowOverlay !== nSet?.enableWindowOverlay) return false;
  if ((pSet?.enableCliStatusLine !== false) !== (nSet?.enableCliStatusLine !== false)) {
    return false;
  }
  if ((pSet?.showTopbarMultiSession !== false) !== (nSet?.showTopbarMultiSession !== false)) {
    return false;
  }
  if (Boolean(pSet?.showStepTurnRail) !== Boolean(nSet?.showStepTurnRail)) {
    return false;
  }
  if ((pSet?.showStepAgentBadge !== false) !== (nSet?.showStepAgentBadge !== false)) {
    return false;
  }
  if (Boolean(pSet?.showStepSpeedColor) !== Boolean(nSet?.showStepSpeedColor)) {
    return false;
  }
  if (!sameArr(pSet?.topbarCapsuleSlots, nSet?.topbarCapsuleSlots)) return false;
  if (!sameArr(pSet?.hoverModules, nSet?.hoverModules)) return false;
  if (!sameArr(pSet?.overviewModules, nSet?.overviewModules)) return false;
  if (!sameArr(pSet?.overviewMetrics, nSet?.overviewMetrics)) return false;
  if (!sameArr(pSet?.stepTableColumns, nSet?.stepTableColumns)) return false;

  // 2. 比对云端状态与桥接健康度
  const pWb = prev.windowBridge;
  const nWb = next.windowBridge;
  if (
    (pWb?.state || '') !== (nWb?.state || '') ||
    Boolean(pWb?.argvUpdatedThisBoot) !== Boolean(nWb?.argvUpdatedThisBoot) ||
    Boolean(pWb?.argvConfigured) !== Boolean(nWb?.argvConfigured) ||
    Boolean(pWb?.launcherConfigured) !== Boolean(nWb?.launcherConfigured) ||
    Boolean(pWb?.canRelaunch) !== Boolean(nWb?.canRelaunch) ||
    Number(pWb?.aliveCount || 0) !== Number(nWb?.aliveCount || 0)
  ) {
    return false;
  }
  const pCloud = prev.cloudStatus;
  const nCloud = next.cloudStatus;
  if (
    pCloud?.currentPluginVersion !== nCloud?.currentPluginVersion ||
    pCloud?.latestPluginVersion !== nCloud?.latestPluginVersion ||
    pCloud?.updateAvailable !== nCloud?.updateAvailable ||
    pCloud?.installMode !== nCloud?.installMode ||
    pCloud?.catalogVersion !== nCloud?.catalogVersion ||
    pCloud?.source !== nCloud?.source ||
    pCloud?.lastSyncedAtMs !== nCloud?.lastSyncedAtMs ||
    pCloud?.modelCount !== nCloud?.modelCount ||
    pCloud?.isSyncing !== nCloud?.isSyncing ||
    pCloud?.isUpdating !== nCloud?.isUpdating ||
    pCloud?.lastSyncError !== nCloud?.lastSyncError ||
    pCloud?.lastUpdateError !== nCloud?.lastUpdateError ||
    pCloud?.lastUpdateResult?.updatedAtMs !== nCloud?.lastUpdateResult?.updatedAtMs
  ) {
    return false;
  }

  // 3. 比对活跃会话的实时测速指标
  if (pAct?.cascadeId !== nAct?.cascadeId) return false;
  if (pAct?.stepCount !== nAct?.stepCount) return false;
  if (pAct?.subagentCount !== nAct?.subagentCount) return false;
  if ((pAct?.swarmCount || 0) !== (nAct?.swarmCount || 0)) return false;
  if ((pAct?.swarmTitle || '') !== (nAct?.swarmTitle || '')) return false;
  if (pAct?.totalStepsAllAgents !== nAct?.totalStepsAllAgents) return false;
  if (pAct?.isRunning !== nAct?.isRunning) return false;
  if (
    pAct?.inputTokens !== nAct?.inputTokens ||
    pAct?.cacheReadTokens !== nAct?.cacheReadTokens ||
    pAct?.outputTokens !== nAct?.outputTokens ||
    pAct?.totalTokens !== nAct?.totalTokens
  ) {
    return false;
  }
  if (
    pAct?.liveActivity?.signature !== nAct?.liveActivity?.signature ||
    pAct?.liveActivity?.startedAtMs !== nAct?.liveActivity?.startedAtMs
  ) {
    return false;
  }
  if (pAct?.aggregated?.isRunning !== nAct?.aggregated?.isRunning) return false;
  if (
    pAct?.aggregated?.inputTokens !== nAct?.aggregated?.inputTokens ||
    pAct?.aggregated?.cacheReadTokens !== nAct?.aggregated?.cacheReadTokens ||
    pAct?.aggregated?.outputTokens !== nAct?.aggregated?.outputTokens ||
    pAct?.aggregated?.totalTokens !== nAct?.aggregated?.totalTokens
  ) {
    return false;
  }
  if (
    pAct?.aggregated?.liveActivity?.signature !== nAct?.aggregated?.liveActivity?.signature ||
    pAct?.aggregated?.liveActivity?.startedAtMs !== nAct?.aggregated?.liveActivity?.startedAtMs
  ) {
    return false;
  }
  if (pAct?.aggregated?.liveActivity?.agentId !== nAct?.aggregated?.liveActivity?.agentId) return false;
  if (pAct?.aggregated?.activeAgentId !== nAct?.aggregated?.activeAgentId) return false;
  if (pAct?.aggregated?.activeAgentBadge !== nAct?.aggregated?.activeAgentBadge) return false;
  if (pAct?.aggregated?.latestTokPerSec !== nAct?.aggregated?.latestTokPerSec) return false;
  if (pAct?.aggregated?.latestTtftSec !== nAct?.aggregated?.latestTtftSec) return false;
  if (pAct?.aggregated?.avgTokPerSec !== nAct?.aggregated?.avgTokPerSec) return false;
  if (pAct?.aggregated?.latestStepCostUsd !== nAct?.aggregated?.latestStepCostUsd) return false;
  if (pAct?.aggregated?.sessionCostUsd !== nAct?.aggregated?.sessionCostUsd) return false;
  if (pAct?.aggregated?.sessionUnpricedCalls !== nAct?.aggregated?.sessionUnpricedCalls) return false;
  if (pAct?.aggregated?.sessionCacheHitPct !== nAct?.aggregated?.sessionCacheHitPct) return false;
  if (pAct?.aggregated?.activeModelShort !== nAct?.aggregated?.activeModelShort) return false;
  if (pAct?.aggregated?.activeModelUpstream !== nAct?.aggregated?.activeModelUpstream) return false;
  if (pAct?.aggregated?.latestCacheHitPct !== nAct?.aggregated?.latestCacheHitPct) return false;
  if (pAct?.aggregated?.latestSpeedReason !== nAct?.aggregated?.latestSpeedReason) return false;
  if (pAct?.latestTokPerSec !== nAct?.latestTokPerSec) return false;
  if (pAct?.latestTtftSec !== nAct?.latestTtftSec) return false;
  if (pAct?.avgTokPerSec !== nAct?.avgTokPerSec) return false;
  if (pAct?.latestCacheHitPct !== nAct?.latestCacheHitPct) return false;
  if (pAct?.sessionCacheHitPct !== nAct?.sessionCacheHitPct) return false;
  if (pAct?.latestSpeedReason !== nAct?.latestSpeedReason) return false;
  if (pAct?.ttftSummary?.avgSec !== nAct?.ttftSummary?.avgSec) return false;
  if (pAct?.speedSummary?.sampleCount !== nAct?.speedSummary?.sampleCount) return false;
  if (
    pAct?.activeModelShort !== nAct?.activeModelShort ||
    pAct?.activeModelLabel !== nAct?.activeModelLabel ||
    pAct?.activeModelUpstream !== nAct?.activeModelUpstream
  ) {
    return false;
  }
  if (
    pAct?.latestStepCostUsd !== nAct?.latestStepCostUsd ||
    pAct?.sessionCostUsd !== nAct?.sessionCostUsd ||
    pAct?.sessionUnpricedCalls !== nAct?.sessionUnpricedCalls
  ) {
    return false;
  }

  const pAgents = pAct?.agents || [];
  const nAgents = nAct?.agents || [];
  if (pAgents.length !== nAgents.length) return false;
  for (let i = 0; i < pAgents.length; i++) {
    const pa = pAgents[i];
    const na = nAgents[i];
    if (
      pa?.agentId !== na?.agentId ||
      pa?.agentKind !== na?.agentKind ||
      pa?.agentOrdinal !== na?.agentOrdinal ||
      (pa?.swarmState || '') !== (na?.swarmState || '') ||
      pa?.role !== na?.role ||
      pa?.stepCount !== na?.stepCount ||
      pa?.isRunning !== na?.isRunning ||
      pa?.liveActivity?.signature !== na?.liveActivity?.signature ||
      pa?.latestTokPerSec !== na?.latestTokPerSec ||
      pa?.latestTtftSec !== na?.latestTtftSec ||
      pa?.avgTokPerSec !== na?.avgTokPerSec ||
      pa?.latestCacheHitPct !== na?.latestCacheHitPct ||
      pa?.sessionCacheHitPct !== na?.sessionCacheHitPct ||
      pa?.latestSpeedReason !== na?.latestSpeedReason ||
      pa?.latestStepCostUsd !== na?.latestStepCostUsd ||
      pa?.sessionCostUsd !== na?.sessionCostUsd ||
      pa?.sessionUnpricedCalls !== na?.sessionUnpricedCalls ||
      pa?.activeModelShort !== na?.activeModelShort ||
      pa?.activeModelUpstream !== na?.activeModelUpstream ||
      pa?.context?.totalTokens !== na?.context?.totalTokens ||
      pa?.context?.compactionLimitTokens !== na?.context?.compactionLimitTokens ||
      pa?.context?.limitTokens !== na?.context?.limitTokens ||
      pa?.context?.messagesTokens !== na?.context?.messagesTokens ||
      pa?.context?.toolResultsTokens !== na?.context?.toolResultsTokens ||
      pa?.context?.assistantTokens !== na?.context?.assistantTokens ||
      pa?.context?.userInputTokens !== na?.context?.userInputTokens ||
      pa?.context?.subagentTokens !== na?.context?.subagentTokens ||
      pa?.context?.checkpointTokens !== na?.context?.checkpointTokens ||
      pa?.context?.systemToolsTokens !== na?.context?.systemToolsTokens ||
      pa?.context?.mcpToolsTokens !== na?.context?.mcpToolsTokens ||
      pa?.context?.skillsTokens !== na?.context?.skillsTokens ||
      pa?.context?.systemPromptTokens !== na?.context?.systemPromptTokens ||
      pa?.context?.userRulesTokens !== na?.context?.userRulesTokens
    ) {
      return false;
    }
    // 主代理步骤由根会话统一比对，避免明细视图组装后的引用造成重复比对。
    const paSteps = pa?.isMain && pAct?.recentSteps ? [] : pa?.recentSteps || [];
    const naSteps = na?.isMain && nAct?.recentSteps ? [] : na?.recentSteps || [];
    if (paSteps.length !== naSteps.length) return false;
    for (let j = 0; paSteps !== naSteps && j < paSteps.length; j++) {
      const bs = paSteps[j];
      const as = naSteps[j];
      if (
        bs?.stepIndex !== as?.stepIndex ||
        bs?.createdAtMs !== as?.createdAtMs ||
        bs?.totalDurationSec !== as?.totalDurationSec ||
        bs?.streamDurationSec !== as?.streamDurationSec ||
        bs?.modelKey !== as?.modelKey ||
        bs?.modelShort !== as?.modelShort ||
        bs?.modelLabel !== as?.modelLabel ||
        bs?.modelUpstream !== as?.modelUpstream ||
        bs?.responseModel !== as?.responseModel ||
        bs?.modelSource !== as?.modelSource ||
        bs?.costUsd !== as?.costUsd ||
        bs?.tokPerSec !== as?.tokPerSec ||
        bs?.ttftSec !== as?.ttftSec ||
        bs?.outputTokens !== as?.outputTokens ||
        bs?.thinkingTokens !== as?.thinkingTokens ||
        bs?.responseTokens !== as?.responseTokens ||
        bs?.inputTokens !== as?.inputTokens ||
        bs?.cacheReadTokens !== as?.cacheReadTokens ||
        bs?.contextTokens !== as?.contextTokens ||
        bs?.cacheHitPct !== as?.cacheHitPct ||
        bs?.selectedSpeedReason !== as?.selectedSpeedReason ||
        bs?.anomalySig !== as?.anomalySig ||
        JSON.stringify(bs?.requestDiagnostics) !== JSON.stringify(as?.requestDiagnostics) ||
        bs?.turnIndex !== as?.turnIndex ||
        bs?.rootTurnIndex !== as?.rootTurnIndex ||
        bs?.isTurnStart !== as?.isTurnStart ||
        bs?.isRootTurnStart !== as?.isRootTurnStart ||
        bs?.isLatestTurn !== as?.isLatestTurn ||
        bs?.isRootLatestTurn !== as?.isRootLatestTurn ||
        bs?.turnPrompt !== as?.turnPrompt ||
        bs?.rootTurnPrompt !== as?.rootTurnPrompt
      ) {
        return false;
      }
    }
  }

  // 4. 比对 10 通道上下文窗口构成及近期步骤明细
  const pCtx = pAct?.context;
  const nCtx = nAct?.context;
  if (pCtx?.totalTokens !== nCtx?.totalTokens) return false;
  if (pCtx?.compactionLimitTokens !== nCtx?.compactionLimitTokens) return false;
  if (pCtx?.limitTokens !== nCtx?.limitTokens) return false;
  if (pCtx?.messagesTokens !== nCtx?.messagesTokens) return false;
  if (pCtx?.assistantTokens !== nCtx?.assistantTokens) return false;
  if (pCtx?.toolResultsTokens !== nCtx?.toolResultsTokens) return false;
  if (pCtx?.userInputTokens !== nCtx?.userInputTokens) return false;
  if (pCtx?.subagentTokens !== nCtx?.subagentTokens) return false;
  if (pCtx?.checkpointTokens !== nCtx?.checkpointTokens) return false;
  if (pCtx?.systemToolsTokens !== nCtx?.systemToolsTokens) return false;
  if (pCtx?.mcpToolsTokens !== nCtx?.mcpToolsTokens) return false;
  if (pCtx?.skillsTokens !== nCtx?.skillsTokens) return false;
  if (pCtx?.systemPromptTokens !== nCtx?.systemPromptTokens) return false;
  if (pCtx?.userRulesTokens !== nCtx?.userRulesTokens) return false;
  if ((pAct?.recentSteps?.length || 0) !== (nAct?.recentSteps?.length || 0)) return false;
  for (let i = 0; pAct?.recentSteps !== nAct?.recentSteps && i < (pAct?.recentSteps?.length || 0); i++) {
    const before = pAct.recentSteps[i], after = nAct.recentSteps[i];
    if (
      before.stepIndex !== after.stepIndex ||
      before.createdAtMs !== after.createdAtMs ||
      before.totalDurationSec !== after.totalDurationSec ||
      before.streamDurationSec !== after.streamDurationSec ||
      before.modelKey !== after.modelKey ||
      before.modelShort !== after.modelShort ||
      before.modelLabel !== after.modelLabel ||
      before.modelUpstream !== after.modelUpstream ||
      before.responseModel !== after.responseModel ||
      before.modelSource !== after.modelSource ||
      before.costUsd !== after.costUsd ||
      before.tokPerSec !== after.tokPerSec ||
      before.ttftSec !== after.ttftSec ||
      before.outputTokens !== after.outputTokens ||
      before.thinkingTokens !== after.thinkingTokens ||
      before.responseTokens !== after.responseTokens ||
      before.inputTokens !== after.inputTokens ||
      before.cacheReadTokens !== after.cacheReadTokens ||
      before.contextTokens !== after.contextTokens ||
      before.cacheHitPct !== after.cacheHitPct ||
      before.selectedSpeedReason !== after.selectedSpeedReason ||
      before.anomalySig !== after.anomalySig ||
      JSON.stringify(before.requestDiagnostics) !== JSON.stringify(after.requestDiagnostics) ||
      before.turnIndex !== after.turnIndex ||
      before.rootTurnIndex !== after.rootTurnIndex ||
      before.isTurnStart !== after.isTurnStart ||
      before.isRootTurnStart !== after.isRootTurnStart ||
      before.isLatestTurn !== after.isLatestTurn ||
      before.isRootLatestTurn !== after.isRootLatestTurn ||
      before.turnPrompt !== after.turnPrompt ||
      before.rootTurnPrompt !== after.rootTurnPrompt
    ) {
      return false;
    }
  }

  // 5. 比对消费统计所选时间区间、当前会话累计消费与账号全局累计消费
  const pRange = prev.consumption?.selectedRange;
  const nRange = next.consumption?.selectedRange;
  if (pRange?.key !== nRange?.key) return false;
  if (nRange?.key === 'custom') {
    if (pRange?.startMs !== nRange?.startMs || pRange?.endMs !== nRange?.endMs) return false;
  }

  const pCons = prev.consumption?.session;
  const nCons = next.consumption?.session;
  if (pCons?.totalTokens !== nCons?.totalTokens) return false;
  if (pCons?.costUsd !== nCons?.costUsd) return false;
  if (pCons?.unpricedCalls !== nCons?.unpricedCalls) return false;

  const pAcct = prev.consumption?.account;
  const nAcct = next.consumption?.account;
  if (pAcct?.totalTokens !== nAcct?.totalTokens) return false;
  if (pAcct?.inputTokens !== nAcct?.inputTokens) return false;
  if (pAcct?.cacheReadTokens !== nAcct?.cacheReadTokens) return false;
  if (pAcct?.outputTokens !== nAcct?.outputTokens) return false;
  if (pAcct?.calls !== nAcct?.calls) return false;
  if (pAcct?.costUsd !== nAcct?.costUsd) return false;
  if (pAcct?.savedCostUsd !== nAcct?.savedCostUsd) return false;
  if (pAcct?.cacheHitPct !== nAcct?.cacheHitPct) return false;
  if (pAcct?.unpricedCalls !== nAcct?.unpricedCalls) return false;

  // 6. 比对历史趋势时间分桶序列与年度分月序列
  const areModelSlicesEqual = (pList, nList) => {
    const a = pList || [];
    const b = nList || [];
    if (a.length !== b.length) return false;
    for (let k = 0; k < a.length; k++) {
      if (
        a[k]?.label !== b[k]?.label ||
        a[k]?.shortName !== b[k]?.shortName ||
        a[k]?.upstreamName !== b[k]?.upstreamName ||
        a[k]?.costUsd !== b[k]?.costUsd ||
        a[k]?.unpricedCalls !== b[k]?.unpricedCalls ||
        a[k]?.totalTokens !== b[k]?.totalTokens ||
        a[k]?.calls !== b[k]?.calls ||
        Number(a[k]?.anomalyCount || 0) !== Number(b[k]?.anomalyCount || 0) ||
        Number(a[k]?.anomalySteps || 0) !== Number(b[k]?.anomalySteps || 0)
      ) {
        return false;
      }
    }
    return true;
  };

  const pTrend = prev.consumption?.trendSeries || [];
  const nTrend = next.consumption?.trendSeries || [];
  if (pTrend.length !== nTrend.length) return false;
  for (let i = 0; i < pTrend.length; i++) {
    if (
      pTrend[i]?.tokens !== nTrend[i]?.tokens ||
      pTrend[i]?.calls !== nTrend[i]?.calls ||
      pTrend[i]?.label !== nTrend[i]?.label ||
      pTrend[i]?.fullLabel !== nTrend[i]?.fullLabel ||
      !areModelSlicesEqual(pTrend[i]?.models, nTrend[i]?.models)
    ) {
      return false;
    }
  }
  if (prev.consumption?.monthlyYear !== next.consumption?.monthlyYear) return false;

  const pMonthly = prev.consumption?.monthlySeries || [];
  const nMonthly = next.consumption?.monthlySeries || [];
  if (pMonthly.length !== nMonthly.length) return false;
  for (let i = 0; i < pMonthly.length; i++) {
    if (
      pMonthly[i]?.totalTokens !== nMonthly[i]?.totalTokens ||
      pMonthly[i]?.costUsd !== nMonthly[i]?.costUsd ||
      pMonthly[i]?.calls !== nMonthly[i]?.calls ||
      !areModelSlicesEqual(pMonthly[i]?.models, nMonthly[i]?.models)
    ) {
      return false;
    }
  }

  // 7. 比对按模型汇总明细与数据来源汇总明细
  if (!areModelSlicesEqual(pAct?.modelBreakdown, nAct?.modelBreakdown)) {
    return false;
  }
  if (!areModelSlicesEqual(prev.modelBreakdown, next.modelBreakdown)) {
    return false;
  }

  const pSources = prev.consumption?.sourcesBreakdown || [];
  const nSources = next.consumption?.sourcesBreakdown || [];
  if (pSources.length !== nSources.length) return false;
  for (let i = 0; i < pSources.length; i++) {
    if (
      pSources[i]?.name !== nSources[i]?.name ||
      pSources[i]?.costUsd !== nSources[i]?.costUsd ||
      pSources[i]?.unpricedCalls !== nSources[i]?.unpricedCalls ||
      pSources[i]?.totalTokens !== nSources[i]?.totalTokens ||
      pSources[i]?.calls !== nSources[i]?.calls ||
      !areModelSlicesEqual(pSources[i]?.models, nSources[i]?.models)
    ) {
      return false;
    }
  }

  // 8. 比对账号订阅档位与动态多配额池
  if (
    prev.account?.email !== next.account?.email ||
    prev.account?.name !== next.account?.name ||
    prev.account?.status !== next.account?.status ||
    prev.account?.tierName !== next.account?.tierName ||
    prev.account?.planName !== next.account?.planName ||
    prev.account?.aiCredits !== next.account?.aiCredits
  ) {
    return false;
  }

  if (
    prev.quotas?.meta?.refreshFailed !== next.quotas?.meta?.refreshFailed ||
    prev.quotas?.meta?.isStale !== next.quotas?.meta?.isStale
  ) {
    return false;
  }

  const pQuot = prev.quotas?.activePool;
  const nQuot = next.quotas?.activePool;
  if (pQuot?.family !== nQuot?.family) return false;
  if (pQuot?.usedPct !== nQuot?.usedPct) return false;
  if (pQuot?.remainingPct !== nQuot?.remainingPct) return false;
  if (pQuot?.weeklyUsedPct !== nQuot?.weeklyUsedPct) return false;
  if (pQuot?.weeklyRemainingPct !== nQuot?.weeklyRemainingPct) return false;
  if (prev.quotas?.weekly?.usedPct !== next.quotas?.weekly?.usedPct) return false;
  if (prev.quotas?.weekly?.remainingPct !== next.quotas?.weekly?.remainingPct) return false;
  if (prev.quotas?.weekly?.tokens !== next.quotas?.weekly?.tokens) return false;
  if (prev.quotas?.weekly?.costUsd !== next.quotas?.weekly?.costUsd) return false;
  if (prev.quotas?.weekly?.calls !== next.quotas?.weekly?.calls) return false;
  if (prev.quotas?.weekly?.unpricedCalls !== next.quotas?.weekly?.unpricedCalls) return false;
  if (prev.quotas?.weekly?.resetTime !== next.quotas?.weekly?.resetTime) return false;

  const pPools = prev.quotas?.pools || [];
  const nPools = next.quotas?.pools || [];
  if (pPools.length !== nPools.length) return false;
  for (let i = 0; i < pPools.length; i++) {
    if (
      pPools[i]?.poolKey !== nPools[i]?.poolKey ||
      pPools[i]?.poolLabel !== nPools[i]?.poolLabel ||
      pPools[i]?.usedPct !== nPools[i]?.usedPct ||
      pPools[i]?.remainingPct !== nPools[i]?.remainingPct ||
      pPools[i]?.resetTime !== nPools[i]?.resetTime ||
      pPools[i]?.weeklyUsedPct !== nPools[i]?.weeklyUsedPct ||
      pPools[i]?.weeklyRemainingPct !== nPools[i]?.weeklyRemainingPct ||
      pPools[i]?.weeklyResetTime !== nPools[i]?.weeklyResetTime ||
      pPools[i]?.cycle5h?.tokens !== nPools[i]?.cycle5h?.tokens ||
      pPools[i]?.cycle5h?.costUsd !== nPools[i]?.cycle5h?.costUsd ||
      pPools[i]?.cycle5h?.calls !== nPools[i]?.cycle5h?.calls ||
      pPools[i]?.cycleWeekly?.tokens !== nPools[i]?.cycleWeekly?.tokens ||
      pPools[i]?.cycleWeekly?.costUsd !== nPools[i]?.cycleWeekly?.costUsd ||
      pPools[i]?.cycleWeekly?.calls !== nPools[i]?.cycleWeekly?.calls
    ) {
      return false;
    }
  }

  const pConvs = prev.conversations || [];
  const nConvs = next.conversations || [];
  if (pConvs.length !== nConvs.length) return false;
  for (let i = 0; i < pConvs.length; i++) {
    if (
      pConvs[i]?.cascadeId !== nConvs[i]?.cascadeId ||
      pConvs[i]?.title !== nConvs[i]?.title ||
      pConvs[i]?.status !== nConvs[i]?.status ||
      pConvs[i]?.stepCount !== nConvs[i]?.stepCount ||
      pConvs[i]?.subagentCount !== nConvs[i]?.subagentCount ||
      (pConvs[i]?.swarmCount || 0) !== (nConvs[i]?.swarmCount || 0) ||
      (pConvs[i]?.swarmTitle || '') !== (nConvs[i]?.swarmTitle || '') ||
      pConvs[i]?.totalStepCount !== nConvs[i]?.totalStepCount
    ) {
      return false;
    }
  }

  const pRunning = prev.runningConversations || [];
  const nRunning = next.runningConversations || [];
  if (pRunning.length !== nRunning.length) return false;
  for (let i = 0; i < pRunning.length; i++) {
    const pr = pRunning[i];
    const nr = nRunning[i];
    if (
      pr?.cascadeId !== nr?.cascadeId ||
      pr?.title !== nr?.title ||
      pr?.isCurrentSelected !== nr?.isCurrentSelected ||
      pr?.isMainRunning !== nr?.isMainRunning ||
      pr?.subagentCount !== nr?.subagentCount ||
      (pr?.swarmCount || 0) !== (nr?.swarmCount || 0) ||
      pr?.runningSubagentCount !== nr?.runningSubagentCount ||
      (pr?.runningSwarmCount || 0) !== (nr?.runningSwarmCount || 0) ||
      pr?.mainActivity?.signature !== nr?.mainActivity?.signature ||
      pr?.mainActivity?.startedAtMs !== nr?.mainActivity?.startedAtMs
    ) {
      return false;
    }
    const pSubs = pr?.subagents || [];
    const nSubs = nr?.subagents || [];
    if (pSubs.length !== nSubs.length) return false;
    for (let j = 0; j < pSubs.length; j++) {
      if (
        pSubs[j]?.cascadeId !== nSubs[j]?.cascadeId ||
        pSubs[j]?.agentKind !== nSubs[j]?.agentKind ||
        (pSubs[j]?.swarmState || '') !== (nSubs[j]?.swarmState || '') ||
        pSubs[j]?.role !== nSubs[j]?.role ||
        pSubs[j]?.isRunning !== nSubs[j]?.isRunning ||
        pSubs[j]?.stepCount !== nSubs[j]?.stepCount ||
        pSubs[j]?.liveActivity?.signature !== nSubs[j]?.liveActivity?.signature ||
        pSubs[j]?.liveActivity?.startedAtMs !== nSubs[j]?.liveActivity?.startedAtMs
      ) {
        return false;
      }
    }
  }

  return true;
}

async function fetchTelemetry({ force = false } = {}) {
  if (!force && activeForceCount > 0) {
    return telemetryStore.getState().telemetry;
  }

  const overlay = isWindowOverlayMode();
  if (overlay) {
    const st = telemetryStore.getState();
    const liveRouteId = extractHostRouteCascadeId();
    if (liveRouteId !== st.hostRouteConversationId) {
      const patch = { hostRouteConversationId: liveRouteId };
      if (liveRouteId && st.selectedConversationId && st.selectedConversationId !== liveRouteId) {
        patch.selectedConversationId = '';
      }
      telemetryStore.setState(patch);
    }
  }
  const current = telemetryStore.getState();
  const effectiveConvId = current.selectedConversationId || current.hostRouteConversationId || '';
  const params = new URLSearchParams();
  if (effectiveConvId) params.set('conversationId', effectiveConvId);
  if (current.selectedTimeRange) params.set('range', current.selectedTimeRange);
  if (current.selectedTimeRange === 'custom') {
    if (current.customStartMs > 0) params.set('startMs', String(current.customStartMs));
    if (current.customEndMs > 0) params.set('endMs', String(current.customEndMs));
  }
  if (force) params.set('force', '1');
  params.set('stepDetails', 'display');

  if (force) {
    inFlightTelemetryPoll = null;
    return requestTelemetry(params, true);
  }
  const query = params.toString();
  const bridge = overlay ? getWindowBridgeConfig() : null;
  const existing = inFlightTelemetryPoll;
  if (existing?.query === query && existing.port === bridge?.port && existing.token === bridge?.token) {
    return existing.promise;
  }
  const poll = { query, port: bridge?.port, token: bridge?.token, promise: null };
  poll.promise = requestTelemetry(params, false).finally(() => {
    if (inFlightTelemetryPoll === poll) inFlightTelemetryPoll = null;
  });
  inFlightTelemetryPoll = poll;
  return poll.promise;
}

function readDisplaySteps(payload) {
  const active = payload?.activeConversation;
  if (!payload?.stepRevision || !Array.isArray(active?.recentSteps)) return null;
  return {
    revision: payload.stepRevision,
    recentSteps: active.recentSteps,
    agentSteps: active.agents.map((agent) => agent.recentSteps === active.recentSteps
      ? undefined
      : agent.recentSteps),
  };
}

async function requestTelemetry(params, force) {
  const reqSeq = ++latestRequestSeq;
  const reqSettingsRev = settingsRevision;
  const reqRange = String(params.get('range') || '');
  const reqStartMs = Number(params.get('startMs') || 0);
  const reqEndMs = Number(params.get('endMs') || 0);
  const startMs = Date.now();

  if (force) {
    activeForceCount += 1;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    telemetryStore.setState({ syncState: 'syncing' });
  }

  try {
    const previousSteps = lastReceivedSteps || readDisplaySteps(telemetryStore.getState().telemetry);
    params.set('stepRevision', previousSteps?.revision || '');
    const payload = await callSidecarApi(`/api/telemetry?${params}`, {
      method: 'GET',
      abortKey: force ? 'telemetry-force' : 'telemetry-poll',
    });

    const active = payload?.activeConversation;
    if (payload?.stepsUnchanged) {
      if (!active || !previousSteps || payload.stepRevision !== previousSteps.revision) {
        throw new Error('Telemetry step revision mismatch');
      }
      active.recentSteps = previousSteps.recentSteps;
      active.agents.forEach((agent, index) => {
        const steps = previousSteps.agentSteps[index];
        if (steps) agent.recentSteps = steps;
      });
    }
    if (reqSeq !== latestRequestSeq) {
      return payload;
    }
    lastReceivedSteps = readDisplaySteps(payload);

    if (payload?.uiBundleVersion) {
      if (activeBundleVersion && activeBundleVersion !== payload.uiBundleVersion) {
        if (
          !isWindowOverlayMode() &&
          typeof window !== 'undefined' &&
          typeof window.location?.reload === 'function'
        ) {
          window.location.reload();
          return payload;
        }
      }
      activeBundleVersion = payload.uiBundleVersion;
    }
    consecutivePollFailures = 0;

    let resolvedPayload = reconcileIncomingTelemetrySettings(payload, reqSettingsRev);
    syncConsumptionCacheScope(resolvedPayload);
    recordConversationViewToCache(resolvedPayload);
    if (resolvedPayload?.consumption) {
      recordConsumptionSliceToCache(resolvedPayload.consumption, resolvedPayload.modelBreakdown, {
        customStartMs: reqStartMs,
        customEndMs: reqEndMs,
      });
    }

    const latestSt = telemetryStore.getState();
    const incomingRev = Number(resolvedPayload?.consumption?.revision || 0);
    const matchesCurrentRange =
      !reqRange ||
      (reqRange === latestSt.selectedTimeRange &&
        (reqRange !== 'custom' ||
          (reqStartMs === Number(latestSt.customStartMs || 0) &&
            reqEndMs === Number(latestSt.customEndMs || 0))));

    // 常规 2 秒轮询在途期间若用户已通过前端缓存瞬切到其他时间段，保留用户当前选中的范围不回跳，
    // 若后端 usageRevision 已推进则静默补发一次轻量范围校准。
    let needsSilentRangeRevalidate = false;
    if (!force && !matchesCurrentRange && resolvedPayload?.consumption) {
      const activeKey = makeConsumptionRangeCacheKey(
        latestSt.selectedTimeRange,
        latestSt.customStartMs,
        latestSt.customEndMs
      );
      const cachedActive = consumptionRangeCache.get(activeKey);
      if (cachedActive) {
        resolvedPayload = applyCachedConsumptionSlice(resolvedPayload, cachedActive, incomingRev);
        if (incomingRev > 0 && cachedActive.revision !== incomingRev) {
          needsSilentRangeRevalidate = true;
        }
      } else if (
        latestSt.telemetry?.consumption?.selectedRange?.key === latestSt.selectedTimeRange
      ) {
        resolvedPayload = {
          ...resolvedPayload,
          consumption: {
            ...resolvedPayload.consumption,
            selectedRange: latestSt.telemetry.consumption.selectedRange,
            session: latestSt.telemetry.consumption.session,
            account: latestSt.telemetry.consumption.account,
            trendSeries: latestSt.telemetry.consumption.trendSeries,
            sourcesBreakdown: latestSt.telemetry.consumption.sourcesBreakdown,
          },
          modelBreakdown: latestSt.telemetry.modelBreakdown,
        };
      }
    }

    if (force) {
      const elapsed = Date.now() - startMs;
      if (elapsed < 220) {
        await new Promise((r) => setTimeout(r, 220 - elapsed));
      }
      if (reqSeq !== latestRequestSeq) {
        return resolvedPayload;
      }
      const finalForcePayload = reconcileIncomingTelemetrySettings(payload, reqSettingsRev);
      if (feedbackTimer) clearTimeout(feedbackTimer);
      telemetryStore.setState({
        telemetry: finalForcePayload,
        minuteTick: Math.floor(Date.now() / 30000),
        syncState: 'synced',
      });
      feedbackTimer = setTimeout(() => {
        feedbackTimer = null;
        telemetryStore.setState({ syncState: 'idle' });
      }, 1100);
      return finalForcePayload;
    } else {
      const isSame = isEquivalentTelemetry(latestSt.telemetry, resolvedPayload);
      const nextTelemetry = isSame ? latestSt.telemetry : resolvedPayload;
      telemetryStore.setState({
        telemetry: nextTelemetry,
        minuteTick: Math.floor(Date.now() / 30000),
        syncState: latestSt.syncState === 'synced' ? 'synced' : 'idle',
      });
      if (needsSilentRangeRevalidate) {
        void fetchConsumptionRangeSlice({
          range: latestSt.selectedTimeRange,
          customStartMs: latestSt.customStartMs,
          customEndMs: latestSt.customEndMs,
        });
      }
      return resolvedPayload;
    }
  } catch (err) {
    if (err?.name === 'AbortError' || reqSeq !== latestRequestSeq) return null;
    consecutivePollFailures += 1;
    if (force || consecutivePollFailures >= 2 || !telemetryStore.getState().telemetry) {
      telemetryStore.setState({ syncState: 'error' });
    }
    return null;
  } finally {
    if (force) {
      activeForceCount = Math.max(0, activeForceCount - 1);
      if (activeForceCount === 0 && loopActive && loopTickFn && !pollTimer) {
        pollTimer = setTimeout(loopTickFn, loopIntervalMs);
      }
    }
  }
}

async function fetchConsumptionRangeSlice({
  range,
  customStartMs = 0,
  customEndMs = 0,
} = {}) {
  const reqSeq = ++latestConsumptionReqSeq;
  const targetRange = String(range || 'today');
  const current = telemetryStore.getState();
  const effectiveConvId = current.selectedConversationId || current.hostRouteConversationId || '';
  const params = new URLSearchParams();
  if (effectiveConvId) params.set('conversationId', effectiveConvId);
  params.set('range', targetRange);
  if (targetRange === 'custom') {
    if (customStartMs > 0) params.set('startMs', String(customStartMs));
    if (customEndMs > 0) params.set('endMs', String(customEndMs));
  }
  params.set('scope', 'consumption');

  try {
    const payload = await callSidecarApi(`/api/telemetry?${params}`, {
      method: 'GET',
      abortKey: 'consumption-range',
    });
    if (!payload || typeof payload !== 'object') return null;

    if (payload.scope === 'consumption' && payload.consumption) {
      const usageRev = Number(payload.usageRevision ?? payload.consumption.revision ?? 0);
      recordConsumptionSliceToCache(payload.consumption, payload.modelBreakdown, {
        customStartMs,
        customEndMs,
        usageRevision: usageRev,
      });
      if (reqSeq !== latestConsumptionReqSeq) return payload;

      const latestSt = telemetryStore.getState();
      const stillMatches =
        latestSt.selectedTimeRange === targetRange &&
        (targetRange !== 'custom' ||
          (Number(latestSt.customStartMs || 0) === Number(customStartMs || 0) &&
            Number(latestSt.customEndMs || 0) === Number(customEndMs || 0)));
      if (!stillMatches) return payload;

      const prevTelemetry = latestSt.telemetry;
      if (prevTelemetry) {
        const nextTelemetry = {
          ...prevTelemetry,
          consumption: {
            ...(prevTelemetry.consumption || {}),
            ...payload.consumption,
            ...(usageRev > 0 ? { revision: usageRev } : {}),
          },
          modelBreakdown: Array.isArray(payload.modelBreakdown)
            ? payload.modelBreakdown
            : prevTelemetry.modelBreakdown,
        };
        if (!isEquivalentTelemetry(prevTelemetry, nextTelemetry)) {
          telemetryStore.setState({ telemetry: nextTelemetry });
        }
      }
      return payload;
    }

    // 冷启动阶段后端尚无基础快照时会回退返回完整 telemetry，直接平滑复用现有状态合并
    if (payload.consumption) {
      syncConsumptionCacheScope(payload);
      recordConsumptionSliceToCache(payload.consumption, payload.modelBreakdown, {
        customStartMs,
        customEndMs,
      });
      if (reqSeq === latestConsumptionReqSeq) {
        const latestSt = telemetryStore.getState();
        if (!isEquivalentTelemetry(latestSt.telemetry, payload)) {
          telemetryStore.setState({ telemetry: payload });
        }
      }
    }
    return payload;
  } catch (err) {
    if (err?.name === 'AbortError') return null;
    return null;
  }
}

/**
 * 快速切换当前查看的会话：
 * - 命中前端 `conversationViewCache` 时，0ms 原子切换当前会话快照，并静默走轻量 `scope=conversation` 校准；
 * - 未命中缓存时直接走零 LS RPC、零全盘扫描的 `scope=conversation` 通道；
 * - 若后端提示该会话需要补读最新运行态或懒迁移字段（`needsBackgroundSync`），展示后再在后台静默补齐。
 */
async function selectConversation(
  nextConvId,
  { hostRouteConversationId = undefined } = {}
) {
  const switchSeq = ++latestConversationSwitchSeq;
  latestRequestSeq += 1;
  inFlightTelemetryPoll = null;
  abortSidecarApiKey('telemetry-poll');
  if (deferredConvSyncTimer) {
    clearTimeout(deferredConvSyncTimer);
    deferredConvSyncTimer = null;
  }

  const targetSelectedId = String(nextConvId || '').trim();
  const prevSt = telemetryStore.getState();
  const nextHostRouteId =
    hostRouteConversationId !== undefined
      ? String(hostRouteConversationId || '').trim()
      : prevSt.hostRouteConversationId;
  const effectiveConvId = targetSelectedId || nextHostRouteId || '';
  const statePatch = {
    selectedConversationId: targetSelectedId,
    ...(hostRouteConversationId !== undefined ? { hostRouteConversationId: nextHostRouteId } : {}),
  };

  const prevTelemetry = prevSt.telemetry;
  const lookupRootId = resolveCachedConversationRootId(prevTelemetry, effectiveConvId);
  const cachedEntry = lookupRootId ? conversationViewCache.get(lookupRootId) : null;
  const cachedSteps =
    cachedEntry && cachedEntry.stepRevision
      ? readDisplaySteps({
          stepRevision: cachedEntry.stepRevision,
          activeConversation: cachedEntry.activeConversation,
        })
      : null;

  if (cachedEntry && prevTelemetry) {
    const optimisticTelemetry = applyConversationSliceToTelemetry(prevTelemetry, cachedEntry);
    if (cachedSteps) {
      lastReceivedSteps = cachedSteps;
    }
    telemetryStore.setState({
      ...statePatch,
      telemetry: optimisticTelemetry,
    });
  } else {
    telemetryStore.setState(statePatch);
  }

  const current = telemetryStore.getState();
  const params = new URLSearchParams();
  if (effectiveConvId) params.set('conversationId', effectiveConvId);
  if (current.selectedTimeRange) params.set('range', current.selectedTimeRange);
  if (current.selectedTimeRange === 'custom') {
    if (current.customStartMs > 0) params.set('startMs', String(current.customStartMs));
    if (current.customEndMs > 0) params.set('endMs', String(current.customEndMs));
  }
  params.set('stepDetails', 'display');
  params.set('stepRevision', cachedSteps?.revision || '');
  params.set('scope', 'conversation');

  const reqSettingsRev = settingsRevision;
  try {
    const payload = await callSidecarApi(`/api/telemetry?${params}`, {
      method: 'GET',
      abortKey: 'conversation-switch',
    });
    if (!payload || typeof payload !== 'object') return null;
    if (switchSeq !== latestConversationSwitchSeq) return payload;

    const latestSt = telemetryStore.getState();
    const latestEffectiveId =
      String(latestSt.selectedConversationId || latestSt.hostRouteConversationId || '').trim();
    if (latestEffectiveId !== effectiveConvId) return payload;

    const active = payload.activeConversation;
    if (payload.stepsUnchanged) {
      const stepsSource =
        (cachedSteps && payload.stepRevision === cachedSteps.revision ? cachedSteps : null) ||
        (lastReceivedSteps && payload.stepRevision === lastReceivedSteps.revision
          ? lastReceivedSteps
          : null);
      if (!active || !stepsSource) {
        return fetchTelemetry({ force: false });
      }
      active.recentSteps = stepsSource.recentSteps;
      active.agents.forEach((agent, index) => {
        const steps = stepsSource.agentSteps[index];
        if (steps) agent.recentSteps = steps;
      });
    }

    if (payload.scope === 'conversation' && active) {
      lastReceivedSteps = readDisplaySteps(payload) || lastReceivedSteps;
      recordConversationViewToCache(payload);
      const baseTelemetry = latestSt.telemetry;
      if (baseTelemetry) {
        const mergedTelemetry = applyConversationSliceToTelemetry(baseTelemetry, {
          activeConversation: active,
          activePool: payload.quotas?.activePool || null,
          weekly: payload.quotas?.weekly || null,
          sessionConsumption: payload.consumption?.session || null,
          sessionPresets: payload.consumption?.sessionPresets || null,
          stepRevision: payload.stepRevision || '',
        });
        if (!isEquivalentTelemetry(baseTelemetry, mergedTelemetry)) {
          telemetryStore.setState({
            telemetry: mergedTelemetry,
            minuteTick: Math.floor(Date.now() / 30000),
          });
        }
      } else {
        return fetchTelemetry({ force: false });
      }
      if (payload.needsBackgroundSync && loopActive && typeof setTimeout === 'function') {
        deferredConvSyncTimer = setTimeout(() => {
          deferredConvSyncTimer = null;
          if (switchSeq === latestConversationSwitchSeq && loopActive) {
            void fetchTelemetry({ force: false });
          }
        }, 35);
      }
      return payload;
    }

    // 冷启动或全新未入缓存会话回退至完整载荷
    const resolvedPayload = reconcileIncomingTelemetrySettings(payload, reqSettingsRev);
    syncConsumptionCacheScope(resolvedPayload);
    lastReceivedSteps = readDisplaySteps(resolvedPayload) || lastReceivedSteps;
    recordConversationViewToCache(resolvedPayload);
    if (resolvedPayload?.consumption) {
      recordConsumptionSliceToCache(resolvedPayload.consumption, resolvedPayload.modelBreakdown, {
        customStartMs: Number(current.customStartMs || 0),
        customEndMs: Number(current.customEndMs || 0),
      });
    }
    if (!isEquivalentTelemetry(latestSt.telemetry, resolvedPayload)) {
      telemetryStore.setState({
        telemetry: resolvedPayload,
        minuteTick: Math.floor(Date.now() / 30000),
        syncState: latestSt.syncState === 'synced' ? 'synced' : 'idle',
      });
    }
    return resolvedPayload;
  } catch (err) {
    if (err?.name === 'AbortError' || switchSeq !== latestConversationSwitchSeq) return null;
    return null;
  }
}

/**
 * 切换「用量统计」时间范围：
 * - 命中前端 rangeCache 时，在单次 setState 内 0ms 原子更新概览/趋势/模型/来源（若 usageRevision 一致则 0 次 HTTP 请求）；
 * - 若后台数据已更新则先 0ms 展示缓存，再静默发起轻量 `scope=consumption` 校准；
 * - 未命中缓存（如自定义时段或进页首 20ms 抢点）则直接走 `<5ms` 的 `scope=consumption` 通道。
 */
function selectConsumptionTimeRange(
  nextRange,
  { customStartMs = undefined, customEndMs = undefined } = {}
) {
  const targetRange = String(nextRange || 'today');
  const prevSt = telemetryStore.getState();
  const nextStartMs =
    targetRange === 'custom'
      ? Number(customStartMs !== undefined ? customStartMs : prevSt.customStartMs || 0)
      : prevSt.customStartMs;
  const nextEndMs =
    targetRange === 'custom'
      ? Number(customEndMs !== undefined ? customEndMs : prevSt.customEndMs || 0)
      : prevSt.customEndMs;

  const statePatch = { selectedTimeRange: targetRange };
  if (targetRange === 'custom') {
    statePatch.customStartMs = nextStartMs;
    statePatch.customEndMs = nextEndMs;
  }

  const cacheKey = makeConsumptionRangeCacheKey(targetRange, nextStartMs, nextEndMs);
  const cached = consumptionRangeCache.get(cacheKey);
  const prevTelemetry = prevSt.telemetry;

  if (cached && prevTelemetry) {
    const currentRev = Number(prevTelemetry.consumption?.revision || 0);
    const nextTelemetry = applyCachedConsumptionSlice(
      prevTelemetry,
      cached,
      currentRev > 0 ? currentRev : cached.revision
    );
    telemetryStore.setState({ ...statePatch, telemetry: nextTelemetry });
    if (currentRev > 0 && cached.revision === currentRev) {
      return Promise.resolve(nextTelemetry);
    }
    return fetchConsumptionRangeSlice({
      range: targetRange,
      customStartMs: nextStartMs,
      customEndMs: nextEndMs,
    });
  }

  telemetryStore.setState(statePatch);
  return fetchConsumptionRangeSlice({
    range: targetRange,
    customStartMs: nextStartMs,
    customEndMs: nextEndMs,
  });
}

/**
 * 仅在进入「用量统计」视图时触发一次静默后台预取，拉齐全部 7 个预设区间到前端缓存以实现 0ms 瞬切。
 */
function prefetchConsumptionPresets() {
  const prevTelemetry = telemetryStore.getState().telemetry;
  const currentRev = Number(prevTelemetry?.consumption?.revision || 0);
  if (currentRev > 0 && lastPrefetchedUsageRevision === currentRev && hasAllPresetRangesCached(currentRev)) {
    return Promise.resolve(true);
  }
  if (inFlightPresetsPrefetch) {
    return inFlightPresetsPrefetch;
  }

  const current = telemetryStore.getState();
  const effectiveConvId = current.selectedConversationId || current.hostRouteConversationId || '';
  const params = new URLSearchParams();
  if (effectiveConvId) params.set('conversationId', effectiveConvId);
  params.set('scope', 'consumption-presets');

  const task = callSidecarApi(`/api/telemetry?${params}`, {
    method: 'GET',
    abortKey: 'consumption-presets',
  })
    .then((payload) => {
      if (payload?.scope === 'consumption-presets' && payload.ranges && typeof payload.ranges === 'object') {
        const rev = Number(payload.usageRevision || currentRev || 0);
        for (const [rangeKey, entry] of Object.entries(payload.ranges)) {
          if (!entry || typeof entry !== 'object') continue;
          recordConsumptionSliceToCache(
            { ...entry, revision: rev },
            entry.modelBreakdown,
            { usageRevision: rev }
          );
        }
        if (rev > 0) {
          lastPrefetchedUsageRevision = rev;
        }
        return true;
      }
      return false;
    })
    .catch(() => false)
    .finally(() => {
      if (inFlightPresetsPrefetch === task) {
        inFlightPresetsPrefetch = null;
      }
    });

  inFlightPresetsPrefetch = task;
  return task;
}

async function saveSettingsPatch(patch) {
  const safePatch = patch && typeof patch === 'object' ? { ...patch } : {};
  if (Object.prototype.hasOwnProperty.call(safePatch, 'language')) {
    safePatch.language = normalizeI18nLanguage(safePatch.language);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'themeAccent')) {
    safePatch.themeAccent = normalizeClientThemeAccent(safePatch.themeAccent);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'fontScale')) {
    safePatch.fontScale = normalizeClientFontScale(safePatch.fontScale);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'experimentalModernUi')) {
    safePatch.experimentalModernUi = normalizeClientModernUi(safePatch.experimentalModernUi);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'weeklyLimitMode')) {
    safePatch.weeklyLimitMode = normalizeWeeklyLimitMode(safePatch.weeklyLimitMode);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'enableCliStatusLine')) {
    safePatch.enableCliStatusLine = Boolean(safePatch.enableCliStatusLine);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'showTopbarMultiSession')) {
    safePatch.showTopbarMultiSession = Boolean(safePatch.showTopbarMultiSession);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'showStepTurnRail')) {
    safePatch.showStepTurnRail = Boolean(safePatch.showStepTurnRail);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'showStepAgentBadge')) {
    safePatch.showStepAgentBadge = Boolean(safePatch.showStepAgentBadge);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'showStepSpeedColor')) {
    safePatch.showStepSpeedColor = Boolean(safePatch.showStepSpeedColor);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'topbarCapsuleSlots')) {
    safePatch.topbarCapsuleSlots = normalizeClientTopbarSlots(safePatch.topbarCapsuleSlots);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'hoverModules')) {
    safePatch.hoverModules = normalizeClientHoverModules(safePatch.hoverModules);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'overviewModules')) {
    safePatch.overviewModules = normalizeClientOverviewModules(safePatch.overviewModules);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'overviewMetrics')) {
    safePatch.overviewMetrics = normalizeClientOverviewMetrics(safePatch.overviewMetrics);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'stepTableColumns')) {
    safePatch.stepTableColumns = normalizeClientStepColumns(safePatch.stepTableColumns);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'stepTokenComboFormat')) {
    safePatch.stepTokenComboFormat = normalizeClientStepTokenComboFormat(
      safePatch.stepTokenComboFormat
    );
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'modelDisplayMode')) {
    const normDisp = normalizeClientModelDisplayMode(
      safePatch.modelDisplayMode,
      safePatch.showUpstreamModel
    );
    safePatch.modelDisplayMode = normDisp;
    safePatch.showUpstreamModel = normDisp !== 'short';
  } else if (Object.prototype.hasOwnProperty.call(safePatch, 'showUpstreamModel')) {
    safePatch.showUpstreamModel = Boolean(safePatch.showUpstreamModel);
    safePatch.modelDisplayMode = safePatch.showUpstreamModel ? 'upstream' : 'short';
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'popoverWidthMode')) {
    safePatch.popoverWidthMode = normalizeClientPopoverWidthMode(safePatch.popoverWidthMode);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'popoverWidth')) {
    safePatch.popoverWidth = normalizeClientPopoverWidth(safePatch.popoverWidth);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'contextWindowRiskAccepted')) {
    safePatch.contextWindowRiskAccepted = Boolean(safePatch.contextWindowRiskAccepted);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'orchestratorIdMode')) {
    safePatch.orchestratorIdMode = normalizeClientOrchestratorIdMode(safePatch.orchestratorIdMode);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'standalonePort')) {
    const numPort = Number(safePatch.standalonePort);
    safePatch.standalonePort =
      Number.isInteger(numPort) && numPort >= 1024 && numPort <= 65535 ? numPort : 0;
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'windowMountMode')) {
    const normMount = normalizeClientWindowMountMode(
      safePatch.windowMountMode,
      safePatch.enableWindowOverlay
    );
    safePatch.windowMountMode = normMount;
    safePatch.enableWindowOverlay = normMount !== 'sidebar';
  } else if (Object.prototype.hasOwnProperty.call(safePatch, 'enableWindowOverlay')) {
    safePatch.enableWindowOverlay = Boolean(safePatch.enableWindowOverlay);
    safePatch.windowMountMode = safePatch.enableWindowOverlay ? 'dual' : 'sidebar';
  }
  const myRev = ++settingsRevision;
  const prevTelemetry = telemetryStore.getState().telemetry;
  const patchKeys = Object.keys(safePatch);
  const prevKeyValues = new Map();
  for (const key of patchKeys) {
    prevKeyValues.set(key, prevTelemetry?.settings?.[key]);
    pendingSettingsMutations.set(key, { rev: myRev, value: safePatch[key] });
  }
  let optimisticTelemetry = null;
  if (prevTelemetry?.settings) {
    optimisticTelemetry = {
      ...prevTelemetry,
      settings: { ...prevTelemetry.settings, ...safePatch },
    };
    telemetryStore.setState({ telemetry: optimisticTelemetry });
  }
  let res = null;
  try {
    res = await enqueueSettingsWrite(() =>
      callSidecarApi('/api/settings', { method: 'POST', body: safePatch })
    );
  } catch (err) {
    const rollbackKeys = [];
    for (const key of patchKeys) {
      const activeEntry = pendingSettingsMutations.get(key);
      if (activeEntry?.rev === myRev) {
        pendingSettingsMutations.delete(key);
        rollbackKeys.push(key);
      }
    }
    if (rollbackKeys.length > 0) {
      const curTelemetry = telemetryStore.getState().telemetry;
      if (prevTelemetry && optimisticTelemetry && curTelemetry === optimisticTelemetry) {
        telemetryStore.setState({ telemetry: prevTelemetry });
      } else if (curTelemetry?.settings) {
        const rolledBackSettings = { ...curTelemetry.settings };
        for (const key of rollbackKeys) {
          if (recentCommittedSettings.has(key)) {
            rolledBackSettings[key] = recentCommittedSettings.get(key).value;
          } else {
            rolledBackSettings[key] = prevKeyValues.get(key);
          }
        }
        telemetryStore.setState({
          telemetry: { ...curTelemetry, settings: rolledBackSettings },
        });
      }
    }
    throw err;
  }

  const serverSettings = extractReturnedSettings(res);
  const committedRev = ++settingsRevision;
  for (const key of patchKeys) {
    const activeEntry = pendingSettingsMutations.get(key);
    const committedVal =
      serverSettings && Object.prototype.hasOwnProperty.call(serverSettings, key)
        ? serverSettings[key]
        : safePatch[key];
    if (activeEntry?.rev === myRev) {
      pendingSettingsMutations.delete(key);
      recentCommittedSettings.set(key, { rev: committedRev, value: committedVal });
    }
  }

  const curTelemetry = telemetryStore.getState().telemetry;
  if (curTelemetry?.settings) {
    const nextSettings = serverSettings
      ? { ...curTelemetry.settings, ...serverSettings }
      : { ...curTelemetry.settings };
    for (const [k, entry] of recentCommittedSettings.entries()) {
      if (entry.rev > committedRev) {
        nextSettings[k] = entry.value;
      }
    }
    for (const [k, entry] of pendingSettingsMutations.entries()) {
      nextSettings[k] = entry.value;
    }
    telemetryStore.setState({
      telemetry: { ...curTelemetry, settings: nextSettings },
    });
  }

  const needsTelemetryRecompute = patchKeys.some((k) => TELEMETRY_RECOMPUTE_SETTING_KEYS.has(k));
  if (
    Object.prototype.hasOwnProperty.call(safePatch, 'weeklyLimitMode') ||
    Object.prototype.hasOwnProperty.call(safePatch, 'weeklyTokenBudget') ||
    Object.prototype.hasOwnProperty.call(safePatch, 'weeklyCostBudget')
  ) {
    clearConsumptionRangeCache();
    clearConversationViewCache();
  }
  if (needsTelemetryRecompute) {
    inFlightTelemetryPoll = null;
    void fetchTelemetry({ force: false });
  }
}

async function saveModelContextWindow(modelId, option) {
  const myRev = ++settingsRevision;
  const result = await enqueueSettingsWrite(() =>
    callSidecarApi('/api/context-window', {
      method: 'POST',
      body: { modelId, option },
    })
  );
  const committedRev = ++settingsRevision;
  if (result?.modelContextWindows) {
    recentCommittedSettings.set('modelContextWindows', {
      rev: Math.max(myRev, committedRev),
      value: result.modelContextWindows,
    });
  }
  const telemetry = telemetryStore.getState().telemetry;
  if (telemetry?.settings) {
    telemetryStore.setState({
      telemetry: {
        ...telemetry,
        settings: { ...telemetry.settings, modelContextWindows: result.modelContextWindows },
      },
    });
  }
  return result.modelContextWindows;
}

async function resetAllSettings() {
  const myRev = ++settingsRevision;
  const res = await enqueueSettingsWrite(() =>
    callSidecarApi('/api/settings/reset', { method: 'POST', body: {} })
  );
  const committedRev = ++settingsRevision;
  const serverSettings = extractReturnedSettings(res);
  if (serverSettings) {
    for (const [key, val] of Object.entries(serverSettings)) {
      const pending = pendingSettingsMutations.get(key);
      if (!pending || pending.rev <= myRev) {
        pendingSettingsMutations.delete(key);
        recentCommittedSettings.set(key, { rev: committedRev, value: val });
      }
    }
  }
  const prevTelemetry = telemetryStore.getState().telemetry;
  if (serverSettings && prevTelemetry) {
    const mergedSettings = { ...serverSettings };
    for (const [k, entry] of pendingSettingsMutations.entries()) {
      mergedSettings[k] = entry.value;
    }
    telemetryStore.setState({
      telemetry: {
        ...prevTelemetry,
        settings: mergedSettings,
      },
    });
  }
  inFlightTelemetryPoll = null;
  clearConsumptionRangeCache();
  clearConversationViewCache();
  void fetchTelemetry({ force: false });
  return res;
}

async function rebuildTrajectoryCache() {
  const res = await callSidecarApi('/api/cache/rebuild', { method: 'POST', body: {} });
  clearConsumptionRangeCache();
  clearConversationViewCache();
  await fetchTelemetry({ force: true });
  return res;
}

async function triggerCloudSync() {
  const res = await callSidecarApi('/api/cloud-sync', { method: 'POST', body: {} });
  clearConsumptionRangeCache();
  clearConversationViewCache();
  await fetchTelemetry({ force: true });
  return res;
}

async function triggerBridgeHostRelaunch() {
  try {
    return await callSidecarApi('/api/bridge/relaunch', { method: 'POST', body: {} });
  } catch {
    // 兼容热更新后常驻父进程 main.mjs 尚未重注册新路由的场景，平滑回退至既有 POST /api/settings 通道转发至最新 Worker
    return callSidecarApi('/api/settings', {
      method: 'POST',
      body: { __bridgeAction: 'relaunch' },
    });
  }
}

async function triggerPluginUpdate() {
  const res = await callSidecarApi('/api/plugin-update', { method: 'POST', body: {} });
  if (res?.ok && res?.restarting) {
    await new Promise((r) => setTimeout(r, 1100));
    if (
      !isWindowOverlayMode() &&
      typeof window !== 'undefined' &&
      typeof window.location?.reload === 'function'
    ) {
      window.location.reload();
      return res;
    }
  }
  await fetchTelemetry({ force: true });
  return res;
}

function startAsyncTelemetryLoop(intervalMs = 2000) {
  stopAsyncTelemetryLoop();
  loopActive = true;
  loopIntervalMs = intervalMs;

  const resolveNextDelay = () => {
    if (isWindowOverlayMode() && typeof document !== 'undefined' && document.hidden) {
      return Math.max(loopIntervalMs, 8000);
    }
    return loopIntervalMs;
  };

  const tick = async () => {
    pollTimer = null;
    if (!loopActive) return;
    await fetchTelemetry({ force: false });
    if (!loopActive || activeForceCount > 0) return;
    if (!pollTimer) {
      pollTimer = setTimeout(tick, resolveNextDelay());
    }
  };
  loopTickFn = tick;

  tick();
  return () => {
    stopAsyncTelemetryLoop();
  };
}

function stopAsyncTelemetryLoop() {
  loopActive = false;
  loopTickFn = null;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (feedbackTimer) {
    clearTimeout(feedbackTimer);
    feedbackTimer = null;
  }
  if (deferredConvSyncTimer) {
    clearTimeout(deferredConvSyncTimer);
    deferredConvSyncTimer = null;
  }
}


/**
 * 在遥测快照中解析宿主当前路由会话 ID（兼容顶层主会话 ID 与子代理/蜂群工蜂 ID）。
 *
 * @param {object|null|undefined} telemetry
 * @param {string} rawRouteId
 * @returns {{ rootConv: object|null, childAgent: object|null, isChildRoute: boolean } | null}
 */
function resolveHostRouteMatch(telemetry, rawRouteId) {
  const routeLower = String(rawRouteId || '').trim().toLowerCase();
  if (!routeLower || !telemetry) return null;
  const convs = Array.isArray(telemetry.conversations) ? telemetry.conversations : [];
  const actConv = telemetry.activeConversation || null;

  const directRoot =
    convs.find((c) => String(c?.cascadeId || '').toLowerCase() === routeLower) ||
    (String(actConv?.cascadeId || '').toLowerCase() === routeLower ? actConv : null);
  if (directRoot) {
    return { rootConv: directRoot, childAgent: null, isChildRoute: false };
  }

  const activeChild = (actConv?.agents || []).find(
    (a) =>
      !a?.isMain &&
      (String(a?.cascadeId || '').toLowerCase() === routeLower ||
        String(a?.agentId || '').toLowerCase() === routeLower)
  );
  if (activeChild) {
    const parentInList = convs.find(
      (c) => String(c?.cascadeId || '').toLowerCase() === String(actConv?.cascadeId || '').toLowerCase()
    );
    return {
      rootConv: parentInList || actConv,
      childAgent: activeChild,
      isChildRoute: true,
    };
  }

  const memberParent = convs.find(
    (c) =>
      Array.isArray(c?.memberCascadeIds) &&
      c.memberCascadeIds.some((id) => String(id || '').toLowerCase() === routeLower)
  );
  if (memberParent) {
    return { rootConv: memberParent, childAgent: null, isChildRoute: true };
  }
  return null;
}

/**
 * 解析当前选中的主/子代理作用域视图数据与独立上下文窗口检视目标。
 * 同时在客户端按需组装主代理与全部汇总的 `recentSteps`，避免后端 JSON 载荷重复序列化 2-3 倍步骤列表。
 *
 * @param {object|null} telemetry
 * @param {string} [selectedAgentScope='all']
 * @param {string} [ctxInspectorAgentId='auto']
 * @param {boolean} [includeSteps=false] 是否组装调用明细所需的步骤列表
 */
const scopedStepProjectionMemo = new WeakMap();

function resolveScopedConversation(
  telemetry,
  selectedAgentScope = 'all',
  ctxInspectorAgentId = 'auto',
  includeSteps = false
) {
  const rawActive = telemetry?.activeConversation;
  const active = rawActive || {};
  const agents = Array.isArray(active.agents) && active.agents.length > 0 ? active.agents : [];
  const hasSubagents = Boolean(active.hasSubagents && agents.length > 1);
  const subagents = agents.filter((a) => !a.isMain);
  let mainAgent = agents.find((a) => a.isMain) || active;
  let aggregated = active.aggregated || active;
  let resolvedAgents = agents;

  if (includeSteps) {
    let cached = rawActive && typeof rawActive === 'object' ? scopedStepProjectionMemo.get(rawActive) : null;
    if (!cached) {
      let nextMain = mainAgent;
      let nextAgents = agents;
      if (!Array.isArray(mainAgent.recentSteps) && Array.isArray(active.recentSteps)) {
        nextMain = { ...mainAgent, recentSteps: active.recentSteps };
        if (agents.includes(mainAgent)) {
          nextAgents = agents.map((ag) => (ag === mainAgent ? nextMain : ag));
        }
      }
      let nextAgg = aggregated;
      if (hasSubagents && !Array.isArray(aggregated.recentSteps)) {
        const combined = [];
        for (const ag of nextAgents) {
          const steps = ag.isMain ? ag.recentSteps || active.recentSteps || [] : ag.recentSteps || [];
          for (const step of steps) combined.push(step);
        }
        combined.sort(
          (a, b) =>
            (b.createdAtMs || 0) - (a.createdAtMs || 0) ||
            (b.agentIndex || 0) - (a.agentIndex || 0) ||
            (b.stepIndex || 0) - (a.stepIndex || 0)
        );
        nextAgg = { ...aggregated, recentSteps: combined };
      }
      cached = { mainAgent: nextMain, aggregated: nextAgg, agents: nextAgents };
      if (rawActive && typeof rawActive === 'object') {
        scopedStepProjectionMemo.set(rawActive, cached);
      }
    }
    mainAgent = cached.mainAgent;
    aggregated = cached.aggregated;
    resolvedAgents = cached.agents;
  }

  if (!hasSubagents) {
    const singleScoped =
      includeSteps && !Array.isArray(active.recentSteps) && Array.isArray(mainAgent.recentSteps)
        ? { ...active, recentSteps: mainAgent.recentSteps }
        : active;
    return {
      hasSubagents: false,
      effectiveScope: 'main',
      effectiveCtxScope: 'main',
      agents: resolvedAgents,
      subagents: [],
      mainAgent,
      aggregated,
      scopedConv: singleScoped,
      ctxAgent: mainAgent,
    };
  }

  const isValidSub = subagents.some((s) => s.agentId === selectedAgentScope);
  const effectiveScope =
    selectedAgentScope === 'main'
      ? 'main'
      : isValidSub
        ? selectedAgentScope
        : 'all';

  const scopedConv =
    effectiveScope === 'all'
      ? aggregated
      : resolvedAgents.find((a) => a.agentId === effectiveScope) || mainAgent;

  let ctxAgent = scopedConv;
  let effectiveCtxScope = effectiveScope;
  if (effectiveScope === 'all') {
    if (ctxInspectorAgentId && ctxInspectorAgentId !== 'auto') {
      const matched = resolvedAgents.find((a) => a.agentId === ctxInspectorAgentId);
      if (matched) {
        ctxAgent = matched;
        effectiveCtxScope = matched.agentId;
      } else {
        effectiveCtxScope = 'auto';
      }
    } else {
      effectiveCtxScope = 'auto';
    }
    if (effectiveCtxScope === 'auto') {
      ctxAgent =
        resolvedAgents.find((a) => !a.isSideQuestion && a.agentId === aggregated.activeAgentId) ||
        resolvedAgents.find((a) => !a.isSideQuestion && a.isRunning) ||
        mainAgent;
    }
  }

  return {
    hasSubagents: true,
    effectiveScope,
    effectiveCtxScope,
    agents: resolvedAgents,
    subagents,
    mainAgent,
    aggregated,
    scopedConv,
    ctxAgent,
  };
}

/**
 * 判断宿主系统是否为 macOS (`darwin`)：优先读取后端遥测或双栖桥接注入的 `platform`，首帧缺省时回退 UA/平台标识。
 *
 * @param {Record<string, any>|null|undefined} telemetry
 * @returns {boolean}
 */
function isMacHostPlatform(telemetry) {
  const p = String(telemetry?.hostPlatform || readInjectedWindowBridge()?.platform || '')
    .trim()
    .toLowerCase();
  if (p) return p === 'darwin';
  if (typeof navigator !== 'undefined') {
    const ua = String(navigator.platform || navigator.userAgent || '');
    return /\b(?:mac|darwin)\b|macintosh|mac\s*os/i.test(ua);
  }
  return false;
}
return { extractHostRouteCascadeId, telemetryStore, clearConsumptionRangeCache, clearConversationViewCache, CLIENT_TOPBAR_SLOT_KEYS, DEFAULT_CLIENT_TOPBAR_SLOTS, CLIENT_OVERVIEW_MODULE_KEYS, DEFAULT_CLIENT_OVERVIEW_MODULES, DEFAULT_CLIENT_HOVER_MODULES, CLIENT_OVERVIEW_METRIC_KEYS, DEFAULT_CLIENT_OVERVIEW_METRICS, CLIENT_STEP_COLUMN_KEYS, DEFAULT_CLIENT_STEP_COLUMNS, DEFAULT_CLIENT_STEP_TOKEN_COMBO_FORMAT, MIN_CLIENT_POPOVER_WIDTH, MAX_CLIENT_POPOVER_WIDTH, DEFAULT_CLIENT_POPOVER_WIDTH, parseClientStepTokenComboSegments, normalizeClientStepTokenComboFormat, normalizeClientPopoverWidthMode, normalizeClientPopoverWidth, normalizeClientModelDisplayMode, normalizeClientTopbarSlots, normalizeClientHoverModules, normalizeClientOverviewModules, normalizeClientOverviewMetrics, normalizeClientStepColumns, normalizeClientUpdateMode, normalizeClientOrchestratorIdMode, normalizeClientWindowMountMode, isEquivalentTelemetry, fetchTelemetry, selectConversation, selectConsumptionTimeRange, prefetchConsumptionPresets, saveSettingsPatch, saveModelContextWindow, resetAllSettings, rebuildTrajectoryCache, triggerCloudSync, triggerBridgeHostRelaunch, triggerPluginUpdate, startAsyncTelemetryLoop, stopAsyncTelemetryLoop, resolveHostRouteMatch, resolveScopedConversation, isMacHostPlatform };
})();

// --- src/components/ui/TopLongPillNav.js ---
const { TopLongPillNav } = (() => {
/**
 * @fileoverview Top Long-Pill Navigation Bar (顶部唯一长药丸功能分割栏).
 * Splits the application into focused single-viewport views and animates
 * the active glider using GPU-accelerated translate3d.
 */


const TopLongPillNav = defineComponent({
  name: 'TopLongPillNav',
  setup({ getProps, emit }) {
    const glider = h('div', { className: 'pill-glider', 'aria-hidden': 'true' });
    const navEl = h(
      'nav',
      {
        className: 'long-pill-nav',
        role: 'tablist',
        'aria-label': '主功能视图分割导航',
      },
      [glider]
    );

    const tabButtons = new Map();

    function selectValue(nextVal) {
      const current = getProps().modelValue;
      if (nextVal !== current) {
        emit('update:modelValue', nextVal);
      }
    }

    function syncTabs() {
      const { items = [], modelValue } = getProps();
      patchStyleVar(navEl, '--pill-count', Math.max(1, items.length));

      const validValues = new Set(items.map((it) => it.value));
      for (const [val, entry] of tabButtons.entries()) {
        if (!validValues.has(val)) {
          if (entry.btn?.parentNode === navEl) {
            navEl.removeChild(entry.btn);
          }
          tabButtons.delete(val);
        }
      }

      let activeIdx = 0;
      items.forEach((item, index) => {
        if (item.value === modelValue) {
          activeIdx = index;
        }
        let entry = tabButtons.get(item.value);
        if (!entry) {
          const iconEl = item.icon ? createSvgIcon(item.icon, { size: 14 }) : null;
          const labelEl = h('span', { className: 'pill-tab-label', text: item.label });
          const badgeEl = h('span', { className: 'pill-tab-badge', hidden: true });
          const btn = h(
            'button',
            {
              type: 'button',
              role: 'tab',
              className: 'pill-tab',
              dataset: { pillValue: item.value },
              onClick: () => selectValue(item.value),
              onKeydown: (e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  e.preventDefault();
                  const curItems = getProps().items || [];
                  if (!curItems.length) return;
                  const curIndex = Math.max(
                    0,
                    curItems.findIndex((it) => it.value === item.value)
                  );
                  const delta = e.key === 'ArrowRight' ? 1 : -1;
                  const nextIndex = (curIndex + delta + curItems.length) % curItems.length;
                  const target = curItems[nextIndex];
                  if (target) {
                    selectValue(target.value);
                    tabButtons.get(target.value)?.btn?.focus();
                  }
                }
              },
            },
            [iconEl, labelEl, badgeEl]
          );
          entry = { btn, labelEl, badgeEl };
          tabButtons.set(item.value, entry);
          navEl.appendChild(btn);
        }

        patchText(entry.labelEl, item.label);
        const hasBadge = item.badge !== undefined && item.badge !== null && item.badge !== '';
        if (hasBadge) {
          patchAttr(entry.badgeEl, 'hidden', false);
          patchText(entry.badgeEl, `(${item.badge})`);
        } else {
          patchAttr(entry.badgeEl, 'hidden', true);
        }
        patchAttr(entry.btn, 'title', hasBadge ? `${item.label} (${item.badge})` : item.label);

        const isActive = item.value === modelValue;
        patchClasses(entry.btn, { 'is-active': isActive });
        patchAttr(entry.btn, 'aria-selected', isActive ? 'true' : 'false');
        patchAttr(entry.btn, 'tabindex', isActive ? '0' : '-1');
      });

      patchStyleVar(navEl, '--active-index', activeIdx);
    }

    syncTabs();

    return {
      el: navEl,
      refs: { glider, tabButtons },
      onPropsChange: syncTabs,
      getValue: () => getProps().modelValue,
    };
  },
});
return { TopLongPillNav };
})();

// --- src/components/ui/CustomSelect.js ---
const { CustomSelect } = (() => {
/**
 * @fileoverview Bespoke CustomSelect dropdown component replacing native <select> / <option>.
 * Supports both single-select and multi-select (`multiple: true`) modes, with incremental
 * option patching while open without losing focus or closing the menu.
 */


function normalizeMultiSelection(rawValue, options = [], allValue = '') {
  const arr = Array.isArray(rawValue)
    ? rawValue
    : rawValue !== undefined && rawValue !== null && rawValue !== ''
      ? [rawValue]
      : [];
  const clean = [];
  const seen = new Set();
  for (const item of arr) {
    const str = String(item ?? '');
    if (!str || seen.has(str)) continue;
    seen.add(str);
    clean.push(str);
  }
  if (allValue && (clean.length === 0 || clean.includes(allValue))) {
    return [allValue];
  }
  if (options.length > 0) {
    const validSet = new Set(options.map((o) => String(o.value)));
    const filtered = clean.filter((v) => validSet.has(v));
    if (filtered.length > 0) return filtered;
    return allValue ? [allValue] : [];
  }
  return clean;
}

function sameStringArray(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const CustomSelect = defineComponent({
  name: 'CustomSelect',
  setup({ getProps, setProps, emit, onCleanup }) {
    let isOpen = false;
    let focusedIndex = -1;

    const initialIcon = getProps().icon;
    const leadIcon = createSvgIcon(initialIcon || 'bolt', { size: 13 });
    patchAttr(leadIcon, 'hidden', !initialIcon);
    const triggerLabel = h('span', { className: 'select-label' });
    const chevronIcon = createSvgIcon('chevron-down', { size: 13 });

    const triggerBtn = h(
      'button',
      {
        type: 'button',
        className: 'select-trigger',
        role: 'combobox',
        'aria-expanded': 'false',
        'aria-haspopup': 'listbox',
        onClick: (e) => {
          e.stopPropagation();
          toggleOpen(!isOpen);
        },
        onKeydown: handleKeydown,
      },
      [leadIcon, triggerLabel, chevronIcon]
    );

    const menuEl = h('div', {
      className: 'select-menu',
      role: 'listbox',
      hidden: true,
    });

    const initialClass = [
      'custom-select',
      getProps().multiple ? 'is-multi' : '',
      getProps().className,
    ]
      .filter(Boolean)
      .join(' ');
    const rootEl = h('div', { className: initialClass }, [triggerBtn, menuEl]);

    function getSelectedSet() {
      const { multiple, modelValue, options = [], allValue = '' } = getProps();
      if (!multiple) {
        return new Set(modelValue !== undefined && modelValue !== null ? [modelValue] : []);
      }
      return new Set(normalizeMultiSelection(modelValue, options, allValue));
    }

    function positionMenu() {
      if (!isOpen) return;
      positionAnchoredPopup(rootEl, triggerBtn, menuEl, {
        margin: 6,
        gap: 4,
        maxHeight: 220,
        minFlipSpace: 140,
      });
    }

    let boundReposition = false;
    function handleViewportChange(e) {
      if (!isOpen) return;
      if (e?.type === 'scroll' && e.target === menuEl) return;
      positionMenu();
    }

    function setRepositionListeners(active) {
      if (active === boundReposition) return;
      boundReposition = active;
      if (typeof window !== 'undefined' && window.addEventListener) {
        if (active) {
          window.addEventListener('resize', handleViewportChange, { passive: true });
          window.addEventListener('scroll', handleViewportChange, true);
        } else {
          window.removeEventListener('resize', handleViewportChange);
          window.removeEventListener('scroll', handleViewportChange, true);
        }
      }
    }

    function toggleOpen(nextOpen) {
      isOpen = Boolean(nextOpen);
      if (isOpen) {
        const opts = getProps().options || [];
        const selSet = getSelectedSet();
        focusedIndex = Math.max(
          0,
          opts.findIndex((o) => selSet.has(o.value))
        );
        renderMenuOptions();
      }
      patchClasses(rootEl, { 'is-open': isOpen });
      patchAttr(triggerBtn, 'aria-expanded', isOpen ? 'true' : 'false');
      patchAttr(menuEl, 'hidden', !isOpen);
      patchSvgIcon(chevronIcon, isOpen ? 'chevron-up' : 'chevron-down');
      setRepositionListeners(isOpen);
      if (isOpen) {
        positionMenu();
      }
    }

    function chooseOption(option) {
      if (!option) return;
      if (option.disabled && !getSelectedSet().has(option.value)) return;
      const { multiple, options = [], allValue = '', collapseAll = false } = getProps();
      if (!multiple) {
        const prevVal = getProps().modelValue;
        toggleOpen(false);
        if (option.value !== prevVal) {
          setProps({ modelValue: option.value });
          emit('update:modelValue', option.value);
        }
        return;
      }

      const prevList = normalizeMultiSelection(getProps().modelValue, options, allValue);
      const val = String(option.value);
      let nextList;
      if (allValue && val === allValue) {
        nextList = [allValue];
      } else {
        const base = prevList.filter((v) => v !== allValue);
        if (base.includes(val)) {
          const rest = base.filter((v) => v !== val);
          nextList = rest.length > 0 ? rest : allValue ? [allValue] : [val];
        } else {
          const addedSet = new Set([...base, val]);
          const ordered = options
            .filter((o) => String(o.value) !== allValue && addedSet.has(String(o.value)))
            .map((o) => String(o.value));
          nextList = ordered.length > 0 ? ordered : [...base, val];
          if (collapseAll && allValue) {
            const nonAllTotal = options.filter((o) => String(o.value) !== allValue).length;
            if (nonAllTotal > 0 && nextList.length >= nonAllTotal) {
              nextList = [allValue];
            }
          }
        }
      }

      if (!sameStringArray(prevList, nextList)) {
        setProps({ modelValue: nextList });
        emit('update:modelValue', nextList);
      } else {
        renderMenuOptions();
      }
    }

    function handleKeydown(e) {
      const opts = getProps().options || [];
      if (!opts.length) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!isOpen) {
          toggleOpen(true);
        } else {
          focusedIndex = (focusedIndex + 1) % opts.length;
          renderMenuOptions();
          menuEl.children[focusedIndex]?.scrollIntoView?.({ block: 'nearest' });
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!isOpen) {
          toggleOpen(true);
        } else {
          focusedIndex = (focusedIndex - 1 + opts.length) % opts.length;
          renderMenuOptions();
          menuEl.children[focusedIndex]?.scrollIntoView?.({ block: 'nearest' });
        }
      } else if ((e.key === 'Enter' || (e.key === ' ' && isOpen && getProps().multiple)) && isOpen) {
        e.preventDefault();
        const target = opts[focusedIndex];
        if (target) chooseOption(target);
      } else if (e.key === 'Escape' && isOpen) {
        e.preventDefault();
        toggleOpen(false);
      }
    }

    function renderMenuOptions() {
      const { options = [], multiple = false } = getProps();
      const selSet = getSelectedSet();
      patchAttr(menuEl, 'aria-multiselectable', multiple ? 'true' : null);
      patchKeyedList(menuEl, options, {
        keyFn: (opt) => opt.value,
        sigFn: (opt, idx) =>
          `${multiple}::${opt.value}::${opt.label}::${opt.meta || ''}::${Boolean(opt.disabled)}::${selSet.has(opt.value)}::${idx === focusedIndex}`,
        createRow: (opt) => {
          const checkboxIcon = createSvgIcon('check', { size: 10 });
          const checkboxBox = h('span', { className: 'select-checkbox', hidden: true }, [
            checkboxIcon,
          ]);
          const textSpan = h('span', { className: 'select-option-text' });
          const metaSpan = h('span', { className: 'text-muted select-option-meta' });
          const checkIcon = createSvgIcon('check', { size: 12 });
          const btn = h(
            'button',
            {
              type: 'button',
              role: 'option',
              className: 'select-option',
              onClick: (e) => {
                e.stopPropagation();
                const latestOpt =
                  (getProps().options || []).find((o) => o.value === opt.value) || opt;
                chooseOption(latestOpt);
              },
            },
            [checkboxBox, textSpan, metaSpan, checkIcon]
          );
          return { el: btn, refs: { checkboxBox, checkboxIcon, textSpan, metaSpan, checkIcon } };
        },
        updateRow: (refs, opt, idx, el) => {
          const isMulti = Boolean(getProps().multiple);
          const selected = selSet.has(opt.value);
          const focused = idx === focusedIndex;
          const isDisabled = Boolean(opt.disabled && !selected);
          patchAttr(refs.checkboxBox, 'hidden', !isMulti);
          patchClasses(refs.checkboxBox, { 'is-checked': selected });
          patchAttr(refs.checkboxIcon, 'hidden', !selected);
          patchText(refs.textSpan, opt.label);
          patchText(refs.metaSpan, opt.meta || '');
          patchAttr(refs.metaSpan, 'hidden', !opt.meta);
          patchAttr(refs.checkIcon, 'hidden', isMulti || !selected);
          patchClasses(el, {
            'is-selected': selected,
            'is-focused': focused,
            'is-disabled': isDisabled,
          });
          patchAttr(el, 'disabled', isDisabled);
          patchAttr(el, 'aria-disabled', isDisabled ? 'true' : null);
          patchAttr(el, 'aria-selected', selected ? 'true' : 'false');
          patchAttr(el, 'data-value', opt.value);
        },
      });
    }

    function syncTriggerAndMenu() {
      const {
        options = [],
        modelValue,
        placeholder = t('fmt.selectPlaceholder'),
        icon,
        multiple = false,
        allValue = '',
        multiUnit = isEnglishLocale() ? 'items' : '项',
      } = getProps();
      patchClasses(rootEl, { 'is-multi': Boolean(multiple) });
      patchAttr(leadIcon, 'hidden', !icon);
      if (icon) {
        patchSvgIcon(leadIcon, icon);
      }

      let labelText = placeholder;
      let titleText = placeholder;

      if (multiple) {
        const vals = normalizeMultiSelection(modelValue, options, allValue);
        if ((allValue && vals.includes(allValue)) || vals.length === 0) {
          const allOpt = options.find((o) => String(o.value) === allValue);
          labelText = allOpt ? allOpt.label : placeholder;
          titleText = labelText;
        } else if (vals.length === 1) {
          const singleOpt = options.find((o) => String(o.value) === vals[0]);
          labelText = singleOpt ? singleOpt.label : vals[0];
          titleText = labelText;
        } else {
          const names = vals.map((v) => options.find((o) => String(o.value) === v)?.label || v);
          labelText = t('fmt.selectedCount', { count: vals.length, unit: multiUnit });
          titleText = t('fmt.selectedListTitle', {
            count: vals.length,
            names: names.join(isEnglishLocale() ? ', ' : '、'),
          });
        }
      } else {
        const matchedOpt = options.find((o) => o.value === modelValue);
        const selectedOpt = matchedOpt || (!modelValue ? options[0] : undefined);
        const fallbackText = modelValue
          ? `${placeholder} (${String(modelValue).slice(0, 8)})`
          : placeholder;
        labelText = selectedOpt ? selectedOpt.label : fallbackText;
        titleText = labelText;
      }

      patchText(triggerLabel, labelText);
      patchAttr(triggerBtn, 'title', titleText);
      if (isOpen) {
        renderMenuOptions();
        positionMenu();
      }
    }

    const handleDocClick = (e) => {
      if (isOpen && !isEventInside(e, rootEl)) {
        toggleOpen(false);
      }
    };

    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('click', handleDocClick, true);
      onCleanup(() => {
        setRepositionListeners(false);
        document.removeEventListener('click', handleDocClick, true);
      });
    } else {
      onCleanup(() => setRepositionListeners(false));
    }

    syncTriggerAndMenu();

    return {
      el: rootEl,
      refs: { triggerBtn, triggerLabel, menuEl },
      onPropsChange: syncTriggerAndMenu,
      methods: {
        close: () => toggleOpen(false),
      },
    };
  },
});
return { CustomSelect };
})();

// --- src/components/ui/CustomNumberInput.js ---
const { CustomNumberInput } = (() => {
/**
 * @fileoverview Bespoke CustomNumberInput spinbutton & precision stepper.
 * Replaces native <input type="number"> with custom SVG step controls,
 * keyboard ArrowUp/ArrowDown (+Shift 10x), and min/max clamping.
 */


const CustomNumberInput = defineComponent({
  name: 'CustomNumberInput',
  setup({ getProps, setProps, emit }) {
    function clampValue(raw) {
      const { min = -Infinity, max = Infinity, precision = 0 } = getProps();
      const num = Number(raw);
      if (!Number.isFinite(num)) {
        return Number(getProps().modelValue ?? (Number.isFinite(min) ? min : 0));
      }
      const clamped = Math.min(max, Math.max(min, num));
      return precision > 0 ? Number(clamped.toFixed(precision)) : Math.round(clamped);
    }

    function applyStep(direction, multiplier = 1) {
      const { step = 1, modelValue = 0 } = getProps();
      const current = Number(modelValue) || 0;
      const next = clampValue(current + direction * step * multiplier);
      syncFieldDisplay(next);
      if (next !== current) {
        setProps({ modelValue: next });
        emit('update:modelValue', next);
      }
    }

    const decBtn = h(
      'button',
      {
        type: 'button',
        className: 'num-step-btn',
        'aria-label': '减少数值',
        onClick: (e) => {
          e.preventDefault();
          applyStep(-1, e.shiftKey ? 10 : 1);
        },
      },
      [createSvgIcon('minus', { size: 12 })]
    );

    const incBtn = h(
      'button',
      {
        type: 'button',
        className: 'num-step-btn',
        'aria-label': '增加数值',
        onClick: (e) => {
          e.preventDefault();
          applyStep(1, e.shiftKey ? 10 : 1);
        },
      },
      [createSvgIcon('plus', { size: 12 })]
    );

    const textField = h('input', {
      type: 'text',
      inputmode: 'decimal',
      role: 'spinbutton',
      className: 'num-field',
      onKeydown: (e) => {
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          applyStep(1, e.shiftKey ? 10 : 1);
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          applyStep(-1, e.shiftKey ? 10 : 1);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          commitManualInput();
        }
      },
      onChange: () => commitManualInput(),
      onBlur: () => commitManualInput(),
    });

    function commitManualInput() {
      const raw = String(textField.value ?? '').trim();
      if (!raw || !/\d/.test(raw)) {
        syncFieldDisplay(getProps().modelValue);
        return;
      }
      const cleaned = raw.replace(/[^0-9.-]/g, '');
      const parsed = Number(cleaned);
      if (!Number.isFinite(parsed)) {
        syncFieldDisplay(getProps().modelValue);
        return;
      }
      const next = clampValue(parsed);
      const prev = Number(getProps().modelValue);
      syncFieldDisplay(next);
      if (next !== prev) {
        setProps({ modelValue: next });
        emit('update:modelValue', next);
      }
    }

    function syncFieldDisplay(val = getProps().modelValue) {
      const { min, max, ariaLabel } = getProps();
      const normalized = clampValue(val);
      if (textField.value !== String(normalized)) {
        textField.value = String(normalized);
      }
      patchAttr(textField, 'aria-valuenow', normalized);
      if (ariaLabel) patchAttr(textField, 'aria-label', ariaLabel);
      if (Number.isFinite(min)) patchAttr(textField, 'aria-valuemin', min);
      if (Number.isFinite(max)) patchAttr(textField, 'aria-valuemax', max);
    }

    const rootEl = h('div', { className: 'number-input' }, [decBtn, textField, incBtn]);
    syncFieldDisplay();

    return {
      el: rootEl,
      refs: { decBtn, incBtn, textField },
      onPropsChange: () => syncFieldDisplay(),
      methods: {
        commit: () => commitManualInput(),
      },
    };
  },
});
return { CustomNumberInput };
})();

// --- src/components/ui/CustomDateTimePicker.js ---
const { CustomDateTimePicker } = (() => {
/**
 * @fileoverview Bespoke CustomDateTimePicker calendar matrix and hour/minute stepper.
 * Replaces native <input type="datetime-local"> and emits Unix epoch ms.
 */


const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

function buildCalendarDays(viewYear, viewMonth, selectedDate) {
  const firstDay = new Date(viewYear, viewMonth, 1);
  // Convert Sunday=0..Saturday=6 into Monday=0..Sunday=6
  const startOffset = (firstDay.getDay() + 6) % 7;
  const cells = [];

  for (let i = 0; i < 42; i++) {
    const cellDate = new Date(viewYear, viewMonth, 1 - startOffset + i);
    const y = cellDate.getFullYear();
    const m = cellDate.getMonth();
    const d = cellDate.getDate();
    const isCurrentMonth = m === viewMonth;
    const isSelected =
      selectedDate &&
      selectedDate.getFullYear() === y &&
      selectedDate.getMonth() === m &&
      selectedDate.getDate() === d;

    cells.push({
      key: `${y}-${m}-${d}`,
      year: y,
      month: m,
      day: d,
      isCurrentMonth,
      isSelected,
    });
  }
  return cells;
}

const CustomDateTimePicker = defineComponent({
  name: 'CustomDateTimePicker',
  setup({ getProps, emit, onCleanup }) {
    let isOpen = false;
    const initialDate = new Date(getProps().modelValue || Date.now());
    let viewYear = initialDate.getFullYear();
    let viewMonth = initialDate.getMonth();

    const triggerText = h('span', { className: 'text-mono' });
    const triggerBtn = h(
      'button',
      {
        type: 'button',
        className: 'dt-trigger',
        'aria-expanded': 'false',
        onClick: (e) => {
          e.stopPropagation();
          togglePopover(!isOpen);
        },
      },
      [createSvgIcon('calendar', { size: 13 }), triggerText]
    );

    const monthTitle = h('span', { className: 'text-mono' });
    const prevMonthBtn = h(
      'button',
      {
        type: 'button',
        className: 'icon-btn',
        'aria-label': '上个月',
        onClick: (e) => {
          e.stopPropagation();
          viewMonth -= 1;
          if (viewMonth < 0) {
            viewMonth = 11;
            viewYear -= 1;
          }
          renderCalendar();
        },
      },
      [createSvgIcon('chevron-left', { size: 12 })]
    );

    const nextMonthBtn = h(
      'button',
      {
        type: 'button',
        className: 'icon-btn',
        'aria-label': '下个月',
        onClick: (e) => {
          e.stopPropagation();
          viewMonth += 1;
          if (viewMonth > 11) {
            viewMonth = 0;
            viewYear += 1;
          }
          renderCalendar();
        },
      },
      [createSvgIcon('chevron-right', { size: 12 })]
    );

    const navBar = h('div', { className: 'dt-nav' }, [prevMonthBtn, monthTitle, nextMonthBtn]);

    const weekdayRow = h(
      'div',
      { className: 'dt-weekdays' },
      WEEKDAYS.map((w) => h('span', { className: 'dt-weekday', text: w }))
    );

    const daysGrid = h('div', { className: 'dt-days' });

    const hourValSpan = h('strong', { className: 'text-mono', text: '00' });
    const minValSpan = h('strong', { className: 'text-mono', text: '00' });

    function adjustTime(part, delta) {
      const cur = new Date(getProps().modelValue || Date.now());
      if (part === 'hour') {
        cur.setHours(cur.getHours() + delta);
      } else {
        cur.setMinutes(cur.getMinutes() + delta);
      }
      const nextMs = cur.getTime();
      viewYear = cur.getFullYear();
      viewMonth = cur.getMonth();
      emit('update:modelValue', nextMs);
    }

    const timeRow = h('div', { className: 'dt-time-row' }, [
      h('span', { className: 'text-muted', text: '时 / 分' }),
      h('div', { className: 'dt-time-controls' }, [
        h('div', { className: 'dt-mini-step' }, [
          h('button', {
            type: 'button',
            className: 'dt-mini-btn',
            text: '-',
            onClick: (e) => {
              e.stopPropagation();
              adjustTime('hour', -1);
            },
          }),
          hourValSpan,
          h('button', {
            type: 'button',
            className: 'dt-mini-btn',
            text: '+',
            onClick: (e) => {
              e.stopPropagation();
              adjustTime('hour', 1);
            },
          }),
        ]),
        h('span', { text: ':' }),
        h('div', { className: 'dt-mini-step' }, [
          h('button', {
            type: 'button',
            className: 'dt-mini-btn',
            text: '-',
            onClick: (e) => {
              e.stopPropagation();
              adjustTime('minute', -5);
            },
          }),
          minValSpan,
          h('button', {
            type: 'button',
            className: 'dt-mini-btn',
            text: '+',
            onClick: (e) => {
              e.stopPropagation();
              adjustTime('minute', 5);
            },
          }),
        ]),
      ]),
    ]);

    const popoverEl = h(
      'div',
      {
        className: 'dt-popover',
        hidden: true,
      },
      [navBar, weekdayRow, daysGrid, timeRow]
    );

    const rootEl = h('div', { className: 'datetime-picker' }, [triggerBtn, popoverEl]);

    function positionPopover() {
      if (!isOpen) return;
      positionAnchoredPopup(rootEl, triggerBtn, popoverEl, {
        margin: 6,
        gap: 4,
        maxHeight: 0,
        minFlipSpace: 260,
      });
    }

    let boundReposition = false;
    function handleViewportChange() {
      if (!isOpen) return;
      positionPopover();
    }

    function setRepositionListeners(active) {
      if (active === boundReposition) return;
      boundReposition = active;
      if (typeof window !== 'undefined' && window.addEventListener) {
        if (active) {
          window.addEventListener('resize', handleViewportChange, { passive: true });
          window.addEventListener('scroll', handleViewportChange, true);
        } else {
          window.removeEventListener('resize', handleViewportChange);
          window.removeEventListener('scroll', handleViewportChange, true);
        }
      }
    }

    function togglePopover(nextOpen) {
      isOpen = Boolean(nextOpen);
      patchAttr(popoverEl, 'hidden', !isOpen);
      patchAttr(triggerBtn, 'aria-expanded', isOpen ? 'true' : 'false');
      setRepositionListeners(isOpen);
      if (isOpen) {
        const cur = new Date(getProps().modelValue || Date.now());
        viewYear = cur.getFullYear();
        viewMonth = cur.getMonth();
        renderCalendar();
        positionPopover();
      }
    }

    function selectDay(cell) {
      const cur = new Date(getProps().modelValue || Date.now());
      cur.setFullYear(cell.year, cell.month, cell.day);
      const nextMs = cur.getTime();
      viewYear = cell.year;
      viewMonth = cell.month;
      emit('update:modelValue', nextMs);
    }

    function renderCalendar() {
      const cur = new Date(getProps().modelValue || Date.now());
      const pad = (n) => String(n).padStart(2, '0');
      patchText(monthTitle, `${viewYear}-${pad(viewMonth + 1)}`);
      patchText(hourValSpan, pad(cur.getHours()));
      patchText(minValSpan, pad(cur.getMinutes()));

      const cells = buildCalendarDays(viewYear, viewMonth, cur);
      patchKeyedList(daysGrid, cells, {
        keyFn: (c) => c.key,
        sigFn: (c) => `${c.key}:${c.isCurrentMonth}:${c.isSelected}`,
        createRow: (cell) => {
          const btn = h('button', {
            type: 'button',
            className: 'dt-day',
            onClick: (e) => {
              e.stopPropagation();
              selectDay(cell);
            },
          });
          return { el: btn, refs: {} };
        },
        updateRow: (_refs, cell, _idx, el) => {
          patchText(el, cell.day);
          patchClasses(el, {
            'is-selected': cell.isSelected,
            'is-outside': !cell.isCurrentMonth,
          });
          patchAttr(el, 'data-date-key', cell.key);
        },
      });
    }

    function syncDisplay() {
      const ms = Number(getProps().modelValue || Date.now());
      patchText(triggerText, formatCompactDateTime(ms));
      if (isOpen) {
        renderCalendar();
      }
    }

    const handleDocClick = (e) => {
      if (isOpen && !isEventInside(e, rootEl)) {
        togglePopover(false);
      }
    };

    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('click', handleDocClick, true);
      onCleanup(() => {
        setRepositionListeners(false);
        document.removeEventListener('click', handleDocClick, true);
      });
    } else {
      onCleanup(() => setRepositionListeners(false));
    }

    syncDisplay();

    return {
      el: rootEl,
      refs: { triggerBtn, triggerText, popoverEl, daysGrid, hourValSpan, minValSpan },
      onPropsChange: syncDisplay,
    };
  },
});
return { CustomDateTimePicker };
})();

// --- src/components/ui/CustomScrollbar.js ---
const { CustomScrollbar } = (() => {
/**
 * @fileoverview Bespoke custom scrollbar component (零原生滚动条).
 * Hides native OS scrollbars completely and renders a precision 4px floating
 * rail + GPU-translated thumb with drag and track-jump support.
 */


const CustomScrollbar = defineComponent({
  name: 'CustomScrollbar',
  setup({ getProps, onCleanup }) {
    const contentEl = getProps().contentEl || h('div');
    contentEl.classList.add('custom-scroll-content');

    const thumbEl = h('div', { className: 'scrollbar-thumb' });
    const railEl = h(
      'div',
      {
        className: 'scrollbar-rail is-inactive',
        'aria-hidden': 'true',
      },
      [thumbEl]
    );

    const hostEl = h(
      'div',
      {
        className: `custom-scroll-host ${getProps().className || ''}`.trim(),
      },
      [contentEl, railEl]
    );

    let isDragging = false;
    let dragStartY = 0;
    let dragStartScrollTop = 0;
    let scrollRafId = 0;

    function syncThumb() {
      const scrollHeight = Number(contentEl.scrollHeight || 0);
      const clientHeight = Number(contentEl.clientHeight || 0);
      const scrollTop = Number(contentEl.scrollTop || 0);
      const overflow = scrollHeight - clientHeight;

      if (overflow <= 1 || clientHeight <= 0) {
        patchClasses(railEl, { 'is-inactive': true });
        patchStyleVar(thumbEl, '--thumb-h', '0px');
        patchStyleVar(thumbEl, '--thumb-y', '0px');
        return;
      }

      patchClasses(railEl, { 'is-inactive': false });
      const railHeight = Math.max(24, clientHeight - 4);
      const thumbHeight = Math.max(24, Math.round((clientHeight / scrollHeight) * railHeight));
      const maxThumbTop = Math.max(0, railHeight - thumbHeight);
      const ratio = Math.max(0, Math.min(1, scrollTop / overflow));
      const thumbTop = Math.round(ratio * maxThumbTop);

      patchStyleVar(thumbEl, '--thumb-h', `${thumbHeight}px`);
      patchStyleVar(thumbEl, '--thumb-y', `${thumbTop}px`);
    }

    function onContentScroll() {
      if (isDragging || typeof requestAnimationFrame !== 'function') {
        syncThumb();
        return;
      }
      if (scrollRafId) return;
      scrollRafId = requestAnimationFrame(() => {
        scrollRafId = 0;
        syncThumb();
      });
    }

    function onDocMouseMove(e) {
      if (!isDragging) return;
      const clientHeight = Number(contentEl.clientHeight || 0);
      const scrollHeight = Number(contentEl.scrollHeight || 0);
      const overflow = scrollHeight - clientHeight;
      if (overflow <= 1) return;

      const railHeight = Math.max(24, clientHeight - 4);
      const thumbHeight = Math.max(24, Math.round((clientHeight / scrollHeight) * railHeight));
      const maxThumbTop = Math.max(1, railHeight - thumbHeight);

      const deltaY = (e.clientY || 0) - dragStartY;
      const scrollDelta = (deltaY / maxThumbTop) * overflow;
      contentEl.scrollTop = Math.max(0, Math.min(overflow, dragStartScrollTop + scrollDelta));
      syncThumb();
    }

    function onDocMouseUp() {
      if (!isDragging) return;
      isDragging = false;
      patchClasses(railEl, { 'is-dragging': false });
      if (typeof document !== 'undefined') {
        document.removeEventListener('mousemove', onDocMouseMove);
        document.removeEventListener('mouseup', onDocMouseUp);
      }
    }

    thumbEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      isDragging = true;
      dragStartY = e.clientY || 0;
      dragStartScrollTop = Number(contentEl.scrollTop || 0);
      patchClasses(railEl, { 'is-dragging': true });
      if (typeof document !== 'undefined') {
        document.addEventListener('mousemove', onDocMouseMove);
        document.addEventListener('mouseup', onDocMouseUp);
      }
    });

    railEl.addEventListener('mousedown', (e) => {
      if (e.target === thumbEl) return;
      e.preventDefault();
      const rect = railEl.getBoundingClientRect ? railEl.getBoundingClientRect() : null;
      if (!rect || rect.height <= 0) return;
      const clickOffset = (e.clientY || 0) - rect.top;
      const ratio = Math.max(0, Math.min(1, clickOffset / rect.height));
      const overflow = Math.max(0, (contentEl.scrollHeight || 0) - (contentEl.clientHeight || 0));
      contentEl.scrollTop = Math.round(ratio * overflow);
      syncThumb();
    });

    contentEl.addEventListener('scroll', onContentScroll, { passive: true });
    hostEl.addEventListener('mouseenter', syncThumb);

    let resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => syncThumb());
      resizeObserver.observe(hostEl);
      resizeObserver.observe(contentEl);
    }

    syncThumb();

    onCleanup(() => {
      onDocMouseUp();
      if (scrollRafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(scrollRafId);
        scrollRafId = 0;
      }
      contentEl.removeEventListener('scroll', onContentScroll);
      hostEl.removeEventListener('mouseenter', syncThumb);
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
    });

    let pendingSync = false;
    function scheduleSyncThumb() {
      if (typeof queueMicrotask === 'function') {
        if (pendingSync) return;
        pendingSync = true;
        queueMicrotask(() => {
          pendingSync = false;
          syncThumb();
        });
      } else {
        syncThumb();
      }
    }

    return {
      el: hostEl,
      refs: { contentEl, railEl, thumbEl },
      onPropsChange: scheduleSyncThumb,
      methods: {
        refresh() {
          scheduleSyncThumb();
        },
      },
    };
  },
});
return { CustomScrollbar };
})();

// --- src/components/ui/SegmentedControl.js ---
const { SegmentedControl } = (() => {
/**
 * @fileoverview Sliding SegmentedControl switcher with variable-width GPU glider.
 * Measures active button geometry via ResizeObserver so both inline variable-width
 * segments (e.g. "今天 / 1天 / ... / 自定义", "按步查看 (1520) / 总汇总") and equal-width
 * grid bars ("常规 / 结构 / 其他") glide smoothly without stretching from 0px on tab reveal.
 */


const SegmentedControl = defineComponent({
  name: 'SegmentedControl',
  setup({ getProps, setProps, emit, onCleanup }) {
    const gliderEl = h('div', { className: 'seg-glider', 'aria-hidden': 'true' });
    const rootEl = h(
      'div',
      {
        className: 'segmented',
        role: 'group',
        'aria-label': getProps().ariaLabel || '分段切换器',
      },
      [gliderEl]
    );

    const btnMap = new Map();
    let orderedBtns = [];
    let activeBtnEl = null;
    let observedBtnEl = null;
    let hasMeasuredVisible = false;
    let readyRafId = 0;

    function cancelReadyRaf() {
      if (readyRafId && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(readyRafId);
      }
      readyRafId = 0;
    }

    function syncGliderGeometry() {
      if (!activeBtnEl) {
        cancelReadyRaf();
        hasMeasuredVisible = false;
        patchClasses(rootEl, { 'has-glider': false });
        patchClasses(gliderEl, { 'is-ready': false });
        return;
      }

      const w = Number(activeBtnEl.offsetWidth || 0);
      const h = Number(activeBtnEl.offsetHeight || 0);
      if (!(w > 0 && h > 0)) {
        // Hidden parent tab or headless Mock DOM: keep .seg-btn.is-active fallback background
        // and snap cleanly on first real paint when tab becomes visible.
        cancelReadyRaf();
        hasMeasuredVisible = false;
        patchClasses(rootEl, { 'has-glider': false });
        patchClasses(gliderEl, { 'is-ready': false });
        return;
      }

      const x = Number(activeBtnEl.offsetLeft || 0);
      const y = Number(activeBtnEl.offsetTop || 0);
      patchStyleVar(gliderEl, '--glider-x', `${x}px`);
      patchStyleVar(gliderEl, '--glider-y', `${y}px`);
      patchStyleVar(gliderEl, '--glider-w', `${w}px`);
      patchStyleVar(gliderEl, '--glider-h', `${h}px`);
      patchClasses(rootEl, { 'has-glider': true });

      if (!hasMeasuredVisible) {
        hasMeasuredVisible = true;
        patchClasses(gliderEl, { 'is-ready': false });
        void gliderEl.offsetWidth;
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          cancelReadyRaf();
          readyRafId = window.requestAnimationFrame(() => {
            readyRafId = 0;
            if (hasMeasuredVisible) {
              patchClasses(gliderEl, { 'is-ready': true });
            }
          });
        } else {
          patchClasses(gliderEl, { 'is-ready': true });
        }
      }
    }

    let resizeObs = null;
    if (typeof ResizeObserver === 'function') {
      resizeObs = new ResizeObserver(() => {
        syncGliderGeometry();
      });
      resizeObs.observe(rootEl);
    }

    function updateObservedActiveButton(nextActiveBtn) {
      if (!resizeObs || observedBtnEl === nextActiveBtn) return;
      if (observedBtnEl) {
        try {
          resizeObs.unobserve(observedBtnEl);
        } catch {
          // ignore
        }
      }
      observedBtnEl = nextActiveBtn || null;
      if (observedBtnEl) {
        try {
          resizeObs.observe(observedBtnEl);
        } catch {
          // ignore
        }
      }
    }

    function selectValue(nextVal) {
      if (getProps().modelValue !== nextVal) {
        setProps({ modelValue: nextVal });
        emit('update:modelValue', nextVal);
      }
    }

    function syncSegments() {
      const { options = [], modelValue, ariaLabel } = getProps();
      if (ariaLabel) {
        patchAttr(rootEl, 'aria-label', ariaLabel);
      }

      const validKeys = new Set(options.map((opt) => String(opt.value)));
      for (const [key, btn] of btnMap.entries()) {
        if (!validKeys.has(key)) {
          if (btn.parentNode === rootEl) {
            rootEl.removeChild(btn);
          }
          btnMap.delete(key);
        }
      }

      orderedBtns = [];
      let nextActiveBtn = null;

      for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        const key = String(opt.value);
        let btn = btnMap.get(key);
        if (!btn) {
          btn = h('button', {
            type: 'button',
            className: 'seg-btn',
            onClick: (e) => {
              e.stopPropagation();
              selectValue(opt.value);
            },
            onKeydown: (e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault();
                const curOpts = getProps().options || [];
                if (!curOpts.length) return;
                const curIdx = Math.max(
                  0,
                  curOpts.findIndex((o) => String(o.value) === key)
                );
                const delta = e.key === 'ArrowRight' ? 1 : -1;
                const nextIdx = (curIdx + delta + curOpts.length) % curOpts.length;
                const targetOpt = curOpts[nextIdx];
                if (targetOpt) {
                  selectValue(targetOpt.value);
                  btnMap.get(String(targetOpt.value))?.focus?.();
                }
              }
            },
          });
          btnMap.set(key, btn);
        }

        const active = opt.value === modelValue;
        patchText(btn, opt.label);
        patchClasses(btn, { 'is-active': active });
        patchAttr(btn, 'aria-pressed', active ? 'true' : 'false');
        patchAttr(btn, 'data-seg-value', opt.value);
        orderedBtns.push(btn);
        if (active) {
          nextActiveBtn = btn;
        }
      }

      // Ensure gliderEl remains index 0 and buttons follow in exact option order
      if (rootEl.firstChild !== gliderEl) {
        rootEl.insertBefore(gliderEl, rootEl.firstChild);
      }
      for (let i = 0; i < orderedBtns.length; i++) {
        const targetNode = orderedBtns[i];
        const currentAtSlot = rootEl.children[i + 1] || null;
        if (currentAtSlot !== targetNode) {
          rootEl.insertBefore(targetNode, currentAtSlot);
        }
      }

      activeBtnEl = nextActiveBtn || orderedBtns[0] || null;
      updateObservedActiveButton(activeBtnEl);
      syncGliderGeometry();
    }

    syncSegments();

    onCleanup(() => {
      cancelReadyRaf();
      resizeObs?.disconnect?.();
      resizeObs = null;
      observedBtnEl = null;
    });

    return {
      el: rootEl,
      refs: { gliderEl, refreshGlider: syncGliderGeometry },
      onPropsChange: syncSegments,
      getValue: () => getProps().modelValue,
    };
  },
});
return { SegmentedControl };
})();

// --- src/components/ui/ContextSegmentMeter.js ---
const { ContextSegmentMeter } = (() => {
/**
 * @fileoverview 10-channel segmented context window progress bar updated via
 * CSS custom variables against the current model's automatic compaction baseline,
 * dynamically ordered from largest to smallest segment.
 */


const SEGMENT_DEFS = [
  { key: 'assistant', labelKey: 'ctx.ch.assistant', cls: 'seg-assistant', getVal: (c) => Number(c.assistantTokens || 0) },
  { key: 'toolResults', labelKey: 'ctx.ch.toolResults', cls: 'seg-tool-results', getVal: (c) => Number(c.toolResultsTokens || 0) },
  {
    key: 'userInput',
    labelKey: 'ctx.ch.userInput',
    cls: 'seg-user-input',
    getVal: (c) => Number(c.userInputTokens ?? c.messagesTokens ?? 0),
  },
  { key: 'subagent', labelKey: 'ctx.ch.subagent', cls: 'seg-subagent-msg', getVal: (c) => Number(c.subagentTokens || 0) },
  { key: 'checkpoint', labelKey: 'ctx.ch.checkpoint', cls: 'seg-checkpoint', getVal: (c) => Number(c.checkpointTokens || 0) },
  { key: 'systemPrompt', labelKey: 'ctx.ch.systemPrompt', cls: 'seg-system-prompt', getVal: (c) => Number(c.systemPromptTokens || 0) },
  { key: 'systemTools', labelKey: 'ctx.ch.systemTools', cls: 'seg-system-tools', getVal: (c) => Number(c.systemToolsTokens || 0) },
  { key: 'mcpTools', labelKey: 'ctx.ch.mcpTools', cls: 'seg-mcp-tools', getVal: (c) => Number(c.mcpToolsTokens || 0) },
  { key: 'skills', labelKey: 'ctx.ch.skills', cls: 'seg-skills', getVal: (c) => Number(c.skillsTokens || 0) },
  { key: 'userRules', labelKey: 'ctx.ch.userRules', cls: 'seg-user-rules', getVal: (c) => Number(c.userRulesTokens || 0) },
];

const ContextSegmentMeter = defineComponent({
  name: 'ContextSegmentMeter',
  setup({ getProps }) {
    // 固定 10 个位置槽位节点，不通过 appendChild 移动 DOM，防止浏览器中断 CSS transition 动画
    const slotEls = SEGMENT_DEFS.map((def) =>
      h('div', { className: `progress-seg ${def.cls}` })
    );

    const trackEl = h(
      'div',
      {
        className: 'progress-track ctx-segment-meter',
        role: 'progressbar',
        'aria-valuemin': '0',
        'aria-valuemax': '100',
      },
      slotEls
    );

    let lastOrderSig = '';

    function syncMeter() {
      const ctx = getProps().context || {};
      const limit = Math.max(1, Number(ctx.compactionLimitTokens || ctx.limitTokens || 256000));
      const scored = SEGMENT_DEFS.map((def, defaultOrder) => {
        const val = def.getVal(ctx);
        const pct = Math.min(100, (val / limit) * 100);
        return { def, defaultOrder, val, pct };
      });

      scored.sort((a, b) => b.val - a.val || a.defaultOrder - b.defaultOrder);
      // 仅关注非零通道的相对顺序变化，决定是否启用 0.05s 先变色再伸缩的衔接延迟
      const activeOrderSig = scored
        .filter((x) => x.val > 0)
        .map((x) => x.def.key)
        .join(',');
      const orderChanged = Boolean(lastOrderSig && activeOrderSig && activeOrderSig !== lastOrderSig);
      if (activeOrderSig) {
        lastOrderSig = activeOrderSig;
      }

      patchClasses(trackEl, { 'is-reordering': orderChanged });

      let seenActive = false;
      for (let i = 0; i < slotEls.length; i++) {
        const slotEl = slotEls[i];
        const item = scored[i];
        const isActive = item.val > 0 && item.pct > 0;
        const hasSep = isActive && seenActive;
        if (isActive) seenActive = true;
        const cls = `progress-seg ${item.def.cls}${isActive ? ' is-active' : ''}${hasSep ? ' has-sep' : ''}`;
        patchAttr(slotEl, 'class', cls);
        patchStyleVar(slotEl, '--seg-w', isActive ? `${item.pct.toFixed(2)}%` : '0%');
        patchAttr(
          slotEl,
          'title',
          isActive
            ? `${t(item.def.labelKey)} · ${formatTokens(item.val)} (${item.pct.toFixed(1)}%)`
            : null
        );
      }

      patchAttr(trackEl, 'aria-valuenow', Math.round(ctx.compactionUsedPct ?? ctx.usedPct ?? 0));
    }

    syncMeter();

    return {
      el: trackEl,
      refs: { segments: slotEls },
      onPropsChange: syncMeter,
    };
  },
});
return { ContextSegmentMeter };
})();

// --- src/components/ui/FourSegmentBar.js ---
const { createFourSegmentBar } = (() => {
/**
 * @fileoverview 通用 4 段式 Token 构成比例条组件 (FourSegmentBar).
 * 用于在消费概览、热门模型明细及数据来源明细中直观展示：
 * 直接输入 (Input)、缓存读取 (Cached)、内容生成 (Output) 与思考推理 (Thinking) 的 Token 占比。
 */


/**
 * 创建 4 段式水平比例进度条实例。
 * 通过动态更新各分段节点的 `--seg-w` CSS 变量实现零重排平滑过渡。
 *
 * @returns {{
 *   el: HTMLElement,
 *   update: (metrics: {
 *     inputTokens?: number,
 *     cacheReadTokens?: number,
 *     responseTokens?: number,
 *     thinkingTokens?: number
 *   }) => void
 * }} 组件根元素与增量更新方法
 */
function createFourSegmentBar() {
  const segInput = h('div', { className: 'progress-seg seg-input' });
  const segCached = h('div', { className: 'progress-seg seg-cached' });
  const segOutput = h('div', { className: 'progress-seg seg-output' });
  const segThinking = h('div', { className: 'progress-seg seg-thinking' });
  const el = h('div', { className: 'progress-track cons-seg-bar' }, [
    segInput,
    segCached,
    segOutput,
    segThinking,
  ]);

  /**
   * 根据四类 Token 数量与整体行宽占比系数 (`scaleRatio`，默认 `1` 占满 100%) 重新计算并写入各分段百分比宽度。
   */
  function update({
    inputTokens = 0,
    cacheReadTokens = 0,
    responseTokens = 0,
    thinkingTokens = 0,
    scaleRatio = 1,
  }) {
    const sum = inputTokens + cacheReadTokens + responseTokens + thinkingTokens;
    const clampedRatio = Number.isFinite(Number(scaleRatio))
      ? Math.min(1, Math.max(0, Number(scaleRatio)))
      : 1;
    if (sum <= 0 || clampedRatio <= 0) {
      patchStyleVar(segInput, '--seg-w', '0%');
      patchStyleVar(segCached, '--seg-w', '0%');
      patchStyleVar(segOutput, '--seg-w', '0%');
      patchStyleVar(segThinking, '--seg-w', '0%');
      return;
    }
    patchStyleVar(segInput, '--seg-w', `${((inputTokens / sum) * 100 * clampedRatio).toFixed(2)}%`);
    patchStyleVar(segCached, '--seg-w', `${((cacheReadTokens / sum) * 100 * clampedRatio).toFixed(2)}%`);
    patchStyleVar(segOutput, '--seg-w', `${((responseTokens / sum) * 100 * clampedRatio).toFixed(2)}%`);
    patchStyleVar(segThinking, '--seg-w', `${((thinkingTokens / sum) * 100 * clampedRatio).toFixed(2)}%`);
  }

  return { el, update };
}
return { createFourSegmentBar };
})();

// --- src/components/charts/TrendAreaChart.js ---
const { HEATMAP_DAYS_THRESHOLD, createTrendAreaChart } = (() => {
/**
 * @fileoverview 交互式历史用量趋势图组件 (TrendAreaChart).
 * 支持双模式自适应切换：
 * 1. <= 90 天（或整点小时分桶）：渲染三次贝塞尔平滑曲线面积图、峰值气泡与对齐多刻度时间轴；
 * 2. > 90 天（自然日分桶）：自动切换为类 GitHub 贡献日历的小格子热力排列（一格一天，7 行星期 × 周列、月份刻度、分位数 5 档热力色阶与底部图例）；
 * 3. 两种模式共享自适应防溢出的悬浮详情卡片（精确日期/小时区间、Token 拆分、费用与调用次数）。
 */


/** 超过该自然日天数（> 90 天）时，趋势图切换为类 GitHub 每日小格子热力图 */
const HEATMAP_DAYS_THRESHOLD = 90;

let chartUidCounter = 0;

function safeSlotTokens(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 将二维采样点序列转换为水平张力平滑的三次贝塞尔曲线 SVG 路径 (`M ... C ...`)。
 * 控制点沿 X 轴取相邻点间距的 `0.42` 张力系数，Y 轴与各自端点齐平，
 * 保证曲线在极值点处平缓过渡且不会产生上下过冲 (Overshoot)。
 *
 * @param {Array<{ x: number, y: number }>} points SVG 坐标系下的采样点数组（长度 >= 2）
 * @returns {string} SVG `<path>` 的 `d` 属性字符串
 */
function buildSmoothSplinePath(points) {
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const cpx1 = p0.x + (p1.x - p0.x) * 0.42;
    const cpx2 = p1.x - (p1.x - p0.x) * 0.42;
    d += ` C ${cpx1.toFixed(1)} ${p0.y.toFixed(1)}, ${cpx2.toFixed(1)} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }
  return d;
}

/**
 * 根据分桶总数与标签平均长度，计算底部 X 轴应当展示的均匀刻度下标列表。
 *
 * @param {Array<{ label?: string }>} slots
 * @returns {number[]}
 */
function computeTickIndices(slots) {
  const n = slots.length;
  if (n <= 1) return [0];
  if (n <= 8) {
    return Array.from({ length: n }, (_, i) => i);
  }
  const sampleLabel = String(slots[Math.floor(n / 2)]?.label || slots[0]?.label || '');
  const maxTicks = sampleLabel.length > 6 ? 5 : 6;
  const set = new Set();
  for (let k = 0; k < maxTicks; k++) {
    const idx = Math.round((k / (maxTicks - 1)) * (n - 1));
    set.add(idx);
  }
  return Array.from(set).sort((a, b) => a - b);
}

/**
 * 基于非零活跃日的分位数阈值计算热力图 5 档色阶（0 ~ 4），避免单日极端峰值压缩其余活跃日的层次对比。
 *
 * @param {number[]} nonZeroValues 已升序排列的正数 Token 列表
 * @param {number} maxTokens
 * @returns {{ q1: number, q2: number, q3: number, maxTokens: number, count: number }}
 */
function computeHeatmapThresholds(nonZeroValues, maxTokens) {
  const n = nonZeroValues.length;
  if (n === 0 || maxTokens <= 0) {
    return { q1: 0, q2: 0, q3: 0, maxTokens: 0, count: 0 };
  }
  if (n < 4) {
    return {
      q1: maxTokens * 0.25,
      q2: maxTokens * 0.5,
      q3: maxTokens * 0.75,
      maxTokens,
      count: n,
    };
  }
  return {
    q1: nonZeroValues[Math.floor((n - 1) * 0.25)],
    q2: nonZeroValues[Math.floor((n - 1) * 0.5)],
    q3: nonZeroValues[Math.floor((n - 1) * 0.75)],
    maxTokens,
    count: n,
  };
}

function resolveHeatmapLevel(tokens, thresholds) {
  if (tokens <= 0 || thresholds.maxTokens <= 0) return 0;
  if (tokens >= thresholds.maxTokens || tokens > thresholds.q3) return 4;
  if (tokens > thresholds.q2) return 3;
  if (tokens > thresholds.q1) return 2;
  return 1;
}

/**
 * 解析日期槽位的年份与月份信息（兼容真实时间戳 `startMs` 与测试简写 `label`）。
 *
 * @param {object} slot
 * @returns {{ year: number, month: number, day: number }}
 */
function parseSlotCalendarParts(slot) {
  const sMs = Number(slot?.startMs);
  if (Number.isFinite(sMs) && sMs > 0) {
    const d = new Date(sMs);
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  }
  const m = String(slot?.label || '').match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    return { year: new Date().getFullYear(), month: Number(m[1]), day: Number(m[2]) };
  }
  return { year: new Date().getFullYear(), month: 0, day: 0 };
}

/**
 * 构建热力图顶部与周列对齐的月份刻度标签（自动跳过首尾过窄残月，防止相邻月份文字重叠）。
 *
 * @param {Array<object>} slots
 * @param {number} firstDow 首日对应的星期行索引（0 = 周一 .. 6 = 周日）
 * @param {number} totalWeeks 总周列数
 * @returns {Array<{ col: number, text: string }>}
 */
function buildHeatmapMonthTicks(slots, firstDow, totalWeeks) {
  if (!slots.length || totalWeeks <= 0) return [];
  const firstParts = parseSlotCalendarParts(slots[0]);
  const lastParts = parseSlotCalendarParts(slots[slots.length - 1]);
  const crossYear = firstParts.year !== lastParts.year;

  const candidates = [];
  let prevMonthKey = '';

  for (let col = 0; col < totalWeeks; col++) {
    let chosenParts = null;
    for (let row = 0; row < 7; row++) {
      const idx = col * 7 + row - firstDow;
      if (idx < 0 || idx >= slots.length) continue;
      const parts = parseSlotCalendarParts(slots[idx]);
      if (!parts.month) continue;
      const mKey = `${parts.year}-${parts.month}`;
      if (col === 0 && !chosenParts) {
        chosenParts = parts;
        prevMonthKey = mKey;
        break;
      }
      if (mKey !== prevMonthKey) {
        chosenParts = parts;
        prevMonthKey = mKey;
        break;
      }
    }
    if (chosenParts && chosenParts.month > 0) {
      candidates.push({ col, year: chosenParts.year, month: chosenParts.month });
    }
  }

  const baseMinGap = totalWeeks > 40 ? 4 : 3;
  if (
    candidates.length >= 2 &&
    candidates[0].col === 0 &&
    candidates[1].col - candidates[0].col < baseMinGap
  ) {
    candidates.shift();
  }

  const ticks = [];
  let nextAllowedCol = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (totalWeeks > 16 && c.col >= totalWeeks - 1) continue;
    if (ticks.length > 0 && c.col < nextAllowedCol) continue;
    const showYear = crossYear && (c.month === 1 || ticks.length === 0);
    const text = showYear
      ? t('chart.trend.hmMonthYear', { yy: String(c.year).slice(-2), month: c.month })
      : t('chart.trend.hmMonthOnly', { month: c.month });
    ticks.push({ col: c.col, text });
    nextAllowedCol = c.col + (showYear ? baseMinGap + 1 : baseMinGap);
  }
  return ticks;
}

/**
 * 创建交互式历史趋势组件（<=90 天为 SVG 平滑曲线图，>90 天自动切换为类 GitHub 每日小格子热力图）。
 *
 * @returns {{
 *   el: HTMLElement,
 *   update: (series?: Array<object>) => void
 * }}
 */
function createTrendAreaChart() {
  const DEFAULT_VIEW_W = 460;
  const VIEW_H = 184;
  const TOP_Y = 26;
  const BOTTOM_Y = 164;
  const SPAN_Y = BOTTOM_Y - TOP_Y;

  let viewW = DEFAULT_VIEW_W;

  function resolvePlotBounds(w) {
    const leftX = 1;
    const rightX = Math.max(leftX + 20, w - 1);
    return { leftX, rightX, spanX: rightX - leftX };
  }

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${viewW} ${VIEW_H}`);
  svg.setAttribute('class', 'trend-svg');
  svg.setAttribute('aria-hidden', 'true');

  // 垂直线性渐变（每实例独立 ID，避免多图表挂载时 SVG url(#...) 冲突）
  const gradId = `trend-area-grad-${++chartUidCounter}`;
  const defs = document.createElementNS(SVG_NS, 'defs');
  const grad = document.createElementNS(SVG_NS, 'linearGradient');
  grad.setAttribute('id', gradId);
  grad.setAttribute('x1', '0');
  grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '0');
  grad.setAttribute('y2', '1');

  const stop1 = document.createElementNS(SVG_NS, 'stop');
  stop1.setAttribute('offset', '0%');
  stop1.setAttribute('stop-color', 'var(--ctx-cached)');
  stop1.setAttribute('stop-opacity', '0.34');

  const stop2 = document.createElementNS(SVG_NS, 'stop');
  stop2.setAttribute('offset', '100%');
  stop2.setAttribute('stop-color', 'var(--ctx-cached)');
  stop2.setAttribute('stop-opacity', '0.0');

  grad.appendChild(stop1);
  grad.appendChild(stop2);
  defs.appendChild(grad);
  svg.appendChild(defs);

  // 背景水平与垂直参考网格线（水平网格全宽贴边铺满 0..viewW）
  const hGridGroup = document.createElementNS(SVG_NS, 'g');
  hGridGroup.setAttribute('class', 'trend-grid');
  const hGridLines = [];
  for (const y of [
    TOP_Y,
    Math.round(TOP_Y + SPAN_Y / 3),
    Math.round(TOP_Y + (SPAN_Y * 2) / 3),
    BOTTOM_Y,
  ]) {
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', '0');
    line.setAttribute('y1', String(y));
    line.setAttribute('x2', String(viewW));
    line.setAttribute('y2', String(y));
    hGridGroup.appendChild(line);
    hGridLines.push(line);
  }
  svg.appendChild(hGridGroup);

  const vGridGroup = document.createElementNS(SVG_NS, 'g');
  vGridGroup.setAttribute('class', 'trend-grid trend-v-grid');
  svg.appendChild(vGridGroup);

  const areaPath = document.createElementNS(SVG_NS, 'path');
  areaPath.setAttribute('fill', `url(#${gradId})`);
  svg.appendChild(areaPath);

  const linePath = document.createElementNS(SVG_NS, 'path');
  linePath.setAttribute('class', 'trend-line');
  linePath.setAttribute('fill', 'none');
  svg.appendChild(linePath);

  const dotsGroup = document.createElementNS(SVG_NS, 'g');
  dotsGroup.setAttribute('class', 'trend-dots-group');
  svg.appendChild(dotsGroup);

  const peakDot = document.createElementNS(SVG_NS, 'circle');
  peakDot.setAttribute('r', '3');
  peakDot.setAttribute('class', 'trend-peak-dot');
  svg.appendChild(peakDot);

  // 悬停十字准星与焦点圆点
  const hoverLine = document.createElementNS(SVG_NS, 'line');
  hoverLine.setAttribute('class', 'trend-hover-line');
  hoverLine.setAttribute('y1', '12');
  hoverLine.setAttribute('y2', String(BOTTOM_Y));
  hoverLine.setAttribute('hidden', 'true');
  svg.appendChild(hoverLine);

  const hoverDot = document.createElementNS(SVG_NS, 'circle');
  hoverDot.setAttribute('r', '3.2');
  hoverDot.setAttribute('class', 'trend-hover-dot');
  hoverDot.setAttribute('hidden', 'true');
  svg.appendChild(hoverDot);

  const peakPill = h('span', { className: 'trend-peak-pill text-mono', text: '0' });

  function createTooltipModelRow() {
    const dotEl = h('span', { className: 'dot-swatch cons-model-dot' });
    const nameEl = h('span', { className: 'cons-pop-model-name' });
    const tokEl = h('span', { className: 'cons-pop-model-tok' });
    const pctEl = h('strong', { className: 'cons-pop-model-pct' });
    const rowEl = h('div', { className: 'cons-pop-model-row' }, [
      h('span', { className: 'cons-pop-model-left' }, [dotEl, nameEl]),
      h('span', { className: 'cons-pop-model-right text-mono' }, [tokEl, pctEl]),
    ]);
    return {
      el: rowEl,
      refs: { rowEl, dotEl, nameEl, tokEl, pctEl },
    };
  }

  // 共享悬停详情浮层卡片（曲线图与热力格子图共用，含该时段分模型占比明细）
  const tipTimeEl = h('span', { className: 'trend-tip-time text-mono' });
  const tipCallsEl = h('span', { className: 'trend-tip-calls text-mono' });
  const tipTokensEl = h('strong', { className: 'trend-tip-tokens text-mono' });
  const tipCostEl = h('span', { className: 'trend-tip-cost text-mono' });
  const tipSubEl = h('div', { className: 'trend-tip-sub text-mono', hidden: true });
  const tipModelsEl = h('div', { className: 'cons-pop-models', hidden: true });

  const tooltipEl = h(
    'div',
    { className: 'trend-tooltip', hidden: true },
    [
      h('div', { className: 'trend-tip-head' }, [tipTimeEl, tipCallsEl]),
      h('div', { className: 'trend-tip-main' }, [tipTokensEl, tipCostEl]),
      tipSubEl,
      tipModelsEl,
    ]
  );

  // 底部对齐刻度轴（曲线模式）
  const xAxisEl = h('div', { className: 'trend-x-axis' });
  const plotStage = h('div', { className: 'trend-plot-stage' }, [peakPill, svg]);

  // 类 GitHub 每日小格子热力图容器（> 90 天模式）
  const wdayMonEl = h('span', { className: 'trend-hm-wday', text: t('chart.trend.wdayMon') });
  const wdayWedEl = h('span', { className: 'trend-hm-wday', text: t('chart.trend.wdayWed') });
  const wdayFriEl = h('span', { className: 'trend-hm-wday', text: t('chart.trend.wdayFri') });
  const wdaySunEl = h('span', { className: 'trend-hm-wday', text: t('chart.trend.wdaySun') });
  const hmWeekdaysEl = h('div', { className: 'trend-hm-weekdays', 'aria-hidden': 'true' }, [
    h('span', { className: 'trend-hm-month-spacer' }),
    wdayMonEl,
    h('span', { className: 'trend-hm-wday', text: '' }),
    wdayWedEl,
    h('span', { className: 'trend-hm-wday', text: '' }),
    wdayFriEl,
    h('span', { className: 'trend-hm-wday', text: '' }),
    wdaySunEl,
  ]);
  const hmMonthsEl = h('div', { className: 'trend-hm-months' });
  const hmGridEl = h('div', {
    className: 'trend-hm-grid',
    role: 'grid',
    'aria-label': t('chart.trend.hmAria'),
  });
  const hmTrackEl = h('div', { className: 'trend-hm-track' }, [hmMonthsEl, hmGridEl]);
  const hmScrollEl = h('div', { className: 'trend-hm-scroll' }, [hmTrackEl]);
  const hmBodyEl = h('div', { className: 'trend-heatmap-body' }, [hmWeekdaysEl, hmScrollEl]);

  const hmSummaryEl = h('span', { className: 'trend-hm-summary text-mono', text: '' });
  const hmLessEl = h('span', { text: t('chart.trend.hmLess') });
  const hmMoreEl = h('span', { text: t('chart.trend.hmMore') });
  const hmLegendEl = h('span', { className: 'trend-hm-legend', 'aria-hidden': 'true' }, [
    hmLessEl,
    h('span', { className: 'trend-hm-swatch lv-0' }),
    h('span', { className: 'trend-hm-swatch lv-1' }),
    h('span', { className: 'trend-hm-swatch lv-2' }),
    h('span', { className: 'trend-hm-swatch lv-3' }),
    h('span', { className: 'trend-hm-swatch lv-4' }),
    hmMoreEl,
  ]);
  const hmFooterEl = h('div', { className: 'trend-hm-footer' }, [hmSummaryEl, hmLegendEl]);
  const heatmapStage = h('div', { className: 'trend-heatmap-stage', hidden: true }, [
    hmBodyEl,
    hmFooterEl,
  ]);

  const chartWrap = h('div', { className: 'trend-chart-wrap' }, [
    plotStage,
    xAxisEl,
    heatmapStage,
    tooltipEl,
  ]);

  let currentSlots = [];
  let currentPts = [];
  let currentIsHeatmap = false;
  let currentHeatmapWeeks = 0;
  let currentHeatmapFirstDow = 0;
  let currentHeatmapGapPx = 2;
  let currentCellEls = [];
  let tickElsByIdx = new Map();
  let hoveredIdx = -1;
  let hoveredCellEl = null;
  let lastRenderSig = '';
  let tipTrackRaf = 0;

  function cancelTipTrackRaf() {
    if (tipTrackRaf && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(tipTrackRaf);
    }
    tipTrackRaf = 0;
  }

  function armTooltipTracking(wasHidden) {
    if (!wasHidden) return;
    patchClasses(tooltipEl, { 'is-tracking': false });
    patchClasses(hoverDot, { 'is-tracking': false });
    void tooltipEl.offsetWidth;
    cancelTipTrackRaf();
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      tipTrackRaf = window.requestAnimationFrame(() => {
        tipTrackRaf = 0;
        if (!tooltipEl.hasAttribute('hidden')) {
          patchClasses(tooltipEl, { 'is-tracking': true });
          patchClasses(hoverDot, { 'is-tracking': true });
        }
      });
    } else {
      patchClasses(tooltipEl, { 'is-tracking': true });
      patchClasses(hoverDot, { 'is-tracking': true });
    }
  }

  function populateTooltipContent(slot) {
    patchText(tipTimeEl, slot.fullLabel || slot.label || '--');
    patchText(
      tipCallsEl,
      t('cons.callsCount', { calls: Math.max(0, Math.floor(Number(slot.calls) || 0)) })
    );
    const slotTok = safeSlotTokens(slot.tokens);
    patchText(tipTokensEl, `${formatTokensPrecise(slotTok)} tok`);
    const slotCost = Number.isFinite(Number(slot.costUsd)) ? Math.max(0, Number(slot.costUsd)) : 0;
    patchText(
      tipCostEl,
      formatUsd(slotCost, {
        precise: slotCost > 0 && slotCost < 0.1,
      })
    );

    const hasSubBreakdown =
      slotTok > 0 &&
      (slot.inputTokens !== undefined ||
        slot.cacheReadTokens !== undefined ||
        slot.outputTokens !== undefined);
    patchAttr(tipSubEl, 'hidden', !hasSubBreakdown);
    if (hasSubBreakdown) {
      patchText(
        tipSubEl,
        t('chart.step.ioSplit', {
          inTok: formatTokensPrecise(safeSlotTokens(slot.inputTokens)),
          cacheTok: formatTokensPrecise(safeSlotTokens(slot.cacheReadTokens)),
          outTok: formatTokensPrecise(safeSlotTokens(slot.outputTokens)),
        })
      );
    }

    const modelSegs = Array.isArray(slot.modelSegments) ? slot.modelSegments : [];
    patchAttr(tipModelsEl, 'hidden', modelSegs.length === 0);
    patchKeyedList(tipModelsEl, modelSegs, {
      keyFn: (r) => r.key,
      sigFn: (r) => `${r.key}:${r.label}:${r.color}:${r.tokText}:${r.pctText}:${r.isOther}`,
      createRow: createTooltipModelRow,
      updateRow: (rRefs, r) => {
        patchClasses(rRefs.rowEl, { 'is-other': Boolean(r.isOther) });
        patchStyleVar(rRefs.dotEl, '--dot-color', r.color);
        patchText(rRefs.nameEl, r.label);
        patchText(rRefs.tokEl, r.tokText);
        patchText(rRefs.pctEl, r.pctText);
      },
    });
  }

  function showLineHoverAtIndex(idx) {
    if (currentIsHeatmap || idx < 0 || idx >= currentSlots.length || !currentPts[idx]) {
      clearHover();
      return;
    }
    const wasHidden = tooltipEl.hasAttribute('hidden');
    hoveredIdx = idx;
    const slot = currentSlots[idx];
    const pt = currentPts[idx];

    patchAttr(hoverLine, 'hidden', false);
    patchAttr(hoverLine, 'x1', pt.x.toFixed(1));
    patchAttr(hoverLine, 'x2', pt.x.toFixed(1));

    patchAttr(hoverDot, 'hidden', false);
    patchAttr(hoverDot, 'cx', pt.x.toFixed(1));
    patchAttr(hoverDot, 'cy', pt.y.toFixed(1));

    const isLineLow = pt.y < Math.round((TOP_Y + BOTTOM_Y) / 2);
    patchAttr(peakPill, 'hidden', true);
    patchClasses(tooltipEl, {
      'is-hm-bottom': false,
      'is-hm-top': false,
      'is-line-low': isLineLow,
    });
    patchAttr(tooltipEl, 'hidden', false);
    populateTooltipContent(slot);

    let tipY = 0;
    if (isLineLow) {
      const wrapH = Number(chartWrap.offsetHeight || 0);
      const tipH = Number(tooltipEl.offsetHeight || 0);
      if (wrapH > 0 && tipH > 0) {
        tipY = Math.max(0, wrapH - tipH - 22);
      }
    }

    const rawPct = (pt.x / viewW) * 100;
    const clampedPct = Math.max(1, Math.min(99, rawPct));
    patchStyleVar(tooltipEl, '--tip-x', `${clampedPct.toFixed(1)}%`);
    patchStyleVar(tooltipEl, '--tip-shift', `-${clampedPct.toFixed(1)}%`);
    patchStyleVar(tooltipEl, '--tip-y', `${Math.round(tipY)}px`);
    armTooltipTracking(wasHidden);

    for (const [tIdx, el] of tickElsByIdx.entries()) {
      patchClasses(el, { 'is-hovered': tIdx === idx });
    }
  }

  function showHeatmapHoverAtIndex(idx, cellEl) {
    if (!currentIsHeatmap || idx < 0 || idx >= currentSlots.length) {
      clearHover();
      return;
    }
    const targetCell = cellEl || currentCellEls[idx] || null;
    if (!targetCell) {
      clearHover();
      return;
    }
    hoveredIdx = idx;
    if (hoveredCellEl && hoveredCellEl !== targetCell) {
      patchClasses(hoveredCellEl, { 'is-hovered': false });
    }
    hoveredCellEl = targetCell;
    patchClasses(targetCell, { 'is-hovered': true });

    const slot = currentSlots[idx];
    const row = Number(targetCell.getAttribute('data-hm-row') || 0);
    const col = Number(targetCell.getAttribute('data-hm-col') || 0);

    const wasHidden = tooltipEl.hasAttribute('hidden');
    // 上半区（周一~周四）浮层停靠热力图下方，下半区（周五~周日）停靠热力图上方，互不遮挡被悬停格子且永不越界裁剪
    patchClasses(tooltipEl, {
      'is-hm-bottom': row <= 3,
      'is-hm-top': row > 3,
      'is-line-low': false,
    });
    patchAttr(tooltipEl, 'hidden', false);
    populateTooltipContent(slot);

    const wrapRect = chartWrap.getBoundingClientRect();
    const cellRect = targetCell.getBoundingClientRect();
    let rawPct = 50;
    if (
      wrapRect &&
      wrapRect.width > 0 &&
      cellRect &&
      cellRect.width > 0 &&
      cellRect.width < wrapRect.width
    ) {
      rawPct = ((cellRect.left + cellRect.width / 2 - wrapRect.left) / wrapRect.width) * 100;
    } else if (currentHeatmapWeeks > 0) {
      rawPct = ((col + 0.5) / currentHeatmapWeeks) * 100;
    }
    const clampedPct = Math.max(1, Math.min(99, rawPct));
    patchStyleVar(tooltipEl, '--tip-x', `${clampedPct.toFixed(1)}%`);
    patchStyleVar(tooltipEl, '--tip-shift', `-${clampedPct.toFixed(1)}%`);
    patchStyleVar(tooltipEl, '--tip-y', '0px');
    armTooltipTracking(wasHidden);
  }

  function clearHover() {
    cancelTipTrackRaf();
    hoveredIdx = -1;
    patchAttr(hoverLine, 'hidden', true);
    patchAttr(hoverDot, 'hidden', true);
    patchAttr(tooltipEl, 'hidden', true);
    patchClasses(tooltipEl, {
      'is-hm-bottom': false,
      'is-hm-top': false,
      'is-line-low': false,
      'is-tracking': false,
    });
    patchClasses(hoverDot, { 'is-tracking': false });
    if (!currentIsHeatmap) {
      patchAttr(peakPill, 'hidden', false);
    }
    if (hoveredCellEl) {
      patchClasses(hoveredCellEl, { 'is-hovered': false });
      hoveredCellEl = null;
    }
    for (const el of tickElsByIdx.values()) {
      patchClasses(el, { 'is-hovered': false });
    }
  }

  function syncViewWidth() {
    const measured = Math.round(
      plotStage.clientWidth ||
        svg.clientWidth ||
        plotStage.getBoundingClientRect?.()?.width ||
        0
    );
    if (measured >= 160 && measured !== viewW) {
      viewW = measured;
      svg.setAttribute('viewBox', `0 0 ${viewW} ${VIEW_H}`);
      for (const line of hGridLines) {
        line.setAttribute('x1', '0');
        line.setAttribute('x2', String(viewW));
      }
      return true;
    }
    return false;
  }

  function handlePointerMove(e) {
    if (currentIsHeatmap || !currentSlots.length) return;
    const rect = svg.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const relX = ((e.clientX - rect.left) / rect.width) * viewW;
    const { leftX, spanX } = resolvePlotBounds(viewW);
    const ratio = (relX - leftX) / Math.max(1, spanX);
    const idx = Math.max(
      0,
      Math.min(currentSlots.length - 1, Math.round(ratio * (currentSlots.length - 1)))
    );
    showLineHoverAtIndex(idx);
  }

  function findDirectHeatmapCell(e) {
    let cur = e?.target || null;
    while (cur && cur !== hmGridEl) {
      const idxAttr = cur.getAttribute?.('data-slot-idx');
      if (idxAttr !== null && idxAttr !== undefined && idxAttr !== '') {
        const idx = Number(idxAttr);
        if (Number.isFinite(idx) && idx >= 0 && idx < currentSlots.length) {
          return { idx, cellEl: cur };
        }
      }
      cur = cur.parentNode || null;
    }
    return null;
  }

  function resolveHeatmapCellFromPointer(e) {
    const directHit = findDirectHeatmapCell(e);
    if (directHit) return directHit;

    const clientX = Number(e?.clientX);
    const clientY = Number(e?.clientY);
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      if (hoveredIdx >= 0 && hoveredIdx < currentSlots.length && currentCellEls[hoveredIdx]) {
        return { idx: hoveredIdx, cellEl: currentCellEls[hoveredIdx] };
      }
      return null;
    }

    const rect = hmGridEl.getBoundingClientRect?.();
    if (!rect || !(rect.width > 0) || !(rect.height > 0) || currentHeatmapWeeks <= 0) {
      if (hoveredIdx >= 0 && hoveredIdx < currentSlots.length && currentCellEls[hoveredIdx]) {
        return { idx: hoveredIdx, cellEl: currentCellEls[hoveredIdx] };
      }
      return null;
    }

    const W = currentHeatmapWeeks;
    const G = currentHeatmapGapPx;
    const relX = clientX - rect.left;
    const relY = clientY - rect.top;
    if (
      relX < -(G + 1) ||
      relX > rect.width + G + 1 ||
      relY < -(G + 1) ||
      relY > rect.height + G + 1
    ) {
      return null;
    }

    const pitchX = (rect.width + G) / W;
    const pitchY = (rect.height + G) / 7;
    const cellW = Math.max(1, pitchX - G);
    const cellH = Math.max(1, pitchY - G);

    function distanceToCell(c, r) {
      const x0 = c * pitchX;
      const y0 = r * pitchY;
      const dx = relX < x0 ? x0 - relX : relX > x0 + cellW ? relX - (x0 + cellW) : 0;
      const dy = relY < y0 ? y0 - relY : relY > y0 + cellH ? relY - (y0 + cellH) : 0;
      return { chebyshev: Math.max(dx, dy), distSq: dx * dx + dy * dy };
    }

    // 指针滑入当前悬停格四周的空隙（gap）时保持原高亮，彻底消除跨格空隙闪烁与边缘微抖
    if (hoveredIdx >= 0 && hoveredIdx < currentSlots.length && currentCellEls[hoveredIdx]) {
      const curGridPos = currentHeatmapFirstDow + hoveredIdx;
      const curCol = Math.floor(curGridPos / 7);
      const curRow = curGridPos % 7;
      if (distanceToCell(curCol, curRow).chebyshev <= G + 0.75) {
        return { idx: hoveredIdx, cellEl: currentCellEls[hoveredIdx] };
      }
    }

    // 快速扫过或初始落入格子间隙时，按网格步距吸附到最近的有效日期格
    const approxCol = Math.max(0, Math.min(W - 1, Math.floor((relX + G * 0.5) / pitchX)));
    const approxRow = Math.max(0, Math.min(6, Math.floor((relY + G * 0.5) / pitchY)));
    const directSlotIdx = approxCol * 7 + approxRow - currentHeatmapFirstDow;
    if (
      directSlotIdx >= 0 &&
      directSlotIdx < currentSlots.length &&
      currentCellEls[directSlotIdx]
    ) {
      return { idx: directSlotIdx, cellEl: currentCellEls[directSlotIdx] };
    }

    // 首周补位或末周未来空白边缘：仅当仍在相邻有效格的间隙光晕内才吸附，深入纯空白角则清空
    let bestIdx = -1;
    let bestDistSq = Infinity;
    for (let dc = -1; dc <= 1; dc++) {
      const c = approxCol + dc;
      if (c < 0 || c >= W) continue;
      for (let dr = -1; dr <= 1; dr++) {
        const r = approxRow + dr;
        if (r < 0 || r > 6) continue;
        const sIdx = c * 7 + r - currentHeatmapFirstDow;
        if (sIdx < 0 || sIdx >= currentSlots.length || !currentCellEls[sIdx]) continue;
        const d = distanceToCell(c, r);
        if (d.chebyshev <= G + 1.5 && d.distSq < bestDistSq) {
          bestDistSq = d.distSq;
          bestIdx = sIdx;
        }
      }
    }
    if (bestIdx >= 0) {
      return { idx: bestIdx, cellEl: currentCellEls[bestIdx] };
    }
    return null;
  }

  function handleHeatmapPointer(e) {
    if (!currentIsHeatmap || !currentSlots.length) return;
    const hit = resolveHeatmapCellFromPointer(e);
    if (!hit || !Number.isFinite(hit.idx)) {
      clearHover();
      return;
    }
    if (hit.idx !== hoveredIdx || hit.cellEl !== hoveredCellEl) {
      showHeatmapHoverAtIndex(hit.idx, hit.cellEl);
    }
  }

  function handleHeatmapWheel(e) {
    if (!currentIsHeatmap) return;
    const maxScrollLeft = (hmScrollEl.scrollWidth || 0) - (hmScrollEl.clientWidth || 0);
    if (maxScrollLeft <= 2) return;
    const dy = Number(e.deltaY || 0);
    const dx = Number(e.deltaX || 0);
    if (Math.abs(dy) > Math.abs(dx) && dy !== 0) {
      const prev = hmScrollEl.scrollLeft || 0;
      const next = Math.max(0, Math.min(maxScrollLeft, prev + dy));
      if (next !== prev) {
        hmScrollEl.scrollLeft = next;
        e.preventDefault?.();
      }
    }
  }

  plotStage.addEventListener('mousemove', handlePointerMove);
  plotStage.addEventListener('mouseleave', clearHover);

  hmGridEl.addEventListener('mouseover', handleHeatmapPointer);
  hmGridEl.addEventListener('mousemove', handleHeatmapPointer);
  hmGridEl.addEventListener('click', handleHeatmapPointer);
  hmGridEl.addEventListener('mouseleave', clearHover);
  hmScrollEl.addEventListener('wheel', handleHeatmapWheel);

  let resizeObs = null;
  let onWinResize = null;
  if (typeof ResizeObserver === 'function') {
    resizeObs = new ResizeObserver(() => {
      if (!currentIsHeatmap && syncViewWidth() && currentSlots.length > 0) {
        lastRenderSig = '';
        update(currentSlots);
      }
    });
    resizeObs.observe(plotStage);
  } else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    onWinResize = () => {
      if (!currentIsHeatmap && syncViewWidth() && currentSlots.length > 0) {
        lastRenderSig = '';
        update(currentSlots);
      }
    };
    window.addEventListener('resize', onWinResize);
  }

  function destroy() {
    cancelTipTrackRaf();
    resizeObs?.disconnect();
    resizeObs = null;
    if (onWinResize && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('resize', onWinResize);
      onWinResize = null;
    }
  }

  /**
   * 根据最新时间分桶序列重绘平滑曲线（<=90天/小时级）或类 GitHub 每日小格子热力图（>90天）。
   */
  function update(series = []) {
    const slots =
      Array.isArray(series) && series.length >= 1
        ? series
        : [
            { label: '00:00', fullLabel: '00:00 - 01:00', tokens: 0, calls: 0, costUsd: 0 },
            { label: '06:00', fullLabel: '06:00 - 07:00', tokens: 0, calls: 0, costUsd: 0 },
            { label: '12:00', fullLabel: '12:00 - 13:00', tokens: 0, calls: 0, costUsd: 0 },
            { label: '18:00', fullLabel: '18:00 - 19:00', tokens: 0, calls: 0, costUsd: 0 },
          ];
    currentSlots = slots;

    const isHourly =
      slots[0]?.granularity === 'hour' || String(slots[0]?.label || '').includes(':');
    const useHeatmap = !isHourly && slots.length > HEATMAP_DAYS_THRESHOLD;
    const modeChanged = useHeatmap !== currentIsHeatmap;
    currentIsHeatmap = useHeatmap;

    if (modeChanged) {
      clearHover();
    }
    patchClasses(chartWrap, { 'is-heatmap': useHeatmap });
    patchAttr(plotStage, 'hidden', useHeatmap);
    patchAttr(xAxisEl, 'hidden', useHeatmap);
    patchAttr(heatmapStage, 'hidden', !useHeatmap);

    if (!useHeatmap) {
      syncViewWidth();
    }

    let maxTokens = 0;
    let peakIdx = 0;
    let activeDays = 0;
    const nonZeroVals = [];

    for (let i = 0; i < slots.length; i++) {
      const tokVal = safeSlotTokens(slots[i]?.tokens);
      if (tokVal > 0) {
        activeDays++;
        nonZeroVals.push(tokVal);
      }
      if (tokVal >= maxTokens) {
        maxTokens = tokVal;
        peakIdx = i;
      }
    }

    const locale = getEffectiveLocale();
    patchText(wdayMonEl, t('chart.trend.wdayMon'));
    patchText(wdayWedEl, t('chart.trend.wdayWed'));
    patchText(wdayFriEl, t('chart.trend.wdayFri'));
    patchText(wdaySunEl, t('chart.trend.wdaySun'));
    patchAttr(hmGridEl, 'aria-label', t('chart.trend.hmAria'));
    patchText(hmLessEl, t('chart.trend.hmLess'));
    patchText(hmMoreEl, t('chart.trend.hmMore'));

    const sig =
      `${locale}|${useHeatmap ? 'hm' : `line:${viewW}`}|` +
      slots
        .map((s) => {
          const mSig = Array.isArray(s?.modelSegments)
            ? s.modelSegments.map((m) => `${m.key}:${m.color}:${m.pctText}`).join(',')
            : '';
          return `${s?.startMs || ''}:${s?.label || ''}:${s?.fullLabel || ''}:${safeSlotTokens(s?.tokens)}:${Number(s?.costUsd || 0)}:${Number(s?.calls || 0)}:${mSig}`;
        })
        .join('|');

    if (hoveredIdx >= 0 && hoveredIdx < slots.length && !tooltipEl.hasAttribute('hidden')) {
      populateTooltipContent(slots[hoveredIdx]);
    }

    if (useHeatmap) {
      currentPts = [];
      if (sig !== lastRenderSig) {
        lastRenderSig = sig;
        nonZeroVals.sort((a, b) => a - b);
        const thresholds = computeHeatmapThresholds(nonZeroVals, maxTokens);

        const firstStartMs = Number(slots[0]?.startMs);
        const firstDow =
          Number.isFinite(firstStartMs) && firstStartMs > 0
            ? (new Date(firstStartMs).getDay() + 6) % 7
            : 0;
        const totalCells = firstDow + slots.length;
        const totalWeeks = Math.max(1, Math.ceil(totalCells / 7));
        const gapPx = totalWeeks > 42 ? 1.5 : 2;
        currentHeatmapWeeks = totalWeeks;
        currentHeatmapFirstDow = firstDow;
        currentHeatmapGapPx = gapPx;

        patchStyleVar(hmBodyEl, '--hm-weeks', String(totalWeeks));
        patchStyleVar(hmBodyEl, '--hm-gap', `${gapPx}px`);

        // 重建顶部对齐月份标签
        while (hmMonthsEl.firstChild) hmMonthsEl.removeChild(hmMonthsEl.firstChild);
        const monthTicks = buildHeatmapMonthTicks(slots, firstDow, totalWeeks);
        for (const mt of monthTicks) {
          const mEl = h('span', { className: 'trend-hm-month text-mono', text: mt.text });
          patchStyleVar(mEl, '--hm-col', String(mt.col));
          hmMonthsEl.appendChild(mEl);
        }

        // 重建 7 行 × N 周列的每日小格子（一格一天），使用 DocumentFragment 一次性批量挂载减少重排
        while (hmGridEl.firstChild) hmGridEl.removeChild(hmGridEl.firstChild);
        hoveredCellEl = null;
        currentCellEls = new Array(slots.length);
        const gridFrag =
          typeof document !== 'undefined' && typeof document.createDocumentFragment === 'function'
            ? document.createDocumentFragment()
            : null;
        const gridTarget = gridFrag || hmGridEl;

        for (let pad = 0; pad < firstDow; pad++) {
          gridTarget.appendChild(
            h('span', { className: 'trend-hm-cell is-pad', 'aria-hidden': 'true' })
          );
        }

        for (let i = 0; i < slots.length; i++) {
          const slot = slots[i];
          const tok = safeSlotTokens(slot?.tokens);
          const lv = resolveHeatmapLevel(tok, thresholds);
          const gridPos = firstDow + i;
          const col = Math.floor(gridPos / 7);
          const row = gridPos % 7;
          const cellEl = h('span', {
            className: `trend-hm-cell lv-${lv}`,
            'data-slot-idx': String(i),
            'data-hm-col': String(col),
            'data-hm-row': String(row),
            role: 'gridcell',
          });
          gridTarget.appendChild(cellEl);
          currentCellEls[i] = cellEl;
        }
        if (gridFrag) {
          hmGridEl.appendChild(gridFrag);
        }

        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => {
            if (hmScrollEl.scrollWidth > hmScrollEl.clientWidth) {
              hmScrollEl.scrollLeft = hmScrollEl.scrollWidth;
            }
          });
        }
      }

      const peakSlot = slots[peakIdx];
      const summaryText =
        maxTokens > 0 && peakSlot?.label
          ? t('chart.trend.hmActivePeak', {
              active: activeDays,
              total: slots.length,
              label: peakSlot.label,
              tokens: formatTokensPrecise(maxTokens),
            })
          : t('chart.trend.hmActiveZero', { total: slots.length });
      patchText(hmSummaryEl, summaryText);

      if (hoveredIdx >= slots.length) {
        clearHover();
      } else if (hoveredIdx >= 0) {
        showHeatmapHoverAtIndex(hoveredIdx, currentCellEls[hoveredIdx]);
      }
      return;
    }

    // --- <= 90 天（或整点小时级）：渲染平滑面积曲线图（1:1 贴边对齐） ---
    currentCellEls = [];
    const { leftX, rightX, spanX } = resolvePlotBounds(viewW);
    const denom = Math.max(1, maxTokens);
    const isSingle = slots.length === 1;
    const pts = slots.map((s, idx) => {
      const tok = safeSlotTokens(s?.tokens);
      const x = isSingle
        ? (leftX + rightX) / 2
        : leftX + (idx / Math.max(1, slots.length - 1)) * spanX;
      const ratio = maxTokens > 0 ? tok / denom : 0;
      const y = BOTTOM_Y - ratio * SPAN_Y;
      return { x, y, tokens: tok };
    });
    currentPts = pts;

    if (sig !== lastRenderSig) {
      lastRenderSig = sig;
      let lineD;
      let areaD;
      if (isSingle) {
        const yStr = pts[0].y.toFixed(1);
        lineD = `M ${leftX.toFixed(1)} ${yStr} L ${rightX.toFixed(1)} ${yStr}`;
        areaD = `${lineD} L ${rightX.toFixed(1)} ${BOTTOM_Y} L ${leftX.toFixed(1)} ${BOTTOM_Y} Z`;
      } else {
        lineD = buildSmoothSplinePath(pts);
        areaD = `${lineD} L ${pts[pts.length - 1].x.toFixed(1)} ${BOTTOM_Y} L ${pts[0].x.toFixed(1)} ${BOTTOM_Y} Z`;
      }
      patchAttr(linePath, 'd', lineD);
      patchAttr(areaPath, 'd', areaD);

      // 渲染与底部刻度对齐的垂直参考网格线及底部 X 轴标签（起止标签严格左右贴边）
      const tickIndices = computeTickIndices(slots);
      while (vGridGroup.firstChild) vGridGroup.removeChild(vGridGroup.firstChild);
      while (xAxisEl.firstChild) xAxisEl.removeChild(xAxisEl.firstChild);
      tickElsByIdx = new Map();

      for (let i = 0; i < tickIndices.length; i++) {
        const tIdx = tickIndices[i];
        const pt = pts[tIdx];
        const slot = slots[tIdx];
        if (!pt || !slot) continue;

        if (i > 0 && i < tickIndices.length - 1) {
          const vLine = document.createElementNS(SVG_NS, 'line');
          vLine.setAttribute('x1', pt.x.toFixed(1));
          vLine.setAttribute('y1', '16');
          vLine.setAttribute('x2', pt.x.toFixed(1));
          vLine.setAttribute('y2', String(BOTTOM_Y));
          vGridGroup.appendChild(vLine);
        }

        const isFirst = !isSingle && i === 0;
        const isLast = !isSingle && i === tickIndices.length - 1;
        const pct = isFirst ? 0 : isLast ? 100 : (pt.x / viewW) * 100;
        const tickEl = h('span', {
          className: `trend-x-tick text-mono${isFirst ? ' is-start' : isLast ? ' is-end' : ''}`,
          text: slot.label || '',
          title: slot.fullLabel || slot.label || '',
        });
        patchStyleVar(tickEl, '--tick-x', `${pct.toFixed(2)}%`);
        tickEl.onclick = () => showLineHoverAtIndex(tIdx);
        xAxisEl.appendChild(tickEl);
        tickElsByIdx.set(tIdx, tickEl);
      }

      // 渲染采样点小圆点（当点数 <= 36 时展示，突出有消耗的整点/日期）
      while (dotsGroup.firstChild) dotsGroup.removeChild(dotsGroup.firstChild);
      if (pts.length <= 36) {
        for (let i = 0; i < pts.length; i++) {
          if (pts[i].tokens <= 0) continue;
          const dot = document.createElementNS(SVG_NS, 'circle');
          dot.setAttribute('cx', pts[i].x.toFixed(1));
          dot.setAttribute('cy', pts[i].y.toFixed(1));
          dot.setAttribute('r', '2');
          dot.setAttribute('class', 'trend-node-dot');
          dotsGroup.appendChild(dot);
        }
      }
    }

    const peakPt = pts[peakIdx] || { x: viewW / 2, y: BOTTOM_Y };
    patchAttr(peakDot, 'cx', peakPt.x.toFixed(1));
    patchAttr(peakDot, 'cy', peakPt.y.toFixed(1));

    const peakSlot = slots[peakIdx];
    const peakText =
      maxTokens > 0 && peakSlot?.label
        ? t('chart.trend.peakPill', {
            label: peakSlot.label,
            tokens: formatTokensPrecise(maxTokens),
          })
        : formatTokensPrecise(maxTokens);
    patchText(peakPill, peakText);
    const pctLeft = Math.max(12, Math.min(88, (peakPt.x / viewW) * 100));
    patchStyleVar(peakPill, '--peak-x', `${pctLeft.toFixed(1)}%`);

    if (hoveredIdx >= slots.length) {
      clearHover();
    } else if (hoveredIdx >= 0) {
      showLineHoverAtIndex(hoveredIdx);
    }
  }

  return { el: chartWrap, update, destroy };
}
return { HEATMAP_DAYS_THRESHOLD, createTrendAreaChart };
})();

// --- src/components/charts/SessionStepCharts.js ---
const { MODEL_COLOR_VARS, getStepModelGroupKey, toChronologicalSteps, computeLinearFit, computePublicationFit, createSessionLineChart, createModelFitChart } = (() => {
/**
 * @fileoverview 当前会话步骤级线性走势图与模型趋势拟合图组件 (SessionStepCharts).
 *
 * 包含两部分能力：
 * 1. `createSessionLineChart`：查看当前会话（支持主代理 / 子代理 / 全部汇总）所有模型的步进变化，
 *    支持切换 `总Token`（累计调用总量）、`上下文`（单步上下文体积）、`TPS`、`首字`、`费用` 五大维度；
 * 2. `createModelFitChart`：查看指定模型或全部模型的 `TPS`、`首字`、`缓存`、`费用` 散点与鲁棒局部加权线性回归（LOWESS + OLS 基准）拟合曲线，
 *    内置视图级模型锁定状态机，进入视图时自动锚定当前调用模型，停留在视图期间绝不随轮询跳变。
 */


let sessionChartUid = 0;

/** 多模型节点与多曲线对比语义调色板（全部取自 tokens.css 语义变量，兼顾设计一致性与交叉曲线区分度） */
const MODEL_COLOR_VARS = Object.freeze([
  'var(--ctx-cached)',
  'var(--ctx-skills)',
  'var(--ctx-user-input)',
  'var(--ctx-checkpoint)',
  'var(--ctx-tool-results)',
  'var(--ctx-subagent-msg)',
]);

/**
 * 提取步骤所属的基础模型分组键（与后端 `usage-aggregator.mjs` 中 `modelBreakdown[].label` 严格一致），
 * 且不受“精简代号 / 原始模型 ID”或“自动压缩”后缀切换影响。
 *
 * @param {object|null|undefined} step
 * @returns {string}
 */
function getStepModelGroupKey(step) {
  if (!step || typeof step !== 'object') return t('fmt.unknownModel');
  const rawLabel = String(step.baseModelLabel || step.modelLabel || step.label || '')
    .replace(/\s*\[自动压缩\]\s*$/u, '')
    .replace(/\s*\((?:Max|XHigh|High|Medium|Low|Thinking|Extra Low|Tiered)\)\s*$/i, '')
    .trim();
  if (rawLabel) return rawLabel;
  const rawShort = String(step.baseModelShort || step.modelShort || step.shortName || '')
    .replace(/·(?:压缩|Compact)\s*$/iu, '')
    .trim();
  return rawShort || t('fmt.unknownModel');
}

/**
 * 将逆序或混合代理的步骤列表归一化为严格时间升序序列（最旧 -> 最新）。
 *
 * @param {Array<object>} steps
 * @param {boolean} isMergedAllAgents
 * @returns {Array<object>}
 */
function toChronologicalSteps(steps, isMergedAllAgents = false) {
  if (!Array.isArray(steps) || steps.length === 0) return [];
  const copy = steps.slice();
  if (isMergedAllAgents) {
    copy.sort(
      (a, b) =>
        (Number(a?.createdAtMs) || 0) - (Number(b?.createdAtMs) || 0) ||
        (Number(a?.agentIndex) || 0) - (Number(b?.agentIndex) || 0) ||
        (Number(a?.stepIndex) || 0) - (Number(b?.stepIndex) || 0)
    );
    return copy;
  }
  copy.sort(
    (a, b) =>
      (Number(a?.stepIndex) || 0) - (Number(b?.stepIndex) || 0) ||
      (Number(a?.createdAtMs) || 0) - (Number(b?.createdAtMs) || 0)
  );
  return copy;
}

function clampValue(v, minVal = 0, maxVal = Infinity) {
  if (!Number.isFinite(v)) return minVal;
  return Math.max(minVal, Math.min(maxVal, v));
}

/**
 * 双侧 95% 置信区间对应的 Student-t 临界值近似表（t_{0.975, df}）。
 *
 * @param {number} df 残差自由度
 * @returns {number}
 */
function tCritical95(df) {
  if (!Number.isFinite(df) || df <= 1.5) return 3.182;
  if (df <= 2.5) return 3.182 + (2.5 - df) * 0.9;
  if (df <= 3.5) return 2.776 + (3.5 - df) * 0.406;
  if (df <= 4.5) return 2.571 + (4.5 - df) * 0.205;
  if (df <= 6) return 2.447;
  if (df <= 8) return 2.306;
  if (df <= 10) return 2.228;
  if (df <= 15) return 2.131;
  if (df <= 20) return 2.086;
  if (df <= 30) return 2.042;
  if (df <= 60) return 2.0;
  if (df <= 120) return 1.98;
  return 1.96;
}

/**
 * 计算普通最小二乘线性回归（OLS: y = intercept + slope * x）。
 *
 * @param {number[]} ys 样本纵坐标序列
 * @param {{ minVal?: number, maxVal?: number, xs?: number[] }} [options]
 * @returns {{ values: number[], slope: number, intercept: number, mean: number, r: number, r2: number }}
 */
function computeLinearFit(ys, { minVal = 0, maxVal = Infinity, xs = null } = {}) {
  const n = Array.isArray(ys) ? ys.length : 0;
  if (n === 0) {
    return { values: [], slope: 0, intercept: 0, mean: 0, r: 0, r2: 0 };
  }
  const xArr =
    Array.isArray(xs) && xs.length === n ? xs : Array.from({ length: n }, (_, idx) => idx);
  const meanY = ys.reduce((acc, v) => acc + v, 0) / n;
  if (n === 1) {
    const c = clampValue(ys[0], minVal, maxVal);
    return { values: [c], slope: 0, intercept: c, mean: c, r: 0, r2: 0 };
  }
  const meanX = xArr.reduce((acc, v) => acc + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xArr[i] - meanX;
    const dy = ys[i] - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const slope = sxx > 1e-12 ? sxy / sxx : 0;
  const intercept = meanY - slope * meanX;
  const r =
    sxx > 1e-12 && syy > 1e-12 ? clampValue(sxy / Math.sqrt(sxx * syy), -1, 1) : 0;
  const values = xArr.map((x) => clampValue(intercept + slope * x, minVal, maxVal));
  return { values, slope, intercept, mean: meanY, r, r2: r * r };
}

/**
 * 学术论文级回归与 95% 置信带计算引擎（Cleveland & Devlin 高斯局部加权线性回归 LOESS + 精确帽子矩阵标准误，
 * 小样本 n <= 5 时自动采用精确 OLS 线性回归与双曲 t 分布 95% 置信区间，等同于 R `ggplot2::geom_smooth(se = TRUE)`）。
 *
 * @param {number[]} xs 严格递增或单调的样本横坐标序列
 * @param {number[]} ys 样本纵坐标序列
 * @param {{ minVal?: number, maxVal?: number, gridSize?: number, span?: number }} [options]
 */
function computePublicationFit(
  xs,
  ys,
  { minVal = 0, maxVal = Infinity, gridSize = 64, span = 0.5 } = {}
) {
  const n = Math.min(Array.isArray(xs) ? xs.length : 0, Array.isArray(ys) ? ys.length : 0);
  if (n === 0) {
    return {
      method: 'OLS',
      mean: 0,
      sd: 0,
      slope: 0,
      intercept: 0,
      r: 0,
      r2: 0,
      sampleFits: [],
      sampleCiLow: [],
      sampleCiHigh: [],
      sampleCiHalf: [],
      grid: [],
    };
  }

  const ols = computeLinearFit(ys, { minVal, maxVal, xs });
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dy = ys[i] - ols.mean;
    syy += dy * dy;
  }
  const sd = n > 1 ? Math.sqrt(syy / (n - 1)) : 0;

  if (n === 1) {
    const val = clampValue(ys[0], minVal, maxVal);
    return {
      method: 'OLS',
      mean: val,
      sd: 0,
      slope: 0,
      intercept: val,
      r: 0,
      r2: 0,
      sampleFits: [val],
      sampleCiLow: [val],
      sampleCiHigh: [val],
      sampleCiHalf: [0],
      grid: [{ x: xs[0], fit: val, ciLow: val, ciHigh: val }],
    };
  }

  const xMin = xs[0];
  const xMax = xs[n - 1];
  const xSpan = Math.max(1e-9, xMax - xMin);
  const M = Math.max(2, gridSize);
  const gridXs = Array.from({ length: M }, (_, k) => xMin + (k / (M - 1)) * xSpan);

  // 小样本（n <= 5）：采用精确 OLS 线性回归与 Student-t 双曲 95% CI 置信带
  if (n <= 5) {
    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    let sxx = 0;
    let sse = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - meanX;
      sxx += dx * dx;
      const resid = ys[i] - (ols.intercept + ols.slope * xs[i]);
      sse += resid * resid;
    }
    const df = n - 2;
    const seResid = df >= 1 ? Math.sqrt(sse / df) : 0;
    const tCrit = df >= 1 ? tCritical95(df) : 0;

    const evalOlsAt = (x0) => {
      const rawFit = ols.intercept + ols.slope * x0;
      const sePred =
        seResid > 0
          ? seResid * Math.sqrt(1 / n + (sxx > 1e-12 ? ((x0 - meanX) * (x0 - meanX)) / sxx : 0))
          : 0;
      const half = tCrit * sePred;
      return {
        fit: clampValue(rawFit, minVal, maxVal),
        ciLow: clampValue(rawFit - half, minVal, maxVal),
        ciHigh: clampValue(rawFit + half, minVal, maxVal),
        half,
      };
    };

    const sampleEval = xs.map(evalOlsAt);
    const grid = gridXs.map((gx) => {
      const g = evalOlsAt(gx);
      return { x: gx, fit: g.fit, ciLow: g.ciLow, ciHigh: g.ciHigh };
    });

    return {
      method: 'OLS',
      mean: ols.mean,
      sd,
      slope: ols.slope,
      intercept: ols.intercept,
      r: ols.r,
      r2: ols.r2,
      sampleFits: sampleEval.map((e) => e.fit),
      sampleCiLow: sampleEval.map((e) => e.ciLow),
      sampleCiHigh: sampleEval.map((e) => e.ciHigh),
      sampleCiHalf: sampleEval.map((e) => e.half),
      grid,
    };
  }

  // n >= 6：Cleveland 高斯局部加权一阶线性回归（LOESS）+ 精确帽子矩阵杠杆度 95% CI 置信带
  const q = Math.max(5, Math.min(n, Math.ceil(span * n)));
  const wBuf = new Float64Array(n);
  const sortedXs = q <= n && xs.slice(0, n).every(
    (x, i) => Number.isFinite(x) && (i === 0 || xs[i - 1] <= x)
  );

  function loessBandwidth(x0) {
    // 有序 x 上的 q 个最近样本可取连续区间；二分比较两端，避免每个拟合点都排序。
    let left = 0;
    let right = n - q;
    while (left < right) {
      const mid = (left + right) >>> 1;
      if (x0 - xs[mid] > xs[mid + q] - x0) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }
    return Math.max(Math.abs(xs[left] - x0), Math.abs(xs[left + q - 1] - x0));
  }

  function evalLoessPoint(x0, diagIdx = -1) {
    let h;
    if (sortedXs) {
      h = loessBandwidth(x0);
      if (h <= 1e-9) {
        h = Math.max(Math.abs(xs[0] - x0), Math.abs(xs[n - 1] - x0), xSpan * 0.05, 1e-6);
      }
    } else {
      const sortedDists = Array.from({ length: n }, (_, j) => Math.abs(xs[j] - x0)).sort((a, b) => a - b);
      h = sortedDists[q - 1];
      if (h <= 1e-9) {
        h = Math.max(sortedDists[n - 1], xSpan * 0.05, 1e-6);
      }
    }
    const maxDist = h * 1.0001;
    let start = 0;
    let end = n;
    if (sortedXs) {
      // 三次权重的支持区间之外权重为零，保留区间内样本原来的累加顺序。
      let right = n;
      while (start < right) {
        const mid = (start + right) >>> 1;
        if (x0 - xs[mid] >= maxDist) start = mid + 1;
        else right = mid;
      }
      let left = start;
      while (left < end) {
        const mid = (left + end) >>> 1;
        if (xs[mid] - x0 < maxDist) left = mid + 1;
        else end = mid;
      }
    }

    let sw = 0;
    let swx = 0;
    for (let j = start; j < end; j++) {
      const u = Math.abs(xs[j] - x0) / maxDist;
      const base = 1 - u * u * u;
      const w = u >= 1 ? 0 : base * base * base;
      wBuf[j] = w;
      sw += w;
      swx += w * xs[j];
    }

    if (sw <= 1e-12) {
      const fallbackVal = ols.intercept + ols.slope * x0;
      return { rawFit: fallbackVal, leverageNormSq: 1 / n, diagHat: 1 / n, localHatDiag: 1 / n };
    }

    const mx = swx / sw;
    let sxxW = 0;
    for (let j = start; j < end; j++) {
      const w = wBuf[j];
      if (w <= 0) continue;
      const dx = xs[j] - mx;
      sxxW += w * dx * dx;
    }

    const dx0 = x0 - mx;
    const useSlope = sxxW > 1e-12;
    const inverseWeightSum = 1 / sw;
    const slopeScale = useSlope ? dx0 / sxxW : 0;
    const localHatDiag = inverseWeightSum + (useSlope ? (dx0 * dx0) / sxxW : 0);
    let rawFit = 0;
    let leverageNormSq = 0;
    let diagHat = 0;

    for (let j = start; j < end; j++) {
      const w = wBuf[j];
      if (w <= 0) continue;
      const lj = w * inverseWeightSum + (useSlope ? w * (xs[j] - mx) * slopeScale : 0);
      rawFit += lj * ys[j];
      leverageNormSq += lj * lj;
      if (j === diagIdx) diagHat = lj;
    }

    return { rawFit, leverageNormSq, diagHat, localHatDiag };
  }

  const rawSampleFits = new Float64Array(n);
  const sampleLevSq = new Float64Array(n);
  let sse = 0;
  let traceL = 0;
  let precomputedGridEval = null;

  // 大样本（n > 200 且 x 单调有序）采用与 R `stats::loess(surface = "interpolate")` 一致的网格插值加速：
  // 仅在 M 个均匀网格顶点做精确 LOESS（O(M·N)），再线性插值样本拟合值与杠杆度，避免 O(N²) 阻塞主线程。
  if (n > 200 && sortedXs && M >= 2) {
    const gridRawFit = new Float64Array(M);
    const gridLevSq = new Float64Array(M);
    const gridHatDiag = new Float64Array(M);
    for (let k = 0; k < M; k++) {
      const res = evalLoessPoint(gridXs[k], -1);
      gridRawFit[k] = res.rawFit;
      gridLevSq[k] = res.leverageNormSq;
      gridHatDiag[k] = res.localHatDiag;
    }
    precomputedGridEval = { gridRawFit, gridLevSq };

    const invSpan = (M - 1) / xSpan;
    const maxK0 = M - 2;
    for (let i = 0; i < n; i++) {
      const u = (xs[i] - xMin) * invSpan;
      const k0 = u <= 0 ? 0 : u >= maxK0 ? maxK0 : Math.floor(u);
      const frac = Math.max(0, Math.min(1, u - k0));
      const rf = gridRawFit[k0] + frac * (gridRawFit[k0 + 1] - gridRawFit[k0]);
      const ls = Math.max(0, gridLevSq[k0] + frac * (gridLevSq[k0 + 1] - gridLevSq[k0]));
      const hd = gridHatDiag[k0] + frac * (gridHatDiag[k0 + 1] - gridHatDiag[k0]);
      rawSampleFits[i] = rf;
      sampleLevSq[i] = ls;
      traceL += hd;
      const diff = ys[i] - rf;
      sse += diff * diff;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const res = evalLoessPoint(xs[i], i);
      rawSampleFits[i] = res.rawFit;
      sampleLevSq[i] = res.leverageNormSq;
      traceL += res.diagHat;
      const diff = ys[i] - res.rawFit;
      sse += diff * diff;
    }
  }

  const dfRes = Math.max(1, n - traceL);
  const sigmaHat = Math.sqrt(sse / dfRes);
  const tCrit = tCritical95(dfRes);

  const sampleFits = new Array(n);
  const sampleCiLow = new Array(n);
  const sampleCiHigh = new Array(n);
  const sampleCiHalf = new Array(n);
  let clampedSse = 0;

  for (let i = 0; i < n; i++) {
    const fitVal = clampValue(rawSampleFits[i], minVal, maxVal);
    const half = tCrit * sigmaHat * Math.sqrt(sampleLevSq[i]);
    sampleFits[i] = fitVal;
    sampleCiLow[i] = clampValue(rawSampleFits[i] - half, minVal, maxVal);
    sampleCiHigh[i] = clampValue(rawSampleFits[i] + half, minVal, maxVal);
    sampleCiHalf[i] = half;
    const d = ys[i] - fitVal;
    clampedSse += d * d;
  }

  const grid = precomputedGridEval
    ? gridXs.map((gx, k) => {
        const rf = precomputedGridEval.gridRawFit[k];
        const half = tCrit * sigmaHat * Math.sqrt(Math.max(0, precomputedGridEval.gridLevSq[k]));
        return {
          x: gx,
          fit: clampValue(rf, minVal, maxVal),
          ciLow: clampValue(rf - half, minVal, maxVal),
          ciHigh: clampValue(rf + half, minVal, maxVal),
        };
      })
    : gridXs.map((gx) => {
        const res = evalLoessPoint(gx, -1);
        const half = tCrit * sigmaHat * Math.sqrt(res.leverageNormSq);
        return {
          x: gx,
          fit: clampValue(res.rawFit, minVal, maxVal),
          ciLow: clampValue(res.rawFit - half, minVal, maxVal),
          ciHigh: clampValue(res.rawFit + half, minVal, maxVal),
        };
      });

  const r2Loess = syy > 1e-12 ? clampValue(1 - clampedSse / syy, 0, 1) : 1;

  return {
    method: 'LOESS',
    mean: ols.mean,
    sd,
    slope: ols.slope,
    intercept: ols.intercept,
    r: ols.r,
    r2: r2Loess,
    sampleFits,
    sampleCiLow,
    sampleCiHigh,
    sampleCiHalf,
    grid,
  };
}

/**
 * Heckbert 科学坐标轴刻度取整算法，生成科研图表风格的均匀整洁刻度。
 */
function niceStepNumber(range, round) {
  if (!Number.isFinite(range) || range <= 0) return 1;
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / 10 ** exponent;
  let niceFraction;
  if (round) {
    if (fraction < 1.5) niceFraction = 1;
    else if (fraction < 3) niceFraction = 2;
    else if (fraction < 7) niceFraction = 5;
    else niceFraction = 10;
  } else if (fraction <= 1) niceFraction = 1;
  else if (fraction <= 2) niceFraction = 2;
  else if (fraction <= 5) niceFraction = 5;
  else niceFraction = 10;
  return niceFraction * 10 ** exponent;
}

function computeNiceYScale(dataMin, dataMax, { minBound = 0, maxBound = Infinity, tickCount = 4 } = {}) {
  let lo = Number.isFinite(dataMin) ? dataMin : 0;
  let hi = Number.isFinite(dataMax) ? dataMax : 1;
  if (minBound === 0 && lo >= 0 && hi > 0 && lo <= hi * 0.32) {
    lo = 0;
  }
  if (hi - lo <= 1e-9) {
    const pad = lo > 0 ? lo * 0.15 : 1;
    lo = Math.max(minBound, lo - pad);
    hi = Math.min(maxBound, hi + pad);
    if (hi - lo <= 1e-9) {
      lo = Math.max(minBound, hi - 1);
    }
  } else {
    const pad = (hi - lo) * 0.05;
    lo = Math.max(minBound, lo - (lo === 0 ? 0 : pad));
    hi = Math.min(maxBound, hi + pad);
  }

  const rawRange = niceStepNumber(hi - lo, false);
  const step = niceStepNumber(rawRange / Math.max(2, tickCount - 1), true);
  let graphMin = Math.max(minBound, Math.floor(lo / step) * step);
  let graphMax = Math.min(maxBound, Math.ceil(hi / step) * step);
  if (graphMax - graphMin <= 1e-9) {
    graphMax = graphMin + step;
  }

  const ticks = [];
  for (let v = graphMin; v <= graphMax + step * 0.25; v += step) {
    const clamped = clampValue(+v.toPrecision(10), minBound, maxBound);
    if (ticks.length === 0 || Math.abs(clamped - ticks[ticks.length - 1]) > step * 1e-4) {
      ticks.push(clamped);
    }
    if (ticks.length >= 8) break;
  }
  return {
    min: ticks[0] ?? graphMin,
    max: ticks[ticks.length - 1] ?? graphMax,
    step,
    ticks,
  };
}

function computeNiceXStepTicks(xs) {
  const n = xs.length;
  if (n === 0) return [];
  if (n <= 5) {
    return Array.from(new Set(xs.map((x) => Math.round(x))));
  }
  const xMin = xs[0];
  const xMax = xs[n - 1];
  const span = xMax - xMin;
  if (span <= 5) {
    return Array.from(new Set(xs.map((x) => Math.round(x))));
  }
  const step = Math.max(1, Math.round(niceStepNumber(span / 4.5, true)));
  const firstTick = Math.ceil(xMin / step) * step;
  const ticks = [];
  if (firstTick - xMin > step * 0.45) {
    ticks.push(Math.round(xMin));
  }
  for (let v = firstTick; v <= xMax + 1e-6; v += step) {
    ticks.push(Math.round(v));
    if (ticks.length >= 7) break;
  }
  if (ticks.length === 0) {
    return [Math.round(xMin), Math.round(xMax)];
  }
  return ticks;
}

function formatYAxisTick(metric, val, step) {
  if (!Number.isFinite(val)) return '';
  if (Math.abs(val) < 1e-9) {
    return metric === 'cost' ? '$0' : metric === 'cache' ? '0%' : metric === 'ttft' ? '0s' : '0';
  }
  if (metric === 'tps') {
    return step >= 1 ? `${Math.round(val)}` : val.toFixed(1);
  }
  if (metric === 'ttft') {
    return step >= 1 ? `${Math.round(val)}s` : `${val.toFixed(1)}s`;
  }
  if (metric === 'cache') {
    return step >= 1 ? `${Math.round(val)}%` : `${val.toFixed(1)}%`;
  }
  if (metric === 'cost') {
    if (step >= 1) return `$${Math.round(val)}`;
    if (step >= 0.1) return `$${val.toFixed(1)}`;
    if (step >= 0.01) return `$${val.toFixed(2)}`;
    return `$${val.toFixed(3)}`;
  }
  return String(val);
}

function buildPolylinePath(points) {
  if (!points.length) return '';
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${points[i].x.toFixed(1)} ${points[i].y.toFixed(1)}`;
  }
  return d;
}

function buildSplinePath(points) {
  if (!points.length) return '';
  if (points.length === 1) {
    return `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  }
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const cpx1 = p0.x + (p1.x - p0.x) * 0.38;
    const cpx2 = p1.x - (p1.x - p0.x) * 0.38;
    d += ` C ${cpx1.toFixed(1)} ${p0.y.toFixed(1)}, ${cpx2.toFixed(1)} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }
  return d;
}

function computeStepTickIndices(count) {
  if (count <= 0) return [];
  if (count <= 6) return Array.from({ length: count }, (_, i) => i);
  const maxTicks = 6;
  const set = new Set();
  for (let k = 0; k < maxTicks; k++) {
    set.add(Math.round((k / (maxTicks - 1)) * (count - 1)));
  }
  return Array.from(set).sort((a, b) => a - b);
}

function formatStepAxisTag(st, showAgentPrefix) {
  const num = `#${Number(st?.stepIndex ?? 0)}`;
  if (!showAgentPrefix) return num;
  const badge = formatAgentBadgeText({
    agentKind:
      st?.agentKind || (!st?.isSubagent ? 'main' : st?.isSideQuestion ? 'side_question' : 'subagent'),
    agentOrdinal:
      st?.agentOrdinal || (st?.isSideQuestion ? st?.sideIndex || 0 : st?.agentIndex || 0),
    isMain: !st?.isSubagent,
    isSideQuestion: Boolean(st?.isSideQuestion),
    sideIndex: st?.sideIndex || 0,
    index: st?.agentIndex || 0,
    badgeText: st?.agentBadge,
  });
  return `${badge}${num}`;
}

function formatChartMetricValue(metric, val) {
  if (!Number.isFinite(val)) return '—';
  switch (metric) {
    case 'totalTokens':
    case 'context':
      return `${formatTokensPrecise(val)} tok`;
    case 'tps':
      return formatSpeedMetric(val, ' tok/s');
    case 'ttft':
      return formatMetric(val, 's');
    case 'cache':
      return `${val.toFixed(1)}%`;
    case 'cost':
      return formatUsd(val, { precise: true });
    default:
      return String(val);
  }
}

function formatChartMetricCompact(metric, val) {
  if (!Number.isFinite(val)) return '—';
  switch (metric) {
    case 'totalTokens':
    case 'context':
      return formatTokens(val);
    case 'tps':
      return formatSpeedMetric(val, ' tok/s');
    case 'ttft':
      return formatMetric(val, 's');
    case 'cache':
      return `${val.toFixed(1)}%`;
    case 'cost':
      return formatUsd(val, { precise: true });
    default:
      return String(val);
  }
}

/**
 * 创建会话全模型线性走势图（支持 `totalTokens` | `context` | `tps` | `ttft` | `cost`，全宽 1:1 贴边对齐）。
 */
function createSessionLineChart() {
  const DEFAULT_VIEW_W = 460;
  const VIEW_H = 106;
  const TOP_Y = 18;
  const BOTTOM_Y = 94;
  const SPAN_Y = BOTTOM_Y - TOP_Y;

  let viewW = DEFAULT_VIEW_W;

  function resolvePlotBounds(w) {
    const leftX = 1;
    const rightX = Math.max(leftX + 20, w - 1);
    return { leftX, rightX, spanX: rightX - leftX };
  }

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${viewW} ${VIEW_H}`);
  svg.setAttribute('class', 'sstep-svg');
  svg.setAttribute('aria-hidden', 'true');

  const gradId = `sstep-line-grad-${++sessionChartUid}`;
  const defs = document.createElementNS(SVG_NS, 'defs');
  const grad = document.createElementNS(SVG_NS, 'linearGradient');
  grad.setAttribute('id', gradId);
  grad.setAttribute('x1', '0');
  grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '0');
  grad.setAttribute('y2', '1');
  const stop1 = document.createElementNS(SVG_NS, 'stop');
  stop1.setAttribute('offset', '0%');
  stop1.setAttribute('stop-color', 'var(--ctx-cached)');
  stop1.setAttribute('stop-opacity', '0.28');
  const stop2 = document.createElementNS(SVG_NS, 'stop');
  stop2.setAttribute('offset', '100%');
  stop2.setAttribute('stop-color', 'var(--ctx-cached)');
  stop2.setAttribute('stop-opacity', '0.0');
  grad.appendChild(stop1);
  grad.appendChild(stop2);
  defs.appendChild(grad);
  svg.appendChild(defs);

  const gridGroup = document.createElementNS(SVG_NS, 'g');
  gridGroup.setAttribute('class', 'trend-grid');
  const gridLines = [];
  for (const y of [TOP_Y, Math.round((TOP_Y + BOTTOM_Y) / 2), BOTTOM_Y]) {
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', '0');
    line.setAttribute('y1', String(y));
    line.setAttribute('x2', String(viewW));
    line.setAttribute('y2', String(y));
    gridGroup.appendChild(line);
    gridLines.push(line);
  }
  svg.appendChild(gridGroup);

  const areaPath = document.createElementNS(SVG_NS, 'path');
  areaPath.setAttribute('fill', `url(#${gradId})`);
  svg.appendChild(areaPath);

  const multiAreaGroup = document.createElementNS(SVG_NS, 'g');
  multiAreaGroup.setAttribute('class', 'sstep-multi-area-group');
  svg.appendChild(multiAreaGroup);

  const linePath = document.createElementNS(SVG_NS, 'path');
  linePath.setAttribute('class', 'trend-line');
  linePath.setAttribute('fill', 'none');
  svg.appendChild(linePath);

  const multiLineGroup = document.createElementNS(SVG_NS, 'g');
  multiLineGroup.setAttribute('class', 'sstep-multi-line-group');
  svg.appendChild(multiLineGroup);

  const dotsGroup = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(dotsGroup);

  const anomalyDotsGroup = document.createElementNS(SVG_NS, 'g');
  anomalyDotsGroup.setAttribute('class', 'sstep-anomaly-dots');
  svg.appendChild(anomalyDotsGroup);

  const hoverLine = document.createElementNS(SVG_NS, 'line');
  hoverLine.setAttribute('class', 'trend-hover-line');
  hoverLine.setAttribute('y1', '10');
  hoverLine.setAttribute('y2', String(BOTTOM_Y));
  hoverLine.setAttribute('hidden', 'true');
  svg.appendChild(hoverLine);

  const hoverDot = document.createElementNS(SVG_NS, 'circle');
  hoverDot.setAttribute('r', '3.4');
  hoverDot.setAttribute('class', 'trend-hover-dot');
  hoverDot.setAttribute('hidden', 'true');
  svg.appendChild(hoverDot);

  const emptyHintEl = h('div', {
    className: 'sstep-empty-hint text-muted',
    text: t('chart.step.empty'),
    hidden: true,
  });

  const peakPill = h('span', { className: 'trend-peak-pill text-mono', hidden: true });

  const tipHeadLeft = h('span', { className: 'trend-tip-time text-mono' });
  const tipHeadRight = h('span', { className: 'trend-tip-calls text-mono' });
  const tipMainLeft = h('strong', { className: 'trend-tip-tokens text-mono' });
  const tipMainRight = h('span', { className: 'trend-tip-cost text-mono' });
  const tipSub = h('div', { className: 'trend-tip-sub text-mono', hidden: true });
  const tipAnomaly = h('div', { className: 'trend-tip-anomaly text-mono', hidden: true });
  const tooltipEl = h('div', { className: 'trend-tooltip', hidden: true }, [
    h('div', { className: 'trend-tip-head' }, [tipHeadLeft, tipHeadRight]),
    h('div', { className: 'trend-tip-main' }, [tipMainLeft, tipMainRight]),
    tipSub,
    tipAnomaly,
  ]);

  const xAxisEl = h('div', { className: 'trend-x-axis' });
  const modelLegendEl = h('div', { className: 'sstep-model-legend', hidden: true });
  const plotStage = h('div', { className: 'sstep-plot-stage' }, [
    peakPill,
    emptyHintEl,
    tooltipEl,
    svg,
  ]);
  const rootEl = h('div', { className: 'sstep-chart-wrap' }, [
    plotStage,
    xAxisEl,
    modelLegendEl,
  ]);

  let currentPoints = [];
  let currentMetric = 'totalTokens';
  let hoveredIdx = -1;
  let tickElsByIdx = new Map();
  let lastSig = '';
  let lastUpdateParams = null;

  function syncViewWidth() {
    const measured = Math.round(
      plotStage.clientWidth ||
        svg.clientWidth ||
        plotStage.getBoundingClientRect?.()?.width ||
        0
    );
    if (measured >= 160 && measured !== viewW) {
      viewW = measured;
      svg.setAttribute('viewBox', `0 0 ${viewW} ${VIEW_H}`);
      for (const line of gridLines) {
        line.setAttribute('x1', '0');
        line.setAttribute('x2', String(viewW));
      }
      return true;
    }
    return false;
  }

  function showHoverAt(idx) {
    if (idx < 0 || idx >= currentPoints.length) {
      clearHover();
      return;
    }
    const wasHidden = tooltipEl.hasAttribute('hidden');
    hoveredIdx = idx;
    const pt = currentPoints[idx];
    patchAttr(hoverLine, 'hidden', false);
    patchAttr(hoverLine, 'x1', pt.x.toFixed(1));
    patchAttr(hoverLine, 'x2', pt.x.toFixed(1));

    patchAttr(hoverDot, 'hidden', false);
    patchAttr(hoverDot, 'cx', pt.x.toFixed(1));
    patchAttr(hoverDot, 'cy', pt.y.toFixed(1));
    const hoverAccent = pt.anomalySummary
      ? pt.anomalySeverity === 'danger'
        ? 'var(--metric-danger)'
        : 'var(--metric-warn)'
      : pt.hoverColor || 'var(--ctx-cached)';
    patchStyleVar(hoverDot, '--hover-dot-color', hoverAccent);

    patchAttr(peakPill, 'hidden', true);
    patchAttr(tooltipEl, 'hidden', false);

    patchText(tipHeadLeft, pt.stepTag);
    patchText(tipHeadRight, pt.modelText);
    patchText(
      tipMainLeft,
      pt.valid ? formatChartMetricValue(currentMetric, pt.value) : t('chart.step.excluded')
    );
    patchText(tipMainRight, pt.secondaryRight || '');
    patchAttr(tipSub, 'hidden', !pt.subDetail);
    if (pt.subDetail) {
      patchText(tipSub, pt.subDetail);
    }
    patchAttr(tipAnomaly, 'hidden', !pt.anomalySummary);
    if (pt.anomalySummary) {
      patchText(tipAnomaly, pt.anomalySummary);
      patchClasses(tipAnomaly, { 'is-danger': pt.anomalySeverity === 'danger' });
    }

    const rawPct = (pt.x / viewW) * 100;
    const clampedPct = Math.max(1, Math.min(99, rawPct));
    patchStyleVar(tooltipEl, '--tip-x', `${clampedPct.toFixed(1)}%`);
    patchStyleVar(tooltipEl, '--tip-shift', `-${clampedPct.toFixed(1)}%`);
    patchStyleVar(tooltipEl, '--tip-y', '0px');
    if (wasHidden) {
      patchClasses(tooltipEl, { 'is-tracking': false });
      void tooltipEl.offsetWidth;
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => {
          if (!tooltipEl.hasAttribute('hidden')) {
            patchClasses(tooltipEl, { 'is-tracking': true });
          }
        });
      } else {
        patchClasses(tooltipEl, { 'is-tracking': true });
      }
    }

    for (const [tIdx, el] of tickElsByIdx.entries()) {
      patchClasses(el, { 'is-hovered': tIdx === idx });
    }
  }

  function clearHover() {
    hoveredIdx = -1;
    patchAttr(hoverLine, 'hidden', true);
    patchAttr(hoverDot, 'hidden', true);
    patchAttr(tooltipEl, 'hidden', true);
    patchClasses(tooltipEl, { 'is-tracking': false });
    if (currentPoints.some((p) => p.valid)) {
      patchAttr(peakPill, 'hidden', false);
    }
    for (const el of tickElsByIdx.values()) {
      patchClasses(el, { 'is-hovered': false });
    }
  }

  plotStage.addEventListener('mousemove', (e) => {
    if (!currentPoints.length) return;
    const rect = svg.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const relX = ((e.clientX - rect.left) / rect.width) * viewW;
    const { leftX, spanX } = resolvePlotBounds(viewW);
    const ratio = (relX - leftX) / Math.max(1, spanX);
    const idx = Math.max(
      0,
      Math.min(currentPoints.length - 1, Math.round(ratio * (currentPoints.length - 1)))
    );
    showHoverAt(idx);
  });
  plotStage.addEventListener('mouseleave', clearHover);

  let resizeObs = null;
  let onWinResize = null;
  if (typeof ResizeObserver === 'function') {
    resizeObs = new ResizeObserver(() => {
      if (syncViewWidth() && lastUpdateParams) {
        lastSig = '';
        update(lastUpdateParams);
      }
    });
    resizeObs.observe(plotStage);
  } else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    onWinResize = () => {
      if (syncViewWidth() && lastUpdateParams) {
        lastSig = '';
        update(lastUpdateParams);
      }
    };
    window.addEventListener('resize', onWinResize);
  }

  function destroy() {
    resizeObs?.disconnect();
    resizeObs = null;
    if (onWinResize && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('resize', onWinResize);
      onWinResize = null;
    }
  }

  /**
   * @param {{
   *   steps: Array<object>,
   *   modelGroupKey?: string,
   *   modelGroupKeys?: string[]|null,
   *   modelColorByGroup?: Map<string, string>|null,
   *   metric: 'totalTokens'|'context'|'tps'|'ttft'|'cost',
   *   showAgentPrefix?: boolean,
   *   displaySettings?: object,
   * }} params
   * @returns {{ summaryBadge: string }}
   */
  function update({
    steps = [],
    modelGroupKey = '__all__',
    modelGroupKeys = null,
    modelColorByGroup = null,
    metric = 'totalTokens',
    showAgentPrefix = false,
    displaySettings = {},
  } = {}) {
    lastUpdateParams = {
      steps,
      modelGroupKey,
      modelGroupKeys,
      modelColorByGroup,
      metric,
      showAgentPrefix,
      displaySettings,
    };
    currentMetric = metric;
    syncViewWidth();

    const accentColor = 'var(--ctx-cached)';
    patchAttr(stop1, 'stop-color', accentColor);
    patchAttr(stop2, 'stop-color', accentColor);
    patchStyleVar(rootEl, '--sstep-accent', accentColor);

    const rawKeys =
      Array.isArray(modelGroupKeys) && modelGroupKeys.length > 0
        ? modelGroupKeys
        : [modelGroupKey || '__all__'];
    const isPooledAll = rawKeys.includes('__all__');
    const targetKeys = isPooledAll
      ? ['__all__']
      : Array.from(new Set(rawKeys.map((k) => String(k || '')).filter(Boolean)));
    const targetKeySet = new Set(targetKeys);
    const isMultiCompare = !isPooledAll && targetKeys.length >= 2;

    const matchedSteps = isPooledAll
      ? steps
      : steps.filter((st) => st && targetKeySet.has(getStepModelGroupKey(st)));

    patchText(emptyHintEl, t('chart.step.empty'));
    if (!matchedSteps.length) {
      currentPoints = [];
      lastSig = 'empty';
      patchAttr(areaPath, 'd', '');
      patchAttr(linePath, 'd', '');
      while (multiAreaGroup.firstChild) multiAreaGroup.removeChild(multiAreaGroup.firstChild);
      while (multiLineGroup.firstChild) multiLineGroup.removeChild(multiLineGroup.firstChild);
      while (dotsGroup.firstChild) dotsGroup.removeChild(dotsGroup.firstChild);
      while (anomalyDotsGroup.firstChild) anomalyDotsGroup.removeChild(anomalyDotsGroup.firstChild);
      while (xAxisEl.firstChild) xAxisEl.removeChild(xAxisEl.firstChild);
      patchAttr(modelLegendEl, 'hidden', true);
      patchAttr(peakPill, 'hidden', true);
      patchAttr(emptyHintEl, 'hidden', false);
      clearHover();
      return { summaryBadge: t('chart.step.zeroSteps') };
    }

    const modelColorMap = new Map();
    const modelLabelByGroup = new Map();
    if (isMultiCompare) {
      for (let i = 0; i < targetKeys.length; i++) {
        const gk = targetKeys[i];
        const colorVar =
          modelColorByGroup?.get(gk) || MODEL_COLOR_VARS[i % MODEL_COLOR_VARS.length];
        modelColorMap.set(gk, colorVar);
        const disp = resolveModelDisplayInfo({ modelLabel: gk, label: gk }, displaySettings, {
          fallback: gk,
        });
        modelLabelByGroup.set(gk, disp.baseText || disp.text || gk);
      }
    }
    for (const st of matchedSteps) {
      const gk = getStepModelGroupKey(st);
      if (!modelColorMap.has(gk)) {
        const colorVar =
          modelColorByGroup?.get(gk) ||
          MODEL_COLOR_VARS[modelColorMap.size % MODEL_COLOR_VARS.length];
        modelColorMap.set(gk, colorVar);
      }
      if (!modelLabelByGroup.has(gk)) {
        const disp = resolveModelDisplayInfo(st, displaySettings, { fallback: gk });
        modelLabelByGroup.set(gk, disp.baseText || disp.text || gk);
      }
    }

    let runningTokens = 0;
    let runningCost = 0;
    let validSum = 0;
    let validCount = 0;
    const perModelRunningTokens = new Map();
    const perModelRunningCost = new Map();
    const perModelPrevCtx = new Map();
    const perModelStats = new Map();

    const rawItems = matchedSteps.map((st, idx) => {
      const gk = getStepModelGroupKey(st);
      const inTok = Math.max(0, Number(st.inputTokens || 0));
      const cacheTok = Math.max(0, Number(st.cacheReadTokens || 0));
      const outTok = Math.max(0, Number(st.outputTokens || 0));
      const stepTotalTok = inTok + cacheTok + outTok;
      runningTokens += stepTotalTok;
      const modelCumTok = (perModelRunningTokens.get(gk) || 0) + stepTotalTok;
      perModelRunningTokens.set(gk, modelCumTok);

      const stepCost = Number.isFinite(Number(st.costUsd)) ? Math.max(0, Number(st.costUsd)) : null;
      if (stepCost !== null) {
        runningCost += stepCost;
        perModelRunningCost.set(gk, (perModelRunningCost.get(gk) || 0) + stepCost);
      }
      const modelCumCost = perModelRunningCost.get(gk) || 0;

      const ctxTok = Math.max(0, Number(st.contextTokens ?? stepTotalTok));
      const hasPrevModelCtx = perModelPrevCtx.has(gk);
      const prevSameModelCtx = hasPrevModelCtx ? perModelPrevCtx.get(gk) : ctxTok;
      perModelPrevCtx.set(gk, ctxTok);

      const prevGlobalCtx =
        idx > 0
          ? Math.max(
              0,
              Number(
                matchedSteps[idx - 1].contextTokens ??
                  Number(matchedSteps[idx - 1].inputTokens || 0) +
                    Number(matchedSteps[idx - 1].cacheReadTokens || 0) +
                    Number(matchedSteps[idx - 1].outputTokens || 0)
              )
            )
          : ctxTok;
      const hasPrevCtx = isMultiCompare ? hasPrevModelCtx : idx > 0;
      const ctxDelta = isMultiCompare ? ctxTok - prevSameModelCtx : idx > 0 ? ctxTok - prevGlobalCtx : 0;

      const disp = resolveModelDisplayInfo(st, displaySettings, { fallback: '—' });
      const stepTag = formatStepAxisTag(st, showAgentPrefix);

      let valid = true;
      let value = 0;
      let secondaryRight = '';
      let subDetail = '';

      if (metric === 'totalTokens') {
        value = isMultiCompare ? modelCumTok : runningTokens;
        secondaryRight = t('chart.step.stepAdd', { tokens: formatTokens(stepTotalTok) });
        subDetail = t('chart.step.ioSplit', {
          inTok: formatTokens(inTok),
          cacheTok: formatTokens(cacheTok),
          outTok: formatTokens(outTok),
        });
      } else if (metric === 'context') {
        value = ctxTok;
        if (hasPrevCtx) {
          const sign = ctxDelta >= 0 ? '+' : '-';
          secondaryRight = `${sign}${formatTokens(Math.abs(ctxDelta))}`;
        } else {
          secondaryRight = t('chart.step.cacheShort', { pct: Number(st.cacheHitPct ?? 0) });
        }
        subDetail = st.isCompactionStep
          ? t('chart.step.compactionCheckpoint')
          : t('chart.step.cacheHitOut', {
              pct: Number(st.cacheHitPct ?? 0),
              outTok: formatTokens(outTok),
            });
      } else if (metric === 'tps') {
        valid = !st.isCompactionStep && Number.isFinite(st.tokPerSec) && st.tokPerSec > 0;
        value = valid ? Number(st.tokPerSec) : 0;
        secondaryRight = Number.isFinite(st.ttftSec)
          ? t('chart.step.ttftShort', { sec: formatMetric(st.ttftSec, '') })
          : '';
        subDetail = valid
          ? t('chart.step.outAndCtx', {
              outTok: formatTokens(outTok),
              ctxTok: formatTokens(ctxTok),
            })
          : speedReasonText(st.selectedSpeedReason) ||
            (st.isCompactionStep ? t('chart.step.compactionStep') : t('chart.step.noSpeedSample'));
      } else if (metric === 'ttft') {
        valid = !st.isCompactionStep && Number.isFinite(st.ttftSec) && st.ttftSec >= 0;
        value = valid ? Number(st.ttftSec) : 0;
        secondaryRight = Number.isFinite(st.tokPerSec) ? formatSpeedMetric(st.tokPerSec, ' tok/s') : '';
        subDetail = valid
          ? t('chart.step.ctxAndCache', {
              ctxTok: formatTokens(ctxTok),
              pct: Number(st.cacheHitPct ?? 0),
            })
          : st.isCompactionStep
            ? t('chart.step.compactionStep')
            : t('chart.step.noTtftSample');
      } else if (metric === 'cost') {
        valid = stepCost !== null;
        value = valid ? stepCost : 0;
        const shownCumCost = isMultiCompare ? modelCumCost : runningCost;
        secondaryRight = t('chart.step.cumCost', {
          cost: formatUsd(shownCumCost, { precise: shownCumCost > 0 && shownCumCost < 0.1 }),
        });
        subDetail = t('chart.step.cacheAndStepTok', {
          pct: Number(st.cacheHitPct ?? 0),
          tokens: formatTokens(stepTotalTok),
        });
      }

      if (valid) {
        validSum += value;
        validCount += 1;
        let stStat = perModelStats.get(gk);
        if (!stStat) {
          stStat = { count: 0, sum: 0, max: 0, last: 0, cumTok: 0, cumCost: 0 };
          perModelStats.set(gk, stStat);
        }
        stStat.count += 1;
        stStat.sum += value;
        if (value > stStat.max) stStat.max = value;
        stStat.last = value;
        stStat.cumTok = modelCumTok;
        stStat.cumCost = modelCumCost;
      }

      const dotColor = modelColorMap.get(gk) || accentColor;
      const anomalySummary = formatStepAnomalyInlineSummary(st.anomaly);
      return {
        idx,
        st,
        stepTag,
        modelGroupKey: gk,
        modelText: disp.text,
        dotColor,
        hoverColor: isMultiCompare ? dotColor : accentColor,
        valid,
        value,
        secondaryRight,
        subDetail,
        anomalySummary,
        anomalySeverity: st.anomaly?.severity || '',
      };
    });

    let maxVal = 0;
    let peakIdx = -1;
    for (let i = 0; i < rawItems.length; i++) {
      if (rawItems[i].valid && rawItems[i].value >= maxVal) {
        maxVal = rawItems[i].value;
        peakIdx = i;
      }
    }

    const { leftX, rightX, spanX } = resolvePlotBounds(viewW);
    const denom = maxVal > 0 ? maxVal : 1;
    const isSingle = rawItems.length === 1;
    const points = rawItems.map((item, i) => {
      const x = isSingle
        ? (leftX + rightX) / 2
        : leftX + (i / Math.max(1, rawItems.length - 1)) * spanX;
      const ratio = item.valid && maxVal > 0 ? item.value / denom : 0;
      const y = item.valid ? BOTTOM_Y - ratio * SPAN_Y : BOTTOM_Y;
      return { ...item, x, y };
    });
    currentPoints = points;

    const validPoints = points.filter((p) => p.valid);
    patchAttr(emptyHintEl, 'hidden', validPoints.length > 0);

    const locale = getEffectiveLocale();
    const colorSig = Array.from(modelColorMap.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    const sig =
      `${locale}|${viewW}|${metric}|${showAgentPrefix}|${isMultiCompare ? 'multi' : 'single'}:${targetKeys.join(',')}|${colorSig}|` +
      points
        .map(
          (p) =>
            `${p.stepTag}:${p.modelText}:${p.valid ? p.value.toFixed(4) : 'x'}:${p.st?.anomalySig || ''}`
        )
        .join('|');

    if (sig !== lastSig) {
      lastSig = sig;
      while (multiAreaGroup.firstChild) multiAreaGroup.removeChild(multiAreaGroup.firstChild);
      while (multiLineGroup.firstChild) multiLineGroup.removeChild(multiLineGroup.firstChild);
      while (dotsGroup.firstChild) dotsGroup.removeChild(dotsGroup.firstChild);
      while (anomalyDotsGroup.firstChild) anomalyDotsGroup.removeChild(anomalyDotsGroup.firstChild);

      if (isMultiCompare) {
        patchAttr(linePath, 'd', '');
        patchAttr(areaPath, 'd', '');

        for (const gk of targetKeys) {
          const seriesColor = modelColorMap.get(gk) || accentColor;
          const seriesPts = points.filter((p) => p.modelGroupKey === gk && p.valid);
          if (seriesPts.length === 0) continue;

          if (seriesPts.length === 1) {
            const singleDot = document.createElementNS(SVG_NS, 'circle');
            singleDot.setAttribute('cx', seriesPts[0].x.toFixed(1));
            singleDot.setAttribute('cy', seriesPts[0].y.toFixed(1));
            singleDot.setAttribute('r', '3.1');
            singleDot.setAttribute('class', 'sstep-series-single-dot');
            patchStyleVar(singleDot, '--sstep-series-color', seriesColor);
            multiLineGroup.appendChild(singleDot);
          } else {
            const seriesLineD = buildSplinePath(seriesPts);
            const firstX = seriesPts[0].x.toFixed(1);
            const lastX = seriesPts[seriesPts.length - 1].x.toFixed(1);

            const mArea = document.createElementNS(SVG_NS, 'path');
            mArea.setAttribute('class', 'sstep-multi-area');
            mArea.setAttribute(
              'd',
              `${seriesLineD} L ${lastX} ${BOTTOM_Y} L ${firstX} ${BOTTOM_Y} Z`
            );
            patchStyleVar(mArea, '--sstep-series-color', seriesColor);
            multiAreaGroup.appendChild(mArea);

            const mLine = document.createElementNS(SVG_NS, 'path');
            mLine.setAttribute('class', 'sstep-fit-line');
            mLine.setAttribute('fill', 'none');
            mLine.setAttribute('d', seriesLineD);
            patchStyleVar(mLine, '--sstep-fit-accent', seriesColor);
            multiLineGroup.appendChild(mLine);

            if (seriesPts.length <= 36) {
              for (const pt of seriesPts) {
                const dot = document.createElementNS(SVG_NS, 'circle');
                dot.setAttribute('cx', pt.x.toFixed(1));
                dot.setAttribute('cy', pt.y.toFixed(1));
                dot.setAttribute('r', seriesPts.length > 20 ? '1.7' : '2.1');
                dot.setAttribute('class', 'sstep-node-dot');
                patchStyleVar(dot, '--dot-stroke', seriesColor);
                dotsGroup.appendChild(dot);
              }
            }
          }
        }
      } else {
        if (validPoints.length === 0) {
          patchAttr(linePath, 'd', '');
          patchAttr(areaPath, 'd', '');
        } else if (validPoints.length === 1) {
          const yStr = validPoints[0].y.toFixed(1);
          const lineD = `M ${leftX.toFixed(1)} ${yStr} L ${rightX.toFixed(1)} ${yStr}`;
          patchAttr(linePath, 'd', lineD);
          patchAttr(
            areaPath,
            'd',
            `${lineD} L ${rightX.toFixed(1)} ${BOTTOM_Y} L ${leftX.toFixed(1)} ${BOTTOM_Y} Z`
          );
        } else {
          const lineD = buildSplinePath(validPoints);
          const firstX = validPoints[0].x.toFixed(1);
          const lastX = validPoints[validPoints.length - 1].x.toFixed(1);
          patchAttr(linePath, 'd', lineD);
          patchAttr(areaPath, 'd', `${lineD} L ${lastX} ${BOTTOM_Y} L ${firstX} ${BOTTOM_Y} Z`);
        }

        if (points.length <= 64) {
          for (const pt of points) {
            const dot = document.createElementNS(SVG_NS, 'circle');
            dot.setAttribute('cx', pt.x.toFixed(1));
            dot.setAttribute('cy', pt.y.toFixed(1));
            if (pt.valid) {
              dot.setAttribute('r', points.length > 36 ? '1.8' : '2.3');
              dot.setAttribute('class', 'sstep-node-dot');
              patchStyleVar(
                dot,
                '--dot-stroke',
                modelColorMap.size > 1 ? pt.dotColor : accentColor
              );
            } else {
              dot.setAttribute('r', '1.6');
              dot.setAttribute('class', 'sstep-node-dot is-skipped');
            }
            dotsGroup.appendChild(dot);
          }
        }
      }

      for (const pt of points) {
        if (!pt.valid || !pt.anomalySummary) continue;
        const aDot = document.createElementNS(SVG_NS, 'circle');
        aDot.setAttribute('cx', pt.x.toFixed(1));
        aDot.setAttribute('cy', pt.y.toFixed(1));
        aDot.setAttribute('r', '2.9');
        aDot.setAttribute(
          'class',
          `sstep-anomaly-dot${pt.anomalySeverity === 'danger' ? ' is-danger' : ''}`
        );
        anomalyDotsGroup.appendChild(aDot);
      }

      const tickIndices = computeStepTickIndices(points.length);
      while (xAxisEl.firstChild) xAxisEl.removeChild(xAxisEl.firstChild);
      tickElsByIdx = new Map();
      for (let i = 0; i < tickIndices.length; i++) {
        const tIdx = tickIndices[i];
        const pt = points[tIdx];
        if (!pt) continue;
        const isFirst = !isSingle && i === 0;
        const isLast = !isSingle && i === tickIndices.length - 1;
        const pct = isFirst ? 0 : isLast ? 100 : (pt.x / viewW) * 100;
        const tickEl = h('span', {
          className: `trend-x-tick text-mono${isFirst ? ' is-start' : isLast ? ' is-end' : ''}`,
          text: pt.stepTag,
          title: `${pt.stepTag} · ${pt.modelText}`,
        });
        patchStyleVar(tickEl, '--tick-x', `${pct.toFixed(2)}%`);
        tickEl.onclick = () => showHoverAt(tIdx);
        xAxisEl.appendChild(tickEl);
        tickElsByIdx.set(tIdx, tickEl);
      }

      while (modelLegendEl.firstChild) modelLegendEl.removeChild(modelLegendEl.firstChild);
      if (isMultiCompare) {
        patchAttr(modelLegendEl, 'hidden', false);
        for (const gk of targetKeys) {
          const colorVar = modelColorMap.get(gk) || accentColor;
          const swatch = h('span', { className: 'sstep-legend-line' });
          patchStyleVar(swatch, '--swatch-bg', colorVar);
          const stStat = perModelStats.get(gk);
          const baseLabel = modelLabelByGroup.get(gk) || gk;
          let summarySuffix = t('chart.step.noSamples');
          if (stStat && stStat.count > 0) {
            if (metric === 'totalTokens') {
              summarySuffix = formatTokens(stStat.cumTok);
            } else if (metric === 'context') {
              summarySuffix = t('chart.step.peakShort', { val: formatTokens(stStat.max) });
            } else if (metric === 'tps' || metric === 'ttft') {
              summarySuffix = formatChartMetricCompact(metric, stStat.sum / stStat.count);
            } else if (metric === 'cost') {
              summarySuffix = formatUsd(stStat.cumCost, {
                precise: stStat.cumCost > 0 && stStat.cumCost < 0.1,
              });
            }
          }
          modelLegendEl.appendChild(
            h('span', { className: 'sstep-legend-item' }, [
              swatch,
              h('span', { text: `${baseLabel} (${summarySuffix})` }),
            ])
          );
        }
      } else {
        const showPooledDotLegend = points.length <= 64 && modelColorMap.size > 1;
        patchAttr(modelLegendEl, 'hidden', !showPooledDotLegend);
        if (showPooledDotLegend) {
          for (const [gk, colorVar] of modelColorMap.entries()) {
            const swatch = h('span', { className: 'sstep-legend-dot' });
            patchStyleVar(swatch, '--swatch-bg', colorVar);
            modelLegendEl.appendChild(
              h('span', { className: 'sstep-legend-item' }, [
                swatch,
                h('span', { text: modelLabelByGroup.get(gk) || gk }),
              ])
            );
          }
        }
      }
    }

    if (peakIdx >= 0 && validPoints.length > 0) {
      const peakPt = points[peakIdx];
      patchText(
        peakPill,
        t('chart.step.peakPill', {
          tag: peakPt.stepTag,
          val: formatChartMetricCompact(metric, peakPt.value),
        })
      );
      patchStyleVar(peakPill, '--sstep-accent', isMultiCompare ? peakPt.dotColor : accentColor);
      const pctLeft = Math.max(14, Math.min(86, (peakPt.x / viewW) * 100));
      patchStyleVar(peakPill, '--peak-x', `${pctLeft.toFixed(1)}%`);
      if (hoveredIdx < 0) patchAttr(peakPill, 'hidden', false);
    } else {
      patchAttr(peakPill, 'hidden', true);
    }

    if (hoveredIdx >= points.length) {
      clearHover();
    } else if (hoveredIdx >= 0) {
      showHoverAt(hoveredIdx);
    }

    let summaryBadge = t('chart.step.stepsCount', { count: matchedSteps.length });
    const activeCompareCount = isMultiCompare ? targetKeys.length : 1;
    const multiPrefix = isMultiCompare
      ? t('chart.step.multiPrefix', { count: activeCompareCount })
      : '';
    if (metric === 'totalTokens') {
      summaryBadge = t('chart.step.sumTokens', {
        prefix: multiPrefix,
        tokens: formatTokens(runningTokens),
      });
    } else if (metric === 'context') {
      const lastCtx = points[points.length - 1]?.value || 0;
      summaryBadge = isMultiCompare
        ? t('chart.step.peakTokens', { prefix: multiPrefix, tokens: formatTokens(maxVal) })
        : t('chart.step.currentCtx', { tokens: formatTokens(lastCtx) });
    } else if (metric === 'tps') {
      summaryBadge =
        validCount > 0
          ? t('chart.step.meanTps', {
              prefix: multiPrefix,
              val: (validSum / validCount).toFixed(1),
            })
          : t('chart.step.noValidSamples');
    } else if (metric === 'ttft') {
      summaryBadge =
        validCount > 0
          ? t('chart.step.meanSec', {
              prefix: multiPrefix,
              val: (validSum / validCount).toFixed(1),
            })
          : t('chart.step.noValidSamples');
    } else if (metric === 'cost') {
      summaryBadge = t('chart.step.sumCost', {
        prefix: multiPrefix,
        cost: formatUsd(runningCost, { precise: runningCost > 0 && runningCost < 0.1 }),
      });
    }

    return { summaryBadge };
  }

  return { el: rootEl, update, destroy };
}

/**
 * 创建学术论文风格散点回归与 95% 置信带拟合图（全宽 1:1 贴边对齐 + 项目统一冷蓝灰设计语言）：
 * - 全宽水平参考网格与底部线性步序刻度轴（内嵌左对齐 Y 轴刻度标签，零左右缩进留白）；
 * - 半透明冷蓝灰实心观测散点（自然呈现重叠密度）；
 * - 围绕回归曲线的 95% CI 置信区间阴影带（绝不向 y=0 做面积图填充）；
 * - 高斯局部线性回归曲线（LOESS, n >= 6）或精确线性回归（OLS, n <= 5），配相关系数 r 与拟合优度 R²。
 */
function createModelFitChart() {
  const DEFAULT_VIEW_W = 460;
  const VIEW_H = 136;
  const TOP_Y = 16;
  const BOTTOM_Y = 116;
  const SPAN_Y = BOTTOM_Y - TOP_Y;

  let viewW = DEFAULT_VIEW_W;

  function resolveFitBounds(w) {
    const plotLeft = 2;
    const plotRight = Math.max(plotLeft + 20, w - 2);
    return { plotLeft, plotRight, plotSpanX: plotRight - plotLeft };
  }

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${viewW} ${VIEW_H}`);
  svg.setAttribute('class', 'sstep-svg sstep-fit-svg');
  svg.setAttribute('aria-hidden', 'true');

  const gridGroup = document.createElementNS(SVG_NS, 'g');
  gridGroup.setAttribute('class', 'sstep-sci-grid');
  svg.appendChild(gridGroup);

  const axesGroup = document.createElementNS(SVG_NS, 'g');
  axesGroup.setAttribute('class', 'sstep-sci-axes');
  svg.appendChild(axesGroup);

  const multiBandGroup = document.createElementNS(SVG_NS, 'g');
  multiBandGroup.setAttribute('class', 'sstep-multi-band-group');
  svg.appendChild(multiBandGroup);

  const scatterGroup = document.createElementNS(SVG_NS, 'g');
  scatterGroup.setAttribute('class', 'sstep-scatter-group');
  svg.appendChild(scatterGroup);

  const multiCurveGroup = document.createElementNS(SVG_NS, 'g');
  multiCurveGroup.setAttribute('class', 'sstep-multi-curve-group');
  svg.appendChild(multiCurveGroup);

  const ciBandPath = document.createElementNS(SVG_NS, 'path');
  ciBandPath.setAttribute('class', 'sstep-ci-band');
  svg.appendChild(ciBandPath);

  const olsLine = document.createElementNS(SVG_NS, 'line');
  olsLine.setAttribute('class', 'sstep-ols-line');
  olsLine.setAttribute('hidden', 'true');
  svg.appendChild(olsLine);

  const fitPath = document.createElementNS(SVG_NS, 'path');
  fitPath.setAttribute('class', 'sstep-fit-line');
  fitPath.setAttribute('fill', 'none');
  svg.appendChild(fitPath);

  const hoverLine = document.createElementNS(SVG_NS, 'line');
  hoverLine.setAttribute('class', 'trend-hover-line');
  hoverLine.setAttribute('y1', String(TOP_Y));
  hoverLine.setAttribute('y2', String(BOTTOM_Y));
  hoverLine.setAttribute('hidden', 'true');
  svg.appendChild(hoverLine);

  const hoverRawDot = document.createElementNS(SVG_NS, 'circle');
  hoverRawDot.setAttribute('r', '3.0');
  hoverRawDot.setAttribute('class', 'sstep-hover-raw-dot');
  hoverRawDot.setAttribute('hidden', 'true');
  svg.appendChild(hoverRawDot);

  const hoverFitDot = document.createElementNS(SVG_NS, 'circle');
  hoverFitDot.setAttribute('r', '3.1');
  hoverFitDot.setAttribute('class', 'trend-hover-dot');
  hoverFitDot.setAttribute('hidden', 'true');
  svg.appendChild(hoverFitDot);

  const emptyHintEl = h('div', {
    className: 'sstep-empty-hint text-muted',
    text: t('chart.fit.empty'),
    hidden: true,
  });

  const tipHeadLeft = h('span', { className: 'trend-tip-time text-mono' });
  const tipHeadRight = h('span', { className: 'trend-tip-calls text-mono' });
  const tipMainLeft = h('strong', { className: 'trend-tip-tokens text-mono' });
  const tipMainRight = h('span', { className: 'trend-tip-cost text-mono' });
  const tipSub = h('div', { className: 'trend-tip-sub text-mono', hidden: true });
  const tipAnomaly = h('div', { className: 'trend-tip-anomaly text-mono', hidden: true });
  const tooltipEl = h('div', { className: 'trend-tooltip', hidden: true }, [
    h('div', { className: 'trend-tip-head' }, [tipHeadLeft, tipHeadRight]),
    h('div', { className: 'trend-tip-main' }, [tipMainLeft, tipMainRight]),
    tipSub,
    tipAnomaly,
  ]);

  const fitMethodLabelEl = h('span', { text: t('chart.fit.loess') });
  const olsLegendTextEl = h('span', { text: t('chart.fit.olsLinear') });
  const olsLegendWrapEl = h('span', { className: 'sstep-fit-legend-ols' }, [
    h('span', { className: 'sstep-fit-swatch is-ols' }),
    olsLegendTextEl,
  ]);
  const obsLegendTextEl = h('span', { text: t('chart.fit.observed') });
  const singleLegendEl = h('span', { className: 'sstep-fit-legend' }, [
    h('span', { className: 'sstep-fit-swatch is-scatter' }),
    obsLegendTextEl,
    h('span', { className: 'sstep-fit-swatch is-curve' }),
    fitMethodLabelEl,
    h('span', { className: 'sstep-fit-swatch is-ci' }),
    h('span', { text: '95% CI' }),
    olsLegendWrapEl,
  ]);
  const multiLegendEl = h('div', { className: 'sstep-model-legend', hidden: true });
  const fitStatsEl = h('span', { className: 'sstep-fit-delta text-mono text-muted' });

  const fitLegendFoot = h('div', { className: 'sstep-fit-foot' }, [
    singleLegendEl,
    multiLegendEl,
    fitStatsEl,
  ]);

  const plotStage = h('div', { className: 'sstep-plot-stage' }, [emptyHintEl, tooltipEl, svg]);
  const rootEl = h('div', { className: 'sstep-chart-wrap' }, [plotStage, fitLegendFoot]);

  let currentSamples = [];
  let currentMetric = 'tps';
  let hoveredIdx = -1;
  let lastSig = '';
  let lastUpdateParams = null;
  let fitCacheMetric = '';
  const fitCache = new Map();

  function reusePublicationFit(key, xs, ys, maxVal, isMultiCompare) {
    const previous = fitCache.get(key);
    if (
      previous && previous.xs.length === xs.length &&
      xs.every((x, i) => x === previous.xs[i] && ys[i] === previous.ys[i])
    ) {
      return previous.result;
    }
    const result = computePublicationFit(xs, ys, {
      minVal: 0,
      maxVal,
      gridSize: isMultiCompare ? 56 : 64,
      span: 0.5,
    });
    fitCache.set(key, { xs, ys, result });
    return result;
  }

  function syncViewWidth() {
    const measured = Math.round(
      plotStage.clientWidth ||
        svg.clientWidth ||
        plotStage.getBoundingClientRect?.()?.width ||
        0
    );
    if (measured >= 160 && measured !== viewW) {
      viewW = measured;
      svg.setAttribute('viewBox', `0 0 ${viewW} ${VIEW_H}`);
      return true;
    }
    return false;
  }

  function showHoverAt(idx) {
    if (idx < 0 || idx >= currentSamples.length) {
      clearHover();
      return;
    }
    hoveredIdx = idx;
    const sp = currentSamples[idx];
    patchAttr(hoverLine, 'hidden', false);
    patchAttr(hoverLine, 'x1', sp.x.toFixed(1));
    patchAttr(hoverLine, 'x2', sp.x.toFixed(1));

    patchAttr(hoverFitDot, 'hidden', false);
    patchAttr(hoverFitDot, 'cx', sp.x.toFixed(1));
    patchAttr(hoverFitDot, 'cy', sp.fitY.toFixed(1));
    patchStyleVar(hoverFitDot, '--hover-dot-color', sp.seriesColor || 'var(--accent-primary)');

    patchAttr(hoverRawDot, 'hidden', false);
    patchAttr(hoverRawDot, 'cx', sp.x.toFixed(1));
    patchAttr(hoverRawDot, 'cy', sp.rawY.toFixed(1));
    patchClasses(hoverRawDot, {
      'is-anomaly': Boolean(sp.anomalySummary),
      'is-danger': Boolean(sp.anomalySummary && sp.anomalySeverity === 'danger'),
    });

    const wasHidden = tooltipEl.hasAttribute('hidden');
    patchAttr(tooltipEl, 'hidden', false);
    patchText(tipHeadLeft, sp.stepTag);
    patchText(tipHeadRight, sp.modelText);
    patchText(
      tipMainLeft,
      t('chart.fit.tipFit', { val: formatChartMetricValue(currentMetric, sp.fitVal) })
    );
    patchText(
      tipMainRight,
      t('chart.fit.tipObs', { val: formatChartMetricValue(currentMetric, sp.rawVal) })
    );

    patchAttr(tipSub, 'hidden', false);
    if (sp.compareHint) {
      patchText(tipSub, sp.compareHint);
    } else if (currentSamples.length >= 3 && sp.ciHalf > 0) {
      patchText(
        tipSub,
        `95% CI [${formatChartMetricCompact(currentMetric, sp.ciLow)}, ${formatChartMetricCompact(currentMetric, sp.ciHigh)}]`
      );
    } else {
      const ctxTok = Math.max(0, Number(sp.st?.contextTokens || 0));
      patchText(
        tipSub,
        t('chart.step.ctxAndCache', {
          ctxTok: formatTokens(ctxTok),
          pct: Number(sp.st?.cacheHitPct ?? 0),
        })
      );
    }
    patchAttr(tipAnomaly, 'hidden', !sp.anomalySummary);
    if (sp.anomalySummary) {
      patchText(tipAnomaly, sp.anomalySummary);
      patchClasses(tipAnomaly, { 'is-danger': sp.anomalySeverity === 'danger' });
    }

    const rawPct = (sp.x / viewW) * 100;
    const clampedPct = Math.max(1, Math.min(99, rawPct));
    patchStyleVar(tooltipEl, '--tip-x', `${clampedPct.toFixed(1)}%`);
    patchStyleVar(tooltipEl, '--tip-shift', `-${clampedPct.toFixed(1)}%`);
    patchStyleVar(tooltipEl, '--tip-y', '0px');
    if (wasHidden) {
      patchClasses(tooltipEl, { 'is-tracking': false });
      void tooltipEl.offsetWidth;
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => {
          if (!tooltipEl.hasAttribute('hidden')) {
            patchClasses(tooltipEl, { 'is-tracking': true });
          }
        });
      } else {
        patchClasses(tooltipEl, { 'is-tracking': true });
      }
    }
  }

  function clearHover() {
    hoveredIdx = -1;
    patchAttr(hoverLine, 'hidden', true);
    patchAttr(hoverFitDot, 'hidden', true);
    patchAttr(hoverRawDot, 'hidden', true);
    patchAttr(tooltipEl, 'hidden', true);
    patchClasses(tooltipEl, { 'is-tracking': false });
  }

  plotStage.addEventListener('mousemove', (e) => {
    if (!currentSamples.length) return;
    const rect = svg.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const relX = ((e.clientX - rect.left) / rect.width) * viewW;
    let lo = 0;
    let hi = currentSamples.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (currentSamples[mid].x < relX) lo = mid + 1;
      else hi = mid;
    }
    let bestIdx = lo;
    if (
      lo > 0 &&
      Math.abs(currentSamples[lo - 1].x - relX) <= Math.abs(currentSamples[lo].x - relX)
    ) {
      bestIdx = lo - 1;
    }
    showHoverAt(bestIdx);
  });
  plotStage.addEventListener('mouseleave', clearHover);

  let resizeObs = null;
  let onWinResize = null;
  if (typeof ResizeObserver === 'function') {
    resizeObs = new ResizeObserver(() => {
      if (syncViewWidth() && lastUpdateParams) {
        lastSig = '';
        update(lastUpdateParams);
      }
    });
    resizeObs.observe(plotStage);
  } else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    onWinResize = () => {
      if (syncViewWidth() && lastUpdateParams) {
        lastSig = '';
        update(lastUpdateParams);
      }
    };
    window.addEventListener('resize', onWinResize);
  }

  function destroy() {
    resizeObs?.disconnect();
    resizeObs = null;
    if (onWinResize && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('resize', onWinResize);
      onWinResize = null;
    }
  }

  /**
   * 在给定横坐标 x0 处对某模型的回归网格做线性插值（仅当 x0 位于该模型观测区间内时返回拟合值）。
   */
  function interpolateSeriesGridFit(grid, x0) {
    if (!Array.isArray(grid) || grid.length === 0) return null;
    if (grid.length === 1) {
      return Math.abs(grid[0].x - x0) < 1e-6 ? grid[0].fit : null;
    }
    const gMin = grid[0].x;
    const gMax = grid[grid.length - 1].x;
    if (x0 < gMin - 1e-6 || x0 > gMax + 1e-6) return null;
    if (x0 <= gMin) return grid[0].fit;
    if (x0 >= gMax) return grid[grid.length - 1].fit;
    for (let i = 0; i < grid.length - 1; i++) {
      const a = grid[i];
      const b = grid[i + 1];
      if (x0 >= a.x && x0 <= b.x) {
        const span = b.x - a.x;
        const t = span > 1e-9 ? (x0 - a.x) / span : 0;
        return a.fit + t * (b.fit - a.fit);
      }
    }
    return grid[grid.length - 1].fit;
  }

  /**
   * 绘制共享的水平网格线、底部步序坐标轴及左对齐内联 Y 轴刻度标签。
   */
  function renderFitAxesAndGrid({ yScale, mapY, mapX, xs, isSingle, plotLeft, plotRight, metric, showAgentPrefix }) {
    while (gridGroup.firstChild) gridGroup.removeChild(gridGroup.firstChild);
    while (axesGroup.firstChild) axesGroup.removeChild(axesGroup.firstChild);

    const xMin = xs[0];
    const xMax = xs[xs.length - 1];

    const xSpine = document.createElementNS(SVG_NS, 'line');
    xSpine.setAttribute('x1', '0');
    xSpine.setAttribute('y1', String(BOTTOM_Y));
    xSpine.setAttribute('x2', String(viewW));
    xSpine.setAttribute('y2', String(BOTTOM_Y));
    xSpine.setAttribute('class', 'sstep-axis-spine');
    axesGroup.appendChild(xSpine);

    for (const tv of yScale.ticks) {
      const ty = mapY(tv);
      if (Math.abs(ty - BOTTOM_Y) > 1.5) {
        const gLine = document.createElementNS(SVG_NS, 'line');
        gLine.setAttribute('x1', '0');
        gLine.setAttribute('y1', ty.toFixed(1));
        gLine.setAttribute('x2', String(viewW));
        gLine.setAttribute('y2', ty.toFixed(1));
        gridGroup.appendChild(gLine);
      }

      const labelEl = document.createElementNS(SVG_NS, 'text');
      labelEl.setAttribute('x', '0');
      labelEl.setAttribute('y', (ty - 3.5).toFixed(1));
      labelEl.setAttribute('text-anchor', 'start');
      labelEl.setAttribute('class', 'sstep-axis-label is-y-inline');
      labelEl.textContent = formatYAxisTick(metric, tv, yScale.step);
      axesGroup.appendChild(labelEl);
    }

    const xTickEntries = [];
    if (isSingle) {
      xTickEntries.push({
        xv: Math.round(xMin),
        tickX: mapX(xMin),
        labelX: mapX(xMin),
        anchor: 'middle',
      });
    } else {
      xTickEntries.push({
        xv: Math.round(xMin),
        tickX: plotLeft,
        labelX: 0,
        anchor: 'start',
      });
      const interiorTicks = computeNiceXStepTicks(xs);
      for (const xv of interiorTicks) {
        if (xv <= xMin || xv >= xMax) continue;
        const tx = mapX(xv);
        if (tx < plotLeft + 38 || tx > plotRight - 38) continue;
        xTickEntries.push({
          xv,
          tickX: tx,
          labelX: tx,
          anchor: 'middle',
        });
      }
      xTickEntries.push({
        xv: Math.round(xMax),
        tickX: plotRight,
        labelX: viewW,
        anchor: 'end',
      });
    }

    for (const xt of xTickEntries) {
      const tickMark = document.createElementNS(SVG_NS, 'line');
      tickMark.setAttribute('x1', xt.tickX.toFixed(1));
      tickMark.setAttribute('y1', String(BOTTOM_Y));
      tickMark.setAttribute('x2', xt.tickX.toFixed(1));
      tickMark.setAttribute('y2', (BOTTOM_Y + 3.2).toFixed(1));
      tickMark.setAttribute('class', 'sstep-axis-tick');
      axesGroup.appendChild(tickMark);

      const labelEl = document.createElementNS(SVG_NS, 'text');
      labelEl.setAttribute('x', xt.labelX.toFixed(1));
      labelEl.setAttribute('y', (BOTTOM_Y + 13.5).toFixed(1));
      labelEl.setAttribute('text-anchor', xt.anchor);
      labelEl.setAttribute('class', 'sstep-axis-label');
      labelEl.textContent = showAgentPrefix ? `${xt.xv}` : `#${xt.xv}`;
      axesGroup.appendChild(labelEl);
    }
  }

  /**
   * @param {{
   *   steps: Array<object>,
   *   modelGroupKey?: string,
   *   modelGroupKeys?: string[]|null,
   *   modelColorByGroup?: Map<string, string>|null,
   *   metric: 'tps'|'ttft'|'cache'|'cost',
   *   showAgentPrefix?: boolean,
   *   displaySettings?: object,
   * }} params
   * @returns {{ sampleCount: number, summaryBadge: string }}
   */
  function update({
    steps = [],
    modelGroupKey = '__all__',
    modelGroupKeys = null,
    modelColorByGroup = null,
    metric = 'tps',
    showAgentPrefix = false,
    displaySettings = {},
  } = {}) {
    lastUpdateParams = {
      steps,
      modelGroupKey,
      modelGroupKeys,
      modelColorByGroup,
      metric,
      showAgentPrefix,
      displaySettings,
    };
    currentMetric = metric;
    syncViewWidth();

    patchStyleVar(rootEl, '--sstep-fit-accent', 'var(--ctx-cached)');

    const rawKeys =
      Array.isArray(modelGroupKeys) && modelGroupKeys.length > 0
        ? modelGroupKeys
        : [modelGroupKey || '__all__'];
    const isPooledAll = rawKeys.includes('__all__');
    const targetKeys = isPooledAll
      ? ['__all__']
      : Array.from(new Set(rawKeys.map((k) => String(k || '')).filter(Boolean)));
    const targetKeySet = new Set(targetKeys);
    const isMultiCompare = !isPooledAll && targetKeys.length >= 2;

    const matchedItems = [];
    let prevXVal = -Infinity;
    for (let idx = 0; idx < steps.length; idx++) {
      const st = steps[idx];
      if (!st || typeof st !== 'object') continue;
      let globalX = showAgentPrefix ? idx + 1 : Number(st.stepIndex ?? idx + 1);
      if (!Number.isFinite(globalX) || globalX <= prevXVal) {
        globalX = prevXVal === -Infinity ? idx + 1 : prevXVal + 1;
      }
      prevXVal = globalX;

      const gk = getStepModelGroupKey(st);
      if (!isPooledAll && !targetKeySet.has(gk)) {
        continue;
      }
      let valid = false;
      let rawVal = 0;
      if (metric === 'tps') {
        valid = !st.isCompactionStep && Number.isFinite(st.tokPerSec) && st.tokPerSec > 0;
        rawVal = valid ? Number(st.tokPerSec) : 0;
      } else if (metric === 'ttft') {
        valid = !st.isCompactionStep && Number.isFinite(st.ttftSec) && st.ttftSec >= 0;
        rawVal = valid ? Number(st.ttftSec) : 0;
      } else if (metric === 'cache') {
        valid = !st.isCompactionStep && Number.isFinite(st.cacheHitPct) && st.cacheHitPct >= 0;
        rawVal = valid ? Number(st.cacheHitPct) : 0;
      } else if (metric === 'cost') {
        valid = Number.isFinite(Number(st.costUsd)) && Number(st.costUsd) >= 0;
        rawVal = valid ? Number(st.costUsd) : 0;
      }
      if (valid) {
        const disp = resolveModelDisplayInfo(st, displaySettings, { fallback: '—' });
        matchedItems.push({
          st,
          gk,
          xVal: globalX,
          rawVal,
          stepTag: formatStepAxisTag(st, showAgentPrefix),
          modelText: disp.baseText || disp.text,
          anomalySummary: formatStepAnomalyInlineSummary(st.anomaly),
          anomalySeverity: st.anomaly?.severity || '',
        });
      }
    }

    const locale = getEffectiveLocale();
    patchText(emptyHintEl, t('chart.fit.empty'));
    patchText(obsLegendTextEl, t('chart.fit.observed'));
    patchText(olsLegendTextEl, t('chart.fit.olsLinear'));

    if (fitCacheMetric !== metric) {
      fitCache.clear();
      fitCacheMetric = metric;
    }
    for (const key of fitCache.keys()) {
      if (isMultiCompare ? !targetKeySet.has(key) : key !== null) fitCache.delete(key);
    }

    if (matchedItems.length === 0) {
      fitCache.clear();
      currentSamples = [];
      lastSig = 'empty';
      patchAttr(ciBandPath, 'd', '');
      patchAttr(fitPath, 'd', '');
      patchAttr(olsLine, 'hidden', true);
      while (multiBandGroup.firstChild) multiBandGroup.removeChild(multiBandGroup.firstChild);
      while (multiCurveGroup.firstChild) multiCurveGroup.removeChild(multiCurveGroup.firstChild);
      while (gridGroup.firstChild) gridGroup.removeChild(gridGroup.firstChild);
      while (axesGroup.firstChild) axesGroup.removeChild(axesGroup.firstChild);
      while (scatterGroup.firstChild) scatterGroup.removeChild(scatterGroup.firstChild);
      patchAttr(singleLegendEl, 'hidden', false);
      patchAttr(multiLegendEl, 'hidden', true);
      patchAttr(emptyHintEl, 'hidden', false);
      patchText(fitMethodLabelEl, t('chart.fit.loess'));
      patchText(fitStatsEl, 'n = 0');
      clearHover();
      return { sampleCount: 0, summaryBadge: t('chart.fit.zeroSamples') };
    }

    patchAttr(emptyHintEl, 'hidden', true);
    const minBound = 0;
    const maxBound = metric === 'cache' ? 100 : Infinity;

    // 分支 A：多模型同图独立拟合曲线对比模式（勾选 >= 2 个模型）
    if (isMultiCompare) {
      const seriesList = [];
      for (let kIdx = 0; kIdx < targetKeys.length; kIdx++) {
        const key = targetKeys[kIdx];
        const items = matchedItems.filter((it) => it.gk === key);
        if (items.length === 0) continue;
        const xs = items.map((d) => d.xVal);
        const rawYs = items.map((d) => d.rawVal);
        const pubFit = reusePublicationFit(key, xs, rawYs, maxBound, true);
        const colorVar =
          modelColorByGroup?.get(key) || MODEL_COLOR_VARS[kIdx % MODEL_COLOR_VARS.length];
        seriesList.push({
          key,
          label: items[0].modelText || key,
          colorVar,
          items,
          xs,
          rawYs,
          pubFit,
        });
      }

      patchAttr(singleLegendEl, 'hidden', true);
      patchAttr(multiLegendEl, 'hidden', false);
      patchAttr(ciBandPath, 'd', '');
      patchAttr(fitPath, 'd', '');
      patchAttr(olsLine, 'hidden', true);

      const allXs = matchedItems.map((d) => d.xVal);
      let dataMin = Infinity;
      let dataMax = -Infinity;
      for (const s of seriesList) {
        for (const v of s.rawYs) {
          if (v < dataMin) dataMin = v;
          if (v > dataMax) dataMax = v;
        }
        for (const g of s.pubFit.grid) {
          if (g.ciLow < dataMin) dataMin = g.ciLow;
          if (g.ciHigh > dataMax) dataMax = g.ciHigh;
        }
      }

      const yScale = computeNiceYScale(dataMin, dataMax, {
        minBound,
        maxBound,
        tickCount: 4,
      });
      const yRange = Math.max(1e-9, yScale.max - yScale.min);
      const mapY = (v) =>
        BOTTOM_Y - ((clampValue(v, yScale.min, yScale.max) - yScale.min) / yRange) * SPAN_Y;

      const { plotLeft, plotRight, plotSpanX } = resolveFitBounds(viewW);
      const xMin = allXs[0];
      const xMax = allXs[allXs.length - 1];
      const isSingle = matchedItems.length === 1 || xMax - xMin <= 1e-9;
      const mapX = (xv) =>
        isSingle
          ? (plotLeft + plotRight) / 2
          : plotLeft + ((xv - xMin) / (xMax - xMin)) * plotSpanX;

      const combinedSamples = [];
      for (const s of seriesList) {
        const sSamples = s.items.map((item, i) => {
          const x = mapX(item.xVal);
          const rawY = mapY(item.rawVal);
          const fitVal = s.pubFit.sampleFits[i];
          const fitY = mapY(fitVal);
          const peerParts = [];
          for (const other of seriesList) {
            if (other.key === s.key) continue;
            const interp = interpolateSeriesGridFit(other.pubFit.grid, item.xVal);
            if (interp !== null) {
              peerParts.push(`${other.label} ${formatChartMetricCompact(metric, interp)}`);
            } else {
              peerParts.push(
                t('chart.fit.peerMean', {
                  label: other.label,
                  val: formatChartMetricCompact(metric, other.pubFit.mean),
                })
              );
            }
          }
          return {
            ...item,
            x,
            rawY,
            fitVal,
            fitY,
            ciLow: s.pubFit.sampleCiLow[i],
            ciHigh: s.pubFit.sampleCiHigh[i],
            ciHalf: s.pubFit.sampleCiHalf[i],
            seriesColor: s.colorVar,
            compareHint:
              peerParts.length > 0
                ? t('chart.fit.peerCompare', { peers: peerParts.join(' · ') })
                : '',
          };
        });
        s.samples = sSamples;
        combinedSamples.push(...sSamples);
      }
      combinedSamples.sort((a, b) => a.x - b.x || a.xVal - b.xVal);
      currentSamples = combinedSamples;

      const sig =
        `multi|${locale}|${viewW}|${targetKeys.join(',')}|${metric}|${showAgentPrefix}|${yScale.min.toFixed(4)}|${yScale.max.toFixed(4)}|` +
        seriesList
          .map(
            (s) =>
              `${s.key}:${s.colorVar}:` +
              s.samples
                .map(
                  (p) =>
                    `${p.xVal}:${p.rawVal.toFixed(3)}:${p.fitVal.toFixed(3)}:${p.st?.anomalySig || ''}`
                )
                .join(',')
          )
          .join('||');

      if (sig !== lastSig) {
        lastSig = sig;
        renderFitAxesAndGrid({
          yScale,
          mapY,
          mapX,
          xs: allXs,
          isSingle,
          plotLeft,
          plotRight,
          metric,
          showAgentPrefix,
        });

        while (multiBandGroup.firstChild) multiBandGroup.removeChild(multiBandGroup.firstChild);
        while (scatterGroup.firstChild) scatterGroup.removeChild(scatterGroup.firstChild);
        while (multiCurveGroup.firstChild) multiCurveGroup.removeChild(multiCurveGroup.firstChild);

        const dotRadius =
          combinedSamples.length > 80 ? '1.8' : combinedSamples.length > 36 ? '2.1' : '2.4';
        const dedupOverdraw = combinedSamples.length > 200;
        const scatterTarget =
          typeof document.createDocumentFragment === 'function'
            ? document.createDocumentFragment()
            : scatterGroup;
        const anomalyOverlayDots = [];

        for (const s of seriesList) {
          const binCounts = dedupOverdraw ? new Map() : null;
          for (const sp of s.samples) {
            if (sp.anomalySummary) {
              anomalyOverlayDots.push(sp);
              continue;
            }
            if (binCounts) {
              const binKey = (Math.round(sp.x * 2) << 11) ^ Math.round(sp.rawY * 2);
              const prevCnt = binCounts.get(binKey) || 0;
              if (prevCnt >= 6) continue;
              binCounts.set(binKey, prevCnt + 1);
            }
            const dot = document.createElementNS(SVG_NS, 'circle');
            dot.setAttribute('cx', sp.x.toFixed(1));
            dot.setAttribute('cy', sp.rawY.toFixed(1));
            dot.setAttribute('r', dotRadius);
            dot.setAttribute('class', 'sstep-scatter-dot is-multi');
            patchStyleVar(dot, '--sstep-fit-accent', s.colorVar);
            scatterTarget.appendChild(dot);
          }

          if (s.samples.length === 1) {
            const sp = s.samples[0];
            const segHalf = Math.min(12, plotSpanX * 0.04);
            const x1 = Math.max(plotLeft, sp.x - segHalf).toFixed(1);
            const x2 = Math.min(plotRight, sp.x + segHalf).toFixed(1);
            const yStr = sp.fitY.toFixed(1);
            const lineEl = document.createElementNS(SVG_NS, 'path');
            lineEl.setAttribute('class', 'sstep-fit-line');
            lineEl.setAttribute('fill', 'none');
            lineEl.setAttribute('d', `M ${x1} ${yStr} L ${x2} ${yStr}`);
            patchStyleVar(lineEl, '--sstep-fit-accent', s.colorVar);
            multiCurveGroup.appendChild(lineEl);
          } else {
            const gridPts = s.pubFit.grid.map((g) => ({
              x: mapX(g.x),
              fitY: mapY(g.fit),
              lowY: mapY(g.ciLow),
              highY: mapY(g.ciHigh),
            }));

            if (s.samples.length >= 3) {
              let bandD = `M ${gridPts[0].x.toFixed(1)} ${gridPts[0].highY.toFixed(1)}`;
              for (let i = 1; i < gridPts.length; i++) {
                bandD += ` L ${gridPts[i].x.toFixed(1)} ${gridPts[i].highY.toFixed(1)}`;
              }
              for (let i = gridPts.length - 1; i >= 0; i--) {
                bandD += ` L ${gridPts[i].x.toFixed(1)} ${gridPts[i].lowY.toFixed(1)}`;
              }
              bandD += ' Z';
              const bandEl = document.createElementNS(SVG_NS, 'path');
              bandEl.setAttribute('class', 'sstep-ci-band is-multi');
              bandEl.setAttribute('d', bandD);
              patchStyleVar(bandEl, '--sstep-fit-accent', s.colorVar);
              multiBandGroup.appendChild(bandEl);
            }

            const curveEl = document.createElementNS(SVG_NS, 'path');
            curveEl.setAttribute('class', 'sstep-fit-line');
            curveEl.setAttribute('fill', 'none');
            curveEl.setAttribute(
              'd',
              buildPolylinePath(gridPts.map((p) => ({ x: p.x, y: p.fitY })))
            );
            patchStyleVar(curveEl, '--sstep-fit-accent', s.colorVar);
            multiCurveGroup.appendChild(curveEl);
          }
        }
        for (const sp of anomalyOverlayDots) {
          const aDot = document.createElementNS(SVG_NS, 'circle');
          aDot.setAttribute('cx', sp.x.toFixed(1));
          aDot.setAttribute('cy', sp.rawY.toFixed(1));
          aDot.setAttribute('r', '2.9');
          aDot.setAttribute(
            'class',
            `sstep-scatter-dot is-anomaly${sp.anomalySeverity === 'danger' ? ' is-danger' : ''}`
          );
          scatterTarget.appendChild(aDot);
        }
        if (scatterTarget !== scatterGroup) {
          scatterGroup.appendChild(scatterTarget);
        }

        while (multiLegendEl.firstChild) multiLegendEl.removeChild(multiLegendEl.firstChild);
        for (const s of seriesList) {
          const swatch = h('span', { className: 'sstep-legend-line' });
          patchStyleVar(swatch, '--swatch-bg', s.colorVar);
          multiLegendEl.appendChild(
            h('span', { className: 'sstep-legend-item' }, [
              swatch,
              h('span', {
                text: `${s.label} (${formatChartMetricCompact(metric, s.pubFit.mean)})`,
              }),
            ])
          );
        }
      }

      const r2SummaryTitle = seriesList
        .map((s) => {
          const rSign = s.pubFit.r >= 0 ? '+' : '';
          return `${s.label}: n=${s.samples.length}, r=${rSign}${s.pubFit.r.toFixed(2)}, R²=${s.pubFit.r2.toFixed(2)}`;
        })
        .join(' | ');
      patchText(
        fitStatsEl,
        seriesList.length <= 2
          ? seriesList.map((s) => `R²=${s.pubFit.r2.toFixed(2)}`).join(' · ')
          : t('chart.fit.curvesCount', { count: seriesList.length })
      );
      patchAttr(fitStatsEl, 'title', r2SummaryTitle);

      if (hoveredIdx >= currentSamples.length) {
        clearHover();
      } else if (hoveredIdx >= 0) {
        showHoverAt(hoveredIdx);
      }

      return {
        sampleCount: combinedSamples.length,
        summaryBadge: t('chart.fit.multiBadge', {
          steps: combinedSamples.length,
          models: seriesList.length,
        }),
      };
    }

    // 分支 B：单模型或整体合并单曲线模式
    while (multiBandGroup.firstChild) multiBandGroup.removeChild(multiBandGroup.firstChild);
    while (multiCurveGroup.firstChild) multiCurveGroup.removeChild(multiCurveGroup.firstChild);
    patchAttr(singleLegendEl, 'hidden', false);
    patchAttr(multiLegendEl, 'hidden', true);

    const filtered = matchedItems;
    const xs = filtered.map((d) => d.xVal);
    const rawYs = filtered.map((d) => d.rawVal);
    const pubFit = reusePublicationFit(null, xs, rawYs, maxBound, false);

    patchText(
      fitMethodLabelEl,
      pubFit.method === 'LOESS' ? t('chart.fit.loess') : t('chart.fit.olsReg')
    );
    patchAttr(olsLegendWrapEl, 'hidden', filtered.length < 6);

    let dataMin = Infinity;
    let dataMax = -Infinity;
    for (let i = 0; i < filtered.length; i++) {
      if (rawYs[i] < dataMin) dataMin = rawYs[i];
      if (rawYs[i] > dataMax) dataMax = rawYs[i];
    }
    for (const g of pubFit.grid) {
      if (g.ciLow < dataMin) dataMin = g.ciLow;
      if (g.ciHigh > dataMax) dataMax = g.ciHigh;
    }

    const yScale = computeNiceYScale(dataMin, dataMax, {
      minBound,
      maxBound,
      tickCount: 4,
    });
    const yRange = Math.max(1e-9, yScale.max - yScale.min);
    const mapY = (v) =>
      BOTTOM_Y - ((clampValue(v, yScale.min, yScale.max) - yScale.min) / yRange) * SPAN_Y;

    const { plotLeft, plotRight, plotSpanX } = resolveFitBounds(viewW);
    const xMin = xs[0];
    const xMax = xs[xs.length - 1];
    const isSingle = filtered.length === 1 || xMax - xMin <= 1e-9;
    const mapX = (xv) =>
      isSingle
        ? (plotLeft + plotRight) / 2
        : plotLeft + ((xv - xMin) / (xMax - xMin)) * plotSpanX;

    const samples = filtered.map((item, i) => {
      const x = mapX(item.xVal);
      const rawY = mapY(item.rawVal);
      const fitVal = pubFit.sampleFits[i];
      const fitY = mapY(fitVal);
      return {
        ...item,
        x,
        rawY,
        fitVal,
        fitY,
        ciLow: pubFit.sampleCiLow[i],
        ciHigh: pubFit.sampleCiHigh[i],
        ciHalf: pubFit.sampleCiHalf[i],
        seriesColor: 'var(--accent-primary)',
        compareHint: '',
      };
    });
    currentSamples = samples;

    const sig =
      `single|${locale}|${viewW}|${targetKeys[0]}|${metric}|${showAgentPrefix}|${yScale.min.toFixed(4)}|${yScale.max.toFixed(4)}|` +
      samples
        .map(
          (s) => `${s.xVal}:${s.rawVal.toFixed(4)}:${s.fitVal.toFixed(4)}:${s.st?.anomalySig || ''}`
        )
        .join('|');

    if (sig !== lastSig) {
      lastSig = sig;
      renderFitAxesAndGrid({
        yScale,
        mapY,
        mapX,
        xs,
        isSingle,
        plotLeft,
        plotRight,
        metric,
        showAgentPrefix,
      });

      // 2. 绘制半透明冷蓝灰实心观测散点（自然呈现局部密度，不抢夺拟合曲线焦点）
      while (scatterGroup.firstChild) scatterGroup.removeChild(scatterGroup.firstChild);
      const dotRadius = samples.length > 80 ? '1.8' : samples.length > 36 ? '2.1' : '2.4';
      const binCounts = samples.length > 200 ? new Map() : null;
      const scatterTarget =
        typeof document.createDocumentFragment === 'function'
          ? document.createDocumentFragment()
          : scatterGroup;
      const singleAnomalyDots = [];
      for (const s of samples) {
        if (s.anomalySummary) {
          singleAnomalyDots.push(s);
          continue;
        }
        if (binCounts) {
          const binKey = (Math.round(s.x * 2) << 11) ^ Math.round(s.rawY * 2);
          const prevCnt = binCounts.get(binKey) || 0;
          if (prevCnt >= 6) continue;
          binCounts.set(binKey, prevCnt + 1);
        }
        const dot = document.createElementNS(SVG_NS, 'circle');
        dot.setAttribute('cx', s.x.toFixed(1));
        dot.setAttribute('cy', s.rawY.toFixed(1));
        dot.setAttribute('r', dotRadius);
        dot.setAttribute('class', 'sstep-scatter-dot');
        scatterTarget.appendChild(dot);
      }
      for (const s of singleAnomalyDots) {
        const aDot = document.createElementNS(SVG_NS, 'circle');
        aDot.setAttribute('cx', s.x.toFixed(1));
        aDot.setAttribute('cy', s.rawY.toFixed(1));
        aDot.setAttribute('r', '2.9');
        aDot.setAttribute(
          'class',
          `sstep-scatter-dot is-anomaly${s.anomalySeverity === 'danger' ? ' is-danger' : ''}`
        );
        scatterTarget.appendChild(aDot);
      }
      if (scatterTarget !== scatterGroup) {
        scatterGroup.appendChild(scatterTarget);
      }

      // 3. 绘制 95% CI 置信带闭合多边形与回归拟合曲线（绝不向底部 X 轴填充面积！）
      if (isSingle) {
        const yStr = samples[0].fitY.toFixed(1);
        patchAttr(fitPath, 'd', `M ${plotLeft.toFixed(1)} ${yStr} L ${plotRight.toFixed(1)} ${yStr}`);
        patchAttr(ciBandPath, 'd', '');
        patchAttr(olsLine, 'hidden', true);
      } else {
        const gridPts = pubFit.grid.map((g) => ({
          x: mapX(g.x),
          fitY: mapY(g.fit),
          lowY: mapY(g.ciLow),
          highY: mapY(g.ciHigh),
        }));

        patchAttr(
          fitPath,
          'd',
          buildPolylinePath(gridPts.map((p) => ({ x: p.x, y: p.fitY })))
        );

        if (samples.length >= 3) {
          let bandD = `M ${gridPts[0].x.toFixed(1)} ${gridPts[0].highY.toFixed(1)}`;
          for (let i = 1; i < gridPts.length; i++) {
            bandD += ` L ${gridPts[i].x.toFixed(1)} ${gridPts[i].highY.toFixed(1)}`;
          }
          for (let i = gridPts.length - 1; i >= 0; i--) {
            bandD += ` L ${gridPts[i].x.toFixed(1)} ${gridPts[i].lowY.toFixed(1)}`;
          }
          bandD += ' Z';
          patchAttr(ciBandPath, 'd', bandD);
        } else {
          patchAttr(ciBandPath, 'd', '');
        }

        const showOlsRef = samples.length >= 6;
        patchAttr(olsLine, 'hidden', !showOlsRef);
        if (showOlsRef) {
          const olsStartVal = clampValue(pubFit.intercept + pubFit.slope * xMin, minBound, maxBound);
          const olsEndVal = clampValue(pubFit.intercept + pubFit.slope * xMax, minBound, maxBound);
          patchAttr(olsLine, 'x1', plotLeft.toFixed(1));
          patchAttr(olsLine, 'y1', mapY(olsStartVal).toFixed(1));
          patchAttr(olsLine, 'x2', plotRight.toFixed(1));
          patchAttr(olsLine, 'y2', mapY(olsEndVal).toFixed(1));
        }
      }
    }

    const summaryBadge = t('chart.fit.singleBadge', {
      steps: samples.length,
      mean: formatChartMetricCompact(metric, pubFit.mean),
    });
    if (samples.length >= 2) {
      const rSign = pubFit.r >= 0 ? '+' : '';
      const slopeSign = pubFit.slope >= 0 ? '+' : '';
      patchText(fitStatsEl, `r = ${rSign}${pubFit.r.toFixed(2)} · R² = ${pubFit.r2.toFixed(2)}`);
      patchAttr(
        fitStatsEl,
        'title',
        t('chart.fit.olsTitle', {
          slope: `${slopeSign}${pubFit.slope.toFixed(3)}`,
          intercept: pubFit.intercept.toFixed(2),
          sd: pubFit.sd.toFixed(2),
        })
      );
    } else {
      patchText(fitStatsEl, `n = ${samples.length}`);
      patchAttr(fitStatsEl, 'title', '');
    }

    if (hoveredIdx >= samples.length) {
      clearHover();
    } else if (hoveredIdx >= 0) {
      showHoverAt(hoveredIdx);
    }

    return { sampleCount: samples.length, summaryBadge };
  }

  return { el: rootEl, update, destroy };
}
return { MODEL_COLOR_VARS, getStepModelGroupKey, toChronologicalSteps, computeLinearFit, computePublicationFit, createSessionLineChart, createModelFitChart };
})();

// --- src/registries/metricRegistry.js ---
const { CAPSULE_METRIC_KEYS, getCapsuleMetricOptions, getOverviewMetricOptions, resolveQuotaCapsuleSummary, resolveSpecificQuotaSlotSummary, resolveCapsuleMetricPresentation, resolveOverviewMetricCell } = (() => {
/**
 * @fileoverview Decoupled Metric Registry (`metricRegistry.js`).
 * Centralizes presentation & option metadata for:
 * 1. Topbar / Composer Capsule Slots (1..5 items out of 13 metrics)
 * 2. Live Overview / Hover First-Row Metric Matrix (1..4 items out of 9 metrics)
 */


const CAPSULE_METRIC_KEYS = TOPBAR_SLOT_KEYS;

function getCapsuleMetricOptions() {
  return CAPSULE_METRIC_KEYS.map((key) => ({
    value: key,
    label: t(`capMetric.${key}`),
  }));
}

function getOverviewMetricOptions() {
  return OVERVIEW_METRIC_KEYS.map((key) => ({
    value: key,
    label: t(`ovMetric.${key}`),
  }));
}

function resolveQuotaCapsuleSummary(quotas) {
  if (!quotas) return null;
  const activePool = quotas.activePool;
  const weekly = quotas.weekly;
  const pools = Array.isArray(quotas.pools) ? quotas.pools : [];
  const candidates = [];
  const defaultPoolName = isEnglishLocale() ? 'Active Pool' : '当前池';
  const wkTag = isEnglishLocale() ? 'Wk' : '周';

  if (activePool && Number.isFinite(Number(activePool.remainingPct))) {
    candidates.push({
      pct: Number(activePool.remainingPct),
      label: activePool.poolLabel || activePool.family || defaultPoolName,
      windowTag: '5h',
    });
  }
  if (activePool && Number.isFinite(Number(activePool.weeklyRemainingPct))) {
    candidates.push({
      pct: Number(activePool.weeklyRemainingPct),
      label: activePool.poolLabel || activePool.family || defaultPoolName,
      windowTag: wkTag,
    });
  }
  if (!candidates.length && weekly && Number.isFinite(Number(weekly.remainingPct))) {
    candidates.push({
      pct: Number(weekly.remainingPct),
      label: weekly.poolFamily || (isEnglishLocale() ? 'Weekly' : '周限额'),
      windowTag: wkTag,
    });
  }
  if (!candidates.length && pools.length > 0) {
    for (const p of pools) {
      const pLabel = p?.poolLabel || p?.family || defaultPoolName;
      if (p && Number.isFinite(Number(p.remainingPct))) {
        candidates.push({ pct: Number(p.remainingPct), label: pLabel, windowTag: '5h' });
      }
      if (p && Number.isFinite(Number(p.weeklyRemainingPct))) {
        candidates.push({ pct: Number(p.weeklyRemainingPct), label: pLabel, windowTag: wkTag });
      }
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.pct - b.pct);
  const tightest = candidates[0];
  const runnerUp = candidates.length > 1 ? candidates[1] : null;
  const rounded = Math.max(0, Math.min(100, Math.round(tightest.pct)));
  const runnerPct = runnerUp ? Math.max(0, Math.min(100, Math.round(runnerUp.pct))) : null;
  const subLabelText = runnerUp
    ? runnerUp.label === tightest.label
      ? `${tightest.label} ${tightest.windowTag} · ${runnerUp.windowTag} ${runnerPct}%`
      : `${tightest.label} ${tightest.windowTag} · ${runnerUp.label} ${runnerUp.windowTag} ${runnerPct}%`
    : `${tightest.label} · ${tightest.windowTag}`;
  return {
    roundedPct: rounded,
    shortText: t('capsule.quotaLeft', { pct: rounded }),
    subLabelText,
    detailText: candidates
      .map((c) => {
        const cPct = Math.max(0, Math.min(100, Math.round(c.pct)));
        return `${c.label} ${c.windowTag} ${t('capsule.quotaLeft', { pct: cPct })}`;
      })
      .join(' · '),
  };
}

/**
 * 解析指定模型池（Gemini 或 Claude & GPT）与指定时间窗口（5h 或周额度）的剩余百分比摘要。
 *
 * @param {object|null|undefined} quotas
 * @param {'gemini_5h'|'gemini_weekly'|'claude_5h'|'claude_weekly'} slotKey
 * @returns {{ roundedPct: number, shortText: string } | null}
 */
function resolveSpecificQuotaSlotSummary(quotas, slotKey) {
  const rounded = resolveCapsuleQuotaSlotPct(quotas, slotKey);
  if (rounded == null) return null;
  return {
    roundedPct: rounded,
    shortText: t('capsule.quotaLeft', { pct: rounded }),
  };
}

/**
 * 解析顶栏/输入框精简胶囊单槽位展示结构。
 *
 * @param {string} metricKey
 * @param {object} slotCtx
 * @param {number} ringCircumference
 */
function resolveCapsuleMetricPresentation(metricKey, slotCtx, ringCircumference) {
  if (!metricKey || metricKey === 'none') {
    return {
      hidden: true,
      metric: 'none',
      segClass: 'wm-cap-slot',
      textClass: 'wm-slot-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: '',
      toneClass: '',
      running: false,
      warn: false,
      danger: false,
    };
  }

  if (metricKey === 'context') {
    if (!slotCtx.hasTelemetry) {
      return {
        hidden: false,
        metric: 'context',
        segClass: 'wm-cap-slot wm-ctx-seg',
        textClass: 'wm-slot-text wm-ctx-pct',
        showRing: true,
        dashOffset: ringCircumference,
        text: '--%',
        toneClass: '',
        running: false,
        warn: false,
        danger: false,
      };
    }
    const isDanger = slotCtx.usedPct >= 88;
    const isWarn = !isDanger && slotCtx.usedPct >= 70;
    const toneClass = isDanger ? 'tone-danger' : isWarn ? 'tone-warn' : '';
    return {
      hidden: false,
      metric: 'context',
      segClass: 'wm-cap-slot wm-ctx-seg',
      textClass: 'wm-slot-text wm-ctx-pct',
      showRing: true,
      dashOffset: slotCtx.dashOffset,
      text: `${Math.round(slotCtx.usedPct)}%`,
      toneClass,
      running: false,
      warn: isWarn,
      danger: isDanger,
    };
  }

  if (metricKey === 'tps') {
    if (!slotCtx.hasTelemetry) {
      return {
        hidden: false,
        metric: 'tps',
        segClass: 'wm-cap-slot wm-seg-speed',
        textClass: 'wm-slot-text wm-speed-text',
        showRing: false,
        dashOffset: ringCircumference,
        text: '-- t/s',
        toneClass: '',
        running: false,
        warn: false,
        danger: false,
      };
    }
    const hasValidTps = Number.isFinite(slotCtx.tps) && slotCtx.tps > 0;
    const toneClass = hasValidTps ? getSpeedToneClass(slotCtx.tps) : '';
    const tpsText = hasValidTps
      ? `${slotCtx.tps >= 100 ? Math.round(slotCtx.tps) : slotCtx.tps.toFixed(1)} t/s`
      : slotCtx.isRunning
        ? t('capsule.tpsRunning')
        : t('capsule.tpsIdle');
    return {
      hidden: false,
      metric: 'tps',
      segClass: 'wm-cap-slot wm-seg-speed',
      textClass: 'wm-slot-text wm-speed-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: tpsText,
      toneClass,
      running: Boolean(slotCtx.isRunning),
      warn: toneClass === 'tone-warn',
      danger: toneClass === 'tone-danger',
    };
  }

  if (metricKey === 'avg_tps') {
    const avgVal = slotCtx.hasTelemetry ? slotCtx.avgTps : null;
    const valid = Number.isFinite(avgVal) && avgVal > 0;
    const toneClass = valid ? getSpeedToneClass(avgVal) : '';
    return {
      hidden: false,
      metric: 'avg_tps',
      segClass: 'wm-cap-slot wm-seg-speed',
      textClass: 'wm-slot-text wm-speed-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: valid ? `${avgVal >= 100 ? Math.round(avgVal) : avgVal.toFixed(1)} t/s` : '-- t/s',
      toneClass,
      running: false,
      warn: toneClass === 'tone-warn',
      danger: toneClass === 'tone-danger',
    };
  }

  if (metricKey === 'ttft') {
    const val = slotCtx.hasTelemetry ? slotCtx.ttft : null;
    const valid = val != null && Number.isFinite(Number(val)) && Number(val) >= 0;
    const numVal = valid ? Number(val) : 0;
    const toneClass = valid ? getTtftToneClass(numVal) : '';
    return {
      hidden: false,
      metric: 'ttft',
      segClass: 'wm-cap-slot wm-seg-ttft',
      textClass: 'wm-slot-text wm-ttft-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: valid ? formatCompactCapsuleTtft(numVal) : '--s',
      toneClass,
      running: false,
      warn: toneClass === 'tone-warn',
      danger: toneClass === 'tone-danger',
    };
  }

  if (metricKey === 'cost' || metricKey === 'session_cost') {
    const costVal = !slotCtx.hasTelemetry
      ? null
      : metricKey === 'session_cost'
        ? slotCtx.sessionCost
        : slotCtx.stepCost;
    const toneClass =
      metricKey === 'cost' && slotCtx.hasTelemetry && costVal != null
        ? getStepCostToneClass(costVal)
        : '';
    return {
      hidden: false,
      metric: metricKey,
      segClass: 'wm-cap-slot wm-seg-cost',
      textClass: 'wm-slot-text wm-cost-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: slotCtx.hasTelemetry ? formatCompactCapsuleCost(costVal) : '--',
      toneClass,
      running: false,
      warn: toneClass === 'tone-warn',
      danger: toneClass === 'tone-danger',
    };
  }

  if (metricKey === 'cache_hit') {
    const cachePct = slotCtx.hasTelemetry ? slotCtx.cacheHitPct : null;
    const valid = cachePct != null && Number.isFinite(Number(cachePct));
    const numVal = valid ? Number(cachePct) : 0;
    const toneClass = valid ? getCacheToneClass(numVal, slotCtx.latestPromptTokens) : '';
    return {
      hidden: false,
      metric: 'cache_hit',
      segClass: 'wm-cap-slot wm-seg-cache',
      textClass: 'wm-slot-text wm-cache-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: valid ? `${Math.round(numVal)}%` : '--%',
      toneClass,
      running: false,
      warn: toneClass === 'tone-warn',
      danger: toneClass === 'tone-danger',
    };
  }

  if (metricKey === 'session_tokens') {
    const tokVal = slotCtx.hasTelemetry ? slotCtx.sessionTokens : null;
    const valid = tokVal != null && Number.isFinite(Number(tokVal)) && Number(tokVal) >= 0;
    return {
      hidden: false,
      metric: 'session_tokens',
      segClass: 'wm-cap-slot wm-seg-tokens',
      textClass: 'wm-slot-text wm-tokens-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: valid ? formatTokens(Number(tokVal)) : '--',
      toneClass: '',
      running: false,
      warn: false,
      danger: false,
    };
  }

  const quotaSum = !slotCtx.hasTelemetry
    ? null
    : metricKey === 'quota_auto'
      ? resolveQuotaCapsuleSummary(slotCtx.quotas)
      : resolveSpecificQuotaSlotSummary(slotCtx.quotas, metricKey);
  const isDanger = Boolean(quotaSum && quotaSum.roundedPct <= 15);
  const isWarn = Boolean(quotaSum && !isDanger && quotaSum.roundedPct <= 30);
  const toneClass = isDanger ? 'tone-danger' : isWarn ? 'tone-warn' : '';
  return {
    hidden: false,
    metric: metricKey,
    segClass: 'wm-cap-slot wm-seg-quota',
    textClass: 'wm-slot-text wm-quota-text',
    showRing: false,
    dashOffset: ringCircumference,
    text: quotaSum ? quotaSum.shortText : t('capsule.quotaUnknown'),
    toneClass,
    running: false,
    warn: isWarn,
    danger: isDanger,
  };
}

function resolveActiveBadgeText(active) {
  if (!active?.activeAgentBadge && !active?.activeAgentKind) return '';
  return formatAgentBadgeText({
    agentKind:
      active.activeAgentKind ||
      (!active.activeAgentId || active.activeAgentId === 'main' ? 'main' : 'subagent'),
    agentOrdinal: Number(active.activeAgentOrdinal || 0),
    isMain: !active.activeAgentId || active.activeAgentId === 'main',
    badgeText: active.activeAgentBadge,
  });
}

/**
 * 解析实时监控第一行矩阵单个单元格的展示数据。
 *
 * @param {string} metricKey
 * @param {{ active?: object, ctx?: object, quotas?: object, settings?: object, hasSubagents?: boolean }} cellCtx
 */
function resolveOverviewMetricCell(metricKey, cellCtx = {}) {
  const active = cellCtx.active || {};
  const ctx = cellCtx.ctx || active.context || {};
  const quotas = cellCtx.quotas || {};
  const settings = cellCtx.settings || {};
  const hasSubagents = Boolean(cellCtx.hasSubagents);
  const hasAnySteps = Number(active.stepCount || 0) > 0;

  if (metricKey === 'tps') {
    const activeModelDisplay = resolveModelDisplayInfo(active, settings, {
      fallback: t('fmt.unknownModel'),
    }).text;
    const reason = speedReasonText(active.latestSpeedReason);
    const badgeStr = resolveActiveBadgeText(active);
    const modelAndAgent =
      hasSubagents && badgeStr ? `[${badgeStr}] ${activeModelDisplay}` : activeModelDisplay;
    const hasSpeed = Number.isFinite(active.latestTokPerSec) && Number(active.latestTokPerSec) > 0;
    const speedTone = hasAnySteps && hasSpeed ? getSpeedToneClass(active.latestTokPerSec) : '';
    return {
      key: 'tps',
      label: t('ovMetric.tps'),
      icon: 'dot',
      iconSize: 10,
      isPulsing: Boolean(active.isRunning),
      valueText: formatMetric(active.latestTokPerSec, ' tok/s'),
      valueClass: speedTone ? `cell-value ${speedTone}` : 'cell-value',
      subText: reason
        ? !hasSpeed
          ? `${reason} · ${modelAndAgent}`
          : `${modelAndAgent} · ${reason}`
        : modelAndAgent,
      subClass: 'cell-sub',
    };
  }

  if (metricKey === 'ttft') {
    const ttftTone = hasAnySteps ? getTtftToneClass(active.latestTtftSec) : '';
    return {
      key: 'ttft',
      label: t('ovMetric.ttft'),
      icon: 'clock',
      iconSize: 11,
      isPulsing: false,
      valueText: formatMetric(active.latestTtftSec, 's'),
      valueClass: ttftTone ? `cell-value ${ttftTone}` : 'cell-value',
      subText: t('ovMetric.subAvgTtft', {
        val: formatMetric(active.ttftSummary?.avgSec, 's'),
      }),
      subClass: 'cell-sub',
    };
  }

  if (metricKey === 'avg_tps') {
    const hasAvgSpeed = Number.isFinite(active.avgTokPerSec) && Number(active.avgTokPerSec) > 0;
    const avgSpeedTone = hasAnySteps && hasAvgSpeed ? getSpeedToneClass(active.avgTokPerSec) : '';
    return {
      key: 'avg_tps',
      label: t('ovMetric.avg_tps'),
      icon: 'pulse',
      iconSize: 11,
      isPulsing: false,
      valueText: formatMetric(active.avgTokPerSec, ' tok/s'),
      valueClass: avgSpeedTone ? `cell-value ${avgSpeedTone}` : 'cell-value',
      subText: t('ovMetric.subValidSamples', {
        samples: sampleSummary(active.speedSummary),
      }),
      subClass: 'cell-sub',
    };
  }

  if (metricKey === 'step_cost' || metricKey === 'session_cost') {
    const stepCost = active.latestStepCostUsd;
    const sessCost = Number(active.sessionCostUsd || 0);
    const stepCnt = Number(active.stepCount || 0);
    const isAllUnpriced =
      stepCnt > 0 && Number(active.sessionUnpricedCalls || 0) >= stepCnt && !(sessCost > 0);
    const stepCostText =
      !hasAnySteps && stepCost == null ? '—' : formatUsd(stepCost, { precise: true });
    const totalCostText =
      !hasAnySteps && active.sessionCostUsd == null
        ? '—'
        : formatUsd(isAllUnpriced ? null : sessCost, {
            precise: sessCost > 0 && sessCost < 0.1,
          });

    if (metricKey === 'step_cost') {
      const costTone = hasAnySteps ? getStepCostToneClass(stepCost) : '';
      return {
        key: 'step_cost',
        label: t('ovMetric.step_cost'),
        icon: 'bolt',
        iconSize: 11,
        isPulsing: false,
        valueText: stepCostText,
        valueClass: costTone ? `cell-value ${costTone}` : 'cell-value',
        subText: t('ovMetric.subTotalCost', { cost: totalCostText }),
        subClass: 'cell-sub',
      };
    }

    return {
      key: 'session_cost',
      label: t('ovMetric.session_cost'),
      icon: 'bolt',
      iconSize: 11,
      isPulsing: false,
      valueText: totalCostText,
      valueClass: 'cell-value',
      subText: t('ovMetric.subStepCost', { cost: stepCostText }),
      subClass: 'cell-sub',
    };
  }

  if (metricKey === 'cache_hit') {
    const latestCache = active.latestCacheHitPct;
    const avgCache = active.sessionCacheHitPct ?? active.latestCacheHitPct;
    const hasLatest = hasAnySteps && latestCache != null && Number.isFinite(Number(latestCache));
    const hasAvg = hasAnySteps && avgCache != null && Number.isFinite(Number(avgCache));
    const cacheTone = hasLatest ? getCacheToneClass(latestCache, active.latestPromptTokens) : '';
    return {
      key: 'cache_hit',
      label: t('ovMetric.cache_hit'),
      icon: 'layers',
      iconSize: 11,
      isPulsing: false,
      valueText: hasLatest ? formatCachePct(latestCache) : '—',
      valueClass: cacheTone ? `cell-value ${cacheTone}` : 'cell-value',
      subText: t('ovMetric.subAvgCache', {
        val: hasAvg ? formatCachePct(avgCache) : '—',
      }),
      subClass: 'cell-sub',
    };
  }

  if (metricKey === 'session_tokens') {
    const inTok = Math.max(0, Number(active.inputTokens || 0));
    const cacheTok = Math.max(0, Number(active.cacheReadTokens || 0));
    const outTok = Math.max(0, Number(active.outputTokens || 0));
    const totalTok = Math.max(0, Number(active.totalTokens ?? inTok + cacheTok + outTok));
    return {
      key: 'session_tokens',
      label: t('ovMetric.session_tokens'),
      icon: 'chart-bar',
      iconSize: 11,
      isPulsing: false,
      valueText: !hasAnySteps && !totalTok ? '—' : formatTokens(totalTok),
      valueClass: 'cell-value',
      subText: t('ovMetric.subInOutTokens', {
        inTok: formatTokens(inTok + cacheTok),
        outTok: formatTokens(outTok),
      }),
      subClass: 'cell-sub',
    };
  }

  if (metricKey === 'context_usage') {
    const limitTokens = Number(ctx.compactionLimitTokens || ctx.limitTokens || 256000);
    const totalTokens = Number(ctx.totalTokens || 0);
    const usedPct =
      limitTokens > 0 ? Math.min(100, +((totalTokens / limitTokens) * 100).toFixed(1)) : 0;
    const toneCls =
      usedPct >= 88
        ? 'cell-value tone-danger'
        : usedPct >= 70
          ? 'cell-value tone-warn'
          : 'cell-value';
    return {
      key: 'context_usage',
      label: t('ovMetric.context_usage'),
      icon: 'layers',
      iconSize: 11,
      isPulsing: false,
      valueText: `${usedPct}%`,
      valueClass: toneCls,
      subText: t('ovMetric.subCtxRatio', {
        used: formatTokens(totalTokens),
        limit: formatTokens(limitTokens),
      }),
      subClass: 'cell-sub',
    };
  }

  const quotaSum = resolveQuotaCapsuleSummary(quotas);
  const quotaToneCls =
    quotaSum && quotaSum.roundedPct <= 15
      ? 'cell-value tone-danger'
      : quotaSum && quotaSum.roundedPct <= 30
        ? 'cell-value tone-warn'
        : 'cell-value';
  return {
    key: 'quota_tightest',
    label: t('ovMetric.quota_tightest'),
    icon: 'pulse',
    iconSize: 11,
    isPulsing: false,
    valueText: quotaSum ? quotaSum.shortText : '—',
    valueClass: quotaToneCls,
    subText: quotaSum
      ? t('ovMetric.subQuotaPool', { label: quotaSum.subLabelText })
      : t('ovMetric.subQuotaPending'),
    subClass: 'cell-sub',
  };
}
return { CAPSULE_METRIC_KEYS, getCapsuleMetricOptions, getOverviewMetricOptions, resolveQuotaCapsuleSummary, resolveSpecificQuotaSlotSummary, resolveCapsuleMetricPresentation, resolveOverviewMetricCell };
})();

// --- src/components/widgets/MetricMatrixWidget.js ---
const { MetricMatrixWidget } = (() => {
/**
 * @fileoverview Standalone decoupled Metric Matrix Widget (`MetricMatrixWidget.js`).
 * Renders 1..4 user-selected telemetry cells dynamically via `metricRegistry.js`.
 */


const MetricMatrixWidget = defineComponent({
  name: 'MetricMatrixWidget',
  setup({ props }) {
    const getCtxAgentId =
      typeof props?.getCtxAgentId === 'function'
        ? props.getCtxAgentId
        : () => uiStore.getState().ctxInspectorAgentId;
    const matrixEl = h('section', {
      className: 'telemetry-matrix',
      'aria-label': t('module.metrics'),
      'data-cols': '4',
    });
    patchStyleVar(matrixEl, '--matrix-cols', '4');

    function createMetricCellNode() {
      const labelSpan = h('span', { text: '—' });
      const iconSvg = createSvgIcon('pulse', { size: 11 });
      const valueEl = h('strong', { className: 'cell-value', text: '—' });
      const subEl = h('span', { className: 'cell-sub', text: '—' });
      const el = h('div', { className: 'matrix-cell' }, [
        h('div', { className: 'cell-label' }, [labelSpan, iconSvg]),
        valueEl,
        subEl,
      ]);
      return {
        el,
        refs: { labelSpan, iconSvg, valueEl, subEl },
      };
    }

    function update({ data } = {}) {
      patchAttr(matrixEl, 'aria-label', t('module.metrics'));
      const metricKeys = normalizeClientOverviewMetrics(data?.settings?.overviewMetrics);
      const colCount = Math.max(1, Math.min(4, metricKeys.length));
      patchAttr(matrixEl, 'data-cols', String(colCount));
      patchStyleVar(matrixEl, '--matrix-cols', String(colCount));

      const { hasSubagents, scopedConv, ctxAgent } = resolveScopedConversation(
        data,
        'all',
        getCtxAgentId()
      );
      const active = scopedConv || data?.activeConversation || {};
      const ctx = ctxAgent?.context || active.context || {};
      const quotas = data?.quotas || {};
      const settings = data?.settings || {};
      const locale = getEffectiveLocale();

      const cells = metricKeys.map((key) =>
        resolveOverviewMetricCell(key, {
          active,
          ctx,
          quotas,
          settings,
          hasSubagents,
        })
      );

      patchKeyedList(matrixEl, cells, {
        keyFn: (cell) => cell.key,
        sigFn: (cell) =>
          `${locale}:${cell.key}:${cell.label}:${cell.icon}:${cell.isPulsing}:${cell.valueClass}:${cell.valueText}:${cell.subClass}:${cell.subText}`,
        createRow: createMetricCellNode,
        updateRow: (refs, cell) => {
          patchText(refs.labelSpan, cell.label);
          patchSvgIcon(refs.iconSvg, cell.icon);
          refs.iconSvg.setAttribute('width', String(cell.iconSize));
          refs.iconSvg.setAttribute('height', String(cell.iconSize));
          patchClasses(refs.iconSvg, { 'is-pulsing': Boolean(cell.isPulsing) });
          patchAttr(refs.valueEl, 'class', cell.valueClass);
          patchText(refs.valueEl, cell.valueText);
          patchAttr(refs.subEl, 'class', cell.subClass);
          patchText(refs.subEl, cell.subText);
        },
      });
    }

    // Initialize default 4-cell skeleton so hover/overview has zero initial height jump
    update({ data: null });

    return {
      el: matrixEl,
      refs: { update },
    };
  },
});
return { MetricMatrixWidget };
})();

// --- src/components/widgets/ContextWindowWidget.js ---
const { CTX_CHANNEL_DEFS, ContextWindowWidget } = (() => {
/**
 * @fileoverview Standalone decoupled Context Window Widget (`ContextWindowWidget.js`).
 * Supports both interactive multi-agent inspector mode (`LiveOverviewView`)
 * and pointer-events-none in-place pre-allocated mode (`WindowOverlayShell` hover popup).
 */


const CTX_PILL_BASE_PAD_PX = 14;
const CTX_CJK_CHAR_PX = 11;
const CTX_ASCII_CHAR_PX = 6.1;
const CTX_PILL_GAP_PX = 4;
const CTX_DEFAULT_BAR_WIDTH_PX = 310;

function estimateCtxPillWidth(text, withChevron = false) {
  let w = CTX_PILL_BASE_PAD_PX + (withChevron ? 14 : 0);
  for (const ch of String(text || '')) {
    w += ch.charCodeAt(0) > 255 ? CTX_CJK_CHAR_PX : CTX_ASCII_CHAR_PX;
  }
  return Math.ceil(w);
}

/**
 * 10 通道上下文窗口构成定义（通过动态 getter 自动跟随当前激活语言）。
 */
const CTX_CHANNEL_DEFS = [
  {
    key: 'assistant',
    labelKey: 'ctx.ch.assistant',
    titleKey: 'ctx.ch.assistantTitle',
    get label() {
      return t(this.labelKey);
    },
    get title() {
      return t(this.titleKey);
    },
    segClass: 'seg-assistant',
    getValue: (c) => Number(c.assistantTokens || 0),
  },
  {
    key: 'toolResults',
    labelKey: 'ctx.ch.toolResults',
    titleKey: 'ctx.ch.toolResultsTitle',
    get label() {
      return t(this.labelKey);
    },
    get title() {
      return t(this.titleKey);
    },
    segClass: 'seg-tool-results',
    getValue: (c) => Number(c.toolResultsTokens || 0),
  },
  {
    key: 'userInput',
    labelKey: 'ctx.ch.userInput',
    titleKey: 'ctx.ch.userInputTitle',
    get label() {
      return t(this.labelKey);
    },
    get title() {
      return t(this.titleKey);
    },
    segClass: 'seg-user-input',
    getValue: (c) => Number(c.userInputTokens ?? c.messagesTokens ?? 0),
  },
  {
    key: 'subagent',
    labelKey: 'ctx.ch.subagent',
    titleKey: 'ctx.ch.subagentTitle',
    get label() {
      return t(this.labelKey);
    },
    get title() {
      return t(this.titleKey);
    },
    segClass: 'seg-subagent-msg',
    getValue: (c) => Number(c.subagentTokens || 0),
  },
  {
    key: 'checkpoint',
    labelKey: 'ctx.ch.checkpoint',
    titleKey: 'ctx.ch.checkpointTitle',
    get label() {
      return t(this.labelKey);
    },
    get title() {
      return t(this.titleKey);
    },
    segClass: 'seg-checkpoint',
    getValue: (c) => Number(c.checkpointTokens || 0),
  },
  {
    key: 'systemPrompt',
    labelKey: 'ctx.ch.systemPrompt',
    titleKey: 'ctx.ch.systemPromptTitle',
    get label() {
      return t(this.labelKey);
    },
    get title() {
      return t(this.titleKey);
    },
    segClass: 'seg-system-prompt',
    getValue: (c) => Number(c.systemPromptTokens || 0),
  },
  {
    key: 'systemTools',
    labelKey: 'ctx.ch.systemTools',
    titleKey: 'ctx.ch.systemToolsTitle',
    get label() {
      return t(this.labelKey);
    },
    get title() {
      return t(this.titleKey);
    },
    segClass: 'seg-system-tools',
    getValue: (c) => Number(c.systemToolsTokens || 0),
  },
  {
    key: 'mcpTools',
    labelKey: 'ctx.ch.mcpTools',
    titleKey: 'ctx.ch.mcpToolsTitle',
    get label() {
      return t(this.labelKey);
    },
    get title() {
      return t(this.titleKey);
    },
    segClass: 'seg-mcp-tools',
    getValue: (c) => Number(c.mcpToolsTokens || 0),
  },
  {
    key: 'skills',
    labelKey: 'ctx.ch.skills',
    titleKey: 'ctx.ch.skillsTitle',
    get label() {
      return t(this.labelKey);
    },
    get title() {
      return t(this.titleKey);
    },
    segClass: 'seg-skills',
    getValue: (c) => Number(c.skillsTokens || 0),
  },
  {
    key: 'userRules',
    labelKey: 'ctx.ch.userRules',
    titleKey: 'ctx.ch.userRulesTitle',
    get label() {
      return t(this.labelKey);
    },
    get title() {
      return t(this.titleKey);
    },
    segClass: 'seg-user-rules',
    getValue: (c) => Number(c.userRulesTokens || 0),
  },
];

const ContextWindowWidget = defineComponent({
  name: 'ContextWindowWidget',
  setup({ props, onCleanup }) {
    const interactiveInspector = props.interactiveInspector !== false;
    const getCtxAgentId =
      typeof props.getCtxAgentId === 'function'
        ? props.getCtxAgentId
        : () => uiStore.getState().ctxInspectorAgentId;
    const setCtxAgentId =
      typeof props.setCtxAgentId === 'function'
        ? props.setCtxAgentId
        : (nextId) => uiStore.setState({ ctxInspectorAgentId: nextId });
    const isVisibleFn =
      typeof props.isVisibleFn === 'function' ? props.isVisibleFn : () => true;

    const titleTextEl = h('span', { text: t('module.context') });
    const ctxAgentBadge = h('span', {
      className: 'agent-badge badge-main',
      hidden: true,
      text: t('fmt.mainAgent'),
    });
    const ctxSummaryText = h('span', { className: 'text-mono', text: '0 / 256.0k (0%)' });
    const ctxSegmentBar = ContextSegmentMeter({ context: {} });

    const ctxPillGroup = h('div', { className: 'ctx-pill-group' });
    const ctxInspectorBar = h(
      'div',
      { className: 'ctx-inspector-bar', hidden: true },
      [ctxPillGroup]
    );

    const ctxChannels = CTX_CHANNEL_DEFS.map((ch, idx) => {
      const swatchEl = h('span', { className: `swatch ${ch.segClass}` });
      const labelEl = h('span', { text: ch.label });
      const valEl = h('strong', { className: 'text-mono', text: '0' });
      const itemEl = h(
        'div',
        { className: 'legend-item', ...(interactiveInspector ? { title: ch.title } : {}) },
        [h('span', { className: 'legend-left' }, [swatchEl, labelEl]), valEl]
      );
      return { ch, defaultOrder: idx, swatchEl, labelEl, valEl, itemEl };
    });

    const ctxLegendGrid = h(
      'div',
      { className: 'ctx-legend-grid' },
      ctxChannels.map((entry) => entry.itemEl)
    );
    let lastLegendOrderSig = ctxChannels.map((entry) => entry.ch.key).join(',');
    let lastLocale = getEffectiveLocale();

    const children = [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('layers', { size: 13 }),
          titleTextEl,
          ctxAgentBadge,
        ]),
        h('span', { className: 'panel-meta' }, [ctxSummaryText]),
      ]),
    ];
    if (interactiveInspector) {
      children.push(ctxInspectorBar);
    }
    children.push(ctxSegmentBar.el, ctxLegendGrid);

    const ctxPanel = h('section', { className: 'panel' }, children);

    let latestData = null;
    let ctxPillsExpanded = false;
    let isCollapsingCtxPills = false;
    let ctxCollapseTimer = null;
    let lastCascadeId = '';
    let cachedBarWidth = 0;

    function clearCtxExpandAnim() {
      if (ctxCollapseTimer) {
        clearTimeout(ctxCollapseTimer);
        ctxCollapseTimer = null;
      }
      isCollapsingCtxPills = false;
      ctxInspectorBar.ontransitionend = null;
      ctxInspectorBar.style.height = '';
      ctxInspectorBar.style.overflow = '';
      ctxInspectorBar.style.transition = '';
      for (const child of ctxPillGroup.children) {
        child.onanimationend = null;
        patchClasses(child, {
          'is-pill-entering': false,
          'is-pill-collapsing': false,
        });
      }
    }

    function update({ data } = {}) {
      latestData = data || null;
      const curLocale = getEffectiveLocale();
      patchText(titleTextEl, t('module.context'));

      if (!data) {
        if (curLocale !== lastLocale) {
          lastLocale = curLocale;
          for (const entry of ctxChannels) {
            patchText(entry.labelEl, entry.ch.label);
            if (interactiveInspector) {
              patchAttr(entry.itemEl, 'title', entry.ch.title);
            }
          }
        }
        return;
      }

      let availRowWidth = CTX_DEFAULT_BAR_WIDTH_PX;
      if (interactiveInspector) {
        const measuredWidth =
          ctxInspectorBar.clientWidth || (ctxPanel.clientWidth ? ctxPanel.clientWidth - 24 : 0);
        if (measuredWidth > 160) {
          cachedBarWidth = measuredWidth;
        }
        availRowWidth = cachedBarWidth > 160 ? cachedBarWidth : CTX_DEFAULT_BAR_WIDTH_PX;

        const currentCascadeId = data.activeConversation?.cascadeId || '';
        if (currentCascadeId && currentCascadeId !== lastCascadeId) {
          if (lastCascadeId) {
            clearCtxExpandAnim();
            ctxPillsExpanded = false;
          }
          lastCascadeId = currentCascadeId;
        }
      }

      const {
        hasSubagents,
        effectiveCtxScope,
        agents,
        aggregated,
        scopedConv,
        ctxAgent,
      } = resolveScopedConversation(data, 'all', getCtxAgentId());

      const active = scopedConv || data.activeConversation || {};
      const ctx = ctxAgent?.context || active.context || {};

      patchAttr(ctxAgentBadge, 'hidden', !(hasSubagents && ctxAgent));
      if (hasSubagents && ctxAgent) {
        const badgeCls = getAgentBadgeClass(ctxAgent.index || 0, Boolean(ctxAgent.isMain));
        patchAttr(ctxAgentBadge, 'class', `agent-badge ${badgeCls}`);
        const badgeFullText = formatAgentLabel(ctxAgent);
        patchText(ctxAgentBadge, badgeFullText);
        if (interactiveInspector) {
          patchAttr(ctxAgentBadge, 'title', badgeFullText);
        }
      }

      if (interactiveInspector) {
        patchAttr(ctxInspectorBar, 'hidden', !hasSubagents);
        if (!hasSubagents && isCollapsingCtxPills) {
          clearCtxExpandAnim();
        }
        if (hasSubagents && ctxAgent && !isCollapsingCtxPills) {
          const activeBadgeText = formatAgentBadgeText({
            agentKind:
              aggregated?.activeAgentKind ||
              (!aggregated?.activeAgentId || aggregated.activeAgentId === 'main'
                ? 'main'
                : 'subagent'),
            agentOrdinal: Number(aggregated?.activeAgentOrdinal || 0),
            isMain: !aggregated?.activeAgentId || aggregated.activeAgentId === 'main',
            badgeText: aggregated?.activeAgentBadge,
          });

          const pillItems = [
            {
              key: 'auto',
              label: t('ctx.followActive', { badge: activeBadgeText }),
              title: t('ctx.followActiveTitle'),
              isActive: effectiveCtxScope === 'auto',
              mode: 'ctx-only',
            },
          ];

          const allAgentPills = agents.map((ag) => {
            const agPct = ag.context?.usedPct ?? 0;
            const agModelDisplay = resolveModelDisplayInfo(ag, data.settings, {
              fallback: t('fmt.unknownModel'),
            }).text;
            const badgeLabel = formatAgentBadgeText(ag);
            return {
              key: ag.agentId,
              label: `${badgeLabel} ${agPct}%`,
              title: `${formatAgentLabel(ag)} (${agModelDisplay} · ${t('header.convMetaSteps', { count: ag.stepCount || 0 })})`,
              isActive: effectiveCtxScope === ag.agentId,
              mode: 'ctx-only',
            };
          });

          const firstPillWidth =
            pillItems.length > 0 ? estimateCtxPillWidth(pillItems[0].label) : 0;
          const totalAllWidth = allAgentPills.reduce(
            (sum, p) => sum + CTX_PILL_GAP_PX + estimateCtxPillWidth(p.label),
            firstPillWidth
          );
          const needsCollapse = totalAllWidth > availRowWidth && allAgentPills.length > 2;

          if (needsCollapse && !ctxPillsExpanded) {
            const toggleSample = t('ctx.expandMore', { count: allAgentPills.length });
            const toggleReservePx = CTX_PILL_GAP_PX + estimateCtxPillWidth(toggleSample, true);
            let usedW = firstPillWidth;
            let fitCount = 0;
            for (let i = 0; i < allAgentPills.length; i += 1) {
              const pw = CTX_PILL_GAP_PX + estimateCtxPillWidth(allAgentPills[i].label);
              if (fitCount >= 1 && usedW + pw + toggleReservePx > availRowWidth) {
                break;
              }
              usedW += pw;
              fitCount += 1;
            }
            const maxKeep = Math.max(1, allAgentPills.length - 2);
            const maxCollapsedCount = Math.max(1, Math.min(maxKeep, fitCount));
            const visibleAgentPills = allAgentPills.slice(0, maxCollapsedCount);
            const activeHiddenPill = allAgentPills
              .slice(maxCollapsedCount)
              .find((p) => p.isActive);
            if (activeHiddenPill) {
              if (visibleAgentPills.length >= 2) {
                visibleAgentPills[visibleAgentPills.length - 1] = activeHiddenPill;
              } else {
                visibleAgentPills.push(activeHiddenPill);
              }
            }
            const hiddenCount = allAgentPills.length - visibleAgentPills.length;
            pillItems.push(...visibleAgentPills, {
              key: '__toggle_more__',
              label: t('ctx.expandMore', { count: hiddenCount }),
              title: t('ctx.expandMoreTitle', { count: allAgentPills.length - 1 }),
              isActive: false,
              isMoreToggle: true,
              isExpanded: false,
              mode: 'toggle-expand',
            });
          } else {
            pillItems.push(...allAgentPills);
            if (needsCollapse) {
              pillItems.push({
                key: '__toggle_more__',
                label: t('ctx.collapse'),
                title: t('ctx.collapseTitle'),
                isActive: false,
                isMoreToggle: true,
                isExpanded: true,
                mode: 'toggle-expand',
              });
            }
          }

          patchKeyedList(ctxPillGroup, pillItems, {
            keyFn: (item) => item.key,
            sigFn: (item) =>
              `${item.key}:${item.label}:${item.isActive}:${item.isMoreToggle}:${Boolean(item.isExpanded)}:${item.mode}:${item.title}`,
            createRow: () => {
              const labelSpan = h('span', { className: 'ctx-pill-label' });
              const chevronEl = createSvgIcon('chevron-down', {
                size: 11,
                className: 'ctx-toggle-chevron',
              });
              patchAttr(chevronEl, 'hidden', true);
              const btn = h('button', { type: 'button', className: 'ctx-agent-pill' }, [
                labelSpan,
                chevronEl,
              ]);
              return { el: btn, refs: { btn, labelSpan, chevronEl } };
            },
            updateRow: (refs, item) => {
              patchText(refs.labelSpan, item.label);
              patchAttr(refs.chevronEl, 'hidden', !item.isMoreToggle);
              patchAttr(refs.btn, 'title', item.title);
              patchAttr(refs.btn, 'data-pill-key', item.key);
              patchClasses(refs.btn, {
                'is-active': item.isActive,
                'is-more-toggle': Boolean(item.isMoreToggle),
                'is-expanded': Boolean(item.isExpanded),
                'is-pill-collapsing': false,
              });
              refs.btn.onclick = () => {
                if (item.mode === 'toggle-expand') {
                  const modern = isModernUiActiveForElement(ctxPanel);
                  const startH = Number(ctxInspectorBar.offsetHeight || 0);
                  clearCtxExpandAnim();
                  if (!modern || !(startH > 0)) {
                    ctxPillsExpanded = !ctxPillsExpanded;
                    if (latestData) update({ data: latestData });
                    return;
                  }

                  if (!ctxPillsExpanded) {
                    const prevKeys = new Set(
                      Array.from(ctxPillGroup.children, (el) => el.getAttribute?.('data-pill-key') || '')
                    );
                    ctxPillsExpanded = true;
                    if (latestData) update({ data: latestData });
                    const endH = Number(ctxPillGroup.offsetHeight || 0);
                    for (const child of ctxPillGroup.children) {
                      const k = child.getAttribute?.('data-pill-key') || '';
                      if (k && k !== '__toggle_more__' && !prevKeys.has(k)) {
                        patchClasses(child, { 'is-pill-entering': true });
                        child.onanimationend = () => {
                          child.onanimationend = null;
                          patchClasses(child, { 'is-pill-entering': false });
                        };
                      }
                    }
                    if (endH > startH + 1) {
                      ctxInspectorBar.style.height = `${startH}px`;
                      ctxInspectorBar.style.overflow = 'hidden';
                      void ctxInspectorBar.offsetHeight;
                      ctxInspectorBar.style.transition =
                        'height 220ms cubic-bezier(0.16, 1, 0.3, 1)';
                      ctxInspectorBar.style.height = `${endH}px`;
                      const finishExpand = () => clearCtxExpandAnim();
                      ctxInspectorBar.ontransitionend = (ev) => {
                        if (
                          ev?.target === ctxInspectorBar &&
                          (!ev.propertyName || ev.propertyName === 'height')
                        ) {
                          finishExpand();
                        }
                      };
                      ctxCollapseTimer = setTimeout(finishExpand, 260);
                    }
                  } else {
                    const firstPill = ctxPillGroup.children[0] || null;
                    const firstTop = Number(firstPill?.offsetTop || 0);
                    let firstRowH = Number(firstPill?.offsetHeight || 20);
                    for (const child of ctxPillGroup.children) {
                      const top = Number(child.offsetTop || 0);
                      if (top <= firstTop + 4) {
                        const bottom = top - firstTop + Number(child.offsetHeight || 0);
                        if (bottom > firstRowH) firstRowH = bottom;
                      }
                    }
                    const targetH = Math.max(18, firstRowH);
                    ctxPillsExpanded = false;
                    isCollapsingCtxPills = true;
                    patchClasses(refs.btn, { 'is-expanded': false });
                    for (const child of ctxPillGroup.children) {
                      if (Number(child.offsetTop || 0) > firstTop + 4) {
                        patchClasses(child, { 'is-pill-collapsing': true });
                      }
                    }
                    ctxInspectorBar.style.height = `${startH}px`;
                    ctxInspectorBar.style.overflow = 'hidden';
                    void ctxInspectorBar.offsetHeight;
                    ctxInspectorBar.style.transition =
                      'height 200ms cubic-bezier(0.16, 1, 0.3, 1)';
                    ctxInspectorBar.style.height = `${targetH}px`;
                    const finishCollapse = () => {
                      clearCtxExpandAnim();
                      if (latestData) update({ data: latestData });
                    };
                    ctxInspectorBar.ontransitionend = (ev) => {
                      if (
                        ev?.target === ctxInspectorBar &&
                        (!ev.propertyName || ev.propertyName === 'height')
                      ) {
                        finishCollapse();
                      }
                    };
                    ctxCollapseTimer = setTimeout(finishCollapse, 240);
                  }
                } else {
                  setCtxAgentId(item.key);
                }
              };
            },
          });
        }
      }

      const limitTokens = Number(ctx.compactionLimitTokens || ctx.limitTokens || 256000);
      const totalTokens = Number(ctx.totalTokens || 0);
      const usedPct =
        limitTokens > 0 ? Math.min(100, +((totalTokens / limitTokens) * 100).toFixed(1)) : 0;
      const ctxToneCls =
        usedPct >= 88 ? 'tone-danger' : usedPct >= 70 ? 'tone-warn' : '';
      patchAttr(ctxSummaryText, 'class', ctxToneCls ? `text-mono ${ctxToneCls}` : 'text-mono');
      patchText(
        ctxSummaryText,
        `${formatTokens(totalTokens)} / ${formatTokens(limitTokens)} (${usedPct}%)`
      );
      ctxSegmentBar.setProps({ context: { ...ctx, limitTokens, usedPct } });

      if (interactiveInspector) {
        const localeChanged = curLocale !== lastLocale;
        lastLocale = curLocale;
        const scored = ctxChannels.map((entry) => {
          const val = entry.ch.getValue(ctx);
          if (localeChanged) {
            patchText(entry.labelEl, entry.ch.label);
            patchAttr(entry.itemEl, 'title', entry.ch.title);
          }
          patchText(entry.valEl, formatTokens(val));
          return { entry, val };
        });
        scored.sort((a, b) => b.val - a.val || a.entry.defaultOrder - b.entry.defaultOrder);
        const nextLegendOrderSig = scored.map((x) => x.entry.ch.key).join(',');
        if (nextLegendOrderSig !== lastLegendOrderSig) {
          lastLegendOrderSig = nextLegendOrderSig;
          for (const { entry } of scored) {
            ctxLegendGrid.appendChild(entry.itemEl);
          }
        }
      } else {
        lastLocale = curLocale;
        const scoredChannels = CTX_CHANNEL_DEFS.map((ch, defaultOrder) => ({
          ch,
          defaultOrder,
          val: ch.getValue(ctx),
        }));
        scoredChannels.sort((a, b) => b.val - a.val || a.defaultOrder - b.defaultOrder);
        for (let i = 0; i < ctxChannels.length; i += 1) {
          const slot = ctxChannels[i];
          const item = scoredChannels[i];
          if (!slot || !item) continue;
          patchAttr(slot.swatchEl, 'class', `swatch ${item.ch.segClass}`);
          patchText(slot.labelEl, item.ch.label);
          patchText(slot.valEl, formatTokens(item.val));
        }
      }
    }

    let ro = null;
    if (interactiveInspector && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        if (!isVisibleFn()) return;
        const nextW =
          ctxInspectorBar.clientWidth || (ctxPanel.clientWidth ? ctxPanel.clientWidth - 24 : 0);
        if (nextW > 160 && Math.abs(nextW - cachedBarWidth) >= 6) {
          cachedBarWidth = nextW;
          if (latestData?.activeConversation?.hasSubagents) {
            update({ data: latestData });
          }
        }
      });
      ro.observe(ctxPanel);
    }

    onCleanup(() => {
      clearCtxExpandAnim();
      if (ro) ro.disconnect();
      ctxSegmentBar.destroy();
    });

    return {
      el: ctxPanel,
      refs: { update, ctxSegmentBar },
    };
  },
});
return { CTX_CHANNEL_DEFS, ContextWindowWidget };
})();

// --- src/components/widgets/QuotaPoolsWidget.js ---
const { buildQuotaPoolItems, createPoolQuotaRow, formatQuotaSummaryFooter, syncPoolQuotaRow, quotaPoolRowSig, QuotaPoolsWidget } = (() => {
/**
 * @fileoverview Standalone decoupled Quota Pools Widget (`QuotaPoolsWidget.js`).
 * Renders dynamic multi-pool quota bars (Gemini, Argon/Carbon, Claude & GPT)
 * and weekly summary footer for both `LiveOverviewView` and `WindowOverlayShell`.
 */


/**
 * 归一化动态配额池列表；在官方配额尚未返回时回退预占 Gemini 与 Claude & GPT 两个标准池槽位。
 *
 * @param {object|null|undefined} quotas
 * @param {number} minuteTick
 * @param {{ isPending?: boolean }} [options]
 * @returns {Array<object>}
 */
function buildQuotaPoolItems(quotas, minuteTick = 0, { isPending = false } = {}) {
  const safeQuotas = quotas || {};
  const activePool = safeQuotas.activePool || {};
  const rawPools =
    Array.isArray(safeQuotas.pools) && safeQuotas.pools.length > 0
      ? safeQuotas.pools
      : [
          { poolKey: 'Gemini', poolLabel: 'Gemini', family: 'Gemini' },
          { poolKey: 'Claude & GPT', poolLabel: 'Claude & GPT', family: 'Claude & GPT' },
        ];
  const weekly = safeQuotas.weekly || {};
  const poolItems = rawPools.map((p) => {
    const key = p.poolKey || p.family || p.poolLabel || 'Other';
    const poolLabel = p.poolLabel || p.family || key;
    const isActivePool =
      Boolean(activePool.family) &&
      (activePool.poolKey === key ||
        activePool.family === p.family ||
        (key === 'Claude & GPT' && ['Claude', 'GPT'].includes(activePool.family)));
    return {
      key,
      poolLabel,
      poolData: p,
      fallbackWeekly: weekly,
      isActivePool,
      minuteTick,
      isPending,
    };
  });
  if (
    weekly?.isOfficial === false &&
    poolItems.length > 0 &&
    !poolItems.some((item) => item.isActivePool)
  ) {
    poolItems[0].isActivePool = true;
  }
  return poolItems;
}

/**
 * 创建单个配额池的 DOM 行结构，内含 5h 限额与每周限额两个可独立显隐的子窗口进度条。
 */
function createPoolQuotaRow() {
  const title5h = h('span', { className: 'quota-win-title', text: '5h' });
  const usage5h = h('span', { className: 'quota-win-usage', hidden: true, text: '' });
  const left5h = h('span', { className: 'quota-win-left' }, [title5h, usage5h]);
  const meta5h = h('span', { className: 'panel-meta quota-win-meta text-mono', text: '--' });
  const fill5h = h('div', { className: 'progress-fill' });
  const row5h = h('div', { style: 'display: flex; flex-direction: column; gap: 4px;' }, [
    h('div', { className: 'panel-header quota-win-head' }, [left5h, meta5h]),
    h('div', { className: 'progress-track' }, [fill5h]),
  ]);

  const titleWk = h('span', { className: 'quota-win-title', text: t('quota.weeklyShort') });
  const usageWk = h('span', { className: 'quota-win-usage', hidden: true, text: '' });
  const leftWk = h('span', { className: 'quota-win-left' }, [titleWk, usageWk]);
  const metaWk = h('span', { className: 'panel-meta quota-win-meta text-mono', text: '--' });
  const fillWk = h('div', { className: 'progress-fill' });
  const rowWk = h('div', { style: 'display: flex; flex-direction: column; gap: 4px;' }, [
    h('div', { className: 'panel-header quota-win-head' }, [leftWk, metaWk]),
    h('div', { className: 'progress-track' }, [fillWk]),
  ]);

  const el = h('div', { style: 'display: flex; flex-direction: column; gap: 8px;' }, [
    row5h,
    rowWk,
  ]);

  return {
    el,
    refs: {
      row5h,
      left5h,
      title5h,
      usage5h,
      meta5h,
      fill5h,
      rowWk,
      leftWk,
      titleWk,
      usageWk,
      metaWk,
      fillWk,
    },
  };
}

/**
 * 格式化可用额度面板底部的汇总行文案（官方配额模式下展示各池周期合计，自定义预算模式下展示自然周累计）。
 */
function formatQuotaSummaryFooter(quotas, account) {
  const weekly = quotas?.weekly || {};
  const isCustomLocal = weekly.isOfficial === false;
  const tokStr = formatTokens(weekly.tokens || 0);
  const costStr = formatUsd(weekly.costUsd || 0);
  const leftText = isCustomLocal
    ? t('quota.footTokensCustom', { tok: tokStr, cost: costStr })
    : t('quota.footTokensCycle', { tok: tokStr, cost: costStr });
  const rightText =
    Number(account?.aiCredits) > 0
      ? t('quota.footCredits', { credits: account.aiCredits })
      : isCustomLocal
        ? t('quota.footCallsCustom', { calls: weekly.calls || 0 })
        : t('quota.footCallsCycle', { calls: weekly.calls || 0 });
  const tooltip = isCustomLocal ? t('quota.footTipCustom') : t('quota.footTipCycle');
  return { leftText, rightText, tooltip };
}

/**
 * 同步单个配额池行的 5h 与每周窗口状态。
 */
function syncPoolQuotaRow(refs, item, idx, rowEl) {
  const { poolData, poolLabel, fallbackWeekly, isActivePool, isPending } = item;
  patchAttr(
    rowEl,
    'style',
    idx === 0
      ? 'display: flex; flex-direction: column; gap: 8px;'
      : 'display: flex; flex-direction: column; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border-hairline);'
  );

  const has5h = poolData?.usedPct != null && poolData?.remainingPct != null;
  const used5hVal = has5h ? Number(poolData.usedPct) : 0;
  const rem5hVal = has5h ? Number(poolData.remainingPct) : 0;

  const useCustomWeekly = Boolean(isActivePool && fallbackWeekly?.isOfficial === false);
  const wkUsedRaw = useCustomWeekly
    ? fallbackWeekly?.usedPct
    : poolData?.weeklyUsedPct ?? (isActivePool ? fallbackWeekly?.usedPct : null);
  const wkRemRaw = useCustomWeekly
    ? fallbackWeekly?.remainingPct
    : poolData?.weeklyRemainingPct ?? (isActivePool ? fallbackWeekly?.remainingPct : null);
  const wkResetRaw = useCustomWeekly
    ? fallbackWeekly?.resetTime || poolData?.weeklyResetTime
    : poolData?.weeklyResetTime || (isActivePool ? fallbackWeekly?.resetTime : null);
  const hasWk = wkUsedRaw != null && wkRemRaw != null;
  const usedWkVal = hasWk ? Number(wkUsedRaw) : 0;
  const remWkVal = hasWk ? Number(wkRemRaw) : 0;

  const hide5h = !has5h && hasWk;
  const hideWk = !hasWk && has5h;
  refs.row5h.hidden = hide5h;
  refs.row5h.style.display = hide5h ? 'none' : 'flex';
  refs.rowWk.hidden = hideWk;
  refs.rowWk.style.display = hideWk ? 'none' : 'flex';

  const fallbackMetaText = isPending ? t('quota.loading') : t('quota.failed');

  patchText(refs.title5h, `5h (${poolLabel})`);
  const c5h = poolData?.cycle5h;
  if (!isPending && has5h && c5h && (c5h.tokens != null || c5h.costUsd != null)) {
    const tok5h = formatTokens(c5h.tokens || 0);
    const cost5h = formatUsd(c5h.costUsd || 0);
    const calls5h = Number(c5h.calls || 0);
    refs.usage5h.hidden = false;
    patchText(refs.usage5h, `· ${tok5h} (${cost5h})`);
    patchAttr(
      refs.left5h,
      'title',
      t('quota.cycle5hTitle', {
        pool: poolLabel,
        tok: tok5h,
        cost: cost5h,
        calls: calls5h,
      })
    );
  } else {
    refs.usage5h.hidden = true;
    patchText(refs.usage5h, '');
    patchAttr(refs.left5h, 'title', null);
  }
  patchText(
    refs.meta5h,
    has5h
      ? t('quota.usedAndLeft', {
          reset: formatCountdown(poolData.resetTime),
          used: used5hVal.toFixed(1),
          rem: rem5hVal.toFixed(1),
        })
      : fallbackMetaText
  );
  patchStyleVar(refs.fill5h, '--fill-w', `${Math.min(100, used5hVal)}%`);
  patchClasses(refs.fill5h, {
    'tone-warn': used5hVal >= 70 && used5hVal < 85,
    'tone-danger': used5hVal >= 85,
  });

  const customTitle =
    useCustomWeekly && fallbackWeekly?.title
      ? fallbackWeekly.title
      : t('quota.weeklyPool', { pool: poolLabel });
  patchText(refs.titleWk, customTitle);
  const cWk = useCustomWeekly
    ? fallbackWeekly
    : poolData?.cycleWeekly || (isActivePool ? fallbackWeekly : null);
  if (!isPending && hasWk && cWk && (cWk.tokens != null || cWk.costUsd != null)) {
    const tokWk = formatTokens(cWk.tokens || 0);
    const costWk = formatUsd(cWk.costUsd || 0);
    const callsWk = Number(cWk.calls || 0);
    refs.usageWk.hidden = false;
    patchText(refs.usageWk, `· ${tokWk} (${costWk})`);
    patchAttr(
      refs.leftWk,
      'title',
      useCustomWeekly
        ? t('quota.cycleWkCustomTitle', { tok: tokWk, cost: costWk, calls: callsWk })
        : t('quota.cycleWkPoolTitle', {
            pool: poolLabel,
            tok: tokWk,
            cost: costWk,
            calls: callsWk,
          })
    );
  } else {
    refs.usageWk.hidden = true;
    patchText(refs.usageWk, '');
    patchAttr(refs.leftWk, 'title', null);
  }
  patchText(
    refs.metaWk,
    hasWk
      ? t('quota.usedAndLeft', {
          reset: formatCountdown(wkResetRaw),
          used: usedWkVal.toFixed(1),
          rem: remWkVal.toFixed(1),
        })
      : fallbackMetaText
  );
  patchStyleVar(refs.fillWk, '--fill-w', `${Math.min(100, usedWkVal)}%`);
  patchClasses(refs.fillWk, {
    'tone-warn': usedWkVal >= 70 && usedWkVal < 85,
    'tone-danger': usedWkVal >= 85,
  });
}

function quotaPoolRowSig(item, idx) {
  const c5h = item.poolData?.cycle5h;
  const cWk = item.poolData?.cycleWeekly;
  const fw = item.fallbackWeekly;
  return `${getEffectiveLocale()}:${idx}:${item.poolLabel}:${item.isActivePool}:${Boolean(item.isPending)}:${item.minuteTick}:${item.poolData?.usedPct}:${item.poolData?.remainingPct}:${item.poolData?.resetTime}:${item.poolData?.weeklyUsedPct}:${item.poolData?.weeklyRemainingPct}:${item.poolData?.weeklyResetTime}:${c5h?.tokens}:${c5h?.costUsd}:${c5h?.calls}:${cWk?.tokens}:${cWk?.costUsd}:${cWk?.calls}:${fw?.isOfficial}:${fw?.usedPct}:${fw?.remainingPct}:${fw?.resetTime}:${fw?.title}:${fw?.tokens}:${fw?.costUsd}:${fw?.calls}`;
}

const QuotaPoolsWidget = defineComponent({
  name: 'QuotaPoolsWidget',
  setup({ props }) {
    const compactHover = Boolean(props.compactHover);
    const titleTextEl = h('span', { text: t('module.quotas') });
    const tierBadge = h('span', { className: 'panel-meta', text: 'Google AI · Pro' });
    const poolsListEl = h(
      'div',
      compactHover
        ? { className: 'wm-hover-quota-pools' }
        : { style: 'display: flex; flex-direction: column; gap: 0;' }
    );

    if (compactHover) {
      patchKeyedList(poolsListEl, buildQuotaPoolItems(null, 0, { isPending: true }), {
        keyFn: (item) => item.key,
        sigFn: quotaPoolRowSig,
        createRow: createPoolQuotaRow,
        updateRow: syncPoolQuotaRow,
      });
    }

    const initFoot = formatQuotaSummaryFooter(null, null);
    const wkFootLeft = h('span', { className: 'text-muted', text: initFoot.leftText });
    const wkFootRight = h('span', {
      className: 'text-muted',
      text: compactHover ? initFoot.rightText : '',
    });

    const quotaPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('pulse', { size: 13 }),
          titleTextEl,
        ]),
        tierBadge,
      ]),
      poolsListEl,
      h(
        'div',
        compactHover
          ? { className: 'panel-header wm-hover-quota-foot' }
          : { className: 'panel-header', style: 'font-size: var(--fs-md); padding-top: 2px;' },
        [wkFootLeft, wkFootRight]
      ),
    ]);

    function update({ data, minuteTick } = {}) {
      patchText(titleTextEl, t('module.quotas'));
      if (!data) {
        if (compactHover) {
          patchKeyedList(poolsListEl, buildQuotaPoolItems(null, 0, { isPending: true }), {
            keyFn: (item) => item.key,
            sigFn: quotaPoolRowSig,
            createRow: createPoolQuotaRow,
            updateRow: syncPoolQuotaRow,
          });
          const pendingFoot = formatQuotaSummaryFooter(null, null);
          patchText(wkFootLeft, pendingFoot.leftText);
          patchText(wkFootRight, pendingFoot.rightText);
        }
        return;
      }

      const quotas = data.quotas || {};
      const effTick = Number.isFinite(minuteTick) ? minuteTick : Math.floor(Date.now() / 30000);
      patchText(
        tierBadge,
        `${data.account?.tierName || 'Google AI'} · ${data.account?.planName || 'Pro'}`
      );
      patchKeyedList(poolsListEl, buildQuotaPoolItems(quotas, effTick), {
        keyFn: (item) => item.key,
        sigFn: quotaPoolRowSig,
        createRow: createPoolQuotaRow,
        updateRow: syncPoolQuotaRow,
      });

      const footSummary = formatQuotaSummaryFooter(quotas, data.account);
      patchText(wkFootLeft, footSummary.leftText);
      patchText(wkFootRight, footSummary.rightText);
      patchAttr(wkFootLeft, 'title', footSummary.tooltip);
      patchAttr(wkFootRight, 'title', footSummary.tooltip);
    }

    return {
      el: quotaPanel,
      refs: { update, poolsListEl },
    };
  },
});
return { buildQuotaPoolItems, createPoolQuotaRow, formatQuotaSummaryFooter, syncPoolQuotaRow, quotaPoolRowSig, QuotaPoolsWidget };
})();

// --- src/components/widgets/LiveActivityWidget.js ---
const { buildFallbackRunningConversations, LiveActivityWidget } = (() => {
/**
 * @fileoverview Standalone decoupled Live Running Tasks Widget (`LiveActivityWidget.js`).
 * Displays active multi-session running conversations & collapsible subagent activity
 * with an isolated 1s elapsed timer lifecycle. Supports both Overview/Hover widget mode
 * and controlled Multi-Session Floating Panel mode (`WindowOverlayShell.js`).
 */


function buildFallbackRunningConversations(
  data,
  { agents = [], aggregated = null, latestTokPerSec = undefined, contextUsedPct = undefined } = {}
) {
  if (!data) return [];
  if (Array.isArray(data.runningConversations) && data.runningConversations.length > 0) {
    return data.runningConversations;
  }
  const activeConv = data.activeConversation || {};
  if (!activeConv.isRunning && !aggregated?.isRunning) return [];
  const childAgents = (agents || []).filter((a) => !a.isMain);
  const swarmChildren = childAgents.filter((a) => a.agentKind === 'swarm_worker');
  return [
    {
      cascadeId: activeConv.cascadeId || 'current',
      title: activeConv.title || t('live.currentSession'),
      ...(activeConv.swarmTitle ? { swarmTitle: activeConv.swarmTitle } : {}),
      isCurrentSelected: true,
      isMainRunning: Boolean(activeConv.isRunning),
      isRunning: true,
      mainActivity: activeConv.liveActivity || aggregated?.liveActivity || null,
      subagentCount: childAgents.length,
      swarmCount: swarmChildren.length,
      runningSubagentCount: childAgents.filter((a) => a.isRunning).length,
      runningSwarmCount: swarmChildren.filter((a) => a.isRunning).length,
      ...(latestTokPerSec !== undefined ? { latestTokPerSec } : {}),
      ...(contextUsedPct !== undefined ? { contextUsedPct } : {}),
      subagents: childAgents.map((s, idx) => {
        const isSwarmW = s.agentKind === 'swarm_worker';
        const isKilled = Boolean(s.swarmState === 'killed');
        return {
          cascadeId: s.cascadeId || s.agentId,
          index: s.index || idx + 1,
          agentKind: s.agentKind || (s.isSideQuestion ? 'side_question' : 'subagent'),
          agentOrdinal:
            s.agentOrdinal || (s.isSideQuestion ? s.sideIndex || 0 : s.index || idx + 1),
          customRole: s.customRole,
          ...(s.swarmState ? { swarmState: s.swarmState } : {}),
          ...(s.isSideQuestion ? { isSideQuestion: true, sideIndex: s.sideIndex || 0 } : {}),
          badgeText: formatAgentBadgeText({ ...s, index: s.index || idx + 1 }),
          shortLabel:
            s.shortLabel ||
            `${isSwarmW ? t('fmt.swarmAgent') : t('fmt.subAgent')} #${s.agentOrdinal || idx + 1}`,
          role:
            s.role ||
            `${isSwarmW ? t('fmt.swarmAgent') : t('fmt.subAgent')} #${s.agentOrdinal || idx + 1}`,
          isRunning: Boolean(s.isRunning),
          stepCount: Number(s.stepCount || 0),
          lastModifiedMs: s.lastModifiedMs || 0,
          liveActivity: s.liveActivity || {
            phase: s.isRunning ? 'thinking' : isSwarmW && !isKilled ? 'waiting' : 'done',
            actionKey: s.isRunning
              ? 'thinking'
              : isSwarmW
                ? isKilled
                  ? 'swarm_killed'
                  : 'swarm_waiting'
                : 'done',
            label: s.isRunning
              ? t('live.thinking')
              : isSwarmW
                ? isKilled
                  ? t('live.killed')
                  : t('live.waiting')
                : t('live.done'),
            detail: '',
            stepProgress: '',
            startedAtMs: s.lastModifiedMs || 0,
            signature: `${s.agentId}:${s.swarmState || ''}:${s.stepCount || 0}`,
          },
        };
      }),
    },
  ];
}

const LiveActivityWidget = defineComponent({
  name: 'LiveActivityWidget',
  setup({ props, onCleanup }) {
    const interactive = props.interactive !== false;
    const preview = Boolean(props.preview);
    const defaultExpandRunningSubs = Boolean(props.defaultExpandRunningSubs);
    const showSessionExtras = Boolean(props.showSessionExtras);
    const onSelectSession =
      typeof props.onSelectSession === 'function' ? props.onSelectSession : null;
    const onLayoutChange =
      typeof props.onLayoutChange === 'function' ? props.onLayoutChange : null;
    const getCtxAgentId =
      typeof props.getCtxAgentId === 'function'
        ? props.getCtxAgentId
        : () => uiStore.getState().ctxInspectorAgentId;
    const isVisibleFn =
      typeof props.isVisibleFn === 'function' ? props.isVisibleFn : () => true;

    const liveActivityBar = h('div', {
      className: 'live-activity-list',
      hidden: true,
      'aria-live': 'polite',
    });

    const manualSubExpandMap = new Map();
    const activityTimersMap = new Map();
    let liveTickTimer = null;
    let latestUpdateArgs = null;

    function resolveIsExpanded(item) {
      const runSubCount = Number(item?.runningSubagentCount || 0);
      if (!interactive) return runSubCount > 0;
      if (manualSubExpandMap.has(item.cascadeId)) {
        return Boolean(manualSubExpandMap.get(item.cascadeId));
      }
      return defaultExpandRunningSubs ? runSubCount > 0 : false;
    }

    function bindLiveElapsedTimer(timerKey, sig, rawStartMs, targetEl) {
      const now = Date.now();
      const prev = activityTimersMap.get(timerKey);
      let startMs = prev?.startMs || 0;
      if (!prev || prev.sig !== sig) {
        const validRaw = Number(rawStartMs || 0);
        startMs = validRaw > 0 && validRaw <= now + 2000 ? validRaw : now;
      } else if (startMs <= 0 && Number(rawStartMs) > 0 && Number(rawStartMs) <= now + 2000) {
        startMs = Number(rawStartMs);
      }
      activityTimersMap.set(timerKey, { sig, startMs, el: targetEl });
      const elapsedSec = Math.max(0, (now - startMs) / 1000);
      patchText(targetEl, formatElapsedSec(elapsedSec));
    }

    function updateLiveElapsedDisplay() {
      const now = Date.now();
      for (const entry of activityTimersMap.values()) {
        if (!entry?.el) continue;
        const elapsedSec = entry.startMs > 0 ? Math.max(0, (now - entry.startMs) / 1000) : 0;
        patchText(entry.el, formatElapsedSec(elapsedSec));
      }
    }

    function pauseTicker() {
      if (liveTickTimer) {
        clearInterval(liveTickTimer);
        liveTickTimer = null;
      }
    }

    function stopLiveTicker() {
      pauseTicker();
      activityTimersMap.clear();
    }

    function ensureLiveTicker() {
      if (!isVisibleFn() || activityTimersMap.size === 0) {
        pauseTicker();
        return;
      }
      if (!liveTickTimer) {
        liveTickTimer = setInterval(updateLiveElapsedDisplay, 1000);
      }
    }

    function resumeTicker() {
      if (activityTimersMap.size > 0) {
        updateLiveElapsedDisplay();
        ensureLiveTicker();
      }
    }

    function readComputedPx(el, prop, fallback) {
      if (!el || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
        return fallback;
      }
      try {
        const val = parseFloat(window.getComputedStyle(el)?.[prop]);
        return Number.isFinite(val) ? val : fallback;
      } catch {
        return fallback;
      }
    }

    function clearSubExpandAnim(refs) {
      if (!refs) return;
      if (refs.subAnimTimer) {
        clearTimeout(refs.subAnimTimer);
        refs.subAnimTimer = null;
      }
      refs.isCollapsingSubs = false;
      const host = refs.subScroll?.el;
      if (host) {
        host.ontransitionend = null;
        patchClasses(host, { 'is-sub-animating': false });
        host.style.height = '';
        host.style.paddingTop = '';
        host.style.marginTop = '';
        host.style.opacity = '';
        host.style.overflow = '';
        host.style.transition = '';
      }
    }

    function createLiveTaskCard() {
      const dotIcon = createSvgIcon('dot', { size: 11 });
      patchClasses(dotIcon, { 'is-pulsing': true });
      const dotWrap = h('span', { className: 'live-activity-dot' }, [dotIcon]);
      const titleEl = h('strong', {
        className: 'live-task-title',
        text: t('live.currentSession'),
      });
      const hereTagEl = showSessionExtras
        ? h('span', {
            className: 'wm-session-tag is-here',
            hidden: true,
            text: t('multi.hereTag'),
          })
        : null;
      const metricsEl = showSessionExtras
        ? h('span', {
            className: 'wm-task-metrics text-mono',
            hidden: true,
            text: '',
          })
        : null;
      const subToggleLabel = h('span', {
        className: 'live-sub-toggle-label',
        text: t('live.subToggleIdle', { total: 0 }),
      });
      const subToggleChevron = createSvgIcon('chevron-down', {
        size: 11,
        className: 'live-sub-toggle-chevron',
      });
      const subToggleBtn = h(
        'button',
        {
          type: 'button',
          className: 'live-sub-toggle',
          hidden: true,
        },
        [subToggleLabel, subToggleChevron]
      );
      const elapsedEl = h('span', {
        className: 'live-activity-elapsed text-mono',
        text: '0s',
      });

      const headerEl = h('div', { className: 'live-task-header' }, [
        h('div', { className: 'live-task-title-wrap' }, [
          dotWrap,
          titleEl,
          ...(hereTagEl ? [hereTagEl] : []),
        ]),
        h('div', { className: 'live-task-header-right' }, [
          ...(metricsEl ? [metricsEl] : []),
          subToggleBtn,
          elapsedEl,
        ]),
      ]);

      const mainBadge = h('span', {
        className: 'agent-badge badge-main',
        hidden: true,
        text: t('fmt.mainBadge'),
      });
      const mainPhase = h('strong', {
        className: 'live-activity-phase',
        text: t('live.thinking'),
      });
      const mainProgress = h('span', {
        className: 'live-activity-progress text-mono',
        hidden: true,
        text: '',
      });
      const mainSep = h('span', { className: 'live-activity-sep', hidden: true, text: '·' });
      const mainDetail = h('span', {
        className: 'live-activity-detail',
        hidden: true,
        text: '',
      });

      const mainRowEl = h('div', { className: 'live-task-main-row' }, [
        mainBadge,
        mainPhase,
        mainProgress,
        mainSep,
        mainDetail,
      ]);

      const subListEl = h('div', { className: 'live-sub-list', hidden: true });
      const subScroll = CustomScrollbar({
        contentEl: subListEl,
        className: 'live-sub-scroll-host',
      });
      patchAttr(subScroll.el, 'hidden', true);
      const cardEl = h('div', { className: 'live-task-card' }, [
        headerEl,
        mainRowEl,
        subScroll.el,
      ]);

      return {
        el: cardEl,
        refs: {
          cardEl,
          dotIcon,
          titleEl,
          hereTagEl,
          metricsEl,
          subToggleBtn,
          subToggleLabel,
          subToggleChevron,
          elapsedEl,
          mainBadge,
          mainPhase,
          mainProgress,
          mainSep,
          mainDetail,
          subListEl,
          subScroll,
          subAnimTimer: null,
          isCollapsingSubs: false,
        },
      };
    }

    function createLiveSubRow() {
      const subBadge = h('span', {
        className: 'agent-badge badge-sub-1',
        text: t('fmt.subBadge', { index: 1 }),
      });
      const subRole = h('span', { className: 'live-sub-role', text: t('fmt.subAgent') });
      const subSummary = h('span', { className: 'live-sub-summary', text: '' });
      const subElapsed = h('span', { className: 'live-sub-elapsed text-mono', text: '0s' });

      const rowEl = h('div', { className: 'live-sub-row' }, [
        h('div', { className: 'live-sub-left' }, [subBadge, subRole, subSummary]),
        subElapsed,
      ]);

      return {
        el: rowEl,
        refs: {
          rowEl,
          subBadge,
          subRole,
          subSummary,
          subElapsed,
        },
      };
    }

    function update({ data = null, items = null, hostRouteConversationId = '' } = {}) {
      latestUpdateArgs = { data, items, hostRouteConversationId };
      if (!data && !Array.isArray(items)) {
        patchAttr(liveActivityBar, 'hidden', true);
        stopLiveTicker();
        return;
      }

      let rawRunningList = Array.isArray(items) ? items : null;
      if (!rawRunningList) {
        const { agents, aggregated } = resolveScopedConversation(
          data,
          'all',
          getCtxAgentId()
        );
        rawRunningList = buildFallbackRunningConversations(data, { agents, aggregated });
      }

      if (manualSubExpandMap.size > 0) {
        const runningIdsSet = new Set(rawRunningList.map((item) => item.cascadeId));
        for (const id of [...manualSubExpandMap.keys()]) {
          if (!runningIdsSet.has(id)) {
            manualSubExpandMap.delete(id);
          }
        }
      }

      const hasRunningTasks = rawRunningList.length > 0;
      patchAttr(liveActivityBar, 'hidden', !hasRunningTasks);
      if (!hasRunningTasks) {
        stopLiveTicker();
        patchKeyedList(liveActivityBar, [], {
          destroyRow: (refs) => {
            clearSubExpandAnim(refs);
            refs?.subScroll?.destroy?.();
          },
        });
        return;
      }

      if (!isVisibleFn()) {
        pauseTicker();
        return;
      }

      const locale = getEffectiveLocale();
      const hostRouteLower = showSessionExtras
        ? String(hostRouteConversationId || extractHostRouteCascadeId() || '').toLowerCase()
        : '';

      const activeTimerKeys = new Set();
      for (const item of rawRunningList) {
        activeTimerKeys.add(`main:${item.cascadeId}`);
        const subCount = Number(item.subagentCount || item.subagents?.length || 0);
        const isExp = resolveIsExpanded(item);
        if (subCount > 0 && isExp) {
          for (const sub of item.subagents || []) {
            if (sub?.isRunning) {
              activeTimerKeys.add(`sub:${sub.cascadeId}`);
            }
          }
        }
      }

      patchKeyedList(liveActivityBar, rawRunningList, {
        keyFn: (item) => item.cascadeId,
        sigFn: (item) => {
          const isExp = resolveIsExpanded(item);
          const isHere =
            showSessionExtras &&
            Boolean(hostRouteLower) &&
            (String(item.cascadeId || '').toLowerCase() === hostRouteLower ||
              (item.subagents || []).some(
                (s) => String(s?.cascadeId || '').toLowerCase() === hostRouteLower
              ));
          const subSig = (item.subagents || [])
            .map(
              (s) =>
                `${s.cascadeId}:${s.isRunning}:${s.swarmState || ''}:${s.stepCount}:${s.liveActivity?.signature || ''}:${s.liveActivity?.startedAtMs || 0}`
            )
            .join('|');
          return `${locale}:${item.cascadeId}:${item.title}:${isHere}:${item.isMainRunning}:${item.subagentCount}:${item.swarmCount || 0}:${item.runningSubagentCount}:${isExp}:${item.latestTokPerSec ?? ''}:${item.contextUsedPct ?? ''}:${item.mainActivity?.signature || ''}:${item.mainActivity?.startedAtMs || 0}:${subSig}`;
        },
        createRow: createLiveTaskCard,
        updateRow: (refs, item) => {
          const act = item.mainActivity || {
            phase: 'thinking',
            actionKey: 'thinking',
            label: t('live.thinking'),
            detail: '',
            stepProgress: '',
            startedAtMs: item.lastModifiedMs || 0,
            signature: `fallback:${item.lastModifiedMs || 0}`,
          };

          const isWaiting = act.phase === 'waiting';
          const isCompacting = act.phase === 'compacting';
          patchClasses(refs.cardEl, {
            'is-waiting': isWaiting,
            'is-compacting': isCompacting,
          });
          patchClasses(refs.dotIcon, { 'is-pulsing': true });

          const convTitle = item.title || item.cascadeId?.slice(0, 8) || t('live.currentSession');
          patchText(refs.titleEl, convTitle);
          if (interactive && !preview) {
            patchAttr(
              refs.titleEl,
              'title',
              onSelectSession
                ? t('multi.inspectSessionTitle', { title: convTitle })
                : t('live.switchSessionTitle', { title: convTitle })
            );
            refs.titleEl.onclick = (e) => {
              e?.stopPropagation?.();
              if (onSelectSession) {
                onSelectSession(item.cascadeId);
              } else if (item.cascadeId && item.cascadeId !== 'current') {
                uiStore.setState({ selectedAgentScope: 'all', ctxInspectorAgentId: 'auto' });
                void selectConversation(item.cascadeId);
              }
            };
          }

          if (showSessionExtras && refs.hereTagEl && refs.metricsEl) {
            const isHere =
              Boolean(hostRouteLower) &&
              (String(item.cascadeId || '').toLowerCase() === hostRouteLower ||
                (item.subagents || []).some(
                  (s) => String(s?.cascadeId || '').toLowerCase() === hostRouteLower
                ));
            patchText(refs.hereTagEl, t('multi.hereTag'));
            patchAttr(refs.hereTagEl, 'hidden', !isHere);

            const metricParts = [];
            if (Number.isFinite(item.latestTokPerSec) && item.latestTokPerSec > 0) {
              metricParts.push(
                `${item.latestTokPerSec >= 100 ? Math.round(item.latestTokPerSec) : item.latestTokPerSec.toFixed(1)} t/s`
              );
            }
            if (item.contextUsedPct != null && Number.isFinite(Number(item.contextUsedPct))) {
              metricParts.push(`${Math.round(Number(item.contextUsedPct))}%`);
            }
            const metricsStr = metricParts.join(' · ');
            patchAttr(refs.metricsEl, 'hidden', !metricsStr);
            if (metricsStr) {
              patchText(refs.metricsEl, metricsStr);
            }
          }

          const subCount = Number(item.subagentCount || item.subagents?.length || 0);
          const swarmCount = Number(
            item.swarmCount ??
              (item.subagents || []).filter((s) => s?.agentKind === 'swarm_worker').length
          );
          const isPureSwarm = subCount > 0 && swarmCount === subCount;
          const runSubCount = Number(item.runningSubagentCount || 0);
          const isExpanded = resolveIsExpanded(item);
          patchText(refs.mainBadge, t('fmt.mainBadge'));
          patchAttr(refs.mainBadge, 'hidden', subCount === 0);
          patchAttr(refs.subToggleBtn, 'hidden', subCount === 0);
          if (subCount > 0) {
            const toggleText =
              runSubCount > 0
                ? t(isPureSwarm ? 'live.swarmToggleRunning' : 'live.subToggleRunning', {
                    run: runSubCount,
                    total: subCount,
                  })
                : t(isPureSwarm ? 'live.swarmToggleIdle' : 'live.subToggleIdle', {
                    total: subCount,
                  });
            patchText(refs.subToggleLabel, toggleText);
            patchClasses(refs.subToggleBtn, { 'is-expanded': isExpanded });
            if (interactive) {
              patchAttr(
                refs.subToggleBtn,
                'title',
                isExpanded ? t('live.subCollapseTitle') : t('live.subExpandTitle')
              );
              refs.subToggleBtn.onclick = (e) => {
                e.stopPropagation();
                const nextExpanded = !resolveIsExpanded(item);
                const host = refs.subScroll.el;
                const curH = Number(host.offsetHeight || 0);
                const curPadTop = readComputedPx(host, 'paddingTop', 6);
                const curMarginTop = readComputedPx(host, 'marginTop', 3);
                const curOpacity = readComputedPx(host, 'opacity', 1);
                const parentGap = readComputedPx(refs.cardEl, 'rowGap', 7);
                const collapsedMarginTop = -Math.max(0, Math.round(parentGap));
                const wasMidAnim = Boolean(refs.subAnimTimer);
                clearSubExpandAnim(refs);
                manualSubExpandMap.set(item.cascadeId, nextExpanded);

                const modern = isModernUiActiveForElement(refs.cardEl);
                if (!modern) {
                  if (latestUpdateArgs) update(latestUpdateArgs);
                  onLayoutChange?.();
                  return;
                }

                if (nextExpanded) {
                  if (latestUpdateArgs) update(latestUpdateArgs);
                  const endH = Number(host.offsetHeight || host.scrollHeight || 0);
                  const endPadTop = readComputedPx(host, 'paddingTop', 6);
                  const endMarginTop = readComputedPx(host, 'marginTop', 3);
                  const fromH = wasMidAnim && curH > 0 ? curH : 0;
                  const fromPadTop = wasMidAnim && curH > 0 ? curPadTop : 0;
                  const fromMarginTop = wasMidAnim && curH > 0 ? curMarginTop : collapsedMarginTop;
                  const fromOpacity = wasMidAnim && curH > 0 ? curOpacity : 0;
                  if (endH > 0) {
                    patchClasses(host, { 'is-sub-animating': true });
                    host.style.height = `${fromH}px`;
                    host.style.paddingTop = `${fromPadTop}px`;
                    host.style.marginTop = `${fromMarginTop}px`;
                    host.style.opacity = `${fromOpacity}`;
                    host.style.overflow = 'hidden';
                    void host.offsetHeight;
                    host.style.transition =
                      'height 220ms cubic-bezier(0.16, 1, 0.3, 1), padding-top 220ms cubic-bezier(0.16, 1, 0.3, 1), margin-top 220ms cubic-bezier(0.16, 1, 0.3, 1), opacity 180ms ease-out';
                    host.style.height = `${endH}px`;
                    host.style.paddingTop = `${endPadTop}px`;
                    host.style.marginTop = `${endMarginTop}px`;
                    host.style.opacity = '1';
                    const finishExpand = () => {
                      clearSubExpandAnim(refs);
                      refs.subScroll.refresh();
                      onLayoutChange?.();
                    };
                    host.ontransitionend = (ev) => {
                      if (
                        ev?.target === host &&
                        (!ev.propertyName || ev.propertyName === 'height')
                      ) {
                        finishExpand();
                      }
                    };
                    refs.subAnimTimer = setTimeout(finishExpand, 260);
                  } else {
                    onLayoutChange?.();
                  }
                } else {
                  patchClasses(refs.subToggleBtn, { 'is-expanded': false });
                  patchAttr(refs.subToggleBtn, 'title', t('live.subExpandTitle'));
                  if (curH > 0) {
                    refs.isCollapsingSubs = true;
                    patchClasses(host, { 'is-sub-animating': true });
                    host.style.height = `${curH}px`;
                    host.style.paddingTop = `${curPadTop}px`;
                    host.style.marginTop = `${curMarginTop}px`;
                    host.style.opacity = `${curOpacity}`;
                    host.style.overflow = 'hidden';
                    void host.offsetHeight;
                    host.style.transition =
                      'height 200ms cubic-bezier(0.16, 1, 0.3, 1), padding-top 200ms cubic-bezier(0.16, 1, 0.3, 1), margin-top 200ms cubic-bezier(0.16, 1, 0.3, 1), opacity 150ms ease-out';
                    host.style.height = '0px';
                    host.style.paddingTop = '0px';
                    host.style.marginTop = `${collapsedMarginTop}px`;
                    host.style.opacity = '0';
                    const finishCollapse = () => {
                      clearSubExpandAnim(refs);
                      patchAttr(host, 'hidden', true);
                      patchAttr(refs.subListEl, 'hidden', true);
                      if (latestUpdateArgs) update(latestUpdateArgs);
                      onLayoutChange?.();
                    };
                    host.ontransitionend = (ev) => {
                      if (
                        ev?.target === host &&
                        (!ev.propertyName || ev.propertyName === 'height')
                      ) {
                        finishCollapse();
                      }
                    };
                    refs.subAnimTimer = setTimeout(finishCollapse, 240);
                  } else {
                    if (latestUpdateArgs) update(latestUpdateArgs);
                    onLayoutChange?.();
                  }
                }
              };
            }
          } else if (refs.isCollapsingSubs) {
            clearSubExpandAnim(refs);
          }

          const mainLabel = formatLiveActivityLabel(act, 'live.thinking');
          const detailStr = formatLiveActivityDetail(act);
          const mainTimerKey = `main:${item.cascadeId}`;
          activeTimerKeys.add(mainTimerKey);
          bindLiveElapsedTimer(
            mainTimerKey,
            `${item.cascadeId}:${act.signature || mainLabel}`,
            act.startedAtMs,
            refs.elapsedEl
          );

          patchText(refs.mainPhase, mainLabel);
          const progText = act.stepProgress ? `[${act.stepProgress}]` : '';
          patchAttr(refs.mainProgress, 'hidden', !progText);
          if (progText) {
            patchText(refs.mainProgress, progText);
          }

          patchAttr(refs.mainSep, 'hidden', !detailStr);
          patchAttr(refs.mainDetail, 'hidden', !detailStr);
          patchText(refs.mainDetail, detailStr);

          if (interactive && !showSessionExtras) {
            const fullTooltip = `[${convTitle}] ${t('fmt.mainAgent')} · ${mainLabel}${progText ? ` ${progText}` : ''}${detailStr ? ` · ${detailStr}` : ''}`;
            patchAttr(refs.cardEl, 'title', fullTooltip);
          }

          const showSubs = subCount > 0 && isExpanded;
          if (!refs.isCollapsingSubs) {
            patchAttr(refs.subScroll.el, 'hidden', !showSubs);
            patchAttr(refs.subListEl, 'hidden', !showSubs);
          }
          if (showSubs) {
            const rawSubItems = item.subagents || [];
            const getSubSortRank = (s) => {
              if (s?.isRunning) return 0;
              if (s?.swarmState === 'waiting' || s?.liveActivity?.actionKey === 'swarm_waiting') {
                return 1;
              }
              return 2;
            };
            const subItems =
              rawSubItems.length > 1
                ? rawSubItems
                    .slice()
                    .sort(
                      (a, b) =>
                        getSubSortRank(a) - getSubSortRank(b) ||
                        Number(a?.index || 0) - Number(b?.index || 0)
                    )
                : rawSubItems;
            patchKeyedList(refs.subListEl, subItems, {
              keyFn: (sub) => sub.cascadeId,
              sigFn: (sub) =>
                `${locale}:${sub.cascadeId}:${sub.agentKind || ''}:${sub.swarmState || ''}:${sub.role}:${sub.isRunning}:${sub.stepCount}:${sub.liveActivity?.signature || ''}:${sub.isRunning ? activityTimersMap.has(`sub:${sub.cascadeId}`) : true}`,
              createRow: createLiveSubRow,
              updateRow: (subRefs, sub) => {
                const subAct = sub.liveActivity || {
                  phase: sub.isRunning ? 'thinking' : 'done',
                  actionKey: sub.isRunning ? 'thinking' : 'done',
                  label: sub.isRunning ? t('live.thinking') : t('live.done'),
                  detail: '',
                  stepProgress: '',
                  startedAtMs: sub.lastModifiedMs || 0,
                };
                const isWaitingSub =
                  !sub.isRunning &&
                  (sub.swarmState === 'waiting' || subAct.actionKey === 'swarm_waiting');
                const isKilledSub =
                  !sub.isRunning &&
                  (sub.swarmState === 'killed' || subAct.actionKey === 'swarm_killed');
                patchClasses(subRefs.rowEl, {
                  'is-done': !sub.isRunning && !isWaitingSub,
                  'is-waiting-sub': isWaitingSub,
                  'is-killed-sub': isKilledSub,
                });

                const badgeCls = getAgentBadgeClass(sub.index || 1, false);
                const subBadgeText = formatAgentBadgeText({
                  ...sub,
                  isMain: false,
                  index: sub.index || 1,
                });
                patchAttr(subRefs.subBadge, 'class', `agent-badge ${badgeCls}`);
                patchText(subRefs.subBadge, subBadgeText);

                const fallbackRole =
                  sub.agentKind === 'side_question' || sub.isSideQuestion
                    ? `${t('fmt.sideQuestion')}${sub.agentOrdinal || sub.sideIndex ? ` #${sub.agentOrdinal || sub.sideIndex}` : ''}`
                    : sub.agentKind === 'swarm_worker'
                      ? `${t('fmt.swarmAgent')}${sub.agentOrdinal || sub.index ? ` #${sub.agentOrdinal || sub.index}` : ''}`
                      : `${t('fmt.subAgent')}${sub.agentOrdinal || sub.index ? ` #${sub.agentOrdinal || sub.index}` : ''}`;
                const roleText =
                  sub.customRole !== undefined
                    ? sub.customRole || fallbackRole
                    : sub.role || sub.shortLabel || fallbackRole;
                patchText(subRefs.subRole, roleText);

                const idleFallbackKey = isKilledSub
                  ? 'live.killed'
                  : isWaitingSub
                    ? 'live.waiting'
                    : 'live.done';
                const subLabel = sub.isRunning
                  ? formatLiveActivityLabel(subAct, 'live.running')
                  : formatLiveActivityLabel(subAct, idleFallbackKey);
                const subDetail = formatLiveActivityDetail(subAct);
                const subProg = subAct.stepProgress ? ` [${subAct.stepProgress}]` : '';
                const summaryStr = showSessionExtras
                  ? sub.isRunning
                    ? `${subLabel}${subProg}${subDetail ? ` · ${subDetail}` : ''}`
                    : isKilledSub
                      ? t('live.killedWithSteps', { steps: sub.stepCount || 0 })
                      : isWaitingSub
                        ? t('live.waitingWithSteps', { steps: sub.stepCount || 0 })
                        : t('live.doneWithSteps', { steps: sub.stepCount || 0 })
                  : [`${subLabel}${subProg}`.trim(), subDetail].filter(Boolean).join(' ');
                patchAttr(subRefs.subSummary, 'hidden', !summaryStr);
                patchText(subRefs.subSummary, summaryStr);

                if (interactive && !showSessionExtras) {
                  patchAttr(
                    subRefs.rowEl,
                    'title',
                    `[${subBadgeText}] ${roleText}${summaryStr ? ` ${summaryStr}` : ''}`
                  );
                }

                if (sub.isRunning) {
                  const subTimerKey = `sub:${sub.cascadeId}`;
                  activeTimerKeys.add(subTimerKey);
                  bindLiveElapsedTimer(
                    subTimerKey,
                    `${sub.cascadeId}:${subAct.signature || subLabel}`,
                    subAct.startedAtMs || sub.lastModifiedMs,
                    subRefs.subElapsed
                  );
                } else {
                  activityTimersMap.delete(`sub:${sub.cascadeId}`);
                  patchText(
                    subRefs.subElapsed,
                    t('header.convMetaSteps', { count: sub.stepCount || 0 })
                  );
                }
              },
            });
            refs.subScroll.refresh();
          }
        },
        destroyRow: (refs) => {
          clearSubExpandAnim(refs);
          refs?.subScroll?.destroy?.();
        },
      });

      for (const key of [...activityTimersMap.keys()]) {
        if (!activeTimerKeys.has(key)) {
          activityTimersMap.delete(key);
        }
      }
      updateLiveElapsedDisplay();
      ensureLiveTicker();
    }

    onCleanup(() => {
      stopLiveTicker();
      patchKeyedList(liveActivityBar, [], {
        destroyRow: (refs) => {
          clearSubExpandAnim(refs);
          refs?.subScroll?.destroy?.();
        },
      });
    });

    return {
      el: liveActivityBar,
      refs: {
        update,
        pauseTicker,
        resumeTicker,
        stopLiveTicker,
      },
    };
  },
});
return { buildFallbackRunningConversations, LiveActivityWidget };
})();

// --- src/registries/widgetRegistry.js ---
const { OVERVIEW_WIDGET_KEYS, OVERVIEW_WIDGET_REGISTRY, getOverviewModuleOptions, createDynamicWidgetHost } = (() => {
/**
 * @fileoverview Decoupled Overview & Hover Widget Registry (`widgetRegistry.js`).
 * Maps module keys (`metrics`, `context`, `quotas`, `live_tasks`) to standalone
 * widget components and provides `createDynamicWidgetHost` for zero-hardcode mounting,
 * live reordering, and clean instance disposal.
 */


const OVERVIEW_WIDGET_KEYS = OVERVIEW_MODULE_KEYS;

const OVERVIEW_WIDGET_REGISTRY = Object.freeze({
  metrics: {
    key: 'metrics',
    labelKey: 'module.metrics',
    create: ({ mode, isVisibleFn, preview, getCtxAgentId }) =>
      MetricMatrixWidget({ mode, isVisibleFn, preview, getCtxAgentId }),
  },
  context: {
    key: 'context',
    labelKey: 'module.context',
    create: ({ mode, isVisibleFn, preview, getCtxAgentId, setCtxAgentId }) =>
      ContextWindowWidget({
        interactiveInspector: mode !== 'hover',
        isVisibleFn,
        preview,
        getCtxAgentId,
        setCtxAgentId,
      }),
  },
  quotas: {
    key: 'quotas',
    labelKey: 'module.quotas',
    create: ({ mode }) =>
      QuotaPoolsWidget({
        compactHover: mode === 'hover',
      }),
  },
  live_tasks: {
    key: 'live_tasks',
    labelKey: 'module.live_tasks',
    create: ({ mode, isVisibleFn, preview, getCtxAgentId }) =>
      LiveActivityWidget({
        interactive: mode !== 'hover',
        isVisibleFn,
        preview,
        getCtxAgentId,
      }),
  },
});

function getOverviewModuleOptions() {
  return OVERVIEW_WIDGET_KEYS.map((key) => ({
    value: key,
    label: t(`module.${key}`),
  }));
}

/**
 * Create a dynamic container host that mounts, reorders, updates, and disposes
 * standalone telemetry widgets based on user-configured module keys.
 *
 * @param {{
 *   containerEl: HTMLElement,
 *   mode?: 'overview' | 'hover',
 *   isVisibleFn?: () => boolean,
 *   initialModuleKeys?: string[]
 * }} options
 */
function createDynamicWidgetHost({
  containerEl,
  mode = 'overview',
  preview = false,
  isVisibleFn = () => true,
  initialModuleKeys = [],
}) {
  const instances = new Map();
  let currentKeys = [];
  let previewCtxAgentId = 'auto';
  let latestUpdatePayload = null;

  const getCtxAgentId = preview ? () => previewCtxAgentId : undefined;
  const setCtxAgentId = preview
    ? (nextId) => {
        previewCtxAgentId = String(nextId || 'auto');
        if (latestUpdatePayload) {
          for (const key of currentKeys) {
            instances.get(key)?.refs?.update?.(latestUpdatePayload);
          }
        }
      }
    : undefined;

  function syncModules(nextKeys) {
    const validKeys = [];
    const seen = new Set();
    for (const rawKey of Array.isArray(nextKeys) ? nextKeys : []) {
      const k = String(rawKey || '').trim();
      if (!k || seen.has(k) || !OVERVIEW_WIDGET_REGISTRY[k]) continue;
      seen.add(k);
      validKeys.push(k);
    }

    // Remove and destroy widgets no longer present
    for (const [existingKey, inst] of [...instances.entries()]) {
      if (!seen.has(existingKey)) {
        try {
          inst.el?.remove?.();
        } catch {}
        try {
          inst.destroy?.();
        } catch {}
        instances.delete(existingKey);
      }
    }

    // Instantiate newly added widgets
    for (const key of validKeys) {
      if (!instances.has(key)) {
        const inst = OVERVIEW_WIDGET_REGISTRY[key].create({
          mode,
          preview,
          isVisibleFn,
          getCtxAgentId,
          setCtxAgentId,
        });
        instances.set(key, inst);
      }
    }

    // Reorder DOM nodes in containerEl only where needed
    const orderChanged =
      validKeys.length !== currentKeys.length ||
      validKeys.some((k, idx) => currentKeys[idx] !== k) ||
      (containerEl.children && containerEl.children.length !== validKeys.length);

    if (orderChanged) {
      for (let i = 0; i < validKeys.length; i += 1) {
        const targetEl = instances.get(validKeys[i]).el;
        const curChild = containerEl.children ? containerEl.children[i] : null;
        if (curChild !== targetEl) {
          if (curChild && typeof containerEl.insertBefore === 'function') {
            containerEl.insertBefore(targetEl, curChild);
          } else {
            containerEl.appendChild(targetEl);
          }
        }
      }
      currentKeys = [...validKeys];
    }

    return validKeys;
  }

  function update({ moduleKeys = [], data = null, minuteTick = undefined } = {}) {
    latestUpdatePayload = { data, minuteTick };
    const validKeys = syncModules(moduleKeys);
    for (const key of validKeys) {
      const inst = instances.get(key);
      inst?.refs?.update?.({ data, minuteTick });
    }
  }

  function pauseTickers() {
    for (const inst of instances.values()) {
      inst?.refs?.pauseTicker?.();
    }
  }

  function resumeTickers() {
    for (const inst of instances.values()) {
      inst?.refs?.resumeTicker?.();
    }
  }

  function getInstance(key) {
    return instances.get(key) || null;
  }

  function destroy() {
    for (const inst of instances.values()) {
      try {
        inst.el?.remove?.();
      } catch {}
      try {
        inst.destroy?.();
      } catch {}
    }
    instances.clear();
    currentKeys = [];
  }

  if (Array.isArray(initialModuleKeys) && initialModuleKeys.length > 0) {
    syncModules(initialModuleKeys);
  }

  return {
    update,
    pauseTickers,
    resumeTickers,
    getInstance,
    getActiveKeys: () => [...currentKeys],
    destroy,
  };
}
return { OVERVIEW_WIDGET_KEYS, OVERVIEW_WIDGET_REGISTRY, getOverviewModuleOptions, createDynamicWidgetHost };
})();

// --- src/registries/stepColumnRegistry.js ---
const { STEP_COLUMN_KEYS, DEFAULT_STEP_COLUMN_KEYS, formatCustomTokenComboHeader, STEP_COLUMN_REGISTRY, getStepColumnOptions } = (() => {
/**
 * @fileoverview Decoupled Step Table Column Registry (`stepColumnRegistry.js`).
 * Defines all 12 customizable columns for `StepsDetailView` ("按步查看"),
 * preserving 100% of the 7 out-of-the-box default columns, clickable agent filter badges,
 * speed reason sub-lines, token combo tooltips, and high-cost highlights.
 */


const STEP_COLUMN_KEYS = STEP_TABLE_COLUMN_KEYS;
const DEFAULT_STEP_COLUMN_KEYS = DEFAULT_STEP_TABLE_COLUMNS;
const DEFAULT_CLIENT_STEP_TOKEN_COMBO_FORMAT = DEFAULT_STEP_TOKEN_COMBO_FORMAT;
const normalizeClientStepTokenComboFormat = normalizeStepTokenComboFormat;
const parseClientStepTokenComboSegments = parseStepTokenComboSegments;

function resolveStepTokenParts(st) {
  const inTok = Math.max(0, Number(st?.inputTokens || 0));
  const cacheTok = Math.max(0, Number(st?.cacheReadTokens || 0));
  const outTok = Math.max(0, Number(st?.outputTokens || 0));
  const thinkTok = Math.max(0, Number(st?.thinkingTokens || 0));
  const respTok =
    st?.responseTokens != null
      ? Math.max(0, Number(st.responseTokens))
      : Math.max(0, outTok - thinkTok);
  const totalTok = inTok + cacheTok + outTok;
  const ctxTok = Math.max(0, Number(st?.contextTokens ?? totalTok));
  return { inTok, cacheTok, outTok, thinkTok, respTok, totalTok, ctxTok };
}

function formatPartWithOptionalCost(tokCount, costVal) {
  const countStr = Math.round(Number(tokCount || 0)).toLocaleString();
  if (costVal != null && Number.isFinite(Number(costVal))) {
    return `${countStr} (${formatUsd(Number(costVal), { precise: true })})`;
  }
  return countStr;
}

function formatCustomTokenComboHeader(rawFormat) {
  const segs = parseClientStepTokenComboSegments(rawFormat);
  return segs.map((seg) => t(`steps.tokSeg.${seg}.th`)).join(' / ');
}

function resolveSegmentDisplay(seg, parts, st) {
  switch (seg) {
    case 'context':
      return {
        short: formatTokens(parts.ctxTok),
        tip: `${t('steps.tokSeg.context.tip')} ${Math.round(parts.ctxTok).toLocaleString()}`,
      };
    case 'in':
      return {
        short: formatTokens(parts.inTok),
        tip: `${t('steps.tokSeg.in.tip')} ${formatPartWithOptionalCost(parts.inTok, st?.inCostUsd)}`,
      };
    case 'out':
      return {
        short: formatTokens(parts.outTok),
        tip: `${t('steps.tokSeg.out.tip')} ${formatPartWithOptionalCost(parts.outTok, st?.outCostUsd)}`,
      };
    case 'cache':
      return {
        short: formatTokens(parts.cacheTok),
        tip: `${t('steps.tokSeg.cache.tip')} ${formatPartWithOptionalCost(parts.cacheTok, st?.cacheCostUsd)}`,
      };
    case 'think':
      return {
        short: formatTokens(parts.thinkTok),
        tip: `${t('steps.tokSeg.think.tip')} ${Math.round(parts.thinkTok).toLocaleString()}`,
      };
    case 'reply':
      return {
        short: formatTokens(parts.respTok),
        tip: `${t('steps.tokSeg.reply.tip')} ${Math.round(parts.respTok).toLocaleString()}`,
      };
    case 'total':
    default:
      return {
        short: formatTokens(parts.totalTok),
        tip: `${t('steps.tokSeg.total.tip')} ${formatPartWithOptionalCost(parts.totalTok, st?.costUsd)}`,
      };
  }
}

function formatStepClockTime(createdAtMs) {
  const ms = Number(createdAtMs || 0);
  if (!(ms > 0) || !Number.isFinite(ms)) {
    return { text: '—', title: '' };
  }
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const hhmmss = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const full = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmmss}`;
  return { text: hhmmss, title: full };
}

const STEP_COLUMN_REGISTRY = Object.freeze({
  step: {
    key: 'step',
    thLabel: () => t('stepCol.step.th'),
    optLabel: () => t('stepCol.step.opt'),
    sigPart: (st) => `${st.stepIndex}`,
    createCell: () => {
      const valEl = h('span');
      const td = h('td', {}, [valEl]);
      return { td, refs: { td, valEl } };
    },
    updateCell: (refs, st) => {
      patchText(refs.valEl, `#${Number(st.stepIndex)}`);
    },
  },

  time: {
    key: 'time',
    thLabel: () => t('stepCol.time.th'),
    optLabel: () => t('stepCol.time.opt'),
    sigPart: (st) => `${st.createdAtMs || 0}`,
    createCell: () => {
      const valEl = h('span');
      const td = h('td', { className: 'text-muted' }, [valEl]);
      return { td, refs: { td, valEl } };
    },
    updateCell: (refs, st) => {
      const { text, title } = formatStepClockTime(st.createdAtMs);
      patchText(refs.valEl, text);
      patchAttr(refs.td, 'title', title || null);
    },
  },

  model: {
    key: 'model',
    thLabel: () => t('stepCol.model.th'),
    optLabel: () => t('stepCol.model.opt'),
    sigPart: (st, ctx) => {
      const disp = resolveModelDisplayInfo(st, ctx.displaySettings, { fallback: '—' });
      return `${disp.baseText}:${disp.compactionSuffix}:${disp.title}`;
    },
    createCell: () => {
      const nameEl = h('span', { className: 'step-model-name' });
      const compactEl = h('span', { className: 'step-model-compact', hidden: true });
      const wrapEl = h('span', { className: 'step-model-cell' }, [nameEl, compactEl]);
      const td = h('td', {}, [wrapEl]);
      return { td, refs: { td, wrapEl, nameEl, compactEl } };
    },
    updateCell: (refs, st, ctx) => {
      const modelDisplay = resolveModelDisplayInfo(st, ctx.displaySettings, { fallback: '—' });
      patchText(refs.nameEl, modelDisplay.baseText);
      const suffix = modelDisplay.compactionSuffix || '';
      patchText(refs.compactEl, suffix);
      patchAttr(refs.compactEl, 'hidden', !suffix);
      patchAttr(refs.td, 'title', modelDisplay.title);
    },
  },

  tps: {
    key: 'tps',
    thLabel: () => t('stepCol.tps.th'),
    optLabel: () => t('stepCol.tps.opt'),
    sigPart: (st, ctx) =>
      `${st.tokPerSec}:${st.selectedSpeedReason || ''}:${ctx?.showStepSpeedColor === true ? 1 : 0}`,
    createCell: () => {
      const speedMain = h('strong', {
        className: 'cell-value tone-muted',
        style: 'font-size: var(--fs-base-sm);',
      });
      const wrapEl = h(
        'span',
        { style: 'display: inline-block; vertical-align: middle;' },
        [speedMain]
      );
      const td = h('td', {}, [wrapEl]);
      return { td, refs: { wrapEl, speedMain, speedReason: null } };
    },
    updateCell: (refs, st, ctx) => {
      patchText(refs.speedMain, formatSpeedMetric(st.tokPerSec, ' tok/s'));
      const hasValidSpeed =
        st.tokPerSec != null && Number.isFinite(Number(st.tokPerSec)) && Number(st.tokPerSec) > 0;
      const toneCls =
        ctx?.showStepSpeedColor === true
          ? getSpeedToneClass(st.tokPerSec)
          : hasValidSpeed
            ? ''
            : 'tone-muted';
      patchAttr(refs.speedMain, 'class', toneCls ? `cell-value ${toneCls}` : 'cell-value');
      const reason = speedReasonText(st.selectedSpeedReason);
      if (reason && !refs.speedReason) {
        refs.speedReason = h('div', {
          className: 'text-muted',
          style: 'font-size: var(--fs-xs);',
        });
        refs.wrapEl.appendChild(refs.speedReason);
      }
      if (refs.speedReason) {
        patchText(refs.speedReason, reason);
        patchAttr(refs.speedReason, 'hidden', !reason);
      }
    },
  },

  ttft: {
    key: 'ttft',
    thLabel: () => t('stepCol.ttft.th'),
    optLabel: () => t('stepCol.ttft.opt'),
    sigPart: (st) => `${st.ttftSec}`,
    createCell: () => {
      const valEl = h('span');
      const td = h('td', {}, [valEl]);
      return { td, refs: { td, valEl } };
    },
    updateCell: (refs, st) => {
      patchText(refs.valEl, formatMetric(st.ttftSec, 's'));
      const tone = getTtftToneClass(st.ttftSec);
      patchAttr(refs.valEl, 'class', tone || null);
    },
  },

  duration: {
    key: 'duration',
    thLabel: () => t('stepCol.duration.th'),
    optLabel: () => t('stepCol.duration.opt'),
    sigPart: (st) => `${st.totalDurationSec ?? st.streamDurationSec ?? ''}`,
    createCell: () => {
      const valEl = h('span');
      const td = h('td', {}, [valEl]);
      return { td, refs: { td, valEl } };
    },
    updateCell: (refs, st) => {
      const dur = st.totalDurationSec ?? st.streamDurationSec ?? null;
      patchText(refs.valEl, formatMetric(dur, 's'));
    },
  },

  tokens_combo: {
    key: 'tokens_combo',
    thLabel: () => t('stepCol.tokens_combo.th'),
    optLabel: () => t('stepCol.tokens_combo.opt'),
    sigPart: (st) =>
      `${st.contextTokens}:${st.outputTokens}:${st.thinkingTokens}:${st.responseTokens}`,
    createCell: () => {
      const valEl = h('span');
      const td = h('td', {}, [valEl]);
      return { td, refs: { td, valEl } };
    },
    updateCell: (refs, st) => {
      const parts = resolveStepTokenParts(st);
      patchText(
        refs.valEl,
        `${formatTokens(parts.ctxTok)} / ${formatTokens(parts.thinkTok)} / ${formatTokens(parts.respTok)}`
      );
      patchAttr(
        refs.td,
        'title',
        t('steps.ctxTitle', {
          ctx: Math.round(parts.ctxTok),
          think: Math.round(parts.thinkTok),
          resp: Math.round(parts.respTok),
        })
      );
    },
  },

  tokens_io_cache: {
    key: 'tokens_io_cache',
    thLabel: () => t('stepCol.tokens_io_cache.th'),
    optLabel: () => t('stepCol.tokens_io_cache.opt'),
    sigPart: (st) =>
      `${st.inputTokens || 0}:${st.outputTokens || 0}:${st.cacheReadTokens || 0}:${st.inCostUsd ?? ''}:${st.outCostUsd ?? ''}:${st.cacheCostUsd ?? ''}`,
    createCell: () => {
      const valEl = h('span');
      const td = h('td', {}, [valEl]);
      return { td, refs: { td, valEl } };
    },
    updateCell: (refs, st) => {
      const parts = resolveStepTokenParts(st);
      patchText(
        refs.valEl,
        `${formatTokens(parts.inTok)} / ${formatTokens(parts.outTok)} / ${formatTokens(parts.cacheTok)}`
      );
      patchAttr(
        refs.td,
        'title',
        t('steps.ioCacheTitle', {
          inPart: formatPartWithOptionalCost(parts.inTok, st?.inCostUsd),
          outPart: formatPartWithOptionalCost(parts.outTok, st?.outCostUsd),
          cachePart: formatPartWithOptionalCost(parts.cacheTok, st?.cacheCostUsd),
        })
      );
    },
  },

  tokens_custom: {
    key: 'tokens_custom',
    thLabel: (ctx) => formatCustomTokenComboHeader(ctx?.stepTokenComboFormat),
    optLabel: (ctx) =>
      t('stepCol.tokens_custom.opt', {
        fmt: formatCustomTokenComboHeader(ctx?.stepTokenComboFormat),
      }),
    sigPart: (st, ctx) =>
      `${normalizeClientStepTokenComboFormat(ctx?.stepTokenComboFormat)}:${st.contextTokens || 0}:${st.inputTokens || 0}:${st.cacheReadTokens || 0}:${st.outputTokens || 0}:${st.thinkingTokens || 0}:${st.responseTokens ?? ''}:${st.costUsd ?? ''}`,
    createCell: () => {
      const valEl = h('span');
      const td = h('td', {}, [valEl]);
      return { td, refs: { td, valEl } };
    },
    updateCell: (refs, st, ctx) => {
      const segs = parseClientStepTokenComboSegments(ctx?.stepTokenComboFormat);
      const parts = resolveStepTokenParts(st);
      const rendered = segs.map((seg) => resolveSegmentDisplay(seg, parts, st));
      patchText(
        refs.valEl,
        rendered.map((r) => r.short).join(' / ')
      );
      patchAttr(
        refs.td,
        'title',
        rendered.map((r) => r.tip).join(' · ')
      );
    },
  },

  input_tokens: {
    key: 'input_tokens',
    thLabel: () => t('stepCol.input_tokens.th'),
    optLabel: () => t('stepCol.input_tokens.opt'),
    sigPart: (st) => `${st.inputTokens || 0}`,
    createCell: () => {
      const valEl = h('span');
      const td = h('td', {}, [valEl]);
      return { td, refs: { td, valEl } };
    },
    updateCell: (refs, st) => {
      patchText(refs.valEl, formatTokens(st.inputTokens || 0));
    },
  },

  cache_tokens: {
    key: 'cache_tokens',
    thLabel: () => t('stepCol.cache_tokens.th'),
    optLabel: () => t('stepCol.cache_tokens.opt'),
    sigPart: (st) => `${st.cacheReadTokens || 0}`,
    createCell: () => {
      const valEl = h('span');
      const td = h('td', {}, [valEl]);
      return { td, refs: { td, valEl } };
    },
    updateCell: (refs, st) => {
      patchText(refs.valEl, formatTokens(st.cacheReadTokens || 0));
    },
  },

  output_tokens: {
    key: 'output_tokens',
    thLabel: () => t('stepCol.output_tokens.th'),
    optLabel: () => t('stepCol.output_tokens.opt'),
    sigPart: (st) => `${st.outputTokens || 0}`,
    createCell: () => {
      const valEl = h('span');
      const td = h('td', {}, [valEl]);
      return { td, refs: { td, valEl } };
    },
    updateCell: (refs, st) => {
      patchText(refs.valEl, formatTokens(st.outputTokens || 0));
    },
  },

  cache: {
    key: 'cache',
    thLabel: () => t('stepCol.cache.th'),
    optLabel: () => t('stepCol.cache.opt'),
    sigPart: (st) =>
      `${st.cacheHitPct ?? 0}:${(st.inputTokens || 0) + (st.cacheReadTokens || 0) > 0 ? 1 : 0}`,
    createCell: () => {
      const valEl = h('span', {
        className: 'cell-value tone-muted',
        style: 'font-size: var(--fs-base-sm);',
      });
      const td = h('td', {}, [valEl]);
      return { td, refs: { td, valEl } };
    },
    updateCell: (refs, st) => {
      const promptTokens = Number(st.inputTokens || 0) + Number(st.cacheReadTokens || 0);
      patchText(refs.valEl, formatCachePct(st.cacheHitPct ?? 0));
      patchAttr(
        refs.valEl,
        'class',
        `cell-value ${getCacheToneClass(st.cacheHitPct ?? 0, promptTokens)}`
      );
    },
  },

  cost: {
    key: 'cost',
    thLabel: () => t('stepCol.cost.th'),
    optLabel: () => t('stepCol.cost.opt'),
    sigPart: (st) => `${st.costUsd}`,
    createCell: () => {
      const valEl = h('span', { style: 'font-weight: 600;' });
      const td = h('td', {}, [valEl]);
      return { td, refs: { td, valEl } };
    },
    updateCell: (refs, st) => {
      const costVal = st.costUsd;
      patchText(refs.valEl, formatUsd(costVal, { precise: true }));
      const tone = getStepCostToneClass(costVal);
      patchAttr(refs.valEl, 'class', tone || null);
    },
  },
});

function getStepColumnOptions(
  stepTokenComboFormat = DEFAULT_CLIENT_STEP_TOKEN_COMBO_FORMAT
) {
  const ctx = { stepTokenComboFormat };
  return STEP_COLUMN_KEYS.map((key) => ({
    value: key,
    label: STEP_COLUMN_REGISTRY[key].optLabel(ctx),
  }));
}
return { STEP_COLUMN_KEYS, DEFAULT_STEP_COLUMN_KEYS, formatCustomTokenComboHeader, STEP_COLUMN_REGISTRY, getStepColumnOptions };
})();

// --- src/components/widgets/CapsuleBarWidget.js ---
const { RING_RADIUS, RING_CIRCUMFERENCE, tokenizeCapsuleOdometerText, patchCapsuleOdometerText, buildCapsuleSlotContext, resolveMultiSessionCapsuleState, createCapsuleSlotNode, syncCapsuleSlotNodes, CapsuleBarWidget } = (() => {
/**
 * @fileoverview Shared Decoupled Capsule Bar Primitives & Widget (`CapsuleBarWidget.js`).
 * Powers both the live host window capsule (`WindowOverlayShell.js`) and the
 * real-UI structure preview (`SettingsStructureTab.js`), ensuring 100% DOM/CSS parity.
 */


const RING_RADIUS = 5.2;
const RING_CIRCUMFERENCE = +(2 * Math.PI * RING_RADIUS).toFixed(2);

const ODOMETER_DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const capsuleOdometerState = new WeakMap();

/**
 * 将胶囊指标文本拆分为「按数位对齐的数字滚轮 + 静态字符片段」：
 * - 整数部分从右向左按位次键控（个位 `i:0`、十位 `i:1`...），小数部分从左向右键控（`f:0`...）；
 * - 位数增减时既有数位节点原地复用，仅发生变化的数字位执行 0.15s 老虎机垂直滚动，未变位与单位纹丝不动。
 *
 * @param {string} rawText
 * @returns {Array<{ key: string, kind: 'digit' | 'static', digit?: number, text?: string }>}
 */
function tokenizeCapsuleOdometerText(rawText) {
  const str = String(rawText ?? '');
  if (!str) return [];
  const parts = str.split(/(\d+(?:\.\d+)?)/g);
  const tokens = [];
  let numIdx = 0;
  let staticIdx = 0;

  for (let p = 0; p < parts.length; p += 1) {
    const seg = parts[p];
    if (!seg) continue;
    if (/^\d+(?:\.\d+)?$/.test(seg)) {
      const dotPos = seg.indexOf('.');
      const intPart = dotPos >= 0 ? seg.slice(0, dotPos) : seg;
      const fracPart = dotPos >= 0 ? seg.slice(dotPos + 1) : '';
      const intLen = intPart.length;
      for (let i = 0; i < intLen; i += 1) {
        const place = intLen - 1 - i;
        tokens.push({
          key: `n:${numIdx}:i:${place}`,
          kind: 'digit',
          digit: Number(intPart[i]),
        });
      }
      if (dotPos >= 0) {
        tokens.push({ key: `n:${numIdx}:dot`, kind: 'static', text: '.' });
        for (let j = 0; j < fracPart.length; j += 1) {
          tokens.push({
            key: `n:${numIdx}:f:${j}`,
            kind: 'digit',
            digit: Number(fracPart[j]),
          });
        }
      }
      numIdx += 1;
    } else {
      tokens.push({ key: `s:${staticIdx}`, kind: 'static', text: seg });
      staticIdx += 1;
    }
  }
  return tokens;
}

function createOdometerDigitReel(initialDigit) {
  const cells = ODOMETER_DIGITS.map((d) => h('span', { className: 'wm-od-cell', text: d }));
  const trackEl = h('span', { className: 'wm-od-track' }, cells);
  patchStyleVar(trackEl, '--od-val', String(initialDigit));
  const digitEl = h('span', { className: 'wm-od-digit', 'aria-hidden': 'true' }, [trackEl]);
  return { el: digitEl, trackEl, kind: 'digit', digit: initialDigit };
}

/**
 * 在实验性新 UI (`[data-modern-ui="true"]`) 下将胶囊数字渲染为 0.15s 老虎机垂直滚轮；
 * 经典 UI 或无数字占位文本（如 `-- t/s`）严格退回原生纯文本 `patchText`，零多余 DOM 与动画。
 */
function patchCapsuleOdometerText(
  el,
  nextValue,
  { resetKey = '', modernUi = undefined } = {}
) {
  if (!el) return false;
  const nextStr = String(nextValue ?? '');
  const isModern = typeof modernUi === 'boolean' ? modernUi : isModernUiActiveForElement(el);
  const prev = capsuleOdometerState.get(el);

  if (!isModern || !/\d/.test(nextStr)) {
    if (prev?.active) {
      while (el.firstChild) el.removeChild(el.firstChild);
      patchAttr(el, 'data-od-active', null);
      patchAttr(el, 'data-od-value', null);
      patchAttr(el, 'aria-label', null);
    }
    const changed = patchText(el, nextStr);
    capsuleOdometerState.set(el, { active: false, text: nextStr, resetKey, nodes: null });
    return changed;
  }

  if (prev?.active && prev.text === nextStr && prev.resetKey === resetKey) {
    return false;
  }

  let nodes;
  if (!prev?.active || prev.resetKey !== resetKey || !(prev.nodes instanceof Map)) {
    while (el.firstChild) el.removeChild(el.firstChild);
    nodes = new Map();
  } else {
    nodes = prev.nodes;
  }

  const tokens = tokenizeCapsuleOdometerText(nextStr);
  const nextKeys = new Set();
  const orderedEls = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    nextKeys.add(tok.key);
    let rec = nodes.get(tok.key);
    if (!rec || rec.kind !== tok.kind) {
      if (rec?.el?.parentNode === el) {
        el.removeChild(rec.el);
      }
      if (tok.kind === 'digit') {
        rec = createOdometerDigitReel(tok.digit);
      } else {
        rec = {
          el: h('span', { className: 'wm-od-static', 'aria-hidden': 'true', text: tok.text }),
          trackEl: null,
          kind: 'static',
          text: tok.text,
        };
      }
      nodes.set(tok.key, rec);
    } else if (tok.kind === 'digit') {
      if (rec.digit !== tok.digit) {
        patchStyleVar(rec.trackEl, '--od-val', String(tok.digit));
        rec.digit = tok.digit;
      }
    } else if (rec.text !== tok.text) {
      patchText(rec.el, tok.text);
      rec.text = tok.text;
    }
    orderedEls.push(rec.el);
  }

  for (const [oldKey, rec] of nodes.entries()) {
    if (!nextKeys.has(oldKey)) {
      if (rec.el?.parentNode === el) {
        el.removeChild(rec.el);
      }
      nodes.delete(oldKey);
    }
  }

  for (let i = 0; i < orderedEls.length; i += 1) {
    const targetNode = orderedEls[i];
    const currentNode = el.children[i] || null;
    if (currentNode !== targetNode) {
      el.insertBefore(targetNode, currentNode);
    }
  }

  patchAttr(el, 'data-od-active', '1');
  patchAttr(el, 'data-od-value', nextStr);
  patchAttr(el, 'aria-label', nextStr);
  capsuleOdometerState.set(el, { active: true, text: nextStr, resetKey, nodes });
  return true;
}

/**
 * Compute shared context ring + 1..5 capsule slot metric payload from telemetry & scoped conversation.
 */
function buildCapsuleSlotContext(
  data,
  { scopedConv = null, overviewConv = null, ctxAgent = null, aggregated = null } = {}
) {
  if (!data) return { hasTelemetry: false };
  const activeConv = data.activeConversation || {};
  const overviewActive = overviewConv || scopedConv || aggregated || activeConv;
  const capActive = scopedConv || aggregated || activeConv || {};
  const ctx = ctxAgent?.context || overviewActive.context || activeConv.context || {};
  const limitTokens = Number(ctx.compactionLimitTokens || ctx.limitTokens || 256000);
  const totalTokens = Number(ctx.totalTokens || 0);
  const usedPct =
    limitTokens > 0 ? Math.min(100, +((totalTokens / limitTokens) * 100).toFixed(1)) : 0;
  const dashOffset = +(
    RING_CIRCUMFERENCE *
    (1 - Math.max(0, Math.min(100, usedPct)) / 100)
  ).toFixed(2);

  const isRunning = Boolean(aggregated?.isRunning || activeConv.isRunning);
  const capInTok = Math.max(0, Number(capActive.inputTokens || 0));
  const capCacheTok = Math.max(0, Number(capActive.cacheReadTokens || 0));
  const capOutTok = Math.max(0, Number(capActive.outputTokens || 0));
  const sessionTokens =
    Number(capActive.stepCount || 0) > 0 ||
    capActive.totalTokens != null ||
    capInTok + capCacheTok + capOutTok > 0
      ? Math.max(0, Number(capActive.totalTokens ?? capInTok + capCacheTok + capOutTok))
      : null;

  return {
    hasTelemetry: true,
    usedPct,
    dashOffset,
    isRunning,
    tps: scopedConv?.latestTokPerSec ?? aggregated?.latestTokPerSec ?? activeConv.latestTokPerSec ?? null,
    avgTps: scopedConv?.avgTokPerSec ?? aggregated?.avgTokPerSec ?? activeConv.avgTokPerSec ?? null,
    ttft: scopedConv?.latestTtftSec ?? aggregated?.latestTtftSec ?? activeConv.latestTtftSec ?? null,
    stepCost:
      scopedConv?.latestStepCostUsd ??
      aggregated?.latestStepCostUsd ??
      activeConv.latestStepCostUsd ??
      null,
    sessionCost:
      scopedConv?.sessionCostUsd ?? aggregated?.sessionCostUsd ?? activeConv.sessionCostUsd ?? null,
    cacheHitPct:
      Number(capActive.stepCount || 0) > 0
        ? capActive.latestCacheHitPct ?? capActive.sessionCacheHitPct ?? null
        : null,
    latestPromptTokens: capActive.latestPromptTokens ?? null,
    sessionTokens,
    quotas: data.quotas,
  };
}

/**
 * Compute multi-session button state & normalized running conversation list.
 */
function resolveMultiSessionCapsuleState(
  data,
  { agents = [], aggregated = null, latestTokPerSec = undefined, contextUsedPct = undefined } = {}
) {
  const rawRunningList = buildFallbackRunningConversations(data, {
    agents,
    aggregated,
    latestTokPerSec,
    contextUsedPct,
  });
  const runningCount = rawRunningList.length;
  const runningSubCount = rawRunningList.reduce(
    (acc, item) => acc + Number(item.runningSubagentCount || 0),
    0
  );
  const runningSwarmCount = rawRunningList.reduce(
    (acc, item) => acc + Number(item.runningSwarmCount || 0),
    0
  );
  const isPureSwarmSubs = runningSubCount > 0 && runningSwarmCount === runningSubCount;
  const hasWaiting = rawRunningList.some((item) => item.mainActivity?.phase === 'waiting');
  const multiBtnText =
    runningCount > 0
      ? runningSubCount > 0
        ? t(isPureSwarmSubs ? 'capsule.multiRunningWithSwarm' : 'capsule.multiRunningWithSubs', {
            count: runningCount,
            subs: runningSubCount,
          })
        : t('capsule.multiRunning', { count: runningCount })
      : t('capsule.multiZero');
  return {
    rawRunningList,
    runningCount,
    runningSubCount,
    runningSwarmCount,
    hasWaiting,
    multiBtnText,
  };
}

/**
 * Create a single reusable capsule metric slot node (`0..4`) with an optional SVG context ring.
 */
function createCapsuleSlotNode(slotIndex, initialMetric) {
  const ringSvg = document.createElementNS(SVG_NS, 'svg');
  ringSvg.setAttribute('viewBox', '0 0 14 14');
  ringSvg.setAttribute('class', 'wm-ring-svg');
  ringSvg.setAttribute('aria-hidden', 'true');

  const ringTrack = document.createElementNS(SVG_NS, 'circle');
  ringTrack.setAttribute('cx', '7');
  ringTrack.setAttribute('cy', '7');
  ringTrack.setAttribute('r', String(RING_RADIUS));
  ringTrack.setAttribute('class', 'wm-ring-track');

  const ringFill = document.createElementNS(SVG_NS, 'circle');
  ringFill.setAttribute('cx', '7');
  ringFill.setAttribute('cy', '7');
  ringFill.setAttribute('r', String(RING_RADIUS));
  ringFill.setAttribute('class', 'wm-ring-fill');
  ringFill.setAttribute('stroke-dasharray', String(RING_CIRCUMFERENCE));
  ringFill.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE));

  ringSvg.appendChild(ringTrack);
  ringSvg.appendChild(ringFill);

  const isNone = initialMetric === 'none';
  const isCtx = initialMetric === 'context';
  const textSpan = h('span', {
    className: isCtx ? 'wm-slot-text wm-ctx-pct' : 'wm-slot-text',
    text: isNone
      ? ''
      : isCtx
        ? '--%'
        : initialMetric === 'tps'
          ? '-- t/s'
          : initialMetric === 'ttft'
            ? '--s'
            : t('capsule.quotaUnknown'),
  });
  const el = h(
    'span',
    {
      className: isNone
        ? 'wm-cap-slot'
        : isCtx
          ? 'wm-cap-slot wm-ctx-seg'
          : initialMetric === 'tps'
            ? 'wm-cap-slot wm-seg-speed'
            : initialMetric === 'ttft'
              ? 'wm-cap-slot wm-seg-metric'
              : 'wm-cap-slot wm-seg-quota',
      hidden: isNone,
      'data-slot-idx': String(slotIndex),
      'data-metric': initialMetric,
      'data-vis-rank': isNone ? '' : String(slotIndex + 1),
    },
    isCtx ? [ringSvg, textSpan] : [textSpan]
  );

  return {
    el,
    ringSvg,
    ringFill,
    textSpan,
    ringMounted: isCtx,
  };
}

/**
 * Patch 5 pre-allocated capsule slots and 4 separators in-place via `metricRegistry`.
 */
function syncCapsuleSlotNodes(capsuleSlots, capsuleSeps, slotKeys, slotCtx) {
  let visRank = 0;
  const visRanks = [0, 0, 0, 0, 0];
  for (let i = 0; i < capsuleSlots.length; i += 1) {
    const slot = capsuleSlots[i];
    const metricKey = i < slotKeys.length ? slotKeys[i] : 'none';
    const pres = resolveCapsuleMetricPresentation(metricKey, slotCtx, RING_CIRCUMFERENCE);
    if (pres.hidden) {
      patchAttr(slot.el, 'hidden', true);
      patchAttr(slot.el, 'data-metric', 'none');
      patchAttr(slot.el, 'data-vis-rank', '');
      continue;
    }
    visRank += 1;
    visRanks[i] = visRank;
    patchAttr(slot.el, 'hidden', false);
    patchAttr(slot.el, 'data-metric', pres.metric);
    patchAttr(slot.el, 'data-vis-rank', String(visRank));

    if (pres.showRing && !slot.ringMounted) {
      slot.el.insertBefore(slot.ringSvg, slot.textSpan);
      slot.ringMounted = true;
    } else if (!pres.showRing && slot.ringMounted) {
      slot.ringSvg.remove();
      slot.ringMounted = false;
    }

    const toneCls =
      pres.toneClass || (pres.danger ? 'tone-danger' : pres.warn ? 'tone-warn' : '');
    const fullSegClass = `${pres.segClass}${pres.running ? ' state-running' : ''}${toneCls ? ` ${toneCls}` : ''}`;
    patchAttr(slot.el, 'class', fullSegClass);
    const fullTextClass = `${pres.textClass}${toneCls ? ` ${toneCls}` : ''}`;
    patchAttr(slot.textSpan, 'class', fullTextClass);
    patchCapsuleOdometerText(slot.textSpan, pres.text, { resetKey: pres.metric });

    if (pres.showRing) {
      slot.ringFill.setAttribute('stroke-dashoffset', String(pres.dashOffset));
      patchClasses(slot.ringFill, { 'tone-warn': pres.warn, 'tone-danger': pres.danger });
    }
  }

  for (let s = 0; s < capsuleSeps.length; s += 1) {
    const sepEl = capsuleSeps[s];
    const nextRank = visRanks[s + 1] || 0;
    const showSep = nextRank >= 2;
    patchAttr(sepEl, 'hidden', !showSep);
    patchAttr(sepEl, 'data-sep-for-rank', showSep ? String(nextRank) : '');
  }
}

/**
 * Standalone Capsule Bar Preview Widget mounting the real `.wm-multi-btn` and `.wm-capsule-btn`
 * inside a contextual host bar (`dual` titlebar, `composer` toolbar, or `sidebar` disabled state).
 */
const CapsuleBarWidget = defineComponent({
  name: 'CapsuleBarWidget',
  setup() {
    const multiDot = h('span', { className: 'wm-multi-dot' });
    const multiLabel = h('span', {
      className: 'wm-multi-label',
      text: t('capsule.multiZero'),
    });
    const multiBtn = h(
      'button',
      {
        type: 'button',
        className: 'wm-multi-btn',
        tabindex: '-1',
        'aria-hidden': 'true',
      },
      [multiDot, multiLabel]
    );

    const capsuleSlots = [
      createCapsuleSlotNode(0, 'tps'),
      createCapsuleSlotNode(1, 'ttft'),
      createCapsuleSlotNode(2, 'context'),
      createCapsuleSlotNode(3, 'none'),
      createCapsuleSlotNode(4, 'none'),
    ];
    const capsuleSeps = [
      h('span', { className: 'wm-sep wm-sep-speed', 'data-sep-for-rank': '2' }),
      h('span', { className: 'wm-sep wm-sep-quota', 'data-sep-for-rank': '3' }),
      h('span', { className: 'wm-sep', 'data-sep-for-rank': '', hidden: true }),
      h('span', { className: 'wm-sep', 'data-sep-for-rank': '', hidden: true }),
    ];

    const capsuleBtn = h(
      'button',
      {
        type: 'button',
        className: 'wm-capsule-btn',
        tabindex: '-1',
        'aria-hidden': 'true',
      },
      [
        capsuleSlots[0].el,
        capsuleSeps[0],
        capsuleSlots[1].el,
        capsuleSeps[1],
        capsuleSlots[2].el,
        capsuleSeps[2],
        capsuleSlots[3].el,
        capsuleSeps[3],
        capsuleSlots[4].el,
      ]
    );

    const capsuleCluster = h('div', { className: 'preview-capsule-cluster' }, [
      multiBtn,
      capsuleBtn,
    ]);

    // Contextual host chrome affordances for Titlebar vs Composer vs Sidebar-only
    const titlebarLeftMock = h('div', { className: 'preview-host-left is-titlebar' }, [
      h('span', { className: 'preview-win-title', text: 'Antigravity' }),
    ]);
    const composerLeftMock = h(
      'div',
      { className: 'preview-host-left is-composer', hidden: true },
      [
        h('span', { className: 'preview-composer-chip' }, [
          h('span', { text: 'Auto' }),
          createSvgIcon('chevron-down', { size: 10 }),
        ]),
        h('span', { className: 'preview-composer-chip' }, [
          h('span', { text: 'Carbon (High)' }),
          createSvgIcon('chevron-down', { size: 10 }),
        ]),
      ]
    );

    const composerSendMock = h(
      'span',
      { className: 'preview-composer-send', 'aria-hidden': 'true', hidden: true },
      [createSvgIcon('arrow-up', { size: 11 })]
    );

    const hostBarEl = h(
      'div',
      { className: 'preview-capsule-bar', 'data-mount-mode': 'dual' },
      [titlebarLeftMock, composerLeftMock, capsuleCluster, composerSendMock]
    );

    const sidebarHintEl = h('div', {
      className: 'preview-sidebar-note',
      hidden: true,
      text: t('settings.str.previewMountSidebarHint'),
    });

    const rootEl = h('div', { className: 'capsule-preview-widget' }, [hostBarEl, sidebarHintEl]);

    function update({ data } = {}) {
      const settings = data?.settings || {};
      const mountMode = normalizeClientWindowMountMode(
        settings.windowMountMode,
        settings.enableWindowOverlay
      );
      const showMulti = settings.showTopbarMultiSession !== false;
      const slotKeys = normalizeClientTopbarSlots(settings.topbarCapsuleSlots);

      const isComposer = mountMode === 'composer';
      const isSidebar = mountMode === 'sidebar';
      patchAttr(hostBarEl, 'data-mount-mode', mountMode);
      patchClasses(hostBarEl, {
        'is-composer': isComposer,
        'is-sidebar-only': isSidebar,
      });

      patchAttr(titlebarLeftMock, 'hidden', isComposer);
      patchAttr(composerLeftMock, 'hidden', !isComposer);
      patchAttr(composerSendMock, 'hidden', !isComposer);
      patchAttr(sidebarHintEl, 'hidden', !isSidebar);
      patchText(sidebarHintEl, t('settings.str.previewMountSidebarHint'));

      patchAttr(multiBtn, 'hidden', !showMulti);

      if (!data) {
        patchClasses(multiBtn, { 'is-running': false, 'is-waiting': false });
        patchCapsuleOdometerText(multiLabel, t('capsule.multiZero'), { resetKey: 'multi' });
        syncCapsuleSlotNodes(capsuleSlots, capsuleSeps, slotKeys, { hasTelemetry: false });
        return;
      }

      const { agents, scopedConv, ctxAgent, aggregated } = resolveScopedConversation(
        data,
        'all',
        'auto'
      );
      const slotCtx = buildCapsuleSlotContext(data, { scopedConv, ctxAgent, aggregated });
      const { runningCount, hasWaiting, multiBtnText } = resolveMultiSessionCapsuleState(data, {
        agents,
        aggregated,
        contextUsedPct: slotCtx.usedPct,
      });

      patchClasses(multiBtn, {
        'is-running': runningCount > 0 && !hasWaiting,
        'is-waiting': runningCount > 0 && hasWaiting,
      });
      patchCapsuleOdometerText(multiLabel, multiBtnText, { resetKey: 'multi' });

      patchClasses(capsuleBtn, { 'is-running': slotCtx.isRunning });
      syncCapsuleSlotNodes(capsuleSlots, capsuleSeps, slotKeys, slotCtx);
    }

    return {
      el: rootEl,
      refs: {
        update,
        multiBtn,
        capsuleBtn,
        capsuleSlots,
        capsuleSeps,
        hostBarEl,
      },
    };
  },
});
return { RING_RADIUS, RING_CIRCUMFERENCE, tokenizeCapsuleOdometerText, patchCapsuleOdometerText, buildCapsuleSlotContext, resolveMultiSessionCapsuleState, createCapsuleSlotNode, syncCapsuleSlotNodes, CapsuleBarWidget };
})();

// --- src/components/widgets/StepTableWidget.js ---
const { formatTurnPromptText, StepTableWidget } = (() => {
/**
 * @fileoverview Reusable Decoupled Step Table Widget (`StepTableWidget.js`).
 * Powers both `StepsDetailView` ("按步查看") and `SettingsStructureTab` live preview,
 * dynamically rendering 2..12 columns via `stepColumnRegistry.js`, turn rail + prompt
 * preview tooltips, and independent Main/Sub agent badges.
 */


function formatTurnPromptText(rawPrompt, { hasMedia = false, mediaOnly = false } = {}) {
  const text = String(rawPrompt || '').trim();
  if (mediaOnly || (!text && hasMedia)) return t('steps.turnMediaOnly');
  if (!text) return '';
  return hasMedia ? `${text} ${t('steps.turnMediaSuffix')}` : text;
}

const VIRTUAL_ROW_THRESHOLD = 80;
const VIRTUAL_OVERSCAN_ROWS = 16;
const VIRTUAL_REFILL_MARGIN = 6;
const MAX_ROW_POOL_SIZE = 96;
const FALLBACK_VIEWPORT_H = 560;
const BASE_SINGLE_ROW_H = 28;
const BASE_REASON_ROW_H = 42;
const SIZER_ROW_KEY = '__vsizer__';
const SPACER_TOP_KEY = '__vspacer_top__';
const SPACER_BOTTOM_KEY = '__vspacer_bottom__';

function estTokenChars(val) {
  const n = Math.max(0, Number(val || 0));
  if (n >= 1_000_000) return n >= 10_000_000 ? 6 : 5;
  if (n >= 100_000) return 6;
  if (n >= 10_000) return 5;
  if (n >= 1_000) return 4;
  if (n >= 100) return 3;
  if (n >= 10) return 2;
  return 1;
}

function estCostChars(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return 1;
  if (n >= 100) return 7;
  if (n >= 10) return 6;
  if (n >= 0.01) return 5;
  return 7;
}

function estSegmentChars(seg, st) {
  const inTok = Math.max(0, Number(st?.inputTokens || 0));
  const cacheTok = Math.max(0, Number(st?.cacheReadTokens || 0));
  const outTok = Math.max(0, Number(st?.outputTokens || 0));
  const thinkTok = Math.max(0, Number(st?.thinkingTokens || 0));
  const respTok =
    st?.responseTokens != null
      ? Math.max(0, Number(st.responseTokens))
      : Math.max(0, outTok - thinkTok);
  switch (seg) {
    case 'context':
      return estTokenChars(st?.contextTokens ?? inTok + cacheTok + outTok);
    case 'in':
      return estTokenChars(inTok);
    case 'out':
      return estTokenChars(outTok);
    case 'cache':
      return estTokenChars(cacheTok);
    case 'think':
      return estTokenChars(thinkTok);
    case 'reply':
      return estTokenChars(respTok);
    case 'total':
    default:
      return estTokenChars(inTok + cacheTok + outTok);
  }
}

function resolveBadgeTextForStep(st) {
  return formatAgentBadgeText({
    agentKind:
      st?.agentKind ||
      (!st?.isSubagent ? 'main' : st?.isSideQuestion ? 'side_question' : 'subagent'),
    agentOrdinal:
      st?.agentOrdinal || (st?.isSideQuestion ? st?.sideIndex || 0 : st?.agentIndex || 0),
    isMain: !st?.isSubagent,
    isSideQuestion: Boolean(st?.isSideQuestion),
    sideIndex: st?.sideIndex || 0,
    index: st?.agentIndex || 0,
    badgeText: st?.agentBadge,
  });
}

function buildColumnSizerSpec(tableSteps, colKeys, wantedSet, cellCtx) {
  const firstStep = tableSteps[0] || {};
  const colSteps = {};
  const needStep = wantedSet.has('step');
  const needTime = wantedSet.has('time');
  const needModel = wantedSet.has('model');
  const needTps = wantedSet.has('tps');
  const needTtft = wantedSet.has('ttft');
  const needDuration = wantedSet.has('duration');
  const needTokensCombo = wantedSet.has('tokens_combo');
  const needTokensIoCache = wantedSet.has('tokens_io_cache');
  const needTokensCustom = wantedSet.has('tokens_custom');
  const needInput = wantedSet.has('input_tokens');
  const needCacheTok = wantedSet.has('cache_tokens');
  const needOutput = wantedSet.has('output_tokens');
  const needCachePct = wantedSet.has('cache');
  const needCost = wantedSet.has('cost');
  const customSegs = needTokensCustom
    ? parseStepTokenComboSegments(cellCtx?.stepTokenComboFormat)
    : null;

  let bestStepNum = -1;
  let bestStepObj = firstStep;
  let bestTimeObj = null;
  const modelCandidates = needModel ? new Map() : null;
  let maxTpsVal = -1;
  let maxTpsObj = null;
  const reasonCandidates = needTps ? new Set() : null;
  let maxTtftVal = -1;
  let bestTtftObj = firstStep;
  let maxDurVal = -1;
  let bestDurObj = firstStep;
  let bestComboScore = -1;
  let bestComboObj = firstStep;
  let bestIoCacheScore = -1;
  let bestIoCacheObj = firstStep;
  let bestCustomScore = -1;
  let bestCustomObj = firstStep;
  let maxInputVal = -1;
  let bestInputObj = firstStep;
  let maxCacheTokVal = -1;
  let bestCacheTokObj = firstStep;
  let maxOutputVal = -1;
  let bestOutputObj = firstStep;
  let bestCachePctScore = -1;
  let bestCachePctObj = firstStep;
  let bestCostScore = -1;
  let bestCostObj = firstStep;

  let bestBadgeText = '';
  let bestBadgeClass = '';
  const badgeCandidates = cellCtx?.showAgentBadge ? new Set() : null;

  for (let i = 0; i < tableSteps.length; i++) {
    const st = tableSteps[i];
    if (!st || typeof st !== 'object') continue;

    if (badgeCandidates) {
      const bKey = `${st.agentKind || ''}|${st.isSubagent ? 1 : 0}|${st.isSideQuestion ? 1 : 0}|${st.agentOrdinal || 0}|${st.sideIndex || 0}|${st.agentIndex || 0}|${st.agentBadge || ''}`;
      if (!badgeCandidates.has(bKey)) {
        badgeCandidates.add(bKey);
        const text = resolveBadgeTextForStep(st);
        if (text.length > bestBadgeText.length) {
          bestBadgeText = text;
          bestBadgeClass = getAgentBadgeClass(st.agentIndex || 0, !st.isSubagent);
        }
      }
    }

    if (needStep) {
      const idxNum = Number(st.stepIndex) || 0;
      if (idxNum > bestStepNum) {
        bestStepNum = idxNum;
        bestStepObj = st;
      }
    }

    if (needTime && !bestTimeObj && Number(st.createdAtMs || 0) > 0) {
      bestTimeObj = st;
    }

    if (modelCandidates) {
      const mKey = `${st.baseModelShort || st.modelShort || ''}|${st.baseModelLabel || st.modelLabel || ''}|${st.rawModel || ''}|${st.isCompactionStep ? 1 : 0}`;
      if (!modelCandidates.has(mKey)) {
        modelCandidates.set(mKey, st);
      }
    }

    if (needTps) {
      const tpsVal = Number(st.tokPerSec);
      if (Number.isFinite(tpsVal) && tpsVal >= 0) {
        const tpsScore =
          (tpsVal >= 100 ? String(Math.round(tpsVal)).length : tpsVal.toFixed(1).length) * 1e6 +
          tpsVal;
        if (tpsScore > maxTpsVal) {
          maxTpsVal = tpsScore;
          maxTpsObj = st;
        }
      }
      if (st.selectedSpeedReason) {
        reasonCandidates.add(st.selectedSpeedReason);
      }
    }

    if (needTtft) {
      const v = Number(st.ttftSec);
      if (Number.isFinite(v) && v > maxTtftVal) {
        maxTtftVal = v;
        bestTtftObj = st;
      }
    }

    if (needDuration) {
      const v = Number(st.totalDurationSec ?? st.streamDurationSec);
      if (Number.isFinite(v) && v > maxDurVal) {
        maxDurVal = v;
        bestDurObj = st;
      }
    }

    if (needTokensCombo) {
      const inTok = Math.max(0, Number(st.inputTokens || 0));
      const cacheTok = Math.max(0, Number(st.cacheReadTokens || 0));
      const outTok = Math.max(0, Number(st.outputTokens || 0));
      const thinkTok = Math.max(0, Number(st.thinkingTokens || 0));
      const respTok =
        st.responseTokens != null
          ? Math.max(0, Number(st.responseTokens))
          : Math.max(0, outTok - thinkTok);
      const ctxTok = Math.max(0, Number(st.contextTokens ?? inTok + cacheTok + outTok));
      const score =
        (estTokenChars(ctxTok) + estTokenChars(thinkTok) + estTokenChars(respTok)) * 1e9 +
        ctxTok;
      if (score > bestComboScore) {
        bestComboScore = score;
        bestComboObj = st;
      }
    }

    if (needTokensIoCache) {
      const inTok = Math.max(0, Number(st.inputTokens || 0));
      const outTok = Math.max(0, Number(st.outputTokens || 0));
      const cacheTok = Math.max(0, Number(st.cacheReadTokens || 0));
      const score =
        (estTokenChars(inTok) + estTokenChars(outTok) + estTokenChars(cacheTok)) * 1e9 +
        cacheTok;
      if (score > bestIoCacheScore) {
        bestIoCacheScore = score;
        bestIoCacheObj = st;
      }
    }

    if (needTokensCustom && customSegs) {
      let chars = 0;
      for (let s = 0; s < customSegs.length; s++) {
        chars += estSegmentChars(customSegs[s], st);
      }
      if (chars > bestCustomScore) {
        bestCustomScore = chars;
        bestCustomObj = st;
      }
    }

    if (needInput) {
      const v = Math.max(0, Number(st.inputTokens || 0));
      const score = estTokenChars(v) * 1e9 + v;
      if (score > maxInputVal) {
        maxInputVal = score;
        bestInputObj = st;
      }
    }

    if (needCacheTok) {
      const v = Math.max(0, Number(st.cacheReadTokens || 0));
      const score = estTokenChars(v) * 1e9 + v;
      if (score > maxCacheTokVal) {
        maxCacheTokVal = score;
        bestCacheTokObj = st;
      }
    }

    if (needOutput) {
      const v = Math.max(0, Number(st.outputTokens || 0));
      const score = estTokenChars(v) * 1e9 + v;
      if (score > maxOutputVal) {
        maxOutputVal = score;
        bestOutputObj = st;
      }
    }

    if (needCachePct) {
      const pct = Number(st.cacheHitPct ?? 0);
      const hasDec = pct > 0 && pct < 100 && Math.abs(pct - Math.round(pct)) > 1e-6;
      const score = pct >= 100 ? 4 : hasDec ? (pct >= 10 ? 5 : 4) : pct >= 10 ? 3 : 2;
      if (score > bestCachePctScore) {
        bestCachePctScore = score;
        bestCachePctObj = st;
      }
    }

    if (needCost) {
      const c = Number(st.costUsd);
      const score = estCostChars(c) * 1e6 + (Number.isFinite(c) && c > 0 ? c : 0);
      if (score > bestCostScore) {
        bestCostScore = score;
        bestCostObj = st;
      }
    }
  }

  if (needStep) colSteps.step = bestStepObj;
  if (needTime) colSteps.time = bestTimeObj || firstStep;
  if (needModel && modelCandidates) {
    let bestModelLen = -1;
    let bestModelObj = firstStep;
    for (const cand of modelCandidates.values()) {
      const disp = resolveModelDisplayInfo(cand, cellCtx?.displaySettings, { fallback: '—' });
      const len = (disp.baseText?.length || 0) + (disp.compactionSuffix?.length || 0);
      if (len > bestModelLen) {
        bestModelLen = len;
        bestModelObj = cand;
      }
    }
    colSteps.model = bestModelObj;
  }
  if (needTps) {
    let longestReasonKey = null;
    let longestReasonLen = 0;
    if (reasonCandidates) {
      for (const rk of reasonCandidates) {
        const txt = speedReasonText(rk);
        if (txt && txt.length > longestReasonLen) {
          longestReasonLen = txt.length;
          longestReasonKey = rk;
        }
      }
    }
    colSteps.tps = {
      ...(maxTpsObj || firstStep),
      tokPerSec: maxTpsVal > 0 ? maxTpsVal : firstStep.tokPerSec,
      selectedSpeedReason: longestReasonKey,
    };
  }
  if (needTtft) colSteps.ttft = bestTtftObj;
  if (needDuration) colSteps.duration = bestDurObj;
  if (needTokensCombo) colSteps.tokens_combo = bestComboObj;
  if (needTokensIoCache) colSteps.tokens_io_cache = bestIoCacheObj;
  if (needTokensCustom) colSteps.tokens_custom = bestCustomObj;
  if (needInput) colSteps.input_tokens = bestInputObj;
  if (needCacheTok) colSteps.cache_tokens = bestCacheTokObj;
  if (needOutput) colSteps.output_tokens = bestOutputObj;
  if (needCachePct) colSteps.cache = bestCachePctObj;
  if (needCost) colSteps.cost = bestCostObj;

  const sigParts = colKeys.map((colKey) => {
    const st = colSteps[colKey] || firstStep;
    return `${colKey}=${STEP_COLUMN_REGISTRY[colKey].sigPart(st, cellCtx)}`;
  });
  return {
    colSteps,
    badgeText: bestBadgeText,
    badgeClass: bestBadgeClass,
    sig: `sizer:${bestBadgeText}:${sigParts.join('|')}`,
  };
}

const StepTableWidget = defineComponent({
  name: 'StepTableWidget',
  setup({ props, onCleanup }) {
    const standalone = Boolean(props.standalone);
    const interactiveBadges = props.interactiveBadges !== false;
    const onSelectAgentScopes =
      typeof props.onSelectAgentScopes === 'function' ? props.onSelectAgentScopes : null;
    const onVirtualHeightChange =
      typeof props.onVirtualHeightChange === 'function' ? props.onVirtualHeightChange : null;

    const stepsTheadRow = h('tr');
    const stepsThead = h('thead', {}, [stepsTheadRow]);
    const stepsTbody = h('tbody');

    function syncTableHeaderColumns(colKeys, headerCtx = {}) {
      const locale = getEffectiveLocale();
      const fmtKey = normalizeClientStepTokenComboFormat(headerCtx?.stepTokenComboFormat);
      const ctx = { stepTokenComboFormat: fmtKey };
      patchKeyedList(stepsTheadRow, colKeys, {
        keyFn: (colKey) => colKey,
        sigFn: (colKey) => `${locale}:${colKey}:${fmtKey}:${STEP_COLUMN_REGISTRY[colKey].thLabel(ctx)}`,
        createRow: (colKey) => {
          const th = h('th', { text: STEP_COLUMN_REGISTRY[colKey].thLabel(ctx) });
          return { el: th, refs: { th } };
        },
        updateRow: (refs, colKey) => {
          patchText(refs.th, STEP_COLUMN_REGISTRY[colKey].thLabel(ctx));
        },
      });
    }

    syncTableHeaderColumns(DEFAULT_STEP_COLUMN_KEYS);

    const stepsTableEl = h('table', { className: 'data-table steps-data-table' }, [
      stepsThead,
      stepsTbody,
    ]);
    const stepsTablePane = h('div', { className: 'table-viewport is-step-table' }, [stepsTableEl]);

    const turnTipEl = h('div', {
      className: 'turn-prompt-tip',
      role: 'tooltip',
      hidden: true,
    });
    const hideTurnTip = () => patchAttr(turnTipEl, 'hidden', true);

    const anomalyTipTitleEl = h('div', { className: 'step-anomaly-tip-title' });
    const anomalyTipSubEl = h('div', { className: 'step-anomaly-tip-sub text-mono', hidden: true });
    const anomalyTipHeadEl = h('div', { className: 'step-anomaly-tip-head' }, [
      anomalyTipTitleEl,
      anomalyTipSubEl,
    ]);
    const anomalyTipListEl = h('div', { className: 'step-anomaly-tip-list' });
    const anomalyTipHintEl = h('div', { className: 'step-anomaly-tip-hint', hidden: true });
    const anomalyTipEl = h(
      'div',
      {
        className: 'step-anomaly-tip',
        role: 'tooltip',
        hidden: true,
      },
      [anomalyTipHeadEl, anomalyTipListEl, anomalyTipHintEl]
    );
    const hideAnomalyTip = () => patchAttr(anomalyTipEl, 'hidden', true);

    const standaloneHostEl = standalone
      ? h('div', { className: 'step-table-preview-host' }, [
          stepsTablePane,
          turnTipEl,
          anomalyTipEl,
        ])
      : null;

    let boundsContainerGetter =
      typeof props.getBoundsEl === 'function'
        ? props.getBoundsEl
        : () => standaloneHostEl || stepsTablePane;

    function setBoundsElGetter(fn) {
      if (typeof fn === 'function') {
        boundsContainerGetter = fn;
      }
    }

    function positionFloatingTip(tipEl, anchorEl) {
      const boundsEl = boundsContainerGetter?.();
      if (
        !boundsEl ||
        typeof boundsEl.getBoundingClientRect !== 'function' ||
        typeof anchorEl?.getBoundingClientRect !== 'function'
      ) {
        return;
      }
      const panelRect = boundsEl.getBoundingClientRect();
      const anchorRect = anchorEl.getBoundingClientRect();
      if (!(panelRect.width > 0 && panelRect.height > 0)) return;
      const tipH = tipEl.offsetHeight || 56;
      const tipW = tipEl.offsetWidth || 220;
      const placeAbove =
        panelRect.bottom - anchorRect.bottom < tipH + 10 &&
        anchorRect.top - panelRect.top > tipH + 6;
      const topPx = placeAbove
        ? Math.max(4, Math.round(anchorRect.top - panelRect.top - tipH - 5))
        : Math.round(anchorRect.bottom - panelRect.top + 5);
      const maxLeft = Math.max(6, Math.round(panelRect.width - tipW - 8));
      const leftPx = Math.min(
        maxLeft,
        Math.max(6, Math.round(anchorRect.left - panelRect.left))
      );
      tipEl.style.top = `${topPx}px`;
      tipEl.style.left = `${leftPx}px`;
    }

    function showTurnTip(anchorCell, promptText) {
      const text = String(promptText || '').trim();
      if (!anchorCell || !text) {
        hideTurnTip();
        return;
      }
      hideAnomalyTip();
      patchText(turnTipEl, text);
      patchAttr(turnTipEl, 'hidden', false);
      positionFloatingTip(turnTipEl, anchorCell);
    }

    function showAnomalyTip(anchorEl, diag) {
      if (!anchorEl || !diag || !diag.title) {
        hideAnomalyTip();
        return;
      }
      hideTurnTip();
      patchClasses(anomalyTipEl, { 'is-danger': diag.severity === 'danger' });
      patchText(anomalyTipTitleEl, diag.title);
      patchAttr(anomalyTipSubEl, 'hidden', !diag.sub);
      if (diag.sub) patchText(anomalyTipSubEl, diag.sub);

      while (anomalyTipListEl.firstChild) {
        anomalyTipListEl.removeChild(anomalyTipListEl.firstChild);
      }
      const rows = Array.isArray(diag.rows) ? diag.rows : [];
      for (const row of rows) {
        const lineEl = h('div', {
          className: `step-anomaly-tip-row${row.danger ? ' is-danger' : ''}`,
          text: row.text,
        });
        const itemChildren = [lineEl];
        if (row.detail) {
          itemChildren.push(
            h('div', {
              className: 'step-anomaly-tip-detail text-mono',
              text: row.detail,
            })
          );
        }
        anomalyTipListEl.appendChild(h('div', { className: 'step-anomaly-tip-item' }, itemChildren));
      }
      patchAttr(anomalyTipListEl, 'hidden', rows.length === 0);

      patchAttr(anomalyTipHintEl, 'hidden', !diag.hint);
      if (diag.hint) patchText(anomalyTipHintEl, diag.hint);

      patchAttr(anomalyTipEl, 'hidden', false);
      positionFloatingTip(anomalyTipEl, anchorEl);
    }

    const hoverRows = new WeakMap();
    let lastRenderedRows = null;
    let lastRenderOptions = '';
    let trackedCascadeId = null;
    let lastAbsorbedAllSteps = null;
    const seenStepKeys = new Set();
    const maxSeenStepByAgent = new Map();
    const activeEnterTimers = new Map();

    // Virtualization state (activates transparently only when !standalone && rowCount > 80)
    let activeDataset = null;
    let renderedSliceStart = -1;
    let renderedSliceEnd = -1;
    let renderedTopSpacerH = -1;
    let renderedBottomSpacerH = -1;
    let scrollRafId = 0;
    let calibrateRafId = 0;
    let lastFontScale = 1;
    let calibratedSingleRowH = 0;
    let calibratedReasonRowH = 0;
    const rowPool = [];

    function readUiFontScale() {
      try {
        if (typeof getComputedStyle === 'function') {
          const target =
            stepsTableEl || (typeof document !== 'undefined' ? document.documentElement : null);
          if (target) {
            const raw = getComputedStyle(target)?.getPropertyValue?.('--ui-font-scale');
            const parsed = Number.parseFloat(raw);
            if (Number.isFinite(parsed) && parsed >= 0.5 && parsed <= 2.5) {
              return parsed;
            }
          }
        }
      } catch {
        // Fallback to default scale in headless/mock environments.
      }
      return 1;
    }

    function getEstRowHeights() {
      const single =
        calibratedSingleRowH > 0
          ? calibratedSingleRowH
          : Math.round(BASE_SINGLE_ROW_H * lastFontScale);
      const reason =
        calibratedReasonRowH > 0
          ? calibratedReasonRowH
          : Math.round(BASE_REASON_ROW_H * lastFontScale);
      return { single, reason };
    }

    function buildRowTops(n, hasReasonFlags) {
      const { single, reason } = getEstRowHeights();
      const tops = new Float64Array(n + 1);
      let acc = 0;
      for (let i = 0; i < n; i++) {
        tops[i] = acc;
        acc += hasReasonFlags && hasReasonFlags[i] ? reason : single;
      }
      tops[n] = acc;
      return { rowTops: tops, totalBodyH: acc };
    }

    function findRowIndexAtOffset(rowTops, n, offset) {
      if (n <= 0 || offset <= 0) return 0;
      if (offset >= rowTops[n - 1]) return n - 1;
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (rowTops[mid] <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    }

    function syncFontScaleIfChanged() {
      const nextScale = readUiFontScale();
      if (Math.abs(nextScale - lastFontScale) < 0.005) return false;
      lastFontScale = nextScale;
      calibratedSingleRowH = 0;
      calibratedReasonRowH = 0;
      if (activeDataset?.isVirtualized) {
        const rebuilt = buildRowTops(activeDataset.tableSteps.length, activeDataset.hasReasonFlags);
        activeDataset.rowTops = rebuilt.rowTops;
        activeDataset.totalBodyH = rebuilt.totalBodyH;
      }
      return true;
    }

    function getStepRowIdentity(st, fallbackCascadeId) {
      const agentKey = String(st?.agentCascadeId || fallbackCascadeId || 'conv');
      const stepNum = Number(st?.stepIndex);
      const rowKey = `${agentKey}-${st?.stepIndex}`;
      return { agentKey, stepNum, rowKey };
    }

    function absorbStepsIntoBaseline(stepList, fallbackCascadeId) {
      if (!Array.isArray(stepList)) return;
      for (const st of stepList) {
        if (!st || typeof st !== 'object') continue;
        const { agentKey, stepNum, rowKey } = getStepRowIdentity(st, fallbackCascadeId);
        seenStepKeys.add(rowKey);
        if (Number.isFinite(stepNum)) {
          const prevMax = maxSeenStepByAgent.get(agentKey);
          if (prevMax === undefined || stepNum > prevMax) {
            maxSeenStepByAgent.set(agentKey, stepNum);
          }
        }
      }
    }

    function clearRowEnterState(tr) {
      if (!tr) return;
      const timer = activeEnterTimers.get(tr);
      if (timer) {
        clearTimeout(timer);
        activeEnterTimers.delete(tr);
      }
      tr.onanimationend = null;
      patchClasses(tr, { 'is-step-entering': false });
    }

    function enterStepCell(event) {
      const { badge, prompt } = hoverRows.get(this);
      if (event?.target === badge) hideTurnTip();
      else showTurnTip(this, prompt);
    }

    function moveInStepCell(event) {
      const { badge } = hoverRows.get(this);
      if (event?.target === badge) hideTurnTip();
    }

    function moveAlongTurnRail(event) {
      const { badge, prompt, anomalyStep } = hoverRows.get(this);
      const rect = this.getBoundingClientRect?.();
      const relX = rect ? (event?.clientX ?? 0) - rect.left : 0;
      if (event?.target !== badge && relX <= 18) {
        showTurnTip(this, prompt);
      } else {
        hideTurnTip();
        if (anomalyStep) {
          showAnomalyTip(this, buildStepAnomalyDiagnostic(anomalyStep));
        }
      }
    }

    function leaveStepCell(event) {
      const entry = hoverRows.get(this);
      hideTurnTip();
      if (entry?.anomalyStep && entry.tr && event?.relatedTarget && entry.tr.contains?.(event.relatedTarget)) {
        showAnomalyTip(this, buildStepAnomalyDiagnostic(entry.anomalyStep));
      }
    }

    function clearCellHover(cell) {
      if (!cell || !hoverRows.delete(cell)) return;
      cell.onmouseenter = null;
      cell.onmousemove = null;
      cell.onmouseleave = null;
    }

    function calibrateRowHeights() {
      calibrateRafId = 0;
      if (!activeDataset?.isVirtualized) return;
      if (Number(stepsTablePane.clientHeight || 0) <= 0) return;
      const needSingle = calibratedSingleRowH <= 0;
      const needReason = calibratedReasonRowH <= 0 && activeDataset.hasAnyReason;
      if (!needSingle && !needReason) return;

      let measuredSingle = 0;
      let measuredReason = 0;
      // Measure contiguous run of normal rows to eliminate single-row subpixel/border-collapse drift.
      let runStartTop = 0;
      let runEndBottom = 0;
      let runCount = 0;
      let bestRunStride = 0;
      let bestRunCount = 0;

      const children = stepsTbody.children || [];
      for (let i = 0; i < children.length; i++) {
        const tr = children[i];
        if (!tr || tr.classList?.contains('step-vspacer') || tr.classList?.contains('step-vsizer')) {
          runCount = 0;
          continue;
        }
        const isReason = tr.dataset?.hasReason === '1';
        if (!isReason && needSingle) {
          const rect = tr.getBoundingClientRect?.();
          const hVal = Number(rect?.height || tr.offsetHeight || 0);
          if (hVal >= 14 && hVal <= 120) {
            if (!measuredSingle) measuredSingle = hVal;
            if (rect && Number.isFinite(rect.top) && Number.isFinite(rect.bottom) && rect.bottom > rect.top) {
              if (runCount === 0) {
                runStartTop = rect.top;
              }
              runEndBottom = rect.bottom;
              runCount += 1;
              if (runCount > bestRunCount && runCount >= 2) {
                const stride = (runEndBottom - runStartTop) / runCount;
                if (stride >= 14 && stride <= 120) {
                  bestRunCount = runCount;
                  bestRunStride = stride;
                }
              }
            }
          }
        } else {
          runCount = 0;
          if (isReason && needReason && !measuredReason) {
            const hVal = Number(tr.getBoundingClientRect?.()?.height || tr.offsetHeight || 0);
            if (hVal >= 18 && hVal <= 160) measuredReason = hVal;
          }
        }
        if ((!needSingle || bestRunCount >= 12) && (!needReason || measuredReason > 0)) {
          break;
        }
      }

      if (bestRunStride > 0) {
        measuredSingle = bestRunStride;
      }

      let changed = false;
      if (measuredSingle > 0) {
        const prev = getEstRowHeights().single;
        calibratedSingleRowH = measuredSingle;
        if (Math.abs(measuredSingle - prev) >= 0.25) changed = true;
      }
      if (measuredReason > 0) {
        const prev = getEstRowHeights().reason;
        calibratedReasonRowH = measuredReason;
        if (Math.abs(measuredReason - prev) >= 0.25) changed = true;
      }

      if (changed && activeDataset) {
        const prevTops = activeDataset.rowTops;
        const anchorIdx = renderedSliceStart > 0 ? renderedSliceStart : 0;
        const prevAnchorTop = prevTops ? prevTops[anchorIdx] : 0;
        const rebuilt = buildRowTops(activeDataset.tableSteps.length, activeDataset.hasReasonFlags);
        activeDataset.rowTops = rebuilt.rowTops;
        activeDataset.totalBodyH = rebuilt.totalBodyH;
        const curScrollTop = Number(stepsTablePane.scrollTop || 0);
        if (anchorIdx > 0 && curScrollTop > 0) {
          const delta = rebuilt.rowTops[anchorIdx] - prevAnchorTop;
          if (Math.abs(delta) >= 0.5) {
            stepsTablePane.scrollTop = Math.max(0, curScrollTop + delta);
          }
        }
        renderCurrentWindow({ force: true, enteringRowKeys: null });
        onVirtualHeightChange?.();
      }
    }

    function scheduleCalibrateRowHeights() {
      if (!activeDataset?.isVirtualized) return;
      const needSingle = calibratedSingleRowH <= 0;
      const needReason = calibratedReasonRowH <= 0 && activeDataset.hasAnyReason;
      if (!needSingle && !needReason) return;
      if (calibrateRafId) return;
      if (typeof requestAnimationFrame === 'function') {
        calibrateRafId = requestAnimationFrame(calibrateRowHeights);
      } else {
        calibrateRowHeights();
      }
    }

    function renderCurrentWindow({ force = false, enteringRowKeys = null } = {}) {
      const ds = activeDataset;
      if (!ds) return;
      const {
        tableSteps,
        cascadeId,
        colKeys,
        wantedSet,
        colOrderSig,
        locale,
        cellCtx,
        railActive,
        showAgentBadge,
        showStepTurnRail,
        useRootTurn,
        isVirtualized,
        hasReasonFlags,
        rowTops,
        totalBodyH,
        sizerSpec,
        effectiveScopes,
        formattedPrompts,
      } = ds;

      const n = tableSteps.length;
      let startIdx = 0;
      let endIdx = n;
      let topSpacerH = 0;
      let bottomSpacerH = 0;

      if (isVirtualized) {
        const scrollTop = Math.max(0, Number(stepsTablePane.scrollTop || 0));
        const rawClientH = Number(stepsTablePane.clientHeight || 0);
        const viewportH = rawClientH > 0 ? rawClientH : FALLBACK_VIEWPORT_H;
        const rawTheadH = Number(
          stepsThead.offsetHeight || stepsThead.getBoundingClientRect?.()?.height || 0
        );
        const theadH = rawTheadH > 0 ? rawTheadH : getEstRowHeights().single;
        const viewTop = Math.max(0, scrollTop - theadH);
        const viewBottom = viewTop + viewportH;
        const firstVis = findRowIndexAtOffset(rowTops, n, viewTop);
        const lastVis = findRowIndexAtOffset(rowTops, n, viewBottom);

        if (
          !force &&
          renderedSliceStart >= 0 &&
          renderedSliceEnd > renderedSliceStart &&
          renderedSliceEnd <= n
        ) {
          const topSafe =
            renderedSliceStart === 0 || firstVis - renderedSliceStart >= VIRTUAL_REFILL_MARGIN;
          const bottomSafe =
            renderedSliceEnd === n || renderedSliceEnd - 1 - lastVis >= VIRTUAL_REFILL_MARGIN;
          if (topSafe && bottomSafe) {
            return;
          }
        }

        startIdx = Math.max(0, firstVis - VIRTUAL_OVERSCAN_ROWS);
        endIdx = Math.min(n, lastVis + 1 + VIRTUAL_OVERSCAN_ROWS);
        topSpacerH = +rowTops[startIdx].toFixed(2);
        bottomSpacerH = +Math.max(0, totalBodyH - rowTops[endIdx]).toFixed(2);

        if (
          !force &&
          startIdx === renderedSliceStart &&
          endIdx === renderedSliceEnd &&
          topSpacerH === renderedTopSpacerH &&
          bottomSpacerH === renderedBottomSpacerH
        ) {
          return;
        }
      }

      const getStepTurnIdx = (st) =>
        useRootTurn ? (st?.rootTurnIndex ?? st?.turnIndex) : st?.turnIndex;
      const getStepIsStart = (st) =>
        Boolean(useRootTurn ? (st?.isRootTurnStart ?? st?.isTurnStart) : st?.isTurnStart);
      const getStepIsLatest = (st) =>
        Boolean(useRootTurn ? (st?.isRootLatestTurn ?? st?.isLatestTurn) : st?.isLatestTurn);
      const getStepPrompt = (st) =>
        (useRootTurn
          ? (st?.rootTurnPromptClean ?? st?.rootTurnPrompt ?? st?.turnPromptClean ?? st?.turnPrompt)
          : (st?.turnPromptClean ?? st?.turnPrompt)) || '';
      const getStepHasMedia = (st) =>
        Boolean(useRootTurn ? (st?.rootTurnHasMedia ?? st?.turnHasMedia) : st?.turnHasMedia);
      const getStepMediaOnly = (st) =>
        Boolean(useRootTurn ? (st?.rootTurnMediaOnly ?? st?.turnMediaOnly) : st?.turnMediaOnly);

      function getTurnKeyAt(idx) {
        if (!showStepTurnRail || idx < 0 || idx >= n) return '';
        const st = tableSteps[idx];
        const tIdx = getStepTurnIdx(st);
        if (!Number.isInteger(tIdx) || tIdx <= 0) return '';
        return useRootTurn ? `root:${tIdx}` : `${st?.agentId || 'main'}:${tIdx}`;
      }

      function formattedTurnPrompt(st) {
        const raw = getStepPrompt(st);
        const hasMedia = getStepHasMedia(st);
        const mediaOnly = getStepMediaOnly(st);
        const cacheKey = `${mediaOnly ? 2 : hasMedia ? 1 : 0}:${raw}`;
        if (!formattedPrompts.has(cacheKey)) {
          formattedPrompts.set(cacheKey, formatTurnPromptText(raw, { hasMedia, mediaOnly }));
        }
        return formattedPrompts.get(cacheKey);
      }

      const windowItems = [];
      if (isVirtualized && sizerSpec) {
        windowItems.push({
          isSizer: true,
          isSpacer: false,
          rowKey: SIZER_ROW_KEY,
          sizerSpec,
        });
      }
      if (isVirtualized && topSpacerH > 0) {
        windowItems.push({
          isSizer: false,
          isSpacer: true,
          rowKey: SPACER_TOP_KEY,
          height: topSpacerH,
          colSpan: colKeys.length,
        });
      }

      for (let idx = startIdx; idx < endIdx; idx++) {
        const st = tableSteps[idx];
        const tKey = getTurnKeyAt(idx);
        const hasTurn = Boolean(tKey);
        const hasUp = hasTurn && getTurnKeyAt(idx - 1) === tKey;
        const hasDown = hasTurn && getTurnKeyAt(idx + 1) === tKey;
        windowItems.push({
          isSizer: false,
          isSpacer: false,
          st,
          logicalIdx: idx,
          isStripeEven: (idx & 1) === 1,
          hasReason: Boolean(hasReasonFlags && hasReasonFlags[idx]),
          rowKey: `${st.agentCascadeId || cascadeId || 'conv'}-${st.stepIndex}`,
          hasTurn,
          hasUp,
          hasDown,
          isStart: Boolean(hasTurn && (getStepIsStart(st) || !hasDown)),
          isLatest: hasTurn && getStepIsLatest(st),
          prompt: hasTurn ? formattedTurnPrompt(st) : '',
        });
      }

      if (isVirtualized && bottomSpacerH > 0) {
        windowItems.push({
          isSizer: false,
          isSpacer: true,
          rowKey: SPACER_BOTTOM_KEY,
          height: bottomSpacerH,
          colSpan: colKeys.length,
        });
      }

      patchKeyedList(stepsTbody, windowItems, {
        keyFn: (item) => item.rowKey,
        sigFn: (item) => {
          if (item.isSizer) {
            return `${locale}:${colOrderSig}:${showAgentBadge ? 1 : 0}:${railActive ? 1 : 0}:${item.sizerSpec.sig}`;
          }
          if (item.isSpacer) {
            return `spacer:${item.colSpan}:${item.height}`;
          }
          const { st } = item;
          const parts = colKeys
            .map((colKey) => STEP_COLUMN_REGISTRY[colKey].sigPart(st, cellCtx))
            .join('|');
          const badgeSig = showAgentBadge
            ? `${cellCtx.scopeSigKey}:${st.agentId || 'main'}:${st.agentBadge || ''}:${st.agentLabel || ''}`
            : '';
          const stripeSig = isVirtualized ? (item.isStripeEven ? 'E' : 'O') : 'N';
          const anomalySig = `${st.anomalySig || ''}:${JSON.stringify(st.requestDiagnostics)}:${st.nativeStreamSec}:${st.thinkingDurationSec}`;
          return `${locale}:${colOrderSig}:${stripeSig}:${badgeSig}:${anomalySig}:${railActive}:${item.hasTurn}:${item.hasUp}:${item.hasDown}:${item.isStart}:${item.isLatest}:${item.prompt}:${parts}`;
        },
        createRow: (item) => {
          if (item.isSizer) {
            const tr = h('tr', { className: 'step-vsizer', 'aria-hidden': 'true' });
            return {
              el: tr,
              refs: {
                isSizer: true,
                isSpacer: false,
                cellMap: new Map(),
                colOrderSig: '',
                agentBadgeEl: null,
              },
            };
          }
          if (item.isSpacer) {
            const td = h('td', {
              className: 'step-vspacer-cell',
              colspan: String(item.colSpan),
            });
            const tr = h('tr', { className: 'step-vspacer', 'aria-hidden': 'true' }, [td]);
            return { el: tr, refs: { isSizer: false, isSpacer: true, td } };
          }
          if (rowPool.length > 0) {
            return rowPool.pop();
          }
          const tr = h('tr');
          return {
            el: tr,
            refs: {
              isSizer: false,
              isSpacer: false,
              cellMap: new Map(),
              colOrderSig: '',
              railEl: null,
              agentBadgeEl: null,
              hoverTd: null,
            },
          };
        },
        updateRow: (refs, item, _idx, tr) => {
          if (item.isSizer) {
            const spec = item.sizerSpec;
            if (refs.colOrderSig !== colOrderSig) {
              for (const [oldColKey, entry] of refs.cellMap) {
                if (!wantedSet.has(oldColKey)) {
                  if (refs.agentBadgeEl?.parentNode === entry.innerEl) {
                    entry.innerEl.removeChild(refs.agentBadgeEl);
                  }
                  tr.removeChild(entry.td);
                  refs.cellMap.delete(oldColKey);
                }
              }
              const isNewSizer = refs.colOrderSig === '';
              for (let i = 0; i < colKeys.length; i++) {
                const colKey = colKeys[i];
                let entry = refs.cellMap.get(colKey);
                if (!entry) {
                  const created = STEP_COLUMN_REGISTRY[colKey].createCell();
                  const innerEl = h('div', { className: 'step-vsizer-inner' });
                  while (created.td.firstChild) {
                    innerEl.appendChild(created.td.firstChild);
                  }
                  created.td.appendChild(innerEl);
                  entry = { td: created.td, refs: created.refs, innerEl };
                  refs.cellMap.set(colKey, entry);
                }
                if (isNewSizer) {
                  tr.appendChild(entry.td);
                } else {
                  const currentTd = tr.children[i] || null;
                  if (currentTd !== entry.td) tr.insertBefore(entry.td, currentTd);
                }
              }
              refs.colOrderSig = colOrderSig;
            }
            for (const colKey of colKeys) {
              const entry = refs.cellMap.get(colKey);
              const probeStep = spec.colSteps[colKey] || tableSteps[0];
              if (entry && probeStep) {
                STEP_COLUMN_REGISTRY[colKey].updateCell(entry.refs, probeStep, cellCtx);
              }
            }
            const firstColKey = colKeys[0];
            const firstInner = firstColKey ? refs.cellMap.get(firstColKey)?.innerEl || null : null;
            const showSizerBadge = Boolean(showAgentBadge && firstInner && spec.badgeText);
            if (showSizerBadge && !refs.agentBadgeEl) {
              refs.agentBadgeEl = h('span', { className: 'agent-badge', style: 'margin-right: 4px;' });
            }
            if (firstInner && refs.agentBadgeEl) {
              if (refs.agentBadgeEl.parentNode !== firstInner || firstInner.firstChild !== refs.agentBadgeEl) {
                firstInner.insertBefore(refs.agentBadgeEl, firstInner.firstChild);
              }
              patchAttr(refs.agentBadgeEl, 'hidden', !showSizerBadge);
              if (showSizerBadge) {
                patchAttr(refs.agentBadgeEl, 'class', `agent-badge ${spec.badgeClass || ''}`.trim());
                patchText(refs.agentBadgeEl, spec.badgeText);
              }
            }
            return;
          }
          if (item.isSpacer) {
            patchAttr(refs.td, 'colspan', String(item.colSpan));
            if (refs.td?.style) {
              refs.td.style.height = `${item.height}px`;
            }
            return;
          }
          const { st, hasTurn, hasUp, hasDown, isStart, isLatest, prompt } = item;
          patchClasses(tr, { 'is-stripe-even': Boolean(isVirtualized && item.isStripeEven) });
          if (tr.dataset) {
            tr.dataset.hasReason = item.hasReason ? '1' : '0';
          }

          if (refs.colOrderSig !== colOrderSig) {
            if (refs.hoverTd) {
              clearCellHover(refs.hoverTd);
              refs.hoverTd = null;
            }
            for (const [oldColKey, entry] of refs.cellMap) {
              if (!wantedSet.has(oldColKey)) {
                if (refs.railEl?.parentNode === entry.td) {
                  entry.td.removeChild(refs.railEl);
                }
                if (refs.agentBadgeEl?.parentNode === entry.td) {
                  entry.td.removeChild(refs.agentBadgeEl);
                }
                tr.removeChild(entry.td);
                refs.cellMap.delete(oldColKey);
              }
            }

            const isNewRow = refs.colOrderSig === '';
            for (let i = 0; i < colKeys.length; i++) {
              const colKey = colKeys[i];
              let cell = refs.cellMap.get(colKey);
              if (!cell) {
                cell = STEP_COLUMN_REGISTRY[colKey].createCell();
                refs.cellMap.set(colKey, cell);
              }
              if (isNewRow) {
                tr.appendChild(cell.td);
              } else {
                const currentTd = tr.children[i] || null;
                if (currentTd !== cell.td) tr.insertBefore(cell.td, currentTd);
              }
            }
            refs.colOrderSig = colOrderSig;
          }

          for (const colKey of colKeys) {
            const cellEntry = refs.cellMap.get(colKey);
            STEP_COLUMN_REGISTRY[colKey].updateCell(cellEntry.refs, st, cellCtx);
            if (colKey === 'ttft' && props.onInspectRequest) {
              if (!cellEntry.inspectButton) {
                cellEntry.inspectButton = h('button', {
                  type: 'button', className: 'step-request-diagnostics-button',
                  style: 'font: inherit; color: inherit; padding: 0; border: 0; background: transparent; text-decoration: underline; cursor: pointer;',
                });
                cellEntry.inspectButton.appendChild(cellEntry.refs.valEl);
                cellEntry.td.appendChild(cellEntry.inspectButton);
              }
              patchAttr(cellEntry.inspectButton, 'title', t('steps.diagnosticsOpen'));
              patchAttr(cellEntry.inspectButton, 'aria-label', t('steps.diagnosticsSelected', { step: st.stepIndex }));
              cellEntry.inspectButton.onclick = () => props.onInspectRequest(st);
            }

          }

          const firstColKey = colKeys[0];
          const firstTd = firstColKey ? refs.cellMap.get(firstColKey)?.td || null : null;
          const showRowRail = Boolean(hasTurn && firstTd);
          if (showRowRail && !refs.railEl) {
            refs.railEl = h('span', { className: 'turn-rail', 'aria-hidden': 'true' });
          }
          if (showAgentBadge && firstTd && !refs.agentBadgeEl) {
            refs.agentBadgeEl = h('span', { className: 'agent-badge', style: 'margin-right: 4px;' });
          }
          if (firstTd) {
            if (refs.railEl && (refs.railEl.parentNode !== firstTd || firstTd.firstChild !== refs.railEl)) {
              firstTd.insertBefore(refs.railEl, firstTd.firstChild);
            }
            const afterRail = refs.railEl
              ? refs.railEl.nextSibling ?? firstTd.children[1] ?? null
              : firstTd.firstChild;
            if (
              refs.agentBadgeEl &&
              (refs.agentBadgeEl.parentNode !== firstTd || afterRail !== refs.agentBadgeEl)
            ) {
              firstTd.insertBefore(refs.agentBadgeEl, afterRail);
            }
          }

          patchAttr(refs.agentBadgeEl, 'hidden', !showAgentBadge || !firstTd);
          if (showAgentBadge && firstTd) {
            const badgeCls = getAgentBadgeClass(st.agentIndex || 0, !st.isSubagent);
            const clickableCls = interactiveBadges && onSelectAgentScopes ? ' is-clickable' : '';
            patchAttr(refs.agentBadgeEl, 'class', `agent-badge${clickableCls} ${badgeCls}`);
            const badgeText = formatAgentBadgeText({
              agentKind:
                st.agentKind ||
                (!st.isSubagent ? 'main' : st.isSideQuestion ? 'side_question' : 'subagent'),
              agentOrdinal:
                st.agentOrdinal || (st.isSideQuestion ? st.sideIndex || 0 : st.agentIndex || 0),
              isMain: !st.isSubagent,
              isSideQuestion: Boolean(st.isSideQuestion),
              sideIndex: st.sideIndex || 0,
              index: st.agentIndex || 0,
              badgeText: st.agentBadge,
            });
            patchText(refs.agentBadgeEl, badgeText);

            if (interactiveBadges && onSelectAgentScopes) {
              const targetScope = st.agentId || 'main';
              const isSoleTarget =
                effectiveScopes.length === 1 && effectiveScopes[0] === targetScope;
              const agentName = formatAgentLabel({
                agentKind:
                  st.agentKind ||
                  (!st.isSubagent ? 'main' : st.isSideQuestion ? 'side_question' : 'subagent'),
                agentOrdinal:
                  st.agentOrdinal || (st.isSideQuestion ? st.sideIndex || 0 : st.agentIndex || 0),
                customRole: st.agentCustomRole,
                isMain: !st.isSubagent,
                isSideQuestion: Boolean(st.isSideQuestion),
                sideIndex: st.sideIndex || 0,
                index: st.agentIndex || 0,
                role: st.agentRole || '',
                shortLabel: st.agentLabel || '',
              });
              patchAttr(
                refs.agentBadgeEl,
                'title',
                isSoleTarget
                  ? t('steps.badgeBackAll')
                  : t('steps.badgeFilterAgent', { agent: agentName })
              );
              refs.agentBadgeEl.onclick = (e) => {
                if (e && (e.ctrlKey || e.metaKey || e.shiftKey) && effectiveScopes[0] !== 'all') {
                  const next = effectiveScopes.includes(targetScope)
                    ? effectiveScopes.filter((id) => id !== targetScope)
                    : [...effectiveScopes, targetScope];
                  onSelectAgentScopes(next.length > 0 ? next : ['all']);
                } else {
                  onSelectAgentScopes(isSoleTarget ? ['all'] : [targetScope]);
                }
              };
            } else {
              patchAttr(refs.agentBadgeEl, 'title', null);
              refs.agentBadgeEl.onclick = null;
            }
          } else if (refs.agentBadgeEl) {
            refs.agentBadgeEl.onclick = null;
          }

          const hasStepAnomaly = Boolean(st?.anomaly && Number(st.anomaly.count) > 0);
          const isAnomalyDanger = Boolean(hasStepAnomaly && st.anomaly.severity === 'danger');
          const isAnomalyWarn = Boolean(hasStepAnomaly && !isAnomalyDanger);
          patchClasses(tr, {
            'is-anomaly-warn': isAnomalyWarn,
            'is-anomaly-danger': isAnomalyDanger,
          });
          if (hasStepAnomaly) {
            const anchorEl = firstTd || tr;
            tr.onmouseenter = () => {
              showAnomalyTip(anchorEl, buildStepAnomalyDiagnostic(st));
            };
            tr.onmouseleave = hideAnomalyTip;
          } else {
            tr.onmouseenter = null;
            tr.onmouseleave = null;
          }

          patchAttr(refs.railEl, 'hidden', !showRowRail);
          if (showRowRail) {
            const marker = isStart ? ' is-origin' : !hasUp && hasDown ? ' is-cap' : '';
            patchAttr(
              refs.railEl,
              'class',
              `turn-rail${isLatest ? ' is-latest' : ''}${hasUp ? ' has-up' : ''}${hasDown ? ' has-down' : ''}${marker}`
            );
          }

          const hoverTd = showRowRail && prompt ? firstTd : null;
          if (refs.hoverTd !== hoverTd) clearCellHover(refs.hoverTd);
          refs.hoverTd = hoverTd;
          if (hoverTd) {
            hoverRows.set(hoverTd, {
              badge: refs.agentBadgeEl,
              prompt,
              anomalyStep: hasStepAnomaly ? st : null,
              tr,
            });
            const useWholeCellTurnTip = firstColKey === 'step' && !hasStepAnomaly;
            hoverTd.onmouseenter = useWholeCellTurnTip ? enterStepCell : null;
            hoverTd.onmousemove = useWholeCellTurnTip ? moveInStepCell : moveAlongTurnRail;
            hoverTd.onmouseleave = leaveStepCell;
          }

          if (enteringRowKeys?.has(item.rowKey)) {
            clearRowEnterState(tr);
            patchClasses(tr, { 'is-step-entering': true });
            tr.onanimationend = (ev) => {
              if (!ev || !ev.target || ev.target === tr) {
                clearRowEnterState(tr);
              }
            };
            const timer = setTimeout(() => clearRowEnterState(tr), 960);
            activeEnterTimers.set(tr, timer);
          }
        },
        destroyRow: (refs, tr) => {
          if (refs?.hoverTd) {
            clearCellHover(refs.hoverTd);
            refs.hoverTd = null;
          }
          clearRowEnterState(tr);
          if (!refs?.isSpacer && !refs?.isSizer && tr) {
            patchClasses(tr, {
              'is-stripe-even': false,
              'is-step-entering': false,
              'is-anomaly-warn': false,
              'is-anomaly-danger': false,
            });
            tr.onmouseenter = null;
            tr.onmouseleave = null;
            if (refs.agentBadgeEl) {
              refs.agentBadgeEl.onclick = null;
            }
            if (rowPool.length < MAX_ROW_POOL_SIZE) {
              rowPool.push({ el: tr, refs });
            }
          }
        },
      });

      renderedSliceStart = startIdx;
      renderedSliceEnd = endIdx;
      renderedTopSpacerH = topSpacerH;
      renderedBottomSpacerH = bottomSpacerH;

      if (isVirtualized) {
        scheduleCalibrateRowHeights();
      }
    }

    function refreshViewport() {
      if (!activeDataset?.isVirtualized) return;
      const scaleChanged = syncFontScaleIfChanged();
      renderCurrentWindow({ force: scaleChanged, enteringRowKeys: null });
      scheduleCalibrateRowHeights();
    }

    function onPaneScroll() {
      hideTurnTip();
      hideAnomalyTip();
      if (!activeDataset?.isVirtualized) return;
      if (typeof requestAnimationFrame === 'function') {
        if (scrollRafId) return;
        scrollRafId = requestAnimationFrame(() => {
          scrollRafId = 0;
          renderCurrentWindow({ force: false, enteringRowKeys: null });
        });
      } else {
        renderCurrentWindow({ force: false, enteringRowKeys: null });
      }
    }

    function onTbodyLeave() {
      hideTurnTip();
      hideAnomalyTip();
    }

    stepsTablePane.addEventListener('scroll', onPaneScroll, { passive: true });
    stepsTbody.addEventListener('mouseleave', onTbodyLeave);

    let paneResizeObs = null;
    if (typeof ResizeObserver === 'function') {
      paneResizeObs = new ResizeObserver(() => {
        if (!activeDataset?.isVirtualized) return;
        refreshViewport();
      });
      paneResizeObs.observe(stepsTablePane);
    }

    function renderStepTable(
      tableSteps,
      cascadeId,
      colKeys,
      locale,
      {
        effectiveScopes = ['all'],
        hasSubagents = false,
        isMergedMultiAgents = false,
        showStepTurnRail = false,
        showStepAgentBadge = true,
        showStepSpeedColor = false,
        stepTokenComboFormat = undefined,
        displaySettings = {},
        allConversationSteps = null,
        allowNewRowFade = false,
      } = {}
    ) {
      const normCascadeId = String(cascadeId || '');
      let enteringRowKeys = null;
      if (!normCascadeId || trackedCascadeId === null || normCascadeId !== trackedCascadeId) {
        trackedCascadeId = normCascadeId || null;
        lastAbsorbedAllSteps = null;
        seenStepKeys.clear();
        maxSeenStepByAgent.clear();
        if (allConversationSteps && allConversationSteps !== tableSteps) {
          absorbStepsIntoBaseline(allConversationSteps, normCascadeId);
          lastAbsorbedAllSteps = allConversationSteps;
        }
        absorbStepsIntoBaseline(tableSteps, normCascadeId);
      } else if (!allowNewRowFade || standalone) {
        if (allConversationSteps && allConversationSteps !== lastAbsorbedAllSteps && allConversationSteps !== tableSteps) {
          absorbStepsIntoBaseline(allConversationSteps, normCascadeId);
          lastAbsorbedAllSteps = allConversationSteps;
        }
        if (tableSteps !== lastRenderedRows) {
          absorbStepsIntoBaseline(tableSteps, normCascadeId);
        }
      } else if (tableSteps !== lastRenderedRows) {
        let pendingMaxByAgent = null;
        for (const st of tableSteps) {
          if (!st || typeof st !== 'object') continue;
          const { agentKey, stepNum, rowKey } = getStepRowIdentity(st, normCascadeId);
          if (!seenStepKeys.has(rowKey)) {
            seenStepKeys.add(rowKey);
            const prevMax = maxSeenStepByAgent.get(agentKey);
            if (prevMax === undefined || !Number.isFinite(stepNum) || stepNum > prevMax) {
              enteringRowKeys ??= new Set();
              enteringRowKeys.add(rowKey);
            }
            if (Number.isFinite(stepNum)) {
              const curPending = pendingMaxByAgent?.get(agentKey);
              if (curPending === undefined || stepNum > curPending) {
                pendingMaxByAgent ??= new Map();
                pendingMaxByAgent.set(agentKey, stepNum);
              }
            }
          }
        }
        if (pendingMaxByAgent) {
          for (const [agentKey, maxStep] of pendingMaxByAgent) {
            const prevMax = maxSeenStepByAgent.get(agentKey);
            if (prevMax === undefined || maxStep > prevMax) {
              maxSeenStepByAgent.set(agentKey, maxStep);
            }
          }
        }
        if (allConversationSteps && allConversationSteps !== lastAbsorbedAllSteps && allConversationSteps !== tableSteps) {
          absorbStepsIntoBaseline(allConversationSteps, normCascadeId);
          lastAbsorbedAllSteps = allConversationSteps;
        }
      } else if (allConversationSteps && allConversationSteps !== lastAbsorbedAllSteps && allConversationSteps !== tableSteps) {
        absorbStepsIntoBaseline(allConversationSteps, normCascadeId);
        lastAbsorbedAllSteps = allConversationSteps;
      }

      const colOrderSig = colKeys.join(',');
      const normTokenFmt = normalizeClientStepTokenComboFormat(stepTokenComboFormat);
      const renderOptions = JSON.stringify([
        cascadeId, locale, colOrderSig, effectiveScopes, hasSubagents, isMergedMultiAgents,
        showStepTurnRail, showStepAgentBadge, showStepSpeedColor, normTokenFmt,
        displaySettings.modelDisplayMode, displaySettings.showUpstreamModel,
        displaySettings.orchestratorIdMode,
      ]);
      if (
        lastRenderOptions === renderOptions &&
        lastRenderedRows &&
        (lastRenderedRows === tableSteps ||
          (lastRenderedRows.length === tableSteps.length &&
            tableSteps.every((step, i) => step === lastRenderedRows[i])))
      ) {
        if (activeDataset?.isVirtualized) {
          refreshViewport();
        }
        return;
      }

      syncFontScaleIfChanged();
      const wantedSet = new Set(colKeys);
      syncTableHeaderColumns(colKeys, { stepTokenComboFormat: normTokenFmt });

      const showAgentBadge = Boolean(hasSubagents && showStepAgentBadge);
      const cellCtx = {
        hasSubagents,
        showAgentBadge,
        showStepSpeedColor,
        stepTokenComboFormat: normTokenFmt,
        effectiveScopes,
        scopeSigKey: effectiveScopes.join(','),
        displaySettings,
        onSelectAgentScopes,
      };

      const useRootTurn = Boolean(hasSubagents && isMergedMultiAgents);
      let railActive = false;
      if (showStepTurnRail) {
        for (let i = 0; i < tableSteps.length; i++) {
          const st = tableSteps[i];
          const tIdx = useRootTurn ? (st?.rootTurnIndex ?? st?.turnIndex) : st?.turnIndex;
          if (Number.isInteger(tIdx) && tIdx > 0) {
            railActive = true;
            break;
          }
        }
      }
      if (!railActive) {
        hideTurnTip();
      }

      const isVirtualized = !standalone && tableSteps.length > VIRTUAL_ROW_THRESHOLD;
      patchClasses(stepsTableEl, {
        'has-turn-rail': railActive,
        'is-virtualized': isVirtualized,
      });

      let hasReasonFlags = null;
      let hasAnyReason = false;
      let rowTops = null;
      let totalBodyH = 0;
      let sizerSpec = null;
      if (isVirtualized) {
        const hasTpsCol = wantedSet.has('tps');
        if (hasTpsCol) {
          hasReasonFlags = new Uint8Array(tableSteps.length);
          for (let i = 0; i < tableSteps.length; i++) {
            const rawReason = tableSteps[i]?.selectedSpeedReason;
            if (rawReason && speedReasonText(rawReason)) {
              hasReasonFlags[i] = 1;
              hasAnyReason = true;
            }
          }
        }
        const built = buildRowTops(tableSteps.length, hasReasonFlags);
        rowTops = built.rowTops;
        totalBodyH = built.totalBodyH;
        sizerSpec = buildColumnSizerSpec(tableSteps, colKeys, wantedSet, cellCtx);
      }

      activeDataset = {
        tableSteps,
        cascadeId,
        colKeys,
        wantedSet,
        colOrderSig,
        locale,
        cellCtx,
        railActive,
        showAgentBadge,
        showStepTurnRail,
        useRootTurn,
        isVirtualized,
        hasReasonFlags,
        hasAnyReason,
        rowTops,
        totalBodyH,
        sizerSpec,
        effectiveScopes,
        formattedPrompts: new Map(),
      };
      renderedSliceStart = -1;
      renderedSliceEnd = -1;
      renderedTopSpacerH = -1;
      renderedBottomSpacerH = -1;

      renderCurrentWindow({ force: true, enteringRowKeys });
      lastRenderOptions = renderOptions;
      lastRenderedRows = tableSteps;
    }

    onCleanup(() => {
      stepsTablePane.removeEventListener('scroll', onPaneScroll);
      stepsTbody.removeEventListener('mouseleave', onTbodyLeave);
      if (scrollRafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(scrollRafId);
        scrollRafId = 0;
      }
      if (calibrateRafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(calibrateRafId);
        calibrateRafId = 0;
      }
      paneResizeObs?.disconnect();
      paneResizeObs = null;
      rowPool.length = 0;
      for (const tr of [...activeEnterTimers.keys()]) {
        clearRowEnterState(tr);
      }
    });

    return {
      el: standaloneHostEl || stepsTablePane,
      refs: {
        stepsTablePane,
        stepsTableEl,
        stepsTheadRow,
        stepsTbody,
        turnTipEl,
        anomalyTipEl,
        syncTableHeaderColumns,
        renderStepTable,
        refreshViewport,
        hideTurnTip,
        showAnomalyTip,
        hideAnomalyTip,
        setBoundsElGetter,
      },
    };
  },
});
return { formatTurnPromptText, StepTableWidget };
})();

// --- src/components/settings/structurePreviewMock.js ---
const { buildStructurePreviewTelemetry } = (() => {
/**
 * @fileoverview Realistic Simulated Telemetry Builder (`structurePreviewMock.js`)
 * for `SettingsStructureTab` real-UI live previews.
 * Exercises all 13 capsule metrics, 8 overview metrics, 10 context channels + subagents,
 * multi-pool quotas, live running task + subagent, and 12 step table columns.
 */


function buildStructurePreviewTelemetry(baseSettings = {}, draftOverrides = {}) {
  const anchorMinMs = Math.floor(Date.now() / 60000) * 60000;
  const reset5hIso = new Date(anchorMinMs + (2 * 60 + 42) * 60000).toISOString();
  const resetWkIso = new Date(anchorMinMs + (4 * 24 * 60 + 180) * 60000).toISOString();
  const resetClaude5hIso = new Date(anchorMinMs + (1 * 60 + 18) * 60000).toISOString();

  const mergedSettings = {
    ...(baseSettings && typeof baseSettings === 'object' ? baseSettings : {}),
    ...draftOverrides,
  };

  const sessionTitle = t('settings.mock.sessionTitle');
  const subRole = t('settings.mock.subRole');
  const promptLatest = t('settings.mock.turnPromptLatest');
  const promptPrev = t('settings.mock.turnPromptPrev');

  const mainContext = {
    totalTokens: 142800,
    limitTokens: 256000,
    compactionLimitTokens: 256000,
    compactionUsedTokens: 142800,
    usedPct: 55.8,
    messagesTokens: 119660,
    toolResultsTokens: 86400,
    assistantTokens: 24200,
    systemToolsTokens: 11800,
    checkpointTokens: 7600,
    systemPromptTokens: 5800,
    skillsTokens: 3100,
    userRulesTokens: 1900,
    userInputTokens: 1120,
    mcpToolsTokens: 540,
    subagentTokens: 340,
  };

  const subContext = {
    totalTokens: 72704,
    limitTokens: 256000,
    compactionLimitTokens: 256000,
    compactionUsedTokens: 72704,
    usedPct: 28.4,
    messagesTokens: 63704,
    toolResultsTokens: 51200,
    assistantTokens: 11400,
    systemToolsTokens: 5600,
    systemPromptTokens: 3400,
    userInputTokens: 1104,
    checkpointTokens: 0,
    skillsTokens: 0,
    userRulesTokens: 0,
    mcpToolsTokens: 0,
    subagentTokens: 0,
  };

  const mockSteps = [
    {
      stepIndex: 24,
      agentCascadeId: 'mock-main',
      agentId: 'main',
      agentIndex: 0,
      isSubagent: false,
      agentBadge: '主',
      agentLabel: t('fmt.mainAgent'),
      modelLabel: 'Gemini 4 Carbon (High)',
      modelShort: 'carbon-4-high',
      rawModel: 'MODEL_PLACEHOLDER_M37',
      modelUpstream: 'gemini-4-carbon-high',
      upstreamModel: 'gemini-4-carbon-high',
      tokPerSec: 68.4,
      ttftSec: 1.15,
      totalDurationSec: 12.6,
      streamDurationSec: 11.45,
      contextTokens: 142800,
      inputTokens: 7800,
      cacheReadTokens: 133580,
      outputTokens: 1420,
      thinkingTokens: 860,
      responseTokens: 560,
      cacheHitPct: 94.5,
      costUsd: 0.042,
      inCostUsd: 0.0156,
      cacheCostUsd: 0.0134,
      outCostUsd: 0.0142,
      createdAtMs: anchorMinMs - 14_000,
      turnIndex: 2,
      rootTurnIndex: 2,
      isTurnStart: false,
      isRootTurnStart: false,
      isLatestTurn: true,
      isRootLatestTurn: true,
      turnPrompt: promptLatest,
      rootTurnPrompt: promptLatest,
    },
    {
      stepIndex: 8,
      agentCascadeId: 'mock-sub-1',
      agentId: 'sub-1',
      agentIndex: 1,
      isSubagent: true,
      agentBadge: '子1',
      agentRole: subRole,
      agentLabel: subRole,
      modelLabel: 'Gemini 3.8 Flash',
      modelShort: 'flash-3.8',
      rawModel: 'MODEL_PLACEHOLDER_M42',
      modelUpstream: 'gemini-3.8-flash-n',
      upstreamModel: 'gemini-3.8-flash-n',
      tokPerSec: 96.2,
      ttftSec: 0.68,
      totalDurationSec: 5.4,
      streamDurationSec: 4.72,
      contextTokens: 72704,
      inputTokens: 8600,
      cacheReadTokens: 63400,
      outputTokens: 704,
      thinkingTokens: 240,
      responseTokens: 464,
      cacheHitPct: 88.1,
      costUsd: 0.009,
      inCostUsd: 0.0065,
      cacheCostUsd: 0.0005,
      outCostUsd: 0.0026,
      createdAtMs: anchorMinMs - 42_000,
      turnIndex: 1,
      rootTurnIndex: 2,
      isTurnStart: true,
      isRootTurnStart: false,
      isLatestTurn: true,
      isRootLatestTurn: true,
      turnPrompt: promptLatest,
      rootTurnPrompt: promptLatest,
    },
    {
      stepIndex: 22,
      agentCascadeId: 'mock-main',
      agentId: 'main',
      agentIndex: 0,
      isSubagent: false,
      agentBadge: '主',
      agentLabel: t('fmt.mainAgent'),
      isCompactionStep: true,
      modelLabel: 'Gemini 4 Carbon (High) [自动压缩]',
      modelShort: 'carbon-4-high·压缩',
      rawModel: 'MODEL_PLACEHOLDER_M37',
      modelUpstream: 'gemini-4-carbon-high·压缩',
      upstreamModel: 'gemini-4-carbon-high',
      tokPerSec: 46.5,
      ttftSec: 3.4,
      totalDurationSec: 15.8,
      streamDurationSec: 12.4,
      contextTokens: 128400,
      inputTokens: 49200,
      cacheReadTokens: 78100,
      outputTokens: 1100,
      thinkingTokens: 720,
      responseTokens: 380,
      cacheHitPct: 61.4,
      costUsd: 0.068,
      inCostUsd: 0.0492,
      cacheCostUsd: 0.0078,
      outCostUsd: 0.011,
      createdAtMs: anchorMinMs - 88_000,
      turnIndex: 2,
      rootTurnIndex: 2,
      isTurnStart: true,
      isRootTurnStart: true,
      isLatestTurn: true,
      isRootLatestTurn: true,
      turnPrompt: promptLatest,
      rootTurnPrompt: promptLatest,
    },
    {
      stepIndex: 19,
      agentCascadeId: 'mock-main',
      agentId: 'main',
      agentIndex: 0,
      isSubagent: false,
      agentBadge: '主',
      agentLabel: t('fmt.mainAgent'),
      modelLabel: 'Gemini 4 Carbon (High)',
      modelShort: 'gemini-4-carbon',
      rawModel: 'MODEL_PLACEHOLDER_M37',
      upstreamModel: 'gemini-4-carbon-high',
      tokPerSec: 17.8,
      ttftSec: 19.4,
      totalDurationSec: 31.2,
      streamDurationSec: 11.8,
      contextTokens: 96200,
      inputTokens: 95400,
      cacheReadTokens: 0,
      outputTokens: 800,
      thinkingTokens: 540,
      responseTokens: 260,
      cacheHitPct: 0,
      costUsd: 0.198,
      inCostUsd: 0.19,
      cacheCostUsd: 0,
      outCostUsd: 0.008,
      createdAtMs: anchorMinMs - 215_000,
      turnIndex: 1,
      rootTurnIndex: 1,
      isTurnStart: true,
      isRootTurnStart: true,
      isLatestTurn: false,
      isRootLatestTurn: false,
      turnPrompt: promptPrev,
      rootTurnPrompt: promptPrev,
    },
  ];

  const mainAgent = {
    agentId: 'main',
    cascadeId: 'mock-main',
    isMain: true,
    index: 0,
    badgeText: '主',
    role: t('fmt.mainAgent'),
    isRunning: true,
    stepCount: 16,
    speedSampleCount: 15,
    speedSummary: { sampleCount: 15, excludedCount: 1 },
    latestTokPerSec: 68.4,
    avgTokPerSec: 54.8,
    latestTtftSec: 1.15,
    avgTtftSec: 1.62,
    ttftSummary: { avgSec: 1.62, sampleCount: 15 },
    latestStepCostUsd: 0.042,
    sessionCostUsd: 1.16,
    latestCacheHitPct: 94.5,
    sessionCacheHitPct: 89.2,
    latestPromptTokens: 141380,
    inputTokens: 152400,
    cacheReadTokens: 1260000,
    outputTokens: 22100,
    totalTokens: 1434500,
    latestModelLabel: 'Gemini 4 Carbon (High)',
    latestModelShort: 'gemini-4-carbon',
    latestRawModel: 'MODEL_PLACEHOLDER_M37',
    latestUpstreamModel: 'gemini-4-carbon-high',
    activeModelLabel: 'Gemini 4 Carbon (High)',
    activeModelShort: 'gemini-4-carbon',
    activeModelUpstream: 'gemini-4-carbon-high',
    sessionUnpricedCalls: 0,
    modelBreakdown: [
      {
        modelKey: 'MODEL_PLACEHOLDER_M37',
        modelShort: 'gemini-4-carbon',
        modelLabel: 'Gemini 4 Carbon (High)',
        upstreamModel: 'gemini-4-carbon-high',
        calls: 16,
        inputTokens: 152400,
        cacheReadTokens: 1260000,
        outputTokens: 22100,
        thinkingTokens: 14200,
        totalTokens: 1434500,
        costUsd: 1.16,
        sharePct: 100,
      },
    ],
    context: mainContext,
    recentSteps: mockSteps.filter((s) => !s.isSubagent),
  };

  const subAgent1 = {
    agentId: 'sub-1',
    cascadeId: 'mock-sub-1',
    isMain: false,
    index: 1,
    badgeText: '子1',
    shortLabel: `${t('fmt.subAgent')} #1`,
    role: subRole,
    isRunning: false,
    stepCount: 8,
    speedSampleCount: 8,
    speedSummary: { sampleCount: 8, excludedCount: 0 },
    latestTokPerSec: 96.2,
    avgTokPerSec: 88.5,
    latestTtftSec: 0.68,
    avgTtftSec: 0.82,
    ttftSummary: { avgSec: 0.82, sampleCount: 8 },
    latestStepCostUsd: 0.009,
    sessionCostUsd: 0.12,
    latestCacheHitPct: 88.1,
    sessionCacheHitPct: 86.4,
    latestPromptTokens: 72000,
    inputTokens: 34000,
    cacheReadTokens: 280000,
    outputTokens: 6300,
    totalTokens: 320300,
    latestModelLabel: 'Gemini 3.8 Flash',
    latestModelShort: 'gemini-3.8-flash',
    latestRawModel: 'MODEL_PLACEHOLDER_M42',
    latestUpstreamModel: 'gemini-3.8-flash-n',
    activeModelLabel: 'Gemini 3.8 Flash',
    activeModelShort: 'gemini-3.8-flash',
    activeModelUpstream: 'gemini-3.8-flash-n',
    sessionUnpricedCalls: 0,
    modelBreakdown: [
      {
        modelKey: 'MODEL_PLACEHOLDER_M42',
        modelShort: 'gemini-3.8-flash',
        modelLabel: 'Gemini 3.8 Flash',
        upstreamModel: 'gemini-3.8-flash-n',
        calls: 8,
        inputTokens: 34000,
        cacheReadTokens: 280000,
        outputTokens: 6300,
        thinkingTokens: 2100,
        totalTokens: 320300,
        costUsd: 0.12,
        sharePct: 100,
      },
    ],
    context: subContext,
    recentSteps: mockSteps.filter((s) => s.isSubagent),
  };

  const aggregated = {
    ...mainAgent,
    agentId: 'all',
    isMain: false,
    agentKind: 'all',
    agentOrdinal: 0,
    badgeText: t('header.scopeAllShort'),
    activeAgentId: 'main',
    activeAgentKind: 'main',
    activeAgentOrdinal: 0,
    stepCount: 24,
    speedSampleCount: 23,
    speedSummary: { sampleCount: 23, excludedCount: 1 },
    avgTokPerSec: 59.6,
    avgTtftSec: 1.38,
    ttftSummary: { avgSec: 1.38, sampleCount: 23 },
    sessionCostUsd: 1.28,
    sessionUnpricedCalls: 0,
    sessionCacheHitPct: 88.9,
    inputTokens: 186400,
    cacheReadTokens: 1540000,
    outputTokens: 28400,
    totalTokens: 1754800,
    activeAgentBadge: t('fmt.mainBadge'),
    modelBreakdown: [...mainAgent.modelBreakdown, ...subAgent1.modelBreakdown],
    recentSteps: mockSteps,
  };

  return {
    settings: mergedSettings,
    account: {
      tierName: 'Google AI Ultra',
      planName: 'Pro',
      aiCredits: 0,
    },
    quotas: {
      meta: {
        hasOfficialData: true,
        isStale: false,
        refreshFailed: false,
      },
      activePool: {
        family: 'Gemini',
        poolKey: 'Gemini',
        poolLabel: 'Gemini',
        usedPct: 36,
        remainingPct: 64,
        resetTime: reset5hIso,
        weeklyUsedPct: 48,
        weeklyRemainingPct: 52,
        weeklyResetTime: resetWkIso,
      },
      pools: [
        {
          poolKey: 'Gemini',
          poolLabel: 'Gemini',
          family: 'Gemini',
          usedPct: 36,
          remainingPct: 64,
          resetTime: reset5hIso,
          weeklyUsedPct: 48,
          weeklyRemainingPct: 52,
          weeklyResetTime: resetWkIso,
          cycle5h: { tokens: 1754800, costUsd: 1.28, calls: 24 },
          cycleWeekly: { tokens: 14200000, costUsd: 11.4, calls: 186 },
        },
        {
          poolKey: 'Claude & GPT',
          poolLabel: 'Claude & GPT',
          family: 'Claude & GPT',
          usedPct: 68,
          remainingPct: 32,
          resetTime: resetClaude5hIso,
          weeklyUsedPct: 41,
          weeklyRemainingPct: 59,
          weeklyResetTime: resetWkIso,
          cycle5h: { tokens: 620000, costUsd: 2.15, calls: 11 },
          cycleWeekly: { tokens: 5800000, costUsd: 18.6, calls: 92 },
        },
      ],
      weekly: {
        isOfficial: true,
        usedPct: 48,
        remainingPct: 52,
        resetTime: resetWkIso,
        tokens: 20000000,
        costUsd: 30.0,
        calls: 278,
      },
    },
    runningConversations: [
      {
        cascadeId: 'mock-preview-conv',
        title: sessionTitle,
        isCurrentSelected: true,
        isMainRunning: true,
        isRunning: true,
        subagentCount: 1,
        runningSubagentCount: 0,
        latestTokPerSec: 68.4,
        contextUsedPct: 55.8,
        mainActivity: {
          phase: 'generating',
          label: t('live.generating'),
          stepProgress: '#24',
          detail: 'src/auth/tokenRefresh.ts',
          startedAtMs: Date.now() - 8000,
          signature: 'mock-preview:24',
        },
        subagents: [
          {
            cascadeId: 'mock-sub-1',
            index: 1,
            badgeText: '子1',
            shortLabel: `${t('fmt.subAgent')} #1`,
            role: subRole,
            isRunning: false,
            stepCount: 8,
            lastModifiedMs: anchorMinMs - 42_000,
            liveActivity: {
              phase: 'done',
              label: t('live.done'),
              detail: '',
              stepProgress: '',
              startedAtMs: anchorMinMs - 42_000,
              signature: 'mock-sub-1:8',
            },
          },
        ],
      },
    ],
    activeConversation: {
      ...mainAgent,
      cascadeId: 'mock-preview-conv',
      title: sessionTitle,
      hasSubagents: true,
      agents: [mainAgent, subAgent1],
      aggregated,
      recentSteps: mockSteps,
    },
  };
}
return { buildStructurePreviewTelemetry };
})();

// --- src/components/settings/CollapsibleSection.js ---
const { CollapsibleSection } = (() => {
/**
 * @fileoverview Reusable Section Card (`CollapsibleSection.js`)
 * for `SettingsStructureTab` — supports both accordion mode (`collapsible: true`)
 * and static 3rd-level pane card mode (`collapsible: false`).
 */


const CollapsibleSection = defineComponent({
  name: 'CollapsibleSection',
  setup({ props, onCleanup }) {
    const isCollapsible = props.collapsible !== false;
    let expanded = isCollapsible ? Boolean(props.defaultExpanded) : true;
    let statusTimer = null;

    const chevronIcon = isCollapsible
      ? createSvgIcon('chevron-right', {
          size: 12,
          className: 'collapsible-chevron',
        })
      : null;
    const sectionIcon = props.icon ? createSvgIcon(props.icon, { size: 13 }) : null;
    const titleTextEl = h('span', {
      className: 'collapsible-title-text',
      text: props.title || '',
    });

    const triggerChildren = [];
    if (chevronIcon) triggerChildren.push(chevronIcon);
    if (sectionIcon) triggerChildren.push(sectionIcon);
    triggerChildren.push(titleTextEl);

    const triggerBtn = isCollapsible
      ? h(
          'button',
          {
            type: 'button',
            className: 'collapsible-trigger',
            'aria-expanded': expanded ? 'true' : 'false',
            onClick: () => {
              setExpanded(!expanded);
              if (typeof props.onToggle === 'function') {
                props.onToggle(expanded);
              }
            },
          },
          triggerChildren
        )
      : h('div', { className: 'collapsible-title-static' }, triggerChildren);

    const statusTextEl = h('span', { className: 'collapsible-status', text: '' });
    const badgeEl = h('span', {
      className: 'collapsible-badge text-mono',
      hidden: !props.badgeText,
      text: props.badgeText || '',
    });

    const resetBtnText = h('span', { text: props.resetLabel || t('settings.resetBtn') });
    const resetBtn =
      typeof props.onReset === 'function'
        ? h(
            'button',
            {
              type: 'button',
              className: 'btn-ghost-sm',
              disabled: props.resetDisabled !== false,
              onClick: (e) => {
                e.stopPropagation();
                props.onReset();
              },
            },
            [resetBtnText]
          )
        : null;

    const rightChildren = [statusTextEl, badgeEl];
    if (resetBtn) rightChildren.push(resetBtn);

    const headerRow = h('div', { className: 'collapsible-header-row' }, [
      triggerBtn,
      h('span', { className: 'collapsible-right' }, rightChildren),
    ]);

    const bodyEl = h(
      'div',
      {
        className: 'collapsible-body',
        hidden: !expanded,
      },
      Array.isArray(props.children) ? props.children : []
    );

    const sectionEl = h(
      'section',
      {
        className: `panel collapsible-section${expanded ? ' is-expanded' : ''}${isCollapsible ? '' : ' is-static-pane'}`,
      },
      [headerRow, bodyEl]
    );

    function setExpanded(next) {
      if (!isCollapsible) return;
      expanded = Boolean(next);
      patchClasses(sectionEl, { 'is-expanded': expanded });
      patchAttr(triggerBtn, 'aria-expanded', expanded ? 'true' : 'false');
      patchAttr(bodyEl, 'hidden', !expanded);
    }

    function setTitle(text) {
      patchText(titleTextEl, text || '');
    }

    function setBadge(text) {
      patchAttr(badgeEl, 'hidden', !text);
      patchText(badgeEl, text || '');
    }

    function setResetLabel(text) {
      if (resetBtn) {
        patchText(resetBtnText, text || t('settings.resetBtn'));
      }
    }

    function setResetDisabled(disabled) {
      if (resetBtn) {
        patchAttr(resetBtn, 'disabled', Boolean(disabled));
      }
    }

    function showStatus(text, autoClearMs = 1500) {
      if (statusTimer) {
        clearTimeout(statusTimer);
        statusTimer = null;
      }
      patchText(statusTextEl, text || '');
      if (text && autoClearMs > 0) {
        statusTimer = setTimeout(() => {
          statusTimer = null;
          patchText(statusTextEl, '');
        }, autoClearMs);
      }
    }

    onCleanup(() => {
      if (statusTimer) {
        clearTimeout(statusTimer);
        statusTimer = null;
      }
    });

    return {
      el: sectionEl,
      refs: {
        triggerBtn,
        bodyEl,
        resetBtn,
        badgeEl,
        statusTextEl,
        setExpanded,
        setTitle,
        setBadge,
        setResetLabel,
        setResetDisabled,
        showStatus,
        isExpanded: () => expanded,
      },
    };
  },
});
return { CollapsibleSection };
})();

// --- src/components/settings/EditableSlotList.js ---
const { EditableSlotList } = (() => {
/**
 * @fileoverview Reusable Drag-Sortable & `+` / `-` / `↑` / `↓` Dynamic Slot List (`EditableSlotList.js`).
 * Powers Topbar Capsule Slots (1..5), Hover Popup Modules (0..4),
 * Live Overview Modules (1..4), First-Row Metrics (1..4), and Step Table Columns (2..12).
 * Supports smooth pointer-based drag reordering with live preview callbacks (`onPreview`)
 * and single-commit persistence on drop (`onChange`).
 */


function isNodeWithin(target, container) {
  let cur = target;
  while (cur) {
    if (cur === container) return true;
    cur = cur.parentNode || cur.host || null;
  }
  return false;
}

function areSlotListsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const EditableSlotList = defineComponent({
  name: 'EditableSlotList',
  setup({ props, onCleanup }) {
    const minItems = Math.max(0, Number(props.minItems ?? 1));
    const maxItems = Math.max(minItems, Number(props.maxItems ?? 5));
    let currentItems = Array.isArray(props.items) ? [...props.items] : [];
    let currentOptions = Array.isArray(props.options) ? [...props.options] : [];
    let emptyHintText = String(props.emptyHintText || '');
    let addBtnTextFn = typeof props.addBtnTextFn === 'function' ? props.addBtnTextFn : null;
    let activeDrag = null;

    const listEl = h('div', { className: 'editable-slot-list' });
    const emptyEl = h('div', {
      className: 'editable-slot-empty',
      hidden: true,
      text: emptyHintText,
    });

    const addBtnLabel = h('span', { text: '' });
    const addBtn = h(
      'button',
      {
        type: 'button',
        className: 'slot-add-btn',
        onClick: () => {
          if (currentItems.length >= maxItems) return;
          const usedSet = new Set(currentItems);
          const nextOpt = currentOptions.find((opt) => !usedSet.has(opt.value));
          if (!nextOpt) return;
          emitChange([...currentItems, nextOpt.value]);
        },
      },
      [createSvgIcon('plus', { size: 11 }), addBtnLabel]
    );

    const footerEl = h('div', { className: 'editable-slot-footer' }, [addBtn]);
    const rootEl = h('div', { className: 'editable-slot-wrap' }, [emptyEl, listEl, footerEl]);

    const rowPool = [];

    function emitChange(nextItems) {
      currentItems = [...nextItems];
      syncRows();
      if (typeof props.onPreview === 'function') {
        props.onPreview([...currentItems]);
      }
      if (typeof props.onChange === 'function') {
        props.onChange([...currentItems]);
      }
    }

    function teardownActiveDrag({ revert = false } = {}) {
      if (!activeDrag) return;
      const { startItems, hasMoved, cleanupListeners } = activeDrag;
      activeDrag = null;
      cleanupListeners();
      patchClasses(listEl, { 'is-dragging-list': false });
      for (const r of rowPool) {
        patchClasses(r.rowEl, { 'is-dragging': false });
      }
      if (revert && hasMoved && !areSlotListsEqual(startItems, currentItems)) {
        currentItems = [...startItems];
        syncRows();
        if (typeof props.onPreview === 'function') {
          props.onPreview([...currentItems]);
        }
      }
    }

    function startPointerDrag(e, initialRowIdx) {
      if (e && e.button != null && e.button !== 0) return;
      if (currentItems.length <= 1) return;
      if (activeDrag) {
        teardownActiveDrag({ revert: false });
      }

      const startY = Number(e?.clientY ?? 0);
      const startItems = [...currentItems];
      let dragIdx = initialRowIdx;
      let hasMoved = false;

      const onPointerMove = (ev) => {
        if (!activeDrag) return;
        const clientY = Number(ev?.clientY ?? startY);
        if (!hasMoved) {
          if (Math.abs(clientY - startY) < 4) return;
          hasMoved = true;
          activeDrag.hasMoved = true;
          for (let k = 0; k < currentItems.length; k += 1) {
            rowPool[k]?.selectComp?.close?.();
          }
          patchClasses(listEl, { 'is-dragging-list': true });
          if (rowPool[dragIdx]) {
            patchClasses(rowPool[dragIdx].rowEl, { 'is-dragging': true });
          }
        }
        ev?.preventDefault?.();

        let targetIdx = dragIdx;
        const count = currentItems.length;
        for (let i = 0; i < dragIdx; i += 1) {
          const rect = rowPool[i]?.rowEl?.getBoundingClientRect?.();
          if (rect && rect.height > 0 && clientY < rect.top + rect.height * 0.5) {
            targetIdx = i;
            break;
          }
        }
        if (targetIdx === dragIdx) {
          for (let i = count - 1; i > dragIdx; i -= 1) {
            const rect = rowPool[i]?.rowEl?.getBoundingClientRect?.();
            if (rect && rect.height > 0 && clientY > rect.top + rect.height * 0.5) {
              targetIdx = i;
              break;
            }
          }
        }

        if (targetIdx !== dragIdx) {
          if (rowPool[dragIdx]) {
            patchClasses(rowPool[dragIdx].rowEl, { 'is-dragging': false });
          }
          const next = [...currentItems];
          const [moved] = next.splice(dragIdx, 1);
          next.splice(targetIdx, 0, moved);
          dragIdx = targetIdx;
          activeDrag.dragIdx = dragIdx;
          currentItems = next;
          syncRows();
          if (rowPool[dragIdx]) {
            patchClasses(rowPool[dragIdx].rowEl, { 'is-dragging': true });
          }
          if (typeof props.onPreview === 'function') {
            props.onPreview([...currentItems]);
          }
        }
      };

      const onPointerUp = () => {
        if (!activeDrag) return;
        const moved = activeDrag.hasMoved;
        const changed = !areSlotListsEqual(startItems, currentItems);
        teardownActiveDrag({ revert: false });
        if (moved && changed) {
          emitChange([...currentItems]);
        }
      };

      const onPointerCancel = () => {
        teardownActiveDrag({ revert: true });
      };

      const onKeyDown = (ev) => {
        if (ev?.key === 'Escape') {
          teardownActiveDrag({ revert: true });
        }
      };

      const docTarget =
        typeof document !== 'undefined' && typeof document.addEventListener === 'function'
          ? document
          : null;

      if (docTarget) {
        docTarget.addEventListener('pointermove', onPointerMove);
        docTarget.addEventListener('pointerup', onPointerUp);
        docTarget.addEventListener('pointercancel', onPointerCancel);
        docTarget.addEventListener('keydown', onKeyDown);
      }

      activeDrag = {
        startItems,
        dragIdx,
        hasMoved: false,
        cleanupListeners: () => {
          if (docTarget && typeof docTarget.removeEventListener === 'function') {
            docTarget.removeEventListener('pointermove', onPointerMove);
            docTarget.removeEventListener('pointerup', onPointerUp);
            docTarget.removeEventListener('pointercancel', onPointerCancel);
            docTarget.removeEventListener('keydown', onKeyDown);
          }
        },
      };
    }

    function createSlotRow() {
      let rowIndex = 0;
      const dragHandle = h(
        'span',
        {
          className: 'slot-drag-handle',
          'aria-hidden': 'true',
          onPointerdown: (e) => {
            e.preventDefault?.();
            e.stopPropagation?.();
            startPointerDrag(e, rowIndex);
          },
        },
        [createSvgIcon('grip', { size: 12 })]
      );
      const indexBadge = h('span', { className: 'slot-index-badge text-mono', text: '1' });
      const selectComp = CustomSelect({
        modelValue: '',
        options: [],
        onUpdateModelValue: (nextVal) => {
          if (!nextVal || currentItems[rowIndex] === nextVal) return;
          if (currentItems.some((v, idx) => idx !== rowIndex && v === nextVal)) return;
          const next = [...currentItems];
          next[rowIndex] = nextVal;
          emitChange(next);
        },
      });

      const upBtn = h(
        'button',
        {
          type: 'button',
          className: 'slot-move-btn',
          onClick: (e) => {
            e.stopPropagation();
            if (rowIndex <= 0) return;
            const next = [...currentItems];
            const tmp = next[rowIndex - 1];
            next[rowIndex - 1] = next[rowIndex];
            next[rowIndex] = tmp;
            emitChange(next);
          },
        },
        [createSvgIcon('chevron-up', { size: 12 })]
      );

      const downBtn = h(
        'button',
        {
          type: 'button',
          className: 'slot-move-btn',
          onClick: (e) => {
            e.stopPropagation();
            if (rowIndex >= currentItems.length - 1) return;
            const next = [...currentItems];
            const tmp = next[rowIndex + 1];
            next[rowIndex + 1] = next[rowIndex];
            next[rowIndex] = tmp;
            emitChange(next);
          },
        },
        [createSvgIcon('chevron-down', { size: 12 })]
      );

      const removeBtn = h(
        'button',
        {
          type: 'button',
          className: 'slot-move-btn slot-remove-btn',
          onClick: (e) => {
            e.stopPropagation();
            if (currentItems.length <= minItems) return;
            const next = currentItems.filter((_, idx) => idx !== rowIndex);
            emitChange(next);
          },
        },
        [createSvgIcon('minus', { size: 12 })]
      );

      const orderBtnsEl = h('span', { className: 'slot-order-btns' }, [upBtn, downBtn, removeBtn]);

      const rowEl = h(
        'div',
        {
          className: 'editable-slot-row',
          onPointerdown: (e) => {
            if (isNodeWithin(e?.target, selectComp.el) || isNodeWithin(e?.target, orderBtnsEl)) {
              return;
            }
            startPointerDrag(e, rowIndex);
          },
        },
        [dragHandle, indexBadge, selectComp.el, orderBtnsEl]
      );

      return {
        rowEl,
        dragHandle,
        indexBadge,
        selectComp,
        upBtn,
        downBtn,
        removeBtn,
        setIndex(idx) {
          rowIndex = idx;
        },
      };
    }

    function syncRows() {
      const count = currentItems.length;
      patchAttr(emptyEl, 'hidden', count > 0 || !emptyHintText);
      if (emptyHintText) {
        patchText(emptyEl, emptyHintText);
      }
      patchAttr(listEl, 'hidden', count === 0);

      while (rowPool.length < count) {
        rowPool.push(createSlotRow());
      }

      while (listEl.children && listEl.children.length > count) {
        const tailIdx = listEl.children.length - 1;
        const tailChild = listEl.children[tailIdx];
        tailChild?.remove?.();
      }

      const canDrag = count > 1;
      const dragTitle = canDrag ? t('settings.slot.dragHint') : '';
      const canRemove = count > minItems;
      const removeTitle = canRemove
        ? t('settings.slot.remove')
        : t('settings.slot.minReached', { min: minItems });

      for (let i = 0; i < count; i += 1) {
        const entry = rowPool[i];
        const itemVal = currentItems[i];
        entry.setIndex(i);
        patchAttr(entry.rowEl, 'data-slot-row', String(i));
        patchText(entry.indexBadge, String(i + 1));
        patchClasses(entry.dragHandle, { 'is-disabled': !canDrag });
        patchAttr(entry.dragHandle, 'title', dragTitle || null);

        const otherUsed = new Set(currentItems.filter((_, idx) => idx !== i));
        const rowOpts = currentOptions.map((opt) => {
          const isTaken = otherUsed.has(opt.value);
          return isTaken
            ? {
                ...opt,
                disabled: true,
                meta: t('settings.slot.alreadyAdded'),
              }
            : opt;
        });

        entry.selectComp.setProps({
          modelValue: itemVal,
          options: rowOpts,
        });

        patchAttr(entry.upBtn, 'disabled', i === 0);
        patchAttr(entry.upBtn, 'title', t('settings.slot.moveUp'));
        patchAttr(entry.upBtn, 'aria-label', t('settings.slot.moveUp'));

        patchAttr(entry.downBtn, 'disabled', i === count - 1);
        patchAttr(entry.downBtn, 'title', t('settings.slot.moveDown'));
        patchAttr(entry.downBtn, 'aria-label', t('settings.slot.moveDown'));

        patchAttr(entry.removeBtn, 'disabled', !canRemove);
        patchAttr(entry.removeBtn, 'title', removeTitle);
        patchAttr(entry.removeBtn, 'aria-label', removeTitle);

        if (!listEl.children || listEl.children[i] !== entry.rowEl) {
          listEl.appendChild(entry.rowEl);
        }
      }

      // Close any hidden pooled selects
      for (let j = count; j < rowPool.length; j += 1) {
        rowPool[j].selectComp.close();
      }

      const usedAll = new Set(currentItems);
      const hasAvailableOption = currentOptions.some((opt) => !usedAll.has(opt.value));
      const disableAdd = count >= maxItems || !hasAvailableOption;
      patchAttr(addBtn, 'disabled', disableAdd);
      const addLabel = addBtnTextFn
        ? addBtnTextFn(count, maxItems)
        : `+ (${count}/${maxItems})`;
      patchText(addBtnLabel, addLabel);
    }

    function setProps(next = {}) {
      if (!activeDrag && Array.isArray(next.items)) {
        currentItems = [...next.items];
      }
      if (Array.isArray(next.options)) {
        currentOptions = [...next.options];
      }
      if (next.emptyHintText !== undefined) {
        emptyHintText = String(next.emptyHintText || '');
      }
      if (typeof next.addBtnTextFn === 'function') {
        addBtnTextFn = next.addBtnTextFn;
      }
      syncRows();
    }

    syncRows();

    onCleanup(() => {
      teardownActiveDrag({ revert: false });
      for (const entry of rowPool) {
        entry.selectComp.destroy();
      }
      rowPool.length = 0;
    });

    return {
      el: rootEl,
      refs: {
        listEl,
        addBtn,
        emptyEl,
        setProps,
        getItems: () => [...currentItems],
        getSelects: () => rowPool.slice(0, currentItems.length).map((r) => r.selectComp),
      },
    };
  },
});
return { EditableSlotList };
})();

// --- src/components/settings/ThemeColorPicker.js ---
const { ThemeColorPicker } = (() => {
/**
 * @fileoverview Host-aware Theme Accent Swatch Picker (`ThemeColorPicker.js`).
 * Provides the default "跟随宿主" (`host`) pill plus 6 curated color swatches.
 */


const ThemeColorPicker = defineComponent({
  name: 'ThemeColorPicker',
  setup({ props }) {
    let currentKey = normalizeClientThemeAccent(props.modelValue);

    const hostLabelEl = h('span', { text: t('settings.gen.accentHost') });
    const hostBtn = h(
      'button',
      {
        type: 'button',
        className: 'theme-host-chip',
        'data-accent-key': 'host',
        onClick: () => selectAccent('host'),
      },
      [hostLabelEl]
    );

    const swatchPresets = THEME_ACCENT_PRESETS.filter((p) => p.key !== 'host');
    const swatchEntries = swatchPresets.map((preset) => {
      const checkIcon = createSvgIcon('check', { size: 11 });
      const btn = h(
        'button',
        {
          type: 'button',
          className: 'theme-swatch-btn',
          'data-accent-key': preset.key,
          title: t(preset.labelKey),
          'aria-label': t(preset.labelKey),
          onClick: () => selectAccent(preset.key),
        },
        [checkIcon]
      );
      patchStyleVar(btn, '--swatch-color', preset.cssColor);
      return { preset, btn, checkIcon };
    });

    const swatchGroup = h(
      'span',
      { className: 'theme-swatch-group' },
      swatchEntries.map((s) => s.btn)
    );

    const rootEl = h('div', { className: 'theme-color-picker' }, [hostBtn, swatchGroup]);

    function syncVisuals() {
      const isHost = currentKey === 'host';
      patchClasses(hostBtn, { 'is-active': isHost });
      patchAttr(hostBtn, 'aria-pressed', isHost ? 'true' : 'false');
      for (const entry of swatchEntries) {
        const active = entry.preset.key === currentKey;
        patchClasses(entry.btn, { 'is-active': active });
        patchAttr(entry.btn, 'aria-pressed', active ? 'true' : 'false');
        patchAttr(entry.checkIcon, 'hidden', !active);
      }
    }

    function refreshLabels() {
      patchText(hostLabelEl, t('settings.gen.accentHost'));
      for (const entry of swatchEntries) {
        const label = t(entry.preset.labelKey);
        patchAttr(entry.btn, 'title', label);
        patchAttr(entry.btn, 'aria-label', label);
      }
    }

    function selectAccent(nextRaw) {
      const normalized = normalizeClientThemeAccent(nextRaw);
      if (normalized === currentKey) return;
      currentKey = normalized;
      syncVisuals();
      if (typeof props.onUpdateModelValue === 'function') {
        props.onUpdateModelValue(currentKey);
      }
    }

    function setValue(nextRaw) {
      currentKey = normalizeClientThemeAccent(nextRaw);
      syncVisuals();
    }

    syncVisuals();

    return {
      el: rootEl,
      refs: {
        hostBtn,
        swatchEntries,
        setValue,
        refreshLabels,
        getValue: () => currentKey,
      },
    };
  },
});
return { ThemeColorPicker };
})();

// --- src/components/settings/BridgeStatusNotice.js ---
const { BridgeStatusNotice } = (() => {
/**
 * @fileoverview Shared CDP / Window Bridge diagnostic & one-click relaunch card (`BridgeStatusNotice.js`).
 * Surfaces automatic shortcut provisioning status and a one-click host relaunch button when
 * Antigravity 2.33.0+ runs without an active `DevToolsActivePort` (`no_devtools_port` / `cdp_unreachable`).
 */


const LAUNCH_FLAG_TEXT = '--remote-debugging-port=0';

async function copyTextToClipboard(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback to temporary textarea inside restricted webview contexts
  }
  try {
    if (typeof document === 'undefined' || !document.body) return false;
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'true');
    area.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
    document.body.appendChild(area);
    area.select?.();
    const ok = Boolean(document.execCommand?.('copy'));
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

const BridgeStatusNotice = defineComponent({
  name: 'BridgeStatusNotice',
  setup({ props, onCleanup }) {
    let contextMode = Boolean(props?.contextMode);
    const dismissible = Boolean(props?.dismissible);
    let lastPayload = {
      visible: false,
      windowBridge: null,
      hostPlatform: 'win32',
    };
    let dismissed = false;
    let copied = false;
    let copiedTimer = null;
    let relaunchState = 'idle'; // 'idle' | 'relaunching' | 'failed'
    let relaunchResetTimer = null;
    let destroyed = false;

    const headIconEl = createSvgIcon('warning', { size: 13, className: 'settings-bridge-icon' });
    const titleEl = h('strong', { className: 'settings-bridge-title', text: '' });
    const bodyEl = h('p', { className: 'settings-bridge-desc', text: '' });

    const dismissBtnEl = dismissible
      ? h(
          'button',
          {
            type: 'button',
            className: 'btn-ghost-sm settings-bridge-dismiss-btn',
            'aria-label': t('settings.bridge.dismissAria'),
            title: t('settings.bridge.dismissAria'),
            onClick: () => {
              dismissed = true;
              render();
              props?.onDismiss?.();
            },
          },
          [createSvgIcon('close', { size: 11 })]
        )
      : null;

    const relaunchBtnIconEl = createSvgIcon('refresh', { size: 11 });
    const relaunchBtnTextEl = h('span', {
      className: 'settings-bridge-relaunch-text',
      text: t('settings.bridge.relaunchBtn'),
    });
    const relaunchBtnEl = h(
      'button',
      {
        type: 'button',
        className: 'settings-bridge-relaunch-btn',
        onClick: async () => {
          if (relaunchState === 'relaunching' || destroyed) return;
          relaunchState = 'relaunching';
          if (relaunchResetTimer) {
            clearTimeout(relaunchResetTimer);
            relaunchResetTimer = null;
          }
          syncActionButtons();
          try {
            const res = await triggerBridgeHostRelaunch();
            if (destroyed) return;
            if (!res || res.ok === false) {
              relaunchState = 'failed';
              syncActionButtons();
              relaunchResetTimer = setTimeout(() => {
                relaunchResetTimer = null;
                if (destroyed) return;
                relaunchState = 'idle';
                syncActionButtons();
              }, 3500);
              relaunchResetTimer?.unref?.();
              return;
            }
            // Reset button if host is still open after 9s (e.g. cancelled close prompt)
            relaunchResetTimer = setTimeout(() => {
              relaunchResetTimer = null;
              if (destroyed) return;
              relaunchState = 'idle';
              syncActionButtons();
            }, 9000);
            relaunchResetTimer?.unref?.();
          } catch {
            if (destroyed) return;
            relaunchState = 'failed';
            syncActionButtons();
            relaunchResetTimer = setTimeout(() => {
              relaunchResetTimer = null;
              if (destroyed) return;
              relaunchState = 'idle';
              syncActionButtons();
            }, 3500);
            relaunchResetTimer?.unref?.();
          }
        },
      },
      [relaunchBtnIconEl, relaunchBtnTextEl]
    );

    const copyBtnIconEl = createSvgIcon('copy', { size: 11 });
    const copyBtnTextEl = h('span', {
      className: 'settings-bridge-copy-text',
      text: t('settings.bridge.copyFlagBtn', { cmd: LAUNCH_FLAG_TEXT }),
    });
    const copyBtnEl = h(
      'button',
      {
        type: 'button',
        className: 'btn-ghost-sm settings-bridge-copy-btn',
        onClick: async () => {
          await copyTextToClipboard(LAUNCH_FLAG_TEXT);
          if (destroyed) return;
          copied = true;
          if (copiedTimer) clearTimeout(copiedTimer);
          syncActionButtons();
          copiedTimer = setTimeout(() => {
            copiedTimer = null;
            if (destroyed) return;
            copied = false;
            syncActionButtons();
          }, 1800);
          copiedTimer?.unref?.();
        },
      },
      [copyBtnIconEl, copyBtnTextEl]
    );

    const headLeftEl = h('div', { className: 'settings-bridge-head-main' }, [headIconEl, titleEl]);
    const headRowEl = h(
      'div',
      { className: 'settings-bridge-head' },
      dismissBtnEl ? [headLeftEl, dismissBtnEl] : [headLeftEl]
    );
    const actionsRowEl = h('div', { className: 'settings-bridge-actions' }, [
      relaunchBtnEl,
      copyBtnEl,
    ]);

    const rootEl = h(
      'div',
      {
        className: 'settings-bridge-notice',
        role: 'status',
        hidden: true,
      },
      [headRowEl, bodyEl, actionsRowEl]
    );

    function syncActionButtons() {
      const canRelaunch = lastPayload.windowBridge?.canRelaunch !== false;
      const needsAuth = Boolean(lastPayload.windowBridge?.hasReadOnlyShortcuts);
      patchAttr(relaunchBtnEl, 'hidden', !canRelaunch);
      patchAttr(relaunchBtnEl, 'disabled', relaunchState === 'relaunching');
      patchText(
        relaunchBtnTextEl,
        relaunchState === 'relaunching'
          ? t('settings.bridge.relaunchingBtn')
          : relaunchState === 'failed'
            ? t('settings.bridge.relaunchFailed')
            : needsAuth
              ? t('settings.bridge.relaunchAuthBtn')
              : t('settings.bridge.relaunchBtn')
      );

      patchSvgIcon(copyBtnIconEl, copied ? 'check' : 'copy');
      patchText(
        copyBtnTextEl,
        copied
          ? t('settings.bridge.copiedBtn')
          : t('settings.bridge.copyFlagBtn', { cmd: LAUNCH_FLAG_TEXT })
      );

      if (dismissBtnEl) {
        const aria = t('settings.bridge.dismissAria');
        patchAttr(dismissBtnEl, 'aria-label', aria);
        patchAttr(dismissBtnEl, 'title', aria);
      }
    }

    function render() {
      const wb = lastPayload.windowBridge;
      const state = String(wb?.state || '').trim();
      if (state === 'active') {
        dismissed = false;
      }
      const shouldShow =
        !dismissed &&
        Boolean(lastPayload.visible) &&
        !isWindowOverlayMode() &&
        (state === 'no_devtools_port' || state === 'cdp_unreachable');

      patchAttr(rootEl, 'hidden', !shouldShow);
      if (!shouldShow) return;

      const plat = String(lastPayload.hostPlatform || '').trim().toLowerCase();
      const hasReadOnlyShortcuts = Boolean(wb?.hasReadOnlyShortcuts);
      const isMacDesktop = plat === 'darwin' && !wb?.argvConfigured;
      const isAutoConfigured = Boolean(
        wb?.launcherConfigured || wb?.argvUpdatedThisBoot || wb?.argvConfigured
      );
      const useRestartTheme = !hasReadOnlyShortcuts && (isAutoConfigured || isMacDesktop);

      patchClasses(rootEl, {
        'is-restart': useRestartTheme,
        'is-warn': !useRestartTheme,
      });
      patchSvgIcon(headIconEl, useRestartTheme ? 'refresh' : 'warning');

      let titleText = '';
      let bodyText = '';
      if (hasReadOnlyShortcuts) {
        titleText = contextMode
          ? t('settings.bridge.ctxReadOnlyTitle')
          : t('settings.bridge.readOnlyTitle');
        bodyText = t('settings.bridge.readOnlyBody');
      } else if (isMacDesktop) {
        titleText = contextMode
          ? t('settings.bridge.ctxMacTitle')
          : t('settings.bridge.macTitle');
        bodyText = t('settings.bridge.guideMac');
      } else if (isAutoConfigured) {
        titleText = contextMode
          ? t('settings.bridge.ctxRestartTitle')
          : t('settings.bridge.restartTitle');
        bodyText = t('settings.bridge.restartBody');
      } else {
        titleText = contextMode
          ? t('settings.bridge.ctxTitle')
          : state === 'cdp_unreachable'
            ? t('settings.bridge.unreachableTitle')
            : t('settings.bridge.noPortTitle');
        bodyText = plat === 'linux' ? t('settings.bridge.guideLinux') : t('settings.bridge.guideWin');
      }

      patchText(titleEl, titleText);
      patchText(bodyEl, bodyText);
      syncActionButtons();
    }

    function update(next = {}) {
      if (typeof next.contextMode === 'boolean') {
        contextMode = next.contextMode;
      }
      lastPayload = {
        ...lastPayload,
        ...next,
      };
      render();
    }

    onCleanup(() => {
      destroyed = true;
      if (copiedTimer) {
        clearTimeout(copiedTimer);
        copiedTimer = null;
      }
      if (relaunchResetTimer) {
        clearTimeout(relaunchResetTimer);
        relaunchResetTimer = null;
      }
    });

    return {
      el: rootEl,
      refs: {
        update,
        refreshLabels: render,
        relaunchBtnEl,
        copyBtnEl,
        dismissBtnEl,
      },
    };
  },
});
return { BridgeStatusNotice };
})();

// --- src/views/settings/SettingsGeneralTab.js ---
const { SettingsGeneralTab } = (() => {
/**
 * @fileoverview Preferences Tab 1: `SettingsGeneralTab.js` ("常规").
 * Manages UI Language (`zh-CN` / `en-US` / `auto`), Theme Accent (`host` + 6 swatches),
 * Panel Font Scale (`sm` / `md` / `lg` / `xl`), Pricing Sync, and Plugin Updates.
 */


function getLanguageOptions() {
  return [
    { value: 'zh-CN', label: t('settings.gen.langZh') },
    { value: 'en-US', label: t('settings.gen.langEn') },
    { value: 'auto', label: t('settings.gen.langAuto') },
  ];
}

function getFontScaleOptions() {
  return [
    { value: 'sm', label: t('settings.gen.fontSm') },
    { value: 'md', label: t('settings.gen.fontMd') },
    { value: 'lg', label: t('settings.gen.fontLg') },
    { value: 'xl', label: t('settings.gen.fontXl') },
  ];
}

function getModernUiOptions() {
  return [
    { value: 'off', label: t('settings.gen.modernUiOff') },
    { value: 'on', label: t('settings.gen.modernUiOn') },
  ];
}

function getUpdateModeOptions() {
  return [
    { value: 'manual', label: t('settings.gen.updateManual') },
    { value: 'auto', label: t('settings.gen.updateAuto') },
    { value: 'off', label: t('settings.gen.updateOff') },
  ];
}

function formatCloudSyncTimeText(tsMs, updatedAt) {
  if (Number(tsMs) > 0) {
    const d = new Date(Number(tsMs));
    const pad = (n) => String(n).padStart(2, '0');
    const timeStr = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return t('settings.gen.syncAt', { time: timeStr });
  }
  if (updatedAt) {
    return t('settings.gen.pubAt', { date: String(updatedAt).slice(0, 10) });
  }
  return t('settings.gen.defaultPricing');
}

const SettingsGeneralTab = defineComponent({
  name: 'SettingsGeneralTab',
  setup({ props, onCleanup }) {
    let draftLanguage = 'zh-CN';
    let draftThemeAccent = 'host';
    let draftFontScale = 'md';
    let draftModernUi = false;
    let draftPluginUpdateMode = 'manual';
    let latestSettings = null;
    let latestCloudStatus = null;
    let appearanceTimer = null;
    let appearanceSaveSeq = 0;
    let cloudTimer = null;

    const appearanceStatusText = h('span', {
      className: 'text-muted',
      style: 'font-size: var(--fs-md);',
      text: '',
    });
    const cloudStatusMsg = h('span', {
      className: 'text-muted',
      style: 'font-size: var(--fs-md);',
      text: '',
    });

    function showAppearanceFeedback(text, autoClearMs = 1500) {
      if (appearanceTimer) {
        clearTimeout(appearanceTimer);
        appearanceTimer = null;
      }
      patchText(appearanceStatusText, text);
      if (text && autoClearMs > 0) {
        appearanceTimer = setTimeout(() => {
          appearanceTimer = null;
          patchText(appearanceStatusText, '');
        }, autoClearMs);
      }
    }

    function showCloudFeedback(text, autoClearMs = 3500) {
      if (cloudTimer) {
        clearTimeout(cloudTimer);
        cloudTimer = null;
      }
      patchText(cloudStatusMsg, text);
      if (text && autoClearMs > 0) {
        cloudTimer = setTimeout(() => {
          cloudTimer = null;
          patchText(cloudStatusMsg, '');
        }, autoClearMs);
      }
    }

    // --- Card 1: 界面与外观 ---
    const appearanceTitleEl = h('span', { text: t('settings.gen.appearanceTitle') });
    const langLabelEl = h('span', { className: 'form-label', text: t('settings.gen.language') });
    const accentLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.gen.themeAccent'),
    });
    const fontLabelEl = h('span', { className: 'form-label', text: t('settings.gen.fontScale') });
    const fontHintEl = h('span', {
      className: 'settings-hint-text',
      text: t('settings.gen.fontHint'),
    });
    const modernUiLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.gen.modernUi'),
    });
    const modernUiHintEl = h('span', {
      className: 'settings-hint-text',
      text: t('settings.gen.modernUiHint'),
    });

    const languageSwitch = SegmentedControl({
      ariaLabel: t('settings.gen.language'),
      modelValue: draftLanguage,
      options: getLanguageOptions(),
      onUpdateModelValue: async (val) => {
        const nextLang = normalizeI18nLanguage(val);
        draftLanguage = nextLang;
        setI18nLanguage(nextLang);
        languageSwitch.setValue(nextLang);
        const saveToken = ++appearanceSaveSeq;
        showAppearanceFeedback(t('settings.saving'), 0);
        try {
          await saveSettingsPatch({ language: nextLang });
          if (saveToken === appearanceSaveSeq) {
            showAppearanceFeedback(t('settings.saved'), 1500);
          }
        } catch {
          if (latestSettings) renderSettings(latestSettings);
          if (saveToken === appearanceSaveSeq) {
            showAppearanceFeedback(t('settings.saveFailed'), 2500);
          }
        }
      },
    });

    const themeColorPicker = ThemeColorPicker({
      modelValue: draftThemeAccent,
      onUpdateModelValue: async (val) => {
        const nextAccent = normalizeClientThemeAccent(val);
        draftThemeAccent = nextAccent;
        themeColorPicker.refs.setValue(nextAccent);
        const saveToken = ++appearanceSaveSeq;
        showAppearanceFeedback(t('settings.saving'), 0);
        try {
          await saveSettingsPatch({ themeAccent: nextAccent });
          if (saveToken === appearanceSaveSeq) {
            showAppearanceFeedback(t('settings.saved'), 1500);
          }
        } catch {
          if (latestSettings) renderSettings(latestSettings);
          if (saveToken === appearanceSaveSeq) {
            showAppearanceFeedback(t('settings.saveFailed'), 2500);
          }
        }
      },
    });

    const fontScaleSwitch = SegmentedControl({
      ariaLabel: t('settings.gen.fontScale'),
      modelValue: draftFontScale,
      options: getFontScaleOptions(),
      onUpdateModelValue: async (val) => {
        const nextScale = normalizeClientFontScale(val);
        draftFontScale = nextScale;
        fontScaleSwitch.setValue(nextScale);
        const saveToken = ++appearanceSaveSeq;
        showAppearanceFeedback(t('settings.saving'), 0);
        try {
          await saveSettingsPatch({ fontScale: nextScale });
          if (saveToken === appearanceSaveSeq) {
            showAppearanceFeedback(t('settings.saved'), 1500);
          }
          props.onLayoutChange?.();
        } catch {
          if (latestSettings) renderSettings(latestSettings);
          if (saveToken === appearanceSaveSeq) {
            showAppearanceFeedback(t('settings.saveFailed'), 2500);
          }
        }
      },
    });

    const modernUiSwitch = SegmentedControl({
      ariaLabel: t('settings.gen.modernUi'),
      modelValue: 'off',
      options: getModernUiOptions(),
      onUpdateModelValue: async (val) => {
        const nextModernUi = val === 'on';
        draftModernUi = nextModernUi;
        modernUiSwitch.setValue(nextModernUi ? 'on' : 'off');
        if (!isWindowOverlayMode() && typeof document !== 'undefined' && document.documentElement) {
          applyAppearanceToRoot(
            document.documentElement,
            {
              ...(latestSettings || {}),
              themeAccent: draftThemeAccent,
              fontScale: draftFontScale,
              experimentalModernUi: nextModernUi,
            },
            { includeFontScale: true }
          );
        }
        const saveToken = ++appearanceSaveSeq;
        showAppearanceFeedback(t('settings.saving'), 0);
        try {
          await saveSettingsPatch({ experimentalModernUi: nextModernUi });
          if (saveToken === appearanceSaveSeq) {
            showAppearanceFeedback(t('settings.saved'), 1500);
          }
          props.onLayoutChange?.();
        } catch {
          if (latestSettings) renderSettings(latestSettings);
          if (saveToken === appearanceSaveSeq) {
            showAppearanceFeedback(t('settings.saveFailed'), 2500);
          }
        }
      },
    });

    const appearancePanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('sliders', { size: 13 }),
          appearanceTitleEl,
        ]),
        appearanceStatusText,
      ]),
      h('div', { className: 'form-row' }, [langLabelEl, languageSwitch.el]),
      h('div', { className: 'form-row' }, [accentLabelEl, themeColorPicker.el]),
      h('div', { className: 'form-row' }, [fontLabelEl, fontScaleSwitch.el, fontHintEl]),
      h('div', { className: 'form-row' }, [modernUiLabelEl, modernUiSwitch.el, modernUiHintEl]),
    ]);

    // --- Card 2: 版本更新 ---
    const updateTitleEl = h('span', { text: t('settings.gen.updateTitle') });
    const updateModeLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.gen.updateMode'),
    });
    const pricingCellLabelEl = h('span', {
      className: 'cell-label',
      text: t('settings.gen.pricingLabel'),
    });
    const versionCellLabelEl = h('span', {
      className: 'cell-label',
      text: t('settings.gen.versionLabel'),
    });

    const autoUpdateSelect = CustomSelect({
      modelValue: 'manual',
      icon: 'refresh',
      options: getUpdateModeOptions(),
      onUpdateModelValue: async (val) => {
        const nextMode = normalizeClientUpdateMode(val);
        draftPluginUpdateMode = nextMode;
        autoUpdateSelect.setValue(nextMode);
        if (latestCloudStatus) {
          renderCloudStatus(latestCloudStatus);
        }
        showCloudFeedback(t('settings.saving'), 0);
        try {
          await saveSettingsPatch({
            pluginUpdateMode: nextMode,
            autoUpdatePlugin: nextMode === 'auto',
          });
          showCloudFeedback(t('settings.saved'), 1800);
        } catch {
          if (latestSettings) renderSettings(latestSettings);
          if (latestCloudStatus) renderCloudStatus(latestCloudStatus);
          showCloudFeedback(t('settings.saveFailed'), 2500);
        }
      },
    });

    const pricingCountVal = h('strong', { className: 'cell-value', text: '—' });
    const pricingSyncSub = h('span', { className: 'cell-sub', text: t('quota.loading') });
    const versionVal = h('strong', { className: 'cell-value', text: 'v1.4.4' });
    const versionSub = h('span', { className: 'cell-sub', text: t('settings.gen.checkingBtn') });

    const syncPricingBtnText = h('span', { text: t('settings.gen.syncBtn') });
    const syncPricingBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: async () => {
          patchAttr(syncPricingBtn, 'disabled', true);
          patchText(syncPricingBtnText, t('settings.gen.syncingBtn'));
          showCloudFeedback(t('settings.gen.syncingMsg'), 0);
          try {
            const res = await triggerCloudSync();
            const cs = res?.cloudStatus;
            if (res?.ok && cs) {
              showCloudFeedback(t('settings.gen.syncedMsg', { count: cs.modelCount }), 3500);
            } else {
              showCloudFeedback(cs?.lastSyncError || t('settings.gen.syncFallbackMsg'), 4500);
            }
          } catch (err) {
            showCloudFeedback(err?.message || t('settings.gen.syncFallbackMsg'), 4500);
          } finally {
            patchAttr(syncPricingBtn, 'disabled', false);
            patchText(syncPricingBtnText, t('settings.gen.syncBtn'));
          }
        },
      },
      [createSvgIcon('refresh', { size: 12 }), syncPricingBtnText]
    );

    const updatePluginBtnText = h('span', { text: t('settings.gen.checkUpdateBtn') });
    const updatePluginBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: async () => {
          patchAttr(updatePluginBtn, 'disabled', true);
          try {
            if (!latestCloudStatus?.updateAvailable) {
              patchText(updatePluginBtnText, t('settings.gen.checkingBtn'));
              showCloudFeedback(t('settings.gen.checkingMsg'), 0);
              const syncRes = await triggerCloudSync();
              const cs = syncRes?.cloudStatus || latestCloudStatus;
              if (cs) {
                latestCloudStatus = cs;
                renderCloudStatus(cs);
              }
              if (!syncRes?.ok && cs?.lastSyncError) {
                showCloudFeedback(
                  t('settings.gen.checkFailedMsg', { err: cs.lastSyncError }),
                  5000
                );
                return;
              }
              if (!cs?.updateAvailable) {
                const curVer = cs?.currentPluginVersion || '1.4.4';
                showCloudFeedback(t('settings.gen.upToDateMsg', { ver: curVer }), 4500);
                return;
              }
            }
            patchText(updatePluginBtnText, t('capsule.updating'));
            showCloudFeedback(t('settings.gen.downloadingMsg'), 0);
            const res = await triggerPluginUpdate();
            if (res?.cloudStatus) {
              latestCloudStatus = res.cloudStatus;
            }
            if (res?.ok) {
              showCloudFeedback(res.message || t('settings.gen.updatedRestartMsg'), 5000);
            } else {
              showCloudFeedback(res?.message || t('settings.gen.updateSkippedMsg'), 5500);
            }
          } catch (err) {
            showCloudFeedback(err?.message || t('settings.gen.updateFailedMsg'), 5000);
          } finally {
            patchAttr(updatePluginBtn, 'disabled', false);
            renderCloudStatus(latestCloudStatus);
          }
        },
      },
      [createSvgIcon('arrow-down', { size: 12 }), updatePluginBtnText]
    );

    const cloudPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('bolt', { size: 13 }),
          updateTitleEl,
        ]),
        cloudStatusMsg,
      ]),
      h('div', { className: 'form-row' }, [updateModeLabelEl, autoUpdateSelect.el]),
      h('div', { className: 'dual-grid' }, [
        h('div', { className: 'matrix-cell' }, [
          pricingCellLabelEl,
          pricingCountVal,
          pricingSyncSub,
        ]),
        h('div', { className: 'matrix-cell' }, [versionCellLabelEl, versionVal, versionSub]),
      ]),
      h('div', { className: 'cloud-actions-row' }, [syncPricingBtn, updatePluginBtn]),
    ]);

    const rootEl = h('div', { className: 'settings-tab-stack' }, [appearancePanel, cloudPanel]);

    function renderSettings(settings) {
      if (!settings) return;
      latestSettings = settings;
      draftLanguage = normalizeI18nLanguage(settings.language);
      draftThemeAccent = normalizeClientThemeAccent(settings.themeAccent);
      draftFontScale = normalizeClientFontScale(settings.fontScale);
      draftModernUi = normalizeClientModernUi(settings.experimentalModernUi);
      draftPluginUpdateMode = normalizeClientUpdateMode(
        settings.pluginUpdateMode,
        settings.autoUpdatePlugin
      );

      languageSwitch.setProps({
        modelValue: draftLanguage,
        options: getLanguageOptions(),
      });
      themeColorPicker.refs.setValue(draftThemeAccent);
      fontScaleSwitch.setProps({
        modelValue: draftFontScale,
        options: getFontScaleOptions(),
      });
      modernUiSwitch.setProps({
        modelValue: draftModernUi ? 'on' : 'off',
        options: getModernUiOptions(),
      });
      autoUpdateSelect.setProps({
        modelValue: draftPluginUpdateMode,
        options: getUpdateModeOptions(),
      });
    }

    function renderCloudStatus(cs) {
      if (!cs) return;
      latestCloudStatus = cs;
      const srcLabel =
        cs.source === 'remote'
          ? t('settings.gen.srcRemote')
          : cs.source === 'local'
            ? t('settings.gen.srcLocal')
            : t('settings.gen.srcDefault');
      patchText(pricingCountVal, t('settings.gen.modelCount', { count: cs.modelCount || 0 }));
      patchText(
        pricingSyncSub,
        `${srcLabel} · ${formatCloudSyncTimeText(cs.lastSyncedAtMs, cs.catalogUpdatedAt)}`
      );

      const curVer = cs.currentPluginVersion || '1.4.4';
      const latVer = cs.latestPluginVersion || curVer;
      const modeTag = cs.installMode === 'git' ? 'Git' : 'ZIP';
      patchText(versionVal, `v${curVer}`);
      if (cs.updateAvailable && draftPluginUpdateMode !== 'off') {
        patchText(versionSub, t('settings.gen.canUpgradeSub', { ver: latVer, mode: modeTag }));
        patchClasses(versionSub, { 'accent-ok': true });
        patchText(updatePluginBtnText, t('settings.gen.upgradeToBtn', { ver: latVer }));
        patchClasses(updatePluginBtn, { 'btn-primary': true, 'btn-secondary': false });
      } else if (draftPluginUpdateMode === 'off') {
        patchText(versionSub, t('settings.gen.updateOffSub', { mode: modeTag }));
        patchClasses(versionSub, { 'accent-ok': false });
        patchText(
          updatePluginBtnText,
          cs.updateAvailable
            ? t('settings.gen.manualUpgradeBtn', { ver: latVer })
            : t('settings.gen.checkUpdateBtn')
        );
        patchClasses(updatePluginBtn, { 'btn-primary': false, 'btn-secondary': true });
      } else {
        patchText(versionSub, t('settings.gen.latestSub', { mode: modeTag }));
        patchClasses(versionSub, { 'accent-ok': false });
        patchText(updatePluginBtnText, t('settings.gen.checkUpdateBtn'));
        patchClasses(updatePluginBtn, { 'btn-primary': false, 'btn-secondary': true });
      }

      if (
        !cloudTimer &&
        (cs.lastUpdateError || (cs.lastUpdateResult?.ok === false && cs.lastUpdateResult?.message))
      ) {
        showCloudFeedback(cs.lastUpdateError || cs.lastUpdateResult.message, 5500);
      }
    }

    function refreshLabels() {
      patchText(appearanceTitleEl, t('settings.gen.appearanceTitle'));
      patchText(langLabelEl, t('settings.gen.language'));
      patchText(accentLabelEl, t('settings.gen.themeAccent'));
      patchText(fontLabelEl, t('settings.gen.fontScale'));
      patchText(fontHintEl, t('settings.gen.fontHint'));
      patchText(modernUiLabelEl, t('settings.gen.modernUi'));
      patchText(modernUiHintEl, t('settings.gen.modernUiHint'));
      patchText(updateTitleEl, t('settings.gen.updateTitle'));
      patchText(updateModeLabelEl, t('settings.gen.updateMode'));
      patchText(pricingCellLabelEl, t('settings.gen.pricingLabel'));
      patchText(versionCellLabelEl, t('settings.gen.versionLabel'));
      if (!syncPricingBtn.hasAttribute('disabled')) {
        patchText(syncPricingBtnText, t('settings.gen.syncBtn'));
      }
      languageSwitch.setProps({
        modelValue: draftLanguage,
        options: getLanguageOptions(),
      });
      themeColorPicker.refs.refreshLabels();
      fontScaleSwitch.setProps({
        modelValue: draftFontScale,
        options: getFontScaleOptions(),
      });
      modernUiSwitch.setProps({
        ariaLabel: t('settings.gen.modernUi'),
        modelValue: draftModernUi ? 'on' : 'off',
        options: getModernUiOptions(),
      });
      autoUpdateSelect.setProps({
        modelValue: draftPluginUpdateMode,
        options: getUpdateModeOptions(),
      });
      if (latestCloudStatus) {
        renderCloudStatus(latestCloudStatus);
      } else {
        patchText(pricingSyncSub, t('quota.loading'));
      }
    }

    onCleanup(() => {
      if (appearanceTimer) clearTimeout(appearanceTimer);
      if (cloudTimer) clearTimeout(cloudTimer);
      languageSwitch.destroy();
      themeColorPicker.destroy();
      fontScaleSwitch.destroy();
      modernUiSwitch.destroy();
      autoUpdateSelect.destroy();
    });

    return {
      el: rootEl,
      refs: {
        languageSwitch,
        themeColorPicker,
        fontScaleSwitch,
        modernUiSwitch,
        autoUpdateSelect,
        syncPricingBtn,
        updatePluginBtn,
        renderSettings,
        renderCloudStatus,
        refreshLabels,
      },
    };
  },
});
return { SettingsGeneralTab };
})();

// --- src/views/settings/SettingsStructureTab.js ---
const { SettingsStructureTab } = (() => {
/**
 * @fileoverview Preferences Tab 2: `SettingsStructureTab.js` ("结构").
 * Organizes the 4 structure settings panes under a dedicated 3rd-level menu bar,
 * renders live previews powered by the decoupled real UI components (`CapsuleBarWidget`,
 * `createDynamicWidgetHost` in `hover` / `overview` modes, and `StepTableWidget`)
 * with simulated telemetry, and supports smooth mouse drag-and-drop reordering.
 */


const STRUCTURE_THIRD_TABS = Object.freeze([
  { key: 'mount', icon: 'dock', labelKey: 'settings.str.tabMount' },
  { key: 'hover', icon: 'layers', labelKey: 'settings.str.tabHover' },
  { key: 'overview', icon: 'pulse', labelKey: 'settings.str.tabOverview' },
  { key: 'steps', icon: 'table', labelKey: 'settings.str.tabSteps' },
]);

function normalizeStructureTabKey(raw) {
  const k = String(raw || '').trim();
  return k === 'hover' || k === 'overview' || k === 'steps' ? k : 'mount';
}

function getMountModeOptions() {
  return [
    { value: 'dual', label: t('settings.str.mountDual') },
    { value: 'composer', label: t('settings.str.mountComposer') },
    { value: 'sidebar', label: t('settings.str.mountSidebar') },
  ];
}

function getMultiToggleOptions() {
  return [
    { value: 'show', label: t('settings.str.show') },
    { value: 'hide', label: t('settings.str.hide') },
  ];
}

function getEnableToggleOptions() {
  return [
    { value: 'on', label: t('settings.str.on') },
    { value: 'off', label: t('settings.str.off') },
  ];
}

function getPopoverWidthModeOptions() {
  return [
    { value: 'auto', label: t('settings.str.popoverWidthAuto') },
    { value: 'custom', label: t('settings.str.popoverWidthCustom') },
  ];
}

function isSameList(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const SettingsStructureTab = defineComponent({
  name: 'SettingsStructureTab',
  setup({ props, onCleanup }) {
    let activeThirdTab = normalizeStructureTabKey(uiStore.getState().settingsStructureTab);
    let draftWindowMountMode = 'dual';
    let draftPopoverWidthMode = 'auto';
    let draftPopoverWidth = DEFAULT_CLIENT_POPOVER_WIDTH;
    let draftEnableCliStatusLine = true;
    let draftShowTopbarMulti = true;
    let draftTopbarSlots = [...DEFAULT_CLIENT_TOPBAR_SLOTS];
    let draftHoverModules = [...DEFAULT_CLIENT_HOVER_MODULES];
    let draftOverviewModules = [...DEFAULT_CLIENT_OVERVIEW_MODULES];
    let draftOverviewMetrics = [...DEFAULT_CLIENT_OVERVIEW_METRICS];
    let draftShowStepTurnRail = false;
    let draftShowStepAgentBadge = true;
    let draftShowStepSpeedColor = false;
    let draftStepTokenComboFormat = DEFAULT_CLIENT_STEP_TOKEN_COMBO_FORMAT;
    let rawStepTokenComboText = DEFAULT_CLIENT_STEP_TOKEN_COMBO_FORMAT;
    let draftStepColumns = [...DEFAULT_CLIENT_STEP_COLUMNS];
    let latestSettings = null;
    let latestWindowBridge = null;
    let latestHostPlatform = 'win32';

    function isStructureVisible() {
      const st = uiStore.getState();
      return getVisibleMonitorView(st) === 'settings' && st.settingsSubTab === 'structure';
    }

    function buildDraftTelemetry() {
      return buildStructurePreviewTelemetry(latestSettings, {
        windowMountMode: draftWindowMountMode,
        enableWindowOverlay: draftWindowMountMode !== 'sidebar',
        popoverWidthMode: draftPopoverWidthMode,
        popoverWidth: draftPopoverWidth,
        enableCliStatusLine: draftEnableCliStatusLine,
        showTopbarMultiSession: draftShowTopbarMulti,
        topbarCapsuleSlots: draftTopbarSlots,
        hoverModules: draftHoverModules,
        overviewModules: draftOverviewModules,
        overviewMetrics: draftOverviewMetrics,
        showStepTurnRail: draftShowStepTurnRail,
        showStepAgentBadge: draftShowStepAgentBadge,
        showStepSpeedColor: draftShowStepSpeedColor,
        stepTokenComboFormat: draftStepTokenComboFormat,
        stepTableColumns: draftStepColumns,
      });
    }

    async function persistStructurePatch(sectionComp, patchObj, successKey = 'settings.saved') {
      sectionComp.refs.showStatus(t('settings.saving'), 0);
      try {
        await saveSettingsPatch(patchObj);
        sectionComp.refs.showStatus(t(successKey), 1500);
      } catch {
        if (latestSettings) {
          renderSettings(latestSettings);
        }
        sectionComp.refs.showStatus(t('settings.saveFailed'), 2500);
      }
    }

    // --- 3rd-Level Navigation Bar ---
    const thirdNavBtnMap = new Map();
    const thirdNavBtns = STRUCTURE_THIRD_TABS.map((item) => {
      const labelEl = h('span', {
        className: 'structure-thirdnav-label',
        text: t(item.labelKey),
      });
      const btn = h(
        'button',
        {
          type: 'button',
          className: `structure-thirdnav-btn${item.key === activeThirdTab ? ' is-active' : ''}`,
          role: 'tab',
          'aria-selected': item.key === activeThirdTab ? 'true' : 'false',
          'data-structure-tab': item.key,
          onClick: () => {
            applyActiveThirdTab(item.key);
            if (uiStore.getState().settingsStructureTab !== item.key) {
              uiStore.setState({ settingsStructureTab: item.key });
            }
          },
          onKeydown: (e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              e.preventDefault();
              const curIdx = Math.max(
                0,
                STRUCTURE_THIRD_TABS.findIndex((it) => it.key === item.key)
              );
              const delta = e.key === 'ArrowRight' ? 1 : -1;
              const nextIdx =
                (curIdx + delta + STRUCTURE_THIRD_TABS.length) % STRUCTURE_THIRD_TABS.length;
              const nextItem = STRUCTURE_THIRD_TABS[nextIdx];
              if (nextItem) {
                applyActiveThirdTab(nextItem.key);
                if (uiStore.getState().settingsStructureTab !== nextItem.key) {
                  uiStore.setState({ settingsStructureTab: nextItem.key });
                }
                thirdNavBtnMap.get(nextItem.key)?.btn?.focus?.();
              }
            }
          },
        },
        [createSvgIcon(item.icon, { size: 12 }), labelEl]
      );
      thirdNavBtnMap.set(item.key, { btn, labelEl, labelKey: item.labelKey });
      return btn;
    });

    const thirdNavGlider = h('div', { className: 'thirdnav-glider', 'aria-hidden': 'true' });
    const thirdNavBar = h(
      'div',
      {
        className: 'settings-thirdnav-bar',
        role: 'tablist',
        'aria-label': t('settings.str.thirdTabAria'),
      },
      [thirdNavGlider, ...thirdNavBtns]
    );
    patchStyleVar(
      thirdNavBar,
      '--active-third-index',
      Math.max(
        0,
        STRUCTURE_THIRD_TABS.findIndex((it) => it.key === activeThirdTab)
      )
    );

    // --- Pane 1: 挂载与胶囊栏 (`mount`) ---
    const capsulePreviewWidget = CapsuleBarWidget({});
    const mountPreviewCanvas = h('div', { className: 'structure-preview-canvas' }, [
      capsulePreviewWidget.el,
    ]);

    const mountModeLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.str.mountMode'),
    });
    const popoverWidthLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.str.popoverWidthLabel'),
    });
    const popoverWidthHintEl = h('span', {
      className: 'settings-hint-text',
      text: t('settings.str.popoverWidthHint'),
    });
    const multiToggleLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.str.multiToggle'),
    });
    const cliCapsuleLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.str.cliCapsuleToggle'),
    });
    const capsuleSlotsLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.str.capsuleSlotsLabel'),
    });

    const windowMountSelect = CustomSelect({
      modelValue: draftWindowMountMode,
      icon: 'dock',
      options: getMountModeOptions(),
      onUpdateModelValue: (val) => {
        const nextMode = normalizeClientWindowMountMode(val);
        draftWindowMountMode = nextMode;
        syncMountSectionMeta();
        props.onLayoutChange?.();
        void persistStructurePatch(mountSection, {
          windowMountMode: nextMode,
          enableWindowOverlay: nextMode !== 'sidebar',
        });
      },
    });

    const popoverWidthStepper = CustomNumberInput({
      modelValue: draftPopoverWidth,
      min: MIN_CLIENT_POPOVER_WIDTH,
      max: MAX_CLIENT_POPOVER_WIDTH,
      step: 10,
      ariaLabel: t('settings.str.popoverWidthLabel'),
      onUpdateModelValue: (val) => {
        const nextWidth = normalizeClientPopoverWidth(val);
        draftPopoverWidth = nextWidth;
        syncMountSectionMeta();
        props.onLayoutChange?.();
        void persistStructurePatch(mountSection, {
          popoverWidthMode: draftPopoverWidthMode,
          popoverWidth: draftPopoverWidth,
        });
      },
    });

    const popoverWidthNumWrap = h(
      'span',
      { className: 'settings-number-wrap', hidden: draftPopoverWidthMode !== 'custom' },
      [popoverWidthStepper.el, h('span', { className: 'settings-number-unit', text: 'px' })]
    );

    const popoverWidthModeToggle = SegmentedControl({
      ariaLabel: t('settings.str.popoverWidthLabel'),
      modelValue: draftPopoverWidthMode,
      options: getPopoverWidthModeOptions(),
      onUpdateModelValue: (val) => {
        draftPopoverWidthMode = normalizeClientPopoverWidthMode(val);
        syncMountSectionMeta();
        props.onLayoutChange?.();
        void persistStructurePatch(mountSection, {
          popoverWidthMode: draftPopoverWidthMode,
          popoverWidth: draftPopoverWidth,
        });
      },
    });

    const multiSessionToggle = SegmentedControl({
      ariaLabel: t('settings.str.multiToggle'),
      modelValue: 'show',
      options: getMultiToggleOptions(),
      onUpdateModelValue: (val) => {
        draftShowTopbarMulti = val !== 'hide';
        syncMountSectionMeta();
        void persistStructurePatch(mountSection, {
          showTopbarMultiSession: draftShowTopbarMulti,
        });
      },
    });

    const cliCapsuleToggle = SegmentedControl({
      ariaLabel: t('settings.str.cliCapsuleToggle'),
      modelValue: 'on',
      options: getEnableToggleOptions(),
      onUpdateModelValue: (val) => {
        draftEnableCliStatusLine = val !== 'off';
        syncMountSectionMeta();
        void persistStructurePatch(mountSection, {
          enableCliStatusLine: draftEnableCliStatusLine,
        });
      },
    });

    const topbarSlotsList = EditableSlotList({
      items: draftTopbarSlots,
      options: getCapsuleMetricOptions(),
      minItems: 1,
      maxItems: 5,
      addBtnTextFn: (count, max) => t('settings.str.addCapsuleSlot', { count, max }),
      onPreview: (previewItems) => {
        draftTopbarSlots = normalizeClientTopbarSlots(previewItems);
        refreshMountPreview();
      },
      onChange: (nextItems) => {
        draftTopbarSlots = normalizeClientTopbarSlots(nextItems);
        syncMountSectionMeta();
        props.onLayoutChange?.();
        void persistStructurePatch(mountSection, {
          topbarCapsuleSlots: draftTopbarSlots,
        });
      },
    });

    const mountBridgeNotice = BridgeStatusNotice({});

    const mountSection = CollapsibleSection({
      collapsible: false,
      icon: 'dock',
      title: t('settings.str.mountSection'),
      badgeText: t('settings.str.mountBadge', { count: draftTopbarSlots.length }),
      onReset: () => {
        draftWindowMountMode = 'dual';
        draftPopoverWidthMode = 'auto';
        draftPopoverWidth = DEFAULT_CLIENT_POPOVER_WIDTH;
        popoverWidthStepper.setProps({ modelValue: DEFAULT_CLIENT_POPOVER_WIDTH });
        draftEnableCliStatusLine = true;
        draftShowTopbarMulti = true;
        draftTopbarSlots = [...DEFAULT_CLIENT_TOPBAR_SLOTS];
        syncMountSectionMeta();
        props.onLayoutChange?.();
        void persistStructurePatch(
          mountSection,
          {
            windowMountMode: 'dual',
            enableWindowOverlay: true,
            popoverWidthMode: 'auto',
            popoverWidth: DEFAULT_CLIENT_POPOVER_WIDTH,
            enableCliStatusLine: true,
            showTopbarMultiSession: true,
            topbarCapsuleSlots: [...DEFAULT_CLIENT_TOPBAR_SLOTS],
          },
          'settings.resetDone'
        );
      },
      children: [
        mountPreviewCanvas,
        h('div', { className: 'settings-divider' }),
        h('div', { className: 'form-row' }, [mountModeLabelEl, windowMountSelect.el]),
        mountBridgeNotice.el,
        h('div', { className: 'form-row' }, [
          h('div', { className: 'settings-inline-row' }, [
            popoverWidthLabelEl,
            h('div', { className: 'settings-inline-controls' }, [
              popoverWidthModeToggle.el,
              popoverWidthNumWrap,
            ]),
          ]),
          popoverWidthHintEl,
        ]),
        h('div', { className: 'settings-inline-row' }, [
          multiToggleLabelEl,
          multiSessionToggle.el,
        ]),
        h('div', { className: 'settings-inline-row' }, [
          cliCapsuleLabelEl,
          cliCapsuleToggle.el,
        ]),
        h('div', { className: 'form-row' }, [capsuleSlotsLabelEl, topbarSlotsList.el]),
      ],
    });

    function refreshMountPreview() {
      if (!isStructureVisible() || activeThirdTab !== 'mount') return;
      capsulePreviewWidget.refs.update({ data: buildDraftTelemetry() });
    }

    function syncMountSectionMeta() {
      windowMountSelect.setProps({
        modelValue: draftWindowMountMode,
        options: getMountModeOptions(),
      });
      mountBridgeNotice.refs.update({
        visible: draftWindowMountMode !== 'sidebar',
        windowBridge: latestWindowBridge,
        hostPlatform: latestHostPlatform,
      });
      popoverWidthModeToggle.setProps({
        modelValue: draftPopoverWidthMode,
        options: getPopoverWidthModeOptions(),
      });
      patchAttr(popoverWidthNumWrap, 'hidden', draftPopoverWidthMode !== 'custom');
      if (document?.activeElement !== popoverWidthStepper.refs.textField) {
        popoverWidthStepper.setProps({
          modelValue: draftPopoverWidth,
          ariaLabel: t('settings.str.popoverWidthLabel'),
        });
      }
      multiSessionToggle.setProps({
        modelValue: draftShowTopbarMulti ? 'show' : 'hide',
        options: getMultiToggleOptions(),
      });
      cliCapsuleToggle.setProps({
        modelValue: draftEnableCliStatusLine ? 'on' : 'off',
        options: getEnableToggleOptions(),
      });
      topbarSlotsList.refs.setProps({
        items: draftTopbarSlots,
        options: getCapsuleMetricOptions(),
        addBtnTextFn: (count, max) => t('settings.str.addCapsuleSlot', { count, max }),
      });
      mountSection.refs.setBadge(
        t('settings.str.mountBadge', { count: draftTopbarSlots.length })
      );
      const isDefault =
        draftWindowMountMode === 'dual' &&
        draftPopoverWidthMode === 'auto' &&
        draftPopoverWidth === DEFAULT_CLIENT_POPOVER_WIDTH &&
        draftEnableCliStatusLine === true &&
        draftShowTopbarMulti === true &&
        isSameList(draftTopbarSlots, DEFAULT_CLIENT_TOPBAR_SLOTS);
      mountSection.refs.setResetDisabled(isDefault);
      refreshMountPreview();
    }

    // --- Pane 2: 鼠标悬浮窗 (`hover`) ---
    const hoverWidgetsContainerEl = h('div', { className: 'wm-hover-widgets' });
    const hoverPreviewTipEl = h('div', { className: 'wm-hover-tip is-preview' }, [
      hoverWidgetsContainerEl,
    ]);
    const hoverPreviewEmptyEl = h('div', {
      className: 'structure-preview-empty',
      hidden: true,
      text: t('settings.str.hoverEmptyHint'),
    });
    const hoverPreviewHost = createDynamicWidgetHost({
      containerEl: hoverWidgetsContainerEl,
      mode: 'hover',
      preview: true,
      isVisibleFn: () => isStructureVisible() && activeThirdTab === 'hover',
      initialModuleKeys: [],
    });
    const hoverPreviewCanvas = h('div', { className: 'structure-preview-canvas' }, [
      hoverPreviewTipEl,
      hoverPreviewEmptyEl,
    ]);

    const hoverModulesLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.str.hoverModulesLabel'),
    });

    const hoverModulesList = EditableSlotList({
      items: draftHoverModules,
      options: getOverviewModuleOptions(),
      minItems: 0,
      maxItems: 4,
      emptyHintText: t('settings.str.hoverEmptyHint'),
      addBtnTextFn: (count, max) => t('settings.str.addHoverModule', { count, max }),
      onPreview: (previewItems) => {
        draftHoverModules = normalizeClientHoverModules(previewItems);
        refreshHoverPreview();
      },
      onChange: (nextItems) => {
        draftHoverModules = normalizeClientHoverModules(nextItems);
        syncHoverSectionMeta();
        props.onLayoutChange?.();
        void persistStructurePatch(hoverSection, {
          hoverModules: draftHoverModules,
        });
      },
    });

    const hoverSection = CollapsibleSection({
      collapsible: false,
      icon: 'layers',
      title: t('settings.str.hoverSection'),
      badgeText: t('settings.str.hoverBadgeCount', { count: draftHoverModules.length }),
      onReset: () => {
        draftHoverModules = [...DEFAULT_CLIENT_HOVER_MODULES];
        syncHoverSectionMeta();
        props.onLayoutChange?.();
        void persistStructurePatch(
          hoverSection,
          { hoverModules: [...DEFAULT_CLIENT_HOVER_MODULES] },
          'settings.resetDone'
        );
      },
      children: [
        hoverPreviewCanvas,
        h('div', { className: 'settings-divider' }),
        h('div', { className: 'form-row' }, [hoverModulesLabelEl, hoverModulesList.el]),
      ],
    });

    function refreshHoverPreview() {
      if (!isStructureVisible() || activeThirdTab !== 'hover') return;
      const hasModules = draftHoverModules.length > 0;
      patchAttr(hoverPreviewTipEl, 'hidden', !hasModules);
      patchAttr(hoverPreviewEmptyEl, 'hidden', hasModules);
      patchText(hoverPreviewEmptyEl, t('settings.str.hoverEmptyHint'));
      hoverPreviewHost.update({
        moduleKeys: draftHoverModules,
        data: buildDraftTelemetry(),
      });
    }

    function syncHoverSectionMeta() {
      hoverModulesList.refs.setProps({
        items: draftHoverModules,
        options: getOverviewModuleOptions(),
        emptyHintText: t('settings.str.hoverEmptyHint'),
        addBtnTextFn: (count, max) => t('settings.str.addHoverModule', { count, max }),
      });
      hoverSection.refs.setBadge(
        draftHoverModules.length === 0
          ? t('settings.str.hoverBadgeOff')
          : t('settings.str.hoverBadgeCount', { count: draftHoverModules.length })
      );
      hoverSection.refs.setResetDisabled(
        isSameList(draftHoverModules, DEFAULT_CLIENT_HOVER_MODULES)
      );
      refreshHoverPreview();
    }

    // --- Pane 3: 实时监控布局 (`overview`) ---
    const overviewPreviewContainerEl = h('div', { className: 'overview-modules-host is-preview' });
    const overviewPreviewHost = createDynamicWidgetHost({
      containerEl: overviewPreviewContainerEl,
      mode: 'overview',
      preview: true,
      isVisibleFn: () => isStructureVisible() && activeThirdTab === 'overview',
      initialModuleKeys: [],
    });
    const overviewPreviewCanvas = h('div', { className: 'structure-preview-canvas' }, [
      overviewPreviewContainerEl,
    ]);

    const overviewModulesLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.str.overviewModulesLabel'),
    });
    const overviewMetricsLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.str.overviewMetricsLabel'),
    });
    const overviewMetricsHintEl = h('span', {
      className: 'settings-hint-text',
      hidden: true,
      text: t('settings.str.overviewMetricsInactiveHint'),
    });

    const overviewModulesList = EditableSlotList({
      items: draftOverviewModules,
      options: getOverviewModuleOptions(),
      minItems: 1,
      maxItems: 4,
      addBtnTextFn: (count, max) => t('settings.str.addOverviewModule', { count, max }),
      onPreview: (previewItems) => {
        draftOverviewModules = normalizeClientOverviewModules(previewItems);
        patchAttr(overviewMetricsHintEl, 'hidden', draftOverviewModules.includes('metrics'));
        refreshOverviewPreview();
      },
      onChange: (nextItems) => {
        draftOverviewModules = normalizeClientOverviewModules(nextItems);
        syncOverviewSectionMeta();
        props.onLayoutChange?.();
        void persistStructurePatch(overviewSection, {
          overviewModules: draftOverviewModules,
        });
      },
    });

    const overviewMetricsList = EditableSlotList({
      items: draftOverviewMetrics,
      options: getOverviewMetricOptions(),
      minItems: 1,
      maxItems: 4,
      addBtnTextFn: (count, max) => t('settings.str.addOverviewMetric', { count, max }),
      onPreview: (previewItems) => {
        draftOverviewMetrics = normalizeClientOverviewMetrics(previewItems);
        refreshOverviewPreview();
      },
      onChange: (nextItems) => {
        draftOverviewMetrics = normalizeClientOverviewMetrics(nextItems);
        syncOverviewSectionMeta();
        props.onLayoutChange?.();
        void persistStructurePatch(overviewSection, {
          overviewMetrics: draftOverviewMetrics,
        });
      },
    });

    const overviewSection = CollapsibleSection({
      collapsible: false,
      icon: 'pulse',
      title: t('settings.str.overviewSection'),
      badgeText: t('settings.str.overviewBadge', {
        modCount: draftOverviewModules.length,
        metCount: draftOverviewMetrics.length,
      }),
      onReset: () => {
        draftOverviewModules = [...DEFAULT_CLIENT_OVERVIEW_MODULES];
        draftOverviewMetrics = [...DEFAULT_CLIENT_OVERVIEW_METRICS];
        syncOverviewSectionMeta();
        props.onLayoutChange?.();
        void persistStructurePatch(
          overviewSection,
          {
            overviewModules: [...DEFAULT_CLIENT_OVERVIEW_MODULES],
            overviewMetrics: [...DEFAULT_CLIENT_OVERVIEW_METRICS],
          },
          'settings.resetDone'
        );
      },
      children: [
        overviewPreviewCanvas,
        h('div', { className: 'settings-divider' }),
        h('div', { className: 'form-row' }, [overviewModulesLabelEl, overviewModulesList.el]),
        h('div', { className: 'settings-divider' }),
        h('div', { className: 'form-row' }, [
          overviewMetricsLabelEl,
          overviewMetricsHintEl,
          overviewMetricsList.el,
        ]),
      ],
    });

    function refreshOverviewPreview() {
      if (!isStructureVisible() || activeThirdTab !== 'overview') return;
      overviewPreviewHost.update({
        moduleKeys: draftOverviewModules,
        data: buildDraftTelemetry(),
      });
    }

    function syncOverviewSectionMeta() {
      overviewModulesList.refs.setProps({
        items: draftOverviewModules,
        options: getOverviewModuleOptions(),
        addBtnTextFn: (count, max) => t('settings.str.addOverviewModule', { count, max }),
      });
      overviewMetricsList.refs.setProps({
        items: draftOverviewMetrics,
        options: getOverviewMetricOptions(),
        addBtnTextFn: (count, max) => t('settings.str.addOverviewMetric', { count, max }),
      });
      const metricsModuleActive = draftOverviewModules.includes('metrics');
      patchAttr(overviewMetricsHintEl, 'hidden', metricsModuleActive);
      overviewSection.refs.setBadge(
        t('settings.str.overviewBadge', {
          modCount: draftOverviewModules.length,
          metCount: draftOverviewMetrics.length,
        })
      );
      const isDefault =
        isSameList(draftOverviewModules, DEFAULT_CLIENT_OVERVIEW_MODULES) &&
        isSameList(draftOverviewMetrics, DEFAULT_CLIENT_OVERVIEW_METRICS);
      overviewSection.refs.setResetDisabled(isDefault);
      refreshOverviewPreview();
    }

    // --- Pane 4: 调用明细字段 (`steps`) ---
    const stepTablePreview = StepTableWidget({
      standalone: true,
      interactiveBadges: false,
    });
    const stepsPreviewCanvas = h('div', { className: 'structure-preview-canvas' }, [
      stepTablePreview.el,
    ]);

    const stepTurnRailLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.str.stepTurnRailToggle'),
    });
    const stepAgentBadgeLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.str.stepAgentBadgeToggle'),
    });
    const stepSpeedColorLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.str.stepSpeedColorToggle'),
    });
    const stepTokenComboLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.str.stepTokenComboLabel'),
    });
    const stepTokenComboHintEl = h('span', {
      className: 'settings-hint-text',
      text: t('settings.str.stepTokenComboHint'),
    });
    const stepColsLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.str.stepsColsLabel'),
    });

    const stepTurnRailToggle = SegmentedControl({
      ariaLabel: t('settings.str.stepTurnRailToggle'),
      modelValue: 'hide',
      options: getMultiToggleOptions(),
      onUpdateModelValue: (val) => {
        draftShowStepTurnRail = val !== 'hide';
        syncStepsSectionMeta();
        void persistStructurePatch(stepsSection, {
          showStepTurnRail: draftShowStepTurnRail,
        });
      },
    });

    const stepAgentBadgeToggle = SegmentedControl({
      ariaLabel: t('settings.str.stepAgentBadgeToggle'),
      modelValue: 'show',
      options: getMultiToggleOptions(),
      onUpdateModelValue: (val) => {
        draftShowStepAgentBadge = val !== 'hide';
        syncStepsSectionMeta();
        void persistStructurePatch(stepsSection, {
          showStepAgentBadge: draftShowStepAgentBadge,
        });
      },
    });

    const stepSpeedColorToggle = SegmentedControl({
      ariaLabel: t('settings.str.stepSpeedColorToggle'),
      modelValue: 'off',
      options: getEnableToggleOptions(),
      onUpdateModelValue: (val) => {
        draftShowStepSpeedColor = val !== 'off';
        syncStepsSectionMeta();
        void persistStructurePatch(stepsSection, {
          showStepSpeedColor: draftShowStepSpeedColor,
        });
      },
    });

    function commitStepTokenComboInput() {
      const rawTrimmed = String(stepTokenComboInput.value || '').trim();
      const normFmt = normalizeClientStepTokenComboFormat(rawTrimmed);
      rawStepTokenComboText = normFmt;
      draftStepTokenComboFormat = normFmt;
      stepTokenComboInput.value = normFmt;
      if (rawTrimmed && !draftStepColumns.includes('tokens_custom')) {
        const comboIdx = draftStepColumns.findIndex(
          (k) => k === 'tokens_combo' || k === 'tokens_io_cache'
        );
        if (comboIdx >= 0) {
          const nextCols = [...draftStepColumns];
          nextCols[comboIdx] = 'tokens_custom';
          draftStepColumns = normalizeClientStepColumns(nextCols);
        } else {
          draftStepColumns = normalizeClientStepColumns([...draftStepColumns, 'tokens_custom']);
        }
      }
      syncStepsSectionMeta();
      props.onLayoutChange?.();
      void persistStructurePatch(stepsSection, {
        stepTokenComboFormat: draftStepTokenComboFormat,
        stepTableColumns: draftStepColumns,
      });
    }

    const stepTokenComboInput = h('input', {
      type: 'text',
      className: 'settings-text-input',
      spellcheck: 'false',
      value: rawStepTokenComboText,
      placeholder: t('settings.str.stepTokenComboPlaceholder'),
      'aria-label': t('settings.str.stepTokenComboLabel'),
      onInput: () => {
        rawStepTokenComboText = stepTokenComboInput.value;
        draftStepTokenComboFormat = normalizeClientStepTokenComboFormat(rawStepTokenComboText);
        stepColumnsList.refs.setProps({
          items: draftStepColumns,
          options: getStepColumnOptions(draftStepTokenComboFormat),
          addBtnTextFn: (count, max) => t('settings.str.addStepCol', { count, max }),
        });
        refreshStepsPreview();
      },
      onChange: () => {
        commitStepTokenComboInput();
      },
      onKeydown: (e) => {
        if (e?.key === 'Enter') {
          e.preventDefault();
          stepTokenComboInput.blur();
        }
      },
    });

    const stepColumnsList = EditableSlotList({
      items: draftStepColumns,
      options: getStepColumnOptions(draftStepTokenComboFormat),
      minItems: 2,
      maxItems: 14,
      addBtnTextFn: (count, max) => t('settings.str.addStepCol', { count, max }),
      onPreview: (previewItems) => {
        draftStepColumns = normalizeClientStepColumns(previewItems);
        refreshStepsPreview();
      },
      onChange: (nextItems) => {
        draftStepColumns = normalizeClientStepColumns(nextItems);
        syncStepsSectionMeta();
        props.onLayoutChange?.();
        void persistStructurePatch(stepsSection, {
          stepTableColumns: draftStepColumns,
        });
      },
    });

    const stepsSection = CollapsibleSection({
      collapsible: false,
      icon: 'table',
      title: t('settings.str.stepsSection'),
      badgeText: t('settings.str.stepsBadge', { count: draftStepColumns.length }),
      onReset: () => {
        draftShowStepTurnRail = false;
        draftShowStepAgentBadge = true;
        draftShowStepSpeedColor = false;
        draftStepTokenComboFormat = DEFAULT_CLIENT_STEP_TOKEN_COMBO_FORMAT;
        rawStepTokenComboText = DEFAULT_CLIENT_STEP_TOKEN_COMBO_FORMAT;
        stepTokenComboInput.value = DEFAULT_CLIENT_STEP_TOKEN_COMBO_FORMAT;
        draftStepColumns = [...DEFAULT_CLIENT_STEP_COLUMNS];
        syncStepsSectionMeta();
        props.onLayoutChange?.();
        void persistStructurePatch(
          stepsSection,
          {
            showStepTurnRail: false,
            showStepAgentBadge: true,
            showStepSpeedColor: false,
            stepTokenComboFormat: DEFAULT_CLIENT_STEP_TOKEN_COMBO_FORMAT,
            stepTableColumns: [...DEFAULT_CLIENT_STEP_COLUMNS],
          },
          'settings.resetDone'
        );
      },
      children: [
        stepsPreviewCanvas,
        h('div', { className: 'settings-divider' }),
        h('div', { className: 'settings-inline-row' }, [
          stepTurnRailLabelEl,
          stepTurnRailToggle.el,
        ]),
        h('div', { className: 'settings-inline-row' }, [
          stepAgentBadgeLabelEl,
          stepAgentBadgeToggle.el,
        ]),
        h('div', { className: 'settings-inline-row' }, [
          stepSpeedColorLabelEl,
          stepSpeedColorToggle.el,
        ]),
        h('div', { className: 'settings-divider' }),
        h('div', { className: 'form-row' }, [
          stepTokenComboLabelEl,
          stepTokenComboInput,
          stepTokenComboHintEl,
        ]),
        h('div', { className: 'form-row' }, [stepColsLabelEl, stepColumnsList.el]),
      ],
    });

    function refreshStepsPreview() {
      if (!isStructureVisible() || activeThirdTab !== 'steps') return;
      const mockData = buildDraftTelemetry();
      const mockSteps = mockData.activeConversation?.recentSteps || [];
      const previewCols =
        document?.activeElement === stepTokenComboInput &&
        String(rawStepTokenComboText || '').trim() &&
        !draftStepColumns.includes('tokens_custom')
          ? normalizeClientStepColumns(
              draftStepColumns.some((k) => k === 'tokens_combo' || k === 'tokens_io_cache')
                ? draftStepColumns.map((k) =>
                    k === 'tokens_combo' || k === 'tokens_io_cache' ? 'tokens_custom' : k
                  )
                : [...draftStepColumns, 'tokens_custom']
            )
          : draftStepColumns;
      stepTablePreview.refs.renderStepTable(
        mockSteps,
        'mock-preview-conv',
        previewCols,
        getEffectiveLocale(),
        {
          effectiveScopes: ['all'],
          hasSubagents: true,
          isMergedMultiAgents: true,
          showStepTurnRail: draftShowStepTurnRail,
          showStepAgentBadge: draftShowStepAgentBadge,
          showStepSpeedColor: draftShowStepSpeedColor,
          stepTokenComboFormat: draftStepTokenComboFormat,
          displaySettings: mockData.settings,
        }
      );
    }

    function syncStepsSectionMeta() {
      stepTurnRailToggle.setProps({
        modelValue: draftShowStepTurnRail ? 'show' : 'hide',
        options: getMultiToggleOptions(),
      });
      stepAgentBadgeToggle.setProps({
        modelValue: draftShowStepAgentBadge ? 'show' : 'hide',
        options: getMultiToggleOptions(),
      });
      stepSpeedColorToggle.setProps({
        modelValue: draftShowStepSpeedColor ? 'on' : 'off',
        options: getEnableToggleOptions(),
      });
      if (document?.activeElement !== stepTokenComboInput) {
        stepTokenComboInput.value = rawStepTokenComboText;
      }
      stepColumnsList.refs.setProps({
        items: draftStepColumns,
        options: getStepColumnOptions(draftStepTokenComboFormat),
        addBtnTextFn: (count, max) => t('settings.str.addStepCol', { count, max }),
      });
      stepsSection.refs.setBadge(t('settings.str.stepsBadge', { count: draftStepColumns.length }));
      const isDefault =
        draftShowStepTurnRail === false &&
        draftShowStepAgentBadge === true &&
        draftShowStepSpeedColor === false &&
        draftStepTokenComboFormat === DEFAULT_CLIENT_STEP_TOKEN_COMBO_FORMAT &&
        isSameList(draftStepColumns, DEFAULT_CLIENT_STEP_COLUMNS);
      stepsSection.refs.setResetDisabled(isDefault);
      refreshStepsPreview();
    }

    function syncPreviewTickers() {
      const visible = isStructureVisible();
      if (visible && activeThirdTab === 'hover') {
        hoverPreviewHost.resumeTickers();
      } else {
        hoverPreviewHost.pauseTickers();
      }
      if (visible && activeThirdTab === 'overview') {
        overviewPreviewHost.resumeTickers();
      } else {
        overviewPreviewHost.pauseTickers();
      }
      if (!visible || activeThirdTab !== 'steps') {
        stepTablePreview.refs.hideTurnTip();
      }
    }

    function refreshActivePreview() {
      if (!isStructureVisible()) return;
      if (activeThirdTab === 'mount') refreshMountPreview();
      else if (activeThirdTab === 'hover') refreshHoverPreview();
      else if (activeThirdTab === 'overview') refreshOverviewPreview();
      else if (activeThirdTab === 'steps') refreshStepsPreview();
    }

    function applyActiveThirdTab(nextRawTab) {
      const nextTab = normalizeStructureTabKey(nextRawTab);
      activeThirdTab = nextTab;
      const activeIdx = Math.max(
        0,
        STRUCTURE_THIRD_TABS.findIndex((it) => it.key === nextTab)
      );
      patchStyleVar(thirdNavBar, '--active-third-index', activeIdx);
      for (const [key, entry] of thirdNavBtnMap.entries()) {
        const isActive = key === nextTab;
        patchClasses(entry.btn, { 'is-active': isActive });
        patchAttr(entry.btn, 'aria-selected', isActive ? 'true' : 'false');
      }
      patchAttr(mountSection.el, 'hidden', nextTab !== 'mount');
      patchAttr(hoverSection.el, 'hidden', nextTab !== 'hover');
      patchAttr(overviewSection.el, 'hidden', nextTab !== 'overview');
      patchAttr(stepsSection.el, 'hidden', nextTab !== 'steps');
      refreshActivePreview();
      syncPreviewTickers();
      props.onLayoutChange?.();
    }

    const rootEl = h('div', { className: 'settings-tab-stack' }, [
      mountSection.el,
      hoverSection.el,
      overviewSection.el,
      stepsSection.el,
    ]);

    function renderSettings(
      settings,
      windowBridge = latestWindowBridge,
      hostPlatform = latestHostPlatform
    ) {
      if (!settings) return;
      latestSettings = settings;
      if (windowBridge !== undefined) latestWindowBridge = windowBridge;
      if (hostPlatform) latestHostPlatform = hostPlatform;
      draftWindowMountMode = normalizeClientWindowMountMode(
        settings.windowMountMode,
        settings.enableWindowOverlay
      );
      draftPopoverWidthMode = normalizeClientPopoverWidthMode(settings.popoverWidthMode);
      draftPopoverWidth = normalizeClientPopoverWidth(settings.popoverWidth);
      draftEnableCliStatusLine = settings.enableCliStatusLine !== false;
      draftShowTopbarMulti = settings.showTopbarMultiSession !== false;
      draftTopbarSlots = normalizeClientTopbarSlots(settings.topbarCapsuleSlots);
      draftHoverModules = normalizeClientHoverModules(settings.hoverModules);
      draftOverviewModules = normalizeClientOverviewModules(settings.overviewModules);
      draftOverviewMetrics = normalizeClientOverviewMetrics(settings.overviewMetrics);
      draftShowStepTurnRail = settings.showStepTurnRail === true;
      draftShowStepAgentBadge = settings.showStepAgentBadge !== false;
      draftShowStepSpeedColor = settings.showStepSpeedColor === true;
      draftStepTokenComboFormat = normalizeClientStepTokenComboFormat(
        settings.stepTokenComboFormat
      );
      rawStepTokenComboText = draftStepTokenComboFormat;
      draftStepColumns = normalizeClientStepColumns(settings.stepTableColumns);

      syncMountSectionMeta();
      syncHoverSectionMeta();
      syncOverviewSectionMeta();
      syncStepsSectionMeta();
    }

    function refreshLabels() {
      patchAttr(thirdNavBar, 'aria-label', t('settings.str.thirdTabAria'));
      for (const entry of thirdNavBtnMap.values()) {
        patchText(entry.labelEl, t(entry.labelKey));
      }

      mountSection.refs.setTitle(t('settings.str.mountSection'));
      mountSection.refs.setResetLabel(t('settings.resetBtn'));
      patchText(mountModeLabelEl, t('settings.str.mountMode'));
      patchText(popoverWidthLabelEl, t('settings.str.popoverWidthLabel'));
      patchText(popoverWidthHintEl, t('settings.str.popoverWidthHint'));
      popoverWidthStepper.setProps({ ariaLabel: t('settings.str.popoverWidthLabel') });
      patchText(multiToggleLabelEl, t('settings.str.multiToggle'));
      patchText(cliCapsuleLabelEl, t('settings.str.cliCapsuleToggle'));
      patchText(capsuleSlotsLabelEl, t('settings.str.capsuleSlotsLabel'));

      hoverSection.refs.setTitle(t('settings.str.hoverSection'));
      hoverSection.refs.setResetLabel(t('settings.resetBtn'));
      patchText(hoverModulesLabelEl, t('settings.str.hoverModulesLabel'));

      overviewSection.refs.setTitle(t('settings.str.overviewSection'));
      overviewSection.refs.setResetLabel(t('settings.resetBtn'));
      patchText(overviewModulesLabelEl, t('settings.str.overviewModulesLabel'));
      patchText(overviewMetricsLabelEl, t('settings.str.overviewMetricsLabel'));
      patchText(overviewMetricsHintEl, t('settings.str.overviewMetricsInactiveHint'));

      stepsSection.refs.setTitle(t('settings.str.stepsSection'));
      stepsSection.refs.setResetLabel(t('settings.resetBtn'));
      patchText(stepTurnRailLabelEl, t('settings.str.stepTurnRailToggle'));
      patchText(stepAgentBadgeLabelEl, t('settings.str.stepAgentBadgeToggle'));
      patchText(stepSpeedColorLabelEl, t('settings.str.stepSpeedColorToggle'));
      patchText(stepTokenComboLabelEl, t('settings.str.stepTokenComboLabel'));
      patchText(stepTokenComboHintEl, t('settings.str.stepTokenComboHint'));
      patchAttr(stepTokenComboInput, 'placeholder', t('settings.str.stepTokenComboPlaceholder'));
      patchAttr(stepTokenComboInput, 'aria-label', t('settings.str.stepTokenComboLabel'));
      patchText(stepColsLabelEl, t('settings.str.stepsColsLabel'));

      syncMountSectionMeta();
      syncHoverSectionMeta();
      syncOverviewSectionMeta();
      syncStepsSectionMeta();
    }

    let wasStructureVisible = isStructureVisible();
    const unsubUi = uiStore.subscribe(
      (st) => ({
        activeView: getVisibleMonitorView(st),
        settingsSubTab: st.settingsSubTab,
        settingsStructureTab: st.settingsStructureTab,
      }),
      (slice) => {
        const nowVisible =
          slice.activeView === 'settings' && slice.settingsSubTab === 'structure';
        const enteredStructure = nowVisible && !wasStructureVisible;
        wasStructureVisible = nowVisible;
        if (normalizeStructureTabKey(slice.settingsStructureTab) !== activeThirdTab) {
          applyActiveThirdTab(slice.settingsStructureTab);
        } else {
          if (enteredStructure) {
            refreshActivePreview();
          }
          syncPreviewTickers();
        }
      }
    );

    syncMountSectionMeta();
    syncHoverSectionMeta();
    syncOverviewSectionMeta();
    syncStepsSectionMeta();
    applyActiveThirdTab(activeThirdTab);

    onCleanup(() => {
      unsubUi();
      mountBridgeNotice.destroy();
      capsulePreviewWidget.destroy();
      hoverPreviewHost.destroy();
      overviewPreviewHost.destroy();
      stepTablePreview.destroy();
      windowMountSelect.destroy();
      popoverWidthStepper.destroy();
      popoverWidthModeToggle.destroy();
      multiSessionToggle.destroy();
      cliCapsuleToggle.destroy();
      topbarSlotsList.destroy();
      hoverModulesList.destroy();
      overviewModulesList.destroy();
      overviewMetricsList.destroy();
      stepTurnRailToggle.destroy();
      stepAgentBadgeToggle.destroy();
      stepSpeedColorToggle.destroy();
      stepColumnsList.destroy();
      mountSection.destroy();
      hoverSection.destroy();
      overviewSection.destroy();
      stepsSection.destroy();
    });

    return {
      el: rootEl,
      refs: {
        thirdNavBar,
        capsulePreviewWidget,
        mountBridgeNotice,
        hoverPreviewHost,
        overviewPreviewHost,
        stepTablePreview,
        windowMountSelect,
        multiSessionToggle,
        cliCapsuleToggle,
        topbarSlotsList,
        hoverModulesList,
        overviewModulesList,
        overviewMetricsList,
        stepTurnRailToggle,
        stepAgentBadgeToggle,
        stepSpeedColorToggle,
        stepColumnsList,
        mountSection,
        hoverSection,
        overviewSection,
        stepsSection,
        renderSettings,
        refreshLabels,
      },
    };
  },
});
return { SettingsStructureTab };
})();

// --- src/views/settings/SettingsOtherTab.js ---
const { SettingsOtherTab } = (() => {
/**
 * @fileoverview Preferences Tab 3: `SettingsOtherTab.js` ("其他").
 * Houses Model Identifier Formatting, Per-Model Context Windows,
 * Local Trajectory Cache Rebuild, and Two-Step Factory Preference Reset.
 */


function getStepModelDisplayOptions() {
  return [
    { value: 'short', label: t('settings.oth.modelShort') },
    { value: 'upstream', label: t('settings.oth.modelUpstream') },
    { value: 'upstream_compact', label: t('settings.oth.modelUpstreamCompact') },
  ];
}

function getOrchestratorIdDisplayOptions() {
  return [
    { value: 'compact', label: t('settings.oth.orchCompact') },
    { value: 'full', label: t('settings.oth.orchFull') },
  ];
}

const SettingsOtherTab = defineComponent({
  name: 'SettingsOtherTab',
  setup({ onCleanup, getProps }) {
    let draftModelDisplayMode = 'short';
    let draftOrchestratorIdMode = 'compact';
    let draftContextRiskAccepted = false;
    let acceptingContextRisk = false;
    let latestSettings = null;
    let latestWindowBridge = null;
    let latestHostPlatform = 'win32';
    let contextWindowModels = [];
    let contextModelId = '';
    let savingContextWindow = false;
    let contextFeedback = '';
    let modelTimer = null;
    let maintTimer = null;
    let resetConfirmTimer = null;
    let resetConfirmArmed = false;
    let isRebuilding = false;
    let isResetting = false;

    const modelStatusText = h('span', {
      className: 'text-muted',
      style: 'font-size: var(--fs-md);',
      text: '',
    });
    const maintStatusText = h('span', {
      className: 'text-muted',
      style: 'font-size: var(--fs-md);',
      text: '',
    });

    function showModelFeedback(text, autoClearMs = 1500) {
      if (modelTimer) {
        clearTimeout(modelTimer);
        modelTimer = null;
      }
      patchText(modelStatusText, text);
      if (text && autoClearMs > 0) {
        modelTimer = setTimeout(() => {
          modelTimer = null;
          patchText(modelStatusText, '');
        }, autoClearMs);
      }
    }

    function showMaintFeedback(text, autoClearMs = 2500) {
      if (maintTimer) {
        clearTimeout(maintTimer);
        maintTimer = null;
      }
      patchText(maintStatusText, text);
      if (text && autoClearMs > 0) {
        maintTimer = setTimeout(() => {
          maintTimer = null;
          patchText(maintStatusText, '');
        }, autoClearMs);
      }
    }

    // --- Card 1: 模型标识显示 ---
    const modelCardTitleEl = h('span', { text: t('settings.oth.modelTitle') });
    const modelFormatLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.oth.modelFormat'),
    });
    const orchFormatLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.oth.orchFormat'),
    });

    const stepModelSelect = CustomSelect({
      modelValue: 'short',
      icon: 'table',
      options: getStepModelDisplayOptions(),
      onUpdateModelValue: async (val) => {
        const nextMode = normalizeClientModelDisplayMode(val);
        draftModelDisplayMode = nextMode;
        stepModelSelect.setValue(nextMode);
        showModelFeedback(t('settings.saving'), 0);
        try {
          await saveSettingsPatch({
            modelDisplayMode: nextMode,
            showUpstreamModel: nextMode !== 'short',
          });
          showModelFeedback(t('settings.saved'), 1500);
        } catch {
          if (latestSettings) renderSettings(latestSettings);
          showModelFeedback(t('settings.saveFailed'), 2500);
        }
      },
    });

    const orchestratorIdSelect = CustomSelect({
      modelValue: 'compact',
      icon: 'layers',
      options: getOrchestratorIdDisplayOptions(),
      onUpdateModelValue: async (val) => {
        const nextMode = normalizeClientOrchestratorIdMode(val);
        draftOrchestratorIdMode = nextMode;
        orchestratorIdSelect.setValue(nextMode);
        showModelFeedback(t('settings.saving'), 0);
        try {
          await saveSettingsPatch({ orchestratorIdMode: nextMode });
          showModelFeedback(t('settings.saved'), 1500);
        } catch {
          if (latestSettings) renderSettings(latestSettings);
          showModelFeedback(t('settings.saveFailed'), 2500);
        }
      },
    });

    const modelPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('sliders', { size: 13 }),
          modelCardTitleEl,
        ]),
        modelStatusText,
      ]),
      h('div', { className: 'form-row' }, [modelFormatLabelEl, stepModelSelect.el]),
      h('div', { className: 'form-row' }, [orchFormatLabelEl, orchestratorIdSelect.el]),
    ]);

    // --- Card 2: 按模型设置上下文窗口 ---
    const baselineTitleEl = h('span', { text: t('settings.oth.baselineTitle') });
    const ctxModelLabel = h('span', { className: 'form-label' });
    const ctxWindowLabel = h('span', { className: 'form-label' });
    const ctxHint = h('span', { className: 'settings-hint-text' });
    const ctxStatus = h('span', { className: 'text-muted', role: 'status' });
    const ctxModelSelect = CustomSelect({
      className: 'settings-context-model',
      options: [],
      onUpdateModelValue: (id) => {
        if (!draftContextRiskAccepted || savingContextWindow) return;
        contextModelId = id;
        contextFeedback = '';
        renderContextWindows();
      },
    });
    const ctxWindowSelect = CustomSelect({
      options: [],
      onUpdateModelValue: async (value) => {
        if (!draftContextRiskAccepted || savingContextWindow || !contextModelId) return;
        savingContextWindow = true;
        contextFeedback = 'settings.saving';
        renderContextWindows();
        try {
          const modelContextWindows = await saveModelContextWindow(contextModelId, value || null);
          latestSettings = { ...latestSettings, modelContextWindows };
          contextFeedback = 'settings.saved';
        } catch {
          contextFeedback = 'settings.saveFailed';
        } finally {
          savingContextWindow = false;
          renderContextWindows();
        }
      },
    });
    const ctxBridgeNotice = BridgeStatusNotice({ contextMode: true });
    const ctxModelRow = h('div', { className: 'form-row' }, [ctxModelLabel, ctxModelSelect.el]);
    const ctxWindowRow = h('div', { className: 'form-row' }, [ctxWindowLabel, ctxWindowSelect.el]);
    const ctxControlsBody = h('div', { className: 'ctx-controls-body is-locked' }, [
      ctxBridgeNotice.el,
      ctxModelRow,
      ctxWindowRow,
      h('div', { className: 'form-row' }, [ctxHint]),
    ]);

    const ctxRiskTitleEl = h('strong', {
      className: 'ctx-risk-title',
      text: t('settings.oth.ctxRiskTitle'),
    });
    const ctxRiskBodyEl = h('p', {
      className: 'ctx-risk-desc',
      text: t('settings.oth.ctxRiskBody'),
    });
    const ctxRiskAcceptBtnText = h('span', { text: t('settings.oth.ctxRiskAcceptBtn') });
    const ctxRiskAcceptBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary btn-danger-confirm ctx-risk-accept-btn',
        onClick: async () => {
          if (acceptingContextRisk || draftContextRiskAccepted) return;
          acceptingContextRisk = true;
          draftContextRiskAccepted = true;
          latestSettings = { ...(latestSettings || {}), contextWindowRiskAccepted: true };
          contextFeedback = 'settings.saving';
          renderContextWindows();
          try {
            await saveSettingsPatch({ contextWindowRiskAccepted: true });
            contextFeedback = 'settings.saved';
          } catch {
            draftContextRiskAccepted = false;
            latestSettings = { ...(latestSettings || {}), contextWindowRiskAccepted: false };
            contextFeedback = 'settings.saveFailed';
          } finally {
            acceptingContextRisk = false;
            renderContextWindows();
          }
        },
      },
      [createSvgIcon('warning', { size: 12 }), ctxRiskAcceptBtnText]
    );
    const ctxRiskMask = h(
      'div',
      {
        className: 'ctx-risk-mask',
        role: 'region',
        'aria-label': t('settings.oth.ctxRiskTitle'),
      },
      [
        h('div', { className: 'ctx-risk-head' }, [
          createSvgIcon('warning', { size: 14, className: 'ctx-risk-icon' }),
          ctxRiskTitleEl,
        ]),
        ctxRiskBodyEl,
        ctxRiskAcceptBtn,
      ]
    );
    const ctxRiskStage = h('div', { className: 'ctx-risk-stage' }, [ctxControlsBody, ctxRiskMask]);

    function renderContextWindows() {
      const unlocked = Boolean(draftContextRiskAccepted);
      if (!unlocked) {
        ctxModelSelect.close();
        ctxWindowSelect.close();
      }
      patchClasses(ctxControlsBody, { 'is-locked': !unlocked });
      patchAttr(ctxControlsBody, 'inert', !unlocked);
      patchAttr(ctxControlsBody, 'aria-hidden', unlocked ? null : 'true');
      patchAttr(ctxRiskMask, 'hidden', unlocked);
      patchAttr(ctxRiskMask, 'aria-label', t('settings.oth.ctxRiskTitle'));
      patchText(ctxRiskTitleEl, t('settings.oth.ctxRiskTitle'));
      patchText(ctxRiskBodyEl, t('settings.oth.ctxRiskBody'));
      patchText(ctxRiskAcceptBtnText, t('settings.oth.ctxRiskAcceptBtn'));
      patchAttr(ctxRiskAcceptBtn, 'disabled', acceptingContextRisk);

      const saved = latestSettings?.modelContextWindows || {};
      const wbState = String(latestWindowBridge?.state || '').trim();
      const isBridgeMissing = wbState === 'no_devtools_port' || wbState === 'cdp_unreachable';
      ctxBridgeNotice.refs.update({
        visible: unlocked,
        windowBridge: latestWindowBridge,
        hostPlatform: latestHostPlatform,
      });
      const models = new Map(contextWindowModels.map((model) => [model.id, model]));
      const knownIds = new Set(contextWindowModels.flatMap(({ id, members = [] }) => [id, ...members]));
      for (const id of Object.keys(saved)) {
        if (!knownIds.has(id)) models.set(id, { id, label: id.replace(/^model:/, ''), options: [] });
      }
      if (!models.has(contextModelId)) contextModelId = '';
      const mixed = '\u0000mixed';
      const getSelection = ({ id, members = [] }) => {
        const legacy = new Set(members.map((member) => saved[member]).filter(Boolean));
        return saved[id] || (legacy.size > 1 ? mixed : legacy.values().next().value) || '';
      };
      const formatLimit = (value) => /^\d+$/.test(value) ? t('settings.oth.ctxTokens', { count: Number(value).toLocaleString() }) : value;
      const isAvailable = (model, value) => model.options.some(({ name }) => name === value) ||
        (/^[1-9]\d*$/.test(value) && Number(value) <= model.capacity);
      const current = models.get(contextModelId);
      const options = current?.options || [];
      const selected = current ? getSelection(current) : '';
      const choices = [
        { value: '', label: t('settings.oth.ctxDefault') },
        ...options.map(({ name, expensive, tokens }) => ({
          value: name,
          label: tokens ? formatLimit(name) :
            (expensive ? t('settings.oth.ctxExpensive', { name }) : name),
        })),
      ];
      if (selected && !choices.some((item) => item.value === selected)) {
        let label = t('settings.oth.ctxMixed');
        if (selected !== mixed) {
          const name = formatLimit(selected);
          label = isAvailable(current, selected) ? name : t('settings.oth.ctxUnavailable', { name });
        }
        choices.push({ value: selected, label, disabled: true });
      }
      ctxModelSelect.setProps({
        modelValue: contextModelId,
        options: [
          { value: '', label: t('settings.oth.ctxChooseModel') },
          ...[...models.values()].map((model) => {
            const value = getSelection(model);
            let meta = t('settings.oth.ctxDefault');
            if (value === mixed) meta = t('settings.oth.ctxMixed');
            else if (value) {
              const name = formatLimit(value);
              if (!isAvailable(model, value)) meta = t('settings.oth.ctxUnavailable', { name });
              else if (isBridgeMissing) meta = t('settings.oth.ctxPendingBridge', { name });
              else if (/^\d+$/.test(value) && model.reportedLimitTokens && Number(value) !== model.reportedLimitTokens) {
                meta = t('settings.oth.ctxConfiguredReported', {
                  name,
                  reported: formatLimit(String(model.reportedLimitTokens)),
                });
              } else meta = t('settings.oth.ctxConfigured', { name });
            }
            else if (model.reportedLimitTokens) meta = t('settings.oth.ctxDefaultReported', { name: formatLimit(String(model.reportedLimitTokens)) });
            return { value: model.id, label: model.label, meta };
          }),
        ],
      });
      ctxWindowSelect.setProps({ modelValue: selected, options: choices });
      patchAttr(ctxModelSelect.refs.triggerBtn, 'disabled', !unlocked || savingContextWindow);
      patchAttr(ctxWindowSelect.refs.triggerBtn, 'disabled', !unlocked || savingContextWindow || (!options.length && !selected));
      patchAttr(ctxModelSelect.refs.triggerBtn, 'aria-label', t('settings.oth.ctxModel'));
      patchAttr(ctxWindowSelect.refs.triggerBtn, 'aria-label', t('settings.oth.ctxBaselineLabel'));
      patchAttr(ctxModelRow, 'hidden', !models.size);
      patchAttr(ctxWindowRow, 'hidden', !contextModelId);
      patchText(ctxModelLabel, t('settings.oth.ctxModel'));
      patchText(ctxWindowLabel, t('settings.oth.ctxBaselineLabel'));
      const hint = !models.size ? 'ctxNoModels' : selected === mixed ? 'ctxMixedHint' :
        contextModelId && !options.length ? 'ctxNoOptions' : 'ctxBaselineHint';
      const reported = current?.reportedLimitTokens;
      patchText(ctxHint, [t(`settings.oth.${hint}`), reported &&
        t('settings.oth.ctxReported', { name: formatLimit(String(reported)) })].filter(Boolean).join(' '));
      patchText(ctxStatus, contextFeedback ? t(contextFeedback) : '');
      getProps().onLayoutChange?.();
    }

    const baselinePanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('layers', { size: 13 }),
          baselineTitleEl,
        ]),
        ctxStatus,
      ]),
      ctxRiskStage,
    ]);
    renderContextWindows();

    // --- Card 3: 缓存与重置 ---
    const maintTitleEl = h('span', { text: t('settings.oth.maintTitle') });
    const cacheLabelEl = h('span', {
      className: 'settings-action-title',
      text: t('settings.oth.cacheLabel'),
    });
    const cacheDescEl = h('span', {
      className: 'settings-action-desc',
      text: t('settings.oth.cacheDesc'),
    });

    const rebuildBtnText = h('span', { text: t('settings.oth.rebuildBtn') });
    const rebuildCacheBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: async () => {
          if (isRebuilding) return;
          isRebuilding = true;
          patchAttr(rebuildCacheBtn, 'disabled', true);
          patchText(rebuildBtnText, t('settings.oth.rebuildingBtn'));
          showMaintFeedback(t('settings.oth.rebuildingBtn'), 0);
          try {
            const res = await rebuildTrajectoryCache();
            if (res?.ok !== false) {
              showMaintFeedback(t('settings.oth.rebuildDone'), 2800);
            } else {
              showMaintFeedback(t('settings.oth.rebuildFailed'), 3000);
            }
          } catch {
            showMaintFeedback(t('settings.oth.rebuildFailed'), 3000);
          } finally {
            isRebuilding = false;
            patchAttr(rebuildCacheBtn, 'disabled', false);
            patchText(rebuildBtnText, t('settings.oth.rebuildBtn'));
          }
        },
      },
      [createSvgIcon('refresh', { size: 12 }), rebuildBtnText]
    );

    const resetLabelEl = h('span', {
      className: 'settings-action-title',
      text: t('settings.oth.resetLabel'),
    });
    const resetDescEl = h('span', {
      className: 'settings-action-desc',
      text: t('settings.oth.resetDesc'),
    });

    const resetBtnText = h('span', { text: t('settings.oth.resetAllBtn') });

    function disarmResetConfirm() {
      resetConfirmArmed = false;
      if (resetConfirmTimer) {
        clearTimeout(resetConfirmTimer);
        resetConfirmTimer = null;
      }
      patchClasses(resetAllBtn, { 'btn-danger-confirm': false });
      if (!isResetting) {
        patchText(resetBtnText, t('settings.oth.resetAllBtn'));
      }
    }

    const resetAllBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: async () => {
          if (isResetting) return;
          if (!resetConfirmArmed) {
            resetConfirmArmed = true;
            patchClasses(resetAllBtn, { 'btn-danger-confirm': true });
            patchText(resetBtnText, t('settings.oth.resetConfirmBtn'));
            if (resetConfirmTimer) clearTimeout(resetConfirmTimer);
            resetConfirmTimer = setTimeout(() => {
              disarmResetConfirm();
            }, 3000);
            return;
          }

          disarmResetConfirm();
          isResetting = true;
          patchAttr(resetAllBtn, 'disabled', true);
          patchText(resetBtnText, t('settings.oth.resettingBtn'));
          showMaintFeedback(t('settings.oth.resettingBtn'), 0);
          try {
            const res = await resetAllSettings();
            setI18nLanguage(res?.settings?.language || 'zh-CN');
            showMaintFeedback(t('settings.oth.resetAllDone'), 2800);
          } catch {
            showMaintFeedback(t('settings.saveFailed'), 2800);
          } finally {
            isResetting = false;
            patchAttr(resetAllBtn, 'disabled', false);
            patchText(resetBtnText, t('settings.oth.resetAllBtn'));
          }
        },
      },
      [resetBtnText]
    );

    const maintPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('refresh', { size: 13 }),
          maintTitleEl,
        ]),
        maintStatusText,
      ]),
      h('div', { className: 'settings-action-block' }, [
        h('div', { className: 'settings-action-info' }, [cacheLabelEl, cacheDescEl]),
        rebuildCacheBtn,
      ]),
      h('div', { className: 'settings-action-block' }, [
        h('div', { className: 'settings-action-info' }, [resetLabelEl, resetDescEl]),
        resetAllBtn,
      ]),
    ]);

    const rootEl = h('div', { className: 'settings-tab-stack' }, [
      modelPanel,
      baselinePanel,
      maintPanel,
    ]);

    function renderSettings(
      settings,
      models = contextWindowModels,
      windowBridge = latestWindowBridge,
      hostPlatform = latestHostPlatform
    ) {
      if (!settings) return;
      latestSettings = settings;
      contextWindowModels = models;
      if (windowBridge !== undefined) latestWindowBridge = windowBridge;
      if (hostPlatform) latestHostPlatform = hostPlatform;
      draftModelDisplayMode = normalizeClientModelDisplayMode(
        settings.modelDisplayMode,
        settings.showUpstreamModel
      );
      draftOrchestratorIdMode = normalizeClientOrchestratorIdMode(settings.orchestratorIdMode);
      if (!acceptingContextRisk) {
        draftContextRiskAccepted = Boolean(settings.contextWindowRiskAccepted);
      }
      stepModelSelect.setProps({
        modelValue: draftModelDisplayMode,
        options: getStepModelDisplayOptions(),
      });
      orchestratorIdSelect.setProps({
        modelValue: draftOrchestratorIdMode,
        options: getOrchestratorIdDisplayOptions(),
      });
      renderContextWindows();
    }

    function refreshLabels() {
      patchText(modelCardTitleEl, t('settings.oth.modelTitle'));
      patchText(modelFormatLabelEl, t('settings.oth.modelFormat'));
      patchText(orchFormatLabelEl, t('settings.oth.orchFormat'));
      patchText(baselineTitleEl, t('settings.oth.baselineTitle'));
      renderContextWindows();
      patchText(maintTitleEl, t('settings.oth.maintTitle'));
      patchText(cacheLabelEl, t('settings.oth.cacheLabel'));
      patchText(cacheDescEl, t('settings.oth.cacheDesc'));
      patchText(resetLabelEl, t('settings.oth.resetLabel'));
      patchText(resetDescEl, t('settings.oth.resetDesc'));

      if (!isRebuilding) {
        patchText(rebuildBtnText, t('settings.oth.rebuildBtn'));
      }
      if (!isResetting) {
        patchText(
          resetBtnText,
          resetConfirmArmed ? t('settings.oth.resetConfirmBtn') : t('settings.oth.resetAllBtn')
        );
      }

      stepModelSelect.setProps({
        modelValue: draftModelDisplayMode,
        options: getStepModelDisplayOptions(),
      });
      orchestratorIdSelect.setProps({
        modelValue: draftOrchestratorIdMode,
        options: getOrchestratorIdDisplayOptions(),
      });
    }

    onCleanup(() => {
      if (modelTimer) clearTimeout(modelTimer);
      if (maintTimer) clearTimeout(maintTimer);
      if (resetConfirmTimer) clearTimeout(resetConfirmTimer);
      stepModelSelect.destroy();
      orchestratorIdSelect.destroy();
      ctxBridgeNotice.destroy();
      ctxModelSelect.destroy();
      ctxWindowSelect.destroy();
    });

    return {
      el: rootEl,
      refs: {
        stepModelSelect,
        orchestratorIdSelect,
        ctxBridgeNotice,
        ctxModelSelect,
        ctxWindowSelect,
        rebuildCacheBtn,
        resetAllBtn,
        renderSettings,
        refreshLabels,
      },
    };
  },
});
return { SettingsOtherTab };
})();

// --- src/components/layout/TopSessionHeader.js ---
const { TopSessionHeader } = (() => {
/**
 * @fileoverview Row 1 of the compact top bar:
 * Bespoke CustomSelect for session switching, SVG live status indicator,
 * and async force-refresh button.
 */


function formatConvOptionMeta(c) {
  return formatConversationMeta(c);
}

const TopSessionHeader = defineComponent({
  name: 'TopSessionHeader',
  setup({ onCleanup }) {
    const convSelect = CustomSelect({
      modelValue: telemetryStore.getState().selectedConversationId,
      placeholder: t('header.followLatest'),
      options: [{ value: '', label: t('header.followLatest') }],
      onUpdateModelValue: (nextConvId) => {
        uiStore.setState({ selectedAgentScope: 'all', ctxInspectorAgentId: 'auto' });
        void selectConversation(nextConvId);
      },
    });

    const updateBtnIcon = createSvgIcon('arrow-down', { size: 11 });
    const updateBtnText = h('span', { text: t('header.hasUpdate') });
    let isHeaderUpdating = false;
    const updateBtn = h(
      'button',
      {
        type: 'button',
        className: 'update-badge-btn',
        hidden: true,
        'aria-label': t('header.ariaUpdate'),
        onClick: async () => {
          if (isHeaderUpdating) return;
          isHeaderUpdating = true;
          patchText(updateBtnText, t('header.upgrading'));
          patchAttr(updateBtn, 'disabled', true);
          try {
            const res = await triggerPluginUpdate();
            if (!res?.ok) {
              uiStore.setState({ activeView: 'settings' });
            }
          } catch {
            uiStore.setState({ activeView: 'settings' });
          } finally {
            isHeaderUpdating = false;
            patchAttr(updateBtn, 'disabled', false);
            const cs = telemetryStore.getState().telemetry?.cloudStatus;
            patchText(
              updateBtnText,
              cs?.latestPluginVersion
                ? t('header.upgradeToVer', { ver: cs.latestPluginVersion })
                : t('header.hasUpdate')
            );
          }
        },
      },
      [updateBtnIcon, updateBtnText]
    );

    const statusIcon = createSvgIcon('pulse', { size: 12 });
    const statusText = h('span', { text: t('header.statusLive') });
    const statusTag = h('span', { className: 'status-tag' }, [statusIcon, statusText]);

    const refreshBtn = h(
      'button',
      {
        type: 'button',
        className: 'icon-btn',
        'aria-label': t('header.ariaRefresh'),
        onClick: () => fetchTelemetry({ force: true }),
      },
      [createSvgIcon('refresh', { size: 13 })]
    );

    const headerRowEl = h('div', { className: 'session-header' }, [
      h('div', { className: 'session-left' }, [convSelect.el]),
      h('div', { className: 'session-right' }, [updateBtn, statusTag, refreshBtn]),
    ]);

    const headerEl = h('header', { className: 'top-session-stack' }, [headerRowEl]);

    let lastActiveCascadeId = '';
    let lastAppliedHostChildRouteId = '';

    function syncSessionScopeOnCascadeChange(telemetry, telSlice = telemetryStore.getState()) {
      const currentCascadeId = telemetry?.activeConversation?.cascadeId || '';
      if (!currentCascadeId) return;

      const selectedId = String(telSlice?.selectedConversationId || '').trim();
      const hostRouteId = String(telSlice?.hostRouteConversationId || '').trim();
      const hostRouteLower = hostRouteId.toLowerCase();

      if (!selectedId && hostRouteLower) {
        const routeMatch = resolveHostRouteMatch(telemetry, hostRouteId);
        if (routeMatch?.isChildRoute && routeMatch.childAgent?.agentId) {
          lastActiveCascadeId = currentCascadeId;
          if (lastAppliedHostChildRouteId !== hostRouteLower) {
            lastAppliedHostChildRouteId = hostRouteLower;
            const targetAgentId = routeMatch.childAgent.agentId;
            const uiSt = uiStore.getState();
            if (
              uiSt.selectedAgentScope !== targetAgentId ||
              uiSt.ctxInspectorAgentId !== targetAgentId
            ) {
              uiStore.setState({
                selectedAgentScope: targetAgentId,
                ctxInspectorAgentId: targetAgentId,
              });
            }
          }
          return;
        }
        if (lastAppliedHostChildRouteId && !routeMatch?.isChildRoute) {
          lastAppliedHostChildRouteId = '';
          const uiSt = uiStore.getState();
          if (uiSt.selectedAgentScope !== 'all' || uiSt.ctxInspectorAgentId !== 'auto') {
            uiStore.setState({ selectedAgentScope: 'all', ctxInspectorAgentId: 'auto' });
          }
          lastActiveCascadeId = currentCascadeId;
          return;
        }
      } else if (lastAppliedHostChildRouteId) {
        lastAppliedHostChildRouteId = '';
      }

      if (lastActiveCascadeId && currentCascadeId !== lastActiveCascadeId) {
        lastActiveCascadeId = currentCascadeId;
        const uiSt = uiStore.getState();
        if (uiSt.selectedAgentScope !== 'all' || uiSt.ctxInspectorAgentId !== 'auto') {
          uiStore.setState({ selectedAgentScope: 'all', ctxInspectorAgentId: 'auto' });
        }
      } else {
        lastActiveCascadeId = currentCascadeId;
      }
    }

    function renderHeaderState() {
      const telSt = telemetryStore.getState();
      const uiSt = uiStore.getState();
      const telemetry = telSt.telemetry;
      if (!uiSt.monitorVisible) return;

      patchAttr(updateBtn, 'aria-label', t('header.ariaUpdate'));
      patchAttr(refreshBtn, 'aria-label', t('header.ariaRefresh'));

      const actConv = telemetry?.activeConversation;
      const convs = telemetry?.conversations || [];
      const hostRouteId = telSt.hostRouteConversationId || '';
      const routeMatch = hostRouteId ? resolveHostRouteMatch(telemetry, hostRouteId) : null;
      const hostMatchedConv = routeMatch?.rootConv || null;
      const childRouteBadge =
        routeMatch?.isChildRoute && routeMatch.childAgent
          ? formatAgentBadgeText(routeMatch.childAgent)
          : '';
      const hostBaseTitle = hostMatchedConv?.title || hostRouteId.slice(0, 8);
      const hostDisplayTitle = childRouteBadge
        ? `${hostBaseTitle} · ${childRouteBadge}`
        : hostBaseTitle;
      const defaultOptLabel = hostRouteId
        ? t('header.currentWindowNamed', {
            title: hostDisplayTitle,
          })
        : convs[0]?.title
          ? t('header.latestNamed', { title: convs[0].title })
          : t('header.followLatest');
      const defaultOptMeta = hostRouteId
        ? hostMatchedConv
          ? formatConvOptionMeta(hostMatchedConv)
          : ''
        : convs[0]
          ? formatConvOptionMeta(convs[0])
          : '';
      const options = [
        {
          value: '',
          label: defaultOptLabel,
          meta: defaultOptMeta,
          ...(hostMatchedConv?.swarmTitle ? { title: hostMatchedConv.swarmTitle } : {}),
        },
        ...convs.map((c) => ({
          value: c.cascadeId,
          label: c.title || c.cascadeId.slice(0, 8),
          meta: formatConvOptionMeta(c),
          ...(c.swarmTitle && c.swarmTitle !== c.title
            ? { title: `${c.title || c.cascadeId.slice(0, 8)} · ${c.swarmTitle}` }
            : {}),
        })),
      ];
      const lockedId = telSt.selectedConversationId;
      if (lockedId && !convs.some((c) => c.cascadeId === lockedId)) {
        const isLoadedLocked = actConv?.cascadeId === lockedId;
        const lockedTitle =
          isLoadedLocked && actConv?.title
            ? actConv.title
            : t('header.lockedSession', { id: String(lockedId).slice(0, 8) });
        const lockedMeta = isLoadedLocked ? formatConvOptionMeta(actConv) : t('header.lockedMeta');
        options.splice(1, 0, {
          value: lockedId,
          label: lockedTitle,
          meta: lockedMeta,
        });
      }
      convSelect.setProps({
        modelValue: telSt.selectedConversationId,
        placeholder: t('header.followLatest'),
        options,
      });

      const hasSubagents = Boolean(actConv?.hasSubagents || (actConv?.subagentCount || 0) > 0);
      const aggregated = actConv?.aggregated;

      const cloudStatus = telemetry?.cloudStatus;
      const updateMode = normalizeClientUpdateMode(
        telemetry?.settings?.pluginUpdateMode,
        telemetry?.settings?.autoUpdatePlugin
      );
      const showUpdate = Boolean(cloudStatus?.updateAvailable) && updateMode !== 'off';
      patchAttr(updateBtn, 'hidden', !showUpdate);
      if (showUpdate && !isHeaderUpdating) {
        patchText(
          updateBtnText,
          cloudStatus?.latestPluginVersion
            ? t('header.upgradeToVer', { ver: cloudStatus.latestPluginVersion })
            : t('header.hasUpdate')
        );
      }

      const isSyncing = telSt.syncState === 'syncing';
      const isSynced = telSt.syncState === 'synced';
      const isError = telSt.syncState === 'error';
      const isRunning = Boolean(aggregated?.isRunning || telemetry?.activeConversation?.isRunning);
      const quotaMeta = telemetry?.quotas?.meta;
      const quotaStale = Boolean(quotaMeta?.refreshFailed || quotaMeta?.isStale);

      patchClasses(refreshBtn, { 'is-spinning': isSyncing });
      patchAttr(refreshBtn, 'disabled', isSyncing);

      if (isSyncing) {
        patchSvgIcon(statusIcon, 'refresh');
        patchText(statusText, t('header.statusSyncing'));
        patchClasses(statusTag, {
          'state-running': false,
          'state-synced': true,
          'state-warn': false,
        });
      } else if (isSynced) {
        patchSvgIcon(statusIcon, 'check');
        patchText(statusText, t('header.statusSynced'));
        patchClasses(statusTag, {
          'state-running': false,
          'state-synced': true,
          'state-warn': false,
        });
      } else if (isError) {
        patchSvgIcon(statusIcon, 'warning');
        patchText(statusText, t('header.statusRetrying'));
        patchClasses(statusTag, {
          'state-running': false,
          'state-synced': false,
          'state-warn': true,
        });
      } else if (isRunning) {
        const runningAgent = (telemetry?.activeConversation?.agents || []).find((a) => a.isRunning);
        const runSuffix =
          hasSubagents && runningAgent ? ` · ${formatAgentBadgeText(runningAgent)}` : '';
        patchSvgIcon(statusIcon, 'bolt');
        patchText(statusText, t('header.statusGenerating', { suffix: runSuffix }));
        patchClasses(statusTag, {
          'state-running': true,
          'state-synced': false,
          'state-warn': false,
        });
      } else if (quotaStale) {
        patchSvgIcon(statusIcon, 'warning');
        patchText(
          statusText,
          quotaMeta?.hasOfficialData ? t('header.statusQuotaCached') : t('header.statusQuotaOffline')
        );
        patchClasses(statusTag, {
          'state-running': false,
          'state-synced': false,
          'state-warn': true,
        });
      } else {
        patchSvgIcon(statusIcon, 'pulse');
        patchText(statusText, t('header.statusLive'));
        patchClasses(statusTag, {
          'state-running': false,
          'state-synced': false,
          'state-warn': false,
        });
      }
    }

    const unsubTelemetry = telemetryStore.subscribe(
      (st) => ({
        selectedConversationId: st.selectedConversationId,
        hostRouteConversationId: st.hostRouteConversationId,
        syncState: st.syncState,
        telemetry: st.telemetry,
      }),
      (slice) => {
        syncSessionScopeOnCascadeChange(slice.telemetry, slice);
        renderHeaderState();
      }
    );

    const unsubI18n = i18nStore.subscribe(
      (st) => st.locale,
      () => renderHeaderState()
    );
    const unsubVisibility = uiStore.subscribe(
      (st) => st.monitorVisible,
      (visible) => {
        if (visible) renderHeaderState();
      },
      { immediate: false }
    );

    onCleanup(() => {
      unsubTelemetry();
      unsubI18n();
      unsubVisibility();
      convSelect.destroy();
    });

    return {
      el: headerEl,
      refs: { convSelect, statusTag, refreshBtn },
    };
  },
});
return { TopSessionHeader };
})();

// --- src/views/LiveOverviewView.js ---
const { LiveOverviewView } = (() => {
/**
 * @fileoverview View 1: Decoupled `LiveOverviewView.js` (实时监控视图).
 * Acts as a lightweight host container delegating all telemetry cards
 * (`metrics`, `context`, `quotas`, `live_tasks`) to `widgetRegistry.js` (`a` calls `b`),
 * allowing users to freely reorder or remove any module down to 1 item.
 */



const LiveOverviewView = defineComponent({
  name: 'LiveOverviewView',
  setup({ onCleanup }) {
    const overviewInner = h('div', {
      className: 'overview-modules-host',
    });

    const widgetHost = createDynamicWidgetHost({
      containerEl: overviewInner,
      mode: 'overview',
      isVisibleFn: () => getVisibleMonitorView() === 'overview',
      initialModuleKeys: DEFAULT_CLIENT_OVERVIEW_MODULES,
    });

    const viewScrollbar = CustomScrollbar({
      contentEl: overviewInner,
      className: 'view-pane',
    });

    let latestData = null;
    let isDirty = false;
    let countdownTickTimer = null;

    function stopCountdownTicker() {
      if (countdownTickTimer) {
        clearInterval(countdownTickTimer);
        countdownTickTimer = null;
      }
    }

    function ensureCountdownTicker() {
      if (getVisibleMonitorView() !== 'overview') {
        stopCountdownTicker();
        return;
      }
      if (!countdownTickTimer) {
        countdownTickTimer = setInterval(() => {
          if (getVisibleMonitorView() === 'overview' && latestData) {
            renderData(latestData);
          }
        }, 30_000);
      }
    }

    function renderData(data) {
      if (!data) return;
      const moduleKeys = normalizeClientOverviewModules(data.settings?.overviewModules);
      const minuteTick = Math.floor(Date.now() / 30000);
      widgetHost.update({
        moduleKeys,
        data,
        minuteTick,
      });
      ensureCountdownTicker();
      viewScrollbar.refresh();
    }

    const unsubTelemetry = telemetryStore.subscribe(
      (st) => ({ telemetry: st.telemetry, minuteTick: st.minuteTick }),
      ({ telemetry: data }) => {
        latestData = data;
        if (getVisibleMonitorView() !== 'overview') {
          const stillRunning =
            (Array.isArray(data?.runningConversations) && data.runningConversations.length > 0) ||
            Boolean(
              data?.activeConversation?.isRunning ||
                data?.activeConversation?.aggregated?.isRunning
            );
          if (!stillRunning) {
            widgetHost.pauseTickers();
          }
          isDirty = true;
          return;
        }
        isDirty = false;
        renderData(data);
      }
    );

    let prevCtxTarget = uiStore.getState().ctxInspectorAgentId;

    const unsubView = uiStore.subscribe(
      (st) => ({
        activeView: getVisibleMonitorView(st),
        ctxInspectorAgentId: st.ctxInspectorAgentId,
      }),
      (slice) => {
        const scopeChanged = slice.ctxInspectorAgentId !== prevCtxTarget;
        prevCtxTarget = slice.ctxInspectorAgentId;

        if (slice.activeView !== 'overview') {
          widgetHost.pauseTickers();
          stopCountdownTicker();
          if (scopeChanged) isDirty = true;
          return;
        }
        ensureCountdownTicker();
        if ((isDirty || scopeChanged) && latestData) {
          isDirty = false;
          renderData(latestData);
        } else {
          widgetHost.resumeTickers();
        }
      }
    );

    const unsubI18n = i18nStore.subscribe(
      (st) => st.locale,
      () => {
        if (getVisibleMonitorView() !== 'overview') {
          isDirty = true;
          // Refresh initial skeleton labels even before telemetry arrives
          if (!latestData) {
            widgetHost.update({
              moduleKeys: DEFAULT_CLIENT_OVERVIEW_MODULES,
              data: null,
            });
          }
          return;
        }
        if (latestData) {
          renderData(latestData);
        } else {
          widgetHost.update({
            moduleKeys: DEFAULT_CLIENT_OVERVIEW_MODULES,
            data: null,
          });
        }
      }
    );

    onCleanup(() => {
      stopCountdownTicker();
      unsubTelemetry();
      unsubView();
      unsubI18n();
      widgetHost.destroy();
      viewScrollbar.destroy();
    });

    return {
      el: viewScrollbar.el,
      refs: { viewScrollbar, widgetHost },
    };
  },
});
return { LiveOverviewView };
})();

// --- src/views/ConsumptionView.js ---
const { ConsumptionView } = (() => {
/**
 * @fileoverview View 2: ConsumptionView (全景消耗统计视图).
 * 采用 5 段式分析布局展示指定时间窗口内的全量 Token 与费用消耗：
 * 1. 用量概览：支持预设时间段与自定义区间筛选，通过 3+3 组合矩阵展示总 Token/调用次数、
 *    USD/CNY 预估费用、缓存命中率与命中量、新输入/缓存读取（含节省费用）/输出细分占比，以及底部 4 段比例条 (`FourSegmentBar`)。
 * 2. 历史趋势：基于 `TrendAreaChart` 渲染纯 SVG 三次贝塞尔平滑曲线面积图、峰值气泡、对齐多刻度时间轴与悬停详情浮层。
 * 3. 热门模型：按 Token 总量降序展示各模型的消耗占比徽章、4 段构成条及输入/缓存/输出/思考/调用明细。
 * 4. 数据来源：按调用来源聚合展示 Token 构成、占比与费用明细。
 * 5. 按月细分：12 个月垂直 4 段堆叠柱状图，直观对比全年各月费用、Token 总量与缓存/思考结构。
 */


/** 消耗统计顶栏支持的时间范围预设项 */
function getConsumptionTimeRangeOptions() {
  return [
    { value: 'cycle', label: t('cons.rangeCycle') },
    { value: 'today', label: t('cons.rangeToday') },
    { value: '24h', label: t('cons.range24h') },
    { value: '7d', label: t('cons.range7d') },
    { value: '14d', label: t('cons.range14d') },
    { value: '30d', label: t('cons.range30d') },
    { value: 'all', label: t('cons.rangeAll') },
    { value: 'custom', label: t('cons.rangeCustom') },
  ];
}

const ConsumptionView = defineComponent({
  name: 'ConsumptionView',
  setup({ onCleanup }) {
    // --- 时间筛选栏：快速时间段分段控制器与自定义起止时间选择条 ---
    let draftStartMs = telemetryStore.getState().customStartMs;
    let draftEndMs = telemetryStore.getState().customEndMs;
    let hasUncommittedCustomDraft = false;

    const timeFilterSwitch = SegmentedControl({
      ariaLabel: t('cons.rangeAria'),
      modelValue: telemetryStore.getState().selectedTimeRange,
      options: getConsumptionTimeRangeOptions(),
      onUpdateModelValue: (nextRange) => {
        if (nextRange === 'custom') {
          const st = telemetryStore.getState();
          draftStartMs = st.customStartMs;
          draftEndMs = st.customEndMs;
          hasUncommittedCustomDraft = false;
          startPicker.setValue(draftStartMs);
          endPicker.setValue(draftEndMs);
        } else {
          hasUncommittedCustomDraft = false;
        }
        selectConsumptionTimeRange(nextRange);
      },
    });

    const startPicker = CustomDateTimePicker({
      modelValue: draftStartMs,
      onUpdateModelValue: (ms) => {
        draftStartMs = ms;
        hasUncommittedCustomDraft = true;
        startPicker.setValue(ms);
      },
    });

    const endPicker = CustomDateTimePicker({
      modelValue: draftEndMs,
      onUpdateModelValue: (ms) => {
        draftEndMs = ms;
        hasUncommittedCustomDraft = true;
        endPicker.setValue(ms);
      },
    });

    const applyCustomBtnLabel = h('span', { text: t('cons.applyFilter') });
    const applyCustomBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-primary',
        style: 'height: 26px; padding: 0 10px;',
        onClick: () => {
          const sMs = Number(draftStartMs || 0);
          const eMs = Number(draftEndMs || 0);
          const minMs = sMs > 0 && eMs > 0 ? Math.min(sMs, eMs) : sMs;
          const maxMs = sMs > 0 && eMs > 0 ? Math.max(sMs, eMs) : eMs;
          draftStartMs = minMs;
          draftEndMs = maxMs;
          hasUncommittedCustomDraft = false;
          startPicker.setValue(minMs);
          endPicker.setValue(maxMs);
          selectConsumptionTimeRange('custom', {
            customStartMs: minMs,
            customEndMs: maxMs,
          });
        },
      },
      [createSvgIcon('check', { size: 12 }), applyCustomBtnLabel]
    );

    const rangeToSpan = h('span', { className: 'text-muted', text: t('cons.rangeTo') });
    const customRangeBar = h(
      'div',
      {
        className: 'cons-custom-range-bar',
        hidden: true,
      },
      [
        startPicker.el,
        rangeToSpan,
        endPicker.el,
        applyCustomBtn,
      ]
    );

    // --- Section 1: 用量概览矩阵 (上层 3 列核心总量 + 下层 3 列新输入/缓存读取/输出拆分 + 底部 4 段比例条) ---
    const dateSpanBadge = h('span', { className: 'cons-badge text-mono', text: '-- ~ --' });
    const heroTotalTokens = h('strong', { className: 'cons-hero-num text-mono', text: '0' });
    const heroTotalCalls = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: t('cons.callsCount', { calls: 0 }) });
    const heroCostUsd = h('strong', { className: 'cons-hero-cost text-mono', text: '$0.00' });
    const heroCostCny = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: '≈ ¥0' });

    const cacheHitPctEl = h('strong', { className: 'cons-hero-cache text-mono', text: '0%' });
    const cacheTokensEl = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: t('cons.cacheHitTokens', { tokens: 0 }) });

    const inputSharePct = h('span', { className: 'text-mono', style: 'color: var(--ctx-input); font-weight: 600; font-size: var(--fs-base-sm);', text: '0%' });
    const inputMainTokens = h('strong', { className: 'cons-mid-num text-mono', text: '0' });
    const inputSubText = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: t('cons.uncachedInput') });

    const cacheSharePct = h('span', { className: 'text-mono', style: 'color: var(--ctx-cached); font-weight: 600; font-size: var(--fs-base-sm);', text: '0%' });
    const cacheMainTokens = h('strong', { className: 'cons-mid-num text-mono', text: '0' });
    const cacheSubText = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: t('cons.savedCost', { cost: '$0.00' }) });

    const outputSharePct = h('span', { className: 'text-mono', style: 'color: var(--ctx-output); font-weight: 600; font-size: var(--fs-base-sm);', text: '0%' });
    const outputMainTokens = h('strong', { className: 'cons-mid-num text-mono', text: '0' });
    const outputSubText = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: t('cons.replyAndThink', { resp: 0, think: 0 }) });

    const overviewSegBar = createFourSegmentBar();
    const overviewTitleSpan = h('span', { text: t('cons.overviewTitle') });
    const totalTokensLabel = h('span', { className: 'text-muted', style: 'font-size: var(--fs-md);', text: t('cons.totalTokens') });
    const estCostLabel = h('span', { className: 'text-muted', style: 'font-size: var(--fs-md);', text: t('cons.estCost') });
    const cacheHitRateLabel = h('span', { text: t('cons.cacheHitRate') });
    const newInputLabel = h('span', { text: t('cons.newInput') });
    const cacheReadLabel = h('span', { text: t('cons.cacheRead') });
    const outputUsageLabel = h('span', { text: t('cons.outputUsage') });

    const overviewPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header cons-overview-head' }, [
        h('span', { className: 'panel-title' }, [
          overviewTitleSpan,
          dateSpanBadge,
        ]),
        timeFilterSwitch.el,
      ]),
      customRangeBar,
      h('div', { className: 'cons-box cons-unified-matrix' }, [
        h('div', { className: 'cons-split-3' }, [
          h('div', { className: 'cons-col' }, [
            totalTokensLabel,
            h('div', { className: 'cons-baseline' }, [heroTotalTokens, heroTotalCalls]),
          ]),
          h('div', { className: 'cons-col is-bordered-col' }, [
            estCostLabel,
            h('div', { className: 'cons-baseline' }, [heroCostUsd, heroCostCny]),
          ]),
          h('div', { className: 'cons-col is-bordered-col' }, [
            h('span', { className: 'legend-left', style: 'font-size: var(--fs-md);' }, [
              h('span', { className: 'dot-swatch seg-cached' }),
              cacheHitRateLabel,
            ]),
            h('div', { className: 'cons-baseline' }, [cacheHitPctEl, cacheTokensEl]),
          ]),
        ]),
        h('div', { className: 'cons-split-3 cons-matrix-bottom' }, [
          h('div', { className: 'cons-col' }, [
            h('div', { className: 'cons-sub-head' }, [
              h('span', { className: 'legend-left cons-sub-label' }, [
                h('span', { className: 'dot-swatch seg-input' }),
                newInputLabel,
              ]),
              inputSharePct,
            ]),
            inputMainTokens,
            inputSubText,
          ]),
          h('div', { className: 'cons-col is-bordered-col' }, [
            h('div', { className: 'cons-sub-head' }, [
              h('span', { className: 'legend-left cons-sub-label' }, [
                h('span', { className: 'dot-swatch seg-cached' }),
                cacheReadLabel,
              ]),
              cacheSharePct,
            ]),
            cacheMainTokens,
            cacheSubText,
          ]),
          h('div', { className: 'cons-col is-bordered-col' }, [
            h('div', { className: 'cons-sub-head' }, [
              h('span', { className: 'legend-left cons-sub-label' }, [
                h('span', { className: 'dot-swatch seg-output' }),
                outputUsageLabel,
              ]),
              outputSharePct,
            ]),
            outputMainTokens,
            outputSubText,
          ]),
        ]),
      ]),
      overviewSegBar.el,
    ]);

    // --- Section 2: 历史趋势 (交互式 SVG 平滑曲线图 + 悬停精确日期/小时浮层 + 多刻度时间轴) ---
    const trendTitleSpan = h('span', { text: t('cons.trendTitle') });
    const trendRangeBadge = h('span', { className: 'cons-badge', text: t('cons.allTime') });
    const trendGranularityHint = h('span', {
      className: 'text-muted text-mono',
      style: 'font-size: var(--fs-sm);',
      text: t('cons.trendPointsHintHourly', { points: 0 }),
    });
    const trendChart = createTrendAreaChart();

    const trendPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          trendTitleSpan,
          trendRangeBadge,
        ]),
        trendGranularityHint,
      ]),
      trendChart.el,
    ]);

    // --- Section 3: 模型排行列表 ---
    const modelsTitleSpan = h('span', { className: 'panel-title', text: t('cons.topModels') });
    const modelsListEl = h('div', { className: 'cons-item-list' });
    const modelsPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        modelsTitleSpan,
      ]),
      modelsListEl,
    ]);

    // --- Section 4: 客户端来源列表 ---
    const sourcesTitleSpan = h('span', { className: 'panel-title', text: t('cons.clientSources') });
    const sourcesHoverHint = h('span', {
      className: 'text-muted text-mono',
      style: 'font-size: var(--fs-sm);',
      text: t('cons.hoverModelsHint'),
    });
    const sourcesListEl = h('div', { className: 'cons-item-list' });
    const sourcesPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        sourcesTitleSpan,
        sourcesHoverHint,
      ]),
      sourcesListEl,
    ]);

    // --- Section 5: 按月细分 (12 个月垂直按模型配色堆叠柱状图 + 悬停明细浮层) ---
    const monthlyTitleSpan = h('span', { text: t('cons.monthlyTitle') });
    const monthlyYearBadge = h('span', { className: 'cons-badge text-mono', text: '2026' });
    const monthlyHoverHint = h('span', {
      className: 'text-muted text-mono',
      style: 'font-size: var(--fs-sm);',
      text: t('cons.hoverModelsHint'),
    });

    let activeHoverTargetEl = null;

    function createPopoverModelRow() {
      const dotEl = h('span', { className: 'dot-swatch cons-model-dot' });
      const nameEl = h('span', { className: 'cons-pop-model-name' });
      const tokEl = h('span', { className: 'cons-pop-model-tok' });
      const pctEl = h('strong', { className: 'cons-pop-model-pct' });
      const rowEl = h('div', { className: 'cons-pop-model-row' }, [
        h('span', { className: 'cons-pop-model-left' }, [dotEl, nameEl]),
        h('span', { className: 'cons-pop-model-right text-mono' }, [tokEl, pctEl]),
      ]);
      return {
        el: rowEl,
        refs: { rowEl, dotEl, nameEl, tokEl, pctEl },
      };
    }

    const popTitleEl = h('span', { className: 'trend-tip-time' });
    const popCallsEl = h('span', { className: 'trend-tip-calls text-mono' });
    const popTokensEl = h('strong', { className: 'trend-tip-tokens text-mono' });
    const popCostEl = h('span', { className: 'trend-tip-cost text-mono' });
    const popListEl = h('div', { className: 'cons-pop-models' });
    const breakdownPopoverEl = h(
      'div',
      { className: 'cons-breakdown-popover', hidden: true },
      [
        h('div', { className: 'trend-tip-head' }, [popTitleEl, popCallsEl]),
        h('div', { className: 'trend-tip-main' }, [popTokensEl, popCostEl]),
        popListEl,
      ]
    );

    function hideBreakdownPopover() {
      if (activeHoverTargetEl) {
        patchClasses(activeHoverTargetEl, { 'is-hovered': false });
        activeHoverTargetEl = null;
      }
      patchAttr(breakdownPopoverEl, 'hidden', true);
      patchClasses(breakdownPopoverEl, { 'is-tracking': false });
    }

    function positionBreakdownPopover(anchorEl, pointerClientX = null) {
      const rootRect = rootEl.getBoundingClientRect?.() || {
        left: 0,
        top: 0,
        width: 360,
        height: 600,
      };
      const anchorRect = anchorEl?.getBoundingClientRect?.() || {
        left: 0,
        top: 0,
        bottom: 0,
        width: 0,
        height: 0,
      };
      const tipRect = breakdownPopoverEl.getBoundingClientRect?.() || {
        width: 220,
        height: 120,
      };
      const rootW = rootRect.width > 0 ? rootRect.width : 360;
      const rootH = rootRect.height > 0 ? rootRect.height : 600;
      const tipW = tipRect.width > 0 ? tipRect.width : 220;
      const tipH = tipRect.height > 0 ? tipRect.height : 120;

      const centerX =
        Number.isFinite(pointerClientX) && pointerClientX > 0 && rootRect.width > 0
          ? pointerClientX - rootRect.left
          : anchorRect.left - rootRect.left + anchorRect.width / 2;

      const maxLeft = Math.max(8, rootW - tipW - 8);
      const leftPx = Math.max(8, Math.min(maxLeft, centerX - tipW / 2));

      const aboveTop = anchorRect.top - rootRect.top - tipH - 8;
      const belowTop = anchorRect.bottom - rootRect.top + 8;
      const topPx =
        aboveTop >= 6
          ? aboveTop
          : Math.min(Math.max(6, rootH - tipH - 6), Math.max(6, belowTop));

      patchStyleVar(breakdownPopoverEl, '--pop-x', `${Math.round(leftPx)}px`);
      patchStyleVar(breakdownPopoverEl, '--pop-y', `${Math.round(topPx)}px`);
    }

    function showBreakdownPopover(anchorEl, payload, pointerClientX = null) {
      if (!payload || !(payload.totalTokens > 0 || payload.calls > 0)) {
        hideBreakdownPopover();
        return;
      }
      if (activeHoverTargetEl && activeHoverTargetEl !== anchorEl) {
        patchClasses(activeHoverTargetEl, { 'is-hovered': false });
      }
      activeHoverTargetEl = anchorEl;
      patchClasses(anchorEl, { 'is-hovered': true });

      patchText(popTitleEl, payload.title || '—');
      patchText(popCallsEl, t('cons.callsCount', { calls: payload.calls || 0 }));
      patchText(popTokensEl, `${formatTokensPrecise(payload.totalTokens || 0)} tok`);
      patchText(popCostEl, payload.costText || '$0.00');

      const rows = Array.isArray(payload.segments) ? payload.segments : [];
      patchAttr(popListEl, 'hidden', rows.length === 0);
      patchKeyedList(popListEl, rows, {
        keyFn: (r) => r.key,
        sigFn: (r) => `${r.key}:${r.label}:${r.color}:${r.tokText}:${r.pctText}:${r.isOther}`,
        createRow: createPopoverModelRow,
        updateRow: (rRefs, r) => {
          patchClasses(rRefs.rowEl, { 'is-other': Boolean(r.isOther) });
          patchStyleVar(rRefs.dotEl, '--dot-color', r.color);
          patchText(rRefs.nameEl, r.label);
          patchText(rRefs.tokEl, r.tokText);
          patchText(rRefs.pctEl, r.pctText);
        },
      });

      const wasHidden = breakdownPopoverEl.hasAttribute('hidden');
      patchAttr(breakdownPopoverEl, 'hidden', false);
      positionBreakdownPopover(anchorEl, pointerClientX);
      if (wasHidden) {
        patchClasses(breakdownPopoverEl, { 'is-tracking': false });
        void breakdownPopoverEl.offsetWidth;
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(() => {
            if (!breakdownPopoverEl.hasAttribute('hidden')) {
              patchClasses(breakdownPopoverEl, { 'is-tracking': true });
            }
          });
        } else {
          patchClasses(breakdownPopoverEl, { 'is-tracking': true });
        }
      }
    }

    function createMonthModelSegment() {
      const segEl = h('div', { className: 'month-seg cons-model-seg' });
      return { el: segEl, refs: { segEl } };
    }

    const monthlyCols = Array.from({ length: 12 }, (_, idx) => {
      const costText = h('span', { className: 'month-cost text-mono', text: '' });
      const stackWrap = h('div', { className: 'month-stack' });
      const zeroDot = h('span', { className: 'month-zero-dot' });
      const monthLabel = h('span', { className: 'month-label', text: t('cons.monthLabel', { m: idx + 1 }) });
      const tokText = h('span', { className: 'month-tok text-mono', text: '' });

      const colState = { hoverPayload: null };
      const colEl = h(
        'div',
        {
          className: 'month-col',
          onMouseEnter: (e) => {
            if (colState.hoverPayload) {
              showBreakdownPopover(colEl, colState.hoverPayload, null);
            } else {
              e?.stopPropagation?.();
            }
          },
          onMouseLeave: () => {
            if (activeHoverTargetEl === colEl) hideBreakdownPopover();
          },
        },
        [
          costText,
          h('div', { className: 'month-bar-well' }, [stackWrap, zeroDot]),
          monthLabel,
          tokText,
        ]
      );
      return {
        el: colEl,
        costText,
        stackWrap,
        zeroDot,
        monthLabel,
        tokText,
        colState,
      };
    });

    const monthlyPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          monthlyTitleSpan,
          monthlyYearBadge,
        ]),
        monthlyHoverHint,
      ]),
      h(
        'div',
        { className: 'monthly-grid' },
        monthlyCols.map((c) => c.el)
      ),
    ]);

    const scrollInner = h(
      'div',
      {
        style: 'display: flex; flex-direction: column; gap: var(--space-3); padding-bottom: var(--space-3);',
      },
      [
        overviewPanel,
        trendPanel,
        modelsPanel,
        sourcesPanel,
        monthlyPanel,
      ]
    );

    const viewScrollbar = CustomScrollbar({
      contentEl: scrollInner,
      className: 'view-pane',
    });
    viewScrollbar.el.addEventListener?.('scroll', hideBreakdownPopover, { passive: true });

    const rootEl = h('div', { className: 'cons-view-stage' }, [
      viewScrollbar.el,
      breakdownPopoverEl,
    ]);

    /**
     * 将分模型列表收敛为主力模型 + 长尾「其他 (N)」，避免进度条尾部与浮层出现 0.0% 碎屑噪音。
     */
    function partitionModelSegments(
      mergedModels,
      modelColorMap,
      { maxMain = 5, minSharePct = 1.5 } = {}
    ) {
      if (!Array.isArray(mergedModels) || mergedModels.length === 0) return [];
      const sumTok = mergedModels.reduce((sum, m) => sum + Number(m.totalTokens || 0), 0);
      const mainModels = [];
      const tailModels = [];

      for (let i = 0; i < mergedModels.length; i++) {
        const m = mergedModels[i];
        const mTok = Number(m.totalTokens || 0);
        const sharePct = sumTok > 0 ? (mTok / sumTok) * 100 : 0;
        if (i === 0 || (mainModels.length < maxMain && sharePct >= minSharePct)) {
          mainModels.push(m);
        } else {
          tailModels.push(m);
        }
      }

      if (tailModels.length === 1) {
        mainModels.push(tailModels.pop());
      }

      const out = mainModels.map((m) => {
        const seed = getCanonicalModelColorSeed(m);
        const color =
          modelColorMap?.get(seed) || resolveDeterministicModelColor(seed || m.displayText);
        const tok = Number(m.totalTokens || 0);
        const pct = sumTok > 0 ? (tok / sumTok) * 100 : 0;
        const label = m.displayText || m.label || m.shortName || '—';
        return {
          key: label,
          label,
          tok,
          pct,
          tokText: formatTokensPrecise(tok),
          pctText: `${pct.toFixed(1)}%`,
          color,
          isOther: false,
        };
      });

      if (tailModels.length >= 2) {
        const otherTok = tailModels.reduce((sum, m) => sum + Number(m.totalTokens || 0), 0);
        const otherPct = sumTok > 0 ? (otherTok / sumTok) * 100 : 0;
        const otherLabel = t('cons.otherModelsCount', { count: tailModels.length });
        out.push({
          key: '__other__',
          label: otherLabel,
          tok: otherTok,
          pct: otherPct,
          tokText: formatTokensPrecise(otherTok),
          pctText: `${otherPct.toFixed(1)}%`,
          color: 'var(--cons-other-seg)',
          isOther: true,
        });
      }

      return out;
    }

    /**
     * 创建热门模型单行 DOM 结构（模型名称后附专属颜色圆点 + 按总占比缩放的 4 段比例条 + 底部分项脚标）。
     */
    function createBreakdownItemRow() {
      const nameTextEl = h('span', { className: 'cons-row-title-text' });
      const modelDotEl = h('span', { className: 'dot-swatch cons-model-dot cons-title-model-dot' });
      const nameEl = h('strong', { className: 'cons-row-title' }, [nameTextEl, modelDotEl]);
      const pctBadge = h('span', { className: 'cons-share-pill text-mono', text: '0%' });
      const totalTokEl = h('span', { className: 'cons-row-tok text-mono' });
      const costEl = h('strong', { className: 'cons-row-cost text-mono' });
      const segBar = createFourSegmentBar();

      const inLbl = h('span', { text: t('cons.footInput') });
      const cacheLbl = h('span', { text: t('cons.footCache') });
      const outLbl = h('span', { text: t('cons.footOutput') });
      const thinkLbl = h('span', { text: t('cons.footThinking') });
      const callsLbl = h('span', { text: t('cons.footCalls') });

      const inVal = h('strong', { className: 'text-mono' });
      const cacheVal = h('strong', { className: 'text-mono' });
      const outVal = h('strong', { className: 'text-mono' });
      const thinkVal = h('strong', { className: 'text-mono' });
      const callsVal = h('strong', { className: 'text-mono' });

      const rowEl = h('div', { className: 'cons-item-row' }, [
        h('div', { className: 'panel-header' }, [
          nameEl,
          h('span', { className: 'cons-row-metrics' }, [
            pctBadge,
            totalTokEl,
            costEl,
          ]),
        ]),
        segBar.el,
        h('div', { className: 'cons-item-foot' }, [
          h('span', { className: 'legend-left' }, [
            h('span', { className: 'dot-swatch seg-input' }),
            inLbl,
            inVal,
          ]),
          h('span', { className: 'legend-left' }, [
            h('span', { className: 'dot-swatch seg-cached' }),
            cacheLbl,
            cacheVal,
          ]),
          h('span', { className: 'legend-left' }, [
            h('span', { className: 'dot-swatch seg-output' }),
            outLbl,
            outVal,
          ]),
          h('span', { className: 'legend-left' }, [
            h('span', { className: 'dot-swatch seg-thinking' }),
            thinkLbl,
            thinkVal,
          ]),
          h('span', { className: 'legend-left' }, [
            callsLbl,
            callsVal,
          ]),
        ]),
      ]);

      return {
        el: rowEl,
        refs: {
          nameEl,
          nameTextEl,
          modelDotEl,
          pctBadge,
          totalTokEl,
          costEl,
          segBar,
          inLbl,
          cacheLbl,
          outLbl,
          thinkLbl,
          callsLbl,
          inVal,
          cacheVal,
          outVal,
          thinkVal,
          callsVal,
        },
      };
    }

    /**
     * 增量更新热门模型单行的指标文本、名称后的专属颜色圆点与按总占比缩放的 4 段比例条宽度。
     */
    function updateBreakdownItemRow(refs, item, grandTotalTokens, modelColor = '') {
      patchText(refs.inLbl, t('cons.footInput'));
      patchText(refs.cacheLbl, t('cons.footCache'));
      patchText(refs.outLbl, t('cons.footOutput'));
      patchText(refs.thinkLbl, t('cons.footThinking'));
      patchText(refs.callsLbl, t('cons.footCalls'));
      const displayLabel = item.label || item.name || item.shortName || '—';
      patchText(refs.nameTextEl, displayLabel);
      patchAttr(refs.nameEl, 'title', item.title || displayLabel);
      patchAttr(refs.modelDotEl, 'hidden', !modelColor);
      if (modelColor) {
        patchStyleVar(refs.modelDotEl, '--dot-color', modelColor);
      }
      const total = Number(item.totalTokens || 0);
      const share = grandTotalTokens > 0 ? +((total / grandTotalTokens) * 100).toFixed(1) : 0;
      const scaleRatio =
        grandTotalTokens > 0 && total > 0 ? Math.min(1, Math.max(0.008, total / grandTotalTokens)) : 0;
      patchText(refs.pctBadge, `${share.toFixed(1)}%`);
      patchText(refs.totalTokEl, formatTokensPrecise(total));
      const costVal = Number(item.costUsd || 0);
      const callsCount = Number(item.calls || 0);
      const isAllUnpriced =
        callsCount > 0 && Number(item.unpricedCalls || 0) >= callsCount && !(costVal > 0);
      patchText(
        refs.costEl,
        formatUsd(isAllUnpriced ? null : costVal, {
          precise: costVal > 0 && costVal < 0.1,
        })
      );

      const responseTok =
        item.responseTokens != null
          ? Number(item.responseTokens)
          : Math.max(0, Number(item.outputTokens || 0) - Number(item.thinkingTokens || 0));
      const thinkingTok = Number(item.thinkingTokens || 0);

      refs.segBar.update({
        inputTokens: Number(item.inputTokens || 0),
        cacheReadTokens: Number(item.cacheReadTokens || 0),
        responseTokens: responseTok,
        thinkingTokens: thinkingTok,
        scaleRatio,
      });

      patchText(refs.inVal, formatTokensPrecise(item.inputTokens || 0));
      patchText(refs.cacheVal, formatTokensPrecise(item.cacheReadTokens || 0));
      patchText(refs.outVal, formatTokensPrecise(responseTok));
      patchText(refs.thinkVal, formatTokensPrecise(thinkingTok));
      patchText(refs.callsVal, String(Number(item.calls || 0)));
    }

    function createSourceModelSegment() {
      const segEl = h('div', { className: 'progress-seg cons-model-seg' });
      return { el: segEl, refs: { segEl } };
    }

    function createSourceTopModelItem() {
      const dotEl = h('span', { className: 'dot-swatch cons-model-dot cons-source-top-dot' });
      const nameEl = h('span', { className: 'cons-source-top-name' });
      const pctEl = h('strong', { className: 'cons-source-top-pct text-mono' });
      const itemEl = h('span', { className: 'cons-source-top-item' }, [dotEl, nameEl, pctEl]);
      return { el: itemEl, refs: { itemEl, dotEl, nameEl, pctEl } };
    }

    function formatCompactSourceSharePct(pct) {
      const num = Number(pct || 0);
      if (!Number.isFinite(num) || num <= 0) return '0%';
      if (num >= 10) return `${Math.round(num)}%`;
      return `${num.toFixed(1)}%`;
    }

    /**
     * 创建客户端来源单行 DOM 结构（保留长尾合并分段配色进度条、单行不换行的 Top 2-3 模型速览和右侧总调用数，悬停进度条或速览区弹出完整明细浮层）。
     */
    function createSourceBreakdownRow() {
      const nameTextEl = h('span', { className: 'cons-row-title-text' });
      const nameEl = h('strong', { className: 'cons-row-title' }, [nameTextEl]);
      const pctBadge = h('span', { className: 'cons-share-pill text-mono', text: '0%' });
      const totalTokEl = h('span', { className: 'cons-row-tok text-mono' });
      const costEl = h('strong', { className: 'cons-row-cost text-mono' });
      const trackEl = h('div', { className: 'progress-track cons-seg-bar cons-source-model-bar' });
      const rowState = { hoverPayload: null };
      const bindPopoverHover = (targetEl) => ({
        onMouseEnter: (e) => {
          if (rowState.hoverPayload) {
            showBreakdownPopover(targetEl, rowState.hoverPayload, e?.clientX ?? null);
          }
        },
        onMouseMove: (e) => {
          if (rowState.hoverPayload && activeHoverTargetEl === targetEl) {
            positionBreakdownPopover(targetEl, e?.clientX ?? null);
          }
        },
        onMouseLeave: () => {
          if (activeHoverTargetEl === targetEl) hideBreakdownPopover();
        },
      });
      const barHitEl = h(
        'div',
        {
          className: 'cons-source-bar-hit',
        },
        [trackEl]
      );
      const barHandlers = bindPopoverHover(barHitEl);
      barHitEl.addEventListener('mouseenter', barHandlers.onMouseEnter);
      barHitEl.addEventListener('mousemove', barHandlers.onMouseMove);
      barHitEl.addEventListener('mouseleave', barHandlers.onMouseLeave);

      const topModelsEl = h('div', { className: 'cons-source-top-models', hidden: true });
      const topHandlers = bindPopoverHover(topModelsEl);
      topModelsEl.addEventListener('mouseenter', topHandlers.onMouseEnter);
      topModelsEl.addEventListener('mousemove', topHandlers.onMouseMove);
      topModelsEl.addEventListener('mouseleave', topHandlers.onMouseLeave);

      const callsLbl = h('span', { text: t('cons.footCalls') });
      const callsVal = h('strong', { className: 'text-mono' });

      const rowEl = h('div', { className: 'cons-item-row cons-source-row' }, [
        h('div', { className: 'panel-header' }, [
          nameEl,
          h('span', { className: 'cons-row-metrics' }, [
            pctBadge,
            totalTokEl,
            costEl,
          ]),
        ]),
        barHitEl,
        h('div', { className: 'cons-item-foot cons-source-foot' }, [
          topModelsEl,
          h('span', { className: 'legend-left cons-calls-stat' }, [
            callsLbl,
            callsVal,
          ]),
        ]),
      ]);

      return {
        el: rowEl,
        refs: {
          nameEl,
          nameTextEl,
          pctBadge,
          totalTokEl,
          costEl,
          barHitEl,
          trackEl,
          topModelsEl,
          callsLbl,
          callsVal,
          rowState,
        },
      };
    }

    function updateSourceBreakdownRow(refs, item, grandTotalTokens, modelColorMap) {
      patchText(refs.callsLbl, t('cons.footCalls'));
      const displayLabel = item.label || item.name || '—';
      patchText(refs.nameTextEl, displayLabel);
      patchAttr(refs.nameEl, 'title', item.title || displayLabel);

      const total = Number(item.totalTokens || 0);
      const share = grandTotalTokens > 0 ? +((total / grandTotalTokens) * 100).toFixed(1) : 0;
      const scaleRatio =
        grandTotalTokens > 0 && total > 0 ? Math.min(1, Math.max(0.01, total / grandTotalTokens)) : 0;
      patchText(refs.pctBadge, `${share.toFixed(1)}%`);
      patchText(refs.totalTokEl, formatTokensPrecise(total));

      const costVal = Number(item.costUsd || 0);
      const callsCount = Number(item.calls || 0);
      const isAllUnpriced =
        callsCount > 0 && Number(item.unpricedCalls || 0) >= callsCount && !(costVal > 0);
      const costText = formatUsd(isAllUnpriced ? null : costVal, {
        precise: costVal > 0 && costVal < 0.1,
      });
      patchText(refs.costEl, costText);
      patchText(refs.callsVal, String(callsCount));

      const sourceModels = Array.isArray(item.mergedModels) ? item.mergedModels : [];
      const partitioned = partitionModelSegments(sourceModels, modelColorMap, {
        maxMain: 5,
        minSharePct: 1.5,
      });

      const barItems =
        partitioned.length > 0
          ? partitioned.map((seg) => ({
              key: seg.key,
              segPct: scaleRatio > 0 ? seg.pct * scaleRatio : 0,
              color: seg.color,
            }))
          : total > 0
            ? [
                {
                  key: '__source_fallback__',
                  segPct: scaleRatio * 100,
                  color: 'var(--accent-primary)',
                },
              ]
            : [];

      patchKeyedList(refs.trackEl, barItems, {
        keyFn: (seg) => seg.key,
        sigFn: (seg) => `${seg.key}:${seg.segPct.toFixed(2)}:${seg.color}`,
        createRow: createSourceModelSegment,
        updateRow: (segRefs, seg) => {
          patchStyleVar(segRefs.segEl, '--seg-w', `${seg.segPct.toFixed(2)}%`);
          patchStyleVar(segRefs.segEl, '--seg-color', seg.color);
        },
      });

      const topModels = partitioned
        .filter((seg) => !seg.isOther)
        .slice(0, 3)
        .map((seg) => ({
          key: seg.key,
          label: seg.label,
          pctText: formatCompactSourceSharePct(seg.pct),
          color: seg.color,
        }));
      patchAttr(refs.topModelsEl, 'hidden', topModels.length === 0);
      patchKeyedList(refs.topModelsEl, topModels, {
        keyFn: (m) => m.key,
        sigFn: (m) => `${m.key}:${m.label}:${m.pctText}:${m.color}`,
        createRow: createSourceTopModelItem,
        updateRow: (mRefs, m) => {
          patchStyleVar(mRefs.dotEl, '--dot-color', m.color);
          patchText(mRefs.nameEl, m.label);
          patchText(mRefs.pctEl, m.pctText);
          patchAttr(mRefs.itemEl, 'title', `${m.label} (${m.pctText})`);
        },
      });

      refs.rowState.hoverPayload =
        total > 0 || callsCount > 0
          ? {
              title: displayLabel,
              calls: callsCount,
              totalTokens: total,
              costText,
              segments: partitioned,
            }
          : null;
    }

    let latestSlice = null;
    let isDirty = false;
    let prefetchedOnCurrentVisit = false;

    let lastRenderedTuple = null;
    let cachedMonthlySeriesRef = null;
    let cachedMonthlyDisplayKey = '';
    let cachedMonthsMergedModels = null;
    let cachedAllMonthMergedModels = null;

    function isSameRenderTuple(prev, next) {
      if (!prev || prev.length !== next.length) return false;
      for (let i = 0; i < prev.length; i++) {
        if (!Object.is(prev[i], next[i])) return false;
      }
      return true;
    }

    /**
     * 将遥测状态切片同步渲染至消费统计视图的 5 个子面板。
     */
    function renderConsumptionData(slice) {
      if (!slice) return;
      const cons = slice.consumption || {};
      const rangeInfo = cons.selectedRange || {};

      // 始终在 0ms 同步顶部时间段滑块与自定义日期条显隐，给予即刻交互反馈
      timeFilterSwitch.setValue(slice.range);
      patchAttr(customRangeBar, 'hidden', slice.range !== 'custom');
      if (!hasUncommittedCustomDraft) {
        draftStartMs = slice.customStartMs;
        draftEndMs = slice.customEndMs;
        startPicker.setValue(draftStartMs);
        endPicker.setValue(draftEndMs);
      }

      // 极少数缓存未命中时（如自定义新区间或进页瞬间抢点），跳过用旧趋势/模型跑无效半更新重绘，待几毫秒后单帧原子绘制
      if (rangeInfo.key && slice.range && rangeInfo.key !== slice.range) {
        return;
      }

      const preset =
        slice.range !== 'custom' && cons.presets?.[slice.range]
          ? cons.presets[slice.range]
          : null;
      const acct = cons.account || preset?.account || {};
      const dateSpan = formatDateSpanBadge(rangeInfo.startMs, rangeInfo.endMs);
      const now = new Date();
      const currentMonthIdx = now.getMonth();
      const monthlyYear = cons.monthlyYear || now.getFullYear();
      const locale = i18nStore.getState().locale;
      const renderTuple = [
        locale,
        slice.range,
        slice.customStartMs,
        slice.customEndMs,
        slice.modelDisplayMode,
        slice.showUpstreamModel,
        slice.orchestratorIdMode,
        dateSpan,
        preset?.label || rangeInfo.label,
        acct,
        cons.trendSeries,
        slice.modelBreakdown,
        cons.sourcesBreakdown,
        monthlyYear,
        currentMonthIdx,
        cons.monthlySeries,
      ];
      if (isSameRenderTuple(lastRenderedTuple, renderTuple)) return;
      drawConsumptionData(slice, { cons, preset, acct, rangeInfo, dateSpan, currentMonthIdx, monthlyYear });
      lastRenderedTuple = renderTuple;
    }

    function drawConsumptionData(slice, { cons, preset, acct, rangeInfo, dateSpan, currentMonthIdx, monthlyYear }) {
      // 1. 同步用量概览矩阵与顶部 4 段比例条
      patchText(dateSpanBadge, dateSpan);
      const totalTokens = Number(acct.totalTokens || 0);
      const inputTokens = Number(acct.inputTokens || 0);
      const cacheTokens = Number(acct.cacheReadTokens || 0);
      const outputTokens = Number(acct.outputTokens || 0);
      const responseTokens = Number(acct.responseTokens || 0);
      const thinkingTokens = Number(acct.thinkingTokens || 0);
      const costUsd = Number(acct.costUsd || 0);
      const savedCostUsd = Number(acct.savedCostUsd || 0);

      patchText(heroTotalTokens, formatTokensPrecise(totalTokens));
      patchText(heroTotalCalls, t('cons.callsCount', { calls: acct.calls || 0 }));
      patchText(heroCostUsd, formatUsd(costUsd));
      patchText(heroCostCny, formatCnyApprox(costUsd));

      patchText(cacheHitPctEl, `${Number(acct.cacheHitPct ?? 0).toFixed(1)}%`);
      patchText(cacheTokensEl, t('cons.cacheHitTokens', { tokens: formatTokensPrecise(cacheTokens) }));

      let inPct = 0;
      let cachePct = 0;
      let outPct = 0;
      if (totalTokens > 0) {
        const scaled = scaleBucketsExact(
          { in: inputTokens, cache: cacheTokens, out: outputTokens },
          ['in', 'cache', 'out'],
          1000
        );
        inPct = +(scaled.in / 10).toFixed(1);
        cachePct = +(scaled.cache / 10).toFixed(1);
        outPct = +(scaled.out / 10).toFixed(1);
      }

      patchText(inputSharePct, `${inPct}%`);
      patchText(inputMainTokens, formatTokensPrecise(inputTokens));
      patchText(inputSubText, t('cons.uncachedInput'));

      patchText(cacheSharePct, `${cachePct}%`);
      patchText(cacheMainTokens, formatTokensPrecise(cacheTokens));
      patchText(
        cacheSubText,
        t('cons.savedCost', {
          cost: formatUsd(savedCostUsd, { precise: savedCostUsd > 0 && savedCostUsd < 0.01 }),
        })
      );

      patchText(outputSharePct, `${outPct}%`);
      patchText(outputMainTokens, formatTokensPrecise(outputTokens));
      patchText(
        outputSubText,
        t('cons.replyAndThink', {
          resp: formatTokensPrecise(responseTokens),
          think: formatTokensPrecise(thinkingTokens),
        })
      );

      overviewSegBar.update({
        inputTokens,
        cacheReadTokens: cacheTokens,
        responseTokens,
        thinkingTokens,
      });

      // 2-5. 统一解析展示模式与全局确定性模型配色映射（确保趋势浮层、模型排行圆点、客户端来源条、月度堆叠柱四处完全同色）
      const localeSig = i18nStore.getState().locale;
      const displaySettings = {
        modelDisplayMode: normalizeModelDisplayMode(
          slice.modelDisplayMode,
          slice.showUpstreamModel
        ),
        showUpstreamModel: Boolean(slice.showUpstreamModel),
        orchestratorIdMode: slice.orchestratorIdMode,
      };
      const mergeAndSortBucketModels = (rawList) =>
        mergeModelsByDisplayName(rawList || [], displaySettings, {
          preferLabelInShort: true,
        })
          .filter((m) => Number(m.totalTokens || 0) > 0 || Number(m.calls || 0) > 0)
          .sort(
            (a, b) =>
              (b.totalTokens || 0) - (a.totalTokens || 0) || (b.calls || 0) - (a.calls || 0)
          );

      const models = mergeModelsByDisplayName(slice.modelBreakdown || [], displaySettings, {
        preferLabelInShort: true,
      }).sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0));
      const modelsTotalTok = models.reduce((s, m) => s + Number(m.totalTokens || 0), 0);

      const rawSources = cons.sourcesBreakdown || [];
      const sourcesTotalTok = rawSources.reduce((s, x) => s + Number(x.totalTokens || 0), 0);
      const allSourceMergedModels = [];
      const sourcesWithModels = rawSources.map((s) => {
        const mergedModels = mergeAndSortBucketModels(s.models);
        for (const m of mergedModels) {
          allSourceMergedModels.push(m);
        }
        return { ...s, mergedModels };
      });

      const monthlySeries = cons.monthlySeries || [];
      const monthlyDisplayKey = `${displaySettings.modelDisplayMode}|${displaySettings.showUpstreamModel ? 1 : 0}|${displaySettings.orchestratorIdMode}`;
      let monthsMergedModels;
      let allMonthMergedModels;
      if (
        cachedMonthlySeriesRef === monthlySeries &&
        cachedMonthlyDisplayKey === monthlyDisplayKey &&
        cachedMonthsMergedModels &&
        cachedAllMonthMergedModels
      ) {
        monthsMergedModels = cachedMonthsMergedModels;
        allMonthMergedModels = cachedAllMonthMergedModels;
      } else {
        allMonthMergedModels = [];
        monthsMergedModels = Array.from({ length: 12 }, (_, idx) => {
          const merged = mergeAndSortBucketModels(monthlySeries[idx]?.models);
          for (const m of merged) {
            allMonthMergedModels.push(m);
          }
          return merged;
        });
        cachedMonthlySeriesRef = monthlySeries;
        cachedMonthlyDisplayKey = monthlyDisplayKey;
        cachedMonthsMergedModels = monthsMergedModels;
        cachedAllMonthMergedModels = allMonthMergedModels;
      }

      const rawTrendSeries = cons.trendSeries || [];
      const allTrendMergedModels = [];
      const trendMergedByIdx = rawTrendSeries.map((slot) => {
        if (!Array.isArray(slot?.models) || slot.models.length === 0) return null;
        const merged = mergeAndSortBucketModels(slot.models);
        for (const m of merged) {
          allTrendMergedModels.push(m);
        }
        return merged;
      });

      const modelColorMap = buildDeterministicModelColorMap([
        ...models,
        ...allSourceMergedModels,
        ...allMonthMergedModels,
        ...allTrendMergedModels,
      ]);

      // 2. 同步历史趋势交互式 SVG 面积图 / 类 GitHub 每日热力图（>90天）与悬停分模型浮层
      const rangeBadgeText = isEnglishLocale()
        ? getConsumptionTimeRangeOptions().find((o) => o.value === slice.range)?.label ||
          t('cons.allTime')
        : preset?.label || rangeInfo.label || t('cons.allTime');
      patchText(trendRangeBadge, rangeBadgeText);
      const isHourlyTrend =
        rawTrendSeries[0]?.granularity === 'hour' ||
        (rawTrendSeries[0]?.label || '').includes(':');
      const isHeatmapTrend = !isHourlyTrend && rawTrendSeries.length > HEATMAP_DAYS_THRESHOLD;
      patchText(
        trendGranularityHint,
        isHeatmapTrend
          ? t('cons.trendHeatmapHint', { days: rawTrendSeries.length })
          : isHourlyTrend
            ? t('cons.trendPointsHintHourly', { points: rawTrendSeries.length || 0 })
            : t('cons.trendPointsHintDaily', { points: rawTrendSeries.length || 0 })
      );
      const enrichedTrendSeries = rawTrendSeries.map((slot, idx) => {
        const mergedSlotModels = trendMergedByIdx[idx];
        if (!mergedSlotModels || mergedSlotModels.length === 0) return slot;
        return {
          ...slot,
          modelSegments: partitionModelSegments(mergedSlotModels, modelColorMap, {
            maxMain: 5,
            minSharePct: 1.5,
          }),
        };
      });
      trendChart.update(enrichedTrendSeries);

      // 3. 同步热门模型列表（名称后带专属颜色圆点 + 4 段条按总占比缩放长度）
      patchKeyedList(modelsListEl, models, {
        keyFn: (m) => m.displayText || m.label || m.shortName,
        sigFn: (m) => {
          const seed = getCanonicalModelColorSeed(m);
          const color = modelColorMap.get(seed) || resolveDeterministicModelColor(seed);
          return `${localeSig}:${m.displayText}:${m.displayTitle}:${color}:${m.totalTokens}:${m.inputTokens}:${m.cacheReadTokens}:${m.responseTokens}:${m.thinkingTokens}:${m.costUsd}:${m.unpricedCalls}:${m.calls}:${modelsTotalTok}`;
        },
        createRow: createBreakdownItemRow,
        updateRow: (refs, m) => {
          const seed = getCanonicalModelColorSeed(m);
          const color = modelColorMap.get(seed) || resolveDeterministicModelColor(seed);
          updateBreakdownItemRow(
            refs,
            { ...m, label: m.displayText, title: m.displayTitle },
            modelsTotalTok,
            color
          );
        },
      });

      // 4. 同步客户端来源列表（长尾合并分段配色 + 右侧总调用数 + 悬停进度条弹出明细浮层）
      patchKeyedList(sourcesListEl, sourcesWithModels, {
        keyFn: (s) => s.name,
        sigFn: (s) => {
          const modelsSig = s.mergedModels
            .map((m) => {
              const seed = getCanonicalModelColorSeed(m);
              return `${m.displayText}:${m.totalTokens}:${m.calls}:${modelColorMap.get(seed) || ''}`;
            })
            .join('|');
          return `${localeSig}:${s.name}:${s.totalTokens}:${s.costUsd}:${s.unpricedCalls}:${s.calls}:${sourcesTotalTok}:${modelsSig}`;
        },
        createRow: createSourceBreakdownRow,
        updateRow: (refs, s) => updateSourceBreakdownRow(refs, s, sourcesTotalTok, modelColorMap),
      });

      // 5. 同步 12 个月垂直堆叠柱状图（按模型配色堆叠 + 长尾合并 + 悬停弹出明细浮层）
      patchText(monthlyYearBadge, String(monthlyYear));
      const maxMonthTokens = Math.max(
        1,
        ...monthlySeries.map((m) => Number(m.totalTokens || 0))
      );

      for (let i = 0; i < 12; i++) {
        const col = monthlyCols[i];
        const m = monthlySeries[i] || { totalTokens: 0, costUsd: 0, calls: 0 };
        const mTot = Number(m.totalTokens || 0);
        const mCalls = Number(m.calls || 0);
        const hasData = mTot > 0;

        patchClasses(col.el, { 'is-interactive': hasData || mCalls > 0 });
        patchClasses(col.monthLabel, { 'is-current': i === currentMonthIdx });
        patchAttr(col.stackWrap, 'hidden', !hasData);
        patchAttr(col.zeroDot, 'hidden', hasData);

        if (!hasData) {
          patchText(col.costText, '');
          patchText(col.tokText, '');
          col.colState.hoverPayload = null;
          patchKeyedList(col.stackWrap, [], {
            keyFn: (x) => x.key,
            sigFn: (x) => x.key,
            createRow: createMonthModelSegment,
            updateRow: () => {},
          });
        } else {
          const cVal = Number(m.costUsd || 0);
          const isMonthUnpriced =
            mCalls > 0 && Number(m.unpricedCalls || 0) >= mCalls && !(cVal > 0);
          patchText(
            col.costText,
            isMonthUnpriced ? '—' : cVal >= 10 ? `$${Math.round(cVal)}` : `$${cVal.toFixed(2)}`
          );
          patchText(col.tokText, formatTokensPrecise(mTot));

          const totalHeightPct = Math.max(8, Math.min(100, (mTot / maxMonthTokens) * 100));
          patchStyleVar(col.stackWrap, '--bar-h', `${totalHeightPct.toFixed(1)}%`);

          const monthModels = monthsMergedModels[i] || [];
          const barPartitioned = partitionModelSegments(monthModels, modelColorMap, {
            maxMain: 5,
            minSharePct: 1.5,
          });
          // 垂直柱状图底端放主力模型、顶端叠放小占比及「其他」，视觉重心稳定
          const verticalSegments =
            barPartitioned.length > 0
              ? [...barPartitioned].reverse()
              : [{ key: '__month_fallback__', pct: 100, color: 'var(--accent-primary)' }];

          patchKeyedList(col.stackWrap, verticalSegments, {
            keyFn: (seg) => seg.key,
            sigFn: (seg) => `${seg.key}:${seg.pct.toFixed(2)}:${seg.color}`,
            createRow: createMonthModelSegment,
            updateRow: (segRefs, seg) => {
              patchStyleVar(segRefs.segEl, '--seg-h', `${seg.pct.toFixed(2)}%`);
              patchStyleVar(segRefs.segEl, '--seg-color', seg.color);
            },
          });

          col.colState.hoverPayload = {
            title: t('cons.monthFullLabel', { year: monthlyYear, m: i + 1 }),
            calls: mCalls,
            totalTokens: mTot,
            costText: formatUsd(isMonthUnpriced ? null : cVal, {
              precise: cVal > 0 && cVal < 0.1,
            }),
            segments: barPartitioned,
          };
        }
      }

      if (activeHoverTargetEl && activeHoverTargetEl.isConnected === false) {
        hideBreakdownPopover();
      }

      viewScrollbar.refresh();
    }

    const unsub = telemetryStore.subscribe(
      (st) => ({
        range: st.selectedTimeRange,
        customStartMs: st.customStartMs,
        customEndMs: st.customEndMs,
        consumption: st.telemetry?.consumption,
        modelBreakdown: st.telemetry?.modelBreakdown,
        modelDisplayMode: normalizeModelDisplayMode(
          st.telemetry?.settings?.modelDisplayMode,
          st.telemetry?.settings?.showUpstreamModel
        ),
        showUpstreamModel: Boolean(st.telemetry?.settings?.showUpstreamModel),
        orchestratorIdMode: normalizeOrchestratorIdDisplayMode(
          st.telemetry?.settings?.orchestratorIdMode
        ),
      }),
      (slice) => {
        latestSlice = slice;
        if (getVisibleMonitorView() !== 'consumption') {
          hideBreakdownPopover();
          isDirty = true;
          return;
        }
        isDirty = false;
        renderConsumptionData(slice);
        if (!prefetchedOnCurrentVisit && Number(slice?.consumption?.revision || 0) > 0) {
          prefetchedOnCurrentVisit = true;
          void prefetchConsumptionPresets();
        }
      }
    );

    const unsubView = uiStore.subscribe(
      getVisibleMonitorView,
      (activeView) => {
        if (activeView !== 'consumption') {
          prefetchedOnCurrentVisit = false;
          hideBreakdownPopover();
          return;
        }
        if (isDirty) {
          isDirty = false;
          if (latestSlice) {
            renderConsumptionData(latestSlice);
          }
        }
        if (!prefetchedOnCurrentVisit && Number(latestSlice?.consumption?.revision || 0) > 0) {
          prefetchedOnCurrentVisit = true;
          void prefetchConsumptionPresets();
        }
      }
    );

    function syncStaticLocaleLabels() {
      timeFilterSwitch.setProps({
        ariaLabel: t('cons.rangeAria'),
        options: getConsumptionTimeRangeOptions(),
      });
      patchText(applyCustomBtnLabel, t('cons.applyFilter'));
      patchText(rangeToSpan, t('cons.rangeTo'));
      patchText(overviewTitleSpan, t('cons.overviewTitle'));
      patchText(totalTokensLabel, t('cons.totalTokens'));
      patchText(estCostLabel, t('cons.estCost'));
      patchText(cacheHitRateLabel, t('cons.cacheHitRate'));
      patchText(newInputLabel, t('cons.newInput'));
      patchText(cacheReadLabel, t('cons.cacheRead'));
      patchText(outputUsageLabel, t('cons.outputUsage'));
      patchText(trendTitleSpan, t('cons.trendTitle'));
      patchText(modelsTitleSpan, t('cons.topModels'));
      patchText(sourcesTitleSpan, t('cons.clientSources'));
      patchText(sourcesHoverHint, t('cons.hoverModelsHint'));
      patchText(monthlyTitleSpan, t('cons.monthlyTitle'));
      patchText(monthlyHoverHint, t('cons.hoverModelsHint'));
      for (let i = 0; i < 12; i++) {
        patchText(monthlyCols[i].monthLabel, t('cons.monthLabel', { m: i + 1 }));
      }
    }

    const unsubI18n = i18nStore.subscribe(
      (st) => st.locale,
      () => {
        syncStaticLocaleLabels();
        if (getVisibleMonitorView() === 'consumption' && latestSlice) {
          isDirty = false;
          renderConsumptionData(latestSlice);
        } else {
          isDirty = true;
        }
      }
    );

    onCleanup(() => {
      hideBreakdownPopover();
      unsub();
      unsubView();
      unsubI18n();
      trendChart.destroy?.();
      timeFilterSwitch.destroy();
      startPicker.destroy();
      endPicker.destroy();
      viewScrollbar.destroy();
    });

    return {
      el: rootEl,
      refs: { timeFilterSwitch, startPicker, endPicker, viewScrollbar, breakdownPopoverEl },
    };
  },
});
return { ConsumptionView };
})();

// --- src/views/StepsDetailView.js ---
const { StepsDetailView } = (() => {
/**
 * @fileoverview View 3: StepsDetailView (步骤明细与总汇总分析视图).
 * 提供“按步查看”与“总汇总”双子视图切换：
 * - 单步测速表通过 `stepColumnRegistry.js` 动态渲染用户自选的 2..12 个字段列，并支持行级增量对账；
 * - 总汇总视图提供会话线性走势图、多模型同图趋势拟合曲线与极简高密度模型总览卡片。
 */


function mergeSelectedAgentUnits(units) {
  const combinedSteps = [];
  const modelMap = new Map();

  for (const ag of units) {
    if (!ag || typeof ag !== 'object') continue;
    if (Array.isArray(ag.recentSteps)) {
      for (const step of ag.recentSteps) combinedSteps.push(step);
    }
    const breakdown = Array.isArray(ag.modelBreakdown) ? ag.modelBreakdown : [];
    for (const m of breakdown) {
      if (!m || typeof m !== 'object') continue;
      const gk = getStepModelGroupKey(m);
      let acc = modelMap.get(gk);
      if (!acc) {
        acc = {
          label: m.label || gk,
          shortName: m.shortName || gk,
          rawModel: m.rawModel || '',
          upstreamName: m.upstreamName || m.upstreamModel || '',
          upstreamSet: new Set(
            Array.isArray(m.upstreamModels) ? m.upstreamModels.filter(Boolean) : []
          ),
          calls: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          thinkingTokens: 0,
          responseTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          unpricedCalls: 0,
          anomalySteps: 0,
          anomalyCount: 0,
          anomalyDangerCount: 0,
          anomalyTotalDelaySec: 0,
          anomalyByKind: {},
          _speedWeightedSum: 0,
          _speedWeight: 0,
          _ttftWeightedSum: 0,
          _ttftWeight: 0,
        };
        if (acc.upstreamName) acc.upstreamSet.add(acc.upstreamName);
        modelMap.set(gk, acc);
      }
      if (!acc.upstreamName && (m.upstreamName || m.upstreamModel)) {
        acc.upstreamName = m.upstreamName || m.upstreamModel;
      }
      if (m.upstreamName) acc.upstreamSet.add(m.upstreamName);
      if (Array.isArray(m.upstreamModels)) {
        for (const u of m.upstreamModels) {
          if (u) acc.upstreamSet.add(u);
        }
      }
      const calls = Math.max(0, Number(m.calls || 0));
      const inTok = Math.max(0, Number(m.inputTokens || 0));
      const cacheTok = Math.max(0, Number(m.cacheReadTokens || 0));
      const outTok = Math.max(0, Number(m.outputTokens || 0));
      const thinkTok = Math.max(0, Number(m.thinkingTokens || 0));
      const respTok =
        m.responseTokens != null
          ? Math.max(0, Number(m.responseTokens))
          : Math.max(0, outTok - thinkTok);
      const totTok = Math.max(0, Number(m.totalTokens ?? inTok + cacheTok + outTok));
      const costUsd = Number.isFinite(Number(m.costUsd)) ? Math.max(0, Number(m.costUsd)) : 0;
      const unpricedCalls = Math.max(0, Number(m.unpricedCalls || 0));

      acc.calls += calls;
      acc.inputTokens += inTok;
      acc.cacheReadTokens += cacheTok;
      acc.outputTokens += outTok;
      acc.thinkingTokens += thinkTok;
      acc.responseTokens += respTok;
      acc.totalTokens += totTok;
      acc.costUsd += costUsd;
      acc.unpricedCalls += unpricedCalls;
      acc.anomalySteps += Math.max(0, Number(m.anomalySteps || 0));
      acc.anomalyCount += Math.max(0, Number(m.anomalyCount || 0));
      acc.anomalyDangerCount += Math.max(0, Number(m.anomalyDangerCount || 0));
      acc.anomalyTotalDelaySec += Math.max(0, Number(m.anomalyTotalDelaySec || 0));
      if (m.anomalyByKind && typeof m.anomalyByKind === 'object') {
        for (const [kind, cnt] of Object.entries(m.anomalyByKind)) {
          const n = Math.max(0, Number(cnt || 0));
          if (n > 0) acc.anomalyByKind[kind] = (acc.anomalyByKind[kind] || 0) + n;
        }
      }

      if (Number.isFinite(Number(m.avgTokPerSec)) && Number(m.avgTokPerSec) > 0) {
        const w = Math.max(1, outTok || calls || 1);
        acc._speedWeightedSum += Number(m.avgTokPerSec) * w;
        acc._speedWeight += w;
      }
      if (
        m.avgTtftSec != null &&
        Number.isFinite(Number(m.avgTtftSec)) &&
        Number(m.avgTtftSec) >= 0
      ) {
        const w = Math.max(1, calls || 1);
        acc._ttftWeightedSum += Number(m.avgTtftSec) * w;
        acc._ttftWeight += w;
      }
    }
  }

  combinedSteps.sort(
    (a, b) =>
      (Number(b?.createdAtMs) || 0) - (Number(a?.createdAtMs) || 0) ||
      (Number(b?.agentIndex) || 0) - (Number(a?.agentIndex) || 0) ||
      (Number(b?.stepIndex) || 0) - (Number(a?.stepIndex) || 0)
  );

  const mergedModels = Array.from(modelMap.values())
    .map((acc) => {
      const promptTok = acc.inputTokens + acc.cacheReadTokens;
      return {
        label: acc.label,
        shortName: acc.shortName,
        rawModel: acc.rawModel,
        upstreamName: acc.upstreamName,
        upstreamModels: Array.from(acc.upstreamSet),
        calls: acc.calls,
        inputTokens: acc.inputTokens,
        cacheReadTokens: acc.cacheReadTokens,
        outputTokens: acc.outputTokens,
        thinkingTokens: acc.thinkingTokens,
        responseTokens: acc.responseTokens,
        totalTokens: acc.totalTokens,
        costUsd: +acc.costUsd.toFixed(6),
        unpricedCalls: acc.unpricedCalls,
        avgTokPerSec:
          acc._speedWeight > 0 ? +(acc._speedWeightedSum / acc._speedWeight).toFixed(1) : null,
        avgTtftSec:
          acc._ttftWeight > 0 ? +(acc._ttftWeightedSum / acc._ttftWeight).toFixed(1) : null,
        cacheHitPct: promptTok > 0 ? +((acc.cacheReadTokens / promptTok) * 100).toFixed(1) : 0,
        ...(acc.anomalyCount > 0
          ? {
              anomalySteps: acc.anomalySteps,
              anomalyCount: acc.anomalyCount,
              anomalyDangerCount: acc.anomalyDangerCount,
              anomalyTotalDelaySec: +acc.anomalyTotalDelaySec.toFixed(1),
              anomalyByKind: acc.anomalyByKind,
            }
          : {}),
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls);

  return { steps: combinedSteps, models: mergedModels };
}

function getLineMetricSwitchOptions() {
  return [
    { value: 'totalTokens', label: t('steps.metricTotalTokens') },
    { value: 'context', label: t('steps.metricContext') },
    { value: 'tps', label: t('steps.metricTps') },
    { value: 'ttft', label: t('steps.metricTtft') },
    { value: 'cost', label: t('steps.metricCost') },
  ];
}

function getFitMetricSwitchOptions() {
  return [
    { value: 'tps', label: t('steps.metricTps') },
    { value: 'ttft', label: t('steps.metricTtft') },
    { value: 'cache', label: t('steps.metricCache') },
    { value: 'cost', label: t('steps.metricCost') },
  ];
}

const StepsDetailView = defineComponent({
  name: 'StepsDetailView',
  setup({ onCleanup }) {
    let selectedAgentScopes = [uiStore.getState().selectedAgentScope || 'all'];
    let lastSyncedUiScope = uiStore.getState().selectedAgentScope || 'all';
    let selectedTableModels = ['__all__'];
    let selectedLineModels = ['__all__'];
    let onlyAnomalies = false;
    let anomalyKindFilter = '';

    function applyAgentScopesSelection(nextScopes) {
      selectedAgentScopes = nextScopes;
      const mappedSingle =
        nextScopes.length === 1 && nextScopes[0] !== 'all' ? nextScopes[0] : 'all';
      const prevUiScope = uiStore.getState().selectedAgentScope;
      lastSyncedUiScope = mappedSingle;
      if (prevUiScope !== mappedSingle) {
        uiStore.setState({
          selectedAgentScope: mappedSingle,
          ...(mappedSingle === 'all' ? { ctxInspectorAgentId: 'auto' } : {}),
        });
      } else if (latestSlice) {
        renderStepsData(latestSlice);
      }
    }

    const inlineScopeSelect = CustomSelect({
      multiple: true,
      allValue: 'all',
      collapseAll: true,
      multiUnit: t('steps.unitAgent'),
      modelValue: selectedAgentScopes,
      placeholder: t('steps.allAgents'),
      className: 'steps-inline-scope-select',
      options: [{ value: 'all', label: t('steps.allAgents') }],
      onUpdateModelValue: (nextScopes) => {
        if (!Array.isArray(nextScopes) || nextScopes.length === 0) return;
        applyAgentScopesSelection(nextScopes);
      },
    });
    inlineScopeSelect.el.setAttribute('hidden', '');

    const stepsModelSelect = CustomSelect({
      multiple: true,
      allValue: '__all__',
      collapseAll: false,
      multiUnit: t('steps.unitModel'),
      modelValue: selectedTableModels,
      placeholder: t('steps.allModels'),
      className: 'steps-inline-model-select',
      options: [{ value: '__all__', label: t('steps.allModels') }],
      onUpdateModelValue: (nextModels) => {
        if (!Array.isArray(nextModels) || nextModels.length === 0) return;
        selectedTableModels = nextModels;
        if (latestSlice) renderStepsData(latestSlice);
      },
    });
    stepsModelSelect.el.setAttribute('hidden', '');

    const subTabSwitch = SegmentedControl({
      ariaLabel: t('steps.title'),
      modelValue: uiStore.getState().stepsSubTab,
      options: [
        { value: 'steps', label: t('steps.tabSteps', { count: 0 }) },
        { value: 'models', label: t('steps.tabModels') },
      ],
      onUpdateModelValue: (nextTab) => {
        uiStore.setState({ stepsSubTab: nextTab });
      },
    });

    // --- 子视图 1：单步明细表（委托给可复用的 `StepTableWidget` 解耦组件） ---
    let diagnosticUrl = null;
    const diagnosticText = h('pre', { style: 'white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px;' });
    const diagnosticDownload = h('a', { text: t('steps.diagnosticsDownload'), download: 'request-diagnostics.json', hidden: true });
    const diagnosticSummary = h('summary', { text: t('steps.diagnosticsHint') });
    const diagnosticPanel = h('details', { style: 'flex: 0 0 auto; max-height: 240px; overflow: auto; padding: 8px 12px;' }, [
      diagnosticSummary,
      diagnosticDownload, diagnosticText,
    ]);
    function inspectRequest(step) {
      const report = JSON.stringify(buildRequestDiagnostics(step), null, 2);
      patchText(diagnosticSummary, t('steps.diagnosticsSelected', { step: step.stepIndex }));
      patchText(diagnosticText, report);
      if (diagnosticUrl) URL.revokeObjectURL(diagnosticUrl);
      diagnosticUrl = URL.createObjectURL(new Blob([report], { type: 'application/json' }));
      patchAttr(diagnosticDownload, 'href', diagnosticUrl);
      patchAttr(diagnosticDownload, 'hidden', false);
      diagnosticPanel.open = true;
    }
    let stepsScroll = null;
    const stepTableWidget = StepTableWidget({
      onInspectRequest: inspectRequest,
      onSelectAgentScopes: applyAgentScopesSelection,
      onVirtualHeightChange: () => stepsScroll?.refresh(),
    });
    const {
      stepsTablePane,
      stepsTableEl,
      stepsTheadRow,
      stepsTbody,
      turnTipEl,
      anomalyTipEl,
      hideTurnTip,
      showAnomalyTip,
      hideAnomalyTip,
      syncTableHeaderColumns,
      renderStepTable,
      refreshViewport: refreshStepTableViewport,
    } = stepTableWidget.refs;
    stepsScroll = CustomScrollbar({
      contentEl: stepsTablePane,
      className: 'table-scroll-host',
    });

    const anomalyFilterLabelEl = h('span', { className: 'steps-anomaly-filter-label text-mono' });
    const anomalyFilterClearBtn = h('button', {
      type: 'button',
      className: 'btn-ghost-sm steps-anomaly-filter-clear',
      text: t('steps.anomalyFilterAll'),
      onclick: () => {
        onlyAnomalies = false;
        anomalyKindFilter = '';
        if (latestSlice) renderStepsData(latestSlice);
      },
    });
    const anomalyFilterBarEl = h(
      'div',
      { className: 'steps-anomaly-filterbar', hidden: true },
      [anomalyFilterLabelEl, anomalyFilterClearBtn]
    );

    // --- 子视图 2：总汇总分析面板 ---
    let selectedLineMetric = 'totalTokens';
    let selectedFitMetric = 'tps';

    let fitLockedCascadeId = null;
    let fitLockedModelKeys = [];
    let fitPinnedWhileVisible = false;
    let fitUserPicked = false;

    const lineTitleEl = h('span', { className: 'sstep-card-title', text: t('steps.lineTitle') });
    const lineSummaryBadge = h('span', {
      className: 'cons-badge text-mono',
      text: t('header.convMetaSteps', { count: 0 }),
    });
    const lineModelSelect = CustomSelect({
      multiple: true,
      allValue: '__all__',
      collapseAll: false,
      multiUnit: t('steps.unitModel'),
      modelValue: selectedLineModels,
      placeholder: t('steps.allModels'),
      className: 'sstep-fit-model-select sstep-line-model-select',
      options: [{ value: '__all__', label: t('steps.allModels') }],
      onUpdateModelValue: (nextModels) => {
        if (!Array.isArray(nextModels) || nextModels.length === 0) return;
        selectedLineModels = nextModels;
        if (latestSlice) renderStepsData(latestSlice);
      },
    });
    lineModelSelect.el.setAttribute('hidden', '');

    const lineMetricSwitch = SegmentedControl({
      ariaLabel: t('steps.lineTitle'),
      modelValue: selectedLineMetric,
      options: getLineMetricSwitchOptions(),
      onUpdateModelValue: (nextMetric) => {
        selectedLineMetric = nextMetric;
        if (latestSlice) renderStepsData(latestSlice);
      },
    });
    const sessionLineChart = createSessionLineChart();
    const sessionLineCard = h('div', { className: 'sstep-card sstep-line-card' }, [
      h('div', { className: 'sstep-card-head' }, [
        h('div', { className: 'sstep-card-title-group' }, [lineTitleEl, lineSummaryBadge]),
        h('div', { className: 'sstep-fit-controls' }, [
          lineModelSelect.el,
          lineMetricSwitch.el,
        ]),
      ]),
      sessionLineChart.el,
    ]);

    const fitTitleEl = h('span', { className: 'sstep-card-title', text: t('steps.fitTitle') });
    const fitSummaryBadge = h('span', {
      className: 'cons-badge text-mono',
      text: t('header.convMetaSteps', { count: 0 }),
    });
    const fitModelSelect = CustomSelect({
      multiple: true,
      allValue: '__all__',
      collapseAll: false,
      multiUnit: t('steps.unitModel'),
      modelValue: ['__all__'],
      placeholder: t('steps.selectModel'),
      className: 'sstep-fit-model-select',
      options: [{ value: '__all__', label: t('steps.allModels') }],
      onUpdateModelValue: (nextModelKeys) => {
        if (!Array.isArray(nextModelKeys) || nextModelKeys.length === 0) return;
        fitLockedModelKeys = nextModelKeys;
        fitUserPicked = true;
        fitPinnedWhileVisible = true;
        if (latestSlice) renderStepsData(latestSlice);
      },
    });
    fitModelSelect.el.setAttribute('hidden', '');

    const fitMetricSwitch = SegmentedControl({
      ariaLabel: t('steps.fitTitle'),
      modelValue: selectedFitMetric,
      options: getFitMetricSwitchOptions(),
      onUpdateModelValue: (nextMetric) => {
        selectedFitMetric = nextMetric;
        if (latestSlice) renderStepsData(latestSlice);
      },
    });
    const modelFitChart = createModelFitChart();
    const modelFitCard = h('div', { className: 'sstep-card sstep-fit-card' }, [
      h('div', { className: 'sstep-card-head' }, [
        h('div', { className: 'sstep-card-title-group' }, [fitTitleEl, fitSummaryBadge]),
        h('div', { className: 'sstep-fit-controls' }, [fitModelSelect.el, fitMetricSwitch.el]),
      ]),
      modelFitChart.el,
    ]);

    const modelsSectionTitleEl = h('span', {
      className: 'sstep-card-title',
      text: t('steps.modelsTitle'),
    });
    const modelsSummaryMeta = h('span', {
      className: 'cons-badge text-mono',
      text: t('cons.callsCount', { calls: 0 }),
    });
    const modelsAnomalyMetaEl = h('button', {
      type: 'button',
      className: 'steps-anomaly-strip-meta text-mono',
      onclick: () => {
        hideAnomalyTip();
        selectedTableModels = ['__all__'];
        onlyAnomalies = true;
        anomalyKindFilter = '';
        uiStore.setState({ stepsSubTab: 'steps' });
      },
    });
    const modelsAnomalyTagsEl = h('div', { className: 'steps-anomaly-strip-tags' });
    const modelsAnomalyStripEl = h(
      'div',
      { className: 'steps-anomaly-strip', hidden: true },
      [modelsAnomalyMetaEl, modelsAnomalyTagsEl]
    );
    let lastAnomalyStripSig = '';
    const modelsEmptyEl = h('div', {
      className: 'smodel-empty text-muted',
      text: t('steps.modelsEmpty'),
    });
    const modelsListEl = h('div', { className: 'smodel-list' });
    const modelsSummarySection = h('div', { className: 'smodel-section' }, [
      h('div', { className: 'smodel-section-head' }, [modelsSectionTitleEl, modelsSummaryMeta]),
      modelsAnomalyStripEl,
      modelsEmptyEl,
      modelsListEl,
    ]);

    const modelsAnalyticsPane = h('div', { className: 'table-viewport models-analytics-pane' }, [
      sessionLineCard,
      modelFitCard,
      modelsSummarySection,
    ]);
    const onModelsPaneScroll = () => hideAnomalyTip();
    modelsAnalyticsPane.addEventListener('scroll', onModelsPaneScroll, { passive: true });
    const modelsScroll = CustomScrollbar({
      contentEl: modelsAnalyticsPane,
      className: 'table-scroll-host',
    });
    modelsScroll.el.setAttribute('hidden', '');

    const panelTitleTextEl = h('span', { text: t('steps.title') });
    const panelEl = h(
      'section',
      {
        className: 'panel',
        style: 'flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative;',
      },
      [
        h('div', { className: 'panel-header steps-panel-header' }, [
          h('span', { className: 'panel-title steps-panel-title' }, [
            createSvgIcon('table', { size: 13 }),
            panelTitleTextEl,
          ]),
          h('div', { className: 'steps-header-controls' }, [
            inlineScopeSelect.el,
            stepsModelSelect.el,
            subTabSwitch.el,
          ]),
        ]),
        anomalyFilterBarEl,
        stepsScroll.el,
        modelsScroll.el,
        diagnosticPanel,
        turnTipEl,
        anomalyTipEl,
      ]
    );
    stepTableWidget.refs.setBoundsElGetter(() => panelEl);

    const rootEl = h('div', { className: 'view-pane' }, [panelEl]);

    let latestSlice = null;
    let isDirty = false;
    let cachedChronoSrc = null;
    let cachedChronoMerged = false;
    let cachedChronoOut = [];

    function getMemoizedChronoSteps(steps, isMergedMultiAgents) {
      if (cachedChronoSrc === steps && cachedChronoMerged === isMergedMultiAgents) {
        return cachedChronoOut;
      }
      cachedChronoSrc = steps;
      cachedChronoMerged = isMergedMultiAgents;
      cachedChronoOut = toChronologicalSteps(steps, isMergedMultiAgents);
      return cachedChronoOut;
    }

    function resolveDefaultActiveModelKey(scopedConv, chronoSteps, models, availableModelKeys) {
      if (scopedConv?.hasKnownModel !== false) {
        const activeCand = getStepModelGroupKey({
          baseModelLabel: scopedConv?.activeBaseModelLabel,
          baseModelShort: scopedConv?.activeBaseModelShort,
          modelLabel: scopedConv?.activeModelLabel,
          modelShort: scopedConv?.activeModelShort,
        });
        if (
          activeCand &&
          activeCand !== t('fmt.unknownModel') &&
          availableModelKeys.has(activeCand)
        ) {
          return activeCand;
        }
      }
      for (let i = chronoSteps.length - 1; i >= 0; i--) {
        const st = chronoSteps[i];
        if (!st || st.isCompactionStep) continue;
        const gk = getStepModelGroupKey(st);
        if (gk && availableModelKeys.has(gk)) return gk;
      }
      if (chronoSteps.length > 0) {
        const gk = getStepModelGroupKey(chronoSteps[chronoSteps.length - 1]);
        if (gk && availableModelKeys.has(gk)) return gk;
      }
      if (models.length > 0) {
        const firstKey = getStepModelGroupKey(models[0]);
        if (firstKey && availableModelKeys.has(firstKey)) return firstKey;
      }
      return '__all__';
    }

    function normalizeMultiModelSelection(rawSelection, availableModelKeys) {
      if (availableModelKeys.size <= 1) return ['__all__'];
      const arr = Array.isArray(rawSelection) ? rawSelection : [];
      if (arr.length === 0 || arr.includes('__all__')) return ['__all__'];
      const valid = Array.from(new Set(arr.filter((k) => availableModelKeys.has(k))));
      if (valid.length === 0) return ['__all__'];
      return valid;
    }

    function refreshStaticLocaleLabels() {
      patchText(panelTitleTextEl, t('steps.title'));
      patchText(lineTitleEl, t('steps.lineTitle'));
      patchText(fitTitleEl, t('steps.fitTitle'));
      patchText(modelsSectionTitleEl, t('steps.modelsTitle'));
      patchText(modelsEmptyEl, t('steps.modelsEmpty'));
      patchText(anomalyFilterClearBtn, t('steps.anomalyFilterAll'));
      lastAnomalyStripSig = '';
      lineMetricSwitch.setProps({
        modelValue: selectedLineMetric,
        options: getLineMetricSwitchOptions(),
      });
      fitMetricSwitch.setProps({
        modelValue: selectedFitMetric,
        options: getFitMetricSwitchOptions(),
      });
      const colKeys = normalizeClientStepColumns(latestSlice?.stepTableColumns);
      syncTableHeaderColumns(colKeys);
      if (!latestSlice) {
        subTabSwitch.setProps({
          modelValue: uiStore.getState().stepsSubTab,
          options: [
            { value: 'steps', label: t('steps.tabSteps', { count: 0 }) },
            { value: 'models', label: t('steps.tabModels') },
          ],
        });
      }
    }

    function renderStepsData(slice, { allowNewRowFade = false } = {}) {
      if (!slice) return;
      const uiSt = uiStore.getState();
      const locale = getEffectiveLocale();

      const currentCid = String(slice.cascadeId || slice.activeConversation?.cascadeId || '');
      if (currentCid !== fitLockedCascadeId) {
        if (fitLockedCascadeId !== null) {
          selectedAgentScopes = [uiSt.selectedAgentScope || 'all'];
          lastSyncedUiScope = uiSt.selectedAgentScope || 'all';
          selectedTableModels = ['__all__'];
          selectedLineModels = ['__all__'];
          onlyAnomalies = false;
          anomalyKindFilter = '';
        }
        fitLockedCascadeId = currentCid;
        fitUserPicked = false;
        fitPinnedWhileVisible = false;
        fitLockedModelKeys = [];
      }

      const baseScope = resolveScopedConversation(
        { activeConversation: slice.activeConversation },
        'all',
        uiSt.ctxInspectorAgentId,
        true
      );
      const { hasSubagents, agents, subagents, mainAgent, aggregated } = baseScope;

      let effectiveScopes = ['main'];
      let isMergedMultiAgents = false;
      let steps = [];
      let models = [];
      let activeModelSource = baseScope.scopedConv;

      patchAttr(inlineScopeSelect.el, 'hidden', !hasSubagents);
      if (hasSubagents) {
        const validAgentIds = ['main', ...subagents.map((s) => s.agentId)];
        const validSet = new Set(validAgentIds);
        if (selectedAgentScopes.length === 0 || selectedAgentScopes.includes('all')) {
          effectiveScopes = ['all'];
        } else {
          const filtered = selectedAgentScopes.filter((id) => validSet.has(id));
          effectiveScopes =
            filtered.length === 0 || filtered.length >= validAgentIds.length
              ? ['all']
              : filtered;
        }
        selectedAgentScopes = effectiveScopes;

        const scopeOpts = [
          {
            value: 'all',
            label: t('steps.allAgents'),
            meta: t('header.convMetaSteps', { count: aggregated?.stepCount ?? 0 }),
          },
          {
            value: 'main',
            label: t('fmt.mainAgent'),
            meta: t('header.convMetaSteps', { count: mainAgent?.stepCount ?? 0 }),
          },
          ...subagents.map((s) => ({
            value: s.agentId,
            label: formatAgentLabel(s),
            meta: t('header.convMetaSteps', { count: s.stepCount || 0 }),
          })),
        ];
        inlineScopeSelect.setProps({
          modelValue: effectiveScopes,
          options: scopeOpts,
          placeholder: t('steps.allAgents'),
          multiUnit: t('steps.unitAgent'),
        });

        if (effectiveScopes[0] === 'all') {
          steps = aggregated?.recentSteps || [];
          models = aggregated?.modelBreakdown || [];
          isMergedMultiAgents = true;
          activeModelSource = aggregated;
        } else if (effectiveScopes.length === 1) {
          const targetId = effectiveScopes[0];
          const unit =
            targetId === 'main'
              ? mainAgent
              : agents.find((a) => a.agentId === targetId) || mainAgent;
          steps = unit?.recentSteps || [];
          models = unit?.modelBreakdown || [];
          isMergedMultiAgents = false;
          activeModelSource = unit;
        } else {
          const scopeSet = new Set(effectiveScopes);
          const selectedUnits = agents.filter((a) =>
            scopeSet.has(a.isMain ? 'main' : a.agentId)
          );
          const merged = mergeSelectedAgentUnits(selectedUnits);
          steps = merged.steps;
          models = merged.models;
          isMergedMultiAgents = true;
          activeModelSource =
            selectedUnits.find((a) => a.isRunning) || selectedUnits[0] || aggregated;
        }
      } else {
        inlineScopeSelect.close();
        steps = slice.recentSteps || [];
        models = slice.sessionModelBreakdown || [];
      }

      const displaySettings = {
        modelDisplayMode: normalizeModelDisplayMode(
          slice.modelDisplayMode,
          slice.showUpstreamModel
        ),
        showUpstreamModel: Boolean(slice.showUpstreamModel),
        orchestratorIdMode: slice.orchestratorIdMode,
      };

      const showAgentPrefix = isMergedMultiAgents;
      const showModels = uiSt.stepsSubTab === 'models';

      const availableModelKeys = new Set();
      const modelColorByGroup = new Map();
      const perModelOptions = [];
      let breakdownCalls = 0;
      for (const m of models) {
        if (!m || typeof m !== 'object') continue;
        breakdownCalls += Math.max(0, Number(m.calls || 0));
        const gk = getStepModelGroupKey(m);
        if (availableModelKeys.has(gk)) continue;
        availableModelKeys.add(gk);
        modelColorByGroup.set(
          gk,
          MODEL_COLOR_VARS[(availableModelKeys.size - 1) % MODEL_COLOR_VARS.length]
        );
        const disp = resolveModelDisplayInfo(m, displaySettings, {
          preferLabelInShort: false,
          fallback: gk,
        });
        perModelOptions.push({
          value: gk,
          label: disp.baseText || disp.text || gk,
          meta: t('header.convMetaSteps', { count: Number(m.calls || 0) }),
        });
      }

      const needStepModelFallback =
        steps.length > 0 && (models.length === 0 || breakdownCalls < steps.length);
      if (needStepModelFallback) {
        const stepModelOptionMap = new Map();
        for (const st of steps) {
          const gk = getStepModelGroupKey(st);
          if (!stepModelOptionMap.has(gk)) {
            const disp = resolveModelDisplayInfo(st, displaySettings, { fallback: gk });
            stepModelOptionMap.set(gk, {
              label: disp.baseText || disp.text || gk,
              calls: 0,
            });
          }
          stepModelOptionMap.get(gk).calls += 1;
        }
        for (const [gk, info] of stepModelOptionMap.entries()) {
          if (!availableModelKeys.has(gk)) {
            availableModelKeys.add(gk);
            modelColorByGroup.set(
              gk,
              MODEL_COLOR_VARS[(availableModelKeys.size - 1) % MODEL_COLOR_VARS.length]
            );
            perModelOptions.push({
              value: gk,
              label: info.label,
              meta: t('header.convMetaSteps', { count: info.calls }),
            });
          }
        }
      }

      const hasMultipleModels = availableModelKeys.size > 1;
      const modelSelectOptions = [
        {
          value: '__all__',
          label: t('steps.allModels'),
          meta: t('header.convMetaSteps', { count: steps.length }),
        },
        ...perModelOptions,
      ];

      // 1. “按步查看”动态列头同步与表格行级增量对账
      selectedTableModels = normalizeMultiModelSelection(
        selectedTableModels,
        availableModelKeys
      );
      const showStepsModelFilter = uiSt.stepsSubTab === 'steps' && hasMultipleModels;
      patchAttr(stepsModelSelect.el, 'hidden', !showStepsModelFilter);
      if (hasMultipleModels) {
        stepsModelSelect.setProps({
          modelValue: selectedTableModels,
          options: modelSelectOptions,
          placeholder: t('steps.allModels'),
          multiUnit: t('steps.unitModel'),
        });
        if (!showStepsModelFilter) stepsModelSelect.close();
      } else {
        stepsModelSelect.close();
      }

      const tableModelFilterSet = selectedTableModels.includes('__all__')
        ? null
        : new Set(selectedTableModels);
      const modelFilteredSteps = tableModelFilterSet
        ? steps.filter((st) => tableModelFilterSet.has(getStepModelGroupKey(st)))
        : steps;
      const tableSteps = onlyAnomalies
        ? modelFilteredSteps.filter((st) => {
            const a = st?.anomaly;
            if (!a || !(Number(a.count) > 0)) return false;
            if (anomalyKindFilter) {
              return Number(a.kinds?.[anomalyKindFilter] || 0) > 0;
            }
            return true;
          })
        : modelFilteredSteps;

      const showAnomalyFilterBar = !showModels && onlyAnomalies;
      patchAttr(anomalyFilterBarEl, 'hidden', !showAnomalyFilterBar);
      if (showAnomalyFilterBar) {
        const baseLabel = t('steps.anomalyFilterLabel', { count: tableSteps.length });
        const kindSuffix = anomalyKindFilter
          ? ` · ${formatAnomalyKindLabel(anomalyKindFilter)}`
          : '';
        patchText(anomalyFilterLabelEl, `${baseLabel}${kindSuffix}`);
      }

      const stepsTabLabel =
        tableSteps.length !== steps.length
          ? t('steps.tabStepsFiltered', {
              filtered: tableSteps.length,
              total: steps.length,
            })
          : t('steps.tabSteps', { count: steps.length });

      subTabSwitch.setProps({
        options: [
          { value: 'steps', label: stepsTabLabel },
          { value: 'models', label: t('steps.tabModels') },
        ],
      });

      const allConversationSteps = hasSubagents
        ? aggregated?.recentSteps || []
        : slice.recentSteps || [];
      const shouldAnimateNewRows = Boolean(
        allowNewRowFade && slice.experimentalModernUi && !showModels
      );
      if (!showModels) {
        const colKeys = normalizeClientStepColumns(slice.stepTableColumns);
        renderStepTable(tableSteps, slice.cascadeId, colKeys, locale, {
          effectiveScopes,
          hasSubagents,
          isMergedMultiAgents,
          showStepTurnRail: slice.showStepTurnRail === true,
          showStepAgentBadge: slice.showStepAgentBadge !== false,
          showStepSpeedColor: slice.showStepSpeedColor === true,
          stepTokenComboFormat: slice.stepTokenComboFormat,
          displaySettings,
          allConversationSteps,
          allowNewRowFade: shouldAnimateNewRows,
        });
        stepsScroll.refresh();
        fitPinnedWhileVisible = false;
        return;
      }

      const chronoSteps = getMemoizedChronoSteps(steps, isMergedMultiAgents);
      const stepTtftFallbackMap = new Map();
      const needTtftFallback = models.some((m) => m && m.avgTtftSec == null);
      if (needTtftFallback) {
        for (const st of chronoSteps) {
          if (!st.isCompactionStep && Number.isFinite(st.ttftSec) && st.ttftSec >= 0) {
            const gk = getStepModelGroupKey(st);
            const prev = stepTtftFallbackMap.get(gk) || { sum: 0, count: 0 };
            prev.sum += Number(st.ttftSec);
            prev.count += 1;
            stepTtftFallbackMap.set(gk, prev);
          }
        }
      }

      // 2. 顶部“会话走势”更新
      selectedLineModels = normalizeMultiModelSelection(
        selectedLineModels,
        availableModelKeys
      );

      // 3. 顶部“趋势拟合”模型锁定随当前会话与代理范围更新。
      const defaultActiveModelKey = resolveDefaultActiveModelKey(
        activeModelSource,
        chronoSteps,
        models,
        availableModelKeys
      );
      const sanitizedLocked = fitLockedModelKeys.includes('__all__')
        ? ['__all__']
        : Array.from(new Set(fitLockedModelKeys.filter((k) => availableModelKeys.has(k))));

      if ((!fitPinnedWhileVisible && !fitUserPicked) || sanitizedLocked.length === 0) {
        fitLockedModelKeys = [defaultActiveModelKey];
      } else {
        fitLockedModelKeys = sanitizedLocked;
      }
      if (availableModelKeys.size > 0) fitPinnedWhileVisible = true;

      patchAttr(lineModelSelect.el, 'hidden', !hasMultipleModels);
      if (hasMultipleModels) {
        lineModelSelect.setProps({
          modelValue: selectedLineModels,
          options: modelSelectOptions,
          placeholder: t('steps.allModels'),
          multiUnit: t('steps.unitModel'),
        });
      } else {
        lineModelSelect.close();
      }

      const lineRes = sessionLineChart.update({
        steps: chronoSteps,
        modelGroupKey: selectedLineModels[0] || '__all__',
        modelGroupKeys: selectedLineModels,
        modelColorByGroup,
        metric: selectedLineMetric,
        showAgentPrefix,
        displaySettings,
      });
      patchText(lineSummaryBadge, lineRes.summaryBadge);

      const effectiveFitModelKeys =
        availableModelKeys.size === 0
          ? ['__all__']
          : !hasMultipleModels
            ? [Array.from(availableModelKeys)[0]]
            : fitLockedModelKeys.length > 0
              ? fitLockedModelKeys
              : [defaultActiveModelKey];

      patchAttr(fitModelSelect.el, 'hidden', !hasMultipleModels);
      if (hasMultipleModels) {
        fitModelSelect.setProps({
          modelValue: effectiveFitModelKeys,
          options: modelSelectOptions,
          placeholder: t('steps.selectModel'),
          multiUnit: t('steps.unitModel'),
        });
      } else {
        fitModelSelect.close();
      }

      const fitRes = modelFitChart.update({
        steps: chronoSteps,
        modelGroupKey: effectiveFitModelKeys[0] || '__all__',
        modelGroupKeys: effectiveFitModelKeys,
        modelColorByGroup,
        metric: selectedFitMetric,
        showAgentPrefix,
        displaySettings,
      });
      patchText(fitSummaryBadge, fitRes.summaryBadge);

      // 4. 极简模型总览列表增量对账
      const displayModels = mergeModelsByDisplayName(models, displaySettings, { fallback: '—' });
      const needStepAnomalyFallback = displayModels.every((m) => !(Number(m?.anomalyCount) > 0));
      let stepAnomalyByGroup = null;
      if (needStepAnomalyFallback) {
        for (const st of chronoSteps) {
          const a = st?.anomaly;
          if (!a || !(Number(a.count) > 0)) continue;
          if (!stepAnomalyByGroup) stepAnomalyByGroup = new Map();
          const gk = getStepModelGroupKey(st);
          let acc = stepAnomalyByGroup.get(gk);
          if (!acc) {
            acc = {
              anomalySteps: 0,
              anomalyCount: 0,
              anomalyDangerCount: 0,
              anomalyTotalDelaySec: 0,
              anomalyByKind: {},
            };
            stepAnomalyByGroup.set(gk, acc);
          }
          acc.anomalySteps += 1;
          acc.anomalyCount += Number(a.count) || 0;
          if (a.severity === 'danger') acc.anomalyDangerCount += 1;
          acc.anomalyTotalDelaySec += Number(a.totalDelaySec) || 0;
          if (a.kinds && typeof a.kinds === 'object') {
            for (const [k, cnt] of Object.entries(a.kinds)) {
              const n = Math.max(0, Number(cnt || 0));
              if (n > 0) acc.anomalyByKind[k] = (acc.anomalyByKind[k] || 0) + n;
            }
          }
        }
      }
      const resolveEffectiveAnomalyModel = (m) => {
        if (Number(m?.anomalyCount) > 0 || !stepAnomalyByGroup) return m;
        const gk = getStepModelGroupKey(m);
        const groupKeys =
          Array.isArray(m.sourceLabels) && m.sourceLabels.length > 0
            ? Array.from(new Set(m.sourceLabels.map((lbl) => getStepModelGroupKey({ label: lbl }))))
            : [gk];
        let anomalySteps = 0;
        let anomalyCount = 0;
        let anomalyDangerCount = 0;
        let anomalyTotalDelaySec = 0;
        const anomalyByKind = {};
        for (const key of groupKeys) {
          const hit = stepAnomalyByGroup.get(key);
          if (!hit) continue;
          anomalySteps += hit.anomalySteps;
          anomalyCount += hit.anomalyCount;
          anomalyDangerCount += hit.anomalyDangerCount;
          anomalyTotalDelaySec += hit.anomalyTotalDelaySec;
          for (const [k, cnt] of Object.entries(hit.anomalyByKind)) {
            anomalyByKind[k] = (anomalyByKind[k] || 0) + cnt;
          }
        }
        if (anomalyCount <= 0) return m;
        return {
          ...m,
          anomalySteps,
          anomalyCount,
          anomalyDangerCount,
          anomalyTotalDelaySec: +anomalyTotalDelaySec.toFixed(1),
          anomalyByKind,
        };
      };

      let sumCalls = 0;
      let sumTokens = 0;
      let sumCost = 0;
      let sumUnpriced = 0;
      let sumAnomalyCount = 0;
      let sumAnomalySteps = 0;
      const sumAnomalyByKind = {};
      const effectiveAnomalyModels = new Map();
      for (const m of displayModels) {
        sumCalls += Math.max(0, Number(m.calls || 0));
        sumTokens += Math.max(0, Number(m.totalTokens || 0));
        sumUnpriced += Math.max(0, Number(m.unpricedCalls || 0));
        if (Number.isFinite(Number(m.costUsd))) {
          sumCost += Math.max(0, Number(m.costUsd));
        }
        const effM = resolveEffectiveAnomalyModel(m);
        effectiveAnomalyModels.set(m, effM);
        const anomSum = resolveModelAnomalySummary(effM);
        if (anomSum) {
          sumAnomalyCount += anomSum.count;
          sumAnomalySteps += anomSum.steps;
          for (const [k, v] of anomSum.entries) {
            sumAnomalyByKind[k] = (sumAnomalyByKind[k] || 0) + v;
          }
        }
      }

      if (sumAnomalyCount > 0) {
        patchAttr(modelsAnomalyStripEl, 'hidden', false);
        const sortedKinds = Object.entries(sumAnomalyByKind)
          .filter(([, v]) => v > 0)
          .sort((a, b) => b[1] - a[1]);
        const stripSig = `${locale}:${sumAnomalyCount}:${sumAnomalySteps}:${sortedKinds.map(([k, v]) => `${k}=${v}`).join(',')}`;
        if (stripSig !== lastAnomalyStripSig) {
          lastAnomalyStripSig = stripSig;
          patchText(
            modelsAnomalyMetaEl,
            t('steps.anomalySummaryMeta', { count: sumAnomalyCount, steps: sumAnomalySteps })
          );
          while (modelsAnomalyTagsEl.firstChild) {
            modelsAnomalyTagsEl.removeChild(modelsAnomalyTagsEl.firstChild);
          }
          for (const [kind, cnt] of sortedKinds) {
            const isDanger = kind === 'rate_limit' || kind === 'auth_or_model';
            const btn = h('button', {
              type: 'button',
              className: `step-anomaly-tag smodel-anomaly-tag text-mono${isDanger ? ' is-danger' : ''}`,
              text: formatAnomalyTagText(kind, cnt),
              title: `${formatAnomalyKindLabel(kind)} · ${t('steps.anomalyModelClickHint')}`,
              onclick: () => {
                hideAnomalyTip();
                selectedTableModels = ['__all__'];
                onlyAnomalies = true;
                anomalyKindFilter = kind;
                uiStore.setState({ stepsSubTab: 'steps' });
              },
            });
            modelsAnomalyTagsEl.appendChild(btn);
          }
        }
      } else {
        lastAnomalyStripSig = '';
        patchAttr(modelsAnomalyStripEl, 'hidden', true);
      }

      if (displayModels.length === 0) {
        patchText(modelsSummaryMeta, t('cons.callsCount', { calls: 0 }));
      } else {
        const modelCountPart =
          displayModels.length > 1
            ? t('steps.modelsSummaryPrefix', { count: displayModels.length })
            : '';
        const isAllUnpricedSum = sumCalls > 0 && sumUnpriced >= sumCalls && !(sumCost > 0);
        patchText(
          modelsSummaryMeta,
          `${modelCountPart}${t('cons.callsCount', { calls: sumCalls })} · ${formatTokens(sumTokens)} · ${formatUsd(
            isAllUnpricedSum ? null : sumCost,
            {
              precise: sumCost > 0 && sumCost < 0.1,
            }
          )}`
        );
      }
      patchAttr(modelsEmptyEl, 'hidden', displayModels.length > 0);
      patchAttr(modelsListEl, 'hidden', displayModels.length === 0);

      const isFitPooledAll = effectiveFitModelKeys.includes('__all__');
      const fitActiveKeySet = new Set(isFitPooledAll ? [] : effectiveFitModelKeys);

      patchKeyedList(modelsListEl, displayModels, {
        keyFn: (m) => m.displayText || m.label || m.shortName,
        sigFn: (m) => {
          const gk = getStepModelGroupKey(m);
          const fbTtft = stepTtftFallbackMap.get(gk);
          const avgTtft =
            m.avgTtftSec != null
              ? m.avgTtftSec
              : fbTtft && fbTtft.count > 0
                ? +(fbTtft.sum / fbTtft.count).toFixed(1)
                : null;
          const cardGroupKeys =
            Array.isArray(m.sourceLabels) && m.sourceLabels.length > 0
              ? m.sourceLabels.map((lbl) => getStepModelGroupKey({ label: lbl }))
              : [gk];
          const isActiveFit =
            hasMultipleModels && cardGroupKeys.some((k) => fitActiveKeySet.has(k));
          const effM = effectiveAnomalyModels.get(m) || m;
          const anomSum = resolveModelAnomalySummary(effM);
          const anomSig = anomSum
            ? `${anomSum.count}:${anomSum.steps}:${anomSum.primaryKind}:${anomSum.severity}:${anomSum.totalDelaySec}`
            : '';
          return `${locale}:${m.displayText}:${m.displayTitle}:${m.calls}:${sumCalls}:${displayModels.length}:${m.avgTokPerSec}:${avgTtft}:${m.cacheHitPct}:${m.inputTokens}:${m.cacheReadTokens}:${m.thinkingTokens}:${m.responseTokens}:${m.totalTokens}:${m.costUsd}:${m.unpricedCalls}:${isActiveFit}:${hasMultipleModels}:${anomSig}`;
        },
        createRow: () => {
          const nameEl = h('strong', { className: 'smodel-name' });
          const callsPillEl = h('span', { className: 'smodel-calls-pill text-mono' });
          const anomalyTagEl = h('span', {
            className: 'step-anomaly-tag smodel-anomaly-tag text-mono',
            title: '',
            hidden: true,
          });
          const tokEl = h('span', { className: 'smodel-tok text-mono' });
          const costEl = h('strong', { className: 'smodel-cost text-mono' });
          const segBar = createFourSegmentBar();
          segBar.el.classList.add('smodel-seg-bar');

          const perfEl = h('span', { className: 'smodel-perf text-mono' });
          const splitEl = h('span', { className: 'smodel-split text-mono' });

          const cardEl = h('div', { className: 'smodel-card' }, [
            h('div', { className: 'smodel-head' }, [
              h('div', { className: 'smodel-ident' }, [nameEl, callsPillEl, anomalyTagEl]),
              h('div', { className: 'smodel-totals' }, [tokEl, costEl]),
            ]),
            segBar.el,
            h('div', { className: 'smodel-foot' }, [perfEl, splitEl]),
          ]);

          return {
            el: cardEl,
            refs: {
              nameEl,
              callsPillEl,
              anomalyTagEl,
              tokEl,
              costEl,
              segBar,
              perfEl,
              splitEl,
              cardTitle: '',
              isHoveringAnomaly: false,
            },
          };
        },
        updateRow: (refs, m, _idx, cardEl) => {
          const gk = getStepModelGroupKey(m);
          const cardGroupKeys =
            Array.isArray(m.sourceLabels) && m.sourceLabels.length > 0
              ? Array.from(
                  new Set(m.sourceLabels.map((lbl) => getStepModelGroupKey({ label: lbl })))
                )
              : [gk];
          const dispText = m.displayText || '—';
          const dispTitle = m.displayTitle || dispText;
          patchText(refs.nameEl, dispText);
          patchAttr(refs.nameEl, 'title', dispTitle);

          const calls = Math.max(0, Number(m.calls || 0));
          const callSharePct = sumCalls > 0 ? Math.round((calls / sumCalls) * 100) : 0;
          patchText(
            refs.callsPillEl,
            displayModels.length > 1
              ? t('steps.modelCallsShare', { calls, pct: callSharePct })
              : t('steps.modelCallsOnly', { calls })
          );

          const effM = effectiveAnomalyModels.get(m) || m;
          const anomSum = resolveModelAnomalySummary(effM);
          patchAttr(refs.anomalyTagEl, 'hidden', !anomSum);
          if (anomSum) {
            patchText(refs.anomalyTagEl, anomSum.tagText);
            patchClasses(refs.anomalyTagEl, { 'is-danger': anomSum.severity === 'danger' });
            patchAttr(refs.anomalyTagEl, 'title', '');
            refs.anomalyTagEl.onmouseenter = () => {
              refs.isHoveringAnomaly = true;
              patchAttr(cardEl, 'title', null);
              showAnomalyTip(refs.anomalyTagEl, buildModelAnomalyDiagnostic(effM));
            };
            refs.anomalyTagEl.onmouseleave = () => {
              refs.isHoveringAnomaly = false;
              patchAttr(cardEl, 'title', refs.cardTitle || null);
              hideAnomalyTip();
            };
            refs.anomalyTagEl.onclick = (e) => {
              e?.stopPropagation?.();
              refs.isHoveringAnomaly = false;
              patchAttr(cardEl, 'title', refs.cardTitle || null);
              hideAnomalyTip();
              selectedTableModels = hasMultipleModels ? [...cardGroupKeys] : ['__all__'];
              onlyAnomalies = true;
              anomalyKindFilter = '';
              uiStore.setState({ stepsSubTab: 'steps' });
            };
          } else {
            refs.isHoveringAnomaly = false;
            refs.anomalyTagEl.onmouseenter = null;
            refs.anomalyTagEl.onmouseleave = null;
            refs.anomalyTagEl.onclick = null;
          }

          const inTok = Math.max(0, Number(m.inputTokens || 0));
          const cacheTok = Math.max(0, Number(m.cacheReadTokens || 0));
          const outTok = Math.max(0, Number(m.outputTokens || 0));
          const thinkTok = Math.max(0, Number(m.thinkingTokens || 0));
          const respTok =
            m.responseTokens != null
              ? Math.max(0, Number(m.responseTokens))
              : Math.max(0, outTok - thinkTok);

          patchText(refs.tokEl, formatTokens(m.totalTokens || 0));
          const costNum = Number(m.costUsd || 0);
          const isAllUnpriced =
            calls > 0 && Number(m.unpricedCalls || 0) >= calls && !(costNum > 0);
          patchText(
            refs.costEl,
            formatUsd(isAllUnpriced ? null : costNum, { precise: costNum > 0 && costNum < 0.1 })
          );

          refs.segBar.update({
            inputTokens: inTok,
            cacheReadTokens: cacheTok,
            responseTokens: respTok,
            thinkingTokens: thinkTok,
          });

          const fbTtft = stepTtftFallbackMap.get(gk);
          const resolvedAvgTtft =
            m.avgTtftSec != null
              ? Number(m.avgTtftSec)
              : fbTtft && fbTtft.count > 0
                ? fbTtft.sum / fbTtft.count
                : null;
          const promptTok = inTok + cacheTok;
          const resolvedCachePct =
            m.cacheHitPct != null
              ? Number(m.cacheHitPct)
              : promptTok > 0
                ? +((cacheTok / promptTok) * 100).toFixed(1)
                : 0;

          patchText(
            refs.perfEl,
            t('steps.modelPerfFoot', {
              tps: formatSpeedMetric(m.avgTokPerSec, ' tok/s'),
              ttft: formatMetric(resolvedAvgTtft, 's'),
              cache: resolvedCachePct,
            })
          );
          patchText(
            refs.splitEl,
            t('steps.modelSplitFoot', {
              inTok: formatTokens(inTok),
              cacheTok: formatTokens(cacheTok),
              thinkTok: formatTokens(thinkTok),
              respTok: formatTokens(respTok),
            })
          );

          const isActiveFit =
            hasMultipleModels && cardGroupKeys.some((k) => fitActiveKeySet.has(k));
          patchClasses(cardEl, { 'is-fit-active': isActiveFit });
          refs.cardTitle = !hasMultipleModels
            ? dispTitle
            : isActiveFit
              ? t('steps.fitActiveCardTitle', { title: dispTitle })
              : t('steps.fitInactiveCardTitle', { text: dispText });
          patchAttr(cardEl, 'title', refs.isHoveringAnomaly ? null : refs.cardTitle);
          cardEl.onclick = (e) => {
            if (!hasMultipleModels) return;
            if (e && (e.ctrlKey || e.metaKey || e.shiftKey) && !isFitPooledAll) {
              const cardSet = new Set(cardGroupKeys);
              const next = isActiveFit
                ? effectiveFitModelKeys.filter((k) => !cardSet.has(k))
                : Array.from(new Set([...effectiveFitModelKeys, ...cardGroupKeys]));
              fitLockedModelKeys = next.length > 0 ? next : [...cardGroupKeys];
              fitUserPicked = true;
              fitPinnedWhileVisible = true;
              if (latestSlice) renderStepsData(latestSlice);
              return;
            }
            const isAlreadySole =
              !isFitPooledAll &&
              effectiveFitModelKeys.length === cardGroupKeys.length &&
              cardGroupKeys.every((k) => fitActiveKeySet.has(k));
            if (!isAlreadySole || !fitUserPicked) {
              fitLockedModelKeys = [...cardGroupKeys];
              fitUserPicked = true;
              fitPinnedWhileVisible = true;
              if (latestSlice) renderStepsData(latestSlice);
            }
          };
        },
      });

      modelsScroll.refresh();
    }

    const unsubUi = uiStore.subscribe(
      (st) => st.stepsSubTab,
      (tab) => {
        hideTurnTip();
        hideAnomalyTip();
        subTabSwitch.setValue(tab);
        patchAttr(anomalyFilterBarEl, 'hidden', tab !== 'steps' || !onlyAnomalies);
        patchAttr(stepsScroll.el, 'hidden', tab !== 'steps');
        patchAttr(modelsScroll.el, 'hidden', tab !== 'models');
        if (getVisibleMonitorView() === 'steps' && latestSlice) {
          renderStepsData(latestSlice);
        } else if (tab === 'steps') {
          refreshStepTableViewport();
          stepsScroll.refresh();
        } else {
          modelsScroll.refresh();
        }
      }
    );

    const unsubTelemetry = telemetryStore.subscribe(
      (st) => ({
        activeConversation: st.telemetry?.activeConversation,
        cascadeId: st.telemetry?.activeConversation?.cascadeId,
        recentSteps: st.telemetry?.activeConversation?.recentSteps,
        sessionModelBreakdown: st.telemetry?.activeConversation?.modelBreakdown,
        modelDisplayMode: normalizeModelDisplayMode(
          st.telemetry?.settings?.modelDisplayMode,
          st.telemetry?.settings?.showUpstreamModel
        ),
        showUpstreamModel: Boolean(st.telemetry?.settings?.showUpstreamModel),
        orchestratorIdMode: normalizeOrchestratorIdDisplayMode(
          st.telemetry?.settings?.orchestratorIdMode
        ),
        showStepTurnRail: st.telemetry?.settings?.showStepTurnRail === true,
        showStepAgentBadge: st.telemetry?.settings?.showStepAgentBadge !== false,
        showStepSpeedColor: st.telemetry?.settings?.showStepSpeedColor === true,
        stepTokenComboFormat: normalizeClientStepTokenComboFormat(
          st.telemetry?.settings?.stepTokenComboFormat
        ),
        stepTableColumns: st.telemetry?.settings?.stepTableColumns,
        experimentalModernUi: Boolean(st.telemetry?.settings?.experimentalModernUi),
      }),
      (slice) => {
        latestSlice = slice;
        if (getVisibleMonitorView() !== 'steps') {
          if (!fitUserPicked) {
            fitPinnedWhileVisible = false;
          }
          isDirty = true;
          return;
        }
        isDirty = false;
        renderStepsData(slice, {
          allowNewRowFade: uiStore.getState().stepsSubTab === 'steps',
        });
      }
    );

    let prevScope = uiStore.getState().selectedAgentScope;
    let prevActiveView = getVisibleMonitorView();

    const unsubView = uiStore.subscribe(
      (st) => ({
        activeView: getVisibleMonitorView(st),
        selectedAgentScope: st.selectedAgentScope,
      }),
      (uiSlice) => {
        const scopeChanged = uiSlice.selectedAgentScope !== prevScope;
        if (uiSlice.selectedAgentScope !== lastSyncedUiScope) {
          lastSyncedUiScope = uiSlice.selectedAgentScope;
          selectedAgentScopes = [uiSlice.selectedAgentScope || 'all'];
        }
        const viewEntered = uiSlice.activeView === 'steps' && prevActiveView !== 'steps';
        prevScope = uiSlice.selectedAgentScope;
        prevActiveView = uiSlice.activeView;
        if (uiSlice.activeView !== 'steps') {
          hideTurnTip();
          hideAnomalyTip();
          fitPinnedWhileVisible = false;
          if (scopeChanged) isDirty = true;
          return;
        }
        if ((isDirty || scopeChanged || viewEntered) && latestSlice) {
          isDirty = false;
          renderStepsData(latestSlice);
        }
      }
    );

    const unsubI18n = i18nStore.subscribe(
      (st) => st.locale,
      () => {
        refreshStaticLocaleLabels();
        patchText(diagnosticSummary, t('steps.diagnosticsHint'));
        patchText(diagnosticDownload, t('steps.diagnosticsDownload'));
        if (getVisibleMonitorView() === 'steps' && latestSlice) {
          renderStepsData(latestSlice);
        } else {
          isDirty = true;
        }
      }
    );

    onCleanup(() => {
      if (diagnosticUrl) URL.revokeObjectURL(diagnosticUrl);
      modelsAnalyticsPane.removeEventListener('scroll', onModelsPaneScroll);
      unsubUi();
      unsubTelemetry();
      unsubView();
      unsubI18n();
      stepTableWidget.destroy();
      sessionLineChart.destroy?.();
      modelFitChart.destroy?.();
      inlineScopeSelect.destroy();
      stepsModelSelect.destroy();
      subTabSwitch.destroy();
      lineModelSelect.destroy();
      lineMetricSwitch.destroy();
      fitModelSelect.destroy();
      fitMetricSwitch.destroy();
      stepsScroll.destroy();
      modelsScroll.destroy();
    });

    return {
      el: rootEl,
      refs: {
        stepsTableEl,
        stepsTheadRow,
        stepsTbody,
        turnTipEl,
        anomalyTipEl,
        anomalyFilterBarEl,
        modelsAnomalyStripEl,
        modelsListEl,
        inlineScopeSelect,
        stepsModelSelect,
        subTabSwitch,
        lineModelSelect,
        lineMetricSwitch,
        fitModelSelect,
        fitMetricSwitch,
        stepsScroll,
        modelsScroll,
        refreshStepTableViewport,
      },
    };
  },
});
return { StepsDetailView };
})();

// --- src/views/SettingsView.js ---
const { SHOW_ACCOUNT_TAB, SettingsView } = (() => {
/**
 * @fileoverview View 4: Modular preferences ("常规" / "结构" / "账号" / "其他").
 * Orchestrates the four preference tabs
 * with top sub-navigation and a shared `CustomScrollbar` viewport.
 */


const SHOW_ACCOUNT_TAB = false;

function getSettingsSubTabOptions() {
  return [
    { value: 'general', label: t('settings.subTab.general') },
    { value: 'structure', label: t('settings.subTab.structure') },
    ...(SHOW_ACCOUNT_TAB ? [{ value: 'account', label: t('settings.subTab.account') }] : []),
    { value: 'other', label: t('settings.subTab.other') },
  ];
}

const SettingsView = defineComponent({
  name: 'SettingsView',
  setup({ onCleanup }) {
    const initialSubTab = uiStore.getState().settingsSubTab || 'general';

    const subNavSwitch = SegmentedControl({
      ariaLabel: t('settings.subTab.aria'),
      modelValue: initialSubTab,
      options: getSettingsSubTabOptions(),
      onUpdateModelValue: (nextSubTab) => {
        uiStore.setState({ settingsSubTab: nextSubTab }, { sync: true });
      },
    });

    const subNavBar = h('div', { className: 'settings-subnav-bar' }, [subNavSwitch.el]);

    let viewScrollbar = null;
    const refreshScroll = () => {
      if (viewScrollbar) {
        viewScrollbar.refresh();
      }
    };

    const generalTab = SettingsGeneralTab({ onLayoutChange: refreshScroll });
    const structureTab = SettingsStructureTab({ onLayoutChange: refreshScroll });
    const accountTab = null; // SettingsAccountTab kept in src/views/settings/ for future opt-in
    const otherTab = SettingsOtherTab({ onLayoutChange: refreshScroll });

    let showingAccount = false;
    function applyActiveSubTab(subTab, activeView) {
      const target =
        subTab === 'structure' ||
        subTab === 'other' ||
        (accountTab && subTab === 'account')
          ? subTab
          : 'general';
      subNavSwitch.setValue(target);
      patchAttr(generalTab.el, 'hidden', target !== 'general');
      patchAttr(structureTab.el, 'hidden', target !== 'structure');
      patchAttr(structureTab.refs.thirdNavBar, 'hidden', target !== 'structure');
      patchAttr(otherTab.el, 'hidden', target !== 'other');
      if (accountTab) {
        patchAttr(accountTab.el, 'hidden', target !== 'account');
        const nextShowingAccount = target === 'account' && activeView === 'settings';
        if (nextShowingAccount && !showingAccount) void accountTab.refs.load();
        showingAccount = nextShowingAccount;
      }
      refreshScroll();
    }

    const contentContainer = h(
      'div',
      {},
      accountTab
        ? [generalTab.el, structureTab.el, accountTab.el, otherTab.el]
        : [generalTab.el, structureTab.el, otherTab.el]
    );
    viewScrollbar = CustomScrollbar({
      contentEl: contentContainer,
      className: 'view-pane',
    });

    applyActiveSubTab(initialSubTab, uiStore.getState().activeView);

    const rootEl = h('div', { className: 'settings-view-root' }, [
      subNavBar,
      structureTab.refs.thirdNavBar,
      viewScrollbar.el,
    ]);

    function syncActiveTab() {
      const ui = uiStore.getState();
      const { settingsSubTab } = ui;
      if (getVisibleMonitorView(ui) !== 'settings') return;
      const telemetry = telemetryStore.getState().telemetry;
      const settings = telemetry?.settings;
      if (settingsSubTab === 'structure') {
        if (settings) {
          structureTab.refs.renderSettings(
            settings,
            telemetry?.windowBridge,
            telemetry?.hostPlatform
          );
        }
      } else if (settingsSubTab === 'other') {
        if (settings) {
          otherTab.refs.renderSettings(
            settings,
            telemetry.contextWindowModels || [],
            telemetry?.windowBridge,
            telemetry?.hostPlatform
          );
        }
      } else if (accountTab && settingsSubTab === 'account') {
        accountTab.refs.renderAccount(telemetry?.account, telemetry?.quotas);
      } else {
        if (settings) generalTab.refs.renderSettings(settings);
        if (telemetry?.cloudStatus) generalTab.refs.renderCloudStatus(telemetry.cloudStatus);
      }
      refreshScroll();
    }

    const unsubTelemetry = telemetryStore.subscribe(
      (st) => ({
        settings: st.telemetry?.settings,
        windowBridge: st.telemetry?.windowBridge,
        hostPlatform: st.telemetry?.hostPlatform,
        cloudStatus: st.telemetry?.cloudStatus,
        contextWindowModels: st.telemetry?.contextWindowModels,
        account: st.telemetry?.account,
        quotas: st.telemetry?.quotas,
      }),
      syncActiveTab
    );

    const unsubUi = uiStore.subscribe(
      (st) => ({
        activeView: getVisibleMonitorView(st),
        settingsSubTab: st.settingsSubTab,
      }),
      (slice) => {
        applyActiveSubTab(slice.settingsSubTab, slice.activeView);
        syncActiveTab();
      }
    );

    const unsubI18n = i18nStore.subscribe(
      (st) => st.locale,
      () => {
        subNavSwitch.setProps({
          modelValue: uiStore.getState().settingsSubTab || 'general',
          options: getSettingsSubTabOptions(),
        });
        generalTab.refs.refreshLabels();
        structureTab.refs.refreshLabels();
        accountTab?.refs.refreshLabels();
        otherTab.refs.refreshLabels();
        refreshScroll();
      }
    );

    onCleanup(() => {
      unsubTelemetry();
      unsubUi();
      unsubI18n();
      subNavSwitch.destroy();
      generalTab.destroy();
      structureTab.destroy();
      accountTab?.destroy();
      otherTab.destroy();
      viewScrollbar.destroy();
    });

    return {
      el: rootEl,
      refs: {
        subNavSwitch,
        generalTab,
        structureTab,
        accountTab,
        otherTab,
        viewScrollbar,
        // Convenience aliases for external callers / tests
        windowMountSelect: structureTab.refs.windowMountSelect,
        multiSessionToggle: structureTab.refs.multiSessionToggle,
        topbarSlotsList: structureTab.refs.topbarSlotsList,
        stepModelSelect: otherTab.refs.stepModelSelect,
        orchestratorIdSelect: otherTab.refs.orchestratorIdSelect,
        autoUpdateSelect: generalTab.refs.autoUpdateSelect,
      },
    };
  },
});
return { SHOW_ACCOUNT_TAB, SettingsView };
})();

// --- src/App.js ---
const { App } = (() => {
/**
 * @fileoverview Root Application Shell (App.js).
 * Combines the compact dual-layer header (TopSessionHeader + TopLongPillNav)
 * and single-viewport functional views.
 */


const App = defineComponent({
  name: 'App',
  setup({ onCleanup }) {
    const sessionHeader = TopSessionHeader();
    const topPillNav = TopLongPillNav({
      modelValue: uiStore.getState().activeView,
      items: getViewTabs(),
      onUpdateModelValue: (nextView) => {
        uiStore.setState({ activeView: nextView });
      },
    });

    const overviewView = LiveOverviewView();
    const consumptionView = ConsumptionView();
    const stepsView = StepsDetailView();
    const settingsView = SettingsView();

    const globalBridgeNotice = BridgeStatusNotice({
      dismissible: true,
    });
    const bannerSlotEl = h('div', { className: 'app-bridge-banner-slot', hidden: true }, [
      globalBridgeNotice.el,
    ]);

    function syncGlobalBridgeBanner() {
      const activeView = uiStore.getState().activeView;
      const telemetry = telemetryStore.getState().telemetry;
      const settings = telemetry?.settings;
      const mountMode = settings
        ? normalizeClientWindowMountMode(settings.windowMountMode, settings.enableWindowOverlay)
        : 'sidebar';
      const hasCtxOverrides = Boolean(
        settings?.modelContextWindows && Object.keys(settings.modelContextWindows).length > 0
      );
      const shouldOfferGlobal =
        !isWindowOverlayMode() &&
        activeView !== 'settings' &&
        (mountMode !== 'sidebar' || hasCtxOverrides);
      globalBridgeNotice.refs.update({
        visible: shouldOfferGlobal,
        contextMode: mountMode === 'sidebar' && hasCtxOverrides,
        windowBridge: telemetry?.windowBridge || null,
        hostPlatform: telemetry?.hostPlatform || 'win32',
      });
      patchAttr(bannerSlotEl, 'hidden', globalBridgeNotice.el.hasAttribute('hidden'));
    }

    const viewMap = {
      overview: overviewView.el,
      consumption: consumptionView.el,
      steps: stepsView.el,
      settings: settingsView.el,
    };

    const stageEl = h('div', { className: 'viewport-stage' }, [
      overviewView.el,
      consumptionView.el,
      stepsView.el,
      settingsView.el,
    ]);

    const shellEl = h('main', { className: 'app-shell' }, [
      h('div', { className: 'top-deck' }, [sessionHeader.el, topPillNav.el]),
      bannerSlotEl,
      stageEl,
    ]);

    function syncStepsBadge() {
      const uiSt = uiStore.getState();
      const scopeForBadge = uiSt.activeView === 'steps' ? uiSt.selectedAgentScope : 'all';
      const { scopedConv } = resolveScopedConversation(
        telemetryStore.getState().telemetry,
        scopeForBadge,
        uiSt.ctxInspectorAgentId
      );
      const stepCount = scopedConv?.stepCount ?? 0;
      topPillNav.setProps({
        items: getViewTabs().map((tabItem) =>
          tabItem.value === 'steps'
            ? { ...tabItem, badge: stepCount > 0 ? stepCount : '' }
            : tabItem
        ),
      });
    }

    const unsubUi = uiStore.subscribe(
      (st) => st.activeView,
      (activeView) => {
        topPillNav.setValue(activeView);
        for (const [key, paneEl] of Object.entries(viewMap)) {
          patchAttr(paneEl, 'hidden', key !== activeView);
        }
        if (activeView === 'overview') {
          overviewView.refs?.viewScrollbar?.refresh();
        } else if (activeView === 'consumption') {
          consumptionView.refs?.viewScrollbar?.refresh();
        } else if (activeView === 'steps') {
          stepsView.refs?.refreshStepTableViewport?.();
          stepsView.refs?.stepsScroll?.refresh();
          stepsView.refs?.modelsScroll?.refresh();
        } else if (activeView === 'settings') {
          settingsView.refs?.viewScrollbar?.refresh();
        }
        syncStepsBadge();
        syncGlobalBridgeBanner();
      }
    );

    const unsubStepCount = telemetryStore.subscribe(
      (st) => ({
        stepCount: st.telemetry?.activeConversation?.stepCount ?? 0,
        totalStepsAllAgents: st.telemetry?.activeConversation?.totalStepsAllAgents ?? 0,
        subagentCount: st.telemetry?.activeConversation?.subagentCount ?? 0,
        windowMountMode: st.telemetry?.settings?.windowMountMode,
        enableWindowOverlay: st.telemetry?.settings?.enableWindowOverlay,
        modelContextWindows: st.telemetry?.settings?.modelContextWindows,
        windowBridge: st.telemetry?.windowBridge,
        hostPlatform: st.telemetry?.hostPlatform,
      }),
      () => {
        syncStepsBadge();
        syncGlobalBridgeBanner();
      }
    );

    const unsubScopeBadge = uiStore.subscribe(
      (st) => st.selectedAgentScope,
      () => syncStepsBadge()
    );

    const unsubI18n = i18nStore.subscribe(
      (st) => st.locale,
      () => {
        syncStepsBadge();
        globalBridgeNotice.refs.refreshLabels();
        patchAttr(bannerSlotEl, 'hidden', globalBridgeNotice.el.hasAttribute('hidden'));
      }
    );

    onCleanup(() => {
      unsubUi();
      unsubStepCount();
      unsubScopeBadge();
      unsubI18n();
      globalBridgeNotice.destroy();
      sessionHeader.destroy();
      topPillNav.destroy();
      overviewView.destroy();
      consumptionView.destroy();
      stepsView.destroy();
      settingsView.destroy();
    });

    return {
      el: shellEl,
      refs: {
        sessionHeader,
        topPillNav,
        globalBridgeNotice,
        overviewView,
        consumptionView,
        stepsView,
        settingsView,
      },
    };
  },
});
return { App };
})();

// --- src/components/layout/WindowOverlayShell.js ---
const { computeCapsuleLayoutMode, mountWindowOverlay } = (() => {
/**
 * @fileoverview 主窗口双栖挂载外壳 (WindowOverlayShell.js).
 *
 * 采用「分离式双 Shadow Host」架构，彻底规避宿主顶栏层叠上下文 (`z-0` / `overflow: hidden`) 裁切与路由重绘卸载问题：
 * 1. `#ag-usage-monitor-capsule`：轻量顶栏胶囊，优先内嵌停靠至 `[class*="@container/titlebar"]` 右侧按钮组，
 *    支持四级迟滞宽度自适应折叠（`wide` -> `compact` -> `minimal` -> `ring-only`），找不到顶栏时自动回退至右上角固定定位；
 * 2. `#ag-usage-monitor-portal`：常驻 `document.body` 顶层的无遮挡浮层宿主，承载悬停速览卡与完整四标签 `App()` 监控面板，
 *    在宿主切换会话重建顶栏 DOM 时始终保持组件实例、滚动位置与动画状态不丢失。
 */


const CAPSULE_HOST_ID = 'ag-usage-monitor-capsule';
const PORTAL_HOST_ID = 'ag-usage-monitor-portal';
const FLOATING_CARD_WIDTH = 522;
const POPOVER_BASE_WIDTH = 540;
const POPOVER_MAX_AUTO_WIDTH = 960;
const MULTI_PANEL_WIDTH = 464;

/**
 * 带迟滞区间（Hysteresis）的四阶段顶栏双胶囊响应式宽度计算，避免临界宽度反复跳动。
 * 当左侧多会话入口关闭（`showMulti === false`）时自动释放约 76px 预算给右侧指标胶囊；
 * 当槽位数超过 3 个（4..5 槽）时自动按槽位增量上浮 `wide` 阈值。
 *
 * @param {number} availWidth
 * @param {'wide'|'compact'|'minimal'|'ring-only'} currentMode
 * @param {{ showMulti?: boolean, hasUpdate?: boolean, slotCount?: number }} [options]
 * @returns {'wide'|'compact'|'minimal'|'ring-only'}
 */
function computeCapsuleLayoutMode(availWidth, currentMode = 'wide', options = undefined) {
  if (availWidth == null || Number.isNaN(availWidth)) return 'wide';
  const showMulti = options?.showMulti !== false;
  const updateReserve = options?.hasUpdate ? 52 : 0;
  const slotCount = Number(options?.slotCount || 3);
  const extraSlotWidth = slotCount > 3 ? (slotCount - 3) * 58 : 0;
  const wideKeep = 256 + extraSlotWidth;
  const wideEnter = 272 + extraSlotWidth;
  const baseEffWidth = showMulti ? availWidth : availWidth + 76;
  const effWidth = baseEffWidth - updateReserve;
  if (currentMode === 'wide') {
    if (baseEffWidth < 78) return 'ring-only';
    if (effWidth < 196) return 'minimal';
    if (effWidth < wideKeep) return 'compact';
    return 'wide';
  }
  if (currentMode === 'compact') {
    if (effWidth >= wideEnter) return 'wide';
    if (baseEffWidth < 78) return 'ring-only';
    if (effWidth < 196) return 'minimal';
    return 'compact';
  }
  if (currentMode === 'minimal') {
    if (effWidth >= wideEnter) return 'wide';
    if (effWidth >= 212) return 'compact';
    if (baseEffWidth < 78) return 'ring-only';
    return 'minimal';
  }
  if (effWidth >= wideEnter) return 'wide';
  if (effWidth >= 212) return 'compact';
  if (baseEffWidth >= 92) return 'minimal';
  return 'ring-only';
}

function findIdeWorkbenchTitlebar() {
  try {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
      return null;
    }
    const workbench = document.querySelector('.monaco-workbench');
    if (!workbench?.querySelector) return null;
    const partTitlebar = workbench.querySelector('.part.titlebar');
    if (!partTitlebar?.querySelector) return null;
    if (partTitlebar.getBoundingClientRect) {
      const pr = partTitlebar.getBoundingClientRect();
      if (pr.width <= 0 || pr.height <= 0) return null;
    }
    const container =
      partTitlebar.querySelector(':scope > .titlebar-container') ||
      partTitlebar.querySelector('.titlebar-container');
    const rightGroup =
      container?.querySelector?.(':scope > .titlebar-right') ||
      container?.querySelector?.('.titlebar-right');
    if (!container || !rightGroup) return null;
    const actionToolbar =
      rightGroup.querySelector?.(':scope > .action-toolbar-container') ||
      rightGroup.querySelector?.('.action-toolbar-container') ||
      null;
    return {
      kind: 'ide-titlebar',
      workbench,
      titlebar: container,
      targetContainer: rightGroup,
      actionToolbar,
    };
  } catch {
    return null;
  }
}

function findHostTitlebar() {
  try {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
      return null;
    }
    const tb = document.querySelector('[class*="@container/titlebar"]');
    if (tb?.getBoundingClientRect) {
      const r = tb.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
    }
    return tb;
  } catch {
    return null;
  }
}

const COMPOSER_EXCLUDED_ANCESTOR_SELECTOR =
  '.part.titlebar, .part.statusbar, .quick-input-widget, .suggest-widget, .find-widget, .scm-editor, .search-view, [class*="@container/titlebar"]';
const COMPOSER_MODEL_LABEL_RE =
  /\b(?:gemini|claude|gpt|argon|carbon|hydrogen|helix|flash|sonnet|opus|haiku|orchestrator|llama|deepseek|qwen|mistral|model_placeholder|placeholder_m\d+|o[134](?:-\w+)?)\b/i;
const COMPOSER_MODEL_ATTR_RE =
  /\bmodel[-_\s]?(?:select|picker|switch|selector|menu|name)\b|选择模型|切换模型/i;
const COMPOSER_MODE_EXACT_RE = /^(?:auto|自动)$/i;
const COMPOSER_MODE_TEXT_RE =
  /^(?:auto|ask|manual|supervised|autonomous|always\s*allow|turbo|safe|yolo|plan|act|review|confirm|normal|fast|自动|询问|手动|始终允许|受控|规划)(?:\s*(?:mode|模式))?$/i;
const COMPOSER_MODE_ATTR_RE =
  /\b(?:auto(?:nomy|matic)?|execution[-_]?mode|agent[-_]?mode|permission|approval|hitl|policy|mode[-_]?selector|mode[-_]?picker)\b|自动|执行模式|权限模式|审批/i;
const COMPOSER_ICON_FONT_CLASS_RE =
  /\b(?:codicon|material-symbols(?:-\w+)?|material-icons(?:-\w+)?|lucide(?:-\w+)?)\b/i;

function querySimpleSelectorList(root, selectors) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  const seen = new Set();
  const out = [];
  for (const sel of selectors) {
    let list = [];
    try {
      list = root.querySelectorAll(sel) || [];
    } catch {
      list = [];
    }
    for (const item of list) {
      if (item && !seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
    }
  }
  return out;
}

function extractVisibleButtonText(node, isRoot = true) {
  if (!node) return '';
  const tag = String(node.tagName || node.nodeName || '').toLowerCase();
  if (tag === 'svg' || tag === 'style' || tag === 'script') return '';
  if (!isRoot) {
    if (node.getAttribute?.('aria-hidden') === 'true') return '';
    const cls = String(node.className || '');
    if (cls && COMPOSER_ICON_FONT_CLASS_RE.test(cls)) return '';
  }
  if (tag === '#text' || node.nodeType === 3) {
    return String(node.nodeValue ?? node.textContent ?? '');
  }
  const childNodes = node.childNodes || node.children;
  if (!childNodes || childNodes.length === 0) {
    return String(node.textContent || '');
  }
  let acc = '';
  for (const ch of childNodes) {
    acc += ` ${extractVisibleButtonText(ch, false)}`;
  }
  return acc;
}

function cleanComposerButtonText(btn) {
  const raw = extractVisibleButtonText(btn, true)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return '';
  return raw.replace(/^[⌃⌄▾▴∨∧^<>›‹+\s]+|[⌃⌄▾▴∨∧^<>›‹\s]+$/g, '').trim();
}

function isComposerModelButtonItem(item) {
  if (!item) return false;
  if (item.cleanText && COMPOSER_MODEL_LABEL_RE.test(item.cleanText)) return true;
  if (item.attrText && COMPOSER_MODEL_ATTR_RE.test(item.attrText)) return true;
  return false;
}

function hasExcludedComposerAncestor(el) {
  if (!el) return false;
  if (typeof el.closest === 'function') {
    try {
      if (el.closest(COMPOSER_EXCLUDED_ANCESTOR_SELECTOR)) return true;
    } catch {
      // 忽略选择器异常并回退祖先链遍历
    }
  }
  let cur = el.parentElement || el.parentNode;
  while (cur) {
    const cls = String(cur.className || '');
    if (
      cls.includes('@container/titlebar') ||
      cls.includes('quick-input-widget') ||
      cls.includes('suggest-widget') ||
      cls.includes('find-widget') ||
      cls.includes('scm-editor') ||
      cls.includes('search-view') ||
      (cls.includes('part') && (cls.includes('titlebar') || cls.includes('statusbar')))
    ) {
      return true;
    }
    cur = cur.parentElement || cur.parentNode;
  }
  return false;
}

function isNodeHiddenByStyle(el) {
  if (!el) return true;
  if (el.hasAttribute?.('hidden') || el.getAttribute?.('aria-hidden') === 'true') return true;
  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try {
      const cs = window.getComputedStyle(el);
      if (cs?.display === 'none' || cs?.visibility === 'hidden') return true;
    } catch {
      // 忽略样式读取异常
    }
  }
  return false;
}

function getInFlowHostChildren(container, capsuleNode, portalNode) {
  const rawChildren = container?.children || [];
  const out = [];
  for (const ch of rawChildren) {
    if (!ch || ch === capsuleNode || ch === portalNode) continue;
    if (ch.id === CAPSULE_HOST_ID || ch.id === PORTAL_HOST_ID) continue;
    if (ch.hasAttribute?.('hidden')) continue;
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      try {
        const cs = window.getComputedStyle(ch);
        if (cs?.display === 'none') continue;
        if (cs?.position === 'absolute' || cs?.position === 'fixed') continue;
      } catch {
        // 忽略计算样式异常
      }
    }
    out.push(ch);
  }
  return out;
}

function isHorizontalFlexContainer(el) {
  if (!el) return false;
  const cls = String(el.className || '');
  if (/\b(?:inline-)?flex\b/.test(cls) && !/\bflex-col\b/.test(cls)) return true;
  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try {
      const cs = window.getComputedStyle(el);
      const disp = String(cs?.display || '');
      const dir = String(cs?.flexDirection || 'row');
      if (disp.includes('flex') && !dir.startsWith('column')) return true;
    } catch {
      // 忽略计算样式异常
    }
  }
  return false;
}

function isSpaceDistributedFlexContainer(el) {
  if (!el) return false;
  const cls = String(el.className || '');
  if (/\bjustify-(?:between|around|evenly)\b/.test(cls)) return true;
  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try {
      const jc = String(window.getComputedStyle(el)?.justifyContent || '');
      if (jc.includes('space-between') || jc.includes('space-around') || jc.includes('space-evenly')) {
        return true;
      }
    } catch {
      // 忽略计算样式异常
    }
  }
  return false;
}

function buildComposerDockDescriptor(autoBtn, composerCard, bottomRowBtns, capsuleNode, portalNode, patchedNode) {
  if (!autoBtn || !composerCard) return null;
  let item = autoBtn;
  while (
    (item.parentElement || item.parentNode) &&
    (item.parentElement || item.parentNode) !== composerCard &&
    (item.parentElement || item.parentNode) !== document.body
  ) {
    const parent = item.parentElement || item.parentNode;
    const hostSiblings = getInFlowHostChildren(parent, capsuleNode, portalNode);
    if (hostSiblings.length >= 2) break;
    const grandParent = parent.parentElement || parent.parentNode;
    const parentCls = String(parent.className || '');
    const parentInlineMl = String(parent.style?.marginLeft || '').trim();
    const isSingleClusterInSplitRow =
      !/\b(?:relative|ml-auto|ms-auto)\b/.test(parentCls) &&
      parentInlineMl !== 'auto' &&
      isHorizontalFlexContainer(parent) &&
      grandParent &&
      isSpaceDistributedFlexContainer(grandParent) &&
      getInFlowHostChildren(grandParent, capsuleNode, portalNode).length >= 2;
    if (isSingleClusterInSplitRow) {
      break;
    }
    item = parent;
  }

  const anchorNode = item;
  const targetContainer = anchorNode.parentElement || anchorNode.parentNode;
  if (!targetContainer) return null;

  const hostChildren = getInFlowHostChildren(targetContainer, capsuleNode, portalNode);
  const anchorIdx = hostChildren.indexOf(anchorNode);
  const isFirstHostChild = anchorIdx <= 0;

  let needsAutoMarginTransfer = false;
  let patchMarginNode = null;

  if (!isFirstHostChild) {
    const cls = String(anchorNode.className || '');
    const inlineMl = String(anchorNode.style?.marginLeft || '').trim();
    let computedLargeMl = false;
    if (
      patchedNode !== anchorNode &&
      typeof window !== 'undefined' &&
      typeof window.getComputedStyle === 'function'
    ) {
      try {
        const mlPx = parseFloat(window.getComputedStyle(anchorNode)?.marginLeft) || 0;
        const prevSib = hostChildren[anchorIdx - 1];
        const aRect = anchorNode.getBoundingClientRect?.();
        const pRect = prevSib?.getBoundingClientRect?.();
        if (mlPx > 24 && aRect && pRect && aRect.left - pRect.right >= mlPx - 6) {
          computedLargeMl = true;
        }
      } catch {
        // 忽略边距测量异常
      }
    }

    if (
      /\b(?:ml-auto|ms-auto)\b/.test(cls) ||
      inlineMl === 'auto' ||
      patchedNode === anchorNode ||
      computedLargeMl
    ) {
      needsAutoMarginTransfer = true;
      patchMarginNode = anchorNode;
    } else if (isSpaceDistributedFlexContainer(targetContainer)) {
      needsAutoMarginTransfer = true;
    }
  }

  const autoRect = anchorNode.getBoundingClientRect?.() || autoBtn.getBoundingClientRect?.();
  let leftClusterRightEdge = 0;
  if (autoRect && Array.isArray(bottomRowBtns)) {
    for (const entry of bottomRowBtns) {
      if (entry.btn === autoBtn || anchorNode.contains?.(entry.btn)) continue;
      if (entry.rect.left < autoRect.left - 2 && entry.rect.right <= autoRect.left + 4) {
        if (entry.rect.right > leftClusterRightEdge) {
          leftClusterRightEdge = entry.rect.right;
        }
      }
    }
  }

  return {
    kind: 'composer',
    workbench: null,
    titlebar: composerCard,
    targetContainer,
    actionToolbar: patchMarginNode,
    anchorNode,
    needsAutoMarginTransfer,
    leftClusterRightEdge,
  };
}

function buildComposerRightEndDockDescriptor(
  leftAnchorBtn,
  composerCard,
  bottomRowBtns,
  capsuleNode,
  portalNode
) {
  if (!leftAnchorBtn || !composerCard) return null;
  const cardRect = composerCard.getBoundingClientRect?.();
  const minRowWidth = cardRect && cardRect.width > 0 ? cardRect.width * 0.65 : 180;
  let toolbarRow = null;
  let cur = leftAnchorBtn.parentElement || leftAnchorBtn.parentNode;
  for (let d = 0; d < 8 && cur && cur !== composerCard && cur !== document.body; d += 1) {
    const r = cur.getBoundingClientRect?.();
    if (r && r.width >= minRowWidth && r.height > 0 && r.height <= 60 && isHorizontalFlexContainer(cur)) {
      toolbarRow = cur;
      break;
    }
    cur = cur.parentElement || cur.parentNode;
  }
  if (!toolbarRow) {
    const p = leftAnchorBtn.parentElement || leftAnchorBtn.parentNode;
    if (!p || !isHorizontalFlexContainer(p)) return null;
    toolbarRow = p;
  }

  let leftClusterRightEdge = 0;
  if (Array.isArray(bottomRowBtns)) {
    for (const entry of bottomRowBtns) {
      if (entry?.rect?.right > leftClusterRightEdge) {
        leftClusterRightEdge = entry.rect.right;
      }
    }
  }

  const rowChildren = getInFlowHostChildren(toolbarRow, capsuleNode, portalNode);
  const lastChild = rowChildren.length >= 2 ? rowChildren[rowChildren.length - 1] : null;
  if (
    lastChild &&
    !lastChild.contains?.(leftAnchorBtn) &&
    isHorizontalFlexContainer(lastChild) &&
    getInFlowHostChildren(lastChild, capsuleNode, portalNode).length === 0
  ) {
    return {
      kind: 'composer',
      workbench: null,
      titlebar: composerCard,
      targetContainer: lastChild,
      actionToolbar: null,
      anchorNode: null,
      needsAutoMarginTransfer: false,
      leftClusterRightEdge,
    };
  }

  return {
    kind: 'composer',
    workbench: null,
    titlebar: composerCard,
    targetContainer: toolbarRow,
    actionToolbar: null,
    anchorNode: null,
    needsAutoMarginTransfer: true,
    leftClusterRightEdge,
  };
}

function collectComposerBottomButtons(container, editorEl, editorRect, capsuleNode, portalNode) {
  const rawBtns = querySimpleSelectorList(container, ['button', '[role="button"]', '[aria-haspopup]']);
  const hostBtns = [];
  for (const btn of rawBtns) {
    if (!btn || btn === editorEl || editorEl?.contains?.(btn)) continue;
    if (editorEl && btn.contains?.(editorEl)) continue;
    if (
      btn.id === CAPSULE_HOST_ID ||
      btn.id === PORTAL_HOST_ID ||
      capsuleNode?.contains?.(btn) ||
      portalNode?.contains?.(btn)
    ) {
      continue;
    }
    if (isNodeHiddenByStyle(btn)) continue;
    // 仅排除嵌套在真实紧凑按钮内部的图标/子触发器，避免外层卡片级 role="button" 误杀工具栏按钮
    let nestedInBtn = false;
    let p = btn.parentElement || btn.parentNode;
    while (p && p !== container) {
      const pTag = String(p.tagName || '').toLowerCase();
      if (pTag === 'button') {
        nestedInBtn = true;
        break;
      }
      if (
        (p.getAttribute?.('role') === 'button' || p.hasAttribute?.('aria-haspopup')) &&
        !(editorEl && p.contains?.(editorEl))
      ) {
        const pr = p.getBoundingClientRect?.();
        if (pr && pr.height > 0 && pr.height <= 48 && pr.width > 0 && pr.width <= 360) {
          nestedInBtn = true;
          break;
        }
      }
      p = p.parentElement || p.parentNode;
    }
    if (nestedInBtn) continue;

    const br = btn.getBoundingClientRect?.();
    if (!br || br.width <= 0 || br.height <= 0 || br.height > 48) continue;
    const centerY = (br.top + br.bottom) / 2;
    if (editorRect && centerY < editorRect.top - 4) continue;
    hostBtns.push({
      btn,
      rect: br,
      centerY,
      centerX: (br.left + br.right) / 2,
      cleanText: cleanComposerButtonText(btn),
      attrText: `${btn.getAttribute?.('data-testid') || ''} ${btn.getAttribute?.('aria-label') || ''} ${btn.getAttribute?.('title') || ''}`.trim(),
    });
  }
  if (hostBtns.length === 0) return [];
  let maxCenterY = -Infinity;
  for (const item of hostBtns) {
    if (item.centerY > maxCenterY) maxCenterY = item.centerY;
  }
  const bottomBand = hostBtns.filter((item) => Math.abs(item.centerY - maxCenterY) <= 22);
  bottomBand.sort((a, b) => a.rect.left - b.rect.left);
  return bottomBand;
}

function pickAutoButtonFromRow(bottomRowBtns, containerRect, options = undefined) {
  if (!Array.isArray(bottomRowBtns) || bottomRowBtns.length === 0) return null;
  const requireModelForFallback = Boolean(options?.requireModelForFallback);
  const rightSplitX = containerRect ? containerRect.left + containerRect.width * 0.35 : 0;
  const rightFirst = [
    ...bottomRowBtns.filter((b) => b.centerX >= rightSplitX),
    ...bottomRowBtns.filter((b) => b.centerX < rightSplitX),
  ];

  // Tier 1: 精确文本 Auto / 自动 匹配
  for (const item of rightFirst) {
    if (COMPOSER_MODE_EXACT_RE.test(item.cleanText)) {
      return { btn: item.btn, tier: 1 };
    }
  }

  // Tier 2: 执行/权限模式文案或无障碍语义属性匹配（排除模型选择器按钮）
  for (const item of rightFirst) {
    if (isComposerModelButtonItem(item)) continue;
    if (
      (item.cleanText && COMPOSER_MODE_TEXT_RE.test(item.cleanText)) ||
      (item.attrText && COMPOSER_MODE_ATTR_RE.test(item.attrText))
    ) {
      return { btn: item.btn, tier: 2 };
    }
  }

  const hasModelBtn = bottomRowBtns.some(isComposerModelButtonItem);

  // Tier 3: 几何右簇首按钮兜底（适配 Antigravity IDE 无 Auto 按钮、右侧为发送/语音按钮的输入栏布局）
  if (bottomRowBtns.length >= 2 && (!requireModelForFallback || hasModelBtn)) {
    let maxGap = -Infinity;
    let splitIdx = -1;
    for (let i = 1; i < bottomRowBtns.length; i += 1) {
      const gap = bottomRowBtns[i].rect.left - bottomRowBtns[i - 1].rect.right;
      if (gap > maxGap) {
        maxGap = gap;
        splitIdx = i;
      }
    }
    if (splitIdx >= 1 && maxGap >= 16) {
      return { btn: bottomRowBtns[splitIdx].btn, tier: 3 };
    }
  }

  // Tier 4: 输入为空时若右侧发送按钮暂时隐藏、仅左侧存在模型选择器按钮，停靠至工具栏最右侧
  if (hasModelBtn && containerRect && containerRect.width >= 200) {
    const lastItem = bottomRowBtns[bottomRowBtns.length - 1];
    if (lastItem.rect.right <= containerRect.left + containerRect.width * 0.72) {
      return { btn: null, leftAnchorBtn: lastItem.btn, tier: 4 };
    }
  }

  return null;
}

function resolveComposerEditorRect(ed) {
  const er = ed?.getBoundingClientRect?.();
  if (er && er.width >= 80 && er.height >= 12) return er;
  let cur = ed;
  for (let d = 0; d < 6 && cur; d += 1) {
    if (String(cur.className || '').includes('monaco-editor')) {
      const mr = cur.getBoundingClientRect?.();
      if (mr && mr.width >= 80 && mr.height >= 12) return mr;
      break;
    }
    cur = cur.parentElement || cur.parentNode;
  }
  return er || null;
}

function findHostComposerAutoTarget(capsuleNode = null, portalNode = null, patchedNode = null) {
  try {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') {
      return null;
    }
    const capEl = capsuleNode || document.getElementById?.(CAPSULE_HOST_ID) || null;
    const porEl = portalNode || document.getElementById?.(PORTAL_HOST_ID) || null;
    const activeRouteId = extractHostRouteCascadeId();

    // 1. 优先从活跃会话的输入框编辑器向上定位底部工具栏与 Auto / 右簇发送按钮
    const rawEditors = querySimpleSelectorList(document, [
      'textarea',
      '[contenteditable]',
      '[role="textbox"]',
      '[data-lexical-editor]',
      '.ProseMirror',
      '.monaco-editor',
    ]);
    const scoredEditors = [];
    for (const ed of rawEditors) {
      if (!ed || capEl?.contains?.(ed) || porEl?.contains?.(ed)) continue;
      if (ed.hasAttribute?.('contenteditable')) {
        const ce = String(ed.getAttribute('contenteditable') || '').trim().toLowerCase();
        if (ce === 'false' && ed.getAttribute?.('role') !== 'textbox') continue;
      }
      if (isNodeHiddenByStyle(ed) || hasExcludedComposerAncestor(ed)) continue;
      const er = resolveComposerEditorRect(ed);
      if (!er || er.width < 100 || er.height < 12 || er.height > 540) continue;

      let score = Math.min(1200, er.width) + Math.max(0, er.bottom) * 0.2;
      if (activeRouteId) {
        let anc = ed.parentElement || ed.parentNode;
        while (anc) {
          const cid = anc.getAttribute?.('data-cascade-id');
          if (cid) {
            score += cid === activeRouteId ? 4000 : -2000;
            break;
          }
          anc = anc.parentElement || anc.parentNode;
        }
      }
      if (
        document.activeElement &&
        (ed === document.activeElement || ed.contains?.(document.activeElement))
      ) {
        score += 1000;
      }
      scoredEditors.push({ ed, rect: er, score });
    }
    scoredEditors.sort((a, b) => b.score - a.score);

    for (const { ed, rect: er } of scoredEditors) {
      const isMonacoCandidate = String(ed.className || '').includes('monaco-editor') ||
        String(ed.className || '').includes('inputarea');
      let tier3Candidate = null;
      let tier4Candidate = null;
      let cur = ed.parentElement || ed.parentNode;
      for (let depth = 0; depth < 18 && cur; depth += 1) {
        if (cur === document.body || cur === document.documentElement) break;
        const tag = String(cur.tagName || '').toLowerCase();
        if (tag === 'main' || String(cur.className || '').includes('monaco-workbench')) break;
        const cr = cur.getBoundingClientRect?.();
        if (cr && cr.height > 680) break;
        if (cr && cr.width >= 180 && cr.height > 0) {
          const bottomRowBtns = collectComposerBottomButtons(cur, ed, er, capEl, porEl);
          const picked = pickAutoButtonFromRow(bottomRowBtns, cr, {
            requireModelForFallback: isMonacoCandidate,
          });
          if (picked) {
            if (picked.tier <= 2) {
              const desc = buildComposerDockDescriptor(
                picked.btn,
                cur,
                bottomRowBtns,
                capEl,
                porEl,
                patchedNode
              );
              if (desc) return desc;
            } else if (picked.tier === 3 && !tier3Candidate) {
              tier3Candidate = { btn: picked.btn, card: cur, bottomRowBtns };
            } else if (picked.tier === 4 && !tier4Candidate) {
              tier4Candidate = { leftAnchorBtn: picked.leftAnchorBtn, card: cur, bottomRowBtns };
            }
          }
        }
        cur = cur.parentElement || cur.parentNode;
      }
      if (tier3Candidate) {
        const desc = buildComposerDockDescriptor(
          tier3Candidate.btn,
          tier3Candidate.card,
          tier3Candidate.bottomRowBtns,
          capEl,
          porEl,
          patchedNode
        );
        if (desc) return desc;
      }
      if (tier4Candidate) {
        const desc = buildComposerRightEndDockDescriptor(
          tier4Candidate.leftAnchorBtn,
          tier4Candidate.card,
          tier4Candidate.bottomRowBtns,
          capEl,
          porEl
        );
        if (desc) return desc;
      }
    }

    // 2. 兜底路径：编辑器自定义封装或暂时只读时，直接扫描底部包含模型选择器或 Auto 按钮的输入工具栏
    const vh = Number(window.innerHeight || 800);
    const allBtns = querySimpleSelectorList(document, ['button', '[role="button"]', '[aria-haspopup]']);
    let modelToolbarFallback = null;
    for (const btn of allBtns) {
      if (!btn || capEl?.contains?.(btn) || porEl?.contains?.(btn)) continue;
      if (isNodeHiddenByStyle(btn) || hasExcludedComposerAncestor(btn)) continue;
      const br = btn.getBoundingClientRect?.();
      if (!br || br.width <= 0 || br.height <= 0 || br.height > 48 || br.top < vh * 0.2) continue;
      const clean = cleanComposerButtonText(btn);
      const attr = `${btn.getAttribute?.('data-testid') || ''} ${btn.getAttribute?.('aria-label') || ''} ${btn.getAttribute?.('title') || ''}`.trim();
      const itemProbe = { cleanText: clean, attrText: attr };
      const isModeBtn =
        COMPOSER_MODE_EXACT_RE.test(clean) ||
        (!isComposerModelButtonItem(itemProbe) &&
          ((clean && COMPOSER_MODE_TEXT_RE.test(clean)) || (attr && COMPOSER_MODE_ATTR_RE.test(attr))));
      const isModelBtn = isComposerModelButtonItem(itemProbe);
      if (!isModeBtn && !isModelBtn) continue;

      let cur = btn.parentElement || btn.parentNode;
      for (let depth = 0; depth < 12 && cur; depth += 1) {
        if (cur === document.body || cur === document.documentElement) break;
        if (String(cur.className || '').includes('monaco-workbench')) break;
        const cr = cur.getBoundingClientRect?.();
        if (!cr || cr.height > 560) break;
        if (cr.width >= 200) {
          const rowBtns = collectComposerBottomButtons(cur, null, null, capEl, porEl);
          if (isModeBtn) {
            const hasModelSibling = rowBtns.some((b) => b.btn !== btn && isComposerModelButtonItem(b));
            if (hasModelSibling) {
              const desc = buildComposerDockDescriptor(btn, cur, rowBtns, capEl, porEl, patchedNode);
              if (desc) return desc;
            }
          } else if (isModelBtn && !modelToolbarFallback) {
            const picked = pickAutoButtonFromRow(rowBtns, cr, { requireModelForFallback: true });
            if (picked) {
              const desc =
                picked.tier <= 3 && picked.btn
                  ? buildComposerDockDescriptor(picked.btn, cur, rowBtns, capEl, porEl, patchedNode)
                  : picked.tier === 4 && picked.leftAnchorBtn
                    ? buildComposerRightEndDockDescriptor(
                        picked.leftAnchorBtn,
                        cur,
                        rowBtns,
                        capEl,
                        porEl
                      )
                    : null;
              if (desc) {
                if (picked.tier <= 2) return desc;
                modelToolbarFallback = desc;
                break;
              }
            }
          }
        }
        cur = cur.parentElement || cur.parentNode;
      }
    }
    if (modelToolbarFallback) return modelToolbarFallback;
  } catch {
    // 忽略输入框探测异常
  }
  return null;
}

function isImmediatelyBeforeNode(node, refNode) {
  if (!node || !refNode) return false;
  if (node.nextElementSibling !== undefined) {
    return node.nextElementSibling === refNode;
  }
  if (node.nextSibling !== undefined) {
    return node.nextSibling === refNode;
  }
  const parent = node.parentElement || node.parentNode;
  if (!parent?.children) return false;
  const idx = Array.prototype.indexOf.call(parent.children, node);
  return idx >= 0 && parent.children[idx + 1] === refNode;
}

function isIdeExtensionChatFrame() {
  try {
    if (typeof window === 'undefined') return false;
    if (readInjectedWindowBridge()?.isIdeChatFrame === true) return true;
    return /[?&]extension(?:View|Variant)=/i.test(String(window.location?.search || ''));
  } catch {
    return false;
  }
}

function resolveActiveDockTarget(options = undefined) {
  const settings = telemetryStore.getState().telemetry?.settings;
  const rawMode =
    settings?.windowMountMode ??
    readInjectedWindowBridge()?.mountMode;
  const mountMode =
    options?.mountMode ||
    normalizeClientWindowMountMode(rawMode, settings?.enableWindowOverlay);
  if (isIdeExtensionChatFrame()) {
    if (mountMode !== 'composer') return null;
    return findHostComposerAutoTarget(
      options?.capsuleNode || null,
      options?.portalNode || null,
      options?.patchedNode || null
    );
  }
  if (mountMode === 'composer') {
    const composerTarget = findHostComposerAutoTarget(
      options?.capsuleNode || null,
      options?.portalNode || null,
      options?.patchedNode || null
    );
    if (composerTarget) return composerTarget;
  }
  const ideTarget = findIdeWorkbenchTitlebar();
  if (ideTarget) return ideTarget;
  const titlebar = findHostTitlebar();
  if (!titlebar) return null;
  let targetContainer = titlebar;
  try {
    const rightGroup = titlebar.querySelector(':scope > div.shrink-0') || titlebar.lastElementChild;
    if (rightGroup && rightGroup !== titlebar.firstElementChild) {
      targetContainer = rightGroup;
    }
  } catch {
    // 忽略子选择器不兼容场景
  }
  return {
    kind: 'flow',
    workbench: null,
    titlebar,
    targetContainer,
    actionToolbar: null,
  };
}

function findNativeTopRightAnchor() {
  try {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
      return null;
    }
    const auxToggle = document.querySelector('[data-testid="toggle-aux-sidebar"]');
    if (auxToggle?.closest) {
      return auxToggle.closest('div.absolute.right-0.top-0') || auxToggle;
    }
    const candidates = document.querySelectorAll('button, a, [role="button"]');
    for (const btn of candidates) {
      const text = String(btn.textContent || '').trim();
      if (
        (text === 'Open IDE' || text === '打开 IDE' || text.includes('Open IDE') || text.includes('打开 IDE')) &&
        btn.getBoundingClientRect?.().top < 52
      ) {
        return btn.closest?.('div.flex.items-center, div.absolute.right-0') || btn;
      }
    }
    return document.querySelector('div.absolute.right-0.top-0');
  } catch {
    return null;
  }
}

function getLeftSidebarRightEdge(vw) {
  try {
    if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
      if (document.querySelector('.monaco-workbench')) {
        return 0;
      }
      const navEl = document.querySelector('div[role="navigation"]');
      if (navEl?.getBoundingClientRect) {
        const nr = navEl.getBoundingClientRect();
        if (nr.width > 0 && nr.left <= 8 && nr.right > 0 && nr.right < vw - 280) {
          return Math.ceil(nr.right);
        }
      }
    }
  } catch {
    // 忽略侧栏测量异常
  }
  return 0;
}

/**
 * 在主窗口挂载双栖顶栏胶囊与完整四标签悬浮面板，并注册 `window.__AGUsageMonitorOverlay` 生命周期句柄。
 */
function mountWindowOverlay() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;

  // 先读取旧实例缓存的遥测快照与展开态（热升级时无缝承接数据与悬停状态，杜绝闪烁或关开），再安全卸载旧实例
  let carryOverTelemetry = null;
  let carryOverTooltipOpen = false;
  let carryOverPopoverOpen = false;
  let carryOverMultiHoverOpen = false;
  let carryOverMultiPinnedOpen = false;
  let carryOverPointer = null;
  try {
    const prevOv = window[WINDOW_OVERLAY_KEY];
    carryOverTelemetry = prevOv?.getTelemetrySnapshot?.() || null;
    carryOverTooltipOpen = Boolean(prevOv?.isHoverOpen?.());
    carryOverPopoverOpen = Boolean(prevOv?.isOpen?.());
    carryOverMultiHoverOpen = Boolean(prevOv?.isMultiHoverOpen?.());
    carryOverMultiPinnedOpen = Boolean(prevOv?.isMultiPinnedOpen?.());
    carryOverPointer = prevOv?.getLastPointer?.() || null;
    prevOv?.[WINDOW_OVERLAY_METHODS.dispose]?.();
  } catch {
    // 忽略旧实例卸载异常
  }
  try {
    document.getElementById(CAPSULE_HOST_ID)?.remove?.();
    document.getElementById(PORTAL_HOST_ID)?.remove?.();
  } catch {
    // 忽略残留节点清理异常
  }

  const bridgeConfig = getWindowBridgeConfig();
  const bundleVersion = String(bridgeConfig?.bundleVersion || '');
  const stylesCss = String(bridgeConfig?.stylesCss || '');
  const seedTelemetry =
    (bridgeConfig?.initialTelemetry && typeof bridgeConfig.initialTelemetry === 'object'
      ? bridgeConfig.initialTelemetry
      : null) || carryOverTelemetry;
  if (bridgeConfig?.initialTelemetry) {
    delete bridgeConfig.initialTelemetry;
  }
  if (seedTelemetry) {
    setI18nLanguage(seedTelemetry?.settings?.language);
    telemetryStore.setState({
      telemetry: seedTelemetry,
      minuteTick: Math.floor(Date.now() / 30000),
      syncState: 'idle',
    });
  } else {
    setI18nLanguage(telemetryStore.getState().telemetry?.settings?.language);
  }

  let disposed = false;
  let popoverOpen = false;
  let tooltipOpen = false;
  let multiOpen = false;
  let multiPinned = false;
  let hoverLeaveTimer = null;
  let multiLeaveTimer = null;
  let hasPointerCoords = Boolean(
    carryOverPointer &&
      Number.isFinite(carryOverPointer.x) &&
      Number.isFinite(carryOverPointer.y)
  );
  let lastPointerX = hasPointerCoords ? carryOverPointer.x : -1;
  let lastPointerY = hasPointerCoords ? carryOverPointer.y : -1;
  let layoutMode = 'wide';
  let observedTitlebar = null;
  let dockRafId = 0;
  let lastObservedRouteId = extractHostRouteCascadeId();

  function recordPointerCoords(e) {
    if (e && Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
      lastPointerX = e.clientX;
      lastPointerY = e.clientY;
      hasPointerCoords = true;
    }
  }

  function isPointerStillInCapsule() {
    if (!hasPointerCoords || document.hidden || !capsuleBtn.getBoundingClientRect) {
      return false;
    }
    const r = capsuleBtn.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    let rightBound = r.right;
    if (!topbarUpdateBtn.hasAttribute('hidden') && topbarUpdateBtn.getBoundingClientRect) {
      const ur = topbarUpdateBtn.getBoundingClientRect();
      if (ur.width > 0 && ur.height > 0) {
        rightBound = Math.max(rightBound, ur.right);
      }
    }
    return (
      lastPointerX >= r.left - 1 &&
      lastPointerX <= rightBound + 1 &&
      lastPointerY >= r.top - 1 &&
      lastPointerY <= r.bottom + 1
    );
  }

  function isPointerInMultiZone() {
    if (!hasPointerCoords || document.hidden || multiBtn.hasAttribute('hidden')) {
      return false;
    }
    const bridgePad = multiOpen ? 12 : 1;
    if (multiBtn.getBoundingClientRect) {
      const mr = multiBtn.getBoundingClientRect();
      if (
        mr.width > 0 &&
        mr.height > 0 &&
        lastPointerX >= mr.left - 1 &&
        lastPointerX <= mr.right + 1 &&
        lastPointerY >= mr.top - bridgePad &&
        lastPointerY <= mr.bottom + bridgePad
      ) {
        return true;
      }
    }
    if (multiOpen && multiPanelEl.getBoundingClientRect) {
      const pr = multiPanelEl.getBoundingClientRect();
      if (
        pr.width > 0 &&
        pr.height > 0 &&
        lastPointerX >= pr.left - 1 &&
        lastPointerX <= pr.right + 1 &&
        lastPointerY >= pr.top - 8 &&
        lastPointerY <= pr.bottom + 12
      ) {
        return true;
      }
    }
    return false;
  }

  function scheduleMultiHoverClose() {
    if (multiLeaveTimer) {
      clearTimeout(multiLeaveTimer);
    }
    multiLeaveTimer = setTimeout(() => {
      multiLeaveTimer = null;
      if (disposed || multiPinned || !multiOpen) return;
      let nativeHover = false;
      try {
        nativeHover = Boolean(
          multiBtn.matches?.(':hover') || multiPanelEl.matches?.(':hover')
        );
      } catch {
        nativeHover = false;
      }
      if (nativeHover || isPointerInMultiZone()) {
        return;
      }
      setMultiOpen(false);
    }, 90);
  }

  function inspectSessionInMonitor(cascadeId) {
    if (!cascadeId || cascadeId === 'current') return;
    uiStore.setState({
      activeView: 'overview',
      selectedAgentScope: 'all',
      ctxInspectorAgentId: 'auto',
    });
    void selectConversation(cascadeId);
    setMultiOpen(false);
    setPopoverOpen(true);
  }

  // --- 1. 创建顶栏/输入框双胶囊 Shadow Host（左：多会话实时信息；右：单会话指标胶囊） ---
  const capsuleHost = document.createElement('div');
  capsuleHost.id = CAPSULE_HOST_ID;
  capsuleHost.className = 'wm-capsule-host';
  capsuleHost.setAttribute('data-dock', 'fixed');
  capsuleHost.setAttribute('data-layout', layoutMode);
  // 隔离冒泡事件，防止嵌入输入框工具栏时点击或回车误触外层编辑框聚焦或表单提交
  capsuleHost.addEventListener?.('mousedown', (e) => e.stopPropagation?.());
  capsuleHost.addEventListener?.('click', (e) => e.stopPropagation?.());
  capsuleHost.addEventListener?.('keydown', (e) => {
    if (e?.key !== 'Escape') {
      e.stopPropagation?.();
    }
  });
  const capsuleShadow = capsuleHost.attachShadow({ mode: 'open' });

  const capsuleStyleEl = document.createElement('style');
  capsuleStyleEl.textContent = stylesCss;
  capsuleShadow.appendChild(capsuleStyleEl);

  // 左侧无边框多会话实时触发按钮（固定预占宽度，不随运行数跳动）
  const multiDot = h('span', { className: 'wm-multi-dot' });
  const multiLabel = h('span', { className: 'wm-multi-label', text: t('capsule.multiZero') });
  const multiBtn = h(
    'button',
    {
      type: 'button',
      className: 'wm-multi-btn',
      'aria-label': t('capsule.ariaMulti'),
      'aria-expanded': 'false',
      onClick: (e) => {
        e.stopPropagation();
        if (multiOpen && multiPinned) {
          setMultiOpen(false);
        } else {
          setMultiOpen(true, { pinned: true });
        }
      },
      onContextmenu: (e) => {
        e.preventDefault();
        e.stopPropagation();
        void fetchTelemetry({ force: true });
      },
      onMouseenter: (e) => {
        recordPointerCoords(e);
        if (multiLeaveTimer) {
          clearTimeout(multiLeaveTimer);
          multiLeaveTimer = null;
        }
        if (!popoverOpen && !multiPinned) {
          setMultiOpen(true, { pinned: false });
        }
      },
      onMouseleave: (e) => {
        recordPointerCoords(e);
        if (!multiPinned) {
          scheduleMultiHoverClose();
        }
      },
    },
    [multiDot, multiLabel]
  );

  // 构建可复用的预占胶囊槽位节点（由 CapsuleBarWidget 共享创建，支持 1..5 项动态槽位）
  const capsuleSlots = [
    createCapsuleSlotNode(0, 'tps'),
    createCapsuleSlotNode(1, 'ttft'),
    createCapsuleSlotNode(2, 'context'),
    createCapsuleSlotNode(3, 'none'),
    createCapsuleSlotNode(4, 'none'),
  ];
  const capsuleSeps = [
    h('span', { className: 'wm-sep wm-sep-speed', 'data-sep-for-rank': '2' }),
    h('span', { className: 'wm-sep wm-sep-quota', 'data-sep-for-rank': '3' }),
    h('span', { className: 'wm-sep', 'data-sep-for-rank': '', hidden: true }),
    h('span', { className: 'wm-sep', 'data-sep-for-rank': '', hidden: true }),
  ];
  let lastSlotCount = 3;
  let lastShowMulti = true;
  let lastShowUpdate = false;
  let isTopbarUpdating = false;

  const updateDot = h('span', { className: 'wm-update-dot', hidden: true });
  const topbarUpdateIcon = createSvgIcon('arrow-down', { size: 10 });
  const topbarUpdateLabel = h('span', {
    className: 'wm-update-label',
    text: t('capsule.newVersion'),
  });
  const topbarUpdateBtn = h(
    'button',
    {
      type: 'button',
      className: 'wm-update-btn',
      hidden: true,
      'aria-label': t('capsule.ariaUpdateTitle'),
      title: t('capsule.ariaUpdateTitle'),
      onClick: async (e) => {
        e.stopPropagation();
        if (isTopbarUpdating) return;
        isTopbarUpdating = true;
        patchClasses(topbarUpdateBtn, { 'is-updating': true });
        patchSvgIcon(topbarUpdateIcon, 'refresh');
        patchText(topbarUpdateLabel, t('capsule.updating'));
        patchAttr(topbarUpdateBtn, 'disabled', true);
        try {
          const res = await triggerPluginUpdate();
          if (!res?.ok) {
            uiStore.setState({ activeView: 'settings' });
            setPopoverOpen(true);
          }
        } catch {
          uiStore.setState({ activeView: 'settings' });
          setPopoverOpen(true);
        } finally {
          isTopbarUpdating = false;
          patchClasses(topbarUpdateBtn, { 'is-updating': false });
          patchSvgIcon(topbarUpdateIcon, 'arrow-down');
          patchAttr(topbarUpdateBtn, 'disabled', false);
          const cs = telemetryStore.getState().telemetry?.cloudStatus;
          patchText(
            topbarUpdateLabel,
            cs?.latestPluginVersion ? `v${cs.latestPluginVersion}` : t('capsule.newVersion')
          );
        }
      },
      onMouseenter: (e) => {
        recordPointerCoords(e);
        if (hoverLeaveTimer) {
          clearTimeout(hoverLeaveTimer);
          hoverLeaveTimer = null;
        }
        if (!popoverOpen && !multiPinned) {
          if (multiOpen) {
            setMultiOpen(false);
          }
          setTooltipOpen(true);
        }
      },
      onMouseleave: (e) => {
        recordPointerCoords(e);
        if (hoverLeaveTimer) {
          clearTimeout(hoverLeaveTimer);
        }
        hoverLeaveTimer = setTimeout(() => {
          hoverLeaveTimer = null;
          if (disposed || popoverOpen) return;
          let nativeHover = false;
          try {
            nativeHover = Boolean(
              capsuleBtn.matches?.(':hover') || topbarUpdateBtn.matches?.(':hover')
            );
          } catch {
            nativeHover = false;
          }
          if (nativeHover || isPointerStillInCapsule()) {
            return;
          }
          setTooltipOpen(false);
        }, 40);
      },
    },
    [topbarUpdateIcon, topbarUpdateLabel]
  );

  const capsuleBtn = h(
    'button',
    {
      type: 'button',
      className: 'wm-capsule-btn',
      'aria-label': t('capsule.ariaMonitor'),
      'aria-expanded': 'false',
      onClick: (e) => {
        e.stopPropagation();
        setPopoverOpen(!popoverOpen);
      },
      onContextmenu: (e) => {
        e.preventDefault();
        e.stopPropagation();
        void fetchTelemetry({ force: true });
      },
      onMouseenter: (e) => {
        recordPointerCoords(e);
        if (hoverLeaveTimer) {
          clearTimeout(hoverLeaveTimer);
          hoverLeaveTimer = null;
        }
        if (!popoverOpen && !multiPinned) {
          if (multiOpen) {
            setMultiOpen(false);
          }
          setTooltipOpen(true);
        }
      },
      onMouseleave: (e) => {
        recordPointerCoords(e);
        if (hoverLeaveTimer) {
          clearTimeout(hoverLeaveTimer);
        }
        hoverLeaveTimer = setTimeout(() => {
          hoverLeaveTimer = null;
          if (disposed || popoverOpen) return;
          let nativeHover = false;
          try {
            nativeHover = Boolean(
              capsuleBtn.matches?.(':hover') || topbarUpdateBtn.matches?.(':hover')
            );
          } catch {
            nativeHover = false;
          }
          if (nativeHover || isPointerStillInCapsule()) {
            return;
          }
          setTooltipOpen(false);
        }, 40);
      },
    },
    [
      capsuleSlots[0].el,
      capsuleSeps[0],
      capsuleSlots[1].el,
      capsuleSeps[1],
      capsuleSlots[2].el,
      capsuleSeps[2],
      capsuleSlots[3].el,
      capsuleSeps[3],
      capsuleSlots[4].el,
      updateDot,
    ]
  );
  capsuleShadow.appendChild(multiBtn);
  capsuleShadow.appendChild(capsuleBtn);
  capsuleShadow.appendChild(topbarUpdateBtn);

  // --- 2. 创建 Body 顶层浮层 Portal Shadow Host ---
  const portalHost = document.createElement('div');
  portalHost.id = PORTAL_HOST_ID;
  portalHost.className = 'wm-portal-host';
  const portalShadow = portalHost.attachShadow({ mode: 'open' });

  const portalStyleEl = document.createElement('style');
  portalStyleEl.textContent = stylesCss;
  portalShadow.appendChild(portalStyleEl);

  const initialSettings = telemetryStore.getState().telemetry?.settings;

  // 悬停全景概览浮层（完全解耦至 widgetRegistry，由 hoverModules 动态驱动 0..4 个独立组件，零硬编码）
  const hoverUpdateVerText = h('span', { text: t('capsule.hoverNewVerGeneric') });
  const hoverUpdateHintText = h('span', {
    className: 'wm-hover-update-hint',
    text: t('capsule.hoverUpdateHintTopbarGeneric'),
  });
  const hoverUpdateBar = h(
    'div',
    {
      className: 'wm-hover-update-bar',
      hidden: true,
    },
    [
      h('span', { className: 'wm-hover-update-left' }, [
        createSvgIcon('arrow-down', { size: 11 }),
        hoverUpdateVerText,
      ]),
      hoverUpdateHintText,
    ]
  );

  const hoverWidgetsContainer = h('div', { className: 'wm-hover-widgets' });
  const hoverWidgetHost = createDynamicWidgetHost({
    containerEl: hoverWidgetsContainer,
    mode: 'hover',
    isVisibleFn: () => Boolean(tooltipOpen && !disposed),
    initialModuleKeys: DEFAULT_CLIENT_HOVER_MODULES,
  });

  const hoverTipEl = h(
    'div',
    {
      className: 'wm-hover-tip',
      hidden: true,
    },
    [hoverUpdateBar, hoverWidgetsContainer]
  );

  // 左侧多会话实时看板浮层（受控复用 LiveActivityWidget，保持零硬编码与同一套计时器状态机）
  const multiPinBadge = h('span', {
    className: 'wm-pin-badge',
    hidden: true,
    text: t('multi.pinned'),
  });
  const multiRunningMetaEl = h('span', {
    className: 'panel-meta text-mono',
    text: t('multi.loading'),
  });
  const multiEmptyTextEl = h('span', { text: t('multi.empty') });
  const multiEmptyEl = h('div', { className: 'wm-multi-empty' }, [
    h('span', { className: 'wm-multi-empty-left' }, [
      h('span', { className: 'wm-idle-dot' }),
      multiEmptyTextEl,
    ]),
  ]);
  const multiRunningWidget = LiveActivityWidget({
    defaultExpandRunningSubs: true,
    showSessionExtras: true,
    isVisibleFn: () => Boolean(multiOpen && !document.hidden && !disposed),
    onSelectSession: inspectSessionInMonitor,
    onLayoutChange: () => {
      if (multiOpen) {
        patchClasses(multiPanelEl, { 'is-instant': true });
        positionFloatingElements();
      }
    },
  });

  const multiTitleTextEl = h('span', { text: t('multi.title') });
  const multiHeaderEl = h('div', { className: 'panel-header wm-multi-header' }, [
    h('span', { className: 'panel-title' }, [
      createSvgIcon('pulse', { size: 13 }),
      multiTitleTextEl,
      multiPinBadge,
    ]),
    multiRunningMetaEl,
  ]);

  const multiPanelEl = h(
    'div',
    {
      className: 'wm-multi-panel',
      role: 'dialog',
      'aria-label': t('multi.ariaDialog'),
      hidden: true,
      onMouseenter: (e) => {
        recordPointerCoords(e);
        if (multiLeaveTimer) {
          clearTimeout(multiLeaveTimer);
          multiLeaveTimer = null;
        }
      },
      onMouseleave: (e) => {
        recordPointerCoords(e);
        if (!multiPinned) {
          scheduleMultiHoverClose();
        }
      },
    },
    [multiHeaderEl, multiEmptyEl, multiRunningWidget.el]
  );

  // 完整四标签悬浮容器
  uiStore.setState({ monitorVisible: false });
  const appInstance = App();
  const popoverEl = h(
    'div',
    {
      className: 'wm-popover-panel',
      role: 'dialog',
      'aria-label': t('capsule.ariaMonitor'),
      hidden: true,
    },
    [appInstance.el]
  );

  function syncPortalAppearance(settings) {
    applyAppearanceToRoot(capsuleHost, settings, { includeFontScale: false });
    applyAppearanceToRoot(portalHost, settings, { includeFontScale: true });
    const scaleKey = normalizeClientFontScale(settings?.fontScale);
    const isModernUi = normalizeClientModernUi(settings?.experimentalModernUi);
    const colorScheme = portalHost.getAttribute?.('data-color-scheme') || 'light';
    for (const el of [popoverEl, hoverTipEl, multiPanelEl]) {
      if (el.getAttribute?.('data-font-scale') !== scaleKey) {
        el.setAttribute?.('data-font-scale', scaleKey);
      }
      if (el.getAttribute?.('data-color-scheme') !== colorScheme) {
        el.setAttribute?.('data-color-scheme', colorScheme);
      }
      if (isModernUi) {
        if (el.getAttribute?.('data-modern-ui') !== 'true') {
          el.setAttribute?.('data-modern-ui', 'true');
        }
      } else if (el.hasAttribute?.('data-modern-ui')) {
        el.removeAttribute?.('data-modern-ui');
      }
    }
  }

  portalShadow.appendChild(multiPanelEl);
  portalShadow.appendChild(hoverTipEl);
  portalShadow.appendChild(popoverEl);
  syncPortalAppearance(initialSettings);
  (document.body || document.documentElement).appendChild(portalHost);

  // --- 3. 几何测量、IDE 主题桥接、顶栏停靠与防溢出定位 ---
  let patchedActionToolbar = null;
  let patchedActionToolbarPrevMargin = '';
  let observedWorkbench = null;
  let themeObserver = null;
  const mirroredThemeVars = new Map();

  function restorePatchedActionToolbar() {
    if (!patchedActionToolbar) return;
    try {
      if (patchedActionToolbar.style) {
        patchedActionToolbar.style.marginLeft = patchedActionToolbarPrevMargin;
      }
    } catch {
      // 忽略还原宿主工具栏边距异常
    }
    patchedActionToolbar = null;
    patchedActionToolbarPrevMargin = '';
  }

  function syncWorkbenchThemeVars() {
    if (disposed) return null;
    try {
      if (
        typeof document === 'undefined' ||
        typeof document.querySelector !== 'function' ||
        typeof window.getComputedStyle !== 'function'
      ) {
        return null;
      }
      const workbenchEl = document.querySelector('.monaco-workbench');
      const rootCs = document.documentElement
        ? window.getComputedStyle(document.documentElement)
        : null;
      const bodyCs = document.body ? window.getComputedStyle(document.body) : null;
      const nativeRootBg = String(
        rootCs?.getPropertyValue?.('--background') ||
          bodyCs?.getPropertyValue?.('--background') ||
          ''
      ).trim();
      if (nativeRootBg) {
        if (mirroredThemeVars.size > 0) {
          for (const k of mirroredThemeVars.keys()) {
            portalHost.style.removeProperty?.(k);
            capsuleHost.style.removeProperty?.(k);
          }
          mirroredThemeVars.clear();
        }
        return workbenchEl || document.documentElement || null;
      }

      const themeSourceEl = workbenchEl || document.documentElement || document.body;
      if (!themeSourceEl) return null;
      const wbCs = window.getComputedStyle(themeSourceEl);
      const pick = (...names) => {
        for (const name of names) {
          const val = String(wbCs?.getPropertyValue?.(name) || '').trim();
          if (val) return val;
        }
        return '';
      };

      const nextVars = [
        [
          '--background',
          pick('--vscode-sideBar-background', '--vscode-editor-background', '--vscode-panel-background'),
        ],
        [
          '--card',
          pick(
            '--vscode-editorWidget-background',
            '--vscode-sideBar-background',
            '--vscode-editor-background'
          ),
        ],
        ['--foreground', pick('--vscode-foreground', '--vscode-editor-foreground')],
        [
          '--muted-foreground',
          pick('--vscode-descriptionForeground', '--vscode-sideBarTitle-foreground'),
        ],
        [
          '--border',
          pick(
            '--vscode-widget-border',
            '--vscode-panel-border',
            '--vscode-commandCenter-border',
            '--vscode-contrastBorder'
          ),
        ],
        [
          '--primary',
          pick('--vscode-textLink-foreground', '--vscode-button-background', '--vscode-focusBorder'),
        ],
        ['--destructive', pick('--vscode-errorForeground', '--vscode-editorError-foreground')],
      ];

      for (const [cssVar, val] of nextVars) {
        const prevVal = mirroredThemeVars.get(cssVar) || '';
        if (val) {
          if (prevVal !== val) {
            portalHost.style.setProperty?.(cssVar, val);
            capsuleHost.style.setProperty?.(cssVar, val);
            mirroredThemeVars.set(cssVar, val);
          }
        } else if (prevVal) {
          if (typeof portalHost.style.removeProperty === 'function') {
            portalHost.style.removeProperty(cssVar);
          } else {
            portalHost.style.setProperty?.(cssVar, '');
          }
          if (typeof capsuleHost.style.removeProperty === 'function') {
            capsuleHost.style.removeProperty(cssVar);
          } else {
            capsuleHost.style.setProperty?.(cssVar, '');
          }
          mirroredThemeVars.delete(cssVar);
        }
      }
      return themeSourceEl;
    } catch {
      return null;
    }
  }

  function ensureWorkbenchThemeObserved() {
    const wb = syncWorkbenchThemeVars();
    syncPortalAppearance(telemetryStore.getState().telemetry?.settings);
    if (wb && wb !== observedWorkbench && themeObserver) {
      observedWorkbench = wb;
      try {
        themeObserver.observe(wb, { attributes: true, attributeFilter: ['class', 'style'] });
      } catch {
        // 忽略工作台属性观察异常
      }
    }
  }

  function resolveRuntimeDockTarget() {
    return resolveActiveDockTarget({
      capsuleNode: capsuleHost,
      portalNode: portalHost,
      patchedNode: patchedActionToolbar,
    });
  }

  function isDockPlacementSynced(dock) {
    const curDockAttr = capsuleHost.getAttribute('data-dock');
    if (!capsuleHost.isConnected || !portalHost.isConnected) return false;
    if (!dock) {
      if (isIdeExtensionChatFrame()) {
        return curDockAttr === 'pending-composer' && capsuleHost.style.display === 'none';
      }
      return curDockAttr === 'fixed';
    }
    if (capsuleHost.style.display === 'none') return false;
    if (!dock.targetContainer?.contains?.(capsuleHost) || curDockAttr !== dock.kind) return false;
    if (dock.kind === 'composer') {
      if (dock.anchorNode) {
        if (!isImmediatelyBeforeNode(capsuleHost, dock.anchorNode)) return false;
      } else {
        const lastEl =
          dock.targetContainer.lastElementChild !== undefined
            ? dock.targetContainer.lastElementChild
            : dock.targetContainer.children?.[dock.targetContainer.children.length - 1] ||
              dock.targetContainer.lastChild;
        if (lastEl !== capsuleHost) return false;
      }
    }
    return true;
  }

  const isMac = () => isMacHostPlatform(telemetryStore.getState().telemetry);

  function updateFixedFallbackPosition() {
    const dockMode = capsuleHost.getAttribute('data-dock');
    if (dockMode === 'flow' || dockMode === 'ide-titlebar' || dockMode === 'composer') {
      capsuleHost.style.top = '';
      capsuleHost.style.right = '';
      return;
    }
    try {
      const vw = Number(window.innerWidth || 1280);
      const minRight = isMac() ? 12 : 144;
      let rightOffset = minRight;
      const anchor = findNativeTopRightAnchor();
      if (anchor?.getBoundingClientRect) {
        const r = anchor.getBoundingClientRect();
        if (r.width > 0 && r.left > 0 && r.left < vw) {
          rightOffset = Math.max(minRight, Math.ceil(vw - r.left + 6));
        }
      }
      capsuleHost.style.top = '7px';
      capsuleHost.style.right = `${rightOffset}px`;
    } catch {
      // 忽略回退坐标计算异常
    }
  }

  function syncCapsuleOsAttr() {
    const nextOs = isMac() ? 'mac' : 'default';
    if (capsuleHost.getAttribute('data-os') !== nextOs) {
      patchAttr(capsuleHost, 'data-os', nextOs);
      if (capsuleHost.getAttribute('data-dock') === 'fixed') {
        updateFixedFallbackPosition();
      }
    }
  }

  function measureAvailableTitlebarWidth(dockTarget) {
    try {
      const titlebar = dockTarget?.titlebar || null;
      if (dockTarget?.kind === 'composer' && titlebar?.getBoundingClientRect) {
        const cRect = titlebar.getBoundingClientRect();
        const aRect = dockTarget.anchorNode?.getBoundingClientRect?.();
        if (cRect.width > 0) {
          const leftEdge =
            Number.isFinite(dockTarget.leftClusterRightEdge) &&
            dockTarget.leftClusterRightEdge > cRect.left + 12
              ? dockTarget.leftClusterRightEdge
              : cRect.left + 12;
          const leftOccupied = Math.max(12, leftEdge - cRect.left);
          if (aRect && aRect.width > 0) {
            const rightOccupied = Math.max(aRect.width + 8, cRect.right - aRect.left);
            return cRect.width - leftOccupied - rightOccupied - 16;
          }
          if (!dockTarget.anchorNode) {
            return cRect.width - leftOccupied - 28;
          }
        }
      }

      if (dockTarget?.kind === 'ide-titlebar' && titlebar?.getBoundingClientRect) {
        const tbRect = titlebar.getBoundingClientRect();
        if (tbRect.width > 0) {
          let leftContentWidth = 12;
          const leftGroup =
            titlebar.querySelector?.(':scope > .titlebar-left') ||
            titlebar.querySelector?.('.titlebar-left');
          if (leftGroup) {
            let leftSum = 0;
            if (typeof window.getComputedStyle === 'function') {
              leftSum += parseFloat(window.getComputedStyle(leftGroup).paddingLeft) || 0;
            }
            if (leftGroup.children) {
              for (const child of leftGroup.children) {
                if (child?.getBoundingClientRect) {
                  leftSum += Math.max(0, child.getBoundingClientRect().width);
                }
              }
            }
            leftContentWidth = Math.min(Math.round(tbRect.width * 0.45), Math.max(12, leftSum));
          }

          let minCenterWidth = 0;
          const centerGroup =
            titlebar.querySelector?.(':scope > .titlebar-center') ||
            titlebar.querySelector?.('.titlebar-center');
          if (centerGroup?.getBoundingClientRect) {
            const cr = centerGroup.getBoundingClientRect();
            if (cr.width > 0 && cr.height > 0) {
              minCenterWidth = Math.min(220, Math.ceil(cr.width));
            }
          }

          let rightSiblingsWidth = 0;
          let hasVisibleWindowControls = false;
          const rightGroup = dockTarget.targetContainer;
          if (rightGroup?.children) {
            for (const child of rightGroup.children) {
              if (child === capsuleHost || !child?.getBoundingClientRect) continue;
              const cw = Math.max(0, child.getBoundingClientRect().width);
              rightSiblingsWidth += cw;
              if (cw > 0 && child.classList?.contains?.('window-controls-container')) {
                hasVisibleWindowControls = true;
              }
            }
          }
          if (navigator?.windowControlsOverlay?.visible) {
            const wcoRect = navigator.windowControlsOverlay.getTitlebarAreaRect?.();
            if (wcoRect && wcoRect.width > 0) {
              if (!hasVisibleWindowControls && tbRect.right > wcoRect.right + 4) {
                rightSiblingsWidth += tbRect.right - wcoRect.right;
              }
              const leftOverlayInset = wcoRect.left - tbRect.left;
              if (leftOverlayInset > leftContentWidth) {
                leftContentWidth = Math.min(
                  Math.round(tbRect.width * 0.45),
                  Math.ceil(leftOverlayInset)
                );
              }
            }
          }

          return tbRect.width - leftContentWidth - minCenterWidth - rightSiblingsWidth - 28;
        }
      }

      if (titlebar?.getBoundingClientRect) {
        const tbRect = titlebar.getBoundingClientRect();
        if (tbRect.width > 0) {
          const titleEl = titlebar.firstElementChild;
          const titleInner = titleEl?.firstElementChild;
          const macTrafficReserve = isMac() ? 80 : 168;
          const contentStart = titleInner?.getBoundingClientRect
            ? Math.max(8, titleInner.getBoundingClientRect().left - tbRect.left)
            : tbRect.left < macTrafficReserve
              ? macTrafficReserve - tbRect.left
              : 12;
          const minTitleWidth = 180;
          let siblingButtonsWidth = 64;
          let rightPad = 8;
          const rightGroup = capsuleHost.parentElement;
          if (rightGroup && rightGroup !== titlebar) {
            const auxOpen =
              typeof document.querySelector === 'function' &&
              Boolean(document.querySelector('[data-testid="aux-pane-sash"]'));
            const root =
              typeof document.querySelector === 'function'
                ? document.querySelector('div.h-screen.w-screen')
                : null;
            const rightClusterVar =
              root?.style?.getPropertyValue?.('--right-cluster-width')?.trim() || '';
            if (auxOpen) {
              rightPad = 8;
            } else if (rightClusterVar) {
              rightPad = Math.max(8, (parseFloat(rightClusterVar) || 44) - 4);
            } else if (typeof window.getComputedStyle === 'function') {
              rightPad = parseFloat(window.getComputedStyle(rightGroup).paddingRight) || 0;
            }
            if (rightGroup.children) {
              let sum = 0;
              for (const child of rightGroup.children) {
                if (child !== capsuleHost && child.getBoundingClientRect) {
                  sum += child.getBoundingClientRect().width;
                }
              }
              if (sum > 0) siblingButtonsWidth = sum + 8;
            }
          }
          return tbRect.width - contentStart - minTitleWidth - rightPad - siblingButtonsWidth;
        }
      }
      if (window.innerWidth) {
        return window.innerWidth - 360;
      }
    } catch {
      // 忽略测量异常
    }
    return 320;
  }

  function positionFloatingElements() {
    if (disposed || !capsuleBtn.getBoundingClientRect) return;
    try {
      const bRect = capsuleBtn.getBoundingClientRect();
      if (bRect.width === 0 && bRect.height === 0) return;
      const vw = Number(window.innerWidth || 1280);
      const vh = Number(window.innerHeight || 800);
      const navRight = getLeftSidebarRightEdge(vw);
      const minLeft = navRight > 0 ? Math.max(12, navRight + 12) : 12;
      const curSettings = telemetryStore.getState().telemetry?.settings;
      const panelScale =
        PANEL_SCALE_FACTORS[normalizeClientFontScale(curSettings?.fontScale)] ?? 1;
      const defaultCardW = Math.min(
        Math.round(FLOATING_CARD_WIDTH * panelScale),
        Math.max(280, vw - 24)
      );
      const defaultMultiW = Math.min(
        Math.round(MULTI_PANEL_WIDTH * panelScale),
        Math.max(280, vw - 24)
      );
      const isDockComposer = capsuleHost.getAttribute('data-dock') === 'composer';

      if (multiOpen) {
        const mRect = multiBtn.getBoundingClientRect?.() || bRect;
        const anchorRect = mRect.width > 0 || mRect.height > 0 ? mRect : bRect;
        const rawW =
          Number(multiPanelEl.offsetWidth) ||
          Number(multiPanelEl.getBoundingClientRect?.().width) ||
          defaultMultiW;
        const panelW = Math.min(rawW, Math.max(280, vw - minLeft - 12));
        const panelH =
          Number(multiPanelEl.offsetHeight) ||
          Number(multiPanelEl.getBoundingClientRect?.().height) ||
          320;
        const spaceBelowMulti = vh - anchorRect.bottom - 12;
        const spaceAboveMulti = anchorRect.top - 16;
        const openMultiAbove =
          (isDockComposer && spaceAboveMulti > spaceBelowMulti) ||
          (anchorRect.bottom + 6 + panelH > vh - 8 && spaceAboveMulti > spaceBelowMulti);

        let top;
        let maxMultiH;
        if (openMultiAbove) {
          maxMultiH = Math.max(180, Math.floor(anchorRect.top - 20));
          multiPanelEl.style.maxHeight = `${maxMultiH}px`;
          const effMultiH = Math.min(Number(multiPanelEl.offsetHeight) || panelH, maxMultiH);
          top = Math.max(12, Math.round(anchorRect.top - effMultiH - 8));
        } else {
          top = Math.max(38, Math.round(anchorRect.bottom + 6));
          maxMultiH = Math.max(240, vh - top - 12);
          multiPanelEl.style.maxHeight = `${maxMultiH}px`;
        }
        patchClasses(multiPanelEl, { 'is-above': openMultiAbove });
        let left = Math.round(anchorRect.left);
        left = Math.min(left, vw - panelW - 12);
        left = Math.max(minLeft, left);
        multiPanelEl.style.top = `${top}px`;
        multiPanelEl.style.left = `${left}px`;
      }

      const rightAnchorEdge =
        !topbarUpdateBtn.hasAttribute('hidden') && topbarUpdateBtn.getBoundingClientRect
          ? Math.max(bRect.right, topbarUpdateBtn.getBoundingClientRect().right || 0)
          : bRect.right;

      if (popoverOpen) {
        const maxPopCardW = Math.max(280, vw - minLeft - 12);
        const popWidthMode = normalizeClientPopoverWidthMode(curSettings?.popoverWidthMode);
        let desiredPopW = Math.min(Math.round(POPOVER_BASE_WIDTH * panelScale), maxPopCardW);
        if (popWidthMode === 'custom') {
          desiredPopW = Math.min(
            normalizeClientPopoverWidth(curSettings?.popoverWidth),
            maxPopCardW
          );
        } else if (typeof popoverEl.querySelectorAll === 'function') {
          const panes = popoverEl.querySelectorAll('.table-viewport.is-step-table');
          for (const pane of panes) {
            let anc = pane;
            let inHiddenTree = false;
            while (anc && anc !== popoverEl) {
              if (anc.hasAttribute?.('hidden')) {
                inHiddenTree = true;
                break;
              }
              anc = anc.parentElement || anc.parentNode;
            }
            if (inHiddenTree) continue;
            const tableEl = pane.querySelector?.('.steps-data-table') || pane.firstElementChild;
            if (!tableEl) continue;
            const paneClientW = Number(pane.clientWidth || 0);
            const curPopW = Number(
              popoverEl.offsetWidth ||
                popoverEl.getBoundingClientRect?.().width ||
                POPOVER_BASE_WIDTH
            );
            let naturalTableW = 0;
            if (tableEl.style) {
              const prevW = tableEl.style.width || '';
              tableEl.style.width = 'max-content';
              naturalTableW = Math.ceil(
                Number(
                  tableEl.getBoundingClientRect?.().width ||
                    tableEl.scrollWidth ||
                    tableEl.offsetWidth ||
                    0
                )
              );
              tableEl.style.width = prevW;
            } else {
              naturalTableW = Math.ceil(Number(tableEl.scrollWidth || tableEl.offsetWidth || 0));
            }
            if (naturalTableW > 0) {
              const chromeW =
                paneClientW > 0 && curPopW >= paneClientW
                  ? Math.max(24, curPopW - paneClientW)
                  : 34;
              desiredPopW = Math.max(
                desiredPopW,
                Math.min(POPOVER_MAX_AUTO_WIDTH, maxPopCardW, naturalTableW + chromeW + 4)
              );
            }
          }
        }
        popoverEl.style.setProperty?.('--wm-popover-w', `${desiredPopW}px`);
        popoverEl.style.width = `${desiredPopW}px`;

        const rawW =
          Number(popoverEl.offsetWidth) ||
          Number(popoverEl.getBoundingClientRect?.().width) ||
          desiredPopW;
        const panelW = Math.min(rawW, maxPopCardW);
        const spaceBelowPop = vh - bRect.bottom - 12;
        const spaceAbovePop = bRect.top - 16;
        const openPopAbove =
          (isDockComposer && spaceAbovePop > spaceBelowPop) ||
          (spaceBelowPop < 360 && spaceAbovePop > spaceBelowPop);

        let top;
        if (openPopAbove) {
          const maxPopH = Math.max(240, Math.floor(bRect.top - 20));
          const targetPopH = Math.min(588, maxPopH);
          popoverEl.style.height = `${targetPopH}px`;
          popoverEl.style.maxHeight = `${maxPopH}px`;
          const actualPopH = Math.min(Number(popoverEl.offsetHeight) || targetPopH, maxPopH);
          top = Math.max(12, Math.round(bRect.top - actualPopH - 8));
        } else {
          popoverEl.style.height = '';
          top = Math.max(38, Math.min(vh - 140, Math.round(bRect.bottom + 6)));
          popoverEl.style.maxHeight = `${Math.max(240, vh - top - 12)}px`;
        }
        patchClasses(popoverEl, { 'is-above': openPopAbove });
        let left = Math.round(rightAnchorEdge - panelW);
        left = Math.min(left, vw - panelW - 12);
        left = Math.max(minLeft, left);
        popoverEl.style.top = `${top}px`;
        popoverEl.style.left = `${left}px`;
      }

      if (tooltipOpen && !popoverOpen && !multiOpen) {
        const rawW =
          Number(hoverTipEl.offsetWidth) ||
          Number(hoverTipEl.getBoundingClientRect?.().width) ||
          defaultCardW;
        const tipW = Math.min(rawW, Math.max(280, vw - minLeft - 12));
        const tipH =
          Number(hoverTipEl.offsetHeight) ||
          Number(hoverTipEl.getBoundingClientRect?.().height) ||
          480;
        const spaceBelowTip = vh - bRect.bottom - 12;
        const spaceAboveTip = bRect.top - 16;
        const openTipAbove =
          (isDockComposer && spaceAboveTip > spaceBelowTip) ||
          (bRect.bottom + 6 + tipH > vh - 8 && spaceAboveTip > spaceBelowTip);

        let top;
        if (openTipAbove) {
          const maxTipH = Math.max(220, Math.floor(bRect.top - 20));
          hoverTipEl.style.maxHeight = `${maxTipH}px`;
          const effTipH = Math.min(Number(hoverTipEl.offsetHeight) || tipH, maxTipH);
          top = Math.max(12, Math.round(bRect.top - effTipH - 8));
        } else {
          top = Math.max(38, Math.round(bRect.bottom + 6));
          hoverTipEl.style.maxHeight = `${Math.max(240, vh - top - 12)}px`;
        }
        patchClasses(hoverTipEl, { 'is-above': openTipAbove });
        let left = Math.round(rightAnchorEdge - tipW);
        left = Math.min(left, vw - tipW - 12);
        left = Math.max(minLeft, left);
        hoverTipEl.style.top = `${top}px`;
        hoverTipEl.style.left = `${left}px`;
      }
    } catch {
      // 忽略定位异常
    }
  }

  function updateResponsiveLayout(dockOverride = undefined) {
    if (disposed) return;
    const dockTarget = dockOverride === undefined ? resolveRuntimeDockTarget() : dockOverride;
    const avail = measureAvailableTitlebarWidth(dockTarget);
    const curTel = telemetryStore.getState().telemetry;
    const showMulti = curTel?.settings?.showTopbarMultiSession !== false;
    const curUpdateMode = normalizeClientUpdateMode(
      curTel?.settings?.pluginUpdateMode,
      curTel?.settings?.autoUpdatePlugin
    );
    const hasUpdate = Boolean(curTel?.cloudStatus?.updateAvailable) && curUpdateMode !== 'off';
    const slotCount = normalizeClientTopbarSlots(curTel?.settings?.topbarCapsuleSlots).length;
    const nextMode = computeCapsuleLayoutMode(avail, layoutMode, {
      showMulti,
      hasUpdate,
      slotCount,
    });
    if (nextMode !== layoutMode) {
      layoutMode = nextMode;
      capsuleHost.setAttribute('data-layout', layoutMode);
    }
    if (capsuleHost.getAttribute('data-dock') === 'fixed') {
      updateFixedFallbackPosition();
    }
    if (popoverOpen || tooltipOpen || multiOpen) {
      positionFloatingElements();
    }
  }

  let resizeObserver = null;

  function ensureCapsuleDocked() {
    if (disposed) return false;
    const bodyOrDoc = document.body || document.documentElement;
    if (bodyOrDoc && !portalHost.isConnected) {
      bodyOrDoc.appendChild(portalHost);
    }
    syncCapsuleOsAttr();
    ensureWorkbenchThemeObserved();

    const dockTarget = resolveRuntimeDockTarget();
    if (dockTarget) {
      if (capsuleHost.style.display === 'none') {
        capsuleHost.style.display = '';
      }
      const { kind, titlebar, targetContainer, actionToolbar } = dockTarget;
      if (kind === 'composer') {
        if (patchedActionToolbar !== actionToolbar) {
          restorePatchedActionToolbar();
          if (actionToolbar?.style) {
            patchedActionToolbar = actionToolbar;
            patchedActionToolbarPrevMargin = actionToolbar.style.marginLeft || '';
            actionToolbar.style.marginLeft = '0px';
          }
        }
        if (dockTarget.anchorNode) {
          if (
            (capsuleHost.parentElement || capsuleHost.parentNode) !== targetContainer ||
            !isImmediatelyBeforeNode(capsuleHost, dockTarget.anchorNode)
          ) {
            targetContainer.insertBefore(capsuleHost, dockTarget.anchorNode);
          }
        } else {
          const lastEl =
            targetContainer.lastElementChild !== undefined
              ? targetContainer.lastElementChild
              : targetContainer.children?.[targetContainer.children.length - 1] ||
                targetContainer.lastChild;
          if (
            (capsuleHost.parentElement || capsuleHost.parentNode) !== targetContainer ||
            lastEl !== capsuleHost
          ) {
            targetContainer.appendChild(capsuleHost);
          }
        }
        patchAttr(capsuleHost, 'data-dock', 'composer');
        patchAttr(
          capsuleHost,
          'data-composer-push',
          dockTarget.needsAutoMarginTransfer ? '1' : null
        );
      } else if (kind === 'ide-titlebar') {
        if (patchedActionToolbar !== actionToolbar) {
          restorePatchedActionToolbar();
          if (actionToolbar?.style) {
            patchedActionToolbar = actionToolbar;
            patchedActionToolbarPrevMargin = actionToolbar.style.marginLeft || '';
            actionToolbar.style.marginLeft = '0px';
          }
        }
        if (capsuleHost.parentElement !== targetContainer || targetContainer.firstChild !== capsuleHost) {
          if (targetContainer.firstChild) {
            targetContainer.insertBefore(capsuleHost, targetContainer.firstChild);
          } else {
            targetContainer.appendChild(capsuleHost);
          }
        }
        patchAttr(capsuleHost, 'data-dock', 'ide-titlebar');
        patchAttr(capsuleHost, 'data-composer-push', null);
      } else {
        restorePatchedActionToolbar();
        if (capsuleHost.parentElement !== targetContainer) {
          if (targetContainer.firstChild && targetContainer !== titlebar) {
            targetContainer.insertBefore(capsuleHost, targetContainer.firstChild);
          } else {
            targetContainer.appendChild(capsuleHost);
          }
        }
        patchAttr(capsuleHost, 'data-dock', 'flow');
        patchAttr(capsuleHost, 'data-composer-push', null);
      }
      if (capsuleHost.style.top) capsuleHost.style.top = '';
      if (capsuleHost.style.right) capsuleHost.style.right = '';

      if (observedTitlebar !== titlebar) {
        observedTitlebar = titlebar;
        try {
          if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver.observe(titlebar);
            if (document.body) resizeObserver.observe(document.body);
          }
        } catch {
          // 忽略观察器异常
        }
      }
    } else if (isIdeExtensionChatFrame()) {
      restorePatchedActionToolbar();
      if (popoverOpen) setPopoverOpen(false);
      if (multiOpen) setMultiOpen(false);
      if (tooltipOpen) setTooltipOpen(false);
      if (bodyOrDoc && (capsuleHost.parentElement || capsuleHost.parentNode) !== bodyOrDoc) {
        bodyOrDoc.appendChild(capsuleHost);
      }
      capsuleHost.style.display = 'none';
      patchAttr(capsuleHost, 'data-dock', 'pending-composer');
      patchAttr(capsuleHost, 'data-composer-push', null);
    } else if (bodyOrDoc) {
      if (capsuleHost.style.display === 'none') {
        capsuleHost.style.display = '';
      }
      restorePatchedActionToolbar();
      if (capsuleHost.parentElement !== bodyOrDoc) {
        bodyOrDoc.appendChild(capsuleHost);
      }
      patchAttr(capsuleHost, 'data-dock', 'fixed');
      patchAttr(capsuleHost, 'data-composer-push', null);
      updateFixedFallbackPosition();
    }

    updateResponsiveLayout(dockTarget);
    return Boolean(capsuleHost.isConnected && portalHost.isConnected);
  }

  function scheduleDockSync() {
    if (disposed) return;
    if (typeof requestAnimationFrame === 'function') {
      if (dockRafId) return;
      dockRafId = requestAnimationFrame(() => {
        dockRafId = 0;
        ensureCapsuleDocked();
      });
    } else {
      ensureCapsuleDocked();
    }
  }

  function refreshActiveViewScrollbars() {
    const activeView = uiStore.getState().activeView;
    const refs = appInstance.refs;
    if (activeView === 'overview') {
      refs?.overviewView?.refs?.viewScrollbar?.refresh();
    } else if (activeView === 'consumption') {
      refs?.consumptionView?.refs?.viewScrollbar?.refresh();
    } else if (activeView === 'steps') {
      refs?.stepsView?.refs?.refreshStepTableViewport?.();
      refs?.stepsView?.refs?.stepsScroll?.refresh();
      refs?.stepsView?.refs?.modelsScroll?.refresh();
    } else if (activeView === 'settings') {
      refs?.settingsView?.refs?.viewScrollbar?.refresh();
    }
  }

  function setMultiOpen(nextOpen, { pinned = false, instant = false } = {}) {
    const targetOpen = Boolean(nextOpen);
    if (targetOpen && multiLeaveTimer) {
      clearTimeout(multiLeaveTimer);
      multiLeaveTimer = null;
    }
    if (targetOpen) {
      setTooltipOpen(false);
      if (pinned && popoverOpen) {
        setPopoverOpen(false);
      }
    }
    const nextPinned = targetOpen ? Boolean(pinned) : false;
    const stateChanged = multiOpen !== targetOpen || multiPinned !== nextPinned;
    multiOpen = targetOpen;
    multiPinned = nextPinned;
    patchClasses(multiBtn, { 'is-open': multiOpen && multiPinned });
    patchAttr(multiBtn, 'aria-expanded', multiOpen ? 'true' : 'false');
    patchAttr(multiPinBadge, 'hidden', !multiPinned);
    if (!stateChanged) return;
    patchClasses(multiPanelEl, { 'is-instant': Boolean(instant && multiOpen) });
    patchAttr(multiPanelEl, 'hidden', !multiOpen);
    if (multiOpen) {
      renderCapsuleTelemetry();
      multiRunningWidget.refs.resumeTicker();
      positionFloatingElements();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => positionFloatingElements());
      }
    } else {
      multiRunningWidget.refs.pauseTicker();
    }
  }

  function canOpenHoverTooltip() {
    const curTel = telemetryStore.getState().telemetry;
    const hoverMods = normalizeClientHoverModules(curTel?.settings?.hoverModules);
    const curUpdateMode = normalizeClientUpdateMode(
      curTel?.settings?.pluginUpdateMode,
      curTel?.settings?.autoUpdatePlugin
    );
    const hasUpd = Boolean(curTel?.cloudStatus?.updateAvailable) && curUpdateMode !== 'off';
    return hoverMods.length > 0 || hasUpd;
  }

  function setTooltipOpen(nextOpen, { instant = false } = {}) {
    const targetOpen = Boolean(
      nextOpen && !popoverOpen && !(multiOpen && multiPinned) && canOpenHoverTooltip()
    );
    if (targetOpen && hoverLeaveTimer) {
      clearTimeout(hoverLeaveTimer);
      hoverLeaveTimer = null;
    }
    if (targetOpen && multiOpen && !multiPinned) {
      setMultiOpen(false);
    }
    if (tooltipOpen === targetOpen) return;
    tooltipOpen = targetOpen;
    patchClasses(hoverTipEl, { 'is-instant': Boolean(instant && targetOpen) });
    patchAttr(hoverTipEl, 'hidden', !tooltipOpen);
    if (tooltipOpen) {
      renderHoverWidgets();
      hoverWidgetHost.resumeTickers();
      positionFloatingElements();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => positionFloatingElements());
      }
    } else {
      hoverWidgetHost.pauseTickers();
    }
  }

  function setPopoverOpen(nextOpen, { instant = false } = {}) {
    const targetOpen = Boolean(nextOpen);
    if (targetOpen) {
      setTooltipOpen(false);
      if (multiOpen) {
        setMultiOpen(false);
      }
    }
    if (popoverOpen === targetOpen) return;
    popoverOpen = targetOpen;
    patchClasses(capsuleBtn, { 'is-open': popoverOpen });
    patchClasses(popoverEl, { 'is-instant': Boolean(instant && popoverOpen) });
    patchAttr(capsuleBtn, 'aria-expanded', popoverOpen ? 'true' : 'false');
    patchAttr(popoverEl, 'hidden', !popoverOpen);
    uiStore.setState({ monitorVisible: popoverOpen && !document.hidden }, { sync: true });
    if (popoverOpen) {
      positionFloatingElements();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          positionFloatingElements();
          refreshActiveViewScrollbars();
        });
      } else {
        refreshActiveViewScrollbars();
      }
    }
  }

  function applyCapsuleSlots(slotKeys, slotCtx) {
    syncCapsuleSlotNodes(capsuleSlots, capsuleSeps, slotKeys, slotCtx);
  }

  function renderMultiRunningPanel(
    rawRunningList,
    runningCount,
    runningSubCount,
    hostRouteConversationId,
    runningSwarmCount = 0
  ) {
    if (!multiOpen || document.hidden) {
      multiRunningWidget.refs.pauseTicker();
      return;
    }
    const isPureSwarm = runningSubCount > 0 && runningSwarmCount === runningSubCount;
    patchText(
      multiRunningMetaEl,
      runningCount > 0
        ? runningSubCount > 0
          ? t(isPureSwarm ? 'multi.metaWithSwarm' : 'multi.metaWithSubs', {
              main: runningCount,
              subs: runningSubCount,
            })
          : t('multi.metaMainOnly', { main: runningCount })
        : t('multi.allIdle')
    );
    patchAttr(multiEmptyEl, 'hidden', runningCount > 0);
    multiRunningWidget.refs.update({
      items: rawRunningList,
      hostRouteConversationId,
    });
  }

  function renderHoverWidgets() {
    const { telemetry, minuteTick } = telemetryStore.getState();
    hoverWidgetHost.update({
      moduleKeys: normalizeClientHoverModules(telemetry?.settings?.hoverModules),
      data: telemetry,
      minuteTick: Number(minuteTick || Math.floor(Date.now() / 30000)),
    });
  }

  // --- 4. 实时遥测状态绑定（双胶囊与多会话/动态组件浮层就地更新，零硬编码、零布局跳动） ---
  function renderCapsuleTelemetry() {
    if (disposed) return;
    const telSt = telemetryStore.getState();
    const uiSt = uiStore.getState();
    const telemetry = telSt.telemetry;

    setI18nLanguage(telemetry?.settings?.language);
    syncPortalAppearance(telemetry?.settings);
    syncCapsuleOsAttr();

    const showMulti = telemetry?.settings?.showTopbarMultiSession !== false;
    patchAttr(multiBtn, 'hidden', !showMulti);
    patchAttr(capsuleHost, 'data-multi', showMulti ? 'on' : 'off');
    if (!showMulti && multiOpen) {
      setMultiOpen(false);
    }

    const slotKeys = normalizeClientTopbarSlots(telemetry?.settings?.topbarCapsuleSlots);
    const layoutInputsChanged =
      showMulti !== lastShowMulti || slotKeys.length !== lastSlotCount;
    if (layoutInputsChanged) {
      lastShowMulti = showMulti;
      lastSlotCount = slotKeys.length;
      updateResponsiveLayout();
    }

    if (!telemetry) {
      patchClasses(multiBtn, { 'is-running': false, 'is-waiting': false });
      patchCapsuleOdometerText(multiLabel, t('capsule.multiZero'), { resetKey: 'multi' });
      patchText(multiRunningMetaEl, t('multi.loading'));
      multiRunningWidget.refs.stopLiveTicker();

      applyCapsuleSlots(slotKeys, { hasTelemetry: false });
      return;
    }

    const { agents, scopedConv: overviewScopedConv, ctxAgent, aggregated } =
      resolveScopedConversation(telemetry, 'all', uiSt.ctxInspectorAgentId);
    const { scopedConv: capsuleScopedConv } = resolveScopedConversation(
      telemetry,
      uiSt.selectedAgentScope,
      uiSt.ctxInspectorAgentId
    );
    const overviewActive = overviewScopedConv || telemetry.activeConversation || {};
    const slotCtx = buildCapsuleSlotContext(telemetry, {
      scopedConv: capsuleScopedConv,
      overviewConv: overviewActive,
      ctxAgent,
      aggregated,
    });
    const {
      rawRunningList,
      runningCount,
      runningSubCount,
      runningSwarmCount,
      hasWaiting,
      multiBtnText,
    } = resolveMultiSessionCapsuleState(telemetry, {
      agents,
      aggregated,
      latestTokPerSec: overviewActive.latestTokPerSec ?? null,
      contextUsedPct: slotCtx.usedPct,
    });

    patchClasses(multiBtn, {
      'is-running': runningCount > 0 && !hasWaiting,
      'is-waiting': runningCount > 0 && hasWaiting,
    });
    patchCapsuleOdometerText(multiLabel, multiBtnText, { resetKey: 'multi' });

    renderMultiRunningPanel(
      rawRunningList,
      runningCount,
      runningSubCount,
      telSt.hostRouteConversationId,
      runningSwarmCount
    );

    patchClasses(capsuleBtn, { 'is-running': slotCtx.isRunning });
    applyCapsuleSlots(slotKeys, slotCtx);

    const updateMode = normalizeClientUpdateMode(
      telemetry.settings?.pluginUpdateMode,
      telemetry.settings?.autoUpdatePlugin
    );
    const showUpdatePrompt =
      Boolean(telemetry.cloudStatus?.updateAvailable) && updateMode !== 'off';
    const latestVer = telemetry.cloudStatus?.latestPluginVersion || '';
    patchAttr(updateDot, 'hidden', !showUpdatePrompt);
    patchAttr(topbarUpdateBtn, 'hidden', !showUpdatePrompt);
    patchAttr(hoverUpdateBar, 'hidden', !showUpdatePrompt);
    if (showUpdatePrompt) {
      if (!isTopbarUpdating) {
        patchText(topbarUpdateLabel, latestVer ? `v${latestVer}` : t('capsule.newVersion'));
      }
      patchAttr(topbarUpdateBtn, 'title', t('capsule.ariaUpdateTitle'));
      patchText(
        hoverUpdateVerText,
        latestVer
          ? t('capsule.hoverNewVer', { ver: latestVer })
          : t('capsule.hoverNewVerGeneric')
      );
      const isComposerDock = capsuleHost.getAttribute('data-dock') === 'composer';
      patchText(
        hoverUpdateHintText,
        latestVer
          ? isComposerDock
            ? t('capsule.hoverUpdateHintComposer', { ver: latestVer })
            : t('capsule.hoverUpdateHintTopbar', { ver: latestVer })
          : isComposerDock
            ? t('capsule.hoverUpdateHintComposerGeneric')
            : t('capsule.hoverUpdateHintTopbarGeneric')
      );
    }
    if (showUpdatePrompt !== lastShowUpdate) {
      lastShowUpdate = showUpdatePrompt;
      updateResponsiveLayout();
    }

    // --- 同步动态悬停组件宿主（0 项且无更新提示时自动关闭悬停窗，点击完整浮窗不受影响） ---
    const hoverModuleKeys = normalizeClientHoverModules(telemetry.settings?.hoverModules);
    patchAttr(hoverWidgetsContainer, 'hidden', hoverModuleKeys.length === 0);
    if (hoverModuleKeys.length === 0 && !showUpdatePrompt && tooltipOpen) {
      setTooltipOpen(false);
    }
    if (tooltipOpen) {
      renderHoverWidgets();
      positionFloatingElements();
    }
  }

  let lastAppliedMountMode = normalizeClientWindowMountMode(
    telemetryStore.getState().telemetry?.settings?.windowMountMode,
    telemetryStore.getState().telemetry?.settings?.enableWindowOverlay
  );

  const unsubStore = telemetryStore.subscribe(
    (st) => ({
      syncState: st.syncState,
      telemetry: st.telemetry,
      minuteTick: st.minuteTick,
      selectedConversationId: st.selectedConversationId,
    }),
    (slice) => {
      const nextMountMode = normalizeClientWindowMountMode(
        slice.telemetry?.settings?.windowMountMode,
        slice.telemetry?.settings?.enableWindowOverlay
      );
      if (slice.telemetry?.settings?.enableWindowOverlay === false || nextMountMode === 'sidebar') {
        if (popoverOpen) setPopoverOpen(false);
        if (multiOpen) setMultiOpen(false);
      } else if (nextMountMode !== lastAppliedMountMode) {
        lastAppliedMountMode = nextMountMode;
        ensureCapsuleDocked();
      }
      lastAppliedMountMode = nextMountMode;
      renderCapsuleTelemetry();
      if (popoverOpen) {
        positionFloatingElements();
      }
    }
  );

  const unsubUiScope = uiStore.subscribe(
    (st) => ({
      selectedAgentScope: st.selectedAgentScope,
      ctxInspectorAgentId: st.ctxInspectorAgentId,
      activeView: st.activeView,
      stepsSubTab: st.stepsSubTab,
      settingsSubTab: st.settingsSubTab,
      settingsStructureTab: st.settingsStructureTab,
    }),
    () => {
      renderCapsuleTelemetry();
      if (popoverOpen) {
        positionFloatingElements();
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => {
            if (!disposed && popoverOpen) {
              positionFloatingElements();
              refreshActiveViewScrollbars();
            }
          });
        }
      }
    }
  );

  const unsubI18n = i18nStore.subscribe(
    (st) => st.locale,
    () => {
      patchAttr(multiBtn, 'aria-label', t('capsule.ariaMulti'));
      patchAttr(capsuleBtn, 'aria-label', t('capsule.ariaMonitor'));
      patchAttr(topbarUpdateBtn, 'aria-label', t('capsule.ariaUpdateTitle'));
      patchAttr(topbarUpdateBtn, 'title', t('capsule.ariaUpdateTitle'));
      patchAttr(multiPanelEl, 'aria-label', t('multi.ariaDialog'));
      patchAttr(popoverEl, 'aria-label', t('capsule.ariaMonitor'));
      patchText(multiPinBadge, t('multi.pinned'));
      patchText(multiEmptyTextEl, t('multi.empty'));
      patchText(multiTitleTextEl, t('multi.title'));
      renderCapsuleTelemetry();
    }
  );

  // --- 5. 宿主会话路由跟随与全局交互监听 ---
  function syncHostRouteIfChanged() {
    if (disposed) return;
    const currentRouteId = extractHostRouteCascadeId();
    if (currentRouteId === lastObservedRouteId) return;
    lastObservedRouteId = currentRouteId;
    const st = telemetryStore.getState();
    const nextSelectedId =
      currentRouteId && st.selectedConversationId && st.selectedConversationId !== currentRouteId
        ? ''
        : st.selectedConversationId;
    uiStore.setState({ selectedAgentScope: 'all', ctxInspectorAgentId: 'auto' });
    void selectConversation(nextSelectedId, { hostRouteConversationId: currentRouteId });
  }

  const onDocMouseDown = (e) => {
    if (popoverOpen && !isEventInside(e, popoverEl) && !isEventInside(e, capsuleHost)) {
      setPopoverOpen(false);
    }
    if (multiOpen && !isEventInside(e, multiPanelEl) && !isEventInside(e, capsuleHost)) {
      setMultiOpen(false);
    }
  };

  const onDocKeyDown = (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      if (popoverOpen) {
        setPopoverOpen(false);
      }
      if (multiOpen) {
        setMultiOpen(false);
      }
    }
  };

  const onWindowPointerMove = (e) => recordPointerCoords(e);
  const onWindowBlur = () => {
    hasPointerCoords = false;
    if (tooltipOpen) {
      setTooltipOpen(false);
    }
    if (multiOpen && !multiPinned) {
      setMultiOpen(false);
    }
  };
  const onWindowResize = () => updateResponsiveLayout();
  const onPopState = () => syncHostRouteIfChanged();
  const onDocFocusIn = () => syncHostRouteIfChanged();
  const onVisibilityChange = () => {
    if (document.hidden) {
      uiStore.setState({ monitorVisible: false });
      multiRunningWidget.refs.pauseTicker();
      hasPointerCoords = false;
      if (tooltipOpen) {
        setTooltipOpen(false);
      }
      if (multiOpen && !multiPinned) {
        setMultiOpen(false);
      }
      return;
    }
    if (!document.hidden && !disposed) {
      uiStore.setState({ monitorVisible: popoverOpen });
      if (multiOpen) renderCapsuleTelemetry();
      syncHostRouteIfChanged();
      void fetchTelemetry({ force: false });
    }
  };

  let hostDomObserver = null;
  try {
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => updateResponsiveLayout());
      if (document.body) resizeObserver.observe(document.body);
    }
    if (typeof MutationObserver !== 'undefined') {
      themeObserver = new MutationObserver(() => {
        syncWorkbenchThemeVars();
        syncPortalAppearance(telemetryStore.getState().telemetry?.settings);
      });
      if (document.head) {
        themeObserver.observe(document.head, {
          childList: true,
          characterData: true,
          subtree: true,
        });
      }
      if (document.documentElement) {
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme', 'data-vscode-theme-kind'],
        });
      }
      if (document.body) {
        themeObserver.observe(document.body, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme', 'data-vscode-theme-kind'],
        });
      }
      if (document.body) {
        hostDomObserver = new MutationObserver((records) => {
          if (
            Array.isArray(records) &&
            records.length > 0 &&
            records.every((r) => r?.target === capsuleHost || r?.target === portalHost)
          ) {
            return;
          }
          syncHostRouteIfChanged();
          if (!observedWorkbench) {
            ensureWorkbenchThemeObserved();
          }
          const dock = resolveRuntimeDockTarget();
          if (!isDockPlacementSynced(dock)) {
            scheduleDockSync();
          }
        });
        hostDomObserver.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-cascade-id', 'data-selected'],
        });
      }
    }
  } catch {
    // 忽略观察器初始化异常
  }

  document.addEventListener?.('mousedown', onDocMouseDown, true);
  document.addEventListener?.('keydown', onDocKeyDown);
  document.addEventListener?.('focusin', onDocFocusIn);
  document.addEventListener?.('visibilitychange', onVisibilityChange);
  window.addEventListener?.('pointermove', onWindowPointerMove, { passive: true });
  window.addEventListener?.('blur', onWindowBlur);
  window.addEventListener?.('resize', onWindowResize);
  window.addEventListener?.('popstate', onPopState);
  navigator?.windowControlsOverlay?.addEventListener?.('geometrychange', onWindowResize);

  const watchdogTimer = setInterval(() => {
    if (disposed) return;
    syncHostRouteIfChanged();
    ensureWorkbenchThemeObserved();
    const dock = resolveRuntimeDockTarget();
    if (!isDockPlacementSynced(dock)) {
      ensureCapsuleDocked();
    }
  }, 1200);

  ensureCapsuleDocked();
  renderCapsuleTelemetry();
  const allowMultiCarryOver =
    telemetryStore.getState().telemetry?.settings?.showTopbarMultiSession !== false;
  if (carryOverPopoverOpen) {
    setPopoverOpen(true, { instant: true });
  } else if (carryOverMultiPinnedOpen && allowMultiCarryOver) {
    setMultiOpen(true, { pinned: true, instant: true });
  } else if (carryOverMultiHoverOpen && allowMultiCarryOver) {
    setMultiOpen(true, { pinned: false, instant: true });
  } else if (carryOverTooltipOpen) {
    setTooltipOpen(true, { instant: true });
  }
  const stopPolling = startAsyncTelemetryLoop(2000);

  const handle = {
    bundleVersion,
    [WINDOW_OVERLAY_METHODS.ensureAlive]() {
      if (disposed) return false;
      return ensureCapsuleDocked();
    },
    [WINDOW_OVERLAY_METHODS.syncHostRoute]() {
      if (disposed) return false;
      syncHostRouteIfChanged();
      return true;
    },
    [WINDOW_OVERLAY_METHODS.updateBridge](nextBridge) {
      if (disposed || !nextBridge || typeof nextBridge !== 'object') return false;
      const port = Number(nextBridge.port || 0);
      const token = String(nextBridge.token || '');
      if (!Number.isInteger(port) || port <= 0 || !token) return false;
      const cur = readInjectedWindowBridge() || {};
      const portChanged = Number(cur.port || 0) !== port || String(cur.token || '') !== token;
      cur.port = port;
      cur.token = token;
      if (portChanged) {
        cur.transportMode = 'http';
      }
      window[WINDOW_BRIDGE_KEY] = cur;
      void fetchTelemetry({ force: false });
      return true;
    },
    getTelemetrySnapshot() {
      return telemetryStore.getState().telemetry;
    },
    getLastPointer() {
      return hasPointerCoords ? { x: lastPointerX, y: lastPointerY } : null;
    },
    [WINDOW_OVERLAY_METHODS.deliverRpc](responses) {
      if (disposed) return 0;
      return deliverCdpBridgeResponses(responses);
    },
    open() {
      setPopoverOpen(true);
    },
    close() {
      setPopoverOpen(false);
    },
    toggle() {
      setPopoverOpen(!popoverOpen);
    },
    openMulti(pinned = true) {
      setMultiOpen(true, { pinned: Boolean(pinned) });
    },
    closeMulti() {
      setMultiOpen(false);
    },
    isOpen: () => popoverOpen,
    isHoverOpen: () => tooltipOpen,
    isMultiOpen: () => multiOpen,
    isMultiHoverOpen: () => Boolean(multiOpen && !multiPinned),
    isMultiPinnedOpen: () => Boolean(multiOpen && multiPinned),
    getLayoutMode: () => layoutMode,
    [WINDOW_OVERLAY_METHODS.getDockKind]: () => String(capsuleHost.getAttribute('data-dock') || ''),
    [WINDOW_OVERLAY_METHODS.getMountMode]: () => lastAppliedMountMode,
    [WINDOW_OVERLAY_METHODS.applyMountMode](nextMode) {
      if (disposed) return false;
      const normalized = normalizeClientWindowMountMode(nextMode, nextMode !== 'sidebar');
      const bridgeConfig = readInjectedWindowBridge();
      if (bridgeConfig) bridgeConfig.mountMode = normalized;
      const curTel = telemetryStore.getState().telemetry;
      if (curTel?.settings) {
        telemetryStore.setState({
          telemetry: {
            ...curTel,
            settings: {
              ...curTel.settings,
              windowMountMode: normalized,
              enableWindowOverlay: normalized !== 'sidebar',
            },
          },
        });
      }
      lastAppliedMountMode = normalized;
      return ensureCapsuleDocked();
    },
    [WINDOW_OVERLAY_METHODS.dispose]() {
      if (disposed) return;
      disposed = true;
      clearInterval(watchdogTimer);
      if (hoverLeaveTimer) {
        clearTimeout(hoverLeaveTimer);
        hoverLeaveTimer = null;
      }
      if (multiLeaveTimer) {
        clearTimeout(multiLeaveTimer);
        multiLeaveTimer = null;
      }
      multiRunningWidget.refs.stopLiveTicker();
      if (dockRafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(dockRafId);
        dockRafId = 0;
      }
      stopPolling();
      stopAsyncTelemetryLoop();
      unsubStore();
      unsubUiScope();
      unsubI18n();
      try {
        resizeObserver?.disconnect();
      } catch {}
      try {
        hostDomObserver?.disconnect();
      } catch {}
      try {
        themeObserver?.disconnect();
      } catch {}
      document.removeEventListener?.('mousedown', onDocMouseDown, true);
      document.removeEventListener?.('keydown', onDocKeyDown);
      document.removeEventListener?.('focusin', onDocFocusIn);
      document.removeEventListener?.('visibilitychange', onVisibilityChange);
      window.removeEventListener?.('pointermove', onWindowPointerMove);
      window.removeEventListener?.('blur', onWindowBlur);
      window.removeEventListener?.('resize', onWindowResize);
      window.removeEventListener?.('popstate', onPopState);
      navigator?.windowControlsOverlay?.removeEventListener?.('geometrychange', onWindowResize);
      restorePatchedActionToolbar();
      try {
        hoverWidgetHost.destroy();
      } catch {}
      try {
        appInstance.destroy();
      } catch {}
      try {
        capsuleHost.remove();
      } catch {}
      try {
        portalHost.remove();
      } catch {}
      if (window[WINDOW_OVERLAY_KEY] === handle) {
        delete window[WINDOW_OVERLAY_KEY];
      }
    },
  };

  window[WINDOW_OVERLAY_KEY] = handle;
  return handle;
}
return { computeCapsuleLayoutMode, mountWindowOverlay };
})();

// --- src/main.js ---
(() => {
/**
 * @fileoverview Async entry point for Antigravity Usage & Speed Monitor.
 * Automatically branches between Auxiliary Sidebar Webview mode (`#app-root`)
 * and Main Window Dual-Mount Overlay mode (`window.__AGUsageMonitorBridge`).
 */


async function bootstrapApp(mountTarget = document.getElementById('app-root')) {
  if (!mountTarget) return null;
  const appInstance = App();
  mountTarget.appendChild(appInstance.el);

  const syncDocAppearance = (settings) => {
    setI18nLanguage(settings?.language);
    if (typeof document !== 'undefined' && document.documentElement) {
      applyAppearanceToRoot(document.documentElement, settings, { includeFontScale: true });
    }
  };
  syncDocAppearance(telemetryStore.getState().telemetry?.settings);

  const unsubAppearance = telemetryStore.subscribe(
    (st) => st.telemetry?.settings,
    syncDocAppearance
  );

  let hostThemeObserver = null;
  let colorSchemeMql = null;
  const onHostThemeChange = () => {
    syncDocAppearance(telemetryStore.getState().telemetry?.settings);
  };
  try {
    if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
      hostThemeObserver = new MutationObserver(onHostThemeChange);
      if (document.documentElement) {
        hostThemeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme', 'data-vscode-theme-kind'],
        });
      }
      if (document.body) {
        hostThemeObserver.observe(document.body, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme', 'data-vscode-theme-kind'],
        });
      }
      if (document.head) {
        hostThemeObserver.observe(document.head, {
          childList: true,
          characterData: true,
          subtree: true,
        });
      }
    }
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      colorSchemeMql = window.matchMedia('(prefers-color-scheme: dark)');
      colorSchemeMql?.addEventListener?.('change', onHostThemeChange);
    }
  } catch {
    // ignore observer setup errors in constrained environments
  }

  const stopPolling = startAsyncTelemetryLoop(2000);
  return {
    appInstance,
    stopPolling: () => {
      hostThemeObserver?.disconnect?.();
      colorSchemeMql?.removeEventListener?.('change', onHostThemeChange);
      unsubAppearance();
      stopPolling();
    },
  };
}

function startEntry() {
  if (isWindowOverlayMode()) {
    mountWindowOverlay();
    return;
  }
  if (
    typeof window !== 'undefined' &&
    !window.sidecar?.fetch &&
    typeof document !== 'undefined' &&
    document.documentElement
  ) {
    document.documentElement.setAttribute('data-standalone', 'true');
  }
  bootstrapApp();
}

function init() {
  if (typeof document === 'undefined') return;
  if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', () => {
      startEntry();
    });
  } else {
    startEntry();
  }
}

init();
})();
})();
