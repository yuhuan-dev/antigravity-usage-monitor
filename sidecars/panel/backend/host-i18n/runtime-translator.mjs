/**
 * @fileoverview 注入到 Antigravity 渲染进程的无损运行时 DOM 翻译引擎与按需词条采集器。
 *
 * 工程底线：
 * 1. 绝不替换、拆裂或增删 React 托管的任何 DOM 元素，仅原地改写 `Text.nodeValue` 及
 *    `placeholder` / `title` / `aria-label` / `aria-description` / `aria-placeholder` 属性；
 * 2. 通过 `WeakMap` 精确记录每个被改写节点/属性的原文与译文，既支持 `light ↔ deep` /
 *    `关闭` 秒级无损还原，也能自动识别 React 原地更新的新英文文案并重新翻译；
 * 3. 对齐 Antigravity 真实 DOM 结构，严格豁免用户消息正文（`user-message-content`）、
 *    AI 回复正文（`planner-response-text` / `progress-update-response-text`）、
 *    Markdown 内容根（`data-markdown-root` / `.md-divider-spacing` / `data-md-table`）、
 *    KaTeX 公式可见层（`.katex` / `.katex-display` / `.katex-html` / `.katex-mathml` / `.md-math-display`）、
 *    代码块、Diff 行、编辑器、终端、可编辑区以及本插件双 Shadow Host，不误伤工具栏按钮；
 * 4. 针对数千条精确词条 + 数百条动态模板做 O(1) 精确查表 + 首词桶索引，并经
 *    `requestAnimationFrame` 分帧合批，杜绝流式输出掉帧。
 */

import { HOST_I18N_GLOBAL_KEY } from '../../shared/host-i18n-protocol.mjs';

/**
 * 宿主页面跳过配置（翻译引擎与未翻译采集器共用单一数据源，通过参数注入到 CDP 隔离执行环境）。
 */
export const HOST_I18N_SKIP_CONFIG = Object.freeze({
  tags: Object.freeze([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'CODE',
    'PRE',
    'TEXTAREA',
    'SVG',
    'MATH',
    'KBD',
    'SAMP',
    'VAR',
    'CANVAS',
    'VIDEO',
    'AUDIO',
    'IFRAME',
  ]),
  attrs: Object.freeze([
    'data-ag-i18n-ignore',
    'data-markdown-root',
    'data-markdown-block-index',
    'data-md-table',
    'data-quotable-inline',
    'data-uri',
    'data-line-tokens',
    'data-line-number',
    'data-diff-type',
    'data-current-original-line',
    'data-current-modified-line',
  ]),
  testIds: Object.freeze([
    'user-message-content',
    'user-message-bubble',
    'agent-message-bubble',
    'user-message-document-chip',
    'attached-context-pill',
    'entity-pill',
    'resource-link',
    'file-title-name',
    'webview-download-filename',
    'breadcrumb-segment',
    'planner-response-text',
    'progress-update-response-text',
    'planner-response-debug-error',
    'ask-question-header-text',
    'ask-question-option-text',
    'side-question-followup-user',
    'browser-subagent-thinking',
    'live-agent-turn',
    'live-user-turn',
    'voice-agent-message',
    'voice-user-message',
    'voice-transcript-summary',
    'coordinator-card-latest-line',
    'comment-card-text',
    'step-plan-item',
    'vcs-commit-message',
    'setup-script-output',
    'pill-comment-anchor-text',
    'markdown-code-block-preview',
    'markdown-frontmatter',
    'automation-instructions-markdown',
    'lsp-hover-body',
    'code-gutter',
    'code-gutter-diff',
    'diff-gutter-strip',
    'artifact-pdf-view',
    'pdf-text-layer',
    'transcript-line-text',
    'terminal-surface',
    'terminal-tab-surface',
    'swarm-title',
    'swarm-overview-frame',
    'swarm-raw',
    'swarm-control-message',
    'swarm-running-activity',
    'swarm-member-activity',
    'swarm-member-owner',
    'swarm-member-workspace',
  ]),
  classes: Object.freeze([
    'monaco-editor',
    'xterm',
    'cm-editor',
    'cm-content',
    'cm-line',
    'ProseMirror',
    'markdown-body',
    'prose',
    'md-divider-spacing',
    'agy-sidebar-row',
    'katex',
    'katex-display',
    'katex-html',
    'katex-mathml',
    'md-math-display',
    'code-block',
    'code-line',
    'line-content',
    'diff-line',
    'view-lines',
    'shiki',
    'prism-code',
    'hljs',
    'token-line',
    'swarm-title',
    'ov-frame',
    'raw',
    'raw-pre',
    'raw-meta',
    'msg-body',
    'post-body',
    'post-md',
    'msg-author',
    'msg-to',
    'chip-name',
    'sys-text',
    'o2-mauth',
    'o2-wchip',
    'o2-runsum',
    'o2-runt',
    'o2-runnote',
    'o2-donem',
    'o2-rcap',
    'o2-thg',
    'o2-sttxt',
    'o2-mnow',
    'o2-mrole',
    'o2-tvcap',
    'hv-nm',
    'hv-rl',
  ]),
  collectorExtraClasses: Object.freeze([
    'material-symbols-outlined',
    'material-symbols-rounded',
    'material-symbols-sharp',
    'google-symbols',
    'codicon',
  ]),
});

/**
 * 在宿主页面执行：安装或热更新无损 DOM 翻译器，并续期 18 秒看门狗。
 *
 * @param {object} payload `{ locale, depth, revision, exact, patterns }`
 * @param {string} bootId
 * @param {string} [globalKey]
 * @param {object} [skipConfig]
 */
export function applyHostI18nInPage(
  payload,
  bootId,
  globalKey = '__AGUsageMonitorHostI18n',
  skipConfig = HOST_I18N_SKIP_CONFIG
) {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { applied: false, reason: 'no_dom' };
  }
  const root = document.body || document.documentElement;
  if (!root) {
    return { applied: false, reason: 'no_root' };
  }

  const WATCHDOG_MS = 18_000;
  const FRAME_NODE_BUDGET = 450;
  const INITIAL_SCAN_BUDGET = 4000;
  const MAX_PENDING_NODES = 4096;
  const MAX_MISS_CACHE = 1024;
  const MAX_EXACT_LEN = 1000;
  const MAX_PATTERN_LEN = 360;
  const TRANSLATABLE_ATTRS = [
    'placeholder',
    'title',
    'aria-label',
    'aria-description',
    'aria-placeholder',
  ];
  const cfg = skipConfig && typeof skipConfig === 'object' ? skipConfig : {};
  const SKIP_TAGS = new Set(Array.isArray(cfg.tags) ? cfg.tags : []);
  const SKIP_ATTRS = Array.isArray(cfg.attrs) ? cfg.attrs : [];
  const SKIP_TESTIDS = new Set(Array.isArray(cfg.testIds) ? cfg.testIds : []);
  const SKIP_CLASSES = new Set(Array.isArray(cfg.classes) ? cfg.classes : []);
  const CONVERSATION_HREF_RE = /^\/c\/[0-9a-f-]{8,}(?:[/?#]|$)/i;
  const SINGLE_LOWER_WORD_RE = /^[a-z][a-z'-]*$/;

  function isSkippedSelf(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.isContentEditable === true) return true;
    const id = el.id;
    if (id === 'ag-usage-monitor-capsule' || id === 'ag-usage-monitor-portal') return true;
    if (typeof el.hasAttribute === 'function') {
      for (let i = 0; i < SKIP_ATTRS.length; i += 1) {
        if (el.hasAttribute(SKIP_ATTRS[i])) return true;
      }
    }
    if (typeof el.getAttribute === 'function') {
      if (el.getAttribute('contenteditable') === 'true') return true;
      const tid = el.getAttribute('data-testid');
      if (tid && SKIP_TESTIDS.has(tid)) return true;
      if (el.tagName === 'A' && CONVERSATION_HREF_RE.test(el.getAttribute('href') || '')) {
        return true;
      }
    }
    const cls = el.className;
    if (typeof cls === 'string' && cls) {
      if (cls.indexOf(' ') === -1) {
        if (SKIP_CLASSES.has(cls)) return true;
      } else {
        const parts = cls.split(/\s+/);
        for (let i = 0; i < parts.length; i += 1) {
          if (SKIP_CLASSES.has(parts[i])) return true;
        }
      }
    }
    return false;
  }

  function isSkippedElement(el) {
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (isSkippedSelf(cur)) return true;
      cur = cur.parentElement || (cur.parentNode && cur.parentNode.nodeType === 1 ? cur.parentNode : null);
    }
    return false;
  }

  function hasAsciiLetter(str) {
    for (let i = 0; i < str.length; i += 1) {
      const code = str.charCodeAt(i);
      if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return true;
    }
    return false;
  }

  function isAsciiLetterCode(code) {
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  }

  function extractFirstWordLower(str) {
    const m = str.match(/^[A-Za-z][A-Za-z0-9'-]*/);
    return m ? m[0].toLowerCase() : '';
  }

  function extractLastWordLower(str) {
    const m = str.match(/([A-Za-z]{2,})[.)?!'"\u201d\u2019…]*$/);
    return m ? m[1].toLowerCase() : '';
  }

  function extractPatternLeadingWordLower(source) {
    // 匹配以 `^Word` 开头的锚定模板（忽略反转义前的普通字母首词）
    const m = String(source || '').match(/^\^([A-Za-z]{2,})/);
    return m ? m[1].toLowerCase() : '';
  }

  function isNumericStartPattern(source) {
    return /^\^(?:\\d|\(\\d|\\\(|\\\+|, \\\+)/.test(String(source || ''));
  }

  function extractPatternTrailingWordsLower(source) {
    const s = String(source || '');
    // 跳过结尾是通配捕获或字符集的模板，仅索引以固定英文词结尾的模板（兼容可选复数 s?）
    const plural = s.match(/([A-Za-z]{2,})s\?(?:\\\)|\\\.|\?|!|"|'|…)*\$$/);
    if (plural) {
      const base = plural[1].toLowerCase();
      return [base, `${base}s`];
    }
    const exact = s.match(/(?:^|[\s(\\/-])([A-Za-z]{2,})(?:\\\)|\\\.|\?|!|"|'|…)*\$$/);
    if (exact) {
      return [exact[1].toLowerCase()];
    }
    return [];
  }

  function computePatternSpecificity(source) {
    const s = String(source || '');
    let literalChars = 0;
    let parenDepth = 0;
    let inCharClass = false;
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      if (ch === '\\' && i + 1 < s.length) {
        const next = s[i + 1];
        if (parenDepth === 0 && !inCharClass && !/[dDwWsSbB]/.test(next)) {
          literalChars += 1;
        }
        i += 1;
        continue;
      }
      if (ch === '[' && !inCharClass) {
        inCharClass = true;
        continue;
      }
      if (ch === ']' && inCharClass) {
        inCharClass = false;
        continue;
      }
      if (inCharClass) continue;
      if (ch === '(') {
        parenDepth += 1;
        continue;
      }
      if (ch === ')') {
        if (parenDepth > 0) parenDepth -= 1;
        continue;
      }
      if (parenDepth === 0 && !'^$.*+?{}|'.includes(ch)) {
        literalChars += 1;
      }
    }
    const looseWildcards = (s.match(/\(\.\+\?\)|\(\.\*\?\)/g) || []).length;
    const typedCaptures = (s.match(/\\d\+/g) || []).length;
    return literalChars * 4 + typedCaptures * 3 - looseWildcards * 6;
  }

  function compileMatchers(rawPayload) {
    const exactMap = new Map();
    const exactLowerMap = new Map();
    const rawExact = rawPayload?.exact;
    if (rawExact && typeof rawExact === 'object') {
      for (const [k, v] of Object.entries(rawExact)) {
        if (typeof v !== 'string' || !v) continue;
        exactMap.set(k, v);
        if (k.length <= 80) {
          const lowerK = k.toLowerCase();
          if (!exactLowerMap.has(lowerK)) {
            exactLowerMap.set(lowerK, v);
          }
        }
      }
    }

    const prefixBuckets = new Map();
    const suffixBuckets = new Map();
    const numericFallbacks = [];
    const fallbackPatterns = [];
    const rawPatterns = Array.isArray(rawPayload?.patterns) ? rawPayload.patterns : [];
    for (let i = 0; i < rawPatterns.length; i += 1) {
      const item = rawPatterns[i];
      if (!item || typeof item.source !== 'string' || typeof item.replace !== 'string') continue;
      try {
        const compiled = {
          re: new RegExp(item.source, typeof item.flags === 'string' ? item.flags : ''),
          replace: item.replace,
          hintLower: typeof item.hint === 'string' ? item.hint.toLowerCase() : '',
          specificity: computePatternSpecificity(item.source),
          sourceLen: item.source.length,
          order: i,
        };
        const leadWord = extractPatternLeadingWordLower(item.source);
        if (leadWord) {
          let bucket = prefixBuckets.get(leadWord);
          if (!bucket) {
            bucket = [];
            prefixBuckets.set(leadWord, bucket);
          }
          bucket.push(compiled);
        } else if (isNumericStartPattern(item.source)) {
          numericFallbacks.push(compiled);
        } else {
          const tailWords = extractPatternTrailingWordsLower(item.source);
          if (tailWords.length > 0) {
            for (let t = 0; t < tailWords.length; t += 1) {
              const tw = tailWords[t];
              let sBucket = suffixBuckets.get(tw);
              if (!sBucket) {
                sBucket = [];
                suffixBuckets.set(tw, sBucket);
              }
              sBucket.push(compiled);
            }
          } else {
            fallbackPatterns.push(compiled);
          }
        }
      } catch {
        // 忽略单条非法正则
      }
    }
    const sortBySpecificity = (a, b) =>
      b.specificity - a.specificity || b.sourceLen - a.sourceLen || a.order - b.order;
    for (const bucket of prefixBuckets.values()) {
      if (bucket.length > 1) bucket.sort(sortBySpecificity);
    }
    for (const bucket of suffixBuckets.values()) {
      if (bucket.length > 1) bucket.sort(sortBySpecificity);
    }
    if (numericFallbacks.length > 1) numericFallbacks.sort(sortBySpecificity);
    if (fallbackPatterns.length > 1) fallbackPatterns.sort(sortBySpecificity);
    return {
      exactMap,
      exactLowerMap,
      prefixBuckets,
      suffixBuckets,
      numericFallbacks,
      fallbackPatterns,
      missCache: new Set(),
    };
  }

  function runPatternList(trimmed, lowerRef, list) {
    if (!list || list.length === 0) return undefined;
    for (let i = 0; i < list.length; i += 1) {
      const pat = list[i];
      if (pat.hintLower) {
        if (lowerRef.value === null) lowerRef.value = trimmed.toLowerCase();
        if (!lowerRef.value.includes(pat.hintLower)) continue;
      }
      if (pat.re.test(trimmed)) {
        const next = trimmed.replace(pat.re, pat.replace);
        if (next && next !== trimmed) return next;
      }
    }
    return undefined;
  }

  function translateTextWithMatchers(rawText, matchers) {
    if (typeof rawText !== 'string' || !rawText || rawText.length > MAX_EXACT_LEN) return null;
    const normalizedRaw = rawText.includes('\r') ? rawText.replace(/\r\n/g, '\n') : rawText;
    const trimmed = normalizedRaw.trim();
    if (!trimmed || trimmed.length > MAX_EXACT_LEN) return null;
    if (trimmed.length <= 160 && matchers.missCache.has(trimmed)) return null;

    let translatedCore = matchers.exactMap.get(trimmed);
    const hasLetter = translatedCore === undefined ? hasAsciiLetter(trimmed) : false;
    let lowerRef = { value: null };

    if (
      translatedCore === undefined &&
      trimmed.length <= 80 &&
      hasLetter &&
      !SINGLE_LOWER_WORD_RE.test(trimmed)
    ) {
      lowerRef.value = trimmed.toLowerCase();
      translatedCore = matchers.exactLowerMap.get(lowerRef.value);
    }
    if (
      translatedCore === undefined &&
      trimmed.length <= MAX_PATTERN_LEN &&
      !trimmed.includes('\n') &&
      hasLetter
    ) {
      const firstCode = trimmed.charCodeAt(0);
      if (isAsciiLetterCode(firstCode)) {
        const leadWord = extractFirstWordLower(trimmed);
        if (leadWord) {
          translatedCore = runPatternList(trimmed, lowerRef, matchers.prefixBuckets.get(leadWord));
        }
      } else if (matchers.numericFallbacks.length > 0) {
        translatedCore = runPatternList(trimmed, lowerRef, matchers.numericFallbacks);
      }
      if (translatedCore === undefined) {
        const tailWord = extractLastWordLower(trimmed);
        if (tailWord) {
          translatedCore = runPatternList(trimmed, lowerRef, matchers.suffixBuckets.get(tailWord));
        }
      }
      if (translatedCore === undefined && matchers.fallbackPatterns.length > 0) {
        translatedCore = runPatternList(trimmed, lowerRef, matchers.fallbackPatterns);
      }
    }
    if (translatedCore === undefined || translatedCore === trimmed) {
      if (trimmed.length <= 160) {
        if (matchers.missCache.size >= MAX_MISS_CACHE) {
          matchers.missCache.clear();
        }
        matchers.missCache.add(trimmed);
      }
      return null;
    }

    const startIdx = normalizedRaw.indexOf(trimmed);
    const leading = startIdx > 0 ? normalizedRaw.slice(0, startIdx) : '';
    const trailing =
      startIdx + trimmed.length < normalizedRaw.length
        ? normalizedRaw.slice(startIdx + trimmed.length)
        : '';
    return leading + translatedCore + trailing;
  }

  let state = window[globalKey];

  function restoreSubtree(scanRoot, targetState) {
    if (!scanRoot) return;
    if (typeof document.createTreeWalker === 'function') {
      const textWalker = document.createTreeWalker(scanRoot, 4);
      let node = textWalker.nextNode();
      while (node) {
        const rec = targetState.textRecords.get(node);
        if (rec) {
          if (node.nodeValue === rec.translated) {
            node.nodeValue = rec.orig;
          }
          targetState.textRecords.delete(node);
        }
        node = textWalker.nextNode();
      }

      const elWalker = document.createTreeWalker(scanRoot, 1);
      let el = elWalker.nextNode();
      while (el) {
        const attrMap = targetState.attrRecords.get(el);
        if (attrMap) {
          for (const [attrName, rec] of attrMap.entries()) {
            if (el.getAttribute(attrName) === rec.translated) {
              el.setAttribute(attrName, rec.orig);
            }
          }
          targetState.attrRecords.delete(el);
        }
        if (el.shadowRoot && el.id !== 'ag-usage-monitor-capsule' && el.id !== 'ag-usage-monitor-portal') {
          restoreSubtree(el.shadowRoot, targetState);
        }
        el = elWalker.nextNode();
      }
    } else {
      const walkFallback = (cur) => {
        if (!cur) return;
        if (cur.nodeType === 3) {
          const rec = targetState.textRecords.get(cur);
          if (rec) {
            if (cur.nodeValue === rec.translated) cur.nodeValue = rec.orig;
            targetState.textRecords.delete(cur);
          }
          return;
        }
        if (cur.nodeType === 1 || cur.nodeType === 11) {
          if (cur.nodeType === 1) {
            const attrMap = targetState.attrRecords.get(cur);
            if (attrMap) {
              for (const [attrName, rec] of attrMap.entries()) {
                if (cur.getAttribute?.(attrName) === rec.translated) {
                  cur.setAttribute(attrName, rec.orig);
                }
              }
              targetState.attrRecords.delete(cur);
            }
            if (cur.shadowRoot && cur.id !== 'ag-usage-monitor-capsule' && cur.id !== 'ag-usage-monitor-portal') {
              walkFallback(cur.shadowRoot);
            }
          }
          const children = cur.childNodes || [];
          for (let i = 0; i < children.length; i += 1) {
            walkFallback(children[i]);
          }
        }
      };
      walkFallback(scanRoot);
    }
  }

  function restoreAllTracked(targetState) {
    if (!targetState) return;
    targetState.isMutating = true;
    try {
      const scanRoot = document.body || document.documentElement;
      restoreSubtree(scanRoot, targetState);
    } finally {
      targetState.isMutating = false;
    }
  }

  if (state && state.bootId !== bootId) {
    state.dispose?.();
    state = null;
  }

  if (!state) {
    const scheduleFrame =
      typeof window.requestAnimationFrame === 'function'
        ? (cb) => ({ kind: 'raf', id: window.requestAnimationFrame(cb) })
        : (cb) => ({ kind: 'timer', id: setTimeout(cb, 16) });
    const cancelFrame = (handle) => {
      if (!handle) return;
      if (handle.kind === 'raf' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(handle.id);
      } else {
        clearTimeout(handle.id);
      }
    };

    state = {
      bootId,
      revision: '',
      locale: '',
      depth: '',
      matchers: {
        exactMap: new Map(),
        exactLowerMap: new Map(),
        prefixBuckets: new Map(),
        suffixBuckets: new Map(),
        numericFallbacks: [],
        fallbackPatterns: [],
        missCache: new Set(),
      },
      textRecords: new WeakMap(),
      attrRecords: new WeakMap(),
      pendingNodes: new Set(),
      fullRescanPending: false,
      frameHandle: null,
      watchdogTimer: null,
      observer: null,
      isMutating: false,
      translatedCount: 0,
      applyTextNode(node, parentVerifiedSafe = false) {
        if (!node || node.nodeType !== 3) return;
        if (!parentVerifiedSafe) {
          const parent = node.parentElement || node.parentNode;
          if (parent && isSkippedElement(parent)) return;
        }
        const curVal = node.nodeValue;
        if (typeof curVal !== 'string' || !curVal) return;

        const existing = state.textRecords.get(node);
        let origVal = curVal;
        if (existing) {
          if (curVal === existing.translated) {
            return;
          }
          origVal = curVal;
          state.textRecords.delete(node);
        }

        const nextVal = translateTextWithMatchers(origVal, state.matchers);
        if (nextVal !== null && nextVal !== origVal) {
          state.textRecords.set(node, { orig: origVal, translated: nextVal });
          state.isMutating = true;
          try {
            node.nodeValue = nextVal;
            state.translatedCount += 1;
          } finally {
            state.isMutating = false;
          }
        }
      },
      applyTextNodeRun(run, parentVerifiedSafe = false) {
        if (!Array.isArray(run) || run.length < 2) return;
        if (!parentVerifiedSafe) {
          const parent = run[0]?.parentElement || run[0]?.parentNode;
          if (parent && isSkippedElement(parent)) return;
        }
        const firstRec = state.textRecords.get(run[0]);
        if (
          firstRec?.runGroup &&
          firstRec.runGroup.nodes.length === run.length &&
          firstRec.runGroup.nodes.every((n, idx) => n === run[idx]) &&
          run.every((n) => {
            const r = state.textRecords.get(n);
            return r && n.nodeValue === r.translated;
          })
        ) {
          return;
        }
        const origs = [];
        for (let k = 0; k < run.length; k += 1) {
          const n = run[k];
          const curVal = typeof n?.nodeValue === 'string' ? n.nodeValue : '';
          const rec = state.textRecords.get(n);
          if (rec && curVal === rec.translated) {
            origs.push(rec.orig);
          } else {
            origs.push(curVal);
          }
        }
        const combinedOrig = origs.join('');
        const combinedTranslated = translateTextWithMatchers(combinedOrig, state.matchers);
        if (combinedTranslated !== null && combinedTranslated !== combinedOrig) {
          const runGroup = { nodes: run.slice() };
          state.isMutating = true;
          try {
            for (let k = 0; k < run.length; k += 1) {
              const nextVal = k === 0 ? combinedTranslated : '';
              state.textRecords.set(run[k], {
                orig: origs[k],
                translated: nextVal,
                runGroup,
              });
              if (run[k].nodeValue !== nextVal) {
                run[k].nodeValue = nextVal;
              }
            }
            state.translatedCount += 1;
          } finally {
            state.isMutating = false;
          }
          return;
        }
        state.isMutating = true;
        try {
          for (let k = 0; k < run.length; k += 1) {
            const rec = state.textRecords.get(run[k]);
            if (rec?.runGroup) {
              if (run[k].nodeValue === rec.translated) {
                run[k].nodeValue = rec.orig;
              }
              state.textRecords.delete(run[k]);
            }
          }
        } finally {
          state.isMutating = false;
        }
        for (let k = 0; k < run.length; k += 1) {
          state.applyTextNode(run[k], true);
        }
      },
      applyElementAttrs(el, selfVerifiedSafe = false) {
        if (!el || el.nodeType !== 1) return;
        if (!selfVerifiedSafe && isSkippedElement(el)) return;
        if (typeof el.getAttribute !== 'function' || typeof el.setAttribute !== 'function') return;
        for (let i = 0; i < TRANSLATABLE_ATTRS.length; i += 1) {
          const attrName = TRANSLATABLE_ATTRS[i];
          const curVal = el.getAttribute(attrName);
          if (!curVal) continue;
          let attrMap = state.attrRecords.get(el);
          const existing = attrMap?.get(attrName);
          let origVal = curVal;
          if (existing) {
            if (curVal === existing.translated) continue;
            origVal = curVal;
            attrMap.delete(attrName);
          }
          const nextVal = translateTextWithMatchers(origVal, state.matchers);
          if (nextVal !== null && nextVal !== origVal) {
            if (!attrMap) {
              attrMap = new Map();
              state.attrRecords.set(el, attrMap);
            }
            attrMap.set(attrName, { orig: origVal, translated: nextVal });
            state.isMutating = true;
            try {
              el.setAttribute(attrName, nextVal);
              state.translatedCount += 1;
            } finally {
              state.isMutating = false;
            }
          }
        }
      },
      walkSubtree(node, budgetRef, ancestorsVerifiedSafe = false) {
        if (!node || budgetRef.remaining <= 0) return false;
        if (node.nodeType === 3) {
          budgetRef.remaining -= 1;
          state.applyTextNode(node, ancestorsVerifiedSafe);
          return true;
        }
        if (node.nodeType !== 1 && node.nodeType !== 11) return true;
        if (node.nodeType === 1) {
          if (ancestorsVerifiedSafe ? isSkippedSelf(node) : isSkippedElement(node)) return true;
          budgetRef.remaining -= 1;
          state.applyElementAttrs(node, true);
          if (node.shadowRoot && node.id !== 'ag-usage-monitor-capsule' && node.id !== 'ag-usage-monitor-portal') {
            state.walkSubtree(node.shadowRoot, budgetRef, true);
          }
        }
        const children = node.childNodes || [];
        for (let i = 0; i < children.length; i += 1) {
          if (budgetRef.remaining <= 0) {
            state.pendingNodes.add(children[i]);
            return false;
          }
          if (children[i]?.nodeType === 3) {
            let j = i + 1;
            while (j < children.length && children[j]?.nodeType === 3) {
              j += 1;
            }
            if (j - i >= 2) {
              const run = [];
              for (let k = i; k < j; k += 1) run.push(children[k]);
              budgetRef.remaining -= run.length;
              state.applyTextNodeRun(run, true);
              i = j - 1;
              continue;
            }
          }
          if (!state.walkSubtree(children[i], budgetRef, true)) {
            for (let j = i + 1; j < children.length; j += 1) {
              state.pendingNodes.add(children[j]);
            }
            return false;
          }
        }
        return true;
      },
      flushPending() {
        state.frameHandle = null;
        if (state.fullRescanPending) {
          state.fullRescanPending = false;
          state.pendingNodes.clear();
          const scanRoot = document.body || document.documentElement;
          if (scanRoot) state.pendingNodes.add(scanRoot);
        }
        const budgetRef = { remaining: FRAME_NODE_BUDGET };
        const batch = Array.from(state.pendingNodes);
        state.pendingNodes.clear();
        for (let i = 0; i < batch.length; i += 1) {
          if (budgetRef.remaining <= 0) {
            for (let j = i; j < batch.length; j += 1) {
              state.pendingNodes.add(batch[j]);
            }
            break;
          }
          state.walkSubtree(batch[i], budgetRef, false);
        }
        if (state.pendingNodes.size > 0 || state.fullRescanPending) {
          state.scheduleFlush();
        }
      },
      scheduleFlush() {
        if (state.frameHandle) return;
        state.frameHandle = scheduleFrame(() => state.flushPending());
      },
      enqueue(node) {
        if (!node) return;
        if (state.pendingNodes.size >= MAX_PENDING_NODES) {
          state.fullRescanPending = true;
          state.pendingNodes.clear();
        } else {
          state.pendingNodes.add(node);
        }
        state.scheduleFlush();
      },
      scanAllNow() {
        const scanRoot = document.body || document.documentElement;
        if (!scanRoot) return;
        const budgetRef = { remaining: INITIAL_SCAN_BUDGET };
        state.walkSubtree(scanRoot, budgetRef, true);
        if (state.pendingNodes.size > 0) {
          state.scheduleFlush();
        }
      },
      touchWatchdog() {
        clearTimeout(state.watchdogTimer);
        state.watchdogTimer = setTimeout(() => {
          state.dispose();
        }, WATCHDOG_MS);
      },
      dispose() {
        clearTimeout(state.watchdogTimer);
        state.watchdogTimer = null;
        cancelFrame(state.frameHandle);
        state.frameHandle = null;
        try {
          state.observer?.disconnect?.();
        } catch {
          // 忽略断开异常
        }
        state.observer = null;
        state.pendingNodes.clear();
        state.fullRescanPending = false;
        restoreAllTracked(state);
        state.matchers.exactMap.clear();
        state.matchers.exactLowerMap.clear();
        state.matchers.prefixBuckets.clear();
        state.matchers.suffixBuckets.clear();
        state.matchers.numericFallbacks.length = 0;
        state.matchers.fallbackPatterns.length = 0;
        state.matchers.missCache.clear();
        if (window[globalKey] === state) {
          delete window[globalKey];
        }
      },
    };

    if (typeof window.MutationObserver === 'function') {
      state.observer = new window.MutationObserver((mutations) => {
        if (state.isMutating) return;
        for (let i = 0; i < mutations.length; i += 1) {
          const m = mutations[i];
          if (m.type === 'characterData') {
            const rec = state.textRecords.get(m.target);
            const hasAdjacentText =
              m.target?.previousSibling?.nodeType === 3 || m.target?.nextSibling?.nodeType === 3;
            state.enqueue(
              (rec?.runGroup || hasAdjacentText) && m.target?.parentNode
                ? m.target.parentNode
                : m.target
            );
          } else if (m.type === 'attributes') {
            state.enqueue(m.target);
          } else if (m.type === 'childList') {
            const added = m.addedNodes || [];
            let enqueuedParent = false;
            if (
              m.target &&
              (added.some((n) => n?.nodeType === 3) ||
                (m.removedNodes && m.removedNodes.length > 0))
            ) {
              const kids = m.target.childNodes || [];
              for (let c = 0; c < kids.length - 1; c += 1) {
                if (kids[c]?.nodeType === 3 && kids[c + 1]?.nodeType === 3) {
                  state.enqueue(m.target);
                  enqueuedParent = true;
                  break;
                }
              }
            }
            if (!enqueuedParent) {
              for (let j = 0; j < added.length; j += 1) {
                state.enqueue(added[j]);
              }
            }
          }
        }
      });
      state.observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: TRANSLATABLE_ATTRS,
      });
    }

    window[globalKey] = state;
  }

  state.touchWatchdog();

  const nextRevision = String(payload?.revision || '');
  if (state.revision !== nextRevision) {
    if (state.revision) {
      restoreAllTracked(state);
    }
    state.revision = nextRevision;
    state.locale = String(payload?.locale || '');
    state.depth = String(payload?.depth || '');
    state.matchers = compileMatchers(payload);
    state.translatedCount = 0;
    state.scanAllNow();
  }

  return {
    applied: true,
    revision: state.revision,
    locale: state.locale,
    depth: state.depth,
    translatedCount: state.translatedCount,
  };
}

/**
 * 轻量心跳表达式：若当前页面已加载同一 `bootId` 且同 `revision`，直接续期看门狗，无需重传大词表。
 */
export function createHostI18nHeartbeatExpression(bootId, revision) {
  return `(() => {
    try {
      const st = typeof window !== 'undefined' ? window[${JSON.stringify(HOST_I18N_GLOBAL_KEY)}] : null;
      if (!st || st.bootId !== ${JSON.stringify(bootId)} || st.revision !== ${JSON.stringify(revision)}) {
        return { alive: false, needsApply: true };
      }
      st.touchWatchdog?.();
      return { alive: true, needsApply: false, revision: st.revision, translatedCount: Number(st.translatedCount || 0) };
    } catch {
      return { alive: false, needsApply: true };
    }
  })()`;
}

/**
 * 生成完整注入/切换词表表达式。
 */
export function createHostI18nApplyExpression(payload, bootId) {
  return `(${applyHostI18nInPage.toString()})(${JSON.stringify(payload)}, ${JSON.stringify(bootId)}, ${JSON.stringify(HOST_I18N_GLOBAL_KEY)}, ${JSON.stringify(HOST_I18N_SKIP_CONFIG)})`;
}

/**
 * 生成停止翻译并无损还原原文的清理表达式。
 */
export function createHostI18nDisposeExpression() {
  return `(() => {
    try {
      const st = typeof window !== 'undefined' ? window[${JSON.stringify(HOST_I18N_GLOBAL_KEY)}] : null;
      if (!st) return { disposed: false };
      st.dispose?.();
      return { disposed: true };
    } catch {
      return { disposed: false };
    }
  })()`;
}

/**
 * 在宿主页面按需执行：只读采集当前已挂载 UI 中尚未翻译的英文短语
 * （与主翻译引擎对齐 `TreeWalker` + `shadowRoot` 遍历范围，严格排除聊天用户正文、代码块、Diff、编辑器、图标连字与隐私路径）。
 */
export function collectUntranslatedHostUiInPage(
  globalKey = '__AGUsageMonitorHostI18n',
  skipConfig = HOST_I18N_SKIP_CONFIG
) {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { count: 0, items: [] };
  }
  const root = document.body || document.documentElement;
  if (!root) return { count: 0, items: [] };

  const activeState = window[globalKey] || null;
  const TRANSLATABLE_ATTRS = [
    'placeholder',
    'title',
    'aria-label',
    'aria-description',
    'aria-placeholder',
  ];
  const cfg = skipConfig && typeof skipConfig === 'object' ? skipConfig : {};
  const SKIP_TAGS = new Set(Array.isArray(cfg.tags) ? cfg.tags : []);
  const SKIP_ATTRS = Array.isArray(cfg.attrs) ? cfg.attrs : [];
  const SKIP_TESTIDS = new Set(Array.isArray(cfg.testIds) ? cfg.testIds : []);
  const SKIP_CLASSES = new Set([
    ...(Array.isArray(cfg.classes) ? cfg.classes : []),
    ...(Array.isArray(cfg.collectorExtraClasses) ? cfg.collectorExtraClasses : []),
  ]);
  const CONVERSATION_HREF_RE = /^\/c\/[0-9a-f-]{8,}(?:[/?#]|$)/i;
  const SINGLE_LOWER_WORD_RE = /^[a-z][a-z'-]*$/;
  const NON_LATIN_RE = /[\u3000-\u9fff\uac00-\ud7af\u0400-\u04ff\uff00-\uffef]/;
  const NOISE_RE =
    /^(?:https?:\/\/|file:\/\/|\/|~\.|[A-Za-z]:\\|[\w.+-]+@[\w.-]+\.[a-z]{2,}$|[0-9a-f]{8}-[0-9a-f]{4}-|v?\d+(?:\.\d+)+$|\/[a-z0-9_-]+$|(?:gemini|claude|gpt|o[134])\b)/i;
  const FILENAME_RE =
    /^[\w.@+-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|jsonc|md|mdx|css|scss|less|html|htm|xml|svg|png|jpe?g|gif|webp|ico|pdf|txt|log|csv|ya?ml|toml|ini|env|lock|sh|ps1|bat|cmd|py|go|rs|java|kt|c|cpp|h|hpp|cs|rb|php|sql|db|sqlite|zip|tar|gz|exe|dll|wasm|pb)$/i;
  const CODE_IDENT_RE =
    /^(?:[a-z0-9]+(?:_[a-z0-9]+)+|[a-z0-9]+(?:-[a-z0-9]+)+|[a-z]+[A-Z][A-Za-z0-9]*|v(?:[A-Z]|\d+(?:\.\d+)*))$/;
  const BRAND_OR_UNIT_RE =
    /^(?:Antigravity|Google|GitHub|GitLab|Bitbucket|Chrome|Chromium|Electron|React|Tailwind|Node\.js|TypeScript|JavaScript|Python|HTML|CSS|JSON|YAML|TOML|XML|SQL|SVG|PDF|PNG|JPEG|WebP|GIF|UTF-8|HTTP|HTTPS|SSH|TLS|SSL|AI|UI|UX|LLM|OS|ID|PR|CL|CI|CD|DB|IP|CPU|GPU|RAM|DNS|VPN|UTC|GMT|API|SDK|DOM|CDP|RPC|gRPC|REST|MCP|CLI|IDE|CDN|SemVer|URL|URI|UUID|SHA-?256|OAuth|JWT|WSL|macOS|Windows|Linux|KB|MB|GB|TB|ms|px|fps)$/i;

  function isSkippedSelf(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.isContentEditable === true) return true;
    const id = el.id;
    if (id === 'ag-usage-monitor-capsule' || id === 'ag-usage-monitor-portal') return true;
    if (typeof el.hasAttribute === 'function') {
      for (let i = 0; i < SKIP_ATTRS.length; i += 1) {
        if (el.hasAttribute(SKIP_ATTRS[i])) return true;
      }
    }
    if (typeof el.getAttribute === 'function') {
      if (el.getAttribute('contenteditable') === 'true') return true;
      const tid = el.getAttribute('data-testid');
      if (tid && SKIP_TESTIDS.has(tid)) return true;
      if (el.tagName === 'A' && CONVERSATION_HREF_RE.test(el.getAttribute('href') || '')) {
        return true;
      }
    }
    const cls = el.className;
    if (typeof cls === 'string' && cls) {
      if (cls.indexOf(' ') === -1) {
        if (SKIP_CLASSES.has(cls)) return true;
      } else {
        const parts = cls.split(/\s+/);
        for (let i = 0; i < parts.length; i += 1) {
          if (SKIP_CLASSES.has(parts[i])) return true;
        }
      }
    }
    return false;
  }

  function isSkipped(el) {
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (isSkippedSelf(cur)) return true;
      cur =
        cur.parentElement ||
        (cur.parentNode && cur.parentNode.nodeType === 1 ? cur.parentNode : null);
    }
    return false;
  }

  const counts = new Map();
  const kinds = new Map();

  function recordCandidate(raw, kind, parentEl = null) {
    if (typeof raw !== 'string') return;
    const normalized = raw.includes('\r') ? raw.replace(/\r\n/g, '\n') : raw;
    const text = normalized.trim();
    if (text.length < 2 || text.length > 260) return;
    if (text.includes('\n') && text.split('\n').length > 3) return;
    if (!/[A-Za-z]{2,}/.test(text)) return;
    if (NON_LATIN_RE.test(text)) return;
    if (NOISE_RE.test(text)) return;
    if (FILENAME_RE.test(text)) return;
    if (CODE_IDENT_RE.test(text)) return;
    if (BRAND_OR_UNIT_RE.test(text)) return;
    if (/^[0-9.,:%$+\-*/\s()[\]]+$/.test(text)) return;
    if (
      kind === 'text' &&
      parentEl?.getAttribute?.('aria-hidden') === 'true' &&
      /^[a-z][a-z0-9_-]*$/.test(text)
    ) {
      return;
    }
    if (activeState?.matchers?.exactMap?.has(text)) return;
    if (
      text.length <= 80 &&
      !SINGLE_LOWER_WORD_RE.test(text) &&
      activeState?.matchers?.exactLowerMap?.has(text.toLowerCase())
    ) {
      return;
    }
    counts.set(text, (counts.get(text) || 0) + 1);
    if (!kinds.has(text)) kinds.set(text, kind);
  }

  function scanElementAttrs(el) {
    const attrMap = activeState?.attrRecords?.get(el);
    for (let k = 0; k < TRANSLATABLE_ATTRS.length; k += 1) {
      const attrName = TRANSLATABLE_ATTRS[k];
      const val = el.getAttribute?.(attrName);
      if (val && !(attrMap && attrMap.has(attrName))) {
        recordCandidate(val, attrName, el);
      }
    }
  }

  function scanSubtree(scanRoot) {
    if (!scanRoot) return;
    if (typeof document.createTreeWalker === 'function') {
      const textWalker = document.createTreeWalker(scanRoot, 4);
      let node = textWalker.nextNode();
      while (node) {
        if (!activeState?.textRecords?.has(node)) {
          const parentEl =
            node.parentElement ||
            (node.parentNode && node.parentNode.nodeType === 1 ? node.parentNode : null);
          if (!parentEl || !isSkipped(parentEl)) {
            recordCandidate(node.nodeValue, 'text', parentEl);
          }
        }
        node = textWalker.nextNode();
      }

      const elWalker = document.createTreeWalker(scanRoot, 1);
      let el = elWalker.nextNode();
      while (el) {
        if (!isSkipped(el)) {
          scanElementAttrs(el);
          if (
            el.shadowRoot &&
            el.id !== 'ag-usage-monitor-capsule' &&
            el.id !== 'ag-usage-monitor-portal'
          ) {
            scanSubtree(el.shadowRoot);
          }
        }
        el = elWalker.nextNode();
      }
      return;
    }

    const walkFallback = (cur, ancestorSkipped) => {
      if (!cur) return;
      if (cur.nodeType === 3) {
        if (!ancestorSkipped && !activeState?.textRecords?.has(cur)) {
          const parentEl =
            cur.parentElement ||
            (cur.parentNode && cur.parentNode.nodeType === 1 ? cur.parentNode : null);
          recordCandidate(cur.nodeValue, 'text', parentEl);
        }
        return;
      }
      if (cur.nodeType === 1 || cur.nodeType === 11) {
        const skippedHere = ancestorSkipped || (cur.nodeType === 1 && isSkippedSelf(cur));
        if (skippedHere) return;
        if (cur.nodeType === 1) {
          scanElementAttrs(cur);
          if (
            cur.shadowRoot &&
            cur.id !== 'ag-usage-monitor-capsule' &&
            cur.id !== 'ag-usage-monitor-portal'
          ) {
            walkFallback(cur.shadowRoot, false);
          }
        }
        const children = cur.childNodes || [];
        for (let i = 0; i < children.length; i += 1) {
          walkFallback(children[i], false);
        }
      }
    };
    walkFallback(scanRoot, false);
  }

  scanSubtree(root);

  const items = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 500)
    .map(([text, count]) => ({ text, kind: kinds.get(text) || 'text', count }));

  return { count: items.length, items };
}

/**
 * 生成按需采集未命中 UI 词条的只读 CDP 表达式。
 */
export function createHostI18nCollectExpression() {
  return `(${collectUntranslatedHostUiInPage.toString()})(${JSON.stringify(HOST_I18N_GLOBAL_KEY)}, ${JSON.stringify(HOST_I18N_SKIP_CONFIG)})`;
}
