import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createMockDom } from './mock-dom.mjs';
import {
  DEFAULT_SETTINGS_SCHEMA,
  normalizeExperimentalModernUi,
  normalizeFullSettings,
  normalizeModernUi,
} from '../backend/settings-schema.mjs';
import { SUPPORTED_LOCALE_ENTRIES } from '../shared/settings-normalization.mjs';
import {
  applyAppearanceToRoot,
  detectHostColorScheme,
  normalizeClientModernUi,
  parseCssColorLuminance,
} from '../src/core/appearance.js';
import { createTrendAreaChart } from '../src/components/charts/TrendAreaChart.js';
import {
  computePublicationFit,
  createModelFitChart,
  createSessionLineChart,
} from '../src/components/charts/SessionStepCharts.js';
import { CustomSelect } from '../src/components/ui/CustomSelect.js';
import { SegmentedControl } from '../src/components/ui/SegmentedControl.js';
import { AccountQuotaTrendCard } from '../src/components/widgets/AccountQuotaTrendCard.js';
import {
  CapsuleBarWidget,
  buildCapsuleSlotContext,
  createCapsuleSlotNode,
  patchCapsuleOdometerText,
  syncCapsuleSlotNodes,
  tokenizeCapsuleOdometerText,
} from '../src/components/widgets/CapsuleBarWidget.js';
import { ContextWindowWidget } from '../src/components/widgets/ContextWindowWidget.js';
import { LiveActivityWidget } from '../src/components/widgets/LiveActivityWidget.js';
import { StepTableWidget } from '../src/components/widgets/StepTableWidget.js';
import {
  fetchTelemetry,
  isEquivalentTelemetry,
  saveSettingsPatch,
  stopAsyncTelemetryLoop,
  telemetryStore,
} from '../src/store/telemetryStore.js';
import { uiStore } from '../src/store/uiStore.js';
import { i18nStore, setI18nLanguage } from '../src/i18n/index.js';
import { ConsumptionView } from '../src/views/ConsumptionView.js';
import { StepsDetailView } from '../src/views/StepsDetailView.js';
import { SettingsGeneralTab } from '../src/views/settings/SettingsGeneralTab.js';
import { SettingsStructureTab } from '../src/views/settings/SettingsStructureTab.js';
import { EditableSlotList } from '../src/components/settings/EditableSlotList.js';
import { MetricMatrixWidget } from '../src/components/widgets/MetricMatrixWidget.js';
import {
  buildSparklineGeometry,
  extractOverviewMetricSeries,
  resolveAdaptiveSparklineSpec,
  splitMetricValueAndUnit,
} from '../src/registries/metricRegistry.js';
import { buildStructurePreviewTelemetry } from '../src/components/settings/structurePreviewMock.js';

test('modernUi schema normalization defaults to true, upgrades 1.5.2 settings without modernUi key to true, and respects explicit false', () => {
  assert.equal(DEFAULT_SETTINGS_SCHEMA.language, 'auto');
  assert.equal(DEFAULT_SETTINGS_SCHEMA.modernUi, true);
  assert.equal(DEFAULT_SETTINGS_SCHEMA.experimentalModernUi, true);
  assert.equal(normalizeModernUi(undefined), true);
  assert.equal(normalizeModernUi(false), false);
  assert.equal(normalizeModernUi('off'), false);
  assert.equal(normalizeModernUi(true), true);
  assert.equal(normalizeModernUi('true'), true);
  assert.equal(normalizeModernUi('on'), true);
  assert.equal(normalizeExperimentalModernUi(undefined), false);
  assert.equal(normalizeClientModernUi(undefined), true);
  assert.equal(normalizeClientModernUi('on'), true);
  assert.equal(normalizeClientModernUi(false), false);
  assert.equal(normalizeClientModernUi('off'), false);

  // Fresh 1.5.3 install -> language='auto', modernUi=true
  assert.equal(normalizeFullSettings({}).language, 'auto');
  assert.equal(normalizeFullSettings({}).modernUi, true);
  assert.equal(normalizeFullSettings({}).experimentalModernUi, true);

  // 1.5.2 persisted settings.json (where experimentalModernUi: false was written by default, no modernUi key) -> upgrades to true!
  const upgradedFrom152 = normalizeFullSettings({ experimentalModernUi: false });
  assert.equal(upgradedFrom152.modernUi, true);
  assert.equal(upgradedFrom152.experimentalModernUi, true);

  // Explicit 1.5.3 user opt-out (`modernUi: false`) -> stays false!
  const explicitOff153 = normalizeFullSettings({ modernUi: false, experimentalModernUi: true });
  assert.equal(explicitOff153.modernUi, false);
  assert.equal(explicitOff153.experimentalModernUi, false);

  assert.equal(
    isEquivalentTelemetry(
      { settings: { modernUi: false } },
      { settings: { modernUi: true } }
    ),
    false,
    'isEquivalentTelemetry must detect modernUi changes'
  );
});

test('detectHostColorScheme accurately distinguishes light vs dark host polarity across classes, CSS colors, and media queries', (t) => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;

  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    getComputedStyle: () => null,
    matchMedia: () => ({ matches: false }),
  };

  t.after(() => {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  assert.ok(parseCssColorLuminance('#ffffff') > 0.99);
  assert.ok(parseCssColorLuminance('#18181b') < 0.15);
  assert.ok(parseCssColorLuminance('rgb(255, 255, 255)') > 0.99);
  assert.ok(parseCssColorLuminance('rgb(21, 24, 30)') < 0.15);
  assert.equal(parseCssColorLuminance('rgba(0, 0, 0, 0)'), null);

  // 1. Light webview on a Dark OS: explicit vscode-light class wins over prefers-color-scheme: dark
  globalThis.window.matchMedia = () => ({ matches: true });
  document.body.className = 'vscode-light';
  assert.equal(detectHostColorScheme(document.documentElement), 'light');

  // 2. Dark class wins cleanly
  document.body.className = 'vscode-dark';
  assert.equal(detectHostColorScheme(document.documentElement), 'dark');

  // 3. Computed surface luminance when no explicit theme class is present
  document.body.className = '';
  globalThis.window.getComputedStyle = (el) => {
    if (el === document.body) {
      return {
        backgroundColor: 'rgb(255, 255, 255)',
        color: 'rgb(24, 24, 27)',
        getPropertyValue: () => '',
      };
    }
    return null;
  };
  assert.equal(detectHostColorScheme(document.documentElement), 'light');

  globalThis.window.getComputedStyle = (el) => {
    if (el === document.body) {
      return {
        backgroundColor: 'rgb(24, 24, 27)',
        color: 'rgb(244, 244, 245)',
        getPropertyValue: () => '',
      };
    }
    return null;
  };
  assert.equal(detectHostColorScheme(document.documentElement), 'dark');
});

test('applyAppearanceToRoot and SettingsGeneralTab toggle data-modern-ui + data-color-scheme and bundle includes crisp light-mode rules', async (t) => {
  const prevLocale = i18nStore.getState().locale;
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevTelState = { ...telemetryStore.getState() };

  const { document } = createMockDom();
  globalThis.document = document;
  document.body.className = 'vscode-light';
  const savedPatches = [];
  globalThis.window = {
    location: { pathname: '/' },
    sidecar: {
      fetch: async (_url, opts) => {
        if (opts?.method === 'POST' && opts?.body) {
          const parsed = JSON.parse(opts.body);
          savedPatches.push(parsed);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              settings: { language: 'zh-CN', themeAccent: 'host', fontScale: 'md', ...parsed },
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
    },
    addEventListener() {},
    removeEventListener() {},
  };

  let tab = null;
  t.after(() => {
    if (tab) tab.destroy();
    setI18nLanguage(prevLocale);
    telemetryStore.setState(prevTelState, { sync: true });
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  setI18nLanguage('zh-CN');

  // 1. Default off -> no data-modern-ui attribute, stamps data-color-scheme="light"
  applyAppearanceToRoot(document.documentElement, { experimentalModernUi: false });
  assert.equal(document.documentElement.hasAttribute('data-modern-ui'), false);
  assert.equal(document.documentElement.getAttribute('data-color-scheme'), 'light');

  applyAppearanceToRoot(document.documentElement, { experimentalModernUi: true });
  assert.equal(document.documentElement.getAttribute('data-modern-ui'), 'true');
  assert.equal(document.documentElement.getAttribute('data-color-scheme'), 'light');

  document.body.className = 'vscode-dark';
  applyAppearanceToRoot(document.documentElement, { experimentalModernUi: true });
  assert.equal(document.documentElement.getAttribute('data-color-scheme'), 'dark');

  document.body.className = 'vscode-light';
  applyAppearanceToRoot(document.documentElement, { experimentalModernUi: false });
  assert.equal(document.documentElement.hasAttribute('data-modern-ui'), false);
  assert.equal(document.documentElement.getAttribute('data-color-scheme'), 'light');

  // 2. SettingsGeneralTab renders '现代化 UI' (开启 / 关闭) and data-driven Language CustomSelect
  tab = SettingsGeneralTab({});
  document.body.appendChild(tab.el);
  tab.refs.renderSettings({
    language: 'auto',
    themeAccent: 'host',
    fontScale: 'md',
    modernUi: false,
    experimentalModernUi: false,
    pluginUpdateMode: 'manual',
  });

  assert.match(tab.el.textContent, /现代化 UI/);
  assert.doesNotMatch(tab.el.textContent, /实验性/);
  assert.equal(tab.refs.languageSwitch.el.querySelector('.select-label').textContent, '跟随系统');
  tab.refs.languageSwitch.el
    .querySelector('.select-trigger')
    .dispatchEvent({ type: 'click', stopPropagation() {} });
  const langSelectOpts = tab.refs.languageSwitch.el.querySelectorAll('.select-option');
  assert.deepEqual(
    langSelectOpts.map((opt) => opt.querySelector('.select-option-text').textContent),
    ['跟随系统', ...SUPPORTED_LOCALE_ENTRIES.map((entry) => entry.nativeName)]
  );
  assert.equal(langSelectOpts[0].classList.contains('is-selected'), true);
  tab.refs.languageSwitch.el
    .querySelector('.select-trigger')
    .dispatchEvent({ type: 'click', stopPropagation() {} });

  const modernBtns = tab.refs.modernUiSwitch.el.querySelectorAll('.seg-btn');
  assert.deepEqual(
    modernBtns.map((b) => b.textContent),
    ['开启', '关闭']
  );
  assert.equal(modernBtns[1].classList.contains('is-active'), true);

  // Click '开启' (index 0)
  modernBtns[0].dispatchEvent({ type: 'click', stopPropagation() {} });
  await new Promise((r) => setTimeout(r, 15));

  assert.equal(document.documentElement.getAttribute('data-modern-ui'), 'true');
  assert.equal(savedPatches.length, 1);
  assert.equal(savedPatches[0].modernUi, true);

  // 3. Built styles.css contains modern-ui borderless, sliding glider, and crisp pure-white light-mode rules
  const builtStyles = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(builtStyles, /\[data-modern-ui="true"\]\s+\.panel/);
  assert.match(builtStyles, /\[data-modern-ui="true"\]\[data-color-scheme="light"\]/);
  assert.match(builtStyles, /--modern-surface-card:\s*#ffffff;/);
  assert.match(builtStyles, /--modern-glider-bg:\s*#ffffff;/);
  assert.match(
    builtStyles,
    /--text-secondary:\s*color-mix\(in srgb,\s*var\(--text-primary\)\s*80%,\s*transparent\);/
  );
  assert.match(
    builtStyles,
    /--text-muted:\s*color-mix\(in srgb,\s*var\(--text-primary\)\s*62%,\s*transparent\);/
  );
  assert.match(
    builtStyles,
    /\[data-modern-ui="true"\]\s+\.ctx-agent-pill\.is-more-toggle\s*\{[^}]*color:\s*var\(--text-secondary\);/
  );
  assert.match(builtStyles, /\.seg-glider\.is-ready/);
  assert.match(builtStyles, /\.thirdnav-glider/);
  assert.match(builtStyles, /\.segmented\s*\{[^}]*width:\s*fit-content;[^}]*\}/);
  assert.doesNotMatch(builtStyles, /#000000/);
  assert.match(
    builtStyles,
    /\[data-modern-ui="true"\]\s+\.dual-grid\s*>\s*\.matrix-cell\s*\{[^}]*background:\s*transparent;/
  );
  assert.match(
    builtStyles,
    /\.cons-custom-range-bar\s*\{[^}]*background:\s*transparent;/
  );
  assert.match(
    builtStyles,
    /\[data-modern-ui="true"\]\s+\.steps-data-table\s+tbody\s+tr\.is-step-entering/
  );
  assert.doesNotMatch(
    builtStyles,
    /(?:^|\n)\.steps-data-table\s+tbody\s+tr\.is-step-entering/,
    'Step row enter animation must ONLY exist under [data-modern-ui="true"]'
  );
  assert.match(
    builtStyles,
    /\[data-modern-ui="true"\]\s+\.trend-tooltip\.is-tracking\s*\{[^}]*150ms/
  );
  assert.match(
    builtStyles,
    /\.trend-tip-sub\s*\{[^}]*background:\s*transparent;/
  );
  assert.match(
    builtStyles,
    /\.trend-tip-cost\s*\{[^}]*background:\s*transparent;/
  );
  assert.match(
    builtStyles,
    /\[data-modern-ui="true"\]\s+\.trend-tip-sub,\s*\[data-modern-ui="true"\]\s+\.trend-tip-cost\s*\{[^}]*background:\s*transparent;/
  );
  assert.match(
    builtStyles,
    /\[data-modern-ui="true"\]\.wm-multi-panel\s+\.live-task-card[\s\S]*?background:\s*transparent;/
  );
  assert.match(
    builtStyles,
    /:host\(\.wm-portal-host\)\s*\{[^}]*font-stretch:\s*100%;[^}]*font-variation-settings:\s*normal;[^}]*letter-spacing:\s*normal;/s,
    'Portal Shadow host must reset inherited host font-stretch/variation/letter-spacing to match sidebar typography'
  );
  assert.match(
    builtStyles,
    /\.wm-multi-panel\s+\.live-task-card\s*\{[^}]*gap:\s*7px;[^}]*padding:\s*10px\s+0;/s,
    'Floating multi-session task cards must match sidebar 7px row gap and 0px horizontal inset alignment'
  );
  assert.match(
    builtStyles,
    /\[data-modern-ui="true"\]\.wm-multi-panel\s+\.live-task-card:last-child[\s\S]*?padding-bottom:\s*0;/,
    'Modern UI multi-session panel must preserve symmetric bottom padding on last task card'
  );
  assert.match(
    builtStyles,
    /\.ctx-inspector-bar\s*\{[^}]*align-items:\s*flex-start;/,
    'ctx-inspector-bar must top-align pills so height clip never hides row 1 during expand/collapse'
  );
  assert.match(
    builtStyles,
    /@keyframes\s+anim-modern-step-row-in\s*\{\s*0%\s*\{[^}]*opacity:\s*0;[^}]*background-color:\s*transparent;[\s\S]*?100%\s*\{[^}]*opacity:\s*1;[^}]*background-color:\s*transparent;/,
    'Step row fade-in must start and end with transparent background to avoid abrupt flashes'
  );
  assert.doesNotMatch(
    builtStyles,
    /scrollbar-width:\s*thin/,
    'No element may opt into Chromium native scrollbar-width: thin'
  );
});

test('SegmentedControl variable-width glider snaps cleanly on reveal and glides across variable-width buttons, plus SettingsStructureTab thirdnav glider slides', (t) => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevUiState = { ...uiStore.getState() };

  const { document } = createMockDom();
  globalThis.document = document;
  let queuedRaf = null;
  globalThis.window = {
    requestAnimationFrame: (cb) => {
      queuedRaf = cb;
      return 1;
    },
    cancelAnimationFrame: () => {
      queuedRaf = null;
    },
    addEventListener() {},
    removeEventListener() {},
  };

  let seg = null;
  let structureTab = null;
  t.after(() => {
    seg?.destroy();
    structureTab?.destroy();
    uiStore.setState(prevUiState, { sync: true });
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  // 1. Hidden / 0x0 fallback -> no .has-glider, button fallback active
  const picked = [];
  seg = SegmentedControl({
    ariaLabel: '视图切换',
    modelValue: 'steps',
    options: [
      { value: 'steps', label: '按步查看 (1520)' },
      { value: 'models', label: '总汇总' },
    ],
    onUpdateModelValue: (v) => picked.push(v),
  });

  const glider = seg.refs.gliderEl;
  const btns = seg.el.querySelectorAll('.seg-btn');
  assert.equal(seg.el.children[0], glider, '.seg-glider stays at child index 0');
  assert.equal(seg.el.classList.contains('has-glider'), false);
  assert.equal(glider.classList.contains('is-ready'), false);

  // 2. Simulate layout reveal with variable widths: btn0 = 114px @ x=3, btn1 = 56px @ x=119
  Object.assign(btns[0], { offsetLeft: 3, offsetTop: 3, offsetWidth: 114, offsetHeight: 22 });
  Object.assign(btns[1], { offsetLeft: 119, offsetTop: 3, offsetWidth: 56, offsetHeight: 22 });

  seg.refs.refreshGlider();
  assert.equal(seg.el.classList.contains('has-glider'), true);
  assert.equal(glider.style.getPropertyValue('--glider-x'), '3px');
  assert.equal(glider.style.getPropertyValue('--glider-w'), '114px');
  assert.equal(
    glider.classList.contains('is-ready'),
    false,
    'Initial visible snap must not animate from 0px'
  );

  assert.equal(typeof queuedRaf, 'function');
  queuedRaf();
  assert.equal(glider.classList.contains('is-ready'), true, 'Transition armed on next frame');

  // 3. Click second segment ('总汇总') -> glider slides to x=119px, w=56px with .is-ready intact
  btns[1].dispatchEvent({ type: 'click', stopPropagation() {} });
  assert.deepEqual(picked, ['models']);
  assert.equal(glider.style.getPropertyValue('--glider-x'), '119px');
  assert.equal(glider.style.getPropertyValue('--glider-w'), '56px');
  assert.equal(glider.classList.contains('is-ready'), true);

  // 4. ArrowLeft cycles back to 'steps'
  btns[1].dispatchEvent({ type: 'keydown', key: 'ArrowLeft', preventDefault() {} });
  assert.deepEqual(picked, ['models', 'steps']);
  assert.equal(glider.style.getPropertyValue('--glider-x'), '3px');
  assert.equal(glider.style.getPropertyValue('--glider-w'), '114px');

  // 5. SettingsStructureTab 4-tab .settings-thirdnav-bar slides .thirdnav-glider via --active-third-index
  uiStore.setState({ settingsStructureTab: 'mount' }, { sync: true });
  structureTab = SettingsStructureTab({});
  const thirdNavBar = structureTab.refs.thirdNavBar;
  const thirdGlider = thirdNavBar.querySelector('.thirdnav-glider');
  const thirdBtns = thirdNavBar.querySelectorAll('.structure-thirdnav-btn');
  assert.ok(thirdGlider, 'thirdNavBar contains .thirdnav-glider');
  assert.equal(thirdNavBar.style.getPropertyValue('--active-third-index'), '0');

  thirdBtns[2].dispatchEvent({ type: 'click' });
  uiStore.flushSync?.();
  assert.equal(thirdNavBar.style.getPropertyValue('--active-third-index'), '2');

  thirdBtns[3].dispatchEvent({ type: 'click' });
  uiStore.flushSync?.();
  assert.equal(thirdNavBar.style.getPropertyValue('--active-third-index'), '3');

  // 6. LiveActivityWidget wraps .live-sub-list inside CustomScrollbar (.live-sub-scroll-host) with zero native scrollbars
  const liveWidget = LiveActivityWidget({ defaultExpandRunningSubs: true });
  liveWidget.refs.update({
    items: [
      {
        cascadeId: 'conv-swarm-1',
        title: 'Swarm Run',
        isMainRunning: true,
        subagentCount: 2,
        runningSubagentCount: 1,
        subagents: [
          { cascadeId: 'sub-1', index: 1, role: '@entry-runtime', isRunning: true, stepCount: 17 },
          { cascadeId: 'sub-2', index: 2, role: '@config-state', isRunning: false, stepCount: 7 },
        ],
      },
    ],
  });
  const scrollHost = liveWidget.el.querySelector('.live-sub-scroll-host');
  assert.ok(scrollHost, 'Subagent list is wrapped in CustomScrollbar .live-sub-scroll-host');
  assert.equal(scrollHost.hasAttribute('hidden'), false);
  assert.ok(scrollHost.querySelector('.scrollbar-rail'), 'CustomScrollbar rail is mounted');
  assert.equal(liveWidget.el.querySelector('.live-sub-list').hasAttribute('hidden'), false);
  liveWidget.destroy();

  // 7. ConsumptionView places '周期' ('cycle') before '今天' ('today'), while defaulting active selection to 'today'
  assert.equal(telemetryStore.getState().selectedTimeRange, 'today');
  setI18nLanguage('zh-CN');
  const consView = ConsumptionView({});
  const rangeBtns = consView.el.querySelector('.cons-overview-head').querySelectorAll('.seg-btn');
  assert.equal(rangeBtns[0].getAttribute('data-seg-value'), 'cycle');
  assert.equal(rangeBtns[0].textContent, '周期');
  assert.equal(rangeBtns[1].getAttribute('data-seg-value'), 'today');
  assert.equal(rangeBtns[1].textContent, '今天');
  assert.equal(rangeBtns[0].classList.contains('is-active'), false);
  assert.equal(rangeBtns[1].classList.contains('is-active'), true, 'Default active range remains today');
  consView.destroy();

  // 8. StepsDetailView inlineScopeSelect ('全部汇总') omits unnecessary leading SVG icon
  const stepsView = StepsDetailView({});
  const scopeTriggerChildren = stepsView.refs.inlineScopeSelect.refs.triggerBtn.children;
  assert.equal(
    scopeTriggerChildren[0].hasAttribute('hidden'),
    true,
    'inlineScopeSelect leading SVG icon is hidden'
  );
  stepsView.destroy();

  // 9. StepTableWidget animates ONLY genuinely newly added steps in Modern UI, never on initial load, filter change, classic UI, or conversation switch
  const stepTable = StepTableWidget({});
  const cols = ['step', 'model', 'tokens_combo'];
  const s1 = { stepIndex: 1, agentCascadeId: 'conv-a', modelShort: '4-carbon', inputTokens: 100 };
  const s2Sub = {
    stepIndex: 1,
    agentCascadeId: 'sub-1',
    isSubagent: true,
    agentId: 'sub-1',
    modelShort: '4-carbon',
    inputTokens: 80,
  };
  const s2Main = { stepIndex: 2, agentCascadeId: 'conv-a', modelShort: '4-carbon', inputTokens: 200 };

  // Initial load (conv-a, filtered to main only, while allConversationSteps has s2Sub too) -> 0 entering rows
  stepTable.refs.renderStepTable([s2Main, s1], 'conv-a', cols, 'zh-CN', {
    allConversationSteps: [s2Main, s2Sub, s1],
    allowNewRowFade: true,
  });
  assert.equal(
    stepTable.refs.stepsTbody.children.some((tr) => tr.classList.contains('is-step-entering')),
    false,
    'Initial render must never animate existing rows'
  );

  // Filter change reveals existing s2Sub -> 0 entering rows ("而且不是查看其他记录")
  stepTable.refs.renderStepTable([s2Main, s2Sub, s1], 'conv-a', cols, 'zh-CN', {
    allConversationSteps: [s2Main, s2Sub, s1],
    allowNewRowFade: false,
  });
  assert.equal(
    stepTable.refs.stepsTbody.children.some((tr) => tr.classList.contains('is-step-entering')),
    false,
    'Revealing existing subagent steps via filter must not animate'
  );

  // Classic UI (allowNewRowFade: false) when step #3 arrives -> 0 entering rows ("只有新ui才有这个动画")
  const s3Classic = { stepIndex: 3, agentCascadeId: 'conv-a', modelShort: '4-carbon', inputTokens: 300 };
  stepTable.refs.renderStepTable([s3Classic, s2Main, s2Sub, s1], 'conv-a', cols, 'zh-CN', {
    allConversationSteps: [s3Classic, s2Main, s2Sub, s1],
    allowNewRowFade: false,
  });
  assert.equal(
    stepTable.refs.stepsTbody.children.some((tr) => tr.classList.contains('is-step-entering')),
    false,
    'Classic UI must not animate newly added step rows'
  );

  // Modern UI live update (allowNewRowFade: true) when step #4 arrives -> ONLY row 0 (#4) gets is-step-entering
  const s4New = { stepIndex: 4, agentCascadeId: 'conv-a', modelShort: '4-carbon', inputTokens: 400 };
  stepTable.refs.renderStepTable([s4New, s3Classic, s2Main, s2Sub, s1], 'conv-a', cols, 'zh-CN', {
    allConversationSteps: [s4New, s3Classic, s2Main, s2Sub, s1],
    allowNewRowFade: true,
  });
  assert.equal(stepTable.refs.stepsTbody.children[0].classList.contains('is-step-entering'), true);
  assert.equal(stepTable.refs.stepsTbody.children[1].classList.contains('is-step-entering'), false);

  // Bubbled animationend from a child <td> must NOT cut off the <tr> highlight fade prematurely
  const enteringRow = stepTable.refs.stepsTbody.children[0];
  enteringRow.onanimationend?.({ target: enteringRow.children[0] });
  assert.equal(
    enteringRow.classList.contains('is-step-entering'),
    true,
    'Child td animationend must not prematurely strip is-step-entering from tr'
  );

  // Clear animationend on row 0 itself, then streaming update to step #4 arrives -> must NOT re-trigger fade-in
  enteringRow.onanimationend?.({ target: enteringRow });
  assert.equal(enteringRow.classList.contains('is-step-entering'), false);
  const s4Updated = { ...s4New, outputTokens: 520 };
  stepTable.refs.renderStepTable([s4Updated, s3Classic, s2Main, s2Sub, s1], 'conv-a', cols, 'zh-CN', {
    allConversationSteps: [s4Updated, s3Classic, s2Main, s2Sub, s1],
    allowNewRowFade: true,
  });
  assert.equal(
    stepTable.refs.stepsTbody.children[0].classList.contains('is-step-entering'),
    false,
    'In-place streaming update of an already seen step must not re-animate'
  );

  // Switching to another conversation ('conv-b') -> 0 entering rows
  const otherConvStep = { stepIndex: 99, agentCascadeId: 'conv-b', modelShort: '4-carbon', inputTokens: 50 };
  stepTable.refs.renderStepTable([otherConvStep], 'conv-b', cols, 'zh-CN', {
    allConversationSteps: [otherConvStep],
    allowNewRowFade: true,
  });
  assert.equal(
    stepTable.refs.stepsTbody.children.some((tr) => tr.classList.contains('is-step-entering')),
    false,
    'Switching conversation must not trigger row fade-in'
  );
  stepTable.destroy();

  // 10. TrendAreaChart tooltip arms 0.15s .is-tracking transition after initial snap and follows pointer steadily without top/bottom jumps
  const trendChart = createTrendAreaChart();
  Object.assign(trendChart.el, {
    clientWidth: 460,
    offsetHeight: 210,
    getBoundingClientRect: () => ({ left: 0, top: 240, width: 460, height: 210, right: 460, bottom: 450 }),
  });
  const tipEl = trendChart.el.querySelector('.trend-tooltip');
  Object.assign(tipEl, { offsetWidth: 216, offsetHeight: 82 });
  const plotStage = trendChart.el.querySelector('.trend-plot-stage');
  const trendPeakPill = trendChart.el.querySelector('.trend-peak-pill');
  const svgEl = trendChart.el.querySelector('.trend-svg');
  svgEl.getBoundingClientRect = () => ({ left: 0, top: 246, width: 460, height: 184, right: 460, bottom: 430 });
  // Zero-data slots must keep peak pill hidden even after hover + mouseleave
  trendChart.update([{ index: 0, label: '00:53', fullLabel: '11月25日 00:53 - 00:54', tokens: 0, calls: 0, costUsd: 0 }]);
  assert.equal(trendPeakPill.hasAttribute('hidden'), true, 'Zero-data chart must hide peak pill');
  plotStage.dispatchEvent({ type: 'mousemove', clientX: 200, clientY: 340 });
  plotStage.dispatchEvent({ type: 'mouseleave' });
  assert.equal(trendPeakPill.hasAttribute('hidden'), true, 'Peak pill stays hidden after mouseleave on zero-data chart');

  trendChart.update([
    { index: 0, label: '00:00', fullLabel: '11月19日 00:00 - 01:00', tokens: 1000, calls: 2, costUsd: 0.1 },
    { index: 1, label: '10:00', fullLabel: '11月19日 10:00 - 11:00', tokens: 25_000_000, calls: 80, costUsd: 6.37 },
  ]);
  assert.equal(trendPeakPill.hasAttribute('hidden'), false, 'Non-zero chart shows peak pill');
  queuedRaf = null;
  plotStage.dispatchEvent({ type: 'mousemove', clientX: 80, clientY: 360 });
  const firstY = tipEl.style.getPropertyValue('--tip-y');
  assert.equal(firstY, '24px');
  assert.equal(tipEl.classList.contains('is-tracking'), false);
  queuedRaf?.();
  assert.equal(tipEl.classList.contains('is-tracking'), true);

  // Sweeping horizontally from valley to peak at steady cursor Y keeps --tip-y rock steady (no top/bottom ping-pong)
  plotStage.dispatchEvent({ type: 'mousemove', clientX: 400, clientY: 360 });
  assert.equal(tipEl.style.getPropertyValue('--tip-y'), firstY);
  assert.equal(tipEl.classList.contains('is-tracking'), true);
  // Moving cursor vertically shifts --tip-y smoothly with cursor
  plotStage.dispatchEvent({ type: 'mousemove', clientX: 400, clientY: 390 });
  assert.equal(tipEl.style.getPropertyValue('--tip-y'), '54px');
  trendChart.destroy();

  // 10b. SessionStepCharts (Summary view) and AccountQuotaTrendCard share 2D pointer-following tooltip + .is-tracking focus dots
  const stepLineChart = createSessionLineChart();
  Object.assign(stepLineChart.el, {
    clientWidth: 460,
    offsetHeight: 130,
    getBoundingClientRect: () => ({ left: 0, top: 200, width: 460, height: 130, right: 460, bottom: 330 }),
  });
  const stepTipEl = stepLineChart.el.querySelector('.trend-tooltip');
  assert.equal(stepTipEl.classList.contains('is-floating-tip'), true);
  Object.assign(stepTipEl, { offsetWidth: 208, offsetHeight: 76 });
  const stepStage = stepLineChart.el.querySelector('.sstep-plot-stage');
  const stepSvg = stepLineChart.el.querySelector('.sstep-svg');
  stepSvg.getBoundingClientRect = () => ({ left: 0, top: 206, width: 460, height: 106, right: 460, bottom: 312 });
  stepLineChart.update({
    steps: [
      { stepIndex: 1, createdAtMs: 1000, modelShort: 'Gemini', totalTokens: 12000, inputTokens: 8000, cacheReadTokens: 2000, outputTokens: 2000, tokPerSec: 60, ttftSec: 0.4 },
      { stepIndex: 2, createdAtMs: 2000, modelShort: 'Gemini', totalTokens: 28000, inputTokens: 16000, cacheReadTokens: 8000, outputTokens: 4000, tokPerSec: 75, ttftSec: 0.3 },
    ],
    metric: 'totalTokens',
  });
  queuedRaf?.();
  assert.equal(stepLineChart.el.querySelector('.trend-peak-pill').classList.contains('is-ready'), true);
  queuedRaf = null;
  stepStage.dispatchEvent({ type: 'mousemove', clientX: 120, clientY: 300 });
  assert.equal(stepTipEl.style.getPropertyValue('--tip-shift'), '0px');
  assert.equal(stepTipEl.style.getPropertyValue('--tip-y'), '10px');
  const stepHoverDot = stepLineChart.el.querySelector('.trend-hover-dot');
  assert.equal(stepTipEl.classList.contains('is-tracking'), false);
  assert.equal(stepHoverDot.classList.contains('is-tracking'), false);
  queuedRaf?.();
  assert.equal(stepTipEl.classList.contains('is-tracking'), true);
  assert.equal(stepHoverDot.classList.contains('is-tracking'), true);

  // High-density 2606-step session downsamples spline cleanly without turning into a 2600-segment wall, while keeping exact peak
  const denseSteps = Array.from({ length: 2606 }, (_, i) => ({
    stepIndex: 5500 + i,
    createdAtMs: 1000 + i * 100,
    modelLabel: i % 2 === 0 ? 'neon-4-xhigh' : 'carbon-4-high',
    modelShort: i % 2 === 0 ? 'neon-4-xhigh' : 'carbon-4-high',
    tokPerSec: i === 1963 ? 151 : 25 + ((i * 17) % 90),
    inputTokens: 1000,
    cacheReadTokens: 2000,
    outputTokens: 100,
  }));
  stepLineChart.update({
    steps: denseSteps,
    modelGroupKey: 'neon-4-xhigh',
    modelGroupKeys: ['neon-4-xhigh'],
    metric: 'tps',
  });
  // Flush any morph animation to final path
  if (queuedRaf) queuedRaf(performance.now() + 400);
  const denseLineD = stepLineChart.el.querySelector('.trend-line').getAttribute('d') || '';
  const cubicSegCount = (denseLineD.match(/ C /g) || []).length;
  assert.ok(
    cubicSegCount >= 120 && cubicSegCount <= 256,
    `Expected adaptive downsampled cubic segment count in [120..256], got ${cubicSegCount}`
  );
  stepLineChart.update({
    steps: denseSteps,
    modelGroupKey: '__all__',
    modelGroupKeys: ['__all__'],
    metric: 'tps',
  });
  if (queuedRaf) queuedRaf(performance.now() + 400);
  assert.match(stepLineChart.el.querySelector('.trend-peak-pill').textContent, /#7463.*151/);

  // Switching from 1 model -> 2 models animates newly added model smoothly from baseline instead of snapping
  globalThis.window.getComputedStyle = () => ({});
  stepLineChart.update({
    steps: denseSteps,
    modelGroupKey: 'neon-4-xhigh',
    modelGroupKeys: ['neon-4-xhigh'],
    metric: 'tps',
  });
  if (queuedRaf) queuedRaf(performance.now() + 400);
  queuedRaf = null;
  stepLineChart.update({
    steps: denseSteps,
    modelGroupKey: 'neon-4-xhigh',
    modelGroupKeys: ['neon-4-xhigh', 'carbon-4-high'],
    metric: 'tps',
  });
  assert.equal(
    typeof queuedRaf,
    'function',
    'Checking a 2nd model in SessionLineChart schedules a 240ms morph animation'
  );
  const multiPaths = stepLineChart.el.querySelectorAll('.sstep-multi-line-group .sstep-fit-line');
  assert.equal(multiPaths.length, 2);
  const carbonStartD = multiPaths[1].getAttribute('d') || '';
  queuedRaf(performance.now() + 400);
  const carbonEndD = multiPaths[1].getAttribute('d') || '';
  assert.notEqual(carbonStartD, carbonEndD, 'Newly checked 2nd model morphs from baseline to target curve');

  // High-density (>96 segments at 460px width) morph must NOT skip knots during animation or pop peaks up at completion
  stepStage.clientWidth = 460;
  stepLineChart.update({
    steps: denseSteps,
    modelGroupKey: '__all__',
    modelGroupKeys: ['__all__'],
    metric: 'totalTokens',
  });
  if (queuedRaf) queuedRaf(performance.now() + 400);
  queuedRaf = null;
  const morphStartTs = performance.now();
  stepLineChart.update({
    steps: denseSteps,
    modelGroupKey: '__all__',
    modelGroupKeys: ['__all__'],
    metric: 'tps',
  });
  assert.equal(typeof queuedRaf, 'function');
  queuedRaf(morphStartTs + 239.95);
  const nearEndD = stepLineChart.el.querySelector('.trend-line').getAttribute('d') || '';
  queuedRaf(morphStartTs + 300);
  const exactEndD = stepLineChart.el.querySelector('.trend-line').getAttribute('d') || '';
  const nearSegCount = (nearEndD.match(/ C /g) || []).length;
  const exactSegCount = (exactEndD.match(/ C /g) || []).length;
  assert.ok(
    exactSegCount > 96 && nearSegCount >= exactSegCount,
    '460px plot preserves >=100% of target knots during >96-segment morph without stride-2 skipping'
  );
  const parseEndpoints = (d) =>
    [...d.matchAll(/([\d.]+)\s+([\d.]+)(?=\s*C|$)/g)].map((m) => ({ x: +m[1], y: +m[2] }));
  const nearPts = parseEndpoints(nearEndD);
  const exactPts = parseEndpoints(exactEndD);
  for (const ep of exactPts) {
    const minDy = nearPts.reduce(
      (best, np) => (Math.abs(np.x - ep.x) <= 0.2 ? Math.min(best, Math.abs(np.y - ep.y)) : best),
      Infinity
    );
    assert.ok(minDy <= 0.2, `Target vertex (${ep.x}, ${ep.y}) must not pop at completion (dy=${minDy})`);
  }
  delete globalThis.window.getComputedStyle;
  stepLineChart.destroy();

  const fitChart = createModelFitChart();
  Object.assign(fitChart.el, {
    clientWidth: 460,
    offsetHeight: 160,
    getBoundingClientRect: () => ({ left: 0, top: 200, width: 460, height: 160, right: 460, bottom: 360 }),
  });
  const fitTipEl = fitChart.el.querySelector('.trend-tooltip');
  assert.equal(fitTipEl.classList.contains('is-floating-tip'), true);
  Object.assign(fitTipEl, { offsetWidth: 212, offsetHeight: 74 });
  fitChart.el.querySelector('.sstep-fit-svg').getBoundingClientRect = () => ({
    left: 0,
    top: 204,
    width: 460,
    height: 138,
    right: 460,
    bottom: 342,
  });
  fitChart.update({
    steps: [
      { stepIndex: 1, createdAtMs: 1000, modelShort: 'Gemini', tokPerSec: 55 },
      { stepIndex: 2, createdAtMs: 2000, modelShort: 'Gemini', tokPerSec: 68 },
      { stepIndex: 3, createdAtMs: 3000, modelShort: 'Gemini', tokPerSec: 72 },
    ],
    metric: 'tps',
  });
  queuedRaf = null;
  fitChart.el.querySelector('.sstep-plot-stage').dispatchEvent({ type: 'mousemove', clientX: 220, clientY: 310 });
  queuedRaf?.();
  assert.equal(fitTipEl.classList.contains('is-tracking'), true);
  assert.equal(fitChart.el.querySelector('.trend-hover-dot').classList.contains('is-tracking'), true);
  assert.equal(fitChart.el.querySelector('.sstep-hover-raw-dot').classList.contains('is-tracking'), true);
  fitChart.destroy();

  const nowQ = Date.now();
  const quotaCard = AccountQuotaTrendCard({});
  const quotaWrap = quotaCard.el.querySelector('.trend-chart-wrap');
  Object.assign(quotaWrap, {
    clientWidth: 460,
    offsetHeight: 210,
    getBoundingClientRect: () => ({ left: 0, top: 200, width: 460, height: 210, right: 460, bottom: 410 }),
  });
  const quotaTipEl = quotaCard.el.querySelector('.trend-tooltip');
  assert.equal(quotaTipEl.classList.contains('is-floating-tip'), true);
  Object.assign(quotaTipEl, { offsetWidth: 200, offsetHeight: 74 });
  quotaCard.el.querySelector('.trend-svg').getBoundingClientRect = () => ({
    left: 0,
    top: 206,
    width: 460,
    height: 184,
    right: 460,
    bottom: 390,
  });
  quotaCard.refs.update({
    activeEmail: 'user@example.com',
    activePools: [
      {
        poolKey: 'Gemini',
        poolLabel: 'Gemini',
        remainingPct: 91,
        weeklyRemainingPct: 88,
        resetTime: new Date(nowQ + 2 * 3600_000).toISOString(),
      },
    ],
    quotaHistory: {
      'user@example.com': {
        pools: {
          Gemini: {
            label: 'Gemini',
            reset5hMs: nowQ + 2 * 3600_000,
            points: [
              [nowQ - 3 * 3600_000 + 2000, 100, 90],
              [nowQ - 3600_000, 95, 89],
            ],
          },
        },
      },
    },
  });
  queuedRaf = null;
  quotaCard.el.querySelector('.trend-plot-stage').dispatchEvent({
    type: 'mousemove',
    clientX: 230,
    clientY: 320,
  });
  assert.equal(quotaTipEl.style.getPropertyValue('--tip-y'), '32px');
  queuedRaf?.();
  assert.equal(quotaTipEl.classList.contains('is-tracking'), true);
  assert.equal(quotaCard.el.querySelector('.trend-hover-dot').classList.contains('is-tracking'), true);
  assert.equal(
    quotaCard.el.querySelectorAll('.trend-x-tick').some((tk) => tk.classList.contains('is-hovered')),
    true,
    'Hovering quota chart highlights nearest X-axis tick'
  );
  quotaCard.destroy();

  // 11. ContextWindowWidget + LiveActivityWidget use pure SVG chevrons and animate expand/collapse under [data-modern-ui="true"]
  document.documentElement.setAttribute('data-modern-ui', 'true');
  const ctxWidget = ContextWindowWidget({});
  document.body.appendChild(ctxWidget.el);
  const subAgents = Array.from({ length: 8 }, (_, idx) => ({
    agentId: `sub-${idx + 1}`,
    cascadeId: `sub-${idx + 1}`,
    index: idx + 1,
    agentKind: 'swarm_worker',
    agentOrdinal: idx + 1,
    isMain: false,
    stepCount: 5,
    context: { usedPct: 15 + idx },
  }));
  ctxWidget.refs.update({
    data: {
      settings: { language: 'zh-CN' },
      activeConversation: {
        cascadeId: 'conv-ctx-anim',
        hasSubagents: true,
        agents: [
          { agentId: 'main', cascadeId: 'conv-ctx-anim', isMain: true, stepCount: 10, context: { usedPct: 40 } },
          ...subAgents,
        ],
        aggregated: { activeAgentId: 'main', activeAgentKind: 'main' },
      },
    },
  });

  const moreBtn = ctxWidget.el.querySelector('.ctx-agent-pill.is-more-toggle');
  assert.ok(moreBtn, 'Overflowing agent pills render .is-more-toggle pill');
  assert.doesNotMatch(moreBtn.textContent, /[▾▴▸]/, 'Zero Unicode arrow characters in toggle text');
  assert.equal(moreBtn.querySelector('.ctx-toggle-chevron')?.hasAttribute('hidden'), false);
  assert.equal(moreBtn.classList.contains('is-expanded'), false);

  const inspectorBar = ctxWidget.el.querySelector('.ctx-inspector-bar');
  const pillGroup = ctxWidget.el.querySelector('.ctx-pill-group');
  Object.assign(inspectorBar, { offsetHeight: 22 });
  Object.assign(pillGroup, { offsetHeight: 74 });

  moreBtn.onclick(); // Expand
  assert.equal(inspectorBar.style.height, '74px');
  const collapseBtn = ctxWidget.el.querySelector('.ctx-agent-pill.is-more-toggle');
  assert.equal(collapseBtn.textContent, '收起');
  assert.equal(collapseBtn.classList.contains('is-expanded'), true);
  inspectorBar.ontransitionend?.({ target: inspectorBar });
  assert.equal(inspectorBar.style.height, '');

  // Collapse back smoothly
  Object.assign(inspectorBar, { offsetHeight: 74 });
  Object.assign(pillGroup.children[0], { offsetHeight: 22, offsetTop: 0 });
  collapseBtn.onclick();
  assert.equal(collapseBtn.classList.contains('is-expanded'), false);
  assert.equal(inspectorBar.style.height, '22px');
  inspectorBar.ontransitionend?.({ target: inspectorBar });
  assert.equal(inspectorBar.style.height, '');
  ctxWidget.destroy();

  // LiveActivityWidget SVG chevron + smooth collapse/expand under [data-modern-ui="true"]
  const animLive = LiveActivityWidget({ defaultExpandRunningSubs: true });
  document.body.appendChild(animLive.el);
  animLive.refs.update({
    items: [
      {
        cascadeId: 'conv-live-anim',
        title: 'Swarm Session',
        isMainRunning: true,
        subagentCount: 2,
        swarmCount: 2,
        runningSubagentCount: 0,
        subagents: [
          { cascadeId: 'sw-1', index: 1, agentKind: 'swarm_worker', role: '@w1', isRunning: false, stepCount: 4 },
          { cascadeId: 'sw-2', index: 2, agentKind: 'swarm_worker', role: '@w2', isRunning: false, stepCount: 6 },
        ],
      },
    ],
  });
  const liveToggleBtn = animLive.el.querySelector('.live-sub-toggle');
  const liveScrollHost = animLive.el.querySelector('.live-sub-scroll-host');
  assert.equal(liveToggleBtn.textContent, '蜂群 (2)');
  assert.ok(liveToggleBtn.querySelector('.live-sub-toggle-chevron'));
  assert.equal(liveToggleBtn.classList.contains('is-expanded'), false);

  Object.assign(liveScrollHost, { offsetHeight: 64, scrollHeight: 64 });
  liveToggleBtn.onclick({ stopPropagation() {} }); // Expand
  assert.equal(liveToggleBtn.classList.contains('is-expanded'), true);
  assert.equal(liveScrollHost.hasAttribute('hidden'), false);
  assert.equal(liveScrollHost.classList.contains('is-sub-animating'), true);
  assert.equal(liveScrollHost.style.height, '64px');
  // Opacity finishes earlier than height -> must NOT cut off height transition early
  liveScrollHost.ontransitionend?.({ target: liveScrollHost, propertyName: 'opacity' });
  assert.equal(liveScrollHost.style.height, '64px');
  assert.equal(liveScrollHost.classList.contains('is-sub-animating'), true);
  liveScrollHost.ontransitionend?.({ target: liveScrollHost, propertyName: 'height' });
  assert.equal(liveScrollHost.style.height, '');
  assert.equal(liveScrollHost.classList.contains('is-sub-animating'), false);

  liveToggleBtn.onclick({ stopPropagation() {} }); // Collapse
  assert.equal(liveToggleBtn.classList.contains('is-expanded'), false);
  assert.equal(liveScrollHost.style.height, '0px');
  assert.equal(liveScrollHost.classList.contains('is-sub-animating'), true);
  liveScrollHost.ontransitionend?.({ target: liveScrollHost, propertyName: 'opacity' });
  assert.equal(liveScrollHost.hasAttribute('hidden'), false);
  liveScrollHost.ontransitionend?.({ target: liveScrollHost, propertyName: 'height' });
  assert.equal(liveScrollHost.hasAttribute('hidden'), true);
  assert.equal(liveScrollHost.classList.contains('is-sub-animating'), false);
  animLive.destroy();
  document.documentElement.removeAttribute('data-modern-ui');
});

test('saveSettingsPatch prevents stale in-flight telemetry polls from snapping settings back and commits UI preferences without blocking on forced telemetry', async (t) => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevTelState = { ...telemetryStore.getState() };

  const { document } = createMockDom();
  globalThis.document = document;

  const baseSettings = {
    language: 'zh-CN',
    themeAccent: 'host',
    fontScale: 'md',
    experimentalModernUi: false,
    windowMountMode: 'dual',
    enableWindowOverlay: true,
  };
  const diskSettings = { ...baseSettings };
  telemetryStore.setState(
    { telemetry: { settings: { ...baseSettings }, activeConversation: { stepCount: 1 } } },
    { sync: true }
  );

  let resolveStalePoll = null;
  let resolveSlowPost = null;
  let telemetryGetCalls = 0;
  const postOrder = [];

  globalThis.window = {
    location: { pathname: '/' },
    sidecar: {
      fetch: async (url, opts = {}) => {
        const method = String(opts.method || 'GET').toUpperCase();
        if (method === 'GET' && String(url).startsWith('/api/telemetry')) {
          telemetryGetCalls += 1;
          if (telemetryGetCalls === 1) {
            // Simulate a slow poll that started BEFORE the user changed any setting
            return new Promise((resolve) => {
              resolveStalePoll = () =>
                resolve({
                  ok: true,
                  status: 200,
                  json: async () => ({
                    settings: { ...baseSettings },
                    activeConversation: { stepCount: 2 },
                  }),
                });
            });
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              settings: { ...diskSettings },
              activeConversation: { stepCount: 3 },
            }),
          };
        }
        if (method === 'POST' && url === '/api/settings') {
          const body = JSON.parse(opts.body);
          postOrder.push(body);
          if (postOrder.length === 1) {
            return new Promise((resolve) => {
              resolveSlowPost = () => {
                Object.assign(diskSettings, body);
                resolve({ ok: true, status: 200, json: async () => ({ ...diskSettings }) });
              };
            });
          }
          Object.assign(diskSettings, body);
          return { ok: true, status: 200, json: async () => ({ ...diskSettings }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      },
    },
    addEventListener() {},
    removeEventListener() {},
  };

  t.after(() => {
    stopAsyncTelemetryLoop();
    telemetryStore.setState(prevTelState, { sync: true });
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  // 1. Start background telemetry poll (capturing stale settings: experimentalModernUi=false, fontScale='md')
  const stalePollPromise = fetchTelemetry({ force: false });
  assert.equal(telemetryGetCalls, 1);

  // 2. While poll is in flight, user toggles experimentalModernUi -> true AND rapidly switches fontScale -> 'lg'
  const save1 = saveSettingsPatch({ experimentalModernUi: true });
  const save2 = saveSettingsPatch({ fontScale: 'lg' });
  assert.equal(telemetryStore.getState().telemetry.settings.experimentalModernUi, true);
  assert.equal(telemetryStore.getState().telemetry.settings.fontScale, 'lg');

  // 3. Stale poll returns BEFORE POST finishes -> live stepCount updates to 2, yet settings NEVER snap back!
  resolveStalePoll();
  await stalePollPromise;
  assert.equal(telemetryStore.getState().telemetry.activeConversation.stepCount, 2);
  assert.equal(
    telemetryStore.getState().telemetry.settings.experimentalModernUi,
    true,
    'Stale in-flight poll must not revert pending experimentalModernUi'
  );
  assert.equal(
    telemetryStore.getState().telemetry.settings.fontScale,
    'lg',
    'Stale in-flight poll must not revert pending fontScale'
  );

  // 4. First POST completes; second serialized POST executes right after -> both settle WITHOUT forcing extra telemetry GET
  resolveSlowPost();
  await Promise.all([save1, save2]);
  assert.deepEqual(postOrder, [{ experimentalModernUi: true }, { fontScale: 'lg' }]);
  assert.equal(
    telemetryGetCalls,
    1,
    'Pure UI setting patches must not block on an unnecessary forced /api/telemetry reload'
  );
  assert.equal(telemetryStore.getState().telemetry.settings.experimentalModernUi, true);
  assert.equal(telemetryStore.getState().telemetry.settings.fontScale, 'lg');

  // 5. Subsequent fresh poll started after commit observes authoritative diskSettings and retires local overlay cleanly
  await fetchTelemetry({ force: false });
  assert.equal(telemetryGetCalls, 2);
  assert.equal(telemetryStore.getState().telemetry.activeConversation.stepCount, 3);
  assert.equal(telemetryStore.getState().telemetry.settings.experimentalModernUi, true);
  assert.equal(telemetryStore.getState().telemetry.settings.fontScale, 'lg');
});

test('StepTableWidget virtualizes large sessions (>80 rows) with exact turn-rail boundaries, stable zebra parity, live fade-in, and zero blank top gap on tab return', (t) => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const { document: mockDoc } = createMockDom();
  globalThis.document = mockDoc;
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
  };

  t.after(() => {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  const stepTable = StepTableWidget({});
  const { stepsTablePane, stepsTableEl, stepsTbody, renderStepTable } = stepTable.refs;
  stepsTablePane.clientHeight = 500;
  stepsTablePane.clientWidth = 520;
  stepsTablePane.scrollTop = 0;

  const cols = ['step', 'model', 'tps', 'ttft', 'tokens_combo', 'cache', 'cost'];
  const makeStep = (idx, extra = {}) => ({
    stepIndex: idx,
    modelShort: idx % 5 === 0 ? '4-neon' : '4-carbon',
    tokPerSec: idx % 17 === 0 ? null : 62.5,
    selectedSpeedReason: idx % 17 === 0 ? 'below_min_output' : null,
    ttftSec: 1.2,
    inputTokens: 1200,
    cacheReadTokens: 80000,
    outputTokens: 600,
    thinkingTokens: 200,
    responseTokens: 400,
    contextTokens: 81800,
    cacheHitPct: 98.5,
    costUsd: 0.021,
    turnIndex: Math.floor((idx - 1) / 4) + 1,
    isTurnStart: (idx - 1) % 4 === 0,
    isLatestTurn: idx > 1718,
    turnPromptClean: `Turn ${Math.floor((idx - 1) / 4) + 1}`,
    ...extra,
  });

  // 1. Small dataset (<=80 rows) stays direct without virtualization or spacers
  const smallSteps = Array.from({ length: 12 }, (_, i) => makeStep(12 - i));
  renderStepTable(smallSteps, 'conv-small', cols, 'zh-CN', {
    showStepTurnRail: true,
    allConversationSteps: smallSteps,
    allowNewRowFade: false,
  });
  assert.equal(stepsTableEl.classList.contains('is-virtualized'), false);
  assert.equal(stepsTbody.children.length, 12);
  assert.equal(
    stepsTbody.children.some((tr) => tr.classList.contains('step-vspacer')),
    false
  );

  // 2. Large 1,722-step session activates transparent virtual windowing
  const isRealRow = (tr) =>
    !tr.classList.contains('step-vspacer') && !tr.classList.contains('step-vsizer');
  const totalSteps = 1722;
  const bigSteps = Array.from({ length: totalSteps }, (_, i) =>
    makeStep(
      totalSteps - i,
      i === 900
        ? { modelShort: '4-hydrogen', modelLabel: 'Gemini 4 Hydrogen', isCompactionStep: true }
        : {}
    )
  );
  const t0 = performance.now();
  renderStepTable(bigSteps, 'conv-big', cols, 'zh-CN', {
    showStepTurnRail: true,
    allConversationSteps: bigSteps,
    allowNewRowFade: false,
  });
  const initialRenderMs = performance.now() - t0;
  assert.equal(stepsTableEl.classList.contains('is-virtualized'), true);
  assert.equal(stepsTableEl.classList.contains('has-turn-rail'), true);

  const initialRealRows = stepsTbody.children.filter(isRealRow);
  const initialSpacers = stepsTbody.children.filter((tr) => tr.classList.contains('step-vspacer'));
  const initialSizers = stepsTbody.children.filter((tr) => tr.classList.contains('step-vsizer'));
  assert.equal(initialSizers.length, 1, 'Virtualized table mounts one zero-height global width sizer row');
  assert.match(
    initialSizers[0].children[1].textContent,
    /4-hydrogen/,
    'Sizer row pre-measures global widest model from off-screen row #900 on frame 1'
  );
  assert.ok(
    initialRealRows.length >= 25 && initialRealRows.length < 75,
    `Expected bounded mounted row window, got ${initialRealRows.length}`
  );
  assert.equal(initialSpacers.length, 1, 'At scrollTop=0 only bottom spacer should be mounted');
  assert.equal(initialRealRows[0].children[0].textContent, '#1722');
  assert.equal(initialRealRows[0].classList.contains('is-stripe-even'), false, 'Logical row 0 is odd');
  assert.equal(initialRealRows[1].classList.contains('is-stripe-even'), true, 'Logical row 1 is even');

  // 2.5 Hysteresis: small wheel scroll inside overscan margin skips DOM updates completely
  const initialSnapshot = [...initialRealRows];
  stepsTablePane.scrollTop = 56;
  stepsTablePane.dispatchEvent({ type: 'scroll' });
  const afterSmallScroll = stepsTbody.children.filter(isRealRow);
  assert.equal(afterSmallScroll.length, initialSnapshot.length);
  assert.equal(
    afterSmallScroll[0],
    initialSnapshot[0],
    'Small scroll within hysteresis margin must keep mounted rows untouched'
  );

  // 3. Scrolling mid-table shifts window, mounts both spacers, keeps logical parity & seamless turn-rail boundary
  const initialRowSet = new Set(initialSnapshot);
  stepsTablePane.scrollTop = 24000;
  stepsTablePane.dispatchEvent({ type: 'scroll' });
  const midRealRows = stepsTbody.children.filter(isRealRow);
  const midSpacers = stepsTbody.children.filter((tr) => tr.classList.contains('step-vspacer'));
  assert.equal(midSpacers.length, 2, 'Mid-scroll must mount both top and bottom spacers');
  assert.ok(midRealRows.length >= 25 && midRealRows.length < 75);
  assert.equal(
    midRealRows.some((tr) => tr.classList.contains('is-step-entering')),
    false,
    'Scrolling into historical rows must never trigger new-row fade-in animation'
  );

  // 3.5 Second distant jump recycles pooled <tr> nodes from the first jump (zero fresh allocations)
  stepsTablePane.scrollTop = 36000;
  stepsTablePane.dispatchEvent({ type: 'scroll' });
  const farRealRows = stepsTbody.children.filter(isRealRow);
  assert.ok(
    farRealRows.some((tr) => initialRowSet.has(tr)),
    'Distant jump must recycle previously unmounted <tr> nodes from rowPool'
  );
  assert.equal(
    stepTable.refs.stepsTheadRow.children.every((th) => !th.style.minWidth),
    true,
    'Scrolling must never ratchet th.style.minWidth and clip trailing columns'
  );
  // Return to mid-table to continue boundary checks
  stepsTablePane.scrollTop = 24000;
  stepsTablePane.dispatchEvent({ type: 'scroll' });
  const midCheckRows = stepsTbody.children.filter(isRealRow);

  // Verify logical zebra parity & turn-rail boundary continuity on first & last mounted mid rows
  for (const tr of midCheckRows) {
    const stepNum = Number(tr.children[0].textContent.replace(/^#/, ''));
    const logicalIdx = totalSteps - stepNum;
    assert.equal(
      tr.classList.contains('is-stripe-even'),
      logicalIdx % 2 === 1,
      `Row #${stepNum} (logicalIdx=${logicalIdx}) must preserve exact logical zebra parity`
    );
  }
  const firstMidRow = midCheckRows[0];
  const firstMidStepNum = Number(firstMidRow.children[0].textContent.replace(/^#/, ''));
  const firstMidIdx = totalSteps - firstMidStepNum;
  const expectedHasUp = bigSteps[firstMidIdx - 1]?.turnIndex === bigSteps[firstMidIdx]?.turnIndex;
  const firstMidRail = firstMidRow.querySelector('.turn-rail');
  assert.ok(firstMidRail, 'Mid-table virtualized row must preserve turn-rail element');
  assert.equal(
    firstMidRail.classList.contains('has-up'),
    expectedHasUp,
    'First mounted row in virtual window must compute has-up from real adjacent step outside window'
  );

  // 4. Simulating tab switch away & back (display:none resets scrollTop to 0 with unchanged bigSteps reference)
  stepsTablePane.scrollTop = 0;
  renderStepTable(bigSteps, 'conv-big', cols, 'zh-CN', {
    showStepTurnRail: true,
    allConversationSteps: bigSteps,
    allowNewRowFade: false,
  });
  const returnedRealRows = stepsTbody.children.filter(isRealRow);
  const returnedSpacers = stepsTbody.children.filter((tr) => tr.classList.contains('step-vspacer'));
  assert.equal(returnedSpacers.length, 1, 'Returning to scrollTop=0 must drop top spacer immediately');
  assert.equal(returnedRealRows[0].children[0].textContent, '#1722');

  // 5. Live new step prepended at top animates ONLY the new row even when virtualized
  const nextBigSteps = [makeStep(1723, { isLatestTurn: true }), ...bigSteps];
  renderStepTable(nextBigSteps, 'conv-big', cols, 'zh-CN', {
    showStepTurnRail: true,
    allConversationSteps: nextBigSteps,
    allowNewRowFade: true,
  });
  const liveRealRows = stepsTbody.children.filter(isRealRow);
  assert.equal(liveRealRows[0].children[0].textContent, '#1723');
  assert.equal(liveRealRows[0].classList.contains('is-step-entering'), true);
  assert.equal(liveRealRows[1].classList.contains('is-step-entering'), false);

  // 6. Narrowing filter below threshold cleanly exits virtualization
  const filteredSteps = nextBigSteps.slice(0, 20);
  renderStepTable(filteredSteps, 'conv-big', cols, 'zh-CN', {
    showStepTurnRail: true,
    allConversationSteps: nextBigSteps,
    allowNewRowFade: false,
  });
  assert.equal(stepsTableEl.classList.contains('is-virtualized'), false);
  assert.equal(stepsTbody.children.length, 20);
  assert.equal(
    stepsTbody.children.some((tr) => !isRealRow(tr)),
    false
  );

  // Verify compiled CSS ships virtualized zebra striping, sizer, spacer, and overflow-anchor rules
  const builtStyles = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(builtStyles, /\.data-table\.is-virtualized\s+tbody\s+tr\.is-stripe-even/);
  assert.match(builtStyles, /\.step-vspacer-cell/);
  assert.match(builtStyles, /\.step-vsizer-inner/);
  assert.match(builtStyles, /overflow-anchor:\s*none;/);
  assert.ok(initialRenderMs < 150, `Virtualized 1722-row initial render should stay fast (was ${initialRenderMs.toFixed(1)}ms)`);

  // 7. Large-N LOESS grid interpolation tracks trends accurately without O(N^2) stalls
  const loessXs = Array.from({ length: totalSteps }, (_, i) => i + 1);
  const loessYs = loessXs.map((x) => 80 - 30 * (x / totalSteps) + ((x * 17) % 9) - 4);
  const lt0 = performance.now();
  const bigFit = computePublicationFit(loessXs, loessYs, { minVal: 0 });
  const loessMs = performance.now() - lt0;
  assert.equal(bigFit.method, 'LOESS');
  assert.equal(bigFit.grid.length, 64);
  assert.equal(bigFit.sampleFits.length, totalSteps);
  assert.ok(bigFit.sampleFits[0] > 76 && bigFit.sampleFits[totalSteps - 1] < 54);
  assert.ok(bigFit.r2 > 0.85, `Expected high R² on smooth downward trend, got ${bigFit.r2}`);
  assert.ok(bigFit.grid.every((g) => g.ciLow <= g.fit + 1e-9 && g.fit <= g.ciHigh + 1e-9));
  assert.ok(loessMs < 80, `Interpolated 1722-sample LOESS should stay fast (was ${loessMs.toFixed(1)}ms)`);

  stepTable.destroy();
});

test('CustomSelect collision detection clamps left/right overflow and flips upward near bottom boundary', (t) => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 1200,
    innerHeight: 800,
    getComputedStyle: () => ({ overflow: 'visible', overflowX: 'visible', overflowY: 'visible' }),
    addEventListener() {},
    removeEventListener() {},
  };

  let selectComp = null;
  t.after(() => {
    selectComp?.destroy?.();
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  });

  const shell = document.createElement('div');
  shell.className = 'wm-popover-panel';
  shell.getBoundingClientRect = () => ({ left: 20, top: 40, right: 560, bottom: 620, width: 540, height: 580 });
  document.body.appendChild(shell);

  selectComp = CustomSelect({
    className: 'steps-inline-scope-select',
    modelValue: 'all',
    options: [
      { value: 'all', label: '全部汇总', meta: '1994步' },
      { value: 'main', label: '主代理', meta: '1759步' },
      { value: 'w1', label: '蜂群 #1 · @entry-runtime', meta: '17步' },
    ],
  });
  shell.appendChild(selectComp.el);

  const menuEl = selectComp.refs.menuEl;
  const triggerBtn = selectComp.refs.triggerBtn;

  // 1. Trigger near left edge with a wide 260px menu whose raw layout overflows left (-50 < 26)
  selectComp.el.getBoundingClientRect = () => ({ left: 90, top: 100, right: 190, bottom: 124, width: 100, height: 24 });
  triggerBtn.getBoundingClientRect = () => ({ left: 90, top: 100, right: 190, bottom: 124, width: 100, height: 24 });
  menuEl.offsetWidth = 260;
  menuEl.offsetHeight = 180;
  menuEl.scrollHeight = 180;
  menuEl.getBoundingClientRect = () => ({ left: -50, top: 128, right: 210, bottom: 308, width: 260, height: 180 });

  triggerBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
  assert.equal(menuEl.style.left, '0px');
  assert.equal(menuEl.style.right, 'auto');
  assert.equal(menuEl.classList.contains('is-above'), false);

  // 2. Trigger near right edge (460..540) overflows right (460+260 > 554) -> right-aligns cleanly inside shell
  triggerBtn.dispatchEvent({ type: 'click', stopPropagation() {} }); // close
  selectComp.el.getBoundingClientRect = () => ({ left: 460, top: 100, right: 540, bottom: 124, width: 80, height: 24 });
  triggerBtn.getBoundingClientRect = () => ({ left: 460, top: 100, right: 540, bottom: 124, width: 80, height: 24 });
  menuEl.getBoundingClientRect = () => ({ left: 460, top: 128, right: 720, bottom: 308, width: 260, height: 180 });

  triggerBtn.dispatchEvent({ type: 'click', stopPropagation() {} }); // reopen
  assert.equal(menuEl.style.left, '-180px', 'Right-edge menu shifts left to align with trigger right edge (540-260=280, offset=-180)');
  assert.equal(menuEl.style.right, 'auto');

  // 3. Trigger near bottom edge (580..604) flips upward (.is-above)
  triggerBtn.dispatchEvent({ type: 'click', stopPropagation() {} }); // close
  selectComp.el.getBoundingClientRect = () => ({ left: 90, top: 580, right: 190, bottom: 604, width: 100, height: 24 });
  triggerBtn.getBoundingClientRect = () => ({ left: 90, top: 580, right: 190, bottom: 604, width: 100, height: 24 });
  menuEl.getBoundingClientRect = () => ({ left: 90, top: 608, right: 350, bottom: 788, width: 260, height: 180 });

  triggerBtn.dispatchEvent({ type: 'click', stopPropagation() {} }); // reopen
  assert.equal(menuEl.classList.contains('is-above'), true);
  assert.equal(menuEl.style.bottom, 'calc(100% + 4px)');
  assert.equal(menuEl.style.top, 'auto');
});

test('Capsule odometer digit rolling (0.15s) and color transition (0.1s) stay strictly isolated to Modern UI', (t) => {
  const prevDoc = globalThis.document;
  const { document } = createMockDom();
  globalThis.document = document;
  t.after(() => {
    globalThis.document = prevDoc;
  });

  // Tokenizer keys integer digits right-to-left by place value and fraction digits left-to-right
  const toks = tokenizeCapsuleOdometerText('37.2 t/s');
  assert.deepEqual(
    toks.map((x) => `${x.key}=${x.kind === 'digit' ? x.digit : x.text}`),
    ['n:0:i:1=3', 'n:0:i:0=7', 'n:0:dot=.', 'n:0:f:0=2', 's:0= t/s']
  );

  const host = document.createElement('div');
  const slotText = document.createElement('span');
  slotText.className = 'wm-slot-text wm-speed-text';
  host.appendChild(slotText);
  document.body.appendChild(host);

  // 1. Classic UI (no data-modern-ui): strictly plain text, zero odometer reels
  patchCapsuleOdometerText(slotText, '37.2 t/s', { resetKey: 'tps' });
  assert.equal(slotText.textContent, '37.2 t/s');
  assert.equal(slotText.querySelectorAll('.wm-od-digit').length, 0);
  assert.equal(slotText.hasAttribute('data-od-active'), false);

  // 2. Enable Modern UI: builds 3 digit reels in place and preserves reel identity across digit updates
  host.setAttribute('data-modern-ui', 'true');
  patchCapsuleOdometerText(slotText, '37.2 t/s', { resetKey: 'tps' });
  assert.equal(slotText.getAttribute('data-od-active'), '1');
  assert.equal(slotText.getAttribute('data-od-value'), '37.2 t/s');
  assert.equal(slotText.getAttribute('aria-label'), '37.2 t/s');
  const reels1 = slotText.querySelectorAll('.wm-od-digit');
  assert.equal(reels1.length, 3);
  const tensTrack = reels1[0].querySelector('.wm-od-track');
  const onesTrack = reels1[1].querySelector('.wm-od-track');
  const fracTrack = reels1[2].querySelector('.wm-od-track');
  assert.equal(tensTrack.style.getPropertyValue('--od-val'), '3');
  assert.equal(onesTrack.style.getPropertyValue('--od-val'), '7');
  assert.equal(fracTrack.style.getPropertyValue('--od-val'), '2');

  // Update 37.2 -> 38.5: same DOM reel nodes reused, only changed digits update --od-val
  patchCapsuleOdometerText(slotText, '38.5 t/s', { resetKey: 'tps' });
  const reels2 = slotText.querySelectorAll('.wm-od-digit');
  assert.equal(reels2[0], reels1[0]);
  assert.equal(reels2[1], reels1[1]);
  assert.equal(reels2[2], reels1[2]);
  assert.equal(tensTrack.style.getPropertyValue('--od-val'), '3');
  assert.equal(onesTrack.style.getPropertyValue('--od-val'), '8');
  assert.equal(fracTrack.style.getPropertyValue('--od-val'), '5');

  // Digit count change 38.5 -> 9.4 -> 12.6 preserves ones & tenths place reels cleanly
  patchCapsuleOdometerText(slotText, '9.4 t/s', { resetKey: 'tps' });
  const reels3 = slotText.querySelectorAll('.wm-od-digit');
  assert.equal(reels3.length, 2);
  assert.equal(reels3[0], reels1[1], 'Ones-place reel stays mounted across 2-digit -> 1-digit shrink');
  assert.equal(reels3[1], reels1[2], 'Tenths-place reel stays mounted');
  assert.equal(onesTrack.style.getPropertyValue('--od-val'), '9');
  assert.equal(fracTrack.style.getPropertyValue('--od-val'), '4');

  patchCapsuleOdometerText(slotText, '12.6 t/s', { resetKey: 'tps' });
  const reels4 = slotText.querySelectorAll('.wm-od-digit');
  assert.equal(reels4.length, 3);
  assert.equal(reels4[1], reels1[1], 'Ones-place reel stays mounted across 1-digit -> 2-digit grow');
  assert.equal(reels4[2], reels1[2], 'Tenths-place reel stays mounted');
  assert.equal(reels4[0].querySelector('.wm-od-track').style.getPropertyValue('--od-val'), '1');
  assert.equal(onesTrack.style.getPropertyValue('--od-val'), '2');
  assert.equal(fracTrack.style.getPropertyValue('--od-val'), '6');

  // 3. Disable Modern UI: restores clean plain text with zero leftover odometer DOM
  host.removeAttribute('data-modern-ui');
  patchCapsuleOdometerText(slotText, '12.6 t/s', { resetKey: 'tps' });
  assert.equal(slotText.textContent, '12.6 t/s');
  assert.equal(slotText.querySelectorAll('.wm-od-digit').length, 0);
  assert.equal(slotText.hasAttribute('data-od-active'), false);

  // 4. Compiled CSS strictly scopes 150ms roll & 100ms color transition under [data-modern-ui="true"]
  const builtStyles = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(builtStyles, /\.steps-inline-scope-select\s+\.select-menu[\s\S]*?left:\s*auto;\s*right:\s*0;/);
  assert.match(
    builtStyles,
    /\[data-modern-ui="true"\]\s+\.select-menu,[\s\S]*?animation:\s*anim-modern-tip-fade\s+120ms/
  );
  assert.match(builtStyles, /\[data-modern-ui="true"\]\s+\.select-menu\.is-above/);
  assert.match(
    builtStyles,
    /\[data-modern-ui="true"\]\s+\.wm-od-track\s*\{[^}]*transition:\s*transform\s+150ms/
  );
  assert.match(
    builtStyles,
    /\[data-modern-ui="true"\]\s+\.wm-multi-label\s*\{[^}]*transition:\s*color\s+100ms/
  );
  assert.doesNotMatch(
    builtStyles,
    /(?:^|\n)\.wm-od-track\s*\{/,
    'Odometer roll CSS must ONLY exist under [data-modern-ui="true"]'
  );
  // 5. Breakdown popovers translate on GPU layer only (no top/left layout transition jitter)
  assert.match(
    builtStyles,
    /\.cons-breakdown-popover\s*\{[^}]*left:\s*0;[^}]*top:\s*0;[^}]*transform:\s*translate3d\(var\(--pop-x,\s*8px\),\s*var\(--pop-y,\s*8px\),\s*0\);[^}]*will-change:\s*transform;/
  );
  assert.match(
    builtStyles,
    /\[data-modern-ui="true"\]\s+\.cons-breakdown-popover\.is-tracking\s*\{\s*transition:\s*transform\s+150ms\s+var\(--ease-modern\);\s*\}/
  );
  assert.match(
    builtStyles,
    /\.trend-tooltip\.is-rich-breakdown\s*\{[^}]*left:\s*0;[^}]*transform:\s*translate3d\(var\(--tip-x,\s*0px\),\s*var\(--tip-y,\s*0px\),\s*0\)/
  );
  assert.match(
    builtStyles,
    /\[data-modern-ui="true"\]\s+\.trend-tooltip\.is-rich-breakdown\.is-tracking\s*\{\s*transition:\s*transform\s+150ms\s+var\(--ease-modern\);\s*\}/
  );
  assert.match(
    builtStyles,
    /@starting-style\s*\{[\s\S]*?\[data-modern-ui="true"\]\s+\.wm-od-track\s*\{\s*transform:\s*translate3d\(0,\s*0,\s*0\);/
  );
  assert.match(
    builtStyles,
    /\.trend-tooltip\.is-floating-tip\s*\{[^}]*left:\s*0;[^}]*transform:\s*translate3d\(var\(--tip-x,\s*0px\),\s*var\(--tip-y,\s*0px\),\s*0\)/
  );

  // 6. Pending TTFT during a new step must NOT flash --s or destroy odometer reels before TTFT is calculated
  const capHost = document.createElement('div');
  capHost.setAttribute('data-modern-ui', 'true');
  const capSlots = [
    createCapsuleSlotNode(0, 'tps'),
    createCapsuleSlotNode(1, 'ttft'),
    createCapsuleSlotNode(2, 'context'),
    createCapsuleSlotNode(3, 'none'),
    createCapsuleSlotNode(4, 'none'),
  ];
  const capSeps = Array.from({ length: 4 }, () => document.createElement('span'));
  for (const s of capSlots) capHost.appendChild(s.el);
  document.body.appendChild(capHost);

  const slotKeys = ['tps', 'ttft', 'context'];

  // Poll 1: Step #10075 finished with ttft = 13.3s
  syncCapsuleSlotNodes(
    capSlots,
    capSeps,
    slotKeys,
    buildCapsuleSlotContext({
      activeConversation: {
        cascadeId: 'df95cefc-791c-4ece-b433-d6ac4ad10316',
        isRunning: false,
        stepCount: 2131,
        latestTokPerSec: 7.4,
        latestTtftSec: 13.3,
        lastKnownTtftSec: 13.3,
        context: { totalTokens: 130000, compactionLimitTokens: 256000 },
      },
    })
  );
  assert.equal(capSlots[1].textSpan.getAttribute('data-od-value'), '13.3s');
  const ttftReelsStep1 = capSlots[1].textSpan.querySelectorAll('.wm-od-digit');
  assert.equal(ttftReelsStep1.length, 3);
  const savedOnesReel = ttftReelsStep1[1];
  const savedTenthsReel = ttftReelsStep1[2];

  // Poll 2: Step #10077 streaming (10.5 t/s, latestTtftSec = null while TTFT is not calculated yet, even without lastKnownTtftSec)
  syncCapsuleSlotNodes(
    capSlots,
    capSeps,
    slotKeys,
    buildCapsuleSlotContext({
      activeConversation: {
        cascadeId: 'df95cefc-791c-4ece-b433-d6ac4ad10316',
        isRunning: true,
        stepCount: 2132,
        latestTokPerSec: 10.5,
        latestTtftSec: null,
        context: { totalTokens: 131000, compactionLimitTokens: 256000 },
      },
    })
  );
  assert.equal(
    capSlots[1].textSpan.getAttribute('data-od-value'),
    '13.3s',
    'TTFT slot keeps previous valid TTFT while new step TTFT is still pending'
  );
  const ttftReelsPending = capSlots[1].textSpan.querySelectorAll('.wm-od-digit');
  assert.equal(ttftReelsPending.length, 3);
  assert.equal(ttftReelsPending[1], savedOnesReel);
  assert.equal(ttftReelsPending[2], savedTenthsReel);

  // Poll 2b: Cold-mounted slot mid-generation resolves lastKnownTtftSec / recentSteps fallback instead of --s
  const coldSlotCtx = buildCapsuleSlotContext({
    activeConversation: {
      cascadeId: 'df95cefc-791c-4ece-b433-d6ac4ad10316',
      isRunning: true,
      stepCount: 2132,
      latestTokPerSec: 10.5,
      latestTtftSec: null,
      lastKnownTtftSec: 13.3,
      context: { totalTokens: 131000, compactionLimitTokens: 256000 },
    },
  });
  assert.equal(coldSlotCtx.ttft, 13.3);

  // Poll 3: Step #10077 TTFT calculated (8.4s) -> rolls directly 13.3s -> 8.4s on the preserved DOM reels
  syncCapsuleSlotNodes(
    capSlots,
    capSeps,
    slotKeys,
    buildCapsuleSlotContext({
      activeConversation: {
        cascadeId: 'df95cefc-791c-4ece-b433-d6ac4ad10316',
        isRunning: true,
        stepCount: 2132,
        latestTokPerSec: 10.5,
        latestTtftSec: 8.4,
        lastKnownTtftSec: 8.4,
        context: { totalTokens: 131000, compactionLimitTokens: 256000 },
      },
    })
  );
  assert.equal(capSlots[1].textSpan.getAttribute('data-od-value'), '8.4s');
  const ttftReelsResolved = capSlots[1].textSpan.querySelectorAll('.wm-od-digit');
  assert.equal(ttftReelsResolved.length, 2);
  assert.equal(ttftReelsResolved[0], savedOnesReel, 'Ones reel stays mounted for 150ms roll');
  assert.equal(ttftReelsResolved[1], savedTenthsReel, 'Tenths reel stays mounted for 150ms roll');
  assert.equal(savedOnesReel.querySelector('.wm-od-track').style.getPropertyValue('--od-val'), '8');
  assert.equal(savedTenthsReel.querySelector('.wm-od-track').style.getPropertyValue('--od-val'), '4');

  // Poll 4: Switching to a different conversation with no TTFT resets cleanly to --s without leaking
  syncCapsuleSlotNodes(
    capSlots,
    capSeps,
    slotKeys,
    buildCapsuleSlotContext({
      activeConversation: {
        cascadeId: 'dddddddd-7777-8888-9999-eeeeeeeeeeee',
        isRunning: false,
        stepCount: 8,
        latestTokPerSec: 120.5,
        latestTtftSec: null,
        recentSteps: [],
        context: { totalTokens: 64000, compactionLimitTokens: 256000 },
      },
    })
  );
  assert.equal(capSlots[1].textSpan.textContent, '--s');
  assert.equal(capSlots[1].textSpan.hasAttribute('data-od-active'), false);
});

test('modern-ui floating hover tooltip rules exclude inline .wm-hover-tip.is-preview inside Shadow DOM popover', () => {
  const stylesCss = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(
    stylesCss,
    /:host\(\[data-modern-ui="true"\]\)\s+\.wm-hover-tip:not\(\.is-preview\)/,
    'Shadow DOM modern-ui floating .wm-hover-tip chrome must not bleed into inline Settings preview'
  );
  assert.doesNotMatch(
    stylesCss,
    /:host\(\[data-modern-ui="true"\]\)\s+\.wm-hover-tip(?:\.is-above)?\s*[,{]/,
    'No unguarded :host([data-modern-ui="true"]) .wm-hover-tip rule may override .wm-hover-tip.is-preview'
  );
  assert.match(
    stylesCss,
    /\.wm-hover-tip\.is-preview\s*\{[^}]*overflow:\s*visible;[^}]*contain:\s*none;/,
    'Inline hover preview resets overflow and contain from floating .wm-hover-tip'
  );
});

test('EditableSlotList supports continuous pointer-following drag, smooth sibling displacement, deferred mid-drag setProps, and Escape revert', async (t) => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCancelRaf = globalThis.cancelAnimationFrame;

  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

  let comp = null;
  t.after(() => {
    comp?.destroy?.();
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.cancelAnimationFrame = prevCancelRaf;
  });

  const previews = [];
  const commits = [];
  comp = EditableSlotList({
    items: ['metrics', 'context', 'quotas'],
    options: [
      { value: 'metrics', label: 'Metrics' },
      { value: 'context', label: 'Context' },
      { value: 'quotas', label: 'Quotas' },
    ],
    minItems: 0,
    maxItems: 4,
    onPreview: (items) => previews.push(items),
    onChange: (items) => commits.push(items),
  });
  document.body.appendChild(comp.el);

  const listEl = comp.refs.listEl;
  listEl.getBoundingClientRect = () => ({ left: 0, top: 100, right: 320, bottom: 199, width: 320, height: 99 });
  for (let i = 0; i < 3; i += 1) {
    const rowEl = listEl.children[i];
    rowEl.getBoundingClientRect = () => ({
      left: 0,
      top: 100 + i * 33,
      right: 320,
      bottom: 100 + i * 33 + 28,
      width: 320,
      height: 28,
    });
  }

  // Drag directly from the row's select-trigger body (stepless continuous follow)
  const row0 = listEl.children[0];
  const row1 = listEl.children[1];
  const row2 = listEl.children[2];
  const row0Trigger = row0.querySelector('.select-trigger');
  row0.dispatchEvent({
    type: 'pointerdown',
    target: row0Trigger,
    button: 0,
    clientX: 120,
    clientY: 114,
    preventDefault() {},
    stopPropagation() {},
  });

  // 1) Move 15px downward + 20px right: continuous translate3d before crossing row 1 midpoint
  document.dispatchEvent({ type: 'pointermove', clientX: 140, clientY: 129, preventDefault() {} });
  assert.equal(listEl.classList.contains('is-dragging-list'), true);
  assert.equal(row0.classList.contains('is-dragging'), true);
  assert.equal(row1.classList.contains('is-drag-sibling'), true);
  assert.match(row0.style.transform, /translate3d\(4\.40px, 15\.00px, 0\) scale\(1\.015\)/);
  assert.equal(previews.length, 0, 'Order stays unchanged before midpoint threshold');

  // 2) Background poll calls setProps mid-drag -> must not tear down or reset active dragged transform
  comp.refs.setProps({ items: ['metrics', 'context', 'quotas'] });
  assert.match(row0.style.transform, /translate3d\(4\.40px, 15\.00px, 0\)/);

  // 3) Drag continuously past row 2 midpoint -> siblings slide up smoothly by -33px and badges update live
  document.dispatchEvent({ type: 'pointermove', clientX: 120, clientY: 186, preventDefault() {} });
  assert.deepEqual(previews.at(-1), ['context', 'quotas', 'metrics']);
  assert.equal(row1.style.transform, 'translate3d(0px, -33.00px, 0)');
  assert.equal(row2.style.transform, 'translate3d(0px, -33.00px, 0)');
  assert.equal(row0.querySelector('.slot-index-badge').textContent, '3');
  assert.equal(row1.querySelector('.slot-index-badge').textContent, '1');
  assert.equal(row2.querySelector('.slot-index-badge').textContent, '2');
  assert.equal(commits.length, 0, 'No persistence before drop');

  // 4) Release commits once immediately and runs FLIP drop settle on target row
  document.dispatchEvent({ type: 'pointerup', clientX: 120, clientY: 186 });
  assert.equal(listEl.classList.contains('is-dragging-list'), false);
  assert.deepEqual(commits, [['context', 'quotas', 'metrics']]);
  assert.equal(row2.classList.contains('is-settling'), true, 'Target row enters smooth drop settle');
  assert.equal(row2.style.transform, 'translate3d(0.00px, 1.50px, 0) scale(1.015)');
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(row2.style.transform, 'translate3d(0px, 0px, 0)', 'Settle transitions smoothly to resting slot');

  // 5) Drag and press Escape -> cleanly reverts order and clears drag classes
  const row0Handle = listEl.children[0].querySelector('.slot-drag-handle');
  row0Handle.dispatchEvent({
    type: 'pointerdown',
    button: 0,
    clientX: 10,
    clientY: 114,
    preventDefault() {},
    stopPropagation() {},
  });
  document.dispatchEvent({ type: 'pointermove', clientX: 10, clientY: 155, preventDefault() {} });
  assert.deepEqual(previews.at(-1), ['quotas', 'context', 'metrics']);
  document.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(listEl.classList.contains('is-dragging-list'), false);
  assert.deepEqual(comp.refs.getItems(), ['context', 'quotas', 'metrics']);
  assert.equal(commits.length, 1, 'Cancelled drag does not commit');
});

test('Large Trend metric cards support unified 1-4 metrics across Hover & Live Overview, sync/detach cleanly, and dim overflow item #4', async (t) => {
  const prevDoc = globalThis.document;
  const { document } = createMockDom();
  globalThis.document = document;
  let hoverMatrix = null;
  let overviewMatrix = null;
  let slotList = null;
  t.after(() => {
    slotList?.destroy();
    hoverMatrix?.destroy();
    overviewMatrix?.destroy();
    globalThis.document = prevDoc;
  });

  // 1) Value/unit splitter & sparkline geometry edge cases
  assert.deepEqual(splitMetricValueAndUnit('82.3 tok/s'), { main: '82.3', unit: 'tok/s' });
  assert.deepEqual(splitMetricValueAndUnit('1.15s'), { main: '1.15', unit: 's' });
  assert.deepEqual(splitMetricValueAndUnit('94.5%'), { main: '94.5', unit: '%' });
  assert.deepEqual(splitMetricValueAndUnit('$0.042'), { main: '$0.042', unit: '' });
  assert.deepEqual(splitMetricValueAndUnit('—'), { main: '—', unit: '' });

  const emptyGeom = buildSparklineGeometry([]);
  assert.equal(emptyGeom.hasLine, false);
  assert.equal(emptyGeom.hasDot, false);

  const singleGeom = buildSparklineGeometry([42]);
  assert.equal(singleGeom.hasLine, true);
  assert.equal(singleGeom.hasDot, true);

  const flatGeom = buildSparklineGeometry([50, 50, 50]);
  assert.equal(flatGeom.hasLine, true);
  assert.ok(flatGeom.linePoints.split(' ').length === 3);

  const mockData = buildStructurePreviewTelemetry(
    {},
    {
      hoverSyncOverviewMetrics: false,
      hoverMetricStyle: 'large',
      hoverMetrics: ['tps', 'ttft', 'step_cost', 'avg_tps'],
      overviewMetricStyle: 'medium',
      overviewMetrics: ['tps', 'ttft', 'avg_tps', 'step_cost'],
    }
  );
  const steps = mockData.activeConversation.sparklineSteps;
  for (const key of [
    'tps',
    'ttft',
    'avg_tps',
    'step_cost',
    'session_cost',
    'cache_hit',
    'session_tokens',
    'context_usage',
  ]) {
    const series = extractOverviewMetricSeries(key, steps, { maxPoints: 16, limitTokens: 256000 });
    assert.equal(series.length, 16, `Metric ${key} extracts up to maxPoints chronological points`);
    assert.ok(series.every((n) => Number.isFinite(n)), `Metric ${key} contains finite values`);
  }
  // Chronological check: oldest first -> newest last (matches latest mock step 68.4 tok/s)
  const tpsSeries = extractOverviewMetricSeries('tps', steps, { maxPoints: 14 });
  assert.equal(tpsSeries.at(-1), 68.4);
  assert.equal(tpsSeries[0], 64.8);

  // Adaptive spec scales step count smoothly with available pixel width
  const narrowSpec = resolveAdaptiveSparklineSpec(38, 3);
  const default3Spec = resolveAdaptiveSparklineSpec(0, 3);
  const default2Spec = resolveAdaptiveSparklineSpec(0, 2);
  const default1Spec = resolveAdaptiveSparklineSpec(0, 1);
  const ultraWideSpec = resolveAdaptiveSparklineSpec(500, 1);
  assert.equal(narrowSpec.width, 38);
  assert.equal(narrowSpec.maxPoints, 5);
  assert.equal(default3Spec.width, 74);
  assert.equal(default3Spec.maxPoints, 9);
  assert.equal(default2Spec.width, 136);
  assert.equal(default2Spec.maxPoints, 18);
  assert.equal(default1Spec.width, 248);
  assert.equal(default1Spec.maxPoints, 33);
  assert.equal(ultraWideSpec.maxPoints, 48);

  // 2) Detached Hover renders top 3 of its 4-metric list in Large mode, while Overview stays in Medium (4 cols)
  const prevRO = globalThis.ResizeObserver;
  const roInstances = [];
  globalThis.ResizeObserver = class MockResizeObserver {
    constructor(cb) {
      this.cb = cb;
      this.observed = new Set();
      roInstances.push(this);
    }
    observe(el) {
      this.observed.add(el);
    }
    unobserve(el) {
      this.observed.delete(el);
    }
    disconnect() {
      this.observed.clear();
    }
    emit(entries) {
      this.cb(entries);
    }
  };
  try {
    hoverMatrix = MetricMatrixWidget({ mode: 'hover', preview: true });
    overviewMatrix = MetricMatrixWidget({ mode: 'overview', preview: true });

    hoverMatrix.refs.update({ data: mockData });
    overviewMatrix.refs.update({ data: mockData });

    assert.equal(hoverMatrix.el.classList.contains('is-large-trend'), true);
    assert.equal(hoverMatrix.el.getAttribute('data-cols'), '3');
    assert.equal(hoverMatrix.el.children.length, 3);
    const card0 = hoverMatrix.el.children[0];
    assert.equal(card0.classList.contains('is-trend-card'), true);
    assert.equal(card0.querySelector('.cell-trend-num').textContent, '68.4');
    assert.equal(card0.querySelector('.cell-trend-unit').textContent, 'tok/s');
    assert.equal(card0.querySelector('.cell-sparkline-svg').getAttribute('viewBox'), '0 0 74 34');
    assert.equal(
      card0.querySelector('.cell-sparkline-line').getAttribute('points').split(' ').length,
      default3Spec.maxPoints
    );
    assert.equal(card0.querySelector('.cell-sparkline-axis'), null);
    assert.ok(card0.querySelector('.cell-sparkline-area').getAttribute('d').startsWith('M '));

    // Live ResizeObserver adapts each card independently to narrow vs wide sparkline space
    const hoverRO = roInstances[0];
    const wrap0 = card0.querySelector('.cell-sparkline-wrap');
    const wrap1 = hoverMatrix.el.children[1].querySelector('.cell-sparkline-wrap');
    hoverRO.emit([
      { target: wrap0, contentRect: { width: 42 } },
      { target: wrap1, contentRect: { width: 120 } },
    ]);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(card0.querySelector('.cell-sparkline-svg').getAttribute('viewBox'), '0 0 42 34');
    assert.equal(
      card0.querySelector('.cell-sparkline-line').getAttribute('points').split(' ').length,
      resolveAdaptiveSparklineSpec(42, 3).maxPoints
    );
    assert.equal(
      hoverMatrix.el.children[1].querySelector('.cell-sparkline-svg').getAttribute('viewBox'),
      '0 0 120 34'
    );
    assert.equal(
      hoverMatrix.el.children[1].querySelector('.cell-sparkline-line').getAttribute('points').split(' ').length,
      resolveAdaptiveSparklineSpec(120, 3).maxPoints
    );

    // Overview stays in 4-column medium mode when detached
    assert.equal(overviewMatrix.el.classList.contains('is-large-trend'), false);
    assert.equal(overviewMatrix.el.getAttribute('data-cols'), '4');
    assert.equal(overviewMatrix.el.children.length, 4);

    // 3) Synced mode (hoverSyncOverviewMetrics: true) mirrors overviewMetricStyle === 'large' across BOTH Overview and Hover
    const syncedLargeData = buildStructurePreviewTelemetry(
      {},
      {
        hoverSyncOverviewMetrics: true,
        hoverMetricStyle: 'medium',
        overviewMetricStyle: 'large',
        overviewMetrics: ['tps', 'ttft', 'avg_tps', 'step_cost'],
      }
    );
    hoverMatrix.refs.update({ data: syncedLargeData });
    overviewMatrix.refs.update({ data: syncedLargeData });
    assert.equal(overviewMatrix.el.classList.contains('is-large-trend'), true);
    assert.equal(overviewMatrix.el.getAttribute('data-cols'), '3');
    assert.equal(overviewMatrix.el.children.length, 3);
    assert.equal(hoverMatrix.el.classList.contains('is-large-trend'), true);
    assert.equal(hoverMatrix.el.getAttribute('data-cols'), '3');

    // 4) 2-card and 1-card large modes reset stale col widths & scale both viewBox and step count cleanly
    hoverMatrix.refs.update({
      data: buildStructurePreviewTelemetry(
        {},
        { hoverSyncOverviewMetrics: false, hoverMetricStyle: 'large', hoverMetrics: ['tps', 'ttft'] }
      ),
    });
    assert.equal(hoverMatrix.el.getAttribute('data-cols'), '2');
    assert.equal(
      hoverMatrix.el.children[0].querySelector('.cell-sparkline-svg').getAttribute('viewBox'),
      '0 0 136 34'
    );
    assert.equal(
      hoverMatrix.el.children[0].querySelector('.cell-sparkline-line').getAttribute('points').split(' ').length,
      default2Spec.maxPoints
    );

    hoverMatrix.refs.update({
      data: buildStructurePreviewTelemetry(
        {},
        { hoverSyncOverviewMetrics: false, hoverMetricStyle: 'large', hoverMetrics: ['tps'] }
      ),
    });
    assert.equal(hoverMatrix.el.getAttribute('data-cols'), '1');
    assert.equal(hoverMatrix.el.children.length, 1);
    assert.equal(
      hoverMatrix.el.children[0].querySelector('.cell-sparkline-svg').getAttribute('viewBox'),
      '0 0 248 34'
    );
    assert.equal(
      hoverMatrix.el.children[0].querySelector('.cell-sparkline-line').getAttribute('points').split(' ').length,
      default1Spec.maxPoints
    );

    // 5) Switching back to medium restores all 4 compact metric cards from the same list
    hoverMatrix.refs.update({
      data: buildStructurePreviewTelemetry(
        {},
        {
          hoverSyncOverviewMetrics: false,
          hoverMetricStyle: 'medium',
          hoverMetrics: ['tps', 'ttft', 'avg_tps', 'step_cost'],
        }
      ),
    });
    assert.equal(hoverMatrix.el.classList.contains('is-large-trend'), false);
    assert.equal(hoverMatrix.el.getAttribute('data-cols'), '4');
    assert.equal(hoverMatrix.el.children.length, 4);
    assert.equal(hoverMatrix.el.children[0].classList.contains('is-trend-card'), false);
  } finally {
    globalThis.ResizeObserver = prevRO;
  }

  // 6) EditableSlotList dims item #4 (index >= 3) in Large mode and clears dim on Medium
  const { EditableSlotList } = await import('../src/components/settings/EditableSlotList.js');
  slotList = EditableSlotList({
    items: ['tps', 'ttft', 'avg_tps', 'step_cost'],
    options: [
      { value: 'tps', label: 'TPS' },
      { value: 'ttft', label: 'TTFT' },
      { value: 'avg_tps', label: 'Avg TPS' },
      { value: 'step_cost', label: 'Cost' },
    ],
    minItems: 1,
    maxItems: 4,
    dimmedFromIndex: 3,
    dimmedTagText: '大尺寸隐藏',
  });
  const dimRows = slotList.el.querySelectorAll('.editable-slot-row');
  assert.equal(dimRows[2].classList.contains('is-dimmed'), false);
  assert.equal(dimRows[3].classList.contains('is-dimmed'), true);
  assert.equal(dimRows[3].querySelector('.slot-dimmed-tag').hasAttribute('hidden'), false);
  slotList.refs.setProps({ dimmedFromIndex: null });
  assert.equal(dimRows[3].classList.contains('is-dimmed'), false);
  assert.equal(dimRows[3].querySelector('.slot-dimmed-tag').hasAttribute('hidden'), true);
});

test('host theme recovery parses modern CSS colors, avoids self-fallback trap, syncs fallback styles, and caches across restarts', async (t) => {
  const os = await import('node:os');
  const path = await import('node:path');
  const vm = await import('node:vm');
  const {
    HOST_THEME_FALLBACK_STYLE_ID,
    buildHostThemeFallbackCss,
    getHostThemeSignature,
    injectHostThemeFallbackIntoHtml,
    normalizeHostThemeSnapshot,
  } = await import('../shared/host-theme.mjs');
  const {
    captureNativeHostThemeSnapshot,
    hasNativeHostTheme,
    syncHostThemeFallback,
  } = await import('../src/core/appearance.js');
  const {
    getEffectiveHostTheme,
    recordLiveCdpHostTheme,
    recordPreloadHostTheme,
    resetHostThemeStoreForTests,
  } = await import('../backend/host-theme-store.mjs');
  const { readCachedHostThemeSnapshotSync } = await import('../backend/http-helpers.mjs');
  const { buildHostThemeProbeSnippet } = await import('../backend/window-bridge.mjs');

  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-host-theme-test-'));

  t.after(() => {
    resetHostThemeStoreForTests();
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup error
    }
  });

  // 1) Modern CSS color parsing: color(srgb), oklch, oklab, and bare Tailwind HSL triplets
  assert.ok(parseCssColorLuminance('color(srgb 0.11 0.12 0.16)') < 0.2);
  assert.ok(parseCssColorLuminance('color(srgb 0.96 0.97 0.99)') > 0.9);
  assert.ok(parseCssColorLuminance('oklch(0.21 0.02 260)') < 0.2);
  assert.ok(parseCssColorLuminance('oklch(0.97 0.005 260)') > 0.9);
  assert.ok(parseCssColorLuminance('oklab(0.22 -0.01 -0.02)') < 0.2);
  assert.ok(parseCssColorLuminance('222 18% 10%') < 0.2);
  assert.ok(parseCssColorLuminance('0 0% 98%') > 0.9);

  // 2) Sanitization & first-paint HTML injection ordering
  const sanitized = normalizeHostThemeSnapshot({
    colorScheme: 'dark',
    source: 'cdp',
    vars: {
      '--background': '#1e1f29',
      '--card': '#252634',
      '--foreground': '#e6eaf2',
      '--primary': 'url(javascript:alert(1))',
      '--border': '#33364a; background: red',
      '--not-allowed': '#ff0000',
    },
  });
  assert.equal(sanitized.vars['--background'], '#1e1f29');
  assert.equal(sanitized.vars['--card'], '#252634');
  assert.equal(sanitized.vars['--primary'], undefined);
  assert.equal(sanitized.vars['--border'], undefined);
  assert.equal(sanitized.vars['--not-allowed'], undefined);

  const rawIndexHtml = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(
    rawIndexHtml.indexOf('<script src="/preload.js"></script>') <
      rawIndexHtml.indexOf('rel="stylesheet"'),
    'index.html must load /preload.js before /styles.css'
  );
  const injectedHtml = injectHostThemeFallbackIntoHtml(rawIndexHtml, sanitized);
  assert.ok(injectedHtml.includes(`<style id="${HOST_THEME_FALLBACK_STYLE_ID}">`));
  assert.ok(
    injectedHtml.indexOf(`id="${HOST_THEME_FALLBACK_STYLE_ID}"`) <
      injectedHtml.indexOf('rel="stylesheet"'),
    'fallback host theme style must precede styles.css so native host styles override it'
  );
  assert.match(buildHostThemeFallbackCss(sanitized), /--background:#1e1f29/);

  // 3) Sidecar iframe without /preload.js vars does NOT get trapped by its own white tokens.css fallback
  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    matchMedia: () => ({ matches: true }),
    getComputedStyle: (el) => {
      if (el === document.documentElement) {
        return {
          backgroundColor: 'rgb(255, 255, 255)',
          color: 'rgb(30, 37, 48)',
          getPropertyValue: (p) => (p === '--surface-bg' ? 'rgb(255, 255, 255)' : ''),
        };
      }
      if (el === document.body) {
        return {
          backgroundColor: 'rgb(255, 255, 255)',
          color: 'rgb(30, 37, 48)',
          getPropertyValue: () => '',
        };
      }
      return null;
    },
  };
  assert.equal(
    detectHostColorScheme(document.documentElement),
    'dark',
    'must skip own white fallback when --surface-bg exists without host vars and follow dark OS'
  );
  assert.equal(hasNativeHostTheme(document), false);

  // 4) syncHostThemeFallback preserves SSR fallback before first telemetry arrives, updates on bridged theme,
  //    and yields cleanly once /preload.js injects native inline :root.style tokens
  const ssrStyle = document.createElement('style');
  ssrStyle.id = HOST_THEME_FALLBACK_STYLE_ID;
  ssrStyle.textContent = ':root{color-scheme:dark;--background:#1a1b26}';
  document.head.appendChild(ssrStyle);

  const preTelemetryRes = syncHostThemeFallback(undefined, {
    doc: document,
    win: globalThis.window,
    isStandalone: false,
    telemetryLoaded: false,
  });
  assert.equal(preTelemetryRes.mode, 'bridged');
  assert.equal(
    document.getElementById(HOST_THEME_FALLBACK_STYLE_ID)?.textContent,
    ':root{color-scheme:dark;--background:#1a1b26}',
    'SSR fallback style stays intact until telemetry resolves'
  );

  const bridgedRes = syncHostThemeFallback(sanitized, {
    doc: document,
    win: globalThis.window,
    isStandalone: false,
    telemetryLoaded: true,
  });
  assert.equal(bridgedRes.mode, 'bridged');
  assert.match(
    document.getElementById(HOST_THEME_FALLBACK_STYLE_ID)?.textContent || '',
    /--background:#1e1f29/
  );

  // When neither native nor bridged theme exists on a dark OS, stamps data-host-theme-fallback="dark"
  const mediaRes = syncHostThemeFallback(null, {
    doc: document,
    win: globalThis.window,
    isStandalone: false,
    telemetryLoaded: true,
  });
  assert.equal(mediaRes.mode, 'media-fallback');
  assert.equal(document.getElementById(HOST_THEME_FALLBACK_STYLE_ID), null);
  assert.equal(document.documentElement.getAttribute('data-host-theme-fallback'), 'dark');

  // Native /preload.js writes inline --background onto :root.style -> wins & captures snapshot
  document.documentElement.style.setProperty('--background', '#21252b');
  document.documentElement.style.setProperty('--foreground', '#d7dae0');
  const nativeRes = syncHostThemeFallback(sanitized, {
    doc: document,
    win: globalThis.window,
    isStandalone: false,
    telemetryLoaded: true,
  });
  assert.equal(nativeRes.mode, 'native');
  assert.equal(document.documentElement.hasAttribute('data-host-theme-fallback'), false);
  assert.equal(document.getElementById(HOST_THEME_FALLBACK_STYLE_ID), null);
  assert.equal(nativeRes.snapshot?.vars['--background'], '#21252b');
  assert.equal(captureNativeHostThemeSnapshot(document, globalThis.window)?.colorScheme, 'dark');

  // 5) Store priority across CDP, leader lease, preload cache, and http-helpers sync read
  resetHostThemeStoreForTests();
  const cacheFile = path.join(tmpDir, 'host-theme-cache.json');
  const leaseFile = path.join(tmpDir, 'window-bridge-lease.json');
  recordPreloadHostTheme(
    { colorScheme: 'dark', vars: { '--background': '#21252b', '--foreground': '#e6eaf2' } },
    { persist: true, cacheFilePath: cacheFile, nowMs: 1000 }
  );
  assert.equal(
    readCachedHostThemeSnapshotSync({ dataDir: tmpDir, nowMs: 2000 })?.vars['--background'],
    '#21252b'
  );
  fs.writeFileSync(
    leaseFile,
    JSON.stringify({
      pid: process.pid,
      updatedAtMs: 5000,
      hostTheme: {
        colorScheme: 'dark',
        source: 'cdp',
        updatedAtMs: 5000,
        vars: { '--background': '#1b1d2b', '--card': '#222436', '--foreground': '#c8d3f5' },
      },
    }),
    'utf8'
  );
  assert.equal(
    readCachedHostThemeSnapshotSync({ dataDir: tmpDir, nowMs: 6000 })?.vars['--background'],
    '#1b1d2b',
    'fresh bridge lease theme takes priority over older disk cache for zero-flash HTML injection'
  );
  assert.equal(
    getEffectiveHostTheme({ cacheFilePath: cacheFile, leaseFilePath: leaseFile, nowMs: 6000 })?.vars['--background'],
    '#1b1d2b'
  );

  recordLiveCdpHostTheme(
    { colorScheme: 'light', vars: { '--background': '#ffffff', '--foreground': '#18181b' } },
    { persist: true, cacheFilePath: cacheFile, nowMs: 9000 }
  );
  assert.equal(
    getEffectiveHostTheme({ cacheFilePath: cacheFile, leaseFilePath: leaseFile, nowMs: 9500 })?.colorScheme,
    'light'
  );

  // 6) isEquivalentTelemetry reacts to hostTheme changes
  assert.equal(
    isEquivalentTelemetry(
      { hostTheme: { colorScheme: 'dark', vars: { '--background': '#1e1f29' } } },
      { hostTheme: { colorScheme: 'light', vars: { '--background': '#ffffff' } } }
    ),
    false
  );
  assert.equal(
    getHostThemeSignature({ colorScheme: 'dark', vars: { '--background': '#1e1f29' }, updatedAtMs: 1 }),
    getHostThemeSignature({ colorScheme: 'dark', vars: { '--background': '#1e1f29' }, updatedAtMs: 999 })
  );

  // 7) CDP host theme probe snippet executes cleanly in IDE workbench DOM and extracts --vscode-* tokens
  const ideDoc = createMockDom().document;
  ideDoc.body.className = 'vscode-dark';
  const probeSnippet = buildHostThemeProbeSnippet();
  const ideResult = vm.runInNewContext(probeSnippet, {
    document: ideDoc,
    window: {
      getComputedStyle: (el) => {
        if (el === ideDoc.documentElement) {
          return {
            getPropertyValue: (k) =>
              ({
                '--vscode-sideBar-background': '#181818',
                '--vscode-editorWidget-background': '#202020',
                '--vscode-foreground': '#cccccc',
              })[k] || '',
          };
        }
        return null;
      },
    },
  });
  assert.equal(ideResult?.colorScheme, 'dark');
  assert.equal(ideResult?.vars['--background'], '#181818');
  assert.equal(ideResult?.vars['--card'], '#202020');
  assert.equal(ideResult?.vars['--foreground'], '#cccccc');
});

test('StepTableWidget virtualized column locking unscales CSS transform animations and respects pane padding', (t) => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCancelRaf = globalThis.cancelAnimationFrame;
  const prevGetComputedStyle = globalThis.getComputedStyle;

  let currentScale = 0.975;
  let panePadRight = 10;
  const colWidths = [86, 62, 76, 44, 134, 48, 46]; // sum = 496px (> 488 contentW, < 498 clientW)
  const trueTableW = colWidths.reduce((a, b) => a + b, 0);

  const { document } = createMockDom({
    resolveRect: (el) => {
      if (el.tagName === 'TH') {
        const siblings = el.parentNode?.children || [];
        const idx = siblings.indexOf(el);
        const baseW = colWidths[idx] || 60;
        return { left: 0, top: 0, right: baseW * currentScale, bottom: 28 * currentScale, width: baseW * currentScale, height: 28 * currentScale };
      }
      if (el.classList?.contains('steps-data-table')) {
        return { left: 0, top: 0, right: trueTableW * currentScale, bottom: 400 * currentScale, width: trueTableW * currentScale, height: 400 * currentScale };
      }
      if (el.tagName === 'TR') {
        return { left: 0, top: 0, right: trueTableW * currentScale, bottom: 28 * currentScale, width: trueTableW * currentScale, height: 28 * currentScale };
      }
      return { left: 0, top: 0, right: 498 * currentScale, bottom: 400 * currentScale, width: 498 * currentScale, height: 400 * currentScale };
    },
  });

  const popAncestor = document.createElement('div');
  popAncestor.className = 'wm-popover-panel';
  document.body.appendChild(popAncestor);

  const mockGetComputedStyle = (el) => {
    if (el === popAncestor) {
      return {
        transform: currentScale === 1 ? 'none' : `matrix(${currentScale}, 0, 0, ${currentScale}, 0, -4)`,
        getPropertyValue: () => '',
      };
    }
    if (el?.classList?.contains('is-step-table')) {
      return {
        paddingLeft: '0px',
        paddingRight: `${panePadRight}px`,
        transform: 'none',
        getPropertyValue: () => '',
      };
    }
    return { transform: 'none', getPropertyValue: () => '' };
  };

  globalThis.document = document;
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 820,
    getComputedStyle: mockGetComputedStyle,
  };
  globalThis.getComputedStyle = mockGetComputedStyle;
  globalThis.requestAnimationFrame = (fn) => {
    fn();
    return 1;
  };
  globalThis.cancelAnimationFrame = () => {};
  t.after(() => {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.cancelAnimationFrame = prevCancelRaf;
    globalThis.getComputedStyle = prevGetComputedStyle;
  });

  const stepTable = StepTableWidget({});
  const { stepsTablePane, stepsTableEl, stepsTheadRow, renderStepTable, refreshViewport } = stepTable.refs;
  popAncestor.appendChild(stepTable.el);
  stepsTablePane.clientWidth = 498;
  stepsTablePane.clientHeight = 400;

  const cols = ['time', 'model', 'tps', 'ttft', 'tokens_combo', 'cache', 'cost'];
  const steps = Array.from({ length: 138 }, (_, i) => ({
    stepIndex: 138 - i,
    createdAtMs: 1795600000000 - i * 10000,
    modelShort: '4-carbon',
    modelLabel: 'Gemini 4 Carbon',
    tokPerSec: 32.6,
    ttftSec: 44.3,
    contextTokens: 312200,
    inputTokens: 1000,
    cacheReadTokens: 309000,
    outputTokens: 2225,
    thinkingTokens: 25,
    responseTokens: 2200,
    cacheHitPct: 98.9,
    costUsd: 0.62,
  }));

  // 1. Render during pop-in animation (scale=0.975) with pane clientWidth=498 & paddingRight=10 (contentW=488 < 496)
  renderStepTable(steps, 'conv-138', cols, 'zh-CN', { allConversationSteps: steps });
  assert.equal(stepsTableEl.classList.contains('is-cols-locked'), true, 'Virtualized table locks columns');
  const ths = stepsTheadRow.children;
  for (let i = 0; i < cols.length; i++) {
    assert.equal(
      ths[i].style.width,
      `${colWidths[i].toFixed(2)}px`,
      `Column ${cols[i]} must unscale transform(0.975) back to true layout width ${colWidths[i]}px`
    );
  }
  assert.equal(
    stepsTableEl.style.minWidth,
    `${trueTableW}px`,
    'Table exceeding pane content width (496 > 488) must keep minWidth even when < clientWidth (498)'
  );

  // 2. Animation settles to scale=1.0 without clientWidth changing -> refreshViewport re-locks cleanly at native scale
  currentScale = 1;
  colWidths[1] = 64; // simulate slight native width change once settled
  refreshViewport();
  assert.equal(
    ths[1].style.width,
    '64.00px',
    'Settling from animated scale to 1.0 must re-measure & re-lock columns even when clientWidth is unchanged'
  );

  // 3. When popover widens so pane content width (560 - 10 = 550) fits table (498), minWidth clears cleanly
  stepsTablePane.clientWidth = 560;
  refreshViewport();
  assert.equal(stepsTableEl.style.minWidth, '', 'Wide enough pane clears horizontal minWidth');

  // 4. Changing fontScale re-syncs virtualized row heights and unlocks stale column widths immediately
  colWidths[1] = 82;
  renderStepTable(steps, 'conv-138', cols, 'zh-CN', {
    allConversationSteps: steps,
    fontScale: 'xl',
  });
  assert.equal(
    ths[1].style.width,
    '82.00px',
    'Changing fontScale must unlock and re-measure virtualized step column widths'
  );

  stepTable.destroy();
});

test('Host typography parity: Sidebar mirrors bridged host fonts in native mode and preserves CDP fonts across preload updates', async (t) => {
  const os = await import('node:os');
  const path = await import('node:path');
  const vm = await import('node:vm');
  const {
    HOST_THEME_FALLBACK_STYLE_ID,
    buildHostThemeFallbackCss,
  } = await import('../shared/host-theme.mjs');
  const { syncHostThemeFallback } = await import('../src/core/appearance.js');
  const {
    getEffectiveHostTheme,
    recordLiveCdpHostTheme,
    recordPreloadHostTheme,
    resetHostThemeStoreForTests,
  } = await import('../backend/host-theme-store.mjs');
  const { readCachedHostThemeSnapshotSync } = await import('../backend/http-helpers.mjs');
  const { buildHostThemeProbeSnippet } = await import('../backend/window-bridge.mjs');

  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-host-font-parity-'));
  t.after(() => {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    resetHostThemeStoreForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const hostSans = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const hostMono = "'Google Sans Code', ui-monospace, SFMono-Regular, monospace";
  const panelFallbackSans = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif';
  const panelFallbackMono = 'ui-monospace, SFMono-Regular, Consolas, monospace';

  // 1) buildHostThemeFallbackCss emits both --font-* and --host-font-* so tokens.css var(--host-font-*, ...) wins on SSR
  const css = buildHostThemeFallbackCss({
    colorScheme: 'dark',
    vars: {
      '--background': '#1A1B26',
      '--font-sans': hostSans,
      '--font-mono': hostMono,
    },
  });
  assert.match(css, /--host-font-sans:system-ui/);
  assert.match(css, /--host-font-mono:'Google Sans Code'/);

  // 2) Sidebar native mode (/preload.js sets inline colors only, no inline font vars):
  //    - captureNativeHostThemeSnapshot must NOT capture our own tokens.css computed --font-sans/--font-mono
  //    - syncHostThemeFallback must mirror CDP host --font-sans/--font-mono onto --host-font-sans/--host-font-mono
  const { document } = createMockDom();
  document.documentElement.style.setProperty('--background', '#1A1B26');
  document.documentElement.style.setProperty('--foreground', '#A9B1D6');

  const ssrStyle = document.createElement('style');
  ssrStyle.id = HOST_THEME_FALLBACK_STYLE_ID;
  ssrStyle.textContent = css;
  document.head.appendChild(ssrStyle);

  let ssrComputedSans = hostSans;
  let ssrComputedMono = hostMono;
  globalThis.document = document;
  globalThis.window = {
    matchMedia: () => ({ matches: true }),
    getComputedStyle: (el) => {
      if (el === document.documentElement) {
        return {
          getPropertyValue: (prop) => {
            if (prop === '--font-sans') return panelFallbackSans;
            if (prop === '--font-mono') return panelFallbackMono;
            if (prop === '--host-font-sans') return ssrComputedSans;
            if (prop === '--host-font-mono') return ssrComputedMono;
            return '';
          },
        };
      }
      return { getPropertyValue: () => '' };
    },
  };

  // Pre-telemetry first boot in native mode preserves SSR bridged fonts without flashing back to fallback
  const preRes = syncHostThemeFallback(undefined, {
    doc: document,
    win: globalThis.window,
    isStandalone: false,
    telemetryLoaded: false,
  });
  assert.equal(preRes.mode, 'native');
  assert.equal(document.documentElement.style.getPropertyValue('--host-font-sans'), hostSans);
  assert.equal(document.documentElement.style.getPropertyValue('--host-font-mono'), hostMono);
  assert.equal(
    preRes.snapshot?.vars?.['--font-sans'],
    undefined,
    'captureNativeHostThemeSnapshot must ignore computed tokens.css --font-sans when not inline'
  );
  assert.equal(
    preRes.snapshot?.vars?.['--font-mono'],
    undefined,
    'captureNativeHostThemeSnapshot must ignore computed tokens.css --font-mono when not inline'
  );

  // Telemetry loaded with CDP hostTheme keeps --host-font-sans & --host-font-mono synced in native mode
  ssrComputedSans = '';
  ssrComputedMono = '';
  const nativeWithBridge = syncHostThemeFallback(
    {
      colorScheme: 'dark',
      source: 'cdp',
      vars: { '--background': '#1A1B26', '--font-sans': hostSans, '--font-mono': hostMono },
    },
    { doc: document, win: globalThis.window, isStandalone: false, telemetryLoaded: true }
  );
  assert.equal(nativeWithBridge.mode, 'native');
  assert.equal(document.documentElement.style.getPropertyValue('--host-font-sans'), hostSans);
  assert.equal(document.documentElement.style.getPropertyValue('--host-font-mono'), hostMono);

  // If /preload.js ever injects inline --font-sans natively, --host-font-sans yields & clears cleanly
  document.documentElement.style.setProperty('--font-sans', '"Custom Preload Sans", sans-serif');
  const nativeWithInlineFont = syncHostThemeFallback(
    {
      colorScheme: 'dark',
      source: 'cdp',
      vars: { '--background': '#1A1B26', '--font-sans': hostSans, '--font-mono': hostMono },
    },
    { doc: document, win: globalThis.window, isStandalone: false, telemetryLoaded: true }
  );
  assert.equal(document.documentElement.style.getPropertyValue('--host-font-sans'), '');
  assert.equal(nativeWithInlineFont.snapshot?.vars?.['--font-sans'], '"Custom Preload Sans", sans-serif');
  assert.equal(document.documentElement.style.getPropertyValue('--host-font-mono'), hostMono);

  // Standalone browser clears bridged host typography overrides
  const standaloneRes = syncHostThemeFallback(
    { colorScheme: 'dark', vars: { '--background': '#1A1B26', '--font-sans': hostSans } },
    { doc: document, win: globalThis.window, isStandalone: true, telemetryLoaded: true }
  );
  assert.equal(standaloneRes.mode, 'standalone');
  assert.equal(document.documentElement.style.getPropertyValue('--host-font-sans'), '');
  assert.equal(document.documentElement.style.getPropertyValue('--host-font-mono'), '');

  // 3) Host theme store merges CDP typography into newer preload color snapshots (memory + persisted cache)
  resetHostThemeStoreForTests();
  const cacheFile = path.join(tmpDir, 'host-theme-cache.json');
  const leaseFile = path.join(tmpDir, 'window-bridge-lease.json');
  recordLiveCdpHostTheme(
    {
      colorScheme: 'dark',
      vars: { '--background': '#1A1B26', '--font-sans': hostSans, '--font-mono': hostMono },
    },
    { persist: true, cacheFilePath: cacheFile, nowMs: 1000 }
  );
  recordPreloadHostTheme(
    {
      colorScheme: 'dark',
      vars: { '--background': '#161722', '--foreground': '#E0E6F8' },
    },
    { persist: true, cacheFilePath: cacheFile, nowMs: 2000 }
  );
  const merged = getEffectiveHostTheme({ cacheFilePath: cacheFile, leaseFilePath: leaseFile, nowMs: 2500 });
  assert.equal(merged?.vars?.['--background'], '#161722', 'newer preload colors win');
  assert.equal(merged?.vars?.['--font-sans'], hostSans, 'CDP --font-sans survives newer preload update');
  assert.equal(merged?.vars?.['--font-mono'], hostMono, 'CDP --font-mono survives newer preload update');
  const persisted = readCachedHostThemeSnapshotSync({ dataDir: tmpDir, nowMs: 2500 });
  assert.equal(persisted?.vars?.['--font-sans'], hostSans, 'persisted cache retains CDP --font-sans');
  assert.equal(persisted?.vars?.['--background'], '#161722', 'persisted cache updates preload colors');

  // 4) CDP probe extracts --vscode-font-family & --vscode-editor-font-family even when --background exists,
  //    and falls back to usable body fontFamily when no CSS font vars exist
  const probeSnippet = buildHostThemeProbeSnippet();
  const hybridDoc = createMockDom().document;
  hybridDoc.body.className = 'dark';
  const hybridRes = vm.runInNewContext(probeSnippet, {
    document: hybridDoc,
    window: {
      getComputedStyle: (el) => {
        if (el === hybridDoc.documentElement) {
          return {
            getPropertyValue: (k) =>
              ({
                '--background': '#1A1B26',
                '--vscode-font-family': '"Segoe UI", sans-serif',
                '--vscode-editor-font-family': '"Cascadia Code", monospace',
              })[k] || '',
          };
        }
        return null;
      },
    },
  });
  assert.equal(hybridRes?.vars?.['--font-sans'], '"Segoe UI", sans-serif');
  assert.equal(hybridRes?.vars?.['--font-mono'], '"Cascadia Code", monospace');

  const bodyFontDoc = createMockDom().document;
  bodyFontDoc.body.className = 'dark';
  const bodyFontRes = vm.runInNewContext(probeSnippet, {
    document: bodyFontDoc,
    window: {
      getComputedStyle: (el) => {
        if (el === bodyFontDoc.documentElement) {
          return { getPropertyValue: (k) => (k === '--background' ? '#1A1B26' : ''), fontFamily: '' };
        }
        if (el === bodyFontDoc.body) {
          return { getPropertyValue: () => '', fontFamily: 'Inter, system-ui, sans-serif' };
        }
        return null;
      },
    },
  });
  assert.equal(bodyFontRes?.vars?.['--font-sans'], 'Inter, system-ui, sans-serif');
});

test('CapsuleBarWidget supports direct horizontal slot drag-to-reorder with variable widths, live preview, deferred update, and Escape cancel', (t) => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCancelRaf = globalThis.cancelAnimationFrame;

  const { document } = createMockDom();
  const winListeners = new Map();
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      winListeners.get(type)?.delete(fn);
    },
  };
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

  let widget = null;
  let readonlyWidget = null;
  t.after(() => {
    widget?.destroy?.();
    readonlyWidget?.destroy?.();
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.cancelAnimationFrame = prevCancelRaf;
  });

  // Read-only widget without callbacks never activates drag affordances
  readonlyWidget = CapsuleBarWidget({});
  readonlyWidget.refs.update({
    data: { settings: { topbarCapsuleSlots: ['tps', 'ttft', 'context'] } },
  });
  assert.equal(readonlyWidget.refs.hostBarEl.classList.contains('is-slot-reorderable'), false);

  const previews = [];
  const commits = [];
  widget = CapsuleBarWidget({
    onPreviewSlots: (keys) => previews.push(keys),
    onReorderSlots: (keys) => commits.push(keys),
  });
  document.body.appendChild(widget.el);

  const makeData = (slots) => ({
    settings: { windowMountMode: 'dual', topbarCapsuleSlots: slots },
    activeConversation: {
      cascadeId: 'c-drag',
      latestTokPerSec: 68.4,
      latestTtftSec: 1.1,
      context: { totalTokens: 143360, limitTokens: 256000 },
    },
  });

  widget.refs.update({ data: makeData(['tps', 'ttft', 'context']) });
  const { hostBarEl, capsuleBtn, capsuleSlots, capsuleSeps } = widget.refs;
  assert.equal(hostBarEl.classList.contains('is-slot-reorderable'), true);
  assert.ok(capsuleSlots[0].el.getAttribute('title'), 'Reorderable capsule slot exposes drag hint title');

  // Variable widths: slot 0 = 58px [100..158], sep 0 = 1px [166..167], slot 1 = 46px [175..221], sep 1 = 1px [229..230], slot 2 = 58px [238..296]
  capsuleBtn.getBoundingClientRect = () => ({ left: 91, top: 20, right: 305, bottom: 48, width: 214, height: 28 });
  const slotRects = [
    { left: 100, right: 158, top: 25, bottom: 43, width: 58, height: 18 },
    { left: 175, right: 221, top: 25, bottom: 43, width: 46, height: 18 },
    { left: 238, right: 296, top: 25, bottom: 43, width: 58, height: 18 },
  ];
  const sepRects = [
    { left: 166, right: 167, top: 28, bottom: 40, width: 1, height: 12 },
    { left: 229, right: 230, top: 28, bottom: 40, width: 1, height: 12 },
  ];
  for (let i = 0; i < 3; i += 1) {
    capsuleSlots[i].el.getBoundingClientRect = () => slotRects[i];
  }
  for (let s = 0; s < 2; s += 1) {
    capsuleSeps[s].getBoundingClientRect = () => sepRects[s];
  }

  // 1) Drag slot 1 ('ttft', width 46) left past slot 0 ('tps', width 58, centerX 129) -> ['ttft', 'tps', 'context']
  capsuleSlots[1].el.dispatchEvent({
    type: 'pointerdown',
    button: 0,
    clientX: 198,
    clientY: 34,
    preventDefault() {},
    stopPropagation() {},
  });
  document.dispatchEvent({ type: 'pointermove', clientX: 115, clientY: 34, preventDefault() {} });
  assert.equal(hostBarEl.classList.contains('is-dragging-capsule'), true);
  assert.equal(capsuleSlots[1].el.classList.contains('is-dragging'), true);
  assert.equal(capsuleSlots[0].el.classList.contains('is-drag-sibling'), true);
  assert.deepEqual(previews[previews.length - 1], ['ttft', 'tps', 'context']);
  assert.equal(commits.length, 0, 'Must not commit before pointerup');
  // Sibling slot 0 (58px) must displace right by 46 + 17 = +63px; sep 0 must shift left by -12px
  assert.equal(capsuleSlots[0].el.style.transform, 'translate3d(63.00px, 0px, 0)');
  assert.equal(capsuleSeps[0].style.transform, 'translate3d(-12.00px, 0px, 0)');
  assert.equal(capsuleSlots[2].el.style.transform, 'translate3d(0px, 0px, 0)');

  // Mid-drag update() is deferred so DOM slots never jump under the pointer
  widget.refs.update({ data: makeData(['tps', 'ttft', 'context']) });
  assert.equal(capsuleSlots[1].el.getAttribute('data-metric'), 'ttft');

  // Pressing Escape cancels cleanly and reverts preview without committing
  document.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(hostBarEl.classList.contains('is-dragging-capsule'), false);
  assert.equal(commits.length, 0);
  assert.deepEqual(previews[previews.length - 1], ['tps', 'ttft', 'context']);

  // 2) Drag slot 2 ('context', centerX 267) all the way left to index 0 (clientX 110) and release -> commits once
  capsuleSlots[2].el.dispatchEvent({
    type: 'pointerdown',
    button: 0,
    clientX: 267,
    clientY: 34,
    preventDefault() {},
    stopPropagation() {},
  });
  document.dispatchEvent({ type: 'pointermove', clientX: 110, clientY: 34, preventDefault() {} });
  assert.deepEqual(previews[previews.length - 1], ['context', 'tps', 'ttft']);
  document.dispatchEvent({ type: 'pointerup', clientX: 110, clientY: 34 });
  assert.equal(hostBarEl.classList.contains('is-dragging-capsule'), false);
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0], ['context', 'tps', 'ttft']);
  assert.equal(capsuleSlots[0].el.getAttribute('data-metric'), 'context');
  assert.equal(capsuleSlots[1].el.getAttribute('data-metric'), 'tps');
  assert.equal(capsuleSlots[2].el.getAttribute('data-metric'), 'ttft');

  // 3) Single-slot capsule disables drag affordance
  widget.refs.update({ data: makeData(['tps']) });
  assert.equal(hostBarEl.classList.contains('is-slot-reorderable'), false);
  assert.equal(capsuleSlots[0].el.getAttribute('title'), null);
});

test('Direct preview drag-to-reorder works for module stacks, 1D/2D metric grids (with vertical handoff & large-mode tail preservation), and step table columns', async (t) => {
  const { createDynamicWidgetHost } = await import('../src/registries/widgetRegistry.js');
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCancelRaf = globalThis.cancelAnimationFrame;

  const { document } = createMockDom();
  const winListeners = new Map();
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      winListeners.get(type)?.delete(fn);
    },
  };
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

  let host = null;
  let stepPreview = null;
  let sortableStepTable = null;
  t.after(() => {
    host?.destroy?.();
    stepPreview?.destroy?.();
    sortableStepTable?.destroy?.();
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.cancelAnimationFrame = prevCancelRaf;
  });

  // --- A) Dynamic Widget Host (Hover / Overview preview): vertical module drag + metric cell drag + vertical handoff ---
  const modPreviews = [];
  const modCommits = [];
  const metPreviews = [];
  const metCommits = [];
  const containerEl = document.createElement('div');
  document.body.appendChild(containerEl);

  host = createDynamicWidgetHost({
    containerEl,
    mode: 'overview',
    preview: true,
    onPreviewModules: (keys) => modPreviews.push(keys),
    onReorderModules: (keys) => modCommits.push(keys),
    onPreviewMetrics: (keys) => metPreviews.push(keys),
    onReorderMetrics: (keys) => metCommits.push(keys),
  });

  const makeOverviewData = (style = 'large', metrics = ['tps', 'ttft', 'avg_tps', 'step_cost']) => ({
    settings: {
      overviewMetricStyle: style,
      overviewMetrics: metrics,
      overviewModules: ['metrics', 'context', 'quotas'],
    },
    activeConversation: {
      cascadeId: 'conv-prev',
      latestTokPerSec: 68.4,
      latestTtftSec: 1.1,
      avgTokPerSec: 52.3,
      latestStepCostUsd: 0.04,
      context: { totalTokens: 128000, limitTokens: 256000 },
      recentSteps: [],
    },
    quotas: {},
  });

  host.update({ moduleKeys: ['metrics', 'context', 'quotas'], data: makeOverviewData('large') });
  assert.equal(containerEl.classList.contains('is-modules-reorderable'), true);
  const metricsEl = host.getInstance('metrics').el;
  const contextEl = host.getInstance('context').el;
  const quotasEl = host.getInstance('quotas').el;
  assert.equal(metricsEl.classList.contains('is-metrics-reorderable'), true);
  assert.equal(metricsEl.children.length, 3, 'Large mode renders first 3 metric cards');

  // Assign realistic variable-height module rects: metrics [0..80], context [88..248], quotas [256..366] (gap = 8)
  containerEl.getBoundingClientRect = () => ({ left: 0, top: 0, right: 360, bottom: 366, width: 360, height: 366 });
  metricsEl.getBoundingClientRect = () => ({ left: 0, top: 0, right: 360, bottom: 80, width: 360, height: 80 });
  contextEl.getBoundingClientRect = () => ({ left: 0, top: 88, right: 360, bottom: 248, width: 360, height: 160 });
  quotasEl.getBoundingClientRect = () => ({ left: 0, top: 256, right: 360, bottom: 366, width: 360, height: 110 });

  // Interactive button inside module never triggers module drag
  const fakeBtn = document.createElement('button');
  contextEl.appendChild(fakeBtn);
  contextEl.dispatchEvent({ type: 'pointerdown', target: fakeBtn, button: 0, clientX: 50, clientY: 120, preventDefault() {} });
  document.dispatchEvent({ type: 'pointermove', clientX: 50, clientY: 320, preventDefault() {} });
  assert.equal(containerEl.classList.contains('is-dragging-modules'), false, 'Interactive sub-control ignores module drag');
  document.dispatchEvent({ type: 'pointerup', clientX: 50, clientY: 320 });
  fakeBtn.remove();

  // 1) Drag 'quotas' (height 110) up above 'metrics' (height 80) -> ['quotas', 'metrics', 'context']
  quotasEl.dispatchEvent({ type: 'pointerdown', button: 0, clientX: 120, clientY: 310, preventDefault() {} });
  document.dispatchEvent({ type: 'pointermove', clientX: 120, clientY: 20, preventDefault() {} });
  assert.equal(containerEl.classList.contains('is-dragging-modules'), true);
  assert.equal(quotasEl.classList.contains('is-module-dragging'), true);
  assert.deepEqual(modPreviews[modPreviews.length - 1], ['quotas', 'metrics', 'context']);
  // Sibling 'metrics' must shift down by quotas(110) + gap(8) = +118px
  assert.equal(metricsEl.style.transform, 'translate3d(0px, 118.00px, 0)');
  assert.equal(modCommits.length, 0);

  // Escape cancels and reverts module preview
  document.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(containerEl.classList.contains('is-dragging-modules'), false);
  assert.equal(modCommits.length, 0);
  assert.deepEqual(modPreviews[modPreviews.length - 1], ['metrics', 'context', 'quotas']);

  // 2) Horizontal metric cell drag in Large mode preserves hidden 4th metric ('step_cost')
  const cellRects1Row = [
    { left: 0, right: 114, top: 0, bottom: 80, width: 114, height: 80 },
    { left: 120, right: 234, top: 0, bottom: 80, width: 114, height: 80 },
    { left: 240, right: 354, top: 0, bottom: 80, width: 114, height: 80 },
  ];
  for (let i = 0; i < 3; i += 1) {
    metricsEl.children[i].getBoundingClientRect = () => cellRects1Row[i];
  }
  metricsEl.children[2].dispatchEvent({
    type: 'pointerdown',
    button: 0,
    clientX: 297,
    clientY: 40,
    preventDefault() {},
    stopPropagation() {},
  });
  document.dispatchEvent({ type: 'pointermove', clientX: 30, clientY: 42, preventDefault() {} });
  assert.equal(metricsEl.classList.contains('is-dragging-matrix'), true);
  assert.equal(containerEl.classList.contains('is-dragging-modules'), false);
  assert.deepEqual(metPreviews[metPreviews.length - 1], ['avg_tps', 'tps', 'ttft', 'step_cost']);
  document.dispatchEvent({ type: 'pointerup', clientX: 30, clientY: 42 });
  assert.equal(metCommits.length, 1);
  assert.deepEqual(metCommits[0], ['avg_tps', 'tps', 'ttft', 'step_cost']);
  assert.equal(metricsEl.children[0].getAttribute('data-metric-key'), 'avg_tps');

  // 3) Vertical drag intent on a single-row metric card seamlessly hands off to vertical module drag!
  for (let i = 0; i < 3; i += 1) {
    metricsEl.children[i].getBoundingClientRect = () => cellRects1Row[i];
  }
  metricsEl.children[0].dispatchEvent({
    type: 'pointerdown',
    button: 0,
    clientX: 57,
    clientY: 40,
    preventDefault() {},
    stopPropagation() {},
  });
  document.dispatchEvent({ type: 'pointermove', clientX: 58, clientY: 220, preventDefault() {} });
  assert.equal(metricsEl.classList.contains('is-dragging-matrix'), false, 'Horizontal cell drag yielded to vertical module drag');
  assert.equal(containerEl.classList.contains('is-dragging-modules'), true, 'Vertical intent on metric card activates module drag');
  assert.equal(metricsEl.classList.contains('is-module-dragging'), true);
  document.dispatchEvent({ type: 'pointerup', clientX: 58, clientY: 220 });
  assert.equal(modCommits.length, 1);
  assert.deepEqual(modCommits[0], ['context', 'metrics', 'quotas']);

  // 4) 2x2 wrapped grid drag in Medium mode moves cell diagonally across rows and columns
  host.update({
    moduleKeys: ['metrics', 'context', 'quotas'],
    data: makeOverviewData('medium', ['tps', 'ttft', 'avg_tps', 'step_cost']),
  });
  const gridRects = [
    { left: 0, right: 170, top: 0, bottom: 60, width: 170, height: 60 },
    { left: 176, right: 346, top: 0, bottom: 60, width: 170, height: 60 },
    { left: 0, right: 170, top: 66, bottom: 126, width: 170, height: 60 },
    { left: 176, right: 346, top: 66, bottom: 126, width: 170, height: 60 },
  ];
  for (let i = 0; i < 4; i += 1) {
    metricsEl.children[i].getBoundingClientRect = () => gridRects[i];
  }
  metricsEl.children[3].dispatchEvent({
    type: 'pointerdown',
    button: 0,
    clientX: 261,
    clientY: 96,
    preventDefault() {},
    stopPropagation() {},
  });
  document.dispatchEvent({ type: 'pointermove', clientX: 85, clientY: 30, preventDefault() {} });
  assert.equal(metricsEl.classList.contains('is-dragging-matrix'), true);
  assert.deepEqual(metPreviews[metPreviews.length - 1], ['step_cost', 'tps', 'ttft', 'avg_tps']);
  document.dispatchEvent({ type: 'pointerup', clientX: 85, clientY: 30 });
  assert.deepEqual(metCommits[1], ['step_cost', 'tps', 'ttft', 'avg_tps']);

  // --- B) StepTableWidget preview direct column drag ---
  const colPreviews = [];
  const colCommits = [];
  stepPreview = StepTableWidget({
    standalone: true,
    interactiveBadges: false,
    onPreviewColumns: (cols) => colPreviews.push(cols),
    onReorderColumns: (cols) => colCommits.push(cols),
  });
  document.body.appendChild(stepPreview.el);
  const sampleSteps = [
    { stepIndex: 2, createdAtMs: 1795600020000, modelShort: '4-neon', tokPerSec: 68.4, ttftSec: 1.1, costUsd: 0.04 },
    { stepIndex: 1, createdAtMs: 1795600010000, modelShort: '4-neon', tokPerSec: 42.1, ttftSec: 1.9, costUsd: 0.02 },
  ];
  stepPreview.refs.renderStepTable(sampleSteps, 'prev-steps', ['time', 'model', 'tps', 'cost'], 'zh-CN');
  const { stepsTableEl, stepsTheadRow, stepsTbody } = stepPreview.refs;
  assert.equal(stepsTableEl.classList.contains('is-col-reorderable'), true);
  stepsTableEl.getBoundingClientRect = () => ({ left: 0, top: 0, right: 320, bottom: 120, width: 320, height: 120 });
  const thRects = [
    { left: 0, right: 80, top: 0, bottom: 26, width: 80, height: 26 },
    { left: 80, right: 160, top: 0, bottom: 26, width: 80, height: 26 },
    { left: 160, right: 250, top: 0, bottom: 26, width: 90, height: 26 },
    { left: 250, right: 320, top: 0, bottom: 26, width: 70, height: 26 },
  ];
  for (let i = 0; i < 4; i += 1) {
    stepsTheadRow.children[i].getBoundingClientRect = () => thRects[i];
  }

  // Drag column 2 ('tps', width 90) left to index 0 ('time') -> ['tps', 'time', 'model', 'cost']
  stepsTheadRow.children[2].dispatchEvent({
    type: 'pointerdown',
    button: 0,
    clientX: 205,
    clientY: 13,
    preventDefault() {},
    stopPropagation() {},
  });
  document.dispatchEvent({ type: 'pointermove', clientX: 20, clientY: 13, preventDefault() {} });
  assert.equal(stepsTableEl.classList.contains('is-dragging-cols'), true);
  assert.equal(stepsTheadRow.children[2].classList.contains('is-col-dragging'), true);
  assert.equal(stepsTbody.children[0].children[2].classList.contains('is-col-dragging'), true, 'Column body cells glide together with header');
  assert.equal(stepsTheadRow.children[0].style.transform, 'translate3d(90.00px, 0px, 0)');
  assert.equal(stepsTbody.children[0].children[0].style.transform, 'translate3d(90.00px, 0px, 0)');
  assert.deepEqual(colPreviews[colPreviews.length - 1], ['tps', 'time', 'model', 'cost']);
  assert.equal(colCommits.length, 0);

  // Drop commits once and reorders headers + cells
  document.dispatchEvent({ type: 'pointerup', clientX: 20, clientY: 13 });
  assert.equal(stepsTableEl.classList.contains('is-dragging-cols'), false);
  assert.equal(colCommits.length, 1);
  assert.deepEqual(colCommits[0], ['tps', 'time', 'model', 'cost']);
  assert.equal(stepsTheadRow.children[0].getAttribute('data-col-key'), 'tps');
  assert.equal(stepsTheadRow.children[1].getAttribute('data-col-key'), 'time');

  // Sortable StepTableWidget (real StepsDetailView) never activates column drag
  sortableStepTable = StepTableWidget({ onSortChange: () => {} });
  sortableStepTable.refs.renderStepTable(sampleSteps, 'live-steps', ['time', 'model', 'tps'], 'zh-CN');
  assert.equal(sortableStepTable.refs.stepsTableEl.classList.contains('is-col-reorderable'), false);
});

test('Hybrid metric matrix mode: normalization, 1..4 layouts, border drag-to-resize, double-click/keyboard reset, reorder isolation, and LiveOverview persistence', async (t) => {
  const {
    DEFAULT_HOVER_METRIC_HYBRID_RATIO,
    DEFAULT_METRIC_HYBRID_RATIO,
    DEFAULT_OVERVIEW_METRIC_HYBRID_RATIO,
    MAX_METRIC_HYBRID_RATIO,
    METRIC_CARD_STYLES,
    MIN_METRIC_HYBRID_RATIO,
    normalizeHoverMetricHybridRatio,
    normalizeMetricCardStyle,
    normalizeMetricHybridRatio,
    normalizeOverviewMetricHybridRatio,
    resolveEffectiveMetricMatrixConfig,
  } = await import('../shared/settings-normalization.mjs');
  const { createDynamicWidgetHost } = await import('../src/registries/widgetRegistry.js');
  const { LiveOverviewView } = await import('../src/views/LiveOverviewView.js');

  // 1) Shared normalization & backend schema checks
  assert.deepEqual([...METRIC_CARD_STYLES], ['medium', 'hybrid', 'large']);
  assert.equal(MIN_METRIC_HYBRID_RATIO, 28);
  assert.equal(MAX_METRIC_HYBRID_RATIO, 72);
  assert.equal(DEFAULT_METRIC_HYBRID_RATIO, 50);
  assert.equal(DEFAULT_SETTINGS_SCHEMA.overviewMetricHybridRatio, DEFAULT_OVERVIEW_METRIC_HYBRID_RATIO);
  assert.equal(DEFAULT_SETTINGS_SCHEMA.hoverMetricHybridRatio, DEFAULT_HOVER_METRIC_HYBRID_RATIO);

  assert.equal(normalizeMetricCardStyle('hybrid'), 'hybrid');
  assert.equal(normalizeMetricCardStyle('MIXED'), 'hybrid');
  assert.equal(normalizeMetricCardStyle('mix'), 'hybrid');
  assert.equal(normalizeMetricCardStyle('large'), 'large');
  assert.equal(normalizeMetricCardStyle('invalid'), 'medium');

  assert.equal(normalizeMetricHybridRatio(undefined), 50);
  assert.equal(normalizeMetricHybridRatio(null), 50);
  assert.equal(normalizeMetricHybridRatio(''), 50);
  assert.equal(normalizeMetricHybridRatio('abc'), 50);
  assert.equal(normalizeMetricHybridRatio(true), 50);
  assert.equal(normalizeMetricHybridRatio(0), 28);
  assert.equal(normalizeMetricHybridRatio(-10), 28);
  assert.equal(normalizeMetricHybridRatio(15), 28);
  assert.equal(normalizeMetricHybridRatio(90), 72);
  assert.equal(normalizeOverviewMetricHybridRatio(43.6), 44);
  assert.equal(normalizeHoverMetricHybridRatio('61'), 61);

  const normalizedFull = normalizeFullSettings({
    overviewMetricStyle: 'hybrid',
    overviewMetricHybridRatio: 88,
    hoverMetricStyle: 'mixed',
    hoverMetricHybridRatio: 12,
  });
  assert.equal(normalizedFull.overviewMetricStyle, 'hybrid');
  assert.equal(normalizedFull.overviewMetricHybridRatio, 72);
  assert.equal(normalizedFull.hoverMetricStyle, 'hybrid');
  assert.equal(normalizedFull.hoverMetricHybridRatio, 28);

  const syncedHoverCfg = resolveEffectiveMetricMatrixConfig('hover', {
    hoverSyncOverviewMetrics: true,
    overviewMetricStyle: 'hybrid',
    overviewMetricHybridRatio: 64,
    overviewMetrics: ['tps', 'ttft', 'avg_tps', 'step_cost'],
    hoverMetricStyle: 'medium',
    hoverMetricHybridRatio: 35,
    hoverMetrics: ['ttft', 'tps'],
  });
  assert.equal(syncedHoverCfg.style, 'hybrid');
  assert.equal(syncedHoverCfg.isHybrid, true);
  assert.equal(syncedHoverCfg.isLarge, false);
  assert.equal(syncedHoverCfg.hybridRatio, 64);
  assert.deepEqual(syncedHoverCfg.metrics, ['tps', 'ttft', 'avg_tps', 'step_cost']);

  const detachedHoverCfg = resolveEffectiveMetricMatrixConfig('hover', {
    hoverSyncOverviewMetrics: false,
    overviewMetricStyle: 'large',
    overviewMetricHybridRatio: 64,
    overviewMetrics: ['tps', 'ttft', 'avg_tps', 'step_cost'],
    hoverMetricStyle: 'hybrid',
    hoverMetricHybridRatio: 37,
    hoverMetrics: ['cache_hit', 'ttft', 'avg_tps', 'step_cost'],
  });
  assert.equal(detachedHoverCfg.style, 'hybrid');
  assert.equal(detachedHoverCfg.isHybrid, true);
  assert.equal(detachedHoverCfg.isLarge, false);
  assert.equal(detachedHoverCfg.hybridRatio, 37);
  assert.deepEqual(detachedHoverCfg.metrics, ['cache_hit', 'ttft', 'avg_tps', 'step_cost']);

  assert.equal(
    isEquivalentTelemetry(
      { settings: { overviewMetricStyle: 'hybrid', overviewMetricHybridRatio: 50 } },
      { settings: { overviewMetricStyle: 'hybrid', overviewMetricHybridRatio: 60 } }
    ),
    false,
    'isEquivalentTelemetry detects overviewMetricHybridRatio change'
  );
  assert.equal(
    isEquivalentTelemetry(
      { settings: { hoverMetricStyle: 'hybrid', hoverMetricHybridRatio: 50 } },
      { settings: { hoverMetricStyle: 'hybrid', hoverMetricHybridRatio: 40 } }
    ),
    false,
    'isEquivalentTelemetry detects hoverMetricHybridRatio change'
  );

  // 2) Setup Mock DOM + ResizeObserver + mock sidecar fetch for widget & LiveOverviewView tests
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCancelRaf = globalThis.cancelAnimationFrame;
  const prevRO = globalThis.ResizeObserver;
  const prevLocale = i18nStore.getState().locale;
  const prevTelState = { ...telemetryStore.getState() };
  const prevUiState = { ...uiStore.getState() };

  const { document } = createMockDom();
  const winListeners = new Map();
  const savedPatches = [];
  const roInstances = [];
  globalThis.ResizeObserver = class MockHybridResizeObserver {
    constructor(cb) {
      this.cb = cb;
      this.observed = new Set();
      roInstances.push(this);
    }
    observe(el) {
      this.observed.add(el);
    }
    unobserve(el) {
      this.observed.delete(el);
    }
    disconnect() {
      this.observed.clear();
    }
    emit(entries) {
      this.cb(entries);
    }
  };
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 800,
    location: { pathname: '/' },
    getComputedStyle: () => ({ columnGap: '0px', gap: '0px' }),
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      winListeners.get(type)?.delete(fn);
    },
    sidecar: {
      fetch: async (_url, opts) => {
        if (opts?.method === 'POST' && opts?.body) {
          const parsed = JSON.parse(opts.body);
          savedPatches.push(parsed);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              settings: { ...(telemetryStore.getState().telemetry?.settings || {}), ...parsed },
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
    },
  };
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

  let host = null;
  let readonlyHybrid = null;
  let liveView = null;
  t.after(() => {
    host?.destroy?.();
    readonlyHybrid?.destroy?.();
    liveView?.destroy?.();
    setI18nLanguage(prevLocale);
    telemetryStore.setState(prevTelState, { sync: true });
    uiStore.setState(prevUiState, { sync: true });
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.cancelAnimationFrame = prevCancelRaf;
    globalThis.ResizeObserver = prevRO;
  });

  setI18nLanguage('zh-CN');

  // Non-interactive hover overlay matrix applies hybrid vars cleanly without mounting a splitter
  readonlyHybrid = MetricMatrixWidget({ mode: 'hover' });
  readonlyHybrid.refs.update({
    data: buildStructurePreviewTelemetry(
      {},
      {
        hoverSyncOverviewMetrics: false,
        hoverMetricStyle: 'hybrid',
        hoverMetricHybridRatio: 58,
        hoverMetrics: ['tps', 'ttft', 'avg_tps', 'step_cost'],
      }
    ),
  });
  assert.equal(readonlyHybrid.el.classList.contains('is-hybrid'), true);
  assert.equal(readonlyHybrid.el.style.getPropertyValue('--hybrid-left-fr'), '58fr');
  assert.equal(readonlyHybrid.el.style.getPropertyValue('--hybrid-right-half-fr'), '21fr');
  assert.equal(readonlyHybrid.el.querySelector('.matrix-hybrid-splitter'), null);
  assert.equal(readonlyHybrid.el.children.length, 4);

  // Interactive host with module reorder + metric reorder + hybrid splitter resize
  const modCommits = [];
  const metCommits = [];
  const ratioPreviews = [];
  const ratioCommits = [];
  const containerEl = document.createElement('div');
  document.body.appendChild(containerEl);
  host = createDynamicWidgetHost({
    containerEl,
    mode: 'overview',
    preview: true,
    onReorderModules: (k) => modCommits.push(k),
    onReorderMetrics: (k) => metCommits.push(k),
    onPreviewHybridRatio: (r) => ratioPreviews.push(r),
    onResizeHybridRatio: (r) => ratioCommits.push(r),
  });

  const makeHybridData = (metrics, ratio = 50) =>
    buildStructurePreviewTelemetry(
      {},
      {
        overviewModules: ['metrics', 'context', 'quotas'],
        overviewMetricStyle: 'hybrid',
        overviewMetricHybridRatio: ratio,
        overviewMetrics: metrics,
      }
    );

  // 1-metric hybrid: 1 hero trend card, NO splitter
  host.update({ moduleKeys: ['metrics', 'context', 'quotas'], data: makeHybridData(['tps'], 55) });
  const matrixEl = host.getInstance('metrics').el;
  assert.equal(matrixEl.classList.contains('is-hybrid'), true);
  assert.equal(matrixEl.classList.contains('is-large-trend'), false);
  assert.equal(matrixEl.getAttribute('data-cols'), '1');
  assert.equal(matrixEl.querySelectorAll('.matrix-cell').length, 1);
  assert.equal(matrixEl.querySelectorAll('.matrix-cell.is-trend-card.is-hybrid-hero').length, 1);
  assert.equal(matrixEl.querySelector('.matrix-hybrid-splitter'), null);

  // 2-metric hybrid: 1 hero + 1 compact + splitter (--hybrid-col-gaps = 1)
  host.update({ moduleKeys: ['metrics', 'context', 'quotas'], data: makeHybridData(['tps', 'ttft'], 55) });
  assert.equal(matrixEl.getAttribute('data-cols'), '2');
  assert.equal(matrixEl.style.getPropertyValue('--hybrid-col-gaps'), '1');
  assert.equal(matrixEl.querySelectorAll('.matrix-cell.is-trend-card.is-hybrid-hero').length, 1);
  assert.equal(
    matrixEl.querySelectorAll('.matrix-cell').filter((el) => !el.classList.contains('is-trend-card')).length,
    1
  );
  assert.ok(matrixEl.querySelector('.matrix-hybrid-splitter'));

  // 3-metric hybrid: 1 hero + 2 compact + splitter (--hybrid-col-gaps = 1)
  host.update({
    moduleKeys: ['metrics', 'context', 'quotas'],
    data: makeHybridData(['tps', 'ttft', 'avg_tps'], 48),
  });
  assert.equal(matrixEl.getAttribute('data-cols'), '3');
  assert.equal(matrixEl.style.getPropertyValue('--hybrid-col-gaps'), '1');
  assert.equal(matrixEl.querySelectorAll('.matrix-cell.is-trend-card.is-hybrid-hero').length, 1);
  assert.equal(
    matrixEl.querySelectorAll('.matrix-cell').filter((el) => !el.classList.contains('is-trend-card')).length,
    2
  );

  // 4-metric hybrid: 1 hero + 3 compact + splitter (--hybrid-col-gaps = 2)
  host.update({
    moduleKeys: ['metrics', 'context', 'quotas'],
    data: makeHybridData(['tps', 'ttft', 'avg_tps', 'step_cost'], 50),
  });
  assert.equal(matrixEl.getAttribute('data-cols'), '4');
  assert.equal(matrixEl.style.getPropertyValue('--hybrid-col-gaps'), '2');
  assert.equal(matrixEl.style.getPropertyValue('--hybrid-left-fr'), '50fr');
  assert.equal(matrixEl.style.getPropertyValue('--hybrid-right-fr'), '50fr');
  assert.equal(matrixEl.style.getPropertyValue('--hybrid-right-half-fr'), '25fr');
  assert.equal(matrixEl.style.getPropertyValue('--hybrid-split-pct'), '50%');
  const cells4 = matrixEl.querySelectorAll('.matrix-cell');
  assert.equal(cells4.length, 4);
  assert.equal(cells4[0].classList.contains('is-trend-card'), true);
  assert.equal(cells4[0].classList.contains('is-hybrid-hero'), true);
  assert.equal(cells4[1].classList.contains('is-trend-card'), false);
  assert.equal(cells4[2].classList.contains('is-trend-card'), false);
  assert.equal(cells4[3].classList.contains('is-trend-card'), false);

  const splitterEl = matrixEl.querySelector('.matrix-hybrid-splitter');
  assert.ok(splitterEl);
  assert.equal(splitterEl.getAttribute('role'), 'separator');
  assert.equal(splitterEl.getAttribute('aria-orientation'), 'vertical');
  assert.equal(splitterEl.getAttribute('aria-valuenow'), '50');
  assert.equal(matrixEl.lastChild, splitterEl, 'Splitter stays trailing after metric cells');

  // 3) Splitter pointer drag updates ratio live, clamps [28..72], blocks cell/module drag, and commits once on pointerup
  matrixEl.getBoundingClientRect = () => ({ left: 100, top: 0, right: 500, bottom: 130, width: 400, height: 130 });
  let stopPropCalled = false;
  let preventDefaultCalled = false;
  splitterEl.dispatchEvent({
    type: 'pointerdown',
    button: 0,
    clientX: 300,
    clientY: 60,
    stopPropagation() {
      stopPropCalled = true;
    },
    preventDefault() {
      preventDefaultCalled = true;
    },
  });
  assert.equal(stopPropCalled, true, 'Splitter pointerdown stops propagation to parent drag handlers');
  assert.equal(preventDefaultCalled, true, 'Splitter pointerdown prevents text selection');

  // Drag right to 65% (left=100 + 260 = 360)
  document.dispatchEvent({ type: 'pointermove', clientX: 360, clientY: 60, preventDefault() {} });
  assert.equal(matrixEl.classList.contains('is-resizing-hybrid'), true);
  assert.equal(matrixEl.classList.contains('is-dragging-matrix'), false, 'Splitter drag must not start cell reorder');
  assert.equal(containerEl.classList.contains('is-dragging-modules'), false, 'Splitter drag must not start module drag');
  assert.equal(matrixEl.style.getPropertyValue('--hybrid-left-fr'), '65fr');
  assert.equal(matrixEl.style.getPropertyValue('--hybrid-right-fr'), '35fr');
  assert.equal(matrixEl.style.getPropertyValue('--hybrid-right-half-fr'), '17.5fr');
  assert.equal(matrixEl.style.getPropertyValue('--hybrid-split-pct'), '65%');
  assert.equal(splitterEl.getAttribute('aria-valuenow'), '65');
  assert.equal(ratioPreviews.at(-1), 65);
  assert.equal(ratioCommits.length, 0, 'Must not commit before pointerup');

  // Drag past max -> clamps cleanly at 72%
  document.dispatchEvent({ type: 'pointermove', clientX: 490, clientY: 60, preventDefault() {} });
  assert.equal(matrixEl.style.getPropertyValue('--hybrid-split-pct'), '72%');

  // Drag back to 62% and release
  document.dispatchEvent({ type: 'pointermove', clientX: 348, clientY: 60, preventDefault() {} });
  document.dispatchEvent({ type: 'pointerup', clientX: 348, clientY: 60 });
  assert.equal(matrixEl.classList.contains('is-resizing-hybrid'), false);
  assert.deepEqual(ratioCommits, [62]);

  // Escape mid-drag reverts smoothly without committing
  splitterEl.dispatchEvent({ type: 'pointerdown', button: 0, clientX: 348, clientY: 60, stopPropagation() {}, preventDefault() {} });
  document.dispatchEvent({ type: 'pointermove', clientX: 160, clientY: 60, preventDefault() {} });
  assert.equal(matrixEl.style.getPropertyValue('--hybrid-split-pct'), '28%');
  document.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(matrixEl.classList.contains('is-resizing-hybrid'), false);
  assert.equal(matrixEl.style.getPropertyValue('--hybrid-split-pct'), '62%', 'Escape reverts to pre-drag ratio');
  assert.deepEqual(ratioCommits, [62], 'Cancelled drag does not commit');

  // ResizeObserver updates hero sparkline step density cleanly when ratio widens hero card
  const heroWrap = cells4[0].querySelector('.cell-sparkline-wrap');
  const hostRO = roInstances.find((ro) => ro.observed.has(heroWrap));
  assert.ok(hostRO, 'Hybrid hero sparkline wrap is observed by ResizeObserver');
  hostRO.emit([{ target: heroWrap, contentRect: { width: 210 } }]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(cells4[0].querySelector('.cell-sparkline-svg').getAttribute('viewBox'), '0 0 210 34');
  assert.equal(
    cells4[0].querySelector('.cell-sparkline-line').getAttribute('points').split(' ').length,
    resolveAdaptiveSparklineSpec(210, 2).maxPoints
  );

  // Double-click resets ratio to 50%
  splitterEl.dispatchEvent({ type: 'dblclick', stopPropagation() {}, preventDefault() {} });
  assert.equal(matrixEl.style.getPropertyValue('--hybrid-split-pct'), '50%');
  assert.deepEqual(ratioCommits, [62, 50]);

  // Keyboard navigation on separator adjusts and clamps cleanly
  splitterEl.dispatchEvent({ type: 'keydown', key: 'ArrowRight', shiftKey: true, stopPropagation() {}, preventDefault() {} });
  assert.equal(matrixEl.style.getPropertyValue('--hybrid-split-pct'), '55%');
  splitterEl.dispatchEvent({ type: 'keydown', key: 'Home', stopPropagation() {}, preventDefault() {} });
  assert.equal(matrixEl.style.getPropertyValue('--hybrid-split-pct'), '28%');
  splitterEl.dispatchEvent({ type: 'keydown', key: 'End', stopPropagation() {}, preventDefault() {} });
  assert.equal(matrixEl.style.getPropertyValue('--hybrid-split-pct'), '72%');
  splitterEl.dispatchEvent({ type: 'keydown', key: 'Enter', stopPropagation() {}, preventDefault() {} });
  assert.equal(matrixEl.style.getPropertyValue('--hybrid-split-pct'), '50%');
  assert.deepEqual(ratioCommits, [62, 50, 55, 28, 72, 50]);

  // 4) Metric reorder in hybrid mode still works seamlessly alongside splitter & promotes new index 0 to hero trend card
  const hybridRects = [
    { left: 0, right: 200, top: 0, bottom: 120, width: 200, height: 120 },
    { left: 206, right: 300, top: 0, bottom: 57, width: 94, height: 57 },
    { left: 306, right: 400, top: 0, bottom: 57, width: 94, height: 57 },
    { left: 206, right: 400, top: 63, bottom: 120, width: 194, height: 57 },
  ];
  const currentCells = matrixEl.querySelectorAll('.matrix-cell');
  for (let i = 0; i < 4; i += 1) {
    currentCells[i].getBoundingClientRect = () => hybridRects[i];
  }
  currentCells[1].dispatchEvent({
    type: 'pointerdown',
    button: 0,
    clientX: 250,
    clientY: 28,
    preventDefault() {},
    stopPropagation() {},
  });
  document.dispatchEvent({ type: 'pointermove', clientX: 80, clientY: 60, preventDefault() {} });
  assert.equal(matrixEl.classList.contains('is-dragging-matrix'), true);
  document.dispatchEvent({ type: 'pointerup', clientX: 80, clientY: 60 });
  assert.deepEqual(metCommits[0], ['ttft', 'tps', 'avg_tps', 'step_cost']);
  const reorderedCells = matrixEl.querySelectorAll('.matrix-cell');
  assert.equal(reorderedCells[0].getAttribute('data-metric-key'), 'ttft');
  assert.equal(reorderedCells[0].classList.contains('is-hybrid-hero'), true);
  assert.equal(reorderedCells[1].getAttribute('data-metric-key'), 'tps');
  assert.equal(reorderedCells[1].classList.contains('is-hybrid-hero'), false);
  assert.equal(matrixEl.lastChild, splitterEl, 'Splitter remains after reordered metric cells');
  assert.equal(modCommits.length, 0);

  // 5) LiveOverviewView wires splitter drag to saveSettingsPatch({ overviewMetricHybridRatio })
  uiStore.setState({ activeView: 'overview' }, { sync: true });
  liveView = LiveOverviewView({});
  document.body.appendChild(liveView.el);
  telemetryStore.setState(
    { telemetry: makeHybridData(['tps', 'ttft', 'avg_tps', 'step_cost'], 50) },
    { sync: true }
  );
  const liveMatrixEl = liveView.el.querySelector('.telemetry-matrix.is-hybrid');
  assert.ok(liveMatrixEl, 'LiveOverviewView renders hybrid matrix');
  const liveSplitter = liveMatrixEl.querySelector('.matrix-hybrid-splitter');
  assert.ok(liveSplitter, 'LiveOverviewView mounts draggable hybrid splitter');
  liveMatrixEl.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 120, width: 400, height: 120 });
  liveSplitter.dispatchEvent({ type: 'pointerdown', button: 0, clientX: 200, clientY: 60, preventDefault() {}, stopPropagation() {} });
  document.dispatchEvent({ type: 'pointermove', clientX: 232, clientY: 60, preventDefault() {} });
  document.dispatchEvent({ type: 'pointerup', clientX: 232, clientY: 60 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(savedPatches.length, 1);
  assert.deepEqual(savedPatches[0], { overviewMetricHybridRatio: 58 });

  // 6) Built styles.css contains hybrid grid layout, splitter styling, and narrow-width media guard
  const builtStyles = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(builtStyles, /\.telemetry-matrix\.is-hybrid\[data-cols="4"\]/);
  assert.match(builtStyles, /\.matrix-hybrid-splitter\s*\{/);
  assert.match(
    builtStyles,
    /\.telemetry-matrix:not\(\.is-hybrid\):not\(\[data-cols="1"\]\):not\(\[data-cols="2"\]\)/
  );
});
