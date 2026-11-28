#!/usr/bin/env node
/**
 * @fileoverview Zero-dependency Antigravity Host I18n coverage auditor & live CDP drift scanner.
 *
 * Compares the latest extracted host UI strings (from Desktop `language_server.exe` JS + embedded
 * feature-flag JSONC and Antigravity IDE `jetskiAgent/main.js`) against a compiled locale pack
 * (`host-i18n/dist/packs/<locale>.json`), optionally also scanning live open Antigravity windows
 * over read-only CDP to catch server-pushed runtime strings (e.g., model tags like `Leaving Soon`).
 *
 * Usage:
 *   node host-i18n/scripts/audit-host-i18n.mjs --locale zh-CN
 *   node host-i18n/scripts/audit-host-i18n.mjs --locale zh-CN --extract --live-cdp --emit-missing tmp/missing.json
 *   node host-i18n/scripts/audit-host-i18n.mjs --locale zh-CN --no-extract --strict
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CATALOG_OUT,
  discoverLocalAntigravitySources,
  runHostStringExtraction,
} from './extract-host-strings.mjs';
import { compileHostI18nRuntimePayload } from '../../sidecars/panel/backend/host-i18n/pack-manager.mjs';
import { createHostI18nCollectExpression } from '../../sidecars/panel/backend/host-i18n/runtime-translator.mjs';
import {
  isSwarmBoardTarget,
  resolveDevToolsPortCandidates,
} from '../../sidecars/panel/backend/window-bridge.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const HOST_I18N_ROOT = resolve(__dirname, '..');
export const DEFAULT_IGNORE_PATH = join(HOST_I18N_ROOT, 'sources', 'ignore.json');

export function loadIgnoreLists(ignorePath = DEFAULT_IGNORE_PATH) {
  if (!existsSync(ignorePath)) {
    return { exact: new Set(), templates: new Set() };
  }
  const raw = JSON.parse(readFileSync(ignorePath, 'utf8'));
  return {
    exact: new Set(Array.isArray(raw?.exact) ? raw.exact : []),
    templates: new Set(Array.isArray(raw?.templates) ? raw.templates : []),
  };
}

const SINGLE_LOWER_WORD_RE = /^[a-z][a-z'-]*$/;

function buildRuntimeMatcher(payload) {
  const exactMap = new Map(Object.entries(payload.exact || {}));
  const exactLowerMap = new Map();
  for (const [k, v] of exactMap.entries()) {
    if (k.length <= 80) {
      const lk = k.toLowerCase();
      if (!exactLowerMap.has(lk)) exactLowerMap.set(lk, v);
    }
  }
  const patterns = [];
  for (const rule of payload.patterns || []) {
    try {
      patterns.push({
        source: rule.source,
        re: new RegExp(rule.source, rule.flags || ''),
        replace: rule.replace,
        hintLower: String(rule.hint || '').toLowerCase(),
      });
    } catch {
      // invalid regex caught separately
    }
  }
  return {
    match(text) {
      const t = String(text || '').trim();
      if (!t) return null;
      if (exactMap.has(t)) return { kind: 'exact', value: exactMap.get(t) };
      if (t.length <= 80 && !SINGLE_LOWER_WORD_RE.test(t)) {
        const lv = exactLowerMap.get(t.toLowerCase());
        if (lv !== undefined) return { kind: 'exact-ci', value: lv };
      }
      if (t.length <= 360 && !t.includes('\n')) {
        const lower = t.toLowerCase();
        for (const p of patterns) {
          if (p.hintLower && !lower.includes(p.hintLower)) continue;
          if (p.re.test(t)) {
            const next = t.replace(p.re, p.replace);
            if (next && next !== t) return { kind: 'pattern', value: next, source: p.source };
          }
        }
      }
      return null;
    },
  };
}

function countCaptureGroups(source) {
  let count = 0;
  let inCharClass = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '[') {
      inCharClass = true;
      continue;
    }
    if (ch === ']') {
      inCharClass = false;
      continue;
    }
    if (inCharClass) continue;
    if (ch === '(' && source[i + 1] !== '?') {
      count += 1;
    }
  }
  return count;
}

/**
 * Pure coverage & integrity audit comparing a catalog against a compiled pack JSON.
 */
export function auditCatalogAgainstPack(catalog, packObj, ignoreLists = { exact: new Set(), templates: new Set() }) {
  const lightPayload = compileHostI18nRuntimePayload(packObj, 'light');
  const deepPayload = compileHostI18nRuntimePayload(packObj, 'deep');
  const lightMatcher = buildRuntimeMatcher(lightPayload);
  const deepMatcher = buildRuntimeMatcher(deepPayload);

  const packPatternSources = new Set([
    ...(packObj?.base?.patterns || []).map((r) => r.source),
    ...(packObj?.modes?.light?.patterns || []).map((r) => r.source),
    ...(packObj?.modes?.deep?.patterns || []).map((r) => r.source),
  ]);

  const missingExact = [];
  const coveredExactByPattern = [];
  let ignoredExactCount = 0;

  for (const str of catalog.exact || []) {
    if (ignoreLists.exact.has(str)) {
      ignoredExactCount += 1;
      continue;
    }
    const deepHit = deepMatcher.match(str);
    const lightHit = lightMatcher.match(str);
    if (!deepHit && !lightHit) {
      missingExact.push(str);
    } else if (deepHit?.kind === 'pattern' && !deepPayload.exact[str]) {
      coveredExactByPattern.push({ text: str, translated: deepHit.value, by: deepHit.source });
    }
  }

  const missingTemplates = [];
  let ignoredTemplateCount = 0;
  for (const tpl of catalog.templates || []) {
    if (ignoreLists.templates.has(tpl.source)) {
      ignoredTemplateCount += 1;
      continue;
    }
    if (!packPatternSources.has(tpl.source)) {
      // Also check if a slightly tightened boundary variant of this template already exists
      // (e.g. `^Continue(.+?)$` tightened to `^Continue(\s+\(.+?\))$`).
      const tightenedVariant = tpl.source.replace(/\(\.\+\?\)\$$/, '(\\s+\\(.+?\\))$');
      if (packPatternSources.has(tightenedVariant)) continue;
      missingTemplates.push(tpl);
    }
  }

  // Audit pattern backreference integrity & redundant light===deep rules
  const brokenPatterns = [];
  const redundantModeExact = [];
  for (const tierName of ['base', 'light', 'deep']) {
    const list =
      tierName === 'base'
        ? packObj?.base?.patterns || []
        : packObj?.modes?.[tierName]?.patterns || [];
    for (const rule of list) {
      const capCount = countCaptureGroups(rule.source);
      const refs = Array.from(String(rule.replace || '').matchAll(/\$(\d+)/g)).map((m) => Number(m[1]));
      const badRef = refs.find((n) => n < 1 || n > capCount);
      if (badRef !== undefined) {
        brokenPatterns.push({ tier: tierName, source: rule.source, replace: rule.replace, badRef, capCount });
      }
    }
  }
  const lightExact = packObj?.modes?.light?.exact || {};
  const deepExact = packObj?.modes?.deep?.exact || {};
  for (const [k, v] of Object.entries(lightExact)) {
    if (Object.prototype.hasOwnProperty.call(deepExact, k) && deepExact[k] === v) {
      redundantModeExact.push(k);
    }
  }

  return {
    locale: packObj.locale,
    version: packObj.version,
    catalogCounts: {
      exact: (catalog.exact || []).length,
      templates: (catalog.templates || []).length,
    },
    packCounts: {
      baseExact: Object.keys(packObj?.base?.exact || {}).length,
      lightExact: Object.keys(lightExact).length,
      deepExact: Object.keys(deepExact).length,
      basePatterns: (packObj?.base?.patterns || []).length,
      lightPatterns: (packObj?.modes?.light?.patterns || []).length,
      deepPatterns: (packObj?.modes?.deep?.patterns || []).length,
    },
    ignoredExactCount,
    ignoredTemplateCount,
    missingExact,
    missingTemplates,
    coveredExactByPatternCount: coveredExactByPattern.length,
    brokenPatterns,
    redundantModeExact,
  };
}

function discoverDevToolsPorts(explicitPorts = []) {
  const candidates = resolveDevToolsPortCandidates({
    platform: process.platform,
    env: process.env,
    homeDir: homedir(),
  });
  const ports = new Set(explicitPorts.filter((p) => Number.isInteger(p) && p > 0 && p < 65536));
  const envPort = Number(process.env.USAGE_MONITOR_CDP_PORT || 0);
  if (Number.isInteger(envPort) && envPort > 0 && envPort < 65536) ports.add(envPort);

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const firstLine = readFileSync(file, 'utf8').split(/\r?\n/)[0]?.trim();
      const port = Number(firstLine);
      if (Number.isInteger(port) && port > 0 && port < 65536) ports.add(port);
    } catch {
      // ignore unreadable port file
    }
  }
  return Array.from(ports);
}

async function evalCdpOnce(wsUrl, expression, timeoutMs = 4000) {
  const WS = globalThis.WebSocket;
  if (typeof WS !== 'function') {
    throw new Error('Global WebSocket unavailable in this Node runtime');
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const ws = new WS(wsUrl);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      rejectPromise(new Error(`CDP evaluate timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (err) rejectPromise(err);
      else resolvePromise(val);
    };

    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: false },
        })
      );
    });
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(String(ev.data || ''));
        if (msg.id === 1) {
          finish(null, msg?.result?.result?.value ?? null);
        }
      } catch (err) {
        finish(err);
      }
    });
    ws.addEventListener('error', () => finish(new Error('CDP WebSocket error')));
  });
}

/**
 * Connects read-only to running Antigravity CDP targets and collects any visible untranslated UI strings.
 */
export async function scanLiveCdpUntranslated({ ignoreLists = { exact: new Set() }, explicitPorts = [] } = {}) {
  const ports = discoverDevToolsPorts(explicitPorts);
  const merged = new Map();
  let scannedTargets = 0;

  for (const port of ports) {
    let targets = [];
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) continue;
      targets = await res.json();
    } catch {
      continue;
    }

    const collectExpr = createHostI18nCollectExpression();
    for (const t of Array.isArray(targets) ? targets : []) {
      const url = String(t?.url || '');
      const isSwarmTarget = isSwarmBoardTarget(t);
      const rawWsUrl = String(t?.webSocketDebuggerUrl || '').trim();
      const wsUrl =
        rawWsUrl ||
        (isSwarmTarget && t?.id
          ? `ws://127.0.0.1:${port}/devtools/page/${encodeURIComponent(String(t.id))}`
          : '');
      if (!wsUrl) continue;
      if (url.startsWith('vscode-file://') || url.includes('workbench.html') || url.startsWith('devtools://')) {
        continue;
      }
      if (
        t.type !== 'page' &&
        !(t.type === 'iframe' && url.includes('extensionView=true')) &&
        !isSwarmTarget
      ) {
        continue;
      }
      try {
        const res = await evalCdpOnce(wsUrl, collectExpr, 4000);
        scannedTargets += 1;
        for (const item of res?.items || []) {
          const text = String(item?.text || '').trim();
          if (!text || ignoreLists.exact.has(text)) continue;
          const prev = merged.get(text);
          merged.set(text, {
            text,
            kind: prev?.kind || item.kind || 'text',
            count: (prev?.count || 0) + (Number(item.count) || 1),
          });
        }
      } catch {
        // Target closed or unavailable
      }
    }
  }

  return {
    ports,
    scannedTargets,
    items: Array.from(merged.values()).sort((a, b) => b.count - a.count || (a.text < b.text ? -1 : 1)),
  };
}

function parseCliArgs(argv) {
  const opts = {
    locale: 'zh-CN',
    extract: false,
    noExtract: false,
    liveCdp: false,
    cdpPorts: [],
    strict: false,
    emitMissing: '',
    catalogPath: DEFAULT_CATALOG_OUT,
    ignorePath: DEFAULT_IGNORE_PATH,
    lsPaths: [],
    jsPaths: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--locale' && argv[i + 1]) opts.locale = argv[++i];
    else if (arg === '--extract') opts.extract = true;
    else if (arg === '--no-extract') opts.noExtract = true;
    else if (arg === '--live-cdp') opts.liveCdp = true;
    else if (arg === '--cdp-port' && argv[i + 1]) opts.cdpPorts.push(Number(argv[++i]));
    else if (arg === '--strict') opts.strict = true;
    else if (arg === '--emit-missing' && argv[i + 1]) opts.emitMissing = resolve(argv[++i]);
    else if (arg === '--catalog' && argv[i + 1]) opts.catalogPath = resolve(argv[++i]);
    else if (arg === '--ignore' && argv[i + 1]) opts.ignorePath = resolve(argv[++i]);
    else if (arg === '--ls' && argv[i + 1]) opts.lsPaths.push(resolve(argv[++i]));
    else if (arg === '--js' && argv[i + 1]) opts.jsPaths.push(resolve(argv[++i]));
  }
  return opts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cli = parseCliArgs(process.argv.slice(2));
  let catalog;

  const shouldExtract = cli.extract || (!cli.noExtract && !existsSync(cli.catalogPath));
  if (shouldExtract) {
    const lsPaths = [...cli.lsPaths];
    const jsPaths = [...cli.jsPaths];
    if (lsPaths.length === 0 && jsPaths.length === 0) {
      const discovered = discoverLocalAntigravitySources();
      lsPaths.push(...discovered.lsBinaries);
      jsPaths.push(...discovered.jsFiles);
    }
    if (lsPaths.length === 0 && jsPaths.length === 0) {
      console.error('[audit-host-i18n] No local Antigravity installation found. Pass --ls/--js or --no-extract.');
      process.exit(1);
    }
    catalog = runHostStringExtraction({ lsPaths, jsPaths, outPath: cli.catalogPath });
  } else {
    catalog = JSON.parse(readFileSync(cli.catalogPath, 'utf8'));
  }

  const packPath = join(HOST_I18N_ROOT, 'dist', 'packs', `${cli.locale}.json`);
  if (!existsSync(packPath)) {
    console.error(`[audit-host-i18n] Compiled pack not found: ${packPath}. Run build-packs.mjs first.`);
    process.exit(1);
  }
  const packObj = JSON.parse(readFileSync(packPath, 'utf8'));
  const ignoreLists = loadIgnoreLists(cli.ignorePath);
  const report = auditCatalogAgainstPack(catalog, packObj, ignoreLists);

  let liveCdp = null;
  if (cli.liveCdp) {
    liveCdp = await scanLiveCdpUntranslated({ ignoreLists, explicitPorts: cli.cdpPorts });
  }

  console.log(
    `[audit-host-i18n] Locale ${report.locale}@${report.version} vs catalog (${report.catalogCounts.exact} exact, ${report.catalogCounts.templates} templates)`
  );
  console.log(
    `  Pack size: base=${report.packCounts.baseExact}, light=${report.packCounts.lightExact}, deep=${report.packCounts.deepExact}, patterns=${report.packCounts.basePatterns}+${report.packCounts.lightPatterns}/${report.packCounts.deepPatterns}`
  );
  console.log(
    `  Ignored allowlist: ${report.ignoredExactCount} exact, ${report.ignoredTemplateCount} templates`
  );
  console.log(
    `  Missing static: ${report.missingExact.length} exact, ${report.missingTemplates.length} templates (covered via pattern: ${report.coveredExactByPatternCount})`
  );
  console.log(
    `  Integrity: ${report.brokenPatterns.length} broken pattern(s), ${report.redundantModeExact.length} redundant identical light/deep key(s)`
  );

  if (report.missingExact.length > 0) {
    console.log('  Sample missing exact (first 25):');
    for (const s of report.missingExact.slice(0, 25)) {
      console.log(`    - ${JSON.stringify(s)}`);
    }
  }
  if (report.missingTemplates.length > 0) {
    console.log('  Sample missing templates (first 15):');
    for (const t of report.missingTemplates.slice(0, 15)) {
      console.log(`    - ${JSON.stringify(t.key)}  (${t.source})`);
    }
  }
  if (report.brokenPatterns.length > 0) {
    console.log('  Broken pattern backreferences:');
    for (const b of report.brokenPatterns) {
      console.log(`    - [${b.tier}] ${b.source} -> ${b.replace} ($${b.badRef} > ${b.capCount})`);
    }
  }
  if (liveCdp) {
    console.log(
      `  Live CDP scan: ports=[${liveCdp.ports.join(',')}], targets=${liveCdp.scannedTargets}, untranslated=${liveCdp.items.length}`
    );
    for (const item of liveCdp.items.slice(0, 25)) {
      console.log(`    - [${item.kind} x${item.count}] ${JSON.stringify(item.text)}`);
    }
  }

  if (cli.emitMissing) {
    mkdirSync(dirname(cli.emitMissing), { recursive: true });
    writeFileSync(
      cli.emitMissing,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          locale: report.locale,
          version: report.version,
          missingExact: report.missingExact,
          missingTemplates: report.missingTemplates,
          liveCdpUntranslated: liveCdp ? liveCdp.items : [],
          brokenPatterns: report.brokenPatterns,
          redundantModeExact: report.redundantModeExact,
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
    console.log(`[audit-host-i18n] Emitted missing report -> ${cli.emitMissing}`);
  }

  const hasGap =
    report.missingExact.length > 0 ||
    report.missingTemplates.length > 0 ||
    report.brokenPatterns.length > 0 ||
    (liveCdp && liveCdp.items.length > 0);

  if (hasGap && cli.strict) {
    process.exit(2);
  }
}
