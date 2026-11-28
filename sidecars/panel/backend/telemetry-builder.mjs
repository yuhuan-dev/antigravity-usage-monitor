/**
 * @fileoverview 遥测载荷组装器与并发请求合并入口。
 *
 * 将遥测构建拆解为清晰的子阶段：
 * 1. 拉取用户状态、轨迹摘要与官方实时配额摘要（含账号切换缓存校验）；
 * 2. 调用 `buildOfficialQuotaPools` 构建动态模型映射与多模型配额池；
 * 3. 调用 `enumerateAndSyncConversations` 枚举会话并增量更新轨迹缓存；
 * 4. 调用 `enrichActiveConversationSteps` 与 `extractActiveContextTelemetry` 计算当前活跃会话指标与 10 通道上下文拆解；
 * 5. 调用 `aggregateMultiWindowUsage` 完成全量多窗口聚合，并组装精简的前端遥测 JSON。
 */

import { isDeepStrictEqual } from 'node:util';
import { LOCAL_ENDPOINT_ID } from '../shared/window-bridge-protocol.mjs';
import { scaleBucketsExact } from '../shared/telemetry-display-rules.mjs';
import {
  extractLiveActivity,
  parseIsoMs,
  parseSwarmWorkerRole,
  speedMetric,
  summarizeSpeed,
  summarizeTtft,
} from '../trajectory-metrics.mjs';
import {
  CLI_STATUS_SNAPSHOT_FILE,
  computeRuntimeCodeVersion,
  inFlightRequests,
  loadSettings,
  localSummaryMemo,
  lsRuntimeEndpoint,
  roundMetric,
  saveJson,
} from './config.mjs';
import { getEndpointCacheStore } from './endpoint-registry.mjs';
import { getContextWindowGroups, getContextWindowModels } from './context-windows.mjs';
import { getCliStatusLineRuntimeStatus } from './cli-statusline-config.mjs';
import { readLocalSummarySnapshot } from './cli-sqlite-reader.mjs';
import {
  enumerateAndSyncConversations,
  getLocalCacheRebuildStatus,
  getLocalRebuildGeneration,
  setLocalBackgroundRebuildHook,
} from './local-scanner.mjs';
import { ensureLsEndpointDiscovered } from './ls-discovery.mjs';
import { callLsRpc, getContextModelCatalog, getOfficialQuotaSummary } from './ls-rpc.mjs';
import {
  computeStepCost,
  createStepModelResolver,
  formatUpstreamModelId,
  isArgonModelIdentifier,
  isCarbonModelIdentifier,
} from './model-pricing.mjs';
import { getCloudStatus, getPricingPhaseEpoch, pricingCatalogRevision } from './pricing-catalog.mjs';
import { getFxStatus } from './fx-rates.mjs';
import { buildOfficialQuotaPools } from './quota-pools.mjs';
import { recordAccountQuotaSnapshot } from './account-quota-history.mjs';
import { refreshSafetyMonitorTelemetry } from './safety-monitor-scanner.mjs';
import { updatePoolQuotaReservationEstimates } from './quota-reservation.mjs';
import { getDefaultCloudCodeProxyStatus } from './cloudcode-proxy.mjs';
import { getEffectiveHostTheme } from './host-theme-store.mjs';
import { getDefaultWindowBridgeStatus } from './window-bridge.mjs';
import {
  aggregateConsumptionPresetBundle,
  aggregateMultiWindowUsage,
  aggregateSelectedWindowUsage,
  aggregateSessionUsageForFamily,
  buildScopedModelBreakdown,
  clearUsageAggregatorMemo,
  getNextMondayResetIso,
  normalizeWorkspaceBucket,
} from './usage-aggregator.mjs';

const MAX_RECENT_QUICK_STATS = 30;
const MAX_CONVERSATION_ASSEMBLY_CACHE = 6;
const MAX_CONVERSATION_ASSEMBLY_TOTAL_STEPS = 8000;
const MAX_TELEMETRY_SNAPSHOT_ENDPOINTS = 8;
const POOL_PRIORITY_ORDER = ['Gemini', 'Argon', 'Carbon', 'Claude & GPT'];
const inFlightTelemetrySources = new Map();
const trajectoryModelFacts = new WeakMap();
let agentStepPrepCache = new WeakMap();
const conversationAssemblyCache = new Map();
const lastCompletedTelemetrySnapshotsByEndpoint = new Map();

export function clearTelemetryBuilderMemo(endpointId = null) {
  agentStepPrepCache = new WeakMap();
  if (endpointId) {
    const epKey = String(endpointId);
    lastCompletedTelemetrySnapshotsByEndpoint.delete(epKey);
    const srcPrefix = `[${JSON.stringify(epKey)},`;
    for (const key of Array.from(inFlightTelemetrySources.keys())) {
      if (key.startsWith(srcPrefix)) {
        inFlightTelemetrySources.delete(key);
      }
    }
    const prefix = `${epKey}::`;
    for (const key of Array.from(conversationAssemblyCache.keys())) {
      if (key.startsWith(prefix)) {
        conversationAssemblyCache.delete(key);
      }
    }
    clearUsageAggregatorMemo(epKey);
    return;
  }
  inFlightTelemetrySources.clear();
  conversationAssemblyCache.clear();
  lastCompletedTelemetrySnapshotsByEndpoint.clear();
  clearUsageAggregatorMemo();
}

setLocalBackgroundRebuildHook(({ finished } = {}) => {
  clearUsageAggregatorMemo(LOCAL_ENDPOINT_ID);
  if (finished) {
    clearTelemetryBuilderMemo(LOCAL_ENDPOINT_ID);
  }
});

function roundSessionCost(val) {
  if (!Number.isFinite(val) || val <= 0) return 0;
  return val < 0.01 ? +val.toFixed(4) : +val.toFixed(2);
}

function findTrajectoryCacheEntry(cascadeId, cacheStore = null, { hydrate = false } = {}) {
  if (!cascadeId) return null;
  const store = cacheStore || getEndpointCacheStore(null);
  if (hydrate && typeof store.getHydratedTrajectoryEntryByLower === 'function') {
    return store.getHydratedTrajectoryEntryByLower(cascadeId)?.entry || null;
  }
  if (hydrate && typeof store.getHydratedTrajectory === 'function') {
    const hit = store.getHydratedTrajectory(cascadeId);
    if (hit) return hit;
  }
  if (typeof store.getCachedTrajectoryEntryByLower === 'function') {
    return store.getCachedTrajectoryEntryByLower(cascadeId)?.entry || null;
  }
  const entry = store.getCachedTrajectory(cascadeId);
  if (entry) return entry;
  const targetLower = String(cascadeId).toLowerCase();
  for (const [k, v] of store.listCachedTrajectoryEntries()) {
    if (k.toLowerCase() === targetLower) return v;
  }
  return null;
}

function rememberModelContextLimit(limits, step) {
  const previous = limits.get(step.modelKey);
  if (!previous || step.createdAtMs > previous.at) {
    limits.set(step.modelKey, { tokens: step.reportedContextLimitTokens, at: step.createdAtMs });
  }
}

function readTrajectoryModelFacts(steps) {
  const cached = trajectoryModelFacts.get(steps);
  if (cached) return cached;
  const upstream = new Map();
  const limits = new Map();
  const fallbackModelKeys = new Set();
  let sortableLimits = true;
  for (const step of steps) {
    if (step?.modelKey && step.modelKey !== 'unknown') {
      if (step.responseModel) {
        upstream.set(step.modelKey, step.responseModel);
      } else {
        fallbackModelKeys.add(step.modelKey);
      }
    }
    if (!step?.isCompactionStep && !step?.isImageGenStep && step?.reportedContextLimitTokens > 0) {
      sortableLimits &&= Number.isFinite(step.createdAtMs);
      rememberModelContextLimit(limits, step);
    }
  }
  const result = { upstream, limits: sortableLimits ? limits : null, fallbackModelKeys };
  trajectoryModelFacts.set(steps, result);
  return result;
}

/** 合并各会话的上游模型与上下文上限，步骤数组更新后重新提取对应会话的数据。 */
function buildKnownUpstreamModelMap(contextLimits, cacheStore = null) {
  const store = cacheStore || getEndpointCacheStore(null);
  const knownUpstreamByModelKey = new Map();
  for (const [, entry] of store.listCachedTrajectoryEntries()) {
    if (!entry?.steps?.length) continue;
    const facts = readTrajectoryModelFacts(entry.steps);
    for (const [key, model] of facts.upstream) knownUpstreamByModelKey.set(key, model);
    if (entry.subagentSpec) continue;
    if (Array.isArray(entry._stepFlags?.modelLimits) && entry._stepFlags.modelLimits.length > 0) {
      for (const [key, tokens, at] of entry._stepFlags.modelLimits) {
        if (!key || !(tokens > 0)) continue;
        const previous = contextLimits.get(key);
        if (!previous || at > previous.at) {
          contextLimits.set(key, { tokens, at });
        }
      }
      continue;
    }
    if (facts.limits) {
      for (const [key, limit] of facts.limits) {
        const previous = contextLimits.get(key);
        if (!previous || limit.at > previous.at) contextLimits.set(key, limit);
      }
    } else {
      for (const step of entry.steps) {
        if (!step?.isCompactionStep && step?.reportedContextLimitTokens > 0) {
          rememberModelContextLimit(contextLimits, step);
        }
      }
    }
  }
  return knownUpstreamByModelKey;
}

/**
 * 为当前活跃会话的步骤补充模型标签、上游响应模型、单步费用、缓存命中率与生成速率指标，
 * 并剔除前端未使用的冗余诊断字段以减小 JSON 体积。
 *
 * @param {object[]} activeSteps 当前会话的原始缓存步骤
 * @param {ReturnType<typeof createStepModelResolver>} resolveStepModel 模型身份与价格解析器
 * @param {Map<string, string>} sharedUpstreamMap 预先构建的已知上游模型映射表
 * @param {object} agentFields 步骤所属代理的标签和标识
 */
function enrichActiveConversationSteps(
  activeSteps,
  resolveStepModel,
  sharedUpstreamMap,
  agentFields
) {
  const sessionSpeed = summarizeSpeed(activeSteps);
  const sessionTtft = summarizeTtft(activeSteps);
  let sessionCostUsd = 0;
  let sessionUnpricedCalls = 0;
  let sessionInputTokens = 0;
  let sessionCacheReadTokens = 0;
  let sessionOutputTokens = 0;

  const knownUpstreamByModelKey = sharedUpstreamMap;
  const enrichedActiveSteps = activeSteps.map((st) => {
    const mInfo = resolveStepModel(st);
    const costUsd = computeStepCost(st, mInfo.pricing);
    const metric = speedMetric(st);

    sessionCostUsd += costUsd ?? 0;
    if (costUsd === null) sessionUnpricedCalls++;
    sessionInputTokens += st.inputTokens;
    sessionCacheReadTokens += st.cacheReadTokens;
    const outputTokens = resolveStepOutputTokens(st);
    sessionOutputTokens += outputTokens;

    const tokPerSec = metric.value;
    const totalPrompt = st.inputTokens + st.cacheReadTokens;
    const cacheHitPct = totalPrompt > 0 ? (st.cacheReadTokens / totalPrompt) * 100 : 0;

    const inCostUsd = mInfo.pricing ? (st.inputTokens / 1_000_000) * mInfo.pricing.input : null;
    const cacheCostUsd = mInfo.pricing
      ? (st.cacheReadTokens / 1_000_000) * mInfo.pricing.cache
      : null;
    const effectiveOutRate = mInfo.pricing
      ? st.isImageGenStep &&
        typeof mInfo.pricing.imageOutput === 'number' &&
        mInfo.pricing.imageOutput > 0
        ? mInfo.pricing.imageOutput
        : mInfo.pricing.output
      : null;
    const outCostUsd =
      effectiveOutRate !== null ? (st.outputTokens / 1_000_000) * effectiveOutRate : null;
    const resolvedResponseModel =
      st.responseModel ||
      (st.modelKey && st.modelKey !== 'unknown'
        ? knownUpstreamByModelKey.get(st.modelKey) || ''
        : '');
    const rawUpstreamModel =
      resolvedResponseModel ||
      (mInfo.modelId && mInfo.modelId !== 'unknown' ? mInfo.modelId : mInfo.shortName);
    const annotatedUpstreamModel = formatUpstreamModelId(rawUpstreamModel, mInfo);
    const modelUpstream = st.isCompactionStep
      ? `${annotatedUpstreamModel}·压缩`
      : annotatedUpstreamModel;

    const {
      viewableDelaySec: _viewableDelaySec,
      ttftSource: _ttftSource,
      speedBasis: _speedBasis,
      ...serializedStep
    } = st;

    return {
      ...serializedStep,
      responseModel: st.responseModel || '',
      hasKnownModel: Boolean(mInfo.modelId && mInfo.modelId !== 'unknown'),
      baseModelUpstream: annotatedUpstreamModel,
      baseModelLabel: mInfo.label,
      baseModelShort: mInfo.shortName,
      modelUpstream,
      modelLabel: st.isCompactionStep ? `${mInfo.label} [自动压缩]` : mInfo.label,
      modelShort: st.isCompactionStep ? `${mInfo.shortName}·压缩` : mInfo.shortName,
      family: mInfo.family,
      tokPerSec: roundMetric(tokPerSec),
      selectedSpeedReason: metric.reason,
      ttftSec: st.nativeTtftSec,
      cacheHitPct: +cacheHitPct.toFixed(1),
      costUsd: costUsd === null ? null : +costUsd.toFixed(4),
      inCostUsd: inCostUsd === null ? null : +inCostUsd.toFixed(4),
      cacheCostUsd: cacheCostUsd === null ? null : +cacheCostUsd.toFixed(4),
      outCostUsd: outCostUsd === null ? null : +outCostUsd.toFixed(4),
      contextTokens: totalPrompt + outputTokens,
      ...agentFields,
    };
  });

  // 关联每轮用户提问摘要与最新轮次标识，供步骤表极简导轨与气泡展示（已回退步骤保持自身历史摘要，不与新分支混并）
  let maxTurnIndex = 0;
  const promptByTurn = new Map();
  const mediaByTurn = new Map();
  for (const st of enrichedActiveSteps) {
    if (st.isReverted) continue;
    const tIdx = st.turnIndex;
    if (!Number.isInteger(tIdx) || tIdx <= 0) continue;
    if (tIdx > maxTurnIndex) maxTurnIndex = tIdx;
    if (st.turnPrompt && (st.isTurnStart || !promptByTurn.has(tIdx))) {
      promptByTurn.set(tIdx, st.turnPrompt);
    }
    if (st.isTurnStart || !mediaByTurn.has(tIdx)) {
      mediaByTurn.set(tIdx, {
        cleanPrompt: st.turnPromptClean ?? '',
        hasMedia: Boolean(st.turnHasMedia),
        mediaOnly: Boolean(st.turnMediaOnly),
      });
    }
  }
  for (const st of enrichedActiveSteps) {
    const tIdx = st.turnIndex;
    if (!Number.isInteger(tIdx) || tIdx <= 0) {
      st.turnIndex = null;
      st.isTurnStart = false;
      st.isLatestTurn = false;
      st.turnPrompt = '';
      st.turnPromptClean = '';
      st.turnHasMedia = false;
      st.turnMediaOnly = false;
      continue;
    }
    if (st.isReverted) {
      st.isTurnStart = Boolean(st.isTurnStart);
      st.isLatestTurn = false;
      st.turnPrompt = st.turnPrompt || '';
      st.turnPromptClean = st.turnPromptClean ?? '';
      st.turnHasMedia = Boolean(st.turnHasMedia);
      st.turnMediaOnly = Boolean(st.turnMediaOnly);
      continue;
    }
    const turnMedia = mediaByTurn.get(tIdx);
    st.isTurnStart = Boolean(st.isTurnStart);
    st.isLatestTurn = tIdx === maxTurnIndex;
    st.turnPrompt = promptByTurn.get(tIdx) || '';
    st.turnPromptClean = turnMedia?.cleanPrompt || '';
    st.turnHasMedia = Boolean(turnMedia?.hasMedia);
    st.turnMediaOnly = Boolean(turnMedia?.mediaOnly);
  }

  const latestEnriched =
    enrichedActiveSteps.length > 0 ? enrichedActiveSteps[enrichedActiveSteps.length - 1] : null;
  const lastKnownTtftSec = findLastValidStepTtft(enrichedActiveSteps);
  const sessionAvgTokPerSec = roundMetric(sessionSpeed.avgTokPerSec);

  return {
    enrichedActiveSteps,
    latestEnriched,
    lastKnownTtftSec,
    sessionSpeed,
    sessionTtft,
    sessionAvgTokPerSec,
    sessionCostUsd,
    sessionUnpricedCalls,
    sessionInputTokens,
    sessionCacheReadTokens,
    sessionOutputTokens,
  };
}

function findLastValidStepTtft(steps) {
  if (!Array.isArray(steps)) return null;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const candidateTtft = steps[i]?.ttftSec;
    if (
      candidateTtft != null &&
      Number.isFinite(Number(candidateTtft)) &&
      Number(candidateTtft) >= 0
    ) {
      return Number(candidateTtft);
    }
  }
  return null;
}

const CONTEXT_CHANNEL_KEYS = [
  'userInput',
  'assistant',
  'toolResults',
  'subagent',
  'checkpoint',
  'systemTools',
  'mcpTools',
  'skills',
  'systemPrompt',
  'userRules',
];

const STATIC_CONTEXT_CHANNEL_KEYS = [
  'systemTools',
  'mcpTools',
  'skills',
  'systemPrompt',
  'userRules',
];

function applyFallbackStaticChannels(channels, fallbackStaticContext, capTotal = 0) {
  if (!fallbackStaticContext || typeof fallbackStaticContext !== 'object') return 0;
  let staticMap = {
    systemTools: Math.max(0, Math.round(Number(fallbackStaticContext.systemToolsTokens || 0))),
    mcpTools: Math.max(0, Math.round(Number(fallbackStaticContext.mcpToolsTokens || 0))),
    skills: Math.max(0, Math.round(Number(fallbackStaticContext.skillsTokens || 0))),
    systemPrompt: Math.max(0, Math.round(Number(fallbackStaticContext.systemPromptTokens || 0))),
    userRules: Math.max(0, Math.round(Number(fallbackStaticContext.userRulesTokens || 0))),
  };
  let staticSum = STATIC_CONTEXT_CHANNEL_KEYS.reduce((sum, k) => sum + staticMap[k], 0);
  if (staticSum <= 0) return 0;
  if (capTotal > 0 && staticSum > capTotal) {
    staticMap = scaleBucketsExact(staticMap, STATIC_CONTEXT_CHANNEL_KEYS, Math.round(capTotal));
    staticSum = STATIC_CONTEXT_CHANNEL_KEYS.reduce((sum, k) => sum + staticMap[k], 0);
  }
  for (const k of STATIC_CONTEXT_CHANNEL_KEYS) {
    channels[k] = staticMap[k];
  }
  return staticSum;
}

function resolveStepOutputTokens(st) {
  const explicitOut = Number(st?.outputTokens || 0);
  if (explicitOut > 0) return explicitOut;
  return Number(st?.thinkingTokens || 0) + Number(st?.responseTokens || 0);
}

function extractRawBreakdownChannels(breakdown) {
  const rawMessages = Number(breakdown?.messagesTokens || 0);
  const hasGranularMsgBreakdown =
    Boolean(breakdown) &&
    Object.prototype.hasOwnProperty.call(breakdown, 'toolResultsTokens');
  const channels = {
    userInput: hasGranularMsgBreakdown
      ? Number(breakdown?.userInputTokens || 0)
      : rawMessages,
    assistant: Number(breakdown?.assistantTokens || 0),
    toolResults: Number(breakdown?.toolResultsTokens || 0),
    subagent: Number(breakdown?.subagentTokens || 0),
    checkpoint: Number(breakdown?.checkpointTokens || 0),
    systemTools: Number(breakdown?.systemToolsTokens || 0),
    mcpTools: Number(breakdown?.mcpToolsTokens || 0),
    skills: Number(breakdown?.skillsTokens || 0),
    systemPrompt: Number(breakdown?.systemPromptTokens || 0),
    userRules: Number(breakdown?.userRulesTokens || 0),
  };
  const msgSubtotal =
    channels.userInput +
    channels.assistant +
    channels.toolResults +
    channels.subagent +
    channels.checkpoint;
  if (rawMessages > msgSubtotal) {
    channels.userInput += rawMessages - msgSubtotal;
  }
  return channels;
}

function resolveCompactionSummaryTokens(compactionStep) {
  const respTok = Number(compactionStep?.responseTokens || 0);
  if (respTok > 0) return respTok;
  return resolveStepOutputTokens(compactionStep);
}

/**
 * 从当前活跃会话的最新步骤提取上下文 10 通道拆解、自动压缩水位与缓存命中率。
 *
 * `chatStartMetadata.contextWindowMetadata` 记录在步骤请求发送前且基于宿主离线估算器：
 * 1. 先按该步模型 API 真实计费输入（`inputTokens + cacheReadTokens`）对请求前 10 通道做等比整数对齐，消除离线估算偏差；
 * 2. 再将该步自身新生成的输出（`outputTokens`）补入 `assistantTokens`，并滚动推进后续无独立拆解的步骤，
 *    使上下文窗口总占用与调用明细表的单步 `contextTokens` 严格一致；
 * 3. 当末尾或最近边界为上下文压缩步骤（`isCompactionStep`）且压缩后尚未产生新的 `contextBreakdown` 时，
 *    继承压缩前最近一次拆解中的 5 个会话静态通道（`systemPrompt` / `systemTools` / `mcpTools` / `skills` / `userRules`），
 *    清空已被折叠的历史对话通道，并将压缩步生成的摘要正文计入 `checkpointTokens`，避免误把压缩前全量输入当作压缩后水位。
 *
 * @param {object[]} enrichedActiveSteps
 * @param {object|null} latestEnriched
 * @param {number} sessionInputTokens
 * @param {number} sessionCacheReadTokens
 */
function extractActiveContextTelemetry(
  enrichedActiveSteps,
  latestEnriched,
  sessionInputTokens,
  sessionCacheReadTokens,
  fallbackStaticContext = null
) {
  let lastCompactionIdx = -1;
  for (let i = enrichedActiveSteps.length - 1; i >= 0; i--) {
    if (enrichedActiveSteps[i]?.isCompactionStep) {
      lastCompactionIdx = i;
      break;
    }
  }

  let latestBreakdown = null;
  let breakdownIdx = -1;
  for (let i = enrichedActiveSteps.length - 1; i > lastCompactionIdx; i--) {
    if (enrichedActiveSteps[i]?.contextBreakdown) {
      latestBreakdown = enrichedActiveSteps[i].contextBreakdown;
      breakdownIdx = i;
      break;
    }
  }

  let channels = extractRawBreakdownChannels(latestBreakdown);
  let fallbackPreCompactionLimit = 0;

  if (latestBreakdown && breakdownIdx > lastCompactionIdx) {
    const rawBreakdownTotal = CONTEXT_CHANNEL_KEYS.reduce((sum, k) => sum + channels[k], 0);
    if (rawBreakdownTotal > 0) {
      const bdStep = enrichedActiveSteps[breakdownIdx];
      const bdPromptTokens =
        Number(bdStep?.inputTokens || 0) + Number(bdStep?.cacheReadTokens || 0);
      const bdOutTokens = resolveStepOutputTokens(bdStep);
      // 仅当模型 API 返回了完整的请求级输入（排除省略 cacheReadTokens 的残缺网关或极小合成桩数据）时对齐至真实分词口径
      if (bdPromptTokens >= rawBreakdownTotal * 0.5) {
        channels = scaleBucketsExact(channels, CONTEXT_CHANNEL_KEYS, bdPromptTokens);
        channels.assistant += bdOutTokens;
        let runningTotal = bdPromptTokens + bdOutTokens;

        for (let m = breakdownIdx + 1; m < enrichedActiveSteps.length; m++) {
          const stepM = enrichedActiveSteps[m];
          if (!stepM || stepM.isCompactionStep) break;
          if (stepM.isImageGenStep) continue;
          const mPrompt =
            Number(stepM.inputTokens || 0) + Number(stepM.cacheReadTokens || 0);
          const mOut = resolveStepOutputTokens(stepM);
          if (mPrompt >= runningTotal * 0.5) {
            if (mPrompt > runningTotal) {
              const delta = mPrompt - runningTotal;
              if (enrichedActiveSteps[m - 1]?.hasToolCalls) {
                channels.toolResults += delta;
              } else {
                channels.userInput += delta;
              }
            } else if (mPrompt < runningTotal) {
              channels = scaleBucketsExact(channels, CONTEXT_CHANNEL_KEYS, mPrompt);
            }
            channels.assistant += mOut;
            runningTotal = mPrompt + mOut;
          }
        }
      }
    }
  } else if (lastCompactionIdx >= 0) {
    const compactionStep = enrichedActiveSteps[lastCompactionIdx];
    let preStep = null;
    for (let i = lastCompactionIdx - 1; i >= 0; i--) {
      if (enrichedActiveSteps[i]?.contextBreakdown) {
        preStep = enrichedActiveSteps[i];
        break;
      }
    }
    if (preStep) {
      fallbackPreCompactionLimit = Number(preStep.maxContextBudgetTokens || 0);
      let preChannels = extractRawBreakdownChannels(preStep.contextBreakdown);
      const preRawTotal = CONTEXT_CHANNEL_KEYS.reduce((sum, k) => sum + preChannels[k], 0);
      const prePromptTokens =
        Number(preStep.inputTokens || 0) + Number(preStep.cacheReadTokens || 0);
      if (preRawTotal > 0 && prePromptTokens >= preRawTotal * 0.5) {
        preChannels = scaleBucketsExact(preChannels, CONTEXT_CHANNEL_KEYS, prePromptTokens);
      }
      channels.systemTools = preChannels.systemTools;
      channels.mcpTools = preChannels.mcpTools;
      channels.skills = preChannels.skills;
      channels.systemPrompt = preChannels.systemPrompt;
      channels.userRules = preChannels.userRules;
    } else if (fallbackStaticContext) {
      applyFallbackStaticChannels(channels, fallbackStaticContext, 0);
    }
    channels.userInput = 0;
    channels.assistant = 0;
    channels.toolResults = 0;
    channels.subagent = 0;
    channels.checkpoint = resolveCompactionSummaryTokens(compactionStep);

    let runningTotal = CONTEXT_CHANNEL_KEYS.reduce((sum, k) => sum + channels[k], 0);
    for (let m = lastCompactionIdx + 1; m < enrichedActiveSteps.length; m++) {
      const stepM = enrichedActiveSteps[m];
      if (!stepM || stepM.isCompactionStep || stepM.isImageGenStep) continue;
      const mPrompt =
        Number(stepM.inputTokens || 0) + Number(stepM.cacheReadTokens || 0);
      const mOut = resolveStepOutputTokens(stepM);
      if (mPrompt > 0 && (runningTotal === 0 || mPrompt >= runningTotal * 0.35)) {
        if (mPrompt > runningTotal) {
          const delta = mPrompt - runningTotal;
          if (m > lastCompactionIdx + 1 && enrichedActiveSteps[m - 1]?.hasToolCalls) {
            channels.toolResults += delta;
          } else {
            channels.userInput += delta;
          }
        } else if (mPrompt < runningTotal) {
          channels = scaleBucketsExact(channels, CONTEXT_CHANNEL_KEYS, mPrompt);
        }
        channels.assistant += mOut;
        runningTotal = mPrompt + mOut;
      }
    }
  } else if (enrichedActiveSteps.length > 0) {
    // 当宿主回退或历史裁剪导致全部步骤均无 `contextBreakdown` 且未发生过压缩时，
    // 基于缓存的 5 通道静态基线（如有）和各步真实计费增量重建上下文通道，避免进度条和 10 项图例全归零。
    let runningTotal = 0;
    let seededInitial = false;
    for (let m = 0; m < enrichedActiveSteps.length; m++) {
      const stepM = enrichedActiveSteps[m];
      if (!stepM || stepM.isCompactionStep || stepM.isImageGenStep) continue;
      const mPrompt =
        Number(stepM.inputTokens || 0) + Number(stepM.cacheReadTokens || 0);
      const mOut = resolveStepOutputTokens(stepM);
      if (!seededInitial) {
        if (mPrompt <= 0 && mOut <= 0) continue;
        seededInitial = true;
        if (mPrompt > 0) {
          const staticUsed = applyFallbackStaticChannels(
            channels,
            fallbackStaticContext,
            mPrompt
          );
          channels.userInput += Math.max(0, mPrompt - staticUsed);
        }
        channels.assistant += mOut;
        runningTotal = mPrompt + mOut;
      } else if (mPrompt > 0) {
        if (mPrompt > runningTotal) {
          const delta = mPrompt - runningTotal;
          if (enrichedActiveSteps[m - 1]?.hasToolCalls) {
            channels.toolResults += delta;
          } else {
            channels.userInput += delta;
          }
        } else if (mPrompt < runningTotal) {
          channels = scaleBucketsExact(channels, CONTEXT_CHANNEL_KEYS, mPrompt);
        }
        channels.assistant += mOut;
        runningTotal = mPrompt + mOut;
      }
    }
    if (runningTotal === 0) {
      const estFallback = Math.max(
        0,
        Math.round(Number(latestEnriched?.estimatedContextTokens || 0))
      );
      if (estFallback > 0) {
        const staticUsed = applyFallbackStaticChannels(
          channels,
          fallbackStaticContext,
          estFallback
        );
        channels.userInput += Math.max(0, estFallback - staticUsed);
      }
    }
  }

  const ctxUserInput = channels.userInput;
  const ctxAssistant = channels.assistant;
  const ctxToolResults = channels.toolResults;
  const ctxSubagent = channels.subagent;
  const ctxCheckpoint = channels.checkpoint;
  const ctxMessages =
    ctxUserInput + ctxAssistant + ctxToolResults + ctxSubagent + ctxCheckpoint;
  const ctxSystemTools = channels.systemTools;
  const ctxMcpTools = channels.mcpTools;
  const ctxSkills = channels.skills;
  const ctxSystemPrompt = channels.systemPrompt;
  const ctxUserRules = channels.userRules;
  const ctxBreakdownTotal =
    ctxMessages + ctxSystemTools + ctxMcpTools + ctxSkills + ctxSystemPrompt + ctxUserRules;

  let ctxRefStep = latestEnriched;
  if (ctxRefStep?.isImageGenStep) {
    for (let i = enrichedActiveSteps.length - 1; i >= 0; i--) {
      if (!enrichedActiveSteps[i]?.isImageGenStep) {
        ctxRefStep = enrichedActiveSteps[i];
        break;
      }
    }
  }
  const isLatestCompaction = Boolean(ctxRefStep?.isCompactionStep);
  const ctxCached = ctxRefStep?.cacheReadTokens || 0;
  const ctxFreshInput = ctxRefStep?.inputTokens || 0;
  const ctxThinking = ctxRefStep?.thinkingTokens || 0;
  const ctxResponse = ctxRefStep?.responseTokens || 0;
  const ctxOut = resolveStepOutputTokens(ctxRefStep);
  const ctxTotal = isLatestCompaction
    ? ctxBreakdownTotal
    : ctxBreakdownTotal > 0
      ? ctxBreakdownTotal
      : (ctxRefStep?.isImageGenStep ? 0 : ctxCached + ctxFreshInput + ctxOut) ||
        Number(ctxRefStep?.estimatedContextTokens || 0);
  const compactionLimitTokens = Number(
    (isLatestCompaction && !ctxRefStep?.reportedContextLimitTokens && fallbackPreCompactionLimit > 0
      ? fallbackPreCompactionLimit
      : ctxRefStep?.maxContextBudgetTokens) || 256000
  );
  const compactionUsedTokens = isLatestCompaction
    ? Number(ctxTotal)
    : Number(
        ctxTotal ||
          ctxRefStep?.estimatedContextTokens ||
          (ctxRefStep?.isImageGenStep ? 0 : ctxCached + ctxFreshInput)
      );
  const compactionUsedPct =
    compactionLimitTokens > 0
      ? Math.min(100, +((compactionUsedTokens / compactionLimitTokens) * 100).toFixed(1))
      : 0;

  const ctxLimit = compactionLimitTokens;
  const ctxPct = ctxLimit > 0 ? Math.min(100, +((ctxTotal / ctxLimit) * 100).toFixed(1)) : 0;

  const latestPromptTokens = ctxCached + ctxFreshInput;
  const latestCacheHitPct =
    latestPromptTokens > 0 ? +((ctxCached / latestPromptTokens) * 100).toFixed(1) : 0;
  const sessionPromptTokens = sessionCacheReadTokens + sessionInputTokens;
  const sessionCacheHitPct =
    sessionPromptTokens > 0 ? +((sessionCacheReadTokens / sessionPromptTokens) * 100).toFixed(1) : 0;

  return {
    latestCacheHitPct,
    sessionCacheHitPct,
    context: {
      totalTokens: ctxTotal,
      limitTokens: ctxLimit,
      usedPct: ctxPct,
      compactionUsedTokens,
      compactionLimitTokens,
      compactionUsedPct,
      messagesTokens: ctxMessages,
      userInputTokens: ctxUserInput,
      assistantTokens: ctxAssistant,
      toolResultsTokens: ctxToolResults,
      subagentTokens: ctxSubagent,
      checkpointTokens: ctxCheckpoint,
      systemToolsTokens: ctxSystemTools,
      mcpToolsTokens: ctxMcpTools,
      skillsTokens: ctxSkills,
      systemPromptTokens: ctxSystemPrompt,
      userRulesTokens: ctxUserRules,
      cachedTokens: ctxCached,
      freshInputTokens: ctxFreshInput,
      thinkingTokens: ctxThinking,
      responseTokens: ctxResponse,
    },
  };
}

function snapshotFallbackUpstreams(fallbackModelKeys, upstream) {
  const map = new Map();
  if (fallbackModelKeys && upstream) {
    for (const key of fallbackModelKeys) {
      map.set(key, upstream.get(key) || '');
    }
  }
  return map;
}

function sameFallbackUpstreams(prevMap, fallbackModelKeys, upstream) {
  if (!prevMap) return !fallbackModelKeys || fallbackModelKeys.size === 0;
  if ((fallbackModelKeys?.size || 0) !== prevMap.size) return false;
  for (const [key, val] of prevMap.entries()) {
    if ((upstream?.get(key) || '') !== val) return false;
  }
  return true;
}

function prepareAgentSteps(
  rawSteps,
  resolveStepModel,
  upstream,
  agentFields,
  reuseInputs,
  fallbackStaticContext = null
) {
  const facts = readTrajectoryModelFacts(rawSteps);
  for (const [key, model] of facts.upstream) upstream.set(key, model);
  const canCache = Boolean(reuseInputs && Array.isArray(rawSteps));
  if (canCache) {
    const previous = agentStepPrepCache.get(rawSteps);
    if (
      previous &&
      isDeepStrictEqual(previous.agentFields, agentFields) &&
      previous.catalogRevision === reuseInputs.catalogRevision &&
      previous.phaseEpoch === reuseInputs.phaseEpoch &&
      isDeepStrictEqual(previous.dynamicModelMap, reuseInputs.dynamicModelMap) &&
      isDeepStrictEqual(previous.fallbackStaticContext || null, fallbackStaticContext || null) &&
      sameFallbackUpstreams(previous.fallbackUpstreams, facts.fallbackModelKeys, upstream)
    ) {
      return previous.prepared;
    }
  }
  const enrichedRes = enrichActiveConversationSteps(rawSteps, resolveStepModel, upstream, agentFields);
  const taggedSteps = enrichedRes.enrichedActiveSteps;
  const liveTaggedSteps = taggedSteps.filter((st) => !st?.isReverted);
  const latestLiveEnriched =
    liveTaggedSteps.length > 0 ? liveTaggedSteps[liveTaggedSteps.length - 1] : null;
  const prepared = {
    enrichedRes,
    recentSteps: taggedSteps.slice().reverse(),
    ctxRes: extractActiveContextTelemetry(
      liveTaggedSteps,
      latestLiveEnriched,
      enrichedRes.sessionInputTokens,
      enrichedRes.sessionCacheReadTokens,
      fallbackStaticContext
    ),
    modelBreakdown: buildScopedModelBreakdown(taggedSteps, resolveStepModel),
  };
  // 按 rawSteps 数组引用缓存各代理（含多代理子代理）步骤富化结果，步骤变更后由 WeakMap 自动淘汰。
  if (canCache) {
    agentStepPrepCache.set(rawSteps, {
      agentFields,
      catalogRevision: reuseInputs.catalogRevision,
      phaseEpoch: reuseInputs.phaseEpoch,
      dynamicModelMap: reuseInputs.dynamicModelMap,
      fallbackStaticContext: fallbackStaticContext || null,
      fallbackUpstreams: snapshotFallbackUpstreams(facts.fallbackModelKeys, upstream),
      prepared,
    });
  }
  return prepared;
}

/**
 * 构建单个代理（主代理或子代理）的标准遥测单元对象。
 */
export function buildAgentUnitTelemetry({
  agentId,
  cascadeId,
  isMain,
  isSideQuestion = false,
  sideIndex = 0,
  agentKind = isMain ? 'main' : isSideQuestion ? 'side_question' : 'subagent',
  agentOrdinal = isMain ? 0 : isSideQuestion ? sideIndex : 0,
  customRole = '',
  swarmState = '',
  isSwarmAuxiliary = false,
  index,
  shortLabel,
  badgeText,
  role,
  typeName,
  agentLabel,
  status,
  rawSteps,
  fallbackStaticContext = null,
  liveActivity = null,
  fallbackLastModMs,
  resolveStepModel,
  knownUpstreamByModelKey,
  includeRecentSteps = true,
  reuseInputs = null,
}) {
  const { enrichedRes, ctxRes, modelBreakdown, recentSteps } = prepareAgentSteps(
    rawSteps,
    resolveStepModel,
    knownUpstreamByModelKey,
    {
      agentId,
      agentCascadeId: cascadeId,
      agentKind,
      agentOrdinal,
      agentCustomRole: customRole,
      agentLabel,
      agentBadge: badgeText,
      agentRole: role,
      agentIndex: index,
      isSubagent: !isMain,
      ...(isSideQuestion ? { isSideQuestion: true, sideIndex } : {}),
    },
    reuseInputs,
    fallbackStaticContext
  );
  const taggedSteps = enrichedRes.enrichedActiveSteps;
  const lastModifiedMs =
    enrichedRes.latestEnriched?.createdAtMs || fallbackLastModMs || 0;
  const isRunning = status === 'CASCADE_RUN_STATUS_RUNNING';
  const resolvedLiveActivity = isRunning
    ? liveActivity ||
      extractLiveActivity([], true, lastModifiedMs || fallbackLastModMs || 0)
    : null;

  return {
    enrichedRes,
    taggedSteps,
    recentSteps,
    ctxRes,
    telemetryUnit: {
      agentId,
      cascadeId,
      isMain,
      agentKind,
      agentOrdinal,
      customRole,
      ...(swarmState ? { swarmState } : {}),
      ...(isSwarmAuxiliary ? { isSwarmAuxiliary: true } : {}),
      ...(isSideQuestion ? { isSideQuestion: true, sideIndex } : {}),
      index,
      shortLabel,
      badgeText,
      role,
      typeName,
      isRunning,
      status: status || 'IDLE',
      liveActivity: resolvedLiveActivity,
      stepCount: taggedSteps.length,
      latestTokPerSec: enrichedRes.latestEnriched?.tokPerSec ?? null,
      latestTtftSec: enrichedRes.latestEnriched?.ttftSec ?? null,
      lastKnownTtftSec: enrichedRes.lastKnownTtftSec ?? null,
      latestSpeedReason: enrichedRes.latestEnriched?.selectedSpeedReason ?? null,
      avgTokPerSec: enrichedRes.sessionAvgTokPerSec,
      speedSummary: enrichedRes.sessionSpeed,
      ttftSummary: enrichedRes.sessionTtft,
      latestStepCostUsd: enrichedRes.latestEnriched?.costUsd ?? null,
      sessionCostUsd: roundSessionCost(enrichedRes.sessionCostUsd),
      sessionUnpricedCalls: enrichedRes.sessionUnpricedCalls,
      inputTokens: enrichedRes.sessionInputTokens,
      cacheReadTokens: enrichedRes.sessionCacheReadTokens,
      outputTokens: enrichedRes.sessionOutputTokens,
      totalTokens:
        enrichedRes.sessionInputTokens +
        enrichedRes.sessionCacheReadTokens +
        enrichedRes.sessionOutputTokens,
      latestPromptTokens: enrichedRes.latestEnriched
        ? Number(enrichedRes.latestEnriched.inputTokens || 0) +
          Number(enrichedRes.latestEnriched.cacheReadTokens || 0)
        : 0,
      latestCacheHitPct: ctxRes.latestCacheHitPct,
      sessionCacheHitPct: ctxRes.sessionCacheHitPct,
      hasKnownModel: Boolean(enrichedRes.latestEnriched?.hasKnownModel),
      activeBaseModelShort: enrichedRes.latestEnriched?.baseModelShort || '',
      activeBaseModelLabel: enrichedRes.latestEnriched?.baseModelLabel || '',
      activeModelShort: enrichedRes.latestEnriched?.modelShort || '模型未知',
      activeModelLabel: enrichedRes.latestEnriched?.modelLabel || '模型未知',
      activeModelUpstream:
        enrichedRes.latestEnriched?.modelUpstream ||
        enrichedRes.latestEnriched?.modelShort ||
        '模型未知',
      context: ctxRes.context,
      ...(includeRecentSteps ? { recentSteps } : {}),
      modelBreakdown,
      lastModifiedMs,
    },
  };
}

async function readTelemetrySources(
  requestedConvId,
  forceQuotaRefresh,
  currentAccountName,
  accountScope,
  userStatus,
  endpoint = null,
  progressiveLocalSync = false,
  expectedGeneration = null
) {
  const isRemote = Boolean(endpoint && endpoint.isRemote);
  const skipRedundantSummaryForce =
    Boolean(localSummaryMemo.available) &&
    Date.now() - Number(localSummaryMemo.refreshedAtMs || 0) < 1500;
  const localSummaries = isRemote
    ? { available: false, summariesObj: {}, sideQuestionParents: {} }
    : readLocalSummarySnapshot(undefined, {
        forceRefresh: Boolean(forceQuotaRefresh && !skipRedundantSummaryForce),
      });
  const [allTrajRes, officialQuotaInfo, contextModelCatalog] = await Promise.all([
    localSummaries.available
      ? Promise.resolve(null)
      : callLsRpc('GetAllCascadeTrajectories', {}, 5000, endpoint).catch(() => ({})),
    userStatus ? getOfficialQuotaSummary(forceQuotaRefresh, currentAccountName, endpoint) : null,
    getContextModelCatalog(endpoint),
  ]);

  const sessions = await enumerateAndSyncConversations({
    summariesObj: localSummaries.available
      ? localSummaries.summariesObj
      : allTrajRes?.trajectorySummaries || {},
    summariesFromLocalDb: localSummaries.available,
    summariesAvailable: Boolean(localSummaries.available || allTrajRes?.trajectorySummaries),
    sideQuestionParents: localSummaries.available ? localSummaries.sideQuestionParents : {},
    currentAccountName: accountScope,
    requestedConvId,
    forceRefresh: forceQuotaRefresh,
    progressiveLocalSync,
    expectedGeneration,
    endpoint,
  });
  return { officialQuotaInfo, contextModelCatalog, sessions };
}

function getTelemetrySources(
  requestedConvId,
  forceQuotaRefresh,
  currentAccountName,
  accountScope,
  userStatus,
  endpoint = null,
  progressiveLocalSync = false,
  expectedGeneration = null
) {
  const endpointKey = endpoint?.isRemote ? String(endpoint.id || 'remote') : LOCAL_ENDPOINT_ID;
  const read = () => readTelemetrySources(
    requestedConvId,
    forceQuotaRefresh,
    currentAccountName,
    accountScope,
    userStatus,
    endpoint,
    progressiveLocalSync,
    expectedGeneration
  );
  if (forceQuotaRefresh) return read();
  const key = JSON.stringify([
    endpointKey,
    requestedConvId || '',
    accountScope,
    Boolean(userStatus),
    Boolean(progressiveLocalSync),
    expectedGeneration,
  ]);
  const existing = inFlightTelemetrySources.get(key);
  if (existing) return existing;
  const pending = read().finally(() => {
    inFlightTelemetrySources.delete(key);
  });
  inFlightTelemetrySources.set(key, pending);
  return pending;
}

function classifySubagentDisplayMeta(subSum, subEntry, idx, counters) {
  const subSpec = subSum.subagentSpec || subEntry?.subagentSpec || null;
  const isSideQ = Boolean(
    subSum.isSideQuestion || subEntry?.isSideQuestion || subSpec?.typeName === 'side_question'
  );
  const rawRole =
    subSpec?.role || subSum.agentScriptName || subEntry?.agentScriptName || subSpec?.typeName || '';
  const parsedSwarm = !isSideQ
    ? parseSwarmWorkerRole({
        role: subSpec?.role || '',
        typeName: subSpec?.typeName || '',
        agentScriptName: subSum.agentScriptName || subEntry?.agentScriptName || '',
        memberName: subSum.swarmMemberName || '',
      })
    : { isSwarmWorker: false };
  const isSwarmW = Boolean(!isSideQ && (subSum.isSwarmWorker || parsedSwarm.isSwarmWorker));
  const isSubRunning = subSum.status === 'CASCADE_RUN_STATUS_RUNNING';
  const isKilled = Boolean(subSum.killed || subSum.swarmState === 'killed');
  const subIndex = idx + 1;
  let sideIndex = 0;
  let agentKind = 'subagent';
  let agentOrdinal = 0;
  let customRole = '';
  let swarmState = '';
  let isSwarmAuxiliary = false;
  let shortLabel = '';
  let badgeText = '';
  let roleLabel = '';
  let runningRole = '';
  let typeName = '';
  let agentLabel = '';

  if (isSideQ) {
    sideIndex = ++counters.side;
    agentKind = 'side_question';
    agentOrdinal = sideIndex;
    shortLabel = `旁路提问 #${sideIndex}`;
    badgeText = `旁${sideIndex}`;
    const cleanSideRole =
      rawRole &&
      rawRole !== '旁路提问' &&
      rawRole !== 'Side Question' &&
      rawRole !== 'side_question'
        ? rawRole
        : '';
    customRole = cleanSideRole;
    roleLabel = cleanSideRole || '旁路提问';
    runningRole = cleanSideRole || shortLabel;
    typeName = 'side_question';
    agentLabel = cleanSideRole ? `${shortLabel} · ${cleanSideRole}` : shortLabel;
  } else if (isSwarmW) {
    const swOrd = ++counters.swarm;
    agentKind = 'swarm_worker';
    agentOrdinal = swOrd;
    const memberTag = parsedSwarm.memberName ? `@${parsedSwarm.memberName}` : '';
    customRole = memberTag;
    shortLabel = `蜂群 #${swOrd}`;
    badgeText = `蜂${swOrd}`;
    roleLabel = memberTag || '蜂群';
    runningRole = memberTag || shortLabel;
    typeName = 'worker';
    agentLabel = memberTag ? `${shortLabel} · ${memberTag}` : shortLabel;
    swarmState = isKilled ? 'killed' : isSubRunning ? 'working' : subSum.swarmState || 'waiting';
    isSwarmAuxiliary = Boolean(subSum.isSwarmAuxiliary || parsedSwarm.isAuxiliary);
  } else {
    const subOrd = ++counters.normal;
    agentKind = 'subagent';
    agentOrdinal = subOrd;
    customRole = rawRole && rawRole !== '子代理' && rawRole !== 'Subagent' ? rawRole : '';
    shortLabel = `子代理 #${subOrd}`;
    badgeText = `子${subOrd}`;
    roleLabel = rawRole || '子代理';
    runningRole = rawRole || shortLabel;
    typeName = subSpec?.typeName || '';
    agentLabel = rawRole ? `${shortLabel} · ${rawRole}` : shortLabel;
  }

  return {
    subSpec,
    isSideQ,
    isSwarmW,
    isSubRunning,
    isKilled,
    subIndex,
    sideIndex,
    agentKind,
    agentOrdinal,
    customRole,
    swarmState,
    isSwarmAuxiliary,
    shortLabel,
    badgeText,
    roleLabel,
    runningRole,
    typeName,
    agentLabel,
  };
}

function buildActiveConversationAssembly({
  activeCascadeId,
  activeConvSummary,
  activeEntry,
  resolveStepModel,
  knownUpstreamByModelKey,
  modelInputs,
  accountScope,
  endpointId = LOCAL_ENDPOINT_ID,
  cacheStore = null,
}) {
  const activeSteps = activeEntry?.steps || [];
  const subagentSummaries = activeConvSummary?.subagents || [];
  const epKey = String(endpointId || LOCAL_ENDPOINT_ID);
  const cacheKey = `${epKey}::${String(activeCascadeId || '__empty__').toLowerCase()}`;

  const subEntries = subagentSummaries.map((subSum) =>
    findTrajectoryCacheEntry(subSum.cascadeId, cacheStore, { hydrate: true })
  );
  const subRawStepsList = subEntries.map((entry) => entry?.steps || []);
  const combinedFallbackKeys = new Set();
  for (const k of readTrajectoryModelFacts(activeSteps).fallbackModelKeys) {
    combinedFallbackKeys.add(k);
  }
  for (const steps of subRawStepsList) {
    for (const k of readTrajectoryModelFacts(steps).fallbackModelKeys) {
      combinedFallbackKeys.add(k);
    }
  }

  const taskStepsMetaSig = (ts) =>
    ts && Number(ts.total) > 0
      ? `${ts.done}/${ts.total}:${ts.inProgress || 0}:${ts.failed || 0}:${ts.skipped || 0}:${ts.currentTitle || ''}:${(ts.items || []).map((x) => `${x.status}:${x.title}`).join('|')}`
      : '';
  const assemblyMetaSig = JSON.stringify([
    activeCascadeId || '',
    activeConvSummary?.title || '',
    activeConvSummary?.swarmTitle || '',
    activeConvSummary?.status || 'IDLE',
    activeConvSummary?.lastModifiedMs || activeEntry?.lastModifiedMs || 0,
    activeConvSummary?.liveActivity?.signature || '',
    activeConvSummary?.liveActivity?.startedAtMs || 0,
    taskStepsMetaSig(activeConvSummary?.liveActivity?.taskSteps),
    activeEntry?.lastKnownStaticContext || null,
    subagentSummaries.map((subSum, idx) => {
      const subEntry = subEntries[idx];
      const subSpec = subSum.subagentSpec || subEntry?.subagentSpec || null;
      return [
        subSum.cascadeId || '',
        subSum.status || 'IDLE',
        Boolean(subSum.killed),
        subSum.swarmState || '',
        Boolean(subSum.isSwarmWorker),
        Boolean(subSum.isSwarmAuxiliary),
        Boolean(subSum.isSideQuestion || subEntry?.isSideQuestion),
        subSum.swarmMemberName || '',
        subSum.agentScriptName || subEntry?.agentScriptName || '',
        subSum.lastModifiedMs || subEntry?.lastModifiedMs || 0,
        subSum.liveActivity?.signature || '',
        subSum.liveActivity?.startedAtMs || 0,
        taskStepsMetaSig(subSum.liveActivity?.taskSteps),
        subEntry?.lastKnownStaticContext || null,
        subSpec?.role || '',
        subSpec?.typeName || '',
      ];
    }),
  ]);

  const cachedAssembly = conversationAssemblyCache.get(cacheKey);
  if (
    cachedAssembly &&
    cachedAssembly.activeSteps === activeSteps &&
    cachedAssembly.assemblyMetaSig === assemblyMetaSig &&
    cachedAssembly.subRawStepsList.length === subRawStepsList.length &&
    cachedAssembly.subRawStepsList.every((s, idx) => s === subRawStepsList[idx]) &&
    cachedAssembly.catalogRevision === modelInputs.catalogRevision &&
    cachedAssembly.phaseEpoch === modelInputs.phaseEpoch &&
    isDeepStrictEqual(cachedAssembly.dynamicModelMap, modelInputs.dynamicModelMap) &&
    sameFallbackUpstreams(
      cachedAssembly.fallbackUpstreams,
      combinedFallbackKeys,
      knownUpstreamByModelKey
    )
  ) {
    conversationAssemblyCache.delete(cacheKey);
    conversationAssemblyCache.set(cacheKey, cachedAssembly);
    return cachedAssembly.result;
  }

  const agentReuseInputs = { ...modelInputs, endpointId: epKey, activeCascadeId, accountScope };
  const mainUnit = buildAgentUnitTelemetry({
    agentId: 'main',
    cascadeId: activeCascadeId,
    isMain: true,
    index: 0,
    shortLabel: '主代理',
    badgeText: '主',
    role: '主代理',
    typeName: 'root',
    agentLabel: '主代理',
    status: activeConvSummary?.status || 'IDLE',
    rawSteps: activeSteps,
    fallbackStaticContext: activeEntry?.lastKnownStaticContext || null,
    liveActivity: activeConvSummary?.liveActivity || null,
    fallbackLastModMs: activeConvSummary?.lastModifiedMs || activeEntry?.lastModifiedMs || 0,
    resolveStepModel,
    knownUpstreamByModelKey,
    includeRecentSteps: false,
    reuseInputs: agentReuseInputs,
  });

  const enrichedActiveSteps = mainUnit.taggedSteps;
  const {
    latestEnriched,
    sessionSpeed,
    sessionTtft,
    sessionAvgTokPerSec,
    sessionCostUsd,
    sessionUnpricedCalls,
    sessionInputTokens,
    sessionCacheReadTokens,
    sessionOutputTokens,
  } = mainUnit.enrichedRes;
  const { latestCacheHitPct, sessionCacheHitPct, context } = mainUnit.ctxRes;
  const mainAgentTelemetry = mainUnit.telemetryUnit;
  const mainModelBreakdown = mainAgentTelemetry.modelBreakdown;

  const activeFamilyCascadeIds = new Set(activeCascadeId ? [activeCascadeId.toLowerCase()] : []);
  const subAgentTelemetries = [];
  const hasSubagentSummaries = subagentSummaries.length > 0;
  const mainStepsForFamily = hasSubagentSummaries
    ? enrichedActiveSteps.map((st) => ({ ...st }))
    : enrichedActiveSteps;
  const allCombinedRawSteps = hasSubagentSummaries ? activeSteps.slice() : [];
  const allCombinedEnrichedSteps = hasSubagentSummaries ? mainStepsForFamily.slice() : [];
  let totalRawSessionCostUsd = sessionCostUsd;
  let totalFamilyInputTokens = sessionInputTokens;
  let totalFamilyCacheReadTokens = sessionCacheReadTokens;
  let totalFamilyOutputTokens = sessionOutputTokens;

  const subCounters = { normal: 0, swarm: 0, side: 0 };
  for (let idx = 0; idx < subagentSummaries.length; idx++) {
    const subSum = subagentSummaries[idx];
    const subCid = subSum.cascadeId;
    activeFamilyCascadeIds.add(String(subCid || '').toLowerCase());
    const subEntry = subEntries[idx];
    const subRawSteps = subRawStepsList[idx];
    for (const step of subRawSteps) allCombinedRawSteps.push(step);

    const {
      isSideQ,
      subIndex,
      sideIndex,
      agentKind,
      agentOrdinal,
      customRole,
      swarmState,
      isSwarmAuxiliary,
      shortLabel,
      badgeText,
      roleLabel,
      typeName,
      agentLabel,
    } = classifySubagentDisplayMeta(subSum, subEntry, idx, subCounters);

    const subUnit = buildAgentUnitTelemetry({
      agentId: subCid,
      cascadeId: subCid,
      isMain: false,
      isSideQuestion: isSideQ,
      sideIndex,
      agentKind,
      agentOrdinal,
      customRole,
      swarmState,
      isSwarmAuxiliary,
      index: subIndex,
      shortLabel,
      badgeText,
      role: roleLabel,
      typeName,
      agentLabel,
      status: subSum.status || 'IDLE',
      rawSteps: subRawSteps,
      fallbackStaticContext: subEntry?.lastKnownStaticContext || null,
      liveActivity: subSum.liveActivity || null,
      fallbackLastModMs: subSum.lastModifiedMs || subEntry?.lastModifiedMs || 0,
      resolveStepModel,
      knownUpstreamByModelKey,
      includeRecentSteps: false,
      reuseInputs: agentReuseInputs,
    });

    const clonedSubSteps = subUnit.taggedSteps.map((st) => ({ ...st }));
    for (const step of clonedSubSteps) allCombinedEnrichedSteps.push(step);
    totalRawSessionCostUsd += subUnit.enrichedRes.sessionCostUsd;
    totalFamilyInputTokens += subUnit.enrichedRes.sessionInputTokens;
    totalFamilyCacheReadTokens += subUnit.enrichedRes.sessionCacheReadTokens;
    totalFamilyOutputTokens += subUnit.enrichedRes.sessionOutputTokens;
    subAgentTelemetries.push({
      ...subUnit.telemetryUnit,
      recentSteps: clonedSubSteps.slice().reverse(),
    });
  }

  const allAgents = [mainAgentTelemetry, ...subAgentTelemetries];
  let aggregatedTelemetry = mainAgentTelemetry;
  let mainRecentSteps = mainUnit.recentSteps;

  if (subAgentTelemetries.length > 0) {
    mainRecentSteps = mainStepsForFamily.slice().reverse();
    allCombinedRawSteps.sort(
      (a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0) || (a.stepIndex || 0) - (b.stepIndex || 0)
    );
    allCombinedEnrichedSteps.sort(
      (a, b) =>
        (a.createdAtMs || 0) - (b.createdAtMs || 0) ||
        (a.agentIndex || 0) - (b.agentIndex || 0) ||
        (a.stepIndex || 0) - (b.stepIndex || 0)
    );

    // 在多代理汇总视图下，将并行交错的子代理步骤按时间归入对应的主会话用户轮次，避免导轨被交错步骤切碎
    const mainTurnByIdx = new Map();
    let maxRootTurn = 0;
    for (const mSt of mainStepsForFamily) {
      if (mSt.isReverted) continue;
      const tIdx = mSt.turnIndex;
      if (!Number.isInteger(tIdx) || tIdx <= 0) continue;
      if (tIdx > maxRootTurn) maxRootTurn = tIdx;
      if (!mainTurnByIdx.has(tIdx) || mSt.isTurnStart) {
        mainTurnByIdx.set(tIdx, {
          turnIndex: tIdx,
          startMs: mSt.createdAtMs || 0,
          prompt: mSt.turnPrompt || '',
          cleanPrompt: mSt.turnPromptClean ?? '',
          hasMedia: Boolean(mSt.turnHasMedia),
          mediaOnly: Boolean(mSt.turnMediaOnly),
        });
      }
    }
    const mainTurns = Array.from(mainTurnByIdx.values()).sort(
      (a, b) => a.turnIndex - b.turnIndex
    );
    if (mainTurns.length > 0) {
      const seenRootStarts = new Set();
      for (const st of allCombinedEnrichedSteps) {
        if (st.isReverted) {
          if (Number.isInteger(st.turnIndex) && st.turnIndex > 0) {
            st.rootTurnIndex = st.turnIndex;
            st.isRootLatestTurn = false;
            st.isRootTurnStart = Boolean(st.isTurnStart);
            st.rootTurnPrompt = st.turnPrompt || '';
            st.rootTurnPromptClean = st.turnPromptClean ?? '';
            st.rootTurnHasMedia = Boolean(st.turnHasMedia);
            st.rootTurnMediaOnly = Boolean(st.turnMediaOnly);
          }
          continue;
        }
        let matched = null;
        if (!st.isSubagent && Number.isInteger(st.turnIndex) && st.turnIndex > 0) {
          matched = mainTurnByIdx.get(st.turnIndex) || null;
        } else {
          const ts = st.createdAtMs || 0;
          for (let k = mainTurns.length - 1; k >= 0; k--) {
            if (ts >= mainTurns[k].startMs) {
              matched = mainTurns[k];
              break;
            }
          }
          if (!matched) matched = mainTurns[0];
        }
        if (matched) {
          st.rootTurnIndex = matched.turnIndex;
          st.isRootLatestTurn = matched.turnIndex === maxRootTurn;
          st.rootTurnPrompt = matched.prompt || '';
          st.rootTurnPromptClean = matched.cleanPrompt ?? '';
          st.rootTurnHasMedia = Boolean(matched.hasMedia);
          st.rootTurnMediaOnly = Boolean(matched.mediaOnly);
          if (!seenRootStarts.has(matched.turnIndex)) {
            seenRootStarts.add(matched.turnIndex);
            st.isRootTurnStart = true;
          } else {
            st.isRootTurnStart = false;
          }
        }
      }
    }
    const combinedSpeed = summarizeSpeed(allCombinedRawSteps);
    const combinedTtft = summarizeTtft(allCombinedRawSteps);
    const combinedAvgTokPerSec = roundMetric(combinedSpeed.avgTokPerSec);
    const combinedModelBreakdown = buildScopedModelBreakdown(
      allCombinedEnrichedSteps,
      resolveStepModel
    );

    const runningAgent = allAgents.find((a) => a.isRunning);
    const latestActiveAgent =
      runningAgent ||
      allAgents
        .slice()
        .sort((a, b) => (b.lastModifiedMs || 0) - (a.lastModifiedMs || 0))[0] ||
      mainAgentTelemetry;

    const agentsWithSteps = allAgents.filter((a) => a.stepCount > 0);
    const latestMetricAgent =
      latestActiveAgent.stepCount > 0
        ? latestActiveAgent
        : agentsWithSteps.find((a) => a.isRunning) ||
          agentsWithSteps
            .slice()
            .sort((a, b) => (b.lastModifiedMs || 0) - (a.lastModifiedMs || 0))[0] ||
          latestActiveAgent;

    // 汇总视图与自动跟随上下文始终锁定主线（主代理与常规子代理），防止旁路提问抽屉篡改主会话 10 通道上下文水位
    const mainlineAgents = allAgents.filter((a) => !a.isSideQuestion);
    const activeMainlineAgent = !latestActiveAgent.isSideQuestion
      ? latestActiveAgent
      : mainlineAgents.find((a) => a.isRunning) ||
        mainlineAgents
          .slice()
          .sort((a, b) => (b.lastModifiedMs || 0) - (a.lastModifiedMs || 0))[0] ||
        mainAgentTelemetry;
    const mainlineWithSteps = mainlineAgents.filter((a) => a.stepCount > 0);
    const contextMetricAgent = !latestMetricAgent.isSideQuestion
      ? latestMetricAgent
      : mainlineWithSteps.find((a) => a.isRunning) ||
        mainlineWithSteps
          .slice()
          .sort((a, b) => (b.lastModifiedMs || 0) - (a.lastModifiedMs || 0))[0] ||
        mainAgentTelemetry;

    const roleSummaryParts = [];
    if (subCounters.swarm > 0) roleSummaryParts.push(`${subCounters.swarm} 蜂群`);
    if (subCounters.normal > 0) roleSummaryParts.push(`${subCounters.normal} 子代理`);
    if (subCounters.side > 0) {
      roleSummaryParts.push(
        roleSummaryParts.length > 0 ? `${subCounters.side} 旁问` : `${subCounters.side} 旁路提问`
      );
    }
    const aggregatedRoleLabel =
      roleSummaryParts.length > 0
        ? `主代理 + ${roleSummaryParts.join(' + ')}`
        : `主代理 + ${subAgentTelemetries.length} 子代理`;

    const totalCostUsd = roundSessionCost(totalRawSessionCostUsd);
    const totalUnpricedCalls = allAgents.reduce(
      (sum, a) => sum + (a.sessionUnpricedCalls || 0),
      0
    );
    const totalFamilyPromptTokens = totalFamilyInputTokens + totalFamilyCacheReadTokens;
    const combinedSessionCacheHitPct =
      totalFamilyPromptTokens > 0
        ? +((totalFamilyCacheReadTokens / totalFamilyPromptTokens) * 100).toFixed(1)
        : 0;

    const runningSubs = subAgentTelemetries.filter((a) => a.isRunning);
    const primaryRunningSub = runningSubs
      .slice()
      .sort((a, b) => (b.lastModifiedMs || 0) - (a.lastModifiedMs || 0))[0];
    const activeActivityAgent =
      primaryRunningSub || (mainAgentTelemetry.isRunning ? mainAgentTelemetry : null);
    const aggregatedLiveActivity = activeActivityAgent?.liveActivity
      ? {
          ...activeActivityAgent.liveActivity,
          agentId: activeActivityAgent.agentId,
          agentKind: activeActivityAgent.agentKind || (activeActivityAgent.isMain ? 'main' : activeActivityAgent.isSideQuestion ? 'side_question' : 'subagent'),
          agentOrdinal: activeActivityAgent.agentOrdinal || 0,
          agentBadge: activeActivityAgent.badgeText,
          agentShortLabel: activeActivityAgent.shortLabel,
          agentRole: activeActivityAgent.role,
          agentIndex: activeActivityAgent.index,
          isMain: Boolean(activeActivityAgent.isMain),
          ...(activeActivityAgent.isSideQuestion
            ? { isSideQuestion: true, sideIndex: activeActivityAgent.sideIndex || 0 }
            : {}),
          parallelCount: runningSubs.length > 1 ? runningSubs.length : 1,
        }
      : null;

    const combinedLastKnownTtftSec =
      findLastValidStepTtft(allCombinedEnrichedSteps) ??
      latestMetricAgent.lastKnownTtftSec ??
      null;

    aggregatedTelemetry = {
      agentId: 'all',
      cascadeId: activeCascadeId,
      isMain: false,
      agentKind: 'all',
      agentOrdinal: 0,
      index: -1,
      shortLabel: '全部汇总',
      badgeText: '全部',
      role: aggregatedRoleLabel,
      typeName: 'all',
      activeAgentId: activeMainlineAgent.agentId,
      activeAgentKind: activeMainlineAgent.agentKind || (activeMainlineAgent.isMain ? 'main' : activeMainlineAgent.isSideQuestion ? 'side_question' : 'subagent'),
      activeAgentOrdinal: activeMainlineAgent.agentOrdinal || 0,
      activeAgentShortLabel: activeMainlineAgent.shortLabel,
      activeAgentBadge: activeMainlineAgent.badgeText,
      activeAgentRole: activeMainlineAgent.role,
      isRunning: allAgents.some((a) => a.isRunning),
      status: allAgents.some((a) => a.isRunning) ? 'CASCADE_RUN_STATUS_RUNNING' : 'IDLE',
      liveActivity: aggregatedLiveActivity,
      stepCount: allCombinedEnrichedSteps.length,
      latestTokPerSec: latestMetricAgent.latestTokPerSec,
      latestTtftSec: latestMetricAgent.latestTtftSec,
      lastKnownTtftSec: combinedLastKnownTtftSec,
      latestSpeedReason: latestMetricAgent.latestSpeedReason,
      avgTokPerSec: combinedAvgTokPerSec,
      speedSummary: combinedSpeed,
      ttftSummary: combinedTtft,
      latestStepCostUsd: latestMetricAgent.latestStepCostUsd,
      sessionCostUsd: totalCostUsd,
      sessionUnpricedCalls: totalUnpricedCalls,
      inputTokens: totalFamilyInputTokens,
      cacheReadTokens: totalFamilyCacheReadTokens,
      outputTokens: totalFamilyOutputTokens,
      totalTokens: totalFamilyInputTokens + totalFamilyCacheReadTokens + totalFamilyOutputTokens,
      latestPromptTokens: latestMetricAgent.latestPromptTokens ?? 0,
      latestCacheHitPct: latestMetricAgent.latestCacheHitPct,
      sessionCacheHitPct: combinedSessionCacheHitPct,
      hasKnownModel: Boolean(latestMetricAgent.hasKnownModel),
      activeBaseModelShort: latestMetricAgent.activeBaseModelShort || '',
      activeBaseModelLabel: latestMetricAgent.activeBaseModelLabel || '',
      activeModelShort: latestMetricAgent.activeModelShort,
      activeModelLabel: latestMetricAgent.activeModelLabel,
      activeModelUpstream: latestMetricAgent.activeModelUpstream,
      context: contextMetricAgent.context,
      modelBreakdown: combinedModelBreakdown,
      lastModifiedMs: latestActiveAgent.lastModifiedMs,
    };
  }

  const latestFamilyStep =
    allCombinedEnrichedSteps.length > 0
      ? allCombinedEnrichedSteps[allCombinedEnrichedSteps.length - 1]
      : latestEnriched;

  const activeConversation = {
    cascadeId: activeCascadeId,
    title: activeConvSummary?.title || '当前会话',
    ...(activeConvSummary?.swarmTitle ? { swarmTitle: activeConvSummary.swarmTitle } : {}),
    isRunning: activeConvSummary?.status === 'CASCADE_RUN_STATUS_RUNNING',
    status: activeConvSummary?.status || 'IDLE',
    liveActivity: mainAgentTelemetry.liveActivity || null,
    stepCount: enrichedActiveSteps.length,
    hasSubagents: subAgentTelemetries.length > 0,
    subagentCount: subAgentTelemetries.length,
    swarmCount: subCounters.swarm,
    normalSubagentCount: subCounters.normal,
    sideQuestionCount: subCounters.side,
    totalStepsAllAgents: subAgentTelemetries.length
      ? allCombinedEnrichedSteps.length
      : enrichedActiveSteps.length,
    latestTokPerSec: latestEnriched?.tokPerSec ?? null,
    latestTtftSec: latestEnriched?.ttftSec ?? null,
    lastKnownTtftSec:
      mainAgentTelemetry.lastKnownTtftSec ?? findLastValidStepTtft(enrichedActiveSteps),
    latestSpeedReason: latestEnriched?.selectedSpeedReason ?? null,
    avgTokPerSec: sessionAvgTokPerSec,
    speedSummary: sessionSpeed,
    ttftSummary: sessionTtft,
    latestStepCostUsd: latestEnriched?.costUsd ?? null,
    sessionCostUsd: roundSessionCost(sessionCostUsd),
    sessionUnpricedCalls,
    inputTokens: sessionInputTokens,
    cacheReadTokens: sessionCacheReadTokens,
    outputTokens: sessionOutputTokens,
    totalTokens: sessionInputTokens + sessionCacheReadTokens + sessionOutputTokens,
    latestPromptTokens: latestEnriched
      ? Number(latestEnriched.inputTokens || 0) + Number(latestEnriched.cacheReadTokens || 0)
      : 0,
    latestCacheHitPct,
    sessionCacheHitPct,
    hasKnownModel: Boolean(latestEnriched?.hasKnownModel),
    activeBaseModelShort: latestEnriched?.baseModelShort || '',
    activeBaseModelLabel: latestEnriched?.baseModelLabel || '',
    activeModelShort: latestEnriched?.modelShort || '模型未知',
    activeModelLabel: latestEnriched?.modelLabel || '模型未知',
    activeModelUpstream:
      latestEnriched?.modelUpstream || latestEnriched?.modelShort || '模型未知',
    context,
    recentSteps: mainRecentSteps,
    modelBreakdown: mainModelBreakdown,
    agents: allAgents,
    aggregated: aggregatedTelemetry,
  };

  const result = {
    activeConversation,
    activeFamilyCascadeIds,
    latestFamilyStep,
  };

  let assemblyStepBudget = Array.isArray(activeSteps) ? activeSteps.length : 0;
  for (const subSteps of subRawStepsList) {
    if (Array.isArray(subSteps)) assemblyStepBudget += subSteps.length;
  }
  conversationAssemblyCache.delete(cacheKey);
  conversationAssemblyCache.set(cacheKey, {
    activeSteps,
    subRawStepsList,
    assemblyMetaSig,
    catalogRevision: modelInputs.catalogRevision,
    phaseEpoch: modelInputs.phaseEpoch,
    dynamicModelMap: modelInputs.dynamicModelMap,
    fallbackUpstreams: snapshotFallbackUpstreams(combinedFallbackKeys, knownUpstreamByModelKey),
    stepBudget: assemblyStepBudget,
    result,
  });
  let totalAssemblySteps = 0;
  for (const rec of conversationAssemblyCache.values()) {
    totalAssemblySteps += Number(rec?.stepBudget || 0);
  }
  while (
    conversationAssemblyCache.size > MAX_CONVERSATION_ASSEMBLY_CACHE ||
    (conversationAssemblyCache.size > 1 &&
      totalAssemblySteps > MAX_CONVERSATION_ASSEMBLY_TOTAL_STEPS)
  ) {
    const oldestKey = conversationAssemblyCache.keys().next().value;
    if (oldestKey === undefined) break;
    const evicted = conversationAssemblyCache.get(oldestKey);
    conversationAssemblyCache.delete(oldestKey);
    totalAssemblySteps -= Number(evicted?.stepBudget || 0);
  }

  return result;
}

function createEmptyCycleSummary() {
  return {
    calls: 0,
    tokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    unpricedCalls: 0,
  };
}

function resolveActivePoolKeyFromStep(latestFamilyStep, quotaPoolsMap) {
  const hasResolvedStepModel = Boolean(
    latestFamilyStep && latestFamilyStep.modelKey && latestFamilyStep.modelKey !== 'unknown'
  );
  const latestIsCarbon = hasResolvedStepModel
    ? isCarbonModelIdentifier(
        latestFamilyStep.modelKey,
        latestFamilyStep.responseModel,
        latestFamilyStep.modelUpstream,
        latestFamilyStep.modelLabel
      )
    : false;
  const latestIsArgon = hasResolvedStepModel
    ? isArgonModelIdentifier(
        latestFamilyStep.modelKey,
        latestFamilyStep.responseModel,
        latestFamilyStep.modelUpstream,
        latestFamilyStep.modelLabel
      )
    : false;
  const rawActiveFamily = latestFamilyStep?.family || 'Other';
  const activePoolKey = !hasResolvedStepModel
    ? 'Unknown'
    : latestIsCarbon && quotaPoolsMap.has('Carbon')
      ? 'Carbon'
      : latestIsArgon && quotaPoolsMap.has('Argon')
        ? 'Argon'
        : rawActiveFamily === 'Gemini'
          ? 'Gemini'
          : ['Claude', 'GPT', 'Other'].includes(rawActiveFamily)
            ? 'Claude & GPT'
            : 'Unknown';
  const matchedActivePool = quotaPoolsMap.get(activePoolKey) || null;
  const activeLive5h = matchedActivePool?.has5h
    ? {
        remainingPct: matchedActivePool.remainingPct,
        remainingIntPct: matchedActivePool.remainingIntPct,
        usedPct: matchedActivePool.usedPct,
        resetTime: matchedActivePool.resetTime,
      }
    : null;
  const activeLiveWeekly = matchedActivePool?.hasWeekly
    ? {
        remainingPct: matchedActivePool.weeklyRemainingPct,
        remainingIntPct: matchedActivePool.weeklyRemainingIntPct,
        usedPct: matchedActivePool.weeklyUsedPct,
        resetTime: matchedActivePool.weeklyResetTime,
      }
    : null;
  return { activePoolKey, matchedActivePool, activeLive5h, activeLiveWeekly };
}

function buildActivePoolAndWeeklyQuotas({
  activePoolKey,
  activeLive5h,
  activeLiveWeekly,
  quotaPoolsMap,
  isCustomWeeklyMode,
  settings,
  weekBucket,
  quotaWeekBucket,
  poolsWeeklySummary,
}) {
  const familyPoolQuota = quotaPoolsMap.get(activePoolKey);
  const activePoolLabel = familyPoolQuota?.poolLabel || activePoolKey;
  const activePoolQuota = familyPoolQuota || {
    poolKey: activePoolKey,
    poolLabel: activePoolKey === 'Unknown' ? '未知' : activePoolKey,
    poolName:
      activePoolKey === 'Carbon'
        ? 'Gemini 4 Carbon 模型池'
        : activePoolKey === 'Argon'
          ? 'Gemini 4 Argon 模型池'
          : activePoolKey === 'Gemini'
            ? 'Gemini 模型池'
            : activePoolKey === 'Claude & GPT'
              ? 'Claude & GPT 模型池'
              : '模型池未知',
    family: activePoolKey,
    isAvailable: Boolean(activeLive5h || activeLiveWeekly),
    has5h: Boolean(activeLive5h),
    hasWeekly: Boolean(activeLiveWeekly),
    remainingPct: activeLive5h?.remainingPct ?? null,
    remainingIntPct: activeLive5h?.remainingIntPct ?? null,
    usedPct: activeLive5h?.usedPct ?? null,
    externalUsedPct: 0,
    safetyReviewUsedPct: 0,
    resetTime: activeLive5h?.resetTime || null,
    weeklyRemainingPct: activeLiveWeekly?.remainingPct ?? null,
    weeklyRemainingIntPct: activeLiveWeekly?.remainingIntPct ?? null,
    weeklyUsedPct: activeLiveWeekly?.usedPct ?? null,
    weeklyExternalUsedPct: 0,
    weeklySafetyReviewUsedPct: 0,
    weeklyResetTime: activeLiveWeekly?.resetTime || null,
    cycle5h: createEmptyCycleSummary(),
    cycleWeekly: createEmptyCycleSummary(),
    models: [],
  };

  const fallbackWeeklyPct =
    settings.weeklyLimitMode === 'custom_cost'
      ? weekBucket.unpricedCalls > 0
        ? null
        : Math.min(
            100,
            +((weekBucket.costUsd / Math.max(1, settings.weeklyCostBudget)) * 100).toFixed(1)
          )
      : Math.min(
          100,
          +((weekBucket.totalTokens / Math.max(1000, settings.weeklyTokenBudget)) * 100).toFixed(1)
        );

  const useOfficialWeekly = Boolean(activeLiveWeekly) && !isCustomWeeklyMode;
  const weeklyUsedPct = useOfficialWeekly
    ? activeLiveWeekly.usedPct
    : isCustomWeeklyMode
      ? fallbackWeeklyPct
      : null;
  const weeklyRemainingPct = useOfficialWeekly
    ? activeLiveWeekly.remainingPct
    : isCustomWeeklyMode && fallbackWeeklyPct !== null
      ? +(100 - fallbackWeeklyPct).toFixed(1)
      : null;
  const weeklyRemainingIntPct = useOfficialWeekly
    ? activeLiveWeekly.remainingIntPct
    : isCustomWeeklyMode && fallbackWeeklyPct !== null
      ? Math.max(0, Math.floor(100 - fallbackWeeklyPct))
      : null;
  const officialFallbackWeekBucket = quotaWeekBucket || weekBucket;
  const weeklyQuota = {
    isOfficial: useOfficialWeekly,
    poolFamily: activePoolKey,
    title: isCustomWeeklyMode
      ? '每周限额 (自定义本机)'
      : `每周限额 (${activePoolLabel && activePoolLabel !== 'Unknown' ? activePoolLabel : '当前'})`,
    calls: isCustomWeeklyMode
      ? weekBucket.calls
      : poolsWeeklySummary
        ? poolsWeeklySummary.calls
        : officialFallbackWeekBucket.calls,
    tokens: isCustomWeeklyMode
      ? weekBucket.totalTokens
      : poolsWeeklySummary
        ? poolsWeeklySummary.tokens
        : officialFallbackWeekBucket.totalTokens,
    costUsd: isCustomWeeklyMode
      ? weekBucket.costUsd
      : poolsWeeklySummary
        ? poolsWeeklySummary.costUsd
        : officialFallbackWeekBucket.costUsd,
    unpricedCalls: isCustomWeeklyMode
      ? weekBucket.unpricedCalls
      : poolsWeeklySummary
        ? poolsWeeklySummary.unpricedCalls
        : officialFallbackWeekBucket.unpricedCalls,
    usedPct: weeklyUsedPct,
    remainingPct: weeklyRemainingPct,
    remainingIntPct: weeklyRemainingIntPct,
    resetTime: useOfficialWeekly
      ? activeLiveWeekly.resetTime
      : isCustomWeeklyMode
        ? getNextMondayResetIso()
        : null,
  };
  return { activePoolQuota, weeklyQuota };
}

/**
 * 构建完整的前端遥测载荷（核心内部实现，直接供单元测试沙箱调用）。
 *
 * @param {string} requestedConvId 请求指定的会话 ID（为空时自动选定最近活跃会话）
 * @param {boolean} [forceQuotaRefresh=false] 是否强制穿透官方配额缓存与失败退避
 * @param {{ range?: string, startMs?: number, endMs?: number, endpoint?: object|null }} [filterOpts={}] 时间范围筛选选项与可选远端端点
 * @returns {Promise<object>}
 */
export async function buildTelemetryPayloadInternal(
  requestedConvId,
  forceQuotaRefresh = false,
  filterOpts = {}
) {
  const endpoint = filterOpts?.endpoint && filterOpts.endpoint.isRemote ? filterOpts.endpoint : null;
  const isRemote = Boolean(endpoint);
  const endpointId = isRemote ? String(endpoint.id || 'remote') : LOCAL_ENDPOINT_ID;
  const endpointLabel = isRemote ? String(endpoint.label || 'SSH') : '';
  const cacheStore = getEndpointCacheStore(endpoint);
  const buildGeneration = isRemote ? 0 : getLocalRebuildGeneration();

  const settings = loadSettings();
  let userStatus = await callLsRpc('GetUserStatus', {}, 5000, endpoint)
    .then((data) => data?.userStatus)
    .catch(() => null);
  if (
    !isRemote &&
    !userStatus &&
    lsRuntimeEndpoint.addr !== 'test.invalid' &&
    (!lsRuntimeEndpoint.baseUrl || lsRuntimeEndpoint.isDynamic)
  ) {
    const prevBaseUrl = lsRuntimeEndpoint.baseUrl;
    const prevCsrf = lsRuntimeEndpoint.csrfToken;
    await ensureLsEndpointDiscovered({
      force: true,
      respectCooldown: !forceQuotaRefresh,
    });
    if (
      lsRuntimeEndpoint.baseUrl &&
      (lsRuntimeEndpoint.baseUrl !== prevBaseUrl || lsRuntimeEndpoint.csrfToken !== prevCsrf)
    ) {
      userStatus = await callLsRpc('GetUserStatus', {})
        .then((data) => data?.userStatus)
        .catch(() => null);
    }
  }
  const currentAccountName = userStatus?.email || userStatus?.name || '';
  const accountStatus = currentAccountName ? 'signedIn' :
    userStatus && !userStatus.userTier && !userStatus.planStatus ? 'signedOut' : 'unknown';
  const accountScope = accountStatus === 'signedOut' ? null : currentAccountName;
  const { officialQuotaInfo, contextModelCatalog, sessions } = await getTelemetrySources(
    requestedConvId,
    forceQuotaRefresh,
    currentAccountName,
    accountScope,
    userStatus,
    endpoint,
    Boolean(filterOpts?.progressiveLocalSync),
    isRemote ? null : buildGeneration
  );
  const { conversations, activeConvSummary, activeCascadeId, deferredCascadeIds } = sessions;

  const officialQuota = officialQuotaInfo?.data || null;
  const clientConfigs = userStatus?.cascadeModelConfigData?.clientModelConfigs || [];

  // 1. 构建官方实时配额池与动态模型目录
  const { dynamicModelMap, quotaPoolsMap } = buildOfficialQuotaPools(
    officialQuota,
    clientConfigs
  );

  const resolveStepModel = createStepModelResolver(dynamicModelMap);

  // 3. 计算当前活跃根会话及其子代理的步骤指标、10 通道上下文拆解与按模型汇总
  const reportedContextLimits = new Map();
  const knownUpstreamByModelKey = buildKnownUpstreamModelMap(reportedContextLimits, cacheStore);
  const activeEntry = findTrajectoryCacheEntry(activeCascadeId, cacheStore, { hydrate: true });
  const modelInputs = {
    catalogRevision: pricingCatalogRevision,
    phaseEpoch: getPricingPhaseEpoch(),
    dynamicModelMap,
  };
  const {
    activeConversation: assembledActiveConversation,
    activeFamilyCascadeIds,
    latestFamilyStep,
  } = buildActiveConversationAssembly({
    activeCascadeId,
    activeConvSummary,
    activeEntry,
    resolveStepModel,
    knownUpstreamByModelKey,
    modelInputs,
    accountScope,
    endpointId,
    cacheStore,
  });

  // 4. 识别当前活跃会话家族绑定的模型池（与 quota-pools.mjs 保持一致，将 Other 第三方模型归入 Claude & GPT）
  const { activePoolKey, activeLive5h, activeLiveWeekly } = resolveActivePoolKeyFromStep(
    latestFamilyStep,
    quotaPoolsMap
  );

  // 全局账号周期锚点采用稳定的配额池优先级（Gemini -> Argon -> Carbon -> Claude & GPT），
  // 防止切换不同会话时全局消费统计（consumption.presets.week / 5h）因重置时间偏移而突变
  let accountFiveHourResetMs = 0;
  let accountWeeklyResetMs = 0;
  for (const pk of POOL_PRIORITY_ORDER) {
    const pool = quotaPoolsMap.get(pk);
    if (!pool) continue;
    if (!accountFiveHourResetMs && pool.resetTime) {
      accountFiveHourResetMs = parseIsoMs(pool.resetTime);
    }
    if (!accountWeeklyResetMs && pool.weeklyResetTime) {
      accountWeeklyResetMs = parseIsoMs(pool.weeklyResetTime);
    }
  }
  const cycleAnchors = {
    fiveHourResetMs: accountFiveHourResetMs || parseIsoMs(activeLive5h?.resetTime),
    weeklyResetMs: accountWeeklyResetMs || parseIsoMs(activeLiveWeekly?.resetTime),
  };

  const isCustomWeeklyMode =
    settings.weeklyLimitMode === 'custom_tokens' || settings.weeklyLimitMode === 'custom_cost';

  // 5. 多时间窗口聚合（预设窗口 + 当前选定窗口 + 趋势 + 月序列 + 来源与模型拆解 + 各配额池独立周期统计）
  const {
    usageRevision,
    selectedWindow,
    trendStartMs,
    trendEndMs,
    finalizedSelectedSession,
    finalizedSelectedAccount,
    finalizedPresets,
    trendSeries,
    sourcesBreakdown,
    currentYear,
    monthlySeries,
    weekBucket,
    quotaWeekBucket,
    modelBreakdown,
    topConversations,
    topWorkspaces,
    poolCycleStats,
    poolsWeeklySummary,
  } = aggregateMultiWindowUsage({
    filterOpts,
    cycleAnchors,
    isCustomWeeklyMode,
    currentAccountName: accountScope,
    activeCascadeId,
    activeFamilyCascadeIds,
    resolveStepModel,
    quotaPoolsMap,
    modelInputs,
    endpoint,
  });

  for (const [pk, poolObj] of quotaPoolsMap.entries()) {
    const pStats = poolCycleStats?.get(pk);
    poolObj.cycle5h = pStats?.cycle5h || createEmptyCycleSummary();
    poolObj.cycleWeekly = pStats?.cycleWeekly || createEmptyCycleSummary();
  }

  const runningPoolKeys = new Set();
  let hasUnknownRunningPool = false;
  for (const rootConv of conversations) {
    const isMainRunning = rootConv?.status === 'CASCADE_RUN_STATUS_RUNNING';
    const rawSubs = Array.isArray(rootConv?.subagents) ? rootConv.subagents : [];
    const runningSubs = rawSubs.filter((s) => s?.status === 'CASCADE_RUN_STATUS_RUNNING');
    if (!isMainRunning && runningSubs.length === 0) continue;

    const recordRunningPool = (cid) => {
      const entry = findTrajectoryCacheEntry(cid, cacheStore);
      const steps = Array.isArray(entry?.steps) ? entry.steps : [];
      const lastStep = steps.length > 0 ? steps[steps.length - 1] : null;
      if (!lastStep) {
        hasUnknownRunningPool = true;
        return;
      }
      const mInfo = resolveStepModel(lastStep);
      const { activePoolKey: pKey } = resolveActivePoolKeyFromStep(
        {
          modelKey: lastStep.modelKey || mInfo.modelId || 'unknown',
          family: mInfo.family,
          modelLabel: mInfo.label,
          modelShort: mInfo.shortName,
          modelUpstream: mInfo.modelId,
        },
        quotaPoolsMap
      );
      if (pKey && pKey !== 'Unknown') {
        runningPoolKeys.add(pKey);
      } else {
        hasUnknownRunningPool = true;
      }
    };

    if (isMainRunning) recordRunningPool(rootConv.cascadeId);
    for (const sub of runningSubs) {
      recordRunningPool(sub.cascadeId);
    }
  }

  const localScanIncomplete = Boolean(
    (!isRemote && getLocalCacheRebuildStatus()?.active) ||
      (deferredCascadeIds instanceof Set && deferredCascadeIds.size > 0)
  );

  const nowMs = Date.now();
  const safetyMonitorSnapshot = !isRemote ? refreshSafetyMonitorTelemetry({ nowMs }) : null;

  updatePoolQuotaReservationEstimates({
    endpointId,
    accountScope: accountScope || '',
    quotaPoolsMap,
    poolCycleStats,
    runningPoolKeys,
    hasUnknownRunningPool,
    localScanIncomplete,
    safetyMonitor: safetyMonitorSnapshot,
    quotaFetchedAtMs: officialQuotaInfo?.fetchedAtMs || 0,
    nowMs,
  });

  // 6. 组装当前活跃配额池与每周限额视图数据
  const { activePoolQuota, weeklyQuota } = buildActivePoolAndWeeklyQuotas({
    activePoolKey,
    activeLive5h,
    activeLiveWeekly,
    quotaPoolsMap,
    isCustomWeeklyMode,
    settings,
    weekBucket,
    quotaWeekBucket,
    poolsWeeklySummary,
  });

  const g1CreditEntry = (userStatus?.userTier?.availableCredits || []).find(
    (c) => c?.creditType === 'GOOGLE_ONE_AI'
  );
  const realAiCredits = Number(g1CreditEntry?.creditAmount || 0);
  const uiBundleVersion = computeRuntimeCodeVersion();

  const rawTierId = String(userStatus?.userTier?.id || '').trim();
  const rawTierName = String(userStatus?.userTier?.name || '').trim();
  const rawTierDesc = String(userStatus?.userTier?.description || '').trim();
  const rawPlanName = String(userStatus?.planStatus?.planInfo?.planName || '').trim();
  const tierIdLower = rawTierId.toLowerCase();
  const tierText = `${rawTierId} ${rawTierName} ${rawTierDesc}`;
  const resolvedTierMultiplier = /(?:^|[-_\s])5x(?:$|[-_\s])|ultra[-_]?lite/i.test(tierText)
    ? '5x'
    : /(?:^|[-_\s])20x(?:$|[-_\s])/i.test(tierText) ||
        tierIdLower === 'g1-ultra-tier' ||
        (/^g1-ultra(?:-[a-z0-9]+)?-tier$/i.test(tierIdLower) && !/lite|5x/i.test(tierIdLower))
      ? '20x'
      : '';
  const resolvedTierName =
    rawTierName ||
    (/ultra/i.test(tierIdLower)
      ? 'Google AI Ultra'
      : /pro/i.test(tierIdLower)
        ? 'Google AI Pro'
        : /free|standard/i.test(tierIdLower)
          ? 'Google AI Free'
          : 'Google AI');
  const isUltraTier = /\bultra\b/i.test(resolvedTierName) || /ultra/i.test(tierIdLower);
  const inferredPlanFallback = /\bfree\b/i.test(resolvedTierName)
    ? 'Free'
    : isUltraTier
      ? resolvedTierMultiplier || 'Ultra'
      : 'Pro';
  // Google 上游对 Ultra 订阅的 planStatus.planInfo.planName 仍会返回 "Pro"，按 userTier.id 还原 5x / 20x
  const resolvedPlanName = isUltraTier
    ? resolvedTierMultiplier ||
      (rawPlanName && !/^pro$/i.test(rawPlanName) ? rawPlanName : 'Ultra')
    : rawPlanName || inferredPlanFallback;

  // 预计算近期会话与运行中会话的轻量缓存速览指标（零额外 RPC 与零 SQLite 冷会话水合开销）
  const quickStatsMemo = new Map();
  const getConversationQuickStats = (rootConv) => {
    const cidKey = String(rootConv?.cascadeId || '').toLowerCase();
    if (cidKey && quickStatsMemo.has(cidKey)) {
      return quickStatsMemo.get(cidKey);
    }
    const rootEntry = findTrajectoryCacheEntry(rootConv?.cascadeId, cacheStore, { hydrate: false });
    const rootSteps = rootEntry?.steps || [];
    const rawSubs = Array.isArray(rootConv?.subagents) ? rootConv.subagents : [];

    let totalCost = 0;
    let unpricedCalls = 0;
    const accumulateStepsCost = (steps) => {
      for (const st of steps) {
        const mInfo = resolveStepModel(st);
        const c = computeStepCost(st, mInfo.pricing);
        if (c === null) unpricedCalls += 1;
        else totalCost += c;
      }
    };
    accumulateStepsCost(rootSteps);

    const lastRootStep = rootSteps.length > 0 ? rootSteps[rootSteps.length - 1] : null;
    let bestMetricStep = lastRootStep;
    let bestMetricRunning = rootConv?.status === 'CASCADE_RUN_STATUS_RUNNING' && Boolean(lastRootStep);

    for (const subSum of rawSubs) {
      const subEntry = findTrajectoryCacheEntry(subSum?.cascadeId, cacheStore);
      const subSteps = subEntry?.steps || [];
      if (subSteps.length === 0) continue;
      accumulateStepsCost(subSteps);
      const lastSub = subSteps[subSteps.length - 1];
      const subRunning = subSum?.status === 'CASCADE_RUN_STATUS_RUNNING';
      if (
        !bestMetricStep ||
        (subRunning && !bestMetricRunning) ||
        (subRunning === bestMetricRunning &&
          (lastSub.createdAtMs || 0) >= (bestMetricStep.createdAtMs || 0))
      ) {
        bestMetricStep = lastSub;
        bestMetricRunning = subRunning;
      }
    }

    let contextUsedPct = null;
    if (lastRootStep) {
      let quickLastStep = lastRootStep;
      if (rootEntry?._coldSteps && !lastRootStep.maxContextBudgetTokens) {
        let coldLimit = 0;
        const limitsList = Array.isArray(rootEntry._stepFlags?.modelLimits)
          ? rootEntry._stepFlags.modelLimits
          : [];
        for (let i = 0; i < limitsList.length; i += 1) {
          const item = limitsList[i];
          if (item && item[0] === lastRootStep.modelKey && Number(item[1]) > 0) {
            coldLimit = Number(item[1]);
            break;
          }
        }
        if (coldLimit > 0) {
          quickLastStep = {
            ...lastRootStep,
            maxContextBudgetTokens: coldLimit,
            reportedContextLimitTokens: coldLimit,
          };
        }
      }
      contextUsedPct = extractActiveContextTelemetry(
        rootSteps,
        quickLastStep,
        0,
        0,
        rootEntry?.lastKnownStaticContext || null
      ).context.compactionUsedPct;
    }

    let modelShort = '';
    let modelUpstream = '';
    let latestTokPerSec = null;
    if (bestMetricStep) {
      const mInfo = resolveStepModel(bestMetricStep);
      const resolvedResp =
        bestMetricStep.responseModel ||
        (bestMetricStep.modelKey && bestMetricStep.modelKey !== 'unknown'
          ? knownUpstreamByModelKey.get(bestMetricStep.modelKey) || ''
          : '');
      modelShort = mInfo.shortName || '';
      const rawQuickUpstream =
        resolvedResp ||
        (mInfo.modelId && mInfo.modelId !== 'unknown' ? mInfo.modelId : mInfo.shortName) ||
        '';
      modelUpstream = formatUpstreamModelId(rawQuickUpstream, mInfo);
      latestTokPerSec = roundMetric(speedMetric(bestMetricStep).value);
    }

    const stats = {
      modelShort,
      modelUpstream,
      latestTokPerSec,
      contextUsedPct,
      sessionCostUsd: roundSessionCost(totalCost),
      sessionUnpricedCalls: unpricedCalls,
    };
    if (cidKey) {
      quickStatsMemo.set(cidKey, stats);
    }
    return stats;
  };

  // 7. 构建所有正在运行的主进程（根会话）及其子代理缩略状态列表
  const runningConversations = [];
  for (const rootConv of conversations) {
    const isMainRunning = rootConv.status === 'CASCADE_RUN_STATUS_RUNNING';
    const rawSubs = Array.isArray(rootConv.subagents) ? rootConv.subagents : [];
    const hasRunningSub = rawSubs.some((s) => s.status === 'CASCADE_RUN_STATUS_RUNNING');
    if (!isMainRunning && !hasRunningSub) {
      continue;
    }

    const rootEntry = findTrajectoryCacheEntry(rootConv.cascadeId, cacheStore);
    const rootFallbackMs =
      rootConv.lastModifiedMs || rootEntry?.lastModifiedMs || rootConv.createdTimeMs || 0;

    const runCounters = { normal: 0, swarm: 0, side: 0 };
    const subItems = rawSubs.map((subSum, idx) => {
      const subCid = subSum.cascadeId;
      const subEntry = findTrajectoryCacheEntry(subCid, cacheStore);
      const {
        subSpec,
        isSideQ,
        isSwarmW,
        isSubRunning,
        isKilled,
        subIndex,
        sideIndex,
        agentKind,
        agentOrdinal,
        customRole,
        swarmState,
        isSwarmAuxiliary,
        badgeText,
        shortLabel,
        runningRole: role,
      } = classifySubagentDisplayMeta(subSum, subEntry, idx, runCounters);
      const stepCount = Number(subSum.stepCount ?? subEntry?.steps?.length ?? 0);
      const subModMs = subSum.lastModifiedMs || subEntry?.lastModifiedMs || 0;
      const liveActivity = isSubRunning
        ? subSum.liveActivity || extractLiveActivity([], true, subModMs)
        : isSwarmW
          ? isKilled
            ? {
                phase: 'done',
                actionKey: 'swarm_killed',
                waitingApproval: false,
                detailKey: '',
                label: '已终止',
                detail: '',
                stepProgress: '',
                startedAtMs: subModMs,
                signature: `killed:${stepCount}`,
              }
            : {
                phase: 'waiting',
                actionKey: 'swarm_waiting',
                waitingApproval: false,
                detailKey: '',
                label: '待命中',
                detail: '',
                stepProgress: '',
                startedAtMs: subModMs,
                signature: `waiting:${stepCount}`,
              }
          : {
              phase: 'done',
              actionKey: 'done',
              waitingApproval: false,
              detailKey: '',
              label: '已完成',
              detail: '',
              stepProgress: '',
              startedAtMs: subModMs,
              signature: `done:${stepCount}`,
            };
      return {
        cascadeId: subCid,
        index: subIndex,
        agentKind,
        agentOrdinal,
        customRole,
        ...(swarmState ? { swarmState } : {}),
        ...(isSwarmAuxiliary ? { isSwarmAuxiliary: true } : {}),
        ...(isSideQ ? { isSideQuestion: true, sideIndex } : {}),
        badgeText,
        shortLabel,
        role,
        typeName: isSideQ ? 'side_question' : isSwarmW ? 'worker' : subSpec?.typeName || '',
        isRunning: isSubRunning,
        status: subSum.status || 'IDLE',
        stepCount,
        lastModifiedMs: subModMs,
        liveActivity,
      };
    });

    const mainLiveAct = isMainRunning
      ? rootConv.liveActivity || extractLiveActivity([], true, rootFallbackMs)
      : null;

    const runningSubCount = subItems.filter((s) => s.isRunning).length;
    const isPendingSubSpawn =
      mainLiveAct?.toolName === 'invoke_subagent' || mainLiveAct?.actionKey === 'invoke_subagent';
    const isPendingSwarmSpawn = mainLiveAct?.actionKey === 'swarm_add';
    if (isMainRunning && (isPendingSubSpawn || isPendingSwarmSpawn) && runningSubCount === 0) {
      const pendingIndex = subItems.length + 1;
      const pendingCustomRole = mainLiveAct.detail || '';
      if (isPendingSwarmSpawn) {
        const pendingSwarmOrd = ++runSwarmIdx;
        const pendingRole = pendingCustomRole || `蜂群 #${pendingSwarmOrd}`;
        subItems.push({
          cascadeId: `${rootConv.cascadeId}:pending-swarm-${pendingIndex}`,
          index: pendingIndex,
          agentKind: 'swarm_worker',
          agentOrdinal: pendingSwarmOrd,
          customRole: pendingCustomRole,
          swarmState: 'working',
          badgeText: `蜂${pendingSwarmOrd}`,
          shortLabel: `蜂群 #${pendingSwarmOrd}`,
          role: pendingRole,
          typeName: 'worker',
          isRunning: true,
          status: 'CASCADE_RUN_STATUS_RUNNING',
          stepCount: 0,
          lastModifiedMs: rootFallbackMs,
          liveActivity: {
            phase: 'thinking',
            actionKey: 'starting',
            waitingApproval: false,
            detailKey: '',
            label: '启动中',
            detail: '',
            stepProgress: '',
            startedAtMs: mainLiveAct.startedAtMs || 0,
            signature: `spawning-swarm:${pendingSwarmOrd}:${pendingRole}`,
          },
        });
      } else {
        const pendingNormOrd = ++runNormalSubIdx;
        const pendingRole = pendingCustomRole || '子代理';
        subItems.push({
          cascadeId: `${rootConv.cascadeId}:pending-sub-${pendingIndex}`,
          index: pendingIndex,
          agentKind: 'subagent',
          agentOrdinal: pendingNormOrd,
          customRole: pendingCustomRole,
          badgeText: `子${pendingNormOrd}`,
          shortLabel: `子代理 #${pendingNormOrd}`,
          role: pendingRole,
          typeName: '',
          isRunning: true,
          status: 'CASCADE_RUN_STATUS_RUNNING',
          stepCount: 0,
          lastModifiedMs: rootFallbackMs,
          liveActivity: {
            phase: 'thinking',
            actionKey: 'starting',
            waitingApproval: false,
            detailKey: '',
            label: '启动中',
            detail: '',
            stepProgress: '',
            startedAtMs: mainLiveAct.startedAtMs || 0,
            signature: `spawning-sub:${pendingIndex}:${pendingRole}`,
          },
        });
      }
    }

    const runningSubList = subItems.filter((s) => s.isRunning);
    const allRunningAreSwarm =
      runningSubList.length > 0 && runningSubList.every((s) => s.agentKind === 'swarm_worker');
    const resolvedMainActivity =
      mainLiveAct ||
      (runningSubList.length > 0
        ? {
            phase: 'waiting',
            actionKey: allRunningAreSwarm ? 'waiting_swarm' : 'waiting_subagent',
            waitingApproval: false,
            detailKey: '',
            label: allRunningAreSwarm ? '等待工蜂' : '等待子代理',
            detail: runningSubList.map((s) => s.customRole || s.role).join(', '),
            stepProgress: '',
            startedAtMs: runningSubList[0]?.liveActivity?.startedAtMs || rootFallbackMs,
            signature: `wait-subs:${runningSubList.length}:${runningSubList[0]?.cascadeId || ''}`,
          }
        : extractLiveActivity([], true, rootFallbackMs));

    const qStats = getConversationQuickStats(rootConv);
    runningConversations.push({
      cascadeId: rootConv.cascadeId,
      title: rootConv.title || rootConv.cascadeId.slice(0, 8),
      ...(rootConv.swarmTitle ? { swarmTitle: rootConv.swarmTitle } : {}),
      isCurrentSelected:
        Boolean(activeCascadeId) &&
        rootConv.cascadeId.toLowerCase() === String(activeCascadeId).toLowerCase(),
      isMainRunning,
      isRunning: true,
      status: isMainRunning ? rootConv.status : 'CASCADE_RUN_STATUS_RUNNING',
      stepCount: Number(rootConv.stepCount || 0),
      totalStepCount: Number(rootConv.totalStepCount || rootConv.stepCount || 0),
      lastModifiedMs: rootConv.groupLastModifiedMs || rootConv.lastModifiedMs || 0,
      mainActivity: resolvedMainActivity,
      subagentCount: subItems.length,
      swarmCount: runCounters.swarm,
      normalSubagentCount: runCounters.normal,
      sideQuestionCount: runCounters.side,
      runningSubagentCount: runningSubList.length,
      runningSwarmCount: runningSubList.filter((s) => s.agentKind === 'swarm_worker').length,
      subagents: subItems,
      modelShort: qStats.modelShort,
      modelUpstream: qStats.modelUpstream,
      latestTokPerSec: qStats.latestTokPerSec,
      contextUsedPct: qStats.contextUsedPct,
      sessionCostUsd: qStats.sessionCostUsd,
      sessionUnpricedCalls: qStats.sessionUnpricedCalls,
    });
  }

  const sortedQuotaPools = Array.from(quotaPoolsMap.values()).sort((a, b) => {
    const order = { Gemini: 0, Argon: 1, Carbon: 2, 'Claude & GPT': 3 };
    return (order[a.family] ?? 99) - (order[b.family] ?? 99);
  });
  if (
    !isRemote &&
    accountStatus === 'signedIn' &&
    userStatus?.email &&
    officialQuotaInfo?.data &&
    !officialQuotaInfo.isStale
  ) {
    recordAccountQuotaSnapshot(
      userStatus.email,
      sortedQuotaPools,
      officialQuotaInfo.fetchedAtMs || Date.now(),
      { isActiveHost: true }
    );
  }
  const weeklyCapacityEstimate = buildWeeklyCapacityEstimate({
    sortedPools: sortedQuotaPools,
    isCustomWeeklyMode,
    hasOfficialData: Boolean(officialQuotaInfo?.data),
  });

  const finalPayload = {
    timestamp: new Date().toISOString(),
    hostPlatform: process.platform || 'unknown',
    endpoint: {
      id: endpointId,
      isRemote,
      label: endpointLabel,
    },
    uiBundleVersion,
    windowBridge: getDefaultWindowBridgeStatus(),
    hostTheme: getEffectiveHostTheme(),
    cloudCodeProxy: getDefaultCloudCodeProxyStatus(),
    cliStatusLine: getCliStatusLineRuntimeStatus(),
    ...(safetyMonitorSnapshot?.hasActiveSources
      ? {
          safetyMonitor: {
            scannedAtMs: safetyMonitorSnapshot.scannedAtMs,
            sourceCount: safetyMonitorSnapshot.sourceCount,
            window5h: safetyMonitorSnapshot.window5h,
            window24h: safetyMonitorSnapshot.window24h,
            lastHeavyEventAtMs: safetyMonitorSnapshot.lastHeavyEventAtMs,
            lastFallbackAtMs: safetyMonitorSnapshot.lastFallbackAtMs,
            alerts: safetyMonitorSnapshot.alerts,
          },
        }
      : {}),
    settings,
    contextWindowModels: getContextWindowGroups(getContextWindowModels(clientConfigs, contextModelCatalog)).map((group) => {
      const latest = group.members.reduce((previous, id) => {
        const reported = reportedContextLimits.get(id);
        return reported && (!previous || reported.at > previous.at) ? reported : previous;
      }, null);
      return { ...group, reportedLimitTokens: latest?.tokens ?? null };
    }),
    cloudStatus: getCloudStatus(),
    fxStatus: getFxStatus(),
    account: {
      status: accountStatus,
      email: userStatus?.email || '',
      name: userStatus?.name || '',
      tierId: rawTierId,
      tierName: resolvedTierName,
      tierMultiplier: resolvedTierMultiplier,
      planName: resolvedPlanName,
      aiCredits: realAiCredits > 0 ? realAiCredits : null,
      totalConversations: conversations.length,
    },
    runningConversations,
    conversations: conversations.map((c, idx) => {
      const rawSubs = Array.isArray(c.subagents) ? c.subagents : [];
      const runningSubCount = rawSubs.filter((s) => s.status === 'CASCADE_RUN_STATUS_RUNNING').length;
      const isConvRunning = c.status === 'CASCADE_RUN_STATUS_RUNNING' || runningSubCount > 0;
      const includeQuickStats =
        idx < MAX_RECENT_QUICK_STATS ||
        isConvRunning ||
        (Boolean(activeCascadeId) &&
          String(c.cascadeId || '').toLowerCase() === String(activeCascadeId).toLowerCase());
      const qStats = includeQuickStats ? getConversationQuickStats(c) : null;
      const cSwarmCount = Number(c.swarmCount ?? rawSubs.filter((s) => s.isSwarmWorker).length);
      const cSideCount = rawSubs.filter((s) => s.isSideQuestion).length;
      const cNormalSubCount = Math.max(0, rawSubs.length - cSwarmCount - cSideCount);
      const wsInfo = normalizeWorkspaceBucket(
        c.workspaceUri || findTrajectoryCacheEntry(c.cascadeId, cacheStore)?.workspaceUri || ''
      );
      return {
        cascadeId: c.cascadeId,
        title: c.title,
        ...(c.swarmTitle ? { swarmTitle: c.swarmTitle } : {}),
        ...(wsInfo ? { workspaceName: wsInfo.label, workspacePath: wsInfo.workspacePath } : {}),
        stepCount: c.stepCount,
        subagentCount: c.subagentCount || 0,
        swarmCount: cSwarmCount,
        normalSubagentCount: cNormalSubCount,
        sideQuestionCount: cSideCount,
        runningSubagentCount: runningSubCount,
        totalStepCount: c.totalStepCount || c.stepCount || 0,
        ...(rawSubs.length > 0 ? { memberCascadeIds: rawSubs.map((s) => s.cascadeId) } : {}),
        isRunning: isConvRunning,
        status: c.status,
        lastModifiedTime: c.lastModifiedTime,
        lastModifiedMs: c.groupLastModifiedMs || c.lastModifiedMs,
        ...(qStats
          ? {
              modelShort: qStats.modelShort,
              modelUpstream: qStats.modelUpstream,
              latestTokPerSec: qStats.latestTokPerSec,
              contextUsedPct: qStats.contextUsedPct,
              sessionCostUsd: qStats.sessionCostUsd,
              sessionUnpricedCalls: qStats.sessionUnpricedCalls,
            }
          : {}),
      };
    }),
    activeConversation: assembledActiveConversation,
    consumption: {
      revision: usageRevision,
      selectedRange: {
        key: selectedWindow.key,
        ...(selectedWindow.pool ? { pool: selectedWindow.pool } : {}),
        ...(selectedWindow.poolLabel ? { poolLabel: selectedWindow.poolLabel } : {}),
        ...(selectedWindow.isFallbackWeek ? { isFallbackWeek: true } : {}),
        label: selectedWindow.label,
        startMs: trendStartMs,
        endMs: trendEndMs,
      },
      session: finalizedSelectedSession,
      account: finalizedSelectedAccount,
      presets: finalizedPresets,
      trendSeries,
      sourcesBreakdown,
      topConversations: enrichTopConversationTitles(topConversations, conversations),
      topWorkspaces: enrichTopWorkspaces(topWorkspaces, conversations),
      monthlyYear: currentYear,
      monthlySeries,
    },
    quotas: {
      meta: {
        fetchedAtMs: officialQuotaInfo?.fetchedAtMs || 0,
        hasOfficialData: Boolean(officialQuotaInfo?.data),
        isStale: Boolean(officialQuotaInfo?.isStale),
        refreshFailed: Boolean(officialQuotaInfo?.refreshFailed),
        error: officialQuotaInfo?.error || null,
        errorMessage: officialQuotaInfo?.error || null,
      },
      activePool: activePoolQuota,
      pools: sortedQuotaPools,
      weekly: weeklyQuota,
      weeklyCapacityEstimate,
    },
    ...(!isRemote ? { cacheRebuild: getLocalCacheRebuildStatus() } : {}),
    modelBreakdown,
  };

  const endpointSig = isRemote
    ? `${Number(endpoint?.instanceId || 0)}|${String(endpoint?.baseUrl || '')}|${String(endpoint?.csrfToken || '')}`
    : String(lsRuntimeEndpoint.addr || '');
  if (isRemote || buildGeneration === getLocalRebuildGeneration()) {
    lastCompletedTelemetrySnapshotsByEndpoint.delete(endpointId);
    if (lastCompletedTelemetrySnapshotsByEndpoint.size >= MAX_TELEMETRY_SNAPSHOT_ENDPOINTS) {
      const oldestKey = lastCompletedTelemetrySnapshotsByEndpoint.keys().next().value;
      if (oldestKey !== undefined) {
        lastCompletedTelemetrySnapshotsByEndpoint.delete(oldestKey);
      }
    }
    lastCompletedTelemetrySnapshotsByEndpoint.set(endpointId, {
      endpointId,
      isRemote,
      endpointSig,
      weeklyLimitMode: settings.weeklyLimitMode,
      weeklyTokenBudget: settings.weeklyTokenBudget,
      weeklyCostBudget: settings.weeklyCostBudget,
      catalogRevision: modelInputs.catalogRevision,
      phaseEpoch: modelInputs.phaseEpoch,
      basePayload: finalPayload,
      deferredCascadeIds: deferredCascadeIds instanceof Set ? deferredCascadeIds : null,
      sessions: {
        conversations,
      },
      knownUpstreamByModelKey,
      quotaContext: {
        quotaPoolsMap,
        isCustomWeeklyMode,
        weekBucket,
        quotaWeekBucket,
        poolsWeeklySummary,
      },
      aggContext: {
        cycleAnchors,
        isCustomWeeklyMode,
        currentAccountName: accountScope,
        activeCascadeId,
        activeFamilyCascadeIds,
        resolveStepModel,
        quotaPoolsMap,
        modelInputs,
        endpoint,
      },
    });

    if (!isRemote && lsRuntimeEndpoint.addr !== 'test.invalid') {
      try {
        saveJson(CLI_STATUS_SNAPSHOT_FILE, buildCliStatusSnapshot(finalPayload, Date.now()));
      } catch {
        // 快照落盘属于旁路辅助能力，任何异常绝不阻断主遥测响应
      }
    }
  }

  return finalPayload;
}

function resolveValidFastSnapshot(endpoint = null) {
  const isRemote = Boolean(endpoint?.isRemote);
  const endpointId = isRemote ? String(endpoint.id || 'remote') : LOCAL_ENDPOINT_ID;
  const snap = lastCompletedTelemetrySnapshotsByEndpoint.get(endpointId);
  if (!snap || !snap.basePayload || !snap.aggContext) return null;
  const expectedSig = isRemote
    ? `${Number(endpoint?.instanceId || 0)}|${String(endpoint?.baseUrl || '')}|${String(endpoint?.csrfToken || '')}`
    : String(lsRuntimeEndpoint.addr || '');
  if (snap.endpointSig !== expectedSig) return null;
  if (
    snap.catalogRevision !== pricingCatalogRevision ||
    snap.phaseEpoch !== getPricingPhaseEpoch()
  ) {
    return null;
  }
  const latestSettings = loadSettings();
  if (
    latestSettings.weeklyLimitMode !== snap.weeklyLimitMode ||
    latestSettings.weeklyTokenBudget !== snap.weeklyTokenBudget ||
    latestSettings.weeklyCostBudget !== snap.weeklyCostBudget
  ) {
    return null;
  }
  return snap;
}

function entryNeedsLazyTelemetryUpgrade(entry) {
  if (!entry || entry.archived || !Array.isArray(entry.steps) || entry.steps.length === 0) {
    return false;
  }
  const grpVer = Number(entry.contextGroupsTelemetry || 0);
  const needsUndoCtxUpgrade =
    grpVer < 2 || (grpVer === 2 && !entry.steps.some((st) => Boolean(st?.contextBreakdown)));
  return (
    !entry.turnRailTelemetry ||
    !entry.anomalyTelemetry ||
    needsUndoCtxUpgrade
  );
}

function tryBuildFastConversationPayload(requestedConvId, filterOpts = {}) {
  const endpoint = filterOpts?.endpoint && filterOpts.endpoint.isRemote ? filterOpts.endpoint : null;
  const endpointId = endpoint ? String(endpoint.id || 'remote') : LOCAL_ENDPOINT_ID;
  const cacheStore = getEndpointCacheStore(endpoint);
  const snap = resolveValidFastSnapshot(endpoint);
  if (!snap || !Array.isArray(snap.sessions?.conversations)) return null;

  const convList = snap.sessions.conversations;
  const reqLower = String(requestedConvId || '').trim().toLowerCase();
  const activeConvSummary = reqLower
    ? convList.find((c) => String(c?.cascadeId || '').toLowerCase() === reqLower) ||
      convList.find((c) =>
        (c?.subagents || []).some((s) => String(s?.cascadeId || '').toLowerCase() === reqLower)
      ) ||
      null
    : convList[0] || null;
  if (!activeConvSummary?.cascadeId) return null;

  const activeCascadeId = activeConvSummary.cascadeId;
  if (
    snap.deferredCascadeIds instanceof Set &&
    (snap.deferredCascadeIds.has(String(activeCascadeId).toLowerCase()) ||
      (reqLower && snap.deferredCascadeIds.has(reqLower)))
  ) {
    return null;
  }
  const activeEntry = findTrajectoryCacheEntry(activeCascadeId, cacheStore, { hydrate: true });
  if (!activeEntry) return null;

  const subagentSummaries = Array.isArray(activeConvSummary.subagents)
    ? activeConvSummary.subagents
    : [];
  let needsBackgroundSync =
    activeConvSummary.status === 'CASCADE_RUN_STATUS_RUNNING' ||
    entryNeedsLazyTelemetryUpgrade(activeEntry);
  if (!needsBackgroundSync) {
    for (const subSum of subagentSummaries) {
      if (subSum?.status === 'CASCADE_RUN_STATUS_RUNNING') {
        needsBackgroundSync = true;
        break;
      }
      const subEntry = findTrajectoryCacheEntry(subSum?.cascadeId, cacheStore, { hydrate: true });
      if (!subEntry || entryNeedsLazyTelemetryUpgrade(subEntry)) {
        needsBackgroundSync = true;
        break;
      }
    }
  }

  const settings = loadSettings();
  const {
    activeConversation,
    activeFamilyCascadeIds,
    latestFamilyStep,
  } = buildActiveConversationAssembly({
    activeCascadeId,
    activeConvSummary,
    activeEntry,
    resolveStepModel: snap.aggContext.resolveStepModel,
    knownUpstreamByModelKey: snap.knownUpstreamByModelKey,
    modelInputs: snap.aggContext.modelInputs,
    accountScope: snap.aggContext.currentAccountName,
    endpointId,
    cacheStore,
  });

  const { activePoolKey, activeLive5h, activeLiveWeekly } = resolveActivePoolKeyFromStep(
    latestFamilyStep,
    snap.quotaContext.quotaPoolsMap
  );
  const { activePoolQuota, weeklyQuota } = buildActivePoolAndWeeklyQuotas({
    activePoolKey,
    activeLive5h,
    activeLiveWeekly,
    quotaPoolsMap: snap.quotaContext.quotaPoolsMap,
    isCustomWeeklyMode: snap.quotaContext.isCustomWeeklyMode,
    settings,
    weekBucket: snap.quotaContext.weekBucket,
    quotaWeekBucket: snap.quotaContext.quotaWeekBucket,
    poolsWeeklySummary: snap.quotaContext.poolsWeeklySummary,
  });

  const sessionUsage = aggregateSessionUsageForFamily({
    filterOpts,
    cycleAnchors: snap.aggContext.cycleAnchors,
    isCustomWeeklyMode: snap.aggContext.isCustomWeeklyMode,
    currentAccountName: snap.aggContext.currentAccountName,
    activeCascadeId,
    activeFamilyCascadeIds,
    resolveStepModel: snap.aggContext.resolveStepModel,
    quotaPoolsMap: snap.quotaContext.quotaPoolsMap,
    endpoint,
  });

  return {
    scope: 'conversation',
    timestamp: new Date().toISOString(),
    endpoint: snap.basePayload.endpoint,
    uiBundleVersion: snap.basePayload.uiBundleVersion || computeRuntimeCodeVersion(),
    account: snap.basePayload.account,
    activeCascadeId,
    activeConversation,
    quotas: {
      activePool: activePoolQuota,
      weekly: weeklyQuota,
      weeklyCapacityEstimate: snap.basePayload.quotas?.weeklyCapacityEstimate || null,
    },
    consumption: {
      session: sessionUsage.finalizedSelectedSession,
      sessionPresets: sessionUsage.sessionPresets,
    },
    needsBackgroundSync,
  };
}

function buildWeeklyCapacityEstimate({
  sortedPools = [],
  isCustomWeeklyMode = false,
  hasOfficialData = false,
} = {}) {
  if (isCustomWeeklyMode) {
    return {
      status: 'custom_mode',
      totalEqWeeklyUsd: null,
      totalEqWeeklyTokens: null,
      readyPoolCount: 0,
      totalPoolCount: 0,
      hasPreliminary: false,
      pools: [],
    };
  }
  const rawPools = Array.isArray(sortedPools) ? sortedPools : [];
  const candidatePools = rawPools.filter(
    (p) =>
      p &&
      (p.hasWeekly ||
        p.weeklyUsedPct != null ||
        Number.isFinite(p.rateEstimate?.eqFullWeeklyUsd))
  );
  const targetPools = candidatePools.length > 0 ? candidatePools : rawPools;
  if (!hasOfficialData && targetPools.length === 0) {
    return {
      status: 'unavailable',
      totalEqWeeklyUsd: null,
      totalEqWeeklyTokens: null,
      readyPoolCount: 0,
      totalPoolCount: 0,
      hasPreliminary: false,
      pools: [],
    };
  }

  let sumUsd = 0;
  let sumTokens = 0;
  let readyPoolCount = 0;
  let tokenReadyPoolCount = 0;
  let hasPreliminary = false;
  const pools = [];

  for (const p of targetPools) {
    const est = p?.rateEstimate && typeof p.rateEstimate === 'object' ? p.rateEstimate : null;
    let eqUsd =
      Number.isFinite(est?.eqFullWeeklyUsd) && est.eqFullWeeklyUsd > 0
        ? Number(est.eqFullWeeklyUsd)
        : null;
    let eqTok =
      Number.isFinite(est?.eqFullWeeklyTokens) && est.eqFullWeeklyTokens > 0
        ? Math.round(Number(est.eqFullWeeklyTokens))
        : null;
    if (eqUsd === null && Array.isArray(est?.models) && est.models.length > 0) {
      const wkModels = est.models.filter(
        (m) => Number.isFinite(m?.eqFullWeeklyUsd) && m.eqFullWeeklyUsd > 0
      );
      if (wkModels.length > 0) {
        eqUsd =
          wkModels.reduce((acc, m) => acc + Number(m.eqFullWeeklyUsd), 0) / wkModels.length;
        const tokModels = wkModels.filter(
          (m) => Number.isFinite(m?.eqFullWeeklyTokens) && m.eqFullWeeklyTokens > 0
        );
        if (tokModels.length === wkModels.length) {
          eqTok = Math.round(
            tokModels.reduce((acc, m) => acc + Number(m.eqFullWeeklyTokens), 0) / tokModels.length
          );
        }
      }
    }

    const isPrelim = Boolean(est?.isPreliminaryWeekly);
    if (eqUsd !== null) {
      readyPoolCount += 1;
      sumUsd += eqUsd;
      if (isPrelim) hasPreliminary = true;
      if (eqTok !== null) {
        tokenReadyPoolCount += 1;
        sumTokens += eqTok;
      }
    }

    pools.push({
      poolKey: p.poolKey || p.family || '',
      poolLabel: p.poolLabel || p.family || p.poolKey || 'Pool',
      usedWeeklyPct: Number.isFinite(Number(p.weeklyUsedPct)) ? +Number(p.weeklyUsedPct).toFixed(1) : null,
      eqFullWeeklyUsd: eqUsd !== null ? +eqUsd.toFixed(1) : null,
      eqFullWeeklyTokens: eqTok,
      source: est?.sourceWeekly || null,
      isPreliminary: isPrelim,
    });
  }

  const totalPoolCount = pools.length;
  const status =
    readyPoolCount === 0
      ? 'collecting'
      : readyPoolCount < totalPoolCount
        ? 'partial'
        : 'ready';

  return {
    status,
    totalEqWeeklyUsd: readyPoolCount > 0 ? +sumUsd.toFixed(1) : null,
    totalEqWeeklyTokens:
      readyPoolCount > 0 && tokenReadyPoolCount === readyPoolCount ? Math.round(sumTokens) : null,
    readyPoolCount,
    totalPoolCount,
    hasPreliminary,
    pools,
  };
}

function enrichTopConversationTitles(topList, convSummaries) {
  if (!Array.isArray(topList) || topList.length === 0) return [];
  const titleMap = new Map();
  if (Array.isArray(convSummaries)) {
    for (const c of convSummaries) {
      const cid = String(c?.cascadeId || '').toLowerCase();
      const title = String(c?.title || '').trim();
      if (cid && title && !titleMap.has(cid)) {
        titleMap.set(cid, title);
      }
      if (Array.isArray(c?.subagents)) {
        for (const sub of c.subagents) {
          const sid = String(sub?.cascadeId || '').toLowerCase();
          if (sid && title && !titleMap.has(sid)) {
            titleMap.set(sid, title);
          }
        }
      }
    }
  }
  return topList.map((item) => {
    if (!item || typeof item !== 'object') return item;
    const cidLower = String(item.cascadeId || '').toLowerCase();
    const fallbackTitle = titleMap.get(cidLower) || '';
    const existingTitle = String(item.title || '').trim();
    const resolvedTitle = existingTitle || fallbackTitle || (item.cascadeId ? item.cascadeId.slice(0, 8) : '—');
    return {
      ...item,
      title: resolvedTitle,
      canJump: titleMap.has(cidLower),
    };
  });
}

function enrichTopWorkspaces(wsList, convSummaries) {
  if (!Array.isArray(wsList) || wsList.length === 0) return [];
  const jumpableIds = new Set();
  if (Array.isArray(convSummaries)) {
    for (const c of convSummaries) {
      const cid = String(c?.cascadeId || '').toLowerCase();
      if (cid) jumpableIds.add(cid);
    }
  }
  return wsList.map((item) => {
    if (!item || typeof item !== 'object') return item;
    const latestCid = String(item.latestCascadeId || '').toLowerCase();
    return {
      ...item,
      canJump: Boolean(latestCid && (jumpableIds.size === 0 || jumpableIds.has(latestCid))),
    };
  });
}

function tryBuildFastConsumptionPayload(filterOpts = {}) {
  const endpoint = filterOpts?.endpoint && filterOpts.endpoint.isRemote ? filterOpts.endpoint : null;
  const snap = resolveValidFastSnapshot(endpoint);
  if (!snap) return null;
  const agg = aggregateSelectedWindowUsage({
    filterOpts,
    ...snap.aggContext,
    endpoint,
  });
  return {
    scope: 'consumption',
    timestamp: new Date().toISOString(),
    endpoint: snap.basePayload.endpoint,
    uiBundleVersion: snap.basePayload.uiBundleVersion || computeRuntimeCodeVersion(),
    usageRevision: agg.usageRevision,
    consumption: {
      revision: agg.usageRevision,
      selectedRange: {
        key: agg.selectedWindow.key,
        ...(agg.selectedWindow.pool ? { pool: agg.selectedWindow.pool } : {}),
        ...(agg.selectedWindow.poolLabel ? { poolLabel: agg.selectedWindow.poolLabel } : {}),
        ...(agg.selectedWindow.isFallbackWeek ? { isFallbackWeek: true } : {}),
        label: agg.selectedWindow.label,
        startMs: agg.trendStartMs,
        endMs: agg.trendEndMs,
      },
      session: agg.finalizedSelectedSession,
      account: agg.finalizedSelectedAccount,
      trendSeries: agg.trendSeries,
      sourcesBreakdown: agg.sourcesBreakdown,
      topConversations: enrichTopConversationTitles(
        agg.topConversations,
        snap.sessions?.conversations
      ),
      topWorkspaces: enrichTopWorkspaces(agg.topWorkspaces, snap.sessions?.conversations),
    },
    modelBreakdown: agg.modelBreakdown,
  };
}

function tryBuildConsumptionPresetsPayload(filterOpts = {}) {
  const endpoint = filterOpts?.endpoint && filterOpts.endpoint.isRemote ? filterOpts.endpoint : null;
  const snap = resolveValidFastSnapshot(endpoint);
  if (!snap) return null;
  const bundle = aggregateConsumptionPresetBundle({
    ...snap.aggContext,
    endpoint,
  });
  const enrichedRanges = {};
  for (const [rangeKey, entry] of Object.entries(bundle.ranges || {})) {
    enrichedRanges[rangeKey] = {
      ...entry,
      topConversations: enrichTopConversationTitles(
        entry?.topConversations,
        snap.sessions?.conversations
      ),
      topWorkspaces: enrichTopWorkspaces(entry?.topWorkspaces, snap.sessions?.conversations),
    };
  }
  return {
    scope: 'consumption-presets',
    timestamp: new Date().toISOString(),
    endpoint: snap.basePayload.endpoint,
    uiBundleVersion: snap.basePayload.uiBundleVersion || computeRuntimeCodeVersion(),
    usageRevision: bundle.usageRevision,
    ranges: enrichedRanges,
  };
}

export function buildCliStatusSnapshot(finalPayload, updatedAtMs = Date.now()) {
  const ac = finalPayload?.activeConversation || {};
  const capSource = ac.aggregated || ac;
  const ctx = ac.context || {};
  const limitTok = Number(ctx.compactionLimitTokens || ctx.limitTokens || 256000);
  const totalTok = Number(ctx.totalTokens || 0);
  const usedPctVal =
    limitTok > 0 ? Math.min(100, +((totalTok / limitTok) * 100).toFixed(1)) : 0;

  const runningList = Array.isArray(finalPayload?.runningConversations)
    ? finalPayload.runningConversations
    : [];
  const activeSteps = Array.isArray(ac.recentSteps) ? ac.recentSteps : [];
  let sessionAnomalyCount = 0;
  let latestAnomaly = null;
  for (let i = 0; i < activeSteps.length; i += 1) {
    const a = activeSteps[i]?.anomaly;
    if (a && Number(a.count) > 0) {
      sessionAnomalyCount += Number(a.count);
    }
  }
  const lastStepAnomaly = activeSteps.length > 0 ? activeSteps[activeSteps.length - 1]?.anomaly : null;
  if (lastStepAnomaly && Number(lastStepAnomaly.count) > 0) {
    latestAnomaly = {
      primaryKind: String(lastStepAnomaly.primaryKind || 'error'),
      count: Number(lastStepAnomaly.count),
      severity: lastStepAnomaly.severity === 'danger' ? 'danger' : 'warn',
      totalDelaySec: Number(lastStepAnomaly.totalDelaySec || 0),
    };
  }

  const waitingCascadeIds = runningList
    .filter(
      (item) =>
        item?.mainActivity?.phase === 'waiting' ||
        (Array.isArray(item?.subagents) &&
          item.subagents.some((sub) => sub?.isRunning && sub?.liveActivity?.phase === 'waiting'))
    )
    .map((item) => String(item?.cascadeId || '').toLowerCase())
    .filter(Boolean);

  return {
    updatedAtMs,
    runningCount: runningList.length,
    runningSubCount: runningList.reduce(
      (acc, item) => acc + Number(item?.runningSubagentCount || 0),
      0
    ),
    hasWaiting: waitingCascadeIds.length > 0,
    waitingCascadeIds,
    quotas: finalPayload?.quotas || null,
    activeConversation: {
      cascadeId: ac.cascadeId || '',
      isRunning: Boolean(capSource.isRunning || ac.isRunning),
      stepCount: Number(capSource.stepCount ?? ac.stepCount ?? 0),
      usedPct: usedPctVal,
      latestTokPerSec: capSource.latestTokPerSec ?? ac.latestTokPerSec ?? null,
      avgTokPerSec: capSource.avgTokPerSec ?? ac.avgTokPerSec ?? null,
      latestTtftSec: capSource.latestTtftSec ?? ac.latestTtftSec ?? null,
      lastKnownTtftSec: capSource.lastKnownTtftSec ?? ac.lastKnownTtftSec ?? null,
      latestStepCostUsd: capSource.latestStepCostUsd ?? ac.latestStepCostUsd ?? null,
      sessionCostUsd: capSource.sessionCostUsd ?? ac.sessionCostUsd ?? null,
      latestCacheHitPct: capSource.latestCacheHitPct ?? ac.latestCacheHitPct ?? null,
      latestPromptTokens: Number(capSource.latestPromptTokens ?? ac.latestPromptTokens ?? 0),
      totalTokens: Number(capSource.totalTokens ?? ac.totalTokens ?? 0),
      ...(latestAnomaly ? { latestAnomaly } : {}),
      ...(sessionAnomalyCount > 0 ? { sessionAnomalyCount } : {}),
    },
  };
}

/**
 * 带并发请求合并（In-Flight Deduplication）的遥测载荷构建入口。
 *
 * @param {string} requestedConvId
 * @param {boolean} [forceQuotaRefresh=false]
 * @param {{ range?: string, startMs?: number, endMs?: number, scope?: string }} [filterOpts={}]
 * @returns {Promise<object>}
 */
export function buildTelemetryPayload(
  requestedConvId,
  forceQuotaRefresh = false,
  filterOpts = {}
) {
  const endpointKey = filterOpts?.endpoint?.isRemote
    ? String(filterOpts.endpoint.id || 'remote')
    : LOCAL_ENDPOINT_ID;
  if (!forceQuotaRefresh) {
    if (filterOpts?.scope === 'conversation') {
      const convPayload = tryBuildFastConversationPayload(requestedConvId, filterOpts);
      if (convPayload) {
        return Promise.resolve(convPayload);
      }
    }
    if (filterOpts?.scope === 'consumption-presets') {
      const presetsPayload = tryBuildConsumptionPresetsPayload(filterOpts);
      if (presetsPayload) {
        return Promise.resolve(presetsPayload);
      }
      const key = `${endpointKey}::${requestedConvId || '__auto__'}::presets-cold`;
      if (inFlightRequests.has(key)) {
        return inFlightRequests.get(key);
      }
      const coldFilterOpts = filterOpts?.endpoint
        ? { range: 'today', endpoint: filterOpts.endpoint }
        : { range: 'today' };
      const p = buildTelemetryPayloadInternal(requestedConvId, false, coldFilterOpts)
        .then(() => tryBuildConsumptionPresetsPayload(filterOpts))
        .finally(() => {
          inFlightRequests.delete(key);
        });
      inFlightRequests.set(key, p);
      return p;
    }
    if (filterOpts?.scope === 'consumption') {
      const litePayload = tryBuildFastConsumptionPayload(filterOpts);
      if (litePayload) {
        return Promise.resolve(litePayload);
      }
    }
  }
  const rangeSig = `${filterOpts.range || 'all'}:${filterOpts.pool || 'all'}:${filterOpts.startMs || 0}:${filterOpts.endMs || 0}`;
  const key = `${endpointKey}::${requestedConvId || '__auto__'}::${forceQuotaRefresh ? 'force' : 'normal'}::${rangeSig}`;
  if (inFlightRequests.has(key)) {
    return inFlightRequests.get(key);
  }
  const p = buildTelemetryPayloadInternal(requestedConvId, forceQuotaRefresh, filterOpts).finally(
    () => {
      inFlightRequests.delete(key);
    }
  );
  inFlightRequests.set(key, p);
  return p;
}
