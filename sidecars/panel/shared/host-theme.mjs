/**
 * @fileoverview Pure host theme snapshot normalization, signature, CSS generation,
 * and first-paint HTML injection utilities (`shared/host-theme.mjs`).
 *
 * Strictly L0 pure module: zero Node.js or DOM dependencies so backend workers,
 * `main.mjs`, `window-bridge.mjs`, and frontend `appearance.js` share a single
 * source of truth for allowed host CSS variables and sanitization rules.
 */

export const HOST_THEME_FALLBACK_STYLE_ID = 'ag-host-theme-fallback';

export const HOST_THEME_CSS_VARS = Object.freeze([
  '--background',
  '--card',
  '--foreground',
  '--muted-foreground',
  '--border',
  '--card-border',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--accent',
  '--accent-foreground',
  '--destructive',
  '--error',
  '--ring',
  '--font-sans',
  '--font-mono',
  '--font-family',
  '--editor-font-family',
]);

const HOST_THEME_VAR_SET = new Set(HOST_THEME_CSS_VARS);
const HOST_THEME_COLOR_SIGNAL_VARS = Object.freeze([
  '--background',
  '--card',
  '--foreground',
  '--primary',
  '--border',
]);
const UNSAFE_CSS_VALUE_RE = /[\r\n;{}<>\\]|url\s*\(|expression\s*\(|@import/i;

/**
 * Sanitize a CSS custom property value before injecting into a `<style>` block.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeHostThemeCssValue(raw) {
  if (typeof raw !== 'string') return '';
  const clean = raw.trim();
  if (!clean || clean.length > 220) return '';
  if (UNSAFE_CSS_VALUE_RE.test(clean)) return '';
  return clean;
}

/**
 * Normalize a host theme snapshot from CDP, `/preload.js`, or disk cache.
 *
 * @param {unknown} raw
 * @returns {{ colorScheme: 'dark' | 'light' | '', vars: Record<string, string>, source: 'cdp' | 'preload' | '', updatedAtMs: number } | null}
 */
export function normalizeHostThemeSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rawScheme = String(raw.colorScheme || '').trim().toLowerCase();
  const colorScheme = rawScheme === 'dark' || rawScheme === 'light' ? rawScheme : '';
  const rawSource = String(raw.source || '').trim().toLowerCase();
  const source = rawSource === 'cdp' || rawSource === 'preload' ? rawSource : '';
  const rawUpdated = Number(raw.updatedAtMs);
  const updatedAtMs = Number.isFinite(rawUpdated) && rawUpdated > 0 ? Math.floor(rawUpdated) : 0;

  const vars = {};
  const rawVars = raw.vars && typeof raw.vars === 'object' && !Array.isArray(raw.vars) ? raw.vars : null;
  if (rawVars) {
    for (const [k, v] of Object.entries(rawVars)) {
      if (!HOST_THEME_VAR_SET.has(k)) continue;
      const safeVal = sanitizeHostThemeCssValue(v);
      if (safeVal) vars[k] = safeVal;
    }
  }

  const hasColorVar = HOST_THEME_COLOR_SIGNAL_VARS.some((k) => Boolean(vars[k]));
  if (!hasColorVar && !colorScheme) {
    return null;
  }

  return {
    colorScheme,
    vars,
    source,
    updatedAtMs,
  };
}

/**
 * Produce a deterministic compact signature for change detection (ignoring timestamps/source).
 *
 * @param {unknown} snapshot
 * @returns {string}
 */
export function getHostThemeSignature(snapshot) {
  const norm = normalizeHostThemeSnapshot(snapshot);
  if (!norm) return '';
  const parts = [];
  for (const key of HOST_THEME_CSS_VARS) {
    const val = norm.vars[key];
    if (val) parts.push(`${key}=${val}`);
  }
  return `${norm.colorScheme}|${parts.join(';')}`;
}

/**
 * Build a stylesheet-level `:root` rule for fallback host theme tokens.
 * Inline `:root.style` written by Antigravity `/preload.js` naturally overrides
 * this rule by CSS specificity whenever present.
 *
 * @param {unknown} snapshot
 * @returns {string}
 */
export function buildHostThemeFallbackCss(snapshot) {
  const norm = normalizeHostThemeSnapshot(snapshot);
  if (!norm) return '';
  const decls = [];
  if (norm.colorScheme === 'dark' || norm.colorScheme === 'light') {
    decls.push(`color-scheme:${norm.colorScheme}`);
  }
  let hasVarDecl = false;
  for (const key of HOST_THEME_CSS_VARS) {
    const val = norm.vars[key];
    if (val) {
      decls.push(`${key}:${val}`);
      if (key === '--font-sans') decls.push(`--host-font-sans:${val}`);
      else if (key === '--font-mono') decls.push(`--host-font-mono:${val}`);
      hasVarDecl = true;
    }
  }
  if (!norm.vars['--font-sans'] && norm.vars['--font-family']) {
    decls.push(`--host-font-sans:${norm.vars['--font-family']}`);
  }
  if (!norm.vars['--font-mono'] && norm.vars['--editor-font-family']) {
    decls.push(`--host-font-mono:${norm.vars['--editor-font-family']}`);
  }
  if (!hasVarDecl) return '';
  return `:root{${decls.join(';')}}`;
}

/**
 * Inject the fallback `<style id="ag-host-theme-fallback">` tag into `index.html`
 * before `/styles.css` so restarted sidecar frames paint with exact host colors
 * on frame 1 while allowing inline `/preload.js` or later host `<style>` tags to win.
 *
 * @param {string} html
 * @param {unknown} snapshot
 * @returns {string}
 */
export function injectHostThemeFallbackIntoHtml(html, snapshot) {
  if (typeof html !== 'string' || !html) return html;
  const css = buildHostThemeFallbackCss(snapshot);
  if (!css) return html;
  const styleTag = `  <style id="${HOST_THEME_FALLBACK_STYLE_ID}">${css}</style>\n`;
  if (/<link\s+rel="stylesheet"/i.test(html)) {
    return html.replace(/(?=[ \t]*<link\s+rel="stylesheet")/i, styleTag);
  }
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${styleTag}</head>`);
  }
  return html;
}
