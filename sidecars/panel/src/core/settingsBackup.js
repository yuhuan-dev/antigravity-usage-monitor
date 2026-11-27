/**
 * @fileoverview 偏好设置便携 JSON 备份及恢复工具 (`settingsBackup.js`).
 * 通过单一声明式字段描述符表同时驱动导出与导入归一化，消除双遍手写 30 个键的漏同步风险。
 */

import { normalizeDisplayCurrency } from '../../shared/currency-catalog.mjs';
import {
  deriveMetricCardStyleFromLayout,
  normalizeAccountQuotaRefreshMinutes,
  normalizeAutoConfigureLaunch,
  normalizeCliStatusLineSlots,
  normalizeContextAgentMode,
  normalizeEnableRemoteSshTelemetry,
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
  normalizeStandalonePort,
  normalizeStepTableColumns,
  normalizeStepTokenComboFormat,
  normalizeThemeAccent,
  normalizeTopbarCapsuleSlots,
  normalizeTopbarMultiSessionMode,
  normalizeWeeklyLimitMode,
  normalizeWindowMountMode,
} from '../../shared/settings-normalization.mjs';

const SETTINGS_BACKUP_SCHEMA = 'antigravity-usage-monitor.settings';
const MAX_SETTINGS_IMPORT_BYTES = 128 * 1024;

function sanitizePositiveBudgetNum(val) {
  const num = Number(val);
  return Number.isFinite(num) && num > 0 ? num : null;
}

/**
 * 在浏览器端通过内存 Blob 触发文件下载（统一承载文本与二进制载荷）。
 *
 * @param {string} filename
 * @param {BlobPart} blobPart
 * @param {string} [mimeType]
 * @returns {boolean}
 */
export function triggerBlobDownload(
  filename,
  blobPart,
  mimeType = 'application/octet-stream'
) {
  try {
    if (
      typeof Blob === 'undefined' ||
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function' ||
      typeof document === 'undefined'
    ) {
      return false;
    }
    const blob = new Blob([blobPart], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.setAttribute('href', url);
    a.setAttribute('download', String(filename || 'export.dat'));
    a.style.display = 'none';
    document.body?.appendChild?.(a);
    a.click?.();
    a.remove?.();
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {}
    }, 1000);
    return true;
  } catch {
    return false;
  }
}

/**
 * 在浏览器端通过内存 Blob 触发文本文件下载。
 *
 * @param {string} filename
 * @param {string} content
 * @param {string} [mimeType]
 * @returns {boolean}
 */
export function triggerTextFileDownload(
  filename,
  content,
  mimeType = 'application/json;charset=utf-8'
) {
  return triggerBlobDownload(
    String(filename || 'export.json'),
    String(content ?? ''),
    mimeType
  );
}

const normField = (key, normalizeFn) => ({
  exportTo: (src, out) => {
    out[key] = normalizeFn(src[key]);
  },
  importTo: (src, hasKey, patch) => {
    if (hasKey(key)) patch[key] = normalizeFn(src[key]);
  },
});

const boolField = (key, defaultVal) => ({
  exportTo: (src, out) => {
    out[key] = defaultVal ? src[key] !== false : src[key] === true;
  },
  importTo: (src, hasKey, patch) => {
    if (hasKey(key) && typeof src[key] === 'boolean') patch[key] = src[key];
  },
});

const arrayField = (key, normalizeFn) => ({
  exportTo: (src, out) => {
    out[key] = normalizeFn(src[key]);
  },
  importTo: (src, hasKey, patch) => {
    if (hasKey(key) && Array.isArray(src[key])) patch[key] = normalizeFn(src[key]);
  },
});

const positiveBudgetField = (key, fallbackVal) => ({
  exportTo: (src, out) => {
    out[key] = sanitizePositiveBudgetNum(src[key]) ?? fallbackVal;
  },
  importTo: (src, hasKey, patch) => {
    if (hasKey(key)) {
      const num = sanitizePositiveBudgetNum(src[key]);
      if (num !== null) patch[key] = num;
    }
  },
});

const PORTABLE_SETTING_DESCRIPTORS = Object.freeze([
  normField('language', normalizeLanguageSetting),
  normField('displayCurrency', normalizeDisplayCurrency),
  normField('themeAccent', normalizeThemeAccent),
  normField('fontScale', normalizeFontScale),
  {
    exportTo: (src, out) => {
      out.modernUi = src.modernUi !== undefined ? normalizeModernUi(src.modernUi) : true;
    },
    importTo: (src, hasKey, patch) => {
      if (hasKey('modernUi')) {
        const val = normalizeModernUi(src.modernUi);
        patch.modernUi = val;
        patch.experimentalModernUi = val;
      }
    },
  },
  normField('weeklyLimitMode', normalizeWeeklyLimitMode),
  positiveBudgetField('weeklyTokenBudget', 150000000),
  positiveBudgetField('weeklyCostBudget', 100),
  {
    exportTo: (src, out) => {
      const mode = normalizeModelDisplayMode(src.modelDisplayMode, src.showUpstreamModel);
      out.modelDisplayMode = mode;
      out.showUpstreamModel = mode !== 'short';
    },
    importTo: (src, hasKey, patch) => {
      if (hasKey('modelDisplayMode') || hasKey('showUpstreamModel')) {
        const mode = normalizeModelDisplayMode(src.modelDisplayMode, src.showUpstreamModel);
        patch.modelDisplayMode = mode;
        patch.showUpstreamModel = mode !== 'short';
      }
    },
  },
  {
    exportTo: (src, out) => {
      out.pluginUpdateMode = normalizePluginUpdateMode(src.pluginUpdateMode, src.autoUpdatePlugin);
    },
    importTo: (src, hasKey, patch) => {
      if (hasKey('pluginUpdateMode') || hasKey('autoUpdatePlugin')) {
        const mode = normalizePluginUpdateMode(src.pluginUpdateMode, src.autoUpdatePlugin);
        patch.pluginUpdateMode = mode;
        patch.autoUpdatePlugin = mode === 'auto';
      }
    },
  },
  {
    exportTo: (src, out) => {
      out.windowMountMode = normalizeWindowMountMode(src.windowMountMode, src.enableWindowOverlay);
    },
    importTo: (src, hasKey, patch) => {
      if (hasKey('windowMountMode') || hasKey('enableWindowOverlay')) {
        const mode = normalizeWindowMountMode(src.windowMountMode, src.enableWindowOverlay);
        patch.windowMountMode = mode;
        patch.enableWindowOverlay = mode !== 'sidebar';
      }
    },
  },
  normField('popoverWidthMode', normalizePopoverWidthMode),
  normField('popoverWidth', normalizePopoverWidth),
  boolField('enableCliStatusLine', true),
  normField('cliStatusLineSlots', normalizeCliStatusLineSlots),
  normField('standalonePort', normalizeStandalonePort),
  normField('autoConfigureLaunch', normalizeAutoConfigureLaunch),
  normField('enableRemoteSshTelemetry', normalizeEnableRemoteSshTelemetry),
  {
    exportTo: (src, out) => {
      const mode = normalizeTopbarMultiSessionMode(
        src.topbarMultiSessionMode,
        src.showTopbarMultiSession
      );
      out.topbarMultiSessionMode = mode;
      out.showTopbarMultiSession = mode !== 'hide';
    },
    importTo: (src, hasKey, patch) => {
      if (hasKey('topbarMultiSessionMode') || hasKey('showTopbarMultiSession')) {
        const mode = normalizeTopbarMultiSessionMode(
          src.topbarMultiSessionMode,
          src.showTopbarMultiSession
        );
        patch.topbarMultiSessionMode = mode;
        patch.showTopbarMultiSession = mode !== 'hide';
      }
    },
  },
  normField('contextAgentMode', normalizeContextAgentMode),
  arrayField('topbarCapsuleSlots', normalizeTopbarCapsuleSlots),
  arrayField('hoverModules', normalizeHoverModules),
  boolField('hoverSyncOverviewMetrics', true),
  {
    exportTo: (src, out) => {
      const metrics = normalizeHoverMetrics(src.hoverMetrics);
      const hasExplicit =
        src.hoverMetricRows !== undefined || src.hoverMetricSizes !== undefined;
      const rows = normalizeHoverMetricRows(
        src.hoverMetricRows,
        hasExplicit ? undefined : src.hoverMetricStyle
      );
      const sizes = normalizeHoverMetricSizes(
        src.hoverMetricSizes,
        metrics,
        hasExplicit ? undefined : src.hoverMetricStyle
      );
      out.hoverMetricStyle = deriveMetricCardStyleFromLayout(rows, metrics, sizes);
      out.hoverMetricRows = rows;
      out.hoverMetricSizes = sizes;
      out.hoverMetricTextMode = normalizeHoverMetricTextMode(src.hoverMetricTextMode);
      out.hoverMetrics = metrics;
    },
    importTo: (src, hasKey, patch) => {
      const hasMetrics = hasKey('hoverMetrics') && Array.isArray(src.hoverMetrics);
      const hasRows = hasKey('hoverMetricRows');
      const hasSizes =
        hasKey('hoverMetricSizes') &&
        src.hoverMetricSizes &&
        typeof src.hoverMetricSizes === 'object' &&
        !Array.isArray(src.hoverMetricSizes);
      const hasStyle = hasKey('hoverMetricStyle');
      if (hasKey('hoverMetricTextMode')) {
        patch.hoverMetricTextMode = normalizeHoverMetricTextMode(src.hoverMetricTextMode);
      }
      if (hasMetrics) {
        patch.hoverMetrics = normalizeHoverMetrics(src.hoverMetrics);
      }
      if (hasRows || hasSizes) {
        const rows = hasRows
          ? normalizeHoverMetricRows(src.hoverMetricRows)
          : undefined;
        const sizes = hasSizes
          ? normalizeHoverMetricSizes(src.hoverMetricSizes)
          : undefined;
        if (rows !== undefined) patch.hoverMetricRows = rows;
        if (sizes !== undefined) patch.hoverMetricSizes = sizes;
        if (rows !== undefined && sizes !== undefined) {
          patch.hoverMetricStyle = deriveMetricCardStyleFromLayout(
            rows,
            patch.hoverMetrics || normalizeHoverMetrics(src.hoverMetrics),
            sizes
          );
        }
      } else if (hasStyle) {
        const style = normalizeHoverMetricStyle(src.hoverMetricStyle);
        const metrics = patch.hoverMetrics || normalizeHoverMetrics(src.hoverMetrics);
        patch.hoverMetricStyle = style;
        patch.hoverMetricRows = normalizeHoverMetricRows(undefined, style);
        patch.hoverMetricSizes = normalizeHoverMetricSizes(undefined, metrics, style);
      }
    },
  },
  arrayField('overviewModules', normalizeOverviewModules),
  {
    exportTo: (src, out) => {
      const metrics = normalizeOverviewMetrics(src.overviewMetrics);
      const hasExplicit =
        src.overviewMetricRows !== undefined || src.overviewMetricSizes !== undefined;
      const rows = normalizeOverviewMetricRows(
        src.overviewMetricRows,
        hasExplicit ? undefined : src.overviewMetricStyle
      );
      const sizes = normalizeOverviewMetricSizes(
        src.overviewMetricSizes,
        metrics,
        hasExplicit ? undefined : src.overviewMetricStyle
      );
      out.overviewMetricStyle = deriveMetricCardStyleFromLayout(rows, metrics, sizes);
      out.overviewMetricRows = rows;
      out.overviewMetricSizes = sizes;
      out.overviewMetricTextMode = normalizeOverviewMetricTextMode(src.overviewMetricTextMode);
      out.overviewMetrics = metrics;
    },
    importTo: (src, hasKey, patch) => {
      const hasMetrics = hasKey('overviewMetrics') && Array.isArray(src.overviewMetrics);
      const hasRows = hasKey('overviewMetricRows');
      const hasSizes =
        hasKey('overviewMetricSizes') &&
        src.overviewMetricSizes &&
        typeof src.overviewMetricSizes === 'object' &&
        !Array.isArray(src.overviewMetricSizes);
      const hasStyle = hasKey('overviewMetricStyle');
      if (hasKey('overviewMetricTextMode')) {
        patch.overviewMetricTextMode = normalizeOverviewMetricTextMode(src.overviewMetricTextMode);
      }
      if (hasMetrics) {
        patch.overviewMetrics = normalizeOverviewMetrics(src.overviewMetrics);
      }
      if (hasRows || hasSizes) {
        const rows = hasRows
          ? normalizeOverviewMetricRows(src.overviewMetricRows)
          : undefined;
        const sizes = hasSizes
          ? normalizeOverviewMetricSizes(src.overviewMetricSizes)
          : undefined;
        if (rows !== undefined) patch.overviewMetricRows = rows;
        if (sizes !== undefined) patch.overviewMetricSizes = sizes;
        if (rows !== undefined && sizes !== undefined) {
          patch.overviewMetricStyle = deriveMetricCardStyleFromLayout(
            rows,
            patch.overviewMetrics || normalizeOverviewMetrics(src.overviewMetrics),
            sizes
          );
        }
      } else if (hasStyle) {
        const style = normalizeOverviewMetricStyle(src.overviewMetricStyle);
        const metrics = patch.overviewMetrics || normalizeOverviewMetrics(src.overviewMetrics);
        patch.overviewMetricStyle = style;
        patch.overviewMetricRows = normalizeOverviewMetricRows(undefined, style);
        patch.overviewMetricSizes = normalizeOverviewMetricSizes(undefined, metrics, style);
      }
    },
  },
  normField('quotaDisplayMode', normalizeQuotaDisplayMode),
  boolField('showStepTurnRail', false),
  boolField('showStepAgentBadge', true),
  boolField('showStepSpeedColor', false),
  boolField('showStepFilterToolbar', false),
  normField('stepTokenComboFormat', normalizeStepTokenComboFormat),
  arrayField('stepTableColumns', normalizeStepTableColumns),
  normField('experimentalQuotaReservation', normalizeExperimentalQuotaReservation),
  normField('accountQuotaRefreshMinutes', normalizeAccountQuotaRefreshMinutes),
]);

/**
 * 将当前用户偏好设置序列化为跨设备可迁移的安全 JSON 备份文本（仅包含便携偏好项，不包含凭证或高风险覆盖开关）。
 *
 * @param {object} [settings={}]
 * @returns {string}
 */
export function buildExportableSettingsJson(settings = {}) {
  const src = settings && typeof settings === 'object' ? settings : {};
  const outSettings = {};
  for (const desc of PORTABLE_SETTING_DESCRIPTORS) {
    desc.exportTo(src, outSettings);
  }
  const payload = {
    schema: SETTINGS_BACKUP_SCHEMA,
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: outSettings,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * 校验并解析导入的偏好设置 JSON，仅提取并归一化白名单内的便携配置项。
 *
 * @param {string} rawText
 * @returns {{ ok: true, patch: object, appliedCount: number } | { ok: false, errorCode: string }}
 */
export function parseImportedSettingsJson(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim() || rawText.length > MAX_SETTINGS_IMPORT_BYTES) {
    return { ok: false, errorCode: 'invalid_json' };
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, errorCode: 'invalid_json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errorCode: 'invalid_json' };
  }

  const hasWrappedSettings =
    parsed.settings && typeof parsed.settings === 'object' && !Array.isArray(parsed.settings);
  if (parsed.schema !== undefined && parsed.schema !== SETTINGS_BACKUP_SCHEMA) {
    return { ok: false, errorCode: 'invalid_schema' };
  }
  const src = hasWrappedSettings ? parsed.settings : parsed;
  const hasKey = (k) => Object.prototype.hasOwnProperty.call(src, k);
  const patch = {};

  for (const desc of PORTABLE_SETTING_DESCRIPTORS) {
    desc.importTo(src, hasKey, patch);
  }

  const appliedCount = Object.keys(patch).length;
  if (appliedCount === 0) {
    return { ok: false, errorCode: 'empty_patch' };
  }
  return { ok: true, patch, appliedCount };
}
