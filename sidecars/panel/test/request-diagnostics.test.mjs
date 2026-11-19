import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockDom } from './mock-dom.mjs';
import { StepTableWidget } from '../src/components/widgets/StepTableWidget.js';
import { extractModelSteps } from '../trajectory-metrics.mjs';
import { buildRequestDiagnostics } from '../src/core/requestDiagnostics.js';

function fixture() {
  const start = '2026-11-13T07:03:57Z';
  return [{
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE',
    metadata: { createdAt: start, finishedGeneratingAt: '2026-11-13T07:05:56.370Z',
      modelUsage: { inputTokens: 45030, cacheReadTokens: 0, outputTokens: 270 },
      generatorMetadata: [{ chatModel: { timeToFirstToken: '119.167s', streamingDuration: '0.203s' } }] },
    plannerResponse: { thinkingDuration: '119.266s', toolCalls: [{ name: 'call_mcp_tool', arguments: 'secret_tool_args' }] },
  }, { type: 'CORTEX_STEP_TYPE_GENERIC', status: 'CORTEX_STEP_STATUS_ERROR',
    metadata: {}, content: 'missing required parameter: method; secret_error_content' }];
}

test('exports slow tool-call timing without tool arguments or error content', () => {
  const step = extractModelSteps(fixture())[0];
  const report = buildRequestDiagnostics(step);
  assert.equal(report.timingSeconds.timeToFirstToken, 119.167);
  assert.equal(report.timingSeconds.afterFirstToken, 0.203);
  assert.deepEqual(report.rawMetadata.toolNames, ['call_mcp_tool']);
  assert.equal(report.rawMetadata.status, 'CORTEX_STEP_STATUS_DONE');
  assert.equal(report.rawMetadata.retryInfoCount, null);
  assert.deepEqual(report.notes, ['long_first_token_wait', 'zero_cache_read_recorded', 'tool_call_returned_in_short_interval']);
  assert.doesNotMatch(JSON.stringify(report), /secret_tool_args|secret_error_content/);
});

test('unknown timing and old cache remain unknown; no fabricated network timings or rates', () => {
  const report = buildRequestDiagnostics({stepIndex: 1, nativeTtftSec: null});
  assert.equal(report.rawMetadata, null);
  assert.equal(report.timingSeconds.afterFirstToken, null);
  assert.equal(report.timingSeconds.timeToFirstToken, null);
  const rows = fixture(); rows[0].metadata.retryInfos = [{usage: {}, token: 'secret'}];
  assert.equal(extractModelSteps(rows)[0].requestDiagnostics.retryInfoCount, 1);
  assert.doesNotMatch(JSON.stringify(buildRequestDiagnostics(extractModelSteps(rows)[0])), /secret/);
});


test('export allowlist excludes extra metadata, anomaly messages and non-finite measurements', () => {
  const report = buildRequestDiagnostics({
    stepIndex: 7, nativeTtftSec: 20, totalDurationSec: 10,
    outputTokens: Infinity, thinkingTokens: NaN,
    requestDiagnostics: { createdAt: '2026-11-19T00:00:00Z', token: 'secret_token',
      arguments: 'secret_arguments', retryInfoCount: 0 },
    anomaly: { count: 1, primaryKind: 'timeout', events: [{ message: 'secret_prompt' }] },
  });
  assert.equal(report.timingSeconds.afterFirstToken, null);
  assert.equal(report.tokens.output, null);
  assert.equal(report.tokens.thinking, null);
  assert.equal(report.rawMetadata.retryInfoCount, 0);
  assert.doesNotMatch(JSON.stringify(report), /secret_/);
});


test('TTFT diagnostic button follows replaced row data and remains keyboard accessible', () => {
  const keys = ['document', 'window', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver'];
  const previous = keys.map((key) => globalThis[key]);
  const { document } = createMockDom();
  Object.assign(globalThis, {
    document,
    window: { innerWidth: 960, innerHeight: 720, getComputedStyle: () => ({ getPropertyValue: () => '' }),
      addEventListener() {}, removeEventListener() {} },
    requestAnimationFrame: (fn) => { fn(); return 1; }, cancelAnimationFrame() {},
    ResizeObserver: class { observe() {} disconnect() {} },
  });
  let widget;
  try {
    let inspected;
    widget = StepTableWidget({ standalone: true, onInspectRequest: (step) => { inspected = step; } });
    const options = { hasSubagents: false, showStepAgentBadge: false, showStepTurnRail: false };
    const first = { stepIndex: 1, ttftSec: 2, requestDiagnostics: { retryInfoCount: null } };
    widget.refs.renderStepTable([first], 'cid', ['step', 'ttft'], 'en-US', options);
    const button = widget.refs.stepsTbody.querySelector('.step-request-diagnostics-button');
    assert.ok(button);
    assert.equal(button.tagName, 'BUTTON');
    assert.ok(button.getAttribute('aria-label'));
    button.onclick();
    assert.equal(inspected, first);
    const corrected = { ...first, requestDiagnostics: { retryInfoCount: 2 } };
    widget.refs.renderStepTable([corrected], 'cid', ['step', 'ttft'], 'en-US', options);
    widget.refs.stepsTbody.querySelector('.step-request-diagnostics-button').onclick();
    assert.equal(inspected, corrected);
    const second = { ...corrected, stepIndex: 3, ttftSec: 6 };
    widget.refs.renderStepTable([second], 'cid', ['step', 'ttft'], 'en-US', options);
    widget.refs.stepsTbody.querySelector('.step-request-diagnostics-button').onclick();
    assert.equal(inspected, second);
  } finally {
    widget?.destroy();
    keys.forEach((key, i) => { globalThis[key] = previous[i]; });
  }
});
