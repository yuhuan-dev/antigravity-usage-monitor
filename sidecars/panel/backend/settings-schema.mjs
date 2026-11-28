/**
 * @fileoverview 用户偏好设置完整 Schema、默认对象工厂与带上下文窗口校验的整表归一化器。
 *
 * 所有跨端通用枚举与单项纯函数归一化规则统一源自 `../shared/settings-normalization.mjs`。
 */

import { isContextWindowSettingId, isContextWindowOption } from './context-windows.mjs';
import {
  DEFAULT_DISPLAY_CURRENCY,
  SUPPORTED_DISPLAY_CURRENCIES,
  normalizeDisplayCurrency,
} from '../shared/currency-catalog.mjs';
import {
  ACCOUNT_QUOTA_REFRESH_MINUTES,
  CLI_STATUSLINE_PRESETS,
  CONTEXT_AGENT_MODES,
  DEFAULT_ACCOUNT_QUOTA_REFRESH_MINUTES,
  DEFAULT_CLI_STATUSLINE_SLOTS,
  DEFAULT_CONTEXT_AGENT_MODE,
  DEFAULT_ENABLE_SAFETY_MONITOR,
  DEFAULT_HOVER_METRICS,
  DEFAULT_HOVER_METRIC_ROWS,
  DEFAULT_HOVER_METRIC_SIZES,
  DEFAULT_HOVER_METRIC_STYLE,
  DEFAULT_HOVER_METRIC_TEXT_MODE,
  DEFAULT_HOVER_MODULES,
  DEFAULT_HOVER_SYNC_OVERVIEW_METRICS,
  DEFAULT_METRIC_ROWS,
  DEFAULT_METRIC_TEXT_MODE,
  DEFAULT_OVERVIEW_METRICS,
  DEFAULT_OVERVIEW_METRIC_ROWS,
  DEFAULT_OVERVIEW_METRIC_SIZES,
  DEFAULT_OVERVIEW_METRIC_STYLE,
  DEFAULT_OVERVIEW_METRIC_TEXT_MODE,
  DEFAULT_OVERVIEW_MODULES,
  DEFAULT_POPOVER_WIDTH,
  DEFAULT_QUOTA_DISPLAY_MODE,
  DEFAULT_STEP_TABLE_COLUMNS,
  DEFAULT_STEP_TOKEN_COMBO_FORMAT,
  DEFAULT_TOPBAR_MULTI_SESSION_MODE,
  DEFAULT_TOPBAR_SLOTS,
  DEFAULT_VSCODE_MOUNT_MODE,
  FONT_SCALE_KEYS,
  HOVER_METRIC_STYLES,
  MAX_CLI_STATUSLINE_SLOTS,
  MAX_LARGE_METRIC_SLOTS,
  MAX_OVERVIEW_METRICS,
  MAX_POPOVER_WIDTH,
  MAX_TOPBAR_SLOTS,
  METRIC_CARD_SIZES,
  METRIC_CARD_STYLES,
  METRIC_GRID_COLS,
  METRIC_GRID_ROWS,
  METRIC_TEXT_MODES,
  MIN_CLI_STATUSLINE_SLOTS,
  MIN_POPOVER_WIDTH,
  MIN_TOPBAR_SLOTS,
  OVERVIEW_METRIC_KEYS,
  OVERVIEW_MODULE_KEYS,
  POPOVER_WIDTH_MODES,
  QUOTA_DISPLAY_MODES,
  STEP_TABLE_COLUMN_KEYS,
  STEP_TOKEN_SEGMENT_ALIASES,
  SUPPORTED_LANGUAGES,
  THEME_ACCENT_KEYS,
  TOPBAR_MULTI_SESSION_MODES,
  TOPBAR_SLOT_KEYS,
  VSCODE_MOUNT_MODES,
  deriveMetricCardStyleFromLayout,
  isAccountSwitchFeatureActive,
  isContextWindowFeatureActive,
  isRiskyFeaturesGateOpen,
  isTopbarMultiSessionVisible,
  normalizeAccountQuotaRefreshMinutes,
  normalizeAutoConfigureLaunch,
  normalizeCliStatusLineSlots,
  normalizeContextAgentMode,
  normalizeDeveloperModeEnabled,
  normalizeEnableRemoteSshTelemetry,
  normalizeEnableSafetyMonitor,
  normalizeExperimentalModernUi,
  normalizeExperimentalQuotaReservation,
  normalizeFontScale,
  normalizeHoverMetricRows,
  normalizeHoverMetricSizes,
  normalizeHoverMetricStyle,
  normalizeHoverMetricTextMode,
  normalizeHoverMetrics,
  normalizeHoverModules,
  normalizeHoverSyncOverviewMetrics,
  normalizeLanguageSetting,
  normalizeMetricCardSize,
  normalizeMetricCardSizes,
  normalizeMetricCardStyle,
  normalizeMetricGridRows,
  normalizeMetricTextMode,
  normalizeModelDisplayMode,
  normalizeModernUi,
  normalizeOverviewMetricRows,
  normalizeOverviewMetricSizes,
  normalizeOverviewMetricStyle,
  normalizeOverviewMetricTextMode,
  normalizeOverviewMetrics,
  normalizeOverviewModules,
  normalizePluginUpdateMode,
  normalizePopoverWidth,
  normalizePopoverWidthMode,
  normalizeQuotaDisplayMode,
  normalizeRiskyFeaturesEnabled,
  normalizeStandalonePort,
  normalizeStepTableColumns,
  normalizeStepTokenComboFormat,
  normalizeThemeAccent,
  normalizeTopbarCapsuleSlots,
  normalizeTopbarMultiSessionMode,
  normalizeVsCodeMountMode,
  normalizeWeeklyLimitMode,
  normalizeWindowMountMode,
  packMetricBentoLayout,
  parseStepTokenComboSegments,
  resolveEffectiveCliStatusLineSlots,
  resolveEffectiveMetricMatrixConfig,
} from '../shared/settings-normalization.mjs';

export {
  ACCOUNT_QUOTA_REFRESH_MINUTES,
  CLI_STATUSLINE_PRESETS,
  CONTEXT_AGENT_MODES,
  DEFAULT_ACCOUNT_QUOTA_REFRESH_MINUTES,
  DEFAULT_CLI_STATUSLINE_SLOTS,
  DEFAULT_CONTEXT_AGENT_MODE,
  DEFAULT_DISPLAY_CURRENCY,
  DEFAULT_ENABLE_SAFETY_MONITOR,
  DEFAULT_HOVER_METRICS,
  DEFAULT_HOVER_METRIC_ROWS,
  DEFAULT_HOVER_METRIC_SIZES,
  DEFAULT_HOVER_METRIC_STYLE,
  DEFAULT_HOVER_METRIC_TEXT_MODE,
  DEFAULT_HOVER_MODULES,
  DEFAULT_HOVER_SYNC_OVERVIEW_METRICS,
  DEFAULT_METRIC_ROWS,
  DEFAULT_METRIC_TEXT_MODE,
  DEFAULT_OVERVIEW_METRICS,
  DEFAULT_OVERVIEW_METRIC_ROWS,
  DEFAULT_OVERVIEW_METRIC_SIZES,
  DEFAULT_OVERVIEW_METRIC_STYLE,
  DEFAULT_OVERVIEW_METRIC_TEXT_MODE,
  DEFAULT_OVERVIEW_MODULES,
  DEFAULT_POPOVER_WIDTH,
  DEFAULT_QUOTA_DISPLAY_MODE,
  DEFAULT_STEP_TABLE_COLUMNS,
  DEFAULT_STEP_TOKEN_COMBO_FORMAT,
  DEFAULT_TOPBAR_MULTI_SESSION_MODE,
  DEFAULT_TOPBAR_SLOTS,
  DEFAULT_VSCODE_MOUNT_MODE,
  FONT_SCALE_KEYS,
  HOVER_METRIC_STYLES,
  MAX_CLI_STATUSLINE_SLOTS,
  MAX_LARGE_METRIC_SLOTS,
  MAX_OVERVIEW_METRICS,
  MAX_POPOVER_WIDTH,
  MAX_TOPBAR_SLOTS,
  METRIC_CARD_SIZES,
  METRIC_CARD_STYLES,
  METRIC_GRID_COLS,
  METRIC_GRID_ROWS,
  METRIC_TEXT_MODES,
  MIN_CLI_STATUSLINE_SLOTS,
  MIN_POPOVER_WIDTH,
  MIN_TOPBAR_SLOTS,
  OVERVIEW_METRIC_KEYS,
  OVERVIEW_MODULE_KEYS,
  POPOVER_WIDTH_MODES,
  QUOTA_DISPLAY_MODES,
  STEP_TABLE_COLUMN_KEYS,
  STEP_TOKEN_SEGMENT_ALIASES,
  SUPPORTED_DISPLAY_CURRENCIES,
  SUPPORTED_LANGUAGES,
  THEME_ACCENT_KEYS,
  TOPBAR_MULTI_SESSION_MODES,
  TOPBAR_SLOT_KEYS,
  VSCODE_MOUNT_MODES,
  deriveMetricCardStyleFromLayout,
  isAccountSwitchFeatureActive,
  isContextWindowFeatureActive,
  isRiskyFeaturesGateOpen,
  isTopbarMultiSessionVisible,
  normalizeAccountQuotaRefreshMinutes,
  normalizeAutoConfigureLaunch,
  normalizeCliStatusLineSlots,
  normalizeContextAgentMode,
  normalizeDeveloperModeEnabled,
  normalizeDisplayCurrency,
  normalizeEnableRemoteSshTelemetry,
  normalizeEnableSafetyMonitor,
  normalizeExperimentalModernUi,
  normalizeExperimentalQuotaReservation,
  normalizeFontScale,
  normalizeHoverMetricRows,
  normalizeHoverMetricSizes,
  normalizeHoverMetricStyle,
  normalizeHoverMetricTextMode,
  normalizeHoverMetrics,
  normalizeHoverModules,
  normalizeHoverSyncOverviewMetrics,
  normalizeLanguageSetting,
  normalizeMetricCardSize,
  normalizeMetricCardSizes,
  normalizeMetricCardStyle,
  normalizeMetricGridRows,
  normalizeMetricTextMode,
  normalizeModelDisplayMode,
  normalizeModernUi,
  normalizeOverviewMetricRows,
  normalizeOverviewMetricSizes,
  normalizeOverviewMetricStyle,
  normalizeOverviewMetricTextMode,
  normalizeOverviewMetrics,
  normalizeOverviewModules,
  normalizePluginUpdateMode,
  normalizePopoverWidth,
  normalizePopoverWidthMode,
  normalizeQuotaDisplayMode,
  normalizeRiskyFeaturesEnabled,
  normalizeStandalonePort,
  normalizeStepTableColumns,
  normalizeStepTokenComboFormat,
  normalizeThemeAccent,
  normalizeTopbarCapsuleSlots,
  normalizeTopbarMultiSessionMode,
  normalizeVsCodeMountMode,
  normalizeWeeklyLimitMode,
  normalizeWindowMountMode,
  packMetricBentoLayout,
  parseStepTokenComboSegments,
  resolveEffectiveCliStatusLineSlots,
  resolveEffectiveMetricMatrixConfig,
};

function isSchemaPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function schemaSanitizePositiveNum(val, fallback) {
  const num = Number(val);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

export function normalizeModelContextWindows(value) {
  return Object.fromEntries(
    Object.entries(isSchemaPlainObject(value) ? value : {}).filter(
      ([id, option]) => isContextWindowSettingId(id) && isContextWindowOption(option)
    )
  );
}

export const DEFAULT_SETTINGS_SCHEMA = Object.freeze({
  language: 'auto',
  displayCurrency: DEFAULT_DISPLAY_CURRENCY,
  themeAccent: 'host',
  fontScale: 'md',
  modernUi: true,
  experimentalModernUi: true,
  weeklyTokenBudget: 150000000,
  weeklyCostBudget: 100,
  weeklyLimitMode: 'official',
  modelDisplayMode: 'short',
  showUpstreamModel: false,
  pluginUpdateMode: 'manual',
  autoUpdatePlugin: false,
  windowMountMode: 'dual',
  vsCodeMountMode: DEFAULT_VSCODE_MOUNT_MODE,
  enableWindowOverlay: true,
  popoverWidthMode: 'auto',
  popoverWidth: DEFAULT_POPOVER_WIDTH,
  enableCliStatusLine: true,
  cliStatusLineSlots: null,
  standalonePort: 0,
  autoConfigureLaunch: true,
  enableRemoteSshTelemetry: true,
  enableSafetyMonitor: DEFAULT_ENABLE_SAFETY_MONITOR,
  topbarMultiSessionMode: DEFAULT_TOPBAR_MULTI_SESSION_MODE,
  showTopbarMultiSession: true,
  contextAgentMode: DEFAULT_CONTEXT_AGENT_MODE,
  topbarCapsuleSlots: DEFAULT_TOPBAR_SLOTS,
  hoverModules: DEFAULT_HOVER_MODULES,
  hoverSyncOverviewMetrics: DEFAULT_HOVER_SYNC_OVERVIEW_METRICS,
  hoverMetricStyle: DEFAULT_HOVER_METRIC_STYLE,
  hoverMetricRows: DEFAULT_HOVER_METRIC_ROWS,
  hoverMetricSizes: DEFAULT_HOVER_METRIC_SIZES,
  hoverMetricTextMode: DEFAULT_HOVER_METRIC_TEXT_MODE,
  hoverMetrics: DEFAULT_HOVER_METRICS,
  overviewModules: DEFAULT_OVERVIEW_MODULES,
  overviewMetricStyle: DEFAULT_OVERVIEW_METRIC_STYLE,
  overviewMetricRows: DEFAULT_OVERVIEW_METRIC_ROWS,
  overviewMetricSizes: DEFAULT_OVERVIEW_METRIC_SIZES,
  overviewMetricTextMode: DEFAULT_OVERVIEW_METRIC_TEXT_MODE,
  overviewMetrics: DEFAULT_OVERVIEW_METRICS,
  quotaDisplayMode: DEFAULT_QUOTA_DISPLAY_MODE,
  showStepTurnRail: false,
  showStepAgentBadge: true,
  showStepSpeedColor: false,
  showStepFilterToolbar: false,
  stepTokenComboFormat: DEFAULT_STEP_TOKEN_COMBO_FORMAT,
  stepTableColumns: DEFAULT_STEP_TABLE_COLUMNS,
  experimentalQuotaReservation: true,
  accountQuotaRefreshMinutes: DEFAULT_ACCOUNT_QUOTA_REFRESH_MINUTES,
  developerModeEnabled: false,
  riskyFeaturesEnabled: false,
  accountSwitchRiskAccepted: false,
  contextWindowRiskAccepted: false,
  contextWindowMainEnabled: true,
  contextWindowSwarmEnabled: false,
  modelContextWindows: Object.freeze({}),
});

/**
 * 创建一份深拷贝的全新默认偏好设置对象。
 */
export function createDefaultSettingsObject() {
  return {
    ...DEFAULT_SETTINGS_SCHEMA,
    topbarCapsuleSlots: [...DEFAULT_TOPBAR_SLOTS],
    hoverModules: [...DEFAULT_HOVER_MODULES],
    hoverMetricSizes: {},
    hoverMetrics: [...DEFAULT_HOVER_METRICS],
    overviewModules: [...DEFAULT_OVERVIEW_MODULES],
    overviewMetricSizes: {},
    overviewMetrics: [...DEFAULT_OVERVIEW_METRICS],
    stepTableColumns: [...DEFAULT_STEP_TABLE_COLUMNS],
    modelContextWindows: {},
  };
}

/**
 * 将原始持久化对象或增量合并结果完整归一化为合法偏好对象。
 *
 * @param {unknown} rawInput
 */
export function normalizeFullSettings(rawInput) {
  const safeRaw = isSchemaPlainObject(rawInput) ? rawInput : {};
  const pluginUpdateMode = normalizePluginUpdateMode(
    safeRaw.pluginUpdateMode,
    safeRaw.autoUpdatePlugin
  );
  const windowMountMode = normalizeWindowMountMode(
    safeRaw.windowMountMode,
    safeRaw.enableWindowOverlay
  );
  const modelDisplayMode = normalizeModelDisplayMode(
    safeRaw.modelDisplayMode,
    safeRaw.showUpstreamModel
  );
  const topbarMultiSessionMode = normalizeTopbarMultiSessionMode(
    safeRaw.topbarMultiSessionMode,
    safeRaw.showTopbarMultiSession
  );
  const modernUi =
    safeRaw.modernUi !== undefined ? normalizeModernUi(safeRaw.modernUi) : true;
  const developerModeEnabled = normalizeDeveloperModeEnabled(safeRaw.developerModeEnabled);
  const riskyFeaturesEnabled = normalizeRiskyFeaturesEnabled(
    safeRaw.riskyFeaturesEnabled,
    developerModeEnabled
  );
  const hoverMetrics = normalizeHoverMetrics(
    safeRaw.hoverMetrics !== undefined
      ? safeRaw.hoverMetrics
      : Array.isArray(safeRaw.hoverLargeMetrics)
        ? [...safeRaw.hoverLargeMetrics, ...DEFAULT_HOVER_METRICS]
        : undefined
  );
  const hasExplicitHoverBento =
    safeRaw.hoverMetricRows !== undefined || safeRaw.hoverMetricSizes !== undefined;
  const hoverMetricRows = normalizeHoverMetricRows(
    safeRaw.hoverMetricRows,
    hasExplicitHoverBento ? undefined : safeRaw.hoverMetricStyle
  );
  const hoverMetricSizes = normalizeHoverMetricSizes(
    safeRaw.hoverMetricSizes,
    hoverMetrics,
    hasExplicitHoverBento ? undefined : safeRaw.hoverMetricStyle
  );
  const hoverMetricStyle = deriveMetricCardStyleFromLayout(
    hoverMetricRows,
    hoverMetrics,
    hoverMetricSizes
  );
  const hoverMetricTextMode = normalizeHoverMetricTextMode(safeRaw.hoverMetricTextMode);
  const overviewMetrics = normalizeOverviewMetrics(safeRaw.overviewMetrics);
  const hasExplicitOverviewBento =
    safeRaw.overviewMetricRows !== undefined || safeRaw.overviewMetricSizes !== undefined;
  const overviewMetricRows = normalizeOverviewMetricRows(
    safeRaw.overviewMetricRows,
    hasExplicitOverviewBento ? undefined : safeRaw.overviewMetricStyle
  );
  const overviewMetricSizes = normalizeOverviewMetricSizes(
    safeRaw.overviewMetricSizes,
    overviewMetrics,
    hasExplicitOverviewBento ? undefined : safeRaw.overviewMetricStyle
  );
  const overviewMetricStyle = deriveMetricCardStyleFromLayout(
    overviewMetricRows,
    overviewMetrics,
    overviewMetricSizes
  );
  const overviewMetricTextMode = normalizeOverviewMetricTextMode(safeRaw.overviewMetricTextMode);
  return {
    language: normalizeLanguageSetting(safeRaw.language),
    displayCurrency: normalizeDisplayCurrency(safeRaw.displayCurrency),
    themeAccent: normalizeThemeAccent(safeRaw.themeAccent),
    fontScale: normalizeFontScale(safeRaw.fontScale),
    modernUi,
    experimentalModernUi: modernUi,
    weeklyTokenBudget: schemaSanitizePositiveNum(
      safeRaw.weeklyTokenBudget ?? safeRaw.weeklyTokenLimit,
      DEFAULT_SETTINGS_SCHEMA.weeklyTokenBudget
    ),
    weeklyCostBudget: schemaSanitizePositiveNum(
      safeRaw.weeklyCostBudget,
      DEFAULT_SETTINGS_SCHEMA.weeklyCostBudget
    ),
    weeklyLimitMode: normalizeWeeklyLimitMode(safeRaw.weeklyLimitMode),
    modelDisplayMode,
    showUpstreamModel: modelDisplayMode !== 'short',
    pluginUpdateMode,
    autoUpdatePlugin: pluginUpdateMode === 'auto',
    windowMountMode,
    vsCodeMountMode: normalizeVsCodeMountMode(safeRaw.vsCodeMountMode),
    enableWindowOverlay: windowMountMode !== 'sidebar',
    popoverWidthMode: normalizePopoverWidthMode(safeRaw.popoverWidthMode),
    popoverWidth: normalizePopoverWidth(safeRaw.popoverWidth),
    enableCliStatusLine: safeRaw.enableCliStatusLine !== false,
    cliStatusLineSlots: normalizeCliStatusLineSlots(safeRaw.cliStatusLineSlots),
    standalonePort: normalizeStandalonePort(safeRaw.standalonePort),
    autoConfigureLaunch: normalizeAutoConfigureLaunch(safeRaw.autoConfigureLaunch),
    enableRemoteSshTelemetry: normalizeEnableRemoteSshTelemetry(safeRaw.enableRemoteSshTelemetry),
    enableSafetyMonitor: normalizeEnableSafetyMonitor(safeRaw.enableSafetyMonitor),
    topbarMultiSessionMode,
    showTopbarMultiSession: topbarMultiSessionMode !== 'hide',
    contextAgentMode: normalizeContextAgentMode(safeRaw.contextAgentMode),
    topbarCapsuleSlots: normalizeTopbarCapsuleSlots(safeRaw.topbarCapsuleSlots),
    hoverModules: normalizeHoverModules(safeRaw.hoverModules),
    hoverSyncOverviewMetrics: normalizeHoverSyncOverviewMetrics(safeRaw.hoverSyncOverviewMetrics),
    hoverMetricStyle,
    hoverMetricRows,
    hoverMetricSizes,
    hoverMetricTextMode,
    hoverMetrics,
    overviewModules: normalizeOverviewModules(safeRaw.overviewModules),
    overviewMetricStyle,
    overviewMetricRows,
    overviewMetricSizes,
    overviewMetricTextMode,
    overviewMetrics,
    quotaDisplayMode: normalizeQuotaDisplayMode(safeRaw.quotaDisplayMode),
    showStepTurnRail: safeRaw.showStepTurnRail === true,
    showStepAgentBadge: safeRaw.showStepAgentBadge !== false,
    showStepSpeedColor: safeRaw.showStepSpeedColor === true,
    showStepFilterToolbar: safeRaw.showStepFilterToolbar === true,
    stepTokenComboFormat: normalizeStepTokenComboFormat(safeRaw.stepTokenComboFormat),
    stepTableColumns: normalizeStepTableColumns(safeRaw.stepTableColumns),
    experimentalQuotaReservation: normalizeExperimentalQuotaReservation(
      safeRaw.experimentalQuotaReservation
    ),
    accountQuotaRefreshMinutes: normalizeAccountQuotaRefreshMinutes(
      safeRaw.accountQuotaRefreshMinutes
    ),
    developerModeEnabled,
    riskyFeaturesEnabled,
    accountSwitchRiskAccepted: riskyFeaturesEnabled && safeRaw.accountSwitchRiskAccepted === true,
    contextWindowRiskAccepted: riskyFeaturesEnabled && safeRaw.contextWindowRiskAccepted === true,
    contextWindowMainEnabled: safeRaw.contextWindowMainEnabled !== false,
    contextWindowSwarmEnabled: riskyFeaturesEnabled && safeRaw.contextWindowSwarmEnabled === true,
    modelContextWindows: normalizeModelContextWindows(safeRaw.modelContextWindows),
  };
}
