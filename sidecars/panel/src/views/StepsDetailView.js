/**
 * @fileoverview View 3: StepsDetailView (步骤明细与总汇总分析视图).
 * 提供“按步查看”与“总汇总”双子视图切换：
 * - 单步测速表通过 `stepColumnRegistry.js` 动态渲染用户自选的 2..12 个字段列，并支持行级增量对账；
 * - 总汇总视图提供会话线性走势图、多模型同图趋势拟合曲线与极简高密度模型总览卡片。
 */

import { normalizeClientFontScale, resolveSettingsModernUi } from '../core/appearance.js';
import { defineComponent } from '../core/component.js';
import {
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchText,
} from '../core/domPatch.js';
import {
  buildModelAnomalyDiagnostic,
  formatAnomalyKindLabel,
  formatAnomalyTagText,
  formatMetric,
  formatPctNumber,
  formatSpeedMetric,
  formatTimingDetailSec,
  formatTokens,
  formatTokensPrecise,
  formatUsd,
  mergeModelsByDisplayName,
  normalizeModelDisplayMode,
  resolveModelAnomalySummary,
  resolveModelDisplayInfo,
} from '../core/formatters.js';
import {
  computeStepQuickChipCounts,
  filterStepsBySearchAndChip,
} from '../core/stepInspector.js';
import {
  buildStepsExportBaseName,
  buildStepsMarkdownReport,
  buildStepsXlsx,
  sanitizeExportFilename,
} from '../core/reportExporter.js';
import {
  copyTextWithFeedback,
  exportBinaryFileWithFeedback,
} from '../core/fileExportClient.js';
import { createSvgIcon, patchSvgIcon } from '../icons/SvgIcon.js';
import { ActionMenu } from '../components/ui/ActionMenu.js';
import { getEffectiveLocale, i18nStore, t } from '../i18n/index.js';
import {
  formatAgentLabel,
  getDefaultCtxInspectorAgentId,
  normalizeClientStepColumns,
  normalizeClientStepTokenComboFormat,
  resolveScopedConversation,
  telemetryStore,
} from '../store/telemetryStore.js';
import { getVisibleMonitorView, uiStore } from '../store/uiStore.js';
import {
  MODEL_COLOR_VARS,
  createModelFitChart,
  createSessionLineChart,
  getStepModelGroupKey,
  toChronologicalSteps,
} from '../components/charts/SessionStepCharts.js';
import { CustomScrollbar } from '../components/ui/CustomScrollbar.js';
import { CustomSelect } from '../components/ui/CustomSelect.js';
import { createFourSegmentBar } from '../components/ui/FourSegmentBar.js';
import { createSearchInput } from '../components/ui/SearchInput.js';
import { SegmentedControl } from '../components/ui/SegmentedControl.js';
import { StepTableWidget } from '../components/widgets/StepTableWidget.js';
import { sortStepsByColumn } from '../registries/stepColumnRegistry.js';

export function mergeSelectedAgentUnits(units) {
  const combinedSteps = [];
  const modelMap = new Map();

  for (const ag of units) {
    if (!ag || typeof ag !== 'object') continue;
    if (Array.isArray(ag.recentSteps)) {
      for (const step of ag.recentSteps) combinedSteps.push(step);
    }
    const breakdown = Array.isArray(ag.modelBreakdown) ? ag.modelBreakdown : [];
    for (const m of breakdown) {
      if (!m || typeof m !== 'object') continue;
      const gk = getStepModelGroupKey(m);
      let acc = modelMap.get(gk);
      if (!acc) {
        acc = {
          label: m.label || gk,
          shortName: m.shortName || gk,
          shortNameCounts: new Map(),
          rawModel: m.rawModel || '',
          upstreamName: m.upstreamName || m.upstreamModel || '',
          upstreamSet: new Set(
            Array.isArray(m.upstreamModels) ? m.upstreamModels.filter(Boolean) : []
          ),
          calls: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          thinkingTokens: 0,
          responseTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          unpricedCalls: 0,
          anomalySteps: 0,
          anomalyCount: 0,
          anomalyDangerCount: 0,
          anomalyTotalDelaySec: 0,
          anomalyByKind: {},
          _hasAnySpeedSummary: false,
          _speedTokens: 0,
          _speedSeconds: 0,
          _speedSampleCount: 0,
          _speedExcludedCount: 0,
          _speedExcludedReasons: {},
          _ttftWeightedSum: 0,
          _ttftWeight: 0,
          _ttftSampleCount: 0,
        };
        if (acc.upstreamName) acc.upstreamSet.add(acc.upstreamName);
        modelMap.set(gk, acc);
      }
      if (!acc.upstreamName && (m.upstreamName || m.upstreamModel)) {
        acc.upstreamName = m.upstreamName || m.upstreamModel;
      }
      if (m.upstreamName) acc.upstreamSet.add(m.upstreamName);
      if (Array.isArray(m.upstreamModels)) {
        for (const u of m.upstreamModels) {
          if (u) acc.upstreamSet.add(u);
        }
      }
      const calls = Math.max(0, Number(m.calls || 0));
      if (m.shortName) {
        acc.shortNameCounts.set(
          m.shortName,
          (acc.shortNameCounts.get(m.shortName) || 0) + Math.max(1, calls)
        );
      }
      const inTok = Math.max(0, Number(m.inputTokens || 0));
      const cacheTok = Math.max(0, Number(m.cacheReadTokens || 0));
      const outTok = Math.max(0, Number(m.outputTokens || 0));
      const thinkTok = Math.max(0, Number(m.thinkingTokens || 0));
      const respTok =
        m.responseTokens != null
          ? Math.max(0, Number(m.responseTokens))
          : Math.max(0, outTok - thinkTok);
      const totTok = Math.max(0, Number(m.totalTokens ?? inTok + cacheTok + outTok));
      const costUsd = Number.isFinite(Number(m.costUsd)) ? Math.max(0, Number(m.costUsd)) : 0;
      const unpricedCalls = Math.max(0, Number(m.unpricedCalls || 0));

      acc.calls += calls;
      acc.inputTokens += inTok;
      acc.cacheReadTokens += cacheTok;
      acc.outputTokens += outTok;
      acc.thinkingTokens += thinkTok;
      acc.responseTokens += respTok;
      acc.totalTokens += totTok;
      acc.costUsd += costUsd;
      acc.unpricedCalls += unpricedCalls;
      acc.anomalySteps += Math.max(0, Number(m.anomalySteps || 0));
      acc.anomalyCount += Math.max(0, Number(m.anomalyCount || 0));
      acc.anomalyDangerCount += Math.max(0, Number(m.anomalyDangerCount || 0));
      acc.anomalyTotalDelaySec += Math.max(0, Number(m.anomalyTotalDelaySec || 0));
      if (m.anomalyByKind && typeof m.anomalyByKind === 'object') {
        for (const [kind, cnt] of Object.entries(m.anomalyByKind)) {
          const n = Math.max(0, Number(cnt || 0));
          if (n > 0) acc.anomalyByKind[kind] = (acc.anomalyByKind[kind] || 0) + n;
        }
      }

      const rawSpeedTok = Number(m.speedSummary?.tokens);
      const rawSpeedSec = Number(m.speedSummary?.seconds);
      if (
        Number.isFinite(rawSpeedTok) &&
        Number.isFinite(rawSpeedSec) &&
        rawSpeedSec > 0 &&
        rawSpeedTok >= 0
      ) {
        acc._hasAnySpeedSummary = true;
        acc._speedTokens += rawSpeedTok;
        acc._speedSeconds += rawSpeedSec;
      } else if (Number.isFinite(Number(m.avgTokPerSec)) && Number(m.avgTokPerSec) > 0) {
        const fallbackTok = outTok > 0 ? outTok : Math.max(1, calls || 1);
        acc._speedTokens += fallbackTok;
        acc._speedSeconds += fallbackTok / Number(m.avgTokPerSec);
      }
      if (m.speedSummary) {
        acc._hasAnySpeedSummary = true;
        acc._speedSampleCount += Math.max(0, Number(m.speedSummary.sampleCount || 0));
        acc._speedExcludedCount += Math.max(0, Number(m.speedSummary.excludedCount || 0));
        if (m.speedSummary.excludedReasons && typeof m.speedSummary.excludedReasons === 'object') {
          for (const [rk, rv] of Object.entries(m.speedSummary.excludedReasons)) {
            const cnt = Math.max(0, Number(rv || 0));
            if (cnt > 0) acc._speedExcludedReasons[rk] = (acc._speedExcludedReasons[rk] || 0) + cnt;
          }
        }
      }
      if (
        m.avgTtftSec != null &&
        Number.isFinite(Number(m.avgTtftSec)) &&
        Number(m.avgTtftSec) >= 0
      ) {
        const ttftSamples = Math.max(0, Number(m.ttftSampleCount || 0));
        const w = ttftSamples > 0 ? ttftSamples : Math.max(1, calls || 1);
        acc._ttftWeightedSum += Number(m.avgTtftSec) * w;
        acc._ttftWeight += w;
        acc._ttftSampleCount += ttftSamples;
      }
    }
  }

  combinedSteps.sort(
    (a, b) =>
      (Number(b?.createdAtMs) || 0) - (Number(a?.createdAtMs) || 0) ||
      (Number(b?.agentIndex) || 0) - (Number(a?.agentIndex) || 0) ||
      (Number(b?.stepIndex) || 0) - (Number(a?.stepIndex) || 0)
  );

  const mergedModels = Array.from(modelMap.values())
    .map((acc) => {
      const promptTok = acc.inputTokens + acc.cacheReadTokens;
      const rawAvgTps = acc._speedSeconds > 0 ? acc._speedTokens / acc._speedSeconds : null;
      let primaryShortName = acc.shortName;
      let bestShortCount = -1;
      for (const [sn, cnt] of acc.shortNameCounts.entries()) {
        if (
          cnt > bestShortCount ||
          (cnt === bestShortCount &&
            (sn.length < primaryShortName.length ||
              (sn.length === primaryShortName.length && sn < primaryShortName)))
        ) {
          primaryShortName = sn;
          bestShortCount = cnt;
        }
      }
      return {
        label: acc.label,
        shortName: primaryShortName,
        rawModel: acc.rawModel,
        upstreamName: acc.upstreamName,
        upstreamModels: Array.from(acc.upstreamSet),
        calls: acc.calls,
        inputTokens: acc.inputTokens,
        cacheReadTokens: acc.cacheReadTokens,
        outputTokens: acc.outputTokens,
        thinkingTokens: acc.thinkingTokens,
        responseTokens: acc.responseTokens,
        totalTokens: acc.totalTokens,
        costUsd: +acc.costUsd.toFixed(6),
        unpricedCalls: acc.unpricedCalls,
        avgTokPerSec: rawAvgTps !== null ? +rawAvgTps.toFixed(1) : null,
        avgTtftSec:
          acc._ttftWeight > 0 ? +(acc._ttftWeightedSum / acc._ttftWeight).toFixed(1) : null,
        ttftSampleCount: acc._ttftSampleCount,
        ...(acc._hasAnySpeedSummary
          ? {
              speedSummary: {
                tokens: acc._speedTokens,
                seconds: +acc._speedSeconds.toFixed(6),
                sampleCount: acc._speedSampleCount,
                excludedCount: acc._speedExcludedCount,
                excludedReasons: acc._speedExcludedReasons,
                avgTokPerSec: rawAvgTps,
              },
            }
          : {}),
        cacheHitPct: promptTok > 0 ? +((acc.cacheReadTokens / promptTok) * 100).toFixed(1) : 0,
        ...(acc.anomalyCount > 0
          ? {
              anomalySteps: acc.anomalySteps,
              anomalyCount: acc.anomalyCount,
              anomalyDangerCount: acc.anomalyDangerCount,
              anomalyTotalDelaySec: +acc.anomalyTotalDelaySec.toFixed(1),
              anomalyByKind: acc.anomalyByKind,
            }
          : {}),
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls);

  return { steps: combinedSteps, models: mergedModels };
}

function getLineMetricSwitchOptions() {
  return [
    { value: 'totalTokens', label: t('steps.metricTotalTokens') },
    { value: 'context', label: t('steps.metricContext') },
    { value: 'tps', label: t('steps.metricTps') },
    { value: 'ttft', label: t('steps.metricTtft') },
    { value: 'cost', label: t('steps.metricCost') },
  ];
}

function getFitMetricSwitchOptions() {
  return [
    { value: 'tps', label: t('steps.metricTps') },
    { value: 'ttft', label: t('steps.metricTtft') },
    { value: 'cache', label: t('steps.metricCache') },
    { value: 'cost', label: t('steps.metricCost') },
  ];
}

export const StepsDetailView = defineComponent({
  name: 'StepsDetailView',
  setup({ getProps, onCleanup }) {
    const onLayoutChange =
      typeof getProps?.()?.onLayoutChange === 'function' ? getProps().onLayoutChange : null;
    let selectedAgentScopes = [uiStore.getState().selectedAgentScope || 'all'];
    let lastSyncedUiScope = uiStore.getState().selectedAgentScope || 'all';
    let selectedTableModels = ['__all__'];
    let selectedLineModels = ['__all__'];
    let onlyAnomalies = false;
    let anomalyKindFilter = '';
    let stepSearchQuery = '';
    let stepQuickChip = '';
    let currentTableSteps = [];
    let currentAllConvSteps = [];
    let currentDisplaySettings = {};
    let sortKey = '';
    let sortDir = '';
    let cachedSortSrc = null;
    let cachedSortSig = '';
    let cachedSortedOut = [];

    function applyAgentScopesSelection(nextScopes) {
      selectedAgentScopes = nextScopes;
      const mappedSingle =
        nextScopes.length === 1 && nextScopes[0] !== 'all' ? nextScopes[0] : 'all';
      const prevUiScope = uiStore.getState().selectedAgentScope;
      lastSyncedUiScope = mappedSingle;
      if (prevUiScope !== mappedSingle) {
        const curCtxId = uiStore.getState().ctxInspectorAgentId;
        const shouldResetSubCtx =
          mappedSingle === 'all' && curCtxId && curCtxId !== 'main' && curCtxId !== 'auto';
        uiStore.setState({
          selectedAgentScope: mappedSingle,
          ...(shouldResetSubCtx
            ? {
                ctxInspectorAgentId: getDefaultCtxInspectorAgentId(
                  telemetryStore.getState().telemetry?.settings
                ),
              }
            : {}),
        });
      } else if (latestSlice) {
        renderStepsData(latestSlice);
      }
    }

    const inlineScopeSelect = CustomSelect({
      multiple: true,
      allValue: 'all',
      collapseAll: true,
      multiUnit: t('steps.unitAgent'),
      modelValue: selectedAgentScopes,
      placeholder: t('steps.allAgents'),
      className: 'steps-inline-scope-select',
      options: [{ value: 'all', label: t('steps.allAgents') }],
      onUpdateModelValue: (nextScopes) => {
        if (!Array.isArray(nextScopes) || nextScopes.length === 0) return;
        applyAgentScopesSelection(nextScopes);
      },
    });
    inlineScopeSelect.el.setAttribute('hidden', '');

    const stepsModelSelect = CustomSelect({
      multiple: true,
      allValue: '__all__',
      collapseAll: false,
      multiUnit: t('steps.unitModel'),
      modelValue: selectedTableModels,
      placeholder: t('steps.allModels'),
      className: 'steps-inline-model-select',
      options: [{ value: '__all__', label: t('steps.allModels') }],
      onUpdateModelValue: (nextModels) => {
        if (!Array.isArray(nextModels) || nextModels.length === 0) return;
        selectedTableModels = nextModels;
        if (latestSlice) renderStepsData(latestSlice);
      },
    });
    stepsModelSelect.el.setAttribute('hidden', '');

    const subTabSwitch = SegmentedControl({
      ariaLabel: t('steps.title'),
      modelValue: uiStore.getState().stepsSubTab,
      options: [
        { value: 'steps', label: t('steps.tabSteps', { count: 0 }) },
        { value: 'models', label: t('steps.tabModels') },
      ],
      onUpdateModelValue: (nextTab) => {
        uiStore.setState({ stepsSubTab: nextTab });
      },
    });

    // --- 子视图 1：单步明细表（委托给可复用的 `StepTableWidget` 解耦组件） ---
    let stepsScroll = null;
    const stepTableWidget = StepTableWidget({
      onSelectAgentScopes: applyAgentScopesSelection,
      onVirtualHeightChange: () => stepsScroll?.refresh(),
      onSortChange: (nextKey, nextDir) => {
        sortKey = nextKey || '';
        sortDir = nextDir || '';
        if (latestSlice) renderStepsData(latestSlice);
      },
    });
    const {
      stepsTablePane,
      stepsTableEl,
      stepsTheadRow,
      stepsTbody,
      turnTipEl,
      anomalyTipEl,
      hideTurnTip,
      showAnomalyTip,
      hideAnomalyTip,
      syncTableHeaderColumns,
      renderStepTable,
      refreshViewport: refreshStepTableViewport,
    } = stepTableWidget.refs;
    stepsScroll = CustomScrollbar({
      contentEl: stepsTablePane,
      className: 'table-scroll-host',
    });

    const anomalyFilterLabelEl = h('span', { className: 'steps-anomaly-filter-label text-mono' });
    const anomalyFilterClearBtn = h('button', {
      type: 'button',
      className: 'btn-ghost-sm steps-anomaly-filter-clear',
      text: t('steps.anomalyFilterAll'),
      onclick: () => {
        onlyAnomalies = false;
        anomalyKindFilter = '';
        if (stepQuickChip === 'anomaly') stepQuickChip = '';
        if (latestSlice) renderStepsData(latestSlice);
      },
    });
    const anomalyFilterBarEl = h(
      'div',
      { className: 'steps-anomaly-filterbar', hidden: true },
      [anomalyFilterLabelEl, anomalyFilterClearBtn]
    );

    // --- 步骤搜索栏及快捷诊断芯片 ---
    const stepSearchBox = createSearchInput({
      wrapClassName: 'steps-search-wrap',
      iconClassName: 'steps-search-icon',
      inputClassName: 'steps-search-input',
      clearClassName: 'steps-search-clear',
      placeholder: t('steps.searchPlaceholder'),
      ariaLabel: t('steps.searchPlaceholder'),
      clearAriaLabel: t('steps.searchClearAria'),
      closeIconSize: 11,
      onInput: (val) => {
        stepSearchQuery = String(val ?? '');
        if (latestSlice) renderStepsData(latestSlice);
      },
      onClear: () => {
        stepSearchQuery = '';
        if (latestSlice) renderStepsData(latestSlice);
        stepSearchInput.focus?.();
      },
      onKeydown: (e) => {
        if (e?.key === 'Escape') {
          e.stopPropagation?.();
          if (stepSearchQuery) {
            stepSearchQuery = '';
            stepSearchBox.setValue('');
            if (latestSlice) renderStepsData(latestSlice);
          } else {
            stepSearchInput.blur?.();
          }
        }
      },
    });
    const stepSearchWrapEl = stepSearchBox.el;
    const stepSearchInput = stepSearchBox.inputEl;
    const stepSearchClearBtn = stepSearchBox.clearBtnEl;

    const QUICK_CHIP_DEFS = [
      { key: 'anomaly', i18nKey: 'steps.chipAnomaly' },
      { key: 'compaction', i18nKey: 'steps.chipCompaction' },
      { key: 'low_cache', i18nKey: 'steps.chipLowCache', tipKey: 'steps.chipLowCacheTip' },
      { key: 'slow_ttft', i18nKey: 'steps.chipSlowTtft', tipKey: 'steps.chipSlowTtftTip' },
    ];
    const stepQuickFilterSwitch = SegmentedControl({
      ariaLabel: t('steps.quickFilterAria'),
      modelValue: '',
      deselectToValue: '',
      options: [],
      onUpdateModelValue: (val) => {
        const nextKey = String(val || '');
        if (nextKey === 'anomaly') {
          onlyAnomalies = true;
          anomalyKindFilter = '';
          stepQuickChip = 'anomaly';
        } else {
          onlyAnomalies = false;
          anomalyKindFilter = '';
          stepQuickChip = nextKey;
        }
        if (latestSlice) renderStepsData(latestSlice);
      },
    });
    const stepQuickChipsEl = stepQuickFilterSwitch.el;
    stepQuickChipsEl.classList?.add('steps-quick-chips');
    patchAttr(stepQuickChipsEl, 'hidden', true);
    const stepsExportMenu = ActionMenu({
      ariaLabel: t('steps.exportMenuAria'),
      className: 'steps-export-menu',
      items: [
        {
          key: 'xlsx',
          icon: 'download',
          label: t('steps.exportXlsx'),
          title: t('steps.exportXlsxTip'),
          onSelect: () => {
            if (currentTableSteps.length === 0) return;
            const bytes = buildStepsXlsx(currentTableSteps, {
              title: latestSlice?.activeConversation?.title || '',
              cascadeId: latestSlice?.cascadeId || latestSlice?.activeConversation?.cascadeId || '',
              displaySettings: currentDisplaySettings,
            });
            const baseName = buildStepsExportBaseName(
              latestSlice?.activeConversation?.title || '',
              latestSlice?.cascadeId || latestSlice?.activeConversation?.cascadeId || ''
            );
            void exportBinaryFileWithFeedback(
              sanitizeExportFilename(baseName, 'xlsx'),
              bytes
            );
          },
        },
        {
          key: 'md',
          icon: 'copy',
          label: t('steps.exportMd'),
          title: t('steps.exportMdTip'),
          onSelect: () => {
            if (currentTableSteps.length === 0) return;
            const md = buildStepsMarkdownReport(currentTableSteps, {
              title: latestSlice?.activeConversation?.title || '',
              cascadeId: latestSlice?.cascadeId || latestSlice?.activeConversation?.cascadeId || '',
              displaySettings: currentDisplaySettings,
            });
            void copyTextWithFeedback(md, t('steps.exportMdDone'));
          },
        },
      ],
    });
    stepsExportMenu.refs.setHidden(true);
    const stepsFilterToolbarEl = h(
      'div',
      { className: 'steps-filter-toolbar', hidden: true },
      [stepSearchWrapEl, stepQuickChipsEl]
    );

    // --- 子视图 2：总汇总分析面板 ---
    let selectedLineMetric = 'totalTokens';
    let selectedFitMetric = 'tps';

    let fitLockedCascadeId = null;
    let fitLockedModelKeys = [];
    let fitPinnedWhileVisible = false;
    let fitUserPicked = false;

    const lineTitleEl = h('span', { className: 'sstep-card-title', text: t('steps.lineTitle') });
    const lineSummaryBadge = h('span', {
      className: 'cons-badge text-mono',
      text: t('header.convMetaSteps', { count: 0 }),
    });
    const lineModelSelect = CustomSelect({
      multiple: true,
      allValue: '__all__',
      collapseAll: false,
      multiUnit: t('steps.unitModel'),
      modelValue: selectedLineModels,
      placeholder: t('steps.allModels'),
      className: 'sstep-fit-model-select sstep-line-model-select',
      options: [{ value: '__all__', label: t('steps.allModels') }],
      onUpdateModelValue: (nextModels) => {
        if (!Array.isArray(nextModels) || nextModels.length === 0) return;
        selectedLineModels = nextModels;
        if (latestSlice) renderStepsData(latestSlice);
      },
    });
    lineModelSelect.el.setAttribute('hidden', '');

    const lineMetricSwitch = SegmentedControl({
      ariaLabel: t('steps.lineTitle'),
      modelValue: selectedLineMetric,
      options: getLineMetricSwitchOptions(),
      onUpdateModelValue: (nextMetric) => {
        selectedLineMetric = nextMetric;
        if (latestSlice) renderStepsData(latestSlice);
      },
    });
    const sessionLineChart = createSessionLineChart();
    const sessionLineCard = h('div', { className: 'sstep-card sstep-line-card' }, [
      h('div', { className: 'sstep-card-head' }, [
        h('div', { className: 'sstep-card-title-group' }, [lineTitleEl, lineSummaryBadge]),
        h('div', { className: 'sstep-fit-controls' }, [
          lineModelSelect.el,
          lineMetricSwitch.el,
        ]),
      ]),
      sessionLineChart.el,
    ]);

    const fitTitleEl = h('span', { className: 'sstep-card-title', text: t('steps.fitTitle') });
    const fitSummaryBadge = h('span', {
      className: 'cons-badge text-mono',
      text: t('header.convMetaSteps', { count: 0 }),
    });
    const fitModelSelect = CustomSelect({
      multiple: true,
      allValue: '__all__',
      collapseAll: false,
      multiUnit: t('steps.unitModel'),
      modelValue: ['__all__'],
      placeholder: t('steps.selectModel'),
      className: 'sstep-fit-model-select',
      options: [{ value: '__all__', label: t('steps.allModels') }],
      onUpdateModelValue: (nextModelKeys) => {
        if (!Array.isArray(nextModelKeys) || nextModelKeys.length === 0) return;
        fitLockedModelKeys = nextModelKeys;
        fitUserPicked = true;
        fitPinnedWhileVisible = true;
        if (latestSlice) renderStepsData(latestSlice);
      },
    });
    fitModelSelect.el.setAttribute('hidden', '');

    const fitMetricSwitch = SegmentedControl({
      ariaLabel: t('steps.fitTitle'),
      modelValue: selectedFitMetric,
      options: getFitMetricSwitchOptions(),
      onUpdateModelValue: (nextMetric) => {
        selectedFitMetric = nextMetric;
        if (latestSlice) renderStepsData(latestSlice);
      },
    });
    const modelFitChart = createModelFitChart();
    const modelFitCard = h('div', { className: 'sstep-card sstep-fit-card' }, [
      h('div', { className: 'sstep-card-head' }, [
        h('div', { className: 'sstep-card-title-group' }, [fitTitleEl, fitSummaryBadge]),
        h('div', { className: 'sstep-fit-controls' }, [fitModelSelect.el, fitMetricSwitch.el]),
      ]),
      modelFitChart.el,
    ]);

    const modelsSectionTitleEl = h('span', {
      className: 'sstep-card-title',
      text: t('steps.modelsTitle'),
    });
    const modelsSummaryMeta = h('span', {
      className: 'cons-badge text-mono',
      text: t('cons.callsCount', { calls: 0 }),
    });
    const modelsAnomalyMetaEl = h('button', {
      type: 'button',
      className: 'steps-anomaly-strip-meta text-mono',
      onclick: () => {
        hideAnomalyTip();
        selectedTableModels = ['__all__'];
        onlyAnomalies = true;
        anomalyKindFilter = '';
        uiStore.setState({ stepsSubTab: 'steps' });
      },
    });
    const modelsAnomalyTagsEl = h('div', { className: 'steps-anomaly-strip-tags' });
    const modelsAnomalyStripEl = h(
      'div',
      { className: 'steps-anomaly-strip', hidden: true },
      [modelsAnomalyMetaEl, modelsAnomalyTagsEl]
    );
    let lastAnomalyStripSig = '';
    const modelsEmptyEl = h('div', {
      className: 'smodel-empty text-muted',
      text: t('steps.modelsEmpty'),
    });
    const modelsListEl = h('div', { className: 'smodel-list' });
    const modelsSummarySection = h('div', { className: 'smodel-section' }, [
      h('div', { className: 'smodel-section-head' }, [modelsSectionTitleEl, modelsSummaryMeta]),
      modelsAnomalyStripEl,
      modelsEmptyEl,
      modelsListEl,
    ]);

    const modelsAnalyticsPane = h('div', { className: 'table-viewport models-analytics-pane' }, [
      sessionLineCard,
      modelFitCard,
      modelsSummarySection,
    ]);
    const onModelsPaneScroll = () => hideAnomalyTip();
    modelsAnalyticsPane.addEventListener('scroll', onModelsPaneScroll, { passive: true });
    const modelsScroll = CustomScrollbar({
      contentEl: modelsAnalyticsPane,
      className: 'table-scroll-host',
    });
    modelsScroll.el.setAttribute('hidden', '');

    const headerFiltersEl = h('div', { className: 'steps-header-filters', hidden: true }, [
      inlineScopeSelect.el,
      stepsModelSelect.el,
    ]);
    const headerRightEl = h('div', { className: 'steps-header-right', hidden: true }, [
      headerFiltersEl,
      stepsExportMenu.el,
    ]);
    function syncHeaderRightVisibility() {
      const hasVisibleRightControl =
        !headerFiltersEl.hasAttribute('hidden') || !stepsExportMenu.el.hasAttribute('hidden');
      patchAttr(headerRightEl, 'hidden', !hasVisibleRightControl);
    }

    const panelEl = h(
      'section',
      {
        className: 'panel steps-panel',
        style: 'flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative;',
      },
      [
        h('div', { className: 'panel-header steps-panel-header' }, [
          h('div', { className: 'steps-header-controls' }, [
            subTabSwitch.el,
            headerRightEl,
          ]),
        ]),
        stepsFilterToolbarEl,
        anomalyFilterBarEl,
        stepsScroll.el,
        modelsScroll.el,
        turnTipEl,
        anomalyTipEl,
      ]
    );
    stepTableWidget.refs.setBoundsElGetter(() => panelEl);

    const rootEl = h('div', { className: 'view-pane' }, [panelEl]);

    let latestSlice = null;
    let isDirty = false;
    let cachedChronoSrc = null;
    let cachedChronoMerged = false;
    let cachedChronoOut = [];

    function getMemoizedChronoSteps(steps, isMergedMultiAgents) {
      if (cachedChronoSrc === steps && cachedChronoMerged === isMergedMultiAgents) {
        return cachedChronoOut;
      }
      cachedChronoSrc = steps;
      cachedChronoMerged = isMergedMultiAgents;
      cachedChronoOut = toChronologicalSteps(steps, isMergedMultiAgents);
      return cachedChronoOut;
    }

    function resolveDefaultActiveModelKey(scopedConv, chronoSteps, models, availableModelKeys) {
      if (scopedConv?.hasKnownModel !== false) {
        const activeCand = getStepModelGroupKey({
          baseModelLabel: scopedConv?.activeBaseModelLabel,
          baseModelShort: scopedConv?.activeBaseModelShort,
          modelLabel: scopedConv?.activeModelLabel,
          modelShort: scopedConv?.activeModelShort,
        });
        if (
          activeCand &&
          activeCand !== t('fmt.unknownModel') &&
          availableModelKeys.has(activeCand)
        ) {
          return activeCand;
        }
      }
      for (let i = chronoSteps.length - 1; i >= 0; i--) {
        const st = chronoSteps[i];
        if (!st || st.isCompactionStep) continue;
        const gk = getStepModelGroupKey(st);
        if (gk && availableModelKeys.has(gk)) return gk;
      }
      if (chronoSteps.length > 0) {
        const gk = getStepModelGroupKey(chronoSteps[chronoSteps.length - 1]);
        if (gk && availableModelKeys.has(gk)) return gk;
      }
      if (models.length > 0) {
        const firstKey = getStepModelGroupKey(models[0]);
        if (firstKey && availableModelKeys.has(firstKey)) return firstKey;
      }
      return '__all__';
    }

    function normalizeMultiModelSelection(rawSelection, availableModelKeys) {
      if (availableModelKeys.size <= 1) return ['__all__'];
      const arr = Array.isArray(rawSelection) ? rawSelection : [];
      if (arr.length === 0 || arr.includes('__all__')) return ['__all__'];
      const valid = Array.from(new Set(arr.filter((k) => availableModelKeys.has(k))));
      if (valid.length === 0) return ['__all__'];
      return valid;
    }

    function refreshStaticLocaleLabels() {
      patchText(lineTitleEl, t('steps.lineTitle'));
      patchText(fitTitleEl, t('steps.fitTitle'));
      patchText(modelsSectionTitleEl, t('steps.modelsTitle'));
      patchText(modelsEmptyEl, t('steps.modelsEmpty'));
      patchText(anomalyFilterClearBtn, t('steps.anomalyFilterAll'));
      patchAttr(stepSearchInput, 'placeholder', t('steps.searchPlaceholder'));
      patchAttr(stepSearchInput, 'aria-label', t('steps.searchPlaceholder'));
      patchAttr(stepSearchClearBtn, 'aria-label', t('steps.searchClearAria'));
      stepsExportMenu.refs.setAriaLabel(t('steps.exportMenuAria'));
      stepsExportMenu.refs.updateItemLabels({
        xlsx: { label: t('steps.exportXlsx'), title: t('steps.exportXlsxTip') },
        md: { label: t('steps.exportMd'), title: t('steps.exportMdTip') },
      });
      lastAnomalyStripSig = '';
      lineMetricSwitch.setProps({
        modelValue: selectedLineMetric,
        options: getLineMetricSwitchOptions(),
      });
      fitMetricSwitch.setProps({
        modelValue: selectedFitMetric,
        options: getFitMetricSwitchOptions(),
      });
      const colKeys = normalizeClientStepColumns(latestSlice?.stepTableColumns);
      syncTableHeaderColumns(colKeys);
      if (!latestSlice) {
        subTabSwitch.setProps({
          modelValue: uiStore.getState().stepsSubTab,
          options: [
            { value: 'steps', label: t('steps.tabSteps', { count: 0 }) },
            { value: 'models', label: t('steps.tabModels') },
          ],
        });
      }
    }

    function renderStepsData(slice, { allowNewRowFade = false } = {}) {
      if (!slice) return;
      const uiSt = uiStore.getState();
      const locale = getEffectiveLocale();

      const currentCid = String(slice.cascadeId || slice.activeConversation?.cascadeId || '');
      if (currentCid !== fitLockedCascadeId) {
        if (fitLockedCascadeId !== null) {
          selectedAgentScopes = [uiSt.selectedAgentScope || 'all'];
          lastSyncedUiScope = uiSt.selectedAgentScope || 'all';
          selectedTableModels = ['__all__'];
          selectedLineModels = ['__all__'];
          onlyAnomalies = false;
          anomalyKindFilter = '';
          stepSearchQuery = '';
          stepSearchInput.value = '';
          patchAttr(stepSearchClearBtn, 'hidden', true);
          stepQuickChip = '';
          sortKey = '';
          sortDir = '';
        }
        fitLockedCascadeId = currentCid;
        fitUserPicked = false;
        fitPinnedWhileVisible = false;
        fitLockedModelKeys = [];
      }

      const baseScope = resolveScopedConversation(
        { activeConversation: slice.activeConversation },
        'all',
        uiSt.ctxInspectorAgentId,
        true
      );
      const { hasSubagents, agents, subagents, mainAgent, aggregated } = baseScope;

      let effectiveScopes = ['main'];
      let isMergedMultiAgents = false;
      let steps = [];
      let models = [];
      let activeModelSource = baseScope.scopedConv;

      patchAttr(inlineScopeSelect.el, 'hidden', !hasSubagents);
      if (hasSubagents) {
        const validAgentIds = ['main', ...subagents.map((s) => s.agentId)];
        const validSet = new Set(validAgentIds);
        if (selectedAgentScopes.length === 0 || selectedAgentScopes.includes('all')) {
          effectiveScopes = ['all'];
        } else {
          const filtered = selectedAgentScopes.filter((id) => validSet.has(id));
          effectiveScopes =
            filtered.length === 0 || filtered.length >= validAgentIds.length
              ? ['all']
              : filtered;
        }
        selectedAgentScopes = effectiveScopes;

        const scopeOpts = [
          {
            value: 'all',
            label: t('steps.allAgents'),
            meta: t('header.convMetaSteps', { count: aggregated?.stepCount ?? 0 }),
          },
          {
            value: 'main',
            label: t('fmt.mainAgent'),
            meta: t('header.convMetaSteps', { count: mainAgent?.stepCount ?? 0 }),
          },
          ...subagents.map((s) => ({
            value: s.agentId,
            label: formatAgentLabel(s),
            meta: t('header.convMetaSteps', { count: s.stepCount || 0 }),
          })),
        ];
        inlineScopeSelect.setProps({
          modelValue: effectiveScopes,
          options: scopeOpts,
          placeholder: t('steps.allAgents'),
          multiUnit: t('steps.unitAgent'),
        });

        if (effectiveScopes[0] === 'all') {
          steps = aggregated?.recentSteps || [];
          models = aggregated?.modelBreakdown || [];
          isMergedMultiAgents = true;
          activeModelSource = aggregated;
        } else if (effectiveScopes.length === 1) {
          const targetId = effectiveScopes[0];
          const unit =
            targetId === 'main'
              ? mainAgent
              : agents.find((a) => a.agentId === targetId) || mainAgent;
          steps = unit?.recentSteps || [];
          models = unit?.modelBreakdown || [];
          isMergedMultiAgents = false;
          activeModelSource = unit;
        } else {
          const scopeSet = new Set(effectiveScopes);
          const selectedUnits = agents.filter((a) =>
            scopeSet.has(a.isMain ? 'main' : a.agentId)
          );
          const merged = mergeSelectedAgentUnits(selectedUnits);
          steps = merged.steps;
          models = merged.models;
          isMergedMultiAgents = true;
          activeModelSource =
            selectedUnits.find((a) => a.isRunning) || selectedUnits[0] || aggregated;
        }
      } else {
        inlineScopeSelect.close();
        steps = slice.recentSteps || [];
        models = slice.sessionModelBreakdown || [];
      }

      const displaySettings = {
        modelDisplayMode: normalizeModelDisplayMode(
          slice.modelDisplayMode,
          slice.showUpstreamModel
        ),
        showUpstreamModel: Boolean(slice.showUpstreamModel),
      };

      const showAgentPrefix = isMergedMultiAgents;
      const showModels = uiSt.stepsSubTab === 'models';

      const availableModelKeys = new Set();
      const modelColorByGroup = new Map();
      const perModelOptions = [];
      let breakdownCalls = 0;
      for (const m of models) {
        if (!m || typeof m !== 'object') continue;
        breakdownCalls += Math.max(0, Number(m.calls || 0));
        const gk = getStepModelGroupKey(m);
        if (availableModelKeys.has(gk)) continue;
        availableModelKeys.add(gk);
        modelColorByGroup.set(
          gk,
          MODEL_COLOR_VARS[(availableModelKeys.size - 1) % MODEL_COLOR_VARS.length]
        );
        const disp = resolveModelDisplayInfo(m, displaySettings, {
          preferLabelInShort: false,
          fallback: gk,
        });
        perModelOptions.push({
          value: gk,
          label: disp.baseText || disp.text || gk,
          meta: t('header.convMetaSteps', { count: Number(m.calls || 0) }),
        });
      }

      const needStepModelFallback =
        steps.length > 0 && (models.length === 0 || breakdownCalls < steps.length);
      if (needStepModelFallback) {
        const stepModelOptionMap = new Map();
        for (const st of steps) {
          const gk = getStepModelGroupKey(st);
          if (!stepModelOptionMap.has(gk)) {
            const disp = resolveModelDisplayInfo(st, displaySettings, { fallback: gk });
            stepModelOptionMap.set(gk, {
              label: disp.baseText || disp.text || gk,
              calls: 0,
            });
          }
          stepModelOptionMap.get(gk).calls += 1;
        }
        for (const [gk, info] of stepModelOptionMap.entries()) {
          if (!availableModelKeys.has(gk)) {
            availableModelKeys.add(gk);
            modelColorByGroup.set(
              gk,
              MODEL_COLOR_VARS[(availableModelKeys.size - 1) % MODEL_COLOR_VARS.length]
            );
            perModelOptions.push({
              value: gk,
              label: info.label,
              meta: t('header.convMetaSteps', { count: info.calls }),
            });
          }
        }
      }

      const hasMultipleModels = availableModelKeys.size > 1;
      const modelSelectOptions = [
        {
          value: '__all__',
          label: t('steps.allModels'),
          meta: t('header.convMetaSteps', { count: steps.length }),
        },
        ...perModelOptions,
      ];

      // 1. “按步查看”动态列头同步与表格行级增量对账
      selectedTableModels = normalizeMultiModelSelection(
        selectedTableModels,
        availableModelKeys
      );
      const showStepsModelFilter = uiSt.stepsSubTab === 'steps' && hasMultipleModels;
      patchAttr(stepsModelSelect.el, 'hidden', !showStepsModelFilter);
      patchAttr(headerFiltersEl, 'hidden', !hasSubagents && !showStepsModelFilter);
      if (hasMultipleModels) {
        stepsModelSelect.setProps({
          modelValue: selectedTableModels,
          options: modelSelectOptions,
          placeholder: t('steps.allModels'),
          multiUnit: t('steps.unitModel'),
        });
        if (!showStepsModelFilter) stepsModelSelect.close();
      } else {
        stepsModelSelect.close();
      }

      const tableModelFilterSet = selectedTableModels.includes('__all__')
        ? null
        : new Set(selectedTableModels);
      const modelFilteredSteps = tableModelFilterSet
        ? steps.filter((st) => tableModelFilterSet.has(getStepModelGroupKey(st)))
        : steps;

      const filterToolbarEnabled = slice.showStepFilterToolbar === true;
      if (!filterToolbarEnabled) {
        if (stepSearchQuery) {
          stepSearchQuery = '';
          stepSearchInput.value = '';
          patchAttr(stepSearchClearBtn, 'hidden', true);
        }
        if (stepQuickChip && stepQuickChip !== 'anomaly') {
          stepQuickChip = '';
        }
      }
      const chipCounts = computeStepQuickChipCounts(modelFilteredSteps);
      const effectiveQuickChip = onlyAnomalies
        ? 'anomaly'
        : filterToolbarEnabled
          ? stepQuickChip
          : '';
      const showFilterToolbar = filterToolbarEnabled && !showModels && steps.length > 0;
      patchAttr(stepsFilterToolbarEl, 'hidden', !showFilterToolbar);
      stepsExportMenu.refs.setHidden(showModels || steps.length === 0);
      syncHeaderRightVisibility();
      if (showFilterToolbar) {
        const activeFilterOpts = [];
        for (const def of QUICK_CHIP_DEFS) {
          const cnt = chipCounts[def.key] || 0;
          const isActive = effectiveQuickChip === def.key;
          if (cnt > 0 || isActive) {
            activeFilterOpts.push({
              value: def.key,
              label: t(def.i18nKey, { count: cnt }),
              ...(def.tipKey ? { title: t(def.tipKey) } : {}),
            });
          }
        }
        const hasFilters = activeFilterOpts.length > 0;
        patchAttr(stepQuickChipsEl, 'hidden', !hasFilters);
        if (hasFilters) {
          stepQuickFilterSwitch.setProps({
            ariaLabel: t('steps.quickFilterAria'),
            modelValue: effectiveQuickChip,
            options: [{ value: '', label: t('steps.chipAll') }, ...activeFilterOpts],
          });
        }
      }

      const filteredTableSteps = filterStepsBySearchAndChip(modelFilteredSteps, {
        query: filterToolbarEnabled ? stepSearchQuery : '',
        quickChip: effectiveQuickChip,
        anomalyKindFilter: onlyAnomalies ? anomalyKindFilter : '',
        displaySettings,
      });

      const normTokenFmt = normalizeClientStepTokenComboFormat(slice.stepTokenComboFormat);
      const sortSig = `${sortKey}:${sortDir}:${normTokenFmt}:${displaySettings.modelDisplayMode}:${displaySettings.showUpstreamModel ? 1 : 0}`;
      let tableSteps = filteredTableSteps;
      if (sortKey && sortDir) {
        if (cachedSortSrc === filteredTableSteps && cachedSortSig === sortSig) {
          tableSteps = cachedSortedOut;
        } else {
          tableSteps = sortStepsByColumn(filteredTableSteps, sortKey, sortDir, {
            stepTokenComboFormat: normTokenFmt,
            displaySettings,
          });
          cachedSortSrc = filteredTableSteps;
          cachedSortSig = sortSig;
          cachedSortedOut = tableSteps;
        }
      } else {
        cachedSortSrc = null;
        cachedSortSig = '';
        cachedSortedOut = [];
      }

      const showAnomalyFilterBar = !showModels && onlyAnomalies;
      patchAttr(anomalyFilterBarEl, 'hidden', !showAnomalyFilterBar);
      if (showAnomalyFilterBar) {
        const baseLabel = t('steps.anomalyFilterLabel', { count: tableSteps.length });
        const kindSuffix = anomalyKindFilter
          ? ` · ${formatAnomalyKindLabel(anomalyKindFilter)}`
          : '';
        patchText(anomalyFilterLabelEl, `${baseLabel}${kindSuffix}`);
      }

      const stepsTabLabel =
        tableSteps.length !== steps.length
          ? t('steps.tabStepsFiltered', {
              filtered: tableSteps.length,
              total: steps.length,
            })
          : t('steps.tabSteps', { count: steps.length });

      subTabSwitch.setProps({
        options: [
          { value: 'steps', label: stepsTabLabel },
          { value: 'models', label: t('steps.tabModels') },
        ],
      });

      const allConversationSteps = hasSubagents
        ? aggregated?.recentSteps || []
        : slice.recentSteps || [];
      currentTableSteps = tableSteps;
      currentAllConvSteps = allConversationSteps;
      currentDisplaySettings = displaySettings;
      const shouldAnimateNewRows = Boolean(
        allowNewRowFade && slice.experimentalModernUi && !showModels
      );
      if (!showModels) {
        const colKeys = normalizeClientStepColumns(slice.stepTableColumns);
        renderStepTable(tableSteps, slice.cascadeId, colKeys, locale, {
          effectiveScopes,
          hasSubagents,
          isMergedMultiAgents,
          showStepTurnRail: slice.showStepTurnRail === true,
          showStepAgentBadge: slice.showStepAgentBadge !== false,
          showStepSpeedColor: slice.showStepSpeedColor === true,
          stepTokenComboFormat: slice.stepTokenComboFormat,
          displaySettings,
          allConversationSteps,
          allowNewRowFade: shouldAnimateNewRows,
          fontScale: slice.fontScale,
          sortKey,
          sortDir,
        });
        stepsScroll.refresh();
        fitPinnedWhileVisible = false;
        onLayoutChange?.();
        return;
      }

      const chronoSteps = getMemoizedChronoSteps(steps, isMergedMultiAgents);
      const stepTtftFallbackMap = new Map();
      const needTtftFallback = models.some((m) => m && m.avgTtftSec == null);
      if (needTtftFallback) {
        for (const st of chronoSteps) {
          if (!st.isCompactionStep && Number.isFinite(st.ttftSec) && st.ttftSec >= 0) {
            const gk = getStepModelGroupKey(st);
            const prev = stepTtftFallbackMap.get(gk) || { sum: 0, count: 0 };
            prev.sum += Number(st.ttftSec);
            prev.count += 1;
            stepTtftFallbackMap.set(gk, prev);
          }
        }
      }

      // 2. 顶部“会话走势”更新
      selectedLineModels = normalizeMultiModelSelection(
        selectedLineModels,
        availableModelKeys
      );

      // 3. 顶部“趋势拟合”模型锁定随当前会话与代理范围更新。
      const defaultActiveModelKey = resolveDefaultActiveModelKey(
        activeModelSource,
        chronoSteps,
        models,
        availableModelKeys
      );
      const sanitizedLocked = fitLockedModelKeys.includes('__all__')
        ? ['__all__']
        : Array.from(new Set(fitLockedModelKeys.filter((k) => availableModelKeys.has(k))));

      if ((!fitPinnedWhileVisible && !fitUserPicked) || sanitizedLocked.length === 0) {
        fitLockedModelKeys = [defaultActiveModelKey];
      } else {
        fitLockedModelKeys = sanitizedLocked;
      }
      if (availableModelKeys.size > 0) fitPinnedWhileVisible = true;

      patchAttr(lineModelSelect.el, 'hidden', !hasMultipleModels);
      if (hasMultipleModels) {
        lineModelSelect.setProps({
          modelValue: selectedLineModels,
          options: modelSelectOptions,
          placeholder: t('steps.allModels'),
          multiUnit: t('steps.unitModel'),
        });
      } else {
        lineModelSelect.close();
      }

      const lineRes = sessionLineChart.update({
        steps: chronoSteps,
        modelGroupKey: selectedLineModels[0] || '__all__',
        modelGroupKeys: selectedLineModels,
        modelColorByGroup,
        metric: selectedLineMetric,
        showAgentPrefix,
        displaySettings,
      });
      patchText(lineSummaryBadge, lineRes.summaryBadge);

      const effectiveFitModelKeys =
        availableModelKeys.size === 0
          ? ['__all__']
          : !hasMultipleModels
            ? [Array.from(availableModelKeys)[0]]
            : fitLockedModelKeys.length > 0
              ? fitLockedModelKeys
              : [defaultActiveModelKey];

      patchAttr(fitModelSelect.el, 'hidden', !hasMultipleModels);
      if (hasMultipleModels) {
        fitModelSelect.setProps({
          modelValue: effectiveFitModelKeys,
          options: modelSelectOptions,
          placeholder: t('steps.selectModel'),
          multiUnit: t('steps.unitModel'),
        });
      } else {
        fitModelSelect.close();
      }

      const fitRes = modelFitChart.update({
        steps: chronoSteps,
        modelGroupKey: effectiveFitModelKeys[0] || '__all__',
        modelGroupKeys: effectiveFitModelKeys,
        modelColorByGroup,
        metric: selectedFitMetric,
        showAgentPrefix,
        displaySettings,
      });
      patchText(fitSummaryBadge, fitRes.summaryBadge);

      // 4. 极简模型总览列表增量对账
      const displayModels = mergeModelsByDisplayName(models, displaySettings, { fallback: '—' });
      const needStepAnomalyFallback = displayModels.every((m) => !(Number(m?.anomalyCount) > 0));
      let stepAnomalyByGroup = null;
      if (needStepAnomalyFallback) {
        for (const st of chronoSteps) {
          const a = st?.anomaly;
          if (!a || !(Number(a.count) > 0)) continue;
          if (!stepAnomalyByGroup) stepAnomalyByGroup = new Map();
          const gk = getStepModelGroupKey(st);
          let acc = stepAnomalyByGroup.get(gk);
          if (!acc) {
            acc = {
              anomalySteps: 0,
              anomalyCount: 0,
              anomalyDangerCount: 0,
              anomalyTotalDelaySec: 0,
              anomalyByKind: {},
            };
            stepAnomalyByGroup.set(gk, acc);
          }
          acc.anomalySteps += 1;
          acc.anomalyCount += Number(a.count) || 0;
          if (a.severity === 'danger') acc.anomalyDangerCount += 1;
          acc.anomalyTotalDelaySec += Number(a.totalDelaySec) || 0;
          if (a.kinds && typeof a.kinds === 'object') {
            for (const [k, cnt] of Object.entries(a.kinds)) {
              const n = Math.max(0, Number(cnt || 0));
              if (n > 0) acc.anomalyByKind[k] = (acc.anomalyByKind[k] || 0) + n;
            }
          }
        }
      }
      const resolveEffectiveAnomalyModel = (m) => {
        if (Number(m?.anomalyCount) > 0 || !stepAnomalyByGroup) return m;
        const gk = getStepModelGroupKey(m);
        const groupKeys =
          Array.isArray(m.sourceLabels) && m.sourceLabels.length > 0
            ? Array.from(new Set(m.sourceLabels.map((lbl) => getStepModelGroupKey({ label: lbl }))))
            : [gk];
        let anomalySteps = 0;
        let anomalyCount = 0;
        let anomalyDangerCount = 0;
        let anomalyTotalDelaySec = 0;
        const anomalyByKind = {};
        for (const key of groupKeys) {
          const hit = stepAnomalyByGroup.get(key);
          if (!hit) continue;
          anomalySteps += hit.anomalySteps;
          anomalyCount += hit.anomalyCount;
          anomalyDangerCount += hit.anomalyDangerCount;
          anomalyTotalDelaySec += hit.anomalyTotalDelaySec;
          for (const [k, cnt] of Object.entries(hit.anomalyByKind)) {
            anomalyByKind[k] = (anomalyByKind[k] || 0) + cnt;
          }
        }
        if (anomalyCount <= 0) return m;
        return {
          ...m,
          anomalySteps,
          anomalyCount,
          anomalyDangerCount,
          anomalyTotalDelaySec: +anomalyTotalDelaySec.toFixed(1),
          anomalyByKind,
        };
      };

      let sumCalls = 0;
      let sumTokens = 0;
      let sumCost = 0;
      let sumUnpriced = 0;
      let sumAnomalyCount = 0;
      let sumAnomalySteps = 0;
      const sumAnomalyByKind = {};
      const effectiveAnomalyModels = new Map();
      for (const m of displayModels) {
        sumCalls += Math.max(0, Number(m.calls || 0));
        sumTokens += Math.max(0, Number(m.totalTokens || 0));
        sumUnpriced += Math.max(0, Number(m.unpricedCalls || 0));
        if (Number.isFinite(Number(m.costUsd))) {
          sumCost += Math.max(0, Number(m.costUsd));
        }
        const effM = resolveEffectiveAnomalyModel(m);
        effectiveAnomalyModels.set(m, effM);
        const anomSum = resolveModelAnomalySummary(effM);
        if (anomSum) {
          sumAnomalyCount += anomSum.count;
          sumAnomalySteps += anomSum.steps;
          for (const [k, v] of anomSum.entries) {
            sumAnomalyByKind[k] = (sumAnomalyByKind[k] || 0) + v;
          }
        }
      }

      if (sumAnomalyCount > 0) {
        patchAttr(modelsAnomalyStripEl, 'hidden', false);
        const sortedKinds = Object.entries(sumAnomalyByKind)
          .filter(([, v]) => v > 0)
          .sort((a, b) => b[1] - a[1]);
        const hasDangerKind = sortedKinds.some(
          ([kind]) => kind === 'rate_limit' || kind === 'auth_or_model'
        );
        patchClasses(modelsAnomalyStripEl, { 'has-danger': hasDangerKind });
        const stripSig = `${locale}:${sumAnomalyCount}:${sumAnomalySteps}:${sortedKinds.map(([k, v]) => `${k}=${v}`).join(',')}`;
        if (stripSig !== lastAnomalyStripSig) {
          lastAnomalyStripSig = stripSig;
          patchText(
            modelsAnomalyMetaEl,
            t('steps.anomalySummaryMeta', { count: sumAnomalyCount, steps: sumAnomalySteps })
          );
          while (modelsAnomalyTagsEl.firstChild) {
            modelsAnomalyTagsEl.removeChild(modelsAnomalyTagsEl.firstChild);
          }
          for (const [kind, cnt] of sortedKinds) {
            const isDanger = kind === 'rate_limit' || kind === 'auth_or_model';
            const btn = h('button', {
              type: 'button',
              className: `step-anomaly-tag smodel-anomaly-tag text-mono${isDanger ? ' is-danger' : ''}`,
              text: formatAnomalyTagText(kind, cnt),
              title: `${formatAnomalyKindLabel(kind)} · ${t('steps.anomalyModelClickHint')}`,
              onclick: () => {
                hideAnomalyTip();
                selectedTableModels = ['__all__'];
                onlyAnomalies = true;
                anomalyKindFilter = kind;
                uiStore.setState({ stepsSubTab: 'steps' });
              },
            });
            modelsAnomalyTagsEl.appendChild(btn);
          }
        }
      } else {
        lastAnomalyStripSig = '';
        patchAttr(modelsAnomalyStripEl, 'hidden', true);
      }

      if (displayModels.length === 0) {
        patchText(modelsSummaryMeta, t('cons.callsCount', { calls: 0 }));
      } else {
        const modelCountPart =
          displayModels.length > 1
            ? t('steps.modelsSummaryPrefix', { count: displayModels.length })
            : '';
        const isAllUnpricedSum = sumCalls > 0 && sumUnpriced >= sumCalls && !(sumCost > 0);
        patchText(
          modelsSummaryMeta,
          `${modelCountPart}${t('cons.callsCount', { calls: sumCalls })} · ${formatTokens(sumTokens)} · ${formatUsd(
            isAllUnpricedSum ? null : sumCost,
            {
              precise: sumCost > 0 && sumCost < 0.1,
            }
          )}`
        );
      }
      patchAttr(modelsEmptyEl, 'hidden', displayModels.length > 0);
      patchAttr(modelsListEl, 'hidden', displayModels.length === 0);

      const isFitPooledAll = effectiveFitModelKeys.includes('__all__');
      const fitActiveKeySet = new Set(isFitPooledAll ? [] : effectiveFitModelKeys);

      patchKeyedList(modelsListEl, displayModels, {
        keyFn: (m) => m.displayText || m.label || m.shortName,
        sigFn: (m) => {
          const gk = getStepModelGroupKey(m);
          const fbTtft = stepTtftFallbackMap.get(gk);
          const avgTtft =
            m.avgTtftSec != null
              ? m.avgTtftSec
              : fbTtft && fbTtft.count > 0
                ? +(fbTtft.sum / fbTtft.count).toFixed(1)
                : null;
          const cardGroupKeys =
            Array.isArray(m.sourceLabels) && m.sourceLabels.length > 0
              ? m.sourceLabels.map((lbl) => getStepModelGroupKey({ label: lbl }))
              : [gk];
          const isActiveFit =
            hasMultipleModels && cardGroupKeys.some((k) => fitActiveKeySet.has(k));
          const effM = effectiveAnomalyModels.get(m) || m;
          const anomSum = resolveModelAnomalySummary(effM);
          const anomSig = anomSum
            ? `${anomSum.count}:${anomSum.steps}:${anomSum.primaryKind}:${anomSum.severity}:${anomSum.totalDelaySec}`
            : '';
          return `${locale}:${m.displayText}:${m.displayTitle}:${m.calls}:${sumCalls}:${sumTokens}:${displayModels.length}:${m.avgTokPerSec}:${avgTtft}:${m.cacheHitPct}:${m.inputTokens}:${m.cacheReadTokens}:${m.thinkingTokens}:${m.responseTokens}:${m.totalTokens}:${m.costUsd}:${m.unpricedCalls}:${isActiveFit}:${hasMultipleModels}:${anomSig}`;
        },
        createRow: () => {
          const nameEl = h('strong', { className: 'cons-row-title-text smodel-name' });
          const anomalyTagEl = h('span', {
            className: 'step-anomaly-tag smodel-anomaly-tag text-mono',
            title: '',
            hidden: true,
          });
          const titleWrapEl = h('strong', { className: 'cons-row-title smodel-ident' }, [
            nameEl,
            anomalyTagEl,
          ]);
          const pctBadgeEl = h('span', { className: 'cons-share-pill text-mono', text: '0%' });
          const tokEl = h('span', { className: 'cons-row-tok smodel-tok text-mono' });
          const costEl = h('strong', { className: 'cons-row-cost smodel-cost text-mono' });
          const segBar = createFourSegmentBar();
          segBar.el.classList.add('smodel-seg-bar');

          const inLbl = h('span', { text: t('cons.footInput') });
          const cacheLbl = h('span', { text: t('cons.footCache') });
          const thinkLbl = h('span', { text: t('cons.footThinking') });
          const outLbl = h('span', { text: t('cons.footOutput') });
          const callsLbl = h('span', { text: t('cons.footCalls') });
          const inVal = h('strong', { className: 'text-mono' });
          const cacheVal = h('strong', { className: 'text-mono' });
          const thinkVal = h('strong', { className: 'text-mono' });
          const outVal = h('strong', { className: 'text-mono' });
          const callsVal = h('strong', { className: 'text-mono' });
          const footEl = h('div', { className: 'cons-item-foot smodel-foot' }, [
            h('span', { className: 'legend-left' }, [
              h('span', { className: 'dot-swatch seg-input' }),
              inLbl,
              inVal,
            ]),
            h('span', { className: 'legend-left' }, [
              h('span', { className: 'dot-swatch seg-cached' }),
              cacheLbl,
              cacheVal,
            ]),
            h('span', { className: 'legend-left' }, [
              h('span', { className: 'dot-swatch seg-thinking' }),
              thinkLbl,
              thinkVal,
            ]),
            h('span', { className: 'legend-left' }, [
              h('span', { className: 'dot-swatch seg-output' }),
              outLbl,
              outVal,
            ]),
            h('span', { className: 'legend-left' }, [callsLbl, callsVal]),
          ]);
          const perfEl = h('span', { className: 'cons-model-perf-main smodel-perf text-mono' });
          const unitCostEl = h('span', {
            className: 'cons-model-unit-cost smodel-unit-cost text-mono',
            hidden: true,
          });
          const perfFootEl = h('div', { className: 'cons-model-perf-foot smodel-perf-foot' }, [
            perfEl,
            unitCostEl,
          ]);

          const cardEl = h('div', { className: 'cons-item-row smodel-card' }, [
            h('div', { className: 'panel-header smodel-head' }, [
              titleWrapEl,
              h('span', { className: 'cons-row-metrics smodel-totals' }, [
                pctBadgeEl,
                tokEl,
                costEl,
              ]),
            ]),
            segBar.el,
            footEl,
            perfFootEl,
          ]);

          return {
            el: cardEl,
            refs: {
              nameEl,
              pctBadgeEl,
              anomalyTagEl,
              tokEl,
              costEl,
              segBar,
              perfEl,
              unitCostEl,
              inLbl,
              cacheLbl,
              thinkLbl,
              outLbl,
              callsLbl,
              inVal,
              cacheVal,
              thinkVal,
              outVal,
              callsVal,
              cardTitle: '',
              isHoveringAnomaly: false,
            },
          };
        },
        updateRow: (refs, m, _idx, cardEl) => {
          const gk = getStepModelGroupKey(m);
          const cardGroupKeys =
            Array.isArray(m.sourceLabels) && m.sourceLabels.length > 0
              ? Array.from(
                  new Set(m.sourceLabels.map((lbl) => getStepModelGroupKey({ label: lbl })))
                )
              : [gk];
          const dispText = m.displayText || '—';
          const dispTitle = m.displayTitle || dispText;
          patchText(refs.nameEl, dispText);
          patchAttr(refs.nameEl, 'title', dispTitle);

          const calls = Math.max(0, Number(m.calls || 0));

          const effM = effectiveAnomalyModels.get(m) || m;
          const anomSum = resolveModelAnomalySummary(effM);
          patchAttr(refs.anomalyTagEl, 'hidden', !anomSum);
          if (anomSum) {
            patchText(refs.anomalyTagEl, anomSum.tagText);
            patchClasses(refs.anomalyTagEl, { 'is-danger': anomSum.severity === 'danger' });
            patchAttr(refs.anomalyTagEl, 'title', '');
            refs.anomalyTagEl.onmouseenter = () => {
              refs.isHoveringAnomaly = true;
              patchAttr(cardEl, 'title', null);
              showAnomalyTip(refs.anomalyTagEl, buildModelAnomalyDiagnostic(effM));
            };
            refs.anomalyTagEl.onmouseleave = () => {
              refs.isHoveringAnomaly = false;
              patchAttr(cardEl, 'title', refs.cardTitle || null);
              hideAnomalyTip();
            };
            refs.anomalyTagEl.onclick = (e) => {
              e?.stopPropagation?.();
              refs.isHoveringAnomaly = false;
              patchAttr(cardEl, 'title', refs.cardTitle || null);
              hideAnomalyTip();
              selectedTableModels = hasMultipleModels ? [...cardGroupKeys] : ['__all__'];
              onlyAnomalies = true;
              anomalyKindFilter = '';
              uiStore.setState({ stepsSubTab: 'steps' });
            };
          } else {
            refs.isHoveringAnomaly = false;
            refs.anomalyTagEl.onmouseenter = null;
            refs.anomalyTagEl.onmouseleave = null;
            refs.anomalyTagEl.onclick = null;
          }

          const inTok = Math.max(0, Number(m.inputTokens || 0));
          const cacheTok = Math.max(0, Number(m.cacheReadTokens || 0));
          const outTok = Math.max(0, Number(m.outputTokens || 0));
          const thinkTok = Math.max(0, Number(m.thinkingTokens || 0));
          const respTok =
            m.responseTokens != null
              ? Math.max(0, Number(m.responseTokens))
              : Math.max(0, outTok - thinkTok);

          const modelTok = Math.max(0, Number(m.totalTokens || 0));
          const tokSharePct =
            sumTokens > 0 ? (modelTok / sumTokens) * 100 : sumCalls > 0 ? (calls / sumCalls) * 100 : 0;
          patchText(refs.pctBadgeEl, formatPctNumber(tokSharePct, { withSymbol: true }));
          patchText(refs.tokEl, formatTokensPrecise(modelTok));
          const costNum = Number(m.costUsd || 0);
          const isAllUnpriced =
            calls > 0 && Number(m.unpricedCalls || 0) >= calls && !(costNum > 0);
          patchText(
            refs.costEl,
            formatUsd(isAllUnpriced ? null : costNum, { precise: costNum > 0 && costNum < 0.1 })
          );

          const scaleRatio =
            displayModels.length > 1 && sumTokens > 0 && modelTok > 0
              ? Math.min(1, Math.max(0.008, modelTok / sumTokens))
              : 1;
          refs.segBar.update({
            inputTokens: inTok,
            cacheReadTokens: cacheTok,
            responseTokens: respTok,
            thinkingTokens: thinkTok,
            scaleRatio,
          });

          const fbTtft = stepTtftFallbackMap.get(gk);
          const resolvedAvgTtft =
            m.avgTtftSec != null
              ? Number(m.avgTtftSec)
              : fbTtft && fbTtft.count > 0
                ? fbTtft.sum / fbTtft.count
                : null;
          const promptTok = inTok + cacheTok;
          const resolvedCachePct =
            m.cacheHitPct != null
              ? Number(m.cacheHitPct)
              : promptTok > 0
                ? +((cacheTok / promptTok) * 100).toFixed(1)
                : 0;

          patchText(refs.inLbl, t('cons.footInput'));
          patchText(refs.cacheLbl, t('cons.footCache'));
          patchText(refs.thinkLbl, t('cons.footThinking'));
          patchText(refs.outLbl, t('cons.footOutput'));
          patchText(refs.callsLbl, t('cons.footCalls'));
          patchText(refs.inVal, formatTokensPrecise(inTok));
          patchText(refs.cacheVal, formatTokensPrecise(cacheTok));
          patchText(refs.thinkVal, formatTokensPrecise(thinkTok));
          patchText(refs.outVal, formatTokensPrecise(respTok));
          patchText(refs.callsVal, String(calls));

          patchText(
            refs.perfEl,
            t('steps.modelPerfFoot', {
              tps: formatSpeedMetric(m.avgTokPerSec, ' tok/s'),
              ttft: formatMetric(resolvedAvgTtft, 's'),
              cache: resolvedCachePct,
            })
          );
          const effCostPer1M =
            !isAllUnpriced && costNum > 0 && modelTok >= 1000
              ? costNum / (modelTok / 1_000_000)
              : null;
          patchAttr(refs.unitCostEl, 'hidden', effCostPer1M === null);
          patchText(
            refs.unitCostEl,
            effCostPer1M !== null
              ? t('cons.modelUnitCost', {
                  cost: formatUsd(effCostPer1M, { precise: effCostPer1M < 0.1 }),
                })
              : ''
          );

          const isActiveFit =
            hasMultipleModels && cardGroupKeys.some((k) => fitActiveKeySet.has(k));
          patchClasses(cardEl, { 'is-fit-active': isActiveFit });
          refs.cardTitle = !hasMultipleModels
            ? dispTitle
            : isActiveFit
              ? t('steps.fitActiveCardTitle', { title: dispTitle })
              : t('steps.fitInactiveCardTitle', { text: dispText });
          patchAttr(cardEl, 'title', refs.isHoveringAnomaly ? null : refs.cardTitle);
          cardEl.onclick = (e) => {
            if (!hasMultipleModels) return;
            if (e && (e.ctrlKey || e.metaKey || e.shiftKey) && !isFitPooledAll) {
              const cardSet = new Set(cardGroupKeys);
              const next = isActiveFit
                ? effectiveFitModelKeys.filter((k) => !cardSet.has(k))
                : Array.from(new Set([...effectiveFitModelKeys, ...cardGroupKeys]));
              fitLockedModelKeys = next.length > 0 ? next : [...cardGroupKeys];
              fitUserPicked = true;
              fitPinnedWhileVisible = true;
              if (latestSlice) renderStepsData(latestSlice);
              return;
            }
            const isAlreadySole =
              !isFitPooledAll &&
              effectiveFitModelKeys.length === cardGroupKeys.length &&
              cardGroupKeys.every((k) => fitActiveKeySet.has(k));
            if (!isAlreadySole || !fitUserPicked) {
              fitLockedModelKeys = [...cardGroupKeys];
              fitUserPicked = true;
              fitPinnedWhileVisible = true;
              if (latestSlice) renderStepsData(latestSlice);
            }
          };
        },
      });

      modelsScroll.refresh();
      onLayoutChange?.();
    }

    const unsubUi = uiStore.subscribe(
      (st) => st.stepsSubTab,
      (tab) => {
        hideTurnTip();
        hideAnomalyTip();
        subTabSwitch.setValue(tab);
        patchAttr(anomalyFilterBarEl, 'hidden', tab !== 'steps' || !onlyAnomalies);
        const toolbarAllowed = latestSlice?.showStepFilterToolbar === true;
        patchAttr(
          stepsFilterToolbarEl,
          'hidden',
          tab !== 'steps' || !toolbarAllowed || (currentTableSteps.length === 0 && !stepSearchQuery && !stepQuickChip)
        );
        if (tab !== 'steps') {
          patchAttr(stepsModelSelect.el, 'hidden', true);
          patchAttr(headerFiltersEl, 'hidden', inlineScopeSelect.el.hasAttribute('hidden'));
        }
        stepsExportMenu.refs.setHidden(tab !== 'steps' || currentAllConvSteps.length === 0);
        syncHeaderRightVisibility();
        patchAttr(stepsScroll.el, 'hidden', tab !== 'steps');
        patchAttr(modelsScroll.el, 'hidden', tab !== 'models');
        if (getVisibleMonitorView() === 'steps' && latestSlice) {
          renderStepsData(latestSlice);
        } else if (tab === 'steps') {
          refreshStepTableViewport();
          stepsScroll.refresh();
        } else {
          modelsScroll.refresh();
        }
      }
    );

    const unsubTelemetry = telemetryStore.subscribe(
      (st) => ({
        activeConversation: st.telemetry?.activeConversation,
        cascadeId: st.telemetry?.activeConversation?.cascadeId,
        recentSteps: st.telemetry?.activeConversation?.recentSteps,
        sessionModelBreakdown: st.telemetry?.activeConversation?.modelBreakdown,
        modelDisplayMode: normalizeModelDisplayMode(
          st.telemetry?.settings?.modelDisplayMode,
          st.telemetry?.settings?.showUpstreamModel
        ),
        showUpstreamModel: Boolean(st.telemetry?.settings?.showUpstreamModel),
        showStepTurnRail: st.telemetry?.settings?.showStepTurnRail === true,
        showStepAgentBadge: st.telemetry?.settings?.showStepAgentBadge !== false,
        showStepSpeedColor: st.telemetry?.settings?.showStepSpeedColor === true,
        showStepFilterToolbar: st.telemetry?.settings?.showStepFilterToolbar === true,
        stepTokenComboFormat: normalizeClientStepTokenComboFormat(
          st.telemetry?.settings?.stepTokenComboFormat
        ),
        stepTableColumns: st.telemetry?.settings?.stepTableColumns,
        fontScale: normalizeClientFontScale(st.telemetry?.settings?.fontScale),
        experimentalModernUi: resolveSettingsModernUi(st.telemetry?.settings),
      }),
      (slice) => {
        latestSlice = slice;
        if (getVisibleMonitorView() !== 'steps') {
          if (!fitUserPicked) {
            fitPinnedWhileVisible = false;
          }
          isDirty = true;
          return;
        }
        isDirty = false;
        renderStepsData(slice, {
          allowNewRowFade: uiStore.getState().stepsSubTab === 'steps',
        });
      }
    );

    let prevScope = uiStore.getState().selectedAgentScope;
    let prevActiveView = getVisibleMonitorView();

    const unsubView = uiStore.subscribe(
      (st) => ({
        activeView: getVisibleMonitorView(st),
        selectedAgentScope: st.selectedAgentScope,
      }),
      (uiSlice) => {
        const scopeChanged = uiSlice.selectedAgentScope !== prevScope;
        if (uiSlice.selectedAgentScope !== lastSyncedUiScope) {
          lastSyncedUiScope = uiSlice.selectedAgentScope;
          selectedAgentScopes = [uiSlice.selectedAgentScope || 'all'];
        }
        const viewEntered = uiSlice.activeView === 'steps' && prevActiveView !== 'steps';
        prevScope = uiSlice.selectedAgentScope;
        prevActiveView = uiSlice.activeView;
        if (uiSlice.activeView !== 'steps') {
          hideTurnTip();
          hideAnomalyTip();
          fitPinnedWhileVisible = false;
          if (scopeChanged) isDirty = true;
          return;
        }
        if ((isDirty || scopeChanged || viewEntered) && latestSlice) {
          isDirty = false;
          renderStepsData(latestSlice);
        }
      }
    );

    const unsubI18n = i18nStore.subscribe(
      (st) => st.locale,
      () => {
        refreshStaticLocaleLabels();
        if (getVisibleMonitorView() === 'steps' && latestSlice) {
          renderStepsData(latestSlice);
        } else {
          isDirty = true;
        }
      }
    );

    onCleanup(() => {
      stepsExportMenu.destroy();
      modelsAnalyticsPane.removeEventListener('scroll', onModelsPaneScroll);
      unsubUi();
      unsubTelemetry();
      unsubView();
      unsubI18n();
      stepTableWidget.destroy();
      sessionLineChart.destroy?.();
      modelFitChart.destroy?.();
      inlineScopeSelect.destroy();
      stepsModelSelect.destroy();
      stepQuickFilterSwitch.destroy();
      subTabSwitch.destroy();
      lineModelSelect.destroy();
      lineMetricSwitch.destroy();
      fitModelSelect.destroy();
      fitMetricSwitch.destroy();
      stepsScroll.destroy();
      modelsScroll.destroy();
    });

    return {
      el: rootEl,
      refs: {
        stepsTableEl,
        stepsTheadRow,
        stepsTbody,
        turnTipEl,
        anomalyTipEl,
        anomalyFilterBarEl,
        stepsFilterToolbarEl,
        stepSearchInput,
        stepQuickChipsEl,
        stepsExportMenu,
        modelsAnomalyStripEl,
        modelsListEl,
        inlineScopeSelect,
        stepsModelSelect,
        subTabSwitch,
        lineModelSelect,
        lineMetricSwitch,
        fitModelSelect,
        fitMetricSwitch,
        stepsScroll,
        modelsScroll,
        refreshStepTableViewport,
      },
    };
  },
});
