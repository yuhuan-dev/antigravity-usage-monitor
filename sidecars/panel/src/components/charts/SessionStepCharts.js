/**
 * @fileoverview 当前会话步骤级线性走势图与模型趋势拟合图组件 (SessionStepCharts).
 *
 * 包含两部分能力：
 * 1. `createSessionLineChart`：查看当前会话（支持主代理 / 子代理 / 全部汇总）所有模型的步进变化，
 *    支持切换 `总Token`（累计调用总量）、`上下文`（单步上下文体积）、`TPS`、`首字`、`费用` 五大维度；
 * 2. `createModelFitChart`：查看指定模型或全部模型的 `TPS`、`首字`、`缓存`、`费用` 散点与鲁棒局部加权线性回归（LOWESS + OLS 基准）拟合曲线，
 *    内置视图级模型锁定状态机，进入视图时自动锚定当前调用模型，停留在视图期间绝不随轮询跳变。
 */

import { h, patchAttr, patchClasses, patchStyleVar, patchText } from '../../core/domPatch.js';
import {
  formatAgentBadgeText,
  formatMetric,
  formatPctNumber,
  formatSpeedMetric,
  formatStepAnomalyInlineSummary,
  formatTokens,
  formatTokensPrecise,
  formatUsd,
  resolveModelDisplayInfo,
  speedReasonText,
} from '../../core/formatters.js';
import { SVG_NS } from '../../icons/SvgIcon.js';
import { getEffectiveLocale, t } from '../../i18n/index.js';

import {
  MODEL_COLOR_VARS,
  buildPolylinePath,
  buildSplinePath,
  clampValue,
  computeLinearFit,
  computeNiceXStepTicks,
  computeNiceYScale,
  computePublicationFit,
  computeStepTickIndices,
  downsampleStepPointsForPlot,
  evalStepSplineYAtX,
  formatChartMetricCompact,
  formatChartMetricValue,
  formatStepAxisTag,
  formatYAxisTick,
  getStepModelGroupKey,
  toChronologicalSteps,
} from './stepChartMath.js';
import {
  createCubicCurveMorphController,
  createFitGridMorphController,
  createFloatingChartTooltipController,
  createMultiSeriesCurveMorphController,
  createReadyClassArmer,
  pointsToNormalizedCubicSegs,
} from './chartMotion.js';

export {
  MODEL_COLOR_VARS,
  computeLinearFit,
  computePublicationFit,
  getStepModelGroupKey,
  toChronologicalSteps,
};

let sessionChartUid = 0;

/**
 * 创建会话全模型线性走势图（支持 `totalTokens` | `context` | `tps` | `ttft` | `cost`，全宽 1:1 贴边对齐）。
 */
export function createSessionLineChart() {
  const DEFAULT_VIEW_W = 460;
  const VIEW_H = 106;
  const TOP_Y = 18;
  const BOTTOM_Y = 94;
  const SPAN_Y = BOTTOM_Y - TOP_Y;

  let viewW = DEFAULT_VIEW_W;

  function resolvePlotBounds(w) {
    const leftX = 1;
    const rightX = Math.max(leftX + 20, w - 1);
    return { leftX, rightX, spanX: rightX - leftX };
  }

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${viewW} ${VIEW_H}`);
  svg.setAttribute('class', 'sstep-svg');
  svg.setAttribute('aria-hidden', 'true');

  const gradId = `sstep-line-grad-${++sessionChartUid}`;
  const defs = document.createElementNS(SVG_NS, 'defs');
  const grad = document.createElementNS(SVG_NS, 'linearGradient');
  grad.setAttribute('id', gradId);
  grad.setAttribute('x1', '0');
  grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '0');
  grad.setAttribute('y2', '1');
  const stop1 = document.createElementNS(SVG_NS, 'stop');
  stop1.setAttribute('offset', '0%');
  stop1.setAttribute('stop-color', 'var(--ctx-cached)');
  stop1.setAttribute('stop-opacity', '0.28');
  const stop2 = document.createElementNS(SVG_NS, 'stop');
  stop2.setAttribute('offset', '100%');
  stop2.setAttribute('stop-color', 'var(--ctx-cached)');
  stop2.setAttribute('stop-opacity', '0.0');
  grad.appendChild(stop1);
  grad.appendChild(stop2);
  defs.appendChild(grad);
  svg.appendChild(defs);

  const gridGroup = document.createElementNS(SVG_NS, 'g');
  gridGroup.setAttribute('class', 'trend-grid');
  const gridLines = [];
  for (const y of [TOP_Y, Math.round((TOP_Y + BOTTOM_Y) / 2), BOTTOM_Y]) {
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', '0');
    line.setAttribute('y1', String(y));
    line.setAttribute('x2', String(viewW));
    line.setAttribute('y2', String(y));
    gridGroup.appendChild(line);
    gridLines.push(line);
  }
  svg.appendChild(gridGroup);

  const areaPath = document.createElementNS(SVG_NS, 'path');
  areaPath.setAttribute('fill', `url(#${gradId})`);
  svg.appendChild(areaPath);

  const multiAreaGroup = document.createElementNS(SVG_NS, 'g');
  multiAreaGroup.setAttribute('class', 'sstep-multi-area-group');
  svg.appendChild(multiAreaGroup);

  const linePath = document.createElementNS(SVG_NS, 'path');
  linePath.setAttribute('class', 'trend-line');
  linePath.setAttribute('fill', 'none');
  svg.appendChild(linePath);

  const multiLineGroup = document.createElementNS(SVG_NS, 'g');
  multiLineGroup.setAttribute('class', 'sstep-multi-line-group');
  svg.appendChild(multiLineGroup);

  const dotsGroup = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(dotsGroup);

  const anomalyDotsGroup = document.createElementNS(SVG_NS, 'g');
  anomalyDotsGroup.setAttribute('class', 'sstep-anomaly-dots');
  svg.appendChild(anomalyDotsGroup);

  const hoverLine = document.createElementNS(SVG_NS, 'line');
  hoverLine.setAttribute('class', 'trend-hover-line');
  hoverLine.setAttribute('y1', '10');
  hoverLine.setAttribute('y2', String(BOTTOM_Y));
  hoverLine.setAttribute('hidden', 'true');
  svg.appendChild(hoverLine);

  const hoverDot = document.createElementNS(SVG_NS, 'circle');
  hoverDot.setAttribute('r', '3.4');
  hoverDot.setAttribute('class', 'trend-hover-dot');
  hoverDot.setAttribute('hidden', 'true');
  svg.appendChild(hoverDot);

  const emptyHintEl = h('div', {
    className: 'sstep-empty-hint text-muted',
    text: t('chart.step.empty'),
    hidden: true,
  });

  const peakPill = h('span', { className: 'trend-peak-pill text-mono', hidden: true });

  const tipHeadLeft = h('span', { className: 'trend-tip-time text-mono' });
  const tipHeadRight = h('span', { className: 'trend-tip-calls text-mono' });
  const tipMainLeft = h('strong', { className: 'trend-tip-tokens text-mono' });
  const tipMainRight = h('span', { className: 'trend-tip-cost text-mono' });
  const tipInLabelEl = h('span', { className: 'trend-tip-stat-label', text: t('cons.legInput') });
  const tipInValEl = h('span', { className: 'trend-tip-stat-val text-mono' });
  const tipCacheLabelEl = h('span', { className: 'trend-tip-stat-label', text: t('cons.legCache') });
  const tipCacheValEl = h('span', { className: 'trend-tip-stat-val text-mono' });
  const tipOutLabelEl = h('span', { className: 'trend-tip-stat-label', text: t('cons.legOutput') });
  const tipOutValEl = h('span', { className: 'trend-tip-stat-val text-mono' });
  const tipIoGrid = h('div', { className: 'trend-tip-sub is-grid', hidden: true }, [
    h('div', { className: 'trend-tip-stat' }, [tipInLabelEl, tipInValEl]),
    h('div', { className: 'trend-tip-stat' }, [tipCacheLabelEl, tipCacheValEl]),
    h('div', { className: 'trend-tip-stat' }, [tipOutLabelEl, tipOutValEl]),
  ]);
  const tipSub = h('div', { className: 'trend-tip-sub text-mono', hidden: true });
  const tipAnomaly = h('div', { className: 'trend-tip-anomaly text-mono', hidden: true });
  const tooltipEl = h('div', { className: 'trend-tooltip', hidden: true }, [
    h('div', { className: 'trend-tip-head' }, [tipHeadLeft, tipHeadRight]),
    h('div', { className: 'trend-tip-main' }, [tipMainLeft, tipMainRight]),
    tipIoGrid,
    tipSub,
    tipAnomaly,
  ]);

  const xAxisEl = h('div', { className: 'trend-x-axis' });
  const modelLegendEl = h('div', { className: 'sstep-model-legend', hidden: true });
  const plotStage = h('div', { className: 'sstep-plot-stage' }, [
    peakPill,
    emptyHintEl,
    svg,
  ]);
  const rootEl = h('div', { className: 'sstep-chart-wrap' }, [
    plotStage,
    xAxisEl,
    modelLegendEl,
    tooltipEl,
  ]);

  let currentPoints = [];
  let currentMaxVal = 0;
  let currentMetric = 'totalTokens';
  let hoveredIdx = -1;
  let lastPointer = null;
  let tickElsByIdx = new Map();
  let lastSig = '';
  let lastPreSig = '';
  let lastSummaryBadge = '';
  let lastUpdateParams = null;
  let cachedPlotSvgRect = null;
  let lastLineMode = '';
  let lastSingleLineKey = '';
  const multiSeriesNodesByKey = new Map();
  const anomalyDotElsByKey = new Map();

  const singleCurveMorphCtrl = createCubicCurveMorphController();
  const multiCurveMorphCtrl = createMultiSeriesCurveMorphController();
  const peakReadyArmer = createReadyClassArmer(peakPill, 'is-ready');
  const lineTooltipCtrl = createFloatingChartTooltipController({
    containerEl: rootEl,
    tooltipEl,
    defaultTipWidth: 212,
    defaultTipHeight: 86,
    defaultViewWidth: DEFAULT_VIEW_W,
    defaultViewHeight: VIEW_H,
  });

  function invalidatePlotSvgRect() {
    cachedPlotSvgRect = null;
    lineTooltipCtrl.invalidateRects();
  }

  function syncViewWidth() {
    const measured = Math.round(
      plotStage.clientWidth ||
        svg.clientWidth ||
        plotStage.getBoundingClientRect?.()?.width ||
        0
    );
    if (measured >= 160 && measured !== viewW) {
      viewW = measured;
      svg.setAttribute('viewBox', `0 0 ${viewW} ${VIEW_H}`);
      for (const line of gridLines) {
        line.setAttribute('x1', '0');
        line.setAttribute('x2', String(viewW));
      }
      return true;
    }
    return false;
  }

  function showHoverAt(idx, pointer = null, { forceRefresh = false } = {}) {
    if (idx < 0 || idx >= currentPoints.length) {
      clearHover();
      return;
    }
    const wasHidden = tooltipEl.hasAttribute('hidden');
    const changedIdx = forceRefresh || wasHidden || idx !== hoveredIdx;
    hoveredIdx = idx;
    if (pointer) {
      lastPointer = pointer;
    }
    const pt = currentPoints[idx];
    const hasIoParts = Boolean(pt.ioParts);

    if (changedIdx) {
      patchAttr(hoverLine, 'hidden', false);
      patchAttr(hoverLine, 'x1', pt.x.toFixed(1));
      patchAttr(hoverLine, 'x2', pt.x.toFixed(1));

      patchAttr(hoverDot, 'hidden', false);
      patchAttr(hoverDot, 'cx', pt.x.toFixed(1));
      patchAttr(hoverDot, 'cy', pt.y.toFixed(1));
      const hoverAccent = pt.anomalySummary
        ? pt.anomalySeverity === 'danger'
          ? 'var(--metric-danger)'
          : 'var(--metric-warn)'
        : pt.hoverColor || 'var(--ctx-cached)';
      patchStyleVar(hoverDot, '--hover-dot-color', hoverAccent);

      patchAttr(peakPill, 'hidden', true);

      patchText(tipHeadLeft, pt.stepTag);
      patchText(tipHeadRight, pt.modelText);
      patchText(
        tipMainLeft,
        pt.valid ? formatChartMetricValue(currentMetric, pt.value) : t('chart.step.excluded')
      );
      patchText(tipMainRight, pt.secondaryRight || '');
      patchAttr(tipIoGrid, 'hidden', !hasIoParts);
      if (hasIoParts) {
        patchText(tipInLabelEl, t('cons.legInput'));
        patchText(tipCacheLabelEl, t('cons.legCache'));
        patchText(tipOutLabelEl, t('cons.legOutput'));
        patchText(tipInValEl, pt.ioParts.inTok);
        patchText(tipCacheValEl, pt.ioParts.cacheTok);
        patchText(tipOutValEl, pt.ioParts.outTok);
      }
      patchAttr(tipSub, 'hidden', hasIoParts || !pt.subDetail);
      if (!hasIoParts && pt.subDetail) {
        patchText(tipSub, pt.subDetail);
      }
      patchAttr(tipAnomaly, 'hidden', !pt.anomalySummary);
      if (pt.anomalySummary) {
        patchText(tipAnomaly, pt.anomalySummary);
        patchClasses(tipAnomaly, { 'is-danger': pt.anomalySeverity === 'danger' });
      }

      for (const [tIdx, el] of tickElsByIdx.entries()) {
        patchClasses(el, { 'is-hovered': tIdx === idx });
      }
    }

    const wrapRect = lineTooltipCtrl.getWrapRect();
    const wrapW =
      wrapRect && wrapRect.width > 0
        ? wrapRect.width
        : Number(rootEl.clientWidth || viewW || DEFAULT_VIEW_W);
    const fallbackX = (pt.x / Math.max(1, viewW)) * wrapW;
    const fallbackY = pt.y + 4;
    lineTooltipCtrl.show({
      fallbackX,
      fallbackY,
      pointer: pointer || lastPointer,
      trackedDots: [hoverDot],
      viewWidth: viewW,
      viewHeight: VIEW_H,
      sizeKey: `${hasIoParts ? 'io' : pt.subDetail ? 'sub' : 'min'}:${pt.anomalySummary ? 'a' : '0'}`,
    });
  }

  function clearHover() {
    hoveredIdx = -1;
    lastPointer = null;
    lineTooltipCtrl.hide();
    patchAttr(hoverLine, 'hidden', true);
    patchAttr(hoverDot, 'hidden', true);
    patchClasses(hoverDot, { 'is-tracking': false });
    if (currentMaxVal > 0 && currentPoints.some((p) => p.valid)) {
      patchAttr(peakPill, 'hidden', false);
    }
    for (const el of tickElsByIdx.values()) {
      patchClasses(el, { 'is-hovered': false });
    }
  }

  plotStage.addEventListener('mousemove', (e) => {
    if (!currentPoints.length) return;
    if (!cachedPlotSvgRect) {
      cachedPlotSvgRect = svg.getBoundingClientRect();
    }
    const rect = cachedPlotSvgRect;
    if (!rect || rect.width <= 0) {
      cachedPlotSvgRect = null;
      return;
    }
    const relX = ((e.clientX - rect.left) / rect.width) * viewW;
    const { leftX, spanX } = resolvePlotBounds(viewW);
    const ratio = (relX - leftX) / Math.max(1, spanX);
    const idx = Math.max(
      0,
      Math.min(currentPoints.length - 1, Math.round(ratio * (currentPoints.length - 1)))
    );
    const pointer =
      Number.isFinite(Number(e?.clientX)) && Number.isFinite(Number(e?.clientY))
        ? { clientX: Number(e.clientX), clientY: Number(e.clientY) }
        : null;
    showHoverAt(idx, pointer);
  });
  plotStage.addEventListener('mouseleave', () => {
    invalidatePlotSvgRect();
    clearHover();
  });

  let resizeObs = null;
  let onWinResize = null;
  if (typeof ResizeObserver === 'function') {
    resizeObs = new ResizeObserver(() => {
      invalidatePlotSvgRect();
      if (syncViewWidth() && lastUpdateParams) {
        lastSig = '';
        lastPreSig = '';
        update({ ...lastUpdateParams, _skipMorph: true });
      }
    });
    resizeObs.observe(plotStage);
  } else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    onWinResize = () => {
      if (syncViewWidth() && lastUpdateParams) {
        lastSig = '';
        update({ ...lastUpdateParams, _skipMorph: true });
      }
    };
    window.addEventListener('resize', onWinResize);
  }

  function destroy() {
    singleCurveMorphCtrl.cancel();
    multiCurveMorphCtrl.cancel();
    peakReadyArmer.cancel();
    lineTooltipCtrl.destroy();
    resizeObs?.disconnect();
    resizeObs = null;
    if (onWinResize && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('resize', onWinResize);
      onWinResize = null;
    }
  }

  /**
   * @param {{
   *   steps: Array<object>,
   *   modelGroupKey?: string,
   *   modelGroupKeys?: string[]|null,
   *   modelColorByGroup?: Map<string, string>|null,
   *   metric: 'totalTokens'|'context'|'tps'|'ttft'|'cost',
   *   showAgentPrefix?: boolean,
   *   displaySettings?: object,
   * }} params
   * @returns {{ summaryBadge: string }}
   */
  function update({
    steps = [],
    modelGroupKey = '__all__',
    modelGroupKeys = null,
    modelColorByGroup = null,
    metric = 'totalTokens',
    showAgentPrefix = false,
    displaySettings = {},
    _skipMorph = false,
  } = {}) {
    lastUpdateParams = {
      steps,
      modelGroupKey,
      modelGroupKeys,
      modelColorByGroup,
      metric,
      showAgentPrefix,
      displaySettings,
    };
    currentMetric = metric;
    syncViewWidth();

    const accentColor = 'var(--ctx-cached)';
    patchAttr(stop1, 'stop-color', accentColor);
    patchAttr(stop2, 'stop-color', accentColor);
    patchStyleVar(rootEl, '--sstep-accent', accentColor);

    const rawKeys =
      Array.isArray(modelGroupKeys) && modelGroupKeys.length > 0
        ? modelGroupKeys
        : [modelGroupKey || '__all__'];
    const isPooledAll = rawKeys.includes('__all__');
    const targetKeys = isPooledAll
      ? ['__all__']
      : Array.from(new Set(rawKeys.map((k) => String(k || '')).filter(Boolean)));
    const targetKeySet = new Set(targetKeys);
    const isMultiCompare = !isPooledAll && targetKeys.length >= 2;

    const matchedSteps = isPooledAll
      ? steps
      : steps.filter((st) => st && targetKeySet.has(getStepModelGroupKey(st)));

    patchText(emptyHintEl, t('chart.step.empty'));
    if (!matchedSteps.length) {
      currentPoints = [];
      patchClasses(rootEl, { 'is-dense': false });
      lastSig = 'empty';
      lastPreSig = '';
      lastLineMode = '';
      lastSingleLineKey = '';
      singleCurveMorphCtrl.reset();
      multiCurveMorphCtrl.reset();
      lastSummaryBadge = t('chart.step.zeroSteps');
      invalidatePlotSvgRect();
      patchAttr(areaPath, 'd', '');
      patchAttr(linePath, 'd', '');
      while (multiAreaGroup.firstChild) multiAreaGroup.removeChild(multiAreaGroup.firstChild);
      while (multiLineGroup.firstChild) multiLineGroup.removeChild(multiLineGroup.firstChild);
      while (dotsGroup.firstChild) dotsGroup.removeChild(dotsGroup.firstChild);
      while (anomalyDotsGroup.firstChild) anomalyDotsGroup.removeChild(anomalyDotsGroup.firstChild);
      anomalyDotElsByKey.clear();
      while (xAxisEl.firstChild) xAxisEl.removeChild(xAxisEl.firstChild);
      patchAttr(modelLegendEl, 'hidden', true);
      patchAttr(peakPill, 'hidden', true);
      patchAttr(emptyHintEl, 'hidden', false);
      clearHover();
      return { summaryBadge: lastSummaryBadge };
    }

    const locale = getEffectiveLocale();
    const extColorSig = modelColorByGroup
      ? Array.from(modelColorByGroup.entries())
          .map(([k, v]) => `${k}=${v}`)
          .join(',')
      : '';
    let preStepParts = `${matchedSteps.length}:`;
    for (let i = 0; i < matchedSteps.length; i += 1) {
      const s = matchedSteps[i];
      preStepParts += `${s.stepIndex ?? i},${s.agentIndex ?? 0},${s.modelKey || s.modelShort || ''},${s.inputTokens || 0},${s.cacheReadTokens || 0},${s.outputTokens || 0},${s.contextTokens || 0},${s.tokPerSec ?? ''},${s.ttftSec ?? ''},${s.costUsd ?? ''},${s.anomalySig || ''};`;
    }
    const preSig = `${locale}|${viewW}|${metric}|${showAgentPrefix}|${displaySettings?.modelDisplayMode || ''}|${Boolean(displaySettings?.showUpstreamModel)}|${targetKeys.join(',')}|${extColorSig}|${preStepParts}`;
    if (preSig === lastPreSig && lastSummaryBadge) {
      return { summaryBadge: lastSummaryBadge };
    }

    const modelColorMap = new Map();
    const modelLabelByGroup = new Map();
    if (isMultiCompare) {
      for (let i = 0; i < targetKeys.length; i++) {
        const gk = targetKeys[i];
        const colorVar =
          modelColorByGroup?.get(gk) || MODEL_COLOR_VARS[i % MODEL_COLOR_VARS.length];
        modelColorMap.set(gk, colorVar);
        const disp = resolveModelDisplayInfo({ modelLabel: gk, label: gk }, displaySettings, {
          fallback: gk,
        });
        modelLabelByGroup.set(gk, disp.baseText || disp.text || gk);
      }
    }
    for (const st of matchedSteps) {
      const gk = getStepModelGroupKey(st);
      if (!modelColorMap.has(gk)) {
        const colorVar =
          modelColorByGroup?.get(gk) ||
          MODEL_COLOR_VARS[modelColorMap.size % MODEL_COLOR_VARS.length];
        modelColorMap.set(gk, colorVar);
      }
      if (!modelLabelByGroup.has(gk)) {
        const disp = resolveModelDisplayInfo(st, displaySettings, { fallback: gk });
        modelLabelByGroup.set(gk, disp.baseText || disp.text || gk);
      }
    }

    let runningTokens = 0;
    let runningCost = 0;
    let validSum = 0;
    let validCount = 0;
    const perModelRunningTokens = new Map();
    const perModelRunningCost = new Map();
    const perModelPrevCtx = new Map();
    const perModelStats = new Map();

    const rawItems = matchedSteps.map((st, idx) => {
      const gk = getStepModelGroupKey(st);
      const inTok = Math.max(0, Number(st.inputTokens || 0));
      const cacheTok = Math.max(0, Number(st.cacheReadTokens || 0));
      const outTok = Math.max(0, Number(st.outputTokens || 0));
      const stepTotalTok = inTok + cacheTok + outTok;
      runningTokens += stepTotalTok;
      const modelCumTok = (perModelRunningTokens.get(gk) || 0) + stepTotalTok;
      perModelRunningTokens.set(gk, modelCumTok);

      const stepCost = Number.isFinite(Number(st.costUsd)) ? Math.max(0, Number(st.costUsd)) : null;
      if (stepCost !== null) {
        runningCost += stepCost;
        perModelRunningCost.set(gk, (perModelRunningCost.get(gk) || 0) + stepCost);
      }
      const modelCumCost = perModelRunningCost.get(gk) || 0;

      const ctxTok = Math.max(0, Number(st.contextTokens ?? stepTotalTok));
      const hasPrevModelCtx = perModelPrevCtx.has(gk);
      const prevSameModelCtx = hasPrevModelCtx ? perModelPrevCtx.get(gk) : ctxTok;
      perModelPrevCtx.set(gk, ctxTok);

      const prevGlobalCtx =
        idx > 0
          ? Math.max(
              0,
              Number(
                matchedSteps[idx - 1].contextTokens ??
                  Number(matchedSteps[idx - 1].inputTokens || 0) +
                    Number(matchedSteps[idx - 1].cacheReadTokens || 0) +
                    Number(matchedSteps[idx - 1].outputTokens || 0)
              )
            )
          : ctxTok;
      const hasPrevCtx = isMultiCompare ? hasPrevModelCtx : idx > 0;
      const ctxDelta = isMultiCompare ? ctxTok - prevSameModelCtx : idx > 0 ? ctxTok - prevGlobalCtx : 0;

      const disp = resolveModelDisplayInfo(st, displaySettings, { fallback: '—' });
      const stepTag = formatStepAxisTag(st, showAgentPrefix);

      let valid = true;
      let value = 0;
      let secondaryRight = '';
      let subDetail = '';
      let ioParts = null;

      if (metric === 'totalTokens') {
        value = isMultiCompare ? modelCumTok : runningTokens;
        secondaryRight = t('chart.step.stepAdd', { tokens: formatTokens(stepTotalTok) });
        ioParts = {
          inTok: formatTokens(inTok),
          cacheTok: formatTokens(cacheTok),
          outTok: formatTokens(outTok),
        };
        subDetail = t('chart.step.ioSplit', ioParts);
      } else if (metric === 'context') {
        value = ctxTok;
        if (hasPrevCtx) {
          const sign = ctxDelta >= 0 ? '+' : '-';
          secondaryRight = `${sign}${formatTokens(Math.abs(ctxDelta))}`;
        } else {
          secondaryRight = t('chart.step.cacheShort', { pct: Number(st.cacheHitPct ?? 0) });
        }
        subDetail = st.isCompactionStep
          ? t('chart.step.compactionCheckpoint')
          : t('chart.step.cacheHitOut', {
              pct: Number(st.cacheHitPct ?? 0),
              outTok: formatTokens(outTok),
            });
      } else if (metric === 'tps') {
        valid = !st.isCompactionStep && Number.isFinite(st.tokPerSec) && st.tokPerSec > 0;
        value = valid ? Number(st.tokPerSec) : 0;
        secondaryRight = Number.isFinite(st.ttftSec)
          ? t('chart.step.ttftShort', { sec: formatMetric(st.ttftSec, '') })
          : '';
        subDetail = valid
          ? t('chart.step.outAndCtx', {
              outTok: formatTokens(outTok),
              ctxTok: formatTokens(ctxTok),
            })
          : speedReasonText(st.selectedSpeedReason) ||
            (st.isCompactionStep ? t('chart.step.compactionStep') : t('chart.step.noSpeedSample'));
      } else if (metric === 'ttft') {
        valid = !st.isCompactionStep && Number.isFinite(st.ttftSec) && st.ttftSec >= 0;
        value = valid ? Number(st.ttftSec) : 0;
        secondaryRight = Number.isFinite(st.tokPerSec) ? formatSpeedMetric(st.tokPerSec, ' tok/s') : '';
        subDetail = valid
          ? t('chart.step.ctxAndCache', {
              ctxTok: formatTokens(ctxTok),
              pct: Number(st.cacheHitPct ?? 0),
            })
          : st.isCompactionStep
            ? t('chart.step.compactionStep')
            : t('chart.step.noTtftSample');
      } else if (metric === 'cost') {
        valid = stepCost !== null;
        value = valid ? stepCost : 0;
        const shownCumCost = isMultiCompare ? modelCumCost : runningCost;
        secondaryRight = t('chart.step.cumCost', {
          cost: formatUsd(shownCumCost, { precise: shownCumCost > 0 && shownCumCost < 0.1 }),
        });
        subDetail = t('chart.step.cacheAndStepTok', {
          pct: Number(st.cacheHitPct ?? 0),
          tokens: formatTokens(stepTotalTok),
        });
      }

      if (valid) {
        validSum += value;
        validCount += 1;
        let stStat = perModelStats.get(gk);
        if (!stStat) {
          stStat = { count: 0, sum: 0, max: 0, last: 0, cumTok: 0, cumCost: 0 };
          perModelStats.set(gk, stStat);
        }
        stStat.count += 1;
        stStat.sum += value;
        if (value > stStat.max) stStat.max = value;
        stStat.last = value;
        stStat.cumTok = modelCumTok;
        stStat.cumCost = modelCumCost;
      }

      const dotColor = modelColorMap.get(gk) || accentColor;
      const anomalySummary = formatStepAnomalyInlineSummary(st.anomaly);
      return {
        idx,
        st,
        stepTag,
        modelGroupKey: gk,
        modelText: disp.text,
        dotColor,
        hoverColor: isMultiCompare ? dotColor : accentColor,
        valid,
        value,
        secondaryRight,
        subDetail,
        ioParts,
        anomalySummary,
        anomalySeverity: st.anomaly?.severity || '',
      };
    });

    let maxVal = 0;
    let peakIdx = -1;
    for (let i = 0; i < rawItems.length; i++) {
      if (rawItems[i].valid && rawItems[i].value >= maxVal) {
        maxVal = rawItems[i].value;
        peakIdx = i;
      }
    }
    currentMaxVal = maxVal;

    const { leftX, rightX, spanX } = resolvePlotBounds(viewW);
    const maxPlotPoints = Math.max(128, Math.min(256, Math.floor(spanX / 2.1)));
    const denom = maxVal > 0 ? maxVal : 1;
    const isSingle = rawItems.length === 1;
    const points = rawItems.map((item, i) => {
      const x = isSingle
        ? (leftX + rightX) / 2
        : leftX + (i / Math.max(1, rawItems.length - 1)) * spanX;
      const ratio = item.valid && maxVal > 0 ? item.value / denom : 0;
      const y = item.valid ? BOTTOM_Y - ratio * SPAN_Y : BOTTOM_Y;
      return { ...item, x, y };
    });

    const validPoints = points.filter((p) => p.valid);
    let hoverPoints = points;
    if (isMultiCompare) {
      if (points.length > maxPlotPoints * targetKeys.length) {
        const merged = [];
        for (const gk of targetKeys) {
          const rawSeries = points.filter((p) => p.modelGroupKey === gk && p.valid);
          merged.push(...downsampleStepPointsForPlot(rawSeries, maxPlotPoints));
        }
        merged.sort((a, b) => a.idx - b.idx);
        if (merged.length > 0) hoverPoints = merged;
      }
    } else if (validPoints.length > maxPlotPoints) {
      hoverPoints = downsampleStepPointsForPlot(validPoints, maxPlotPoints);
    }
    currentPoints = hoverPoints;
    patchClasses(rootEl, {
      'is-dense': isMultiCompare
        ? hoverPoints.length > 120 * targetKeys.length
        : hoverPoints.length > 120,
    });
    patchAttr(emptyHintEl, 'hidden', validPoints.length > 0);

    const colorSig = Array.from(modelColorMap.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    const sig =
      `${locale}|${viewW}|${metric}|${showAgentPrefix}|${isMultiCompare ? 'multi' : 'single'}:${targetKeys.join(',')}|${colorSig}|` +
      points
        .map(
          (p) =>
            `${p.stepTag}:${p.modelText}:${p.valid ? p.value.toFixed(4) : 'x'}:${p.st?.anomalySig || ''}`
        )
        .join('|');

    if (sig !== lastSig) {
      lastSig = sig;
      while (dotsGroup.firstChild) dotsGroup.removeChild(dotsGroup.firstChild);
      const plottedSeriesByKey = new Map();
      let singlePlottedPts = null;

      if (isMultiCompare) {
        if (lastLineMode === 'single') {
          const prevSingleSegs = singleCurveMorphCtrl.getCurrentSegs();
          if (prevSingleSegs.length > 0) {
            if (lastSingleLineKey && lastSingleLineKey !== '__all__') {
              multiCurveMorphCtrl.seedSeries(lastSingleLineKey, prevSingleSegs);
            } else {
              for (const gk of targetKeys) {
                multiCurveMorphCtrl.seedSeries(gk, prevSingleSegs);
              }
            }
          }
        }
        singleCurveMorphCtrl.reset();
        lastLineMode = 'multi';
        lastSingleLineKey = '';
        patchAttr(linePath, 'd', '');
        patchAttr(areaPath, 'd', '');
        for (let ci = multiLineGroup.children.length - 1; ci >= 0; ci--) {
          const ch = multiLineGroup.children[ci];
          if (ch.getAttribute?.('class') === 'sstep-series-single-dot') {
            ch.remove();
          }
        }

        const activeGks = new Set();
        const morphItems = [];

        for (const gk of targetKeys) {
          const seriesColor = modelColorMap.get(gk) || accentColor;
          const rawSeriesPts = points.filter((p) => p.modelGroupKey === gk && p.valid);
          const seriesPts = downsampleStepPointsForPlot(rawSeriesPts, maxPlotPoints);
          if (seriesPts.length === 0) continue;
          plottedSeriesByKey.set(gk, seriesPts);

          if (seriesPts.length === 1) {
            const singleDot = document.createElementNS(SVG_NS, 'circle');
            singleDot.setAttribute('cx', seriesPts[0].x.toFixed(1));
            singleDot.setAttribute('cy', seriesPts[0].y.toFixed(1));
            singleDot.setAttribute('r', '3.1');
            singleDot.setAttribute('class', 'sstep-series-single-dot');
            patchStyleVar(singleDot, '--sstep-series-color', seriesColor);
            multiLineGroup.appendChild(singleDot);
          } else {
            activeGks.add(gk);
            let nodes = multiSeriesNodesByKey.get(gk);
            if (!nodes) {
              const mArea = document.createElementNS(SVG_NS, 'path');
              mArea.setAttribute('class', 'sstep-multi-area');
              const mLine = document.createElementNS(SVG_NS, 'path');
              mLine.setAttribute('class', 'sstep-fit-line');
              mLine.setAttribute('fill', 'none');
              nodes = { mArea, mLine };
              multiSeriesNodesByKey.set(gk, nodes);
            }
            patchStyleVar(nodes.mArea, '--sstep-series-color', seriesColor);
            patchStyleVar(nodes.mLine, '--sstep-fit-accent', seriesColor);
            multiAreaGroup.appendChild(nodes.mArea);
            multiLineGroup.appendChild(nodes.mLine);

            const seriesLineD = buildSplinePath(seriesPts);
            const firstX = seriesPts[0].x.toFixed(1);
            const lastX = seriesPts[seriesPts.length - 1].x.toFixed(1);
            const seriesAreaD = `${seriesLineD} L ${lastX} ${BOTTOM_Y} L ${firstX} ${BOTTOM_Y} Z`;

            morphItems.push({
              key: gk,
              nextSegs: pointsToNormalizedCubicSegs(seriesPts, BOTTOM_Y, {
                leftX,
                spanX,
              }),
              lineEl: nodes.mLine,
              areaEl: nodes.mArea,
              endDotEl: null,
              endX: NaN,
              endY: NaN,
              finalLineD: seriesLineD,
              finalAreaD: seriesAreaD,
            });
          }
        }

        for (const [gk, nodes] of multiSeriesNodesByKey.entries()) {
          if (!activeGks.has(gk)) {
            nodes.mArea.remove();
            nodes.mLine.remove();
          }
        }

        multiCurveMorphCtrl.morphSeries({
          items: morphItems,
          leftX,
          spanX,
          bottomY: BOTTOM_Y,
          skipMorph: _skipMorph,
          allowBaselineEntry: true,
        });
      } else {
        const nextSingleKey = isPooledAll ? '__all__' : targetKeys[0] || '__all__';
        if (lastLineMode === 'multi') {
          const seedSegs =
            multiCurveMorphCtrl.getSeriesSegs(nextSingleKey) ||
            multiCurveMorphCtrl.getFirstSegs();
          if (seedSegs && seedSegs.length > 0) {
            singleCurveMorphCtrl.seedSegs(seedSegs);
          }
        }
        multiCurveMorphCtrl.reset();
        lastLineMode = 'single';
        lastSingleLineKey = nextSingleKey;
        for (const nodes of multiSeriesNodesByKey.values()) {
          nodes.mArea.remove();
          nodes.mLine.remove();
        }
        const plotValidPoints = downsampleStepPointsForPlot(validPoints, maxPlotPoints);
        singlePlottedPts = plotValidPoints;
        if (plotValidPoints.length === 0) {
          singleCurveMorphCtrl.reset();
          patchAttr(linePath, 'd', '');
          patchAttr(areaPath, 'd', '');
        } else if (plotValidPoints.length === 1) {
          const yVal = plotValidPoints[0].y;
          const yStr = yVal.toFixed(1);
          const lineD = `M ${leftX.toFixed(1)} ${yStr} L ${rightX.toFixed(1)} ${yStr}`;
          const areaD = `${lineD} L ${rightX.toFixed(1)} ${BOTTOM_Y} L ${leftX.toFixed(1)} ${BOTTOM_Y} Z`;
          const flatPts = [
            { x: leftX, y: yVal },
            { x: rightX, y: yVal },
          ];
          singleCurveMorphCtrl.morphTo({
            nextSegs: pointsToNormalizedCubicSegs(flatPts, BOTTOM_Y, { leftX, spanX }),
            leftX,
            spanX,
            bottomY: BOTTOM_Y,
            linePath,
            areaPath,
            finalLineD: lineD,
            finalAreaD: areaD,
            skipMorph: _skipMorph,
          });
        } else {
          const lineD = buildSplinePath(plotValidPoints);
          const firstX = plotValidPoints[0].x.toFixed(1);
          const lastX = plotValidPoints[plotValidPoints.length - 1].x.toFixed(1);
          const areaD = `${lineD} L ${lastX} ${BOTTOM_Y} L ${firstX} ${BOTTOM_Y} Z`;
          singleCurveMorphCtrl.morphTo({
            nextSegs: pointsToNormalizedCubicSegs(plotValidPoints, BOTTOM_Y, { leftX, spanX }),
            leftX,
            spanX,
            bottomY: BOTTOM_Y,
            linePath,
            areaPath,
            finalLineD: lineD,
            finalAreaD: areaD,
            skipMorph: _skipMorph,
          });
        }
      }

      const clusteredAnomalies = [];
      for (const pt of points) {
        if (!pt.valid || !pt.anomalySummary) continue;
        const curvePts = isMultiCompare
          ? plottedSeriesByKey.get(pt.modelGroupKey)
          : singlePlottedPts;
        if (!curvePts || curvePts.length === 0) continue;
        const onCurveY =
          curvePts.length === 1 ? curvePts[0].y : evalStepSplineYAtX(curvePts, pt.x);
        const prevCluster = clusteredAnomalies[clusteredAnomalies.length - 1];
        if (
          prevCluster &&
          (!isMultiCompare || prevCluster.modelGroupKey === pt.modelGroupKey) &&
          Math.abs(pt.x - prevCluster.x) < 3.0
        ) {
          if (pt.anomalySeverity === 'danger' && prevCluster.severity !== 'danger') {
            prevCluster.key = `${pt.stepTag}:${pt.modelGroupKey}`;
            prevCluster.x = pt.x;
            prevCluster.y = onCurveY;
            prevCluster.severity = 'danger';
          }
          continue;
        }
        clusteredAnomalies.push({
          key: `${pt.stepTag}:${pt.modelGroupKey}`,
          modelGroupKey: pt.modelGroupKey,
          x: pt.x,
          y: onCurveY,
          severity: pt.anomalySeverity === 'danger' ? 'danger' : 'warn',
        });
      }
      clusteredAnomalies.sort((a, b) =>
        a.severity === 'danger' ? 1 : b.severity === 'danger' ? -1 : 0
      );

      const activeAnomalyKeys = new Set();
      for (const item of clusteredAnomalies) {
        activeAnomalyKeys.add(item.key);
        let dotEl = anomalyDotElsByKey.get(item.key);
        if (!dotEl) {
          dotEl = document.createElementNS(SVG_NS, 'circle');
          dotEl.setAttribute('r', '2.1');
          anomalyDotElsByKey.set(item.key, dotEl);
        }
        patchAttr(dotEl, 'cx', item.x.toFixed(1));
        patchAttr(dotEl, 'cy', item.y.toFixed(1));
        patchAttr(
          dotEl,
          'class',
          `sstep-anomaly-dot${item.severity === 'danger' ? ' is-danger' : ''}`
        );
        anomalyDotsGroup.appendChild(dotEl);
      }
      for (const [k, el] of anomalyDotElsByKey.entries()) {
        if (!activeAnomalyKeys.has(k)) {
          el.remove();
          anomalyDotElsByKey.delete(k);
        }
      }

      const tickIndices = computeStepTickIndices(currentPoints.length);
      while (xAxisEl.firstChild) xAxisEl.removeChild(xAxisEl.firstChild);
      tickElsByIdx = new Map();
      for (let i = 0; i < tickIndices.length; i++) {
        const tIdx = tickIndices[i];
        const pt = currentPoints[tIdx];
        if (!pt) continue;
        const isFirst = !isSingle && i === 0;
        const isLast = !isSingle && i === tickIndices.length - 1;
        const pct = isFirst ? 0 : isLast ? 100 : (pt.x / viewW) * 100;
        const tickEl = h('span', {
          className: `trend-x-tick text-mono${isFirst ? ' is-start' : isLast ? ' is-end' : ''}`,
          text: pt.stepTag,
          title: `${pt.stepTag} · ${pt.modelText}`,
        });
        patchStyleVar(tickEl, '--tick-x', `${pct.toFixed(2)}%`);
        tickEl.onclick = () => {
          lastPointer = null;
          showHoverAt(tIdx, null);
        };
        xAxisEl.appendChild(tickEl);
        tickElsByIdx.set(tIdx, tickEl);
      }

      while (modelLegendEl.firstChild) modelLegendEl.removeChild(modelLegendEl.firstChild);
      if (isMultiCompare) {
        patchAttr(modelLegendEl, 'hidden', false);
        for (const gk of targetKeys) {
          const colorVar = modelColorMap.get(gk) || accentColor;
          const swatch = h('span', { className: 'sstep-legend-line' });
          patchStyleVar(swatch, '--swatch-bg', colorVar);
          const stStat = perModelStats.get(gk);
          const baseLabel = modelLabelByGroup.get(gk) || gk;
          let summarySuffix = t('chart.step.noSamples');
          if (stStat && stStat.count > 0) {
            if (metric === 'totalTokens') {
              summarySuffix = formatTokens(stStat.cumTok);
            } else if (metric === 'context') {
              summarySuffix = t('chart.step.peakShort', { val: formatTokens(stStat.max) });
            } else if (metric === 'tps' || metric === 'ttft') {
              summarySuffix = formatChartMetricCompact(metric, stStat.sum / stStat.count);
            } else if (metric === 'cost') {
              summarySuffix = formatUsd(stStat.cumCost, {
                precise: stStat.cumCost > 0 && stStat.cumCost < 0.1,
              });
            }
          }
          modelLegendEl.appendChild(
            h('span', { className: 'sstep-legend-item' }, [
              swatch,
              h('span', { text: `${baseLabel} (${summarySuffix})` }),
            ])
          );
        }
      } else {
        const showPooledDotLegend = points.length <= 64 && modelColorMap.size > 1;
        patchAttr(modelLegendEl, 'hidden', !showPooledDotLegend);
        if (showPooledDotLegend) {
          for (const [gk, colorVar] of modelColorMap.entries()) {
            const swatch = h('span', { className: 'sstep-legend-dot' });
            patchStyleVar(swatch, '--swatch-bg', colorVar);
            modelLegendEl.appendChild(
              h('span', { className: 'sstep-legend-item' }, [
                swatch,
                h('span', { text: modelLabelByGroup.get(gk) || gk }),
              ])
            );
          }
        }
      }
    }

    if (peakIdx >= 0 && validPoints.length > 0 && maxVal > 0) {
      const peakPt = points[peakIdx];
      patchText(
        peakPill,
        t('chart.step.peakPill', {
          tag: peakPt.stepTag,
          val: formatChartMetricCompact(metric, peakPt.value),
        })
      );
      patchStyleVar(peakPill, '--sstep-accent', isMultiCompare ? peakPt.dotColor : accentColor);
      const pctLeft = Math.max(14, Math.min(86, (peakPt.x / viewW) * 100));
      patchStyleVar(peakPill, '--peak-x', `${pctLeft.toFixed(1)}%`);
      peakReadyArmer.arm();
      if (hoveredIdx < 0) patchAttr(peakPill, 'hidden', false);
    } else {
      patchAttr(peakPill, 'hidden', true);
    }

    if (hoveredIdx >= currentPoints.length) {
      clearHover();
    } else if (hoveredIdx >= 0) {
      showHoverAt(hoveredIdx, lastPointer, { forceRefresh: true });
    }

    let summaryBadge = t('chart.step.stepsCount', { count: matchedSteps.length });
    const activeCompareCount = isMultiCompare ? targetKeys.length : 1;
    const multiPrefix = isMultiCompare
      ? t('chart.step.multiPrefix', { count: activeCompareCount })
      : '';
    if (metric === 'totalTokens') {
      summaryBadge = t('chart.step.sumTokens', {
        prefix: multiPrefix,
        tokens: formatTokens(runningTokens),
      });
    } else if (metric === 'context') {
      const lastCtx = points[points.length - 1]?.value || 0;
      summaryBadge = isMultiCompare
        ? t('chart.step.peakTokens', { prefix: multiPrefix, tokens: formatTokens(maxVal) })
        : t('chart.step.currentCtx', { tokens: formatTokens(lastCtx) });
    } else if (metric === 'tps') {
      summaryBadge =
        validCount > 0
          ? t('chart.step.meanTps', {
              prefix: multiPrefix,
              val: (validSum / validCount).toFixed(1),
            })
          : t('chart.step.noValidSamples');
    } else if (metric === 'ttft') {
      summaryBadge =
        validCount > 0
          ? t('chart.step.meanSec', {
              prefix: multiPrefix,
              val: (validSum / validCount).toFixed(1),
            })
          : t('chart.step.noValidSamples');
    } else if (metric === 'cost') {
      summaryBadge = t('chart.step.sumCost', {
        prefix: multiPrefix,
        cost: formatUsd(runningCost, { precise: runningCost > 0 && runningCost < 0.1 }),
      });
    }

    lastPreSig = preSig;
    lastSummaryBadge = summaryBadge;
    return { summaryBadge };
  }

  return { el: rootEl, update, destroy };
}

/**
 * 创建学术论文风格散点回归与 95% 置信带拟合图（全宽 1:1 贴边对齐 + 项目统一冷蓝灰设计语言）：
 * - 全宽水平参考网格与底部线性步序刻度轴（内嵌左对齐 Y 轴刻度标签，零左右缩进留白）；
 * - 半透明冷蓝灰实心观测散点（自然呈现重叠密度）；
 * - 围绕回归曲线的 95% CI 置信区间阴影带（绝不向 y=0 做面积图填充）；
 * - 高斯局部线性回归曲线（LOESS, n >= 6）或精确线性回归（OLS, n <= 5），配相关系数 r 与拟合优度 R²。
 */
export function createModelFitChart() {
  const DEFAULT_VIEW_W = 460;
  const VIEW_H = 136;
  const TOP_Y = 16;
  const BOTTOM_Y = 116;
  const SPAN_Y = BOTTOM_Y - TOP_Y;

  let viewW = DEFAULT_VIEW_W;

  function formatTrendAmount(metric, value) {
    return metric === 'cache'
      ? t('chart.fit.percentPoints', { value: value.toFixed(1) })
      : formatChartMetricValue(metric, value);
  }

  function resolveFitBounds(w) {
    const plotLeft = 2;
    const plotRight = Math.max(plotLeft + 20, w - 2);
    return { plotLeft, plotRight, plotSpanX: plotRight - plotLeft };
  }

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${viewW} ${VIEW_H}`);
  svg.setAttribute('class', 'sstep-svg sstep-fit-svg');
  svg.setAttribute('aria-hidden', 'true');

  const gridGroup = document.createElementNS(SVG_NS, 'g');
  gridGroup.setAttribute('class', 'sstep-sci-grid');
  svg.appendChild(gridGroup);

  const axesGroup = document.createElementNS(SVG_NS, 'g');
  axesGroup.setAttribute('class', 'sstep-sci-axes');

  const multiBandGroup = document.createElementNS(SVG_NS, 'g');
  multiBandGroup.setAttribute('class', 'sstep-multi-band-group');
  svg.appendChild(multiBandGroup);

  const ciBandPath = document.createElementNS(SVG_NS, 'path');
  ciBandPath.setAttribute('class', 'sstep-ci-band');
  svg.appendChild(ciBandPath);

  const scatterGroup = document.createElementNS(SVG_NS, 'g');
  scatterGroup.setAttribute('class', 'sstep-scatter-group');
  svg.appendChild(scatterGroup);

  const multiCurveGroup = document.createElementNS(SVG_NS, 'g');
  multiCurveGroup.setAttribute('class', 'sstep-multi-curve-group');
  svg.appendChild(multiCurveGroup);

  const olsLine = document.createElementNS(SVG_NS, 'line');
  olsLine.setAttribute('class', 'sstep-ols-line');
  olsLine.setAttribute('hidden', 'true');
  svg.appendChild(olsLine);

  const fitPath = document.createElementNS(SVG_NS, 'path');
  fitPath.setAttribute('class', 'sstep-fit-line is-primary');
  fitPath.setAttribute('fill', 'none');
  svg.appendChild(fitPath);

  const fitAnomalyGroup = document.createElementNS(SVG_NS, 'g');
  fitAnomalyGroup.setAttribute('class', 'sstep-fit-anomaly-group');
  svg.appendChild(fitAnomalyGroup);

  // 坐标轴和刻度字放在点和曲线之上：刻度字自带底色描边，边缘小三角压上来时仍能看清
  svg.appendChild(axesGroup);

  const hoverLine = document.createElementNS(SVG_NS, 'line');
  hoverLine.setAttribute('class', 'trend-hover-line');
  hoverLine.setAttribute('y1', String(TOP_Y));
  hoverLine.setAttribute('y2', String(BOTTOM_Y));
  hoverLine.setAttribute('hidden', 'true');
  svg.appendChild(hoverLine);

  const hoverRawDot = document.createElementNS(SVG_NS, 'circle');
  hoverRawDot.setAttribute('r', '3.0');
  hoverRawDot.setAttribute('class', 'sstep-hover-raw-dot');
  hoverRawDot.setAttribute('hidden', 'true');
  svg.appendChild(hoverRawDot);

  const hoverFitDot = document.createElementNS(SVG_NS, 'circle');
  hoverFitDot.setAttribute('r', '3.1');
  hoverFitDot.setAttribute('class', 'trend-hover-dot');
  hoverFitDot.setAttribute('hidden', 'true');
  svg.appendChild(hoverFitDot);

  const emptyHintEl = h('div', {
    className: 'sstep-empty-hint text-muted',
    text: t('chart.fit.empty'),
    hidden: true,
  });

  const tipHeadLeft = h('span', { className: 'trend-tip-time text-mono' });
  const tipHeadRight = h('span', { className: 'trend-tip-calls text-mono' });
  const tipMainLeft = h('strong', { className: 'trend-tip-tokens text-mono' });
  const tipMainRight = h('span', { className: 'trend-tip-cost text-mono' });
  const tipSub = h('div', { className: 'trend-tip-sub text-mono', hidden: true });
  const tipAnomaly = h('div', { className: 'trend-tip-anomaly text-mono', hidden: true });
  const tooltipEl = h('div', { className: 'trend-tooltip', hidden: true }, [
    h('div', { className: 'trend-tip-head' }, [tipHeadLeft, tipHeadRight]),
    h('div', { className: 'trend-tip-main' }, [tipMainLeft, tipMainRight]),
    tipSub,
    tipAnomaly,
  ]);

  const fitMethodLabelEl = h('span', { text: t('chart.fit.loess') });
  const olsLegendTextEl = h('span', { text: t('chart.fit.olsLinear') });
  const olsLegendWrapEl = h('span', { className: 'sstep-fit-legend-ols', hidden: true }, [
    h('span', { className: 'sstep-fit-swatch is-ols' }),
    olsLegendTextEl,
  ]);
  const singleExtraLegend = [
    ['caret', 'chart.fit.outOfRange'],
    ['anomaly', 'chart.fit.legendAnomaly'],
    ['danger', 'chart.fit.legendAnomalyDanger'],
  ].map(([swatch, key]) => {
    const label = h('span');
    const wrap = h('span', { hidden: true }, [
      h('span', { className: `sstep-fit-swatch is-${swatch}` }),
      label,
    ]);
    return { wrap, label, key };
  });
  const obsLegendTextEl = h('span', { text: t('chart.fit.observed') });
  const singleLegendEl = h('span', { className: 'sstep-fit-legend' }, [
    h('span', { className: 'sstep-fit-swatch is-scatter' }),
    obsLegendTextEl,
    h('span', { className: 'sstep-fit-swatch is-curve' }),
    fitMethodLabelEl,
    h('span', { className: 'sstep-fit-swatch is-ci' }),
    h('span', { text: '95% CI' }),
    olsLegendWrapEl,
    ...singleExtraLegend.map(({ wrap }) => wrap),
  ]);
  const multiLegendEl = h('div', { className: 'sstep-model-legend', hidden: true });
  const fitStatsEl = h('span', { className: 'sstep-fit-delta text-mono text-muted' });

  const fitLegendFoot = h('div', { className: 'sstep-fit-foot' }, [
    singleLegendEl,
    multiLegendEl,
    fitStatsEl,
  ]);

  const plotStage = h('div', { className: 'sstep-plot-stage' }, [emptyHintEl, svg]);
  const rootEl = h('div', { className: 'sstep-chart-wrap' }, [plotStage, fitLegendFoot, tooltipEl]);

  let currentSamples = [];
  let currentMetric = 'tps';
  let hoveredIdx = -1;
  let lastFitPointer = null;
  let lastSig = '';
  let lastUpdateParams = null;
  let fitCacheMetric = '';
  const fitCache = new Map();
  const multiFitNodesByKey = new Map();

  const fitMorphCtrl = createFitGridMorphController();
  let lastFitMode = '';
  let lastSingleFitKey = '';
  const fitTooltipCtrl = createFloatingChartTooltipController({
    containerEl: rootEl,
    tooltipEl,
    defaultTipWidth: 216,
    defaultTipHeight: 82,
    defaultViewWidth: DEFAULT_VIEW_W,
    defaultViewHeight: VIEW_H,
  });

  function reusePublicationFit(key, xs, ys, maxVal, isMultiCompare) {
    const previous = fitCache.get(key);
    if (
      previous && previous.xs.length === xs.length &&
      xs.every((x, i) => x === previous.xs[i] && ys[i] === previous.ys[i])
    ) {
      return previous.result;
    }
    const result = computePublicationFit(xs, ys, {
      minVal: 0,
      maxVal,
      gridSize: isMultiCompare ? 56 : 64,
      span: 0.5,
    });
    fitCache.set(key, { xs, ys, result });
    return result;
  }

  function syncViewWidth() {
    const measured = Math.round(
      plotStage.clientWidth ||
        svg.clientWidth ||
        plotStage.getBoundingClientRect?.()?.width ||
        0
    );
    if (measured >= 160 && measured !== viewW) {
      viewW = measured;
      svg.setAttribute('viewBox', `0 0 ${viewW} ${VIEW_H}`);
      return true;
    }
    return false;
  }

  function showHoverAt(idx, pointer = null, { forceRefresh = false } = {}) {
    if (idx < 0 || idx >= currentSamples.length) {
      clearHover();
      return;
    }
    const wasHidden = tooltipEl.hasAttribute('hidden');
    const changedIdx = forceRefresh || wasHidden || idx !== hoveredIdx;
    hoveredIdx = idx;
    if (pointer) {
      lastFitPointer = pointer;
    }
    const sp = currentSamples[idx];
    const hasFit = sp.fitVal !== null;

    if (changedIdx) {
      patchAttr(hoverLine, 'hidden', false);
      patchAttr(hoverLine, 'x1', sp.x.toFixed(1));
      patchAttr(hoverLine, 'x2', sp.x.toFixed(1));

      patchAttr(hoverFitDot, 'hidden', !hasFit);
      if (hasFit) {
        patchAttr(hoverFitDot, 'cx', sp.x.toFixed(1));
        patchAttr(hoverFitDot, 'cy', sp.fitY.toFixed(1));
        patchStyleVar(hoverFitDot, '--hover-dot-color', sp.seriesColor || 'var(--accent-primary)');
      }

      patchAttr(hoverRawDot, 'hidden', false);
      patchAttr(hoverRawDot, 'cx', sp.x.toFixed(1));
      patchAttr(hoverRawDot, 'cy', sp.rawY.toFixed(1));
      patchClasses(hoverRawDot, {
        'is-anomaly': Boolean(sp.anomalySummary),
        'is-danger': Boolean(sp.anomalySummary && sp.anomalySeverity === 'danger'),
      });

      patchText(tipHeadLeft, sp.stepTag);
      patchText(tipHeadRight, sp.modelText);
      const observation = t('chart.fit.tipObs', { val: formatChartMetricValue(currentMetric, sp.rawVal) });
      patchText(
        tipMainLeft,
        hasFit ? t('chart.fit.tipFit', { val: formatChartMetricValue(currentMetric, sp.fitVal) }) : observation
      );
      patchText(tipMainRight, hasFit ? observation : '');

      patchAttr(tipSub, 'hidden', false);
      if (sp.compareHint) {
        patchText(tipSub, sp.compareHint);
      } else if (currentSamples.length >= 3 && sp.ciHalf > 0) {
        patchText(
          tipSub,
          `95% CI [${formatChartMetricCompact(currentMetric, sp.ciLow)}, ${formatChartMetricCompact(currentMetric, sp.ciHigh)}]`
        );
      } else {
        const ctxTok = Math.max(0, Number(sp.st?.contextTokens || 0));
        patchText(
          tipSub,
          t('chart.step.ctxAndCache', {
            ctxTok: formatTokens(ctxTok),
            pct: Number(sp.st?.cacheHitPct ?? 0),
          })
        );
      }
      patchAttr(tipAnomaly, 'hidden', !sp.anomalySummary);
      if (sp.anomalySummary) {
        patchText(tipAnomaly, sp.anomalySummary);
        patchClasses(tipAnomaly, { 'is-danger': sp.anomalySeverity === 'danger' });
      }
    }

    const wrapRect = fitTooltipCtrl.getWrapRect();
    const wrapW =
      wrapRect && wrapRect.width > 0
        ? wrapRect.width
        : Number(rootEl.clientWidth || viewW || DEFAULT_VIEW_W);
    const fallbackX = (sp.x / Math.max(1, viewW)) * wrapW;
    const fallbackY = sp.fitY + 4;
    fitTooltipCtrl.show({
      fallbackX,
      fallbackY,
      pointer: pointer || lastFitPointer,
      trackedDots: hasFit ? [hoverFitDot, hoverRawDot] : [hoverRawDot],
      viewWidth: viewW,
      viewHeight: VIEW_H,
      sizeKey: `${sp.anomalySummary ? 'fit:a' : 'fit:0'}${hasFit ? '' : ':obs'}`,
    });
  }

  function clearHover() {
    hoveredIdx = -1;
    lastFitPointer = null;
    fitTooltipCtrl.hide();
    patchAttr(hoverLine, 'hidden', true);
    patchAttr(hoverFitDot, 'hidden', true);
    patchAttr(hoverRawDot, 'hidden', true);
    patchClasses(hoverFitDot, { 'is-tracking': false });
    patchClasses(hoverRawDot, { 'is-tracking': false });
  }

  let cachedFitSvgRect = null;
  plotStage.addEventListener('mousemove', (e) => {
    if (!currentSamples.length) return;
    if (!cachedFitSvgRect) {
      cachedFitSvgRect = svg.getBoundingClientRect();
    }
    const rect = cachedFitSvgRect;
    if (!rect || rect.width <= 0) {
      cachedFitSvgRect = null;
      return;
    }
    const relX = ((e.clientX - rect.left) / rect.width) * viewW;
    let lo = 0;
    let hi = currentSamples.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (currentSamples[mid].x < relX) lo = mid + 1;
      else hi = mid;
    }
    let bestIdx = lo;
    if (
      lo > 0 &&
      Math.abs(currentSamples[lo - 1].x - relX) <= Math.abs(currentSamples[lo].x - relX)
    ) {
      bestIdx = lo - 1;
    }
    const pointer =
      Number.isFinite(Number(e?.clientX)) && Number.isFinite(Number(e?.clientY))
        ? { clientX: Number(e.clientX), clientY: Number(e.clientY) }
        : null;
    showHoverAt(bestIdx, pointer);
  });
  plotStage.addEventListener('mouseleave', () => {
    cachedFitSvgRect = null;
    fitTooltipCtrl.invalidateRects();
    clearHover();
  });

  let resizeObs = null;
  let onWinResize = null;
  if (typeof ResizeObserver === 'function') {
    resizeObs = new ResizeObserver(() => {
      cachedFitSvgRect = null;
      fitTooltipCtrl.invalidateRects();
      if (syncViewWidth() && lastUpdateParams) {
        lastSig = '';
        update({ ...lastUpdateParams, _skipMorph: true });
      }
    });
    resizeObs.observe(plotStage);
  } else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    onWinResize = () => {
      if (syncViewWidth() && lastUpdateParams) {
        lastSig = '';
        update({ ...lastUpdateParams, _skipMorph: true });
      }
    };
    window.addEventListener('resize', onWinResize);
  }

  function destroy() {
    fitMorphCtrl.cancel();
    fitTooltipCtrl.destroy();
    resizeObs?.disconnect();
    resizeObs = null;
    if (onWinResize && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('resize', onWinResize);
      onWinResize = null;
    }
  }

  /**
   * 在给定横坐标 x0 处对某模型的回归网格做线性插值（仅当 x0 位于该模型观测区间内时返回拟合值）。
   */
  function interpolateSeriesGridFit(grid, x0) {
    if (!Array.isArray(grid) || grid.length === 0) return null;
    if (grid.length === 1) {
      return Math.abs(grid[0].x - x0) < 1e-6 ? grid[0].fit : null;
    }
    const gMin = grid[0].x;
    const gMax = grid[grid.length - 1].x;
    if (x0 < gMin - 1e-6 || x0 > gMax + 1e-6) return null;
    if (x0 <= gMin) return grid[0].fit;
    if (x0 >= gMax) return grid[grid.length - 1].fit;
    for (let i = 0; i < grid.length - 1; i++) {
      const a = grid[i];
      const b = grid[i + 1];
      if (x0 >= a.x && x0 <= b.x) {
        const span = b.x - a.x;
        const t = span > 1e-9 ? (x0 - a.x) / span : 0;
        return a.fit + t * (b.fit - a.fit);
      }
    }
    return grid[grid.length - 1].fit;
  }

  /**
   * 绘制共享的水平网格线、底部步序坐标轴及左对齐内联 Y 轴刻度标签。
   */
  function renderFitAxesAndGrid({ yScale, mapY, mapX, xs, isSingle, plotLeft, plotRight, metric, showAgentPrefix }) {
    while (gridGroup.firstChild) gridGroup.removeChild(gridGroup.firstChild);
    while (axesGroup.firstChild) axesGroup.removeChild(axesGroup.firstChild);

    const xMin = xs[0];
    const xMax = xs[xs.length - 1];

    const xSpine = document.createElementNS(SVG_NS, 'line');
    xSpine.setAttribute('x1', '0');
    xSpine.setAttribute('y1', String(BOTTOM_Y));
    xSpine.setAttribute('x2', String(viewW));
    xSpine.setAttribute('y2', String(BOTTOM_Y));
    xSpine.setAttribute('class', 'sstep-axis-spine');
    axesGroup.appendChild(xSpine);

    for (const tv of yScale.ticks) {
      const ty = mapY(tv);
      if (Math.abs(ty - BOTTOM_Y) > 1.5) {
        const gLine = document.createElementNS(SVG_NS, 'line');
        gLine.setAttribute('x1', '0');
        gLine.setAttribute('y1', ty.toFixed(1));
        gLine.setAttribute('x2', String(viewW));
        gLine.setAttribute('y2', ty.toFixed(1));
        gridGroup.appendChild(gLine);
      }

      const labelEl = document.createElementNS(SVG_NS, 'text');
      labelEl.setAttribute('x', '0');
      labelEl.setAttribute('y', (ty - 3.5).toFixed(1));
      labelEl.setAttribute('text-anchor', 'start');
      labelEl.setAttribute('class', 'sstep-axis-label is-y-inline');
      labelEl.textContent = formatYAxisTick(metric, tv, yScale.step);
      axesGroup.appendChild(labelEl);
    }

    const xTickEntries = [];
    if (isSingle) {
      xTickEntries.push({
        xv: Math.round(xMin),
        tickX: mapX(xMin),
        labelX: mapX(xMin),
        anchor: 'middle',
      });
    } else {
      xTickEntries.push({
        xv: Math.round(xMin),
        tickX: plotLeft,
        labelX: 0,
        anchor: 'start',
      });
      const interiorTicks = computeNiceXStepTicks(xs);
      for (const xv of interiorTicks) {
        if (xv <= xMin || xv >= xMax) continue;
        const tx = mapX(xv);
        if (tx < plotLeft + 38 || tx > plotRight - 38) continue;
        xTickEntries.push({
          xv,
          tickX: tx,
          labelX: tx,
          anchor: 'middle',
        });
      }
      xTickEntries.push({
        xv: Math.round(xMax),
        tickX: plotRight,
        labelX: viewW,
        anchor: 'end',
      });
    }

    for (const xt of xTickEntries) {
      const tickMark = document.createElementNS(SVG_NS, 'line');
      tickMark.setAttribute('x1', xt.tickX.toFixed(1));
      tickMark.setAttribute('y1', String(BOTTOM_Y));
      tickMark.setAttribute('x2', xt.tickX.toFixed(1));
      tickMark.setAttribute('y2', (BOTTOM_Y + 3.2).toFixed(1));
      tickMark.setAttribute('class', 'sstep-axis-tick');
      axesGroup.appendChild(tickMark);

      const labelEl = document.createElementNS(SVG_NS, 'text');
      labelEl.setAttribute('x', xt.labelX.toFixed(1));
      labelEl.setAttribute('y', (BOTTOM_Y + 13.5).toFixed(1));
      labelEl.setAttribute('text-anchor', xt.anchor);
      labelEl.setAttribute('class', 'sstep-axis-label');
      labelEl.textContent = showAgentPrefix ? `${xt.xv}` : `#${xt.xv}`;
      axesGroup.appendChild(labelEl);
    }
  }

  /**
   * @param {{
   *   steps: Array<object>,
   *   modelGroupKey?: string,
   *   modelGroupKeys?: string[]|null,
   *   modelColorByGroup?: Map<string, string>|null,
   *   metric: 'tps'|'ttft'|'cache'|'cost',
   *   showAgentPrefix?: boolean,
   *   displaySettings?: object,
   * }} params
   * @returns {{ sampleCount: number, summaryBadge: string }}
   */
  function update({
    steps = [],
    modelGroupKey = '__all__',
    modelGroupKeys = null,
    modelColorByGroup = null,
    metric = 'tps',
    showAgentPrefix = false,
    displaySettings = {},
    _skipMorph = false,
  } = {}) {
    lastUpdateParams = {
      steps,
      modelGroupKey,
      modelGroupKeys,
      modelColorByGroup,
      metric,
      showAgentPrefix,
      displaySettings,
    };
    currentMetric = metric;
    syncViewWidth();

    patchStyleVar(rootEl, '--sstep-fit-accent', 'var(--ctx-cached)');

    const rawKeys =
      Array.isArray(modelGroupKeys) && modelGroupKeys.length > 0
        ? modelGroupKeys
        : [modelGroupKey || '__all__'];
    const isPooledAll = rawKeys.includes('__all__');
    const targetKeys = isPooledAll
      ? ['__all__']
      : Array.from(new Set(rawKeys.map((k) => String(k || '')).filter(Boolean)));
    const targetKeySet = new Set(targetKeys);
    const isMultiCompare = !isPooledAll && targetKeys.length >= 2;

    const matchedItems = [];
    let prevXVal = -Infinity;
    for (let idx = 0; idx < steps.length; idx++) {
      const st = steps[idx];
      if (!st || typeof st !== 'object') continue;
      let globalX = showAgentPrefix ? idx + 1 : Number(st.stepIndex ?? idx + 1);
      if (!Number.isFinite(globalX) || globalX <= prevXVal) {
        globalX = prevXVal === -Infinity ? idx + 1 : prevXVal + 1;
      }
      prevXVal = globalX;

      const gk = getStepModelGroupKey(st);
      if (!isPooledAll && !targetKeySet.has(gk)) {
        continue;
      }
      let valid = false;
      let rawVal = 0;
      if (metric === 'tps') {
        valid = !st.isCompactionStep && Number.isFinite(st.tokPerSec) && st.tokPerSec > 0;
        rawVal = valid ? Number(st.tokPerSec) : 0;
      } else if (metric === 'ttft') {
        valid = !st.isCompactionStep && Number.isFinite(st.ttftSec) && st.ttftSec >= 0;
        rawVal = valid ? Number(st.ttftSec) : 0;
      } else if (metric === 'cache') {
        valid = !st.isCompactionStep && Number.isFinite(st.cacheHitPct) && st.cacheHitPct >= 0;
        rawVal = valid ? Number(st.cacheHitPct) : 0;
      } else if (metric === 'cost') {
        valid = Number.isFinite(Number(st.costUsd)) && Number(st.costUsd) >= 0;
        rawVal = valid ? Number(st.costUsd) : 0;
      }
      if (valid) {
        const disp = resolveModelDisplayInfo(st, displaySettings, { fallback: '—' });
        matchedItems.push({
          st,
          gk,
          xVal: globalX,
          rawVal,
          stepTag: formatStepAxisTag(st, showAgentPrefix),
          modelText: disp.baseText || disp.text,
          anomalySummary: formatStepAnomalyInlineSummary(st.anomaly),
          anomalySeverity: st.anomaly?.severity || '',
        });
      }
    }

    const locale = getEffectiveLocale();
    patchText(emptyHintEl, t('chart.fit.empty'));
    patchText(obsLegendTextEl, t('chart.fit.observed'));
    patchText(olsLegendTextEl, t('chart.fit.olsLinear'));

    if (fitCacheMetric !== metric) {
      fitCache.clear();
      fitCacheMetric = metric;
    }
    for (const key of fitCache.keys()) {
      if (isMultiCompare ? !targetKeySet.has(key) : key !== null) fitCache.delete(key);
    }

    if (isMultiCompare || matchedItems.length === 0) {
      while (fitAnomalyGroup.firstChild) fitAnomalyGroup.removeChild(fitAnomalyGroup.firstChild);
      for (const { wrap } of singleExtraLegend) patchAttr(wrap, 'hidden', true);
    }

    if (matchedItems.length === 0) {
      fitCache.clear();
      fitMorphCtrl.reset();
      lastFitMode = '';
      lastSingleFitKey = '';
      currentSamples = [];
      lastSig = 'empty';
      patchAttr(ciBandPath, 'd', '');
      patchAttr(fitPath, 'd', '');
      patchAttr(olsLine, 'hidden', true);
      for (const nodes of multiFitNodesByKey.values()) {
        nodes.bandEl.remove();
        nodes.curveEl.remove();
      }
      while (gridGroup.firstChild) gridGroup.removeChild(gridGroup.firstChild);
      while (axesGroup.firstChild) axesGroup.removeChild(axesGroup.firstChild);
      while (scatterGroup.firstChild) scatterGroup.removeChild(scatterGroup.firstChild);
      patchAttr(singleLegendEl, 'hidden', false);
      patchAttr(multiLegendEl, 'hidden', true);
      patchAttr(emptyHintEl, 'hidden', false);
      patchText(fitMethodLabelEl, t('chart.fit.loess'));
      patchText(fitStatsEl, 'n = 0');
      patchAttr(fitStatsEl, 'title', '');
      clearHover();
      return { sampleCount: 0, summaryBadge: t('chart.fit.zeroSamples') };
    }

    patchAttr(emptyHintEl, 'hidden', true);
    const minBound = 0;
    const maxBound = metric === 'cache' ? 100 : Infinity;

    // 分支 A：多模型同图独立拟合曲线对比模式（勾选 >= 2 个模型）
    if (isMultiCompare) {
      const seriesList = [];
      for (let kIdx = 0; kIdx < targetKeys.length; kIdx++) {
        const key = targetKeys[kIdx];
        const items = matchedItems.filter((it) => it.gk === key);
        if (items.length === 0) continue;
        const xs = items.map((d) => d.xVal);
        const rawYs = items.map((d) => d.rawVal);
        const pubFit = reusePublicationFit(key, xs, rawYs, maxBound, true);
        const colorVar =
          modelColorByGroup?.get(key) || MODEL_COLOR_VARS[kIdx % MODEL_COLOR_VARS.length];
        seriesList.push({
          key,
          label: items[0].modelText || key,
          colorVar,
          items,
          xs,
          rawYs,
          pubFit,
        });
      }

      patchAttr(singleLegendEl, 'hidden', true);
      patchAttr(multiLegendEl, 'hidden', false);
      patchAttr(ciBandPath, 'd', '');
      patchAttr(fitPath, 'd', '');
      patchAttr(olsLine, 'hidden', true);

      const allXs = matchedItems.map((d) => d.xVal);
      let dataMin = Infinity;
      let dataMax = -Infinity;
      for (const s of seriesList) {
        for (const v of s.rawYs) {
          if (v < dataMin) dataMin = v;
          if (v > dataMax) dataMax = v;
        }
        for (const g of s.pubFit.grid) {
          if (g.ciLow < dataMin) dataMin = g.ciLow;
          if (g.ciHigh > dataMax) dataMax = g.ciHigh;
        }
      }

      const yScale = computeNiceYScale(dataMin, dataMax, {
        minBound,
        maxBound,
        tickCount: 4,
      });
      const yRange = Math.max(1e-9, yScale.max - yScale.min);
      const mapY = (v) =>
        BOTTOM_Y - ((clampValue(v, yScale.min, yScale.max) - yScale.min) / yRange) * SPAN_Y;

      const { plotLeft, plotRight, plotSpanX } = resolveFitBounds(viewW);
      const xMin = allXs[0];
      const xMax = allXs[allXs.length - 1];
      const isSingle = matchedItems.length === 1 || xMax - xMin <= 1e-9;
      const mapX = (xv) =>
        isSingle
          ? (plotLeft + plotRight) / 2
          : plotLeft + ((xv - xMin) / (xMax - xMin)) * plotSpanX;

      const combinedSamples = [];
      for (const s of seriesList) {
        const sSamples = s.items.map((item, i) => {
          const x = mapX(item.xVal);
          const rawY = mapY(item.rawVal);
          const fitVal = s.pubFit.sampleFits[i];
          const fitY = mapY(fitVal);
          const peerParts = [];
          for (const other of seriesList) {
            if (other.key === s.key) continue;
            const interp = interpolateSeriesGridFit(other.pubFit.grid, item.xVal);
            if (interp !== null) {
              peerParts.push(`${other.label} ${formatChartMetricCompact(metric, interp)}`);
            } else {
              peerParts.push(
                t('chart.fit.peerMean', {
                  label: other.label,
                  val: formatChartMetricCompact(metric, other.pubFit.mean),
                })
              );
            }
          }
          return {
            ...item,
            x,
            rawY,
            fitVal,
            fitY,
            ciLow: s.pubFit.sampleCiLow[i],
            ciHigh: s.pubFit.sampleCiHigh[i],
            ciHalf: s.pubFit.sampleCiHalf[i],
            seriesColor: s.colorVar,
            compareHint:
              peerParts.length > 0
                ? t('chart.fit.peerCompare', { peers: peerParts.join(' · ') })
                : '',
          };
        });
        s.samples = sSamples;
        combinedSamples.push(...sSamples);
      }
      combinedSamples.sort((a, b) => a.x - b.x || a.xVal - b.xVal);
      currentSamples = combinedSamples;

      const sig =
        `multi|${locale}|${viewW}|${targetKeys.join(',')}|${metric}|${showAgentPrefix}|${yScale.min.toFixed(4)}|${yScale.max.toFixed(4)}|` +
        seriesList
          .map(
            (s) =>
              `${s.key}:${s.colorVar}:` +
              s.samples
                .map(
                  (p) =>
                    `${p.xVal}:${p.rawVal.toFixed(3)}:${p.fitVal.toFixed(3)}:${p.st?.anomalySig || ''}`
                )
                .join(',')
          )
          .join('||');

      if (sig !== lastSig) {
        lastSig = sig;
        renderFitAxesAndGrid({
          yScale,
          mapY,
          mapX,
          xs: allXs,
          isSingle,
          plotLeft,
          plotRight,
          metric,
          showAgentPrefix,
        });

        while (scatterGroup.firstChild) scatterGroup.removeChild(scatterGroup.firstChild);

        const dotRadius =
          combinedSamples.length > 80 ? '1.8' : combinedSamples.length > 36 ? '2.1' : '2.4';
        const dedupOverdraw = combinedSamples.length > 200;
        const scatterTarget =
          typeof document.createDocumentFragment === 'function'
            ? document.createDocumentFragment()
            : scatterGroup;
        const anomalyOverlayDots = [];
        const activeFitKeys = new Set();
        const fitMorphItems = [];

        for (const s of seriesList) {
          const binCounts = dedupOverdraw ? new Map() : null;
          for (const sp of s.samples) {
            if (sp.anomalySummary) {
              anomalyOverlayDots.push(sp);
              continue;
            }
            if (binCounts) {
              const binKey = (Math.round(sp.x * 2) << 11) ^ Math.round(sp.rawY * 2);
              const prevCnt = binCounts.get(binKey) || 0;
              if (prevCnt >= 6) continue;
              binCounts.set(binKey, prevCnt + 1);
            }
            const dot = document.createElementNS(SVG_NS, 'circle');
            dot.setAttribute('cx', sp.x.toFixed(1));
            dot.setAttribute('cy', sp.rawY.toFixed(1));
            dot.setAttribute('r', dotRadius);
            dot.setAttribute('class', 'sstep-scatter-dot is-multi');
            patchStyleVar(dot, '--sstep-fit-accent', s.colorVar);
            scatterTarget.appendChild(dot);
          }

          activeFitKeys.add(s.key);
          let nodes = multiFitNodesByKey.get(s.key);
          if (!nodes) {
            const bandEl = document.createElementNS(SVG_NS, 'path');
            bandEl.setAttribute('class', 'sstep-ci-band is-multi');
            const curveEl = document.createElementNS(SVG_NS, 'path');
            curveEl.setAttribute('class', 'sstep-fit-line');
            curveEl.setAttribute('fill', 'none');
            nodes = { bandEl, curveEl };
            multiFitNodesByKey.set(s.key, nodes);
          }
          patchStyleVar(nodes.bandEl, '--sstep-fit-accent', s.colorVar);
          patchStyleVar(nodes.curveEl, '--sstep-fit-accent', s.colorVar);

          if (s.samples.length === 1) {
            const sp = s.samples[0];
            const segHalf = Math.min(12, plotSpanX * 0.04);
            const x1 = Math.max(plotLeft, sp.x - segHalf);
            const x2 = Math.min(plotRight, sp.x + segHalf);
            const yStr = sp.fitY.toFixed(1);
            const flatCurveD = `M ${x1.toFixed(1)} ${yStr} L ${x2.toFixed(1)} ${yStr}`;
            nodes.bandEl.setAttribute('d', '');
            nodes.bandEl.remove();
            multiCurveGroup.appendChild(nodes.curveEl);
            fitMorphItems.push({
              key: `multi:${s.key}`,
              gridPts: [
                { x: x1, fitY: sp.fitY, lowY: sp.fitY, highY: sp.fitY },
                { x: x2, fitY: sp.fitY, lowY: sp.fitY, highY: sp.fitY },
              ],
              curveEl: nodes.curveEl,
              bandEl: null,
              olsEl: null,
              olsCoords: null,
              finalCurveD: flatCurveD,
              finalBandD: '',
            });
          } else {
            const gridPts = s.pubFit.grid.map((g) => ({
              x: mapX(g.x),
              fitY: mapY(g.fit),
              lowY: mapY(g.ciLow),
              highY: mapY(g.ciHigh),
            }));

            let bandD = '';
            if (s.samples.length >= 3) {
              bandD = `M ${gridPts[0].x.toFixed(1)} ${gridPts[0].highY.toFixed(1)}`;
              for (let i = 1; i < gridPts.length; i++) {
                bandD += ` L ${gridPts[i].x.toFixed(1)} ${gridPts[i].highY.toFixed(1)}`;
              }
              for (let i = gridPts.length - 1; i >= 0; i--) {
                bandD += ` L ${gridPts[i].x.toFixed(1)} ${gridPts[i].lowY.toFixed(1)}`;
              }
              bandD += ' Z';
              multiBandGroup.appendChild(nodes.bandEl);
            } else {
              nodes.bandEl.setAttribute('d', '');
              nodes.bandEl.remove();
            }

            const curveD = buildPolylinePath(gridPts.map((p) => ({ x: p.x, y: p.fitY })));
            multiCurveGroup.appendChild(nodes.curveEl);
            fitMorphItems.push({
              key: `multi:${s.key}`,
              gridPts,
              curveEl: nodes.curveEl,
              bandEl: bandD ? nodes.bandEl : null,
              olsEl: null,
              olsCoords: null,
              finalCurveD: curveD,
              finalBandD: bandD,
            });
          }
        }

        for (const [k, nodes] of multiFitNodesByKey.entries()) {
          if (!activeFitKeys.has(k)) {
            nodes.bandEl.remove();
            nodes.curveEl.remove();
          }
        }
        if (lastFitMode === 'single') {
          const prevSingleGrid = fitMorphCtrl.getGrid('single');
          if (prevSingleGrid && prevSingleGrid.length > 0) {
            if (lastSingleFitKey && lastSingleFitKey !== '__all__') {
              fitMorphCtrl.seedGrid(`multi:${lastSingleFitKey}`, prevSingleGrid);
            } else {
              for (const s of seriesList) {
                fitMorphCtrl.seedGrid(`multi:${s.key}`, prevSingleGrid);
              }
            }
          }
        }
        lastFitMode = 'multi';
        lastSingleFitKey = '';
        fitMorphCtrl.morphFits({
          items: fitMorphItems,
          skipMorph: _skipMorph,
          allowBaselineEntry: true,
          bottomY: BOTTOM_Y,
        });
        anomalyOverlayDots.sort((a, b) =>
          a.anomalySeverity === 'danger' ? 1 : b.anomalySeverity === 'danger' ? -1 : 0
        );
        for (const sp of anomalyOverlayDots) {
          const aDot = document.createElementNS(SVG_NS, 'circle');
          aDot.setAttribute('cx', sp.x.toFixed(1));
          aDot.setAttribute('cy', sp.rawY.toFixed(1));
          aDot.setAttribute('r', dotRadius);
          aDot.setAttribute(
            'class',
            `sstep-scatter-dot is-anomaly${sp.anomalySeverity === 'danger' ? ' is-danger' : ''}`
          );
          scatterTarget.appendChild(aDot);
        }
        if (scatterTarget !== scatterGroup) {
          scatterGroup.appendChild(scatterTarget);
        }

        while (multiLegendEl.firstChild) multiLegendEl.removeChild(multiLegendEl.firstChild);
        for (const s of seriesList) {
          const swatch = h('span', { className: 'sstep-legend-line' });
          patchStyleVar(swatch, '--swatch-bg', s.colorVar);
          multiLegendEl.appendChild(
            h('span', { className: 'sstep-legend-item' }, [
              swatch,
              h('span', {
                text: `${s.label} (${formatChartMetricCompact(metric, s.pubFit.mean)})`,
              }),
            ])
          );
        }
      }

      const r2SummaryTitle = seriesList
        .map((s) => {
          const rSign = s.pubFit.r >= 0 ? '+' : '';
          return `${s.label}: n=${s.samples.length}, r=${rSign}${s.pubFit.r.toFixed(2)}, R²=${s.pubFit.r2.toFixed(2)}`;
        })
        .join(' | ');
      patchText(
        fitStatsEl,
        seriesList.length <= 2
          ? seriesList.map((s) => `R²=${s.pubFit.r2.toFixed(2)}`).join(' · ')
          : t('chart.fit.curvesCount', { count: seriesList.length })
      );
      patchAttr(fitStatsEl, 'title', r2SummaryTitle);

      if (hoveredIdx >= currentSamples.length) {
        clearHover();
      } else if (hoveredIdx >= 0) {
        showHoverAt(hoveredIdx, lastFitPointer, { forceRefresh: true });
      }

      return {
        sampleCount: combinedSamples.length,
        summaryBadge: t('chart.fit.multiBadge', {
          steps: combinedSamples.length,
          models: seriesList.length,
        }),
      };
    }

    // 分支 B：单模型或整体合并单曲线模式
    const nextSingleFitKey = isPooledAll ? '__all__' : targetKeys[0] || '__all__';
    if (lastFitMode === 'multi') {
      const seedGrid =
        fitMorphCtrl.getGrid(`multi:${nextSingleFitKey}`) || fitMorphCtrl.getFirstGrid();
      if (seedGrid && seedGrid.length > 0) {
        fitMorphCtrl.seedGrid('single', seedGrid);
      }
    }
    lastFitMode = 'single';
    lastSingleFitKey = nextSingleFitKey;
    for (const nodes of multiFitNodesByKey.values()) {
      nodes.bandEl.remove();
      nodes.curveEl.remove();
    }
    patchAttr(singleLegendEl, 'hidden', false);
    patchAttr(multiLegendEl, 'hidden', true);

    // 重试、断连会让这一步的速度和首字失真，只标出不参与拟合
    const normalItems = matchedItems.filter((item) => !item.anomalySummary);
    const fitItems = normalItems.length >= 3 ? normalItems : matchedItems;
    const fitXs = fitItems.map((item) => item.xVal);
    const fitYs = fitItems.map((item) => item.rawVal);
    const pubFit = reusePublicationFit(null, fitXs, fitYs, maxBound, false);
    const { grid } = pubFit;

    patchText(
      fitMethodLabelEl,
      pubFit.method === 'LOESS' ? t('chart.fit.loess') : t('chart.fit.olsReg')
    );
    // 按 3%–97% 分位定纵轴，少数离群点画成边缘小三角，避免整条趋势被压扁
    let dataMin = Infinity;
    let dataMax = -Infinity;
    if (fitItems.length >= 20) {
      const sortedYs = [...fitYs].sort((a, b) => a - b);
      const quantile = (p) => {
        const index = (sortedYs.length - 1) * p;
        const lo = Math.floor(index);
        return sortedYs[lo] + (index - lo) * (sortedYs[Math.ceil(index)] - sortedYs[lo]);
      };
      dataMin = quantile(0.03);
      dataMax = quantile(0.97);
    } else {
      for (const rawVal of fitYs) {
        if (rawVal < dataMin) dataMin = rawVal;
        if (rawVal > dataMax) dataMax = rawVal;
      }
    }
    for (const g of grid) {
      if (g.ciLow < dataMin) dataMin = g.ciLow;
      if (g.ciHigh > dataMax) dataMax = g.ciHigh;
    }

    const yScale = computeNiceYScale(dataMin, dataMax, {
      minBound,
      maxBound,
      tickCount: 4,
    });
    const yRange = Math.max(1e-9, yScale.max - yScale.min);
    const mapY = (v) =>
      BOTTOM_Y - ((clampValue(v, yScale.min, yScale.max) - yScale.min) / yRange) * SPAN_Y;

    const { plotLeft, plotRight, plotSpanX } = resolveFitBounds(viewW);
    const xs = matchedItems.map((item) => item.xVal);
    const xMin = xs[0];
    const xMax = xs[xs.length - 1];
    const isSingle = matchedItems.length === 1 || xMax - xMin <= 1e-9;
    const mapX = (xv) =>
      isSingle
        ? (plotLeft + plotRight) / 2
        : plotLeft + ((xv - xMin) / (xMax - xMin)) * plotSpanX;

    const gridMinX = grid[0].x;
    const gridMaxX = grid[grid.length - 1].x;
    let gridIdx = 0;
    const samples = matchedItems.map((item) => {
      const rawY = mapY(item.rawVal);
      let fitVal = null;
      let ciLow = null;
      let ciHigh = null;
      if (item.xVal >= gridMinX && item.xVal <= gridMaxX) {
        while (gridIdx < grid.length - 2 && item.xVal > grid[gridIdx + 1].x) gridIdx++;
        const a = grid[gridIdx];
        const b = grid[gridIdx + 1] || a;
        const frac = b.x > a.x ? clampValue((item.xVal - a.x) / (b.x - a.x), 0, 1) : 0;
        fitVal = a.fit + frac * (b.fit - a.fit);
        ciLow = a.ciLow + frac * (b.ciLow - a.ciLow);
        ciHigh = a.ciHigh + frac * (b.ciHigh - a.ciHigh);
      }
      return {
        ...item,
        x: mapX(item.xVal),
        rawY,
        fitVal,
        fitY: fitVal === null ? rawY : mapY(fitVal),
        ciLow,
        ciHigh,
        ciHalf: fitVal === null ? 0 : (ciHigh - ciLow) / 2,
        seriesColor: 'var(--accent-primary)',
        compareHint: '',
      };
    });
    currentSamples = samples;

    const sig =
      `single|${locale}|${viewW}|${targetKeys[0]}|${metric}|${showAgentPrefix}|${yScale.min.toFixed(4)}|${yScale.max.toFixed(4)}|` +
      samples
        .map(
          (s) => `${s.xVal}:${s.rawVal}:${s.anomalySummary ? s.anomalySeverity || 'anomaly' : ''}`
        )
        .join('|');

    if (sig !== lastSig) {
      lastSig = sig;
      renderFitAxesAndGrid({
        yScale,
        mapY,
        mapX,
        xs,
        isSingle,
        plotLeft,
        plotRight,
        metric,
        showAgentPrefix,
      });

      while (scatterGroup.firstChild) scatterGroup.removeChild(scatterGroup.firstChild);
      while (fitAnomalyGroup.firstChild) fitAnomalyGroup.removeChild(fitAnomalyGroup.firstChild);
      const dotRadius = samples.length > 80 ? '2.0' : samples.length > 36 ? '2.3' : '2.6';
      const binCounts = samples.length > 200 ? new Map() : null;
      const scatterTarget =
        typeof document.createDocumentFragment === 'function'
          ? document.createDocumentFragment()
          : scatterGroup;
      const singleAnomalyDots = [];
      let outOfRangeCount = 0;
      for (const s of samples) {
        if (s.anomalySummary) {
          singleAnomalyDots.push(s);
          continue;
        }
        const above = s.rawVal > yScale.max;
        if (above || s.rawVal < yScale.min) {
          const caret = document.createElementNS(SVG_NS, 'path');
          const tipY = above ? TOP_Y - 5 : BOTTOM_Y - 1;
          const baseY = above ? TOP_Y + 1 : BOTTOM_Y - 7;
          caret.setAttribute('class', 'sstep-outlier-caret');
          caret.setAttribute(
            'd',
            `M ${s.x.toFixed(1)} ${tipY} L ${(s.x - 3.5).toFixed(1)} ${baseY} L ${(s.x + 3.5).toFixed(1)} ${baseY} Z`
          );
          scatterTarget.appendChild(caret);
          outOfRangeCount++;
          continue;
        }
        if (binCounts) {
          const binKey = (Math.round(s.x * 2) << 11) ^ Math.round(s.rawY * 2);
          const prevCnt = binCounts.get(binKey) || 0;
          if (prevCnt >= 6) continue;
          binCounts.set(binKey, prevCnt + 1);
        }
        const dot = document.createElementNS(SVG_NS, 'circle');
        dot.setAttribute('cx', s.x.toFixed(1));
        dot.setAttribute('cy', s.rawY.toFixed(1));
        dot.setAttribute('r', dotRadius);
        dot.setAttribute('class', 'sstep-scatter-dot');
        scatterTarget.appendChild(dot);
      }
      singleAnomalyDots.sort((a, b) =>
        Number(a.anomalySeverity === 'danger') - Number(b.anomalySeverity === 'danger')
      );
      let dangerCount = 0;
      for (const s of singleAnomalyDots) {
        const isDanger = s.anomalySeverity === 'danger';
        if (isDanger) dangerCount++;
        const aDot = document.createElementNS(SVG_NS, 'circle');
        aDot.setAttribute('cx', s.x.toFixed(1));
        aDot.setAttribute('cy', s.rawY.toFixed(1));
        aDot.setAttribute('r', isDanger ? '3.4' : '3.2');
        aDot.setAttribute(
          'class',
          `sstep-scatter-dot is-anomaly${isDanger ? ' is-danger' : ''}`
        );
        fitAnomalyGroup.appendChild(aDot);
      }
      if (scatterTarget !== scatterGroup) {
        scatterGroup.appendChild(scatterTarget);
      }
      const legendCounts = [outOfRangeCount, singleAnomalyDots.length - dangerCount, dangerCount];
      singleExtraLegend.forEach(({ wrap, label, key }, i) => {
        const count = legendCounts[i];
        patchAttr(wrap, 'hidden', count === 0);
        if (count > 0) patchText(label, t(key, { count }));
      });

      if (isSingle) {
        const yVal = samples[0].fitY;
        const yStr = yVal.toFixed(1);
        const flatCurveD = `M ${plotLeft.toFixed(1)} ${yStr} L ${plotRight.toFixed(1)} ${yStr}`;
        patchAttr(ciBandPath, 'd', '');
        const flatGrid = Array.from({ length: 64 }, (_, gi) => ({
          x: plotLeft + (gi / 63) * plotSpanX,
          fitY: yVal,
          lowY: yVal,
          highY: yVal,
        }));
        fitMorphCtrl.morphFits({
          items: [
            {
              key: 'single',
              gridPts: flatGrid,
              curveEl: fitPath,
              bandEl: null,
              olsEl: null,
              olsCoords: null,
              finalCurveD: flatCurveD,
              finalBandD: '',
            },
          ],
          skipMorph: _skipMorph,
        });
      } else {
        const gridPts = grid.map((g) => ({
          x: mapX(g.x),
          fitY: mapY(g.fit),
          lowY: mapY(g.ciLow),
          highY: mapY(g.ciHigh),
        }));

        const curveD = buildPolylinePath(gridPts.map((p) => ({ x: p.x, y: p.fitY })));
        let bandD = '';
        if (fitItems.length >= 3) {
          bandD = `M ${gridPts[0].x.toFixed(1)} ${gridPts[0].highY.toFixed(1)}`;
          for (let i = 1; i < gridPts.length; i++) {
            bandD += ` L ${gridPts[i].x.toFixed(1)} ${gridPts[i].highY.toFixed(1)}`;
          }
          for (let i = gridPts.length - 1; i >= 0; i--) {
            bandD += ` L ${gridPts[i].x.toFixed(1)} ${gridPts[i].lowY.toFixed(1)}`;
          }
          bandD += ' Z';
        } else {
          patchAttr(ciBandPath, 'd', '');
        }

        fitMorphCtrl.morphFits({
          items: [
            {
              key: 'single',
              gridPts,
              curveEl: fitPath,
              bandEl: bandD ? ciBandPath : null,
              olsEl: null,
              olsCoords: null,
              finalCurveD: curveD,
              finalBandD: bandD,
            },
          ],
          skipMorph: _skipMorph,
        });
      }
    }

    const mean =
      fitItems.length === matchedItems.length
        ? pubFit.mean
        : matchedItems.reduce((sum, item) => sum + item.rawVal, 0) / matchedItems.length;
    const summaryBadge = t('chart.fit.singleBadge', {
      steps: samples.length,
      mean: formatChartMetricCompact(metric, mean),
    });
    if (fitItems.length >= 2) {
      const d = grid[grid.length - 1].fit - grid[0].fit;
      const sse = samples.reduce(
        (sum, s) => (fitItems === matchedItems || !s.anomalySummary ? sum + (s.rawVal - s.fitVal) ** 2 : sum),
        0
      );
      const sd = Math.sqrt(sse / Math.max(1, fitItems.length - 2));
      const formattedSd = formatTrendAmount(metric, sd);
      const delta = formatTrendAmount(metric, Math.abs(d));
      if (delta === formatTrendAmount(metric, 0) || Math.abs(d) < 0.25 * sd) {
        patchText(fitStatsEl, t('chart.fit.trendFlat', { sd: formattedSd }));
      } else {
        const rising = d > 0;
        const higherIsBetter = metric === 'tps' || metric === 'cache';
        patchText(
          fitStatsEl,
          t(rising ? 'chart.fit.trendRise' : 'chart.fit.trendFall', {
            delta,
            verdict: t(rising === higherIsBetter ? 'chart.fit.verdictBetter' : 'chart.fit.verdictWorse'),
            sd: formattedSd,
          })
        );
      }
      const rSign = pubFit.r >= 0 ? '+' : '';
      const slopeSign = pubFit.slope >= 0 ? '+' : '';
      const diagnostics = `r = ${rSign}${pubFit.r.toFixed(2)} · R² = ${pubFit.r2.toFixed(2)}`;
      patchAttr(
        fitStatsEl,
        'title',
        `${diagnostics} · ${t('chart.fit.olsTitle', {
          slope: `${slopeSign}${pubFit.slope.toFixed(3)}`,
          intercept: pubFit.intercept.toFixed(2),
          sd: pubFit.sd.toFixed(2),
        })}`
      );
    } else {
      patchText(fitStatsEl, `n = ${samples.length}`);
      patchAttr(fitStatsEl, 'title', '');
    }

    if (hoveredIdx >= samples.length) {
      clearHover();
    } else if (hoveredIdx >= 0) {
      showHoverAt(hoveredIdx, lastFitPointer, { forceRefresh: true });
    }

    return { sampleCount: samples.length, summaryBadge };
  }

  return { el: rootEl, update, destroy };
}
