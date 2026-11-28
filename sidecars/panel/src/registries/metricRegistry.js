/**
 * @fileoverview Decoupled Metric Registry (`metricRegistry.js`).
 * Centralizes presentation & option metadata for:
 * 1. Topbar / Composer Capsule Slots (1..5 items out of 13 metrics)
 * 2. Live Overview / Hover First-Row Metric Matrix (1..4 items out of 9 metrics)
 */

import {
  formatAgentBadgeText,
  formatCachePct,
  formatMetric,
  formatQuotaPoolLabel,
  formatTokens,
  formatUsd,
  getCacheToneClass,
  getSpeedToneClass,
  getStepCostToneClass,
  getTtftToneClass,
  resolveModelDisplayInfo,
  sampleSummary,
  speedReasonText,
} from '../core/formatters.js';
import { t } from '../i18n/index.js';
import {
  OVERVIEW_METRIC_KEYS,
  TOPBAR_SLOT_KEYS,
} from '../../shared/settings-normalization.mjs';
import {
  formatCompactCapsuleCost,
  formatCompactCapsuleTtft,
  hasArgonWeeklyQuotaPool,
  resolveCapsuleQuotaSlotPct,
} from '../../shared/telemetry-display-rules.mjs';

export {
  OVERVIEW_METRIC_KEYS,
  formatCompactCapsuleCost,
  formatCompactCapsuleTtft,
  hasArgonWeeklyQuotaPool,
};
export const CAPSULE_METRIC_KEYS = TOPBAR_SLOT_KEYS;

export function getCapsuleMetricOptions({ quotas = null, selectedSlots = [] } = {}) {
  const showArgonWeekly =
    hasArgonWeeklyQuotaPool(quotas) ||
    (Array.isArray(selectedSlots) && selectedSlots.includes('argon_weekly'));
  return CAPSULE_METRIC_KEYS.filter((key) => key !== 'argon_weekly' || showArgonWeekly).map(
    (key) => ({
      value: key,
      label: t(`capMetric.${key}`),
    })
  );
}

export function getOverviewMetricOptions() {
  return OVERVIEW_METRIC_KEYS.map((key) => ({
    value: key,
    label: t(`ovMetric.${key}`),
  }));
}

/**
 * 将格式化后的指标文本拆分为主体数值与尾随单位（如 `'68.4 tok/s'` → `{ main: '68.4', unit: 'tok/s' }`），
 * 便于大尺寸趋势卡片将数值加粗放大、单位轻量化排版。
 *
 * @param {string} valueText
 * @returns {{ main: string, unit: string }}
 */
export function splitMetricValueAndUnit(valueText) {
  const str = String(valueText ?? '—').trim();
  if (!str) return { main: '—', unit: '' };
  const match = str.match(/^([+-]?\$?[\d.,]+[kKmMbB]?)(?:\s*(tok\/s|t\/s|ms|s|%))$/);
  if (match) {
    return { main: match[1], unit: match[2] };
  }
  return { main: str, unit: '' };
}

const SPARKLINE_DEFAULT_WIDTH_BY_COLS = Object.freeze({ 1: 248, 2: 136, 3: 74 });
const SPARKLINE_DEFAULT_HEIGHT = 34;
const SPARKLINE_MIN_WIDTH = 28;
const SPARKLINE_MAX_WIDTH = 640;
const SPARKLINE_MIN_HEIGHT = 24;
const SPARKLINE_MAX_HEIGHT = 120;
const SPARKLINE_PAD_X = 4;
const SPARKLINE_TARGET_PITCH_PX = 7.5;
const SPARKLINE_MIN_POINTS = 5;
const SPARKLINE_MAX_POINTS = 48;

/**
 * 根据折线容器实际可用像素宽高，自适应计算 SVG 画布尺寸、采样步数上限与笔触粗细：
 * - 保持约 7.5px / 步的均衡节奏：极窄 3 列悬浮卡收敛为 5~7 步避免锯齿拥挤，
 *   宽卡 / 单列 / 宽屏面板则平滑扩展至最多 48 步以展示更长趋势；
 * - 支持按容器实测高度自适应拉伸纵轴（宽卡满高、2×2 大卡随隐藏标题/副标自动舒展），
 * - 未挂载或无法测宽时（如首帧 / 无头测试）按列数回退至默认基准尺寸。
 *
 * @param {number} [availableWidth]
 * @param {number} [colCount=3]
 * @param {number} [availableHeight=0]
 */
export function resolveAdaptiveSparklineSpec(availableWidth, colCount = 3, availableHeight = 0) {
  const safeCols = colCount === 1 || colCount === 2 ? colCount : 3;
  const fallbackWidth = SPARKLINE_DEFAULT_WIDTH_BY_COLS[safeCols];
  const rawWidth = Number(availableWidth);
  const width =
    Number.isFinite(rawWidth) && rawWidth > 0
      ? Math.max(SPARKLINE_MIN_WIDTH, Math.min(SPARKLINE_MAX_WIDTH, Math.round(rawWidth)))
      : fallbackWidth;
  const rawHeight = Number(availableHeight);
  const height =
    Number.isFinite(rawHeight) && rawHeight > 0
      ? Math.max(SPARKLINE_MIN_HEIGHT, Math.min(SPARKLINE_MAX_HEIGHT, Math.round(rawHeight)))
      : SPARKLINE_DEFAULT_HEIGHT;
  const plotWidth = Math.max(8, width - SPARKLINE_PAD_X * 2);
  const maxPoints = Math.max(
    SPARKLINE_MIN_POINTS,
    Math.min(SPARKLINE_MAX_POINTS, Math.floor(plotWidth / SPARKLINE_TARGET_PITCH_PX) + 1)
  );
  return {
    width,
    height,
    maxPoints,
    strokeWidth: width < 64 ? '1.5' : width < 100 ? '1.55' : height >= 56 ? '1.8' : '1.65',
    dotRadius: width < 64 ? '2.25' : width < 100 ? '2.5' : height >= 56 ? '3' : '2.75',
  };
}

/**
 * 从 `recentSteps`（默认按时间倒序）提取指定指标的时间顺序序列（从旧到新，最多取末 `maxPoints` 点），
 * 用于驱动悬浮窗大尺寸实时指标卡片右侧的迷你走势折线图。
 *
 * @param {string} metricKey
 * @param {Array<Record<string, any>>} [steps=[]]
 * @param {{ maxPoints?: number, limitTokens?: number }} [options]
 * @returns {number[]}
 */
export function extractOverviewMetricSeries(
  metricKey,
  steps = [],
  { maxPoints = 16, limitTokens = 256000 } = {}
) {
  if (!Array.isArray(steps) || steps.length === 0) return [];
  const cap = Math.max(2, Number(maxPoints) || 16);
  const safeLimit = Number(limitTokens) > 0 ? Number(limitTokens) : 256000;
  const series = [];

  if (metricKey === 'avg_tps') {
    let sum = 0;
    let count = 0;
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      const v = Number(steps[i]?.tokPerSec);
      if (Number.isFinite(v) && v > 0) {
        sum += v;
        count += 1;
        series.push(+(sum / count).toFixed(2));
      }
    }
    return series.slice(-cap);
  }

  if (metricKey === 'session_cost') {
    let acc = 0;
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      const raw = steps[i]?.costUsd;
      if (raw != null && Number.isFinite(Number(raw)) && Number(raw) >= 0) {
        acc += Number(raw);
        series.push(+acc.toFixed(4));
      }
    }
    return series.slice(-cap);
  }

  if (metricKey === 'session_tokens') {
    let acc = 0;
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      const s = steps[i];
      if (!s) continue;
      const inTok = Math.max(0, Number(s.inputTokens || 0));
      const cacheTok = Math.max(0, Number(s.cacheReadTokens || 0));
      const outTok = Math.max(0, Number(s.outputTokens || 0));
      const stepTotal = inTok + cacheTok + outTok || Math.max(0, Number(s.contextTokens || 0));
      if (stepTotal > 0) {
        acc += stepTotal;
        series.push(acc);
      }
    }
    return series.slice(-cap);
  }

  // Non-cumulative per-step metrics: collect at most `cap` most recent valid points in O(cap)
  const rev = [];
  for (let i = 0; i < steps.length && rev.length < cap; i += 1) {
    const s = steps[i];
    if (!s) continue;
    let val = null;
    if (metricKey === 'tps') {
      const v = Number(s.tokPerSec);
      if (Number.isFinite(v) && v > 0) val = v;
    } else if (metricKey === 'ttft') {
      if (s.ttftSec != null && Number.isFinite(Number(s.ttftSec)) && Number(s.ttftSec) >= 0) {
        val = Number(s.ttftSec);
      }
    } else if (metricKey === 'step_cost') {
      if (s.costUsd != null && Number.isFinite(Number(s.costUsd)) && Number(s.costUsd) >= 0) {
        val = Number(s.costUsd);
      }
    } else if (metricKey === 'cache_hit') {
      if (
        s.cacheHitPct != null &&
        Number.isFinite(Number(s.cacheHitPct)) &&
        Number(s.cacheHitPct) >= 0
      ) {
        val = Math.min(100, Number(s.cacheHitPct));
      }
    } else if (metricKey === 'context_usage') {
      const v = Number(s.contextTokens);
      if (Number.isFinite(v) && v > 0) {
        val = Math.min(100, +((v / safeLimit) * 100).toFixed(2));
      }
    }
    if (val !== null) rev.push(val);
  }
  rev.reverse();
  return rev;
}

/**
 * 将数值序列映射为轻量迷你折线图 SVG 几何路径（含折线坐标、底部渐变面积闭合路径与末端圆点坐标）。
 *
 * @param {number[]} values
 * @param {{ width?: number, height?: number, padTop?: number, padBottom?: number, padX?: number }} [dims]
 */
export function buildSparklineGeometry(
  values = [],
  { width = 108, height = 34, padTop = 4, padBottom = 5, padX = 4 } = {}
) {
  const pts = Array.isArray(values)
    ? values.map(Number).filter((n) => Number.isFinite(n))
    : [];
  const baselineY = +(height - 2).toFixed(1);
  const plotTop = padTop;
  const plotBottom = height - padBottom;
  const plotH = Math.max(4, plotBottom - plotTop);
  const plotW = Math.max(8, width - padX * 2);

  if (pts.length === 0) {
    return {
      hasLine: false,
      hasDot: false,
      linePoints: '',
      areaPath: '',
      lastX: 0,
      lastY: 0,
      baselineY,
    };
  }

  if (pts.length === 1) {
    const midY = +(plotTop + plotH * 0.5).toFixed(1);
    const startX = +(padX + plotW * 0.52).toFixed(1);
    const endX = +(width - padX).toFixed(1);
    return {
      hasLine: true,
      hasDot: true,
      linePoints: `${startX},${midY} ${endX},${midY}`,
      areaPath: `M ${startX},${midY} L ${endX},${midY} L ${endX},${baselineY} L ${startX},${baselineY} Z`,
      lastX: endX,
      lastY: midY,
      baselineY,
    };
  }

  let min = pts[0];
  let max = pts[0];
  for (let i = 1; i < pts.length; i += 1) {
    if (pts[i] < min) min = pts[i];
    if (pts[i] > max) max = pts[i];
  }
  const span = max - min;
  const coords = [];
  for (let i = 0; i < pts.length; i += 1) {
    const x = +(padX + (i / (pts.length - 1)) * plotW).toFixed(1);
    const y =
      span > 1e-9
        ? +(plotBottom - ((pts[i] - min) / span) * plotH).toFixed(1)
        : +(plotTop + plotH * 0.5).toFixed(1);
    coords.push([x, y]);
  }

  const linePoints = coords.map(([x, y]) => `${x},${y}`).join(' ');
  const first = coords[0];
  const last = coords[coords.length - 1];
  const lineSegments = coords
    .slice(1)
    .map(([x, y]) => `L ${x},${y}`)
    .join(' ');
  const areaPath = `M ${first[0]},${first[1]} ${lineSegments} L ${last[0]},${baselineY} L ${first[0]},${baselineY} Z`;

  return {
    hasLine: true,
    hasDot: true,
    linePoints,
    areaPath,
    lastX: last[0],
    lastY: last[1],
    baselineY,
  };
}

export function resolveQuotaCapsuleSummary(quotas) {
  if (!quotas) return null;
  const activePool = quotas.activePool;
  const weekly = quotas.weekly;
  const pools = Array.isArray(quotas.pools) ? quotas.pools : [];
  const candidates = [];
  const defaultPoolName = t('fmt.activePool');
  const wkTag = t('fmt.weekTag');
  const wkCompact = t('fmt.weekCompact');

  if (activePool && Number.isFinite(Number(activePool.remainingPct))) {
    candidates.push({
      pct: Number(activePool.remainingPct),
      label: formatQuotaPoolLabel(activePool.poolLabel || activePool.family, {
        fallback: defaultPoolName,
      }),
      windowTag: '5h',
    });
  }
  if (activePool && Number.isFinite(Number(activePool.weeklyRemainingPct))) {
    candidates.push({
      pct: Number(activePool.weeklyRemainingPct),
      label: formatQuotaPoolLabel(activePool.poolLabel || activePool.family, {
        fallback: defaultPoolName,
      }),
      windowTag: wkTag,
    });
  }
  if (!candidates.length && weekly && Number.isFinite(Number(weekly.remainingPct))) {
    candidates.push({
      pct: Number(weekly.remainingPct),
      label: formatQuotaPoolLabel(weekly.poolFamily, {
        fallback: t('fmt.weeklyQuota'),
      }),
      windowTag: wkTag,
    });
  }
  if (!candidates.length && pools.length > 0) {
    for (const p of pools) {
      const pLabel = formatQuotaPoolLabel(p?.poolLabel || p?.family, {
        fallback: defaultPoolName,
      });
      if (p && Number.isFinite(Number(p.remainingPct))) {
        candidates.push({ pct: Number(p.remainingPct), label: pLabel, windowTag: '5h' });
      }
      if (p && Number.isFinite(Number(p.weeklyRemainingPct))) {
        candidates.push({ pct: Number(p.weeklyRemainingPct), label: pLabel, windowTag: wkTag });
      }
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.pct - b.pct);
  const tightest = candidates[0];
  const runnerUp = candidates.length > 1 ? candidates[1] : null;
  const rounded = Math.max(0, Math.min(100, Math.round(tightest.pct)));
  const runnerPct = runnerUp ? Math.max(0, Math.min(100, Math.round(runnerUp.pct))) : null;
  const subLabelText = runnerUp
    ? runnerUp.label === tightest.label
      ? `${tightest.label} ${tightest.windowTag} · ${runnerUp.windowTag} ${runnerPct}%`
      : `${tightest.label} ${tightest.windowTag} · ${runnerUp.label} ${runnerUp.windowTag} ${runnerPct}%`
    : `${tightest.label} · ${tightest.windowTag}`;
  const tightestIsClaude = /claude|gpt|fable|oss|third/i.test(String(tightest.label || ''));
  const tightestIsArgon = !tightestIsClaude && /\bargon\b/i.test(String(tightest.label || ''));
  const tightestIsGemini =
    !tightestIsClaude && !tightestIsArgon && /gemini|carbon|neon|flash|pro/i.test(String(tightest.label || ''));
  const tightestWinShort = tightest.windowTag === '5h' ? '5h' : wkCompact;
  const poolPrefix = tightestIsClaude
    ? `C${tightestWinShort}`
    : tightestIsArgon
      ? `A${tightestWinShort}`
      : tightestIsGemini
        ? `G${tightestWinShort}`
        : tightest.windowTag === '5h'
          ? '5h'
          : wkTag;
  return {
    roundedPct: rounded,
    shortText: t('capsule.quotaLeft', { pct: rounded }),
    poolPrefix,
    subLabelText,
    detailText: candidates
      .map((c) => {
        const cPct = Math.max(0, Math.min(100, Math.round(c.pct)));
        return `${c.label} ${c.windowTag} ${t('capsule.quotaLeft', { pct: cPct })}`;
      })
      .join(' · '),
  };
}

function resolveQuotaCapsulePrefix(metricKey, quotaSum) {
  const wkCompact = t('fmt.weekCompact');
  if (metricKey === 'gemini_5h') return 'G5h';
  if (metricKey === 'gemini_weekly') return `G${wkCompact}`;
  if (metricKey === 'argon_weekly') return `A${wkCompact}`;
  if (metricKey === 'claude_5h') return 'C5h';
  if (metricKey === 'claude_weekly') return `C${wkCompact}`;
  if (quotaSum?.poolPrefix) return quotaSum.poolPrefix;
  return t('fmt.quotaPrefix');
}

/**
 * 解析指定模型池（Gemini 或 Claude & GPT）与指定时间窗口（5h 或周额度）的剩余百分比摘要。
 *
 * @param {object|null|undefined} quotas
 * @param {'gemini_5h'|'gemini_weekly'|'claude_5h'|'claude_weekly'} slotKey
 * @returns {{ roundedPct: number, shortText: string } | null}
 */
export function resolveSpecificQuotaSlotSummary(quotas, slotKey) {
  const rounded = resolveCapsuleQuotaSlotPct(quotas, slotKey);
  if (rounded == null) return null;
  return {
    roundedPct: rounded,
    shortText: t('capsule.quotaLeft', { pct: rounded }),
  };
}

/**
 * 解析顶栏/输入框精简胶囊单槽位展示结构。
 *
 * @param {string} metricKey
 * @param {object} slotCtx
 * @param {number} ringCircumference
 */
export function resolveCapsuleMetricPresentation(metricKey, slotCtx, ringCircumference) {
  if (!metricKey || metricKey === 'none') {
    return {
      hidden: true,
      metric: 'none',
      segClass: 'wm-cap-slot',
      textClass: 'wm-slot-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: '',
      toneClass: '',
      running: false,
      warn: false,
      danger: false,
    };
  }

  if (metricKey === 'context') {
    if (!slotCtx.hasTelemetry) {
      return {
        hidden: false,
        metric: 'context',
        segClass: 'wm-cap-slot wm-ctx-seg',
        textClass: 'wm-slot-text wm-ctx-pct',
        showRing: true,
        dashOffset: ringCircumference,
        text: '--%',
        toneClass: '',
        running: false,
        warn: false,
        danger: false,
      };
    }
    const isDanger = slotCtx.usedPct >= 88;
    const isWarn = !isDanger && slotCtx.usedPct >= 70;
    const toneClass = isDanger ? 'tone-danger' : isWarn ? 'tone-warn' : '';
    return {
      hidden: false,
      metric: 'context',
      segClass: 'wm-cap-slot wm-ctx-seg',
      textClass: 'wm-slot-text wm-ctx-pct',
      showRing: true,
      dashOffset: slotCtx.dashOffset,
      text: `${Math.round(slotCtx.usedPct)}%`,
      toneClass,
      running: false,
      warn: isWarn,
      danger: isDanger,
    };
  }

  if (metricKey === 'tps') {
    if (!slotCtx.hasTelemetry) {
      return {
        hidden: false,
        metric: 'tps',
        segClass: 'wm-cap-slot wm-seg-speed',
        textClass: 'wm-slot-text wm-speed-text',
        showRing: false,
        dashOffset: ringCircumference,
        text: '-- t/s',
        toneClass: '',
        running: false,
        warn: false,
        danger: false,
      };
    }
    const hasValidTps = Number.isFinite(slotCtx.tps) && slotCtx.tps > 0;
    const toneClass = hasValidTps ? getSpeedToneClass(slotCtx.tps) : '';
    const tpsText = hasValidTps
      ? `${slotCtx.tps >= 100 ? Math.round(slotCtx.tps) : slotCtx.tps.toFixed(1)} t/s`
      : slotCtx.isRunning
        ? t('capsule.tpsRunning')
        : t('capsule.tpsIdle');
    return {
      hidden: false,
      metric: 'tps',
      segClass: 'wm-cap-slot wm-seg-speed',
      textClass: 'wm-slot-text wm-speed-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: tpsText,
      toneClass,
      running: Boolean(slotCtx.isRunning),
      warn: toneClass === 'tone-warn',
      danger: toneClass === 'tone-danger',
    };
  }

  if (metricKey === 'avg_tps') {
    const avgVal = slotCtx.hasTelemetry ? slotCtx.avgTps : null;
    const valid = Number.isFinite(avgVal) && avgVal > 0;
    const toneClass = valid ? getSpeedToneClass(avgVal) : '';
    return {
      hidden: false,
      metric: 'avg_tps',
      segClass: 'wm-cap-slot wm-seg-speed',
      textClass: 'wm-slot-text wm-speed-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: valid ? `${avgVal >= 100 ? Math.round(avgVal) : avgVal.toFixed(1)} t/s` : '-- t/s',
      toneClass,
      running: false,
      warn: toneClass === 'tone-warn',
      danger: toneClass === 'tone-danger',
    };
  }

  if (metricKey === 'ttft') {
    const val = slotCtx.hasTelemetry ? slotCtx.ttft : null;
    const valid = val != null && Number.isFinite(Number(val)) && Number(val) >= 0;
    const numVal = valid ? Number(val) : 0;
    const toneClass = valid ? getTtftToneClass(numVal) : '';
    return {
      hidden: false,
      metric: 'ttft',
      segClass: 'wm-cap-slot wm-seg-ttft',
      textClass: 'wm-slot-text wm-ttft-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: valid ? formatCompactCapsuleTtft(numVal) : '--s',
      toneClass,
      running: false,
      warn: toneClass === 'tone-warn',
      danger: toneClass === 'tone-danger',
    };
  }

  if (metricKey === 'cost' || metricKey === 'session_cost') {
    const costVal = !slotCtx.hasTelemetry
      ? null
      : metricKey === 'session_cost'
        ? slotCtx.sessionCost
        : slotCtx.stepCost;
    const toneClass =
      metricKey === 'cost' && slotCtx.hasTelemetry && costVal != null
        ? getStepCostToneClass(costVal)
        : '';
    return {
      hidden: false,
      metric: metricKey,
      segClass: 'wm-cap-slot wm-seg-cost',
      textClass: 'wm-slot-text wm-cost-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: slotCtx.hasTelemetry ? formatCompactCapsuleCost(costVal) : '--',
      toneClass,
      running: false,
      warn: toneClass === 'tone-warn',
      danger: toneClass === 'tone-danger',
    };
  }

  if (metricKey === 'cache_hit') {
    const cachePct = slotCtx.hasTelemetry ? slotCtx.cacheHitPct : null;
    const valid = cachePct != null && Number.isFinite(Number(cachePct));
    const numVal = valid ? Number(cachePct) : 0;
    const toneClass = valid ? getCacheToneClass(numVal, slotCtx.latestPromptTokens) : '';
    return {
      hidden: false,
      metric: 'cache_hit',
      segClass: 'wm-cap-slot wm-seg-cache',
      textClass: 'wm-slot-text wm-cache-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: valid ? `${Math.round(numVal)}%` : '--%',
      toneClass,
      running: false,
      warn: toneClass === 'tone-warn',
      danger: toneClass === 'tone-danger',
    };
  }

  if (metricKey === 'session_tokens') {
    const tokVal = slotCtx.hasTelemetry ? slotCtx.sessionTokens : null;
    const valid = tokVal != null && Number.isFinite(Number(tokVal)) && Number(tokVal) >= 0;
    return {
      hidden: false,
      metric: 'session_tokens',
      segClass: 'wm-cap-slot wm-seg-tokens',
      textClass: 'wm-slot-text wm-tokens-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: valid ? formatTokens(Number(tokVal)) : '--',
      toneClass: '',
      running: false,
      warn: false,
      danger: false,
    };
  }

  if (metricKey === 'argon_weekly' && slotCtx.hasTelemetry && !hasArgonWeeklyQuotaPool(slotCtx.quotas)) {
    return {
      hidden: true,
      metric: 'none',
      segClass: 'wm-cap-slot',
      textClass: 'wm-slot-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: '',
      toneClass: '',
      running: false,
      warn: false,
      danger: false,
    };
  }

  const quotaSum = !slotCtx.hasTelemetry
    ? null
    : metricKey === 'quota_auto'
      ? resolveQuotaCapsuleSummary(slotCtx.quotas)
      : resolveSpecificQuotaSlotSummary(slotCtx.quotas, metricKey);
  const hasQuotaPct = Boolean(quotaSum && Number.isFinite(quotaSum.roundedPct));
  const clampedPct = hasQuotaPct ? Math.max(0, Math.min(100, quotaSum.roundedPct)) : 0;
  const quotaDashOffset = hasQuotaPct
    ? +(ringCircumference * (1 - clampedPct / 100)).toFixed(2)
    : ringCircumference;
  const isDanger = Boolean(hasQuotaPct && clampedPct <= 15);
  const isWarn = Boolean(hasQuotaPct && !isDanger && clampedPct <= 30);
  const toneClass = isDanger ? 'tone-danger' : isWarn ? 'tone-warn' : '';
  return {
    hidden: false,
    metric: metricKey,
    segClass: 'wm-cap-slot wm-seg-quota',
    textClass: 'wm-slot-text wm-quota-text',
    showRing: true,
    ringKind: 'quota',
    ringEmpty: !hasQuotaPct,
    dashOffset: quotaDashOffset,
    prefix: resolveQuotaCapsulePrefix(metricKey, quotaSum),
    text: hasQuotaPct ? `${clampedPct}%` : '--%',
    toneClass,
    running: false,
    warn: isWarn,
    danger: isDanger,
  };
}

function resolveActiveBadgeText(active) {
  if (!active?.activeAgentBadge && !active?.activeAgentKind) return '';
  return formatAgentBadgeText({
    agentKind:
      active.activeAgentKind ||
      (!active.activeAgentId || active.activeAgentId === 'main' ? 'main' : 'subagent'),
    agentOrdinal: Number(active.activeAgentOrdinal || 0),
    isMain: !active.activeAgentId || active.activeAgentId === 'main',
    badgeText: active.activeAgentBadge,
  });
}

/**
 * 解析实时监控第一行矩阵单个单元格的展示数据。
 *
 * @param {string} metricKey
 * @param {{ active?: object, ctx?: object, quotas?: object, settings?: object, hasSubagents?: boolean }} cellCtx
 */
export function resolveOverviewMetricCell(metricKey, cellCtx = {}) {
  const active = cellCtx.active || {};
  const ctx = cellCtx.ctx || active.context || {};
  const quotas = cellCtx.quotas || {};
  const settings = cellCtx.settings || {};
  const hasSubagents = Boolean(cellCtx.hasSubagents);
  const hasAnySteps = Number(active.stepCount || 0) > 0;

  if (metricKey === 'tps') {
    const activeModelDisplay = resolveModelDisplayInfo(active, settings, {
      fallback: t('fmt.unknownModel'),
    }).text;
    const reason = speedReasonText(active.latestSpeedReason);
    const badgeStr = resolveActiveBadgeText(active);
    const modelAndAgent =
      hasSubagents && badgeStr ? `[${badgeStr}] ${activeModelDisplay}` : activeModelDisplay;
    const hasSpeed = Number.isFinite(active.latestTokPerSec) && Number(active.latestTokPerSec) > 0;
    const speedTone = hasAnySteps && hasSpeed ? getSpeedToneClass(active.latestTokPerSec) : '';
    return {
      key: 'tps',
      label: t('ovMetric.tps'),
      icon: 'dot',
      iconSize: 10,
      isPulsing: Boolean(active.isRunning),
      valueText: formatMetric(active.latestTokPerSec, ' tok/s'),
      valueClass: speedTone ? `cell-value ${speedTone}` : 'cell-value',
      subText: reason
        ? !hasSpeed
          ? `${reason} · ${modelAndAgent}`
          : `${modelAndAgent} · ${reason}`
        : modelAndAgent,
      subClass: 'cell-sub',
    };
  }

  if (metricKey === 'ttft') {
    const ttftTone = hasAnySteps ? getTtftToneClass(active.latestTtftSec) : '';
    return {
      key: 'ttft',
      label: t('ovMetric.ttft'),
      icon: 'clock',
      iconSize: 11,
      isPulsing: false,
      valueText: formatMetric(active.latestTtftSec, 's'),
      valueClass: ttftTone ? `cell-value ${ttftTone}` : 'cell-value',
      subText: t('ovMetric.subAvgTtft', {
        val: formatMetric(active.ttftSummary?.avgSec, 's'),
      }),
      subClass: 'cell-sub',
    };
  }

  if (metricKey === 'avg_tps') {
    const hasAvgSpeed = Number.isFinite(active.avgTokPerSec) && Number(active.avgTokPerSec) > 0;
    const avgSpeedTone = hasAnySteps && hasAvgSpeed ? getSpeedToneClass(active.avgTokPerSec) : '';
    return {
      key: 'avg_tps',
      label: t('ovMetric.avg_tps'),
      icon: 'pulse',
      iconSize: 11,
      isPulsing: false,
      valueText: formatMetric(active.avgTokPerSec, ' tok/s'),
      valueClass: avgSpeedTone ? `cell-value ${avgSpeedTone}` : 'cell-value',
      subText: t('ovMetric.subValidSamples', {
        samples: sampleSummary(active.speedSummary),
      }),
      subClass: 'cell-sub',
    };
  }

  if (metricKey === 'step_cost' || metricKey === 'session_cost') {
    const stepCost = active.latestStepCostUsd;
    const sessCost = Number(active.sessionCostUsd || 0);
    const stepCnt = Number(active.stepCount || 0);
    const isAllUnpriced =
      stepCnt > 0 && Number(active.sessionUnpricedCalls || 0) >= stepCnt && !(sessCost > 0);
    const stepCostText =
      !hasAnySteps && stepCost == null ? '—' : formatUsd(stepCost, { precise: true });
    const totalCostText =
      !hasAnySteps && active.sessionCostUsd == null
        ? '—'
        : formatUsd(isAllUnpriced ? null : sessCost, {
            precise: sessCost > 0 && sessCost < 0.1,
          });

    if (metricKey === 'step_cost') {
      const costTone = hasAnySteps ? getStepCostToneClass(stepCost) : '';
      return {
        key: 'step_cost',
        label: t('ovMetric.step_cost'),
        icon: 'bolt',
        iconSize: 11,
        isPulsing: false,
        valueText: stepCostText,
        valueClass: costTone ? `cell-value ${costTone}` : 'cell-value',
        subText: t('ovMetric.subTotalCost', { cost: totalCostText }),
        subClass: 'cell-sub',
      };
    }

    return {
      key: 'session_cost',
      label: t('ovMetric.session_cost'),
      icon: 'bolt',
      iconSize: 11,
      isPulsing: false,
      valueText: totalCostText,
      valueClass: 'cell-value',
      subText: t('ovMetric.subStepCost', { cost: stepCostText }),
      subClass: 'cell-sub',
    };
  }

  if (metricKey === 'cache_hit') {
    const latestCache = active.latestCacheHitPct;
    const avgCache = active.sessionCacheHitPct ?? active.latestCacheHitPct;
    const hasLatest = hasAnySteps && latestCache != null && Number.isFinite(Number(latestCache));
    const hasAvg = hasAnySteps && avgCache != null && Number.isFinite(Number(avgCache));
    const cacheTone = hasLatest ? getCacheToneClass(latestCache, active.latestPromptTokens) : '';
    return {
      key: 'cache_hit',
      label: t('ovMetric.cache_hit'),
      icon: 'layers',
      iconSize: 11,
      isPulsing: false,
      valueText: hasLatest ? formatCachePct(latestCache) : '—',
      valueClass: cacheTone ? `cell-value ${cacheTone}` : 'cell-value',
      subText: t('ovMetric.subAvgCache', {
        val: hasAvg ? formatCachePct(avgCache) : '—',
      }),
      subClass: 'cell-sub',
    };
  }

  if (metricKey === 'session_tokens') {
    const inTok = Math.max(0, Number(active.inputTokens || 0));
    const cacheTok = Math.max(0, Number(active.cacheReadTokens || 0));
    const outTok = Math.max(0, Number(active.outputTokens || 0));
    const totalTok = Math.max(0, Number(active.totalTokens ?? inTok + cacheTok + outTok));
    return {
      key: 'session_tokens',
      label: t('ovMetric.session_tokens'),
      icon: 'chart-bar',
      iconSize: 11,
      isPulsing: false,
      valueText: !hasAnySteps && !totalTok ? '—' : formatTokens(totalTok),
      valueClass: 'cell-value',
      subText: t('ovMetric.subInOutTokens', {
        inTok: formatTokens(inTok + cacheTok),
        outTok: formatTokens(outTok),
      }),
      subClass: 'cell-sub',
    };
  }

  if (metricKey === 'context_usage') {
    const limitTokens = Number(ctx.compactionLimitTokens || ctx.limitTokens || 256000);
    const totalTokens = Number(ctx.totalTokens || 0);
    const usedPct =
      limitTokens > 0 ? Math.min(100, +((totalTokens / limitTokens) * 100).toFixed(1)) : 0;
    const toneCls =
      usedPct >= 88
        ? 'cell-value tone-danger'
        : usedPct >= 70
          ? 'cell-value tone-warn'
          : 'cell-value';
    return {
      key: 'context_usage',
      label: t('ovMetric.context_usage'),
      icon: 'layers',
      iconSize: 11,
      isPulsing: false,
      valueText: `${usedPct}%`,
      valueClass: toneCls,
      subText: t('ovMetric.subCtxRatio', {
        used: formatTokens(totalTokens),
        limit: formatTokens(limitTokens),
      }),
      subClass: 'cell-sub',
    };
  }

  const quotaSum = resolveQuotaCapsuleSummary(quotas);
  const quotaToneCls =
    quotaSum && quotaSum.roundedPct <= 15
      ? 'cell-value tone-danger'
      : quotaSum && quotaSum.roundedPct <= 30
        ? 'cell-value tone-warn'
        : 'cell-value';
  return {
    key: 'quota_tightest',
    label: t('ovMetric.quota_tightest'),
    icon: 'pulse',
    iconSize: 11,
    isPulsing: false,
    valueText: quotaSum ? quotaSum.shortText : '—',
    valueClass: quotaToneCls,
    subText: quotaSum
      ? t('ovMetric.subQuotaPool', { label: quotaSum.subLabelText })
      : t('ovMetric.subQuotaPending'),
    subClass: 'cell-sub',
  };
}
