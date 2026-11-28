import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSafetyMonitorScanner,
  discoverSafetyMonitorLogSources,
  smIsStrictRateLimit429Line,
  summarizeSafetyMonitorWindow,
} from '../backend/safety-monitor-scanner.mjs';
import { createQuotaReservationTracker } from '../backend/quota-reservation.mjs';

function makeGlogTs(dateMs) {
  const d = new Date(dateMs);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getMonth() + 1)}${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}000`;
}

test('discoverSafetyMonitorLogSources resolves custom APPDATA/XDG paths and deduplicates CLI logs', () => {
  const root = mkdtempSync(join(tmpdir(), 'ag-sm-disc-'));
  try {
    const winAppData = join(root, 'CustomRoaming');
    const winLog = join(winAppData, 'Antigravity', 'logs', 'language_server.log');
    mkdirSync(join(winAppData, 'Antigravity', 'logs'), { recursive: true });
    writeFileSync(winLog, '', 'utf8');

    const geminiDir = join(root, 'gemini');
    const cliLogDir = join(geminiDir, 'antigravity-cli', 'log');
    mkdirSync(cliLogDir, { recursive: true });
    writeFileSync(join(cliLogDir, 'cli-20261128_120000.log'), '', 'utf8');
    writeFileSync(join(geminiDir, 'antigravity-cli', 'cli.log'), '', 'utf8');

    const winSources = discoverSafetyMonitorLogSources({
      env: { APPDATA: winAppData, ANTIGRAVITY_GEMINI_DIR: geminiDir },
      platform: 'win32',
      homeDir: root,
    });
    assert.equal(winSources.length, 2);
    assert.ok(winSources.some((s) => s.kind === 'desktop' && s.path === winLog));
    assert.ok(
      winSources.some((s) => s.kind === 'cli' && s.path.endsWith('cli-20261128_120000.log'))
    );
    assert.equal(
      winSources.some((s) => s.path.endsWith(`${join('antigravity-cli', 'cli.log')}`)),
      false,
      'must skip top-level cli.log when rotated log/cli-*.log exists'
    );

    // Fallback to cli.log when log/cli-*.log does not exist
    const emptyGemini = join(root, 'gemini-fallback');
    mkdirSync(join(emptyGemini, 'antigravity-cli'), { recursive: true });
    const topCliLog = join(emptyGemini, 'antigravity-cli', 'cli.log');
    writeFileSync(topCliLog, '', 'utf8');

    const xdgDir = join(root, 'xdg');
    const linuxLog = join(xdgDir, 'Antigravity', 'logs', 'language_server.log');
    mkdirSync(join(xdgDir, 'Antigravity', 'logs'), { recursive: true });
    writeFileSync(linuxLog, '', 'utf8');

    const linuxSources = discoverSafetyMonitorLogSources({
      env: { XDG_CONFIG_HOME: xdgDir, ANTIGRAVITY_GEMINI_DIR: emptyGemini },
      platform: 'linux',
      homeDir: root,
    });
    assert.equal(linuxSources.length, 2);
    assert.ok(linuxSources.some((s) => s.kind === 'desktop' && s.path === linuxLog));
    assert.ok(linuxSources.some((s) => s.kind === 'cli' && s.path === topCliLog));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('smIsStrictRateLimit429Line rejects timestamps/ports/UUIDs/csrf/runner reasons and detects real 429', () => {
  assert.equal(smIsStrictRateLimit429Line('http_helpers.go', 'URL: https://example.com:2429/v1'), false);
  assert.equal(smIsStrictRateLimit429Line('cascade_manager.go', 'Trace: 0x00429abc elapsed 1.429s'), false);
  assert.equal(smIsStrictRateLimit429Line('csrf_interceptor.go', 'HTTP 429 RESOURCE_EXHAUSTED'), false);
  assert.equal(
    smIsStrictRateLimit429Line(
      'runner.go',
      'Monitor sir_flash_lite FINISHED: triggered=false, reason="User asked about HTTP 429 RESOURCE_EXHAUSTED errors", duration=1.2s'
    ),
    false
  );
  assert.equal(smIsStrictRateLimit429Line('http_helpers.go', 'rpc error: code = RESOURCE_EXHAUSTED'), true);
  assert.equal(smIsStrictRateLimit429Line('http_helpers.go', 'HTTP 429 Too Many Requests'), true);
  assert.equal(smIsStrictRateLimit429Line('client.go', 'request failed with status code: 429'), true);
});

test('safety-monitor-scanner parses Desktop funnel, conjoined Windows CLI lines, incremental append, and restart truncation', () => {
  const root = mkdtempSync(join(tmpdir(), 'ag-sm-scan-'));
  try {
    const logPath = join(root, 'language_server.log');
    const baseMs = Date.now() - 10 * 60 * 1000;
    const t1 = makeGlogTs(baseMs);
    const t2 = makeGlogTs(baseMs + 500);
    const t3 = makeGlogTs(baseMs + 1500);
    const t4 = makeGlogTs(baseMs + 2000);
    const t5 = makeGlogTs(baseMs + 8500);
    const t6 = makeGlogTs(baseMs + 9000);

    // Includes Desktop ERROR prefix, same-tid attribution, normal non-monitor streamGenerateContent,
    // conjoined Windows CLI lines without newline, false-positive 429 noise, and real fallback/429.
    const initialLines = [
      `ERROR: logging before google.Init: I${t1}   10001 cascade_manager.go:99] noisy line 1.429s port :2429`,
      `ERROR: logging before google.Init: I${t1}   10010 http_helpers.go:748] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse Trace: 0x1`,
      `ERROR: logging before google.Init: I${t1}   20001 llm_monitor.go:349] LLM Monitor sir_flash_lite: Starting evaluation`,
      `ERROR: logging before google.Init: I${t2}   20001 llm_monitor.go:636] LLM Monitor sir_flash_lite: Trajectory formatted, length: 1200`,
      `ERROR: logging before google.Init: I${t2}   20001 llm_monitor.go:712] LLM Monitor sir_flash_lite: Calling LLM (model: MODEL_TIER_FLASH_LITE)`,
      `ERROR: logging before google.Init: I${t3}   20001 http_helpers.go:748] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse Trace: 0x2`,
      `ERROR: logging before google.Init: I${t3}   20001 llm_monitor.go:785] LLM Monitor sir_flash_lite: Evaluation complete. Triggered: true, Severity: 3, Confidence: 9`,
      // Conjoined two glog lines on a single line (Windows CLI concurrent goroutine flush)
      `I${t4}   20002 llm_monitor.go:331] LLM Monitor severe_internal_risks_agy: Starting evaluationI${t4}   20002 llm_monitor.go:622] LLM Monitor severe_internal_risks_agy: Trajectory formatted, length: 295000`,
      `I${t4}   20002 llm_monitor.go:713] LLM Monitor severe_internal_risks_agy: Calling LLM (model: gemini-4-hydrogen-sonar)`,
      `I${t5}   20002 http_helpers.go:709] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse Trace: 0x3`,
      `I${t6}   20002 llm_monitor.go:786] LLM Monitor severe_internal_risks_agy: Evaluation complete. Triggered: false, Severity: 0, Confidence: 0`,
      `I${t6}   20003 runner.go:898] Monitor severe_internal_risks_agy FINISHED: triggered=false, reason="mentions 429 RESOURCE_EXHAUSTED safely", duration=7.0s`,
    ].join('\n') + '\n';
    writeFileSync(logPath, initialLines, 'utf8');

    let persisted = null;
    const makeScanner = () =>
      createSafetyMonitorScanner({
        loadState: () => persisted,
        saveState: (payload) => {
          persisted = JSON.parse(JSON.stringify(payload));
        },
        discoverSources: () => [{ path: logPath, key: 'desktop-log', kind: 'desktop' }],
        scanMinIntervalMs: 0,
        persistMinIntervalMs: 0,
      });

    const scanner1 = makeScanner();
    const snap1 = scanner1.refresh({ nowMs: baseMs + 20_000, force: true });
    assert.equal(snap1.hasActiveSources, true);
    assert.equal(snap1.window5h.totalStreamGen, 3);
    assert.equal(snap1.window5h.hiddenStreamGen, 2);
    assert.equal(snap1.window5h.flashLiteCalls, 1);
    assert.equal(snap1.window5h.flashLiteTriggered, 1);
    assert.equal(snap1.window5h.heavyCalls, 1);
    assert.equal(snap1.window5h.heavyTriggered, 0);
    assert.equal(snap1.window5h.heavyFalseAlarmRate, 1);
    assert.equal(snap1.window5h.heavyTrajChars, 295000);
    assert.equal(snap1.window5h.rateLimit429Count, 0);
    assert.equal(snap1.window5h.fallbackCount, 0);
    assert.equal(snap1.recentHeavyEvents.length, 1);
    assert.equal(snap1.recentHeavyEvents[0].trajChars, 295000);
    assert.ok(snap1.window5h.blockedMs >= 7000);
    assert.ok(persisted && persisted.version === 1);

    // Re-scanning unchanged file does not double-count
    const snap1Again = scanner1.refresh({ nowMs: baseMs + 25_000, force: true });
    assert.equal(snap1Again.window5h.heavyCalls, 1);
    assert.equal(snap1Again.window5h.totalStreamGen, 3);

    // Incremental append with real 429 + fallback
    const t7 = makeGlogTs(baseMs + 30_000);
    appendFileSync(
      logPath,
      [
        `I${t7}   30001 http_helpers.go:748] HTTP 429 RESOURCE_EXHAUSTED`,
        `I${t7}   30002 runner.go:702] Monitor severe_internal_risks_agy: parent sir_flash_lite failed, running it anyway`,
      ].join('\n') + '\n',
      'utf8'
    );
    const snap2 = scanner1.refresh({ nowMs: baseMs + 35_000, force: true });
    assert.equal(snap2.window5h.rateLimit429Count, 1);
    assert.equal(snap2.window5h.fallbackCount, 1);
    assert.equal(snap2.alerts.has429Fallback, true);

    // Desktop restart truncates language_server.log -> new scanner restores persisted buckets & reads fresh truncated log without losing history
    const t8 = makeGlogTs(baseMs + 90_000);
    const t9 = makeGlogTs(baseMs + 96_000);
    writeFileSync(
      logPath,
      [
        `I${t8}   40001 llm_monitor.go:349] LLM Monitor severe_internal_risks_agy: Starting evaluation`,
        `I${t8}   40001 llm_monitor.go:636] LLM Monitor severe_internal_risks_agy: Trajectory formatted, length: 280000`,
        `I${t8}   40001 llm_monitor.go:712] LLM Monitor severe_internal_risks_agy: Calling LLM (model: gemini-4-hydrogen-sonar)`,
        `I${t9}   40001 http_helpers.go:748] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse Trace: 0x9`,
        `I${t9}   40001 llm_monitor.go:785] LLM Monitor severe_internal_risks_agy: Evaluation complete. Triggered: false, Severity: 0, Confidence: 0`,
      ].join('\n') + '\n',
      'utf8'
    );
    const scanner2 = makeScanner();
    const snap3 = scanner2.refresh({ nowMs: baseMs + 100_000, force: true });
    assert.equal(snap3.window5h.heavyCalls, 2, 'historical count preserved across Desktop log truncation');
    assert.equal(snap3.window5h.heavyTrajChars, 575000);
    assert.equal(snap3.window5h.totalStreamGen, 4);
    assert.equal(snap3.recentHeavyEvents.length, 2);

    const winSub = summarizeSafetyMonitorWindow(
      snap3.minuteBuckets,
      snap3.recentHeavyEvents,
      baseMs + 80_000,
      baseMs + 100_000
    );
    assert.equal(winSub.heavyCalls, 1);
    assert.equal(winSub.heavyTrajChars, 280000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quota-reservation attributes local gemini-4-hydrogen-sonar jumps to safetyReviewUsedPct without false externalUsage, while keeping real external detection intact', () => {
  const tracker = createQuotaReservationTracker();
  const baseMs = Date.parse('2026-11-28T03:30:00Z');
  const reset5hIso = new Date(baseMs + 5 * 3600 * 1000).toISOString();
  const resetWkIso = new Date(baseMs + 7 * 24 * 3600 * 1000).toISOString();

  const makePools = (used5h, usedWk, claude5h = 0, claudeWk = 0) =>
    new Map([
      [
        'Gemini',
        {
          poolKey: 'Gemini',
          family: 'Gemini',
          has5h: true,
          hasWeekly: true,
          remainingFraction: (100 - used5h) / 100,
          weeklyRemainingFraction: (100 - usedWk) / 100,
          resetTime: reset5hIso,
          weeklyResetTime: resetWkIso,
        },
      ],
      [
        'Claude & GPT',
        {
          poolKey: 'Claude & GPT',
          family: 'Claude & GPT',
          has5h: true,
          hasWeekly: true,
          remainingFraction: (100 - claude5h) / 100,
          weeklyRemainingFraction: (100 - claudeWk) / 100,
          resetTime: reset5hIso,
          weeklyResetTime: resetWkIso,
        },
      ],
    ]);

  const makeStats = (cost5h, calls5h, costWk, callsWk, lastMs) =>
    new Map([
      [
        'Gemini',
        {
          exactCost5hUsd: cost5h,
          exactCostWeeklyUsd: costWk,
          cycle5h: { costUsd: cost5h, calls: calls5h, tokens: calls5h * 100_000, unpricedCalls: 0 },
          cycleWeekly: { costUsd: costWk, calls: callsWk, tokens: callsWk * 100_000, unpricedCalls: 0 },
          modelCosts5h: { 'Gemini 4 Neon': cost5h },
          modelCostsWeekly: { 'Gemini 4 Neon': costWk },
          recent10m: { lastActivityMs: lastMs, activeSessionCount: 1, costUsd: 0.5 },
        },
      ],
      [
        'Claude & GPT',
        {
          exactCost5hUsd: 0,
          exactCostWeeklyUsd: 0,
          cycle5h: { costUsd: 0, calls: 0, tokens: 0, unpricedCalls: 0 },
          cycleWeekly: { costUsd: 0, calls: 0, tokens: 0, unpricedCalls: 0 },
          recent10m: { lastActivityMs: 0, activeSessionCount: 0, costUsd: 0 },
        },
      ],
    ]);

  // 1. Calibrate clean baseline: 5h = 3.3333 %/$ ($30), weekly = 0.83333 %/$ ($120)
  // Note: 5h step cost $0.12 => deltaOfficial = 0.40% (>= 0.35%), also verifying 5h rate sampling does not stall!
  let t = baseMs;
  let u5 = 0;
  let uw = 0;
  let c = 0;
  let calls = 0;
  tracker.updatePools({
    accountScope: 'solo@example.com',
    quotaPoolsMap: makePools(0, 0),
    poolCycleStats: makeStats(0, 0, 0, 0, t),
    runningPoolKeys: new Set(['Gemini']),
    quotaFetchedAtMs: t,
    nowMs: t,
  });

  // First 3 clean small steps ($0.08 => +0.267% 5h, +0.067% wk) + 2 larger normal steps ($0.12 => +0.40% 5h, +0.10% wk)
  for (const stepUsd of [0.08, 0.08, 0.08, 0.12, 0.12]) {
    t += 20_000;
    c += stepUsd;
    calls += 1;
    u5 += stepUsd * (100 / 30);
    uw += stepUsd * (100 / 120);
    tracker.updatePools({
      accountScope: 'solo@example.com',
      quotaPoolsMap: makePools(u5, uw),
      poolCycleStats: makeStats(c, calls, c, calls, t),
      runningPoolKeys: new Set(['Gemini']),
      quotaFetchedAtMs: t,
      nowMs: t,
    });
  }

  const st5hBefore = tracker._buckets.get('local::solo@example.com::Gemini::5h');
  assert.ok(
    st5hBefore.rateSamples >= 5,
    `5h rate should accept clean $0.12 (0.40%) steps without stalling, got ${st5hBefore.rateSamples}`
  );

  // 2. Simulate 4 consecutive local gemini-4-hydrogen-sonar escalations (+0.54% 5h / +0.135% weekly each, dCost=0)
  const recentHeavyEvents = [];
  const minuteBuckets = Object.create(null);
  let lastPools = null;
  for (let i = 0; i < 4; i += 1) {
    t += 25_000;
    const sonarDoneMs = t - 4000;
    recentHeavyEvents.push({
      tsMs: sonarDoneMs,
      startedAtMs: sonarDoneMs - 7000,
      name: 'severe_internal_risks_agy',
      model: 'gemini-4-hydrogen-sonar',
      trajChars: 300_000,
      triggered: false,
      durationMs: 7000,
    });
    const mk = String(Math.floor(sonarDoneMs / 60_000));
    minuteBuckets[mk] = minuteBuckets[mk] || { s: 0, h: 0, fl: 0, flTrig: 0, sn: 0, snTrig: 0, ch: 0, flCh: 0, blMs: 0, r429: 0, fb: 0 };
    minuteBuckets[mk].sn += 1;
    minuteBuckets[mk].ch += 300_000;

    u5 += 0.54;
    uw += 0.135;
    lastPools = makePools(u5, uw);
    tracker.updatePools({
      accountScope: 'solo@example.com',
      quotaPoolsMap: lastPools,
      poolCycleStats: makeStats(c, calls, c, calls, t),
      runningPoolKeys: new Set(['Gemini']),
      safetyMonitor: {
        hasActiveSources: true,
        recentHeavyEvents,
        minuteBuckets,
        lastHeavyEventAtMs: sonarDoneMs,
        lastAnyMonitorAtMs: sonarDoneMs,
      },
      quotaFetchedAtMs: t,
      nowMs: t,
    });
  }

  const gem = lastPools.get('Gemini');
  assert.equal(gem.externalUsedPct, 0, 'local sonar calls must not inflate 5h externalUsedPct');
  assert.equal(gem.weeklyExternalUsedPct, 0, 'local sonar calls must not inflate weekly externalUsedPct');
  assert.equal(gem.reservedPct, 0, 'local sonar calls must not spawn fake 5h leases');
  assert.ok(gem.safetyReviewUsedPct >= 2.0, `expected ~2.2% 5h safetyReviewUsedPct, got ${gem.safetyReviewUsedPct}`);
  assert.ok(gem.weeklySafetyReviewUsedPct >= 0.5, `expected ~0.5% weekly safetyReviewUsedPct, got ${gem.weeklySafetyReviewUsedPct}`);
  assert.equal(gem.rateEstimate?.externalUsage ?? null, null, 'no shared-active / family-group banner for solo sonar calls');

  // 3. Real external consumption on Claude & GPT (never shielded by Gemini sonar) AND idle Gemini jump without new sonar
  t += 6 * 60 * 1000; // idle > 4m
  u5 += 1.2;
  uw += 0.3;
  const poolsExt = makePools(u5, uw, 3.0, 1.0);
  tracker.updatePools({
    accountScope: 'solo@example.com',
    quotaPoolsMap: poolsExt,
    poolCycleStats: makeStats(c, calls, c, calls, t - 6 * 60 * 1000),
    runningPoolKeys: new Set(),
    safetyMonitor: {
      hasActiveSources: true,
      recentHeavyEvents,
      minuteBuckets,
      lastHeavyEventAtMs: recentHeavyEvents[recentHeavyEvents.length - 1].tsMs,
      lastAnyMonitorAtMs: recentHeavyEvents[recentHeavyEvents.length - 1].tsMs,
    },
    quotaFetchedAtMs: t,
    nowMs: t,
  });

  const gemExt = poolsExt.get('Gemini');
  const claudeExt = poolsExt.get('Claude & GPT');
  assert.ok(gemExt.externalUsedPct >= 1.1, 'real idle Gemini external usage without matching sonar must still be flagged');
  assert.equal(gemExt.rateEstimate?.externalUsage?.detected, true);
  assert.equal(claudeExt.externalUsedPct, 3.0, 'Claude & GPT pool must never be shielded by Gemini sonar logs');
});

test('quota-reservation retroactively heals pre-upgrade false externalUsage when observed cycle sonar logs explain the residual', () => {
  const nowMs = Date.parse('2026-11-28T04:50:00Z');
  const reset5hMs = nowMs + 3.6 * 3600 * 1000;
  const resetWkMs = nowMs + 5.5 * 24 * 3600 * 1000;
  const cycle5hStart = reset5hMs - 5 * 3600 * 1000;

  // Seed persisted state resembling pre-upgrade solo account polluted by 32 sonar calls
  const persisted = {
    version: 2,
    buckets: {
      'local::solo-upgrade@example.com::Gemini::5h': {
        resetTimeMs: reset5hMs,
        lastQuotaTs: nowMs - 5000,
        lastOfficialUsedPct: 56.0,
        lastCycleCostUsd: 12.0,
        lastCycleCalls: 120,
        lastModelCostsUsd: { 'Gemini 4 Neon': 12.0 },
        lastUnpricedCalls: 0,
        ratePctPerUsd: 3.3333,
        rateSamples: 1,
        rateWindow: [3.3333],
        modelRates: { 'Gemini 4 Neon': { ratePctPerUsd: 3.3333, rateSamples: 1, rateWindow: [3.3333], lastSeenMs: nowMs } },
        activeLeases: [],
        hasExternalUsage: true,
        lastExternalUsageAtMs: nowMs - 120_000,
        externalUsedPct: 16.0,
        externalEvents: 25,
      },
      'local::solo-upgrade@example.com::Gemini::weekly': {
        resetTimeMs: resetWkMs,
        lastQuotaTs: nowMs - 5000,
        lastOfficialUsedPct: 38.0,
        lastCycleCostUsd: 36.0,
        lastCycleCalls: 360,
        lastModelCostsUsd: { 'Gemini 4 Neon': 36.0 },
        lastUnpricedCalls: 0,
        ratePctPerUsd: 0.83333,
        rateSamples: 120,
        rateWindow: Array(20).fill(0.83333),
        modelRates: { 'Gemini 4 Neon': { ratePctPerUsd: 0.83333, rateSamples: 120, rateWindow: Array(20).fill(0.83333), lastSeenMs: nowMs } },
        activeLeases: [],
        hasExternalUsage: true,
        lastExternalUsageAtMs: nowMs - 120_000,
        externalUsedPct: 8.0,
        externalEvents: 10,
      },
    },
    events: [],
  };

  const tracker = createQuotaReservationTracker({ loadState: () => persisted });

  // Build observed safety logs: 32 sonar calls in 5h (9.6M chars => ~$5.24 => ~17.45% of 5h), 49 in weekly (14.7M chars => ~$8.02 => ~6.68% of weekly)
  const minuteBuckets = Object.create(null);
  const min5h = String(Math.floor((cycle5hStart + 600_000) / 60_000));
  minuteBuckets[min5h] = { s: 100, h: 50, fl: 200, flTrig: 32, sn: 32, snTrig: 0, ch: 9_600_000, flCh: 100_000, blMs: 220_000, r429: 0, fb: 0 };
  const minEarlierWk = String(Math.floor((cycle5hStart - 12 * 3600 * 1000) / 60_000));
  minuteBuckets[minEarlierWk] = { s: 60, h: 30, fl: 100, flTrig: 17, sn: 17, snTrig: 0, ch: 5_100_000, flCh: 50_000, blMs: 110_000, r429: 0, fb: 0 };

  const pools = new Map([
    [
      'Gemini',
      {
        poolKey: 'Gemini',
        family: 'Gemini',
        has5h: true,
        hasWeekly: true,
        remainingFraction: 0.44,
        weeklyRemainingFraction: 0.62,
        resetTime: new Date(reset5hMs).toISOString(),
        weeklyResetTime: new Date(resetWkMs).toISOString(),
      },
    ],
  ]);
  const stats = new Map([
    [
      'Gemini',
      {
        exactCost5hUsd: 12.0,
        exactCostWeeklyUsd: 36.0,
        cycle5h: { costUsd: 12.0, calls: 120, tokens: 35_000_000, unpricedCalls: 0 },
        cycleWeekly: { costUsd: 36.0, calls: 360, tokens: 115_000_000, unpricedCalls: 0 },
        modelCosts5h: { 'Gemini 4 Neon': 12.0 },
        modelCostsWeekly: { 'Gemini 4 Neon': 36.0 },
        recent10m: { lastActivityMs: nowMs - 10_000, activeSessionCount: 1, costUsd: 0.5 },
      },
    ],
  ]);

  // Even on a cached quota response (same quotaFetchedAtMs), retroactive reconciliation heals immediately
  tracker.updatePools({
    accountScope: 'solo-upgrade@example.com',
    quotaPoolsMap: pools,
    poolCycleStats: stats,
    runningPoolKeys: new Set(['Gemini']),
    safetyMonitor: {
      hasActiveSources: true,
      minuteBuckets,
      recentHeavyEvents: [],
      lastHeavyEventAtMs: nowMs - 110_000,
      lastAnyMonitorAtMs: nowMs - 10_000,
    },
    quotaFetchedAtMs: nowMs - 5000,
    nowMs,
  });

  const gem = pools.get('Gemini');
  assert.equal(gem.externalUsedPct, 0, '5h false externalUsedPct healed to 0');
  assert.equal(gem.weeklyExternalUsedPct, 0, 'weekly false externalUsedPct healed to 0');
  assert.equal(gem.rateEstimate?.externalUsage ?? null, null, 'false shared-active & family banner cleared');
  assert.ok(gem.safetyReviewUsedPct >= 15.0, `5h safetyReviewUsedPct promoted (${gem.safetyReviewUsedPct})`);
  assert.ok(gem.weeklySafetyReviewUsedPct >= 6.0, `weekly safetyReviewUsedPct promoted (${gem.weeklySafetyReviewUsedPct})`);
  assert.ok(
    gem.rateEstimate?.eqFull5hUsd >= 28 && gem.rateEstimate?.eqFull5hUsd <= 33,
    `cycle_ratio 5h estimate must subtract safetyReviewUsedPct instead of skewing lower, got $${gem.rateEstimate?.eqFull5hUsd}`
  );
});
