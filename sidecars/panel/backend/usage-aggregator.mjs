/**
 * @fileoverview 多时间窗口解析、用量桶累加、趋势序列、月度序列与分模型/分来源聚合引擎。
 *
 * 负责将内存缓存 (`trajectoryCache`) 与外部深层统计缓存 (`loadExternalDeepStatsCache`)
 * 中的所有步骤按预设窗口（`all`, `cycle`, `5h`, `today`, `24h`, `week`, `7d`, `14d`, `30d`）与当前选定窗口
 * 进行去重遍历聚合，输出前端消费分析与模型明细所需的完整统计结构。
 */

import { usageHistoryKey } from './config.mjs';
import { isDeepStrictEqual } from 'node:util';
import {
  MEASUREMENT_VERSION,
  accumulateSpeed,
  createSpeedAccumulator,
  finishSpeed,
  parseIsoMs,
} from '../trajectory-metrics.mjs';
import { roundMetric } from './config.mjs';
import { getEndpointCacheStore } from './endpoint-registry.mjs';
import { loadExternalDeepStatsCache } from './local-scanner.mjs';
import {
  computeStepCost,
  formatUpstreamModelId,
  isArgonModelIdentifier,
  isCarbonModelIdentifier,
} from './model-pricing.mjs';

/** @typedef {ReturnType<import('./model-pricing.mjs').createStepModelResolver>} StepModelResolver */

function safeTok(val) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function normalizeOwnerAccount(val) {
  return typeof val === 'string' ? val.trim().toLowerCase() : '';
}

const COMPACTION_QUOTA_SETTLE_MAX_MS = 180_000;
const STEP_QUOTA_DURATION_CAP_SEC = 600;

/**
 * 解析单步用于官方配额周期窗口（`5h` / `weekly` / `cycle`）边界比对的结算时间戳：
 * 服务端配额桶的 `resetTime` 锚定在周期内首笔请求完成扣费时刻（而非 `createdAt` 发起时刻），
 * 使用完成时刻（无流式计时的自动压缩 `CHECKPOINT` 步按合理结算上限及下一步发起时刻封顶）避免漏计开启新周期的首步。
 */
function resolveStepQuotaBillingMs(st, nextStep, nowMs) {
  const tMs = Number(st?.createdAtMs) > 0 ? Number(st.createdAtMs) : 0;
  if (!(tMs > 0) || tMs > nowMs) return tMs;
  const durSec = Number(st?.totalDurationSec);
  if (Number.isFinite(durSec) && durSec > 0) {
    const endMs = tMs + Math.round(Math.min(durSec, STEP_QUOTA_DURATION_CAP_SEC) * 1000);
    return Math.min(nowMs, endMs);
  }
  if (st?.isCompactionStep) {
    const nextMs = Number(nextStep?.createdAtMs) > tMs ? Number(nextStep.createdAtMs) : Infinity;
    return Math.min(nowMs, nextMs, tMs + COMPACTION_QUOTA_SETTLE_MAX_MS);
  }
  return tMs;
}

/**
 * 获取本地当日 00:00:00.000 的毫秒时间戳。
 *
 * @param {Date|number} [now=new Date()]
 * @returns {number}
 */
function getStartOfLocalDayMs(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function getStartOfLocalOffsetDaysMs(nowMs, offsetDays) {
  const d = new Date(nowMs);
  d.setDate(d.getDate() - offsetDays);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 获取本地下一个周一 00:00:00.000 的 ISO 时间字符串（用于自定义本机周限额重置倒计时）。
 *
 * @param {Date|number} [now=new Date()]
 * @returns {string}
 */
export function getNextMondayResetIso(now = new Date()) {
  const d = new Date(now);
  const day = d.getDay(); // 0 = Sun, 1 = Mon ...
  const daysUntilMon = day === 0 ? 1 : 8 - day;
  d.setDate(d.getDate() + daysUntilMon);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * 获取本地本周一 00:00:00.000 的毫秒时间戳。
 *
 * @param {Date|number} [now=new Date()]
 * @returns {number}
 */
function getStartOfCurrentWeekMs(now = new Date()) {
  const d = new Date(now);
  const day = d.getDay(); // 0 = Sun, 1 = Mon
  const diffToMon = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMon);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 根据时间范围键名 (`rangeKey`) 与官方配额重置锚点 (`cycleAnchors`) 解析起止毫秒时间戳。
 *
 * @param {string} [rangeKey='all']
 * @param {number} [customStartMs=0]
 * @param {number} [customEndMs=0]
 * @param {number} [nowMs=Date.now()]
 * @param {{ fiveHourResetMs?: number, weeklyResetMs?: number }} [cycleAnchors={}]
 * @returns {{ key: string, label: string, startMs: number, endMs: number }}
 */
function resolveTimeWindow(
  rangeKey = 'all',
  customStartMs = 0,
  customEndMs = 0,
  nowMs = Date.now(),
  cycleAnchors = {},
  isCustomWeeklyMode = false
) {
  const now = new Date(nowMs);
  switch (rangeKey) {
    case 'cycle': {
      const resetWkMs = !isCustomWeeklyMode ? cycleAnchors.weeklyResetMs || 0 : 0;
      const startCycleMs =
        resetWkMs > nowMs
          ? Math.min(nowMs, resetWkMs - 7 * 24 * 3600 * 1000)
          : getStartOfCurrentWeekMs(now);
      return {
        key: 'cycle',
        label: isCustomWeeklyMode ? '本周' : '当前周期',
        startMs: startCycleMs,
        endMs: nowMs,
      };
    }
    case '5h': {
      const reset5hMs = cycleAnchors.fiveHourResetMs || 0;
      const start5hMs =
        reset5hMs > nowMs
          ? Math.min(nowMs, reset5hMs - 5 * 3600 * 1000)
          : nowMs - 5 * 3600 * 1000;
      return {
        key: '5h',
        label: reset5hMs > nowMs ? '当前 5h 周期' : '近 5 小时',
        startMs: start5hMs,
        endMs: nowMs,
      };
    }
    case 'today':
      return { key: 'today', label: '今日', startMs: getStartOfLocalDayMs(now), endMs: nowMs };
    case '24h':
      return { key: '24h', label: '近 24 小时', startMs: nowMs - 24 * 3600 * 1000, endMs: nowMs };
    case 'week': {
      const resetWkMs = cycleAnchors.weeklyResetMs || 0;
      const startWkMs =
        resetWkMs > nowMs
          ? Math.min(nowMs, resetWkMs - 7 * 24 * 3600 * 1000)
          : getStartOfCurrentWeekMs(now);
      return {
        key: 'week',
        label: resetWkMs > nowMs ? '当前周限周期' : '本周',
        startMs: startWkMs,
        endMs: nowMs,
      };
    }
    case '7d':
      return {
        key: '7d',
        label: '近 7 天',
        startMs: getStartOfLocalOffsetDaysMs(nowMs, 7),
        endMs: nowMs,
      };
    case '14d':
      return {
        key: '14d',
        label: '近 14 天',
        startMs: getStartOfLocalOffsetDaysMs(nowMs, 14),
        endMs: nowMs,
      };
    case '30d':
      return {
        key: '30d',
        label: '近 30 天',
        startMs: getStartOfLocalOffsetDaysMs(nowMs, 30),
        endMs: nowMs,
      };
    case 'custom': {
      const s = Number(customStartMs) > 0 ? Number(customStartMs) : 0;
      const e = Number(customEndMs) > 0 ? Number(customEndMs) : nowMs;
      return {
        key: 'custom',
        label: '自定义时段',
        startMs: Math.min(s, e),
        endMs: Math.max(s, e),
      };
    }
    case 'all':
    default:
      return { key: 'all', label: '全部时间', startMs: 0, endMs: Infinity };
  }
}

/**
 * 创建一个空的用量统计累加桶。
 */
function createUsageBucket() {
  return {
    calls: 0,
    conversationsSet: new Set(),
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    responseTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    savedCostUsd: 0,
  };
}

/**
 * 将单个模型步骤的 Token 与成本累加至目标统计桶。
 *
 * @param {ReturnType<typeof createUsageBucket>} bucket
 * @param {object} usage 已归一化的单步用量
 * @param {string} cascadeId 会话标识
 */
function accumulateStepIntoBucket(bucket, usage, cascadeId) {
  const { inTok, cacheTok, outTok, thinkTok, respTok, stepTotalTokens,
    resolvedCost, savedCost, unpriced } = usage;
  if (unpriced) bucket.unpricedCalls = (bucket.unpricedCalls || 0) + 1;
  bucket.calls += 1;
  if (cascadeId) bucket.conversationsSet.add(cascadeId);
  bucket.inputTokens += inTok;
  bucket.cacheReadTokens += cacheTok;
  bucket.outputTokens += outTok;
  bucket.thinkingTokens += thinkTok;
  bucket.responseTokens += respTok;
  bucket.totalTokens += stepTotalTokens;
  bucket.costUsd += resolvedCost;
  bucket.savedCostUsd += savedCost;
}

/**
 * 将累加完成的用量桶定型为可序列化的前端统计结构（计算缓存命中率并舍入金额）。
 *
 * @param {ReturnType<typeof createUsageBucket>} bucket
 */
function finalizeUsageBucket(bucket) {
  const promptTokens = bucket.inputTokens + bucket.cacheReadTokens;
  const cacheHitPct =
    promptTokens > 0 ? +((bucket.cacheReadTokens / promptTokens) * 100).toFixed(1) : 0;
  return {
    calls: bucket.calls,
    conversationsCount: bucket.conversationsSet.size,
    inputTokens: bucket.inputTokens,
    cacheReadTokens: bucket.cacheReadTokens,
    outputTokens: bucket.outputTokens,
    thinkingTokens: bucket.thinkingTokens,
    responseTokens: bucket.responseTokens,
    totalTokens: bucket.totalTokens,
    costUsd: +bucket.costUsd.toFixed(2),
    unpricedCalls: bucket.unpricedCalls || 0,
    savedCostUsd: +bucket.savedCostUsd.toFixed(2),
    cacheHitPct,
  };
}

/**
 * 将单步统计数据累加至按模型分组的映射表中（供单代理、主+子汇总与全局时间范围共用）。
 *
 * @param {Map<string, object>} perModelStats
 * @param {object} st
 * @param {object} mInfo
 * @param {number|null} stepCost
 */
function accumulateStepIntoModelMap(perModelStats, st, mInfo, stepCost) {
  const inTok = safeTok(st?.inputTokens);
  const cacheTok = safeTok(st?.cacheReadTokens);
  const outTok = safeTok(st?.outputTokens);
  const thinkTok = safeTok(st?.thinkingTokens);
  const respTok =
    st?.responseTokens !== undefined && st?.responseTokens !== null
      ? safeTok(st.responseTokens)
      : Math.max(0, outTok - thinkTok);
  const stepTotalTokens = inTok + cacheTok + outTok;
  const unpriced = stepCost === null ? 1 : 0;
  const modelGroupKey = mInfo.baseLabel || mInfo.label;

  if (!perModelStats.has(modelGroupKey)) {
    perModelStats.set(modelGroupKey, {
      label: modelGroupKey,
      shortName: mInfo.shortName,
      fallbackModelId:
        mInfo.modelId && mInfo.modelId !== 'unknown'
          ? formatUpstreamModelId(mInfo.modelId, mInfo)
          : '',
      upstreamModelCounts: new Map(),
      family: mInfo.family,
      calls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      responseTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      ttftSumSec: 0,
      ttftSampleCount: 0,
      speedAccumulator: createSpeedAccumulator(),
      anomalySteps: 0,
      anomalyCount: 0,
      anomalyDangerCount: 0,
      anomalyTotalDelaySec: 0,
      anomalyByKind: {},
    });
  }
  const agg = perModelStats.get(modelGroupKey);
  if (st.responseModel) {
    const formattedResp = formatUpstreamModelId(st.responseModel, mInfo);
    agg.upstreamModelCounts.set(
      formattedResp,
      (agg.upstreamModelCounts.get(formattedResp) || 0) + 1
    );
  }
  accumulateSpeed(agg.speedAccumulator, st);
  if (
    !st.isCompactionStep &&
    st.measurementVersion === MEASUREMENT_VERSION &&
    st.isComplete &&
    Number.isFinite(st.totalDurationSec) &&
    Number.isFinite(st.nativeTtftSec) &&
    st.nativeTtftSec >= 0 &&
    st.nativeTtftSec <= st.totalDurationSec + 0.01
  ) {
    agg.ttftSumSec += st.nativeTtftSec;
    agg.ttftSampleCount += 1;
  }

  if (st?.anomaly && Number(st.anomaly.count) > 0) {
    agg.anomalySteps += 1;
    agg.anomalyCount += Number(st.anomaly.count);
    if (st.anomaly.severity === 'danger') {
      agg.anomalyDangerCount += 1;
    }
    if (Number(st.anomaly.totalDelaySec) > 0) {
      agg.anomalyTotalDelaySec += Number(st.anomaly.totalDelaySec);
    }
    if (st.anomaly.kinds && typeof st.anomaly.kinds === 'object') {
      for (const [k, v] of Object.entries(st.anomaly.kinds)) {
        const cnt = Number(v || 0);
        if (cnt > 0) {
          agg.anomalyByKind[k] = (agg.anomalyByKind[k] || 0) + cnt;
        }
      }
    } else if (st.anomaly.primaryKind) {
      agg.anomalyByKind[st.anomaly.primaryKind] =
        (agg.anomalyByKind[st.anomaly.primaryKind] || 0) + Number(st.anomaly.count);
    }
  }

  agg.calls += 1;
  agg.inputTokens += inTok;
  agg.cacheReadTokens += cacheTok;
  agg.outputTokens += outTok;
  agg.thinkingTokens += thinkTok;
  agg.responseTokens += respTok;
  agg.totalTokens += stepTotalTokens;
  agg.costUsd += Number.isFinite(stepCost) ? stepCost : 0;
  agg.unpricedCalls = (agg.unpricedCalls || 0) + unpriced;
}

/**
 * 将按模型分组的统计映射表定型并排序为前端可渲染数组。
 *
 * @param {Map<string, object>} perModelStats
 * @returns {object[]}
 */
function finalizeModelBreakdownMap(perModelStats) {
  return Array.from(perModelStats.values())
    .sort((a, b) => b.calls - a.calls || String(a.label).localeCompare(String(b.label)))
    .map(
      ({
        speedAccumulator,
        upstreamModelCounts,
        fallbackModelId,
        ttftSumSec,
        ttftSampleCount,
        anomalySteps,
        anomalyCount,
        anomalyDangerCount,
        anomalyTotalDelaySec,
        anomalyByKind,
        ...m
      }) => {
        const sortedUpstream = Array.from((upstreamModelCounts || new Map()).entries())
          .sort((a, b) => b[1] - a[1])
          .map(([name]) => name);
        const primaryUpstream =
          sortedUpstream.length > 0 ? sortedUpstream[0] : fallbackModelId || m.shortName || m.label;
        const finishedSpeed = finishSpeed(speedAccumulator);
        const promptTokens = m.inputTokens + m.cacheReadTokens;
        const cacheHitPct =
          promptTokens > 0 ? +((m.cacheReadTokens / promptTokens) * 100).toFixed(1) : 0;
        const avgTtftSec =
          ttftSampleCount > 0 ? roundMetric(ttftSumSec / ttftSampleCount) : null;
        const hasAnomalies = Number(anomalyCount || 0) > 0;
        return {
          ...m,
          upstreamName: primaryUpstream,
          upstreamModels: sortedUpstream,
          costUsd: +m.costUsd.toFixed(6),
          cacheHitPct,
          avgTtftSec,
          ttftSampleCount,
          avgTokPerSec: roundMetric(finishedSpeed.avgTokPerSec),
          speedSummary: finishedSpeed,
          ...(hasAnomalies
            ? {
                anomalySteps: Number(anomalySteps || 0),
                anomalyCount: Number(anomalyCount || 0),
                anomalyDangerCount: Number(anomalyDangerCount || 0),
                anomalyTotalDelaySec: +(Number(anomalyTotalDelaySec || 0)).toFixed(1),
                anomalyByKind: anomalyByKind || {},
              }
            : {}),
        };
      }
    );
}

/**
 * 针对给定步骤数组构建按模型聚合的统计列表（供单代理、主+子汇总及全局时间范围复用）。
 *
 * @param {object[]} [steps=[]]
 * @param {StepModelResolver} resolveStepModel
 * @returns {object[]}
 */
export function buildScopedModelBreakdown(steps, resolveStepModel) {
  const perModelStats = new Map();
  for (const st of steps) {
    if (!st || typeof st !== 'object') continue;
    const mInfo = resolveStepModel(st);
    const stepCost = computeStepCost(st, mInfo.pricing);
    accumulateStepIntoModelMap(perModelStats, st, mInfo, stepCost);
  }
  return finalizeModelBreakdownMap(perModelStats);
}

const MAX_USAGE_SNAPSHOT_ENDPOINTS = 8;
const lastUsageSnapshotsByEndpoint = new Map();
let usageSnapshotRevisionSeq = 0;
const stepsTimeBoundsCache = new WeakMap();
const MAX_TREND_TIMESTAMP_MS = 8_640_000_000_000_000;
export const CONSUMPTION_PRESET_RANGE_KEYS = ['cycle', 'today', '24h', '7d', '14d', '30d', 'all'];
const USAGE_SOURCE_LABELS = {
  standalone: 'Antigravity App',
  ide: 'Antigravity IDE',
  cli: 'Antigravity CLI',
  ssh: 'Antigravity SSH',
};

export function clearUsageAggregatorMemo(endpointId = null) {
  if (endpointId) {
    lastUsageSnapshotsByEndpoint.delete(String(endpointId));
  } else {
    lastUsageSnapshotsByEndpoint.clear();
  }
  usageSnapshotRevisionSeq += 1;
}

function getStepsTimeBounds(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { minMs: Infinity, maxMs: 0 };
  }
  const cached = stepsTimeBoundsCache.get(steps);
  if (cached) return cached;
  let minMs = Infinity;
  let maxMs = 0;
  for (let i = 0; i < steps.length; i++) {
    const tMs = Number(steps[i]?.createdAtMs);
    if (tMs > 0) {
      if (tMs < minMs) minMs = tMs;
      if (tMs > maxMs) maxMs = tMs;
    }
  }
  const bounds = { minMs, maxMs };
  stepsTimeBoundsCache.set(steps, bounds);
  return bounds;
}

function collectUsageEntriesToAggregate(familySet, endpoint = null) {
  const isRemote = Boolean(endpoint && endpoint.isRemote);
  const cacheStore = getEndpointCacheStore(endpoint);
  const externalConvos = isRemote ? new Map() : loadExternalDeepStatsCache();

  // 构建大小写归一化的内存缓存与跨端深层缓存索引，彻底杜绝 `${appSource}:${cascadeId}` 键不匹配导致的双倍重复计费
  const allLiveByLower = new Map();
  for (const [rawId, entry] of cacheStore.listCachedTrajectoryEntries(true)) {
    const cidLower = String(rawId || '').toLowerCase();
    if (!cidLower || !entry || typeof entry !== 'object') continue;
    const prev = allLiveByLower.get(cidLower);
    if (!prev || (entry.steps?.length || 0) > (prev.steps?.length || 0)) {
      allLiveByLower.set(cidLower, entry);
    }
  }

  const externalByCid = new Map();
  for (const ext of externalConvos.values()) {
    const extCidLower = String(ext?.cascadeId || '').toLowerCase();
    if (!extCidLower) continue;
    const prevExt = externalByCid.get(extCidLower);
    if (!prevExt || (ext.steps?.length || 0) > (prevExt.steps?.length || 0)) {
      externalByCid.set(extCidLower, ext);
    }
  }

  if (!isRemote && [...allLiveByLower.keys()].some(id => id.startsWith('usage-history:'))) {
    for (const id of new Set([...allLiveByLower.keys(), ...externalByCid.keys()])) {
      if (id.startsWith('usage-history:')) continue;
      const key = usageHistoryKey(id);
      const history = allLiveByLower.get(key);
      if (!history) continue;
      const live = allLiveByLower.get(id);
      const external = externalByCid.get(id);
      if (history.steps.length > Math.max(live?.steps?.length || 0, external?.steps?.length || 0)) {
        allLiveByLower.set(id, {
          ...history,
          rootConversationId: live?.rootConversationId,
          parentConversationId: live?.parentConversationId,
        });
      }
      allLiveByLower.delete(key);
    }
  }

  const allEntriesToAggregate = [];

  for (const [cidLower, entry] of allLiveByLower.entries()) {
    const extMatch = externalByCid.get(cidLower);
    if (extMatch && (extMatch.steps?.length || 0) > (entry?.steps?.length || 0)) {
      continue;
    }
    const groupCascadeId = String(
      entry?.rootConversationId || entry?.parentConversationId || cidLower
    ).toLowerCase();
    allEntriesToAggregate.push({
      cascadeId: groupCascadeId,
      appSource: isRemote ? 'ssh' : entry?.appSource || 'standalone',
      accountName: entry?.accountName || extMatch?.accountName || '',
      steps: entry?.steps || [],
      isCurrentConv: familySet.has(cidLower),
    });
  }

  for (const [extCidLower, ext] of externalByCid.entries()) {
    const liveEntry = allLiveByLower.get(extCidLower);
    if (liveEntry && (liveEntry.steps?.length || 0) >= (ext.steps?.length || 0)) {
      continue;
    }
    allEntriesToAggregate.push({
      cascadeId: extCidLower,
      appSource: ext.appSource || 'ide',
      accountName: ext.accountName || liveEntry?.accountName || '',
      steps: ext.steps || [],
      isCurrentConv: familySet.has(extCidLower),
    });
  }

  return allEntriesToAggregate;
}

function buildQuotaPoolCycleMap(quotaPoolsMap, nowMs) {
  const poolCycleBuckets = new Map();
  if (quotaPoolsMap instanceof Map && quotaPoolsMap.size > 0) {
    const weekFallbackStartMs = getStartOfCurrentWeekMs(new Date(nowMs));
    for (const [poolKey, poolObj] of quotaPoolsMap.entries()) {
      const reset5hMs = parseIsoMs(poolObj?.resetTime) || 0;
      const start5hMs =
        reset5hMs > nowMs
          ? Math.min(nowMs, reset5hMs - 5 * 3600 * 1000)
          : nowMs - 5 * 3600 * 1000;
      const resetWkMs = parseIsoMs(poolObj?.weeklyResetTime) || 0;
      const startWkMs =
        resetWkMs > nowMs
          ? Math.min(nowMs, resetWkMs - 7 * 24 * 3600 * 1000)
          : weekFallbackStartMs;
      poolCycleBuckets.set(poolKey, {
        start5hMs,
        startWkMs,
        b5h: createUsageBucket(),
        bWk: createUsageBucket(),
      });
    }
  }
  return poolCycleBuckets;
}

function resolvePoolBucketForStep(
  st,
  mInfo,
  poolCycleBuckets,
  poolByModel,
  hasDedicatedCarbonPool,
  hasDedicatedArgonPool
) {
  if (poolCycleBuckets.size === 0) return null;
  let cachedPool = poolByModel.get(mInfo);
  if (
    !cachedPool ||
    cachedPool.key !== st.modelKey ||
    cachedPool.response !== st.responseModel ||
    cachedPool.displayName !== st.modelDisplayName
  ) {
    const ids = [
      st.modelKey,
      st.responseModel,
      mInfo.modelId,
      mInfo.label,
      st.modelDisplayName,
    ];
    let poolKey = null;
    if (hasDedicatedCarbonPool && isCarbonModelIdentifier(...ids)) poolKey = 'Carbon';
    else if (hasDedicatedArgonPool && isArgonModelIdentifier(...ids)) poolKey = 'Argon';
    else if (mInfo.family === 'Gemini') poolKey = 'Gemini';
    else if (['Claude', 'GPT', 'Other'].includes(mInfo.family)) poolKey = 'Claude & GPT';
    cachedPool = {
      key: st.modelKey,
      response: st.responseModel,
      displayName: st.modelDisplayName,
      bucket: poolCycleBuckets.get(poolKey) || null,
    };
    poolByModel.set(mInfo, cachedPool);
  }
  return cachedPool.bucket;
}

function buildUsageTrendSeries(
  selectedWindow,
  effectiveSelectedWindow,
  selectedWindowSteps,
  nowMs,
  earliestSelectedStepMs,
  latestSelectedStepMs
) {
  const trend = planUsageTrend(
    effectiveSelectedWindow,
    nowMs,
    earliestSelectedStepMs,
    latestSelectedStepMs
  );
  const { start: trendStartMs, end: trendEndMs, hourly: useHourly } = trend;
  const pad2 = (n) => String(n).padStart(2, '0');
  const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  const trendSeries = [];
  if (useHourly) {
    let firstHourMs = trend.first;
    let lastHourMs = trend.last;
    if (selectedWindow.key === 'today') {
      const minTodayEndMs = firstHourMs + 5 * 3600 * 1000;
      if (lastHourMs < minTodayEndMs) {
        lastHourMs = minTodayEndMs;
      }
    } else if (lastHourMs - firstHourMs < 5 * 3600 * 1000) {
      firstHourMs = lastHourMs - 5 * 3600 * 1000;
    }

    const totalHours = Math.max(2, Math.round((lastHourMs - firstHourMs) / (3600 * 1000)) + 1);
    const stepHours = totalHours > 72 ? Math.ceil(totalHours / 48) : 1;
    const slotMs = stepHours * 3600 * 1000;
    const slotCount = Math.max(2, Math.ceil((lastHourMs - firstHourMs + 3600 * 1000) / slotMs));

    const firstD = new Date(firstHourMs);
    const lastD = new Date(firstHourMs + (slotCount - 1) * slotMs);
    const isSameDay =
      firstD.getFullYear() === lastD.getFullYear() &&
      firstD.getMonth() === lastD.getMonth() &&
      firstD.getDate() === lastD.getDate();

    for (let idx = 0; idx < slotCount; idx++) {
      const sMs = firstHourMs + idx * slotMs;
      const eMs = sMs + slotMs;
      const sd = new Date(sMs);
      const ed = new Date(eMs);
      if (Number.isNaN(sd.getTime())) continue;
      const hh = `${pad2(sd.getHours())}:00`;
      const endHh = `${pad2(ed.getHours())}:00`;
      const dateStr = `${sd.getMonth() + 1}/${pad2(sd.getDate())}`;
      const axisLabel = isSameDay ? hh : `${dateStr} ${hh}`;
      const fullLabel = `${sd.getMonth() + 1}月${sd.getDate()}日 ${hh} - ${endHh}`;
      trendSeries.push({
        index: idx,
        startMs: sMs,
        endMs: eMs,
        granularity: 'hour',
        label: axisLabel,
        fullLabel,
        tokens: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        unpricedCalls: 0,
        calls: 0,
      });
    }
  } else {
    const firstDayMs = trend.first;
    const lastDayMs = trend.last;
    const dayStarts = [];
    const cursor = new Date(firstDayMs);
    cursor.setHours(0, 0, 0, 0);
    let safety = 0;
    while (cursor.getTime() <= lastDayMs && safety < 3660) {
      dayStarts.push(cursor.getTime());
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      safety++;
    }
    while (dayStarts.length < 2) {
      const prev = new Date(dayStarts[0] || firstDayMs);
      prev.setDate(prev.getDate() - 1);
      prev.setHours(0, 0, 0, 0);
      dayStarts.unshift(prev.getTime());
    }

    const firstYear = new Date(dayStarts[0]).getFullYear();
    const lastYear = new Date(dayStarts[dayStarts.length - 1]).getFullYear();
    const showFullYear = firstYear !== lastYear || dayStarts.length > 90;

    for (let i = 0; i < dayStarts.length; i++) {
      const sMs = dayStarts[i];
      const endCursor = new Date(sMs);
      endCursor.setDate(endCursor.getDate() + 1);
      endCursor.setHours(0, 0, 0, 0);
      const eMs = endCursor.getTime();

      const sd = new Date(sMs);
      const axisLabel = `${sd.getMonth() + 1}/${pad2(sd.getDate())}`;
      const datePrefix = showFullYear ? `${sd.getFullYear()}年` : '';
      const fullLabel = `${datePrefix}${sd.getMonth() + 1}月${sd.getDate()}日 (${WEEKDAY_NAMES[sd.getDay()]})`;

      trendSeries.push({
        index: i,
        startMs: sMs,
        endMs: eMs,
        granularity: 'day',
        label: axisLabel,
        fullLabel,
        tokens: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        unpricedCalls: 0,
        calls: 0,
      });
    }
  }

  if (trendSeries.length > 0) {
    const firstBucketStart = trendSeries[0].startMs;
    const lastIdx = trendSeries.length - 1;
    let previousBucketIndex = 0;
    for (const item of selectedWindowSteps) {
      let targetIdx = lastIdx;
      const previousBucket = trendSeries[previousBucketIndex];
      if (item.tMs <= firstBucketStart) {
        targetIdx = 0;
      } else if (item.tMs >= previousBucket.startMs && item.tMs < previousBucket.endMs) {
        targetIdx = previousBucketIndex;
      } else {
        // 二分查找匹配的时间桶 [startMs, endMs)
        let lo = 0;
        let hi = lastIdx;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const b = trendSeries[mid];
          if (item.tMs < b.startMs) {
            hi = mid - 1;
          } else if (item.tMs >= b.endMs && mid < lastIdx) {
            lo = mid + 1;
          } else {
            targetIdx = mid;
            break;
          }
        }
      }
      previousBucketIndex = targetIdx;
      const bucket = trendSeries[targetIdx];
      bucket.tokens += item.tokens;
      bucket.inputTokens += item.inputTokens || 0;
      bucket.cacheReadTokens += item.cacheReadTokens || 0;
      bucket.outputTokens += item.outputTokens || 0;
      bucket.costUsd += item.costUsd;
      bucket.unpricedCalls = (bucket.unpricedCalls || 0) + item.unpricedCalls;
      bucket.calls += 1;

      if (item.mInfo && item.tokens > 0) {
        bucket.perModelStats ??= new Map();
        const mInfo = item.mInfo;
        const modelGroupKey = mInfo.baseLabel || mInfo.label;
        let bModel = bucket.perModelStats.get(modelGroupKey);
        if (!bModel) {
          bModel = {
            label: modelGroupKey,
            shortName: mInfo.shortName,
            fallbackModelId:
              mInfo.modelId && mInfo.modelId !== 'unknown'
                ? formatUpstreamModelId(mInfo.modelId, mInfo)
                : '',
            upstreamModelCounts: new Map(),
            family: mInfo.family,
            calls: 0,
            totalTokens: 0,
            costUsd: 0,
            unpricedCalls: 0,
          };
          bucket.perModelStats.set(modelGroupKey, bModel);
        }
        if (item.responseModel) {
          const formattedResp = formatUpstreamModelId(item.responseModel, mInfo);
          bModel.upstreamModelCounts.set(
            formattedResp,
            (bModel.upstreamModelCounts.get(formattedResp) || 0) + 1
          );
        }
        bModel.calls += 1;
        bModel.totalTokens += item.tokens;
        bModel.costUsd += item.costUsd;
        bModel.unpricedCalls += item.unpricedCalls || 0;
      }
    }
    for (const b of trendSeries) {
      b.costUsd = +b.costUsd.toFixed(4);
      if (b.perModelStats) {
        b.models = Array.from(b.perModelStats.values())
          .sort((a, c) => c.totalTokens - a.totalTokens || c.calls - a.calls)
          .map(({ upstreamModelCounts, fallbackModelId, ...m }) => {
            const sortedUpstream = Array.from(upstreamModelCounts.entries())
              .sort((a, c) => c[1] - a[1])
              .map(([name]) => name);
            const primaryUpstream =
              sortedUpstream.length > 0 ? sortedUpstream[0] : fallbackModelId || m.shortName || m.label;
            return {
              ...m,
              upstreamName: primaryUpstream,
              upstreamModels: sortedUpstream,
              costUsd: +m.costUsd.toFixed(6),
            };
          });
        delete b.perModelStats;
      }
    }
  }

  return { trend, trendStartMs, trendEndMs, trendSeries };
}

function planUsageTrend(window, nowMs, earliest, latest) {
  const safeMs = (value, fallback) =>
    Number.isFinite(value) && value > 0 && value <= MAX_TREND_TIMESTAMP_MS ? value : fallback;
  const end = Math.max(safeMs(window.endMs, Math.max(nowMs, latest || nowMs)), latest);
  const defaultStart = end - 24 * 3600 * 1000;
  const start = window.key === 'all'
    ? Math.min(safeMs(earliest, defaultStart), end - 3600 * 1000)
    : Math.min(safeMs(window.startMs, defaultStart), end);
  const hourly = window.key === 'today' || window.key === '24h' || window.key === '5h' ||
    end - start <= 72 * 3600 * 1000;
  const first = new Date(start);
  const last = new Date(end);
  if (hourly) {
    first.setMinutes(0, 0, 0);
    last.setMinutes(0, 0, 0);
  } else {
    first.setHours(0, 0, 0, 0);
    last.setHours(0, 0, 0, 0);
  }
  return { start, end, hourly, first: first.getTime(), last: last.getTime() };
}

function sameUsageEntries(previous, current) {
  return previous.length === current.length && current.every((entry, index) => {
    const before = previous[index];
    return entry.steps === before.steps && entry.cascadeId === before.cascadeId &&
      entry.appSource === before.appSource && entry.accountName === before.accountName;
  });
}

function buildFamilySig(familySet) {
  if (!(familySet instanceof Set) || familySet.size === 0) return '';
  return Array.from(familySet).sort().join(',');
}

function computeFamilySessionBuckets({
  entries,
  familySet,
  presetKeys = [],
  presetWindows = {},
  selectedWindow,
  isCustomWeeklyMode = false,
  poolCycleBuckets = new Map(),
  normalizedQuotaAccount = '',
  nowMs = Date.now(),
  resolveStepModel,
  weekStartMs = 0,
}) {
  const sessionBuckets = {};
  for (const k of presetKeys) {
    sessionBuckets[k] = createUsageBucket();
  }
  const selectedSessionBucket =
    (selectedWindow?.key && sessionBuckets[selectedWindow.key]) || createUsageBucket();
  if (!(familySet instanceof Set) || familySet.size === 0) {
    const sessionPresets = {};
    for (const k of presetKeys) {
      sessionPresets[k] = finalizeUsageBucket(sessionBuckets[k]);
    }
    return {
      finalizedSelectedSession: finalizeUsageBucket(selectedSessionBucket),
      sessionPresets,
    };
  }

  const hasDedicatedCarbonPool = poolCycleBuckets.has('Carbon');
  const hasDedicatedArgonPool = poolCycleBuckets.has('Argon');
  const poolByModel = new Map();
  const effectiveWeekStartMs = weekStartMs || presetWindows.week?.startMs || 0;
  const cycleStartFallbackMs =
    presetWindows.cycle?.startMs ??
    (selectedWindow?.key === 'cycle' ? selectedWindow.startMs : 0);

  for (const entry of entries || []) {
    const cidLower = String(entry?.cascadeId || '').toLowerCase();
    if (!cidLower || !familySet.has(cidLower)) continue;
    const entryOwner = normalizeOwnerAccount(entry.accountName);
    const entrySteps = entry.steps || [];
    for (let sIdx = 0; sIdx < entrySteps.length; sIdx++) {
      const st = entrySteps[sIdx];
      if (!st || typeof st !== 'object') continue;
      const nextSt = entrySteps[sIdx + 1] || null;
      const stepOwner = normalizeOwnerAccount(st.accountName) || entryOwner;
      const includeInQuotaPools =
        normalizedQuotaAccount === null
          ? false
          : normalizedQuotaAccount === '' || stepOwner === ''
            ? true
            : stepOwner === normalizedQuotaAccount;
      const mInfo = resolveStepModel(st);
      const inTok = safeTok(st.inputTokens);
      const cacheTok = safeTok(st.cacheReadTokens);
      const outTok = safeTok(st.outputTokens);
      const thinkTok = safeTok(st.thinkingTokens);
      const respTok =
        st.responseTokens !== undefined && st.responseTokens !== null
          ? safeTok(st.responseTokens)
          : Math.max(0, outTok - thinkTok);
      const stepTotalTokens = inTok + cacheTok + outTok;
      const stepCost = computeStepCost(st, mInfo.pricing);
      const resolvedCost = Number.isFinite(stepCost) ? stepCost : 0;
      const unpriced = stepCost === null ? 1 : 0;
      const tMs = Number(st.createdAtMs) > 0 ? Number(st.createdAtMs) : 0;
      const qMs = resolveStepQuotaBillingMs(st, nextSt, nowMs);
      const savedCost = mInfo.pricing
        ? (cacheTok / 1_000_000) * Math.max(0, mInfo.pricing.input - mInfo.pricing.cache)
        : 0;
      const stepUsage = {
        inTok,
        cacheTok,
        outTok,
        thinkTok,
        respTok,
        stepTotalTokens,
        resolvedCost,
        savedCost,
        unpriced,
      };

      const poolBucketEntry =
        poolCycleBuckets.size > 0
          ? resolvePoolBucketForStep(
              st,
              mInfo,
              poolCycleBuckets,
              poolByModel,
              hasDedicatedCarbonPool,
              hasDedicatedArgonPool
            )
          : null;

      let inCurrentCycle = false;
      if (qMs > 0 && qMs <= nowMs) {
        if (isCustomWeeklyMode) {
          inCurrentCycle = tMs >= effectiveWeekStartMs;
        } else if (poolCycleBuckets.size > 0) {
          const effCycleStartMs = poolBucketEntry
            ? poolBucketEntry.startWkMs
            : cycleStartFallbackMs;
          inCurrentCycle = includeInQuotaPools && qMs >= effCycleStartMs;
        } else {
          inCurrentCycle = includeInQuotaPools && qMs >= cycleStartFallbackMs;
        }
      }

      for (const k of presetKeys) {
        const w = presetWindows[k];
        const cmpMs = k === '5h' || k === 'week' ? qMs : tMs;
        const matchesPreset =
          k === 'all'
            ? true
            : k === 'cycle'
              ? inCurrentCycle
              : cmpMs > 0 && cmpMs >= w.startMs && cmpMs <= w.endMs;
        if (matchesPreset) {
          accumulateStepIntoBucket(sessionBuckets[k], stepUsage, entry.cascadeId);
        }
      }

      if (selectedWindow && (!sessionBuckets[selectedWindow.key] || selectedWindow.key === 'custom')) {
        const selCmpMs =
          selectedWindow.key === '5h' || selectedWindow.key === 'week' ? qMs : tMs;
        const inSelectedWindow =
          selectedWindow.key === 'all'
            ? true
            : selectedWindow.key === 'cycle'
              ? inCurrentCycle
              : selCmpMs > 0 && selCmpMs >= selectedWindow.startMs && selCmpMs <= selectedWindow.endMs;
        if (inSelectedWindow) {
          accumulateStepIntoBucket(selectedSessionBucket, stepUsage, entry.cascadeId);
        }
      }
    }
  }

  const sessionPresets = {};
  for (const k of presetKeys) {
    sessionPresets[k] = finalizeUsageBucket(sessionBuckets[k]);
  }
  return {
    finalizedSelectedSession: finalizeUsageBucket(selectedSessionBucket),
    sessionPresets,
  };
}

function sortedUsageTimestamps(entries) {
  const dates = new Float64Array(entries.reduce((sum, entry) => sum + entry.steps.length, 0));
  let count = 0;
  for (const { steps } of entries) {
    for (const step of steps) {
      const date = Number(step?.createdAtMs);
      if (date > 0) dates[count++] = date;
    }
  }
  return dates.subarray(0, count).sort();
}

function usageTimestampBoundary(dates, value, inclusive) {
  let start = 0;
  let end = dates.length;
  while (start < end) {
    const i = (start + end) >>> 1;
    if (dates[i] < value || (inclusive && dates[i] === value)) start = i + 1;
    else end = i;
  }
  return start;
}

function sortedQuotaBillingTimestamps(entries, nowMs) {
  const dates = new Float64Array(entries.reduce((sum, entry) => sum + entry.steps.length, 0));
  let count = 0;
  for (const { steps } of entries) {
    for (let i = 0; i < steps.length; i++) {
      const qMs = resolveStepQuotaBillingMs(steps[i], steps[i + 1] || null, nowMs);
      if (qMs > 0) dates[count++] = qMs;
    }
  }
  return dates.subarray(0, count).sort();
}

function isQuotaAnchoredWindowKey(key) {
  return key === '5h' || key === 'week' || key === 'cycle' || String(key || '').includes(':');
}

function sameUsageWindows(previous, current, dates, quotaDates = dates) {
  return previous.length === current.length && current.every((window, index) => {
    const before = previous[index];
    const refDates = isQuotaAnchoredWindowKey(window.key) ? quotaDates : dates;
    return before.key === window.key && before.label === window.label &&
      (before.startMs === window.startMs ||
        usageTimestampBoundary(refDates, before.startMs, false) ===
          usageTimestampBoundary(refDates, window.startMs, false)) &&
      (before.endMs === window.endMs ||
        usageTimestampBoundary(refDates, before.endMs, true) ===
          usageTimestampBoundary(refDates, window.endMs, true));
  });
}

/**
 * 聚合所有预设时间窗口、当前选定窗口、趋势图、年度月序列、来源占比与分模型统计。
 *
 * @param {{
 *   filterOpts?: { range?: string, startMs?: number, endMs?: number },
 *   cycleAnchors?: { fiveHourResetMs?: number, weeklyResetMs?: number },
 *   currentAccountName?: string|null,
 *   activeCascadeId?: string|null,
 *   activeFamilyCascadeIds?: Set<string>|null,
 *   resolveStepModel: StepModelResolver
 *   modelInputs?: { catalogRevision: number, dynamicModelMap: Map }
 * }} params
 */
export function aggregateMultiWindowUsage({
  filterOpts = {},
  cycleAnchors = {},
  isCustomWeeklyMode = false,
  currentAccountName = '',
  activeCascadeId = null,
  activeFamilyCascadeIds = null,
  resolveStepModel,
  quotaPoolsMap = null,
  modelInputs = null,
  endpoint = null,
}) {
  const isRemote = Boolean(endpoint && endpoint.isRemote);
  const endpointKey = isRemote ? String(endpoint.id || 'remote') : 'local';
  const rawFamilyIds =
    activeFamilyCascadeIds instanceof Set
      ? Array.from(activeFamilyCascadeIds)
      : activeCascadeId
        ? [activeCascadeId]
        : [];
  const familySet = new Set(rawFamilyIds.map((id) => String(id || '').toLowerCase()));
  const nowMs = Date.now();
  const selectedWindow = resolveTimeWindow(
    filterOpts.range || 'all',
    filterOpts.startMs,
    filterOpts.endMs,
    nowMs,
    cycleAnchors,
    isCustomWeeklyMode
  );

  const presetKeys = ['all', 'cycle', '5h', 'today', '24h', 'week', '7d', '14d', '30d'];
  const presetWindows = {};
  const accountBuckets = {};
  const sessionBuckets = {};

  for (const k of presetKeys) {
    presetWindows[k] = resolveTimeWindow(k, 0, 0, nowMs, cycleAnchors, isCustomWeeklyMode);
    accountBuckets[k] = createUsageBucket();
    sessionBuckets[k] = createUsageBucket();
  }

  // 为每个配额池建立独立的 5h 与周限周期统计桶（按各池自身的 resetTime / weeklyResetTime 截取窗口）
  const poolCycleBuckets = buildQuotaPoolCycleMap(quotaPoolsMap, nowMs);
  const hasDedicatedCarbonPool = poolCycleBuckets.has('Carbon');
  const hasDedicatedArgonPool = poolCycleBuckets.has('Argon');
  const poolByModel = new Map();
  const quotaWeekBucket = createUsageBucket();
  const normalizedQuotaAccount =
    currentAccountName === null ? null : normalizeOwnerAccount(currentAccountName);
  const selectedAccountBucket = accountBuckets[selectedWindow.key] || createUsageBucket();
  const selectedSessionBucket = sessionBuckets[selectedWindow.key] || createUsageBucket();
  const perModelStats = new Map();
  const selectedWindowSteps = [];
  let earliestSelectedStepMs = Infinity;
  let latestSelectedStepMs = 0;
  let earliestActiveCyclePoolStartMs = Infinity;

  const currentYear = new Date(nowMs).getFullYear();
  const monthBoundsMs = Array.from({ length: 13 }, (_, idx) =>
    new Date(currentYear, idx, 1).getTime()
  );
  const yearStartMs = monthBoundsMs[0];
  const nextYearStartMs = monthBoundsMs[12];
  const monthlySeries = Array.from({ length: 12 }, (_, idx) => ({
    month: idx + 1,
    label: `${idx + 1}月`,
    calls: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    responseTokens: 0,
    thinkingTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    unpricedCalls: 0,
    perModelStats: new Map(),
  }));

  const perSourceStats = new Map();
  const allEntriesToAggregate = collectUsageEntriesToAggregate(familySet, endpoint);
  const familySig = buildFamilySig(familySet);

  const timeZone = modelInputs ? new Intl.DateTimeFormat().resolvedOptions().timeZone : '';
  const quotaWindows = Array.from(poolCycleBuckets, ([key, { start5hMs, startWkMs }]) => [
    { key: `${key}:5h`, startMs: start5hMs, endMs: nowMs },
    { key: `${key}:week`, startMs: startWkMs, endMs: nowMs },
  ]).flat();
  const windows = [selectedWindow, ...Object.values(presetWindows), ...quotaWindows];
  const snapshot = lastUsageSnapshotsByEndpoint.get(endpointKey) || null;
  const sameSnapshot = modelInputs && snapshot && timeZone === snapshot.timeZone &&
    currentYear === snapshot.currentYear &&
    Boolean(isCustomWeeklyMode) === Boolean(snapshot.isCustomWeeklyMode) &&
    normalizedQuotaAccount === snapshot.normalizedQuotaAccount &&
    modelInputs.catalogRevision === snapshot.modelInputs.catalogRevision &&
    isDeepStrictEqual(modelInputs.dynamicModelMap, snapshot.modelInputs.dynamicModelMap) &&
    sameUsageEntries(snapshot.entries, allEntriesToAggregate);
  const previous = sameSnapshot ? snapshot.ranges.get(selectedWindow.key) : null;
  if (previous) {
    // 时钟继续前进，只有实际有步骤跨过窗口边界时才重新聚合。
    const effectivePrevWin =
      selectedWindow.key === 'cycle' && previous.effectiveSelectedWindow
        ? { ...previous.effectiveSelectedWindow, endMs: nowMs }
        : selectedWindow;
    const trend = planUsageTrend(effectivePrevWin, nowMs, previous.earliest, previous.latest);
    if (
      trend.hourly === previous.trend.hourly && trend.first === previous.trend.first &&
      trend.last === previous.trend.last &&
      sameUsageWindows(
        previous.windows,
        windows,
        (snapshot.dates ??= sortedUsageTimestamps(allEntriesToAggregate)),
        (snapshot.quotaDates ??= sortedQuotaBillingTimestamps(allEntriesToAggregate, nowMs))
      )
    ) {
      snapshot.ranges.delete(selectedWindow.key);
      snapshot.ranges.set(selectedWindow.key, previous);
      if (previous.familySig === familySig) {
        return {
          ...previous.result,
          usageRevision: snapshot.revision,
          selectedWindow: effectivePrevWin,
          trendStartMs: trend.start,
          trendEndMs: trend.end,
        };
      }
      const { finalizedSelectedSession: nextSelSession, sessionPresets } =
        computeFamilySessionBuckets({
          entries: allEntriesToAggregate,
          familySet,
          presetKeys,
          presetWindows,
          selectedWindow,
          isCustomWeeklyMode,
          poolCycleBuckets,
          normalizedQuotaAccount,
          nowMs,
          resolveStepModel,
        });
      const prevPresets = previous.result.finalizedPresets || {};
      const nextFinalizedPresets = {};
      for (const k of presetKeys) {
        nextFinalizedPresets[k] = {
          ...(prevPresets[k] || { label: presetWindows[k].label }),
          session: sessionPresets[k],
        };
      }
      return {
        ...previous.result,
        usageRevision: snapshot.revision,
        selectedWindow: effectivePrevWin,
        trendStartMs: trend.start,
        trendEndMs: trend.end,
        finalizedSelectedSession: nextSelSession,
        finalizedPresets: nextFinalizedPresets,
      };
    }
  }

  for (const entry of allEntriesToAggregate) {
    const { cascadeId, isCurrentConv } = entry;
    const entryOwner = normalizeOwnerAccount(entry.accountName);
    const srcKey = entry.appSource || 'standalone';
    const srcName = USAGE_SOURCE_LABELS[srcKey] || `Antigravity (${srcKey})`;

    const entrySteps = entry.steps || [];
    for (let sIdx = 0; sIdx < entrySteps.length; sIdx++) {
      const st = entrySteps[sIdx];
      if (!st || typeof st !== 'object') continue;
      const nextSt = entrySteps[sIdx + 1] || null;
      const stepOwner = normalizeOwnerAccount(st.accountName) || entryOwner;
      const includeInQuotaPools =
        normalizedQuotaAccount === null
          ? false
          : normalizedQuotaAccount === '' || stepOwner === ''
            ? true
            : stepOwner === normalizedQuotaAccount;
      const mInfo = resolveStepModel(st);
      const inTok = safeTok(st.inputTokens);
      const cacheTok = safeTok(st.cacheReadTokens);
      const outTok = safeTok(st.outputTokens);
      const thinkTok = safeTok(st.thinkingTokens);
      const respTok =
        st.responseTokens !== undefined && st.responseTokens !== null
          ? safeTok(st.responseTokens)
          : Math.max(0, outTok - thinkTok);
      const stepTotalTokens = inTok + cacheTok + outTok;
      const stepCost = computeStepCost(st, mInfo.pricing);
      const resolvedCost = Number.isFinite(stepCost) ? stepCost : 0;
      const unpriced = stepCost === null ? 1 : 0;
      const tMs = Number(st.createdAtMs) > 0 ? Number(st.createdAtMs) : 0;
      const qMs = resolveStepQuotaBillingMs(st, nextSt, nowMs);
      const savedCost = mInfo.pricing
        ? (cacheTok / 1_000_000) * Math.max(0, mInfo.pricing.input - mInfo.pricing.cache)
        : 0;
      const stepUsage = { inTok, cacheTok, outTok, thinkTok, respTok, stepTotalTokens,
        resolvedCost, savedCost, unpriced };

      if (tMs >= yearStartMs && tMs < nextYearStartMs) {
        let monthIdx = 11;
        for (let m = 0; m < 12; m++) {
          if (tMs < monthBoundsMs[m + 1]) {
            monthIdx = m;
            break;
          }
        }
        const mBucket = monthlySeries[monthIdx];
        if (mBucket) {
          mBucket.calls += 1;
          mBucket.inputTokens += inTok;
          mBucket.cacheReadTokens += cacheTok;
          mBucket.responseTokens += respTok;
          mBucket.thinkingTokens += thinkTok;
          mBucket.totalTokens += stepTotalTokens;
          mBucket.costUsd += resolvedCost;
          mBucket.unpricedCalls = (mBucket.unpricedCalls || 0) + unpriced;
          accumulateStepIntoModelMap(mBucket.perModelStats, st, mInfo, stepCost);
        }
      }

      const poolBucketEntry = resolvePoolBucketForStep(
        st,
        mInfo,
        poolCycleBuckets,
        poolByModel,
        hasDedicatedCarbonPool,
        hasDedicatedArgonPool
      );

      if (includeInQuotaPools && poolBucketEntry && qMs > 0 && qMs <= nowMs) {
        if (qMs >= poolBucketEntry.start5hMs) {
          accumulateStepIntoBucket(poolBucketEntry.b5h, stepUsage, cascadeId);
        }
        if (qMs >= poolBucketEntry.startWkMs) {
          accumulateStepIntoBucket(poolBucketEntry.bWk, stepUsage, cascadeId);
        }
      }

      let inCurrentCycle = false;
      if (qMs > 0 && qMs <= nowMs) {
        if (isCustomWeeklyMode) {
          inCurrentCycle = tMs >= presetWindows.week.startMs;
        } else if (poolCycleBuckets.size > 0) {
          const effCycleStartMs = poolBucketEntry
            ? poolBucketEntry.startWkMs
            : presetWindows.cycle.startMs;
          inCurrentCycle = includeInQuotaPools && qMs >= effCycleStartMs;
        } else {
          inCurrentCycle = includeInQuotaPools && qMs >= presetWindows.cycle.startMs;
        }
      }

      for (const k of presetKeys) {
        const w = presetWindows[k];
        const cmpMs = k === '5h' || k === 'week' ? qMs : tMs;
        const matchesPreset =
          k === 'all'
            ? true
            : k === 'cycle'
              ? inCurrentCycle
              : cmpMs > 0 && cmpMs >= w.startMs && cmpMs <= w.endMs;
        if (matchesPreset) {
          accumulateStepIntoBucket(accountBuckets[k], stepUsage, cascadeId);
          if (isCurrentConv) {
            accumulateStepIntoBucket(sessionBuckets[k], stepUsage, cascadeId);
          }
          if (k === 'week' && includeInQuotaPools) {
            accumulateStepIntoBucket(quotaWeekBucket, stepUsage, cascadeId);
          }
        }
      }

      const selCmpMs =
        selectedWindow.key === '5h' || selectedWindow.key === 'week' ? qMs : tMs;
      const inSelectedWindow =
        selectedWindow.key === 'all'
          ? true
          : selectedWindow.key === 'cycle'
            ? inCurrentCycle
            : selCmpMs > 0 && selCmpMs >= selectedWindow.startMs && selCmpMs <= selectedWindow.endMs;

      if (inSelectedWindow) {
        if (
          selectedWindow.key === 'cycle' &&
          !isCustomWeeklyMode &&
          poolBucketEntry &&
          poolBucketEntry.startWkMs < earliestActiveCyclePoolStartMs
        ) {
          earliestActiveCyclePoolStartMs = poolBucketEntry.startWkMs;
        }
        if (selectedWindow.key === 'custom') {
          accumulateStepIntoBucket(selectedAccountBucket, stepUsage, cascadeId);
          if (isCurrentConv) {
            accumulateStepIntoBucket(selectedSessionBucket, stepUsage, cascadeId);
          }
        }
        if (tMs > 0) {
          if (tMs < earliestSelectedStepMs) earliestSelectedStepMs = tMs;
          if (tMs > latestSelectedStepMs && tMs <= MAX_TREND_TIMESTAMP_MS) latestSelectedStepMs = tMs;
          selectedWindowSteps.push({
            tMs,
            tokens: stepTotalTokens,
            inputTokens: inTok,
            cacheReadTokens: cacheTok,
            outputTokens: outTok,
            costUsd: resolvedCost,
            unpricedCalls: unpriced,
            mInfo,
            responseModel: st.responseModel || '',
          });
        }

        if (!perSourceStats.has(srcKey)) {
          perSourceStats.set(srcKey, {
            name: srcName,
            calls: 0,
            inputTokens: 0,
            cacheReadTokens: 0,
            responseTokens: 0,
            thinkingTokens: 0,
            totalTokens: 0,
            costUsd: 0,
            perModelStats: new Map(),
          });
        }
        const sAgg = perSourceStats.get(srcKey);
        sAgg.calls += 1;
        sAgg.inputTokens += inTok;
        sAgg.cacheReadTokens += cacheTok;
        sAgg.responseTokens += respTok;
        sAgg.thinkingTokens += thinkTok;
        sAgg.totalTokens += stepTotalTokens;
        sAgg.costUsd += resolvedCost;
        sAgg.unpricedCalls = (sAgg.unpricedCalls || 0) + unpriced;
        accumulateStepIntoModelMap(sAgg.perModelStats, st, mInfo, stepCost);

        accumulateStepIntoModelMap(perModelStats, st, mInfo, stepCost);
      }
    }
  }

  const finalizedMonthlySeries = monthlySeries.map(
    ({ perModelStats: monthModelMap, ...mBucket }) => ({
      ...mBucket,
      costUsd: +mBucket.costUsd.toFixed(4),
      models: finalizeModelBreakdownMap(monthModelMap),
    })
  );

  // 构建当前选定时间窗口的自适应自然整点/整日趋势序列 (trendSeries)
  const effectiveSelectedWindow =
    selectedWindow.key === 'cycle' &&
    Number.isFinite(earliestActiveCyclePoolStartMs) &&
    earliestActiveCyclePoolStartMs < Infinity
      ? {
          ...selectedWindow,
          startMs: Math.min(earliestActiveCyclePoolStartMs, earliestSelectedStepMs),
        }
      : selectedWindow;
  const { trend, trendStartMs, trendEndMs, trendSeries } = buildUsageTrendSeries(
    selectedWindow,
    effectiveSelectedWindow,
    selectedWindowSteps,
    nowMs,
    earliestSelectedStepMs,
    latestSelectedStepMs
  );

  const finalizedPresets = {};
  for (const k of presetKeys) {
    finalizedPresets[k] = {
      label: presetWindows[k].label,
      session: finalizeUsageBucket(sessionBuckets[k]),
      account: finalizeUsageBucket(accountBuckets[k]),
    };
  }

  const finalizedSelectedSession = finalizeUsageBucket(selectedSessionBucket);
  const finalizedSelectedAccount = finalizeUsageBucket(selectedAccountBucket);

  const sourcesBreakdown = Array.from(perSourceStats.values())
    .filter((s) => s.totalTokens > 0 || s.calls > 0)
    .map(({ perModelStats: sourceModelMap, ...s }) => ({
      ...s,
      costUsd: +s.costUsd.toFixed(2),
      models: finalizeModelBreakdownMap(sourceModelMap),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls);

  const todayBucket = finalizedPresets.today.account;
  const weekBucket = finalizedPresets.week.account;
  const finalizedQuotaWeekBucket = finalizeUsageBucket(quotaWeekBucket);
  const modelBreakdown = finalizeModelBreakdownMap(perModelStats);

  const formatCycleSummary = (b) => {
    const fin = finalizeUsageBucket(b);
    return {
      calls: fin.calls,
      tokens: fin.totalTokens,
      inputTokens: fin.inputTokens,
      cacheReadTokens: fin.cacheReadTokens,
      outputTokens: fin.outputTokens,
      costUsd: fin.costUsd,
      unpricedCalls: fin.unpricedCalls,
    };
  };

  const poolCycleStats = new Map();
  let rawPoolsWeeklyCalls = 0;
  let rawPoolsWeeklyTokens = 0;
  let rawPoolsWeeklyCostUsd = 0;
  let rawPoolsWeeklyUnpricedCalls = 0;
  for (const [poolKey, entry] of poolCycleBuckets.entries()) {
    poolCycleStats.set(poolKey, {
      cycle5h: formatCycleSummary(entry.b5h),
      cycleWeekly: formatCycleSummary(entry.bWk),
    });
    rawPoolsWeeklyCalls += entry.bWk.calls;
    rawPoolsWeeklyTokens += entry.bWk.totalTokens;
    rawPoolsWeeklyCostUsd += entry.bWk.costUsd;
    rawPoolsWeeklyUnpricedCalls += entry.bWk.unpricedCalls || 0;
  }
  const poolsWeeklySummary =
    poolCycleBuckets.size > 0
      ? {
          calls: rawPoolsWeeklyCalls,
          tokens: rawPoolsWeeklyTokens,
          costUsd: +rawPoolsWeeklyCostUsd.toFixed(2),
          unpricedCalls: rawPoolsWeeklyUnpricedCalls,
        }
      : null;

  let resolvedUsageRevision = usageSnapshotRevisionSeq;
  let activeSnap = snapshot;
  if (modelInputs) {
    if (!sameSnapshot) {
      resolvedUsageRevision = ++usageSnapshotRevisionSeq;
      activeSnap = {
        revision: resolvedUsageRevision,
        timeZone,
        modelInputs,
        currentYear,
        isCustomWeeklyMode: Boolean(isCustomWeeklyMode),
        normalizedQuotaAccount,
        entries: allEntriesToAggregate,
        dates: null,
        ranges: new Map(),
        selectedRanges: new Map(),
      };
      lastUsageSnapshotsByEndpoint.delete(endpointKey);
      if (lastUsageSnapshotsByEndpoint.size >= MAX_USAGE_SNAPSHOT_ENDPOINTS) {
        const oldestKey = lastUsageSnapshotsByEndpoint.keys().next().value;
        if (oldestKey !== undefined) lastUsageSnapshotsByEndpoint.delete(oldestKey);
      }
      lastUsageSnapshotsByEndpoint.set(endpointKey, activeSnap);
    } else {
      resolvedUsageRevision = activeSnap.revision;
    }
  } else {
    resolvedUsageRevision = ++usageSnapshotRevisionSeq;
  }

  const result = {
    usageRevision: resolvedUsageRevision,
    selectedWindow: effectiveSelectedWindow,
    trendStartMs,
    trendEndMs,
    finalizedSelectedSession,
    finalizedSelectedAccount,
    finalizedPresets,
    trendSeries,
    sourcesBreakdown,
    currentYear,
    monthlySeries: finalizedMonthlySeries,
    todayBucket,
    weekBucket,
    quotaWeekBucket: finalizedQuotaWeekBucket,
    modelBreakdown,
    poolCycleStats,
    poolsWeeklySummary,
  };
  if (modelInputs && activeSnap) {
    const { ranges } = activeSnap;
    ranges.delete(selectedWindow.key);
    ranges.set(selectedWindow.key, {
      familySig,
      windows,
      selectedWindow,
      effectiveSelectedWindow,
      trend,
      result,
      earliest: earliestSelectedStepMs,
      latest: latestSelectedStepMs,
    });
    // 缓存各时间窗口的完整多窗口聚合结果，同快照复用时亚毫秒命中。
    if (ranges.size > 10) ranges.delete(ranges.keys().next().value);
  }
  return result;
}

/**
 * 轻量级单时间窗口剪枝聚合器（专为 `scope=consumption` / `scope=consumption-presets` 瞬切服务）：
 * 1. 跳过 12 个月年度柱、9 预设桶与配额池 5h/周统计；
 * 2. 基于会话级 `[minMs, maxMs]` 边界直接跳过时间完全不重叠的历史会话；
 * 3. 与 `aggregateMultiWindowUsage` 共用完全一致的周期锚点、来源/模型归并及趋势分桶逻辑。
 */
export function aggregateSelectedWindowUsage({
  filterOpts = {},
  cycleAnchors = {},
  isCustomWeeklyMode = false,
  currentAccountName = '',
  activeCascadeId = null,
  activeFamilyCascadeIds = null,
  resolveStepModel,
  quotaPoolsMap = null,
  modelInputs = null,
  precollectedEntries = null,
  endpoint = null,
}) {
  const isRemote = Boolean(endpoint && endpoint.isRemote);
  const endpointKey = isRemote ? String(endpoint.id || 'remote') : 'local';
  const rawFamilyIds =
    activeFamilyCascadeIds instanceof Set
      ? Array.from(activeFamilyCascadeIds)
      : activeCascadeId
        ? [activeCascadeId]
        : [];
  const familySet = new Set(rawFamilyIds.map((id) => String(id || '').toLowerCase()));
  const nowMs = Date.now();
  const selectedWindow = resolveTimeWindow(
    filterOpts.range || 'all',
    filterOpts.startMs,
    filterOpts.endMs,
    nowMs,
    cycleAnchors,
    isCustomWeeklyMode
  );
  const weekStartMs =
    selectedWindow.key === 'cycle'
      ? resolveTimeWindow('week', 0, 0, nowMs, cycleAnchors, isCustomWeeklyMode).startMs
      : 0;
  const poolCycleBuckets =
    selectedWindow.key === 'cycle' ? buildQuotaPoolCycleMap(quotaPoolsMap, nowMs) : new Map();
  const hasDedicatedCarbonPool = poolCycleBuckets.has('Carbon');
  const hasDedicatedArgonPool = poolCycleBuckets.has('Argon');
  const poolByModel = new Map();
  const normalizedQuotaAccount =
    currentAccountName === null ? null : normalizeOwnerAccount(currentAccountName);

  const allEntriesToAggregate = Array.isArray(precollectedEntries)
    ? precollectedEntries
    : collectUsageEntriesToAggregate(familySet, endpoint);
  const familySig = buildFamilySig(familySet);
  const currentYear = new Date(nowMs).getFullYear();
  const timeZone = modelInputs ? new Intl.DateTimeFormat().resolvedOptions().timeZone : '';

  const snapshot = lastUsageSnapshotsByEndpoint.get(endpointKey) || null;
  const sameSnapshot = Boolean(
    modelInputs &&
      snapshot &&
      timeZone === snapshot.timeZone &&
      currentYear === snapshot.currentYear &&
      Boolean(isCustomWeeklyMode) === Boolean(snapshot.isCustomWeeklyMode) &&
      normalizedQuotaAccount === snapshot.normalizedQuotaAccount &&
      modelInputs.catalogRevision === snapshot.modelInputs.catalogRevision &&
      isDeepStrictEqual(modelInputs.dynamicModelMap, snapshot.modelInputs.dynamicModelMap) &&
      sameUsageEntries(snapshot.entries, allEntriesToAggregate)
  );

  if (sameSnapshot) {
    snapshot.selectedRanges ??= new Map();
    const cachedFull = snapshot.ranges.get(selectedWindow.key);
    const cachedLite = snapshot.selectedRanges.get(selectedWindow.key);
    const candidate = cachedFull || cachedLite;
    if (candidate) {
      const prevWin = candidate.selectedWindow || candidate.windows?.[0] || selectedWindow;
      const effectivePrevWin =
        selectedWindow.key === 'cycle' && candidate.effectiveSelectedWindow
          ? { ...candidate.effectiveSelectedWindow, endMs: nowMs }
          : selectedWindow;
      const trend = planUsageTrend(effectivePrevWin, nowMs, candidate.earliest, candidate.latest);
      if (
        trend.hourly === candidate.trend.hourly &&
        trend.first === candidate.trend.first &&
        trend.last === candidate.trend.last &&
        sameUsageWindows(
          [prevWin],
          [selectedWindow],
          (snapshot.dates ??= sortedUsageTimestamps(allEntriesToAggregate)),
          (snapshot.quotaDates ??= sortedQuotaBillingTimestamps(allEntriesToAggregate, nowMs))
        )
      ) {
        const res = candidate.result;
        const resolvedSelectedSession =
          candidate.familySig === familySig
            ? res.finalizedSelectedSession
            : computeFamilySessionBuckets({
                entries: allEntriesToAggregate,
                familySet,
                presetKeys: [],
                presetWindows: {},
                selectedWindow,
                isCustomWeeklyMode,
                poolCycleBuckets,
                normalizedQuotaAccount,
                nowMs,
                resolveStepModel,
                weekStartMs,
              }).finalizedSelectedSession;
        return {
          usageRevision: snapshot.revision,
          selectedWindow: effectivePrevWin,
          trendStartMs: trend.start,
          trendEndMs: trend.end,
          finalizedSelectedSession: resolvedSelectedSession,
          finalizedSelectedAccount: res.finalizedSelectedAccount,
          trendSeries: res.trendSeries,
          sourcesBreakdown: res.sourcesBreakdown,
          modelBreakdown: res.modelBreakdown,
        };
      }
    }
  }

  const maxSettlementSlackMs = Math.max(
    COMPACTION_QUOTA_SETTLE_MAX_MS,
    STEP_QUOTA_DURATION_CAP_SEC * 1000
  );
  let minCutoffMs = 0;
  let maxCutoffMs = Infinity;
  let canPruneByTime = false;
  if (selectedWindow.key === 'cycle') {
    canPruneByTime = true;
    maxCutoffMs = nowMs;
    if (isCustomWeeklyMode) {
      minCutoffMs = weekStartMs;
    } else if (poolCycleBuckets.size > 0) {
      minCutoffMs = selectedWindow.startMs;
      for (const entry of poolCycleBuckets.values()) {
        if (entry.startWkMs < minCutoffMs) minCutoffMs = entry.startWkMs;
      }
      minCutoffMs = Math.max(0, minCutoffMs - maxSettlementSlackMs);
    } else {
      minCutoffMs = Math.max(0, selectedWindow.startMs - maxSettlementSlackMs);
    }
  } else if (selectedWindow.key === '5h' || selectedWindow.key === 'week') {
    canPruneByTime = true;
    minCutoffMs = Math.max(0, selectedWindow.startMs - maxSettlementSlackMs);
    maxCutoffMs = selectedWindow.endMs;
  } else if (selectedWindow.key !== 'all') {
    canPruneByTime = true;
    minCutoffMs = selectedWindow.startMs;
    maxCutoffMs = selectedWindow.endMs;
  }

  const selectedAccountBucket = createUsageBucket();
  const selectedSessionBucket = createUsageBucket();
  const perModelStats = new Map();
  const perSourceStats = new Map();
  const selectedWindowSteps = [];
  let earliestSelectedStepMs = Infinity;
  let latestSelectedStepMs = 0;
  let earliestActiveCyclePoolStartMs = Infinity;

  for (const entry of allEntriesToAggregate) {
    const steps = entry.steps || [];
    if (steps.length === 0) continue;
    if (canPruneByTime) {
      const bounds = getStepsTimeBounds(steps);
      if (bounds.maxMs <= 0 || bounds.maxMs < minCutoffMs || bounds.minMs > maxCutoffMs) {
        continue;
      }
    }
    const { cascadeId, isCurrentConv } = entry;
    const entryOwner = normalizeOwnerAccount(entry.accountName);
    const srcKey = entry.appSource || 'standalone';
    const srcName = USAGE_SOURCE_LABELS[srcKey] || `Antigravity (${srcKey})`;

    for (let sIdx = 0; sIdx < steps.length; sIdx++) {
      const st = steps[sIdx];
      if (!st || typeof st !== 'object') continue;
      const nextSt = steps[sIdx + 1] || null;
      const tMs = Number(st.createdAtMs) > 0 ? Number(st.createdAtMs) : 0;
      const qMs = resolveStepQuotaBillingMs(st, nextSt, nowMs);
      const isQuotaWin =
        selectedWindow.key === 'cycle' ||
        selectedWindow.key === '5h' ||
        selectedWindow.key === 'week';
      const effStepMs = isQuotaWin && !(selectedWindow.key === 'cycle' && isCustomWeeklyMode) ? qMs : tMs;
      if (canPruneByTime && (effStepMs <= 0 || effStepMs < minCutoffMs || effStepMs > maxCutoffMs)) {
        continue;
      }
      if (
        (selectedWindow.key === '5h' || selectedWindow.key === 'week') &&
        effStepMs < selectedWindow.startMs
      ) {
        continue;
      }

      let poolBucketEntry = null;
      let mInfo = null;
      if (selectedWindow.key === 'cycle') {
        const stepOwner = normalizeOwnerAccount(st.accountName) || entryOwner;
        const includeInQuotaPools =
          normalizedQuotaAccount === null
            ? false
            : normalizedQuotaAccount === '' || stepOwner === ''
              ? true
              : stepOwner === normalizedQuotaAccount;
        let inCurrentCycle = false;
        if (isCustomWeeklyMode) {
          inCurrentCycle = tMs >= weekStartMs;
        } else if (poolCycleBuckets.size > 0) {
          if (!includeInQuotaPools) continue;
          mInfo = resolveStepModel(st);
          poolBucketEntry = resolvePoolBucketForStep(
            st,
            mInfo,
            poolCycleBuckets,
            poolByModel,
            hasDedicatedCarbonPool,
            hasDedicatedArgonPool
          );
          const effCycleStartMs = poolBucketEntry
            ? poolBucketEntry.startWkMs
            : selectedWindow.startMs;
          inCurrentCycle = qMs >= effCycleStartMs;
        } else {
          inCurrentCycle = includeInQuotaPools && qMs >= selectedWindow.startMs;
        }
        if (!inCurrentCycle) continue;
        if (
          !isCustomWeeklyMode &&
          poolBucketEntry &&
          poolBucketEntry.startWkMs < earliestActiveCyclePoolStartMs
        ) {
          earliestActiveCyclePoolStartMs = poolBucketEntry.startWkMs;
        }
      }

      mInfo ??= resolveStepModel(st);
      const inTok = safeTok(st.inputTokens);
      const cacheTok = safeTok(st.cacheReadTokens);
      const outTok = safeTok(st.outputTokens);
      const thinkTok = safeTok(st.thinkingTokens);
      const respTok =
        st.responseTokens !== undefined && st.responseTokens !== null
          ? safeTok(st.responseTokens)
          : Math.max(0, outTok - thinkTok);
      const stepTotalTokens = inTok + cacheTok + outTok;
      const stepCost = computeStepCost(st, mInfo.pricing);
      const resolvedCost = Number.isFinite(stepCost) ? stepCost : 0;
      const unpriced = stepCost === null ? 1 : 0;
      const savedCost = mInfo.pricing
        ? (cacheTok / 1_000_000) * Math.max(0, mInfo.pricing.input - mInfo.pricing.cache)
        : 0;
      const stepUsage = {
        inTok,
        cacheTok,
        outTok,
        thinkTok,
        respTok,
        stepTotalTokens,
        resolvedCost,
        savedCost,
        unpriced,
      };

      accumulateStepIntoBucket(selectedAccountBucket, stepUsage, cascadeId);
      if (isCurrentConv) {
        accumulateStepIntoBucket(selectedSessionBucket, stepUsage, cascadeId);
      }

      if (tMs > 0) {
        if (tMs < earliestSelectedStepMs) earliestSelectedStepMs = tMs;
        if (tMs > latestSelectedStepMs && tMs <= MAX_TREND_TIMESTAMP_MS) latestSelectedStepMs = tMs;
        selectedWindowSteps.push({
          tMs,
          tokens: stepTotalTokens,
          inputTokens: inTok,
          cacheReadTokens: cacheTok,
          outputTokens: outTok,
          costUsd: resolvedCost,
          unpricedCalls: unpriced,
          mInfo,
          responseModel: st.responseModel || '',
        });
      }

      if (!perSourceStats.has(srcKey)) {
        perSourceStats.set(srcKey, {
          name: srcName,
          calls: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          responseTokens: 0,
          thinkingTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          perModelStats: new Map(),
        });
      }
      const sAgg = perSourceStats.get(srcKey);
      sAgg.calls += 1;
      sAgg.inputTokens += inTok;
      sAgg.cacheReadTokens += cacheTok;
      sAgg.responseTokens += respTok;
      sAgg.thinkingTokens += thinkTok;
      sAgg.totalTokens += stepTotalTokens;
      sAgg.costUsd += resolvedCost;
      sAgg.unpricedCalls = (sAgg.unpricedCalls || 0) + unpriced;
      accumulateStepIntoModelMap(sAgg.perModelStats, st, mInfo, stepCost);

      accumulateStepIntoModelMap(perModelStats, st, mInfo, stepCost);
    }
  }

  const effectiveSelectedWindow =
    selectedWindow.key === 'cycle' &&
    Number.isFinite(earliestActiveCyclePoolStartMs) &&
    earliestActiveCyclePoolStartMs < Infinity
      ? {
          ...selectedWindow,
          startMs: Math.min(earliestActiveCyclePoolStartMs, earliestSelectedStepMs),
        }
      : selectedWindow;

  const { trend, trendStartMs, trendEndMs, trendSeries } = buildUsageTrendSeries(
    selectedWindow,
    effectiveSelectedWindow,
    selectedWindowSteps,
    nowMs,
    earliestSelectedStepMs,
    latestSelectedStepMs
  );

  const finalizedSelectedSession = finalizeUsageBucket(selectedSessionBucket);
  const finalizedSelectedAccount = finalizeUsageBucket(selectedAccountBucket);
  const sourcesBreakdown = Array.from(perSourceStats.values())
    .filter((s) => s.totalTokens > 0 || s.calls > 0)
    .map(({ perModelStats: sourceModelMap, ...s }) => ({
      ...s,
      costUsd: +s.costUsd.toFixed(2),
      models: finalizeModelBreakdownMap(sourceModelMap),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls);
  const modelBreakdown = finalizeModelBreakdownMap(perModelStats);

  const sliceResult = {
    usageRevision: sameSnapshot ? snapshot.revision : usageSnapshotRevisionSeq,
    selectedWindow: effectiveSelectedWindow,
    trendStartMs,
    trendEndMs,
    finalizedSelectedSession,
    finalizedSelectedAccount,
    trendSeries,
    sourcesBreakdown,
    modelBreakdown,
  };

  if (sameSnapshot) {
    snapshot.selectedRanges ??= new Map();
    snapshot.selectedRanges.delete(selectedWindow.key);
    snapshot.selectedRanges.set(selectedWindow.key, {
      familySig,
      selectedWindow,
      effectiveSelectedWindow,
      trend,
      result: sliceResult,
      earliest: earliestSelectedStepMs,
      latest: latestSelectedStepMs,
    });
    if (snapshot.selectedRanges.size > 12) {
      snapshot.selectedRanges.delete(snapshot.selectedRanges.keys().next().value);
    }
  }

  return sliceResult;
}

/**
 * 轻量级单会话家族用量汇总（专为 `scope=conversation` 瞬切服务）：
 * 仅遍历当前选中根会话及其子代理步骤，不触碰其余历史会话与全局账户聚合缓存。
 */
export function aggregateSessionUsageForFamily({
  filterOpts = {},
  cycleAnchors = {},
  isCustomWeeklyMode = false,
  currentAccountName = '',
  activeCascadeId = null,
  activeFamilyCascadeIds = null,
  resolveStepModel,
  quotaPoolsMap = null,
  endpoint = null,
}) {
  const isRemote = Boolean(endpoint && endpoint.isRemote);
  const cacheStore = getEndpointCacheStore(endpoint);
  const rawFamilyIds =
    activeFamilyCascadeIds instanceof Set
      ? Array.from(activeFamilyCascadeIds)
      : activeCascadeId
        ? [activeCascadeId]
        : [];
  const familySet = new Set(rawFamilyIds.map((id) => String(id || '').toLowerCase()).filter(Boolean));
  const nowMs = Date.now();
  const selectedWindow = resolveTimeWindow(
    filterOpts.range || 'all',
    filterOpts.startMs,
    filterOpts.endMs,
    nowMs,
    cycleAnchors,
    isCustomWeeklyMode
  );
  const presetKeys = ['all', 'cycle', '5h', 'today', '24h', 'week', '7d', '14d', '30d'];
  const presetWindows = {};
  for (const k of presetKeys) {
    presetWindows[k] = resolveTimeWindow(k, 0, 0, nowMs, cycleAnchors, isCustomWeeklyMode);
  }
  const poolCycleBuckets = buildQuotaPoolCycleMap(quotaPoolsMap, nowMs);
  const normalizedQuotaAccount =
    currentAccountName === null ? null : normalizeOwnerAccount(currentAccountName);

  const familyEntries = [];
  for (const [cid, entry] of cacheStore.listCachedTrajectoryEntries()) {
    if (!entry || !Array.isArray(entry.steps) || entry.steps.length === 0) continue;
    const cidLower = String(cid || '').toLowerCase();
    if (!familySet.has(cidLower)) continue;
    familyEntries.push({
      cascadeId: cid,
      appSource: isRemote ? 'ssh' : entry.appSource || 'standalone',
      accountName: entry.accountName || '',
      steps: entry.steps,
      isCurrentConv: true,
    });
  }

  return computeFamilySessionBuckets({
    entries: familyEntries,
    familySet,
    presetKeys,
    presetWindows,
    selectedWindow,
    isCustomWeeklyMode,
    poolCycleBuckets,
    normalizedQuotaAccount,
    nowMs,
    resolveStepModel,
  });
}

/**
 * 批量预聚合全部 7 个用量页预设区间（复用同一次条目收集与时间剪枝），供前端进入「用量统计」时静默预取实现 0ms 瞬切。
 */
export function aggregateConsumptionPresetBundle(params) {
  const { activeCascadeId = null, activeFamilyCascadeIds = null, endpoint = null } = params || {};
  const rawFamilyIds =
    activeFamilyCascadeIds instanceof Set
      ? Array.from(activeFamilyCascadeIds)
      : activeCascadeId
        ? [activeCascadeId]
        : [];
  const familySet = new Set(rawFamilyIds.map((id) => String(id || '').toLowerCase()));
  const precollectedEntries = collectUsageEntriesToAggregate(familySet, endpoint);
  const ranges = {};
  let usageRevision = usageSnapshotRevisionSeq;

  for (const rangeKey of CONSUMPTION_PRESET_RANGE_KEYS) {
    const agg = aggregateSelectedWindowUsage({
      ...params,
      filterOpts: { range: rangeKey },
      precollectedEntries,
    });
    usageRevision = agg.usageRevision;
    ranges[rangeKey] = {
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
      modelBreakdown: agg.modelBreakdown,
    };
  }

  return { usageRevision, ranges };
}
