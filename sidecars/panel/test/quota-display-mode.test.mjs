import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DEFAULT_QUOTA_DISPLAY_MODE,
  QUOTA_DISPLAY_MODES,
  normalizeFullSettings,
  normalizeQuotaDisplayMode,
} from '../backend/config.mjs';
import {
  buildExportableSettingsJson,
  parseImportedSettingsJson,
} from '../src/core/settingsBackup.js';
import { createMockDom } from './mock-dom.mjs';
import { SUPPORTED_LOCALES } from '../shared/settings-normalization.mjs';

test('quotaDisplayMode defaults to used, normalizes valid/invalid inputs, re-exports from config, and round-trips through backup', () => {
  assert.deepEqual([...QUOTA_DISPLAY_MODES], ['used', 'remaining']);
  assert.equal(DEFAULT_QUOTA_DISPLAY_MODE, 'used');
  assert.equal(normalizeQuotaDisplayMode(undefined), 'used');
  assert.equal(normalizeQuotaDisplayMode('invalid'), 'used');
  assert.equal(normalizeQuotaDisplayMode('remaining'), 'remaining');
  assert.equal(normalizeQuotaDisplayMode(' REMAINING '), 'remaining');

  const def = normalizeFullSettings({});
  assert.equal(def.quotaDisplayMode, 'used');

  const rem = normalizeFullSettings({ quotaDisplayMode: 'remaining' });
  assert.equal(rem.quotaDisplayMode, 'remaining');

  const exportedRem = buildExportableSettingsJson(rem);
  const parsedRem = parseImportedSettingsJson(exportedRem);
  assert.equal(parsedRem.ok, true);
  assert.equal(parsedRem.patch.quotaDisplayMode, 'remaining');

  const exportedUsed = buildExportableSettingsJson(def);
  const parsedUsed = parseImportedSettingsJson(exportedUsed);
  assert.equal(parsedUsed.ok, true);
  assert.equal(parsedUsed.patch.quotaDisplayMode, 'used');
});

test('QuotaPoolsWidget renders remaining percentage, remaining bar fill, warning tones, and legend across all supported locales', async () => {
  const { document } = createMockDom();
  const origDocument = globalThis.document;
  const origWindow = globalThis.window;
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 960,
    innerHeight: 720,
    addEventListener() {},
    removeEventListener() {},
    location: { origin: 'http://127.0.0.1:0', href: 'http://127.0.0.1:0/' },
  };

  try {
    const [{ setI18nLanguage, t }, { QuotaPoolsWidget }] = await Promise.all([
      import('../src/i18n/index.js'),
      import('../src/components/widgets/QuotaPoolsWidget.js'),
    ]);

    const widget = QuotaPoolsWidget();
    const basePools = [
      {
        poolKey: 'Gemini',
        poolLabel: 'Gemini',
        family: 'Gemini',
        usedPct: 7.6,
        remainingPct: 92.4,
        reservedPct: 1.5,
        reservedLeaseCount: 1,
        resetTime: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
        weeklyUsedPct: 86.0,
        weeklyRemainingPct: 14.0,
        weeklyReservedPct: 0.5,
        weeklyReservedLeaseCount: 1,
        weeklyResetTime: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
      },
    ];
    const baseData = {
      account: { tierName: 'Google AI Pro', planName: 'Pro' },
      quotas: { pools: basePools, weekly: { isOfficial: true } },
    };

    // zh-CN remaining mode with reservation OFF
    setI18nLanguage('zh-CN');
    widget.refs.update({
      data: {
        ...baseData,
        settings: { experimentalQuotaReservation: false, quotaDisplayMode: 'remaining' },
      },
      minuteTick: 1,
    });
    const metas = widget.el.querySelectorAll('.quota-win-meta');
    assert.equal(metas.length, 2);
    assert.match(metas[0].textContent, /· 剩余 92\.4%$/);
    assert.match(metas[1].textContent, /· 剩余 14\.0%$/);

    const fills = widget.el.querySelectorAll('.progress-fill');
    assert.equal(fills[0].style.getPropertyValue('--fill-w'), '92.4%');
    assert.equal(fills[0].classList.contains('tone-warn'), false);
    assert.equal(fills[0].classList.contains('tone-danger'), false);
    assert.equal(fills[1].style.getPropertyValue('--fill-w'), '14%');
    assert.equal(fills[1].classList.contains('tone-danger'), true);

    // Reservation ON: legend switches to 剩余 / 预占, reserved bar sits next to remaining
    widget.refs.update({
      data: {
        ...baseData,
        settings: { experimentalQuotaReservation: true, quotaDisplayMode: 'remaining' },
      },
      minuteTick: 1,
    });
    const legendEl = widget.el.querySelector('.quota-reserve-legend');
    assert.equal(legendEl.hidden, false);
    assert.match(legendEl.textContent, /剩余/);
    assert.match(legendEl.textContent, /预占/);
    const rsvBars = widget.el.querySelectorAll('.progress-fill-reserved');
    assert.equal(fills[0].style.getPropertyValue('--fill-w'), '92.4%');
    assert.equal(rsvBars[0].style.getPropertyValue('--reserved-w'), '1.5%');
    assert.equal(rsvBars[0].classList.contains('is-active'), true);

    // Spot-check curated wording on core locales, and verify every registered locale renders remaining mode cleanly
    const localeChecks = new Map([
      ['zh-CN', [/· 剩余 92\.4%$/, /剩余/]],
      ['zh-TW', [/· 剩餘 92\.4%$/, /剩餘/]],
      ['en-US', [/· 92\.4% left$/, /Remaining/]],
      ['ja-JP', [/· 残り 92\.4%$/, /残り/]],
      ['ko-KR', [/· 잔여 92\.4%$/, /잔여/]],
      ['de-DE', [/· 92\.4% frei$/, /Verbleibend/]],
      ['fr-FR', [/· 92\.4% restant$/, /Restant/]],
    ]);
    for (let i = 0; i < SUPPORTED_LOCALES.length; i += 1) {
      const locale = SUPPORTED_LOCALES[i];
      setI18nLanguage(locale);
      widget.refs.update({
        data: {
          ...baseData,
          settings: { experimentalQuotaReservation: true, quotaDisplayMode: 'remaining' },
        },
        minuteTick: 2 + i,
      });
      const expected = localeChecks.get(locale);
      if (expected) {
        assert.match(metas[0].textContent, expected[0], `${locale} remaining text`);
        assert.match(legendEl.textContent, expected[1], `${locale} remaining legend`);
      } else {
        assert.ok(metas[0].textContent.includes('92.4%'), `${locale} remaining pct`);
        assert.ok(legendEl.textContent.includes(t('quota.legendRemaining')), `${locale} remaining legend`);
      }
    }

    // Switch back to used mode restores original display
    setI18nLanguage('zh-CN');
    widget.refs.update({
      data: {
        ...baseData,
        settings: { experimentalQuotaReservation: false, quotaDisplayMode: 'used' },
      },
      minuteTick: 20,
    });
    assert.match(metas[0].textContent, /· 已用 7\.6%$/);
    assert.equal(fills[0].style.getPropertyValue('--fill-w'), '7.6%');
    assert.equal(legendEl.hidden, true, 'solo pool with reservation off hides legend');
    assert.equal(
      legendEl.querySelector('.quota-legend-item.is-external-item').hidden,
      true,
      'solo pool hides non-self legend item'
    );

    // Shared account externalUsedPct renders dashed theme-colored segment, legend item, and tooltips in BOTH used & remaining modes
    const sharedPools = [
      {
        poolKey: 'Gemini',
        poolLabel: 'Gemini',
        family: 'Gemini',
        usedPct: 24.0,
        remainingPct: 76.0,
        externalUsedPct: 14.0,
        reservedPct: 2.0,
        reservedLeaseCount: 1,
        resetTime: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
        weeklyUsedPct: 40.0,
        weeklyRemainingPct: 60.0,
        weeklyExternalUsedPct: 25.0,
        weeklyReservedPct: 0,
        weeklyReservedLeaseCount: 0,
        weeklyResetTime: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
      },
    ];
    const sharedData = {
      account: { tierName: 'Google AI Ultra', planName: '20x' },
      quotas: { pools: sharedPools, weekly: { isOfficial: true } },
    };

    // Used mode with both external + reserved
    widget.refs.update({
      data: {
        ...sharedData,
        settings: { experimentalQuotaReservation: true, quotaDisplayMode: 'used' },
      },
      minuteTick: 21,
    });
    const extBars = widget.el.querySelectorAll('.progress-fill-external');
    const rsvBarsShared = widget.el.querySelectorAll('.progress-fill-reserved');
    const tracksShared = widget.el.querySelectorAll('.progress-track');
    assert.equal(extBars.length, 2);
    assert.equal(tracksShared[0].classList.contains('is-remaining-mode'), false);
    // 5h: self = 24 - 14 - 2 = 8%, ext = 14%, rsv = 2% (sum = 24%)
    assert.equal(fills[0].style.getPropertyValue('--fill-w'), '8%');
    assert.equal(extBars[0].style.getPropertyValue('--external-w'), '14%');
    assert.equal(extBars[0].classList.contains('is-active'), true);
    assert.equal(extBars[0].classList.contains('has-sep'), true);
    assert.equal(rsvBarsShared[0].style.getPropertyValue('--reserved-w'), '2%');
    assert.equal(rsvBarsShared[0].classList.contains('is-active'), true);
    assert.equal(rsvBarsShared[0].classList.contains('has-sep'), true);
    assert.match(metas[0].getAttribute('title') || '', /本机自用约 8\.0%.*非自用约 14\.0%.*预占约 2\.0%/);
    // weekly: self = 40 - 25 = 15%, ext = 25%, rsv = 0%
    assert.equal(fills[1].style.getPropertyValue('--fill-w'), '15%');
    assert.equal(extBars[1].style.getPropertyValue('--external-w'), '25%');
    assert.equal(rsvBarsShared[1].classList.contains('is-active'), false);
    assert.match(metas[1].getAttribute('title') || '', /本机自用约 15\.0%.*非自用.*25\.0%/);

    // Legend shows 实占 + 非自用 + 预占
    assert.equal(legendEl.hidden, false);
    assert.equal(legendEl.querySelector('.quota-legend-item.is-external-item').hidden, false);
    assert.equal(legendEl.querySelector('.quota-legend-item.is-reserved-item').hidden, false);
    assert.ok(legendEl.querySelector('.quota-legend-line.is-external'));
    assert.match(legendEl.textContent, /非自用/);

    // Reservation OFF with external usage present: legend stays visible with 实占 + 非自用, hiding 预占
    widget.refs.update({
      data: {
        ...sharedData,
        settings: { experimentalQuotaReservation: false, quotaDisplayMode: 'used' },
      },
      minuteTick: 22,
    });
    assert.equal(legendEl.hidden, false);
    assert.equal(legendEl.querySelector('.quota-legend-item.is-external-item').hidden, false);
    assert.equal(legendEl.querySelector('.quota-legend-item.is-reserved-item').hidden, true);
    assert.equal(fills[0].style.getPropertyValue('--fill-w'), '10%');
    assert.equal(extBars[0].style.getPropertyValue('--external-w'), '14%');
    assert.equal(rsvBarsShared[0].classList.contains('is-active'), false);

    // Remaining mode with external + reserved: non-overlapping widths summing <= 100%
    widget.refs.update({
      data: {
        ...sharedData,
        settings: { experimentalQuotaReservation: true, quotaDisplayMode: 'remaining' },
      },
      minuteTick: 23,
    });
    assert.equal(tracksShared[0].classList.contains('is-remaining-mode'), true);
    assert.equal(fills[0].style.getPropertyValue('--fill-w'), '76%');
    assert.equal(rsvBarsShared[0].style.getPropertyValue('--reserved-w'), '2%');
    assert.equal(extBars[0].style.getPropertyValue('--external-w'), '14%');
    assert.equal(extBars[0].classList.contains('is-active'), true);
    const totalRemWidths =
      parseFloat(fills[0].style.getPropertyValue('--fill-w')) +
      parseFloat(rsvBarsShared[0].style.getPropertyValue('--reserved-w')) +
      parseFloat(extBars[0].style.getPropertyValue('--external-w'));
    assert.ok(totalRemWidths <= 100, `remaining mode widths must not exceed 100% (got ${totalRemWidths})`);

    // English locale check for 非自用 -> Non-self
    setI18nLanguage('en-US');
    widget.refs.update({
      data: {
        ...sharedData,
        settings: { experimentalQuotaReservation: true, quotaDisplayMode: 'used' },
      },
      minuteTick: 24,
    });
    assert.match(legendEl.querySelector('.quota-legend-item.is-external-item').textContent, /Non-self/);
    assert.match(metas[0].getAttribute('title') || '', /Local self ~8\.0%.*Non-self ~14\.0%.*Reserved ~2\.0%/);

    // Built styles.css renders external segment and legend swatch as current theme-color dashed lines
    const builtStyles = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    assert.match(
      builtStyles,
      /\.progress-fill-external\s*\{[^}]*repeating-linear-gradient\([\s\S]*?var\(--accent-primary\)/
    );
    assert.match(
      builtStyles,
      /\.quota-legend-line\.is-external\s*\{[^}]*repeating-linear-gradient\([\s\S]*?var\(--accent-primary\)/
    );

    widget.destroy();
  } finally {
    globalThis.document = origDocument;
    globalThis.window = origWindow;
  }
});

test('SettingsStructureTab quotaDisplayMode toggle updates both Overview and Hover previews and resets cleanly', async () => {
  const { document } = createMockDom();
  const origDocument = globalThis.document;
  const origWindow = globalThis.window;
  const origFetch = globalThis.fetch;
  const savedPatches = [];

  globalThis.document = document;
  globalThis.window = {
    innerWidth: 960,
    innerHeight: 720,
    location: { origin: 'http://127.0.0.1:41234', href: 'http://127.0.0.1:41234/' },
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('/api/settings') && init.method === 'POST') {
      const patch = JSON.parse(init.body || '{}');
      savedPatches.push(patch);
      return { ok: true, json: async () => ({ ...patch }) };
    }
    return { ok: true, json: async () => ({}) };
  };

  let tab = null;
  try {
    const [{ setI18nLanguage }, { uiStore }, { SettingsStructureTab }] = await Promise.all([
      import('../src/i18n/index.js'),
      import('../src/store/uiStore.js'),
      import('../src/views/settings/SettingsStructureTab.js'),
    ]);
    setI18nLanguage('zh-CN');
    uiStore.setState({
      activeView: 'settings',
      settingsSubTab: 'structure',
      settingsStructureTab: 'overview',
    });

    tab = SettingsStructureTab({ onLayoutChange: () => {} });
    tab.refs.renderSettings({ quotaDisplayMode: 'used' });

    const ovBefore = tab.refs.overviewSection.el.querySelectorAll('.quota-win-meta');
    assert.ok(ovBefore.length > 0 && /已用/.test(ovBefore[0].textContent));

    // Switch to Remaining
    const quotaBtns = tab.refs.quotaDisplayModeToggle.el.querySelectorAll('.seg-btn');
    assert.deepEqual(
      quotaBtns.map((b) => b.textContent),
      ['已用', '剩余']
    );
    quotaBtns[1].dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 15));
    assert.deepEqual(savedPatches[0], { quotaDisplayMode: 'remaining' });

    const ovAfter = tab.refs.overviewSection.el.querySelectorAll('.quota-win-meta');
    assert.ok(ovAfter.length > 0 && /剩余/.test(ovAfter[0].textContent));

    // Switching to Hover preview pane also reflects remaining mode
    uiStore.setState({ settingsStructureTab: 'hover' });
    await new Promise((r) => setTimeout(r, 15));
    const hoverAfter = tab.refs.hoverSection.el.querySelectorAll('.quota-win-meta');
    assert.ok(hoverAfter.length > 0 && /剩余/.test(hoverAfter[0].textContent));

    // Reset Overview section restores used mode
    uiStore.setState({ settingsStructureTab: 'overview' });
    await new Promise((r) => setTimeout(r, 15));
    tab.refs.overviewSection.el
      .querySelector('.btn-ghost-sm')
      .dispatchEvent({ type: 'click', stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(savedPatches[1]?.quotaDisplayMode, 'used');
    const ovReset = tab.refs.overviewSection.el.querySelectorAll('.quota-win-meta');
    assert.ok(ovReset.length > 0 && /已用/.test(ovReset[0].textContent));
  } finally {
    tab?.destroy?.();
    globalThis.document = origDocument;
    globalThis.window = origWindow;
    globalThis.fetch = origFetch;
  }
});
