/**
 * @fileoverview Standalone decoupled Live Running Tasks Widget (`LiveActivityWidget.js`).
 * Displays active multi-session running conversations & collapsible subagent activity
 * with an isolated 1s elapsed timer lifecycle. Supports both Overview/Hover widget mode
 * and controlled Multi-Session Floating Panel mode (`WindowOverlayShell.js`).
 */

import { defineComponent } from '../../core/component.js';
import { isModernUiActiveForElement } from '../../core/appearance.js';
import {
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchText,
} from '../../core/domPatch.js';
import {
  formatAgentBadgeText,
  formatElapsedSec,
  formatLiveActivityDetail,
  formatLiveActivityLabel,
  formatLiveTaskStepsProgress,
  getAgentBadgeClass,
  getTaskStepsSignature,
} from '../../core/formatters.js';
import { createSvgIcon } from '../../icons/SvgIcon.js';
import { getEffectiveLocale, t } from '../../i18n/index.js';
import {
  extractHostRouteCascadeId,
  resolveScopedConversation,
  selectConversation,
  telemetryStore,
} from '../../store/telemetryStore.js';
import { uiStore } from '../../store/uiStore.js';
import { CustomScrollbar } from '../ui/CustomScrollbar.js';

export function buildFallbackRunningConversations(
  data,
  { agents = [], aggregated = null, latestTokPerSec = undefined, contextUsedPct = undefined } = {}
) {
  if (!data) return [];
  if (Array.isArray(data.runningConversations) && data.runningConversations.length > 0) {
    return data.runningConversations;
  }
  const activeConv = data.activeConversation || {};
  if (!activeConv.isRunning && !aggregated?.isRunning) return [];
  const childAgents = (agents || []).filter((a) => !a.isMain);
  const swarmChildren = childAgents.filter((a) => a.agentKind === 'swarm_worker');
  return [
    {
      cascadeId: activeConv.cascadeId || 'current',
      title: activeConv.title || t('live.currentSession'),
      ...(activeConv.swarmTitle ? { swarmTitle: activeConv.swarmTitle } : {}),
      isCurrentSelected: true,
      isMainRunning: Boolean(activeConv.isRunning),
      isRunning: true,
      stepCount: Number(activeConv.stepCount || 0),
      totalStepCount: Number(activeConv.totalStepCount || activeConv.stepCount || 0),
      mainActivity: activeConv.liveActivity || aggregated?.liveActivity || null,
      subagentCount: childAgents.length,
      swarmCount: swarmChildren.length,
      runningSubagentCount: childAgents.filter((a) => a.isRunning).length,
      runningSwarmCount: swarmChildren.filter((a) => a.isRunning).length,
      ...(latestTokPerSec !== undefined ? { latestTokPerSec } : {}),
      ...(contextUsedPct !== undefined ? { contextUsedPct } : {}),
      subagents: childAgents.map((s, idx) => {
        const isSwarmW = s.agentKind === 'swarm_worker';
        const isKilled = Boolean(s.swarmState === 'killed');
        return {
          cascadeId: s.cascadeId || s.agentId,
          index: s.index || idx + 1,
          agentKind: s.agentKind || (s.isSideQuestion ? 'side_question' : 'subagent'),
          agentOrdinal:
            s.agentOrdinal || (s.isSideQuestion ? s.sideIndex || 0 : s.index || idx + 1),
          customRole: s.customRole,
          ...(s.swarmState ? { swarmState: s.swarmState } : {}),
          ...(s.isSideQuestion ? { isSideQuestion: true, sideIndex: s.sideIndex || 0 } : {}),
          badgeText: formatAgentBadgeText({ ...s, index: s.index || idx + 1 }),
          shortLabel:
            s.shortLabel ||
            `${isSwarmW ? t('fmt.swarmAgent') : t('fmt.subAgent')} #${s.agentOrdinal || idx + 1}`,
          role:
            s.role ||
            `${isSwarmW ? t('fmt.swarmAgent') : t('fmt.subAgent')} #${s.agentOrdinal || idx + 1}`,
          isRunning: Boolean(s.isRunning),
          stepCount: Number(s.stepCount || 0),
          lastModifiedMs: s.lastModifiedMs || 0,
          liveActivity: s.liveActivity || {
            phase: s.isRunning ? 'thinking' : isSwarmW && !isKilled ? 'waiting' : 'done',
            actionKey: s.isRunning
              ? 'thinking'
              : isSwarmW
                ? isKilled
                  ? 'swarm_killed'
                  : 'swarm_waiting'
                : 'done',
            label: s.isRunning
              ? t('live.thinking')
              : isSwarmW
                ? isKilled
                  ? t('live.killed')
                  : t('live.waiting')
                : t('live.done'),
            detail: '',
            stepProgress: '',
            startedAtMs: s.lastModifiedMs || 0,
            signature: `${s.agentId}:${s.swarmState || ''}:${s.stepCount || 0}`,
          },
        };
      }),
    },
  ];
}

export const LiveActivityWidget = defineComponent({
  name: 'LiveActivityWidget',
  setup({ props, onCleanup }) {
    const interactive = props.interactive !== false;
    const preview = Boolean(props.preview);
    const defaultExpandRunningSubs = Boolean(props.defaultExpandRunningSubs);
    const showSessionExtras = Boolean(props.showSessionExtras);
    const onSelectSession =
      typeof props.onSelectSession === 'function' ? props.onSelectSession : null;
    const onLayoutChange =
      typeof props.onLayoutChange === 'function' ? props.onLayoutChange : null;
    const getCtxAgentId =
      typeof props.getCtxAgentId === 'function'
        ? props.getCtxAgentId
        : () => uiStore.getState().ctxInspectorAgentId;
    const isVisibleFn =
      typeof props.isVisibleFn === 'function' ? props.isVisibleFn : () => true;

    const liveActivityBar = h('div', {
      className: 'live-activity-list',
      hidden: true,
      'aria-live': 'polite',
    });

    const manualSubExpandMap = new Map();
    const manualStepsExpandMap = new Map();
    const activityTimersMap = new Map();
    let liveTickTimer = null;
    let latestUpdateArgs = null;

    function resolveIsExpanded(item) {
      const runSubCount = Number(item?.runningSubagentCount || 0);
      if (!interactive) return runSubCount > 0;
      if (manualSubExpandMap.has(item.cascadeId)) {
        return Boolean(manualSubExpandMap.get(item.cascadeId));
      }
      return defaultExpandRunningSubs ? runSubCount > 0 : false;
    }

    function bindLiveElapsedTimer(timerKey, sig, rawStartMs, targetEl) {
      const now = Date.now();
      const prev = activityTimersMap.get(timerKey);
      let startMs = prev?.startMs || 0;
      if (!prev || prev.sig !== sig) {
        const validRaw = Number(rawStartMs || 0);
        startMs = validRaw > 0 && validRaw <= now + 2000 ? validRaw : now;
      } else if (startMs <= 0 && Number(rawStartMs) > 0 && Number(rawStartMs) <= now + 2000) {
        startMs = Number(rawStartMs);
      }
      activityTimersMap.set(timerKey, { sig, startMs, el: targetEl });
      const elapsedSec = Math.max(0, (now - startMs) / 1000);
      patchText(targetEl, formatElapsedSec(elapsedSec));
    }

    function updateLiveElapsedDisplay() {
      const now = Date.now();
      for (const entry of activityTimersMap.values()) {
        if (!entry?.el) continue;
        const elapsedSec = entry.startMs > 0 ? Math.max(0, (now - entry.startMs) / 1000) : 0;
        patchText(entry.el, formatElapsedSec(elapsedSec));
      }
    }

    function pauseTicker() {
      if (liveTickTimer) {
        clearInterval(liveTickTimer);
        liveTickTimer = null;
      }
    }

    function stopLiveTicker() {
      pauseTicker();
      activityTimersMap.clear();
    }

    function ensureLiveTicker() {
      if (!isVisibleFn() || activityTimersMap.size === 0) {
        pauseTicker();
        return;
      }
      if (!liveTickTimer) {
        liveTickTimer = setInterval(updateLiveElapsedDisplay, 1000);
      }
    }

    function resumeTicker() {
      if (activityTimersMap.size > 0) {
        updateLiveElapsedDisplay();
        ensureLiveTicker();
      }
    }

    function readComputedPx(el, prop, fallback) {
      if (!el || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
        return fallback;
      }
      try {
        const val = parseFloat(window.getComputedStyle(el)?.[prop]);
        return Number.isFinite(val) ? val : fallback;
      } catch {
        return fallback;
      }
    }

    function clearSubExpandAnim(refs) {
      if (!refs) return;
      if (refs.subAnimTimer) {
        clearTimeout(refs.subAnimTimer);
        refs.subAnimTimer = null;
      }
      refs.isCollapsingSubs = false;
      const host = refs.subScroll?.el;
      if (host) {
        host.ontransitionend = null;
        patchClasses(host, { 'is-sub-animating': false });
        host.style.height = '';
        host.style.paddingTop = '';
        host.style.marginTop = '';
        host.style.opacity = '';
        host.style.overflow = '';
        host.style.transition = '';
      }
    }

    function createLiveTaskCard() {
      const dotIcon = createSvgIcon('dot', { size: 11 });
      patchClasses(dotIcon, { 'is-pulsing': true });
      const dotWrap = h('span', { className: 'live-activity-dot' }, [dotIcon]);
      const titleEl = h('strong', {
        className: 'live-task-title',
        text: t('live.currentSession'),
      });
      const hereTagEl = showSessionExtras
        ? h('span', {
            className: 'wm-session-tag is-here',
            hidden: true,
            text: t('multi.hereTag'),
          })
        : null;
      const metricsEl = showSessionExtras
        ? h('span', {
            className: 'wm-task-metrics text-mono',
            hidden: true,
            text: '',
          })
        : null;
      const subToggleLabel = h('span', {
        className: 'live-sub-toggle-label',
        text: t('live.subToggleIdle', { total: 0 }),
      });
      const subToggleChevron = createSvgIcon('chevron-down', {
        size: 11,
        className: 'live-sub-toggle-chevron',
      });
      const subToggleBtn = h(
        'button',
        {
          type: 'button',
          className: 'live-sub-toggle',
          hidden: true,
        },
        [subToggleLabel, subToggleChevron]
      );
      const elapsedEl = h('span', {
        className: 'live-activity-elapsed text-mono',
        text: '0s',
      });

      const headerEl = h('div', { className: 'live-task-header' }, [
        h('div', { className: 'live-task-title-wrap' }, [
          dotWrap,
          titleEl,
          ...(hereTagEl ? [hereTagEl] : []),
        ]),
        h(
          'div',
          { className: 'live-task-header-right' },
          showSessionExtras ? [elapsedEl] : [subToggleBtn, elapsedEl]
        ),
      ]);

      const metaRowEl = showSessionExtras
        ? h('div', { className: 'live-task-meta-row', hidden: true }, [
            metricsEl,
            subToggleBtn,
          ])
        : null;

      const mainBadge = h('span', {
        className: 'agent-badge badge-main',
        hidden: true,
        text: t('fmt.mainBadge'),
      });
      const mainPhase = h('strong', {
        className: 'live-activity-phase',
        text: t('live.thinking'),
      });
      const mainProgress = h('span', {
        className: 'live-activity-progress text-mono',
        hidden: true,
        text: '',
      });
      const mainSep = h('span', { className: 'live-activity-sep', hidden: true, text: '·' });
      const mainDetail = h('span', {
        className: 'live-activity-detail',
        hidden: true,
        text: '',
      });

      const mainRowEl = h('div', { className: 'live-task-main-row' }, [
        mainBadge,
        mainPhase,
        mainProgress,
        mainSep,
        mainDetail,
      ]);

      const stepsCountBadge = h('span', {
        className: 'live-steps-count text-mono',
        text: '',
      });
      const stepsCurrentEl = h('span', {
        className: 'live-steps-current',
        hidden: true,
        text: '',
      });
      const stepsChevron = createSvgIcon('chevron-down', {
        size: 10,
        className: 'live-steps-chevron',
      });
      const stepsSummaryBtn = h(
        'button',
        {
          type: 'button',
          className: 'live-steps-summary',
        },
        [stepsCountBadge, stepsCurrentEl, stepsChevron]
      );
      const stepsListEl = h('div', { className: 'live-steps-list', hidden: true });
      const stepsBoxEl = h('div', { className: 'live-steps-box', hidden: true }, [
        stepsSummaryBtn,
        stepsListEl,
      ]);

      const subListEl = h('div', { className: 'live-sub-list', hidden: true });
      const subScroll = CustomScrollbar({
        contentEl: subListEl,
        className: 'live-sub-scroll-host',
      });
      patchAttr(subScroll.el, 'hidden', true);
      const cardEl = h('div', { className: 'live-task-card' }, [
        headerEl,
        mainRowEl,
        stepsBoxEl,
        ...(metaRowEl ? [metaRowEl] : []),
        subScroll.el,
      ]);

      return {
        el: cardEl,
        refs: {
          cardEl,
          dotIcon,
          titleEl,
          hereTagEl,
          metricsEl,
          metaRowEl,
          subToggleBtn,
          subToggleLabel,
          subToggleChevron,
          elapsedEl,
          mainBadge,
          mainPhase,
          mainProgress,
          mainSep,
          mainDetail,
          stepsBoxEl,
          stepsSummaryBtn,
          stepsCountBadge,
          stepsCurrentEl,
          stepsChevron,
          stepsListEl,
          subListEl,
          subScroll,
          subAnimTimer: null,
          isCollapsingSubs: false,
        },
      };
    }

    function createLiveStepItemRow() {
      const dotEl = h('span', { className: 'live-step-dot', 'aria-hidden': 'true' });
      const titleEl = h('span', { className: 'live-step-title', text: '' });
      const rowEl = h('div', { className: 'live-step-item' }, [dotEl, titleEl]);
      return {
        el: rowEl,
        refs: { rowEl, dotEl, titleEl },
      };
    }

    function createLiveSubRow() {
      const subBadge = h('span', {
        className: 'agent-badge badge-sub-1',
        text: t('fmt.subBadge', { index: 1 }),
      });
      const subRole = h('span', { className: 'live-sub-role', text: t('fmt.subAgent') });
      const subSummary = h('span', { className: 'live-sub-summary', text: '' });
      const subElapsed = h('span', { className: 'live-sub-elapsed text-mono', text: '0s' });

      const rowEl = h('div', { className: 'live-sub-row' }, [
        h('div', { className: 'live-sub-left' }, [subBadge, subRole, subSummary]),
        subElapsed,
      ]);

      return {
        el: rowEl,
        refs: {
          rowEl,
          subBadge,
          subRole,
          subSummary,
          subElapsed,
        },
      };
    }

    function update({ data = null, items = null, hostRouteConversationId = '' } = {}) {
      latestUpdateArgs = { data, items, hostRouteConversationId };
      if (!data && !Array.isArray(items)) {
        patchAttr(liveActivityBar, 'hidden', true);
        stopLiveTicker();
        return;
      }

      let rawRunningList = Array.isArray(items) ? items : null;
      if (!rawRunningList) {
        const { agents, aggregated } = resolveScopedConversation(
          data,
          'all',
          getCtxAgentId()
        );
        rawRunningList = buildFallbackRunningConversations(data, { agents, aggregated });
      }

      if (manualSubExpandMap.size > 0 || manualStepsExpandMap.size > 0) {
        const runningIdsSet = new Set(rawRunningList.map((item) => item.cascadeId));
        for (const id of [...manualSubExpandMap.keys()]) {
          if (!runningIdsSet.has(id)) {
            manualSubExpandMap.delete(id);
          }
        }
        for (const id of [...manualStepsExpandMap.keys()]) {
          if (!runningIdsSet.has(id)) {
            manualStepsExpandMap.delete(id);
          }
        }
      }

      const hasRunningTasks = rawRunningList.length > 0;
      patchAttr(liveActivityBar, 'hidden', !hasRunningTasks);
      if (!hasRunningTasks) {
        stopLiveTicker();
        patchKeyedList(liveActivityBar, [], {
          destroyRow: (refs) => {
            clearSubExpandAnim(refs);
            refs?.subScroll?.destroy?.();
          },
        });
        return;
      }

      if (!isVisibleFn()) {
        pauseTicker();
        return;
      }

      const locale = getEffectiveLocale();
      const hostRouteLower = showSessionExtras
        ? String(hostRouteConversationId || extractHostRouteCascadeId() || '').toLowerCase()
        : '';

      const activeTimerKeys = new Set();
      for (const item of rawRunningList) {
        activeTimerKeys.add(`main:${item.cascadeId}`);
        const subCount = Number(item.subagentCount || item.subagents?.length || 0);
        const isExp = resolveIsExpanded(item);
        if (subCount > 0 && isExp) {
          for (const sub of item.subagents || []) {
            if (sub?.isRunning) {
              activeTimerKeys.add(`sub:${sub.cascadeId}`);
            }
          }
        }
      }

      patchKeyedList(liveActivityBar, rawRunningList, {
        keyFn: (item) => item.cascadeId,
        sigFn: (item) => {
          const isExp = resolveIsExpanded(item);
          const isHere =
            showSessionExtras &&
            Boolean(hostRouteLower) &&
            (String(item.cascadeId || '').toLowerCase() === hostRouteLower ||
              (item.subagents || []).some(
                (s) => String(s?.cascadeId || '').toLowerCase() === hostRouteLower
              ));
          const stepsSig = getTaskStepsSignature(item.mainActivity?.taskSteps);
          const isStepsExp = Boolean(manualStepsExpandMap.get(item.cascadeId));
          const subSig = (item.subagents || [])
            .map(
              (s) =>
                `${s.cascadeId}:${s.isRunning}:${s.swarmState || ''}:${s.stepCount}:${s.liveActivity?.signature || ''}:${s.liveActivity?.startedAtMs || 0}`
            )
            .join('|');
          return `${locale}:${item.cascadeId}:${item.title}:${isHere}:${item.isMainRunning}:${item.subagentCount}:${item.swarmCount || 0}:${item.runningSubagentCount}:${isExp}:${isStepsExp}:${stepsSig}:${item.latestTokPerSec ?? ''}:${item.contextUsedPct ?? ''}:${item.mainActivity?.signature || ''}:${item.mainActivity?.startedAtMs || 0}:${subSig}`;
        },
        createRow: createLiveTaskCard,
        updateRow: (refs, item) => {
          const act = item.mainActivity || {
            phase: 'thinking',
            actionKey: 'thinking',
            label: t('live.thinking'),
            detail: '',
            stepProgress: '',
            startedAtMs: item.lastModifiedMs || 0,
            signature: `fallback:${item.lastModifiedMs || 0}`,
          };

          const isWaiting = act.phase === 'waiting';
          const isCompacting = act.phase === 'compacting';
          patchClasses(refs.cardEl, {
            'is-waiting': isWaiting,
            'is-compacting': isCompacting,
          });
          patchClasses(refs.dotIcon, { 'is-pulsing': true });

          const convTitle = item.title || item.cascadeId?.slice(0, 8) || t('live.currentSession');
          patchText(refs.titleEl, convTitle);
          if (interactive && !preview) {
            patchAttr(
              refs.titleEl,
              'title',
              onSelectSession
                ? t('multi.inspectSessionTitle', { title: convTitle })
                : t('live.switchSessionTitle', { title: convTitle })
            );
            refs.titleEl.onclick = (e) => {
              e?.stopPropagation?.();
              if (onSelectSession) {
                onSelectSession(item.cascadeId);
              } else if (item.cascadeId && item.cascadeId !== 'current') {
                uiStore.setState({ selectedAgentScope: 'all', ctxInspectorAgentId: 'auto' });
                void selectConversation(item.cascadeId);
              }
            };
          }

          let hasExtrasMetrics = false;
          if (showSessionExtras && refs.hereTagEl && refs.metricsEl) {
            const isHere =
              Boolean(hostRouteLower) &&
              (String(item.cascadeId || '').toLowerCase() === hostRouteLower ||
                (item.subagents || []).some(
                  (s) => String(s?.cascadeId || '').toLowerCase() === hostRouteLower
                ));
            patchText(refs.hereTagEl, t('multi.hereTag'));
            patchAttr(refs.hereTagEl, 'hidden', !isHere);

            const metricParts = [];
            if (Number.isFinite(item.latestTokPerSec) && item.latestTokPerSec > 0) {
              metricParts.push(
                `${item.latestTokPerSec >= 100 ? Math.round(item.latestTokPerSec) : item.latestTokPerSec.toFixed(1)} t/s`
              );
            }
            if (item.contextUsedPct != null && Number.isFinite(Number(item.contextUsedPct))) {
              metricParts.push(`${Math.round(Number(item.contextUsedPct))}%`);
            }
            const metricsStr = metricParts.join(' · ');
            hasExtrasMetrics = Boolean(metricsStr);
            patchAttr(refs.metricsEl, 'hidden', !metricsStr);
            if (metricsStr) {
              patchText(refs.metricsEl, metricsStr);
            }
          }

          const subCount = Number(item.subagentCount || item.subagents?.length || 0);
          if (refs.metaRowEl) {
            patchAttr(refs.metaRowEl, 'hidden', !hasExtrasMetrics && subCount === 0);
          }
          const swarmCount = Number(
            item.swarmCount ??
              (item.subagents || []).filter((s) => s?.agentKind === 'swarm_worker').length
          );
          const isPureSwarm = subCount > 0 && swarmCount === subCount;
          const runSubCount = Number(item.runningSubagentCount || 0);
          const isExpanded = resolveIsExpanded(item);
          patchText(refs.mainBadge, t('fmt.mainBadge'));
          patchAttr(refs.mainBadge, 'hidden', subCount === 0);
          patchAttr(refs.subToggleBtn, 'hidden', subCount === 0);
          if (subCount > 0) {
            const toggleText =
              runSubCount > 0
                ? t(isPureSwarm ? 'live.swarmToggleRunning' : 'live.subToggleRunning', {
                    run: runSubCount,
                    total: subCount,
                  })
                : t(isPureSwarm ? 'live.swarmToggleIdle' : 'live.subToggleIdle', {
                    total: subCount,
                  });
            patchText(refs.subToggleLabel, toggleText);
            patchClasses(refs.subToggleBtn, { 'is-expanded': isExpanded });
            if (interactive) {
              patchAttr(
                refs.subToggleBtn,
                'title',
                isExpanded ? t('live.subCollapseTitle') : t('live.subExpandTitle')
              );
              refs.subToggleBtn.onclick = (e) => {
                e.stopPropagation();
                const nextExpanded = !resolveIsExpanded(item);
                const host = refs.subScroll.el;
                const curH = Number(host.offsetHeight || 0);
                const curPadTop = readComputedPx(host, 'paddingTop', 6);
                const curMarginTop = readComputedPx(host, 'marginTop', 3);
                const curOpacity = readComputedPx(host, 'opacity', 1);
                const parentGap = readComputedPx(refs.cardEl, 'rowGap', 7);
                const collapsedMarginTop = -Math.max(0, Math.round(parentGap));
                const wasMidAnim = Boolean(refs.subAnimTimer);
                clearSubExpandAnim(refs);
                manualSubExpandMap.set(item.cascadeId, nextExpanded);

                const modern = isModernUiActiveForElement(refs.cardEl);
                if (!modern) {
                  if (latestUpdateArgs) update(latestUpdateArgs);
                  onLayoutChange?.();
                  return;
                }

                if (nextExpanded) {
                  if (latestUpdateArgs) update(latestUpdateArgs);
                  const endH = Number(host.offsetHeight || host.scrollHeight || 0);
                  const endPadTop = readComputedPx(host, 'paddingTop', 6);
                  const endMarginTop = readComputedPx(host, 'marginTop', 3);
                  const fromH = wasMidAnim && curH > 0 ? curH : 0;
                  const fromPadTop = wasMidAnim && curH > 0 ? curPadTop : 0;
                  const fromMarginTop = wasMidAnim && curH > 0 ? curMarginTop : collapsedMarginTop;
                  const fromOpacity = wasMidAnim && curH > 0 ? curOpacity : 0;
                  if (endH > 0) {
                    patchClasses(host, { 'is-sub-animating': true });
                    host.style.height = `${fromH}px`;
                    host.style.paddingTop = `${fromPadTop}px`;
                    host.style.marginTop = `${fromMarginTop}px`;
                    host.style.opacity = `${fromOpacity}`;
                    host.style.overflow = 'hidden';
                    void host.offsetHeight;
                    host.style.transition =
                      'height 220ms cubic-bezier(0.16, 1, 0.3, 1), padding-top 220ms cubic-bezier(0.16, 1, 0.3, 1), margin-top 220ms cubic-bezier(0.16, 1, 0.3, 1), opacity 180ms ease-out';
                    host.style.height = `${endH}px`;
                    host.style.paddingTop = `${endPadTop}px`;
                    host.style.marginTop = `${endMarginTop}px`;
                    host.style.opacity = '1';
                    const finishExpand = () => {
                      clearSubExpandAnim(refs);
                      refs.subScroll.refresh();
                      onLayoutChange?.();
                    };
                    host.ontransitionend = (ev) => {
                      if (
                        ev?.target === host &&
                        (!ev.propertyName || ev.propertyName === 'height')
                      ) {
                        finishExpand();
                      }
                    };
                    refs.subAnimTimer = setTimeout(finishExpand, 260);
                  } else {
                    onLayoutChange?.();
                  }
                } else {
                  patchClasses(refs.subToggleBtn, { 'is-expanded': false });
                  patchAttr(refs.subToggleBtn, 'title', t('live.subExpandTitle'));
                  if (curH > 0) {
                    refs.isCollapsingSubs = true;
                    patchClasses(host, { 'is-sub-animating': true });
                    host.style.height = `${curH}px`;
                    host.style.paddingTop = `${curPadTop}px`;
                    host.style.marginTop = `${curMarginTop}px`;
                    host.style.opacity = `${curOpacity}`;
                    host.style.overflow = 'hidden';
                    void host.offsetHeight;
                    host.style.transition =
                      'height 200ms cubic-bezier(0.16, 1, 0.3, 1), padding-top 200ms cubic-bezier(0.16, 1, 0.3, 1), margin-top 200ms cubic-bezier(0.16, 1, 0.3, 1), opacity 150ms ease-out';
                    host.style.height = '0px';
                    host.style.paddingTop = '0px';
                    host.style.marginTop = `${collapsedMarginTop}px`;
                    host.style.opacity = '0';
                    const finishCollapse = () => {
                      clearSubExpandAnim(refs);
                      patchAttr(host, 'hidden', true);
                      patchAttr(refs.subListEl, 'hidden', true);
                      if (latestUpdateArgs) update(latestUpdateArgs);
                      onLayoutChange?.();
                    };
                    host.ontransitionend = (ev) => {
                      if (
                        ev?.target === host &&
                        (!ev.propertyName || ev.propertyName === 'height')
                      ) {
                        finishCollapse();
                      }
                    };
                    refs.subAnimTimer = setTimeout(finishCollapse, 240);
                  } else {
                    if (latestUpdateArgs) update(latestUpdateArgs);
                    onLayoutChange?.();
                  }
                }
              };
            }
          } else if (refs.isCollapsingSubs) {
            clearSubExpandAnim(refs);
          }

          const mainLabel = formatLiveActivityLabel(act, 'live.thinking');
          const detailStr = formatLiveActivityDetail(act);
          const mainTimerKey = `main:${item.cascadeId}`;
          activeTimerKeys.add(mainTimerKey);
          bindLiveElapsedTimer(
            mainTimerKey,
            `${item.cascadeId}:${act.signature || mainLabel}`,
            act.startedAtMs,
            refs.elapsedEl
          );

          patchText(refs.mainPhase, mainLabel);
          const progText = act.stepProgress
            ? String(act.stepProgress).replace(/^\[|\]$/g, '').trim()
            : '';
          patchAttr(refs.mainProgress, 'hidden', !progText);
          if (progText) {
            patchText(refs.mainProgress, progText);
          }

          patchAttr(refs.mainSep, 'hidden', !detailStr);
          patchAttr(refs.mainDetail, 'hidden', !detailStr);
          patchText(refs.mainDetail, detailStr);

          const taskSteps =
            act.taskSteps && Number(act.taskSteps.total) > 0 ? act.taskSteps : null;
          patchAttr(refs.stepsBoxEl, 'hidden', !taskSteps);
          if (taskSteps) {
            const stepsDone = Math.max(0, Number(taskSteps.done || 0));
            const stepsTotal = Math.max(1, Number(taskSteps.total || 0));
            const allDone = stepsDone >= stepsTotal && Number(taskSteps.failed || 0) === 0;
            const hasFailed = Number(taskSteps.failed || 0) > 0;
            const stepItems = Array.isArray(taskSteps.items) ? taskSteps.items : [];
            const canExpandSteps = interactive && stepItems.length > 0;
            const stepsExpanded = canExpandSteps && Boolean(manualStepsExpandMap.get(item.cascadeId));

            patchText(refs.stepsCountBadge, formatLiveTaskStepsProgress(taskSteps));
            patchClasses(refs.stepsCountBadge, {
              'is-done': allDone,
              'is-failed': hasFailed,
            });
            const currentStepText =
              String(taskSteps.currentTitle || '').trim() || (allDone ? t('live.stepsAllDone') : '');
            patchAttr(refs.stepsCurrentEl, 'hidden', !currentStepText);
            if (currentStepText) {
              patchText(refs.stepsCurrentEl, currentStepText);
            }
            patchAttr(refs.stepsChevron, 'hidden', !canExpandSteps);
            patchClasses(refs.stepsSummaryBtn, {
              'is-expanded': stepsExpanded,
              'is-static': !canExpandSteps,
            });
            patchAttr(
              refs.stepsSummaryBtn,
              'aria-expanded',
              canExpandSteps ? (stepsExpanded ? 'true' : 'false') : null
            );
            patchAttr(
              refs.stepsSummaryBtn,
              'title',
              canExpandSteps
                ? stepsExpanded
                  ? t('live.stepsCollapseTitle')
                  : t('live.stepsExpandTitle')
                : null
            );
            refs.stepsSummaryBtn.onclick = canExpandSteps
              ? (e) => {
                  e?.stopPropagation?.();
                  manualStepsExpandMap.set(
                    item.cascadeId,
                    !Boolean(manualStepsExpandMap.get(item.cascadeId))
                  );
                  if (latestUpdateArgs) update(latestUpdateArgs);
                  onLayoutChange?.();
                }
              : null;

            const showStepsList = canExpandSteps && stepsExpanded;
            patchAttr(refs.stepsListEl, 'hidden', !showStepsList);
            if (showStepsList) {
              patchKeyedList(refs.stepsListEl, stepItems, {
                keyFn: (st, idx) => `${idx}:${st.title}`,
                sigFn: (st) => `${st.status}:${st.title}`,
                createRow: createLiveStepItemRow,
                updateRow: (stepRefs, st) => {
                  const status = String(st?.status || 'pending');
                  patchClasses(stepRefs.rowEl, {
                    'is-done': status === 'done',
                    'is-in-progress': status === 'in_progress',
                    'is-failed': status === 'failed',
                    'is-skipped': status === 'skipped',
                    'is-pending':
                      status !== 'done' &&
                      status !== 'in_progress' &&
                      status !== 'failed' &&
                      status !== 'skipped',
                  });
                  patchText(stepRefs.titleEl, st?.title || '');
                },
              });
            }
          } else {
            refs.stepsSummaryBtn.onclick = null;
          }

          if (interactive && !showSessionExtras) {
            const stepsSummarySuffix = taskSteps
              ? ` · ${formatLiveTaskStepsProgress(taskSteps)}${taskSteps.currentTitle ? ` ${taskSteps.currentTitle}` : ''}`
              : '';
            const fullTooltip = `[${convTitle}] ${t('fmt.mainAgent')} · ${mainLabel}${progText ? ` ${progText}` : ''}${detailStr ? ` · ${detailStr}` : ''}${stepsSummarySuffix}`;
            patchAttr(refs.cardEl, 'title', fullTooltip);
          }

          const showSubs = subCount > 0 && isExpanded;
          if (!refs.isCollapsingSubs) {
            patchAttr(refs.subScroll.el, 'hidden', !showSubs);
            patchAttr(refs.subListEl, 'hidden', !showSubs);
          }
          if (showSubs) {
            const rawSubItems = item.subagents || [];
            const getSubSortRank = (s) => {
              if (s?.isRunning) return 0;
              if (s?.swarmState === 'waiting' || s?.liveActivity?.actionKey === 'swarm_waiting') {
                return 1;
              }
              return 2;
            };
            const subItems =
              rawSubItems.length > 1
                ? rawSubItems
                    .slice()
                    .sort(
                      (a, b) =>
                        getSubSortRank(a) - getSubSortRank(b) ||
                        Number(a?.index || 0) - Number(b?.index || 0)
                    )
                : rawSubItems;
            patchKeyedList(refs.subListEl, subItems, {
              keyFn: (sub) => sub.cascadeId,
              sigFn: (sub) =>
                `${locale}:${sub.cascadeId}:${sub.agentKind || ''}:${sub.swarmState || ''}:${sub.role}:${sub.isRunning}:${sub.stepCount}:${sub.liveActivity?.signature || ''}:${sub.isRunning ? activityTimersMap.has(`sub:${sub.cascadeId}`) : true}`,
              createRow: createLiveSubRow,
              updateRow: (subRefs, sub) => {
                const subAct = sub.liveActivity || {
                  phase: sub.isRunning ? 'thinking' : 'done',
                  actionKey: sub.isRunning ? 'thinking' : 'done',
                  label: sub.isRunning ? t('live.thinking') : t('live.done'),
                  detail: '',
                  stepProgress: '',
                  startedAtMs: sub.lastModifiedMs || 0,
                };
                const isWaitingSub =
                  !sub.isRunning &&
                  (sub.swarmState === 'waiting' || subAct.actionKey === 'swarm_waiting');
                const isKilledSub =
                  !sub.isRunning &&
                  (sub.swarmState === 'killed' || subAct.actionKey === 'swarm_killed');
                patchClasses(subRefs.rowEl, {
                  'is-done': !sub.isRunning && !isWaitingSub,
                  'is-waiting-sub': isWaitingSub,
                  'is-killed-sub': isKilledSub,
                });

                const badgeCls = getAgentBadgeClass(sub.index || 1, false);
                const subBadgeText = formatAgentBadgeText({
                  ...sub,
                  isMain: false,
                  index: sub.index || 1,
                });
                patchAttr(subRefs.subBadge, 'class', `agent-badge ${badgeCls}`);
                patchText(subRefs.subBadge, subBadgeText);

                const fallbackRole =
                  sub.agentKind === 'side_question' || sub.isSideQuestion
                    ? `${t('fmt.sideQuestion')}${sub.agentOrdinal || sub.sideIndex ? ` #${sub.agentOrdinal || sub.sideIndex}` : ''}`
                    : sub.agentKind === 'swarm_worker'
                      ? `${t('fmt.swarmAgent')}${sub.agentOrdinal || sub.index ? ` #${sub.agentOrdinal || sub.index}` : ''}`
                      : `${t('fmt.subAgent')}${sub.agentOrdinal || sub.index ? ` #${sub.agentOrdinal || sub.index}` : ''}`;
                const rawFallbackRole = String(sub.role || sub.shortLabel || '').trim();
                const isGenericBackendRole =
                  !rawFallbackRole ||
                  /^(?:主代理|子代理(?:\s*#\d+)?|蜂群(?:\s*#\d+)?|旁路提问(?:\s*#\d+)?|Main Agent|Subagent(?:\s*#\d+)?|Swarm(?:\s*#\d+)?|Side Question(?:\s*#\d+)?)$/i.test(
                    rawFallbackRole
                  );
                const roleText =
                  sub.customRole !== undefined
                    ? sub.customRole || fallbackRole
                    : isGenericBackendRole
                      ? fallbackRole
                      : rawFallbackRole;
                patchText(subRefs.subRole, roleText);

                const idleFallbackKey = isKilledSub
                  ? 'live.killed'
                  : isWaitingSub
                    ? 'live.waiting'
                    : 'live.done';
                const subLabel = sub.isRunning
                  ? formatLiveActivityLabel(subAct, 'live.running')
                  : formatLiveActivityLabel(subAct, idleFallbackKey);
                const subDetail = formatLiveActivityDetail(subAct);
                const subProgClean = subAct.stepProgress
                  ? String(subAct.stepProgress).replace(/^\[|\]$/g, '').trim()
                  : '';
                const subProg = subProgClean ? ` ${subProgClean}` : '';
                const summaryStr = showSessionExtras
                  ? sub.isRunning
                    ? `${subLabel}${subProg}${subDetail ? ` · ${subDetail}` : ''}`
                    : isKilledSub
                      ? t('live.killedWithSteps', { steps: sub.stepCount || 0 })
                      : isWaitingSub
                        ? t('live.waitingWithSteps', { steps: sub.stepCount || 0 })
                        : t('live.doneWithSteps', { steps: sub.stepCount || 0 })
                  : [`${subLabel}${subProg}`.trim(), subDetail].filter(Boolean).join(' ');
                patchAttr(subRefs.subSummary, 'hidden', !summaryStr);
                patchText(subRefs.subSummary, summaryStr);

                if (interactive && !showSessionExtras) {
                  patchAttr(
                    subRefs.rowEl,
                    'title',
                    `[${subBadgeText}] ${roleText}${summaryStr ? ` ${summaryStr}` : ''}`
                  );
                }

                if (sub.isRunning) {
                  const subTimerKey = `sub:${sub.cascadeId}`;
                  activeTimerKeys.add(subTimerKey);
                  bindLiveElapsedTimer(
                    subTimerKey,
                    `${sub.cascadeId}:${subAct.signature || subLabel}`,
                    subAct.startedAtMs || sub.lastModifiedMs,
                    subRefs.subElapsed
                  );
                } else {
                  activityTimersMap.delete(`sub:${sub.cascadeId}`);
                  patchText(
                    subRefs.subElapsed,
                    t('header.convMetaSteps', { count: sub.stepCount || 0 })
                  );
                }
              },
            });
            refs.subScroll.refresh();
          }
        },
        destroyRow: (refs) => {
          clearSubExpandAnim(refs);
          refs?.subScroll?.destroy?.();
        },
      });

      for (const key of [...activityTimersMap.keys()]) {
        if (!activeTimerKeys.has(key)) {
          activityTimersMap.delete(key);
        }
      }
      updateLiveElapsedDisplay();
      ensureLiveTicker();
    }

    onCleanup(() => {
      stopLiveTicker();
      patchKeyedList(liveActivityBar, [], {
        destroyRow: (refs) => {
          clearSubExpandAnim(refs);
          refs?.subScroll?.destroy?.();
        },
      });
    });

    return {
      el: liveActivityBar,
      refs: {
        update,
        pauseTicker,
        resumeTicker,
        stopLiveTicker,
      },
    };
  },
});
