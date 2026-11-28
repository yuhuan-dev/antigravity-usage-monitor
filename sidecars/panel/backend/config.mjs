/**
 * @fileoverview 后端全局路径常量、默认配置、JSON 持久化工具与运行时共享状态容器。
 *
 * 负责统一管理：
 * 1. 插件根目录 (`PLUGIN_ROOT`)、面板目录 (`HERE`) 与持久化数据目录 (`DATA_DIR`) 的路径解析；
 * 2. Language Server RPC 连接参数 (`LS_ADDR` / `LS_BASE_URL` / `CSRF_TOKEN`) 与 GitHub 云端价格表地址；
 * 3. 安全的 JSON 读写封装 (`loadJson` / `saveJson`) 与用户设置合并 (`loadSettings`)；
 * 4. 跨子系统共享的内存态缓存容器（采用对象属性就地更新设计，兼容 ES Module 与 VM 沙箱）。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomicSync } from './fs-atomic.mjs';
import { isPlainObject } from './http-helpers.mjs';
import { writeTrajectoryCacheFile } from './trajectory-cache-file.mjs';
import {
  CACHE_RUNNING_SAVE_INTERVAL_MS,
  createTrajectoryCacheStore,
} from './trajectory-cache-store.mjs';
import { normalizeFullSettings } from './settings-schema.mjs';

export { CACHE_RUNNING_SAVE_INTERVAL_MS, isPlainObject };

export {
  CLI_STATUSLINE_PRESETS,
  CONTEXT_AGENT_MODES,
  DEFAULT_CLI_STATUSLINE_SLOTS,
  DEFAULT_CONTEXT_AGENT_MODE,
  DEFAULT_DISPLAY_CURRENCY,
  DEFAULT_HOVER_METRICS,
  DEFAULT_HOVER_METRIC_ROWS,
  DEFAULT_HOVER_METRIC_SIZES,
  DEFAULT_HOVER_METRIC_STYLE,
  DEFAULT_HOVER_METRIC_TEXT_MODE,
  DEFAULT_HOVER_MODULES,
  DEFAULT_HOVER_SYNC_OVERVIEW_METRICS,
  DEFAULT_METRIC_ROWS,
  DEFAULT_METRIC_TEXT_MODE,
  DEFAULT_OVERVIEW_METRICS,
  DEFAULT_OVERVIEW_METRIC_ROWS,
  DEFAULT_OVERVIEW_METRIC_SIZES,
  DEFAULT_OVERVIEW_METRIC_STYLE,
  DEFAULT_OVERVIEW_METRIC_TEXT_MODE,
  DEFAULT_OVERVIEW_MODULES,
  DEFAULT_POPOVER_WIDTH,
  DEFAULT_QUOTA_DISPLAY_MODE,
  DEFAULT_SETTINGS_SCHEMA,
  DEFAULT_STEP_TABLE_COLUMNS,
  DEFAULT_STEP_TOKEN_COMBO_FORMAT,
  DEFAULT_TOPBAR_MULTI_SESSION_MODE,
  DEFAULT_TOPBAR_SLOTS,
  FONT_SCALE_KEYS,
  HOVER_METRIC_STYLES,
  MAX_CLI_STATUSLINE_SLOTS,
  MAX_LARGE_METRIC_SLOTS,
  MAX_OVERVIEW_METRICS,
  MAX_POPOVER_WIDTH,
  MAX_TOPBAR_SLOTS,
  METRIC_CARD_SIZES,
  METRIC_CARD_STYLES,
  METRIC_GRID_COLS,
  METRIC_GRID_ROWS,
  METRIC_TEXT_MODES,
  MIN_CLI_STATUSLINE_SLOTS,
  MIN_POPOVER_WIDTH,
  MIN_TOPBAR_SLOTS,
  OVERVIEW_METRIC_KEYS,
  OVERVIEW_MODULE_KEYS,
  QUOTA_DISPLAY_MODES,
  STEP_TABLE_COLUMN_KEYS,
  SUPPORTED_DISPLAY_CURRENCIES,
  SUPPORTED_LANGUAGES,
  THEME_ACCENT_KEYS,
  TOPBAR_MULTI_SESSION_MODES,
  TOPBAR_SLOT_KEYS,
  createDefaultSettingsObject,
  deriveMetricCardStyleFromLayout,
  isAccountSwitchFeatureActive,
  isContextWindowFeatureActive,
  isRiskyFeaturesGateOpen,
  isTopbarMultiSessionVisible,
  normalizeAutoConfigureLaunch,
  normalizeCliStatusLineSlots,
  normalizeContextAgentMode,
  normalizeDeveloperModeEnabled,
  normalizeDisplayCurrency,
  normalizeEnableRemoteSshTelemetry,
  normalizeExperimentalQuotaReservation,
  normalizeFontScale,
  normalizeFullSettings,
  normalizeHoverMetricRows,
  normalizeHoverMetricSizes,
  normalizeHoverMetricStyle,
  normalizeHoverMetricTextMode,
  normalizeHoverMetrics,
  normalizeHoverModules,
  normalizeHoverSyncOverviewMetrics,
  normalizeLanguageSetting,
  normalizeMetricCardSize,
  normalizeMetricCardSizes,
  normalizeMetricCardStyle,
  normalizeMetricGridRows,
  normalizeMetricTextMode,
  normalizeModelDisplayMode,
  normalizeModernUi,
  normalizeOverviewMetricRows,
  normalizeOverviewMetricSizes,
  normalizeOverviewMetricStyle,
  normalizeOverviewMetricTextMode,
  normalizeOverviewMetrics,
  normalizeOverviewModules,
  normalizePluginUpdateMode,
  normalizePopoverWidth,
  normalizePopoverWidthMode,
  normalizeQuotaDisplayMode,
  normalizeRiskyFeaturesEnabled,
  normalizeStandalonePort,
  normalizeStepTableColumns,
  normalizeStepTokenComboFormat,
  normalizeThemeAccent,
  normalizeTopbarCapsuleSlots,
  normalizeTopbarMultiSessionMode,
  normalizeWeeklyLimitMode,
  normalizeWindowMountMode,
  packMetricBentoLayout,
  parseStepTokenComboSegments,
  resolveEffectiveCliStatusLineSlots,
  resolveEffectiveMetricMatrixConfig,
} from './settings-schema.mjs';

/**
 * 自适应解析 `sidecars/panel` 目录路径：
 * - 在真实 Node ESM 运行时中，本文件位于 `sidecars/panel/backend/config.mjs`，向上取一级即为 `sidecars/panel`；
 * - 在 `backend-harness.mjs` 单元测试沙箱中，`fileURLToPath` 返回 `.../sidecars/panel/main.mjs`，当前目录即为 `sidecars/panel`。
 */
const rawModuleDir = dirname(fileURLToPath(import.meta.url));
export const HERE = /[\\/]backend$/i.test(rawModuleDir) ? dirname(rawModuleDir) : rawModuleDir;
export const PLUGIN_ROOT = dirname(dirname(HERE));
export const PLUGIN_MANIFEST_FILE = join(PLUGIN_ROOT, 'plugin.json');
export const LOCAL_CATALOG_FILE = join(PLUGIN_ROOT, 'pricing-catalog.json');

function resolveGeminiBaseDir() {
  const envGemini = String(process.env.ANTIGRAVITY_GEMINI_DIR || '').trim();
  return envGemini || join(homedir(), '.gemini');
}

function dedupeDirCandidates(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const clean = String(item || '').trim();
    if (!clean) continue;
    const key =
      process.platform === 'win32'
        ? clean.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
        : clean.replace(/\/+$/, '') || '/';
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function resolveProductDataRoots() {
  const geminiBase = resolveGeminiBaseDir();
  const explicitAppDir = String(
    process.env.USAGE_MONITOR_APP_DATA_DIR || process.env.ANTIGRAVITY_APP_DATA_DIR || ''
  ).trim();
  const customRoot = explicitAppDir
    ? /[\\/]|^[a-zA-Z]:/.test(explicitAppDir)
      ? explicitAppDir
      : join(geminiBase, explicitAppDir)
    : '';
  return dedupeDirCandidates([
    customRoot,
    join(geminiBase, 'antigravity'),
    join(geminiBase, 'antigravity-cli'),
    join(geminiBase, 'antigravity-ide'),
    join(geminiBase, 'antigravity-idea'),
  ]);
}

/**
 * 插件持久化数据目录（默认由 Antigravity 宿主注入 `~/.gemini/antigravity/sidecar_data/usage-monitor/panel/data`）。
 * 兼容桌面端、Antigravity IDE 与无头 `agy` CLI（`~/.gemini/antigravity-cli`）：
 * 优先使用已存在的持久化目录，纯 CLI 服务器自动落入 `~/.gemini/antigravity-cli/sidecar_data/usage-monitor/panel/data`，
 * 避免落入插件源码目录而在自更新时丢失缓存与设置。
 */
function resolveDefaultDataDir() {
  const explicitDataDir = String(process.env.USAGE_MONITOR_DATA_DIR || '').trim();
  if (explicitDataDir) {
    return explicitDataDir;
  }
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    return process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  }
  if (String(process.env.ANTIGRAVITY_LS_ADDRESS || '').trim() === 'test.invalid') {
    return join(HERE, '.data');
  }
  const geminiBase = resolveGeminiBaseDir();
  const antigravityRoot = join(geminiBase, 'antigravity');
  const ideRoot = join(geminiBase, 'antigravity-ide');
  const cliRoot = join(geminiBase, 'antigravity-cli');
  const panelDataDir = join(antigravityRoot, 'sidecar_data', 'usage-monitor', 'panel', 'data');
  const legacyDataDir = join(antigravityRoot, 'sidecar_data', 'usage-monitor', 'data');
  const idePanelDataDir = join(ideRoot, 'sidecar_data', 'usage-monitor', 'panel', 'data');
  const cliPanelDataDir = join(cliRoot, 'sidecar_data', 'usage-monitor', 'panel', 'data');
  const pluginEnvDataDir =
    process.env.USAGE_MONITOR_PLUGIN_DATA && !process.env.USAGE_MONITOR_PLUGIN_DATA.includes('${')
      ? process.env.USAGE_MONITOR_PLUGIN_DATA
      : '';
  if (existsSync(panelDataDir)) return panelDataDir;
  if (existsSync(legacyDataDir)) return legacyDataDir;
  if (pluginEnvDataDir && existsSync(pluginEnvDataDir)) return pluginEnvDataDir;
  if (existsSync(idePanelDataDir)) return idePanelDataDir;
  if (existsSync(cliPanelDataDir)) return cliPanelDataDir;
  if (existsSync(antigravityRoot)) return panelDataDir;
  if (pluginEnvDataDir) return pluginEnvDataDir;
  if (existsSync(ideRoot)) return idePanelDataDir;
  if (existsSync(cliRoot)) return cliPanelDataDir;
  return join(HERE, '.data');
}

export const DATA_DIR = resolveDefaultDataDir();
export const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
export const CACHE_FILE = join(DATA_DIR, 'trajectory_usage_cache.json');
export const TRAJECTORY_DB_FILE = join(DATA_DIR, 'trajectory_store.sqlite');
export const REMOTE_CATALOG_CACHE_FILE = join(DATA_DIR, 'remote_pricing_cache.json');
export const FX_RATES_CACHE_FILE = join(DATA_DIR, 'fx_rates_cache.json');
export const CLI_STATUS_SNAPSHOT_FILE = join(DATA_DIR, 'cli-status-snapshot.json');
export const QUOTA_RESERVATION_STATE_FILE = join(DATA_DIR, 'quota_reservation_state.json');
export const SAFETY_MONITOR_STATE_FILE = join(DATA_DIR, 'safety_monitor_state.json');
export const ACCOUNT_QUOTA_HISTORY_FILE = join(DATA_DIR, 'account_quota_history.json');
export const DEEP_STATS_COVERAGE_MEMO_FILE = join(DATA_DIR, 'deep_stats_coverage_memo.json');

/**
 * 本地对话记录目录、脑图日志目录、守护发现目录与跨端深层统计缓存路径候选列表（联合覆盖 Desktop / CLI / IDE）。
 */
export const PRODUCT_DATA_ROOTS = resolveProductDataRoots();
export const CONVERSATION_DIRS = PRODUCT_DATA_ROOTS.map((root) => join(root, 'conversations'));
export const BRAIN_DIRS = PRODUCT_DATA_ROOTS.map((root) => join(root, 'brain'));
export const ANNOTATION_DIRS = PRODUCT_DATA_ROOTS.map((root) => join(root, 'annotations'));
export const DAEMON_DIRS = dedupeDirCandidates([
  join(resolveGeminiBaseDir(), 'antigravity-cli', 'daemon'),
  ...PRODUCT_DATA_ROOTS.map((root) => join(root, 'daemon')),
]);
export const CONVERSATIONS_DIR = CONVERSATION_DIRS[0];
export const BRAIN_DIR = BRAIN_DIRS[0];
export const DEEP_STATS_CACHE_CANDIDATES = dedupeDirCandidates([
  join(resolveGeminiBaseDir(), 'antigravity-ide', 'brain', '.deep_stats_cache.json'),
  join(resolveGeminiBaseDir(), 'antigravity-cli', 'brain', '.deep_stats_cache.json'),
  join(resolveGeminiBaseDir(), 'antigravity', 'brain', '.deep_stats_cache.json'),
  join(resolveGeminiBaseDir(), 'antigravity-idea', 'brain', '.deep_stats_cache.json'),
  ...BRAIN_DIRS.map((dir) => join(dir, '.deep_stats_cache.json')),
]);

/**
 * Antigravity 本地 Language Server Connect RPC 端点与鉴权 Token（支持环境变量静态注入与进程/守护文件动态发现）。
 */
const rawLsAddr = String(process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
const LS_PROTOCOL = /^https:\/\//i.test(rawLsAddr) ? 'https' : 'http';
export const LS_ADDR = rawLsAddr.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
export const LS_BASE_URL = LS_ADDR ? `${LS_PROTOCOL}://${LS_ADDR}` : '';
export const CSRF_TOKEN =
  process.env.ANTIGRAVITY_CSRF_TOKEN || process.env.ANTIGRAVITY_SERVER_CSRF_TOKEN;

export const lsRuntimeEndpoint = {
  addr: LS_ADDR,
  baseUrl: LS_BASE_URL,
  csrfToken: CSRF_TOKEN || '',
  isDynamic: false,
};

/**
 * 动态更新运行时 Language Server / Hub RPC 连接端点与 CSRF 令牌。
 *
 * @param {string} nextAddr
 * @param {string} nextCsrfToken
 * @param {{ isDynamic?: boolean }} [opts]
 */
export function setLsRuntimeEndpoint(nextAddr, nextCsrfToken, { isDynamic = true } = {}) {
  const raw = String(nextAddr || '').trim();
  const proto = /^https:\/\//i.test(raw) ? 'https' : 'http';
  const cleanAddr = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  lsRuntimeEndpoint.addr = cleanAddr;
  lsRuntimeEndpoint.baseUrl = cleanAddr ? `${proto}://${cleanAddr}` : '';
  lsRuntimeEndpoint.csrfToken = String(nextCsrfToken || '').trim();
  lsRuntimeEndpoint.isDynamic = Boolean(cleanAddr && isDynamic);
}

/**
 * GitHub 官方云端价格目录与插件发布包地址配置。
 */
export const OFFICIAL_GITHUB_REPO = 'yuhuan-dev/antigravity-usage-monitor';
export const LEGACY_GITHUB_REPOS = Object.freeze([
  'yuhuan2498281558/antigravity-usage-monitor',
]);
export const CLOUD_CATALOG_URLS = [
  `https://raw.githubusercontent.com/${OFFICIAL_GITHUB_REPO}/main/pricing-catalog.json`,
];
export const DEFAULT_RELEASE_URL =
  `https://github.com/${OFFICIAL_GITHUB_REPO}/releases/latest`;
export const DEFAULT_DOWNLOAD_URL =
  `https://github.com/${OFFICIAL_GITHUB_REPO}/releases/latest/download/usage-monitor.zip`;
export const DEFAULT_ARCHIVE_FALLBACK_URL =
  `https://codeload.github.com/${OFFICIAL_GITHUB_REPO}/zip/refs/heads/main`;

/**
 * 检测当前插件目录是否关联了非官方自定义 GitHub Fork 远端（如二次开发分支）。
 * 命中自定义 Fork 时保留上游价格目录热同步，但将插件版本号与更新包地址锚定至用户自己的 Fork，避免误报更新。
 *
 * @returns {string} 自定义 Fork 的 `owner/repo`，未命中或为官方仓库时返回 `''`
 */
export function detectCustomGitForkRepo() {
  try {
    const dotGitPath = join(PLUGIN_ROOT, '.git');
    if (!existsSync(dotGitPath)) return '';
    let gitConfigPath = join(dotGitPath, 'config');
    if (!existsSync(gitConfigPath)) {
      const ptrText = readFileSync(dotGitPath, 'utf8');
      const m = typeof ptrText === 'string' && ptrText.match(/^gitdir:\s*(.+)$/im);
      if (m) {
        const gitDir = m[1].trim();
        const commonDirFile = join(gitDir, 'commondir');
        if (existsSync(commonDirFile)) {
          const relCommon = String(readFileSync(commonDirFile, 'utf8') || '').trim();
          gitConfigPath = join(gitDir, relCommon, 'config');
        } else {
          gitConfigPath = join(gitDir, 'config');
        }
      }
    }
    if (!existsSync(gitConfigPath)) return '';
    const cfg = readFileSync(gitConfigPath, 'utf8');
    if (typeof cfg !== 'string' || !cfg) return '';
    const originBlock = cfg.match(/\[remote\s+"origin"\]([\s\S]*?)(?:\r?\n\[|$)/i);
    if (!originBlock) return '';
    const urlMatch = originBlock[1].match(/^\s*url\s*=\s*(.+)$/im);
    if (!urlMatch) return '';
    const rawUrl = urlMatch[1].trim();
    const ghMatch = rawUrl.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i);
    if (!ghMatch) return '';
    const repo = ghMatch[1];
    const lower = repo.toLowerCase();
    if (
      lower === OFFICIAL_GITHUB_REPO.toLowerCase() ||
      LEGACY_GITHUB_REPOS.some((r) => r.toLowerCase() === lower)
    ) {
      return '';
    }
    return repo;
  } catch {
    return '';
  }
}

/** 云端目录常规自动检查间隔（6 小时）与失败冷却时间（5 分钟）。 */
export const CLOUD_SYNC_TTL_MS = 6 * 3600 * 1000;
export const CLOUD_SYNC_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

/** 历史轨迹缓存 Schema 版本号，升级时触发旧缓存字段迁移校验。 */
export const CACHE_SCHEMA_VERSION = 'v10-model-identity';

/**
 * 安全读取并解析本地 JSON 文件；文件不存在或解析失败时返回 `fallback`。
 *
 * @param {string} filePath 目标文件绝对路径
 * @param {*} fallback 失败时的回退值
 * @returns {*}
 */
export function loadJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * 将数据序列化为格式化 JSON 并写入 `DATA_DIR` 下的指定文件。
 *
 * @param {string} filePath 目标文件绝对路径
 * @param {*} data 待写入的数据对象
 * @returns {boolean} 是否写入成功
 */
export function saveJson(filePath, data) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    if (filePath === CACHE_FILE) {
      writeTrajectoryCacheFile(filePath, data);
    } else {
      writeJsonAtomicSync(filePath, data);
    }
    return true;
  } catch (err) {
    console.error(`Failed writing ${filePath}: ${err.message}`);
    return false;
  }
}

/**
 * 读取用户设置并通过统一 Schema 归一化合并默认值，自动迁移旧版字段。
 */
export function loadSettings() {
  return normalizeFullSettings(loadJson(SETTINGS_FILE, {}));
}

/**
 * 将浮点指标保留 1 位小数；非有限数值返回 `null`。
 *
 * @param {number} value
 * @returns {number|null}
 */
export function roundMetric(value) {
  return Number.isFinite(value) ? +value.toFixed(1) : null;
}

const RUNTIME_CODE_VERSION_TTL_MS = 2_000;
let cachedRuntimeCodeVersion = '';
let cachedRuntimeCodeVersionExpiresAt = 0;

/**
 * 计算前端产物与后端源码文件的最大修改时间戳，用于插件热更新后触发客户端重载。
 * 内置 2 秒短期记忆化缓存，避免桥接守护与轮询循环高频重复执行 ~80 次同步 `statSync` / `readdirSync`。
 *
 * @param {{ force?: boolean }} [options={}]
 * @returns {string}
 */
export function computeRuntimeCodeVersion(options = {}) {
  const nowMs = Date.now();
  if (!options?.force && cachedRuntimeCodeVersion && nowMs < cachedRuntimeCodeVersionExpiresAt) {
    return cachedRuntimeCodeVersion;
  }
  let maxMtime = 0;
  const candidates = [
    join(HERE, 'app.js'),
    join(HERE, 'styles.css'),
    join(HERE, 'main.mjs'),
    join(HERE, 'standalone.mjs'),
    join(HERE, 'bridge-daemon.mjs'),
    join(HERE, 'mcp-entry.mjs'),
    join(HERE, 'cli-statusline.mjs'),
    join(HERE, 'trajectory-metrics.mjs'),
    LOCAL_CATALOG_FILE,
  ];
  for (const subDir of ['shared', 'backend', join('backend', 'host-i18n')]) {
    const absDir = join(HERE, subDir);
    try {
      if (existsSync(absDir)) {
        for (const name of readdirSync(absDir)) {
          if (name.endsWith('.mjs') || name.endsWith('.js')) {
            candidates.push(join(absDir, name));
          }
        }
      }
    } catch {
      // 忽略目录列举异常
    }
  }
  candidates.sort();
  let hash = 0x811c9dc5;
  let counted = 0;
  for (const file of candidates) {
    try {
      const st = statSync(file, { throwIfNoEntry: false });
      if (st) {
        const mtime = Math.floor(st.mtimeMs || 0);
        const size = Math.floor(st.size || 0);
        if (mtime > maxMtime) maxMtime = mtime;
        counted += 1;
        const entry = `${file}|${mtime}|${size}`;
        for (let i = 0; i < entry.length; i += 1) {
          hash ^= entry.charCodeAt(i);
          hash = Math.imul(hash, 0x01000193);
        }
      }
    } catch {
      // 忽略单文件 stat 异常
    }
  }
  const digest = (hash >>> 0).toString(16).padStart(8, '0');
  cachedRuntimeCodeVersion = `${maxMtime || nowMs}-${counted}-${digest}`;
  cachedRuntimeCodeVersionExpiresAt = nowMs + RUNTIME_CODE_VERSION_TTL_MS;
  return cachedRuntimeCodeVersion;
}

// ---------------------------------------------------------------------------
// 跨模块共享运行时状态容器（首次访问时惰性加载历史轨迹缓存，避免 CLI 状态栏等无缓存消费者付出 13MB 解析开销）
// ---------------------------------------------------------------------------

/**
 * 本机内存态轨迹步骤缓存容器（委托 `createTrajectoryCacheStore`，首次读取时惰性加载历史缓存）。
 */
const isUnscopedHostTestRunner = Boolean(
  typeof process !== 'undefined' &&
    process?.env?.NODE_TEST_CONTEXT &&
    !process?.env?.USAGE_MONITOR_APP_DATA_DIR &&
    !process?.env?.ANTIGRAVITY_APP_DATA_DIR &&
    !process?.env?.ANTIGRAVITY_GEMINI_DIR
);

const localTrajectoryCacheStore = createTrajectoryCacheStore({
  cacheFilePath: isUnscopedHostTestRunner ? '' : CACHE_FILE,
  sqliteFilePath: isUnscopedHostTestRunner ? '' : TRAJECTORY_DB_FILE,
  loadJsonFn: loadJson,
  writeCacheFn: (targetPath, dataObj) => saveJson(targetPath, dataObj),
  shouldBypassThrottleFn: (allowThrottleInTest) =>
    lsRuntimeEndpoint.addr === 'test.invalid' && !allowThrottleInTest,
  registerExitHook: !isUnscopedHostTestRunner,
});

export function getLocalTrajectoryCacheStore() {
  return localTrajectoryCacheStore;
}

export function getCachedTrajectory(cascadeId) {
  return localTrajectoryCacheStore.getCachedTrajectory(cascadeId);
}

export function getCachedTrajectoryEntryByLower(cascadeId) {
  return localTrajectoryCacheStore.getCachedTrajectoryEntryByLower(cascadeId);
}

export function getHydratedTrajectory(cascadeId) {
  return localTrajectoryCacheStore.getHydratedTrajectory(cascadeId);
}

export function getHydratedTrajectoryEntryByLower(cascadeId) {
  return localTrajectoryCacheStore.getHydratedTrajectoryEntryByLower(cascadeId);
}

export function listCachedTrajectoryEntries() {
  return localTrajectoryCacheStore.listCachedTrajectoryEntries();
}

export function setCachedTrajectory(cascadeId, entry) {
  localTrajectoryCacheStore.setCachedTrajectory(cascadeId, entry);
}

export function removeCachedTrajectory(cascadeId) {
  localTrajectoryCacheStore.removeCachedTrajectory(cascadeId);
}

export function hasPendingTrajectoryCacheSave() {
  return localTrajectoryCacheStore.hasPendingTrajectoryCacheSave();
}

export function flushTrajectoryCacheNow() {
  return localTrajectoryCacheStore.flushTrajectoryCacheNow();
}

export function persistTrajectoryCacheIfNeeded(options = {}) {
  localTrajectoryCacheStore.persistTrajectoryCacheIfNeeded(options);
}

export const externalDeepStatsMemo = {
  sig: '',
  loaded: false,
  pruned: false,
  coveredPairs: null,
  convos: new Map(),
};

export const localSummaryMemo = {
  sig: '',
  byId: new Map(),
  available: false,
  summariesObj: {},
  sideQuestionParents: {},
  refreshedAtMs: 0,
  byRootsKey: new Map(),
};

/** 并发请求去重表（防止同一参数并发重复拉取）。 */
export const inFlightRequests = new Map();

/** 官方配额摘要 10 秒短期缓存与失败退避冷却记录。 */
export const quotaSummaryCache = {
  ts: 0,
  lastAttemptTs: 0,
  accountName: '',
  accountGeneration: 0,
  data: null,
  error: null,
};

/** 云端价格与版本目录同步状态。 */
export const cloudSyncState = {
  catalogVersion: 'builtin',
  updatedAt: null,
  fetchedAtMs: 0,
  lastAttemptMs: 0,
  source: 'builtin', // 'builtin' | 'local' | 'remote'
  sourceUrl: '',
  latestPluginVersion: null,
  releaseUrl: DEFAULT_RELEASE_URL,
  downloadUrl: DEFAULT_DOWNLOAD_URL,
  archiveFallbackUrl: DEFAULT_ARCHIVE_FALLBACK_URL,
  isSyncing: false,
  lastError: null,
  inFlight: null,
};

/** 插件自更新执行状态。 */
export const pluginUpdateState = {
  isUpdating: false,
  inFlightIsAuto: false,
  lastAutoAttemptVersion: '',
  lastResult: null,
  lastError: null,
  inFlight: null,
};

/**
 * 清空内存态轨迹缓存、外部深层统计 Memo 与配额摘要短期缓存，并将磁盘缓存重置为空对象。
 * 空缓存落盘成功后再清理内存，写入失败时可继续使用内存数据并重试。
 *
 * @returns {boolean} 是否成功写回空白缓存文件
 */
export function clearRuntimeCaches(options = {}) {
  if (!localTrajectoryCacheStore.clearCache(options)) return false;
  externalDeepStatsMemo.sig = '';
  externalDeepStatsMemo.loaded = false;
  externalDeepStatsMemo.pruned = false;
  externalDeepStatsMemo.coveredPairs = null;
  externalDeepStatsMemo.convos.clear();
  try {
    const normMemo = String(DEEP_STATS_COVERAGE_MEMO_FILE || '').replace(/\\/g, '/');
    if (
      normMemo &&
      !normMemo.startsWith('/test/') &&
      !normMemo.startsWith('/test-home/') &&
      existsSync(DEEP_STATS_COVERAGE_MEMO_FILE)
    ) {
      rmSync(DEEP_STATS_COVERAGE_MEMO_FILE, { force: true });
    }
  } catch {
    // 忽略清理覆盖跳过缓存异常
  }
  if (!options?.preserveFreshSummaryMemo) {
    localSummaryMemo.sig = '';
    localSummaryMemo.byId.clear();
    localSummaryMemo.available = false;
    localSummaryMemo.summariesObj = {};
    localSummaryMemo.sideQuestionParents = {};
    localSummaryMemo.refreshedAtMs = 0;
    localSummaryMemo.byRootsKey.clear();
  }
  quotaSummaryCache.ts = 0;
  quotaSummaryCache.lastAttemptTs = 0;
  quotaSummaryCache.accountName = '';
  quotaSummaryCache.accountGeneration += 1;
  quotaSummaryCache.data = null;
  quotaSummaryCache.error = null;
  return true;
}
