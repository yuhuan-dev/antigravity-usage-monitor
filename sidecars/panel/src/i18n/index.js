/**
 * @fileoverview Reactive lightweight i18n engine driven by `SUPPORTED_LOCALES` + `auto`.
 */

import { createReactiveStore } from '../core/reactive.js';
import {
  normalizeLanguageSetting,
  resolveLocaleFromLanguageTag,
} from '../../shared/settings-normalization.mjs';
import { I18N_MESSAGES_ZH_CN } from './zh-CN.js';
import { I18N_MESSAGES_ZH_TW } from './zh-TW.js';
import { I18N_MESSAGES_EN_US } from './en-US.js';
import { I18N_MESSAGES_JA_JP } from './ja-JP.js';
import { I18N_MESSAGES_KO_KR } from './ko-KR.js';
import { I18N_MESSAGES_DE_DE } from './de-DE.js';
import { I18N_MESSAGES_FR_FR } from './fr-FR.js';
import { I18N_MESSAGES_VI_VN } from './vi-VN.js';

export const I18N_DICTIONARIES = Object.freeze({
  'zh-CN': I18N_MESSAGES_ZH_CN,
  'zh-TW': I18N_MESSAGES_ZH_TW,
  'en-US': I18N_MESSAGES_EN_US,
  'vi-VN': I18N_MESSAGES_VI_VN,
  'ja-JP': I18N_MESSAGES_JA_JP,
  'ko-KR': I18N_MESSAGES_KO_KR,
  'de-DE': I18N_MESSAGES_DE_DE,
  'fr-FR': I18N_MESSAGES_FR_FR,
});

export function normalizeI18nLanguage(raw) {
  return normalizeLanguageSetting(raw);
}

export function detectHostSystemLocale() {
  try {
    if (typeof navigator !== 'undefined' && navigator.language) {
      return resolveLocaleFromLanguageTag(navigator.language, 'en-US');
    }
  } catch {
    // Ignore environment navigator read errors
  }
  return 'zh-CN';
}

export const i18nStore = createReactiveStore({
  language: 'auto',
  locale: detectHostSystemLocale(),
});

export function setI18nLanguage(rawLang) {
  const language = normalizeI18nLanguage(rawLang);
  const locale = language === 'auto' ? detectHostSystemLocale() : language;
  const cur = i18nStore.getState();
  if (cur.language !== language || cur.locale !== locale) {
    i18nStore.setState({ language, locale });
  }
  return locale;
}

export function getEffectiveLocale() {
  return i18nStore.getState().locale || 'zh-CN';
}

export function isEnglishLocale() {
  return getEffectiveLocale() === 'en-US';
}

/**
 * Sync `<html lang>` and `<title>` on the panel / standalone document to the active locale.
 * Uses equality guards so repeated calls avoid redundant DOM mutations on `<head>`.
 *
 * @param {Document | null} [doc]
 * @returns {string}
 */
export function syncDocumentLocale(doc = typeof document !== 'undefined' ? document : null) {
  const locale = getEffectiveLocale();
  if (!doc) return locale;
  try {
    if (doc.documentElement && doc.documentElement.lang !== locale) {
      doc.documentElement.lang = locale;
    }
    const nextTitle = t('app.title');
    if (nextTitle && doc.title !== nextTitle) {
      doc.title = nextTitle;
    }
  } catch {
    // Ignore read-only document environments in constrained webviews/tests
  }
  return locale;
}

/**
 * Translate a message key for an explicit locale without mutating global `i18nStore`.
 *
 * @param {string|null|undefined} rawLocale
 * @param {string} key
 * @param {Record<string, string | number>} [vars]
 * @returns {string}
 */
export function tForLocale(rawLocale, key, vars = undefined) {
  const locale =
    typeof rawLocale === 'string' && rawLocale.trim()
      ? resolveLocaleFromLanguageTag(rawLocale, getEffectiveLocale())
      : getEffectiveLocale();
  const dict = I18N_DICTIONARIES[locale] || I18N_MESSAGES_EN_US;
  const template = dict[key] ?? I18N_MESSAGES_EN_US[key] ?? I18N_MESSAGES_ZH_CN[key] ?? key;
  if (!vars || typeof template !== 'string') return template;
  return template.replace(/\{(\w+)\}/g, (_, k) =>
    vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''
  );
}

/**
 * Translate a message key with optional `{name}` variable interpolation.
 *
 * @param {string} key
 * @param {Record<string, string | number>} [vars]
 * @returns {string}
 */
export function t(key, vars = undefined) {
  return tForLocale(getEffectiveLocale(), key, vars);
}
