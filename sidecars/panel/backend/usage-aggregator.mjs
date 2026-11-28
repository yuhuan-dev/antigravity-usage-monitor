/**
 * @fileoverview 多时间窗口解析、用量桶累加、趋势序列、月度序列与分模型/分来源聚合引擎。
 *
 * 负责将内存缓存 (`trajectoryCache`) 与外部深层统计缓存 (`loadExternalDeepStatsCache`)
 * 中的所有步骤按预设窗口（`all`, `cycle`, `5h`, `today`, `24h`, `week`, `7d`, `14d`, `30d`）与当前选定窗口
 * 进行去重遍历聚合，输出前端消费分析与模型明细所需的完整统计结构。
 */

import { isDeepStrictEqual } from 'node:util';
import { decodeWorkspaceFileUriToPath } from '../shared/workspace-uri.mjs';
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

const LOCAL_TIMEZONE_TTL_MS = 30_000;
let cachedLocalTimeZone = '';
let cachedLocalTimeZoneAtMs = 0;

function resolveCachedLocalTimeZone() {
  const nowMs = Date.now();
  if (cachedLocalTimeZone && nowMs - cachedLocalTimeZoneAtMs < LOCAL_TIMEZONE_TTL_MS) {
    return cachedLocalTimeZone;
  }
  cachedLocalTimeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  cachedLocalTimeZoneAtMs = nowMs;
  return cachedLocalTimeZone;
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

function resolvePrimaryShortName(shortNameCounts, fallback = '') {
  if (!(shortNameCounts instanceof Map) || shortNameCounts.size === 0) return fallback;
  let bestName = fallback;
  let bestCount = -1;
  for (const [name, count] of shortNameCounts.entries()) {
    if (
      count > bestCount ||
      (count === bestCount &&
        (name.length < bestName.length || (name.length === bestName.length && name < bestName)))
    ) {
      bestName = name;
      bestCount = count;
    }
  }
  return bestName;
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
      shortNameCounts: new Map(),
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
  if (mInfo.shortName) {
    agg.shortNameCounts.set(mInfo.shortName, (agg.shortNameCounts.get(mInfo.shortName) || 0) + 1);
  }
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
    !st.isImageGenStep &&
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
        shortNameCounts,
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
        const primaryShortName = resolvePrimaryShortName(shortNameCounts, m.shortName);
        const sortedUpstream = Array.from((upstreamModelCounts || new Map()).entries())
          .sort((a, b) => b[1] - a[1])
          .map(([name]) => name);
        const primaryUpstream =
          sortedUpstream.length > 0
            ? sortedUpstream[0]
            : fallbackModelId || primaryShortName || m.label;
        const finishedSpeed = finishSpeed(speedAccumulator);
        const promptTokens = m.inputTokens + m.cacheReadTokens;
        const cacheHitPct =
          promptTokens > 0 ? +((m.cacheReadTokens / promptTokens) * 100).toFixed(1) : 0;
        const avgTtftSec =
          ttftSampleCount > 0 ? roundMetric(ttftSumSec / ttftSampleCount) : null;
        const hasAnomalies = Number(anomalyCount || 0) > 0;
        return {
          ...m,
          shortName: primaryShortName,
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

  // 构建大小写归一化的内存缓存与跨端深层缓存索引，彻底杜绝 `${appSource}:${cascadeId}` 键不匹配导致的双倍重复计费
  const allLiveByLower = new Map();
  for (const [rawId, entry] of cacheStore.listCachedTrajectoryEntries()) {
    const cidLower = String(rawId || '').toLowerCase();
    if (!cidLower || !entry || typeof entry !== 'object') continue;
    const prev = allLiveByLower.get(cidLower);
    if (!prev || (entry.steps?.length || 0) > (prev.steps?.length || 0)) {
      allLiveByLower.set(cidLower, entry);
    }
  }

  const externalConvos = isRemote
    ? new Map()
    : loadExternalDeepStatsCache({ coveredByLive: allLiveByLower });

  const externalByCid = new Map();
  for (const ext of externalConvos.values()) {
    const extCidLower = String(ext?.cascadeId || '').toLowerCase();
    if (!extCidLower) continue;
    const prevExt = externalByCid.get(extCidLower);
    if (!prevExt || (ext.steps?.length || 0) > (prevExt.steps?.length || 0)) {
      externalByCid.set(extCidLower, ext);
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
    const rootLive = allLiveByLower.get(groupCascadeId);
    const entryTitle = String(
      rootLive?.title || entry?.title || extMatch?.title || ''
    ).trim();
    const entryWorkspaceUri = String(
      rootLive?.workspaceUri || entry?.workspaceUri || extMatch?.workspaceUri || ''
    ).trim();
    allEntriesToAggregate.push({
      cascadeId: groupCascadeId,
      title: entryTitle,
      appSource: isRemote ? 'ssh' : entry?.appSource || 'standalone',
      accountName: entry?.accountName || extMatch?.accountName || '',
      workspaceUri: entryWorkspaceUri,
      steps: entry?.steps || [],
      accountingRev: Number(entry?._accountingRev || 0),
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
      title: String(ext.title || liveEntry?.title || '').trim(),
      appSource: ext.appSource || 'ide',
      accountName: ext.accountName || liveEntry?.accountName || '',
      workspaceUri: String(ext.workspaceUri || liveEntry?.workspaceUri || '').trim(),
      steps: ext.steps || [],
      isCurrentConv: familySet.has(extCidLower),
    });
  }

  return allEntriesToAggregate;
}

const MAX_TOP_CONVERSATIONS_LIMIT = 10;
const MAX_TOP_WORKSPACES_LIMIT = 12;
const UNBOUND_WORKSPACE_KEY = '__unbound__';

/**
 * 将 `file://` URI 或本地文件系统路径归一化为稳定的工作区聚合键、项目短名及可读路径。
 *
 * @param {string} rawUri
 * @returns {{ workspaceKey: string, label: string, workspacePath: string }|null}
 */
export function normalizeWorkspaceBucket(rawUri) {
  const decoded = decodeWorkspaceFileUriToPath(rawUri);
  if (!decoded) return null;
  const parts = decoded.split('/').filter(Boolean);
  const label = parts.length > 0 ? parts[parts.length - 1] : decoded;
  return {
    workspaceKey: decoded.toLowerCase(),
    label,
    workspacePath: decoded,
  };
}

function accumulateStepIntoWorkspaceMap(
  perWorkspaceMap,
  entry,
  stepUsage,
  tMs,
  st = null,
  mInfo = null,
  stepCost = null
) {
  const norm = normalizeWorkspaceBucket(entry?.workspaceUri);
  const key = norm ? norm.workspaceKey : UNBOUND_WORKSPACE_KEY;
  let acc = perWorkspaceMap.get(key);
  if (!acc) {
    acc = {
      workspaceKey: key,
      label: norm ? norm.label : '',
      workspacePath: norm ? norm.workspacePath : '',
      isUnbound: !norm,
      sessionIds: new Set(),
      calls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      responseTokens: 0,
      thinkingTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      unpricedCalls: 0,
      lastTimestampMs: 0,
      latestCascadeId: '',
      perModelStats: new Map(),
    };
    perWorkspaceMap.set(key, acc);
  }
  const cid = String(entry?.cascadeId || '').trim();
  if (cid) acc.sessionIds.add(cid);
  acc.calls += 1;
  acc.inputTokens += stepUsage.inTok;
  acc.cacheReadTokens += stepUsage.cacheTok;
  acc.responseTokens += stepUsage.respTok;
  acc.thinkingTokens += stepUsage.thinkTok;
  acc.totalTokens += stepUsage.stepTotalTokens;
  acc.costUsd += stepUsage.resolvedCost;
  acc.unpricedCalls += stepUsage.unpriced;
  if (tMs >= acc.lastTimestampMs) {
    acc.lastTimestampMs = tMs;
    if (cid) acc.latestCascadeId = cid;
  }
  if (st && mInfo) {
    accumulateStepIntoModelMap(acc.perModelStats, st, mInfo, stepCost);
  }
}

function finalizeTopWorkspacesMap(perWorkspaceMap, maxItems = MAX_TOP_WORKSPACES_LIMIT) {
  let hasRealWorkspace = false;
  for (const w of perWorkspaceMap.values()) {
    if (!w.isUnbound && (w.totalTokens > 0 || w.calls > 0)) {
      hasRealWorkspace = true;
      break;
    }
  }
  if (!hasRealWorkspace) return [];
  return Array.from(perWorkspaceMap.values())
    .filter((w) => w.totalTokens > 0 || w.calls > 0)
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens || b.calls - a.calls)
    .slice(0, maxItems)
    .map((w) => {
      const promptTokens = w.inputTokens + w.cacheReadTokens;
      return {
        workspaceKey: w.workspaceKey,
        label: w.label,
        workspacePath: w.workspacePath,
        isUnbound: w.isUnbound,
        sessionCount: w.sessionIds.size,
        calls: w.calls,
        inputTokens: w.inputTokens,
        cacheReadTokens: w.cacheReadTokens,
        responseTokens: w.responseTokens,
        thinkingTokens: w.thinkingTokens,
        totalTokens: w.totalTokens,
        costUsd: +w.costUsd.toFixed(6),
        unpricedCalls: w.unpricedCalls,
        cacheHitPct: promptTokens > 0 ? +((w.cacheReadTokens / promptTokens) * 100).toFixed(1) : 0,
        lastTimestampMs: w.lastTimestampMs,
        latestCascadeId: w.latestCascadeId,
        models: finalizeModelBreakdownMap(w.perModelStats),
      };
    });
}

function accumulateStepIntoConversationMap(
  perConvMap,
  entry,
  srcKey,
  srcName,
  stepUsage,
  tMs,
  st = null,
  mInfo = null,
  stepCost = null
) {
  const cid = String(entry?.cascadeId || '').trim();
  if (!cid) return;
  let acc = perConvMap.get(cid);
  if (!acc) {
    acc = {
      cascadeId: cid,
      title: String(entry?.title || '').trim(),
      appSource: srcKey,
      sourceName: srcName,
      calls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      responseTokens: 0,
      thinkingTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      unpricedCalls: 0,
      lastTimestampMs: 0,
      perModelStats: new Map(),
    };
    perConvMap.set(cid, acc);
  }
  if (!acc.title && entry?.title) {
    acc.title = String(entry.title).trim();
  }
  acc.calls += 1;
  acc.inputTokens += stepUsage.inTok;
  acc.cacheReadTokens += stepUsage.cacheTok;
  acc.responseTokens += stepUsage.respTok;
  acc.thinkingTokens += stepUsage.thinkTok;
  acc.totalTokens += stepUsage.stepTotalTokens;
  acc.costUsd += stepUsage.resolvedCost;
  acc.unpricedCalls += stepUsage.unpriced;
  if (tMs > acc.lastTimestampMs) {
    acc.lastTimestampMs = tMs;
  }
  if (st && mInfo) {
    accumulateStepIntoModelMap(acc.perModelStats, st, mInfo, stepCost);
  }
}

function finalizeTopConversationsMap(perConvMap, maxItems = MAX_TOP_CONVERSATIONS_LIMIT) {
  return Array.from(perConvMap.values())
    .filter((c) => c.totalTokens > 0 || c.calls > 0)
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens || b.calls - a.calls)
    .slice(0, maxItems)
    .map((c) => {
      const promptTokens = c.inputTokens + c.cacheReadTokens;
      return {
        cascadeId: c.cascadeId,
        title: c.title,
        appSource: c.appSource,
        sourceName: c.sourceName,
        calls: c.calls,
        inputTokens: c.inputTokens,
        cacheReadTokens: c.cacheReadTokens,
        responseTokens: c.responseTokens,
        thinkingTokens: c.thinkingTokens,
        totalTokens: c.totalTokens,
        costUsd: +c.costUsd.toFixed(6),
        unpricedCalls: c.unpricedCalls,
        cacheHitPct: promptTokens > 0 ? +((c.cacheReadTokens / promptTokens) * 100).toFixed(1) : 0,
        lastTimestampMs: c.lastTimestampMs,
        models: finalizeModelBreakdownMap(c.perModelStats),
      };
    });
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
      const hasOfficialWk = resetWkMs > nowMs;
      const startWkMs = hasOfficialWk
        ? Math.min(nowMs, resetWkMs - 7 * 24 * 3600 * 1000)
        : weekFallbackStartMs;
      poolCycleBuckets.set(poolKey, {
        start5hMs,
        startWkMs,
        hasOfficialWk,
        b5h: createUsageBucket(),
        bWk: createUsageBucket(),
        pricedTokens5h: 0,
        pricedTokensWk: 0,
        modelCosts5h: new Map(),
        modelCostsWk: new Map(),
        modelTokens5h: new Map(),
        modelTokensWk: new Map(),
        lastActivityMs: 0,
        recent10mSessions: new Map(),
      });
    }
  }
  return poolCycleBuckets;
}

export function normalizeCyclePoolFilter(rawPool, availablePoolKeys = null) {
  const raw = typeof rawPool === 'string' ? rawPool.trim() : '';
  if (!raw || raw.toLowerCase() === 'all') return 'all';
  const lower = raw.toLowerCase();
  let canonical = raw;
  if (lower === 'gemini') canonical = 'Gemini';
  else if (lower === 'argon' || lower === 'gemini 4 argon') canonical = 'Argon';
  else if (lower === 'carbon' || lower === 'gemini 4 carbon') canonical = 'Carbon';
  else if (lower === 'claude & gpt' || lower === 'claude' || lower === 'gpt') {
    canonical = 'Claude & GPT';
  }
  if (availablePoolKeys && availablePoolKeys.size > 0 && !availablePoolKeys.has(canonical)) {
    for (const k of availablePoolKeys.keys()) {
      if (String(k).toLowerCase() === lower) return k;
    }
    return 'all';
  }
  return canonical;
}

function resolveStepPoolAssignment(
  st,
  mInfo,
  poolCycleBuckets,
  poolByModel,
  hasDedicatedCarbonPool,
  hasDedicatedArgonPool
) {
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
      poolKey,
      bucket: poolKey && poolCycleBuckets.size > 0 ? poolCycleBuckets.get(poolKey) || null : null,
    };
    poolByModel.set(mInfo, cachedPool);
  }
  return cachedPool;
}

function resolveEffectiveSelectedCycleWindow({
  selectedWindow,
  effectiveCyclePool = 'all',
  isCustomWeeklyMode = false,
  cycleAnchors = {},
  nowMs = Date.now(),
  poolCycleBuckets,
  quotaPoolsMap = null,
  earliestActiveCyclePoolStartMs = Infinity,
  earliestSelectedStepMs = Infinity,
}) {
  if (!selectedWindow || selectedWindow.key !== 'cycle') return selectedWindow;
  if (effectiveCyclePool !== 'all') {
    const poolBucket = poolCycleBuckets?.get?.(effectiveCyclePool) || null;
    const poolMeta = quotaPoolsMap instanceof Map ? quotaPoolsMap.get(effectiveCyclePool) : null;
    const poolLabel = poolMeta?.poolLabel || effectiveCyclePool;
    const baseStartMs =
      !isCustomWeeklyMode && poolBucket ? poolBucket.startWkMs : selectedWindow.startMs;
    const startMs =
      Number.isFinite(earliestSelectedStepMs) && earliestSelectedStepMs < Infinity
        ? Math.min(baseStartMs, earliestSelectedStepMs)
        : baseStartMs;
    const isFallbackWeek = !isCustomWeeklyMode && !poolBucket?.hasOfficialWk;
    return {
      ...selectedWindow,
      pool: effectiveCyclePool,
      poolLabel,
      isFallbackWeek,
      label: `${isCustomWeeklyMode || isFallbackWeek ? '本周' : '当前周期'} · ${poolLabel}`,
      startMs,
    };
  }
  let hasAnyOfficialWk = !isCustomWeeklyMode && (cycleAnchors?.weeklyResetMs || 0) > nowMs;
  if (!hasAnyOfficialWk && poolCycleBuckets instanceof Map) {
    for (const b of poolCycleBuckets.values()) {
      if (b?.hasOfficialWk) {
        hasAnyOfficialWk = true;
        break;
      }
    }
  }
  const isFallbackWeek = !isCustomWeeklyMode && !hasAnyOfficialWk;
  const startMs =
    Number.isFinite(earliestActiveCyclePoolStartMs) && earliestActiveCyclePoolStartMs < Infinity
      ? Math.min(earliestActiveCyclePoolStartMs, earliestSelectedStepMs)
      : selectedWindow.startMs;
  return {
    ...selectedWindow,
    pool: 'all',
    poolLabel: '',
    isFallbackWeek,
    label: isCustomWeeklyMode || isFallbackWeek ? '本周' : '当前周期',
    startMs,
  };
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
  const { start: trendStartMs, end: trendEndMs, hourly: useHourly, stepMs: plannedStepMs } = trend;
  const pad2 = (n) => String(n).padStart(2, '0');
  const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  const trendSeries = [];
  if (useHourly) {
    const firstSlotMs = trend.first;
    const lastSlotMs = trend.last;
    const slotMs = Math.max(60 * 1000, Number(plannedStepMs) || 3600 * 1000);
    const stepMinutes = Math.max(1, Math.round(slotMs / (60 * 1000)));
    const isSubHour = stepMinutes < 60;
    const slotCount = Math.max(1, Math.floor((lastSlotMs - firstSlotMs) / slotMs) + 1);

    const firstD = new Date(firstSlotMs);
    const lastD = new Date(firstSlotMs + (slotCount - 1) * slotMs);
    const isSameDay =
      firstD.getFullYear() === lastD.getFullYear() &&
      firstD.getMonth() === lastD.getMonth() &&
      firstD.getDate() === lastD.getDate();

    for (let idx = 0; idx < slotCount; idx++) {
      const sMs = firstSlotMs + idx * slotMs;
      const eMs = sMs + slotMs;
      const sd = new Date(sMs);
      const ed = new Date(eMs);
      if (Number.isNaN(sd.getTime())) continue;
      const hh = `${pad2(sd.getHours())}:${pad2(sd.getMinutes())}`;
      const endHh = `${pad2(ed.getHours())}:${pad2(ed.getMinutes())}`;
      const dateStr = `${sd.getMonth() + 1}/${pad2(sd.getDate())}`;
      const axisLabel = isSameDay ? hh : `${dateStr} ${hh}`;
      const fullLabel = `${sd.getMonth() + 1}月${sd.getDate()}日 ${hh} - ${endHh}`;
      trendSeries.push({
        index: idx,
        startMs: sMs,
        endMs: eMs,
        granularity: isSubHour ? 'minute' : 'hour',
        ...(isSubHour ? { stepMinutes } : {}),
        label: axisLabel,
        fullLabel,
        tokens: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        responseTokens: 0,
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
    if (dayStarts.length === 0) {
      const fallbackDay = new Date(firstDayMs);
      fallbackDay.setHours(0, 0, 0, 0);
      dayStarts.push(fallbackDay.getTime());
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
        thinkingTokens: 0,
        responseTokens: 0,
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
      bucket.thinkingTokens += item.thinkingTokens || 0;
      bucket.responseTokens += item.responseTokens || 0;
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
            shortNameCounts: new Map(),
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
            unpricedCalls: 0,
          };
          bucket.perModelStats.set(modelGroupKey, bModel);
        }
        if (mInfo.shortName) {
          bModel.shortNameCounts.set(
            mInfo.shortName,
            (bModel.shortNameCounts.get(mInfo.shortName) || 0) + 1
          );
        }
        if (item.responseModel) {
          const formattedResp = formatUpstreamModelId(item.responseModel, mInfo);
          bModel.upstreamModelCounts.set(
            formattedResp,
            (bModel.upstreamModelCounts.get(formattedResp) || 0) + 1
          );
        }
        bModel.calls += 1;
        bModel.inputTokens += item.inputTokens || 0;
        bModel.cacheReadTokens += item.cacheReadTokens || 0;
        bModel.outputTokens += item.outputTokens || 0;
        bModel.thinkingTokens += item.thinkingTokens || 0;
        bModel.responseTokens += item.responseTokens || 0;
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
          .map(({ shortNameCounts, upstreamModelCounts, fallbackModelId, ...m }) => {
            const primaryShortName = resolvePrimaryShortName(shortNameCounts, m.shortName);
            const sortedUpstream = Array.from(upstreamModelCounts.entries())
              .sort((a, c) => c[1] - a[1])
              .map(([name]) => name);
            const primaryUpstream =
              sortedUpstream.length > 0
                ? sortedUpstream[0]
                : fallbackModelId || primaryShortName || m.label;
            return {
              ...m,
              shortName: primaryShortName,
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

function resolveIntradayStepMinutes(spanMs, windowKey = '') {
  if (windowKey !== 'all') {
    if (spanMs < 15 * 60 * 1000) return 1;
    if (spanMs < 60 * 60 * 1000) return 5;
    if (spanMs < 2 * 3600 * 1000) return 15;
  }
  const totalHours = Math.max(2, Math.floor(spanMs / (3600 * 1000)) + 1);
  return totalHours > 72 ? Math.ceil(totalHours / 48) * 60 : 60;
}

function floorToLocalTrendSlotMs(ms, stepMinutes) {
  const d = new Date(ms);
  if (stepMinutes < 60) {
    const alignedMin = Math.floor(d.getMinutes() / stepMinutes) * stepMinutes;
    d.setMinutes(alignedMin, 0, 0);
  } else {
    d.setMinutes(0, 0, 0);
  }
  return d.getTime();
}

function planUsageTrend(window, nowMs, earliest, latest) {
  const safeMs = (value, fallback) =>
    Number.isFinite(value) && value > 0 && value <= MAX_TREND_TIMESTAMP_MS ? value : fallback;
  const end = Math.max(safeMs(window.endMs, Math.max(nowMs, latest || nowMs)), latest);
  const defaultStart = end - 24 * 3600 * 1000;
  const start =
    window.key === 'all'
      ? Math.min(safeMs(earliest, defaultStart), end - 3600 * 1000)
      : Math.min(safeMs(window.startMs, defaultStart), end);
  const spanMs = Math.max(0, end - start);
  const hourly =
    window.key === 'today' ||
    window.key === '24h' ||
    window.key === '5h' ||
    spanMs <= 72 * 3600 * 1000;
  if (hourly) {
    const stepMinutes = resolveIntradayStepMinutes(spanMs, window.key);
    const stepMs = stepMinutes * 60 * 1000;
    const first = floorToLocalTrendSlotMs(start, stepMinutes);
    const last = floorToLocalTrendSlotMs(end, stepMinutes);
    return { start, end, hourly, stepMs, first, last };
  }
  const first = new Date(start);
  const last = new Date(end);
  first.setHours(0, 0, 0, 0);
  last.setHours(0, 0, 0, 0);
  return {
    start,
    end,
    hourly,
    stepMs: 24 * 3600 * 1000,
    first: first.getTime(),
    last: last.getTime(),
  };
}

function sameUsageEntries(previous, current) {
  return previous.length === current.length && current.every((entry, index) => {
    const before = previous[index];
    const sameSteps =
      entry.steps === before.steps ||
      (entry.accountingRev > 0 &&
        entry.accountingRev === before.accountingRev &&
        Array.isArray(entry.steps) &&
        Array.isArray(before.steps) &&
        entry.steps.length === before.steps.length);
    return sameSteps && entry.cascadeId === before.cascadeId &&
      entry.appSource === before.appSource && entry.accountName === before.accountName &&
      entry.workspaceUri === before.workspaceUri;
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
  effectiveCyclePool = 'all',
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
  const isScopedCyclePool = selectedWindow?.key === 'cycle' && effectiveCyclePool !== 'all';
  const selectedSessionBucket =
    selectedWindow?.key && !isScopedCyclePool && sessionBuckets[selectedWindow.key]
      ? sessionBuckets[selectedWindow.key]
      : createUsageBucket();
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

      const stepPool = resolveStepPoolAssignment(
        st,
        mInfo,
        poolCycleBuckets,
        poolByModel,
        hasDedicatedCarbonPool,
        hasDedicatedArgonPool
      );
      const poolBucketEntry = stepPool.bucket;

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

      if (
        selectedWindow &&
        (!sessionBuckets[selectedWindow.key] ||
          selectedWindow.key === 'custom' ||
          isScopedCyclePool)
      ) {
        const selCmpMs =
          selectedWindow.key === '5h' || selectedWindow.key === 'week' ? qMs : tMs;
        const inSelectedWindow =
          selectedWindow.key === 'all'
            ? true
            : selectedWindow.key === 'cycle'
              ? inCurrentCycle && (effectiveCyclePool === 'all' || stepPool.poolKey === effectiveCyclePool)
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

  // 为每个配额池建立独立的 5h 及周限周期统计桶（按各池自身的 resetTime / weeklyResetTime 截取窗口）
  const poolCycleBuckets = buildQuotaPoolCycleMap(quotaPoolsMap, nowMs);
  const effectiveCyclePool =
    selectedWindow.key === 'cycle'
      ? normalizeCyclePoolFilter(filterOpts.pool, poolCycleBuckets)
      : 'all';
  const isScopedCyclePool = selectedWindow.key === 'cycle' && effectiveCyclePool !== 'all';
  const selectedRangeCacheKey = isScopedCyclePool
    ? `cycle:${effectiveCyclePool}`
    : selectedWindow.key;
  const hasDedicatedCarbonPool = poolCycleBuckets.has('Carbon');
  const hasDedicatedArgonPool = poolCycleBuckets.has('Argon');
  const poolByModel = new Map();
  const quotaWeekBucket = createUsageBucket();
  const normalizedQuotaAccount =
    currentAccountName === null ? null : normalizeOwnerAccount(currentAccountName);
  const selectedAccountBucket =
    !isScopedCyclePool && accountBuckets[selectedWindow.key]
      ? accountBuckets[selectedWindow.key]
      : createUsageBucket();
  const selectedSessionBucket =
    !isScopedCyclePool && sessionBuckets[selectedWindow.key]
      ? sessionBuckets[selectedWindow.key]
      : createUsageBucket();
  const perModelStats = new Map();
  const perConvStats = new Map();
  const perWorkspaceStats = new Map();
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

  const timeZone = modelInputs ? resolveCachedLocalTimeZone() : '';
  const quotaWindows = Array.from(poolCycleBuckets, ([key, { start5hMs, startWkMs }]) => [
    { key: `${key}:5h`, startMs: start5hMs, endMs: nowMs },
    { key: `${key}:week`, startMs: startWkMs, endMs: nowMs },
  ]).flat();
  const windows = [selectedWindow, ...Object.values(presetWindows), ...quotaWindows];
  const endpointInstanceId = endpoint?.isRemote ? Number(endpoint.instanceId || 0) : 0;
  const snapshot = lastUsageSnapshotsByEndpoint.get(endpointKey) || null;
  const sameSnapshot = modelInputs && snapshot && timeZone === snapshot.timeZone &&
    endpointInstanceId === Number(snapshot.endpointInstanceId || 0) &&
    currentYear === snapshot.currentYear &&
    Boolean(isCustomWeeklyMode) === Boolean(snapshot.isCustomWeeklyMode) &&
    normalizedQuotaAccount === snapshot.normalizedQuotaAccount &&
    modelInputs.catalogRevision === snapshot.modelInputs.catalogRevision &&
    isDeepStrictEqual(modelInputs.dynamicModelMap, snapshot.modelInputs.dynamicModelMap) &&
    sameUsageEntries(snapshot.entries, allEntriesToAggregate);
  const previous = sameSnapshot ? snapshot.ranges.get(selectedRangeCacheKey) : null;
  if (previous) {
    // 时钟继续前进，只有实际有步骤跨过窗口边界时才重新聚合。
    const probeEffectiveWin =
      selectedWindow.key === 'cycle'
        ? resolveEffectiveSelectedCycleWindow({
            selectedWindow,
            effectiveCyclePool,
            isCustomWeeklyMode,
            cycleAnchors,
            nowMs,
            poolCycleBuckets,
            quotaPoolsMap,
            earliestActiveCyclePoolStartMs: previous.earliestActiveCyclePoolStartMs,
            earliestSelectedStepMs: previous.earliest,
          })
        : selectedWindow;
    const effectivePrevWin =
      selectedWindow.key === 'cycle' && previous.effectiveSelectedWindow
        ? { ...probeEffectiveWin, endMs: nowMs }
        : selectedWindow;
    const trend = planUsageTrend(effectivePrevWin, nowMs, previous.earliest, previous.latest);
    if (
      Boolean(effectivePrevWin.isFallbackWeek) ===
        Boolean(previous.effectiveSelectedWindow?.isFallbackWeek) &&
      trend.hourly === previous.trend.hourly &&
      trend.stepMs === previous.trend.stepMs &&
      trend.first === previous.trend.first &&
      trend.last === previous.trend.last &&
      sameUsageWindows(
        previous.windows,
        windows,
        (snapshot.dates ??= sortedUsageTimestamps(allEntriesToAggregate)),
        (snapshot.quotaDates ??= sortedQuotaBillingTimestamps(allEntriesToAggregate, nowMs))
      )
    ) {
      snapshot.ranges.delete(selectedRangeCacheKey);
      snapshot.ranges.set(selectedRangeCacheKey, previous);
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
          effectiveCyclePool,
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

      const stepPool = resolveStepPoolAssignment(
        st,
        mInfo,
        poolCycleBuckets,
        poolByModel,
        hasDedicatedCarbonPool,
        hasDedicatedArgonPool
      );
      const poolBucketEntry = stepPool.bucket;

      if (includeInQuotaPools && poolBucketEntry && qMs > 0 && qMs <= nowMs) {
        if (qMs > poolBucketEntry.lastActivityMs) {
          poolBucketEntry.lastActivityMs = qMs;
        }
        if (qMs >= nowMs - 10 * 60 * 1000) {
          const sessKey = String(cascadeId || '');
          let sessStat = poolBucketEntry.recent10mSessions.get(sessKey);
          if (!sessStat) {
            sessStat = { costUsd: 0, calls: 0, lastActivityMs: 0 };
            poolBucketEntry.recent10mSessions.set(sessKey, sessStat);
          }
          sessStat.costUsd += stepUsage.resolvedCost;
          sessStat.calls += 1;
          if (qMs > sessStat.lastActivityMs) sessStat.lastActivityMs = qMs;
        }
        const quotaModelKey = mInfo.baseLabel || mInfo.label || '';
        if (qMs >= poolBucketEntry.start5hMs) {
          accumulateStepIntoBucket(poolBucketEntry.b5h, stepUsage, cascadeId);
          if (stepUsage.resolvedCost > 0 && stepTotalTokens > 0) {
            poolBucketEntry.pricedTokens5h += stepTotalTokens;
          }
          if (quotaModelKey && stepUsage.resolvedCost > 0) {
            poolBucketEntry.modelCosts5h.set(
              quotaModelKey,
              (poolBucketEntry.modelCosts5h.get(quotaModelKey) || 0) + stepUsage.resolvedCost
            );
            if (stepTotalTokens > 0) {
              poolBucketEntry.modelTokens5h.set(
                quotaModelKey,
                (poolBucketEntry.modelTokens5h.get(quotaModelKey) || 0) + stepTotalTokens
              );
            }
          }
        }
        if (qMs >= poolBucketEntry.startWkMs) {
          accumulateStepIntoBucket(poolBucketEntry.bWk, stepUsage, cascadeId);
          if (stepUsage.resolvedCost > 0 && stepTotalTokens > 0) {
            poolBucketEntry.pricedTokensWk += stepTotalTokens;
          }
          if (quotaModelKey && stepUsage.resolvedCost > 0) {
            poolBucketEntry.modelCostsWk.set(
              quotaModelKey,
              (poolBucketEntry.modelCostsWk.get(quotaModelKey) || 0) + stepUsage.resolvedCost
            );
            if (stepTotalTokens > 0) {
              poolBucketEntry.modelTokensWk.set(
                quotaModelKey,
                (poolBucketEntry.modelTokensWk.get(quotaModelKey) || 0) + stepTotalTokens
              );
            }
          }
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
            ? inCurrentCycle && (effectiveCyclePool === 'all' || stepPool.poolKey === effectiveCyclePool)
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
        if (selectedWindow.key === 'custom' || isScopedCyclePool) {
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
            thinkingTokens: thinkTok,
            responseTokens: respTok,
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
        accumulateStepIntoConversationMap(
          perConvStats,
          entry,
          srcKey,
          srcName,
          stepUsage,
          tMs,
          st,
          mInfo,
          stepCost
        );
        accumulateStepIntoWorkspaceMap(
          perWorkspaceStats,
          entry,
          stepUsage,
          tMs,
          st,
          mInfo,
          stepCost
        );
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
  const effectiveSelectedWindow = resolveEffectiveSelectedCycleWindow({
    selectedWindow,
    effectiveCyclePool,
    isCustomWeeklyMode,
    cycleAnchors,
    nowMs,
    poolCycleBuckets,
    quotaPoolsMap,
    earliestActiveCyclePoolStartMs,
    earliestSelectedStepMs,
  });
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
  const topConversations = finalizeTopConversationsMap(perConvStats);
  const topWorkspaces = finalizeTopWorkspacesMap(perWorkspaceStats);

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
  const serializeModelCosts = (mMap) => {
    const out = {};
    if (!(mMap instanceof Map)) return out;
    for (const [mKey, costVal] of mMap.entries()) {
      if (mKey && Number.isFinite(costVal) && costVal > 0) {
        out[mKey] = +costVal.toFixed(6);
      }
    }
    return out;
  };
  const serializeModelTokens = (mMap) => {
    const out = {};
    if (!(mMap instanceof Map)) return out;
    for (const [mKey, tokVal] of mMap.entries()) {
      if (mKey && Number.isFinite(tokVal) && tokVal > 0) {
        out[mKey] = Math.round(tokVal);
      }
    }
    return out;
  };
  for (const [poolKey, entry] of poolCycleBuckets.entries()) {
    let recent10mCostUsd = 0;
    for (const sStat of entry.recent10mSessions.values()) {
      recent10mCostUsd += sStat.costUsd;
    }
    poolCycleStats.set(poolKey, {
      cycle5h: formatCycleSummary(entry.b5h),
      cycleWeekly: formatCycleSummary(entry.bWk),
      pricedTokens5h: Math.round(entry.pricedTokens5h || 0),
      pricedTokensWeekly: Math.round(entry.pricedTokensWk || 0),
      exactCost5hUsd: +entry.b5h.costUsd.toFixed(6),
      exactCostWeeklyUsd: +entry.bWk.costUsd.toFixed(6),
      modelCosts5h: serializeModelCosts(entry.modelCosts5h),
      modelCostsWeekly: serializeModelCosts(entry.modelCostsWk),
      modelTokens5h: serializeModelTokens(entry.modelTokens5h),
      modelTokensWeekly: serializeModelTokens(entry.modelTokensWk),
      recent10m: {
        lastActivityMs: entry.lastActivityMs,
        activeSessionCount: entry.recent10mSessions.size,
        costUsd: +recent10mCostUsd.toFixed(4),
      },
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
        endpointInstanceId,
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
    } else if (previous) {
      resolvedUsageRevision = ++usageSnapshotRevisionSeq;
      activeSnap.revision = resolvedUsageRevision;
      activeSnap.ranges.clear();
      activeSnap.selectedRanges?.clear?.();
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
    topConversations,
    topWorkspaces,
    poolCycleStats,
    poolsWeeklySummary,
  };
  if (modelInputs && activeSnap) {
    const { ranges } = activeSnap;
    ranges.delete(selectedRangeCacheKey);
    ranges.set(selectedRangeCacheKey, {
      familySig,
      windows,
      selectedWindow,
      effectiveSelectedWindow,
      earliestActiveCyclePoolStartMs,
      trend,
      result,
      earliest: earliestSelectedStepMs,
      latest: latestSelectedStepMs,
    });
    // 缓存各时间窗口的完整多窗口聚合结果，同快照复用时亚毫秒命中。
    if (ranges.size > 16) ranges.delete(ranges.keys().next().value);
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
  const effectiveCyclePool =
    selectedWindow.key === 'cycle'
      ? normalizeCyclePoolFilter(filterOpts.pool, poolCycleBuckets)
      : 'all';
  const selectedRangeCacheKey =
    selectedWindow.key === 'cycle' && effectiveCyclePool !== 'all'
      ? `cycle:${effectiveCyclePool}`
      : selectedWindow.key;
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
  const timeZone = modelInputs ? resolveCachedLocalTimeZone() : '';

  const currentCheckWindows =
    selectedWindow.key === 'cycle'
      ? [
          selectedWindow,
          ...Array.from(poolCycleBuckets, ([key, { startWkMs }]) => ({
            key: `${key}:week`,
            label: `${key}:week`,
            startMs: startWkMs,
            endMs: nowMs,
          })),
        ]
      : [selectedWindow];

  const endpointInstanceId = endpoint?.isRemote ? Number(endpoint.instanceId || 0) : 0;
  const snapshot = lastUsageSnapshotsByEndpoint.get(endpointKey) || null;
  const sameSnapshot = Boolean(
    modelInputs &&
      snapshot &&
      endpointInstanceId === Number(snapshot.endpointInstanceId || 0) &&
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
    const cachedFull = snapshot.ranges.get(selectedRangeCacheKey);
    const cachedLite = snapshot.selectedRanges.get(selectedRangeCacheKey);
    const candidate = cachedFull || cachedLite;
    if (candidate) {
      const prevWin = candidate.selectedWindow || candidate.windows?.[0] || selectedWindow;
      const probeEffectiveWin =
        selectedWindow.key === 'cycle'
          ? resolveEffectiveSelectedCycleWindow({
              selectedWindow,
              effectiveCyclePool,
              isCustomWeeklyMode,
              cycleAnchors,
              nowMs,
              poolCycleBuckets,
              quotaPoolsMap,
              earliestActiveCyclePoolStartMs: candidate.earliestActiveCyclePoolStartMs,
              earliestSelectedStepMs: candidate.earliest,
            })
          : selectedWindow;
      const effectivePrevWin =
        selectedWindow.key === 'cycle' && candidate.effectiveSelectedWindow
          ? { ...probeEffectiveWin, endMs: nowMs }
          : selectedWindow;
      const trend = planUsageTrend(effectivePrevWin, nowMs, candidate.earliest, candidate.latest);
      const prevCheckWindows = candidate.checkWindows || [prevWin];
      const compareNextWindows =
        prevCheckWindows.length === currentCheckWindows.length
          ? currentCheckWindows
          : [selectedWindow];
      if (
        Boolean(effectivePrevWin.isFallbackWeek) ===
          Boolean(candidate.effectiveSelectedWindow?.isFallbackWeek) &&
        trend.hourly === candidate.trend.hourly &&
        trend.stepMs === candidate.trend.stepMs &&
        trend.first === candidate.trend.first &&
        trend.last === candidate.trend.last &&
        sameUsageWindows(
          prevCheckWindows.length === compareNextWindows.length ? prevCheckWindows : [prevWin],
          compareNextWindows,
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
                effectiveCyclePool,
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
          topConversations: res.topConversations || [],
          topWorkspaces: res.topWorkspaces || [],
        };
      }
      snapshot.revision = ++usageSnapshotRevisionSeq;
      snapshot.ranges.clear();
      snapshot.selectedRanges.clear();
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
    } else if (effectiveCyclePool !== 'all' && poolCycleBuckets.has(effectiveCyclePool)) {
      minCutoffMs = Math.max(
        0,
        poolCycleBuckets.get(effectiveCyclePool).startWkMs - maxSettlementSlackMs
      );
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
  const perConvStats = new Map();
  const perWorkspaceStats = new Map();
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
        mInfo = resolveStepModel(st);
        const stepPool = resolveStepPoolAssignment(
          st,
          mInfo,
          poolCycleBuckets,
          poolByModel,
          hasDedicatedCarbonPool,
          hasDedicatedArgonPool
        );
        poolBucketEntry = stepPool.bucket;
        if (effectiveCyclePool !== 'all' && stepPool.poolKey !== effectiveCyclePool) {
          continue;
        }
        let inCurrentCycle = false;
        if (isCustomWeeklyMode) {
          inCurrentCycle = tMs >= weekStartMs;
        } else if (poolCycleBuckets.size > 0) {
          if (!includeInQuotaPools) continue;
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
          thinkingTokens: thinkTok,
          responseTokens: respTok,
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
      accumulateStepIntoConversationMap(
        perConvStats,
        entry,
        srcKey,
        srcName,
        stepUsage,
        tMs,
        st,
        mInfo,
        stepCost
      );
      accumulateStepIntoWorkspaceMap(
        perWorkspaceStats,
        entry,
        stepUsage,
        tMs,
        st,
        mInfo,
        stepCost
      );
    }
  }

  const effectiveSelectedWindow = resolveEffectiveSelectedCycleWindow({
    selectedWindow,
    effectiveCyclePool,
    isCustomWeeklyMode,
    cycleAnchors,
    nowMs,
    poolCycleBuckets,
    quotaPoolsMap,
    earliestActiveCyclePoolStartMs,
    earliestSelectedStepMs,
  });

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
  const topConversations = finalizeTopConversationsMap(perConvStats);
  const topWorkspaces = finalizeTopWorkspacesMap(perWorkspaceStats);

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
    topConversations,
    topWorkspaces,
  };

  if (sameSnapshot) {
    snapshot.selectedRanges ??= new Map();
    snapshot.selectedRanges.delete(selectedRangeCacheKey);
    snapshot.selectedRanges.set(selectedRangeCacheKey, {
      familySig,
      checkWindows: currentCheckWindows,
      selectedWindow,
      effectiveSelectedWindow,
      earliestActiveCyclePoolStartMs,
      trend,
      result: sliceResult,
      earliest: earliestSelectedStepMs,
      latest: latestSelectedStepMs,
    });
    if (snapshot.selectedRanges.size > 16) {
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
  const effectiveCyclePool =
    selectedWindow.key === 'cycle'
      ? normalizeCyclePoolFilter(filterOpts.pool, poolCycleBuckets)
      : 'all';
  const normalizedQuotaAccount =
    currentAccountName === null ? null : normalizeOwnerAccount(currentAccountName);

  const familyEntries = [];
  if (typeof cacheStore.getCachedTrajectoryEntryByLower === 'function') {
    for (const fidLower of familySet) {
      const hit = cacheStore.getCachedTrajectoryEntryByLower(fidLower);
      const entry = hit?.entry;
      if (!entry || !Array.isArray(entry.steps) || entry.steps.length === 0) continue;
      familyEntries.push({
        cascadeId: hit.id,
        appSource: isRemote ? 'ssh' : entry.appSource || 'standalone',
        accountName: entry.accountName || '',
        steps: entry.steps,
        isCurrentConv: true,
      });
    }
  } else {
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
  }

  return computeFamilySessionBuckets({
    entries: familyEntries,
    familySet,
    presetKeys,
    presetWindows,
    selectedWindow,
    effectiveCyclePool,
    isCustomWeeklyMode,
    poolCycleBuckets,
    normalizedQuotaAccount,
    nowMs,
    resolveStepModel,
  });
}

/**
 * 批量预聚合全部 7 个用量页预设区间及各配额池独立周期（复用同一次条目收集和时间剪枝），供前端进入「用量统计」时静默预取实现 0ms 瞬切。
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

  const packSlice = (agg) => ({
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
    modelBreakdown: agg.modelBreakdown,
    topConversations: agg.topConversations || [],
    topWorkspaces: agg.topWorkspaces || [],
  });

  for (const rangeKey of CONSUMPTION_PRESET_RANGE_KEYS) {
    const agg = aggregateSelectedWindowUsage({
      ...params,
      filterOpts: { range: rangeKey },
      precollectedEntries,
    });
    usageRevision = agg.usageRevision;
    ranges[rangeKey] = packSlice(agg);
  }

  if (params?.quotaPoolsMap instanceof Map) {
    for (const poolKey of params.quotaPoolsMap.keys()) {
      if (!poolKey || poolKey === 'all') continue;
      const agg = aggregateSelectedWindowUsage({
        ...params,
        filterOpts: { range: 'cycle', pool: poolKey },
        precollectedEntries,
      });
      usageRevision = agg.usageRevision;
      ranges[`cycle:${poolKey}`] = packSlice(agg);
    }
  }

  return { usageRevision, ranges };
}
