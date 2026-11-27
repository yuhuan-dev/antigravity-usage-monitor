import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QR_CONSUME_LAG_GRACE_MS,
  QR_LEASE_IDLE_EXPIRY_MS,
  QR_REFUND_CONFIRM_WINDOW_MS,
  QR_TENTATIVE_LEASE_TTL_MS,
  createQuotaReservationTracker,
} from '../backend/quota-reservation.mjs';
import { normalizeFullSettings } from '../backend/settings-schema.mjs';
import {
  buildExportableSettingsJson,
  parseImportedSettingsJson,
} from '../src/core/settingsBackup.js';
import { backendHarness } from './backend-harness.mjs';
import { createMockDom } from './mock-dom.mjs';

const T0 = Date.parse('2026-11-22T09:00:00Z');
const RESET_5H = Date.parse('2026-11-22T14:00:00Z');
const RESET_WK = Date.parse('2026-11-28T09:00:00Z');

test('quota-reservation: 5h & weekly independently track staggered leases (错档触发)', () => {
  const tracker = createQuotaReservationTracker();

  // Bootstrap settled baseline: 5h ≈ 0.75 %/$, weekly ≈ 0.22 %/$
  const pool0 = new Map([
    [
      'Gemini',
      {
        poolKey: 'Gemini',
        has5h: true,
        hasWeekly: true,
        remainingFraction: 1 - 0.03,
        usedPct: 3.0,
        resetTime: new Date(RESET_5H).toISOString(),
        weeklyRemainingFraction: 1 - 0.11,
        weeklyUsedPct: 11.0,
        weeklyResetTime: new Date(RESET_WK).toISOString(),
      },
    ],
  ]);
  const stats0 = new Map([
    [
      'Gemini',
      {
        cycle5h: { costUsd: 4.0, unpricedCalls: 0 },
        cycleWeekly: { costUsd: 50.0, unpricedCalls: 0 },
        exactCost5hUsd: 4.0,
        exactCostWeeklyUsd: 50.0,
        recent10m: { lastActivityMs: T0, activeSessionCount: 1, costUsd: 0.1 },
      },
    ],
  ]);

  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'u@example.com',
    quotaPoolsMap: pool0,
    poolCycleStats: stats0,
    quotaFetchedAtMs: T0,
    nowMs: T0,
  });
  assert.equal(pool0.get('Gemini').reservedPct, 0);
  assert.equal(pool0.get('Gemini').weeklyReservedPct, 0);

  // Heavy turn ($0.10): 5h jumps +1.0% (lease 1%), weekly jumps +0.5% (lease 0.5%)
  const t1 = T0 + 20_000;
  const pool1 = new Map([
    [
      'Gemini',
      {
        ...pool0.get('Gemini'),
        remainingFraction: 1 - 0.04,
        usedPct: 4.0,
        weeklyRemainingFraction: 1 - 0.115,
        weeklyUsedPct: 11.5,
      },
    ],
  ]);
  const stats1 = new Map([
    [
      'Gemini',
      {
        cycle5h: { costUsd: 4.1, unpricedCalls: 0 },
        cycleWeekly: { costUsd: 50.1, unpricedCalls: 0 },
        exactCost5hUsd: 4.1,
        exactCostWeeklyUsd: 50.1,
        recent10m: { lastActivityMs: t1, activeSessionCount: 1, costUsd: 0.2 },
      },
    ],
  ]);

  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'u@example.com',
    quotaPoolsMap: pool1,
    poolCycleStats: stats1,
    quotaFetchedAtMs: t1,
    nowMs: t1,
  });

  // 5h excess = 1.0 - 0.075 = 0.925 -> 0.9%; weekly excess = 0.5 - 0.022 = 0.478 -> 0.5%
  assert.equal(pool1.get('Gemini').reservedPct, 0.9);
  assert.equal(pool1.get('Gemini').reservedLeaseCount, 1);
  assert.equal(pool1.get('Gemini').weeklyReservedPct, 0.5);
  assert.equal(pool1.get('Gemini').weeklyReservedLeaseCount, 1);
});

test('quota-reservation: consumes inside active lease and snaps to 0 on partial refund (退还差额)', () => {
  const tracker = createQuotaReservationTracker();
  const key = 'local::u@example.com::Gemini::5h';

  // Seed calibrated baseline: 1% per $1.00 (4.0% / $4.00)
  tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 4.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: T0,
    cycleCostUsd: 4.0,
    poolLastActivityMs: T0,
    nowMs: T0,
  });

  // Trigger 1.0% lease on $0.05 step -> excess = 0.95% -> 1.0%
  const t1 = T0 + 15_000;
  const r1 = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 5.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t1,
    cycleCostUsd: 4.05,
    poolLastActivityMs: t1,
    nowMs: t1,
  });
  assert.equal(r1.reservedPct, 1.0);

  // Follow-up turns spend $0.35 inside the lease while official stays flat at 5.0%:
  // first flat tick buffers for reporting-lag grace, follow-up flat poll past grace confirms consume -> 0.6%
  const t2 = t1 + 30_000;
  const r2Pending = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 5.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t2,
    cycleCostUsd: 4.4,
    poolLastActivityMs: t2,
    nowMs: t2,
  });
  assert.equal(r2Pending.reservedPct, 1.0);

  const t2Confirm = t2 + QR_CONSUME_LAG_GRACE_MS + 1_000;
  const r2 = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 5.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t2Confirm,
    cycleCostUsd: 4.4,
    poolLastActivityMs: t2,
    nowMs: t2Confirm,
  });
  assert.equal(r2.reservedPct, 0.6);

  // 10 minutes idle: server refunds remaining 0.6% (official drops 5.0% -> 4.4%)
  const t3 = t2Confirm + 10 * 60 * 1000;
  const r3 = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 4.4,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t3,
    cycleCostUsd: 4.4,
    poolLastActivityMs: t2,
    nowMs: t3,
  });
  assert.equal(r3.reservedPct, 0);
  assert.equal(r3.reservedLeaseCount, 0);
});

test('quota-reservation: stacks multiple concurrent session leases (2%+) and settles FIFO', () => {
  const tracker = createQuotaReservationTracker();
  const key = 'local::u@example.com::Gemini::weekly';

  // Seed weekly baseline: 0.2 %/$ (10% / $50)
  tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 10.0,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: T0,
    cycleCostUsd: 50.0,
    poolLastActivityMs: T0,
    nowMs: T0,
  });

  // Session A triggers +1.0% weekly lease
  const t1 = T0 + 15_000;
  const r1 = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 11.0,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: t1,
    cycleCostUsd: 50.1,
    poolLastActivityMs: t1,
    activeSessionCount10m: 1,
    nowMs: t1,
  });
  assert.equal(r1.reservedPct, 1.0);
  assert.equal(r1.reservedLeaseCount, 1);

  // Session B opens concurrently and triggers a second +1.0% weekly lease -> total ~2.0%
  const t2 = t1 + 25_000;
  const r2 = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 12.0,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: t2,
    cycleCostUsd: 50.2,
    poolLastActivityMs: t2,
    activeSessionCount10m: 2,
    nowMs: t2,
  });
  assert.equal(r2.reservedPct, 2.0);
  assert.equal(r2.reservedLeaseCount, 2);

  // Session A's lease expires first (-0.98% refund) -> Session B's ~1.0% lease remains
  const t3 = t1 + 10 * 60 * 1000;
  const r3 = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 11.02,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: t3,
    cycleCostUsd: 50.2,
    poolLastActivityMs: t2,
    activeSessionCount10m: 1,
    nowMs: t3,
  });
  assert.equal(r3.reservedPct, 1.0);
  assert.equal(r3.reservedLeaseCount, 1);

  // Session B's lease expires (-0.98% refund) -> back to 0%
  const t4 = t2 + 10 * 60 * 1000;
  const r4 = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 10.04,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: t4,
    cycleCostUsd: 50.2,
    poolLastActivityMs: t2,
    activeSessionCount10m: 0,
    nowMs: t4,
  });
  assert.equal(r4.reservedPct, 0);
  assert.equal(r4.reservedLeaseCount, 0);
});

test('quota-reservation: avoids false positives on genuinely large steps, handles TTL expiry & cycle reset', () => {
  const tracker = createQuotaReservationTracker();
  const key = 'local::u@example.com::Gemini::5h';

  // Baseline 0.75 %/$
  tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 3.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: T0,
    cycleCostUsd: 4.0,
    poolLastActivityMs: T0,
    nowMs: T0,
  });

  // Legitimate large $2.00 step -> expected +1.5%, official +1.5% -> NOT a reservation
  const t1 = T0 + 20_000;
  const rLarge = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 4.5,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t1,
    cycleCostUsd: 6.0,
    poolLastActivityMs: t1,
    nowMs: t1,
  });
  assert.equal(rLarge.reservedPct, 0);

  // Lease triggers (+0.5% on tiny $0.02 step), then idle past TTL+grace with no refund -> auto expires
  const t2 = t1 + 20_000;
  const rJump = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 5.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t2,
    cycleCostUsd: 6.02,
    poolLastActivityMs: t2,
    nowMs: t2,
  });
  assert.equal(rJump.reservedPct, 0.5);

  const tExpired = t2 + QR_LEASE_IDLE_EXPIRY_MS + 1_000;
  const rExpired = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 5.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: tExpired,
    cycleCostUsd: 6.02,
    poolLastActivityMs: t2,
    nowMs: tExpired,
  });
  assert.equal(rExpired.reservedPct, 0);

  // Trigger another lease then simulate 5h cycle rollover -> clears immediately while keeping rate
  const t3 = tExpired + 20_000;
  tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 6.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t3,
    cycleCostUsd: 6.05,
    poolLastActivityMs: t3,
    nowMs: t3,
  });
  const tReset = t3 + 60_000;
  const rReset = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 0.0,
    resetTimeMs: RESET_5H + 5 * 3600 * 1000,
    quotaFetchedAtMs: tReset,
    cycleCostUsd: 0,
    poolLastActivityMs: t3,
    nowMs: tReset,
  });
  assert.equal(rReset.reservedPct, 0);
  assert.ok(tracker._buckets.get(key).ratePctPerUsd > 0, 'calibrated rate preserved across reset');
});

test('quota-reservation: persists log, calibrated rate, and active leases across plugin restarts', () => {
  let storedPayload = null;
  const trackerA = createQuotaReservationTracker({
    loadState: () => storedPayload,
    saveState: (payload) => {
      storedPayload = JSON.parse(JSON.stringify(payload));
    },
  });
  const key = 'local::u@example.com::Gemini::5h';

  trackerA.observeBucket({
    bucketKey: key,
    officialUsedPct: 4.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: T0,
    cycleCostUsd: 4.0,
    poolLastActivityMs: T0,
    nowMs: T0,
  });

  const t1 = T0 + 20_000;
  trackerA.observeBucket({
    bucketKey: key,
    officialUsedPct: 5.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t1,
    cycleCostUsd: 4.05,
    poolLastActivityMs: t1,
    nowMs: t1,
  });
  assert.ok(storedPayload && storedPayload.events.length === 2, 'baseline + lease persisted to disk');

  // Simulate full plugin restart with a brand new tracker instance reading storedPayload
  const trackerB = createQuotaReservationTracker({
    loadState: () => storedPayload,
    saveState: (payload) => {
      storedPayload = JSON.parse(JSON.stringify(payload));
    },
  });
  const snapBeforeAnyPoll = trackerB.getLogSnapshot();
  assert.equal(snapBeforeAnyPoll.count, 2, 'historical events immediately available after restart');
  assert.equal(snapBeforeAnyPoll.buckets[0].reservedPct, 1.0, 'active lease survives restart');
  assert.equal(snapBeforeAnyPoll.buckets[0].ratePctPerUsd, 1.0, 'calibrated rate survives restart');

  // Refund arriving after restart cleanly reconciles against the hydrated lease
  const t2 = t1 + 10 * 60 * 1000;
  const rAfterRestart = trackerB.observeBucket({
    bucketKey: key,
    officialUsedPct: 4.05,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t2,
    cycleCostUsd: 4.05,
    poolLastActivityMs: t1,
    nowMs: t2,
  });
  assert.equal(rAfterRestart.reservedPct, 0);
  assert.equal(trackerB.getLogSnapshot().count, 3);
});

test('quota-reservation: suppresses replica ping-pong, keeps rolling median rate clean, and ignores 0% idle reset drift', () => {
  const tracker = createQuotaReservationTracker();
  const key5h = 'local::u@example.com::Gemini::5h';
  const keyWk = 'local::u@example.com::Gemini::weekly';
  const keyIdle = 'local::u@example.com::Claude & GPT::5h';

  let ts = T0;
  let u5 = 13.0;
  let uw = 18.0;
  let c5 = 18.0;
  let cw = 86.0;

  // Baseline + 8 clean steps at exact 0.6667 %/$ (5h) and 0.1667 %/$ (weekly)
  tracker.observeBucket({
    bucketKey: key5h,
    officialUsedPct: u5,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: ts,
    cycleCostUsd: c5,
    poolLastActivityMs: ts,
    nowMs: ts,
  });
  tracker.observeBucket({
    bucketKey: keyWk,
    officialUsedPct: uw,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: ts,
    cycleCostUsd: cw,
    poolLastActivityMs: ts,
    nowMs: ts,
  });
  tracker.observeBucket({
    bucketKey: keyIdle,
    officialUsedPct: 0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: ts,
    cycleCostUsd: 0,
    poolLastActivityMs: 0,
    nowMs: ts,
  });

  for (let i = 0; i < 8; i += 1) {
    ts += 15_000;
    const dc = 0.09;
    c5 += dc;
    cw += dc;
    u5 += dc * (2 / 3);
    uw += dc * (1 / 6);
    tracker.observeBucket({
      bucketKey: key5h,
      officialUsedPct: u5,
      resetTimeMs: RESET_5H,
      quotaFetchedAtMs: ts,
      cycleCostUsd: c5,
      poolLastActivityMs: ts,
      nowMs: ts,
    });
    tracker.observeBucket({
      bucketKey: keyWk,
      officialUsedPct: uw,
      resetTimeMs: RESET_WK,
      quotaFetchedAtMs: ts,
      cycleCostUsd: cw,
      poolLastActivityMs: ts,
      nowMs: ts,
    });
  }

  // Idle 0% pool resetTime drifts by 35 min -> silently absorbed (no spurious reset event)
  tracker.observeBucket({
    bucketKey: keyIdle,
    officialUsedPct: 0,
    resetTimeMs: RESET_5H + 35 * 60 * 1000,
    quotaFetchedAtMs: ts + 35 * 60 * 1000,
    cycleCostUsd: 0,
    poolLastActivityMs: 0,
    nowMs: ts,
  });
  assert.equal(
    tracker.getLogSnapshot().events.some((e) => e.pool === 'Claude & GPT' && e.event === 'reset'),
    false,
    'idle 0% pool drift must not emit reset'
  );

  // Weekly triggers a +0.9% lease on Cell B, then bounces Cell A <-> Cell B 5 times while 5h bounces +/-0.2%
  ts += 10_000;
  const wkBase = uw;
  const wkHigh = uw + 0.9;
  const rLease = tracker.observeBucket({
    bucketKey: keyWk,
    officialUsedPct: wkHigh,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: ts,
    cycleCostUsd: cw,
    poolLastActivityMs: ts,
    nowMs: ts,
  });
  assert.equal(rLease.reservedPct, 0.9);
  assert.equal(rLease.reservedLeaseCount, 1);

  for (let i = 0; i < 5; i += 1) {
    // Drop to Cell A (low replica)
    ts += 10_000;
    c5 += 0.06;
    cw += 0.06;
    const rLowWk = tracker.observeBucket({
      bucketKey: keyWk,
      officialUsedPct: wkBase + (i + 1) * 0.01,
      resetTimeMs: RESET_WK,
      quotaFetchedAtMs: ts,
      cycleCostUsd: cw,
      poolLastActivityMs: ts,
      nowMs: ts,
    });
    assert.equal(rLowWk.reservedPct, 0, 'low replica hides lease portion so actual stays stable');

    tracker.observeBucket({
      bucketKey: key5h,
      officialUsedPct: u5 - 0.2 + i * 0.04,
      resetTimeMs: RESET_5H,
      quotaFetchedAtMs: ts,
      cycleCostUsd: c5,
      poolLastActivityMs: ts,
      nowMs: ts,
    });

    // Bounce back to Cell B (high replica)
    ts += 10_000;
    c5 += 0.06;
    cw += 0.06;
    const rHighWk = tracker.observeBucket({
      bucketKey: keyWk,
      officialUsedPct: wkHigh + (i + 1) * 0.02,
      resetTimeMs: RESET_WK,
      quotaFetchedAtMs: ts,
      cycleCostUsd: cw,
      poolLastActivityMs: ts,
      nowMs: ts,
    });
    assert.equal(rHighWk.reservedPct, 0.9, 'rebound restores same lease without duplicating');
    assert.equal(rHighWk.reservedLeaseCount, 1);

    tracker.observeBucket({
      bucketKey: key5h,
      officialUsedPct: u5 + 0.08 + i * 0.08,
      resetTimeMs: RESET_5H,
      quotaFetchedAtMs: ts,
      cycleCostUsd: c5,
      poolLastActivityMs: ts,
      nowMs: ts,
    });
  }

  // Both rolling-median rates remain unpolluted near 0.6667 and 0.1667
  const snapMid = tracker.getLogSnapshot();
  const b5h = snapMid.buckets.find((b) => b.pool === 'Gemini' && b.win === '5h');
  const bWk = snapMid.buckets.find((b) => b.pool === 'Gemini' && b.win === 'weekly');
  assert.ok(Math.abs(b5h.ratePctPerUsd - 0.6667) < 0.02, `5h rate stays clean: ${b5h.ratePctPerUsd}`);
  assert.ok(Math.abs(bWk.ratePctPerUsd - 0.1667) < 0.01, `weekly rate stays clean: ${bWk.ratePctPerUsd}`);

  // Sustained drop on weekly (stays low across >= 3 samples and >= 90s while active) confirms genuine refund
  for (let i = 0; i < 4; i += 1) {
    ts += Math.ceil(QR_REFUND_CONFIRM_WINDOW_MS / 3);
    tracker.observeBucket({
      bucketKey: keyWk,
      officialUsedPct: wkBase + 0.1,
      resetTimeMs: RESET_WK,
      quotaFetchedAtMs: ts,
      cycleCostUsd: cw,
      poolLastActivityMs: ts,
      nowMs: ts,
    });
  }
  const bWkAfter = tracker.getLogSnapshot().buckets.find((b) => b.pool === 'Gemini' && b.win === 'weekly');
  assert.equal(bWkAfter.reservedPct, 0);
  assert.equal(bWkAfter.leases, 0);
});

test('quota-reservation: ignores sub-epsilon shortfall noise and drops polluted v1 EMA rate on schema upgrade', () => {
  // 1. Sub-epsilon rounding mismatch during normal spending must not keep stale leases alive
  const tracker = createQuotaReservationTracker();
  const key = 'local::u@example.com::Gemini::5h';
  tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 10.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: T0,
    cycleCostUsd: 15.0,
    poolLastActivityMs: T0,
    nowMs: T0,
  });
  // Trigger +1.0% lease at t1
  const t1 = T0 + 15_000;
  tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 11.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t1,
    cycleCostUsd: 15.0,
    poolLastActivityMs: t1,
    nowMs: t1,
  });
  // Normal steps at ~0.666 %/$ (0.001% below cold-start 0.667) across idle expiry window -> lease expires normally
  let u = 11.0;
  let c = 15.0;
  let now = t1;
  const stepMs = Math.ceil((QR_LEASE_IDLE_EXPIRY_MS + 60_000) / 12);
  for (let i = 0; i < 12; i += 1) {
    now += stepMs;
    c += 0.09;
    u += 0.059;
    tracker.observeBucket({
      bucketKey: key,
      officialUsedPct: u,
      resetTimeMs: RESET_5H,
      quotaFetchedAtMs: now,
      cycleCostUsd: c,
      poolLastActivityMs: now,
      nowMs: now,
    });
  }
  const snap = tracker.getLogSnapshot();
  assert.equal(snap.buckets[0].reservedPct, 0, 'normal billing does not infinitely renew stale lease');

  // 2. Loading v1 persisted payload resets polluted EMA rate while preserving event log
  const v1Payload = {
    version: 1,
    savedAt: new Date(T0).toISOString(),
    buckets: {
      [key]: {
        resetTimeMs: RESET_5H,
        lastQuotaTs: T0,
        lastOfficialUsedPct: 30.0,
        lastCycleCostUsd: 38.0,
        ratePctPerUsd: 2.005,
        rateSamples: 41,
        activeLeases: [],
      },
    },
    events: [{ ts: new Date(T0).toISOString(), pool: 'Gemini', win: '5h', event: 'normal' }],
  };
  const migrated = createQuotaReservationTracker({ loadState: () => v1Payload });
  const migSnap = migrated.getLogSnapshot();
  assert.equal(migSnap.count, 1, 'v1 events preserved on upgrade');
  assert.equal(migSnap.buckets[0].ratePctPerUsd, null, 'polluted v1 rate cleared for clean recalibration');
});

test('quota-reservation: buffers short reporting lag inside lease, survives 35m residency, and clears recovered pendingDrop', () => {
  const tracker = createQuotaReservationTracker();
  const key = 'local::u@example.com::Gemini::weekly';

  // Seed baseline at 0.5 %/$ (20% / $40)
  let ts = T0;
  tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 20.0,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: ts,
    cycleCostUsd: 40.0,
    poolLastActivityMs: ts,
    nowMs: ts,
  });

  // Trigger +0.8% lease
  ts += 10_000;
  const rLease = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 20.8,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: ts,
    cycleCostUsd: 40.0,
    poolLastActivityMs: ts,
    nowMs: ts,
  });
  assert.equal(rLease.reservedPct, 0.8);

  // Short 8s upstream reporting lag: dCost=$0.20 (exp=0.1%), dUsed=0 -> buffered, then next tick catches up +0.1%
  ts += 10_000;
  const rLag = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 20.8,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: ts,
    cycleCostUsd: 40.2,
    poolLastActivityMs: ts,
    nowMs: ts,
  });
  assert.equal(rLag.reservedPct, 0.8, 'first flat tick does not prematurely drain active lease');

  ts += 8_000;
  const rCatchUp = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 20.9,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: ts,
    cycleCostUsd: 40.2,
    poolLastActivityMs: ts,
    nowMs: ts,
  });
  assert.equal(rCatchUp.reservedPct, 0.8, 'catch-up tick keeps lease intact with zero false consume');

  // Lease stays alive past 35 minutes idle when official has not refunded yet, then clears on real refund
  const lastActTs = ts;
  ts += 35 * 60 * 1000;
  const rStillHeld = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 20.9,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: ts,
    cycleCostUsd: 40.2,
    poolLastActivityMs: lastActTs,
    nowMs: ts,
  });
  assert.equal(rStillHeld.reservedPct, 0.8, 'active lease survives 35m residency before upstream refund');

  ts += 10 * 60 * 1000;
  const rRefund = tracker.observeBucket({
    bucketKey: key,
    officialUsedPct: 20.1,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: ts,
    cycleCostUsd: 40.2,
    poolLastActivityMs: lastActTs,
    nowMs: ts,
  });
  assert.equal(rRefund.reservedPct, 0);
  assert.equal(rRefund.reservedLeaseCount, 0);

  // Small drop (-0.05%) recovered naturally by normal spending clears zombie pendingDrop,
  // so a subsequent +1.0% jump is cleanly recognized as a real lease
  const key5h = 'local::u@example.com::Gemini::5h';
  let t5 = T0;
  tracker.observeBucket({
    bucketKey: key5h,
    officialUsedPct: 20.0,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t5,
    cycleCostUsd: 10.0,
    poolLastActivityMs: t5,
    nowMs: t5,
  });
  t5 += 10_000;
  tracker.observeBucket({
    bucketKey: key5h,
    officialUsedPct: 19.95,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t5,
    cycleCostUsd: 10.05,
    poolLastActivityMs: t5,
    nowMs: t5,
  });
  t5 += 10_000;
  tracker.observeBucket({
    bucketKey: key5h,
    officialUsedPct: 20.05,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t5,
    cycleCostUsd: 10.1,
    poolLastActivityMs: t5,
    nowMs: t5,
  });
  t5 += 10_000;
  const rNewLease = tracker.observeBucket({
    bucketKey: key5h,
    officialUsedPct: 21.05,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: t5,
    cycleCostUsd: 10.1,
    poolLastActivityMs: t5,
    nowMs: t5,
  });
  assert.equal(rNewLease.reservedPct, 1.0, 'real +1.0% lease not swallowed by cleared pendingDrop');
  assert.equal(rNewLease.reservedLeaseCount, 1);
});

test('experimentalQuotaReservation setting defaults true and round-trips through schema & backup', () => {
  const def = normalizeFullSettings({});
  assert.equal(def.experimentalQuotaReservation, true);

  const disabled = normalizeFullSettings({ experimentalQuotaReservation: false });
  assert.equal(disabled.experimentalQuotaReservation, false);

  const enabled = normalizeFullSettings({ experimentalQuotaReservation: true });
  assert.equal(enabled.experimentalQuotaReservation, true);

  const json = buildExportableSettingsJson(enabled);
  const parsed = parseImportedSettingsJson(json);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.patch.experimentalQuotaReservation, true);

  const disabledJson = buildExportableSettingsJson(disabled);
  const disabledParsed = parseImportedSettingsJson(disabledJson);
  assert.equal(disabledParsed.ok, true);
  assert.equal(disabledParsed.patch.experimentalQuotaReservation, false);
});

test('backendHarness buildTelemetry populates reservedPct when local session is running and flags external_usage when idle', async () => {
  // 1. Idle machine (no local running conversation / no local cost): external jump must be classified as external_usage (0% reserved)
  let nowIdle = T0;
  const hIdle = backendHarness({
    clock: () => nowIdle,
    userStatus: { email: 'family-idle@example.com', userTier: { name: 'Google AI Ultra' } },
    quotaSummary: {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'gemini-5h',
              window: '5h',
              remainingFraction: 0.96,
              resetTime: new Date(RESET_5H).toISOString(),
            },
            {
              bucketId: 'gemini-weekly',
              window: 'weekly',
              remainingFraction: 0.85,
              resetTime: new Date(RESET_WK).toISOString(),
            },
          ],
        },
      ],
    },
  });

  const idleP1 = await hIdle.buildTelemetryPayloadInternal(null, true);
  const idleG1 = idleP1.quotas.pools.find((p) => p.poolKey === 'Gemini');
  assert.equal(idleP1.settings.experimentalQuotaReservation, true);
  assert.equal(idleG1.reservedPct, 0);
  assert.equal(idleG1.weeklyReservedPct, 0);
  assert.equal(idleG1.externalUsedPct, 4.0, 'idle baseline pre-existing 5h usage attributed to externalUsedPct');
  assert.equal(idleG1.weeklyExternalUsedPct, 15.0, 'idle baseline pre-existing weekly usage attributed to weeklyExternalUsedPct');

  nowIdle += 20_000;
  hIdle.state.quotaSummary = {
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          {
            bucketId: 'gemini-5h',
            window: '5h',
            remainingFraction: 0.95,
            resetTime: new Date(RESET_5H).toISOString(),
          },
          {
            bucketId: 'gemini-weekly',
            window: 'weekly',
            remainingFraction: 0.845,
            resetTime: new Date(RESET_WK).toISOString(),
          },
        ],
      },
    ],
  };

  const idleP2 = await hIdle.buildTelemetryPayloadInternal(null, true);
  const idleG2 = idleP2.quotas.pools.find((p) => p.poolKey === 'Gemini');
  assert.equal(idleG2.reservedPct, 0, 'idle external 5h jump must not create fake reservation');
  assert.equal(idleG2.weeklyReservedPct, 0, 'idle external weekly jump must not create fake reservation');
  assert.equal(idleG2.externalUsedPct, 5.0);
  assert.equal(idleG2.weeklyExternalUsedPct, 15.5);
  assert.equal(idleG2.rateEstimate?.externalUsage?.detected, true);
  assert.equal(idleG2.rateEstimate?.externalUsage?.activeRecently, true);
  assert.equal(idleG2.rateEstimate?.externalUsage?.used5hPct, 5.0);
  assert.equal(idleG2.rateEstimate?.externalUsage?.usedWeeklyPct, 15.5);

  const idleLogRes = await hIdle.dispatchBridgeApiRequest('/api/quota-reservation/log', 'GET');
  assert.equal(idleLogRes.status, 200);
  const idleLogJson = JSON.parse(idleLogRes.body);
  assert.ok(
    idleLogJson.events.some((e) => e.pool === 'Gemini' && e.win === '5h' && e.event === 'external_usage'),
    'idle 5h jump logged as external_usage'
  );

  // 2. Active local running Gemini conversation: same quota jump cleanly triggers local reservation leases
  let now = T0;
  const h = backendHarness({
    clock: () => now,
    userStatus: { email: 'tester@example.com', userTier: { name: 'Google AI Ultra' } },
    summaries: {
      'conv-local-gem': {
        summary: 'Local Gemini Session',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        stepCount: 1,
        createdTime: new Date(T0 - 15_000).toISOString(),
        lastModifiedTime: new Date(T0).toISOString(),
      },
    },
    trajectories: {
      'conv-local-gem': {
        trajectory: {
          generatorMetadata: [
            {
              stepIndices: [0],
              chatModel: {
                model: 'gemini-4-neon-xhigh',
                usage: {
                  inputTokens: 10000,
                  cacheReadTokens: 0,
                  outputTokens: 500,
                },
              },
            },
          ],
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              metadata: {
                createdAt: new Date(T0).toISOString(),
                generatorModel: 'gemini-4-neon-xhigh',
              },
            },
          ],
        },
      },
    },
    quotaSummary: {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'gemini-5h',
              window: '5h',
              remainingFraction: 0.96,
              resetTime: new Date(RESET_5H).toISOString(),
            },
            {
              bucketId: 'gemini-weekly',
              window: 'weekly',
              remainingFraction: 0.85,
              resetTime: new Date(RESET_WK).toISOString(),
            },
          ],
        },
      ],
    },
  });

  const p1 = await h.buildTelemetryPayloadInternal(null, true);
  const g1 = p1.quotas.pools.find((p) => p.poolKey === 'Gemini');
  assert.equal(g1.reservedPct, 0);
  assert.equal(g1.weeklyReservedPct, 0);

  now += 20_000;
  h.state.quotaSummary = {
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          {
            bucketId: 'gemini-5h',
            window: '5h',
            remainingFraction: 0.95,
            resetTime: new Date(RESET_5H).toISOString(),
          },
          {
            bucketId: 'gemini-weekly',
            window: 'weekly',
            remainingFraction: 0.845,
            resetTime: new Date(RESET_WK).toISOString(),
          },
        ],
      },
    ],
  };

  const p2 = await h.buildTelemetryPayloadInternal(null, true);
  const g2 = p2.quotas.pools.find((p) => p.poolKey === 'Gemini');
  assert.equal(g2.reservedPct, 1.0);
  assert.equal(g2.weeklyReservedPct, 0.5);

  const logRes = await h.dispatchBridgeApiRequest('/api/quota-reservation/log', 'GET');
  assert.equal(logRes.status, 200);
  const logJson = JSON.parse(logRes.body);
  assert.equal(logJson.ok, true);
  assert.ok(logJson.count >= 4, 'baseline + lease events recorded in ring buffer');
  assert.ok(
    logJson.events.some((e) => e.pool === 'Gemini' && e.win === '5h' && e.event === 'lease'),
    '5h lease jump logged'
  );
  assert.ok(
    logJson.events.some((e) => e.pool === 'Gemini' && e.win === 'weekly' && e.event === 'lease'),
    'weekly lease jump logged'
  );
});

test('QuotaPoolsWidget & SettingsOtherTab render experimental reservation bar/text and toggle', async () => {
  const { document } = createMockDom();
  const origDocument = globalThis.document;
  const origWindow = globalThis.window;
  const origFetch = globalThis.fetch;
  const origNavigator = globalThis.navigator;
  let copiedClipboardText = '';
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        async writeText(text) {
          copiedClipboardText = String(text);
        },
      },
    },
  });
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 960,
    innerHeight: 720,
    addEventListener() {},
    removeEventListener() {},
    location: { origin: 'http://127.0.0.1:0', href: 'http://127.0.0.1:0/' },
  };
  const savedPatches = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('/api/quota-reservation/log')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          generatedAt: '2026-11-22T09:20:00.000Z',
          count: 1,
          buckets: [{ pool: 'Gemini', win: '5h', usedPct: 4.1, reservedPct: 1, leases: 1 }],
          events: [
            {
              ts: '2026-11-22T09:19:50.000Z',
              pool: 'Gemini',
              win: '5h',
              event: 'lease',
              usedPct: 4.1,
              dUsed: 1,
              rsvPct: 1,
              leases: 1,
            },
          ],
        }),
      };
    }
    if (String(url).includes('/api/settings') && opts.method === 'POST') {
      const patch = JSON.parse(opts.body);
      savedPatches.push(patch);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, settings: patch }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  try {
    const [{ setI18nLanguage }, { QuotaPoolsWidget }, { SettingsOtherTab }] = await Promise.all([
      import('../src/i18n/index.js'),
      import('../src/components/widgets/QuotaPoolsWidget.js'),
      import('../src/views/settings/SettingsOtherTab.js'),
    ]);
    setI18nLanguage('zh-CN');

    const widget = QuotaPoolsWidget();
    const baseData = {
      settings: { experimentalQuotaReservation: false },
      account: { tierName: 'Google AI Ultra', planName: 'Pro' },
      quotas: {
        pools: [
          {
            poolKey: 'Gemini',
            poolLabel: 'Gemini',
            family: 'Gemini',
            usedPct: 4.1,
            remainingPct: 95.9,
            reservedPct: 1.0,
            reservedLeaseCount: 1,
            resetTime: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
            weeklyUsedPct: 16.2,
            weeklyRemainingPct: 83.8,
            weeklyReservedPct: 0.5,
            weeklyReservedLeaseCount: 1,
            weeklyResetTime: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
          },
        ],
        weekly: { isOfficial: true },
      },
    };

    // Default (omitted setting): enabled by default
    widget.refs.update({
      data: { ...baseData, settings: {} },
      minuteTick: 1,
    });
    const legendEl = widget.el.querySelector('.quota-reserve-legend');
    assert.ok(legendEl, 'quota reservation legend mounted');
    assert.equal(legendEl.hidden, false);

    // Toggle OFF: no reserved highlight, legend hidden, compact reset + used text only
    widget.refs.update({ data: baseData, minuteTick: 1 });
    assert.equal(legendEl.hidden, true);
    const metasOff = widget.el.querySelectorAll('.quota-win-meta');
    assert.equal(metasOff.length, 2);
    assert.match(metasOff[0].textContent, /· 已用 4\.1%$/);
    assert.doesNotMatch(metasOff[0].textContent, /[()（）]|预占|余/);
    assert.match(metasOff[1].textContent, /· 已用 16\.2%$/);
    assert.doesNotMatch(metasOff[1].textContent, /[()（）]|预占|余/);
    const fillBarsOff = widget.el.querySelectorAll('.progress-fill');
    assert.equal(fillBarsOff[0].style.getPropertyValue('--fill-w'), '4.1%');

    // Toggle ON: violet reserved bar segment + hover tooltip + bottom solid/dashed legend, without parenthetical inline text
    widget.refs.update({
      data: { ...baseData, settings: { experimentalQuotaReservation: true } },
      minuteTick: 1,
    });
    assert.equal(legendEl.hidden, false);
    assert.ok(legendEl.querySelector('.quota-legend-line.is-actual'));
    assert.ok(legendEl.querySelector('.quota-legend-line.is-reserved'));
    assert.match(legendEl.textContent, /实占/);
    assert.match(legendEl.textContent, /预占/);
    const metasOn = widget.el.querySelectorAll('.quota-win-meta');
    assert.match(metasOn[0].textContent, /· 已用 4\.1%$/);
    assert.doesNotMatch(metasOn[0].textContent, /[()（）]|预占|余/);
    assert.match(metasOn[0].getAttribute('title') || '', /1\.0%/);
    assert.match(metasOn[1].textContent, /· 已用 16\.2%$/);
    assert.doesNotMatch(metasOn[1].textContent, /[()（）]|预占|余/);
    assert.match(metasOn[1].getAttribute('title') || '', /0\.5%/);

    const fillBarsOn = widget.el.querySelectorAll('.progress-fill');
    const rsvBarsOn = widget.el.querySelectorAll('.progress-fill-reserved');
    assert.equal(fillBarsOn[0].style.getPropertyValue('--fill-w'), '3.1%');
    assert.equal(rsvBarsOn[0].style.getPropertyValue('--reserved-w'), '1%');
    assert.equal(rsvBarsOn[0].classList.contains('is-active'), true);
    assert.equal(rsvBarsOn[0].classList.contains('has-sep'), true);
    assert.equal(fillBarsOn[1].style.getPropertyValue('--fill-w'), '15.7%');
    assert.equal(rsvBarsOn[1].style.getPropertyValue('--reserved-w'), '0.5%');
    assert.equal(rsvBarsOn[1].classList.contains('has-sep'), true);

    // SettingsOtherTab renders experimental badge and persists toggle click
    const othTab = SettingsOtherTab({ onLayoutChange: () => {} });
    othTab.refs.renderSettings({ experimentalQuotaReservation: false }, []);
    const badge = othTab.el.querySelector('.settings-experimental-badge');
    assert.ok(badge, 'experimental badge rendered');
    assert.equal(badge.textContent, '试验性');

    const toggleBtns = othTab.refs.quotaReserveToggle.el.querySelectorAll('.seg-btn');
    assert.equal(toggleBtns.length, 2);
    toggleBtns[0].dispatchEvent({
      type: 'click',
      stopPropagation() {},
      preventDefault() {},
    });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(
      savedPatches.some((p) => p.experimentalQuotaReservation === true),
      true,
      'clicking 开启 saves experimentalQuotaReservation: true'
    );

    othTab.refs.exportReserveLogBtn.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 25));
    const copiedObj = JSON.parse(copiedClipboardText);
    assert.equal(copiedObj.count, 1);
    assert.equal(copiedObj.events[0].event, 'lease');
    assert.equal(copiedObj.events[0].pool, 'Gemini');

    othTab.destroy();
    widget.destroy();
  } finally {
    globalThis.fetch = origFetch;
    globalThis.document = origDocument;
    globalThis.window = origWindow;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: origNavigator,
    });
  }
});

test('quota-reservation: learns per-model burn rates & 3x/1x multipliers with strict account isolation and persistence', () => {
  let storedPayload = null;
  const tracker = createQuotaReservationTracker({
    loadState: () => storedPayload,
    saveState: (payload) => {
      storedPayload = JSON.parse(JSON.stringify(payload));
    },
  });

  const makePools = (used5h, usedWk) =>
    new Map([
      [
        'Gemini',
        {
          poolKey: 'Gemini',
          has5h: true,
          hasWeekly: true,
          remainingFraction: 1 - used5h / 100,
          usedPct: used5h,
          resetTime: new Date(RESET_5H).toISOString(),
          weeklyRemainingFraction: 1 - usedWk / 100,
          weeklyUsedPct: usedWk,
          weeklyResetTime: new Date(RESET_WK).toISOString(),
        },
      ],
    ]);

  const makeStats = (cost5h, costWk, modelCosts5h, modelCostsWeekly, ts) =>
    new Map([
      [
        'Gemini',
        {
          cycle5h: { costUsd: cost5h, unpricedCalls: 0 },
          cycleWeekly: { costUsd: costWk, unpricedCalls: 0 },
          exactCost5hUsd: cost5h,
          exactCostWeeklyUsd: costWk,
          modelCosts5h,
          modelCostsWeekly,
          recent10m: { lastActivityMs: ts, activeSessionCount: 1, costUsd: 0.1 },
        },
      ],
    ]);

  let ts = T0;
  let u5 = 10.0;
  let uw = 20.0;
  let carbonCost = 1.0;
  let neonCost = 0.0;

  // Baseline for Account A
  const p0 = makePools(u5, uw);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'alice@example.com',
    quotaPoolsMap: p0,
    poolCycleStats: makeStats(
      carbonCost,
      carbonCost,
      { 'Gemini 4 Carbon': carbonCost },
      { 'Gemini 4 Carbon': carbonCost },
      ts
    ),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(p0.get('Gemini').rateEstimate, null);

  // 3 clean single-model steps on Carbon: 2.0 %/$ (5h), 0.5 %/$ (weekly)
  let latestPool = null;
  for (let i = 0; i < 3; i += 1) {
    ts += 15_000;
    carbonCost = +(carbonCost + 0.1).toFixed(6);
    u5 = +(u5 + 0.2).toFixed(6);
    uw = +(uw + 0.05).toFixed(6);
    latestPool = makePools(u5, uw);
    tracker.updatePools({
      endpointId: 'local',
      accountScope: 'alice@example.com',
      quotaPoolsMap: latestPool,
      poolCycleStats: makeStats(
        carbonCost,
        carbonCost,
        { 'Gemini 4 Carbon': carbonCost },
        { 'Gemini 4 Carbon': carbonCost },
        ts
      ),
      quotaFetchedAtMs: ts,
      nowMs: ts,
    });
  }

  const estCarbonOnly = latestPool.get('Gemini').rateEstimate;
  assert.ok(estCarbonOnly, 'rateEstimate appears once 3 clean single-model steps are recorded');
  assert.equal(estCarbonOnly.models.length, 1);
  assert.equal(estCarbonOnly.models[0].model, 'Gemini 4 Carbon');
  assert.equal(estCarbonOnly.models[0].rate5hPctPerUsd, 2);
  assert.equal(estCarbonOnly.models[0].rateWeeklyPctPerUsd, 0.5);
  assert.equal(estCarbonOnly.models[0].eqFull5hUsd, 50);
  assert.equal(estCarbonOnly.models[0].eqFullWeeklyUsd, 200);
  assert.equal(estCarbonOnly.models[0].multiplier, null, 'single model does not emit relative multiplier');
  assert.equal(estCarbonOnly.models[0].samples, 3);

  // 3 clean single-model steps on Neon: 0.6667 %/$ (5h), 0.1667 %/$ (weekly) -> 1:3 relative ratio
  for (let i = 0; i < 3; i += 1) {
    ts += 15_000;
    neonCost = +(neonCost + 0.15).toFixed(6);
    u5 = +(u5 + 0.1).toFixed(6);
    uw = +(uw + 0.025).toFixed(6);
    latestPool = makePools(u5, uw);
    tracker.updatePools({
      endpointId: 'local',
      accountScope: 'alice@example.com',
      quotaPoolsMap: latestPool,
      poolCycleStats: makeStats(
        carbonCost + neonCost,
        carbonCost + neonCost,
        { 'Gemini 4 Carbon': carbonCost, 'Gemini 4 Neon': neonCost },
        { 'Gemini 4 Carbon': carbonCost, 'Gemini 4 Neon': neonCost },
        ts
      ),
      quotaFetchedAtMs: ts,
      nowMs: ts,
    });
  }

  const estDual = latestPool.get('Gemini').rateEstimate;
  assert.equal(estDual.models.length, 2);
  assert.equal(estDual.models[0].model, 'Gemini 4 Carbon');
  assert.equal(estDual.models[0].multiplier, 3);
  assert.equal(estDual.models[0].eqFull5hUsd, 50);
  assert.equal(estDual.models[0].eqFullWeeklyUsd, 200);
  assert.equal(estDual.models[1].model, 'Gemini 4 Neon');
  assert.equal(estDual.models[1].multiplier, 1);
  assert.equal(estDual.models[1].eqFull5hUsd, 150);
  assert.equal(estDual.models[1].eqFullWeeklyUsd, 600);

  // Mixed-model step ($0.10 Carbon + $0.15 Neon -> +0.30% 5h, +0.075% weekly):
  // weighted expected matches official (no false lease) and does not pollute per-model sample counts
  ts += 15_000;
  carbonCost = +(carbonCost + 0.1).toFixed(6);
  neonCost = +(neonCost + 0.15).toFixed(6);
  u5 = +(u5 + 0.3).toFixed(6);
  uw = +(uw + 0.075).toFixed(6);
  const pMixed = makePools(u5, uw);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'alice@example.com',
    quotaPoolsMap: pMixed,
    poolCycleStats: makeStats(
      carbonCost + neonCost,
      carbonCost + neonCost,
      { 'Gemini 4 Carbon': carbonCost, 'Gemini 4 Neon': neonCost },
      { 'Gemini 4 Carbon': carbonCost, 'Gemini 4 Neon': neonCost },
      ts
    ),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(pMixed.get('Gemini').reservedPct, 0);
  assert.equal(pMixed.get('Gemini').rateEstimate.models[0].samples, 3);
  assert.equal(pMixed.get('Gemini').rateEstimate.models[1].samples, 3);

  // Strict account isolation: Account B sees null (no cross-account leakage);
  // case-insensitive Account A lookup still sees its own calibrated estimates
  ts += 15_000;
  const pBob = makePools(5.0, 10.0);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'bob@example.com',
    quotaPoolsMap: pBob,
    poolCycleStats: makeStats(0.5, 0.5, { 'Gemini 4 Carbon': 0.5 }, { 'Gemini 4 Carbon': 0.5 }, ts),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(pBob.get('Gemini').rateEstimate, null, 'other account must not inherit Alice rates');

  // Force a persist tick past QR_PERSIST_MIN_INTERVAL_MS and test reload across restart
  ts += 40_000;
  carbonCost = +(carbonCost + 0.1).toFixed(6);
  u5 = +(u5 + 0.2).toFixed(6);
  uw = +(uw + 0.05).toFixed(6);
  const pAliceCase = makePools(u5, uw);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'ALICE@EXAMPLE.COM',
    quotaPoolsMap: pAliceCase,
    poolCycleStats: makeStats(
      carbonCost + neonCost,
      carbonCost + neonCost,
      { 'Gemini 4 Carbon': carbonCost, 'Gemini 4 Neon': neonCost },
      { 'Gemini 4 Carbon': carbonCost, 'Gemini 4 Neon': neonCost },
      ts
    ),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(pAliceCase.get('Gemini').rateEstimate.models[0].samples, 4);

  const reloaded = createQuotaReservationTracker({ loadState: () => storedPayload });
  const pReloadAlice = makePools(u5, uw);
  reloaded.updatePools({
    endpointId: 'local',
    accountScope: 'alice@example.com',
    quotaPoolsMap: pReloadAlice,
    poolCycleStats: makeStats(
      carbonCost + neonCost,
      carbonCost + neonCost,
      { 'Gemini 4 Carbon': carbonCost, 'Gemini 4 Neon': neonCost },
      { 'Gemini 4 Carbon': carbonCost, 'Gemini 4 Neon': neonCost },
      ts
    ),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(pReloadAlice.get('Gemini').rateEstimate.models.length, 2);
  assert.equal(pReloadAlice.get('Gemini').rateEstimate.models[0].multiplier, 3);
  assert.equal(pReloadAlice.get('Gemini').rateEstimate.models[1].multiplier, 1);

  const snap = reloaded.getLogSnapshot();
  const alice5h = snap.buckets.find((b) => b.pool === 'Gemini' && b.win === '5h' && b.byModel);
  assert.ok(alice5h?.byModel?.['Gemini 4 Carbon'], 'snapshot exposes per-model summary');
  assert.equal(alice5h.byModel['Gemini 4 Carbon'].eqFullUsd, 50);

  const pReloadBob = makePools(5.0, 10.0);
  reloaded.updatePools({
    endpointId: 'local',
    accountScope: 'bob@example.com',
    quotaPoolsMap: pReloadBob,
    poolCycleStats: makeStats(0.5, 0.5, { 'Gemini 4 Carbon': 0.5 }, { 'Gemini 4 Carbon': 0.5 }, ts),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(pReloadBob.get('Gemini').rateEstimate, null, 'account isolation preserved after restart');

  // Legacy v2 persisted bucket missing lastModelCostsUsd must not pollute modelRates on first upgrade tick
  const legacyV2 = createQuotaReservationTracker({
    loadState: () => ({
      version: 2,
      savedAt: new Date(T0).toISOString(),
      buckets: {
        'local::legacy@example.com::Gemini::5h': {
          resetTimeMs: RESET_5H,
          lastQuotaTs: T0,
          lastOfficialUsedPct: 12.0,
          lastCycleCostUsd: 18.0,
          ratePctPerUsd: 0.6667,
          rateSamples: 10,
          rateWindow: [0.6667, 0.6667, 0.6667],
          activeLeases: [],
        },
      },
      events: [],
    }),
  });
  const tUp = T0 + 15_000;
  const pUp = makePools(12.2, 20.0);
  legacyV2.updatePools({
    endpointId: 'local',
    accountScope: 'legacy@example.com',
    quotaPoolsMap: pUp,
    poolCycleStats: makeStats(18.1, 18.1, { 'Gemini 4 Carbon': 18.1 }, { 'Gemini 4 Carbon': 18.1 }, tUp),
    quotaFetchedAtMs: tUp,
    nowMs: tUp,
  });
  const legacySt = legacyV2._buckets.get('local::legacy@example.com::Gemini::5h');
  assert.deepEqual(legacySt.modelRates, {}, 'first upgrade tick backfills baseline without recording polluted cumulative delta');
  assert.equal(legacySt.lastModelCostsUsd['Gemini 4 Carbon'], 18.1);
});

test('QuotaPoolsWidget renders circle-? hover popover for account-isolated model burn rates', async () => {
  const { document } = createMockDom();
  const origDocument = globalThis.document;
  const origWindow = globalThis.window;
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 960,
    innerHeight: 720,
    addEventListener() {},
    removeEventListener() {},
    location: { origin: 'http://127.0.0.1:0', href: 'http://127.0.0.1:0/' },
  };

  try {
    const [{ setI18nLanguage }, { QuotaPoolsWidget, maskAccountLabel }] = await Promise.all([
      import('../src/i18n/index.js'),
      import('../src/components/widgets/QuotaPoolsWidget.js'),
    ]);
    setI18nLanguage('zh-CN');

    // Account privacy masking
    assert.equal(maskAccountLabel('sjee80343@gmail.com'), 'sj***43@gmail.com');
    assert.equal(maskAccountLabel('alice@example.com'), 'al***ce@example.com');
    assert.equal(maskAccountLabel('bob@example.com'), 'b***b@example.com');
    assert.equal(maskAccountLabel('ab@example.com'), 'a*@example.com');
    assert.equal(maskAccountLabel('Tester'), 'Te***r');
    assert.equal(maskAccountLabel(''), '');

    const widget = QuotaPoolsWidget();
    const helpBtn = widget.refs.rateHelpBtn;
    const popover = widget.refs.ratePopoverEl;
    assert.ok(helpBtn, 'circle-? help button mounted');
    assert.ok(popover, 'rate popover mounted');
    assert.equal(popover.hidden, true);
    assert.equal(helpBtn.getAttribute('aria-expanded'), 'false');

    // Hover opens empty collecting hint before samples accumulate
    helpBtn.dispatchEvent({ type: 'mouseenter' });
    assert.equal(popover.hidden, false);
    assert.equal(helpBtn.getAttribute('aria-expanded'), 'true');
    assert.match(popover.textContent, /暂未采集到足够的单模型干净样本/);

    // Populated multi-model rateEstimate for current account
    const dualData = {
      account: { email: 'sjee80343@gmail.com', tierName: 'Google AI Ultra', tierMultiplier: '5x' },
      quotas: {
        pools: [
          {
            poolKey: 'Gemini',
            poolLabel: 'Gemini',
            family: 'Gemini',
            usedPct: 30,
            remainingPct: 70,
            weeklyUsedPct: 37,
            weeklyRemainingPct: 63,
            rateEstimate: {
              rate5hPctPerUsd: 2,
              rateWeeklyPctPerUsd: 0.5,
              eqFull5hUsd: 50,
              eqFullWeeklyUsd: 200,
              samples5h: 26,
              samplesWeekly: 32,
              models: [
                {
                  model: 'Gemini 4 Carbon',
                  rate5hPctPerUsd: 2,
                  rateWeeklyPctPerUsd: 0.5,
                  eqFull5hUsd: 50,
                  eqFullWeeklyUsd: 200,
                  multiplier: 3,
                  samples: 26,
                },
                {
                  model: 'Gemini 4 Neon',
                  rate5hPctPerUsd: 0.6667,
                  rateWeeklyPctPerUsd: 0.1667,
                  eqFull5hUsd: 150,
                  eqFullWeeklyUsd: 600,
                  multiplier: 1,
                  samples: 12,
                },
              ],
            },
          },
        ],
        weekly: { isOfficial: true },
      },
    };
    widget.refs.update({ data: dualData, minuteTick: 1 });
    const acctPill = popover.querySelector('.quota-rate-pop-account');
    assert.equal(acctPill.textContent, 'sj***43@gmail.com');
    assert.equal(acctPill.getAttribute('title'), 'sj***43@gmail.com');
    assert.equal(popover.textContent.includes('sjee80343'), false, 'raw email never leaks in popover');
    const rows = popover.querySelectorAll('.quota-rate-model-row');
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent, /Gemini 4 Carbon/);
    assert.match(rows[0].textContent, /3x/);
    assert.match(rows[0].textContent, /5h≈ \$50/);
    assert.match(rows[0].textContent, /周限≈ \$200/);
    assert.match(rows[0].textContent, /5h 2%\/\$ · 26 样本/);
    assert.equal(rows[0].querySelector('.quota-rate-mult-badge').classList.contains('is-high'), true);
    assert.equal(rows[0].querySelector('.quota-rate-eq-grid').classList.contains('is-single'), false);

    assert.match(rows[1].textContent, /Gemini 4 Neon/);
    assert.match(rows[1].textContent, /1x/);
    assert.match(rows[1].textContent, /5h≈ \$150/);
    assert.match(rows[1].textContent, /周限≈ \$600/);
    assert.match(rows[1].textContent, /5h 0\.67%\/\$ · 12 样本/);
    assert.equal(rows[1].querySelector('.quota-rate-mult-badge').classList.contains('is-high'), false);

    // Switching to another account with pool-average-only fallback refreshes popover cleanly
    widget.refs.update({
      data: {
        account: { email: 'bob@example.com', tierName: 'Google AI Pro' },
        quotas: {
          pools: [
            {
              poolKey: 'Argon',
              poolLabel: 'Gemini 4 Argon',
              family: 'Argon',
              weeklyUsedPct: 40,
              weeklyRemainingPct: 60,
              rateEstimate: {
                rate5hPctPerUsd: null,
                rateWeeklyPctPerUsd: 0.5,
                eqFull5hUsd: null,
                eqFullWeeklyUsd: 200,
                samples5h: 0,
                samplesWeekly: 8,
                models: [],
              },
            },
          ],
          weekly: { isOfficial: true },
        },
      },
      minuteTick: 2,
    });
    assert.equal(acctPill.textContent, 'b***b@example.com');
    const fallbackRow = popover.querySelector('.quota-rate-model-row.is-fallback');
    assert.ok(fallbackRow, 'renders pool-average fallback before per-model reaches 3 samples');
    assert.match(fallbackRow.textContent, /池综合均值/);
    assert.match(fallbackRow.textContent, /周限≈ \$200/);
    assert.match(fallbackRow.textContent, /周限 0\.5%\/\$ · 8 样本/);
    assert.equal(fallbackRow.querySelector('.quota-rate-eq-grid').classList.contains('is-single'), true);

    // Locale switch renders English copy
    setI18nLanguage('en-US');
    widget.refs.update({ data: dualData, minuteTick: 3 });
    assert.match(popover.textContent, /Estimated Burn Rates/);
    assert.equal(acctPill.textContent, 'sj***43@gmail.com');
    assert.match(popover.textContent, /5h≈ \$50/);
    assert.match(popover.textContent, /Weekly≈ \$200/);

    // Escape closes popover; click toggles open/close; mouseleave closes after grace delay
    helpBtn.dispatchEvent({ type: 'keydown', key: 'Escape', stopPropagation() {} });
    assert.equal(popover.hidden, true);
    helpBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
    assert.equal(popover.hidden, false);
    helpBtn.dispatchEvent({ type: 'mouseleave' });
    popover.dispatchEvent({ type: 'mouseenter' });
    await new Promise((r) => setTimeout(r, 160));
    assert.equal(popover.hidden, false, 'moving pointer into popover cancels close');
    popover.dispatchEvent({ type: 'mouseleave' });
    await new Promise((r) => setTimeout(r, 170));
    assert.equal(popover.hidden, true, 'leaving popover closes after grace delay');

    widget.destroy();
  } finally {
    globalThis.document = origDocument;
    globalThis.window = origWindow;
  }
});

test('quota-reservation: 3-layer family-group defense blocks idle/proportional jumps, promotes corroborated tentative leases, and evicts unbacked ghost leases', () => {
  const tracker = createQuotaReservationTracker();

  const makePools = (used5h, usedWk) =>
    new Map([
      [
        'Gemini',
        {
          poolKey: 'Gemini',
          has5h: true,
          hasWeekly: true,
          remainingFraction: 1 - used5h / 100,
          usedPct: used5h,
          resetTime: new Date(RESET_5H).toISOString(),
          weeklyRemainingFraction: 1 - usedWk / 100,
          weeklyUsedPct: usedWk,
          weeklyResetTime: new Date(RESET_WK).toISOString(),
        },
      ],
    ]);

  const makeStats = (cost5h, costWk, lastActivityMs, sess10m = 1) =>
    new Map([
      [
        'Gemini',
        {
          cycle5h: { costUsd: cost5h, unpricedCalls: 0 },
          cycleWeekly: { costUsd: costWk, unpricedCalls: 0 },
          exactCost5hUsd: cost5h,
          exactCostWeeklyUsd: costWk,
          recent10m: { lastActivityMs, activeSessionCount: sess10m, costUsd: sess10m > 0 ? 0.2 : 0 },
        },
      ],
    ]);

  // 1. Cold-start baseline where family already spent 18% (5h) & 30% (weekly) while local spent $0:
  // must mark hasExternalUsage without poisoning ratePctPerUsd
  let ts = T0;
  let u5 = 18.0;
  let uw = 30.0;
  let c5 = 0;
  let cw = 0;
  const pBase = makePools(u5, uw);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'family@example.com',
    quotaPoolsMap: pBase,
    poolCycleStats: makeStats(c5, cw, 0, 0),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(pBase.get('Gemini').reservedPct, 0);
  assert.equal(pBase.get('Gemini').externalUsedPct, 18.0);
  assert.equal(pBase.get('Gemini').weeklyExternalUsedPct, 30.0);
  assert.equal(pBase.get('Gemini').rateEstimate?.externalUsage?.detected, true);
  assert.equal(pBase.get('Gemini').rateEstimate?.externalUsage?.activeRecently, false);
  const st5h = tracker._buckets.get('local::family@example.com::Gemini::5h');
  assert.equal(st5h.ratePctPerUsd, null, 'family cold-start must not fabricate inflated safeUsed/safeCost rate');

  // 2. Calibrate real local burn rates cleanly via 3 single-step turns: 5h = 2.0 %/$, weekly = 0.5 %/$
  for (let i = 0; i < 3; i += 1) {
    ts += 20_000;
    c5 = +(c5 + 0.1).toFixed(4);
    cw = +(cw + 0.1).toFixed(4);
    u5 = +(u5 + 0.2).toFixed(4);
    uw = +(uw + 0.05).toFixed(4);
    const pCal = makePools(u5, uw);
    tracker.updatePools({
      endpointId: 'local',
      accountScope: 'family@example.com',
      quotaPoolsMap: pCal,
      poolCycleStats: makeStats(c5, cw, ts, 1),
      runningPoolKeys: new Set(['Gemini']),
      quotaFetchedAtMs: ts,
      nowMs: ts,
    });
    assert.equal(pCal.get('Gemini').reservedPct, 0);
  }
  assert.ok(Math.abs(st5h.ratePctPerUsd - 2.0) < 0.05);

  // 3. Layer 1 (Local-Activity Gate): local goes idle for 5 min (or uses Claude only) while family burns +1.2% 5h & +0.3% weekly
  const lastLocalAct = ts;
  ts += 5 * 60 * 1000;
  u5 = +(u5 + 1.2).toFixed(4);
  uw = +(uw + 0.3).toFixed(4);
  const pIdleExt = makePools(u5, uw);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'family@example.com',
    quotaPoolsMap: pIdleExt,
    poolCycleStats: makeStats(c5, cw, lastLocalAct, 0),
    runningPoolKeys: new Set(['Claude & GPT']),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(pIdleExt.get('Gemini').reservedPct, 0, 'idle Gemini jump while running Claude is external_usage');
  assert.equal(pIdleExt.get('Gemini').weeklyReservedPct, 0);
  assert.equal(pIdleExt.get('Gemini').externalUsedPct, 19.2);
  assert.equal(pIdleExt.get('Gemini').weeklyExternalUsedPct, 30.3);
  assert.equal(pIdleExt.get('Gemini').rateEstimate?.externalUsage?.activeRecently, true);
  assert.equal(pIdleExt.get('Gemini').rateEstimate?.externalUsage?.used5hPct, 19.2);
  assert.equal(pIdleExt.get('Gemini').rateEstimate?.externalUsage?.usedWeeklyPct, 30.3);

  // 4. Layer 2 (5h/weekly proportional co-movement): local IS active ($0.05 step -> exp 0.10% / 0.025%),
  // AND family member simultaneously spends $0.60 (+1.20% 5h, +0.30% weekly) on the same snapshot
  ts += 30_000;
  c5 = +(c5 + 0.05).toFixed(4);
  cw = +(cw + 0.05).toFixed(4);
  u5 = +(u5 + 1.3).toFixed(4);
  uw = +(uw + 0.325).toFixed(4);
  const pCoMove = makePools(u5, uw);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'family@example.com',
    quotaPoolsMap: pCoMove,
    poolCycleStats: makeStats(c5, cw, ts, 1),
    runningPoolKeys: new Set(['Gemini']),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(pCoMove.get('Gemini').reservedPct, 0, 'proportional 5h+weekly jump blocked as external_usage');
  assert.equal(pCoMove.get('Gemini').weeklyReservedPct, 0);
  assert.equal(pCoMove.get('Gemini').externalUsedPct, 20.4);
  assert.equal(pCoMove.get('Gemini').weeklyExternalUsedPct, 30.6);
  assert.equal(pCoMove.get('Gemini').rateEstimate?.externalUsage?.used5hPct, 20.4);

  // 5. Layer 3a (Shared-active tentative lease -> corroborated promotion on consume):
  // External usage was seen 30s ago -> a genuine staggered 5h +1.0% lease stays hidden (tentative) first
  ts += 20_000;
  c5 = +(c5 + 0.05).toFixed(4);
  cw = +(cw + 0.05).toFixed(4);
  u5 = +(u5 + 1.1).toFixed(4); // excess 1.0% on 5h only
  uw = +(uw + 0.025).toFixed(4); // normal 1:1 on weekly
  const pTent = makePools(u5, uw);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'family@example.com',
    quotaPoolsMap: pTent,
    poolCycleStats: makeStats(c5, cw, ts, 1),
    runningPoolKeys: new Set(['Gemini']),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(pTent.get('Gemini').reservedPct, 0, 'shared-active new lease stays tentative/hidden until corroborated');

  // Next local spend ($0.15 -> exp 0.30%) is absorbed with flat official (consume past lag grace) -> promotes tentative lease!
  ts += 15_000;
  c5 = +(c5 + 0.15).toFixed(4);
  cw = +(cw + 0.15).toFixed(4);
  uw = +(uw + 0.075).toFixed(4);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'family@example.com',
    quotaPoolsMap: makePools(u5, uw),
    poolCycleStats: makeStats(c5, cw, ts, 1),
    runningPoolKeys: new Set(['Gemini']),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  ts += QR_CONSUME_LAG_GRACE_MS + 1_000;
  const pPromoted = makePools(u5, uw);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'family@example.com',
    quotaPoolsMap: pPromoted,
    poolCycleStats: makeStats(c5, cw, ts, 1),
    runningPoolKeys: new Set(['Gemini']),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(pPromoted.get('Gemini').reservedPct, 0.7, 'corroborated tentative lease promotes cleanly (1.0% - 0.3% = 0.7%)');

  // 6. Layer 3b (Unbacked single-session ghost lease fast eviction on a fresh solo-looking account):
  const soloTracker = createQuotaReservationTracker();
  const sKey = 'local::overlap@example.com::Gemini::5h';
  let stTs = T0;
  let su = 10.0;
  let sc = 5.0; // calibrated 2.0 %/$
  soloTracker.observeBucket({
    bucketKey: sKey,
    officialUsedPct: su,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: stTs,
    cycleCostUsd: sc,
    poolLastActivityMs: stTs,
    activeSessionCount10m: 1,
    nowMs: stTs,
  });
  // Unseen family burst overlaps single local turn -> creates unconfirmed +0.8% lease
  stTs += 15_000;
  sc = +(sc + 0.05).toFixed(4);
  su = +(su + 0.9).toFixed(4);
  const rGhost = soloTracker.observeBucket({
    bucketKey: sKey,
    officialUsedPct: su,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: stTs,
    cycleCostUsd: sc,
    poolLastActivityMs: stTs,
    activeSessionCount10m: 1,
    nowMs: stTs,
  });
  assert.equal(rGhost.reservedPct, 0.8);

  // 3 consecutive normal 1:1 local steps ($0.05 -> +0.10% each, total 0.30% >= 0.25%) with zero absorption -> evicts ghost lease!
  let rFinal = null;
  for (let i = 0; i < 3; i += 1) {
    stTs += 20_000;
    sc = +(sc + 0.05).toFixed(4);
    su = +(su + 0.1).toFixed(4);
    rFinal = soloTracker.observeBucket({
      bucketKey: sKey,
      officialUsedPct: su,
      resetTimeMs: RESET_5H,
      quotaFetchedAtMs: stTs,
      cycleCostUsd: sc,
      poolLastActivityMs: stTs,
      activeSessionCount10m: 1,
      nowMs: stTs,
    });
  }
  assert.equal(rFinal.reservedPct, 0, 'unbacked single-session ghost lease fast-evicted after 3 unabsorbed 1:1 steps');
  assert.equal(soloTracker._buckets.get(sKey).hasExternalUsage, true);
  assert.ok(
    soloTracker.getLogSnapshot().events.some((e) => e.event === 'lease_rejected'),
    'eviction recorded as lease_rejected'
  );
});

test('QuotaPoolsWidget ? popover renders family-group/external usage banner and shared-active badge cleanly', async () => {
  const { document } = createMockDom();
  const origDocument = globalThis.document;
  const origWindow = globalThis.window;
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 960,
    innerHeight: 720,
    addEventListener() {},
    removeEventListener() {},
    location: { origin: 'http://127.0.0.1:0', href: 'http://127.0.0.1:0/' },
  };

  try {
    const [{ setI18nLanguage }, { QuotaPoolsWidget }] = await Promise.all([
      import('../src/i18n/index.js'),
      import('../src/components/widgets/QuotaPoolsWidget.js'),
    ]);
    setI18nLanguage('zh-CN');

    const widget = QuotaPoolsWidget();
    const popover = widget.refs.ratePopoverEl;

    // 1. Solo account without external usage: no shared badge or external banner
    widget.refs.update({
      data: {
        account: { email: 'solo@example.com', tierName: 'Google AI Ultra' },
        quotas: {
          pools: [
            {
              poolKey: 'Gemini',
              poolLabel: 'Gemini',
              family: 'Gemini',
              usedPct: 12,
              remainingPct: 88,
              rateEstimate: {
                rate5hPctPerUsd: 2,
                rateWeeklyPctPerUsd: 0.5,
                eqFull5hUsd: 50,
                eqFullWeeklyUsd: 200,
                samples5h: 5,
                samplesWeekly: 5,
                models: [],
              },
            },
          ],
          weekly: { isOfficial: true },
        },
      },
      minuteTick: 1,
    });
    assert.equal(popover.querySelector('.quota-rate-shared-badge'), null);
    assert.equal(popover.querySelector('.quota-rate-ext-banner'), null);

    // 2. Family-group active external usage with concrete 5h + weekly excluded %
    const familyData = {
      account: { email: 'family@example.com', tierName: 'Google AI Ultra' },
      quotas: {
        pools: [
          {
            poolKey: 'Gemini',
            poolLabel: 'Gemini',
            family: 'Gemini',
            usedPct: 24,
            remainingPct: 76,
            weeklyUsedPct: 35,
            weeklyRemainingPct: 65,
            rateEstimate: {
              rate5hPctPerUsd: 2,
              rateWeeklyPctPerUsd: 0.5,
              eqFull5hUsd: 50,
              eqFullWeeklyUsd: 200,
              samples5h: 6,
              samplesWeekly: 6,
              models: [],
              externalUsage: {
                detected: true,
                activeRecently: true,
                used5hPct: 2.4,
                usedWeeklyPct: 0.6,
                events: 3,
                lastSeenAtMs: Date.now(),
              },
            },
          },
        ],
        weekly: { isOfficial: true },
      },
    };
    widget.refs.update({ data: familyData, minuteTick: 2 });
    const sharedBadge = popover.querySelector('.quota-rate-shared-badge');
    const extBanner = popover.querySelector('.quota-rate-ext-banner');
    assert.ok(sharedBadge, 'shared-active badge rendered');
    assert.equal(sharedBadge.textContent, '共享活跃');
    assert.ok(extBanner, 'external usage banner rendered');
    assert.equal(extBanner.classList.contains('is-active'), true);
    assert.equal(extBanner.textContent, '检测到家庭组 / 其他设备消耗');
    assert.equal(extBanner.textContent.includes('与'), false);

    // 3. Baseline-only external detection before any model samples exist
    widget.refs.update({
      data: {
        account: { email: 'family@example.com', tierName: 'Google AI Ultra' },
        quotas: {
          pools: [
            {
              poolKey: 'Gemini',
              poolLabel: 'Gemini',
              family: 'Gemini',
              usedPct: 18,
              remainingPct: 82,
              rateEstimate: {
                rate5hPctPerUsd: null,
                rateWeeklyPctPerUsd: null,
                eqFull5hUsd: null,
                eqFullWeeklyUsd: null,
                samples5h: 0,
                samplesWeekly: 0,
                models: [],
                externalUsage: {
                  detected: true,
                  activeRecently: false,
                  used5hPct: 0,
                  usedWeeklyPct: 0,
                  events: 0,
                  lastSeenAtMs: null,
                },
              },
            },
          ],
          weekly: { isOfficial: true },
        },
      },
      minuteTick: 3,
    });
    assert.equal(popover.querySelector('.quota-rate-shared-badge'), null);
    const baseBanner = popover.querySelector('.quota-rate-ext-banner');
    assert.ok(baseBanner);
    assert.match(baseBanner.textContent, /仅按本机实测校准/);

    // 4. English locale rendering
    setI18nLanguage('en-US');
    widget.refs.update({ data: familyData, minuteTick: 4 });
    assert.equal(popover.querySelector('.quota-rate-shared-badge').textContent, 'Shared active');
    assert.equal(
      popover.querySelector('.quota-rate-ext-banner').textContent,
      'Family group / other-device usage detected'
    );

    widget.destroy();
  } finally {
    globalThis.document = origDocument;
    globalThis.window = origWindow;
  }
});

test('quota-reservation: 3-tier hybrid estimator unlocks cycle_ratio & anchor_slope, derives full-pool tokens, and retains density across reset & restart', () => {
  let storedPayload = null;
  const tracker = createQuotaReservationTracker({
    saveState: (p) => {
      storedPayload = JSON.parse(JSON.stringify(p));
    },
  });

  const makePools = (used5h, usedWk, reset5h = RESET_5H, resetWk = RESET_WK) =>
    new Map([
      [
        'Claude & GPT',
        {
          poolKey: 'Claude & GPT',
          poolLabel: 'Claude & GPT',
          family: 'Claude & GPT',
          has5h: true,
          hasWeekly: true,
          remainingFraction: 1 - used5h / 100,
          usedPct: used5h,
          resetTime: new Date(reset5h).toISOString(),
          weeklyRemainingFraction: 1 - usedWk / 100,
          weeklyUsedPct: usedWk,
          weeklyResetTime: new Date(resetWk).toISOString(),
        },
      ],
    ]);

  const makeStats = ({
    cost5h,
    costWk,
    calls5h,
    callsWk,
    tok5h,
    tokWk,
    modelCosts5h = {},
    modelCostsWk = {},
    modelTokens5h = {},
    modelTokensWk = {},
    ts = T0,
  }) =>
    new Map([
      [
        'Claude & GPT',
        {
          cycle5h: { costUsd: cost5h, calls: calls5h, tokens: tok5h, unpricedCalls: 0 },
          cycleWeekly: { costUsd: costWk, calls: callsWk, tokens: tokWk, unpricedCalls: 0 },
          pricedTokens5h: tok5h,
          pricedTokensWeekly: tokWk,
          exactCost5hUsd: cost5h,
          exactCostWeeklyUsd: costWk,
          modelCosts5h,
          modelCostsWeekly: modelCostsWk,
          modelTokens5h,
          modelTokensWeekly: modelTokensWk,
          recent10m: { lastActivityMs: ts, activeSessionCount: 1, costUsd: 0.2 },
        },
      ],
    ]);

  // 1. Cold-start Tier 3 (cycle_ratio): solo account at 3.2% 5h / 2.4% weekly across 6 calls ($1.20, 300k tok -> $4/MTok)
  // Unlocks immediately without waiting for 3 clean single-step diffs, while keeping reservedPct = 0
  const pCold = makePools(3.2, 2.4);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'tier3@example.com',
    quotaPoolsMap: pCold,
    poolCycleStats: makeStats({
      cost5h: 1.6,
      costWk: 1.2,
      calls5h: 6,
      callsWk: 6,
      tok5h: 400_000,
      tokWk: 300_000,
      modelCosts5h: { 'Claude Sonnet 4.6': 1.6 },
      modelCostsWk: { 'Claude Sonnet 4.6': 1.2 },
      modelTokens5h: { 'Claude Sonnet 4.6': 400_000 },
      modelTokensWk: { 'Claude Sonnet 4.6': 300_000 },
      ts: T0,
    }),
    quotaFetchedAtMs: T0,
    nowMs: T0,
  });
  const coldPool = pCold.get('Claude & GPT');
  assert.equal(coldPool.reservedPct, 0);
  assert.equal(coldPool.weeklyReservedPct, 0);
  assert.equal(coldPool.rateEstimate?.source5h, 'cycle_ratio');
  assert.equal(coldPool.rateEstimate?.sourceWeekly, 'cycle_ratio');
  assert.equal(coldPool.rateEstimate?.isPreliminary5h, true);
  assert.equal(coldPool.rateEstimate?.isPreliminaryWeekly, true);
  assert.equal(coldPool.rateEstimate?.eqFull5hUsd, 50);
  assert.equal(coldPool.rateEstimate?.eqFullWeeklyUsd, 50);
  assert.equal(coldPool.rateEstimate?.eqFull5hTokens, 12_500_000);
  assert.equal(coldPool.rateEstimate?.eqFullWeeklyTokens, 12_500_000);

  // 2. Mid-cycle / shared-account Tier 2 (anchor_slope + Theil-Sen):
  // Baseline starts at 28% weekly with $0 local cost -> hasExternalUsage = true, Tier 3 blocked
  let ts = T0;
  let u5 = 15.0;
  let uw = 28.0;
  let c = 0;
  let n = 0;
  let tok = 0;
  const pExt0 = makePools(u5, uw);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'slope@example.com',
    quotaPoolsMap: pExt0,
    poolCycleStats: makeStats({ cost5h: 0, costWk: 0, calls5h: 0, callsWk: 0, tok5h: 0, tokWk: 0, ts }),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(pExt0.get('Claude & GPT').rateEstimate?.eqFullWeeklyUsd, null, 'Tier 3 blocked on external baseline');

  // Local runs 3 multi-model batched checkpoints (+0.6% weekly / +$0.30 / +2 calls each; total +1.8% >= 1.5%, +6 calls >= 5, $4/MTok)
  // Note: delta5h = +0.6% (>= 0.35% lease jump threshold on uncalibrated or multi-step), so clean single-step rateSamples stays 0,
  // proving Tier 2 anchor_slope independently recovers 2.0 %/$ -> $50 full weekly!
  let pSlope = null;
  for (let step = 0; step < 3; step += 1) {
    ts += 30_000;
    c = +(c + 0.3).toFixed(4);
    n += 2;
    tok += 75_000;
    u5 = +(u5 + 0.3).toFixed(4);
    uw = +(uw + 0.6).toFixed(4);
    pSlope = makePools(u5, uw);
    tracker.updatePools({
      endpointId: 'local',
      accountScope: 'slope@example.com',
      quotaPoolsMap: pSlope,
      poolCycleStats: makeStats({
        cost5h: c,
        costWk: c,
        calls5h: n,
        callsWk: n,
        tok5h: tok,
        tokWk: tok,
        modelCosts5h: { 'Claude Sonnet 4.6': c * 0.6, 'Claude Opus 4.6': c * 0.4 },
        modelCostsWk: { 'Claude Sonnet 4.6': c * 0.6, 'Claude Opus 4.6': c * 0.4 },
        modelTokens5h: { 'Claude Sonnet 4.6': Math.round(tok * 0.75), 'Claude Opus 4.6': Math.round(tok * 0.25) },
        modelTokensWk: { 'Claude Sonnet 4.6': Math.round(tok * 0.75), 'Claude Opus 4.6': Math.round(tok * 0.25) },
        ts,
      }),
      runningPoolKeys: new Set(['Claude & GPT']),
      quotaFetchedAtMs: ts,
      nowMs: ts,
    });
  }
  const slopeEst = pSlope.get('Claude & GPT').rateEstimate;
  assert.equal(slopeEst?.sourceWeekly, 'anchor_slope');
  assert.equal(slopeEst?.isPreliminaryWeekly, true);
  assert.equal(slopeEst?.eqFullWeeklyUsd, 50);
  assert.equal(slopeEst?.eqFullWeeklyTokens, 12_500_000);

  // 3. Three clean single-model steps on Sonnet ($0.10 -> +0.2% weekly = 2.0 %/$) promote pool & model to Tier 1 calibrated
  let sonnetExtraCost = 0;
  let sonnetExtraTok = 0;
  let pCal = null;
  for (let i = 0; i < 3; i += 1) {
    ts += 20_000;
    c = +(c + 0.1).toFixed(4);
    sonnetExtraCost = +(sonnetExtraCost + 0.1).toFixed(4);
    sonnetExtraTok += 25_000;
    n += 1;
    tok += 25_000;
    u5 = +(u5 + 0.2).toFixed(4);
    uw = +(uw + 0.2).toFixed(4);
    pCal = makePools(u5, uw);
    tracker.updatePools({
      endpointId: 'local',
      accountScope: 'slope@example.com',
      quotaPoolsMap: pCal,
      poolCycleStats: makeStats({
        cost5h: c,
        costWk: c,
        calls5h: n,
        callsWk: n,
        tok5h: tok,
        tokWk: tok,
        modelCosts5h: { 'Claude Sonnet 4.6': 0.54 + sonnetExtraCost, 'Claude Opus 4.6': 0.36 },
        modelCostsWk: { 'Claude Sonnet 4.6': 0.54 + sonnetExtraCost, 'Claude Opus 4.6': 0.36 },
        modelTokens5h: { 'Claude Sonnet 4.6': 168_750 + sonnetExtraTok, 'Claude Opus 4.6': 56_250 },
        modelTokensWk: { 'Claude Sonnet 4.6': 168_750 + sonnetExtraTok, 'Claude Opus 4.6': 56_250 },
        ts,
      }),
      runningPoolKeys: new Set(['Claude & GPT']),
      quotaFetchedAtMs: ts,
      nowMs: ts,
    });
  }
  const calEst = pCal.get('Claude & GPT').rateEstimate;
  assert.equal(calEst?.sourceWeekly, 'calibrated');
  assert.equal(calEst?.isPreliminaryWeekly, false);
  assert.equal(calEst?.eqFullWeeklyUsd, 50);
  assert.equal(calEst?.eqFullWeeklyTokens, 12_500_000);
  assert.ok(calEst?.models?.[0]?.eqFullWeeklyTokens > 10_000_000, 'per-model eqFullWeeklyTokens populated');

  // 4. Weekly rollover reset back to 0% ($0 cost, 0 tokens) + reload from persisted v2 payload:
  // priorUsdPerMTok preserves full-pool token capacity with zero Monday-reset amnesia!
  ts += 7 * 24 * 3600 * 1000;
  const pReset = makePools(0, 0, RESET_5H + 7 * 24 * 3600 * 1000, RESET_WK + 7 * 24 * 3600 * 1000);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'slope@example.com',
    quotaPoolsMap: pReset,
    poolCycleStats: makeStats({ cost5h: 0, costWk: 0, calls5h: 0, callsWk: 0, tok5h: 0, tokWk: 0, ts }),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(pReset.get('Claude & GPT').rateEstimate?.eqFullWeeklyUsd, 50);
  assert.equal(pReset.get('Claude & GPT').rateEstimate?.eqFullWeeklyTokens, 12_500_000);

  assert.equal(storedPayload?.version, 2, 'keeps v2 schema version backward-compatible');
  const reloaded = createQuotaReservationTracker({ loadState: () => storedPayload });
  const pAfterRestart = makePools(0, 0, RESET_5H + 7 * 24 * 3600 * 1000, RESET_WK + 7 * 24 * 3600 * 1000);
  reloaded.updatePools({
    endpointId: 'local',
    accountScope: 'slope@example.com',
    quotaPoolsMap: pAfterRestart,
    poolCycleStats: makeStats({ cost5h: 0, costWk: 0, calls5h: 0, callsWk: 0, tok5h: 0, tokWk: 0, ts }),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(pAfterRestart.get('Claude & GPT').rateEstimate?.eqFullWeeklyUsd, 50);
  assert.equal(pAfterRestart.get('Claude & GPT').rateEstimate?.eqFullWeeklyTokens, 12_500_000);
});

test('QuotaPoolsWidget ? popover renders preliminary labels and full-pool token references without weekly summary row, footer note, or divider rules', async () => {
  const { document } = createMockDom();
  const origDocument = globalThis.document;
  const origWindow = globalThis.window;
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 960,
    innerHeight: 720,
    addEventListener() {},
    removeEventListener() {},
    location: { origin: 'http://127.0.0.1:0', href: 'http://127.0.0.1:0/' },
  };

  try {
    const [{ setI18nLanguage }, { QuotaPoolsWidget }] = await Promise.all([
      import('../src/i18n/index.js'),
      import('../src/components/widgets/QuotaPoolsWidget.js'),
    ]);
    setI18nLanguage('zh-CN');

    const widget = QuotaPoolsWidget();
    const popover = widget.refs.ratePopoverEl;

    // 1. Minimalist layout: no redundant weekly summary row or footer note element
    assert.equal(popover.querySelector('.quota-rate-wk-summary'), null);
    assert.equal(popover.querySelector('.quota-rate-pop-note'), null);

    // 2. Partial + Preliminary state (Claude ready via anchor_slope, Gemini still collecting)
    widget.refs.update({
      data: {
        account: { email: 'sjee80343@gmail.com', tierName: 'Google AI Pro' },
        quotas: {
          pools: [
            {
              poolKey: 'Claude & GPT',
              poolLabel: 'Claude & GPT',
              family: 'Claude & GPT',
              has5h: true,
              hasWeekly: true,
              usedPct: 14,
              remainingPct: 86,
              weeklyUsedPct: 30,
              weeklyRemainingPct: 70,
              cycleWeekly: { tokens: 3_100_000, costUsd: 15, calls: 42 },
              rateEstimate: {
                rate5hPctPerUsd: null,
                rateWeeklyPctPerUsd: 2.0833,
                eqFull5hUsd: null,
                eqFullWeeklyUsd: 48,
                eqFullWeeklyTokens: 9_900_000,
                samples5h: 0,
                samplesWeekly: 0,
                sourceWeekly: 'anchor_slope',
                isPreliminaryWeekly: true,
                models: [],
              },
            },
            {
              poolKey: 'Gemini',
              poolLabel: 'Gemini',
              family: 'Gemini',
              hasWeekly: true,
              weeklyUsedPct: 0.4,
              weeklyRemainingPct: 99.6,
              rateEstimate: null,
            },
          ],
          weekly: { isOfficial: true },
        },
      },
      minuteTick: 1,
    });

    assert.doesNotMatch(popover.textContent, /预测周额度/);
    assert.doesNotMatch(popover.textContent, /同池最省/);
    const fallbackRow = popover.querySelector('.quota-rate-model-row.is-fallback');
    assert.ok(fallbackRow);
    assert.match(fallbackRow.textContent, /池综合均值/);
    assert.match(fallbackRow.textContent, /周限 2\.08%\/\$ · 斜率初估/);
    assert.match(fallbackRow.textContent, /周限≈ \$48· 9\.9M/);

    const wkRowLeft = widget.refs.poolsListEl.querySelectorAll('.quota-win-left')[1];
    assert.match(wkRowLeft.getAttribute('title') || '', /满池约 \$48 \(9\.9M\)/);

    // 3. All pools calibrated & ready: renders per-pool model & fallback cards cleanly
    const allReadyData = {
      account: { email: 'sjee80343@gmail.com', tierName: 'Google AI Pro' },
      quotas: {
        pools: [
          {
            poolKey: 'Claude & GPT',
            poolLabel: 'Claude & GPT',
            family: 'Claude & GPT',
            has5h: true,
            hasWeekly: true,
            usedPct: 14,
            remainingPct: 86,
            weeklyUsedPct: 30,
            weeklyRemainingPct: 70,
            cycleWeekly: { tokens: 3_100_000, costUsd: 15, calls: 42 },
            rateEstimate: {
              rate5hPctPerUsd: 2,
              rateWeeklyPctPerUsd: 2,
              eqFull5hUsd: 50,
              eqFullWeeklyUsd: 50,
              eqFull5hTokens: 10_300_000,
              eqFullWeeklyTokens: 10_300_000,
              samples5h: 8,
              samplesWeekly: 8,
              source5h: 'calibrated',
              sourceWeekly: 'calibrated',
              isPreliminary5h: false,
              isPreliminaryWeekly: false,
              models: [
                {
                  model: 'Claude Sonnet 4.6',
                  rate5hPctPerUsd: 2,
                  rateWeeklyPctPerUsd: 2,
                  eqFull5hUsd: 50,
                  eqFullWeeklyUsd: 50,
                  eqFull5hTokens: 10_300_000,
                  eqFullWeeklyTokens: 10_300_000,
                  multiplier: null,
                  samples: 8,
                },
              ],
            },
          },
          {
            poolKey: 'Gemini',
            poolLabel: 'Gemini',
            family: 'Gemini',
            has5h: true,
            hasWeekly: true,
            usedPct: 10,
            remainingPct: 90,
            weeklyUsedPct: 20,
            weeklyRemainingPct: 80,
            rateEstimate: {
              rate5hPctPerUsd: 2.8571,
              rateWeeklyPctPerUsd: 2.8571,
              eqFull5hUsd: 35,
              eqFullWeeklyUsd: 35,
              eqFull5hTokens: 14_200_000,
              eqFullWeeklyTokens: 14_200_000,
              samples5h: 6,
              samplesWeekly: 6,
              source5h: 'calibrated',
              sourceWeekly: 'calibrated',
              isPreliminary5h: false,
              isPreliminaryWeekly: false,
              models: [],
            },
          },
        ],
        weekly: { isOfficial: true },
      },
    };
    widget.refs.update({ data: allReadyData, minuteTick: 2 });
    assert.match(popover.textContent, /Claude Sonnet 4\.6.*5h≈ \$50· 10\.3M.*周限≈ \$50· 10\.3M/);
    assert.match(popover.textContent, /Gemini.*池综合均值.*5h≈ \$35· 14\.2M/);

    // 4. English locale switch updates model cards and row title tooltip without reload
    setI18nLanguage('en-US');
    widget.refs.update({ data: allReadyData, minuteTick: 3 });
    assert.doesNotMatch(popover.textContent, /Est\. Weekly Quota/);
    assert.doesNotMatch(popover.textContent, /lowest in pool/);
    assert.match(popover.textContent, /5h≈ \$50· 10\.3M.*Weekly≈ \$50· 10\.3M/);
    assert.match(
      widget.refs.poolsListEl.querySelectorAll('.quota-win-left')[1].getAttribute('title') || '',
      /Full ~\$50 \(10\.3M\)/
    );

    // 5. Pool with 5h-only model card + pool-level preliminary weekly estimate renders supplementary weekly fallback row
    setI18nLanguage('zh-CN');
    widget.refs.update({
      data: {
        account: { email: 'sjee80343@gmail.com', tierName: 'Google AI Pro' },
        quotas: {
          pools: [
            {
              poolKey: 'Gemini',
              poolLabel: 'Gemini',
              family: 'Gemini',
              has5h: true,
              hasWeekly: true,
              usedPct: 8,
              remainingPct: 92,
              weeklyUsedPct: 12,
              weeklyRemainingPct: 88,
              rateEstimate: {
                rate5hPctPerUsd: 0.6667,
                rateWeeklyPctPerUsd: 0.1667,
                eqFull5hUsd: 150,
                eqFullWeeklyUsd: 600,
                eqFull5hTokens: 50_000_000,
                eqFullWeeklyTokens: 200_000_000,
                samples5h: 4,
                samplesWeekly: 0,
                source5h: 'calibrated',
                sourceWeekly: 'anchor_slope',
                isPreliminary5h: false,
                isPreliminaryWeekly: true,
                models: [
                  {
                    model: 'Gemini 3.1 Pro',
                    rate5hPctPerUsd: 0.6667,
                    rateWeeklyPctPerUsd: null,
                    eqFull5hUsd: 150,
                    eqFullWeeklyUsd: null,
                    eqFull5hTokens: 50_000_000,
                    multiplier: null,
                    samples: 4,
                  },
                ],
              },
            },
          ],
          weekly: { isOfficial: true },
        },
      },
      minuteTick: 5,
    });
    const mixedRows = popover.querySelectorAll('.quota-rate-model-row');
    assert.equal(mixedRows.length, 2, 'renders 5h model card + supplementary pool weekly fallback row');
    assert.match(mixedRows[0].textContent, /Gemini 3\.1 Pro.*5h≈ \$150/);
    assert.match(mixedRows[1].textContent, /池综合均值.*斜率初估.*周限≈ \$600· 200\.0M/);

    widget.destroy();
  } finally {
    globalThis.document = origDocument;
    globalThis.window = origWindow;
  }
});

test('quota-reservation: batches multi-pool persistence and isolates slope/calibration from unpriced calls, lease expiry & cold-start', () => {
  let saveCalls = 0;
  let stored = null;
  const tracker = createQuotaReservationTracker({
    saveState: (p) => {
      saveCalls += 1;
      stored = JSON.parse(JSON.stringify(p));
    },
  });

  // 1. Batched persistence across multiple pools on non-urgent baseline/normal ticks:
  // Both pools' 5h AND weekly buckets must be persisted in a single atomic save
  let ts = T0;
  const mkMultiPools = (c5, cw, g5, gw) =>
    new Map([
      [
        'Claude & GPT',
        {
          poolKey: 'Claude & GPT',
          poolLabel: 'Claude & GPT',
          family: 'Claude & GPT',
          has5h: true,
          hasWeekly: true,
          remainingFraction: 1 - c5 / 100,
          usedPct: c5,
          resetTime: new Date(RESET_5H).toISOString(),
          weeklyRemainingFraction: 1 - cw / 100,
          weeklyUsedPct: cw,
          weeklyResetTime: new Date(RESET_WK).toISOString(),
        },
      ],
      [
        'Gemini',
        {
          poolKey: 'Gemini',
          poolLabel: 'Gemini',
          family: 'Gemini',
          has5h: true,
          hasWeekly: true,
          remainingFraction: 1 - g5 / 100,
          usedPct: g5,
          resetTime: new Date(RESET_5H).toISOString(),
          weeklyRemainingFraction: 1 - gw / 100,
          weeklyUsedPct: gw,
          weeklyResetTime: new Date(RESET_WK).toISOString(),
        },
      ],
    ]);

  const mkMultiStats = (cc, gc, cCalls, gCalls, cUnp = 0) =>
    new Map([
      [
        'Claude & GPT',
        {
          cycle5h: { costUsd: cc, calls: cCalls, tokens: 300_000, unpricedCalls: cUnp },
          cycleWeekly: { costUsd: cc, calls: cCalls, tokens: 300_000, unpricedCalls: cUnp },
          pricedTokens5h: 300_000,
          pricedTokensWeekly: 300_000,
          exactCost5hUsd: cc,
          exactCostWeeklyUsd: cc,
          modelCosts5h: { 'Claude Sonnet 4.6': cc },
          modelCostsWeekly: { 'Claude Sonnet 4.6': cc },
          modelTokens5h: { 'Claude Sonnet 4.6': 300_000 },
          modelTokensWeekly: { 'Claude Sonnet 4.6': 300_000 },
          recent10m: { lastActivityMs: ts, activeSessionCount: 1, costUsd: 0.1 },
        },
      ],
      [
        'Gemini',
        {
          cycle5h: { costUsd: gc, calls: gCalls, tokens: 500_000, unpricedCalls: 0 },
          cycleWeekly: { costUsd: gc, calls: gCalls, tokens: 500_000, unpricedCalls: 0 },
          pricedTokens5h: 500_000,
          pricedTokensWeekly: 500_000,
          exactCost5hUsd: gc,
          exactCostWeeklyUsd: gc,
          modelCosts5h: { 'Gemini 3.1 Pro': gc },
          modelCostsWeekly: { 'Gemini 3.1 Pro': gc },
          modelTokens5h: { 'Gemini 3.1 Pro': 500_000 },
          modelTokensWeekly: { 'Gemini 3.1 Pro': 500_000 },
          recent10m: { lastActivityMs: ts, activeSessionCount: 1, costUsd: 0.1 },
        },
      ],
    ]);

  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'batch@example.com',
    quotaPoolsMap: mkMultiPools(2.0, 2.0, 1.0, 1.0),
    poolCycleStats: mkMultiStats(1.0, 2.0, 5, 5),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(saveCalls, 1, 'updatePools coalesces multi-pool baseline into 1 disk write');
  assert.ok(stored?.buckets?.['local::batch@example.com::Claude & GPT::weekly'], 'Claude weekly persisted');
  assert.ok(stored?.buckets?.['local::batch@example.com::Gemini::weekly'], '2nd pool Gemini weekly persisted');
  assert.ok(
    stored.buckets['local::batch@example.com::Gemini::weekly'].usdPerMTok > 0,
    '2nd pool weekly token density persisted'
  );

  // 2. Cold-start seeded bucket (rateSamples = 1, rateWindow = []) requires 3 genuine clean steps before calibrated
  for (let step = 1; step <= 2; step += 1) {
    ts += 20_000;
    const p2 = mkMultiPools(2.0 + step * 0.2, 2.0 + step * 0.2, 1.0, 1.0);
    tracker.updatePools({
      endpointId: 'local',
      accountScope: 'batch@example.com',
      quotaPoolsMap: p2,
      poolCycleStats: mkMultiStats(1.0 + step * 0.1, 2.0, 5 + step, 5),
      runningPoolKeys: new Set(['Claude & GPT']),
      quotaFetchedAtMs: ts,
      nowMs: ts,
    });
    const estStep = p2.get('Claude & GPT').rateEstimate;
    assert.equal(
      estStep?.isPreliminaryWeekly,
      true,
      `step ${step} (< 3 clean steps) stays preliminary despite cold-start seed`
    );
  }
  ts += 20_000;
  const pStep3 = mkMultiPools(2.6, 2.6, 1.0, 1.0);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'batch@example.com',
    quotaPoolsMap: pStep3,
    poolCycleStats: mkMultiStats(1.3, 2.0, 8, 5),
    runningPoolKeys: new Set(['Claude & GPT']),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(pStep3.get('Claude & GPT').rateEstimate?.isPreliminaryWeekly, false, '3rd genuine clean step promotes to calibrated');
  assert.equal(stored?.buckets?.['local::batch@example.com::Claude & GPT::weekly']?.rateWindow?.length, 3, 'normal tick persisted weekly rateWindow');

  // 3. Unpriced calls & expired leases do NOT poison Tier 2 anchor_slope
  ts = T0;
  const makeWkPool = (uw) =>
    new Map([
      [
        'Argon',
        {
          poolKey: 'Argon',
          poolLabel: 'Argon',
          family: 'Argon',
          has5h: false,
          hasWeekly: true,
          weeklyRemainingFraction: 1 - uw / 100,
          weeklyUsedPct: uw,
          weeklyResetTime: new Date(RESET_WK).toISOString(),
        },
      ],
    ]);
  const makeWkStats = (cost, calls, unp) =>
    new Map([
      [
        'Argon',
        {
          cycle5h: { costUsd: 0, calls: 0, tokens: 0, unpricedCalls: 0 },
          cycleWeekly: { costUsd: cost, calls, tokens: 100_000, unpricedCalls: unp },
          pricedTokensWeekly: 100_000,
          exactCostWeeklyUsd: cost,
          recent10m: { lastActivityMs: ts, activeSessionCount: 2, costUsd: 0.1 },
        },
      ],
    ]);

  // Baseline on shared pool (20% with $0 local -> Tier 3 blocked)
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'guard@example.com',
    quotaPoolsMap: makeWkPool(20.0),
    poolCycleStats: makeWkStats(0, 0, 0),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  // Unpriced burst burns +3.0% alongside tiny $0.03 priced spend -> must reset slope anchor, NOT record 100 %/$
  ts += 30_000;
  const pUnp = makeWkPool(23.0);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'guard@example.com',
    quotaPoolsMap: pUnp,
    poolCycleStats: makeWkStats(0.03, 6, 5),
    runningPoolKeys: new Set(['Argon']),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(pUnp.get('Argon').rateEstimate?.eqFullWeeklyUsd ?? null, null, 'unpriced burst does not unlock poisoned slope');

  // Subsequent priced multi-step burn (+1.6% across +$0.80, 6 calls, unp stays 5) cleanly calibrates 2.0 %/$ -> $50!
  for (let k = 1; k <= 2; k += 1) {
    ts += 30_000;
    const pPriced = makeWkPool(23.0 + k * 0.8);
    tracker.updatePools({
      endpointId: 'local',
      accountScope: 'guard@example.com',
      quotaPoolsMap: pPriced,
      poolCycleStats: makeWkStats(0.03 + k * 0.4, 6 + k * 3, 5),
      runningPoolKeys: new Set(['Argon']),
      quotaFetchedAtMs: ts,
      nowMs: ts,
    });
    if (k === 2) {
      assert.equal(pPriced.get('Argon').rateEstimate?.sourceWeekly, 'anchor_slope');
      assert.equal(pPriced.get('Argon').rateEstimate?.eqFullWeeklyUsd, 50);
    }
  }

  // Trigger a 2.0% cold-start/active lease jump, then let it expire after 91 minutes -> expiry jump must reset slope anchor
  ts += 30_000;
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'guard@example.com',
    quotaPoolsMap: makeWkPool(26.6),
    poolCycleStats: makeWkStats(0.85, 13, 5),
    runningPoolKeys: new Set(['Argon']),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  const argonSt = tracker._buckets.get('local::guard@example.com::Argon::weekly');
  assert.ok(argonSt.activeLeases.length > 0, 'lease recorded before TTL expiry');
  ts += 91 * 60 * 1000;
  const pExpired = makeWkPool(26.65);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'guard@example.com',
    quotaPoolsMap: pExpired,
    poolCycleStats: makeWkStats(0.88, 14, 5),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(argonSt.activeLeases.length, 0, 'lease expired');
  assert.equal(argonSt.slopeSamples.length, 1, 'slope anchor reset cleanly on lease TTL expiry');
});

test('quota-reservation: suppresses post-refund idle replica ping-pong and self-heals false externalUsage while preserving real shared pools', () => {
  const tracker = createQuotaReservationTracker();
  const keyWk = 'local::solo-bounce@example.com::Gemini::weekly';
  let ts = T0;

  // 1. Calibrate solo account cleanly at 0.125 %/$ ($800 full weekly): 3 clean steps + active lease up to 1.048%
  tracker.observeBucket({
    bucketKey: keyWk,
    officialUsedPct: 0.3,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: ts,
    cycleCostUsd: 2.4,
    cycleCalls: 30,
    poolLastActivityMs: ts,
    activeSessionCount10m: 1,
    nowMs: ts,
  });
  for (let i = 1; i <= 3; i += 1) {
    ts += 20_000;
    tracker.observeBucket({
      bucketKey: keyWk,
      officialUsedPct: +(0.3 + i * 0.025).toFixed(4),
      resetTimeMs: RESET_WK,
      quotaFetchedAtMs: ts,
      cycleCostUsd: +(2.4 + i * 0.2).toFixed(4),
      cycleCalls: 30 + i,
      poolLastActivityMs: ts,
      activeSessionCount10m: 1,
      nowMs: ts,
    });
  }
  const lastActiveTs = ts;
  // Active lease jumps 0.375% -> 1.048%
  ts += 15_000;
  tracker.observeBucket({
    bucketKey: keyWk,
    officialUsedPct: 1.048,
    resetTimeMs: RESET_WK,
    quotaFetchedAtMs: ts,
    cycleCostUsd: 3.0688,
    cycleCalls: 34,
    poolLastActivityMs: lastActiveTs,
    activeSessionCount10m: 1,
    nowMs: ts,
  });

  // User goes idle for 10 min -> upstream settles down to 0.356%, then multi-replica LB bounces 1.048% <-> 0.356% repeatedly
  const bounceSchedule = [
    [10 * 60 * 1000, 0.356],
    [15 * 60 * 1000, 1.048],
    [12 * 60 * 1000, 0.356],
    [11 * 1000, 1.048],
    [7 * 60 * 1000, 0.356],
  ];
  for (const [dt, pct] of bounceSchedule) {
    ts += dt;
    tracker.observeBucket({
      bucketKey: keyWk,
      officialUsedPct: pct,
      resetTimeMs: RESET_WK,
      quotaFetchedAtMs: ts,
      cycleCostUsd: 3.0688,
      cycleCalls: 34,
      poolLastActivityMs: lastActiveTs,
      activeSessionCount10m: 0,
      nowMs: ts,
    });
  }
  const stBounce = tracker._buckets.get(keyWk);
  assert.equal(stBounce.hasExternalUsage, false, 'idle post-refund replica bounce must not flag external usage');
  assert.equal(stBounce.externalUsedPct, 0, 'ping-pong must never accumulate externalUsedPct');

  // 2. Self-healing of already-polluted persisted state vs preservation of genuine shared state
  let healedSaved = null;
  const persisted = {
    version: 2,
    savedAt: new Date(T0).toISOString(),
    buckets: {
      'local::polluted@example.com::Gemini::weekly': {
        resetTimeMs: RESET_WK,
        lastQuotaTs: T0,
        lastOfficialUsedPct: 0.4012,
        lastCycleCostUsd: 3.53,
        lastCycleCalls: 44,
        lastPricedTokens: 9_803_219,
        lastUnpricedCalls: 0,
        usdPerMTok: 0.36,
        ratePctPerUsd: 0.125,
        rateSamples: 20,
        rateWindow: [0.125, 0.125, 0.125, 0.125],
        hasExternalUsage: true,
        lastExternalUsageAtMs: T0 - 3 * 3600 * 1000,
        externalUsedPct: 2.018,
        externalEvents: 4,
      },
      'local::shared@example.com::Gemini::weekly': {
        resetTimeMs: RESET_WK,
        lastQuotaTs: T0,
        lastOfficialUsedPct: 49.82,
        lastCycleCostUsd: 196.93,
        lastCycleCalls: 120,
        lastPricedTokens: 60_000_000,
        lastUnpricedCalls: 0,
        usdPerMTok: 3.28,
        ratePctPerUsd: 0.1667,
        rateSamples: 55,
        rateWindow: [0.1667, 0.1667, 0.1667, 0.1667],
        hasExternalUsage: true,
        lastExternalUsageAtMs: T0 - 3 * 3600 * 1000,
        externalUsedPct: 0.571,
        externalEvents: 1,
      },
    },
    events: [],
  };
  const healer = createQuotaReservationTracker({
    loadState: () => persisted,
    saveState: (p) => {
      healedSaved = p;
    },
  });
  const mkPollPools = (uw) =>
    new Map([
      [
        'Gemini',
        {
          poolKey: 'Gemini',
          poolLabel: 'Gemini',
          family: 'Gemini',
          has5h: false,
          hasWeekly: true,
          weeklyUsedPct: uw,
          weeklyResetTime: new Date(RESET_WK).toISOString(),
        },
      ],
    ]);
  const pPolluted = mkPollPools(0.4012);
  healer.updatePools({
    endpointId: 'local',
    accountScope: 'polluted@example.com',
    quotaPoolsMap: pPolluted,
    poolCycleStats: new Map([
      [
        'Gemini',
        {
          cycleWeekly: { costUsd: 3.53, calls: 44, tokens: 9_803_219, unpricedCalls: 0 },
          pricedTokensWeekly: 9_803_219,
          exactCostWeeklyUsd: 3.53,
        },
      ],
    ]),
    quotaFetchedAtMs: T0,
    nowMs: T0 + 60_000,
  });
  assert.equal(
    pPolluted.get('Gemini').rateEstimate?.externalUsage ?? null,
    null,
    'polluted solo bucket self-heals false externalUsage banner immediately even on cached quota poll'
  );
  assert.equal(healedSaved?.buckets?.['local::polluted@example.com::Gemini::weekly']?.hasExternalUsage, false);
  assert.equal(healedSaved?.buckets?.['local::polluted@example.com::Gemini::weekly']?.externalUsedPct, 0);

  const pShared = mkPollPools(49.82);
  healer.updatePools({
    endpointId: 'local',
    accountScope: 'shared@example.com',
    quotaPoolsMap: pShared,
    poolCycleStats: new Map([
      [
        'Gemini',
        {
          cycleWeekly: { costUsd: 196.93, calls: 120, tokens: 60_000_000, unpricedCalls: 0 },
          pricedTokensWeekly: 60_000_000,
          exactCostWeeklyUsd: 196.93,
        },
      ],
    ]),
    quotaFetchedAtMs: T0,
    nowMs: T0 + 60_000,
  });
  assert.equal(
    pShared.get('Gemini').rateEstimate?.externalUsage?.detected,
    true,
    'genuine shared pool with 17% unexplained burn retains externalUsage detection'
  );
  assert.equal(pShared.get('Gemini').rateEstimate?.externalUsage?.usedWeeklyPct, 0.6);
});

test('quota-reservation: prevents solo hypersensitivity (high-usage self-heal, scan lag, idle jitter, pricing variance, delayed rollback, incomplete scan)', () => {
  // 1. High-usage solo polluted bucket (40% used, 30.3% stale externalUsedPct, local explains ~98%) must self-heal immediately
  const highUsagePersisted = {
    version: 2,
    savedAt: new Date(T0).toISOString(),
    buckets: {
      'local::solo-high@example.com::Gemini::5h': {
        resetTimeMs: RESET_5H,
        lastQuotaTs: T0,
        lastOfficialUsedPct: 40.0,
        lastCycleCostUsd: 54.0,
        lastCycleCalls: 95,
        lastPricedTokens: 80_000_000,
        lastUnpricedCalls: 0,
        usdPerMTok: 0.675,
        ratePctPerUsd: 0.67,
        rateSamples: 21,
        rateWindow: [0.67, 0.67, 0.67, 0.67, 0.67],
        hasExternalUsage: true,
        lastExternalUsageAtMs: T0 - 20 * 60 * 1000,
        externalUsedPct: 30.3,
        externalEvents: 14,
      },
      'local::solo-high@example.com::Gemini::weekly': {
        resetTimeMs: RESET_WK,
        lastQuotaTs: T0,
        lastOfficialUsedPct: 20.0,
        lastCycleCostUsd: 120.0,
        lastCycleCalls: 210,
        lastPricedTokens: 160_000_000,
        lastUnpricedCalls: 0,
        usdPerMTok: 0.75,
        ratePctPerUsd: 0.1667,
        rateSamples: 21,
        rateWindow: [0.1667, 0.1667, 0.1667, 0.1667, 0.1667],
        hasExternalUsage: true,
        lastExternalUsageAtMs: T0 - 2 * 60 * 1000, // even recentExt self-heals when local covers 100%
        externalUsedPct: 19.6,
        externalEvents: 12,
      },
    },
    events: [],
  };
  let savedHigh = null;
  const highHealer = createQuotaReservationTracker({
    loadState: () => highUsagePersisted,
    saveState: (p) => {
      savedHigh = p;
    },
  });
  const highPools = new Map([
    [
      'Gemini',
      {
        poolKey: 'Gemini',
        poolLabel: 'Gemini',
        family: 'Gemini',
        has5h: true,
        hasWeekly: true,
        usedPct: 40.0,
        weeklyUsedPct: 20.0,
        resetTime: new Date(RESET_5H).toISOString(),
        weeklyResetTime: new Date(RESET_WK).toISOString(),
      },
    ],
  ]);
  highHealer.updatePools({
    endpointId: 'local',
    accountScope: 'solo-high@example.com',
    quotaPoolsMap: highPools,
    poolCycleStats: new Map([
      [
        'Gemini',
        {
          cycle5h: { costUsd: 54.0, calls: 95, tokens: 80_000_000, unpricedCalls: 0 },
          cycleWeekly: { costUsd: 120.0, calls: 210, tokens: 160_000_000, unpricedCalls: 0 },
          exactCost5hUsd: 54.0,
          exactCostWeeklyUsd: 120.0,
          pricedTokens5h: 80_000_000,
          pricedTokensWeekly: 160_000_000,
        },
      ],
    ]),
    quotaFetchedAtMs: T0,
    nowMs: T0 + 30_000,
  });
  assert.equal(
    highPools.get('Gemini').rateEstimate?.externalUsage ?? null,
    null,
    'polluted high-usage solo buckets (40% 5h / 20% weekly) self-heal false externalUsage immediately'
  );
  assert.equal(savedHigh?.buckets?.['local::solo-high@example.com::Gemini::5h']?.hasExternalUsage, false);
  assert.equal(savedHigh?.buckets?.['local::solo-high@example.com::Gemini::weekly']?.hasExternalUsage, false);

  // 2. Solo calibrated tracker: in-flight scan lag, pricing variance, delayed settlement, idle micro-jitter, and delayed rollback
  const tracker = createQuotaReservationTracker();
  let ts = T0;
  let u5 = 6.7;
  let uw = 1.67;
  let c5 = 10.0;
  let cw = 10.0;
  const mkPools = (p5, pw) =>
    new Map([
      [
        'Gemini',
        {
          poolKey: 'Gemini',
          poolLabel: 'Gemini',
          family: 'Gemini',
          has5h: true,
          hasWeekly: true,
          usedPct: p5,
          weeklyUsedPct: pw,
          resetTime: new Date(RESET_5H).toISOString(),
          weeklyResetTime: new Date(RESET_WK).toISOString(),
        },
      ],
    ]);
  const mkStats = (cost5, costW, lastActMs, { sess = 1, unpriced = 0 } = {}) =>
    new Map([
      [
        'Gemini',
        {
          cycle5h: { costUsd: cost5, calls: 20, unpricedCalls: unpriced },
          cycleWeekly: { costUsd: costW, calls: 20, unpricedCalls: unpriced },
          exactCost5hUsd: cost5,
          exactCostWeeklyUsd: costW,
          recent10m: { lastActivityMs: lastActMs, activeSessionCount: sess, costUsd: sess > 0 ? 1.0 : 0 },
        },
      ],
    ]);

  // Baseline + 3 clean calibration ticks (5h = 0.67 %/$, weekly = 0.167 %/$)
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'solo-clean@example.com',
    quotaPoolsMap: mkPools(u5, uw),
    poolCycleStats: mkStats(c5, cw, ts),
    runningPoolKeys: new Set(['Gemini']),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  for (let i = 0; i < 3; i += 1) {
    ts += 20_000;
    c5 = +(c5 + 0.3).toFixed(4);
    cw = +(cw + 0.3).toFixed(4);
    u5 = +(u5 + 0.201).toFixed(4);
    uw = +(uw + 0.0501).toFixed(4);
    tracker.updatePools({
      endpointId: 'local',
      accountScope: 'solo-clean@example.com',
      quotaPoolsMap: mkPools(u5, uw),
      poolCycleStats: mkStats(c5, cw, ts),
      runningPoolKeys: new Set(['Gemini']),
      quotaFetchedAtMs: ts,
      nowMs: ts,
    });
  }

  // 2a. In-flight local turn deducts +1.005% 5h & +0.2505% weekly BEFORE local .pb step flushes ($0 delta)
  ts += 15_000;
  u5 = +(u5 + 1.005).toFixed(4);
  uw = +(uw + 0.2505).toFixed(4);
  const pLag = mkPools(u5, uw);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'solo-clean@example.com',
    quotaPoolsMap: pLag,
    poolCycleStats: mkStats(c5, cw, ts - 15_000),
    runningPoolKeys: new Set(['Gemini']),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(
    pLag.get('Gemini').rateEstimate?.externalUsage ?? null,
    null,
    'in-flight running local turn with proportional 5h+weekly quota tick must NOT trigger external_usage'
  );

  // 15s later local step flushes $1.50 while official stays flat -> absorbed cleanly after lag grace
  ts += 15_000;
  c5 = +(c5 + 1.5).toFixed(4);
  cw = +(cw + 1.5).toFixed(4);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'solo-clean@example.com',
    quotaPoolsMap: mkPools(u5, uw),
    poolCycleStats: mkStats(c5, cw, ts),
    runningPoolKeys: new Set(['Gemini']),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  ts += QR_CONSUME_LAG_GRACE_MS + 1_000;
  const pAfterFlush = mkPools(u5, uw);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'solo-clean@example.com',
    quotaPoolsMap: pAfterFlush,
    poolCycleStats: mkStats(c5, cw, ts - QR_CONSUME_LAG_GRACE_MS),
    runningPoolKeys: new Set(['Gemini']),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(pAfterFlush.get('Gemini').rateEstimate?.externalUsage ?? null, null);
  assert.equal(pAfterFlush.get('Gemini').reservedPct, 0);

  // 2b. Solo 2x pricing variance turn ($1.00 local -> upstream bills $2.00 = +1.34% 5h & +0.334% weekly)
  ts += 20_000;
  c5 = +(c5 + 1.0).toFixed(4);
  cw = +(cw + 1.0).toFixed(4);
  u5 = +(u5 + 1.34).toFixed(4);
  uw = +(uw + 0.334).toFixed(4);
  const pPriceVar = mkPools(u5, uw);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'solo-clean@example.com',
    quotaPoolsMap: pPriceVar,
    poolCycleStats: mkStats(c5, cw, ts),
    runningPoolKeys: new Set(['Gemini']),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(
    pPriceVar.get('Gemini').rateEstimate?.externalUsage ?? null,
    null,
    '2x local pricing variance must not trigger co-movement external_usage'
  );

  // 2c. Delayed upstream settlement after user goes idle for 5 min (local cost already on disk covers official)
  ts += 20_000;
  c5 = +(c5 + 2.0).toFixed(4);
  cw = +(cw + 2.0).toFixed(4);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'solo-clean@example.com',
    quotaPoolsMap: mkPools(u5, uw),
    poolCycleStats: mkStats(c5, cw, ts),
    runningPoolKeys: new Set(),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  const lastTurnMs = ts;
  ts += 5 * 60 * 1000;
  u5 = +(u5 + 0.67).toFixed(4);
  uw = +(uw + 0.167).toFixed(4);
  const pDelayedSettle = mkPools(u5, uw);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'solo-clean@example.com',
    quotaPoolsMap: pDelayedSettle,
    poolCycleStats: mkStats(c5, cw, lastTurnMs, { sess: 0 }),
    runningPoolKeys: new Set(),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(
    pDelayedSettle.get('Gemini').rateEstimate?.externalUsage ?? null,
    null,
    'idle upstream catch-up already covered by local cycle spend must not flag external_usage'
  );

  // 2d. Isolated idle micro-jitter (+0.08% 5h) followed by replica drop must NOT flag external_usage
  ts += 6 * 60 * 1000;
  const pJitter = mkPools(+(u5 + 0.08).toFixed(4), uw);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'solo-clean@example.com',
    quotaPoolsMap: pJitter,
    poolCycleStats: mkStats(c5, cw, lastTurnMs, { sess: 0 }),
    runningPoolKeys: new Set(),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(
    pJitter.get('Gemini').rateEstimate?.externalUsage ?? null,
    null,
    'single isolated +0.08% idle blip must not trigger external_usage'
  );
  ts += 20_000;
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'solo-clean@example.com',
    quotaPoolsMap: mkPools(u5, uw),
    poolCycleStats: mkStats(c5, cw, lastTurnMs, { sess: 0 }),
    runningPoolKeys: new Set(),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });

  // 2e. Delayed local step flush rolls back a single temporary external_usage event (e.g. model switch mid-chat)
  const rollbackTracker = createQuotaReservationTracker();
  let rt = T0;
  let ru5 = 10.0;
  let rc5 = 10.0;
  const rKey = 'local::switch-model@example.com::Gemini::5h';
  rollbackTracker.observeBucket({
    bucketKey: rKey,
    poolKey: 'Gemini',
    win: '5h',
    officialUsedPct: ru5,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: rt,
    cycleCostUsd: rc5,
    cycleCalls: 10,
    poolLastActivityMs: rt,
    activeSessionCount10m: 1,
    nowMs: rt,
  });
  for (let i = 0; i < 3; i += 1) {
    rt += 20_000;
    rc5 = +(rc5 + 0.2).toFixed(4);
    ru5 = +(ru5 + 0.2).toFixed(4);
    rollbackTracker.observeBucket({
      bucketKey: rKey,
      poolKey: 'Gemini',
      win: '5h',
      officialUsedPct: ru5,
      resetTimeMs: RESET_5H,
      quotaFetchedAtMs: rt,
      cycleCostUsd: rc5,
      cycleCalls: 11 + i,
      poolLastActivityMs: rt,
      activeSessionCount10m: 1,
      nowMs: rt,
    });
  }
  const rLastAct = rt;
  // User switches into Gemini while pool looked idle -> +0.8% arrives before local step flushes
  rt += 6 * 60 * 1000;
  ru5 = +(ru5 + 0.8).toFixed(4);
  rollbackTracker.observeBucket({
    bucketKey: rKey,
    poolKey: 'Gemini',
    win: '5h',
    officialUsedPct: ru5,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: rt,
    cycleCostUsd: rc5,
    cycleCalls: 13,
    poolLastActivityMs: rLastAct,
    activeSessionCount10m: 0,
    nowMs: rt,
  });
  assert.equal(rollbackTracker._buckets.get(rKey).hasExternalUsage, true);
  // 15s later the local $0.80 Gemini step flushes while official stays flat -> cancels temporary flag
  rt += 15_000;
  rc5 = +(rc5 + 0.8).toFixed(4);
  rollbackTracker.observeBucket({
    bucketKey: rKey,
    poolKey: 'Gemini',
    win: '5h',
    officialUsedPct: ru5,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: rt,
    cycleCostUsd: rc5,
    cycleCalls: 14,
    poolLastActivityMs: rt,
    activeSessionCount10m: 1,
    nowMs: rt,
  });
  assert.equal(
    rollbackTracker._buckets.get(rKey).hasExternalUsage,
    false,
    'delayed local step flush within reconcile window cancels false temporary external_usage'
  );
  assert.equal(rollbackTracker._buckets.get(rKey).externalUsedPct, 0);

  // 2f. Incomplete local progressive scan must not stamp baseline hasExternalUsage
  const scanTracker = createQuotaReservationTracker();
  const scanPools = mkPools(15.0, 22.0);
  scanTracker.updatePools({
    endpointId: 'local',
    accountScope: 'rebuilding@example.com',
    quotaPoolsMap: scanPools,
    poolCycleStats: mkStats(0, 0, 0, { sess: 0 }),
    localScanIncomplete: true,
    quotaFetchedAtMs: T0,
    nowMs: T0,
  });
  assert.equal(
    scanPools.get('Gemini').rateEstimate?.externalUsage ?? null,
    null,
    'baseline poll while local cache scan is incomplete must not flag external_usage'
  );

  // 2g. Real-log regressions:
  // (i) Uncalibrated Pro cold-start lease_rejected must not stamp hasExternalUsage or deadlock rate=null
  const proTracker = createQuotaReservationTracker();
  const pKey = 'local::solo-pro@example.com::Gemini::5h';
  let pt = T0;
  proTracker.observeBucket({
    bucketKey: pKey,
    poolKey: 'Gemini',
    win: '5h',
    officialUsedPct: 4.5,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: pt,
    cycleCostUsd: 1.4,
    cycleCalls: 12,
    poolLastActivityMs: pt,
    activeSessionCount10m: 1,
    nowMs: pt,
  });
  // Cold-start lease jumps +0.626% while ratePctPerUsd is still null (reset ratePctPerUsd to simulate Pro cold start)
  proTracker._buckets.get(pKey).ratePctPerUsd = null;
  proTracker._buckets.get(pKey).rateSamples = 0;
  pt += 15_000;
  proTracker.observeBucket({
    bucketKey: pKey,
    poolKey: 'Gemini',
    win: '5h',
    officialUsedPct: 5.126,
    resetTimeMs: RESET_5H,
    quotaFetchedAtMs: pt,
    cycleCostUsd: 1.4,
    cycleCalls: 12,
    poolLastActivityMs: pt,
    activeSessionCount10m: 1,
    nowMs: pt,
  });
  // 3 normal Pro 1:1 turns (~3.33 %/$) evict the cold-start lease WITHOUT poisoning hasExternalUsage
  let pu = 5.126;
  let pc = 1.4;
  for (let i = 0; i < 3; i += 1) {
    pt += 20_000;
    pc = +(pc + 0.07).toFixed(4);
    pu = +(pu + 0.233).toFixed(4);
    proTracker.observeBucket({
      bucketKey: pKey,
      poolKey: 'Gemini',
      win: '5h',
      officialUsedPct: pu,
      resetTimeMs: RESET_5H,
      quotaFetchedAtMs: pt,
      cycleCostUsd: pc,
      cycleCalls: 13 + i,
      poolLastActivityMs: pt,
      activeSessionCount10m: 1,
      nowMs: pt,
    });
  }
  assert.equal(
    proTracker._buckets.get(pKey).hasExternalUsage,
    false,
    'evicting an uncalibrated cold-start lease on a Pro account must not stamp hasExternalUsage'
  );

  // (ii) 5h-only +1.0% jump with 0.0% weekly movement on calibrated 4:1 pool is a 5h-only server lease, not external_usage
  const fiveHLeaseTracker = createQuotaReservationTracker();
  let ft = T0;
  let fu5 = 10.0;
  let fuw = 2.5;
  let fc5 = 15.0;
  let fcw = 15.0;
  fiveHLeaseTracker.updatePools({
    endpointId: 'local',
    accountScope: 'fiveh-lease@example.com',
    quotaPoolsMap: mkPools(fu5, fuw),
    poolCycleStats: mkStats(fc5, fcw, ft),
    runningPoolKeys: new Set(['Gemini']),
    quotaFetchedAtMs: ft,
    nowMs: ft,
  });
  for (let i = 0; i < 3; i += 1) {
    ft += 20_000;
    fc5 = +(fc5 + 0.3).toFixed(4);
    fcw = +(fcw + 0.3).toFixed(4);
    fu5 = +(fu5 + 0.2).toFixed(4);
    fuw = +(fuw + 0.05).toFixed(4);
    fiveHLeaseTracker.updatePools({
      endpointId: 'local',
      accountScope: 'fiveh-lease@example.com',
      quotaPoolsMap: mkPools(fu5, fuw),
      poolCycleStats: mkStats(fc5, fcw, ft),
      runningPoolKeys: new Set(['Gemini']),
      quotaFetchedAtMs: ft,
      nowMs: ft,
    });
  }
  const fLastAct = ft;
  ft += 5 * 60 * 1000; // past idle grace, yet weekly moves 0.000% while 5h jumps +1.000%
  fu5 = +(fu5 + 1.0).toFixed(4);
  const pFiveHOnly = mkPools(fu5, fuw);
  fiveHLeaseTracker.updatePools({
    endpointId: 'local',
    accountScope: 'fiveh-lease@example.com',
    quotaPoolsMap: pFiveHOnly,
    poolCycleStats: mkStats(fc5, fcw, fLastAct, { sess: 0 }),
    runningPoolKeys: new Set(),
    quotaFetchedAtMs: ft,
    nowMs: ft,
  });
  assert.equal(
    pFiveHOnly.get('Gemini').rateEstimate?.externalUsage ?? null,
    null,
    '5h-only +1.0% jump with 0.000% weekly movement must not trigger external_usage'
  );
  assert.equal(pFiveHOnly.get('Gemini').externalUsedPct, 0);
});

test('quota-reservation: multi-user baseline/reset init, tentative lease expiry reconciliation, rate protection & strict conservation', () => {
  const mkPools = (u5, uw, reset5h = RESET_5H, resetWk = RESET_WK) =>
    new Map([
      [
        'Gemini',
        {
          poolKey: 'Gemini',
          poolLabel: 'Gemini',
          family: 'Gemini',
          has5h: true,
          hasWeekly: true,
          remainingFraction: 1 - u5 / 100,
          usedPct: +(u5).toFixed(1),
          resetTime: new Date(reset5h).toISOString(),
          weeklyRemainingFraction: 1 - uw / 100,
          weeklyUsedPct: +(uw).toFixed(1),
          weeklyResetTime: new Date(resetWk).toISOString(),
        },
      ],
    ]);
  const mkStats = (c5, cw, calls5, callsW, lastActMs, sess = 0) =>
    new Map([
      [
        'Gemini',
        {
          cycle5h: { costUsd: c5, calls: calls5, unpricedCalls: 0 },
          cycleWeekly: { costUsd: cw, calls: callsW, unpricedCalls: 0 },
          exactCost5hUsd: c5,
          exactCostWeeklyUsd: cw,
          recent10m: { lastActivityMs: lastActMs, activeSessionCount: sess, costUsd: sess > 0 ? 0.2 : 0 },
        },
      ],
    ]);

  // 1. Baseline external usage respects localScanIncomplete & hasUnknownRunningPool guards
  const guardTracker = createQuotaReservationTracker();
  const pUnknown = mkPools(16.0, 24.0);
  guardTracker.updatePools({
    endpointId: 'local',
    accountScope: 'unknown-run@example.com',
    quotaPoolsMap: pUnknown,
    poolCycleStats: mkStats(0, 0, 0, 0, 0, 0),
    hasUnknownRunningPool: true,
    quotaFetchedAtMs: T0,
    nowMs: T0,
  });
  assert.equal(pUnknown.get('Gemini').externalUsedPct, 0, 'hasUnknownRunningPool blocks baseline external attribution');
  assert.equal(pUnknown.get('Gemini').weeklyExternalUsedPct, 0);

  // 2. Clean shared cold-start + calibration + cycle reset with pre-existing external burn
  const tracker = createQuotaReservationTracker();
  let ts = T0;
  let u5 = 12.0;
  let uw = 25.0;
  let c5 = 0;
  let cw = 0;
  let calls = 0;

  const p0 = mkPools(u5, uw);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'shared-team@example.com',
    quotaPoolsMap: p0,
    poolCycleStats: mkStats(c5, cw, calls, calls, 0, 0),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(p0.get('Gemini').externalUsedPct, 12.0);
  assert.equal(p0.get('Gemini').weeklyExternalUsedPct, 25.0);
  assert.equal(p0.get('Gemini').reservedPct, 0);

  // Calibrate cleanly via 4 local steps: 5h = 2.0 %/$, weekly = 0.5 %/$
  for (let i = 0; i < 4; i += 1) {
    ts += 20_000;
    c5 = +(c5 + 0.1).toFixed(4);
    cw = +(cw + 0.1).toFixed(4);
    calls += 1;
    u5 = +(u5 + 0.2).toFixed(4);
    uw = +(uw + 0.05).toFixed(4);
    const pCal = mkPools(u5, uw);
    tracker.updatePools({
      endpointId: 'local',
      accountScope: 'shared-team@example.com',
      quotaPoolsMap: pCal,
      poolCycleStats: mkStats(c5, cw, calls, calls, ts, 1),
      runningPoolKeys: new Set(['Gemini']),
      quotaFetchedAtMs: ts,
      nowMs: ts,
    });
    const g = pCal.get('Gemini');
    assert.ok(g.externalUsedPct >= 0 && g.reservedPct >= 0);
    assert.ok(g.externalUsedPct + g.reservedPct <= g.usedPct + 1e-6);
  }
  const st5h = tracker._buckets.get('local::shared-team@example.com::Gemini::5h');
  const stWk = tracker._buckets.get('local::shared-team@example.com::Gemini::weekly');
  assert.ok(Math.abs(st5h.ratePctPerUsd - 2.0) < 0.05);
  assert.ok(Math.abs(stWk.ratePctPerUsd - 0.5) < 0.02);

  // 3. External idle burst activates shared-active mode; symmetric 5h+weekly attribution even when 5h delta is < 0.30%
  const idleRef = ts;
  ts += 5 * 60 * 1000;
  u5 = +(u5 + 0.25).toFixed(4); // < 0.30 idle 5h threshold, buffered
  uw = +(uw + 0.15).toFixed(4); // >= 0.12 idle weekly threshold -> triggers symmetric flush on 5h!
  const pSym = mkPools(u5, uw);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'shared-team@example.com',
    quotaPoolsMap: pSym,
    poolCycleStats: mkStats(c5, cw, calls, calls, idleRef, 0),
    runningPoolKeys: new Set(),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(pSym.get('Gemini').externalUsedPct, 12.3, '5h buffered idle external flushed symmetrically with weekly');
  assert.equal(pSym.get('Gemini').weeklyExternalUsedPct, 25.2);

  // 4. Rate protection: repeated small concurrent external bursts during shared-active must NOT corrupt ratePctPerUsd
  for (let i = 0; i < 6; i += 1) {
    ts += 15_000;
    c5 = +(c5 + 0.05).toFixed(4); // expected +0.10% 5h, +0.025% wk
    cw = +(cw + 0.05).toFixed(4);
    calls += 1;
    u5 = +(u5 + 0.25).toFixed(4); // inflated by +0.15% external (below 0.35 jump threshold)
    uw = +(uw + 0.03).toFixed(4); // slight weekly inflation
    tracker.updatePools({
      endpointId: 'local',
      accountScope: 'shared-team@example.com',
      quotaPoolsMap: mkPools(u5, uw),
      poolCycleStats: mkStats(c5, cw, calls, calls, ts, 1),
      runningPoolKeys: new Set(['Gemini']),
      quotaFetchedAtMs: ts,
      nowMs: ts,
    });
  }
  assert.ok(
    Math.abs(st5h.ratePctPerUsd - 2.0) < 0.1,
    `5h rate must resist concurrent external inflation (got ${st5h.ratePctPerUsd})`
  );

  // 5. Medium concurrent shared proportional burst (+0.24% 5h, +0.06% wk excess) caught cleanly when externalActiveRecently
  const extBeforeCo = st5h.externalUsedPct;
  const wkExtBeforeCo = stWk.externalUsedPct;
  ts += 15_000;
  c5 = +(c5 + 0.05).toFixed(4);
  cw = +(cw + 0.05).toFixed(4);
  calls += 1;
  u5 = +(u5 + 0.34).toFixed(4); // +0.10 local + 0.24 external
  uw = +(uw + 0.085).toFixed(4); // +0.025 local + 0.06 external
  const pMedCo = mkPools(u5, uw);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'shared-team@example.com',
    quotaPoolsMap: pMedCo,
    poolCycleStats: mkStats(c5, cw, calls, calls, ts, 1),
    runningPoolKeys: new Set(['Gemini']),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(pMedCo.get('Gemini').reservedPct, 0);
  assert.ok(st5h.externalUsedPct > extBeforeCo + 0.2, 'medium shared proportional burst attributed to 5h external');
  assert.ok(stWk.externalUsedPct > wkExtBeforeCo + 0.05, 'medium shared proportional burst attributed to weekly external');

  // 6. Tentative lease expiry without refund reconciles unrefunded amount into externalUsedPct (instead of inflating self-used)
  const extBeforeTent = st5h.externalUsedPct;
  ts += 15_000;
  c5 = +(c5 + 0.05).toFixed(4);
  cw = +(cw + 0.05).toFixed(4);
  calls += 1;
  u5 = +(u5 + 1.1).toFixed(4); // +0.10 local + 1.00 excess on 5h only -> tentative lease!
  uw = +(uw + 0.025).toFixed(4);
  const pTentJump = mkPools(u5, uw);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'shared-team@example.com',
    quotaPoolsMap: pTentJump,
    poolCycleStats: mkStats(c5, cw, calls, calls, ts, 1),
    runningPoolKeys: new Set(['Gemini']),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(pTentJump.get('Gemini').reservedPct, 0, 'tentative lease stays hidden');
  assert.equal(st5h.activeLeases.length, 1);
  assert.equal(st5h.activeLeases[0].tentative, true);

  // Advance past QR_TENTATIVE_LEASE_TTL_MS with NO refund and NO absorption (cached quota poll) -> reconciles +1.0% into externalUsedPct!
  ts += QR_TENTATIVE_LEASE_TTL_MS + 5_000;
  const pTentExp = mkPools(u5, uw);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'shared-team@example.com',
    quotaPoolsMap: pTentExp,
    poolCycleStats: mkStats(c5, cw, calls, calls, ts - QR_TENTATIVE_LEASE_TTL_MS, 0),
    runningPoolKeys: new Set(),
    quotaFetchedAtMs: ts - QR_TENTATIVE_LEASE_TTL_MS - 5_000, // cached poll
    nowMs: ts,
  });
  assert.equal(st5h.activeLeases.length, 0, 'tentative lease pruned on TTL expiry');
  assert.ok(
    st5h.externalUsedPct >= extBeforeTent + 0.9,
    `expired unrefunded tentative lease attributed to externalUsedPct (before=${extBeforeTent}, after=${st5h.externalUsedPct})`
  );
  const gExp = pTentExp.get('Gemini');
  assert.ok(
    gExp.externalUsedPct + gExp.reservedPct <= gExp.usedPct + 1e-6,
    'conservation invariant holds after tentative expiry reconciliation'
  );

  // 7. Tentative lease that IS refunded before expiry must NOT inflate externalUsedPct
  const extBeforeRefundTent = st5h.externalUsedPct;
  ts += 15_000;
  c5 = +(c5 + 0.05).toFixed(4);
  cw = +(cw + 0.05).toFixed(4);
  calls += 1;
  u5 = +(u5 + 1.1).toFixed(4); // another +1.0% tentative lease
  uw = +(uw + 0.025).toFixed(4);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'shared-team@example.com',
    quotaPoolsMap: mkPools(u5, uw),
    poolCycleStats: mkStats(c5, cw, calls, calls, ts, 1),
    runningPoolKeys: new Set(['Gemini']),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  const lastActBeforeRef = ts;
  // Idle 6 min -> server refunds -1.0% directly -> active lease cleared via refund, externalUsedPct unchanged!
  ts += 6 * 60 * 1000;
  u5 = +(u5 - 1.0).toFixed(4);
  const pRefunded = mkPools(u5, uw);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'shared-team@example.com',
    quotaPoolsMap: pRefunded,
    poolCycleStats: mkStats(c5, cw, calls, calls, lastActBeforeRef, 0),
    runningPoolKeys: new Set(),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(st5h.activeLeases.length, 0);
  assert.ok(
    Math.abs(st5h.externalUsedPct - extBeforeRefundTent) < 0.05,
    'refunded tentative lease must not inflate externalUsedPct'
  );

  // 8. Cycle reset with pre-existing external burn initializes externalUsedPct cleanly
  ts += 6 * 3600 * 1000;
  const nextReset5h = RESET_5H + 5 * 3600 * 1000;
  const pResetExt = mkPools(8.5, uw, nextReset5h, RESET_WK);
  tracker.updatePools({
    endpointId: 'local',
    accountScope: 'shared-team@example.com',
    quotaPoolsMap: pResetExt,
    poolCycleStats: mkStats(0, cw, 0, calls, lastActBeforeRef, 0),
    runningPoolKeys: new Set(),
    quotaFetchedAtMs: ts,
    nowMs: ts,
  });
  assert.equal(pResetExt.get('Gemini').externalUsedPct, 8.5, 'cycle reset with 0 local calls initializes externalUsedPct');
  assert.equal(pResetExt.get('Gemini').reservedPct, 0);
});
