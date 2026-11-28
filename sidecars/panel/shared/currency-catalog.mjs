/**
 * @fileoverview 跨前后端共享的多币种目录、语言默认货币映射与次级参考金额格式化工具。
 *
 * 设计原则：
 * - 所有内部计费与聚合基准严格保持 USD；本模块仅负责将 USD 折算为辅助展示货币；
 * - 默认策略 `'auto'` 按当前有效界面语言自动映射对应货币（简中 CNY、繁中 TWD、日语 JPY、
 *   韩语 KRW、德/法语 EUR；英语 `en-US` 主数值已是 USD，自动隐藏重复的 `≈` 副标）；
 * - 同时支持手动固定任意内置币种（含 `USD` 显式隐藏副标及主流地区币种），内置静态离线参考汇率兜底。
 */

import { resolveLocaleFromLanguageTag } from './settings-normalization.mjs';

export const DEFAULT_DISPLAY_CURRENCY = 'auto';

export const LOCALE_DEFAULT_CURRENCY = Object.freeze({
  'zh-CN': 'CNY',
  'zh-TW': 'TWD',
  'en-US': 'USD',
  'vi-VN': 'VND',
  'ja-JP': 'JPY',
  'ko-KR': 'KRW',
  'de-DE': 'EUR',
  'fr-FR': 'EUR',
});

export const CURRENCY_CATALOG = Object.freeze({
  USD: Object.freeze({ code: 'USD', symbol: '$', fallbackRate: 1, zeroDecimal: false }),
  CNY: Object.freeze({ code: 'CNY', symbol: '¥', fallbackRate: 7.2, zeroDecimal: false }),
  TWD: Object.freeze({ code: 'TWD', symbol: 'NT$', fallbackRate: 32.5, zeroDecimal: true }),
  JPY: Object.freeze({ code: 'JPY', symbol: '¥', fallbackRate: 152, zeroDecimal: true }),
  KRW: Object.freeze({ code: 'KRW', symbol: '₩', fallbackRate: 1380, zeroDecimal: true }),
  EUR: Object.freeze({ code: 'EUR', symbol: '€', fallbackRate: 0.92, zeroDecimal: false }),
  GBP: Object.freeze({ code: 'GBP', symbol: '£', fallbackRate: 0.79, zeroDecimal: false }),
  HKD: Object.freeze({ code: 'HKD', symbol: 'HK$', fallbackRate: 7.8, zeroDecimal: false }),
  SGD: Object.freeze({ code: 'SGD', symbol: 'S$', fallbackRate: 1.34, zeroDecimal: false }),
  MYR: Object.freeze({ code: 'MYR', symbol: 'RM', fallbackRate: 4.45, zeroDecimal: false }),
  AUD: Object.freeze({ code: 'AUD', symbol: 'A$', fallbackRate: 1.54, zeroDecimal: false }),
  CAD: Object.freeze({ code: 'CAD', symbol: 'C$', fallbackRate: 1.39, zeroDecimal: false }),
  CHF: Object.freeze({ code: 'CHF', symbol: 'CHF ', fallbackRate: 0.88, zeroDecimal: false }),
  INR: Object.freeze({ code: 'INR', symbol: '₹', fallbackRate: 84.5, zeroDecimal: false }),
  THB: Object.freeze({ code: 'THB', symbol: '฿', fallbackRate: 34.5, zeroDecimal: false }),
  IDR: Object.freeze({ code: 'IDR', symbol: 'Rp', fallbackRate: 15800, zeroDecimal: true }),
  VND: Object.freeze({ code: 'VND', symbol: '₫', fallbackRate: 25400, zeroDecimal: true }),
  PHP: Object.freeze({ code: 'PHP', symbol: '₱', fallbackRate: 58.5, zeroDecimal: false }),
  BRL: Object.freeze({ code: 'BRL', symbol: 'R$', fallbackRate: 5.8, zeroDecimal: false }),
  MXN: Object.freeze({ code: 'MXN', symbol: 'MX$', fallbackRate: 20.2, zeroDecimal: false }),
});

export const SUPPORTED_CURRENCY_CODES = Object.freeze(Object.keys(CURRENCY_CATALOG));
export const SUPPORTED_DISPLAY_CURRENCIES = Object.freeze([
  DEFAULT_DISPLAY_CURRENCY,
  ...SUPPORTED_CURRENCY_CODES,
]);

const SUPPORTED_CURRENCY_CODE_SET = new Set(SUPPORTED_CURRENCY_CODES);

export const BUILTIN_FX_RATES = Object.freeze(
  Object.fromEntries(
    SUPPORTED_CURRENCY_CODES.map((code) => [code, CURRENCY_CATALOG[code].fallbackRate])
  )
);

/**
 * 归一化用户选择的参考货币设置（`'auto'` 或支持的 3 位 ISO 4217 货币代码）。
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeDisplayCurrency(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return DEFAULT_DISPLAY_CURRENCY;
  const lower = s.toLowerCase();
  if (lower === 'auto' || lower === 'system' || lower === 'locale') {
    return DEFAULT_DISPLAY_CURRENCY;
  }
  const upper = s.toUpperCase();
  if (SUPPORTED_CURRENCY_CODE_SET.has(upper)) {
    return upper;
  }
  return DEFAULT_DISPLAY_CURRENCY;
}

/**
 * 解析当前生效的目标参考货币代码：
 * - 手动指定具体币种时直接返回该币种（含 `'USD'`）；
 * - 为 `'auto'` 时按当前界面 Locale 自动映射到对应地区货币。
 *
 * @param {unknown} displayCurrency
 * @param {unknown} locale
 * @returns {string}
 */
export function resolveEffectiveCurrency(displayCurrency, locale = 'zh-CN') {
  const normalized = normalizeDisplayCurrency(displayCurrency);
  if (normalized !== DEFAULT_DISPLAY_CURRENCY) {
    return normalized;
  }
  const resolvedLocale = resolveLocaleFromLanguageTag(locale, 'zh-CN');
  return LOCALE_DEFAULT_CURRENCY[resolvedLocale] || 'USD';
}

/**
 * 解析某目标货币的实时/兜底汇率元数据。
 *
 * @param {string} currencyCode
 * @param {Record<string, any> | null | undefined} fxStatus
 * @param {number | null | undefined} [rateOverride]
 * @returns {{ code: string, symbol: string, zeroDecimal: boolean, rate: number, isLive: boolean, source: string, date: string | null }}
 */
export function resolveCurrencyRateInfo(currencyCode, fxStatus = null, rateOverride = null) {
  const code = SUPPORTED_CURRENCY_CODE_SET.has(String(currencyCode || '').toUpperCase())
    ? String(currencyCode).toUpperCase()
    : 'CNY';
  const profile = CURRENCY_CATALOG[code] || CURRENCY_CATALOG.CNY;
  const overrideNum = Number(rateOverride);
  if (Number.isFinite(overrideNum) && overrideNum > 0) {
    return {
      code,
      symbol: profile.symbol,
      zeroDecimal: profile.zeroDecimal,
      rate: overrideNum,
      isLive: false,
      source: 'override',
      date: null,
    };
  }
  const liveCandidate = Number(fxStatus?.rates?.[code]);
  const hasLiveRate =
    code !== 'USD' &&
    fxStatus?.source &&
    fxStatus.source !== 'builtin' &&
    Number.isFinite(liveCandidate) &&
    liveCandidate > 0;
  return {
    code,
    symbol: profile.symbol,
    zeroDecimal: profile.zeroDecimal,
    rate: hasLiveRate ? liveCandidate : profile.fallbackRate,
    isLive: Boolean(hasLiveRate),
    source: hasLiveRate ? String(fxStatus.source) : 'builtin',
    date: hasLiveRate && typeof fxStatus.date === 'string' && fxStatus.date ? fxStatus.date : null,
  };
}

/**
 * 格式化汇率单价数值（如 `7.20`、`0.92`、`152`、`1,380`）。
 *
 * @param {number} rate
 * @param {boolean} [zeroDecimal=false]
 * @returns {string}
 */
export function formatFxRateValue(rate, zeroDecimal = false) {
  const num = Number(rate);
  if (!Number.isFinite(num) || num <= 0) return '—';
  if (zeroDecimal || num >= 100) {
    const rounded = Math.round(num);
    return rounded >= 1000 ? rounded.toLocaleString('en-US') : String(rounded);
  }
  return num.toFixed(2);
}

/**
 * 将 USD 金额格式化为次级近似参考货币文本（如 `≈ ¥1138`、`≈ NT$5137`、`≈ ¥24,024`、`≈ €145`）。
 * 当生效币种为 `USD` 时返回空字符串 `''`，避免在美元主值旁重复展示美元副标。
 *
 * @param {number} usdAmount
 * @param {{ displayCurrency?: string, locale?: string, fxStatus?: Record<string, any> | null, rateOverride?: number | null }} [options]
 * @returns {string}
 */
export function formatConvertedApprox(
  usdAmount,
  { displayCurrency = DEFAULT_DISPLAY_CURRENCY, locale = 'zh-CN', fxStatus = null, rateOverride = null } = {}
) {
  const code = resolveEffectiveCurrency(displayCurrency, locale);
  if (code === 'USD') return '';
  const info = resolveCurrencyRateInfo(code, fxStatus, rateOverride);
  const amount = Number(usdAmount || 0) * info.rate;
  if (!Number.isFinite(amount) || amount <= 0) {
    return `≈ ${info.symbol}0`;
  }
  if (info.zeroDecimal) {
    const rounded = Math.round(amount);
    if (rounded >= 10_000) {
      return `≈ ${info.symbol}${rounded.toLocaleString('en-US')}`;
    }
    if (rounded >= 1) {
      return `≈ ${info.symbol}${rounded}`;
    }
    return `≈ ${info.symbol}${amount.toFixed(1)}`;
  }
  if (amount >= 10_000) {
    return `≈ ${info.symbol}${Math.round(amount).toLocaleString('en-US')}`;
  }
  if (amount >= 10) {
    return `≈ ${info.symbol}${Math.round(amount)}`;
  }
  return `≈ ${info.symbol}${amount.toFixed(1)}`;
}
