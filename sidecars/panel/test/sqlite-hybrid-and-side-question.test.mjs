import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeSqliteWalSig,
  isSqliteDbReadyForRead,
  readLocalImageDimensionsFromUri,
  readLocalSqliteTrajectory,
  withReadOnlySqliteDb,
} from '../backend/cli-sqlite-reader.mjs';
import {
  readTranscriptJsonlLines,
  resolveTranscriptPathInLogsDir,
} from '../backend/transcript-fallback.mjs';
import { resolveCliLocalSessionMetrics } from '../cli-statusline.mjs';
import { extractModelSteps } from '../trajectory-metrics.mjs';
import { backendHarness } from './backend-harness.mjs';
import { i18nStore } from '../src/i18n/index.js';
import {
  formatAgentBadgeText,
  formatAgentLabel,
  resolveScopedConversation,
} from '../src/store/telemetryStore.js';

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

function encodeStepMeta({
  createdSec,
  finishedSec,
  stepIndex,
  originCascadeId = '',
  modelEnumInt = 0,
  inputTokens = 0,
  cacheReadTokens = 0,
  outputTokens = 0,
  thinkingTokens = 0,
  responseTokens = 0,
}) {
  const parts = [encodeFieldBytes(1, encodeTimestamp(createdSec))];
  if (finishedSec) {
    parts.push(encodeFieldBytes(7, encodeTimestamp(finishedSec)));
  }
  if (modelEnumInt || inputTokens || cacheReadTokens || outputTokens) {
    const muParts = [];
    if (modelEnumInt) muParts.push(encodeFieldVarint(1, modelEnumInt));
    if (inputTokens) muParts.push(encodeFieldVarint(2, inputTokens));
    if (outputTokens) muParts.push(encodeFieldVarint(3, outputTokens));
    if (cacheReadTokens) muParts.push(encodeFieldVarint(5, cacheReadTokens));
    muParts.push(encodeFieldVarint(6, 24)); // API_PROVIDER_GOOGLE_GEMINI
    if (thinkingTokens) muParts.push(encodeFieldVarint(9, thinkingTokens));
    if (responseTokens) muParts.push(encodeFieldVarint(10, responseTokens));
    parts.push(encodeFieldBytes(9, Buffer.concat(muParts)));
  }
  const siParts = [encodeFieldVarint(2, stepIndex)];
  if (originCascadeId) {
    siParts.push(encodeFieldBytes(4, originCascadeId));
  }
  parts.push(encodeFieldBytes(20, Buffer.concat(siParts)));
  return Buffer.concat(parts);
}

function encodeUserInputPayload(text) {
  return encodeFieldBytes(19, encodeFieldBytes(2, text));
}

function encodePlannerResponsePayload(text) {
  return encodeFieldBytes(20, encodeFieldBytes(1, text));
}

function encodeGenMeta({
  stepIndex,
  cascadeId,
  responseModel,
  modelDisplayName,
  estimatedTokensUsed = 0,
  maxContextTokens = 256000,
  userMsgTokens = 0,
}) {
  const groups = [];
  if (userMsgTokens > 0) {
    const child = Buffer.concat([
      encodeFieldBytes(1, '0: USER_INPUT'),
      encodeFieldVarint(3, userMsgTokens),
    ]);
    const topGroup = Buffer.concat([
      encodeFieldBytes(1, 'Chat Messages'),
      encodeFieldVarint(2, 7), // TOKEN_TYPE_CHAT_MESSAGES
      encodeFieldVarint(4, userMsgTokens),
      encodeFieldBytes(5, child),
    ]);
    groups.push(encodeFieldBytes(1, topGroup));
  }
  const cwParts = [];
  if (estimatedTokensUsed > 0) cwParts.push(encodeFieldVarint(1, estimatedTokensUsed));
  if (groups.length > 0) cwParts.push(encodeFieldBytes(3, Buffer.concat(groups)));
  if (maxContextTokens > 0) cwParts.push(encodeFieldVarint(4, maxContextTokens));

  const mapCascade = Buffer.concat([
    encodeFieldBytes(1, 'cascade_id'),
    encodeFieldBytes(2, cascadeId),
  ]);
  const chatParts = [
    encodeFieldBytes(9, encodeFieldBytes(10, Buffer.concat(cwParts))),
    encodeFieldBytes(11, encodeTimestamp(1, 0)), // 1s TTFT
    encodeFieldBytes(19, responseModel),
    encodeFieldBytes(20, mapCascade),
    encodeFieldBytes(21, modelDisplayName),
  ];
  return Buffer.concat([
    encodeFieldVarint(2, stepIndex),
    encodeFieldBytes(1, Buffer.concat(chatParts)),
  ]);
}

function encodeSummaryBlob({
  title = '',
  stepCount = 0,
  lastModSec = 0,
  statusInt = 1,
  trajectoryType = 0,
  forkParentId = '',
  sideQuestionIds = [],
  sideQuestionTitles = {},
  parentConversationId = '',
  subagentSpec = null,
}) {
  const parts = [];
  if (stepCount > 0) parts.push(encodeFieldVarint(2, stepCount));
  if (lastModSec > 0) parts.push(encodeFieldBytes(3, encodeTimestamp(lastModSec)));
  if (statusInt > 0) parts.push(encodeFieldVarint(5, statusInt));

  const annParts = [];
  if (title) annParts.push(encodeFieldBytes(1, title));
  for (const sqId of sideQuestionIds) {
    annParts.push(encodeFieldBytes(17, sqId));
  }
  for (const [k, v] of Object.entries(sideQuestionTitles)) {
    annParts.push(
      encodeFieldBytes(18, Buffer.concat([encodeFieldBytes(1, k), encodeFieldBytes(2, v)]))
    );
  }
  if (annParts.length > 0) parts.push(encodeFieldBytes(15, Buffer.concat(annParts)));

  if (parentConversationId || subagentSpec) {
    const tmParts = [];
    if (parentConversationId) tmParts.push(encodeFieldBytes(5, parentConversationId));
    if (subagentSpec) {
      const specParts = [];
      if (subagentSpec.typeName) specParts.push(encodeFieldBytes(1, subagentSpec.typeName));
      if (subagentSpec.role) specParts.push(encodeFieldBytes(2, subagentSpec.role));
      tmParts.push(encodeFieldBytes(8, Buffer.concat(specParts)));
    }
    parts.push(encodeFieldBytes(17, Buffer.concat(tmParts)));
  }

  if (trajectoryType > 0) parts.push(encodeFieldVarint(22, trajectoryType));
  if (forkParentId) parts.push(encodeFieldBytes(24, forkParentId));
  return Buffer.concat(parts);
}

test('Hybrid SQLite+WAL mode skips trajectory RPCs for local DBs, falls back to RPC when DB is absent, deduplicates cloned Side Question steps, protects mainline context, and renders zh/en badges', async (t) => {
  const sqliteMod =
    typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : null;
  if (!sqliteMod?.DatabaseSync) {
    t.skip('node:sqlite DatabaseSync unavailable');
    return;
  }
  const { DatabaseSync } = sqliteMod;
  const tempRoot = mkdtempSync(join(tmpdir(), 'agy-hybrid-sqlite-'));

  const mainCid = '11111111-1111-4111-8111-111111111111';
  const subCid = '22222222-2222-4222-8222-222222222222';
  const sideCid = '33333333-3333-4333-8333-333333333333';
  const emptySideCid = '44444444-4444-4444-8444-444444444444';
  const rpcOnlyCid = '55555555-5555-4555-8555-555555555555';

  // Use promo-period timestamp: 2026-11-18T00:00:00Z = 1794960000
  const baseSec = Math.floor(Date.parse('2026-11-18T00:00:00Z') / 1000);
  const rpcCalls = [];

  const mockLsServer = http.createServer((req, res) => {
    let rawBody = '';
    req.on('data', (chunk) => {
      rawBody += chunk;
    });
    req.on('end', () => {
      const method = req.url.split('/').pop();
      const body = rawBody ? JSON.parse(rawBody) : {};
      rpcCalls.push({ method, cascadeId: body.cascadeId || '' });

      res.setHeader('Content-Type', 'application/json');
      if (method === 'GetUserStatus') {
        res.end(JSON.stringify({ userStatus: { email: 'dev@example.com' } }));
        return;
      }
      if (method === 'RetrieveUserQuotaSummary') {
        res.end(JSON.stringify({ response: { groups: [] } }));
        return;
      }
      if (method === 'GetAvailableModels') {
        res.end(JSON.stringify({ response: { models: {} } }));
        return;
      }
      if (method === 'GetCascadeTrajectory' && body.cascadeId === rpcOnlyCid) {
        res.end(
          JSON.stringify({
            numTotalSteps: 2,
            trajectory: {
              steps: [
                {
                  // Cloned step from mainCid over RPC — must ALSO be stripped by filterClonedTrajectorySteps!
                  type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                  status: 'CORTEX_STEP_STATUS_DONE',
                  metadata: {
                    createdAt: new Date((baseSec + 50) * 1000).toISOString(),
                    finishedGeneratingAt: new Date((baseSec + 54) * 1000).toISOString(),
                    sourceTrajectoryStepInfo: { stepIndex: 0, cascadeId: mainCid },
                    modelUsage: {
                      model: 'MODEL_PLACEHOLDER_M429',
                      apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                      inputTokens: '5000000',
                      cacheReadTokens: '0',
                      outputTokens: '0',
                    },
                  },
                },
                {
                  type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
                  status: 'CORTEX_STEP_STATUS_DONE',
                  metadata: {
                    createdAt: new Date((baseSec + 100) * 1000).toISOString(),
                    finishedGeneratingAt: new Date((baseSec + 102) * 1000).toISOString(),
                    sourceTrajectoryStepInfo: { stepIndex: 1, cascadeId: rpcOnlyCid },
                    modelUsage: {
                      model: 'MODEL_PLACEHOLDER_M320', // gemini-3.8-flash-low: $0.30/M input
                      apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                      inputTokens: '1000000',
                      cacheReadTokens: '0',
                      outputTokens: '0',
                    },
                  },
                },
              ],
            },
          })
        );
        return;
      }
      res.statusCode = 500;
      res.end(JSON.stringify({ error: `unexpected RPC ${method}` }));
    });
  });

  await new Promise((resolve) => mockLsServer.listen(0, '127.0.0.1', resolve));
  const lsPort = mockLsServer.address().port;

  try {
    const agyDir = join(tempRoot, 'antigravity');
    const convDir = join(agyDir, 'conversations');
    mkdirSync(convDir, { recursive: true });

    // 1. Build conversation_summaries.db in WAL mode
    const sumDbPath = join(agyDir, 'conversation_summaries.db');
    const sumDb = new DatabaseSync(sumDbPath);
    sumDb.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        preview TEXT,
        status TEXT,
        source TEXT,
        parent_conversation_id TEXT,
        nesting_depth INTEGER,
        agent_name TEXT,
        not_fully_idle INTEGER,
        killed INTEGER,
        step_count INTEGER,
        last_modified_time TEXT,
        app_data_dir TEXT,
        raw_summary BLOB
      );
      CREATE TABLE conversation_parents (
        conversation_id TEXT,
        parent_id TEXT
      );
    `);

    const insSum = sumDb.prepare(`
      INSERT INTO conversation_summaries (
        conversation_id, title, status, parent_conversation_id, step_count, last_modified_time, app_data_dir, raw_summary
      ) VALUES (?, ?, ?, ?, ?, ?, 'antigravity', ?)
    `);

    insSum.run(
      mainCid,
      'Main Architecture Task',
      'CASCADE_RUN_STATUS_IDLE',
      '',
      2,
      '2026-11-18T00:01:35Z',
      encodeSummaryBlob({
        title: 'Main Architecture Task',
        stepCount: 2,
        lastModSec: baseSec + 95,
        sideQuestionIds: [sideCid, emptySideCid],
        sideQuestionTitles: { [sideCid]: '为什么用 WAL 模式？' },
      })
    );
    insSum.run(
      subCid,
      'SQLite Researcher',
      'CASCADE_RUN_STATUS_IDLE',
      mainCid,
      2,
      '2026-11-18T00:01:10Z',
      encodeSummaryBlob({
        title: 'SQLite Researcher',
        stepCount: 2,
        lastModSec: baseSec + 70,
        parentConversationId: mainCid,
        subagentSpec: { typeName: 'research', role: 'SQLite Researcher' },
      })
    );
    insSum.run(
      sideCid,
      '',
      'CASCADE_RUN_STATUS_IDLE',
      '',
      4,
      '2026-11-18T00:02:00Z',
      encodeSummaryBlob({
        stepCount: 4,
        lastModSec: baseSec + 120,
        trajectoryType: 22,
        forkParentId: mainCid,
      })
    );
    insSum.run(
      emptySideCid,
      '',
      'CASCADE_RUN_STATUS_IDLE',
      '',
      2,
      '2026-11-18T00:01:30Z',
      encodeSummaryBlob({
        stepCount: 2,
        lastModSec: baseSec + 90,
        trajectoryType: 22,
        forkParentId: mainCid,
      })
    );
    // rpcOnlyCid is present in summaries, but has NO local .db file -> must fall back to GetCascadeTrajectory RPC!
    insSum.run(
      rpcOnlyCid,
      'Remote WSL Session',
      'CASCADE_RUN_STATUS_IDLE',
      '',
      1,
      '2026-11-18T00:00:30Z',
      encodeSummaryBlob({
        title: 'Remote WSL Session',
        stepCount: 1,
        lastModSec: baseSec + 30,
      })
    );
    sumDb.prepare('INSERT INTO conversation_parents (conversation_id, parent_id) VALUES (?, ?)').run(sideCid, mainCid);
    sumDb.close();

    const initConvDb = (cid, trajectoryType = 1) => {
      const db = new DatabaseSync(join(convDir, `${cid}.db`));
      db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
        CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
        CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      `);
      db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, ?, 1)').run(cid, cid, trajectoryType);
      return db;
    };

    // 2. Main conversation DB: 1 USER_INPUT ("设计混合 SQLite 读取") + 1 Carbon High response ($12.10, context 120k/256k)
    const mainDb = initConvDb(mainCid, 1);
    mainDb
      .prepare('INSERT INTO steps VALUES (0, 14, 3, ?, ?)')
      .run(
        encodeStepMeta({ createdSec: baseSec + 1, stepIndex: 0, originCascadeId: mainCid }),
        encodeUserInputPayload('设计混合 SQLite 读取')
      );
    mainDb
      .prepare('INSERT INTO steps VALUES (1, 15, 3, ?, ?)')
      .run(
        encodeStepMeta({
          createdSec: baseSec + 50,
          finishedSec: baseSec + 54,
          stepIndex: 1,
          originCascadeId: mainCid,
          modelEnumInt: 1429, // MODEL_PLACEHOLDER_M429 -> Carbon High ($2 + $0.1 + $10 = $12.10)
          inputTokens: 1_000_000,
          cacheReadTokens: 1_000_000,
          outputTokens: 1_000_000,
          thinkingTokens: 400_000,
          responseTokens: 600_000,
        }),
        encodePlannerResponsePayload('这是混合架构方案。')
      );
    mainDb
      .prepare('INSERT INTO gen_metadata VALUES (0, ?)')
      .run(
        encodeGenMeta({
          stepIndex: 1,
          cascadeId: mainCid,
          responseModel: 'gemini-4-carbon-high',
          modelDisplayName: 'Gemini 4 Carbon (High)',
          estimatedTokensUsed: 120_000,
          maxContextTokens: 256_000,
          userMsgTokens: 120_000,
        })
      );
    mainDb.close();

    // 3. Regular subagent DB: 1 Flash 3.8 Low step ($0.30)
    const subDb = initConvDb(subCid, 1);
    subDb
      .prepare('INSERT INTO steps VALUES (0, 14, 3, ?, ?)')
      .run(
        encodeStepMeta({ createdSec: baseSec + 10, stepIndex: 0, originCascadeId: subCid }),
        encodeUserInputPayload('调研 SQLite WAL')
      );
    subDb
      .prepare('INSERT INTO steps VALUES (1, 15, 3, ?, ?)')
      .run(
        encodeStepMeta({
          createdSec: baseSec + 11,
          finishedSec: baseSec + 13,
          stepIndex: 1,
          originCascadeId: subCid,
          modelEnumInt: 1320, // MODEL_PLACEHOLDER_M320 -> $0.30/1M input
          inputTokens: 1_000_000,
        }),
        encodePlannerResponsePayload('WAL 调研完毕')
      );
    subDb.close();

    // 4. Side Question DB (trajectory_type = 22):
    // Contains 2 CLONED parent steps from mainCid ($12.10) + 1 own USER_INPUT + 1 own Flash 3.8 High step ($0.75)
    // Context watermark in Side Question is tiny (15k) and later than mainCid — must NOT overwrite mainCid's context!
    const sideDb = initConvDb(sideCid, 22);
    sideDb
      .prepare('INSERT INTO steps VALUES (0, 14, 3, ?, ?)')
      .run(
        encodeStepMeta({ createdSec: baseSec + 1, stepIndex: 0, originCascadeId: mainCid }),
        encodeUserInputPayload('设计混合 SQLite 读取')
      );
    sideDb
      .prepare('INSERT INTO steps VALUES (1, 15, 3, ?, ?)')
      .run(
        encodeStepMeta({
          createdSec: baseSec + 50,
          finishedSec: baseSec + 54,
          stepIndex: 1,
          originCascadeId: mainCid, // CLONED FROM PARENT! Must be filtered out!
          modelEnumInt: 1429,
          inputTokens: 1_000_000,
          cacheReadTokens: 1_000_000,
          outputTokens: 1_000_000,
        }),
        encodePlannerResponsePayload('克隆的父回复')
      );
    sideDb
      .prepare('INSERT INTO steps VALUES (2, 14, 3, ?, ?)')
      .run(
        encodeStepMeta({ createdSec: baseSec + 80, stepIndex: 2, originCascadeId: sideCid }),
        encodeUserInputPayload('顺便问下为什么用 WAL？')
      );
    sideDb
      .prepare('INSERT INTO steps VALUES (3, 15, 3, ?, ?)')
      .run(
        encodeStepMeta({
          createdSec: baseSec + 81,
          finishedSec: baseSec + 83,
          stepIndex: 3,
          originCascadeId: sideCid,
          modelEnumInt: 1318, // MODEL_PLACEHOLDER_M318 -> $0.75/1M input
          inputTokens: 1_000_000,
        }),
        encodePlannerResponsePayload('因为只读不阻塞 checkpoint。')
      );
    sideDb
      .prepare('INSERT INTO gen_metadata VALUES (0, ?)')
      .run(
        encodeGenMeta({
          stepIndex: 1,
          cascadeId: mainCid, // Cloned gen_metadata from parent!
          responseModel: 'gemini-4-carbon-high',
          modelDisplayName: 'Gemini 4 Carbon (High)',
          estimatedTokensUsed: 120_000,
          maxContextTokens: 256_000,
          userMsgTokens: 120_000,
        })
      );
    sideDb
      .prepare('INSERT INTO gen_metadata VALUES (1, ?)')
      .run(
        encodeGenMeta({
          stepIndex: 3,
          cascadeId: sideCid,
          responseModel: 'gemini-3.8-flash-high',
          modelDisplayName: 'Gemini 3.8 Flash (High)',
          estimatedTokensUsed: 15_000,
          maxContextTokens: 256_000,
          userMsgTokens: 15_000,
        })
      );
    sideDb.close();

    // 5. Empty Side Question DB: only cloned parent steps, 0 own steps -> must be hidden!
    const emptySideDb = initConvDb(emptySideCid, 22);
    emptySideDb
      .prepare('INSERT INTO steps VALUES (0, 15, 3, ?, ?)')
      .run(
        encodeStepMeta({
          createdSec: baseSec + 2,
          finishedSec: baseSec + 6,
          stepIndex: 1,
          originCascadeId: mainCid,
          modelEnumInt: 1429,
          inputTokens: 1_000_000,
        }),
        null
      );
    emptySideDb.close();

    const execFileAsync = promisify(execFile);
    const builderUrl = new URL('../backend/telemetry-builder.mjs', import.meta.url).href;
    const { stdout: rawJson } = await execFileAsync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { buildTelemetryPayload } = await import(${JSON.stringify(builderUrl)});
         const p = await buildTelemetryPayload(${JSON.stringify(mainCid)}, false, { range: 'all' });
         process.stdout.write(JSON.stringify(p));`,
      ],
      {
        env: {
          ...process.env,
          ANTIGRAVITY_GEMINI_DIR: tempRoot,
          ANTIGRAVITY_APP_DATA_DIR: '',
          USAGE_MONITOR_APP_DATA_DIR: '',
          ANTIGRAVITY_EXECUTABLE_DATA_DIR: '',
          USAGE_MONITOR_DATA_DIR: join(tempRoot, 'sidecar-data'),
          ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${lsPort}`,
          ANTIGRAVITY_CSRF_TOKEN: 'test-csrf',
        },
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      }
    );

    const payload = JSON.parse(rawJson);

    // A. Verify RPC calls: ZERO GetAllCascadeTrajectories, ZERO GetCascadeTrajectory for local SQLite DBs,
    //    and exactly ONE GetCascadeTrajectory fallback for rpcOnlyCid!
    assert.equal(
      rpcCalls.some((c) => c.method === 'GetAllCascadeTrajectories'),
      false,
      'local conversation_summaries.db must eliminate GetAllCascadeTrajectories RPC'
    );
    const trajRpcTargets = rpcCalls
      .filter((c) => c.method === 'GetCascadeTrajectory')
      .map((c) => c.cascadeId);
    assert.deepEqual(
      trajRpcTargets,
      [rpcOnlyCid],
      'only conversation missing local .db falls back to GetCascadeTrajectory RPC'
    );

    // B. Top-level conversations list contains ONLY mainCid and rpcOnlyCid (no orphan/empty side questions or subagents)
    assert.deepEqual(
      payload.conversations.map((c) => c.cascadeId).sort(),
      [mainCid, rpcOnlyCid].sort()
    );

    // C. Verify Turn Rail prompt decoded directly from SQLite USER_INPUT step_payload
    const mainUnit = payload.activeConversation.agents.find((a) => a.isMain);
    assert.ok(mainUnit);
    assert.equal(payload.activeConversation.recentSteps[0].turnPrompt, '设计混合 SQLite 读取');

    // D. Verify agents under mainCid: [main, subagent #1, side question #1] (emptySideCid hidden!)
    const agents = payload.activeConversation.agents;
    assert.equal(agents.length, 3);
    assert.equal(agents[1].badgeText, '子1');
    assert.equal(Boolean(agents[1].isSideQuestion), false);
    assert.equal(agents[2].badgeText, '旁1');
    assert.equal(agents[2].isSideQuestion, true);
    assert.equal(agents[2].sideIndex, 1);
    assert.equal(agents[2].role, '为什么用 WAL 模式？');
    assert.equal(agents[2].stepCount, 1, 'cloned parent steps must be stripped from Side Question');
    assert.equal(agents[2].sessionCostUsd, 0.75, 'Side Question bills ONLY its own step ($0.75), never parent ($12.10)');

    // E. Verify total session & account costs have ZERO double-counting:
    // Session (main $12.10 + sub $0.30 + sideQ $0.75) = $13.15
    // Account (session $13.15 + rpcOnlyCid $0.30) = $13.45
    assert.equal(payload.activeConversation.aggregated.sessionCostUsd, 13.15);
    assert.equal(payload.consumption.account.costUsd, 13.45);
    assert.equal(payload.activeConversation.aggregated.role, '主代理 + 1 子代理 + 1 旁问');

    // F. Verify mainline context watermark protection (backend aggregated + frontend auto-follow)
    // Main agent has 3_000_000 tokens (1M in + 1M cache + 1M out), Side Question has 15_000/1_000_000
    assert.equal(payload.activeConversation.aggregated.activeAgentId, 'main');
    assert.equal(payload.activeConversation.aggregated.context.totalTokens, mainUnit.context.totalTokens);

    const scopedAuto = resolveScopedConversation(payload, 'all', 'auto', true);
    assert.equal(scopedAuto.ctxAgent.agentId, 'main', 'auto context inspector locks onto mainline agent');
    const scopedExplicitSide = resolveScopedConversation(payload, 'all', sideCid, false);
    assert.equal(scopedExplicitSide.ctxAgent.agentId, sideCid, 'explicitly selecting Side Question pill still inspects it');

    // G. Verify zh-CN & en-US badge and label formatting
    const prevLocale = i18nStore.getState().locale;
    try {
      i18nStore.setState({ locale: 'zh-CN', hostLocale: 'zh-CN' });
      assert.equal(formatAgentBadgeText(agents[2]), '旁1');
      assert.equal(formatAgentLabel(agents[2]), '旁路提问 #1 · 为什么用 WAL 模式？');

      i18nStore.setState({ locale: 'en-US', hostLocale: 'en-US' });
      assert.equal(formatAgentBadgeText(agents[1]), 'S1');
      assert.equal(formatAgentBadgeText(agents[2]), 'Q1');
      assert.equal(formatAgentLabel(agents[2]), 'Side Question #1 · 为什么用 WAL 模式？');
    } finally {
      i18nStore.setState({ locale: prevLocale });
    }
  } finally {
    await new Promise((resolve) => mockLsServer.close(resolve));
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('persistTrajectoryCacheIfNeeded throttles RUNNING disk writes to 30s and flushes immediately on IDLE or cache rebuild', () => {
  let now = 1_000_000;
  const scheduled = new Map();
  const h = backendHarness({
    cache: { live: { title: 'Cached session', steps: [] } },
    clock: () => now,
    timerApi: {
      setTimeout(_callback, delay) {
        const id = Symbol();
        scheduled.set(id, delay);
        return id;
      },
      clearTimeout(id) {
        scheduled.delete(id);
      },
    },
  });

  // 1st save (lastSavedAtMs === 0) flushes immediately even while running
  h.persistTrajectoryCacheIfNeeded({ hasRunningSessions: true, allowThrottleInTest: true });
  assert.equal(h.state.saves.length, 1);
  assert.equal(h.hasPendingTrajectoryCacheSave(), false);

  // Subsequent saves within 30s window while RUNNING are throttled in memory
  now += 2_000;
  h.persistTrajectoryCacheIfNeeded({ hasRunningSessions: true, allowThrottleInTest: true });
  now += 2_000;
  h.persistTrajectoryCacheIfNeeded({ hasRunningSessions: true, allowThrottleInTest: true });
  assert.equal(h.state.saves.length, 1, '2s polling during RUNNING must not rewrite disk every tick');
  assert.equal(h.hasPendingTrajectoryCacheSave(), true);
  assert.deepEqual([...scheduled.values()], [28_000]);

  // Transitioning to IDLE flushes immediately and clears pending timer
  now += 2_000;
  h.persistTrajectoryCacheIfNeeded({ hasRunningSessions: false, allowThrottleInTest: true });
  assert.equal(h.state.saves.length, 2, 'transition to IDLE flushes immediately');
  assert.equal(h.hasPendingTrajectoryCacheSave(), false);
  assert.equal(scheduled.size, 0);

  // Re-arming throttle then calling executeRebuildCacheAction cancels timer cleanly
  now += 2_000;
  h.persistTrajectoryCacheIfNeeded({ hasRunningSessions: true, allowThrottleInTest: true });
  assert.equal(scheduled.size, 1);
  h.state.cacheWriteError = new Error('Disk unavailable');
  assert.equal(h.executeRebuildCacheAction().status, 500);
  assert.equal(h.getCachedTrajectory('live').title, 'Cached session');
  assert.equal(h.hasPendingTrajectoryCacheSave(), true);
  assert.equal(scheduled.size, 1);

  h.state.cacheWriteError = null;
  const rebuildRes = h.executeRebuildCacheAction();
  assert.equal(rebuildRes.ok, true);
  assert.equal(scheduled.size, 0);
  assert.equal(h.hasPendingTrajectoryCacheSave(), false);
  assert.equal(h.listCachedTrajectoryEntries().length, 0);
  assert.deepEqual(h.state.saves.at(-1).data, {});
});

test('SQLite trajectory reader scans backwards past trailing plannerConfig-only gen_metadata rows to preserve pre-compaction tokenBreakdown', (t) => {
  const sqliteMod =
    typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : null;
  if (!sqliteMod?.DatabaseSync) {
    t.skip('node:sqlite DatabaseSync unavailable');
    return;
  }
  const { DatabaseSync } = sqliteMod;
  const tempRoot = mkdtempSync(join(tmpdir(), 'agy-sqlite-compact-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  const cid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const dbPath = join(tempRoot, `${cid}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
    CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
  `);
  db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, 1, 1)').run(cid, cid);
  db.prepare('INSERT INTO steps VALUES (0, 15, 3, ?, NULL)').run(
    encodeStepMeta({
      createdSec: 1794960010,
      finishedSec: 1794960014,
      stepIndex: 0,
      originCascadeId: cid,
      modelEnumInt: 1429,
      inputTokens: 10000,
      cacheReadTokens: 110000,
      outputTokens: 500,
    })
  );
  // Step 1: CHECKPOINT compaction step (step_type = 23)
  db.prepare('INSERT INTO steps VALUES (1, 23, 3, ?, NULL)').run(
    encodeStepMeta({
      createdSec: 1794960020,
      finishedSec: 1794960024,
      stepIndex: 1,
      originCascadeId: cid,
      modelEnumInt: 1429,
      inputTokens: 10000,
      cacheReadTokens: 110000,
      outputTokens: 2400,
      thinkingTokens: 400,
      responseTokens: 2000,
    })
  );

  // gen_metadata[0] has the full tokenBreakdown, followed by 3 plannerConfig-only records [1..3]
  db.prepare('INSERT INTO gen_metadata VALUES (0, ?)').run(
    encodeGenMeta({
      stepIndex: 0,
      cascadeId: cid,
      responseModel: 'gemini-4-carbon-high',
      modelDisplayName: 'Gemini 4 Carbon (High)',
      estimatedTokensUsed: 120_000,
      maxContextTokens: 384_000,
      userMsgTokens: 120_000,
    })
  );
  const plannerOnlyBlob = encodeFieldBytes(3, encodeFieldBytes(28, 'gemini-4-carbon-high'));
  db.prepare('INSERT INTO gen_metadata VALUES (1, ?)').run(plannerOnlyBlob);
  db.prepare('INSERT INTO gen_metadata VALUES (2, ?)').run(plannerOnlyBlob);
  db.prepare('INSERT INTO gen_metadata VALUES (3, ?)').run(plannerOnlyBlob);
  db.close();

  const res = readLocalSqliteTrajectory(dbPath, { cascadeId: cid });
  assert.ok(res);
  assert.equal(res.steps.length, 2);
  assert.equal(res.steps[1].type, 'CORTEX_STEP_TYPE_CHECKPOINT');
  const gm0 = res.generatorMetadata.find((g) => g.stepIndices.includes(0));
  assert.ok(
    gm0?.chatModel?.chatStartMetadata?.contextWindowMetadata?.tokenBreakdown?.groups?.length > 0,
    'must decode tokenBreakdown on gen_metadata[0] even with 3 trailing plannerConfig-only records'
  );
});

test('computeSqliteWalSig ignores zero-byte .db-wal mtime churn while detecting non-empty WAL writes', (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'agy-sqlite-empty-wal-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  const dbPath = join(tempRoot, 'aaaaaaaa-bbbb-4ccc-8ddd-111111111111.db');
  const walPath = `${dbPath}-wal`;
  writeFileSync(dbPath, Buffer.from('sqlite-main-placeholder'));
  const baseSec = 1_795_000_000;
  utimesSync(dbPath, baseSec, baseSec);

  const sigNoWal = computeSqliteWalSig(dbPath);
  assert.equal(sigNoWal.exists, true);
  assert.ok(sigNoWal.sig.endsWith('|0:0'), `expected |0:0 suffix, got ${sigNoWal.sig}`);

  // Creating and touching a 0-byte .db-wal (e.g. SQLite WAL open/close or host LRU eviction)
  // must NOT change sig or mtimeMs.
  writeFileSync(walPath, Buffer.alloc(0));
  utimesSync(walPath, baseSec + 120, baseSec + 120);
  const sigEmptyWal1 = computeSqliteWalSig(dbPath);
  assert.deepEqual(sigEmptyWal1, sigNoWal);

  utimesSync(walPath, baseSec + 360, baseSec + 360);
  const sigEmptyWal2 = computeSqliteWalSig(dbPath);
  assert.deepEqual(sigEmptyWal2, sigNoWal);

  // Real uncheckpointed WAL write (size > 0) MUST change sig and advance mtimeMs.
  writeFileSync(walPath, Buffer.alloc(4096, 1));
  utimesSync(walPath, baseSec + 500, baseSec + 500);
  const sigNonEmptyWal = computeSqliteWalSig(dbPath);
  assert.notEqual(sigNonEmptyWal.sig, sigNoWal.sig);
  assert.ok(sigNonEmptyWal.mtimeMs > sigNoWal.mtimeMs);
  assert.ok(sigNonEmptyWal.sig.endsWith(':4096'));

  // Truncating the WAL back to 0 bytes converges back to the canonical |0:0 signature.
  truncateSync(walPath, 0);
  utimesSync(walPath, baseSec + 900, baseSec + 900);
  const sigTruncatedWal = computeSqliteWalSig(dbPath);
  assert.deepEqual(sigTruncatedWal, sigNoWal);
});

test('legacy pre-PR#38 empty-WAL sqlite cache signatures migrate in-place without re-reading SQLite', async (t) => {
  const { normalizeEmptyWalSqliteSig } = await import('../backend/local-scanner.mjs');

  assert.equal(
    normalizeEmptyWalSqliteSig('v10-model-identity:sqlite:12:2026-11-22T10:00:00Z:1795400000:50000|1795412345:0'),
    'v10-model-identity:sqlite:12:2026-11-22T10:00:00Z:1795400000:50000|0:0'
  );
  assert.equal(
    normalizeEmptyWalSqliteSig('v10-model-identity:sqlite:12:2026-11-22T10:00:00Z:1795400000:50000|1795412345:4096'),
    'v10-model-identity:sqlite:12:2026-11-22T10:00:00Z:1795400000:50000|1795412345:4096',
    'non-empty WAL signature must NOT be collapsed'
  );

  // End-to-end verification in isolated subprocess: pre-seed trajectory_usage_cache.json with legacy |<walMtime>:0
  // signature for a real .db + 0-byte .db-wal, verify enumerateAndSyncConversations does NOT re-read SQLite
  // (keeping sentinel step marker intact) and normalizes cached signature to |0:0.
  let sqliteMod = null;
  try {
    sqliteMod = await import('node:sqlite');
  } catch {
    sqliteMod = null;
  }
  if (!sqliteMod?.DatabaseSync) {
    t.skip('node:sqlite DatabaseSync unavailable');
    return;
  }
  const { DatabaseSync } = sqliteMod;
  const tempRoot = mkdtempSync(join(tmpdir(), 'agy-sqlite-smooth-upgrade-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  const geminiDir = join(tempRoot, '.gemini');
  const convDir = join(geminiDir, 'antigravity', 'conversations');
  const dataDir = join(geminiDir, 'antigravity', 'sidecar_data', 'usage-monitor', 'panel', 'data');
  mkdirSync(convDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const cid = '99999999-9999-4999-8999-999999999999';
  const dbPath = join(convDir, `${cid}.db`);
  const walPath = `${dbPath}-wal`;
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
    CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
  `);
  db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, 1, 1)').run(cid, cid);
  db.close();

  const baseSec = 1_795_000_000;
  writeFileSync(walPath, Buffer.alloc(0));
  utimesSync(dbPath, baseSec, baseSec);
  utimesSync(walPath, baseSec + 120, baseSec + 120);

  const curSig = computeSqliteWalSig(dbPath);
  assert.ok(curSig.sig.endsWith('|0:0'));
  const legacyDiskSig = curSig.sig.replace(/\|0:0$/, `|${(baseSec + 120) * 1000}:0`);
  const legacyFullSig = `v10-model-identity:sqlite:1::${legacyDiskSig}`;

  // Write a sentinel cached step so if SQLite were re-read (empty steps table), the sentinel would vanish!
  const cacheFile = join(dataDir, 'trajectory_usage_cache.json');
  writeFileSync(
    cacheFile,
    JSON.stringify({
      [cid]: {
        title: 'Pre-PR38 Cached Session',
        signature: legacyFullSig,
        lastModifiedMs: baseSec * 1000,
        diskMtimeMs: baseSec * 1000,
        wasRunning: false,
        offlineSqliteTelemetry: true,
        contextLimitTelemetry: true,
        contextGroupsTelemetry: 2,
        turnRailTelemetry: true,
        anomalyTelemetry: true,
        subagentRefs: [],
        steps: [
          {
            stepIndex: 0,
            turnIndex: 1,
            model: 'MODEL_PLACEHOLDER_M429',
            responseModel: 'gemini-4-carbon-high',
            inputTokens: 1234,
            cacheReadTokens: 0,
            outputTokens: 567,
            thinkingTokens: 0,
            responseTokens: 567,
            createdAtMs: baseSec * 1000,
            completedAtMs: (baseSec + 2) * 1000,
            durationSec: 2,
            ttftSec: 0.5,
            streamSec: 1.5,
            contextBreakdown: { toolResultsTokens: 0 },
          },
        ],
      },
    }),
    'utf8'
  );

  const execFileAsync = promisify(execFile);
  const scannerUrl = new URL('../backend/local-scanner.mjs', import.meta.url).href;
  const configUrl = new URL('../backend/config.mjs', import.meta.url).href;
  const script = `
    import { existsSync } from 'node:fs';
    import { enumerateAndSyncConversations } from ${JSON.stringify(scannerUrl)};
    import { CACHE_FILE, TRAJECTORY_DB_FILE, flushTrajectoryCacheNow, getCachedTrajectory } from ${JSON.stringify(configUrl)};
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    await enumerateAndSyncConversations({ summariesObj: {}, requestedConvId: '' });
    const entry = getCachedTrajectory(${JSON.stringify(cid)});
    flushTrajectoryCacheNow();
    const db = new DatabaseSync(TRAJECTORY_DB_FILE, { readOnly: true });
    const row = db.prepare('SELECT meta_json FROM conversations WHERE lower_id = ?').get(${JSON.stringify(cid.toLowerCase())});
    db.close();
    const onDiskMeta = row?.meta_json ? JSON.parse(row.meta_json) : {};
    console.log(JSON.stringify({
      memSig: entry?.signature || '',
      diskSig: onDiskMeta?.signature || '',
      migratedBakExists: existsSync(CACHE_FILE + '.bak'),
      stepCount: entry?.steps?.length || 0,
      firstInput: entry?.steps?.[0]?.inputTokens || 0,
    }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env,
      ANTIGRAVITY_GEMINI_DIR: geminiDir,
      ANTIGRAVITY_APP_DATA_DIR: '',
      USAGE_MONITOR_APP_DATA_DIR: '',
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
      ANTIGRAVITY_LS_ADDRESS: 'test.invalid',
    },
  });
  const out = JSON.parse(stdout.trim().split('\n').pop());
  assert.equal(out.migratedBakExists, true, 'legacy JSON cache automatically migrated and archived to .bak');
  assert.equal(out.stepCount, 1, 'cached sentinel step preserved (SQLite was NOT re-read)');
  assert.equal(out.firstInput, 1234, 'cached usage preserved intact');
  assert.ok(out.memSig.endsWith('|0:0'), `in-memory signature normalized to |0:0: ${out.memSig}`);
  assert.ok(out.diskSig.endsWith('|0:0'), `persisted signature normalized to |0:0: ${out.diskSig}`);
});

test('readLocalImageDimensionsFromUri and readLocalSqliteTrajectory decode PNG/JPEG/WebP headers and step_type 132 GenerateImage protobuf (140.2.6)', (t) => {
  const sqliteMod =
    typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : null;
  if (!sqliteMod?.DatabaseSync) {
    t.skip('node:sqlite DatabaseSync unavailable');
    return;
  }
  const { DatabaseSync } = sqliteMod;
  const tempDir = mkdtempSync(join(tmpdir(), 'agy-imggen-sqlite-'));
  t.after(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore Windows WAL cleanup lock
    }
  });

  // 1. Minimal valid PNG header (1200x896)
  const pngPath = join(tempDir, 'cat_1k.png');
  const pngBuf = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(pngBuf, 0);
  pngBuf.writeUInt32BE(13, 8);
  pngBuf.write('IHDR', 12, 'ascii');
  pngBuf.writeUInt32BE(1200, 16);
  pngBuf.writeUInt32BE(896, 20);
  writeFileSync(pngPath, pngBuf);

  // 2. Minimal valid JPEG SOF2 header (2048x1536) after APP0 segment
  const jpgPath = join(tempDir, 'scene_2k.jpg');
  const jpgBuf = Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0 (len 4)
    0xff, 0xc2, 0x00, 0x0b, 0x08, 0x06, 0x00, 0x08, 0x00, 0x01, 0x01, 0x11, 0x00, // SOF2: height=1536 (0x0600), width=2048 (0x0800)
    0xff, 0xd9,
  ]);
  writeFileSync(jpgPath, jpgBuf);

  // 3. Minimal valid WebP VP8X header (4096x3072 -> minus-one LE24: 4095=0x000fff, 3071=0x000bff)
  const webpPath = join(tempDir, 'poster_4k.webp');
  const webpBuf = Buffer.alloc(30);
  webpBuf.write('RIFF', 0, 'ascii');
  webpBuf.writeUInt32LE(22, 4);
  webpBuf.write('WEBP', 8, 'ascii');
  webpBuf.write('VP8X', 12, 'ascii');
  webpBuf.writeUInt32LE(10, 16);
  webpBuf[24] = 0xff;
  webpBuf[25] = 0x0f;
  webpBuf[26] = 0x00;
  webpBuf[27] = 0xff;
  webpBuf[28] = 0x0b;
  webpBuf[29] = 0x00;
  writeFileSync(webpPath, webpBuf);

  const toFileUri = (p) => `file:///${p.replace(/\\/g, '/').replace(/^\/+/, '')}`;
  assert.deepEqual(readLocalImageDimensionsFromUri(toFileUri(pngPath)), { width: 1200, height: 896 });
  assert.deepEqual(readLocalImageDimensionsFromUri(toFileUri(jpgPath)), { width: 2048, height: 1536 });
  assert.deepEqual(readLocalImageDimensionsFromUri(toFileUri(webpPath)), { width: 4096, height: 3072 });

  // 4. SQLite trajectory with step_type=132 (GENERIC tool step, toolCall.name='generate_image', payload 140.2.6)
  const cid = 'd369e740-1f52-4f06-90a3-2f88bc623e2e';
  const dbPath = join(tempDir, `${cid}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
    CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
  `);
  db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, 1, 1)').run(cid, cid);

  const baseSec = Math.floor(Date.parse('2026-11-24T01:50:21Z') / 1000);
  const toolCallBytes = Buffer.concat([
    encodeFieldBytes(1, 'call_img_1'),
    encodeFieldBytes(2, 'generate_image'),
    encodeFieldBytes(3, JSON.stringify({ Prompt: '2K mountain sunrise', AspectRatio: '4:3' })),
  ]);
  const metaBytes = Buffer.concat([
    encodeFieldBytes(1, encodeTimestamp(baseSec, 217_000_000)), // createdAt
    encodeFieldBytes(4, toolCallBytes), // toolCall
    encodeFieldBytes(7, encodeTimestamp(baseSec, 337_000_000)), // finishedGeneratingAt (0.12s!)
    encodeFieldBytes(8, encodeTimestamp(baseSec + 63, 127_000_000)), // completedAt (~62.785s!)
    encodeFieldBytes(20, Buffer.concat([encodeFieldVarint(2, 2), encodeFieldBytes(4, cid)])),
    encodeFieldBytes(32, encodeTimestamp(baseSec, 342_000_000)), // startedAt
  ]);

  const genImgProto = Buffer.concat([
    encodeFieldBytes(1, '2K mountain sunrise'),
    encodeFieldBytes(3, '4:3'),
    encodeFieldBytes(4, toFileUri(jpgPath)),
    encodeFieldVarint(5, jpgBuf.length),
    encodeFieldBytes(6, 'gemini-3.1-flash-image'),
    encodeFieldBytes(8, 'scene_2k'),
  ]);
  const anyProto = Buffer.concat([
    encodeFieldBytes(1, 'type.googleapis.com/exa.cortex.core.tools.GenerateImage'),
    encodeFieldBytes(2, genImgProto),
  ]);
  const stepPayload140 = encodeFieldBytes(140, encodeFieldBytes(2, encodeFieldBytes(6, anyProto)));

  db.prepare('INSERT INTO steps VALUES (2, 132, 3, ?, ?)').run(metaBytes, stepPayload140);
  db.close();

  const decoded = readLocalSqliteTrajectory(dbPath, { cascadeId: cid });
  assert.ok(decoded);
  assert.equal(decoded.steps.length, 1);
  assert.equal(decoded.steps[0].type, 'CORTEX_STEP_TYPE_GENERATE_IMAGE');
  assert.equal(decoded.steps[0].generateImage.modelName, 'gemini-3.1-flash-image');
  assert.equal(decoded.steps[0].generateImage.width, 2048);
  assert.equal(decoded.steps[0].generateImage.height, 1536);

  // Extract model steps -> 2048x1536 hits 2K tier -> 1680 output tokens and 62.785s duration!
  const modelSteps = extractModelSteps(decoded.steps, decoded.generatorMetadata);
  assert.equal(modelSteps.length, 1);
  assert.equal(modelSteps[0].isImageGenStep, true);
  assert.equal(modelSteps[0].modelKey, 'gemini-3.1-flash-image');
  assert.equal(modelSteps[0].outputTokens, 1680);
  assert.equal(modelSteps[0].ttftSec, null);
  assert.ok(Math.abs(modelSteps[0].totalDurationSec - 62.785) < 0.01);
});

test('SQLite header readiness guard skips 0-byte, pre-DDL, 32-byte WAL-header-only, and active rollback-journal DBs without acquiring locks', (t) => {
  const sqliteMod =
    typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : null;
  if (!sqliteMod?.DatabaseSync) {
    t.skip('node:sqlite DatabaseSync unavailable');
    return;
  }
  const { DatabaseSync } = sqliteMod;
  const tempRoot = mkdtempSync(join(tmpdir(), 'agy-sqlite-init-guard-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  // 1. Fresh 0-byte DB (just opened by host, before WAL switch or DDL)
  const zeroDbPath = join(tempRoot, 'zero.db');
  const writerZero = new DatabaseSync(zeroDbPath);
  try {
    let readerCalled = false;
    assert.equal(isSqliteDbReadyForRead(zeroDbPath), false);
    assert.equal(computeSqliteWalSig(zeroDbPath).exists, true);
    const res = withReadOnlySqliteDb(zeroDbPath, () => {
      readerCalled = true;
      return 'unexpected';
    });
    assert.equal(res, null);
    assert.equal(readerCalled, false);

    // Host immediately runs page_size + WAL + schema init without hitting SQLITE_BUSY
    writerZero.exec(`
      PRAGMA page_size = 32768;
      PRAGMA journal_mode = WAL;
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER);
      INSERT INTO steps VALUES (0, 14);
    `);

    // Open uncheckpointed WAL DB (pages=1 in main file, committed frames in .db-wal) IS ready
    assert.equal(isSqliteDbReadyForRead(zeroDbPath), true);
    const rowCnt = withReadOnlySqliteDb(zeroDbPath, (db) =>
      db.prepare('SELECT count(*) AS c FROM steps').get()
    );
    assert.equal(rowCnt?.c, 1);
  } finally {
    writerZero.close();
  }

  // After close (WAL checkpointed & removed, pages >= 2 & schemaCookie > 0 in main file), still ready
  assert.equal(isSqliteDbReadyForRead(zeroDbPath), true);

  // 2. 1-page WAL header before any DDL is committed (walSize=0 or 32B WAL header only)
  const preDdlWalPath = join(tempRoot, 'pre-ddl-wal.db');
  const writerPreDdl = new DatabaseSync(preDdlWalPath);
  try {
    writerPreDdl.exec('PRAGMA page_size = 32768; PRAGMA journal_mode = WAL;');
    assert.equal(isSqliteDbReadyForRead(preDdlWalPath), false);
    assert.equal(isSqliteDbReadyForRead(preDdlWalPath, { walStat: { size: 32 } }), false);
    assert.equal(withReadOnlySqliteDb(preDdlWalPath, () => 1), null);
  } finally {
    writerPreDdl.close();
  }

  // 3. Active rollback-journal DDL transaction (non-empty <db>-journal before WAL switch)
  const rollbackDbPath = join(tempRoot, 'rollback-init.db');
  const writerRollback = new DatabaseSync(rollbackDbPath);
  try {
    writerRollback.exec('CREATE TABLE t_seed (x INT);');
    writerRollback.exec('BEGIN IMMEDIATE; CREATE TABLE steps (idx INT); INSERT INTO steps VALUES (1);');
    assert.equal(isSqliteDbReadyForRead(rollbackDbPath), false);
    assert.equal(withReadOnlySqliteDb(rollbackDbPath, () => 1), null);

    // Writer commits and switches to WAL cleanly without lock contention
    writerRollback.exec('COMMIT; PRAGMA journal_mode = WAL;');
    assert.equal(isSqliteDbReadyForRead(rollbackDbPath), true);
    const rbCnt = withReadOnlySqliteDb(rollbackDbPath, (db) =>
      db.prepare('SELECT count(*) AS c FROM steps').get()
    );
    assert.equal(rbCnt?.c, 1);
  } finally {
    writerRollback.close();
  }

  // 4. Oversized transcript_full.jsonl is safely rejected by size guard
  const logsDir = join(tempRoot, 'oversize-logs');
  mkdirSync(logsDir, { recursive: true });
  const fullPath = join(logsDir, 'transcript_full.jsonl');
  writeFileSync(fullPath, '{"step_index":0,"input_tokens":10,"output_tokens":5}\n', 'utf8');
  assert.equal(resolveTranscriptPathInLogsDir(logsDir, { maxFullBytes: 1024 }), fullPath);
  assert.equal(resolveTranscriptPathInLogsDir(logsDir, { maxFullBytes: 16 }), '');
  assert.deepEqual(readTranscriptJsonlLines(fullPath, { maxBytes: 16 }), []);
});

test('Empty-shell .db + encrypted .pb fallback recovers CLI conversation steps, subagents, and live updates from transcript.jsonl even when present in conversation_summaries.db', async (t) => {
  const sqliteMod =
    typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : null;
  if (!sqliteMod?.DatabaseSync) {
    t.skip('node:sqlite DatabaseSync unavailable');
    return;
  }
  const { DatabaseSync } = sqliteMod;
  const tempRoot = mkdtempSync(join(tmpdir(), 'agy-pb-fallback-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

  const p3Cid = '73384c09-50e3-4434-9b39-f8336aee5909';
  const childCid = '1d0dfb7b-2a04-47b6-bcaf-1eb76aa34e34';
  const orphanPbCid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const normalOlderCid = 'bbbbbbbb-1111-4222-8333-cccccccccccc';

  const rpcCalls = [];
  const mockLsServer = http.createServer((req, res) => {
    let rawBody = '';
    req.on('data', (chunk) => {
      rawBody += chunk;
    });
    req.on('end', () => {
      const method = req.url.split('/').pop();
      const body = rawBody ? JSON.parse(rawBody) : {};
      rpcCalls.push({ method, cascadeId: body.cascadeId || '' });

      res.setHeader('Content-Type', 'application/json');
      if (method === 'GetUserStatus') {
        res.end(JSON.stringify({ userStatus: { email: 'dev@example.com' } }));
        return;
      }
      if (method === 'RetrieveUserQuotaSummary') {
        res.end(JSON.stringify({ response: { groups: [] } }));
        return;
      }
      if (method === 'GetAvailableModels') {
        res.end(JSON.stringify({ response: { models: {} } }));
        return;
      }
      if (method === 'GetCascadeTrajectory') {
        res.statusCode = 404;
        res.end(JSON.stringify({ code: 'not_found', message: 'conversation not found in desktop LS' }));
        return;
      }
      res.statusCode = 500;
      res.end(JSON.stringify({ error: `unexpected RPC ${method}` }));
    });
  });

  await new Promise((resolve) => mockLsServer.listen(0, '127.0.0.1', resolve));
  const lsPort = mockLsServer.address().port;
  t.after(() => mockLsServer.close());

  const geminiDir = join(tempRoot, '.gemini');
  const cliDir = join(geminiDir, 'antigravity-cli');
  const cliConvDir = join(cliDir, 'conversations');
  const dataDir = join(geminiDir, 'antigravity', 'sidecar_data', 'usage-monitor', 'panel', 'data');
  mkdirSync(cliConvDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  // 1. Create CLI conversation_summaries.db with P3 (step_count=35, empty title), child subagent, and an unreadable .pb-only session
  const sumDb = new DatabaseSync(join(cliDir, 'conversation_summaries.db'));
  sumDb.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT,
      preview TEXT,
      status TEXT,
      source TEXT,
      parent_conversation_id TEXT,
      nesting_depth INTEGER,
      agent_name TEXT,
      not_fully_idle INTEGER,
      killed INTEGER,
      step_count INTEGER,
      last_modified_time TEXT,
      app_data_dir TEXT,
      raw_summary BLOB
    );
  `);
  const insSum = sumDb.prepare(`
    INSERT INTO conversation_summaries (
      conversation_id, title, preview, status, source, parent_conversation_id,
      nesting_depth, agent_name, not_fully_idle, killed, step_count, last_modified_time, app_data_dir
    ) VALUES (?, ?, '', 'CASCADE_RUN_STATUS_IDLE', 'CORTEX_TRAJECTORY_SOURCE_CLI', ?, ?, '', 0, 0, ?, ?, 'antigravity-cli')
  `);
  insSum.run(p3Cid, '', '', 0, 35, '2026-11-24 15:09:34.2531675+00:00');
  insSum.run(childCid, '', p3Cid, 1, 4, '2026-11-24 15:05:00.0000000+00:00');
  insSum.run(orphanPbCid, 'Legacy Encrypted Only', '', 0, 20, '2026-11-24 14:00:00.0000000+00:00');
  sumDb.close();

  // 2. Create empty-shell .db (steps=0, gen_metadata=0) + encrypted .pb for P3 and orphanPbCid
  for (const emptyCid of [p3Cid, orphanPbCid]) {
    const emptyDbPath = join(cliConvDir, `${emptyCid}.db`);
    const emptyDb = new DatabaseSync(emptyDbPath);
    emptyDb.exec(`
      PRAGMA page_size = 32768;
      PRAGMA journal_mode = WAL;
      CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
      PRAGMA user_version = 1;
    `);
    emptyDb.prepare('INSERT INTO trajectory_meta VALUES (?, ?, 0, 0)').run(emptyCid, emptyCid);
    emptyDb.prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', X'')").run();
    emptyDb.close();
  }

  const p3PbPath = join(cliConvDir, `${p3Cid}.pb`);
  const orphanPbPath = join(cliConvDir, `${orphanPbCid}.pb`);
  writeFileSync(p3PbPath, Buffer.alloc(4096, 0xa5));
  writeFileSync(orphanPbPath, Buffer.alloc(2048, 0x5a));

  // Older normal SQLite session to ensure cli-statusline prefers newer .pb session mtime
  const olderDbPath = join(cliConvDir, `${normalOlderCid}.db`);
  const olderDb = new DatabaseSync(olderDbPath);
  olderDb.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
    CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
  `);
  olderDb
    .prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (0, 15, 3, ?)')
    .run(
      encodeStepMeta({
        createdSec: 1795520000,
        finishedSec: 1795520002,
        stepIndex: 0,
        originCascadeId: normalOlderCid,
        modelEnumInt: 1429,
        inputTokens: 500,
        outputTokens: 50,
      })
    );
  olderDb.close();
  utimesSync(olderDbPath, 1795520002, 1795520002);
  utimesSync(join(cliConvDir, `${orphanPbCid}.db`), 1795528800, 1795528800);
  utimesSync(orphanPbPath, 1795528800, 1795528800);
  utimesSync(join(cliConvDir, `${p3Cid}.db`), 1795532499, 1795532499);
  utimesSync(p3PbPath, 1795532974, 1795532974);

  // 3. Write P3 and child subagent transcript.jsonl files
  const p3LogDir = join(cliDir, 'brain', p3Cid, '.system_generated', 'logs');
  const childLogDir = join(cliDir, 'brain', childCid, '.system_generated', 'logs');
  mkdirSync(p3LogDir, { recursive: true });
  mkdirSync(childLogDir, { recursive: true });

  const p3TranscriptPath = join(p3LogDir, 'transcript.jsonl');
  const p3Lines = [
    JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-24T15:01:39Z',
      content: '<USER_REQUEST>\nPolyglot P3 八道题离线求解\n</USER_REQUEST>',
    }),
    JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-24T15:01:39Z',
      model: 'gemini-4-neon-xhigh',
      input_tokens: 16431,
      cache_read_tokens: 0,
      output_tokens: 2476,
      tool_calls: [
        {
          id: 'call_sub_1',
          name: 'invoke_subagent',
          args: { Role: '"Polyglot Verifier"', TypeName: '"research"' },
        },
      ],
    }),
    JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      tool_call_id: 'call_sub_1',
      created_at: '2026-11-24T15:02:00Z',
      content: `Created the following subagent:\n{\n  "conversationId": "${childCid}"\n}`,
    }),
    JSON.stringify({
      step_index: 34,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-24T15:02:05Z',
      model: 'gemini-4-neon-xhigh',
      input_tokens: 10611,
      cache_read_tokens: 16432,
      output_tokens: 54193,
      content: '已完成全部 8 道题。',
    }),
  ];
  writeFileSync(p3TranscriptPath, p3Lines.join('\n'), 'utf8');

  writeFileSync(
    join(childLogDir, 'transcript.jsonl'),
    [
      JSON.stringify({
        step_index: 0,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        created_at: '2026-11-24T15:02:01Z',
        content: 'Verify edge cases for poker and sgf-parsing.',
      }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-24T15:02:03Z',
        model: 'gemini-4-neon-xhigh',
        input_tokens: 4000,
        cache_read_tokens: 0,
        output_tokens: 500,
        content: 'Verified.',
      }),
    ].join('\n'),
    'utf8'
  );

  // Verify cli-statusline picks P3 (via .pb mtime) and recovers metrics from transcript.jsonl
  const prevDataDirEnv = process.env.USAGE_MONITOR_DATA_DIR;
  process.env.USAGE_MONITOR_DATA_DIR = dataDir;
  try {
    const cliMetrics = resolveCliLocalSessionMetrics({
      cliRoot: cliDir,
      stdinData: null,
      nowMs: Date.parse('2026-11-24T15:10:00Z'),
    });
    assert.equal(cliMetrics.found, true);
    assert.equal(cliMetrics.cascadeId, p3Cid);
    assert.equal(cliMetrics.stepCount, 2);
    assert.equal(cliMetrics.sessionTokens, 16431 + 2476 + 10611 + 16432 + 54193);
    assert.ok(cliMetrics.sessionCost > 0.9, `expected priced Neon cost, got ${cliMetrics.sessionCost}`);
    assert.match(cliMetrics.latestModelHint, /Neon/i);
  } finally {
    if (prevDataDirEnv === undefined) delete process.env.USAGE_MONITOR_DATA_DIR;
    else process.env.USAGE_MONITOR_DATA_DIR = prevDataDirEnv;
  }

  // Verify panel telemetry-builder recovers P3 + subagent, preserves contextGroupsTelemetry=3, avoids steady-state RPC spam, and picks up live transcript growth
  const execFileAsync = promisify(execFile);
  const builderUrl = new URL('../backend/telemetry-builder.mjs', import.meta.url).href;
  const configUrl = new URL('../backend/config.mjs', import.meta.url).href;
  const script = `
    import { appendFileSync, utimesSync } from 'node:fs';
    import { buildTelemetryPayload } from ${JSON.stringify(builderUrl)};
    import { getCachedTrajectory } from ${JSON.stringify(configUrl)};

    const p1 = await buildTelemetryPayload(${JSON.stringify(p3Cid)}, false, { range: 'all' });
    const cachedP3 = getCachedTrajectory(${JSON.stringify(p3Cid)});
    const p2 = await buildTelemetryPayload(${JSON.stringify(p3Cid)}, false, { range: 'all' });

    // Append a new step to P3 transcript.jsonl + touch .pb while empty .db remains untouched
    appendFileSync(
      ${JSON.stringify(p3TranscriptPath)},
      '\\n' + JSON.stringify({
        step_index: 35,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-24T15:09:40Z',
        model: 'gemini-4-neon-xhigh',
        input_tokens: 2000,
        cache_read_tokens: 20000,
        output_tokens: 1000,
        content: '补充自检通过。',
      }),
      'utf8'
    );
    utimesSync(${JSON.stringify(p3PbPath)}, 1795532985, 1795532985);
    const p3 = await buildTelemetryPayload(${JSON.stringify(p3Cid)}, false, { range: 'all' });

    const convEntry1 = p1.conversations.find((c) => c.cascadeId === ${JSON.stringify(p3Cid)});
    const orphanEntry = p1.conversations.find((c) => c.cascadeId === ${JSON.stringify(orphanPbCid)});
    console.log(JSON.stringify({
      title: p1.activeConversation?.title,
      cachedCtxGrpVer: cachedP3?.contextGroupsTelemetry || 0,
      mainSteps1: p1.activeConversation?.agents?.[0]?.stepCount,
      subCount1: p1.activeConversation?.subagentCount,
      subRole1: p1.activeConversation?.agents?.[1]?.role,
      subSteps1: p1.activeConversation?.agents?.[1]?.stepCount,
      listStepCount1: convEntry1?.stepCount,
      listTotalStepCount1: convEntry1?.totalStepCount,
      mainIn1: p1.activeConversation?.agents?.[0]?.inputTokens,
      mainCache1: p1.activeConversation?.agents?.[0]?.cacheReadTokens,
      mainOut1: p1.activeConversation?.agents?.[0]?.outputTokens,
      orphanStepCount: orphanEntry?.stepCount,
      mainSteps2: p2.activeConversation?.agents?.[0]?.stepCount,
      mainSteps3: p3.activeConversation?.agents?.[0]?.stepCount,
    }));
  `;

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ['--input-type=module', '-e', script],
    {
      env: {
        ...process.env,
        ANTIGRAVITY_GEMINI_DIR: geminiDir,
        ANTIGRAVITY_APP_DATA_DIR: '',
        USAGE_MONITOR_APP_DATA_DIR: '',
        ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
        ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${lsPort}`,
        ANTIGRAVITY_LS_PLAIN_HTTP: '1',
        ANTIGRAVITY_CSRF_TOKEN: 'test-csrf',
      },
    }
  );

  assert.equal(stderr.trim(), '', `expected no noisy stderr on expected CLI 404 fallback, got: ${stderr}`);
  const res = JSON.parse(stdout.trim().split('\n').pop());
  assert.equal(res.title, 'Polyglot P3 八道题离线求解');
  assert.equal(res.cachedCtxGrpVer, 3, 'offline recovered entry keeps contextGroupsTelemetry=3');
  assert.equal(res.mainSteps1, 2);
  assert.equal(res.subCount1, 1);
  assert.equal(res.subRole1, 'Polyglot Verifier');
  assert.equal(res.subSteps1, 1);
  assert.equal(res.listStepCount1, 2, 'root stepCount matches 2 recovered main model steps (not raw 35)');
  assert.equal(res.listTotalStepCount1, 3, 'root totalStepCount matches 2 main + 1 subagent recovered model steps');
  assert.equal(res.mainIn1, 16431 + 10611);
  assert.equal(res.mainCache1, 16432);
  assert.equal(res.mainOut1, 2476 + 54193);
  assert.equal(res.orphanStepCount, 0, 'unreadable .pb without transcript normalizes stepCount to 0 instead of raw 20');
  assert.equal(res.mainSteps2, 2);
  assert.equal(res.mainSteps3, 3, 'growing transcript.jsonl + .pb advances signature even when empty .db is frozen');

  const p3RpcCallsAfter2Polls = rpcCalls.filter(
    (c) => c.method === 'GetCascadeTrajectory' && c.cascadeId === p3Cid
  );
  assert.equal(
    p3RpcCallsAfter2Polls.length,
    2,
    'poll 1 and post-growth poll 3 attempted RPC once each; steady poll 2 hit cooldown without hammering LS'
  );
});

test('readLocalSqliteTrajectoryIncremental matches full extraction bit-for-bit on append and falls back cleanly on undo/truncation', async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const { readLocalSqliteTrajectoryIncremental } = await import('../backend/cli-sqlite-reader.mjs');
  const { extractModelSteps } = await import('../trajectory-metrics.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'ag-um-sqlite-inc-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const cid = 'a1b2c3d4-1111-4222-8333-444455556666';
  const dbPath = join(dir, `${cid}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
    CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
    CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
  `);
  db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, 0, 0)').run(cid, cid);
  db.prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', X'')").run();

  const insStep = db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)');
  // Insert 10 model steps across 2 turns (idx 0 = USER_INPUT, idx 1..5 = PLANNER, idx 6 = USER_INPUT, idx 7..11 = PLANNER)
  insStep.run(0, 14, 3, encodeStepMeta({ createdSec: 1795600000, stepIndex: 0, originCascadeId: cid }));
  for (let i = 1; i <= 5; i += 1) {
    insStep.run(
      i,
      15,
      3,
      encodeStepMeta({
        createdSec: 1795600000 + i * 5,
        finishedSec: 1795600000 + i * 5 + 2,
        stepIndex: i,
        originCascadeId: cid,
        modelEnumInt: 1429,
        inputTokens: 1000 + i * 100,
        outputTokens: 80 + i * 10,
      })
    );
  }
  insStep.run(6, 14, 3, encodeStepMeta({ createdSec: 1795600100, stepIndex: 6, originCascadeId: cid }));
  for (let i = 7; i <= 11; i += 1) {
    insStep.run(
      i,
      15,
      3,
      encodeStepMeta({
        createdSec: 1795600100 + (i - 6) * 5,
        finishedSec: 1795600100 + (i - 6) * 5 + 2,
        stepIndex: i,
        originCascadeId: cid,
        modelEnumInt: 1429,
        inputTokens: 2000 + i * 100,
        outputTokens: 120 + i * 10,
      })
    );
  }

  const initialFull = readLocalSqliteTrajectory(dbPath, { cascadeId: cid, isRunning: true });
  const initialSteps = extractModelSteps(initialFull.steps, initialFull.generatorMetadata);
  assert.equal(initialSteps.length, 10);

  // Build cursor at model step index 7 (raw idx = 9, leaving raw idx 10..11 in tail)
  const cutPos = 7;
  const cutStep = initialSteps[cutPos];
  const stableRawIdx = cutStep.stepIndex; // 9
  const stableRawRowCount = initialFull.steps.filter((s) => s.idx <= stableRawIdx).length;
  const cursor = {
    stableRawIdx,
    stableRawRowCount,
    stableMaxGenIdx: -1,
    isChildTrajectory: false,
    isSideQuestion: false,
    trajectoryType: 0,
    forkParentConversationId: '',
    firstOwnUserPrompt: '',
    rootConversationId: '',
    parentConversationId: '',
    trajectoryMetadata: initialFull.trajectory.metadata,
  };

  // Append a new user turn + 2 new model steps
  insStep.run(12, 14, 3, encodeStepMeta({ createdSec: 1795600200, stepIndex: 12, originCascadeId: cid }));
  insStep.run(
    13,
    15,
    3,
    encodeStepMeta({
      createdSec: 1795600205,
      finishedSec: 1795600208,
      stepIndex: 13,
      originCascadeId: cid,
      modelEnumInt: 1429,
      inputTokens: 4200,
      outputTokens: 260,
    })
  );
  insStep.run(
    14,
    15,
    3,
    encodeStepMeta({
      createdSec: 1795600215,
      finishedSec: 1795600218,
      stepIndex: 14,
      originCascadeId: cid,
      modelEnumInt: 1429,
      inputTokens: 4600,
      outputTokens: 310,
    })
  );

  const incRes = readLocalSqliteTrajectoryIncremental(dbPath, cursor, { cascadeId: cid, isRunning: true });
  assert.ok(incRes && incRes.incremental, 'incremental read succeeds on append-only growth');
  assert.equal(incRes.steps.length, 5, 'incremental read only loads tail rows idx 10..14');

  const incTailModel = extractModelSteps(incRes.steps, incRes.generatorMetadata, {
    turnCounter: cutStep.turnIndex,
    activeTurnIndex: cutStep.turnIndex,
    hasHumanUserTurn: true,
    lastCompactionStepIdx: -1,
    lastKnownGmStepIdx: stableRawIdx,
  });
  const combinedSteps = initialSteps.slice(0, cutPos + 1).concat(incTailModel);

  const postFull = readLocalSqliteTrajectory(dbPath, { cascadeId: cid, isRunning: true });
  const postFullSteps = extractModelSteps(postFull.steps, postFull.generatorMetadata);
  assert.deepEqual(combinedSteps, postFullSteps, 'incremental extraction matches full scan bit-for-bit');

  // Simulate undo/truncation deleting prefix rows -> incremental reader MUST return null for full fallback
  db.prepare('DELETE FROM steps WHERE idx >= 8').run();
  db.close();
  const afterUndo = readLocalSqliteTrajectoryIncremental(dbPath, cursor, { cascadeId: cid, isRunning: false });
  assert.equal(afterUndo, null, 'incremental read returns null on prefix truncation so caller falls back to full scan');
});
