/**
 * @fileoverview Reusable Drag-Sortable & `+` / `-` / `↑` / `↓` Dynamic Slot List (`EditableSlotList.js`).
 * Powers Topbar Capsule Slots (1..5), Hover Popup Modules (0..4),
 * Live Overview Modules (1..4), Bento Metrics (1..8), and Step Table Columns (2..12).
 * Supports smooth pointer-based drag reordering with live preview callbacks (`onPreview`),
 * single-commit persistence on drop (`onChange`), exact dimmed item sets, and optional
 * per-row interactive pill badges (e.g. `小 / 宽 / 大` Bento size cycling).
 */

import { defineComponent } from '../../core/component.js';
import {
  areSlotListsEqual,
  createDropSettleAnimator,
  h,
  patchAttr,
  patchClasses,
  patchText,
  startLinearDragReorder,
} from '../../core/domPatch.js';
import { createSvgIcon } from '../../icons/SvgIcon.js';
import { t } from '../../i18n/index.js';
import { CustomSelect } from '../ui/CustomSelect.js';

function isNodeWithin(target, container) {
  let cur = target;
  while (cur) {
    if (cur === container) return true;
    cur = cur.parentNode || cur.host || null;
  }
  return false;
}

function normalizeDimmedValues(raw) {
  if (raw == null) return null;
  if (raw instanceof Set) return new Set(raw);
  if (Array.isArray(raw)) return new Set(raw);
  return null;
}

export const EditableSlotList = defineComponent({
  name: 'EditableSlotList',
  setup({ props, onCleanup }) {
    const minItems = Math.max(0, Number(props.minItems ?? 1));
    let maxItems = Math.max(minItems, Number(props.maxItems ?? 5));
    let currentItems = Array.isArray(props.items) ? [...props.items] : [];
    let currentOptions = Array.isArray(props.options) ? [...props.options] : [];
    let emptyHintText = String(props.emptyHintText || '');
    let addBtnTextFn = typeof props.addBtnTextFn === 'function' ? props.addBtnTextFn : null;
    let dimmedFromIndex =
      Number.isInteger(props.dimmedFromIndex) && props.dimmedFromIndex >= 0
        ? props.dimmedFromIndex
        : null;
    let dimmedValuesSet = normalizeDimmedValues(props.dimmedValues);
    let dimmedTagText = String(props.dimmedTagText || '');
    let getItemBadge = typeof props.getItemBadge === 'function' ? props.getItemBadge : null;
    let onClickItemBadge =
      typeof props.onClickItemBadge === 'function' ? props.onClickItemBadge : null;
    let activeDrag = null;
    const settleAnimator = createDropSettleAnimator('is-settling', ' scale(1.015)');
    let suppressClickTimer = null;
    let suppressNextClick = false;
    let pendingSyncAfterDrag = false;

    const listEl = h('div', { className: 'editable-slot-list' });
    const emptyEl = h('div', {
      className: 'editable-slot-empty',
      hidden: true,
      text: emptyHintText,
    });

    const addBtnLabel = h('span', { text: '' });
    const addBtn = h(
      'button',
      {
        type: 'button',
        className: 'slot-add-btn',
        onClick: () => {
          if (currentItems.length >= maxItems) return;
          const usedSet = new Set(currentItems);
          const nextOpt = currentOptions.find((opt) => !usedSet.has(opt.value));
          if (!nextOpt) return;
          emitChange([...currentItems, nextOpt.value]);
        },
      },
      [createSvgIcon('plus', { size: 11 }), addBtnLabel]
    );

    const footerEl = h('div', { className: 'editable-slot-footer' }, [addBtn]);
    const rootEl = h('div', { className: 'editable-slot-wrap' }, [emptyEl, listEl, footerEl]);

    const rowPool = [];

    function isSlotDimmed(itemVal, visualSlot) {
      if (dimmedValuesSet !== null) {
        return dimmedValuesSet.has(itemVal);
      }
      return dimmedFromIndex !== null && visualSlot >= dimmedFromIndex;
    }

    function clearSettleAnimation() {
      settleAnimator.clear();
    }

    function clearClickSuppression() {
      if (suppressClickTimer) {
        clearTimeout(suppressClickTimer);
        suppressClickTimer = null;
      }
      suppressNextClick = false;
    }

    function armClickSuppression() {
      clearClickSuppression();
      suppressNextClick = true;
      suppressClickTimer = setTimeout(() => {
        suppressClickTimer = null;
        suppressNextClick = false;
      }, 120);
    }

    function emitChange(nextItems) {
      currentItems = [...nextItems];
      syncRows();
      props.onPreview?.([...currentItems]);
      props.onChange?.([...currentItems]);
    }

    function resetRowDragStyles() {
      for (const r of rowPool) {
        patchClasses(r.rowEl, { 'is-dragging': false, 'is-drag-sibling': false });
        if (r.rowEl?.style) {
          r.rowEl.style.transition = '';
          r.rowEl.style.transform = '';
        }
      }
    }

    function teardownActiveDrag({ revert = false } = {}) {
      if (!activeDrag) return;
      const { startItems, session } = activeDrag;
      const moved = session.isMoved();
      activeDrag = null;
      session.cancel(true);
      patchClasses(listEl, { 'is-dragging-list': false });
      resetRowDragStyles();
      if (revert && moved && !areSlotListsEqual(startItems, currentItems)) {
        currentItems = [...startItems];
        pendingSyncAfterDrag = false;
        syncRows();
        props.onPreview?.([...currentItems]);
      } else if (pendingSyncAfterDrag) {
        pendingSyncAfterDrag = false;
        syncRows();
      }
    }

    function startPointerDrag(e, initialRowIdx, { threshold = 3 } = {}) {
      if (e && e.button != null && e.button !== 0) return;
      if (currentItems.length <= 1) return;
      if (activeDrag) teardownActiveDrag({ revert: false });
      clearSettleAnimation();

      const startItems = [...currentItems];
      const count = startItems.length;
      const startIdx = initialRowIdx;

      function applySlotDimState(entry, itemVal, visualSlot) {
        const isDimmed = isSlotDimmed(itemVal, visualSlot);
        patchClasses(entry.rowEl, { 'is-dimmed': isDimmed });
        patchAttr(entry.dimmedTagEl, 'hidden', !isDimmed || !dimmedTagText);
        if (dimmedTagText) patchText(entry.dimmedTagEl, dimmedTagText);
      }

      const session = startLinearDragReorder(e, {
        axis: 'y',
        items: startItems,
        startIdx,
        itemEls: rowPool.slice(0, count).map((r) => r?.rowEl),
        containerEl: listEl,
        fallbackSize: 28,
        fallbackGap: 5,
        threshold,
        autoScroll: true,
        rubberBandMax: 26,
        crossMax: 18,
        crossRatio: 0.22,
        dragScale: ' scale(1.015)',
        onStart: () => {
          for (let k = 0; k < count; k += 1) rowPool[k]?.selectComp?.close?.();
          patchClasses(listEl, { 'is-dragging-list': true });
          for (let k = 0; k < count; k += 1) {
            if (!rowPool[k]) continue;
            patchClasses(rowPool[k].rowEl, {
              'is-dragging': k === startIdx,
              'is-drag-sibling': k !== startIdx,
            });
          }
        },
        onLayout: ({ perm }) => {
          for (let visualSlot = 0; visualSlot < perm.length; visualSlot += 1) {
            const origIdx = perm[visualSlot];
            const entry = rowPool[origIdx];
            if (!entry) continue;
            patchText(entry.indexBadge, String(visualSlot + 1));
            applySlotDimState(entry, startItems[origIdx], visualSlot);
          }
        },
        onPreview: (working) => {
          currentItems = working;
          props.onPreview?.([...currentItems]);
        },
        onCancel: () => teardownActiveDrag({ revert: true }),
        onFinish: ({ moved, changed, targetIdx, finalItems, residualX, residualY }) => {
          teardownActiveDrag({ revert: false });
          if (moved) armClickSuppression();
          if (changed) emitChange(finalItems);
          else if (moved) syncRows();
          if (moved && rowPool[targetIdx]?.rowEl) {
            settleAnimator.trigger(rowPool[targetIdx].rowEl, residualX, residualY);
          }
        },
      });

      activeDrag = { startItems, session };
    }

    function createSlotRow() {
      let rowIndex = 0;
      const dragHandle = h(
        'span',
        {
          className: 'slot-drag-handle',
          'aria-hidden': 'true',
          onPointerdown: (e) => {
            e.preventDefault?.();
            e.stopPropagation?.();
            startPointerDrag(e, rowIndex);
          },
        },
        [createSvgIcon('grip', { size: 12 })]
      );
      const indexBadge = h('span', { className: 'slot-index-badge text-mono', text: '1' });
      const selectComp = CustomSelect({
        modelValue: '',
        options: [],
        onUpdateModelValue: (nextVal) => {
          if (!nextVal || currentItems[rowIndex] === nextVal) return;
          if (currentItems.some((v, idx) => idx !== rowIndex && v === nextVal)) return;
          const next = [...currentItems];
          next[rowIndex] = nextVal;
          emitChange(next);
        },
      });

      const itemBadgeBtn = h('button', {
        type: 'button',
        className: 'slot-size-pill',
        hidden: true,
        text: '',
        onClick: (e) => {
          e.stopPropagation();
          const val = currentItems[rowIndex];
          if (val !== undefined) {
            onClickItemBadge?.(val, rowIndex);
          }
        },
      });

      const upBtn = h(
        'button',
        {
          type: 'button',
          className: 'slot-move-btn',
          onClick: (e) => {
            e.stopPropagation();
            if (rowIndex <= 0) return;
            const next = [...currentItems];
            const tmp = next[rowIndex - 1];
            next[rowIndex - 1] = next[rowIndex];
            next[rowIndex] = tmp;
            emitChange(next);
          },
        },
        [createSvgIcon('chevron-up', { size: 12 })]
      );

      const downBtn = h(
        'button',
        {
          type: 'button',
          className: 'slot-move-btn',
          onClick: (e) => {
            e.stopPropagation();
            if (rowIndex >= currentItems.length - 1) return;
            const next = [...currentItems];
            const tmp = next[rowIndex + 1];
            next[rowIndex + 1] = next[rowIndex];
            next[rowIndex] = tmp;
            emitChange(next);
          },
        },
        [createSvgIcon('chevron-down', { size: 12 })]
      );

      const removeBtn = h(
        'button',
        {
          type: 'button',
          className: 'slot-move-btn slot-remove-btn',
          onClick: (e) => {
            e.stopPropagation();
            if (currentItems.length <= minItems) return;
            const next = currentItems.filter((_, idx) => idx !== rowIndex);
            emitChange(next);
          },
        },
        [createSvgIcon('minus', { size: 12 })]
      );

      const selectMenuEl = selectComp.el?.querySelector?.('.select-menu') || null;
      const dimmedTagEl = h('span', { className: 'slot-dimmed-tag', hidden: true, text: '' });
      const orderBtnsEl = h('span', { className: 'slot-order-btns' }, [upBtn, downBtn, removeBtn]);

      const rowEl = h(
        'div',
        {
          className: 'editable-slot-row',
          onPointerdown: (e) => {
            if (isNodeWithin(e?.target, orderBtnsEl)) return;
            if (isNodeWithin(e?.target, itemBadgeBtn)) return;
            if (selectMenuEl && isNodeWithin(e?.target, selectMenuEl)) return;
            const onSelectTrigger = isNodeWithin(e?.target, selectComp.el);
            startPointerDrag(e, rowIndex, { threshold: onSelectTrigger ? 5 : 3 });
          },
        },
        [dragHandle, indexBadge, selectComp.el, dimmedTagEl, itemBadgeBtn, orderBtnsEl]
      );
      if (typeof rowEl.addEventListener === 'function') {
        rowEl.addEventListener(
          'click',
          (e) => {
            if (!suppressNextClick) return;
            clearClickSuppression();
            e.preventDefault?.();
            e.stopPropagation?.();
          },
          true
        );
      }

      return {
        rowEl,
        dragHandle,
        indexBadge,
        dimmedTagEl,
        itemBadgeBtn,
        selectComp,
        upBtn,
        downBtn,
        removeBtn,
        setIndex(idx) {
          rowIndex = idx;
        },
      };
    }

    function syncRows() {
      const count = currentItems.length;
      patchAttr(emptyEl, 'hidden', count > 0 || !emptyHintText);
      if (emptyHintText) {
        patchText(emptyEl, emptyHintText);
      }
      patchAttr(listEl, 'hidden', count === 0);

      while (rowPool.length < count) {
        rowPool.push(createSlotRow());
      }

      while (listEl.children && listEl.children.length > count) {
        const tailIdx = listEl.children.length - 1;
        const tailChild = listEl.children[tailIdx];
        tailChild?.remove?.();
      }

      const canDrag = count > 1;
      const dragTitle = canDrag ? t('settings.slot.dragHint') : '';
      const canRemove = count > minItems;
      const removeTitle = canRemove
        ? t('settings.slot.remove')
        : t('settings.slot.minReached', { min: minItems });

      for (let i = 0; i < count; i += 1) {
        const entry = rowPool[i];
        const itemVal = currentItems[i];
        entry.setIndex(i);
        const isDimmed = isSlotDimmed(itemVal, i);
        patchAttr(entry.rowEl, 'data-slot-row', String(i));
        patchAttr(entry.rowEl, 'data-slot-value', String(itemVal));
        patchClasses(entry.rowEl, { 'is-dimmed': isDimmed });
        patchText(entry.indexBadge, String(i + 1));
        patchAttr(entry.dimmedTagEl, 'hidden', !isDimmed || !dimmedTagText);
        if (dimmedTagText) {
          patchText(entry.dimmedTagEl, dimmedTagText);
        }

        const badge = getItemBadge ? getItemBadge(itemVal, i) : null;
        if (badge && badge.text) {
          patchAttr(entry.itemBadgeBtn, 'hidden', false);
          patchText(entry.itemBadgeBtn, badge.text);
          patchAttr(entry.itemBadgeBtn, 'title', badge.title || null);
          patchAttr(entry.itemBadgeBtn, 'aria-label', badge.ariaLabel || badge.title || badge.text);
          patchAttr(entry.itemBadgeBtn, 'data-badge-tone', badge.tone || null);
          patchClasses(entry.itemBadgeBtn, { 'is-active': Boolean(badge.active) });
        } else {
          patchAttr(entry.itemBadgeBtn, 'hidden', true);
        }

        patchClasses(entry.dragHandle, { 'is-disabled': !canDrag });
        patchAttr(entry.dragHandle, 'title', dragTitle || null);

        const otherUsed = new Set(currentItems.filter((_, idx) => idx !== i));
        const rowOpts = currentOptions.map((opt) => {
          const isTaken = otherUsed.has(opt.value);
          return isTaken
            ? {
                ...opt,
                disabled: true,
                meta: t('settings.slot.alreadyAdded'),
              }
            : opt;
        });

        entry.selectComp.setProps({
          modelValue: itemVal,
          options: rowOpts,
        });

        patchAttr(entry.upBtn, 'disabled', i === 0);
        patchAttr(entry.upBtn, 'title', t('settings.slot.moveUp'));
        patchAttr(entry.upBtn, 'aria-label', t('settings.slot.moveUp'));

        patchAttr(entry.downBtn, 'disabled', i === count - 1);
        patchAttr(entry.downBtn, 'title', t('settings.slot.moveDown'));
        patchAttr(entry.downBtn, 'aria-label', t('settings.slot.moveDown'));

        patchAttr(entry.removeBtn, 'disabled', !canRemove);
        patchAttr(entry.removeBtn, 'title', removeTitle);
        patchAttr(entry.removeBtn, 'aria-label', removeTitle);

        if (!listEl.children || listEl.children[i] !== entry.rowEl) {
          listEl.appendChild(entry.rowEl);
        }
      }

      // Close any hidden pooled selects
      for (let j = count; j < rowPool.length; j += 1) {
        rowPool[j].selectComp.close();
      }

      const usedAll = new Set(currentItems);
      const hasAvailableOption = currentOptions.some((opt) => !usedAll.has(opt.value));
      const disableAdd = count >= maxItems || !hasAvailableOption;
      patchAttr(addBtn, 'disabled', disableAdd);
      const addLabel = addBtnTextFn
        ? addBtnTextFn(count, maxItems)
        : `+ (${count}/${maxItems})`;
      patchText(addBtnLabel, addLabel);
    }

    function setProps(next = {}) {
      if (!activeDrag && Array.isArray(next.items)) {
        currentItems = [...next.items];
      }
      if (Array.isArray(next.options)) {
        currentOptions = [...next.options];
      }
      if (next.maxItems !== undefined && Number.isFinite(Number(next.maxItems))) {
        maxItems = Math.max(minItems, Number(next.maxItems));
      }
      if (next.emptyHintText !== undefined) {
        emptyHintText = String(next.emptyHintText || '');
      }
      if (typeof next.addBtnTextFn === 'function') {
        addBtnTextFn = next.addBtnTextFn;
      }
      if (next.dimmedFromIndex !== undefined) {
        dimmedFromIndex =
          Number.isInteger(next.dimmedFromIndex) && next.dimmedFromIndex >= 0
            ? next.dimmedFromIndex
            : null;
      }
      if (next.dimmedValues !== undefined) {
        dimmedValuesSet = normalizeDimmedValues(next.dimmedValues);
      }
      if (next.dimmedTagText !== undefined) {
        dimmedTagText = String(next.dimmedTagText || '');
      }
      if (next.getItemBadge !== undefined) {
        getItemBadge = typeof next.getItemBadge === 'function' ? next.getItemBadge : null;
      }
      if (next.onClickItemBadge !== undefined) {
        onClickItemBadge =
          typeof next.onClickItemBadge === 'function' ? next.onClickItemBadge : null;
      }
      if (activeDrag) {
        pendingSyncAfterDrag = true;
        if (next.dimmedValues !== undefined || next.dimmedFromIndex !== undefined) {
          for (let k = 0; k < activeDrag.startItems.length; k += 1) {
            const entry = rowPool[k];
            if (!entry) continue;
            const itemVal = activeDrag.startItems[k];
            const isDimmed = isSlotDimmed(itemVal, k);
            patchClasses(entry.rowEl, { 'is-dimmed': isDimmed });
            patchAttr(entry.dimmedTagEl, 'hidden', !isDimmed || !dimmedTagText);
            if (dimmedTagText) patchText(entry.dimmedTagEl, dimmedTagText);
          }
        }
        return;
      }
      syncRows();
    }

    syncRows();

    onCleanup(() => {
      teardownActiveDrag({ revert: false });
      clearSettleAnimation();
      clearClickSuppression();
      for (const entry of rowPool) {
        entry.selectComp.destroy();
      }
      rowPool.length = 0;
    });

    return {
      el: rootEl,
      refs: {
        listEl,
        addBtn,
        emptyEl,
        setProps,
        getItems: () => [...currentItems],
        getSelects: () => rowPool.slice(0, currentItems.length).map((r) => r.selectComp),
      },
    };
  },
});
