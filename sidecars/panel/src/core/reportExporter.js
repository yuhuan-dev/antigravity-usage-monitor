/**
 * @fileoverview 原生多工作表 Excel (`.xlsx`)、RFC-4180 防公式注入 CSV 及多语言 Markdown 诊断报告生成纯函数模块 (`reportExporter.js`)。
 * 零外部依赖、单遍 O(N) 聚合，支持全部受支持界面语言导出，供「按步查看」和「用量统计」视图复用。
 */

import { getEffectiveLocale, tForLocale } from '../i18n/index.js';
import { resolveLocaleFromLanguageTag } from '../../shared/settings-normalization.mjs';
import {
  formatCompactDateTime,
  formatMetric,
  formatPctNumber,
  formatQuotaPoolLabel,
  formatSpeedMetric,
  formatTokensPrecise,
  formatTrendSlotFullLabel,
  formatUsd,
  mergeModelsByDisplayName,
  resolveModelDisplayInfo,
} from './formatters.js';
import { buildXlsxWorkbookBytes } from './xlsxBuilder.js';

const PLAIN_SIGNED_NUMBER_RE = /^[+-]?\d+(\.\d+)?$/;

const RANGE_KEY_SET = new Set([
  '5h',
  'today',
  '24h',
  'week',
  '7d',
  '14d',
  '30d',
  'all',
  'cycle',
  'custom',
]);

function resolveExportLocale(locale) {
  if (typeof locale === 'string' && locale.trim()) {
    return resolveLocaleFromLanguageTag(locale, getEffectiveLocale());
  }
  return getEffectiveLocale();
}

function formatExportDateTime(ms, includeSeconds = true) {
  const n = Number(ms);
  if (!(n > 0) || !Number.isFinite(n)) return '';
  const d = new Date(n);
  const pad = (v) => String(v).padStart(2, '0');
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return includeSeconds ? `${base}:${pad(d.getSeconds())}` : base;
}

function formatExportDate(ms) {
  const n = Number(ms);
  if (!(n > 0) || !Number.isFinite(n)) return '';
  const d = new Date(n);
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function resolveLocalizedRangeLabel(range, exportLocale) {
  const r = range || {};
  const key = String(r.key || '').trim().toLowerCase();
  const poolSuffix =
    key === 'cycle' && r.pool && r.pool !== 'all'
      ? ` · ${formatQuotaPoolLabel(r.poolLabel || r.pool, { locale: exportLocale })}`
      : '';
  if (exportLocale === 'zh-CN' && r.label) {
    return r.label;
  }
  if (key === 'cycle' && r.isFallbackWeek) {
    return `${tForLocale(exportLocale, 'report.range.week')}${poolSuffix}`;
  }
  const base = RANGE_KEY_SET.has(key)
    ? tForLocale(exportLocale, `report.range.${key}`)
    : r.label || key || tForLocale(exportLocale, 'report.range.all');
  return `${base}${poolSuffix}`;
}

function resolveRangeSpanNote(range) {
  const startMs = Number(range?.startMs || 0);
  const endMs = Number(range?.endMs || 0);
  if (startMs > 0 && endMs > 0) {
    return `${formatExportDate(startMs)} ~ ${formatExportDate(endMs)}`;
  }
  return '';
}

function computeCacheHitRatio(inTok, cacheTok, fallbackPct = null) {
  const safeIn = Math.max(0, Number(inTok || 0));
  const safeCache = Math.max(0, Number(cacheTok || 0));
  const promptTok = safeIn + safeCache;
  if (promptTok > 0) {
    return Math.max(0, Math.min(1, safeCache / promptTok));
  }
  if (fallbackPct != null && Number.isFinite(Number(fallbackPct))) {
    return Math.max(0, Math.min(1, Number(fallbackPct) / 100));
  }
  return 0;
}

function formatLocalizedAnomalyKind(kind, exportLocale) {
  const k = String(kind || 'error').trim();
  const key = `steps.anomalyKind.${k}`;
  const translated = tForLocale(exportLocale, key);
  return translated !== key ? translated : tForLocale(exportLocale, 'steps.anomalyKind.error');
}

function formatStepAnomaliesText(st, exportLocale) {
  const anom = st?.anomaly;
  const count = Number(anom?.count || 0);
  if (!(count > 0)) return '';
  const sep = tForLocale(exportLocale, 'report.anomSep');
  const kinds = anom?.kinds && typeof anom.kinds === 'object' ? Object.entries(anom.kinds) : [];
  if (kinds.length > 0) {
    return kinds
      .filter(([, v]) => Number(v || 0) > 0)
      .map(([k, v]) => `${formatLocalizedAnomalyKind(k, exportLocale)} ×${Number(v)}`)
      .join(sep);
  }
  return formatLocalizedAnomalyKind(anom?.primaryKind || 'error', exportLocale);
}

function formatStepAgentLabel(st, exportLocale) {
  const tr = (key, vars) => tForLocale(exportLocale, key, vars);
  const kind = String(st?.agentKind || '').trim();
  const explicit = String(st?.agentLabel || st?.agentBadge || '').trim();
  const customRole = String(st?.agentCustomRole || '').trim();

  if (
    kind === 'main' ||
    (!kind && !st?.isSubagent && (!explicit || /^(?:主代理|主|Main Agent|Main)$/i.test(explicit)))
  ) {
    return tr('report.agentMain');
  }

  const ord = Number(
    st?.agentOrdinal || (st?.isSideQuestion ? st?.sideIndex || 0 : st?.agentIndex || 0)
  );
  if (kind === 'side_question' || st?.isSideQuestion) {
    const base = ord > 0 ? `${tr('fmt.sideQuestion')} #${ord}` : tr('fmt.sideQuestion');
    return customRole ? `${base} · ${customRole}` : base;
  }
  if (kind === 'swarm_worker') {
    const base = ord > 0 ? `${tr('fmt.swarmAgent')} #${ord}` : tr('fmt.swarmAgent');
    return customRole ? `${base} · ${customRole}` : base;
  }

  if (explicit) {
    const subPrefixMatch = explicit.match(/^(?:子代理|Subagent)(?:\s*#(\d+))?(?:\s*·\s*(.+))?$/i);
    if (subPrefixMatch) {
      const idx = subPrefixMatch[1] || (ord > 0 ? String(ord) : '');
      const rest = String(subPrefixMatch[2] || '').trim();
      const base = idx ? `${tr('fmt.subAgent')} #${idx}` : tr('fmt.subAgent');
      return rest ? `${base} · ${rest}` : base;
    }
    const swarmPrefixMatch = explicit.match(/^(?:蜂群|Swarm)(?:\s*#(\d+))?(?:\s*·\s*(.+))?$/i);
    if (swarmPrefixMatch) {
      const idx = swarmPrefixMatch[1] || (ord > 0 ? String(ord) : '');
      const rest = String(swarmPrefixMatch[2] || '').trim();
      const base = idx ? `${tr('fmt.swarmAgent')} #${idx}` : tr('fmt.swarmAgent');
      return rest ? `${base} · ${rest}` : base;
    }
    const sidePrefixMatch = explicit.match(
      /^(?:旁路提问|Side Question)(?:\s*#(\d+))?(?:\s*·\s*(.+))?$/i
    );
    if (sidePrefixMatch) {
      const idx = sidePrefixMatch[1] || (ord > 0 ? String(ord) : '');
      const rest = String(sidePrefixMatch[2] || '').trim();
      const base = idx ? `${tr('fmt.sideQuestion')} #${idx}` : tr('fmt.sideQuestion');
      return rest ? `${base} · ${rest}` : base;
    }
    const shortBadgeMatch = explicit.match(/^(子|蜂|旁)(\d+)$/);
    if (shortBadgeMatch) {
      const idx = shortBadgeMatch[2];
      if (shortBadgeMatch[1] === '蜂') return `${tr('fmt.swarmAgent')} #${idx}`;
      if (shortBadgeMatch[1] === '旁') return `${tr('fmt.sideQuestion')} #${idx}`;
      return `${tr('fmt.subAgent')} #${idx}`;
    }
    return explicit;
  }

  if (st?.isSubagent) {
    if (ord > 0) return `${tr('fmt.subAgent')} #${ord}`;
    return st?.agentId ? String(st.agentId) : tr('fmt.subAgent');
  }
  return tr('report.agentMain');
}

function formatTrendWindowLabel(slot, isHourly) {
  if (Number(slot?.startMs) > 0) {
    return isHourly
      ? formatExportDateTime(slot.startMs, false)
      : formatExportDate(slot.startMs);
  }
  return String(slot?.fullLabel || slot?.label || '');
}

function summarizeStepsForExport(list, displaySettings, exportLocale) {
  let sumIn = 0;
  let sumCache = 0;
  let sumOut = 0;
  let sumThink = 0;
  let sumReply = 0;
  let sumCost = 0;
  let sumDuration = 0;
  let maxContext = 0;
  let tpsTokSum = 0;
  let tpsSecSum = 0;
  let tpsCnt = 0;
  let ttftSum = 0;
  let ttftCnt = 0;
  let anomSteps = 0;
  let anomTotal = 0;
  let compactionCount = 0;
  const byModel = new Map();

  for (let i = 0; i < list.length; i += 1) {
    const st = list[i];
    if (!st) continue;
    const inTok = Math.max(0, Number(st.inputTokens || 0));
    const cacheTok = Math.max(0, Number(st.cacheReadTokens || 0));
    const outTok = Math.max(0, Number(st.outputTokens || 0));
    const thinkTok = Math.max(0, Number(st.thinkingTokens || 0));
    const replyTok =
      st.responseTokens != null
        ? Math.max(0, Number(st.responseTokens))
        : Math.max(0, outTok - thinkTok);
    const ctxTok = Math.max(0, Number(st.contextTokens || inTok + cacheTok + outTok));
    const cost = Number(st.costUsd || 0);
    const rawDur = st.totalDurationSec ?? st.durationSec;
    const dur = rawDur != null && Number.isFinite(Number(rawDur)) ? Number(rawDur) : 0;

    sumIn += inTok;
    sumCache += cacheTok;
    sumOut += outTok;
    sumThink += thinkTok;
    sumReply += replyTok;
    if (ctxTok > maxContext) maxContext = ctxTok;
    if (Number.isFinite(cost) && cost > 0) sumCost += cost;
    if (Number.isFinite(dur) && dur > 0) sumDuration += dur;

    const validTps =
      !st.isCompactionStep &&
      !st.isImageGenStep &&
      outTok >= 50 &&
      !st.selectedSpeedReason &&
      Number.isFinite(Number(st.tokPerSec)) &&
      Number(st.tokPerSec) > 0;
    const stepSpeedSec = validTps
      ? st.totalDurationSec != null && Number(st.totalDurationSec) >= 0.5
        ? Number(st.totalDurationSec)
        : outTok / Number(st.tokPerSec)
      : 0;
    const validTtft =
      !st.isCompactionStep &&
      !st.isImageGenStep &&
      st.ttftSec != null &&
      Number.isFinite(Number(st.ttftSec)) &&
      Number(st.ttftSec) >= 0;
    if (validTps && stepSpeedSec > 0) {
      tpsTokSum += outTok;
      tpsSecSum += stepSpeedSec;
      tpsCnt += 1;
    }
    if (validTtft) {
      ttftSum += Number(st.ttftSec);
      ttftCnt += 1;
    }
    if (st.isCompactionStep) compactionCount += 1;
    const ac = Number(st.anomaly?.count || 0);
    if (ac > 0) {
      anomSteps += 1;
      anomTotal += ac;
    }

    const mInfo = resolveModelDisplayInfo(st, displaySettings, { locale: exportLocale });
    const mKey = mInfo.text || tForLocale(exportLocale, 'fmt.unknownModel');
    let mAcc = byModel.get(mKey);
    if (!mAcc) {
      mAcc = {
        label: mKey,
        calls: 0,
        inTok: 0,
        cacheTok: 0,
        outTok: 0,
        cost: 0,
        tpsTokSum: 0,
        tpsSecSum: 0,
        tpsCnt: 0,
        ttftSum: 0,
        ttftCnt: 0,
      };
      byModel.set(mKey, mAcc);
    }
    mAcc.calls += 1;
    mAcc.inTok += inTok;
    mAcc.cacheTok += cacheTok;
    mAcc.outTok += outTok;
    if (Number.isFinite(cost) && cost > 0) mAcc.cost += cost;
    if (validTps && stepSpeedSec > 0) {
      mAcc.tpsTokSum += outTok;
      mAcc.tpsSecSum += stepSpeedSec;
      mAcc.tpsCnt += 1;
    }
    if (validTtft) {
      mAcc.ttftSum += Number(st.ttftSec);
      mAcc.ttftCnt += 1;
    }
  }

  const sortedModels = Array.from(byModel.values()).sort(
    (a, b) =>
      b.cost - a.cost ||
      b.inTok + b.cacheTok + b.outTok - (a.inTok + a.cacheTok + a.outTok)
  );

  return {
    sumIn,
    sumCache,
    sumOut,
    sumThink,
    sumReply,
    sumCost,
    sumDuration,
    maxContext,
    tpsTokSum,
    tpsSecSum,
    tpsCnt,
    ttftSum,
    ttftCnt,
    anomSteps,
    anomTotal,
    compactionCount,
    sortedModels,
  };
}

/**
 * RFC-4180 安全转义单个 CSV 单元格，并防御电子表格公式注入（`=`, `+`, `-`, `@`, `\t`, `\r`）。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeCsvCell(value) {
  if (value === null || value === undefined) return '';
  let str = String(value);
  if (str.length > 0) {
    const first = str[0];
    if (
      first === '=' ||
      first === '@' ||
      first === '\t' ||
      first === '\r' ||
      ((first === '+' || first === '-') && !PLAIN_SIGNED_NUMBER_RE.test(str.trim()))
    ) {
      str = `'${str}`;
    }
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function csvRow(cells) {
  return cells.map(escapeCsvCell).join(',');
}

/**
 * 生成安全跨平台导出文件名（剔除非法路径字符并附加 `YYYYMMDD-HHmm` 时间戳）。
 *
 * @param {string} baseName
 * @param {string} ext
 * @param {number} [nowMs]
 * @returns {string}
 */
export function sanitizeExportFilename(baseName, ext = 'xlsx', nowMs = Date.now()) {
  const cleanBase =
    String(baseName || 'usage-report')
      .replace(/[\\/:*?"<>|\r\n\t]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'usage-report';
  const d = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const cleanExt = String(ext || 'xlsx').replace(/^\.+/, '');
  return `${cleanBase}-${stamp}.${cleanExt}`;
}

/**
 * 生成按当前界面语言本地化的用量统计导出文件前缀。
 *
 * @param {object} consumption
 * @param {string} [fallbackRange='all']
 * @param {{ locale?: string }} [opts]
 * @returns {string}
 */
export function buildConsumptionExportBaseName(
  consumption,
  fallbackRange = 'all',
  { locale } = {}
) {
  const exportLocale = resolveExportLocale(locale);
  const range = consumption?.selectedRange || { key: fallbackRange };
  const rKey = range.key || fallbackRange || 'all';
  if (exportLocale === 'en-US') {
    return `usage-${rKey}`;
  }
  const rangeLabel = resolveLocalizedRangeLabel(range, exportLocale);
  return tForLocale(exportLocale, 'report.fileUsage', { range: rangeLabel });
}

/**
 * 生成按当前界面语言本地化的调用明细导出文件前缀。
 *
 * @param {string} [title='']
 * @param {string} [cascadeId='']
 * @param {{ locale?: string }} [opts]
 * @returns {string}
 */
export function buildStepsExportBaseName(title = '', cascadeId = '', { locale } = {}) {
  const exportLocale = resolveExportLocale(locale);
  const name = String(title || cascadeId || '').trim();
  return tForLocale(exportLocale, 'report.fileSteps', {
    name: name || tForLocale(exportLocale, 'report.currentSession'),
  });
}

function escapeMdCell(value) {
  return String(value ?? '—')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

/**
 * 将当前步骤列表导出为带 UTF-8 BOM 的 RFC-4180 安全 CSV 字符串（向后兼容保留）。
 *
 * @param {Array<object>} steps
 * @param {{ displaySettings?: object, includeBom?: boolean, locale?: string }} [opts]
 * @returns {string}
 */
export function buildStepsCsv(steps, { displaySettings = {}, includeBom = true, locale } = {}) {
  const exportLocale = resolveExportLocale(locale);
  const list = Array.isArray(steps) ? steps : [];
  const header = csvRow([
    'step',
    'timestamp',
    'agent',
    'model',
    'raw_model_id',
    'tok_per_sec',
    'ttft_sec',
    'duration_sec',
    'input_tokens',
    'cache_read_tokens',
    'output_tokens',
    'thinking_tokens',
    'response_tokens',
    'context_tokens',
    'cache_hit_pct',
    'cost_usd',
    'compaction',
    'anomaly_count',
    'anomalies',
    'prompt',
  ]);

  const rows = [header];
  for (let i = 0; i < list.length; i += 1) {
    const st = list[i];
    if (!st) continue;
    const mInfo = resolveModelDisplayInfo(st, displaySettings, { locale: exportLocale });
    const inTok = Number(st.inputTokens || 0);
    const cacheTok = Number(st.cacheReadTokens || 0);
    const outTok = Number(st.outputTokens || 0);
    const thinkTok = Number(st.thinkingTokens || 0);
    const replyTok =
      st.responseTokens != null ? Number(st.responseTokens) : Math.max(0, outTok - thinkTok);
    const promptTok = inTok + cacheTok;
    const cachePct =
      st.cacheHitPct != null && Number.isFinite(Number(st.cacheHitPct))
        ? formatPctNumber(st.cacheHitPct)
        : promptTok > 0
          ? formatPctNumber((cacheTok / promptTok) * 100)
          : '0';
    const ctxTok = Number(st.contextTokens || promptTok + outTok);
    const anomCount = Number(st.anomaly?.count || 0);
    const anomDesc =
      anomCount > 0
        ? Object.entries(st.anomaly?.kinds || {})
            .map(([k, v]) => `${k}:${v}`)
            .join(';') || String(st.anomaly?.primaryKind || 'error')
        : '';
    rows.push(
      csvRow([
        st.stepIndex ?? '',
        st.createdAtMs ? new Date(st.createdAtMs).toISOString() : '',
        formatStepAgentLabel(st, exportLocale),
        mInfo.text,
        st.rawModelId || st.modelKey || '',
        st.tokPerSec != null && Number.isFinite(Number(st.tokPerSec))
          ? Number(st.tokPerSec).toFixed(2)
          : '',
        st.ttftSec != null && Number.isFinite(Number(st.ttftSec))
          ? Number(st.ttftSec).toFixed(3)
          : '',
        (st.totalDurationSec ?? st.durationSec) != null &&
        Number.isFinite(Number(st.totalDurationSec ?? st.durationSec))
          ? Number(st.totalDurationSec ?? st.durationSec).toFixed(3)
          : '',
        inTok,
        cacheTok,
        outTok,
        thinkTok,
        replyTok,
        ctxTok,
        cachePct,
        st.costUsd != null && Number.isFinite(Number(st.costUsd))
          ? Number(st.costUsd).toFixed(6)
          : '',
        st.isCompactionStep ? 'true' : 'false',
        anomCount,
        anomDesc,
        String(st.turnPrompt || st.rootTurnPrompt || '').replace(/\r?\n/g, ' ').trim(),
      ])
    );
  }
  return `${includeBom ? '\uFEFF' : ''}${rows.join('\r\n')}\r\n`;
}

/**
 * 将当前步骤列表导出为精排版、多工作表、多语言原生 Excel (`.xlsx`) 二进制工作簿。
 *
 * @param {Array<object>} steps
 * @param {{ title?: string, cascadeId?: string, displaySettings?: object, locale?: string }} [opts]
 * @returns {Uint8Array}
 */
export function buildStepsXlsx(steps, { displaySettings = {}, locale } = {}) {
  const exportLocale = resolveExportLocale(locale);
  const tr = (key, vars) => tForLocale(exportLocale, key, vars);
  const list = Array.isArray(steps) ? steps.filter(Boolean) : [];
  const agg = summarizeStepsForExport(list, displaySettings, exportLocale);

  const stepRows = [];
  for (let i = 0; i < list.length; i += 1) {
    const st = list[i];
    const mInfo = resolveModelDisplayInfo(st, displaySettings, { locale: exportLocale });
    const inTok = Math.max(0, Number(st.inputTokens || 0));
    const cacheTok = Math.max(0, Number(st.cacheReadTokens || 0));
    const outTok = Math.max(0, Number(st.outputTokens || 0));
    const thinkTok = Math.max(0, Number(st.thinkingTokens || 0));
    const replyTok =
      st.responseTokens != null
        ? Math.max(0, Number(st.responseTokens))
        : Math.max(0, outTok - thinkTok);
    const ctxTok = Math.max(0, Number(st.contextTokens || inTok + cacheTok + outTok));
    const cacheRatio = computeCacheHitRatio(inTok, cacheTok, st.cacheHitPct);
    const anomCount = Number(st.anomaly?.count || 0);
    const anomText = formatStepAnomaliesText(st, exportLocale);
    const promptText = String(st.turnPrompt || st.rootTurnPrompt || '')
      .replace(/\r?\n/g, ' ')
      .trim();
    const stepNum = Number.isFinite(Number(st.stepIndex)) ? Number(st.stepIndex) : i + 1;
    const tpsVal =
      !st.isCompactionStep && st.tokPerSec != null && Number.isFinite(Number(st.tokPerSec))
        ? Number(st.tokPerSec)
        : null;
    const ttftVal =
      !st.isCompactionStep && st.ttftSec != null && Number.isFinite(Number(st.ttftSec))
        ? Number(st.ttftSec)
        : null;
    const rawDurVal = st.totalDurationSec ?? st.durationSec;
    const durVal =
      rawDurVal != null && Number.isFinite(Number(rawDurVal))
        ? Number(rawDurVal)
        : null;
    const costVal =
      st.costUsd != null && Number.isFinite(Number(st.costUsd)) ? Number(st.costUsd) : null;
    const typeLabel = st.isCompactionStep
      ? tr('report.stepTypeCompaction')
      : st.isImageGenStep
        ? tr('report.stepTypeImage')
        : tr('report.stepTypeNormal');
    const tone = anomCount > 0 ? 'danger' : st.isCompactionStep ? 'info' : '';

    stepRows.push({
      tone,
      values: [
        stepNum,
        formatExportDateTime(st.createdAtMs, true),
        formatStepAgentLabel(st, exportLocale),
        mInfo.text || '—',
        typeLabel,
        tpsVal,
        ttftVal,
        durVal,
        inTok,
        cacheTok,
        thinkTok,
        replyTok,
        outTok,
        ctxTok,
        cacheRatio,
        costVal,
        anomText,
        promptText,
      ],
    });
  }

  if (list.length > 0) {
    const overallCacheRatio = computeCacheHitRatio(agg.sumIn, agg.sumCache);
    stepRows.push({
      tone: 'summary',
      values: [
        '',
        '',
        '',
        tr('report.totalSteps', { count: list.length }),
        agg.compactionCount > 0 ? tr('report.compactCount', { count: agg.compactionCount }) : '',
        agg.tpsSecSum > 0 ? +(agg.tpsTokSum / agg.tpsSecSum).toFixed(1) : null,
        agg.ttftCnt > 0 ? +(agg.ttftSum / agg.ttftCnt).toFixed(2) : null,
        agg.sumDuration > 0 ? +agg.sumDuration.toFixed(2) : null,
        agg.sumIn,
        agg.sumCache,
        agg.sumThink,
        agg.sumReply,
        agg.sumOut,
        agg.maxContext,
        overallCacheRatio,
        agg.sumCost,
        agg.anomTotal > 0 ? tr('report.anomCount', { total: agg.anomTotal, steps: agg.anomSteps }) : '',
        '',
      ],
    });
  }

  const sheets = [
    {
      name: tr('report.sheetSteps'),
      columns: [
        { header: tr('report.colStep'), type: 'int', minWidth: 9 },
        { header: tr('report.colTime'), type: 'center', minWidth: 21 },
        { header: tr('report.colAgent'), type: 'center', minWidth: 11 },
        { header: tr('report.colModel'), type: 'text', minWidth: 18, maxWidth: 38 },
        { header: tr('report.colType'), type: 'center', minWidth: 11 },
        { header: tr('report.colSpeed'), type: 'dec1', minWidth: 14 },
        { header: tr('report.colTtft'), type: 'dec2', minWidth: 13 },
        { header: tr('report.colDuration'), type: 'dec2', minWidth: 13 },
        { header: tr('report.colFreshInput'), type: 'int', minWidth: 13 },
        { header: tr('report.colCacheRead'), type: 'int', minWidth: 14 },
        { header: tr('report.colThinking'), type: 'int', minWidth: 11 },
        { header: tr('report.colReply'), type: 'int', minWidth: 11 },
        { header: tr('report.colOutput'), type: 'int', minWidth: 12 },
        { header: tr('report.colContext'), type: 'int', minWidth: 14 },
        { header: tr('report.colCacheHitPct'), type: 'pct', minWidth: 13 },
        { header: tr('report.colCostUsd'), type: 'usd4', minWidth: 14 },
        { header: tr('report.colAnomalies'), type: 'text', minWidth: 14, maxWidth: 38 },
        { header: tr('report.colTurnPrompt'), type: 'text', minWidth: 24, maxWidth: 52 },
      ],
      rows: stepRows,
    },
  ];

  if (agg.sortedModels.length > 0) {
    const modelRows = agg.sortedModels.map((m) => {
      const mTotal = m.inTok + m.cacheTok + m.outTok;
      return [
        m.label,
        m.calls,
        m.inTok,
        m.cacheTok,
        m.outTok,
        mTotal,
        computeCacheHitRatio(m.inTok, m.cacheTok),
        m.tpsSecSum > 0 ? +(m.tpsTokSum / m.tpsSecSum).toFixed(1) : null,
        m.ttftCnt > 0 ? +(m.ttftSum / m.ttftCnt).toFixed(2) : null,
        m.cost,
      ];
    });
    modelRows.push({
      tone: 'summary',
      values: [
        tr('report.total'),
        list.length,
        agg.sumIn,
        agg.sumCache,
        agg.sumOut,
        agg.sumIn + agg.sumCache + agg.sumOut,
        computeCacheHitRatio(agg.sumIn, agg.sumCache),
        agg.tpsSecSum > 0 ? +(agg.tpsTokSum / agg.tpsSecSum).toFixed(1) : null,
        agg.ttftCnt > 0 ? +(agg.ttftSum / agg.ttftCnt).toFixed(2) : null,
        agg.sumCost,
      ],
    });
    sheets.push({
      name: tr('report.sheetModelSummary'),
      columns: [
        { header: tr('report.colModel'), type: 'text', minWidth: 20, maxWidth: 42 },
        { header: tr('report.colSteps'), type: 'int', minWidth: 10 },
        { header: tr('report.colFreshInput'), type: 'int', minWidth: 14 },
        { header: tr('report.colCacheRead'), type: 'int', minWidth: 15 },
        { header: tr('report.colOutput'), type: 'int', minWidth: 13 },
        { header: tr('report.colTotalTokens'), type: 'int', minWidth: 15 },
        { header: tr('report.colCacheHitPct'), type: 'pct', minWidth: 13 },
        { header: tr('report.colAvgSpeed'), type: 'dec1', minWidth: 16 },
        { header: tr('report.colAvgTtft'), type: 'dec2', minWidth: 14 },
        { header: tr('report.colEstCostUsd'), type: 'usd4', minWidth: 16 },
      ],
      rows: modelRows,
    });
  }

  return buildXlsxWorkbookBytes(sheets);
}

/**
 * 生成当前会话（或筛选后步骤子集）的可分享多语言 Markdown 诊断报告。
 *
 * @param {Array<object>} steps
 * @param {{ title?: string, cascadeId?: string, displaySettings?: object, filterNote?: string, locale?: string }} [opts]
 * @returns {string}
 */
export function buildStepsMarkdownReport(
  steps,
  { title = '', cascadeId = '', displaySettings = {}, filterNote = '', locale } = {}
) {
  const exportLocale = resolveExportLocale(locale);
  const tr = (key, vars) => tForLocale(exportLocale, key, vars);
  const list = Array.isArray(steps) ? steps.filter(Boolean) : [];
  const agg = summarizeStepsForExport(list, displaySettings, exportLocale);

  const totalTok = agg.sumIn + agg.sumCache + agg.sumOut;
  const cacheHitPct = formatPctNumber(computeCacheHitRatio(agg.sumIn, agg.sumCache) * 100);
  const avgTps =
    agg.tpsSecSum > 0 ? formatSpeedMetric(agg.tpsTokSum / agg.tpsSecSum, ' tok/s') : '—';
  const avgTtft = agg.ttftCnt > 0 ? formatMetric(agg.ttftSum / agg.ttftCnt, 's') : '—';
  const heading = title ? `# ${title}` : tr('report.mdStepsTitle');

  const lines = [
    heading,
    '',
    ...(cascadeId ? [tr('report.mdSessionId', { id: cascadeId })] : []),
    ...(filterNote ? [tr('report.mdScope', { scope: filterNote })] : []),
    tr('report.mdStepsLine', {
      count: list.length,
      compactPart:
        agg.compactionCount > 0 ? tr('report.mdCompactPart', { count: agg.compactionCount }) : '',
      anomPart:
        agg.anomTotal > 0
          ? tr('report.mdAnomPart', { total: agg.anomTotal, steps: agg.anomSteps })
          : '',
    }),
    tr('report.mdTokensLine', {
      total: formatTokensPrecise(totalTok),
      inTok: formatTokensPrecise(agg.sumIn),
      cacheTok: formatTokensPrecise(agg.sumCache),
      cachePct: cacheHitPct,
      outTok: formatTokensPrecise(agg.sumOut),
    }),
    tr('report.mdCostSpeedLine', {
      cost: formatUsd(agg.sumCost, { precise: agg.sumCost > 0 && agg.sumCost < 0.1 }),
      speed: avgTps,
      ttft: avgTtft,
    }),
  ];

  if (agg.sortedModels.length > 0) {
    lines.push(
      '',
      tr('report.mdModelBreakdown'),
      '',
      tr('report.mdHeaderModel'),
      '| --- | ---: | ---: | ---: | ---: | ---: |'
    );
    for (const m of agg.sortedModels) {
      const mTotal = m.inTok + m.cacheTok + m.outTok;
      const mCache = formatPctNumber(computeCacheHitRatio(m.inTok, m.cacheTok) * 100, {
        withSymbol: true,
      });
      const mTps =
        m.tpsSecSum > 0 ? formatSpeedMetric(m.tpsTokSum / m.tpsSecSum, ' tok/s') : '—';
      lines.push(
        `| ${escapeMdCell(m.label)} | ${m.calls} | ${formatTokensPrecise(mTotal)} | ${mCache} | ${mTps} | ${formatUsd(m.cost, { precise: m.cost > 0 && m.cost < 0.1 })} |`
      );
    }
  }

  const topCostly = list
    .filter((st) => Number(st?.costUsd || 0) > 0)
    .slice()
    .sort((a, b) => Number(b.costUsd || 0) - Number(a.costUsd || 0))
    .slice(0, 5);
  if (topCostly.length > 0) {
    lines.push(
      '',
      tr('report.mdTopCostly'),
      '',
      tr('report.mdHeaderTopSteps'),
      '| ---: | --- | --- | ---: | ---: | ---: | ---: |'
    );
    for (const st of topCostly) {
      const mInfo = resolveModelDisplayInfo(st, displaySettings, { locale: exportLocale });
      const timeStr = st.createdAtMs ? formatCompactDateTime(st.createdAtMs) : '—';
      const ctxTok = Number(
        st.contextTokens ||
          Number(st.inputTokens || 0) + Number(st.cacheReadTokens || 0) + Number(st.outputTokens || 0)
      );
      lines.push(
        `| #${st.stepIndex ?? '—'} | ${timeStr} | ${escapeMdCell(mInfo.text)} | ${formatSpeedMetric(st.tokPerSec, ' tok/s')} | ${formatMetric(st.ttftSec, 's')} | ${formatTokensPrecise(ctxTok)} | ${formatUsd(st.costUsd, { precise: true })} |`
      );
    }
  }

  if (agg.anomTotal > 0) {
    const anomKindTotals = new Map();
    for (const st of list) {
      if (!st?.anomaly?.kinds) continue;
      for (const [k, v] of Object.entries(st.anomaly.kinds)) {
        const n = Number(v || 0);
        if (n > 0) anomKindTotals.set(k, (anomKindTotals.get(k) || 0) + n);
      }
    }
    if (anomKindTotals.size > 0) {
      const summary = Array.from(anomKindTotals.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${formatLocalizedAnomalyKind(k, exportLocale)} ×${v}`)
        .join(tr('select.listSep'));
      lines.push('', tr('report.mdAnomSummary', { summary }));
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * 将历史用量统计视图当前区间数据导出为结构化 CSV（向后兼容保留）。
 *
 * @param {object} consumption
 * @param {Array<object>} modelBreakdown
 * @param {{ displaySettings?: object, includeBom?: boolean, locale?: string }} [opts]
 * @returns {string}
 */
export function buildConsumptionCsv(
  consumption,
  modelBreakdown = [],
  { displaySettings = {}, includeBom = true, locale } = {}
) {
  const exportLocale = resolveExportLocale(locale);
  const cons = consumption || {};
  const acc = cons.account || {};
  const range = cons.selectedRange || {};
  const models = mergeModelsByDisplayName(modelBreakdown || [], displaySettings, {
    preferLabelInShort: true,
    locale: exportLocale,
  });
  const workspaces = Array.isArray(cons.topWorkspaces) ? cons.topWorkspaces : [];
  const sessions = Array.isArray(cons.topConversations) ? cons.topConversations : [];
  const trend = Array.isArray(cons.trendSeries) ? cons.trendSeries : [];

  const rows = [
    csvRow([
      'section',
      'name',
      'calls',
      'input_tokens',
      'cache_read_tokens',
      'output_tokens',
      'total_tokens',
      'cache_hit_pct',
      'cost_usd',
      'extra',
    ]),
    csvRow([
      'summary',
      resolveLocalizedRangeLabel(range, exportLocale),
      Number(acc.calls || 0),
      Number(acc.inputTokens || 0),
      Number(acc.cacheReadTokens || 0),
      Number(acc.outputTokens || 0),
      Number(acc.totalTokens || 0),
      formatPctNumber(acc.cacheHitPct || 0),
      Number(acc.costUsd || 0).toFixed(4),
      `saved_usd=${Number(acc.savedCostUsd || 0).toFixed(4)}`,
    ]),
  ];

  for (const m of models) {
    rows.push(
      csvRow([
        'model',
        m.displayText || m.label || m.shortName || '—',
        Number(m.calls || 0),
        Number(m.inputTokens || 0),
        Number(m.cacheReadTokens || 0),
        Number(m.outputTokens || 0),
        Number(m.totalTokens || 0),
        formatPctNumber(m.cacheHitPct || 0),
        Number(m.costUsd || 0).toFixed(4),
        m.avgTokPerSec != null ? `avg_tps=${Number(m.avgTokPerSec).toFixed(1)}` : '',
      ])
    );
  }

  for (const w of workspaces) {
    rows.push(
      csvRow([
        'project',
        w.label || w.workspacePath || 'unbound',
        Number(w.calls || 0),
        Number(w.inputTokens || 0),
        Number(w.cacheReadTokens || 0),
        Number(w.responseTokens || 0) + Number(w.thinkingTokens || 0),
        Number(w.totalTokens || 0),
        formatPctNumber(w.cacheHitPct || 0),
        Number(w.costUsd || 0).toFixed(4),
        `sessions=${Number(w.sessionCount || 0)}`,
      ])
    );
  }

  for (const c of sessions) {
    rows.push(
      csvRow([
        'session',
        c.title || c.cascadeId || '—',
        Number(c.calls || 0),
        Number(c.inputTokens || 0),
        Number(c.cacheReadTokens || 0),
        Number(c.responseTokens || 0) + Number(c.thinkingTokens || 0),
        Number(c.totalTokens || 0),
        formatPctNumber(c.cacheHitPct || 0),
        Number(c.costUsd || 0).toFixed(4),
        c.sourceName || c.appSource || '',
      ])
    );
  }

  for (const slot of trend) {
    if (!slot || !(Number(slot.tokens || 0) > 0 || Number(slot.calls || 0) > 0)) continue;
    rows.push(
      csvRow([
        'trend',
        formatTrendSlotFullLabel(slot, { locale: exportLocale }) || slot.label || '',
        Number(slot.calls || 0),
        Number(slot.inputTokens || 0),
        Number(slot.cacheReadTokens || 0),
        Number(slot.outputTokens || 0),
        Number(slot.tokens || 0),
        '',
        Number(slot.costUsd || 0).toFixed(4),
        slot.granularity || '',
      ])
    );
  }

  return `${includeBom ? '\uFEFF' : ''}${rows.join('\r\n')}\r\n`;
}

/**
 * 将历史用量统计视图当前区间数据导出为多工作表、全自动列宽及多语言原生 Excel (`.xlsx`) 工作簿。
 *
 * @param {object} consumption
 * @param {Array<object>} modelBreakdown
 * @param {{ displaySettings?: object, locale?: string, nowMs?: number }} [opts]
 * @returns {Uint8Array}
 */
export function buildConsumptionXlsx(
  consumption,
  modelBreakdown = [],
  { displaySettings = {}, locale, nowMs = Date.now() } = {}
) {
  const exportLocale = resolveExportLocale(locale);
  const tr = (key, vars) => tForLocale(exportLocale, key, vars);
  const cons = consumption || {};
  const acc = cons.account || {};
  const range = cons.selectedRange || {};
  const models = mergeModelsByDisplayName(modelBreakdown || [], displaySettings, {
    preferLabelInShort: true,
    locale: exportLocale,
  });
  const workspaces = Array.isArray(cons.topWorkspaces) ? cons.topWorkspaces : [];
  const sessions = Array.isArray(cons.topConversations) ? cons.topConversations : [];
  const sources = Array.isArray(cons.sourcesBreakdown) ? cons.sourcesBreakdown : [];
  const trend = (Array.isArray(cons.trendSeries) ? cons.trendSeries : []).filter(
    (slot) => slot && (Number(slot.tokens || 0) > 0 || Number(slot.calls || 0) > 0)
  );

  const rangeLabel = resolveLocalizedRangeLabel(range, exportLocale);
  const spanNote = resolveRangeSpanNote(range);
  const accIn = Math.max(0, Number(acc.inputTokens || 0));
  const accCache = Math.max(0, Number(acc.cacheReadTokens || 0));
  const accOut = Math.max(0, Number(acc.outputTokens || 0));
  const accThink = Math.max(0, Number(acc.thinkingTokens || 0));
  const accReply =
    acc.responseTokens != null
      ? Math.max(0, Number(acc.responseTokens))
      : Math.max(0, accOut - accThink);
  const accTotal = Math.max(0, Number(acc.totalTokens ?? accIn + accCache + accOut));
  const accCalls = Math.max(0, Number(acc.calls || 0));
  const accCacheRatio = computeCacheHitRatio(accIn, accCache, acc.cacheHitPct);
  const accCost = Math.max(0, Number(acc.costUsd || 0));
  const accSaved = Math.max(0, Number(acc.savedCostUsd || 0));

  const overviewRows = [
    [tr('report.ovTimeRange'), { value: rangeLabel, type: 'text_right' }, spanNote],
    [tr('report.ovExportedAt'), { value: formatExportDateTime(nowMs, true), type: 'text_right' }, ''],
    [tr('report.ovTotalCalls'), { value: accCalls, type: 'int' }, tr('report.ovTotalCallsNote')],
    [tr('report.colTotalTokens'), { value: accTotal, type: 'int' }, tr('report.ovTotalTokensNote')],
    [tr('report.ovFreshInputTokens'), { value: accIn, type: 'int' }, tr('report.ovFreshInputNote')],
    [tr('report.ovCacheReadTokens'), { value: accCache, type: 'int' }, tr('report.ovCacheReadNote')],
    [
      tr('report.ovTotalOutputTokens'),
      { value: accOut, type: 'int' },
      accThink > 0
        ? tr('report.ovOutputSplitNote', {
            think: accThink.toLocaleString('en-US'),
            reply: accReply.toLocaleString('en-US'),
          })
        : tr('report.ovOutputNote'),
    ],
  ];

  if (accThink > 0 || accReply > 0) {
    overviewRows.push(
      [tr('report.ovThinkingTokens'), { value: accThink, type: 'int' }, tr('report.ovThinkingNote')],
      [tr('report.ovReplyTokens'), { value: accReply, type: 'int' }, tr('report.ovReplyNote')]
    );
  }

  overviewRows.push(
    [tr('report.ovCacheHitRate'), { value: accCacheRatio, type: 'pct' }, tr('report.ovCacheHitNote')],
    [tr('report.ovCacheSaved'), { value: accSaved, type: 'usd2' }, tr('report.ovCacheSavedNote')],
    {
      tone: 'summary',
      values: [
        tr('report.colEstCostUsd'),
        { value: accCost, type: 'usd2' },
        tr('report.ovEstCostNote'),
      ],
    }
  );

  const sheets = [
    {
      name: tr('report.sheetOverview'),
      autoFilter: false,
      columns: [
        { header: tr('report.colMetric'), type: 'text', minWidth: 20 },
        { header: tr('report.colValue'), type: 'text_right', align: 'right', minWidth: 22 },
        { header: tr('report.colNotes'), type: 'text', minWidth: 32, maxWidth: 56 },
      ],
      rows: overviewRows,
    },
  ];

  // Sheet 2: Models
  if (models.length > 0) {
    let mCalls = 0;
    let mIn = 0;
    let mCache = 0;
    let mOut = 0;
    let mTot = 0;
    let mCost = 0;
    let tpsTokSum = 0;
    let tpsSecSum = 0;
    const modelRows = models.map((m, idx) => {
      const calls = Math.max(0, Number(m.calls || 0));
      const inTok = Math.max(0, Number(m.inputTokens || 0));
      const cacheTok = Math.max(0, Number(m.cacheReadTokens || 0));
      const outTok = Math.max(0, Number(m.outputTokens || 0));
      const totTok = Math.max(0, Number(m.totalTokens ?? inTok + cacheTok + outTok));
      const cost = Math.max(0, Number(m.costUsd || 0));
      const tps =
        m.avgTokPerSec != null && Number.isFinite(Number(m.avgTokPerSec)) && Number(m.avgTokPerSec) > 0
          ? Number(m.avgTokPerSec)
          : null;
      mCalls += calls;
      mIn += inTok;
      mCache += cacheTok;
      mOut += outTok;
      mTot += totTok;
      mCost += cost;
      const rawSpeedTok = Number(m.speedSummary?.tokens);
      const rawSpeedSec = Number(m.speedSummary?.seconds);
      if (
        Number.isFinite(rawSpeedTok) &&
        Number.isFinite(rawSpeedSec) &&
        rawSpeedSec > 0 &&
        rawSpeedTok >= 0
      ) {
        tpsTokSum += rawSpeedTok;
        tpsSecSum += rawSpeedSec;
      } else if (tps != null) {
        const fallbackTok = outTok > 0 ? outTok : Math.max(1, calls);
        tpsTokSum += fallbackTok;
        tpsSecSum += fallbackTok / tps;
      }
      return [
        idx + 1,
        m.displayText || m.label || m.shortName || '—',
        calls,
        inTok,
        cacheTok,
        outTok,
        totTok,
        computeCacheHitRatio(inTok, cacheTok, m.cacheHitPct),
        tps,
        cost,
      ];
    });
    modelRows.push({
      tone: 'summary',
      values: [
        '',
        tr('report.total'),
        mCalls,
        mIn,
        mCache,
        mOut,
        mTot,
        computeCacheHitRatio(mIn, mCache),
        tpsSecSum > 0 ? +(tpsTokSum / tpsSecSum).toFixed(1) : null,
        mCost,
      ],
    });
    sheets.push({
      name: tr('report.sheetModels'),
      columns: [
        { header: tr('report.colRank'), type: 'center', minWidth: 8 },
        { header: tr('report.colModel'), type: 'text', minWidth: 20, maxWidth: 42 },
        { header: tr('report.colCalls'), type: 'int', minWidth: 11 },
        { header: tr('report.colFreshInput'), type: 'int', minWidth: 14 },
        { header: tr('report.colCacheRead'), type: 'int', minWidth: 15 },
        { header: tr('report.colOutputShort'), type: 'int', minWidth: 13 },
        { header: tr('report.colTotalTokens'), type: 'int', minWidth: 15 },
        { header: tr('report.colCacheHitPct'), type: 'pct', minWidth: 13 },
        { header: tr('report.colAvgSpeed'), type: 'dec1', minWidth: 17 },
        { header: tr('report.colEstCostUsd'), type: 'usd2', minWidth: 16 },
      ],
      rows: modelRows,
    });
  }

  // Sheet 3: Projects
  if (workspaces.length > 0) {
    let wSess = 0;
    let wCalls = 0;
    let wIn = 0;
    let wCache = 0;
    let wOut = 0;
    let wTot = 0;
    let wCost = 0;
    const wsRows = workspaces.map((w, idx) => {
      const sess = Math.max(0, Number(w.sessionCount || 0));
      const calls = Math.max(0, Number(w.calls || 0));
      const inTok = Math.max(0, Number(w.inputTokens || 0));
      const cacheTok = Math.max(0, Number(w.cacheReadTokens || 0));
      const outTok =
        w.outputTokens != null
          ? Math.max(0, Number(w.outputTokens))
          : Math.max(0, Number(w.responseTokens || 0)) + Math.max(0, Number(w.thinkingTokens || 0));
      const totTok = Math.max(0, Number(w.totalTokens ?? inTok + cacheTok + outTok));
      const cost = Math.max(0, Number(w.costUsd || 0));
      wSess += sess;
      wCalls += calls;
      wIn += inTok;
      wCache += cacheTok;
      wOut += outTok;
      wTot += totTok;
      wCost += cost;
      return [
        idx + 1,
        w.label || w.workspacePath || tr('report.unbound'),
        w.workspacePath || '',
        sess,
        calls,
        inTok,
        cacheTok,
        outTok,
        totTok,
        computeCacheHitRatio(inTok, cacheTok, w.cacheHitPct),
        cost,
      ];
    });
    wsRows.push({
      tone: 'summary',
      values: [
        '',
        tr('report.total'),
        '',
        wSess,
        wCalls,
        wIn,
        wCache,
        wOut,
        wTot,
        computeCacheHitRatio(wIn, wCache),
        wCost,
      ],
    });
    sheets.push({
      name: tr('report.sheetProjects'),
      columns: [
        { header: tr('report.colRank'), type: 'center', minWidth: 8 },
        { header: tr('report.colProject'), type: 'text', minWidth: 18, maxWidth: 36 },
        { header: tr('report.colWorkspacePath'), type: 'text', minWidth: 22, maxWidth: 52 },
        { header: tr('report.colSessions'), type: 'int', minWidth: 10 },
        { header: tr('report.colCalls'), type: 'int', minWidth: 11 },
        { header: tr('report.colFreshInput'), type: 'int', minWidth: 14 },
        { header: tr('report.colCacheRead'), type: 'int', minWidth: 15 },
        { header: tr('report.colOutputShort'), type: 'int', minWidth: 13 },
        { header: tr('report.colTotalTokens'), type: 'int', minWidth: 15 },
        { header: tr('report.colCacheHitPct'), type: 'pct', minWidth: 13 },
        { header: tr('report.colEstCostUsd'), type: 'usd2', minWidth: 16 },
      ],
      rows: wsRows,
    });
  }

  // Sheet 4: Sessions
  if (sessions.length > 0) {
    let sCalls = 0;
    let sIn = 0;
    let sCache = 0;
    let sOut = 0;
    let sTot = 0;
    let sCost = 0;
    const sessRows = sessions.map((c, idx) => {
      const calls = Math.max(0, Number(c.calls || 0));
      const inTok = Math.max(0, Number(c.inputTokens || 0));
      const cacheTok = Math.max(0, Number(c.cacheReadTokens || 0));
      const outTok =
        c.outputTokens != null
          ? Math.max(0, Number(c.outputTokens))
          : Math.max(0, Number(c.responseTokens || 0)) + Math.max(0, Number(c.thinkingTokens || 0));
      const totTok = Math.max(0, Number(c.totalTokens ?? inTok + cacheTok + outTok));
      const cost = Math.max(0, Number(c.costUsd || 0));
      sCalls += calls;
      sIn += inTok;
      sCache += cacheTok;
      sOut += outTok;
      sTot += totTok;
      sCost += cost;
      return [
        idx + 1,
        c.title || c.cascadeId || '—',
        c.sourceName || c.appSource || '',
        calls,
        inTok,
        cacheTok,
        outTok,
        totTok,
        computeCacheHitRatio(inTok, cacheTok, c.cacheHitPct),
        cost,
      ];
    });
    sessRows.push({
      tone: 'summary',
      values: [
        '',
        tr('report.total'),
        '',
        sCalls,
        sIn,
        sCache,
        sOut,
        sTot,
        computeCacheHitRatio(sIn, sCache),
        sCost,
      ],
    });
    sheets.push({
      name: tr('report.sheetSessions'),
      columns: [
        { header: tr('report.colRank'), type: 'center', minWidth: 8 },
        { header: tr('report.colSessionTitle'), type: 'text', minWidth: 24, maxWidth: 48 },
        { header: tr('report.colClientSource'), type: 'text', minWidth: 16 },
        { header: tr('report.colCalls'), type: 'int', minWidth: 11 },
        { header: tr('report.colFreshInput'), type: 'int', minWidth: 14 },
        { header: tr('report.colCacheRead'), type: 'int', minWidth: 15 },
        { header: tr('report.colOutputShort'), type: 'int', minWidth: 13 },
        { header: tr('report.colTotalTokens'), type: 'int', minWidth: 15 },
        { header: tr('report.colCacheHitPct'), type: 'pct', minWidth: 13 },
        { header: tr('report.colEstCostUsd'), type: 'usd2', minWidth: 16 },
      ],
      rows: sessRows,
    });
  }

  // Sheet 5: Trend
  if (trend.length > 0) {
    let tCalls = 0;
    let tIn = 0;
    let tCache = 0;
    let tOut = 0;
    let tTot = 0;
    let tCost = 0;
    const trendRows = trend.map((slot) => {
      const isMinute = slot.granularity === 'minute';
      const isHourly =
        isMinute ||
        slot.granularity === 'hour' ||
        String(slot.label || '').includes(':');
      const calls = Math.max(0, Number(slot.calls || 0));
      const inTok = Math.max(0, Number(slot.inputTokens || 0));
      const cacheTok = Math.max(0, Number(slot.cacheReadTokens || 0));
      const outTok = Math.max(0, Number(slot.outputTokens || 0));
      const totTok = Math.max(0, Number(slot.tokens ?? inTok + cacheTok + outTok));
      const cost = Math.max(0, Number(slot.costUsd || 0));
      tCalls += calls;
      tIn += inTok;
      tCache += cacheTok;
      tOut += outTok;
      tTot += totTok;
      tCost += cost;
      const stepMins = Math.max(1, Number(slot.stepMinutes) || 5);
      const granLabel = isMinute
        ? tr('report.granMinute', { mins: stepMins })
        : isHourly
          ? tr('report.granHourly')
          : tr('report.granDaily');
      return [
        formatTrendWindowLabel(slot, isHourly),
        granLabel,
        calls,
        inTok,
        cacheTok,
        outTok,
        totTok,
        cost,
      ];
    });
    trendRows.push({
      tone: 'summary',
      values: [tr('report.total'), '', tCalls, tIn, tCache, tOut, tTot, tCost],
    });
    sheets.push({
      name: tr('report.sheetTrend'),
      columns: [
        { header: tr('report.colTimeWindow'), type: 'text', minWidth: 19 },
        { header: tr('report.colGranularity'), type: 'center', minWidth: 11 },
        { header: tr('report.colCalls'), type: 'int', minWidth: 11 },
        { header: tr('report.colFreshInput'), type: 'int', minWidth: 14 },
        { header: tr('report.colCacheRead'), type: 'int', minWidth: 15 },
        { header: tr('report.colOutputShort'), type: 'int', minWidth: 13 },
        { header: tr('report.colTotalTokens'), type: 'int', minWidth: 15 },
        { header: tr('report.colEstCostUsd'), type: 'usd2', minWidth: 16 },
      ],
      rows: trendRows,
    });
  }

  // Sheet 6: Client Sources
  if (sources.length > 0) {
    let srcCalls = 0;
    let srcIn = 0;
    let srcCache = 0;
    let srcOut = 0;
    let srcTot = 0;
    let srcCost = 0;
    const srcRows = sources.map((s) => {
      const calls = Math.max(0, Number(s.calls || 0));
      const inTok = Math.max(0, Number(s.inputTokens || 0));
      const cacheTok = Math.max(0, Number(s.cacheReadTokens || 0));
      const outTok =
        s.outputTokens != null
          ? Math.max(0, Number(s.outputTokens))
          : Math.max(0, Number(s.responseTokens || 0)) + Math.max(0, Number(s.thinkingTokens || 0));
      const totTok = Math.max(0, Number(s.totalTokens ?? inTok + cacheTok + outTok));
      const cost = Math.max(0, Number(s.costUsd || 0));
      srcCalls += calls;
      srcIn += inTok;
      srcCache += cacheTok;
      srcOut += outTok;
      srcTot += totTok;
      srcCost += cost;
      return [
        s.name || '—',
        calls,
        inTok,
        cacheTok,
        outTok,
        totTok,
        computeCacheHitRatio(inTok, cacheTok, s.cacheHitPct),
        cost,
      ];
    });
    srcRows.push({
      tone: 'summary',
      values: [
        tr('report.total'),
        srcCalls,
        srcIn,
        srcCache,
        srcOut,
        srcTot,
        computeCacheHitRatio(srcIn, srcCache),
        srcCost,
      ],
    });
    sheets.push({
      name: tr('report.sheetSources'),
      columns: [
        { header: tr('report.colClientSource'), type: 'text', minWidth: 18 },
        { header: tr('report.colCalls'), type: 'int', minWidth: 11 },
        { header: tr('report.colFreshInput'), type: 'int', minWidth: 14 },
        { header: tr('report.colCacheRead'), type: 'int', minWidth: 15 },
        { header: tr('report.colOutputShort'), type: 'int', minWidth: 13 },
        { header: tr('report.colTotalTokens'), type: 'int', minWidth: 15 },
        { header: tr('report.colCacheHitPct'), type: 'pct', minWidth: 13 },
        { header: tr('report.colEstCostUsd'), type: 'usd2', minWidth: 16 },
      ],
      rows: srcRows,
    });
  }

  return buildXlsxWorkbookBytes(sheets);
}

/**
 * 生成历史用量统计当前区间的多语言 Markdown 汇总报告。
 *
 * @param {object} consumption
 * @param {Array<object>} modelBreakdown
 * @param {{ displaySettings?: object, locale?: string }} [opts]
 * @returns {string}
 */
export function buildConsumptionMarkdownReport(
  consumption,
  modelBreakdown = [],
  { displaySettings = {}, locale } = {}
) {
  const exportLocale = resolveExportLocale(locale);
  const tr = (key, vars) => tForLocale(exportLocale, key, vars);
  const cons = consumption || {};
  const acc = cons.account || {};
  const range = cons.selectedRange || {};
  const models = mergeModelsByDisplayName(modelBreakdown || [], displaySettings, {
    preferLabelInShort: true,
    locale: exportLocale,
  });
  const workspaces = Array.isArray(cons.topWorkspaces) ? cons.topWorkspaces : [];
  const sessions = Array.isArray(cons.topConversations) ? cons.topConversations : [];

  const rangeLabel = resolveLocalizedRangeLabel(range, exportLocale);
  const lines = [
    tr('report.mdUsageTitle', { range: rangeLabel }),
    '',
    tr('report.mdUsageTokensLine', {
      total: formatTokensPrecise(acc.totalTokens || 0),
      calls: Number(acc.calls || 0),
    }),
    tr('report.mdUsageCostLine', {
      cost: formatUsd(acc.costUsd || 0),
      saved: formatUsd(acc.savedCostUsd || 0),
    }),
    tr('report.mdUsageCacheLine', {
      pct: formatPctNumber(acc.cacheHitPct || 0, { withSymbol: true }),
      inTok: formatTokensPrecise(acc.inputTokens || 0),
      cacheTok: formatTokensPrecise(acc.cacheReadTokens || 0),
      outTok: formatTokensPrecise(acc.outputTokens || 0),
    }),
  ];

  if (models.length > 0) {
    lines.push(
      '',
      tr('report.mdModelsTitle'),
      '',
      tr('report.mdHeaderUsageModel'),
      '| --- | ---: | ---: | ---: | ---: | ---: |'
    );
    for (const m of models) {
      lines.push(
        `| ${escapeMdCell(m.displayText || m.label || m.shortName)} | ${Number(m.calls || 0)} | ${formatTokensPrecise(m.totalTokens || 0)} | ${formatPctNumber(m.cacheHitPct || 0, { withSymbol: true })} | ${m.avgTokPerSec != null ? formatSpeedMetric(m.avgTokPerSec, ' tok/s') : '—'} | ${formatUsd(m.costUsd || 0)} |`
      );
    }
  }

  if (workspaces.length > 0) {
    lines.push(
      '',
      tr('report.mdProjectsTitle'),
      '',
      tr('report.mdHeaderProjects'),
      '| --- | ---: | ---: | ---: | ---: | ---: |'
    );
    for (const w of workspaces) {
      lines.push(
        `| ${escapeMdCell(w.label || w.workspacePath || tr('report.unbound'))} | ${Number(w.sessionCount || 0)} | ${Number(w.calls || 0)} | ${formatTokensPrecise(w.totalTokens || 0)} | ${formatPctNumber(w.cacheHitPct || 0, { withSymbol: true })} | ${formatUsd(w.costUsd || 0)} |`
      );
    }
  }

  if (sessions.length > 0) {
    lines.push(
      '',
      tr('report.mdTopSessionsTitle'),
      '',
      tr('report.mdHeaderSessions'),
      '| --- | ---: | ---: | ---: | ---: |'
    );
    for (const c of sessions.slice(0, 8)) {
      lines.push(
        `| ${escapeMdCell(c.title || c.cascadeId)} | ${Number(c.calls || 0)} | ${formatTokensPrecise(c.totalTokens || 0)} | ${formatPctNumber(c.cacheHitPct || 0, { withSymbol: true })} | ${formatUsd(c.costUsd || 0)} |`
      );
    }
  }

  return `${lines.join('\n')}\n`;
}
