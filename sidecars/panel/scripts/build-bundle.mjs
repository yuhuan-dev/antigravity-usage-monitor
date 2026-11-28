/**
 * @fileoverview Assembles the modular ES files under src/ into the root
 * classic scripts (/styles.css and /app.js) required by the Antigravity
 * Sidecar Webview sandbox.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { SUPPORTED_LOCALES } from '../shared/settings-normalization.mjs';

const PANEL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'typeof',
  'void',
  'delete',
  'throw',
  'case',
  'in',
  'of',
  'instanceof',
  'new',
  'yield',
  'await',
]);

const REGEX_AFTER_PAREN_KEYWORDS = new Set(['if', 'while', 'for', 'with']);

function isIdentStart(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    ch === '_' ||
    ch === '$' ||
    code > 127
  );
}

function isIdentPart(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return isIdentStart(ch) || (code >= 48 && code <= 57);
}

function skipSimpleString(source, startIdx) {
  const quote = source[startIdx];
  let idx = startIdx + 1;
  while (idx < source.length) {
    const ch = source[idx];
    if (ch === '\\') {
      idx += 2;
      continue;
    }
    if (ch === quote) return idx + 1;
    idx += 1;
  }
  return source.length;
}

function skipSpacesAndComments(source, startIdx) {
  let idx = startIdx;
  while (idx < source.length) {
    const ch = source[idx];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      idx += 1;
    } else if (ch === '/' && source[idx + 1] === '/') {
      idx += 2;
      while (idx < source.length && source[idx] !== '\n') idx += 1;
    } else if (ch === '/' && source[idx + 1] === '*') {
      idx += 2;
      while (idx < source.length && !(source[idx] === '*' && source[idx + 1] === '/')) idx += 1;
      idx = Math.min(source.length, idx + 2);
    } else {
      break;
    }
  }
  return idx;
}

function consumeTrailingStatementEnd(source, startIdx) {
  let idx = startIdx;
  while (idx < source.length && (source[idx] === ' ' || source[idx] === '\t')) idx += 1;
  if (source[idx] === ';') {
    idx += 1;
    while (idx < source.length && (source[idx] === ' ' || source[idx] === '\t')) idx += 1;
  }
  if (source[idx] === '\r' && source[idx + 1] === '\n') {
    idx += 2;
  } else if (source[idx] === '\n') {
    idx += 1;
  }
  return idx;
}

function scanImportDeclarationEnd(source, afterImportIdx, onImport) {
  let idx = afterImportIdx;
  let braceDepth = 0;
  while (idx < source.length) {
    const ch = source[idx];
    if (ch === "'" || ch === '"') {
      const end = skipSimpleString(source, idx);
      if (braceDepth === 0) {
        onImport?.(source.slice(idx + 1, end - 1), source.slice(afterImportIdx, idx));
        return consumeTrailingStatementEnd(source, end);
      }
      idx = end;
      continue;
    }
    if (ch === '/' && source[idx + 1] === '/') {
      idx += 2;
      while (idx < source.length && source[idx] !== '\n') idx += 1;
      continue;
    }
    if (ch === '/' && source[idx + 1] === '*') {
      idx += 2;
      while (idx < source.length && !(source[idx] === '*' && source[idx + 1] === '/')) idx += 1;
      idx = Math.min(source.length, idx + 2);
      continue;
    }
    if (ch === '{') braceDepth += 1;
    else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === ';' && braceDepth === 0) {
      return consumeTrailingStatementEnd(source, idx);
    }
    idx += 1;
  }
  return source.length;
}

function scanExportClauseEnd(source, afterExportIdx, onImport, onExport) {
  let idx = afterExportIdx;
  let braceBody = '';
  if (source[idx] === '{') {
    const bodyStart = idx + 1;
    let depth = 1;
    idx += 1;
    while (idx < source.length && depth > 0) {
      const ch = source[idx];
      if (ch === "'" || ch === '"') {
        idx = skipSimpleString(source, idx);
        continue;
      }
      if (ch === '/' && source[idx + 1] === '/') {
        idx += 2;
        while (idx < source.length && source[idx] !== '\n') idx += 1;
        continue;
      }
      if (ch === '/' && source[idx + 1] === '*') {
        idx += 2;
        while (idx < source.length && !(source[idx] === '*' && source[idx + 1] === '/')) idx += 1;
        idx = Math.min(source.length, idx + 2);
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      idx += 1;
    }
    braceBody = source.slice(bodyStart, Math.max(bodyStart, idx - 1));
  } else if (source[idx] === '*') {
    idx += 1;
    idx = skipSpacesAndComments(source, idx);
    if (source.startsWith('as', idx) && !isIdentPart(source[idx + 2])) {
      idx = skipSpacesAndComments(source, idx + 2);
      while (idx < source.length && isIdentPart(source[idx])) idx += 1;
    }
  }

  function emitBraceExports() {
    if (!braceBody || !onExport) return;
    const cleaned = braceBody.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, ' ');
    for (const part of cleaned.split(',')) {
      const tok = part.trim();
      if (!tok) continue;
      const asMatch =
        /^([$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*)\s+as\s+([$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*)$/u.exec(
          tok
        );
      if (asMatch) {
        onExport(asMatch[2], true, asMatch[1]);
      } else {
        onExport(tok, true, tok);
      }
    }
  }

  const peekFrom = skipSpacesAndComments(source, idx);
  if (source.startsWith('from', peekFrom) && !isIdentPart(source[peekFrom + 4])) {
    const specIdx = skipSpacesAndComments(source, peekFrom + 4);
    if (source[specIdx] === "'" || source[specIdx] === '"') {
      const specEnd = skipSimpleString(source, specIdx);
      const specifier = source.slice(specIdx + 1, specEnd - 1);
      onImport?.(specifier, braceBody ? `{ ${braceBody} } from` : '');
      if (braceBody) {
        const cleaned = braceBody.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, ' ');
        for (const part of cleaned.split(',')) {
          const tok = part.trim();
          if (!tok) continue;
          const asMatch =
            /^([$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*)\s+as\s+([$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*)$/u.exec(
              tok
            );
          const exportedName = asMatch ? asMatch[2] : tok;
          onExport?.(exportedName, true, exportedName);
        }
      }
      idx = specEnd;
      return consumeTrailingStatementEnd(source, idx);
    }
  }

  emitBraceExports();
  return consumeTrailingStatementEnd(source, idx);
}

function recordExportedDeclarationIdent(source, declKeywordIdx, onExport) {
  if (!onExport) return;
  let pos = declKeywordIdx;
  if (source.startsWith('async', pos) && !isIdentPart(source[pos + 5])) {
    pos = skipSpacesAndComments(source, pos + 5);
  }
  for (const kw of ['const', 'let', 'var', 'function', 'class']) {
    if (source.startsWith(kw, pos) && !isIdentPart(source[pos + kw.length])) {
      pos = skipSpacesAndComments(source, pos + kw.length);
      if (source[pos] === '*') pos = skipSpacesAndComments(source, pos + 1);
      if (isIdentStart(source[pos])) {
        let end = pos + 1;
        while (end < source.length && isIdentPart(source[end])) end += 1;
        onExport(source.slice(pos, end), false);
      }
      return;
    }
  }
}

/**
 * Lexical ES module syntax stripper that skips comments, single/double-quoted
 * strings, template literals (including nested `${...}` expressions), and regex
 * literals, removing only true top-level `import` / `export` syntax.
 *
 * @param {string} source
 * @param {(specifier: string, clause: string) => void} [onImport]
 * @param {(name: string, isClauseExport: boolean) => void} [onExport]
 * @returns {string}
 */
export function stripModuleSyntax(source, onImport, onExport, { stripComments = false } = {}) {
  const len = source.length;
  let out = '';
  let i = 0;
  let braceDepth = 0;
  let parenDepth = 0;
  const parenAllowsRegexStack = [];
  const tplBraceStack = [];
  let canStartRegex = true;
  let prevNonWsChar = '';
  let pendingRegexParenKeyword = '';

  function scanTemplateChunk(startAfterBacktickOrBrace) {
    let idx = startAfterBacktickOrBrace;
    while (idx < len) {
      const ch = source[idx];
      if (ch === '\\') {
        idx += 2;
        continue;
      }
      if (ch === '`') {
        out += source.slice(startAfterBacktickOrBrace, idx + 1);
        canStartRegex = false;
        prevNonWsChar = '`';
        return idx + 1;
      }
      if (ch === '$' && source[idx + 1] === '{') {
        out += source.slice(startAfterBacktickOrBrace, idx + 2);
        tplBraceStack.push(braceDepth);
        braceDepth += 1;
        canStartRegex = true;
        prevNonWsChar = '{';
        return idx + 2;
      }
      idx += 1;
    }
    out += source.slice(startAfterBacktickOrBrace);
    return len;
  }

  while (i < len) {
    const ch = source[i];

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      out += ch;
      i += 1;
      continue;
    }

    // Line comment
    if (ch === '/' && source[i + 1] === '/') {
      let end = i + 2;
      while (end < len && source[end] !== '\n') end += 1;
      if (!stripComments) out += source.slice(i, end);
      i = end;
      continue;
    }

    // Block comment
    if (ch === '/' && source[i + 1] === '*') {
      let end = i + 2;
      while (end < len && !(source[end] === '*' && source[end + 1] === '/')) end += 1;
      end = Math.min(len, end + 2);
      if (!stripComments) {
        out += source.slice(i, end);
      } else {
        out += source.slice(i, end).includes('\n') ? '\n' : ' ';
      }
      i = end;
      continue;
    }

    // Single or double quoted string
    if (ch === "'" || ch === '"') {
      const end = skipSimpleString(source, i);
      out += source.slice(i, end);
      canStartRegex = false;
      prevNonWsChar = ch;
      pendingRegexParenKeyword = '';
      i = end;
      continue;
    }

    // Template literal start
    if (ch === '`') {
      out += '`';
      pendingRegexParenKeyword = '';
      i = scanTemplateChunk(i + 1);
      continue;
    }

    // Regex literal
    if (ch === '/' && canStartRegex) {
      let end = i + 1;
      let inClass = false;
      while (end < len) {
        const rc = source[end];
        if (rc === '\\') {
          end += 2;
          continue;
        }
        if (rc === '[') inClass = true;
        else if (rc === ']') inClass = false;
        else if (rc === '/' && !inClass) {
          end += 1;
          while (end < len && /[a-z]/i.test(source[end])) end += 1;
          break;
        } else if (rc === '\n') {
          break;
        }
        end += 1;
      }
      out += source.slice(i, end);
      canStartRegex = false;
      prevNonWsChar = '/';
      pendingRegexParenKeyword = '';
      i = end;
      continue;
    }

    // Braces & template expression resume
    if (ch === '{') {
      braceDepth += 1;
      out += ch;
      canStartRegex = true;
      prevNonWsChar = ch;
      pendingRegexParenKeyword = '';
      i += 1;
      continue;
    }

    if (ch === '}') {
      pendingRegexParenKeyword = '';
      if (tplBraceStack.length > 0 && braceDepth === tplBraceStack[tplBraceStack.length - 1] + 1) {
        braceDepth -= 1;
        tplBraceStack.pop();
        out += '}';
        i = scanTemplateChunk(i + 1);
        continue;
      }
      braceDepth = Math.max(0, braceDepth - 1);
      out += ch;
      canStartRegex = true;
      prevNonWsChar = ch;
      i += 1;
      continue;
    }

    if (ch === '(') {
      parenDepth += 1;
      parenAllowsRegexStack.push(Boolean(pendingRegexParenKeyword));
      pendingRegexParenKeyword = '';
      out += ch;
      canStartRegex = true;
      prevNonWsChar = ch;
      i += 1;
      continue;
    }

    if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      const allowsRegexAfterParen = parenAllowsRegexStack.pop() ?? false;
      pendingRegexParenKeyword = '';
      out += ch;
      canStartRegex = allowsRegexAfterParen;
      prevNonWsChar = ch;
      i += 1;
      continue;
    }

    // Identifier / keyword
    if (isIdentStart(ch)) {
      let end = i + 1;
      while (end < len && isIdentPart(source[end])) end += 1;
      const word = source.slice(i, end);

      const isTrueTopLevel =
        braceDepth === 0 &&
        parenDepth === 0 &&
        tplBraceStack.length === 0 &&
        prevNonWsChar !== '.';

      if (isTrueTopLevel && word === 'import') {
        const afterImport = skipSpacesAndComments(source, end);
        const nextCh = source[afterImport];
        // Exclude `import.meta` and dynamic `import(...)`
        if (nextCh && nextCh !== '.' && nextCh !== '(') {
          i = scanImportDeclarationEnd(source, afterImport, onImport);
          canStartRegex = true;
          prevNonWsChar = ';';
          pendingRegexParenKeyword = '';
          continue;
        }
      }

      if (isTrueTopLevel && word === 'export') {
        const afterExport = skipSpacesAndComments(source, end);
        const nextCh = source[afterExport];
        if (nextCh === '{' || nextCh === '*') {
          i = scanExportClauseEnd(source, afterExport, onImport, onExport);
          canStartRegex = true;
          prevNonWsChar = ';';
          pendingRegexParenKeyword = '';
          continue;
        }
        // `export default ...`
        if (source.startsWith('default', afterExport) && !isIdentPart(source[afterExport + 7])) {
          const afterDefault = skipSpacesAndComments(source, afterExport + 7);
          const isDecl =
            (source.startsWith('function', afterDefault) && !isIdentPart(source[afterDefault + 8])) ||
            (source.startsWith('class', afterDefault) && !isIdentPart(source[afterDefault + 5])) ||
            (source.startsWith('async', afterDefault) && !isIdentPart(source[afterDefault + 5]));
          if (isDecl) {
            recordExportedDeclarationIdent(source, afterDefault, onExport);
            i = afterDefault;
            canStartRegex = false;
            pendingRegexParenKeyword = '';
            continue;
          }
          out += 'void ';
          i = afterDefault;
          canStartRegex = true;
          prevNonWsChar = 'd';
          pendingRegexParenKeyword = '';
          continue;
        }
        // `export const|let|var|function|class|async ...`
        if (
          (source.startsWith('const', afterExport) && !isIdentPart(source[afterExport + 5])) ||
          (source.startsWith('let', afterExport) && !isIdentPart(source[afterExport + 3])) ||
          (source.startsWith('var', afterExport) && !isIdentPart(source[afterExport + 3])) ||
          (source.startsWith('function', afterExport) && !isIdentPart(source[afterExport + 8])) ||
          (source.startsWith('class', afterExport) && !isIdentPart(source[afterExport + 5])) ||
          (source.startsWith('async', afterExport) && !isIdentPart(source[afterExport + 5]))
        ) {
          recordExportedDeclarationIdent(source, afterExport, onExport);
          i = afterExport;
          canStartRegex = false;
          pendingRegexParenKeyword = '';
          continue;
        }
      }

      if (prevNonWsChar !== '.' && REGEX_AFTER_PAREN_KEYWORDS.has(word)) {
        pendingRegexParenKeyword = word;
      } else if (pendingRegexParenKeyword === 'for' && word === 'await') {
        pendingRegexParenKeyword = 'for_await';
      } else {
        pendingRegexParenKeyword = '';
      }
      out += word;
      canStartRegex = REGEX_PRECEDING_KEYWORDS.has(word);
      prevNonWsChar = word[word.length - 1];
      i = end;
      continue;
    }

    // Numbers & other punctuation
    pendingRegexParenKeyword = '';
    out += ch;
    if (/[0-9\]`]/.test(ch)) {
      canStartRegex = false;
    } else if (/[,=:[!&|?;+\-*%~^<>]/.test(ch)) {
      canStartRegex = true;
    } else {
      canStartRegex = false;
    }
    prevNonWsChar = ch;
    i += 1;
  }

  return out;
}

function validateBundleImport(
  sourcePath,
  specifier,
  clause,
  bundledPaths,
  moduleImportedNames,
  moduleImportAliases,
  outerExportedSymbols
) {
  const binding = clause.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, ' ').trim();
  if (binding) {
    const named = /^\{([^}]*)\}\s*from$/.exec(binding);
    const identifier = /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u;
    const aliasPattern =
      /^([$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*)\s+as\s+([$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*)$/u;
    if (!named) {
      throw new Error(`${sourcePath}: only named imports are supported in app.js`);
    }
    for (const rawItem of named[1].split(',')) {
      const name = rawItem.trim();
      if (!name) continue;
      const asMatch = aliasPattern.exec(name);
      if (asMatch) {
        const [, importedName, localName] = asMatch;
        if (outerExportedSymbols && !outerExportedSymbols.has(importedName)) {
          throw new Error(
            `${sourcePath}: imported symbol '${importedName}' is not exported by an earlier module in jsOrder`
          );
        }
        moduleImportedNames?.add(localName);
        if (localName !== importedName) {
          moduleImportAliases?.set(localName, importedName);
        }
        continue;
      }
      if (!identifier.test(name)) {
        throw new Error(`${sourcePath}: unsupported import binding '${name}' in app.js`);
      }
      moduleImportedNames?.add(name);
    }
  }
  if (
    !(specifier.startsWith('./') || specifier.startsWith('../')) ||
    !bundledPaths.has(resolve(dirname(sourcePath), specifier))
  ) {
    throw new Error(`${sourcePath}: ${specifier} must appear earlier in jsOrder`);
  }
}

export function buildBundle(panelDir = PANEL_DIR) {
  const cssOrder = [
    'src/styles/tokens.css',
    'src/styles/base.css',
    'src/styles/animations.css',
    'src/styles/controls.css',
    'src/styles/views-overview.css',
    'src/styles/views-consumption.css',
    'src/styles/views-tables.css',
    'src/styles/views-settings.css',
    'src/styles/overlay.css',
    'src/styles/modern-ui.css',
  ];

  const cssBundle =
    cssOrder
      .map((rel) => {
        const strippedCss = readFileSync(join(panelDir, rel), 'utf8')
          .replace(/\r\n/g, '\n')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        return `/* --- ${rel} --- */\n${strippedCss}`;
      })
      .join('\n\n') + '\n';

  const jsOrder = [
    'shared/settings-normalization.mjs',
    'shared/currency-catalog.mjs',
    'shared/telemetry-display-rules.mjs',
    'shared/window-bridge-protocol.mjs',
    'shared/host-i18n-protocol.mjs',
    'shared/host-theme.mjs',
    'src/icons/svgRegistry.js',
    'src/icons/SvgIcon.js',
    'src/core/reactive.js',
    ...SUPPORTED_LOCALES.map((locale) => `src/i18n/${locale}.js`),
    'src/i18n/index.js',
    'src/core/appearance.js',
    'src/core/domPatch.js',
    'src/core/component.js',
    'src/core/formatters.js',
    'src/core/stepInspector.js',
    'src/core/settingsBackup.js',
    'src/core/xlsxBuilder.js',
    'src/core/reportExporter.js',
    'src/core/httpClient.js',
    'src/store/uiStore.js',
    'src/core/fileExportClient.js',
    'src/core/hostI18nClient.js',
    'src/store/telemetryStore.js',
    'src/components/ui/TopLongPillNav.js',
    'src/components/ui/SearchInput.js',
    'src/components/ui/CustomSelect.js',
    'src/components/ui/ActionMenu.js',
    'src/components/ui/CustomNumberInput.js',
    'src/components/ui/CustomDateTimePicker.js',
    'src/components/ui/CustomScrollbar.js',
    'src/components/ui/SegmentedControl.js',
    'src/components/ui/ToggleSwitch.js',
    'src/components/ui/ContextSegmentMeter.js',
    'src/components/ui/FourSegmentBar.js',
    'src/components/ui/ConsumptionTooltipContent.js',
    'src/components/charts/chartMotion.js',
    'src/components/charts/TrendAreaChart.js',
    'src/components/charts/stepChartMath.js',
    'src/components/charts/SessionStepCharts.js',
    'src/registries/metricRegistry.js',
    'src/components/widgets/MetricMatrixWidget.js',
    'src/components/widgets/ContextWindowWidget.js',
    'src/components/widgets/QuotaPoolsWidget.js',
    'src/components/widgets/AccountQuotaTrendCard.js',
    'src/components/widgets/LiveActivityWidget.js',
    'src/registries/widgetRegistry.js',
    'src/registries/stepColumnRegistry.js',
    'src/components/widgets/CapsuleBarWidget.js',
    'src/components/widgets/StepTableWidget.js',
    'src/components/widgets/ConsumptionBreakdownRows.js',
    'src/components/widgets/SafetyMonitorCard.js',
    'src/components/settings/structurePreviewMock.js',
    'src/components/settings/CollapsibleSection.js',
    'src/components/settings/EditableSlotList.js',
    'src/components/settings/ThemeColorPicker.js',
    'src/components/settings/BridgeStatusNotice.js',
    'src/components/settings/SessionManagerCard.js',
    'src/components/settings/SessionMigrationCard.js',
    'src/components/settings/HostI18nCard.js',
    'src/views/settings/SettingsGeneralTab.js',
    'src/views/settings/SettingsStructureTab.js',
    'src/views/settings/SettingsSessionsTab.js',
    'src/views/settings/SettingsAccountTab.js',
    'src/views/settings/SettingsOtherTab.js',
    'src/components/layout/TopSessionHeader.js',
    'src/views/LiveOverviewView.js',
    'src/views/ConsumptionView.js',
    'src/views/StepsDetailView.js',
    'src/views/SettingsView.js',
    'src/App.js',
    'src/components/layout/overlayHostAnchors.js',
    'src/components/layout/WindowOverlayShell.js',
    'src/main.js',
  ];

  const bundledPaths = new Set();
  const outerExportedSymbols = new Set();
  const innerModules = jsOrder
    .map((rel) => {
      const path = resolve(panelDir, rel);
      if (bundledPaths.has(path)) throw new Error(`${rel}: duplicate entry in jsOrder`);
      const raw = readFileSync(path, 'utf8')
        .replace(/\r\n/g, '\n')
        .replace(/^\s*\/\*\*[\s\S]*?\*\/\s*/, '');
      const moduleImportedNames = new Set();
      const moduleImportAliases = new Map();
      const moduleLocalExports = new Map();
      const stripped = stripModuleSyntax(
        raw,
        (specifier, clause) =>
          validateBundleImport(
            path,
            specifier,
            clause,
            bundledPaths,
            moduleImportedNames,
            moduleImportAliases,
            outerExportedSymbols
          ),
        (name, isClauseExport, localName = name) => {
          if (
            isClauseExport &&
            localName === name &&
            moduleImportedNames.has(name) &&
            outerExportedSymbols.has(name)
          ) {
            return;
          }
          moduleLocalExports.set(name, localName);
        },
        { stripComments: true }
      )
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n');
      bundledPaths.add(path);
      const exportEntries = [...moduleLocalExports.entries()];
      for (const [sym] of exportEntries) {
        outerExportedSymbols.add(sym);
      }
      const aliasLines = [...moduleImportAliases.entries()].map(
        ([localName, importedName]) => `const ${localName} = ${importedName};`
      );
      const bodyWithAliases =
        aliasLines.length > 0 ? `${aliasLines.join('\n')}\n${stripped.trim()}` : stripped.trim();
      const outerDestructure = exportEntries.map(([exported]) => exported).join(', ');
      const innerReturnFields = exportEntries
        .map(([exported, local]) => (exported === local ? exported : `${exported}: ${local}`))
        .join(', ');
      const wrapped =
        exportEntries.length > 0
          ? `const { ${outerDestructure} } = (() => {\n${bodyWithAliases}\nreturn { ${innerReturnFields} };\n})();`
          : `(() => {\n${bodyWithAliases}\n})();`;
      return `// --- ${rel} ---\n${wrapped}`;
    })
    .join('\n\n');

  const jsBundle = `(() => {\n'use strict';\n\n${innerModules}\n})();\n`;
  new Script(jsBundle, { filename: 'app.js' });

  const ver = Date.now();
  const indexHtmlPath = join(panelDir, 'index.html');
  const html = existsSync(indexHtmlPath)
    ? readFileSync(indexHtmlPath, 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/href="\/styles\.css(?:\?v=[^"]*)?"/, `href="/styles.css?v=${ver}"`)
      .replace(/src="\/app\.js(?:\?v=[^"]*)?"/, `src="/app.js?v=${ver}"`)
    : null;

  writeFileSync(join(panelDir, 'styles.css'), cssBundle, 'utf8');
  writeFileSync(join(panelDir, 'app.js'), jsBundle, 'utf8');
  if (html !== null) {
    writeFileSync(indexHtmlPath, html, 'utf8');
  }

  console.log(
    `Built styles.css (${cssBundle.length} bytes) and app.js (${jsBundle.length} bytes) [v=${ver}]`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildBundle();
}
