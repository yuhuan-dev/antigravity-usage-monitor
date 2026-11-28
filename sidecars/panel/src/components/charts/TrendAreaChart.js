/**
 * @fileoverview 交互式历史用量趋势图组件 (TrendAreaChart).
 * 支持双模式自适应切换：
 * 1. <= 90 天（或整点小时分桶）：渲染三次贝塞尔平滑曲线面积图、峰值气泡与对齐多刻度时间轴；
 * 2. > 90 天（自然日分桶）：自动切换为类 GitHub 贡献日历的小格子热力排列（一格一天，7 行星期 × 周列、月份刻度、分位数 5 档热力色阶与底部图例）；
 * 3. 两种模式共享自适应防溢出的悬浮详情卡片（精确日期/小时区间、Token 拆分、费用与调用次数）。
 */

import {
  h,
  patchAttr,
  patchClasses,
  patchStyleVar,
  patchText,
} from '../../core/domPatch.js';
import {
  formatDateSpanBadge,
  formatShortMonthName,
  formatTokensPrecise,
  formatTrendSlotFullLabel,
  formatUsd,
} from '../../core/formatters.js';
import { SVG_NS } from '../../icons/SvgIcon.js';
import { getEffectiveLocale, t } from '../../i18n/index.js';
import { createConsumptionBreakdownContent } from '../ui/ConsumptionTooltipContent.js';
import {
  createCubicCurveMorphController,
  createFloatingChartTooltipController,
  createReadyClassArmer,
  pointsToNormalizedCubicSegs,
} from './chartMotion.js';

/** 超过该自然日天数（> 90 天）时，趋势图切换为类 GitHub 每日小格子热力图 */
export const HEATMAP_DAYS_THRESHOLD = 90;

let chartUidCounter = 0;

function safeSlotTokens(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 将二维采样点序列转换为水平张力平滑的三次贝塞尔曲线 SVG 路径 (`M ... C ...`)。
 * 控制点沿 X 轴取相邻点间距的 `0.42` 张力系数，Y 轴与各自端点齐平，
 * 保证曲线在极值点处平缓过渡且不会产生上下过冲 (Overshoot)。
 *
 * @param {Array<{ x: number, y: number }>} points SVG 坐标系下的采样点数组（长度 >= 2）
 * @returns {string} SVG `<path>` 的 `d` 属性字符串
 */
function buildSmoothSplinePath(points) {
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const cpx1 = p0.x + (p1.x - p0.x) * 0.42;
    const cpx2 = p1.x - (p1.x - p0.x) * 0.42;
    d += ` C ${cpx1.toFixed(1)} ${p0.y.toFixed(1)}, ${cpx2.toFixed(1)} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }
  return d;
}

/**
 * 根据分桶总数及标签平均长度，计算底部 X 轴应当展示的均匀刻度下标列表。
 *
 * @param {Array<{ label?: string }>} slots
 * @returns {number[]}
 */
function computeTickIndices(slots) {
  const n = slots.length;
  if (n <= 1) return [0];
  const sampleLabel = String(slots[Math.floor(n / 2)]?.label || slots[0]?.label || '');
  const maxDirectTicks = sampleLabel.length > 6 ? 5 : 8;
  if (n <= maxDirectTicks) {
    return Array.from({ length: n }, (_, i) => i);
  }
  const maxTicks = sampleLabel.length > 6 ? 5 : 6;
  const set = new Set();
  for (let k = 0; k < maxTicks; k++) {
    const idx = Math.round((k / (maxTicks - 1)) * (n - 1));
    set.add(idx);
  }
  return Array.from(set).sort((a, b) => a - b);
}

/**
 * 基于非零活跃日的分位数阈值计算热力图 5 档色阶（0 ~ 4），避免单日极端峰值压缩其余活跃日的层次对比。
 *
 * @param {number[]} nonZeroValues 已升序排列的正数 Token 列表
 * @param {number} maxTokens
 * @returns {{ q1: number, q2: number, q3: number, maxTokens: number, count: number }}
 */
function computeHeatmapThresholds(nonZeroValues, maxTokens) {
  const n = nonZeroValues.length;
  if (n === 0 || maxTokens <= 0) {
    return { q1: 0, q2: 0, q3: 0, maxTokens: 0, count: 0 };
  }
  if (n < 4) {
    return {
      q1: maxTokens * 0.25,
      q2: maxTokens * 0.5,
      q3: maxTokens * 0.75,
      maxTokens,
      count: n,
    };
  }
  return {
    q1: nonZeroValues[Math.floor((n - 1) * 0.25)],
    q2: nonZeroValues[Math.floor((n - 1) * 0.5)],
    q3: nonZeroValues[Math.floor((n - 1) * 0.75)],
    maxTokens,
    count: n,
  };
}

function resolveHeatmapLevel(tokens, thresholds) {
  if (tokens <= 0 || thresholds.maxTokens <= 0) return 0;
  if (tokens >= thresholds.maxTokens || tokens > thresholds.q3) return 4;
  if (tokens > thresholds.q2) return 3;
  if (tokens > thresholds.q1) return 2;
  return 1;
}

/**
 * 解析日期槽位的年份与月份信息（兼容真实时间戳 `startMs` 与测试简写 `label`）。
 *
 * @param {object} slot
 * @returns {{ year: number, month: number, day: number }}
 */
function parseSlotCalendarParts(slot) {
  const sMs = Number(slot?.startMs);
  if (Number.isFinite(sMs) && sMs > 0) {
    const d = new Date(sMs);
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  }
  const m = String(slot?.label || '').match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    return { year: new Date().getFullYear(), month: Number(m[1]), day: Number(m[2]) };
  }
  return { year: new Date().getFullYear(), month: 0, day: 0 };
}

/**
 * 构建热力图顶部与周列对齐的月份刻度标签（自动跳过首尾过窄残月，防止相邻月份文字重叠）。
 *
 * @param {Array<object>} slots
 * @param {number} firstDow 首日对应的星期行索引（0 = 周一 .. 6 = 周日）
 * @param {number} totalWeeks 总周列数
 * @returns {Array<{ col: number, text: string }>}
 */
function buildHeatmapMonthTicks(slots, firstDow, totalWeeks) {
  if (!slots.length || totalWeeks <= 0) return [];
  const firstParts = parseSlotCalendarParts(slots[0]);
  const lastParts = parseSlotCalendarParts(slots[slots.length - 1]);
  const crossYear = firstParts.year !== lastParts.year;

  const candidates = [];
  let prevMonthKey = '';

  for (let col = 0; col < totalWeeks; col++) {
    let chosenParts = null;
    for (let row = 0; row < 7; row++) {
      const idx = col * 7 + row - firstDow;
      if (idx < 0 || idx >= slots.length) continue;
      const parts = parseSlotCalendarParts(slots[idx]);
      if (!parts.month) continue;
      const mKey = `${parts.year}-${parts.month}`;
      if (col === 0 && !chosenParts) {
        chosenParts = parts;
        prevMonthKey = mKey;
        break;
      }
      if (mKey !== prevMonthKey) {
        chosenParts = parts;
        prevMonthKey = mKey;
        break;
      }
    }
    if (chosenParts && chosenParts.month > 0) {
      candidates.push({ col, year: chosenParts.year, month: chosenParts.month });
    }
  }

  const baseMinGap = totalWeeks > 40 ? 4 : 3;
  if (
    candidates.length >= 2 &&
    candidates[0].col === 0 &&
    candidates[1].col - candidates[0].col < baseMinGap
  ) {
    candidates.shift();
  }

  const ticks = [];
  let nextAllowedCol = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (totalWeeks > 16 && c.col >= totalWeeks - 1) continue;
    if (ticks.length > 0 && c.col < nextAllowedCol) continue;
    const showYear = crossYear && (c.month === 1 || ticks.length === 0);
    const text = showYear
      ? t('chart.trend.hmMonthYear', { yy: String(c.year).slice(-2), month: c.month })
      : t('chart.trend.hmMonthOnly', { month: c.month });
    ticks.push({ col: c.col, text });
    nextAllowedCol = c.col + (showYear ? baseMinGap + 1 : baseMinGap);
  }
  return ticks;
}

function normalizeHeatmapMode(mode) {
  return mode === 'week' || mode === 'month' || mode === 'all' ? mode : 'day';
}

function createHeatmapAggAcc(extra = {}) {
  return {
    tokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    thinkingTokens: 0,
    responseTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    calls: 0,
    minStartMs: Infinity,
    maxEndMs: 0,
    firstLabel: '',
    lastLabel: '',
    modelMap: new Map(),
    ...extra,
  };
}

function mergeSlotIntoHeatmapAcc(acc, slot) {
  if (!slot) return;
  const tok = safeSlotTokens(slot.tokens);
  const inTok = safeSlotTokens(slot.inputTokens);
  const cacheTok = safeSlotTokens(slot.cacheReadTokens);
  const thinkTok = safeSlotTokens(slot.thinkingTokens);
  const respTok = safeSlotTokens(slot.responseTokens);
  const outTok =
    slot.outputTokens !== undefined && slot.outputTokens !== null
      ? safeSlotTokens(slot.outputTokens)
      : thinkTok + respTok;
  acc.tokens += tok;
  acc.inputTokens += inTok;
  acc.cacheReadTokens += cacheTok;
  acc.thinkingTokens += thinkTok;
  acc.responseTokens += respTok;
  acc.outputTokens += outTok;
  acc.costUsd += Math.max(0, Number(slot.costUsd || 0));
  acc.calls += Math.max(0, Number(slot.calls || 0));

  const sMs = Number(slot.startMs);
  const eMs = Number(slot.endMs);
  if (Number.isFinite(sMs) && sMs > 0 && sMs < acc.minStartMs) {
    acc.minStartMs = sMs;
  }
  if (Number.isFinite(eMs) && eMs > acc.maxEndMs) {
    acc.maxEndMs = eMs;
  } else if (Number.isFinite(sMs) && sMs > 0 && sMs + 86_400_000 > acc.maxEndMs) {
    acc.maxEndMs = sMs + 86_400_000;
  }
  const lbl = String(slot.label || '');
  if (!acc.firstLabel && lbl) acc.firstLabel = lbl;
  if (lbl) acc.lastLabel = lbl;

  const srcModels = Array.isArray(slot.mergedModels)
    ? slot.mergedModels
    : Array.isArray(slot.models)
      ? slot.models
      : null;
  if (srcModels) {
    for (let i = 0; i < srcModels.length; i++) {
      const m = srcModels[i];
      if (!m) continue;
      const key = String(m.displayText || m.label || m.shortName || '');
      if (!key) continue;
      let cur = acc.modelMap.get(key);
      if (!cur) {
        cur = {
          ...m,
          calls: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          thinkingTokens: 0,
          responseTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costUsd: 0,
        };
        acc.modelMap.set(key, cur);
      }
      cur.calls += Math.max(0, Number(m.calls || 0));
      cur.inputTokens += safeSlotTokens(m.inputTokens);
      cur.cacheReadTokens += safeSlotTokens(m.cacheReadTokens);
      cur.thinkingTokens += safeSlotTokens(m.thinkingTokens);
      cur.responseTokens += safeSlotTokens(m.responseTokens);
      cur.outputTokens += safeSlotTokens(m.outputTokens);
      cur.totalTokens += safeSlotTokens(m.totalTokens);
      cur.costUsd += Math.max(0, Number(m.costUsd || 0));
    }
  }
}

function finalizeHeatmapBucket(acc, customTitle, shortLabel, buildSegmentsFn) {
  const hasStart = Number.isFinite(acc.minStartMs) && acc.minStartMs < Infinity && acc.minStartMs > 0;
  const startMs = hasStart ? acc.minStartMs : 0;
  const endMs =
    hasStart && acc.maxEndMs > startMs
      ? Math.max(startMs + 60_000, acc.maxEndMs - 1)
      : 0;
  let modelSegments = [];
  if (typeof buildSegmentsFn === 'function' && acc.modelMap.size > 0) {
    const mergedList = Array.from(acc.modelMap.values(), (m) => ({ ...m })).sort(
      (a, b) => (b.totalTokens || 0) - (a.totalTokens || 0) || (b.calls || 0) - (a.calls || 0)
    );
    modelSegments = buildSegmentsFn(mergedList) || [];
  }
  return {
    startMs,
    endMs,
    label: shortLabel || customTitle,
    fullLabel: customTitle,
    customTitle,
    tokens: acc.tokens,
    inputTokens: acc.inputTokens,
    cacheReadTokens: acc.cacheReadTokens,
    thinkingTokens: acc.thinkingTokens,
    responseTokens: acc.responseTokens,
    outputTokens: acc.outputTokens,
    costUsd: +acc.costUsd.toFixed(4),
    calls: acc.calls,
    modelSegments,
  };
}

function buildHeatmapBarView(slots, firstDow, totalWeeks, mode, buildSegmentsFn) {
  if (mode === 'week') {
    const weekAccs = Array.from({ length: totalWeeks }, () => createHeatmapAggAcc());
    for (let i = 0; i < slots.length; i++) {
      const col = Math.floor((firstDow + i) / 7);
      if (col >= 0 && col < totalWeeks) {
        mergeSlotIntoHeatmapAcc(weekAccs[col], slots[i]);
      }
    }
    let maxTok = 0;
    let peakIdx = 0;
    let activeWeeks = 0;
    const nonZero = [];
    const buckets = weekAccs.map((acc, idx) => {
      if (acc.tokens > 0) {
        activeWeeks++;
        nonZero.push(acc.tokens);
      }
      if (acc.tokens >= maxTok) {
        maxTok = acc.tokens;
        peakIdx = idx;
      }
      const hasValidRange = Number.isFinite(acc.minStartMs) && acc.minStartMs < Infinity && acc.minStartMs > 0;
      const spanTitle = hasValidRange
        ? formatDateSpanBadge(acc.minStartMs, Math.max(acc.minStartMs, acc.maxEndMs - 1))
        : acc.firstLabel && acc.lastLabel && acc.firstLabel !== acc.lastLabel
          ? `${acc.firstLabel} ~ ${acc.lastLabel}`
          : acc.firstLabel || '--';
      const shortLbl =
        acc.firstLabel && acc.lastLabel && acc.firstLabel !== acc.lastLabel
          ? `${acc.firstLabel}~${acc.lastLabel.split('/').pop()}`
          : acc.firstLabel || spanTitle;
      return finalizeHeatmapBucket(acc, spanTitle, shortLbl, buildSegmentsFn);
    });
    nonZero.sort((a, b) => a - b);
    const thresholds = computeHeatmapThresholds(nonZero, maxTok);
    const colSpecs = buckets.map((b, col) => {
      const litRows =
        b.tokens > 0 && maxTok > 0 ? Math.max(1, Math.min(7, Math.ceil((b.tokens / maxTok) * 7))) : 0;
      return {
        bucketIdx: col,
        litRows,
        lv: litRows > 0 ? resolveHeatmapLevel(b.tokens, thresholds) : 0,
        isMonthEdge: false,
      };
    });
    const peakB = buckets[peakIdx];
    const summaryText =
      maxTok > 0 && peakB
        ? t('chart.trend.hmWeekPeak', {
            active: activeWeeks,
            total: totalWeeks,
            label: peakB.label,
            tokens: formatTokensPrecise(maxTok),
          })
        : t('chart.trend.hmWeekZero', { total: totalWeeks });
    return { buckets, colSpecs, summaryText };
  }

  if (mode === 'month') {
    const monthIndexByKey = new Map();
    const monthAccs = [];
    const colMonthCounts = Array.from({ length: totalWeeks }, () => new Map());

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const parts = parseSlotCalendarParts(slot);
      const mKey = `${parts.year}-${parts.month}`;
      let mIdx = monthIndexByKey.get(mKey);
      if (mIdx === undefined) {
        mIdx = monthAccs.length;
        monthIndexByKey.set(mKey, mIdx);
        monthAccs.push(createHeatmapAggAcc({ year: parts.year, month: parts.month }));
      }
      mergeSlotIntoHeatmapAcc(monthAccs[mIdx], slot);
      const col = Math.floor((firstDow + i) / 7);
      if (col >= 0 && col < totalWeeks) {
        colMonthCounts[col].set(mIdx, (colMonthCounts[col].get(mIdx) || 0) + 1);
      }
    }

    const colMonthIdx = new Array(totalWeeks).fill(0);
    for (let col = 0; col < totalWeeks; col++) {
      let bestM = col > 0 ? colMonthIdx[col - 1] : 0;
      let bestCnt = -1;
      for (const [mIdx, cnt] of colMonthCounts[col].entries()) {
        if (cnt >= bestCnt) {
          bestCnt = cnt;
          bestM = mIdx;
        }
      }
      colMonthIdx[col] = bestM;
    }
    if (monthAccs.length > 0 && totalWeeks >= monthAccs.length) {
      colMonthIdx[0] = 0;
      colMonthIdx[totalWeeks - 1] = monthAccs.length - 1;
    }

    let maxTok = 0;
    let peakIdx = 0;
    let activeMonths = 0;
    const nonZero = [];
    const activeLocale = getEffectiveLocale();
    const useCjkMonthTemplate =
      activeLocale === 'zh-CN' ||
      activeLocale === 'zh-TW' ||
      activeLocale === 'ja-JP' ||
      activeLocale === 'ko-KR';
    const buckets = monthAccs.map((acc, idx) => {
      if (acc.tokens > 0) {
        activeMonths++;
        nonZero.push(acc.tokens);
      }
      if (acc.tokens >= maxTok) {
        maxTok = acc.tokens;
        peakIdx = idx;
      }
      const mNum = acc.month || 1;
      const monShort = useCjkMonthTemplate
        ? ''
        : formatShortMonthName(mNum - 1, activeLocale, { stripTrailingDot: true }) || `M${mNum}`;
      const fullTitle = useCjkMonthTemplate
        ? t('cons.monthFullLabel', { year: acc.year, m: mNum })
        : `${monShort} ${acc.year}`;
      const shortLbl = useCjkMonthTemplate ? t('cons.monthLabel', { m: mNum }) : monShort;
      return finalizeHeatmapBucket(acc, fullTitle, shortLbl, buildSegmentsFn);
    });
    nonZero.sort((a, b) => a - b);
    const thresholds = computeHeatmapThresholds(nonZero, maxTok);
    const colSpecs = colMonthIdx.map((mIdx, col) => {
      const b = buckets[mIdx] || { tokens: 0 };
      const litRows =
        b.tokens > 0 && maxTok > 0 ? Math.max(1, Math.min(7, Math.ceil((b.tokens / maxTok) * 7))) : 0;
      return {
        bucketIdx: mIdx,
        litRows,
        lv: litRows > 0 ? resolveHeatmapLevel(b.tokens, thresholds) : 0,
        isMonthEdge: col > 0 && mIdx !== colMonthIdx[col - 1],
      };
    });
    const peakB = buckets[peakIdx];
    const summaryText =
      maxTok > 0 && peakB
        ? t('chart.trend.hmMonthPeak', {
            active: activeMonths,
            total: buckets.length,
            label: peakB.label,
            tokens: formatTokensPrecise(maxTok),
          })
        : t('chart.trend.hmMonthZero', { total: Math.max(1, buckets.length) });
    return { buckets, colSpecs, summaryText };
  }

  // mode === 'all' (累计总量爬升柱阵)
  const runAcc = createHeatmapAggAcc();
  const buckets = new Array(totalWeeks);
  for (let col = 0; col < totalWeeks; col++) {
    for (let row = 0; row < 7; row++) {
      const sIdx = col * 7 + row - firstDow;
      if (sIdx >= 0 && sIdx < slots.length) {
        mergeSlotIntoHeatmapAcc(runAcc, slots[sIdx]);
      }
    }
    const hasEnd = Number.isFinite(runAcc.minStartMs) && runAcc.minStartMs < Infinity && runAcc.maxEndMs > 0;
    const endDayMs = hasEnd ? Math.max(runAcc.minStartMs, runAcc.maxEndMs - 1) : 0;
    const endDateStr = endDayMs > 0 ? formatDateSpanBadge(endDayMs, endDayMs) : runAcc.lastLabel || '--';
    const cumTitle = t('chart.trend.hmCumThrough', { date: endDateStr });
    buckets[col] = finalizeHeatmapBucket(runAcc, cumTitle, endDateStr, buildSegmentsFn);
  }
  const grandTotal = buckets[totalWeeks - 1]?.tokens || 0;
  const grandCost = buckets[totalWeeks - 1]?.costUsd || 0;
  const colSpecs = buckets.map((b, col) => {
    const litRows =
      b.tokens > 0 && grandTotal > 0
        ? Math.max(1, Math.min(7, Math.ceil((b.tokens / grandTotal) * 7)))
        : 0;
    const ratio = grandTotal > 0 ? b.tokens / grandTotal : 0;
    const lv = litRows === 0 ? 0 : ratio > 0.75 ? 4 : ratio > 0.5 ? 3 : ratio > 0.25 ? 2 : 1;
    return {
      bucketIdx: col,
      litRows,
      lv,
      isMonthEdge: false,
    };
  });
  const summaryText = t('chart.trend.hmCumSummary', {
    days: slots.length,
    tokens: formatTokensPrecise(grandTotal),
    cost: formatUsd(grandCost),
  });
  return { buckets, colSpecs, summaryText };
}

/**
 * 创建交互式历史趋势组件（<=90 天为 SVG 平滑曲线图，>90 天自动切换为类 GitHub 每日小格子热力图）。
 *
 * @param {{ onSelectSlot?: (slot: object) => void }} [options]
 * @returns {{
 *   el: HTMLElement,
 *   update: (series?: Array<object>) => void,
 *   destroy: () => void
 * }}
 */
export function createTrendAreaChart({ onSelectSlot = null } = {}) {
  const DEFAULT_VIEW_W = 460;
  const VIEW_H = 184;
  const TOP_Y = 26;
  const BOTTOM_Y = 164;
  const SPAN_Y = BOTTOM_Y - TOP_Y;

  let viewW = DEFAULT_VIEW_W;

  function resolvePlotBounds(w) {
    const leftX = 1;
    const rightX = Math.max(leftX + 20, w - 1);
    return { leftX, rightX, spanX: rightX - leftX };
  }

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${viewW} ${VIEW_H}`);
  svg.setAttribute('class', 'trend-svg');
  svg.setAttribute('aria-hidden', 'true');

  // 垂直线性渐变（每实例独立 ID，避免多图表挂载时 SVG url(#...) 冲突）
  const gradId = `trend-area-grad-${++chartUidCounter}`;
  const defs = document.createElementNS(SVG_NS, 'defs');
  const grad = document.createElementNS(SVG_NS, 'linearGradient');
  grad.setAttribute('id', gradId);
  grad.setAttribute('x1', '0');
  grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '0');
  grad.setAttribute('y2', '1');

  const stop1 = document.createElementNS(SVG_NS, 'stop');
  stop1.setAttribute('offset', '0%');
  stop1.setAttribute('stop-color', 'var(--ctx-cached)');
  stop1.setAttribute('stop-opacity', '0.34');

  const stop2 = document.createElementNS(SVG_NS, 'stop');
  stop2.setAttribute('offset', '100%');
  stop2.setAttribute('stop-color', 'var(--ctx-cached)');
  stop2.setAttribute('stop-opacity', '0.0');

  grad.appendChild(stop1);
  grad.appendChild(stop2);
  defs.appendChild(grad);
  svg.appendChild(defs);

  // 背景水平与垂直参考网格线（水平网格全宽贴边铺满 0..viewW）
  const hGridGroup = document.createElementNS(SVG_NS, 'g');
  hGridGroup.setAttribute('class', 'trend-grid');
  const hGridLines = [];
  for (const y of [
    TOP_Y,
    Math.round(TOP_Y + SPAN_Y / 3),
    Math.round(TOP_Y + (SPAN_Y * 2) / 3),
    BOTTOM_Y,
  ]) {
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', '0');
    line.setAttribute('y1', String(y));
    line.setAttribute('x2', String(viewW));
    line.setAttribute('y2', String(y));
    hGridGroup.appendChild(line);
    hGridLines.push(line);
  }
  svg.appendChild(hGridGroup);

  const vGridGroup = document.createElementNS(SVG_NS, 'g');
  vGridGroup.setAttribute('class', 'trend-grid trend-v-grid');
  svg.appendChild(vGridGroup);

  const areaPath = document.createElementNS(SVG_NS, 'path');
  areaPath.setAttribute('fill', `url(#${gradId})`);
  svg.appendChild(areaPath);

  const linePath = document.createElementNS(SVG_NS, 'path');
  linePath.setAttribute('class', 'trend-line');
  linePath.setAttribute('fill', 'none');
  svg.appendChild(linePath);

  // 悬停十字准星及焦点圆点
  const hoverLine = document.createElementNS(SVG_NS, 'line');
  hoverLine.setAttribute('class', 'trend-hover-line');
  hoverLine.setAttribute('y1', '12');
  hoverLine.setAttribute('y2', String(BOTTOM_Y));
  hoverLine.setAttribute('hidden', 'true');
  svg.appendChild(hoverLine);

  const hoverDot = document.createElementNS(SVG_NS, 'circle');
  hoverDot.setAttribute('r', '3.2');
  hoverDot.setAttribute('class', 'trend-hover-dot');
  hoverDot.setAttribute('hidden', 'true');
  svg.appendChild(hoverDot);

  const peakPill = h('span', { className: 'trend-peak-pill text-mono', text: '0', hidden: true });

  // 共享悬停详情浮层卡片（曲线图和热力格子图共用，含分模型四段进度条及底部四通道明细）
  const tooltipContent = createConsumptionBreakdownContent({
    showModelDot: false,
    monoTitle: true,
  });

  const tooltipEl = h(
    'div',
    { className: 'trend-tooltip is-rich-breakdown', hidden: true },
    tooltipContent.children
  );

  // 底部对齐刻度轴（曲线模式）
  const xAxisEl = h('div', { className: 'trend-x-axis' });
  const plotStage = h(
    'div',
    { className: `trend-plot-stage${typeof onSelectSlot === 'function' ? ' is-clickable' : ''}` },
    [peakPill, svg]
  );

  // 类 GitHub 每日小格子热力图容器（> 90 天模式）
  const wdayMonEl = h('span', { className: 'trend-hm-wday', text: t('chart.trend.wdayMon') });
  const wdayWedEl = h('span', { className: 'trend-hm-wday', text: t('chart.trend.wdayWed') });
  const wdayFriEl = h('span', { className: 'trend-hm-wday', text: t('chart.trend.wdayFri') });
  const wdaySunEl = h('span', { className: 'trend-hm-wday', text: t('chart.trend.wdaySun') });
  const hmWeekdaysEl = h('div', { className: 'trend-hm-weekdays', 'aria-hidden': 'true' }, [
    h('span', { className: 'trend-hm-month-spacer' }),
    wdayMonEl,
    h('span', { className: 'trend-hm-wday', text: '' }),
    wdayWedEl,
    h('span', { className: 'trend-hm-wday', text: '' }),
    wdayFriEl,
    h('span', { className: 'trend-hm-wday', text: '' }),
    wdaySunEl,
  ]);
  const hmMonthsEl = h('div', { className: 'trend-hm-months' });
  const hmGridEl = h('div', {
    className: 'trend-hm-grid',
    role: 'grid',
    'aria-label': t('chart.trend.hmAria'),
  });
  const hmTrackEl = h('div', { className: 'trend-hm-track' }, [hmMonthsEl, hmGridEl]);
  const hmScrollEl = h('div', { className: 'trend-hm-scroll' }, [hmTrackEl]);
  const hmBodyEl = h('div', { className: 'trend-heatmap-body' }, [hmWeekdaysEl, hmScrollEl]);

  const hmSummaryEl = h('span', { className: 'trend-hm-summary text-mono', text: '' });
  const hmLessEl = h('span', { text: t('chart.trend.hmLess') });
  const hmMoreEl = h('span', { text: t('chart.trend.hmMore') });
  const hmLegendEl = h('span', { className: 'trend-hm-legend', 'aria-hidden': 'true' }, [
    hmLessEl,
    h('span', { className: 'trend-hm-swatch lv-0' }),
    h('span', { className: 'trend-hm-swatch lv-1' }),
    h('span', { className: 'trend-hm-swatch lv-2' }),
    h('span', { className: 'trend-hm-swatch lv-3' }),
    h('span', { className: 'trend-hm-swatch lv-4' }),
    hmMoreEl,
  ]);
  const hmFooterEl = h('div', { className: 'trend-hm-footer' }, [hmSummaryEl, hmLegendEl]);
  const heatmapStage = h('div', { className: 'trend-heatmap-stage', hidden: true }, [
    hmBodyEl,
    hmFooterEl,
  ]);

  const chartWrap = h('div', { className: 'trend-chart-wrap' }, [
    plotStage,
    xAxisEl,
    heatmapStage,
    tooltipEl,
  ]);

  let currentSlots = [];
  let currentPts = [];
  let currentMaxTokens = 0;
  let currentIsHeatmap = false;
  let currentHmMode = 'day';
  let lastBuildSegmentsFn = null;
  let currentHeatmapWeeks = 0;
  let currentHeatmapFirstDow = 0;
  let currentHeatmapGapPx = 2;
  let currentCellEls = [];
  let currentHmBuckets = [];
  let currentHmBucketCells = [];
  let currentHmAnchorCells = [];
  let currentColBucketIdx = [];
  let hoveredHighlightEls = [];
  let lastHeatmapSummaryText = '';
  let tickElsByIdx = new Map();
  let hoveredIdx = -1;
  let hoveredCellEl = null;
  let lastPointer = null;
  let lastRenderSig = '';
  const vGridLinePool = [];
  const xAxisTickPool = [];
  const hmMonthPool = [];
  const hmCellPool = [];

  const curveMorphCtrl = createCubicCurveMorphController();
  const peakReadyArmer = createReadyClassArmer(peakPill, 'is-ready');
  const tooltipCtrl = createFloatingChartTooltipController({
    containerEl: chartWrap,
    tooltipEl,
    defaultTipWidth: 216,
    defaultTipHeight: 104,
    defaultViewWidth: DEFAULT_VIEW_W,
    defaultViewHeight: VIEW_H,
    useFloatingClass: false,
  });

  function populateTooltipContent(slot) {
    const slotTok = safeSlotTokens(slot.tokens);
    const slotCost = Number.isFinite(Number(slot.costUsd)) ? Math.max(0, Number(slot.costUsd)) : 0;
    tooltipContent.update({
      title: slot.customTitle || formatTrendSlotFullLabel(slot) || slot.label || '--',
      calls: slot.calls,
      totalTokens: slotTok,
      costText: formatUsd(slotCost, {
        precise: slotCost > 0 && slotCost < 0.1,
      }),
      inputTokens: slot.inputTokens,
      cacheReadTokens: slot.cacheReadTokens,
      thinkingTokens: slot.thinkingTokens,
      responseTokens: slot.responseTokens,
      outputTokens: slot.outputTokens,
      segments: Array.isArray(slot.modelSegments) ? slot.modelSegments : [],
    });
  }

  let cachedSvgRect = null;
  let cachedHmGridRect = null;

  function invalidateHoverRects() {
    tooltipCtrl.invalidateRects();
    cachedSvgRect = null;
    cachedHmGridRect = null;
  }

  function showLineHoverAtIndex(idx, pointer = null) {
    if (currentIsHeatmap || idx < 0 || idx >= currentSlots.length || !currentPts[idx]) {
      clearHover();
      return;
    }
    const wasHidden = tooltipEl.hasAttribute('hidden');
    const changedIdx = idx !== hoveredIdx;
    hoveredIdx = idx;
    if (pointer) {
      lastPointer = pointer;
    }
    const slot = currentSlots[idx];
    const pt = currentPts[idx];

    if (wasHidden || changedIdx) {
      patchAttr(hoverLine, 'hidden', false);
      patchAttr(hoverLine, 'x1', pt.x.toFixed(1));
      patchAttr(hoverLine, 'x2', pt.x.toFixed(1));

      patchAttr(hoverDot, 'hidden', false);
      patchAttr(hoverDot, 'cx', pt.x.toFixed(1));
      patchAttr(hoverDot, 'cy', pt.y.toFixed(1));

      patchAttr(peakPill, 'hidden', true);
      patchClasses(tooltipEl, {
        'is-hm-bottom': false,
        'is-hm-top': false,
        'is-line-low': false,
      });
      populateTooltipContent(slot);

      for (const [tIdx, el] of tickElsByIdx.entries()) {
        patchClasses(el, { 'is-hovered': tIdx === idx });
      }
    }

    const wrapRect = tooltipCtrl.getWrapRect();
    const wrapW =
      wrapRect && wrapRect.width > 0
        ? wrapRect.width
        : Number(chartWrap.clientWidth || viewW || DEFAULT_VIEW_W);
    const fallbackX = (pt.x / Math.max(1, viewW)) * wrapW;
    const fallbackY = pt.y + 6;
    tooltipCtrl.show({
      fallbackX,
      fallbackY,
      pointer: pointer || lastPointer,
      trackedDots: [hoverDot],
      viewWidth: viewW,
      viewHeight: VIEW_H,
    });
  }

  function showHeatmapHoverAtIndex(idx, cellEl, pointer = null) {
    if (!currentIsHeatmap || idx < 0 || idx >= currentHmBuckets.length) {
      clearHover();
      return;
    }
    const isBarMode = currentHmMode !== 'day';
    const targetCell = isBarMode
      ? currentHmAnchorCells[idx] || cellEl || null
      : cellEl || currentHmAnchorCells[idx] || currentCellEls[idx] || null;
    if (!targetCell) {
      clearHover();
      return;
    }
    const wasHidden = tooltipEl.hasAttribute('hidden');
    const changedCell = idx !== hoveredIdx || hoveredCellEl !== targetCell;
    hoveredIdx = idx;
    if (pointer) {
      lastPointer = pointer;
    }

    if (changedCell || hoveredHighlightEls.length === 0) {
      for (let i = 0; i < hoveredHighlightEls.length; i++) {
        patchClasses(hoveredHighlightEls[i], {
          'is-hovered': false,
          'is-bar-hovered': false,
        });
      }
      const nextHighlight =
        currentHmBucketCells[idx] && currentHmBucketCells[idx].length > 0
          ? currentHmBucketCells[idx]
          : [targetCell];
      for (let i = 0; i < nextHighlight.length; i++) {
        patchClasses(nextHighlight[i], {
          'is-hovered': !isBarMode,
          'is-bar-hovered': isBarMode,
        });
      }
      hoveredHighlightEls = nextHighlight;
      hoveredCellEl = targetCell;
    }

    const slot = currentHmBuckets[idx];
    const row = Number(targetCell.getAttribute('data-hm-row') || 0);
    const col = Number(targetCell.getAttribute('data-hm-col') || 0);

    if (wasHidden || changedCell) {
      patchClasses(tooltipEl, {
        'is-hm-bottom': false,
        'is-hm-top': false,
        'is-line-low': false,
      });
      populateTooltipContent(slot);
    }

    const wrapRect = tooltipCtrl.getWrapRect();
    const cellRect = targetCell.getBoundingClientRect?.() || null;
    const wrapW =
      wrapRect && wrapRect.width > 0
        ? wrapRect.width
        : Number(chartWrap.clientWidth || viewW || DEFAULT_VIEW_W);
    let fallbackX =
      currentHeatmapWeeks > 0 ? ((col + 0.5) / currentHeatmapWeeks) * wrapW : wrapW / 2;
    let fallbackY = 20 + row * 14;
    const hasValidCellRect = Boolean(
      wrapRect &&
        wrapRect.width > 0 &&
        cellRect &&
        cellRect.width > 0 &&
        cellRect.width < wrapRect.width
    );
    if (hasValidCellRect) {
      fallbackX = cellRect.left + cellRect.width / 2 - wrapRect.left;
      fallbackY = cellRect.top + cellRect.height / 2 - wrapRect.top;
    }

    const rawPtr = pointer || lastPointer;
    const effectivePtr =
      isBarMode &&
      rawPtr &&
      hasValidCellRect &&
      Number.isFinite(Number(rawPtr.clientX)) &&
      Number.isFinite(Number(rawPtr.clientY))
        ? {
            clientX: Number(rawPtr.clientX),
            clientY: Math.min(Number(rawPtr.clientY), cellRect.top + 2),
          }
        : rawPtr;

    tooltipCtrl.show({
      fallbackX,
      fallbackY,
      pointer: effectivePtr,
      trackedDots: [],
      viewWidth: viewW,
      viewHeight: VIEW_H,
    });
  }

  function clearHover() {
    invalidateHoverRects();
    tooltipCtrl.hide();
    hoveredIdx = -1;
    lastPointer = null;
    patchAttr(hoverLine, 'hidden', true);
    patchAttr(hoverDot, 'hidden', true);
    patchClasses(hoverDot, { 'is-tracking': false });
    if (!currentIsHeatmap && currentMaxTokens > 0) {
      patchAttr(peakPill, 'hidden', false);
    }
    if (hoveredHighlightEls.length > 0) {
      for (let i = 0; i < hoveredHighlightEls.length; i++) {
        patchClasses(hoveredHighlightEls[i], {
          'is-hovered': false,
          'is-bar-hovered': false,
        });
      }
      hoveredHighlightEls = [];
    }
    if (hoveredCellEl) {
      patchClasses(hoveredCellEl, { 'is-hovered': false, 'is-bar-hovered': false });
      hoveredCellEl = null;
    }
    for (const el of tickElsByIdx.values()) {
      patchClasses(el, { 'is-hovered': false });
    }
  }

  function syncViewWidth() {
    const measured = Math.round(
      plotStage.clientWidth ||
        svg.clientWidth ||
        plotStage.getBoundingClientRect?.()?.width ||
        0
    );
    if (measured >= 160 && measured !== viewW) {
      viewW = measured;
      svg.setAttribute('viewBox', `0 0 ${viewW} ${VIEW_H}`);
      for (const line of hGridLines) {
        line.setAttribute('x1', '0');
        line.setAttribute('x2', String(viewW));
      }
      return true;
    }
    return false;
  }

  function handlePointerMove(e) {
    if (currentIsHeatmap || !currentSlots.length) return;
    if (!cachedSvgRect) {
      cachedSvgRect = svg.getBoundingClientRect();
    }
    const rect = cachedSvgRect;
    if (!rect || rect.width <= 0) {
      cachedSvgRect = null;
      return;
    }
    const relX = ((e.clientX - rect.left) / rect.width) * viewW;
    const { leftX, spanX } = resolvePlotBounds(viewW);
    const ratio = (relX - leftX) / Math.max(1, spanX);
    const idx = Math.max(
      0,
      Math.min(currentSlots.length - 1, Math.round(ratio * (currentSlots.length - 1)))
    );
    const pointer =
      Number.isFinite(Number(e?.clientX)) && Number.isFinite(Number(e?.clientY))
        ? { clientX: Number(e.clientX), clientY: Number(e.clientY) }
        : null;
    showLineHoverAtIndex(idx, pointer);
  }

  function findDirectHeatmapCell(e) {
    let cur = e?.target || null;
    while (cur && cur !== hmGridEl) {
      const idxAttr = cur.getAttribute?.('data-slot-idx');
      if (idxAttr !== null && idxAttr !== undefined && idxAttr !== '') {
        const idx = Number(idxAttr);
        if (Number.isFinite(idx) && idx >= 0 && idx < currentHmBuckets.length) {
          const cellEl =
            currentHmMode !== 'day' ? currentHmAnchorCells[idx] || cur : cur;
          return { idx, cellEl };
        }
      }
      cur = cur.parentNode || null;
    }
    return null;
  }

  function resolveHeatmapCellFromPointer(e) {
    const directHit = findDirectHeatmapCell(e);
    if (directHit) return directHit;

    const clientX = Number(e?.clientX);
    const clientY = Number(e?.clientY);
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      if (
        hoveredIdx >= 0 &&
        hoveredIdx < currentHmBuckets.length &&
        currentHmAnchorCells[hoveredIdx]
      ) {
        return { idx: hoveredIdx, cellEl: currentHmAnchorCells[hoveredIdx] };
      }
      return null;
    }

    if (!cachedHmGridRect) {
      cachedHmGridRect = hmGridEl.getBoundingClientRect?.() || null;
    }
    const rect = cachedHmGridRect;
    if (!rect || !(rect.width > 0) || !(rect.height > 0) || currentHeatmapWeeks <= 0) {
      cachedHmGridRect = null;
      if (
        hoveredIdx >= 0 &&
        hoveredIdx < currentHmBuckets.length &&
        currentHmAnchorCells[hoveredIdx]
      ) {
        return { idx: hoveredIdx, cellEl: currentHmAnchorCells[hoveredIdx] };
      }
      return null;
    }

    const W = currentHeatmapWeeks;
    const G = currentHeatmapGapPx;
    const relX = clientX - rect.left;
    const relY = clientY - rect.top;
    if (
      relX < -(G + 1) ||
      relX > rect.width + G + 1 ||
      relY < -(G + 1) ||
      relY > rect.height + G + 1
    ) {
      return null;
    }

    const pitchX = (rect.width + G) / W;
    const pitchY = (rect.height + G) / 7;
    const cellW = Math.max(1, pitchX - G);
    const cellH = Math.max(1, pitchY - G);

    // 柱阵模式下按列定位分桶，并在列间隙保持原高亮防闪烁
    if (currentHmMode !== 'day') {
      const approxCol = Math.max(0, Math.min(W - 1, Math.floor((relX + G * 0.5) / pitchX)));
      if (
        hoveredIdx >= 0 &&
        hoveredIdx < currentHmBuckets.length &&
        currentColBucketIdx[approxCol] !== hoveredIdx
      ) {
        for (const dc of [-1, 1]) {
          const nc = approxCol + dc;
          if (nc < 0 || nc >= W || currentColBucketIdx[nc] !== hoveredIdx) continue;
          const x0 = nc * pitchX;
          const dx = relX < x0 ? x0 - relX : relX > x0 + cellW ? relX - (x0 + cellW) : 0;
          if (dx <= G + 0.75 && currentHmAnchorCells[hoveredIdx]) {
            return { idx: hoveredIdx, cellEl: currentHmAnchorCells[hoveredIdx] };
          }
        }
      }
      const bIdx = currentColBucketIdx[approxCol];
      if (
        Number.isFinite(bIdx) &&
        bIdx >= 0 &&
        bIdx < currentHmBuckets.length &&
        currentHmAnchorCells[bIdx]
      ) {
        return { idx: bIdx, cellEl: currentHmAnchorCells[bIdx] };
      }
      return null;
    }

    function distanceToCell(c, r) {
      const x0 = c * pitchX;
      const y0 = r * pitchY;
      const dx = relX < x0 ? x0 - relX : relX > x0 + cellW ? relX - (x0 + cellW) : 0;
      const dy = relY < y0 ? y0 - relY : relY > y0 + cellH ? relY - (y0 + cellH) : 0;
      return { chebyshev: Math.max(dx, dy), distSq: dx * dx + dy * dy };
    }

    // 指针滑入当前悬停格四周的空隙（gap）时保持原高亮，彻底消除跨格空隙闪烁和边缘微抖
    if (hoveredIdx >= 0 && hoveredIdx < currentSlots.length && currentCellEls[hoveredIdx]) {
      const curGridPos = currentHeatmapFirstDow + hoveredIdx;
      const curCol = Math.floor(curGridPos / 7);
      const curRow = curGridPos % 7;
      if (distanceToCell(curCol, curRow).chebyshev <= G + 0.75) {
        return { idx: hoveredIdx, cellEl: currentCellEls[hoveredIdx] };
      }
    }

    // 快速扫过或初始落入格子间隙时，按网格步距吸附到最近的有效日期格
    const approxCol = Math.max(0, Math.min(W - 1, Math.floor((relX + G * 0.5) / pitchX)));
    const approxRow = Math.max(0, Math.min(6, Math.floor((relY + G * 0.5) / pitchY)));
    const directSlotIdx = approxCol * 7 + approxRow - currentHeatmapFirstDow;
    if (
      directSlotIdx >= 0 &&
      directSlotIdx < currentSlots.length &&
      currentCellEls[directSlotIdx]
    ) {
      return { idx: directSlotIdx, cellEl: currentCellEls[directSlotIdx] };
    }

    // 首周补位或末周未来空白边缘：仅当仍在相邻有效格的间隙光晕内才吸附，深入纯空白角则清空
    let bestIdx = -1;
    let bestDistSq = Infinity;
    for (let dc = -1; dc <= 1; dc++) {
      const c = approxCol + dc;
      if (c < 0 || c >= W) continue;
      for (let dr = -1; dr <= 1; dr++) {
        const r = approxRow + dr;
        if (r < 0 || r > 6) continue;
        const sIdx = c * 7 + r - currentHeatmapFirstDow;
        if (sIdx < 0 || sIdx >= currentSlots.length || !currentCellEls[sIdx]) continue;
        const d = distanceToCell(c, r);
        if (d.chebyshev <= G + 1.5 && d.distSq < bestDistSq) {
          bestDistSq = d.distSq;
          bestIdx = sIdx;
        }
      }
    }
    if (bestIdx >= 0) {
      return { idx: bestIdx, cellEl: currentCellEls[bestIdx] };
    }
    return null;
  }

  function handleHeatmapPointer(e) {
    if (!currentIsHeatmap || !currentHmBuckets.length) return;
    const hit = resolveHeatmapCellFromPointer(e);
    if (!hit || !Number.isFinite(hit.idx)) {
      clearHover();
      return;
    }
    const pointer =
      Number.isFinite(Number(e?.clientX)) && Number.isFinite(Number(e?.clientY))
        ? { clientX: Number(e.clientX), clientY: Number(e.clientY) }
        : null;
    if (hit.idx !== hoveredIdx || hit.cellEl !== hoveredCellEl || pointer) {
      showHeatmapHoverAtIndex(hit.idx, hit.cellEl, pointer);
    }
  }

  function handleHeatmapWheel(e) {
    if (!currentIsHeatmap) return;
    const maxScrollLeft = (hmScrollEl.scrollWidth || 0) - (hmScrollEl.clientWidth || 0);
    if (maxScrollLeft <= 2) return;
    const dy = Number(e.deltaY || 0);
    const dx = Number(e.deltaX || 0);
    if (Math.abs(dy) > Math.abs(dx) && dy !== 0) {
      const prev = hmScrollEl.scrollLeft || 0;
      const next = Math.max(0, Math.min(maxScrollLeft, prev + dy));
      if (next !== prev) {
        hmScrollEl.scrollLeft = next;
        e.preventDefault?.();
      }
    }
  }

  function handleLineClick(e) {
    if (currentIsHeatmap || !currentSlots.length || typeof onSelectSlot !== 'function') return;
    let idx = hoveredIdx;
    const rect = svg.getBoundingClientRect?.();
    if (rect && rect.width > 0 && Number.isFinite(Number(e?.clientX))) {
      const relX = ((e.clientX - rect.left) / rect.width) * viewW;
      const { leftX, spanX } = resolvePlotBounds(viewW);
      const ratio = (relX - leftX) / Math.max(1, spanX);
      idx = Math.max(
        0,
        Math.min(currentSlots.length - 1, Math.round(ratio * (currentSlots.length - 1)))
      );
    }
    const slot = currentSlots[idx];
    if (slot && Number(slot.startMs) > 0 && Number(slot.endMs) > Number(slot.startMs)) {
      onSelectSlot(slot);
    }
  }

  function handleHeatmapClick(e) {
    handleHeatmapPointer(e);
    if (!currentIsHeatmap || !currentHmBuckets.length || typeof onSelectSlot !== 'function') return;
    const hit = resolveHeatmapCellFromPointer(e);
    if (!hit || !Number.isFinite(hit.idx)) return;
    const slot = currentHmBuckets[hit.idx];
    if (slot && Number(slot.startMs) > 0 && Number(slot.endMs) > Number(slot.startMs)) {
      onSelectSlot(slot);
    }
  }

  plotStage.addEventListener('mousemove', handlePointerMove);
  plotStage.addEventListener('click', handleLineClick);
  plotStage.addEventListener('mouseleave', clearHover);

  hmGridEl.addEventListener('mouseover', handleHeatmapPointer);
  hmGridEl.addEventListener('mousemove', handleHeatmapPointer);
  hmGridEl.addEventListener('click', handleHeatmapClick);
  hmGridEl.addEventListener('mouseleave', clearHover);
  hmScrollEl.addEventListener('wheel', handleHeatmapWheel);

  let resizeObs = null;
  let onWinResize = null;
  if (typeof ResizeObserver === 'function') {
    resizeObs = new ResizeObserver(() => {
      invalidateHoverRects();
      if (!currentIsHeatmap && syncViewWidth() && currentSlots.length > 0) {
        lastRenderSig = '';
        update(currentSlots);
      }
    });
    resizeObs.observe(plotStage);
  } else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    onWinResize = () => {
      if (!currentIsHeatmap && syncViewWidth() && currentSlots.length > 0) {
        lastRenderSig = '';
        update(currentSlots);
      }
    };
    window.addEventListener('resize', onWinResize);
  }

  function destroy() {
    tooltipCtrl.destroy();
    curveMorphCtrl.cancel();
    peakReadyArmer.cancel();
    plotStage.removeEventListener('mousemove', handlePointerMove);
    plotStage.removeEventListener('click', handleLineClick);
    plotStage.removeEventListener('mouseleave', clearHover);
    hmGridEl.removeEventListener('mouseover', handleHeatmapPointer);
    hmGridEl.removeEventListener('mousemove', handleHeatmapPointer);
    hmGridEl.removeEventListener('click', handleHeatmapClick);
    hmGridEl.removeEventListener('mouseleave', clearHover);
    hmScrollEl.removeEventListener('wheel', handleHeatmapWheel);
    resizeObs?.disconnect();
    resizeObs = null;
    if (onWinResize && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('resize', onWinResize);
      onWinResize = null;
    }
  }

  /**
   * 根据最新时间分桶序列重绘平滑曲线（<=90天/小时级）或 7×W 矩阵热力图（>90天，支持日/周/月/全部四档）。
   */
  function update(series = [], opts = {}) {
    if (opts && opts.heatmapMode !== undefined) {
      const nextHmMode = normalizeHeatmapMode(opts.heatmapMode);
      if (nextHmMode !== currentHmMode) {
        clearHover();
        currentHmMode = nextHmMode;
      }
    }
    if (opts && typeof opts.buildModelSegments === 'function') {
      lastBuildSegmentsFn = opts.buildModelSegments;
    }

    const slots =
      Array.isArray(series) && series.length >= 1
        ? series
        : [
            { label: '00:00', fullLabel: '00:00 - 01:00', tokens: 0, calls: 0, costUsd: 0 },
            { label: '06:00', fullLabel: '06:00 - 07:00', tokens: 0, calls: 0, costUsd: 0 },
            { label: '12:00', fullLabel: '12:00 - 13:00', tokens: 0, calls: 0, costUsd: 0 },
            { label: '18:00', fullLabel: '18:00 - 19:00', tokens: 0, calls: 0, costUsd: 0 },
          ];
    currentSlots = slots;

    const isHourly =
      slots[0]?.granularity === 'hour' ||
      slots[0]?.granularity === 'minute' ||
      String(slots[0]?.label || '').includes(':');
    const useHeatmap = !isHourly && slots.length > HEATMAP_DAYS_THRESHOLD;
    const modeChanged = useHeatmap !== currentIsHeatmap;
    currentIsHeatmap = useHeatmap;

    if (modeChanged) {
      clearHover();
      curveMorphCtrl.cancel();
    }
    patchClasses(chartWrap, { 'is-heatmap': useHeatmap });
    patchAttr(plotStage, 'hidden', useHeatmap);
    patchAttr(xAxisEl, 'hidden', useHeatmap);
    patchAttr(heatmapStage, 'hidden', !useHeatmap);

    if (!useHeatmap) {
      syncViewWidth();
    }

    let maxTokens = 0;
    let peakIdx = 0;
    let activeDays = 0;
    const nonZeroVals = [];

    for (let i = 0; i < slots.length; i++) {
      const tokVal = safeSlotTokens(slots[i]?.tokens);
      if (tokVal > 0) {
        activeDays++;
        nonZeroVals.push(tokVal);
      }
      if (tokVal >= maxTokens) {
        maxTokens = tokVal;
        peakIdx = i;
      }
    }
    currentMaxTokens = maxTokens;

    const locale = getEffectiveLocale();
    patchText(wdayMonEl, t('chart.trend.wdayMon'));
    patchText(wdayWedEl, t('chart.trend.wdayWed'));
    patchText(wdayFriEl, t('chart.trend.wdayFri'));
    patchText(wdaySunEl, t('chart.trend.wdaySun'));
    patchAttr(hmGridEl, 'aria-label', t('chart.trend.hmAria'));
    patchText(hmLessEl, t('chart.trend.hmLess'));
    patchText(hmMoreEl, t('chart.trend.hmMore'));

    const sig =
      `${locale}|${useHeatmap ? `hm:${currentHmMode}` : `line:${viewW}`}|` +
      slots
        .map((s) => {
          const mSig = Array.isArray(s?.modelSegments)
            ? s.modelSegments
                .map(
                  (m) =>
                    `${m.key}:${m.color}:${m.pctText}:${m.inputTokens || 0}:${m.cacheReadTokens || 0}:${m.thinkingTokens || 0}:${m.responseTokens || 0}`
                )
                .join(',')
            : '';
          const mergedCnt = Array.isArray(s?.mergedModels) ? s.mergedModels.length : 0;
          return `${s?.startMs || ''}:${s?.label || ''}:${s?.fullLabel || ''}:${safeSlotTokens(s?.tokens)}:${safeSlotTokens(s?.inputTokens)}:${safeSlotTokens(s?.cacheReadTokens)}:${safeSlotTokens(s?.thinkingTokens)}:${safeSlotTokens(s?.responseTokens)}:${Number(s?.costUsd || 0)}:${Number(s?.calls || 0)}:${mergedCnt}:${mSig}`;
        })
        .join('|');

    if (useHeatmap) {
      currentPts = [];
      const isBarMode = currentHmMode !== 'day';
      hmWeekdaysEl.style.visibility = isBarMode ? 'hidden' : '';
      patchClasses(heatmapStage, { 'is-bar-mode': isBarMode });

      if (sig !== lastRenderSig) {
        lastRenderSig = sig;
        const firstStartMs = Number(slots[0]?.startMs);
        const firstDow =
          Number.isFinite(firstStartMs) && firstStartMs > 0
            ? (new Date(firstStartMs).getDay() + 6) % 7
            : 0;
        const totalCells = firstDow + slots.length;
        const totalWeeks = Math.max(1, Math.ceil(totalCells / 7));
        const gapPx = totalWeeks > 42 ? 1.5 : 2;
        const shouldAutoScrollRight = modeChanged || currentHeatmapWeeks !== totalWeeks;
        currentHeatmapWeeks = totalWeeks;
        currentHeatmapFirstDow = firstDow;
        currentHeatmapGapPx = gapPx;

        patchStyleVar(hmBodyEl, '--hm-weeks', String(totalWeeks));
        patchStyleVar(hmBodyEl, '--hm-gap', `${gapPx}px`);

        // 就地增量补丁顶部对齐月份标签，避免文字节点销毁重建
        const monthTicks = buildHeatmapMonthTicks(slots, firstDow, totalWeeks);
        for (let i = 0; i < monthTicks.length; i++) {
          const mt = monthTicks[i];
          let mEl = hmMonthPool[i];
          if (!mEl) {
            mEl = h('span', { className: 'trend-hm-month text-mono' });
            hmMonthPool.push(mEl);
          }
          patchText(mEl, mt.text);
          patchStyleVar(mEl, '--hm-col', String(mt.col));
          if (hmMonthsEl.children[i] !== mEl) {
            hmMonthsEl.insertBefore(mEl, hmMonthsEl.children[i] || null);
          }
        }
        while (hmMonthsEl.children.length > monthTicks.length) {
          hmMonthsEl.removeChild(hmMonthsEl.lastChild);
        }

        const prevMountedCount = hmGridEl.children.length;

        if (!isBarMode) {
          nonZeroVals.sort((a, b) => a - b);
          const thresholds = computeHeatmapThresholds(nonZeroVals, maxTokens);

          // 就地增量复用 7 行 × N 周列的每日小格子，首次批量新增节点使用 DocumentFragment 挂载
          currentCellEls = new Array(slots.length);
          const newCellsFrag =
            totalCells > prevMountedCount &&
            typeof document !== 'undefined' &&
            typeof document.createDocumentFragment === 'function'
              ? document.createDocumentFragment()
              : null;

          for (let nodeIdx = 0; nodeIdx < totalCells; nodeIdx++) {
            let cellEl = hmCellPool[nodeIdx];
            if (!cellEl) {
              cellEl = h('span', { className: 'trend-hm-cell' });
              hmCellPool.push(cellEl);
            }
            if (nodeIdx < firstDow) {
              patchClasses(cellEl, {
                'is-pad': true,
                'is-hovered': false,
                'is-bar-hovered': false,
                'is-month-edge': false,
                'lv-0': false,
                'lv-1': false,
                'lv-2': false,
                'lv-3': false,
                'lv-4': false,
              });
              patchAttr(cellEl, 'aria-hidden', 'true');
              patchAttr(cellEl, 'role', null);
              patchAttr(cellEl, 'data-slot-idx', null);
              patchAttr(cellEl, 'data-hm-col', null);
              patchAttr(cellEl, 'data-hm-row', null);
            } else {
              const i = nodeIdx - firstDow;
              const slot = slots[i];
              const tok = safeSlotTokens(slot?.tokens);
              const lv = resolveHeatmapLevel(tok, thresholds);
              const col = Math.floor(nodeIdx / 7);
              const row = nodeIdx % 7;
              patchClasses(cellEl, {
                'is-pad': false,
                'is-hovered': hoveredIdx === i,
                'is-bar-hovered': false,
                'is-month-edge': false,
                'lv-0': lv === 0,
                'lv-1': lv === 1,
                'lv-2': lv === 2,
                'lv-3': lv === 3,
                'lv-4': lv === 4,
              });
              patchAttr(cellEl, 'aria-hidden', null);
              patchAttr(cellEl, 'role', 'gridcell');
              patchAttr(cellEl, 'data-slot-idx', String(i));
              patchAttr(cellEl, 'data-hm-col', String(col));
              patchAttr(cellEl, 'data-hm-row', String(row));
              currentCellEls[i] = cellEl;
            }
            if (nodeIdx < prevMountedCount) {
              if (hmGridEl.children[nodeIdx] !== cellEl) {
                hmGridEl.insertBefore(cellEl, hmGridEl.children[nodeIdx] || null);
              }
            } else if (newCellsFrag) {
              newCellsFrag.appendChild(cellEl);
            } else {
              hmGridEl.appendChild(cellEl);
            }
          }
          if (newCellsFrag) {
            hmGridEl.appendChild(newCellsFrag);
          }
          while (hmGridEl.children.length > totalCells) {
            hmGridEl.removeChild(hmGridEl.lastChild);
          }

          currentHmBuckets = slots;
          currentHmBucketCells = currentCellEls.map((el) => (el ? [el] : []));
          currentHmAnchorCells = currentCellEls.slice();
          currentColBucketIdx = [];
          hoveredCellEl =
            hoveredIdx >= 0 && hoveredIdx < slots.length ? currentCellEls[hoveredIdx] || null : null;
          hoveredHighlightEls = hoveredCellEl ? [hoveredCellEl] : [];

          const peakSlot = slots[peakIdx];
          lastHeatmapSummaryText =
            maxTokens > 0 && peakSlot?.label
              ? t('chart.trend.hmActivePeak', {
                  active: activeDays,
                  total: slots.length,
                  label: peakSlot.label,
                  tokens: formatTokensPrecise(maxTokens),
                })
              : t('chart.trend.hmActiveZero', { total: slots.length });
        } else {
          // 周 / 月 / 全部柱阵模式：保持 7 行 × N 周列点阵几何不变，自底向上点亮对应格数
          const barView = buildHeatmapBarView(
            slots,
            firstDow,
            totalWeeks,
            currentHmMode,
            lastBuildSegmentsFn
          );
          const totalGridCells = totalWeeks * 7;
          currentCellEls = [];
          currentHmBuckets = barView.buckets;
          currentColBucketIdx = barView.colSpecs.map((s) => s.bucketIdx);

          const bucketCount = barView.buckets.length;
          const bucketLitCells = Array.from({ length: bucketCount }, () => []);
          const bucketBottomCells = Array.from({ length: bucketCount }, () => []);
          const bucketTopRowCells = Array.from({ length: bucketCount }, () => []);

          const newCellsFrag =
            totalGridCells > prevMountedCount &&
            typeof document !== 'undefined' &&
            typeof document.createDocumentFragment === 'function'
              ? document.createDocumentFragment()
              : null;

          for (let nodeIdx = 0; nodeIdx < totalGridCells; nodeIdx++) {
            let cellEl = hmCellPool[nodeIdx];
            if (!cellEl) {
              cellEl = h('span', { className: 'trend-hm-cell' });
              hmCellPool.push(cellEl);
            }
            const col = Math.floor(nodeIdx / 7);
            const row = nodeIdx % 7;
            const spec = barView.colSpecs[col] || {
              bucketIdx: 0,
              litRows: 0,
              lv: 0,
              isMonthEdge: false,
            };
            const bIdx = spec.bucketIdx;
            const topLitRow = spec.litRows > 0 ? 7 - spec.litRows : 6;
            const isLit = spec.litRows > 0 && row >= topLitRow;
            const lv = isLit ? spec.lv : 0;
            const isBarHovered =
              hoveredIdx === bIdx && (isLit || (spec.litRows === 0 && row === 6));

            patchClasses(cellEl, {
              'is-pad': false,
              'is-hovered': false,
              'is-bar-hovered': isBarHovered,
              'is-month-edge': Boolean(spec.isMonthEdge),
              'lv-0': lv === 0,
              'lv-1': lv === 1,
              'lv-2': lv === 2,
              'lv-3': lv === 3,
              'lv-4': lv === 4,
            });
            patchAttr(cellEl, 'aria-hidden', null);
            patchAttr(cellEl, 'role', 'gridcell');
            patchAttr(cellEl, 'data-slot-idx', String(bIdx));
            patchAttr(cellEl, 'data-hm-col', String(col));
            patchAttr(cellEl, 'data-hm-row', String(row));

            if (bIdx >= 0 && bIdx < bucketCount) {
              if (isLit) bucketLitCells[bIdx].push(cellEl);
              if (row === 6) bucketBottomCells[bIdx].push(cellEl);
              if (row === topLitRow) bucketTopRowCells[bIdx].push(cellEl);
            }

            if (nodeIdx < prevMountedCount) {
              if (hmGridEl.children[nodeIdx] !== cellEl) {
                hmGridEl.insertBefore(cellEl, hmGridEl.children[nodeIdx] || null);
              }
            } else if (newCellsFrag) {
              newCellsFrag.appendChild(cellEl);
            } else {
              hmGridEl.appendChild(cellEl);
            }
          }
          if (newCellsFrag) {
            hmGridEl.appendChild(newCellsFrag);
          }
          while (hmGridEl.children.length > totalGridCells) {
            hmGridEl.removeChild(hmGridEl.lastChild);
          }

          currentHmBucketCells = barView.buckets.map((_, bIdx) =>
            bucketLitCells[bIdx].length > 0 ? bucketLitCells[bIdx] : bucketBottomCells[bIdx]
          );
          currentHmAnchorCells = barView.buckets.map((_, bIdx) => {
            const tops = bucketTopRowCells[bIdx];
            return tops.length > 0 ? tops[Math.floor(tops.length / 2)] : null;
          });
          hoveredCellEl =
            hoveredIdx >= 0 && hoveredIdx < bucketCount
              ? currentHmAnchorCells[hoveredIdx] || null
              : null;
          hoveredHighlightEls =
            hoveredIdx >= 0 && hoveredIdx < bucketCount
              ? currentHmBucketCells[hoveredIdx] || []
              : [];
          lastHeatmapSummaryText = barView.summaryText;
        }

        if (shouldAutoScrollRight && typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => {
            if (hmScrollEl.scrollWidth > hmScrollEl.clientWidth) {
              hmScrollEl.scrollLeft = hmScrollEl.scrollWidth;
            }
          });
        }
      } else if (currentHmMode === 'day') {
        const peakSlot = slots[peakIdx];
        lastHeatmapSummaryText =
          maxTokens > 0 && peakSlot?.label
            ? t('chart.trend.hmActivePeak', {
                active: activeDays,
                total: slots.length,
                label: peakSlot.label,
                tokens: formatTokensPrecise(maxTokens),
              })
            : t('chart.trend.hmActiveZero', { total: slots.length });
      }

      patchText(hmSummaryEl, lastHeatmapSummaryText);

      if (hoveredIdx >= currentHmBuckets.length) {
        clearHover();
      } else if (hoveredIdx >= 0) {
        if (!tooltipEl.hasAttribute('hidden') && currentHmBuckets[hoveredIdx]) {
          populateTooltipContent(currentHmBuckets[hoveredIdx]);
        }
        showHeatmapHoverAtIndex(hoveredIdx, currentHmAnchorCells[hoveredIdx], lastPointer);
      }
      return;
    }

    if (hoveredIdx >= 0 && hoveredIdx < slots.length && !tooltipEl.hasAttribute('hidden')) {
      populateTooltipContent(slots[hoveredIdx]);
    }

    // --- <= 90 天（或整点/分钟级）：渲染平滑面积曲线图（1:1 贴边对齐 + 连续插值形变过渡） ---
    currentCellEls = [];
    const { leftX, rightX, spanX } = resolvePlotBounds(viewW);
    const denom = Math.max(1, maxTokens);
    const isSingle = slots.length === 1;
    const pts = slots.map((s, idx) => {
      const tok = safeSlotTokens(s?.tokens);
      const x = isSingle
        ? (leftX + rightX) / 2
        : leftX + (idx / Math.max(1, slots.length - 1)) * spanX;
      const ratio = maxTokens > 0 ? tok / denom : 0;
      const y = BOTTOM_Y - ratio * SPAN_Y;
      return { x, y, tokens: tok };
    });
    currentPts = pts;

    const nextSegs = pointsToNormalizedCubicSegs(pts, BOTTOM_Y);

    if (sig !== lastRenderSig) {
      lastRenderSig = sig;
      let lineD;
      let areaD;
      if (isSingle) {
        if (maxTokens > 0) {
          lineD = buildSmoothSplinePath([
            { x: leftX, y: BOTTOM_Y },
            pts[0],
            { x: rightX, y: BOTTOM_Y },
          ]);
        } else {
          const yStr = pts[0].y.toFixed(1);
          lineD = `M ${leftX.toFixed(1)} ${yStr} L ${rightX.toFixed(1)} ${yStr}`;
        }
        areaD = `${lineD} L ${rightX.toFixed(1)} ${BOTTOM_Y} L ${leftX.toFixed(1)} ${BOTTOM_Y} Z`;
      } else {
        lineD = buildSmoothSplinePath(pts);
        areaD = `${lineD} L ${pts[pts.length - 1].x.toFixed(1)} ${BOTTOM_Y} L ${pts[0].x.toFixed(1)} ${BOTTOM_Y} Z`;
      }

      curveMorphCtrl.morphTo({
        nextSegs,
        leftX,
        spanX,
        bottomY: BOTTOM_Y,
        linePath,
        areaPath,
        finalLineD: lineD,
        finalAreaD: areaD,
        skipMorph: modeChanged,
      });

      // 就地增量补丁垂直参考网格线及底部 X 轴标签，保持文字常驻不重排不闪烁
      const tickIndices = computeTickIndices(slots);
      tickElsByIdx = new Map();
      let vLineCount = 0;
      let tickCount = 0;

      for (let i = 0; i < tickIndices.length; i++) {
        const tIdx = tickIndices[i];
        const pt = pts[tIdx];
        const slot = slots[tIdx];
        if (!pt || !slot) continue;

        if (i > 0 && i < tickIndices.length - 1) {
          let vLine = vGridLinePool[vLineCount];
          if (!vLine) {
            vLine = document.createElementNS(SVG_NS, 'line');
            vLine.setAttribute('y1', '16');
            vLine.setAttribute('y2', String(BOTTOM_Y));
            vGridLinePool.push(vLine);
          }
          const xFixed = pt.x.toFixed(1);
          patchAttr(vLine, 'x1', xFixed);
          patchAttr(vLine, 'x2', xFixed);
          if (vGridGroup.children[vLineCount] !== vLine) {
            vGridGroup.insertBefore(vLine, vGridGroup.children[vLineCount] || null);
          }
          vLineCount++;
        }

        const isFirst = !isSingle && i === 0;
        const isLast = !isSingle && i === tickIndices.length - 1;
        const pct = isFirst ? 0 : isLast ? 100 : (pt.x / viewW) * 100;
        let tickRec = xAxisTickPool[tickCount];
        if (!tickRec) {
          const el = h('span', { className: 'trend-x-tick text-mono' });
          const rec = { el, slotIdx: tIdx };
          el.onclick = () => {
            lastPointer = null;
            showLineHoverAtIndex(rec.slotIdx);
          };
          tickRec = rec;
          xAxisTickPool.push(tickRec);
        }
        tickRec.slotIdx = tIdx;
        patchClasses(tickRec.el, {
          'is-start': isFirst,
          'is-end': isLast,
          'is-hovered': hoveredIdx === tIdx,
        });
        patchText(tickRec.el, slot.label || '');
        patchAttr(tickRec.el, 'title', formatTrendSlotFullLabel(slot) || slot.label || '');
        patchStyleVar(tickRec.el, '--tick-x', `${pct.toFixed(2)}%`);
        if (xAxisEl.children[tickCount] !== tickRec.el) {
          xAxisEl.insertBefore(tickRec.el, xAxisEl.children[tickCount] || null);
        }
        tickElsByIdx.set(tIdx, tickRec.el);
        tickCount++;
      }

      while (vGridGroup.children.length > vLineCount) {
        vGridGroup.removeChild(vGridGroup.lastChild);
      }
      while (xAxisEl.children.length > tickCount) {
        xAxisEl.removeChild(xAxisEl.lastChild);
      }
    }

    if (maxTokens > 0) {
      const peakPt = pts[peakIdx] || { x: viewW / 2, y: BOTTOM_Y };
      const peakSlot = slots[peakIdx];
      const peakText = peakSlot?.label
        ? t('chart.trend.peakPill', {
            label: peakSlot.label,
            tokens: formatTokensPrecise(maxTokens),
          })
        : formatTokensPrecise(maxTokens);
      patchText(peakPill, peakText);
      const pctLeft = Math.max(12, Math.min(88, (peakPt.x / viewW) * 100));
      patchStyleVar(peakPill, '--peak-x', `${pctLeft.toFixed(1)}%`);
      peakReadyArmer.arm();
      if (hoveredIdx < 0) {
        patchAttr(peakPill, 'hidden', false);
      }
    } else {
      patchAttr(peakPill, 'hidden', true);
    }

    if (hoveredIdx >= slots.length) {
      clearHover();
    } else if (hoveredIdx >= 0) {
      showLineHoverAtIndex(hoveredIdx, lastPointer);
    }
  }

  function setHeatmapMode(nextMode) {
    const norm = normalizeHeatmapMode(nextMode);
    if (norm === currentHmMode) return;
    clearHover();
    currentHmMode = norm;
    if (currentSlots.length > 0) {
      update(currentSlots);
    }
  }

  return {
    el: chartWrap,
    update,
    setHeatmapMode,
    getHeatmapMode: () => currentHmMode,
    destroy,
  };
}
