/**
 * @fileoverview Decoupled Overview & Hover Widget Registry (`widgetRegistry.js`).
 * Maps module keys (`metrics`, `context`, `quotas`, `live_tasks`) to standalone
 * widget components and provides `createDynamicWidgetHost` for zero-hardcode mounting,
 * live reordering, and clean instance disposal.
 */

import { OVERVIEW_MODULE_KEYS } from '../../shared/settings-normalization.mjs';
import {
  areSlotListsEqual,
  createDropSettleAnimator,
  isInteractiveDragTarget,
  patchAttr,
  patchClasses,
  startLinearDragReorder,
} from '../core/domPatch.js';
import { ContextWindowWidget } from '../components/widgets/ContextWindowWidget.js';
import { LiveActivityWidget } from '../components/widgets/LiveActivityWidget.js';
import { MetricMatrixWidget } from '../components/widgets/MetricMatrixWidget.js';
import { QuotaPoolsWidget } from '../components/widgets/QuotaPoolsWidget.js';
import { t } from '../i18n/index.js';

export const OVERVIEW_WIDGET_KEYS = OVERVIEW_MODULE_KEYS;

export const OVERVIEW_WIDGET_REGISTRY = Object.freeze({
  metrics: {
    key: 'metrics',
    labelKey: 'module.metrics',
    create: ({
      mode,
      isVisibleFn,
      preview,
      getCtxAgentId,
      onPreviewMetrics,
      onReorderMetrics,
      onPreviewHybridRatio,
      onResizeHybridRatio,
      onRequestVerticalDrag,
      canDragParentModule,
    }) =>
      MetricMatrixWidget({
        mode,
        isVisibleFn,
        preview,
        getCtxAgentId,
        onPreviewMetrics,
        onReorderMetrics,
        onPreviewHybridRatio,
        onResizeHybridRatio,
        onRequestVerticalDrag,
        canDragParentModule,
      }),
  },
  context: {
    key: 'context',
    labelKey: 'module.context',
    create: ({ mode, isVisibleFn, preview, getCtxAgentId, setCtxAgentId }) =>
      ContextWindowWidget({
        interactiveInspector: mode !== 'hover',
        isVisibleFn,
        preview,
        getCtxAgentId,
        setCtxAgentId,
      }),
  },
  quotas: {
    key: 'quotas',
    labelKey: 'module.quotas',
    create: ({ mode }) =>
      QuotaPoolsWidget({
        compactHover: mode === 'hover',
      }),
  },
  live_tasks: {
    key: 'live_tasks',
    labelKey: 'module.live_tasks',
    create: ({ mode, isVisibleFn, preview, getCtxAgentId }) =>
      LiveActivityWidget({
        interactive: mode !== 'hover',
        isVisibleFn,
        preview,
        getCtxAgentId,
      }),
  },
});

export function getOverviewModuleOptions() {
  return OVERVIEW_WIDGET_KEYS.map((key) => ({
    value: key,
    label: t(`module.${key}`),
  }));
}

/**
 * Create a dynamic container host that mounts, reorders, updates, and disposes
 * standalone telemetry widgets based on user-configured module keys.
 *
 * @param {{
 *   containerEl: HTMLElement,
 *   mode?: 'overview' | 'hover',
 *   isVisibleFn?: () => boolean,
 *   initialModuleKeys?: string[]
 * }} options
 */
export function createDynamicWidgetHost({
  containerEl,
  mode = 'overview',
  preview = false,
  isVisibleFn = () => true,
  initialModuleKeys = [],
  getCtxAgentId: customGetCtxAgentId = undefined,
  setCtxAgentId: customSetCtxAgentId = undefined,
  onPreviewModules = undefined,
  onReorderModules = undefined,
  onPreviewMetrics = undefined,
  onReorderMetrics = undefined,
  onPreviewHybridRatio = undefined,
  onResizeHybridRatio = undefined,
}) {
  const instances = new Map();
  const modulePointerCleanups = new Map();
  let currentKeys = [];
  let previewCtxAgentId = 'main';
  let latestUpdatePayload = null;
  let pendingUpdateArgs = null;
  let activeModuleDrag = null;
  const settleAnimator = createDropSettleAnimator('is-module-settling', ' scale(1.012)');

  const hasModuleReorder =
    typeof onReorderModules === 'function' || typeof onPreviewModules === 'function';
  const canDragParentModule = () => hasModuleReorder && currentKeys.length > 1;

  const getCtxAgentId =
    typeof customGetCtxAgentId === 'function'
      ? customGetCtxAgentId
      : preview
        ? () => previewCtxAgentId
        : undefined;
  const setCtxAgentId =
    typeof customSetCtxAgentId === 'function'
      ? customSetCtxAgentId
      : preview
        ? (nextId) => {
            previewCtxAgentId = String(nextId || 'main');
            if (latestUpdatePayload) {
              for (const key of currentKeys) {
                instances.get(key)?.refs?.update?.(latestUpdatePayload);
              }
            }
          }
        : undefined;

  function resetModuleDragVisuals() {
    patchClasses(containerEl, { 'is-dragging-modules': false });
    for (const inst of instances.values()) {
      const el = inst?.el;
      if (!el) continue;
      patchClasses(el, { 'is-module-dragging': false, 'is-module-drag-sibling': false });
      if (el.style) {
        el.style.transition = '';
        el.style.transform = '';
      }
    }
  }

  function syncModuleDragAffordances(validKeys) {
    if (!hasModuleReorder) return;
    const canDrag = validKeys.length > 1;
    patchClasses(containerEl, { 'is-modules-reorderable': canDrag });
    const moduleHint = canDrag ? t('settings.str.moduleDragHint') : null;
    for (const key of validKeys) {
      const el = instances.get(key)?.el;
      if (!el) continue;
      patchAttr(el, 'data-module-key', key);
      patchClasses(el, { 'is-reorderable-module': canDrag });
      patchAttr(el, 'title', key !== 'metrics' ? moduleHint : null);
    }
  }

  function teardownActiveModuleDrag({ revert = false, flushPending = true } = {}) {
    if (!activeModuleDrag) return;
    const { startKeys, getWorkingKeys, session } = activeModuleDrag;
    const moved = session.isMoved();
    activeModuleDrag = null;
    session.cancel(true);
    resetModuleDragVisuals();
    if (revert && moved && !areSlotListsEqual(startKeys, getWorkingKeys())) {
      onPreviewModules?.([...startKeys]);
    }
    if (flushPending && pendingUpdateArgs) {
      const queued = pendingUpdateArgs;
      pendingUpdateArgs = null;
      applyUpdateArgs(queued);
    }
  }

  function startModuleDrag(e, startKey, { immediate = false, clientX = null, clientY = null } = {}) {
    if (!hasModuleReorder || (e && e.button != null && e.button !== 0)) return false;
    const startIdx = currentKeys.indexOf(startKey);
    if (startIdx < 0 || currentKeys.length <= 1) return false;
    if (activeModuleDrag) teardownActiveModuleDrag({ revert: false, flushPending: true });
    settleAnimator.clear();

    const startKeys = [...currentKeys];
    const count = startKeys.length;
    const moduleEls = startKeys.map((k) => instances.get(k)?.el || null);
    if (moduleEls.some((el) => !el)) return false;

    const session = startLinearDragReorder(e, {
      axis: 'y',
      items: startKeys,
      startIdx,
      itemEls: moduleEls,
      containerEl,
      fallbackSize: 96,
      fallbackGap: 8,
      threshold: 4,
      immediate,
      initialClientX: clientX,
      initialClientY: clientY,
      autoScroll: true,
      edgeZone: 38,
      rubberBandMax: 24,
      crossMax: 12,
      crossRatio: 0.16,
      dragScale: ' scale(1.012)',
      onStart: () => {
        patchClasses(containerEl, { 'is-dragging-modules': true });
        for (let k = 0; k < count; k += 1) {
          patchClasses(moduleEls[k], { 'is-module-dragging': k === startIdx, 'is-module-drag-sibling': k !== startIdx });
        }
      },
      onPreview: (working) => onPreviewModules?.(working),
      onCancel: () => teardownActiveModuleDrag({ revert: true, flushPending: true }),
      onFinish: ({ moved, changed, finalItems, residualX, residualY }) => {
        teardownActiveModuleDrag({ revert: false, flushPending: !changed });
        if (changed) {
          pendingUpdateArgs = null;
          syncModules(finalItems);
          onReorderModules?.([...finalItems]);
        }
        const landedEl = instances.get(startKey)?.el;
        if (moved && landedEl) {
          settleAnimator.trigger(landedEl, residualX, residualY);
        }
      },
    });

    activeModuleDrag = { startKeys, getWorkingKeys: session.getWorkingItems, session };
    return true;
  }

  function detachModulePointer(key) {
    const cleanup = modulePointerCleanups.get(key);
    if (cleanup) {
      cleanup();
      modulePointerCleanups.delete(key);
    }
  }

  function attachModulePointer(key, moduleEl) {
    if (!hasModuleReorder || !moduleEl) return;
    detachModulePointer(key);
    const onPointerDown = (e) => {
      if (currentKeys.length <= 1 || (e && e.button != null && e.button !== 0)) return;
      if (isInteractiveDragTarget(e?.target, moduleEl)) return;
      e?.preventDefault?.();
      startModuleDrag(e, key);
    };
    moduleEl.addEventListener?.('pointerdown', onPointerDown);
    modulePointerCleanups.set(key, () => moduleEl.removeEventListener?.('pointerdown', onPointerDown));
  }

  function syncModules(nextKeys) {
    const validKeys = [];
    const seen = new Set();
    for (const rawKey of Array.isArray(nextKeys) ? nextKeys : []) {
      const k = String(rawKey || '').trim();
      if (!k || seen.has(k) || !OVERVIEW_WIDGET_REGISTRY[k]) continue;
      seen.add(k);
      validKeys.push(k);
    }

    // Remove and destroy widgets no longer present
    for (const [existingKey, inst] of [...instances.entries()]) {
      if (!seen.has(existingKey)) {
        detachModulePointer(existingKey);
        try {
          inst.el?.remove?.();
        } catch {}
        try {
          inst.destroy?.();
        } catch {}
        instances.delete(existingKey);
      }
    }

    // Instantiate newly added widgets
    for (const key of validKeys) {
      if (!instances.has(key)) {
        const inst = OVERVIEW_WIDGET_REGISTRY[key].create({
          mode,
          preview,
          isVisibleFn,
          getCtxAgentId,
          setCtxAgentId,
          onPreviewMetrics,
          onReorderMetrics,
          onPreviewHybridRatio,
          onResizeHybridRatio,
          onRequestVerticalDrag: hasModuleReorder
            ? (downEv, cx, cy) =>
                startModuleDrag(downEv, 'metrics', {
                  immediate: true,
                  clientX: cx,
                  clientY: cy,
                })
            : undefined,
          canDragParentModule,
        });
        instances.set(key, inst);
        attachModulePointer(key, inst.el);
      }
    }

    // Reorder DOM nodes in containerEl only where needed
    const orderChanged =
      validKeys.length !== currentKeys.length ||
      validKeys.some((k, idx) => currentKeys[idx] !== k) ||
      (containerEl.children && containerEl.children.length !== validKeys.length);

    if (orderChanged) {
      for (let i = 0; i < validKeys.length; i += 1) {
        const targetEl = instances.get(validKeys[i]).el;
        const curChild = containerEl.children ? containerEl.children[i] : null;
        if (curChild !== targetEl) {
          if (curChild && typeof containerEl.insertBefore === 'function') {
            containerEl.insertBefore(targetEl, curChild);
          } else {
            containerEl.appendChild(targetEl);
          }
        }
      }
      currentKeys = [...validKeys];
    }

    syncModuleDragAffordances(validKeys);
    return validKeys;
  }

  function applyUpdateArgs({ moduleKeys = [], data = null, minuteTick = undefined } = {}) {
    latestUpdatePayload = { data, minuteTick };
    const validKeys = syncModules(moduleKeys);
    for (const key of validKeys) {
      const inst = instances.get(key);
      inst?.refs?.update?.({ data, minuteTick });
    }
  }

  function update(args = {}) {
    if (activeModuleDrag) {
      pendingUpdateArgs = args;
      return;
    }
    applyUpdateArgs(args);
  }

  function pauseTickers() {
    for (const inst of instances.values()) {
      inst?.refs?.pauseTicker?.();
    }
  }

  function resumeTickers() {
    for (const inst of instances.values()) {
      inst?.refs?.resumeTicker?.();
    }
  }

  function getInstance(key) {
    return instances.get(key) || null;
  }

  function destroy() {
    teardownActiveModuleDrag({ revert: false, flushPending: false });
    settleAnimator.clear();
    for (const key of [...modulePointerCleanups.keys()]) {
      detachModulePointer(key);
    }
    for (const inst of instances.values()) {
      try {
        inst.el?.remove?.();
      } catch {}
      try {
        inst.destroy?.();
      } catch {}
    }
    instances.clear();
    currentKeys = [];
  }

  if (Array.isArray(initialModuleKeys) && initialModuleKeys.length > 0) {
    syncModules(initialModuleKeys);
  }

  return {
    update,
    pauseTickers,
    resumeTickers,
    getInstance,
    getActiveKeys: () => [...currentKeys],
    destroy,
  };
}
