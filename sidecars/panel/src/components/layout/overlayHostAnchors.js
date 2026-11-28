/**
 * @fileoverview Host IDE/Desktop titlebar & composer button anchor discovery,
 * 4-stage responsive capsule hysteresis, and shared ShadowRoot CSSStyleSheet mounting
 * extracted from WindowOverlayShell.js.
 */

import {
  readInjectedWindowBridge,
  resolveClientEffectiveOverlayMountMode,
} from '../../../shared/window-bridge-protocol.mjs';
import {
  extractHostRouteCascadeId,
  telemetryStore,
} from '../../store/telemetryStore.js';

export const CAPSULE_HOST_ID = 'ag-usage-monitor-capsule';
export const PORTAL_HOST_ID = 'ag-usage-monitor-portal';

/**
 * 带迟滞区间（Hysteresis）的四阶段顶栏双胶囊响应式宽度计算，避免临界宽度反复跳动。
 * 当左侧多会话入口关闭（`showMulti === false`）时自动释放约 76px 预算给右侧指标胶囊；
 * 当槽位数超过 3 个（4..5 槽）时自动按槽位增量上浮 `wide` 阈值。
 *
 * @param {number} availWidth
 * @param {'wide'|'compact'|'minimal'|'ring-only'} currentMode
 * @param {{ showMulti?: boolean, hasUpdate?: boolean, slotCount?: number }} [options]
 * @returns {'wide'|'compact'|'minimal'|'ring-only'}
 */
export function computeCapsuleLayoutMode(availWidth, currentMode = 'wide', options = undefined) {
  if (availWidth == null || Number.isNaN(availWidth)) return 'wide';
  const showMulti = options?.showMulti !== false;
  const updateReserve = options?.hasUpdate ? 52 : 0;
  const slotCount = Number(options?.slotCount || 3);
  const extraSlotWidth = slotCount > 3 ? (slotCount - 3) * 58 : 0;
  const wideKeep = 256 + extraSlotWidth;
  const wideEnter = 272 + extraSlotWidth;
  const baseEffWidth = showMulti ? availWidth : availWidth + 76;
  const effWidth = baseEffWidth - updateReserve;
  if (currentMode === 'wide') {
    if (baseEffWidth < 78) return 'ring-only';
    if (effWidth < 196) return 'minimal';
    if (effWidth < wideKeep) return 'compact';
    return 'wide';
  }
  if (currentMode === 'compact') {
    if (effWidth >= wideEnter) return 'wide';
    if (baseEffWidth < 78) return 'ring-only';
    if (effWidth < 196) return 'minimal';
    return 'compact';
  }
  if (currentMode === 'minimal') {
    if (effWidth >= wideEnter) return 'wide';
    if (effWidth >= 212) return 'compact';
    if (baseEffWidth < 78) return 'ring-only';
    return 'minimal';
  }
  if (effWidth >= wideEnter) return 'wide';
  if (effWidth >= 212) return 'compact';
  if (baseEffWidth >= 92) return 'minimal';
  return 'ring-only';
}

function findIdeWorkbenchTitlebar() {
  try {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
      return null;
    }
    const workbench = document.querySelector('.monaco-workbench');
    if (!workbench?.querySelector) return null;
    const partTitlebar = workbench.querySelector('.part.titlebar');
    if (!partTitlebar?.querySelector) return null;
    if (partTitlebar.getBoundingClientRect) {
      const pr = partTitlebar.getBoundingClientRect();
      if (pr.width <= 0 || pr.height <= 0) return null;
    }
    const container =
      partTitlebar.querySelector(':scope > .titlebar-container') ||
      partTitlebar.querySelector('.titlebar-container');
    const rightGroup =
      container?.querySelector?.(':scope > .titlebar-right') ||
      container?.querySelector?.('.titlebar-right');
    if (!container || !rightGroup) return null;
    const actionToolbar =
      rightGroup.querySelector?.(':scope > .action-toolbar-container') ||
      rightGroup.querySelector?.('.action-toolbar-container') ||
      null;
    return {
      kind: 'ide-titlebar',
      workbench,
      titlebar: container,
      targetContainer: rightGroup,
      actionToolbar,
    };
  } catch {
    return null;
  }
}

function findHostTitlebar() {
  try {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
      return null;
    }
    const tb = document.querySelector('[class*="@container/titlebar"]');
    if (tb?.getBoundingClientRect) {
      const r = tb.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
    }
    return tb;
  } catch {
    return null;
  }
}

const COMPOSER_EXCLUDED_ANCESTOR_SELECTOR =
  '.part.titlebar, .part.statusbar, .quick-input-widget, .suggest-widget, .find-widget, .scm-editor, .search-view, [class*="@container/titlebar"]';
const COMPOSER_MODEL_LABEL_RE =
  /\b(?:gemini|claude|gpt|argon|carbon|neon|hydrogen|helix|flash|sonnet|opus|haiku|orchestrator|llama|deepseek|qwen|mistral|model_placeholder|placeholder_m\d+|o[134](?:-\w+)?)\b/i;
const COMPOSER_MODEL_ATTR_RE =
  /\bmodel[-_\s]?(?:select|picker|switch|selector|menu|name)\b|选择模型|切换模型/i;
const COMPOSER_MODE_EXACT_RE = /^(?:auto|自动)$/i;
const COMPOSER_MODE_TEXT_RE =
  /^(?:auto|ask|manual|supervised|autonomous|always\s*allow|turbo|safe|yolo|plan|planning|act|review|confirm|normal|fast|自动|询问|始终询问|手动|始终允许|受控|规划|快速)(?:\s*(?:mode|模式))?$/i;
const COMPOSER_MODE_ATTR_RE =
  /\b(?:auto(?:nomy|matic)?|execution[-_]?mode|agent[-_]?mode|permission|approval|hitl|policy|mode[-_]?selector|mode[-_]?picker)\b|自动|执行模式|权限模式|审批/i;
const COMPOSER_ICON_FONT_CLASS_RE =
  /\b(?:codicon|material-symbols(?:-\w+)?|material-icons(?:-\w+)?|lucide(?:-\w+)?)\b/i;

function querySimpleSelectorList(root, selectors) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  const seen = new Set();
  const out = [];
  for (const sel of selectors) {
    let list = [];
    try {
      list = root.querySelectorAll(sel) || [];
    } catch {
      list = [];
    }
    for (const item of list) {
      if (item && !seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
    }
  }
  return out;
}

function extractVisibleButtonText(node, isRoot = true) {
  if (!node) return '';
  const tag = String(node.tagName || node.nodeName || '').toLowerCase();
  if (tag === 'svg' || tag === 'style' || tag === 'script') return '';
  if (!isRoot) {
    if (node.getAttribute?.('aria-hidden') === 'true') return '';
    const cls = String(node.className || '');
    if (cls && COMPOSER_ICON_FONT_CLASS_RE.test(cls)) return '';
  }
  if (tag === '#text' || node.nodeType === 3) {
    return String(node.nodeValue ?? node.textContent ?? '');
  }
  const childNodes = node.childNodes || node.children;
  if (!childNodes || childNodes.length === 0) {
    return String(node.textContent || '');
  }
  let acc = '';
  for (const ch of childNodes) {
    acc += ` ${extractVisibleButtonText(ch, false)}`;
  }
  return acc;
}

function cleanComposerButtonText(btn) {
  const raw = extractVisibleButtonText(btn, true)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return '';
  return raw.replace(/^[⌃⌄▾▴∨∧^<>›‹+\s]+|[⌃⌄▾▴∨∧^<>›‹\s]+$/g, '').trim();
}

function isComposerModelButtonItem(item) {
  if (!item) return false;
  if (item.cleanText && COMPOSER_MODEL_LABEL_RE.test(item.cleanText)) return true;
  if (item.attrText && COMPOSER_MODEL_ATTR_RE.test(item.attrText)) return true;
  return false;
}

function hasExcludedComposerAncestor(el) {
  if (!el) return false;
  if (typeof el.closest === 'function') {
    try {
      if (el.closest(COMPOSER_EXCLUDED_ANCESTOR_SELECTOR)) return true;
    } catch {
      // 忽略选择器异常并回退祖先链遍历
    }
  }
  let cur = el.parentElement || el.parentNode;
  while (cur) {
    const cls = String(cur.className || '');
    if (
      cls.includes('@container/titlebar') ||
      cls.includes('quick-input-widget') ||
      cls.includes('suggest-widget') ||
      cls.includes('find-widget') ||
      cls.includes('scm-editor') ||
      cls.includes('search-view') ||
      (cls.includes('part') && (cls.includes('titlebar') || cls.includes('statusbar')))
    ) {
      return true;
    }
    cur = cur.parentElement || cur.parentNode;
  }
  return false;
}

function isNodeHiddenByStyle(el) {
  if (!el) return true;
  if (el.hasAttribute?.('hidden') || el.getAttribute?.('aria-hidden') === 'true') return true;
  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try {
      const cs = window.getComputedStyle(el);
      if (cs?.display === 'none' || cs?.visibility === 'hidden') return true;
    } catch {
      // 忽略样式读取异常
    }
  }
  return false;
}

function getInFlowHostChildren(container, capsuleNode, portalNode) {
  const rawChildren = container?.children || [];
  const out = [];
  for (const ch of rawChildren) {
    if (!ch || ch === capsuleNode || ch === portalNode) continue;
    if (ch.id === CAPSULE_HOST_ID || ch.id === PORTAL_HOST_ID) continue;
    if (ch.hasAttribute?.('hidden')) continue;
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      try {
        const cs = window.getComputedStyle(ch);
        if (cs?.display === 'none') continue;
        if (cs?.position === 'absolute' || cs?.position === 'fixed') continue;
      } catch {
        // 忽略计算样式异常
      }
    }
    out.push(ch);
  }
  return out;
}

function isHorizontalFlexContainer(el) {
  if (!el) return false;
  const cls = String(el.className || '');
  if (/\b(?:inline-)?flex\b/.test(cls) && !/\bflex-col\b/.test(cls)) return true;
  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try {
      const cs = window.getComputedStyle(el);
      const disp = String(cs?.display || '');
      const dir = String(cs?.flexDirection || 'row');
      if (disp.includes('flex') && !dir.startsWith('column')) return true;
    } catch {
      // 忽略计算样式异常
    }
  }
  return false;
}

function isSpaceDistributedFlexContainer(el) {
  if (!el) return false;
  const cls = String(el.className || '');
  if (/\bjustify-(?:between|around|evenly)\b/.test(cls)) return true;
  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try {
      const jc = String(window.getComputedStyle(el)?.justifyContent || '');
      if (jc.includes('space-between') || jc.includes('space-around') || jc.includes('space-evenly')) {
        return true;
      }
    } catch {
      // 忽略计算样式异常
    }
  }
  return false;
}

function buildComposerDockDescriptor(autoBtn, composerCard, bottomRowBtns, capsuleNode, portalNode, patchedNode) {
  if (!autoBtn || !composerCard) return null;
  let item = autoBtn;
  while (
    (item.parentElement || item.parentNode) &&
    (item.parentElement || item.parentNode) !== composerCard &&
    (item.parentElement || item.parentNode) !== document.body
  ) {
    const parent = item.parentElement || item.parentNode;
    const hostSiblings = getInFlowHostChildren(parent, capsuleNode, portalNode);
    if (hostSiblings.length >= 2) break;
    const grandParent = parent.parentElement || parent.parentNode;
    const parentCls = String(parent.className || '');
    const parentInlineMl = String(parent.style?.marginLeft || '').trim();
    const isSingleClusterInSplitRow =
      !/\b(?:relative|ml-auto|ms-auto)\b/.test(parentCls) &&
      parentInlineMl !== 'auto' &&
      isHorizontalFlexContainer(parent) &&
      grandParent &&
      isSpaceDistributedFlexContainer(grandParent) &&
      getInFlowHostChildren(grandParent, capsuleNode, portalNode).length >= 2;
    if (isSingleClusterInSplitRow) {
      break;
    }
    item = parent;
  }

  const anchorNode = item;
  const targetContainer = anchorNode.parentElement || anchorNode.parentNode;
  if (!targetContainer) return null;

  const hostChildren = getInFlowHostChildren(targetContainer, capsuleNode, portalNode);
  const anchorIdx = hostChildren.indexOf(anchorNode);
  const isFirstHostChild = anchorIdx <= 0;

  let needsAutoMarginTransfer = false;
  let patchMarginNode = null;

  if (!isFirstHostChild) {
    const cls = String(anchorNode.className || '');
    const inlineMl = String(anchorNode.style?.marginLeft || '').trim();
    let computedLargeMl = false;
    if (
      patchedNode !== anchorNode &&
      typeof window !== 'undefined' &&
      typeof window.getComputedStyle === 'function'
    ) {
      try {
        const mlPx = parseFloat(window.getComputedStyle(anchorNode)?.marginLeft) || 0;
        const prevSib = hostChildren[anchorIdx - 1];
        const aRect = anchorNode.getBoundingClientRect?.();
        const pRect = prevSib?.getBoundingClientRect?.();
        if (mlPx > 24 && aRect && pRect && aRect.left - pRect.right >= mlPx - 6) {
          computedLargeMl = true;
        }
      } catch {
        // 忽略边距测量异常
      }
    }

    if (
      /\b(?:ml-auto|ms-auto)\b/.test(cls) ||
      inlineMl === 'auto' ||
      patchedNode === anchorNode ||
      computedLargeMl
    ) {
      needsAutoMarginTransfer = true;
      patchMarginNode = anchorNode;
    } else if (isSpaceDistributedFlexContainer(targetContainer)) {
      needsAutoMarginTransfer = true;
    }
  }

  const autoRect = anchorNode.getBoundingClientRect?.() || autoBtn.getBoundingClientRect?.();
  let leftClusterRightEdge = 0;
  if (autoRect && Array.isArray(bottomRowBtns)) {
    for (const entry of bottomRowBtns) {
      if (entry.btn === autoBtn || anchorNode.contains?.(entry.btn)) continue;
      if (entry.rect.left < autoRect.left - 2 && entry.rect.right <= autoRect.left + 4) {
        if (entry.rect.right > leftClusterRightEdge) {
          leftClusterRightEdge = entry.rect.right;
        }
      }
    }
  }

  return {
    kind: 'composer',
    workbench: null,
    titlebar: composerCard,
    targetContainer,
    actionToolbar: patchMarginNode,
    anchorNode,
    needsAutoMarginTransfer,
    leftClusterRightEdge,
  };
}

function buildComposerRightEndDockDescriptor(
  leftAnchorBtn,
  composerCard,
  bottomRowBtns,
  capsuleNode,
  portalNode
) {
  if (!leftAnchorBtn || !composerCard) return null;
  const cardRect = composerCard.getBoundingClientRect?.();
  const minRowWidth = cardRect && cardRect.width > 0 ? cardRect.width * 0.65 : 180;
  let toolbarRow = null;
  let cur = leftAnchorBtn.parentElement || leftAnchorBtn.parentNode;
  for (let d = 0; d < 8 && cur && cur !== composerCard && cur !== document.body; d += 1) {
    const r = cur.getBoundingClientRect?.();
    if (r && r.width >= minRowWidth && r.height > 0 && r.height <= 60 && isHorizontalFlexContainer(cur)) {
      toolbarRow = cur;
      break;
    }
    cur = cur.parentElement || cur.parentNode;
  }
  if (!toolbarRow) {
    const p = leftAnchorBtn.parentElement || leftAnchorBtn.parentNode;
    if (!p || !isHorizontalFlexContainer(p)) return null;
    toolbarRow = p;
  }

  let leftClusterRightEdge = 0;
  if (Array.isArray(bottomRowBtns)) {
    for (const entry of bottomRowBtns) {
      if (entry?.rect?.right > leftClusterRightEdge) {
        leftClusterRightEdge = entry.rect.right;
      }
    }
  }

  const rowChildren = getInFlowHostChildren(toolbarRow, capsuleNode, portalNode);
  const lastChild = rowChildren.length >= 2 ? rowChildren[rowChildren.length - 1] : null;
  if (
    lastChild &&
    !lastChild.contains?.(leftAnchorBtn) &&
    isHorizontalFlexContainer(lastChild) &&
    getInFlowHostChildren(lastChild, capsuleNode, portalNode).length === 0
  ) {
    return {
      kind: 'composer',
      workbench: null,
      titlebar: composerCard,
      targetContainer: lastChild,
      actionToolbar: null,
      anchorNode: null,
      needsAutoMarginTransfer: false,
      leftClusterRightEdge,
    };
  }

  return {
    kind: 'composer',
    workbench: null,
    titlebar: composerCard,
    targetContainer: toolbarRow,
    actionToolbar: null,
    anchorNode: null,
    needsAutoMarginTransfer: true,
    leftClusterRightEdge,
  };
}

function collectComposerBottomButtons(container, editorEl, editorRect, capsuleNode, portalNode) {
  const rawBtns = querySimpleSelectorList(container, ['button', '[role="button"]', '[aria-haspopup]']);
  const hostBtns = [];
  for (const btn of rawBtns) {
    if (!btn || btn === editorEl || editorEl?.contains?.(btn)) continue;
    if (editorEl && btn.contains?.(editorEl)) continue;
    if (
      btn.id === CAPSULE_HOST_ID ||
      btn.id === PORTAL_HOST_ID ||
      capsuleNode?.contains?.(btn) ||
      portalNode?.contains?.(btn)
    ) {
      continue;
    }
    if (isNodeHiddenByStyle(btn)) continue;
    // 仅排除嵌套在真实紧凑按钮内部的图标/子触发器，避免外层卡片级 role="button" 误杀工具栏按钮
    let nestedInBtn = false;
    let p = btn.parentElement || btn.parentNode;
    while (p && p !== container) {
      const pTag = String(p.tagName || '').toLowerCase();
      if (pTag === 'button') {
        nestedInBtn = true;
        break;
      }
      if (
        (p.getAttribute?.('role') === 'button' || p.hasAttribute?.('aria-haspopup')) &&
        !(editorEl && p.contains?.(editorEl))
      ) {
        const pr = p.getBoundingClientRect?.();
        if (pr && pr.height > 0 && pr.height <= 48 && pr.width > 0 && pr.width <= 360) {
          nestedInBtn = true;
          break;
        }
      }
      p = p.parentElement || p.parentNode;
    }
    if (nestedInBtn) continue;

    const br = btn.getBoundingClientRect?.();
    if (!br || br.width <= 0 || br.height <= 0 || br.height > 48) continue;
    const centerY = (br.top + br.bottom) / 2;
    if (editorRect && centerY < editorRect.top - 4) continue;
    hostBtns.push({
      btn,
      rect: br,
      centerY,
      centerX: (br.left + br.right) / 2,
      cleanText: cleanComposerButtonText(btn),
      attrText: `${btn.getAttribute?.('data-testid') || ''} ${btn.getAttribute?.('aria-label') || ''} ${btn.getAttribute?.('title') || ''}`.trim(),
    });
  }
  if (hostBtns.length === 0) return [];
  let maxCenterY = -Infinity;
  for (const item of hostBtns) {
    if (item.centerY > maxCenterY) maxCenterY = item.centerY;
  }
  const bottomBand = hostBtns.filter((item) => Math.abs(item.centerY - maxCenterY) <= 22);
  bottomBand.sort((a, b) => a.rect.left - b.rect.left);
  return bottomBand;
}

function pickAutoButtonFromRow(bottomRowBtns, containerRect, options = undefined) {
  if (!Array.isArray(bottomRowBtns) || bottomRowBtns.length === 0) return null;
  const requireModelForFallback = Boolean(options?.requireModelForFallback);
  const rightSplitX = containerRect ? containerRect.left + containerRect.width * 0.35 : 0;
  const rightFirst = [
    ...bottomRowBtns.filter((b) => b.centerX >= rightSplitX),
    ...bottomRowBtns.filter((b) => b.centerX < rightSplitX),
  ];

  // Tier 1: 精确文本 Auto / 自动 匹配
  for (const item of rightFirst) {
    if (COMPOSER_MODE_EXACT_RE.test(item.cleanText)) {
      return { btn: item.btn, tier: 1 };
    }
  }

  // Tier 2: 执行/权限模式文案或无障碍语义属性匹配（排除模型选择器按钮）
  for (const item of rightFirst) {
    if (isComposerModelButtonItem(item)) continue;
    if (
      (item.cleanText && COMPOSER_MODE_TEXT_RE.test(item.cleanText)) ||
      (item.attrText && COMPOSER_MODE_ATTR_RE.test(item.attrText))
    ) {
      return { btn: item.btn, tier: 2 };
    }
  }

  const hasModelBtn = bottomRowBtns.some(isComposerModelButtonItem);

  // Tier 3: 几何右簇首按钮兜底（适配 Antigravity IDE 无 Auto 按钮、右侧为发送/语音按钮的输入栏布局）
  if (bottomRowBtns.length >= 2 && (!requireModelForFallback || hasModelBtn)) {
    let maxGap = -Infinity;
    let splitIdx = -1;
    for (let i = 1; i < bottomRowBtns.length; i += 1) {
      const gap = bottomRowBtns[i].rect.left - bottomRowBtns[i - 1].rect.right;
      if (gap > maxGap) {
        maxGap = gap;
        splitIdx = i;
      }
    }
    if (splitIdx >= 1 && maxGap >= 16) {
      return { btn: bottomRowBtns[splitIdx].btn, tier: 3 };
    }
  }

  // Tier 4: 输入为空时若右侧发送按钮暂时隐藏、仅左侧存在模型选择器按钮，停靠至工具栏最右侧
  if (hasModelBtn && containerRect && containerRect.width >= 200) {
    const lastItem = bottomRowBtns[bottomRowBtns.length - 1];
    if (lastItem.rect.right <= containerRect.left + containerRect.width * 0.72) {
      return { btn: null, leftAnchorBtn: lastItem.btn, tier: 4 };
    }
  }

  return null;
}

function resolveComposerEditorRect(ed) {
  const er = ed?.getBoundingClientRect?.();
  if (er && er.width >= 80 && er.height >= 12) return er;
  let cur = ed;
  for (let d = 0; d < 6 && cur; d += 1) {
    if (String(cur.className || '').includes('monaco-editor')) {
      const mr = cur.getBoundingClientRect?.();
      if (mr && mr.width >= 80 && mr.height >= 12) return mr;
      break;
    }
    cur = cur.parentElement || cur.parentNode;
  }
  return er || null;
}

function findHostComposerAutoTarget(capsuleNode = null, portalNode = null, patchedNode = null) {
  try {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') {
      return null;
    }
    const capEl = capsuleNode || document.getElementById?.(CAPSULE_HOST_ID) || null;
    const porEl = portalNode || document.getElementById?.(PORTAL_HOST_ID) || null;
    const activeRouteId = extractHostRouteCascadeId();

    // 1. 优先从活跃会话的输入框编辑器向上定位底部工具栏和 Auto / 右簇发送按钮
    const rawEditors = querySimpleSelectorList(document, [
      'textarea',
      '[contenteditable]',
      '[role="textbox"]',
      '[data-lexical-editor]',
      '.ProseMirror',
      '.monaco-editor',
    ]);
    const scoredEditors = [];
    for (const ed of rawEditors) {
      if (!ed || capEl?.contains?.(ed) || porEl?.contains?.(ed)) continue;
      if (ed.hasAttribute?.('contenteditable')) {
        const ce = String(ed.getAttribute('contenteditable') || '').trim().toLowerCase();
        if (ce === 'false' && ed.getAttribute?.('role') !== 'textbox') continue;
      }
      if (isNodeHiddenByStyle(ed) || hasExcludedComposerAncestor(ed)) continue;
      const er = resolveComposerEditorRect(ed);
      if (!er || er.width < 100 || er.height < 12 || er.height > 540) continue;

      let score = Math.min(1200, er.width) + Math.max(0, er.bottom) * 0.2;
      if (activeRouteId) {
        let anc = ed.parentElement || ed.parentNode;
        while (anc) {
          const cid = anc.getAttribute?.('data-cascade-id');
          if (cid) {
            score += cid === activeRouteId ? 4000 : -2000;
            break;
          }
          anc = anc.parentElement || anc.parentNode;
        }
      }
      if (
        document.activeElement &&
        (ed === document.activeElement || ed.contains?.(document.activeElement))
      ) {
        score += 1000;
      }
      scoredEditors.push({ ed, rect: er, score });
    }
    scoredEditors.sort((a, b) => b.score - a.score);

    for (const { ed, rect: er } of scoredEditors) {
      const isMonacoCandidate = String(ed.className || '').includes('monaco-editor') ||
        String(ed.className || '').includes('inputarea');
      let tier3Candidate = null;
      let tier4Candidate = null;
      let cur = ed.parentElement || ed.parentNode;
      for (let depth = 0; depth < 18 && cur; depth += 1) {
        if (cur === document.body || cur === document.documentElement) break;
        const tag = String(cur.tagName || '').toLowerCase();
        if (tag === 'main' || String(cur.className || '').includes('monaco-workbench')) break;
        const cr = cur.getBoundingClientRect?.();
        if (cr && cr.height > 680) break;
        if (cr && cr.width >= 180 && cr.height > 0) {
          const bottomRowBtns = collectComposerBottomButtons(cur, ed, er, capEl, porEl);
          const picked = pickAutoButtonFromRow(bottomRowBtns, cr, {
            requireModelForFallback: isMonacoCandidate,
          });
          if (picked) {
            if (picked.tier <= 2) {
              const desc = buildComposerDockDescriptor(
                picked.btn,
                cur,
                bottomRowBtns,
                capEl,
                porEl,
                patchedNode
              );
              if (desc) return desc;
            } else if (picked.tier === 3 && !tier3Candidate) {
              tier3Candidate = { btn: picked.btn, card: cur, bottomRowBtns };
            } else if (picked.tier === 4 && !tier4Candidate) {
              tier4Candidate = { leftAnchorBtn: picked.leftAnchorBtn, card: cur, bottomRowBtns };
            }
          }
        }
        cur = cur.parentElement || cur.parentNode;
      }
      if (tier3Candidate) {
        const desc = buildComposerDockDescriptor(
          tier3Candidate.btn,
          tier3Candidate.card,
          tier3Candidate.bottomRowBtns,
          capEl,
          porEl,
          patchedNode
        );
        if (desc) return desc;
      }
      if (tier4Candidate) {
        const desc = buildComposerRightEndDockDescriptor(
          tier4Candidate.leftAnchorBtn,
          tier4Candidate.card,
          tier4Candidate.bottomRowBtns,
          capEl,
          porEl
        );
        if (desc) return desc;
      }
    }

    // 2. 兜底路径：编辑器自定义封装或暂时只读时，直接扫描底部包含模型选择器或 Auto 按钮的输入工具栏
    const vh = Number(window.innerHeight || 800);
    const allBtns = querySimpleSelectorList(document, ['button', '[role="button"]', '[aria-haspopup]']);
    let modelToolbarFallback = null;
    for (const btn of allBtns) {
      if (!btn || capEl?.contains?.(btn) || porEl?.contains?.(btn)) continue;
      if (isNodeHiddenByStyle(btn) || hasExcludedComposerAncestor(btn)) continue;
      const br = btn.getBoundingClientRect?.();
      if (!br || br.width <= 0 || br.height <= 0 || br.height > 48 || br.top < vh * 0.2) continue;
      const clean = cleanComposerButtonText(btn);
      const attr = `${btn.getAttribute?.('data-testid') || ''} ${btn.getAttribute?.('aria-label') || ''} ${btn.getAttribute?.('title') || ''}`.trim();
      const itemProbe = { cleanText: clean, attrText: attr };
      const isModeBtn =
        COMPOSER_MODE_EXACT_RE.test(clean) ||
        (!isComposerModelButtonItem(itemProbe) &&
          ((clean && COMPOSER_MODE_TEXT_RE.test(clean)) || (attr && COMPOSER_MODE_ATTR_RE.test(attr))));
      const isModelBtn = isComposerModelButtonItem(itemProbe);
      if (!isModeBtn && !isModelBtn) continue;

      let cur = btn.parentElement || btn.parentNode;
      for (let depth = 0; depth < 12 && cur; depth += 1) {
        if (cur === document.body || cur === document.documentElement) break;
        if (String(cur.className || '').includes('monaco-workbench')) break;
        const cr = cur.getBoundingClientRect?.();
        if (!cr || cr.height > 560) break;
        if (cr.width >= 200) {
          const rowBtns = collectComposerBottomButtons(cur, null, null, capEl, porEl);
          if (isModeBtn) {
            const hasModelSibling = rowBtns.some((b) => b.btn !== btn && isComposerModelButtonItem(b));
            if (hasModelSibling) {
              const desc = buildComposerDockDescriptor(btn, cur, rowBtns, capEl, porEl, patchedNode);
              if (desc) return desc;
            }
          } else if (isModelBtn && !modelToolbarFallback) {
            const picked = pickAutoButtonFromRow(rowBtns, cr, { requireModelForFallback: true });
            if (picked) {
              const desc =
                picked.tier <= 3 && picked.btn
                  ? buildComposerDockDescriptor(picked.btn, cur, rowBtns, capEl, porEl, patchedNode)
                  : picked.tier === 4 && picked.leftAnchorBtn
                    ? buildComposerRightEndDockDescriptor(
                        picked.leftAnchorBtn,
                        cur,
                        rowBtns,
                        capEl,
                        porEl
                      )
                    : null;
              if (desc) {
                if (picked.tier <= 2) return desc;
                modelToolbarFallback = desc;
                break;
              }
            }
          }
        }
        cur = cur.parentElement || cur.parentNode;
      }
    }
    if (modelToolbarFallback) return modelToolbarFallback;
  } catch {
    // 忽略输入框探测异常
  }
  return null;
}

export function isImmediatelyBeforeNode(node, refNode) {
  if (!node || !refNode) return false;
  if (node.nextElementSibling !== undefined) {
    return node.nextElementSibling === refNode;
  }
  if (node.nextSibling !== undefined) {
    return node.nextSibling === refNode;
  }
  const parent = node.parentElement || node.parentNode;
  if (!parent?.children) return false;
  const idx = Array.prototype.indexOf.call(parent.children, node);
  return idx >= 0 && parent.children[idx + 1] === refNode;
}

export function isIdeExtensionChatFrame() {
  try {
    if (typeof window === 'undefined') return false;
    if (readInjectedWindowBridge()?.isIdeChatFrame === true) return true;
    return /[?&]extension(?:View|Variant)=/i.test(String(window.location?.search || ''));
  } catch {
    return false;
  }
}

export function resolveActiveDockTarget(options = undefined) {
  const settings = telemetryStore.getState().telemetry?.settings;
  const mountMode =
    options?.mountMode || resolveClientEffectiveOverlayMountMode(settings);
  if (isIdeExtensionChatFrame()) {
    if (mountMode !== 'composer') return null;
    return findHostComposerAutoTarget(
      options?.capsuleNode || null,
      options?.portalNode || null,
      options?.patchedNode || null
    );
  }
  if (mountMode === 'composer') {
    const composerTarget = findHostComposerAutoTarget(
      options?.capsuleNode || null,
      options?.portalNode || null,
      options?.patchedNode || null
    );
    if (composerTarget) return composerTarget;
  }
  const ideTarget = findIdeWorkbenchTitlebar();
  if (ideTarget) return ideTarget;
  const titlebar = findHostTitlebar();
  if (!titlebar) return null;
  let targetContainer = titlebar;
  try {
    const rightGroup = titlebar.querySelector(':scope > div.shrink-0') || titlebar.lastElementChild;
    if (rightGroup && rightGroup !== titlebar.firstElementChild) {
      targetContainer = rightGroup;
    }
  } catch {
    // 忽略子选择器不兼容场景
  }
  return {
    kind: 'flow',
    workbench: null,
    titlebar,
    targetContainer,
    actionToolbar: null,
  };
}

export function findNativeTopRightAnchor() {
  try {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
      return null;
    }
    const auxToggle = document.querySelector('[data-testid="toggle-aux-sidebar"]');
    if (auxToggle?.closest) {
      return auxToggle.closest('div.absolute.right-0.top-0') || auxToggle;
    }
    const candidates = document.querySelectorAll('button, a, [role="button"]');
    for (const btn of candidates) {
      const text = String(btn.textContent || '').trim();
      if (
        (text === 'Open IDE' || text === '打开 IDE' || text.includes('Open IDE') || text.includes('打开 IDE')) &&
        btn.getBoundingClientRect?.().top < 52
      ) {
        return btn.closest?.('div.flex.items-center, div.absolute.right-0') || btn;
      }
    }
    return document.querySelector('div.absolute.right-0.top-0');
  } catch {
    return null;
  }
}

export function getLeftSidebarRightEdge(vw) {
  try {
    if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
      if (document.querySelector('.monaco-workbench')) {
        return 0;
      }
      const navEl = document.querySelector('div[role="navigation"]');
      if (navEl?.getBoundingClientRect) {
        const nr = navEl.getBoundingClientRect();
        if (nr.width > 0 && nr.left <= 8 && nr.right > 0 && nr.right < vw - 280) {
          return Math.ceil(nr.right);
        }
      }
    }
  } catch {
    // 忽略侧栏测量异常
  }
  return 0;
}

/**
 * 检测主窗口右侧辅助栏（Antigravity 2.0 `aux-pane` / `用量监控` 侧栏或 IDE `.part.auxiliarybar`）的左边界 X 坐标，
 * 供顶栏浮动面板（如 `.wm-multi-panel`）做右边界避让，防止跨过分栏线遮挡右侧栏内容。
 * 未展开右侧栏或边界不合理时返回 `0`。
 *
 * @param {number} vw
 * @returns {number}
 */
export function getRightSidebarLeftEdge(vw) {
  try {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
      return 0;
    }
    const safeVw = Number(vw || 0);
    if (!(safeVw > 320)) return 0;

    const sashEl = document.querySelector('[data-testid="aux-pane-sash"]');
    if (sashEl && !isNodeHiddenByStyle(sashEl) && sashEl.getBoundingClientRect) {
      const sr = sashEl.getBoundingClientRect();
      if (
        (sr.width > 0 || sr.height > 0) &&
        sr.left > 240 &&
        sr.left < safeVw - 40
      ) {
        return Math.floor(sr.left);
      }
    }

    const auxSelectors = [
      '.monaco-workbench .part.auxiliarybar',
      '.monaco-workbench .part.sidebar.right',
      '[data-testid="aux-pane"]',
      '[data-testid="aux-sidebar"]',
      'aside[data-side="right"]',
      'iframe[src*="usage-monitor"]',
      'webview[src*="usage-monitor"]',
    ];
    let minLeftEdge = 0;
    for (const sel of auxSelectors) {
      const el = document.querySelector(sel);
      if (!el || el.id === CAPSULE_HOST_ID || el.id === PORTAL_HOST_ID) continue;
      if (isNodeHiddenByStyle(el) || !el.getBoundingClientRect) continue;
      const r = el.getBoundingClientRect();
      if (
        r.width >= 120 &&
        r.height > 0 &&
        r.left > 240 &&
        r.left < safeVw - 40 &&
        r.right >= safeVw - 24
      ) {
        const edge = Math.floor(r.left);
        if (minLeftEdge === 0 || edge < minLeftEdge) {
          minLeftEdge = edge;
        }
      }
    }
    if (minLeftEdge > 0) return minLeftEdge;

    const tbEl = findHostTitlebar();
    if (tbEl && !isNodeHiddenByStyle(tbEl) && tbEl.getBoundingClientRect) {
      const tr = tbEl.getBoundingClientRect();
      if (tr.width >= 300 && tr.height > 0 && tr.right > 300 && tr.right < safeVw - 160) {
        return Math.floor(tr.right);
      }
    }
    return 0;
  } catch {
    // 忽略右侧栏测量异常
  }
  return 0;
}

/**
 * 在主窗口挂载双栖顶栏胶囊和完整四标签悬浮面板，并注册 `window.__AGUsageMonitorOverlay` 生命周期句柄。
 */
const CAPSULE_EXCLUDED_CSS_SECTIONS = new Set([
  'src/styles/views-overview.css',
  'src/styles/views-consumption.css',
  'src/styles/views-tables.css',
  'src/styles/views-settings.css',
  'src/styles/controls.css',
]);

let sharedOverlayStyleSheetMemo = { rawCss: '', sheet: null };

function buildSlimCapsuleCss(fullCss) {
  if (!fullCss || !fullCss.includes('/* --- src/styles/')) return fullCss;
  return fullCss
    .split(/(?=\/\* --- src\/styles\/)/)
    .filter((block) => {
      const m = block.match(/^\/\* --- (src\/styles\/[^\s]+) --- \*\//);
      return !m || !CAPSULE_EXCLUDED_CSS_SECTIONS.has(m[1]);
    })
    .join('');
}

export function attachShadowStyles(shadowRoot, fullCss, { slimCapsule = false } = {}) {
  if (!shadowRoot) return;
  if (
    fullCss &&
    typeof CSSStyleSheet === 'function' &&
    Array.isArray(shadowRoot.adoptedStyleSheets)
  ) {
    try {
      if (sharedOverlayStyleSheetMemo.rawCss !== fullCss || !sharedOverlayStyleSheetMemo.sheet) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(fullCss);
        sharedOverlayStyleSheetMemo = { rawCss: fullCss, sheet };
      }
      shadowRoot.adoptedStyleSheets = [sharedOverlayStyleSheetMemo.sheet];
      return;
    } catch {
      // 降级到传统 <style> 节点
    }
  }
  const styleEl = document.createElement('style');
  styleEl.textContent = slimCapsule ? buildSlimCapsuleCss(fullCss) : fullCss;
  shadowRoot.appendChild(styleEl);
}
