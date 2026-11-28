/**
 * @fileoverview Pure vector SVG icon registry (16x16 grid).
 * Strictly zero emoji characters anywhere in the codebase.
 */

export const SVG_ICON_DEFS = Object.freeze({
  pulse: [
    { tag: 'path', attrs: { d: 'M1.5 8h2.5l2.2-5.5 3.6 11 2.2-5.5h2.5' } },
  ],
  bolt: [
    { tag: 'path', attrs: { d: 'M9.2 1.5L3.5 9h4.2l-.9 5.5L12.5 7H8.3l.9-5.5z' } },
  ],
  refresh: [
    { tag: 'path', attrs: { d: 'M13.5 8a5.5 5.5 0 1 1-1.4-3.7' } },
    { tag: 'path', attrs: { d: 'M13.5 2.2v2.6h-2.6' } },
  ],
  check: [
    { tag: 'path', attrs: { d: 'M3 8.5l3.2 3.2L13 4.8' } },
  ],
  warning: [
    { tag: 'path', attrs: { d: 'M8 2.2L1.8 13.2h12.4L8 2.2z' } },
    { tag: 'path', attrs: { d: 'M8 6.2v3.4' } },
    { tag: 'circle', attrs: { cx: '8', cy: '11.5', r: '0.6', fill: 'currentColor', stroke: 'none' } },
  ],
  'help-circle': [
    { tag: 'circle', attrs: { cx: '8', cy: '8', r: '6' } },
    { tag: 'path', attrs: { d: 'M6.2 6.3a1.9 1.9 0 0 1 3.6.7c0 1.15-1.8 1.35-1.8 2.5' } },
    { tag: 'circle', attrs: { cx: '8', cy: '11.8', r: '0.65', fill: 'currentColor', stroke: 'none' } },
  ],
  'chevron-down': [
    { tag: 'path', attrs: { d: 'M4 6.2l4 4 4-4' } },
  ],
  'chevron-up': [
    { tag: 'path', attrs: { d: 'M4 9.8l4-4 4 4' } },
  ],
  'chevron-right': [
    { tag: 'path', attrs: { d: 'M6.2 4l4 4-4 4' } },
  ],
  'chevron-left': [
    { tag: 'path', attrs: { d: 'M9.8 4l-4 4 4 4' } },
  ],
  layers: [
    { tag: 'path', attrs: { d: 'M8 2L2 5.2 8 8.4l6-3.2L8 2z' } },
    { tag: 'path', attrs: { d: 'M2 8.2L8 11.4l6-3.2' } },
    { tag: 'path', attrs: { d: 'M2 11.2L8 14.4l6-3.2' } },
  ],
  'chart-bar': [
    { tag: 'path', attrs: { d: 'M2 13.5h12' } },
    { tag: 'path', attrs: { d: 'M4.5 13.5V7.5' } },
    { tag: 'path', attrs: { d: 'M8 13.5V2.5' } },
    { tag: 'path', attrs: { d: 'M11.5 13.5V5.2' } },
  ],
  table: [
    { tag: 'rect', attrs: { x: '2', y: '2.5', width: '12', height: '11', rx: '1.5' } },
    { tag: 'path', attrs: { d: 'M2 6.2h12' } },
    { tag: 'path', attrs: { d: 'M6.2 6.2v7.3' } },
  ],
  sliders: [
    { tag: 'path', attrs: { d: 'M2 3.5h2M7 3.5h7' } },
    { tag: 'path', attrs: { d: 'M2 8h7M12 8h2' } },
    { tag: 'path', attrs: { d: 'M2 12.5h3.3M8.3 12.5H14' } },
    { tag: 'circle', attrs: { cx: '5.5', cy: '3.5', r: '1.5' } },
    { tag: 'circle', attrs: { cx: '10.5', cy: '8', r: '1.5' } },
    { tag: 'circle', attrs: { cx: '6.8', cy: '12.5', r: '1.5' } },
  ],
  calendar: [
    { tag: 'rect', attrs: { x: '2.2', y: '3.2', width: '11.6', height: '10.6', rx: '1' } },
    { tag: 'path', attrs: { d: 'M5.2 1.8v2.4M10.8 1.8v2.4M2.2 6.5h11.6' } },
  ],
  clock: [
    { tag: 'circle', attrs: { cx: '8', cy: '8', r: '5.8' } },
    { tag: 'path', attrs: { d: 'M8 4.8v3.5l2.4 1.5' } },
  ],
  plus: [
    { tag: 'path', attrs: { d: 'M8 3.5v9M3.5 8h9' } },
  ],
  minus: [
    { tag: 'path', attrs: { d: 'M3.5 8h9' } },
  ],
  dot: [
    { tag: 'circle', attrs: { cx: '8', cy: '8', r: '5', fill: 'currentColor', stroke: 'none' } },
  ],
  'arrow-down': [
    { tag: 'path', attrs: { d: 'M8 2.8v10.4M4.2 9.4L8 13.2l3.8-3.8' } },
  ],
  'arrow-up': [
    { tag: 'path', attrs: { d: 'M8 13.2V2.8M4.2 6.6L8 2.8l3.8 3.8' } },
  ],
  dock: [
    { tag: 'rect', attrs: { x: '1.8', y: '2.5', width: '12.4', height: '11', rx: '1.5' } },
    { tag: 'path', attrs: { d: 'M1.8 6h12.4' } },
    { tag: 'path', attrs: { d: 'M9.2 4.25h3.2' } },
  ],
  close: [
    { tag: 'path', attrs: { d: 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6' } },
  ],
  copy: [
    { tag: 'rect', attrs: { x: '5.2', y: '5.2', width: '8.3', height: '8.3', rx: '1.3' } },
    { tag: 'path', attrs: { d: 'M3.5 10.8H2.8a1.3 1.3 0 0 1-1.3-1.3V3.3A1.3 1.3 0 0 1 2.8 2h6.2a1.3 1.3 0 0 1 1.3 1.3v.7' } },
  ],
  search: [
    { tag: 'circle', attrs: { cx: '7.2', cy: '7.2', r: '4.5' } },
    { tag: 'path', attrs: { d: 'M10.6 10.6L14 14' } },
  ],
  download: [
    { tag: 'path', attrs: { d: 'M8 2.4v7.6M5 7.2L8 10.2l3-3' } },
    { tag: 'path', attrs: { d: 'M2.6 11.4v1.4a1 1 0 0 0 1 1h8.8a1 1 0 0 0 1-1v-1.4' } },
  ],
  upload: [
    { tag: 'path', attrs: { d: 'M8 10.2V2.6M5 5.4L8 2.4l3 3' } },
    { tag: 'path', attrs: { d: 'M2.6 11.4v1.4a1 1 0 0 0 1 1h8.8a1 1 0 0 0 1-1v-1.4' } },
  ],
  'more-vertical': [
    { tag: 'circle', attrs: { cx: '8', cy: '3.6', r: '1.15', fill: 'currentColor', stroke: 'none' } },
    { tag: 'circle', attrs: { cx: '8', cy: '8', r: '1.15', fill: 'currentColor', stroke: 'none' } },
    { tag: 'circle', attrs: { cx: '8', cy: '12.4', r: '1.15', fill: 'currentColor', stroke: 'none' } },
  ],
  folder: [
    {
      tag: 'path',
      attrs: {
        d: 'M2.2 4.3a1.3 1.3 0 0 1 1.3-1.3h3l1.3 1.5h4.7a1.3 1.3 0 0 1 1.3 1.3v5.9a1.3 1.3 0 0 1-1.3 1.3H3.5a1.3 1.3 0 0 1-1.3-1.3V4.3z',
      },
    },
  ],
  grip: [
    { tag: 'circle', attrs: { cx: '6', cy: '4', r: '1.05', fill: 'currentColor', stroke: 'none' } },
    { tag: 'circle', attrs: { cx: '10', cy: '4', r: '1.05', fill: 'currentColor', stroke: 'none' } },
    { tag: 'circle', attrs: { cx: '6', cy: '8', r: '1.05', fill: 'currentColor', stroke: 'none' } },
    { tag: 'circle', attrs: { cx: '10', cy: '8', r: '1.05', fill: 'currentColor', stroke: 'none' } },
    { tag: 'circle', attrs: { cx: '6', cy: '12', r: '1.05', fill: 'currentColor', stroke: 'none' } },
    { tag: 'circle', attrs: { cx: '10', cy: '12', r: '1.05', fill: 'currentColor', stroke: 'none' } },
  ],
  lock: [
    { tag: 'rect', attrs: { x: '3', y: '7', width: '10', height: '7', rx: '1.5' } },
    { tag: 'path', attrs: { d: 'M5.2 7V5.1a2.8 2.8 0 0 1 5.6 0V7' } },
    { tag: 'circle', attrs: { cx: '8', cy: '10.5', r: '0.9', fill: 'currentColor', stroke: 'none' } },
  ],
  unlock: [
    { tag: 'rect', attrs: { x: '3', y: '7', width: '10', height: '7', rx: '1.5' } },
    { tag: 'path', attrs: { d: 'M5.2 7V5.1a2.8 2.8 0 0 1 5.3-1.2' } },
  ],
  globe: [
    { tag: 'circle', attrs: { cx: '8', cy: '8', r: '6' } },
    { tag: 'ellipse', attrs: { cx: '8', cy: '8', rx: '2.7', ry: '6' } },
    { tag: 'path', attrs: { d: 'M2.3 6h11.4M2.3 10h11.4' } },
  ],
  terminal: [
    { tag: 'rect', attrs: { x: '2', y: '3', width: '12', height: '10', rx: '1.8' } },
    { tag: 'path', attrs: { d: 'M4.8 6.4 7 8.2 4.8 10M8.4 10h2.8' } },
  ],
  trash: [
    { tag: 'path', attrs: { d: 'M2.8 4.5h10.4' } },
    { tag: 'path', attrs: { d: 'M6 4.5V3.1a.9.9 0 0 1 .9-.9h2.2a.9.9 0 0 1 .9.9v1.4' } },
    { tag: 'path', attrs: { d: 'M4.2 4.5l.6 8.4a1.1 1.1 0 0 0 1.1 1h4.2a1.1 1.1 0 0 0 1.1-1l.6-8.4' } },
    { tag: 'path', attrs: { d: 'M6.6 7.2v4.2M9.4 7.2v4.2' } },
  ],
  shield: [
    { tag: 'path', attrs: { d: 'M8 2L3 4v3.8c0 3.1 2.1 5.3 5 6.2 2.9-.9 5-3.1 5-6.2V4L8 2z' } },
    { tag: 'path', attrs: { d: 'M6 8l1.4 1.4L10.3 6.5' } },
  ],
  database: [
    { tag: 'ellipse', attrs: { cx: '8', cy: '4', rx: '5', ry: '1.8' } },
    { tag: 'path', attrs: { d: 'M3 4v8c0 1 2.24 1.8 5 1.8s5-.8 5-1.8V4' } },
    { tag: 'path', attrs: { d: 'M3 8c0 1 2.24 1.8 5 1.8s5-.8 5-1.8' } },
  ],
});
