import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLocalSqliteTrajectory } from '../backend/cli-sqlite-reader.mjs';
import { classifyStepAnomalyError, extractModelSteps } from '../trajectory-metrics.mjs';
import { buildScopedModelBreakdown } from '../backend/usage-aggregator.mjs';
import { createMockDom } from './mock-dom.mjs';
import { i18nStore, setI18nLanguage } from '../src/i18n/index.js';
import {
  buildModelAnomalyDiagnostic,
  buildStepAnomalyDiagnostic,
  buildStepCompactionDiagnostic,
  buildStepTimingDiagnostic,
  formatAnomalyTagText,
  formatMetric,
  formatSpeedMetric,
  hasStepTimingData,
} from '../src/core/formatters.js';
import { ContextSegmentMeter } from '../src/components/ui/ContextSegmentMeter.js';
import { STEP_COLUMN_REGISTRY } from '../src/registries/stepColumnRegistry.js';
import { StepTableWidget } from '../src/components/widgets/StepTableWidget.js';
import {
  createModelFitChart,
  createSessionLineChart,
} from '../src/components/charts/SessionStepCharts.js';
import { StepsDetailView } from '../src/views/StepsDetailView.js';
import { telemetryStore } from '../src/store/telemetryStore.js';
import { uiStore } from '../src/store/uiStore.js';

function encodeVarint(val) {
  let v = BigInt(val);
  if (v < 0n) v = BigInt.asUintN(64, v);
  const out = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

function encodeFieldVarint(fieldNo, val) {
  return Buffer.concat([encodeVarint((fieldNo << 3) | 0), encodeVarint(val)]);
}

function encodeFieldBytes(fieldNo, bufOrStr) {
  const b = Buffer.isBuffer(bufOrStr) ? bufOrStr : Buffer.from(String(bufOrStr), 'utf8');
  return Buffer.concat([encodeVarint((fieldNo << 3) | 2), encodeVarint(b.length), b]);
}

function encodeTimestamp(sec, nanos = 0) {
  return Buffer.concat([encodeFieldVarint(1, sec), ...(nanos ? [encodeFieldVarint(2, nanos)] : [])]);
}

function encodeRetryInfo({ error = '', reasonCode = 1, delaySec = 0, delayNanos = 0 } = {}) {
  const parts = [];
  if (error) parts.push(encodeFieldBytes(3, error));
  if (reasonCode) parts.push(encodeFieldVarint(5, reasonCode));
  if (delaySec || delayNanos) {
    parts.push(encodeFieldBytes(7, encodeTimestamp(delaySec, delayNanos)));
  }
  return Buffer.concat(parts);
}

function encodeStepMeta({
  createdSec,
  finishedSec,
  stepIndex,
  modelEnumInt = 0,
  inputTokens = 0,
  cacheReadTokens = 0,
  outputTokens = 0,
  retryInfos = [],
}) {
  const parts = [encodeFieldBytes(1, encodeTimestamp(createdSec))];
  if (finishedSec) parts.push(encodeFieldBytes(7, encodeTimestamp(finishedSec)));
  if (modelEnumInt || inputTokens || cacheReadTokens || outputTokens) {
    const muParts = [];
    if (modelEnumInt) muParts.push(encodeFieldVarint(1, modelEnumInt));
    if (inputTokens) muParts.push(encodeFieldVarint(2, inputTokens));
    if (outputTokens) muParts.push(encodeFieldVarint(3, outputTokens));
    if (cacheReadTokens) muParts.push(encodeFieldVarint(5, cacheReadTokens));
    muParts.push(encodeFieldVarint(6, 24));
    parts.push(encodeFieldBytes(9, Buffer.concat(muParts)));
  }
  parts.push(encodeFieldBytes(20, encodeFieldVarint(2, stepIndex)));
  for (const ri of retryInfos) {
    parts.push(encodeFieldBytes(28, encodeRetryInfo(ri)));
  }
  return Buffer.concat(parts);
}

function encodeErrorMessagePayload({
  userErrorMessage = '',
  shortError = '',
  errorCode = '',
  shouldShowModel = false,
  shouldShowUser = false,
}) {
  const errParts = [];
  if (userErrorMessage) errParts.push(encodeFieldBytes(1, userErrorMessage));
  if (shortError) errParts.push(encodeFieldBytes(2, shortError));
  if (errorCode) errParts.push(encodeFieldBytes(7, errorCode));
  const inner = [encodeFieldBytes(3, Buffer.concat(errParts))];
  if (shouldShowModel) inner.push(encodeFieldVarint(4, 1));
  if (shouldShowUser) inner.push(encodeFieldVarint(5, 1));
  return encodeFieldBytes(24, Buffer.concat(inner));
}

function encodeGenMeta({
  stepIndex,
  cascadeId,
  responseModel,
  modelDisplayName,
  retryCount = 0,
  retryInfos = [],
}) {
  const mapCascade = Buffer.concat([
    encodeFieldBytes(1, 'cascade_id'),
    encodeFieldBytes(2, cascadeId),
  ]);
  const chatParts = [
    encodeFieldBytes(11, encodeTimestamp(1, 0)),
    encodeFieldBytes(19, responseModel),
    encodeFieldBytes(20, mapCascade),
    encodeFieldBytes(21, modelDisplayName),
  ];
  if (retryCount > 0) chatParts.push(encodeFieldVarint(14, retryCount));
  for (const ri of retryInfos) {
    chatParts.push(encodeFieldBytes(17, encodeRetryInfo(ri)));
  }
  return Buffer.concat([
    encodeFieldVarint(2, stepIndex),
    encodeFieldBytes(1, Buffer.concat(chatParts)),
  ]);
}

function installMockBrowser() {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCaf = globalThis.cancelAnimationFrame;
  const prevResizeObs = globalThis.ResizeObserver;
  const { document } = createMockDom();
  globalThis.document = document;
  globalThis.window = {
    innerWidth: 960,
    innerHeight: 720,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globalThis.requestAnimationFrame = (fn) => {
    fn();
    return 1;
  };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  return {
    document,
    restore() {
      globalThis.document = prevDoc;
      globalThis.window = prevWin;
      globalThis.requestAnimationFrame = prevRaf;
      globalThis.cancelAnimationFrame = prevCaf;
      globalThis.ResizeObserver = prevResizeObs;
    },
  };
}

test('SQLite protobuf decoder + trajectory-metrics + usage-aggregator decode chatModel retries, checkpoint retries, deduplicated ERROR_MESSAGE, and trailing terminal errors', (t) => {
  const sqliteMod =
    typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : null;
  if (!sqliteMod?.DatabaseSync) {
    t.skip('node:sqlite DatabaseSync unavailable');
    return;
  }
  const { DatabaseSync } = sqliteMod;
  const tempRoot = mkdtempSync(join(tmpdir(), 'agy-anomaly-sqlite-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));

  const cid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const dbPath = join(tempRoot, `${cid}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
    CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
  `);
  db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, 1, 1)').run(cid, cid);

  const baseSec = 1794960000;
  // Step 0: USER_INPUT (step_type=14)
  db.prepare('INSERT INTO steps VALUES (0, 14, 3, ?, ?)').run(
    encodeStepMeta({ createdSec: baseSec, finishedSec: baseSec, stepIndex: 0 }),
    encodeFieldBytes(19, encodeFieldBytes(2, '帮我排查超时'))
  );
  // Step 1: Normal model response (zero anomalies)
  db.prepare('INSERT INTO steps VALUES (1, 15, 3, ?, ?)').run(
    encodeStepMeta({
      createdSec: baseSec + 1,
      finishedSec: baseSec + 3,
      stepIndex: 1,
      modelEnumInt: 1035,
      inputTokens: 500,
      cacheReadTokens: 2000,
      outputTokens: 260,
    }),
    encodeFieldBytes(20, encodeFieldBytes(1, 'ok'))
  );
  db.prepare('INSERT INTO gen_metadata VALUES (0, ?)').run(
    encodeGenMeta({
      stepIndex: 1,
      cascadeId: cid,
      responseModel: 'gemini-3-flash',
      modelDisplayName: 'Gemini 3 Flash',
    })
  );

  // Step 2: Preceding ERROR_MESSAGE (duplicate of retryInfo capacity 503) — should be deduplicated against step 3 retryInfos
  db.prepare('INSERT INTO steps VALUES (2, 17, 3, ?, ?)').run(
    encodeStepMeta({ createdSec: baseSec + 4, finishedSec: baseSec + 4, stepIndex: 2 }),
    encodeErrorMessagePayload({
      shortError: 'HTTP 503 No capacity available for model',
      errorCode: 'UNAVAILABLE',
      shouldShowUser: false,
    })
  );
  // Step 3: Retried model response with 2 retryInfos (timeout 2.5s + capacity 5s)
  db.prepare('INSERT INTO steps VALUES (3, 15, 3, ?, ?)').run(
    encodeStepMeta({
      createdSec: baseSec + 5,
      finishedSec: baseSec + 15,
      stepIndex: 3,
      modelEnumInt: 1035,
      inputTokens: 600,
      cacheReadTokens: 3000,
      outputTokens: 300,
    }),
    encodeFieldBytes(20, encodeFieldBytes(1, 'retried ok'))
  );
  db.prepare('INSERT INTO gen_metadata VALUES (1, ?)').run(
    encodeGenMeta({
      stepIndex: 3,
      cascadeId: cid,
      responseModel: 'gemini-3-flash',
      modelDisplayName: 'Gemini 3 Flash',
      retryCount: 2,
      retryInfos: [
        {
          error: 'stream idle timeout: no data received for 60s',
          reasonCode: 1,
          delaySec: 2,
          delayNanos: 500_000_000,
        },
        {
          error: 'HTTP 503 No capacity available for model',
          reasonCode: 1,
          delaySec: 5,
        },
      ],
    })
  );

  // Step 4: CHECKPOINT (step_type=18) with metadata.fn=28 retryInfo (model_output)
  db.prepare('INSERT INTO steps VALUES (4, 18, 3, ?, NULL)').run(
    encodeStepMeta({
      createdSec: baseSec + 16,
      finishedSec: baseSec + 19,
      stepIndex: 4,
      modelEnumInt: 1035,
      inputTokens: 400,
      outputTokens: 120,
      retryInfos: [
        {
          error: 'invalid tool call arguments JSON',
          reasonCode: 2,
          delaySec: 1,
        },
      ],
    })
  );

  // Step 5: Model step followed by turn-ending terminal ERROR_MESSAGE (status=7 CORTEX_STEP_STATUS_ERROR)
  db.prepare('INSERT INTO steps VALUES (5, 15, 7, ?, ?)').run(
    encodeStepMeta({
      createdSec: baseSec + 20,
      finishedSec: baseSec + 25,
      stepIndex: 5,
      modelEnumInt: 1035,
      inputTokens: 200,
      outputTokens: 0,
    }),
    encodeFieldBytes(20, encodeFieldBytes(1, ''))
  );
  db.prepare('INSERT INTO gen_metadata VALUES (2, ?)').run(
    encodeGenMeta({
      stepIndex: 5,
      cascadeId: cid,
      responseModel: 'gemini-3-pro',
      modelDisplayName: 'Gemini 3 Pro',
    })
  );
  // Step 6: Trailing terminal ERROR_MESSAGE (should attach to step 5)
  db.prepare('INSERT INTO steps VALUES (6, 17, 3, ?, ?)').run(
    encodeStepMeta({ createdSec: baseSec + 25, finishedSec: baseSec + 25, stepIndex: 6 }),
    encodeErrorMessagePayload({
      userErrorMessage: 'TLS handshake timeout while reaching upstream',
      shortError: 'dial tcp: TLS handshake timeout',
      errorCode: 'DEADLINE_EXCEEDED',
      shouldShowUser: true,
    })
  );
  db.close();

  const traj = readLocalSqliteTrajectory(dbPath);
  assert.ok(traj, 'SQLite trajectory decoded');
  const gen1 = traj.generatorMetadata.find((g) => g.stepIndices?.includes(3));
  assert.equal(gen1?.chatModel?.retryCount, 2);
  assert.equal(gen1?.chatModel?.retryInfos?.length, 2);
  assert.equal(gen1?.chatModel?.retryInfos?.[0]?.retryDelay, '2.5s');
  assert.equal(traj.steps[4]?.metadata?.retryInfos?.length, 1);
  assert.equal(traj.steps[6]?.errorMessage?.shouldShowUser, true);
  assert.match(traj.steps[6]?.errorMessage?.error?.userErrorMessage || '', /TLS handshake timeout/);

  const extracted = extractModelSteps(traj.steps, traj.generatorMetadata);
  const s1 = extracted.find((s) => s.stepIndex === 1);
  const s3 = extracted.find((s) => s.stepIndex === 3);
  const s4 = extracted.find((s) => s.stepIndex === 4);
  const s5 = extracted.find((s) => s.stepIndex === 5);

  assert.equal(s1.anomaly, undefined, 'Normal step carries zero anomaly payload');
  assert.equal(s1.anomalySig, undefined, 'Normal step omits anomalySig');

  assert.ok(s3.anomaly, 'Step 3 has anomaly record');
  assert.equal(s3.anomaly.count, 2, 'Duplicate preceding 503 ERROR_MESSAGE is deduplicated against retryInfos');
  assert.equal(s3.anomaly.totalDelaySec, 7.5);
  assert.equal(s3.anomaly.kinds.timeout, 1);
  assert.equal(s3.anomaly.kinds.capacity, 1);
  assert.equal(s3.anomaly.severity, 'warn');

  assert.ok(s4.anomaly, 'Checkpoint step 4 decodes metadata.fn=28 retryInfo');
  assert.equal(s4.anomaly.primaryKind, 'model_output');
  assert.equal(s4.anomaly.count, 1);

  assert.ok(s5.anomaly, 'Trailing turn-ending ERROR_MESSAGE attaches to step 5');
  assert.equal(s5.anomaly.primaryKind, 'timeout');
  assert.equal(s5.anomaly.severity, 'danger', 'Terminal error escalates severity to danger');
  assert.equal(s5.anomaly.events[0]?.terminal, true);
  assert.equal(s5.speedReason, 'error');
  assert.equal(s5.totalTokPerSec, null);

  // Also check classifyStepAnomalyError directly for rate_limit & safety
  assert.equal(classifyStepAnomalyError('HTTP 429 RESOURCE_EXHAUSTED quota exceeded'), 'rate_limit');
  assert.equal(classifyStepAnomalyError('blocked by safety filter policy'), 'safety');

  const breakdown = buildScopedModelBreakdown(extracted, (st) => ({
    label: st.responseModel || 'Unknown',
    shortName: st.responseModel || 'Unknown',
    rawModel: st.model || '',
    upstreamName: st.responseModel || '',
    costUsd: 0.01,
  }));
  const flash = breakdown.find((m) => m.label === 'gemini-3-flash');
  const pro = breakdown.find((m) => m.label === 'gemini-3-pro');
  assert.ok(flash && pro);
  assert.equal(flash.anomalySteps, 1);
  assert.equal(flash.anomalyCount, 2);
  assert.equal(flash.anomalyTotalDelaySec, 7.5);
  assert.equal(pro.anomalySteps, 1);
  assert.equal(pro.anomalyCount, 1);
  assert.equal(pro.anomalyDangerCount, 1);
  assert.equal(pro.anomalyByKind.timeout, 1);
});

test('formatSpeedMetric drops decimals at >= 100 tok/s and STEP_COLUMN_REGISTRY.tps renders integer speeds and error reasons', () => {
  const env = installMockBrowser();
  try {
    i18nStore.setState({ locale: 'zh-CN' });

    assert.equal(formatSpeedMetric(100), '100 tok/s');
    assert.equal(formatSpeedMetric(128.4), '128 tok/s');
    assert.equal(formatSpeedMetric(145.6), '146 tok/s');
    assert.equal(formatSpeedMetric(99.9), '99.9 tok/s');
    assert.equal(formatSpeedMetric(65.7), '65.7 tok/s');
    assert.equal(formatSpeedMetric(0), '0.0 tok/s');
    assert.equal(formatSpeedMetric(null), '—');

    const fastCell = STEP_COLUMN_REGISTRY.tps.createCell();
    STEP_COLUMN_REGISTRY.tps.updateCell(fastCell.refs, { tokPerSec: 128.4 }, { showStepSpeedColor: false });
    assert.equal(fastCell.refs.speedMain.textContent, '128 tok/s');

    STEP_COLUMN_REGISTRY.tps.updateCell(fastCell.refs, { tokPerSec: 65.7 }, { showStepSpeedColor: false });
    assert.equal(fastCell.refs.speedMain.textContent, '65.7 tok/s');

    STEP_COLUMN_REGISTRY.tps.updateCell(
      fastCell.refs,
      { tokPerSec: null, selectedSpeedReason: 'short_timing' },
      { showStepSpeedColor: false }
    );
    assert.equal(fastCell.refs.speedMain.textContent, '—');
    assert.equal(fastCell.refs.speedReason, undefined, 'tps cell must stay strictly single-line without a sub-reason row');
    assert.equal(fastCell.td.getAttribute('title'), '耗时过短 (<0.5s)');

    STEP_COLUMN_REGISTRY.tps.updateCell(
      fastCell.refs,
      { tokPerSec: null, selectedSpeedReason: 'compaction_timing_unavailable', isCompactionStep: true },
      { showStepSpeedColor: false }
    );
    assert.equal(fastCell.refs.speedMain.textContent, '—');
    assert.equal(fastCell.td.getAttribute('title'), null, 'compaction rows rely on custom hover popover without native title overlap');

    STEP_COLUMN_REGISTRY.tps.updateCell(
      fastCell.refs,
      { tokPerSec: null, selectedSpeedReason: 'canceled', anomaly: { count: 1 } },
      { showStepSpeedColor: false }
    );
    assert.equal(fastCell.refs.speedMain.textContent, '—');
    assert.equal(fastCell.td.getAttribute('title'), null, 'anomaly/canceled rows rely on custom hover popover without native title overlap');

    // Seconds >= 100s also drop decimals in ttft & duration columns
    assert.equal(formatMetric(100, 's'), '100s');
    assert.equal(formatMetric(142.6, 's'), '143s');
    assert.equal(formatMetric(99.9, 's'), '99.9s');

    const ttftCell = STEP_COLUMN_REGISTRY.ttft.createCell();
    STEP_COLUMN_REGISTRY.ttft.updateCell(ttftCell.refs, { ttftSec: 124.7 });
    assert.equal(ttftCell.refs.valEl.textContent, '125s');
    STEP_COLUMN_REGISTRY.ttft.updateCell(ttftCell.refs, { ttftSec: 14.2 });
    assert.equal(ttftCell.refs.valEl.textContent, '14.2s');

    const durCell = STEP_COLUMN_REGISTRY.duration.createCell();
    STEP_COLUMN_REGISTRY.duration.updateCell(durCell.refs, { totalDurationSec: 108.4 });
    assert.equal(durCell.refs.valEl.textContent, '108s');
    STEP_COLUMN_REGISTRY.duration.updateCell(durCell.refs, { totalDurationSec: 42.3 });
    assert.equal(durCell.refs.valEl.textContent, '42.3s');

    // Compaction steps keep normal TTFT formatting ("—" when null) instead of overriding the cell
    const compactTtftCell = STEP_COLUMN_REGISTRY.ttft.createCell();
    i18nStore.setState({ locale: 'zh-CN' });
    STEP_COLUMN_REGISTRY.ttft.updateCell(compactTtftCell.refs, { isCompactionStep: true, ttftSec: null });
    assert.equal(compactTtftCell.refs.valEl.textContent, '—');
    assert.notEqual(compactTtftCell.refs.valEl.getAttribute('class'), 'step-ttft-compaction');
    STEP_COLUMN_REGISTRY.ttft.updateCell(compactTtftCell.refs, { isCompactionStep: false, ttftSec: 5.2 });
    assert.equal(compactTtftCell.refs.valEl.textContent, '5.2s');

    // ContextSegmentMeter renders crisp separated blocks (.ctx-segment-meter + .is-active + .has-sep)
    const meter = ContextSegmentMeter({
      context: {
        limitTokens: 200_000,
        toolResultsTokens: 60_000,
        assistantTokens: 20_000,
        skillsTokens: 1_000,
      },
    });
    assert.equal(meter.el.classList.contains('ctx-segment-meter'), true);
    const activeSegs = meter.refs.segments.filter((s) => s.classList.contains('is-active'));
    assert.equal(activeSegs.length, 3);
    assert.equal(activeSegs[0].classList.contains('has-sep'), false, 'First active segment has no left cut gap');
    assert.equal(activeSegs[1].classList.contains('has-sep'), true, 'Second active segment has 2px cut gap');
    assert.equal(activeSegs[2].classList.contains('has-sep'), true, 'Third active segment has 2px cut gap');
    assert.match(activeSegs[0].getAttribute('title') || '', /60\.0k/);
    const inactiveSegs = meter.refs.segments.filter((s) => !s.classList.contains('is-active'));
    assert.equal(inactiveSegs.length, 7);
    assert.equal(inactiveSegs.every((s) => !s.classList.contains('has-sep') && !s.getAttribute('title')), true);
  } finally {
    env.restore();
  }
});

test('StepTableWidget tints entire anomaly rows with zero extra column width and reveals full diagnostic popover on row hover', () => {
  const env = installMockBrowser();
  const widget = StepTableWidget({ standalone: true });
  try {
    i18nStore.setState({ locale: 'zh-CN' });

    const colKeys = ['step', 'model', 'tps', 'ttft'];
    const steps = [
      {
        stepIndex: 4924,
        modelShort: '4-neon',
        modelLabel: '4-neon',
        tokPerSec: 132.6,
        ttftSec: 2.1,
        anomalySig: 'timeout:1:w:2.5',
        anomaly: {
          count: 1,
          primaryKind: 'timeout',
          severity: 'warn',
          totalDelaySec: 2.5,
          kinds: { timeout: 1 },
          events: [
            {
              attempt: 1,
              kind: 'timeout',
              delaySec: 2.5,
              terminal: false,
              message: 'stream idle timeout: no data received',
            },
          ],
        },
      },
      {
        stepIndex: 4922,
        modelShort: '4-neon',
        modelLabel: '4-neon',
        tokPerSec: null,
        selectedSpeedReason: 'error',
        ttftSec: null,
        anomalySig: 'rate_limit:1:d:0',
        anomaly: {
          count: 1,
          primaryKind: 'rate_limit',
          severity: 'danger',
          totalDelaySec: 0,
          kinds: { rate_limit: 1 },
          events: [
            {
              attempt: 1,
              kind: 'rate_limit',
              delaySec: 0,
              terminal: true,
              message: 'HTTP 429 RESOURCE_EXHAUSTED',
            },
          ],
        },
      },
      {
        stepIndex: 4920,
        modelShort: '4-neon',
        modelLabel: '4-neon',
        tokPerSec: 65.7,
        ttftSec: 1.4,
        anomalySig: '',
      },
      {
        stepIndex: 4918,
        modelShort: '4-neon',
        modelLabel: '4-neon',
        isCompactionStep: true,
        inputTokens: 120000,
        cacheReadTokens: 400000,
        outputTokens: 4400,
        tokPerSec: 86.6,
        ttftSec: null,
        anomalySig: '',
      },
      {
        stepIndex: 4916,
        modelShort: '4-neon',
        modelLabel: '4-neon',
        isCompactionStep: true,
        inputTokens: 100000,
        cacheReadTokens: 300000,
        outputTokens: 2100,
        tokPerSec: null,
        selectedSpeedReason: 'error',
        ttftSec: null,
        anomalySig: 'timeout:1:w:1.5',
        anomaly: {
          count: 1,
          primaryKind: 'timeout',
          severity: 'warn',
          totalDelaySec: 1.5,
          kinds: { timeout: 1 },
          events: [
            {
              attempt: 1,
              kind: 'timeout',
              delaySec: 1.5,
              terminal: false,
              message: 'compaction stream idle timeout',
            },
          ],
        },
      },
    ];

    widget.refs.renderStepTable(steps, 'cid-1', colKeys, 'zh-CN', {
      hasSubagents: false,
      showStepAgentBadge: true,
      showStepTurnRail: false,
    });

    // Zero extra columns and zero inline text badges added to table cells
    assert.equal(widget.refs.stepsTheadRow.children.length, colKeys.length);
    const rows = widget.refs.stepsTbody.children;
    assert.equal(rows.length, 5);
    assert.equal(rows[0].children.length, colKeys.length);
    assert.equal(rows[0].querySelector('.step-anomaly-tag'), null, 'No inline tag widening the #step column');

    // Row 0: warn tint (orange) + integer speed 133 tok/s
    assert.equal(rows[0].classList.contains('is-anomaly-warn'), true);
    assert.equal(rows[0].classList.contains('is-anomaly-danger'), false);
    assert.equal(rows[0].children[2].textContent, '133 tok/s');

    // Row 1: danger tint (red)
    assert.equal(rows[1].classList.contains('is-anomaly-danger'), true);
    assert.equal(rows[1].classList.contains('is-anomaly-warn'), false);

    // Row 2: normal step has NO anomaly/compaction row classes and keeps 1 decimal < 100 tok/s
    assert.equal(rows[2].classList.contains('is-anomaly-warn'), false);
    assert.equal(rows[2].classList.contains('is-anomaly-danger'), false);
    assert.equal(rows[2].classList.contains('is-compaction'), false);
    assert.equal(rows[2].children[2].textContent, '65.7 tok/s');

    // Row 3: pure compaction step uses host-accent row tint, keeps TTFT as "—", and shows compaction hover popover
    assert.equal(rows[3].classList.contains('is-compaction'), true);
    assert.equal(rows[3].classList.contains('is-anomaly-warn'), false);
    assert.equal(rows[3].classList.contains('is-anomaly-danger'), false);
    assert.equal(rows[3].children[3].textContent, '—');

    // Hovering the tinted row expands the structured diagnostic popover
    const tipEl = widget.refs.anomalyTipEl;
    assert.equal(tipEl.hasAttribute('hidden'), true);
    rows[0].onmouseenter();
    assert.equal(tipEl.hasAttribute('hidden'), false);
    assert.equal(tipEl.classList.contains('is-compaction'), false);
    assert.match(tipEl.querySelector('.step-anomaly-tip-title').textContent, /#4924.*异常 1 次/);
    assert.equal(tipEl.querySelector('.step-anomaly-tip-sub').textContent, '退避 2.5s');
    assert.match(tipEl.querySelector('.step-anomaly-tip-detail').textContent, /stream idle timeout/);

    rows[0].onmouseleave();
    assert.equal(tipEl.hasAttribute('hidden'), true);

    // Hovering compaction row displays host-accent compaction popover matching warning popover structure
    rows[3].onmouseenter();
    assert.equal(tipEl.hasAttribute('hidden'), false);
    assert.equal(tipEl.classList.contains('is-compaction'), true);
    assert.equal(tipEl.classList.contains('is-danger'), false);
    assert.match(tipEl.querySelector('.step-anomaly-tip-title').textContent, /#4918.*自动压缩/);
    assert.equal(tipEl.querySelector('.step-anomaly-tip-sub').textContent, '4-neon');
    assert.match(tipEl.querySelector('.step-anomaly-tip-row').textContent, /输入 520\.0k → 摘要输出 4\.4k/);
    assert.equal(tipEl.querySelector('.step-anomaly-tip-detail').classList.contains('text-mono'), false);
    rows[3].onmouseleave();
    assert.equal(tipEl.hasAttribute('hidden'), true);

    // Hovering danger row sets danger style and clears compaction style on tooltip
    rows[1].onmouseenter();
    assert.equal(tipEl.hasAttribute('hidden'), false);
    assert.equal(tipEl.classList.contains('is-danger'), true);
    assert.equal(tipEl.classList.contains('is-compaction'), false);
    assert.match(tipEl.querySelector('.step-anomaly-tip-detail').textContent, /429 RESOURCE_EXHAUSTED/);
    rows[1].onmouseleave();
    assert.equal(tipEl.hasAttribute('hidden'), true);

    // Row 4: hybrid compaction + anomaly keeps anomaly diagnostic and appends compaction hint
    assert.equal(rows[4].classList.contains('is-compaction'), true);
    assert.equal(rows[4].classList.contains('is-anomaly-warn'), true);
    rows[4].onmouseenter();
    assert.equal(tipEl.hasAttribute('hidden'), false);
    assert.equal(tipEl.classList.contains('is-compaction'), false);
    assert.match(tipEl.querySelector('.step-anomaly-tip-title').textContent, /#4916.*异常 1 次/);
    assert.match(tipEl.querySelector('.step-anomaly-tip-hint').textContent, /自动压缩/);
    rows[4].onmouseleave();
    assert.equal(tipEl.hasAttribute('hidden'), true);

    // Verify helper outputs cleanly
    assert.equal(formatAnomalyTagText('capacity', 1), '503');
    assert.equal(formatAnomalyTagText('capacity', 3), '503×3');
    assert.ok(buildStepAnomalyDiagnostic(steps[0]));
    assert.equal(buildStepAnomalyDiagnostic(steps[2]), null);
    assert.equal(buildStepCompactionDiagnostic(steps[3]).severity, 'compaction');
  } finally {
    widget.destroy();
    env.restore();
  }
});

test('StepsDetailView total summary cards, session anomaly strip, click-to-filter jump, and line/fit chart anomaly markers & hover tooltips work across UI modes', async () => {
  const env = installMockBrowser();
  const prevUi = uiStore.getState();
  const prevTel = telemetryStore.getState();
  let view = null;
  let lineChart = null;
  let fitChart = null;
  try {
    i18nStore.setState({ locale: 'zh-CN' });
    view = StepsDetailView();

    const anomalyObj = {
      count: 2,
      primaryKind: 'timeout',
      severity: 'danger',
      totalDelaySec: 4.5,
      kinds: { timeout: 2 },
      events: [
        { attempt: 1, kind: 'timeout', delaySec: 2, terminal: false, message: 'idle timeout #1' },
        { attempt: 2, kind: 'timeout', delaySec: 2.5, terminal: true, message: 'TLS handshake timeout' },
      ],
    };

    const recentSteps = [
      {
        stepIndex: 10,
        createdAtMs: 1794960100000,
        modelLabel: 'Gemini 3 Pro',
        modelShort: '3-pro',
        tokPerSec: 120.4,
        ttftSec: 1.5,
        inputTokens: 1000,
        cacheReadTokens: 4000,
        outputTokens: 300,
        thinkingTokens: 100,
        responseTokens: 200,
        contextTokens: 5300,
        cacheHitPct: 80,
        costUsd: 0.02,
        anomalySig: 'timeout:2:d:4.5',
        anomaly: anomalyObj,
      },
      {
        stepIndex: 9,
        createdAtMs: 1794960050000,
        modelLabel: 'Gemini 3 Flash',
        modelShort: '3-flash',
        tokPerSec: 88.2,
        ttftSec: 0.9,
        inputTokens: 500,
        cacheReadTokens: 2000,
        outputTokens: 150,
        thinkingTokens: 50,
        responseTokens: 100,
        contextTokens: 2650,
        cacheHitPct: 80,
        costUsd: 0.005,
        anomalySig: '',
      },
    ];

    const modelBreakdown = [
      {
        label: 'Gemini 3 Pro',
        shortName: '3-pro',
        calls: 1,
        inputTokens: 1000,
        cacheReadTokens: 4000,
        outputTokens: 300,
        thinkingTokens: 100,
        responseTokens: 200,
        totalTokens: 5300,
        costUsd: 0.02,
        avgTokPerSec: 120.4,
        avgTtftSec: 1.5,
        cacheHitPct: 80,
        anomalySteps: 1,
        anomalyCount: 2,
        anomalyDangerCount: 1,
        anomalyTotalDelaySec: 4.5,
        anomalyByKind: { timeout: 2 },
      },
      {
        label: 'Gemini 3 Flash',
        shortName: '3-flash',
        calls: 1,
        inputTokens: 500,
        cacheReadTokens: 2000,
        outputTokens: 150,
        thinkingTokens: 50,
        responseTokens: 100,
        totalTokens: 2650,
        costUsd: 0.005,
        avgTokPerSec: 88.2,
        avgTtftSec: 0.9,
        cacheHitPct: 80,
      },
    ];

    uiStore.setState({
      monitorVisible: true,
      activeView: 'steps',
      stepsSubTab: 'models',
      selectedAgentScope: 'all',
    });
    telemetryStore.setState({
      telemetry: {
        settings: {
          stepTableColumns: ['step', 'model', 'tps', 'ttft'],
          experimentalModernUi: false,
        },
        activeConversation: {
          cascadeId: 'cid-summary-test',
          recentSteps,
          modelBreakdown,
        },
      },
    });
    await Promise.resolve();

    // Session-level anomaly strip is visible with timeout tag
    const stripEl = view.refs.modelsAnomalyStripEl;
    assert.equal(stripEl.hasAttribute('hidden'), false);
    assert.match(stripEl.textContent, /异常 2 次.*1 步/);

    // Model summary cards: Pro shows danger anomaly badge + integer 120 tok/s; Flash hides badge + keeps 88.2 tok/s
    const cards = view.refs.modelsListEl.querySelectorAll('.smodel-card');
    assert.equal(cards.length, 2);
    const proBadge = cards[0].querySelector('.smodel-anomaly-tag');
    const flashBadge = cards[1].querySelector('.smodel-anomaly-tag');
    assert.equal(proBadge.hasAttribute('hidden'), false);
    assert.equal(proBadge.textContent, '超时2');
    assert.equal(proBadge.classList.contains('is-danger'), true);
    assert.match(cards[0].querySelector('.smodel-perf').textContent, /120 tok\/s/);
    assert.equal(flashBadge.hasAttribute('hidden'), true);
    assert.match(cards[1].querySelector('.smodel-perf').textContent, /88\.2 tok\/s/);

    // Hovering model card anomaly badge opens diagnostic popover with click hint AND suppresses parent card native title tooltip
    const modelDiag = buildModelAnomalyDiagnostic(modelBreakdown[0]);
    assert.ok(modelDiag && modelDiag.hint);
    assert.ok(cards[0].getAttribute('title'), 'Model card has native fit-chart title before hovering anomaly badge');
    proBadge.onmouseenter();
    assert.equal(cards[0].getAttribute('title'), null, 'Parent model card native title must be suppressed while hovering anomaly badge');
    assert.equal(view.refs.anomalyTipEl.hasAttribute('hidden'), false);
    assert.match(view.refs.anomalyTipEl.querySelector('.step-anomaly-tip-hint').textContent, /按步查看/);
    proBadge.onmouseleave();
    assert.ok(cards[0].getAttribute('title'), 'Parent model card native title restores after leaving anomaly badge');
    assert.equal(view.refs.anomalyTipEl.hasAttribute('hidden'), true);

    // Clicking model card anomaly badge jumps to 'steps', activates anomaly filterbar, and filters to only anomaly step #10
    proBadge.onclick({ stopPropagation() {} });
    await Promise.resolve();
    assert.equal(uiStore.getState().stepsSubTab, 'steps');
    assert.equal(view.refs.anomalyFilterBarEl.hasAttribute('hidden'), false);
    assert.equal(view.refs.stepsTbody.children.length, 1);
    assert.match(view.refs.stepsTbody.children[0].children[0].textContent, /#10/);

    // Clicking "返回全部步骤" restores all rows and hides the filterbar
    view.refs.anomalyFilterBarEl
      .querySelector('.steps-anomaly-filter-clear')
      .dispatchEvent({ type: 'click', stopPropagation() {} });
    assert.equal(view.refs.anomalyFilterBarEl.hasAttribute('hidden'), true);
    assert.equal(view.refs.stepsTbody.children.length, 1);

    // Switch back to 'models' and click a session-level anomaly strip category pill -> jumps to 'steps' filtered by kind
    uiStore.setState({ stepsSubTab: 'models' });
    await Promise.resolve();
    const stripTagBtn = stripEl.querySelector('.smodel-anomaly-tag');
    assert.ok(stripTagBtn, 'Session anomaly strip renders clickable category micro-tag');
    assert.equal(stripTagBtn.textContent, '超时2');
    stripTagBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
    await Promise.resolve();
    assert.equal(uiStore.getState().stepsSubTab, 'steps');
    assert.equal(view.refs.anomalyFilterBarEl.hasAttribute('hidden'), false);
    assert.match(view.refs.anomalyFilterBarEl.textContent, /流空闲 \/ 连接超时/);
    assert.equal(view.refs.stepsTbody.children.length, 1);

    // Line chart (>64 points still renders anomaly ring overlay!) and Fit chart scatter anomaly overlay + hover tooltip linkage
    const manySteps = Array.from({ length: 70 }, (_, idx) => ({
      stepIndex: idx + 1,
      createdAtMs: 1794960000000 + idx * 1000,
      modelLabel: 'Gemini 3 Pro',
      modelShort: '3-pro',
      tokPerSec: 90 + (idx % 25),
      ttftSec: 1.2,
      inputTokens: 1000,
      cacheReadTokens: 3000,
      outputTokens: 200,
      contextTokens: 4200,
      cacheHitPct: 75,
      costUsd: 0.01,
      ...(idx === 35 ? { anomalySig: 'timeout:2:d:4.5', anomaly: anomalyObj } : { anomalySig: '' }),
    }));

    lineChart = createSessionLineChart();
    lineChart.update({
      steps: manySteps,
      modelGroupKey: '__all__',
      modelGroupKeys: ['__all__'],
      metric: 'tps',
    });
    const lineAnomalyDots = lineChart.el.querySelectorAll('.sstep-anomaly-dot');
    assert.equal(lineAnomalyDots.length, 1, 'Line chart renders on-curve anomaly dot even when steps > 64');
    assert.equal(lineAnomalyDots[0].tagName.toLowerCase(), 'circle');
    assert.equal(lineAnomalyDots[0].classList.contains('is-danger'), true);
    const dotCy = Number(lineAnomalyDots[0].getAttribute('cy'));
    assert.ok(dotCy > 10 && dotCy < 96, `Expected anomaly dot directly on curve (cy=${dotCy}), not at baseline`);

    fitChart = createModelFitChart();
    fitChart.update({
      steps: manySteps,
      modelGroupKey: 'Gemini 3 Pro',
      modelGroupKeys: ['Gemini 3 Pro'],
      metric: 'tps',
    });
    const fitAnomalyDots = fitChart.el.querySelectorAll('.sstep-scatter-dot.is-anomaly');
    assert.equal(fitAnomalyDots.length, 1, 'Fit scatter chart renders the anomaly dot without overdraw drop');
    assert.equal(fitAnomalyDots[0].getAttribute('r'), '3.4');
    assert.equal(fitAnomalyDots[0].classList.contains('is-danger'), true);
    assert.ok(fitChart.el.querySelector('.trend-tip-anomaly'), 'Fit chart tooltip mounts linked anomaly diagnostic row');
  } finally {
    lineChart?.destroy?.();
    fitChart?.destroy?.();
    view?.destroy?.();
    uiStore.setState(prevUi);
    telemetryStore.setState(prevTel);
    env.restore();
  }
});

test('Compiled styles.css centers odometer capsule slot text and ships both classic & modern-ui anomaly styles', () => {
  const builtCss = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

  // Capsule bar alignment fix: centered by default for fixed-width slots, flex-start for ctx-pct and multi-label
  assert.match(
    builtCss,
    /\.wm-slot-text\[data-od-active="1"\][\s\S]*?justify-content:\s*center;/,
    'Odometer active slot text centers horizontally inside fixed-width capsule slots'
  );
  assert.match(
    builtCss,
    /\.wm-slot-text\.wm-ctx-pct\[data-od-active="1"\][\s\S]*?justify-content:\s*flex-start;/,
    'Context percentage slot stays left-aligned next to its progress ring'
  );

  // Universal Classic + Modern UI compaction & anomaly styling (anomaly overrides compaction if both occur)
  const classicCompactIdx = builtCss.indexOf('tr.is-compaction {');
  const classicWarnIdx = builtCss.indexOf('tr.is-anomaly-warn {');
  assert.ok(classicCompactIdx > 0 && classicWarnIdx > classicCompactIdx, 'Classic tr.is-compaction precedes tr.is-anomaly-warn');
  assert.match(builtCss, /tr\.is-compaction\s*\{[^}]*var\(--accent-primary\)/);
  assert.match(builtCss, /\[data-modern-ui="true"\][\s\S]*?tr\.is-compaction[\s\S]*?var\(--accent-primary\)/);
  assert.match(builtCss, /\.step-anomaly-tip\.is-compaction[\s\S]*?var\(--accent-primary\)/);
  assert.doesNotMatch(builtCss, /\.step-ttft-compaction/);
  assert.match(builtCss, /tr\.is-anomaly-warn\s*\{/);
  assert.match(builtCss, /tr\.is-anomaly-danger\s*\{/);
  assert.match(builtCss, /\[data-modern-ui="true"\][\s\S]*?tr\.is-anomaly-warn/);
  assert.match(builtCss, /\.form-row\s*>\s*\.custom-select\s*>\s*\.select-trigger\s*\{[^}]*border:\s*none;[^}]*border-radius:\s*var\(--radius-pill\)/s);
  assert.match(builtCss, /\.steps-header-filters\s*\{[\s\S]*?justify-content:\s*flex-end;[\s\S]*?margin-left:\s*auto;/);
  assert.match(builtCss, /\.steps-inline-scope-select,\s*\.steps-inline-model-select\s*\{[\s\S]*?flex:\s*0\s+1\s+auto;/);
  assert.match(builtCss, /\.steps-inline-scope-select\s+\.select-trigger[\s\S]*?border-radius:\s*var\(--radius-pill\)/);
  assert.match(builtCss, /\[data-modern-ui="true"\]\s*\.form-row\s*>\s*\.custom-select\s*>\s*\.select-trigger,[\s\S]*?\.steps-inline-scope-select\s+\.select-trigger[\s\S]*?border-radius:\s*var\(--radius-pill\)[\s\S]*?var\(--modern-pill-select-bg\)/);
  assert.match(builtCss, /\.step-anomaly-tag\s*\{/);
  assert.match(builtCss, /\.step-anomaly-tip\s*\{/);
  assert.match(builtCss, /\.steps-anomaly-strip\s*\{/);
  assert.match(builtCss, /\.steps-anomaly-filterbar\s*\{/);
  assert.match(builtCss, /\.sstep-anomaly-dot/);
  assert.match(builtCss, /\.panel\s*>\s*\.table-scroll-host\s*\{[\s\S]*?margin-right:\s*calc\(-1\s*\*\s*var\(--space-5\)\s*\+\s*2px\)/);
  assert.match(builtCss, /\.panel\s*>\s*\.table-scroll-host\s*>\s*\.custom-scroll-content\s*\{[\s\S]*?padding-right:\s*calc\(var\(--space-5\)\s*-\s*2px\)/);
  assert.doesNotMatch(builtCss, /\.models-analytics-pane\s*\{[^}]*padding:\s*var\(--space-3\)\s+0\s+2px/);
  assert.match(builtCss, /\.trend-tip-sub\.is-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(builtCss, /\.trend-tip-anomaly/);
  assert.match(builtCss, /\[data-modern-ui="true"\]\s*\.step-anomaly-tip/);
  assert.match(builtCss, /\.progress-track\.ctx-segment-meter\s*\{[\s\S]*?height:\s*6px;/);
  assert.match(builtCss, /\.progress-track\.ctx-segment-meter\s+\.progress-seg\s*\{[\s\S]*?border-radius:\s*2px;/);
  assert.match(builtCss, /\.progress-track\.ctx-segment-meter\s+\.progress-seg\.is-active\.has-sep\s*\{[\s\S]*?margin-left:\s*2px;/);
  assert.match(builtCss, /\.step-anomaly-tip\.is-timing\s*\{/);
  assert.match(builtCss, /\.step-anomaly-tip-row\.is-kv\s*\{[\s\S]*?justify-content:\s*space-between;/);
});

test('buildStepTimingDiagnostic and StepTableWidget TTFT/duration hover tooltips render stage breakdown and coexist cleanly with anomaly rows', () => {
  const env = installMockBrowser();
  const prevLang = i18nStore.getState().language;
  let widget = null;
  try {
    setI18nLanguage('zh-CN');

    // 1. Slow buffered tool-call step with overlapping native thinking timing
    const slowToolStep = {
      stepIndex: 101,
      modelLabel: 'Gemini 4 Neon',
      modelShort: '4-neon',
      tokPerSec: 2.3,
      ttftSec: 119.167,
      nativeTtftSec: 119.167,
      nativeStreamSec: 0.203,
      thinkingDurationSec: 119.266,
      totalDurationSec: 119.37,
      hasToolCalls: true,
      contextTokens: 45300,
      inputTokens: 45030,
      cacheReadTokens: 0,
      outputTokens: 270,
      thinkingTokens: 180,
      responseTokens: 90,
      cacheHitPct: 0,
      costUsd: 0.14,
    };
    assert.equal(hasStepTimingData(slowToolStep), true);
    const slowDiag = buildStepTimingDiagnostic(slowToolStep);
    assert.equal(slowDiag.severity, 'timing');
    assert.equal(slowDiag.title, '#101 · 耗时拆解');
    assert.equal(slowDiag.sub, '总计 119.4s');
    assert.equal(slowDiag.rows.length, 3);
    assert.equal(slowDiag.rows[0].value, '119.2s (100%)');
    assert.equal(slowDiag.rows[0].toneClass, 'tone-danger');
    assert.equal(slowDiag.rows[1].value, '0.20s');
    assert.equal(slowDiag.rows[2].value, '119.3s');
    assert.doesNotMatch(slowDiag.hint, /重叠/);
    assert.match(slowDiag.hint, /工具调用/);

    // 2. Legacy step without nativeStreamSec derives after-TTFT cleanly; inconsistent timing avoids bogus share
    const legacyDiag = buildStepTimingDiagnostic({
      stepIndex: 102,
      ttftSec: 1.25,
      totalDurationSec: 5.0,
    });
    assert.equal(legacyDiag.rows.length, 2);
    assert.equal(legacyDiag.rows[0].value, '1.25s (25%)');
    assert.equal(legacyDiag.rows[1].text, '首字后耗时');
    assert.equal(legacyDiag.rows[1].value, '3.75s');
    assert.equal(legacyDiag.hint, '');

    const inconsistentDiag = buildStepTimingDiagnostic({
      stepIndex: 103,
      ttftSec: 20,
      totalDurationSec: 10,
    });
    assert.equal(inconsistentDiag.rows.length, 1);
    assert.equal(inconsistentDiag.rows[0].value, '20.0s');

    // 3. Step with zero timing metadata produces null
    assert.equal(hasStepTimingData({ stepIndex: 104, ttftSec: null, totalDurationSec: null }), false);
    assert.equal(buildStepTimingDiagnostic({ stepIndex: 104, ttftSec: null, totalDurationSec: null }), null);

    // 4. Anomaly row + normal row + compaction row in StepTableWidget
    const anomalyStep = {
      stepIndex: 105,
      modelLabel: 'Claude Opus 4.6 (Thinking)',
      modelShort: 'opus-4.6',
      tokPerSec: 42.0,
      ttftSec: 14.01,
      nativeTtftSec: 14.01,
      nativeStreamSec: 1.08,
      thinkingDurationSec: 14.36,
      totalDurationSec: 15.09,
      hasToolCalls: false,
      anomaly: {
        count: 1,
        primaryKind: 'timeout',
        severity: 'warn',
        totalDelaySec: 2.5,
        kinds: { timeout: 1 },
        events: [{ attempt: 1, kind: 'timeout', delaySec: 2.5, message: 'stream idle timeout' }],
      },
      anomalySig: 'timeout:1:warn:2.5:timeout=1',
    };
    const compactionStep = {
      stepIndex: 106,
      isCompactionStep: true,
      modelLabel: 'Gemini 4 Neon [自动压缩]',
      modelShort: '4-neon·压缩',
      tokPerSec: null,
      ttftSec: null,
      totalDurationSec: null,
      inputTokens: 120000,
      outputTokens: 3200,
    };

    widget = StepTableWidget({ standalone: true });
    widget.refs.renderStepTable(
      [slowToolStep, anomalyStep, compactionStep],
      'conv-timing-tip',
      ['step', 'model', 'ttft', 'duration', 'cost'],
      'zh-CN',
      { hasSubagents: false, showStepAgentBadge: false, showStepTurnRail: false }
    );

    const rows = Array.from(widget.refs.stepsTbody.children);
    assert.equal(rows.length, 3);
    const tipEl = widget.refs.anomalyTipEl;
    assert.equal(tipEl.hasAttribute('hidden'), true);

    // Hovering TTFT cell on normal row opens neutral timing popover
    const slowTtftTd = rows[0].children[2];
    const slowDurTd = rows[0].children[3];
    assert.equal(typeof slowTtftTd.onmouseenter, 'function');
    assert.equal(typeof slowDurTd.onmouseenter, 'function');
    slowTtftTd.onmouseenter();
    assert.equal(tipEl.hasAttribute('hidden'), false);
    assert.equal(tipEl.classList.contains('is-timing'), true);
    assert.equal(tipEl.classList.contains('is-danger'), false);
    assert.equal(tipEl.classList.contains('is-compaction'), false);
    assert.equal(tipEl.querySelector('.step-anomaly-tip-title').textContent, '#101 · 耗时拆解');
    assert.equal(tipEl.querySelector('.step-anomaly-tip-sub').textContent, '总计 119.4s');
    const kvKeys = Array.from(tipEl.querySelectorAll('.step-anomaly-tip-k')).map((el) => el.textContent);
    const kvVals = Array.from(tipEl.querySelectorAll('.step-anomaly-tip-v')).map((el) => el.textContent);
    assert.deepEqual(kvKeys, ['首字等待 (TTFT)', '流式返回', '原生思考计时']);
    assert.deepEqual(kvVals, ['119.2s (100%)', '0.20s', '119.3s']);

    slowTtftTd.onmouseleave({});
    assert.equal(tipEl.hasAttribute('hidden'), true);

    // Hovering duration cell also opens the timing popover
    slowDurTd.onmouseenter();
    assert.equal(tipEl.hasAttribute('hidden'), false);
    assert.equal(tipEl.classList.contains('is-timing'), true);
    slowDurTd.onmouseleave({});
    assert.equal(tipEl.hasAttribute('hidden'), true);

    // Anomaly row: hovering TTFT switches to timing tip with anomaly hint, leaving to another cell in same row restores anomaly tip
    const anomModelTd = rows[1].children[1];
    const anomTtftTd = rows[1].children[2];
    rows[1].onmouseenter();
    assert.equal(tipEl.classList.contains('is-timing'), false);
    assert.match(tipEl.querySelector('.step-anomaly-tip-title').textContent, /#105.*异常 1 次/);

    anomTtftTd.onmouseenter();
    assert.equal(tipEl.classList.contains('is-timing'), true);
    assert.equal(tipEl.querySelector('.step-anomaly-tip-title').textContent, '#105 · 耗时拆解');
    assert.match(tipEl.querySelector('.step-anomaly-tip-hint').textContent, /含 1 次异常 · 退避 2\.5s/);

    anomTtftTd.onmouseleave({ relatedTarget: anomModelTd });
    assert.equal(tipEl.hasAttribute('hidden'), false);
    assert.equal(tipEl.classList.contains('is-timing'), false);
    assert.match(tipEl.querySelector('.step-anomaly-tip-title').textContent, /#105.*异常 1 次/);

    rows[1].onmouseleave();
    assert.equal(tipEl.hasAttribute('hidden'), true);

    // Compaction row without timing data does not bind timing hover on TTFT/duration cells
    assert.equal(rows[2].children[2].onmouseenter ?? null, null);
    assert.equal(rows[2].children[3].onmouseenter ?? null, null);

    // Updating row data updates timing popover content dynamically (including en-US locale)
    setI18nLanguage('en-US');
    const updatedStep = { ...slowToolStep, ttftSec: 2.4, nativeTtftSec: 2.4, nativeStreamSec: 1.6, thinkingDurationSec: null, totalDurationSec: 4.0, hasToolCalls: false };
    widget.refs.renderStepTable(
      [updatedStep],
      'conv-timing-tip',
      ['step', 'model', 'ttft', 'duration', 'cost'],
      'en-US',
      { hasSubagents: false, showStepAgentBadge: false, showStepTurnRail: false }
    );
    const refreshedTtftTd = widget.refs.stepsTbody.children[0].children[2];
    refreshedTtftTd.onmouseenter();
    assert.equal(tipEl.querySelector('.step-anomaly-tip-title').textContent, '#101 · Timing Breakdown');
    assert.equal(tipEl.querySelector('.step-anomaly-tip-sub').textContent, 'Total 4.00s');
    assert.deepEqual(
      Array.from(tipEl.querySelectorAll('.step-anomaly-tip-k')).map((el) => el.textContent),
      ['First Token (TTFT)', 'Streaming']
    );
    assert.deepEqual(
      Array.from(tipEl.querySelectorAll('.step-anomaly-tip-v')).map((el) => el.textContent),
      ['2.40s (60%)', '1.60s']
    );
  } finally {
    widget?.destroy();
    setI18nLanguage(prevLang);
    env.restore();
  }
});
