/**
 * @fileoverview Sidecar Webview 与主窗口双栖桥接共享的 API 路由分发与运行时引导层。
 *
 * 与 `sidecar_sdk` 完全解耦，使同一套遥测聚合、偏好持久化、云端目录同步与自更新逻辑可同时服务于：
 * 1. Antigravity 2.0 客户端右侧辅助栏 (`main.mjs` -> `SidecarApp`)；
 * 2. Antigravity IDE / 2.0 后台守护桥接进程 (`mcp-entry.mjs` -> `bridge-daemon.mjs`)。
 */

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { BRIDGE_API_ROUTE_DEFS, LOCAL_ENDPOINT_ID } from '../shared/window-bridge-protocol.mjs';
import {
  getAccountQuotaHistoryPayload,
  getLatestRecordedHostEmail,
} from './account-quota-history.mjs';
import { isAccountPlatformSupported } from './account-keyring-store.mjs';
import { handleAccountCredentialAction, warmAccountPublicListCache } from './account-switch.mjs';
import { issueAccountActionNonce, verifyAccountActionNonce } from './account-vault-crypto.mjs';
import {
  clearRemoteEndpointCaches,
  resolveEndpointContext,
  trackEndpointRequestEnd,
  trackEndpointRequestStart,
} from './endpoint-registry.mjs';
import { isLocalHostRequest, readLocalAsync } from './http-helpers.mjs';
import {
  revealLocalExportFile,
  revealLocalSessionPath,
  writeLocalExportFile,
} from './file-exporter.mjs';
import {
  clearScannerRuntimeMemos,
  collectAuthoritativeLiveCascadeIds,
  isLocalBackgroundRebuildActive,
} from './local-scanner.mjs';
import {
  SETTINGS_FILE,
  clearRuntimeCaches,
  cloudSyncState,
  computeRuntimeCodeVersion,
  createDefaultSettingsObject,
  inFlightRequests,
  isAccountSwitchFeatureActive,
  isContextWindowFeatureActive,
  isPlainObject,
  loadSettings,
  lsRuntimeEndpoint,
  normalizeFullSettings,
  normalizeMetricCardStyle,
  normalizeModelDisplayMode,
  normalizeModernUi,
  normalizePluginUpdateMode,
  normalizeTopbarMultiSessionMode,
  normalizeWindowMountMode,
  saveJson,
} from './config.mjs';
import {
  getContextWindowModels,
  getContextWindowGroups,
  isContextWindowSettingId,
  isContextWindowOption,
  resolveContextWindowOption,
} from './context-windows.mjs';
import { ensureLsEndpointDiscovered } from './ls-discovery.mjs';
import { callLsRpc, getContextModelCatalog } from './ls-rpc.mjs';
import {
  performPluginUpdate,
  scheduleSidecarRestart,
  setSidecarRestartHandler,
  syncCloudCatalog,
} from './plugin-updater.mjs';
import { getCloudStatus } from './pricing-catalog.mjs';
import { syncFxRates } from './fx-rates.mjs';
import { buildTelemetryPayload, clearTelemetryBuilderMemo } from './telemetry-builder.mjs';
import {
  createMacOsLaunchWrapper,
  ensureDesktopLaunchEntriesConfigured,
  inspectMacOsLaunchWrapperStatus,
  removeMacOsLaunchWrapper,
  triggerDesktopHostRelaunch,
} from './desktop-launcher-config.mjs';
import {
  collectHostI18nUntranslatedFromActiveTargets,
  ensureIdeRemoteDebuggingArgv,
  getDefaultWindowBridgeStatus,
  notifyHostI18nChanged,
  notifyModelContextWindowsChanged,
  notifyWindowOverlaySetting,
  resolveDevToolsPortCandidates,
  startDefaultWindowBridge,
} from './window-bridge.mjs';
import {
  handleHostI18nGetRequest,
  handleHostI18nPostAction,
} from './host-i18n/index.mjs';
import { getEffectiveHostTheme, recordPreloadHostTheme } from './host-theme-store.mjs';
import { getQuotaReservationLogSnapshot } from './quota-reservation.mjs';
import {
  authorizeSessionPathsForReveal,
  clearSessionManagerScanCaches,
  deleteLocalSessions,
  deleteLocalSessionsAsync,
  getAuthorizedRevealSnapshot,
  previewSessionCleanup,
  previewSessionCleanupAsync,
  scanLocalSessions,
  scanLocalSessionsAsync,
  sweepLedgerPrivacy,
} from './session-manager.mjs';
import { getSessionMigrationCatalog, migrateSessions } from './session-migrator.mjs';
import { SESSION_CLIENT_DEFS, resolveClientRoot } from './session-store.mjs';
import { clearUsageAggregatorMemo } from './usage-aggregator.mjs';
import {
  ensureCliStatusLineConfigured,
  getCliStatusLineRuntimeStatus,
} from './cli-statusline-config.mjs';

export const bootBundleVersion = computeRuntimeCodeVersion();

let standalonePortListener = null;

export function setStandalonePortListener(listener) {
  standalonePortListener = typeof listener === 'function' ? listener : null;
}

export { isLocalHostRequest, readLocalAsync };

const MAX_SAFE_DATE_MS = 8_640_000_000_000_000;

function sanitizePositiveFiniteMs(val) {
  const num = Number(val);
  return Number.isFinite(num) && num > 0 && num <= MAX_SAFE_DATE_MS ? Math.floor(num) : 0;
}

function projectDisplayStep(st) {
  const {
    stepIndex, createdAtMs, isCompactionStep, isImageGenStep, isReverted, modelKey, modelShort, modelLabel,
    modelUpstream, responseModel, modelSource, tokPerSec, ttftSec, totalDurationSec,
    nativeStreamSec, thinkingDurationSec, hasToolCalls, selectedSpeedReason, anomaly, anomalySig,
    contextTokens, inputTokens, cacheReadTokens,
    outputTokens, thinkingTokens, responseTokens, cacheHitPct, costUsd, inCostUsd,
    cacheCostUsd, outCostUsd, agentId, agentCascadeId, agentKind, agentOrdinal,
    agentCustomRole, agentLabel, agentBadge, agentRole, agentIndex, isSubagent,
    isSideQuestion, sideIndex, turnIndex, isTurnStart, isLatestTurn, turnPrompt,
    turnPromptClean, turnHasMedia, turnMediaOnly, rootTurnIndex, isRootTurnStart,
    isRootLatestTurn, rootTurnPrompt, rootTurnPromptClean, rootTurnHasMedia,
    rootTurnMediaOnly,
  } = st;
  return {
    stepIndex, createdAtMs, isCompactionStep, isImageGenStep,
    ...(isReverted ? { isReverted: true } : {}),
    modelKey, modelShort, modelLabel,
    modelUpstream, responseModel, modelSource, tokPerSec, ttftSec, totalDurationSec,
    nativeStreamSec, thinkingDurationSec, hasToolCalls, selectedSpeedReason,
    ...(anomaly ? { anomaly, anomalySig } : {}),
    contextTokens, inputTokens, cacheReadTokens,
    outputTokens, thinkingTokens, responseTokens, cacheHitPct, costUsd, inCostUsd,
    cacheCostUsd, outCostUsd, agentId, agentCascadeId, agentKind, agentOrdinal,
    agentCustomRole, agentLabel, agentBadge, agentRole, agentIndex, isSubagent,
    isSideQuestion, sideIndex, turnIndex, isTurnStart, isLatestTurn, turnPrompt,
    turnPromptClean, turnHasMedia, turnMediaOnly, rootTurnIndex, isRootTurnStart,
    isRootLatestTurn, rootTurnPrompt, rootTurnPromptClean, rootTurnHasMedia,
    rootTurnMediaOnly,
  };
}

const MAX_DISPLAY_STEP_CACHE_ENTRIES = 8;
const MAX_DISPLAY_STEP_CACHE_TOTAL_STEPS = 6000;
const displayStepsCache = new Map();

function countProjectedDisplaySteps(stepLists) {
  let total = 0;
  for (const list of stepLists || []) {
    if (Array.isArray(list)) total += list.length;
  }
  return total;
}

function pruneDisplayStepsCache() {
  let totalSteps = 0;
  for (const rec of displayStepsCache.values()) {
    totalSteps += Number(rec?.stepCount || 0);
  }
  while (
    displayStepsCache.size > MAX_DISPLAY_STEP_CACHE_ENTRIES ||
    (displayStepsCache.size > 2 && totalSteps > MAX_DISPLAY_STEP_CACHE_TOTAL_STEPS)
  ) {
    const oldestKey = displayStepsCache.keys().next().value;
    if (oldestKey === undefined) break;
    const evicted = displayStepsCache.get(oldestKey);
    displayStepsCache.delete(oldestKey);
    totalSteps -= Number(evicted?.stepCount || 0);
  }
}
const displayStepFields = Object.keys(
  projectDisplayStep({ anomaly: true, anomalySig: '', isReverted: true })
).filter((k) => k !== 'anomaly');

function buildEndpointErrorResponse(epCtx) {
  return {
    status: Number(epCtx?.status || 400),
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      error: epCtx?.error || 'Invalid endpointId',
      ...(epCtx?.retryable ? { retryable: true } : {}),
    }),
  };
}

function resolveActionEndpoint(data, opts) {
  const rawId =
    opts && opts.endpointId !== undefined
      ? opts.endpointId
      : isPlainObject(data) && data.endpointId !== undefined
        ? data.endpointId
        : undefined;
  return resolveEndpointContext(rawId);
}

function stripEndpointField(data) {
  if (!isPlainObject(data) || !Object.prototype.hasOwnProperty.call(data, 'endpointId')) {
    return data;
  }
  const { endpointId: _ignored, ...rest } = data;
  return rest;
}

function haveSameDisplaySteps(previous, current) {
  if (!previous || !current) return previous === current;
  if (previous.length !== current.length) return false;
  for (let i = 0; i < current.length; i++) {
    const before = previous[i];
    const after = current[i];
    for (const key of displayStepFields) {
      if (before[key] !== after[key]) return false;
    }
  }
  return true;
}

function projectDisplayTelemetry(payload, requestedRevision) {
  const active = payload.activeConversation;
  const agents = active.agents;
  const endpointKey = payload.endpoint?.id || LOCAL_ENDPOINT_ID;
  const sourceSteps = [active.recentSteps, ...agents.map((agent) => agent.recentSteps)];
  let projected;
  let revision;
  if (typeof requestedRevision === 'string') {
    const cacheKey = `${endpointKey}::${active.cascadeId || '__empty__'}`;
    const scope = [
      endpointKey,
      payload.account?.status,
      payload.account?.email || payload.account?.name || '',
      active.cascadeId,
      ...agents.map((agent) => agent.agentId),
    ];
    const previous = displayStepsCache.get(cacheKey);
    if (previous && isDeepStrictEqual(scope, previous.scope) &&
        sourceSteps.every((steps, index) => (steps && previous.sources[index]?.deref() === steps) ||
          haveSameDisplaySteps(previous.steps[index], steps))) {
      ({ revision, steps: projected } = previous);
      previous.sources = sourceSteps.map((steps) => steps ? new WeakRef(steps) : undefined);
      displayStepsCache.delete(cacheKey);
      displayStepsCache.set(cacheKey, previous);
    } else {
      revision = randomUUID();
      projected = sourceSteps.map((steps) => steps?.map(projectDisplayStep));
      displayStepsCache.delete(cacheKey);
      displayStepsCache.set(cacheKey, {
        scope,
        steps: projected,
        stepCount: countProjectedDisplaySteps(projected),
        revision,
        sources: sourceSteps.map((steps) => steps ? new WeakRef(steps) : undefined),
      });
      pruneDisplayStepsCache();
    }
  }
  projected ||= sourceSteps.map((steps) => steps?.map(projectDisplayStep));
  const stepsUnchanged = revision !== undefined && requestedRevision === revision;
  return {
    ...payload,
    ...(revision ? { stepRevision: revision, stepsUnchanged } : {}),
    activeConversation: {
      ...active,
      recentSteps: stepsUnchanged ? undefined : projected[0],
      agents: agents.map((agent, index) => projected[index + 1]
        ? { ...agent, recentSteps: stepsUnchanged ? undefined : projected[index + 1] }
        : agent),
    },
  };
}

export async function executeTelemetryAction(data, opts = {}) {
  const { onRestart = null } = opts || {};
  const epCtx = resolveActionEndpoint(data, opts);
  if (!epCtx.ok) {
    return buildEndpointErrorResponse(epCtx);
  }
  const isRemote = epCtx.isRemote;
  const rawConvId = String(
    data?.conversationId || (isRemote ? '' : process.env.ANTIGRAVITY_CONVERSATION_ID || '')
  ).trim();
  const convId = rawConvId && !/[\\/]|\.\./.test(rawConvId) ? rawConvId : '';
  const force = data?.force === '1' || data?.force === true;
  if (lsRuntimeEndpoint.addr !== 'test.invalid') {
    if (!isRemote && !lsRuntimeEndpoint.baseUrl) {
      await ensureLsEndpointDiscovered({ force: false });
    }
    if (isRemote || lsRuntimeEndpoint.baseUrl) {
      if (force && Date.now() - cloudSyncState.lastAttemptMs > 15_000) {
        await Promise.race([
          syncCloudCatalog({ force: true }).catch(() => {}),
          new Promise((r) => setTimeout(r, 1200)),
        ]);
      } else {
        syncCloudCatalog({ force: false }).catch(() => {});
      }
      syncFxRates({ force: false }).catch(() => {});
    }
  }
  const rawScope = String(data?.scope || '').trim();
  const scope =
    rawScope === 'consumption' ||
    rawScope === 'consumption-presets' ||
    rawScope === 'conversation'
      ? rawScope
      : '';
  const rawPool = typeof data?.pool === 'string' ? data.pool.trim().slice(0, 48) : '';
  const filterOpts = {
    range: data?.range || 'all',
    ...(rawPool ? { pool: rawPool } : {}),
    startMs: sanitizePositiveFiniteMs(data?.startMs),
    endMs: sanitizePositiveFiniteMs(data?.endMs),
    ...(scope ? { scope } : {}),
    ...(!isRemote &&
    (scope === '' || scope === 'conversation' || isLocalBackgroundRebuildActive())
      ? { progressiveLocalSync: true }
      : {}),
    endpoint: epCtx.endpoint,
  };
  let payload;
  trackEndpointRequestStart(epCtx.endpoint);
  try {
    payload = await buildTelemetryPayload(convId, force, filterOpts);
  } catch (err) {
    if (
      lsRuntimeEndpoint.addr !== 'test.invalid' &&
      bootBundleVersion &&
      String(computeRuntimeCodeVersion()) !== String(bootBundleVersion)
    ) {
      if (typeof onRestart === 'function') {
        onRestart();
      } else {
        scheduleSidecarRestart(150);
      }
    }
    throw err;
  } finally {
    trackEndpointRequestEnd(epCtx.endpoint);
  }
  if (
    bootBundleVersion &&
    payload?.uiBundleVersion &&
    String(payload.uiBundleVersion) !== String(bootBundleVersion)
  ) {
    if (typeof onRestart === 'function') {
      onRestart();
    } else {
      scheduleSidecarRestart(150);
    }
  }
  const isScopedConsumptionPayload =
    payload?.scope === 'consumption' || payload?.scope === 'consumption-presets';
  const responsePayload =
    !isScopedConsumptionPayload && data?.stepDetails === 'display'
      ? projectDisplayTelemetry(payload, data.stepRevision)
      : payload;
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(responsePayload),
  };
}

function sanitizePositiveSettingNumber(val, fallback) {
  const num = Number(val);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

export function executeSettingsAction(data) {
  const current = loadSettings();
  const payload = isPlainObject(data) ? stripEndpointField(data) : {};
  const nextPluginUpdateMode =
    payload.pluginUpdateMode !== undefined
      ? normalizePluginUpdateMode(payload.pluginUpdateMode)
      : typeof payload.autoUpdatePlugin === 'boolean'
        ? payload.autoUpdatePlugin
          ? 'auto'
          : 'manual'
        : normalizePluginUpdateMode(current.pluginUpdateMode, current.autoUpdatePlugin);
  const nextWindowMountMode =
    payload.windowMountMode !== undefined
      ? normalizeWindowMountMode(payload.windowMountMode)
      : typeof payload.enableWindowOverlay === 'boolean'
        ? payload.enableWindowOverlay
          ? current.windowMountMode === 'composer'
            ? 'composer'
            : 'dual'
          : 'sidebar'
        : normalizeWindowMountMode(current.windowMountMode, current.enableWindowOverlay);
  const nextModelDisplayMode =
    payload.modelDisplayMode !== undefined
      ? normalizeModelDisplayMode(payload.modelDisplayMode)
      : typeof payload.showUpstreamModel === 'boolean'
        ? payload.showUpstreamModel
          ? 'upstream'
          : 'short'
        : normalizeModelDisplayMode(current.modelDisplayMode, current.showUpstreamModel);
  const nextModernUi =
    payload.modernUi !== undefined
      ? normalizeModernUi(payload.modernUi)
      : payload.experimentalModernUi !== undefined
        ? normalizeModernUi(payload.experimentalModernUi)
        : normalizeModernUi(current.modernUi);
  const nextTopbarMultiSessionMode =
    payload.topbarMultiSessionMode !== undefined
      ? normalizeTopbarMultiSessionMode(
          payload.topbarMultiSessionMode,
          payload.showTopbarMultiSession
        )
      : typeof payload.showTopbarMultiSession === 'boolean'
        ? payload.showTopbarMultiSession
          ? 'show'
          : 'hide'
        : normalizeTopbarMultiSessionMode(
            current.topbarMultiSessionMode,
            current.showTopbarMultiSession
          );
  const legacyOverviewStyleOnly =
    payload.overviewMetricStyle !== undefined &&
    payload.overviewMetricRows === undefined &&
    payload.overviewMetricSizes === undefined &&
    (payload.overviewMetrics === undefined ||
      normalizeMetricCardStyle(payload.overviewMetricStyle) !== current.overviewMetricStyle);
  const legacyHoverStyleOnly =
    payload.hoverMetricStyle !== undefined &&
    payload.hoverMetricRows === undefined &&
    payload.hoverMetricSizes === undefined &&
    (payload.hoverMetrics === undefined ||
      normalizeMetricCardStyle(payload.hoverMetricStyle) !== current.hoverMetricStyle);
  const mergedForNorm = {
    ...current,
    ...payload,
    ...(legacyOverviewStyleOnly
      ? { overviewMetricRows: undefined, overviewMetricSizes: undefined }
      : {}),
    ...(legacyHoverStyleOnly
      ? { hoverMetricRows: undefined, hoverMetricSizes: undefined }
      : {}),
    modernUi: nextModernUi,
    topbarMultiSessionMode: nextTopbarMultiSessionMode,
    showTopbarMultiSession: nextTopbarMultiSessionMode !== 'hide',
    modelContextWindows: current.modelContextWindows,
    weeklyTokenBudget: sanitizePositiveSettingNumber(
      payload.weeklyTokenBudget ?? payload.weeklyTokenLimit,
      current.weeklyTokenBudget
    ),
    weeklyCostBudget: sanitizePositiveSettingNumber(
      payload.weeklyCostBudget,
      current.weeklyCostBudget
    ),
    modelDisplayMode: nextModelDisplayMode,
    pluginUpdateMode: nextPluginUpdateMode,
    windowMountMode: nextWindowMountMode,
  };
  const updated = normalizeFullSettings(mergedForNorm);
  if (!saveJson(SETTINGS_FILE, updated)) {
    return {
      ok: false,
      status: 500,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, error: 'Failed to persist settings' }),
    };
  }
  const prevMountMode = normalizeWindowMountMode(
    current.windowMountMode,
    current.enableWindowOverlay
  );
  const prevContextActive = isContextWindowFeatureActive(current);
  const nextContextActive = isContextWindowFeatureActive(updated);
  const riskyGateChanged =
    Boolean(updated.developerModeEnabled) !== Boolean(current.developerModeEnabled) ||
    Boolean(updated.riskyFeaturesEnabled) !== Boolean(current.riskyFeaturesEnabled) ||
    Boolean(updated.accountSwitchRiskAccepted) !== Boolean(current.accountSwitchRiskAccepted) ||
    Boolean(updated.contextWindowRiskAccepted) !== Boolean(current.contextWindowRiskAccepted);
  const contextWindowScopeChanged =
    prevContextActive !== nextContextActive ||
    (updated.contextWindowMainEnabled !== false) !== (current.contextWindowMainEnabled !== false) ||
    (updated.contextWindowSwarmEnabled === true) !== (current.contextWindowSwarmEnabled === true);
  const bridgeAuxChanged =
    (updated.autoConfigureLaunch !== false) !== (current.autoConfigureLaunch !== false) ||
    (updated.enableRemoteSshTelemetry !== false) !== (current.enableRemoteSshTelemetry !== false);
  const affectsBackendTelemetry =
    updated.weeklyLimitMode !== current.weeklyLimitMode ||
    updated.weeklyTokenBudget !== current.weeklyTokenBudget ||
    updated.weeklyCostBudget !== current.weeklyCostBudget ||
    updated.enableWindowOverlay !== (current.enableWindowOverlay !== false) ||
    updated.windowMountMode !== prevMountMode ||
    bridgeAuxChanged ||
    riskyGateChanged ||
    contextWindowScopeChanged;
  inFlightRequests.clear();
  if (affectsBackendTelemetry) {
    clearTelemetryBuilderMemo();
  }
  if (
    updated.enableWindowOverlay !== (current.enableWindowOverlay !== false) ||
    updated.windowMountMode !== prevMountMode ||
    bridgeAuxChanged
  ) {
    void notifyWindowOverlaySetting(updated.enableWindowOverlay);
  } else if (contextWindowScopeChanged) {
    void notifyModelContextWindowsChanged();
  }
  if ((updated.enableCliStatusLine !== false) !== (current.enableCliStatusLine !== false)) {
    ensureCliStatusLineConfigured({ enabled: updated.enableCliStatusLine !== false });
  }
  if (
    typeof standalonePortListener === 'function' &&
    Number(updated.standalonePort || 0) !== Number(current.standalonePort || 0)
  ) {
    try {
      standalonePortListener(Number(updated.standalonePort || 0));
    } catch {
      // 忽略独立端口热重载回调异常
    }
  }
  return {
    ok: true,
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    updated,
    body: JSON.stringify(updated),
  };
}

export async function executeModelContextWindowAction(data, opts = {}) {
  const epCtx = resolveActionEndpoint(data, opts);
  if (!epCtx.ok) {
    return buildEndpointErrorResponse(epCtx);
  }
  const { modelId, option } = data || {};
  const respond = (status, payload) => ({
    status,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(payload),
  });
  if (opts?.bypassRiskCheck !== true && !isContextWindowFeatureActive(loadSettings())) {
    return respond(403, { error: 'riskNotAccepted' });
  }
  if (!isContextWindowSettingId(modelId) || (option !== null && !isContextWindowOption(option))) {
    return respond(400, { error: 'Invalid model context window' });
  }

  async function loadGroupsForEndpoint(targetEndpoint) {
    const [{ userStatus }, catalog] = await Promise.all([
      callLsRpc('GetUserStatus', {}, 5000, targetEndpoint),
      getContextModelCatalog(targetEndpoint),
    ]);
    const configs = userStatus?.cascadeModelConfigData?.clientModelConfigs;
    if (!Array.isArray(configs) || configs.length === 0) return null;
    const models = getContextWindowModels(configs, catalog);
    return getContextWindowGroups(models);
  }

  let group;
  let verifiedHostConfigs = false;
  trackEndpointRequestStart(epCtx.endpoint);
  try {
    let groups = null;
    try {
      groups = await loadGroupsForEndpoint(epCtx.endpoint);
    } catch {
      groups = null;
    }
    if (epCtx.isRemote && !groups) {
      // 仅在远端 RPC 异常或未返回模型配置时安全回退本机校验；远端已成功返回时绝不放宽其档位限制
      try {
        groups = await loadGroupsForEndpoint(null);
      } catch {
        groups = null;
      }
    }
    if (Array.isArray(groups)) {
      verifiedHostConfigs = true;
      group = groups.find(({ id }) => id === modelId);
    }
  } finally {
    trackEndpointRequestEnd(epCtx.endpoint);
  }
  if (!verifiedHostConfigs) {
    if (option !== null || modelId.startsWith('model:')) {
      return respond(503, { error: 'Unable to verify the host model configuration' });
    }
  }
  if (option !== null && (!group || resolveContextWindowOption(group, option) === null)) {
    return respond(400, { error: 'This context window is not available for the selected model' });
  }
  const current = loadSettings();
  for (const id of group?.members || []) delete current.modelContextWindows[id];
  if (option === null) {
    delete current.modelContextWindows[modelId];
  } else {
    current.modelContextWindows[modelId] = option;
  }
  if (!saveJson(SETTINGS_FILE, current)) {
    return respond(500, { error: 'Failed to persist model context window' });
  }
  inFlightRequests.clear();
  clearTelemetryBuilderMemo();
  void notifyModelContextWindowsChanged();
  return respond(200, { modelContextWindows: current.modelContextWindows });
}

export function executeResetSettingsAction() {
  const current = loadSettings();
  const updated = createDefaultSettingsObject();
  if (!saveJson(SETTINGS_FILE, updated)) {
    return {
      ok: false,
      status: 500,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, error: 'Failed to reset settings' }),
    };
  }
  inFlightRequests.clear();
  clearTelemetryBuilderMemo();
  const prevMountMode = normalizeWindowMountMode(
    current.windowMountMode,
    current.enableWindowOverlay
  );
  const bridgeAuxChanged =
    (updated.autoConfigureLaunch !== false) !== (current.autoConfigureLaunch !== false) ||
    (updated.enableRemoteSshTelemetry !== false) !== (current.enableRemoteSshTelemetry !== false);
  if (
    updated.enableWindowOverlay !== (current.enableWindowOverlay !== false) ||
    updated.windowMountMode !== prevMountMode ||
    bridgeAuxChanged
  ) {
    void notifyWindowOverlaySetting(updated.enableWindowOverlay);
  } else if (
    isContextWindowFeatureActive(current) ||
    Object.keys(current.modelContextWindows).length ||
    current.contextWindowMainEnabled === false ||
    current.contextWindowSwarmEnabled === true
  ) {
    void notifyModelContextWindowsChanged();
  }
  if ((updated.enableCliStatusLine !== false) !== (current.enableCliStatusLine !== false)) {
    ensureCliStatusLineConfigured({ enabled: updated.enableCliStatusLine !== false });
  }
  if (
    typeof standalonePortListener === 'function' &&
    Number(updated.standalonePort || 0) !== Number(current.standalonePort || 0)
  ) {
    try {
      standalonePortListener(Number(updated.standalonePort || 0));
    } catch {
      // 忽略独立端口热重载回调异常
    }
  }
  return {
    ok: true,
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    updated,
    body: JSON.stringify(updated),
  };
}

export function executeRebuildCacheAction(data = undefined, opts = {}) {
  const epCtx = resolveActionEndpoint(data, opts);
  if (!epCtx.ok) {
    return buildEndpointErrorResponse(epCtx);
  }
  const liveCascadeIds = collectAuthoritativeLiveCascadeIds(
    epCtx.isRemote ? epCtx.endpoint : null
  );
  const ok = epCtx.isRemote
    ? clearRemoteEndpointCaches(epCtx.id, { liveCascadeIds })
    : clearRuntimeCaches({ liveCascadeIds, preserveFreshSummaryMemo: true });
  if (!ok) {
    return {
      ok: false,
      status: 500,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, error: 'Failed to clear trajectory cache' }),
    };
  }
  inFlightRequests.clear();
  const cachePrefix = `${epCtx.id}::`;
  for (const key of Array.from(displayStepsCache.keys())) {
    if (key.startsWith(cachePrefix)) {
      displayStepsCache.delete(key);
    }
  }
  const liveCount = liveCascadeIds instanceof Set ? liveCascadeIds.size : 0;
  clearScannerRuntimeMemos(epCtx.isRemote ? epCtx.id : null, {
    totalHint: liveCount,
    armed: !epCtx.isRemote && liveCount > 0,
  });
  clearTelemetryBuilderMemo(epCtx.id);
  return {
    ok: true,
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      ok: true,
      endpointId: epCtx.id,
      clearedAt: Date.now(),
      totalLive: liveCount,
    }),
  };
}

export async function executeCloudSyncAction() {
  const cloudStatus = await syncCloudCatalog({ force: true });
  clearTelemetryBuilderMemo();
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify({ ok: !cloudStatus.lastSyncError, cloudStatus }),
  };
}

export async function executeFxSyncAction(opts = {}) {
  const syncFn = typeof opts?.syncFxRatesFn === 'function' ? opts.syncFxRatesFn : syncFxRates;
  const fxStatus = await syncFn({ force: true });
  clearTelemetryBuilderMemo();
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify({ ok: !fxStatus.lastError, fxStatus }),
  };
}

export async function executePluginUpdateAction() {
  const result = await performPluginUpdate({ isAuto: false });
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify({ ...result, cloudStatus: getCloudStatus() }),
  };
}

const NONCE_PROTECTED_ACCOUNT_ACTIONS = new Set([
  'save',
  'capture',
  'switch',
  'remove',
  'loginStart',
  'setPassword',
  'unlockVault',
  'lockVault',
  'changePassword',
  'disablePassword',
  'resetVault',
]);

export async function executeAccountCredentialAction(data, opts = {}) {
  const epCtx = resolveActionEndpoint(data, opts);
  if (!epCtx.ok) {
    return buildEndpointErrorResponse(epCtx);
  }
  if (epCtx.isRemote) {
    return {
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ supported: false, accounts: [], error: 'unsupported' }),
    };
  }
  const cleanData = stripEndpointField(data);
  const action = cleanData?.action || 'list';
  const riskAccepted =
    opts?.bypassRiskCheck === true || isAccountSwitchFeatureActive(loadSettings());
  if (!riskAccepted) {
    if (action !== 'list') {
      return {
        status: 200,
        contentType: 'application/json',
        headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify({
          error: 'riskNotAccepted',
          actionNonce: issueAccountActionNonce(),
        }),
      };
    }
    const hostEmail = getLatestRecordedHostEmail();
    return {
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        supported: isAccountPlatformSupported(process.platform),
        riskLocked: true,
        accounts: [],
        selectedEmail: '',
        quotas: {},
        quotaHistory: getAccountQuotaHistoryPayload({
          allowedEmails: hostEmail ? [hostEmail] : [],
        }),
        actionNonce: issueAccountActionNonce(),
      }),
    };
  }
  if (NONCE_PROTECTED_ACCOUNT_ACTIONS.has(action) && !verifyAccountActionNonce(cleanData?.actionNonce)) {
    return {
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        error: 'invalidActionNonce',
        actionNonce: issueAccountActionNonce(),
      }),
    };
  }
  const result = await handleAccountCredentialAction({
    ...(isPlainObject(cleanData) ? cleanData : {}),
    action,
    includeSecurity: true,
  });
  if (action === 'switch' && !result?.error) {
    clearTelemetryBuilderMemo(LOCAL_ENDPOINT_ID);
  }
  const hostEmail = getLatestRecordedHostEmail();
  const allowedHistoryEmails = Array.isArray(result?.accounts)
    ? [...new Set([...result.accounts, ...(hostEmail ? [hostEmail] : [])])]
    : hostEmail
      ? [hostEmail]
      : null;
  const enriched =
    result && typeof result === 'object'
      ? {
          ...result,
          ...(action === 'list' || Array.isArray(result.accounts)
            ? {
                quotaHistory: getAccountQuotaHistoryPayload({
                  allowedEmails: allowedHistoryEmails,
                }),
              }
            : {}),
          actionNonce: issueAccountActionNonce(),
        }
      : result;
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(enriched),
  };
}

export async function executeBridgeRelaunchAction(data = {}) {
  const payload = isPlainObject(data) ? data : {};
  const action = String(payload.action || 'relaunch').trim().toLowerCase();
  const rawProduct = String(payload.product || 'auto').trim().toLowerCase();
  const bridgeSnap = getDefaultWindowBridgeStatus();
  const preferredProduct =
    rawProduct === 'ide' || rawProduct === 'desktop'
      ? rawProduct
      : String(bridgeSnap?.targetProduct || 'auto').trim().toLowerCase() || 'auto';

  if (action === 'create_macos_wrapper') {
    const targetProd = preferredProduct === 'ide' ? 'ide' : 'desktop';
    const created = await createMacOsLaunchWrapper({ product: targetProd });
    const wrapperStatus = inspectMacOsLaunchWrapperStatus();
    clearTelemetryBuilderMemo();
    return {
      status: created.ok ? 200 : Number(created.status || 500),
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        ...created,
        macWrapperExists: Boolean(wrapperStatus.exists),
        macDesktopWrapperExists: Boolean(wrapperStatus.desktopExists),
        macIdeWrapperExists: Boolean(wrapperStatus.ideExists),
        macWrapperPaths: wrapperStatus.paths || [],
      }),
    };
  }

  if (action === 'remove_macos_wrapper') {
    const removeProd =
      rawProduct === 'ide' || rawProduct === 'desktop' ? rawProduct : 'both';
    const removed = removeMacOsLaunchWrapper({ product: removeProd });
    const wrapperStatus = inspectMacOsLaunchWrapperStatus();
    clearTelemetryBuilderMemo();
    return {
      status: removed.ok ? 200 : Number(removed.status || 500),
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        ...removed,
        macWrapperExists: Boolean(wrapperStatus.exists),
        macDesktopWrapperExists: Boolean(wrapperStatus.desktopExists),
        macIdeWrapperExists: Boolean(wrapperStatus.ideExists),
        macWrapperPaths: wrapperStatus.paths || [],
      }),
    };
  }

  if (preferredProduct !== 'desktop') {
    ensureIdeRemoteDebuggingArgv({ enabled: true });
  }
  const launchProduct =
    preferredProduct === 'ide' ? 'ide' : preferredProduct === 'desktop' ? 'desktop' : 'both';
  const launchConfig = await ensureDesktopLaunchEntriesConfigured({
    enabled: true,
    product: launchProduct,
  }).catch(() => null);
  const result = await triggerDesktopHostRelaunch({
    preferredProduct,
    stalePortFiles: resolveDevToolsPortCandidates(),
    readOnlyShortcutPaths: launchConfig?.readOnlyPaths || [],
  });
  return {
    status: result.ok ? 200 : Number(result.status || 500),
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(result),
  };
}

export function executeCliStatusLineAction(rawAction) {
  const action = String(rawAction || '').trim();
  if (action !== 'force_install' && action !== 'clear_flags') {
    return {
      status: 400,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, error: 'Unsupported CLI statusLine action' }),
    };
  }

  let current = loadSettings();
  if (action === 'force_install' && current.enableCliStatusLine === false) {
    const nextSettings = normalizeFullSettings({
      ...current,
      enableCliStatusLine: true,
    });
    if (saveJson(SETTINGS_FILE, nextSettings)) {
      current = nextSettings;
    }
  }

  const result = ensureCliStatusLineConfigured({
    enabled: true,
    forceReplaceCustom: action === 'force_install',
    preserveManagedFlags: false,
  });
  const cliStatusLine = getCliStatusLineRuntimeStatus();
  const ok = Boolean(result?.updated || result?.alreadyConfigured || cliStatusLine.configured);
  return {
    status: ok ? 200 : 500,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      ok,
      action,
      result,
      cliStatusLine,
      settings: current,
    }),
  };
}

export function executeSessionMigrationCatalogAction(data = undefined, opts = {}) {
  const epCtx = resolveActionEndpoint(data, opts);
  if (!epCtx.ok) {
    return buildEndpointErrorResponse(epCtx);
  }
  if (epCtx.isRemote) {
    return {
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        available: false,
        sqliteSupported: false,
        clients: [],
        sessionsByClient: {},
        desktopProjects: [],
        error: 'unsupported_remote',
      }),
    };
  }
  const catalog = getSessionMigrationCatalog(opts?.sessionOptions || {});
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(catalog),
  };
}

export function executeSessionMigrationMigrateAction(data = undefined, opts = {}) {
  const epCtx = resolveActionEndpoint(data, opts);
  if (!epCtx.ok) {
    return buildEndpointErrorResponse(epCtx);
  }
  if (epCtx.isRemote) {
    return {
      status: 400,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, error: 'unsupported_remote', results: [] }),
    };
  }
  const cleanData = stripEndpointField(data);
  const result = migrateSessions(cleanData, opts?.sessionOptions || {});
  if (result.migratedCount > 0) {
    clearSessionManagerScanCaches();
    invalidateLocalSessionDisplayCaches();
  }
  return {
    status: Number(result.status || (result.ok ? 200 : 400)),
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(result),
  };
}

export function executeExportFileAction(data, opts = {}) {
  const result = writeLocalExportFile(data || {}, {
    ...(opts?.exportDir ? { overrideDir: opts.exportDir } : {}),
    ...(opts?.homeDir ? { homeDir: opts.homeDir } : {}),
    ...(opts?.fallbackDataDir ? { fallbackDataDir: opts.fallbackDataDir } : {}),
  });
  return {
    status: Number(result.status || (result.ok ? 200 : 400)),
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(result),
  };
}

export function executeQuotaReservationLogAction() {
  const snapshot = getQuotaReservationLogSnapshot();
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify({ ok: true, ...snapshot }),
  };
}

export async function executeHostI18nGetAction(opts = {}) {
  const result = await handleHostI18nGetRequest({
    bridgeStatus: getDefaultWindowBridgeStatus(),
    ...(opts?.hostI18nManager ? { manager: opts.hostI18nManager } : {}),
  });
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(result),
  };
}

export async function executeHostI18nPostAction(data = {}, opts = {}) {
  const out = await handleHostI18nPostAction(isPlainObject(data) ? data : {}, {
    bridgeStatus: getDefaultWindowBridgeStatus(),
    onChanged: typeof opts?.onHostI18nChanged === 'function' ? opts.onHostI18nChanged : notifyHostI18nChanged,
    collectFromTargets:
      typeof opts?.collectHostI18nUntranslated === 'function'
        ? opts.collectHostI18nUntranslated
        : collectHostI18nUntranslatedFromActiveTargets,
    ...(opts?.hostI18nManager ? { manager: opts.hostI18nManager } : {}),
  });
  return {
    status: Number(out?.status || 200),
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(out?.payload || { ok: false, error: 'Invalid host-i18n response' }),
  };
}

export function executeRevealFileAction(data, opts = {}) {
  const result = revealLocalExportFile(data?.filePath, {
    ...(opts?.platform ? { platform: opts.platform } : {}),
    ...(typeof opts?.spawnFn === 'function' ? { spawnFn: opts.spawnFn } : {}),
  });
  return {
    status: Number(result.status || (result.ok ? 200 : 400)),
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(result),
  };
}

let inFlightSessionsListPromise = null;

export async function executeSessionsListAction(data = undefined, opts = {}) {
  const epCtx = resolveActionEndpoint(data, opts);
  if (!epCtx.ok) {
    return buildEndpointErrorResponse(epCtx);
  }
  if (epCtx.isRemote) {
    return {
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        ok: false,
        error: 'unsupported_remote',
        clients: [],
        sessions: [],
        counts: { total: 0, indexOnly: 0, byClient: { desktop: 0, cli: 0, ide_legacy: 0 } },
        warnings: [],
      }),
    };
  }
  const sessionOpts = opts?.sessionOptions || {};
  const isDefaultLocal = !opts?.sessionOptions;
  let result;
  if (isDefaultLocal) {
    if (!inFlightSessionsListPromise) {
      inFlightSessionsListPromise = scanLocalSessionsAsync(sessionOpts).finally(() => {
        inFlightSessionsListPromise = null;
      });
    }
    result = await inFlightSessionsListPromise;
  } else {
    result = await scanLocalSessionsAsync(sessionOpts);
  }
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(result),
  };
}

export async function executeSessionsCleanupPreviewAction(data = undefined, opts = {}) {
  const epCtx = resolveActionEndpoint(data, opts);
  if (!epCtx.ok) {
    return buildEndpointErrorResponse(epCtx);
  }
  if (epCtx.isRemote) {
    return {
      status: 400,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, error: 'unsupported_remote' }),
    };
  }
  const cleanData = stripEndpointField(data);
  const result = await previewSessionCleanupAsync(cleanData || {}, opts?.sessionOptions || {});
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(result),
  };
}

function invalidateLocalSessionDisplayCaches() {
  const localPrefix = `${LOCAL_ENDPOINT_ID}::`;
  for (const key of Array.from(displayStepsCache.keys())) {
    if (key.startsWith(localPrefix)) {
      displayStepsCache.delete(key);
    }
  }
  clearScannerRuntimeMemos(LOCAL_ENDPOINT_ID);
  clearTelemetryBuilderMemo(LOCAL_ENDPOINT_ID);
  clearUsageAggregatorMemo(LOCAL_ENDPOINT_ID);
}

export async function executeSessionsDeleteAction(data = undefined, opts = {}) {
  const epCtx = resolveActionEndpoint(data, opts);
  if (!epCtx.ok) {
    return buildEndpointErrorResponse(epCtx);
  }
  if (epCtx.isRemote) {
    return {
      status: 400,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, error: 'unsupported_remote', deletedCount: 0, failedCount: 0 }),
    };
  }
  const cleanData = stripEndpointField(data);
  const result = await deleteLocalSessionsAsync(cleanData || {}, opts?.sessionOptions || {});
  if (result.deletedCount > 0 || (result.ledgerRedaction?.redactedConversations || 0) > 0) {
    invalidateLocalSessionDisplayCaches();
  }
  return {
    status: Number(result.status || (result.ok ? 200 : 400)),
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(result),
  };
}

export function executeSessionsRedactLedgerAction(data = undefined, opts = {}) {
  const epCtx = resolveActionEndpoint(data, opts);
  if (!epCtx.ok) {
    return buildEndpointErrorResponse(epCtx);
  }
  if (epCtx.isRemote) {
    return {
      status: 400,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, error: 'unsupported_remote' }),
    };
  }
  const sessionOpts = opts?.sessionOptions || {};
  const extraLiveIds =
    !sessionOpts.geminiDir && !sessionOpts.extraLiveIds
      ? collectAuthoritativeLiveCascadeIds(null)
      : sessionOpts.extraLiveIds;
  const result = sweepLedgerPrivacy({
    ...sessionOpts,
    ...(extraLiveIds ? { extraLiveIds } : {}),
  });
  if ((result.redactedConversations || 0) > 0 || (result.redactedSteps || 0) > 0) {
    invalidateLocalSessionDisplayCaches();
  }
  return {
    status: Number(result.status || (result.ok ? 200 : 500)),
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(result),
  };
}

export function executeSessionsRevealAction(data = undefined, opts = {}) {
  const epCtx = resolveActionEndpoint(data, opts);
  if (!epCtx.ok) {
    return buildEndpointErrorResponse(epCtx);
  }
  if (epCtx.isRemote) {
    return {
      status: 400,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, error: 'unsupported_remote' }),
    };
  }
  const cleanData = stripEndpointField(data);
  const explicitGeminiDir = opts?.sessionOptions?.geminiDir;
  const allowedRoots = SESSION_CLIENT_DEFS.map((def) => resolveClientRoot(def, explicitGeminiDir)).filter(Boolean);
  const targetRawPath = cleanData?.path || cleanData?.filePath || '';
  const revealBaseOpts = {
    allowedRoots,
    ...(opts?.platform ? { platform: opts.platform } : {}),
    ...(typeof opts?.spawnFn === 'function' ? { spawnFn: opts.spawnFn } : {}),
  };
  let result = revealLocalSessionPath(targetRawPath, {
    ...revealBaseOpts,
    allowedPaths: getAuthorizedRevealSnapshot(),
  });
  if (!result.ok && result.status === 403 && cleanData?.clientId && cleanData?.sessionId) {
    const refreshedPaths = authorizeSessionPathsForReveal(
      { clientId: cleanData.clientId, sessionId: cleanData.sessionId },
      opts?.sessionOptions || {}
    );
    result = revealLocalSessionPath(targetRawPath, {
      ...revealBaseOpts,
      allowedPaths: refreshedPaths,
    });
  }
  return {
    status: Number(result.status || (result.ok ? 200 : 400)),
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(result),
  };
}

const BRIDGE_ROUTE_LOOKUP = new Map(
  BRIDGE_API_ROUTE_DEFS.map((r) => [`${r.method}:${r.path}`, r.action])
);

export async function dispatchBridgeApiRequest(pathname, method, data, opts = undefined) {
  const action = BRIDGE_ROUTE_LOOKUP.get(`${String(method || '').toUpperCase()}:${pathname}`);
  switch (action) {
    case 'telemetry':
      return executeTelemetryAction(data, opts);
    case 'settings':
      if (isPlainObject(data) && data.__bridgeAction === 'relaunch') {
        return executeBridgeRelaunchAction(data);
      }
      if (isPlainObject(data) && typeof data.__cliStatusLineAction === 'string') {
        return executeCliStatusLineAction(data.__cliStatusLineAction);
      }
      if (isPlainObject(data) && data.__sessionMigrationAction === 'catalog') {
        return executeSessionMigrationCatalogAction(data, opts);
      }
      if (isPlainObject(data) && data.__sessionMigrationAction === 'migrate') {
        return executeSessionMigrationMigrateAction(data.payload || data, opts);
      }
      if (isPlainObject(data) && typeof data.__sessionManagerAction === 'string') {
        const smPayload = isPlainObject(data.payload) ? data.payload : data;
        if (data.__sessionManagerAction === 'list') {
          return executeSessionsListAction(smPayload, opts);
        }
        if (data.__sessionManagerAction === 'cleanup_preview') {
          return executeSessionsCleanupPreviewAction(smPayload, opts);
        }
        if (data.__sessionManagerAction === 'delete') {
          return executeSessionsDeleteAction(smPayload, opts);
        }
        if (data.__sessionManagerAction === 'redact_ledger') {
          return executeSessionsRedactLedgerAction(smPayload, opts);
        }
        if (data.__sessionManagerAction === 'reveal') {
          return executeSessionsRevealAction(smPayload, opts);
        }
      }
      if (isPlainObject(data) && data.__exportFileAction === 'save') {
        return executeExportFileAction(data.payload || data, opts);
      }
      if (isPlainObject(data) && data.__exportFileAction === 'reveal') {
        return executeRevealFileAction(data.payload || data, opts);
      }
      if (isPlainObject(data) && data.__quotaReservationAction === 'log') {
        return executeQuotaReservationLogAction();
      }
      if (isPlainObject(data) && typeof data.__hostI18nAction === 'string') {
        if (data.__hostI18nAction === 'get') {
          return executeHostI18nGetAction(opts);
        }
        return executeHostI18nPostAction(
          { ...(isPlainObject(data.payload) ? data.payload : {}), action: data.__hostI18nAction },
          opts
        );
      }
      if (isPlainObject(data) && data.__fxAction === 'sync') {
        return executeFxSyncAction(opts);
      }
      if (isPlainObject(data) && data.__hostThemeAction === 'cache') {
        const saved = recordPreloadHostTheme(data.payload);
        return {
          status: 200,
          contentType: 'application/json',
          headers: { 'Cache-Control': 'no-store' },
          body: JSON.stringify({
            ok: Boolean(saved),
            hostTheme: saved || getEffectiveHostTheme(),
          }),
        };
      }
      return executeSettingsAction(data);
    case 'accounts_get':
      return executeAccountCredentialAction(undefined, opts);
    case 'accounts_update':
      return executeAccountCredentialAction(data, opts);
    case 'context_window':
      return executeModelContextWindowAction(data, opts);
    case 'settings_reset':
      return executeResetSettingsAction();
    case 'cache_rebuild':
      return executeRebuildCacheAction(data, opts);
    case 'cloud_sync':
      return executeCloudSyncAction();
    case 'fx_sync':
      return executeFxSyncAction(opts);
    case 'plugin_update':
      return executePluginUpdateAction();
    case 'bridge_relaunch':
      return executeBridgeRelaunchAction(data);
    case 'session_migration_catalog':
      return executeSessionMigrationCatalogAction(data, opts);
    case 'session_migration_migrate':
      return executeSessionMigrationMigrateAction(data, opts);
    case 'export_file':
      return executeExportFileAction(data, opts);
    case 'reveal_file':
      return executeRevealFileAction(data, opts);
    case 'quota_reservation_log':
      return executeQuotaReservationLogAction();
    case 'host_i18n_get':
      return executeHostI18nGetAction(opts);
    case 'host_i18n_action':
      return executeHostI18nPostAction(data, opts);
    case 'sessions_list':
      return executeSessionsListAction(data, opts);
    case 'sessions_cleanup_preview':
      return executeSessionsCleanupPreviewAction(data, opts);
    case 'sessions_delete':
      return executeSessionsDeleteAction(data, opts);
    case 'sessions_redact_ledger':
      return executeSessionsRedactLedgerAction(data, opts);
    case 'sessions_reveal':
      return executeSessionsRevealAction(data, opts);
    default:
      return {
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Not found' }),
      };
  }
}

/**
 * 启动进程级双栖窗口桥接器（兼容 Sidecar 环境与独立后台守护进程环境）。
 *
 * @param {{ allowDynamicLs?: boolean, onRestart?: () => void }} [options]
 */
export function bootWindowBridgeRuntime({ allowDynamicLs = false, onRestart = null } = {}) {
  if (lsRuntimeEndpoint.addr === 'test.invalid') return null;
  if (!allowDynamicLs && !lsRuntimeEndpoint.addr) return null;

  const bootSettings = loadSettings();
  ensureCliStatusLineConfigured({ enabled: bootSettings.enableCliStatusLine !== false });
  if (allowDynamicLs && isAccountSwitchFeatureActive(bootSettings)) {
    setTimeout(() => {
      void warmAccountPublicListCache();
    }, 80).unref?.();
  }

  const triggerRestart =
    typeof onRestart === 'function' ? onRestart : () => scheduleSidecarRestart(150);
  if (typeof onRestart === 'function') {
    setSidecarRestartHandler(onRestart);
  }

  if (lsRuntimeEndpoint.baseUrl) {
    syncCloudCatalog({ force: false }).catch(() => {});
  } else {
    ensureLsEndpointDiscovered({ force: false })
      .then((ok) => {
        if (ok) {
          syncCloudCatalog({ force: false }).catch(() => {});
        }
      })
      .catch(() => {});
  }
  syncFxRates({ force: false }).catch(() => {});

  return startDefaultWindowBridge({
    handleApiRequest: (pathname, method, data, ctx) =>
      dispatchBridgeApiRequest(pathname, method, data, {
        onRestart: triggerRestart,
        ...(ctx?.endpointId !== undefined ? { endpointId: ctx.endpointId } : {}),
      }),
    readAssetFn: readLocalAsync,
    bootBundleVersion,
    onVersionDrift: triggerRestart,
  });
}

