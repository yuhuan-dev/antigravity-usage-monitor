/**
 * @fileoverview 通用 4 段式 Token 构成比例条组件 (FourSegmentBar).
 * 用于在消费概览、热门模型明细及数据来源明细中直观展示：
 * 直接输入 (Input)、缓存读取 (Cached)、内容生成 (Output) 与思考推理 (Thinking) 的 Token 占比。
 */

import { h, patchStyleVar } from '../../core/domPatch.js';

/**
 * 创建 4 段式水平比例进度条实例。
 * 通过动态更新各分段节点的 `--seg-w` CSS 变量实现零重排平滑过渡。
 *
 * @returns {{
 *   el: HTMLElement,
 *   update: (metrics: {
 *     inputTokens?: number,
 *     cacheReadTokens?: number,
 *     responseTokens?: number,
 *     thinkingTokens?: number,
 *     scaleMax?: number
 *   }) => void
 * }} 组件根元素与增量更新方法
 */
export function createFourSegmentBar() {
  const segInput = h('div', { className: 'progress-seg seg-input' });
  const segCached = h('div', { className: 'progress-seg seg-cached' });
  const segOutput = h('div', { className: 'progress-seg seg-output' });
  const segThinking = h('div', { className: 'progress-seg seg-thinking' });
  const el = h('div', { className: 'progress-track cons-seg-bar' }, [
    segInput,
    segCached,
    segOutput,
    segThinking,
  ]);

  /**
   * 根据四类 Token 数量重新计算并写入各分段百分比宽度；
   * 若传入大于 0 的 `scaleMax`，则整条叠加宽度按 `total / scaleMax` 相对缩放，用于跨条目总量直观对比。
   */
  function update({
    inputTokens = 0,
    cacheReadTokens = 0,
    responseTokens = 0,
    thinkingTokens = 0,
    scaleMax = 0,
  }) {
    const total = inputTokens + cacheReadTokens + responseTokens + thinkingTokens;
    if (total <= 0) {
      patchStyleVar(segInput, '--seg-w', '0%');
      patchStyleVar(segCached, '--seg-w', '0%');
      patchStyleVar(segOutput, '--seg-w', '0%');
      patchStyleVar(segThinking, '--seg-w', '0%');
      return;
    }
    const maxRef = Number(scaleMax || 0);
    const barSpanPct =
      maxRef > 0 ? Math.min(100, Math.max(1.2, (total / maxRef) * 100)) : 100;
    patchStyleVar(segInput, '--seg-w', `${((inputTokens / total) * barSpanPct).toFixed(2)}%`);
    patchStyleVar(segCached, '--seg-w', `${((cacheReadTokens / total) * barSpanPct).toFixed(2)}%`);
    patchStyleVar(segOutput, '--seg-w', `${((responseTokens / total) * barSpanPct).toFixed(2)}%`);
    patchStyleVar(
      segThinking,
      '--seg-w',
      `${((thinkingTokens / total) * barSpanPct).toFixed(2)}%`
    );
  }

  return { el, update };
}
