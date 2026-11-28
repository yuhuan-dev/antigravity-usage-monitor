import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILTIN_FX_RATES,
  DEFAULT_DISPLAY_CURRENCY,
  LOCALE_DEFAULT_CURRENCY,
  SUPPORTED_CURRENCY_CODES,
  SUPPORTED_DISPLAY_CURRENCIES,
  formatConvertedApprox,
  formatFxRateValue,
  normalizeDisplayCurrency,
  resolveCurrencyRateInfo,
  resolveEffectiveCurrency,
} from '../shared/currency-catalog.mjs';
import { SUPPORTED_LOCALES } from '../shared/settings-normalization.mjs';
import {
  createFxRatesManager,
  parseErApiResponse,
  parseFrankfurterResponse,
  sanitizeFxRatesMap,
} from '../backend/fx-rates.mjs';
import {
  createDefaultSettingsObject,
  normalizeFullSettings,
} from '../backend/settings-schema.mjs';
import { dispatchBridgeApiRequest } from '../backend/api-actions.mjs';
import {
  buildExportableSettingsJson,
  parseImportedSettingsJson,
} from '../src/core/settingsBackup.js';
import {
  formatCnyApprox,
  formatFxRateCaption,
  formatSecondaryCostApprox,
} from '../src/core/formatters.js';
import { setI18nLanguage } from '../src/i18n/index.js';

function createTempDir(t, prefix = 'ag-fx-rates-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  });
  return dir;
}

test('currency catalog maps all supported locales automatically in auto mode, supports manual overrides, and hides secondary USD estimate', () => {
  assert.equal(DEFAULT_DISPLAY_CURRENCY, 'auto');
  assert.ok(SUPPORTED_DISPLAY_CURRENCIES.includes('auto'));
  assert.ok(SUPPORTED_CURRENCY_CODES.includes('CNY'));
  assert.ok(SUPPORTED_CURRENCY_CODES.includes('TWD'));
  assert.ok(SUPPORTED_CURRENCY_CODES.includes('JPY'));
  assert.ok(SUPPORTED_CURRENCY_CODES.includes('KRW'));
  assert.ok(SUPPORTED_CURRENCY_CODES.includes('EUR'));
  assert.ok(SUPPORTED_CURRENCY_CODES.includes('MYR'));

  assert.equal(normalizeDisplayCurrency(''), 'auto');
  assert.equal(normalizeDisplayCurrency('system'), 'auto');
  assert.equal(normalizeDisplayCurrency('myr'), 'MYR');
  assert.equal(normalizeDisplayCurrency('usd'), 'USD');
  assert.equal(normalizeDisplayCurrency('INVALID_XYZ'), 'auto');

  // Auto mode resolves per-locale reference currency
  assert.equal(resolveEffectiveCurrency('auto', 'zh-CN'), 'CNY');
  assert.equal(resolveEffectiveCurrency('auto', 'zh-TW'), 'TWD');
  assert.equal(resolveEffectiveCurrency('auto', 'en-US'), 'USD');
  assert.equal(resolveEffectiveCurrency('auto', 'ja-JP'), 'JPY');
  assert.equal(resolveEffectiveCurrency('auto', 'ko-KR'), 'KRW');
  assert.equal(resolveEffectiveCurrency('auto', 'de-DE'), 'EUR');
  assert.equal(resolveEffectiveCurrency('auto', 'fr-FR'), 'EUR');
  assert.equal(resolveEffectiveCurrency('auto', 'vi-VN'), 'VND');
  for (const loc of SUPPORTED_LOCALES) {
    assert.equal(
      resolveEffectiveCurrency('auto', loc),
      LOCALE_DEFAULT_CURRENCY[loc],
      `auto currency mapping for ${loc}`
    );
  }

  // Manual override takes precedence regardless of UI language
  assert.equal(resolveEffectiveCurrency('MYR', 'en-US'), 'MYR');
  assert.equal(resolveEffectiveCurrency('USD', 'zh-CN'), 'USD');

  // Formatting $158.05 across all 7 locales with built-in fallback rates
  assert.equal(formatConvertedApprox(158.05, { displayCurrency: 'auto', locale: 'zh-CN' }), '≈ ¥1138');
  assert.equal(formatConvertedApprox(158.05, { displayCurrency: 'auto', locale: 'zh-TW' }), '≈ NT$5137');
  assert.equal(formatConvertedApprox(158.05, { displayCurrency: 'auto', locale: 'en-US' }), '');
  assert.equal(formatConvertedApprox(158.05, { displayCurrency: 'auto', locale: 'ja-JP' }), '≈ ¥24,024');
  assert.equal(formatConvertedApprox(158.05, { displayCurrency: 'auto', locale: 'ko-KR' }), '≈ ₩218,109');
  assert.equal(formatConvertedApprox(158.05, { displayCurrency: 'auto', locale: 'de-DE' }), '≈ €145');
  assert.equal(formatConvertedApprox(158.05, { displayCurrency: 'auto', locale: 'fr-FR' }), '≈ €145');
  assert.equal(formatConvertedApprox(158.05, { displayCurrency: 'auto', locale: 'vi-VN' }), '≈ ₫4,014,470');
  assert.equal(formatConvertedApprox(158.05, { displayCurrency: 'MYR', locale: 'en-US' }), '≈ RM703');
  assert.equal(formatConvertedApprox(158.05, { displayCurrency: 'USD', locale: 'zh-CN' }), '');

  // Small values, zero values, live FX rates, and backward-compatible formatCnyApprox
  assert.equal(formatCnyApprox(1.5, 7.2), '≈ ¥11');
  assert.equal(formatCnyApprox(0, 7.2), '≈ ¥0');
  assert.equal(formatConvertedApprox(1, { displayCurrency: 'EUR', locale: 'de-DE' }), '≈ €0.9');
  const liveFx = {
    source: 'frankfurter',
    date: '2026-11-26',
    rates: { MYR: 4.5, EUR: 0.95, JPY: 155 },
  };
  assert.equal(
    formatConvertedApprox(100, { displayCurrency: 'MYR', locale: 'en-US', fxStatus: liveFx }),
    '≈ RM450'
  );
  assert.equal(
    formatConvertedApprox(100, { displayCurrency: 'auto', locale: 'ja-JP', fxStatus: liveFx }),
    '≈ ¥15,500'
  );
  assert.equal(formatFxRateValue(7.2, false), '7.20');
  assert.equal(formatFxRateValue(1380, true), '1,380');
  const rateInfo = resolveCurrencyRateInfo('EUR', liveFx);
  assert.equal(rateInfo.isLive, true);
  assert.equal(rateInfo.rate, 0.95);
  assert.equal(rateInfo.date, '2026-11-26');
});

test('formatSecondaryCostApprox and formatFxRateCaption react immediately to setI18nLanguage switches', () => {
  try {
    setI18nLanguage('zh-CN');
    assert.equal(formatSecondaryCostApprox(158.05), '≈ ¥1138');
    assert.match(formatFxRateCaption(), /1 USD ≈ 7\.20 CNY/);

    setI18nLanguage('zh-TW');
    assert.equal(formatSecondaryCostApprox(158.05), '≈ NT$5137');
    assert.match(formatFxRateCaption(), /1 USD ≈ 33 TWD/);

    setI18nLanguage('ja-JP');
    assert.equal(formatSecondaryCostApprox(158.05), '≈ ¥24,024');
    assert.match(formatFxRateCaption(), /1 USD ≈ 152 JPY/);

    setI18nLanguage('ko-KR');
    assert.equal(formatSecondaryCostApprox(158.05), '≈ ₩218,109');
    assert.match(formatFxRateCaption(), /1 USD ≈ 1,380 KRW/);

    setI18nLanguage('de-DE');
    assert.equal(formatSecondaryCostApprox(158.05), '≈ €145');
    assert.match(formatFxRateCaption(), /1 USD ≈ 0\.92 EUR/);

    setI18nLanguage('fr-FR');
    assert.equal(formatSecondaryCostApprox(158.05), '≈ €145');

    setI18nLanguage('en-US');
    assert.equal(formatSecondaryCostApprox(158.05), '');
    assert.match(formatFxRateCaption(), /already in USD/i);

    // Manual override still shows currency in en-US
    assert.equal(formatSecondaryCostApprox(100, { displayCurrency: 'GBP' }), '≈ £79');
    assert.match(
      formatFxRateCaption({
        displayCurrency: 'GBP',
        fxStatus: { source: 'frankfurter', date: '2026-11-26', rates: { GBP: 0.78 } },
      }),
      /1 USD ≈ 0\.78 GBP \(Frankfurter · 2026-11-26\)/
    );
  } finally {
    setI18nLanguage('zh-CN');
  }
});

test('FX rates manager merges Frankfurter + ExchangeRate-API supplement, falls back offline, enforces 24h TTL, and sanitizes bad rates', async (t) => {
  assert.deepEqual(
    sanitizeFxRatesMap({ CNY: 7.25, EUR: -1, JPY: Infinity, MYR: '4.42', HACK: 99, KRW: 1e8 }),
    { CNY: 7.25, MYR: 4.42 }
  );
  const parsedF = parseFrankfurterResponse({ date: '2026-11-26', rates: { CNY: 7.23, EUR: 0.91 } });
  assert.equal(parsedF.source, 'frankfurter');
  assert.equal(parsedF.date, '2026-11-26');
  const parsedE = parseErApiResponse({
    result: 'success',
    time_last_update_utc: 'Thu, 26 Nov 2026 00:02:31 +0000',
    rates: { TWD: 32.3, VND: 25300 },
  });
  assert.equal(parsedE.source, 'er-api');
  assert.equal(parsedE.date, '2026-11-26');

  const tmpDir = createTempDir(t);
  const cacheFile = join(tmpDir, 'fx_rates_cache.json');
  let nowMs = 1_795_700_000_000;
  let fetchCalls = 0;
  let mode = 'mixed';

  const mockFetch = async (url) => {
    fetchCalls += 1;
    if (mode === 'offline') {
      throw new Error('network down');
    }
    if (url.includes('api.frankfurter.dev')) {
      if (mode === 'fallback_only') {
        return { ok: false, status: 503, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          base: 'USD',
          date: '2026-11-26',
          rates: { CNY: 7.26, EUR: 0.93, JPY: 153.5, MYR: 4.41 },
        }),
      };
    }
    if (url.includes('open.er-api.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          result: 'success',
          time_last_update_utc: 'Thu, 26 Nov 2026 00:00:01 +0000',
          rates: { CNY: 7.29, TWD: 32.4, KRW: 1390, VND: 25350 },
        }),
      };
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const mgr = createFxRatesManager({
    cacheFile,
    fetchImpl: mockFetch,
    nowFn: () => nowMs,
    isTestEnvFn: () => false,
  });

  // 1. Cold start without cache returns built-in static rates
  const cold = mgr.getStatus();
  assert.equal(cold.source, 'builtin');
  assert.equal(cold.rates.CNY, BUILTIN_FX_RATES.CNY);

  // 2. Primary + supplement merge (Frankfurter wins for CNY/EUR/JPY/MYR, ER-API fills TWD/KRW/VND)
  const synced = await mgr.sync({ force: false });
  assert.equal(synced.source, 'mixed');
  assert.equal(synced.date, '2026-11-26');
  assert.equal(synced.rates.CNY, 7.26, 'Primary Frankfurter rate takes priority over ER-API');
  assert.equal(synced.rates.TWD, 32.4, 'ER-API supplements TWD missing from ECB/Frankfurter');
  assert.equal(synced.rates.VND, 25350);
  assert.equal(synced.lastError, null);
  assert.equal(existsSync(cacheFile), true);
  assert.equal(JSON.parse(readFileSync(cacheFile, 'utf8')).source, 'mixed');

  // 3. Within 24h TTL, non-forced sync makes ZERO network calls
  const callsAfterFirst = fetchCalls;
  nowMs += 60 * 60 * 1000;
  await mgr.sync({ force: false });
  assert.equal(fetchCalls, callsAfterFirst);

  // 4. Separate manager instance loads disk cache synchronously with ZERO network calls
  const mgr2 = createFxRatesManager({
    cacheFile,
    fetchImpl: async () => {
      throw new Error('should not fetch when reading cache');
    },
    nowFn: () => nowMs,
    isTestEnvFn: () => false,
  });
  assert.equal(mgr2.getStatus().source, 'mixed');
  assert.equal(mgr2.getStatus().rates.TWD, 32.4);

  // 5. Frankfurter failure falls back cleanly to ExchangeRate-API
  mode = 'fallback_only';
  const fallbackRes = await mgr.sync({ force: true });
  assert.equal(fallbackRes.source, 'er-api');
  assert.equal(fallbackRes.rates.CNY, 7.29);
  assert.equal(fallbackRes.lastError, null);

  // 6. Complete offline failure preserves previous live rates and records lastError without throwing
  mode = 'offline';
  const offlineRes = await mgr.sync({ force: true });
  assert.equal(offlineRes.rates.CNY, 7.29);
  assert.ok(offlineRes.lastError);
});

test('displayCurrency integrates cleanly with settings schema, portable settings backup, and /api/fx-sync dispatch', async () => {
  const defaults = createDefaultSettingsObject();
  assert.equal(defaults.displayCurrency, 'auto');
  assert.equal(normalizeFullSettings({ displayCurrency: 'jpy' }).displayCurrency, 'JPY');
  assert.equal(normalizeFullSettings({ displayCurrency: 'bad' }).displayCurrency, 'auto');

  const exportedJson = buildExportableSettingsJson({ language: 'en-US', displayCurrency: 'MYR' });
  const parsed = parseImportedSettingsJson(exportedJson);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.patch.displayCurrency, 'MYR');

  const fakeFxStatus = {
    source: 'frankfurter',
    date: '2026-11-26',
    fetchedAtMs: 1_795_700_000_000,
    isSyncing: false,
    lastError: null,
    rates: { ...BUILTIN_FX_RATES, EUR: 0.91 },
  };
  const directRes = await dispatchBridgeApiRequest('/api/fx-sync', 'POST', {}, {
    syncFxRatesFn: async ({ force }) => {
      assert.equal(force, true);
      return fakeFxStatus;
    },
  });
  assert.equal(directRes.status, 200);
  const directBody = JSON.parse(directRes.body);
  assert.equal(directBody.ok, true);
  assert.equal(directBody.fxStatus.rates.EUR, 0.91);

  const compatRes = await dispatchBridgeApiRequest(
    '/api/settings',
    'POST',
    { __fxAction: 'sync' },
    { syncFxRatesFn: async () => fakeFxStatus }
  );
  assert.equal(compatRes.status, 200);
  assert.equal(JSON.parse(compatRes.body).fxStatus.source, 'frankfurter');
});
