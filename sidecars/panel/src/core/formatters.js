/**
 * @fileoverview Pure formatting utilities for speed metrics, token counts,
 * USD estimates, countdown timers, and custom datetime displays.
 */

import { getEffectiveLocale, t, tForLocale } from '../i18n/index.js';
import {
  normalizeModelDisplayMode,
  resolveLocaleFromLanguageTag,
} from '../../shared/settings-normalization.mjs';
import {
  DEFAULT_DISPLAY_CURRENCY,
  formatConvertedApprox,
  formatFxRateValue,
  resolveCurrencyRateInfo,
  resolveEffectiveCurrency,
} from '../../shared/currency-catalog.mjs';
import {
  classifyCacheTier,
  classifySpeedTier,
  classifyStepCostTier,
  classifyTtftTier,
  formatCompactTokens,
} from '../../shared/telemetry-display-rules.mjs';

const LOCALE_MONTH_SHORT = Object.freeze({
  'en-US': Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']),
  'de-DE': Object.freeze(['Jan.', 'Feb.', 'Mär.', 'Apr.', 'Mai', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Okt.', 'Nov.', 'Dez.']),
  'fr-FR': Object.freeze(['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']),
});

const LOCALE_WEEKDAY_SHORT = Object.freeze({
  'zh-CN': Object.freeze(['周日', '周一', '周二', '周三', '周四', '周五', '周六']),
  'zh-TW': Object.freeze(['週日', '週一', '週二', '週三', '週四', '週五', '週六']),
  'en-US': Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']),
  'ja-JP': Object.freeze(['日', '月', '火', '水', '木', '金', '土']),
  'ko-KR': Object.freeze(['일', '월', '화', '수', '목', '금', '토']),
  'de-DE': Object.freeze(['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']),
  'fr-FR': Object.freeze(['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.']),
});

const MAX_INTL_LOCALE_CACHE = 64;
const INTL_SHORT_MONTHS_CACHE = new Map();
const INTL_SHORT_WEEKDAYS_CACHE = new Map();

function getLocaleShortMonths(locale) {
  if (LOCALE_MONTH_SHORT[locale]) return LOCALE_MONTH_SHORT[locale];
  if (INTL_SHORT_MONTHS_CACHE.has(locale)) return INTL_SHORT_MONTHS_CACHE.get(locale);
  let resolved = LOCALE_MONTH_SHORT['en-US'];
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function') {
      const fmt = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
      const list = Array.from({ length: 12 }, (_, m) => fmt.format(new Date(Date.UTC(2024, m, 15))));
      if (list.every((s) => typeof s === 'string' && s.trim().length > 0)) {
        resolved = Object.freeze(list);
      }
    }
  } catch {
    // Fallback to en-US short months if Intl lacks locale data
  }
  if (INTL_SHORT_MONTHS_CACHE.size < MAX_INTL_LOCALE_CACHE) {
    INTL_SHORT_MONTHS_CACHE.set(locale, resolved);
  }
  return resolved;
}

function getLocaleShortWeekdays(locale) {
  if (LOCALE_WEEKDAY_SHORT[locale]) return LOCALE_WEEKDAY_SHORT[locale];
  if (INTL_SHORT_WEEKDAYS_CACHE.has(locale)) return INTL_SHORT_WEEKDAYS_CACHE.get(locale);
  let resolved = LOCALE_WEEKDAY_SHORT['en-US'];
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function') {
      const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
      // 2024-01-07 is Sunday in UTC
      const list = Array.from({ length: 7 }, (_, d) => fmt.format(new Date(Date.UTC(2024, 0, 7 + d))));
      if (list.every((s) => typeof s === 'string' && s.trim().length > 0)) {
        resolved = Object.freeze(list);
      }
    }
  } catch {
    // Fallback to en-US short weekdays if Intl lacks locale data
  }
  if (INTL_SHORT_WEEKDAYS_CACHE.size < MAX_INTL_LOCALE_CACHE) {
    INTL_SHORT_WEEKDAYS_CACHE.set(locale, resolved);
  }
  return resolved;
}

export function formatShortMonthName(monthIndex, locale, { stripTrailingDot = false } = {}) {
  const loc = resolveFormatterLocale(locale);
  const raw = getLocaleShortMonths(loc)[monthIndex] || '';
  return stripTrailingDot ? raw.replace(/\.$/, '') : raw;
}

export function formatShortWeekdayName(dayIndex, locale) {
  const loc = resolveFormatterLocale(locale);
  return getLocaleShortWeekdays(loc)[dayIndex] || '';
}

function resolveFormatterLocale(explicitLocale) {
  if (typeof explicitLocale === 'string' && explicitLocale.trim()) {
    return resolveLocaleFromLanguageTag(explicitLocale, getEffectiveLocale());
  }
  return getEffectiveLocale();
}

export function formatMetric(value, unit = '') {
  if (!Number.isFinite(value)) return '—';
  const numStr = Math.abs(value) >= 100 ? String(Math.round(value)) : value.toFixed(1);
  return `${numStr}${unit}`;
}

export function formatSpeedMetric(value, unit = ' tok/s') {
  return formatMetric(value, unit);
}

export function formatCachePct(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const num = Math.max(0, Math.min(100, +Number(value).toFixed(1)));
  return `${num}%`;
}

/**
 * 格式化百分比数值文本：常规值保留 1 位小数，将边界值 `0.0` / `100.0` 收口为整数 `0` / `100`。
 *
 * @param {number|string|null|undefined} value
 * @param {{ withSymbol?: boolean }} [options]
 * @returns {string}
 */
export function formatPctNumber(value, { withSymbol = false } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return withSymbol ? '0%' : '0';
  const rounded = Math.round(num * 10) / 10;
  const str =
    Math.abs(rounded) < 1e-9
      ? '0'
      : Math.abs(rounded - 100) < 1e-9
        ? '100'
        : rounded.toFixed(1);
  return withSymbol ? `${str}%` : str;
}

export function getSpeedToneClass(tokPerSec) {
  return `tone-${classifySpeedTier(tokPerSec)}`;
}

export function getCacheToneClass(cacheHitPct, promptTokens = null) {
  return `tone-${classifyCacheTier(cacheHitPct, promptTokens)}`;
}

export function getStepCostToneClass(costUsd) {
  const tier = classifyStepCostTier(costUsd);
  return tier ? `tone-${tier}` : '';
}

export function getTtftToneClass(ttftSec) {
  const tier = classifyTtftTier(ttftSec);
  return tier === 'warn' || tier === 'danger' ? `tone-${tier}` : '';
}

export const formatTokens = formatCompactTokens;

export function formatTokensPrecise(num) {
  const n = Number(num || 0);
  if (n <= 0) return '0';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatCnyApprox(usdAmount, rate = 7.2) {
  return formatConvertedApprox(usdAmount, {
    displayCurrency: 'CNY',
    rateOverride: rate,
  });
}

/**
 * 按当前设置（或 `'auto'` 随语言映射）及实时/兜底汇率，格式化 USD 旁边的参考货币近似值。
 * 生效货币为 `USD` 时返回 `''`（由调用方隐藏副标签）。
 */
export function formatSecondaryCostApprox(
  usdAmount,
  { displayCurrency = DEFAULT_DISPLAY_CURRENCY, locale, fxStatus = null } = {}
) {
  return formatConvertedApprox(usdAmount, {
    displayCurrency,
    locale: resolveFormatterLocale(locale),
    fxStatus,
  });
}

/**
 * 格式化当前生效参考货币的汇率与来源说明（供「常规设置」提示行与「用量」副标 tooltip 复用）。
 */
export function formatFxRateCaption({
  displayCurrency = DEFAULT_DISPLAY_CURRENCY,
  locale,
  fxStatus = null,
} = {}) {
  const loc = resolveFormatterLocale(locale);
  const code = resolveEffectiveCurrency(displayCurrency, loc);
  if (code === 'USD') {
    return tForLocale(loc, 'settings.gen.currencyUsdOnlyHint');
  }
  const info = resolveCurrencyRateInfo(code, fxStatus);
  const rateText = formatFxRateValue(info.rate, info.zeroDecimal);
  const sourceLabel =
    info.source === 'frankfurter'
      ? 'Frankfurter'
      : info.source === 'er-api'
        ? 'ExchangeRate-API'
        : info.source === 'mixed'
          ? 'Frankfurter / ER-API'
          : tForLocale(loc, 'settings.gen.currencySrcBuiltin');
  const meta = info.date ? `${sourceLabel} · ${info.date}` : sourceLabel;
  return tForLocale(loc, 'settings.gen.currencyRateMeta', {
    rate: rateText,
    code: info.code,
    meta,
  });
}

function formatLocalizedDayDate(dateObj, locale, includeYear) {
  const y = dateObj.getFullYear();
  const m = dateObj.getMonth() + 1;
  const d = dateObj.getDate();
  if (locale === 'zh-CN' || locale === 'zh-TW' || locale === 'ja-JP') {
    return includeYear ? `${y}年${m}月${d}日` : `${m}月${d}日`;
  }
  if (locale === 'ko-KR') {
    return includeYear ? `${y}년 ${m}월 ${d}일` : `${m}월 ${d}일`;
  }
  const mon = formatShortMonthName(dateObj.getMonth(), locale);
  if (locale === 'de-DE') {
    return includeYear ? `${d}. ${mon} ${y}` : `${d}. ${mon}`;
  }
  if (locale === 'fr-FR') {
    return includeYear ? `${d} ${mon} ${y}` : `${d} ${mon}`;
  }
  return includeYear ? `${mon} ${d}, ${y}` : `${mon} ${d}`;
}

export function formatDateSpanBadge(startMs, endMs, { locale } = {}) {
  const s = startMs && Number.isFinite(startMs) ? new Date(startMs) : new Date();
  const e = endMs && Number.isFinite(endMs) ? new Date(endMs) : new Date();
  const loc = resolveFormatterLocale(locale);
  const sameYear = s.getFullYear() === e.getFullYear();
  const sameMonth = sameYear && s.getMonth() === e.getMonth();
  const sameDay = sameMonth && s.getDate() === e.getDate();

  if (!sameYear) {
    return `${formatLocalizedDayDate(s, loc, true)} ~ ${formatLocalizedDayDate(e, loc, true)}`;
  }
  if (sameDay) {
    return formatLocalizedDayDate(s, loc, false);
  }
  if (sameMonth) {
    if (loc === 'zh-CN' || loc === 'zh-TW' || loc === 'ja-JP') {
      return `${s.getMonth() + 1}月${s.getDate()}日 ~ ${e.getDate()}日`;
    }
    if (loc === 'ko-KR') {
      return `${s.getMonth() + 1}월 ${s.getDate()}일 ~ ${e.getDate()}일`;
    }
    if (loc === 'en-US') {
      const sMon = LOCALE_MONTH_SHORT['en-US'][s.getMonth()] || '';
      return `${sMon} ${s.getDate()} ~ ${e.getDate()}`;
    }
  }
  return `${formatLocalizedDayDate(s, loc, false)} ~ ${formatLocalizedDayDate(e, loc, false)}`;
}

export function formatTrendSlotFullLabel(slot, { locale, showFullYear = false } = {}) {
  const loc = resolveFormatterLocale(locale);
  const isZhCn = loc === 'zh-CN';
  const sMs = Number(slot?.startMs);
  if (Number.isFinite(sMs) && sMs > 0) {
    const sd = new Date(sMs);
    const pad2 = (n) => String(n).padStart(2, '0');
    const rawFull = String(slot?.fullLabel || '');
    const includeYear = Boolean(
      showFullYear || /^\d{4}年/.test(rawFull) || sd.getFullYear() !== new Date().getFullYear()
    );
    const gran = String(slot?.granularity || '').toLowerCase();
    const isSubDay =
      gran === 'minute' ||
      gran === 'hour' ||
      (!gran && Number(slot?.endMs) > sMs && Number(slot.endMs) - sMs <= 3600_000 * 2);

    const datePart = formatLocalizedDayDate(sd, loc, includeYear);
    if (isSubDay) {
      const eMs = Number(slot?.endMs);
      const ed = Number.isFinite(eMs) && eMs > 0 ? new Date(eMs) : new Date(sMs + 3600_000);
      const hh = `${pad2(sd.getHours())}:${pad2(sd.getMinutes())}`;
      const endHh = `${pad2(ed.getHours())}:${pad2(ed.getMinutes())}`;
      const sep = loc === 'en-US' ? ', ' : ' ';
      return `${datePart}${sep}${hh} - ${endHh}`;
    }

    const wday = formatShortWeekdayName(sd.getDay(), loc);
    return `${datePart} (${wday})`;
  }

  const rawFull = String(slot?.fullLabel || '').trim();
  const rawShort = String(slot?.label || '').trim();
  if (!isZhCn && rawFull && /[\u4e00-\u9fff]/.test(rawFull)) {
    return rawShort || rawFull;
  }
  return rawFull || rawShort;
}

export function formatUsd(amount, { precise = false } = {}) {
  if (amount == null || !Number.isFinite(Number(amount))) return t('fmt.pending');
  const val = Number(amount || 0);
  if (precise) {
    if (val > 0 && val < 0.001) return '<$0.001';
    return val >= 1 ? `$${val.toFixed(2)}` : `$${val.toFixed(3)}`;
  }
  return `$${val.toFixed(2)}`;
}

const SPEED_REASON_LABELS = {
  __proto__: null,
  incomplete_or_invalid_timing: 'fmt.speedIncomplete',
  canceled: 'fmt.speedCanceled',
  error: 'fmt.speedError',
  interrupted: 'fmt.speedInterrupted',
  compaction_timing_unavailable: 'fmt.speedCompactionTimingUnavailable',
  invalid_output_tokens: 'fmt.speedInvalidOutput',
  inconsistent_timing: 'fmt.speedInconsistent',
  short_timing: 'fmt.speedShort',
  legacy_cache: 'fmt.speedLegacy',
};

export function speedReasonText(reason) {
  const label = SPEED_REASON_LABELS[reason];
  return label ? t(label) : '';
}

const ANOMALY_KIND_ORDER = Object.freeze([
  'rate_limit',
  'timeout',
  'capacity',
  'disconnect',
  'upstream',
  'model_output',
  'safety',
  'auth_or_model',
  'error',
]);

export function formatAnomalyKindLabel(kind) {
  const k = String(kind || 'error');
  const key = `steps.anomalyKind.${k}`;
  const text = t(key);
  return text === key ? t('steps.anomalyKind.error') : text;
}

export function formatAnomalyTagText(primaryKind, count = 1) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  const k = String(primaryKind || 'error');
  if (k === 'capacity' && n === 1) return t('steps.anomalyTag.capacitySingle');
  if (k === 'upstream' && n === 1) return t('steps.anomalyTag.upstreamSingle');
  const key = `steps.anomalyTag.${k}`;
  const formatted = t(key, { n });
  return formatted === key ? t('steps.anomalyTag.error', { n }) : formatted;
}

export function resolveModelAnomalySummary(m) {
  const count = Math.max(0, Number(m?.anomalyCount || 0));
  const steps = Math.max(0, Number(m?.anomalySteps || 0));
  if (count <= 0 && steps <= 0) return null;
  const byKind = m?.anomalyByKind && typeof m.anomalyByKind === 'object' ? m.anomalyByKind : {};
  const entries = Object.entries(byKind)
    .map(([k, v]) => [k, Math.max(0, Number(v || 0))])
    .filter(([, v]) => v > 0)
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const pa = ANOMALY_KIND_ORDER.indexOf(a[0]);
      const pb = ANOMALY_KIND_ORDER.indexOf(b[0]);
      return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb);
    });
  const totalCount = count || entries.reduce((sum, [, v]) => sum + v, 0) || steps;
  const primaryKind = entries.length === 1 ? entries[0][0] : entries.length > 1 ? 'mixed' : 'error';
  const severity =
    Number(m?.anomalyDangerCount || 0) > 0 ||
    entries.some(([k]) => k === 'rate_limit' || k === 'auth_or_model')
      ? 'danger'
      : 'warn';
  return {
    count: totalCount,
    steps: steps || totalCount,
    totalDelaySec: Math.max(0, Number(m?.anomalyTotalDelaySec || 0)),
    primaryKind,
    severity,
    entries,
    tagText: formatAnomalyTagText(primaryKind, totalCount),
  };
}

export function formatStepAnomalyInlineSummary(anomaly) {
  if (!anomaly || !(Number(anomaly.count) > 0)) return '';
  const tag = formatAnomalyTagText(anomaly.primaryKind, anomaly.count);
  const label = formatAnomalyKindLabel(anomaly.primaryKind);
  const delaySec = Number(anomaly.totalDelaySec || 0);
  const delayPart = delaySec > 0 ? ` · ${t('steps.anomalyDelayPart', { sec: delaySec })}` : '';
  return `${tag} · ${label}${delayPart}`;
}

export function buildStepAnomalyDiagnostic(st) {
  const a = st?.anomaly;
  if (!a || !(Number(a.count) > 0)) return null;
  const title = t('steps.anomalyStepTitle', {
    step: Number(st.stepIndex ?? 0),
    count: Number(a.count),
  });
  const delaySec = Number(a.totalDelaySec || 0);
  const sub = delaySec > 0 ? t('steps.anomalyDelayPart', { sec: delaySec }) : '';
  const events = Array.isArray(a.events) ? a.events : [];
  const rows = events.map((ev, idx) => {
    const label = formatAnomalyKindLabel(ev.kind);
    const parts = [`#${ev.attempt || idx + 1} ${label}`];
    if (Number(ev.delaySec) > 0) {
      parts.push(t('steps.anomalyDelayPart', { sec: ev.delaySec }));
    }
    if (ev.terminal) {
      parts.push(t('steps.anomalyTerminalTag'));
    }
    return {
      text: parts.join(' · '),
      detail: ev.message || '',
      danger: Boolean(ev.terminal || ev.kind === 'rate_limit' || ev.kind === 'auth_or_model'),
    };
  });
  return {
    title,
    sub,
    rows,
    hint: '',
    severity: a.severity === 'danger' ? 'danger' : 'warn',
  };
}

export function buildStepCompactionDiagnostic(st, displaySettings = {}) {
  if (!st || typeof st !== 'object') return null;
  const disp = resolveModelDisplayInfo(st, displaySettings, { fallback: '' });
  const promptTok =
    Math.max(0, Number(st.inputTokens || 0)) + Math.max(0, Number(st.cacheReadTokens || 0));
  const outTok = Math.max(0, Number(st.outputTokens || 0));
  const title = t('steps.compactionStepTitle', { step: Number(st.stepIndex ?? 0) });
  const rows =
    promptTok > 0 || outTok > 0
      ? [
          {
            text: t('steps.compactionSummaryRow', {
              input: formatTokens(promptTok),
              output: formatTokens(outTok),
            }),
            detail: t('steps.compactionDetailHint'),
            mono: false,
            danger: false,
          },
        ]
      : [
          {
            text: t('steps.compactionDetailHint'),
            detail: '',
            danger: false,
          },
        ];
  return {
    title,
    sub: disp.baseText || '',
    rows,
    hint: '',
    severity: 'compaction',
  };
}

export function buildStepRevertedDiagnostic(st, displaySettings = {}) {
  if (!st || typeof st !== 'object') return null;
  const disp = resolveModelDisplayInfo(st, displaySettings, { fallback: '' });
  return {
    title: t('steps.revertedStepTitle', { step: Number(st.stepIndex ?? 0) }),
    sub: disp.baseText || '',
    rows: [
      {
        text: t('steps.revertedDetailHint'),
        detail: '',
        mono: false,
        danger: false,
      },
    ],
    hint: '',
    severity: 'reverted',
  };
}

function finiteNonNegativeSec(val) {
  if (val === null || val === undefined || val === '') return null;
  const num = Number(val);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

export function formatTimingDetailSec(sec) {
  const num = finiteNonNegativeSec(sec);
  if (num === null) return '—';
  if (num > 0 && num < 0.01) return '<0.01s';
  if (num >= 10) return `${num.toFixed(1)}s`;
  return `${num.toFixed(2)}s`;
}

export function hasStepTimingData(st) {
  if (!st || typeof st !== 'object') return false;
  return (
    finiteNonNegativeSec(st.nativeTtftSec ?? st.ttftSec) !== null ||
    finiteNonNegativeSec(st.totalDurationSec ?? st.streamDurationSec) !== null ||
    finiteNonNegativeSec(st.nativeStreamSec) !== null ||
    finiteNonNegativeSec(st.thinkingDurationSec) !== null
  );
}

export function buildStepTimingDiagnostic(st) {
  if (!st || typeof st !== 'object') return null;
  const ttft = finiteNonNegativeSec(st.nativeTtftSec ?? st.ttftSec);
  const total = finiteNonNegativeSec(st.totalDurationSec ?? st.streamDurationSec);
  const nativeStream = finiteNonNegativeSec(st.nativeStreamSec);
  const think = finiteNonNegativeSec(st.thinkingDurationSec);
  if (ttft === null && total === null && nativeStream === null && think === null) {
    return null;
  }

  const afterTtft =
    nativeStream === null && total !== null && ttft !== null && total >= ttft
      ? +(total - ttft).toFixed(6)
      : null;

  const rows = [];
  if (ttft !== null) {
    let valText = formatTimingDetailSec(ttft);
    if (total !== null && total > 0 && ttft <= total + 0.01) {
      const pct = Math.min(100, Math.max(0, Math.round((ttft / total) * 100)));
      valText = `${valText} (${pct}%)`;
    }
    rows.push({
      text: t('steps.timingTtftLabel'),
      value: valText,
      toneClass: getTtftToneClass(ttft),
    });
  }
  if (nativeStream !== null) {
    rows.push({
      text: t('steps.timingStreamLabel'),
      value: formatTimingDetailSec(nativeStream),
    });
  } else if (afterTtft !== null) {
    rows.push({
      text: t('steps.timingAfterTtftLabel'),
      value: formatTimingDetailSec(afterTtft),
    });
  }
  if (think !== null) {
    rows.push({
      text: t('steps.timingThinkLabel'),
      value: formatTimingDetailSec(think),
    });
  }

  const showTotalInSub = total !== null && rows.length > 0;
  if (total !== null && !showTotalInSub) {
    rows.push({
      text: t('steps.timingTotalLabel'),
      value: formatTimingDetailSec(total),
    });
  }

  const hints = [];
  const streamForToolCheck = nativeStream ?? afterTtft;
  if (
    st.hasToolCalls &&
    streamForToolCheck !== null &&
    streamForToolCheck < 0.5 &&
    ttft !== null &&
    ttft >= 2
  ) {
    hints.push(t('steps.timingToolBufferedHint'));
  }
  const anomalyCount = Math.max(0, Number(st.anomaly?.count || 0));
  if (anomalyCount > 0) {
    const delaySec = Number(st.anomaly?.totalDelaySec || 0);
    hints.push(
      delaySec > 0
        ? t('steps.timingAnomalyDelayHint', { count: anomalyCount, sec: delaySec })
        : t('steps.timingAnomalyHint', { count: anomalyCount })
    );
  }

  return {
    title: t('steps.timingStepTitle', { step: Number(st.stepIndex ?? 0) }),
    sub: showTotalInSub ? t('steps.timingTotalSub', { sec: formatTimingDetailSec(total) }) : '',
    rows,
    hint: hints.join(' · '),
    severity: 'timing',
  };
}

export function buildModelAnomalyDiagnostic(m) {
  const sum = resolveModelAnomalySummary(m);
  if (!sum) return null;
  const title = t('steps.anomalyModelTitle', {
    model: m?.displayText || m?.shortName || m?.label || '—',
    count: sum.count,
  });
  const subParts = [t('steps.anomalyModelSub', { steps: sum.steps })];
  if (sum.totalDelaySec > 0) {
    subParts.push(t('steps.anomalyDelayPart', { sec: sum.totalDelaySec }));
  }
  const rows = sum.entries.map(([k, v]) => ({
    text: t('steps.anomalyModelKindRow', { kind: formatAnomalyKindLabel(k), count: v }),
    detail: '',
    danger: k === 'rate_limit' || k === 'auth_or_model',
  }));
  return {
    title,
    sub: subParts.join(' · '),
    rows,
    hint: t('steps.anomalyModelClickHint'),
    severity: sum.severity,
  };
}

export function sampleSummary(summary) {
  const valid = summary?.sampleCount || 0;
  const excluded = summary?.excludedCount || 0;
  return t('fmt.sampleSteps', { valid, total: valid + excluded });
}

export function formatCountdown(isoTime, nowMs = Date.now()) {
  if (!isoTime) return t('fmt.resetUnknown');
  const targetMs = Date.parse(isoTime);
  if (!Number.isFinite(targetMs) || targetMs <= 0) return t('fmt.resetUnknown');
  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return t('fmt.resetSoon');
  if (diffMs < 60_000) return t('fmt.resetUnder1m');

  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return t('fmt.resetDaysHours', { d: days, h: hours });
  if (hours > 0) return t('fmt.resetHoursMins', { h: hours, m: minutes });
  return t('fmt.resetMins', { m: minutes });
}

export function formatCompactDateTime(ms) {
  if (!ms || !Number.isFinite(ms)) return t('fmt.selectTime');
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatElapsedSec(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) {
    return `${m}m ${String(remS).padStart(2, '0')}s`;
  }
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
}

export { normalizeModelDisplayMode };

/**
 * 隐藏原始模型 ID 开头的 `gemini-`、`claude-`、`gpt-` 厂商前缀以节省单行表格空间（确保剥离后非空）。
 *
 * @param {string} rawText
 * @returns {string}
 */
export function stripVendorModelPrefix(rawText) {
  return String(rawText || '')
    .trim()
    .replace(/^(?:gemini|claude|gpt)-(?=.+)/i, '');
}

function stripCompactionMarker(rawText) {
  return String(rawText || '')
    .replace(/(?:·(?:压缩|compact)|\[自动压缩\]|\[auto[- ]?compact\])\s*$/iu, '')
    .trim();
}

function normalizeOrchVariantToken(raw = '') {
  let s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!s || /^worker(?:$|-)/.test(s)) return '';
  s = s.replace(/([a-z]-)(\d+)-(\d+)(?=$|-)/g, '$1$2.$3');
  s = s
    .replace(/^(?:claude|anthropic|openai)-(?=.+)/, '')
    .replace(/^gemini-(?:4-)?(?=(?:carbon|argon|neon|hydrogen|helix)(?:$|-))/, '');
  return s;
}

function extractOrchWorkerVariant(fields = [], combinedText = '') {
  for (const rawField of fields) {
    const field = String(rawField || '').trim();
    if (!field) continue;
    const parenMatch = field.match(/\bOrchestrator\s+Worker\s*\(\s*([^)]+?)\s*\)/i);
    if (parenMatch) {
      const v = normalizeOrchVariantToken(parenMatch[1]);
      if (v) return v;
    }
    const compactMatch = field.match(/\bworker-agy-([a-z0-9]+(?:[.-][a-z0-9]+)*)(?=·|\s|$)/i);
    if (compactMatch) {
      const v = normalizeOrchVariantToken(compactMatch[1]);
      if (v) return v;
    }
  }
  if (/\bMODEL_PLACEHOLDER_M669\b|\bgemini-flash-worker-agy\b/i.test(combinedText)) {
    return 'hydrogen';
  }
  const upstreamMatch = combinedText.match(/\b([a-z0-9][a-z0-9.-]*?)-worker-agy\b/i);
  if (upstreamMatch) {
    const rawPrefix = upstreamMatch[1].toLowerCase();
    if (rawPrefix === 'gemini-flash') return 'hydrogen';
    if (/^gemini-(?:4-)?neon$/i.test(rawPrefix)) return 'neon';
    if (/^gemini-(?:4-)?argon$/i.test(rawPrefix)) return 'argon';
    if (/^gemini-(?:4-)?carbon$/i.test(rawPrefix)) return 'carbon';
    const v = normalizeOrchVariantToken(rawPrefix);
    if (v && v !== 'gemini-pro') return v;
  }
  if (/\bneon\b/i.test(combinedText)) return 'neon';
  if (/\bhydrogen\b/i.test(combinedText)) return 'hydrogen';
  if (/\bargon\b/i.test(combinedText)) return 'argon';
  if (/\bcarbon\b/i.test(combinedText)) return 'carbon';
  return '';
}

function extractDynamicOrchVariant(fields = []) {
  for (const rawField of fields) {
    const field = String(rawField || '').trim();
    if (!field) continue;
    const parenAfter = field.match(/\bOrchestrator\s*\(\s*([^)]+?)\s*\)/i);
    if (parenAfter) {
      const v = normalizeOrchVariantToken(parenAfter[1]);
      if (v) return v;
    }
    const parenBefore = field.match(
      /^([a-z0-9][a-z0-9.\s-]{0,40}?)\s*\(\s*Orchestrator\s*\)(?:\s*\[[^\]]+\])?$/i
    );
    if (parenBefore) {
      const v = normalizeOrchVariantToken(parenBefore[1]);
      if (v) return v;
    }
    const geminiProSlug = field.match(
      /\bgemini-pro-orchestrator-([a-z0-9]+(?:[.-][a-z0-9]+)*)(?=·|\s|$)/i
    );
    if (geminiProSlug) {
      const v = normalizeOrchVariantToken(geminiProSlug[1]);
      if (v) return v;
    }
    const prefixSlug = field.match(
      /\b(?:orchestrator|orch)-([a-z0-9]+(?:[.-][a-z0-9]+)*)(?=·|\s|$)/i
    );
    if (prefixSlug) {
      const v = normalizeOrchVariantToken(prefixSlug[1]);
      if (v) return v;
    }
    const suffixSlug = field.match(/\b([a-z0-9]+(?:[.-][a-z0-9]+)*)-orchestrator(?=·|\s|$)/i);
    if (suffixSlug && !/^gemini-pro$/i.test(suffixSlug[1])) {
      const v = normalizeOrchVariantToken(suffixSlug[1]);
      if (v) return v;
    }
  }
  return '';
}

/**
 * 统一解析步骤、会话摘要或模型汇总行面向用户的模型显示文本及悬停提示。
 *
 * 规则：
 * - 统一遵循 `modelDisplayMode`（`'short'` | `'upstream_compact'` | `'upstream'`，兼容旧版布尔 `showUpstreamModel`）：
 *   - Orchestrator 系列（如 `Orchestrator (Carbon / Argon / Neon / Opus 5.5)`、`Orchestrator Worker (Hydrogen / Neon / ...)`）
 *     在 `'short'` / `'upstream_compact'` 下显示紧凑代号 `orchestrator-<variant>` / `worker-agy-<variant>`，
 *     在 `'upstream'` 下显示带底层模型标注的完整上游 ID；
 *   - 其余普通模型按所选模式显示精简代号、去前缀上游 ID 或原始上游 ID；
 * - 独立拆分 `baseText` 及 `compactionSuffix`（`·压缩`），供步骤表单独保护压缩尾标永不截断。
 *
 * @param {object|null|undefined} target
 * @param {{ modelDisplayMode?: string, showUpstreamModel?: boolean }|boolean} [settings]
 * @param {{ preferLabelInShort?: boolean, fallback?: string }} [options]
 * @returns {{ text: string, baseText: string, compactionSuffix: string, isCompaction: boolean, title: string, isOrchestratorSeries: boolean }}
 */
export function resolveModelDisplayInfo(target, settings = {}, options = {}) {
  const modelDisplayMode =
    typeof settings === 'boolean'
      ? settings
        ? 'upstream'
        : 'short'
      : normalizeModelDisplayMode(settings?.modelDisplayMode, settings?.showUpstreamModel);
  const showUpstream = modelDisplayMode !== 'short';
  const preferLabelInShort = Boolean(options?.preferLabelInShort);
  const explicitLocale = typeof options?.locale === 'string' && options.locale.trim().length > 0;
  const resolvedLocale = explicitLocale
    ? resolveFormatterLocale(options.locale)
    : getEffectiveLocale();
  const fallback =
    options?.fallback ??
    (explicitLocale ? tForLocale(resolvedLocale, 'fmt.unknownModel') : t('fmt.unknownModel'));

  if (!target || typeof target !== 'object') {
    return {
      text: fallback,
      baseText: fallback,
      compactionSuffix: '',
      isCompaction: false,
      title: fallback,
      isOrchestratorSeries: false,
    };
  }

  const shortText = String(
    target.activeBaseModelShort ??
      target.baseModelShort ??
      target.activeModelShort ??
      target.modelShort ??
      target.shortName ??
      ''
  ).trim();
  const labelText = String(
    target.activeBaseModelLabel ??
      target.baseModelLabel ??
      target.activeModelLabel ??
      target.modelLabel ??
      target.label ??
      ''
  ).trim();
  const upstreamText = String(
    target.baseModelUpstream ??
      target.activeModelUpstream ??
      target.modelUpstream ??
      target.upstreamModel ??
      target.upstreamName ??
      ''
  ).trim();
  const rawCompactionText = `${target.activeModelShort ?? target.modelShort ?? ''} ${target.activeModelLabel ?? target.modelLabel ?? ''} ${target.activeModelUpstream ?? target.modelUpstream ?? ''}`;
  const responseText = String(target.responseModel ?? '').trim();
  const modelKeyText = String(target.modelKey ?? '').trim();

  const isCompaction =
    Boolean(target.isCompactionStep) ||
    /·(?:压缩|壓縮|圧縮|압축|compact|komp\.?|comp\.?)(?=\s|$)|\[自动压缩\]/iu.test(rawCompactionText);

  const compactionSuffix = isCompaction
    ? explicitLocale
      ? tForLocale(resolvedLocale, 'fmt.compactionSuffix')
      : t('fmt.compactionSuffix')
    : '';

  const fields = [labelText, shortText, upstreamText, responseText, modelKeyText];
  const combined = `${modelKeyText} ${shortText} ${labelText} ${upstreamText} ${responseText}`;
  const isOrchWorker =
    /\bMODEL_PLACEHOLDER_M669\b|\b[a-z0-9.-]*worker-agy\b|\bworker-agy-[a-z0-9.-]+\b|\bOrchestrator\s+Worker\b/i.test(
      combined
    );
  const isKnownOrchCarbonPh = /\bMODEL_PLACEHOLDER_M667\b/i.test(combined);
  const isKnownOrchArgonPh = /\bMODEL_PLACEHOLDER_M681\b/i.test(combined);
  const isKnownOrchNeonPh = /\bMODEL_PLACEHOLDER_M537\b/i.test(combined);
  const dynamicOrchVariant = isOrchWorker ? '' : extractDynamicOrchVariant(fields);
  const hasBareProOrch = /\bgemini-pro-orchestrator\b(?![-_][a-z0-9])/i.test(combined);
  const isOrchSeries =
    isOrchWorker ||
    Boolean(dynamicOrchVariant) ||
    isKnownOrchNeonPh ||
    isKnownOrchArgonPh ||
    isKnownOrchCarbonPh ||
    hasBareProOrch;

  if (isOrchSeries) {
    let compactId = '';
    let fullId = '';
    if (isOrchWorker) {
      const workerVariant = extractOrchWorkerVariant(fields, combined);
      const cleanUpstream = stripCompactionMarker(upstreamText || responseText || '').trim();
      if (workerVariant === 'hydrogen') {
        compactId = 'worker-agy-hydrogen';
        fullId = 'gemini-flash-worker-agy (hydrogen-4)';
      } else if (workerVariant === 'neon') {
        compactId = 'worker-agy-neon';
        if (cleanUpstream) {
          if (/\([^)]+\)\s*$/.test(cleanUpstream)) {
            fullId = cleanUpstream;
          } else if (/(?:worker-agy)/i.test(cleanUpstream)) {
            fullId = `${cleanUpstream} (neon-4)`;
          } else if (/\bneon\b/i.test(cleanUpstream)) {
            fullId = cleanUpstream;
          } else {
            fullId = `${cleanUpstream} (neon-4)`;
          }
        } else {
          fullId = 'gemini-neon-worker-agy (neon-4)';
        }
      } else if (workerVariant) {
        compactId = `worker-agy-${workerVariant}`;
        const variantDashed = workerVariant.replace(/\./g, '-');
        const upstreamLower = cleanUpstream.toLowerCase();
        const mentionsVariant =
          upstreamLower.includes(workerVariant) || upstreamLower.includes(variantDashed);
        fullId = cleanUpstream
          ? mentionsVariant || /\([^)]+\)\s*$/.test(cleanUpstream)
            ? cleanUpstream
            : `${cleanUpstream} (${workerVariant})`
          : `worker-agy-${workerVariant}`;
      } else {
        compactId = 'worker-agy';
        fullId = cleanUpstream || 'worker-agy';
      }
    } else if (isKnownOrchNeonPh || dynamicOrchVariant === 'neon') {
      compactId = 'orchestrator-neon';
      fullId = 'gemini-pro-orchestrator-neon (neon-4)';
    } else if (isKnownOrchArgonPh || dynamicOrchVariant === 'argon') {
      compactId = 'orchestrator-argon';
      fullId = 'gemini-pro-orchestrator-argon (argon-4)';
    } else if (
      isKnownOrchCarbonPh ||
      dynamicOrchVariant === 'carbon' ||
      (hasBareProOrch && !dynamicOrchVariant)
    ) {
      compactId = 'orchestrator-carbon';
      fullId = 'gemini-pro-orchestrator (carbon-4)';
    } else if (dynamicOrchVariant) {
      compactId = `orchestrator-${dynamicOrchVariant}`;
      const cleanUpstream = stripCompactionMarker(upstreamText || responseText || '').trim();
      const variantDashed = dynamicOrchVariant.replace(/\./g, '-');
      const upstreamLower = cleanUpstream.toLowerCase();
      const mentionsVariant =
        upstreamLower.includes(dynamicOrchVariant) || upstreamLower.includes(variantDashed);
      if (cleanUpstream) {
        fullId =
          mentionsVariant || /\([^)]+\)\s*$/.test(cleanUpstream)
            ? cleanUpstream
            : `${cleanUpstream} (${dynamicOrchVariant})`;
      } else {
        const isNonGeminiOrch = /\b(?:claude|anthropic|opus|sonnet|haiku|fable|gpt|openai)\b/i.test(
          `${combined} ${dynamicOrchVariant}`
        );
        fullId = isNonGeminiOrch
          ? `orchestrator-${dynamicOrchVariant}`
          : `gemini-pro-orchestrator-${dynamicOrchVariant}`;
      }
    }
    if (compactId) {
      const baseText = modelDisplayMode === 'upstream' ? fullId : compactId;
      const text = `${baseText}${compactionSuffix}`;
      const multiUpstream =
        Array.isArray(target.upstreamModels) && target.upstreamModels.length > 1
          ? target.upstreamModels.join(' / ')
          : '';
      const title = multiUpstream || `${fullId}${compactionSuffix}`;
      return {
        text,
        baseText,
        compactionSuffix,
        isCompaction,
        title,
        isOrchestratorSeries: true,
      };
    }
  }

  const rawSelected =
    (showUpstream
      ? upstreamText || responseText || shortText || labelText
      : preferLabelInShort
        ? labelText || shortText
        : shortText || labelText) || fallback;
  const cleanRawBase = stripCompactionMarker(rawSelected) || fallback;
  const baseText =
    modelDisplayMode === 'upstream_compact'
      ? stripVendorModelPrefix(cleanRawBase) || cleanRawBase
      : cleanRawBase;
  const text = `${baseText}${compactionSuffix}`;
  const fullUpstreamWithSuffix = `${cleanRawBase}${compactionSuffix}`;
  const standardTitle =
    showUpstream && Array.isArray(target.upstreamModels) && target.upstreamModels.length > 1
      ? target.upstreamModels.join(' / ')
      : showUpstream
        ? fullUpstreamWithSuffix
        : text;
  return {
    text,
    baseText,
    compactionSuffix,
    isCompaction,
    title: standardTitle,
    isOrchestratorSeries: false,
  };
}

/**
 * 按当前显示策略 (`resolveModelDisplayInfo`) 解析出的最终展示名称对模型统计列表执行二次去重归并，
 * 确保当多个外层模型槽位映射到同一展示名（例如切换至“原始模型 ID”后共享同一 `upstreamName`）时，
 * 不会在排行榜或总览中出现重复同名行，同时完整累加 Token、调用次数、未定价计数与速度/首字加权均值。
 *
 * @param {object[]} [models=[]]
 * @param {object|boolean} [settings={}]
 * @param {{ preferLabelInShort?: boolean, fallback?: string }} [options={}]
 * @returns {object[]}
 */
export function mergeModelsByDisplayName(models = [], settings = {}, options = {}) {
  if (!Array.isArray(models) || models.length === 0) return [];
  const showUpstream =
    typeof settings === 'boolean'
      ? settings
      : normalizeModelDisplayMode(settings?.modelDisplayMode, settings?.showUpstreamModel) !== 'short';
  const byDisplay = new Map();

  for (const m of models) {
    if (!m || typeof m !== 'object') continue;
    const disp = resolveModelDisplayInfo(m, settings, options);
    const key = String(disp.text || options?.fallback || '—').trim() || '—';

    const calls = Math.max(0, Number(m.calls || 0));
    const inTok = Math.max(0, Number(m.inputTokens || 0));
    const cacheTok = Math.max(0, Number(m.cacheReadTokens || 0));
    const outTok = Math.max(0, Number(m.outputTokens || 0));
    const thinkTok = Math.max(0, Number(m.thinkingTokens || 0));
    const respTok =
      m.responseTokens != null
        ? Math.max(0, Number(m.responseTokens))
        : Math.max(0, outTok - thinkTok);
    const totTok = Math.max(0, Number(m.totalTokens ?? inTok + cacheTok + outTok));
    const costUsd = Number.isFinite(Number(m.costUsd)) ? Math.max(0, Number(m.costUsd)) : 0;
    const unpricedCalls = Math.max(0, Number(m.unpricedCalls || 0));

    const speedSampleCount = Math.max(0, Number(m.speedSummary?.sampleCount || 0));
    const speedExcludedCount = Math.max(0, Number(m.speedSummary?.excludedCount || 0));
    const speedWeight = speedSampleCount > 0 ? speedSampleCount : Math.max(1, outTok || calls || 1);
    const hasSpeed =
      m.avgTokPerSec != null && Number.isFinite(Number(m.avgTokPerSec)) && Number(m.avgTokPerSec) > 0;
    const rawSpeedTokens = Number(m.speedSummary?.tokens);
    const rawSpeedSeconds = Number(m.speedSummary?.seconds);
    const hasExactSpeedSummary =
      Number.isFinite(rawSpeedTokens) &&
      Number.isFinite(rawSpeedSeconds) &&
      rawSpeedSeconds > 0 &&
      rawSpeedTokens >= 0;

    const ttftSampleCount = Math.max(0, Number(m.ttftSampleCount || 0));
    const ttftWeight = ttftSampleCount > 0 ? ttftSampleCount : Math.max(1, calls || 1);
    const hasTtft =
      m.avgTtftSec != null && Number.isFinite(Number(m.avgTtftSec)) && Number(m.avgTtftSec) >= 0;

    let acc = byDisplay.get(key);
    if (!acc) {
      const initExcludedReasons = {};
      if (m.speedSummary?.excludedReasons && typeof m.speedSummary.excludedReasons === 'object') {
        for (const [rk, rv] of Object.entries(m.speedSummary.excludedReasons)) {
          const cnt = Math.max(0, Number(rv || 0));
          if (cnt > 0) initExcludedReasons[rk] = cnt;
        }
      }
      acc = {
        baseItem: m,
        mergedCount: 1,
        displayText: key,
        firstTitle: disp.title || key,
        titleSet: new Set(disp.title ? [disp.title] : []),
        upstreamSet: new Set(
          Array.isArray(m.upstreamModels) ? m.upstreamModels.filter(Boolean) : []
        ),
        sourceLabels: m.label ? [m.label] : [],
        calls,
        inputTokens: inTok,
        cacheReadTokens: cacheTok,
        outputTokens: outTok,
        thinkingTokens: thinkTok,
        responseTokens: respTok,
        totalTokens: totTok,
        costUsd,
        unpricedCalls,
        hasAnySpeedSummary: Boolean(m.speedSummary),
        allSpeedExact: !hasSpeed || hasExactSpeedSummary,
        speedTokens: hasExactSpeedSummary ? rawSpeedTokens : 0,
        speedSeconds: hasExactSpeedSummary ? rawSpeedSeconds : 0,
        speedWeightedSum: hasSpeed ? Number(m.avgTokPerSec) * speedWeight : 0,
        speedWeight: hasSpeed ? speedWeight : 0,
        speedSampleCount,
        speedExcludedCount,
        speedExcludedReasons: initExcludedReasons,
        ttftWeightedSum: hasTtft ? Number(m.avgTtftSec) * ttftWeight : 0,
        ttftWeight: hasTtft ? ttftWeight : 0,
        ttftSampleCount,
        anomalySteps: Math.max(0, Number(m.anomalySteps || 0)),
        anomalyCount: Math.max(0, Number(m.anomalyCount || 0)),
        anomalyDangerCount: Math.max(0, Number(m.anomalyDangerCount || 0)),
        anomalyTotalDelaySec: Math.max(0, Number(m.anomalyTotalDelaySec || 0)),
        anomalyByKind:
          m.anomalyByKind && typeof m.anomalyByKind === 'object' ? { ...m.anomalyByKind } : {},
      };
      if (m.upstreamName) acc.upstreamSet.add(m.upstreamName);
      byDisplay.set(key, acc);
      continue;
    }

    acc.mergedCount += 1;
    if (disp.title) acc.titleSet.add(disp.title);
    if (Array.isArray(m.upstreamModels)) {
      for (const u of m.upstreamModels) {
        if (u) acc.upstreamSet.add(u);
      }
    }
    if (m.upstreamName) acc.upstreamSet.add(m.upstreamName);
    if (m.label && !acc.sourceLabels.includes(m.label)) {
      acc.sourceLabels.push(m.label);
    }

    acc.calls += calls;
    acc.inputTokens += inTok;
    acc.cacheReadTokens += cacheTok;
    acc.outputTokens += outTok;
    acc.thinkingTokens += thinkTok;
    acc.responseTokens += respTok;
    acc.totalTokens += totTok;
    acc.costUsd += costUsd;
    acc.unpricedCalls += unpricedCalls;

    acc.anomalySteps += Math.max(0, Number(m.anomalySteps || 0));
    acc.anomalyCount += Math.max(0, Number(m.anomalyCount || 0));
    acc.anomalyDangerCount += Math.max(0, Number(m.anomalyDangerCount || 0));
    acc.anomalyTotalDelaySec += Math.max(0, Number(m.anomalyTotalDelaySec || 0));
    if (m.anomalyByKind && typeof m.anomalyByKind === 'object') {
      for (const [ak, av] of Object.entries(m.anomalyByKind)) {
        const cnt = Math.max(0, Number(av || 0));
        if (cnt > 0) acc.anomalyByKind[ak] = (acc.anomalyByKind[ak] || 0) + cnt;
      }
    }

    if (m.speedSummary) acc.hasAnySpeedSummary = true;
    if (hasSpeed && !hasExactSpeedSummary) acc.allSpeedExact = false;
    if (hasExactSpeedSummary) {
      acc.speedTokens += rawSpeedTokens;
      acc.speedSeconds += rawSpeedSeconds;
    }
    if (hasSpeed) {
      acc.speedWeightedSum += Number(m.avgTokPerSec) * speedWeight;
      acc.speedWeight += speedWeight;
    }
    acc.speedSampleCount += speedSampleCount;
    acc.speedExcludedCount += speedExcludedCount;
    if (m.speedSummary?.excludedReasons && typeof m.speedSummary.excludedReasons === 'object') {
      for (const [rk, rv] of Object.entries(m.speedSummary.excludedReasons)) {
        const cnt = Math.max(0, Number(rv || 0));
        if (cnt > 0) acc.speedExcludedReasons[rk] = (acc.speedExcludedReasons[rk] || 0) + cnt;
      }
    }

    if (hasTtft) {
      acc.ttftWeightedSum += Number(m.avgTtftSec) * ttftWeight;
      acc.ttftWeight += ttftWeight;
    }
    acc.ttftSampleCount += ttftSampleCount;
  }

  return Array.from(byDisplay.values()).map((acc) => {
    if (acc.mergedCount === 1) {
      return {
        ...acc.baseItem,
        displayText: acc.displayText,
        displayTitle: acc.firstTitle,
        sourceLabels: acc.sourceLabels,
      };
    }
    const promptTok = acc.inputTokens + acc.cacheReadTokens;
    const cacheHitPct = promptTok > 0 ? +((acc.cacheReadTokens / promptTok) * 100).toFixed(1) : 0;
    const rawAvgTps =
      acc.allSpeedExact && acc.speedSeconds > 0
        ? acc.speedTokens / acc.speedSeconds
        : acc.speedWeight > 0
          ? acc.speedWeightedSum / acc.speedWeight
          : null;
    const avgTokPerSec = rawAvgTps !== null ? +rawAvgTps.toFixed(1) : null;
    const avgTtftSec =
      acc.ttftWeight > 0 ? +(acc.ttftWeightedSum / acc.ttftWeight).toFixed(1) : null;
    const upstreamModels = Array.from(acc.upstreamSet);
    const displayTitle =
      showUpstream && upstreamModels.length > 1
        ? upstreamModels.join(' / ')
        : Array.from(acc.titleSet).join(' / ') || acc.displayText;

    return {
      ...acc.baseItem,
      calls: acc.calls,
      inputTokens: acc.inputTokens,
      cacheReadTokens: acc.cacheReadTokens,
      outputTokens: acc.outputTokens,
      thinkingTokens: acc.thinkingTokens,
      responseTokens: acc.responseTokens,
      totalTokens: acc.totalTokens,
      costUsd: +acc.costUsd.toFixed(6),
      unpricedCalls: acc.unpricedCalls,
      cacheHitPct,
      avgTokPerSec,
      avgTtftSec,
      ttftSampleCount: acc.ttftSampleCount,
      ...(acc.anomalyCount > 0
        ? {
            anomalySteps: acc.anomalySteps,
            anomalyCount: acc.anomalyCount,
            anomalyDangerCount: acc.anomalyDangerCount,
            anomalyTotalDelaySec: +acc.anomalyTotalDelaySec.toFixed(1),
            anomalyByKind: acc.anomalyByKind,
          }
        : {}),
      speedSummary: acc.hasAnySpeedSummary
        ? {
            ...(acc.baseItem.speedSummary || {}),
            tokens: acc.speedTokens,
            seconds: +acc.speedSeconds.toFixed(6),
            sampleCount: acc.speedSampleCount,
            excludedCount: acc.speedExcludedCount,
            excludedReasons: acc.speedExcludedReasons,
            avgTokPerSec: rawAvgTps,
          }
        : undefined,
      upstreamModels,
      displayText: acc.displayText,
      displayTitle,
      sourceLabels: acc.sourceLabels,
    };
  });
}

/**
 * 根据代理索引返回对应的微边框语义徽章样式类名。
 *
 * @param {number} [index=0]
 * @param {boolean} [isMain=false]
 * @returns {string}
 */
export function getAgentBadgeClass(index = 0, isMain = false) {
  if (isMain || index <= 0) return 'badge-main';
  const slot = ((index - 1) % 3) + 1;
  return `badge-sub-${slot}`;
}

function resolveStructuredAgentKind(agent) {
  if (!agent) return 'main';
  if (agent.agentKind) return agent.agentKind;
  if (agent.isMain) return 'main';
  if (agent.isSideQuestion || agent.typeName === 'side_question') return 'side_question';
  if (
    agent.typeName === 'worker' ||
    agent.typeName === 'swarm_worker' ||
    /^Swarm\s+Worker\s*\(/i.test(String(agent.role || ''))
  ) {
    return 'swarm_worker';
  }
  return 'subagent';
}

function normalizeSwarmMemberHandle(rawText) {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) return '';
  const wrapper = trimmed.match(/^Swarm\s+Worker\s*\(([^)]+)\)\s*$/i);
  const inner = (wrapper ? wrapper[1] : trimmed).replace(/^@+/, '').trim();
  if (
    !inner ||
    inner === '蜂群' ||
    inner === '工蜂' ||
    inner.toLowerCase() === 'swarm' ||
    inner.toLowerCase() === 'worker' ||
    inner.toLowerCase() === 'swarm worker'
  ) {
    return '';
  }
  return `@${inner}`;
}

/**
 * 格式化后端配额池展示名称，将默认兜底的 `'未知'` / `'Unknown'` 本地化为当前语言文本，
 * 保留真实配额池名（如 `'Gemini'`、`'Claude & GPT'`、`'Gemini 4 Argon'`）不变。
 *
 * @param {string|null|undefined} rawLabel
 * @param {{ fallback?: string, locale?: string }} [options]
 * @returns {string}
 */
export function formatQuotaPoolLabel(rawLabel, { fallback = '', locale } = {}) {
  const text = String(rawLabel || '').trim();
  const explicitLocale = typeof locale === 'string' && locale.trim().length > 0;
  const resolvedLocale = explicitLocale
    ? resolveFormatterLocale(locale)
    : getEffectiveLocale();
  const unknownText = explicitLocale
    ? tForLocale(resolvedLocale, 'fmt.unknownPool')
    : t('fmt.unknownPool');
  if (!text) return fallback || unknownText;
  if (text === '未知' || text.toLowerCase() === 'unknown') return unknownText;
  return text;
}

/**
 * 基于结构化 `agentKind` / `agentOrdinal` 格式化主/子代理、蜂群节点或旁路提问的紧凑徽章文本（零正则反拆中文）。
 *
 * @param {object|null|undefined} agent
 * @returns {string}
 */
export function formatAgentBadgeText(agent) {
  if (!agent) return t('fmt.mainBadge');
  const kind = resolveStructuredAgentKind(agent);
  if (kind === 'all') return t('header.scopeAllShort');
  if (kind === 'main') return t('fmt.mainBadge');
  const isZhCn = getEffectiveLocale() === 'zh-CN';
  if (kind === 'side_question') {
    const ord = Number(agent.agentOrdinal || agent.sideIndex || 0);
    if (ord > 0) return t('fmt.sideBadge', { index: ord });
    if (isZhCn && agent.badgeText) return String(agent.badgeText);
    return t('fmt.sideBadgeShort');
  }
  if (kind === 'swarm_worker') {
    const ord = Number(agent.agentOrdinal || agent.index || 0);
    if (ord > 0) return t('fmt.swarmBadge', { index: ord });
    if (isZhCn && agent.badgeText) return String(agent.badgeText);
    return t('fmt.swarmBadgeShort');
  }
  const ord = Number(agent.agentOrdinal || agent.index || 0);
  if (ord > 0) return t('fmt.subBadge', { index: ord });
  if (isZhCn && agent.badgeText) return String(agent.badgeText);
  return t('fmt.subBadgeShort');
}

/**
 * 基于结构化 `agentKind` / `agentOrdinal` / `customRole` 格式化代理完整显示名称（零正则反拆中文）。
 *
 * @param {object|null|undefined} agent
 * @returns {string}
 */
export function formatAgentLabel(agent) {
  if (!agent) return t('fmt.mainAgent');
  const kind = resolveStructuredAgentKind(agent);
  if (kind === 'all') return t('header.scopeAll');
  if (kind === 'main') return t('fmt.mainAgent');

  const rawCustom =
    agent.customRole !== undefined
      ? String(agent.customRole || '').trim()
      : String(agent.role || '').trim();
  if (kind === 'side_question') {
    const ord = Number(agent.agentOrdinal || agent.sideIndex || 0);
    const baseLabel = ord > 0 ? `${t('fmt.sideQuestion')} #${ord}` : t('fmt.sideQuestion');
    const isGeneric =
      !rawCustom ||
      rawCustom === baseLabel ||
      rawCustom === agent.shortLabel ||
      rawCustom === t('fmt.sideQuestion') ||
      rawCustom === 'Side Question' ||
      rawCustom === 'side_question';
    return isGeneric ? baseLabel : `${baseLabel} · ${rawCustom}`;
  }

  if (kind === 'swarm_worker') {
    const ord = Number(agent.agentOrdinal || agent.index || 0);
    const baseLabel = ord > 0 ? `${t('fmt.swarmAgent')} #${ord}` : t('fmt.swarmAgent');
    const handle = normalizeSwarmMemberHandle(rawCustom || agent.role || '');
    if (!handle) return baseLabel;
    let auxSuffix = '';
    if (/^@monitor(?:-\d+)?$/i.test(handle)) {
      auxSuffix = ` (${t('fmt.swarmMonitorHint')})`;
    } else if (/^@narrator(?:-\d+)?$/i.test(handle)) {
      auxSuffix = ` (${t('fmt.swarmNarratorHint')})`;
    }
    return `${baseLabel} · ${handle}${auxSuffix}`;
  }

  const ord = Number(agent.agentOrdinal || agent.index || 0);
  const baseLabel = ord > 0 ? `${t('fmt.subAgent')} #${ord}` : t('fmt.subAgent');
  const isGeneric =
    !rawCustom ||
    rawCustom === baseLabel ||
    rawCustom === agent.shortLabel ||
    rawCustom === t('fmt.subAgent') ||
    rawCustom === 'Subagent';
  return isGeneric ? baseLabel : `${baseLabel} · ${rawCustom}`;
}

/**
 * 格式化会话选项右侧元信息（自适应区分纯蜂群、蜂群+子代理混合、常规子代理与单会话步数）。
 *
 * @param {object|null|undefined} conv
 * @returns {string}
 */
export function formatConversationMeta(conv) {
  if (!conv) return '';
  const main = Number(conv.stepCount || 0);
  const totalSubs = Number(conv.subagentCount || 0);
  const swarm = Number(conv.swarmCount || 0);
  const otherSubs = Math.max(0, totalSubs - swarm);
  const total = Number(conv.totalStepCount ?? conv.totalStepsAllAgents ?? main);
  if (swarm > 0 && otherSubs > 0) {
    return t('header.convMetaWithSwarmAndSubs', { main, swarm, subs: otherSubs, total });
  }
  if (swarm > 0) {
    return t('header.convMetaWithSwarm', { main, swarm, total });
  }
  if (totalSubs > 0) {
    return t('header.convMetaWithSubs', { main, subs: totalSubs, total });
  }
  return t('header.convMetaSteps', { count: main });
}

/**
 * 基于后端结构化 `actionKey` + `waitingApproval` 渲染实时动作短标题（兼容自定义 `label` 回退）。
 *
 * @param {object|null|undefined} act
 * @param {string} [fallbackKey='live.thinking']
 * @returns {string}
 */
export function formatLiveActivityLabel(act, fallbackKey = 'live.thinking') {
  if (!act || typeof act !== 'object') return t(fallbackKey);
  let baseLabel = '';
  if (act.actionKey) {
    const i18nKey = `live.act.${act.actionKey}`;
    const translated = t(i18nKey);
    if (translated && translated !== i18nKey) {
      baseLabel = translated;
    }
  }
  if (!baseLabel) {
    baseLabel = String(act.label || '').trim() || t(fallbackKey);
  }
  if (act.waitingApproval) {
    return t('live.act.awaitingApproval', { label: baseLabel });
  }
  return baseLabel;
}

/**
 * 基于后端结构化 `detailKey` 渲染实时动作补充说明（兼容自由文本 `detail`）。
 *
 * @param {object|null|undefined} act
 * @returns {string}
 */
export function formatLiveActivityDetail(act) {
  if (!act || typeof act !== 'object') return '';
  if (act.detailKey === 'compaction_resuming') {
    return t('live.act.compactionResuming');
  }
  return String(act.detail || '');
}

/**
 * 20 色感知均匀色环（无特定模型绑定，兼顾亮/暗背景可读性，彻底消除标准 HSL 绿色/暗红区过度聚集撞色）。
 * 每项为 `[hue, saturationPct, lightnessPct]`。
 */
const PERCEPTUAL_MODEL_COLOR_RING = [
  [217, 82, 53], // Royal Blue
  [14, 80, 52], // Coral / Vermilion
  [162, 74, 41], // Teal / Jade
  [272, 74, 58], // Vivid Violet
  [36, 88, 47], // Rich Amber
  [336, 78, 53], // Rose / Raspberry
  [193, 84, 43], // Cerulean / Cyan
  [138, 66, 41], // Emerald Green
  [246, 74, 60], // Indigo
  [25, 86, 50], // Tangerine Orange
  [306, 70, 52], // Magenta / Orchid
  [177, 76, 39], // Deep Seafoam
  [355, 76, 54], // Crimson Red
  [205, 80, 48], // Ocean Blue
  [45, 88, 44], // Warm Gold
  [288, 68, 55], // Amethyst Purple
  [102, 60, 42], // Leaf Green
  [230, 76, 57], // Cobalt Blue
  [322, 74, 51], // Berry Pink
  [185, 72, 46], // Turquoise
];

/**
 * 提取跨平台、跨语言、同屏三栏（模型排行 / 客户端来源 / 月度统计）严格一致的模型颜色种子字符串。
 *
 * 优先取单模型稳定 `sourceLabels[0]`；若多个外层槽位已在当前显示策略下合并（如 `4-argon`），
 * 则以规范化 `displayText` 为种子，确保跨客户端与跨月份聚合子集不同时依然映射至完全相同的颜色。
 *
 * @param {object|string|null|undefined} model
 * @returns {string}
 */
export function getCanonicalModelColorSeed(model) {
  if (typeof model === 'string') {
    return model.trim().toLowerCase().replace(/\s+/g, ' ');
  }
  if (!model || typeof model !== 'object') return '';
  if (
    Number(model.mergedCount || 0) <= 1 &&
    Array.isArray(model.sourceLabels) &&
    model.sourceLabels.length === 1 &&
    model.sourceLabels[0]
  ) {
    return String(model.sourceLabels[0]).trim().toLowerCase().replace(/\s+/g, ' ');
  }
  const raw =
    model.displayText ||
    model.label ||
    model.modelId ||
    model.baseItem?.modelId ||
    model.shortName ||
    model.name ||
    '';
  return String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
}

function hashModelSeed32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function formatRingSlotHsl(slotIdx, shiftLight = 0) {
  const [hue, sat, light] = PERCEPTUAL_MODEL_COLOR_RING[slotIdx % PERCEPTUAL_MODEL_COLOR_RING.length];
  const clampedLight = Math.min(66, Math.max(34, light + shiftLight));
  return `hsl(${hue} ${sat}% ${clampedLight}%)`;
}

/**
 * 基于模型标识通过 32 位雪崩哈希映射至 20 色感知均匀色环，确保跨电脑同模型同色且无需硬编码颜色表。
 *
 * @param {object|string|null|undefined} seedOrModel
 * @returns {string}
 */
export function resolveDeterministicModelColor(seedOrModel) {
  const seed = getCanonicalModelColorSeed(seedOrModel);
  if (!seed) return 'var(--accent-primary)';
  const h = hashModelSeed32(seed);
  return formatRingSlotHsl(h % PERCEPTUAL_MODEL_COLOR_RING.length);
}

/**
 * 为一组模型构建确定性颜色映射表（双遍固有槽位保护）：
 * 1. 所有无槽位冲突的模型 100% 保持其纯哈希固有色，不受长尾模型增减影响；
 * 2. 仅当同屏两个模型恰好落入同一色环槽位时，按严格字典序以互质步长 `+7` 优先探查未被任何模型占用的空闲槽位。
 *
 * @param {Array<object|string>} [models=[]]
 * @returns {Map<string, string>} `canonicalSeed -> hsl(...)`
 */
export function buildDeterministicModelColorMap(models = []) {
  const ringLen = PERCEPTUAL_MODEL_COLOR_RING.length;
  const uniqueSeeds = Array.from(
    new Set(
      (Array.isArray(models) ? models : [])
        .map((m) => getCanonicalModelColorSeed(m))
        .filter(Boolean)
    )
  ).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const naturalSlotCounts = new Map();
  for (const seed of uniqueSeeds) {
    const nat = hashModelSeed32(seed) % ringLen;
    naturalSlotCounts.set(nat, (naturalSlotCounts.get(nat) || 0) + 1);
  }

  const usedSlots = new Set();
  const colorMap = new Map();

  for (const seed of uniqueSeeds) {
    const h = hashModelSeed32(seed);
    const nat = h % ringLen;
    if (!usedSlots.has(nat)) {
      usedSlots.add(nat);
      colorMap.set(seed, formatRingSlotHsl(nat));
      continue;
    }

    let picked = -1;
    for (let k = 1; k < ringLen; k++) {
      const cand = (nat + k * 7) % ringLen;
      if (!usedSlots.has(cand) && !naturalSlotCounts.has(cand)) {
        picked = cand;
        break;
      }
    }
    if (picked < 0) {
      for (let k = 1; k < ringLen; k++) {
        const cand = (nat + k * 7) % ringLen;
        if (!usedSlots.has(cand)) {
          picked = cand;
          break;
        }
      }
    }

    if (picked >= 0) {
      usedSlots.add(picked);
      colorMap.set(seed, formatRingSlotHsl(picked));
    } else {
      const shift = (h >>> 8) & 1 ? 9 : -8;
      colorMap.set(seed, formatRingSlotHsl(nat, shift));
    }
  }

  return colorMap;
}
