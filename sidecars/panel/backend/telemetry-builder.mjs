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
  lsRuntimeEndpoint,
  roundMetric,
  saveJson,
} from './config.mjs';
import { getEndpointCacheStore } from './endpoint-registry.mjs';
import { getContextWindowGroups, getContextWindowModels } from './context-windows.mjs';
import { readLocalSummarySnapshot } from './cli-sqlite-reader.mjs';
import { enumerateAndSyncConversations } from './local-scanner.mjs';
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
import { buildOfficialQuotaPools } from './quota-pools.mjs';
import { getDefaultWindowBridgeStatus } from './window-bridge.mjs';
import {
  aggregateConsumptionPresetBundle,
  aggregateMultiWindowUsage,
  aggregateSelectedWindowUsage,
  aggregateSessionUsageForFamily,
  buildScopedModelBreakdown,
  clearUsageAggregatorMemo,
  getNextMondayResetIso,
} from './usage-aggregator.mjs';

const MAX_RECENT_CONVERSATIONS = 30;
const MAX_CONVERSATION_ASSEMBLY_CACHE = 8;
const MAX_TELEMETRY_SNAPSHOT_ENDPOINTS = 8;
const POOL_PRIORITY_ORDER = ['Gemini', 'Argon', 'Carbon', 'Claude & GPT'];
const inFlightTelemetrySources = new Map();
const trajectoryModelFacts = new WeakMap();
let agentStepPrepCache = new WeakMap();
const conversationAssemblyCache = new Map();
const lastCompletedTelemetrySnapshotsByEndpoint = new Map();

export function clearTelemetryBuilderMemo(endpointId = null) {
  if (endpointId) {
    const epKey = String(endpointId);
    lastCompletedTelemetrySnapshotsByEndpoint.delete(epKey);
    const prefix = `${epKey}::`;
    for (const key of Array.from(conversationAssemblyCache.keys())) {
      if (key.startsWith(prefix)) {
        conversationAssemblyCache.delete(key);
      }
    }
    clearUsageAggregatorMemo(epKey);
    return;
  }
  agentStepPrepCache = new WeakMap();
  conversationAssemblyCache.clear();
  lastCompletedTelemetrySnapshotsByEndpoint.clear();
  clearUsageAggregatorMemo();
}

function roundSessionCost(val) {
  if (!Number.isFinite(val) || val <= 0) return 0;
  return val < 0.01 ? +val.toFixed(4) : +val.toFixed(2);
}

function findTrajectoryCacheEntry(cascadeId, cacheStore = null) {
  if (!cascadeId) return null;
  const store = cacheStore || getEndpointCacheStore(null);
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
    if (!step?.isCompactionStep && step?.reportedContextLimitTokens > 0) {
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
    const outCostUsd = mInfo.pricing ? (st.outputTokens / 1_000_000) * mInfo.pricing.output : null;
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

  // 关联每轮用户提问摘要与最新轮次标识，供步骤表极简导轨与气泡展示
  let maxTurnIndex = 0;
  const promptByTurn = new Map();
  const mediaByTurn = new Map();
  for (const st of enrichedActiveSteps) {
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
  const sessionAvgTokPerSec = roundMetric(sessionSpeed.avgTokPerSec);

  return {
    enrichedActiveSteps,
    latestEnriched,
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
  sessionCacheReadTokens
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
    }
    channels.userInput = 0;
    channels.assistant = 0;
    channels.toolResults = 0;
    channels.subagent = 0;
    channels.checkpoint = resolveCompactionSummaryTokens(compactionStep);

    let runningTotal = CONTEXT_CHANNEL_KEYS.reduce((sum, k) => sum + channels[k], 0);
    for (let m = lastCompactionIdx + 1; m < enrichedActiveSteps.length; m++) {
      const stepM = enrichedActiveSteps[m];
      if (!stepM || stepM.isCompactionStep) continue;
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

  const isLatestCompaction = Boolean(latestEnriched?.isCompactionStep);
  const ctxCached = latestEnriched?.cacheReadTokens || 0;
  const ctxFreshInput = latestEnriched?.inputTokens || 0;
  const ctxThinking = latestEnriched?.thinkingTokens || 0;
  const ctxResponse = latestEnriched?.responseTokens || 0;
  const ctxOut = resolveStepOutputTokens(latestEnriched);
  const ctxTotal = isLatestCompaction
    ? ctxBreakdownTotal
    : ctxBreakdownTotal > 0
      ? ctxBreakdownTotal
      : ctxCached + ctxFreshInput + ctxOut;
  const compactionLimitTokens = Number(
    (isLatestCompaction && !latestEnriched?.reportedContextLimitTokens && fallbackPreCompactionLimit > 0
      ? fallbackPreCompactionLimit
      : latestEnriched?.maxContextBudgetTokens) || 256000
  );
  const compactionUsedTokens = isLatestCompaction
    ? Number(ctxTotal)
    : Number(ctxTotal || latestEnriched?.estimatedContextTokens || ctxCached + ctxFreshInput);
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

function prepareAgentSteps(rawSteps, resolveStepModel, upstream, agentFields, reuseInputs) {
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
      sameFallbackUpstreams(previous.fallbackUpstreams, facts.fallbackModelKeys, upstream)
    ) {
      return previous.prepared;
    }
  }
  const enrichedRes = enrichActiveConversationSteps(rawSteps, resolveStepModel, upstream, agentFields);
  const taggedSteps = enrichedRes.enrichedActiveSteps;
  const prepared = {
    enrichedRes,
    recentSteps: taggedSteps.slice().reverse(),
    ctxRes: extractActiveContextTelemetry(taggedSteps, enrichedRes.latestEnriched,
      enrichedRes.sessionInputTokens, enrichedRes.sessionCacheReadTokens),
    modelBreakdown: buildScopedModelBreakdown(taggedSteps, resolveStepModel),
  };
  // 按 rawSteps 数组引用缓存各代理（含多代理子代理）步骤富化结果，步骤变更后由 WeakMap 自动淘汰。
  if (canCache) {
    agentStepPrepCache.set(rawSteps, {
      agentFields,
      catalogRevision: reuseInputs.catalogRevision,
      phaseEpoch: reuseInputs.phaseEpoch,
      dynamicModelMap: reuseInputs.dynamicModelMap,
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
    reuseInputs
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
  endpoint = null
) {
  const isRemote = Boolean(endpoint && endpoint.isRemote);
  const localSummaries = isRemote
    ? { available: false, summariesObj: {}, sideQuestionParents: {} }
    : readLocalSummarySnapshot(undefined, { forceRefresh: forceQuotaRefresh });
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
    summariesAvailable: localSummaries.available || Boolean(allTrajRes?.trajectorySummaries),
    sideQuestionParents: localSummaries.available ? localSummaries.sideQuestionParents : {},
    currentAccountName: accountScope,
    requestedConvId,
    forceRefresh: forceQuotaRefresh,
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
  endpoint = null
) {
  const endpointKey = endpoint?.isRemote ? String(endpoint.id || 'remote') : LOCAL_ENDPOINT_ID;
  const read = () => readTelemetrySources(
    requestedConvId, forceQuotaRefresh, currentAccountName, accountScope, userStatus, endpoint
  );
  if (forceQuotaRefresh) return read();
  const key = JSON.stringify([endpointKey, requestedConvId || '', accountScope, Boolean(userStatus)]);
  const existing = inFlightTelemetrySources.get(key);
  if (existing) return existing;
  const pending = read().finally(() => {
    inFlightTelemetrySources.delete(key);
  });
  inFlightTelemetrySources.set(key, pending);
  return pending;
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
    findTrajectoryCacheEntry(subSum.cascadeId, cacheStore)
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

  const assemblyMetaSig = JSON.stringify([
    activeCascadeId || '',
    activeConvSummary?.title || '',
    activeConvSummary?.swarmTitle || '',
    activeConvSummary?.status || 'IDLE',
    activeConvSummary?.lastModifiedMs || activeEntry?.lastModifiedMs || 0,
    activeConvSummary?.liveActivity?.signature || '',
    activeConvSummary?.liveActivity?.startedAtMs || 0,
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

  let normalSubCount = 0;
  let swarmWorkerCount = 0;
  let sideQuestionCount = 0;
  for (let idx = 0; idx < subagentSummaries.length; idx++) {
    const subSum = subagentSummaries[idx];
    const subCid = subSum.cascadeId;
    activeFamilyCascadeIds.add(String(subCid || '').toLowerCase());
    const subEntry = subEntries[idx];
    const subRawSteps = subRawStepsList[idx];
    for (const step of subRawSteps) allCombinedRawSteps.push(step);

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
    let typeName = '';
    let agentLabel = '';
    if (isSideQ) {
      sideIndex = ++sideQuestionCount;
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
      typeName = 'side_question';
      agentLabel = cleanSideRole ? `${shortLabel} · ${cleanSideRole}` : shortLabel;
    } else if (isSwarmW) {
      const swOrd = ++swarmWorkerCount;
      agentKind = 'swarm_worker';
      agentOrdinal = swOrd;
      const memberTag = parsedSwarm.memberName ? `@${parsedSwarm.memberName}` : '';
      customRole = memberTag;
      shortLabel = `蜂群 #${swOrd}`;
      badgeText = `蜂${swOrd}`;
      roleLabel = memberTag || '蜂群';
      typeName = 'worker';
      agentLabel = memberTag ? `${shortLabel} · ${memberTag}` : shortLabel;
      swarmState = subSum.killed
        ? 'killed'
        : subSum.status === 'CASCADE_RUN_STATUS_RUNNING'
          ? 'working'
          : subSum.swarmState || 'waiting';
      isSwarmAuxiliary = Boolean(subSum.isSwarmAuxiliary || parsedSwarm.isAuxiliary);
    } else {
      const subOrd = ++normalSubCount;
      agentKind = 'subagent';
      agentOrdinal = subOrd;
      customRole = rawRole && rawRole !== '子代理' && rawRole !== 'Subagent' ? rawRole : '';
      shortLabel = `子代理 #${subOrd}`;
      badgeText = `子${subOrd}`;
      roleLabel = rawRole || '子代理';
      typeName = subSpec?.typeName || '';
      agentLabel = rawRole ? `${shortLabel} · ${rawRole}` : shortLabel;
    }

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
    if (swarmWorkerCount > 0) roleSummaryParts.push(`${swarmWorkerCount} 蜂群`);
    if (normalSubCount > 0) roleSummaryParts.push(`${normalSubCount} 子代理`);
    if (sideQuestionCount > 0) {
      roleSummaryParts.push(
        roleSummaryParts.length > 0 ? `${sideQuestionCount} 旁问` : `${sideQuestionCount} 旁路提问`
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
    swarmCount: swarmWorkerCount,
    normalSubagentCount: normalSubCount,
    sideQuestionCount,
    totalStepsAllAgents: subAgentTelemetries.length
      ? allCombinedEnrichedSteps.length
      : enrichedActiveSteps.length,
    latestTokPerSec: latestEnriched?.tokPerSec ?? null,
    latestTtftSec: latestEnriched?.ttftSec ?? null,
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

  if (
    !conversationAssemblyCache.has(cacheKey) &&
    conversationAssemblyCache.size >= MAX_CONVERSATION_ASSEMBLY_CACHE
  ) {
    conversationAssemblyCache.delete(conversationAssemblyCache.keys().next().value);
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
    result,
  });

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
    resetTime: activeLive5h?.resetTime || null,
    weeklyRemainingPct: activeLiveWeekly?.remainingPct ?? null,
    weeklyRemainingIntPct: activeLiveWeekly?.remainingIntPct ?? null,
    weeklyUsedPct: activeLiveWeekly?.usedPct ?? null,
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
    requestedConvId, forceQuotaRefresh, currentAccountName, accountScope, userStatus, endpoint
  );
  const { conversations, activeConvSummary, activeCascadeId } = sessions;

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
  const activeEntry = findTrajectoryCacheEntry(activeCascadeId, cacheStore);
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

  const rawTierName = userStatus?.userTier?.name || '';
  const inferredPlanFallback = /\bfree\b/i.test(rawTierName)
    ? 'Free'
    : /\bultra\b/i.test(rawTierName)
      ? 'Ultra'
      : 'Pro';
  const resolvedPlanName = userStatus?.planStatus?.planInfo?.planName || inferredPlanFallback;

  // 预计算近期会话与运行中会话的轻量缓存速览指标（零额外 RPC 开销）
  const quickStatsMemo = new Map();
  const getConversationQuickStats = (rootConv) => {
    const cidKey = String(rootConv?.cascadeId || '').toLowerCase();
    if (cidKey && quickStatsMemo.has(cidKey)) {
      return quickStatsMemo.get(cidKey);
    }
    const rootEntry = findTrajectoryCacheEntry(rootConv?.cascadeId, cacheStore);
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
      contextUsedPct = extractActiveContextTelemetry(rootSteps, lastRootStep, 0, 0).context
        .compactionUsedPct;
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

    let runNormalSubIdx = 0;
    let runSwarmIdx = 0;
    let runSideIdx = 0;
    const subItems = rawSubs.map((subSum, idx) => {
      const subCid = subSum.cascadeId;
      const subEntry = findTrajectoryCacheEntry(subCid, cacheStore);
      const subSpec = subSum.subagentSpec || subEntry?.subagentSpec || null;
      const isSideQ = Boolean(
        subSum.isSideQuestion || subEntry?.isSideQuestion || subSpec?.typeName === 'side_question'
      );
      const rawRole =
        subSpec?.role ||
        subSum.agentScriptName ||
        subEntry?.agentScriptName ||
        subSpec?.typeName ||
        '';
      const parsedSwarm = !isSideQ
        ? parseSwarmWorkerRole({
            role: subSpec?.role || '',
            typeName: subSpec?.typeName || '',
            agentScriptName: subSum.agentScriptName || subEntry?.agentScriptName || '',
            memberName: subSum.swarmMemberName || '',
          })
        : { isSwarmWorker: false };
      const isSwarmW = Boolean(!isSideQ && (subSum.isSwarmWorker || parsedSwarm.isSwarmWorker));
      const subIndex = idx + 1;
      let sideIndex = 0;
      let agentKind = 'subagent';
      let agentOrdinal = 0;
      let customRole = '';
      let swarmState = '';
      let isSwarmAuxiliary = false;
      let badgeText = '';
      let shortLabel = '';
      let role = '';
      if (isSideQ) {
        sideIndex = ++runSideIdx;
        agentKind = 'side_question';
        agentOrdinal = sideIndex;
        badgeText = `旁${sideIndex}`;
        shortLabel = `旁路提问 #${sideIndex}`;
        const cleanSide =
          rawRole &&
          rawRole !== '旁路提问' &&
          rawRole !== 'Side Question' &&
          rawRole !== 'side_question'
            ? rawRole
            : '';
        customRole = cleanSide;
        role = cleanSide || shortLabel;
      } else if (isSwarmW) {
        const swOrd = ++runSwarmIdx;
        agentKind = 'swarm_worker';
        agentOrdinal = swOrd;
        const memberTag = parsedSwarm.memberName ? `@${parsedSwarm.memberName}` : '';
        customRole = memberTag;
        badgeText = `蜂${swOrd}`;
        shortLabel = `蜂群 #${swOrd}`;
        role = memberTag || shortLabel;
        isSwarmAuxiliary = Boolean(subSum.isSwarmAuxiliary || parsedSwarm.isAuxiliary);
      } else {
        const nOrd = ++runNormalSubIdx;
        agentKind = 'subagent';
        agentOrdinal = nOrd;
        customRole = rawRole && rawRole !== '子代理' && rawRole !== 'Subagent' ? rawRole : '';
        badgeText = `子${nOrd}`;
        shortLabel = `子代理 #${nOrd}`;
        role = rawRole || shortLabel;
      }
      const isSubRunning = subSum.status === 'CASCADE_RUN_STATUS_RUNNING';
      const isKilled = Boolean(subSum.killed || subSum.swarmState === 'killed');
      if (isSwarmW) {
        swarmState = isKilled ? 'killed' : isSubRunning ? 'working' : subSum.swarmState || 'waiting';
      }
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
      swarmCount: runSwarmIdx,
      normalSubagentCount: runNormalSubIdx,
      sideQuestionCount: runSideIdx,
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
    settings: loadSettings(),
    contextWindowModels: getContextWindowGroups(getContextWindowModels(clientConfigs, contextModelCatalog)).map((group) => {
      const latest = group.members.reduce((previous, id) => {
        const reported = reportedContextLimits.get(id);
        return reported && (!previous || reported.at > previous.at) ? reported : previous;
      }, null);
      return { ...group, reportedLimitTokens: latest?.tokens ?? null };
    }),
    cloudStatus: getCloudStatus(),
    account: {
      status: accountStatus,
      email: userStatus?.email || '',
      name: userStatus?.name || '',
      tierName: rawTierName || 'Google AI',
      planName: resolvedPlanName,
      aiCredits: realAiCredits > 0 ? realAiCredits : null,
      totalConversations: conversations.length,
    },
    runningConversations,
    conversations: conversations.slice(0, MAX_RECENT_CONVERSATIONS).map((c) => {
      const qStats = getConversationQuickStats(c);
      const rawSubs = Array.isArray(c.subagents) ? c.subagents : [];
      const runningSubCount = rawSubs.filter((s) => s.status === 'CASCADE_RUN_STATUS_RUNNING').length;
      const cSwarmCount = Number(c.swarmCount ?? rawSubs.filter((s) => s.isSwarmWorker).length);
      const cSideCount = rawSubs.filter((s) => s.isSideQuestion).length;
      const cNormalSubCount = Math.max(0, rawSubs.length - cSwarmCount - cSideCount);
      return {
        cascadeId: c.cascadeId,
        title: c.title,
        ...(c.swarmTitle ? { swarmTitle: c.swarmTitle } : {}),
        stepCount: c.stepCount,
        subagentCount: c.subagentCount || 0,
        swarmCount: cSwarmCount,
        normalSubagentCount: cNormalSubCount,
        sideQuestionCount: cSideCount,
        runningSubagentCount: runningSubCount,
        totalStepCount: c.totalStepCount || c.stepCount || 0,
        ...(rawSubs.length > 0 ? { memberCascadeIds: rawSubs.map((s) => s.cascadeId) } : {}),
        isRunning: c.status === 'CASCADE_RUN_STATUS_RUNNING' || runningSubCount > 0,
        status: c.status,
        lastModifiedTime: c.lastModifiedTime,
        lastModifiedMs: c.groupLastModifiedMs || c.lastModifiedMs,
        modelShort: qStats.modelShort,
        modelUpstream: qStats.modelUpstream,
        latestTokPerSec: qStats.latestTokPerSec,
        contextUsedPct: qStats.contextUsedPct,
        sessionCostUsd: qStats.sessionCostUsd,
        sessionUnpricedCalls: qStats.sessionUnpricedCalls,
      };
    }),
    activeConversation: assembledActiveConversation,
    consumption: {
      revision: usageRevision,
      selectedRange: {
        key: selectedWindow.key,
        label: selectedWindow.label,
        startMs: trendStartMs,
        endMs: trendEndMs,
      },
      session: finalizedSelectedSession,
      account: finalizedSelectedAccount,
      presets: finalizedPresets,
      trendSeries,
      sourcesBreakdown,
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
      pools: Array.from(quotaPoolsMap.values()).sort((a, b) => {
        const order = { Gemini: 0, Argon: 1, Carbon: 2, 'Claude & GPT': 3 };
        return (order[a.family] ?? 99) - (order[b.family] ?? 99);
      }),
      weekly: weeklyQuota,
    },
    modelBreakdown,
  };

  const endpointSig = isRemote
    ? `${Number(endpoint?.instanceId || 0)}|${String(endpoint?.baseUrl || '')}|${String(endpoint?.csrfToken || '')}`
    : String(lsRuntimeEndpoint.addr || '');
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
  if (!entry || !Array.isArray(entry.steps) || entry.steps.length === 0) return false;
  return (
    !entry.turnRailTelemetry ||
    !entry.anomalyTelemetry ||
    entry.contextGroupsTelemetry !== 2
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
  const activeEntry = findTrajectoryCacheEntry(activeCascadeId, cacheStore);
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
      const subEntry = findTrajectoryCacheEntry(subSum?.cascadeId, cacheStore);
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
    },
    consumption: {
      session: sessionUsage.finalizedSelectedSession,
      sessionPresets: sessionUsage.sessionPresets,
    },
    needsBackgroundSync,
  };
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
        label: agg.selectedWindow.label,
        startMs: agg.trendStartMs,
        endMs: agg.trendEndMs,
      },
      session: agg.finalizedSelectedSession,
      account: agg.finalizedSelectedAccount,
      trendSeries: agg.trendSeries,
      sourcesBreakdown: agg.sourcesBreakdown,
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
  return {
    scope: 'consumption-presets',
    timestamp: new Date().toISOString(),
    endpoint: snap.basePayload.endpoint,
    uiBundleVersion: snap.basePayload.uiBundleVersion || computeRuntimeCodeVersion(),
    usageRevision: bundle.usageRevision,
    ranges: bundle.ranges,
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

  return {
    updatedAtMs,
    runningCount: runningList.length,
    runningSubCount: runningList.reduce(
      (acc, item) => acc + Number(item?.runningSubagentCount || 0),
      0
    ),
    hasWaiting: runningList.some((item) => item?.mainActivity?.phase === 'waiting'),
    quotas: finalPayload?.quotas || null,
    activeConversation: {
      cascadeId: ac.cascadeId || '',
      isRunning: Boolean(capSource.isRunning || ac.isRunning),
      stepCount: Number(capSource.stepCount ?? ac.stepCount ?? 0),
      usedPct: usedPctVal,
      latestTokPerSec: capSource.latestTokPerSec ?? ac.latestTokPerSec ?? null,
      avgTokPerSec: capSource.avgTokPerSec ?? ac.avgTokPerSec ?? null,
      latestTtftSec: capSource.latestTtftSec ?? ac.latestTtftSec ?? null,
      latestStepCostUsd: capSource.latestStepCostUsd ?? ac.latestStepCostUsd ?? null,
      sessionCostUsd: capSource.sessionCostUsd ?? ac.sessionCostUsd ?? null,
      latestCacheHitPct: capSource.latestCacheHitPct ?? ac.latestCacheHitPct ?? null,
      latestPromptTokens: Number(capSource.latestPromptTokens ?? ac.latestPromptTokens ?? 0),
      totalTokens: Number(capSource.totalTokens ?? ac.totalTokens ?? 0),
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
  const rangeSig = `${filterOpts.range || 'all'}:${filterOpts.startMs || 0}:${filterOpts.endMs || 0}`;
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
