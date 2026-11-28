/**
 * @fileoverview Multi-account switcher, quota trajectory chart, risk gate, and passphrase vault UI.
 * Reuses `SegmentedControl`, `CustomSelect`, `AccountQuotaTrendCard`, `.ctx-risk-mask`,
 * `.settings-bridge-notice`, `.status-tag`, `.btn-ghost-sm`, `.btn-danger-confirm`, and `.quota-pool-row`.
 */

import { defineComponent } from '../../core/component.js';
import {
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchStyleVar,
  patchText,
} from '../../core/domPatch.js';
import { formatCountdown } from '../../core/formatters.js';
import { callSidecarApi } from '../../core/httpClient.js';
import { createSvgIcon, patchSvgIcon } from '../../icons/SvgIcon.js';
import { getEffectiveLocale, t } from '../../i18n/index.js';
import { CustomSelect } from '../../components/ui/CustomSelect.js';
import { SegmentedControl } from '../../components/ui/SegmentedControl.js';
import { AccountQuotaTrendCard } from '../../components/widgets/AccountQuotaTrendCard.js';
import { formatAccountTierBadge } from '../../components/widgets/QuotaPoolsWidget.js';
import {
  DEFAULT_ACCOUNT_QUOTA_REFRESH_MINUTES,
  normalizeAccountQuotaRefreshMinutes,
} from '../../../shared/settings-normalization.mjs';
import { saveSettingsPatch, telemetryStore } from '../../store/telemetryStore.js';

const key = (name) => `settings.account.${name}`;
const fmtPct = (v) => String(+Number(v).toFixed(1));

let warmAccountCache = null;
const ACTIVE_LOGIN_STATUSES = new Set(['waiting', 'exchanging', 'saving']);
const MAX_DISMISSED_TERMINAL_LOGINS = 32;
const dismissedTerminalLogins = new Set();

function getTerminalLoginKey(session) {
  if (!session?.status || ACTIVE_LOGIN_STATUSES.has(session.status)) return '';
  return `${session.id || ''}:${session.status}:${session.error || ''}`;
}

function rememberDismissedTerminalLogin(termKey) {
  if (!termKey) return;
  if (!dismissedTerminalLogins.has(termKey) && dismissedTerminalLogins.size >= MAX_DISMISSED_TERMINAL_LOGINS) {
    const oldest = dismissedTerminalLogins.values().next().value;
    if (oldest !== undefined) dismissedTerminalLogins.delete(oldest);
  }
  dismissedTerminalLogins.add(termKey);
}

const errors = new Set([
  'unsupported', 'invalidEmail', 'invalidCredential', 'credentialTooLarge', 'notFound',
  'noCurrentCredential', 'busy', 'storeFailed', 'rollbackFailed', 'credentialAccessDenied',
  'credentialChanged', 'credentialRejected', 'identityMismatch', 'oauthClientUnavailable',
  'oauthUnavailable', 'quotaUnavailable',
  'switchStartFailed', 'clientCloseFailed', 'clientRestartFailed',
  'loginStartFailed', 'loginExchangeFailed', 'loginExpired', 'loginDenied',
  'vaultLocked', 'wrongPassword', 'invalidPassword', 'passwordMismatch',
  'passwordRateLimited', 'vaultDecryptFailed', 'passphraseRequired', 'keyringUnavailable',
  'invalidActionNonce', 'riskNotAccepted',
]);

const okToastKeys = new Set([
  'saved', 'removed', 'switched',
  'pwdEnabledToast', 'pwdChangedToast', 'pwdDisabledToast',
  'vaultUnlockedToast', 'vaultLockedToast', 'vaultResetToast',
]);

function getAccountRefreshOptions() {
  return [
    { value: 10, label: t(key('refresh10m')) },
    { value: 30, label: t(key('refresh30m')) },
    { value: 60, label: t(key('refresh1h')) },
    { value: 180, label: t(key('refresh3h')) },
    { value: 360, label: t(key('refresh6h')) },
    { value: 720, label: t(key('refresh12h')) },
    { value: 1440, label: t(key('refresh24h')) },
    { value: 0, label: t(key('refreshOff')) },
  ];
}

function getPwdModeOptions() {
  return [
    { value: 'change', label: t(key('pwdTabChange')) },
    { value: 'disable', label: t(key('pwdTabDisable')) },
  ];
}

function formatValidCountdown(isoTime) {
  if (!isoTime) return '';
  const ms = Date.parse(isoTime);
  if (!Number.isFinite(ms) || ms <= Date.now()) return '';
  return formatCountdown(isoTime);
}

function syncRemainingMeter(wrapEl, quotaLabelEl, resetEl, fillEl, hasData, labelText, remVal, resetTime) {
  patchAttr(wrapEl, 'hidden', !hasData);
  if (!hasData) return;
  const clamped = Math.max(0, Math.min(100, Number(remVal) || 0));
  patchText(quotaLabelEl, labelText);
  const cd = formatValidCountdown(resetTime);
  patchText(resetEl, cd);
  patchAttr(resetEl, 'hidden', !cd);
  patchStyleVar(fillEl, '--fill-w', `${+clamped.toFixed(1)}%`);
  patchClasses(fillEl, {
    'tone-warn': clamped > 15 && clamped <= 30,
    'tone-danger': clamped <= 15,
  });
}

function renderQuotaRows(container, quotaPools) {
  const locale = getEffectiveLocale();
  const pools = (Array.isArray(quotaPools) ? quotaPools : []).filter(
    (pool) => Number.isFinite(pool?.remainingPct) || Number.isFinite(pool?.weeklyRemainingPct)
  );
  patchKeyedList(container, pools, {
    keyFn: (pool) => pool.poolKey || pool.poolLabel,
    sigFn: (pool, idx) =>
      JSON.stringify([
        idx > 0,
        locale,
        pool.poolLabel,
        pool.remainingPct,
        pool.weeklyRemainingPct,
        pool.resetTime,
        pool.weeklyResetTime,
      ]),
    createRow: () => {
      const poolTitle = h('div', { className: 'account-pool-label' });

      const label5h = h('span', { className: 'quota-win-title settings-account-quota text-mono' });
      const reset5h = h('span', { className: 'panel-meta quota-win-meta text-mono', hidden: true });
      const fill5h = h('div', { className: 'progress-fill' });
      const meter5h = h('div', { className: 'account-meter-col' }, [
        h('div', { className: 'panel-header quota-win-head' }, [
          h('span', { className: 'quota-win-left' }, [label5h]),
          reset5h,
        ]),
        h('div', { className: 'progress-track' }, [fill5h]),
      ]);

      const labelWk = h('span', { className: 'quota-win-title settings-account-quota text-mono' });
      const resetWk = h('span', { className: 'panel-meta quota-win-meta text-mono', hidden: true });
      const fillWk = h('div', { className: 'progress-fill' });
      const meterWk = h('div', { className: 'account-meter-col' }, [
        h('div', { className: 'panel-header quota-win-head' }, [
          h('span', { className: 'quota-win-left' }, [labelWk]),
          resetWk,
        ]),
        h('div', { className: 'progress-track' }, [fillWk]),
      ]);

      const gridEl = h('div', { className: 'account-pool-meters' }, [meter5h, meterWk]);
      const el = h('div', { className: 'quota-pool-row' }, [poolTitle, gridEl]);
      return {
        el,
        refs: { el, poolTitle, gridEl, meter5h, label5h, reset5h, fill5h, meterWk, labelWk, resetWk, fillWk },
      };
    },
    updateRow: (refs, pool, idx) => {
      patchClasses(refs.el, { 'has-divider': idx > 0 });
      patchText(refs.poolTitle, pool.poolLabel || pool.poolKey);
      const has5h = Number.isFinite(pool.remainingPct);
      const hasWk = Number.isFinite(pool.weeklyRemainingPct);
      patchClasses(refs.gridEl, { 'is-single': (has5h ? 1 : 0) + (hasWk ? 1 : 0) <= 1 });

      syncRemainingMeter(
        refs.meter5h,
        refs.label5h,
        refs.reset5h,
        refs.fill5h,
        has5h,
        has5h ? t(key('quota5h'), { percent: fmtPct(pool.remainingPct) }) : '',
        pool.remainingPct,
        pool.resetTime
      );
      syncRemainingMeter(
        refs.meterWk,
        refs.labelWk,
        refs.resetWk,
        refs.fillWk,
        hasWk,
        hasWk ? t(key('quotaWeekly'), { percent: fmtPct(pool.weeklyRemainingPct) }) : '',
        pool.weeklyRemainingPct,
        pool.weeklyResetTime
      );
    },
  });
  patchAttr(container, 'hidden', pools.length === 0);
  return pools.length;
}

function needsLegacyUltraTierRefresh(cached) {
  if (!cached || cached.tierId || cached.tierMultiplier) return false;
  const name = String(cached.tierName || '');
  return /\bultra\b/i.test(name) && !/\b(?:5x|20x)\b/i.test(name);
}

function isValidVaultPassphrase(raw) {
  return typeof raw === 'string' && raw.length >= 4 && raw.length <= 128 && Boolean(raw.trim());
}

export const SettingsAccountTab = defineComponent({
  name: 'SettingsAccountTab',
  setup({ props, onCleanup }) {
    const initialSettings = telemetryStore.getState().telemetry?.settings;
    let account = null;
    let quotas = null;
    let refreshMinutes = normalizeAccountQuotaRefreshMinutes(
      initialSettings?.accountQuotaRefreshMinutes ?? DEFAULT_ACCOUNT_QUOTA_REFRESH_MINUTES
    );
    let draftRiskAccepted = Boolean(initialSettings?.accountSwitchRiskAccepted);
    let acceptingRisk = false;
    let riskLockedFromServer = warmAccountCache ? Boolean(warmAccountCache.riskLocked) : true;
    let accounts = warmAccountCache ? [...warmAccountCache.accounts] : [];
    let selectedEmail = warmAccountCache ? warmAccountCache.selectedEmail : '';
    let supported = warmAccountCache ? warmAccountCache.supported : null;
    let keyringAvailable = warmAccountCache ? warmAccountCache.keyringAvailable !== false : true;
    let passphraseRequired = warmAccountCache ? Boolean(warmAccountCache.passphraseRequired) : false;
    let vaultSecurity = warmAccountCache?.vaultSecurity
      ? { ...warmAccountCache.vaultSecurity }
      : { enabled: false, unlocked: true };
    let quotaHistory = warmAccountCache?.quotaHistory ? { ...warmAccountCache.quotaHistory } : {};
    let actionNonce = warmAccountCache?.actionNonce || '';
    let operation = '';
    let status = '';
    let statusClearTimer = null;
    let confirmTarget = null;
    let confirmClearTimer = null;
    let switchState = null;
    let importOpen = false;
    let pwdDrawerOpen = false;
    let pwdManageMode = 'change';
    let forgotResetOpen = false;
    let refreshingSavedQuotas = false;
    let disposed = false;
    let loginSession = null;
    let loginTimer;
    let loginDismissTimer = null;
    let loginGeneration = 0;
    let loginRefreshEmail = '';
    const savedQuotas = new Map(warmAccountCache ? warmAccountCache.savedQuotasEntries : []);
    const quotaInFlight = new Set();
    const quotaVisibleLoading = new Set();
    const quotaErrors = new Map();

    function isVaultLocked() {
      return Boolean(vaultSecurity?.enabled && !vaultSecurity?.unlocked);
    }

    function syncWarmCache() {
      if (supported !== true) return;
      warmAccountCache = {
        supported,
        keyringAvailable,
        passphraseRequired,
        riskLocked: riskLockedFromServer,
        accounts: [...accounts],
        selectedEmail,
        savedQuotasEntries: [...savedQuotas.entries()],
        vaultSecurity: { ...vaultSecurity },
        quotaHistory: { ...quotaHistory },
        actionNonce,
      };
    }

    function clearConfirmTarget(shouldRender = false) {
      if (confirmClearTimer) {
        clearTimeout(confirmClearTimer);
        confirmClearTimer = null;
      }
      if (!confirmTarget) return;
      confirmTarget = null;
      if (shouldRender && !disposed) render();
    }

    function armOrRunConfirm(type, targetKey, runFn) {
      if (confirmTarget && confirmTarget.type === type && confirmTarget.key === targetKey) {
        clearConfirmTarget(false);
        runFn();
        return;
      }
      if (confirmClearTimer) clearTimeout(confirmClearTimer);
      confirmTarget = { type, key: targetKey };
      confirmClearTimer = setTimeout(() => clearConfirmTarget(true), 4500);
      render();
    }

    function setTransientStatus(nextStatus, autoClearMs = 0) {
      if (statusClearTimer) {
        clearTimeout(statusClearTimer);
        statusClearTimer = null;
      }
      status = nextStatus;
      if (nextStatus && autoClearMs > 0) {
        statusClearTimer = setTimeout(() => {
          statusClearTimer = null;
          if (!disposed && status === nextStatus) {
            status = '';
            render();
          }
        }, autoClearMs);
      }
    }

    function clearLoginDismissTimer() {
      if (loginDismissTimer) {
        clearTimeout(loginDismissTimer);
        loginDismissTimer = null;
      }
    }

    function dismissTerminalLoginIfIdle() {
      const termKey = getTerminalLoginKey(loginSession);
      if (!termKey) return;
      clearLoginDismissTimer();
      rememberDismissedTerminalLogin(termKey);
      loginSession = null;
    }

    function clearPasswordInputs() {
      unlockInput.value = '';
      pwdCurrentInput.value = '';
      pwdNewInput.value = '';
      pwdConfirmInput.value = '';
    }

    // --- Section 1: Active Account Card Host ---
    const activeCardHost = h('div', { className: 'account-cards-stack' });

    // --- Section 2: Quota Trend Line Chart Card ---
    const quotaTrendCard = AccountQuotaTrendCard();

    // --- Section 3: Multi-Account Toolbar, Drawers, Backup Cards & Risk Gate ---
    const loginBtnLabel = h('span');
    const loginButton = h(
      'button',
      {
        type: 'button',
        className: 'btn-primary settings-account-login',
        onClick: () => {
          clearConfirmTarget(false);
          void request('loginStart', { language: getEffectiveLocale() });
        },
      },
      [createSvgIcon('plus', { size: 12 }), loginBtnLabel]
    );
    const cancelLogin = h('button', {
      type: 'button',
      className: 'btn-secondary settings-account-login-cancel',
      hidden: true,
      onClick: () => request('loginCancel', { id: loginSession?.id }),
    });
    const importToggleLabel = h('span');
    const importToggleBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: () => {
          clearConfirmTarget(false);
          dismissTerminalLoginIfIdle();
          importOpen = !importOpen;
          if (importOpen) {
            pwdDrawerOpen = false;
            clearPasswordInputs();
          }
          render();
          if (importOpen) credential.focus?.();
        },
      },
      [importToggleLabel]
    );

    const pwdToggleIcon = createSvgIcon('lock', { size: 12 });
    const pwdToggleLabel = h('span');
    const pwdToggleBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary settings-account-pwd-toggle',
        onClick: () => {
          clearConfirmTarget(false);
          dismissTerminalLoginIfIdle();
          pwdDrawerOpen = !pwdDrawerOpen;
          if (pwdDrawerOpen) {
            importOpen = false;
            pwdManageMode = 'change';
            pwdModeSegment.setProps({ modelValue: 'change', options: getPwdModeOptions() });
          }
          clearPasswordInputs();
          render();
          if (pwdDrawerOpen) {
            (vaultSecurity.enabled ? pwdCurrentInput : pwdNewInput).focus?.();
          }
        },
      },
      [pwdToggleIcon, pwdToggleLabel]
    );

    const lockNowLabel = h('span');
    const lockNowBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary settings-account-lock-now',
        hidden: true,
        onClick: () => {
          clearConfirmTarget(false);
          pwdDrawerOpen = false;
          importOpen = false;
          clearPasswordInputs();
          void request('lockVault');
        },
      },
      [createSvgIcon('lock', { size: 12 }), lockNowLabel]
    );

    const feedback = h('span', {
      className: 'settings-action-desc account-status-inline',
      role: 'status',
      hidden: true,
    });
    const refreshIntervalSelect = CustomSelect({
      className: 'account-refresh-select',
      icon: 'clock',
      modelValue: refreshMinutes,
      options: getAccountRefreshOptions(),
      onUpdateModelValue: async (nextVal) => {
        const nextMins = normalizeAccountQuotaRefreshMinutes(nextVal);
        refreshMinutes = nextMins;
        refreshIntervalSelect.setValue(nextMins);
        if (nextMins > 0) {
          void refreshSavedQuotas();
        }
        try {
          await saveSettingsPatch({ accountQuotaRefreshMinutes: nextMins });
        } catch {
          // Keep selected interval locally if save fails transiently
        }
      },
    });
    patchAttr(refreshIntervalSelect.refs.triggerBtn, 'aria-label', t(key('refreshFreqAria')));
    patchAttr(refreshIntervalSelect.refs.triggerBtn, 'title', t(key('refreshFreqAria')));

    const reload = h(
      'button',
      {
        type: 'button',
        className: 'icon-btn',
        onClick: () => request('list'),
      },
      [createSvgIcon('refresh', { size: 13 })]
    );

    // Locked Vault Notice (reusing `.settings-bridge-notice`)
    const unlockHintLabel = h('span', { className: 'settings-bridge-title' });
    const forgotToggleBtn = h('button', {
      type: 'button',
      className: 'btn-ghost-sm settings-account-forgot-btn',
      onClick: () => {
        forgotResetOpen = !forgotResetOpen;
        clearConfirmTarget(false);
        render();
      },
    });
    const unlockInput = h('input', {
      type: 'password',
      className: 'settings-text-input account-import-input settings-account-unlock-input',
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: 128,
    });
    const unlockSubmitBtn = h('button', {
      type: 'submit',
      className: 'btn-primary settings-account-unlock-submit',
    });
    const unlockForm = h(
      'form',
      {
        className: 'account-import-row',
        autocomplete: 'off',
        onSubmit: submitUnlock,
      },
      [unlockInput, unlockSubmitBtn]
    );
    const resetHintEl = h('p', { className: 'settings-bridge-desc', hidden: true });
    const resetVaultBtn = h('button', {
      type: 'button',
      className: 'btn-secondary btn-danger-confirm settings-account-reset-vault',
      hidden: true,
      onClick: () => {
        armOrRunConfirm('resetVault', 'vault', () => {
          void request('resetVault', { confirmReset: 'RESET' });
        });
      },
    });
    const unlockBox = h(
      'div',
      { className: 'settings-bridge-notice settings-account-unlock-box', hidden: true },
      [
        h('div', { className: 'settings-bridge-head' }, [
          h('span', { className: 'settings-bridge-head-main' }, [
            createSvgIcon('lock', { size: 13, className: 'settings-bridge-icon' }),
            unlockHintLabel,
          ]),
          forgotToggleBtn,
        ]),
        unlockForm,
        resetHintEl,
        h('div', { className: 'settings-bridge-actions', hidden: true }, [resetVaultBtn]),
      ]
    );
    const resetActionsWrap = resetVaultBtn.parentElement;

    // Passphrase Setup / Manage Drawer (reusing `SegmentedControl`!)
    const pwdModeSegment = SegmentedControl({
      ariaLabel: t(key('pwdBtnManage')),
      modelValue: pwdManageMode,
      options: getPwdModeOptions(),
      onUpdateModelValue: (val) => {
        pwdManageMode = val === 'disable' ? 'disable' : 'change';
        pwdModeSegment.setProps({ modelValue: pwdManageMode, options: getPwdModeOptions() });
        clearPasswordInputs();
        render();
      },
    });
    const pwdCurrentInput = h('input', {
      type: 'password',
      className: 'settings-text-input account-import-input settings-account-pwd-current',
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: 128,
      hidden: true,
    });
    const pwdNewInput = h('input', {
      type: 'password',
      className: 'settings-text-input account-import-input settings-account-pwd-new',
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: 128,
    });
    const pwdConfirmInput = h('input', {
      type: 'password',
      className: 'settings-text-input account-import-input settings-account-pwd-confirm',
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: 128,
    });
    const pwdSubmitBtn = h('button', {
      type: 'submit',
      className: 'btn-primary settings-account-pwd-submit',
    });
    const pwdHint = h('div', { className: 'settings-action-desc' });
    const pwdForm = h(
      'form',
      {
        className: 'account-import-drawer settings-account-pwd-form',
        autocomplete: 'off',
        hidden: true,
        onSubmit: submitPasswordDrawer,
      },
      [
        pwdModeSegment.el,
        h('div', { className: 'account-import-row' }, [
          pwdCurrentInput,
          pwdNewInput,
          pwdConfirmInput,
          pwdSubmitBtn,
        ]),
        pwdHint,
      ]
    );

    // Credential Import Drawer
    const credential = h('input', {
      type: 'password',
      className: 'settings-text-input account-import-input',
      required: true,
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: 16384,
    });
    const save = h('button', {
      type: 'submit',
      className: 'btn-primary',
    });
    const importHint = h('div', { className: 'settings-action-desc' });
    const form = h(
      'form',
      {
        className: 'settings-account-form account-import-drawer',
        autocomplete: 'off',
        hidden: true,
        onSubmit: importCredential,
      },
      [
        h('div', { className: 'account-import-row' }, [credential, save]),
        importHint,
      ]
    );

    // OAuth Browser Login & Switch Notices (reusing `.settings-bridge-notice`)
    const loginMessage = h('p', {
      className: 'settings-bridge-desc settings-action-desc',
      role: 'status',
      hidden: true,
    });
    const loginLink = h('a', {
      className: 'settings-bridge-relaunch-btn',
      target: '_blank',
      rel: 'noopener noreferrer',
      hidden: true,
    });
    const loginStrip = h(
      'div',
      { className: 'settings-bridge-notice is-restart', hidden: true },
      [loginMessage, h('div', { className: 'settings-bridge-actions' }, [loginLink, cancelLogin])]
    );
    const loginLinkWrap = loginLink.parentElement;

    const pendingDesc = h('p', { className: 'settings-bridge-desc', role: 'status' });
    const pending = h('div', { className: 'settings-bridge-notice', hidden: true }, [pendingDesc]);

    const toolbarPanel = h('section', { className: 'panel account-toolbar-panel' }, [
      h('div', { className: 'account-toolbar-row' }, [
        h('div', { className: 'account-toolbar-left' }, [
          loginButton,
          importToggleBtn,
          pwdToggleBtn,
          lockNowBtn,
        ]),
        h('div', { className: 'account-toolbar-right' }, [
          feedback,
          refreshIntervalSelect.el,
          reload,
        ]),
      ]),
      unlockBox,
      pwdForm,
      form,
      loginStrip,
      pending,
    ]);

    const backupCardsHost = h('div', { className: 'account-cards-stack' });
    const emptyPanel = h('section', { className: 'panel account-empty-panel', hidden: true }, [
      h('div', { className: 'settings-action-desc account-empty-text' }),
    ]);
    const emptyTextEl = emptyPanel.firstChild;

    // Risk Gate Stage (100% shared `.ctx-risk-stage` / `.ctx-risk-mask` with `SettingsOtherTab`)
    const riskTitleEl = h('strong', {
      className: 'ctx-risk-title',
      text: t('settings.oth.ctxRiskTitle'),
    });
    const riskBodyEl = h('p', {
      className: 'ctx-risk-desc',
      text: t(key('riskBody')),
    });
    const riskAcceptBtnText = h('span', { text: t('settings.oth.ctxRiskAcceptBtn') });
    const riskAcceptBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary btn-danger-confirm ctx-risk-accept-btn settings-account-risk-accept',
        onClick: async () => {
          if (acceptingRisk || draftRiskAccepted) return;
          acceptingRisk = true;
          draftRiskAccepted = true;
          render();
          try {
            await saveSettingsPatch({ accountSwitchRiskAccepted: true });
            await request('list');
          } catch {
            draftRiskAccepted = false;
            setTransientStatus('storeFailed', 2800);
          } finally {
            acceptingRisk = false;
            if (!disposed) render();
          }
        },
      },
      [createSvgIcon('warning', { size: 12 }), riskAcceptBtnText]
    );
    const riskMask = h(
      'div',
      {
        className: 'ctx-risk-mask settings-account-risk-mask',
        role: 'region',
        'aria-label': t('settings.oth.ctxRiskTitle'),
      },
      [
        h('div', { className: 'ctx-risk-head' }, [
          createSvgIcon('warning', { size: 14, className: 'ctx-risk-icon' }),
          riskTitleEl,
        ]),
        riskBodyEl,
        riskAcceptBtn,
      ]
    );
    const managedControlsBody = h('div', { className: 'ctx-controls-body is-locked' }, [
      toolbarPanel,
      backupCardsHost,
    ]);
    const riskStage = h('div', { className: 'ctx-risk-stage' }, [managedControlsBody, riskMask]);

    function resolveActiveEmail() {
      return account?.status === 'signedIn' ? (account.email || '').trim().toLowerCase() : '';
    }

    function createAccountCardDom(entry) {
      const emailEl = h('span', {
        className: 'settings-account-identity account-card-email',
        text: entry.email,
        title: entry.email,
      });
      const tierPill = h('span', { className: 'status-tag state-synced', hidden: true });
      const statePill = h('span', { className: 'status-tag', hidden: true });

      const captureBtn = h('button', {
        type: 'button',
        className: 'btn-ghost-sm',
        hidden: true,
        onClick: () => {
          clearConfirmTarget(false);
          void request('capture');
        },
      });
      const selectBtn = h('button', {
        type: 'button',
        className: 'btn-ghost-sm',
        hidden: true,
        onClick: () => {
          armOrRunConfirm('switch', entry.email, () => {
            const curActive = resolveActiveEmail();
            void request('switch', {
              email: entry.email,
              ...(curActive ? { activeEmail: curActive } : {}),
            });
          });
        },
      });
      const loadQuotaBtn = h(
        'button',
        {
          type: 'button',
          className: 'icon-btn settings-account-load-quota',
          hidden: true,
          onClick: () => {
            clearConfirmTarget(false);
            void request('quota', { email: entry.email, manual: true });
          },
        },
        [createSvgIcon('refresh', { size: 12 })]
      );
      const removeBtn = h(
        'button',
        {
          type: 'button',
          className: 'icon-btn slot-remove-btn settings-account-remove',
          hidden: true,
          onClick: () => {
            armOrRunConfirm('remove', entry.email, () => {
              void request('remove', { email: entry.email });
            });
          },
        },
        [createSvgIcon('close', { size: 12 })]
      );
      const removeConfirmBtn = h('button', {
        type: 'button',
        className: 'btn-ghost-sm btn-danger-confirm settings-account-remove-confirm',
        hidden: true,
        onClick: () => {
          armOrRunConfirm('remove', entry.email, () => {
            void request('remove', { email: entry.email });
          });
        },
      });

      const actionsWrap = h('div', { className: 'account-card-actions' }, [
        captureBtn,
        selectBtn,
        loadQuotaBtn,
        removeBtn,
        removeConfirmBtn,
      ]);
      const poolsWrap = h('div', { className: 'account-pools-stack' });
      const noteEl = h('div', { className: 'settings-action-desc account-card-note', hidden: true });

      const cardEl = h('section', { className: 'panel account-card' }, [
        h('div', { className: 'panel-header account-card-head' }, [
          h('div', { className: 'account-card-meta' }, [emailEl, tierPill, statePill]),
          actionsWrap,
        ]),
        poolsWrap,
        noteEl,
      ]);
      return {
        el: cardEl,
        refs: {
          cardEl,
          emailEl,
          tierPill,
          statePill,
          actionsWrap,
          captureBtn,
          selectBtn,
          loadQuotaBtn,
          removeBtn,
          removeConfirmBtn,
          poolsWrap,
          noteEl,
        },
      };
    }

    function updateAccountCardDom(row, entry, ctx) {
      const addr = entry.email;
      const active = entry.isActive;
      const isSaved = entry.isSaved;
      const written = addr === selectedEmail && !active && switchState?.state === 'written';
      const cached = active ? null : savedQuotas.get(addr);
      const tierText = active
        ? ctx.activeTierBadge
        : cached?.tierName || cached?.tierId
          ? formatAccountTierBadge({
              tierId: cached.tierId,
              tierName: cached.tierName,
              tierMultiplier: cached.tierMultiplier,
            })
          : '';
      const isSpinning = !active && quotaVisibleLoading.has(addr);
      const canSwitch = !active && isSaved && ctx.riskAccepted;
      const armedSwitch = confirmTarget?.type === 'switch' && confirmTarget.key === addr;
      const armedRemove = confirmTarget?.type === 'remove' && confirmTarget.key === addr;

      patchClasses(row.cardEl, { 'is-active-account': active });
      patchText(row.emailEl, addr);
      patchAttr(row.emailEl, 'title', addr);

      patchText(row.tierPill, tierText);
      patchAttr(row.tierPill, 'hidden', !tierText);

      patchText(row.statePill, active ? t(key('active')) : written ? t(key('written')) : '');
      patchClasses(row.statePill, { 'state-warn': written && !active });
      patchAttr(row.statePill, 'hidden', !active && !written);

      const showCapture = active && !isSaved && ctx.riskAccepted && supported !== false;
      const showRemove = isSaved && ctx.riskAccepted;
      const showQuotaRefresh = !active && isSaved && ctx.riskAccepted;
      const hasAnyAction = showCapture || canSwitch || showQuotaRefresh || showRemove;
      patchAttr(row.actionsWrap, 'hidden', !hasAnyAction);

      patchText(row.captureBtn, t(key('capture')));
      patchAttr(row.captureBtn, 'hidden', !showCapture);
      patchAttr(row.captureBtn, 'disabled', !ctx.canWrite);

      patchText(row.selectBtn, t(key(armedSwitch ? 'switchConfirm' : 'switch')));
      patchAttr(row.selectBtn, 'title', t(key('switchHint')));
      patchClasses(row.selectBtn, {
        'settings-account-switch': canSwitch,
        'btn-danger-confirm': armedSwitch,
      });
      patchAttr(row.selectBtn, 'hidden', !canSwitch);
      patchAttr(row.selectBtn, 'disabled', !ctx.canWrite);

      patchAttr(row.loadQuotaBtn, 'title', t(key(isSpinning ? 'loadingQuota' : 'loadQuota')));
      patchAttr(row.loadQuotaBtn, 'aria-label', t(key('loadQuota')));
      patchClasses(row.loadQuotaBtn, { 'is-spinning': isSpinning });
      patchAttr(row.loadQuotaBtn, 'hidden', !showQuotaRefresh);
      patchAttr(row.loadQuotaBtn, 'disabled', !ctx.canWrite || isSpinning);

      patchAttr(row.removeBtn, 'title', t(key('remove')));
      patchAttr(row.removeBtn, 'aria-label', t(key('remove')));
      patchAttr(row.removeBtn, 'hidden', !showRemove || armedRemove);
      patchAttr(row.removeBtn, 'disabled', !ctx.canWrite);

      patchText(row.removeConfirmBtn, t(key('removeConfirm')));
      patchAttr(row.removeConfirmBtn, 'hidden', !showRemove || !armedRemove);
      patchAttr(row.removeConfirmBtn, 'disabled', !ctx.canWrite);

      const displayedPools = active ? quotas?.pools || [] : cached?.pools || [];
      const poolCount = renderQuotaRows(row.poolsWrap, displayedPools);
      const quotaError = active ? '' : quotaErrors.get(addr);

      let noteText = '';
      if (quotaError) {
        noteText = t(key(quotaError));
      } else if (active && poolCount > 0 && quotas?.meta?.isStale) {
        noteText = t(key('quotaStale'));
      } else if (active && poolCount === 0) {
        noteText = t(key('noQuota'));
      } else if (!active && cached && poolCount === 0) {
        noteText = t(key('emptyCredentialQuota'));
      }
      patchText(row.noteEl, noteText);
      patchClasses(row.noteEl, { 'is-error': Boolean(quotaError) });
      patchAttr(row.noteEl, 'hidden', !noteText);
    }

    function render() {
      const signedIn = account?.status === 'signedIn';
      const activeEmail = resolveActiveEmail();
      if (activeEmail && selectedEmail === activeEmail && switchState?.state !== 'starting') {
        selectedEmail = '';
      }
      const riskAccepted = Boolean(draftRiskAccepted);
      if (!riskAccepted) {
        refreshIntervalSelect.close?.();
      }
      const vaultLocked = isVaultLocked();
      const canOperateVault =
        riskAccepted &&
        supported === true &&
        !operation &&
        status !== 'restarting' &&
        switchState?.state !== 'starting';
      const canWrite = canOperateVault && !vaultLocked;
      const locale = getEffectiveLocale();
      const activeTierBadge =
        signedIn && (account?.tierName || account?.planName)
          ? formatAccountTierBadge(account)
          : '';
      const cardCtx = { riskAccepted, canWrite, activeTierBadge };

      // 1. Active Logged-in Account Card
      const activeEntries = activeEmail
        ? [
            {
              email: activeEmail,
              isActive: true,
              isSaved: riskAccepted && accounts.includes(activeEmail),
            },
          ]
        : [];
      patchAttr(activeCardHost, 'hidden', activeEntries.length === 0);
      patchKeyedList(activeCardHost, activeEntries, {
        keyFn: (entry) => entry.email,
        sigFn: (entry) =>
          JSON.stringify([
            locale,
            entry.isSaved,
            riskAccepted,
            canWrite,
            confirmTarget?.key === entry.email ? confirmTarget.type : '',
            quotas,
            activeTierBadge,
          ]),
        createRow: createAccountCardDom,
        updateRow: (row, entry) => updateAccountCardDom(row, entry, cardCtx),
      });

      // 2. Quota Trend Line Chart Card (always visible; locked to activeEmail when !riskAccepted)
      quotaTrendCard.refs.update({
        activeEmail,
        activePools: quotas?.pools || [],
        riskAccepted,
        accounts,
        savedQuotas,
        quotaHistory,
      });

      // 3. Risk Gate Stage & Multi-Account Controls
      patchClasses(managedControlsBody, { 'is-locked': !riskAccepted });
      patchAttr(managedControlsBody, 'inert', !riskAccepted);
      patchAttr(managedControlsBody, 'aria-hidden', riskAccepted ? null : 'true');
      patchAttr(riskMask, 'hidden', riskAccepted);
      patchAttr(riskMask, 'aria-label', t('settings.oth.ctxRiskTitle'));
      patchText(riskTitleEl, t('settings.oth.ctxRiskTitle'));
      patchText(riskBodyEl, t(key('riskBody')));
      patchText(riskAcceptBtnText, t('settings.oth.ctxRiskAcceptBtn'));
      patchAttr(riskAcceptBtn, 'disabled', acceptingRisk);

      const loginActive = ['waiting', 'exchanging', 'saving'].includes(loginSession?.status);
      patchText(loginBtnLabel, t(key('googleLogin')));
      patchAttr(loginButton, 'disabled', !canWrite || loginActive);
      patchText(cancelLogin, t(key('cancelLogin')));
      patchAttr(cancelLogin, 'hidden', !loginActive);
      patchAttr(cancelLogin, 'disabled', Boolean(operation) || loginSession?.status === 'saving');

      patchText(importToggleLabel, t(key('importExisting')));
      patchClasses(importToggleBtn, { 'is-open': importOpen });
      patchAttr(importToggleBtn, 'hidden', supported === false);
      patchAttr(importToggleBtn, 'disabled', !canWrite);

      patchSvgIcon(pwdToggleIcon, vaultSecurity.enabled ? 'unlock' : 'lock');
      patchText(pwdToggleLabel, t(key(vaultSecurity.enabled ? 'pwdBtnManage' : 'pwdBtnSet')));
      patchClasses(pwdToggleBtn, { 'is-open': pwdDrawerOpen });
      patchAttr(pwdToggleBtn, 'hidden', supported === false || vaultLocked);
      patchAttr(pwdToggleBtn, 'disabled', !canOperateVault);

      patchText(lockNowLabel, t(key('lockNow')));
      patchAttr(lockNowBtn, 'title', t(key('lockNowTip')));
      patchAttr(lockNowBtn, 'hidden', !vaultSecurity.enabled || vaultLocked || supported === false);
      patchAttr(lockNowBtn, 'disabled', !canOperateVault);

      // Unlock Notice
      patchAttr(unlockBox, 'hidden', !riskAccepted || supported !== true || !vaultLocked);
      patchText(unlockHintLabel, t(key('vaultLockedHint')));
      patchText(forgotToggleBtn, t(key('forgotPwdToggle')));
      patchAttr(unlockInput, 'placeholder', t(key('unlockPlaceholder')));
      patchAttr(unlockInput, 'disabled', !canOperateVault);
      patchText(unlockSubmitBtn, t(key('unlockBtn')));
      patchAttr(unlockSubmitBtn, 'disabled', !canOperateVault);
      const showResetSection = forgotResetOpen && vaultLocked;
      patchAttr(resetHintEl, 'hidden', !showResetSection);
      patchAttr(resetActionsWrap, 'hidden', !showResetSection);
      patchAttr(resetVaultBtn, 'hidden', !showResetSection);
      patchText(resetHintEl, t(key('resetVaultHint')));
      const armedVaultReset =
        confirmTarget?.type === 'resetVault' && confirmTarget.key === 'vault';
      patchText(resetVaultBtn, t(key(armedVaultReset ? 'resetVaultConfirm' : 'resetVaultBtn')));
      patchAttr(resetVaultBtn, 'disabled', !canOperateVault);

      // Passphrase Drawer (`SegmentedControl` for Change / Disable)
      const showPwdDrawer = riskAccepted && pwdDrawerOpen && !vaultLocked && supported === true;
      patchAttr(pwdForm, 'hidden', !showPwdDrawer);
      if (showPwdDrawer) {
        const isSetNew = !vaultSecurity.enabled;
        const isDisableMode = !isSetNew && pwdManageMode === 'disable';
        const disableBlockedNoKeyring = !keyringAvailable && isDisableMode;
        patchAttr(pwdModeSegment.el, 'hidden', isSetNew);
        if (!isSetNew) {
          pwdModeSegment.setProps({ modelValue: pwdManageMode, options: getPwdModeOptions() });
        }

        patchAttr(pwdCurrentInput, 'hidden', isSetNew);
        patchAttr(pwdCurrentInput, 'placeholder', t(key('pwdCurrentPlaceholder')));
        patchAttr(pwdCurrentInput, 'disabled', !canOperateVault || disableBlockedNoKeyring);

        patchAttr(pwdNewInput, 'hidden', isDisableMode);
        patchAttr(pwdNewInput, 'placeholder', t(key('pwdNewPlaceholder')));
        patchAttr(pwdNewInput, 'disabled', !canOperateVault);

        patchAttr(pwdConfirmInput, 'hidden', isDisableMode);
        patchAttr(pwdConfirmInput, 'placeholder', t(key('pwdConfirmPlaceholder')));
        patchAttr(pwdConfirmInput, 'disabled', !canOperateVault);

        patchText(
          pwdSubmitBtn,
          t(key(isSetNew ? 'pwdEnableSubmit' : isDisableMode ? 'pwdDisableSubmit' : 'pwdChangeSubmit'))
        );
        patchClasses(pwdSubmitBtn, {
          'btn-primary': !isDisableMode,
          'btn-secondary': isDisableMode,
          'btn-danger-confirm': isDisableMode,
        });
        patchAttr(pwdSubmitBtn, 'disabled', !canOperateVault || disableBlockedNoKeyring);
        const pwdHintKey =
          disableBlockedNoKeyring
            ? 'keyringUnavailable'
            : isSetNew && passphraseRequired
              ? 'passphraseRequired'
              : isSetNew
                ? 'pwdSetHint'
                : 'pwdManageHint';
        patchText(pwdHint, t(key(pwdHintKey)));
      }

      refreshIntervalSelect.setProps({
        modelValue: refreshMinutes,
        options: getAccountRefreshOptions(),
      });
      patchAttr(refreshIntervalSelect.refs.triggerBtn, 'aria-label', t(key('refreshFreqAria')));
      patchAttr(refreshIntervalSelect.refs.triggerBtn, 'title', t(key('refreshFreqAria')));
      patchAttr(refreshIntervalSelect.el, 'hidden', supported === false);

      patchAttr(reload, 'title', t(key('reload')));
      patchAttr(reload, 'aria-label', t(key('reload')));
      patchAttr(reload, 'disabled', Boolean(operation));
      patchClasses(reload, { 'is-spinning': operation === 'list' });

      patchAttr(form, 'hidden', !riskAccepted || !importOpen || vaultLocked || supported === false);
      patchAttr(credential, 'placeholder', t(key('credentialPlaceholder')));
      patchAttr(credential, 'disabled', !canWrite);
      patchText(save, t(key('save')));
      patchAttr(save, 'disabled', !canWrite);
      patchText(importHint, t(key('importHint')));

      const loginStatusKeys = {
        waiting: 'loginWaiting',
        exchanging: 'loginFinishing',
        saving: 'loginFinishing',
        success: 'loginSuccess',
        cancelled: 'loginCancelled',
        expired: 'loginExpired',
      };
      const hasLoginSession = Boolean(loginSession?.status);
      const loginIsError =
        loginSession?.status === 'error' ||
        loginSession?.status === 'expired' ||
        loginSession?.error === 'loginDenied';
      const loginMessageKey =
        loginSession?.status === 'error'
          ? errors.has(loginSession.error)
            ? loginSession.error
            : 'loginExchangeFailed'
          : loginSession?.error === 'loginDenied'
            ? 'loginDenied'
            : loginStatusKeys[loginSession?.status] || '';
      patchText(loginMessage, loginMessageKey ? t(key(loginMessageKey)) : '');
      patchAttr(loginMessage, 'hidden', !loginMessageKey);

      const authUrl =
        loginSession?.status === 'waiting' &&
        loginSession.url?.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')
          ? loginSession.url
          : '';
      patchText(loginLink, t(key('openLoginPage')));
      patchAttr(loginLink, 'href', authUrl || null);
      patchAttr(loginLink, 'hidden', !authUrl);
      patchAttr(loginLinkWrap, 'hidden', !authUrl && !loginActive);
      patchClasses(loginStrip, { 'is-restart': !loginIsError });
      patchAttr(loginStrip, 'hidden', !hasLoginSession || !loginMessageKey);

      const failedSwitch =
        switchState?.state === 'failed' && errors.has(switchState.error) ? switchState.error : '';
      const message =
        status ||
        failedSwitch ||
        (operation === 'switch'
          ? 'switching'
          : operation === 'save' || operation === 'capture'
            ? 'verifying'
            : '');
      const isFeedbackError = Boolean(errors.has(message));
      const isFeedbackOk = okToastKeys.has(message);
      patchText(feedback, message ? t(key(message)) : '');
      patchAttr(feedback, 'title', message ? t(key(message)) : null);
      patchClasses(feedback, {
        'is-error': isFeedbackError,
        'is-ok': isFeedbackOk,
      });
      patchAttr(feedback, 'hidden', !message);

      const waiting =
        Boolean(selectedEmail) &&
        activeEmail !== selectedEmail &&
        switchState?.state === 'written' &&
        status !== 'restarting';
      patchText(pendingDesc, waiting ? t(key('pending'), { email: selectedEmail }) : '');
      patchAttr(pending, 'hidden', !waiting);

      const backupEntries = riskAccepted
        ? accounts
            .filter((addr) => addr && addr !== activeEmail)
            .map((addr) => ({ email: addr, isActive: false, isSaved: true }))
        : [];
      patchAttr(backupCardsHost, 'hidden', backupEntries.length === 0);
      patchKeyedList(backupCardsHost, backupEntries, {
        keyFn: (entry) => entry.email,
        sigFn: (entry) =>
          JSON.stringify([
            locale,
            selectedEmail,
            switchState?.state || '',
            canWrite,
            confirmTarget?.key === entry.email ? confirmTarget.type : '',
            savedQuotas.get(entry.email),
            quotaVisibleLoading.has(entry.email),
            quotaErrors.get(entry.email),
          ]),
        createRow: createAccountCardDom,
        updateRow: (row, entry) => updateAccountCardDom(row, entry, cardCtx),
      });

      const showEmpty = !activeEmail && (!riskAccepted || backupEntries.length === 0);
      patchText(
        emptyTextEl,
        t(
          key(
            supported === null && !activeEmail
              ? 'loading'
              : account?.status === 'signedOut'
                ? 'signedOut'
                : 'empty'
          )
        )
      );
      patchAttr(emptyPanel, 'hidden', !showEmpty);

      props.onLayoutChange?.();
    }

    async function dispatchAccountPost(action, fields) {
      let res = await callSidecarApi('/api/accounts/update', {
        method: 'POST',
        body: {
          action,
          ...fields,
          ...(actionNonce ? { actionNonce } : {}),
        },
        cdpTimeoutMs: 40000,
      });
      if (res?.actionNonce) {
        actionNonce = res.actionNonce;
      }
      if (res?.error === 'invalidActionNonce' && actionNonce) {
        res = await callSidecarApi('/api/accounts/update', {
          method: 'POST',
          body: {
            action,
            ...fields,
            actionNonce,
          },
          cdpTimeoutMs: 40000,
        });
        if (res?.actionNonce) {
          actionNonce = res.actionNonce;
        }
      }
      return res;
    }

    async function request(action, fields = {}) {
      if (action !== 'list' && !draftRiskAccepted) return;
      if (action === 'quota') return refreshQuota(fields.email, Boolean(fields.manual));
      if (operation) return;
      operation = action;
      if (action === 'loginStart' || action === 'loginCancel') {
        clearTimeout(loginTimer);
        loginGeneration += 1;
      }
      setTransientStatus('');
      render();
      try {
        const result =
          action === 'list'
            ? await callSidecarApi('/api/accounts')
            : await dispatchAccountPost(action, fields);
        if (disposed) return;
        if (typeof result?.actionNonce === 'string' && result.actionNonce) {
          actionNonce = result.actionNonce;
        }
        if (result?.quotaHistory && typeof result.quotaHistory === 'object') {
          quotaHistory = { ...quotaHistory, ...result.quotaHistory };
        }
        if (result?.error) {
          if (result.error === 'unsupported') supported = false;
          if (result.error === 'vaultLocked') {
            vaultSecurity = { enabled: true, unlocked: false };
            syncWarmCache();
          }
          if (result.error === 'passphraseRequired' && !vaultSecurity.enabled) {
            keyringAvailable = false;
            passphraseRequired = true;
            importOpen = false;
            pwdDrawerOpen = true;
            clearPasswordInputs();
            syncWarmCache();
          } else if (result.error === 'keyringUnavailable') {
            keyringAvailable = false;
            syncWarmCache();
          }
          setTransientStatus(errors.has(result.error) ? result.error : 'storeFailed', 4500);
          return;
        }
        if (action === 'loginStart' || action === 'loginCancel') {
          applyLogin(result.login);
          if (result.login?.status === 'success') loginRefreshEmail = result.login.email;
          return;
        }
        supported = result?.supported === true;
        riskLockedFromServer = Boolean(result?.riskLocked);
        keyringAvailable = result?.keyringAvailable !== false;
        passphraseRequired = Boolean(result?.passphraseRequired && !result?.security?.enabled);
        accounts = result?.accounts || [];
        selectedEmail = result?.selectedEmail || '';
        switchState = result?.switchState || null;
        if (result?.security) {
          vaultSecurity = {
            enabled: Boolean(result.security.enabled),
            unlocked: result.security.unlocked !== false,
          };
        } else {
          vaultSecurity = { enabled: false, unlocked: true };
        }
        if (passphraseRequired && draftRiskAccepted && !riskLockedFromServer && action === 'list') {
          importOpen = false;
          pwdDrawerOpen = true;
        }
        if (result.login) {
          applyLogin(result.login);
        } else if (!ACTIVE_LOGIN_STATUSES.has(loginSession?.status) && !loginDismissTimer) {
          loginSession = null;
        }
        if (action === 'resetVault') {
          savedQuotas.clear();
          quotaErrors.clear();
        }
        for (const [addr, snapshot] of Object.entries(result?.quotas || {})) {
          savedQuotas.set(addr, snapshot);
        }
        syncWarmCache();
        if (action !== 'switch' && draftRiskAccepted && !riskLockedFromServer && !isVaultLocked()) {
          void refreshSavedQuotas();
        }
        if (action === 'save' || action === 'capture') {
          importOpen = false;
          setTransientStatus('saved', 2600);
        } else if (action === 'remove') {
          savedQuotas.delete(fields.email);
          quotaErrors.delete(fields.email);
          syncWarmCache();
          setTransientStatus('removed', 2600);
        } else if (action === 'switch') {
          setTransientStatus(
            result.restarting ? 'restarting' : 'switchStartFailed',
            result.restarting ? 0 : 4500
          );
        } else if (action === 'setPassword') {
          pwdDrawerOpen = false;
          setTransientStatus('pwdEnabledToast', 2600);
        } else if (action === 'changePassword') {
          pwdDrawerOpen = false;
          setTransientStatus('pwdChangedToast', 2600);
        } else if (action === 'disablePassword') {
          pwdDrawerOpen = false;
          setTransientStatus('pwdDisabledToast', 2600);
        } else if (action === 'unlockVault') {
          forgotResetOpen = false;
          quotaErrors.clear();
          setTransientStatus('vaultUnlockedToast', 2200);
        } else if (action === 'lockVault') {
          pwdDrawerOpen = false;
          importOpen = false;
          setTransientStatus('vaultLockedToast', 2200);
        } else if (action === 'resetVault') {
          forgotResetOpen = false;
          setTransientStatus('vaultResetToast', 2600);
        }
      } catch {
        setTransientStatus('storeFailed', 3200);
      } finally {
        operation = '';
        if (!disposed) {
          render();
          if (loginRefreshEmail) {
            const email = loginRefreshEmail;
            loginRefreshEmail = '';
            void refreshLoginAccount(email);
          }
        }
      }
    }

    async function refreshLoginAccount(email) {
      if (disposed || !email) return;
      if (operation) {
        loginRefreshEmail = email;
        return;
      }
      await request('list');
      if (
        !disposed &&
        refreshMinutes > 0 &&
        draftRiskAccepted &&
        !isVaultLocked() &&
        email !== resolveActiveEmail()
      ) {
        void refreshQuota(email, false);
      }
    }

    function applyLogin(session) {
      clearTimeout(loginTimer);
      const termKey = getTerminalLoginKey(session);
      if (termKey && dismissedTerminalLogins.has(termKey)) {
        clearLoginDismissTimer();
        loginSession = null;
        return;
      }
      const prevTermKey = getTerminalLoginKey(loginSession);
      loginSession = session || null;
      if (ACTIVE_LOGIN_STATUSES.has(session?.status)) {
        clearLoginDismissTimer();
        loginTimer = setTimeout(() => pollLogin(session.id, loginGeneration), 1000);
        loginTimer.unref?.();
        return;
      }
      if (termKey) {
        if (prevTermKey === termKey && loginDismissTimer) {
          return;
        }
        clearLoginDismissTimer();
        const isErr =
          session.status === 'error' ||
          session.status === 'expired' ||
          session.error === 'loginDenied';
        const autoHideMs = isErr ? 4500 : 2800;
        loginDismissTimer = setTimeout(() => {
          loginDismissTimer = null;
          rememberDismissedTerminalLogin(termKey);
          if (!disposed && getTerminalLoginKey(loginSession) === termKey) {
            loginSession = null;
            render();
          }
        }, autoHideMs);
        loginDismissTimer.unref?.();
      } else {
        clearLoginDismissTimer();
      }
    }

    async function pollLogin(id, generation) {
      try {
        const result = await callSidecarApi('/api/accounts/update', {
          method: 'POST',
          body: { action: 'loginStatus', id, ...(actionNonce ? { actionNonce } : {}) },
          cdpTimeoutMs: 10000,
        });
        if (disposed || generation !== loginGeneration) return;
        if (typeof result?.actionNonce === 'string' && result.actionNonce) {
          actionNonce = result.actionNonce;
        }
        if (result.error) throw new Error(result.error);
        applyLogin(result.login);
        if (loginSession?.status === 'success') await refreshLoginAccount(loginSession.email);
      } catch {
        if (disposed || generation !== loginGeneration) return;
        applyLogin({ id, status: 'error', error: 'loginStartFailed' });
      }
      if (!disposed) render();
    }

    async function refreshSavedQuotas() {
      if (refreshMinutes <= 0 || refreshingSavedQuotas || !draftRiskAccepted || isVaultLocked()) return;
      refreshingSavedQuotas = true;
      try {
        const activeEmail = resolveActiveEmail();
        const ttlMs = refreshMinutes * 60_000;
        const staleTargets = accounts.filter((addr) => {
          if (!addr || addr === activeEmail) return false;
          const cached = savedQuotas.get(addr);
          if (needsLegacyUltraTierRefresh(cached)) return true;
          return Date.now() - (cached?.fetchedAt || 0) >= ttlMs;
        });
        const BATCH_SIZE = 3;
        for (let i = 0; i < staleTargets.length; i += BATCH_SIZE) {
          if (
            disposed ||
            refreshMinutes <= 0 ||
            operation === 'switch' ||
            !draftRiskAccepted ||
            isVaultLocked()
          ) {
            break;
          }
          const batch = staleTargets.slice(i, i + BATCH_SIZE);
          await Promise.all(batch.map((addr) => refreshQuota(addr, false)));
        }
      } finally {
        refreshingSavedQuotas = false;
      }
    }

    async function refreshQuota(addr, manual = false) {
      const activeEmail = resolveActiveEmail();
      if (
        !addr ||
        addr === activeEmail ||
        (!manual && refreshMinutes <= 0) ||
        !draftRiskAccepted ||
        isVaultLocked() ||
        quotaInFlight.has(addr) ||
        disposed
      ) {
        return;
      }
      const hasCachedPools = Boolean(savedQuotas.get(addr)?.pools?.length);
      const showSpinner = manual || !hasCachedPools;
      quotaInFlight.add(addr);
      if (showSpinner) quotaVisibleLoading.add(addr);
      quotaErrors.delete(addr);
      if (showSpinner || quotaErrors.size > 0) render();
      try {
        const result = await callSidecarApi('/api/accounts/update', {
          method: 'POST',
          body: { action: 'quota', email: addr, ...(actionNonce ? { actionNonce } : {}) },
          cdpTimeoutMs: 40000,
        });
        if (typeof result?.actionNonce === 'string' && result.actionNonce) {
          actionNonce = result.actionNonce;
        }
        if (result?.error === 'vaultLocked') {
          vaultSecurity = { enabled: true, unlocked: false };
          syncWarmCache();
          return;
        }
        if (result?.error) {
          if (manual || !hasCachedPools) {
            quotaErrors.set(addr, errors.has(result.error) ? result.error : 'quotaUnavailable');
          }
        } else {
          const prev = savedQuotas.get(addr) || {};
          const nextTierId = result.tierId || prev.tierId || '';
          const nextTierName = result.tierName || prev.tierName || '';
          const nextTierMult = result.tierMultiplier || prev.tierMultiplier || '';
          const fetchedAt = result.fetchedAt || Date.now();
          savedQuotas.set(addr, {
            pools: result.pools,
            fetchedAt,
            ...(nextTierId ? { tierId: nextTierId } : {}),
            ...(nextTierName ? { tierName: nextTierName } : {}),
            ...(nextTierMult ? { tierMultiplier: nextTierMult } : {}),
          });
          syncWarmCache();
        }
      } catch {
        if (manual || !hasCachedPools) {
          quotaErrors.set(addr, 'quotaUnavailable');
        }
      } finally {
        quotaInFlight.delete(addr);
        quotaVisibleLoading.delete(addr);
        if (!disposed) render();
      }
    }

    function submitUnlock(event) {
      event.preventDefault();
      if (operation) return;
      const pwd = unlockInput.value;
      unlockInput.value = '';
      if (!isValidVaultPassphrase(pwd)) {
        setTransientStatus('wrongPassword', 3000);
        render();
        return;
      }
      void request('unlockVault', { password: pwd });
    }

    function submitPasswordDrawer(event) {
      event.preventDefault();
      if (operation) return;
      const curPwd = pwdCurrentInput.value;
      const nextPwd = pwdNewInput.value;
      const confirmPwd = pwdConfirmInput.value;
      clearPasswordInputs();

      if (!vaultSecurity.enabled) {
        if (!isValidVaultPassphrase(nextPwd)) {
          setTransientStatus('invalidPassword', 3200);
          render();
          return;
        }
        if (nextPwd !== confirmPwd) {
          setTransientStatus('passwordMismatch', 3200);
          render();
          return;
        }
        void request('setPassword', { newPassword: nextPwd });
        return;
      }

      if (!isValidVaultPassphrase(curPwd)) {
        setTransientStatus('wrongPassword', 3000);
        render();
        return;
      }
      if (pwdManageMode === 'disable') {
        void request('disablePassword', { currentPassword: curPwd });
        return;
      }
      if (!isValidVaultPassphrase(nextPwd)) {
        setTransientStatus('invalidPassword', 3200);
        render();
        return;
      }
      if (nextPwd !== confirmPwd) {
        setTransientStatus('passwordMismatch', 3200);
        render();
        return;
      }
      void request('changePassword', { currentPassword: curPwd, newPassword: nextPwd });
    }

    function importCredential(event) {
      event.preventDefault();
      if (operation) return;
      const input = credential.value;
      credential.value = '';
      void request('save', { credential: input });
    }

    function renderAccount(value, quotaData, settingsData) {
      const nextRefreshMins =
        settingsData?.accountQuotaRefreshMinutes !== undefined
          ? normalizeAccountQuotaRefreshMinutes(settingsData.accountQuotaRefreshMinutes)
          : refreshMinutes;
      const nextRiskAccepted =
        acceptingRisk || settingsData?.accountSwitchRiskAccepted === undefined
          ? draftRiskAccepted
          : Boolean(settingsData.accountSwitchRiskAccepted);
      if (
        account === value &&
        quotas === quotaData &&
        refreshMinutes === nextRefreshMins &&
        draftRiskAccepted === nextRiskAccepted
      ) {
        return;
      }
      const becameRiskUnlocked = !draftRiskAccepted && nextRiskAccepted;
      account = value;
      quotas = quotaData;
      refreshMinutes = nextRefreshMins;
      draftRiskAccepted = nextRiskAccepted;
      render();
      if (becameRiskUnlocked && riskLockedFromServer && !operation) {
        void request('list');
      }
    }

    const quotaScheduleTimer = setInterval(() => {
      if (
        !disposed &&
        refreshMinutes > 0 &&
        draftRiskAccepted &&
        accounts.length > 0 &&
        !operation &&
        !isVaultLocked()
      ) {
        void refreshSavedQuotas();
      }
    }, 60_000);
    quotaScheduleTimer.unref?.();

    const root = h('div', { className: 'settings-tab-stack settings-account-root' }, [
      quotaTrendCard.el,
      activeCardHost,
      emptyPanel,
      riskStage,
    ]);
    render();
    onCleanup(() => {
      disposed = true;
      clearTimeout(loginTimer);
      clearLoginDismissTimer();
      clearInterval(quotaScheduleTimer);
      if (statusClearTimer) clearTimeout(statusClearTimer);
      if (confirmClearTimer) clearTimeout(confirmClearTimer);
      refreshIntervalSelect.destroy();
      pwdModeSegment.destroy();
      quotaTrendCard.destroy();
      loginGeneration += 1;
      credential.value = '';
      clearPasswordInputs();
    });
    return {
      el: root,
      refs: {
        renderAccount,
        refreshLabels: () => {
          quotaTrendCard.refs.refreshLabels();
          render();
        },
        preload: () => (supported === null ? request('list') : Promise.resolve()),
        load: () =>
          supported === null || (draftRiskAccepted && riskLockedFromServer)
            ? request('list')
            : draftRiskAccepted
              ? refreshSavedQuotas()
              : Promise.resolve(),
      },
    };
  },
});
