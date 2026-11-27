/**
 * @fileoverview 主窗口双栖挂载外壳 (WindowOverlayShell.js).
 *
 * 采用「分离式双 Shadow Host」架构，彻底规避宿主顶栏层叠上下文 (`z-0` / `overflow: hidden`) 裁切与路由重绘卸载问题：
 * 1. `#ag-usage-monitor-capsule`：轻量顶栏胶囊，优先内嵌停靠至 `[class*="@container/titlebar"]` 右侧按钮组，
 *    支持四级迟滞宽度自适应折叠（`wide` -> `compact` -> `minimal` -> `ring-only`），找不到顶栏时自动回退至右上角固定定位；
 * 2. `#ag-usage-monitor-portal`：常驻 `document.body` 顶层的无遮挡浮层宿主，承载悬停速览卡与完整四标签 `App()` 监控面板，
 *    在宿主切换会话重建顶栏 DOM 时始终保持组件实例、滚动位置与动画状态不丢失。
 */

import {
  LOCAL_ENDPOINT_ID,
  WINDOW_BRIDGE_ENDPOINT_KEY,
  WINDOW_BRIDGE_KEY,
  WINDOW_OVERLAY_KEY,
  WINDOW_OVERLAY_METHODS,
  readInjectedWindowBridge,
} from '../../../shared/window-bridge-protocol.mjs';
import { App } from '../../App.js';
import {
  PANEL_SCALE_FACTORS,
  applyAppearanceToRoot,
  normalizeClientFontScale,
  resolveSettingsModernUi,
} from '../../core/appearance.js';
import {
  getElementContentWidth,
  getVisualTransformScale,
  h,
  isEventInside,
  patchAttr,
  patchClasses,
  patchText,
} from '../../core/domPatch.js';
import { deliverCdpBridgeResponses, getWindowBridgeConfig } from '../../core/httpClient.js';
import { i18nStore, setI18nLanguage, t } from '../../i18n/index.js';
import { createSvgIcon, patchSvgIcon } from '../../icons/SvgIcon.js';
import {
  buildCapsuleSlotContext,
  createCapsuleSlotNode,
  patchCapsuleOdometerText,
  resolveMultiSessionCapsuleState,
  syncCapsuleSlotNodes,
} from '../widgets/CapsuleBarWidget.js';
import { LiveActivityWidget } from '../widgets/LiveActivityWidget.js';
import { createDynamicWidgetHost } from '../../registries/widgetRegistry.js';
import {
  DEFAULT_CLIENT_HOVER_MODULES,
  extractHostRouteCascadeId,
  fetchTelemetry,
  getDefaultCtxInspectorAgentId,
  isClientTopbarMultiSessionVisible,
  isMacHostPlatform,
  normalizeClientHoverModules,
  normalizeClientPopoverWidth,
  normalizeClientPopoverWidthMode,
  normalizeClientTopbarMultiSessionMode,
  normalizeClientTopbarSlots,
  normalizeClientUpdateMode,
  normalizeClientWindowMountMode,
  resetTelemetryForEndpointSwitch,
  resolveHostRouteMatch,
  resolveOverlayCtxInspectorAgentId,
  resolveScopedConversation,
  selectConversation,
  startAsyncTelemetryLoop,
  stopAsyncTelemetryLoop,
  telemetryStore,
  triggerPluginUpdate,
} from '../../store/telemetryStore.js';
import { uiStore } from '../../store/uiStore.js';

import {
  CAPSULE_HOST_ID,
  PORTAL_HOST_ID,
  attachShadowStyles,
  computeCapsuleLayoutMode,
  findNativeTopRightAnchor,
  getLeftSidebarRightEdge,
  getRightSidebarLeftEdge,
  isIdeExtensionChatFrame,
  isImmediatelyBeforeNode,
  resolveActiveDockTarget,
} from './overlayHostAnchors.js';

export { computeCapsuleLayoutMode };

const FLOATING_CARD_WIDTH = 522;
const POPOVER_BASE_WIDTH = 540;
const POPOVER_MAX_AUTO_WIDTH = 960;
const MULTI_PANEL_WIDTH = 376;
const MULTI_PANEL_EMPTY_WIDTH = 256;


export function mountWindowOverlay() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;

  // 先读取旧实例缓存的遥测快照与展开态（热升级时无缝承接数据与悬停状态，杜绝闪烁或关开），再安全卸载旧实例
  let carryOverTelemetry = null;
  let carryOverTooltipOpen = false;
  let carryOverPopoverOpen = false;
  let carryOverMultiHoverOpen = false;
  let carryOverMultiPinnedOpen = false;
  let carryOverPointer = null;
  try {
    const prevOv = window[WINDOW_OVERLAY_KEY];
    carryOverTelemetry = prevOv?.getTelemetrySnapshot?.() || null;
    carryOverTooltipOpen = Boolean(prevOv?.isHoverOpen?.());
    carryOverPopoverOpen = Boolean(prevOv?.isOpen?.());
    carryOverMultiHoverOpen = Boolean(prevOv?.isMultiHoverOpen?.());
    carryOverMultiPinnedOpen = Boolean(prevOv?.isMultiPinnedOpen?.());
    carryOverPointer = prevOv?.getLastPointer?.() || null;
    prevOv?.[WINDOW_OVERLAY_METHODS.dispose]?.();
  } catch {
    // 忽略旧实例卸载异常
  }
  try {
    document.getElementById(CAPSULE_HOST_ID)?.remove?.();
    document.getElementById(PORTAL_HOST_ID)?.remove?.();
  } catch {
    // 忽略残留节点清理异常
  }

  const bridgeConfig = getWindowBridgeConfig();
  const bundleVersion = String(bridgeConfig?.bundleVersion || '');
  const stylesCss = String(bridgeConfig?.stylesCss || '');
  const activeBridgeEndpointId = String(
    bridgeConfig?.[WINDOW_BRIDGE_ENDPOINT_KEY] || LOCAL_ENDPOINT_ID
  );
  const reusableCarryOver =
    carryOverTelemetry &&
    String(carryOverTelemetry?.endpoint?.id || LOCAL_ENDPOINT_ID) === activeBridgeEndpointId
      ? carryOverTelemetry
      : null;
  const seedTelemetry =
    (bridgeConfig?.initialTelemetry && typeof bridgeConfig.initialTelemetry === 'object'
      ? bridgeConfig.initialTelemetry
      : null) || reusableCarryOver;
  if (bridgeConfig?.initialTelemetry) {
    delete bridgeConfig.initialTelemetry;
  }
  if (seedTelemetry) {
    setI18nLanguage(seedTelemetry?.settings?.language);
    telemetryStore.setState({
      telemetry: seedTelemetry,
      minuteTick: Math.floor(Date.now() / 30000),
      syncState: 'idle',
    });
  } else {
    setI18nLanguage(telemetryStore.getState().telemetry?.settings?.language);
  }

  let disposed = false;
  let popoverOpen = false;
  let tooltipOpen = false;
  let multiOpen = false;
  let multiPinned = false;
  let hoverLeaveTimer = null;
  let multiLeaveTimer = null;
  let hasPointerCoords = Boolean(
    carryOverPointer &&
      Number.isFinite(carryOverPointer.x) &&
      Number.isFinite(carryOverPointer.y)
  );
  let lastPointerX = hasPointerCoords ? carryOverPointer.x : -1;
  let lastPointerY = hasPointerCoords ? carryOverPointer.y : -1;
  let layoutMode = 'wide';
  let observedTitlebar = null;
  let dockRafId = 0;
  let lastObservedRouteId = extractHostRouteCascadeId();

  function recordPointerCoords(e) {
    if (e && Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
      lastPointerX = e.clientX;
      lastPointerY = e.clientY;
      hasPointerCoords = true;
    }
  }

  function isPointerStillInCapsule() {
    if (!hasPointerCoords || document.hidden || !capsuleBtn.getBoundingClientRect) {
      return false;
    }
    const r = capsuleBtn.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    let rightBound = r.right;
    if (!topbarUpdateBtn.hasAttribute('hidden') && topbarUpdateBtn.getBoundingClientRect) {
      const ur = topbarUpdateBtn.getBoundingClientRect();
      if (ur.width > 0 && ur.height > 0) {
        rightBound = Math.max(rightBound, ur.right);
      }
    }
    return (
      lastPointerX >= r.left - 1 &&
      lastPointerX <= rightBound + 1 &&
      lastPointerY >= r.top - 1 &&
      lastPointerY <= r.bottom + 1
    );
  }

  function isPointerInMultiZone() {
    if (!hasPointerCoords || document.hidden || multiBtn.hasAttribute('hidden')) {
      return false;
    }
    const bridgePad = multiOpen ? 12 : 1;
    if (multiBtn.getBoundingClientRect) {
      const mr = multiBtn.getBoundingClientRect();
      if (
        mr.width > 0 &&
        mr.height > 0 &&
        lastPointerX >= mr.left - 1 &&
        lastPointerX <= mr.right + 1 &&
        lastPointerY >= mr.top - bridgePad &&
        lastPointerY <= mr.bottom + bridgePad
      ) {
        return true;
      }
    }
    if (multiOpen && multiPanelEl.getBoundingClientRect) {
      const pr = multiPanelEl.getBoundingClientRect();
      if (
        pr.width > 0 &&
        pr.height > 0 &&
        lastPointerX >= pr.left - 1 &&
        lastPointerX <= pr.right + 1 &&
        lastPointerY >= pr.top - 8 &&
        lastPointerY <= pr.bottom + 12
      ) {
        return true;
      }
    }
    return false;
  }

  function scheduleMultiHoverClose() {
    if (multiLeaveTimer) {
      clearTimeout(multiLeaveTimer);
    }
    multiLeaveTimer = setTimeout(() => {
      multiLeaveTimer = null;
      if (disposed || multiPinned || !multiOpen) return;
      let nativeHover = false;
      try {
        nativeHover = Boolean(
          multiBtn.matches?.(':hover') || multiPanelEl.matches?.(':hover')
        );
      } catch {
        nativeHover = false;
      }
      if (nativeHover || isPointerInMultiZone()) {
        return;
      }
      setMultiOpen(false);
    }, 90);
  }

  function inspectSessionInMonitor(cascadeId) {
    if (!cascadeId || cascadeId === 'current') return;
    uiStore.setState({
      activeView: 'overview',
      selectedAgentScope: 'all',
      ctxInspectorAgentId: getDefaultCtxInspectorAgentId(
        telemetryStore.getState().telemetry?.settings
      ),
    });
    void selectConversation(cascadeId);
    setMultiOpen(false);
    setPopoverOpen(true);
  }

  // --- 1. 创建顶栏/输入框双胶囊 Shadow Host（左：多会话实时信息；右：单会话指标胶囊） ---
  const capsuleHost = document.createElement('div');
  capsuleHost.id = CAPSULE_HOST_ID;
  capsuleHost.className = 'wm-capsule-host';
  capsuleHost.setAttribute('data-dock', 'fixed');
  capsuleHost.setAttribute('data-layout', layoutMode);
  // 隔离冒泡事件，防止嵌入输入框工具栏时点击或回车误触外层编辑框聚焦或表单提交
  capsuleHost.addEventListener?.('mousedown', (e) => e.stopPropagation?.());
  capsuleHost.addEventListener?.('click', (e) => e.stopPropagation?.());
  capsuleHost.addEventListener?.('keydown', (e) => {
    if (e?.key !== 'Escape') {
      e.stopPropagation?.();
    }
  });
  const capsuleShadow = capsuleHost.attachShadow({ mode: 'open' });
  attachShadowStyles(capsuleShadow, stylesCss, { slimCapsule: true });

  // 左侧无边框多会话实时触发按钮（固定预占宽度，不随运行数跳动）
  const multiDot = h('span', { className: 'wm-multi-dot' });
  const multiLabel = h('span', { className: 'wm-multi-label', text: t('capsule.multiZero') });
  const multiBtn = h(
    'button',
    {
      type: 'button',
      className: 'wm-multi-btn',
      'aria-label': t('capsule.ariaMulti'),
      'aria-expanded': 'false',
      onClick: (e) => {
        e.stopPropagation();
        if (multiOpen && multiPinned) {
          setMultiOpen(false);
        } else {
          setMultiOpen(true, { pinned: true });
        }
      },
      onContextmenu: (e) => {
        e.preventDefault();
        e.stopPropagation();
        void fetchTelemetry({ force: true });
      },
      onMouseenter: (e) => {
        recordPointerCoords(e);
        if (multiLeaveTimer) {
          clearTimeout(multiLeaveTimer);
          multiLeaveTimer = null;
        }
        if (!popoverOpen && !multiPinned) {
          setMultiOpen(true, { pinned: false });
        }
      },
      onMouseleave: (e) => {
        recordPointerCoords(e);
        if (!multiPinned) {
          scheduleMultiHoverClose();
        }
      },
    },
    [multiDot, multiLabel]
  );

  // 构建可复用的预占胶囊槽位节点（由 CapsuleBarWidget 共享创建，支持 1..5 项动态槽位）
  const capsuleSlots = [
    createCapsuleSlotNode(0, 'tps'),
    createCapsuleSlotNode(1, 'ttft'),
    createCapsuleSlotNode(2, 'context'),
    createCapsuleSlotNode(3, 'none'),
    createCapsuleSlotNode(4, 'none'),
  ];
  const capsuleSeps = [
    h('span', { className: 'wm-sep wm-sep-speed', 'data-sep-for-rank': '2' }),
    h('span', { className: 'wm-sep wm-sep-quota', 'data-sep-for-rank': '3' }),
    h('span', { className: 'wm-sep', 'data-sep-for-rank': '', hidden: true }),
    h('span', { className: 'wm-sep', 'data-sep-for-rank': '', hidden: true }),
  ];
  let lastSlotCount = 3;
  let lastShowMulti = true;
  let lastRunningCount = 0;
  let lastShowUpdate = false;
  let isTopbarUpdating = false;

  function resolveEffectiveShowMulti(telemetry, runningCountOverride = null) {
    const mode = normalizeClientTopbarMultiSessionMode(
      telemetry?.settings?.topbarMultiSessionMode,
      telemetry?.settings?.showTopbarMultiSession
    );
    const count = runningCountOverride !== null ? runningCountOverride : lastRunningCount;
    return isClientTopbarMultiSessionVisible(mode, count);
  }

  const updateDot = h('span', { className: 'wm-update-dot', hidden: true });
  const topbarUpdateIcon = createSvgIcon('arrow-down', { size: 10 });
  const topbarUpdateLabel = h('span', {
    className: 'wm-update-label',
    text: t('capsule.newVersion'),
  });
  const topbarUpdateBtn = h(
    'button',
    {
      type: 'button',
      className: 'wm-update-btn',
      hidden: true,
      'aria-label': t('capsule.ariaUpdateTitle'),
      title: t('capsule.ariaUpdateTitle'),
      onClick: async (e) => {
        e.stopPropagation();
        if (isTopbarUpdating) return;
        isTopbarUpdating = true;
        patchClasses(topbarUpdateBtn, { 'is-updating': true });
        patchSvgIcon(topbarUpdateIcon, 'refresh');
        patchText(topbarUpdateLabel, t('capsule.updating'));
        patchAttr(topbarUpdateBtn, 'disabled', true);
        try {
          const res = await triggerPluginUpdate();
          if (!res?.ok) {
            uiStore.setState({ activeView: 'settings' });
            setPopoverOpen(true);
          }
        } catch {
          uiStore.setState({ activeView: 'settings' });
          setPopoverOpen(true);
        } finally {
          isTopbarUpdating = false;
          patchClasses(topbarUpdateBtn, { 'is-updating': false });
          patchSvgIcon(topbarUpdateIcon, 'arrow-down');
          patchAttr(topbarUpdateBtn, 'disabled', false);
          const cs = telemetryStore.getState().telemetry?.cloudStatus;
          patchText(
            topbarUpdateLabel,
            cs?.latestPluginVersion ? `v${cs.latestPluginVersion}` : t('capsule.newVersion')
          );
        }
      },
      onMouseenter: (e) => {
        recordPointerCoords(e);
        if (hoverLeaveTimer) {
          clearTimeout(hoverLeaveTimer);
          hoverLeaveTimer = null;
        }
        if (!popoverOpen && !multiPinned) {
          if (multiOpen) {
            setMultiOpen(false);
          }
          setTooltipOpen(true);
        }
      },
      onMouseleave: (e) => {
        recordPointerCoords(e);
        if (hoverLeaveTimer) {
          clearTimeout(hoverLeaveTimer);
        }
        hoverLeaveTimer = setTimeout(() => {
          hoverLeaveTimer = null;
          if (disposed || popoverOpen) return;
          let nativeHover = false;
          try {
            nativeHover = Boolean(
              capsuleBtn.matches?.(':hover') || topbarUpdateBtn.matches?.(':hover')
            );
          } catch {
            nativeHover = false;
          }
          if (nativeHover || isPointerStillInCapsule()) {
            return;
          }
          setTooltipOpen(false);
        }, 40);
      },
    },
    [topbarUpdateIcon, topbarUpdateLabel]
  );

  const capsuleBtn = h(
    'button',
    {
      type: 'button',
      className: 'wm-capsule-btn',
      'aria-label': t('capsule.ariaMonitor'),
      'aria-expanded': 'false',
      onClick: (e) => {
        e.stopPropagation();
        setPopoverOpen(!popoverOpen);
      },
      onContextmenu: (e) => {
        e.preventDefault();
        e.stopPropagation();
        void fetchTelemetry({ force: true });
      },
      onMouseenter: (e) => {
        recordPointerCoords(e);
        if (hoverLeaveTimer) {
          clearTimeout(hoverLeaveTimer);
          hoverLeaveTimer = null;
        }
        if (!popoverOpen && !multiPinned) {
          if (multiOpen) {
            setMultiOpen(false);
          }
          setTooltipOpen(true);
        }
      },
      onMouseleave: (e) => {
        recordPointerCoords(e);
        if (hoverLeaveTimer) {
          clearTimeout(hoverLeaveTimer);
        }
        hoverLeaveTimer = setTimeout(() => {
          hoverLeaveTimer = null;
          if (disposed || popoverOpen) return;
          let nativeHover = false;
          try {
            nativeHover = Boolean(
              capsuleBtn.matches?.(':hover') || topbarUpdateBtn.matches?.(':hover')
            );
          } catch {
            nativeHover = false;
          }
          if (nativeHover || isPointerStillInCapsule()) {
            return;
          }
          setTooltipOpen(false);
        }, 40);
      },
    },
    [
      capsuleSlots[0].el,
      capsuleSeps[0],
      capsuleSlots[1].el,
      capsuleSeps[1],
      capsuleSlots[2].el,
      capsuleSeps[2],
      capsuleSlots[3].el,
      capsuleSeps[3],
      capsuleSlots[4].el,
      updateDot,
    ]
  );
  capsuleShadow.appendChild(multiBtn);
  capsuleShadow.appendChild(capsuleBtn);
  capsuleShadow.appendChild(topbarUpdateBtn);

  // --- 2. 创建 Body 顶层浮层 Portal Shadow Host ---
  const portalHost = document.createElement('div');
  portalHost.id = PORTAL_HOST_ID;
  portalHost.className = 'wm-portal-host';
  const portalShadow = portalHost.attachShadow({ mode: 'open' });
  attachShadowStyles(portalShadow, stylesCss, { slimCapsule: false });

  const initialSettings = telemetryStore.getState().telemetry?.settings;

  // 悬停全景概览浮层（完全解耦至 widgetRegistry，由 hoverModules 动态驱动 0..4 个独立组件，零硬编码）
  const hoverUpdateVerText = h('span', { text: t('capsule.hoverNewVerGeneric') });
  const hoverUpdateHintText = h('span', {
    className: 'wm-hover-update-hint',
    text: t('capsule.hoverUpdateHintTopbarGeneric'),
  });
  const hoverUpdateBar = h(
    'div',
    {
      className: 'wm-hover-update-bar',
      hidden: true,
    },
    [
      h('span', { className: 'wm-hover-update-left' }, [
        createSvgIcon('arrow-down', { size: 11 }),
        hoverUpdateVerText,
      ]),
      hoverUpdateHintText,
    ]
  );

  const hoverWidgetsContainer = h('div', { className: 'wm-hover-widgets' });
  const hoverWidgetHost = createDynamicWidgetHost({
    containerEl: hoverWidgetsContainer,
    mode: 'hover',
    isVisibleFn: () => Boolean(tooltipOpen && !disposed),
    initialModuleKeys: DEFAULT_CLIENT_HOVER_MODULES,
    getCtxAgentId: () =>
      resolveOverlayCtxInspectorAgentId(
        telemetryStore.getState().telemetry,
        uiStore.getState().ctxInspectorAgentId
      ),
  });

  const hoverTipEl = h(
    'div',
    {
      className: 'wm-hover-tip',
      hidden: true,
    },
    [hoverUpdateBar, hoverWidgetsContainer]
  );

  // 左侧多会话实时看板浮层（受控复用 LiveActivityWidget，保持零硬编码与同一套计时器状态机）
  const multiPinBadge = h('span', {
    className: 'wm-pin-badge',
    hidden: true,
    text: t('multi.pinned'),
  });
  const multiRunningMetaEl = h('span', {
    className: 'panel-meta text-mono',
    text: t('multi.loading'),
  });
  const multiEmptyTextEl = h('span', { text: t('multi.empty') });
  const multiEmptyEl = h('div', { className: 'wm-multi-empty' }, [
    h('span', { className: 'wm-multi-empty-left' }, [
      h('span', { className: 'wm-idle-dot' }),
      multiEmptyTextEl,
    ]),
  ]);
  const multiRunningWidget = LiveActivityWidget({
    defaultExpandRunningSubs: true,
    showSessionExtras: true,
    isVisibleFn: () => Boolean(multiOpen && !document.hidden && !disposed),
    onSelectSession: inspectSessionInMonitor,
    onLayoutChange: () => {
      if (multiOpen) {
        patchClasses(multiPanelEl, { 'is-instant': true });
        positionFloatingElements();
      }
    },
  });

  const multiTitleTextEl = h('span', { text: t('multi.title') });
  const multiHeaderEl = h('div', { className: 'panel-header wm-multi-header' }, [
    h('span', { className: 'panel-title' }, [
      createSvgIcon('pulse', { size: 13 }),
      multiTitleTextEl,
      multiPinBadge,
    ]),
    multiRunningMetaEl,
  ]);

  const multiPanelEl = h(
    'div',
    {
      className: 'wm-multi-panel',
      role: 'dialog',
      'aria-label': t('multi.ariaDialog'),
      hidden: true,
      onMouseenter: (e) => {
        recordPointerCoords(e);
        if (multiLeaveTimer) {
          clearTimeout(multiLeaveTimer);
          multiLeaveTimer = null;
        }
      },
      onMouseleave: (e) => {
        recordPointerCoords(e);
        if (!multiPinned) {
          scheduleMultiHoverClose();
        }
      },
    },
    [multiHeaderEl, multiEmptyEl, multiRunningWidget.el]
  );

  // 完整四标签悬浮容器（首次打开主弹窗时按需懒挂载 App，彻底消除宿主窗口冷启动开销）
  uiStore.setState({ monitorVisible: false });
  let appInstance = null;
  const popoverEl = h(
    'div',
    {
      className: 'wm-popover-panel',
      role: 'dialog',
      'aria-label': t('capsule.ariaMonitor'),
      hidden: true,
    },
    []
  );

  let popoverLayoutMicrotaskPending = false;
  function schedulePopoverLayoutSync() {
    if (disposed || !popoverOpen || popoverLayoutMicrotaskPending) return;
    popoverLayoutMicrotaskPending = true;
    const run = () => {
      popoverLayoutMicrotaskPending = false;
      if (disposed || !popoverOpen) return;
      positionFloatingElements();
    };
    if (typeof queueMicrotask === 'function') {
      queueMicrotask(run);
    } else {
      Promise.resolve().then(run);
    }
  }

  function ensureAppMounted() {
    if (!appInstance) {
      appInstance = App({
        onLayoutChange: () => {
          if (!disposed && popoverOpen) {
            schedulePopoverLayoutSync();
          }
        },
      });
      popoverEl.appendChild(appInstance.el);
    }
    return appInstance;
  }

  const onPopoverAnimationEnd = (e) => {
    if (disposed || !popoverOpen) return;
    if (e?.target && e.target !== popoverEl) return;
    positionFloatingElements();
    refreshActiveViewScrollbars();
  };
  popoverEl.addEventListener?.('animationend', onPopoverAnimationEnd);

  function syncPortalAppearance(settings) {
    applyAppearanceToRoot(capsuleHost, settings, { includeFontScale: false });
    applyAppearanceToRoot(portalHost, settings, { includeFontScale: true });
    const scaleKey = normalizeClientFontScale(settings?.fontScale);
    const isModernUi = resolveSettingsModernUi(settings);
    const colorScheme = portalHost.getAttribute?.('data-color-scheme') || 'light';
    for (const el of [popoverEl, hoverTipEl, multiPanelEl]) {
      if (el.getAttribute?.('data-font-scale') !== scaleKey) {
        el.setAttribute?.('data-font-scale', scaleKey);
      }
      if (el.getAttribute?.('data-color-scheme') !== colorScheme) {
        el.setAttribute?.('data-color-scheme', colorScheme);
      }
      if (isModernUi) {
        if (el.getAttribute?.('data-modern-ui') !== 'true') {
          el.setAttribute?.('data-modern-ui', 'true');
        }
      } else if (el.hasAttribute?.('data-modern-ui')) {
        el.removeAttribute?.('data-modern-ui');
      }
    }
  }

  portalShadow.appendChild(multiPanelEl);
  portalShadow.appendChild(hoverTipEl);
  portalShadow.appendChild(popoverEl);
  syncPortalAppearance(initialSettings);
  (document.body || document.documentElement).appendChild(portalHost);

  // --- 3. 几何测量、IDE 主题桥接、顶栏停靠与防溢出定位 ---
  let patchedActionToolbar = null;
  let patchedActionToolbarPrevMargin = '';
  let observedWorkbench = null;
  let themeObserver = null;
  const mirroredThemeVars = new Map();
  const mirroredTypographyVars = new Map();

  function isUsableHostFontStack(raw) {
    const val = String(raw || '').trim();
    if (!val) return false;
    const bare = val.replace(/["']/g, '').trim();
    return !/^(?:initial|inherit|unset|revert|serif|sans-serif|monospace|times new roman|arial)$/i.test(
      bare
    );
  }

  function syncHostTypographyVars(rootCs, bodyCs, wbCs) {
    const readProp = (cs, prop, fallbackKey = '') => {
      if (!cs) return '';
      const v = String(cs.getPropertyValue?.(prop) || (fallbackKey ? cs[fallbackKey] : '') || '').trim();
      return isUsableHostFontStack(v) ? v : '';
    };
    const hostFontSans =
      readProp(rootCs, '--font-sans') ||
      readProp(bodyCs, '--font-sans') ||
      readProp(wbCs, '--vscode-font-family') ||
      readProp(bodyCs, 'font-family', 'fontFamily') ||
      readProp(rootCs, 'font-family', 'fontFamily');
    const hostFontMono =
      readProp(rootCs, '--font-mono') ||
      readProp(bodyCs, '--font-mono') ||
      readProp(wbCs, '--vscode-editor-font-family') ||
      readProp(rootCs, '--font-code');

    for (const [cssVar, val] of [
      ['--font-sans', hostFontSans],
      ['--font-mono', hostFontMono],
    ]) {
      const prevVal = mirroredTypographyVars.get(cssVar) || '';
      if (val) {
        if (prevVal !== val) {
          portalHost.style.setProperty?.(cssVar, val);
          mirroredTypographyVars.set(cssVar, val);
        }
      } else if (prevVal) {
        if (typeof portalHost.style.removeProperty === 'function') {
          portalHost.style.removeProperty(cssVar);
        } else {
          portalHost.style.setProperty?.(cssVar, '');
        }
        mirroredTypographyVars.delete(cssVar);
      }
    }
  }

  function restorePatchedActionToolbar() {
    if (!patchedActionToolbar) return;
    try {
      if (patchedActionToolbar.style) {
        patchedActionToolbar.style.marginLeft = patchedActionToolbarPrevMargin;
      }
    } catch {
      // 忽略还原宿主工具栏边距异常
    }
    patchedActionToolbar = null;
    patchedActionToolbarPrevMargin = '';
  }

  function syncWorkbenchThemeVars() {
    if (disposed) return null;
    try {
      if (
        typeof document === 'undefined' ||
        typeof document.querySelector !== 'function' ||
        typeof window.getComputedStyle !== 'function'
      ) {
        return null;
      }
      const workbenchEl = document.querySelector('.monaco-workbench');
      const rootCs = document.documentElement
        ? window.getComputedStyle(document.documentElement)
        : null;
      const bodyCs = document.body ? window.getComputedStyle(document.body) : null;
      const wbOnlyCs = workbenchEl ? window.getComputedStyle(workbenchEl) : null;
      syncHostTypographyVars(rootCs, bodyCs, wbOnlyCs);
      const nativeRootBg = String(
        rootCs?.getPropertyValue?.('--background') ||
          bodyCs?.getPropertyValue?.('--background') ||
          ''
      ).trim();
      if (nativeRootBg) {
        if (mirroredThemeVars.size > 0) {
          for (const k of mirroredThemeVars.keys()) {
            portalHost.style.removeProperty?.(k);
            capsuleHost.style.removeProperty?.(k);
          }
          mirroredThemeVars.clear();
        }
        return workbenchEl || document.documentElement || null;
      }

      const themeSourceEl = workbenchEl || document.documentElement || document.body;
      if (!themeSourceEl) return null;
      const wbCs = window.getComputedStyle(themeSourceEl);
      const pick = (...names) => {
        for (const name of names) {
          const val = String(wbCs?.getPropertyValue?.(name) || '').trim();
          if (val) return val;
        }
        return '';
      };

      const nextVars = [
        [
          '--background',
          pick('--vscode-sideBar-background', '--vscode-editor-background', '--vscode-panel-background'),
        ],
        [
          '--card',
          pick(
            '--vscode-editorWidget-background',
            '--vscode-sideBar-background',
            '--vscode-editor-background'
          ),
        ],
        ['--foreground', pick('--vscode-foreground', '--vscode-editor-foreground')],
        [
          '--muted-foreground',
          pick('--vscode-descriptionForeground', '--vscode-sideBarTitle-foreground'),
        ],
        [
          '--border',
          pick(
            '--vscode-widget-border',
            '--vscode-panel-border',
            '--vscode-commandCenter-border',
            '--vscode-contrastBorder'
          ),
        ],
        [
          '--primary',
          pick('--vscode-textLink-foreground', '--vscode-button-background', '--vscode-focusBorder'),
        ],
        ['--destructive', pick('--vscode-errorForeground', '--vscode-editorError-foreground')],
      ];

      for (const [cssVar, val] of nextVars) {
        const prevVal = mirroredThemeVars.get(cssVar) || '';
        if (val) {
          if (prevVal !== val) {
            portalHost.style.setProperty?.(cssVar, val);
            capsuleHost.style.setProperty?.(cssVar, val);
            mirroredThemeVars.set(cssVar, val);
          }
        } else if (prevVal) {
          if (typeof portalHost.style.removeProperty === 'function') {
            portalHost.style.removeProperty(cssVar);
          } else {
            portalHost.style.setProperty?.(cssVar, '');
          }
          if (typeof capsuleHost.style.removeProperty === 'function') {
            capsuleHost.style.removeProperty(cssVar);
          } else {
            capsuleHost.style.setProperty?.(cssVar, '');
          }
          mirroredThemeVars.delete(cssVar);
        }
      }
      return themeSourceEl;
    } catch {
      return null;
    }
  }

  function ensureWorkbenchThemeObserved() {
    const wb = syncWorkbenchThemeVars();
    syncPortalAppearance(telemetryStore.getState().telemetry?.settings);
    if (wb && wb !== observedWorkbench && themeObserver) {
      observedWorkbench = wb;
      try {
        themeObserver.observe(wb, { attributes: true, attributeFilter: ['class', 'style'] });
      } catch {
        // 忽略工作台属性观察异常
      }
    }
  }

  function resolveRuntimeDockTarget() {
    return resolveActiveDockTarget({
      capsuleNode: capsuleHost,
      portalNode: portalHost,
      patchedNode: patchedActionToolbar,
    });
  }

  function isDockPlacementSynced(dock) {
    const curDockAttr = capsuleHost.getAttribute('data-dock');
    if (!capsuleHost.isConnected || !portalHost.isConnected) return false;
    if (!dock) {
      if (isIdeExtensionChatFrame()) {
        return curDockAttr === 'pending-composer' && capsuleHost.style.display === 'none';
      }
      return curDockAttr === 'fixed';
    }
    if (capsuleHost.style.display === 'none') return false;
    if (!dock.targetContainer?.contains?.(capsuleHost) || curDockAttr !== dock.kind) return false;
    if (dock.kind === 'composer') {
      if (dock.anchorNode) {
        if (!isImmediatelyBeforeNode(capsuleHost, dock.anchorNode)) return false;
      } else {
        const lastEl =
          dock.targetContainer.lastElementChild !== undefined
            ? dock.targetContainer.lastElementChild
            : dock.targetContainer.children?.[dock.targetContainer.children.length - 1] ||
              dock.targetContainer.lastChild;
        if (lastEl !== capsuleHost) return false;
      }
    }
    return true;
  }

  const isMac = () => isMacHostPlatform(telemetryStore.getState().telemetry);

  function updateFixedFallbackPosition() {
    const dockMode = capsuleHost.getAttribute('data-dock');
    if (dockMode === 'flow' || dockMode === 'ide-titlebar' || dockMode === 'composer') {
      capsuleHost.style.top = '';
      capsuleHost.style.right = '';
      return;
    }
    try {
      const vw = Number(window.innerWidth || 1280);
      const minRight = isMac() ? 12 : 144;
      let rightOffset = minRight;
      const anchor = findNativeTopRightAnchor();
      if (anchor?.getBoundingClientRect) {
        const r = anchor.getBoundingClientRect();
        if (r.width > 0 && r.left > 0 && r.left < vw) {
          rightOffset = Math.max(minRight, Math.ceil(vw - r.left + 6));
        }
      }
      capsuleHost.style.top = '7px';
      capsuleHost.style.right = `${rightOffset}px`;
    } catch {
      // 忽略回退坐标计算异常
    }
  }

  function syncCapsuleOsAttr() {
    const nextOs = isMac() ? 'mac' : 'default';
    if (capsuleHost.getAttribute('data-os') !== nextOs) {
      patchAttr(capsuleHost, 'data-os', nextOs);
      if (capsuleHost.getAttribute('data-dock') === 'fixed') {
        updateFixedFallbackPosition();
      }
    }
  }

  function measureAvailableTitlebarWidth(dockTarget) {
    try {
      const titlebar = dockTarget?.titlebar || null;
      if (dockTarget?.kind === 'composer' && titlebar?.getBoundingClientRect) {
        const cRect = titlebar.getBoundingClientRect();
        const aRect = dockTarget.anchorNode?.getBoundingClientRect?.();
        if (cRect.width > 0) {
          const leftEdge =
            Number.isFinite(dockTarget.leftClusterRightEdge) &&
            dockTarget.leftClusterRightEdge > cRect.left + 12
              ? dockTarget.leftClusterRightEdge
              : cRect.left + 12;
          const leftOccupied = Math.max(12, leftEdge - cRect.left);
          if (aRect && aRect.width > 0) {
            const rightOccupied = Math.max(aRect.width + 8, cRect.right - aRect.left);
            return cRect.width - leftOccupied - rightOccupied - 16;
          }
          if (!dockTarget.anchorNode) {
            return cRect.width - leftOccupied - 28;
          }
        }
      }

      if (dockTarget?.kind === 'ide-titlebar' && titlebar?.getBoundingClientRect) {
        const tbRect = titlebar.getBoundingClientRect();
        if (tbRect.width > 0) {
          let leftContentWidth = 12;
          const leftGroup =
            titlebar.querySelector?.(':scope > .titlebar-left') ||
            titlebar.querySelector?.('.titlebar-left');
          if (leftGroup) {
            let leftSum = 0;
            if (typeof window.getComputedStyle === 'function') {
              leftSum += parseFloat(window.getComputedStyle(leftGroup).paddingLeft) || 0;
            }
            if (leftGroup.children) {
              for (const child of leftGroup.children) {
                if (child?.getBoundingClientRect) {
                  leftSum += Math.max(0, child.getBoundingClientRect().width);
                }
              }
            }
            leftContentWidth = Math.min(Math.round(tbRect.width * 0.45), Math.max(12, leftSum));
          }

          let minCenterWidth = 0;
          const centerGroup =
            titlebar.querySelector?.(':scope > .titlebar-center') ||
            titlebar.querySelector?.('.titlebar-center');
          if (centerGroup?.getBoundingClientRect) {
            const cr = centerGroup.getBoundingClientRect();
            if (cr.width > 0 && cr.height > 0) {
              minCenterWidth = Math.min(220, Math.ceil(cr.width));
            }
          }

          let rightSiblingsWidth = 0;
          let hasVisibleWindowControls = false;
          const rightGroup = dockTarget.targetContainer;
          if (rightGroup?.children) {
            for (const child of rightGroup.children) {
              if (child === capsuleHost || !child?.getBoundingClientRect) continue;
              const cw = Math.max(0, child.getBoundingClientRect().width);
              rightSiblingsWidth += cw;
              if (cw > 0 && child.classList?.contains?.('window-controls-container')) {
                hasVisibleWindowControls = true;
              }
            }
          }
          if (navigator?.windowControlsOverlay?.visible) {
            const wcoRect = navigator.windowControlsOverlay.getTitlebarAreaRect?.();
            if (wcoRect && wcoRect.width > 0) {
              if (!hasVisibleWindowControls && tbRect.right > wcoRect.right + 4) {
                rightSiblingsWidth += tbRect.right - wcoRect.right;
              }
              const leftOverlayInset = wcoRect.left - tbRect.left;
              if (leftOverlayInset > leftContentWidth) {
                leftContentWidth = Math.min(
                  Math.round(tbRect.width * 0.45),
                  Math.ceil(leftOverlayInset)
                );
              }
            }
          }

          return tbRect.width - leftContentWidth - minCenterWidth - rightSiblingsWidth - 28;
        }
      }

      if (titlebar?.getBoundingClientRect) {
        const tbRect = titlebar.getBoundingClientRect();
        if (tbRect.width > 0) {
          const titleEl = titlebar.firstElementChild;
          const titleInner = titleEl?.firstElementChild;
          const macTrafficReserve = isMac() ? 80 : 168;
          const contentStart = titleInner?.getBoundingClientRect
            ? Math.max(8, titleInner.getBoundingClientRect().left - tbRect.left)
            : tbRect.left < macTrafficReserve
              ? macTrafficReserve - tbRect.left
              : 12;
          const minTitleWidth = 180;
          let siblingButtonsWidth = 64;
          let rightPad = 8;
          const rightGroup = capsuleHost.parentElement;
          if (rightGroup && rightGroup !== titlebar) {
            const auxOpen =
              typeof document.querySelector === 'function' &&
              Boolean(document.querySelector('[data-testid="aux-pane-sash"]'));
            const root =
              typeof document.querySelector === 'function'
                ? document.querySelector('div.h-screen.w-screen')
                : null;
            const rightClusterVar =
              root?.style?.getPropertyValue?.('--right-cluster-width')?.trim() || '';
            if (auxOpen) {
              rightPad = 8;
            } else if (rightClusterVar) {
              rightPad = Math.max(8, (parseFloat(rightClusterVar) || 44) - 4);
            } else if (typeof window.getComputedStyle === 'function') {
              rightPad = parseFloat(window.getComputedStyle(rightGroup).paddingRight) || 0;
            }
            if (rightGroup.children) {
              let sum = 0;
              for (const child of rightGroup.children) {
                if (child !== capsuleHost && child.getBoundingClientRect) {
                  sum += child.getBoundingClientRect().width;
                }
              }
              if (sum > 0) siblingButtonsWidth = sum + 8;
            }
          }
          return tbRect.width - contentStart - minTitleWidth - rightPad - siblingButtonsWidth;
        }
      }
      if (window.innerWidth) {
        return window.innerWidth - 360;
      }
    } catch {
      // 忽略测量异常
    }
    return 320;
  }

  function positionFloatingElements() {
    if (disposed || !capsuleBtn.getBoundingClientRect) return;
    try {
      const bRect = capsuleBtn.getBoundingClientRect();
      if (bRect.width === 0 && bRect.height === 0) return;
      const vw = Number(window.innerWidth || 1280);
      const vh = Number(window.innerHeight || 800);
      const navRight = getLeftSidebarRightEdge(vw);
      const minLeft = navRight > 0 ? Math.max(12, navRight + 12) : 12;
      const curSettings = telemetryStore.getState().telemetry?.settings;
      const panelScale =
        PANEL_SCALE_FACTORS[normalizeClientFontScale(curSettings?.fontScale)] ?? 1;
      const defaultCardW = Math.min(
        Math.round(FLOATING_CARD_WIDTH * panelScale),
        Math.max(280, vw - 24)
      );
      const isDockComposer = capsuleHost.getAttribute('data-dock') === 'composer';

      if (multiOpen) {
        const mRect = multiBtn.getBoundingClientRect?.() || bRect;
        const anchorRect = mRect.width > 0 || mRect.height > 0 ? mRect : bRect;
        const rightEdge = getRightSidebarLeftEdge(vw);
        const hasUsableRightBound = rightEdge > 0 && rightEdge - 10 - minLeft >= 240;
        const maxRight = hasUsableRightBound ? Math.min(vw - 12, rightEdge - 10) : vw - 12;
        const availMultiW = Math.max(240, maxRight - minLeft);
        const isEmptyMulti = Boolean(multiPanelEl.classList?.contains?.('is-empty'));
        const targetMultiW = Math.min(
          Math.round((isEmptyMulti ? MULTI_PANEL_EMPTY_WIDTH : MULTI_PANEL_WIDTH) * panelScale),
          availMultiW
        );
        multiPanelEl.style.maxWidth = `${availMultiW}px`;
        const measuredW =
          Number(multiPanelEl.offsetWidth) ||
          Number(multiPanelEl.getBoundingClientRect?.().width) ||
          0;
        const panelW = measuredW > 0 ? Math.min(measuredW, availMultiW) : targetMultiW;
        const panelH =
          Number(multiPanelEl.offsetHeight) ||
          Number(multiPanelEl.getBoundingClientRect?.().height) ||
          (isEmptyMulti ? 92 : 320);
        const spaceBelowMulti = vh - anchorRect.bottom - 12;
        const spaceAboveMulti = anchorRect.top - 16;
        const openMultiAbove =
          (isDockComposer && spaceAboveMulti > spaceBelowMulti) ||
          (anchorRect.bottom + 6 + panelH > vh - 8 && spaceAboveMulti > spaceBelowMulti);

        let top;
        let maxMultiH;
        if (openMultiAbove) {
          maxMultiH = Math.max(180, Math.floor(anchorRect.top - 20));
          multiPanelEl.style.maxHeight = `${maxMultiH}px`;
          const effMultiH = Math.min(Number(multiPanelEl.offsetHeight) || panelH, maxMultiH);
          top = Math.max(12, Math.round(anchorRect.top - effMultiH - 8));
        } else {
          top = Math.max(38, Math.round(anchorRect.bottom + 6));
          maxMultiH = Math.max(240, vh - top - 12);
          multiPanelEl.style.maxHeight = `${maxMultiH}px`;
        }
        patchClasses(multiPanelEl, { 'is-above': openMultiAbove });
        let left = Math.round(anchorRect.left);
        left = Math.min(left, maxRight - panelW);
        left = Math.max(minLeft, left);
        multiPanelEl.style.top = `${top}px`;
        multiPanelEl.style.left = `${left}px`;
      }

      const rightAnchorEdge =
        !topbarUpdateBtn.hasAttribute('hidden') && topbarUpdateBtn.getBoundingClientRect
          ? Math.max(bRect.right, topbarUpdateBtn.getBoundingClientRect().right || 0)
          : bRect.right;

      if (popoverOpen) {
        const maxPopCardW = Math.max(280, vw - minLeft - 12);
        const popWidthMode = normalizeClientPopoverWidthMode(curSettings?.popoverWidthMode);
        let desiredPopW = Math.min(Math.round(POPOVER_BASE_WIDTH * panelScale), maxPopCardW);
        if (popWidthMode === 'custom') {
          desiredPopW = Math.min(
            normalizeClientPopoverWidth(curSettings?.popoverWidth),
            maxPopCardW
          );
        } else if (typeof popoverEl.querySelectorAll === 'function') {
          const panes = popoverEl.querySelectorAll('.table-viewport.is-step-table');
          const { scaleX: popScaleX } = getVisualTransformScale(popoverEl);
          const rawPopRectW = Number(popoverEl.getBoundingClientRect?.()?.width || 0);
          const curPopW = Number(
            popoverEl.offsetWidth ||
              (rawPopRectW > 0 ? rawPopRectW / popScaleX : 0) ||
              POPOVER_BASE_WIDTH
          );
          for (const pane of panes) {
            let anc = pane;
            let inHiddenTree = false;
            while (anc && anc !== popoverEl) {
              if (anc.hasAttribute?.('hidden')) {
                inHiddenTree = true;
                break;
              }
              anc = anc.parentElement || anc.parentNode;
            }
            if (inHiddenTree) continue;
            const tableEl = pane.querySelector?.('.steps-data-table') || pane.firstElementChild;
            if (!tableEl) continue;
            const paneContentW = getElementContentWidth(pane);
            let naturalTableW = 0;
            if (tableEl.style) {
              const wasLocked = Boolean(tableEl.classList?.contains?.('is-cols-locked'));
              const prevW = tableEl.style.width || '';
              const prevMinW = tableEl.style.minWidth || '';
              const theadEl = wasLocked ? tableEl.querySelector?.('thead') : null;
              const lockedThs = theadEl?.querySelectorAll
                ? Array.from(theadEl.querySelectorAll('th'))
                : [];
              const prevThWidths = lockedThs.map((th) => th?.style?.width || '');
              if (wasLocked) {
                tableEl.classList.remove('is-cols-locked');
                for (let i = 0; i < lockedThs.length; i++) {
                  if (lockedThs[i]?.style) lockedThs[i].style.width = '';
                }
              }
              tableEl.style.minWidth = '';
              tableEl.style.width = 'max-content';
              const { scaleX: tableScaleX } = getVisualTransformScale(tableEl, popoverEl);
              const rawTableRectW = Number(tableEl.getBoundingClientRect?.()?.width || 0);
              const unscaledRectW = rawTableRectW > 0 ? rawTableRectW / tableScaleX : 0;
              const layoutTableW = Math.max(
                Number(tableEl.scrollWidth || 0),
                Number(tableEl.offsetWidth || 0)
              );
              naturalTableW = Math.ceil(Math.max(unscaledRectW, layoutTableW));
              tableEl.style.width = prevW;
              tableEl.style.minWidth = prevMinW;
              if (wasLocked) {
                for (let i = 0; i < lockedThs.length; i++) {
                  if (lockedThs[i]?.style) lockedThs[i].style.width = prevThWidths[i];
                }
                tableEl.classList.add('is-cols-locked');
              }
            } else {
              naturalTableW = Math.ceil(Number(tableEl.scrollWidth || tableEl.offsetWidth || 0));
            }
            if (naturalTableW > 0) {
              const chromeW =
                paneContentW > 0 && curPopW >= paneContentW
                  ? Math.max(24, curPopW - paneContentW)
                  : 52;
              desiredPopW = Math.max(
                desiredPopW,
                Math.min(POPOVER_MAX_AUTO_WIDTH, maxPopCardW, naturalTableW + chromeW + 4)
              );
            }
          }
        }
        const prevPopWidthStyle = popoverEl.style.width || '';
        const nextPopWidthStyle = `${desiredPopW}px`;
        popoverEl.style.setProperty?.('--wm-popover-w', nextPopWidthStyle);
        popoverEl.style.width = nextPopWidthStyle;

        const rawW =
          Number(popoverEl.offsetWidth) ||
          desiredPopW;
        const panelW = Math.min(rawW, maxPopCardW);
        const spaceBelowPop = vh - bRect.bottom - 12;
        const spaceAbovePop = bRect.top - 16;
        const openPopAbove =
          (isDockComposer && spaceAbovePop > spaceBelowPop) ||
          (spaceBelowPop < 360 && spaceAbovePop > spaceBelowPop);

        let top;
        if (openPopAbove) {
          const maxPopH = Math.max(240, Math.floor(bRect.top - 20));
          const targetPopH = Math.min(588, maxPopH);
          popoverEl.style.height = `${targetPopH}px`;
          popoverEl.style.maxHeight = `${maxPopH}px`;
          const actualPopH = Math.min(Number(popoverEl.offsetHeight) || targetPopH, maxPopH);
          top = Math.max(12, Math.round(bRect.top - actualPopH - 8));
        } else {
          popoverEl.style.height = '';
          top = Math.max(38, Math.min(vh - 140, Math.round(bRect.bottom + 6)));
          popoverEl.style.maxHeight = `${Math.max(240, vh - top - 12)}px`;
        }
        patchClasses(popoverEl, { 'is-above': openPopAbove });
        let left = Math.round(rightAnchorEdge - panelW);
        left = Math.min(left, vw - panelW - 12);
        left = Math.max(minLeft, left);
        popoverEl.style.top = `${top}px`;
        popoverEl.style.left = `${left}px`;
        if (prevPopWidthStyle && prevPopWidthStyle !== nextPopWidthStyle) {
          refreshActiveViewScrollbars();
        }
      }

      if (tooltipOpen && !popoverOpen && !multiOpen) {
        const rawW =
          Number(hoverTipEl.offsetWidth) ||
          Number(hoverTipEl.getBoundingClientRect?.().width) ||
          defaultCardW;
        const tipW = Math.min(rawW, Math.max(280, vw - minLeft - 12));
        const tipH =
          Number(hoverTipEl.offsetHeight) ||
          Number(hoverTipEl.getBoundingClientRect?.().height) ||
          480;
        const spaceBelowTip = vh - bRect.bottom - 12;
        const spaceAboveTip = bRect.top - 16;
        const openTipAbove =
          (isDockComposer && spaceAboveTip > spaceBelowTip) ||
          (bRect.bottom + 6 + tipH > vh - 8 && spaceAboveTip > spaceBelowTip);

        let top;
        if (openTipAbove) {
          const maxTipH = Math.max(220, Math.floor(bRect.top - 20));
          hoverTipEl.style.maxHeight = `${maxTipH}px`;
          const effTipH = Math.min(Number(hoverTipEl.offsetHeight) || tipH, maxTipH);
          top = Math.max(12, Math.round(bRect.top - effTipH - 8));
        } else {
          top = Math.max(38, Math.round(bRect.bottom + 6));
          hoverTipEl.style.maxHeight = `${Math.max(240, vh - top - 12)}px`;
        }
        patchClasses(hoverTipEl, { 'is-above': openTipAbove });
        let left = Math.round(rightAnchorEdge - tipW);
        left = Math.min(left, vw - tipW - 12);
        left = Math.max(minLeft, left);
        hoverTipEl.style.top = `${top}px`;
        hoverTipEl.style.left = `${left}px`;
      }
    } catch {
      // 忽略定位异常
    }
  }

  function updateResponsiveLayout(dockOverride = undefined) {
    if (disposed) return;
    const dockTarget = dockOverride === undefined ? resolveRuntimeDockTarget() : dockOverride;
    const avail = measureAvailableTitlebarWidth(dockTarget);
    const curTel = telemetryStore.getState().telemetry;
    const showMulti = resolveEffectiveShowMulti(curTel);
    const curUpdateMode = normalizeClientUpdateMode(
      curTel?.settings?.pluginUpdateMode,
      curTel?.settings?.autoUpdatePlugin
    );
    const hasUpdate = Boolean(curTel?.cloudStatus?.updateAvailable) && curUpdateMode !== 'off';
    const slotCount = normalizeClientTopbarSlots(curTel?.settings?.topbarCapsuleSlots).length;
    const nextMode = computeCapsuleLayoutMode(avail, layoutMode, {
      showMulti,
      hasUpdate,
      slotCount,
    });
    if (nextMode !== layoutMode) {
      layoutMode = nextMode;
      capsuleHost.setAttribute('data-layout', layoutMode);
    }
    if (capsuleHost.getAttribute('data-dock') === 'fixed') {
      updateFixedFallbackPosition();
    }
    if (popoverOpen || tooltipOpen || multiOpen) {
      positionFloatingElements();
    }
  }

  let resizeObserver = null;

  function ensureCapsuleDocked() {
    if (disposed) return false;
    const bodyOrDoc = document.body || document.documentElement;
    if (bodyOrDoc && !portalHost.isConnected) {
      bodyOrDoc.appendChild(portalHost);
    }
    syncCapsuleOsAttr();
    ensureWorkbenchThemeObserved();

    const dockTarget = resolveRuntimeDockTarget();
    if (dockTarget) {
      if (capsuleHost.style.display === 'none') {
        capsuleHost.style.display = '';
      }
      const { kind, titlebar, targetContainer, actionToolbar } = dockTarget;
      if (kind === 'composer') {
        if (patchedActionToolbar !== actionToolbar) {
          restorePatchedActionToolbar();
          if (actionToolbar?.style) {
            patchedActionToolbar = actionToolbar;
            patchedActionToolbarPrevMargin = actionToolbar.style.marginLeft || '';
            actionToolbar.style.marginLeft = '0px';
          }
        }
        if (dockTarget.anchorNode) {
          if (
            (capsuleHost.parentElement || capsuleHost.parentNode) !== targetContainer ||
            !isImmediatelyBeforeNode(capsuleHost, dockTarget.anchorNode)
          ) {
            targetContainer.insertBefore(capsuleHost, dockTarget.anchorNode);
          }
        } else {
          const lastEl =
            targetContainer.lastElementChild !== undefined
              ? targetContainer.lastElementChild
              : targetContainer.children?.[targetContainer.children.length - 1] ||
                targetContainer.lastChild;
          if (
            (capsuleHost.parentElement || capsuleHost.parentNode) !== targetContainer ||
            lastEl !== capsuleHost
          ) {
            targetContainer.appendChild(capsuleHost);
          }
        }
        patchAttr(capsuleHost, 'data-dock', 'composer');
        patchAttr(
          capsuleHost,
          'data-composer-push',
          dockTarget.needsAutoMarginTransfer ? '1' : null
        );
      } else if (kind === 'ide-titlebar') {
        if (patchedActionToolbar !== actionToolbar) {
          restorePatchedActionToolbar();
          if (actionToolbar?.style) {
            patchedActionToolbar = actionToolbar;
            patchedActionToolbarPrevMargin = actionToolbar.style.marginLeft || '';
            actionToolbar.style.marginLeft = '0px';
          }
        }
        if (capsuleHost.parentElement !== targetContainer || targetContainer.firstChild !== capsuleHost) {
          if (targetContainer.firstChild) {
            targetContainer.insertBefore(capsuleHost, targetContainer.firstChild);
          } else {
            targetContainer.appendChild(capsuleHost);
          }
        }
        patchAttr(capsuleHost, 'data-dock', 'ide-titlebar');
        patchAttr(capsuleHost, 'data-composer-push', null);
      } else {
        restorePatchedActionToolbar();
        if (capsuleHost.parentElement !== targetContainer) {
          if (targetContainer.firstChild && targetContainer !== titlebar) {
            targetContainer.insertBefore(capsuleHost, targetContainer.firstChild);
          } else {
            targetContainer.appendChild(capsuleHost);
          }
        }
        patchAttr(capsuleHost, 'data-dock', 'flow');
        patchAttr(capsuleHost, 'data-composer-push', null);
      }
      if (capsuleHost.style.top) capsuleHost.style.top = '';
      if (capsuleHost.style.right) capsuleHost.style.right = '';

      if (observedTitlebar !== titlebar) {
        observedTitlebar = titlebar;
        try {
          if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver.observe(titlebar);
            if (document.body) resizeObserver.observe(document.body);
          }
        } catch {
          // 忽略观察器异常
        }
      }
    } else if (isIdeExtensionChatFrame()) {
      restorePatchedActionToolbar();
      if (popoverOpen) setPopoverOpen(false);
      if (multiOpen) setMultiOpen(false);
      if (tooltipOpen) setTooltipOpen(false);
      if (bodyOrDoc && (capsuleHost.parentElement || capsuleHost.parentNode) !== bodyOrDoc) {
        bodyOrDoc.appendChild(capsuleHost);
      }
      capsuleHost.style.display = 'none';
      patchAttr(capsuleHost, 'data-dock', 'pending-composer');
      patchAttr(capsuleHost, 'data-composer-push', null);
    } else if (bodyOrDoc) {
      if (capsuleHost.style.display === 'none') {
        capsuleHost.style.display = '';
      }
      restorePatchedActionToolbar();
      if (capsuleHost.parentElement !== bodyOrDoc) {
        bodyOrDoc.appendChild(capsuleHost);
      }
      patchAttr(capsuleHost, 'data-dock', 'fixed');
      patchAttr(capsuleHost, 'data-composer-push', null);
      updateFixedFallbackPosition();
    }

    updateResponsiveLayout(dockTarget);
    return Boolean(capsuleHost.isConnected && portalHost.isConnected);
  }

  function scheduleDockSync() {
    if (disposed) return;
    if (typeof requestAnimationFrame === 'function') {
      if (dockRafId) return;
      dockRafId = requestAnimationFrame(() => {
        dockRafId = 0;
        ensureCapsuleDocked();
      });
    } else {
      ensureCapsuleDocked();
    }
  }

  function refreshActiveViewScrollbars() {
    if (!appInstance) return;
    const activeView = uiStore.getState().activeView;
    const refs = appInstance.refs;
    if (activeView === 'overview') {
      refs?.overviewView?.refs?.viewScrollbar?.refresh();
    } else if (activeView === 'consumption') {
      refs?.consumptionView?.refs?.viewScrollbar?.refresh();
    } else if (activeView === 'steps') {
      refs?.stepsView?.refs?.refreshStepTableViewport?.();
      refs?.stepsView?.refs?.stepsScroll?.refresh();
      refs?.stepsView?.refs?.modelsScroll?.refresh();
    } else if (activeView === 'settings') {
      refs?.settingsView?.refs?.viewScrollbar?.refresh();
    }
  }

  function setMultiOpen(nextOpen, { pinned = false, instant = false } = {}) {
    const targetOpen = Boolean(nextOpen);
    if (targetOpen && multiBtn.hasAttribute('hidden')) {
      return;
    }
    if (targetOpen && multiLeaveTimer) {
      clearTimeout(multiLeaveTimer);
      multiLeaveTimer = null;
    }
    if (targetOpen) {
      setTooltipOpen(false);
      if (pinned && popoverOpen) {
        setPopoverOpen(false);
      }
    }
    const nextPinned = targetOpen ? Boolean(pinned) : false;
    const stateChanged = multiOpen !== targetOpen || multiPinned !== nextPinned;
    multiOpen = targetOpen;
    multiPinned = nextPinned;
    patchClasses(multiBtn, { 'is-open': multiOpen && multiPinned });
    patchAttr(multiBtn, 'aria-expanded', multiOpen ? 'true' : 'false');
    patchAttr(multiPinBadge, 'hidden', !multiPinned);
    if (!stateChanged) return;
    patchClasses(multiPanelEl, { 'is-instant': Boolean(instant && multiOpen) });
    patchAttr(multiPanelEl, 'hidden', !multiOpen);
    if (multiOpen) {
      renderCapsuleTelemetry();
      multiRunningWidget.refs.resumeTicker();
      positionFloatingElements();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => positionFloatingElements());
      }
    } else {
      multiRunningWidget.refs.pauseTicker();
    }
  }

  function canOpenHoverTooltip() {
    const curTel = telemetryStore.getState().telemetry;
    const hoverMods = normalizeClientHoverModules(curTel?.settings?.hoverModules);
    const curUpdateMode = normalizeClientUpdateMode(
      curTel?.settings?.pluginUpdateMode,
      curTel?.settings?.autoUpdatePlugin
    );
    const hasUpd = Boolean(curTel?.cloudStatus?.updateAvailable) && curUpdateMode !== 'off';
    return hoverMods.length > 0 || hasUpd;
  }

  function setTooltipOpen(nextOpen, { instant = false } = {}) {
    const targetOpen = Boolean(
      nextOpen && !popoverOpen && !(multiOpen && multiPinned) && canOpenHoverTooltip()
    );
    if (targetOpen && hoverLeaveTimer) {
      clearTimeout(hoverLeaveTimer);
      hoverLeaveTimer = null;
    }
    if (targetOpen && multiOpen && !multiPinned) {
      setMultiOpen(false);
    }
    if (tooltipOpen === targetOpen) return;
    tooltipOpen = targetOpen;
    patchClasses(hoverTipEl, { 'is-instant': Boolean(instant && targetOpen) });
    patchAttr(hoverTipEl, 'hidden', !tooltipOpen);
    if (tooltipOpen) {
      renderHoverWidgets();
      hoverWidgetHost.resumeTickers();
      positionFloatingElements();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => positionFloatingElements());
      }
    } else {
      hoverWidgetHost.pauseTickers();
    }
  }

  function setPopoverOpen(nextOpen, { instant = false } = {}) {
    const targetOpen = Boolean(nextOpen);
    if (targetOpen) {
      setTooltipOpen(false);
      if (multiOpen) {
        setMultiOpen(false);
      }
    }
    if (popoverOpen === targetOpen) return;
    popoverOpen = targetOpen;
    if (popoverOpen) {
      ensureAppMounted();
    }
    patchClasses(capsuleBtn, { 'is-open': popoverOpen });
    patchClasses(popoverEl, { 'is-instant': Boolean(instant && popoverOpen) });
    patchAttr(capsuleBtn, 'aria-expanded', popoverOpen ? 'true' : 'false');
    patchAttr(popoverEl, 'hidden', !popoverOpen);
    uiStore.setState({ monitorVisible: popoverOpen && !document.hidden }, { sync: true });
    if (popoverOpen) {
      positionFloatingElements();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          positionFloatingElements();
          refreshActiveViewScrollbars();
        });
      } else {
        refreshActiveViewScrollbars();
      }
    }
  }

  function applyCapsuleSlots(slotKeys, slotCtx) {
    syncCapsuleSlotNodes(capsuleSlots, capsuleSeps, slotKeys, slotCtx);
  }

  function renderMultiRunningPanel(
    rawRunningList,
    runningCount,
    runningSubCount,
    hostRouteConversationId,
    runningSwarmCount = 0
  ) {
    const isEmpty = runningCount === 0;
    const wasEmpty = Boolean(multiPanelEl.classList?.contains?.('is-empty'));
    patchClasses(multiPanelEl, { 'is-empty': isEmpty });
    patchAttr(multiRunningMetaEl, 'hidden', isEmpty);
    if (!isEmpty) {
      const isPureSwarm = runningSubCount > 0 && runningSwarmCount === runningSubCount;
      patchText(
        multiRunningMetaEl,
        runningSubCount > 0
          ? t(isPureSwarm ? 'multi.metaWithSwarm' : 'multi.metaWithSubs', {
              main: runningCount,
              subs: runningSubCount,
            })
          : t('multi.metaMainOnly', { main: runningCount })
      );
    }
    patchAttr(multiEmptyEl, 'hidden', !isEmpty);
    if (!multiOpen || document.hidden) {
      multiRunningWidget.refs.pauseTicker();
      return;
    }
    multiRunningWidget.refs.update({
      items: rawRunningList,
      hostRouteConversationId,
    });
    if (wasEmpty !== isEmpty) {
      positionFloatingElements();
    }
  }

  function renderHoverWidgets() {
    const { telemetry, minuteTick } = telemetryStore.getState();
    hoverWidgetHost.update({
      moduleKeys: normalizeClientHoverModules(telemetry?.settings?.hoverModules),
      data: telemetry,
      minuteTick: Number(minuteTick || Math.floor(Date.now() / 30000)),
    });
  }

  // --- 4. 实时遥测状态绑定（双胶囊与多会话/动态组件浮层就地更新，零硬编码、零布局跳动） ---
  function renderCapsuleTelemetry() {
    if (disposed) return;
    const telSt = telemetryStore.getState();
    const uiSt = uiStore.getState();
    const telemetry = telSt.telemetry;

    setI18nLanguage(telemetry?.settings?.language);
    syncPortalAppearance(telemetry?.settings);
    syncCapsuleOsAttr();

    const slotKeys = normalizeClientTopbarSlots(telemetry?.settings?.topbarCapsuleSlots);

    if (!telemetry) {
      lastRunningCount = 0;
      const showMulti = resolveEffectiveShowMulti(null, 0);
      patchAttr(multiBtn, 'hidden', !showMulti);
      patchAttr(capsuleHost, 'data-multi', showMulti ? 'on' : 'off');
      if (!showMulti && multiOpen) {
        setMultiOpen(false);
      }
      if (showMulti !== lastShowMulti || slotKeys.length !== lastSlotCount) {
        lastShowMulti = showMulti;
        lastSlotCount = slotKeys.length;
        updateResponsiveLayout();
      }
      patchClasses(multiBtn, { 'is-running': false, 'is-waiting': false });
      patchCapsuleOdometerText(multiLabel, t('capsule.multiZero'), { resetKey: 'multi' });
      patchClasses(multiPanelEl, { 'is-empty': true });
      patchAttr(multiRunningMetaEl, 'hidden', false);
      patchText(multiRunningMetaEl, t('multi.loading'));
      patchAttr(multiEmptyEl, 'hidden', false);
      multiRunningWidget.refs.stopLiveTicker();

      applyCapsuleSlots(slotKeys, { hasTelemetry: false });
      return;
    }

    const overlayCtxAgentId = resolveOverlayCtxInspectorAgentId(
      telemetry,
      uiSt.ctxInspectorAgentId
    );
    const { agents, scopedConv: overviewScopedConv, ctxAgent, aggregated } =
      resolveScopedConversation(telemetry, 'all', overlayCtxAgentId);
    const { scopedConv: capsuleScopedConv } = resolveScopedConversation(
      telemetry,
      uiSt.selectedAgentScope,
      overlayCtxAgentId
    );
    const overviewActive = overviewScopedConv || telemetry.activeConversation || {};
    const slotCtx = buildCapsuleSlotContext(telemetry, {
      scopedConv: capsuleScopedConv,
      overviewConv: overviewActive,
      ctxAgent,
      aggregated,
    });
    const {
      rawRunningList,
      runningCount,
      runningSubCount,
      runningSwarmCount,
      hasWaiting,
      multiBtnText,
    } = resolveMultiSessionCapsuleState(telemetry, {
      agents,
      aggregated,
      latestTokPerSec: overviewActive.latestTokPerSec ?? null,
      contextUsedPct: slotCtx.usedPct,
    });

    lastRunningCount = runningCount;
    const showMulti = resolveEffectiveShowMulti(telemetry, runningCount);
    patchAttr(multiBtn, 'hidden', !showMulti);
    patchAttr(capsuleHost, 'data-multi', showMulti ? 'on' : 'off');
    if (!showMulti && multiOpen) {
      setMultiOpen(false);
    }

    const layoutInputsChanged =
      showMulti !== lastShowMulti || slotKeys.length !== lastSlotCount;
    if (layoutInputsChanged) {
      lastShowMulti = showMulti;
      lastSlotCount = slotKeys.length;
      updateResponsiveLayout();
    }

    patchClasses(multiBtn, {
      'is-running': runningCount > 0 && !hasWaiting,
      'is-waiting': runningCount > 0 && hasWaiting,
    });
    patchCapsuleOdometerText(multiLabel, multiBtnText, { resetKey: 'multi' });

    renderMultiRunningPanel(
      rawRunningList,
      runningCount,
      runningSubCount,
      telSt.hostRouteConversationId,
      runningSwarmCount
    );

    patchClasses(capsuleBtn, { 'is-running': slotCtx.isRunning });
    applyCapsuleSlots(slotKeys, slotCtx);

    const updateMode = normalizeClientUpdateMode(
      telemetry.settings?.pluginUpdateMode,
      telemetry.settings?.autoUpdatePlugin
    );
    const showUpdatePrompt =
      Boolean(telemetry.cloudStatus?.updateAvailable) && updateMode !== 'off';
    const latestVer = telemetry.cloudStatus?.latestPluginVersion || '';
    patchAttr(updateDot, 'hidden', !showUpdatePrompt);
    patchAttr(topbarUpdateBtn, 'hidden', !showUpdatePrompt);
    patchAttr(hoverUpdateBar, 'hidden', !showUpdatePrompt);
    if (showUpdatePrompt) {
      if (!isTopbarUpdating) {
        patchText(topbarUpdateLabel, latestVer ? `v${latestVer}` : t('capsule.newVersion'));
      }
      patchAttr(topbarUpdateBtn, 'title', t('capsule.ariaUpdateTitle'));
      patchText(
        hoverUpdateVerText,
        latestVer
          ? t('capsule.hoverNewVer', { ver: latestVer })
          : t('capsule.hoverNewVerGeneric')
      );
      const isComposerDock = capsuleHost.getAttribute('data-dock') === 'composer';
      patchText(
        hoverUpdateHintText,
        latestVer
          ? isComposerDock
            ? t('capsule.hoverUpdateHintComposer', { ver: latestVer })
            : t('capsule.hoverUpdateHintTopbar', { ver: latestVer })
          : isComposerDock
            ? t('capsule.hoverUpdateHintComposerGeneric')
            : t('capsule.hoverUpdateHintTopbarGeneric')
      );
    }
    if (showUpdatePrompt !== lastShowUpdate) {
      lastShowUpdate = showUpdatePrompt;
      updateResponsiveLayout();
    }

    // --- 同步动态悬停组件宿主（0 项且无更新提示时自动关闭悬停窗，点击完整浮窗不受影响） ---
    const hoverModuleKeys = normalizeClientHoverModules(telemetry.settings?.hoverModules);
    patchAttr(hoverWidgetsContainer, 'hidden', hoverModuleKeys.length === 0);
    if (hoverModuleKeys.length === 0 && !showUpdatePrompt && tooltipOpen) {
      setTooltipOpen(false);
    }
    if (tooltipOpen) {
      renderHoverWidgets();
      positionFloatingElements();
    }
  }

  let lastAppliedMountMode = normalizeClientWindowMountMode(
    telemetryStore.getState().telemetry?.settings?.windowMountMode,
    telemetryStore.getState().telemetry?.settings?.enableWindowOverlay
  );

  const unsubStore = telemetryStore.subscribe(
    (st) => ({
      syncState: st.syncState,
      telemetry: st.telemetry,
      minuteTick: st.minuteTick,
      selectedConversationId: st.selectedConversationId,
    }),
    (slice) => {
      const nextMountMode = normalizeClientWindowMountMode(
        slice.telemetry?.settings?.windowMountMode,
        slice.telemetry?.settings?.enableWindowOverlay
      );
      if (slice.telemetry?.settings?.enableWindowOverlay === false || nextMountMode === 'sidebar') {
        if (popoverOpen) setPopoverOpen(false);
        if (multiOpen) setMultiOpen(false);
      } else if (nextMountMode !== lastAppliedMountMode) {
        lastAppliedMountMode = nextMountMode;
        ensureCapsuleDocked();
      }
      lastAppliedMountMode = nextMountMode;
      renderCapsuleTelemetry();
      if (popoverOpen) {
        positionFloatingElements();
        schedulePopoverLayoutSync();
      }
    }
  );

  const unsubUiScope = uiStore.subscribe(
    (st) => ({
      selectedAgentScope: st.selectedAgentScope,
      ctxInspectorAgentId: st.ctxInspectorAgentId,
      activeView: st.activeView,
      stepsSubTab: st.stepsSubTab,
      settingsSubTab: st.settingsSubTab,
      settingsStructureTab: st.settingsStructureTab,
    }),
    () => {
      renderCapsuleTelemetry();
      if (popoverOpen) {
        positionFloatingElements();
        schedulePopoverLayoutSync();
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => {
            if (!disposed && popoverOpen) {
              positionFloatingElements();
              refreshActiveViewScrollbars();
            }
          });
        }
      }
    }
  );

  const unsubI18n = i18nStore.subscribe(
    (st) => st.locale,
    () => {
      patchAttr(multiBtn, 'aria-label', t('capsule.ariaMulti'));
      patchAttr(capsuleBtn, 'aria-label', t('capsule.ariaMonitor'));
      patchAttr(topbarUpdateBtn, 'aria-label', t('capsule.ariaUpdateTitle'));
      patchAttr(topbarUpdateBtn, 'title', t('capsule.ariaUpdateTitle'));
      patchAttr(multiPanelEl, 'aria-label', t('multi.ariaDialog'));
      patchAttr(popoverEl, 'aria-label', t('capsule.ariaMonitor'));
      patchText(multiPinBadge, t('multi.pinned'));
      patchText(multiEmptyTextEl, t('multi.empty'));
      patchText(multiTitleTextEl, t('multi.title'));
      renderCapsuleTelemetry();
    }
  );

  // --- 5. 宿主会话路由跟随与全局交互监听 ---
  function syncHostRouteIfChanged() {
    if (disposed) return;
    const currentRouteId = extractHostRouteCascadeId();
    if (currentRouteId === lastObservedRouteId) return;
    lastObservedRouteId = currentRouteId;
    const st = telemetryStore.getState();
    const activeCascadeId = String(st.telemetry?.activeConversation?.cascadeId || '').trim();
    const isSameActiveRoot =
      Boolean(activeCascadeId) &&
      Boolean(currentRouteId) &&
      currentRouteId.toLowerCase() === activeCascadeId.toLowerCase();
    const isChildOfActiveRoot =
      Boolean(currentRouteId) &&
      Boolean(resolveHostRouteMatch(st.telemetry, currentRouteId)?.isChildRoute);
    const shouldPreserveSameSession =
      !currentRouteId || isSameActiveRoot || isChildOfActiveRoot;
    const nextSelectedId =
      currentRouteId && st.selectedConversationId && st.selectedConversationId !== currentRouteId
        ? ''
        : st.selectedConversationId;
    if (!shouldPreserveSameSession) {
      uiStore.setState({
        selectedAgentScope: 'all',
        ctxInspectorAgentId: getDefaultCtxInspectorAgentId(st.telemetry?.settings),
      });
    }
    void selectConversation(nextSelectedId, { hostRouteConversationId: currentRouteId });
  }

  const onDocMouseDown = (e) => {
    if (popoverOpen && !isEventInside(e, popoverEl) && !isEventInside(e, capsuleHost)) {
      setPopoverOpen(false);
    }
    if (multiOpen && !isEventInside(e, multiPanelEl) && !isEventInside(e, capsuleHost)) {
      setMultiOpen(false);
    }
  };

  const onDocKeyDown = (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      if (popoverOpen) {
        setPopoverOpen(false);
      }
      if (multiOpen) {
        setMultiOpen(false);
      }
    }
  };

  const onWindowPointerMove = (e) => recordPointerCoords(e);
  const onWindowBlur = () => {
    hasPointerCoords = false;
    if (tooltipOpen) {
      setTooltipOpen(false);
    }
    if (multiOpen && !multiPinned) {
      setMultiOpen(false);
    }
  };
  const onWindowResize = () => updateResponsiveLayout();
  const onPopState = () => syncHostRouteIfChanged();
  const onDocFocusIn = () => syncHostRouteIfChanged();
  const onVisibilityChange = () => {
    if (document.hidden) {
      uiStore.setState({ monitorVisible: false });
      multiRunningWidget.refs.pauseTicker();
      hasPointerCoords = false;
      if (tooltipOpen) {
        setTooltipOpen(false);
      }
      if (multiOpen && !multiPinned) {
        setMultiOpen(false);
      }
      return;
    }
    if (!document.hidden && !disposed) {
      uiStore.setState({ monitorVisible: popoverOpen });
      if (multiOpen) renderCapsuleTelemetry();
      syncHostRouteIfChanged();
      void fetchTelemetry({ force: false });
    }
  };

  let hostDomObserver = null;
  let hostDomRafId = 0;
  let hostDomMicrotaskPending = false;
  function flushHostDomMutationCheck() {
    if (disposed) return;
    syncHostRouteIfChanged();
    if (!observedWorkbench) {
      ensureWorkbenchThemeObserved();
    }
    const dock = resolveRuntimeDockTarget();
    if (!isDockPlacementSynced(dock)) {
      scheduleDockSync();
    }
  }
  function scheduleHostDomMutationCheck() {
    if (disposed) return;
    const rafFn =
      (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame.bind(window)
        : null) || (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null);
    if (rafFn) {
      if (hostDomRafId) return;
      hostDomRafId = rafFn(() => {
        hostDomRafId = 0;
        flushHostDomMutationCheck();
      });
      return;
    }
    if (hostDomMicrotaskPending) return;
    hostDomMicrotaskPending = true;
    queueMicrotask(() => {
      hostDomMicrotaskPending = false;
      flushHostDomMutationCheck();
    });
  }
  try {
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => updateResponsiveLayout());
      if (document.body) resizeObserver.observe(document.body);
    }
    if (typeof MutationObserver !== 'undefined') {
      themeObserver = new MutationObserver(() => {
        syncWorkbenchThemeVars();
        syncPortalAppearance(telemetryStore.getState().telemetry?.settings);
      });
      if (document.head) {
        themeObserver.observe(document.head, {
          childList: true,
          characterData: true,
          subtree: true,
        });
      }
      if (document.documentElement) {
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme', 'data-vscode-theme-kind'],
        });
      }
      if (document.body) {
        themeObserver.observe(document.body, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme', 'data-vscode-theme-kind'],
        });
      }
      if (document.body) {
        hostDomObserver = new MutationObserver((records) => {
          if (
            Array.isArray(records) &&
            records.length > 0 &&
            records.every((r) => r?.target === capsuleHost || r?.target === portalHost)
          ) {
            return;
          }
          scheduleHostDomMutationCheck();
        });
        hostDomObserver.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-cascade-id', 'data-selected'],
        });
      }
    }
  } catch {
    // 忽略观察器初始化异常
  }

  document.addEventListener?.('mousedown', onDocMouseDown, true);
  document.addEventListener?.('keydown', onDocKeyDown);
  document.addEventListener?.('focusin', onDocFocusIn);
  document.addEventListener?.('visibilitychange', onVisibilityChange);
  window.addEventListener?.('pointermove', onWindowPointerMove, { passive: true });
  window.addEventListener?.('blur', onWindowBlur);
  window.addEventListener?.('resize', onWindowResize);
  window.addEventListener?.('popstate', onPopState);
  navigator?.windowControlsOverlay?.addEventListener?.('geometrychange', onWindowResize);

  const watchdogTimer = setInterval(() => {
    if (disposed) return;
    syncHostRouteIfChanged();
    ensureWorkbenchThemeObserved();
    const dock = resolveRuntimeDockTarget();
    if (!isDockPlacementSynced(dock)) {
      ensureCapsuleDocked();
    }
  }, 1200);

  ensureCapsuleDocked();
  renderCapsuleTelemetry();
  const allowMultiCarryOver = !multiBtn.hasAttribute('hidden');
  if (carryOverPopoverOpen) {
    setPopoverOpen(true, { instant: true });
  } else if (carryOverMultiPinnedOpen && allowMultiCarryOver) {
    setMultiOpen(true, { pinned: true, instant: true });
  } else if (carryOverMultiHoverOpen && allowMultiCarryOver) {
    setMultiOpen(true, { pinned: false, instant: true });
  } else if (carryOverTooltipOpen) {
    setTooltipOpen(true, { instant: true });
  }
  const stopPolling = startAsyncTelemetryLoop(2000);

  const handle = {
    bundleVersion,
    [WINDOW_OVERLAY_METHODS.ensureAlive]() {
      if (disposed) return false;
      return ensureCapsuleDocked();
    },
    [WINDOW_OVERLAY_METHODS.syncHostRoute]() {
      if (disposed) return false;
      syncHostRouteIfChanged();
      return true;
    },
    [WINDOW_OVERLAY_METHODS.updateBridge](nextBridge) {
      if (disposed || !nextBridge || typeof nextBridge !== 'object') return false;
      const port = Number(nextBridge.port || 0);
      const token = String(nextBridge.token || '');
      if (!Number.isInteger(port) || port <= 0 || !token) return false;
      const cur = readInjectedWindowBridge() || {};
      const prevEndpointId = String(cur[WINDOW_BRIDGE_ENDPOINT_KEY] || LOCAL_ENDPOINT_ID);
      const nextEndpointId =
        nextBridge[WINDOW_BRIDGE_ENDPOINT_KEY] !== undefined
          ? String(nextBridge[WINDOW_BRIDGE_ENDPOINT_KEY] || LOCAL_ENDPOINT_ID)
          : prevEndpointId;
      const portChanged = Number(cur.port || 0) !== port || String(cur.token || '') !== token;
      const endpointChanged = prevEndpointId !== nextEndpointId;
      cur.port = port;
      cur.token = token;
      cur[WINDOW_BRIDGE_ENDPOINT_KEY] = nextEndpointId;
      if (nextBridge.isRemoteEndpoint !== undefined) {
        cur.isRemoteEndpoint = Boolean(nextBridge.isRemoteEndpoint);
      }
      if (nextBridge.endpointLabel !== undefined) {
        cur.endpointLabel = String(nextBridge.endpointLabel || '');
      }
      if (portChanged || endpointChanged) {
        cur.transportMode = 'http';
      }
      if (endpointChanged) {
        if (Array.isArray(cur.rpcQueue)) {
          cur.rpcQueue.length = 0;
        }
        if (cur.rpcPending instanceof Map) {
          for (const pending of cur.rpcPending.values()) {
            try {
              const switchErr = new Error('Bridge endpoint switched');
              switchErr.name = 'AbortError';
              pending?.reject?.(switchErr);
            } catch {
              // 忽略旧端点回调异常
            }
          }
          cur.rpcPending.clear();
        }
      }
      window[WINDOW_BRIDGE_KEY] = cur;
      if (endpointChanged) {
        resetTelemetryForEndpointSwitch();
        void fetchTelemetry({ force: true });
      } else {
        void fetchTelemetry({ force: false });
      }
      return true;
    },
    getTelemetrySnapshot() {
      return telemetryStore.getState().telemetry;
    },
    getLastPointer() {
      return hasPointerCoords ? { x: lastPointerX, y: lastPointerY } : null;
    },
    [WINDOW_OVERLAY_METHODS.deliverRpc](responses) {
      if (disposed) return 0;
      return deliverCdpBridgeResponses(responses);
    },
    open() {
      setPopoverOpen(true);
    },
    close() {
      setPopoverOpen(false);
    },
    toggle() {
      setPopoverOpen(!popoverOpen);
    },
    openMulti(pinned = true) {
      setMultiOpen(true, { pinned: Boolean(pinned) });
    },
    closeMulti() {
      setMultiOpen(false);
    },
    isOpen: () => popoverOpen,
    isHoverOpen: () => tooltipOpen,
    isMultiOpen: () => multiOpen,
    isMultiHoverOpen: () => Boolean(multiOpen && !multiPinned),
    isMultiPinnedOpen: () => Boolean(multiOpen && multiPinned),
    getLayoutMode: () => layoutMode,
    [WINDOW_OVERLAY_METHODS.getDockKind]: () => String(capsuleHost.getAttribute('data-dock') || ''),
    [WINDOW_OVERLAY_METHODS.getMountMode]: () => lastAppliedMountMode,
    [WINDOW_OVERLAY_METHODS.applyMountMode](nextMode) {
      if (disposed) return false;
      const normalized = normalizeClientWindowMountMode(nextMode, nextMode !== 'sidebar');
      const bridgeConfig = readInjectedWindowBridge();
      if (bridgeConfig) bridgeConfig.mountMode = normalized;
      const curTel = telemetryStore.getState().telemetry;
      if (curTel?.settings) {
        telemetryStore.setState({
          telemetry: {
            ...curTel,
            settings: {
              ...curTel.settings,
              windowMountMode: normalized,
              enableWindowOverlay: normalized !== 'sidebar',
            },
          },
        });
      }
      lastAppliedMountMode = normalized;
      return ensureCapsuleDocked();
    },
    [WINDOW_OVERLAY_METHODS.dispose]() {
      if (disposed) return;
      disposed = true;
      clearInterval(watchdogTimer);
      if (hoverLeaveTimer) {
        clearTimeout(hoverLeaveTimer);
        hoverLeaveTimer = null;
      }
      if (multiLeaveTimer) {
        clearTimeout(multiLeaveTimer);
        multiLeaveTimer = null;
      }
      multiRunningWidget.refs.stopLiveTicker();
      if (dockRafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(dockRafId);
        dockRafId = 0;
      }
      if (hostDomRafId) {
        const cancelRaf =
          (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function'
            ? window.cancelAnimationFrame.bind(window)
            : null) || (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null);
        cancelRaf?.(hostDomRafId);
        hostDomRafId = 0;
      }
      stopPolling();
      stopAsyncTelemetryLoop();
      unsubStore();
      unsubUiScope();
      unsubI18n();
      try {
        resizeObserver?.disconnect();
      } catch {}
      try {
        hostDomObserver?.disconnect();
      } catch {}
      try {
        themeObserver?.disconnect();
      } catch {}
      document.removeEventListener?.('mousedown', onDocMouseDown, true);
      document.removeEventListener?.('keydown', onDocKeyDown);
      document.removeEventListener?.('focusin', onDocFocusIn);
      document.removeEventListener?.('visibilitychange', onVisibilityChange);
      popoverEl.removeEventListener?.('animationend', onPopoverAnimationEnd);
      window.removeEventListener?.('pointermove', onWindowPointerMove);
      window.removeEventListener?.('blur', onWindowBlur);
      window.removeEventListener?.('resize', onWindowResize);
      window.removeEventListener?.('popstate', onPopState);
      navigator?.windowControlsOverlay?.removeEventListener?.('geometrychange', onWindowResize);
      restorePatchedActionToolbar();
      try {
        multiRunningWidget.destroy();
      } catch {}
      try {
        hoverWidgetHost.destroy();
      } catch {}
      try {
        appInstance?.destroy?.();
      } catch {}
      try {
        capsuleHost.remove();
      } catch {}
      try {
        portalHost.remove();
      } catch {}
      if (window[WINDOW_OVERLAY_KEY] === handle) {
        delete window[WINDOW_OVERLAY_KEY];
      }
    },
  };

  window[WINDOW_OVERLAY_KEY] = handle;
  return handle;
}
