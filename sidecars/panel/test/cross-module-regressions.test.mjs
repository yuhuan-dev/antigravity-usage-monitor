import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { backendHarness } from './backend-harness.mjs';
import {
  extractContextBreakdown,
  extractLiveActivity,
  extractModelSteps,
  normalizeCachedStep,
} from '../trajectory-metrics.mjs';
import {
  formatCountdown,
  formatUsd,
  speedReasonText,
} from '../src/core/formatters.js';
import { createReactiveStore } from '../src/core/reactive.js';
import { i18nStore, setI18nLanguage } from '../src/i18n/index.js';
import { buildBundle, stripModuleSyntax } from '../scripts/build-bundle.mjs';

const nowMs = Date.now();
const nowIso = new Date(nowMs - 5_000).toISOString();
const doneIso = new Date(nowMs - 3_000).toISOString();
const promoMs = Date.parse('2026-11-17T12:00:00Z');
const promoNowIso = new Date(promoMs - 5_000).toISOString();
const promoDoneIso = new Date(promoMs - 3_000).toISOString();

test('BUG-01 & INCON-01: Google-proxied Claude/GPT/o-series never misclassify as Gemini, and M429/M322/M149/M20 resolve accurately', () => {
  const h = backendHarness({
    clock: () => promoMs,
    userStatus: {
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            modelOrAlias: { model: 'MODEL_CLAUDE_PROXY' },
            label: 'Claude Opus 4.6 (Google Vertex)',
            quotaInfo: { remainingFraction: 0.75, resetTime: new Date(nowMs + 3600_000).toISOString() },
          },
        ],
      },
    },
  });

  const infoClaude = h.resolveModelInfo('claude-opus-4-6', new Map(), 'API_PROVIDER_GOOGLE_GEMINI');
  assert.equal(infoClaude.family, 'Claude');
  const infoO3 = h.resolveModelInfo('o3-mini', new Map(), 'API_PROVIDER_GOOGLE_GEMINI');
  assert.equal(infoO3.family, 'GPT');

  // Calling resolveModelInfo with omitted dynamicModelMap must not throw (BUG-03)
  const infoDefaultMap = h.resolveModelInfo('MODEL_PLACEHOLDER_M320');
  assert.equal(infoDefaultMap.modelId, 'gemini-3.8-flash-low');
  assert.equal(infoDefaultMap.pricing?.input, 0.3);

  const m429 = h.resolveModelInfo('MODEL_PLACEHOLDER_M429', new Map(), 'API_PROVIDER_GOOGLE_GEMINI');
  assert.equal(m429.modelId, 'gemini-4-carbon-high');
  assert.equal(m429.shortName, 'carbon-4-high');

  const m322 = h.resolveModelInfo('MODEL_PLACEHOLDER_M322', new Map(), 'API_PROVIDER_GOOGLE_GEMINI');
  assert.equal(m322.modelId, 'gemini-3.8-flash-tiered');
  assert.equal(
    h.computeStepCost(
      {
        modelKey: 'MODEL_PLACEHOLDER_M322',
        inputTokens: 1_000_000,
        cacheReadTokens: 0,
        outputTokens: 0,
      },
      m322.pricing
    ),
    0.75
  );

  const m149 = h.resolveModelInfo('MODEL_PLACEHOLDER_M149', new Map(), 'API_PROVIDER_GOOGLE_GEMINI');
  assert.equal(m149.modelId, 'gemini-3.5-flash-high');

  const m20 = h.resolveModelInfo('MODEL_PLACEHOLDER_M20', new Map(), 'API_PROVIDER_GOOGLE_GEMINI');
  assert.equal(m20.modelId, 'gemini-3.5-flash');

  // Gemini Hydrogen ($1.50/$0.075/$7.50) & Helix ($0.30/$0.015/$2.50), shared Gemini pool
  const dynHydrogenMap = new Map([
    ['MODEL_PLACEHOLDER_M480', { modelId: '', label: 'Gemini 4 Hydrogen (High)' }],
    ['MODEL_PLACEHOLDER_M481', { modelId: '', label: 'Gemini 4 Hydrogen (Low)' }],
    ['MODEL_PLACEHOLDER_M482', { modelId: '', label: 'Gemini 4 Helix' }],
  ]);
  const hydroHigh = h.resolveModelInfo('MODEL_PLACEHOLDER_M480', dynHydrogenMap);
  assert.equal(hydroHigh.family, 'Gemini');
  assert.equal(hydroHigh.shortName, 'hydrogen-4-high');
  assert.deepEqual(
    { i: hydroHigh.pricing?.input, c: hydroHigh.pricing?.cache, o: hydroHigh.pricing?.output },
    { i: 1.5, c: 0.075, o: 7.5 }
  );
  const hydroLow = h.resolveModelInfo('MODEL_PLACEHOLDER_M481', dynHydrogenMap);
  assert.equal(hydroLow.shortName, 'hydrogen-4-low');
  assert.deepEqual(
    { i: hydroLow.pricing?.input, c: hydroLow.pricing?.cache, o: hydroLow.pricing?.output },
    { i: 1.5, c: 0.075, o: 7.5 }
  );
  const hydroCodename = h.resolveModelInfo('gemini-hydrogen');
  assert.equal(hydroCodename.family, 'Gemini');
  assert.equal(hydroCodename.label, 'Gemini Hydrogen');
  assert.equal(hydroCodename.pricing?.input, 1.5);
  assert.equal(hydroCodename.pricing?.output, 7.5);

  const helixInfo = h.resolveModelInfo('MODEL_PLACEHOLDER_M482', dynHydrogenMap);
  assert.equal(helixInfo.family, 'Gemini');
  assert.equal(helixInfo.shortName, 'helix-4');
  assert.deepEqual(
    { i: helixInfo.pricing?.input, c: helixInfo.pricing?.cache, o: helixInfo.pricing?.output },
    { i: 0.3, c: 0.015, o: 2.5 }
  );
  const helixCodename = h.resolveModelInfo('gemini-helix');
  assert.equal(helixCodename.family, 'Gemini');
  assert.equal(helixCodename.label, 'Gemini Helix');
  assert.equal(helixCodename.pricing?.output, 2.5);

  const { quotaPoolsMap } = h.buildOfficialQuotaPools(null, [
    {
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M480' },
      label: 'Gemini 4 Hydrogen (High)',
      quotaInfo: { remainingFraction: 0.8, resetTime: new Date(nowMs + 3600_000).toISOString() },
    },
    {
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M482' },
      label: 'Gemini 4 Helix',
      quotaInfo: { remainingFraction: 0.8, resetTime: new Date(nowMs + 3600_000).toISOString() },
    },
  ]);
  assert.equal(quotaPoolsMap.has('Hydrogen'), false, 'Hydrogen has no dedicated quota pool');
  assert.equal(quotaPoolsMap.has('Helix'), false, 'Helix has no dedicated quota pool');
  assert.equal(quotaPoolsMap.get('Gemini')?.isAvailable, true);
});

test('BUG-02 & BUG-11: ide:<uuid> external sessions do not double-count live conversations, only quota pools isolate cross-account entries, and orphan subagents never leak to top-level list', async () => {
  const reset5hIso = new Date(Date.now() + 4 * 3600_000).toISOString();
  const resetWkIso = new Date(Date.now() + 6 * 24 * 3600_000).toISOString();
  const stepObj = {
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      sourceTrajectoryStepInfo: { stepIndex: 1 },
      createdAt: nowIso,
      completedAt: doneIso,
      modelUsage: {
        model: 'MODEL_PLACEHOLDER_M318',
        inputTokens: '10000',
        cacheReadTokens: '20000',
        outputTokens: '5000',
      },
    },
  };
  const h = backendHarness({
    userStatus: { email: 'alice@example.com' },
    quotaSummary: {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.9, resetTime: reset5hIso },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.95, resetTime: resetWkIso },
          ],
        },
      ],
    },
    deepStats: {
      accountName: 'alice@example.com',
      perConvo: {
        // Same conversation ID as live 'abcd-1234' (case-insensitive, prefixed with 'ide:') -> must deduplicate!
        'ide:AbCd-1234': {
          accountName: 'alice@example.com',
          appSource: 'ide',
          entries: [
            { ts: nowIso, model: 'MODEL_PLACEHOLDER_M318', inp: 10000, cache: 20000, out: 5000, reasoning: 0 },
            { ts: doneIso, model: 'MODEL_PLACEHOLDER_M318', inp: 10000, cache: 20000, out: 5000, reasoning: 0 },
          ],
        },
        // Different account -> retained in global consumption, isolated out of Alice's quota pools!
        'ide:bob-conv': {
          accountName: 'bob@example.com',
          appSource: 'ide',
          entries: [
            { ts: nowIso, model: 'MODEL_PLACEHOLDER_M318', inp: 99000, cache: 0, out: 1000, reasoning: 0 },
          ],
        },
      },
    },
    cache: {
      'orphan-sub': {
        accountName: 'bob@example.com',
        isSubagent: true,
        parentCascadeId: 'deleted-parent',
        signature: 'v10-model-identity:sub',
        steps: extractModelSteps([stepObj]),
      },
    },
    summaries: {
      'abcd-1234': { stepCount: 1, lastModifiedTime: doneIso, status: 'IDLE' },
    },
    trajectories: {
      'abcd-1234': { trajectory: { steps: [stepObj] } },
    },
  });

  const p = await h.buildTelemetryPayloadInternal('abcd-1234', false, { range: 'all' });
  // ide:AbCd-1234 (70k) deduplicates live abcd-1234 (35k); global consumption retains ide:bob-conv (100k) + orphan-sub (35k)
  assert.equal(p.consumption.account.conversationsCount, 3);
  assert.equal(p.consumption.account.calls, 4);
  assert.equal(p.consumption.account.totalTokens, 205_000);
  // Quota pools & weekly cycle strictly isolate to alice@example.com (2 calls = 70,000 tokens)
  const geminiPool = p.quotas.pools.find((pool) => pool.poolKey === 'Gemini');
  assert.equal(geminiPool.cycle5h.calls, 2);
  assert.equal(geminiPool.cycle5h.tokens, 70_000);
  assert.equal(geminiPool.cycleWeekly.calls, 2);
  assert.equal(geminiPool.cycleWeekly.tokens, 70_000);
  assert.equal(p.quotas.weekly.calls, 2);
  assert.equal(p.quotas.weekly.tokens, 70_000);
  assert.equal(
    p.conversations.some((c) => c.cascadeId === 'orphan-sub'),
    false,
    'orphan subagent must not appear in top-level conversation dropdown'
  );
});

test('account switch preserves conversation list, locked session steps, and consumption history while isolating quota pools per step across mid-conversation switches', async () => {
  const baseMs = Date.now() - 60_000;
  const reset5hIso = new Date(baseMs + 4 * 3600_000).toISOString();
  const resetWkIso = new Date(baseMs + 6 * 24 * 3600_000).toISOString();
  const makeStepAt = (idx, inTok, outTok, offsetMs) => ({
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      sourceTrajectoryStepInfo: { stepIndex: idx },
      createdAt: new Date(baseMs + offsetMs).toISOString(),
      completedAt: new Date(baseMs + offsetMs + 1000).toISOString(),
      modelUsage: {
        model: 'MODEL_PLACEHOLDER_M318',
        inputTokens: String(inTok),
        cacheReadTokens: '0',
        outputTokens: String(outTok),
      },
    },
  });
  const makeQuota = (rem5h, remWk) => ({
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          { bucketId: 'gemini-5h', window: '5h', remainingFraction: rem5h, resetTime: reset5hIso },
          { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: remWk, resetTime: resetWkIso },
        ],
      },
    ],
  });

  const sharedStep1 = makeStepAt(1, 25_000, 5_000, 1_000); // 30,000
  const sharedStep2 = makeStepAt(2, 25_000, 5_000, 3_000); // 30,000
  const aliceOldStep = makeStepAt(1, 35_000, 5_000, 5_000); // 40,000

  const h = backendHarness({
    userStatus: { email: 'alice@example.com', userTier: { name: 'Google AI Ultra' } },
    quotaSummary: makeQuota(0.8, 0.9),
    summaries: {
      'conv-shared': {
        stepCount: 2,
        lastModifiedTime: new Date(baseMs + 4_000).toISOString(),
        status: 'IDLE',
        annotations: { title: 'Greeting and Hello' },
      },
      'conv-alice-old': {
        stepCount: 1,
        lastModifiedTime: new Date(baseMs + 6_000).toISOString(),
        status: 'IDLE',
        annotations: { title: 'Earlier Alice Session' },
      },
    },
    trajectories: {
      'conv-shared': { trajectory: { steps: [sharedStep1, sharedStep2] } },
      'conv-alice-old': { trajectory: { steps: [aliceOldStep] } },
    },
  });

  // 1. Initial state under Alice: 3 calls = 100,000 tokens in both consumption and Alice's quota pools
  const pAlice = await h.buildTelemetryPayloadInternal('conv-shared', false, { range: 'all' });
  assert.equal(pAlice.conversations.length, 2);
  assert.equal(pAlice.activeConversation.cascadeId, 'conv-shared');
  assert.equal(pAlice.activeConversation.stepCount, 2);
  assert.equal(pAlice.consumption.account.calls, 3);
  assert.equal(pAlice.consumption.account.totalTokens, 100_000);
  assert.equal(pAlice.quotas.weekly.calls, 3);
  assert.equal(pAlice.quotas.weekly.tokens, 100_000);

  // 2. Switch to Bob and create 1 new step (15,900 tokens) in conv-bob while keeping conv-shared locked
  const bobStep1 = makeStepAt(1, 15_552, 348, 10_000); // 15,900
  h.state.userStatus = { email: 'bob@example.com', userTier: { name: 'Google AI Ultra' } };
  h.state.quotaSummary = makeQuota(0.977, 0.994);
  h.state.summaries['conv-bob'] = {
    stepCount: 1,
    lastModifiedTime: new Date(baseMs + 11_000).toISOString(),
    status: 'IDLE',
    annotations: { title: 'New Bob Session' },
  };
  h.state.trajectories['conv-bob'] = { trajectory: { steps: [bobStep1] } };

  const pBob = await h.buildTelemetryPayloadInternal('conv-shared', false, { range: 'all' });
  assert.equal(pBob.conversations.length, 3, 'All historical conversations remain visible after account switch');
  assert.equal(pBob.activeConversation.cascadeId, 'conv-shared', 'Locked conversation stays selected');
  assert.equal(pBob.activeConversation.stepCount, 2, 'Step details of locked conversation are preserved');
  assert.equal(pBob.consumption.account.calls, 4, 'Global consumption retains all 4 calls across accounts');
  assert.equal(pBob.consumption.account.totalTokens, 115_900);
  const bobGemini = pBob.quotas.pools.find((pool) => pool.poolKey === 'Gemini');
  assert.equal(bobGemini.cycle5h.calls, 1, 'Quota 5h isolates strictly to Bob');
  assert.equal(bobGemini.cycle5h.tokens, 15_900);
  assert.equal(bobGemini.cycleWeekly.tokens, 15_900);
  assert.equal(pBob.quotas.weekly.calls, 1);
  assert.equal(pBob.quotas.weekly.tokens, 15_900);

  // 3. Continue chatting inside conv-shared while logged in as Bob (step #3 = 25,000 tokens)
  const sharedStep3ByBob = makeStepAt(3, 24_000, 1_000, 20_000); // 25,000
  h.state.summaries['conv-shared'] = {
    ...h.state.summaries['conv-shared'],
    stepCount: 3,
    lastModifiedTime: new Date(baseMs + 21_000).toISOString(),
  };
  h.state.trajectories['conv-shared'] = {
    trajectory: { steps: [sharedStep1, sharedStep2, sharedStep3ByBob] },
  };

  const pBobContinued = await h.buildTelemetryPayloadInternal('conv-shared', false, { range: 'all' });
  assert.equal(pBobContinued.activeConversation.stepCount, 3);
  assert.equal(pBobContinued.consumption.account.calls, 5);
  assert.equal(pBobContinued.consumption.account.totalTokens, 140_900);
  const bobGeminiAfter = pBobContinued.quotas.pools.find((pool) => pool.poolKey === 'Gemini');
  assert.equal(bobGeminiAfter.cycle5h.calls, 2, 'Bob quota includes conv-bob + his new step #3 in conv-shared');
  assert.equal(bobGeminiAfter.cycle5h.tokens, 40_900);
  assert.equal(pBobContinued.quotas.weekly.calls, 2);
  assert.equal(pBobContinued.quotas.weekly.tokens, 40_900);

  // 4. Switch back to Alice -> Alice quota remains strictly her 3 calls (100,000 tokens)
  h.state.userStatus = { email: 'alice@example.com', userTier: { name: 'Google AI Ultra' } };
  h.state.quotaSummary = makeQuota(0.8, 0.9);
  const pAliceBack = await h.buildTelemetryPayloadInternal('conv-shared', false, { range: 'all' });
  assert.equal(pAliceBack.consumption.account.calls, 5);
  assert.equal(pAliceBack.consumption.account.totalTokens, 140_900);
  assert.equal(pAliceBack.quotas.weekly.calls, 3);
  assert.equal(pAliceBack.quotas.weekly.tokens, 100_000);
});

test('BUG-03, BUG-12 & BUG-16: negative/NaN token sanitization, deferred costUsd rounding, and dynamicModelMap default', async () => {
  const badStep = {
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      sourceTrajectoryStepInfo: { stepIndex: 1 },
      createdAt: nowIso,
      completedAt: doneIso,
      modelUsage: {
        model: 'MODEL_PLACEHOLDER_M318',
        inputTokens: '-5000',
        cacheReadTokens: 'NaN',
        outputTokens: '1000',
        thinkingOutputTokens: '2500',
      },
    },
  };
  const extracted = extractModelSteps([badStep]);
  assert.equal(extracted[0].inputTokens, 0);
  assert.equal(extracted[0].cacheReadTokens, 0);
  assert.equal(extracted[0].outputTokens, 1000);
  assert.equal(extracted[0].thinkingTokens, 1000);
  assert.equal(extracted[0].responseTokens, 0);
  assert.equal(normalizeCachedStep({ ...extracted[0], inputTokens: -99 }).inputTokens, 0);
  assert.equal(normalizeCachedStep(null), null);

  // Micro-steps: 100 steps * (1067 output * $3.75 / 1M = $0.00400125) = $0.40 (previously rounded per-step to $0.00 -> $0.00!)
  const microSteps = Array.from({ length: 100 }, (_, idx) => ({
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      sourceTrajectoryStepInfo: { stepIndex: idx + 1 },
      createdAt: promoNowIso,
      completedAt: promoDoneIso,
      modelUsage: {
        model: 'MODEL_PLACEHOLDER_M318', // gemini-3.8-flash-high: $0.75/1M input, $3.75/1M output
        inputTokens: '0',
        cacheReadTokens: '0',
        outputTokens: '1067',
      },
    },
  }));
  const h = backendHarness({
    clock: () => promoMs,
    summaries: { micro: { stepCount: 100, lastModifiedTime: promoDoneIso, status: 'IDLE' } },
    trajectories: { micro: { trajectory: { steps: microSteps } } },
  });
  const p = await h.buildTelemetryPayloadInternal('micro', false, { range: 'today' });
  assert.equal(p.consumption.account.costUsd, 0.4);
});

test('BUG-04 & BUG-10: failed RUNNING trajectory fetch enters cooldown instead of hammering RPC every poll, cleared by forceRefresh', async () => {
  const h = backendHarness({
    summaries: { run1: { stepCount: 2, lastModifiedTime: doneIso, status: 'CASCADE_RUN_STATUS_RUNNING' } },
    trajectories: { run1: new Error('LS timeout') },
    quotaSummary: new Error('Quota RPC down'),
  });

  await h.buildTelemetryPayloadInternal('run1', false);
  const callsAfterFirst = h.state.calls.filter((c) => c.method === 'GetCascadeTrajectory').length;
  const quotaCallsAfterFirst = h.state.calls.filter((c) => c.method === 'RetrieveUserQuotaSummary').length;
  assert.equal(callsAfterFirst, 1);
  assert.equal(quotaCallsAfterFirst, 1);

  // Immediate second background poll must respect cooldown for both trajectory and quota RPC
  await h.buildTelemetryPayloadInternal('run1', false);
  assert.equal(h.state.calls.filter((c) => c.method === 'GetCascadeTrajectory').length, 1);
  assert.equal(h.state.calls.filter((c) => c.method === 'RetrieveUserQuotaSummary').length, 1);

  // Manual forceRefresh=true bypasses cooldown immediately
  await h.buildTelemetryPayloadInternal('run1', true);
  assert.equal(h.state.calls.filter((c) => c.method === 'GetCascadeTrajectory').length, 2);
  assert.equal(h.state.calls.filter((c) => c.method === 'RetrieveUserQuotaSummary').length, 2);
});

test('BUG-09, BUG-14 & BUG-15: SemVer 2.0 prerelease/build ordering, future-only exhausted quota inference, and <6h dual-bucket classification', async () => {
  const h = backendHarness({
    quotaSummary: {
      groups: [
        {
          displayName: 'Gemini',
          buckets: [
            {
              // Omitted remainingFraction with epoch-0 resetTime must NOT falsely report 0% remaining!
              resetTime: '1970-01-01T00:00:00Z',
            },
          ],
        },
        {
          displayName: 'Claude & GPT',
          buckets: [
            {
              remainingFraction: 0.4,
              resetTime: new Date(nowMs + 2 * 3600_000).toISOString(),
            },
            {
              remainingFraction: 0.8,
              // Weekly bucket that happens to be 4h away from resetting!
              resetTime: new Date(nowMs + 4 * 3600_000).toISOString(),
            },
          ],
        },
      ],
    },
  });

  assert.equal(h.compareSemver('1.4.2+20261110', '1.4.2'), 0);
  assert.equal(h.compareSemver('1.5.0-beta.2', '1.5.0-alpha.10'), 1);
  assert.equal(h.compareSemver('1.5.0-alpha.1', '1.5.0-alpha.beta'), -1);

  const p = await h.buildTelemetryPayloadInternal('');
  const geminiPool = p.quotas.pools.find((x) => x.poolKey === 'Gemini');
  assert.ok(geminiPool);
  assert.equal(geminiPool.isAvailable, false, 'epoch-0 omitted remainingFraction must not create fake 0% exhausted pool');
  assert.equal(geminiPool.remainingPct, null);
  assert.equal(geminiPool.usedPct, null);

  const claudePool = p.quotas.pools.find((x) => x.poolKey === 'Claude & GPT');
  assert.ok(claudePool);
  assert.equal(claudePool.remainingPct, 40);
  assert.equal(claudePool.weeklyRemainingPct, 80);

  const prevLang = i18nStore.getState().language;
  setI18nLanguage('zh-CN');
  try {
    assert.equal(formatCountdown(new Date(nowMs + 30_000).toISOString(), nowMs), '<1分钟后重置');
    assert.equal(formatCountdown('1969-12-31T23:59:59Z', nowMs), '未知重置时间');
    assert.equal(formatUsd(0.0004, { precise: true }), '<$0.001');
    assert.equal(formatUsd(12.34, { unpricedCalls: 1, compactPending: true }), '$12.34');
    assert.equal(speedReasonText('short_timing'), '耗时过短 (<0.5s)');
  } finally {
    setI18nLanguage(prevLang);
  }
});

test('BUG-17 & CANCEL-06: extractContextBreakdown classifies messagePrompts when children are empty and blocks post-compaction carryover', () => {
  const ctx = extractContextBreakdown({
    chatStartMetadata: {
      contextWindowMetadata: {
        estimatedTokensUsed: 10000,
        tokenBreakdown: {
          groups: [
            { type: 'TOKEN_TYPE_SYSTEM_PROMPT', numTokens: 2000 },
            { type: 'TOKEN_TYPE_CHAT_MESSAGES', numTokens: 8000, children: [] },
          ],
        },
      },
    },
    messagePrompts: [
      { source: 'CHAT_MESSAGE_SOURCE_USER', prompt: '<USER_REQUEST>hello world</USER_REQUEST>' },
      { source: 'CHAT_MESSAGE_SOURCE_MODEL', prompt: 'Assistant reply content here!' },
    ],
  });
  assert.ok(ctx);
  assert.equal(ctx.systemPromptTokens, 2000);
  assert.ok(ctx.userInputTokens > 0);
  assert.ok(ctx.assistantTokens > 0);
  assert.equal(ctx.userInputTokens + ctx.assistantTokens, 8000);

  const stepsWithTrailingCheckpoint = extractModelSteps(
    [
      {
        status: 'CORTEX_STEP_STATUS_DONE',
        metadata: {
          sourceTrajectoryStepInfo: { stepIndex: 1 },
          createdAt: nowIso,
          completedAt: doneIso,
          modelUsage: { model: 'MODEL_PLACEHOLDER_M318', inputTokens: '180000', outputTokens: '500' },
        },
      },
      {
        type: 'CORTEX_STEP_TYPE_CHECKPOINT',
        status: 'CORTEX_STEP_STATUS_DONE',
        metadata: {
          sourceTrajectoryStepInfo: { stepIndex: 2 },
          createdAt: nowIso,
          completedAt: doneIso,
          modelUsage: { model: 'MODEL_PLACEHOLDER_M318', inputTokens: '180000', outputTokens: '1200' },
        },
      },
    ],
    [
      {
        stepIndices: [1],
        chatModel: {
          chatStartMetadata: {
            contextWindowMetadata: {
              estimatedTokensUsed: 180_000,
              tokenBreakdown: {
                groups: [{ type: 'TOKEN_TYPE_CHAT_MESSAGES', numTokens: 180_000 }],
              },
            },
          },
        },
      },
    ]
  );
  assert.equal(stepsWithTrailingCheckpoint.length, 2);
  assert.equal(stepsWithTrailingCheckpoint[1].isCompactionStep, true);
  assert.equal(
    stepsWithTrailingCheckpoint[1].contextBreakdown,
    null,
    'compaction checkpoint must not inherit pre-compaction 180k contextBreakdown'
  );
});

test('BUG-20 & BUG-24: reactive store microtask deduplication, stripModuleSyntax safety, and IIFE bundle isolation', async () => {
  const store = createReactiveStore({ a: 1, b: 2 });
  let calls = 0;
  store.subscribe((s) => s.a + s.b, () => {
    calls += 1;
  }, { immediate: false });

  store.setState({ a: 10 });
  store.setState({ b: 20 });
  await new Promise((r) => queueMicrotask(r));
  assert.equal(calls, 1, 'multiple setState calls in same microtask must batch into 1 subscriber flush');

  const trickyModule = [
    "import './side-effect.js';",
    "import { foo,\n  bar } from './multi.js';",
    'const tpl = `\nimport { keepMe } from "tpl";\nexport const KEEP_ME = 42;\n`;',
    'export async function runTask() { return tpl; }',
    'export { runTask };',
  ].join('\n');

  const stripped = stripModuleSyntax(trickyModule);
  assert.ok(stripped.includes('import { keepMe } from "tpl"'));
  assert.ok(stripped.includes('export const KEEP_ME = 42'));
  assert.equal(/^\s*import\s/m.test(stripped.replace(/`[\s\S]*?`/g, '')), false);
  assert.doesNotThrow(() => new vm.Script(stripped));

  const appBundle = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.ok(appBundle.startsWith('(() => {\n\'use strict\';'));
  assert.ok(appBundle.trimEnd().endsWith('})();'));
});

test('bundle validation rejects incompatible imports and duplicate bindings before touching output', (t) => {
  const tempDir = fs.mkdtempSync(fileURLToPath(new URL('./.bundle-test-', import.meta.url)));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  for (const dir of ['src', 'shared']) {
    fs.cpSync(new URL(`../${dir}/`, import.meta.url), join(tempDir, dir), { recursive: true });
  }
  const outputs = ['app.js', 'styles.css', 'index.html'];
  for (const file of outputs) fs.writeFileSync(join(tempDir, file), file);

  const iconSource = join(tempDir, 'src', 'icons', 'svgRegistry.js');
  const original = fs.readFileSync(iconSource, 'utf8');
  for (const [prefix, error] of [
    [
      "import * as ns from '../../shared/settings-normalization.mjs';",
      /svgRegistry\.js.*only named imports/,
    ],
    ["import { SVG_NS } from './SvgIcon.js';", /svgRegistry\.js.*SvgIcon\.js.*earlier in jsOrder/],
    ["import './missing.js';", /svgRegistry\.js.*missing\.js.*earlier in jsOrder/],
    ['export const SVG_NS = "duplicate";', /Identifier 'SVG_NS' has already been declared/],
  ]) {
    fs.writeFileSync(iconSource, `${prefix}\n${original}`);
    assert.throws(() => buildBundle(tempDir), error);
    for (const file of outputs) {
      assert.equal(fs.readFileSync(join(tempDir, file), 'utf8'), file);
    }
  }

  // Named import aliases (`import { a as b }`) from earlier modules in jsOrder are supported inside the module IIFE
  fs.writeFileSync(
    iconSource,
    `import { normalizeStandalonePort /* comment */ as normPort } from '../../shared/settings-normalization.mjs';\nvoid normPort;\n${original}`
  );
  assert.doesNotThrow(() => buildBundle(tempDir));

  // Per-module closure isolation: unexported private identifiers never collide across modules
  fs.writeFileSync(iconSource, `const SVG_NS = "private_local";\n${original}`);
  assert.doesNotThrow(() => buildBundle(tempDir));
});

test('Compaction liveActivity: detects in-progress & completed CHECKPOINT over pre-compaction tool operations across RPC and transcript.jsonl', async () => {
  const convId = '4432b724-3e1e-4421-a375-c6855a7b7b37';

  // Pre-compaction steps (matching real-world step 0..2: planner edit_file x2 + 2 completed tool results)
  const rpcPreCompactionSteps = [
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: {
        createdAt: '2026-11-11T02:18:21Z',
        finishedGeneratingAt: '2026-11-11T02:18:35Z',
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M318',
          inputTokens: '2918',
          cacheReadTokens: '252465',
          outputTokens: '814',
        },
      },
      plannerResponse: {
        toolCalls: [
          { name: 'edit_file', argumentsJson: JSON.stringify({ Path: 'f:/repo/backend-harness.mjs' }) },
          { name: 'edit_file', argumentsJson: JSON.stringify({ Path: 'f:/repo/04-post-fix-verify.mjs' }) },
        ],
      },
    },
    {
      type: 'CORTEX_STEP_TYPE_CODE_ACTION',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { createdAt: '2026-11-11T02:18:35Z', completedAt: '2026-11-11T02:18:38Z' },
    },
    {
      type: 'CORTEX_STEP_TYPE_CODE_ACTION',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { createdAt: '2026-11-11T02:18:35Z', completedAt: '2026-11-11T02:18:40Z' },
    },
  ];

  // transcript.jsonl still ends at step_index 2 (since CHECKPOINT only flushes to transcript.jsonl when DONE)
  const transcriptPreFlush = [
    {
      step_index: 0,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-11T02:18:21Z',
      tool_calls: [
        { name: 'edit_file', args: { Path: '"f:\\\\repo\\\\backend-harness.mjs"' } },
        { name: 'edit_file', args: { Path: '"f:\\\\repo\\\\04-post-fix-verify.mjs"' } },
      ],
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-11T02:18:35Z',
      content: 'Created At: 2026-11-11T11:18:35+09:00\nCompleted At: 2026-11-11T11:18:38+09:00\nMade 1 replacement',
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-11T02:18:35Z',
      content: 'Created At: 2026-11-11T11:18:35+09:00\nCompleted At: 2026-11-11T11:18:40+09:00\nMade 1 replacement',
    },
  ];

  // Phase 1: In-progress CORTEX_STEP_TYPE_CHECKPOINT in RPC WITHOUT metadata.createdAt yet + trailing MEMENTO
  const h = backendHarness({
    summaries: {
      [convId]: {
        stepCount: 4,
        lastModifiedTime: '2026-11-11T02:18:35Z',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        annotations: { title: 'Audit & Fix Session' },
      },
    },
    trajectories: {
      [convId]: {
        trajectory: {
          steps: [
            ...rpcPreCompactionSteps,
            {
              type: 'CORTEX_STEP_TYPE_CHECKPOINT',
              status: 'CORTEX_STEP_STATUS_RUNNING',
              metadata: {},
            },
            {
              type: 'CORTEX_STEP_TYPE_MEMENTO',
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: { createdAt: '2026-11-11T02:18:40Z' },
            },
          ],
        },
      },
    },
    transcripts: {
      [convId]: transcriptPreFlush,
    },
  });

  const pCompacting = await h.buildTelemetryPayloadInternal(convId);
  assert.equal(pCompacting.activeConversation.liveActivity.phase, 'compacting');
  assert.equal(pCompacting.activeConversation.liveActivity.label, '上下文压缩');
  assert.equal(
    pCompacting.activeConversation.liveActivity.startedAtMs,
    Date.parse('2026-11-11T02:18:40Z'),
    'uses previous tool completion timestamp when in-progress CHECKPOINT lacks createdAt'
  );
  assert.equal(pCompacting.runningConversations[0].mainActivity.phase, 'compacting');
  assert.equal(pCompacting.runningConversations[0].mainActivity.label, '上下文压缩');

  // Phase 2: CHECKPOINT finishes (status=DONE in both RPC & transcript.jsonl) while resuming before next PLANNER_RESPONSE
  h.state.trajectories[convId] = {
    trajectory: {
      steps: [
        ...rpcPreCompactionSteps,
        {
          type: 'CORTEX_STEP_TYPE_CHECKPOINT',
          status: 'CORTEX_STEP_STATUS_DONE',
          metadata: {
            createdAt: '2026-11-11T02:18:40Z',
            finishedGeneratingAt: '2026-11-11T02:19:33Z',
            modelUsage: {
              model: 'MODEL_PLACEHOLDER_M318',
              inputTokens: '3082',
              cacheReadTokens: '254224',
              outputTokens: '4627',
            },
          },
        },
      ],
    },
  };
  h.state.transcripts[convId] = [
    ...transcriptPreFlush,
    {
      step_index: 3,
      source: 'SYSTEM',
      type: 'CHECKPOINT',
      status: 'DONE',
      created_at: '2026-11-11T02:18:40Z',
      content: '# Resuming from a compaction\n...',
    },
  ];
  h.state.transcriptMtimeMs = 2;

  const pResuming = await h.buildTelemetryPayloadInternal(convId);
  assert.equal(pResuming.activeConversation.liveActivity.phase, 'compacting');
  assert.equal(pResuming.activeConversation.liveActivity.label, '上下文压缩');
  assert.equal(pResuming.activeConversation.liveActivity.detail, '已完成压缩，正在恢复推理');
  assert.equal(
    pResuming.activeConversation.liveActivity.startedAtMs,
    Date.parse('2026-11-11T02:19:33Z')
  );

  // Phase 3: Even when RPC fails/cools down and ONLY transcript.jsonl (with status="DONE" CHECKPOINT) is available,
  // it STILL detects compaction instead of regressing to pre-compaction "修改文件"
  h.state.trajectories[convId] = new Error('temporary RPC timeout');
  const pTranscriptOnly = await h.buildTelemetryPayloadInternal(convId, true);
  assert.equal(pTranscriptOnly.activeConversation.liveActivity.phase, 'compacting');
  assert.equal(pTranscriptOnly.activeConversation.liveActivity.label, '上下文压缩');
});

test('panel typography scales all view/table/chart CSS rules via --fs-* tokens without hardcoded px sizes', () => {
  const stylesDir = fileURLToPath(new URL('../src/styles', import.meta.url));
  const viewCssFiles = [
    'controls.css',
    'views-overview.css',
    'views-tables.css',
    'views-consumption.css',
    'views-settings.css',
  ];
  for (const file of viewCssFiles) {
    const css = fs.readFileSync(join(stylesDir, file), 'utf8');
    const rawFontLines = css
      .split(/\r?\n/)
      .filter((line) => /font-size\s*:/.test(line) && !/var\(--fs-/.test(line));
    assert.deepEqual(
      rawFontLines,
      [],
      `${file} must route every font-size declaration through scalable --fs-* tokens`
    );
  }
  const tokensCss = fs.readFileSync(join(stylesDir, 'tokens.css'), 'utf8');
  assert.match(tokensCss, /--font-sans\s*:\s*var\(--host-font-sans,\s*[^;]+"SF Pro Text"/);
  assert.match(tokensCss, /--font-mono\s*:\s*var\(--host-font-mono,\s*ui-monospace,\s*SFMono-Regular,\s*"SF Mono"/);
  assert.match(tokensCss, /:host\(\[data-font-scale="xl"\]\)/);
  assert.match(tokensCss, /\[data-font-scale\]\s*\{[\s\S]*?--fs-base-sm:/);
  assert.doesNotMatch(tokensCss, /:root,\s*:host\s*\{[^}]*--ui-font-scale\s*:\s*1\s*;/);

  const panelRoot = fileURLToPath(new URL('..', import.meta.url));
  for (const artifact of ['styles.css', 'app.js', 'index.html']) {
    const rawArtifact = fs.readFileSync(join(panelRoot, artifact), 'utf8');
    assert.equal(rawArtifact.includes('\r\n'), false, `${artifact} must normalize line endings to LF`);
  }
});

test('post-compaction context preserves static channels + checkpoint summary, capsule fits 100% without ellipsis, and .step-model-compact follows --accent-primary', async () => {
  const convId = '99999999-8888-4777-8666-555555555555';
  const preStep = {
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      createdAt: '2026-11-18T03:00:00Z',
      finishedGeneratingAt: '2026-11-18T03:00:05Z',
      sourceTrajectoryStepInfo: { stepIndex: 10 },
      modelUsage: {
        model: 'MODEL_PLACEHOLDER_M429',
        apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
        inputTokens: '5400',
        cacheReadTokens: '270000',
        outputTokens: '1200',
      },
    },
  };
  const checkpointStep = {
    type: 'CORTEX_STEP_TYPE_CHECKPOINT',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      createdAt: '2026-11-18T03:01:00Z',
      finishedGeneratingAt: '2026-11-18T03:01:06Z',
      sourceTrajectoryStepInfo: { stepIndex: 12 },
      modelUsage: {
        apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
        inputTokens: '5400',
        cacheReadTokens: '270000',
        outputTokens: '3800',
        thinkingOutputTokens: '800',
        responseOutputTokens: '3000',
      },
    },
  };
  const preGeneratorMetadata = [
    {
      stepIndices: [10],
      chatModel: {
        responseModel: 'gemini-4-carbon-high',
        modelDisplayName: 'Gemini 4 Carbon (High)',
        chatStartMetadata: {
          contextWindowMetadata: {
            estimatedTokensUsed: 275_400,
            maxContextTokens: 384_000,
            tokenBreakdown: {
              groups: [
                {
                  type: 'TOKEN_TYPE_SYSTEM_PROMPT',
                  numTokens: 16_000,
                  children: [
                    { name: 'identity', numTokens: 10_000 },
                    { name: 'skills', numTokens: 4_000 },
                    { name: 'user_rules', numTokens: 2_000 },
                  ],
                },
                {
                  type: 'TOKEN_TYPE_TOOLS',
                  numTokens: 10_000,
                  children: [
                    { name: 'run_command', numTokens: 8_000 },
                    { name: 'mcp_gradio_predict', numTokens: 2_000 },
                  ],
                },
                {
                  type: 'TOKEN_TYPE_CHAT_MESSAGES',
                  numTokens: 249_400,
                  children: [
                    { name: '1: USER_INPUT', numTokens: 49_400 },
                    { name: '2: PLANNER_RESPONSE', numTokens: 80_000 },
                    { name: '3: GENERIC', numTokens: 120_000 },
                  ],
                },
              ],
            },
          },
        },
      },
    },
  ];

  const h = backendHarness({
    clock: () => Date.parse('2026-11-18T03:02:00Z'),
    summaries: {
      [convId]: {
        summary: 'Compaction test',
        stepCount: 2,
        status: 'CASCADE_RUN_STATUS_IDLE',
        lastModifiedTime: '2026-11-18T03:01:06Z',
      },
    },
    trajectories: {
      [convId]: {
        numTotalSteps: 2,
        trajectory: {
          steps: [preStep, checkpointStep],
          generatorMetadata: preGeneratorMetadata,
        },
      },
    },
  });

  const payload = await h.buildTelemetryPayloadInternal(convId);
  const ctx = payload.activeConversation.context;

  // Static channels must survive compaction while old chat history resets and checkpoint summary is recorded
  assert.equal(ctx.systemPromptTokens, 10_000);
  assert.equal(ctx.skillsTokens, 4_000);
  assert.equal(ctx.userRulesTokens, 2_000);
  assert.equal(ctx.systemToolsTokens, 8_000);
  assert.equal(ctx.mcpToolsTokens, 2_000);
  assert.equal(ctx.checkpointTokens, 3_000, 'checkpoint summary uses responseTokens excluding thinkingTokens');
  assert.equal(ctx.userInputTokens, 0);
  assert.equal(ctx.assistantTokens, 0);
  assert.equal(ctx.toolResultsTokens, 0);
  assert.equal(ctx.subagentTokens, 0);
  assert.equal(ctx.totalTokens, 29_000, 'must not leak 275.4k pre-compaction input into post-compaction total');
  assert.equal(ctx.compactionLimitTokens, 384_000, 'inherits 384k custom context budget across compaction step');
  assert.equal(ctx.usedPct, 7.6);
  assert.equal(payload.conversations[0].contextUsedPct, 7.6, 'Multi-Session quick stats must also reflect post-compaction %');

  // Subsequent lightweight step without its own tokenBreakdown rolls forward cleanly on top of compacted baseline
  h.state.summaries[convId].stepCount = 3;
  h.state.summaries[convId].lastModifiedTime = '2026-11-18T03:02:10Z';
  h.state.trajectories[convId] = {
    numTotalSteps: 3,
    trajectory: {
      steps: [
        preStep,
        checkpointStep,
        {
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          status: 'CORTEX_STEP_STATUS_DONE',
          metadata: {
            createdAt: '2026-11-18T03:02:05Z',
            finishedGeneratingAt: '2026-11-18T03:02:10Z',
            sourceTrajectoryStepInfo: { stepIndex: 14 },
            modelUsage: {
              model: 'MODEL_PLACEHOLDER_M429',
              apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
              inputTokens: '1500',
              cacheReadTokens: '29000',
              outputTokens: '600',
            },
          },
        },
      ],
      generatorMetadata: preGeneratorMetadata,
    },
  };
  const payloadFollowup = await h.buildTelemetryPayloadInternal(convId, true);
  const ctx2 = payloadFollowup.activeConversation.context;
  assert.equal(ctx2.systemPromptTokens, 10_000);
  assert.equal(ctx2.checkpointTokens, 3_000);
  assert.equal(ctx2.userInputTokens, 1_500);
  assert.equal(ctx2.assistantTokens, 600);
  assert.equal(ctx2.totalTokens, 31_100);

  // Verify capsule 100% slot CSS, non-hardcoded compaction suffix color, and narrow-width top pill nav containment
  const stylesCss = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(stylesCss, /\.wm-ctx-seg\s*\{[^}]*width:\s*58px;/);
  assert.match(stylesCss, /\.wm-ctx-pct\s*\{[^}]*max-width:\s*none;[^}]*overflow:\s*visible;[^}]*text-overflow:\s*clip;/s);
  assert.match(stylesCss, /\.data-table\s+tbody\s+tr\.is-compaction\s*\{[^}]*var\(--accent-primary\)/);
  assert.doesNotMatch(stylesCss, /\.data-table\s+tbody\s+tr\.is-compaction\s*\{[^}]*--metric-info/);
  assert.match(stylesCss, /\.long-pill-nav\s*\{[^}]*container-type:\s*inline-size;[^}]*minmax\(0,\s*1fr\)[^}]*overflow:\s*hidden;/s);
  assert.match(stylesCss, /\.pill-tab\s*\{[^}]*min-width:\s*0;/s);
  assert.match(stylesCss, /@container\s*\(max-width:\s*30em\)\s*\{[\s\S]*?\.pill-tab-badge\s*\{\s*display:\s*none\s*!important;/);
  assert.doesNotMatch(stylesCss, /\.structure-preview-canvas[^{]*\{[^}]*zoom:/, 'Structure preview must stay 1:1 without zoom distortion');
  assert.match(stylesCss, /\.preview-capsule-bar\s*\{[^}]*"Google Sans Flex"/s);
});

test('P0 audit fixes: main/bridge-daemon import isolation, standalone lsAddr, dual-window stepRevision LRU, CORTEX_STEP_TYPE_FIND, preview i18n, and header render purity', async () => {
  // 1. Static import isolation on main.mjs and bridge-daemon.mjs
  const mainSrc = fs.readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(
    mainSrc,
    /^import\s+[\s\S]*?from\s+['"]\.\/backend\/(?:api-actions|config)\.mjs['"]/m,
    'main.mjs must not statically import api-actions.mjs or config.mjs in the host parent process'
  );
  const daemonSrc = fs.readFileSync(new URL('../bridge-daemon.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(
    daemonSrc,
    /^import\s+[\s\S]*?from\s+['"]\.\/backend\/config\.mjs['"]/m,
    'bridge-daemon.mjs must not statically import config.mjs before --standalone env overrides'
  );

  // 2. Dual-window alternating stepDetails='display' stepRevision cache hit + rebuild invalidation
  const makeConv = (prompt) => ({
    trajectory: {
      steps: [
        {
          type: 'CORTEX_STEP_TYPE_USER_INPUT',
          userInput: { userResponse: prompt },
          metadata: { createdAt: '2026-11-18T05:00:00Z' },
        },
        {
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          status: 'CORTEX_STEP_STATUS_DONE',
          plannerResponse: { response: 'done' },
          metadata: {
            createdAt: '2026-11-18T05:00:01Z',
            completedAt: '2026-11-18T05:00:02Z',
            modelUsage: {
              model: 'MODEL_PLACEHOLDER_M65',
              inputTokens: '1200',
              outputTokens: '60',
            },
          },
        },
      ],
    },
  });
  const cidA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const cidB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const h = backendHarness({
    summaries: {
      [cidA]: { summary: 'A', stepCount: 2, lastModifiedTime: '2026-11-18T05:00:02Z' },
      [cidB]: { summary: 'B', stepCount: 2, lastModifiedTime: '2026-11-18T05:00:03Z' },
    },
    trajectories: {
      [cidA]: makeConv('Prompt A'),
      [cidB]: makeConv('Prompt B'),
    },
  });

  const firstA = JSON.parse(
    (await h.executeTelemetryAction({ conversationId: cidA, stepDetails: 'display', stepRevision: '' })).body
  );
  const firstB = JSON.parse(
    (await h.executeTelemetryAction({ conversationId: cidB, stepDetails: 'display', stepRevision: '' })).body
  );
  const secondA = JSON.parse(
    (await h.executeTelemetryAction({
      conversationId: cidA,
      stepDetails: 'display',
      stepRevision: firstA.stepRevision,
    })).body
  );
  const secondB = JSON.parse(
    (await h.executeTelemetryAction({
      conversationId: cidB,
      stepDetails: 'display',
      stepRevision: firstB.stepRevision,
    })).body
  );
  assert.equal(secondA.stepsUnchanged, true);
  assert.equal(secondB.stepsUnchanged, true);
  assert.equal(secondA.activeConversation.recentSteps, undefined);
  assert.equal(secondB.activeConversation.recentSteps, undefined);

  h.executeRebuildCacheAction();
  const afterRebuildA = JSON.parse(
    (await h.executeTelemetryAction({
      conversationId: cidA,
      stepDetails: 'display',
      stepRevision: firstA.stepRevision,
    })).body
  );
  assert.equal(afterRebuildA.stepsUnchanged, false);
  assert.equal(Array.isArray(afterRebuildA.activeConversation.recentSteps), true);

  // 3. CORTEX_STEP_TYPE_FIND live activity resolution
  const findAct = extractLiveActivity(
    [
      {
        type: 'CORTEX_STEP_TYPE_FIND',
        status: 'CORTEX_STEP_STATUS_RUNNING',
        metadata: { createdAt: '2026-11-18T05:00:00Z' },
      },
    ],
    true
  );
  assert.equal(findAct?.label, '查找文件');

  // 4. Preview i18n ('live.generating'), stepColumns maxItems: 14, SQLite busy helper reuse, and pure header render
  const { setI18nLanguage } = await import('../src/i18n/index.js');
  const { buildStructurePreviewTelemetry } = await import(
    '../src/components/settings/structurePreviewMock.js'
  );
  setI18nLanguage('zh-CN');
  assert.equal(
    buildStructurePreviewTelemetry().runningConversations[0].mainActivity.label,
    '生成中'
  );
  setI18nLanguage('en-US');
  assert.equal(
    buildStructurePreviewTelemetry().runningConversations[0].mainActivity.label,
    'Generating'
  );
  setI18nLanguage('zh-CN');

  const structureTabSrc = fs.readFileSync(
    new URL('../src/views/settings/SettingsStructureTab.js', import.meta.url),
    'utf8'
  );
  assert.match(structureTabSrc, /options:\s*getStepColumnOptions[\s\S]{0,120}?maxItems:\s*14\b/);

  const cliStatusSrc = fs.readFileSync(new URL('../cli-statusline.mjs', import.meta.url), 'utf8');
  assert.match(cliStatusSrc, /\bwithReadOnlySqliteDb\b/);
  assert.doesNotMatch(cliStatusSrc, /\bnew\s+DatabaseSync\s*\(/);

  const headerSrc = fs.readFileSync(
    new URL('../src/components/layout/TopSessionHeader.js', import.meta.url),
    'utf8'
  );
  const renderBody = headerSrc.slice(
    headerSrc.indexOf('function renderHeaderState()'),
    headerSrc.indexOf('const unsubTelemetry =')
  );
  assert.doesNotMatch(renderBody, /\buiStore\.setState\b/);
});

test('P1 audit fixes: shared third-party pool & route single-source, pure frozen resolveScopedConversation, mock schema alignment, and account preferences inclusion', async () => {
  const { normalizeI18nLanguage } = await import('../src/i18n/index.js');
  const { resolveSpecificQuotaSlotSummary } = await import('../src/registries/metricRegistry.js');
  const { resolveScopedConversation, isEquivalentTelemetry } = await import(
    '../src/store/telemetryStore.js'
  );
  const { buildStructurePreviewTelemetry } = await import(
    '../src/components/settings/structurePreviewMock.js'
  );
  const { BRIDGE_API_ROUTE_DEFS } = await import('../shared/window-bridge-protocol.mjs');

  assert.equal(normalizeI18nLanguage('system'), 'auto');
  assert.equal(typeof isEquivalentTelemetry, 'function');
  assert.equal(BRIDGE_API_ROUTE_DEFS.length, 23);
  assert.ok(BRIDGE_API_ROUTE_DEFS.some((r) => r.path === '/api/fx-sync' && r.method === 'POST'));
  assert.ok(BRIDGE_API_ROUTE_DEFS.some((r) => r.path === '/api/bridge/relaunch'));
  assert.ok(BRIDGE_API_ROUTE_DEFS.some((r) => r.path === '/api/session-migration/catalog'));
  assert.ok(BRIDGE_API_ROUTE_DEFS.some((r) => r.path === '/api/session-migration/migrate'));
  assert.ok(BRIDGE_API_ROUTE_DEFS.some((r) => r.path === '/api/export-file'));
  assert.ok(BRIDGE_API_ROUTE_DEFS.some((r) => r.path === '/api/reveal-file'));
  assert.ok(BRIDGE_API_ROUTE_DEFS.some((r) => r.path === '/api/quota-reservation/log'));
  assert.ok(BRIDGE_API_ROUTE_DEFS.some((r) => r.path === '/api/host-i18n' && r.method === 'GET'));
  assert.ok(BRIDGE_API_ROUTE_DEFS.some((r) => r.path === '/api/host-i18n' && r.method === 'POST'));
  assert.ok(BRIDGE_API_ROUTE_DEFS.some((r) => r.path === '/api/sessions/list' && r.method === 'GET'));
  assert.ok(BRIDGE_API_ROUTE_DEFS.some((r) => r.path === '/api/sessions/cleanup-preview' && r.method === 'POST'));
  assert.ok(BRIDGE_API_ROUTE_DEFS.some((r) => r.path === '/api/sessions/delete' && r.method === 'POST'));
  assert.ok(BRIDGE_API_ROUTE_DEFS.some((r) => r.path === '/api/sessions/redact-ledger' && r.method === 'POST'));
  assert.ok(BRIDGE_API_ROUTE_DEFS.some((r) => r.path === '/api/sessions/reveal' && r.method === 'POST'));

  // 1. Third-party pool parity across backend, CLI statusline, and frontend metricRegistry
  const h = backendHarness();
  const poolSample = 'Fable / OSS Third-Party Pool';
  assert.equal(h.classifyQuotaPoolIdentity({ groupName: poolSample }).poolKey, 'Claude & GPT');
  const quotasFixture = {
    pools: [
      {
        poolKey: poolSample,
        poolLabel: poolSample,
        family: poolSample,
        remainingPct: 37,
        weeklyRemainingPct: 68,
      },
    ],
  };
  assert.equal(resolveSpecificQuotaSlotSummary(quotasFixture, 'claude_5h')?.roundedPct, 37);
  assert.match(
    h.formatCliStatusLineCapsule({ quotas: quotasFixture }, { slots: ['claude_5h'], terminalWidth: 120 }),
    /37%/
  );

  // 2. Pure resolveScopedConversation never mutates deeply frozen telemetry
  const deepFreeze = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
    return obj;
  };
  const frozenTelemetry = deepFreeze({
    activeConversation: {
      cascadeId: 'frozen-conv',
      hasSubagents: true,
      recentSteps: [{ stepIndex: 1, createdAtMs: 100 }],
      agents: [
        { agentId: 'main', isMain: true, index: 0 },
        { agentId: 'sub-1', isMain: false, index: 1, recentSteps: [{ stepIndex: 2, createdAtMs: 200 }] },
      ],
      aggregated: { activeAgentId: 'main' },
    },
  });
  const scoped = resolveScopedConversation(frozenTelemetry, 'all', 'auto', true);
  assert.equal(scoped.aggregated.recentSteps.length, 2);
  assert.equal(scoped.mainAgent.recentSteps.length, 1);

  // 3. structurePreviewMock schema completeness & account preferences bundled for use
  const mock = buildStructurePreviewTelemetry();
  assert.equal(typeof mock.activeConversation.context.compactionUsedTokens, 'number');
  assert.equal(mock.activeConversation.aggregated.agentId, 'all');
  assert.equal(Array.isArray(mock.activeConversation.agents[0].modelBreakdown), true);
  assert.equal(mock.quotas.meta.hasOfficialData, true);

  const appJs = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.equal(appJs.includes('SettingsAccountTab.js'), true);
  assert.equal(appJs.includes('function renderQuotaRows('), true);
});

test('P2 audit fixes: standalone sqlite/proto-wire primitives, structured liveActivity/agent/media i18n, full en-US SVG charts, controlled LiveActivityWidget reuse, and shared Mock DOM', async () => {
  // 1. Standalone sqlite-client & proto-wire primitives (zero config/metrics imports)
  const sqliteClientSrc = fs.readFileSync(
    new URL('../backend/sqlite-client.mjs', import.meta.url),
    'utf8'
  );
  const protoWireSrc = fs.readFileSync(
    new URL('../backend/proto-wire.mjs', import.meta.url),
    'utf8'
  );
  assert.doesNotMatch(sqliteClientSrc, /config\.mjs|trajectory-metrics\.mjs/);
  assert.doesNotMatch(protoWireSrc, /config\.mjs|trajectory-metrics\.mjs/);

  const protoWire = await import('../backend/proto-wire.mjs');
  assert.equal(protoWire.unescapePbtxtString('\\344\\275\\240\\345\\245\\275'), '你好');
  const varState = { off: 0 };
  assert.equal(protoWire.readProtoVarint(new Uint8Array([0xac, 0x02]), varState), 300n);

  // 2. Bilingual dictionary 100% key parity
  const { I18N_MESSAGES_ZH_CN } = await import('../src/i18n/zh-CN.js');
  const { I18N_MESSAGES_EN_US } = await import('../src/i18n/en-US.js');
  const zhKeys = Object.keys(I18N_MESSAGES_ZH_CN).sort();
  const enKeys = Object.keys(I18N_MESSAGES_EN_US).sort();
  assert.deepEqual(enKeys, zhKeys);

  // 3. Structured liveActivity, agent badges/labels, turn media, and en-US SVG charts (zero Chinese leakage)
  const { createMockDom } = await import('./mock-dom.mjs');
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const { document: mockDoc } = createMockDom();
  globalThis.document = mockDoc;
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    document: mockDoc,
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };

  try {
    const { setI18nLanguage } = await import('../src/i18n/index.js');
    const {
      formatAgentBadgeText,
      formatAgentLabel,
      formatLiveActivityDetail,
      formatLiveActivityLabel,
    } = await import('../src/core/formatters.js');
    const { formatTurnPromptText } = await import('../src/components/widgets/StepTableWidget.js');
    const { LiveActivityWidget } = await import('../src/components/widgets/LiveActivityWidget.js');
    const { buildCapsuleSlotContext } = await import('../src/components/widgets/CapsuleBarWidget.js');
    const { createModelFitChart, createSessionLineChart } = await import(
      '../src/components/charts/SessionStepCharts.js'
    );
    const { createTrendAreaChart } = await import('../src/components/charts/TrendAreaChart.js');

    const waitCmdAct = extractLiveActivity(
      [
        {
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          status: 'CORTEX_STEP_STATUS_DONE',
          plannerResponse: {
            toolCalls: [{ name: 'run_command', argumentsJson: '{"CommandLine":"npm test"}' }],
          },
        },
        { type: 'CORTEX_STEP_TYPE_RUN_COMMAND', status: 'CORTEX_STEP_STATUS_WAITING' },
      ],
      true
    );
    assert.equal(waitCmdAct?.actionKey, 'run_command');
    assert.equal(waitCmdAct?.waitingApproval, true);

    setI18nLanguage('en-US');
    assert.equal(formatLiveActivityLabel(waitCmdAct), 'Awaiting Approval · Run Command');
    assert.equal(
      formatLiveActivityDetail({ detailKey: 'compaction_resuming' }),
      'Compaction finished, resuming reasoning'
    );
    assert.equal(
      formatAgentBadgeText({ agentKind: 'side_question', agentOrdinal: 2 }),
      'Q2'
    );
    assert.equal(
      formatAgentLabel({ agentKind: 'subagent', agentOrdinal: 1, customRole: 'Auditor' }),
      'Subagent #1 · Auditor'
    );
    assert.equal(
      formatTurnPromptText('Check image', { hasMedia: true, mediaOnly: false }),
      'Check image [Media]'
    );
    assert.equal(formatTurnPromptText('', { hasMedia: true, mediaOnly: true }), '[Media Attachment]');

    // Controlled LiveActivityWidget auto-expands running subagents and renders session extras
    let selectedCid = '';
    const controlledLive = LiveActivityWidget({
      defaultExpandRunningSubs: true,
      showSessionExtras: true,
      onSelectSession: (cid) => {
        selectedCid = cid;
      },
    });
    controlledLive.refs.update({
      hostRouteConversationId: 'conv-en-ctrl',
      items: [
        {
          cascadeId: 'conv-en-ctrl',
          title: 'Controlled Multi Panel',
          isMainRunning: true,
          isRunning: true,
          latestTokPerSec: 82.4,
          contextUsedPct: 44,
          mainActivity: waitCmdAct,
          subagentCount: 1,
          runningSubagentCount: 1,
          subagents: [
            {
              cascadeId: 'sub-ctrl-1',
              index: 1,
              agentKind: 'subagent',
              agentOrdinal: 1,
              customRole: 'Verifier',
              isRunning: true,
              stepCount: 2,
              liveActivity: {
                phase: 'compacting',
                actionKey: 'compacting',
                detailKey: 'compaction_resuming',
                signature: 'cp:1',
              },
            },
          ],
        },
      ],
    });
    assert.equal(controlledLive.el.querySelector('.live-sub-list').hasAttribute('hidden'), false);
    assert.equal(controlledLive.el.querySelector('.wm-session-tag.is-here').hasAttribute('hidden'), false);
    assert.equal(controlledLive.el.querySelector('.wm-task-metrics').textContent, '82.4 t/s · 44%');
    assert.equal(/[\u4e00-\u9fff]/.test(controlledLive.el.textContent), false);
    controlledLive.el.querySelector('.live-task-title').onclick({});
    assert.equal(selectedCid, 'conv-en-ctrl');
    controlledLive.refs.stopLiveTicker();

    // SVG charts in en-US emit zero Chinese characters
    const sampleSteps = Array.from({ length: 6 }, (_, i) => ({
      stepIndex: i + 1,
      baseModelLabel: 'Gemini 4 Carbon',
      baseModelShort: 'carbon-4',
      tokPerSec: 70 + i * 4,
      ttftSec: 1.1,
      cacheHitPct: 88,
      inputTokens: 1000,
      cacheReadTokens: 8000,
      outputTokens: 300,
      contextTokens: 12000,
      costUsd: 0.01,
    }));
    const lineChart = createSessionLineChart();
    const lineRes = lineChart.update({ steps: sampleSteps, metric: 'tps' });
    assert.equal(/[\u4e00-\u9fff]/.test(lineRes.summaryBadge), false);
    assert.equal(/[\u4e00-\u9fff]/.test(lineChart.el.textContent), false);
    lineChart.destroy();

    const fitChart = createModelFitChart();
    const fitRes = fitChart.update({ steps: sampleSteps, metric: 'tps' });
    assert.equal(/[\u4e00-\u9fff]/.test(fitRes.summaryBadge), false);
    assert.equal(/[\u4e00-\u9fff]/.test(fitChart.el.textContent), false);
    fitChart.destroy();

    const trendChart = createTrendAreaChart();
    const hmSlots = Array.from({ length: 95 }, (_, i) => {
      const iso = new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10);
      return { dateKey: iso, label: iso.slice(5), fullLabel: iso, tokens: (i + 1) * 500, calls: 2, costUsd: 0.02 };
    });
    trendChart.update(hmSlots);
    assert.equal(/[\u4e00-\u9fff]/.test(trendChart.el.textContent), false);
    trendChart.destroy();

    const slotCtx = buildCapsuleSlotContext(
      { activeConversation: { isRunning: true, stepCount: 2, latestTokPerSec: 64.5, context: { totalTokens: 64000, limitTokens: 256000 } } },
      {}
    );
    assert.equal(slotCtx.usedPct, 25);
    assert.equal(slotCtx.tps, 64.5);

    setI18nLanguage('zh-CN');
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  }
});

test('5h quota cycle includes cycle-opening compaction CHECKPOINT and cross-boundary steps plus unattributed cold-boot cache entries', async () => {
  const nowMs = Date.now();
  const start5hMs = nowMs - 2 * 3600_000;
  const reset5hIso = new Date(start5hMs + 5 * 3600_000).toISOString();
  const resetWkIso = new Date(nowMs + 5 * 24 * 3600_000).toISOString();

  // 1. Old step from expired previous cycle (2.5h before start5hMs) -> must be excluded from 5h
  const oldCycleStep = {
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      sourceTrajectoryStepInfo: { stepIndex: 1 },
      createdAt: new Date(start5hMs - 2.5 * 3600_000).toISOString(),
      completedAt: new Date(start5hMs - 2.5 * 3600_000 + 8_000).toISOString(),
      modelUsage: {
        model: 'MODEL_PLACEHOLDER_M429',
        inputTokens: '100000',
        cacheReadTokens: '0',
        outputTokens: '5000',
      },
    },
  };

  // 2. Untimed /compact CHECKPOINT started 70s BEFORE start5hMs that settled & opened the 5h bucket -> must be included!
  const compactOpeningStep = {
    type: 'CORTEX_STEP_TYPE_CHECKPOINT',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      sourceTrajectoryStepInfo: { stepIndex: 2 },
      createdAt: new Date(start5hMs - 70_000).toISOString(),
      modelUsage: {
        model: 'MODEL_PLACEHOLDER_M429',
        inputTokens: '300000',
        cacheReadTokens: '0',
        outputTokens: '4000',
      },
    },
  };

  // 3. Normal step after compaction inside 5h window
  const postCompactStep = {
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      sourceTrajectoryStepInfo: { stepIndex: 3 },
      createdAt: new Date(start5hMs + 120_000).toISOString(),
      completedAt: new Date(start5hMs + 135_000).toISOString(),
      modelUsage: {
        model: 'MODEL_PLACEHOLDER_M429',
        inputTokens: '6000',
        cacheReadTokens: '80000',
        outputTokens: '2000',
      },
    },
  };

  // 4. Cold-boot cached conversation initially saved with accountName: '' before email loaded -> included for Alice, while Bob stays excluded
  const coldBootStep = {
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      sourceTrajectoryStepInfo: { stepIndex: 1 },
      createdAt: new Date(start5hMs - 40_000).toISOString(),
      completedAt: new Date(start5hMs + 10_000).toISOString(),
      modelUsage: {
        model: 'MODEL_PLACEHOLDER_M429',
        inputTokens: '10000',
        cacheReadTokens: '0',
        outputTokens: '1000',
      },
    },
  };

  const h = backendHarness({
    userStatus: { email: 'alice@example.com', userTier: { name: 'Google AI Ultra' } },
    quotaSummary: {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.929, resetTime: reset5hIso },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.395, resetTime: resetWkIso },
          ],
        },
      ],
    },
    cache: {
      'cold-boot-conv': {
        accountName: '',
        signature: 'v10-model-identity:cold',
        steps: extractModelSteps([coldBootStep]),
      },
      'bob-conv': {
        accountName: 'bob@example.com',
        signature: 'v10-model-identity:bob',
        steps: extractModelSteps([postCompactStep]),
      },
    },
    summaries: {
      'main-conv': { stepCount: 3, lastModifiedTime: new Date(nowMs - 10_000).toISOString(), status: 'IDLE' },
    },
    trajectories: {
      'main-conv': { trajectory: { steps: [oldCycleStep, compactOpeningStep, postCompactStep] } },
    },
  });

  const payload = await h.buildTelemetryPayloadInternal('main-conv', false, { range: '5h' });
  const geminiPool = payload.quotas.pools.find((p) => p.poolKey === 'Gemini');
  // Includes compactOpeningStep (304,000) + postCompactStep (88,000) + coldBootStep (11,000) = 403,000 tokens (3 calls)
  assert.equal(geminiPool.cycle5h.calls, 3);
  assert.equal(geminiPool.cycle5h.tokens, 403_000);
  // Preset 5h account bucket includes Alice's 3 calls (403k) + Bob's 1 call (88k), excluding oldCycleStep (105k)
  assert.equal(payload.consumption.account.calls, 4);
  assert.equal(payload.consumption.account.totalTokens, 491_000);
});

test('i18n static t(...) key completeness guard across all supported locales, backend copy, currency, and localized trend/export outputs', async () => {
  const { I18N_DICTIONARIES, setI18nLanguage } = await import('../src/i18n/index.js');
  const {
    SUPPORTED_LOCALE_ENTRIES,
    SUPPORTED_LOCALES,
    normalizeLanguageSetting,
    resolveLocaleFromLanguageTag,
  } = await import('../shared/settings-normalization.mjs');
  const {
    LOCALE_DEFAULT_CURRENCY,
    SUPPORTED_CURRENCY_CODES,
  } = await import('../shared/currency-catalog.mjs');
  const { LOGIN_CALLBACK_COPY } = await import('../backend/account-login.mjs');
  const { CLI_STATUS_COPY } = await import('../backend/cli-statusline-config.mjs');
  const { STANDALONE_LOCALE_COPY } = await import('../backend/standalone-server.mjs');
  const {
    formatAgentBadgeText,
    formatAgentLabel,
    formatDateSpanBadge,
    formatQuotaPoolLabel,
    formatShortMonthName,
    formatShortWeekdayName,
    formatTrendSlotFullLabel,
  } = await import('../src/core/formatters.js');
  const { buildStructurePreviewTelemetry } = await import('../src/components/settings/structurePreviewMock.js');
  const {
    buildConsumptionCsv,
    buildStepsCsv,
    buildStepsMarkdownReport,
    buildStepsXlsx,
  } = await import('../src/core/reportExporter.js');
  const { TopLongPillNav } = await import('../src/components/ui/TopLongPillNav.js');
  const { createTrendAreaChart } = await import('../src/components/charts/TrendAreaChart.js');
  const { createMockDom } = await import('./mock-dom.mjs');

  // 1. Every registered locale in SUPPORTED_LOCALE_ENTRIES has full end-to-end coverage
  const srcRoot = fileURLToPath(new URL('../src', import.meta.url));
  const walkJs = (dir) => {
    const out = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) out.push(...walkJs(p));
      else if (ent.name.endsWith('.js') || ent.name.endsWith('.mjs')) out.push(p);
    }
    return out;
  };
  assert.equal(new Set(SUPPORTED_LOCALES).size, SUPPORTED_LOCALES.length, 'SUPPORTED_LOCALES must have no duplicates');
  for (const entry of SUPPORTED_LOCALE_ENTRIES) {
    assert.equal(typeof entry.locale === 'string' && entry.locale.length > 0, true);
    assert.equal(typeof entry.nativeName === 'string' && entry.nativeName.trim().length > 0, true);
  }
  assert.deepEqual(
    Object.keys(I18N_DICTIONARIES).sort(),
    [...SUPPORTED_LOCALES].sort(),
    'I18N_DICTIONARIES must register every supported locale'
  );
  const enDict = I18N_DICTIONARIES['en-US'];
  const enKeys = new Set(Object.keys(enDict));
  const extractPh = (str) => [...String(str).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const emojiRe = /\p{Extended_Pictographic}/u;
  const currencyCodeSet = new Set(SUPPORTED_CURRENCY_CODES);
  const sampleMs = new Date(2026, 10, 24, 10, 0, 0, 0).getTime();
  for (const loc of SUPPORTED_LOCALES) {
    assert.equal(
      fs.existsSync(join(srcRoot, 'i18n', `${loc}.js`)),
      true,
      `src/i18n/${loc}.js must exist for build-bundle.mjs`
    );
    assert.equal(resolveLocaleFromLanguageTag(loc), loc, `${loc} must round-trip in resolveLocaleFromLanguageTag`);
    assert.equal(normalizeLanguageSetting(loc), loc, `${loc} must round-trip in normalizeLanguageSetting`);
    assert.equal(
      currencyCodeSet.has(LOCALE_DEFAULT_CURRENCY[loc]),
      true,
      `LOCALE_DEFAULT_CURRENCY[${loc}] must map to a supported currency`
    );

    const loginCopy = LOGIN_CALLBACK_COPY[loc];
    assert.ok(loginCopy, `LOGIN_CALLBACK_COPY missing ${loc}`);
    for (const field of ['htmlLang', 'okTitle', 'failTitle', 'detail']) {
      assert.equal(typeof loginCopy[field] === 'string' && loginCopy[field].length > 0, true, `LOGIN_CALLBACK_COPY.${loc}.${field}`);
    }

    const standaloneCopy = STANDALONE_LOCALE_COPY[loc];
    assert.ok(standaloneCopy, `STANDALONE_LOCALE_COPY missing ${loc}`);
    for (const field of ['htmlLang', 'title', 'authTitle', 'desc', 'err', 'placeholder', 'submit']) {
      assert.equal(typeof standaloneCopy[field] === 'string' && standaloneCopy[field].length > 0, true, `STANDALONE_LOCALE_COPY.${loc}.${field}`);
    }

    const cliCopy = CLI_STATUS_COPY[loc];
    assert.ok(cliCopy, `CLI_STATUS_COPY missing ${loc}`);
    for (const field of ['ctx', 'gen', 'idle', 'avg', 'sum', 'cache', 'quotaAuto', 'quotaEmpty', 'wk', 'idleZero']) {
      assert.equal(typeof cliCopy[field] === 'string' && cliCopy[field].length > 0, true, `CLI_STATUS_COPY.${loc}.${field}`);
    }
    assert.equal(typeof cliCopy.active, 'function', `CLI_STATUS_COPY.${loc}.active`);
    assert.equal(typeof cliCopy.activeSub, 'function', `CLI_STATUS_COPY.${loc}.activeSub`);
    assert.ok(cliCopy.anom && typeof cliCopy.anom.error === 'function', `CLI_STATUS_COPY.${loc}.anom`);

    assert.ok(formatShortMonthName(0, loc).length > 0, `${loc} short month name`);
    assert.ok(formatShortWeekdayName(1, loc).length > 0, `${loc} short weekday name`);
    assert.ok(formatDateSpanBadge(sampleMs, sampleMs + 86400_000, { locale: loc }).length > 0, `${loc} date span`);

    const dict = I18N_DICTIONARIES[loc];
    const locKeys = new Set(Object.keys(dict));
    assert.deepEqual([...enKeys].filter((k) => !locKeys.has(k)), [], `${loc} missing keys`);
    assert.deepEqual([...locKeys].filter((k) => !enKeys.has(k)), [], `${loc} extra keys`);
    for (const k of enKeys) {
      const val = dict[k];
      assert.equal(typeof val === 'string' && val.length > 0, true, `${loc}.${k} must be non-empty`);
      assert.equal(extractPh(val), extractPh(enDict[k]), `${loc}.${k} placeholder mismatch`);
      assert.equal(emojiRe.test(val), false, `${loc}.${k} must not contain emoji`);
      if (k.startsWith('report.sheet')) {
        assert.equal(val.length <= 31 && !/[\[\]:*?\/\\]/.test(val), true, `${loc}.${k} invalid Excel sheet name`);
      }
    }
  }

  // Unlisted locales fall back gracefully via Intl.DateTimeFormat for month/weekday names
  assert.equal(formatShortMonthName(2, 'de-DE', { stripTrailingDot: true }), 'Mär');
  assert.equal(formatShortMonthName(0, 'fr-FR', { stripTrailingDot: true }), 'janv');
  assert.ok(formatShortMonthName(0, 'vi-VN').length > 0);
  assert.ok(formatShortWeekdayName(1, 'vi-VN').length > 0);

  // BCP-47 tag normalization + regional aliases
  assert.equal(resolveLocaleFromLanguageTag('zh-HK'), 'zh-TW');
  assert.equal(resolveLocaleFromLanguageTag('zh-Hant-TW'), 'zh-TW');
  assert.equal(resolveLocaleFromLanguageTag('zh-Hans-CN'), 'zh-CN');
  assert.equal(resolveLocaleFromLanguageTag('ja'), 'ja-JP');
  assert.equal(resolveLocaleFromLanguageTag('ko'), 'ko-KR');
  assert.equal(resolveLocaleFromLanguageTag('de-AT'), 'de-DE');
  assert.equal(resolveLocaleFromLanguageTag('fr-CA'), 'fr-FR');

  const missingKeys = [];
  for (const filePath of walkJs(srcRoot)) {
    const srcText = fs.readFileSync(filePath, 'utf8');
    const re = /(?<![.\w])t\(\s*(['"])([^'"]+)\1/g;
    let m;
    while ((m = re.exec(srcText)) !== null) {
      const k = m[2];
      for (const loc of SUPPORTED_LOCALES) {
        if (!(k in I18N_DICTIONARIES[loc])) {
          missingKeys.push(`${filePath}:${loc}:${k}`);
        }
      }
    }
  }
  assert.deepEqual(missingKeys, []);

  // 2. agentKind === 'all' & structurePreviewMock never leak raw key strings
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    location: { origin: 'http://127.0.0.1:41234', href: 'http://127.0.0.1:41234/' },
    addEventListener() {},
    removeEventListener() {},
  };

  try {
    setI18nLanguage('zh-CN');
    assert.equal(formatAgentBadgeText({ agentKind: 'all' }), '全');
    assert.equal(formatAgentLabel({ agentKind: 'all' }), '全部代理');
    assert.equal(buildStructurePreviewTelemetry().activeConversation.aggregated.badgeText, '全');

    setI18nLanguage('en-US');
    assert.equal(formatAgentBadgeText({ agentKind: 'all' }), 'All');
    assert.equal(formatAgentLabel({ agentKind: 'all' }), 'All Agents');
    assert.equal(buildStructurePreviewTelemetry().activeConversation.aggregated.badgeText, 'All');

    // 3. TrendAreaChart tooltip + X-axis tick title & CSV export localize dates in en-US without hardcoded Chinese
    const localStart = new Date(new Date().getFullYear(), 10, 24, 10, 0, 0, 0).getTime();
    const localEnd = localStart + 3600_000;
    const hourlySlot = {
      index: 0,
      startMs: localStart,
      endMs: localEnd,
      granularity: 'hour',
      label: '10:00',
      fullLabel: '11月24日 10:00 - 11:00',
      tokens: 12_000,
      inputTokens: 8_000,
      cacheReadTokens: 3_000,
      outputTokens: 1_000,
      costUsd: 0.05,
      calls: 2,
    };
    const dailySlot = {
      index: 0,
      startMs: new Date(2025, 10, 24, 0, 0, 0, 0).getTime(),
      endMs: new Date(2025, 10, 25, 0, 0, 0, 0).getTime(),
      granularity: 'day',
      label: '11/24',
      fullLabel: '2025年11月24日 (周一)',
      tokens: 25_000,
      calls: 4,
      costUsd: 0.12,
    };

    assert.equal(formatTrendSlotFullLabel(hourlySlot, { locale: 'en-US' }), 'Nov 24, 10:00 - 11:00');
    assert.equal(formatTrendSlotFullLabel(hourlySlot, { locale: 'zh-CN' }), '11月24日 10:00 - 11:00');
    assert.equal(formatTrendSlotFullLabel(dailySlot, { locale: 'en-US' }), 'Nov 24, 2025 (Mon)');
    assert.equal(formatTrendSlotFullLabel(dailySlot, { locale: 'zh-CN' }), '2025年11月24日 (周一)');

    const chart = createTrendAreaChart();
    setI18nLanguage('en-US');
    chart.update([hourlySlot, { ...hourlySlot, index: 1, startMs: localEnd, endMs: localEnd + 3600_000, label: '11:00', fullLabel: '11月24日 11:00 - 12:00' }]);
    const enTicks = chart.el.querySelectorAll('.trend-x-tick');
    assert.equal(enTicks[0].getAttribute('title'), 'Nov 24, 10:00 - 11:00');
    enTicks[0].onclick?.();
    assert.match(chart.el.textContent, /Nov 24, 10:00 - 11:00/);
    assert.doesNotMatch(chart.el.textContent, /11月24日/);

    setI18nLanguage('zh-CN');
    chart.update([hourlySlot, { ...hourlySlot, index: 1, startMs: localEnd, endMs: localEnd + 3600_000, label: '11:00', fullLabel: '11月24日 11:00 - 12:00' }]);
    const zhTicks = chart.el.querySelectorAll('.trend-x-tick');
    assert.equal(zhTicks[0].getAttribute('title'), '11月24日 10:00 - 11:00');
    chart.destroy();

    const csvEn = buildConsumptionCsv(
      {
        selectedRange: { key: 'cycle', label: '当前周期' },
        account: { calls: 2, inputTokens: 8000, cacheReadTokens: 3000, outputTokens: 1000, totalTokens: 12000, cacheHitPct: 27.3, costUsd: 0.05, savedCostUsd: 0.01 },
        trendSeries: [hourlySlot],
      },
      [],
      { locale: 'en-US', includeBom: false }
    );
    assert.match(csvEn, /summary,Current Cycle,/);
    assert.match(csvEn, /trend,"Nov 24, 10:00 - 11:00",/);
    assert.doesNotMatch(csvEn, /[\u4e00-\u9fff]/);

    // 4. TopLongPillNav aria-label, structurePreviewMock, formatQuotaPoolLabel & explicit en-US step exports never leak Chinese
    setI18nLanguage('zh-CN');
    const pillNav = TopLongPillNav({
      modelValue: 'overview',
      items: [{ value: 'overview', label: '实时监控' }],
    });
    assert.equal(pillNav.el.getAttribute('aria-label'), '主功能视图分割导航');
    assert.equal(formatQuotaPoolLabel('未知'), '未知');

    setI18nLanguage('en-US');
    pillNav.setProps({ items: [{ value: 'overview', label: 'Live' }] });
    assert.equal(pillNav.el.getAttribute('aria-label'), 'Main navigation views');
    assert.equal(formatQuotaPoolLabel('未知'), 'Unknown');
    pillNav.destroy();

    const enPreview = buildStructurePreviewTelemetry();
    assert.doesNotMatch(JSON.stringify(enPreview), /[\u4e00-\u9fff]/);

    // Even when global i18nStore is zh-CN, explicit { locale: 'en-US' } step exports must not leak Chinese agent/compaction labels
    setI18nLanguage('zh-CN');
    const backendLikeSteps = [
      {
        stepIndex: 1,
        createdAtMs: localStart,
        agentKind: 'main',
        agentLabel: '主代理',
        agentBadge: '主',
        isSubagent: false,
        isCompactionStep: true,
        modelLabel: 'Gemini 4 Carbon (High) [自动压缩]',
        modelShort: 'carbon-4-high·压缩',
        modelUpstream: 'gemini-4-carbon-high·压缩',
        inputTokens: 1000,
        cacheReadTokens: 4000,
        outputTokens: 300,
        costUsd: 0.02,
      },
      {
        stepIndex: 2,
        createdAtMs: localStart + 5000,
        agentKind: 'subagent',
        agentOrdinal: 1,
        agentLabel: '子代理 #1',
        agentBadge: '子1',
        isSubagent: true,
        modelLabel: 'Gemini 3.8 Flash',
        modelShort: 'flash-3.8',
        inputTokens: 500,
        cacheReadTokens: 1500,
        outputTokens: 200,
        costUsd: 0.005,
      },
    ];
    const stepsCsvEn = buildStepsCsv(backendLikeSteps, { locale: 'en-US', includeBom: false });
    assert.match(stepsCsvEn, /,Main,carbon-4-high·compact,/);
    assert.match(stepsCsvEn, /,Subagent #1,flash-3\.8,/);
    assert.doesNotMatch(stepsCsvEn, /[\u4e00-\u9fff]/);

    const stepsMdEn = buildStepsMarkdownReport(backendLikeSteps, {
      title: 'Session Audit',
      locale: 'en-US',
    });
    assert.match(stepsMdEn, /carbon-4-high·compact/);
    assert.doesNotMatch(stepsMdEn, /[\u4e00-\u9fff]/);

    const stepsXlsxEnBytes = buildStepsXlsx(backendLikeSteps, { locale: 'en-US' });
    const stepsXlsxEnRaw = Buffer.from(stepsXlsxEnBytes).toString('utf8');
    assert.match(stepsXlsxEnRaw, /carbon-4-high·compact/);
    assert.match(stepsXlsxEnRaw, />Main</);
    assert.match(stepsXlsxEnRaw, />Subagent #1</);
    assert.doesNotMatch(stepsXlsxEnRaw, /[\u4e00-\u9fff]/);

    // Non-binary locales (ja-JP / ko-KR / de-DE / fr-FR / zh-TW) export cleanly with localized labels
    const stepsCsvJa = buildStepsCsv(backendLikeSteps, { locale: 'ja-JP', includeBom: false });
    assert.match(stepsCsvJa, /carbon-4-high·圧縮/);
    const stepsCsvDe = buildStepsCsv(backendLikeSteps, { locale: 'de-DE', includeBom: false });
    assert.match(stepsCsvDe, /carbon-4-high·komp\./);
    assert.doesNotMatch(stepsCsvDe, /[\u4e00-\u9fff]/);
    const stepsCsvFr = buildStepsCsv(backendLikeSteps, { locale: 'fr-FR', includeBom: false });
    assert.match(stepsCsvFr, /carbon-4-high·comp\./);
    assert.doesNotMatch(stepsCsvFr, /[\u4e00-\u9fff]/);
    const stepsCsvKo = buildStepsCsv(backendLikeSteps, { locale: 'ko-KR', includeBom: false });
    assert.match(stepsCsvKo, /carbon-4-high·압축/);
    assert.doesNotMatch(stepsCsvKo, /[\u4e00-\u9fff]/);
    const stepsCsvTw = buildStepsCsv(backendLikeSteps, { locale: 'zh-TW', includeBom: false });
    assert.match(stepsCsvTw, /carbon-4-high·壓縮/);

    // Every registered locale exports cleanly without leaking raw Chinese in non-CJK locales
    for (const loc of SUPPORTED_LOCALES) {
      const csv = buildStepsCsv(backendLikeSteps, { locale: loc, includeBom: false });
      assert.ok(csv.length > 0, `${loc} CSV export non-empty`);
      if (loc !== 'zh-CN' && loc !== 'zh-TW' && loc !== 'ja-JP') {
        assert.doesNotMatch(csv, /[\u4e00-\u9fff]/, `${loc} CSV must not leak Chinese characters`);
      }
    }
  } finally {
    setI18nLanguage('zh-CN');
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  }
});

test('xlsxBuilder enforces 32,767 UTF-16 cell limit without splitting surrogate pairs or emitting lone surrogates', async () => {
  const { buildXlsxWorkbookBytes, MAX_EXCEL_CELL_CHARS } = await import('../src/core/xlsxBuilder.js');
  assert.equal(MAX_EXCEL_CELL_CHARS, 32767);

  // Place an emoji ('😀' = \uD83D\uDE00, 2 UTF-16 code units) straddling index 32765..32766
  const boundaryEmojiText = `${'A'.repeat(32765)}😀${'B'.repeat(500)}`;
  const loneSurrogateText = `ok\uD800mid\uDC00end`;
  const bytes = buildXlsxWorkbookBytes([
    {
      name: 'OverflowGuard',
      columns: [{ header: 'TextCol', type: 'text' }],
      rows: [[boundaryEmojiText], [loneSurrogateText]],
    },
  ]);

  const rawArchiveStr = Buffer.from(bytes).toString('utf8');
  const cellMatches = [...rawArchiveStr.matchAll(/<c r="A[23]"[^>]*><is><t[^>]*>([\s\S]*?)<\/t><\/is><\/c>/g)];
  assert.equal(cellMatches.length, 2);

  const cellA2 = cellMatches[0][1];
  assert.ok(
    cellA2.length <= MAX_EXCEL_CELL_CHARS,
    `Expected <= 32767 UTF-16 code units, got ${cellA2.length}`
  );
  assert.equal(cellA2.length, 32766, 'Backs off by 1 code unit before emoji high surrogate + ellipsis');
  assert.ok(cellA2.endsWith('…'));
  assert.equal(/[\uD800-\uDFFF]/.test(cellA2), false, 'No split surrogate code unit remains');

  const cellA3 = cellMatches[1][1];
  assert.equal(cellA3, 'ok\uFFFDmid\uFFFDend');
});

test('ConsumptionView and TrendAreaChart patch text DOM nodes in-place without opacity flicker classes on date range switches', async () => {
  const consCss = fs.readFileSync(
    fileURLToPath(new URL('../src/styles/views-consumption.css', import.meta.url)),
    'utf8'
  );
  for (const bannedToken of [
    'is-range-switching',
    'is-tab-entering',
    'is-switching',
    'is-stage-entering',
    'anim-cons-content-switch',
    'anim-cons-axis-fade',
    'anim-cons-stage-in',
  ]) {
    assert.equal(
      consCss.includes(bannedToken),
      false,
      `Expected views-consumption.css not to contain text-opacity flicker rule "${bannedToken}"`
    );
  }

  const { createMockDom } = await import('./mock-dom.mjs');
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    location: { origin: 'http://127.0.0.1:41234', href: 'http://127.0.0.1:41234/' },
    getComputedStyle: () => ({ overflow: 'visible', overflowX: 'visible', overflowY: 'visible' }),
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (cb) => setTimeout(() => cb(performance.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    addEventListener() {},
    removeEventListener() {},
  };

  try {
    const { ConsumptionView } = await import('../src/views/ConsumptionView.js');
    const { telemetryStore } = await import('../src/store/telemetryStore.js');
    const { uiStore } = await import('../src/store/uiStore.js');
    const prevTelState = { ...telemetryStore.getState() };
    const prevUiState = { ...uiStore.getState() };

    uiStore.setState(
      { activeView: 'consumption', monitorVisible: true, settingsOpen: false },
      { sync: true }
    );
    const view = ConsumptionView();
    document.body.appendChild(view.el);

    const makeRangePayload = (rangeKey, tokBase, labels) => ({
      settings: { modelDisplayMode: 'short', showUpstreamModel: false },
      consumption: {
        revision: 0,
        selectedRange: {
          key: rangeKey,
          label: rangeKey,
          startMs: 1_760_000_000_000,
          endMs: 1_760_086_400_000,
        },
        account: {
          totalTokens: tokBase,
          inputTokens: Math.round(tokBase * 0.2),
          cacheReadTokens: Math.round(tokBase * 0.7),
          outputTokens: Math.round(tokBase * 0.1),
          responseTokens: Math.round(tokBase * 0.07),
          thinkingTokens: Math.round(tokBase * 0.03),
          calls: 12,
          costUsd: 1.25,
          savedCostUsd: 0.85,
          cacheHitPct: 77.8,
        },
        trendSeries: labels.map((lbl, idx) => ({
          index: idx,
          startMs: 1_760_000_000_000 + idx * 3_600_000,
          endMs: 1_760_000_000_000 + (idx + 1) * 3_600_000,
          granularity: labels.length > 90 ? 'day' : 'hour',
          label: lbl,
          fullLabel: lbl,
          tokens: 1_000 * (idx + 1),
          calls: 1,
          costUsd: 0.05,
        })),
        sourcesBreakdown: [
          {
            name: 'antigravity',
            label: 'Antigravity IDE',
            totalTokens: tokBase,
            calls: 12,
            costUsd: 1.25,
            models: [{ label: 'Claude Opus 4.6', shortName: 'Claude Opus 4.6', totalTokens: tokBase, calls: 12 }],
          },
        ],
        topConversations: [],
        topWorkspaces: [],
        monthlyYear: 2026,
        monthlySeries: Array.from({ length: 12 }, (_, m) => ({
          month: m + 1,
          totalTokens: m === 10 ? tokBase : 0,
          costUsd: m === 10 ? 1.25 : 0,
          calls: m === 10 ? 12 : 0,
        })),
      },
      modelBreakdown: [
        {
          label: 'Claude Opus 4.6',
          shortName: 'Claude Opus 4.6',
          totalTokens: tokBase,
          inputTokens: Math.round(tokBase * 0.2),
          cacheReadTokens: Math.round(tokBase * 0.7),
          responseTokens: Math.round(tokBase * 0.07),
          thinkingTokens: Math.round(tokBase * 0.03),
          outputTokens: Math.round(tokBase * 0.1),
          calls: 12,
          costUsd: 1.25,
        },
      ],
    });

    telemetryStore.setState(
      {
        selectedTimeRange: 'today',
        telemetry: makeRangePayload('today', 100_000, ['00:00', '06:00', '12:00', '18:00']),
      },
      { sync: true }
    );

    const matrixEl = view.el.querySelector('.cons-unified-matrix');
    const heroNumEl = view.el.querySelector('.cons-hero-num');
    const modelRowEl = view.el.querySelector('.cons-item-row');
    const modelTitleTextEl = modelRowEl.querySelector('.cons-row-title-text');
    const sourceRowEl = view.el.querySelector('.cons-source-row');
    const xAxisEl = view.el.querySelector('.trend-x-axis');
    const initialTicks = xAxisEl.querySelectorAll('.trend-x-tick');
    assert.equal(initialTicks.length, 4);

    // Switch to 7d: same model, same source, updated numbers & tick labels -> all DOM nodes reused in-place, zero opacity flicker classes
    telemetryStore.setState(
      {
        selectedTimeRange: '7d',
        telemetry: makeRangePayload('7d', 450_000, ['11/18', '11/20', '11/22', '11/24']),
      },
      { sync: true }
    );

    assert.equal(view.el.querySelector('.cons-hero-num'), heroNumEl, 'Hero token element persists');
    assert.equal(view.el.querySelector('.cons-item-row'), modelRowEl, 'Model row element persists');
    assert.equal(
      view.el.querySelector('.cons-item-row .cons-row-title-text'),
      modelTitleTextEl,
      'Model title text node persists'
    );
    assert.equal(view.el.querySelector('.cons-source-row'), sourceRowEl, 'Source row element persists');

    const nextTicks = xAxisEl.querySelectorAll('.trend-x-tick');
    assert.equal(nextTicks.length, 4);
    for (let i = 0; i < 4; i++) {
      assert.equal(nextTicks[i], initialTicks[i], `Trend X-axis tick #${i} reused in-place`);
    }
    assert.equal(nextTicks[0].textContent, '11/18');

    for (const cls of ['is-range-switching', 'is-tab-entering', 'is-switching', 'is-stage-entering']) {
      assert.equal(matrixEl.classList.contains(cls), false);
      assert.equal(modelRowEl.parentNode.classList.contains(cls), false);
      assert.equal(sourceRowEl.parentNode.classList.contains(cls), false);
      assert.equal(xAxisEl.classList.contains(cls), false);
    }

    // Switch to >90d heatmap and update counts -> month labels and grid cells reuse pooled nodes in-place
    const hmLabelsA = Array.from({ length: 95 }, (_, idx) => `08/${String((idx % 28) + 1).padStart(2, '0')}`);
    telemetryStore.setState(
      {
        selectedTimeRange: 'all',
        telemetry: makeRangePayload('all', 900_000, hmLabelsA),
      },
      { sync: true }
    );
    const hmGridEl = view.el.querySelector('.trend-hm-grid');
    const firstGridCells = [...hmGridEl.children];
    assert.ok(firstGridCells.length >= 95);

    telemetryStore.setState(
      {
        selectedTimeRange: 'all',
        telemetry: makeRangePayload('all', 950_000, hmLabelsA),
      },
      { sync: true }
    );
    const secondGridCells = [...hmGridEl.children];
    assert.equal(secondGridCells.length, firstGridCells.length);
    assert.equal(secondGridCells[10], firstGridCells[10], 'Heatmap cell DOM node reused in-place');

    // Switch to 'cycle' with multiple quota pools -> compact inline pool selector becomes visible (and stays hidden on 'today'/'all')
    assert.equal(view.refs.cyclePoolSelect.el.hasAttribute('hidden'), true, 'Hidden outside cycle range');
    const cyclePoolsFixture = [
      {
        poolKey: 'Gemini',
        poolLabel: 'Gemini',
        weeklyRemainingPct: 99.7,
        cycleWeekly: { calls: 12, tokens: 2_480_000, costUsd: 0.86 },
      },
      {
        poolKey: 'Claude & GPT',
        poolLabel: 'Claude & GPT',
        weeklyRemainingPct: 38.0,
        cycleWeekly: { calls: 690, tokens: 172_580_000, costUsd: 61.38 },
      },
    ];
    const baseCyclePayload = makeRangePayload('cycle', 2_480_000, ['12:00', '14:00', '16:00', '18:00']);
    baseCyclePayload.quotas = { pools: cyclePoolsFixture };
    baseCyclePayload.consumption.selectedRange = {
      key: 'cycle',
      pool: 'Gemini',
      poolLabel: 'Gemini',
      label: '当前周期 · Gemini',
      startMs: 1_760_040_000_000,
      endMs: 1_760_061_600_000,
    };
    telemetryStore.setState(
      {
        selectedTimeRange: 'cycle',
        selectedCyclePool: 'Gemini',
        telemetry: baseCyclePayload,
      },
      { sync: true }
    );
    assert.equal(view.refs.cyclePoolSelect.el.hasAttribute('hidden'), false, 'Shown on cycle with >=2 pools');
    assert.equal(view.refs.cyclePoolSelect.refs.triggerLabel.textContent, 'Gemini');
    const badges = view.el.querySelectorAll('.cons-badge');
    assert.match(badges[1]?.textContent || '', /当前周期 · Gemini/);

    // Open dropdown and verify localized pool metadata + switch back to 'today' hides dropdown
    view.refs.cyclePoolSelect.open();
    const optTexts = [...view.refs.cyclePoolSelect.refs.optionsListEl.children].map(
      (btn) => btn.textContent
    );
    assert.equal(optTexts.length, 3);
    assert.match(optTexts[0], /全部池.*\$62\.24/);
    assert.match(optTexts[1], /Gemini.*剩 99\.7% · \$0\.86/);
    assert.match(optTexts[2], /Claude & GPT.*剩 38\.0% · \$61\.38/);

    telemetryStore.setState(
      {
        selectedTimeRange: 'today',
        telemetry: makeRangePayload('today', 100_000, ['00:00', '06:00', '12:00', '18:00']),
      },
      { sync: true }
    );
    assert.equal(view.refs.cyclePoolSelect.el.hasAttribute('hidden'), true, 'Re-hidden on today');

    view.destroy();
    telemetryStore.setState(prevTelState, { sync: true });
    uiStore.setState(prevUiState, { sync: true });
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  }
});

test('Issue #45: grouped modelBreakdown, trend bucket models, and merged agent units pick dominant shortName (tie-breaking to shorter base alias)', async () => {
  const { buildScopedModelBreakdown, aggregateSelectedWindowUsage } = await import(
    '../backend/usage-aggregator.mjs'
  );
  const { mergeSelectedAgentUnits } = await import('../src/views/StepsDetailView.js');

  const mkStep = (tier, createdAtMs) => ({
    modelKey: tier,
    inputTokens: 1000,
    cacheReadTokens: 2000,
    outputTokens: 300,
    thinkingTokens: 100,
    createdAtMs,
  });
  const resolveTier = (st) => {
    if (st.modelKey === 'low') {
      return {
        label: 'Gemini 4 Neon (Low)',
        baseLabel: 'Gemini 4 Neon',
        shortName: 'neon-4-low',
        modelId: 'gemini-4-neon',
        family: 'Gemini',
        pricing: null,
      };
    }
    return {
      label: 'Gemini 4 Neon (Medium)',
      baseLabel: 'Gemini 4 Neon',
      shortName: 'neon-4',
      modelId: 'gemini-4-neon',
      family: 'Gemini',
      pricing: null,
    };
  };

  // 1. Dominant tier wins even when minority tier appears first
  const now = Date.now();
  const mixedSteps = [
    mkStep('low', now - 5000),
    mkStep('medium', now - 4000),
    mkStep('medium', now - 3000),
    mkStep('medium', now - 2000),
    mkStep('medium', now - 1000),
  ];
  const dominantBreakdown = buildScopedModelBreakdown(mixedSteps, resolveTier);
  assert.equal(dominantBreakdown.length, 1);
  assert.equal(dominantBreakdown[0].calls, 5);
  assert.equal(dominantBreakdown[0].shortName, 'neon-4');

  // 2. Tie breaks in favor of shorter base alias regardless of scan order
  const tiedSteps = [
    mkStep('low', now - 4000),
    mkStep('low', now - 3000),
    mkStep('medium', now - 2000),
    mkStep('medium', now - 1000),
  ];
  const tiedBreakdown = buildScopedModelBreakdown(tiedSteps, resolveTier);
  assert.equal(tiedBreakdown[0].shortName, 'neon-4');

  // 3. Trend series bucket perModelStats also resolves dominant shortName
  const rangeRes = aggregateSelectedWindowUsage({
    precollectedEntries: [
      {
        cascadeId: 'cid-issue-45',
        steps: mixedSteps,
        stepCount: mixedSteps.length,
        lastModifiedMs: now,
      },
    ],
    filterOpts: { range: 'today' },
    resolveStepModel: resolveTier,
  });
  assert.equal(rangeRes.modelBreakdown[0].shortName, 'neon-4');
  const activeTrendBuckets = (rangeRes.trendSeries || []).filter(
    (b) => Array.isArray(b.models) && b.models.length > 0
  );
  assert.ok(activeTrendBuckets.length > 0, 'Trend bucket populated');
  assert.equal(activeTrendBuckets[0].models[0].shortName, 'neon-4');

  // 4. StepsDetailView mergeSelectedAgentUnits weights shortName by calls
  const merged = mergeSelectedAgentUnits([
    {
      modelBreakdown: [
        { label: 'Gemini 4 Neon', shortName: 'neon-4-low', calls: 2, inputTokens: 2000, outputTokens: 400, totalTokens: 2400, costUsd: 0.01 },
      ],
    },
    {
      modelBreakdown: [
        { label: 'Gemini 4 Neon', shortName: 'neon-4', calls: 10, inputTokens: 10000, outputTokens: 2000, totalTokens: 12000, costUsd: 0.05 },
      ],
    },
  ]);
  assert.equal(merged.models.length, 1);
  assert.equal(merged.models[0].shortName, 'neon-4');
});

test('Conversation undo UI & SQLite persistence: reverted steps keep distinct keys, render gray .is-reverted rows, break turn rails, and round-trip via SQLite flags', async () => {
  const { createMockDom } = await import('./mock-dom.mjs');
  const { getStepSelectionKey } = await import('../src/core/stepInspector.js');
  const { StepTableWidget } = await import('../src/components/widgets/StepTableWidget.js');
  const {
    splitStepForStorage,
    buildSlimStepFromAccounting,
  } = await import('../backend/trajectory-sqlite-ledger.mjs');

  // 1. SQLite bitmask round-trips isReverted cleanly without touching detail_json
  const activeStep = {
    stepIndex: 5,
    createdAtMs: 1767225645000,
    modelKey: 'MODEL_PLACEHOLDER_M37',
    modelShort: 'Gemini 3.1 Pro',
    modelLabel: 'Gemini 3.1 Pro',
    inputTokens: 3000,
    cacheReadTokens: 26000,
    outputTokens: 1200,
    thinkingTokens: 200,
    responseTokens: 1000,
    contextTokens: 30200,
    turnIndex: 3,
    isTurnStart: true,
    isLatestTurn: true,
    turnPrompt: 'new branch prompt',
  };
  const revertedStep = {
    ...activeStep,
    createdAtMs: 1767225620000,
    inputTokens: 4000,
    cacheReadTokens: 27500,
    outputTokens: 800,
    contextTokens: 32300,
    isReverted: true,
    isLatestTurn: false,
    turnPrompt: 'reverted prompt',
  };
  const packedRev = splitStepForStorage(revertedStep);
  const unpackedRev = buildSlimStepFromAccounting(packedRev.accountingTuple);
  assert.equal(unpackedRev.isReverted, true);
  assert.equal(packedRev.detailObj?.isReverted, undefined, 'isReverted stored in compact flags bitmask');
  const packedAct = splitStepForStorage(activeStep);
  const unpackedAct = buildSlimStepFromAccounting(packedAct.accountingTuple);
  assert.equal(Boolean(unpackedAct.isReverted), false);

  // 2. Distinct selection keys when reverted & active steps share the same stepIndex
  const kAct = getStepSelectionKey(activeStep, 'conv-undo-ui');
  const kRev = getStepSelectionKey(revertedStep, 'conv-undo-ui');
  assert.notEqual(kAct, kRev);

  // 3. StepTableWidget renders both rows, applies .is-reverted only to reverted row, and isolates turn rails
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const { document: doc } = createMockDom();
  globalThis.document = doc;
  globalThis.window = {
    innerWidth: 960,
    innerHeight: 720,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
  };
  try {
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    const widget = StepTableWidget({ standalone: true });
    host.appendChild(widget.el);
    widget.refs.renderStepTable(
      [activeStep, revertedStep],
      'conv-undo-ui',
      ['step', 'model', 'tokens_combo', 'cost'],
      'zh-CN',
      {
        showStepTurnRail: true,
        allConversationSteps: [activeStep, revertedStep],
      }
    );
    const rows = host.querySelectorAll('tbody tr');
    assert.equal(rows.length, 2, 'Both active and reverted rows with same stepIndex render without key collision');
    assert.equal(rows[0].classList.contains('is-reverted'), false);
    assert.equal(rows[1].classList.contains('is-reverted'), true);
    const rail0 = rows[0].querySelector('.turn-rail');
    const rail1 = rows[1].querySelector('.turn-rail');
    assert.equal(rail0.classList.contains('has-down'), false, 'Active turn rail does not weld into reverted row below');
    assert.equal(rail1.classList.contains('has-up'), false, 'Reverted turn rail does not weld into active row above');
    widget.destroy();
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  }

  // 4. Compiled CSS bundle includes classic & modern-ui gray/dimmed styles for .is-reverted
  const { readFileSync: readBundleFileSync } = await import('node:fs');
  const stylesCss = readBundleFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(stylesCss, /\.data-table\s+tbody\s+tr\.is-reverted\s*\{/);
  assert.match(stylesCss, /\.data-table\s+tbody\s+tr\.is-reverted\s+td\s*\{[^}]*opacity:\s*0\.62/);
  assert.match(stylesCss, /\[data-modern-ui="true"\]\s+\.data-table\s+tbody\s+tr\.is-reverted/);
});

test('Running sessions 3-way mode, update_steps forwarding/UI, bracketless progress pills, and 7-locale i18n', async () => {
  const {
    TOPBAR_MULTI_SESSION_MODES,
    normalizeTopbarMultiSessionMode,
    isTopbarMultiSessionVisible,
    SUPPORTED_LOCALES,
  } = await import('../shared/settings-normalization.mjs');
  const { normalizeFullSettings } = await import('../backend/settings-schema.mjs');
  const { formatCliStatusLineCapsule } = await import('../backend/cli-statusline-config.mjs');
  const { I18N_DICTIONARIES, setI18nLanguage } = await import('../src/i18n/index.js');
  const { LiveActivityWidget } = await import('../src/components/widgets/LiveActivityWidget.js');
  const { createMockDom } = await import('./mock-dom.mjs');

  // 1. Shared normalization & legacy showTopbarMultiSession compatibility
  assert.deepEqual(TOPBAR_MULTI_SESSION_MODES, ['show', 'running_only', 'hide']);
  assert.equal(normalizeTopbarMultiSessionMode(undefined, undefined), 'show');
  assert.equal(normalizeTopbarMultiSessionMode(undefined, false), 'hide');
  assert.equal(normalizeTopbarMultiSessionMode(undefined, true), 'show');
  assert.equal(normalizeTopbarMultiSessionMode('running_only', false), 'running_only');
  assert.equal(isTopbarMultiSessionVisible('show', 0), true);
  assert.equal(isTopbarMultiSessionVisible('running_only', 0), false);
  assert.equal(isTopbarMultiSessionVisible('running_only', 2), true);
  assert.equal(isTopbarMultiSessionVisible('hide', 5), false);

  // 2. Settings schema normalizer reconciles explicit mode and legacy boolean configs
  const sRunOnly = normalizeFullSettings({ topbarMultiSessionMode: 'running_only', showTopbarMultiSession: false });
  assert.equal(sRunOnly.topbarMultiSessionMode, 'running_only');
  assert.equal(sRunOnly.showTopbarMultiSession, true);
  const sLegacyHide = normalizeFullSettings({ showTopbarMultiSession: false });
  assert.equal(sLegacyHide.topbarMultiSessionMode, 'hide');
  assert.equal(sLegacyHide.showTopbarMultiSession, false);
  const sLegacyShow = normalizeFullSettings({ showTopbarMultiSession: true });
  assert.equal(sLegacyShow.topbarMultiSessionMode, 'show');
  assert.equal(sLegacyShow.showTopbarMultiSession, true);

  // 3. CLI statusLine omits multiCore when running_only & runningCount === 0, shows when > 0
  const cliIdle = formatCliStatusLineCapsule(
    { hasTelemetry: true, runningCount: 0, usedPct: 42 },
    { language: 'zh-CN', multiSessionMode: 'running_only', slots: ['context'], color: false }
  );
  assert.equal(cliIdle.includes('运行中'), false, 'running_only hides 0 running badge in CLI statusLine');
  assert.match(cliIdle, /42%/);

  const cliBusy = formatCliStatusLineCapsule(
    { hasTelemetry: true, runningCount: 2, usedPct: 42 },
    { language: 'zh-CN', multiSessionMode: 'running_only', slots: ['context'], color: false }
  );
  assert.match(cliBusy, /2 运行中/, 'running_only shows running badge when runningCount > 0');

  // 4. Backend telemetry-builder forwards taskSteps into activeConversation & runningConversations and invalidates cache on update
  const stepUpdate1 = {
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: { createdAt: '2026-01-01T00:00:05Z' },
    plannerResponse: {
      toolCalls: [
        {
          name: 'update_steps',
          argumentsJson: JSON.stringify({
            steps: [
              { title: 'Audit anchors', status: 'done' },
              { title: 'Render steps bar', status: 'in_progress' },
            ],
          }),
        },
      ],
    },
  };
  const stepUpdate2 = {
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: { createdAt: '2026-01-01T00:00:12Z' },
    plannerResponse: {
      toolCalls: [
        {
          name: 'update_steps',
          argumentsJson: JSON.stringify({
            steps: [
              { title: 'Audit anchors', status: 'done' },
              { title: 'Render steps bar', status: 'done' },
            ],
          }),
        },
      ],
    },
  };
  const stepsRef = [stepUpdate1];
  const h = backendHarness({
    summaries: {
      'conv-steps': {
        summary: 'Steps Pipeline Session',
        stepCount: 2,
        lastModifiedTime: new Date().toISOString(),
        status: 'CASCADE_RUN_STATUS_RUNNING',
      },
    },
    trajectories: {
      'conv-steps': { trajectory: { steps: stepsRef } },
    },
  });
  const payload1 = await h.buildTelemetryPayloadInternal('conv-steps', false, {});
  assert.equal(payload1.activeConversation.liveActivity?.taskSteps?.done, 1);
  assert.equal(payload1.activeConversation.liveActivity?.taskSteps?.total, 2);
  assert.equal(payload1.runningConversations[0]?.mainActivity?.taskSteps?.currentTitle, 'Render steps bar');

  stepsRef.push(stepUpdate2);
  const payload2 = await h.buildTelemetryPayloadInternal('conv-steps', false, {});
  assert.equal(payload2.activeConversation.liveActivity?.taskSteps?.done, 2);
  assert.equal(payload2.runningConversations[0]?.mainActivity?.taskSteps?.done, 2);

  // 5. All 7 locales have updated multiToggle label and new runningOnly/update_steps/update_focus/steps keys
  assert.equal(I18N_DICTIONARIES['zh-CN']['settings.str.multiToggle'], '实时运行会话');
  assert.equal(I18N_DICTIONARIES['zh-TW']['settings.str.multiToggle'], '即時執行工作階段');
  assert.equal(I18N_DICTIONARIES['en-US']['settings.str.multiToggle'], 'Running sessions');
  for (const loc of SUPPORTED_LOCALES) {
    const d = I18N_DICTIONARIES[loc];
    for (const k of [
      'settings.str.multiToggle',
      'settings.str.runningOnly',
      'live.act.update_steps',
      'live.act.update_focus',
      'live.stepsProgress',
      'live.stepsExpandTitle',
      'live.stepsCollapseTitle',
      'live.stepsAllDone',
    ]) {
      assert.equal(typeof d[k] === 'string' && d[k].length > 0, true, `${loc}.${k} missing`);
    }
  }

  // 6. LiveActivityWidget renders bracketless progress (5/5, not [5/5]) and expandable .live-steps-box
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const { document: doc } = createMockDom();
  globalThis.document = doc;
  globalThis.window = {
    innerWidth: 960,
    innerHeight: 720,
    getComputedStyle: () => ({}),
    addEventListener() {},
    removeEventListener() {},
  };
  try {
    setI18nLanguage('zh-CN');
    const widget = LiveActivityWidget({
      interactive: true,
      defaultExpandRunningSubs: true,
      showSessionExtras: true,
    });
    doc.body.appendChild(widget.el);
    widget.refs.update({
      items: [
        {
          cascadeId: 'conv-ui-steps',
          title: 'Long Running Refactor Session',
          isRunning: true,
          isMainRunning: true,
          latestTokPerSec: 88.4,
          contextUsedPct: 41,
          subagentCount: 1,
          runningSubagentCount: 1,
          mainActivity: {
            phase: 'tool',
            actionKey: 'edit_file',
            label: '修改文件',
            detail: 'LiveActivityWidget.js',
            stepProgress: '5/5',
            startedAtMs: Date.now() - 5000,
            signature: 'edit:5/5',
            taskSteps: {
              total: 3,
              done: 1,
              inProgress: 1,
              failed: 0,
              skipped: 0,
              currentTitle: 'Fix progress pill alignment',
              items: [
                { title: 'Rename running sessions toggle', status: 'done' },
                { title: 'Fix progress pill alignment', status: 'in_progress' },
                { title: 'Verify build and tests', status: 'pending' },
              ],
            },
          },
          subagents: [
            {
              cascadeId: 'conv-ui-steps:sub1',
              index: 1,
              role: 'UI Verifier',
              isRunning: true,
              stepCount: 4,
              liveActivity: {
                phase: 'tool',
                actionKey: 'read_file',
                label: '读取文件',
                detail: 'overlay.css',
                stepProgress: '2/3',
                startedAtMs: Date.now() - 2000,
                signature: 'sub:2/3',
              },
            },
          ],
        },
      ],
    });

    const card = widget.el.querySelector('.live-task-card');
    assert.ok(card);
    // Bracketless progress on both main pill and subagent summary
    assert.equal(card.querySelector('.live-activity-progress').textContent, '5/5');
    assert.equal(card.querySelector('.live-activity-progress').textContent.includes('['), false);
    const subSummaryText = card.querySelector('.live-sub-summary').textContent;
    assert.match(subSummaryText, /读取文件 2\/3 · overlay\.css/);
    assert.equal(subSummaryText.includes('['), false);

    // Compact header keeps metrics + subagent toggle in secondary .live-task-meta-row
    assert.equal(card.querySelector('.live-task-header-right').querySelector('.wm-task-metrics'), null);
    assert.equal(card.querySelector('.live-task-header-right').querySelector('.live-sub-toggle'), null);
    assert.equal(card.querySelector('.live-task-meta-row .wm-task-metrics').textContent, '88.4 t/s · 41%');
    assert.ok(card.querySelector('.live-task-meta-row .live-sub-toggle'));

    // Expandable .live-steps-box
    const stepsBox = card.querySelector('.live-steps-box');
    assert.equal(stepsBox.hasAttribute('hidden'), false);
    assert.equal(stepsBox.querySelector('.live-steps-count').textContent, '步骤 1/3');
    assert.equal(stepsBox.querySelector('.live-steps-current').textContent, 'Fix progress pill alignment');
    assert.equal(stepsBox.querySelector('.live-steps-list').hasAttribute('hidden'), true, 'Steps list collapsed by default');

    stepsBox.querySelector('.live-steps-summary').onclick({ stopPropagation() {} });
    assert.equal(stepsBox.querySelector('.live-steps-list').hasAttribute('hidden'), false, 'Clicking steps summary expands checklist');
    const stepRows = stepsBox.querySelectorAll('.live-step-item');
    assert.equal(stepRows.length, 3);
    assert.equal(stepRows[0].classList.contains('is-done'), true);
    assert.equal(stepRows[1].classList.contains('is-in-progress'), true);
    assert.equal(stepRows[2].classList.contains('is-pending'), true);

    widget.destroy();
  } finally {
    setI18nLanguage('zh-CN');
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  }
});
