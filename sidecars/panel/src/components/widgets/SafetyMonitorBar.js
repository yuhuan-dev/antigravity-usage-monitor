/**
 * @fileoverview Restrained collapsible Safety Monitor status bar (`SafetyMonitorBar.js`).
 * Surfaces hidden background safety checks (`sir_flash_lite` / `gemini-4-hydrogen-sonar`)
 * inside `QuotaPoolsWidget` with honest separation between exact log observations and
 * lower/upper input token estimates, plus targeted alerts on 429 fallback, heavy burst,
 * or 5h Flash Lite ceiling pressure.
 */

import { defineComponent } from '../../core/component.js';
import { h, patchAttr, patchClasses, patchText } from '../../core/domPatch.js';
import { formatPctNumber, formatTokens } from '../../core/formatters.js';
import { createSvgIcon, patchSvgIcon } from '../../icons/SvgIcon.js';
import { getEffectiveLocale, t } from '../../i18n/index.js';

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

function formatBlockedDuration(rawMs) {
  const ms = Math.max(0, Number(rawMs) || 0);
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${Number(totalSec.toFixed(1))}s`;
  const mins = Math.floor(totalSec / 60);
  const remSec = Math.round(totalSec % 60);
  return remSec > 0 ? `${mins}m ${remSec}s` : `${mins}m`;
}

function getWindowCalls(win) {
  if (!win || typeof win !== 'object') return 0;
  return Math.max(0, Number(win.flashLiteCalls) || 0) + Math.max(0, Number(win.heavyCalls) || 0);
}

function buildSafetyBarSignature({ enabled, compactHover, expanded, winKey, safetyMonitor }) {
  const locale = getEffectiveLocale();
  if (!enabled || !safetyMonitor || typeof safetyMonitor !== 'object') {
    return `${locale}|off|${compactHover ? 1 : 0}`;
  }
  const w5 = safetyMonitor.window5h || {};
  const w24 = safetyMonitor.window24h || {};
  const al = safetyMonitor.alerts || {};
  return [
    locale,
    compactHover ? 1 : 0,
    expanded ? 1 : 0,
    winKey,
    w5.totalStreamGen || 0,
    w5.hiddenStreamGen || 0,
    w5.flashLiteCalls || 0,
    w5.heavyCalls || 0,
    w5.heavyTriggered || 0,
    w5.heavyTrajChars || 0,
    w5.blockedMs || 0,
    w5.rateLimit429Count || 0,
    w5.fallbackCount || 0,
    w24.totalStreamGen || 0,
    w24.hiddenStreamGen || 0,
    w24.flashLiteCalls || 0,
    w24.heavyCalls || 0,
    w24.heavyTriggered || 0,
    w24.heavyTrajChars || 0,
    w24.blockedMs || 0,
    w24.rateLimit429Count || 0,
    w24.fallbackCount || 0,
    al.has429Fallback ? 1 : 0,
    al.hasHeavyBurst ? 1 : 0,
    al.nearFlashLiteLimit ? 1 : 0,
  ].join('|');
}

function createSafetyMetricCell() {
  const labelEl = h('span', { className: 'safety-monitor-cell-k' });
  const valueEl = h('span', { className: 'safety-monitor-cell-v text-mono' });
  const el = h('div', { className: 'safety-monitor-cell' }, [labelEl, valueEl]);
  return { el, labelEl, valueEl };
}

export const SafetyMonitorBar = defineComponent({
  name: 'SafetyMonitorBar',
  setup({ props }) {
    const compactHover = Boolean(props.compactHover);
    let expanded = false;
    let userPickedWin = '';
    let latestState = { enabled: true, safetyMonitor: null };
    let lastSig = '';

    const leadIconEl = createSvgIcon('shield', { size: 12, className: 'safety-monitor-icon' });
    const titleEl = h('span', { className: 'safety-monitor-title' });
    const alertBadgeEl = h('span', { className: 'safety-monitor-badge', hidden: true });
    const summaryEl = h('span', { className: 'safety-monitor-summary text-mono' });
    const chevronEl = createSvgIcon('chevron-down', {
      size: 11,
      className: 'safety-monitor-chevron',
    });

    const headBtn = h(
      'button',
      {
        type: 'button',
        className: 'safety-monitor-head',
        'aria-expanded': 'false',
        onClick: (ev) => {
          if (compactHover) return;
          ev?.stopPropagation?.();
          expanded = !expanded;
          render();
        },
      },
      [
        h('span', { className: 'safety-monitor-head-left' }, [leadIconEl, titleEl, alertBadgeEl]),
        h('span', { className: 'safety-monitor-head-right' }, [
          summaryEl,
          ...(compactHover ? [] : [chevronEl]),
        ]),
      ]
    );

    const adviceEl = h('div', { className: 'safety-monitor-advice', hidden: true });

    const win5hBtn = h('button', {
      type: 'button',
      className: 'safety-monitor-win-btn is-active',
      'data-win': '5h',
      onClick: (ev) => {
        ev?.stopPropagation?.();
        if (userPickedWin === '5h') return;
        userPickedWin = '5h';
        render();
      },
    });
    const win24hBtn = h('button', {
      type: 'button',
      className: 'safety-monitor-win-btn',
      'data-win': '24h',
      onClick: (ev) => {
        ev?.stopPropagation?.();
        if (userPickedWin === '24h') return;
        userPickedWin = '24h';
        render();
      },
    });
    const detailsScopeEl = h('span', { className: 'safety-monitor-details-scope' });
    const cellHiddenRatio = createSafetyMetricCell();
    const cellFlashLite = createSafetyMetricCell();
    const cellHeavy = createSafetyMetricCell();
    const cellTrajBlock = createSafetyMetricCell();
    const cell429Fallback = createSafetyMetricCell();
    const cellEstTokens = createSafetyMetricCell();
    const disclaimerEl = h('div', { className: 'safety-monitor-note' });

    const detailsEl = h('div', { className: 'safety-monitor-details', hidden: true }, [
      h('div', { className: 'safety-monitor-details-head' }, [
        detailsScopeEl,
        h('div', { className: 'safety-monitor-win-tabs', role: 'tablist' }, [win5hBtn, win24hBtn]),
      ]),
      h('div', { className: 'safety-monitor-grid' }, [
        cellHiddenRatio.el,
        cellFlashLite.el,
        cellHeavy.el,
        cellTrajBlock.el,
        cell429Fallback.el,
        cellEstTokens.el,
      ]),
      disclaimerEl,
    ]);

    const rootEl = h(
      'div',
      {
        className: `safety-monitor-bar${compactHover ? ' is-compact-hover' : ''}`,
        hidden: true,
      },
      [headBtn, adviceEl, ...(compactHover ? [] : [detailsEl])]
    );
    rootEl.hidden = true;

    function resolveActiveWindowKey(sm) {
      if (userPickedWin === '5h' || userPickedWin === '24h') return userPickedWin;
      const c5h = getWindowCalls(sm?.window5h);
      const c24h = getWindowCalls(sm?.window24h);
      if (c5h === 0 && c24h > 0) return '24h';
      return '5h';
    }

    function render() {
      const { enabled, safetyMonitor } = latestState;
      const winKey = resolveActiveWindowKey(safetyMonitor);
      const sig = buildSafetyBarSignature({
        enabled,
        compactHover,
        expanded,
        winKey,
        safetyMonitor,
      });
      if (sig === lastSig) return;
      lastSig = sig;

      const alertKind = resolveSafetyMonitorAlert(safetyMonitor?.alerts);
      const calls5h = getWindowCalls(safetyMonitor?.window5h);
      const calls24h = getWindowCalls(safetyMonitor?.window24h);
      const hasAnyActivity = calls5h > 0 || calls24h > 0 || Boolean(alertKind);
      const shouldShow = Boolean(
        enabled && safetyMonitor && hasAnyActivity && (!compactHover || Boolean(alertKind))
      );

      rootEl.hidden = !shouldShow;
      patchAttr(rootEl, 'hidden', !shouldShow);
      if (!shouldShow) {
        return;
      }

      const isDanger = alertKind === 'fallback429';
      const isWarn = alertKind === 'heavyBurst' || alertKind === 'nearLimit';
      patchClasses(rootEl, {
        'is-expanded': !compactHover && expanded,
        'tone-danger': isDanger,
        'tone-warn': isWarn,
      });

      const activeWin =
        winKey === '24h' ? safetyMonitor.window24h || {} : safetyMonitor.window5h || {};
      const flCalls = Math.max(0, Number(activeWin.flashLiteCalls) || 0);
      const heavyCalls = Math.max(0, Number(activeWin.heavyCalls) || 0);
      const totalStream = Math.max(0, Number(activeWin.totalStreamGen) || 0);
      const hiddenStream = Math.max(0, Number(activeWin.hiddenStreamGen) || 0);
      const hiddenPct = totalStream > 0 ? formatPctNumber((hiddenStream / totalStream) * 100) : '';

      patchSvgIcon(leadIconEl, alertKind ? 'warning' : 'shield');
      patchText(titleEl, t('safety.title', { win: winKey }));

      const badgeText =
        alertKind === 'fallback429'
          ? t('safety.alert429Badge')
          : alertKind === 'heavyBurst'
            ? t('safety.alertBurstBadge')
            : alertKind === 'nearLimit'
              ? t('safety.alertLimitBadge')
              : '';
      alertBadgeEl.hidden = !badgeText;
      patchAttr(alertBadgeEl, 'hidden', !badgeText);
      patchText(alertBadgeEl, badgeText);

      const summaryText = hiddenPct
        ? t('safety.summaryCompact', { fl: flCalls, heavy: heavyCalls, pct: hiddenPct })
        : t('safety.summaryNoRatio', { fl: flCalls, heavy: heavyCalls });
      patchText(summaryEl, summaryText);

      if (!compactHover) {
        patchSvgIcon(chevronEl, expanded ? 'chevron-up' : 'chevron-down');
        patchAttr(headBtn, 'aria-expanded', expanded ? 'true' : 'false');
        patchAttr(headBtn, 'aria-label', expanded ? t('safety.collapseAria') : t('safety.expandAria'));
      } else {
        patchAttr(headBtn, 'disabled', true);
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
      patchText(adviceEl, adviceText);

      if (compactHover) return;

      detailsEl.hidden = !expanded;
      patchAttr(detailsEl, 'hidden', !expanded);
      if (!expanded) return;

      patchText(detailsScopeEl, t('safety.observedScope'));
      patchText(win5hBtn, t('safety.win5h'));
      patchText(win24hBtn, t('safety.win24h'));
      patchClasses(win5hBtn, { 'is-active': winKey === '5h' });
      patchClasses(win24hBtn, { 'is-active': winKey === '24h' });
      patchAttr(win5hBtn, 'aria-selected', winKey === '5h' ? 'true' : 'false');
      patchAttr(win24hBtn, 'aria-selected', winKey === '24h' ? 'true' : 'false');

      patchText(cellHiddenRatio.labelEl, t('safety.metricHiddenRatio'));
      patchText(
        cellHiddenRatio.valueEl,
        totalStream > 0 ? `${hiddenStream} / ${totalStream} (${hiddenPct}%)` : `${hiddenStream}`
      );

      patchText(cellFlashLite.labelEl, t('safety.metricFlashLite'));
      patchText(
        cellFlashLite.valueEl,
        winKey === '5h' ? `${flCalls} / ${FLASH_LITE_5H_CAP_REF}` : `${flCalls}`
      );

      const falseAlarmPct =
        heavyCalls > 0
          ? formatPctNumber(((heavyCalls - Math.max(0, Number(activeWin.heavyTriggered) || 0)) / heavyCalls) * 100)
          : '';
      patchText(cellHeavy.labelEl, t('safety.metricHeavy'));
      patchText(
        cellHeavy.valueEl,
        heavyCalls > 0
          ? `${heavyCalls} (${t('safety.falseAlarmSuffix', { pct: falseAlarmPct })})`
          : '0'
      );

      const totalChars =
        Math.max(0, Number(activeWin.heavyTrajChars) || 0) +
        Math.max(0, Number(activeWin.flashLiteTrajChars) || 0);
      patchText(cellTrajBlock.labelEl, t('safety.metricTrajBlock'));
      patchText(
        cellTrajBlock.valueEl,
        `${formatTokens(totalChars)} ${t('safety.charsUnit')} · ${formatBlockedDuration(activeWin.blockedMs)}`
      );

      const r429 = Math.max(0, Number(activeWin.rateLimit429Count) || 0);
      const fb = Math.max(0, Number(activeWin.fallbackCount) || 0);
      patchText(cell429Fallback.labelEl, t('safety.metric429Fallback'));
      patchText(cell429Fallback.valueEl, `${r429} / ${fb}`);
      patchClasses(cell429Fallback.valueEl, { 'is-alert': r429 > 0 || fb > 0 });

      const lowTok = Math.max(0, Number(activeWin.estInputTokensLower) || 0);
      const highTok = Math.max(0, Number(activeWin.estInputTokensUpper) || 0);
      patchText(cellEstTokens.labelEl, t('safety.metricEstTokens'));
      patchText(
        cellEstTokens.valueEl,
        highTok > 0 ? `~${formatTokens(lowTok)} – ${formatTokens(highTok)}` : '--'
      );

      patchText(disclaimerEl, t('safety.disclaimer'));
    }

    function update({ enabled = true, safetyMonitor = null } = {}) {
      latestState = { enabled: enabled !== false, safetyMonitor: safetyMonitor || null };
      render();
    }

    return {
      el: rootEl,
      refs: {
        update,
        headBtn,
        detailsEl,
        adviceEl,
        alertBadgeEl,
        win5hBtn,
        win24hBtn,
      },
    };
  },
});
