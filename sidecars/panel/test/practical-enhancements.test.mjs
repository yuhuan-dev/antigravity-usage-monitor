import test from 'node:test';
import assert from 'node:assert/strict';

import { createMockDom } from './mock-dom.mjs';
import { CustomSelect, filterSelectOptionsByQuery } from '../src/components/ui/CustomSelect.js';
import { App } from '../src/App.js';
import { sortStepsByColumn } from '../src/registries/stepColumnRegistry.js';
import {
  buildExportableSettingsJson,
  parseImportedSettingsJson,
} from '../src/core/settingsBackup.js';
import { StepsDetailView } from '../src/views/StepsDetailView.js';
import { ConsumptionView } from '../src/views/ConsumptionView.js';
import { SettingsOtherTab } from '../src/views/settings/SettingsOtherTab.js';
import { createTrendAreaChart } from '../src/components/charts/TrendAreaChart.js';
import { backendHarness } from './backend-harness.mjs';
import { i18nStore, setI18nLanguage } from '../src/i18n/index.js';
import { telemetryStore } from '../src/store/telemetryStore.js';
import { uiStore } from '../src/store/uiStore.js';

test('Feature 1: CustomSelect searchable mode filters by multi-term query, respects threshold, and handles keyboard flow', (t) => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevLocale = i18nStore.getState().locale;

  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 960,
    innerHeight: 720,
    addEventListener() {},
    removeEventListener() {},
  };
  setI18nLanguage('zh-CN');

  let picked = null;
  let comp = null;
  t.after(() => {
    comp?.destroy?.();
    setI18nLanguage(prevLocale);
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  // Pure multi-term matcher
  const opts = [
    { value: '', label: '最新 (主对话)', meta: '12步' },
    { value: 'cid-ssh-1', label: 'SSH 远程部署排查', meta: '主4 · 2蜂 (共18步)' },
    { value: 'cid-ui-2', label: 'Modern UI 光滑动画', meta: '9步' },
    { value: 'cid-bug-3', label: '5h 配额周期对齐', meta: '42步' },
    { value: 'cid-sql-4', label: 'SQLite WAL 性能优化', meta: '31步' },
    { value: 'cid-perf-5', label: 'Carbon 模型测速对比', meta: '19步' },
  ];
  assert.equal(filterSelectOptionsByQuery(opts, 'ssh 蜂').length, 1);
  assert.equal(filterSelectOptionsByQuery(opts, 'cid-bug-3')[0].value, 'cid-bug-3');
  assert.equal(filterSelectOptionsByQuery(opts, 'no-such-session').length, 0);

  comp = CustomSelect({
    modelValue: '',
    searchable: true,
    searchThreshold: 6,
    searchPlaceholder: '搜索会话…',
    options: opts,
    onUpdateModelValue: (val) => {
      picked = val;
    },
  });
  document.body.appendChild(comp.el);

  // Below threshold hides search bar
  comp.setProps({ options: opts.slice(0, 3) });
  comp.open();
  assert.equal(comp.el.querySelector('.select-search-wrap').hasAttribute('hidden'), true);
  comp.close();

  // At/above threshold shows search bar and filters live
  comp.setProps({ options: opts });
  let focusedSearch = false;
  comp.refs.searchInput.focus = () => {
    focusedSearch = true;
  };
  comp.openAndFocusSearch();
  assert.equal(comp.el.classList.contains('is-open'), true);
  assert.equal(comp.el.querySelector('.select-search-wrap').hasAttribute('hidden'), false);
  assert.equal(comp.el.querySelectorAll('.select-option').length, 6);

  // Type query -> filters to 1 match
  comp.refs.searchInput.value = 'sql wal';
  comp.refs.searchInput.dispatchEvent({
    type: 'input',
    target: comp.refs.searchInput,
  });
  let visibleRows = comp.el.querySelectorAll('.select-option');
  assert.equal(visibleRows.length, 1);
  assert.equal(visibleRows[0].getAttribute('data-value'), 'cid-sql-4');
  assert.equal(comp.el.querySelector('.select-empty').hasAttribute('hidden'), true);

  // Unmatched query -> shows empty hint
  comp.refs.searchInput.value = 'does-not-exist-xyz';
  comp.refs.searchInput.dispatchEvent({
    type: 'input',
    target: comp.refs.searchInput,
  });
  assert.equal(comp.el.querySelectorAll('.select-option').length, 0);
  assert.equal(comp.el.querySelector('.select-empty').hasAttribute('hidden'), false);

  // First Escape clears query instead of closing dropdown
  comp.refs.searchInput.dispatchEvent({
    type: 'keydown',
    key: 'Escape',
    target: comp.refs.searchInput,
    preventDefault() {},
  });
  assert.equal(comp.el.classList.contains('is-open'), true);
  assert.equal(comp.refs.searchInput.value, '');
  assert.equal(comp.el.querySelectorAll('.select-option').length, 6);

  // Filter and press Enter to select
  comp.refs.searchInput.value = 'carbon';
  comp.refs.searchInput.dispatchEvent({
    type: 'input',
    target: comp.refs.searchInput,
  });
  comp.refs.searchInput.dispatchEvent({
    type: 'keydown',
    key: 'Enter',
    target: comp.refs.searchInput,
    preventDefault() {},
  });
  assert.equal(picked, 'cid-perf-5');
  assert.equal(comp.el.classList.contains('is-open'), false);
  return Promise.resolve().then(() => {
    assert.equal(focusedSearch, true);
  });
});

test('Feature 1: App panel keyboard shortcuts switch tabs (1-4), trigger refresh (r), open search (/), and ignore editable inputs', (t) => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevUi = { ...uiStore.getState() };
  const prevTel = { ...telemetryStore.getState() };

  const { document } = createMockDom();
  globalThis.document = document;
  let fetchCalled = 0;
  globalThis.window = {
    location: { pathname: '/' },
    innerWidth: 960,
    innerHeight: 720,
    sidecar: {
      fetch: async () => {
        fetchCalled += 1;
        return { ok: true, status: 200, json: async () => ({}) };
      },
    },
    addEventListener() {},
    removeEventListener() {},
  };

  uiStore.setState({ activeView: 'overview', monitorVisible: true }, { sync: true });
  let app = null;
  t.after(() => {
    app?.destroy?.();
    uiStore.setState(prevUi, { sync: true });
    telemetryStore.setState(prevTel, { sync: true });
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  app = App();
  document.body.appendChild(app.el);

  // Keys 2, 3, 4, 1 switch activeView
  app.el.dispatchEvent({ type: 'keydown', key: '2', target: app.el, preventDefault() {} });
  assert.equal(uiStore.getState().activeView, 'consumption');
  app.el.dispatchEvent({ type: 'keydown', key: '3', target: app.el, preventDefault() {} });
  assert.equal(uiStore.getState().activeView, 'steps');
  app.el.dispatchEvent({ type: 'keydown', key: '4', target: app.el, preventDefault() {} });
  assert.equal(uiStore.getState().activeView, 'settings');
  app.el.dispatchEvent({ type: 'keydown', key: '1', target: app.el, preventDefault() {} });
  assert.equal(uiStore.getState().activeView, 'overview');

  // Modifier keys and INPUT targets are ignored
  app.el.dispatchEvent({
    type: 'keydown',
    key: '3',
    ctrlKey: true,
    target: app.el,
    preventDefault() {},
  });
  assert.equal(uiStore.getState().activeView, 'overview');

  const fakeInput = document.createElement('input');
  app.el.dispatchEvent({ type: 'keydown', key: '3', target: fakeInput, preventDefault() {} });
  assert.equal(uiStore.getState().activeView, 'overview');

  // '/' opens top session picker
  app.el.dispatchEvent({ type: 'keydown', key: '/', target: app.el, preventDefault() {} });
  assert.equal(app.refs.sessionHeader.refs.convSelect.el.classList.contains('is-open'), true);

  // 'r' triggers telemetry refresh
  app.el.dispatchEvent({ type: 'keydown', key: 'r', target: app.el, preventDefault() {} });
  assert.ok(fetchCalled >= 1);
});

test('Feature 3: Step table supports multi-column sorting (with nulls last), anomaly/compaction quick chips, and live subtotal bar', (t) => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevUi = { ...uiStore.getState() };
  const prevTel = { ...telemetryStore.getState() };
  const prevLocale = i18nStore.getState().locale;

  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 960,
    innerHeight: 720,
    addEventListener() {},
    removeEventListener() {},
  };
  setI18nLanguage('zh-CN');

  let view = null;
  t.after(() => {
    view?.destroy?.();
    uiStore.setState(prevUi, { sync: true });
    telemetryStore.setState(prevTel, { sync: true });
    setI18nLanguage(prevLocale);
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  const sampleSteps = [
    {
      stepIndex: 3,
      createdAtMs: 3000,
      modelShort: '4-neon',
      modelLabel: 'Gemini 4 Neon',
      tokPerSec: 30,
      ttftSec: 4.5,
      inputTokens: 10_000,
      cacheReadTokens: 90_000,
      outputTokens: 600,
      thinkingTokens: 400,
      responseTokens: 200,
      contextTokens: 100_600,
      cacheHitPct: 90,
      costUsd: 0.45,
      anomaly: { count: 1, severity: 'warn', primaryKind: 'timeout', kinds: { timeout: 1 } },
      anomalySig: 'timeout:1',
    },
    {
      stepIndex: 2,
      createdAtMs: 2000,
      modelShort: '4-carbon',
      modelLabel: 'Gemini 4 Carbon',
      tokPerSec: null,
      ttftSec: null,
      isCompactionStep: true,
      inputTokens: 50_000,
      cacheReadTokens: 0,
      outputTokens: 1_000,
      thinkingTokens: 0,
      responseTokens: 1_000,
      contextTokens: 51_000,
      cacheHitPct: 0,
      costUsd: 0.12,
    },
    {
      stepIndex: 1,
      createdAtMs: 1000,
      modelShort: '4-carbon',
      modelLabel: 'Gemini 4 Carbon',
      tokPerSec: 60,
      ttftSec: 1.5,
      inputTokens: 5_000,
      cacheReadTokens: 95_000,
      outputTokens: 1_200,
      thinkingTokens: 500,
      responseTokens: 700,
      contextTokens: 101_200,
      cacheHitPct: 95,
      costUsd: 0.08,
    },
  ];

  // Pure sort keeps nulls last in both desc and asc
  const byTpsDesc = sortStepsByColumn(sampleSteps, 'tps', 'desc');
  assert.deepEqual(byTpsDesc.map((s) => s.stepIndex), [1, 3, 2]);
  const byTpsAsc = sortStepsByColumn(sampleSteps, 'tps', 'asc');
  assert.deepEqual(byTpsAsc.map((s) => s.stepIndex), [3, 1, 2]);

  // Full StepsDetailView integration: click header sort cycles desc -> asc -> default (no bottom summary bar)
  uiStore.setState({ activeView: 'steps', stepsSubTab: 'steps', monitorVisible: true }, { sync: true });
  telemetryStore.setState(
    {
      telemetry: {
        settings: {
          stepTableColumns: ['step', 'model', 'tps', 'cost'],
          showStepTurnRail: true,
        },
        activeConversation: {
          cascadeId: 'cid-sort-1',
          stepCount: 3,
          recentSteps: sampleSteps,
          modelBreakdown: [],
        },
      },
    },
    { sync: true }
  );

  view = StepsDetailView();
  document.body.appendChild(view.el);

  assert.equal(view.el.querySelector('.steps-summary-bar'), null);

  // Click '费用' header (index 3) -> desc -> asc -> default
  const ths = view.el.querySelectorAll('thead th');
  assert.equal(ths.length, 4);
  ths[3].onclick();
  assert.equal(ths[3].getAttribute('aria-sort'), 'descending');
  let rowStepTexts = view.el.querySelectorAll('tbody tr').map((tr) => tr.children[0].textContent);
  assert.deepEqual(rowStepTexts, ['#3', '#2', '#1']);

  ths[3].onclick();
  assert.equal(ths[3].getAttribute('aria-sort'), 'ascending');
  rowStepTexts = view.el.querySelectorAll('tbody tr').map((tr) => tr.children[0].textContent);
  assert.deepEqual(rowStepTexts, ['#1', '#2', '#3']);

  ths[3].onclick();
  assert.equal(ths[3].getAttribute('aria-sort'), 'none');
  rowStepTexts = view.el.querySelectorAll('tbody tr').map((tr) => tr.children[0].textContent);
  assert.deepEqual(rowStepTexts, ['#3', '#2', '#1']);
});

test('Feature 5: backend aggregates top costly sessions consistently across full and fast paths', async () => {
  const nowMs = Date.now();
  const h = (hrsAgo) => nowMs - hrsAgo * 3600 * 1000;

  const harn = backendHarness({
    cache: {
      'conv-high-cost': {
        cascadeId: 'conv-high-cost',
        title: 'Expensive Refactor',
        appSource: 'standalone',
        steps: [
          {
            stepIndex: 1,
            modelKey: 'MODEL_PLACEHOLDER_M18',
            inputTokens: 200_000,
            cacheReadTokens: 800_000,
            outputTokens: 40_000,
            thinkingTokens: 15_000,
            responseTokens: 25_000,
            createdAtMs: h(3),
          },
          {
            stepIndex: 2,
            modelKey: 'MODEL_PLACEHOLDER_M18',
            inputTokens: 100_000,
            cacheReadTokens: 400_000,
            outputTokens: 20_000,
            thinkingTokens: 8_000,
            responseTokens: 12_000,
            createdAtMs: h(30),
          },
        ],
      },
      'conv-low-cost': {
        cascadeId: 'conv-low-cost',
        title: 'Quick Bugfix',
        appSource: 'ide',
        steps: [
          {
            stepIndex: 1,
            modelKey: 'MODEL_PLACEHOLDER_M18',
            inputTokens: 50_000,
            cacheReadTokens: 200_000,
            outputTokens: 10_000,
            thinkingTokens: 3_000,
            responseTokens: 7_000,
            createdAtMs: h(2),
          },
        ],
      },
    },
    summaries: {
      'conv-high-cost': { summary: 'Expensive Refactor', stepCount: 2, lastModifiedTime: new Date(h(3)).toISOString() },
      'conv-low-cost': { summary: 'Quick Bugfix', stepCount: 1, lastModifiedTime: new Date(h(2)).toISOString() },
    },
  });

  const full24h = await harn.buildTelemetryPayloadInternal('conv-high-cost', false, { range: '24h' });
  const topList = full24h.consumption.topConversations;
  assert.equal(Array.isArray(topList), true);
  assert.equal(topList.length, 2);
  assert.equal(topList[0].cascadeId, 'conv-high-cost');
  assert.equal(topList[0].title, 'Expensive Refactor');
  assert.equal(topList[0].totalTokens, 1_040_000);
  assert.equal(topList[0].cacheHitPct, 80);
  assert.equal(Array.isArray(topList[0].models), true, 'Each top conversation carries per-model breakdown');
  assert.equal(topList[0].models.length, 1);
  assert.equal(topList[0].models[0].totalTokens, 1_040_000);
  assert.equal(topList[1].cascadeId, 'conv-low-cost');
  assert.equal(topList[1].totalTokens, 260_000);
  assert.equal(full24h.consumption.comparison, undefined);

  // Fast consumption slice path matches full path identically
  const fast24h = JSON.parse(
    (await harn.executeTelemetryAction({
      conversationId: 'conv-high-cost',
      range: '24h',
      scope: 'consumption',
    })).body
  );
  assert.equal(fast24h.scope, 'consumption');
  assert.equal(fast24h.consumption.topConversations.length, 2);
  assert.equal(fast24h.consumption.topConversations[0].cascadeId, 'conv-high-cost');
});

test('Feature 5: TrendAreaChart drill-down click and unified Models/Sessions segmented ranking card', async (t) => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevFetch = globalThis.fetch;
  const prevLocale = i18nStore.getState().locale;
  const prevUi = uiStore.getState();
  const prevTel = telemetryStore.getState();

  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    sidecar: {
      fetch: (url, init) => globalThis.fetch(url, init),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (cb) => {
      cb();
      return 1;
    },
    cancelAnimationFrame: () => {},
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

  let view = null;
  let chart = null;
  t.after(() => {
    view?.destroy?.();
    chart?.destroy?.();
    setI18nLanguage(prevLocale);
    uiStore.setState(prevUi, { sync: true });
    telemetryStore.setState(prevTel, { sync: true });
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.fetch = prevFetch;
  });

  setI18nLanguage('zh-CN');

  // 1. TrendAreaChart click drill-down on line curve
  const selectedSlots = [];
  chart = createTrendAreaChart({ onSelectSlot: (slot) => selectedSlots.push(slot) });
  const day1Start = new Date(2026, 9, 10, 0, 0, 0, 0).getTime();
  const day1End = new Date(2026, 9, 10, 23, 59, 59, 999).getTime();
  const day2Start = new Date(2026, 9, 11, 0, 0, 0, 0).getTime();
  const day2End = new Date(2026, 9, 11, 23, 59, 59, 999).getTime();
  chart.update([
    { label: '10/10', fullLabel: '2026-10-10', startMs: day1Start, endMs: day1End, tokens: 100_000, calls: 2, costUsd: 0.2 },
    { label: '10/11', fullLabel: '2026-10-11', startMs: day2Start, endMs: day2End, tokens: 300_000, calls: 4, costUsd: 0.6 },
  ]);
  const svgEl = chart.el.querySelector('svg');
  svgEl.getBoundingClientRect = () => ({ left: 0, width: 400, top: 0, height: 184 });
  const stageEl = chart.el.querySelector('.trend-plot-stage');
  stageEl.dispatchEvent({ type: 'click', clientX: 390 });
  assert.equal(selectedSlots.length, 1);
  assert.equal(selectedSlots[0].label, '10/11');

  // 2. ConsumptionView renders delta pills, top sessions sorting & click-to-jump, and month bar drill-down
  uiStore.setState({ activeView: 'consumption', monitorVisible: true }, { sync: true });
  telemetryStore.setState(
    {
      selectedTimeRange: '7d',
      customStartMs: 0,
      customEndMs: 0,
      telemetry: {
        settings: {},
        consumption: {
          revision: 7,
          selectedRange: { key: '7d', label: '近7天', startMs: day1Start, endMs: day2End },
          account: {
            totalTokens: 1_500_000,
            inputTokens: 200_000,
            cacheReadTokens: 1_200_000,
            outputTokens: 100_000,
            responseTokens: 60_000,
            thinkingTokens: 40_000,
            costUsd: 2.5,
            savedCostUsd: 1.8,
            cacheHitPct: 85.7,
            calls: 15,
          },
          comparison: {
            prevTotalTokens: 1_000_000,
            prevCostUsd: 5.0,
            prevCalls: 10,
            tokensDeltaPct: 50,
            costDeltaPct: -50,
          },
          topConversations: [
            {
              cascadeId: 'cid-costly',
              title: 'Costly Session',
              sourceName: 'Antigravity',
              calls: 6,
              inputTokens: 150_000,
              cacheReadTokens: 300_000,
              responseTokens: 40_000,
              thinkingTokens: 10_000,
              totalTokens: 500_000,
              costUsd: 1.8,
              cacheHitPct: 66.7,
              canJump: true,
              models: [
                { label: '4-neon', shortName: '4-neon', calls: 4, totalTokens: 400_000, costUsd: 1.5 },
                { label: '4-carbon', shortName: '4-carbon', calls: 2, totalTokens: 100_000, costUsd: 0.3 },
              ],
            },
            {
              cascadeId: 'cid-heavy-tok',
              title: 'Heavy Cache Session',
              sourceName: 'IDE',
              calls: 9,
              inputTokens: 50_000,
              cacheReadTokens: 900_000,
              responseTokens: 20_000,
              thinkingTokens: 30_000,
              totalTokens: 1_000_000,
              costUsd: 0.7,
              cacheHitPct: 94.7,
              canJump: true,
              models: [
                { label: '4-carbon', shortName: '4-carbon', calls: 9, totalTokens: 1_000_000, costUsd: 0.7 },
              ],
            },
          ],
          trendSeries: [],
          sourcesBreakdown: [],
          monthlyYear: 2026,
          monthlySeries: Array.from({ length: 12 }, (_, idx) =>
            idx === 4
              ? { month: 5, totalTokens: 800_000, costUsd: 1.4, calls: 12, models: [] }
              : { month: idx + 1, totalTokens: 0, costUsd: 0, calls: 0, models: [] }
          ),
        },
        modelBreakdown: [],
      },
    },
    { sync: true }
  );

  view = ConsumptionView();
  document.body.appendChild(view.el);

  // Period delta pills removed
  assert.equal(view.el.querySelectorAll('.cons-delta-pill').length, 0);

  // Unified ranking panel starts on Models tab and hides Sessions list
  const rankingPanel = view.el.querySelector('.cons-ranking-panel');
  const rankingTabBtns = rankingPanel.querySelector('.cons-ranking-head > .segmented').querySelectorAll('.seg-btn');
  assert.equal(rankingTabBtns.length, 2);
  assert.match(rankingTabBtns[0].textContent, /模型排行/);
  assert.match(rankingTabBtns[1].textContent, /会话排行 \(2\)/);

  const listContainers = rankingPanel.querySelectorAll('.cons-item-list');
  assert.equal(listContainers[0].hasAttribute('hidden'), false, 'Models list visible by default');
  assert.equal(listContainers[1].hasAttribute('hidden'), true, 'Sessions list hidden by default');

  // Switch ranking tab to Sessions -> models list hides, sessions list reveals
  rankingTabBtns[1].dispatchEvent({ type: 'click', stopPropagation: () => {} });
  assert.equal(listContainers[0].hasAttribute('hidden'), true);
  assert.equal(listContainers[1].hasAttribute('hidden'), false);

  // Top sessions default sorted by cost: Costly Session first with cost-share % and multi-model bar
  let convRows = view.el.querySelectorAll('.cons-top-conv-row');
  assert.equal(convRows.length, 2);
  assert.equal(convRows[0].querySelector('.cons-row-title-text').textContent, 'Costly Session');
  assert.equal(convRows[0].querySelector('.cons-share-pill').textContent, '72.0%');
  assert.equal(convRows[0].querySelectorAll('.cons-model-seg').length, 2, 'Session bar splits by model colors');
  assert.equal(convRows[0].querySelectorAll('.cons-source-top-item').length, 2, 'Session footer shows top models');
  assert.equal(convRows[0].querySelector('.cons-source-top-name').textContent, '4-neon');

  // Switch sessions sort to Tokens: Heavy Cache Session moves to first and share switches to token % (66.7%)
  const sortSwitches = rankingPanel.querySelectorAll('.cons-ranking-sort-wrap > .segmented');
  assert.equal(sortSwitches[0].hasAttribute('hidden'), true, 'Models sort switch hidden on Sessions tab');
  assert.equal(sortSwitches[1].hasAttribute('hidden'), false, 'Sessions sort switch visible on Sessions tab');
  const topConvSortBtns = sortSwitches[1].querySelectorAll('.seg-btn');
  topConvSortBtns[1].dispatchEvent({ type: 'click', stopPropagation: () => {} });
  convRows = view.el.querySelectorAll('.cons-top-conv-row');
  assert.equal(convRows[0].querySelector('.cons-row-title-text').textContent, 'Heavy Cache Session');
  assert.equal(convRows[0].querySelector('.cons-share-pill').textContent, '66.7%');

  // Click a monthly bar (May, index 4) to drill down to May 2026 custom range
  const monthCols = view.el.querySelectorAll('.month-col');
  monthCols[4].dispatchEvent({ type: 'click' });
  assert.equal(telemetryStore.getState().selectedTimeRange, 'custom');
  assert.equal(new Date(telemetryStore.getState().customStartMs).getMonth(), 4);
  assert.equal(new Date(telemetryStore.getState().customEndMs).getMonth(), 4);

  // Click top session row to jump to steps view with that conversation selected
  convRows[0].dispatchEvent({ type: 'click' });
  assert.equal(uiStore.getState().activeView, 'steps');
  assert.equal(telemetryStore.getState().selectedConversationId, 'cid-heavy-tok');
});

test('Feature 6: model ranking multi-metric sort with efficiency footer & validated settings JSON backup/restore', async (t) => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevFetch = globalThis.fetch;
  const prevLocale = i18nStore.getState().locale;
  const prevUi = uiStore.getState();
  const prevTel = telemetryStore.getState();

  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    sidecar: {
      fetch: (url, init) => globalThis.fetch(url, init),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (cb) => {
      cb();
      return 1;
    },
    cancelAnimationFrame: () => {},
  };

  let savedPatches = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/api/settings') && opts?.method === 'POST') {
      const body = JSON.parse(opts.body);
      savedPatches.push(body);
      return { ok: true, json: async () => ({ ok: true, settings: body }) };
    }
    return { ok: true, json: async () => ({}) };
  };

  let consView = null;
  let otherTab = null;
  t.after(() => {
    consView?.destroy?.();
    otherTab?.destroy?.();
    setI18nLanguage(prevLocale);
    uiStore.setState(prevUi, { sync: true });
    telemetryStore.setState(prevTel, { sync: true });
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.fetch = prevFetch;
  });

  setI18nLanguage('zh-CN');

  // 1. Model ranking sort & efficiency footer (TPS / TTFT / Cache / Anomaly / $/1M)
  uiStore.setState({ activeView: 'consumption', monitorVisible: true }, { sync: true });
  telemetryStore.setState(
    {
      selectedTimeRange: '7d',
      telemetry: {
        settings: {},
        consumption: {
          revision: 9,
          selectedRange: { key: '7d', label: '近7天', startMs: 1, endMs: 2 },
          account: { totalTokens: 3_000_000, costUsd: 5.0, calls: 30 },
          trendSeries: [],
          sourcesBreakdown: [],
          monthlyYear: 2026,
          monthlySeries: [],
        },
        modelBreakdown: [
          {
            label: 'model-high-tok',
            shortName: 'model-high-tok',
            calls: 10,
            inputTokens: 100_000,
            cacheReadTokens: 1_800_000,
            outputTokens: 100_000,
            thinkingTokens: 40_000,
            responseTokens: 60_000,
            totalTokens: 2_000_000,
            costUsd: 1.5,
            avgTokPerSec: 32.5,
            avgTtftSec: 2.1,
            cacheHitPct: 94.7,
            anomalyCount: 2,
          },
          {
            label: 'model-fast-costly',
            shortName: 'model-fast-costly',
            calls: 20,
            inputTokens: 300_000,
            cacheReadTokens: 600_000,
            outputTokens: 100_000,
            thinkingTokens: 30_000,
            responseTokens: 70_000,
            totalTokens: 1_000_000,
            costUsd: 3.5,
            avgTokPerSec: 88.4,
            avgTtftSec: 0.8,
            cacheHitPct: 66.7,
            anomalyCount: 0,
          },
        ],
      },
    },
    { sync: true }
  );

  consView = ConsumptionView();
  document.body.appendChild(consView.el);

  // Default sorted by Tokens -> model-high-tok first with Token share (66.7%) & full info
  let rows = consView.el.querySelectorAll('.cons-item-row');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].querySelector('.cons-row-title-text').textContent, 'model-high-tok');
  assert.equal(rows[0].querySelector('.cons-share-pill').textContent, '66.7%');
  const perfFoot = rows[0].querySelector('.cons-model-perf-foot');
  assert.equal(perfFoot.hasAttribute('hidden'), false);
  assert.match(perfFoot.querySelector('.cons-model-perf-main').textContent, /32\.5 tok\/s/);
  assert.match(perfFoot.querySelector('.cons-model-perf-main').textContent, /2\.1s/);
  assert.equal(perfFoot.querySelector('.cons-model-anom-tag'), null);
  assert.match(perfFoot.querySelector('.cons-model-unit-cost').textContent, /\$0\.75\/1M/);
  assert.equal(rows[0].querySelector('.cons-model-focus-foot').hasAttribute('hidden'), true);

  // Switch model ranking sort to Speed -> model-fast-costly first, pct becomes relative speed (100%), focuses on speed
  const modelsHeaderBtns = consView.el
    .querySelector('.cons-ranking-sort-wrap > .segmented')
    .querySelectorAll('.seg-btn');
  assert.equal(modelsHeaderBtns.length, 4);
  modelsHeaderBtns[2].dispatchEvent({ type: 'click', stopPropagation: () => {} });
  rows = consView.el.querySelectorAll('.cons-item-row');
  assert.equal(rows[0].querySelector('.cons-row-title-text').textContent, 'model-fast-costly');
  assert.equal(rows[0].querySelector('.cons-share-pill').textContent, '100%');
  assert.equal(rows[0].querySelector('.cons-row-cost').textContent, '88.4 tok/s');
  assert.equal(rows[0].querySelector('.cons-model-perf-foot').hasAttribute('hidden'), true);
  assert.equal(rows[0].querySelector('.cons-model-focus-foot').hasAttribute('hidden'), false);
  assert.equal(rows[1].querySelector('.cons-share-pill').textContent, '37%');

  // Switch to Cost -> model-fast-costly ($3.50 / $5.00 = 70.0%), focuses on cost
  modelsHeaderBtns[1].dispatchEvent({ type: 'click', stopPropagation: () => {} });
  rows = consView.el.querySelectorAll('.cons-item-row');
  assert.equal(rows[0].querySelector('.cons-row-title-text').textContent, 'model-fast-costly');
  assert.equal(rows[0].querySelector('.cons-share-pill').textContent, '70.0%');
  assert.equal(rows[0].querySelector('.cons-row-cost').textContent, '$3.50');
  assert.equal(rows[0].querySelector('.cons-model-focus-foot').hasAttribute('hidden'), false);

  // Switch to Calls -> model-fast-costly (20 / 30 = 66.7%), focuses on calls
  modelsHeaderBtns[3].dispatchEvent({ type: 'click', stopPropagation: () => {} });
  rows = consView.el.querySelectorAll('.cons-item-row');
  assert.equal(rows[0].querySelector('.cons-row-title-text').textContent, 'model-fast-costly');
  assert.equal(rows[0].querySelector('.cons-share-pill').textContent, '66.7%');
  assert.equal(rows[0].querySelector('.cons-row-cost').textContent, '20 次');

  // 2. Settings JSON Export & Safe Validated Import
  const exportedJson = buildExportableSettingsJson({
    language: 'en-US',
    themeAccent: 'emerald',
    fontScale: 'lg',
    modernUi: true,
    stepTableColumns: ['step', 'model', 'cost'],
    developerModeEnabled: true,
    riskyFeaturesEnabled: true,
    accountSwitchRiskAccepted: true,
    contextWindowRiskAccepted: true,
    modelContextWindows: { 'model:foo': '1000000' },
  });
  const parsedRaw = JSON.parse(exportedJson);
  assert.equal(parsedRaw.schema, 'antigravity-usage-monitor.settings');
  assert.equal(parsedRaw.settings.themeAccent, 'emerald');
  assert.equal(parsedRaw.settings.developerModeEnabled, undefined, 'Developer mode flag must not be exported');
  assert.equal(parsedRaw.settings.riskyFeaturesEnabled, undefined, 'Risky features flag must not be exported');
  assert.equal(parsedRaw.settings.accountSwitchRiskAccepted, undefined, 'Account risk flag must not be exported');
  assert.equal(parsedRaw.settings.contextWindowRiskAccepted, undefined, 'Risk flag must not be exported');
  assert.equal(parsedRaw.settings.modelContextWindows, undefined, 'Context overrides must not be exported');

  // Import strips unknown/dangerous keys and normalizes valid keys
  const imported = parseImportedSettingsJson(
    JSON.stringify({
      schema: 'antigravity-usage-monitor.settings',
      settings: {
        language: 'en-US',
        themeAccent: 'violet',
        fontScale: 'INVALID_SCALE',
        popoverWidth: 99999,
        developerModeEnabled: true,
        riskyFeaturesEnabled: true,
        accountSwitchRiskAccepted: true,
        contextWindowRiskAccepted: true,
        unknownSecret: 'nope',
      },
    })
  );
  assert.equal(imported.ok, true);
  assert.equal(imported.patch.language, 'en-US');
  assert.equal(imported.patch.themeAccent, 'violet');
  assert.equal(imported.patch.fontScale, 'md', 'Invalid scale normalizes safely');
  assert.equal(imported.patch.popoverWidth, 1080, 'Oversized popover width clamps safely');
  assert.equal(imported.patch.developerModeEnabled, undefined);
  assert.equal(imported.patch.riskyFeaturesEnabled, undefined);
  assert.equal(imported.patch.accountSwitchRiskAccepted, undefined);
  assert.equal(imported.patch.contextWindowRiskAccepted, undefined);
  assert.equal(imported.patch.unknownSecret, undefined);

  // Rejects bad JSON and foreign schema
  assert.equal(parseImportedSettingsJson('{bad json').ok, false);
  assert.equal(parseImportedSettingsJson(JSON.stringify({ schema: 'other.app', settings: {} })).ok, false);

  // SettingsOtherTab wires import end-to-end
  otherTab = SettingsOtherTab();
  otherTab.refs.renderSettings({ language: 'zh-CN', themeAccent: 'host' }, []);
  const applied = await otherTab.refs.applyImportedSettingsText(exportedJson);
  assert.equal(applied, true);
  assert.equal(savedPatches.length, 1);
  assert.equal(savedPatches[0].themeAccent, 'emerald');
  assert.equal(i18nStore.getState().locale, 'en-US');
});

test('Feature 7: telemetry exposes all local conversations beyond 30 and recovers missing/hex titles from turn prompts', async () => {
  const baseMs = Date.parse('2026-11-21T03:00:00.000Z');
  const summaries = {};
  const trajectories = {};
  for (let i = 0; i < 36; i++) {
    const hex = String(i + 1).padStart(8, '0');
    const cid = `${hex}-1111-4111-8111-111111111111`;
    const tsIso = new Date(baseMs - i * 60_000).toISOString();
    const isUntitled = i === 34;
    summaries[cid] = {
      summary: isUntitled ? '' : `Session #${i + 1}`,
      status: 'CASCADE_RUN_STATUS_IDLE',
      stepCount: 2,
      createdTime: tsIso,
      lastModifiedTime: tsIso,
    };
    trajectories[cid] = {
      trajectory: {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_USER_INPUT',
            status: 'CORTEX_STEP_STATUS_DONE',
            userInput: {
              userResponse: isUntitled ? '排查热力图悬浮提示抖动问题' : `Prompt #${i + 1}`,
            },
            metadata: { createdAt: tsIso },
          },
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_DONE',
            metadata: {
              createdAt: tsIso,
              completedAt: new Date(baseMs - i * 60_000 + 2000).toISOString(),
              sourceTrajectoryStepInfo: { stepIndex: 1 },
              modelUsage: {
                model: 'MODEL_PLACEHOLDER_M429',
                apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                inputTokens: '1000',
                cacheReadTokens: '2000',
                outputTokens: '500',
              },
            },
          },
        ],
      },
    };
  }

  const harness = backendHarness({
    clock: () => baseMs + 5_000,
    summaries,
    trajectories,
  });

  const payload = await harness.buildTelemetryPayloadInternal();
  assert.equal(payload.conversations.length, 36, 'All 36 local conversations should be exposed without 30-item truncation');
  assert.equal(payload.account.totalConversations, 36);
  assert.ok(payload.conversations[0].sessionCostUsd !== undefined, 'Recent conversations keep quick stats');
  assert.equal(payload.conversations[35].sessionCostUsd, undefined, 'Older historical conversations omit heavy quick stats');

  const recoveredConv = payload.conversations.find((c) => c.cascadeId.startsWith('00000035-'));
  assert.ok(recoveredConv);
  assert.equal(recoveredConv.title, '排查热力图悬浮提示抖动问题');
});

test('Feature 8: StepsDetailView model summary cards align with Model Ranking (proportional 4-seg bar + left-aligned perf sub-row + unit cost)', (t) => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevLocale = i18nStore.getState().locale;
  const prevUi = uiStore.getState();
  const prevTel = telemetryStore.getState();

  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    location: { pathname: '/' },
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
  };

  let view = null;
  t.after(() => {
    if (view) view.destroy();
    setI18nLanguage(prevLocale);
    uiStore.setState(prevUi, { sync: true });
    telemetryStore.setState(prevTel, { sync: true });
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  setI18nLanguage('zh-CN');
  uiStore.setState(
    { monitorVisible: true, activeView: 'steps', stepsSubTab: 'models', selectedAgentScope: 'all' },
    { sync: true }
  );
  telemetryStore.setState(
    {
      telemetry: {
        settings: { language: 'zh-CN', modelDisplayMode: 'upstream', showUpstreamModel: true },
        activeConversation: {
          cascadeId: 'steps-summary-align',
          stepCount: 10,
          recentSteps: [],
          modelBreakdown: [
            {
              label: '4-neon',
              shortName: '4-neon',
              upstreamName: '4-neon',
              calls: 8,
              inputTokens: 100_000,
              cacheReadTokens: 600_000,
              thinkingTokens: 50_000,
              responseTokens: 50_000,
              outputTokens: 100_000,
              totalTokens: 800_000,
              costUsd: 2.4,
              avgTokPerSec: 45.2,
              avgTtftSec: 12.1,
              cacheHitPct: 85.7,
            },
            {
              label: '4-carbon',
              shortName: '4-carbon',
              upstreamName: '4-carbon',
              calls: 2,
              inputTokens: 40_000,
              cacheReadTokens: 140_000,
              thinkingTokens: 10_000,
              responseTokens: 10_000,
              outputTokens: 20_000,
              totalTokens: 200_000,
              costUsd: 0.4,
              avgTokPerSec: 22.0,
              avgTtftSec: 18.4,
              cacheHitPct: 77.8,
            },
          ],
        },
      },
    },
    { sync: true }
  );

  view = StepsDetailView();
  document.body.appendChild(view.el);

  const cards = view.el.querySelectorAll('.smodel-card');
  assert.equal(cards.length, 2);
  const sumBarPct = (card) =>
    card
      .querySelectorAll('.progress-seg')
      .reduce((acc, el) => acc + (Number.parseFloat(el.style.getPropertyValue('--seg-w')) || 0), 0);

  assert.ok(Math.abs(sumBarPct(cards[0]) - 80) < 0.2, `Expected 80% bar width for 4-neon, got ${sumBarPct(cards[0])}`);
  assert.ok(Math.abs(sumBarPct(cards[1]) - 20) < 0.2, `Expected 20% bar width for 4-carbon, got ${sumBarPct(cards[1])}`);
  assert.ok(cards[0].querySelector('.smodel-perf-foot > .smodel-perf'), 'Perf metrics live in dedicated left-aligned sub-row');
  assert.match(cards[0].querySelector('.smodel-unit-cost')?.textContent || '', /均价 \$3\.00\/1M/);
});

test('Feature 9: workspace/project cost aggregation (full + fast paths) and Projects ranking tab in ConsumptionView', async (t) => {
  const { normalizeWorkspaceBucket } = await import('../backend/usage-aggregator.mjs');

  // 1. URI / Windows / POSIX workspace path normalization
  const winNorm = normalizeWorkspaceBucket('file:///F%3A/ppt/1111/antigravity-usage-monitor/');
  assert.equal(winNorm.label, 'antigravity-usage-monitor');
  assert.equal(winNorm.workspacePath, 'F:/ppt/1111/antigravity-usage-monitor');
  assert.equal(winNorm.workspaceKey, 'f:/ppt/1111/antigravity-usage-monitor');

  const winBackslash = normalizeWorkspaceBucket('f:\\ppt\\1111\\antigravity-usage-monitor\\');
  assert.equal(winBackslash.workspaceKey, winNorm.workspaceKey);

  const posixNorm = normalizeWorkspaceBucket('file:///Users/dev/my-service/');
  assert.equal(posixNorm.label, 'my-service');
  assert.equal(posixNorm.workspacePath, '/Users/dev/my-service');

  // 2. End-to-end backend aggregation across multiple sessions sharing a workspace (including backfill from summaries.workspaces)
  const now = Date.now();
  const harn = backendHarness({
    cache: {
      'ws-conv-a1': {
        cascadeId: 'ws-conv-a1',
        title: 'Monitor work 1',
        appSource: 'standalone',
        workspaceUri: 'file:///F%3A/ppt/usage-monitor',
        steps: [
          {
            stepIndex: 1,
            modelKey: 'MODEL_PLACEHOLDER_M18',
            inputTokens: 120_000,
            cacheReadTokens: 180_000,
            outputTokens: 8_000,
            thinkingTokens: 3_000,
            responseTokens: 5_000,
            createdAtMs: now - 120_000,
          },
        ],
      },
      'ws-conv-a2': {
        cascadeId: 'ws-conv-a2',
        title: 'Monitor work 2',
        appSource: 'cli',
        // Intentionally omit workspaceUri on cache entry to verify backfill from summaries.workspaces
        steps: [
          {
            stepIndex: 1,
            modelKey: 'MODEL_PLACEHOLDER_M18',
            inputTokens: 80_000,
            cacheReadTokens: 120_000,
            outputTokens: 4_000,
            thinkingTokens: 1_000,
            responseTokens: 3_000,
            createdAtMs: now - 60_000,
          },
        ],
      },
      'ws-conv-b1': {
        cascadeId: 'ws-conv-b1',
        title: 'Docs site',
        appSource: 'ide',
        workspaceUri: 'file:///F%3A/ppt/docs-site',
        steps: [
          {
            stepIndex: 1,
            modelKey: 'MODEL_PLACEHOLDER_M18',
            inputTokens: 20_000,
            cacheReadTokens: 30_000,
            outputTokens: 1_000,
            thinkingTokens: 400,
            responseTokens: 600,
            createdAtMs: now - 90_000,
          },
        ],
      },
    },
    summaries: {
      'ws-conv-a1': {
        summary: 'Monitor work 1',
        stepCount: 1,
        lastModifiedTime: new Date(now - 120_000).toISOString(),
        workspaces: [{ workspaceFolderAbsoluteUri: 'file:///F%3A/ppt/usage-monitor' }],
      },
      'ws-conv-a2': {
        summary: 'Monitor work 2',
        stepCount: 1,
        lastModifiedTime: new Date(now - 60_000).toISOString(),
        workspaces: [{ workspaceFolderAbsoluteUri: 'file:///f:/ppt/usage-monitor/' }],
      },
      'ws-conv-b1': {
        summary: 'Docs site',
        stepCount: 1,
        lastModifiedTime: new Date(now - 90_000).toISOString(),
        workspaces: [{ workspaceFolderAbsoluteUri: 'file:///F%3A/ppt/docs-site' }],
      },
    },
  });

  const fullPayload = await harn.buildTelemetryPayloadInternal('ws-conv-a2', false, { range: '24h' });
  const topWs = fullPayload.consumption?.topWorkspaces || [];
  assert.equal(topWs.length, 2);
  assert.equal(topWs[0].label, 'usage-monitor');
  assert.equal(topWs[0].sessionCount, 2);
  assert.equal(topWs[0].calls, 2);
  assert.equal(topWs[0].totalTokens, 512_000);
  assert.equal(topWs[0].latestCascadeId, 'ws-conv-a2');
  assert.equal(topWs[0].canJump, true);
  assert.equal(topWs[1].label, 'docs-site');
  assert.equal(topWs[1].sessionCount, 1);

  const fastPayload = JSON.parse(
    (await harn.executeTelemetryAction({
      conversationId: 'ws-conv-a2',
      range: '24h',
      scope: 'consumption',
    })).body
  );
  assert.equal(fastPayload.consumption.topWorkspaces.length, 2);
  assert.equal(fastPayload.consumption.topWorkspaces[0].label, 'usage-monitor');
  assert.equal(fastPayload.consumption.topWorkspaces[0].totalTokens, topWs[0].totalTokens);

  // 3. Frontend ConsumptionView Projects tab rendering, sorting, and click-to-jump
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevFetch = globalThis.fetch;
  const prevLocale = i18nStore.getState().locale;
  const prevUi = uiStore.getState();
  const prevTel = telemetryStore.getState();

  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    sidecar: {
      fetch: (url, init) => globalThis.fetch(url, init),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (cb) => {
      cb();
      return 1;
    },
    cancelAnimationFrame: () => {},
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

  let view = null;
  t.after(() => {
    view?.destroy?.();
    setI18nLanguage(prevLocale);
    uiStore.setState(prevUi, { sync: true });
    telemetryStore.setState(prevTel, { sync: true });
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.fetch = prevFetch;
  });

  setI18nLanguage('zh-CN');
  uiStore.setState({ activeView: 'consumption', monitorVisible: true }, { sync: true });
  telemetryStore.setState(
    {
      selectedTimeRange: '7d',
      customStartMs: 0,
      customEndMs: 0,
      telemetry: {
        settings: {},
        consumption: {
          revision: 11,
          selectedRange: { key: '7d', label: '近7天', startMs: now - 86_400_000, endMs: now },
          account: {
            totalTokens: 1_000_000,
            inputTokens: 200_000,
            cacheReadTokens: 700_000,
            outputTokens: 100_000,
            responseTokens: 60_000,
            thinkingTokens: 40_000,
            costUsd: 3.0,
            savedCostUsd: 1.0,
            cacheHitPct: 77.8,
            calls: 10,
          },
          topConversations: [],
          topWorkspaces: [
            {
              workspaceKey: 'f:/ppt/usage-monitor',
              label: 'usage-monitor',
              workspacePath: 'F:/ppt/usage-monitor',
              isUnbound: false,
              sessionCount: 4,
              calls: 6,
              inputTokens: 150_000,
              cacheReadTokens: 200_000,
              responseTokens: 30_000,
              thinkingTokens: 20_000,
              totalTokens: 400_000,
              costUsd: 2.1,
              cacheHitPct: 57.1,
              latestCascadeId: 'ws-conv-a2',
              canJump: true,
              models: [{ label: '4-neon', shortName: '4-neon', calls: 6, totalTokens: 400_000, costUsd: 2.1 }],
            },
            {
              workspaceKey: 'f:/ppt/docs-site',
              label: 'docs-site',
              workspacePath: 'F:/ppt/docs-site',
              isUnbound: false,
              sessionCount: 2,
              calls: 4,
              inputTokens: 50_000,
              cacheReadTokens: 500_000,
              responseTokens: 30_000,
              thinkingTokens: 20_000,
              totalTokens: 600_000,
              costUsd: 0.9,
              cacheHitPct: 90.9,
              latestCascadeId: 'ws-conv-b1',
              canJump: true,
              models: [{ label: '4-carbon', shortName: '4-carbon', calls: 4, totalTokens: 600_000, costUsd: 0.9 }],
            },
          ],
          trendSeries: [],
          sourcesBreakdown: [],
          monthlyYear: 2026,
          monthlySeries: [],
        },
        modelBreakdown: [],
      },
    },
    { sync: true }
  );

  view = ConsumptionView();
  document.body.appendChild(view.el);

  const rankingPanel = view.el.querySelector('.cons-ranking-panel');
  const rankingTabBtns = rankingPanel.querySelector('.cons-ranking-head > .segmented').querySelectorAll('.seg-btn');
  assert.equal(rankingTabBtns.length, 3);
  assert.match(rankingTabBtns[1].textContent, /项目排行 \(2\)/);

  // Switch to Projects tab
  rankingTabBtns[1].dispatchEvent({ type: 'click', stopPropagation: () => {} });
  const wsRows = view.el.querySelectorAll('.cons-workspace-row');
  assert.equal(wsRows.length, 2);
  assert.equal(wsRows[0].querySelector('.cons-row-title-text').textContent, 'usage-monitor');
  assert.equal(wsRows[0].querySelector('.cons-ws-sessions-tag').textContent, '4 会话');

  // Switch sort to Tokens -> docs-site (600k) moves first
  const sortSwitches = rankingPanel.querySelectorAll('.cons-ranking-sort-wrap > .segmented');
  sortSwitches[1].querySelectorAll('.seg-btn')[1].dispatchEvent({ type: 'click', stopPropagation: () => {} });
  const wsRowsAfterSort = view.el.querySelectorAll('.cons-workspace-row');
  assert.equal(wsRowsAfterSort[0].querySelector('.cons-row-title-text').textContent, 'docs-site');

  // Project rows are read-only breakdown cards and must not jump on click
  assert.equal(wsRowsAfterSort[0].classList.contains('is-jumpable'), false);
  const prevView = uiStore.getState().activeView;
  const prevSelectedCid = telemetryStore.getState().selectedConversationId;
  wsRowsAfterSort[0].dispatchEvent({ type: 'click' });
  assert.equal(uiStore.getState().activeView, prevView);
  assert.equal(telemetryStore.getState().selectedConversationId, prevSelectedCid);
});

test('Feature 10: StepsDetailView live search, dynamic diagnostic chips, and click-to-inspect step drawer', async (t) => {
  const {
    computeStepQuickChipCounts,
    computeStepTimingWaterfall,
    filterStepsBySearchAndChip,
    buildStepDiagnosticMarkdown,
  } = await import('../src/core/stepInspector.js');

  const steps = [
    {
      stepIndex: 4,
      createdAtMs: Date.UTC(2026, 10, 22, 10, 4, 0),
      modelShort: '4-neon',
      modelLabel: 'Gemini 4 Neon',
      tokPerSec: 42.5,
      ttftSec: 32.4,
      streamDurationSec: 4.6,
      durationSec: 38.0,
      inputTokens: 12_000,
      cacheReadTokens: 8_000,
      outputTokens: 600,
      thinkingTokens: 400,
      responseTokens: 200,
      contextTokens: 120_600,
      cacheHitPct: 40.0,
      costUsd: 0.24,
      turnPrompt: 'Debug SQLite migrator lock contention',
      anomaly: { count: 1, severity: 'danger', primaryKind: 'rate_limit', kinds: { rate_limit: 1 } },
      anomalySig: 'rate_limit:1',
    },
    {
      stepIndex: 3,
      createdAtMs: Date.UTC(2026, 10, 22, 10, 3, 0),
      modelShort: '4-carbon',
      modelLabel: 'Gemini 4 Carbon',
      tokPerSec: null,
      ttftSec: null,
      isCompactionStep: true,
      inputTokens: 40_000,
      cacheReadTokens: 0,
      outputTokens: 1_500,
      contextTokens: 41_500,
      cacheHitPct: 0,
      costUsd: 0.08,
    },
    {
      stepIndex: 2,
      createdAtMs: Date.UTC(2026, 10, 22, 10, 2, 0),
      modelShort: '4-carbon',
      modelLabel: 'Gemini 4 Carbon',
      tokPerSec: 68.0,
      ttftSec: 1.8,
      streamDurationSec: 3.2,
      durationSec: 5.0,
      inputTokens: 4_000,
      cacheReadTokens: 96_000,
      outputTokens: 800,
      thinkingTokens: 200,
      responseTokens: 600,
      contextTokens: 100_800,
      cacheHitPct: 96.0,
      costUsd: 0.05,
      turnPrompt: 'Polish quota widget styling',
    },
  ];

  // 1. Pure O(N) chip counts, filtering, waterfall math, and diagnostic Markdown
  const counts = computeStepQuickChipCounts(steps);
  assert.deepEqual(counts, { anomaly: 1, compaction: 1, low_cache: 1, slow_ttft: 1 });
  assert.deepEqual(
    filterStepsBySearchAndChip(steps, { query: 'sqlite neon' }).map((s) => s.stepIndex),
    [4]
  );
  assert.deepEqual(
    filterStepsBySearchAndChip(steps, { quickChip: 'compaction' }).map((s) => s.stepIndex),
    [3]
  );
  assert.deepEqual(
    filterStepsBySearchAndChip(steps, { quickChip: 'low_cache' }).map((s) => s.stepIndex),
    [4]
  );
  assert.deepEqual(
    filterStepsBySearchAndChip(steps, { quickChip: 'slow_ttft' }).map((s) => s.stepIndex),
    [4]
  );

  const wf = computeStepTimingWaterfall(steps[0]);
  assert.equal(wf.totalSec, 38);
  assert.equal(wf.ttftSec, 32.4);
  assert.equal(wf.streamSec, 4.6);
  assert.equal(wf.otherSec, 1);

  // Aligns slow_ttft strictly with danger TTFT tier (>= 30s), avoiding false positives on 10-29.9s steps
  assert.deepEqual(
    computeStepQuickChipCounts([
      { stepIndex: 10, ttftSec: 12.4 },
      { stepIndex: 11, ttftSec: 29.9 },
      { stepIndex: 12, ttftSec: 30.0 },
    ]).slow_ttft,
    1
  );

  const md = buildStepDiagnosticMarkdown(steps[0], { prevContextTokens: 41_500 });
  assert.match(md, /Step #4/);
  assert.match(md, /Debug SQLite migrator/);
  assert.match(md, /\+79\.1k/);

  // 2. Full StepsDetailView DOM integration: search input, diagnostic chips, row click -> drawer, keyboard Escape
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevUi = { ...uiStore.getState() };
  const prevTel = { ...telemetryStore.getState() };
  const prevLocale = i18nStore.getState().locale;

  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 960,
    innerHeight: 720,
    addEventListener() {},
    removeEventListener() {},
  };
  setI18nLanguage('zh-CN');

  let view = null;
  t.after(() => {
    view?.destroy?.();
    uiStore.setState(prevUi, { sync: true });
    telemetryStore.setState(prevTel, { sync: true });
    setI18nLanguage(prevLocale);
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  uiStore.setState({ activeView: 'steps', stepsSubTab: 'steps', monitorVisible: true }, { sync: true });
  telemetryStore.setState(
    {
      telemetry: {
        settings: { stepTableColumns: ['step', 'model', 'tps', 'cost'] },
        activeConversation: {
          cascadeId: 'cid-insp-1',
          stepCount: 3,
          recentSteps: steps,
          modelBreakdown: [],
        },
      },
    },
    { sync: true }
  );

  view = StepsDetailView();
  document.body.appendChild(view.el);

  // Filter toolbar is OFF by default, while compact export ActionMenu stays accessible in header
  assert.equal(view.refs.stepsFilterToolbarEl.hasAttribute('hidden'), true);
  assert.equal(view.refs.stepsExportMenu.el.hasAttribute('hidden'), false);
  assert.ok(
    view.el.querySelector('.steps-panel-header .steps-export-menu .action-menu-trigger'),
    'Compact 3-dot export menu stays accessible in Steps header even when filter bar is off'
  );

  // Enabling showStepFilterToolbar in settings reveals search bar + all 4 diagnostic chips
  telemetryStore.setState(
    {
      telemetry: {
        ...telemetryStore.getState().telemetry,
        settings: {
          stepTableColumns: ['step', 'model', 'tps', 'cost'],
          showStepFilterToolbar: true,
        },
      },
    },
    { sync: true }
  );
  assert.equal(view.refs.stepsFilterToolbarEl.hasAttribute('hidden'), false);
  assert.equal(view.refs.stepQuickChipsEl.classList.contains('segmented'), true);
  const chipBtns = view.refs.stepQuickChipsEl.querySelectorAll('.seg-btn');
  assert.equal(chipBtns.length, 5);
  assert.equal(chipBtns[0].getAttribute('data-seg-value'), '');
  assert.equal(chipBtns[0].classList.contains('is-active'), true);

  // Click Low Cache segment -> narrows table to step #4
  const lowCacheBtn = chipBtns.find((b) => b.getAttribute('data-seg-value') === 'low_cache');
  lowCacheBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
  let rows = view.el.querySelectorAll('tbody tr');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].children[0].textContent, '#4');

  // Toggle active segment off -> returns to All and restores all 3 rows
  lowCacheBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
  rows = view.el.querySelectorAll('tbody tr');
  assert.equal(rows.length, 3);
  assert.equal(chipBtns[0].classList.contains('is-active'), true);

  // Type search query "quota" -> narrows to step #2
  view.refs.stepSearchInput.value = 'quota';
  view.refs.stepSearchInput.dispatchEvent({ type: 'input', target: view.refs.stepSearchInput });
  rows = view.el.querySelectorAll('tbody tr');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].children[0].textContent, '#2');

  // Turning showStepFilterToolbar back off clears active search and restores all 3 rows
  telemetryStore.setState(
    {
      telemetry: {
        ...telemetryStore.getState().telemetry,
        settings: {
          stepTableColumns: ['step', 'model', 'tps', 'cost'],
          showStepFilterToolbar: false,
        },
      },
    },
    { sync: true }
  );
  assert.equal(view.refs.stepsFilterToolbarEl.hasAttribute('hidden'), true);
  assert.equal(view.refs.stepSearchInput.value, '');
  rows = view.el.querySelectorAll('tbody tr');
  assert.equal(rows.length, 3);

  // Step rows do not expose row-click diagnostic drawer or selection handlers
  assert.equal(view.el.querySelector('.step-inspector-drawer'), null);
  assert.equal(Boolean(rows[0].onclick), false);
  assert.equal(rows[0].classList.contains('is-selectable'), false);
  assert.equal(rows[0].classList.contains('is-selected'), false);
});

test('Feature 11: native multi-sheet localized XLSX, formula-safe CSV and bilingual Markdown report export', async () => {
  const {
    escapeCsvCell,
    sanitizeExportFilename,
    buildStepsCsv,
    buildStepsXlsx,
    buildStepsMarkdownReport,
    buildStepsExportBaseName,
    buildConsumptionCsv,
    buildConsumptionXlsx,
    buildConsumptionMarkdownReport,
    buildConsumptionExportBaseName,
  } = await import('../src/core/reportExporter.js');

  function parseZipStoreEntries(bytes) {
    assert.equal(bytes instanceof Uint8Array, true);
    assert.equal(bytes[0], 0x50);
    assert.equal(bytes[1], 0x4b);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries = new Map();
    let pos = 0;
    while (pos + 30 <= bytes.length && view.getUint32(pos, true) === 0x04034b50) {
      const compMethod = view.getUint16(pos + 8, true);
      assert.equal(compMethod, 0, 'ZIP STORE entry');
      const compSize = view.getUint32(pos + 18, true);
      const nameLen = view.getUint16(pos + 26, true);
      const extraLen = view.getUint16(pos + 28, true);
      const nameStart = pos + 30;
      const dataStart = nameStart + nameLen + extraLen;
      const name = Buffer.from(bytes.subarray(nameStart, nameStart + nameLen)).toString('utf8');
      const text = Buffer.from(bytes.subarray(dataStart, dataStart + compSize)).toString('utf8');
      entries.set(name, text);
      pos = dataStart + compSize;
    }
    // Verify EOCD record exists at end
    const eocdPos = bytes.length - 22;
    assert.equal(view.getUint32(eocdPos, true), 0x06054b50, 'Valid ZIP EOCD signature');
    assert.equal(view.getUint16(eocdPos + 10, true), entries.size);
    return entries;
  }

  // 1. Formula injection neutralization and RFC-4180 quoting
  assert.equal(escapeCsvCell('=CMD("calc")'), `"'=CMD(""calc"")"` );
  assert.equal(escapeCsvCell('+SUM(A1:A2)'), `'+SUM(A1:A2)`);
  assert.equal(escapeCsvCell('@evil'), `'@evil`);
  assert.equal(escapeCsvCell('-12.5'), '-12.5'); // genuine signed numbers preserved
  assert.equal(escapeCsvCell('hello, "world"\nline2'), '"hello, ""world""\nline2"');

  const fname = sanitizeExportFilename('my:bad/title*name?', 'xlsx', Date.UTC(2026, 10, 22, 8, 5));
  assert.match(fname, /^my-bad-title-name-\d{8}-\d{4}\.xlsx$/);

  // 2. Steps CSV, bilingual Markdown report, and native multi-sheet XLSX (with danger/info row styles)
  const sampleSteps = [
    {
      stepIndex: 2,
      createdAtMs: Date.UTC(2026, 10, 22, 9, 0, 0),
      modelShort: '4-neon',
      modelLabel: 'Gemini 4 Neon',
      rawModelId: 'gemini-4-neon',
      tokPerSec: 55.2,
      ttftSec: 2.4,
      durationSec: 6.8,
      inputTokens: 10_000,
      cacheReadTokens: 90_000,
      outputTokens: 500,
      thinkingTokens: 300,
      responseTokens: 200,
      contextTokens: 100_500,
      cacheHitPct: 90,
      costUsd: 0.145,
      anomaly: { count: 1, primaryKind: 'timeout', kinds: { timeout: 1 } },
      turnPrompt: '=HYPERLINK("http://x"), "test"',
    },
    {
      stepIndex: 3,
      createdAtMs: Date.UTC(2026, 10, 22, 9, 5, 0),
      modelShort: '4-neon',
      modelLabel: 'Gemini 4 Neon',
      inputTokens: 1_000,
      cacheReadTokens: 50_000,
      outputTokens: 300,
      costUsd: 0.012,
      isCompactionStep: true,
    },
  ];
  const stepsCsv = buildStepsCsv(sampleSteps);
  assert.equal(stepsCsv.startsWith('\uFEFFstep,timestamp,'), true);
  assert.match(stepsCsv, /"'=HYPERLINK\(""http:\/\/x""\), ""test"""/);
  assert.match(stepsCsv, /0\.145000/);

  const stepsMdEn = buildStepsMarkdownReport(sampleSteps, {
    title: 'Perf Audit',
    cascadeId: 'cid-export-1',
    locale: 'en-US',
  });
  assert.match(stepsMdEn, /# Perf Audit/);
  assert.match(stepsMdEn, /## Model Breakdown/);
  assert.match(stepsMdEn, /## Top Costliest Steps/);
  assert.match(stepsMdEn, /#2/);

  const stepsMdZh = buildStepsMarkdownReport(sampleSteps, {
    title: 'Perf Audit',
    cascadeId: 'cid-export-1',
    locale: 'zh-CN',
  });
  assert.match(stepsMdZh, /## 模型分布/);
  assert.match(stepsMdZh, /## 高成本步骤 Top 5/);
  assert.match(stepsMdZh, /异常汇总/);

  const stepsXlsxZh = parseZipStoreEntries(
    buildStepsXlsx(sampleSteps, { title: 'Perf Audit', locale: 'zh-CN' })
  );
  assert.match(stepsXlsxZh.get('xl/workbook.xml'), /name="步骤明细"/);
  assert.match(stepsXlsxZh.get('xl/workbook.xml'), /name="模型汇总"/);
  const stepsSheetZh = stepsXlsxZh.get('xl/worksheets/sheet1.xml');
  assert.match(stepsSheetZh, /<pane ySplit="1"/);
  assert.match(stepsSheetZh, /<autoFilter ref="A1:R3"\/>/, 'AutoFilter excludes bottom summary row 4');
  assert.match(stepsSheetZh, /t="inlineStr"[^>]*><is><t[^>]*>=HYPERLINK/, 'Formulas stored safely as inlineStr');
  assert.match(stepsSheetZh, /自动压缩/);
  assert.match(stepsSheetZh, /流空闲 \/ 连接超时/);
  assert.match(stepsSheetZh, /合计（共 2 步）/);

  const stepsXlsxEn = parseZipStoreEntries(
    buildStepsXlsx(sampleSteps, { title: 'Perf Audit', locale: 'en-US' })
  );
  assert.match(stepsXlsxEn.get('xl/workbook.xml'), /name="Steps"/);
  assert.match(stepsXlsxEn.get('xl/workbook.xml'), /name="Model Summary"/);
  assert.match(stepsXlsxEn.get('xl/worksheets/sheet1.xml'), /Compaction/);
  assert.match(stepsXlsxEn.get('xl/worksheets/sheet1.xml'), /Total \(2 steps\)/);

  // 3. Consumption CSV, bilingual Markdown report, and 6-sheet native XLSX
  const cons = {
    selectedRange: { key: '7d', label: '近7天', startMs: Date.UTC(2026, 10, 15), endMs: Date.UTC(2026, 10, 22) },
    account: {
      calls: 410,
      inputTokens: 2_250_054,
      cacheReadTokens: 100_300_000,
      outputTokens: 479_037,
      thinkingTokens: 136_100,
      responseTokens: 342_937,
      totalTokens: 103_029_091,
      cacheHitPct: 97.8,
      costUsd: 28.98,
      savedCostUsd: 285.89,
    },
    topWorkspaces: [
      {
        label: 'usage-monitor',
        workspacePath: 'F:/ppt/1111/antigravity-usage-monitor',
        sessionCount: 3,
        calls: 333,
        inputTokens: 1_859_526,
        cacheReadTokens: 85_614_438,
        responseTokens: 250_000,
        thinkingTokens: 134_565,
        totalTokens: 87_858_529,
        cacheHitPct: 97.9,
        costUsd: 24.1892,
      },
    ],
    topConversations: [
      {
        cascadeId: 'cid-1',
        title: 'Refactor',
        sourceName: 'Antigravity App',
        calls: 333,
        inputTokens: 1_859_526,
        cacheReadTokens: 85_614_438,
        responseTokens: 250_000,
        thinkingTokens: 134_565,
        totalTokens: 87_858_529,
        cacheHitPct: 97.9,
        costUsd: 24.1892,
      },
    ],
    trendSeries: [
      { label: '11/22', fullLabel: '2026-11-22', granularity: 'day', calls: 410, inputTokens: 2_250_054, cacheReadTokens: 100_300_000, outputTokens: 479_037, tokens: 103_029_091, costUsd: 28.98 },
    ],
    sourcesBreakdown: [
      { name: 'Antigravity App', calls: 333, inputTokens: 1_859_526, cacheReadTokens: 85_614_438, outputTokens: 384_565, totalTokens: 87_858_529, costUsd: 24.19 },
    ],
  };
  const models = [
    {
      label: '4-neon',
      shortName: '4-neon',
      calls: 410,
      inputTokens: 2_250_054,
      cacheReadTokens: 100_300_000,
      outputTokens: 479_037,
      totalTokens: 103_029_091,
      cacheHitPct: 97.8,
      avgTokPerSec: 50.9,
      costUsd: 28.9826,
    },
  ];
  const consCsv = buildConsumptionCsv(cons, models);
  assert.equal(consCsv.startsWith('\uFEFFsection,name,'), true);
  assert.match(consCsv, /project,usage-monitor,333,/);
  assert.match(consCsv, /trend,2026-11-22,410,/);

  const consMdEn = buildConsumptionMarkdownReport(cons, models, { locale: 'en-US' });
  assert.match(consMdEn, /# Usage Report · Last 7 Days/);
  assert.match(consMdEn, /## Models/);
  assert.match(consMdEn, /## Projects/);
  assert.match(consMdEn, /usage-monitor/);
  assert.match(consMdEn, /## Top Sessions/);

  const consMdZh = buildConsumptionMarkdownReport(cons, models, { locale: 'zh-CN' });
  assert.match(consMdZh, /# 用量统计报告 · 近7天/);
  assert.match(consMdZh, /## 模型排行/);
  assert.match(consMdZh, /## 项目排行/);
  assert.match(consMdZh, /## 热门会话/);

  const consXlsxZh = parseZipStoreEntries(buildConsumptionXlsx(cons, models, { locale: 'zh-CN' }));
  const wbZh = consXlsxZh.get('xl/workbook.xml');
  for (const sheetName of ['用量总览', '模型排行', '项目排行', '会话排行', '时间趋势', '客户端来源']) {
    assert.ok(wbZh.includes(`name="${sheetName}"`), `ZH workbook includes sheet ${sheetName}`);
  }
  const stylesXml = consXlsxZh.get('xl/styles.xml');
  assert.match(stylesXml, /formatCode="#,##0"/);
  assert.match(stylesXml, /formatCode="\$#,##0\.00"/);
  assert.match(stylesXml, /formatCode="0\.0%"/);
  assert.match(stylesXml, /<cellXfs count="45">/);

  const modelsSheetZh = consXlsxZh.get('xl/worksheets/sheet2.xml');
  assert.match(modelsSheetZh, /<v>103029091<\/v>/, 'Large token count stored as raw integer without scientific notation');
  assert.match(modelsSheetZh, /customWidth="1"/, 'Auto column widths emitted');
  assert.match(modelsSheetZh, /<autoFilter ref="A1:J2"\/>/, 'Models autoFilter excludes bottom total row');

  const consXlsxEn = parseZipStoreEntries(buildConsumptionXlsx(cons, models, { locale: 'en-US' }));
  const wbEn = consXlsxEn.get('xl/workbook.xml');
  for (const sheetName of ['Overview', 'Models', 'Projects', 'Sessions', 'Trend', 'Client Sources']) {
    assert.ok(wbEn.includes(`name="${sheetName}"`), `EN workbook includes sheet ${sheetName}`);
  }
  assert.match(consXlsxEn.get('xl/worksheets/sheet1.xml'), /Last 7 Days/);
  assert.equal(consXlsxEn.get('xl/worksheets/sheet1.xml').includes('近7天'), false);

  assert.equal(buildConsumptionExportBaseName(cons, '7d', { locale: 'zh-CN' }), '用量统计-近7天');
  assert.equal(buildConsumptionExportBaseName(cons, '7d', { locale: 'en-US' }), 'usage-7d');
  assert.equal(buildStepsExportBaseName('调试任务', '', { locale: 'zh-CN' }), '调用明细-调试任务');
  assert.equal(buildStepsExportBaseName('Debug Task', '', { locale: 'en-US' }), 'steps-Debug Task');
});

test('Feature 13: TopSessionHeader exposes project/workspace tags on sessions and filters by workspace name', async (t) => {
  const { TopSessionHeader } = await import('../src/components/layout/TopSessionHeader.js');
  const now = Date.now();
  const harn = backendHarness({
    cache: {
      'proj-conv-1': {
        cascadeId: 'proj-conv-1',
        title: 'Fix auth bug',
        workspaceUri: 'file:///F%3A/repos/billing-service',
        steps: [{ stepIndex: 1, modelKey: 'MODEL_PLACEHOLDER_M18', inputTokens: 1000, outputTokens: 100, createdAtMs: now - 5000 }],
      },
      'proj-conv-2': {
        cascadeId: 'proj-conv-2',
        title: 'Fix auth bug',
        workspaceUri: 'file:///F%3A/repos/web-dashboard',
        steps: [{ stepIndex: 1, modelKey: 'MODEL_PLACEHOLDER_M18', inputTokens: 1000, outputTokens: 100, createdAtMs: now - 10000 }],
      },
    },
    summaries: {
      'proj-conv-1': { summary: 'Fix auth bug', stepCount: 1, lastModifiedTime: new Date(now - 5000).toISOString() },
      'proj-conv-2': { summary: 'Fix auth bug', stepCount: 1, lastModifiedTime: new Date(now - 10000).toISOString() },
    },
  });

  const payload = await harn.buildTelemetryPayloadInternal('proj-conv-1');
  const convById = new Map((payload.conversations || []).map((c) => [c.cascadeId, c]));
  assert.equal(convById.get('proj-conv-1')?.workspaceName, 'billing-service');
  assert.equal(convById.get('proj-conv-2')?.workspaceName, 'web-dashboard');

  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevLocale = i18nStore.getState().locale;
  const prevUi = uiStore.getState();
  const prevTel = telemetryStore.getState();

  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 960,
    innerHeight: 720,
    addEventListener() {},
    removeEventListener() {},
  };

  let header = null;
  t.after(() => {
    header?.destroy?.();
    setI18nLanguage(prevLocale);
    uiStore.setState(prevUi, { sync: true });
    telemetryStore.setState(prevTel, { sync: true });
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  setI18nLanguage('zh-CN');
  uiStore.setState({ activeView: 'overview', monitorVisible: true }, { sync: true });
  telemetryStore.setState(
    {
      selectedConversationId: '',
      telemetry: {
        ...payload,
        conversations: [
          ...payload.conversations,
          ...Array.from({ length: 6 }, (_, i) => ({
            cascadeId: `pad-${i}`,
            title: `Other session ${i}`,
            stepCount: 2,
            workspaceName: 'misc-repo',
          })),
        ],
      },
    },
    { sync: true }
  );

  header = TopSessionHeader();
  document.body.appendChild(header.el);
  header.refs.convSelect.open();

  const optionEls = header.refs.convSelect.el.querySelectorAll('.select-option');
  const billingOpt = optionEls.find((el) => el.getAttribute('data-value') === 'proj-conv-1');
  assert.ok(billingOpt, 'Session dropdown renders proj-conv-1 option');
  assert.equal(
    (billingOpt.textContent || '').includes('billing-service'),
    false,
    'Session dropdown hides noisy workspaceName from visible row text'
  );
  assert.match(
    billingOpt.getAttribute('title') || '',
    /billing-service/,
    'Session dropdown preserves workspace path in hover tooltip'
  );

  const searchInput = header.refs.convSelect.el.querySelector('.select-search-input');
  assert.ok(searchInput, 'Search input present for >6 sessions');
  searchInput.value = 'web-dashboard';
  searchInput.dispatchEvent({ type: 'input', target: searchInput });
  const visibleOpts = header.refs.convSelect.el
    .querySelectorAll('.select-option')
    .filter((el) => !el.hasAttribute('hidden'));
  assert.equal(visibleOpts.length, 1);
  assert.equal(visibleOpts[0].getAttribute('data-value'), 'proj-conv-2');
  assert.match(visibleOpts[0].getAttribute('title') || '', /web-dashboard/);
});

test('Feature 14: compact vertical ActionMenu replaces export bars, backend exports files safely with reveal whitelist and toast feedback', async (t) => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const {
    sanitizeLocalExportFilename,
    writeLocalExportFile,
    revealLocalExportFile,
  } = await import('../backend/file-exporter.mjs');
  const { dispatchBridgeApiRequest } = await import('../backend/api-actions.mjs');
  const { dismissUiToast } = await import('../src/store/uiStore.js');

  // 1. Filename sanitization blocks traversal and enforces allowlist extensions
  const safe1 = sanitizeLocalExportFilename('../../evil<script>.exe', 'text/csv');
  assert.equal(safe1.ext, '.csv');
  assert.equal(safe1.fileName.includes('..'), false);
  assert.equal(safe1.fileName.includes('/'), false);

  // 2. Backend write avoids overwrite collisions and enforces reveal whitelist
  const tempExportDir = mkdtempSync(path.join(os.tmpdir(), 'ag-export-test-'));
  t.after(() => {
    try {
      rmSync(tempExportDir, { recursive: true, force: true });
    } catch {}
  });

  const exp1 = writeLocalExportFile(
    { filename: 'usage-today.csv', content: 'a,b\n1,2\n', mimeType: 'text/csv' },
    { overrideDir: tempExportDir }
  );
  assert.equal(exp1.ok, true);
  assert.equal(exp1.fileName, 'usage-today.csv');
  assert.equal(readFileSync(exp1.filePath, 'utf8'), 'a,b\n1,2\n');

  const exp2 = writeLocalExportFile(
    { filename: 'usage-today.csv', content: 'a,b\n3,4\n', mimeType: 'text/csv' },
    { overrideDir: tempExportDir }
  );
  assert.equal(exp2.ok, true);
  assert.equal(exp2.fileName, 'usage-today (1).csv');

  // Binary .xlsx base64 export writes exact ZIP/PK archive and rejects corrupted non-PK payload
  const { buildXlsxWorkbookBytes, uint8ArrayToBase64 } = await import('../src/core/xlsxBuilder.js');
  const miniXlsx = buildXlsxWorkbookBytes([
    { name: '总览', columns: [{ header: '指标', type: 'text' }], rows: [['测试']] },
  ]);
  const expXlsx = writeLocalExportFile(
    {
      filename: '用量统计-今日.xlsx',
      content: uint8ArrayToBase64(miniXlsx),
      encoding: 'base64',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    },
    { overrideDir: tempExportDir }
  );
  assert.equal(expXlsx.ok, true);
  assert.equal(expXlsx.fileName, '用量统计-今日.xlsx');
  const savedXlsxBytes = readFileSync(expXlsx.filePath);
  assert.equal(savedXlsxBytes[0], 0x50);
  assert.equal(savedXlsxBytes[1], 0x4b);
  assert.equal(savedXlsxBytes.length, miniXlsx.length);

  const badXlsx = writeLocalExportFile(
    {
      filename: 'corrupt.xlsx',
      content: Buffer.from('not-a-zip').toString('base64'),
      encoding: 'base64',
    },
    { overrideDir: tempExportDir }
  );
  assert.equal(badXlsx.ok, false);
  assert.equal(badXlsx.status, 400);

  // Unauthorized arbitrary path must be rejected (403)
  const denied = revealLocalExportFile(path.join(tempExportDir, 'not-exported.txt'), {
    platform: 'win32',
    spawnFn: () => {
      throw new Error('Should never spawn for unauthorized path');
    },
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);

  // Authorized exported path spawns explorer /select,"<path>" cleanly
  const spawnCalls = [];
  const revealed = revealLocalExportFile(exp1.filePath, {
    platform: 'win32',
    spawnFn: (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts });
      return { on() {}, unref() {} };
    },
  });
  assert.equal(revealed.ok, true);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].cmd, 'explorer.exe');
  assert.equal(spawnCalls[0].args[0], `/select,"${exp1.filePath}"`);

  // 3. Bridge API dispatch handles /api/export-file and /api/reveal-file
  const apiSave = await dispatchBridgeApiRequest(
    '/api/export-file',
    'POST',
    { filename: 'prefs.json', content: '{"ok":true}\n', mimeType: 'application/json' },
    { exportDir: tempExportDir }
  );
  assert.equal(apiSave.status, 200);
  const apiSaveBody = JSON.parse(apiSave.body);
  assert.equal(apiSaveBody.ok, true);
  assert.equal(apiSaveBody.fileName, 'prefs.json');

  const apiReveal = await dispatchBridgeApiRequest(
    '/api/reveal-file',
    'POST',
    { filePath: apiSaveBody.filePath },
    {
      platform: 'win32',
      spawnFn: (cmd, args) => {
        spawnCalls.push({ cmd, args });
        return { on() {}, unref() {} };
      },
    }
  );
  assert.equal(apiReveal.status, 200);
  assert.equal(spawnCalls.length, 2);

  // 4. Frontend ConsumptionView places ActionMenu in overview header (no bottom .cons-export-strip) and shows path toast
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevFetch = globalThis.fetch;
  const prevLocale = i18nStore.getState().locale;
  const prevUi = { ...uiStore.getState() };
  const prevTel = { ...telemetryStore.getState() };

  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    sidecar: {
      fetch: (url, init) => globalThis.fetch(url, init),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (cb) => {
      cb();
      return 1;
    },
    cancelAnimationFrame: () => {},
  };

  const apiCalls = [];
  globalThis.fetch = async (url, init) => {
    const parsedBody = init?.body ? JSON.parse(init.body) : {};
    apiCalls.push({ url, method: init?.method || 'GET', body: parsedBody });
    if (String(url).includes('/api/export-file')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          filePath: apiSaveBody.filePath,
          dirPath: tempExportDir,
          fileName: parsedBody.filename || '用量统计-近7天.xlsx',
        }),
      };
    }
    if (String(url).includes('/api/reveal-file')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, filePath: parsedBody.filePath }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  let view = null;
  t.after(() => {
    view?.destroy?.();
    dismissUiToast();
    setI18nLanguage(prevLocale);
    uiStore.setState(prevUi, { sync: true });
    telemetryStore.setState(prevTel, { sync: true });
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.fetch = prevFetch;
  });

  setI18nLanguage('zh-CN');
  uiStore.setState({ activeView: 'consumption', monitorVisible: true, toast: null }, { sync: true });
  telemetryStore.setState(
    {
      selectedTimeRange: '7d',
      customStartMs: 0,
      customEndMs: 0,
      telemetry: {
        settings: {},
        consumption: {
          revision: 31,
          selectedRange: { key: '7d', label: '近7天' },
          account: {
            calls: 5,
            totalTokens: 500_000,
            inputTokens: 100_000,
            cacheReadTokens: 380_000,
            outputTokens: 20_000,
            responseTokens: 12_000,
            thinkingTokens: 8_000,
            costUsd: 1.2,
            savedCostUsd: 0.8,
            cacheHitPct: 79.2,
          },
          topConversations: [],
          topWorkspaces: [],
          trendSeries: [],
          sourcesBreakdown: [],
          monthlyYear: 2026,
          monthlySeries: [],
        },
        modelBreakdown: [],
      },
    },
    { sync: true }
  );

  view = ConsumptionView();
  document.body.appendChild(view.el);

  assert.equal(view.el.querySelectorAll('.cons-export-strip').length, 0, 'Bottom export strip removed');
  assert.ok(
    view.el.querySelector('.cons-overview-head .cons-export-menu .action-menu-trigger'),
    'Compact vertical 3-dot trigger lives inside overview header'
  );

  const menu = view.refs.consExportMenu;
  assert.equal(menu.refs.isOpen(), false);
  menu.refs.triggerBtn.dispatchEvent({ type: 'click', stopPropagation: () => {} });
  assert.equal(menu.refs.isOpen(), true);

  const xlsxItem = menu.refs.getItemBtn('xlsx');
  assert.ok(xlsxItem);
  xlsxItem.dispatchEvent({ type: 'click', stopPropagation: () => {} });
  assert.equal(menu.refs.isOpen(), false);

  await new Promise((r) => setTimeout(r, 15));
  const exportCall = apiCalls.find((c) => String(c.url).includes('/api/export-file'));
  assert.ok(exportCall, 'XLSX menu item posts to /api/export-file');
  assert.equal(exportCall.body.encoding, 'base64');
  assert.match(exportCall.body.filename, /^用量统计-近7天-\d{8}-\d{4}\.xlsx$/);

  const toast = uiStore.getState().toast;
  assert.ok(toast, 'Export displays global toast');
  assert.match(toast.message, /用量统计-近7天-.*\.xlsx/);
  assert.equal(toast.detail, apiSaveBody.filePath);
  assert.equal(toast.actionLabel, '打开位置');
  assert.equal(typeof toast.onAction, 'function');

  // Clicking toast action calls /api/reveal-file with exact saved path
  toast.onAction();
  await new Promise((r) => setTimeout(r, 15));
  const revealCall = apiCalls.find((c) => String(c.url).includes('/api/reveal-file'));
  assert.ok(revealCall, 'Open Folder action invokes /api/reveal-file');
  assert.equal(revealCall.body.filePath, apiSaveBody.filePath);

  // 5. Fallback via POST /api/settings (__exportFileAction) when sticky main.mjs returns 404 for new routes
  const { exportTextFileWithFeedback, revealExportedFile } = await import(
    '../src/core/fileExportClient.js'
  );
  const fallbackCalls = [];
  globalThis.window.sidecar = {
    fetch: async (url, init) => {
      const parsedBody = init?.body ? JSON.parse(init.body) : {};
      fallbackCalls.push({ url, body: parsedBody });
      if (String(url).includes('/api/export-file') || String(url).includes('/api/reveal-file')) {
        return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
      }
      if (String(url).includes('/api/settings') && parsedBody.__exportFileAction === 'save') {
        const out = await dispatchBridgeApiRequest('/api/settings', 'POST', parsedBody, {
          exportDir: tempExportDir,
        });
        return { ok: out.status === 200, status: out.status, json: async () => JSON.parse(out.body) };
      }
      if (String(url).includes('/api/settings') && parsedBody.__exportFileAction === 'reveal') {
        const out = await dispatchBridgeApiRequest('/api/settings', 'POST', parsedBody, {
          platform: 'win32',
          spawnFn: (cmd, args) => {
            spawnCalls.push({ cmd, args });
            return { on() {}, unref() {} };
          },
        });
        return { ok: out.status === 200, status: out.status, json: async () => JSON.parse(out.body) };
      }
      return { ok: false, status: 500, json: async () => ({ error: 'Unexpected' }) };
    },
  };

  const fallbackRes = await exportTextFileWithFeedback(
    'hotreload-settings.json',
    '{"theme":"blue"}\n',
    'application/json;charset=utf-8'
  );
  assert.equal(fallbackRes.ok, true);
  assert.equal(fallbackRes.mode, 'local');
  assert.equal(fallbackRes.fileName, 'hotreload-settings.json');
  assert.equal(readFileSync(fallbackRes.filePath, 'utf8'), '{"theme":"blue"}\n');
  assert.ok(
    fallbackCalls.some((c) => c.url === '/api/settings' && c.body.__exportFileAction === 'save'),
    'Falls back to POST /api/settings when sticky main.mjs returns 404'
  );

  const revealFallbackOk = await revealExportedFile(fallbackRes.filePath);
  assert.equal(revealFallbackOk, true);
  assert.ok(
    fallbackCalls.some((c) => c.url === '/api/settings' && c.body.__exportFileAction === 'reveal')
  );

  // 6. Inside host embedded Webview, total backend failure never fakes a browser download toast
  globalThis.window.sidecar = {
    fetch: async () => ({ ok: false, status: 500, json: async () => ({ error: 'Down' }) }),
  };
  const failedRes = await exportTextFileWithFeedback('broken.csv', 'a,b\n', 'text/csv');
  assert.equal(failedRes.ok, false);
  assert.equal(failedRes.mode, 'failed');
  assert.equal(uiStore.getState().toast?.tone, 'warn');

  // 7. Standalone browser mode (no window.sidecar and no window bridge) skips /api/export-file
  //    completely (even over ssh -L / loopback reverse proxy) and invokes native Save Picker directly
  delete globalThis.window.sidecar;
  let browserExportBackendCalled = false;
  globalThis.fetch = async () => {
    browserExportBackendCalled = true;
    return { ok: true, status: 200, json: async () => ({ ok: true, filePath: '/remote/Downloads/leak.json' }) };
  };
  let pickedSuggestedName = '';
  let pickedWrittenPayload = null;
  globalThis.window.showSaveFilePicker = async (opts) => {
    pickedSuggestedName = opts?.suggestedName || '';
    return {
      name: pickedSuggestedName,
      createWritable: async () => ({
        write: async (data) => {
          pickedWrittenPayload = data;
        },
        close: async () => {},
      }),
    };
  };
  const standalonePickerRes = await exportTextFileWithFeedback(
    'standalone-report.md',
    '# Hello Browser\n',
    'text/markdown'
  );
  assert.equal(browserExportBackendCalled, false, 'Standalone browser must NOT call /api/export-file');
  assert.equal(standalonePickerRes.ok, true);
  assert.equal(standalonePickerRes.mode, 'picker');
  assert.equal(pickedSuggestedName, 'standalone-report.md');
  assert.equal(pickedWrittenPayload, '# Hello Browser\n');
  assert.equal(await revealExportedFile('/remote/Downloads/leak.json'), false);
});

test('P0 regression: V4 display-projected steps open inspector, preserve waterfall/diagnostics/XLSX duration, match anomaly events, compute harmonic speed, and clean up UI observers/i18n', async (t) => {
  const { extractModelSteps, summarizeSpeed } = await import('../trajectory-metrics.mjs');
  const { handleAccountCredentialAction } = await import('../backend/account-switch.mjs');
  const {
    getStepSelectionKey,
    computeStepTimingWaterfall,
    filterStepsBySearchAndChip,
  } = await import('../src/core/stepInspector.js');
  const {
    buildStepTimingDiagnostic,
    mergeModelsByDisplayName,
  } = await import('../src/core/formatters.js');
  const {
    buildStepsXlsx,
    buildStepsCsv,
    buildStepsMarkdownReport,
    buildConsumptionXlsx,
  } = await import('../src/core/reportExporter.js');
  const { StepsDetailView, mergeSelectedAgentUnits } = await import('../src/views/StepsDetailView.js');
  const { CustomDateTimePicker } = await import('../src/components/ui/CustomDateTimePicker.js');
  const { CustomNumberInput } = await import('../src/components/ui/CustomNumberInput.js');
  const { SegmentedControl } = await import('../src/components/ui/SegmentedControl.js');
  const { mountWindowOverlay } = await import('../src/components/layout/WindowOverlayShell.js');
  const { WINDOW_OVERLAY_KEY } = await import('../shared/window-bridge-protocol.mjs');
  const { uiStore } = await import('../src/store/uiStore.js');
  const { telemetryStore } = await import('../src/store/telemetryStore.js');
  const { i18nStore, setI18nLanguage } = await import('../src/i18n/index.js');

  function parseZipEntries(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries = new Map();
    let pos = 0;
    while (pos + 30 <= bytes.length && view.getUint32(pos, true) === 0x04034b50) {
      const compSize = view.getUint32(pos + 18, true);
      const nameLen = view.getUint16(pos + 26, true);
      const extraLen = view.getUint16(pos + 28, true);
      const nameStart = pos + 30;
      const dataStart = nameStart + nameLen + extraLen;
      const name = Buffer.from(bytes.subarray(nameStart, nameStart + nameLen)).toString('utf8');
      const text = Buffer.from(bytes.subarray(dataStart, dataStart + compSize)).toString('utf8');
      entries.set(name, text);
      pos = dataStart + compSize;
    }
    return entries;
  }

  // Extract genuine V4 step with nativeTtftSec, nativeStreamSec, thinkingDurationSec, toolCalls, and retryInfos
  const rawSteps = [
    {
      type: 'CORTEX_STEP_TYPE_USER_INPUT',
      metadata: { createdAt: '2026-11-22T10:00:00Z' },
      userInput: { items: [{ text: 'Inspect V4 projected telemetry step' }] },
    },
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: {
        createdAt: '2026-11-22T10:00:01Z',
        completedAt: '2026-11-22T10:00:11.050Z',
        generatorModel: 'MODEL_PLACEHOLDER_M37',
        modelUsage: {
          model: 'MODEL_PLACEHOLDER_M37',
          inputTokens: '4000',
          outputTokens: '200',
          thinkingTokens: '120',
          cacheReadInputTokens: '16000',
        },
        retryInfos: [
          {
            attempt: 1,
            error: 'HTTP 429 Resource Exhausted UniqueQuotaToken777',
            retryDelay: '2.5s',
          },
        ],
      },
      plannerResponse: {
        response: 'Completed',
        thinkingDuration: '8.64s',
        toolCalls: [{ id: 'tc-1', name: 'read_file' }],
      },
    },
  ];
  const generatorMetadata = [
    {
      stepIndices: [1],
      chatModel: {
        usage: {
          model: 'MODEL_PLACEHOLDER_M37',
          inputTokens: '4000',
          outputTokens: '200',
          thinkingOutputTokens: '120',
          cacheReadTokens: '16000',
        },
        timeToFirstToken: '8.32s',
        streamingDuration: '1.73s',
      },
    },
  ];
  const [extracted] = extractModelSteps(rawSteps, generatorMetadata);
  const cascadeUuid = '28a876b9-8b93-4dbd-8c0b-3b6101fc481d';
  const projectedLikeStep = {
    stepIndex: extracted.stepIndex,
    createdAtMs: extracted.createdAtMs,
    isCompactionStep: extracted.isCompactionStep,
    modelKey: extracted.modelKey,
    modelShort: '3.1-pro-h',
    modelLabel: 'Gemini 3.1 Pro (High)',
    modelUpstream: 'gemini-3.1-pro-high-upstream-id',
    responseModel: '',
    modelSource: extracted.modelSource,
    tokPerSec: +(extracted.outputTokens / extracted.totalDurationSec).toFixed(1),
    ttftSec: extracted.nativeTtftSec,
    totalDurationSec: extracted.totalDurationSec,
    nativeStreamSec: extracted.nativeStreamSec,
    thinkingDurationSec: extracted.thinkingDurationSec,
    hasToolCalls: extracted.hasToolCalls,
    selectedSpeedReason: extracted.speedReason,
    anomaly: extracted.anomaly,
    anomalySig: extracted.anomalySig,
    contextTokens: 20200,
    inputTokens: extracted.inputTokens,
    cacheReadTokens: extracted.cacheReadTokens,
    outputTokens: extracted.outputTokens,
    thinkingTokens: extracted.thinkingTokens,
    responseTokens: extracted.responseTokens,
    cacheHitPct: 80,
    costUsd: 0.042,
    agentId: 'main',
    agentCascadeId: cascadeUuid,
    agentLabel: 'Main',
    agentBadge: 'MAIN',
    agentIndex: 0,
    isSubagent: false,
    turnIndex: extracted.turnIndex,
    isTurnStart: extracted.isTurnStart,
    isLatestTurn: true,
    turnPrompt: extracted.turnPrompt,
  };

  // B-04: Anomaly event message, modelKey, and modelUpstream search
  assert.equal(
    filterStepsBySearchAndChip([projectedLikeStep], { query: 'UniqueQuotaToken777' }).length,
    1
  );
  assert.equal(
    filterStepsBySearchAndChip([projectedLikeStep], { query: 'MODEL_PLACEHOLDER_M37' }).length,
    1
  );
  assert.equal(
    filterStepsBySearchAndChip([projectedLikeStep], {
      query: 'gemini-3.1-pro-high-upstream-id',
    }).length,
    1
  );

  // B-02 & B-03: Waterfall, XLSX H2 duration cell, CSV duration, and timing diagnostic parity
  const wf = computeStepTimingWaterfall(projectedLikeStep);
  assert.equal(wf.totalSec, 10.05);
  assert.equal(wf.ttftSec, 8.32);
  assert.equal(wf.streamSec, 1.73);
  assert.equal(wf.thinkingSec, 8.64);

  const xlsxXml = parseZipEntries(buildStepsXlsx([projectedLikeStep], { locale: 'en-US' })).get(
    'xl/worksheets/sheet1.xml'
  );
  assert.match(xlsxXml, /<c r="H2"[^>]*><v>10\.05<\/v><\/c>/);
  assert.match(buildStepsCsv([projectedLikeStep], { includeBom: false }), /,10\.050,/);

  setI18nLanguage('zh-CN');
  const diag = buildStepTimingDiagnostic(projectedLikeStep);
  assert.equal(diag.rows.length, 3);
  assert.match(diag.rows[1].text, /流式返回/);
  assert.match(diag.rows[2].text, /原生思考计时/);
  assert.doesNotMatch(diag.hint, /重叠/);
  assert.match(diag.hint, /含 1 次异常/);

  // B-05: Speed aggregation matches official summarizeSpeed (18.2 tok/s, not 55.0 tok/s) and skips <50 tok short samples
  const stepSlow = {
    measurementVersion: 4,
    isComplete: true,
    isCompactionStep: false,
    speedSampleEligible: true,
    speedReason: null,
    selectedSpeedReason: null,
    stepIndex: 1,
    modelShort: '4-neon',
    modelLabel: 'Gemini 4 Neon',
    outputTokens: 100,
    totalDurationSec: 10,
    totalTokPerSec: 10,
    tokPerSec: 10,
  };
  const stepFast = {
    ...stepSlow,
    stepIndex: 2,
    totalDurationSec: 1,
    totalTokPerSec: 100,
    tokPerSec: 100,
  };
  const stepShort = {
    ...stepSlow,
    stepIndex: 3,
    speedSampleEligible: false,
    speedReason: 'short_sample',
    selectedSpeedReason: 'short_sample',
    outputTokens: 10,
    totalDurationSec: 0.5,
    totalTokPerSec: 20,
    tokPerSec: 20,
  };
  const mSlow = {
    label: 'Gemini 4 Neon',
    shortName: '4-neon',
    rawModel: 'MODEL_A',
    calls: 1,
    outputTokens: 100,
    totalTokens: 100,
    avgTokPerSec: 10,
    speedSummary: summarizeSpeed([stepSlow]),
  };
  const mFast = {
    label: 'Gemini 4 Neon',
    shortName: '4-neon',
    rawModel: 'MODEL_A',
    calls: 1,
    outputTokens: 100,
    totalTokens: 100,
    avgTokPerSec: 100,
    speedSummary: summarizeSpeed([stepFast]),
  };
  const mergedDisplay = mergeModelsByDisplayName(
    [mSlow, { ...mFast, rawModel: 'MODEL_B' }],
    { modelDisplayMode: 'short' }
  );
  assert.equal(mergedDisplay[0].avgTokPerSec, 18.2);
  assert.equal(mergedDisplay[0].speedSummary.tokens, 200);
  assert.equal(mergedDisplay[0].speedSummary.seconds, 11);

  const mergedUnits = mergeSelectedAgentUnits([
    { recentSteps: [stepSlow], modelBreakdown: [mSlow] },
    { recentSteps: [stepFast], modelBreakdown: [mFast] },
  ]);
  assert.equal(mergedUnits.models[0].avgTokPerSec, 18.2);

  const consXlsxXml = parseZipEntries(
    buildConsumptionXlsx(
      { selectedRange: { key: '7d', label: '7d' }, account: { calls: 2, outputTokens: 200 } },
      [
        { ...mSlow, label: 'Slow', shortName: 'slow' },
        { ...mFast, label: 'Fast', shortName: 'fast' },
      ],
      { locale: 'en-US' }
    )
  ).get('xl/worksheets/sheet2.xml');
  assert.match(consXlsxXml, /<c r="I4"[^>]*><v>18\.2<\/v><\/c>/);
  assert.match(
    buildStepsMarkdownReport([stepSlow, stepFast, stepShort], { locale: 'en-US' }),
    /\*\*Avg Speed\*\*: 18\.2 tok\/s/
  );

  // B-01 & B-07 DOM checks: click real projected step opens drawer + i18n controls + WindowOverlayShell ResizeObserver cleanup
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevRo = globalThis.ResizeObserver;
  const prevMo = globalThis.MutationObserver;
  const prevUi = uiStore.getState();
  const prevTel = telemetryStore.getState();
  const prevLocale = i18nStore.getState().language;

  const { document } = createMockDom();
  globalThis.document = document;
  let activeResizeObservers = 0;
  globalThis.ResizeObserver = class {
    constructor() {
      this.connected = false;
    }
    observe() {
      if (!this.connected) {
        this.connected = true;
        activeResizeObservers += 1;
      }
    }
    unobserve() {}
    disconnect() {
      if (this.connected) {
        this.connected = false;
        activeResizeObservers -= 1;
      }
    }
  };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
  };

  let stepsView = null;
  let overlay = null;
  t.after(() => {
    stepsView?.destroy?.();
    overlay?.dispose?.();
    uiStore.setState(prevUi, { sync: true });
    telemetryStore.setState(prevTel, { sync: true });
    setI18nLanguage(prevLocale);
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.ResizeObserver = prevRo;
    globalThis.MutationObserver = prevMo;
  });

  uiStore.setState({ activeView: 'steps', stepsSubTab: 'steps', monitorVisible: true }, { sync: true });
  telemetryStore.setState(
    {
      telemetry: {
        settings: { stepTableColumns: ['step', 'model', 'tps', 'duration', 'cost'] },
        activeConversation: {
          cascadeId: cascadeUuid,
          stepCount: 1,
          recentSteps: [projectedLikeStep],
          modelBreakdown: [],
        },
      },
    },
    { sync: true }
  );
  stepsView = StepsDetailView();
  document.body.appendChild(stepsView.el);
  assert.equal(
    getStepSelectionKey(projectedLikeStep, cascadeUuid),
    `${cascadeUuid}-${projectedLikeStep.stepIndex}`
  );
  const tr = stepsView.el.querySelectorAll('tbody tr')[0];
  assert.ok(tr, 'projected step row rendered');
  assert.equal(Boolean(tr.onclick), false, 'clicking step row does not trigger diagnostic drawer');
  assert.equal(stepsView.el.querySelector('.step-inspector-drawer'), null);
  stepsView.destroy();
  stepsView = null;

  // B-07 i18n reactive switching
  setI18nLanguage('en-US');
  const dt = CustomDateTimePicker({ modelValue: Date.UTC(2026, 10, 22, 12, 30) });
  const num = CustomNumberInput({ modelValue: 5 });
  const seg = SegmentedControl({ options: [{ label: 'A', value: 'a' }], modelValue: 'a' });
  assert.equal(dt.el.querySelector('.dt-weekdays').textContent, 'MoTuWeThFrSaSu');
  assert.equal(dt.el.querySelector('.dt-time-row .text-muted').textContent, 'Hr / Min');
  assert.equal(num.el.querySelectorAll('.num-step-btn')[0].getAttribute('aria-label'), 'Decrease value');
  assert.equal(seg.el.getAttribute('aria-label'), 'Segmented switcher');
  setI18nLanguage('zh-CN');
  await Promise.resolve();
  assert.equal(dt.el.querySelector('.dt-weekdays').textContent, '一二三四五六日');
  assert.equal(dt.el.querySelector('.dt-time-row .text-muted').textContent, '时 / 分');
  dt.destroy();
  num.destroy();
  seg.destroy();

  // B-07 WindowOverlayShell dispose cleans up multiRunningWidget subScroll ResizeObserver
  const roBaseline = activeResizeObservers;
  globalThis.window[WINDOW_OVERLAY_KEY] = { isMultiPinnedOpen: () => true, dispose() {} };
  overlay = mountWindowOverlay();
  telemetryStore.setState(
    {
      telemetry: {
        settings: {},
        runningConversations: [
          {
            cascadeId: 'run-ro-1',
            title: 'Swarm Run',
            isMainRunning: true,
            subagentCount: 1,
            runningSubagentCount: 1,
            subagents: [{ cascadeId: 'sub-ro-1', isRunning: true, stepCount: 2 }],
          },
        ],
        activeConversation: { cascadeId: 'run-ro-1', recentSteps: [], modelBreakdown: [] },
      },
    },
    { sync: true }
  );
  overlay.dispose();
  overlay = null;
  assert.equal(activeResizeObservers, roBaseline);

  // B-07 account-switch honors ANTIGRAVITY_GEMINI_DIR
  const prevGemEnv = process.env.ANTIGRAVITY_GEMINI_DIR;
  process.env.ANTIGRAVITY_GEMINI_DIR = 'D:\\CustomGeminiVerify';
  try {
    let seenFallbacks = [];
    await handleAccountCredentialAction(
      { action: 'list' },
      {
        platform: 'win32',
        store: async (cfg) => {
          seenFallbacks = cfg.fallbacks || [];
          return { accounts: [], selectedEmail: '' };
        },
      }
    );
    assert.equal(seenFallbacks.every((p) => p.startsWith('D:\\CustomGeminiVerify')), true);
  } finally {
    if (prevGemEnv === undefined) delete process.env.ANTIGRAVITY_GEMINI_DIR;
    else process.env.ANTIGRAVITY_GEMINI_DIR = prevGemEnv;
  }
});

test('P1 regression: O(1) lowercase cache index, SQLite live-tail/parent helpers, lazy App mount, adoptedStyleSheets, rAF observer coalescing, and chart DOMRect caching', async (t) => {
  const {
    getCachedTrajectoryEntryByLower,
    removeCachedTrajectory,
    setCachedTrajectory,
  } = await import('../backend/config.mjs');
  const { mountWindowOverlay } = await import('../src/components/layout/WindowOverlayShell.js');
  const { WINDOW_BRIDGE_KEY } = await import('../shared/window-bridge-protocol.mjs');
  const { createSessionLineChart } = await import('../src/components/charts/SessionStepCharts.js');
  const { createTrendAreaChart } = await import('../src/components/charts/TrendAreaChart.js');
  const { uiStore } = await import('../src/store/uiStore.js');
  const { telemetryStore } = await import('../src/store/telemetryStore.js');

  // 1. O(1) case-insensitive trajectory cache index replaces mixed-case keys cleanly
  const upperId = 'ABCDEF12-3456-4789-8ABC-DEF123456789';
  const lowerId = upperId.toLowerCase();
  try {
    setCachedTrajectory(upperId, { signature: 'v1', steps: [{ stepIndex: 1 }] });
    const hit1 = getCachedTrajectoryEntryByLower(lowerId);
    assert.equal(hit1?.id, upperId);
    assert.equal(hit1?.entry?.steps?.length, 1);

    setCachedTrajectory(lowerId, { signature: 'v2', steps: [{ stepIndex: 1 }, { stepIndex: 2 }] });
    const hit2 = getCachedTrajectoryEntryByLower(upperId);
    assert.equal(hit2?.id, lowerId);
    assert.equal(hit2?.entry?.steps?.length, 2);
  } finally {
    removeCachedTrajectory(upperId);
    removeCachedTrajectory(lowerId);
  }

  // 2. WindowOverlayShell lazy App() mount, shared CSSStyleSheet, and rAF MutationObserver coalescing
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevRo = globalThis.ResizeObserver;
  const prevMo = globalThis.MutationObserver;
  const prevCssSheet = globalThis.CSSStyleSheet;
  const prevUi = uiStore.getState();
  const prevTel = telemetryStore.getState();

  const { document } = createMockDom();
  const origAttachShadow = document.createElement('div').constructor.prototype.attachShadow;
  globalThis.document = document;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  let bodyObserverCb = null;
  globalThis.MutationObserver = class {
    constructor(cb) {
      this.cb = cb;
    }
    observe(target, opts) {
      if (target === document.body && opts?.subtree) {
        bodyObserverCb = this.cb;
      }
    }
    disconnect() {}
  };
  class MockCSSStyleSheet {
    constructor() {
      this.cssText = '';
    }
    replaceSync(text) {
      this.cssText = text;
    }
  }
  globalThis.CSSStyleSheet = MockCSSStyleSheet;

  // Give Mock ShadowRoots adoptedStyleSheets array support
  const sampleDiv = document.createElement('div');
  const proto = Object.getPrototypeOf(sampleDiv);
  proto.attachShadow = function (init) {
    const sr = origAttachShadow.call(this, init);
    sr.adoptedStyleSheets = [];
    return sr;
  };

  const rafQueue = [];
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 800,
    [WINDOW_BRIDGE_KEY]: {
      port: 19888,
      token: 'p1-tok',
      bundleVersion: '1',
      stylesCss: '/* --- src/styles/tokens.css --- */\n:host { color: inherit; }',
    },
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (fn) => {
      rafQueue.push(fn);
      return rafQueue.length;
    },
    cancelAnimationFrame: () => {},
  };

  let ov = null;
  t.after(() => {
    ov?.dispose?.();
    proto.attachShadow = origAttachShadow;
    uiStore.setState(prevUi, { sync: true });
    telemetryStore.setState(prevTel, { sync: true });
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.ResizeObserver = prevRo;
    globalThis.MutationObserver = prevMo;
    globalThis.CSSStyleSheet = prevCssSheet;
  });

  ov = mountWindowOverlay();
  const capsuleHost = document.getElementById('ag-usage-monitor-capsule');
  const portalHost = document.getElementById('ag-usage-monitor-portal');
  const popoverEl = portalHost.shadowRoot.querySelector('.wm-popover-panel');

  // Cold start: App() is NOT mounted yet, and both ShadowRoots share the exact same CSSStyleSheet object!
  assert.equal(popoverEl.children.length, 0, 'App() stays unmounted on cold start');
  assert.equal(capsuleHost.shadowRoot.adoptedStyleSheets.length, 1);
  assert.equal(
    capsuleHost.shadowRoot.adoptedStyleSheets[0],
    portalHost.shadowRoot.adoptedStyleSheets[0],
    'Capsule and Portal ShadowRoots share single CSSStyleSheet instance'
  );

  // Opening popover mounts App() on demand
  ov.open();
  assert.equal(popoverEl.children.length, 1, 'App() mounts immediately on first open()');

  // 20 streaming DOM mutations coalesce into 0 synchronous scans and 1 rAF flush
  let qsCalls = 0;
  const origQs = document.querySelector.bind(document);
  document.querySelector = (s) => {
    qsCalls += 1;
    return origQs(s);
  };
  for (let i = 0; i < 20; i += 1) {
    bodyObserverCb?.([{ target: document.body, type: 'childList' }]);
  }
  assert.equal(qsCalls, 0, 'Zero synchronous DOM queries during streaming burst');
  while (rafQueue.length > 0) rafQueue.shift()();
  assert.ok(qsCalls > 0 && qsCalls <= 10, `Coalesced into single frame check (calls=${qsCalls})`);
  document.querySelector = origQs;

  // 3. Chart mousemove DOMRect caching & preSig fast path
  const stepChart = createSessionLineChart();
  document.body.appendChild(stepChart.el);
  let stepBcr = 0;
  const stepSvg = stepChart.el.querySelector('svg');
  stepSvg.getBoundingClientRect = () => {
    stepBcr += 1;
    return { left: 0, top: 0, width: 400, height: 140 };
  };
  const stepData = [
    { stepIndex: 1, modelShort: '4-neon', tokPerSec: 60, outputTokens: 120, inputTokens: 1000, cacheReadTokens: 2000 },
    { stepIndex: 2, modelShort: '4-neon', tokPerSec: 80, outputTokens: 160, inputTokens: 1100, cacheReadTokens: 2200 },
  ];
  const r1 = stepChart.update({ steps: stepData, metric: 'tps' });
  const r2 = stepChart.update({ steps: stepData, metric: 'tps' });
  assert.equal(r1.summaryBadge, r2.summaryBadge, 'preSig fast-path preserves summaryBadge');
  stepBcr = 0;
  for (let i = 0; i < 30; i += 1) {
    stepSvg.parentNode.dispatchEvent({ type: 'mousemove', clientX: 40 + i * 5, clientY: 50 });
  }
  assert.equal(stepBcr, 1, 'SessionLineChart caches SVG DOMRect across mousemove burst');
  stepSvg.parentNode.dispatchEvent({ type: 'mouseleave' });
  stepSvg.parentNode.dispatchEvent({ type: 'mousemove', clientX: 60, clientY: 50 });
  assert.equal(stepBcr, 2, 'mouseleave invalidates cached SVG DOMRect cleanly');
  stepChart.destroy();

  const trendChart = createTrendAreaChart();
  document.body.appendChild(trendChart.el);
  let trendBcr = 0;
  const rectStub = () => {
    trendBcr += 1;
    return { left: 0, top: 0, width: 400, height: 140 };
  };
  trendChart.el.getBoundingClientRect = rectStub;
  const trendSvg = trendChart.el.querySelector('svg');
  trendSvg.getBoundingClientRect = rectStub;
  trendChart.update({
    series: [
      { label: '10:00', fullLabel: '10:00', tokens: 5000, calls: 1 },
      { label: '11:00', fullLabel: '11:00', tokens: 8000, calls: 2 },
    ],
    rangeKey: '24h',
  });
  trendBcr = 0;
  for (let i = 0; i < 30; i += 1) {
    trendSvg.parentNode.dispatchEvent({ type: 'mousemove', clientX: 30 + i * 5, clientY: 50 });
  }
  assert.equal(trendBcr, 2, 'TrendAreaChart caches svgRect and wrapRect across mousemove burst');
  trendChart.destroy();
});

test('P2 regressions: bundler regex-after-paren lexer, shared URI/prompt/atomic primitives, zero-ResizeObserver ToggleSwitch, SearchInput, and declarative settingsBackup parity', async (t) => {
  const [{ stripModuleSyntax }, { decodeWorkspaceFileUriToPath, parseWorkspaceUrisColumn }, { extractShortPromptTitle }, { writeJsonAtomicSync }] =
    await Promise.all([
      import('../scripts/build-bundle.mjs'),
      import('../shared/workspace-uri.mjs'),
      import('../shared/prompt-clean.mjs'),
      import('../backend/fs-atomic.mjs'),
    ]);

  // 1. Bundler lexer handles regex literals with unbalanced braces after if/while/for-await parens
  const sampleMod = [
    'export function f(c, s) { if (c) /a{b/.test(s); }',
    'export const afterFn = 42;',
    'export function g(x) { while (x) /c}d/.test(x); }',
    'export const afterG = 99;',
    'export async function h(it) { for await (const x of it) /e{f/.test(x); }',
    'export const divOk = (10 + 2) / (3 + 1);',
    'const localHidden = 7;',
    'export { localHidden as publicAlias };',
  ].join('\n');
  const recordedExports = [];
  const stripped = stripModuleSyntax(sampleMod, null, (exported, isClause, local) => {
    recordedExports.push({ exported, isClause, local });
  });
  assert.equal(/\bexport\b/.test(stripped), false, 'no raw export keyword remains after regex-after-paren');
  assert.deepEqual(
    recordedExports.find((e) => e.exported === 'publicAlias'),
    { exported: 'publicAlias', isClause: true, local: 'localHidden' }
  );

  // 2. Shared workspace URI & prompt cleaner & atomic JSON writer
  assert.equal(decodeWorkspaceFileUriToPath('file:///f%3A/ppt/demo/'), 'f:/ppt/demo');
  assert.equal(decodeWorkspaceFileUriToPath('file:///Users/dev/app/'), '/Users/dev/app');
  assert.deepEqual(parseWorkspaceUrisColumn('["file:///f%3A/ppt/a",""]'), ['file:///f%3A/ppt/a']);
  assert.equal(
    extractShortPromptTitle(
      '<CONTEXT_SUMMARY>old</CONTEXT_SUMMARY><USER_REQUEST>继续P2\n优化代码</USER_REQUEST><ADDITIONAL_METADATA>t</ADDITIONAL_METADATA>',
      48,
      { firstLineOnly: true }
    ),
    '继续P2'
  );
  const fsCalls = [];
  writeJsonAtomicSync('/cfg/settings.json', { ok: true }, {
    fsOps: {
      mkdirFn: () => fsCalls.push('mkdir'),
      writeFn: (p) => fsCalls.push(`write:${p.endsWith('.json') ? 'direct' : 'tmp'}`),
      renameFn: () => fsCalls.push('rename'),
      unlinkFn: () => fsCalls.push('unlink'),
    },
  });
  assert.deepEqual(fsCalls, ['mkdir', 'write:tmp', 'rename']);

  // 3. ToggleSwitch creates 0 ResizeObservers & SearchInput wires clear/input cleanly
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevRO = globalThis.ResizeObserver;
  const { document } = createMockDom();
  let roCreated = 0;
  globalThis.document = document;
  globalThis.window = { document, addEventListener() {}, removeEventListener() {} };
  globalThis.ResizeObserver = class {
    constructor() {
      roCreated += 1;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  t.after(() => {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.ResizeObserver = prevRO;
  });

  const [{ ToggleSwitch }, { createSearchInput }, { buildExportableSettingsJson, parseImportedSettingsJson }] =
    await Promise.all([
      import('../src/components/ui/ToggleSwitch.js'),
      import('../src/components/ui/SearchInput.js'),
      import('../src/core/settingsBackup.js'),
    ]);

  let toggledVal = 'off';
  const sw = ToggleSwitch({
    preset: 'enable',
    modelValue: 'off',
    onUpdateModelValue: (v) => {
      toggledVal = v;
    },
  });
  assert.equal(roCreated, 0, 'ToggleSwitch must not allocate any ResizeObserver');
  assert.equal(sw.el.style.getPropertyValue('--seg-active-idx'), '1');
  sw.el.querySelectorAll('.seg-btn')[0].dispatchEvent({ type: 'click', stopPropagation() {} });
  assert.equal(toggledVal, 'on');
  assert.equal(sw.el.style.getPropertyValue('--seg-active-idx'), '0');
  sw.destroy();

  let latestQuery = '';
  const sBox = createSearchInput({
    wrapClassName: 'steps-search-wrap',
    placeholder: 'Search',
    onInput: (v) => {
      latestQuery = v;
    },
  });
  sBox.inputEl.value = '429';
  sBox.inputEl.dispatchEvent({ type: 'input', target: sBox.inputEl });
  assert.equal(latestQuery, '429');
  assert.equal(sBox.clearBtnEl.hasAttribute('hidden'), false);
  sBox.clearBtnEl.dispatchEvent({ type: 'click', stopPropagation() {} });
  assert.equal(latestQuery, '');
  assert.equal(sBox.clearBtnEl.hasAttribute('hidden'), true);

  // 4. Declarative settingsBackup round-trips all 47 portable keys + coupled legacy flags
  const exported = buildExportableSettingsJson({
    language: 'en-US',
    displayCurrency: 'MYR',
    modernUi: false,
    modelDisplayMode: 'upstream_compact',
    pluginUpdateMode: 'auto',
    windowMountMode: 'composer',
    vsCodeMountMode: 'dual',
    enableSafetyMonitor: true,
    topbarMultiSessionMode: 'running_only',
    hoverSyncOverviewMetrics: false,
    hoverMetricRows: 2,
    hoverMetricSizes: { tps: 'tall', cache_hit: 'wide' },
    hoverMetricTextMode: 'none',
    hoverMetrics: ['tps', 'cache_hit', 'ttft', 'step_cost'],
    overviewMetricRows: 2,
    overviewMetricSizes: { tps: 'tall' },
    overviewMetricTextMode: 'sub',
    quotaDisplayMode: 'remaining',
    showStepFilterToolbar: true,
    experimentalQuotaReservation: true,
    accountQuotaRefreshMinutes: 180,
  });
  const parsedExport = JSON.parse(exported);
  assert.equal(Object.keys(parsedExport.settings).length, 47);
  assert.equal(parsedExport.settings.enableSafetyMonitor, true);
  assert.equal(parsedExport.settings.displayCurrency, 'MYR');
  assert.equal(parsedExport.settings.quotaDisplayMode, 'remaining');
  assert.equal(parsedExport.settings.vsCodeMountMode, 'dual');
  assert.equal(parsedExport.settings.topbarMultiSessionMode, 'running_only');
  assert.equal(parsedExport.settings.showTopbarMultiSession, true);
  assert.equal(parsedExport.settings.hoverMetricRows, 2);
  assert.deepEqual(parsedExport.settings.hoverMetricSizes, { tps: 'tall', cache_hit: 'wide' });
  assert.equal(parsedExport.settings.hoverMetricTextMode, 'none');
  assert.equal(parsedExport.settings.hoverMetricStyle, 'hybrid');
  assert.equal(parsedExport.settings.overviewMetricRows, 2);
  assert.deepEqual(parsedExport.settings.overviewMetricSizes, { tps: 'tall' });
  assert.equal(parsedExport.settings.overviewMetricTextMode, 'sub');
  assert.equal(parsedExport.settings.overviewMetricStyle, 'hybrid');
  assert.equal('orchestratorIdMode' in parsedExport.settings, false);
  const reimported = parseImportedSettingsJson(
    JSON.stringify({
      ...parsedExport,
      settings: { ...parsedExport.settings, orchestratorIdMode: 'full' },
    })
  );
  assert.equal(reimported.ok, true);
  assert.equal('orchestratorIdMode' in reimported.patch, false);
  assert.equal(reimported.patch.vsCodeMountMode, 'dual');
  assert.equal(reimported.patch.topbarMultiSessionMode, 'running_only');
  assert.equal(reimported.patch.showTopbarMultiSession, true);
  const legacyMultiImport = parseImportedSettingsJson(
    JSON.stringify({
      schemaVersion: parsedExport.schemaVersion,
      settings: { showTopbarMultiSession: false },
    })
  );
  assert.equal(legacyMultiImport.ok, true);
  assert.equal(legacyMultiImport.patch.topbarMultiSessionMode, 'hide');
  assert.equal(legacyMultiImport.patch.showTopbarMultiSession, false);
  assert.equal(reimported.patch.hoverSyncOverviewMetrics, false);
  assert.equal(reimported.patch.hoverMetricRows, 2);
  assert.deepEqual(reimported.patch.hoverMetricSizes, { tps: 'tall', cache_hit: 'wide' });
  assert.equal(reimported.patch.hoverMetricTextMode, 'none');
  assert.equal(reimported.patch.hoverMetricStyle, 'hybrid');
  assert.deepEqual(reimported.patch.hoverMetrics, ['tps', 'cache_hit', 'ttft', 'step_cost']);
  assert.equal(reimported.patch.overviewMetricRows, 2);
  assert.deepEqual(reimported.patch.overviewMetricSizes, { tps: 'tall' });
  assert.equal(reimported.patch.overviewMetricTextMode, 'sub');
  assert.equal(reimported.patch.overviewMetricStyle, 'hybrid');
  const legacyBentoImport = parseImportedSettingsJson(
    JSON.stringify({
      hoverMetricStyle: 'mixed',
      hoverMetrics: ['cache_hit', 'ttft', 'avg_tps', 'step_cost'],
      overviewMetricStyle: 'large',
      overviewMetrics: ['tps', 'ttft', 'avg_tps'],
    })
  );
  assert.equal(legacyBentoImport.ok, true);
  assert.equal(legacyBentoImport.patch.hoverMetricRows, 2);
  assert.deepEqual(legacyBentoImport.patch.hoverMetricSizes, { cache_hit: 'tall' });
  assert.equal(legacyBentoImport.patch.hoverMetricStyle, 'hybrid');
  assert.equal(legacyBentoImport.patch.overviewMetricRows, 1);
  assert.deepEqual(legacyBentoImport.patch.overviewMetricSizes, {
    tps: 'third',
    ttft: 'third',
    avg_tps: 'third',
  });
  assert.equal(legacyBentoImport.patch.overviewMetricStyle, 'large');
  assert.equal(reimported.patch.quotaDisplayMode, 'remaining');
  assert.equal(reimported.patch.modernUi, false);
  assert.equal(reimported.patch.experimentalModernUi, false);
  assert.equal(reimported.patch.modelDisplayMode, 'upstream_compact');
  assert.equal(reimported.patch.showUpstreamModel, true);
  assert.equal(reimported.patch.pluginUpdateMode, 'auto');
  assert.equal(reimported.patch.autoUpdatePlugin, true);
  assert.equal(reimported.patch.windowMountMode, 'composer');
  assert.equal(reimported.patch.enableWindowOverlay, true);
  assert.equal(reimported.patch.showStepFilterToolbar, true);
  assert.equal(reimported.patch.experimentalQuotaReservation, true);
  assert.equal(reimported.patch.enableSafetyMonitor, true);
  assert.equal(reimported.patch.accountQuotaRefreshMinutes, 180);
});

test('Feature 16: P3 extracted sub-modules (stepChartMath, overlayHostAnchors, ConsumptionBreakdownRows) and doc-to-code parity guard', async (t) => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    location: { pathname: '/' },
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
  };
  t.after(() => {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  const [
    { computeLinearFit, computeNiceYScale, buildSplinePath },
    { computeCapsuleLayoutMode },
    { partitionModelSegments },
    { DEFAULT_SETTINGS_SCHEMA },
    { BRIDGE_API_ROUTE_DEFS },
    fsMod,
    pathMod,
    urlMod,
  ] = await Promise.all([
    import('../src/components/charts/stepChartMath.js'),
    import('../src/components/layout/overlayHostAnchors.js'),
    import('../src/components/widgets/ConsumptionBreakdownRows.js'),
    import('../backend/settings-schema.mjs'),
    import('../shared/window-bridge-protocol.mjs'),
    import('node:fs'),
    import('node:path'),
    import('node:url'),
  ]);

  // 1. Extracted chart math + layout hysteresis + model segment partition
  const fit = computeLinearFit([20, 30, 40], { xs: [1000, 2000, 3000] });
  assert.ok(fit && Math.abs(fit.slope - 0.01) < 1e-6);
  const scale = computeNiceYScale(0, 93, 4);
  assert.ok(scale.max >= 93 && scale.ticks.length >= 2);
  assert.match(buildSplinePath([{ x: 0, y: 10 }, { x: 20, y: 30 }, { x: 40, y: 15 }]), /^M/);

  assert.equal(computeCapsuleLayoutMode(380, 'wide', { slotCount: 3 }), 'wide');
  assert.equal(computeCapsuleLayoutMode(260, 'wide', { slotCount: 3 }), 'wide');
  assert.equal(computeCapsuleLayoutMode(260, 'compact', { slotCount: 3 }), 'compact');
  assert.equal(computeCapsuleLayoutMode(70, 'minimal', { slotCount: 3 }), 'ring-only');

  const segs = partitionModelSegments(
    [
      { label: '4-neon', totalTokens: 700 },
      { label: '4-argon', totalTokens: 300 },
    ],
    new Map()
  );
  assert.equal(segs.length, 2);
  assert.equal(Math.round(segs[0].pct + segs[1].pct), 100);

  // 2. Repo documentation parity against live schema & route definitions
  // Note: `docs/` and `plan/` are local engineering directories (.gitignore); guard with existsSync so fresh CI clones pass cleanly while local dev enforces 100% parity.
  const repoRoot = pathMod.resolve(pathMod.dirname(urlMod.fileURLToPath(import.meta.url)), '..', '..', '..');
  assert.ok(fsMod.existsSync(pathMod.join(repoRoot, 'CHANGELOG.md')), 'Root CHANGELOG.md must exist');
  const readmeEn = fsMod.readFileSync(pathMod.join(repoRoot, 'README.md'), 'utf8');
  const readmeZh = fsMod.readFileSync(pathMod.join(repoRoot, 'README.zh-CN.md'), 'utf8');
  assert.ok(readmeEn.includes('defineComponent') && !readmeEn.includes('native Web Components'));
  assert.ok(readmeZh.includes('defineComponent') && !readmeZh.includes('原生 Web Components'));

  const docsDir = pathMod.join(repoRoot, 'docs');
  if (fsMod.existsSync(docsDir)) {
    const settingsDoc = fsMod.readFileSync(pathMod.join(docsDir, 'settings-and-cli.md'), 'utf8');
    for (const key of Object.keys(DEFAULT_SETTINGS_SCHEMA)) {
      assert.ok(settingsDoc.includes(`\`${key}\``), `docs/settings-and-cli.md must document setting key: ${key}`);
    }

    const apiDoc = fsMod.readFileSync(pathMod.join(docsDir, 'backend-and-api.md'), 'utf8');
    for (const route of BRIDGE_API_ROUTE_DEFS) {
      assert.ok(
        apiDoc.includes(`${route.method} ${route.path}`),
        `docs/backend-and-api.md must document route: ${route.method} ${route.path}`
      );
    }
    for (const requiredModule of [
      'cloudcode-proxy.mjs',
      'quota-reservation.mjs',
      'fs-atomic.mjs',
      'trajectory-cache-store.mjs',
      '.xlsx',
    ]) {
      assert.ok(apiDoc.includes(requiredModule), `docs/backend-and-api.md must cover ${requiredModule}`);
    }

    const feDoc = fsMod.readFileSync(pathMod.join(docsDir, 'frontend-core-and-store.md'), 'utf8');
    assert.ok(feDoc.includes('xlsxBuilder.js') && feDoc.includes('exportBinaryFileWithFeedback'));
  }

  const legacyPlanPath = pathMod.join(repoRoot, 'plan', 'code-audit-and-cleanup-plan.md');
  if (fsMod.existsSync(legacyPlanPath)) {
    const legacyPlan = fsMod.readFileSync(legacyPlanPath, 'utf8');
    assert.match(legacyPlan, /ARCHIVED/);
  }
});

test('Issue #62: accountQuotaRefreshMinutes supports 0 (Off) after 24h, preserves falsy defaults, round-trips backup, and blocks automatic saved-account quota polling', async (t) => {
  const {
    ACCOUNT_QUOTA_REFRESH_MINUTES,
    DEFAULT_ACCOUNT_QUOTA_REFRESH_MINUTES,
    normalizeAccountQuotaRefreshMinutes,
  } = await import('../shared/settings-normalization.mjs');
  const { setI18nLanguage } = await import('../src/i18n/index.js');
  const { SettingsAccountTab } = await import('../src/views/settings/SettingsAccountTab.js');

  assert.deepEqual([...ACCOUNT_QUOTA_REFRESH_MINUTES], [10, 30, 60, 180, 360, 720, 1440, 0]);
  assert.equal(normalizeAccountQuotaRefreshMinutes(0), 0);
  assert.equal(normalizeAccountQuotaRefreshMinutes('0'), 0);
  assert.equal(normalizeAccountQuotaRefreshMinutes('off'), 0);
  assert.equal(normalizeAccountQuotaRefreshMinutes('disabled'), 0);
  assert.equal(normalizeAccountQuotaRefreshMinutes('none'), 0);
  for (const bad of [undefined, null, '', '   ', false, true, -1, 999, NaN]) {
    assert.equal(
      normalizeAccountQuotaRefreshMinutes(bad),
      DEFAULT_ACCOUNT_QUOTA_REFRESH_MINUTES,
      `falsy/invalid ${String(bad)} must not accidentally map to 0 (Off)`
    );
  }

  // Portable backup preserves accountQuotaRefreshMinutes = 0
  const exportedOff = buildExportableSettingsJson({ accountQuotaRefreshMinutes: 0 });
  const parsedOff = parseImportedSettingsJson(exportedOff);
  assert.equal(parsedOff.ok, true);
  assert.equal(parsedOff.patch.accountQuotaRefreshMinutes, 0);

  // Component check: 0 (Off) appears immediately after 24h and suppresses automatic quota fetches while keeping manual click functional
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevFetch = globalThis.fetch;
  const { document } = createMockDom();
  const apiCalls = [];
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 1024,
    innerHeight: 768,
    location: { pathname: '/', href: 'http://127.0.0.1:41234/' },
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
  };
  const makeJsonRes = (payload) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  });
  globalThis.fetch = async (url, opts = {}) => {
    const urlStr = String(url);
    const body = opts?.body ? JSON.parse(opts.body) : {};
    apiCalls.push({ url: urlStr, method: opts?.method || 'GET', body });
    if (urlStr.includes('/api/accounts') && !urlStr.includes('/api/accounts/update')) {
      return makeJsonRes({
        ok: true,
        supported: true,
        riskLocked: false,
        actionNonce: 'nonce-62',
        accounts: ['active@example.com', 'backup@example.com'],
        quotas: {
          'backup@example.com': {
            pools: [],
            fetchedAt: 0,
          },
        },
        security: { enabled: false, unlocked: true },
      });
    }
    if (urlStr.includes('/api/accounts/update') && body.action === 'quota') {
      return makeJsonRes({
        ok: true,
        actionNonce: 'nonce-62',
        pools: [{ poolKey: 'gemini', poolLabel: 'Gemini', remainingPct: 80 }],
        fetchedAt: Date.now(),
      });
    }
    return makeJsonRes({ ok: true });
  };
  t.after(() => {
    setI18nLanguage('zh-CN');
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.fetch = prevFetch;
  });

  setI18nLanguage('zh-CN');
  const tab = SettingsAccountTab({
    initialSettings: {
      accountSwitchRiskAccepted: true,
      accountQuotaRefreshMinutes: 0,
    },
  });
  try {
    tab.refs.renderAccount(
      { status: 'signedIn', email: 'active@example.com' },
      { pools: [] },
      { accountSwitchRiskAccepted: true, accountQuotaRefreshMinutes: 0 }
    );
    const selectTrigger = tab.el.querySelector('.account-refresh-select .select-trigger');
    assert.ok(selectTrigger, 'Refresh interval CustomSelect exists');
    assert.equal(selectTrigger.textContent.trim(), '关闭', 'Model value 0 renders localized Off label');
    selectTrigger.dispatchEvent({ type: 'click', stopPropagation() {} });
    const opts = tab.el.querySelectorAll('.account-refresh-select .select-option');
    const optValues = opts.map((el) => el.getAttribute('data-value'));
    const optLabels = opts.map((el) => el.querySelector('.select-option-text')?.textContent?.trim());
    assert.deepEqual(optValues, ['10', '30', '60', '180', '360', '720', '1440', '0']);
    assert.equal(optLabels[optLabels.length - 2], '24 小时');
    assert.equal(optLabels[optLabels.length - 1], '关闭');

    await tab.refs.load();
    await new Promise((r) => setTimeout(r, 30));
    const autoQuotaCalls = apiCalls.filter((c) => c.body?.action === 'quota');
    assert.equal(autoQuotaCalls.length, 0, 'With refreshMinutes=0, load/list must not trigger automatic quota polling');

    // Explicit manual click on saved account refresh button still works
    const manualBtn = tab.el
      .querySelectorAll('.settings-account-load-quota')
      .find((el) => !el.hasAttribute('hidden'));
    assert.ok(manualBtn, 'Manual per-account refresh button remains available');
    manualBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    const manualQuotaCalls = apiCalls.filter((c) => c.body?.action === 'quota');
    assert.equal(manualQuotaCalls.length, 1, 'Explicit manual refresh button still queries quota on demand');
    assert.equal(manualQuotaCalls[0].body.email, 'backup@example.com');
  } finally {
    tab.destroy();
  }
});

test('Issue #60: enableSafetyMonitor defaults off, mounts native SafetyMonitorCard in ConsumptionView, and persists opt-in toggle', async (t) => {
  const [
    { DEFAULT_ENABLE_SAFETY_MONITOR, normalizeEnableSafetyMonitor },
    { DEFAULT_SETTINGS_SCHEMA, normalizeFullSettings },
    { QuotaPoolsWidget },
    { SafetyMonitorCard, resolveSafetyMonitorAlert },
  ] = await Promise.all([
    import('../shared/settings-normalization.mjs'),
    import('../backend/settings-schema.mjs'),
    import('../src/components/widgets/QuotaPoolsWidget.js'),
    import('../src/components/widgets/SafetyMonitorCard.js'),
  ]);

  assert.equal(DEFAULT_ENABLE_SAFETY_MONITOR, false);
  assert.equal(DEFAULT_SETTINGS_SCHEMA.enableSafetyMonitor, false);
  assert.equal(normalizeEnableSafetyMonitor(undefined), false);
  assert.equal(normalizeEnableSafetyMonitor(null), false);
  assert.equal(normalizeEnableSafetyMonitor(''), false);
  assert.equal(normalizeEnableSafetyMonitor(false), false);
  assert.equal(normalizeEnableSafetyMonitor('false'), false);
  assert.equal(normalizeEnableSafetyMonitor('0'), false);
  assert.equal(normalizeEnableSafetyMonitor('off'), false);
  assert.equal(normalizeEnableSafetyMonitor('on'), true);
  assert.equal(normalizeEnableSafetyMonitor(true), true);
  assert.equal(normalizeFullSettings({ enableSafetyMonitor: true }).enableSafetyMonitor, true);
  assert.equal(normalizeFullSettings({}).enableSafetyMonitor, false);

  assert.equal(resolveSafetyMonitorAlert({ has429Fallback: true, hasHeavyBurst: true }), 'fallback429');
  assert.equal(resolveSafetyMonitorAlert({ hasHeavyBurst: true, nearFlashLiteLimit: true }), 'heavyBurst');
  assert.equal(resolveSafetyMonitorAlert({ nearFlashLiteLimit: true }), 'nearLimit');
  assert.equal(resolveSafetyMonitorAlert({}), '');

  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevFetch = globalThis.fetch;
  const prevLocale = i18nStore.getState().locale;
  const { document } = createMockDom();
  const savedPatches = [];
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 1024,
    innerHeight: 768,
    location: { pathname: '/', href: 'http://127.0.0.1:41234/' },
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
  };
  globalThis.fetch = async (url, opts = {}) => {
    const urlStr = String(url);
    const body = opts?.body ? JSON.parse(opts.body) : {};
    if (urlStr.includes('/api/settings') && opts?.method === 'POST') {
      savedPatches.push(body);
      const merged = normalizeFullSettings({ enableSafetyMonitor: body.enableSafetyMonitor });
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => merged,
        text: async () => JSON.stringify(merged),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ ok: true }),
      text: async () => JSON.stringify({ ok: true }),
    };
  };
  t.after(() => {
    setI18nLanguage(prevLocale);
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.fetch = prevFetch;
  });

  setI18nLanguage('zh-CN');

  const sampleSafetyMonitor = {
    scannedAtMs: Date.now(),
    sourceCount: 1,
    window5h: {
      totalStreamGen: 282,
      hiddenStreamGen: 130,
      hiddenRatio: 0.461,
      flashLiteCalls: 123,
      flashLiteTriggered: 7,
      heavyCalls: 7,
      heavyTriggered: 0,
      heavyFalseAlarmRate: 1,
      heavyTrajChars: 2_890_000,
      flashLiteTrajChars: 120_000,
      blockedMs: 173_000,
      rateLimit429Count: 0,
      fallbackCount: 0,
      estInputTokensLower: 722_500,
      estInputTokensUpper: 963_333,
    },
    window24h: {
      totalStreamGen: 400,
      hiddenStreamGen: 180,
      hiddenRatio: 0.45,
      flashLiteCalls: 170,
      flashLiteTriggered: 10,
      heavyCalls: 10,
      heavyTriggered: 1,
      heavyFalseAlarmRate: 0.9,
      heavyTrajChars: 3_600_000,
      flashLiteTrajChars: 200_000,
      blockedMs: 210_000,
      rateLimit429Count: 0,
      fallbackCount: 0,
      estInputTokensLower: 900_000,
      estInputTokensUpper: 1_200_000,
    },
    alerts: {
      has429Fallback: false,
      hasHeavyBurst: false,
      nearFlashLiteLimit: false,
    },
  };

  const sampleQuotas = {
    pools: [
      {
        poolKey: 'Gemini',
        poolLabel: 'Gemini',
        family: 'Gemini',
        usedPct: 24,
        remainingPct: 76,
        safetyReviewUsedPct: 1.5,
        resetTime: new Date(Date.now() + 3600_000).toISOString(),
      },
    ],
    weekly: { isOfficial: true },
  };

  const quotaWidget = QuotaPoolsWidget({ compactHover: false });
  const safetyCard = SafetyMonitorCard();
  const consView = ConsumptionView();
  const otherTab = SettingsOtherTab({});
  try {
    // 1. QuotaPoolsWidget stays clean (no embedded safety bar) while honoring opt-in tooltip suffix
    quotaWidget.refs.update({
      data: {
        settings: { experimentalQuotaReservation: true },
        quotas: sampleQuotas,
        safetyMonitor: sampleSafetyMonitor,
        account: { tierName: 'Pro' },
      },
    });
    assert.equal(quotaWidget.el.querySelector('.safety-monitor-panel'), null);
    const firstTrack = quotaWidget.el.querySelector('.progress-track');
    assert.equal(firstTrack.getAttribute('title'), null);

    quotaWidget.refs.update({
      data: {
        settings: { enableSafetyMonitor: true, experimentalQuotaReservation: true },
        quotas: sampleQuotas,
        safetyMonitor: sampleSafetyMonitor,
        account: { tierName: 'Pro' },
      },
    });
    assert.match(firstTrack.getAttribute('title') || '', /1\.5%/);

    // 2. SafetyMonitorCard hidden by default when disabled, visible when enabled (including ConsumptionView mount)
    assert.ok(consView.refs.safetyMonitorCard, 'ConsumptionView mounts SafetyMonitorCard');
    safetyCard.refs.update({ enabled: false, safetyMonitor: sampleSafetyMonitor });
    assert.equal(safetyCard.el.hidden, true, 'SafetyMonitorCard hides when enableSafetyMonitor is false');

    safetyCard.refs.update({ enabled: true, safetyMonitor: sampleSafetyMonitor });
    assert.equal(safetyCard.el.hidden, false, 'SafetyMonitorCard shows when opted in');
    assert.equal(safetyCard.refs.shareBarEl.hidden, false);
    assert.equal(safetyCard.refs.adviceEl.hidden, true);
    assert.match(safetyCard.el.textContent, /46\.1%/);
    assert.match(safetyCard.el.textContent, /123 \/ 7/);
    assert.match(safetyCard.el.textContent, /100%/);

    // Switch 5h -> 24h via native SegmentedControl
    const btn24h = safetyCard.refs.winSwitch.el.querySelector('button[data-seg-value="24h"]');
    assert.ok(btn24h, 'SafetyMonitorCard exposes 24h SegmentedControl button');
    btn24h.dispatchEvent({ type: 'click', stopPropagation() {} });
    assert.match(safetyCard.el.textContent, /170 \/ 10/);

    // 3. Alert state surfaces status-tag + soft borderless advice banner
    const alertSafety = {
      ...sampleSafetyMonitor,
      window5h: { ...sampleSafetyMonitor.window5h, rateLimit429Count: 2, fallbackCount: 1 },
      alerts: { has429Fallback: true, hasHeavyBurst: false, nearFlashLiteLimit: false },
    };
    safetyCard.refs.update({ enabled: true, safetyMonitor: alertSafety });
    assert.equal(safetyCard.refs.alertTagEl.hidden, false);
    assert.equal(safetyCard.refs.alertTagEl.classList.contains('state-danger'), true);
    assert.equal(safetyCard.refs.adviceEl.hidden, false);
    assert.equal(safetyCard.refs.adviceEl.classList.contains('tone-danger'), true);

    // 4. Empty window when opted in displays clean zero-state message
    safetyCard.refs.update({ enabled: true, safetyMonitor: null });
    assert.equal(safetyCard.el.hidden, false);
    assert.equal(safetyCard.refs.shareBarEl.hidden, true);
    assert.match(safetyCard.el.textContent, /暂未观测到/);

    // 5. SettingsOtherTab defaults safetyMonitorToggle to off and persists opt-in patch
    otherTab.refs.renderSettings({});
    const onBtn = otherTab.refs.safetyMonitorToggle.el.querySelector('button[data-seg-value="on"]');
    assert.ok(onBtn, 'SettingsOtherTab mounts safetyMonitorToggle with on button');
    assert.equal(
      otherTab.refs.safetyMonitorToggle.el
        .querySelector('button[data-seg-value="off"]')
        ?.getAttribute('aria-pressed'),
      'true'
    );
    onBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(
      savedPatches.some((p) => p.enableSafetyMonitor === true),
      'Clicking safetyMonitorToggle persists enableSafetyMonitor=true'
    );
  } finally {
    quotaWidget.destroy();
    safetyCard.destroy();
    consView.destroy();
    otherTab.destroy();
  }
});
