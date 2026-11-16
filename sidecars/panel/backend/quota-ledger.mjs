/**
 * @fileoverview 会话级配额分组消耗台账（实时扣减差值归因 + 当期未追踪历史按占比保守估算）。
 *
 * 原则：
 * 1. 基于 `resolveStepQuotaPoolKey` 对活跃根会话及其全部子代理的步骤按配额池聚合 Tokens、调用次数与等效费用；
 * 2. 在侧栏轮询获得非缓存官方配额快照 (`!fromCache`) 且配额已用比例增长时，
 *    将新增消耗权重归因至该区间内活跃产生新步骤的根会话，并持久化至 `DATA_DIR/session_quota_ledger.json`；
 * 3. `5h` 与 `weekly` 窗口维护各自独立的待归因队列，避免两个窗口更新节拍不同步时相互清除；
 * 4. 若存在插件记录前的历史步骤且落入当前 5h/周限额重置周期，则扣除全账号已实测归因的百分比后，
 *    按当期未追踪权重比例保守估算并明确标记来源 (`observed` / `estimated` / `mixed` / `untracked`)；
 *    超出当前重置周期且无实测记录的早期历史会话严格返回 `usedPct: null` (`untracked`)，绝不伪造百分比。
 */

import { parseIsoMs } from '../speed-metrics.mjs';
import {
  SESSION_QUOTA_LEDGER_FILE,
  loadJson,
  saveJson,
} from './config.mjs';
import { computeStepCost, resolveModelInfo } from './model-pricing.mjs';
import { POOL_PRIORITY_ORDER, resolveStepQuotaPoolKey } from './quota-pools.mjs';
import { collectAccountConversationEntries } from './usage-aggregator.mjs';

const PENDING_WORK_TTL_MS = 180_000;
const RESET_JUMP_TOLERANCE_MS = 10 * 60_000;

function ledgerSafeTok(val) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function roundCostVal(val) {
  if (!Number.isFinite(val) || val <= 0) return 0;
  return val < 0.01 ? +val.toFixed(4) : +val.toFixed(2);
}

function createEmptyPoolAcc() {
  return {
    calls: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    unpricedCalls: 0,
    weightedWork: 0,
    lastStepMs: 0,
    win5h: { calls: 0, tokens: 0, costUsd: 0, weightedWork: 0 },
    winWeekly: { calls: 0, tokens: 0, costUsd: 0, weightedWork: 0 },
  };
}

function createEmptyLedger() {
  return { version: 2, accounts: {} };
}

function isSameResetWindow(aIso, bIso) {
  if (!aIso || !bIso) return true;
  const aMs = parseIsoMs(aIso);
  const bMs = parseIsoMs(bIso);
  if (!aMs || !bMs) return String(aIso) === String(bIso);
  return Math.abs(aMs - bMs) <= RESET_JUMP_TOLERANCE_MS;
}

function ensureAccountState(ledger, accountKey, nowMs) {
  if (!ledger.accounts || typeof ledger.accounts !== 'object') {
    ledger.accounts = {};
  }
  if (!ledger.accounts[accountKey]) {
    ledger.accounts[accountKey] = {
      startedTrackingAtMs: nowMs,
      snapshots: {},
      convWorkBaseline: {},
      pendingByWindow: { '5h': {}, weekly: {} },
      sessions: {},
    };
  }
  const acct = ledger.accounts[accountKey];
  if (!acct.startedTrackingAtMs) acct.startedTrackingAtMs = nowMs;
  if (!acct.snapshots) acct.snapshots = {};
  if (!acct.convWorkBaseline) acct.convWorkBaseline = {};
  if (!acct.pendingByWindow) acct.pendingByWindow = { '5h': {}, weekly: {} };
  if (!acct.pendingByWindow['5h']) acct.pendingByWindow['5h'] = {};
  if (!acct.pendingByWindow.weekly) acct.pendingByWindow.weekly = {};
  if (!acct.sessions) acct.sessions = {};
  return acct;
}

function ensureSessionPoolRecord(acctState, cidLower, poolKey) {
  if (!acctState.sessions[cidLower]) {
    acctState.sessions[cidLower] = {};
  }
  if (!acctState.sessions[cidLower][poolKey]) {
    acctState.sessions[cidLower][poolKey] = {
      observed5hPct: 0,
      observed5hWinPct: 0,
      win5hResetTime: '',
      tracked5hSteps: 0,
      tracked5hWork: 0,
      settledZero5hSteps: 0,
      settledZero5hWork: 0,
      observedWeeklyPct: 0,
      observedWeeklyWinPct: 0,
      winWeeklyResetTime: '',
      trackedWeeklySteps: 0,
      trackedWeeklyWork: 0,
      settledZeroWeeklySteps: 0,
      settledZeroWeeklyWork: 0,
    };
  }
  return acctState.sessions[cidLower][poolKey];
}

let memoryLedgerCache = null;

/** 重置内存台账缓存（仅供单元测试在独立沙箱中调用）。 */
export function resetSessionQuotaLedgerCache() {
  memoryLedgerCache = null;
}

function getOrLoadQuotaLedger() {
  if (memoryLedgerCache) return memoryLedgerCache;
  const loaded = loadJson(SESSION_QUOTA_LEDGER_FILE, null);
  if (loaded && typeof loaded === 'object' && loaded.accounts && loaded.version === 2) {
    memoryLedgerCache = loaded;
  } else {
    memoryLedgerCache = createEmptyLedger();
  }
  return memoryLedgerCache;
}

/**
 * 更新实时配额扣减台账并构建当前活跃会话（主代理+子代理）的「已使用额度」分分组汇总。
 *
 * @param {{
 *   activeCascadeId?: string|null,
 *   activeFamilyCascadeIds?: Set<string>|null,
 *   currentAccountName?: string,
 *   quotaPoolsMap?: Map<string, object>,
 *   officialQuotaInfo?: { fromCache?: boolean, refreshFailed?: boolean }|null,
 *   dynamicModelMap?: Map<string, object>,
 *   nowMs?: number
 * }} params
 * @returns {{
 *   cascadeId: string|null,
 *   pools: Array<object>,
 *   totalCalls: number,
 *   totalTokens: number,
 *   totalCostUsd: number,
 *   unpricedCalls: number,
 *   unknownPoolCalls: number,
 *   unknownPoolTokens: number
 * }}
 */
export function updateLedgerAndBuildSessionUsedQuota({
  activeCascadeId = null,
  activeFamilyCascadeIds = null,
  currentAccountName = '',
  quotaPoolsMap = new Map(),
  officialQuotaInfo = null,
  dynamicModelMap = new Map(),
  nowMs = Date.now(),
} = {}) {
  const activeLower = String(activeCascadeId || '').trim().toLowerCase();
  const rawFamilyIds =
    activeFamilyCascadeIds instanceof Set
      ? Array.from(activeFamilyCascadeIds)
      : activeLower
        ? [activeLower]
        : [];
  const familySet = new Set(rawFamilyIds.map((id) => String(id || '').toLowerCase()));

  // 为各可用池计算当前 5h 与每周窗口起始时间，供当期未追踪步骤占比估算使用
  const windowBoundsByPool = new Map();
  for (const [pk, pInfo] of quotaPoolsMap.entries()) {
    const reset5hMs = parseIsoMs(pInfo?.resetTime);
    const resetWkMs = parseIsoMs(pInfo?.weeklyResetTime);
    windowBoundsByPool.set(pk, {
      start5hMs: reset5hMs > 0 ? reset5hMs - 5 * 3600_000 : 0,
      end5hMs: reset5hMs > 0 ? Math.max(nowMs, reset5hMs) : nowMs,
      startWkMs: resetWkMs > 0 ? resetWkMs - 7 * 24 * 3600_000 : 0,
      endWkMs: resetWkMs > 0 ? Math.max(nowMs, resetWkMs) : nowMs,
    });
  }

  // 1. 全量扫描当前账号所有根会话（已归并子代理）在各配额池中的工作量与当前活跃会话分池消耗
  const { entries } = collectAccountConversationEntries({ currentAccountName, familySet });
  const poolStatsByConv = new Map();
  let activeUnknownPoolCalls = 0;
  let activeUnknownPoolTokens = 0;

  for (const entry of entries) {
    const cidLower = String(entry?.cascadeId || '').toLowerCase();
    if (!cidLower) continue;
    let convMap = poolStatsByConv.get(cidLower);
    if (!convMap) {
      convMap = new Map();
      poolStatsByConv.set(cidLower, convMap);
    }

    for (const st of entry.steps || []) {
      if (!st || typeof st !== 'object') continue;
      const inTok = ledgerSafeTok(st.inputTokens);
      const cacheTok = ledgerSafeTok(st.cacheReadTokens);
      const outTok = ledgerSafeTok(st.outputTokens);
      const stepTotalTokens = inTok + cacheTok + outTok;

      const pk = resolveStepQuotaPoolKey(st, dynamicModelMap, quotaPoolsMap);
      if (!pk) {
        if (cidLower === activeLower) {
          activeUnknownPoolCalls += 1;
          activeUnknownPoolTokens += stepTotalTokens;
        }
        continue;
      }

      const mInfo = resolveModelInfo(
        st.modelKey,
        dynamicModelMap,
        st.apiProvider,
        st.modelDisplayName,
        st.responseModel
      );
      const stepCost = computeStepCost(st, mInfo.pricing);
      const resolvedCost = Number.isFinite(stepCost) ? stepCost : 0;
      const workWeight =
        Number.isFinite(stepCost) && stepCost > 0
          ? stepCost
          : Math.max(0.0001, (inTok * 2 + cacheTok * 0.2 + outTok * 10) / 1_000_000);
      const tMs = Number(st.createdAtMs) > 0 ? Number(st.createdAtMs) : 0;

      let acc = convMap.get(pk);
      if (!acc) {
        acc = createEmptyPoolAcc();
        convMap.set(pk, acc);
      }
      acc.calls += 1;
      acc.inputTokens += inTok;
      acc.cacheReadTokens += cacheTok;
      acc.outputTokens += outTok;
      acc.totalTokens += stepTotalTokens;
      acc.costUsd += resolvedCost;
      if (stepCost === null) acc.unpricedCalls += 1;
      acc.weightedWork += workWeight;
      if (tMs > acc.lastStepMs) acc.lastStepMs = tMs;

      const bounds = windowBoundsByPool.get(pk);
      if (bounds && tMs > 0) {
        if (bounds.start5hMs > 0 && tMs >= bounds.start5hMs && tMs <= bounds.end5hMs + 60_000) {
          acc.win5h.calls += 1;
          acc.win5h.tokens += stepTotalTokens;
          acc.win5h.costUsd += resolvedCost;
          acc.win5h.weightedWork += workWeight;
        }
        if (bounds.startWkMs > 0 && tMs >= bounds.startWkMs && tMs <= bounds.endWkMs + 60_000) {
          acc.winWeekly.calls += 1;
          acc.winWeekly.tokens += stepTotalTokens;
          acc.winWeekly.costUsd += resolvedCost;
          acc.winWeekly.weightedWork += workWeight;
        }
      }
    }
  }

  // 2. 仅当官方配额池存在有效实时数据且未失败时，运行实时差值追踪与归因
  const hasAnyAvailablePool = Array.from(quotaPoolsMap.values()).some(
    (p) => Boolean(p?.isAvailable) && (Boolean(p?.has5h) || Boolean(p?.hasWeekly))
  );
  const canInspectLiveQuotas = hasAnyAvailablePool && !officialQuotaInfo?.refreshFailed;
  const isFreshQuotaResponse = canInspectLiveQuotas && officialQuotaInfo?.fromCache === false;

  const accountKey = currentAccountName || '__default__';
  const ledger = canInspectLiveQuotas ? getOrLoadQuotaLedger() : null;
  const acctState = ledger ? ensureAccountState(ledger, accountKey, nowMs) : null;
  let ledgerDirty = false;

  if (acctState && canInspectLiveQuotas) {
    const appendPendingForWindow = (winKey, pk, cid, deltaSteps, deltaWork, lastStepMs) => {
      if (!acctState.pendingByWindow[winKey][pk]) {
        acctState.pendingByWindow[winKey][pk] = {};
      }
      const curP = acctState.pendingByWindow[winKey][pk][cid] || {
        weight: 0,
        stepsAdded: 0,
        lastStepMs: 0,
        updatedAtMs: nowMs,
      };
      curP.weight += deltaWork;
      curP.stepsAdded += deltaSteps;
      curP.lastStepMs = Math.max(curP.lastStepMs, lastStepMs || nowMs);
      curP.updatedAtMs = nowMs;
      acctState.pendingByWindow[winKey][pk][cid] = curP;
    };

    for (const [pk, poolInfo] of quotaPoolsMap.entries()) {
      if (!poolInfo?.isAvailable) continue;
      if (!acctState.pendingByWindow['5h'][pk]) acctState.pendingByWindow['5h'][pk] = {};
      if (!acctState.pendingByWindow.weekly[pk]) acctState.pendingByWindow.weekly[pk] = {};

      const prevSnap = acctState.snapshots[pk];
      if (!prevSnap) {
        // 首次建基线：记录全局配额起点及现有会话步骤基线，绝不把历史累计误算为瞬时新增
        acctState.snapshots[pk] = {
          used5hPct: poolInfo.has5h ? poolInfo.usedPct : null,
          reset5hTime: poolInfo.has5h ? poolInfo.resetTime || '' : '',
          usedWeeklyPct: poolInfo.hasWeekly ? poolInfo.weeklyUsedPct : null,
          resetWeeklyTime: poolInfo.hasWeekly ? poolInfo.weeklyResetTime || '' : '',
          updatedAtMs: nowMs,
        };
        for (const [cid, convMap] of poolStatsByConv.entries()) {
          const pStats = convMap.get(pk);
          if (!pStats || pStats.calls <= 0) continue;
          if (!acctState.convWorkBaseline[cid]) acctState.convWorkBaseline[cid] = {};
          acctState.convWorkBaseline[cid][pk] = {
            stepCount: pStats.calls,
            weightedWork: pStats.weightedWork,
          };
        }
        ledgerDirty = true;
        continue;
      }

      // 检测自上次基线以来每个根会话在该池产生的新步骤工作量
      for (const [cid, convMap] of poolStatsByConv.entries()) {
        const pStats = convMap.get(pk);
        if (!pStats || pStats.calls <= 0) continue;
        if (!acctState.convWorkBaseline[cid]) acctState.convWorkBaseline[cid] = {};
        const prevB = acctState.convWorkBaseline[cid][pk];
        if (!prevB) {
          const isPostTrackingStep =
            pStats.lastStepMs >= acctState.startedTrackingAtMs - 15_000 ||
            (pStats.lastStepMs > 0 && nowMs - pStats.lastStepMs <= 120_000);
          if (isPostTrackingStep) {
            if (poolInfo.has5h) {
              appendPendingForWindow('5h', pk, cid, pStats.calls, pStats.weightedWork, pStats.lastStepMs);
            }
            if (poolInfo.hasWeekly) {
              appendPendingForWindow('weekly', pk, cid, pStats.calls, pStats.weightedWork, pStats.lastStepMs);
            }
          }
          acctState.convWorkBaseline[cid][pk] = {
            stepCount: pStats.calls,
            weightedWork: pStats.weightedWork,
          };
          ledgerDirty = true;
        } else if (
          pStats.calls > prevB.stepCount ||
          pStats.weightedWork > prevB.weightedWork + 1e-6
        ) {
          const dSteps = Math.max(0, pStats.calls - prevB.stepCount);
          const dWork = Math.max(0.0001, pStats.weightedWork - prevB.weightedWork);
          if (poolInfo.has5h) {
            appendPendingForWindow('5h', pk, cid, dSteps, dWork, pStats.lastStepMs);
          }
          if (poolInfo.hasWeekly) {
            appendPendingForWindow('weekly', pk, cid, dSteps, dWork, pStats.lastStepMs);
          }
          acctState.convWorkBaseline[cid][pk] = {
            stepCount: pStats.calls,
            weightedWork: pStats.weightedWork,
          };
          ledgerDirty = true;
        }
      }

      if (!isFreshQuotaResponse) {
        continue;
      }

      const processWindowDelta = (winKey) => {
        const is5h = winKey === '5h';
        const hasWin = is5h ? Boolean(poolInfo.has5h) : Boolean(poolInfo.hasWeekly);
        const currUsed = is5h ? poolInfo.usedPct : poolInfo.weeklyUsedPct;
        if (!hasWin || currUsed == null || !Number.isFinite(Number(currUsed))) return;

        const currUsedNum = Number(currUsed);
        const currReset = (is5h ? poolInfo.resetTime : poolInfo.weeklyResetTime) || '';
        const prevUsedRaw = is5h ? prevSnap.used5hPct : prevSnap.usedWeeklyPct;
        const prevReset = (is5h ? prevSnap.reset5hTime : prevSnap.resetWeeklyTime) || '';

        const winQueue = acctState.pendingByWindow[winKey][pk] || {};
        const zeroStepsField = is5h ? 'settledZero5hSteps' : 'settledZeroWeeklySteps';
        const zeroWorkField = is5h ? 'settledZero5hWork' : 'settledZeroWeeklyWork';
        const trackedStepsField = is5h ? 'tracked5hSteps' : 'trackedWeeklySteps';
        const trackedWorkField = is5h ? 'tracked5hWork' : 'trackedWeeklyWork';
        const winPctField = is5h ? 'observed5hWinPct' : 'observedWeeklyWinPct';
        const totalPctField = is5h ? 'observed5hPct' : 'observedWeeklyPct';
        const resetField = is5h ? 'win5hResetTime' : 'winWeeklyResetTime';
        const snapUsedField = is5h ? 'used5hPct' : 'usedWeeklyPct';
        const snapResetField = is5h ? 'reset5hTime' : 'resetWeeklyTime';

        // 过期未触发配额波动的 pendingWork 记为已由实时监控观察（零扣减）
        for (const [cid, pEntry] of Object.entries(winQueue)) {
          if (nowMs - (pEntry?.updatedAtMs || 0) > PENDING_WORK_TTL_MS) {
            const sRec = ensureSessionPoolRecord(acctState, cid, pk);
            sRec[zeroStepsField] = Number(sRec[zeroStepsField] || 0) + Number(pEntry.stepsAdded || 0);
            sRec[zeroWorkField] = Number(sRec[zeroWorkField] || 0) + Number(pEntry.weight || 0);
            delete winQueue[cid];
            ledgerDirty = true;
          }
        }

        const pendingEntries = Object.entries(winQueue);
        const totalPendingWeight = pendingEntries.reduce(
          (sum, [, p]) => sum + Math.max(0, Number(p?.weight || 0)),
          0
        );

        const prevResetMs = parseIsoMs(prevReset);
        const currResetMs = parseIsoMs(currReset);
        const didReset =
          prevResetMs > 0 && currResetMs > prevResetMs + RESET_JUMP_TOLERANCE_MS;

        if (didReset) {
          for (const sPools of Object.values(acctState.sessions)) {
            if (sPools?.[pk]) {
              sPools[pk][winPctField] = 0;
              sPools[pk][resetField] = currReset;
            }
          }
          if (currUsedNum > 0 && totalPendingWeight > 0) {
            for (const [cid, pEntry] of pendingEntries) {
              const sRec = ensureSessionPoolRecord(acctState, cid, pk);
              const share = +(currUsedNum * (pEntry.weight / totalPendingWeight)).toFixed(3);
              sRec[totalPctField] = +(Number(sRec[totalPctField] || 0) + share).toFixed(3);
              sRec[winPctField] = +(Number(sRec[winPctField] || 0) + share).toFixed(3);
              sRec[resetField] = currReset;
              sRec[trackedStepsField] =
                Number(sRec[trackedStepsField] || 0) + Number(pEntry.stepsAdded || 0);
              sRec[trackedWorkField] =
                Number(sRec[trackedWorkField] || 0) + Number(pEntry.weight || 0);
            }
            acctState.pendingByWindow[winKey][pk] = {};
          }
          prevSnap[snapUsedField] = currUsedNum;
          prevSnap[snapResetField] = currReset;
          prevSnap.updatedAtMs = nowMs;
          ledgerDirty = true;
          return;
        }

        if (prevUsedRaw != null && Number.isFinite(Number(prevUsedRaw))) {
          const deltaPct = +(currUsedNum - Number(prevUsedRaw)).toFixed(2);
          if (deltaPct > 0) {
            if (totalPendingWeight > 0) {
              for (const [cid, pEntry] of pendingEntries) {
                const sRec = ensureSessionPoolRecord(acctState, cid, pk);
                if (currReset && sRec[resetField] && !isSameResetWindow(sRec[resetField], currReset)) {
                  sRec[winPctField] = 0;
                }
                const share = +(deltaPct * (pEntry.weight / totalPendingWeight)).toFixed(3);
                sRec[totalPctField] = +(Number(sRec[totalPctField] || 0) + share).toFixed(3);
                sRec[winPctField] = +(Number(sRec[winPctField] || 0) + share).toFixed(3);
                if (currReset) sRec[resetField] = currReset;
                sRec[trackedStepsField] =
                  Number(sRec[trackedStepsField] || 0) + Number(pEntry.stepsAdded || 0);
                sRec[trackedWorkField] =
                  Number(sRec[trackedWorkField] || 0) + Number(pEntry.weight || 0);
              }
              acctState.pendingByWindow[winKey][pk] = {};
            }
            prevSnap[snapUsedField] = currUsedNum;
            if (currReset) prevSnap[snapResetField] = currReset;
            prevSnap.updatedAtMs = nowMs;
            ledgerDirty = true;
          } else if (deltaPct < -0.5) {
            prevSnap[snapUsedField] = currUsedNum;
            if (currReset) prevSnap[snapResetField] = currReset;
            prevSnap.updatedAtMs = nowMs;
            ledgerDirty = true;
          } else if (currReset && currReset !== prevReset) {
            prevSnap[snapResetField] = currReset;
            ledgerDirty = true;
          }
        } else {
          prevSnap[snapUsedField] = currUsedNum;
          prevSnap[snapResetField] = currReset;
          prevSnap.updatedAtMs = nowMs;
          ledgerDirty = true;
        }
      };

      processWindowDelta('5h');
      processWindowDelta('weekly');
    }

    if (ledgerDirty) {
      saveJson(SESSION_QUOTA_LEDGER_FILE, ledger);
    }
  }

  // 3. 组装当前活跃会话（含子代理）在各已使用配额分组中的消耗明细
  const activeConvPoolMap = poolStatsByConv.get(activeLower) || new Map();
  const usedPools = [];
  let grandTotalCalls = 0;
  let grandTotalTokens = 0;
  let grandTotalCostUsd = 0;
  let grandUnpricedCalls = 0;

  const sortedPoolKeys = Array.from(activeConvPoolMap.keys()).sort((a, b) => {
    const ia = POOL_PRIORITY_ORDER.indexOf(a);
    const ib = POOL_PRIORITY_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return String(a).localeCompare(String(b));
  });

  const buildWindowMetrics = (pk, poolInfo, activeStats, winKey) => {
    const is5h = winKey === '5h';
    const hasWindow = is5h ? Boolean(poolInfo?.has5h) : Boolean(poolInfo?.hasWeekly);
    const winStats = is5h ? activeStats.win5h : activeStats.winWeekly;
    if (!hasWindow) {
      return {
        usedPct: null,
        observedPct: 0,
        estimatedPct: 0,
        source: 'none',
        windowCalls: winStats.calls,
        windowTokens: winStats.tokens,
        windowCostUsd: roundCostVal(winStats.costUsd),
      };
    }

    const poolGlobalUsedRaw = is5h ? poolInfo?.usedPct : poolInfo?.weeklyUsedPct;
    const poolGlobalUsed =
      poolGlobalUsedRaw != null && Number.isFinite(Number(poolGlobalUsedRaw))
        ? Number(poolGlobalUsedRaw)
        : null;
    const currReset = (is5h ? poolInfo?.resetTime : poolInfo?.weeklyResetTime) || '';

    const sessRec = acctState?.sessions?.[activeLower]?.[pk] || null;
    const pendingEntry = acctState?.pendingByWindow?.[winKey]?.[pk]?.[activeLower] || null;
    const trackedStepsField = is5h ? 'tracked5hSteps' : 'trackedWeeklySteps';
    const trackedWorkField = is5h ? 'tracked5hWork' : 'trackedWeeklyWork';
    const zeroStepsField = is5h ? 'settledZero5hSteps' : 'settledZeroWeeklySteps';
    const zeroWorkField = is5h ? 'settledZero5hWork' : 'settledZeroWeeklyWork';
    const winPctField = is5h ? 'observed5hWinPct' : 'observedWeeklyWinPct';
    const totalPctField = is5h ? 'observed5hPct' : 'observedWeeklyPct';
    const resetField = is5h ? 'win5hResetTime' : 'winWeeklyResetTime';

    const obsTotal = +Number(sessRec?.[totalPctField] || 0).toFixed(1);
    const trackedCoverageCount =
      Number(sessRec?.[trackedStepsField] || 0) +
      Number(sessRec?.[zeroStepsField] || 0) +
      Number(pendingEntry?.stepsAdded || 0);
    const isFullyObserved = Boolean(acctState) && trackedCoverageCount >= activeStats.calls;

    if (isFullyObserved) {
      return {
        usedPct: obsTotal,
        observedPct: obsTotal,
        estimatedPct: 0,
        source: 'observed',
        windowCalls: winStats.calls,
        windowTokens: winStats.tokens,
        windowCostUsd: roundCostVal(winStats.costUsd),
      };
    }

    if (poolGlobalUsed === null || winStats.calls <= 0 || winStats.weightedWork <= 0) {
      return {
        usedPct: obsTotal > 0 ? obsTotal : null,
        observedPct: obsTotal,
        estimatedPct: 0,
        source: obsTotal > 0 ? 'observed' : 'untracked',
        windowCalls: winStats.calls,
        windowTokens: winStats.tokens,
        windowCostUsd: roundCostVal(winStats.costUsd),
      };
    }

    const sessTrackedWork =
      Number(sessRec?.[trackedWorkField] || 0) +
      Number(sessRec?.[zeroWorkField] || 0) +
      Number(pendingEntry?.weight || 0);
    const activeUntrackedWinWork = Math.max(0, winStats.weightedWork - sessTrackedWork);

    let sumAllObservedWinPct = 0;
    let sumAllUntrackedWinWork = 0;
    for (const [cid, convMap] of poolStatsByConv.entries()) {
      const cStats = convMap.get(pk);
      if (!cStats) continue;
      const cWin = is5h ? cStats.win5h : cStats.winWeekly;
      const cRec = acctState?.sessions?.[cid]?.[pk] || null;
      const cPending = acctState?.pendingByWindow?.[winKey]?.[pk]?.[cid] || null;

      if (cRec) {
        const cResetVal = cRec[resetField];
        if (!cResetVal || !currReset || isSameResetWindow(cResetVal, currReset)) {
          sumAllObservedWinPct += Number(cRec[winPctField] || 0);
        }
      }

      if (cWin.weightedWork > 0) {
        const cCoveredWork =
          Number(cRec?.[trackedWorkField] || 0) +
          Number(cRec?.[zeroWorkField] || 0) +
          Number(cPending?.weight || 0);
        sumAllUntrackedWinWork += Math.max(0, cWin.weightedWork - cCoveredWork);
      }
    }

    const remainingUnattributed = Math.max(0, poolGlobalUsed - sumAllObservedWinPct);
    const estPct =
      sumAllUntrackedWinWork > 0 && activeUntrackedWinWork > 0
        ? +(remainingUnattributed * (activeUntrackedWinWork / sumAllUntrackedWinWork)).toFixed(1)
        : 0;
    const combinedPct = +(obsTotal + estPct).toFixed(1);
    const source =
      obsTotal > 0 && estPct > 0
        ? 'mixed'
        : estPct > 0
          ? 'estimated'
          : obsTotal > 0
            ? 'observed'
            : poolGlobalUsed === 0
              ? 'estimated'
              : 'untracked';

    return {
      usedPct: combinedPct,
      observedPct: obsTotal,
      estimatedPct: estPct,
      source,
      windowCalls: winStats.calls,
      windowTokens: winStats.tokens,
      windowCostUsd: roundCostVal(winStats.costUsd),
    };
  };

  for (const pk of sortedPoolKeys) {
    const pStats = activeConvPoolMap.get(pk);
    if (!pStats || pStats.calls <= 0) continue;

    const poolInfo = quotaPoolsMap.get(pk) || null;
    const poolLabel =
      poolInfo?.poolLabel ||
      (pk === 'Argon' ? 'Gemini 4 Argon' : pk === 'Carbon' ? 'Gemini 4 Carbon' : pk);

    const w5h = buildWindowMetrics(pk, poolInfo, pStats, '5h');
    const wWk = buildWindowMetrics(pk, poolInfo, pStats, 'weekly');

    grandTotalCalls += pStats.calls;
    grandTotalTokens += pStats.totalTokens;
    grandTotalCostUsd += pStats.costUsd;
    grandUnpricedCalls += pStats.unpricedCalls;

    usedPools.push({
      poolKey: pk,
      poolLabel,
      family: pk,
      calls: pStats.calls,
      inputTokens: pStats.inputTokens,
      cacheReadTokens: pStats.cacheReadTokens,
      outputTokens: pStats.outputTokens,
      totalTokens: pStats.totalTokens,
      costUsd: roundCostVal(pStats.costUsd),
      unpricedCalls: pStats.unpricedCalls,
      has5h: Boolean(poolInfo?.has5h),
      hasWeekly: Boolean(poolInfo?.hasWeekly),
      used5hPct: w5h.usedPct,
      observed5hPct: w5h.observedPct,
      estimated5hPct: w5h.estimatedPct,
      source5h: w5h.source,
      win5hTokens: w5h.windowTokens,
      win5hCostUsd: w5h.windowCostUsd,
      win5hCalls: w5h.windowCalls,
      usedWeeklyPct: wWk.usedPct,
      observedWeeklyPct: wWk.observedPct,
      estimatedWeeklyPct: wWk.estimatedPct,
      sourceWeekly: wWk.source,
      winWeeklyTokens: wWk.windowTokens,
      winWeeklyCostUsd: wWk.windowCostUsd,
      winWeeklyCalls: wWk.windowCalls,
    });
  }

  for (const p of usedPools) {
    p.shareOfSessionTokensPct =
      grandTotalTokens > 0 ? +((p.totalTokens / grandTotalTokens) * 100).toFixed(1) : 0;
  }

  return {
    cascadeId: activeCascadeId || null,
    pools: usedPools,
    totalCalls: grandTotalCalls,
    totalTokens: grandTotalTokens,
    totalCostUsd: roundCostVal(grandTotalCostUsd),
    unpricedCalls: grandUnpricedCalls,
    unknownPoolCalls: activeUnknownPoolCalls,
    unknownPoolTokens: activeUnknownPoolTokens,
  };
}
