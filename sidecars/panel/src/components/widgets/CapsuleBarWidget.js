/**
 * @fileoverview Shared Decoupled Capsule Bar Primitives & Widget (`CapsuleBarWidget.js`).
 * Powers both the live host window capsule (`WindowOverlayShell.js`) and the
 * real-UI structure preview (`SettingsStructureTab.js`), ensuring 100% DOM/CSS parity.
 */

import { isModernUiActiveForElement } from '../../core/appearance.js';
import { defineComponent } from '../../core/component.js';
import {
  areSlotListsEqual,
  createDropSettleAnimator,
  h,
  patchAttr,
  patchClasses,
  patchStyleVar,
  patchText,
  setTranslate3d,
  startLinearDragReorder,
} from '../../core/domPatch.js';
import { t } from '../../i18n/index.js';
import { createSvgIcon, SVG_NS } from '../../icons/SvgIcon.js';
import { resolveCapsuleMetricPresentation } from '../../registries/metricRegistry.js';
import {
  isClientTopbarMultiSessionVisible,
  normalizeClientTopbarMultiSessionMode,
  normalizeClientTopbarSlots,
  normalizeClientWindowMountMode,
  resolveOverlayCtxInspectorAgentId,
  resolveScopedConversation,
} from '../../store/telemetryStore.js';
import { buildFallbackRunningConversations } from './LiveActivityWidget.js';

export const RING_RADIUS = 5.2;
export const RING_CIRCUMFERENCE = +(2 * Math.PI * RING_RADIUS).toFixed(2);

const ODOMETER_DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const capsuleOdometerState = new WeakMap();

/**
 * 将胶囊指标文本拆分为「按数位对齐的数字滚轮 + 静态字符片段」：
 * - 整数部分从右向左按位次键控（个位 `i:0`、十位 `i:1`...），小数部分从左向右键控（`f:0`...）；
 * - 位数增减时既有数位节点原地复用，仅发生变化的数字位执行 0.15s 老虎机垂直滚动，未变位与单位纹丝不动。
 *
 * @param {string} rawText
 * @returns {Array<{ key: string, kind: 'digit' | 'static', digit?: number, text?: string }>}
 */
export function tokenizeCapsuleOdometerText(rawText) {
  const str = String(rawText ?? '');
  if (!str) return [];
  const parts = str.split(/(\d+(?:\.\d+)?)/g);
  const tokens = [];
  let numIdx = 0;
  let staticIdx = 0;

  for (let p = 0; p < parts.length; p += 1) {
    const seg = parts[p];
    if (!seg) continue;
    if (/^\d+(?:\.\d+)?$/.test(seg)) {
      const dotPos = seg.indexOf('.');
      const intPart = dotPos >= 0 ? seg.slice(0, dotPos) : seg;
      const fracPart = dotPos >= 0 ? seg.slice(dotPos + 1) : '';
      const intLen = intPart.length;
      for (let i = 0; i < intLen; i += 1) {
        const place = intLen - 1 - i;
        tokens.push({
          key: `n:${numIdx}:i:${place}`,
          kind: 'digit',
          digit: Number(intPart[i]),
        });
      }
      if (dotPos >= 0) {
        tokens.push({ key: `n:${numIdx}:dot`, kind: 'static', text: '.' });
        for (let j = 0; j < fracPart.length; j += 1) {
          tokens.push({
            key: `n:${numIdx}:f:${j}`,
            kind: 'digit',
            digit: Number(fracPart[j]),
          });
        }
      }
      numIdx += 1;
    } else {
      tokens.push({ key: `s:${staticIdx}`, kind: 'static', text: seg });
      staticIdx += 1;
    }
  }
  return tokens;
}

function createOdometerDigitReel(initialDigit) {
  const cells = ODOMETER_DIGITS.map((d) => h('span', { className: 'wm-od-cell', text: d }));
  const trackEl = h('span', { className: 'wm-od-track' }, cells);
  patchStyleVar(trackEl, '--od-val', String(initialDigit));
  const digitEl = h('span', { className: 'wm-od-digit', 'aria-hidden': 'true' }, [trackEl]);
  return { el: digitEl, trackEl, kind: 'digit', digit: initialDigit };
}

/**
 * 在实验性新 UI (`[data-modern-ui="true"]`) 下将胶囊数字渲染为 0.15s 老虎机垂直滚轮；
 * 经典 UI 或无数字占位文本（如 `-- t/s`）严格退回原生纯文本 `patchText`，零多余 DOM 与动画。
 */
export function patchCapsuleOdometerText(
  el,
  nextValue,
  { resetKey = '', modernUi = undefined } = {}
) {
  if (!el) return false;
  const nextStr = String(nextValue ?? '');
  const isModern = typeof modernUi === 'boolean' ? modernUi : isModernUiActiveForElement(el);
  const prev = capsuleOdometerState.get(el);

  if (!isModern || !/\d/.test(nextStr)) {
    if (prev?.active) {
      el.textContent = '';
      while (el.firstChild) el.removeChild(el.firstChild);
      patchAttr(el, 'data-od-active', null);
      patchAttr(el, 'data-od-value', null);
      patchAttr(el, 'aria-label', null);
    }
    const changed = patchText(el, nextStr);
    capsuleOdometerState.set(el, { active: false, text: nextStr, resetKey, nodes: null });
    return changed;
  }

  if (prev?.active && prev.text === nextStr && prev.resetKey === resetKey) {
    return false;
  }

  let nodes;
  if (!prev?.active || prev.resetKey !== resetKey || !(prev.nodes instanceof Map)) {
    el.textContent = '';
    while (el.firstChild) el.removeChild(el.firstChild);
    nodes = new Map();
  } else {
    nodes = prev.nodes;
  }

  const tokens = tokenizeCapsuleOdometerText(nextStr);
  const nextKeys = new Set();
  const orderedEls = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    nextKeys.add(tok.key);
    let rec = nodes.get(tok.key);
    if (!rec || rec.kind !== tok.kind) {
      if (rec?.el?.parentNode === el) {
        el.removeChild(rec.el);
      }
      if (tok.kind === 'digit') {
        rec = createOdometerDigitReel(tok.digit);
      } else {
        rec = {
          el: h('span', { className: 'wm-od-static', 'aria-hidden': 'true', text: tok.text }),
          trackEl: null,
          kind: 'static',
          text: tok.text,
        };
      }
      nodes.set(tok.key, rec);
    } else if (tok.kind === 'digit') {
      if (rec.digit !== tok.digit) {
        patchStyleVar(rec.trackEl, '--od-val', String(tok.digit));
        rec.digit = tok.digit;
      }
    } else if (rec.text !== tok.text) {
      patchText(rec.el, tok.text);
      rec.text = tok.text;
    }
    orderedEls.push(rec.el);
  }

  for (const [oldKey, rec] of nodes.entries()) {
    if (!nextKeys.has(oldKey)) {
      if (rec.el?.parentNode === el) {
        el.removeChild(rec.el);
      }
      nodes.delete(oldKey);
    }
  }

  for (let i = 0; i < orderedEls.length; i += 1) {
    const targetNode = orderedEls[i];
    const currentNode = el.children[i] || null;
    if (currentNode !== targetNode) {
      el.insertBefore(targetNode, currentNode);
    }
  }

  patchAttr(el, 'data-od-active', '1');
  patchAttr(el, 'data-od-value', nextStr);
  patchAttr(el, 'aria-label', nextStr);
  capsuleOdometerState.set(el, { active: true, text: nextStr, resetKey, nodes });
  return true;
}

function isValidTtftSec(val) {
  return val != null && Number.isFinite(Number(val)) && Number(val) >= 0;
}

function findFallbackRecentStepTtft(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const firstIdx = Number(steps[0]?.stepIndex ?? 0);
  const lastIdx = Number(steps[steps.length - 1]?.stepIndex ?? 0);
  if (firstIdx >= lastIdx) {
    for (let i = 0; i < steps.length; i += 1) {
      const candidate = steps[i]?.ttftSec;
      if (isValidTtftSec(candidate)) return Number(candidate);
    }
    return null;
  }
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const candidate = steps[i]?.ttftSec;
    if (isValidTtftSec(candidate)) return Number(candidate);
  }
  return null;
}

/**
 * Compute shared context ring + 1..5 capsule slot metric payload from telemetry & scoped conversation.
 */
export function buildCapsuleSlotContext(
  data,
  { scopedConv = null, overviewConv = null, ctxAgent = null, aggregated = null } = {}
) {
  if (!data) return { hasTelemetry: false };
  const activeConv = data.activeConversation || {};
  const overviewActive = overviewConv || scopedConv || aggregated || activeConv;
  const capActive = scopedConv || aggregated || activeConv || {};
  const ctx = ctxAgent?.context || overviewActive.context || activeConv.context || {};
  const limitTokens = Number(ctx.compactionLimitTokens || ctx.limitTokens || 256000);
  const totalTokens = Number(ctx.totalTokens || 0);
  const usedPct =
    limitTokens > 0 ? Math.min(100, +((totalTokens / limitTokens) * 100).toFixed(1)) : 0;
  const dashOffset = +(
    RING_CIRCUMFERENCE *
    (1 - Math.max(0, Math.min(100, usedPct)) / 100)
  ).toFixed(2);

  const isRunning = Boolean(aggregated?.isRunning || activeConv.isRunning);
  const convId = String(capActive.cascadeId || activeConv.cascadeId || '')
    .trim()
    .toLowerCase();
  const scopeId = String(scopedConv?.agentId || aggregated?.agentId || 'main');
  const conversationKey = convId ? `${convId}::${scopeId}` : '';
  const stepCount = Math.max(0, Number(capActive.stepCount ?? activeConv.stepCount ?? 0));

  const rawTtft =
    scopedConv?.latestTtftSec ?? aggregated?.latestTtftSec ?? activeConv.latestTtftSec ?? null;
  const fallbackTtft = isValidTtftSec(rawTtft)
    ? Number(rawTtft)
    : scopedConv?.lastKnownTtftSec ??
      findFallbackRecentStepTtft(scopedConv?.recentSteps) ??
      aggregated?.lastKnownTtftSec ??
      activeConv.lastKnownTtftSec ??
      findFallbackRecentStepTtft(activeConv.recentSteps);
  const resolvedTtft = isValidTtftSec(fallbackTtft) ? Number(fallbackTtft) : null;

  const capInTok = Math.max(0, Number(capActive.inputTokens || 0));
  const capCacheTok = Math.max(0, Number(capActive.cacheReadTokens || 0));
  const capOutTok = Math.max(0, Number(capActive.outputTokens || 0));
  const sessionTokens =
    stepCount > 0 ||
    capActive.totalTokens != null ||
    capInTok + capCacheTok + capOutTok > 0
      ? Math.max(0, Number(capActive.totalTokens ?? capInTok + capCacheTok + capOutTok))
      : null;

  return {
    hasTelemetry: true,
    conversationKey,
    stepCount,
    usedPct,
    dashOffset,
    isRunning,
    tps: scopedConv?.latestTokPerSec ?? aggregated?.latestTokPerSec ?? activeConv.latestTokPerSec ?? null,
    avgTps: scopedConv?.avgTokPerSec ?? aggregated?.avgTokPerSec ?? activeConv.avgTokPerSec ?? null,
    ttft: resolvedTtft,
    stepCost:
      scopedConv?.latestStepCostUsd ??
      aggregated?.latestStepCostUsd ??
      activeConv.latestStepCostUsd ??
      null,
    sessionCost:
      scopedConv?.sessionCostUsd ?? aggregated?.sessionCostUsd ?? activeConv.sessionCostUsd ?? null,
    cacheHitPct:
      Number(capActive.stepCount || 0) > 0
        ? capActive.latestCacheHitPct ?? capActive.sessionCacheHitPct ?? null
        : null,
    latestPromptTokens: capActive.latestPromptTokens ?? null,
    sessionTokens,
    quotas: data.quotas,
  };
}

/**
 * Compute multi-session button state & normalized running conversation list.
 */
export function resolveMultiSessionCapsuleState(
  data,
  { agents = [], aggregated = null, latestTokPerSec = undefined, contextUsedPct = undefined } = {}
) {
  const rawRunningList = buildFallbackRunningConversations(data, {
    agents,
    aggregated,
    latestTokPerSec,
    contextUsedPct,
  });
  const runningCount = rawRunningList.length;
  const runningSubCount = rawRunningList.reduce(
    (acc, item) => acc + Number(item.runningSubagentCount || 0),
    0
  );
  const runningSwarmCount = rawRunningList.reduce(
    (acc, item) => acc + Number(item.runningSwarmCount || 0),
    0
  );
  const isPureSwarmSubs = runningSubCount > 0 && runningSwarmCount === runningSubCount;
  const hasWaiting = rawRunningList.some((item) => item.mainActivity?.phase === 'waiting');
  const multiBtnText =
    runningCount > 0
      ? runningSubCount > 0
        ? t(isPureSwarmSubs ? 'capsule.multiRunningWithSwarm' : 'capsule.multiRunningWithSubs', {
            count: runningCount,
            subs: runningSubCount,
          })
        : t('capsule.multiRunning', { count: runningCount })
      : t('capsule.multiZero');
  return {
    rawRunningList,
    runningCount,
    runningSubCount,
    runningSwarmCount,
    hasWaiting,
    multiBtnText,
  };
}

/**
 * Create a single reusable capsule metric slot node (`0..4`) with an optional SVG context ring.
 */
export function createCapsuleSlotNode(slotIndex, initialMetric) {
  const ringSvg = document.createElementNS(SVG_NS, 'svg');
  ringSvg.setAttribute('viewBox', '0 0 14 14');
  ringSvg.setAttribute('class', 'wm-ring-svg');
  ringSvg.setAttribute('aria-hidden', 'true');

  const ringTrack = document.createElementNS(SVG_NS, 'circle');
  ringTrack.setAttribute('cx', '7');
  ringTrack.setAttribute('cy', '7');
  ringTrack.setAttribute('r', String(RING_RADIUS));
  ringTrack.setAttribute('class', 'wm-ring-track');

  const ringFill = document.createElementNS(SVG_NS, 'circle');
  ringFill.setAttribute('cx', '7');
  ringFill.setAttribute('cy', '7');
  ringFill.setAttribute('r', String(RING_RADIUS));
  ringFill.setAttribute('class', 'wm-ring-fill');
  ringFill.setAttribute('stroke-dasharray', String(RING_CIRCUMFERENCE));
  ringFill.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE));

  ringSvg.appendChild(ringTrack);
  ringSvg.appendChild(ringFill);

  const isNone = initialMetric === 'none';
  const isCtx = initialMetric === 'context';
  const prefixSpan = h('span', { className: 'wm-slot-prefix' });
  const textSpan = h('span', {
    className: isCtx ? 'wm-slot-text wm-ctx-pct' : 'wm-slot-text',
    text: isNone
      ? ''
      : isCtx
        ? '--%'
        : initialMetric === 'tps'
          ? '-- t/s'
          : initialMetric === 'ttft'
            ? '--s'
            : '--%',
  });
  const el = h(
    'span',
    {
      className: isNone
        ? 'wm-cap-slot'
        : isCtx
          ? 'wm-cap-slot wm-ctx-seg'
          : initialMetric === 'tps'
            ? 'wm-cap-slot wm-seg-speed'
            : initialMetric === 'ttft'
              ? 'wm-cap-slot wm-seg-metric'
              : 'wm-cap-slot wm-seg-quota',
      hidden: isNone,
      'data-slot-idx': String(slotIndex),
      'data-metric': initialMetric,
      'data-vis-rank': isNone ? '' : String(slotIndex + 1),
    },
    isCtx ? [ringSvg, textSpan] : [textSpan]
  );

  return {
    el,
    ringSvg,
    ringFill,
    prefixSpan,
    textSpan,
    ringMounted: isCtx,
    prefixMounted: false,
    heldTtft: null,
  };
}

/**
 * Patch 5 pre-allocated capsule slots and 4 separators in-place via `metricRegistry`.
 */
export function syncCapsuleSlotNodes(capsuleSlots, capsuleSeps, slotKeys, slotCtx) {
  let visRank = 0;
  const visRanks = [0, 0, 0, 0, 0];
  for (let i = 0; i < capsuleSlots.length; i += 1) {
    const slot = capsuleSlots[i];
    const metricKey = i < slotKeys.length ? slotKeys[i] : 'none';
    if (!slotCtx?.hasTelemetry || metricKey !== 'ttft') {
      slot.heldTtft = null;
    }
    let pres = resolveCapsuleMetricPresentation(metricKey, slotCtx, RING_CIRCUMFERENCE);
    if (metricKey === 'ttft' && slotCtx?.hasTelemetry) {
      const convKey = String(slotCtx.conversationKey || '');
      if (isValidTtftSec(slotCtx.ttft)) {
        slot.heldTtft = convKey ? { conversationKey: convKey, pres } : null;
      } else if (
        convKey &&
        slot.heldTtft &&
        slot.heldTtft.conversationKey === convKey &&
        (slotCtx.isRunning || Number(slotCtx.stepCount) > 0)
      ) {
        pres = { ...slot.heldTtft.pres, running: Boolean(slotCtx.isRunning) };
      } else {
        slot.heldTtft = null;
      }
    }
    if (pres.hidden) {
      patchAttr(slot.el, 'hidden', true);
      patchAttr(slot.el, 'data-metric', 'none');
      patchAttr(slot.el, 'data-vis-rank', '');
      continue;
    }
    visRank += 1;
    visRanks[i] = visRank;
    patchAttr(slot.el, 'hidden', false);
    patchAttr(slot.el, 'data-metric', pres.metric);
    patchAttr(slot.el, 'data-vis-rank', String(visRank));

    if (pres.showRing && !slot.ringMounted) {
      slot.el.insertBefore(slot.ringSvg, slot.el.firstChild || slot.textSpan);
      slot.ringMounted = true;
    } else if (!pres.showRing && slot.ringMounted) {
      slot.ringSvg.remove();
      slot.ringMounted = false;
    }

    const prefixText = String(pres.prefix || '');
    if (prefixText) {
      patchText(slot.prefixSpan, prefixText);
      if (!slot.prefixMounted) {
        slot.el.insertBefore(slot.prefixSpan, slot.textSpan);
        slot.prefixMounted = true;
      }
    } else if (slot.prefixMounted) {
      slot.prefixSpan.remove();
      slot.prefixMounted = false;
    }

    const toneCls =
      pres.toneClass || (pres.danger ? 'tone-danger' : pres.warn ? 'tone-warn' : '');
    const fullSegClass = `${pres.segClass}${pres.running ? ' state-running' : ''}${toneCls ? ` ${toneCls}` : ''}`;
    patchAttr(slot.el, 'class', fullSegClass);
    const fullTextClass = `${pres.textClass}${toneCls ? ` ${toneCls}` : ''}`;
    patchAttr(slot.textSpan, 'class', fullTextClass);
    patchCapsuleOdometerText(slot.textSpan, pres.text, { resetKey: pres.metric });

    if (pres.showRing) {
      slot.ringFill.setAttribute('stroke-dashoffset', String(pres.dashOffset));
      patchClasses(slot.ringFill, {
        'is-quota': pres.ringKind === 'quota',
        'is-empty': pres.ringEmpty === true,
        'tone-warn': pres.warn,
        'tone-danger': pres.danger,
      });
    }
  }

  for (let s = 0; s < capsuleSeps.length; s += 1) {
    const sepEl = capsuleSeps[s];
    const nextRank = visRanks[s + 1] || 0;
    const showSep = nextRank >= 2;
    patchAttr(sepEl, 'hidden', !showSep);
    patchAttr(sepEl, 'data-sep-for-rank', showSep ? String(nextRank) : '');
  }
}

/**
 * Standalone Capsule Bar Preview Widget mounting the real `.wm-multi-btn` and `.wm-capsule-btn`
 * inside a contextual host bar (`dual` titlebar, `composer` toolbar, or `sidebar` disabled state).
 * When `onReorderSlots` / `onPreviewSlots` callbacks are supplied, metric chips inside the
 * preview capsule support direct horizontal pointer drag-to-reorder.
 */
export const CapsuleBarWidget = defineComponent({
  name: 'CapsuleBarWidget',
  setup({ props, onCleanup }) {
    const hasReorderCallbacks =
      typeof props?.onReorderSlots === 'function' || typeof props?.onPreviewSlots === 'function';
    let currentSlotKeys = ['tps', 'ttft', 'context'];
    let lastUpdatePayload = null;
    let pendingUpdatePayload = null;
    let activeDrag = null;
    const settleAnimator = createDropSettleAnimator('is-settling', ' scale(1.04)');

    const multiDot = h('span', { className: 'wm-multi-dot' });
    const multiLabel = h('span', {
      className: 'wm-multi-label',
      text: t('capsule.multiZero'),
    });
    const multiBtn = h(
      'button',
      {
        type: 'button',
        className: 'wm-multi-btn',
        tabindex: '-1',
        'aria-hidden': 'true',
      },
      [multiDot, multiLabel]
    );

    const capsuleSlots = [
      createCapsuleSlotNode(0, 'tps'),
      createCapsuleSlotNode(1, 'ttft'),
      createCapsuleSlotNode(2, 'context'),
      createCapsuleSlotNode(3, 'none'),
      createCapsuleSlotNode(4, 'none'),
    ];
    const capsuleSeps = [
      h('span', { className: 'wm-sep wm-sep-speed', 'data-sep-for-rank': '2' }),
      h('span', { className: 'wm-sep wm-sep-quota', 'data-sep-for-rank': '3' }),
      h('span', { className: 'wm-sep', 'data-sep-for-rank': '', hidden: true }),
      h('span', { className: 'wm-sep', 'data-sep-for-rank': '', hidden: true }),
    ];

    const capsuleBtn = h(
      'button',
      {
        type: 'button',
        className: 'wm-capsule-btn',
        tabindex: '-1',
        ...(hasReorderCallbacks ? {} : { 'aria-hidden': 'true' }),
      },
      [
        capsuleSlots[0].el,
        capsuleSeps[0],
        capsuleSlots[1].el,
        capsuleSeps[1],
        capsuleSlots[2].el,
        capsuleSeps[2],
        capsuleSlots[3].el,
        capsuleSeps[3],
        capsuleSlots[4].el,
      ]
    );

    const capsuleCluster = h('div', { className: 'preview-capsule-cluster' }, [
      multiBtn,
      capsuleBtn,
    ]);

    // Contextual host chrome affordances for Titlebar vs Composer vs Sidebar-only
    const titlebarLeftMock = h('div', { className: 'preview-host-left is-titlebar' }, [
      h('span', { className: 'preview-win-title', text: 'Antigravity' }),
    ]);
    const composerLeftMock = h(
      'div',
      { className: 'preview-host-left is-composer', hidden: true },
      [
        h('span', { className: 'preview-composer-chip' }, [
          h('span', { text: 'Carbon (High)' }),
          createSvgIcon('chevron-down', { size: 10 }),
        ]),
      ]
    );

    const composerSendMock = h(
      'span',
      { className: 'preview-composer-send', 'aria-hidden': 'true', hidden: true },
      [createSvgIcon('arrow-up', { size: 11 })]
    );

    const hostBarEl = h(
      'div',
      { className: 'preview-capsule-bar', 'data-mount-mode': 'dual' },
      [titlebarLeftMock, composerLeftMock, capsuleCluster, composerSendMock]
    );

    const sidebarHintEl = h('div', {
      className: 'preview-sidebar-note',
      hidden: true,
      text: t('settings.str.previewMountSidebarHint'),
    });

    const rootEl = h('div', { className: 'capsule-preview-widget' }, [hostBarEl, sidebarHintEl]);

    function resetDragVisuals() {
      patchClasses(hostBarEl, { 'is-dragging-capsule': false });
      patchClasses(capsuleBtn, { 'is-dragging-capsule': false });
      for (const slot of capsuleSlots) {
        patchClasses(slot.el, { 'is-dragging': false, 'is-drag-sibling': false });
        if (slot.el?.style) {
          slot.el.style.transition = '';
          slot.el.style.transform = '';
        }
      }
      for (const sep of capsuleSeps) {
        patchClasses(sep, { 'is-drag-sep': false });
        if (sep?.style) {
          sep.style.transition = '';
          sep.style.transform = '';
        }
      }
    }

    function syncSlotDragAffordances(slotCount) {
      const canDrag = hasReorderCallbacks && slotCount > 1;
      patchClasses(hostBarEl, { 'is-slot-reorderable': canDrag });
      patchClasses(capsuleBtn, { 'is-slot-reorderable': canDrag });
      const hint = canDrag ? t('settings.str.capsuleDragHint') : null;
      for (let i = 0; i < capsuleSlots.length; i += 1) {
        patchAttr(capsuleSlots[i].el, 'title', canDrag && i < slotCount ? hint : null);
      }
    }

    function teardownActiveDrag({ revert = false, flushPending = true } = {}) {
      if (!activeDrag) return;
      const { startKeys, getWorkingKeys, session } = activeDrag;
      const moved = session.isMoved();
      activeDrag = null;
      session.cancel(true);
      resetDragVisuals();
      if (revert && moved && !areSlotListsEqual(startKeys, getWorkingKeys())) {
        props?.onPreviewSlots?.([...startKeys]);
      }
      if (flushPending && pendingUpdatePayload) {
        const queued = pendingUpdatePayload;
        pendingUpdatePayload = null;
        applyUpdatePayload(queued);
      }
    }

    function startSlotDrag(e, initialSlotIdx) {
      if (!hasReorderCallbacks || (e && e.button != null && e.button !== 0)) return;
      if (currentSlotKeys.length <= 1 || initialSlotIdx < 0 || initialSlotIdx >= currentSlotKeys.length) {
        return;
      }
      e?.preventDefault?.();
      e?.stopPropagation?.();
      if (activeDrag) teardownActiveDrag({ revert: false, flushPending: true });
      settleAnimator.clear();

      const startKeys = [...currentSlotKeys];
      const count = startKeys.length;
      const startIdx = initialSlotIdx;
      let sepMetrics = [];

      const session = startLinearDragReorder(e, {
        axis: 'x',
        items: startKeys,
        startIdx,
        itemEls: capsuleSlots.slice(0, count).map((s) => s.el),
        containerEl: capsuleBtn,
        fallbackSize: 54,
        fallbackGap: 17,
        threshold: 3,
        rubberBandMax: 12,
        crossMax: 4,
        crossRatio: 0.14,
        dragScale: ' scale(1.04)',
        onStart: ({ metrics }) => {
          sepMetrics = [];
          for (let s = 0; s < count - 1; s += 1) {
            const sr = capsuleSeps[s]?.getBoundingClientRect?.();
            const ok = Boolean(sr && Number.isFinite(sr.width) && sr.width > 0);
            sepMetrics.push({ left: ok ? sr.left : metrics[s].end + 8, width: ok ? sr.width : 1 });
          }
          patchClasses(hostBarEl, { 'is-dragging-capsule': true });
          patchClasses(capsuleBtn, { 'is-dragging-capsule': true });
          for (let k = 0; k < count; k += 1) {
            patchClasses(capsuleSlots[k].el, { 'is-dragging': k === startIdx, 'is-drag-sibling': k !== startIdx });
          }
          for (let s = 0; s < count - 1; s += 1) patchClasses(capsuleSeps[s], { 'is-drag-sep': true });
        },
        onLayout: ({ perm, targetStartByOrig, metrics, gap }) => {
          for (let s = 0; s < count - 1; s += 1) {
            if (!sepMetrics[s]) continue;
            const leftOrig = perm[s];
            const desiredSepLeft =
              targetStartByOrig[leftOrig] + metrics[leftOrig].size + (gap - (sepMetrics[s].width || 1)) * 0.5;
            setTranslate3d(capsuleSeps[s], desiredSepLeft - sepMetrics[s].left);
          }
        },
        onPreview: (working) => props?.onPreviewSlots?.(working),
        onCancel: () => teardownActiveDrag({ revert: true, flushPending: true }),
        onFinish: ({ moved, changed, targetIdx, finalItems, residualX, residualY }) => {
          teardownActiveDrag({ revert: false, flushPending: !changed });
          if (changed) {
            pendingUpdatePayload = null;
            currentSlotKeys = finalItems;
            if (lastUpdatePayload?.data) {
              applyUpdatePayload({
                data: {
                  ...lastUpdatePayload.data,
                  settings: { ...(lastUpdatePayload.data.settings || {}), topbarCapsuleSlots: finalItems },
                },
              });
            }
            props?.onReorderSlots?.([...finalItems]);
          }
          if (moved && capsuleSlots[targetIdx]?.el) {
            settleAnimator.trigger(capsuleSlots[targetIdx].el, residualX, residualY);
          }
        },
      });

      activeDrag = { startKeys, getWorkingKeys: session.getWorkingItems, session };
    }

    const slotPointerCleanups = [];
    if (hasReorderCallbacks) {
      for (let i = 0; i < capsuleSlots.length; i += 1) {
        const slotEl = capsuleSlots[i].el;
        const onSlotPointerDown = (e) => startSlotDrag(e, i);
        slotEl.addEventListener?.('pointerdown', onSlotPointerDown);
        slotPointerCleanups.push(() => {
          slotEl.removeEventListener?.('pointerdown', onSlotPointerDown);
        });
      }
    }

    function applyUpdatePayload({ data } = {}) {
      lastUpdatePayload = { data };
      const settings = data?.settings || {};
      const mountMode = normalizeClientWindowMountMode(
        settings.windowMountMode,
        settings.enableWindowOverlay
      );
      const multiMode = normalizeClientTopbarMultiSessionMode(
        settings.topbarMultiSessionMode,
        settings.showTopbarMultiSession
      );
      const slotKeys = normalizeClientTopbarSlots(settings.topbarCapsuleSlots);
      currentSlotKeys = [...slotKeys];

      const isComposer = mountMode === 'composer';
      const isSidebar = mountMode === 'sidebar';
      patchAttr(hostBarEl, 'data-mount-mode', mountMode);
      patchClasses(hostBarEl, {
        'is-composer': isComposer,
        'is-sidebar-only': isSidebar,
      });

      patchAttr(titlebarLeftMock, 'hidden', isComposer);
      patchAttr(composerLeftMock, 'hidden', !isComposer);
      patchAttr(composerSendMock, 'hidden', !isComposer);
      patchAttr(sidebarHintEl, 'hidden', !isSidebar);
      patchText(sidebarHintEl, t('settings.str.previewMountSidebarHint'));

      if (!data) {
        patchAttr(multiBtn, 'hidden', !isClientTopbarMultiSessionVisible(multiMode, 0));
        patchClasses(multiBtn, { 'is-running': false, 'is-waiting': false });
        patchCapsuleOdometerText(multiLabel, t('capsule.multiZero'), { resetKey: 'multi' });
        syncCapsuleSlotNodes(capsuleSlots, capsuleSeps, slotKeys, { hasTelemetry: false });
        syncSlotDragAffordances(slotKeys.length);
        return;
      }

      const { agents, scopedConv, ctxAgent, aggregated } = resolveScopedConversation(
        data,
        'all',
        resolveOverlayCtxInspectorAgentId(data, 'auto')
      );
      const slotCtx = buildCapsuleSlotContext(data, { scopedConv, ctxAgent, aggregated });
      const { runningCount, hasWaiting, multiBtnText } = resolveMultiSessionCapsuleState(data, {
        agents,
        aggregated,
        contextUsedPct: slotCtx.usedPct,
      });

      patchAttr(multiBtn, 'hidden', !isClientTopbarMultiSessionVisible(multiMode, runningCount));
      patchClasses(multiBtn, {
        'is-running': runningCount > 0 && !hasWaiting,
        'is-waiting': runningCount > 0 && hasWaiting,
      });
      patchCapsuleOdometerText(multiLabel, multiBtnText, { resetKey: 'multi' });

      patchClasses(capsuleBtn, { 'is-running': slotCtx.isRunning });
      syncCapsuleSlotNodes(capsuleSlots, capsuleSeps, slotKeys, slotCtx);
      syncSlotDragAffordances(slotKeys.length);
    }

    function update(payload = {}) {
      if (activeDrag) {
        pendingUpdatePayload = payload;
        return;
      }
      applyUpdatePayload(payload);
    }

    onCleanup(() => {
      teardownActiveDrag({ revert: false, flushPending: false });
      settleAnimator.clear();
      for (const cleanup of slotPointerCleanups) {
        cleanup();
      }
      slotPointerCleanups.length = 0;
    });

    return {
      el: rootEl,
      refs: {
        update,
        multiBtn,
        capsuleBtn,
        capsuleSlots,
        capsuleSeps,
        hostBarEl,
      },
    };
  },
});
