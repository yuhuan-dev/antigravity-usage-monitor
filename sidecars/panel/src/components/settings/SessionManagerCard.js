/**
 * @fileoverview 本地三端会话管理卡片组件 (`SessionManagerCard.js`)。
 *
 * Usage Monitor 原生风格：
 * - 100% 视口自适应全高列表，支持本机 Desktop / CLI / 旧版 IDE 三端会话筛选、搜索、多维度排行与批量清理；
 * - 支持单击勾选与 Shift 区间连选；
 * - 零原生 checkbox / `<select>` / `window.confirm`：全部采用 `.select-checkbox`、`CustomSelect`、
 *   `SegmentedControl`、`ToggleSwitch`、`SearchInput`、`CustomScrollbar`、`ActionMenu` 与内联危险确认抽屉。
 */

import { defineComponent } from '../../core/component.js';
import { h, patchAttr, patchClasses, patchText } from '../../core/domPatch.js';
import {
  formatCompactBytes,
  formatCompactDateTime,
  formatTokensPrecise,
  formatUsd,
} from '../../core/formatters.js';
import { createSvgIcon } from '../../icons/SvgIcon.js';

export { formatCompactBytes };
import { t } from '../../i18n/index.js';
import {
  deleteLocalSessionsAction,
  fetchLocalSessionsList,
  fetchSessionCleanupPreview,
  redactLocalLedgerPrivacy,
} from '../../store/telemetryStore.js';
import { ActionMenu } from '../ui/ActionMenu.js';
import { CustomScrollbar } from '../ui/CustomScrollbar.js';
import { CustomSelect } from '../ui/CustomSelect.js';
import { createSearchInput } from '../ui/SearchInput.js';
import { SegmentedControl } from '../ui/SegmentedControl.js';
import { ToggleSwitch } from '../ui/ToggleSwitch.js';

const SMGR_PAGE_SIZE = 80;
const SMGR_PREFS_STORAGE_KEY = 'ag_um_session_clean_prefs_v1';
const SMGR_EXACT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SMGR_VALID_SORTS = new Set(['time_desc', 'time_asc', 'size_desc', 'cost_desc', 'tokens_desc']);

function normalizeSortKey(raw) {
  const k = String(raw || '').trim();
  return SMGR_VALID_SORTS.has(k) ? k : 'time_desc';
}

function loadCleanupPrefs() {
  const defaults = {
    redactLedger: true,
    clearBrowserCache: false,
    hideIndexOnly: true,
    sortBy: 'time_desc',
  };
  try {
    if (typeof localStorage === 'undefined') return defaults;
    const raw = localStorage.getItem(SMGR_PREFS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return {
      redactLedger: parsed?.redactLedger !== false,
      clearBrowserCache: Boolean(parsed?.clearBrowserCache),
      hideIndexOnly: parsed?.hideIndexOnly !== false,
      sortBy: normalizeSortKey(parsed?.sortBy),
    };
  } catch {
    return defaults;
  }
}

function saveCleanupPrefs(prefs) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(SMGR_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // 忽略沙箱存储异常
  }
}

const SMGR_LARGE_SESSION_BYTES = 50 * 1024 * 1024;

function buildSessionSizeTooltip(session) {
  const totalBytes = Math.max(0, Number(session?.sizeBytes || 0));
  const totalLine = t('settings.smgr.sizeTooltipTotal', {
    size: formatCompactBytes(totalBytes),
  });
  const dbBytes = Math.max(0, Number(session?.dbSizeBytes || 0));
  const brainBytes = Math.max(0, Number(session?.brainSizeBytes || 0));
  const subBytes = Math.max(0, Number(session?.subagentSizeBytes || 0));
  const parts = [];
  if (dbBytes > 0) parts.push(t('settings.smgr.sizePartDb', { size: formatCompactBytes(dbBytes) }));
  if (brainBytes > 0) parts.push(t('settings.smgr.sizePartBrain', { size: formatCompactBytes(brainBytes) }));
  if (subBytes > 0) parts.push(t('settings.smgr.sizePartSubagents', { size: formatCompactBytes(subBytes) }));
  if (parts.length >= 2 || (parts.length === 1 && (brainBytes > 0 || subBytes > 0))) {
    return `${totalLine}\n${parts.join(' · ')}`;
  }
  return totalLine;
}

function getClientDisplayName(clientId) {
  if (clientId === 'cli') return t('settings.smgr.sourceCli');
  if (clientId === 'ide_legacy') return t('settings.smgr.sourceIde');
  return t('settings.smgr.sourceDesktop');
}

function getSessionDeleteBlockedTip(session) {
  if (!session || session.canDelete) return '';
  const reason = String(session.deleteBlockedReason || '').trim();
  if (reason === 'session_running') return t('settings.smgr.deleteSessionRunningTip');
  if (reason === 'index_only_online') return t('settings.smgr.deleteIndexOnlyOnlineTip');
  if (reason === 'process_check_failed') return t('settings.smgr.guardCheckFailed');
  return t('settings.smgr.deleteRunningTip');
}

function getSortOptions() {
  return [
    { value: 'time_desc', label: t('settings.smgr.sortTimeDesc') },
    { value: 'time_asc', label: t('settings.smgr.sortTimeAsc') },
    { value: 'size_desc', label: t('settings.smgr.sortSizeDesc') },
    { value: 'cost_desc', label: t('settings.smgr.sortCostDesc') },
    { value: 'tokens_desc', label: t('settings.smgr.sortTokensDesc') },
  ];
}

function compareSessionsBySort(a, b, sortBy) {
  const timeTieBreak = () =>
    (Number(b?.lastModifiedMs || 0) - Number(a?.lastModifiedMs || 0)) ||
    String(a?.sessionId || '').localeCompare(String(b?.sessionId || ''));

  switch (sortBy) {
    case 'time_asc':
      return (
        (Number(a?.lastModifiedMs || 0) - Number(b?.lastModifiedMs || 0)) ||
        String(a?.sessionId || '').localeCompare(String(b?.sessionId || ''))
      );
    case 'size_desc':
      return (Number(b?.sizeBytes || 0) - Number(a?.sizeBytes || 0)) || timeTieBreak();
    case 'cost_desc':
      return (
        (Number(b?.telemetry?.costUsd || 0) - Number(a?.telemetry?.costUsd || 0)) ||
        (Number(b?.telemetry?.totalTokens || 0) - Number(a?.telemetry?.totalTokens || 0)) ||
        timeTieBreak()
      );
    case 'tokens_desc':
      return (
        (Number(b?.telemetry?.totalTokens || 0) - Number(a?.telemetry?.totalTokens || 0)) ||
        (Number(b?.telemetry?.costUsd || 0) - Number(a?.telemetry?.costUsd || 0)) ||
        timeTieBreak()
      );
    case 'time_desc':
    default:
      return timeTieBreak();
  }
}

function sessionItemKey(session) {
  return `${session?.clientId || ''}:${session?.sessionId || ''}`;
}

export const SessionManagerCard = defineComponent({
  name: 'SessionManagerCard',
  setup({ getProps, onCleanup }) {
    const prefs = loadCleanupPrefs();

    let loadedOnce = false;
    let isLoading = false;
    let isDeleting = false;
    let isSweeping = false;
    let remoteUnsupported = false;

    let catalog = null; // { clients, runningClients, onlineDeleteClients, sessions, counts, warnings }
    let sourceFilter = 'all'; // 'all' | 'desktop' | 'cli' | 'ide_legacy'
    let searchQuery = '';
    let visibleLimit = SMGR_PAGE_SIZE;
    let selectedKeys = new Set();
    let lastAnchorKey = '';

    let prefsExpanded = false;
    let confirmState = null; // { targets, preview, includeOrphans, purgeProtectedBrain }
    let previewReqSeq = 0;
    let reloadSeq = 0;
    let activeReloadCount = 0;
    let resultBanner = null; // { ok, text, detail }

    function dismissConfirmDrawer() {
      previewReqSeq += 1;
      if (!confirmState || isDeleting) return;
      confirmState = null;
      renderConfirmBox();
      getProps()?.onLayoutChange?.();
    }

    function resolveApi() {
      const p = getProps() || {};
      return {
        loadList: typeof p.loadList === 'function' ? p.loadList : fetchLocalSessionsList,
        loadPreview: typeof p.loadPreview === 'function' ? p.loadPreview : fetchSessionCleanupPreview,
        runDelete: typeof p.runDelete === 'function' ? p.runDelete : deleteLocalSessionsAction,
        runSweep: typeof p.runSweep === 'function' ? p.runSweep : redactLocalLedgerPrivacy,
      };
    }

    // 1. 顶栏
    const titleTextEl = h('span', { text: t('settings.smgr.title') });
    const totalCountBadge = h('span', { className: 'smgr-title-count', text: '0' });
    const totalSizeTextEl = h('span', { text: '' });
    const totalSizeBadge = h(
      'span',
      { className: 'smgr-title-size', hidden: true },
      [createSvgIcon('database', { size: 10 }), totalSizeTextEl]
    );
    const refreshBtnTextEl = h('span', { text: t('settings.smgr.refresh') });
    const refreshBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-ghost-sm smgr-refresh-btn',
        onClick: () => {
          void reload();
        },
      },
      [createSvgIcon('refresh', { size: 12 }), refreshBtnTextEl]
    );

    const moreMenu = ActionMenu({
      align: 'right',
      ariaLabel: t('settings.smgr.moreAria'),
      items: [],
    });

    const headerEl = h('div', { className: 'panel-header smgr-header' }, [
      h('span', { className: 'panel-title' }, [
        createSvgIcon('layers', { size: 13 }),
        titleTextEl,
        totalCountBadge,
        totalSizeBadge,
      ]),
      h('div', { className: 'smgr-header-actions' }, [refreshBtn, moreMenu.el]),
    ]);

    // 2. 来源分段条
    const sourceSeg = SegmentedControl({
      options: [],
      modelValue: sourceFilter,
      ariaLabel: t('settings.smgr.sourceAria'),
      onChange: (val) => {
        sourceFilter = val || 'all';
        visibleLimit = SMGR_PAGE_SIZE;
        lastAnchorKey = '';
        dismissConfirmDrawer();
        renderList();
      },
    });
    sourceSeg.el.classList.add('smgr-source-seg');

    // 3. 运行态守卫提示（仅只读受限或进程探测失败时显示）
    const guardNoticeEl = h('div', { className: 'smgr-guard-notice', hidden: true });

    // 4. 可折叠清理偏好抽屉
    const prefRedactLabelEl = h('div', {
      className: 'smgr-pref-title',
      text: t('settings.smgr.prefRedactLedger'),
    });
    const prefRedactDescEl = h('div', {
      className: 'smgr-pref-desc',
      text: t('settings.smgr.prefRedactLedgerDesc'),
    });
    const prefRedactToggle = ToggleSwitch({
      preset: 'enable',
      modelValue: prefs.redactLedger ? 'on' : 'off',
      ariaLabel: t('settings.smgr.prefRedactLedger'),
      onChange: (v) => {
        prefs.redactLedger = v === 'on';
        saveCleanupPrefs(prefs);
        renderConfirmBox();
      },
    });

    const prefCacheLabelEl = h('div', {
      className: 'smgr-pref-title',
      text: t('settings.smgr.prefClearCache'),
    });
    const prefCacheDescEl = h('div', {
      className: 'smgr-pref-desc',
      text: t('settings.smgr.prefClearCacheDesc'),
    });
    const prefCacheToggle = ToggleSwitch({
      preset: 'enable',
      modelValue: prefs.clearBrowserCache ? 'on' : 'off',
      ariaLabel: t('settings.smgr.prefClearCache'),
      onChange: (v) => {
        prefs.clearBrowserCache = v === 'on';
        saveCleanupPrefs(prefs);
        renderConfirmBox();
      },
    });

    const prefsDrawerEl = h('div', { className: 'smgr-prefs-drawer', hidden: true }, [
      h('div', { className: 'smgr-pref-row' }, [
        h('div', { className: 'smgr-pref-text' }, [prefRedactLabelEl, prefRedactDescEl]),
        prefRedactToggle.el,
      ]),
      h('div', { className: 'smgr-pref-row' }, [
        h('div', { className: 'smgr-pref-text' }, [prefCacheLabelEl, prefCacheDescEl]),
        prefCacheToggle.el,
      ]),
    ]);

    // 5. 搜索 + 排行下拉 + 齐平列表操作栏
    const searchControl = createSearchInput({
      wrapClassName: 'smgr-search-wrap',
      inputClassName: 'smgr-search-input',
      clearClassName: 'smgr-search-clear',
      placeholder: t('settings.smgr.searchPlaceholder'),
      ariaLabel: t('settings.smgr.searchAria'),
      clearAriaLabel: t('settings.smgr.clearSearchAria'),
      onInput: (val) => {
        searchQuery = String(val || '').trim();
        visibleLimit = SMGR_PAGE_SIZE;
        lastAnchorKey = '';
        dismissConfirmDrawer();
        renderList();
      },
    });

    const sortSelect = CustomSelect({
      ariaLabel: t('settings.smgr.sortAria'),
      modelValue: prefs.sortBy,
      options: getSortOptions(),
      className: 'smgr-sort-select',
      onUpdateModelValue: (val) => {
        const nextSort = normalizeSortKey(val);
        if (nextSort === prefs.sortBy) return;
        prefs.sortBy = nextSort;
        saveCleanupPrefs(prefs);
        visibleLimit = SMGR_PAGE_SIZE;
        lastAnchorKey = '';
        dismissConfirmDrawer();
        renderList();
      },
    });

    const searchRowEl = h('div', { className: 'smgr-search-row' }, [
      searchControl.el,
      sortSelect.el,
    ]);

    const selectAllCheckBoxEl = h('span', {
      className: 'select-checkbox smgr-checkbox smgr-select-all-box',
      'aria-hidden': 'true',
    });
    const toggleAllTextEl = h('span', {
      className: 'smgr-select-all-label',
      text: t('settings.smgr.selectAll'),
    });
    const toggleAllBtn = h(
      'button',
      {
        type: 'button',
        className: 'smgr-select-all-btn',
        onClick: () => handleToggleSelectAll(),
      },
      [selectAllCheckBoxEl, toggleAllTextEl]
    );

    const clearSelBtn = h('button', {
      type: 'button',
      className: 'smgr-inline-link-btn smgr-clear-sel-btn',
      hidden: true,
      text: t('settings.smgr.clearSelShort'),
      onClick: () => {
        if (selectedKeys.size === 0 || isDeleting) return;
        selectedKeys.clear();
        lastAnchorKey = '';
        dismissConfirmDrawer();
        renderList();
      },
    });

    const hideIdxBoxEl = h('span', {
      className: `select-checkbox smgr-checkbox smgr-inline-check${prefs.hideIndexOnly ? ' is-checked' : ''}`,
      'aria-hidden': 'true',
    }, prefs.hideIndexOnly ? [createSvgIcon('check', { size: 9 })] : []);
    const hideIdxBtnTextEl = h('span', { text: t('settings.smgr.hideIndexOnly') });
    const hideIdxBtn = h(
      'button',
      {
        type: 'button',
        className: `smgr-inline-toggle${prefs.hideIndexOnly ? ' is-active' : ''}`,
        'aria-pressed': prefs.hideIndexOnly ? 'true' : 'false',
        title: t('settings.smgr.hideIndexOnlyTitle'),
        onClick: () => {
          prefs.hideIndexOnly = !prefs.hideIndexOnly;
          saveCleanupPrefs(prefs);
          syncHideIdxButton();
          visibleLimit = SMGR_PAGE_SIZE;
          lastAnchorKey = '';
          dismissConfirmDrawer();
          renderList();
        },
      },
      [hideIdxBoxEl, hideIdxBtnTextEl]
    );

    function syncHideIdxButton() {
      patchClasses(hideIdxBtn, { 'is-active': prefs.hideIndexOnly });
      patchAttr(hideIdxBtn, 'aria-pressed', prefs.hideIndexOnly ? 'true' : 'false');
      patchClasses(hideIdxBoxEl, { 'is-checked': prefs.hideIndexOnly });
      hideIdxBoxEl.textContent = '';
      if (prefs.hideIndexOnly) {
        hideIdxBoxEl.appendChild(createSvgIcon('check', { size: 9 }));
      }
    }

    const batchDeleteTextEl = h('span');
    const batchDeleteBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-danger-sm smgr-batch-delete-btn',
        hidden: true,
        onClick: () => {
          const targets = getSelectedTargets();
          if (targets.length > 0) void openDeleteConfirm(targets);
        },
      },
      [createSvgIcon('trash', { size: 12 }), batchDeleteTextEl]
    );

    const selectedSizeTextEl = h('span', { text: '' });
    const selectedSizeEl = h(
      'span',
      { className: 'smgr-selected-size', hidden: true },
      [createSvgIcon('database', { size: 10 }), selectedSizeTextEl]
    );

    const actionBarEl = h('div', { className: 'smgr-action-bar' }, [
      h('div', { className: 'smgr-action-left' }, [toggleAllBtn, clearSelBtn, selectedSizeEl]),
      h('div', { className: 'smgr-action-right' }, [hideIdxBtn, batchDeleteBtn]),
    ]);

    const toolbarEl = h('div', { className: 'smgr-toolbar' }, [searchRowEl, actionBarEl]);

    // 6. 内联二次确认抽屉与结果提示条
    const confirmBoxEl = h('div', { className: 'smgr-confirm-box', hidden: true });
    const resultBoxEl = h('div', { className: 'smgr-result', hidden: true });

    // 7. 100% 高度自适应列表滚动区
    const listEl = h('div', { className: 'smgr-list' });
    const listScrollbar = CustomScrollbar({
      contentEl: listEl,
      className: 'smgr-list-scroll-host',
    });

    const rootEl = h('section', { className: 'panel smgr-panel' }, [
      headerEl,
      sourceSeg.el,
      guardNoticeEl,
      prefsDrawerEl,
      confirmBoxEl,
      resultBoxEl,
      toolbarEl,
      listScrollbar.el,
    ]);

    // -----------------------------------------------------------------------
    // 数据过滤、排行与多选辅助
    // -----------------------------------------------------------------------

    function getAllSessions() {
      return Array.isArray(catalog?.sessions) ? catalog.sessions : [];
    }

    function getFilteredSessions() {
      const all = getAllSessions();
      const q = searchQuery.toLowerCase();
      const isExactUuid = SMGR_EXACT_UUID_RE.test(q);
      const filtered = all.filter((s) => {
        if (sourceFilter !== 'all' && s.clientId !== sourceFilter) return false;
        if (prefs.hideIndexOnly && s.indexOnly && !isExactUuid) return false;
        if (!q) return true;
        return (
          String(s.title || '').toLowerCase().includes(q) ||
          String(s.preview || '').toLowerCase().includes(q) ||
          String(s.workspaceName || '').toLowerCase().includes(q) ||
          String(s.workspacePath || '').toLowerCase().includes(q) ||
          String(s.sessionId || '').toLowerCase().includes(q)
        );
      });
      if (prefs.sortBy !== 'time_desc' || filtered.length > 1) {
        filtered.sort((a, b) => compareSessionsBySort(a, b, prefs.sortBy));
      }
      return filtered;
    }

    function getSessionByKey(key) {
      if (!key) return null;
      return getAllSessions().find((s) => sessionItemKey(s) === key) || null;
    }

    function getSelectedStats() {
      const targets = [];
      let totalSizeBytes = 0;
      for (const s of getAllSessions()) {
        if (s.canDelete && selectedKeys.has(sessionItemKey(s))) {
          targets.push({ clientId: s.clientId, sessionId: s.sessionId });
          totalSizeBytes += Math.max(0, Number(s.sizeBytes || 0));
        }
      }
      return { targets, count: targets.length, totalSizeBytes };
    }

    function getSelectedTargets() {
      return getSelectedStats().targets;
    }

    function computeAllSessionsTotalBytes() {
      const all = getAllSessions();
      if (all.length > 0) {
        return all.reduce((sum, s) => sum + Math.max(0, Number(s.sizeBytes || 0)), 0);
      }
      return Math.max(0, Number(catalog?.counts?.totalSizeBytes || 0));
    }

    function syncTotalSizeBadge(filtered) {
      if (!catalog || remoteUnsupported) {
        patchAttr(totalSizeBadge, 'hidden', true);
        return;
      }
      const allTotalBytes = computeAllSessionsTotalBytes();
      const filteredBytes = Array.isArray(filtered)
        ? filtered.reduce((sum, s) => sum + Math.max(0, Number(s.sizeBytes || 0)), 0)
        : allTotalBytes;
      const isNarrowed = sourceFilter !== 'all' || Boolean(searchQuery);
      const displayBytes = isNarrowed ? filteredBytes : filteredBytes || allTotalBytes;
      const formattedDisplay = formatCompactBytes(displayBytes);
      patchText(totalSizeTextEl, formattedDisplay);
      patchClasses(totalSizeBadge, { 'is-filtered': isNarrowed });
      const tip = isNarrowed
        ? t('settings.smgr.filteredSizeTitle', {
            filtered: formattedDisplay,
            total: formatCompactBytes(allTotalBytes),
          })
        : t('settings.smgr.totalSizeTitle', { size: formattedDisplay });
      patchAttr(totalSizeBadge, 'title', tip);
      patchAttr(totalSizeBadge, 'aria-label', tip);
      patchAttr(totalSizeBadge, 'hidden', false);
    }

    function rebuildTopMoreMenu() {
      moreMenu.refs.setItems([
        {
          key: 'toggle_prefs',
          icon: 'sliders',
          label: prefsExpanded
            ? t('settings.smgr.togglePrefsHide')
            : t('settings.smgr.togglePrefsShow'),
          onSelect: () => {
            prefsExpanded = !prefsExpanded;
            patchAttr(prefsDrawerEl, 'hidden', !prefsExpanded);
            rebuildTopMoreMenu();
            listScrollbar.refresh();
            getProps()?.onLayoutChange?.();
          },
        },
        {
          key: 'sweep_ledger',
          icon: 'shield',
          label: t('settings.smgr.sweepLedger'),
          disabled: isSweeping || remoteUnsupported,
          onSelect: () => {
            void handleSweepLedger();
          },
        },
      ]);
    }

    function isClientOnlineDeleteSupported(clientId) {
      if (catalog?.onlineDeleteClients && typeof catalog.onlineDeleteClients === 'object') {
        return Boolean(catalog.onlineDeleteClients[clientId]);
      }
      const info = Array.isArray(catalog?.clients)
        ? catalog.clients.find((c) => c.id === clientId)
        : null;
      return Boolean(info?.onlineDeleteSupported);
    }

    function syncSourceSegments() {
      const counts = catalog?.counts?.byClient || { desktop: 0, cli: 0, ide_legacy: 0 };
      const sizeByClient = catalog?.counts?.byClientSizeBytes || {};
      const total = Number(catalog?.counts?.total || 0);
      const running = catalog?.runningClients || {};
      const clientsList = Array.isArray(catalog?.clients) ? catalog.clients : [];
      const allTotalBytes = computeAllSessionsTotalBytes();

      const formatLabel = (base, count, isRun) => `${base} (${count})${isRun ? ' •' : ''}`;
      const opts = [
        {
          value: 'all',
          label: `${t('settings.smgr.sourceAll')} (${total})`,
          title:
            allTotalBytes > 0
              ? t('settings.smgr.totalSizeTitle', { size: formatCompactBytes(allTotalBytes) })
              : '',
        },
      ];

      for (const defId of ['desktop', 'cli', 'ide_legacy']) {
        const info = clientsList.find((c) => c.id === defId);
        const cnt = Number(counts[defId] || 0);
        if (info?.exists || cnt > 0 || defId === 'desktop') {
          const isRun = Boolean(running[defId]);
          const isOnline = isRun && isClientOnlineDeleteSupported(defId);
          const clientBytes = Number(info?.totalSizeBytes ?? sizeByClient[defId] ?? 0);
          const titleParts = [];
          if (clientBytes > 0) {
            titleParts.push(
              t('settings.smgr.totalSizeTitle', { size: formatCompactBytes(clientBytes) })
            );
          }
          if (isRun) {
            titleParts.push(
              isOnline ? t('settings.smgr.runningDotOnlineTitle') : t('settings.smgr.runningDotTitle')
            );
          }
          opts.push({
            value: defId,
            label: formatLabel(getClientDisplayName(defId), cnt, isRun),
            title: titleParts.join(' · '),
          });
        }
      }
      if (!opts.some((o) => o.value === sourceFilter)) {
        sourceFilter = 'all';
      }
      sourceSeg.setProps({
        options: opts,
        modelValue: sourceFilter,
        ariaLabel: t('settings.smgr.sourceAria'),
      });
      patchText(totalCountBadge, String(total));
    }

    function syncGuardNotice() {
      if (remoteUnsupported) {
        patchText(guardNoticeEl, t('settings.smgr.remoteUnsupported'));
        patchClasses(guardNoticeEl, { 'is-warn': false });
        patchAttr(guardNoticeEl, 'hidden', false);
        return;
      }
      const rc = catalog?.runningClients;
      if (!rc) {
        patchAttr(guardNoticeEl, 'hidden', true);
        return;
      }
      if (rc.checked === false) {
        patchText(guardNoticeEl, t('settings.smgr.guardCheckFailed'));
        patchClasses(guardNoticeEl, { 'is-warn': true });
        patchAttr(guardNoticeEl, 'hidden', false);
        return;
      }
      const readOnlyNames = [];
      for (const defId of ['desktop', 'cli', 'ide_legacy']) {
        if (!rc[defId]) continue;
        if (!isClientOnlineDeleteSupported(defId)) {
          readOnlyNames.push(getClientDisplayName(defId));
        }
      }
      if (readOnlyNames.length > 0) {
        patchText(
          guardNoticeEl,
          t('settings.smgr.guardNotice', { clients: readOnlyNames.join(' / ') })
        );
        patchClasses(guardNoticeEl, { 'is-warn': true });
        patchAttr(guardNoticeEl, 'hidden', false);
      } else {
        patchAttr(guardNoticeEl, 'hidden', true);
      }
    }

    function syncSelectionButtons(filtered) {
      const deletableFiltered = filtered.filter((s) => s.canDelete);
      const selectedInFiltered = deletableFiltered.filter((s) =>
        selectedKeys.has(sessionItemKey(s))
      ).length;
      const allSelected =
        deletableFiltered.length > 0 && selectedInFiltered === deletableFiltered.length;
      const partialSelected = selectedInFiltered > 0 && !allSelected;

      patchClasses(selectAllCheckBoxEl, {
        'is-checked': allSelected,
        'is-partial': partialSelected,
      });
      selectAllCheckBoxEl.textContent = '';
      if (allSelected) {
        selectAllCheckBoxEl.appendChild(createSvgIcon('check', { size: 9 }));
      } else if (partialSelected) {
        selectAllCheckBoxEl.appendChild(h('span', { className: 'smgr-partial-dash' }));
      }

      const { count: selCount, totalSizeBytes: selSizeBytes } = getSelectedStats();
      patchText(
        toggleAllTextEl,
        allSelected
          ? t('settings.smgr.clearSel')
          : selCount > 0
            ? t('settings.smgr.selectedCount', { n: selCount })
            : t('settings.smgr.selectAll')
      );
      patchAttr(toggleAllBtn, 'disabled', deletableFiltered.length === 0 || isDeleting);
      patchAttr(clearSelBtn, 'hidden', selCount === 0 || allSelected);
      patchAttr(clearSelBtn, 'disabled', isDeleting);

      patchAttr(selectedSizeEl, 'hidden', selCount === 0);
      if (selCount > 0) {
        const formattedSelSize = formatCompactBytes(selSizeBytes);
        patchText(selectedSizeTextEl, formattedSelSize);
        const selSizeTip = t('settings.smgr.selectedSizeTitle', { size: formattedSelSize });
        patchAttr(selectedSizeEl, 'title', selSizeTip);
        patchAttr(selectedSizeEl, 'aria-label', selSizeTip);
      }

      patchAttr(batchDeleteBtn, 'hidden', selCount === 0);
      patchAttr(batchDeleteBtn, 'disabled', selCount === 0 || isDeleting);
      patchText(batchDeleteTextEl, t('settings.smgr.deleteSelected', { n: selCount }));
    }

    function renderResultBanner() {
      resultBoxEl.textContent = '';
      if (!resultBanner) {
        patchAttr(resultBoxEl, 'hidden', true);
        return;
      }
      patchAttr(resultBoxEl, 'hidden', false);
      patchClasses(resultBoxEl, { 'is-ok': Boolean(resultBanner.ok), 'is-err': !resultBanner.ok });
      resultBoxEl.appendChild(
        h('div', { className: 'smgr-result-msg', text: resultBanner.text || '' })
      );
      if (resultBanner.detail) {
        resultBoxEl.appendChild(
          h('div', { className: 'smgr-result-detail', text: resultBanner.detail })
        );
      }
    }

    function renderConfirmBox() {
      confirmBoxEl.textContent = '';
      if (!confirmState) {
        patchAttr(confirmBoxEl, 'hidden', true);
        return;
      }
      patchAttr(confirmBoxEl, 'hidden', false);
      const { targets, preview, includeOrphans, purgeProtectedBrain } = confirmState;
      const deletableN = Number(preview?.deletableCount || 0);
      const onlineDeletableN = Number(preview?.onlineDeletableCount || 0);
      const offlineDeletableN =
        preview?.offlineDeletableCount !== undefined
          ? Number(preview.offlineDeletableCount || 0)
          : Math.max(0, deletableN - onlineDeletableN);
      const protectedItems = Array.isArray(preview?.protectedMigrationItems)
        ? preview.protectedMigrationItems
        : [];
      const protectedCount = protectedItems.length;
      const protectedOnlineCount =
        preview?.protectedMigrationOnlineCount !== undefined
          ? Number(preview.protectedMigrationOnlineCount || 0)
          : protectedItems.filter((it) => it?.mode === 'online').length;
      const protectedOfflineCount = Math.max(0, protectedCount - protectedOnlineCount);
      const effectiveDeletableN = purgeProtectedBrain
        ? deletableN
        : Math.max(0, deletableN - protectedOnlineCount);

      const header = h('div', { className: 'smgr-confirm-head' }, [
        createSvgIcon('warning', { size: 13 }),
        h('span', { className: 'smgr-confirm-title', text: t('settings.smgr.confirmTitle') }),
      ]);
      confirmBoxEl.appendChild(header);

      const bullets = [t('settings.smgr.confirmSummary', { n: effectiveDeletableN })];
      let reclaimableBytes = 0;
      if (preview && Number.isFinite(Number(preview.reclaimableSizeBytes))) {
        const rawReclaim = Math.max(0, Number(preview.reclaimableSizeBytes));
        const protOnlineBytes = Math.max(0, Number(preview.protectedOnlineSizeBytes || 0));
        reclaimableBytes = purgeProtectedBrain
          ? rawReclaim
          : Math.max(0, rawReclaim - protOnlineBytes);
      } else if (Array.isArray(targets) && targets.length > 0) {
        const blockedSet = new Set(
          (Array.isArray(preview?.blockedByRunning) ? preview.blockedByRunning : []).map(
            (b) => `${b.clientId}:${b.sessionId}`
          )
        );
        const protOnlineSet = new Set(
          protectedItems
            .filter((it) => it?.mode === 'online')
            .map((it) => `${it.clientId}:${it.sessionId}`)
        );
        for (const item of targets) {
          const itemKey = `${item.clientId}:${item.sessionId}`;
          if (blockedSet.has(itemKey)) continue;
          if (!purgeProtectedBrain && protOnlineSet.has(itemKey)) continue;
          const hit = getSessionByKey(itemKey);
          reclaimableBytes += Math.max(0, Number(hit?.sizeBytes || 0));
        }
      }
      if (effectiveDeletableN > 0 && reclaimableBytes > 0) {
        bullets.push(
          t('settings.smgr.confirmReclaimSize', { size: formatCompactBytes(reclaimableBytes) })
        );
      }
      if (onlineDeletableN > 0 && offlineDeletableN > 0) {
        bullets.push(
          t('settings.smgr.confirmOnlineMixed', { online: onlineDeletableN, offline: offlineDeletableN })
        );
      } else if (onlineDeletableN > 0) {
        bullets.push(t('settings.smgr.confirmOnlineMode', { n: onlineDeletableN }));
      }
      if (Array.isArray(targets) && targets.length > 0) {
        const previewLabels = targets.slice(0, 3).map((item) => {
          const hit = getSessionByKey(`${item.clientId}:${item.sessionId}`);
          return hit?.title || item.sessionId.slice(0, 8);
        });
        const moreSuffix = targets.length > 3 ? ` (+${targets.length - 3})` : '';
        bullets.push(
          t('settings.smgr.confirmTargets', {
            titles: `${previewLabels.join(' / ')}${moreSuffix}`,
          })
        );
      }
      if ((preview?.cascadeSubagentCount || 0) > 0) {
        bullets.push(t('settings.smgr.confirmCascade', { n: preview.cascadeSubagentCount }));
      }
      if ((preview?.crossSourceIndexMatches?.length || 0) > 0) {
        bullets.push(t('settings.smgr.confirmCrossIndex', { n: preview.crossSourceIndexMatches.length }));
      }
      if (protectedOfflineCount > 0) {
        bullets.push(t('settings.smgr.confirmProtected', { n: protectedOfflineCount }));
      }
      if (protectedOnlineCount > 0) {
        bullets.push(t('settings.smgr.confirmProtectedOnline', { n: protectedOnlineCount }));
      }
      if ((preview?.blockedByRunning?.length || 0) > 0) {
        bullets.push(t('settings.smgr.confirmBlocked', { n: preview.blockedByRunning.length }));
      }
      const desktopRunning = Boolean(preview?.runningClients?.desktop ?? catalog?.runningClients?.desktop);
      const optLabels = [];
      if (prefs.redactLedger) optLabels.push(t('settings.smgr.confirmOptRedact'));
      if (prefs.clearBrowserCache && !desktopRunning) optLabels.push(t('settings.smgr.confirmOptCache'));
      if (optLabels.length > 0) {
        bullets.push(t('settings.smgr.confirmOptions', { opts: optLabels.join(' + ') }));
      }

      const ul = h('ul', { className: 'smgr-confirm-list' });
      for (const line of bullets) {
        ul.appendChild(h('li', { text: line }));
      }
      confirmBoxEl.appendChild(ul);

      if (protectedCount > 0) {
        const protToggleRow = h(
          'button',
          {
            type: 'button',
            className: 'smgr-confirm-orphan-toggle smgr-confirm-protected-toggle',
            'aria-pressed': purgeProtectedBrain ? 'true' : 'false',
            onClick: () => {
              if (!confirmState || isDeleting) return;
              confirmState.purgeProtectedBrain = !confirmState.purgeProtectedBrain;
              renderConfirmBox();
            },
          },
          [
            h(
              'span',
              {
                className: `select-checkbox smgr-checkbox${purgeProtectedBrain ? ' is-checked' : ''}`,
                'aria-hidden': 'true',
              },
              purgeProtectedBrain ? [createSvgIcon('check', { size: 9 })] : []
            ),
            h('span', { text: t('settings.smgr.confirmPurgeProtectedToggle') }),
          ]
        );
        confirmBoxEl.appendChild(protToggleRow);
      }

      const orphanCount = preview?.orphanIndexMatches?.length || 0;
      if (orphanCount > 0) {
        const orphanRow = h(
          'button',
          {
            type: 'button',
            className: 'smgr-confirm-orphan-toggle',
            'aria-pressed': includeOrphans ? 'true' : 'false',
            onClick: () => {
              if (!confirmState || isDeleting) return;
              confirmState.includeOrphans = !confirmState.includeOrphans;
              renderConfirmBox();
            },
          },
          [
            h(
              'span',
              {
                className: `select-checkbox smgr-checkbox${includeOrphans ? ' is-checked' : ''}`,
                'aria-hidden': 'true',
              },
              includeOrphans ? [createSvgIcon('check', { size: 9 })] : []
            ),
            h('span', { text: t('settings.smgr.confirmOrphanToggle', { n: orphanCount }) }),
          ]
        );
        confirmBoxEl.appendChild(orphanRow);
      }

      const execBtn = h('button', {
        type: 'button',
        className: 'btn-danger-sm smgr-confirm-exec-btn',
        disabled: isDeleting || effectiveDeletableN === 0,
        text: isDeleting ? t('settings.smgr.confirmRunning') : t('settings.smgr.confirmExec'),
        onClick: () => {
          void executeConfirmedDelete();
        },
      });
      const cancelBtn = h('button', {
        type: 'button',
        className: 'btn-ghost-sm smgr-confirm-cancel-btn',
        disabled: isDeleting,
        text: t('settings.smgr.confirmCancel'),
        onClick: () => {
          confirmState = null;
          renderConfirmBox();
          listScrollbar.refresh();
          getProps()?.onLayoutChange?.();
        },
      });
      confirmBoxEl.appendChild(h('div', { className: 'smgr-confirm-actions' }, [execBtn, cancelBtn]));
    }

    function handleToggleSessionSelection(session, filtered, event) {
      if (!session?.canDelete || isDeleting) return;
      const key = sessionItemKey(session);
      const willSelect = !selectedKeys.has(key);

      if (Boolean(event?.shiftKey) && lastAnchorKey) {
        const anchorIdx = filtered.findIndex((item) => sessionItemKey(item) === lastAnchorKey);
        const curIdx = filtered.findIndex((item) => sessionItemKey(item) === key);
        if (anchorIdx >= 0 && curIdx >= 0) {
          event?.preventDefault?.();
          const start = Math.min(anchorIdx, curIdx);
          const end = Math.max(anchorIdx, curIdx);
          for (let i = start; i <= end; i += 1) {
            const item = filtered[i];
            if (!item?.canDelete) continue;
            const k = sessionItemKey(item);
            if (willSelect) selectedKeys.add(k);
            else selectedKeys.delete(k);
          }
          dismissConfirmDrawer();
          renderList();
          return;
        }
      }

      if (willSelect) selectedKeys.add(key);
      else selectedKeys.delete(key);
      lastAnchorKey = key;
      dismissConfirmDrawer();
      renderList();
    }

    function renderList() {
      listEl.textContent = '';
      if (isLoading && !catalog) {
        listEl.appendChild(
          h('div', { className: 'smgr-empty', text: t('settings.smgr.emptyLoading') })
        );
        syncTotalSizeBadge([]);
        syncSelectionButtons([]);
        listScrollbar.refresh();
        return;
      }

      const filtered = getFilteredSessions();
      syncTotalSizeBadge(filtered);
      syncSelectionButtons(filtered);

      if (filtered.length === 0) {
        listEl.appendChild(
          h('div', { className: 'smgr-empty', text: t('settings.smgr.emptyNone') })
        );
        listScrollbar.refresh();
        return;
      }

      const pageItems = filtered.slice(0, visibleLimit);
      for (const s of pageItems) {
        const key = sessionItemKey(s);
        const isChecked = s.canDelete && selectedKeys.has(key);
        const blockedTip = getSessionDeleteBlockedTip(s);

        const checkBtn = h(
          'button',
          {
            type: 'button',
            role: 'checkbox',
            'aria-checked': isChecked ? 'true' : 'false',
            className: `select-checkbox smgr-checkbox${isChecked ? ' is-checked' : ''}`,
            disabled: !s.canDelete || isDeleting,
            title: blockedTip,
            onClick: (e) => {
              e?.stopPropagation?.();
              handleToggleSessionSelection(s, filtered, e);
            },
          },
          isChecked ? [createSvgIcon('check', { size: 9 })] : []
        );

        const sessionSizeBytes = Math.max(0, Number(s.sizeBytes || 0));
        const sizeBadgeClass = [
          'smgr-badge',
          'smgr-size-badge',
          sessionSizeBytes >= SMGR_LARGE_SESSION_BYTES ? 'is-large' : '',
          sessionSizeBytes === 0 ? 'is-zero' : '',
        ]
          .filter(Boolean)
          .join(' ');
        const tags = [
          h('span', {
            className: `smgr-badge is-client-${s.clientId}`,
            text: getClientDisplayName(s.clientId),
          }),
          h(
            'span',
            {
              className: sizeBadgeClass,
              title: buildSessionSizeTooltip(s),
            },
            [
              createSvgIcon('database', { size: 10 }),
              h('span', { text: formatCompactBytes(sessionSizeBytes) }),
            ]
          ),
        ];
        if (s.indexOnly) {
          tags.push(h('span', { className: 'smgr-badge is-muted', text: t('settings.smgr.tagIndexOnly') }));
        }
        if (s.isFork) {
          tags.push(h('span', { className: 'smgr-badge is-accent', text: t('settings.smgr.tagFork') }));
        }
        if (s.subagentCount > 0) {
          tags.push(
            h('span', {
              className: 'smgr-badge is-muted',
              text: t('settings.smgr.tagSubagents', { n: s.subagentCount }),
            })
          );
        }
        if (s.protectedByMigration) {
          tags.push(h('span', { className: 'smgr-badge is-info', text: t('settings.smgr.tagProtected') }));
        }
        if (s.sessionRunning) {
          tags.push(h('span', { className: 'smgr-badge is-warn', text: t('settings.smgr.tagGenerating') }));
        } else if (s.clientRunning && !s.canDelete) {
          tags.push(h('span', { className: 'smgr-badge is-warn', text: t('settings.smgr.tagRunning') }));
        }

        const rightMetaParts = [];
        if (s.lastModifiedMs > 0) rightMetaParts.push(formatCompactDateTime(s.lastModifiedMs));

        const telNodes = [];
        if (s.telemetry?.recorded && s.telemetry.hasUsage) {
          const tParts = [];
          if (s.telemetry.totalTokens > 0) tParts.push(formatTokensPrecise(s.telemetry.totalTokens));
          if (s.telemetry.costUsd > 0) tParts.push(formatUsd(s.telemetry.costUsd));
          if (tParts.length > 0) {
            telNodes.push(
              h('span', { className: 'smgr-item-tel', text: tParts.join(' · ') })
            );
          }
        }

        const itemEl = h(
          'div',
          {
            className: `smgr-item${isChecked ? ' is-checked' : ''}${s.canDelete ? '' : ' is-blocked'}`,
            'data-session-key': key,
            title: blockedTip,
            onClick: (e) => {
              handleToggleSessionSelection(s, filtered, e);
            },
          },
          [
            checkBtn,
            h('div', { className: 'smgr-item-body' }, [
              h('div', { className: 'smgr-item-top' }, [
                h('span', { className: 'smgr-item-title', text: s.title || s.sessionId }),
                h('span', { className: 'smgr-item-meta', text: rightMetaParts.join(' · ') }),
              ]),
              h('div', { className: 'smgr-item-sub' }, [
                h('span', { className: 'smgr-item-ws', text: s.workspaceName || s.sessionId.slice(0, 8) }),
                ...telNodes,
              ]),
              h('div', { className: 'smgr-item-tags' }, tags),
            ]),
          ]
        );
        listEl.appendChild(itemEl);
      }

      if (filtered.length > visibleLimit) {
        const remaining = filtered.length - visibleLimit;
        listEl.appendChild(
          h('button', {
            type: 'button',
            className: 'btn-ghost-sm smgr-load-more-btn',
            text: t('settings.smgr.loadMore', { n: remaining }),
            onClick: () => {
              visibleLimit += SMGR_PAGE_SIZE;
              renderList();
            },
          })
        );
      }

      listScrollbar.refresh();
    }

    // -----------------------------------------------------------------------
    // 异步交互流程
    // -----------------------------------------------------------------------

    function handleToggleSelectAll() {
      const deletable = getFilteredSessions().filter((s) => s.canDelete);
      if (deletable.length === 0) return;
      const allSelected = deletable.every((s) => selectedKeys.has(sessionItemKey(s)));
      if (allSelected) {
        for (const s of deletable) selectedKeys.delete(sessionItemKey(s));
      } else {
        for (const s of deletable) selectedKeys.add(sessionItemKey(s));
      }
      lastAnchorKey = '';
      dismissConfirmDrawer();
      renderList();
    }

    async function openDeleteConfirm(targets) {
      if (!Array.isArray(targets) || targets.length === 0 || isDeleting) return;
      const reqSeq = ++previewReqSeq;
      resultBanner = null;
      renderResultBanner();
      try {
        const preview = await resolveApi().loadPreview({ targets });
        if (reqSeq !== previewReqSeq || isDeleting) return;
        confirmState = {
          targets: targets.map((item) => ({ clientId: item.clientId, sessionId: item.sessionId })),
          preview,
          includeOrphans: false,
          purgeProtectedBrain: false,
        };
        renderConfirmBox();
        listScrollbar.refresh();
        getProps()?.onLayoutChange?.();
      } catch (err) {
        if (reqSeq !== previewReqSeq) return;
        resultBanner = { ok: false, text: err?.message || 'preview_failed' };
        renderResultBanner();
      }
    }

    async function executeConfirmedDelete() {
      if (!confirmState || isDeleting) return;
      isDeleting = true;
      renderConfirmBox();
      try {
        const desktopRunning = Boolean(
          confirmState.preview?.runningClients?.desktop ?? catalog?.runningClients?.desktop
        );
        const res = await resolveApi().runDelete({
          targets: confirmState.targets,
          redactLedger: prefs.redactLedger,
          clearBrowserCache: prefs.clearBrowserCache && !desktopRunning,
          preserveProtectedBrain: !confirmState.purgeProtectedBrain,
          includeOrphanIndexes: confirmState.includeOrphans,
          orphanIndexTargets: confirmState.includeOrphans
            ? confirmState.preview?.orphanIndexMatches || []
            : [],
        });

        confirmState = null;
        renderConfirmBox();

        const parts = [];
        if ((res?.deletedCount || 0) > 0) {
          parts.push(t('settings.smgr.resultDeleted', { n: res.deletedCount }));
        }
        if ((res?.cascadeSubagentCount || 0) > 0) {
          parts.push(t('settings.smgr.resultCascade', { n: res.cascadeSubagentCount }));
        }
        if ((res?.crossOrphanCleanedCount || 0) > 0) {
          parts.push(t('settings.smgr.resultOrphan', { n: res.crossOrphanCleanedCount }));
        }
        if ((res?.ledgerRedaction?.redactedConversations || 0) > 0) {
          parts.push(
            t('settings.smgr.resultRedacted', { n: res.ledgerRedaction.redactedConversations })
          );
        }
        if ((res?.failedCount || 0) > 0) {
          parts.push(t('settings.smgr.resultFailed', { n: res.failedCount }));
        }

        const detailParts = [];
        if (Array.isArray(res?.failed) && res.failed.length > 0) {
          detailParts.push(res.failed.map((f) => `${f.sessionId.slice(0, 8)}: ${f.error}`).join('; '));
        }
        if (Array.isArray(res?.warnings) && res.warnings.length > 0) {
          detailParts.push(t('settings.smgr.resultWarnings', { msg: res.warnings.join('; ') }));
        }

        resultBanner = {
          ok: Boolean(res?.ok),
          text: parts.join(' · ') || res?.error || 'delete_failed',
          detail: detailParts.join(' | '),
        };
        renderResultBanner();

        for (const d of res?.deleted || []) {
          const dk = `${d.clientId}:${d.sessionId}`;
          selectedKeys.delete(dk);
          if (lastAnchorKey === dk) lastAnchorKey = '';
        }
        await reload();
      } catch (err) {
        confirmState = null;
        resultBanner = { ok: false, text: err?.message || 'delete_failed' };
        renderResultBanner();
        getProps()?.onLayoutChange?.();
      } finally {
        isDeleting = false;
        renderConfirmBox();
        renderList();
      }
    }

    async function handleSweepLedger() {
      if (isSweeping) return;
      isSweeping = true;
      rebuildTopMoreMenu();
      try {
        const res = await resolveApi().runSweep();
        if (res?.ok) {
          const convs = Number(res.redactedConversations || 0);
          const steps = Number(res.redactedSteps || 0);
          resultBanner = {
            ok: true,
            text:
              convs > 0
                ? t('settings.smgr.sweepDone', { convs, steps })
                : t('settings.smgr.sweepNone'),
          };
        } else {
          resultBanner = {
            ok: false,
            text: t('settings.smgr.sweepFailed', { error: res?.error || 'unknown' }),
          };
        }
        renderResultBanner();
      } catch (err) {
        resultBanner = {
          ok: false,
          text: t('settings.smgr.sweepFailed', { error: err?.message || 'unknown' }),
        };
        renderResultBanner();
      } finally {
        isSweeping = false;
        rebuildTopMoreMenu();
      }
    }

    async function reload() {
      const seq = ++reloadSeq;
      activeReloadCount += 1;
      isLoading = true;
      patchAttr(refreshBtn, 'disabled', true);
      if (resultBanner && !resultBanner.ok) {
        resultBanner = null;
        renderResultBanner();
      }
      if (!catalog) renderList();
      try {
        const res = await resolveApi().loadList();
        if (seq !== reloadSeq) return;
        loadedOnce = true;
        if (res?.error === 'unsupported_remote') {
          remoteUnsupported = true;
          catalog = { clients: [], runningClients: null, sessions: [], counts: { total: 0, byClient: {} }, warnings: [] };
        } else {
          remoteUnsupported = false;
          catalog = res || { clients: [], runningClients: null, sessions: [], counts: { total: 0, byClient: {} }, warnings: [] };
        }
        getProps()?.onCatalogLoaded?.(res);

        const validKeys = new Set(getAllSessions().map(sessionItemKey));
        for (const k of Array.from(selectedKeys)) {
          if (!validKeys.has(k)) selectedKeys.delete(k);
        }
        if (lastAnchorKey && !validKeys.has(lastAnchorKey)) {
          lastAnchorKey = '';
        }
        syncSourceSegments();
        syncGuardNotice();
        rebuildTopMoreMenu();
        renderList();
        getProps()?.onLayoutChange?.();
      } catch (err) {
        if (seq !== reloadSeq) return;
        resultBanner = { ok: false, text: err?.message || 'scan_failed' };
        renderResultBanner();
      } finally {
        activeReloadCount = Math.max(0, activeReloadCount - 1);
        if (activeReloadCount === 0) {
          isLoading = false;
          patchAttr(refreshBtn, 'disabled', false);
          if (!catalog) {
            renderList();
          }
        }
      }
    }

    async function ensureLoaded() {
      if (loadedOnce) return;
      await reload();
    }

    function markStale() {
      reloadSeq += 1;
      loadedOnce = false;
      lastAnchorKey = '';
      dismissConfirmDrawer();
    }

    function refreshLabels() {
      patchText(titleTextEl, t('settings.smgr.title'));
      patchText(refreshBtnTextEl, t('settings.smgr.refresh'));
      moreMenu.refs.setAriaLabel(t('settings.smgr.moreAria'));
      rebuildTopMoreMenu();
      searchControl.syncLabels({
        placeholder: t('settings.smgr.searchPlaceholder'),
        ariaLabel: t('settings.smgr.searchAria'),
        clearAriaLabel: t('settings.smgr.clearSearchAria'),
      });
      sortSelect.setProps({
        ariaLabel: t('settings.smgr.sortAria'),
        modelValue: prefs.sortBy,
        options: getSortOptions(),
      });
      patchText(clearSelBtn, t('settings.smgr.clearSelShort'));
      patchText(hideIdxBtnTextEl, t('settings.smgr.hideIndexOnly'));
      patchAttr(hideIdxBtn, 'title', t('settings.smgr.hideIndexOnlyTitle'));
      patchText(prefRedactLabelEl, t('settings.smgr.prefRedactLedger'));
      patchText(prefRedactDescEl, t('settings.smgr.prefRedactLedgerDesc'));
      patchText(prefCacheLabelEl, t('settings.smgr.prefClearCache'));
      patchText(prefCacheDescEl, t('settings.smgr.prefClearCacheDesc'));
      syncSourceSegments();
      syncGuardNotice();
      renderConfirmBox();
      renderList();
    }

    rebuildTopMoreMenu();
    syncSourceSegments();

    onCleanup(() => {
      moreMenu.destroy();
      sourceSeg.destroy();
      sortSelect.destroy();
      prefRedactToggle.destroy();
      prefCacheToggle.destroy();
      listScrollbar.destroy();
    });

    return {
      el: rootEl,
      refs: {
        refreshBtn,
        totalSizeBadge,
        selectedSizeEl,
        searchInput: searchControl.inputEl,
        sortSelect,
        hideIdxBtn,
        toggleAllBtn,
        clearSelBtn,
        batchDeleteBtn,
        confirmBoxEl,
        resultBoxEl,
        listEl,
        isLoaded: () => loadedOnce,
        ensureLoaded,
        reload,
        markStale,
        refreshLabels,
      },
    };
  },
});
