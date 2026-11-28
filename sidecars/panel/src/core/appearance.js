/**
 * @fileoverview Theme accent palette, host theme fallback sync, & panel font-scale appearance engine.
 * Applies CSS custom properties cleanly to Sidebar `:root` and Shadow DOM hosts,
 * while strictly isolating `#ag-usage-monitor-capsule` from font scaling.
 */

import {
  HOST_THEME_CSS_VARS,
  HOST_THEME_FALLBACK_STYLE_ID,
  buildHostThemeFallbackCss,
  normalizeHostThemeSnapshot,
} from '../../shared/host-theme.mjs';

export const THEME_ACCENT_PRESETS = Object.freeze([
  { key: 'host', labelKey: 'settings.gen.accentHost', cssColor: '' },
  { key: 'blue', labelKey: 'settings.gen.accentBlue', cssColor: 'hsl(217 84% 53%)' },
  { key: 'emerald', labelKey: 'settings.gen.accentEmerald', cssColor: 'hsl(152 66% 39%)' },
  { key: 'amber', labelKey: 'settings.gen.accentAmber', cssColor: 'hsl(34 88% 46%)' },
  { key: 'violet', labelKey: 'settings.gen.accentViolet', cssColor: 'hsl(262 76% 58%)' },
  { key: 'cyan', labelKey: 'settings.gen.accentCyan', cssColor: 'hsl(191 82% 41%)' },
  { key: 'rose', labelKey: 'settings.gen.accentRose', cssColor: 'hsl(346 78% 54%)' },
]);

export const FONT_SCALE_FACTORS = Object.freeze({
  sm: 0.92,
  md: 1,
  lg: 1.14,
  xl: 1.28,
});

export const PANEL_SCALE_FACTORS = Object.freeze({
  sm: 1,
  md: 1,
  lg: 1.09,
  xl: 1.18,
});

export function normalizeClientThemeAccent(raw) {
  const val = String(raw ?? '').trim().toLowerCase();
  return THEME_ACCENT_PRESETS.some((p) => p.key === val) ? val : 'host';
}

export function normalizeClientFontScale(raw) {
  const val = String(raw ?? '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(FONT_SCALE_FACTORS, val) ? val : 'md';
}

export function normalizeClientModernUi(raw) {
  if (raw === undefined || raw === null || raw === '') return true;
  if (typeof raw === 'string') {
    const lower = raw.trim().toLowerCase();
    if (lower === 'false' || lower === '0' || lower === 'off') return false;
    if (lower === 'true' || lower === '1' || lower === 'on') return true;
    return true;
  }
  return Boolean(raw);
}

export function resolveSettingsModernUi(settings) {
  if (!settings || typeof settings !== 'object') return true;
  if (settings.modernUi !== undefined) {
    return normalizeClientModernUi(settings.modernUi);
  }
  if (settings.experimentalModernUi !== undefined) {
    return normalizeClientModernUi(settings.experimentalModernUi);
  }
  return true;
}

/**
 * Check whether `el` (or its Shadow DOM host / document root) is currently under `[data-modern-ui="true"]`.
 *
 * @param {Node | null | undefined} el
 * @returns {boolean}
 */
export function isModernUiActiveForElement(el) {
  let cur = el || null;
  while (cur) {
    if (typeof cur.getAttribute === 'function' && cur.getAttribute('data-modern-ui') === 'true') {
      return true;
    }
    if (cur.parentNode) {
      cur = cur.parentNode;
    } else if (cur.host) {
      cur = cur.host;
    } else {
      break;
    }
  }
  if (typeof document !== 'undefined' && document.documentElement) {
    return document.documentElement.getAttribute?.('data-modern-ui') === 'true';
  }
  return false;
}

const LIGHT_THEME_CLASSES = new Set([
  'light',
  'vs-light',
  'vscode-light',
  'hc-light',
  'vscode-high-contrast-light',
]);

const DARK_THEME_CLASSES = new Set([
  'dark',
  'vs-dark',
  'vscode-dark',
  'hc-black',
  'vscode-high-contrast',
]);

const NATIVE_HOST_INLINE_SIGNAL_VARS = Object.freeze([
  '--background',
  '--card',
  '--foreground',
  '--vscode-sideBar-background',
  '--vscode-editor-background',
]);

function hslToRgb(hDeg, sPct, lPct) {
  const h = (((hDeg % 360) + 360) % 360) / 360;
  const s = Math.max(0, Math.min(1, sPct / 100));
  const l = Math.max(0, Math.min(1, lPct / 100));
  if (s === 0) {
    const v = l * 255;
    return [v, v, v];
  }
  const hue2rgb = (p, q, t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    hue2rgb(p, q, h + 1 / 3) * 255,
    hue2rgb(p, q, h) * 255,
    hue2rgb(p, q, h - 1 / 3) * 255,
  ];
}

function linearToGammaSrgb(c) {
  const clamped = Math.max(0, Math.min(1, c));
  return clamped <= 0.0031308
    ? 12.92 * clamped
    : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

function oklabToSrgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  const rLin = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return [
    linearToGammaSrgb(rLin) * 255,
    linearToGammaSrgb(gLin) * 255,
    linearToGammaSrgb(bLin) * 255,
  ];
}

function parseAlphaToken(rawAlpha) {
  if (rawAlpha == null || rawAlpha === '') return 1;
  const str = String(rawAlpha).trim();
  if (!str) return 1;
  if (str.endsWith('%')) {
    const pct = parseFloat(str);
    return Number.isFinite(pct) ? pct / 100 : 1;
  }
  const num = parseFloat(str);
  return Number.isFinite(num) ? num : 1;
}

function parseCssAngleDeg(rawAngle) {
  const str = String(rawAngle ?? '').trim().toLowerCase();
  if (!str) return NaN;
  const num = parseFloat(str);
  if (!Number.isFinite(num)) return NaN;
  if (str.endsWith('rad')) return (num * 180) / Math.PI;
  if (str.endsWith('turn')) return num * 360;
  if (str.endsWith('grad')) return num * 0.9;
  return num;
}

/**
 * Parse `#hex`, `rgb()/rgba()`, `hsl()/hsla()`, `color(srgb|srgb-linear|display-p3 ...)`,
 * `oklab()`, `oklch()`, or bare Tailwind HSL triplets (`222 18% 10%`) into perceptual luminance `[0, 1]`.
 * Returns `null` when transparent (`alpha <= 0.15`) or unparseable.
 *
 * @param {string | null | undefined} rawColor
 * @returns {number | null}
 */
export function parseCssColorLuminance(rawColor) {
  const str = String(rawColor ?? '').trim().toLowerCase();
  if (!str || str === 'transparent' || str === 'none' || str === 'inherit' || str === 'initial') {
    return null;
  }

  if (str.startsWith('#')) {
    const hex = str.slice(1);
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 1;
    if (hex.length === 3 || hex.length === 4) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
      if (hex.length === 4) a = parseInt(hex[3] + hex[3], 16) / 255;
    } else if (hex.length === 6 || hex.length === 8) {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
      if (hex.length === 8) a = parseInt(hex.slice(6, 8), 16) / 255;
    } else {
      return null;
    }
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || a <= 0.15) {
      return null;
    }
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  const rgbMatch = str.match(/^rgba?\(([^)]+)\)$/);
  if (rgbMatch) {
    const body = rgbMatch[1].trim();
    const [channelsPart, slashAlpha] = body.split('/');
    const parts = channelsPart
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean);
    if (parts.length < 3) return null;
    const parseChan = (tok) =>
      tok.endsWith('%') ? (parseFloat(tok) / 100) * 255 : parseFloat(tok);
    const r = parseChan(parts[0]);
    const g = parseChan(parts[1]);
    const b = parseChan(parts[2]);
    const a = slashAlpha !== undefined ? parseAlphaToken(slashAlpha) : parseAlphaToken(parts[3]);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || a <= 0.15) {
      return null;
    }
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  const hslMatch = str.match(/^hsla?\(([^)]+)\)$/);
  if (hslMatch) {
    const body = hslMatch[1].trim();
    const [channelsPart, slashAlpha] = body.split('/');
    const parts = channelsPart
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean);
    if (parts.length < 3) return null;
    const h = parseCssAngleDeg(parts[0]);
    const s = parseFloat(parts[1]);
    const l = parseFloat(parts[2]);
    const a = slashAlpha !== undefined ? parseAlphaToken(slashAlpha) : parseAlphaToken(parts[3]);
    if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(l) || a <= 0.15) {
      return null;
    }
    const [r, g, b] = hslToRgb(h, s, l);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  const colorFnMatch = str.match(/^color\(([^)]+)\)$/);
  if (colorFnMatch) {
    const body = colorFnMatch[1].trim();
    const [channelsPart, slashAlpha] = body.split('/');
    const parts = channelsPart.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 4) return null;
    const space = parts[0];
    if (space !== 'srgb' && space !== 'srgb-linear' && space !== 'display-p3') {
      return null;
    }
    const parseUnit = (tok) =>
      tok.endsWith('%') ? parseFloat(tok) / 100 : parseFloat(tok);
    let r = parseUnit(parts[1]);
    let g = parseUnit(parts[2]);
    let b = parseUnit(parts[3]);
    const a = slashAlpha !== undefined ? parseAlphaToken(slashAlpha) : 1;
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || a <= 0.15) {
      return null;
    }
    if (space === 'srgb-linear') {
      r = linearToGammaSrgb(r);
      g = linearToGammaSrgb(g);
      b = linearToGammaSrgb(b);
    }
    return Math.max(0, Math.min(1, 0.299 * r + 0.587 * g + 0.114 * b));
  }

  const oklchMatch = str.match(/^oklch\(([^)]+)\)$/);
  if (oklchMatch) {
    const body = oklchMatch[1].trim();
    const [channelsPart, slashAlpha] = body.split('/');
    const parts = channelsPart.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 3) return null;
    const L = parts[0].endsWith('%') ? parseFloat(parts[0]) / 100 : parseFloat(parts[0]);
    const C = parts[1].endsWith('%') ? (parseFloat(parts[1]) / 100) * 0.4 : parseFloat(parts[1]);
    const hDeg = parts[2] === 'none' ? 0 : parseCssAngleDeg(parts[2]);
    const a = slashAlpha !== undefined ? parseAlphaToken(slashAlpha) : 1;
    if (!Number.isFinite(L) || !Number.isFinite(C) || !Number.isFinite(hDeg) || a <= 0.15) {
      return null;
    }
    const hRad = (hDeg * Math.PI) / 180;
    const [r, g, b] = oklabToSrgb(L, C * Math.cos(hRad), C * Math.sin(hRad));
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  const oklabMatch = str.match(/^oklab\(([^)]+)\)$/);
  if (oklabMatch) {
    const body = oklabMatch[1].trim();
    const [channelsPart, slashAlpha] = body.split('/');
    const parts = channelsPart.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 3) return null;
    const L = parts[0].endsWith('%') ? parseFloat(parts[0]) / 100 : parseFloat(parts[0]);
    const oa = parts[1].endsWith('%') ? (parseFloat(parts[1]) / 100) * 0.4 : parseFloat(parts[1]);
    const ob = parts[2].endsWith('%') ? (parseFloat(parts[2]) / 100) * 0.4 : parseFloat(parts[2]);
    const a = slashAlpha !== undefined ? parseAlphaToken(slashAlpha) : 1;
    if (!Number.isFinite(L) || !Number.isFinite(oa) || !Number.isFinite(ob) || a <= 0.15) {
      return null;
    }
    const [r, g, b] = oklabToSrgb(L, oa, ob);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  const bareHslMatch = str.match(
    /^(-?\d+(?:\.\d+)?(?:deg|rad|turn|grad)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%(?:\s*\/\s*([0-9.]+%?))?$/
  );
  if (bareHslMatch) {
    const h = parseCssAngleDeg(bareHslMatch[1]);
    const s = parseFloat(bareHslMatch[2]);
    const l = parseFloat(bareHslMatch[3]);
    const a = parseAlphaToken(bareHslMatch[4]);
    if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(l) || a <= 0.15) {
      return null;
    }
    const [r, g, b] = hslToRgb(h, s, l);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  return null;
}

function readInlineStyleVar(el, prop) {
  if (!el?.style) return '';
  const val =
    typeof el.style.getPropertyValue === 'function'
      ? el.style.getPropertyValue(prop)
      : el.style[prop];
  return val ? String(val).trim() : '';
}

function readStyleProp(el, cs, prop) {
  if (prop.startsWith('--')) {
    const inlineVal = readInlineStyleVar(el, prop);
    if (inlineVal) return inlineVal;
    const compVal = cs?.getPropertyValue?.(prop);
    return compVal ? String(compVal).trim() : '';
  }
  const inlineVal = el?.style?.[prop];
  if (inlineVal && String(inlineVal).trim()) return String(inlineVal).trim();
  const compVal = cs?.[prop];
  return compVal ? String(compVal).trim() : '';
}

function resolveColorLuminanceWithProbe(rawColor, doc, win) {
  const direct = parseCssColorLuminance(rawColor);
  if (direct !== null) return direct;
  const clean = String(rawColor ?? '').trim();
  if (
    !clean ||
    /^(?:transparent|none|inherit|initial|unset|revert)$/i.test(clean) ||
    !doc?.documentElement ||
    typeof doc.createElement !== 'function' ||
    typeof doc.documentElement.appendChild !== 'function' ||
    typeof win?.getComputedStyle !== 'function'
  ) {
    return null;
  }
  let probe = null;
  try {
    probe = doc.createElement('span');
    if (!probe?.style) return null;
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.pointerEvents = 'none';
    probe.style.color = clean;
    doc.documentElement.appendChild(probe);
    const computed = String(win.getComputedStyle(probe)?.color || '').trim();
    return computed && computed !== clean ? parseCssColorLuminance(computed) : null;
  } catch {
    return null;
  } finally {
    try {
      probe?.remove?.();
    } catch {
      // ignore probe cleanup errors
    }
  }
}

function hasExplicitThemeMarker(el) {
  if (!el) return false;
  const vk = String(el.getAttribute?.('data-vscode-theme-kind') || '').trim();
  if (vk) return true;
  const dt = String(el.getAttribute?.('data-theme') || el.getAttribute?.('data-color-mode') || '').trim().toLowerCase();
  if (dt === 'light' || dt === 'dark' || dt.endsWith('-light') || dt.endsWith('-dark')) return true;
  const rawCls = typeof el.className === 'string' ? el.className : '';
  if (rawCls) {
    const tokens = rawCls.trim().toLowerCase().split(/\s+/);
    for (const tok of tokens) {
      if (LIGHT_THEME_CLASSES.has(tok) || DARK_THEME_CLASSES.has(tok)) return true;
    }
  }
  return false;
}

/**
 * Determine whether the host environment natively injected theme tokens or markers
 * (e.g. Antigravity `/preload.js` writing `--background` onto `:root.style`, a host `<style>` tag,
 * or VS Code `vscode-dark`/`vscode-light` classes) independent of our own fallback `<style>`.
 *
 * @param {Document | null | undefined} [doc]
 * @returns {boolean}
 */
export function hasNativeHostTheme(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return false;
  const root = doc.documentElement;
  const body = doc.body;
  for (const el of [root, body]) {
    if (!el) continue;
    for (const prop of NATIVE_HOST_INLINE_SIGNAL_VARS) {
      if (readInlineStyleVar(el, prop)) return true;
    }
    if (hasExplicitThemeMarker(el)) return true;
  }
  try {
    const headStyles = doc.head?.querySelectorAll?.('style');
    if (headStyles && headStyles.length > 0) {
      for (const stEl of headStyles) {
        if (!stEl || stEl.id === HOST_THEME_FALLBACK_STYLE_ID) continue;
        const cssText = String(stEl.textContent || '');
        if (/--(?:background|vscode-sideBar-background|vscode-editor-background)\s*:/i.test(cssText)) {
          return true;
        }
      }
    }
  } catch {
    // ignore head traversal errors in constrained DOM mocks
  }
  return false;
}

/**
 * Capture a normalized snapshot of native host CSS tokens when `hasNativeHostTheme(doc)` is true,
 * so the backend can persist it for instant zero-flash recovery across plugin restarts.
 *
 * @param {Document | null | undefined} [doc]
 * @param {Window | null | undefined} [win]
 */
export function captureNativeHostThemeSnapshot(
  doc = typeof document !== 'undefined' ? document : null,
  win = typeof window !== 'undefined' ? window : null
) {
  if (!doc || !hasNativeHostTheme(doc)) return null;
  const root = doc.documentElement;
  const body = doc.body;
  let rootCs = null;
  let bodyCs = null;
  try {
    rootCs = root && typeof win?.getComputedStyle === 'function' ? win.getComputedStyle(root) : null;
    bodyCs = body && typeof win?.getComputedStyle === 'function' ? win.getComputedStyle(body) : null;
  } catch {
    rootCs = null;
    bodyCs = null;
  }
  const vars = {};
  for (const key of HOST_THEME_CSS_VARS) {
    const inlineVal = readInlineStyleVar(root, key) || readInlineStyleVar(body, key);
    // Avoid mistaking our own tokens.css fallback --font-sans/--font-mono for host /preload.js typography
    const isPanelOwnTypographyFallbackVar = key === '--font-sans' || key === '--font-mono';
    const val = isPanelOwnTypographyFallbackVar
      ? inlineVal
      : inlineVal ||
        String(rootCs?.getPropertyValue?.(key) || '').trim() ||
        String(bodyCs?.getPropertyValue?.(key) || '').trim();
    if (val) vars[key] = val;
  }
  const colorScheme = detectHostColorScheme(root);
  return normalizeHostThemeSnapshot({
    colorScheme,
    vars,
    source: 'preload',
  });
}

/**
 * Detect whether the active host surface is `'light'` or `'dark'`.
 * Inspects explicit Antigravity / VS Code theme classes & attributes first,
 * then actual computed surface/text luminance (avoiding false positives from our own
 * white `tokens.css` fallback when host tokens are absent), then backend `fallbackHostTheme`,
 * then `prefers-color-scheme`.
 *
 * @param {HTMLElement | null | undefined} [targetEl]
 * @param {{ fallbackHostTheme?: { colorScheme?: string } | null }} [options]
 * @returns {'light' | 'dark'}
 */
export function detectHostColorScheme(targetEl = null, { fallbackHostTheme = null } = {}) {
  const doc = typeof document !== 'undefined' ? document : null;
  const win = typeof window !== 'undefined' ? window : null;
  let workbenchEl = null;
  try {
    workbenchEl =
      typeof doc?.querySelector === 'function' ? doc.querySelector('.monaco-workbench') : null;
  } catch {
    workbenchEl = null;
  }

  const candidates = [];
  for (const el of [doc?.body, doc?.documentElement, workbenchEl, targetEl]) {
    if (el && !candidates.includes(el)) {
      candidates.push(el);
    }
  }

  // 1. Explicit host theme attributes & class tokens (never read our own data-color-scheme)
  for (const el of candidates) {
    const vscodeKind = String(el.getAttribute?.('data-vscode-theme-kind') || '')
      .trim()
      .toLowerCase();
    if (vscodeKind) {
      if (vscodeKind.includes('light')) return 'light';
      if (vscodeKind.includes('dark') || vscodeKind.includes('high-contrast')) return 'dark';
    }
    const dataTheme = String(
      el.getAttribute?.('data-theme') || el.getAttribute?.('data-color-mode') || ''
    )
      .trim()
      .toLowerCase();
    if (dataTheme === 'light' || dataTheme.endsWith('-light')) return 'light';
    if (dataTheme === 'dark' || dataTheme.endsWith('-dark')) return 'dark';

    const rawCls = typeof el.className === 'string' ? el.className : '';
    if (rawCls) {
      const tokens = rawCls.trim().toLowerCase().split(/\s+/);
      for (const tok of tokens) {
        if (LIGHT_THEME_CLASSES.has(tok)) return 'light';
        if (DARK_THEME_CLASSES.has(tok)) return 'dark';
      }
    }
  }

  // 2. Computed / inline host CSS custom properties & surface luminance
  const bgTargets = [];
  for (const el of [targetEl, doc?.body, doc?.documentElement, workbenchEl]) {
    if (el && !bgTargets.includes(el)) {
      bgTargets.push(el);
    }
  }
  const computedByEl = new Map();
  const getCs = (el) => {
    if (!el) return null;
    if (computedByEl.has(el)) return computedByEl.get(el);
    let cs = null;
    try {
      cs = typeof win?.getComputedStyle === 'function' ? win.getComputedStyle(el) : null;
    } catch {
      cs = null;
    }
    computedByEl.set(el, cs);
    return cs;
  };

  const hostBgVars = [
    '--background',
    '--card',
    '--vscode-sideBar-background',
    '--vscode-editor-background',
  ];
  const hostFgVars = ['--foreground', '--vscode-foreground', '--vscode-editor-foreground'];

  let hasAnyHostToken = false;
  for (const el of bgTargets) {
    const cs = getCs(el);
    for (const prop of hostBgVars) {
      const raw = readStyleProp(el, cs, prop);
      if (raw) {
        hasAnyHostToken = true;
        const lum = resolveColorLuminanceWithProbe(raw, doc, win);
        if (lum !== null) {
          return lum > 0.52 ? 'light' : 'dark';
        }
      }
    }
  }

  const rootCs = getCs(doc?.documentElement);
  const hasOwnPanelTokens = Boolean(readStyleProp(doc?.documentElement, rootCs, '--surface-bg'));
  if (!hasAnyHostToken && hasOwnPanelTokens) {
    for (const el of bgTargets) {
      const cs = getCs(el);
      for (const prop of hostFgVars) {
        if (readStyleProp(el, cs, prop)) {
          hasAnyHostToken = true;
          break;
        }
      }
      if (hasAnyHostToken) break;
    }
  }

  const skipOwnDocFallback = hasOwnPanelTokens && !hasAnyHostToken;

  for (const el of bgTargets) {
    if (skipOwnDocFallback && (el === doc?.body || el === doc?.documentElement || el === targetEl)) {
      continue;
    }
    const cs = getCs(el);
    const lum = resolveColorLuminanceWithProbe(readStyleProp(el, cs, 'backgroundColor'), doc, win);
    if (lum !== null) {
      return lum > 0.52 ? 'light' : 'dark';
    }
  }

  // 3. Computed / inline foreground text luminance
  for (const el of bgTargets) {
    const cs = getCs(el);
    for (const prop of hostFgVars) {
      const lum = resolveColorLuminanceWithProbe(readStyleProp(el, cs, prop), doc, win);
      if (lum !== null) {
        return lum < 0.48 ? 'light' : 'dark';
      }
    }
    if (skipOwnDocFallback && (el === doc?.body || el === doc?.documentElement || el === targetEl)) {
      continue;
    }
    const lum = resolveColorLuminanceWithProbe(readStyleProp(el, cs, 'color'), doc, win);
    if (lum !== null) {
      return lum < 0.48 ? 'light' : 'dark';
    }
  }

  // 3b. Backend host theme polarity fallback (CDP / persisted preload cache)
  const fallbackScheme = String(fallbackHostTheme?.colorScheme || '').trim().toLowerCase();
  if (fallbackScheme === 'dark' || fallbackScheme === 'light') {
    return fallbackScheme;
  }

  // 4. OS media query fallback
  try {
    if (win?.matchMedia?.('(prefers-color-scheme: dark)')?.matches) {
      return 'dark';
    }
  } catch {
    // ignore matchMedia errors
  }

  return 'light';
}

function setAttrIfChanged(el, name, value) {
  if (!el || typeof el.setAttribute !== 'function') return;
  if (typeof el.getAttribute === 'function' && el.getAttribute(name) === value) return;
  el.setAttribute(name, value);
}

function removeAttrIfPresent(el, name) {
  if (!el || typeof el.removeAttribute !== 'function') return;
  if (typeof el.hasAttribute === 'function' && !el.hasAttribute(name)) return;
  el.removeAttribute(name);
}

function setOrClearStyleVar(el, propName, value) {
  if (!el || !el.style) return;
  const cur =
    typeof el.style.getPropertyValue === 'function'
      ? el.style.getPropertyValue(propName)
      : el.style[propName] || '';
  if (value) {
    if (cur === value) return;
    if (typeof el.style.setProperty === 'function') {
      el.style.setProperty(propName, value);
    } else {
      el.style[propName] = value;
    }
  } else if (cur) {
    if (typeof el.style.removeProperty === 'function') {
      el.style.removeProperty(propName);
    } else if (typeof el.style.setProperty === 'function') {
      el.style.setProperty(propName, '');
    } else {
      el.style[propName] = '';
    }
  }
}

/**
 * Keep the sidecar document's fallback host theme stylesheet (`#ag-host-theme-fallback`)
 * and `data-host-theme-fallback` attribute in sync:
 * - Native host theme (`/preload.js` inline `:root.style`, host `<style>`, or VS Code classes) always wins and clears fallback;
 * - When native tokens are absent (e.g. after sidecar restart), applies bridged/cached `hostTheme` CSS vars in `<head>`;
 * - When neither native nor bridged tokens exist, applies `data-host-theme-fallback="dark"` on dark OS / dark polarity.
 *
 * @param {unknown} hostTheme
 * @param {{ doc?: Document | null, win?: Window | null, isStandalone?: boolean }} [options]
 * @returns {{ mode: 'standalone' | 'native' | 'bridged' | 'media-fallback', snapshot: ReturnType<typeof normalizeHostThemeSnapshot> }}
 */
export function syncHostThemeFallback(
  hostTheme,
  {
    doc = typeof document !== 'undefined' ? document : null,
    win = typeof window !== 'undefined' ? window : null,
    isStandalone = false,
    telemetryLoaded = true,
  } = {}
) {
  const root = doc?.documentElement || null;
  const existingStyle = doc?.getElementById?.(HOST_THEME_FALLBACK_STYLE_ID) || null;
  const removeFallbackStyle = () => {
    if (existingStyle) {
      existingStyle.remove?.();
    }
  };

  const readSsrBridgedFontVar = (hostVar) => {
    if (!existingStyle || !root || typeof win?.getComputedStyle !== 'function') return '';
    try {
      return String(win.getComputedStyle(root)?.getPropertyValue?.(hostVar) || '').trim();
    } catch {
      return '';
    }
  };
  const ssrFallbackFonts =
    !telemetryLoaded && existingStyle
      ? {
          '--font-sans': readSsrBridgedFontVar('--host-font-sans'),
          '--font-mono': readSsrBridgedFontVar('--host-font-mono'),
        }
      : null;

  const syncBridgedTypography = (normalizedSnap) => {
    const body = doc?.body || null;
    for (const [cssVar, hostVar, fallbackVar] of [
      ['--font-sans', '--host-font-sans', '--font-family'],
      ['--font-mono', '--host-font-mono', '--editor-font-family'],
    ]) {
      const hasNativeInlineFont = Boolean(
        readInlineStyleVar(root, cssVar) || readInlineStyleVar(body, cssVar)
      );
      if (hasNativeInlineFont) {
        setOrClearStyleVar(root, hostVar, '');
        continue;
      }
      const bridgedVal =
        String(normalizedSnap?.vars?.[cssVar] || '').trim() ||
        String(normalizedSnap?.vars?.[fallbackVar] || '').trim() ||
        readInlineStyleVar(root, fallbackVar) ||
        readInlineStyleVar(body, fallbackVar) ||
        String(ssrFallbackFonts?.[cssVar] || '').trim();
      if (bridgedVal) {
        setOrClearStyleVar(root, hostVar, bridgedVal);
      } else if (telemetryLoaded) {
        setOrClearStyleVar(root, hostVar, '');
      }
    }
  };

  if (!doc || !root || isStandalone) {
    removeFallbackStyle();
    removeAttrIfPresent(root, 'data-host-theme-fallback');
    if (root) {
      setOrClearStyleVar(root, '--host-font-sans', '');
      setOrClearStyleVar(root, '--host-font-mono', '');
    }
    return { mode: 'standalone', snapshot: null };
  }

  const normalized = normalizeHostThemeSnapshot(hostTheme);

  if (hasNativeHostTheme(doc)) {
    removeFallbackStyle();
    removeAttrIfPresent(root, 'data-host-theme-fallback');
    syncBridgedTypography(normalized);
    return { mode: 'native', snapshot: captureNativeHostThemeSnapshot(doc, win) };
  }

  const css = buildHostThemeFallbackCss(normalized);
  if (css && doc.head) {
    if (existingStyle) {
      if (existingStyle.textContent !== css) {
        existingStyle.textContent = css;
      }
    } else if (typeof doc.createElement === 'function') {
      const styleEl = doc.createElement('style');
      styleEl.id = HOST_THEME_FALLBACK_STYLE_ID;
      styleEl.textContent = css;
      if (typeof doc.head.insertBefore === 'function' && doc.head.firstChild) {
        doc.head.insertBefore(styleEl, doc.head.firstChild);
      } else {
        doc.head.appendChild?.(styleEl);
      }
    }
    removeAttrIfPresent(root, 'data-host-theme-fallback');
    syncBridgedTypography(normalized);
    return { mode: 'bridged', snapshot: normalized };
  }

  if (!telemetryLoaded && existingStyle && String(existingStyle.textContent || '').trim()) {
    removeAttrIfPresent(root, 'data-host-theme-fallback');
    return { mode: 'bridged', snapshot: null };
  }

  removeFallbackStyle();
  syncBridgedTypography(null);
  const scheme = detectHostColorScheme(root, { fallbackHostTheme: normalized });
  if (scheme === 'dark') {
    setAttrIfChanged(root, 'data-host-theme-fallback', 'dark');
  } else {
    removeAttrIfPresent(root, 'data-host-theme-fallback');
  }
  return { mode: 'media-fallback', snapshot: null };
}

/**
 * Synchronize theme accent, host color scheme polarity, and (optionally) font scale tokens
 * onto a root/host element.
 *
 * @param {HTMLElement | null | undefined} targetEl
 * @param {object | null | undefined} settings
 * @param {{ includeFontScale?: boolean, fallbackHostTheme?: { colorScheme?: string } | null }} [options]
 */
export function applyAppearanceToRoot(
  targetEl,
  settings,
  { includeFontScale = true, fallbackHostTheme = null } = {}
) {
  if (!targetEl || !targetEl.style) return;
  const accentKey = normalizeClientThemeAccent(settings?.themeAccent);
  const preset = THEME_ACCENT_PRESETS.find((p) => p.key === accentKey) || THEME_ACCENT_PRESETS[0];

  if (preset.key !== 'host' && preset.cssColor) {
    setOrClearStyleVar(targetEl, '--user-accent-primary', preset.cssColor);
    setOrClearStyleVar(targetEl, '--user-accent-contrast', '#ffffff');
  } else {
    setOrClearStyleVar(targetEl, '--user-accent-primary', '');
    setOrClearStyleVar(targetEl, '--user-accent-contrast', '');
  }
  setAttrIfChanged(targetEl, 'data-accent', preset.key);

  const colorScheme = detectHostColorScheme(targetEl, { fallbackHostTheme });
  setAttrIfChanged(targetEl, 'data-color-scheme', colorScheme);

  const isModernUi = resolveSettingsModernUi(settings);
  if (isModernUi) {
    setAttrIfChanged(targetEl, 'data-modern-ui', 'true');
  } else {
    removeAttrIfPresent(targetEl, 'data-modern-ui');
  }

  if (includeFontScale) {
    const scaleKey = normalizeClientFontScale(settings?.fontScale);
    const factor = FONT_SCALE_FACTORS[scaleKey] ?? 1;
    const panelFactor = PANEL_SCALE_FACTORS[scaleKey] ?? 1;
    setOrClearStyleVar(targetEl, '--ui-font-scale', factor === 1 ? '' : String(factor));
    setOrClearStyleVar(targetEl, '--ui-panel-scale', panelFactor === 1 ? '' : String(panelFactor));
    setAttrIfChanged(targetEl, 'data-font-scale', scaleKey);
  } else {
    setOrClearStyleVar(targetEl, '--ui-font-scale', '');
    setOrClearStyleVar(targetEl, '--ui-panel-scale', '');
    removeAttrIfPresent(targetEl, 'data-font-scale');
  }
}
