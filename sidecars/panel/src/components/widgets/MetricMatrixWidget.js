/**
 * @fileoverview Standalone decoupled Metric Matrix Widget (`MetricMatrixWidget.js`).
 * Renders user-selected telemetry cards dynamically via `metricRegistry.js` inside
 * a deterministic 4-column × (1 or 2)-row Bento grid supporting per-card discrete
 * sizes: Compact (`sm`, 1×1), Wide Trend (`wide`, 2×1), and Tall Hero Trend (`tall`, 2×2).
 *
 * Drag-to-resize and drag-to-reorder affordances are strictly opt-in via callbacks
 * (`onPreviewMetricSizes` / `onResizeMetricSizes` / `onReorderMetrics`) so live
 * overview and hover display surfaces stay 100% read-only.
 */

import { defineComponent } from '../../core/component.js';
import {
  applyRubberBand,
  areSlotListsEqual,
  buildReorderedItems,
  createDropSettleAnimator,
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchStyleVar,
  patchText,
  setTranslate3d,
  startPointerDragSession,
} from '../../core/domPatch.js';
import { SVG_NS } from '../../icons/SvgIcon.js';
import { getEffectiveLocale, t } from '../../i18n/index.js';
import {
  buildSparklineGeometry,
  extractOverviewMetricSeries,
  resolveAdaptiveSparklineSpec,
  resolveOverviewMetricCell,
  splitMetricValueAndUnit,
} from '../../registries/metricRegistry.js';
import {
  CLIENT_METRIC_GRID_COLS,
  normalizeClientMetricCardSize,
  normalizeClientMetricCardSizes,
  packClientMetricBentoLayout,
  resolveEffectiveClientMetricMatrixConfig,
  resolveScopedConversation,
} from '../../store/telemetryStore.js';
import { uiStore } from '../../store/uiStore.js';

let sparklineGradSeq = 0;

function extractToneClass(valueClass = '') {
  const m = String(valueClass || '').match(/\b(tone-(?:good|info|warn|danger|muted)|accent-(?:speed|ok))\b/);
  return m ? m[1] : '';
}

function isNodeWithin(target, container) {
  let cur = target;
  while (cur) {
    if (cur === container) return true;
    cur = cur.parentNode || cur.host || null;
  }
  return false;
}

function sameSizeMap(a, b) {
  const keysA = Object.keys(a || {});
  const keysB = Object.keys(b || {});
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

function buildNextSizesMap(baseSizes, key, nextSize) {
  const out = { ...(baseSizes || {}) };
  const cleanSize = normalizeClientMetricCardSize(nextSize);
  if (cleanSize === 'sm') {
    delete out[key];
  } else {
    out[key] = cleanSize;
  }
  return out;
}

function cycleMetricCardSize(currentEffSize, rows) {
  if (rows === 2) {
    if (currentEffSize === 'sm') return 'third';
    if (currentEffSize === 'third') return 'wide';
    if (currentEffSize === 'wide') return 'narrow';
    if (currentEffSize === 'narrow') return 'tall';
    return 'sm';
  }
  if (currentEffSize === 'sm') return 'third';
  if (currentEffSize === 'third') return 'wide';
  return 'sm';
}

function formatMetricSizeBadge(size) {
  if (size === 'tall') return `${t('settings.str.metricSizeTall')} 2×2`;
  if (size === 'narrow') return `${t('settings.str.metricSizeNarrow')} 1×2`;
  if (size === 'wide') return `${t('settings.str.metricSizeWide')} 2×1`;
  if (size === 'third') return `${t('settings.str.metricSizeThird')} 1/3`;
  return `${t('settings.str.metricSizeSm')} 1×1`;
}

function prefersReducedMotion() {
  try {
    return Boolean(
      typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)')?.matches
    );
  } catch {
    return false;
  }
}

function readMatrixGridGaps(matrixEl, cellEls) {
  let colGap = NaN;
  let rowGap = NaN;
  const getStyle =
    typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
      ? window.getComputedStyle
      : typeof getComputedStyle === 'function'
        ? getComputedStyle
        : null;
  if (getStyle && matrixEl) {
    try {
      const cs = getStyle(matrixEl);
      const cg = Number.parseFloat(cs?.columnGap);
      const rg = Number.parseFloat(cs?.rowGap);
      const g = Number.parseFloat(cs?.gap);
      if (Number.isFinite(cg) && cg > 0) colGap = cg;
      else if (Number.isFinite(g) && g > 0) colGap = g;
      if (Number.isFinite(rg) && rg > 0) rowGap = rg;
      else if (Number.isFinite(g) && g > 0) rowGap = g;
    } catch {}
  }
  if ((!Number.isFinite(colGap) || !Number.isFinite(rowGap)) && Array.isArray(cellEls) && cellEls.length > 1) {
    const rects = cellEls
      .map((el) => el?.getBoundingClientRect?.())
      .filter((r) => r && Number.isFinite(r.width) && r.width > 0 && Number.isFinite(r.height) && r.height > 0);
    let minHorizGap = Infinity;
    let minVertGap = Infinity;
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = 0; j < rects.length; j += 1) {
        if (i === j) continue;
        const a = rects[i];
        const b = rects[j];
        if (Math.abs(a.top - b.top) < 8 && b.left >= a.right - 0.5) {
          const dg = b.left - a.right;
          if (dg >= 0 && dg < minHorizGap) minHorizGap = dg;
        }
        if (Math.abs(a.left - b.left) < 8 && b.top >= a.bottom - 0.5) {
          const dg = b.top - a.bottom;
          if (dg >= 0 && dg < minVertGap) minVertGap = dg;
        }
      }
    }
    if (!Number.isFinite(colGap) && Number.isFinite(minHorizGap) && minHorizGap < 40) {
      colGap = minHorizGap;
    }
    if (!Number.isFinite(rowGap) && Number.isFinite(minVertGap) && minVertGap < 40) {
      rowGap = minVertGap;
    }
  }
  return {
    colGap: Number.isFinite(colGap) && colGap >= 0 ? colGap : 1,
    rowGap: Number.isFinite(rowGap) && rowGap >= 0 ? rowGap : 1,
  };
}

function computePlacementPixelRect(placement, layout, matrixRect, colGap, rowGap) {
  const cols = Math.max(1, Number(layout?.gridCols || CLIENT_METRIC_GRID_COLS));
  const rows = Math.max(1, Number(layout?.effectiveRows || 1));
  const colW = Math.max(4, (matrixRect.width - colGap * (cols - 1)) / cols);
  const rowH = Math.max(16, (matrixRect.height - rowGap * (rows - 1)) / rows);
  const left = matrixRect.left + (placement.colStart - 1) * (colW + colGap);
  const top = matrixRect.top + (placement.rowStart - 1) * (rowH + rowGap);
  const width = placement.colSpan * colW + (placement.colSpan - 1) * colGap;
  const height = placement.rowSpan * rowH + (placement.rowSpan - 1) * rowGap;
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    centerX: left + width * 0.5,
    centerY: top + height * 0.5,
  };
}

function createSparklineSvg(gradId) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'cell-sparkline-svg');
  svg.setAttribute('viewBox', '0 0 108 34');
  svg.setAttribute('preserveAspectRatio', 'xMaxYMid meet');
  svg.setAttribute('aria-hidden', 'true');

  const defs = document.createElementNS(SVG_NS, 'defs');
  const grad = document.createElementNS(SVG_NS, 'linearGradient');
  grad.setAttribute('id', gradId);
  grad.setAttribute('x1', '0');
  grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '0');
  grad.setAttribute('y2', '1');
  const stopTop = document.createElementNS(SVG_NS, 'stop');
  stopTop.setAttribute('offset', '0%');
  stopTop.setAttribute('stop-color', 'currentColor');
  stopTop.setAttribute('stop-opacity', '0.22');
  const stopBot = document.createElementNS(SVG_NS, 'stop');
  stopBot.setAttribute('offset', '100%');
  stopBot.setAttribute('stop-color', 'currentColor');
  stopBot.setAttribute('stop-opacity', '0');
  grad.appendChild(stopTop);
  grad.appendChild(stopBot);
  defs.appendChild(grad);

  const areaPath = document.createElementNS(SVG_NS, 'path');
  areaPath.setAttribute('class', 'cell-sparkline-area');
  areaPath.setAttribute('fill', `url(#${gradId})`);

  const polyline = document.createElementNS(SVG_NS, 'polyline');
  polyline.setAttribute('class', 'cell-sparkline-line');
  polyline.setAttribute('fill', 'none');
  polyline.setAttribute('stroke', 'currentColor');
  polyline.setAttribute('stroke-width', '1.65');
  polyline.setAttribute('stroke-linecap', 'round');
  polyline.setAttribute('stroke-linejoin', 'round');

  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('class', 'cell-sparkline-dot');
  dot.setAttribute('r', '2.75');
  dot.setAttribute('fill', 'currentColor');

  svg.appendChild(defs);
  svg.appendChild(areaPath);
  svg.appendChild(polyline);
  svg.appendChild(dot);

  return { svg, areaPath, polyline, dot };
}

function createCornerGripSvg() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'matrix-resize-grip-svg');
  svg.setAttribute('viewBox', '0 0 10 10');
  svg.setAttribute('width', '9');
  svg.setAttribute('height', '9');
  svg.setAttribute('aria-hidden', 'true');

  const line1 = document.createElementNS(SVG_NS, 'path');
  line1.setAttribute('d', 'M8.5 2.5L2.5 8.5');
  line1.setAttribute('stroke', 'currentColor');
  line1.setAttribute('stroke-width', '1.35');
  line1.setAttribute('stroke-linecap', 'round');

  const line2 = document.createElementNS(SVG_NS, 'path');
  line2.setAttribute('d', 'M8.5 6.2L6.2 8.5');
  line2.setAttribute('stroke', 'currentColor');
  line2.setAttribute('stroke-width', '1.35');
  line2.setAttribute('stroke-linecap', 'round');

  svg.appendChild(line1);
  svg.appendChild(line2);
  return svg;
}

export const MetricMatrixWidget = defineComponent({
  name: 'MetricMatrixWidget',
  setup({ props, onCleanup }) {
    const widgetMode = props?.mode === 'hover' ? 'hover' : 'overview';
    const hasMetricReorder =
      typeof props?.onReorderMetrics === 'function' || typeof props?.onPreviewMetrics === 'function';
    const hasMetricResize =
      typeof props?.onResizeMetricSizes === 'function' ||
      typeof props?.onPreviewMetricSizes === 'function';
    const onRequestVerticalDrag =
      typeof props?.onRequestVerticalDrag === 'function' ? props.onRequestVerticalDrag : null;
    const canParentDragModule =
      typeof props?.canDragParentModule === 'function' ? props.canDragParentModule : () => false;
    const getCtxAgentId =
      typeof props?.getCtxAgentId === 'function'
        ? props.getCtxAgentId
        : () => uiStore.getState().ctxInspectorAgentId;

    const matrixEl = h('section', {
      className: 'telemetry-matrix',
      'aria-label': t('module.metrics'),
      'data-cols': '4',
      'data-rows': '1',
    });
    patchStyleVar(matrixEl, '--matrix-cols', '4');
    patchStyleVar(matrixEl, '--matrix-rows', '1');

    let currentVisibleKeys = [];
    let currentOverflowKeys = [];
    let currentLayoutRows = 1;
    let currentEffectiveRows = 1;
    let currentGridCols = 4;
    let currentSizesMap = {};
    let currentPlacementsByKey = new Map();
    let draggingSizesOverride = null;
    let resizingKey = null;
    let lastUpdatePayload = null;
    let pendingUpdatePayload = null;
    let activeDrag = null;
    let activeResize = null;
    let suppressResizeClick = false;
    let suppressResizeClickTimer = null;
    let lastLayoutGeomSig = '';
    let lastSparkGeomSig = '';
    let pendingSparkResizeRafId = 0;
    let pendingSparkResizeMicrotask = false;
    let skipNextFlip = false;
    let flipRafId = 0;
    let flipCleanupTimer = null;
    let activeFlipEls = [];
    let resizePullEl = null;
    const measuredWrapSizeByKey = new Map();
    const observedWrapToKey = new Map();
    const ghostElPool = [];
    const dropPreviewEl = hasMetricReorder
      ? h('div', {
          className: 'matrix-drop-preview',
          'aria-hidden': 'true',
          hidden: true,
        })
      : null;
    const settleAnimator = createDropSettleAnimator('is-settling', ' scale(1.02)');

    function getMetricCellEls() {
      return Array.from(matrixEl.children || []).filter((child) =>
        child?.classList?.contains?.('matrix-cell')
      );
    }

    function getMetricCellByKey(key) {
      if (!key) return null;
      return getMetricCellEls().find((el) => el?.getAttribute?.('data-metric-key') === key) || null;
    }

    function clearResizePullVisual() {
      if (!resizePullEl) return;
      const el = resizePullEl;
      resizePullEl = null;
      if (el?.style && !el.classList?.contains?.('is-bento-flipping')) {
        el.style.transformOrigin = '';
        el.style.transform = '';
      }
    }

    function clearFlipAnimation() {
      if (flipRafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(flipRafId);
        flipRafId = 0;
      }
      if (flipCleanupTimer) {
        clearTimeout(flipCleanupTimer);
        flipCleanupTimer = null;
      }
      patchClasses(matrixEl, { 'is-bento-animating': false });
      if (activeFlipEls.length > 0) {
        for (const el of activeFlipEls) {
          patchClasses(el, { 'is-bento-flipping': false });
          if (el?.style && !el.classList?.contains?.('is-cell-dragging')) {
            el.style.transition = '';
            el.style.transformOrigin = '';
            el.style.transform = '';
          }
        }
        activeFlipEls = [];
      }
    }

    function captureFlipRects() {
      const map = new Map();
      for (const el of getMetricCellEls()) {
        const key = el?.getAttribute?.('data-metric-key');
        const r = el?.getBoundingClientRect?.();
        if (key && r && Number.isFinite(r.width) && r.width > 0 && Number.isFinite(r.height) && r.height > 0) {
          map.set(key, { left: r.left, top: r.top, width: r.width, height: r.height });
        }
      }
      clearFlipAnimation();
      clearResizePullVisual();
      return map;
    }

    function playFlipFrom(beforeRects) {
      if (!beforeRects || beforeRects.size === 0) return;
      if (prefersReducedMotion() || typeof requestAnimationFrame !== 'function') return;
      const animated = [];
      for (const el of getMetricCellEls()) {
        const key = el?.getAttribute?.('data-metric-key');
        if (!key || !beforeRects.has(key)) continue;
        const prev = beforeRects.get(key);
        const next = el?.getBoundingClientRect?.();
        if (!next || !Number.isFinite(next.width) || next.width <= 0 || !Number.isFinite(next.height) || next.height <= 0) {
          continue;
        }
        const dx = prev.left - next.left;
        const dy = prev.top - next.top;
        const sx = prev.width / next.width;
        const sy = prev.height / next.height;
        if (
          Math.abs(dx) > 0.5 ||
          Math.abs(dy) > 0.5 ||
          Math.abs(sx - 1) > 0.015 ||
          Math.abs(sy - 1) > 0.015
        ) {
          animated.push({ el, dx, dy, sx, sy });
        }
      }
      if (animated.length === 0) return;
      clearFlipAnimation();
      activeFlipEls = animated.map((item) => item.el);
      patchClasses(matrixEl, { 'is-bento-animating': true });
      for (const item of animated) {
        if (!item.el?.style) continue;
        item.el.style.transition = 'none';
        item.el.style.transformOrigin = '0 0';
        item.el.style.transform = `translate3d(${item.dx.toFixed(2)}px, ${item.dy.toFixed(2)}px, 0) scale(${item.sx.toFixed(4)}, ${item.sy.toFixed(4)})`;
        patchClasses(item.el, { 'is-bento-flipping': true });
      }
      void matrixEl.offsetWidth;
      const batchEls = activeFlipEls;
      flipRafId = requestAnimationFrame(() => {
        flipRafId = 0;
        if (activeFlipEls !== batchEls) return;
        for (const item of animated) {
          if (!item.el?.style) continue;
          item.el.style.transition = '';
          item.el.style.transform = 'translate3d(0px, 0px, 0) scale(1, 1)';
        }
      });
      flipCleanupTimer = setTimeout(() => {
        if (activeFlipEls === batchEls) {
          clearFlipAnimation();
        }
      }, 250);
    }

    function clearResizeClickSuppression() {
      if (suppressResizeClickTimer) {
        clearTimeout(suppressResizeClickTimer);
        suppressResizeClickTimer = null;
      }
      suppressResizeClick = false;
    }

    function armResizeClickSuppression() {
      clearResizeClickSuppression();
      suppressResizeClick = true;
      suppressResizeClickTimer = setTimeout(() => {
        suppressResizeClickTimer = null;
        suppressResizeClick = false;
      }, 120);
    }

    function persistOptimisticMetricSizes(nextSizes) {
      const clean = normalizeClientMetricCardSizes(nextSizes);
      currentSizesMap = clean;
      if (lastUpdatePayload?.data) {
        const prevSettings = lastUpdatePayload.data.settings || {};
        const syncOverview =
          widgetMode !== 'hover' || prevSettings.hoverSyncOverviewMetrics !== false;
        lastUpdatePayload = {
          data: {
            ...lastUpdatePayload.data,
            settings: {
              ...prevSettings,
              ...(syncOverview
                ? { overviewMetricSizes: clean }
                : { hoverMetricSizes: clean }),
            },
          },
        };
      }
    }

    function teardownActiveResize({ revert = false } = {}) {
      if (!activeResize) return;
      const { startSizes, getWorkingSizes, session } = activeResize;
      const moved = session.isMoved();
      activeResize = null;
      draggingSizesOverride = null;
      resizingKey = null;
      clearResizePullVisual();
      session.cancel(true);
      patchClasses(matrixEl, { 'is-resizing-metric': false });
      if (revert && moved && !sameSizeMap(startSizes, getWorkingSizes())) {
        props?.onPreviewMetricSizes?.({ ...startSizes });
      }
      if (revert && lastUpdatePayload) {
        applyUpdatePayload(lastUpdatePayload);
      }
    }

    function commitMetricCardSizeImmediate(cellKey, nextSize) {
      if (!hasMetricResize || !cellKey) return;
      const nextSizes = buildNextSizesMap(currentSizesMap, cellKey, nextSize);
      if (sameSizeMap(currentSizesMap, nextSizes)) return;
      persistOptimisticMetricSizes(nextSizes);
      applyUpdatePayload(lastUpdatePayload);
      props?.onPreviewMetricSizes?.({ ...nextSizes });
      props?.onResizeMetricSizes?.({ ...nextSizes });
      scheduleAdaptiveSparklineRepaint();
    }

    function startMetricCardResize(e, cellKey) {
      if (!hasMetricResize || activeDrag || !cellKey) return;
      if (e && e.button != null && e.button !== 0) return;
      const placement = currentPlacementsByKey.get(cellKey);
      if (!placement) return;
      e?.preventDefault?.();
      e?.stopPropagation?.();
      if (activeResize) teardownActiveResize({ revert: false });

      const startSizes = { ...currentSizesMap };
      const startEffSize = placement.size;
      const rowsAtStart = currentLayoutRows;
      const effectiveRowsAtStart = Math.max(1, currentEffectiveRows);
      const startLogicalCols =
        startEffSize === 'wide' || startEffSize === 'tall'
          ? 6
          : startEffSize === 'third'
            ? 4
            : 3;
      const startLogicalRows = startEffSize === 'narrow' || startEffSize === 'tall' ? 2 : 1;

      const matrixRect = matrixEl.getBoundingClientRect?.();
      const rawMatrixW = Number(matrixRect?.width || 0);
      const rawMatrixH = Number(matrixRect?.height || 0);
      const gridColsAtStart = Math.max(1, currentGridCols || CLIENT_METRIC_GRID_COLS);
      const unitW =
        Number.isFinite(rawMatrixW) && rawMatrixW > 0 ? rawMatrixW / gridColsAtStart : 32;
      const unitH =
        Number.isFinite(rawMatrixH) && rawMatrixH > 0
          ? rawMatrixH / effectiveRowsAtStart
          : 62;

      let workingSize = startEffSize;
      let workingSizes = { ...startSizes };

      function resolveSnappedSize(clientX, clientY, startX, startY) {
        const spanCols = startLogicalCols + (Number(clientX) - Number(startX)) / Math.max(8, unitW);
        const spanRows = startLogicalRows + (Number(clientY) - Number(startY)) / Math.max(24, unitH);
        const curIsTall = workingSize === 'narrow' || workingSize === 'tall';
        const nextIsTall =
          rowsAtStart === 2 ? (curIsTall ? spanRows > 1.28 : spanRows >= 1.45) : false;
        if (nextIsTall) {
          const curIsWide = workingSize === 'wide' || workingSize === 'tall';
          const nextIsWide = curIsWide ? spanCols > 4.25 : spanCols >= 4.65;
          return nextIsWide ? 'tall' : 'narrow';
        }
        if (workingSize === 'wide' || workingSize === 'tall') {
          if (spanCols <= 3.35) return 'sm';
          if (spanCols <= 4.75) return 'third';
          return 'wide';
        }
        if (workingSize === 'third') {
          if (spanCols >= 5.15) return 'wide';
          if (spanCols <= 3.35) return 'sm';
          return 'third';
        }
        if (spanCols >= 5.15) return 'wide';
        if (spanCols >= 3.55) return 'third';
        return 'sm';
      }

      const session = startPointerDragSession(e, {
        threshold: 4,
        onStart: () => {
          resizingKey = cellKey;
          draggingSizesOverride = { ...startSizes };
          patchClasses(matrixEl, { 'is-resizing-metric': true });
          if (lastUpdatePayload) {
            applyUpdatePayload(lastUpdatePayload);
          }
        },
        onMove: ({ clientX, clientY, startX, startY }) => {
          const nextSize = resolveSnappedSize(clientX, clientY, startX, startY);
          if (nextSize !== workingSize) {
            workingSize = nextSize;
            workingSizes = buildNextSizesMap(startSizes, cellKey, nextSize);
            draggingSizesOverride = { ...workingSizes };
            if (lastUpdatePayload) {
              applyUpdatePayload(lastUpdatePayload);
            }
            props?.onPreviewMetricSizes?.({ ...workingSizes });
          } else if (!prefersReducedMotion()) {
            const targetCell = getMetricCellByKey(cellKey);
            if (targetCell?.style && !targetCell.classList?.contains?.('is-bento-flipping')) {
              const targetLogicalCols =
                workingSize === 'wide' || workingSize === 'tall'
                  ? 6
                  : workingSize === 'third'
                    ? 4
                    : 3;
              const targetLogicalRows = workingSize === 'narrow' || workingSize === 'tall' ? 2 : 1;
              const remCols =
                (startLogicalCols -
                  targetLogicalCols +
                  (Number(clientX) - Number(startX)) / Math.max(8, unitW)) /
                3;
              const remRows =
                startLogicalRows -
                targetLogicalRows +
                (Number(clientY) - Number(startY)) / Math.max(24, unitH);
              const pullX = Math.max(-0.045, Math.min(0.055, remCols * 0.06));
              const pullY =
                rowsAtStart === 2
                  ? Math.max(-0.045, Math.min(0.055, remRows * 0.06))
                  : 0;
              resizePullEl = targetCell;
              targetCell.style.transformOrigin = '0 0';
              targetCell.style.transform = `scale(${(1 + pullX).toFixed(4)}, ${(1 + pullY).toFixed(4)})`;
            }
          }
        },
        onEnd: ({ moved, cancelled }) => {
          armResizeClickSuppression();
          if (cancelled) {
            teardownActiveResize({ revert: true });
            return;
          }
          if (!moved) {
            teardownActiveResize({ revert: false });
            commitMetricCardSizeImmediate(
              cellKey,
              cycleMetricCardSize(startEffSize, rowsAtStart)
            );
            return;
          }
          const finalSizes = { ...workingSizes };
          const changed = !sameSizeMap(startSizes, finalSizes);
          teardownActiveResize({ revert: false });
          if (changed) {
            persistOptimisticMetricSizes(finalSizes);
            if (lastUpdatePayload) {
              applyUpdatePayload(lastUpdatePayload);
            }
            props?.onResizeMetricSizes?.({ ...finalSizes });
            scheduleAdaptiveSparklineRepaint();
          } else if (lastUpdatePayload) {
            applyUpdatePayload(lastUpdatePayload);
          }
        },
      });

      activeResize = {
        startSizes,
        getWorkingSizes: () => workingSizes,
        session,
      };
    }

    function scheduleAdaptiveSparklineRepaint() {
      if (activeDrag || !lastUpdatePayload) return;
      if (typeof requestAnimationFrame === 'function') {
        if (pendingSparkResizeRafId) return;
        pendingSparkResizeRafId = requestAnimationFrame(() => {
          pendingSparkResizeRafId = 0;
          if (!activeDrag && lastUpdatePayload) {
            applyUpdatePayload(lastUpdatePayload);
          }
        });
        return;
      }
      if (pendingSparkResizeMicrotask) return;
      pendingSparkResizeMicrotask = true;
      queueMicrotask(() => {
        pendingSparkResizeMicrotask = false;
        if (!activeDrag && lastUpdatePayload) {
          applyUpdatePayload(lastUpdatePayload);
        }
      });
    }

    const sparkResizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver((entries) => {
            if (!Array.isArray(entries) || entries.length === 0) return;
            let changed = false;
            for (const entry of entries) {
              const wrapEl = entry?.target;
              if (!wrapEl) continue;
              const key = observedWrapToKey.get(wrapEl);
              if (!key) continue;
              const rawW = Number(entry?.contentRect?.width || wrapEl.clientWidth || 0);
              const rawH = Number(entry?.contentRect?.height || wrapEl.clientHeight || 0);
              if (!Number.isFinite(rawW) || rawW <= 0) continue;
              const nextW = Math.round(rawW);
              const nextH = Number.isFinite(rawH) && rawH > 0 ? Math.round(rawH) : 0;
              const prev = measuredWrapSizeByKey.get(key);
              const prevW = prev?.width || 0;
              const prevH = prev?.height || 0;
              if (Math.abs(nextW - prevW) >= 2 || (nextH > 0 && Math.abs(nextH - prevH) >= 2)) {
                measuredWrapSizeByKey.set(key, {
                  width: nextW,
                  height: nextH > 0 ? nextH : prevH,
                });
                changed = true;
              }
            }
            if (changed) {
              scheduleAdaptiveSparklineRepaint();
            }
          })
        : null;

    function syncObservedSparklineWraps(activeKeys) {
      if (!sparkResizeObserver) return;
      const activeKeySet = new Set(activeKeys);
      for (const [wrapEl, key] of observedWrapToKey.entries()) {
        if (!activeKeySet.has(key) || !matrixEl.contains?.(wrapEl)) {
          sparkResizeObserver.unobserve(wrapEl);
          observedWrapToKey.delete(wrapEl);
        }
      }
    }

    function readLiveSparklineSizes(sparkGeomSig, trendKeys) {
      if (trendKeys.length === 0) {
        measuredWrapSizeByKey.clear();
        return;
      }
      if (sparkGeomSig !== lastSparkGeomSig) {
        measuredWrapSizeByKey.clear();
        return;
      }
      const keySet = new Set(trendKeys);
      for (const key of Array.from(measuredWrapSizeByKey.keys())) {
        if (!keySet.has(key)) measuredWrapSizeByKey.delete(key);
      }
      for (const cellEl of getMetricCellEls()) {
        const key = cellEl?.getAttribute?.('data-metric-key');
        if (!key || !keySet.has(key)) continue;
        const wrapEl = cellEl.querySelector?.('.cell-sparkline-wrap');
        const liveW = Math.round(Number(wrapEl?.clientWidth || 0));
        const liveH = Math.round(Number(wrapEl?.clientHeight || 0));
        if (Number.isFinite(liveW) && liveW > 0) {
          const prev = measuredWrapSizeByKey.get(key);
          const prevW = prev?.width || 0;
          const prevH = prev?.height || 0;
          if (
            Math.abs(liveW - prevW) >= 2 ||
            prevW === 0 ||
            (Number.isFinite(liveH) && liveH > 0 && (Math.abs(liveH - prevH) >= 2 || prevH === 0))
          ) {
            measuredWrapSizeByKey.set(key, {
              width: liveW,
              height: Number.isFinite(liveH) && liveH > 0 ? liveH : prevH,
            });
          }
        }
      }
    }

    function hideDropPreview() {
      if (!dropPreviewEl) return;
      patchAttr(dropPreviewEl, 'hidden', true);
      if (dropPreviewEl.style) {
        dropPreviewEl.style.transform = '';
        dropPreviewEl.style.width = '';
        dropPreviewEl.style.height = '';
      }
    }

    function updateDropPreview(rect, matrixLeft, matrixTop, { instant = false } = {}) {
      if (!dropPreviewEl || !rect) return;
      const wasHidden = dropPreviewEl.hasAttribute?.('hidden') || dropPreviewEl.parentNode !== matrixEl;
      if (dropPreviewEl.parentNode !== matrixEl) {
        matrixEl.appendChild(dropPreviewEl);
      }
      if ((instant || wasHidden) && dropPreviewEl.style) {
        dropPreviewEl.style.transition = 'none';
      }
      patchAttr(dropPreviewEl, 'hidden', false);
      if (dropPreviewEl.style) {
        dropPreviewEl.style.width = `${Math.max(12, rect.width).toFixed(2)}px`;
        dropPreviewEl.style.height = `${Math.max(12, rect.height).toFixed(2)}px`;
        setTranslate3d(dropPreviewEl, rect.left - matrixLeft, rect.top - matrixTop);
        if (instant || wasHidden) {
          void dropPreviewEl.offsetWidth;
          dropPreviewEl.style.transition = '';
        }
      }
    }

    function resetDragVisuals() {
      hideDropPreview();
      patchClasses(matrixEl, { 'is-dragging-matrix': false });
      for (const cellEl of getMetricCellEls()) {
        patchClasses(cellEl, { 'is-cell-dragging': false, 'is-cell-drag-sibling': false });
        if (cellEl?.style) {
          cellEl.style.transition = '';
          cellEl.style.transformOrigin = '';
          cellEl.style.transform = '';
        }
      }
    }

    function teardownActiveDrag({ revert = false, flushPending = true } = {}) {
      if (!activeDrag) return;
      const { startVisible, overflowTail, getWorkingVisible, session } = activeDrag;
      const moved = session.isMoved();
      activeDrag = null;
      session.cancel(true);
      resetDragVisuals();
      if (revert && moved && !areSlotListsEqual(startVisible, getWorkingVisible())) {
        props?.onPreviewMetrics?.([...startVisible, ...overflowTail]);
      }
      if (flushPending && pendingUpdatePayload) {
        const queued = pendingUpdatePayload;
        pendingUpdatePayload = null;
        applyUpdatePayload(queued);
      }
    }

    function startMetricCellDrag(e, startIdx) {
      if (!hasMetricReorder || activeResize || (e && e.button != null && e.button !== 0)) return;
      if (currentVisibleKeys.length <= 1 || startIdx < 0 || startIdx >= currentVisibleKeys.length) {
        return;
      }
      e?.preventDefault?.();
      e?.stopPropagation?.();
      if (activeDrag) teardownActiveDrag({ revert: false, flushPending: true });
      clearFlipAnimation();
      settleAnimator.clear();

      const startVisible = [...currentVisibleKeys];
      const overflowTail = [...currentOverflowKeys];
      const dragKey = startVisible[startIdx];
      const count = startVisible.length;
      const cellEls = getMetricCellEls().slice(0, count);
      if (cellEls.length !== count) return;
      const draggedEl = cellEls[startIdx];
      const cellElByKey = new Map();
      for (let i = 0; i < count; i += 1) {
        cellElByKey.set(startVisible[i], cellEls[i]);
      }

      const dragRows = currentLayoutRows;
      const dragSizes = { ...currentSizesMap };
      let workingVisible = [...startVisible];
      let candidates = [];
      let activeCandidate = null;
      let origRectsByKey = new Map();
      let origDraggedRect = null;
      let baseMatrixRect = { left: 0, top: 0, width: 400, height: 72, right: 400, bottom: 72 };
      let isMultiRow = false;
      let hasMatrixRect = false;
      let lastDragOffsetX = 0;
      let lastDragOffsetY = 0;

      function applyCandidateTransforms(cand) {
        if (!cand) return;
        updateDropPreview(cand.draggedRect, baseMatrixRect.left, baseMatrixRect.top);
        for (let i = 0; i < count; i += 1) {
          const key = startVisible[i];
          if (key === dragKey) continue;
          const el = cellElByKey.get(key);
          const fromRect = origRectsByKey.get(key);
          const toRect = cand.rectsByKey.get(key);
          if (!el || !fromRect || !toRect) continue;
          const dx = toRect.left - fromRect.left;
          const dy = toRect.top - fromRect.top;
          const sx = fromRect.width > 0 ? toRect.width / fromRect.width : 1;
          const sy = fromRect.height > 0 ? toRect.height / fromRect.height : 1;
          if (Math.abs(sx - 1) > 0.015 || Math.abs(sy - 1) > 0.015) {
            if (el.style) el.style.transformOrigin = '0 0';
            setTranslate3d(el, dx, dy, ` scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`);
          } else {
            if (el.style) el.style.transformOrigin = '';
            setTranslate3d(el, dx, dy);
          }
        }
      }

      const session = startPointerDragSession(e, {
        threshold: 4,
        onStart: ({ startX, startY, clientX, clientY }) => {
          const measuredRects = [];
          for (let i = 0; i < count; i += 1) {
            const key = startVisible[i];
            const r = cellEls[i]?.getBoundingClientRect?.();
            const ok = Boolean(r && Number.isFinite(r.width) && r.width > 0 && Number.isFinite(r.height) && r.height > 0);
            const width = ok ? r.width : 110;
            const height = ok ? r.height : 64;
            const left = ok ? r.left : i * 116;
            const top = ok ? r.top : 0;
            const rectObj = {
              left,
              top,
              width,
              height,
              right: left + width,
              bottom: top + height,
              centerX: left + width * 0.5,
              centerY: top + height * 0.5,
            };
            measuredRects.push(rectObj);
            origRectsByKey.set(key, rectObj);
          }
          origDraggedRect = origRectsByKey.get(dragKey);
          isMultiRow =
            currentEffectiveRows > 1 ||
            measuredRects.some((r) => Math.abs(r.top - measuredRects[0].top) > 10);
          if (
            !isMultiRow &&
            onRequestVerticalDrag &&
            canParentDragModule() &&
            Math.abs(clientY - startY) > Math.abs(clientX - startX) * 1.15
          ) {
            activeDrag = null;
            onRequestVerticalDrag(e, clientX, clientY);
            return false;
          }

          const mr = matrixEl?.getBoundingClientRect?.();
          hasMatrixRect = Boolean(mr && Number.isFinite(mr.width) && mr.width > 0 && Number.isFinite(mr.height) && mr.height > 0);
          if (hasMatrixRect) {
            baseMatrixRect = {
              left: mr.left,
              top: mr.top,
              width: mr.width,
              height: mr.height,
              right: mr.left + mr.width,
              bottom: mr.top + mr.height,
            };
          } else {
            const minLeft = Math.min(...measuredRects.map((r) => r.left));
            const minTop = Math.min(...measuredRects.map((r) => r.top));
            const maxRight = Math.max(...measuredRects.map((r) => r.right));
            const maxBottom = Math.max(...measuredRects.map((r) => r.bottom));
            baseMatrixRect = {
              left: minLeft,
              top: minTop,
              width: Math.max(100, maxRight - minLeft),
              height: Math.max(64, maxBottom - minTop),
              right: maxRight,
              bottom: maxBottom,
            };
          }

          const { colGap, rowGap } = readMatrixGridGaps(matrixEl, cellEls);
          const bySlotKey = new Map();
          for (let candIdx = 0; candIdx < count; candIdx += 1) {
            const candOrder = buildReorderedItems(startVisible, startIdx, candIdx);
            const candLayout = packClientMetricBentoLayout({
              rows: dragRows,
              metrics: candOrder,
              sizes: dragSizes,
              includeGhostCells: hasMetricResize,
            });
            if (candLayout.placements.length !== count) continue;
            const draggedPlacement = candLayout.placements.find((p) => p.key === dragKey);
            if (!draggedPlacement) continue;
            const rectsByKey = new Map();
            for (const p of candLayout.placements) {
              rectsByKey.set(
                p.key,
                candIdx === startIdx && origRectsByKey.has(p.key)
                  ? origRectsByKey.get(p.key)
                  : computePlacementPixelRect(p, candLayout, baseMatrixRect, colGap, rowGap)
              );
            }
            const draggedRect = rectsByKey.get(dragKey);
            const slotKey = `${draggedPlacement.colStart}:${draggedPlacement.colSpan}:${draggedPlacement.rowStart}:${draggedPlacement.rowSpan}`;
            const candObj = {
              candIdx,
              order: candOrder,
              layout: candLayout,
              rectsByKey,
              draggedRect,
              distFromStart: Math.abs(candIdx - startIdx),
            };
            const existing = bySlotKey.get(slotKey);
            if (!existing || candObj.distFromStart < existing.distFromStart) {
              bySlotKey.set(slotKey, candObj);
            }
          }
          candidates = Array.from(bySlotKey.values());
          activeCandidate =
            candidates.find((c) => c.candIdx === startIdx) ||
            candidates[0] || {
              candIdx: startIdx,
              order: [...startVisible],
              rectsByKey: origRectsByKey,
              draggedRect: origDraggedRect,
            };
          if (candidates.length === 0) {
            candidates = [activeCandidate];
          }

          patchClasses(matrixEl, { 'is-dragging-matrix': true });
          for (let k = 0; k < count; k += 1) {
            patchClasses(cellEls[k], {
              'is-cell-dragging': k === startIdx,
              'is-cell-drag-sibling': k !== startIdx,
            });
          }
          applyCandidateTransforms(activeCandidate);
        },
        onMove: ({ clientX, clientY, startX, startY }) => {
          const mr = hasMatrixRect ? matrixEl?.getBoundingClientRect?.() : null;
          const rawDeltaX = clientX - startX - (mr && mr.width > 0 ? mr.left - baseMatrixRect.left : 0);
          const rawDeltaY = clientY - startY - (mr && mr.width > 0 ? mr.top - baseMatrixRect.top : 0);

          const clampedX = applyRubberBand(
            rawDeltaX,
            baseMatrixRect.left - origDraggedRect.left,
            baseMatrixRect.right - origDraggedRect.right,
            14,
            0.25
          );
          const clampedY = isMultiRow
            ? applyRubberBand(
                rawDeltaY,
                baseMatrixRect.top - origDraggedRect.top,
                baseMatrixRect.bottom - origDraggedRect.bottom,
                14,
                0.25
              )
            : rawDeltaY === 0
              ? 0
              : Math.sign(rawDeltaY) * Math.min(8, Math.abs(rawDeltaY) * 0.18);

          lastDragOffsetX = clampedX;
          lastDragOffsetY = clampedY;
          setTranslate3d(draggedEl, clampedX, clampedY, ' scale(1.02)');

          const cx = origDraggedRect.centerX + rawDeltaX;
          const cy = origDraggedRect.centerY + rawDeltaY;
          let bestCand = activeCandidate;
          let bestScore = Infinity;
          for (let i = 0; i < candidates.length; i += 1) {
            const cand = candidates[i];
            const dist = isMultiRow
              ? Math.hypot(cx - cand.draggedRect.centerX, cy - cand.draggedRect.centerY)
              : Math.abs(cx - cand.draggedRect.centerX);
            const score = cand === activeCandidate ? dist - 6 : dist;
            if (score < bestScore) {
              bestScore = score;
              bestCand = cand;
            }
          }
          if (bestCand && bestCand !== activeCandidate) {
            activeCandidate = bestCand;
            workingVisible = [...bestCand.order];
            applyCandidateTransforms(activeCandidate);
            props?.onPreviewMetrics?.([...workingVisible, ...overflowTail]);
          }
        },
        onEnd: ({ moved, cancelled }) => {
          if (cancelled) {
            teardownActiveDrag({ revert: true, flushPending: true });
            return;
          }
          const finalCand = activeCandidate;
          const finalVisible = [...workingVisible];
          const finalFull = [...finalVisible, ...overflowTail];
          const targetOffsetX =
            moved && finalCand?.draggedRect && origDraggedRect
              ? finalCand.draggedRect.left - origDraggedRect.left
              : 0;
          const targetOffsetY =
            moved && finalCand?.draggedRect && origDraggedRect
              ? finalCand.draggedRect.top - origDraggedRect.top
              : 0;
          const residualX = moved ? lastDragOffsetX - targetOffsetX : 0;
          const residualY = moved ? lastDragOffsetY - targetOffsetY : 0;
          const changed = moved && !areSlotListsEqual(startVisible, finalVisible);

          teardownActiveDrag({ revert: false, flushPending: !changed });
          if (changed) {
            pendingUpdatePayload = null;
            currentVisibleKeys = finalVisible;
            if (lastUpdatePayload?.data) {
              const prevSettings = lastUpdatePayload.data.settings || {};
              const syncOverview =
                widgetMode !== 'hover' || prevSettings.hoverSyncOverviewMetrics !== false;
              skipNextFlip = true;
              applyUpdatePayload({
                data: {
                  ...lastUpdatePayload.data,
                  settings: {
                    ...prevSettings,
                    ...(syncOverview ? { overviewMetrics: finalFull } : { hoverMetrics: finalFull }),
                  },
                },
              });
            }
            props?.onReorderMetrics?.(finalFull);
          }
          const landedCell = getMetricCellByKey(dragKey);
          if (moved && landedCell) {
            settleAnimator.trigger(landedCell, residualX, residualY);
          }
        },
      });

      activeDrag = { startVisible, overflowTail, getWorkingVisible: () => workingVisible, session };
    }

    function syncGhostCells(ghostSpecs) {
      const targetCount = Array.isArray(ghostSpecs) ? ghostSpecs.length : 0;
      while (ghostElPool.length < targetCount) {
        ghostElPool.push(
          h('div', {
            className: 'matrix-ghost-cell',
            'aria-hidden': 'true',
          })
        );
      }
      for (let i = 0; i < ghostElPool.length; i += 1) {
        const ghostEl = ghostElPool[i];
        if (i < targetCount) {
          const spec = ghostSpecs[i];
          patchStyleVar(ghostEl, '--ghost-col-start', String(spec.colStart));
          patchStyleVar(ghostEl, '--ghost-col-span', String(spec.colSpan || 3));
          patchStyleVar(ghostEl, '--ghost-row-start', String(spec.rowStart));
          if (ghostEl.parentNode !== matrixEl) {
            matrixEl.appendChild(ghostEl);
          }
        } else if (ghostEl.parentNode === matrixEl) {
          matrixEl.removeChild(ghostEl);
        }
      }
    }

    function createMetricCellNode() {
      let boundMetricKey = '';
      const gradId = `wm-spark-grad-${++sparklineGradSeq}`;
      const labelSpan = h('span', { text: '—' });
      const valueMainEl = h('span', { className: 'cell-value-main', text: '—' });
      const valueUnitEl = h('span', { className: 'cell-value-unit', hidden: true, text: '' });
      const valueEl = h('strong', { className: 'cell-value' }, [valueMainEl, valueUnitEl]);
      const subEl = h('span', { className: 'cell-sub', text: '—' });

      const trendNumEl = h('strong', { className: 'cell-trend-num', text: '—' });
      const trendUnitEl = h('span', { className: 'cell-trend-unit', text: '' });
      const trendMetricEl = h('div', { className: 'cell-trend-metric', hidden: true }, [
        trendNumEl,
        trendUnitEl,
      ]);
      const trendSubEl = h('span', { className: 'cell-trend-sub', hidden: true, text: '—' });
      const spark = createSparklineSvg(gradId);
      const sparkWrapEl = h('div', { className: 'cell-sparkline-wrap', hidden: true }, [
        spark.svg,
      ]);

      const sizeBadgeEl = hasMetricResize
        ? h('span', {
            className: 'matrix-cell-size-badge text-mono',
            'aria-hidden': 'true',
            hidden: true,
            text: '',
          })
        : null;

      const resizeHandleEl = hasMetricResize
        ? h(
            'button',
            {
              type: 'button',
              className: 'matrix-cell-resize-handle',
              'aria-label': t('settings.str.metricResizeHandleAria'),
              title: t('settings.str.metricResizeHandleHint'),
              onPointerdown: (e) => startMetricCardResize(e, boundMetricKey),
              onClick: (e) => {
                e?.preventDefault?.();
                e?.stopPropagation?.();
                if (suppressResizeClick) {
                  clearResizeClickSuppression();
                  return;
                }
                const placement = currentPlacementsByKey.get(boundMetricKey);
                if (!placement) return;
                commitMetricCardSizeImmediate(
                  boundMetricKey,
                  cycleMetricCardSize(placement.size, currentLayoutRows)
                );
              },
              onKeydown: (e) => {
                if (!hasMetricResize || !boundMetricKey) return;
                const placement = currentPlacementsByKey.get(boundMetricKey);
                if (!placement) return;
                if (e?.key === 'Enter' || e?.key === ' ') {
                  e.preventDefault?.();
                  e.stopPropagation?.();
                  commitMetricCardSizeImmediate(
                    boundMetricKey,
                    cycleMetricCardSize(placement.size, currentLayoutRows)
                  );
                } else if (e?.key === 'ArrowRight') {
                  e.preventDefault?.();
                  e.stopPropagation?.();
                  if (placement.size === 'sm') {
                    commitMetricCardSizeImmediate(boundMetricKey, 'third');
                  } else if (placement.size === 'third') {
                    commitMetricCardSizeImmediate(boundMetricKey, 'wide');
                  } else if (placement.size === 'narrow') {
                    commitMetricCardSizeImmediate(boundMetricKey, 'tall');
                  }
                } else if (e?.key === 'ArrowLeft') {
                  e.preventDefault?.();
                  e.stopPropagation?.();
                  if (placement.size === 'wide') {
                    commitMetricCardSizeImmediate(boundMetricKey, 'third');
                  } else if (placement.size === 'third') {
                    commitMetricCardSizeImmediate(boundMetricKey, 'sm');
                  } else if (placement.size === 'tall') {
                    commitMetricCardSizeImmediate(boundMetricKey, 'narrow');
                  }
                } else if (e?.key === 'ArrowDown' && currentLayoutRows === 2) {
                  e.preventDefault?.();
                  e.stopPropagation?.();
                  if (placement.size === 'sm') {
                    commitMetricCardSizeImmediate(boundMetricKey, 'narrow');
                  } else if (placement.size === 'third' || placement.size === 'wide') {
                    commitMetricCardSizeImmediate(boundMetricKey, 'tall');
                  }
                } else if (e?.key === 'ArrowUp') {
                  e.preventDefault?.();
                  e.stopPropagation?.();
                  if (placement.size === 'narrow') {
                    commitMetricCardSizeImmediate(boundMetricKey, 'sm');
                  } else if (placement.size === 'tall') {
                    commitMetricCardSizeImmediate(boundMetricKey, 'wide');
                  }
                }
              },
            },
            [createCornerGripSvg()]
          )
        : null;

      const labelRowEl = h('div', { className: 'cell-label' }, [labelSpan]);
      const children = [
        labelRowEl,
        valueEl,
        subEl,
        trendMetricEl,
        trendSubEl,
        sparkWrapEl,
      ];
      if (sizeBadgeEl) children.push(sizeBadgeEl);
      if (resizeHandleEl) children.push(resizeHandleEl);

      const el = h(
        'div',
        {
          className: 'matrix-cell',
          ...(hasMetricReorder
            ? {
                onPointerdown: (e) => {
                  if (resizeHandleEl && isNodeWithin(e?.target, resizeHandleEl)) return;
                  const idx = getMetricCellEls().indexOf(el);
                  if (idx >= 0) startMetricCellDrag(e, idx);
                },
              }
            : {}),
        },
        children
      );

      return {
        el,
        refs: {
          el,
          labelRowEl,
          labelSpan,
          valueEl,
          valueMainEl,
          valueUnitEl,
          subEl,
          trendMetricEl,
          trendNumEl,
          trendUnitEl,
          trendSubEl,
          sparkWrapEl,
          spark,
          sizeBadgeEl,
          resizeHandleEl,
          setBoundKey(key) {
            boundMetricKey = key;
          },
        },
      };
    }

    function applyUpdatePayload({ data } = {}) {
      lastUpdatePayload = { data };
      patchAttr(matrixEl, 'aria-label', t('module.metrics'));
      const baseSettings = data?.settings || {};
      const syncOverviewSetting =
        widgetMode !== 'hover' || baseSettings.hoverSyncOverviewMetrics !== false;
      const effectiveSettings =
        draggingSizesOverride != null
          ? {
              ...baseSettings,
              ...(syncOverviewSetting
                ? { overviewMetricSizes: draggingSizesOverride }
                : { hoverMetricSizes: draggingSizesOverride }),
            }
          : baseSettings;

      const {
        rows: configuredRows,
        sizes: resolvedSizes,
        textMode,
        showTitle,
        showSub,
        layout,
      } = resolveEffectiveClientMetricMatrixConfig(widgetMode, effectiveSettings, {
        includeGhostCells: hasMetricResize,
      });

      const placements = layout.placements;
      const metricKeys = placements.map((p) => p.key);
      currentVisibleKeys = [...metricKeys];
      currentOverflowKeys = [...layout.overflowKeys];
      currentLayoutRows = configuredRows;
      currentEffectiveRows = layout.effectiveRows;
      currentGridCols = layout.gridCols;
      currentSizesMap = { ...resolvedSizes };
      currentPlacementsByKey = new Map(placements.map((p) => [p.key, p]));

      const canDragCells = hasMetricReorder && metricKeys.length > 1;
      const dragHint = canDragCells
        ? canParentDragModule()
          ? t('settings.str.metricOrModuleDragHint')
          : t('settings.str.metricDragHint')
        : null;
      const trendPlacements = placements.filter((p) => p.isTrend);
      const trendKeys = trendPlacements.map((p) => p.key);
      const needsSparkline = trendKeys.length > 0;
      const geomSig = `${layout.effectiveRows}:${layout.gridCols}:${layout.isThreeUpTrend ? '3up' : 'bento'}:${placements
        .map((p) => `${p.key}=${p.size}:${p.isTrend ? 'T' : 'C'}@${p.colStart},${p.colSpan},${p.rowStart},${p.rowSpan}`)
        .join('|')}`;
      const sparkGeomSig = `${geomSig}:${textMode}`;
      const shouldFlip =
        (hasMetricResize || hasMetricReorder) &&
        !activeDrag &&
        !skipNextFlip &&
        lastLayoutGeomSig !== '' &&
        geomSig !== lastLayoutGeomSig;
      skipNextFlip = false;
      const beforeFlipRects = shouldFlip ? captureFlipRects() : null;
      readLiveSparklineSizes(sparkGeomSig, trendKeys);
      lastLayoutGeomSig = geomSig;
      lastSparkGeomSig = sparkGeomSig;

      patchClasses(matrixEl, {
        'is-bento': true,
        'is-large-trend': layout.isThreeUpTrend,
        'is-two-row': layout.effectiveRows === 2,
        'is-metrics-reorderable': canDragCells,
        'is-metrics-resizable': hasMetricResize,
      });
      patchAttr(matrixEl, 'data-cols', String(layout.displayCols || 4));
      patchAttr(matrixEl, 'data-rows', String(layout.effectiveRows));
      patchAttr(matrixEl, 'data-metric-text', textMode);
      patchStyleVar(matrixEl, '--matrix-cols', String(layout.gridCols));
      patchStyleVar(matrixEl, '--matrix-rows', String(layout.effectiveRows));

      const { hasSubagents, scopedConv, ctxAgent } = resolveScopedConversation(
        data,
        'all',
        getCtxAgentId(),
        needsSparkline
      );
      const active = scopedConv || data?.activeConversation || {};
      const ctx = ctxAgent?.context || active.context || {};
      const quotas = data?.quotas || {};
      const locale = getEffectiveLocale();
      const limitTokens = Number(ctx.compactionLimitTokens || ctx.limitTokens || 256000);
      const seriesSteps = needsSparkline
        ? active.sparklineSteps || active.recentSteps || data?.activeConversation?.recentSteps || []
        : [];
      const resizeHandleAria = hasMetricResize ? t('settings.str.metricResizeHandleAria') : '';
      const resizeHandleHint = hasMetricResize ? t('settings.str.metricResizeHandleHint') : '';

      const cells = placements.map((p) => {
        const base = resolveOverviewMetricCell(p.key, {
          active,
          ctx,
          quotas,
          settings: effectiveSettings,
          hasSubagents,
        });
        const split = splitMetricValueAndUnit(base.valueText);
        const isResizingThis = hasMetricResize && resizingKey === p.key;
        const sizeBadgeText = hasMetricResize ? formatMetricSizeBadge(p.size) : '';
        if (!p.isTrend) {
          return {
            ...base,
            placement: p,
            textMode,
            showTitle,
            showSub,
            valueMain: split.main,
            valueUnit: split.unit,
            isTrend: false,
            isTall: false,
            isNarrow: false,
            isThird: false,
            isWide: false,
            isResizingThis,
            sizeBadgeText,
            resizeHandleAria,
            resizeHandleHint,
            sparkSig: '',
          };
        }
        const isNarrow = Boolean(p.isNarrow);
        const isTall = Boolean(p.isTall);
        const isThird = Boolean(p.isThird);
        const isWide = Boolean(p.isWide);
        const widthFrac = p.colSpan / Math.max(1, layout.gridCols);
        const fallbackSparkCols = widthFrac >= 0.75 ? 1 : widthFrac >= 0.45 ? 2 : 3;
        const fallbackSparkHeight = isTall
          ? textMode === 'none'
            ? 76
            : textMode === 'both'
              ? 54
              : 64
          : isNarrow
            ? textMode === 'both'
              ? 34
              : 42
            : textMode === 'both'
              ? 24
              : 26;
        const measuredSize = measuredWrapSizeByKey.get(p.key);
        const spec = resolveAdaptiveSparklineSpec(
          measuredSize?.width,
          fallbackSparkCols,
          measuredSize?.height || fallbackSparkHeight
        );
        const series = extractOverviewMetricSeries(p.key, seriesSteps, {
          maxPoints: spec.maxPoints,
          limitTokens,
        });
        const geom = buildSparklineGeometry(series, { width: spec.width, height: spec.height });
        const tone = extractToneClass(base.valueClass);
        const sparkSig = `${spec.width}x${spec.height}:${spec.maxPoints}:${geom.linePoints}:${geom.lastX},${geom.lastY}`;
        return {
          ...base,
          placement: p,
          textMode,
          showTitle,
          showSub,
          valueMain: split.main,
          valueUnit: split.unit,
          isTrend: true,
          isTall,
          isNarrow,
          isThird,
          isWide,
          isResizingThis,
          sizeBadgeText,
          resizeHandleAria,
          resizeHandleHint,
          tone,
          trendMain: split.main,
          trendUnit: split.unit,
          sparkWidth: spec.width,
          sparkHeight: spec.height,
          sparkStrokeWidth: spec.strokeWidth,
          sparkDotRadius: spec.dotRadius,
          geom,
          sparkSig,
        };
      });

      patchKeyedList(matrixEl, cells, {
        keyFn: (cell) => cell.key,
        sigFn: (cell) => {
          const p = cell.placement;
          return `${locale}:${cell.textMode}:${p.size}:${p.isTrend ? 'T' : 'C'}:${p.isTall ? 'H' : p.isNarrow ? 'V' : p.isThird ? 'M' : ''}:${p.colStart}:${p.colSpan}:${p.rowStart}:${p.rowSpan}:${cell.isResizingThis ? 'R' : ''}:${cell.sizeBadgeText}:${cell.key}:${cell.label}:${cell.valueClass}:${cell.valueText}:${cell.subClass}:${cell.subText}:${cell.sparkSig}:${dragHint || ''}`;
        },
        createRow: createMetricCellNode,
        updateRow: (refs, cell) => {
          const p = cell.placement;
          refs.setBoundKey(cell.key);
          patchAttr(refs.el, 'data-metric-key', cell.key);
          patchAttr(refs.el, 'data-card-size', p.size);
          patchAttr(refs.el, 'data-col-span', String(p.colSpan));
          patchAttr(refs.el, 'data-row-span', String(p.rowSpan));
          patchAttr(refs.el, 'title', dragHint || (!cell.showTitle ? cell.label : null));
          patchStyleVar(refs.el, '--cell-col-start', String(p.colStart));
          patchStyleVar(refs.el, '--cell-col-span', String(p.colSpan));
          patchStyleVar(refs.el, '--cell-row-start', String(p.rowStart));
          patchStyleVar(refs.el, '--cell-row-span', String(p.rowSpan));
          patchClasses(refs.el, {
            'is-trend-card': cell.isTrend,
            'is-third-card': cell.isThird,
            'is-wide-card': cell.isWide,
            'is-narrow-card': cell.isNarrow,
            'is-tall-card': cell.isTall,
            'is-cell-resizing': cell.isResizingThis,
          });
          patchAttr(refs.labelRowEl, 'hidden', !cell.showTitle);
          patchText(refs.labelSpan, cell.label);

          if (refs.sizeBadgeEl) {
            patchText(refs.sizeBadgeEl, cell.sizeBadgeText);
            patchAttr(refs.sizeBadgeEl, 'hidden', !cell.isResizingThis);
          }
          if (refs.resizeHandleEl) {
            patchAttr(refs.resizeHandleEl, 'aria-label', cell.resizeHandleAria);
            patchAttr(refs.resizeHandleEl, 'title', cell.resizeHandleHint);
            patchAttr(refs.resizeHandleEl, 'data-card-size', p.size);
          }

          patchAttr(refs.valueEl, 'hidden', cell.isTrend);
          patchAttr(refs.subEl, 'hidden', cell.isTrend || !cell.showSub);
          patchAttr(refs.trendMetricEl, 'hidden', !cell.isTrend);
          patchAttr(refs.trendSubEl, 'hidden', !cell.isTrend || !cell.showSub);
          patchAttr(refs.sparkWrapEl, 'hidden', !cell.isTrend);

          if (!cell.isTrend) {
            const isWordUnit = cell.valueUnit === 'tok/s' || cell.valueUnit === 't/s';
            patchAttr(refs.valueEl, 'class', cell.valueClass);
            patchText(refs.valueMainEl, cell.valueMain);
            patchText(refs.valueUnitEl, cell.valueUnit);
            patchAttr(refs.valueUnitEl, 'hidden', !cell.valueUnit);
            patchAttr(refs.valueUnitEl, 'data-unit-spaced', isWordUnit ? 'true' : null);
            patchAttr(refs.subEl, 'class', cell.subClass);
            patchText(refs.subEl, cell.subText);
            return;
          }

          patchAttr(
            refs.trendNumEl,
            'class',
            cell.tone ? `cell-trend-num ${cell.tone}` : 'cell-trend-num'
          );
          patchText(refs.trendNumEl, cell.trendMain);
          patchText(refs.trendUnitEl, cell.trendUnit);
          patchAttr(refs.trendUnitEl, 'hidden', !cell.trendUnit);
          patchText(refs.trendSubEl, cell.subText);

          patchAttr(
            refs.sparkWrapEl,
            'class',
            cell.tone ? `cell-sparkline-wrap ${cell.tone}` : 'cell-sparkline-wrap'
          );
          if (sparkResizeObserver) {
            if (!observedWrapToKey.has(refs.sparkWrapEl)) {
              sparkResizeObserver.observe(refs.sparkWrapEl);
            }
            observedWrapToKey.set(refs.sparkWrapEl, cell.key);
          }
          refs.spark.svg.setAttribute('viewBox', `0 0 ${cell.sparkWidth} ${cell.sparkHeight}`);
          refs.spark.polyline.setAttribute('stroke-width', cell.sparkStrokeWidth);
          refs.spark.dot.setAttribute('r', cell.sparkDotRadius);

          if (cell.geom.hasLine) {
            refs.spark.areaPath.setAttribute('d', cell.geom.areaPath);
            refs.spark.polyline.setAttribute('points', cell.geom.linePoints);
            patchAttr(refs.spark.areaPath, 'hidden', false);
            patchAttr(refs.spark.polyline, 'hidden', false);
          } else {
            refs.spark.areaPath.setAttribute('d', '');
            refs.spark.polyline.setAttribute('points', '');
            patchAttr(refs.spark.areaPath, 'hidden', true);
            patchAttr(refs.spark.polyline, 'hidden', true);
          }

          if (cell.geom.hasDot) {
            refs.spark.dot.setAttribute('cx', String(cell.geom.lastX));
            refs.spark.dot.setAttribute('cy', String(cell.geom.lastY));
            patchAttr(refs.spark.dot, 'hidden', false);
          } else {
            patchAttr(refs.spark.dot, 'hidden', true);
          }
        },
      });

      syncGhostCells(hasMetricResize ? layout.ghostCells : []);
      if (dropPreviewEl && dropPreviewEl.parentNode === matrixEl && !activeDrag) {
        hideDropPreview();
      }
      if (beforeFlipRects && beforeFlipRects.size > 0) {
        playFlipFrom(beforeFlipRects);
      }
      syncObservedSparklineWraps(trendKeys);
    }

    function update(payload = {}) {
      if (activeDrag) {
        pendingUpdatePayload = payload;
        return;
      }
      applyUpdatePayload(payload);
    }

    onCleanup(() => {
      teardownActiveResize({ revert: false });
      teardownActiveDrag({ revert: false, flushPending: false });
      clearFlipAnimation();
      clearResizePullVisual();
      clearResizeClickSuppression();
      settleAnimator.clear();
      hideDropPreview();
      if (pendingSparkResizeRafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(pendingSparkResizeRafId);
        pendingSparkResizeRafId = 0;
      }
      sparkResizeObserver?.disconnect();
      observedWrapToKey.clear();
      measuredWrapSizeByKey.clear();
      ghostElPool.length = 0;
    });

    // Initialize default 4-cell skeleton so hover/overview has zero initial height jump
    update({ data: null });

    return {
      el: matrixEl,
      refs: { update },
    };
  },
});
