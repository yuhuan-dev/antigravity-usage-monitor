/**
 * @fileoverview Reusable Decoupled Step Table Widget (`StepTableWidget.js`).
 * Powers both `StepsDetailView` ("按步查看") and `SettingsStructureTab` live preview,
 * dynamically rendering 2..12 columns via `stepColumnRegistry.js`, turn rail + prompt
 * preview tooltips, and independent Main/Sub agent badges.
 */

import { defineComponent } from '../../core/component.js';
import {
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchText,
} from '../../core/domPatch.js';
import {
  buildStepAnomalyDiagnostic,
  resolveModelDisplayInfo,
  speedReasonText,
} from '../../core/formatters.js';
import { getEffectiveLocale, t } from '../../i18n/index.js';
import {
  DEFAULT_STEP_COLUMN_KEYS,
  STEP_COLUMN_REGISTRY,
} from '../../registries/stepColumnRegistry.js';
import {
  formatAgentBadgeText,
  formatAgentLabel,
  getAgentBadgeClass,
  normalizeClientStepTokenComboFormat,
} from '../../store/telemetryStore.js';
import { parseStepTokenComboSegments } from '../../../shared/settings-normalization.mjs';

export function formatTurnPromptText(rawPrompt, { hasMedia = false, mediaOnly = false } = {}) {
  const text = String(rawPrompt || '').trim();
  if (mediaOnly || (!text && hasMedia)) return t('steps.turnMediaOnly');
  if (!text) return '';
  return hasMedia ? `${text} ${t('steps.turnMediaSuffix')}` : text;
}

const VIRTUAL_ROW_THRESHOLD = 80;
const VIRTUAL_OVERSCAN_ROWS = 16;
const VIRTUAL_REFILL_MARGIN = 6;
const MAX_ROW_POOL_SIZE = 96;
const FALLBACK_VIEWPORT_H = 560;
const BASE_SINGLE_ROW_H = 28;
const BASE_REASON_ROW_H = 42;
const SIZER_ROW_KEY = '__vsizer__';
const SPACER_TOP_KEY = '__vspacer_top__';
const SPACER_BOTTOM_KEY = '__vspacer_bottom__';

function estTokenChars(val) {
  const n = Math.max(0, Number(val || 0));
  if (n >= 1_000_000) return n >= 10_000_000 ? 6 : 5;
  if (n >= 100_000) return 6;
  if (n >= 10_000) return 5;
  if (n >= 1_000) return 4;
  if (n >= 100) return 3;
  if (n >= 10) return 2;
  return 1;
}

function estCostChars(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return 1;
  if (n >= 100) return 7;
  if (n >= 10) return 6;
  if (n >= 0.01) return 5;
  return 7;
}

function estSegmentChars(seg, st) {
  const inTok = Math.max(0, Number(st?.inputTokens || 0));
  const cacheTok = Math.max(0, Number(st?.cacheReadTokens || 0));
  const outTok = Math.max(0, Number(st?.outputTokens || 0));
  const thinkTok = Math.max(0, Number(st?.thinkingTokens || 0));
  const respTok =
    st?.responseTokens != null
      ? Math.max(0, Number(st.responseTokens))
      : Math.max(0, outTok - thinkTok);
  switch (seg) {
    case 'context':
      return estTokenChars(st?.contextTokens ?? inTok + cacheTok + outTok);
    case 'in':
      return estTokenChars(inTok);
    case 'out':
      return estTokenChars(outTok);
    case 'cache':
      return estTokenChars(cacheTok);
    case 'think':
      return estTokenChars(thinkTok);
    case 'reply':
      return estTokenChars(respTok);
    case 'total':
    default:
      return estTokenChars(inTok + cacheTok + outTok);
  }
}

function resolveBadgeTextForStep(st) {
  return formatAgentBadgeText({
    agentKind:
      st?.agentKind ||
      (!st?.isSubagent ? 'main' : st?.isSideQuestion ? 'side_question' : 'subagent'),
    agentOrdinal:
      st?.agentOrdinal || (st?.isSideQuestion ? st?.sideIndex || 0 : st?.agentIndex || 0),
    isMain: !st?.isSubagent,
    isSideQuestion: Boolean(st?.isSideQuestion),
    sideIndex: st?.sideIndex || 0,
    index: st?.agentIndex || 0,
    badgeText: st?.agentBadge,
  });
}

function buildColumnSizerSpec(tableSteps, colKeys, wantedSet, cellCtx) {
  const firstStep = tableSteps[0] || {};
  const colSteps = {};
  const needStep = wantedSet.has('step');
  const needTime = wantedSet.has('time');
  const needModel = wantedSet.has('model');
  const needTps = wantedSet.has('tps');
  const needTtft = wantedSet.has('ttft');
  const needDuration = wantedSet.has('duration');
  const needTokensCombo = wantedSet.has('tokens_combo');
  const needTokensIoCache = wantedSet.has('tokens_io_cache');
  const needTokensCustom = wantedSet.has('tokens_custom');
  const needInput = wantedSet.has('input_tokens');
  const needCacheTok = wantedSet.has('cache_tokens');
  const needOutput = wantedSet.has('output_tokens');
  const needCachePct = wantedSet.has('cache');
  const needCost = wantedSet.has('cost');
  const customSegs = needTokensCustom
    ? parseStepTokenComboSegments(cellCtx?.stepTokenComboFormat)
    : null;

  let bestStepNum = -1;
  let bestStepObj = firstStep;
  let bestTimeObj = null;
  const modelCandidates = needModel ? new Map() : null;
  let maxTpsVal = -1;
  let maxTpsObj = null;
  const reasonCandidates = needTps ? new Set() : null;
  let maxTtftVal = -1;
  let bestTtftObj = firstStep;
  let maxDurVal = -1;
  let bestDurObj = firstStep;
  let bestComboScore = -1;
  let bestComboObj = firstStep;
  let bestIoCacheScore = -1;
  let bestIoCacheObj = firstStep;
  let bestCustomScore = -1;
  let bestCustomObj = firstStep;
  let maxInputVal = -1;
  let bestInputObj = firstStep;
  let maxCacheTokVal = -1;
  let bestCacheTokObj = firstStep;
  let maxOutputVal = -1;
  let bestOutputObj = firstStep;
  let bestCachePctScore = -1;
  let bestCachePctObj = firstStep;
  let bestCostScore = -1;
  let bestCostObj = firstStep;

  let bestBadgeText = '';
  let bestBadgeClass = '';
  const badgeCandidates = cellCtx?.showAgentBadge ? new Set() : null;

  for (let i = 0; i < tableSteps.length; i++) {
    const st = tableSteps[i];
    if (!st || typeof st !== 'object') continue;

    if (badgeCandidates) {
      const bKey = `${st.agentKind || ''}|${st.isSubagent ? 1 : 0}|${st.isSideQuestion ? 1 : 0}|${st.agentOrdinal || 0}|${st.sideIndex || 0}|${st.agentIndex || 0}|${st.agentBadge || ''}`;
      if (!badgeCandidates.has(bKey)) {
        badgeCandidates.add(bKey);
        const text = resolveBadgeTextForStep(st);
        if (text.length > bestBadgeText.length) {
          bestBadgeText = text;
          bestBadgeClass = getAgentBadgeClass(st.agentIndex || 0, !st.isSubagent);
        }
      }
    }

    if (needStep) {
      const idxNum = Number(st.stepIndex) || 0;
      if (idxNum > bestStepNum) {
        bestStepNum = idxNum;
        bestStepObj = st;
      }
    }

    if (needTime && !bestTimeObj && Number(st.createdAtMs || 0) > 0) {
      bestTimeObj = st;
    }

    if (modelCandidates) {
      const mKey = `${st.baseModelShort || st.modelShort || ''}|${st.baseModelLabel || st.modelLabel || ''}|${st.rawModel || ''}|${st.isCompactionStep ? 1 : 0}`;
      if (!modelCandidates.has(mKey)) {
        modelCandidates.set(mKey, st);
      }
    }

    if (needTps) {
      const tpsVal = Number(st.tokPerSec);
      if (Number.isFinite(tpsVal) && tpsVal >= 0) {
        const tpsScore =
          (tpsVal >= 100 ? String(Math.round(tpsVal)).length : tpsVal.toFixed(1).length) * 1e6 +
          tpsVal;
        if (tpsScore > maxTpsVal) {
          maxTpsVal = tpsScore;
          maxTpsObj = st;
        }
      }
      if (st.selectedSpeedReason) {
        reasonCandidates.add(st.selectedSpeedReason);
      }
    }

    if (needTtft) {
      const v = Number(st.ttftSec);
      if (Number.isFinite(v) && v > maxTtftVal) {
        maxTtftVal = v;
        bestTtftObj = st;
      }
    }

    if (needDuration) {
      const v = Number(st.totalDurationSec ?? st.streamDurationSec);
      if (Number.isFinite(v) && v > maxDurVal) {
        maxDurVal = v;
        bestDurObj = st;
      }
    }

    if (needTokensCombo) {
      const inTok = Math.max(0, Number(st.inputTokens || 0));
      const cacheTok = Math.max(0, Number(st.cacheReadTokens || 0));
      const outTok = Math.max(0, Number(st.outputTokens || 0));
      const thinkTok = Math.max(0, Number(st.thinkingTokens || 0));
      const respTok =
        st.responseTokens != null
          ? Math.max(0, Number(st.responseTokens))
          : Math.max(0, outTok - thinkTok);
      const ctxTok = Math.max(0, Number(st.contextTokens ?? inTok + cacheTok + outTok));
      const score =
        (estTokenChars(ctxTok) + estTokenChars(thinkTok) + estTokenChars(respTok)) * 1e9 +
        ctxTok;
      if (score > bestComboScore) {
        bestComboScore = score;
        bestComboObj = st;
      }
    }

    if (needTokensIoCache) {
      const inTok = Math.max(0, Number(st.inputTokens || 0));
      const outTok = Math.max(0, Number(st.outputTokens || 0));
      const cacheTok = Math.max(0, Number(st.cacheReadTokens || 0));
      const score =
        (estTokenChars(inTok) + estTokenChars(outTok) + estTokenChars(cacheTok)) * 1e9 +
        cacheTok;
      if (score > bestIoCacheScore) {
        bestIoCacheScore = score;
        bestIoCacheObj = st;
      }
    }

    if (needTokensCustom && customSegs) {
      let chars = 0;
      for (let s = 0; s < customSegs.length; s++) {
        chars += estSegmentChars(customSegs[s], st);
      }
      if (chars > bestCustomScore) {
        bestCustomScore = chars;
        bestCustomObj = st;
      }
    }

    if (needInput) {
      const v = Math.max(0, Number(st.inputTokens || 0));
      const score = estTokenChars(v) * 1e9 + v;
      if (score > maxInputVal) {
        maxInputVal = score;
        bestInputObj = st;
      }
    }

    if (needCacheTok) {
      const v = Math.max(0, Number(st.cacheReadTokens || 0));
      const score = estTokenChars(v) * 1e9 + v;
      if (score > maxCacheTokVal) {
        maxCacheTokVal = score;
        bestCacheTokObj = st;
      }
    }

    if (needOutput) {
      const v = Math.max(0, Number(st.outputTokens || 0));
      const score = estTokenChars(v) * 1e9 + v;
      if (score > maxOutputVal) {
        maxOutputVal = score;
        bestOutputObj = st;
      }
    }

    if (needCachePct) {
      const pct = Number(st.cacheHitPct ?? 0);
      const hasDec = pct > 0 && pct < 100 && Math.abs(pct - Math.round(pct)) > 1e-6;
      const score = pct >= 100 ? 4 : hasDec ? (pct >= 10 ? 5 : 4) : pct >= 10 ? 3 : 2;
      if (score > bestCachePctScore) {
        bestCachePctScore = score;
        bestCachePctObj = st;
      }
    }

    if (needCost) {
      const c = Number(st.costUsd);
      const score = estCostChars(c) * 1e6 + (Number.isFinite(c) && c > 0 ? c : 0);
      if (score > bestCostScore) {
        bestCostScore = score;
        bestCostObj = st;
      }
    }
  }

  if (needStep) colSteps.step = bestStepObj;
  if (needTime) colSteps.time = bestTimeObj || firstStep;
  if (needModel && modelCandidates) {
    let bestModelLen = -1;
    let bestModelObj = firstStep;
    for (const cand of modelCandidates.values()) {
      const disp = resolveModelDisplayInfo(cand, cellCtx?.displaySettings, { fallback: '—' });
      const len = (disp.baseText?.length || 0) + (disp.compactionSuffix?.length || 0);
      if (len > bestModelLen) {
        bestModelLen = len;
        bestModelObj = cand;
      }
    }
    colSteps.model = bestModelObj;
  }
  if (needTps) {
    let longestReasonKey = null;
    let longestReasonLen = 0;
    if (reasonCandidates) {
      for (const rk of reasonCandidates) {
        const txt = speedReasonText(rk);
        if (txt && txt.length > longestReasonLen) {
          longestReasonLen = txt.length;
          longestReasonKey = rk;
        }
      }
    }
    colSteps.tps = {
      ...(maxTpsObj || firstStep),
      tokPerSec: maxTpsVal > 0 ? maxTpsVal : firstStep.tokPerSec,
      selectedSpeedReason: longestReasonKey,
    };
  }
  if (needTtft) colSteps.ttft = bestTtftObj;
  if (needDuration) colSteps.duration = bestDurObj;
  if (needTokensCombo) colSteps.tokens_combo = bestComboObj;
  if (needTokensIoCache) colSteps.tokens_io_cache = bestIoCacheObj;
  if (needTokensCustom) colSteps.tokens_custom = bestCustomObj;
  if (needInput) colSteps.input_tokens = bestInputObj;
  if (needCacheTok) colSteps.cache_tokens = bestCacheTokObj;
  if (needOutput) colSteps.output_tokens = bestOutputObj;
  if (needCachePct) colSteps.cache = bestCachePctObj;
  if (needCost) colSteps.cost = bestCostObj;

  const sigParts = colKeys.map((colKey) => {
    const st = colSteps[colKey] || firstStep;
    return `${colKey}=${STEP_COLUMN_REGISTRY[colKey].sigPart(st, cellCtx)}`;
  });
  return {
    colSteps,
    badgeText: bestBadgeText,
    badgeClass: bestBadgeClass,
    sig: `sizer:${bestBadgeText}:${sigParts.join('|')}`,
  };
}

export const StepTableWidget = defineComponent({
  name: 'StepTableWidget',
  setup({ props, onCleanup }) {
    const standalone = Boolean(props.standalone);
    const interactiveBadges = props.interactiveBadges !== false;
    const onSelectAgentScopes =
      typeof props.onSelectAgentScopes === 'function' ? props.onSelectAgentScopes : null;
    const onVirtualHeightChange =
      typeof props.onVirtualHeightChange === 'function' ? props.onVirtualHeightChange : null;

    const stepsTheadRow = h('tr');
    const stepsThead = h('thead', {}, [stepsTheadRow]);
    const stepsTbody = h('tbody');

    function syncTableHeaderColumns(colKeys, headerCtx = {}) {
      const locale = getEffectiveLocale();
      const fmtKey = normalizeClientStepTokenComboFormat(headerCtx?.stepTokenComboFormat);
      const ctx = { stepTokenComboFormat: fmtKey };
      patchKeyedList(stepsTheadRow, colKeys, {
        keyFn: (colKey) => colKey,
        sigFn: (colKey) => `${locale}:${colKey}:${fmtKey}:${STEP_COLUMN_REGISTRY[colKey].thLabel(ctx)}`,
        createRow: (colKey) => {
          const th = h('th', { text: STEP_COLUMN_REGISTRY[colKey].thLabel(ctx) });
          return { el: th, refs: { th } };
        },
        updateRow: (refs, colKey) => {
          patchText(refs.th, STEP_COLUMN_REGISTRY[colKey].thLabel(ctx));
        },
      });
    }

    syncTableHeaderColumns(DEFAULT_STEP_COLUMN_KEYS);

    const stepsTableEl = h('table', { className: 'data-table steps-data-table' }, [
      stepsThead,
      stepsTbody,
    ]);
    const stepsTablePane = h('div', { className: 'table-viewport is-step-table' }, [stepsTableEl]);

    const turnTipEl = h('div', {
      className: 'turn-prompt-tip',
      role: 'tooltip',
      hidden: true,
    });
    const hideTurnTip = () => patchAttr(turnTipEl, 'hidden', true);

    const anomalyTipTitleEl = h('div', { className: 'step-anomaly-tip-title' });
    const anomalyTipSubEl = h('div', { className: 'step-anomaly-tip-sub text-mono', hidden: true });
    const anomalyTipHeadEl = h('div', { className: 'step-anomaly-tip-head' }, [
      anomalyTipTitleEl,
      anomalyTipSubEl,
    ]);
    const anomalyTipListEl = h('div', { className: 'step-anomaly-tip-list' });
    const anomalyTipHintEl = h('div', { className: 'step-anomaly-tip-hint', hidden: true });
    const anomalyTipEl = h(
      'div',
      {
        className: 'step-anomaly-tip',
        role: 'tooltip',
        hidden: true,
      },
      [anomalyTipHeadEl, anomalyTipListEl, anomalyTipHintEl]
    );
    const hideAnomalyTip = () => patchAttr(anomalyTipEl, 'hidden', true);

    const standaloneHostEl = standalone
      ? h('div', { className: 'step-table-preview-host' }, [
          stepsTablePane,
          turnTipEl,
          anomalyTipEl,
        ])
      : null;

    let boundsContainerGetter =
      typeof props.getBoundsEl === 'function'
        ? props.getBoundsEl
        : () => standaloneHostEl || stepsTablePane;

    function setBoundsElGetter(fn) {
      if (typeof fn === 'function') {
        boundsContainerGetter = fn;
      }
    }

    function positionFloatingTip(tipEl, anchorEl) {
      const boundsEl = boundsContainerGetter?.();
      if (
        !boundsEl ||
        typeof boundsEl.getBoundingClientRect !== 'function' ||
        typeof anchorEl?.getBoundingClientRect !== 'function'
      ) {
        return;
      }
      const panelRect = boundsEl.getBoundingClientRect();
      const anchorRect = anchorEl.getBoundingClientRect();
      if (!(panelRect.width > 0 && panelRect.height > 0)) return;
      const tipH = tipEl.offsetHeight || 56;
      const tipW = tipEl.offsetWidth || 220;
      const placeAbove =
        panelRect.bottom - anchorRect.bottom < tipH + 10 &&
        anchorRect.top - panelRect.top > tipH + 6;
      const topPx = placeAbove
        ? Math.max(4, Math.round(anchorRect.top - panelRect.top - tipH - 5))
        : Math.round(anchorRect.bottom - panelRect.top + 5);
      const maxLeft = Math.max(6, Math.round(panelRect.width - tipW - 8));
      const leftPx = Math.min(
        maxLeft,
        Math.max(6, Math.round(anchorRect.left - panelRect.left))
      );
      tipEl.style.top = `${topPx}px`;
      tipEl.style.left = `${leftPx}px`;
    }

    function showTurnTip(anchorCell, promptText) {
      const text = String(promptText || '').trim();
      if (!anchorCell || !text) {
        hideTurnTip();
        return;
      }
      hideAnomalyTip();
      patchText(turnTipEl, text);
      patchAttr(turnTipEl, 'hidden', false);
      positionFloatingTip(turnTipEl, anchorCell);
    }

    function showAnomalyTip(anchorEl, diag) {
      if (!anchorEl || !diag || !diag.title) {
        hideAnomalyTip();
        return;
      }
      hideTurnTip();
      patchClasses(anomalyTipEl, { 'is-danger': diag.severity === 'danger' });
      patchText(anomalyTipTitleEl, diag.title);
      patchAttr(anomalyTipSubEl, 'hidden', !diag.sub);
      if (diag.sub) patchText(anomalyTipSubEl, diag.sub);

      while (anomalyTipListEl.firstChild) {
        anomalyTipListEl.removeChild(anomalyTipListEl.firstChild);
      }
      const rows = Array.isArray(diag.rows) ? diag.rows : [];
      for (const row of rows) {
        const lineEl = h('div', {
          className: `step-anomaly-tip-row${row.danger ? ' is-danger' : ''}`,
          text: row.text,
        });
        const itemChildren = [lineEl];
        if (row.detail) {
          itemChildren.push(
            h('div', {
              className: 'step-anomaly-tip-detail text-mono',
              text: row.detail,
            })
          );
        }
        anomalyTipListEl.appendChild(h('div', { className: 'step-anomaly-tip-item' }, itemChildren));
      }
      patchAttr(anomalyTipListEl, 'hidden', rows.length === 0);

      patchAttr(anomalyTipHintEl, 'hidden', !diag.hint);
      if (diag.hint) patchText(anomalyTipHintEl, diag.hint);

      patchAttr(anomalyTipEl, 'hidden', false);
      positionFloatingTip(anomalyTipEl, anchorEl);
    }

    const hoverRows = new WeakMap();
    let lastRenderedRows = null;
    let lastRenderOptions = '';
    let trackedCascadeId = null;
    let lastAbsorbedAllSteps = null;
    const seenStepKeys = new Set();
    const maxSeenStepByAgent = new Map();
    const activeEnterTimers = new Map();

    // Virtualization state (activates transparently only when !standalone && rowCount > 80)
    let activeDataset = null;
    let renderedSliceStart = -1;
    let renderedSliceEnd = -1;
    let renderedTopSpacerH = -1;
    let renderedBottomSpacerH = -1;
    let scrollRafId = 0;
    let calibrateRafId = 0;
    let lastFontScale = 1;
    let calibratedSingleRowH = 0;
    let calibratedReasonRowH = 0;
    const rowPool = [];

    function readUiFontScale() {
      try {
        if (typeof getComputedStyle === 'function') {
          const target =
            stepsTableEl || (typeof document !== 'undefined' ? document.documentElement : null);
          if (target) {
            const raw = getComputedStyle(target)?.getPropertyValue?.('--ui-font-scale');
            const parsed = Number.parseFloat(raw);
            if (Number.isFinite(parsed) && parsed >= 0.5 && parsed <= 2.5) {
              return parsed;
            }
          }
        }
      } catch {
        // Fallback to default scale in headless/mock environments.
      }
      return 1;
    }

    function getEstRowHeights() {
      const single =
        calibratedSingleRowH > 0
          ? calibratedSingleRowH
          : Math.round(BASE_SINGLE_ROW_H * lastFontScale);
      const reason =
        calibratedReasonRowH > 0
          ? calibratedReasonRowH
          : Math.round(BASE_REASON_ROW_H * lastFontScale);
      return { single, reason };
    }

    function buildRowTops(n, hasReasonFlags) {
      const { single, reason } = getEstRowHeights();
      const tops = new Float64Array(n + 1);
      let acc = 0;
      for (let i = 0; i < n; i++) {
        tops[i] = acc;
        acc += hasReasonFlags && hasReasonFlags[i] ? reason : single;
      }
      tops[n] = acc;
      return { rowTops: tops, totalBodyH: acc };
    }

    function findRowIndexAtOffset(rowTops, n, offset) {
      if (n <= 0 || offset <= 0) return 0;
      if (offset >= rowTops[n - 1]) return n - 1;
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >>> 1;
        if (rowTops[mid] <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    }

    function syncFontScaleIfChanged() {
      const nextScale = readUiFontScale();
      if (Math.abs(nextScale - lastFontScale) < 0.005) return false;
      lastFontScale = nextScale;
      calibratedSingleRowH = 0;
      calibratedReasonRowH = 0;
      if (activeDataset?.isVirtualized) {
        const rebuilt = buildRowTops(activeDataset.tableSteps.length, activeDataset.hasReasonFlags);
        activeDataset.rowTops = rebuilt.rowTops;
        activeDataset.totalBodyH = rebuilt.totalBodyH;
      }
      return true;
    }

    function getStepRowIdentity(st, fallbackCascadeId) {
      const agentKey = String(st?.agentCascadeId || fallbackCascadeId || 'conv');
      const stepNum = Number(st?.stepIndex);
      const rowKey = `${agentKey}-${st?.stepIndex}`;
      return { agentKey, stepNum, rowKey };
    }

    function absorbStepsIntoBaseline(stepList, fallbackCascadeId) {
      if (!Array.isArray(stepList)) return;
      for (const st of stepList) {
        if (!st || typeof st !== 'object') continue;
        const { agentKey, stepNum, rowKey } = getStepRowIdentity(st, fallbackCascadeId);
        seenStepKeys.add(rowKey);
        if (Number.isFinite(stepNum)) {
          const prevMax = maxSeenStepByAgent.get(agentKey);
          if (prevMax === undefined || stepNum > prevMax) {
            maxSeenStepByAgent.set(agentKey, stepNum);
          }
        }
      }
    }

    function clearRowEnterState(tr) {
      if (!tr) return;
      const timer = activeEnterTimers.get(tr);
      if (timer) {
        clearTimeout(timer);
        activeEnterTimers.delete(tr);
      }
      tr.onanimationend = null;
      patchClasses(tr, { 'is-step-entering': false });
    }

    function enterStepCell(event) {
      const { badge, prompt } = hoverRows.get(this);
      if (event?.target === badge) hideTurnTip();
      else showTurnTip(this, prompt);
    }

    function moveInStepCell(event) {
      const { badge } = hoverRows.get(this);
      if (event?.target === badge) hideTurnTip();
    }

    function moveAlongTurnRail(event) {
      const { badge, prompt, anomalyStep } = hoverRows.get(this);
      const rect = this.getBoundingClientRect?.();
      const relX = rect ? (event?.clientX ?? 0) - rect.left : 0;
      if (event?.target !== badge && relX <= 18) {
        showTurnTip(this, prompt);
      } else {
        hideTurnTip();
        if (anomalyStep) {
          showAnomalyTip(this, buildStepAnomalyDiagnostic(anomalyStep));
        }
      }
    }

    function leaveStepCell(event) {
      const entry = hoverRows.get(this);
      hideTurnTip();
      if (entry?.anomalyStep && entry.tr && event?.relatedTarget && entry.tr.contains?.(event.relatedTarget)) {
        showAnomalyTip(this, buildStepAnomalyDiagnostic(entry.anomalyStep));
      }
    }

    function clearCellHover(cell) {
      if (!cell || !hoverRows.delete(cell)) return;
      cell.onmouseenter = null;
      cell.onmousemove = null;
      cell.onmouseleave = null;
    }

    function calibrateRowHeights() {
      calibrateRafId = 0;
      if (!activeDataset?.isVirtualized) return;
      if (Number(stepsTablePane.clientHeight || 0) <= 0) return;
      const needSingle = calibratedSingleRowH <= 0;
      const needReason = calibratedReasonRowH <= 0 && activeDataset.hasAnyReason;
      if (!needSingle && !needReason) return;

      let measuredSingle = 0;
      let measuredReason = 0;
      // Measure contiguous run of normal rows to eliminate single-row subpixel/border-collapse drift.
      let runStartTop = 0;
      let runEndBottom = 0;
      let runCount = 0;
      let bestRunStride = 0;
      let bestRunCount = 0;

      const children = stepsTbody.children || [];
      for (let i = 0; i < children.length; i++) {
        const tr = children[i];
        if (!tr || tr.classList?.contains('step-vspacer') || tr.classList?.contains('step-vsizer')) {
          runCount = 0;
          continue;
        }
        const isReason = tr.dataset?.hasReason === '1';
        if (!isReason && needSingle) {
          const rect = tr.getBoundingClientRect?.();
          const hVal = Number(rect?.height || tr.offsetHeight || 0);
          if (hVal >= 14 && hVal <= 120) {
            if (!measuredSingle) measuredSingle = hVal;
            if (rect && Number.isFinite(rect.top) && Number.isFinite(rect.bottom) && rect.bottom > rect.top) {
              if (runCount === 0) {
                runStartTop = rect.top;
              }
              runEndBottom = rect.bottom;
              runCount += 1;
              if (runCount > bestRunCount && runCount >= 2) {
                const stride = (runEndBottom - runStartTop) / runCount;
                if (stride >= 14 && stride <= 120) {
                  bestRunCount = runCount;
                  bestRunStride = stride;
                }
              }
            }
          }
        } else {
          runCount = 0;
          if (isReason && needReason && !measuredReason) {
            const hVal = Number(tr.getBoundingClientRect?.()?.height || tr.offsetHeight || 0);
            if (hVal >= 18 && hVal <= 160) measuredReason = hVal;
          }
        }
        if ((!needSingle || bestRunCount >= 12) && (!needReason || measuredReason > 0)) {
          break;
        }
      }

      if (bestRunStride > 0) {
        measuredSingle = bestRunStride;
      }

      let changed = false;
      if (measuredSingle > 0) {
        const prev = getEstRowHeights().single;
        calibratedSingleRowH = measuredSingle;
        if (Math.abs(measuredSingle - prev) >= 0.25) changed = true;
      }
      if (measuredReason > 0) {
        const prev = getEstRowHeights().reason;
        calibratedReasonRowH = measuredReason;
        if (Math.abs(measuredReason - prev) >= 0.25) changed = true;
      }

      if (changed && activeDataset) {
        const prevTops = activeDataset.rowTops;
        const anchorIdx = renderedSliceStart > 0 ? renderedSliceStart : 0;
        const prevAnchorTop = prevTops ? prevTops[anchorIdx] : 0;
        const rebuilt = buildRowTops(activeDataset.tableSteps.length, activeDataset.hasReasonFlags);
        activeDataset.rowTops = rebuilt.rowTops;
        activeDataset.totalBodyH = rebuilt.totalBodyH;
        const curScrollTop = Number(stepsTablePane.scrollTop || 0);
        if (anchorIdx > 0 && curScrollTop > 0) {
          const delta = rebuilt.rowTops[anchorIdx] - prevAnchorTop;
          if (Math.abs(delta) >= 0.5) {
            stepsTablePane.scrollTop = Math.max(0, curScrollTop + delta);
          }
        }
        renderCurrentWindow({ force: true, enteringRowKeys: null });
        onVirtualHeightChange?.();
      }
    }

    function scheduleCalibrateRowHeights() {
      if (!activeDataset?.isVirtualized) return;
      const needSingle = calibratedSingleRowH <= 0;
      const needReason = calibratedReasonRowH <= 0 && activeDataset.hasAnyReason;
      if (!needSingle && !needReason) return;
      if (calibrateRafId) return;
      if (typeof requestAnimationFrame === 'function') {
        calibrateRafId = requestAnimationFrame(calibrateRowHeights);
      } else {
        calibrateRowHeights();
      }
    }

    function renderCurrentWindow({ force = false, enteringRowKeys = null } = {}) {
      const ds = activeDataset;
      if (!ds) return;
      const {
        tableSteps,
        cascadeId,
        colKeys,
        wantedSet,
        colOrderSig,
        locale,
        cellCtx,
        railActive,
        showAgentBadge,
        showStepTurnRail,
        useRootTurn,
        isVirtualized,
        hasReasonFlags,
        rowTops,
        totalBodyH,
        sizerSpec,
        effectiveScopes,
        formattedPrompts,
      } = ds;

      const n = tableSteps.length;
      let startIdx = 0;
      let endIdx = n;
      let topSpacerH = 0;
      let bottomSpacerH = 0;

      if (isVirtualized) {
        const scrollTop = Math.max(0, Number(stepsTablePane.scrollTop || 0));
        const rawClientH = Number(stepsTablePane.clientHeight || 0);
        const viewportH = rawClientH > 0 ? rawClientH : FALLBACK_VIEWPORT_H;
        const rawTheadH = Number(
          stepsThead.offsetHeight || stepsThead.getBoundingClientRect?.()?.height || 0
        );
        const theadH = rawTheadH > 0 ? rawTheadH : getEstRowHeights().single;
        const viewTop = Math.max(0, scrollTop - theadH);
        const viewBottom = viewTop + viewportH;
        const firstVis = findRowIndexAtOffset(rowTops, n, viewTop);
        const lastVis = findRowIndexAtOffset(rowTops, n, viewBottom);

        if (
          !force &&
          renderedSliceStart >= 0 &&
          renderedSliceEnd > renderedSliceStart &&
          renderedSliceEnd <= n
        ) {
          const topSafe =
            renderedSliceStart === 0 || firstVis - renderedSliceStart >= VIRTUAL_REFILL_MARGIN;
          const bottomSafe =
            renderedSliceEnd === n || renderedSliceEnd - 1 - lastVis >= VIRTUAL_REFILL_MARGIN;
          if (topSafe && bottomSafe) {
            return;
          }
        }

        startIdx = Math.max(0, firstVis - VIRTUAL_OVERSCAN_ROWS);
        endIdx = Math.min(n, lastVis + 1 + VIRTUAL_OVERSCAN_ROWS);
        topSpacerH = +rowTops[startIdx].toFixed(2);
        bottomSpacerH = +Math.max(0, totalBodyH - rowTops[endIdx]).toFixed(2);

        if (
          !force &&
          startIdx === renderedSliceStart &&
          endIdx === renderedSliceEnd &&
          topSpacerH === renderedTopSpacerH &&
          bottomSpacerH === renderedBottomSpacerH
        ) {
          return;
        }
      }

      const getStepTurnIdx = (st) =>
        useRootTurn ? (st?.rootTurnIndex ?? st?.turnIndex) : st?.turnIndex;
      const getStepIsStart = (st) =>
        Boolean(useRootTurn ? (st?.isRootTurnStart ?? st?.isTurnStart) : st?.isTurnStart);
      const getStepIsLatest = (st) =>
        Boolean(useRootTurn ? (st?.isRootLatestTurn ?? st?.isLatestTurn) : st?.isLatestTurn);
      const getStepPrompt = (st) =>
        (useRootTurn
          ? (st?.rootTurnPromptClean ?? st?.rootTurnPrompt ?? st?.turnPromptClean ?? st?.turnPrompt)
          : (st?.turnPromptClean ?? st?.turnPrompt)) || '';
      const getStepHasMedia = (st) =>
        Boolean(useRootTurn ? (st?.rootTurnHasMedia ?? st?.turnHasMedia) : st?.turnHasMedia);
      const getStepMediaOnly = (st) =>
        Boolean(useRootTurn ? (st?.rootTurnMediaOnly ?? st?.turnMediaOnly) : st?.turnMediaOnly);

      function getTurnKeyAt(idx) {
        if (!showStepTurnRail || idx < 0 || idx >= n) return '';
        const st = tableSteps[idx];
        const tIdx = getStepTurnIdx(st);
        if (!Number.isInteger(tIdx) || tIdx <= 0) return '';
        return useRootTurn ? `root:${tIdx}` : `${st?.agentId || 'main'}:${tIdx}`;
      }

      function formattedTurnPrompt(st) {
        const raw = getStepPrompt(st);
        const hasMedia = getStepHasMedia(st);
        const mediaOnly = getStepMediaOnly(st);
        const cacheKey = `${mediaOnly ? 2 : hasMedia ? 1 : 0}:${raw}`;
        if (!formattedPrompts.has(cacheKey)) {
          formattedPrompts.set(cacheKey, formatTurnPromptText(raw, { hasMedia, mediaOnly }));
        }
        return formattedPrompts.get(cacheKey);
      }

      const windowItems = [];
      if (isVirtualized && sizerSpec) {
        windowItems.push({
          isSizer: true,
          isSpacer: false,
          rowKey: SIZER_ROW_KEY,
          sizerSpec,
        });
      }
      if (isVirtualized && topSpacerH > 0) {
        windowItems.push({
          isSizer: false,
          isSpacer: true,
          rowKey: SPACER_TOP_KEY,
          height: topSpacerH,
          colSpan: colKeys.length,
        });
      }

      for (let idx = startIdx; idx < endIdx; idx++) {
        const st = tableSteps[idx];
        const tKey = getTurnKeyAt(idx);
        const hasTurn = Boolean(tKey);
        const hasUp = hasTurn && getTurnKeyAt(idx - 1) === tKey;
        const hasDown = hasTurn && getTurnKeyAt(idx + 1) === tKey;
        windowItems.push({
          isSizer: false,
          isSpacer: false,
          st,
          logicalIdx: idx,
          isStripeEven: (idx & 1) === 1,
          hasReason: Boolean(hasReasonFlags && hasReasonFlags[idx]),
          rowKey: `${st.agentCascadeId || cascadeId || 'conv'}-${st.stepIndex}`,
          hasTurn,
          hasUp,
          hasDown,
          isStart: Boolean(hasTurn && (getStepIsStart(st) || !hasDown)),
          isLatest: hasTurn && getStepIsLatest(st),
          prompt: hasTurn ? formattedTurnPrompt(st) : '',
        });
      }

      if (isVirtualized && bottomSpacerH > 0) {
        windowItems.push({
          isSizer: false,
          isSpacer: true,
          rowKey: SPACER_BOTTOM_KEY,
          height: bottomSpacerH,
          colSpan: colKeys.length,
        });
      }

      patchKeyedList(stepsTbody, windowItems, {
        keyFn: (item) => item.rowKey,
        sigFn: (item) => {
          if (item.isSizer) {
            return `${locale}:${colOrderSig}:${showAgentBadge ? 1 : 0}:${railActive ? 1 : 0}:${item.sizerSpec.sig}`;
          }
          if (item.isSpacer) {
            return `spacer:${item.colSpan}:${item.height}`;
          }
          const { st } = item;
          const parts = colKeys
            .map((colKey) => STEP_COLUMN_REGISTRY[colKey].sigPart(st, cellCtx))
            .join('|');
          const badgeSig = showAgentBadge
            ? `${cellCtx.scopeSigKey}:${st.agentId || 'main'}:${st.agentBadge || ''}:${st.agentLabel || ''}`
            : '';
          const stripeSig = isVirtualized ? (item.isStripeEven ? 'E' : 'O') : 'N';
          const anomalySig = `${st.anomalySig || ''}:${JSON.stringify(st.requestDiagnostics)}:${st.nativeStreamSec}:${st.thinkingDurationSec}`;
          return `${locale}:${colOrderSig}:${stripeSig}:${badgeSig}:${anomalySig}:${railActive}:${item.hasTurn}:${item.hasUp}:${item.hasDown}:${item.isStart}:${item.isLatest}:${item.prompt}:${parts}`;
        },
        createRow: (item) => {
          if (item.isSizer) {
            const tr = h('tr', { className: 'step-vsizer', 'aria-hidden': 'true' });
            return {
              el: tr,
              refs: {
                isSizer: true,
                isSpacer: false,
                cellMap: new Map(),
                colOrderSig: '',
                agentBadgeEl: null,
              },
            };
          }
          if (item.isSpacer) {
            const td = h('td', {
              className: 'step-vspacer-cell',
              colspan: String(item.colSpan),
            });
            const tr = h('tr', { className: 'step-vspacer', 'aria-hidden': 'true' }, [td]);
            return { el: tr, refs: { isSizer: false, isSpacer: true, td } };
          }
          if (rowPool.length > 0) {
            return rowPool.pop();
          }
          const tr = h('tr');
          return {
            el: tr,
            refs: {
              isSizer: false,
              isSpacer: false,
              cellMap: new Map(),
              colOrderSig: '',
              railEl: null,
              agentBadgeEl: null,
              hoverTd: null,
            },
          };
        },
        updateRow: (refs, item, _idx, tr) => {
          if (item.isSizer) {
            const spec = item.sizerSpec;
            if (refs.colOrderSig !== colOrderSig) {
              for (const [oldColKey, entry] of refs.cellMap) {
                if (!wantedSet.has(oldColKey)) {
                  if (refs.agentBadgeEl?.parentNode === entry.innerEl) {
                    entry.innerEl.removeChild(refs.agentBadgeEl);
                  }
                  tr.removeChild(entry.td);
                  refs.cellMap.delete(oldColKey);
                }
              }
              const isNewSizer = refs.colOrderSig === '';
              for (let i = 0; i < colKeys.length; i++) {
                const colKey = colKeys[i];
                let entry = refs.cellMap.get(colKey);
                if (!entry) {
                  const created = STEP_COLUMN_REGISTRY[colKey].createCell();
                  const innerEl = h('div', { className: 'step-vsizer-inner' });
                  while (created.td.firstChild) {
                    innerEl.appendChild(created.td.firstChild);
                  }
                  created.td.appendChild(innerEl);
                  entry = { td: created.td, refs: created.refs, innerEl };
                  refs.cellMap.set(colKey, entry);
                }
                if (isNewSizer) {
                  tr.appendChild(entry.td);
                } else {
                  const currentTd = tr.children[i] || null;
                  if (currentTd !== entry.td) tr.insertBefore(entry.td, currentTd);
                }
              }
              refs.colOrderSig = colOrderSig;
            }
            for (const colKey of colKeys) {
              const entry = refs.cellMap.get(colKey);
              const probeStep = spec.colSteps[colKey] || tableSteps[0];
              if (entry && probeStep) {
                STEP_COLUMN_REGISTRY[colKey].updateCell(entry.refs, probeStep, cellCtx);
              }
            }
            const firstColKey = colKeys[0];
            const firstInner = firstColKey ? refs.cellMap.get(firstColKey)?.innerEl || null : null;
            const showSizerBadge = Boolean(showAgentBadge && firstInner && spec.badgeText);
            if (showSizerBadge && !refs.agentBadgeEl) {
              refs.agentBadgeEl = h('span', { className: 'agent-badge', style: 'margin-right: 4px;' });
            }
            if (firstInner && refs.agentBadgeEl) {
              if (refs.agentBadgeEl.parentNode !== firstInner || firstInner.firstChild !== refs.agentBadgeEl) {
                firstInner.insertBefore(refs.agentBadgeEl, firstInner.firstChild);
              }
              patchAttr(refs.agentBadgeEl, 'hidden', !showSizerBadge);
              if (showSizerBadge) {
                patchAttr(refs.agentBadgeEl, 'class', `agent-badge ${spec.badgeClass || ''}`.trim());
                patchText(refs.agentBadgeEl, spec.badgeText);
              }
            }
            return;
          }
          if (item.isSpacer) {
            patchAttr(refs.td, 'colspan', String(item.colSpan));
            if (refs.td?.style) {
              refs.td.style.height = `${item.height}px`;
            }
            return;
          }
          const { st, hasTurn, hasUp, hasDown, isStart, isLatest, prompt } = item;
          patchClasses(tr, { 'is-stripe-even': Boolean(isVirtualized && item.isStripeEven) });
          if (tr.dataset) {
            tr.dataset.hasReason = item.hasReason ? '1' : '0';
          }

          if (refs.colOrderSig !== colOrderSig) {
            if (refs.hoverTd) {
              clearCellHover(refs.hoverTd);
              refs.hoverTd = null;
            }
            for (const [oldColKey, entry] of refs.cellMap) {
              if (!wantedSet.has(oldColKey)) {
                if (refs.railEl?.parentNode === entry.td) {
                  entry.td.removeChild(refs.railEl);
                }
                if (refs.agentBadgeEl?.parentNode === entry.td) {
                  entry.td.removeChild(refs.agentBadgeEl);
                }
                tr.removeChild(entry.td);
                refs.cellMap.delete(oldColKey);
              }
            }

            const isNewRow = refs.colOrderSig === '';
            for (let i = 0; i < colKeys.length; i++) {
              const colKey = colKeys[i];
              let cell = refs.cellMap.get(colKey);
              if (!cell) {
                cell = STEP_COLUMN_REGISTRY[colKey].createCell();
                refs.cellMap.set(colKey, cell);
              }
              if (isNewRow) {
                tr.appendChild(cell.td);
              } else {
                const currentTd = tr.children[i] || null;
                if (currentTd !== cell.td) tr.insertBefore(cell.td, currentTd);
              }
            }
            refs.colOrderSig = colOrderSig;
          }

          for (const colKey of colKeys) {
            const cellEntry = refs.cellMap.get(colKey);
            STEP_COLUMN_REGISTRY[colKey].updateCell(cellEntry.refs, st, cellCtx);
            if (colKey === 'ttft' && props.onInspectRequest) {
              if (!cellEntry.inspectButton) {
                cellEntry.inspectButton = h('button', {
                  type: 'button', className: 'step-request-diagnostics-button',
                  style: 'font: inherit; color: inherit; padding: 0; border: 0; background: transparent; text-decoration: underline; cursor: pointer;',
                });
                cellEntry.inspectButton.appendChild(cellEntry.refs.valEl);
                cellEntry.td.appendChild(cellEntry.inspectButton);
              }
              patchAttr(cellEntry.inspectButton, 'title', t('steps.diagnosticsOpen'));
              patchAttr(cellEntry.inspectButton, 'aria-label', t('steps.diagnosticsSelected', { step: st.stepIndex }));
              cellEntry.inspectButton.onclick = () => props.onInspectRequest(st);
            }

          }

          const firstColKey = colKeys[0];
          const firstTd = firstColKey ? refs.cellMap.get(firstColKey)?.td || null : null;
          const showRowRail = Boolean(hasTurn && firstTd);
          if (showRowRail && !refs.railEl) {
            refs.railEl = h('span', { className: 'turn-rail', 'aria-hidden': 'true' });
          }
          if (showAgentBadge && firstTd && !refs.agentBadgeEl) {
            refs.agentBadgeEl = h('span', { className: 'agent-badge', style: 'margin-right: 4px;' });
          }
          if (firstTd) {
            if (refs.railEl && (refs.railEl.parentNode !== firstTd || firstTd.firstChild !== refs.railEl)) {
              firstTd.insertBefore(refs.railEl, firstTd.firstChild);
            }
            const afterRail = refs.railEl
              ? refs.railEl.nextSibling ?? firstTd.children[1] ?? null
              : firstTd.firstChild;
            if (
              refs.agentBadgeEl &&
              (refs.agentBadgeEl.parentNode !== firstTd || afterRail !== refs.agentBadgeEl)
            ) {
              firstTd.insertBefore(refs.agentBadgeEl, afterRail);
            }
          }

          patchAttr(refs.agentBadgeEl, 'hidden', !showAgentBadge || !firstTd);
          if (showAgentBadge && firstTd) {
            const badgeCls = getAgentBadgeClass(st.agentIndex || 0, !st.isSubagent);
            const clickableCls = interactiveBadges && onSelectAgentScopes ? ' is-clickable' : '';
            patchAttr(refs.agentBadgeEl, 'class', `agent-badge${clickableCls} ${badgeCls}`);
            const badgeText = formatAgentBadgeText({
              agentKind:
                st.agentKind ||
                (!st.isSubagent ? 'main' : st.isSideQuestion ? 'side_question' : 'subagent'),
              agentOrdinal:
                st.agentOrdinal || (st.isSideQuestion ? st.sideIndex || 0 : st.agentIndex || 0),
              isMain: !st.isSubagent,
              isSideQuestion: Boolean(st.isSideQuestion),
              sideIndex: st.sideIndex || 0,
              index: st.agentIndex || 0,
              badgeText: st.agentBadge,
            });
            patchText(refs.agentBadgeEl, badgeText);

            if (interactiveBadges && onSelectAgentScopes) {
              const targetScope = st.agentId || 'main';
              const isSoleTarget =
                effectiveScopes.length === 1 && effectiveScopes[0] === targetScope;
              const agentName = formatAgentLabel({
                agentKind:
                  st.agentKind ||
                  (!st.isSubagent ? 'main' : st.isSideQuestion ? 'side_question' : 'subagent'),
                agentOrdinal:
                  st.agentOrdinal || (st.isSideQuestion ? st.sideIndex || 0 : st.agentIndex || 0),
                customRole: st.agentCustomRole,
                isMain: !st.isSubagent,
                isSideQuestion: Boolean(st.isSideQuestion),
                sideIndex: st.sideIndex || 0,
                index: st.agentIndex || 0,
                role: st.agentRole || '',
                shortLabel: st.agentLabel || '',
              });
              patchAttr(
                refs.agentBadgeEl,
                'title',
                isSoleTarget
                  ? t('steps.badgeBackAll')
                  : t('steps.badgeFilterAgent', { agent: agentName })
              );
              refs.agentBadgeEl.onclick = (e) => {
                if (e && (e.ctrlKey || e.metaKey || e.shiftKey) && effectiveScopes[0] !== 'all') {
                  const next = effectiveScopes.includes(targetScope)
                    ? effectiveScopes.filter((id) => id !== targetScope)
                    : [...effectiveScopes, targetScope];
                  onSelectAgentScopes(next.length > 0 ? next : ['all']);
                } else {
                  onSelectAgentScopes(isSoleTarget ? ['all'] : [targetScope]);
                }
              };
            } else {
              patchAttr(refs.agentBadgeEl, 'title', null);
              refs.agentBadgeEl.onclick = null;
            }
          } else if (refs.agentBadgeEl) {
            refs.agentBadgeEl.onclick = null;
          }

          const hasStepAnomaly = Boolean(st?.anomaly && Number(st.anomaly.count) > 0);
          const isAnomalyDanger = Boolean(hasStepAnomaly && st.anomaly.severity === 'danger');
          const isAnomalyWarn = Boolean(hasStepAnomaly && !isAnomalyDanger);
          patchClasses(tr, {
            'is-anomaly-warn': isAnomalyWarn,
            'is-anomaly-danger': isAnomalyDanger,
          });
          if (hasStepAnomaly) {
            const anchorEl = firstTd || tr;
            tr.onmouseenter = () => {
              showAnomalyTip(anchorEl, buildStepAnomalyDiagnostic(st));
            };
            tr.onmouseleave = hideAnomalyTip;
          } else {
            tr.onmouseenter = null;
            tr.onmouseleave = null;
          }

          patchAttr(refs.railEl, 'hidden', !showRowRail);
          if (showRowRail) {
            const marker = isStart ? ' is-origin' : !hasUp && hasDown ? ' is-cap' : '';
            patchAttr(
              refs.railEl,
              'class',
              `turn-rail${isLatest ? ' is-latest' : ''}${hasUp ? ' has-up' : ''}${hasDown ? ' has-down' : ''}${marker}`
            );
          }

          const hoverTd = showRowRail && prompt ? firstTd : null;
          if (refs.hoverTd !== hoverTd) clearCellHover(refs.hoverTd);
          refs.hoverTd = hoverTd;
          if (hoverTd) {
            hoverRows.set(hoverTd, {
              badge: refs.agentBadgeEl,
              prompt,
              anomalyStep: hasStepAnomaly ? st : null,
              tr,
            });
            const useWholeCellTurnTip = firstColKey === 'step' && !hasStepAnomaly;
            hoverTd.onmouseenter = useWholeCellTurnTip ? enterStepCell : null;
            hoverTd.onmousemove = useWholeCellTurnTip ? moveInStepCell : moveAlongTurnRail;
            hoverTd.onmouseleave = leaveStepCell;
          }

          if (enteringRowKeys?.has(item.rowKey)) {
            clearRowEnterState(tr);
            patchClasses(tr, { 'is-step-entering': true });
            tr.onanimationend = (ev) => {
              if (!ev || !ev.target || ev.target === tr) {
                clearRowEnterState(tr);
              }
            };
            const timer = setTimeout(() => clearRowEnterState(tr), 960);
            activeEnterTimers.set(tr, timer);
          }
        },
        destroyRow: (refs, tr) => {
          if (refs?.hoverTd) {
            clearCellHover(refs.hoverTd);
            refs.hoverTd = null;
          }
          clearRowEnterState(tr);
          if (!refs?.isSpacer && !refs?.isSizer && tr) {
            patchClasses(tr, {
              'is-stripe-even': false,
              'is-step-entering': false,
              'is-anomaly-warn': false,
              'is-anomaly-danger': false,
            });
            tr.onmouseenter = null;
            tr.onmouseleave = null;
            if (refs.agentBadgeEl) {
              refs.agentBadgeEl.onclick = null;
            }
            if (rowPool.length < MAX_ROW_POOL_SIZE) {
              rowPool.push({ el: tr, refs });
            }
          }
        },
      });

      renderedSliceStart = startIdx;
      renderedSliceEnd = endIdx;
      renderedTopSpacerH = topSpacerH;
      renderedBottomSpacerH = bottomSpacerH;

      if (isVirtualized) {
        scheduleCalibrateRowHeights();
      }
    }

    function refreshViewport() {
      if (!activeDataset?.isVirtualized) return;
      const scaleChanged = syncFontScaleIfChanged();
      renderCurrentWindow({ force: scaleChanged, enteringRowKeys: null });
      scheduleCalibrateRowHeights();
    }

    function onPaneScroll() {
      hideTurnTip();
      hideAnomalyTip();
      if (!activeDataset?.isVirtualized) return;
      if (typeof requestAnimationFrame === 'function') {
        if (scrollRafId) return;
        scrollRafId = requestAnimationFrame(() => {
          scrollRafId = 0;
          renderCurrentWindow({ force: false, enteringRowKeys: null });
        });
      } else {
        renderCurrentWindow({ force: false, enteringRowKeys: null });
      }
    }

    function onTbodyLeave() {
      hideTurnTip();
      hideAnomalyTip();
    }

    stepsTablePane.addEventListener('scroll', onPaneScroll, { passive: true });
    stepsTbody.addEventListener('mouseleave', onTbodyLeave);

    let paneResizeObs = null;
    if (typeof ResizeObserver === 'function') {
      paneResizeObs = new ResizeObserver(() => {
        if (!activeDataset?.isVirtualized) return;
        refreshViewport();
      });
      paneResizeObs.observe(stepsTablePane);
    }

    function renderStepTable(
      tableSteps,
      cascadeId,
      colKeys,
      locale,
      {
        effectiveScopes = ['all'],
        hasSubagents = false,
        isMergedMultiAgents = false,
        showStepTurnRail = false,
        showStepAgentBadge = true,
        showStepSpeedColor = false,
        stepTokenComboFormat = undefined,
        displaySettings = {},
        allConversationSteps = null,
        allowNewRowFade = false,
      } = {}
    ) {
      const normCascadeId = String(cascadeId || '');
      let enteringRowKeys = null;
      if (!normCascadeId || trackedCascadeId === null || normCascadeId !== trackedCascadeId) {
        trackedCascadeId = normCascadeId || null;
        lastAbsorbedAllSteps = null;
        seenStepKeys.clear();
        maxSeenStepByAgent.clear();
        if (allConversationSteps && allConversationSteps !== tableSteps) {
          absorbStepsIntoBaseline(allConversationSteps, normCascadeId);
          lastAbsorbedAllSteps = allConversationSteps;
        }
        absorbStepsIntoBaseline(tableSteps, normCascadeId);
      } else if (!allowNewRowFade || standalone) {
        if (allConversationSteps && allConversationSteps !== lastAbsorbedAllSteps && allConversationSteps !== tableSteps) {
          absorbStepsIntoBaseline(allConversationSteps, normCascadeId);
          lastAbsorbedAllSteps = allConversationSteps;
        }
        if (tableSteps !== lastRenderedRows) {
          absorbStepsIntoBaseline(tableSteps, normCascadeId);
        }
      } else if (tableSteps !== lastRenderedRows) {
        let pendingMaxByAgent = null;
        for (const st of tableSteps) {
          if (!st || typeof st !== 'object') continue;
          const { agentKey, stepNum, rowKey } = getStepRowIdentity(st, normCascadeId);
          if (!seenStepKeys.has(rowKey)) {
            seenStepKeys.add(rowKey);
            const prevMax = maxSeenStepByAgent.get(agentKey);
            if (prevMax === undefined || !Number.isFinite(stepNum) || stepNum > prevMax) {
              enteringRowKeys ??= new Set();
              enteringRowKeys.add(rowKey);
            }
            if (Number.isFinite(stepNum)) {
              const curPending = pendingMaxByAgent?.get(agentKey);
              if (curPending === undefined || stepNum > curPending) {
                pendingMaxByAgent ??= new Map();
                pendingMaxByAgent.set(agentKey, stepNum);
              }
            }
          }
        }
        if (pendingMaxByAgent) {
          for (const [agentKey, maxStep] of pendingMaxByAgent) {
            const prevMax = maxSeenStepByAgent.get(agentKey);
            if (prevMax === undefined || maxStep > prevMax) {
              maxSeenStepByAgent.set(agentKey, maxStep);
            }
          }
        }
        if (allConversationSteps && allConversationSteps !== lastAbsorbedAllSteps && allConversationSteps !== tableSteps) {
          absorbStepsIntoBaseline(allConversationSteps, normCascadeId);
          lastAbsorbedAllSteps = allConversationSteps;
        }
      } else if (allConversationSteps && allConversationSteps !== lastAbsorbedAllSteps && allConversationSteps !== tableSteps) {
        absorbStepsIntoBaseline(allConversationSteps, normCascadeId);
        lastAbsorbedAllSteps = allConversationSteps;
      }

      const colOrderSig = colKeys.join(',');
      const normTokenFmt = normalizeClientStepTokenComboFormat(stepTokenComboFormat);
      const renderOptions = JSON.stringify([
        cascadeId, locale, colOrderSig, effectiveScopes, hasSubagents, isMergedMultiAgents,
        showStepTurnRail, showStepAgentBadge, showStepSpeedColor, normTokenFmt,
        displaySettings.modelDisplayMode, displaySettings.showUpstreamModel,
        displaySettings.orchestratorIdMode,
      ]);
      if (
        lastRenderOptions === renderOptions &&
        lastRenderedRows &&
        (lastRenderedRows === tableSteps ||
          (lastRenderedRows.length === tableSteps.length &&
            tableSteps.every((step, i) => step === lastRenderedRows[i])))
      ) {
        if (activeDataset?.isVirtualized) {
          refreshViewport();
        }
        return;
      }

      syncFontScaleIfChanged();
      const wantedSet = new Set(colKeys);
      syncTableHeaderColumns(colKeys, { stepTokenComboFormat: normTokenFmt });

      const showAgentBadge = Boolean(hasSubagents && showStepAgentBadge);
      const cellCtx = {
        hasSubagents,
        showAgentBadge,
        showStepSpeedColor,
        stepTokenComboFormat: normTokenFmt,
        effectiveScopes,
        scopeSigKey: effectiveScopes.join(','),
        displaySettings,
        onSelectAgentScopes,
      };

      const useRootTurn = Boolean(hasSubagents && isMergedMultiAgents);
      let railActive = false;
      if (showStepTurnRail) {
        for (let i = 0; i < tableSteps.length; i++) {
          const st = tableSteps[i];
          const tIdx = useRootTurn ? (st?.rootTurnIndex ?? st?.turnIndex) : st?.turnIndex;
          if (Number.isInteger(tIdx) && tIdx > 0) {
            railActive = true;
            break;
          }
        }
      }
      if (!railActive) {
        hideTurnTip();
      }

      const isVirtualized = !standalone && tableSteps.length > VIRTUAL_ROW_THRESHOLD;
      patchClasses(stepsTableEl, {
        'has-turn-rail': railActive,
        'is-virtualized': isVirtualized,
      });

      let hasReasonFlags = null;
      let hasAnyReason = false;
      let rowTops = null;
      let totalBodyH = 0;
      let sizerSpec = null;
      if (isVirtualized) {
        const hasTpsCol = wantedSet.has('tps');
        if (hasTpsCol) {
          hasReasonFlags = new Uint8Array(tableSteps.length);
          for (let i = 0; i < tableSteps.length; i++) {
            const rawReason = tableSteps[i]?.selectedSpeedReason;
            if (rawReason && speedReasonText(rawReason)) {
              hasReasonFlags[i] = 1;
              hasAnyReason = true;
            }
          }
        }
        const built = buildRowTops(tableSteps.length, hasReasonFlags);
        rowTops = built.rowTops;
        totalBodyH = built.totalBodyH;
        sizerSpec = buildColumnSizerSpec(tableSteps, colKeys, wantedSet, cellCtx);
      }

      activeDataset = {
        tableSteps,
        cascadeId,
        colKeys,
        wantedSet,
        colOrderSig,
        locale,
        cellCtx,
        railActive,
        showAgentBadge,
        showStepTurnRail,
        useRootTurn,
        isVirtualized,
        hasReasonFlags,
        hasAnyReason,
        rowTops,
        totalBodyH,
        sizerSpec,
        effectiveScopes,
        formattedPrompts: new Map(),
      };
      renderedSliceStart = -1;
      renderedSliceEnd = -1;
      renderedTopSpacerH = -1;
      renderedBottomSpacerH = -1;

      renderCurrentWindow({ force: true, enteringRowKeys });
      lastRenderOptions = renderOptions;
      lastRenderedRows = tableSteps;
    }

    onCleanup(() => {
      stepsTablePane.removeEventListener('scroll', onPaneScroll);
      stepsTbody.removeEventListener('mouseleave', onTbodyLeave);
      if (scrollRafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(scrollRafId);
        scrollRafId = 0;
      }
      if (calibrateRafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(calibrateRafId);
        calibrateRafId = 0;
      }
      paneResizeObs?.disconnect();
      paneResizeObs = null;
      rowPool.length = 0;
      for (const tr of [...activeEnterTimers.keys()]) {
        clearRowEnterState(tr);
      }
    });

    return {
      el: standaloneHostEl || stepsTablePane,
      refs: {
        stepsTablePane,
        stepsTableEl,
        stepsTheadRow,
        stepsTbody,
        turnTipEl,
        anomalyTipEl,
        syncTableHeaderColumns,
        renderStepTable,
        refreshViewport,
        hideTurnTip,
        showAnomalyTip,
        hideAnomalyTip,
        setBoundsElGetter,
      },
    };
  },
});
