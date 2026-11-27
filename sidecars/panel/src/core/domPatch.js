/**
 * @fileoverview Incremental DOM patching utilities and keyed list reconciler.
 * Prevents full innerHTML replacements and preserves active DOM element state.
 */

export function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, val] of Object.entries(props)) {
      if (val === undefined || val === null || val === false) continue;
      if (key === 'className' || key === 'class') {
        el.className = String(val);
      } else if (key === 'dataset' && typeof val === 'object') {
        for (const [dk, dv] of Object.entries(val)) {
          if (dv !== undefined && dv !== null) {
            el.dataset[dk] = String(dv);
          }
        }
      } else if (key.startsWith('on') && typeof val === 'function') {
        const evt = key.slice(2).toLowerCase();
        el.addEventListener(evt, val);
      } else if (key === 'text') {
        el.textContent = String(val);
      } else if (val === true) {
        el.setAttribute(key, '');
      } else {
        el.setAttribute(key, String(val));
      }
    }
  }
  const childArray = Array.isArray(children) ? children : [children];
  for (const child of childArray) {
    if (child === null || child === undefined || child === false) continue;
    if (typeof child === 'string' || typeof child === 'number') {
      el.appendChild(document.createTextNode(String(child)));
    } else {
      el.appendChild(child);
    }
  }
  return el;
}

export function patchText(el, nextValue) {
  if (!el) return false;
  const nextStr = String(nextValue ?? '');
  if (el.textContent === nextStr) {
    return false;
  }
  el.textContent = nextStr;
  return true;
}

export function patchAttr(el, attrName, nextValue) {
  if (!el) return false;
  if (nextValue === null || nextValue === undefined || nextValue === false) {
    let mutated = false;
    if (el.hasAttribute(attrName)) {
      el.removeAttribute(attrName);
      mutated = true;
    }
    if (attrName === 'value' && 'value' in el && el.value !== '') {
      el.value = '';
      mutated = true;
    }
    return mutated;
  }
  const strVal = nextValue === true ? '' : String(nextValue);
  let mutated = false;
  if (el.getAttribute(attrName) !== strVal) {
    el.setAttribute(attrName, strVal);
    mutated = true;
  }
  if (attrName === 'value' && 'value' in el && el.value !== strVal) {
    el.value = strVal;
    mutated = true;
  }
  return mutated;
}

export function patchClasses(el, classMap) {
  if (!el || !classMap) return false;
  let mutated = false;
  for (const [cls, active] of Object.entries(classMap)) {
    if (!cls) continue;
    const shouldHave = Boolean(active);
    const tokens = String(cls).split(/\s+/).filter(Boolean);
    for (const tok of tokens) {
      const has = el.classList.contains(tok);
      if (has !== shouldHave) {
        el.classList.toggle(tok, shouldHave);
        mutated = true;
      }
    }
  }
  return mutated;
}

export function patchStyleVar(el, varName, nextValue) {
  if (!el) return false;
  const strVal = String(nextValue ?? '');
  const prev = el.style.getPropertyValue(varName);
  if (prev === strVal) {
    return false;
  }
  el.style.setProperty(varName, strVal);
  return true;
}

/**
 * 判断事件是否发生在目标节点内部（兼容 Shadow DOM 的 `composedPath()` 穿透）。
 *
 * @param {Event|null|undefined} event
 * @param {Node|null|undefined} element
 * @returns {boolean}
 */
export function isEventInside(event, element) {
  if (!event || !element) return false;
  if (typeof event.composedPath === 'function') {
    const path = event.composedPath();
    if (Array.isArray(path) && path.includes(element)) {
      return true;
    }
  }
  const target = event.target;
  return Boolean(target && typeof element.contains === 'function' && element.contains(target));
}

function parseCssTransformScale(transformStr) {
  const raw = String(transformStr || '').trim();
  if (!raw || raw === 'none') return null;
  if (raw.startsWith('matrix3d(')) {
    const nums = raw
      .slice(9, -1)
      .split(',')
      .map((s) => Number.parseFloat(s.trim()));
    if (nums.length === 16 && nums.every(Number.isFinite)) {
      const scaleX = Math.hypot(nums[0], nums[1], nums[2]);
      const scaleY = Math.hypot(nums[4], nums[5], nums[6]);
      if (scaleX > 0.1 && scaleX < 10 && scaleY > 0.1 && scaleY < 10) {
        return { scaleX, scaleY };
      }
    }
    return null;
  }
  if (raw.startsWith('matrix(')) {
    const nums = raw
      .slice(7, -1)
      .split(',')
      .map((s) => Number.parseFloat(s.trim()));
    if (nums.length === 6 && nums.every(Number.isFinite)) {
      const scaleX = Math.hypot(nums[0], nums[1]);
      const scaleY = Math.hypot(nums[2], nums[3]);
      if (scaleX > 0.1 && scaleX < 10 && scaleY > 0.1 && scaleY < 10) {
        return { scaleX, scaleY };
      }
    }
  }
  return null;
}

/**
 * 读取元素内容区可用宽度（`clientWidth` 扣除左右 `padding`，用于和子元素 `100%` 布局宽度精确对齐）。
 *
 * @param {Element|null|undefined} el
 * @returns {number}
 */
export function getElementContentWidth(el) {
  const clientW = Number(el?.clientWidth || 0);
  if (!(clientW > 0)) return 0;
  let padL = 0;
  let padR = 0;
  const getStyle =
    typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
      ? window.getComputedStyle
      : typeof getComputedStyle === 'function'
        ? getComputedStyle
        : null;
  if (getStyle) {
    try {
      const cs = getStyle(el);
      const pl = Number.parseFloat(cs?.paddingLeft);
      const pr = Number.parseFloat(cs?.paddingRight);
      if (Number.isFinite(pl) && pl > 0) padL = pl;
      if (Number.isFinite(pr) && pr > 0) padR = pr;
    } catch {
      // 忽略 Mock DOM 样式查询异常
    }
  }
  return Math.max(0, clientW - padL - padR);
}

/**
 * 计算元素当前生效的视觉缩放比（例如入场动画 `scale(0.975)`），
 * 用于将受 `transform` 影响的 `getBoundingClientRect()` 还原为真实 CSS 布局像素。
 *
 * @param {Element|null|undefined} el
 * @param {Element|null|undefined} [stopEl]
 * @returns {{ scaleX: number, scaleY: number }}
 */
export function getVisualTransformScale(el, stopEl = null) {
  let scaleX = 1;
  let scaleY = 1;
  if (!el) return { scaleX, scaleY };
  const getStyle =
    typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
      ? window.getComputedStyle
      : typeof getComputedStyle === 'function'
        ? getComputedStyle
        : null;
  if (getStyle) {
    let cur = el;
    for (let depth = 0; cur && depth < 16; depth++) {
      try {
        const parsed = parseCssTransformScale(getStyle(cur)?.transform);
        if (parsed) {
          scaleX *= parsed.scaleX;
          scaleY *= parsed.scaleY;
        }
      } catch {
        // 忽略 Mock DOM 样式查询异常
      }
      if (stopEl && cur === stopEl) break;
      cur = cur.parentElement || (cur.parentNode && cur.parentNode.nodeType === 1 ? cur.parentNode : null);
    }
  }

  const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
  if (Math.abs(scaleX - 1) <= 0.001) {
    const offsetW = Number(el.offsetWidth || 0);
    const rectW = Number(rect?.width || 0);
    if (offsetW >= 16 && rectW > 0) {
      const ratioX = rectW / offsetW;
      if (Number.isFinite(ratioX) && ratioX > 0.25 && ratioX < 4 && Math.abs(ratioX - 1) > 0.004) {
        scaleX = ratioX;
      }
    }
  }
  if (Math.abs(scaleY - 1) <= 0.001) {
    const offsetH = Number(el.offsetHeight || 0);
    const rectH = Number(rect?.height || 0);
    if (offsetH >= 16 && rectH > 0) {
      const ratioY = rectH / offsetH;
      if (Number.isFinite(ratioY) && ratioY > 0.25 && ratioY < 4 && Math.abs(ratioY - 1) > 0.004) {
        scaleY = ratioY;
      }
    }
  }

  return {
    scaleX: Number.isFinite(scaleX) && scaleX > 0.1 && scaleX < 10 ? scaleX : 1,
    scaleY: Number.isFinite(scaleY) && scaleY > 0.1 && scaleY < 10 ? scaleY : 1,
  };
}

const keyedListState = new WeakMap();

/**
 * Keyed incremental list reconciler.
 * Reuses existing DOM nodes by key and patches only changed items in-place.
 */
export function patchKeyedList(
  container,
  items,
  { keyFn = (_, i) => i, sigFn, createRow, updateRow, destroyRow } = {}
) {
  if (!container) return;
  let map = keyedListState.get(container);
  if (!map) {
    map = new Map();
    keyedListState.set(container, map);
  }

  const nextKeys = new Set();
  const seenInPass = new Map();
  const orderedNodes = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const rawKey = String(keyFn(item, i));
    const dupIdx = seenInPass.get(rawKey) || 0;
    seenInPass.set(rawKey, dupIdx + 1);
    const key = dupIdx === 0 ? rawKey : `${rawKey}__dup_${dupIdx}`;
    const sig = sigFn ? String(sigFn(item, i)) : JSON.stringify(item);
    nextKeys.add(key);

    let record = map.get(key);
    if (!record) {
      const created = createRow(item, i);
      record = {
        el: created.el,
        refs: created.refs,
        sig,
      };
      updateRow(record.refs, item, i, record.el);
      map.set(key, record);
    } else if (record.sig !== sig) {
      record.sig = sig;
      updateRow(record.refs, item, i, record.el);
    }
    orderedNodes.push(record.el);
  }

  // Remove stale keys
  for (const [oldKey, record] of map.entries()) {
    if (!nextKeys.has(oldKey)) {
      if (record.el.parentNode === container) {
        container.removeChild(record.el);
      }
      destroyRow?.(record.refs, record.el);
      map.delete(oldKey);
    }
  }

  if (!container.firstChild && orderedNodes.length > 1 && typeof document.createDocumentFragment === 'function') {
    const fragment = document.createDocumentFragment();
    for (const node of orderedNodes) {
      fragment.appendChild(node);
    }
    container.appendChild(fragment);
    return;
  }

  // Reorder or insert nodes with minimal DOM moves
  for (let i = 0; i < orderedNodes.length; i++) {
    const targetNode = orderedNodes[i];
    const currentNode = container.children[i] || null;
    if (currentNode !== targetNode) {
      container.insertBefore(targetNode, currentNode);
    }
  }
}

const CLIPPING_OVERFLOW_RE = /(?:hidden|clip|auto|scroll)/i;

/**
 * 解析浮层所在的可视裁剪边界（兼容 Shadow DOM 悬浮窗 `.wm-popover-panel`、
 * 侧栏 `.app-shell`、自定义滚动容器 `.custom-scroll-content` 与窗口视口）。
 *
 * @param {HTMLElement} anchorRootEl
 * @returns {{ left: number, top: number, right: number, bottom: number, width: number, height: number } | null}
 */
function resolvePopupBoundaryRect(anchorRootEl) {
  if (!anchorRootEl) return null;
  const winW = typeof window !== 'undefined' ? Number(window.innerWidth || 0) : 0;
  const winH = typeof window !== 'undefined' ? Number(window.innerHeight || 0) : 0;
  let boundLeft = 0;
  let boundTop = 0;
  let boundRight = winW > 0 ? winW : Infinity;
  let boundBottom = winH > 0 ? winH : Infinity;
  let hasBoundary = winW > 0 && winH > 0;

  const getStyle =
    typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
      ? window.getComputedStyle
      : null;

  let cur = anchorRootEl.parentNode || null;
  while (cur) {
    if (cur.nodeType === 1 || typeof cur.getBoundingClientRect === 'function') {
      const cls = cur.classList;
      const isShell = Boolean(
        cls?.contains?.('wm-popover-panel') ||
          cls?.contains?.('wm-multi-panel') ||
          cls?.contains?.('app-shell') ||
          cls?.contains?.('custom-scroll-host') ||
          cls?.contains?.('custom-scroll-content')
      );
      let clipsX = isShell;
      let clipsY = isShell;
      if (!isShell && getStyle) {
        try {
          const cs = getStyle(cur);
          if (cs) {
            clipsX = CLIPPING_OVERFLOW_RE.test(cs.overflowX || cs.overflow || '');
            clipsY = CLIPPING_OVERFLOW_RE.test(cs.overflowY || cs.overflow || '');
          }
        } catch {
          // 忽略 Mock DOM 样式查询异常
        }
      }
      if (clipsX || clipsY) {
        const r = cur.getBoundingClientRect?.();
        if (r && r.width > 0 && r.height > 0) {
          hasBoundary = true;
          if (clipsX) {
            boundLeft = Math.max(boundLeft, r.left);
            boundRight = Math.min(boundRight, r.right);
          }
          if (clipsY) {
            boundTop = Math.max(boundTop, r.top);
            boundBottom = Math.min(boundBottom, r.bottom);
          }
        }
      }
    }
    // 到达 ShadowRoot 或文档顶层后停止，避免误受宿主页面外层容器干扰
    if (!cur.parentNode) break;
    cur = cur.parentNode;
  }

  if (!hasBoundary || !Number.isFinite(boundRight) || !Number.isFinite(boundBottom)) {
    return null;
  }
  const width = Math.max(0, boundRight - boundLeft);
  const height = Math.max(0, boundBottom - boundTop);
  if (width <= 0 || height <= 0) return null;
  return { left: boundLeft, top: boundTop, right: boundRight, bottom: boundBottom, width, height };
}

/**
 * 为锚定在触发器上的绝对定位下拉浮层执行水平/垂直碰撞检测与边界夹紧：
 * - 水平方向优先左对齐，右侧溢出时切右对齐，仍越界则直接夹紧在容器可视安全区内；
 * - 垂直方向底部空间不足且上方更宽裕时自动向上翻转（追加 `.is-above`），并按可用空间收紧 `max-height`。
 *
 * @param {HTMLElement} rootEl 定位基准容器 (`position: relative`)
 * @param {HTMLElement} triggerEl 触发按钮
 * @param {HTMLElement} popupEl 下拉浮层 (`position: absolute`)
 * @param {{ margin?: number, gap?: number, maxHeight?: number, minFlipSpace?: number }} [opts]
 */
export function positionAnchoredPopup(
  rootEl,
  triggerEl,
  popupEl,
  { margin = 6, gap = 4, maxHeight = 220, minFlipSpace = 140 } = {}
) {
  if (!rootEl || !triggerEl || !popupEl || !popupEl.style) return;
  if (popupEl.hasAttribute?.('hidden')) return;

  const rootRect = rootEl.getBoundingClientRect?.();
  const triggerRect = triggerEl.getBoundingClientRect?.();
  if (
    !rootRect ||
    !triggerRect ||
    !(triggerRect.width > 0 && triggerRect.height > 0)
  ) {
    return;
  }

  const bound = resolvePopupBoundaryRect(rootEl);
  if (!bound) return;

  // 清除旧的动态夹紧值以便读取自然布局宽度
  popupEl.style.left = '';
  popupEl.style.right = '';
  popupEl.style.top = '';
  popupEl.style.bottom = '';
  popupEl.style.minWidth = '';
  popupEl.style.maxWidth = '';
  popupEl.style.maxHeight = '';

  const availWidth = Math.max(120, Math.floor(bound.width - margin * 2));
  let cssMaxW = NaN;
  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try {
      const rawMaxW = window.getComputedStyle(popupEl)?.maxWidth;
      if (rawMaxW && rawMaxW !== 'none') {
        cssMaxW = Number.parseFloat(rawMaxW);
      }
    } catch {
      // 忽略 Mock DOM 样式查询异常
    }
  }
  const effectiveMaxW =
    Number.isFinite(cssMaxW) && cssMaxW > 0
      ? Math.max(120, Math.min(availWidth, Math.floor(cssMaxW)))
      : availWidth;
  popupEl.style.maxWidth = `${effectiveMaxW}px`;

  const rawRect = popupEl.getBoundingClientRect?.();
  // 优先读取 offsetWidth，避免入场动画 scale(0.975) 导致测宽偏小
  const naturalW = Math.max(
    Number(popupEl.offsetWidth || 0),
    Math.ceil(Number(rawRect?.width || 0))
  );
  if (naturalW > effectiveMaxW) {
    popupEl.style.minWidth = '0px';
  }
  const popupW = Math.min(
    effectiveMaxW,
    naturalW > 0 ? naturalW : Math.max(triggerRect.width, 210)
  );

  const safeLeft = bound.left + margin;
  const safeRight = bound.right - margin;
  const rawLeft = Number(rawRect?.left);
  const rawRight = Number(rawRect?.right);
  const hasRawBox = Number.isFinite(rawLeft) && Number.isFinite(rawRight) && rawRight > rawLeft;
  // 若入场缩放动画（如 scale(0.975)）正在首帧生效，按对称补偿还原终态边界再判断是否越界
  const scalePadX = hasRawBox ? Math.max(0, (popupW - (rawRight - rawLeft)) / 2) : 0;
  const naturalLeft = hasRawBox ? rawLeft - scalePadX : triggerRect.left;
  const naturalRight = hasRawBox
    ? Math.max(rawRight + scalePadX, naturalLeft + popupW)
    : naturalLeft + popupW;
  const fitsAsDefault = hasRawBox && naturalLeft >= safeLeft && naturalRight <= safeRight;

  if (!fitsAsDefault) {
    let targetLeft = triggerRect.left;
    if (targetLeft + popupW > safeRight) {
      const rightAlignedLeft = triggerRect.right - popupW;
      if (rightAlignedLeft >= safeLeft) {
        targetLeft = rightAlignedLeft;
      } else {
        targetLeft = Math.max(safeLeft, safeRight - popupW);
      }
    }
    if (targetLeft < safeLeft) {
      targetLeft = safeLeft;
    }

    const offsetLeft = Math.round(targetLeft - rootRect.left);
    popupEl.style.left = `${offsetLeft}px`;
    popupEl.style.right = 'auto';
  }

  const spaceBelow = Math.max(0, bound.bottom - triggerRect.bottom - gap - margin);
  const spaceAbove = Math.max(0, triggerRect.top - bound.top - gap - margin);
  const naturalH = Math.max(
    Number(popupEl.scrollHeight || 0),
    Number(popupEl.offsetHeight || 0),
    Math.ceil(Number(rawRect?.height || 0))
  );
  const desiredH = maxHeight > 0 ? Math.min(maxHeight, naturalH || maxHeight) : naturalH || 240;
  const shouldOpenAbove =
    spaceBelow < Math.min(desiredH, minFlipSpace) && spaceAbove > spaceBelow;

  patchClasses(popupEl, { 'is-above': shouldOpenAbove });
  if (shouldOpenAbove) {
    popupEl.style.top = 'auto';
    popupEl.style.bottom = `calc(100% + ${gap}px)`;
    if (maxHeight > 0) {
      popupEl.style.maxHeight = `${Math.max(88, Math.floor(Math.min(maxHeight, spaceAbove)))}px`;
    }
  } else {
    popupEl.style.top = `calc(100% + ${gap}px)`;
    popupEl.style.bottom = 'auto';
    if (maxHeight > 0) {
      popupEl.style.maxHeight = `${Math.max(88, Math.floor(Math.min(maxHeight, spaceBelow)))}px`;
    }
  }
}

/**
 * Clamp `value` to `[minVal, maxVal]` with damped rubber-band overshoot at the ends.
 */
export function applyRubberBand(value, minVal, maxVal, maxOvershoot = 24, factor = 0.25) {
  if (value < minVal) {
    const excess = minVal - value;
    return minVal - Math.min(maxOvershoot, excess * factor);
  }
  if (value > maxVal) {
    const excess = value - maxVal;
    return maxVal + Math.min(maxOvershoot, excess * factor);
  }
  return value;
}

/**
 * Return a shallow copy of `sourceItems` with the element at `fromIdx` moved to `toIdx`.
 */
export function buildReorderedItems(sourceItems, fromIdx, toIdx) {
  const next = [...sourceItems];
  if (fromIdx === toIdx) return next;
  const [moved] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, moved);
  return next;
}

/**
 * Compare two flat slot-key arrays for exact element-by-element equality.
 */
export function areSlotListsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Measure 1D bounding geometry & average gap along 'x' or 'y'.
export function measureLinearMetrics(els, axis = 'x', fallbackSize = 60, fallbackGap = 8) {
  const isX = axis === 'x';
  const metrics = [];
  for (let i = 0; i < els.length; i += 1) {
    const r = els[i]?.getBoundingClientRect?.();
    const sizeVal = isX ? r?.width : r?.height;
    const ok = Boolean(r && Number.isFinite(sizeVal) && sizeVal > 0);
    const size = ok ? sizeVal : fallbackSize;
    const start = ok ? (isX ? r.left : r.top) : i * (fallbackSize + fallbackGap);
    metrics.push({ start, size, end: start + size, center: start + size * 0.5 });
  }
  let gapSum = 0;
  let gapN = 0;
  for (let i = 0; i < metrics.length - 1; i += 1) {
    const g = metrics[i + 1].start - metrics[i].end;
    if (Number.isFinite(g) && g >= 0) {
      gapSum += g;
      gapN += 1;
    }
  }
  return { metrics, gap: gapN > 0 ? gapSum / gapN : fallbackGap };
}

export function setTranslate3d(el, x = 0, y = 0, extra = '') {
  if (!el?.style) return;
  const tx = Math.abs(x) > 0.05 ? x.toFixed(2) : '0';
  const ty = Math.abs(y) > 0.05 ? y.toFixed(2) : '0';
  el.style.transform = `translate3d(${tx}px, ${ty}px, 0)${extra}`;
}

export function computeLinearPermutationLayout(metrics, gap, startIdx, targetIdx) {
  const count = metrics.length;
  const origIndices = Array.from({ length: count }, (_, idx) => idx);
  const perm = buildReorderedItems(origIndices, startIdx, targetIdx);
  let cursor = count > 0 ? metrics[0].start : 0;
  const targetStartByOrig = new Array(count);
  for (let pos = 0; pos < count; pos += 1) {
    const orig = perm[pos];
    targetStartByOrig[orig] = cursor;
    cursor += metrics[orig].size + gap;
  }
  return { perm, targetStartByOrig };
}

export function hitTestLinearCenter(metrics, startIdx, rawDelta) {
  const count = metrics.length;
  if (count <= 1 || !metrics[startIdx]) return startIdx;
  const draggedCenter = metrics[startIdx].center + rawDelta;
  if (rawDelta < 0) {
    for (let i = 0; i < startIdx; i += 1) {
      if (draggedCenter < metrics[i].center) return i;
    }
  } else if (rawDelta > 0) {
    for (let i = count - 1; i > startIdx; i -= 1) {
      if (draggedCenter > metrics[i].center) return i;
    }
  }
  return startIdx;
}

export function findScrollableAncestor(el) {
  let cur = el?.parentNode || null;
  while (cur) {
    if (
      typeof cur.scrollHeight === 'number' &&
      typeof cur.clientHeight === 'number' &&
      cur.scrollHeight > cur.clientHeight + 4
    ) {
      return cur;
    }
    cur = cur.parentNode || null;
  }
  return null;
}

const INTERACTIVE_DRAG_TAGS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A', 'LABEL']);
const INTERACTIVE_DRAG_ROLES = new Set(['button', 'combobox', 'listbox', 'option', 'separator', 'switch', 'tab']);

export function isInteractiveDragTarget(target, boundaryEl = null) {
  let cur = target;
  while (cur && cur !== boundaryEl) {
    const tag = String(cur.tagName || '').toUpperCase();
    if (INTERACTIVE_DRAG_TAGS.has(tag)) return true;
    const role = String(cur.getAttribute?.('role') || '').trim().toLowerCase();
    if (INTERACTIVE_DRAG_ROLES.has(role)) return true;
    if (
      cur.classList?.contains?.('custom-select') ||
      cur.classList?.contains?.('select-menu') ||
      cur.classList?.contains?.('select-trigger')
    ) {
      return true;
    }
    cur = cur.parentNode || null;
  }
  return false;
}

export function createDropSettleAnimator(settleClass = 'is-settling', scaleExpr = '') {
  let timer = null;
  let activeEls = [];

  function clear() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (activeEls.length > 0) {
      for (const el of activeEls) {
        patchClasses(el, { [settleClass]: false });
        if (el?.style) {
          el.style.transition = '';
          el.style.transform = '';
        }
      }
      activeEls = [];
    }
  }

  function trigger(targetOrList, residualX = 0, residualY = 0) {
    const els = Array.isArray(targetOrList)
      ? targetOrList.filter((el) => el?.style)
      : targetOrList?.style
        ? [targetOrList]
        : [];
    if (els.length === 0) return;
    if (Math.abs(residualX) < 0.5 && Math.abs(residualY) < 0.5) return;
    if (typeof requestAnimationFrame !== 'function') return;
    clear();
    activeEls = els;
    const initialTf = `translate3d(${residualX.toFixed(2)}px, ${residualY.toFixed(2)}px, 0)${scaleExpr}`;
    for (const el of activeEls) {
      el.style.transition = 'none';
      el.style.transform = initialTf;
      patchClasses(el, { [settleClass]: true });
    }
    void activeEls[0].offsetWidth;
    requestAnimationFrame(() => {
      if (activeEls !== els) return;
      for (const el of activeEls) {
        el.style.transition = '';
        el.style.transform = 'translate3d(0px, 0px, 0)';
      }
    });
    timer = setTimeout(() => {
      if (activeEls === els) clear();
    }, 220);
  }

  return { clear, trigger };
}

export function startPointerDragSession(
  e,
  {
    threshold = 3,
    immediate = false,
    initialClientX = null,
    initialClientY = null,
    getAutoScrollContainer = null,
    edgeZone = 34,
    onStart = null,
    onMove = null,
    onEnd = null,
  } = {}
) {
  const startX = Number(e?.clientX ?? initialClientX ?? 0);
  const startY = Number(e?.clientY ?? initialClientY ?? 0);
  let lastClientX = Number(initialClientX ?? startX);
  let lastClientY = Number(initialClientY ?? startY);
  let hasMoved = false;
  let finished = false;
  let autoScrollRaf = null;

  function stopAutoScroll() {
    if (autoScrollRaf != null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(autoScrollRaf);
    }
    autoScrollRaf = null;
  }

  const docTarget =
    typeof document !== 'undefined' && typeof document.addEventListener === 'function'
      ? document
      : null;
  const winTarget =
    typeof window !== 'undefined' && typeof window.addEventListener === 'function'
      ? window
      : null;

  function cleanupListeners() {
    stopAutoScroll();
    if (docTarget && typeof docTarget.removeEventListener === 'function') {
      docTarget.removeEventListener('pointermove', onPointerMove);
      docTarget.removeEventListener('pointerup', onPointerUp);
      docTarget.removeEventListener('pointercancel', onPointerCancel);
      docTarget.removeEventListener('keydown', onKeyDown);
    }
    if (winTarget && typeof winTarget.removeEventListener === 'function') {
      winTarget.removeEventListener('blur', onPointerCancel);
    }
  }

  function finish(cancelled, silent = false) {
    if (finished) return;
    finished = true;
    cleanupListeners();
    if (!silent) {
      onEnd?.({ moved: hasMoved, cancelled, clientX: lastClientX, clientY: lastClientY });
    }
  }

  function tickAutoScroll() {
    autoScrollRaf = null;
    if (finished || !hasMoved || typeof getAutoScrollContainer !== 'function') return;
    const sc = getAutoScrollContainer();
    const r = sc?.getBoundingClientRect?.();
    if (!r || r.height <= 0) return;
    let step = 0;
    if (lastClientY < r.top + edgeZone) {
      step = -Math.ceil(3 + Math.min(1, (r.top + edgeZone - lastClientY) / edgeZone) * 7);
    } else if (lastClientY > r.bottom - edgeZone) {
      step = Math.ceil(3 + Math.min(1, (lastClientY - (r.bottom - edgeZone)) / edgeZone) * 7);
    }
    if (step !== 0) {
      const prev = sc.scrollTop;
      sc.scrollTop = prev + step;
      if (sc.scrollTop !== prev) {
        onMove?.({ clientX: lastClientX, clientY: lastClientY, startX, startY });
        if (typeof requestAnimationFrame === 'function') {
          autoScrollRaf = requestAnimationFrame(tickAutoScroll);
        }
      }
    }
  }

  function scheduleAutoScrollCheck() {
    if (
      finished ||
      autoScrollRaf != null ||
      typeof getAutoScrollContainer !== 'function' ||
      typeof requestAnimationFrame !== 'function'
    ) {
      return;
    }
    const r = getAutoScrollContainer()?.getBoundingClientRect?.();
    if (!r || r.height <= 0) return;
    if (lastClientY < r.top + edgeZone || lastClientY > r.bottom - edgeZone) {
      autoScrollRaf = requestAnimationFrame(tickAutoScroll);
    }
  }

  function activate(cx, cy) {
    if (onStart?.({ startX, startY, clientX: cx, clientY: cy }) === false) {
      finish(true, true);
      return false;
    }
    hasMoved = true;
    return true;
  }

  function onPointerMove(ev) {
    if (finished) return;
    const cx = Number(ev?.clientX ?? startX);
    const cy = Number(ev?.clientY ?? startY);
    lastClientX = cx;
    lastClientY = cy;
    if (!hasMoved) {
      if (Math.hypot(cx - startX, cy - startY) < threshold) return;
      if (!activate(cx, cy)) return;
    }
    ev?.preventDefault?.();
    onMove?.({ clientX: cx, clientY: cy, startX, startY });
    scheduleAutoScrollCheck();
  }

  function onPointerUp(ev) {
    if (ev?.clientX != null) lastClientX = Number(ev.clientX);
    if (ev?.clientY != null) lastClientY = Number(ev.clientY);
    finish(false);
  }

  function onPointerCancel() {
    finish(true);
  }

  function onKeyDown(ev) {
    if (ev?.key === 'Escape') finish(true);
  }

  if (docTarget) {
    docTarget.addEventListener('pointermove', onPointerMove);
    docTarget.addEventListener('pointerup', onPointerUp);
    docTarget.addEventListener('pointercancel', onPointerCancel);
    docTarget.addEventListener('keydown', onKeyDown);
  }
  if (winTarget) {
    winTarget.addEventListener('blur', onPointerCancel);
  }

  if (immediate) {
    if (activate(lastClientX, lastClientY)) {
      onMove?.({ clientX: lastClientX, clientY: lastClientY, startX, startY });
      scheduleAutoScrollCheck();
    }
  }

  return {
    cancel: (silent = false) => finish(true, silent),
    isMoved: () => hasMoved,
  };
}

export function startLinearDragReorder(
  e,
  {
    axis = 'x',
    items = [],
    startIdx = 0,
    itemEls = [],
    getTargetEls = null,
    containerEl = null,
    fallbackSize = 60,
    fallbackGap = 8,
    fixedGap = null,
    threshold = 3,
    immediate = false,
    initialClientX = null,
    initialClientY = null,
    autoScroll = false,
    edgeZone = 34,
    rubberBandMax = 24,
    rubberBandRatio = 0.25,
    crossMax = 0,
    crossRatio = 0,
    dragScale = '',
    onStart = null,
    onLayout = null,
    onPreview = null,
    onCancel = null,
    onFinish = null,
  } = {}
) {
  const isX = axis === 'x';
  const startItems = [...items];
  const count = startItems.length;
  let targetIdx = startIdx;
  let workingItems = [...startItems];
  let metrics = [];
  let gap = fixedGap ?? fallbackGap;
  let startContainerPos = 0;
  let hasContainerRect = false;
  let lastMain = 0;
  let lastCross = 0;
  let scrollContainer = null;

  function applyTransform(origIdx, main, cross, extra = '') {
    const targets = getTargetEls ? getTargetEls(origIdx) : [itemEls[origIdx]];
    for (const el of targets) {
      setTranslate3d(el, isX ? main : cross, isX ? cross : main, extra);
    }
  }

  function updateSiblings(nextTargetIdx) {
    const layout = computeLinearPermutationLayout(metrics, gap, startIdx, nextTargetIdx);
    for (let orig = 0; orig < count; orig += 1) {
      if (orig !== startIdx) {
        applyTransform(orig, layout.targetStartByOrig[orig] - metrics[orig].start, 0);
      }
    }
    onLayout?.({ ...layout, targetIdx: nextTargetIdx, metrics, gap });
  }

  const session = startPointerDragSession(e, {
    threshold,
    immediate,
    initialClientX,
    initialClientY,
    getAutoScrollContainer: autoScroll ? () => scrollContainer : null,
    edgeZone,
    onStart: () => {
      const measured = measureLinearMetrics(itemEls, axis, fallbackSize, fallbackGap);
      metrics = measured.metrics;
      gap = fixedGap != null ? fixedGap : measured.gap;
      const cr = containerEl?.getBoundingClientRect?.();
      const cSize = isX ? cr?.width : cr?.height;
      hasContainerRect = Boolean(cr && Number.isFinite(cSize) && cSize > 0);
      startContainerPos = hasContainerRect ? (isX ? cr.left : cr.top) : 0;
      if (autoScroll) scrollContainer = findScrollableAncestor(containerEl);
      onStart?.({ metrics, gap });
      updateSiblings(targetIdx);
    },
    onMove: ({ clientX, clientY, startX, startY }) => {
      const cr = hasContainerRect ? containerEl?.getBoundingClientRect?.() : null;
      const cSize = isX ? cr?.width : cr?.height;
      const containerShift = cr && cSize > 0 ? (isX ? cr.left : cr.top) - startContainerPos : 0;
      const rawMain = (isX ? clientX - startX : clientY - startY) - containerShift;
      const rawCross = isX ? clientY - startY : clientX - startX;

      lastMain = applyRubberBand(
        rawMain,
        metrics[0].start - metrics[startIdx].start,
        metrics[count - 1].end - metrics[startIdx].end,
        rubberBandMax,
        rubberBandRatio
      );
      lastCross =
        crossMax > 0 && rawCross !== 0
          ? Math.sign(rawCross) * Math.min(crossMax, Math.abs(rawCross) * crossRatio)
          : 0;
      applyTransform(startIdx, lastMain, lastCross, dragScale);

      const nextTarget = hitTestLinearCenter(metrics, startIdx, rawMain);
      if (nextTarget !== targetIdx) {
        targetIdx = nextTarget;
        workingItems = buildReorderedItems(startItems, startIdx, targetIdx);
        updateSiblings(targetIdx);
        onPreview?.([...workingItems], targetIdx);
      }
    },
    onEnd: ({ moved, cancelled }) => {
      if (cancelled) {
        onCancel?.({ moved, startItems });
        return;
      }
      const targetOffsetMain =
        moved && metrics.length === count
          ? computeLinearPermutationLayout(metrics, gap, startIdx, targetIdx).targetStartByOrig[startIdx] -
            metrics[startIdx].start
          : 0;
      const residualMain = moved ? lastMain - targetOffsetMain : 0;
      const residualCross = moved ? lastCross : 0;
      const finalItems = [...workingItems];
      const changed = moved && !areSlotListsEqual(startItems, finalItems);
      onFinish?.({
        moved,
        changed,
        targetIdx,
        finalItems,
        residualX: isX ? residualMain : residualCross,
        residualY: isX ? residualCross : residualMain,
      });
    },
  });

  return {
    startItems,
    getWorkingItems: () => workingItems,
    isMoved: session.isMoved,
    cancel: session.cancel,
  };
}
