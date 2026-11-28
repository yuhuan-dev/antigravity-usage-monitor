/**
 * @fileoverview 前后端与 CLI 共用的偏好设置枚举常量、默认值与无状态纯函数归一化规则。
 */

export const SUPPORTED_LOCALE_ENTRIES = Object.freeze([
  Object.freeze({
    locale: 'zh-CN',
    nativeName: '简体中文',
    prefixes: Object.freeze(['zh']),
  }),
  Object.freeze({
    locale: 'zh-TW',
    nativeName: '繁體中文',
    exactTags: Object.freeze(['zh-tw', 'zh-hk', 'zh-mo']),
    prefixes: Object.freeze(['zh-hant']),
  }),
  Object.freeze({
    locale: 'en-US',
    nativeName: 'English',
    prefixes: Object.freeze(['en']),
  }),
  Object.freeze({
    locale: 'ja-JP',
    nativeName: '日本語',
    prefixes: Object.freeze(['ja']),
  }),
  Object.freeze({
    locale: 'ko-KR',
    nativeName: '한국어',
    prefixes: Object.freeze(['ko']),
  }),
  Object.freeze({
    locale: 'de-DE',
    nativeName: 'Deutsch',
    prefixes: Object.freeze(['de']),
  }),
  Object.freeze({
    locale: 'fr-FR',
    nativeName: 'Français',
    prefixes: Object.freeze(['fr']),
  }),
  Object.freeze({
    locale: 'vi-VN',
    nativeName: 'Tiếng Việt',
    prefixes: Object.freeze(['vi']),
  }),
]);

export const SUPPORTED_LOCALES = Object.freeze(
  SUPPORTED_LOCALE_ENTRIES.map((entry) => entry.locale)
);
export const SUPPORTED_LANGUAGES = Object.freeze(['auto', ...SUPPORTED_LOCALES]);

const LOCALE_EXACT_TAG_MAP = new Map();
const LOCALE_PREFIX_MATCHERS = [];
for (const entry of SUPPORTED_LOCALE_ENTRIES) {
  LOCALE_EXACT_TAG_MAP.set(entry.locale.toLowerCase(), entry.locale);
  if (Array.isArray(entry.exactTags)) {
    for (const tag of entry.exactTags) {
      LOCALE_EXACT_TAG_MAP.set(String(tag).toLowerCase(), entry.locale);
    }
  }
  if (Array.isArray(entry.prefixes)) {
    for (const prefix of entry.prefixes) {
      LOCALE_PREFIX_MATCHERS.push({
        prefix: String(prefix).toLowerCase(),
        locale: entry.locale,
      });
    }
  }
}
// Match more specific subtags (e.g. `zh-hant`) before broader language prefixes (`zh`)
LOCALE_PREFIX_MATCHERS.sort((a, b) => b.prefix.length - a.prefix.length);

export const THEME_ACCENT_KEYS = Object.freeze([
  'host',
  'blue',
  'emerald',
  'amber',
  'violet',
  'cyan',
  'rose',
]);

export const FONT_SCALE_KEYS = Object.freeze(['sm', 'md', 'lg', 'xl']);

export const TOPBAR_SLOT_KEYS = Object.freeze([
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
  'argon_weekly',
  'claude_5h',
  'claude_weekly',
]);

export const DEFAULT_TOPBAR_SLOTS = Object.freeze(['tps', 'ttft', 'context']);
export const MIN_TOPBAR_SLOTS = 1;
export const MAX_TOPBAR_SLOTS = 5;

export const DEFAULT_CLI_STATUSLINE_SLOTS = Object.freeze([
  'tps',
  'ttft',
  'session_cost',
  'quota_auto',
  'context',
]);
export const MIN_CLI_STATUSLINE_SLOTS = 1;
export const MAX_CLI_STATUSLINE_SLOTS = 6;
export const CLI_STATUSLINE_PRESETS = Object.freeze({
  compact: Object.freeze(['tps', 'ttft', 'context']),
  balanced: DEFAULT_CLI_STATUSLINE_SLOTS,
  full: Object.freeze(['tps', 'ttft', 'cache_hit', 'session_cost', 'quota_auto', 'context']),
});

export const OVERVIEW_MODULE_KEYS = Object.freeze([
  'metrics',
  'context',
  'quotas',
  'live_tasks',
]);

export const DEFAULT_OVERVIEW_MODULES = Object.freeze([
  'metrics',
  'context',
  'quotas',
  'live_tasks',
]);

export const DEFAULT_HOVER_MODULES = Object.freeze(['metrics', 'context', 'quotas']);

export const METRIC_CARD_STYLES = Object.freeze(['medium', 'hybrid', 'large']);
export const HOVER_METRIC_STYLES = METRIC_CARD_STYLES;
export const DEFAULT_OVERVIEW_METRIC_STYLE = 'medium';
export const DEFAULT_HOVER_METRIC_STYLE = 'medium';
export const DEFAULT_HOVER_SYNC_OVERVIEW_METRICS = true;
export const MAX_LARGE_METRIC_SLOTS = 3;
export const METRIC_GRID_COLS = 12;
export const METRIC_GRID_ROWS = Object.freeze([1, 2]);
export const DEFAULT_METRIC_ROWS = 1;
export const DEFAULT_OVERVIEW_METRIC_ROWS = DEFAULT_METRIC_ROWS;
export const DEFAULT_HOVER_METRIC_ROWS = DEFAULT_METRIC_ROWS;
export const METRIC_CARD_SIZES = Object.freeze(['sm', 'third', 'wide', 'narrow', 'tall']);
export const DEFAULT_OVERVIEW_METRIC_SIZES = Object.freeze({});
export const DEFAULT_HOVER_METRIC_SIZES = Object.freeze({});
export const METRIC_TEXT_MODES = Object.freeze(['both', 'title', 'sub', 'none']);
export const DEFAULT_METRIC_TEXT_MODE = 'title';
export const DEFAULT_OVERVIEW_METRIC_TEXT_MODE = DEFAULT_METRIC_TEXT_MODE;
export const DEFAULT_HOVER_METRIC_TEXT_MODE = DEFAULT_METRIC_TEXT_MODE;
export const MAX_OVERVIEW_METRICS = 8;

export const OVERVIEW_METRIC_KEYS = Object.freeze([
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

export const DEFAULT_OVERVIEW_METRICS = Object.freeze([
  'tps',
  'ttft',
  'avg_tps',
  'step_cost',
]);
export const DEFAULT_HOVER_METRICS = DEFAULT_OVERVIEW_METRICS;

export const STEP_TABLE_COLUMN_KEYS = Object.freeze([
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

export const DEFAULT_STEP_TABLE_COLUMNS = Object.freeze([
  'step',
  'model',
  'tps',
  'ttft',
  'tokens_combo',
  'cache',
  'cost',
]);

export const DEFAULT_STEP_TOKEN_COMBO_FORMAT = 'context:in:cache';

export const STEP_TOKEN_SEGMENT_ALIASES = Object.freeze({
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

export const POPOVER_WIDTH_MODES = Object.freeze(['auto', 'custom']);
export const MIN_POPOVER_WIDTH = 440;
export const MAX_POPOVER_WIDTH = 1080;
export const DEFAULT_POPOVER_WIDTH = 580;

/**
 * 将任意 BCP-47 / POSIX 语言标签映射到 `SUPPORTED_LOCALES` 中的受支持界面 Locale。
 *
 * @param {unknown} rawTag
 * @param {string} [fallback='en-US']
 * @returns {string}
 */
export function resolveLocaleFromLanguageTag(rawTag, fallback = 'en-US') {
  const clean = String(rawTag ?? '')
    .trim()
    .replace(/_/g, '-')
    .replace(/\..*$/, '')
    .toLowerCase();
  if (!clean || clean === 'c' || clean === 'posix') return fallback;
  const exact = LOCALE_EXACT_TAG_MAP.get(clean);
  if (exact) return exact;
  for (let i = 0; i < LOCALE_PREFIX_MATCHERS.length; i += 1) {
    const { prefix, locale } = LOCALE_PREFIX_MATCHERS[i];
    if (clean === prefix || clean.startsWith(`${prefix}-`)) {
      return locale;
    }
  }
  return fallback;
}

/**
 * 归一化界面语言枚举（默认 `'auto'`，或 `SUPPORTED_LOCALES` 中任一受支持语言）。
 *
 * @param {unknown} lang
 * @returns {string}
 */
export function normalizeLanguageSetting(lang) {
  const raw = String(lang ?? '').trim();
  if (!raw) return 'auto';
  const lower = raw.toLowerCase().replace(/_/g, '-');
  if (lower === 'auto' || lower === 'system') return 'auto';
  const resolved = resolveLocaleFromLanguageTag(lower, /** @type {any} */ (''));
  return resolved || 'auto';
}

/**
 * 归一化主题强调色预设键（默认 `'host'` 跟随宿主原生主题）。
 *
 * @param {unknown} accent
 * @returns {'host'|'blue'|'emerald'|'amber'|'violet'|'cyan'|'rose'}
 */
export function normalizeThemeAccent(accent) {
  const clean = String(accent ?? '').trim().toLowerCase();
  return THEME_ACCENT_KEYS.includes(clean) ? /** @type {any} */ (clean) : 'host';
}

/**
 * 归一化面板字号档位（默认 `'md'` 标准 100%）。
 *
 * @param {unknown} scale
 * @returns {'sm'|'md'|'lg'|'xl'}
 */
export function normalizeFontScale(scale) {
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
export function normalizeModelDisplayMode(mode, legacyShowUpstream) {
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
 * 归一化悬浮主面板宽度模式（`'auto'` | `'custom'`，默认 `'auto'`）。
 *
 * @param {unknown} mode
 * @returns {'auto'|'custom'}
 */
export function normalizePopoverWidthMode(mode) {
  const m = String(mode ?? '').trim().toLowerCase();
  return m === 'custom' || m === 'fixed' ? 'custom' : 'auto';
}

/**
 * 归一化悬浮主面板自定义宽度像素值（范围 `440..1080`，默认 `580`）。
 *
 * @param {unknown} width
 * @returns {number}
 */
export function normalizePopoverWidth(width) {
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
export function parseStepTokenComboSegments(raw) {
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
export function normalizeStepTokenComboFormat(raw) {
  return parseStepTokenComboSegments(raw).join(':');
}

/**
 * 归一化插件更新策略枚举（兼容历史 `autoUpdatePlugin` 布尔开关，默认 `'manual'`）。
 *
 * @param {unknown} mode
 * @param {unknown} [legacyAutoUpdate]
 * @returns {'off'|'manual'|'auto'}
 */
export function normalizePluginUpdateMode(mode, legacyAutoUpdate) {
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
export function normalizeWindowMountMode(mode, legacyEnableOverlay) {
  const m = String(mode ?? '').trim().toLowerCase();
  if (m === 'composer' || m === 'input') return 'composer';
  if (m === 'sidebar' || m === 'sidebar_only' || m === 'off') return 'sidebar';
  if (m === 'dual' || m === 'topbar') return 'dual';
  if (legacyEnableOverlay === false) return 'sidebar';
  return 'dual';
}

export const VSCODE_MOUNT_MODES = Object.freeze(['composer', 'dual']);
export const DEFAULT_VSCODE_MOUNT_MODE = 'composer';

/**
 * 归一化标准 VS Code / VS Code Insiders 宿主挂载方式（默认 `'composer'` 输入框，可选 `'dual'` 顶部栏，严格拒绝 `'sidebar'`）。
 *
 * @param {unknown} mode
 * @returns {'composer'|'dual'}
 */
export function normalizeVsCodeMountMode(mode) {
  const m = String(mode ?? '').trim().toLowerCase();
  if (m === 'dual' || m === 'topbar') return 'dual';
  return 'composer';
}

/**
 * 归一化每周额度统计模式枚举（`'official'` | `'custom_tokens'` | `'custom_cost'`）。
 *
 * @param {unknown} mode
 * @returns {'official'|'custom_tokens'|'custom_cost'}
 */
export function normalizeWeeklyLimitMode(mode) {
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
export function normalizeTopbarCapsuleSlots(raw) {
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
 * 归一化 CLI 底部状态栏独立槽位配置（`null` 表示自动跟随宽屏默认或自定义顶栏槽位；
 * 支持预设名 `compact` / `balanced` / `full`、逗号分隔列表或数组，保留 1~6 个去重合法槽位）。
 *
 * @param {unknown} raw
 * @returns {string[]|null}
 */
export function normalizeCliStatusLineSlots(raw) {
  if (raw === undefined || raw === null) return null;
  let items = null;
  if (typeof raw === 'string') {
    const clean = raw.trim();
    const lower = clean.toLowerCase();
    if (!clean || lower === 'auto' || lower === 'default') {
      return null;
    }
    if (Object.prototype.hasOwnProperty.call(CLI_STATUSLINE_PRESETS, lower)) {
      return [...CLI_STATUSLINE_PRESETS[lower]];
    }
    items = clean.split(/[\s,|:]+/);
  } else if (Array.isArray(raw)) {
    items = raw;
  } else {
    return null;
  }
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const val = String(item ?? '').trim();
    if (!val || val === 'none') continue;
    const mapped = val === 'step_cost' ? 'cost' : val;
    if (!TOPBAR_SLOT_KEYS.includes(mapped) || seen.has(mapped)) continue;
    seen.add(mapped);
    out.push(mapped);
    if (out.length >= MAX_CLI_STATUSLINE_SLOTS) break;
  }
  return out.length >= MIN_CLI_STATUSLINE_SLOTS ? out : null;
}

/**
 * 解析当前生效的 CLI 底栏槽位列表：
 * 1. 若用户显式设置了 `cliStatusLineSlots`，优先使用；
 * 2. 若用户自定义了非默认 `topbarCapsuleSlots`，沿用其自定义顺序保持兼容；
 * 3. 否则采用面向宽终端的 5 槽默认组合（速度 / 首字 / 费用 / 配额 / 上下文）。
 *
 * @param {object|null|undefined} settings
 * @returns {string[]}
 */
export function resolveEffectiveCliStatusLineSlots(settings) {
  const customCli = normalizeCliStatusLineSlots(settings?.cliStatusLineSlots);
  if (customCli && customCli.length > 0) {
    return customCli;
  }
  const topbar = normalizeTopbarCapsuleSlots(settings?.topbarCapsuleSlots);
  const isDefaultTopbar =
    topbar.length === DEFAULT_TOPBAR_SLOTS.length &&
    topbar.every((k, i) => k === DEFAULT_TOPBAR_SLOTS[i]);
  if (!isDefaultTopbar) {
    return topbar;
  }
  return [...DEFAULT_CLI_STATUSLINE_SLOTS];
}

/**
 * 归一化实时监控指标矩阵的槽位与顺序（1~8 项，默认 4 项）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeOverviewMetrics(raw) {
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
    if (out.length >= MAX_OVERVIEW_METRICS) break;
  }
  return out.length > 0 ? out : ['tps'];
}

/**
 * 归一化实时监控视图展示的模块及上下顺序（1~4 项，默认 4 项全开）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeOverviewModules(raw) {
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
export function normalizeHoverModules(raw) {
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
 * 归一化实时指标卡片展示尺寸（兼容旧版 `'medium'` / `'hybrid'` / `'large'` 枚举）。
 *
 * @param {unknown} raw
 * @returns {'medium'|'hybrid'|'large'}
 */
export function normalizeMetricCardStyle(raw) {
  const val = String(raw ?? '').trim().toLowerCase();
  if (val === 'large' || val === 'sparkline' || val === 'trend') return 'large';
  if (val === 'hybrid' || val === 'mixed' || val === 'mix') return 'hybrid';
  return 'medium';
}

export const normalizeOverviewMetricStyle = normalizeMetricCardStyle;
export const normalizeHoverMetricStyle = normalizeMetricCardStyle;

/**
 * 归一化实时指标网格层高档位（严格限定 `1` 层或 `2` 层，兼容旧版 `'hybrid'` 自动升级为 `2` 层）。
 *
 * @param {unknown} raw
 * @param {unknown} [legacyStyle]
 * @returns {1|2}
 */
export function normalizeMetricGridRows(raw, legacyStyle) {
  if (raw === 2 || raw === '2') return 2;
  if (raw === 1 || raw === '1') return 1;
  if (typeof raw === 'string') {
    const lower = raw.trim().toLowerCase();
    if (lower === '2' || lower === 'two' || lower === 'double') return 2;
    if (lower === '1' || lower === 'one' || lower === 'single') return 1;
  }
  if (legacyStyle !== undefined && normalizeMetricCardStyle(legacyStyle) === 'hybrid') {
    return 2;
  }
  return DEFAULT_METRIC_ROWS;
}

export const normalizeOverviewMetricRows = normalizeMetricGridRows;
export const normalizeHoverMetricRows = normalizeMetricGridRows;

/**
 * 归一化单张实时指标卡片的 12 列 Bento 网格尺寸：
 * - `'sm'`（小 1×1，占 3/12 列）
 * - `'third'`（中 1/3 宽，占 4/12 列，每行 3 张）
 * - `'wide'`（宽 2×1，占 6/12 列，每行 2 张）
 * - `'narrow'`（竖 1×2，占 3/12 列 × 2 层）
 * - `'tall'`（大 2×2，占 6/12 列 × 2 层）
 *
 * @param {unknown} raw
 * @returns {'sm'|'third'|'wide'|'narrow'|'tall'}
 */
export function normalizeMetricCardSize(raw) {
  const val = String(raw ?? '').trim().toLowerCase();
  if (val === 'tall' || val === 'large' || val === 'lg' || val === '2x2' || val === 'hero') {
    return 'tall';
  }
  if (val === 'narrow' || val === 'col' || val === 'slim' || val === 'vertical' || val === '1x2') {
    return 'narrow';
  }
  if (val === 'wide' || val === '2x1' || val === 'trend' || val === 'half') {
    return 'wide';
  }
  if (
    val === 'third' ||
    val === 'md' ||
    val === 'medium_trend' ||
    val === '1/3' ||
    val === '3up' ||
    val === '1.33x1' ||
    val === '1.333x1' ||
    val === 'tri'
  ) {
    return 'third';
  }
  return 'sm';
}

/**
 * 归一化实时指标单卡尺寸映射表（仅持久化非 `'sm'` 项；兼容旧版 `large` / `hybrid` 样式自动派生）。
 *
 * @param {unknown} raw
 * @param {string[]} [metricsList]
 * @param {unknown} [legacyStyle]
 * @returns {Record<string, 'third'|'wide'|'narrow'|'tall'>}
 */
export function normalizeMetricCardSizes(raw, metricsList = null, legacyStyle = undefined) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      const cleanKey = String(k ?? '').trim();
      const mappedKey = cleanKey === 'cost' ? 'step_cost' : cleanKey;
      if (!OVERVIEW_METRIC_KEYS.includes(mappedKey)) continue;
      const size = normalizeMetricCardSize(v);
      if (size !== 'sm') {
        out[mappedKey] = size;
      }
    }
    return out;
  }
  if (legacyStyle !== undefined) {
    const style = normalizeMetricCardStyle(legacyStyle);
    const list = Array.isArray(metricsList) && metricsList.length > 0
      ? metricsList
      : DEFAULT_OVERVIEW_METRICS;
    if (style === 'large') {
      const out = {};
      for (const key of list) {
        if (OVERVIEW_METRIC_KEYS.includes(key)) out[key] = 'third';
      }
      return out;
    }
    if (style === 'hybrid' && list[0] && OVERVIEW_METRIC_KEYS.includes(list[0])) {
      const out = { [list[0]]: 'tall' };
      if (list.length === 3) {
        if (list[1] && OVERVIEW_METRIC_KEYS.includes(list[1])) out[list[1]] = 'wide';
        if (list[2] && OVERVIEW_METRIC_KEYS.includes(list[2])) out[list[2]] = 'wide';
      }
      return out;
    }
  }
  return {};
}

export const normalizeOverviewMetricSizes = normalizeMetricCardSizes;
export const normalizeHoverMetricSizes = normalizeMetricCardSizes;

/**
 * 归一化实时指标卡片辅助文字显示模式（`'both'` 都有 / `'title'` 仅标题 / `'sub'` 仅副标 / `'none'` 仅数值）。
 *
 * @param {unknown} raw
 * @returns {'both'|'title'|'sub'|'none'}
 */
export function normalizeMetricTextMode(raw) {
  const val = String(raw ?? '').trim().toLowerCase();
  if (val === 'both' || val === 'all' || val === 'full') {
    return 'both';
  }
  if (val === 'title' || val === 'title_only' || val === 'label' || val === 'label_only') {
    return 'title';
  }
  if (val === 'sub' || val === 'sub_only' || val === 'subtitle' || val === 'meta') {
    return 'sub';
  }
  if (val === 'none' || val === 'minimal' || val === 'value' || val === 'value_only') {
    return 'none';
  }
  return DEFAULT_METRIC_TEXT_MODE;
}

export const normalizeOverviewMetricTextMode = normalizeMetricTextMode;
export const normalizeHoverMetricTextMode = normalizeMetricTextMode;

/**
 * 根据层数与单卡尺寸表反推兼容旧版的 `metricStyle` 摘要值（`'medium'` | `'hybrid'` | `'large'`）。
 *
 * @param {number} rows
 * @param {string[]} metrics
 * @param {Record<string, string>} sizesMap
 * @returns {'medium'|'hybrid'|'large'}
 */
export function deriveMetricCardStyleFromLayout(rows, metrics, sizesMap) {
  const safeRows = normalizeMetricGridRows(rows);
  const list = Array.isArray(metrics) ? metrics : [];
  if (safeRows === 1 && list.length > 0) {
    const effSizes = list.map((key) => {
      const s = normalizeMetricCardSize(sizesMap?.[key]);
      if (s === 'tall') return 'wide';
      if (s === 'narrow') return 'sm';
      return s;
    });
    if (effSizes.every((s) => s === 'sm')) return 'medium';
    const checkLen = Math.min(MAX_LARGE_METRIC_SLOTS, effSizes.length);
    if (effSizes.slice(0, checkLen).every((s) => s === 'third' || s === 'wide')) return 'large';
  }
  return 'hybrid';
}

function getMetricCardColSpan(effSize) {
  if (effSize === 'wide' || effSize === 'tall') return 6;
  if (effSize === 'third') return 4;
  return 3;
}

function pushMetricGhostRunsForRow(occRow, rowNumber, out) {
  let c = 0;
  while (c < METRIC_GRID_COLS) {
    if (occRow[c]) {
      c += 1;
      continue;
    }
    const start = c;
    while (c < METRIC_GRID_COLS && !occRow[c]) c += 1;
    let pos = start;
    let rem = c - start;
    const step = rem === 4 || rem === 8 ? 4 : 3;
    while (rem > 0) {
      const span = rem >= step ? step : rem;
      out.push({ colStart: pos + 1, colSpan: span, rowStart: rowNumber });
      pos += span;
      rem -= span;
    }
  }
}

/**
 * 将实时指标列表与单卡尺寸打包进 12 列 × (1 或 2) 层固定高度的 Bento 网格：
 * - 每张卡片严格按真实有效尺寸占格（`sm` 3/12、`third` 4/12、`wide` 6/12、`narrow` 3/12×2、`tall` 6/12×2），绝不偷偷变形；
 * - 1 层模式下 `tall` (2×2) 视觉降级为 `wide` (2×1)、`narrow` (1×2) 降级为 `sm` (1×1)，同时完整保留原始偏好；
 * - 2 层模式下支持上 3 张 `third` + 下 4 张 `sm`、两层 6 张 `third` 等自由组合；若前置单行卡占满第 1 行导致后续跨双层卡片（1×2 / 2×2）放不下，自动将前置卡片紧凑折入左侧列区腾出右侧整列；
 * - 编辑态 (`includeGhostCells: true`) 在未占用连续列段按 1/3 或 1/4 宽度合并渲染诚实虚线引导空槽。
 *
 * @param {{
 *   rows?: 1|2|number,
 *   metrics?: string[],
 *   sizes?: Record<string, string>,
 *   includeGhostCells?: boolean,
 * }} options
 */
export function packMetricBentoLayout({
  rows = DEFAULT_METRIC_ROWS,
  metrics = DEFAULT_OVERVIEW_METRICS,
  sizes = {},
  includeGhostCells = false,
} = {}) {
  const safeRows = normalizeMetricGridRows(rows);
  const list = normalizeOverviewMetrics(metrics);
  const sizesMap = normalizeMetricCardSizes(sizes);
  const resolveEffSize = (key) => {
    const rawSize = normalizeMetricCardSize(sizesMap[key]);
    if (safeRows === 1) {
      if (rawSize === 'tall') return 'wide';
      if (rawSize === 'narrow') return 'sm';
    }
    return rawSize;
  };

  const occ = Array.from({ length: safeRows }, () => Array(METRIC_GRID_COLS).fill(false));
  const placements = [];
  const overflowKeys = [];

  function tryRepackForTwoRowCard(existingPlacements, newWidth) {
    if (safeRows !== 2) return null;
    const leftLimit = METRIC_GRID_COLS - newWidth;
    if (leftLimit < 3) return null;
    const leftOcc = [Array(leftLimit).fill(false), Array(leftLimit).fill(false)];
    const coords = new Array(existingPlacements.length);

    // First preserve/place existing 2-row items inside [0 .. leftLimit - 1]
    for (let idx = 0; idx < existingPlacements.length; idx += 1) {
      const item = existingPlacements[idx];
      if (item.rowSpan !== 2) continue;
      const w = item.colSpan;
      if (w > leftLimit) return null;
      let fitCol = -1;
      const prefCol = item.colStart - 1;
      if (prefCol >= 0 && prefCol + w <= leftLimit) {
        let prefFree = true;
        for (let dc = 0; dc < w; dc += 1) {
          if (leftOcc[0][prefCol + dc] || leftOcc[1][prefCol + dc]) {
            prefFree = false;
            break;
          }
        }
        if (prefFree) fitCol = prefCol;
      }
      if (fitCol < 0) {
        for (let c = 0; c <= leftLimit - w; c += 1) {
          let free = true;
          for (let dc = 0; dc < w; dc += 1) {
            if (leftOcc[0][c + dc] || leftOcc[1][c + dc]) {
              free = false;
              break;
            }
          }
          if (free) {
            fitCol = c;
            break;
          }
        }
      }
      if (fitCol < 0) return null;
      for (let dc = 0; dc < w; dc += 1) {
        leftOcc[0][fitCol + dc] = true;
        leftOcc[1][fitCol + dc] = true;
      }
      coords[idx] = { colStart: fitCol + 1, rowStart: 1 };
    }

    // Then pack all existing 1-row items cleanly into remaining slots of [0 .. leftLimit - 1]
    for (let idx = 0; idx < existingPlacements.length; idx += 1) {
      const item = existingPlacements[idx];
      if (item.rowSpan !== 1) continue;
      const w = item.colSpan;
      if (w > leftLimit) return null;
      let fit = null;
      for (let r = 0; r < 2 && !fit; r += 1) {
        for (let c = 0; c <= leftLimit - w && !fit; c += 1) {
          let free = true;
          for (let dc = 0; dc < w; dc += 1) {
            if (leftOcc[r][c + dc]) {
              free = false;
              break;
            }
          }
          if (free) {
            for (let dc = 0; dc < w; dc += 1) {
              leftOcc[r][c + dc] = true;
            }
            fit = { colStart: c + 1, rowStart: r + 1 };
          }
        }
      }
      if (!fit) return null;
      coords[idx] = fit;
    }

    return { leftOcc, leftLimit, coords };
  }

  for (let i = 0; i < list.length; i += 1) {
    const key = list[i];
    const rawSize = normalizeMetricCardSize(sizesMap[key]);
    const effSize = resolveEffSize(key);
    const w = getMetricCardColSpan(effSize);
    const h = effSize === 'narrow' || effSize === 'tall' ? 2 : 1;
    let placed = false;

    for (let r = 0; r <= safeRows - h && !placed; r += 1) {
      for (let c = 0; c <= METRIC_GRID_COLS - w && !placed; c += 1) {
        let free = true;
        for (let dr = 0; dr < h && free; dr += 1) {
          for (let dc = 0; dc < w; dc += 1) {
            if (occ[r + dr][c + dc]) {
              free = false;
              break;
            }
          }
        }
        if (free) {
          for (let dr = 0; dr < h; dr += 1) {
            for (let dc = 0; dc < w; dc += 1) {
              occ[r + dr][c + dc] = true;
            }
          }
          placements.push({
            key,
            index: i,
            rawSize,
            size: effSize,
            isTrend: effSize !== 'sm',
            isThird: effSize === 'third',
            isWide: effSize === 'wide',
            isNarrow: effSize === 'narrow',
            isTall: effSize === 'tall',
            colStart: c + 1,
            colSpan: w,
            rowStart: r + 1,
            rowSpan: h,
          });
          placed = true;
        }
      }
    }

    // 2 层模式下，若前置单行卡占满第 1 行导致后续跨双层卡片（2×2 或 1×2）放不下，尝试将前置卡片紧凑折入左侧列区，把右侧整列让给跨双层卡片
    if (!placed && safeRows === 2 && h === 2) {
      const repacked = tryRepackForTwoRowCard(placements, w);
      if (repacked) {
        for (let r = 0; r < 2; r += 1) {
          for (let c = 0; c < METRIC_GRID_COLS; c += 1) {
            occ[r][c] = c < repacked.leftLimit ? repacked.leftOcc[r][c] : false;
          }
        }
        for (let k = 0; k < placements.length; k += 1) {
          placements[k].colStart = repacked.coords[k].colStart;
          placements[k].rowStart = repacked.coords[k].rowStart;
        }
        const targetCol = repacked.leftLimit;
        for (let dr = 0; dr < 2; dr += 1) {
          for (let dc = 0; dc < w; dc += 1) {
            occ[dr][targetCol + dc] = true;
          }
        }
        placements.push({
          key,
          index: i,
          rawSize,
          size: effSize,
          isTrend: true,
          isThird: false,
          isWide: false,
          isNarrow: effSize === 'narrow',
          isTall: effSize === 'tall',
          colStart: targetCol + 1,
          colSpan: w,
          rowStart: 1,
          rowSpan: 2,
        });
        placed = true;
      }
    }

    if (!placed) {
      overflowKeys.push(key);
    }
  }

  if (safeRows === 1) {
    const usedCols = placements.reduce((acc, item) => acc + item.colSpan, 0);
    const isUniformThirdRow = placements.length > 0 && placements.every((p) => p.size === 'third');
    const showRow1Ghosts = includeGhostCells && overflowKeys.length > 0 && usedCols < METRIC_GRID_COLS;
    const ghostCells = [];
    if (showRow1Ghosts) {
      pushMetricGhostRunsForRow(occ[0], 1, ghostCells);
    }
    return {
      rows: 1,
      effectiveRows: 1,
      gridCols: showRow1Ghosts ? METRIC_GRID_COLS : Math.max(1, Math.min(METRIC_GRID_COLS, usedCols)),
      displayCols: Math.max(1, Math.min(4, placements.length)),
      isThreeUpTrend: isUniformThirdRow,
      placements,
      overflowKeys,
      ghostCells,
    };
  }

  const row2HasAny = occ[1].some(Boolean);
  if (!row2HasAny && !includeGhostCells) {
    const usedCols = placements.reduce((acc, item) => acc + item.colSpan, 0);
    const isUniformThirdRow = placements.length > 0 && placements.every((p) => p.size === 'third');
    return {
      rows: 2,
      effectiveRows: 1,
      gridCols: Math.max(1, Math.min(METRIC_GRID_COLS, usedCols)),
      displayCols: Math.max(1, Math.min(4, placements.length)),
      isThreeUpTrend: isUniformThirdRow,
      placements,
      overflowKeys,
      ghostCells: [],
    };
  }

  const ghostCells = [];
  if (includeGhostCells) {
    pushMetricGhostRunsForRow(occ[0], 1, ghostCells);
    pushMetricGhostRunsForRow(occ[1], 2, ghostCells);
  }

  const allThird = placements.length > 0 && placements.every((p) => p.size === 'third');
  return {
    rows: 2,
    effectiveRows: 2,
    gridCols: METRIC_GRID_COLS,
    displayCols: allThird ? 3 : 4,
    isThreeUpTrend: false,
    placements,
    overflowKeys,
    ghostCells,
  };
}

/**
 * 归一化鼠标悬浮窗是否同步「实时监控」的实时指标层高、单卡尺寸与列表（默认开启）。
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
export function normalizeHoverSyncOverviewMetrics(raw) {
  return raw !== false;
}

/**
 * 归一化鼠标悬浮窗独立实时指标列表及左右顺序（1~8 项，与 `overviewMetrics` 共用完整候选集）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeHoverMetrics(raw) {
  return normalizeOverviewMetrics(raw);
}

/**
 * 解析实时监控 (`overview`) 或鼠标悬浮窗 (`hover`) 当前生效的实时指标 Bento 布局配置：
 * - `hover` 且开启 `hoverSyncOverviewMetrics` 时直接复用 `overviewMetricRows` + `overviewMetricSizes` + `overviewMetrics`；
 * - 无损兼容仅有旧版 `overviewMetricStyle` / `hoverMetricStyle` 的历史配置。
 *
 * @param {'overview'|'hover'|string} mode
 * @param {Record<string, any>|null|undefined} [settings]
 * @param {{ includeGhostCells?: boolean }} [options]
 */
export function resolveEffectiveMetricMatrixConfig(
  mode,
  settings = {},
  { includeGhostCells = false } = {}
) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const isHover = mode === 'hover';
  const syncOverview = !isHover || normalizeHoverSyncOverviewMetrics(s.hoverSyncOverviewMetrics);
  const allMetrics = syncOverview
    ? normalizeOverviewMetrics(s.overviewMetrics)
    : normalizeHoverMetrics(s.hoverMetrics);
  const rawRows = syncOverview ? s.overviewMetricRows : s.hoverMetricRows;
  const rawSizes = syncOverview ? s.overviewMetricSizes : s.hoverMetricSizes;
  const rawStyle = syncOverview ? s.overviewMetricStyle : s.hoverMetricStyle;
  const rawTextMode = syncOverview ? s.overviewMetricTextMode : s.hoverMetricTextMode;
  const hasExplicitBento = rawRows !== undefined || rawSizes !== undefined;
  const rows = normalizeMetricGridRows(rawRows, hasExplicitBento ? undefined : rawStyle);
  const sizes = normalizeMetricCardSizes(
    rawSizes,
    allMetrics,
    hasExplicitBento ? undefined : rawStyle
  );
  const textMode = normalizeMetricTextMode(rawTextMode);
  const showTitle = textMode === 'both' || textMode === 'title';
  const showSub = textMode === 'both' || textMode === 'sub';
  const style = deriveMetricCardStyleFromLayout(rows, allMetrics, sizes);
  const layout = packMetricBentoLayout({
    rows,
    metrics: allMetrics,
    sizes,
    includeGhostCells,
  });
  const metrics = layout.placements.map((p) => p.key);
  const isLarge = style === 'large';
  const isHybrid = style === 'hybrid';
  return {
    syncOverview,
    rows,
    sizes,
    textMode,
    showTitle,
    showSub,
    style,
    isLarge,
    isHybrid,
    allMetrics,
    metrics,
    layout,
  };
}

/**
 * 归一化调用明细「按步查看」表格列配置与左右顺序（2~14 列，默认保留现有 7 列）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeStepTableColumns(raw) {
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
export function normalizeStandalonePort(port) {
  const num = Number(port);
  if (!Number.isInteger(num) || num <= 0) return 0;
  if (num >= 1024 && num <= 65535) return num;
  return 0;
}

/**
 * 归一化现代化 UI 开关（默认 `true`）。
 *
 * @param {unknown} val
 * @returns {boolean}
 */
export function normalizeModernUi(val) {
  if (val === undefined || val === null || val === '') return true;
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    if (lower === 'false' || lower === '0' || lower === 'off') return false;
    if (lower === 'true' || lower === '1' || lower === 'on') return true;
    return true;
  }
  return Boolean(val);
}

export const CONTEXT_AGENT_MODES = Object.freeze(['main', 'auto']);
export const DEFAULT_CONTEXT_AGENT_MODE = 'main';

export const TOPBAR_MULTI_SESSION_MODES = Object.freeze(['show', 'running_only', 'hide']);
export const DEFAULT_TOPBAR_MULTI_SESSION_MODE = 'show';

/**
 * 归一化顶栏/输入框实时运行会话入口展示模式（`'show'` | `'running_only'` | `'hide'`），
 * 兼容历史布尔开关 `showTopbarMultiSession`。
 *
 * @param {unknown} mode
 * @param {unknown} [legacyShowMulti]
 * @returns {'show'|'running_only'|'hide'}
 */
export function normalizeTopbarMultiSessionMode(mode, legacyShowMulti) {
  const m = String(mode ?? '').trim().toLowerCase();
  if (m === 'running_only' || m === 'running' || m === 'active_only' || m === 'when_running') {
    return 'running_only';
  }
  if (m === 'hide' || m === 'hidden' || m === 'off' || m === 'false') {
    return 'hide';
  }
  if (m === 'show' || m === 'always' || m === 'on' || m === 'true') {
    return 'show';
  }
  if (legacyShowMulti === false) {
    return 'hide';
  }
  return DEFAULT_TOPBAR_MULTI_SESSION_MODE;
}

/**
 * 根据实时运行会话展示模式与当前运行中会话数量，判断入口按钮是否应当显示。
 *
 * @param {unknown} mode
 * @param {number} [runningCount=0]
 * @param {unknown} [legacyShowMulti]
 * @returns {boolean}
 */
export function isTopbarMultiSessionVisible(mode, runningCount = 0, legacyShowMulti = undefined) {
  const normalized = normalizeTopbarMultiSessionMode(mode, legacyShowMulti);
  if (normalized === 'hide') return false;
  if (normalized === 'running_only') return Number(runningCount) > 0;
  return true;
}

export const QUOTA_DISPLAY_MODES = Object.freeze(['used', 'remaining']);
export const DEFAULT_QUOTA_DISPLAY_MODE = 'used';

/**
 * 归一化可用额度进度条与百分比显示口径（默认 `'used'` 显示已用，可选 `'remaining'` 显示剩余）。
 *
 * @param {unknown} raw
 * @returns {'used'|'remaining'}
 */
export function normalizeQuotaDisplayMode(raw) {
  const val = String(raw || '').trim().toLowerCase();
  return val === 'remaining' ? 'remaining' : 'used';
}

export const ACCOUNT_QUOTA_REFRESH_MINUTES = Object.freeze([10, 30, 60, 180, 360, 720, 1440, 0]);
export const DEFAULT_ACCOUNT_QUOTA_REFRESH_MINUTES = 60;

/**
 * 归一化非当前账号的后台配额刷新间隔（分钟，默认 `60` 即 1 小时；`0` 表示关闭自动刷新）。
 *
 * @param {unknown} raw
 * @returns {10|30|60|180|360|720|1440|0}
 */
export function normalizeAccountQuotaRefreshMinutes(raw) {
  if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') {
    return DEFAULT_ACCOUNT_QUOTA_REFRESH_MINUTES;
  }
  if (typeof raw === 'string') {
    const clean = raw.trim().toLowerCase();
    if (!clean) return DEFAULT_ACCOUNT_QUOTA_REFRESH_MINUTES;
    if (clean === 'off' || clean === 'disabled' || clean === 'none') return 0;
  }
  const num = Number(raw);
  return ACCOUNT_QUOTA_REFRESH_MINUTES.includes(num)
    ? /** @type {any} */ (num)
    : DEFAULT_ACCOUNT_QUOTA_REFRESH_MINUTES;
}

/**
 * 归一化顶栏胶囊及悬停速览浮窗的上下文代理来源（默认 `'main'` 锁定主代理，可选 `'auto'` 跟随活跃）。
 *
 * @param {unknown} raw
 * @returns {'main'|'auto'}
 */
export function normalizeContextAgentMode(raw) {
  const val = String(raw || '').trim().toLowerCase();
  return val === 'auto' ? 'auto' : 'main';
}

/**
 * 归一化配额预占估算开关（默认 `true`）。
 *
 * @param {unknown} val
 * @returns {boolean}
 */
export function normalizeExperimentalQuotaReservation(val) {
  if (val === undefined || val === null || val === '') return true;
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    if (lower === 'false' || lower === '0' || lower === 'off') return false;
    if (lower === 'true' || lower === '1' || lower === 'on') return true;
    return true;
  }
  return Boolean(val);
}

/**
 * 归一化旧版实验性新 UI 字段（保留兼容，缺省返回 `false`）。
 *
 * @param {unknown} val
 * @returns {boolean}
 */
export function normalizeExperimentalModernUi(val) {
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    return lower === 'true' || lower === '1' || lower === 'on';
  }
  return Boolean(val);
}

/**
 * 归一化宿主启动参数自动维护开关（默认 `true`）。
 *
 * @param {unknown} val
 * @returns {boolean}
 */
export function normalizeAutoConfigureLaunch(val) {
  if (val === undefined || val === null || val === '') return true;
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    if (lower === 'false' || lower === '0' || lower === 'off') return false;
    if (lower === 'true' || lower === '1' || lower === 'on' || lower === 'auto') return true;
    return true;
  }
  return Boolean(val);
}

/**
 * 归一化 IDE Remote-SSH 远端守护发现与独立端点遥测开关（默认 `true`）。
 *
 * @param {unknown} val
 * @returns {boolean}
 */
export function normalizeEnableRemoteSshTelemetry(val) {
  if (val === undefined || val === null || val === '') return true;
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    if (lower === 'false' || lower === '0' || lower === 'off') return false;
    if (lower === 'true' || lower === '1' || lower === 'on') return true;
    return true;
  }
  return Boolean(val);
}

export const DEFAULT_ENABLE_SAFETY_MONITOR = true;

/**
 * 归一化后台安全审查日志监测开关（默认 `true`，只读增量扫描本机 Desktop / CLI 日志并辅助配额归因）。
 *
 * @param {unknown} val
 * @returns {boolean}
 */
export function normalizeEnableSafetyMonitor(val) {
  if (val === undefined || val === null || val === '') return DEFAULT_ENABLE_SAFETY_MONITOR;
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    if (lower === 'false' || lower === '0' || lower === 'off') return false;
    if (lower === 'true' || lower === '1' || lower === 'on') return true;
    return DEFAULT_ENABLE_SAFETY_MONITOR;
  }
  return Boolean(val);
}

/**
 * 归一化开发者模式开关（默认 `false`，严格仅接受显式 `true`）。
 *
 * @param {unknown} val
 * @returns {boolean}
 */
export function normalizeDeveloperModeEnabled(val) {
  return val === true;
}

/**
 * 归一化高风险功能总开关（必须同时开启开发者模式，默认 `false`）。
 *
 * @param {unknown} val
 * @param {unknown} [developerModeEnabled=false]
 * @returns {boolean}
 */
export function normalizeRiskyFeaturesEnabled(val, developerModeEnabled = false) {
  return developerModeEnabled === true && val === true;
}

/**
 * 判断「开发者模式 -> 高风险功能」双层显示闸门是否已开启。
 *
 * @param {Record<string, unknown> | null | undefined} settings
 * @returns {boolean}
 */
export function isRiskyFeaturesGateOpen(settings) {
  return Boolean(
    settings &&
      settings.developerModeEnabled === true &&
      settings.riskyFeaturesEnabled === true
  );
}

/**
 * 判断非官方模型上下文覆写能力是否已同时通过双层闸门与风险确认。
 *
 * @param {Record<string, unknown> | null | undefined} settings
 * @returns {boolean}
 */
export function isContextWindowFeatureActive(settings) {
  return Boolean(
    isRiskyFeaturesGateOpen(settings) && settings.contextWindowRiskAccepted === true
  );
}

/**
 * 判断非官方多账号凭证切换能力是否已同时通过双层闸门与风险确认。
 *
 * @param {Record<string, unknown> | null | undefined} settings
 * @returns {boolean}
 */
export function isAccountSwitchFeatureActive(settings) {
  return Boolean(
    isRiskyFeaturesGateOpen(settings) && settings.accountSwitchRiskAccepted === true
  );
}
