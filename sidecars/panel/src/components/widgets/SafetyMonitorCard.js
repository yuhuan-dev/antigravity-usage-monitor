/**
 * @fileoverview Standalone native-styled Safety Monitor panel for `ConsumptionView` (`SafetyMonitorCard.js`).
 * Reuses `.panel`, `.panel-header`, `SegmentedControl`, `.status-tag`, and `.cons-unified-matrix`
 * so it matches `ConsumptionView` identically in both Classic and Modern UI.
 */

import { defineComponent } from '../../core/component.js';
import {
  h,
  patchAttr,
  patchClasses,
  patchStyleVar,
  patchText,
} from '../../core/domPatch.js';
import { formatPctNumber, formatTokens } from '../../core/formatters.js';
import { createSvgIcon } from '../../icons/SvgIcon.js';
import { getEffectiveLocale, t } from '../../i18n/index.js';
import { SegmentedControl } from '../ui/SegmentedControl.js';

const FLASH_LITE_5H_CAP_REF = 4400;

/**
 * 解析当前最高优先级的后台安全审查告警类型。
 *
 * @param {object|null|undefined} alerts
 * @returns {'fallback429'|'heavyBurst'|'nearLimit'|''}
 */
export function resolveSafetyMonitorAlert(alerts) {
  if (!alerts || typeof alerts !== 'object') return '';
  if (alerts.has429Fallback) return 'fallback429';
  if (alerts.hasHeavyBurst) return 'heavyBurst';
  if (alerts.nearFlashLiteLimit) return 'nearLimit';
  return '';
}

function formatSafetyBlockedDuration(rawMs) {
  const ms = Math.max(0, Number(rawMs) || 0);
  if (ms === 0) return '0s';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${Number(totalSec.toFixed(1))}s`;
  const mins = Math.floor(totalSec / 60);
  const remSec = Math.round(totalSec % 60);
  return remSec > 0 ? `${mins}m ${remSec}s` : `${mins}m`;
}

function getSafetyWindowCalls(win) {
  if (!win || typeof win !== 'object') return 0;
  return Math.max(0, Number(win.flashLiteCalls) || 0) + Math.max(0, Number(win.heavyCalls) || 0);
}

function getSafetyWindowOptions() {
  return [
    { value: '5h', label: t('safety.win5h') },
    { value: '24h', label: t('safety.win24h') },
  ];
}

function buildSafetyCardSignature({ enabled, winKey, safetyMonitor }) {
  const locale = getEffectiveLocale();
  if (!enabled) return `${locale}|off`;
  if (!safetyMonitor || typeof safetyMonitor !== 'object') return `${locale}|on|empty|${winKey}`;
  const w5 = safetyMonitor.window5h || {};
  const w24 = safetyMonitor.window24h || {};
  const al = safetyMonitor.alerts || {};
  return [
    locale,
    'on',
    winKey,
    w5.totalStreamGen || 0,
    w5.hiddenStreamGen || 0,
    w5.flashLiteCalls || 0,
    w5.heavyCalls || 0,
    w5.heavyTriggered || 0,
    w5.heavyTrajChars || 0,
    w5.flashLiteTrajChars || 0,
    w5.blockedMs || 0,
    w5.rateLimit429Count || 0,
    w5.fallbackCount || 0,
    w5.estInputTokensLower || 0,
    w5.estInputTokensUpper || 0,
    w24.totalStreamGen || 0,
    w24.hiddenStreamGen || 0,
    w24.flashLiteCalls || 0,
    w24.heavyCalls || 0,
    w24.heavyTriggered || 0,
    w24.heavyTrajChars || 0,
    w24.flashLiteTrajChars || 0,
    w24.blockedMs || 0,
    w24.rateLimit429Count || 0,
    w24.fallbackCount || 0,
    w24.estInputTokensLower || 0,
    w24.estInputTokensUpper || 0,
    al.has429Fallback ? 1 : 0,
    al.hasHeavyBurst ? 1 : 0,
    al.nearFlashLiteLimit ? 1 : 0,
  ].join('|');
}

export const SafetyMonitorCard = defineComponent({
  name: 'SafetyMonitorCard',
  setup({ onCleanup }) {
    let userPickedWin = '';
    let latestState = { enabled: false, safetyMonitor: null };
    let lastSig = '';

    const titleEl = h('span', { text: t('safety.cardTitle') });
    const alertTagEl = h('span', { className: 'status-tag', hidden: true });
    alertTagEl.hidden = true;

    const winSwitch = SegmentedControl({
      ariaLabel: t('safety.cardTitle'),
      modelValue: '5h',
      options: getSafetyWindowOptions(),
      onUpdateModelValue: (nextWin) => {
        const clean = nextWin === '24h' ? '24h' : '5h';
        if (userPickedWin === clean) return;
        userPickedWin = clean;
        render();
      },
    });

    // Top 3 hero columns (matching ConsumptionView overview matrix)
    const hiddenLabelEl = h('span', { className: 'text-muted', style: 'font-size: var(--fs-md);' });
    const hiddenHeroEl = h('strong', { className: 'cons-hero-num text-mono', text: '0%' });
    const hiddenSubEl = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);' });

    const callsLabelEl = h('span', { className: 'text-muted', style: 'font-size: var(--fs-md);' });
    const callsHeroEl = h('strong', { className: 'cons-hero-cost text-mono', text: '0 / 0' });
    const callsSubEl = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);' });

    const estLabelEl = h('span', { className: 'text-muted', style: 'font-size: var(--fs-md);' });
    const estHeroEl = h('strong', { className: 'cons-hero-cache text-mono', text: '--' });
    const estSubEl = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);' });

    // Bottom 3 detail columns (matching `.cons-matrix-bottom`)
    const flLabelEl = h('span', { className: 'cons-sub-label' });
    const flValEl = h('span', { className: 'cons-mid-num text-mono', text: '0' });
    const flMetaEl = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-sm);' });

    const heavyLabelEl = h('span', { className: 'cons-sub-label' });
    const heavyValEl = h('span', { className: 'cons-mid-num text-mono', text: '0' });
    const heavyMetaEl = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-sm);' });

    const rate429DotEl = h('span', { className: 'dot-swatch safety-dot-muted' });
    const rate429LabelEl = h('span', { className: 'cons-sub-label' });
    const rate429ValEl = h('span', { className: 'cons-mid-num text-mono', text: '0 / 0' });
    const rate429MetaEl = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-sm);' });

    // Sleek 3-segment composition bar
    const segVisibleEl = h('div', { className: 'safety-share-seg is-visible' });
    const segFlashEl = h('div', { className: 'safety-share-seg is-flash' });
    const segHeavyEl = h('div', { className: 'safety-share-seg is-heavy' });
    const shareBarEl = h('div', { className: 'safety-share-bar', hidden: true }, [
      segVisibleEl,
      segFlashEl,
      segHeavyEl,
    ]);
    shareBarEl.hidden = true;

    const adviceTextEl = h('span', { className: 'safety-advice-text' });
    const adviceEl = h('div', { className: 'safety-monitor-advice', hidden: true }, [
      createSvgIcon('warning', { size: 12, className: 'safety-advice-icon' }),
      adviceTextEl,
    ]);
    adviceEl.hidden = true;

    const noteEl = h('div', { className: 'safety-monitor-note' });

    const matrixEl = h('div', { className: 'cons-box cons-unified-matrix safety-monitor-matrix' }, [
      h('div', { className: 'cons-split-3' }, [
        h('div', { className: 'cons-col' }, [
          hiddenLabelEl,
          h('div', { className: 'cons-baseline' }, [hiddenHeroEl, hiddenSubEl]),
        ]),
        h('div', { className: 'cons-col is-bordered-col' }, [
          callsLabelEl,
          h('div', { className: 'cons-baseline' }, [callsHeroEl, callsSubEl]),
        ]),
        h('div', { className: 'cons-col is-bordered-col' }, [
          estLabelEl,
          h('div', { className: 'cons-baseline' }, [estHeroEl, estSubEl]),
        ]),
      ]),
      h('div', { className: 'cons-split-3 cons-matrix-bottom' }, [
        h('div', { className: 'cons-col' }, [
          h('div', { className: 'cons-sub-head' }, [
            h('span', { className: 'safety-sub-title' }, [
              h('span', { className: 'dot-swatch seg-cached' }),
              flLabelEl,
            ]),
          ]),
          h('div', { className: 'cons-baseline' }, [flValEl, flMetaEl]),
        ]),
        h('div', { className: 'cons-col is-bordered-col' }, [
          h('div', { className: 'cons-sub-head' }, [
            h('span', { className: 'safety-sub-title' }, [
              h('span', { className: 'dot-swatch seg-input' }),
              heavyLabelEl,
            ]),
          ]),
          h('div', { className: 'cons-baseline' }, [heavyValEl, heavyMetaEl]),
        ]),
        h('div', { className: 'cons-col is-bordered-col' }, [
          h('div', { className: 'cons-sub-head' }, [
            h('span', { className: 'safety-sub-title' }, [rate429DotEl, rate429LabelEl]),
          ]),
          h('div', { className: 'cons-baseline' }, [rate429ValEl, rate429MetaEl]),
        ]),
      ]),
    ]);

    const rootEl = h('section', { className: 'panel safety-monitor-panel', hidden: true }, [
      h('div', { className: 'panel-header safety-monitor-head' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('shield', { size: 13 }),
          titleEl,
          alertTagEl,
        ]),
        winSwitch.el,
      ]),
      matrixEl,
      shareBarEl,
      adviceEl,
      noteEl,
    ]);
    rootEl.hidden = true;

    function resolveActiveWindowKey(sm) {
      if (userPickedWin === '5h' || userPickedWin === '24h') return userPickedWin;
      const c5h = getSafetyWindowCalls(sm?.window5h);
      const c24h = getSafetyWindowCalls(sm?.window24h);
      if (c5h === 0 && c24h > 0) return '24h';
      return '5h';
    }

    function render() {
      const { enabled, safetyMonitor } = latestState;
      const winKey = resolveActiveWindowKey(safetyMonitor);
      const sig = buildSafetyCardSignature({ enabled, winKey, safetyMonitor });
      if (sig === lastSig) return;
      lastSig = sig;

      const shouldShow = enabled === true;
      rootEl.hidden = !shouldShow;
      patchAttr(rootEl, 'hidden', !shouldShow);
      if (!shouldShow) return;

      const alertKind = resolveSafetyMonitorAlert(safetyMonitor?.alerts);
      const activeWin =
        winKey === '24h' ? safetyMonitor?.window24h || {} : safetyMonitor?.window5h || {};

      patchText(titleEl, t('safety.cardTitle'));
      winSwitch.setProps({
        ariaLabel: t('safety.cardTitle'),
        modelValue: winKey,
        options: getSafetyWindowOptions(),
      });

      const badgeText =
        alertKind === 'fallback429'
          ? t('safety.alert429Badge')
          : alertKind === 'heavyBurst'
            ? t('safety.alertBurstBadge')
            : alertKind === 'nearLimit'
              ? t('safety.alertLimitBadge')
              : '';
      alertTagEl.hidden = !badgeText;
      patchAttr(alertTagEl, 'hidden', !badgeText);
      patchText(alertTagEl, badgeText);
      patchClasses(alertTagEl, {
        'state-danger': alertKind === 'fallback429',
        'state-warn': alertKind === 'heavyBurst' || alertKind === 'nearLimit',
      });

      const flCalls = Math.max(0, Number(activeWin.flashLiteCalls) || 0);
      const heavyCalls = Math.max(0, Number(activeWin.heavyCalls) || 0);
      const totalStream = Math.max(0, Number(activeWin.totalStreamGen) || 0);
      const hiddenStream = Math.max(0, Number(activeWin.hiddenStreamGen) || 0);
      const hiddenPctNum = totalStream > 0 ? (hiddenStream / totalStream) * 100 : 0;
      const hiddenPctStr = totalStream > 0 ? `${formatPctNumber(hiddenPctNum)}%` : '0%';
      const falseAlarmPct =
        heavyCalls > 0
          ? formatPctNumber(
              ((heavyCalls - Math.max(0, Number(activeWin.heavyTriggered) || 0)) / heavyCalls) * 100
            )
          : '';
      const totalChars =
        Math.max(0, Number(activeWin.heavyTrajChars) || 0) +
        Math.max(0, Number(activeWin.flashLiteTrajChars) || 0);
      const lowTok = Math.max(0, Number(activeWin.estInputTokensLower) || 0);
      const highTok = Math.max(0, Number(activeWin.estInputTokensUpper) || 0);
      const r429 = Math.max(0, Number(activeWin.rateLimit429Count) || 0);
      const fb = Math.max(0, Number(activeWin.fallbackCount) || 0);
      const blockedStr = formatSafetyBlockedDuration(activeWin.blockedMs);

      patchText(hiddenLabelEl, t('safety.metricHiddenRatio'));
      patchText(hiddenHeroEl, hiddenPctStr);
      patchText(
        hiddenSubEl,
        totalStream > 0 ? `${hiddenStream} / ${totalStream}` : `${hiddenStream}`
      );

      patchText(callsLabelEl, t('safety.metricCallsSplit'));
      patchText(callsHeroEl, `${flCalls} / ${heavyCalls}`);
      patchText(
        callsSubEl,
        heavyCalls > 0 ? t('safety.falseAlarmSuffix', { pct: falseAlarmPct }) : winKey
      );

      patchText(estLabelEl, t('safety.metricEstTokens'));
      patchText(estHeroEl, highTok > 0 ? `~${formatTokens(lowTok)}–${formatTokens(highTok)}` : '--');
      patchText(
        estSubEl,
        totalChars > 0 ? `${formatTokens(totalChars)} ${t('safety.charsUnit')}` : ''
      );

      patchText(flLabelEl, t('safety.metricFlashLite'));
      patchText(flValEl, String(flCalls));
      patchText(flMetaEl, winKey === '5h' ? `/ ${FLASH_LITE_5H_CAP_REF}` : '');

      patchText(heavyLabelEl, t('safety.metricHeavy'));
      patchText(heavyValEl, String(heavyCalls));
      patchText(heavyMetaEl, blockedStr !== '0s' ? `· ${blockedStr}` : '');

      const hasRateAlert = r429 > 0 || fb > 0;
      patchClasses(rate429DotEl, {
        'safety-dot-danger': hasRateAlert,
        'safety-dot-muted': !hasRateAlert,
      });
      patchText(rate429LabelEl, t('safety.metric429Fallback'));
      patchText(rate429ValEl, `${r429} / ${fb}`);
      patchClasses(rate429ValEl, { 'is-alert': hasRateAlert });
      patchText(rate429MetaEl, '');

      const hasBar = totalStream > 0 && (flCalls > 0 || heavyCalls > 0);
      shareBarEl.hidden = !hasBar;
      patchAttr(shareBarEl, 'hidden', !hasBar);
      if (hasBar) {
        const effTotal = Math.max(totalStream, flCalls + heavyCalls);
        const visPct = Math.max(0, ((effTotal - flCalls - heavyCalls) / effTotal) * 100);
        const flPct = Math.max(0, (flCalls / effTotal) * 100);
        const hvPct = Math.max(0, 100 - visPct - flPct);
        patchStyleVar(segVisibleEl, '--seg-w', `${+visPct.toFixed(2)}%`);
        patchStyleVar(segFlashEl, '--seg-w', `${+flPct.toFixed(2)}%`);
        patchStyleVar(segHeavyEl, '--seg-w', `${+hvPct.toFixed(2)}%`);
      }

      const adviceText =
        alertKind === 'fallback429'
          ? t('safety.alert429Advice')
          : alertKind === 'heavyBurst'
            ? t('safety.alertBurstAdvice')
            : alertKind === 'nearLimit'
              ? t('safety.alertLimitAdvice')
              : '';
      adviceEl.hidden = !adviceText;
      patchAttr(adviceEl, 'hidden', !adviceText);
      patchText(adviceTextEl, adviceText);
      patchClasses(adviceEl, {
        'tone-danger': alertKind === 'fallback429',
        'tone-warn': alertKind === 'heavyBurst' || alertKind === 'nearLimit',
      });

      const hasAnyCalls = flCalls > 0 || heavyCalls > 0;
      patchText(noteEl, hasAnyCalls ? t('safety.disclaimer') : t('safety.emptyWindow'));
    }

    function update({ enabled = false, safetyMonitor = null } = {}) {
      latestState = { enabled: enabled === true, safetyMonitor: safetyMonitor || null };
      render();
    }

    function refreshLabels() {
      lastSig = '';
      render();
    }

    onCleanup(() => {
      winSwitch.destroy();
    });

    return {
      el: rootEl,
      refs: {
        update,
        refreshLabels,
        winSwitch,
        alertTagEl,
        adviceEl,
        shareBarEl,
      },
    };
  },
});
