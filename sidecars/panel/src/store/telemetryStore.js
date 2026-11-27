/**
 * @fileoverview Reactive telemetry store with async non-overlapping poll scheduler
 * and granular slice updates.
 */

import { createReactiveStore } from '../core/reactive.js';
import {
  abortSidecarApiKey,
  callSidecarApi,
  getWindowBridgeConfig,
  isWindowOverlayMode,
} from '../core/httpClient.js';
import {
  formatAgentBadgeText,
  formatAgentLabel,
  formatConversationMeta,
  formatLiveActivityDetail,
  formatLiveActivityLabel,
  getAgentBadgeClass,
} from '../core/formatters.js';
import { normalizeI18nLanguage, t } from '../i18n/index.js';
import { normalizeDisplayCurrency } from '../../shared/currency-catalog.mjs';
import {
  normalizeClientFontScale,
  normalizeClientModernUi,
  normalizeClientThemeAccent,
  resolveSettingsModernUi,
} from '../core/appearance.js';
import {
  CLI_STATUSLINE_PRESETS,
  DEFAULT_CLI_STATUSLINE_SLOTS,
  DEFAULT_CONTEXT_AGENT_MODE,
  DEFAULT_HOVER_METRICS,
  DEFAULT_HOVER_METRIC_STYLE,
  DEFAULT_HOVER_MODULES,
  DEFAULT_HOVER_SYNC_OVERVIEW_METRICS,
  DEFAULT_OVERVIEW_METRICS,
  DEFAULT_OVERVIEW_METRIC_STYLE,
  DEFAULT_OVERVIEW_MODULES,
  DEFAULT_POPOVER_WIDTH,
  DEFAULT_QUOTA_DISPLAY_MODE,
  DEFAULT_STEP_TABLE_COLUMNS,
  DEFAULT_STEP_TOKEN_COMBO_FORMAT,
  DEFAULT_TOPBAR_SLOTS,
  MAX_LARGE_METRIC_SLOTS,
  MAX_POPOVER_WIDTH,
  MIN_POPOVER_WIDTH,
  OVERVIEW_METRIC_KEYS,
  OVERVIEW_MODULE_KEYS,
  STEP_TABLE_COLUMN_KEYS,
  TOPBAR_SLOT_KEYS,
  isRiskyFeaturesGateOpen,
  normalizeAccountQuotaRefreshMinutes,
  normalizeAutoConfigureLaunch,
  normalizeCliStatusLineSlots,
  normalizeContextAgentMode,
  normalizeDeveloperModeEnabled,
  normalizeEnableRemoteSshTelemetry,
  normalizeExperimentalQuotaReservation,
  normalizeHoverMetricStyle,
  normalizeHoverMetrics,
  normalizeHoverModules,
  normalizeHoverSyncOverviewMetrics,
  normalizeModelDisplayMode,
  normalizeOverviewMetricStyle,
  normalizeOverviewMetrics,
  normalizeOverviewModules,
  normalizePluginUpdateMode,
  normalizePopoverWidth,
  normalizePopoverWidthMode,
  normalizeQuotaDisplayMode,
  normalizeRiskyFeaturesEnabled,
  normalizeStepTableColumns,
  normalizeStepTokenComboFormat,
  normalizeTopbarCapsuleSlots,
  normalizeWeeklyLimitMode,
  normalizeWindowMountMode,
  parseStepTokenComboSegments,
  resolveEffectiveCliStatusLineSlots,
  resolveEffectiveMetricMatrixConfig,
} from '../../shared/settings-normalization.mjs';
import {
  LOCAL_ENDPOINT_ID,
  WINDOW_BRIDGE_ENDPOINT_KEY,
  WINDOW_BRIDGE_ROUTE_KEY,
  readInjectedWindowBridge,
} from '../../shared/window-bridge-protocol.mjs';
import { getHostThemeSignature } from '../../shared/host-theme.mjs';

const CASCADE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 在主窗口双栖模式下，提取当前正在浏览的会话 ID：
 * 1. 优先解析 Antigravity 2.0 路由路径 `/c/<uuid>`；
 * 2. 在 Antigravity IDE (`workbench.html`) 无路径路由时，回退读取活跃对话视图
 *    `[data-testid="conversation-view"][data-cascade-id]` 或侧栏选中项。
 *
 * @returns {string}
 */
export function extractHostRouteCascadeId() {
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

export const telemetryStore = createReactiveStore({
  selectedConversationId: initialConversationId,
  hostRouteConversationId: extractHostRouteCascadeId(),
  selectedTimeRange: 'today',
  selectedCyclePool: 'all',
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
let endpointSwitchEpoch = 0;
let activeForceCount = 0;
let consecutivePollFailures = 0;
let inFlightTelemetryPoll = null;
let inFlightPresetsPrefetch = null;
let lastPrefetchedUsageRevision = 0;
let consumptionCacheScopeSig = '';
const MAX_CONSUMPTION_RANGE_CACHE = 24;
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
  'autoConfigureLaunch',
  'enableRemoteSshTelemetry',
]);

function makeConsumptionRangeCacheKey(
  range,
  customStartMs = 0,
  customEndMs = 0,
  cyclePool = 'all'
) {
  const key = String(range || 'all');
  if (key === 'custom') {
    return `custom:${Number(customStartMs || 0)}:${Number(customEndMs || 0)}`;
  }
  if (key === 'cycle' && cyclePool && cyclePool !== 'all') {
    return `cycle:${String(cyclePool)}`;
  }
  return key;
}

export function clearConsumptionRangeCache() {
  consumptionRangeCache.clear();
  lastPrefetchedUsageRevision = 0;
  inFlightPresetsPrefetch = null;
}

export function clearConversationViewCache() {
  conversationViewCache.clear();
  if (deferredConvSyncTimer) {
    clearTimeout(deferredConvSyncTimer);
    deferredConvSyncTimer = null;
  }
}

function buildConsumptionScopeSig(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const ep = payload.endpoint || {};
  const acct = payload.account || {};
  const set = payload.settings || {};
  const cloud = payload.cloudStatus || {};
  return `${String(ep.id || LOCAL_ENDPOINT_ID)}|${String(acct.status || '')}|${String(acct.email || acct.name || '').toLowerCase()}|${String(set.weeklyLimitMode || '')}|${String(cloud.catalogVersion || '')}`;
}

function reconcileSelectedCyclePool(payload) {
  const curPool = telemetryStore.getState().selectedCyclePool || 'all';
  if (curPool === 'all') return;
  const pools = payload?.quotas?.pools;
  if (!Array.isArray(pools) || pools.length === 0) return;
  const exists = pools.some((p) => String(p?.poolKey || p?.family || '') === curPool);
  if (!exists) {
    telemetryStore.setState({ selectedCyclePool: 'all' });
  }
}

function syncConsumptionCacheScope(payload) {
  const nextSig = buildConsumptionScopeSig(payload);
  if (!nextSig) return;
  if (consumptionCacheScopeSig && consumptionCacheScopeSig !== nextSig) {
    clearConsumptionRangeCache();
    clearConversationViewCache();
  }
  consumptionCacheScopeSig = nextSig;
  reconcileSelectedCyclePool(payload);
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
  { customStartMs = 0, customEndMs = 0, cyclePool = 'all', usageRevision = 0 } = {}
) {
  const rangeKey = String(cons?.selectedRange?.key || '');
  if (!rangeKey) return;
  const resolvedPool =
    rangeKey === 'cycle'
      ? String(cons?.selectedRange?.pool || cyclePool || 'all')
      : 'all';
  const cacheKey = makeConsumptionRangeCacheKey(
    rangeKey,
    rangeKey === 'custom' ? customStartMs || cons.selectedRange?.startMs || 0 : 0,
    rangeKey === 'custom' ? customEndMs || cons.selectedRange?.endMs || 0 : 0,
    resolvedPool
  );
  putConsumptionRangeCacheEntry(cacheKey, {
    revision: Number(cons.revision ?? usageRevision ?? 0),
    selectedRange: cons.selectedRange,
    session: cons.session,
    account: cons.account,
    trendSeries: Array.isArray(cons.trendSeries) ? cons.trendSeries : [],
    sourcesBreakdown: Array.isArray(cons.sourcesBreakdown) ? cons.sourcesBreakdown : [],
    topConversations: Array.isArray(cons.topConversations) ? cons.topConversations : [],
    topWorkspaces: Array.isArray(cons.topWorkspaces) ? cons.topWorkspaces : [],
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
      topConversations: Array.isArray(cachedEntry.topConversations)
        ? cachedEntry.topConversations
        : [],
      topWorkspaces: Array.isArray(cachedEntry.topWorkspaces) ? cachedEntry.topWorkspaces : [],
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

export const CLIENT_TOPBAR_SLOT_KEYS = TOPBAR_SLOT_KEYS;
export const DEFAULT_CLIENT_TOPBAR_SLOTS = DEFAULT_TOPBAR_SLOTS;
export const DEFAULT_CLIENT_CONTEXT_AGENT_MODE = DEFAULT_CONTEXT_AGENT_MODE;
export const CLIENT_CLI_STATUSLINE_PRESETS = CLI_STATUSLINE_PRESETS;
export const DEFAULT_CLIENT_CLI_STATUSLINE_SLOTS = DEFAULT_CLI_STATUSLINE_SLOTS;
export const CLIENT_OVERVIEW_MODULE_KEYS = OVERVIEW_MODULE_KEYS;
export const DEFAULT_CLIENT_OVERVIEW_MODULES = DEFAULT_OVERVIEW_MODULES;
export const DEFAULT_CLIENT_HOVER_MODULES = DEFAULT_HOVER_MODULES;
export const DEFAULT_CLIENT_HOVER_SYNC_OVERVIEW_METRICS = DEFAULT_HOVER_SYNC_OVERVIEW_METRICS;
export const DEFAULT_CLIENT_HOVER_METRIC_STYLE = DEFAULT_HOVER_METRIC_STYLE;
export const DEFAULT_CLIENT_HOVER_METRICS = DEFAULT_HOVER_METRICS;
export const DEFAULT_CLIENT_OVERVIEW_METRIC_STYLE = DEFAULT_OVERVIEW_METRIC_STYLE;
export const MAX_CLIENT_LARGE_METRIC_SLOTS = MAX_LARGE_METRIC_SLOTS;
export const CLIENT_OVERVIEW_METRIC_KEYS = OVERVIEW_METRIC_KEYS;
export const DEFAULT_CLIENT_OVERVIEW_METRICS = DEFAULT_OVERVIEW_METRICS;
export const CLIENT_STEP_COLUMN_KEYS = STEP_TABLE_COLUMN_KEYS;
export const DEFAULT_CLIENT_STEP_COLUMNS = DEFAULT_STEP_TABLE_COLUMNS;
export const DEFAULT_CLIENT_STEP_TOKEN_COMBO_FORMAT = DEFAULT_STEP_TOKEN_COMBO_FORMAT;
export const MIN_CLIENT_POPOVER_WIDTH = MIN_POPOVER_WIDTH;
export const MAX_CLIENT_POPOVER_WIDTH = MAX_POPOVER_WIDTH;
export const DEFAULT_CLIENT_POPOVER_WIDTH = DEFAULT_POPOVER_WIDTH;
export const DEFAULT_CLIENT_QUOTA_DISPLAY_MODE = DEFAULT_QUOTA_DISPLAY_MODE;

export const parseClientStepTokenComboSegments = parseStepTokenComboSegments;
export const normalizeClientStepTokenComboFormat = normalizeStepTokenComboFormat;
export const normalizeClientPopoverWidthMode = normalizePopoverWidthMode;
export const normalizeClientPopoverWidth = normalizePopoverWidth;
export const normalizeClientModelDisplayMode = normalizeModelDisplayMode;
export const normalizeClientTopbarSlots = normalizeTopbarCapsuleSlots;
export const normalizeClientContextAgentMode = normalizeContextAgentMode;
export const normalizeClientQuotaDisplayMode = normalizeQuotaDisplayMode;
export const normalizeClientExperimentalQuotaReservation = normalizeExperimentalQuotaReservation;
export const normalizeClientAccountQuotaRefreshMinutes = normalizeAccountQuotaRefreshMinutes;
export const normalizeClientCliStatusLineSlots = normalizeCliStatusLineSlots;

/**
 * 根据偏好设置返回默认上下文代理目标（`'main'` 锁定主代理，`'auto'` 跟随活跃）。
 *
 * @param {Record<string, any>|null|undefined} settings
 * @returns {'main'|'auto'}
 */
export function getDefaultCtxInspectorAgentId(settings) {
  return normalizeContextAgentMode(settings?.contextAgentMode) === 'auto' ? 'auto' : 'main';
}

/**
 * 计算顶栏挂载胶囊及悬停速览浮窗应使用的上下文代理目标：
 * - 当 `contextAgentMode === 'main'`（默认）时始终锁定 `'main'`，不被后台子代理或面板临时点选带偏；
 * - 当 `contextAgentMode === 'auto'` 时跟随面板当前 `ctxInspectorAgentId`（含手动点选 `主`）。
 *
 * @param {Record<string, any>|null|undefined} telemetry
 * @param {string} [ctxInspectorAgentId='auto']
 * @returns {string}
 */
export function resolveOverlayCtxInspectorAgentId(telemetry, ctxInspectorAgentId = 'auto') {
  if (normalizeContextAgentMode(telemetry?.settings?.contextAgentMode) === 'main') {
    return 'main';
  }
  return ctxInspectorAgentId || 'auto';
}
export const resolveEffectiveClientCliStatusLineSlots = resolveEffectiveCliStatusLineSlots;
export const normalizeClientHoverModules = normalizeHoverModules;
export const normalizeClientHoverSyncOverviewMetrics = normalizeHoverSyncOverviewMetrics;
export const normalizeClientHoverMetricStyle = normalizeHoverMetricStyle;
export const normalizeClientHoverMetrics = normalizeHoverMetrics;
export const normalizeClientOverviewModules = normalizeOverviewModules;
export const normalizeClientOverviewMetricStyle = normalizeOverviewMetricStyle;
export const normalizeClientOverviewMetrics = normalizeOverviewMetrics;
export const resolveEffectiveClientMetricMatrixConfig = resolveEffectiveMetricMatrixConfig;
export const normalizeClientStepColumns = normalizeStepTableColumns;
export const normalizeClientUpdateMode = normalizePluginUpdateMode;
export const normalizeClientWindowMountMode = normalizeWindowMountMode;
export const normalizeClientDisplayCurrency = normalizeDisplayCurrency;

export function isEquivalentTelemetry(prev, next) {
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

  if ((pSet?.language ?? 'auto') !== (nSet?.language ?? 'auto')) return false;
  if (
    normalizeDisplayCurrency(pSet?.displayCurrency) !==
    normalizeDisplayCurrency(nSet?.displayCurrency)
  ) {
    return false;
  }
  if ((pSet?.themeAccent ?? 'host') !== (nSet?.themeAccent ?? 'host')) return false;
  if ((pSet?.fontScale ?? 'md') !== (nSet?.fontScale ?? 'md')) return false;
  if (resolveSettingsModernUi(pSet) !== resolveSettingsModernUi(nSet)) return false;
  if ((prev.hostPlatform || '') !== (next.hostPlatform || '')) return false;
  if (getHostThemeSignature(prev.hostTheme) !== getHostThemeSignature(next.hostTheme)) return false;
  if (
    (prev.endpoint?.id || LOCAL_ENDPOINT_ID) !== (next.endpoint?.id || LOCAL_ENDPOINT_ID) ||
    Boolean(prev.endpoint?.isRemote) !== Boolean(next.endpoint?.isRemote) ||
    (prev.endpoint?.label || '') !== (next.endpoint?.label || '')
  ) {
    return false;
  }
  if (
    Boolean(pSet?.developerModeEnabled) !== Boolean(nSet?.developerModeEnabled) ||
    Boolean(pSet?.riskyFeaturesEnabled) !== Boolean(nSet?.riskyFeaturesEnabled)
  ) {
    return false;
  }
  if (Boolean(pSet?.contextWindowRiskAccepted) !== Boolean(nSet?.contextWindowRiskAccepted)) {
    return false;
  }
  if (
    (pSet?.contextWindowMainEnabled !== false) !== (nSet?.contextWindowMainEnabled !== false) ||
    Boolean(pSet?.contextWindowSwarmEnabled) !== Boolean(nSet?.contextWindowSwarmEnabled)
  ) {
    return false;
  }
  if (
    (prev.cloudCodeProxy?.state || 'disabled') !== (next.cloudCodeProxy?.state || 'disabled') ||
    Number(prev.cloudCodeProxy?.ruleCount || 0) !== Number(next.cloudCodeProxy?.ruleCount || 0) ||
    String(prev.cloudCodeProxy?.error || '') !== String(next.cloudCodeProxy?.error || '') ||
    Number(prev.cloudCodeProxy?.syncedAtMs || 0) !== Number(next.cloudCodeProxy?.syncedAtMs || 0)
  ) {
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
  if (!sameArr(pSet?.cliStatusLineSlots, nSet?.cliStatusLineSlots)) return false;
  if ((pSet?.showTopbarMultiSession !== false) !== (nSet?.showTopbarMultiSession !== false)) {
    return false;
  }
  if (
    normalizeClientContextAgentMode(pSet?.contextAgentMode) !==
    normalizeClientContextAgentMode(nSet?.contextAgentMode)
  ) {
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
  if (Boolean(pSet?.showStepFilterToolbar) !== Boolean(nSet?.showStepFilterToolbar)) {
    return false;
  }
  if (
    normalizeClientQuotaDisplayMode(pSet?.quotaDisplayMode) !==
    normalizeClientQuotaDisplayMode(nSet?.quotaDisplayMode)
  ) {
    return false;
  }
  if (
    normalizeClientExperimentalQuotaReservation(pSet?.experimentalQuotaReservation) !==
    normalizeClientExperimentalQuotaReservation(nSet?.experimentalQuotaReservation)
  ) {
    return false;
  }
  if (
    normalizeClientAccountQuotaRefreshMinutes(pSet?.accountQuotaRefreshMinutes) !==
    normalizeClientAccountQuotaRefreshMinutes(nSet?.accountQuotaRefreshMinutes)
  ) {
    return false;
  }
  if (Boolean(pSet?.accountSwitchRiskAccepted) !== Boolean(nSet?.accountSwitchRiskAccepted)) {
    return false;
  }
  if (Number(pSet?.standalonePort || 0) !== Number(nSet?.standalonePort || 0)) {
    return false;
  }
  if (
    normalizeAutoConfigureLaunch(pSet?.autoConfigureLaunch) !==
    normalizeAutoConfigureLaunch(nSet?.autoConfigureLaunch)
  ) {
    return false;
  }
  if (
    normalizeEnableRemoteSshTelemetry(pSet?.enableRemoteSshTelemetry) !==
    normalizeEnableRemoteSshTelemetry(nSet?.enableRemoteSshTelemetry)
  ) {
    return false;
  }
  if (!sameArr(pSet?.topbarCapsuleSlots, nSet?.topbarCapsuleSlots)) return false;
  if (!sameArr(pSet?.hoverModules, nSet?.hoverModules)) return false;
  if (
    normalizeClientHoverSyncOverviewMetrics(pSet?.hoverSyncOverviewMetrics) !==
    normalizeClientHoverSyncOverviewMetrics(nSet?.hoverSyncOverviewMetrics)
  ) {
    return false;
  }
  if (
    normalizeClientHoverMetricStyle(pSet?.hoverMetricStyle) !==
    normalizeClientHoverMetricStyle(nSet?.hoverMetricStyle)
  ) {
    return false;
  }
  if (!sameArr(pSet?.hoverMetrics, nSet?.hoverMetrics)) return false;
  if (!sameArr(pSet?.overviewModules, nSet?.overviewModules)) return false;
  if (
    normalizeClientOverviewMetricStyle(pSet?.overviewMetricStyle) !==
    normalizeClientOverviewMetricStyle(nSet?.overviewMetricStyle)
  ) {
    return false;
  }
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
    Boolean(pWb?.hasReadOnlyShortcuts) !== Boolean(nWb?.hasReadOnlyShortcuts) ||
    Boolean(pWb?.stalePortDetected) !== Boolean(nWb?.stalePortDetected) ||
    String(pWb?.targetProduct || 'auto') !== String(nWb?.targetProduct || 'auto') ||
    Boolean(pWb?.macWrapperExists) !== Boolean(nWb?.macWrapperExists) ||
    Boolean(pWb?.macDesktopWrapperExists) !== Boolean(nWb?.macDesktopWrapperExists) ||
    Boolean(pWb?.macIdeWrapperExists) !== Boolean(nWb?.macIdeWrapperExists) ||
    Boolean(pWb?.canRelaunch) !== Boolean(nWb?.canRelaunch) ||
    Number(pWb?.aliveCount || 0) !== Number(nWb?.aliveCount || 0)
  ) {
    return false;
  }
  const pCli = prev.cliStatusLine;
  const nCli = next.cliStatusLine;
  if (
    Boolean(pCli?.installed) !== Boolean(nCli?.installed) ||
    Boolean(pCli?.configured) !== Boolean(nCli?.configured) ||
    Boolean(pCli?.preservedCustom) !== Boolean(nCli?.preservedCustom) ||
    String(pCli?.managedFlags || '') !== String(nCli?.managedFlags || '')
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

  const pFx = prev.fxStatus;
  const nFx = next.fxStatus;
  if (
    pFx?.source !== nFx?.source ||
    pFx?.date !== nFx?.date ||
    Number(pFx?.fetchedAtMs || 0) !== Number(nFx?.fetchedAtMs || 0) ||
    Boolean(pFx?.isSyncing) !== Boolean(nFx?.isSyncing) ||
    (pFx?.lastError || null) !== (nFx?.lastError || null)
  ) {
    return false;
  }

  const pReb = prev.cacheRebuild;
  const nReb = next.cacheRebuild;
  if (
    Boolean(pReb?.active) !== Boolean(nReb?.active) ||
    Number(pReb?.completed || 0) !== Number(nReb?.completed || 0) ||
    Number(pReb?.total || 0) !== Number(nReb?.total || 0)
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
  if (pAct?.aggregated?.lastKnownTtftSec !== nAct?.aggregated?.lastKnownTtftSec) return false;
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
  if (pAct?.lastKnownTtftSec !== nAct?.lastKnownTtftSec) return false;
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
      pa?.lastKnownTtftSec !== na?.lastKnownTtftSec ||
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
        bs?.nativeStreamSec !== as?.nativeStreamSec ||
        bs?.thinkingDurationSec !== as?.thinkingDurationSec ||
        Boolean(bs?.hasToolCalls) !== Boolean(as?.hasToolCalls) ||
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
      before.nativeStreamSec !== after.nativeStreamSec ||
      before.thinkingDurationSec !== after.thinkingDurationSec ||
      Boolean(before.hasToolCalls) !== Boolean(after.hasToolCalls) ||
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

  // 5. 比对消费统计所选时间区间、当前会话累计消费和账号全局累计消费
  const pRange = prev.consumption?.selectedRange;
  const nRange = next.consumption?.selectedRange;
  if (pRange?.key !== nRange?.key) return false;
  if ((pRange?.pool || 'all') !== (nRange?.pool || 'all')) return false;
  if ((pRange?.label || '') !== (nRange?.label || '')) return false;
  if (Boolean(pRange?.isFallbackWeek) !== Boolean(nRange?.isFallbackWeek)) return false;
  if (nRange?.key === 'custom' || nRange?.key === 'cycle') {
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
        a[k]?.inputTokens !== b[k]?.inputTokens ||
        a[k]?.cacheReadTokens !== b[k]?.cacheReadTokens ||
        a[k]?.thinkingTokens !== b[k]?.thinkingTokens ||
        a[k]?.responseTokens !== b[k]?.responseTokens ||
        a[k]?.calls !== b[k]?.calls ||
        (a[k]?.avgTokPerSec ?? null) !== (b[k]?.avgTokPerSec ?? null) ||
        (a[k]?.avgTtftSec ?? null) !== (b[k]?.avgTtftSec ?? null) ||
        (a[k]?.cacheHitPct ?? null) !== (b[k]?.cacheHitPct ?? null) ||
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
      pTrend[i]?.inputTokens !== nTrend[i]?.inputTokens ||
      pTrend[i]?.cacheReadTokens !== nTrend[i]?.cacheReadTokens ||
      pTrend[i]?.thinkingTokens !== nTrend[i]?.thinkingTokens ||
      pTrend[i]?.responseTokens !== nTrend[i]?.responseTokens ||
      pTrend[i]?.calls !== nTrend[i]?.calls ||
      pTrend[i]?.granularity !== nTrend[i]?.granularity ||
      pTrend[i]?.stepMinutes !== nTrend[i]?.stepMinutes ||
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

  const pTopConvs = prev.consumption?.topConversations || [];
  const nTopConvs = next.consumption?.topConversations || [];
  if (pTopConvs.length !== nTopConvs.length) return false;
  for (let i = 0; i < pTopConvs.length; i++) {
    if (
      pTopConvs[i]?.cascadeId !== nTopConvs[i]?.cascadeId ||
      pTopConvs[i]?.title !== nTopConvs[i]?.title ||
      pTopConvs[i]?.totalTokens !== nTopConvs[i]?.totalTokens ||
      pTopConvs[i]?.costUsd !== nTopConvs[i]?.costUsd ||
      pTopConvs[i]?.calls !== nTopConvs[i]?.calls ||
      !areModelSlicesEqual(pTopConvs[i]?.models, nTopConvs[i]?.models)
    ) {
      return false;
    }
  }

  const pTopWs = prev.consumption?.topWorkspaces || [];
  const nTopWs = next.consumption?.topWorkspaces || [];
  if (pTopWs.length !== nTopWs.length) return false;
  for (let i = 0; i < pTopWs.length; i++) {
    if (
      pTopWs[i]?.workspaceKey !== nTopWs[i]?.workspaceKey ||
      pTopWs[i]?.label !== nTopWs[i]?.label ||
      pTopWs[i]?.sessionCount !== nTopWs[i]?.sessionCount ||
      pTopWs[i]?.totalTokens !== nTopWs[i]?.totalTokens ||
      pTopWs[i]?.costUsd !== nTopWs[i]?.costUsd ||
      pTopWs[i]?.calls !== nTopWs[i]?.calls ||
      !areModelSlicesEqual(pTopWs[i]?.models, nTopWs[i]?.models)
    ) {
      return false;
    }
  }

  // 8. 比对账号订阅档位与动态多配额池
  if (
    prev.account?.email !== next.account?.email ||
    prev.account?.name !== next.account?.name ||
    prev.account?.status !== next.account?.status ||
    prev.account?.tierId !== next.account?.tierId ||
    prev.account?.tierName !== next.account?.tierName ||
    prev.account?.tierMultiplier !== next.account?.tierMultiplier ||
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
      pPools[i]?.reservedPct !== nPools[i]?.reservedPct ||
      pPools[i]?.reservedLeaseCount !== nPools[i]?.reservedLeaseCount ||
      pPools[i]?.externalUsedPct !== nPools[i]?.externalUsedPct ||
      pPools[i]?.resetTime !== nPools[i]?.resetTime ||
      pPools[i]?.weeklyUsedPct !== nPools[i]?.weeklyUsedPct ||
      pPools[i]?.weeklyRemainingPct !== nPools[i]?.weeklyRemainingPct ||
      pPools[i]?.weeklyReservedPct !== nPools[i]?.weeklyReservedPct ||
      pPools[i]?.weeklyReservedLeaseCount !== nPools[i]?.weeklyReservedLeaseCount ||
      pPools[i]?.weeklyExternalUsedPct !== nPools[i]?.weeklyExternalUsedPct ||
      pPools[i]?.weeklyResetTime !== nPools[i]?.weeklyResetTime ||
      pPools[i]?.cycle5h?.tokens !== nPools[i]?.cycle5h?.tokens ||
      pPools[i]?.cycle5h?.costUsd !== nPools[i]?.cycle5h?.costUsd ||
      pPools[i]?.cycle5h?.calls !== nPools[i]?.cycle5h?.calls ||
      pPools[i]?.cycleWeekly?.tokens !== nPools[i]?.cycleWeekly?.tokens ||
      pPools[i]?.cycleWeekly?.costUsd !== nPools[i]?.cycleWeekly?.costUsd ||
      pPools[i]?.cycleWeekly?.calls !== nPools[i]?.cycleWeekly?.calls ||
      JSON.stringify(pPools[i]?.rateEstimate || null) !==
        JSON.stringify(nPools[i]?.rateEstimate || null)
    ) {
      return false;
    }
  }
  if (
    JSON.stringify(prev.quotas?.weeklyCapacityEstimate || null) !==
    JSON.stringify(next.quotas?.weeklyCapacityEstimate || null)
  ) {
    return false;
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
      (pConvs[i]?.workspaceName || '') !== (nConvs[i]?.workspaceName || '') ||
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

export function resetTelemetryForEndpointSwitch() {
  endpointSwitchEpoch += 1;
  latestRequestSeq += 1;
  latestConsumptionReqSeq += 1;
  latestConversationSwitchSeq += 1;
  lastReceivedSteps = null;
  inFlightTelemetryPoll = null;
  consecutivePollFailures = 0;
  consumptionCacheScopeSig = '';
  abortSidecarApiKey('telemetry-poll');
  abortSidecarApiKey('telemetry-force');
  abortSidecarApiKey('consumption-range');
  abortSidecarApiKey('consumption-presets');
  abortSidecarApiKey('conversation-switch');
  clearConsumptionRangeCache();
  clearConversationViewCache();
  if (feedbackTimer) {
    clearTimeout(feedbackTimer);
    feedbackTimer = null;
  }
  telemetryStore.setState({
    selectedConversationId: '',
    telemetry: null,
    syncState: 'idle',
  });
}

export async function fetchTelemetry({ force = false } = {}) {
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
  if (
    current.selectedTimeRange === 'cycle' &&
    current.selectedCyclePool &&
    current.selectedCyclePool !== 'all'
  ) {
    params.set('pool', current.selectedCyclePool);
  }
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
  const endpointId = bridge?.[WINDOW_BRIDGE_ENDPOINT_KEY] || LOCAL_ENDPOINT_ID;
  const existing = inFlightTelemetryPoll;
  if (
    existing?.query === query &&
    existing.port === bridge?.port &&
    existing.token === bridge?.token &&
    existing.endpointId === endpointId
  ) {
    return existing.promise;
  }
  const poll = { query, port: bridge?.port, token: bridge?.token, endpointId, promise: null };
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

function clearCachesIfRebuildFinished(prevTelemetry, nextPayload) {
  if (Boolean(prevTelemetry?.cacheRebuild?.active) && !nextPayload?.cacheRebuild?.active) {
    clearConsumptionRangeCache();
    clearConversationViewCache();
  }
}

async function requestTelemetry(params, force) {
  const reqSeq = ++latestRequestSeq;
  const reqSettingsRev = settingsRevision;
  const reqRange = String(params.get('range') || '');
  const reqPool = String(params.get('pool') || 'all');
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
    clearCachesIfRebuildFinished(telemetryStore.getState().telemetry, resolvedPayload);
    syncConsumptionCacheScope(resolvedPayload);
    recordConversationViewToCache(resolvedPayload);
    if (resolvedPayload?.consumption) {
      recordConsumptionSliceToCache(resolvedPayload.consumption, resolvedPayload.modelBreakdown, {
        customStartMs: reqStartMs,
        customEndMs: reqEndMs,
        cyclePool: reqPool,
      });
    }

    const latestSt = telemetryStore.getState();
    const incomingRev = Number(resolvedPayload?.consumption?.revision || 0);
    const activePoolPref = latestSt.selectedCyclePool || 'all';
    const matchesCurrentRange =
      !reqRange ||
      (reqRange === latestSt.selectedTimeRange &&
        (reqRange !== 'cycle' || reqPool === activePoolPref) &&
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
        latestSt.customEndMs,
        activePoolPref
      );
      const cachedActive = consumptionRangeCache.get(activeKey);
      if (cachedActive) {
        resolvedPayload = applyCachedConsumptionSlice(resolvedPayload, cachedActive, incomingRev);
        if (incomingRev > 0 && cachedActive.revision !== incomingRev) {
          needsSilentRangeRevalidate = true;
        }
      } else if (
        latestSt.telemetry?.consumption?.selectedRange?.key === latestSt.selectedTimeRange &&
        (latestSt.selectedTimeRange !== 'cycle' ||
          (latestSt.telemetry?.consumption?.selectedRange?.pool || 'all') === activePoolPref)
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
            topConversations: latestSt.telemetry.consumption.topConversations,
            topWorkspaces: latestSt.telemetry.consumption.topWorkspaces,
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
      clearCachesIfRebuildFinished(telemetryStore.getState().telemetry, finalForcePayload);
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
          cyclePool: latestSt.selectedCyclePool || 'all',
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
        const nextDelay = telemetryStore.getState().telemetry?.cacheRebuild?.active
          ? Math.min(loopIntervalMs, 800)
          : loopIntervalMs;
        pollTimer = setTimeout(loopTickFn, nextDelay);
      }
    }
  }
}

async function fetchConsumptionRangeSlice({
  range,
  customStartMs = 0,
  customEndMs = 0,
  cyclePool = 'all',
} = {}) {
  const reqEpoch = endpointSwitchEpoch;
  const reqSeq = ++latestConsumptionReqSeq;
  const targetRange = String(range || 'today');
  const targetPool = targetRange === 'cycle' ? String(cyclePool || 'all') : 'all';
  const current = telemetryStore.getState();
  const effectiveConvId = current.selectedConversationId || current.hostRouteConversationId || '';
  const params = new URLSearchParams();
  if (effectiveConvId) params.set('conversationId', effectiveConvId);
  params.set('range', targetRange);
  if (targetRange === 'cycle' && targetPool !== 'all') {
    params.set('pool', targetPool);
  }
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
    if (!payload || typeof payload !== 'object' || reqEpoch !== endpointSwitchEpoch) return null;

    if (payload.scope === 'consumption' && payload.consumption) {
      const usageRev = Number(payload.usageRevision ?? payload.consumption.revision ?? 0);
      recordConsumptionSliceToCache(payload.consumption, payload.modelBreakdown, {
        customStartMs,
        customEndMs,
        cyclePool: targetPool,
        usageRevision: usageRev,
      });
      if (reqSeq !== latestConsumptionReqSeq) return payload;

      const latestSt = telemetryStore.getState();
      const stillMatches =
        latestSt.selectedTimeRange === targetRange &&
        (targetRange !== 'cycle' || (latestSt.selectedCyclePool || 'all') === targetPool) &&
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
      clearCachesIfRebuildFinished(telemetryStore.getState().telemetry, payload);
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
export async function selectConversation(
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
  if (
    current.selectedTimeRange === 'cycle' &&
    current.selectedCyclePool &&
    current.selectedCyclePool !== 'all'
  ) {
    params.set('pool', current.selectedCyclePool);
  }
  if (current.selectedTimeRange === 'custom') {
    if (current.customStartMs > 0) params.set('startMs', String(current.customStartMs));
    if (current.customEndMs > 0) params.set('endMs', String(current.customEndMs));
  }
  params.set('stepDetails', 'display');
  params.set('stepRevision', cachedSteps?.revision || '');
  params.set('scope', 'conversation');

  const reqEpoch = endpointSwitchEpoch;
  const reqSettingsRev = settingsRevision;
  try {
    const payload = await callSidecarApi(`/api/telemetry?${params}`, {
      method: 'GET',
      abortKey: 'conversation-switch',
    });
    if (!payload || typeof payload !== 'object' || reqEpoch !== endpointSwitchEpoch) return null;
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
    clearCachesIfRebuildFinished(telemetryStore.getState().telemetry, resolvedPayload);
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
export function selectConsumptionTimeRange(
  nextRange,
  { customStartMs = undefined, customEndMs = undefined, cyclePool = undefined } = {}
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
  const nextCyclePool =
    targetRange === 'cycle'
      ? String(cyclePool !== undefined ? cyclePool || 'all' : prevSt.selectedCyclePool || 'all')
      : prevSt.selectedCyclePool || 'all';

  const statePatch = { selectedTimeRange: targetRange };
  if (cyclePool !== undefined) {
    statePatch.selectedCyclePool = nextCyclePool;
  }
  if (targetRange === 'custom') {
    statePatch.customStartMs = nextStartMs;
    statePatch.customEndMs = nextEndMs;
  }

  const cacheKey = makeConsumptionRangeCacheKey(
    targetRange,
    nextStartMs,
    nextEndMs,
    targetRange === 'cycle' ? nextCyclePool : 'all'
  );
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
      cyclePool: nextCyclePool,
    });
  }

  telemetryStore.setState(statePatch);
  return fetchConsumptionRangeSlice({
    range: targetRange,
    customStartMs: nextStartMs,
    customEndMs: nextEndMs,
    cyclePool: nextCyclePool,
  });
}

export function selectConsumptionCyclePool(nextPool = 'all') {
  return selectConsumptionTimeRange('cycle', { cyclePool: String(nextPool || 'all') });
}

/**
 * 仅在进入「用量统计」视图时触发一次静默后台预取，拉齐全部 7 个预设区间到前端缓存以实现 0ms 瞬切。
 */
export function prefetchConsumptionPresets() {
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

  const reqEpoch = endpointSwitchEpoch;
  const task = callSidecarApi(`/api/telemetry?${params}`, {
    method: 'GET',
    abortKey: 'consumption-presets',
  })
    .then((payload) => {
      if (reqEpoch !== endpointSwitchEpoch) return false;
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

export async function saveSettingsPatch(patch) {
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
  if (Object.prototype.hasOwnProperty.call(safePatch, 'modernUi')) {
    const normModern = normalizeClientModernUi(safePatch.modernUi);
    safePatch.modernUi = normModern;
    safePatch.experimentalModernUi = normModern;
  } else if (Object.prototype.hasOwnProperty.call(safePatch, 'experimentalModernUi')) {
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
  if (Object.prototype.hasOwnProperty.call(safePatch, 'contextAgentMode')) {
    safePatch.contextAgentMode = normalizeClientContextAgentMode(safePatch.contextAgentMode);
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
  if (Object.prototype.hasOwnProperty.call(safePatch, 'showStepFilterToolbar')) {
    safePatch.showStepFilterToolbar = Boolean(safePatch.showStepFilterToolbar);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'quotaDisplayMode')) {
    safePatch.quotaDisplayMode = normalizeClientQuotaDisplayMode(safePatch.quotaDisplayMode);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'experimentalQuotaReservation')) {
    safePatch.experimentalQuotaReservation = normalizeClientExperimentalQuotaReservation(
      safePatch.experimentalQuotaReservation
    );
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'accountQuotaRefreshMinutes')) {
    safePatch.accountQuotaRefreshMinutes = normalizeClientAccountQuotaRefreshMinutes(
      safePatch.accountQuotaRefreshMinutes
    );
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'developerModeEnabled')) {
    safePatch.developerModeEnabled = normalizeDeveloperModeEnabled(safePatch.developerModeEnabled);
    if (!safePatch.developerModeEnabled) {
      safePatch.riskyFeaturesEnabled = false;
      safePatch.accountSwitchRiskAccepted = false;
      safePatch.contextWindowRiskAccepted = false;
      safePatch.contextWindowSwarmEnabled = false;
    }
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'riskyFeaturesEnabled')) {
    const effectiveDevMode = Object.prototype.hasOwnProperty.call(safePatch, 'developerModeEnabled')
      ? safePatch.developerModeEnabled
      : telemetryStore.getState().telemetry?.settings?.developerModeEnabled === true;
    safePatch.riskyFeaturesEnabled = normalizeRiskyFeaturesEnabled(
      safePatch.riskyFeaturesEnabled,
      effectiveDevMode
    );
    if (!safePatch.riskyFeaturesEnabled) {
      safePatch.accountSwitchRiskAccepted = false;
      safePatch.contextWindowRiskAccepted = false;
      safePatch.contextWindowSwarmEnabled = false;
    }
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'accountSwitchRiskAccepted')) {
    safePatch.accountSwitchRiskAccepted = Boolean(safePatch.accountSwitchRiskAccepted);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'topbarCapsuleSlots')) {
    safePatch.topbarCapsuleSlots = normalizeClientTopbarSlots(safePatch.topbarCapsuleSlots);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'cliStatusLineSlots')) {
    safePatch.cliStatusLineSlots = normalizeClientCliStatusLineSlots(safePatch.cliStatusLineSlots);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'hoverModules')) {
    safePatch.hoverModules = normalizeClientHoverModules(safePatch.hoverModules);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'hoverSyncOverviewMetrics')) {
    safePatch.hoverSyncOverviewMetrics = normalizeClientHoverSyncOverviewMetrics(
      safePatch.hoverSyncOverviewMetrics
    );
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'hoverMetricStyle')) {
    safePatch.hoverMetricStyle = normalizeClientHoverMetricStyle(safePatch.hoverMetricStyle);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'hoverMetrics')) {
    safePatch.hoverMetrics = normalizeClientHoverMetrics(safePatch.hoverMetrics);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'overviewModules')) {
    safePatch.overviewModules = normalizeClientOverviewModules(safePatch.overviewModules);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'overviewMetricStyle')) {
    safePatch.overviewMetricStyle = normalizeClientOverviewMetricStyle(
      safePatch.overviewMetricStyle
    );
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
  if (Object.prototype.hasOwnProperty.call(safePatch, 'contextWindowMainEnabled')) {
    safePatch.contextWindowMainEnabled = Boolean(safePatch.contextWindowMainEnabled);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'contextWindowSwarmEnabled')) {
    safePatch.contextWindowSwarmEnabled = Boolean(safePatch.contextWindowSwarmEnabled);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'standalonePort')) {
    const numPort = Number(safePatch.standalonePort);
    safePatch.standalonePort =
      Number.isInteger(numPort) && numPort >= 1024 && numPort <= 65535 ? numPort : 0;
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'autoConfigureLaunch')) {
    safePatch.autoConfigureLaunch = normalizeAutoConfigureLaunch(safePatch.autoConfigureLaunch);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'enableRemoteSshTelemetry')) {
    safePatch.enableRemoteSshTelemetry = normalizeEnableRemoteSshTelemetry(
      safePatch.enableRemoteSshTelemetry
    );
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

export async function saveModelContextWindow(modelId, option) {
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

export async function resetAllSettings() {
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

export async function rebuildTrajectoryCache() {
  const res = await callSidecarApi('/api/cache/rebuild', { method: 'POST', body: {} });
  clearConsumptionRangeCache();
  clearConversationViewCache();
  const latestTelemetry = await fetchTelemetry({ force: true });
  return {
    ...(res && typeof res === 'object' ? res : {}),
    cacheRebuild: latestTelemetry?.cacheRebuild || null,
  };
}

export async function triggerCloudSync() {
  const res = await callSidecarApi('/api/cloud-sync', { method: 'POST', body: {} });
  clearConsumptionRangeCache();
  clearConversationViewCache();
  await fetchTelemetry({ force: true });
  return res;
}

export async function triggerFxSync() {
  let res;
  try {
    res = await callSidecarApi('/api/fx-sync', { method: 'POST', body: {} });
  } catch {
    res = await callSidecarApi('/api/settings', {
      method: 'POST',
      body: { __fxAction: 'sync' },
    });
  }
  if (res?.fxStatus) {
    const cur = telemetryStore.getState().telemetry;
    if (cur) {
      telemetryStore.setState({
        telemetry: { ...cur, fxStatus: res.fxStatus },
      });
    }
  }
  return res;
}

export const normalizeClientAutoConfigureLaunch = normalizeAutoConfigureLaunch;
export const normalizeClientEnableRemoteSshTelemetry = normalizeEnableRemoteSshTelemetry;

export async function triggerBridgeHostRelaunch(options = {}) {
  const payload =
    options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  let res;
  try {
    res = await callSidecarApi('/api/bridge/relaunch', { method: 'POST', body: payload });
  } catch {
    // 兼容热更新后常驻父进程 main.mjs 尚未重注册新路由的场景，平滑回退至既有 POST /api/settings 通道转发至最新 Worker
    res = await callSidecarApi('/api/settings', {
      method: 'POST',
      body: { ...payload, __bridgeAction: 'relaunch' },
    });
  }
  if (
    payload.action === 'create_macos_wrapper' ||
    payload.action === 'remove_macos_wrapper'
  ) {
    const cur = telemetryStore.getState().telemetry;
    if (cur && res && typeof res === 'object' && typeof res.macWrapperExists === 'boolean') {
      telemetryStore.setState({
        telemetry: {
          ...cur,
          windowBridge: {
            ...(cur.windowBridge || {}),
            macWrapperExists: res.macWrapperExists,
            ...(typeof res.macDesktopWrapperExists === 'boolean'
              ? { macDesktopWrapperExists: res.macDesktopWrapperExists }
              : {}),
            ...(typeof res.macIdeWrapperExists === 'boolean'
              ? { macIdeWrapperExists: res.macIdeWrapperExists }
              : {}),
            macWrapperPaths: Array.isArray(res.macWrapperPaths) ? res.macWrapperPaths : [],
          },
        },
      });
    }
    void fetchTelemetry({ force: true }).catch(() => {});
  }
  return res;
}

export async function triggerCliStatusLineAction(action) {
  const res = await callSidecarApi('/api/settings', {
    method: 'POST',
    body: { __cliStatusLineAction: String(action || 'force_install') },
  });
  const cur = telemetryStore.getState().telemetry;
  if (cur && res && typeof res === 'object') {
    const nextTelemetry = {
      ...cur,
      ...(res.cliStatusLine ? { cliStatusLine: res.cliStatusLine } : {}),
      ...(res.settings ? { settings: { ...cur.settings, ...res.settings } } : {}),
    };
    telemetryStore.setState({ telemetry: nextTelemetry });
  }
  void fetchTelemetry({ force: true }).catch(() => {});
  return res;
}

export async function fetchSessionMigrationCatalog() {
  try {
    return await callSidecarApi('/api/session-migration/catalog', { method: 'GET' });
  } catch {
    return callSidecarApi('/api/settings', {
      method: 'POST',
      body: { __sessionMigrationAction: 'catalog' },
    });
  }
}

export async function fetchQuotaReservationLog() {
  try {
    return await callSidecarApi('/api/quota-reservation/log', { method: 'GET' });
  } catch {
    return callSidecarApi('/api/settings', {
      method: 'POST',
      body: { __quotaReservationAction: 'log' },
    });
  }
}

export async function executeSessionMigration(payload) {
  let res;
  try {
    res = await callSidecarApi('/api/session-migration/migrate', {
      method: 'POST',
      body: payload || {},
    });
  } catch {
    res = await callSidecarApi('/api/settings', {
      method: 'POST',
      body: { __sessionMigrationAction: 'migrate', payload: payload || {} },
    });
  }
  if (res?.migratedCount > 0) {
    void fetchTelemetry({ force: true }).catch(() => {});
  }
  return res;
}

function isUnregisteredSessionRouteError(err) {
  if (!err || Number(err.httpStatus) !== 404) return false;
  if (err.data && typeof err.data === 'object' && err.data.ok === false) return false;
  const msg = String(err.message || '').trim();
  return /^(?:not found|http 404|unknown.*route)$/i.test(msg);
}

async function callSessionManagerEndpoint(path, method, fallbackAction, payload = undefined) {
  try {
    return await callSidecarApi(path, {
      method,
      ...(method === 'POST' ? { body: payload || {} } : {}),
    });
  } catch (err) {
    if (!isUnregisteredSessionRouteError(err)) {
      if (err?.data && typeof err.data === 'object' && err.data.ok === false) {
        return err.data;
      }
      throw err;
    }
  }
  try {
    return await callSidecarApi('/api/settings', {
      method: 'POST',
      body: {
        __sessionManagerAction: fallbackAction,
        ...(payload !== undefined ? { payload } : {}),
      },
    });
  } catch (fallbackErr) {
    if (
      fallbackErr?.data &&
      typeof fallbackErr.data === 'object' &&
      fallbackErr.data.ok === false
    ) {
      return fallbackErr.data;
    }
    throw fallbackErr;
  }
}

export async function fetchLocalSessionsList() {
  return callSessionManagerEndpoint('/api/sessions/list', 'GET', 'list');
}

export async function fetchSessionCleanupPreview(payload) {
  return callSessionManagerEndpoint(
    '/api/sessions/cleanup-preview',
    'POST',
    'cleanup_preview',
    payload || {}
  );
}

export async function deleteLocalSessionsAction(payload) {
  const res = await callSessionManagerEndpoint(
    '/api/sessions/delete',
    'POST',
    'delete',
    payload || {}
  );
  if (res?.deletedCount > 0 || (res?.ledgerRedaction?.redactedConversations || 0) > 0) {
    void fetchTelemetry({ force: true }).catch(() => {});
  }
  return res;
}

export async function redactLocalLedgerPrivacy() {
  const res = await callSessionManagerEndpoint(
    '/api/sessions/redact-ledger',
    'POST',
    'redact_ledger',
    {}
  );
  if ((res?.redactedConversations || 0) > 0 || (res?.redactedSteps || 0) > 0) {
    void fetchTelemetry({ force: true }).catch(() => {});
  }
  return res;
}

export async function revealLocalSessionPathAction(targetPath, context = undefined) {
  return callSessionManagerEndpoint('/api/sessions/reveal', 'POST', 'reveal', {
    path: String(targetPath || ''),
    ...(context?.clientId ? { clientId: String(context.clientId) } : {}),
    ...(context?.sessionId ? { sessionId: String(context.sessionId) } : {}),
  });
}

export async function triggerPluginUpdate() {
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

export function startAsyncTelemetryLoop(intervalMs = 2000) {
  stopAsyncTelemetryLoop();
  loopActive = true;
  loopIntervalMs = intervalMs;

  const resolveNextDelay = () => {
    if (telemetryStore.getState().telemetry?.cacheRebuild?.active) {
      return Math.min(loopIntervalMs, 800);
    }
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

export function stopAsyncTelemetryLoop() {
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

export {
  formatAgentBadgeText,
  formatAgentLabel,
  formatConversationMeta,
  formatLiveActivityDetail,
  formatLiveActivityLabel,
  getAgentBadgeClass,
};

/**
 * 在遥测快照中解析宿主当前路由会话 ID（兼容顶层主会话 ID 与子代理/蜂群工蜂 ID）。
 *
 * @param {object|null|undefined} telemetry
 * @param {string} rawRouteId
 * @returns {{ rootConv: object|null, childAgent: object|null, isChildRoute: boolean } | null}
 */
export function resolveHostRouteMatch(telemetry, rawRouteId) {
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

export function resolveScopedConversation(
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
export function isMacHostPlatform(telemetry) {
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
