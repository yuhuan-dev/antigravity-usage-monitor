/**
 * @fileoverview 实验性配额预占估算器（`quota-reservation.mjs`）。
 *
 * 基于分布式配额租约（Per-Bucket / Per-Session Quota Lease）的行为特征：
 * 1. 5h 桶及周限桶各自独立追踪（支持错档触发）；
 * 2. 多高消耗会话并发时支持多笔租约线性叠加（如 0.5% / 1.0% / 2.0%+）；
 * 3. 在租约期内继续产生真实消耗时按单桶换算率扣减可退差额；
 * 4. 上游退还租约（同周期内 officialUsedPct 下降）时按 FIFO 精准核销并反向校准单桶费率；
 * 5. 轻量 O(1) 状态机 + DATA_DIR 节流持久化（保留最近 500 条事件，重启及热更新后自动恢复）。
 */

import { parseIsoMs } from '../trajectory-metrics.mjs';
import {
  QUOTA_RESERVATION_STATE_FILE,
  loadJson,
  lsRuntimeEndpoint,
  saveJson,
} from './config.mjs';
import { summarizeSafetyMonitorWindow } from './safety-monitor-scanner.mjs';

export const QR_LEASE_TTL_MS = 45 * 60 * 1000;
export const QR_LEASE_GRACE_MS = 15 * 60 * 1000;
export const QR_LEASE_IDLE_EXPIRY_MS = QR_LEASE_TTL_MS + QR_LEASE_GRACE_MS;
export const QR_LEASE_MAX_AGE_MS = 90 * 60 * 1000;
export const QR_PENDING_COST_TTL_MS = 60 * 1000;
export const QR_CONSUME_LAG_GRACE_MS = 25 * 1000;
export const QR_CYCLE_RESET_SHIFT_MS = 30 * 60 * 1000;
export const QR_MIN_JUMP_EXCESS_PCT = 0.35;
export const QR_COLD_START_JUMP_PCT = 0.45;
export const QR_COLD_START_MAX_COST_USD = 0.25;
export const QR_REFUND_EPSILON_PCT = 0.04;
export const QR_MIN_DISPLAY_RESERVED_PCT = 0.05;
export const QR_IDLE_CONFIRM_REFUND_MS = 5 * 60 * 1000;
export const QR_REFUND_CONFIRM_WINDOW_MS = 4 * 60 * 1000;
export const QR_REFUND_CONFIRM_MIN_SAMPLES = 4;
export const QR_RATE_BOUNCE_COOLDOWN_MS = 60 * 1000;
export const QR_REPLICA_BOUNCE_MEMORY_MS = 30 * 60 * 1000;
export const QR_RATE_WINDOW_SIZE = 20;
export const QR_RATE_OUTLIER_MIN_RATIO = 0.45;
export const QR_RATE_OUTLIER_MAX_RATIO = 2.0;
export const QR_RATE_DRIFT_STREAK = 5;
export const QR_CONSUME_MIN_SHORTFALL_PCT = 0.03;
export const QR_CONSUME_SHORTFALL_RATIO = 0.35;
export const QR_MODEL_RATE_MIN_UI_SAMPLES = 3;
export const QR_MODEL_SINGLE_DOMINANCE_RATIO = 0.95;
export const QR_LOCAL_ACTIVITY_GRACE_MS = 4 * 60 * 1000;
export const QR_EXTERNAL_ACTIVE_WINDOW_MS = 15 * 60 * 1000;
export const QR_EXTERNAL_MIN_IDLE_DELTA_PCT = 0.25;
export const QR_EXTERNAL_MIN_IDLE_5H_DELTA_PCT = 0.3;
export const QR_EXTERNAL_MIN_IDLE_WK_DELTA_PCT = 0.12;
export const QR_EXTERNAL_BASELINE_USED_PCT = 2.0;
export const QR_EXTERNAL_BASELINE_MAX_LOCAL_COST_USD = 0.05;
export const QR_EXTERNAL_LOCAL_COVER_RATIO = 0.02;
export const QR_EXTERNAL_SOLO_DRIFT_RATIO = 0.12;
export const QR_EXTERNAL_SOLO_DRIFT_FLOOR_PCT = 0.25;
export const QR_EXTERNAL_RESIDUAL_MIN_SAMPLES = 5;
export const QR_EXTERNAL_PEER_RESIDUAL_MIN_PCT = 0.5;
export const QR_EXTERNAL_MODEL_UNCERT_MULT = 2.0;
export const QR_EXTERNAL_HIGH_COVERAGE_MAX_UNCAL_SHARE = 0.15;
export const QR_EXTERNAL_RECONCILE_DEADBAND_PCT = 0.02;
export const QR_LEASE_REJECT_SURPLUS_RATIO = 0.06;
export const QR_EXTERNAL_SCAN_LAG_RECONCILE_MS = 2 * 60 * 1000;
export const QR_SAFETY_EVENT_MATCH_WINDOW_MS = 90 * 1000;
export const QR_SAFETY_EVENT_MAX_LOOKBACK_MS = 10 * 60 * 1000;
export const QR_SAFETY_MAX_USD_PER_HEAVY_EVENT = 0.65;
export const QR_SAFETY_CHARS_PER_TOKEN_EST = 2.75;
export const QR_SAFETY_SONAR_INPUT_USD_PER_MTOK = 1.5;
export const QR_SAFETY_FLASH_LITE_EST_USD_PER_CALL = 0.0015;
export const QR_CO_MOVE_MIN_5H_EXCESS_PCT = 0.35;
export const QR_CO_MOVE_MIN_WK_EXCESS_PCT = 0.1;
export const QR_CO_MOVE_SHARED_MIN_5H_EXCESS_PCT = 0.2;
export const QR_CO_MOVE_SHARED_MIN_WK_EXCESS_PCT = 0.05;
export const QR_CO_MOVE_SOLO_MIN_5H_EXCESS_PCT = 0.8;
export const QR_CO_MOVE_SOLO_MIN_WK_EXCESS_PCT = 0.2;
export const QR_CO_MOVE_SOLO_MIN_EXCESS_RATIO = 2.5;
export const QR_CO_MOVE_MIN_RATE_RATIO = 1.8;
export const QR_CO_MOVE_MIN_USD_RATIO = 0.65;
export const QR_CO_MOVE_MAX_USD_RATIO = 1.55;
export const QR_UNCONFIRMED_NORMAL_STEPS_EVICT = 3;
export const QR_UNCONFIRMED_NORMAL_PCT_EVICT = 0.25;
export const QR_UNCONFIRMED_RATIO_FLOOR = 0.72;
export const QR_TENTATIVE_NORMAL_STEPS_EVICT = 2;
export const QR_TENTATIVE_NORMAL_PCT_EVICT = 0.12;
export const QR_TENTATIVE_LEASE_TTL_MS = 3 * 60 * 1000;
const QR_MAX_MODELS_PER_BUCKET = 16;
const QR_MAX_TRACKED_BUCKETS = 128;
const QR_MAX_ACTIVE_LEASES = 16;
const QR_MAX_SLOPE_SAMPLES = 24;
const QR_SLOPE_MIN_DELTA_PCT = 0.25;
const QR_SLOPE_MIN_DELTA_COST_USD = 0.15;
const QR_SLOPE_UNLOCK_5H_PCT = 2.5;
const QR_SLOPE_UNLOCK_WK_PCT = 1.5;
const QR_SLOPE_UNLOCK_MIN_CALLS = 5;
const QR_COLD_RATIO_5H_PCT = 3.0;
const QR_COLD_RATIO_WK_PCT = 2.0;
const QR_COLD_RATIO_SOLO_PCT = 5.0;
const QR_COLD_RATIO_MIN_CALLS = 5;
const QR_COLD_RATIO_SOLO_MIN_CALLS = 3;
const QR_COLD_RATIO_5H_MIN_COST_USD = 0.15;
const QR_COLD_RATIO_WK_MIN_COST_USD = 0.25;
const QR_DENSITY_MIN_TOKENS = 10_000;
const QR_DENSITY_MIN_COST_USD = 0.05;
const QR_MAX_EVENT_LOG = 500;
const QR_PERSIST_MIN_INTERVAL_MS = 5000;
const QR_STATE_SCHEMA_VERSION = 2;

function qrClamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function qrRound1(val) {
  return Math.round(val * 10) / 10;
}

function qrClampRate(rate) {
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return qrClamp(rate, 0.005, 50);
}

function qrClampUsdPerMTok(val) {
  const num = Number(val);
  if (!Number.isFinite(num) || num <= 0) return null;
  return qrClamp(num, 0.02, 500);
}

function qrBlendUsdPerMTok(prevDensity, costUsd, pricedTokens) {
  const prev = qrClampUsdPerMTok(prevDensity);
  const safeCost = Number(costUsd) || 0;
  const safeTokens = Number(pricedTokens) || 0;
  if (safeTokens < QR_DENSITY_MIN_TOKENS || safeCost < QR_DENSITY_MIN_COST_USD) {
    return prev;
  }
  const curr = qrClampUsdPerMTok(safeCost / (safeTokens / 1_000_000));
  if (curr === null) return prev;
  if (prev === null) return curr;
  const w = safeCost / (safeCost + 1.0);
  return qrClampUsdPerMTok(prev * (1 - w) + curr * w);
}

function qrDeriveEqFullTokens(rawEqFullUsd, usdPerMTok) {
  const usd = Number(rawEqFullUsd);
  const density = qrClampUsdPerMTok(usdPerMTok);
  if (!Number.isFinite(usd) || usd <= 0 || density === null) return null;
  const tok = Math.round((usd / density) * 1_000_000);
  return Number.isFinite(tok) && tok > 0 ? tok : null;
}

function qrComputeTheilSenSlope(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  if (samples.length === 2) {
    const du = samples[1].u - samples[0].u;
    const dc = samples[1].c - samples[0].c;
    return dc >= 0.05 && du > 0 ? qrClampRate(du / dc) : null;
  }
  const slopes = [];
  for (let i = 0; i < samples.length - 1; i += 1) {
    for (let j = i + 1; j < samples.length; j += 1) {
      const du = samples[j].u - samples[i].u;
      const dc = samples[j].c - samples[i].c;
      if (dc >= 0.05 && du > 0) {
        const s = qrClampRate(du / dc);
        if (s !== null) slopes.push(s);
      }
    }
  }
  return slopes.length > 0 ? qrClampRate(qrComputeMedian(slopes)) : null;
}

function qrSanitizeSlopeSamples(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (let i = 0; i < raw.length && out.length < QR_MAX_SLOPE_SAMPLES; i += 1) {
    const item = raw[i];
    if (!item || typeof item !== 'object') continue;
    const u = Number(item.u);
    const c = Number(item.c);
    const n = Math.floor(Number(item.n) || 0);
    const unp = Math.max(0, Math.floor(Number(item.unp) || 0));
    if (!Number.isFinite(u) || u < 0 || !Number.isFinite(c) || c < 0 || n < 0) continue;
    out.push({ u: qrClamp(u, 0, 100), c, n, ...(unp > 0 ? { unp } : {}) });
  }
  return out;
}

function qrSanitizeModelTokens(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    const cleanKey = String(k || '').trim();
    const num = Math.floor(Number(v) || 0);
    if (cleanKey && Number.isFinite(num) && num > 0) {
      out[cleanKey] = num;
    }
  }
  return out;
}

function qrRefreshBucketDensities(st, safeCost, safePricedTokens, safeModelCosts, safeModelTokens) {
  if (!st || typeof st !== 'object') return;
  const nextPoolDensity = qrBlendUsdPerMTok(st.priorUsdPerMTok, safeCost, safePricedTokens);
  if (nextPoolDensity !== null) {
    st.usdPerMTok = nextPoolDensity;
  }
  const priorModels =
    st.priorModelUsdPerMTok && typeof st.priorModelUsdPerMTok === 'object'
      ? st.priorModelUsdPerMTok
      : {};
  const nextModels = { ...priorModels };
  if (safeModelCosts && safeModelTokens) {
    for (const [mKey, mCost] of Object.entries(safeModelCosts)) {
      const mTok = Number(safeModelTokens[mKey]) || 0;
      const blended = qrBlendUsdPerMTok(priorModels[mKey] ?? null, mCost, mTok);
      if (blended !== null) {
        nextModels[mKey] = +blended.toFixed(4);
      }
    }
  }
  const entries = Object.entries(nextModels).slice(-QR_MAX_MODELS_PER_BUCKET);
  st.modelUsdPerMTok = Object.fromEntries(entries);
}

function qrComputeNetLocalUsedPct(st, officialUsedPct) {
  const safeOfficial = qrClamp(Number(officialUsedPct) || 0, 0, 100);
  if (!st || typeof st !== 'object') return safeOfficial;
  const leaseSum = qrSumLeases(st.activeLeases || [], { includeTentative: true });
  const extPct = Math.max(0, Number(st.externalUsedPct) || 0);
  const safetyPct = Math.max(0, Number(st.safetyReviewUsedPct) || 0);
  return Math.max(0, safeOfficial - leaseSum - extPct - safetyPct);
}

function qrSanitizeModelDensities(raw, { preserveRate = true } = {}) {
  const out = {};
  if (!preserveRate || !raw || typeof raw !== 'object') return out;
  const entries = Object.entries(raw).slice(-QR_MAX_MODELS_PER_BUCKET);
  for (const [k, v] of entries) {
    const cleanKey = String(k || '').trim();
    const clamped = qrClampUsdPerMTok(v);
    if (cleanKey && clamped !== null) {
      out[cleanKey] = +clamped.toFixed(4);
    }
  }
  return out;
}

function qrResetSlopeAnchor(st, netUsedPct, safeCost, safeCalls, safeUnpriced = 0) {
  if (!st || typeof st !== 'object') return;
  const calls = Math.max(0, Math.floor(Number(safeCalls) || 0));
  const unp = Math.max(0, Math.floor(Number(safeUnpriced) || 0));
  const u = qrClamp(Number(netUsedPct) || 0, 0, 100);
  const c = Math.max(0, Number(safeCost) || 0);
  st.slopeSamples = [{ u: +u.toFixed(4), c: +c.toFixed(6), n: calls, ...(unp > 0 ? { unp } : {}) }];
}

function qrUpdateSlopeSamples(st, netUsedPct, safeCost, safeCalls, safeUnpriced = 0) {
  if (!st || st.pendingDrop !== null) return;
  const calls = Math.max(0, Math.floor(Number(safeCalls) || 0));
  const unp = Math.max(0, Math.floor(Number(safeUnpriced) || 0));
  const u = qrClamp(Number(netUsedPct) || 0, 0, 100);
  const c = Math.max(0, Number(safeCost) || 0);
  const arr = Array.isArray(st.slopeSamples) ? st.slopeSamples : (st.slopeSamples = []);
  if (arr.length === 0) {
    arr.push({ u: +u.toFixed(4), c: +c.toFixed(6), n: calls, ...(unp > 0 ? { unp } : {}) });
    return;
  }
  const last = arr[arr.length - 1];
  const lastUnp = Math.max(0, Math.floor(Number(last.unp) || 0));
  if (u < last.u - 0.15 || c < last.c - 1e-4 || calls < last.n || unp !== lastUnp) {
    st.slopeSamples = [{ u: +u.toFixed(4), c: +c.toFixed(6), n: calls, ...(unp > 0 ? { unp } : {}) }];
    return;
  }
  const du = u - last.u;
  const dc = c - last.c;
  const dn = calls - last.n;
  if (
    dn > 0 &&
    ((du >= QR_SLOPE_MIN_DELTA_PCT && dc >= 0.02) ||
      (dc >= QR_SLOPE_MIN_DELTA_COST_USD && du > 1e-3))
  ) {
    arr.push({ u: +u.toFixed(4), c: +c.toFixed(6), n: calls, ...(unp > 0 ? { unp } : {}) });
    if (arr.length > QR_MAX_SLOPE_SAMPLES) {
      // 保留首锚点 arr[0] 以维持整周期跨度，淘汰最早的中间点
      arr.splice(1, arr.length - QR_MAX_SLOPE_SAMPLES);
    }
  }
}

function qrResolveExactUsedPct(poolObj, win) {
  const rawFrac =
    win === 'weekly' ? poolObj?.weeklyRemainingFraction : poolObj?.remainingFraction;
  if (rawFrac !== undefined && rawFrac !== null && Number.isFinite(Number(rawFrac))) {
    return qrClamp((1 - qrClamp(Number(rawFrac), 0, 1)) * 100, 0, 100);
  }
  const rawUsed = win === 'weekly' ? poolObj?.weeklyUsedPct : poolObj?.usedPct;
  if (rawUsed !== undefined && rawUsed !== null && Number.isFinite(Number(rawUsed))) {
    return qrClamp(Number(rawUsed), 0, 100);
  }
  return null;
}

function qrSumLeases(leases, { includeTentative = true } = {}) {
  let sum = 0;
  for (let i = 0; i < leases.length; i += 1) {
    if (!includeTentative && leases[i]?.tentative) continue;
    sum += Math.max(0, Number(leases[i]?.remainingPct) || 0);
  }
  return sum;
}

function qrConfirmAllLeases(leases) {
  let promoted = false;
  for (let i = 0; i < leases.length; i += 1) {
    if (leases[i].tentative) {
      leases[i].tentative = false;
      promoted = true;
    }
    leases[i].confirmed = true;
    leases[i].unabsorbedNormalSteps = 0;
    leases[i].unabsorbedExpectedPct = 0;
  }
  return promoted;
}

function qrConsumeLeasesFifo(leases, amountPct) {
  let left = Math.max(0, Number(amountPct) || 0);
  if (left <= 0 || leases.length === 0) return 0;
  let consumed = 0;
  for (let i = 0; i < leases.length && left > 1e-6; i += 1) {
    const cur = Math.max(0, Number(leases[i].remainingPct) || 0);
    const take = Math.min(cur, left);
    leases[i].remainingPct = cur - take;
    left -= take;
    consumed += take;
  }
  for (let i = leases.length - 1; i >= 0; i -= 1) {
    if (leases[i].remainingPct <= 1e-4) {
      leases.splice(i, 1);
    }
  }
  return consumed;
}

function qrComputeMedian(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function qrRecordRateSample(state, sampleRate, { blockUpwardDriftReset = false } = {}) {
  const clamped = qrClampRate(sampleRate);
  if (clamped === null) return false;
  const win = Array.isArray(state.rateWindow) ? state.rateWindow : (state.rateWindow = []);

  if (win.length >= 4) {
    const med = qrComputeMedian(win);
    const lowBound = med * QR_RATE_OUTLIER_MIN_RATIO;
    const highBound = med * QR_RATE_OUTLIER_MAX_RATIO;
    if (clamped < lowBound || clamped > highBound) {
      const side = clamped > highBound ? 1 : -1;
      if (blockUpwardDriftReset && side === 1) {
        // 共享活跃期内外部并发扣费只会把表观费率向上拉偏，禁止向上离群连续触发漂移重置
        return false;
      }
      if (state.rateOutlierSide !== side) {
        state.rateOutlierSide = side;
        state.rateOutlierBuf = [clamped];
      } else {
        state.rateOutlierBuf.push(clamped);
      }
      if (state.rateOutlierBuf.length >= QR_RATE_DRIFT_STREAK) {
        // 连续多次干净同向偏移（如账号套餐倍率变化），重置中位数窗口
        state.rateWindow = state.rateOutlierBuf.slice(-QR_RATE_WINDOW_SIZE);
        state.rateOutlierSide = 0;
        state.rateOutlierBuf = [];
        state.ratePctPerUsd = qrClampRate(qrComputeMedian(state.rateWindow));
        state.rateSamples += 1;
        return true;
      }
      return false;
    }
  }

  state.rateOutlierSide = 0;
  state.rateOutlierBuf = [];
  win.push(clamped);
  if (win.length > QR_RATE_WINDOW_SIZE) {
    win.splice(0, win.length - QR_RATE_WINDOW_SIZE);
  }
  state.ratePctPerUsd = qrClampRate(qrComputeMedian(win));
  state.rateSamples += 1;
  return true;
}

function qrResolveEffectiveRate(state, officialUsedPct, cycleCostUsd) {
  if (state.ratePctPerUsd !== null && Number.isFinite(state.ratePctPerUsd)) {
    return state.ratePctPerUsd;
  }
  // 一旦检测到同池存在家庭组 / 其他设备外部消耗或未计价调用，禁止用累计总占比 / 本机花费做冷启动反推
  if (
    !state.hasExternalUsage &&
    (state.lastUnpricedCalls || 0) === 0 &&
    cycleCostUsd >= 0.5 &&
    officialUsedPct >= 0.3
  ) {
    return qrClampRate(officialUsedPct / cycleCostUsd);
  }
  return null;
}

function qrPruneExpiredLeases(state, nowMs) {
  if (state.activeLeases.length === 0) {
    return { prunedCount: 0, expiredTentativePct: 0, latestTentativeCreatedAtMs: 0 };
  }
  let prunedCount = 0;
  let expiredTentativePct = 0;
  let latestTentativeCreatedAtMs = 0;
  for (let i = state.activeLeases.length - 1; i >= 0; i -= 1) {
    const lease = state.activeLeases[i];
    const lastActiveMs = lease.lastTouchedMs || lease.createdAtMs || 0;
    const tentativeExpired =
      Boolean(lease.tentative) &&
      (lease.createdAtMs || 0) > 0 &&
      nowMs - (lease.createdAtMs || 0) >= QR_TENTATIVE_LEASE_TTL_MS;
    const idleExpired = lastActiveMs > 0 && nowMs - lastActiveMs >= QR_LEASE_IDLE_EXPIRY_MS;
    const maxAgeExpired = nowMs - (lease.createdAtMs || 0) >= QR_LEASE_MAX_AGE_MS;
    if (tentativeExpired || idleExpired || maxAgeExpired) {
      if (lease.tentative) {
        expiredTentativePct += Math.max(0, Number(lease.remainingPct) || 0);
        const createdMs = Math.max(0, Number(lease.createdAtMs) || 0);
        if (createdMs > latestTentativeCreatedAtMs) {
          latestTentativeCreatedAtMs = createdMs;
        }
      }
      state.activeLeases.splice(i, 1);
      prunedCount += 1;
    }
  }
  return { prunedCount, expiredTentativePct, latestTentativeCreatedAtMs };
}

function qrFormatOutput(state, officialUsedPct) {
  const safeOfficial = qrClamp(Number(officialUsedPct) || 0, 0, 100);
  const roundedOfficial = qrRound1(safeOfficial);
  const rawSum = qrSumLeases(state.activeLeases, { includeTentative: false });
  let dropOffset = 0;
  if (state.pendingDrop && Number.isFinite(state.pendingDrop.preDropUsedPct)) {
    const costSinceDrop = Math.max(
      0,
      Number(state.lastCycleCostUsd || 0) - Number(state.pendingDrop.preDropCostUsd || 0)
    );
    const expectedSinceDrop =
      state.ratePctPerUsd !== null && Number.isFinite(state.ratePctPerUsd)
        ? costSinceDrop * state.ratePctPerUsd
        : 0;
    dropOffset = Math.max(0, state.pendingDrop.preDropUsedPct + expectedSinceDrop - safeOfficial);
  }
  const visibleRaw = Math.max(0, rawSum - dropOffset);
  const rawReserved = qrClamp(visibleRaw, 0, safeOfficial);
  const hasVisibleReserved = rawReserved >= QR_MIN_DISPLAY_RESERVED_PCT;
  const reservedPct = hasVisibleReserved
    ? qrClamp(qrRound1(rawReserved), 0, roundedOfficial)
    : 0;

  let earliestExpiresAtMs = null;
  let visibleCount = 0;
  if (hasVisibleReserved) {
    for (let i = 0; i < state.activeLeases.length; i += 1) {
      if (state.activeLeases[i]?.tentative) continue;
      visibleCount += 1;
      const exp =
        (state.activeLeases[i].lastTouchedMs || state.activeLeases[i].createdAtMs || 0) +
        QR_LEASE_TTL_MS;
      if (exp > 0 && (earliestExpiresAtMs === null || exp < earliestExpiresAtMs)) {
        earliestExpiresAtMs = exp;
      }
    }
  }

  const maxSafetyRaw = Math.max(0, safeOfficial - (hasVisibleReserved ? rawReserved : 0));
  const rawSafety = qrClamp(Number(state.safetyReviewUsedPct) || 0, 0, maxSafetyRaw);
  const maxSafetyRounded = Math.max(0, qrRound1(roundedOfficial - reservedPct));
  const safetyReviewUsedPct =
    rawSafety >= QR_MIN_DISPLAY_RESERVED_PCT
      ? qrClamp(qrRound1(rawSafety), 0, maxSafetyRounded)
      : 0;

  // 严格守恒：externalUsedPct >= 0 且 externalUsedPct + safetyReviewUsedPct + reservedPct <= officialUsedPct
  const maxExtRaw = Math.max(0, maxSafetyRaw - rawSafety);
  const rawExternal = qrClamp(Number(state.externalUsedPct) || 0, 0, maxExtRaw);
  const maxExtRounded = Math.max(0, qrRound1(roundedOfficial - reservedPct - safetyReviewUsedPct));
  const externalUsedPct =
    rawExternal >= QR_MIN_DISPLAY_RESERVED_PCT
      ? qrClamp(qrRound1(rawExternal), 0, maxExtRounded)
      : 0;

  return {
    reservedPct,
    reservedLeaseCount: hasVisibleReserved ? visibleCount : 0,
    reservedExpiresAtMs: hasVisibleReserved ? earliestExpiresAtMs : null,
    externalUsedPct,
    safetyReviewUsedPct,
  };
}

function qrSanitizePersistedLeases(rawLeases) {
  if (!Array.isArray(rawLeases)) return [];
  const out = [];
  for (let i = 0; i < rawLeases.length && out.length < QR_MAX_ACTIVE_LEASES; i += 1) {
    const item = rawLeases[i];
    if (!item || typeof item !== 'object') continue;
    const rem = Number(item.remainingPct);
    const amt = Number(item.amountPct);
    const createdAtMs = Number(item.createdAtMs) || 0;
    const lastTouchedMs = Number(item.lastTouchedMs) || createdAtMs;
    if (!Number.isFinite(rem) || rem <= 1e-4) continue;
    out.push({
      amountPct: Number.isFinite(amt) && amt > 0 ? amt : rem,
      remainingPct: rem,
      createdAtMs,
      lastTouchedMs,
      sessionCount: Math.max(1, Number(item.sessionCount) || 1),
      confirmed: item.confirmed !== false,
      tentative: item.tentative === true,
      unabsorbedNormalSteps: Math.max(0, Math.floor(Number(item.unabsorbedNormalSteps) || 0)),
      unabsorbedExpectedPct: Math.max(0, Number(item.unabsorbedExpectedPct) || 0),
    });
  }
  return out;
}

function qrSanitizePersistedPendingDrop(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const preDropUsedPct = Number(raw.preDropUsedPct);
  const lowestUsedPct = Number(raw.lowestUsedPct);
  const dropPct = Number(raw.dropPct);
  const droppedAtMs = Number(raw.droppedAtMs) || 0;
  if (!Number.isFinite(preDropUsedPct) || !Number.isFinite(lowestUsedPct) || !Number.isFinite(dropPct) || dropPct <= 0 || droppedAtMs <= 0) {
    return null;
  }
  return {
    preDropUsedPct: qrClamp(preDropUsedPct, 0, 100),
    preDropCostUsd: Math.max(0, Number(raw.preDropCostUsd) || 0),
    dropPct: qrClamp(dropPct, 0, 100),
    droppedAtMs,
    lowSamples: Math.max(1, Math.floor(Number(raw.lowSamples) || 1)),
    lowestUsedPct: qrClamp(lowestUsedPct, 0, 100),
  };
}

function qrSanitizeModelCosts(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    const cleanKey = String(k || '').trim();
    const num = Number(v);
    if (cleanKey && Number.isFinite(num) && num > 0) {
      out[cleanKey] = num;
    }
  }
  return out;
}

function qrSanitizePersistedModelRates(raw, { preserveRate = true } = {}) {
  const out = {};
  if (!preserveRate || !raw || typeof raw !== 'object') return out;
  const entries = Object.entries(raw).slice(-QR_MAX_MODELS_PER_BUCKET);
  for (const [k, item] of entries) {
    const cleanKey = String(k || '').trim();
    if (!cleanKey || !item || typeof item !== 'object') continue;
    const rateWindow = Array.isArray(item.rateWindow)
      ? item.rateWindow
          .map((v) => qrClampRate(Number(v)))
          .filter((v) => v !== null)
          .slice(-QR_RATE_WINDOW_SIZE)
      : [];
    const rate =
      rateWindow.length > 0
        ? qrClampRate(qrComputeMedian(rateWindow))
        : item.ratePctPerUsd !== undefined && item.ratePctPerUsd !== null
          ? qrClampRate(Number(item.ratePctPerUsd))
          : null;
    if (rate === null) continue;
    out[cleanKey] = {
      ratePctPerUsd: rate,
      rateSamples: Math.max(rateWindow.length, Math.floor(Number(item.rateSamples) || 0)),
      rateWindow,
      rateOutlierSide: 0,
      rateOutlierBuf: [],
      lastSeenMs: Math.max(0, Number(item.lastSeenMs) || 0),
    };
  }
  return out;
}

function qrGetOrCreateModelRate(st, modelKey, nowMs) {
  const map = st.modelRates && typeof st.modelRates === 'object' ? st.modelRates : (st.modelRates = {});
  if (map[modelKey]) return map[modelKey];
  const keys = Object.keys(map);
  if (keys.length >= QR_MAX_MODELS_PER_BUCKET) {
    let oldestKey = keys[0];
    let oldestMs = Number(map[oldestKey]?.lastSeenMs || 0);
    for (let i = 1; i < keys.length; i += 1) {
      const candidateMs = Number(map[keys[i]]?.lastSeenMs || 0);
      if (candidateMs < oldestMs) {
        oldestMs = candidateMs;
        oldestKey = keys[i];
      }
    }
    if (oldestKey) delete map[oldestKey];
  }
  const entry = {
    ratePctPerUsd: null,
    rateSamples: 0,
    rateWindow: [],
    rateOutlierSide: 0,
    rateOutlierBuf: [],
    lastSeenMs: nowMs,
  };
  map[modelKey] = entry;
  return entry;
}

function qrEstimateModelWeightedPct(st, deltaModelCosts, totalDeltaCostUsd, fallbackRate) {
  if (fallbackRate === null || !Number.isFinite(fallbackRate) || totalDeltaCostUsd <= 0) return 0;
  const modelRates = st.modelRates && typeof st.modelRates === 'object' ? st.modelRates : null;
  if (!modelRates || !deltaModelCosts || typeof deltaModelCosts !== 'object') {
    return totalDeltaCostUsd * fallbackRate;
  }
  let attributedCost = 0;
  let weightedPct = 0;
  let usedPerModel = false;
  for (const [mKey, costDelta] of Object.entries(deltaModelCosts)) {
    if (!Number.isFinite(costDelta) || costDelta <= 0) continue;
    attributedCost += costDelta;
    const mr = modelRates[mKey];
    if (mr && mr.rateSamples >= 2 && Number.isFinite(mr.ratePctPerUsd) && mr.ratePctPerUsd > 0) {
      weightedPct += costDelta * mr.ratePctPerUsd;
      usedPerModel = true;
    } else {
      weightedPct += costDelta * fallbackRate;
    }
  }
  if (!usedPerModel || attributedCost <= 0) {
    return totalDeltaCostUsd * fallbackRate;
  }
  const unattributedCost = Math.max(0, totalDeltaCostUsd - attributedCost);
  return weightedPct + unattributedCost * fallbackRate;
}

function qrResolveBucketDisplayRate(st, win) {
  if (!st || typeof st !== 'object') return null;
  const cleanWin = Array.isArray(st.rateWindow) ? st.rateWindow : [];
  const calibratedSamples = cleanWin.length > 0 ? cleanWin.length : st.rateSamples;
  if (calibratedSamples >= QR_MODEL_RATE_MIN_UI_SAMPLES && Number.isFinite(st.ratePctPerUsd)) {
    return {
      rate: st.ratePctPerUsd,
      source: 'calibrated',
      isPreliminary: false,
      samples: Math.max(cleanWin.length, st.rateSamples),
    };
  }

  let tier2Rate = null;
  const slopePts = Array.isArray(st.slopeSamples) ? st.slopeSamples : [];
  if (slopePts.length >= 2) {
    const first = slopePts[0];
    const last = slopePts[slopePts.length - 1];
    const spanPct = last.u - first.u;
    const spanCost = last.c - first.c;
    const spanCalls = last.n - first.n;
    const minSpanPct = win === '5h' ? QR_SLOPE_UNLOCK_5H_PCT : QR_SLOPE_UNLOCK_WK_PCT;
    if (
      spanPct >= minSpanPct &&
      spanCost >= QR_SLOPE_MIN_DELTA_COST_USD &&
      spanCalls >= QR_SLOPE_UNLOCK_MIN_CALLS
    ) {
      tier2Rate = qrComputeTheilSenSlope(slopePts);
    }
  }

  let tier3Rate = null;
  if (!st.hasExternalUsage && (st.lastUnpricedCalls || 0) === 0 && st.lastOfficialUsedPct !== null) {
    const out = qrFormatOutput(st, st.lastOfficialUsedPct);
    const netUsedPct = Math.max(
      0,
      st.lastOfficialUsedPct -
        out.reservedPct -
        (Number(st.externalUsedPct) || 0) -
        (Number(st.safetyReviewUsedPct) || 0)
    );
    const calls = Math.max(0, Number(st.lastCycleCalls) || 0);
    const cost = Math.max(0, Number(st.lastCycleCostUsd) || 0);
    const minCost = win === '5h' ? QR_COLD_RATIO_5H_MIN_COST_USD : QR_COLD_RATIO_WK_MIN_COST_USD;
    const minPct = win === '5h' ? QR_COLD_RATIO_5H_PCT : QR_COLD_RATIO_WK_PCT;
    const unlocked =
      cost >= minCost &&
      ((netUsedPct >= minPct && calls >= QR_COLD_RATIO_MIN_CALLS) ||
        (netUsedPct >= QR_COLD_RATIO_SOLO_PCT && calls >= QR_COLD_RATIO_SOLO_MIN_CALLS));
    if (unlocked) {
      tier3Rate = qrClampRate(netUsedPct / cost);
    }
  }

  const prelimRate = tier2Rate ?? tier3Rate;
  if (prelimRate === null) return null;
  const prelimSource = tier2Rate !== null ? 'anchor_slope' : 'cycle_ratio';
  if (cleanWin.length > 0) {
    const cleanMed = qrComputeMedian(cleanWin);
    if (cleanMed !== null) {
      const w = cleanWin.length / (cleanWin.length + QR_MODEL_RATE_MIN_UI_SAMPLES);
      const blended = qrClampRate(cleanMed * w + prelimRate * (1 - w));
      if (blended !== null) {
        return {
          rate: blended,
          source: prelimSource,
          isPreliminary: true,
          samples: cleanWin.length,
        };
      }
    }
  }
  return {
    rate: prelimRate,
    source: prelimSource,
    isPreliminary: true,
    samples: 0,
  };
}

function qrBuildPoolRateEstimate(st5h, stWk, nowMs = Date.now(), { out5h = null, outWk = null } = {}) {
  const resolved5h = qrResolveBucketDisplayRate(st5h, '5h');
  const resolvedWk = qrResolveBucketDisplayRate(stWk, 'weekly');
  const raw5hPool = resolved5h ? resolved5h.rate : null;
  const rawWkPool = resolvedWk ? resolvedWk.rate : null;
  const rate5hPool = raw5hPool !== null ? +raw5hPool.toFixed(4) : null;
  const rateWkPool = rawWkPool !== null ? +rawWkPool.toFixed(4) : null;
  const fallbackPoolDensity = stWk?.usdPerMTok ?? st5h?.usdPerMTok ?? null;
  const density5hPool = st5h?.usdPerMTok ?? fallbackPoolDensity;
  const densityWkPool = stWk?.usdPerMTok ?? fallbackPoolDensity;

  const modelKeys = new Set([
    ...Object.keys(st5h?.modelRates || {}),
    ...Object.keys(stWk?.modelRates || {}),
  ]);
  const models = [];
  for (const model of modelKeys) {
    const m5 = st5h?.modelRates?.[model] || null;
    const mw = stWk?.modelRates?.[model] || null;
    const rawR5 =
      m5 && m5.rateSamples >= QR_MODEL_RATE_MIN_UI_SAMPLES && Number.isFinite(m5.ratePctPerUsd)
        ? m5.ratePctPerUsd
        : null;
    const rawRw =
      mw && mw.rateSamples >= QR_MODEL_RATE_MIN_UI_SAMPLES && Number.isFinite(mw.ratePctPerUsd)
        ? mw.ratePctPerUsd
        : null;
    if (rawR5 === null && rawRw === null) continue;
    const rawEq5hUsd = rawR5 ? 100 / rawR5 : null;
    const rawEqWkUsd = rawRw ? 100 / rawRw : null;
    const modelDensity5h =
      st5h?.modelUsdPerMTok?.[model] ?? stWk?.modelUsdPerMTok?.[model] ?? density5hPool;
    const modelDensityWk =
      stWk?.modelUsdPerMTok?.[model] ?? st5h?.modelUsdPerMTok?.[model] ?? densityWkPool;
    const eq5hTok = qrDeriveEqFullTokens(rawEq5hUsd, modelDensity5h);
    const eqWkTok = qrDeriveEqFullTokens(rawEqWkUsd, modelDensityWk);
    models.push({
      model,
      rate5hPctPerUsd: rawR5 !== null ? +rawR5.toFixed(4) : null,
      rateWeeklyPctPerUsd: rawRw !== null ? +rawRw.toFixed(4) : null,
      eqFull5hUsd: rawEq5hUsd ? +rawEq5hUsd.toFixed(1) : null,
      eqFullWeeklyUsd: rawEqWkUsd ? +rawEqWkUsd.toFixed(1) : null,
      ...(eq5hTok !== null ? { eqFull5hTokens: eq5hTok } : {}),
      ...(eqWkTok !== null ? { eqFullWeeklyTokens: eqWkTok } : {}),
      multiplier: null,
      samples: Math.max(m5?.rateSamples || 0, mw?.rateSamples || 0),
      _rawR5: rawR5,
      _rawRw: rawRw,
    });
  }

  if (models.length >= 2) {
    const allHave5h = models.every((m) => m._rawR5 !== null);
    const allHaveWk = models.every((m) => m._rawRw !== null);
    const basisList = allHave5h
      ? models.map((m) => m._rawR5)
      : allHaveWk
        ? models.map((m) => m._rawRw)
        : null;
    if (basisList) {
      const minBasis = Math.min(...basisList);
      if (minBasis > 0) {
        for (let i = 0; i < models.length; i += 1) {
          models[i].multiplier = +(basisList[i] / minBasis).toFixed(1);
        }
      }
    }
  }

  models.sort(
    (a, b) =>
      (b.multiplier ?? 0) - (a.multiplier ?? 0) ||
      (b._rawR5 ?? b._rawRw ?? 0) - (a._rawR5 ?? a._rawRw ?? 0) ||
      b.samples - a.samples ||
      a.model.localeCompare(b.model)
  );
  for (const m of models) {
    delete m._rawR5;
    delete m._rawRw;
  }

  const extDetected = Boolean(st5h?.hasExternalUsage || stWk?.hasExternalUsage);
  const lastExtAtMs = Math.max(
    Number(st5h?.lastExternalUsageAtMs) || 0,
    Number(stWk?.lastExternalUsageAtMs) || 0
  );
  const extActiveRecently =
    lastExtAtMs > 0 && nowMs >= lastExtAtMs && nowMs - lastExtAtMs <= QR_EXTERNAL_ACTIVE_WINDOW_MS;
  const ext5hPct =
    out5h && Number.isFinite(Number(out5h.externalUsedPct))
      ? +Number(out5h.externalUsedPct).toFixed(1)
      : +(Number(st5h?.externalUsedPct) || 0).toFixed(1);
  const extWkPct =
    outWk && Number.isFinite(Number(outWk.externalUsedPct))
      ? +Number(outWk.externalUsedPct).toFixed(1)
      : +(Number(stWk?.externalUsedPct) || 0).toFixed(1);
  const extEvents = (Number(st5h?.externalEvents) || 0) + (Number(stWk?.externalEvents) || 0);
  const externalUsage = extDetected
    ? {
        detected: true,
        activeRecently: extActiveRecently,
        used5hPct: ext5hPct,
        usedWeeklyPct: extWkPct,
        events: extEvents,
        lastSeenAtMs: lastExtAtMs || null,
      }
    : null;

  if (models.length === 0 && rate5hPool === null && rateWkPool === null && !externalUsage) {
    return null;
  }

  const rawPoolEq5hUsd = raw5hPool ? 100 / raw5hPool : null;
  const rawPoolEqWkUsd = rawWkPool ? 100 / rawWkPool : null;
  const poolEq5hTok = qrDeriveEqFullTokens(rawPoolEq5hUsd, density5hPool);
  const poolEqWkTok = qrDeriveEqFullTokens(rawPoolEqWkUsd, densityWkPool);

  return {
    rate5hPctPerUsd: rate5hPool,
    rateWeeklyPctPerUsd: rateWkPool,
    eqFull5hUsd: rawPoolEq5hUsd ? +rawPoolEq5hUsd.toFixed(1) : null,
    eqFullWeeklyUsd: rawPoolEqWkUsd ? +rawPoolEqWkUsd.toFixed(1) : null,
    ...(poolEq5hTok !== null ? { eqFull5hTokens: poolEq5hTok } : {}),
    ...(poolEqWkTok !== null ? { eqFullWeeklyTokens: poolEqWkTok } : {}),
    samples5h: resolved5h ? resolved5h.samples : st5h?.rateSamples || 0,
    samplesWeekly: resolvedWk ? resolvedWk.samples : stWk?.rateSamples || 0,
    source5h: resolved5h ? resolved5h.source : null,
    sourceWeekly: resolvedWk ? resolvedWk.source : null,
    isPreliminary5h: Boolean(resolved5h?.isPreliminary),
    isPreliminaryWeekly: Boolean(resolvedWk?.isPreliminary),
    models,
    ...(externalUsage ? { externalUsage } : {}),
  };
}

function qrResolveIdleExternalThreshold(win) {
  if (win === '5h') return QR_EXTERNAL_MIN_IDLE_5H_DELTA_PCT;
  if (win === 'weekly') return QR_EXTERNAL_MIN_IDLE_WK_DELTA_PCT;
  return QR_EXTERNAL_MIN_IDLE_DELTA_PCT;
}

function qrResolveLocalCoverTolerance(localExpectedPct) {
  return Math.max(
    QR_EXTERNAL_SOLO_DRIFT_FLOOR_PCT,
    Math.max(0, Number(localExpectedPct) || 0) * QR_EXTERNAL_LOCAL_COVER_RATIO
  );
}

function qrResolveSoloDriftTolerance(localExpectedPct) {
  return Math.max(
    QR_EXTERNAL_SOLO_DRIFT_FLOOR_PCT,
    Math.max(0, Number(localExpectedPct) || 0) * QR_EXTERNAL_SOLO_DRIFT_RATIO
  );
}

function qrIsSafetyReviewEligiblePool(poolKey, poolObj) {
  const pk = String(poolKey || '').trim().toLowerCase();
  if (pk === 'gemini') return true;
  const fam = String(poolObj?.family || '').trim().toLowerCase();
  return fam === 'gemini' && pk !== 'carbon' && pk !== 'argon';
}

function qrCollectUnmatchedHeavySafetyEvents(st, safetyMonitor, safeFetchTs, nowMs) {
  const events = Array.isArray(safetyMonitor?.recentHeavyEvents)
    ? safetyMonitor.recentHeavyEvents
    : null;
  if (!events || events.length === 0) {
    return { count: 0, latestTsMs: 0, totalChars: 0 };
  }
  const lastAttributed = Number(st?.lastAttributedSafetyEventMs) || 0;
  const refHigh = Math.max(Number(safeFetchTs) || 0, Number(nowMs) || 0) + 5_000;
  const prevQuotaTs = Number(st?.lastQuotaTs) || 0;
  const minWindowFloor = Math.max(0, nowMs - QR_SAFETY_EVENT_MAX_LOOKBACK_MS);
  const rawLower =
    prevQuotaTs > 0
      ? Math.min(prevQuotaTs - 15_000, nowMs - QR_SAFETY_EVENT_MATCH_WINDOW_MS)
      : nowMs - QR_SAFETY_EVENT_MATCH_WINDOW_MS;
  const lowerBound = Math.max(lastAttributed, minWindowFloor, rawLower);

  let count = 0;
  let latestTsMs = 0;
  let totalChars = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (!ev || ev.tsMs <= lowerBound) break;
    if (ev.tsMs > refHigh) continue;
    count += 1;
    totalChars += Number(ev.trajChars) || 0;
    if (ev.tsMs > latestTsMs) latestTsMs = ev.tsMs;
  }
  return { count, latestTsMs, totalChars };
}

function qrComputeObservedCycleSafetyPct(st, safetyMonitor, win, safeResetMs, nowMs, fallbackRate) {
  if (!safetyMonitor || typeof safetyMonitor !== 'object') {
    return { estPct: 0, latestEventMs: 0, heavyCalls: 0 };
  }
  const rate =
    Number.isFinite(Number(fallbackRate)) && Number(fallbackRate) > 0
      ? Number(fallbackRate)
      : Number(st?.ratePctPerUsd) > 0
        ? Number(st.ratePctPerUsd)
        : 0;
  if (rate <= 0) {
    return { estPct: 0, latestEventMs: 0, heavyCalls: 0 };
  }
  const winMs = win === 'weekly' ? 7 * 24 * 60 * 60 * 1000 : 5 * 60 * 60 * 1000;
  const cycleStartMs =
    safeResetMs > 0 ? Math.max(0, safeResetMs - winMs) : Math.max(0, nowMs - winMs);
  const summary = summarizeSafetyMonitorWindow(
    safetyMonitor.minuteBuckets,
    safetyMonitor.recentHeavyEvents,
    cycleStartMs,
    nowMs
  );
  if (!summary || (summary.heavyCalls <= 0 && summary.flashLiteCalls <= 0)) {
    return { estPct: 0, latestEventMs: 0, heavyCalls: 0 };
  }
  const heavyUsd =
    summary.heavyTrajChars > 0
      ? (summary.heavyTrajChars / 1_000_000 / QR_SAFETY_CHARS_PER_TOKEN_EST) *
        QR_SAFETY_SONAR_INPUT_USD_PER_MTOK
      : summary.heavyCalls * 0.14;
  const flashLiteUsd = summary.flashLiteCalls * QR_SAFETY_FLASH_LITE_EST_USD_PER_CALL;
  const estPct = (heavyUsd + flashLiteUsd) * rate;
  const latestEventMs = Math.max(
    Number(safetyMonitor.lastHeavyEventAtMs) || 0,
    Number(safetyMonitor.lastAnyMonitorAtMs) || 0
  );
  return {
    estPct: Number.isFinite(estPct) && estPct > 0 ? estPct : 0,
    latestEventMs,
    heavyCalls: summary.heavyCalls,
  };
}

function qrComputeCycleUnexplained(st, safeUsed, safeCost, safeModelCosts, safeUnpriced = 0) {
  const leaseSum = qrSumLeases(st?.activeLeases || [], { includeTentative: true });
  const safetyReviewPct = Math.max(0, Number(st?.safetyReviewUsedPct) || 0);
  const cleanWin = Array.isArray(st?.rateWindow) ? st.rateWindow : [];
  const isCalibrated = Boolean(
    st &&
      cleanWin.length >= QR_MODEL_RATE_MIN_UI_SAMPLES &&
      safeUnpriced === 0 &&
      Number.isFinite(st.ratePctPerUsd) &&
      st.ratePctPerUsd > 0
  );
  if (!isCalibrated) {
    return {
      isCalibrated: false,
      leaseSum,
      safetyReviewPct,
      localExpectedPct: 0,
      unexplainedPct: null,
      localCoverTolerance: QR_EXTERNAL_SOLO_DRIFT_FLOOR_PCT,
      soloTolerance: QR_EXTERNAL_SOLO_DRIFT_FLOOR_PCT,
    };
  }
  const localExpectedPct = qrEstimateModelWeightedPct(
    st,
    safeModelCosts,
    safeCost,
    st.ratePctPerUsd
  );
  const unexplainedPct = Math.max(0, safeUsed - leaseSum - safetyReviewPct - localExpectedPct);
  return {
    isCalibrated: true,
    leaseSum,
    safetyReviewPct,
    localExpectedPct,
    unexplainedPct,
    localCoverTolerance: qrResolveLocalCoverTolerance(localExpectedPct),
    soloTolerance: qrResolveSoloDriftTolerance(localExpectedPct),
  };
}

function qrComputeBucketDeltaPreview(
  st,
  { officialUsedPct, resetTimeMs, quotaFetchedAtMs, cycleCostUsd, modelCostsUsd, unpricedCalls = 0, nowMs }
) {
  if (!st || st.lastOfficialUsedPct === null || st.pendingDrop) return null;
  if (officialUsedPct === null || !Number.isFinite(officialUsedPct)) return null;
  const safeUsed = qrClamp(Number(officialUsedPct), 0, 100);
  const safeCost = Math.max(0, Number(cycleCostUsd) || 0);
  const safeUnpriced = Math.max(0, Number(unpricedCalls) || 0);
  if (safeUnpriced > (Number(st.lastUnpricedCalls) || 0)) return null;
  const safeResetMs = Number(resetTimeMs) > 0 ? Number(resetTimeMs) : 0;
  const safeFetchTs = Number(quotaFetchedAtMs) > 0 ? Number(quotaFetchedAtMs) : nowMs;
  const resetShifted =
    safeResetMs > 0 &&
    st.resetTimeMs > 0 &&
    Math.abs(safeResetMs - st.resetTimeMs) > QR_CYCLE_RESET_SHIFT_MS;
  const rolloverDrop = st.lastOfficialUsedPct >= 5 && safeUsed < 1;
  if (resetShifted || rolloverDrop) return null;
  const isFreshSample =
    safeFetchTs !== st.lastQuotaTs || Math.abs(safeUsed - st.lastOfficialUsedPct) > 1e-4;
  if (!isFreshSample) return null;

  const rate = st.ratePctPerUsd;
  const cleanWinLen = Array.isArray(st.rateWindow) ? st.rateWindow.length : 0;
  if (
    rate === null ||
    !Number.isFinite(rate) ||
    rate <= 0 ||
    Math.max(cleanWinLen, st.rateSamples || 0) < QR_MODEL_RATE_MIN_UI_SAMPLES
  ) {
    return null;
  }
  const deltaOfficial = safeUsed - st.lastOfficialUsedPct;
  if (deltaOfficial <= 1e-3) return null;

  const rawDeltaCost = Math.max(0, safeCost - st.lastCycleCostUsd);
  const safeModelCosts = qrSanitizeModelCosts(modelCostsUsd);
  const cycleInfo = qrComputeCycleUnexplained(st, safeUsed, safeCost, safeModelCosts, safeUnpriced);
  if (cycleInfo.isCalibrated && safeCost > 0 && cycleInfo.unexplainedPct <= cycleInfo.localCoverTolerance) {
    // 累计官方已用仍完全被本机已落盘周期花费覆盖（如上游延迟补账），不视为外部同涨
    return null;
  }
  const prevModelCosts = st.lastModelCostsUsd && typeof st.lastModelCostsUsd === 'object' ? st.lastModelCostsUsd : {};
  const hasValidPrevModelBaseline =
    st.lastCycleCostUsd <= 1e-6 || Object.keys(prevModelCosts).length > 0;
  const rawDeltaModelCosts = {};
  if (hasValidPrevModelBaseline) {
    for (const [mKey, curModelCost] of Object.entries(safeModelCosts)) {
      const dModel = curModelCost - (Number(prevModelCosts[mKey]) || 0);
      if (dModel > 1e-6) rawDeltaModelCosts[mKey] = dModel;
    }
  }
  const pendingValid =
    st.pendingCostUsd > 0 && nowMs - st.pendingCostAtMs <= QR_PENDING_COST_TTL_MS;
  const effectiveDeltaCost = rawDeltaCost + (pendingValid ? st.pendingCostUsd : 0);
  const effectiveDeltaModelCosts = { ...rawDeltaModelCosts };
  if (pendingValid && st.pendingModelCostsUsd && typeof st.pendingModelCostsUsd === 'object') {
    for (const [mKey, pCost] of Object.entries(st.pendingModelCostsUsd)) {
      if (Number.isFinite(pCost) && pCost > 0) {
        effectiveDeltaModelCosts[mKey] = (effectiveDeltaModelCosts[mKey] || 0) + pCost;
      }
    }
  }
  const expectedDeltaPct = qrEstimateModelWeightedPct(
    st,
    effectiveDeltaModelCosts,
    effectiveDeltaCost,
    rate
  );
  const excessPct = deltaOfficial - expectedDeltaPct;
  return { rate, deltaOfficial, expectedDeltaPct, excessPct, effectiveDeltaCost };
}

function qrDetectProportionalExternalJump(
  st5h,
  stWk,
  params5h,
  paramsWk,
  { hasRunningLocalSession = false, externalActiveRecently = false, localScanIncomplete = false } = {}
) {
  if (localScanIncomplete) return false;
  const p5 = qrComputeBucketDeltaPreview(st5h, params5h);
  const pw = qrComputeBucketDeltaPreview(stWk, paramsWk);
  if (!p5 || !pw) return false;
  if (
    hasRunningLocalSession &&
    !externalActiveRecently &&
    p5.effectiveDeltaCost <= 1e-6 &&
    pw.effectiveDeltaCost <= 1e-6
  ) {
    // 本机会话正在运行且本地账单尚未落盘时，官方先扣费导致的 5h/周限同涨属于扫描延迟而非外部消耗
    return false;
  }
  if (p5.rate / pw.rate < QR_CO_MOVE_MIN_RATE_RATIO) return false;
  const min5hExcess = externalActiveRecently
    ? QR_CO_MOVE_SHARED_MIN_5H_EXCESS_PCT
    : QR_CO_MOVE_SOLO_MIN_5H_EXCESS_PCT;
  const minWkExcess = externalActiveRecently
    ? QR_CO_MOVE_SHARED_MIN_WK_EXCESS_PCT
    : QR_CO_MOVE_SOLO_MIN_WK_EXCESS_PCT;
  if (p5.excessPct < min5hExcess) return false;
  if (pw.excessPct < minWkExcess) return false;
  if (!externalActiveRecently) {
    if (
      p5.effectiveDeltaCost > 0 &&
      p5.expectedDeltaPct > 0 &&
      p5.excessPct < p5.expectedDeltaPct * QR_CO_MOVE_SOLO_MIN_EXCESS_RATIO
    ) {
      return false;
    }
    if (
      pw.effectiveDeltaCost > 0 &&
      pw.expectedDeltaPct > 0 &&
      pw.excessPct < pw.expectedDeltaPct * QR_CO_MOVE_SOLO_MIN_EXCESS_RATIO
    ) {
      return false;
    }
  }
  const impliedUsd5h = p5.excessPct / p5.rate;
  const impliedUsdWk = pw.excessPct / pw.rate;
  if (!Number.isFinite(impliedUsd5h) || !Number.isFinite(impliedUsdWk) || impliedUsdWk <= 1e-6) {
    return false;
  }
  const usdRatio = impliedUsd5h / impliedUsdWk;
  return usdRatio >= QR_CO_MOVE_MIN_USD_RATIO && usdRatio <= QR_CO_MOVE_MAX_USD_RATIO;
}

function qrComputeBaselineExternalPct(st, safeUsed, safeCost, safeModelCosts, safeUnpriced = 0) {
  if (safeUsed < QR_EXTERNAL_BASELINE_USED_PCT) return 0;
  if (
    st &&
    safeCost > 0 &&
    safeUnpriced === 0 &&
    Number.isFinite(st.ratePctPerUsd) &&
    st.ratePctPerUsd > 0
  ) {
    const localExpected = qrEstimateModelWeightedPct(st, safeModelCosts, safeCost, st.ratePctPerUsd);
    const unexplained = Math.max(0, safeUsed - localExpected);
    return unexplained >= QR_MIN_DISPLAY_RESERVED_PCT ? qrClamp(unexplained, 0, safeUsed) : 0;
  }
  return qrClamp(safeUsed, 0, 100);
}

function qrReconcileExpiredTentativeLeases(
  st,
  {
    expiredTentativePct = 0,
    latestTentativeCreatedAtMs = 0,
    safeUsed = 0,
    safeCost = 0,
    safeModelCosts = null,
    safeUnpriced = 0,
    localScanIncomplete = false,
    nowMs = Date.now(),
  } = {}
) {
  if (
    !st ||
    expiredTentativePct < QR_MIN_DISPLAY_RESERVED_PCT ||
    localScanIncomplete ||
    st.pendingDrop !== null ||
    safeUnpriced > 0
  ) {
    return 0;
  }
  const remainingLeaseSum = qrSumLeases(st.activeLeases || [], { includeTentative: true });
  const curExtPct = Math.max(0, Number(st.externalUsedPct) || 0);
  let attrPct = 0;

  if (st.ratePctPerUsd !== null && Number.isFinite(st.ratePctPerUsd) && st.ratePctPerUsd > 0) {
    const localExpectedPct = qrEstimateModelWeightedPct(
      st,
      safeModelCosts,
      safeCost,
      st.ratePctPerUsd
    );
    const safetyReviewPct = Math.max(0, Number(st.safetyReviewUsedPct) || 0);
    const unexplainedTotal = Math.max(
      0,
      safeUsed - remainingLeaseSum - safetyReviewPct - localExpectedPct
    );
    const soloTol = qrResolveSoloDriftTolerance(localExpectedPct);
    const maxAddable = Math.max(
      0,
      safeUsed - remainingLeaseSum - safetyReviewPct - localExpectedPct - curExtPct
    );
    if (unexplainedTotal > soloTol && maxAddable >= QR_MIN_DISPLAY_RESERVED_PCT) {
      attrPct = Math.min(expiredTentativePct, maxAddable);
    }
  } else if (st.hasExternalUsage && safeCost < QR_EXTERNAL_BASELINE_MAX_LOCAL_COST_USD) {
    const safetyReviewPct = Math.max(0, Number(st.safetyReviewUsedPct) || 0);
    const maxAddable = Math.max(0, safeUsed - remainingLeaseSum - safetyReviewPct - curExtPct);
    if (maxAddable >= QR_MIN_DISPLAY_RESERVED_PCT) {
      attrPct = Math.min(expiredTentativePct, maxAddable);
    }
  }

  if (attrPct < QR_MIN_DISPLAY_RESERVED_PCT) {
    return 0;
  }
  const eventTs =
    latestTentativeCreatedAtMs > 0 ? Math.min(nowMs, latestTentativeCreatedAtMs) : nowMs;
  st.hasExternalUsage = true;
  st.externalUsedPct = qrClamp(curExtPct + attrPct, 0, Math.max(0, safeUsed - remainingLeaseSum));
  st.externalEvents = (Number(st.externalEvents) || 0) + 1;
  st.lastExternalUsageAtMs = Math.max(Number(st.lastExternalUsageAtMs) || 0, eventTs);
  return attrPct;
}

function qrComputeModelUncertainty(st, safeCost, safeModelCosts) {
  const fallbackRate = st?.ratePctPerUsd;
  if (!st || !Number.isFinite(fallbackRate) || fallbackRate <= 0 || safeCost <= 0) {
    return { uncalibratedCostShare: 0, modelUncertPct: 0 };
  }
  const modelCosts = safeModelCosts && typeof safeModelCosts === 'object' ? safeModelCosts : null;
  if (!modelCosts) {
    return { uncalibratedCostShare: 0, modelUncertPct: 0 };
  }
  const entries = Object.entries(modelCosts);
  if (entries.length === 0) {
    return { uncalibratedCostShare: 0, modelUncertPct: 0 };
  }
  const modelRates = st.modelRates && typeof st.modelRates === 'object' ? st.modelRates : {};
  let attributedCost = 0;
  let uncalibratedCost = 0;
  let calibratedModelCount = 0;
  for (const [mKey, costVal] of entries) {
    const c = Number(costVal) || 0;
    if (c <= 0) continue;
    attributedCost += c;
    const mr = modelRates[mKey];
    if (mr && mr.rateSamples >= 2 && Number.isFinite(mr.ratePctPerUsd) && mr.ratePctPerUsd > 0) {
      calibratedModelCount += 1;
    } else {
      uncalibratedCost += c;
    }
  }
  if (attributedCost <= 0) {
    return { uncalibratedCostShare: 0, modelUncertPct: 0 };
  }
  if (calibratedModelCount === 0 && entries.length === 1) {
    return { uncalibratedCostShare: 0, modelUncertPct: 0 };
  }
  const missingCost = Math.max(0, safeCost - attributedCost);
  const totalUncalibratedCost = uncalibratedCost + missingCost;
  const uncalibratedCostShare = qrClamp(
    totalUncalibratedCost / Math.max(safeCost, attributedCost),
    0,
    1
  );
  const modelUncertPct = totalUncalibratedCost * fallbackRate * QR_EXTERNAL_MODEL_UNCERT_MULT;
  return { uncalibratedCostShare, modelUncertPct };
}

function qrReconcileExternalUsageBound(
  st,
  safeUsed,
  safeCost,
  safeModelCosts,
  nowMs,
  {
    localScanIncomplete = false,
    hasRunningLocalSession = false,
    suppressIdleExternal = false,
    peerHasExternalUsage = false,
    observedCycleSafetyPct = 0,
    observedSafetyLatestMs = 0,
  } = {}
) {
  if (!st) return false;
  let mutated = false;
  const leaseSum0 = qrSumLeases(st.activeLeases || [], { includeTentative: true });
  const hasAnyValidRate =
    (st.lastUnpricedCalls || 0) === 0 &&
    Number.isFinite(st.ratePctPerUsd) &&
    st.ratePctPerUsd > 0;
  const effLocalExp = hasAnyValidRate
    ? qrEstimateModelWeightedPct(st, safeModelCosts, safeCost, st.ratePctPerUsd)
    : null;

  const curSafetyPct = Math.max(0, Number(st.safetyReviewUsedPct) || 0);
  const maxSafetyPhysical =
    effLocalExp !== null
      ? Math.max(0, safeUsed - leaseSum0 - effLocalExp * (1 - QR_EXTERNAL_SOLO_DRIFT_RATIO))
      : Math.max(0, safeUsed - leaseSum0);
  if (curSafetyPct > maxSafetyPhysical + 1e-3) {
    const clampedSafety =
      maxSafetyPhysical < QR_MIN_DISPLAY_RESERVED_PCT ? 0 : maxSafetyPhysical;
    if (Math.abs(curSafetyPct - clampedSafety) > 1e-3) {
      st.safetyReviewUsedPct = clampedSafety;
      mutated = true;
    }
  }

  let promotedFromExternal = 0;
  if (
    !localScanIncomplete &&
    !suppressIdleExternal &&
    st.pendingDrop === null &&
    Number(observedCycleSafetyPct) > 0 &&
    effLocalExp !== null
  ) {
    const rawResidualBeforeSafety = Math.max(0, safeUsed - leaseSum0 - effLocalExp);
    const backedSafetyTarget = Math.min(rawResidualBeforeSafety, Number(observedCycleSafetyPct));
    const curSafetyNow = Math.max(0, Number(st.safetyReviewUsedPct) || 0);
    if (backedSafetyTarget > curSafetyNow + QR_EXTERNAL_RECONCILE_DEADBAND_PCT) {
      const deltaPromote = backedSafetyTarget - curSafetyNow;
      st.safetyReviewUsedPct =
        backedSafetyTarget < QR_MIN_DISPLAY_RESERVED_PCT ? 0 : backedSafetyTarget;
      if (observedSafetyLatestMs > 0) {
        st.lastSafetyReviewAtMs = Math.max(
          Number(st.lastSafetyReviewAtMs) || 0,
          observedSafetyLatestMs
        );
      }
      const curExtBeforePromote = Math.max(0, Number(st.externalUsedPct) || 0);
      if (curExtBeforePromote > 0) {
        promotedFromExternal = Math.min(curExtBeforePromote, deltaPromote);
        const nextExt = Math.max(0, curExtBeforePromote - promotedFromExternal);
        st.externalUsedPct = nextExt < QR_MIN_DISPLAY_RESERVED_PCT ? 0 : nextExt;
      }
      mutated = true;
    }
  }

  const curExtPct = Number(st.externalUsedPct) || 0;
  const hasExistingExternal = Boolean(st.hasExternalUsage || curExtPct > 0);
  const cycleInfo = qrComputeCycleUnexplained(
    st,
    safeUsed,
    safeCost,
    safeModelCosts,
    st.lastUnpricedCalls || 0
  );

  if (!hasExistingExternal && !cycleInfo.isCalibrated) {
    return mutated;
  }

  const maxResidualCap = Math.max(0, safeUsed - cycleInfo.leaseSum - cycleInfo.safetyReviewPct);

  if (hasExistingExternal) {
    // 本周期累计外部消耗物理上不可能超过（官方累计已用 - 活跃租约 - 本机安全审查 - 已校准本机下界）
    const maxExternalBound = cycleInfo.isCalibrated
      ? Math.max(
          0,
          safeUsed -
            cycleInfo.leaseSum -
            cycleInfo.safetyReviewPct -
            cycleInfo.localExpectedPct * (1 - QR_EXTERNAL_SOLO_DRIFT_RATIO)
        )
      : maxResidualCap;
    if (curExtPct > maxExternalBound + 1e-3) {
      const clamped = maxExternalBound < QR_MIN_DISPLAY_RESERVED_PCT ? 0 : maxExternalBound;
      if (Math.abs(curExtPct - clamped) > 1e-3) {
        st.externalUsedPct = clamped;
        mutated = true;
      }
    }
    const recentExt =
      (Number(st.lastExternalUsageAtMs) || 0) > 0 &&
      nowMs >= st.lastExternalUsageAtMs &&
      nowMs - st.lastExternalUsageAtMs <= QR_EXTERNAL_ACTIVE_WINDOW_MS;
    const fullyExplainedByLocal =
      cycleInfo.isCalibrated &&
      safeCost > 0 &&
      safeUsed >= 0.05 &&
      cycleInfo.unexplainedPct < QR_MIN_DISPLAY_RESERVED_PCT;
    const explainedWithinSoloDrift =
      cycleInfo.isCalibrated &&
      safeCost > 0 &&
      safeUsed >= 0.05 &&
      !recentExt &&
      cycleInfo.unexplainedPct <= cycleInfo.soloTolerance;
    const effResidualAfterSafety =
      effLocalExp !== null
        ? Math.max(
            0,
            safeUsed - leaseSum0 - (Number(st.safetyReviewUsedPct) || 0) - effLocalExp
          )
        : null;
    const effSoloTol = effLocalExp !== null ? qrResolveSoloDriftTolerance(effLocalExp) : 0;
    const healedByObservedSafety =
      effResidualAfterSafety !== null &&
      (Number(st.safetyReviewUsedPct) || 0) >= QR_MIN_DISPLAY_RESERVED_PCT &&
      effResidualAfterSafety <= effSoloTol &&
      (promotedFromExternal > 0 ||
        (Number(st.externalUsedPct) || 0) < QR_MIN_DISPLAY_RESERVED_PCT) &&
      (observedSafetyLatestMs <= 0 ||
        (Number(st.lastExternalUsageAtMs) || 0) <= observedSafetyLatestMs + 60_000);
    const pollutedUncalibratedColdStart =
      !cycleInfo.isCalibrated &&
      st.ratePctPerUsd === null &&
      (st.lastUnpricedCalls || 0) === 0 &&
      !recentExt &&
      safeCost >= 1.0 &&
      safeUsed >= 1.0 &&
      (Number(st.externalEvents) || 0) <= 1 &&
      (Number(st.externalUsedPct) || 0) > 0 &&
      (Number(st.externalUsedPct) || 0) <= safeUsed * 0.1;
    if (
      fullyExplainedByLocal ||
      explainedWithinSoloDrift ||
      healedByObservedSafety ||
      pollutedUncalibratedColdStart
    ) {
      if (
        st.hasExternalUsage ||
        (Number(st.externalUsedPct) || 0) > 0 ||
        (Number(st.externalEvents) || 0) > 0 ||
        (Number(st.lastExternalUsageAtMs) || 0) > 0
      ) {
        st.hasExternalUsage = false;
        st.externalUsedPct = 0;
        st.externalEvents = 0;
        st.lastExternalUsageAtMs = 0;
        mutated = true;
      }
      return mutated;
    }
  }

  // 已校准周期总账闭环对齐：修复升级前存量、离线/切号期间、活跃期小步并发外部消耗及租约过期导致的非自用漏算
  if (
    cycleInfo.isCalibrated &&
    !localScanIncomplete &&
    !suppressIdleExternal &&
    st.pendingDrop === null &&
    maxResidualCap >= QR_MIN_DISPLAY_RESERVED_PCT
  ) {
    const { uncalibratedCostShare, modelUncertPct } = qrComputeModelUncertainty(
      st,
      safeCost,
      safeModelCosts
    );
    const upwardGuardTol = cycleInfo.soloTolerance + modelUncertPct;
    const highCoverage = uncalibratedCostShare <= QR_EXTERNAL_HIGH_COVERAGE_MAX_UNCAL_SHARE;

    if (st.hasExternalUsage) {
      if (cycleInfo.unexplainedPct > upwardGuardTol) {
        const currentAfterClamp = Number(st.externalUsedPct) || 0;
        const targetExtPct = highCoverage
          ? qrClamp(cycleInfo.unexplainedPct, 0, maxResidualCap)
          : qrClamp(
              Math.max(currentAfterClamp, cycleInfo.unexplainedPct - modelUncertPct),
              0,
              maxResidualCap
            );
        if (Math.abs(currentAfterClamp - targetExtPct) >= QR_EXTERNAL_RECONCILE_DEADBAND_PCT) {
          st.externalUsedPct =
            targetExtPct < QR_MIN_DISPLAY_RESERVED_PCT ? 0 : targetExtPct;
          mutated = true;
        }
      }
    } else {
      const peerCorroborated =
        peerHasExternalUsage &&
        cycleInfo.unexplainedPct >= Math.max(QR_EXTERNAL_PEER_RESIDUAL_MIN_PCT, upwardGuardTol);
      const standaloneConfirmed =
        !peerHasExternalUsage &&
        (Number(st.rateSamples) || 0) >= QR_EXTERNAL_RESIDUAL_MIN_SAMPLES &&
        (!hasRunningLocalSession ||
          cycleInfo.unexplainedPct >= Math.max(5.0, upwardGuardTol * 1.5)) &&
        cycleInfo.unexplainedPct >=
          Math.max(QR_EXTERNAL_BASELINE_USED_PCT, upwardGuardTol * 1.25);
      if (peerCorroborated || standaloneConfirmed) {
        const targetExtPct = qrClamp(
          highCoverage
            ? cycleInfo.unexplainedPct
            : Math.max(0, cycleInfo.unexplainedPct - modelUncertPct),
          0,
          maxResidualCap
        );
        if (targetExtPct >= QR_MIN_DISPLAY_RESERVED_PCT) {
          st.hasExternalUsage = true;
          st.externalUsedPct = targetExtPct;
          mutated = true;
        }
      }
    }
  }

  return mutated;
}

function qrSanitizePersistedBucket(raw, { preserveRate = true } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const lastOfficial =
    raw.lastOfficialUsedPct !== undefined &&
    raw.lastOfficialUsedPct !== null &&
    Number.isFinite(Number(raw.lastOfficialUsedPct))
      ? qrClamp(Number(raw.lastOfficialUsedPct), 0, 100)
      : null;
  const rateWindow =
    preserveRate && Array.isArray(raw.rateWindow)
      ? raw.rateWindow
          .map((v) => qrClampRate(Number(v)))
          .filter((v) => v !== null)
          .slice(-QR_RATE_WINDOW_SIZE)
      : [];
  const rate = preserveRate
    ? rateWindow.length > 0
      ? qrClampRate(qrComputeMedian(rateWindow))
      : raw.ratePctPerUsd !== undefined && raw.ratePctPerUsd !== null
        ? qrClampRate(Number(raw.ratePctPerUsd))
        : null
    : null;
  return {
    resetTimeMs: Math.max(0, Number(raw.resetTimeMs) || 0),
    lastQuotaTs: Math.max(0, Number(raw.lastQuotaTs) || 0),
    lastOfficialUsedPct: lastOfficial,
    lastCycleCostUsd: Math.max(0, Number(raw.lastCycleCostUsd) || 0),
    lastCycleCalls: Math.max(0, Math.floor(Number(raw.lastCycleCalls) || 0)),
    lastPricedTokens: Math.max(0, Math.floor(Number(raw.lastPricedTokens) || 0)),
    lastModelCostsUsd: qrSanitizeModelCosts(raw.lastModelCostsUsd),
    lastUnpricedCalls: Math.max(0, Number(raw.lastUnpricedCalls) || 0),
    usdPerMTok: preserveRate ? qrClampUsdPerMTok(raw.usdPerMTok) : null,
    priorUsdPerMTok: preserveRate
      ? qrClampUsdPerMTok(raw.priorUsdPerMTok ?? raw.usdPerMTok)
      : null,
    modelUsdPerMTok: qrSanitizeModelDensities(raw.modelUsdPerMTok, { preserveRate }),
    priorModelUsdPerMTok: qrSanitizeModelDensities(
      raw.priorModelUsdPerMTok ?? raw.modelUsdPerMTok,
      { preserveRate }
    ),
    slopeSamples: preserveRate ? qrSanitizeSlopeSamples(raw.slopeSamples) : [],
    pendingCostUsd: 0,
    pendingCostAtMs: 0,
    pendingCostSinceMs: 0,
    pendingModelCostsUsd: {},
    ratePctPerUsd: rate,
    rateSamples: preserveRate ? Math.max(rateWindow.length, Math.floor(Number(raw.rateSamples) || 0)) : 0,
    rateWindow,
    rateOutlierSide: 0,
    rateOutlierBuf: [],
    modelRates: qrSanitizePersistedModelRates(raw.modelRates, { preserveRate }),
    activeLeases: qrSanitizePersistedLeases(raw.activeLeases),
    pendingDrop: preserveRate ? qrSanitizePersistedPendingDrop(raw.pendingDrop) : null,
    lastBounceAtMs: Math.max(0, Number(raw.lastBounceAtMs) || 0),
    lastRefundAtMs: Math.max(0, Number(raw.lastRefundAtMs) || 0),
    lastRefundPct: Math.max(0, Number(raw.lastRefundPct) || 0),
    lastRefundHighWaterPct: qrClamp(Math.max(0, Number(raw.lastRefundHighWaterPct) || 0), 0, 100),
    hasExternalUsage: raw.hasExternalUsage === true,
    lastExternalUsageAtMs: Math.max(0, Number(raw.lastExternalUsageAtMs) || 0),
    externalUsedPct: Math.max(0, Number(raw.externalUsedPct) || 0),
    externalEvents: Math.max(0, Math.floor(Number(raw.externalEvents) || 0)),
    safetyReviewUsedPct: Math.max(0, Number(raw.safetyReviewUsedPct) || 0),
    safetyReviewEvents: Math.max(0, Math.floor(Number(raw.safetyReviewEvents) || 0)),
    lastSafetyReviewAtMs: Math.max(0, Number(raw.lastSafetyReviewAtMs) || 0),
    lastAttributedSafetyEventMs: Math.max(0, Number(raw.lastAttributedSafetyEventMs) || 0),
    idleUnexplainedAccumPct: 0,
  };
}

/**
 * 创建独立的配额预占状态追踪器（支持可选持久化钩子及单元测试隔离）。
 *
 * @param {{ loadState?: () => object|null, saveState?: (payload: object) => void }} [options]
 */
export function createQuotaReservationTracker({ loadState = null, saveState = null } = {}) {
  const buckets = new Map();
  const eventLog = [];
  let hydrated = typeof loadState !== 'function';
  let lastPersistMs = 0;
  let batchingDepth = 0;
  let batchPendingEvent = null;

  function ensureHydrated() {
    if (hydrated) return;
    hydrated = true;
    try {
      const persisted = loadState?.();
      if (!persisted || typeof persisted !== 'object') return;
      const isCurrentSchema = Number(persisted.version) === QR_STATE_SCHEMA_VERSION;
      if (persisted.buckets && typeof persisted.buckets === 'object') {
        const entries = Object.entries(persisted.buckets).slice(-QR_MAX_TRACKED_BUCKETS);
        for (const [k, rawSt] of entries) {
          // 从 v1 升级到 v2 时丢弃旧版可能被双副本抖动污染的 EMA 费率，保留历史事件日志
          const clean = qrSanitizePersistedBucket(rawSt, { preserveRate: isCurrentSchema });
          if (k && clean) {
            buckets.set(k, clean);
          }
        }
      }
      if (Array.isArray(persisted.events)) {
        const recent = persisted.events
          .filter((e) => e && typeof e === 'object' && typeof e.ts === 'string')
          .slice(-QR_MAX_EVENT_LOG);
        eventLog.push(...recent);
      }
    } catch {
      // 忽略损坏的持久化状态，自动从空白基线重建
    }
  }

  function serializeState(nowMs = Date.now()) {
    const serializedBuckets = {};
    for (const [k, st] of buckets.entries()) {
      const serializedModelRates = {};
      for (const [mKey, mr] of Object.entries(st.modelRates || {})) {
        if (!mr || mr.ratePctPerUsd === null) continue;
        serializedModelRates[mKey] = {
          ratePctPerUsd: mr.ratePctPerUsd,
          rateSamples: mr.rateSamples,
          rateWindow: mr.rateWindow,
          lastSeenMs: mr.lastSeenMs,
        };
      }
      serializedBuckets[k] = {
        resetTimeMs: st.resetTimeMs,
        lastQuotaTs: st.lastQuotaTs,
        lastOfficialUsedPct: st.lastOfficialUsedPct,
        lastCycleCostUsd: st.lastCycleCostUsd,
        lastCycleCalls: st.lastCycleCalls || 0,
        lastPricedTokens: st.lastPricedTokens || 0,
        lastModelCostsUsd: st.lastModelCostsUsd || {},
        lastUnpricedCalls: st.lastUnpricedCalls,
        ...(st.usdPerMTok !== null && Number.isFinite(st.usdPerMTok)
          ? { usdPerMTok: +st.usdPerMTok.toFixed(4) }
          : {}),
        ...(st.priorUsdPerMTok !== null && Number.isFinite(st.priorUsdPerMTok)
          ? { priorUsdPerMTok: +st.priorUsdPerMTok.toFixed(4) }
          : {}),
        ...(st.modelUsdPerMTok && Object.keys(st.modelUsdPerMTok).length > 0
          ? { modelUsdPerMTok: st.modelUsdPerMTok }
          : {}),
        ...(st.priorModelUsdPerMTok && Object.keys(st.priorModelUsdPerMTok).length > 0
          ? { priorModelUsdPerMTok: st.priorModelUsdPerMTok }
          : {}),
        ...(Array.isArray(st.slopeSamples) && st.slopeSamples.length > 0
          ? { slopeSamples: st.slopeSamples }
          : {}),
        ratePctPerUsd: st.ratePctPerUsd,
        rateSamples: st.rateSamples,
        rateWindow: st.rateWindow,
        modelRates: serializedModelRates,
        activeLeases: st.activeLeases,
        pendingDrop: st.pendingDrop,
        lastBounceAtMs: st.lastBounceAtMs,
        lastRefundAtMs: st.lastRefundAtMs,
        lastRefundPct: st.lastRefundPct,
        ...(Number(st.lastRefundHighWaterPct) > 0
          ? { lastRefundHighWaterPct: +Number(st.lastRefundHighWaterPct).toFixed(4) }
          : {}),
        hasExternalUsage: Boolean(st.hasExternalUsage),
        lastExternalUsageAtMs: st.lastExternalUsageAtMs || 0,
        externalUsedPct: +(Number(st.externalUsedPct) || 0).toFixed(3),
        externalEvents: Math.max(0, Math.floor(Number(st.externalEvents) || 0)),
        ...(Number(st.safetyReviewUsedPct) > 0
          ? { safetyReviewUsedPct: +(Number(st.safetyReviewUsedPct) || 0).toFixed(3) }
          : {}),
        ...(Number(st.safetyReviewEvents) > 0
          ? { safetyReviewEvents: Math.max(0, Math.floor(Number(st.safetyReviewEvents) || 0)) }
          : {}),
        ...(Number(st.lastSafetyReviewAtMs) > 0
          ? { lastSafetyReviewAtMs: Number(st.lastSafetyReviewAtMs) || 0 }
          : {}),
        ...(Number(st.lastAttributedSafetyEventMs) > 0
          ? { lastAttributedSafetyEventMs: Number(st.lastAttributedSafetyEventMs) || 0 }
          : {}),
      };
    }
    return {
      version: QR_STATE_SCHEMA_VERSION,
      savedAt: new Date(nowMs).toISOString(),
      buckets: serializedBuckets,
      events: eventLog.slice(-QR_MAX_EVENT_LOG),
    };
  }

  function persistIfNeeded(eventKind, nowMs) {
    if (typeof saveState !== 'function') return;
    if (
      !eventKind ||
      eventKind === 'idle' ||
      eventKind === 'lag_pending' ||
      eventKind === 'drop_pending' ||
      eventKind === 'replica_flip' ||
      eventKind === 'lease_tentative'
    ) {
      return;
    }
    const isUrgent =
      eventKind === 'lease' ||
      eventKind === 'lease_rejected' ||
      eventKind === 'external_usage' ||
      eventKind === 'refund' ||
      eventKind === 'reset' ||
      eventKind === 'expire';
    if (batchingDepth > 0) {
      if (isUrgent || !batchPendingEvent) {
        batchPendingEvent = isUrgent ? 'lease' : eventKind;
      }
      return;
    }
    if (!isUrgent && lastPersistMs > 0 && nowMs - lastPersistMs < QR_PERSIST_MIN_INTERVAL_MS) {
      return;
    }
    lastPersistMs = nowMs;
    try {
      saveState(serializeState(nowMs));
    } catch {
      // 持久化失败不影响内存态主流程
    }
  }

  function appendEventLog(entry, nowMs) {
    eventLog.push(entry);
    if (eventLog.length > QR_MAX_EVENT_LOG) {
      eventLog.splice(0, eventLog.length - QR_MAX_EVENT_LOG);
    }
    persistIfNeeded(entry.event, nowMs);
  }

  function getOrCreateBucket(bucketKey) {
    let st = buckets.get(bucketKey);
    if (st) {
      buckets.delete(bucketKey);
      buckets.set(bucketKey, st);
      return st;
    }
    if (buckets.size >= QR_MAX_TRACKED_BUCKETS) {
      const oldestKey = buckets.keys().next().value;
      if (oldestKey !== undefined) buckets.delete(oldestKey);
    }
    st = {
      resetTimeMs: 0,
      lastQuotaTs: 0,
      lastOfficialUsedPct: null,
      lastCycleCostUsd: 0,
      lastCycleCalls: 0,
      lastPricedTokens: 0,
      lastModelCostsUsd: {},
      lastUnpricedCalls: 0,
      usdPerMTok: null,
      priorUsdPerMTok: null,
      modelUsdPerMTok: {},
      priorModelUsdPerMTok: {},
      slopeSamples: [],
      pendingCostUsd: 0,
      pendingCostAtMs: 0,
      pendingCostSinceMs: 0,
      pendingModelCostsUsd: {},
      ratePctPerUsd: null,
      rateSamples: 0,
      rateWindow: [],
      rateOutlierSide: 0,
      rateOutlierBuf: [],
      modelRates: {},
      activeLeases: [],
      pendingDrop: null,
      lastBounceAtMs: 0,
      lastRefundAtMs: 0,
      lastRefundPct: 0,
      lastRefundHighWaterPct: 0,
      hasExternalUsage: false,
      lastExternalUsageAtMs: 0,
      externalUsedPct: 0,
      externalEvents: 0,
      safetyReviewUsedPct: 0,
      safetyReviewEvents: 0,
      lastSafetyReviewAtMs: 0,
      lastAttributedSafetyEventMs: 0,
      idleUnexplainedAccumPct: 0,
    };
    buckets.set(bucketKey, st);
    return st;
  }

  function observeBucket({
    bucketKey,
    poolKey = '',
    win = '',
    officialUsedPct,
    resetTimeMs = 0,
    quotaFetchedAtMs = 0,
    cycleCostUsd = 0,
    cycleCalls = 0,
    pricedTokens = 0,
    modelCostsUsd = null,
    modelTokens = null,
    unpricedCalls = 0,
    poolLastActivityMs = 0,
    activeSessionCount10m = 0,
    recent10mCostUsd = 0,
    hasRunningLocalSession = false,
    localScanIncomplete = false,
    suppressIdleExternal = false,
    forceExternalJump = false,
    peerLastExternalUsageAtMs = 0,
    peerHasExternalUsage = false,
    unmatchedHeavySafety = null,
    observedCycleSafetyPct = 0,
    observedSafetyLatestMs = 0,
    nowMs = Date.now(),
  }) {
    if (officialUsedPct === null || !Number.isFinite(officialUsedPct)) {
      return {
        reservedPct: 0,
        reservedLeaseCount: 0,
        reservedExpiresAtMs: null,
        externalUsedPct: 0,
        safetyReviewUsedPct: 0,
      };
    }
    ensureHydrated();
    const safeUsed = qrClamp(Number(officialUsedPct), 0, 100);
    const safeCost = Math.max(0, Number(cycleCostUsd) || 0);
    const safeCalls = Math.max(0, Math.floor(Number(cycleCalls) || 0));
    const safePricedTokens = Math.max(0, Math.floor(Number(pricedTokens) || 0));
    const safeModelCosts = qrSanitizeModelCosts(modelCostsUsd);
    const safeModelTokens = qrSanitizeModelTokens(modelTokens);
    const safeUnpriced = Math.max(0, Number(unpricedCalls) || 0);
    const safeResetMs = Number(resetTimeMs) > 0 ? Number(resetTimeMs) : 0;
    const safeFetchTs = Number(quotaFetchedAtMs) > 0 ? Number(quotaFetchedAtMs) : nowMs;
    const safeSess10m = Math.max(0, Number(activeSessionCount10m) || 0);
    const safeCost10m = Math.max(0, Number(recent10mCostUsd) || 0);
    const parsedParts = String(bucketKey || '').split('::');
    const logPool = poolKey || parsedParts[2] || '';
    const logWin = win || parsedParts[3] || '';
    const st = getOrCreateBucket(bucketKey);

    const recordLog = (event, fields = {}) => {
      appendEventLog(
        {
          ts: new Date(nowMs).toISOString(),
          pool: logPool,
          win: logWin,
          event,
          usedPct: +safeUsed.toFixed(3),
          dUsed: +(Number(fields.deltaOfficial) || 0).toFixed(3),
          costUsd: +safeCost.toFixed(4),
          dCost: +(Number(fields.rawDeltaCost) || 0).toFixed(4),
          expPct: +(Number(fields.expectedDeltaPct) || 0).toFixed(3),
          excessPct: +(Number(fields.excessPct) || 0).toFixed(3),
          rate: st.ratePctPerUsd !== null ? +st.ratePctPerUsd.toFixed(4) : null,
          rsvPct: Number(fields.reservedPct) || 0,
          leases: Number(fields.reservedLeaseCount) || 0,
          sess10m: safeSess10m,
          cost10m: +safeCost10m.toFixed(4),
        },
        nowMs
      );
    };

    // 1. 周期重置检测：静默忽略 0% 空闲池的滑动重置时间漂移；真正跨周期时清空租约但保留单桶及单模型费率
    const resetShifted =
      safeResetMs > 0 &&
      st.resetTimeMs > 0 &&
      Math.abs(safeResetMs - st.resetTimeMs) > QR_CYCLE_RESET_SHIFT_MS;
    const rolloverDrop =
      st.lastOfficialUsedPct !== null && st.lastOfficialUsedPct >= 5 && safeUsed < 1;
    if (resetShifted || rolloverDrop) {
      const prevUsed = st.lastOfficialUsedPct ?? 0;
      const isIdleZeroDrift =
        !rolloverDrop &&
        prevUsed < 0.05 &&
        safeUsed < 0.05 &&
        st.activeLeases.length === 0 &&
        st.pendingDrop === null;
      st.resetTimeMs = safeResetMs;
      st.lastQuotaTs = safeFetchTs;
      st.lastOfficialUsedPct = safeUsed;
      st.lastCycleCostUsd = safeCost;
      st.lastCycleCalls = safeCalls;
      st.lastPricedTokens = safePricedTokens;
      st.lastModelCostsUsd = safeModelCosts;
      st.lastUnpricedCalls = safeUnpriced;
      if (isIdleZeroDrift) {
        qrRefreshBucketDensities(st, safeCost, safePricedTokens, safeModelCosts, safeModelTokens);
        return qrFormatOutput(st, safeUsed);
      }
      if (st.usdPerMTok !== null && Number.isFinite(st.usdPerMTok)) {
        st.priorUsdPerMTok = st.usdPerMTok;
      }
      if (st.modelUsdPerMTok && Object.keys(st.modelUsdPerMTok).length > 0) {
        st.priorModelUsdPerMTok = {
          ...(st.priorModelUsdPerMTok || {}),
          ...st.modelUsdPerMTok,
        };
      }
      st.slopeSamples = [];
      st.pendingCostUsd = 0;
      st.pendingCostAtMs = 0;
      st.pendingCostSinceMs = 0;
      st.pendingModelCostsUsd = {};
      st.activeLeases = [];
      st.pendingDrop = null;
      st.lastRefundHighWaterPct = 0;
      st.safetyReviewUsedPct = 0;
      st.safetyReviewEvents = 0;
      st.lastSafetyReviewAtMs = 0;
      st.lastAttributedSafetyEventMs = 0;
      const isResetBaselineExternal =
        !localScanIncomplete &&
        !hasRunningLocalSession &&
        safeCalls === 0 &&
        safeUsed >= QR_EXTERNAL_BASELINE_USED_PCT &&
        safeCost < QR_EXTERNAL_BASELINE_MAX_LOCAL_COST_USD;
      const resetExtPct = isResetBaselineExternal
        ? qrComputeBaselineExternalPct(st, safeUsed, safeCost, safeModelCosts, safeUnpriced)
        : 0;
      st.hasExternalUsage = resetExtPct >= QR_MIN_DISPLAY_RESERVED_PCT;
      st.externalUsedPct = st.hasExternalUsage ? resetExtPct : 0;
      st.externalEvents = 0;
      st.lastExternalUsageAtMs = 0;
      st.idleUnexplainedAccumPct = 0;
      qrReconcileExternalUsageBound(st, safeUsed, safeCost, safeModelCosts, nowMs, {
        localScanIncomplete,
        hasRunningLocalSession,
        suppressIdleExternal,
        peerHasExternalUsage,
        observedCycleSafetyPct,
        observedSafetyLatestMs,
      });
      qrRefreshBucketDensities(st, safeCost, safePricedTokens, safeModelCosts, safeModelTokens);
      qrUpdateSlopeSamples(
        st,
        qrComputeNetLocalUsedPct(st, safeUsed),
        safeCost,
        safeCalls,
        safeUnpriced
      );
      const out = qrFormatOutput(st, safeUsed);
      recordLog('reset', { deltaOfficial: safeUsed - prevUsed, ...out });
      return out;
    }

    // 2. 首次观测：建立基线并按当前周期已有消耗做冷启动费率估计（检测到外部消耗或未计价调用时跳过累计比值反推）
    if (st.lastOfficialUsedPct === null) {
      st.resetTimeMs = safeResetMs;
      st.lastQuotaTs = safeFetchTs;
      st.lastOfficialUsedPct = safeUsed;
      st.lastCycleCostUsd = safeCost;
      st.lastCycleCalls = safeCalls;
      st.lastPricedTokens = safePricedTokens;
      st.lastModelCostsUsd = safeModelCosts;
      st.lastUnpricedCalls = safeUnpriced;
      st.idleUnexplainedAccumPct = 0;
      if (
        !localScanIncomplete &&
        !hasRunningLocalSession &&
        safeCalls === 0 &&
        safeUsed >= QR_EXTERNAL_BASELINE_USED_PCT &&
        safeCost < QR_EXTERNAL_BASELINE_MAX_LOCAL_COST_USD
      ) {
        const baselineExtPct = qrComputeBaselineExternalPct(
          st,
          safeUsed,
          safeCost,
          safeModelCosts,
          safeUnpriced
        );
        st.hasExternalUsage = baselineExtPct >= QR_MIN_DISPLAY_RESERVED_PCT;
        st.externalUsedPct = st.hasExternalUsage ? baselineExtPct : 0;
        qrReconcileExternalUsageBound(st, safeUsed, safeCost, safeModelCosts, nowMs, {
          observedCycleSafetyPct,
          observedSafetyLatestMs,
        });
      } else if (
        !st.hasExternalUsage &&
        safeUnpriced === 0 &&
        safeCost >= 0.5 &&
        safeUsed >= 0.3
      ) {
        st.ratePctPerUsd = qrClampRate(safeUsed / safeCost);
        st.rateSamples = 1;
      }
      qrRefreshBucketDensities(st, safeCost, safePricedTokens, safeModelCosts, safeModelTokens);
      qrUpdateSlopeSamples(
        st,
        qrComputeNetLocalUsedPct(st, safeUsed),
        safeCost,
        safeCalls,
        safeUnpriced
      );
      const out = qrFormatOutput(st, safeUsed);
      recordLog('baseline', out);
      return out;
    }

    if (safeResetMs > 0 && st.resetTimeMs === 0) {
      st.resetTimeMs = safeResetMs;
    }

    // 3. 同一份缓存配额响应：跳过重复差分，仅补齐缺失的单模型基线并检查租约超时清理
    const isFreshSample =
      safeFetchTs !== st.lastQuotaTs || Math.abs(safeUsed - st.lastOfficialUsedPct) > 1e-4;
    if (!isFreshSample) {
      if (
        Object.keys(st.lastModelCostsUsd || {}).length === 0 &&
        Object.keys(safeModelCosts).length > 0
      ) {
        st.lastModelCostsUsd = safeModelCosts;
      }
      if (st.lastCycleCalls === 0 || Math.abs(safeCost - st.lastCycleCostUsd) <= 1e-4) {
        st.lastCycleCalls = safeCalls;
      }
      st.lastPricedTokens = safePricedTokens;
      const prevDensity = st.usdPerMTok;
      qrRefreshBucketDensities(st, safeCost, safePricedTokens, safeModelCosts, safeModelTokens);
      const cachePrune = qrPruneExpiredLeases(st, nowMs);
      const cacheTentativeExtPct =
        cachePrune.expiredTentativePct > 0
          ? qrReconcileExpiredTentativeLeases(st, {
              expiredTentativePct: cachePrune.expiredTentativePct,
              latestTentativeCreatedAtMs: cachePrune.latestTentativeCreatedAtMs,
              safeUsed,
              safeCost: st.lastCycleCostUsd,
              safeModelCosts: st.lastModelCostsUsd,
              safeUnpriced: st.lastUnpricedCalls,
              localScanIncomplete,
              nowMs,
            })
          : 0;
      const extReconciled = qrReconcileExternalUsageBound(
        st,
        safeUsed,
        st.lastCycleCostUsd,
        st.lastModelCostsUsd,
        nowMs,
        {
          localScanIncomplete,
          hasRunningLocalSession,
          suppressIdleExternal,
          peerHasExternalUsage,
          observedCycleSafetyPct,
          observedSafetyLatestMs,
        }
      );
      const out = qrFormatOutput(st, safeUsed);
      if (cachePrune.prunedCount > 0) {
        qrResetSlopeAnchor(
          st,
          qrComputeNetLocalUsedPct(st, safeUsed),
          st.lastCycleCostUsd,
          st.lastCycleCalls,
          st.lastUnpricedCalls
        );
        recordLog(cacheTentativeExtPct > 0 ? 'external_usage' : 'expire', out);
      } else if (extReconciled) {
        qrResetSlopeAnchor(
          st,
          qrComputeNetLocalUsedPct(st, safeUsed),
          st.lastCycleCostUsd,
          st.lastCycleCalls,
          st.lastUnpricedCalls
        );
        persistIfNeeded('external_usage', nowMs);
      } else if (prevDensity === null && st.usdPerMTok !== null) {
        persistIfNeeded('normal', nowMs);
      }
      return out;
    }

    const deltaOfficial = safeUsed - st.lastOfficialUsedPct;
    const rawDeltaCost = Math.max(0, safeCost - st.lastCycleCostUsd);
    const prevModelCosts = st.lastModelCostsUsd && typeof st.lastModelCostsUsd === 'object' ? st.lastModelCostsUsd : {};
    const hasValidPrevModelBaseline =
      st.lastCycleCostUsd <= 1e-6 || Object.keys(prevModelCosts).length > 0;
    const rawDeltaModelCosts = {};
    let totalModelDeltaUsd = 0;
    let dominantModelKey = '';
    let dominantModelDeltaUsd = 0;
    if (hasValidPrevModelBaseline) {
      for (const [mKey, curModelCost] of Object.entries(safeModelCosts)) {
        const prevModelCost = Number(prevModelCosts[mKey]) || 0;
        const dModel = curModelCost - prevModelCost;
        if (dModel > 1e-6) {
          rawDeltaModelCosts[mKey] = dModel;
          totalModelDeltaUsd += dModel;
          if (dModel > dominantModelDeltaUsd) {
            dominantModelDeltaUsd = dModel;
            dominantModelKey = mKey;
          }
        }
      }
    }
    const modelDeltaMatchesTotal =
      totalModelDeltaUsd > 0 && totalModelDeltaUsd <= rawDeltaCost * 1.15 + 0.01;
    const isPureSingleModelStep = Boolean(
      hasValidPrevModelBaseline &&
        modelDeltaMatchesTotal &&
        dominantModelKey &&
        dominantModelDeltaUsd / totalModelDeltaUsd >= QR_MODEL_SINGLE_DOMINANCE_RATIO &&
        dominantModelDeltaUsd >= 0.04
    );
    const deltaUnpriced = Math.max(0, safeUnpriced - st.lastUnpricedCalls);
    const pendingValid =
      st.pendingCostUsd > 0 && nowMs - st.pendingCostAtMs <= QR_PENDING_COST_TTL_MS;
    const effectiveDeltaCost = rawDeltaCost + (pendingValid ? st.pendingCostUsd : 0);
    const effectiveDeltaModelCosts = { ...rawDeltaModelCosts };
    if (pendingValid && st.pendingModelCostsUsd && typeof st.pendingModelCostsUsd === 'object') {
      for (const [mKey, pCost] of Object.entries(st.pendingModelCostsUsd)) {
        if (Number.isFinite(pCost) && pCost > 0) {
          effectiveDeltaModelCosts[mKey] = (effectiveDeltaModelCosts[mKey] || 0) + pCost;
        }
      }
    }
    const rate = qrResolveEffectiveRate(st, safeUsed, safeCost);
    let expectedDeltaPct = qrEstimateModelWeightedPct(
      st,
      effectiveDeltaModelCosts,
      effectiveDeltaCost,
      rate
    );
    let excessPct = deltaOfficial - expectedDeltaPct;
    const isIdleRefundReady =
      poolLastActivityMs > 0 && nowMs - poolLastActivityMs >= QR_IDLE_CONFIRM_REFUND_MS;
    const hasRecentLocalActivity =
      poolLastActivityMs > 0 && nowMs - poolLastActivityMs <= QR_LOCAL_ACTIVITY_GRACE_MS;
    const hasLocalPoolActivity = Boolean(
      effectiveDeltaCost > 0 || hasRunningLocalSession || hasRecentLocalActivity
    );
    const peerExternalTs = Number(peerLastExternalUsageAtMs) || 0;
    const latestExternalTs = Math.max(Number(st.lastExternalUsageAtMs) || 0, peerExternalTs);
    const externalActiveRecently =
      latestExternalTs > 0 &&
      nowMs >= latestExternalTs &&
      nowMs - latestExternalTs <= QR_EXTERNAL_ACTIVE_WINDOW_MS;
    let eventKind = 'idle';
    let skipSlopeUpdate = false;

    const recordExternalDelta = (pct) => {
      st.hasExternalUsage = true;
      st.lastExternalUsageAtMs = nowMs;
      st.externalUsedPct = Math.min(
        100,
        (Number(st.externalUsedPct) || 0) + Math.max(0, Number(pct) || 0)
      );
      st.externalEvents = (Number(st.externalEvents) || 0) + 1;
    };

    const clearPendingCost = () => {
      st.pendingCostUsd = 0;
      st.pendingCostAtMs = 0;
      st.pendingCostSinceMs = 0;
      st.pendingModelCostsUsd = {};
    };

    const confirmRefund = (
      refundedPct,
      { keepPendingCost = false, preRefundHighPct = 0 } = {}
    ) => {
      const amt = Math.max(0, Number(refundedPct) || 0);
      const prevHighWater =
        st.lastRefundAtMs > 0 && nowMs - st.lastRefundAtMs <= QR_REPLICA_BOUNCE_MEMORY_MS
          ? Number(st.lastRefundHighWaterPct) || 0
          : 0;
      st.lastRefundHighWaterPct = Math.max(
        prevHighWater,
        Number(preRefundHighPct) || 0,
        Number(st.lastOfficialUsedPct) || 0
      );
      const leaseConsumed = amt > 0 ? qrConsumeLeasesFifo(st.activeLeases, amt) : 0;
      const unbackedDrop = Math.max(0, amt - leaseConsumed);
      if (unbackedDrop > 0 && (Number(st.externalUsedPct) || 0) > 0) {
        st.externalUsedPct = Math.max(0, (Number(st.externalUsedPct) || 0) - unbackedDrop);
        if (st.externalUsedPct < QR_MIN_DISPLAY_RESERVED_PCT) {
          st.externalUsedPct = 0;
        }
      }
      st.lastRefundAtMs = nowMs;
      st.lastRefundPct = amt;
      st.lastBounceAtMs = nowMs;
      st.pendingDrop = null;
      if (!keepPendingCost) {
        clearPendingCost();
      }
      if (qrSumLeases(st.activeLeases) < QR_MIN_DISPLAY_RESERVED_PCT) {
        st.activeLeases = [];
      }
      eventKind = 'refund';
    };

    if (deltaOfficial <= -QR_REFUND_EPSILON_PCT) {
      // 4A. 同周期余额回升：区分「静默到期真退还」及「活跃期双副本回落待确认」
      st.idleUnexplainedAccumPct = 0;
      if (st.activeLeases.length > 0) {
        qrConfirmAllLeases(st.activeLeases);
      }
      const prevHigh = st.pendingDrop
        ? Math.max(st.pendingDrop.preDropUsedPct, st.lastOfficialUsedPct)
        : st.lastOfficialUsedPct;
      const totalDrop = Math.max(0, prevHigh - safeUsed);
      st.lastBounceAtMs = nowMs;
      clearPendingCost();

      if (isIdleRefundReady) {
        confirmRefund(totalDrop, { preRefundHighPct: prevHigh });
      } else if (st.pendingDrop) {
        st.pendingDrop.preDropUsedPct = prevHigh;
        st.pendingDrop.lowestUsedPct = Math.min(st.pendingDrop.lowestUsedPct, safeUsed);
        st.pendingDrop.dropPct = Math.max(0, prevHigh - st.pendingDrop.lowestUsedPct);
        st.pendingDrop.lowSamples += 1;
        if (
          st.pendingDrop.lowSamples >= QR_REFUND_CONFIRM_MIN_SAMPLES &&
          nowMs - st.pendingDrop.droppedAtMs >= QR_REFUND_CONFIRM_WINDOW_MS
        ) {
          confirmRefund(st.pendingDrop.dropPct, { preRefundHighPct: prevHigh });
        } else {
          eventKind = 'drop_pending';
        }
      } else {
        st.pendingDrop = {
          preDropUsedPct: st.lastOfficialUsedPct,
          preDropCostUsd: st.lastCycleCostUsd,
          dropPct: -deltaOfficial,
          droppedAtMs: nowMs,
          lowSamples: 1,
          lowestUsedPct: safeUsed,
        };
        eventKind = 'drop_pending';
      }
    } else if (st.pendingDrop) {
      // 4B-Pending. 当前处于回落观察窗内：判断是「弹回高副本」「正常消耗自然越过前高」还是「持续低位确认退还」
      const pd = st.pendingDrop;
      const costSinceDrop = Math.max(0, safeCost - pd.preDropCostUsd);
      const expectedSinceDrop = rate !== null ? costSinceDrop * rate : 0;
      const expectedOnTick = rate !== null ? rawDeltaCost * rate : 0;
      const jumpAboveTickSpend = deltaOfficial - expectedOnTick;
      const reboundFloor = pd.preDropUsedPct - Math.min(0.15, pd.dropPct * 0.35);
      const isReplicaRebound =
        deltaOfficial > 1e-3 &&
        jumpAboveTickSpend >= Math.max(QR_REFUND_EPSILON_PCT, pd.dropPct * 0.45) &&
        safeUsed >= reboundFloor;

      if (isReplicaRebound) {
        st.idleUnexplainedAccumPct = 0;
        if (st.activeLeases.length > 0) {
          qrConfirmAllLeases(st.activeLeases);
        }
        const excessAboveHighWater = safeUsed - (pd.preDropUsedPct + expectedSinceDrop);
        st.pendingDrop = null;
        st.lastBounceAtMs = nowMs;
        clearPendingCost();
        if (rate !== null && excessAboveHighWater >= QR_MIN_JUMP_EXCESS_PCT) {
          const reboundCycleInfo = qrComputeCycleUnexplained(
            st,
            safeUsed,
            safeCost,
            safeModelCosts,
            safeUnpriced
          );
          const reboundExplainedByLocal = Boolean(
            reboundCycleInfo.isCalibrated &&
              safeCost > 0 &&
              reboundCycleInfo.unexplainedPct <= reboundCycleInfo.localCoverTolerance
          );
          if (!hasLocalPoolActivity || forceExternalJump) {
            if (!localScanIncomplete && !reboundExplainedByLocal) {
              recordExternalDelta(excessAboveHighWater);
              eventKind = 'external_usage';
            } else {
              eventKind = 'replica_flip';
            }
          } else {
            const isTentative = externalActiveRecently || (st.hasExternalUsage && rate === null);
            st.activeLeases.push({
              amountPct: excessAboveHighWater,
              remainingPct: excessAboveHighWater,
              createdAtMs: nowMs,
              lastTouchedMs: nowMs,
              sessionCount: Math.max(1, safeSess10m || 1),
              confirmed: false,
              tentative: isTentative,
              unabsorbedNormalSteps: 0,
              unabsorbedExpectedPct: 0,
            });
            if (st.activeLeases.length > QR_MAX_ACTIVE_LEASES) {
              st.activeLeases.splice(0, st.activeLeases.length - QR_MAX_ACTIVE_LEASES);
            }
            eventKind = isTentative ? 'lease_tentative' : 'lease';
          }
        } else {
          eventKind = 'replica_flip';
        }
      } else if (deltaOfficial > 1e-3 && safeUsed >= pd.preDropUsedPct - 1e-3) {
        // 正常消耗已自然推高至回落前水位以上，立即解除残留观察窗，防止后续真实租约跳变被吞
        st.pendingDrop = null;
        clearPendingCost();
        eventKind = 'normal';
      } else {
        pd.lowSamples += 1;
        const sustainedLow =
          isIdleRefundReady ||
          (pd.lowSamples >= QR_REFUND_CONFIRM_MIN_SAMPLES &&
            nowMs - pd.droppedAtMs >= QR_REFUND_CONFIRM_WINDOW_MS);
        if (sustainedLow) {
          if (rawDeltaCost > 0 && deltaOfficial <= 1e-3) {
            st.pendingCostUsd = effectiveDeltaCost;
            st.pendingCostAtMs = nowMs;
            st.pendingCostSinceMs =
              pendingValid && st.pendingCostSinceMs > 0 ? st.pendingCostSinceMs : nowMs;
          }
          const effectiveDrop = Math.max(0, pd.preDropUsedPct + expectedSinceDrop - safeUsed);
          confirmRefund(effectiveDrop > 0 ? Math.min(pd.dropPct, effectiveDrop) : pd.dropPct, {
            keepPendingCost: deltaOfficial <= 1e-3 && st.pendingCostUsd > 0,
            preRefundHighPct: pd.preDropUsedPct,
          });
        } else if (deltaOfficial > 1e-3) {
          clearPendingCost();
          eventKind = 'drop_pending';
        } else if (rawDeltaCost > 0) {
          st.pendingCostUsd = effectiveDeltaCost;
          st.pendingCostAtMs = nowMs;
          st.pendingCostSinceMs =
            pendingValid && st.pendingCostSinceMs > 0 ? st.pendingCostSinceMs : nowMs;
          eventKind = 'lag_pending';
        }
      }
    } else if (deltaOfficial > 1e-3) {
      // 4B. 官方已用比例上升：先筛除退还后多副本回弹、本机周期可解释补账及外部/家庭组消耗，再区分租约跳变、租约内消费及常规消耗
      const cycleInfo = qrComputeCycleUnexplained(
        st,
        safeUsed,
        safeCost,
        safeModelCosts,
        safeUnpriced
      );
      const isExplainedByLocalCycle = Boolean(
        cycleInfo.isCalibrated && safeCost > 0 && cycleInfo.unexplainedPct <= cycleInfo.localCoverTolerance
      );
      const isPostRefundReplicaBounce =
        !forceExternalJump &&
        !hasLocalPoolActivity &&
        st.lastRefundAtMs > 0 &&
        nowMs >= st.lastRefundAtMs &&
        nowMs - st.lastRefundAtMs <= QR_REPLICA_BOUNCE_MEMORY_MS &&
        (Number(st.lastRefundHighWaterPct) || 0) > 0 &&
        safeUsed <= (Number(st.lastRefundHighWaterPct) || 0) + QR_REFUND_EPSILON_PCT;
      if (hasLocalPoolActivity || isPostRefundReplicaBounce || isExplainedByLocalCycle) {
        st.idleUnexplainedAccumPct = 0;
      }
      const idleMinPct = qrResolveIdleExternalThreshold(logWin);
      let isIdleExternalUsage = false;
      let idleExternalAmt = deltaOfficial;
      let isBufferedIdleNoise = false;
      if (
        !localScanIncomplete &&
        !suppressIdleExternal &&
        !isPostRefundReplicaBounce &&
        !hasLocalPoolActivity &&
        !isExplainedByLocalCycle
      ) {
        if (
          deltaOfficial >= idleMinPct ||
          (externalActiveRecently && deltaOfficial >= QR_MIN_DISPLAY_RESERVED_PCT)
        ) {
          isIdleExternalUsage = true;
          idleExternalAmt = deltaOfficial + (Number(st.idleUnexplainedAccumPct) || 0);
          st.idleUnexplainedAccumPct = 0;
        } else if (deltaOfficial >= QR_MIN_DISPLAY_RESERVED_PCT) {
          st.idleUnexplainedAccumPct = (Number(st.idleUnexplainedAccumPct) || 0) + deltaOfficial;
          if (st.idleUnexplainedAccumPct >= idleMinPct) {
            isIdleExternalUsage = true;
            idleExternalAmt = st.idleUnexplainedAccumPct;
            st.idleUnexplainedAccumPct = 0;
          } else {
            isBufferedIdleNoise = true;
          }
        }
      }
      const allowForceExternal = Boolean(
        forceExternalJump && !localScanIncomplete && !isExplainedByLocalCycle
      );
      let safetyReviewMatchedFully = false;
      const unmatchedSafetyCount = Number(unmatchedHeavySafety?.count) || 0;
      if (
        !isPostRefundReplicaBounce &&
        !localScanIncomplete &&
        !isExplainedByLocalCycle &&
        unmatchedSafetyCount > 0
      ) {
        const rawSafetyExcess =
          rate !== null
            ? Math.max(0, excessPct)
            : effectiveDeltaCost <= QR_COLD_START_MAX_COST_USD
              ? deltaOfficial
              : 0;
        if (rawSafetyExcess >= QR_MIN_DISPLAY_RESERVED_PCT) {
          const maxSafetyTickPct =
            rate !== null && rate > 0
              ? unmatchedSafetyCount * QR_SAFETY_MAX_USD_PER_HEAVY_EVENT * rate
              : logWin === 'weekly'
                ? unmatchedSafetyCount * 0.6
                : unmatchedSafetyCount * 2.2;
          const attributedSafetyPct = Math.min(rawSafetyExcess, maxSafetyTickPct);
          if (attributedSafetyPct >= QR_MIN_DISPLAY_RESERVED_PCT) {
            const latestSafetyTs = Math.max(
              Number(unmatchedHeavySafety?.latestTsMs) || 0,
              nowMs
            );
            st.safetyReviewUsedPct = qrClamp(
              (Number(st.safetyReviewUsedPct) || 0) + attributedSafetyPct,
              0,
              safeUsed
            );
            st.safetyReviewEvents = (Number(st.safetyReviewEvents) || 0) + unmatchedSafetyCount;
            st.lastSafetyReviewAtMs = Math.max(
              Number(st.lastSafetyReviewAtMs) || 0,
              latestSafetyTs
            );
            st.lastAttributedSafetyEventMs = Math.max(
              Number(st.lastAttributedSafetyEventMs) || 0,
              Number(unmatchedHeavySafety?.latestTsMs) || nowMs
            );
            st.idleUnexplainedAccumPct = 0;
            skipSlopeUpdate = true;
            excessPct -= attributedSafetyPct;
            const remExcess = rawSafetyExcess - attributedSafetyPct;
            safetyReviewMatchedFully =
              rate !== null
                ? remExcess < QR_MIN_JUMP_EXCESS_PCT
                : remExcess < QR_COLD_START_JUMP_PCT;
          }
        }
      }
      const detectedWithRate = rate !== null && excessPct >= QR_MIN_JUMP_EXCESS_PCT;
      const detectedColdStart =
        rate === null &&
        deltaOfficial >= QR_COLD_START_JUMP_PCT &&
        effectiveDeltaCost <= QR_COLD_START_MAX_COST_USD;
      const shortfall = expectedDeltaPct - deltaOfficial;
      const isSignificantShortfall =
        st.activeLeases.length > 0 &&
        expectedDeltaPct > 0 &&
        shortfall >= Math.max(QR_CONSUME_MIN_SHORTFALL_PCT, expectedDeltaPct * QR_CONSUME_SHORTFALL_RATIO);

      if (isPostRefundReplicaBounce) {
        st.lastBounceAtMs = nowMs;
        eventKind = 'replica_flip';
      } else if (safetyReviewMatchedFully) {
        eventKind = 'safety_review';
      } else if (allowForceExternal || isIdleExternalUsage) {
        const extAmt =
          allowForceExternal && excessPct > 0 ? excessPct : idleExternalAmt;
        recordExternalDelta(extAmt);
        eventKind = 'external_usage';
      } else if (
        !hasLocalPoolActivity &&
        (isBufferedIdleNoise || isExplainedByLocalCycle || localScanIncomplete || suppressIdleExternal)
      ) {
        eventKind = 'idle';
      } else if (detectedWithRate || detectedColdStart) {
        const leaseRemaining = detectedWithRate ? excessPct : deltaOfficial;
        const isTentative = externalActiveRecently || (st.hasExternalUsage && rate === null);
        st.activeLeases.push({
          amountPct: leaseRemaining,
          remainingPct: leaseRemaining,
          createdAtMs: nowMs,
          lastTouchedMs: nowMs,
          sessionCount: Math.max(1, safeSess10m || 1),
          confirmed: false,
          tentative: isTentative,
          unabsorbedNormalSteps: 0,
          unabsorbedExpectedPct: 0,
        });
        if (st.activeLeases.length > QR_MAX_ACTIVE_LEASES) {
          st.activeLeases.splice(0, st.activeLeases.length - QR_MAX_ACTIVE_LEASES);
        }
        eventKind = isTentative ? 'lease_tentative' : 'lease';
      } else if (isSignificantShortfall) {
        // 租约期内出现明显低于预期的官方增量：佐证租约存在并把显著缺口计入当前租约内消费
        qrConfirmAllLeases(st.activeLeases);
        qrConsumeLeasesFifo(st.activeLeases, shortfall);
        for (let i = 0; i < st.activeLeases.length; i += 1) {
          st.activeLeases[i].lastTouchedMs = nowMs;
        }
        eventKind = 'consume';
      } else {
        // 检查未经佐证的疑似租约：若本机单会话持续按 1:1 实扣且无吸收/无回落，快速核销租约；仅在已校准且存在真实未解释盈余、且非已证实堆叠租约时计为外部消耗
        let rejectedLease = false;
        if (
          st.activeLeases.length > 0 &&
          effectiveDeltaCost >= 0.02 &&
          expectedDeltaPct >= 0.02 &&
          deltaOfficial >= expectedDeltaPct * QR_UNCONFIRMED_RATIO_FLOOR
        ) {
          for (let i = st.activeLeases.length - 1; i >= 0; i -= 1) {
            const lease = st.activeLeases[i];
            if (lease.confirmed) continue;
            if (!lease.tentative && safeSess10m > 1) continue;
            lease.unabsorbedNormalSteps = (lease.unabsorbedNormalSteps || 0) + 1;
            lease.unabsorbedExpectedPct = (lease.unabsorbedExpectedPct || 0) + expectedDeltaPct;
            const hitEvict = lease.tentative
              ? lease.unabsorbedNormalSteps >= QR_TENTATIVE_NORMAL_STEPS_EVICT &&
                lease.unabsorbedExpectedPct >= QR_TENTATIVE_NORMAL_PCT_EVICT
              : lease.unabsorbedNormalSteps >= QR_UNCONFIRMED_NORMAL_STEPS_EVICT &&
                lease.unabsorbedExpectedPct >= QR_UNCONFIRMED_NORMAL_PCT_EVICT;
            if (hitEvict) {
              const droppedPct = Math.max(0, Number(lease.remainingPct) || 0);
              const hadOtherConfirmedLease = st.activeLeases.some((l, idx) => idx !== i && l.confirmed);
              st.activeLeases.splice(i, 1);
              const effectiveLocalExp =
                st.ratePctPerUsd !== null && safeUnpriced === 0
                  ? qrEstimateModelWeightedPct(st, safeModelCosts, safeCost, st.ratePctPerUsd)
                  : null;
              const remainingLeaseSum = qrSumLeases(st.activeLeases, { includeTentative: true });
              const safetyReviewPct = Math.max(0, Number(st.safetyReviewUsedPct) || 0);
              const effectiveUnexplained =
                effectiveLocalExp !== null
                  ? Math.max(0, safeUsed - remainingLeaseSum - safetyReviewPct - effectiveLocalExp)
                  : null;
              const leaseRejectTol = Math.max(
                QR_EXTERNAL_SOLO_DRIFT_FLOOR_PCT,
                Math.max(0, Number(effectiveLocalExp) || 0) * QR_LEASE_REJECT_SURPLUS_RATIO
              );
              const hasRealUnexplainedSurplus =
                !localScanIncomplete &&
                safeUnpriced === 0 &&
                st.ratePctPerUsd !== null &&
                (lease.tentative || !hadOtherConfirmedLease) &&
                effectiveUnexplained !== null &&
                effectiveUnexplained >= leaseRejectTol;
              if (hasRealUnexplainedSurplus) {
                const curExtPct = Math.max(0, Number(st.externalUsedPct) || 0);
                const addableExt = Math.min(
                  droppedPct,
                  Math.max(0, effectiveUnexplained - curExtPct)
                );
                if (addableExt >= QR_MIN_DISPLAY_RESERVED_PCT) {
                  recordExternalDelta(addableExt);
                }
              }
              rejectedLease = true;
            }
          }
        }

        const outsideBounceCooldown =
          st.lastBounceAtMs === 0 || nowMs - st.lastBounceAtMs >= QR_RATE_BOUNCE_COOLDOWN_MS;
        const suspiciousExternalInflation = Boolean(
          externalActiveRecently &&
            rate !== null &&
            expectedDeltaPct > 0 &&
            excessPct >= (logWin === 'weekly' ? 0.02 : 0.05) &&
            deltaOfficial > expectedDeltaPct * 1.45
        );
        if (suspiciousExternalInflation) {
          skipSlopeUpdate = true;
        }
        const isCleanSampleMagnitude =
          deltaOfficial < QR_MIN_JUMP_EXCESS_PCT ||
          (rate !== null &&
            Array.isArray(st.rateWindow) &&
            st.rateWindow.length >= 1 &&
            excessPct < QR_MIN_JUMP_EXCESS_PCT &&
            deltaOfficial < 2.5);
        const hasNonAbsorbingConfirmedLeases =
          st.activeLeases.length > 0 &&
          st.activeLeases.every((l) => l.confirmed && !l.tentative) &&
          rate !== null &&
          expectedDeltaPct >= 0.08 &&
          deltaOfficial >= expectedDeltaPct * 0.9 &&
          deltaOfficial <= expectedDeltaPct * 1.12 &&
          Math.abs(excessPct) < 0.05;
        if (
          !rejectedLease &&
          !suspiciousExternalInflation &&
          (st.activeLeases.length === 0 || hasNonAbsorbingConfirmedLeases) &&
          outsideBounceCooldown &&
          !pendingValid &&
          rawDeltaCost >= 0.04 &&
          deltaUnpriced === 0 &&
          deltaOfficial > 0.005 &&
          isCleanSampleMagnitude
        ) {
          // 纯净未租约（或已证实租约未发生吸收）且无近期副本抖动的单步消耗：进入滚动中位数费率校准池；纯单模型步同步校准该模型费率
          qrRecordRateSample(st, deltaOfficial / rawDeltaCost, {
            blockUpwardDriftReset: externalActiveRecently,
          });
          if (isPureSingleModelStep) {
            const mr = qrGetOrCreateModelRate(st, dominantModelKey, nowMs);
            qrRecordRateSample(mr, deltaOfficial / dominantModelDeltaUsd, {
              blockUpwardDriftReset: externalActiveRecently,
            });
            mr.lastSeenMs = nowMs;
          }
        }
        eventKind = rejectedLease ? 'lease_rejected' : 'normal';
      }
      clearPendingCost();
    } else if (rawDeltaCost > 0) {
      // 4C. 官方已用比例持平但本地产生真实消耗：先核销近期因本地扫描延迟误记的外部消耗，再缓冲短期记账延迟或扣减租约
      st.idleUnexplainedAccumPct = 0;
      const hasBufferedLeaseCost = st.pendingCostUsd > 0 && st.pendingCostSinceMs > 0;
      if (st.activeLeases.length > 0) {
        const accCost = rawDeltaCost + (hasBufferedLeaseCost ? st.pendingCostUsd : 0);
        const accModelCosts = { ...rawDeltaModelCosts };
        if (hasBufferedLeaseCost && st.pendingModelCostsUsd && typeof st.pendingModelCostsUsd === 'object') {
          for (const [mKey, pCost] of Object.entries(st.pendingModelCostsUsd)) {
            if (Number.isFinite(pCost) && pCost > 0) {
              accModelCosts[mKey] = (accModelCosts[mKey] || 0) + pCost;
            }
          }
        }
        const sinceMs = hasBufferedLeaseCost ? st.pendingCostSinceMs : nowMs;
        if (nowMs - sinceMs >= QR_CONSUME_LAG_GRACE_MS) {
          qrConfirmAllLeases(st.activeLeases);
          const consumedPct = qrEstimateModelWeightedPct(st, accModelCosts, accCost, rate);
          expectedDeltaPct = consumedPct;
          excessPct = deltaOfficial - expectedDeltaPct;
          if (consumedPct > 0) {
            qrConsumeLeasesFifo(st.activeLeases, consumedPct);
          }
          for (let i = 0; i < st.activeLeases.length; i += 1) {
            st.activeLeases[i].lastTouchedMs = nowMs;
          }
          clearPendingCost();
          eventKind = 'consume';
        } else {
          st.pendingCostUsd = accCost;
          st.pendingCostAtMs = nowMs;
          st.pendingCostSinceMs = sinceMs;
          st.pendingModelCostsUsd = accModelCosts;
          eventKind = 'lag_pending';
        }
      } else {
        const withinScanLagWindow =
          (Number(st.externalUsedPct) || 0) > 0 &&
          st.lastExternalUsageAtMs > 0 &&
          nowMs >= st.lastExternalUsageAtMs &&
          nowMs - st.lastExternalUsageAtMs <= QR_EXTERNAL_SCAN_LAG_RECONCILE_MS &&
          rate !== null;
        let remainingLagCost = effectiveDeltaCost;
        if (withinScanLagWindow) {
          const arrivedLocalPct = qrEstimateModelWeightedPct(
            st,
            rawDeltaModelCosts,
            rawDeltaCost,
            rate
          );
          if (arrivedLocalPct > 0) {
            const prevExtPct = Number(st.externalUsedPct) || 0;
            const offsetPct = Math.min(prevExtPct, arrivedLocalPct);
            st.externalUsedPct = Math.max(0, prevExtPct - offsetPct);
            if (st.externalUsedPct < QR_MIN_DISPLAY_RESERVED_PCT) {
              st.externalUsedPct = 0;
              if ((Number(st.externalEvents) || 0) <= 1) {
                st.hasExternalUsage = false;
                st.externalEvents = 0;
                st.lastExternalUsageAtMs = 0;
              }
            }
            const offsetRatio = Math.min(1, offsetPct / arrivedLocalPct);
            remainingLagCost = Math.max(0, effectiveDeltaCost - rawDeltaCost * offsetRatio);
          }
        }
        if (remainingLagCost > 1e-6) {
          // 尚未租约：暂存短时待配对成本，吸收 10~30s 记账延迟或小额步长累积
          st.pendingCostUsd = remainingLagCost;
          st.pendingCostAtMs = nowMs;
          st.pendingCostSinceMs =
            pendingValid && st.pendingCostSinceMs > 0 ? st.pendingCostSinceMs : nowMs;
          st.pendingModelCostsUsd =
            remainingLagCost >= effectiveDeltaCost - 1e-6 ? effectiveDeltaModelCosts : {};
          eventKind = 'lag_pending';
        } else {
          clearPendingCost();
          eventKind = 'normal';
        }
      }
    } else if (
      st.activeLeases.length > 0 &&
      st.pendingCostUsd > 0 &&
      st.pendingCostSinceMs > 0 &&
      nowMs - st.pendingCostSinceMs >= QR_CONSUME_LAG_GRACE_MS
    ) {
      // 4C-2. 无新增花费但已跨过 25s 延迟观察窗且官方仍原地踏步：确认此前缓冲成本已在租约内消化
      qrConfirmAllLeases(st.activeLeases);
      const consumedPct = qrEstimateModelWeightedPct(
        st,
        st.pendingModelCostsUsd,
        st.pendingCostUsd,
        rate
      );
      expectedDeltaPct = consumedPct;
      excessPct = deltaOfficial - expectedDeltaPct;
      if (consumedPct > 0) {
        qrConsumeLeasesFifo(st.activeLeases, consumedPct);
      }
      for (let i = 0; i < st.activeLeases.length; i += 1) {
        st.activeLeases[i].lastTouchedMs = nowMs;
      }
      clearPendingCost();
      eventKind = 'consume';
    }

    st.lastQuotaTs = safeFetchTs;
    st.lastOfficialUsedPct = safeUsed;
    st.lastCycleCostUsd = safeCost;
    st.lastCycleCalls = safeCalls;
    st.lastPricedTokens = safePricedTokens;
    st.lastModelCostsUsd = safeModelCosts;
    st.lastUnpricedCalls = safeUnpriced;

    // 5. 租约 TTL 超时兜底（试探租约到期后若存在未退还且超出本机容差的盈余，自动核销入非自用外部消耗）
    const pruneRes = qrPruneExpiredLeases(st, nowMs);
    const prunedExpiredLeases = pruneRes.prunedCount > 0;
    const tentativeAttributedPct =
      pruneRes.expiredTentativePct > 0
        ? qrReconcileExpiredTentativeLeases(st, {
            expiredTentativePct: pruneRes.expiredTentativePct,
            latestTentativeCreatedAtMs: pruneRes.latestTentativeCreatedAtMs,
            safeUsed,
            safeCost,
            safeModelCosts,
            safeUnpriced,
            localScanIncomplete,
            nowMs,
          })
        : 0;
    if (tentativeAttributedPct > 0 && eventKind === 'idle') {
      eventKind = 'external_usage';
    } else if (prunedExpiredLeases && eventKind === 'idle') {
      eventKind = 'expire';
    }

    const prevDensity = st.usdPerMTok;
    qrRefreshBucketDensities(st, safeCost, safePricedTokens, safeModelCosts, safeModelTokens);
    const extReconciled = qrReconcileExternalUsageBound(
      st,
      safeUsed,
      safeCost,
      safeModelCosts,
      nowMs,
      {
        localScanIncomplete,
        hasRunningLocalSession,
        suppressIdleExternal,
        peerHasExternalUsage,
        observedCycleSafetyPct,
        observedSafetyLatestMs,
      }
    );
    const netLocalUsed = qrComputeNetLocalUsedPct(st, safeUsed);
    if (prunedExpiredLeases) {
      qrResetSlopeAnchor(st, netLocalUsed, safeCost, safeCalls, safeUnpriced);
    } else if (!skipSlopeUpdate) {
      qrUpdateSlopeSamples(st, netLocalUsed, safeCost, safeCalls, safeUnpriced);
    }

    const out = qrFormatOutput(st, safeUsed);
    if (eventKind !== 'idle') {
      recordLog(eventKind, {
        deltaOfficial,
        rawDeltaCost,
        expectedDeltaPct,
        excessPct,
        ...out,
      });
    } else if (extReconciled) {
      persistIfNeeded('external_usage', nowMs);
    } else if (prevDensity === null && st.usdPerMTok !== null) {
      persistIfNeeded('normal', nowMs);
    }
    return out;
  }

  function updatePools({
    endpointId = 'local',
    accountScope = '',
    quotaPoolsMap = null,
    poolCycleStats = null,
    runningPoolKeys = null,
    hasUnknownRunningPool = false,
    localScanIncomplete = false,
    safetyMonitor = null,
    quotaFetchedAtMs = 0,
    nowMs = Date.now(),
  } = {}) {
    if (!(quotaPoolsMap instanceof Map) || quotaPoolsMap.size === 0) return;
    ensureHydrated();
    const normalizedAccountScope = String(accountScope || '').trim().toLowerCase();
    const scopePrefix = `${String(endpointId || 'local')}::${normalizedAccountScope}`;

    batchingDepth += 1;
    try {
      for (const [poolKey, poolObj] of quotaPoolsMap.entries()) {
        if (!poolObj || typeof poolObj !== 'object') continue;
        const pStats = poolCycleStats instanceof Map ? poolCycleStats.get(poolKey) : null;
        const recent10m = pStats?.recent10m || null;
        const poolLastActivityMs = Number(recent10m?.lastActivityMs) || 0;
        const activeSessionCount10m = Number(recent10m?.activeSessionCount) || 0;
        const recent10mCostUsd = Number(recent10m?.costUsd) || 0;
        const hasRunningLocalSession = Boolean(
          hasUnknownRunningPool ||
            (runningPoolKeys instanceof Set && runningPoolKeys.has(poolKey))
        );

        const key5h = `${scopePrefix}::${poolKey}::5h`;
        const keyWk = `${scopePrefix}::${poolKey}::weekly`;
        const used5hExact = poolObj.has5h ? qrResolveExactUsedPct(poolObj, '5h') : null;
        const usedWkExact = poolObj.hasWeekly ? qrResolveExactUsedPct(poolObj, 'weekly') : null;
        const reset5hMs = parseIsoMs(poolObj.resetTime);
        const resetWkMs = parseIsoMs(poolObj.weeklyResetTime);
        const cost5hUsd = pStats?.exactCost5hUsd ?? pStats?.cycle5h?.costUsd ?? 0;
        const costWkUsd = pStats?.exactCostWeeklyUsd ?? pStats?.cycleWeekly?.costUsd ?? 0;
        const calls5h = pStats?.cycle5h?.calls || 0;
        const callsWk = pStats?.cycleWeekly?.calls || 0;
        const unpriced5h = pStats?.cycle5h?.unpricedCalls || 0;
        const unpricedWk = pStats?.cycleWeekly?.unpricedCalls || 0;
        const pricedTokens5h =
          pStats?.pricedTokens5h ?? (unpriced5h === 0 ? pStats?.cycle5h?.tokens || 0 : 0);
        const pricedTokensWk =
          pStats?.pricedTokensWeekly ?? (unpricedWk === 0 ? pStats?.cycleWeekly?.tokens || 0 : 0);
        const modelCosts5h = pStats?.modelCosts5h || null;
        const modelCostsWk = pStats?.modelCostsWeekly || null;
        const modelTokens5h = pStats?.modelTokens5h || null;
        const modelTokensWk = pStats?.modelTokensWeekly || null;

        const prev5hSt = buckets.get(key5h) || null;
        const prevWkSt = buckets.get(keyWk) || null;
        const isSafetyPool = Boolean(
          safetyMonitor && qrIsSafetyReviewEligiblePool(poolKey, poolObj)
        );
        const unmatchedHeavy5h = isSafetyPool
          ? qrCollectUnmatchedHeavySafetyEvents(prev5hSt, safetyMonitor, quotaFetchedAtMs, nowMs)
          : { count: 0, latestTsMs: 0, totalChars: 0 };
        const unmatchedHeavyWk = isSafetyPool
          ? qrCollectUnmatchedHeavySafetyEvents(prevWkSt, safetyMonitor, quotaFetchedAtMs, nowMs)
          : { count: 0, latestTsMs: 0, totalChars: 0 };
        const obsSafety5h = isSafetyPool
          ? qrComputeObservedCycleSafetyPct(
              prev5hSt,
              safetyMonitor,
              '5h',
              reset5hMs,
              nowMs,
              prev5hSt?.ratePctPerUsd
            )
          : { estPct: 0, latestEventMs: 0, heavyCalls: 0 };
        const obsSafetyWk = isSafetyPool
          ? qrComputeObservedCycleSafetyPct(
              prevWkSt,
              safetyMonitor,
              'weekly',
              resetWkMs,
              nowMs,
              prevWkSt?.ratePctPerUsd
            )
          : { estPct: 0, latestEventMs: 0, heavyCalls: 0 };

        const peerExtTs5h = Number(prevWkSt?.lastExternalUsageAtMs) || 0;
        const peerExtTsWk = Number(prev5hSt?.lastExternalUsageAtMs) || 0;
        const latestPoolExtTs = Math.max(peerExtTs5h, peerExtTsWk);
        const poolExternalActiveRecently =
          latestPoolExtTs > 0 &&
          nowMs >= latestPoolExtTs &&
          nowMs - latestPoolExtTs <= QR_EXTERNAL_ACTIVE_WINDOW_MS;

        // 第 2 层：同一快照下 5h / 周限按已校准费率等比同涨 -> 判定为同一笔家庭组/外部真实消耗而非租约
        // 若本机刚完成后台安全审查（如 gemini-4-hydrogen-sonar），抑制同涨误判，由单桶直接归入 safetyReviewUsedPct
        const suppressProportionalForSafety =
          isSafetyPool && (unmatchedHeavy5h.count > 0 || unmatchedHeavyWk.count > 0);
        const isProportionalExternal =
          !suppressProportionalForSafety && used5hExact !== null && usedWkExact !== null
            ? qrDetectProportionalExternalJump(
                prev5hSt,
                prevWkSt,
                {
                  officialUsedPct: used5hExact,
                  resetTimeMs: reset5hMs,
                  quotaFetchedAtMs,
                  cycleCostUsd: cost5hUsd,
                  modelCostsUsd: modelCosts5h,
                  unpricedCalls: unpriced5h,
                  nowMs,
                },
                {
                  officialUsedPct: usedWkExact,
                  resetTimeMs: resetWkMs,
                  quotaFetchedAtMs,
                  cycleCostUsd: costWkUsd,
                  modelCostsUsd: modelCostsWk,
                  unpricedCalls: unpricedWk,
                  nowMs,
                },
                {
                  hasRunningLocalSession,
                  externalActiveRecently: poolExternalActiveRecently,
                  localScanIncomplete,
                }
              )
            : false;

        const isFiveHOnlyServerLease = Boolean(
          used5hExact !== null &&
            usedWkExact !== null &&
            usedWkExact < 99.5 &&
            prev5hSt &&
            prevWkSt &&
            prev5hSt.lastOfficialUsedPct !== null &&
            prevWkSt.lastOfficialUsedPct !== null &&
            prev5hSt.ratePctPerUsd > 0 &&
            prevWkSt.ratePctPerUsd > 0 &&
            Math.max(prev5hSt.rateWindow?.length || 0, prev5hSt.rateSamples || 0) >=
              QR_MODEL_RATE_MIN_UI_SAMPLES &&
            Math.max(prevWkSt.rateWindow?.length || 0, prevWkSt.rateSamples || 0) >=
              QR_MODEL_RATE_MIN_UI_SAMPLES &&
            used5hExact - prev5hSt.lastOfficialUsedPct >= QR_EXTERNAL_MIN_IDLE_5H_DELTA_PCT &&
            ((used5hExact - prev5hSt.lastOfficialUsedPct) / prev5hSt.ratePctPerUsd) *
              prevWkSt.ratePctPerUsd >=
              0.08 &&
            usedWkExact - prevWkSt.lastOfficialUsedPct <= 0.005
        );

        let res5h =
          used5hExact !== null
            ? observeBucket({
                bucketKey: key5h,
                poolKey,
                win: '5h',
                officialUsedPct: used5hExact,
                resetTimeMs: reset5hMs,
                quotaFetchedAtMs,
                cycleCostUsd: cost5hUsd,
                cycleCalls: calls5h,
                pricedTokens: pricedTokens5h,
                modelCostsUsd: modelCosts5h,
                modelTokens: modelTokens5h,
                unpricedCalls: unpriced5h,
                poolLastActivityMs,
                activeSessionCount10m,
                recent10mCostUsd,
                hasRunningLocalSession,
                localScanIncomplete,
                suppressIdleExternal: isFiveHOnlyServerLease,
                forceExternalJump: isProportionalExternal,
                peerLastExternalUsageAtMs: peerExtTs5h,
                peerHasExternalUsage: Boolean(prevWkSt?.hasExternalUsage),
                unmatchedHeavySafety: unmatchedHeavy5h,
                observedCycleSafetyPct: obsSafety5h.estPct,
                observedSafetyLatestMs: obsSafety5h.latestEventMs,
                nowMs,
              })
            : {
                reservedPct: 0,
                reservedLeaseCount: 0,
                reservedExpiresAtMs: null,
                externalUsedPct: 0,
                safetyReviewUsedPct: 0,
              };

        const updated5hSt = used5hExact !== null ? buckets.get(key5h) || null : null;
        const updated5hExtTs = Math.max(
          peerExtTsWk,
          Number(updated5hSt?.lastExternalUsageAtMs) || 0
        );

        const resWk =
          usedWkExact !== null
            ? observeBucket({
                bucketKey: keyWk,
                poolKey,
                win: 'weekly',
                officialUsedPct: usedWkExact,
                resetTimeMs: resetWkMs,
                quotaFetchedAtMs,
                cycleCostUsd: costWkUsd,
                cycleCalls: callsWk,
                pricedTokens: pricedTokensWk,
                modelCostsUsd: modelCostsWk,
                modelTokens: modelTokensWk,
                unpricedCalls: unpricedWk,
                poolLastActivityMs,
                activeSessionCount10m,
                recent10mCostUsd,
                hasRunningLocalSession,
                localScanIncomplete,
                forceExternalJump: isProportionalExternal,
                peerLastExternalUsageAtMs: updated5hExtTs,
                peerHasExternalUsage: Boolean(updated5hSt?.hasExternalUsage),
                unmatchedHeavySafety: unmatchedHeavyWk,
                observedCycleSafetyPct: obsSafetyWk.estPct,
                observedSafetyLatestMs: obsSafetyWk.latestEventMs,
                nowMs,
              })
            : {
                reservedPct: 0,
                reservedLeaseCount: 0,
                reservedExpiresAtMs: null,
                externalUsedPct: 0,
                safetyReviewUsedPct: 0,
              };

        // 对称补齐：若周限在本轮确认空闲外部消耗，而 5h 因单桶微增暂存在 idleUnexplainedAccumPct 中，同步记入 5h 非自用
        const st5hNow = used5hExact !== null ? buckets.get(key5h) || null : null;
        const stWkNow = usedWkExact !== null ? buckets.get(keyWk) || null : null;
        if (
          st5hNow &&
          stWkNow &&
          !localScanIncomplete &&
          !isFiveHOnlyServerLease &&
          stWkNow.lastExternalUsageAtMs === nowMs &&
          (Number(st5hNow.idleUnexplainedAccumPct) || 0) >= QR_MIN_DISPLAY_RESERVED_PCT
        ) {
          const symAmt = Number(st5hNow.idleUnexplainedAccumPct) || 0;
          st5hNow.idleUnexplainedAccumPct = 0;
          st5hNow.hasExternalUsage = true;
          st5hNow.lastExternalUsageAtMs = nowMs;
          st5hNow.externalUsedPct = Math.min(
            100,
            (Number(st5hNow.externalUsedPct) || 0) + symAmt
          );
          st5hNow.externalEvents = (Number(st5hNow.externalEvents) || 0) + 1;
          qrReconcileExternalUsageBound(
            st5hNow,
            used5hExact,
            st5hNow.lastCycleCostUsd,
            st5hNow.lastModelCostsUsd,
            nowMs,
            {
              localScanIncomplete,
              hasRunningLocalSession,
              suppressIdleExternal: isFiveHOnlyServerLease,
              peerHasExternalUsage: Boolean(stWkNow?.hasExternalUsage),
              observedCycleSafetyPct: obsSafety5h.estPct,
              observedSafetyLatestMs: obsSafety5h.latestEventMs,
            }
          );
          res5h = qrFormatOutput(st5hNow, used5hExact);
          persistIfNeeded('external_usage', nowMs);
        }

        poolObj.reservedPct = res5h.reservedPct;
        poolObj.reservedLeaseCount = res5h.reservedLeaseCount;
        poolObj.reservedExpiresAtMs = res5h.reservedExpiresAtMs;
        poolObj.externalUsedPct = res5h.externalUsedPct;
        poolObj.safetyReviewUsedPct = res5h.safetyReviewUsedPct;
        poolObj.weeklyReservedPct = resWk.reservedPct;
        poolObj.weeklyReservedLeaseCount = resWk.reservedLeaseCount;
        poolObj.weeklyReservedExpiresAtMs = resWk.reservedExpiresAtMs;
        poolObj.weeklyExternalUsedPct = resWk.externalUsedPct;
        poolObj.weeklySafetyReviewUsedPct = resWk.safetyReviewUsedPct;
        poolObj.rateEstimate = qrBuildPoolRateEstimate(st5hNow, stWkNow, nowMs, {
          out5h: res5h,
          outWk: resWk,
        });
      }
    } finally {
      batchingDepth = Math.max(0, batchingDepth - 1);
      if (batchingDepth === 0 && batchPendingEvent) {
        const pending = batchPendingEvent;
        batchPendingEvent = null;
        persistIfNeeded(pending, nowMs);
      }
    }
  }

  function getLogSnapshot() {
    ensureHydrated();
    const bucketSummaries = [];
    for (const [key, st] of buckets.entries()) {
      const parts = key.split('::');
      const usedPct = st.lastOfficialUsedPct ?? 0;
      const out = qrFormatOutput(st, usedPct);
      const byModel = {};
      for (const [mKey, mr] of Object.entries(st.modelRates || {})) {
        if (!mr || mr.ratePctPerUsd === null) continue;
        byModel[mKey] = {
          ratePctPerUsd: +mr.ratePctPerUsd.toFixed(4),
          eqFullUsd: +(100 / mr.ratePctPerUsd).toFixed(1),
          samples: mr.rateSamples,
        };
      }
      bucketSummaries.push({
        pool: parts[2] || key,
        win: parts[3] || '',
        usedPct: +usedPct.toFixed(3),
        cycleCostUsd: +Number(st.lastCycleCostUsd || 0).toFixed(4),
        ratePctPerUsd: st.ratePctPerUsd !== null ? +st.ratePctPerUsd.toFixed(4) : null,
        rateSamples: st.rateSamples,
        reservedPct: out.reservedPct,
        leases: out.reservedLeaseCount,
        ...(st.hasExternalUsage || out.externalUsedPct > 0
          ? {
              hasExternalUsage: true,
              externalUsedPct: out.externalUsedPct,
              externalEvents: Number(st.externalEvents) || 0,
            }
          : {}),
        ...(out.safetyReviewUsedPct > 0 || (Number(st.safetyReviewEvents) || 0) > 0
          ? {
              safetyReviewUsedPct: out.safetyReviewUsedPct,
              safetyReviewEvents: Number(st.safetyReviewEvents) || 0,
            }
          : {}),
        ...(Object.keys(byModel).length > 0 ? { byModel } : {}),
      });
    }
    return {
      generatedAt: new Date().toISOString(),
      count: eventLog.length,
      maxEntries: QR_MAX_EVENT_LOG,
      buckets: bucketSummaries,
      events: eventLog.slice(),
    };
  }

  function reset() {
    buckets.clear();
    eventLog.length = 0;
    lastPersistMs = 0;
    batchingDepth = 0;
    batchPendingEvent = null;
    hydrated = true;
  }

  return {
    observeBucket,
    updatePools,
    getLogSnapshot,
    reset,
    _buckets: buckets,
  };
}

function qrIsTestRuntime() {
  return (
    lsRuntimeEndpoint?.addr === 'test.invalid' ||
    String(process?.env?.ANTIGRAVITY_LS_ADDRESS || '').trim() === 'test.invalid'
  );
}

const defaultQuotaReservationTracker = createQuotaReservationTracker({
  loadState: () => {
    if (qrIsTestRuntime()) return null;
    return loadJson(QUOTA_RESERVATION_STATE_FILE, null);
  },
  saveState: (payload) => {
    if (qrIsTestRuntime()) return;
    saveJson(QUOTA_RESERVATION_STATE_FILE, payload);
  },
});

/**
 * 使用全局默认追踪器为 `quotaPoolsMap` 中的所有配额池刷新 5h 及周限的实验性预占估算字段。
 */
export function updatePoolQuotaReservationEstimates(params) {
  return defaultQuotaReservationTracker.updatePools(params);
}

/**
 * 获取当前内存中的配额预占观测日志快照（供「其他 → 试验性功能」复制到剪贴板）。
 */
export function getQuotaReservationLogSnapshot() {
  return defaultQuotaReservationTracker.getLogSnapshot();
}

/**
 * 清空全局默认配额预占状态（供测试隔离使用）。
 */
export function resetQuotaReservationState() {
  defaultQuotaReservationTracker.reset();
}
