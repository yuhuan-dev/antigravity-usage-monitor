/**
 * @fileoverview View 2: ConsumptionView (全景消耗统计视图).
 * 采用 5 段式分析布局展示指定时间窗口内的全量 Token 与费用消耗：
 * 1. 用量概览：支持预设时间段与自定义区间筛选，通过 3+3 组合矩阵展示总 Token/调用次数、
 *    USD/CNY 预估费用、缓存命中率与命中量、新输入/缓存读取（含节省费用）/输出细分占比，以及底部 4 段比例条 (`FourSegmentBar`)。
 * 2. 历史趋势：基于 `TrendAreaChart` 渲染纯 SVG 三次贝塞尔平滑曲线面积图、峰值气泡、对齐多刻度时间轴与悬停详情浮层。
 * 3. 热门模型：按 Token 总量降序展示各模型的消耗占比徽章、4 段构成条及输入/缓存/输出/思考/调用明细。
 * 4. 数据来源：按调用来源聚合展示 Token 构成、占比与费用明细。
 * 5. 按月细分：12 个月垂直 4 段堆叠柱状图，直观对比全年各月费用、Token 总量与缓存/思考结构。
 */

import { defineComponent } from '../core/component.js';
import {
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchStyleVar,
  patchText,
} from '../core/domPatch.js';
import {
  buildDeterministicModelColorMap,
  formatDateSpanBadge,
  formatFxRateCaption,
  formatMetric,
  formatPctNumber,
  formatQuotaPoolLabel,
  formatSecondaryCostApprox,
  formatSpeedMetric,
  formatTokensPrecise,
  formatUsd,
  getCanonicalModelColorSeed,
  mergeModelsByDisplayName,
  normalizeModelDisplayMode,
  resolveDeterministicModelColor,
} from '../core/formatters.js';
import { normalizeDisplayCurrency } from '../../shared/currency-catalog.mjs';
import { scaleBucketsExact } from '../../shared/telemetry-display-rules.mjs';
import {
  buildConsumptionExportBaseName,
  buildConsumptionMarkdownReport,
  buildConsumptionXlsx,
  sanitizeExportFilename,
} from '../core/reportExporter.js';
import {
  copyTextWithFeedback,
  exportBinaryFileWithFeedback,
} from '../core/fileExportClient.js';
import { getEffectiveLocale, i18nStore, t } from '../i18n/index.js';
import { createSvgIcon } from '../icons/SvgIcon.js';
import { ActionMenu } from '../components/ui/ActionMenu.js';
import {
  getDefaultCtxInspectorAgentId,
  prefetchConsumptionPresets,
  selectConsumptionCyclePool,
  selectConsumptionTimeRange,
  selectConversation,
  telemetryStore,
} from '../store/telemetryStore.js';
import { getVisibleMonitorView, uiStore } from '../store/uiStore.js';
import {
  createTrendAreaChart,
  HEATMAP_DAYS_THRESHOLD,
} from '../components/charts/TrendAreaChart.js';
import { CustomDateTimePicker } from '../components/ui/CustomDateTimePicker.js';
import { CustomScrollbar } from '../components/ui/CustomScrollbar.js';
import { CustomSelect } from '../components/ui/CustomSelect.js';
import { createFourSegmentBar } from '../components/ui/FourSegmentBar.js';
import { createConsumptionBreakdownContent } from '../components/ui/ConsumptionTooltipContent.js';
import { SegmentedControl } from '../components/ui/SegmentedControl.js';
import {
  createBreakdownItemRow,
  createConsumptionBreakdownRowBuilders,
  partitionModelSegments,
  updateBreakdownItemRow,
} from '../components/widgets/ConsumptionBreakdownRows.js';
import { SafetyMonitorCard } from '../components/widgets/SafetyMonitorCard.js';

/** 消耗统计顶栏支持的时间范围预设项 */
function getConsumptionTimeRangeOptions() {
  return [
    { value: 'cycle', label: t('cons.rangeCycle') },
    { value: 'today', label: t('cons.rangeToday') },
    { value: '24h', label: t('cons.range24h') },
    { value: '7d', label: t('cons.range7d') },
    { value: '14d', label: t('cons.range14d') },
    { value: '30d', label: t('cons.range30d') },
    { value: 'all', label: t('cons.rangeAll') },
    { value: 'custom', label: t('cons.rangeCustom') },
  ];
}

/** 热力图顶栏支持的四档聚合视图选项 */
function getHeatmapModeOptions() {
  return [
    { value: 'day', label: t('cons.hmModeDay') },
    { value: 'week', label: t('cons.hmModeWeek') },
    { value: 'month', label: t('cons.hmModeMonth') },
    { value: 'all', label: t('cons.hmModeAll') },
  ];
}

function floorToStartOfMinuteMs(ms) {
  const n = Number(ms);
  if (!(n > 0)) return 0;
  const d = new Date(n);
  d.setSeconds(0, 0);
  return d.getTime();
}

function ceilToEndOfMinuteMs(ms) {
  const n = Number(ms);
  if (!(n > 0)) return 0;
  const d = new Date(n);
  d.setSeconds(59, 999);
  return d.getTime();
}

function formatCyclePoolShortLabel(poolKey, poolLabel) {
  if (poolKey === 'Argon') return 'Argon';
  if (poolKey === 'Carbon') return 'Carbon';
  if (poolKey === 'Claude & GPT') return 'Claude/GPT';
  return poolLabel || poolKey;
}

function buildCyclePoolSelectOptions(pools, isCustomWeeklyMode = false) {
  const list = Array.isArray(pools) ? pools : [];
  let sumCycleCost = 0;
  let hasAnyCycleCost = false;
  for (let i = 0; i < list.length; i++) {
    const c = Number(list[i]?.cycleWeekly?.costUsd);
    if (Number.isFinite(c) && c >= 0 && list[i]?.cycleWeekly) {
      sumCycleCost += c;
      hasAnyCycleCost = true;
    }
  }
  const allLabel = t('cons.cyclePoolAll');
  const opts = [
    {
      value: 'all',
      label: allLabel,
      shortLabel: t('cons.cyclePoolAllShort'),
      meta: !isCustomWeeklyMode && hasAnyCycleCost ? formatUsd(sumCycleCost) : '',
      title: allLabel,
    },
  ];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const key = String(p?.poolKey || p?.family || '').trim();
    if (!key || key === 'Unknown') continue;
    const label = String(p?.poolLabel || key).trim();
    const shortLabel = formatCyclePoolShortLabel(key, label);
    const metaParts = [];
    if (
      !isCustomWeeklyMode &&
      p?.weeklyRemainingPct != null &&
      Number.isFinite(Number(p.weeklyRemainingPct))
    ) {
      metaParts.push(
        t('cons.cyclePoolRemMeta', {
          pct: formatPctNumber(p.weeklyRemainingPct, { withSymbol: true }),
        })
      );
    }
    if (!isCustomWeeklyMode && p?.cycleWeekly && Number.isFinite(Number(p.cycleWeekly.costUsd))) {
      metaParts.push(formatUsd(p.cycleWeekly.costUsd));
    }
    const meta = metaParts.join(' · ');
    opts.push({
      value: key,
      label,
      shortLabel,
      meta,
      title: meta ? `${label} (${meta})` : label,
    });
  }
  return opts;
}

function formatCycleMinuteSpanTip(startMs, endMs, isFallbackWeek = false) {
  const s = Number(startMs);
  const e = Number(endMs);
  if (!(s > 0 && e > 0 && Number.isFinite(s) && Number.isFinite(e))) return null;
  const sd = new Date(s);
  const ed = new Date(e);
  const pad2 = (n) => String(n).padStart(2, '0');
  const sTime = `${pad2(sd.getHours())}:${pad2(sd.getMinutes())}`;
  const eTime = `${pad2(ed.getHours())}:${pad2(ed.getMinutes())}`;
  const sameDay =
    sd.getFullYear() === ed.getFullYear() &&
    sd.getMonth() === ed.getMonth() &&
    sd.getDate() === ed.getDate();
  const sDate = `${sd.getMonth() + 1}/${pad2(sd.getDate())}`;
  const eDate = `${ed.getMonth() + 1}/${pad2(ed.getDate())}`;
  const base = sameDay ? `${sDate} ${sTime} ~ ${eTime}` : `${sDate} ${sTime} ~ ${eDate} ${eTime}`;
  return isFallbackWeek ? `${base} · ${t('cons.cycleFallbackWeekTip')}` : base;
}

export const ConsumptionView = defineComponent({
  name: 'ConsumptionView',
  setup({ onCleanup }) {
    // --- 时间筛选栏：快速时间段分段控制器与自定义起止时间选择条 ---
    let draftStartMs = telemetryStore.getState().customStartMs;
    let draftEndMs = telemetryStore.getState().customEndMs;
    let hasUncommittedCustomDraft = false;
    let hasCommittedCustomRange = false;

    const timeFilterSwitch = SegmentedControl({
      ariaLabel: t('cons.rangeAria'),
      modelValue: telemetryStore.getState().selectedTimeRange,
      options: getConsumptionTimeRangeOptions(),
      onUpdateModelValue: (nextRange) => {
        if (nextRange === 'custom') {
          const st = telemetryStore.getState();
          if (!hasCommittedCustomRange && st.selectedTimeRange !== 'custom') {
            const nowMs = Date.now();
            draftStartMs = floorToStartOfMinuteMs(nowMs - 24 * 3600 * 1000);
            draftEndMs = ceilToEndOfMinuteMs(nowMs);
            hasUncommittedCustomDraft = false;
            startPicker.setValue(draftStartMs);
            endPicker.setValue(draftEndMs);
            selectConsumptionTimeRange('custom', {
              customStartMs: draftStartMs,
              customEndMs: draftEndMs,
            });
            return;
          }
          draftStartMs = st.customStartMs;
          draftEndMs = st.customEndMs;
          hasUncommittedCustomDraft = false;
          startPicker.setValue(draftStartMs);
          endPicker.setValue(draftEndMs);
        } else {
          hasUncommittedCustomDraft = false;
        }
        selectConsumptionTimeRange(nextRange);
      },
    });

    const startPicker = CustomDateTimePicker({
      modelValue: draftStartMs,
      onUpdateModelValue: (ms) => {
        draftStartMs = ms;
        hasUncommittedCustomDraft = true;
        startPicker.setValue(ms);
      },
    });

    const endPicker = CustomDateTimePicker({
      modelValue: draftEndMs,
      onUpdateModelValue: (ms) => {
        draftEndMs = ms;
        hasUncommittedCustomDraft = true;
        endPicker.setValue(ms);
      },
    });

    const applyCustomBtnLabel = h('span', { text: t('cons.applyFilter') });
    const applyCustomBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-primary',
        style: 'height: 26px; padding: 0 10px;',
        onClick: () => {
          const sMs = Number(draftStartMs || 0);
          const eMs = Number(draftEndMs || 0);
          const rawMinMs = sMs > 0 && eMs > 0 ? Math.min(sMs, eMs) : sMs;
          const rawMaxMs = sMs > 0 && eMs > 0 ? Math.max(sMs, eMs) : eMs;
          const minMs = floorToStartOfMinuteMs(rawMinMs);
          const maxMs = ceilToEndOfMinuteMs(rawMaxMs);
          draftStartMs = minMs;
          draftEndMs = maxMs;
          hasUncommittedCustomDraft = false;
          hasCommittedCustomRange = true;
          startPicker.setValue(minMs);
          endPicker.setValue(maxMs);
          selectConsumptionTimeRange('custom', {
            customStartMs: minMs,
            customEndMs: maxMs,
          });
        },
      },
      [createSvgIcon('check', { size: 12 }), applyCustomBtnLabel]
    );

    const rangeToSpan = h('span', { className: 'text-muted', text: t('cons.rangeTo') });
    const customRangeBar = h(
      'div',
      {
        className: 'cons-custom-range-bar',
        hidden: true,
      },
      [
        startPicker.el,
        rangeToSpan,
        endPicker.el,
        applyCustomBtn,
      ]
    );

    // --- Section 1: 用量概览矩阵 (上层 3 列核心总量 + 下层 3 列新输入/缓存读取/输出拆分 + 底部 4 段比例条) ---
    const dateSpanBadge = h('span', { className: 'cons-badge text-mono', text: '-- ~ --' });
    const cyclePoolSelect = CustomSelect({
      className: 'cons-cycle-pool-select',
      modelValue: telemetryStore.getState().selectedCyclePool || 'all',
      options: buildCyclePoolSelectOptions([]),
      onUpdateModelValue: (nextPool) => {
        selectConsumptionCyclePool(nextPool || 'all');
      },
    });
    patchAttr(cyclePoolSelect.el, 'hidden', true);
    patchAttr(cyclePoolSelect.refs.triggerBtn, 'aria-label', t('cons.cyclePoolAria'));
    const heroTotalTokens = h('strong', { className: 'cons-hero-num text-mono', text: '0' });
    const heroTotalCalls = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: t('cons.callsCount', { calls: 0 }) });
    const initialSecondaryCost = formatSecondaryCostApprox(0);
    const heroCostUsd = h('strong', { className: 'cons-hero-cost text-mono', text: '$0.00' });
    const heroCostCny = h('span', {
      className: 'text-muted text-mono',
      style: 'font-size: var(--fs-md);',
      text: initialSecondaryCost,
      hidden: !initialSecondaryCost,
    });

    const cacheHitPctEl = h('strong', { className: 'cons-hero-cache text-mono', text: '0%' });
    const cacheTokensEl = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: t('cons.cacheHitTokens', { tokens: 0 }) });

    const inputSharePct = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: '0%' });
    const inputMainTokens = h('strong', { className: 'cons-hero-num text-mono', text: '0' });

    const cacheSharePct = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: '0%' });
    const cacheMainTokens = h('strong', { className: 'cons-hero-num text-mono', text: '0' });

    const outputSharePct = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: '0%' });
    const outputMainTokens = h('strong', { className: 'cons-hero-num text-mono', text: '0' });

    const overviewSegBar = createFourSegmentBar();
    const consExportMenu = ActionMenu({
      ariaLabel: t('cons.exportMenuAria'),
      className: 'cons-export-menu',
      items: [
        {
          key: 'xlsx',
          icon: 'download',
          label: t('cons.exportXlsx'),
          title: t('cons.exportXlsxTip'),
          onSelect: () => {
            const cons = latestSlice?.consumption;
            if (!cons) return;
            const displaySettings = {
              modelDisplayMode: latestSlice?.modelDisplayMode,
              showUpstreamModel: latestSlice?.showUpstreamModel,
            };
            const bytes = buildConsumptionXlsx(cons, latestSlice?.modelBreakdown || [], {
              displaySettings,
            });
            const baseName = buildConsumptionExportBaseName(
              cons,
              latestSlice?.range || 'all'
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
          label: t('cons.exportMd'),
          title: t('cons.exportMdTip'),
          onSelect: () => {
            const cons = latestSlice?.consumption;
            if (!cons) return;
            const displaySettings = {
              modelDisplayMode: latestSlice?.modelDisplayMode,
              showUpstreamModel: latestSlice?.showUpstreamModel,
            };
            const md = buildConsumptionMarkdownReport(cons, latestSlice?.modelBreakdown || [], {
              displaySettings,
            });
            void copyTextWithFeedback(md, t('cons.exportMdDone'));
          },
        },
      ],
    });
    consExportMenu.refs.setHidden(true);
    const totalTokensLabel = h('span', { className: 'text-muted', style: 'font-size: var(--fs-md);', text: t('cons.totalTokens') });
    const estCostLabel = h('span', { className: 'text-muted', style: 'font-size: var(--fs-md);', text: t('cons.estCost') });
    const cacheHitRateLabel = h('span', { text: t('cons.cacheHitRate') });
    const newInputLabel = h('span', { text: t('cons.newInput') });
    const cacheReadLabel = h('span', { text: t('cons.cacheRead') });
    const outputUsageLabel = h('span', { text: t('cons.outputUsage') });

    const unifiedMatrixEl = h('div', { className: 'cons-box cons-unified-matrix' }, [
      h('div', { className: 'cons-split-3' }, [
        h('div', { className: 'cons-col' }, [
          totalTokensLabel,
          h('div', { className: 'cons-baseline' }, [heroTotalTokens, heroTotalCalls]),
        ]),
        h('div', { className: 'cons-col is-bordered-col' }, [
          estCostLabel,
          h('div', { className: 'cons-baseline' }, [heroCostUsd, heroCostCny]),
        ]),
        h('div', { className: 'cons-col is-bordered-col' }, [
          h('span', { className: 'legend-left', style: 'font-size: var(--fs-md);' }, [
            h('span', { className: 'dot-swatch seg-cached' }),
            cacheHitRateLabel,
          ]),
          h('div', { className: 'cons-baseline' }, [cacheHitPctEl, cacheTokensEl]),
        ]),
      ]),
      h('div', { className: 'cons-split-3 cons-matrix-bottom' }, [
        h('div', { className: 'cons-col' }, [
          h('span', { className: 'legend-left text-muted', style: 'font-size: var(--fs-md);' }, [
            h('span', { className: 'dot-swatch seg-input' }),
            newInputLabel,
          ]),
          h('div', { className: 'cons-baseline' }, [inputMainTokens, inputSharePct]),
        ]),
        h('div', { className: 'cons-col is-bordered-col' }, [
          h('span', { className: 'legend-left text-muted', style: 'font-size: var(--fs-md);' }, [
            h('span', { className: 'dot-swatch seg-cached' }),
            cacheReadLabel,
          ]),
          h('div', { className: 'cons-baseline' }, [cacheMainTokens, cacheSharePct]),
        ]),
        h('div', { className: 'cons-col is-bordered-col' }, [
          h('span', { className: 'legend-left text-muted', style: 'font-size: var(--fs-md);' }, [
            h('span', { className: 'dot-swatch seg-output' }),
            outputUsageLabel,
          ]),
          h('div', { className: 'cons-baseline' }, [outputMainTokens, outputSharePct]),
        ]),
      ]),
    ]);

    const overviewPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header cons-overview-head' }, [
        h('span', { className: 'panel-title cons-overview-title' }, [
          dateSpanBadge,
          cyclePoolSelect.el,
        ]),
        h('div', { className: 'cons-overview-controls' }, [
          timeFilterSwitch.el,
          consExportMenu.el,
        ]),
      ]),
      customRangeBar,
      unifiedMatrixEl,
      overviewSegBar.el,
    ]);

    function drillDownToTimeRange(startMs, endMs) {
      const minMs = floorToStartOfMinuteMs(startMs);
      const maxMs = ceilToEndOfMinuteMs(endMs);
      if (!(minMs > 0) || !(maxMs > minMs)) return;
      hideBreakdownPopover();
      draftStartMs = minMs;
      draftEndMs = maxMs;
      hasUncommittedCustomDraft = false;
      hasCommittedCustomRange = true;
      startPicker.setValue(minMs);
      endPicker.setValue(maxMs);
      selectConsumptionTimeRange('custom', {
        customStartMs: minMs,
        customEndMs: maxMs,
      });
    }

    // --- Section 2: 历史趋势 (交互式 SVG 平滑曲线图 / 7×W 四态热力格子图 + 悬停明细浮层 + 点击时段下钻) ---
    let heatmapViewMode = 'day';
    const trendTitleSpan = h('span', { text: t('cons.trendTitle') });
    const trendRangeBadge = h('span', { className: 'cons-badge', text: t('cons.allTime') });
    const trendGranularityHint = h('span', {
      className: 'cons-trend-hint text-muted text-mono',
      style: 'font-size: var(--fs-sm);',
      text: t('cons.trendPointsHintHourly', { points: 0 }),
    });
    const heatmapModeSwitch = SegmentedControl({
      ariaLabel: t('cons.hmModeAria'),
      modelValue: heatmapViewMode,
      options: getHeatmapModeOptions(),
      onUpdateModelValue: (nextMode) => {
        if (!['day', 'week', 'month', 'all'].includes(nextMode)) return;
        heatmapViewMode = nextMode;
        heatmapModeSwitch.setValue(nextMode);
        trendChart.setHeatmapMode(nextMode);
      },
    });
    heatmapModeSwitch.el.classList.add('cons-hm-mode-switch');
    patchAttr(heatmapModeSwitch.el, 'hidden', true);

    const trendChart = createTrendAreaChart({
      onSelectSlot: (slot) => {
        if (slot && Number(slot.startMs) > 0 && Number(slot.endMs) > Number(slot.startMs)) {
          drillDownToTimeRange(slot.startMs, slot.endMs);
        }
      },
    });

    const trendPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header cons-trend-head' }, [
        h('span', { className: 'panel-title' }, [
          trendTitleSpan,
          trendRangeBadge,
        ]),
        h('div', { className: 'cons-trend-head-right' }, [
          trendGranularityHint,
          heatmapModeSwitch.el,
        ]),
      ]),
      trendChart.el,
    ]);

    // --- Section 3: 统一排行卡片（分段切换「模型排行 | 项目排行 | 会话排行」，右侧联动对应排序切换） ---
    let activeRankingTab = 'models';
    let modelsSortBy = 'tokens';
    let topConvsSortBy = 'cost';
    let lastModelsCount = 0;
    let lastWorkspacesCount = 0;
    let lastConvsCount = 0;
    let hasCompletedInitialDraw = false;
    let lastAnimatedRangeSig = '';
    let lastAnimatedRankingKey = '';
    let lastAnimatedSortSig = '';
    const consAnimTimers = new Map();
    const TRANSIENT_CONS_CLASSES = ['is-bars-revealing'];

    function cleanupConsAnim(el) {
      const rec = consAnimTimers.get(el);
      if (!rec) return;
      clearTimeout(rec.tid);
      el?.removeEventListener?.('animationend', rec.onEnd);
      el?.classList?.remove(...TRANSIENT_CONS_CLASSES);
      consAnimTimers.delete(el);
    }

    function triggerConsAnim(el, cls, fallbackMs = 650) {
      if (
        !el ||
        !el.classList ||
        typeof window === 'undefined' ||
        typeof window.getComputedStyle !== 'function' ||
        window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
      ) {
        return;
      }
      cleanupConsAnim(el);
      el.classList.remove(...TRANSIENT_CONS_CLASSES);
      void el.offsetWidth;
      const onEnd = (ev) => {
        if (ev && ev.target && ev.target !== el) return;
        cleanupConsAnim(el);
      };
      const tid = setTimeout(() => cleanupConsAnim(el), fallbackMs);
      consAnimTimers.set(el, { cls, tid, onEnd });
      el.addEventListener?.('animationend', onEnd);
      el.classList.add(cls);
    }

    function clearConsAnimTimers() {
      for (const el of Array.from(consAnimTimers.keys())) {
        cleanupConsAnim(el);
      }
    }

    function getRankingTabOptions(
      modelsCount = lastModelsCount,
      convsCount = lastConvsCount,
      workspacesCount = lastWorkspacesCount
    ) {
      const opts = [
        {
          value: 'models',
          label:
            modelsCount > 0
              ? t('cons.rankTabModelsCount', { count: modelsCount })
              : t('cons.topModels'),
        },
      ];
      if (workspacesCount > 0) {
        opts.push({
          value: 'workspaces',
          label: t('cons.rankTabWorkspacesCount', { count: workspacesCount }),
        });
      }
      opts.push({
        value: 'sessions',
        label:
          convsCount > 0
            ? t('cons.rankTabSessionsCount', { count: convsCount })
            : t('cons.rankTabSessions'),
      });
      return opts;
    }

    function getModelsSortOptions() {
      return [
        { value: 'tokens', label: t('cons.modelsSortTokens') },
        { value: 'cost', label: t('cons.modelsSortCost') },
        { value: 'speed', label: t('cons.modelsSortSpeed') },
        { value: 'calls', label: t('cons.modelsSortCalls') },
      ];
    }

    function getTopConvsSortOptions() {
      return [
        { value: 'cost', label: t('cons.topConvsSortCost') },
        { value: 'tokens', label: t('cons.topConvsSortTokens') },
      ];
    }

    const rankingTabSwitch = SegmentedControl({
      ariaLabel: t('cons.rankTabAria'),
      modelValue: activeRankingTab,
      options: getRankingTabOptions(0, 0, 0),
      onUpdateModelValue: (nextTab) => {
        if (nextTab !== 'models' && nextTab !== 'sessions' && nextTab !== 'workspaces') return;
        activeRankingTab = nextTab;
        rankingTabSwitch.setValue(nextTab);
        if (latestSlice) {
          renderConsumptionData(latestSlice);
        }
      },
    });

    const modelsSortSwitch = SegmentedControl({
      ariaLabel: t('cons.modelsSortAria'),
      modelValue: modelsSortBy,
      options: getModelsSortOptions(),
      onUpdateModelValue: (nextSort) => {
        if (!['tokens', 'cost', 'speed', 'calls'].includes(nextSort)) return;
        modelsSortBy = nextSort;
        modelsSortSwitch.setValue(nextSort);
        if (latestSlice) {
          renderConsumptionData(latestSlice);
        }
      },
    });

    const topConvsSortSwitch = SegmentedControl({
      ariaLabel: t('cons.topConvsSortAria'),
      modelValue: topConvsSortBy,
      options: getTopConvsSortOptions(),
      onUpdateModelValue: (nextSort) => {
        if (nextSort !== 'cost' && nextSort !== 'tokens') return;
        topConvsSortBy = nextSort;
        topConvsSortSwitch.setValue(nextSort);
        if (latestSlice) {
          renderConsumptionData(latestSlice);
        }
      },
    });
    patchAttr(topConvsSortSwitch.el, 'hidden', true);

    const rankingSortWrap = h('div', { className: 'cons-ranking-sort-wrap' }, [
      modelsSortSwitch.el,
      topConvsSortSwitch.el,
    ]);
    const modelsListEl = h('div', { className: 'cons-item-list' });
    const topConvsListEl = h('div', { className: 'cons-item-list', hidden: true });
    const workspacesListEl = h('div', { className: 'cons-item-list', hidden: true });
    const topConvsEmptyEl = h('div', {
      className: 'cons-ranking-empty text-muted',
      hidden: true,
      text: t('cons.topConvsEmpty'),
    });
    const rankingPanel = h('section', { className: 'panel cons-ranking-panel' }, [
      h('div', { className: 'panel-header cons-ranking-head' }, [
        rankingTabSwitch.el,
        rankingSortWrap,
      ]),
      modelsListEl,
      topConvsListEl,
      workspacesListEl,
      topConvsEmptyEl,
    ]);

    // --- Section 4: 客户端来源列表 ---
    const sourcesTitleSpan = h('span', { className: 'panel-title', text: t('cons.clientSources') });
    const sourcesHoverHint = h('span', {
      className: 'text-muted text-mono',
      style: 'font-size: var(--fs-sm);',
      text: t('cons.hoverModelsHint'),
    });
    const sourcesListEl = h('div', { className: 'cons-item-list' });
    const sourcesPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        sourcesTitleSpan,
        sourcesHoverHint,
      ]),
      sourcesListEl,
    ]);

    // --- Section 5: 按月细分 (12 个月垂直按模型配色堆叠柱状图 + 悬停明细浮层) ---
    const monthlyTitleSpan = h('span', { text: t('cons.monthlyTitle') });
    const monthlyYearBadge = h('span', { className: 'cons-badge text-mono', text: '2026' });
    const monthlyHoverHint = h('span', {
      className: 'text-muted text-mono',
      style: 'font-size: var(--fs-sm);',
      text: t('cons.hoverModelsHint'),
    });

    let activeHoverTargetEl = null;
    let activeHoverPayload = null;
    let cachedBreakdownRootRect = null;
    let cachedBreakdownAnchorRect = null;

    const popoverContent = createConsumptionBreakdownContent({
      showModelDot: true,
      monoTitle: false,
    });
    const breakdownPopoverEl = h(
      'div',
      { className: 'cons-breakdown-popover is-rich-breakdown', hidden: true },
      popoverContent.children
    );

    function hideBreakdownPopover() {
      cachedBreakdownRootRect = null;
      cachedBreakdownAnchorRect = null;
      activeHoverPayload = null;
      if (activeHoverTargetEl) {
        patchClasses(activeHoverTargetEl, { 'is-hovered': false });
        activeHoverTargetEl = null;
      }
      patchAttr(breakdownPopoverEl, 'hidden', true);
      patchClasses(breakdownPopoverEl, { 'is-tracking': false });
    }

    function positionBreakdownPopover(anchorEl, pointerClientX = null, pointerClientY = null) {
      if (!cachedBreakdownRootRect) {
        cachedBreakdownRootRect = rootEl.getBoundingClientRect?.() || {
          left: 0,
          top: 0,
          width: 360,
          height: 600,
        };
      }
      const rootRect = cachedBreakdownRootRect;
      if (!cachedBreakdownAnchorRect) {
        cachedBreakdownAnchorRect = anchorEl?.getBoundingClientRect?.() || {
          left: 0,
          top: 0,
          bottom: 0,
          width: 0,
          height: 0,
        };
      }
      const anchorRect = cachedBreakdownAnchorRect;
      const tipW = Number(breakdownPopoverEl.offsetWidth || 0) || 216;
      const tipH = Number(breakdownPopoverEl.offsetHeight || 0) || 108;
      const rootW = rootRect.width > 0 ? rootRect.width : 360;
      const rootH = rootRect.height > 0 ? rootRect.height : 600;

      const hasPointerX = Number.isFinite(pointerClientX) && pointerClientX > 0 && rootRect.width > 0;
      const hasPointerY = Number.isFinite(pointerClientY) && pointerClientY > 0 && rootRect.height > 0;

      const centerX = hasPointerX
        ? pointerClientX - rootRect.left
        : anchorRect.left - rootRect.left + anchorRect.width / 2;
      const anchorY = hasPointerY
        ? pointerClientY - rootRect.top
        : anchorRect.top - rootRect.top;

      const maxLeft = Math.max(8, rootW - tipW - 8);
      let leftPx = Math.max(8, Math.min(maxLeft, centerX - tipW / 2));

      const aboveTop = anchorY - tipH - (hasPointerY ? 14 : 8);
      const belowTop = hasPointerY ? anchorY + 18 : anchorRect.bottom - rootRect.top + 8;
      let topPx;
      if (aboveTop >= 6) {
        topPx = Math.min(Math.max(6, rootH - tipH - 6), aboveTop);
      } else if (hasPointerX && centerX + 16 + tipW <= rootW - 8) {
        leftPx = centerX + 16;
        topPx = Math.max(6, Math.min(Math.max(6, rootH - tipH - 6), anchorY - tipH / 2));
      } else if (hasPointerX && centerX - 16 - tipW >= 8) {
        leftPx = centerX - 16 - tipW;
        topPx = Math.max(6, Math.min(Math.max(6, rootH - tipH - 6), anchorY - tipH / 2));
      } else {
        topPx = Math.min(Math.max(6, rootH - tipH - 6), Math.max(6, belowTop));
      }

      patchStyleVar(breakdownPopoverEl, '--pop-x', `${Math.round(leftPx)}px`);
      patchStyleVar(breakdownPopoverEl, '--pop-y', `${Math.round(topPx)}px`);
    }

    function showBreakdownPopover(
      anchorEl,
      payload,
      pointerClientX = null,
      pointerClientY = null
    ) {
      if (!payload || !(payload.totalTokens > 0 || payload.calls > 0)) {
        hideBreakdownPopover();
        return;
      }
      const wasHidden = breakdownPopoverEl.hasAttribute('hidden');
      const sameTargetAndPayload =
        !wasHidden && activeHoverTargetEl === anchorEl && activeHoverPayload === payload;
      if (activeHoverTargetEl && activeHoverTargetEl !== anchorEl) {
        patchClasses(activeHoverTargetEl, { 'is-hovered': false });
        cachedBreakdownAnchorRect = null;
      } else if (!activeHoverTargetEl) {
        cachedBreakdownRootRect = null;
        cachedBreakdownAnchorRect = null;
      }
      activeHoverTargetEl = anchorEl;
      activeHoverPayload = payload;
      patchClasses(anchorEl, { 'is-hovered': true });

      if (!sameTargetAndPayload) {
        popoverContent.update({
          title: payload.title || '—',
          calls: payload.calls || 0,
          totalTokens: payload.totalTokens || 0,
          costText: payload.costText || '$0.00',
          inputTokens: payload.inputTokens,
          cacheReadTokens: payload.cacheReadTokens,
          thinkingTokens: payload.thinkingTokens,
          responseTokens: payload.responseTokens,
          outputTokens: payload.outputTokens,
          segments: Array.isArray(payload.segments) ? payload.segments : [],
        });
      }

      patchAttr(breakdownPopoverEl, 'hidden', false);
      positionBreakdownPopover(anchorEl, pointerClientX, pointerClientY);
      if (wasHidden) {
        patchClasses(breakdownPopoverEl, { 'is-tracking': false });
        void breakdownPopoverEl.offsetWidth;
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(() => {
            if (!breakdownPopoverEl.hasAttribute('hidden')) {
              patchClasses(breakdownPopoverEl, { 'is-tracking': true });
            }
          });
        } else {
          patchClasses(breakdownPopoverEl, { 'is-tracking': true });
        }
      }
    }

    function createMonthModelSegment() {
      const segEl = h('div', { className: 'month-seg cons-model-seg' });
      return { el: segEl, refs: { segEl } };
    }

    let monthlyGridEl = null;
    const monthlyColByEl = new Map();

    function findMonthlyColForNode(node) {
      let cur = node;
      while (cur && cur !== monthlyGridEl) {
        const hit = monthlyColByEl.get(cur);
        if (hit) return hit;
        cur = cur.parentNode || null;
      }
      return null;
    }

    const monthlyCols = Array.from({ length: 12 }, (_, idx) => {
      const costText = h('span', { className: 'month-cost text-mono', text: '' });
      const stackWrap = h('div', { className: 'month-stack' });
      const zeroDot = h('span', { className: 'month-zero-dot' });
      const monthLabel = h('span', { className: 'month-label', text: t('cons.monthLabel', { m: idx + 1 }) });
      const tokText = h('span', { className: 'month-tok text-mono', text: '' });

      const colState = { hoverPayload: null, monthRange: null };
      const colEl = h(
        'div',
        {
          className: 'month-col',
          onClick: () => {
            if (colState.monthRange) {
              drillDownToTimeRange(colState.monthRange.startMs, colState.monthRange.endMs);
            }
          },
          onMouseEnter: (e) => {
            if (colState.hoverPayload) {
              showBreakdownPopover(
                colEl,
                colState.hoverPayload,
                e?.clientX ?? null,
                e?.clientY ?? null
              );
            } else {
              if (activeHoverTargetEl && monthlyColByEl.has(activeHoverTargetEl)) {
                hideBreakdownPopover();
              }
              e?.stopPropagation?.();
            }
          },
          onMouseMove: (e) => {
            if (colState.hoverPayload && activeHoverTargetEl === colEl) {
              positionBreakdownPopover(colEl, e?.clientX ?? null, e?.clientY ?? null);
            }
          },
          onMouseLeave: (e) => {
            if (activeHoverTargetEl !== colEl) return;
            const nextEl = e?.relatedTarget || null;
            if (nextEl) {
              const nextCol = findMonthlyColForNode(nextEl);
              if ((nextCol && nextCol.colState.hoverPayload) || nextEl === monthlyGridEl) {
                return;
              }
            }
            hideBreakdownPopover();
          },
        },
        [
          costText,
          h('div', { className: 'month-bar-well' }, [stackWrap, zeroDot]),
          monthLabel,
          tokText,
        ]
      );
      const colRec = {
        el: colEl,
        costText,
        stackWrap,
        zeroDot,
        monthLabel,
        tokText,
        colState,
      };
      monthlyColByEl.set(colEl, colRec);
      return colRec;
    });

    monthlyGridEl = h(
      'div',
      {
        className: 'monthly-grid',
        onMouseLeave: () => {
          if (activeHoverTargetEl && monthlyColByEl.has(activeHoverTargetEl)) {
            hideBreakdownPopover();
          }
        },
      },
      monthlyCols.map((c) => c.el)
    );

    const monthlyPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          monthlyTitleSpan,
          monthlyYearBadge,
        ]),
        monthlyHoverHint,
      ]),
      monthlyGridEl,
    ]);

    const safetyMonitorCard = SafetyMonitorCard();

    const scrollInner = h(
      'div',
      {
        style: 'display: flex; flex-direction: column; gap: var(--space-3); padding-bottom: var(--space-3);',
      },
      [
        overviewPanel,
        trendPanel,
        rankingPanel,
        sourcesPanel,
        monthlyPanel,
        safetyMonitorCard.el,
      ]
    );

    const viewScrollbar = CustomScrollbar({
      contentEl: scrollInner,
      className: 'view-pane',
    });
    viewScrollbar.el.addEventListener?.('scroll', hideBreakdownPopover, { passive: true });

    const rootEl = h('div', { className: 'cons-view-stage' }, [
      viewScrollbar.el,
      breakdownPopoverEl,
    ]);

    const {
      createSourceBreakdownRow,
      updateSourceBreakdownRow,
      createTopConversationRow,
      updateTopConversationRow,
    } = createConsumptionBreakdownRowBuilders({
      showPopover: showBreakdownPopover,
      movePopover: positionBreakdownPopover,
      hidePopover: hideBreakdownPopover,
      isHoveredTarget: (targetEl) => activeHoverTargetEl === targetEl,
      onSelectConversation: (cascadeId) => {
        selectConversation(cascadeId);
        uiStore.setState({
          activeView: 'steps',
          stepsSubTab: 'steps',
          selectedAgentScope: 'all',
          ctxInspectorAgentId: getDefaultCtxInspectorAgentId(
            telemetryStore.getState().telemetry?.settings
          ),
        });
      },
    });

    let latestSlice = null;
    let isDirty = false;
    let prefetchedOnCurrentVisit = false;

    let lastRenderedTuple = null;
    let cachedMonthlySeriesRef = null;
    let cachedMonthlyDisplayKey = '';
    let cachedMonthsMergedModels = null;
    let cachedAllMonthMergedModels = null;

    function isSameRenderTuple(prev, next) {
      if (!prev || prev.length !== next.length) return false;
      for (let i = 0; i < prev.length; i++) {
        if (!Object.is(prev[i], next[i])) return false;
      }
      return true;
    }

    /**
     * 将遥测状态切片同步渲染至消费统计视图的 5 个子面板。
     */
    function renderConsumptionData(slice) {
      if (!slice) return;
      safetyMonitorCard.refs.update({
        enabled: slice.enableSafetyMonitor === true,
        safetyMonitor: slice.safetyMonitor || null,
      });
      const cons = slice.consumption || {};
      const rangeInfo = cons.selectedRange || {};

      // 始终在 0ms 同步顶部时间段滑块、周期池选择器及自定义日期条显隐，给予即刻交互反馈
      timeFilterSwitch.setValue(slice.range);
      patchAttr(customRangeBar, 'hidden', slice.range !== 'custom');
      if (!hasUncommittedCustomDraft) {
        draftStartMs = slice.customStartMs;
        draftEndMs = slice.customEndMs;
        startPicker.setValue(draftStartMs);
        endPicker.setValue(draftEndMs);
      }

      const isCustomWeeklyMode =
        slice.weeklyLimitMode === 'custom_tokens' || slice.weeklyLimitMode === 'custom_cost';
      const cyclePoolOptions =
        slice.range === 'cycle'
          ? buildCyclePoolSelectOptions(slice.quotaPools, isCustomWeeklyMode)
          : [];
      const activePoolFilter = slice.range === 'cycle' ? slice.cyclePool || 'all' : 'all';
      const showCyclePoolSelect = slice.range === 'cycle' && cyclePoolOptions.length > 2;
      if (!showCyclePoolSelect) {
        cyclePoolSelect.close?.();
        patchAttr(cyclePoolSelect.el, 'hidden', true);
      } else {
        cyclePoolSelect.setProps({
          modelValue: activePoolFilter,
          options: cyclePoolOptions,
        });
        patchAttr(cyclePoolSelect.el, 'hidden', false);
      }

      // 极少数缓存未命中时（如自定义新区间或进页瞬间抢点），跳过用旧趋势/模型跑无效半更新重绘，待几毫秒后单帧原子绘制
      const payloadPool = rangeInfo.key === 'cycle' ? rangeInfo.pool || 'all' : 'all';
      if (
        (rangeInfo.key && slice.range && rangeInfo.key !== slice.range) ||
        (slice.range === 'cycle' && rangeInfo.pool && payloadPool !== activePoolFilter)
      ) {
        return;
      }

      const preset =
        slice.range !== 'custom' &&
        !(slice.range === 'cycle' && activePoolFilter !== 'all') &&
        cons.presets?.[slice.range]
          ? cons.presets[slice.range]
          : null;
      const acct = cons.account || preset?.account || {};
      const dateSpan = formatDateSpanBadge(rangeInfo.startMs, rangeInfo.endMs);
      const cycleOptionsSig = showCyclePoolSelect
        ? cyclePoolOptions.map((o) => `${o.value}:${o.label}:${o.meta || ''}`).join('|')
        : '';
      const now = new Date();
      const currentMonthIdx = now.getMonth();
      const monthlyYear = cons.monthlyYear || now.getFullYear();
      const locale = i18nStore.getState().locale;
      const displayCurrency = normalizeDisplayCurrency(slice.displayCurrency);
      const fxStatus = slice.fxStatus || null;
      const fxStatusSig = fxStatus
        ? `${fxStatus.source || 'builtin'}|${fxStatus.date || ''}|${Number(fxStatus.fetchedAtMs || 0)}`
        : 'builtin||0';
      const renderTuple = [
        locale,
        displayCurrency,
        fxStatusSig,
        slice.range,
        activePoolFilter,
        cycleOptionsSig,
        Boolean(rangeInfo.isFallbackWeek),
        slice.customStartMs,
        slice.customEndMs,
        slice.modelDisplayMode,
        slice.showUpstreamModel,
        dateSpan,
        preset?.label || rangeInfo.label,
        acct,
        cons.trendSeries,
        slice.modelBreakdown,
        activeRankingTab,
        modelsSortBy,
        cons.topConversations,
        topConvsSortBy,
        cons.sourcesBreakdown,
        monthlyYear,
        currentMonthIdx,
        cons.monthlySeries,
      ];
      if (isSameRenderTuple(lastRenderedTuple, renderTuple)) return;
      drawConsumptionData(slice, {
        cons,
        preset,
        acct,
        rangeInfo,
        activePoolFilter,
        dateSpan,
        currentMonthIdx,
        monthlyYear,
      });
      lastRenderedTuple = renderTuple;
    }

    function drawConsumptionData(
      slice,
      { cons, preset, acct, rangeInfo, activePoolFilter, dateSpan, currentMonthIdx, monthlyYear }
    ) {
      // 1. 同步用量概览矩阵及顶部 4 段比例条
      patchText(dateSpanBadge, dateSpan);
      patchAttr(
        dateSpanBadge,
        'title',
        slice.range === 'cycle'
          ? formatCycleMinuteSpanTip(
              rangeInfo.startMs,
              rangeInfo.endMs,
              Boolean(rangeInfo.isFallbackWeek)
            )
          : null
      );
      const totalTokens = Number(acct.totalTokens || 0);
      const inputTokens = Number(acct.inputTokens || 0);
      const cacheTokens = Number(acct.cacheReadTokens || 0);
      const outputTokens = Number(acct.outputTokens || 0);
      const responseTokens = Number(acct.responseTokens || 0);
      const thinkingTokens = Number(acct.thinkingTokens || 0);
      const costUsd = Number(acct.costUsd || 0);

      patchText(heroTotalTokens, formatTokensPrecise(totalTokens));
      patchText(heroTotalCalls, t('cons.callsCount', { calls: acct.calls || 0 }));
      patchText(heroCostUsd, formatUsd(costUsd));
      const heroSecondaryCost = formatSecondaryCostApprox(costUsd, {
        displayCurrency: slice.displayCurrency,
        locale: i18nStore.getState().locale,
        fxStatus: slice.fxStatus,
      });
      patchText(heroCostCny, heroSecondaryCost);
      patchAttr(heroCostCny, 'hidden', !heroSecondaryCost);
      patchAttr(
        heroCostCny,
        'title',
        heroSecondaryCost
          ? formatFxRateCaption({
              displayCurrency: slice.displayCurrency,
              locale: i18nStore.getState().locale,
              fxStatus: slice.fxStatus,
            })
          : null
      );

      patchText(cacheHitPctEl, formatPctNumber(acct.cacheHitPct ?? 0, { withSymbol: true }));
      patchText(cacheTokensEl, t('cons.cacheHitTokens', { tokens: formatTokensPrecise(cacheTokens) }));

      let inPct = 0;
      let cachePct = 0;
      let outPct = 0;
      if (totalTokens > 0) {
        const scaled = scaleBucketsExact(
          { in: inputTokens, cache: cacheTokens, out: outputTokens },
          ['in', 'cache', 'out'],
          1000
        );
        inPct = +(scaled.in / 10).toFixed(1);
        cachePct = +(scaled.cache / 10).toFixed(1);
        outPct = +(scaled.out / 10).toFixed(1);
      }

      patchText(inputSharePct, `${inPct}%`);
      patchText(inputMainTokens, formatTokensPrecise(inputTokens));

      patchText(cacheSharePct, `${cachePct}%`);
      patchText(cacheMainTokens, formatTokensPrecise(cacheTokens));

      patchText(outputSharePct, `${outPct}%`);
      patchText(outputMainTokens, formatTokensPrecise(outputTokens));
      consExportMenu.refs.setHidden(!(totalTokens > 0 || Number(acct.calls || 0) > 0));

      overviewSegBar.update({
        inputTokens,
        cacheReadTokens: cacheTokens,
        responseTokens,
        thinkingTokens,
      });

      // 2-5. 统一解析展示模式与全局确定性模型配色映射（确保趋势浮层、模型排行圆点、客户端来源条、月度堆叠柱四处完全同色）
      const localeSig = i18nStore.getState().locale;
      const displaySettings = {
        modelDisplayMode: normalizeModelDisplayMode(
          slice.modelDisplayMode,
          slice.showUpstreamModel
        ),
        showUpstreamModel: Boolean(slice.showUpstreamModel),
      };
      const mergeAndSortBucketModels = (rawList) =>
        mergeModelsByDisplayName(rawList || [], displaySettings, {
          preferLabelInShort: true,
        })
          .filter((m) => Number(m.totalTokens || 0) > 0 || Number(m.calls || 0) > 0)
          .sort(
            (a, b) =>
              (b.totalTokens || 0) - (a.totalTokens || 0) || (b.calls || 0) - (a.calls || 0)
          );

      const models = mergeModelsByDisplayName(slice.modelBreakdown || [], displaySettings, {
        preferLabelInShort: true,
      }).sort((a, b) => {
        if (modelsSortBy === 'cost') {
          return (b.costUsd || 0) - (a.costUsd || 0) || (b.totalTokens || 0) - (a.totalTokens || 0);
        }
        if (modelsSortBy === 'speed') {
          const sa = Number(a.avgTokPerSec) > 0 ? Number(a.avgTokPerSec) : -1;
          const sb = Number(b.avgTokPerSec) > 0 ? Number(b.avgTokPerSec) : -1;
          return sb - sa || (b.totalTokens || 0) - (a.totalTokens || 0);
        }
        if (modelsSortBy === 'calls') {
          return (b.calls || 0) - (a.calls || 0) || (b.totalTokens || 0) - (a.totalTokens || 0);
        }
        return (b.totalTokens || 0) - (a.totalTokens || 0) || (b.calls || 0) - (a.calls || 0);
      });
      const modelsTotalTok = models.reduce((s, m) => s + Number(m.totalTokens || 0), 0);
      const modelsTotalCost = models.reduce((s, m) => s + Math.max(0, Number(m.costUsd || 0)), 0);
      const modelsTotalCalls = models.reduce((s, m) => s + Math.max(0, Number(m.calls || 0)), 0);
      const modelsMaxAvgTps = models.reduce((mx, m) => {
        const v = Number(m.avgTokPerSec || 0);
        return Number.isFinite(v) && v > mx ? v : mx;
      }, 0);
      const modelsTotalsCtx = {
        totalTokens: modelsTotalTok,
        totalCost: modelsTotalCost,
        totalCalls: modelsTotalCalls,
        maxAvgTps: modelsMaxAvgTps,
        displayCurrency: normalizeDisplayCurrency(slice.displayCurrency),
        locale: localeSig,
        fxStatus: slice.fxStatus || null,
      };
      const modelsCurrencySig = `${modelsTotalsCtx.displayCurrency}|${slice.fxStatus?.source || 'builtin'}|${Number(slice.fxStatus?.fetchedAtMs || 0)}`;

      const rawTopConvs = Array.isArray(cons.topConversations) ? cons.topConversations : [];
      const allTopConvMergedModels = [];
      const topConvsWithModels = rawTopConvs.map((c) => {
        const mergedModels = mergeAndSortBucketModels(c.models);
        for (const m of mergedModels) {
          allTopConvMergedModels.push(m);
        }
        return { ...c, mergedModels };
      });

      const rawTopWorkspaces = Array.isArray(cons.topWorkspaces) ? cons.topWorkspaces : [];
      const allWorkspaceMergedModels = [];
      const topWorkspacesWithModels = rawTopWorkspaces.map((w) => {
        const mergedModels = mergeAndSortBucketModels(w.models);
        for (const m of mergedModels) {
          allWorkspaceMergedModels.push(m);
        }
        return { ...w, isWorkspaceRow: true, mergedModels };
      });

      const rawSources = cons.sourcesBreakdown || [];
      const sourcesTotalTok = rawSources.reduce((s, x) => s + Number(x.totalTokens || 0), 0);
      const allSourceMergedModels = [];
      const sourcesWithModels = rawSources.map((s) => {
        const mergedModels = mergeAndSortBucketModels(s.models);
        for (const m of mergedModels) {
          allSourceMergedModels.push(m);
        }
        return { ...s, mergedModels };
      });

      const monthlySeries = cons.monthlySeries || [];
      const monthlyDisplayKey = `${displaySettings.modelDisplayMode}|${displaySettings.showUpstreamModel ? 1 : 0}`;
      let monthsMergedModels;
      let allMonthMergedModels;
      if (
        cachedMonthlySeriesRef === monthlySeries &&
        cachedMonthlyDisplayKey === monthlyDisplayKey &&
        cachedMonthsMergedModels &&
        cachedAllMonthMergedModels
      ) {
        monthsMergedModels = cachedMonthsMergedModels;
        allMonthMergedModels = cachedAllMonthMergedModels;
      } else {
        allMonthMergedModels = [];
        monthsMergedModels = Array.from({ length: 12 }, (_, idx) => {
          const merged = mergeAndSortBucketModels(monthlySeries[idx]?.models);
          for (const m of merged) {
            allMonthMergedModels.push(m);
          }
          return merged;
        });
        cachedMonthlySeriesRef = monthlySeries;
        cachedMonthlyDisplayKey = monthlyDisplayKey;
        cachedMonthsMergedModels = monthsMergedModels;
        cachedAllMonthMergedModels = allMonthMergedModels;
      }

      const rawTrendSeries = cons.trendSeries || [];
      const allTrendMergedModels = [];
      const trendMergedByIdx = rawTrendSeries.map((slot) => {
        if (!Array.isArray(slot?.models) || slot.models.length === 0) return null;
        const merged = mergeAndSortBucketModels(slot.models);
        for (const m of merged) {
          allTrendMergedModels.push(m);
        }
        return merged;
      });

      const modelColorMap = buildDeterministicModelColorMap([
        ...models,
        ...allSourceMergedModels,
        ...allTopConvMergedModels,
        ...allWorkspaceMergedModels,
        ...allMonthMergedModels,
        ...allTrendMergedModels,
      ]);

      // 2. 同步历史趋势交互式 SVG 面积图 / 类 GitHub 每日热力图（>90天）及悬停分模型浮层
      const rangeBadgeText =
        slice.range === 'cycle'
          ? `${rangeInfo.isFallbackWeek || slice.weeklyLimitMode === 'custom_tokens' || slice.weeklyLimitMode === 'custom_cost' ? t('cons.cycleFallbackWeek') : t('cons.currentCycle')}${
              activePoolFilter && activePoolFilter !== 'all'
                ? ` · ${formatQuotaPoolLabel(rangeInfo.poolLabel || activePoolFilter)}`
                : ''
            }`
          : getEffectiveLocale() !== 'zh-CN'
            ? getConsumptionTimeRangeOptions().find((o) => o.value === slice.range)?.label ||
              t('cons.allTime')
            : preset?.label || rangeInfo.label || t('cons.allTime');
      patchText(trendRangeBadge, rangeBadgeText);
      const firstTrendSlot = rawTrendSeries[0] || null;
      const isMinuteTrend = firstTrendSlot?.granularity === 'minute';
      const isHourlyTrend =
        !isMinuteTrend &&
        (firstTrendSlot?.granularity === 'hour' ||
          (firstTrendSlot?.label || '').includes(':'));
      const isHeatmapTrend =
        !isMinuteTrend && !isHourlyTrend && rawTrendSeries.length > HEATMAP_DAYS_THRESHOLD;
      patchAttr(trendGranularityHint, 'hidden', isHeatmapTrend);
      patchAttr(heatmapModeSwitch.el, 'hidden', !isHeatmapTrend);
      if (!isHeatmapTrend) {
        patchText(
          trendGranularityHint,
          isMinuteTrend
            ? t('cons.trendPointsHintMinute', {
                minutes: Math.max(1, Number(firstTrendSlot?.stepMinutes) || 5),
                points: rawTrendSeries.length || 0,
              })
            : isHourlyTrend
              ? t('cons.trendPointsHintHourly', { points: rawTrendSeries.length || 0 })
              : t('cons.trendPointsHintDaily', { points: rawTrendSeries.length || 0 })
        );
      } else {
        heatmapModeSwitch.setValue(heatmapViewMode);
      }
      const buildTrendModelSegments = (mergedSlotModels) =>
        partitionModelSegments(mergedSlotModels, modelColorMap, {
          maxMain: 5,
          minSharePct: 1.5,
        });
      const enrichedTrendSeries = rawTrendSeries.map((slot, idx) => {
        const mergedSlotModels = trendMergedByIdx[idx];
        if (!mergedSlotModels || mergedSlotModels.length === 0) return slot;
        return {
          ...slot,
          mergedModels: mergedSlotModels,
          modelSegments: buildTrendModelSegments(mergedSlotModels),
        };
      });
      trendChart.update(enrichedTrendSeries, {
        heatmapMode: heatmapViewMode,
        buildModelSegments: buildTrendModelSegments,
      });

      // 3. 同步统一排行卡片（分段切换「模型排行 | 项目排行 | 会话排行」及对应排序控制）
      const sortedTopConvs = [...topConvsWithModels].sort((a, b) =>
        topConvsSortBy === 'tokens'
          ? (b.totalTokens || 0) - (a.totalTokens || 0) || (b.costUsd || 0) - (a.costUsd || 0)
          : (b.costUsd || 0) - (a.costUsd || 0) || (b.totalTokens || 0) - (a.totalTokens || 0)
      );
      const sortedTopWorkspaces = [...topWorkspacesWithModels].sort((a, b) =>
        topConvsSortBy === 'tokens'
          ? (b.totalTokens || 0) - (a.totalTokens || 0) || (b.costUsd || 0) - (a.costUsd || 0)
          : (b.costUsd || 0) - (a.costUsd || 0) || (b.totalTokens || 0) - (a.totalTokens || 0)
      );
      if (activeRankingTab === 'workspaces' && sortedTopWorkspaces.length === 0) {
        activeRankingTab = 'models';
      }
      lastModelsCount = models.length;
      lastWorkspacesCount = sortedTopWorkspaces.length;
      lastConvsCount = sortedTopConvs.length;
      rankingTabSwitch.setProps({
        ariaLabel: t('cons.rankTabAria'),
        modelValue: activeRankingTab,
        options: getRankingTabOptions(
          models.length,
          sortedTopConvs.length,
          sortedTopWorkspaces.length
        ),
      });
      const showSessionsTab = activeRankingTab === 'sessions';
      const showWorkspacesTab = activeRankingTab === 'workspaces' && sortedTopWorkspaces.length > 0;
      const showModelsTab = !showSessionsTab && !showWorkspacesTab;
      patchAttr(modelsSortSwitch.el, 'hidden', !showModelsTab);
      patchAttr(
        topConvsSortSwitch.el,
        'hidden',
        showModelsTab ||
          (showSessionsTab && sortedTopConvs.length === 0) ||
          (showWorkspacesTab && sortedTopWorkspaces.length === 0)
      );
      patchAttr(modelsListEl, 'hidden', !showModelsTab);
      patchAttr(topConvsListEl, 'hidden', !showSessionsTab || sortedTopConvs.length === 0);
      patchAttr(workspacesListEl, 'hidden', !showWorkspacesTab);
      patchAttr(topConvsEmptyEl, 'hidden', !showSessionsTab || sortedTopConvs.length > 0);
      patchText(topConvsEmptyEl, t('cons.topConvsEmpty'));

      const nextRangeSig = `${slice.range || ''}:${activePoolFilter || 'all'}:${slice.customStartMs || 0}:${slice.customEndMs || 0}`;
      const nextRankingKey = showWorkspacesTab
        ? 'workspaces'
        : showSessionsTab
          ? 'sessions'
          : 'models';
      const nextSortSig = showModelsTab ? `m:${modelsSortBy}` : `c:${topConvsSortBy}`;
      const activeRankingEl = showWorkspacesTab
        ? workspacesListEl
        : showSessionsTab
          ? sortedTopConvs.length > 0
            ? topConvsListEl
            : topConvsEmptyEl
          : modelsListEl;

      const rangeSwitched = hasCompletedInitialDraw && nextRangeSig !== lastAnimatedRangeSig;
      const tabSwitched =
        hasCompletedInitialDraw && !rangeSwitched && nextRankingKey !== lastAnimatedRankingKey;
      const sortSwitched =
        hasCompletedInitialDraw &&
        !rangeSwitched &&
        !tabSwitched &&
        nextSortSig !== lastAnimatedSortSig;

      patchKeyedList(modelsListEl, models, {
        keyFn: (m) => m.displayText || m.label || m.shortName,
        sigFn: (m) =>
          `${localeSig}:${modelsCurrencySig}:${modelsSortBy}:${m.displayText}:${m.displayTitle}:${m.totalTokens}:${m.inputTokens}:${m.cacheReadTokens}:${m.responseTokens}:${m.thinkingTokens}:${m.costUsd}:${m.unpricedCalls}:${m.calls}:${m.avgTokPerSec ?? ''}:${m.avgTtftSec ?? ''}:${m.cacheHitPct ?? ''}:${modelsTotalTok}:${modelsTotalCost.toFixed(4)}:${modelsTotalCalls}:${modelsMaxAvgTps}`,
        createRow: createBreakdownItemRow,
        updateRow: (refs, m) => {
          updateBreakdownItemRow(
            refs,
            { ...m, label: m.displayText, title: m.displayTitle },
            modelsTotalsCtx,
            modelsSortBy
          );
        },
      });

      const topConvsBaseTokens =
        totalTokens > 0
          ? totalTokens
          : sortedTopConvs.reduce((s, c) => s + Number(c.totalTokens || 0), 0);
      const topConvsBaseCost =
        costUsd > 0
          ? costUsd
          : sortedTopConvs.reduce((s, c) => s + Math.max(0, Number(c.costUsd || 0)), 0);
      const topConvsBases = { tokens: topConvsBaseTokens, cost: topConvsBaseCost };
      patchKeyedList(topConvsListEl, sortedTopConvs, {
        keyFn: (c) => c.cascadeId,
        sigFn: (c) => {
          const modelsSig = c.mergedModels
            .map((m) => {
              const seed = getCanonicalModelColorSeed(m);
              return `${m.displayText}:${m.totalTokens}:${m.inputTokens || 0}:${m.cacheReadTokens || 0}:${m.thinkingTokens || 0}:${m.responseTokens || 0}:${m.calls}:${modelColorMap.get(seed) || ''}`;
            })
            .join('|');
          return `${localeSig}:${topConvsSortBy}:${c.cascadeId}:${c.title}:${c.totalTokens}:${c.inputTokens || 0}:${c.cacheReadTokens || 0}:${c.thinkingTokens || 0}:${c.responseTokens || 0}:${c.costUsd}:${c.unpricedCalls}:${c.calls}:${c.cacheHitPct}:${c.sourceName}:${c.canJump ? 1 : 0}:${topConvsBaseTokens}:${topConvsBaseCost.toFixed(4)}:${modelsSig}`;
        },
        createRow: createTopConversationRow,
        updateRow: (refs, c) =>
          updateTopConversationRow(refs, c, topConvsBases, modelColorMap, topConvsSortBy),
      });

      const topWsBaseTokens =
        totalTokens > 0
          ? totalTokens
          : sortedTopWorkspaces.reduce((s, w) => s + Number(w.totalTokens || 0), 0);
      const topWsBaseCost =
        costUsd > 0
          ? costUsd
          : sortedTopWorkspaces.reduce((s, w) => s + Math.max(0, Number(w.costUsd || 0)), 0);
      const topWsBases = { tokens: topWsBaseTokens, cost: topWsBaseCost };
      patchKeyedList(workspacesListEl, sortedTopWorkspaces, {
        keyFn: (w) => w.workspaceKey,
        sigFn: (w) => {
          const modelsSig = w.mergedModels
            .map((m) => {
              const seed = getCanonicalModelColorSeed(m);
              return `${m.displayText}:${m.totalTokens}:${m.inputTokens || 0}:${m.cacheReadTokens || 0}:${m.thinkingTokens || 0}:${m.responseTokens || 0}:${m.calls}:${modelColorMap.get(seed) || ''}`;
            })
            .join('|');
          return `${localeSig}:${topConvsSortBy}:${w.workspaceKey}:${w.label}:${w.sessionCount}:${w.totalTokens}:${w.inputTokens || 0}:${w.cacheReadTokens || 0}:${w.thinkingTokens || 0}:${w.responseTokens || 0}:${w.costUsd}:${w.unpricedCalls}:${w.calls}:${w.cacheHitPct}:${w.latestCascadeId}:${w.canJump ? 1 : 0}:${topWsBaseTokens}:${topWsBaseCost.toFixed(4)}:${modelsSig}`;
        },
        createRow: createTopConversationRow,
        updateRow: (refs, w) =>
          updateTopConversationRow(refs, w, topWsBases, modelColorMap, topConvsSortBy),
      });

      // 4. 同步客户端来源列表（长尾合并分段配色 + 右侧总调用数 + 悬停进度条弹出明细浮层）
      patchKeyedList(sourcesListEl, sourcesWithModels, {
        keyFn: (s) => s.name,
        sigFn: (s) => {
          const modelsSig = s.mergedModels
            .map((m) => {
              const seed = getCanonicalModelColorSeed(m);
              return `${m.displayText}:${m.totalTokens}:${m.inputTokens || 0}:${m.cacheReadTokens || 0}:${m.thinkingTokens || 0}:${m.responseTokens || 0}:${m.calls}:${modelColorMap.get(seed) || ''}`;
            })
            .join('|');
          return `${localeSig}:${s.name}:${s.totalTokens}:${s.inputTokens || 0}:${s.cacheReadTokens || 0}:${s.thinkingTokens || 0}:${s.responseTokens || 0}:${s.costUsd}:${s.unpricedCalls}:${s.calls}:${sourcesTotalTok}:${modelsSig}`;
        },
        createRow: createSourceBreakdownRow,
        updateRow: (refs, s) => updateSourceBreakdownRow(refs, s, sourcesTotalTok, modelColorMap),
      });

      if (tabSwitched || sortSwitched) {
        triggerConsAnim(activeRankingEl, 'is-bars-revealing');
      }
      if (!hasCompletedInitialDraw) {
        hasCompletedInitialDraw = true;
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(() => {
            rootEl.classList?.add('is-ready');
          });
        } else {
          rootEl.classList?.add('is-ready');
        }
      }
      lastAnimatedRangeSig = nextRangeSig;
      lastAnimatedRankingKey = nextRankingKey;
      lastAnimatedSortSig = nextSortSig;

      // 5. 同步 12 个月垂直堆叠柱状图（按模型配色堆叠 + 长尾合并 + 悬停弹出明细浮层）
      patchText(monthlyYearBadge, String(monthlyYear));
      const maxMonthTokens = Math.max(
        1,
        ...monthlySeries.map((m) => Number(m.totalTokens || 0))
      );

      for (let i = 0; i < 12; i++) {
        const col = monthlyCols[i];
        const m = monthlySeries[i] || { totalTokens: 0, costUsd: 0, calls: 0 };
        const mTot = Number(m.totalTokens || 0);
        const mCalls = Number(m.calls || 0);
        const hasData = mTot > 0;

        patchClasses(col.el, { 'is-interactive': hasData || mCalls > 0 });
        patchClasses(col.monthLabel, { 'is-current': i === currentMonthIdx });
        patchAttr(col.stackWrap, 'hidden', !hasData);
        patchAttr(col.zeroDot, 'hidden', hasData);

        if (!hasData) {
          patchText(col.costText, '');
          patchText(col.tokText, '');
          col.colState.hoverPayload = null;
          col.colState.monthRange = null;
          patchKeyedList(col.stackWrap, [], {
            keyFn: (x) => x.key,
            sigFn: (x) => x.key,
            createRow: createMonthModelSegment,
            updateRow: () => {},
          });
        } else {
          const cVal = Number(m.costUsd || 0);
          const isMonthUnpriced =
            mCalls > 0 && Number(m.unpricedCalls || 0) >= mCalls && !(cVal > 0);
          patchText(
            col.costText,
            isMonthUnpriced ? '—' : cVal >= 10 ? `$${Math.round(cVal)}` : `$${cVal.toFixed(2)}`
          );
          patchText(col.tokText, formatTokensPrecise(mTot));

          const totalHeightPct = Math.max(8, Math.min(100, (mTot / maxMonthTokens) * 100));
          patchStyleVar(col.stackWrap, '--bar-h', `${totalHeightPct.toFixed(1)}%`);

          const monthModels = monthsMergedModels[i] || [];
          const barPartitioned = partitionModelSegments(monthModels, modelColorMap, {
            maxMain: 5,
            minSharePct: 1.5,
          });
          // 垂直柱状图底端放主力模型、顶端叠放小占比及「其他」，视觉重心稳定
          const verticalSegments =
            barPartitioned.length > 0
              ? [...barPartitioned].reverse()
              : [{ key: '__month_fallback__', pct: 100, color: 'var(--accent-primary)' }];

          patchKeyedList(col.stackWrap, verticalSegments, {
            keyFn: (seg) => seg.key,
            sigFn: (seg) => `${seg.key}:${seg.pct.toFixed(2)}:${seg.color}`,
            createRow: createMonthModelSegment,
            updateRow: (segRefs, seg) => {
              patchStyleVar(segRefs.segEl, '--seg-h', `${seg.pct.toFixed(2)}%`);
              patchStyleVar(segRefs.segEl, '--seg-color', seg.color);
            },
          });

          col.colState.monthRange = {
            startMs: new Date(monthlyYear, i, 1, 0, 0, 0, 0).getTime(),
            endMs: new Date(monthlyYear, i + 1, 0, 23, 59, 59, 999).getTime(),
          };
          col.colState.hoverPayload = {
            title: t('cons.monthFullLabel', { year: monthlyYear, m: i + 1 }),
            calls: mCalls,
            totalTokens: mTot,
            costText: formatUsd(isMonthUnpriced ? null : cVal, {
              precise: cVal > 0 && cVal < 0.1,
            }),
            inputTokens: m.inputTokens,
            cacheReadTokens: m.cacheReadTokens,
            thinkingTokens: m.thinkingTokens,
            responseTokens: m.responseTokens,
            outputTokens: m.outputTokens,
            segments: barPartitioned,
          };
        }
      }

      if (activeHoverTargetEl && activeHoverTargetEl.isConnected === false) {
        hideBreakdownPopover();
      }

      viewScrollbar.refresh();
    }

    const unsub = telemetryStore.subscribe(
      (st) => ({
        range: st.selectedTimeRange,
        cyclePool: st.selectedCyclePool || 'all',
        customStartMs: st.customStartMs,
        customEndMs: st.customEndMs,
        quotaPools: st.telemetry?.quotas?.pools,
        weeklyLimitMode: st.telemetry?.settings?.weeklyLimitMode,
        consumption: st.telemetry?.consumption,
        modelBreakdown: st.telemetry?.modelBreakdown,
        modelDisplayMode: normalizeModelDisplayMode(
          st.telemetry?.settings?.modelDisplayMode,
          st.telemetry?.settings?.showUpstreamModel
        ),
        showUpstreamModel: Boolean(st.telemetry?.settings?.showUpstreamModel),
        displayCurrency: normalizeDisplayCurrency(st.telemetry?.settings?.displayCurrency),
        fxStatus: st.telemetry?.fxStatus || null,
        enableSafetyMonitor: st.telemetry?.settings?.enableSafetyMonitor === true,
        safetyMonitor: st.telemetry?.safetyMonitor || null,
      }),
      (slice) => {
        latestSlice = slice;
        if (getVisibleMonitorView() !== 'consumption') {
          hideBreakdownPopover();
          isDirty = true;
          return;
        }
        isDirty = false;
        renderConsumptionData(slice);
        if (!prefetchedOnCurrentVisit && Number(slice?.consumption?.revision || 0) > 0) {
          prefetchedOnCurrentVisit = true;
          void prefetchConsumptionPresets();
        }
      }
    );

    const unsubView = uiStore.subscribe(
      getVisibleMonitorView,
      (activeView) => {
        if (activeView !== 'consumption') {
          prefetchedOnCurrentVisit = false;
          hideBreakdownPopover();
          return;
        }
        if (isDirty) {
          isDirty = false;
          if (latestSlice) {
            renderConsumptionData(latestSlice);
          }
        }
        if (!prefetchedOnCurrentVisit && Number(latestSlice?.consumption?.revision || 0) > 0) {
          prefetchedOnCurrentVisit = true;
          void prefetchConsumptionPresets();
        }
      }
    );

    function syncStaticLocaleLabels() {
      timeFilterSwitch.setProps({
        ariaLabel: t('cons.rangeAria'),
        options: getConsumptionTimeRangeOptions(),
      });
      patchAttr(cyclePoolSelect.refs.triggerBtn, 'aria-label', t('cons.cyclePoolAria'));
      patchText(applyCustomBtnLabel, t('cons.applyFilter'));
      patchText(rangeToSpan, t('cons.rangeTo'));
      patchText(totalTokensLabel, t('cons.totalTokens'));
      patchText(estCostLabel, t('cons.estCost'));
      patchText(cacheHitRateLabel, t('cons.cacheHitRate'));
      patchText(newInputLabel, t('cons.newInput'));
      patchText(cacheReadLabel, t('cons.cacheRead'));
      patchText(outputUsageLabel, t('cons.outputUsage'));
      consExportMenu.refs.setAriaLabel(t('cons.exportMenuAria'));
      consExportMenu.refs.updateItemLabels({
        xlsx: { label: t('cons.exportXlsx'), title: t('cons.exportXlsxTip') },
        md: { label: t('cons.exportMd'), title: t('cons.exportMdTip') },
      });
      patchText(trendTitleSpan, t('cons.trendTitle'));
      heatmapModeSwitch.setProps({
        ariaLabel: t('cons.hmModeAria'),
        modelValue: heatmapViewMode,
        options: getHeatmapModeOptions(),
      });
      rankingTabSwitch.setProps({
        ariaLabel: t('cons.rankTabAria'),
        modelValue: activeRankingTab,
        options: getRankingTabOptions(),
      });
      modelsSortSwitch.setProps({
        ariaLabel: t('cons.modelsSortAria'),
        options: getModelsSortOptions(),
      });
      topConvsSortSwitch.setProps({
        ariaLabel: t('cons.topConvsSortAria'),
        options: getTopConvsSortOptions(),
      });
      patchText(topConvsEmptyEl, t('cons.topConvsEmpty'));
      patchText(sourcesTitleSpan, t('cons.clientSources'));
      patchText(sourcesHoverHint, t('cons.hoverModelsHint'));
      patchText(monthlyTitleSpan, t('cons.monthlyTitle'));
      patchText(monthlyHoverHint, t('cons.hoverModelsHint'));
      for (let i = 0; i < 12; i++) {
        patchText(monthlyCols[i].monthLabel, t('cons.monthLabel', { m: i + 1 }));
      }
      safetyMonitorCard.refs.refreshLabels();
    }

    const unsubI18n = i18nStore.subscribe(
      (st) => st.locale,
      () => {
        syncStaticLocaleLabels();
        if (getVisibleMonitorView() === 'consumption' && latestSlice) {
          isDirty = false;
          renderConsumptionData(latestSlice);
        } else {
          isDirty = true;
        }
      }
    );

    onCleanup(() => {
      clearConsAnimTimers();
      hideBreakdownPopover();
      unsub();
      unsubView();
      unsubI18n();
      consExportMenu.destroy();
      cyclePoolSelect.destroy();
      heatmapModeSwitch.destroy();
      trendChart.destroy?.();
      rankingTabSwitch.destroy();
      modelsSortSwitch.destroy();
      topConvsSortSwitch.destroy();
      timeFilterSwitch.destroy();
      startPicker.destroy();
      endPicker.destroy();
      safetyMonitorCard.destroy();
      viewScrollbar.destroy();
    });

    return {
      el: rootEl,
      refs: {
        timeFilterSwitch,
        cyclePoolSelect,
        heatmapModeSwitch,
        trendChart,
        startPicker,
        endPicker,
        viewScrollbar,
        breakdownPopoverEl,
        consExportMenu,
        safetyMonitorCard,
      },
    };
  },
});
