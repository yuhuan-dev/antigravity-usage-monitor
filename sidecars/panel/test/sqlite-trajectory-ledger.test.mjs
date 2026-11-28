import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { MODEL_IDENTITY_VERSION } from '../trajectory-metrics.mjs';
import {
  DEFAULT_HOT_SESSION_LRU_LIMIT,
  createTrajectoryCacheStore,
} from '../backend/trajectory-cache-store.mjs';

const execFileAsync = promisify(execFile);

function loadJsonHelper(filePath, fallback = null) {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function makeRichStep(stepIndex, overrides = {}) {
  const baseMs = Date.parse('2026-11-20T08:00:00Z') + stepIndex * 5_000;
  return {
    stepIndex,
    isCompactionStep: false,
    modelKey: 'MODEL_PLACEHOLDER_M429',
    modelSource: 'generatorMetadata.chatModel.model',
    responseModel: 'gemini-4-carbon-high',
    modelIdentityVersion: MODEL_IDENTITY_VERSION,
    modelDisplayName: 'Gemini 4 Carbon (High)',
    apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
    createdAt: new Date(baseMs).toISOString(),
    createdAtMs: baseMs,
    hasVisibleText: true,
    hasToolCalls: false,
    inputTokens: 10_000 + stepIndex * 100,
    cacheReadTokens: 40_000,
    outputTokens: 600,
    thinkingTokens: 200,
    responseTokens: 400,
    estimatedContextTokens: 50_600,
    maxContextBudgetTokens: 1_000_000,
    reportedContextLimitTokens: 1_000_000,
    contextBreakdown: {
      totalTokens: 50_600,
      messagesTokens: 32_000,
      userInputTokens: 8_000,
      assistantTokens: 14_000,
      toolResultsTokens: 10_000,
      subagentTokens: 0,
      checkpointTokens: 0,
      systemToolsTokens: 9_600,
      mcpToolsTokens: 2_000,
      skillsTokens: 3_000,
      systemPromptTokens: 3_000,
      userRulesTokens: 1_000,
    },
    measurementVersion: 4,
    isComplete: true,
    nativeTtftSec: 1.5,
    nativeStreamSec: 4.5,
    viewableDelaySec: 1.6,
    ttftSec: 1.5,
    ttftSource: 'generator_metadata',
    thinkingDurationSec: 1.2,
    totalDurationSec: 6.0,
    totalTokPerSec: 100,
    speedBasis: 'request_total',
    speedSampleEligible: true,
    speedReason: null,
    turnIndex: 1,
    isTurnStart: stepIndex === 1,
    turnPrompt: `Prompt for step ${stepIndex}`,
    turnPromptClean: `Prompt for step ${stepIndex}`,
    turnHasMedia: false,
    turnMediaOnly: false,
    ...overrides,
  };
}

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

function encodeTimestamp(sec) {
  return encodeFieldBytes(1, Buffer.concat([encodeFieldVarint(1, sec)])).subarray(2);
}

function encodeStepMeta({ createdSec, finishedSec, stepIndex, originCid, inputTokens, outputTokens }) {
  const ts = (sec) => encodeFieldBytes(1, Buffer.concat([encodeFieldVarint(1, sec)])).subarray(2);
  const mu = Buffer.concat([
    encodeFieldVarint(1, 1429), // MODEL_PLACEHOLDER_M429 (Carbon High)
    encodeFieldVarint(2, inputTokens),
    encodeFieldVarint(3, outputTokens),
    encodeFieldVarint(6, 24),
  ]);
  return Buffer.concat([
    encodeFieldBytes(1, ts(createdSec)),
    encodeFieldBytes(7, ts(finishedSec)),
    encodeFieldBytes(9, mu),
    encodeFieldBytes(20, Buffer.concat([encodeFieldVarint(2, stepIndex), encodeFieldBytes(4, originCid)])),
  ]);
}

test('SQLite ledger automatically migrates legacy trajectory_usage_cache.json to .sqlite, archives .bak, and preserves lossless details & anomalies', (t) => {
  const sqliteMod =
    typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : null;
  if (!sqliteMod?.DatabaseSync) {
    t.skip('node:sqlite DatabaseSync unavailable');
    return;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'agy-ledger-mig-'));
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const legacyJson = join(tmp, 'trajectory_usage_cache.json');
  const sqliteFile = join(tmp, 'trajectory_store.sqlite');
  const mainCid = 'aaaaaaaa-1111-4111-8111-111111111111';
  const subCid = 'bbbbbbbb-2222-4222-8222-222222222222';

  const step1 = makeRichStep(1, {
    accountName: 'alice@example.com',
    anomaly: {
      count: 2,
      severity: 'warn',
      primaryKind: 'rate_limit',
      totalDelaySec: 8.5,
      kinds: { rate_limit: 2 },
    },
    anomalySig: 'rl:2',
  });
  const cpStep = makeRichStep(2, {
    isCompactionStep: true,
    modelKey: undefined,
    responseModel: '',
    modelDisplayName: '',
    contextBreakdown: null,
    inputTokens: 5_000,
    cacheReadTokens: 0,
    outputTokens: 300,
    thinkingTokens: 0,
    responseTokens: 300,
  });
  delete cpStep.modelKey;

  writeFileSync(
    legacyJson,
    JSON.stringify({
      [mainCid.toUpperCase()]: {
        title: 'Legacy Migrated Root',
        signature: 'v10-model-identity:sqlite:1::100:200|0:0',
        accountName: 'bob@example.com',
        workspaceUri: 'file:///f:/demo/project',
        subagentRefs: [{ cascadeId: subCid, role: 'Researcher', typeName: 'research', spawnOrder: 0 }],
        steps: [step1, cpStep],
      },
      [subCid]: {
        title: 'Researcher',
        parentConversationId: mainCid,
        rootConversationId: mainCid,
        subagentSpec: { typeName: 'research', role: 'Researcher' },
        steps: [makeRichStep(1, { inputTokens: 2_000, outputTokens: 100 })],
      },
    }),
    'utf8'
  );

  const store = createTrajectoryCacheStore({
    cacheFilePath: legacyJson,
    sqliteFilePath: sqliteFile,
    enableSqlite: true,
    loadJsonFn: loadJsonHelper,
  });

  // Cold startup list reads slim accounting entries without hydrating detail_json
  const entries = store.listCachedTrajectoryEntries();
  assert.equal(entries.length, 2);
  assert.equal(existsSync(sqliteFile), true);
  assert.equal(existsSync(legacyJson), false, 'legacy JSON moved out of active path');
  assert.equal(existsSync(`${legacyJson}.bak`), true, 'legacy JSON safely archived to .bak');

  // Cold entry omits heavy contextBreakdown/turnPrompt, retains anomaly/accountName/inferred compaction model!
  assert.equal(store.isConversationCold(mainCid), true);
  const coldMain = store.getCachedTrajectoryEntryByLower(mainCid)?.entry;
  assert.ok(coldMain);
  assert.equal(coldMain.steps.length, 2);
  assert.equal(coldMain.steps[0].contextBreakdown, undefined, 'cold step omits heavy contextBreakdown');
  assert.equal(coldMain.steps[0].turnPrompt, undefined, 'cold step omits heavy turnPrompt');
  assert.deepEqual(coldMain.steps[0].anomaly, step1.anomaly, 'cold step preserves anomaly for model ranking');
  assert.equal(coldMain.steps[0].accountName, 'alice@example.com');
  assert.equal(coldMain.steps[1].modelKey, 'MODEL_PLACEHOLDER_M429', 'compaction step inferred model during migration');

  // Explicit hydration restores 100% lossless step details
  const hydratedMain = store.getHydratedTrajectoryEntryByLower(mainCid)?.entry;
  assert.equal(store.isConversationCold(mainCid), false);
  assert.deepEqual(hydratedMain.steps[0].contextBreakdown, step1.contextBreakdown);
  assert.equal(hydratedMain.steps[0].turnPrompt, 'Prompt for step 1');
  assert.equal(hydratedMain.steps[0].reportedContextLimitTokens, 1_000_000);
});

test('Hot 24-session LRU evicts cold detail memory, never thrashes during full-list scans, and re-hydrates on demand', (t) => {
  const sqliteMod =
    typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : null;
  if (!sqliteMod?.DatabaseSync) {
    t.skip('node:sqlite DatabaseSync unavailable');
    return;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'agy-ledger-lru-'));
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const sqliteFile = join(tmp, 'trajectory_store.sqlite');
  const store = createTrajectoryCacheStore({
    sqliteFilePath: sqliteFile,
    enableSqlite: true,
    hotSessionLimit: 24,
  });

  const originalStep0 = makeRichStep(1, {
    turnPrompt: 'Deep historical architecture prompt #0',
    anomaly: { count: 1, severity: 'danger', primaryKind: 'timeout', totalDelaySec: 30, kinds: { timeout: 1 } },
  });

  for (let i = 0; i < 32; i += 1) {
    const cid = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    store.setCachedTrajectory(cid, {
      title: `Session #${i}`,
      signature: `v10-model-identity:sqlite:1::${i}`,
      wasRunning: false,
      contextGroupsTelemetry: 3,
      turnRailTelemetry: true,
      anomalyTelemetry: 1,
      steps: [i === 0 ? originalStep0 : makeRichStep(1, { turnPrompt: `Prompt #${i}` })],
    });
  }

  // Before flush, dirty unflushed sessions MUST NOT drop detail_json prematurely!
  const cid0 = '00000000-0000-4000-8000-000000000000';
  assert.ok(store.getCachedTrajectory(cid0).steps[0].contextBreakdown, 'dirty unflushed session retains detail');

  // Flush writes all 32 to SQLite, then trims hot LRU down to 24!
  assert.equal(store.flushTrajectoryCacheNow(), true);
  assert.equal(store.getHotSessionCount(), 24);
  assert.equal(store.isConversationCold(cid0), true, 'oldest session #0 evicted to cold slim mode');
  assert.equal(store.getCachedTrajectory(cid0).steps[0].contextBreakdown, undefined);
  assert.deepEqual(store.getCachedTrajectory(cid0).steps[0].anomaly, originalStep0.anomaly);

  // Iterating all 32 conversations via getCachedTrajectory / listCachedTrajectoryEntries MUST NOT hydrate cold sessions!
  for (const [cid] of store.listCachedTrajectoryEntries()) {
    const e = store.getCachedTrajectory(cid);
    assert.equal(e.steps.length, 1);
  }
  assert.equal(store.isConversationCold(cid0), true, 'scan loop caused zero cold SQLite reads');
  assert.equal(store.getHotSessionCount(), 24);

  // Explicit hydration of cold session #0 restores exact original step and evicts #8
  const hydrated0 = store.getHydratedTrajectory(cid0);
  assert.equal(store.isConversationCold(cid0), false);
  assert.equal(store.getHotSessionCount(), 24);
  assert.equal(isDeepStrictEqual(hydrated0.steps[0], originalStep0), true);
  assert.equal(store.isConversationCold('00000000-0000-4000-8000-000000000008'), true);
});

test('Step-level O(delta) UPSERT, conversation undo tail truncation, and cross-process WAL sync keep zero file locks', (t) => {
  const sqliteMod =
    typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : null;
  if (!sqliteMod?.DatabaseSync) {
    t.skip('node:sqlite DatabaseSync unavailable');
    return;
  }
  const { DatabaseSync } = sqliteMod;
  const tmp = mkdtempSync(join(tmpdir(), 'agy-ledger-wal-'));
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const sqliteFile = join(tmp, 'trajectory_store.sqlite');
  const storeWriter = createTrajectoryCacheStore({ sqliteFilePath: sqliteFile, enableSqlite: true });
  const storeReader = createTrajectoryCacheStore({ sqliteFilePath: sqliteFile, enableSqlite: true });

  const cid = 'cccccccc-3333-4333-8333-333333333333';
  const s1 = makeRichStep(1, { inputTokens: 1_000 });
  const s2 = makeRichStep(2, { inputTokens: 2_000 });
  const s3 = makeRichStep(3, { inputTokens: 3_000 });
  storeWriter.setCachedTrajectory(cid, {
    title: 'Incremental Session',
    signature: 'sig-3',
    steps: [s1, s2, s3],
  });
  storeWriter.flushTrajectoryCacheNow();

  // Reader hydrates initial 3 steps
  assert.equal(storeReader.getCachedTrajectory(cid).steps.length, 3);

  // Append step #4: verify SQLite now has 4 rows and Reader picks up incremental write_seq update
  const s4 = makeRichStep(4, { inputTokens: 4_000 });
  storeWriter.setCachedTrajectory(cid, {
    title: 'Incremental Session',
    signature: 'sig-4',
    steps: [s1, s2, s3, s4],
  });
  storeWriter.flushTrajectoryCacheNow();

  storeReader.syncExternalChangesNow();
  assert.equal(storeReader.getCachedTrajectory(cid).steps.length, 4);
  assert.equal(storeReader.getCachedTrajectory(cid).steps[3].inputTokens, 4_000);

  // Simulate Undo in Antigravity: steps shrink from 4 back to 2 -> pos 2 & 3 MUST be deleted from SQLite!
  storeWriter.setCachedTrajectory(cid, {
    title: 'Incremental Session (Undone)',
    signature: 'sig-2',
    steps: [s1, s2],
  });
  storeWriter.flushTrajectoryCacheNow();

  const dbCheck = new DatabaseSync(sqliteFile, { readOnly: true });
  const stepRowCount = dbCheck
    .prepare('SELECT COUNT(*) AS cnt FROM steps WHERE cascade_id = ?')
    .get(cid).cnt;
  dbCheck.close();
  assert.equal(stepRowCount, 2, 'undone tail steps pos >= 2 truncated cleanly');

  storeReader.syncExternalChangesNow();
  assert.equal(storeReader.getCachedTrajectory(cid).steps.length, 2);

  // Simulate clearCache on Writer (with cid live -> cleared): Reader syncs epoch bump and removes cid!
  storeWriter.clearCache({ liveCascadeIds: [cid] });
  storeReader.syncExternalChangesNow();
  assert.equal(storeReader.getCachedTrajectory(cid), undefined);
});

test('Deleting source conversation in Antigravity + clicking Rebuild Cache permanently preserves deleted conversation tokens, costs, and details', async (t) => {
  const sqliteMod =
    typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sqlite') : null;
  if (!sqliteMod?.DatabaseSync) {
    t.skip('node:sqlite DatabaseSync unavailable');
    return;
  }
  const { DatabaseSync } = sqliteMod;
  const tmp = mkdtempSync(join(tmpdir(), 'agy-ledger-perm-'));
  t.after(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Ignore Windows WAL cleanup race
    }
  });

  const geminiDir = join(tmp, 'gemini');
  const agyDir = join(geminiDir, 'antigravity');
  const convDir = join(agyDir, 'conversations');
  const dataDir = join(tmp, 'panel-data');
  mkdirSync(convDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const cidDeleted = 'dddddddd-4444-4444-8444-444444444444';
  const cidLive = 'eeeeeeee-5555-4555-8555-555555555555';
  const baseSec = Math.floor(Date.parse('2026-11-18T00:00:00Z') / 1000);

  // Create conversation_summaries.db and both .db files
  const sumDbPath = join(agyDir, 'conversation_summaries.db');
  const sumDb = new DatabaseSync(sumDbPath);
  sumDb.exec(`
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
    CREATE TABLE conversation_parents (conversation_id TEXT, parent_id TEXT);
  `);
  const insSum = sumDb.prepare(
    "INSERT INTO conversation_summaries (conversation_id, title, status, parent_conversation_id, step_count, last_modified_time, app_data_dir, raw_summary) VALUES (?, ?, 'CASCADE_RUN_STATUS_IDLE', '', 2, '2026-11-18T00:01:00Z', 'antigravity', ?)"
  );
  insSum.run(cidDeleted, 'Deleted Precious Ledger Task', Buffer.alloc(0));
  insSum.run(cidLive, 'Surviving Live Task', Buffer.alloc(0));
  sumDb.close();

  const createConvSqlite = (cid, promptText, inTok, outTok) => {
    const p = join(convDir, `${cid}.db`);
    const db = new DatabaseSync(p);
    db.exec(`
      CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    `);
    db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, 1, 1)').run(cid, cid);
    db.prepare('INSERT INTO steps VALUES (0, 14, 3, ?, ?)').run(
      Buffer.concat([
        encodeFieldBytes(1, encodeTimestamp(baseSec + 1)),
        encodeFieldBytes(20, Buffer.concat([encodeFieldVarint(2, 0), encodeFieldBytes(4, cid)])),
      ]),
      encodeFieldBytes(19, encodeFieldBytes(2, promptText))
    );
    db.prepare('INSERT INTO steps VALUES (1, 15, 3, ?, ?)').run(
      encodeStepMeta({
        createdSec: baseSec + 10,
        finishedSec: baseSec + 15,
        stepIndex: 1,
        originCid: cid,
        inputTokens: inTok,
        outputTokens: outTok,
      }),
      encodeFieldBytes(20, encodeFieldBytes(1, 'Completed task'))
    );
    db.close();
    return p;
  };

  const deletedDbFile = createConvSqlite(cidDeleted, 'Keep my billing forever', 100_000, 10_000);
  const liveDbFile = createConvSqlite(cidLive, 'Still working on this', 50_000, 5_000);

  const apiUrl = new URL('../backend/api-actions.mjs', import.meta.url).href;
  const telUrl = new URL('../backend/telemetry-builder.mjs', import.meta.url).href;
  const cfgUrl = new URL('../backend/config.mjs', import.meta.url).href;

  const script = `
    import { unlinkSync } from 'node:fs';
    import { executeRebuildCacheAction } from ${JSON.stringify(apiUrl)};
    import { buildTelemetryPayloadInternal } from ${JSON.stringify(telUrl)};
    import { flushTrajectoryCacheNow, getCachedTrajectory, getHydratedTrajectory } from ${JSON.stringify(cfgUrl)};
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

    // 1. Initial scan records both conversations in trajectory_store.sqlite
    const before = await buildTelemetryPayloadInternal(${JSON.stringify(cidLive)}, { range: 'all' });
    flushTrajectoryCacheNow();
    const totalTokensBefore = before.consumption.account.totalTokens;

    // 2. Delete cidDeleted completely from Antigravity (.db + summary row), and add a step to cidLive!
    unlinkSync(${JSON.stringify(deletedDbFile)});
    const sdb = new DatabaseSync(${JSON.stringify(sumDbPath)});
    sdb.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?').run(${JSON.stringify(cidDeleted)});
    sdb.close();

    // 3. Click Rebuild Cache TWICE in a row!
    const r1 = executeRebuildCacheAction();
    const r2 = executeRebuildCacheAction();

    // 4. Rebuild telemetry & inspect both cidLive and deleted cidDeleted
    const afterLive = await buildTelemetryPayloadInternal(${JSON.stringify(cidLive)}, { range: 'all' });
    const afterDeleted = await buildTelemetryPayloadInternal(${JSON.stringify(cidDeleted)}, { range: 'all' });
    flushTrajectoryCacheNow();

    const cachedDeleted = getCachedTrajectory(${JSON.stringify(cidDeleted)});
    const hydratedDeleted = getHydratedTrajectory(${JSON.stringify(cidDeleted)});

    console.log(JSON.stringify({
      r1Ok: r1.ok,
      r2Ok: r2.ok,
      totalTokensBefore,
      totalTokensAfter: afterLive.consumption.account.totalTokens,
      deletedArchivedFlag: Boolean(cachedDeleted?.archived),
      deletedStepCount: hydratedDeleted?.steps?.length || 0,
      deletedTurnPrompt: hydratedDeleted?.steps?.[0]?.turnPrompt || '',
      deletedViewSteps: afterDeleted.activeConversation?.recentSteps?.length || 0,
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
  assert.equal(out.r1Ok, true);
  assert.equal(out.r2Ok, true);
  // 100k + 10k (cidDeleted) + 50k + 5k (cidLive) = 165,000 tokens -> 100% preserved after deleting cidDeleted + 2x Rebuild Cache!
  assert.equal(out.totalTokensBefore, 165_000);
  assert.equal(out.totalTokensAfter, 165_000, 'deleted conversation tokens & cost permanently preserved');
  assert.equal(out.deletedArchivedFlag, true, 'deleted conversation marked archived');
  assert.equal(out.deletedStepCount, 1);
  assert.equal(out.deletedTurnPrompt, 'Keep my billing forever', 'deleted conversation detail_json preserved');
  assert.equal(out.deletedViewSteps, 1, 'clicking archived deleted conversation still renders step details');
  assert.equal(existsSync(liveDbFile), true);
});

test('SQLite hardening: cold metadata vs peer append safety, mixed-case re-keying, corrupt DB quarantine + .bak recovery, and 64-session LRU', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-um-sqlite-hardening-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // 1. Default hot LRU comfortably holds 30 quick-stat sessions + active subagents without cyclic thrashing
  assert.equal(DEFAULT_HOT_SESSION_LRU_LIMIT, 64);

  const dbPath = join(dir, 'trajectory_store.sqlite');
  const jsonPath = join(dir, 'trajectory_usage_cache.json');
  const mixedUpperCid = 'ABCDEF99-1111-4222-8333-444455556666';
  const mixedLowerCid = mixedUpperCid.toLowerCase();
  const conflictCid = '11112222-3333-4444-8555-666677778888';

  // Seed initial DB via Store Writer
  const writer = createTrajectoryCacheStore({
    cacheFilePath: jsonPath,
    sqliteFilePath: dbPath,
    enableSqlite: true,
    loadJsonFn: loadJsonHelper,
  });
  writer.setCachedTrajectory(mixedUpperCid, {
    signature: 'v4:init',
    title: 'Mixed Case Session',
    steps: [makeRichStep(1, { turnPrompt: 'Mixed case prompt 1' })],
  });
  writer.setCachedTrajectory(conflictCid, {
    signature: 'v4:s2',
    title: 'Initial Title',
    steps: [
      makeRichStep(1, { turnPrompt: 'Step 1 intact' }),
      makeRichStep(2, { turnPrompt: 'Step 2 intact' }),
    ],
  });
  assert.equal(writer.flushTrajectoryCacheNow(), true);

  // Open Peer A (cold reader/writer) BEFORE Peer B appends Step #3
  const peerA = createTrajectoryCacheStore({
    cacheFilePath: jsonPath,
    sqliteFilePath: dbPath,
    enableSqlite: true,
    loadJsonFn: loadJsonHelper,
  });
  const coldConflict = peerA.getCachedTrajectory(conflictCid);
  assert.equal(coldConflict.steps.length, 2);
  assert.equal(peerA.isConversationCold(conflictCid), true);

  // Peer B appends Step #3 (with rich detail_json) to conflictCid and flushes first
  const peerB = createTrajectoryCacheStore({
    cacheFilePath: jsonPath,
    sqliteFilePath: dbPath,
    enableSqlite: true,
    loadJsonFn: loadJsonHelper,
  });
  const hydratedB = peerB.getHydratedTrajectory(conflictCid);
  peerB.setCachedTrajectory(conflictCid, {
    ...hydratedB,
    signature: 'v4:s3',
    steps: [...hydratedB.steps, makeRichStep(3, { turnPrompt: 'Step 3 from Peer B' })],
  });
  assert.equal(peerB.flushTrajectoryCacheNow(), true);

  // Peer A (still holding stale 2-step cold entry!) updates metadata & re-keys mixedUpperCid -> mixedLowerCid
  peerA.setCachedTrajectory(conflictCid, {
    ...coldConflict,
    workspaceUri: 'file:///workspace/project-a',
  });
  const coldMixed = peerA.getCachedTrajectory(mixedUpperCid);
  assert.equal(peerA.isConversationCold(mixedUpperCid), true);
  peerA.setCachedTrajectory(mixedLowerCid, { ...coldMixed, title: 'Normalized Lower Title' });
  assert.equal(peerA.flushTrajectoryCacheNow(), true);

  // Also test array-copied slim steps ([...coldEntry.steps]) losing array-level _isColdSlimSteps
  const peerC = createTrajectoryCacheStore({
    cacheFilePath: jsonPath,
    sqliteFilePath: dbPath,
    enableSqlite: true,
    loadJsonFn: loadJsonHelper,
  });
  const coldMixedC = peerC.getCachedTrajectory(mixedLowerCid);
  peerC.setCachedTrajectory(mixedLowerCid, {
    ...coldMixedC,
    steps: [...coldMixedC.steps],
  });
  assert.equal(peerC.flushTrajectoryCacheNow(), true);

  // Verify fresh reader sees ALL 3 steps + ALL detail_json on conflictCid AND preserved detail_json on mixedLowerCid!
  const verifier = createTrajectoryCacheStore({
    cacheFilePath: jsonPath,
    sqliteFilePath: dbPath,
    enableSqlite: true,
    loadJsonFn: loadJsonHelper,
  });
  const verifiedConflict = verifier.getHydratedTrajectory(conflictCid);
  assert.equal(verifiedConflict.steps.length, 3, 'Peer B step #3 was NOT truncated by Peer A cold metadata flush');
  assert.equal(verifiedConflict.steps[0].turnPrompt, 'Step 1 intact');
  assert.equal(verifiedConflict.steps[1].turnPrompt, 'Step 2 intact');
  assert.equal(verifiedConflict.steps[2].turnPrompt, 'Step 3 from Peer B');
  assert.equal(verifiedConflict.steps[2].contextBreakdown.totalTokens, 50_600);

  const verifiedMixed = verifier.getHydratedTrajectory(mixedLowerCid);
  assert.equal(verifiedMixed.title, 'Normalized Lower Title');
  assert.equal(verifiedMixed.steps.length, 1);
  assert.equal(verifiedMixed.steps[0].turnPrompt, 'Mixed case prompt 1', 'mixed-case re-keying + array-spread preserved detail_json');

  // 2. Corrupt SQLite file self-healing + automatic recovery from trajectory_usage_cache.json.bak
  const corruptDir = mkdtempSync(join(tmpdir(), 'ag-um-sqlite-corrupt-'));
  t.after(() => {
    rmSync(corruptDir, { recursive: true, force: true });
  });
  const corruptDbPath = join(corruptDir, 'trajectory_store.sqlite');
  const corruptJsonPath = join(corruptDir, 'trajectory_usage_cache.json');
  const bakCid = '99998888-7777-4666-8555-444433332222';
  writeFileSync(corruptDbPath, 'CORRUPT_HEADER_NOT_A_VALID_SQLITE_3_DATABASE_IMAGE', 'utf8');
  writeFileSync(
    `${corruptJsonPath}.bak`,
    JSON.stringify({
      [bakCid]: {
        signature: 'v4:bak',
        title: 'Recovered From Backup',
        steps: [makeRichStep(1, { turnPrompt: 'Backup survived corruption' })],
      },
    }),
    'utf8'
  );

  const healedStore = createTrajectoryCacheStore({
    cacheFilePath: corruptJsonPath,
    sqliteFilePath: corruptDbPath,
    enableSqlite: true,
    loadJsonFn: loadJsonHelper,
  });
  const recovered = healedStore.getHydratedTrajectory(bakCid);
  assert.ok(recovered, 'corrupt SQLite quarantined and recovered from .json.bak');
  assert.equal(recovered.title, 'Recovered From Backup');
  assert.equal(recovered.steps[0].turnPrompt, 'Backup survived corruption');
  const quarantinedFiles = readdirSync(corruptDir).filter((f) => f.includes('.corrupt.'));
  assert.equal(quarantinedFiles.length >= 1, true, 'corrupt DB preserved as .corrupt.<ts>');

  // 3. Transient startup load error does NOT latch loadedOnce permanently
  let failFirstLoad = true;
  const retryStore = createTrajectoryCacheStore({
    cacheFilePath: '/virtual/retry.json',
    enableSqlite: false,
    loadJsonFn: () => {
      if (failFirstLoad) {
        failFirstLoad = false;
        throw new Error('transient EBUSY');
      }
      return { [bakCid]: { signature: 'v4:ok', steps: [makeRichStep(1)] } };
    },
  });
  assert.throws(() => retryStore.getCachedTrajectory(bakCid), /transient EBUSY/);
  assert.equal(retryStore.getCachedTrajectory(bakCid)?.steps?.length, 1, 'second read succeeds cleanly');
});

test('Non-blocking progressive cache rebuild: foreground active session priority, macrotask responsiveness, chunked LRU bounds, on-demand historical load, and 100% final token accuracy', async (t) => {
  const sqliteMod = process.getBuiltinModule?.('node:sqlite');
  if (!sqliteMod?.DatabaseSync) {
    t.skip('node:sqlite unavailable');
    return;
  }
  const { DatabaseSync } = sqliteMod;

  // 1. Direct store verification: chunked flush of 30 sessions with hotSessionLimit=12 keeps hot RAM bounded and dirty queue = 0
  const lruDir = mkdtempSync(join(tmpdir(), 'ag-um-chunk-lru-'));
  t.after(() => {
    rmSync(lruDir, { recursive: true, force: true });
  });
  const boundedStore = createTrajectoryCacheStore({
    cacheFilePath: join(lruDir, 'trajectory_usage_cache.json'),
    sqliteFilePath: join(lruDir, 'trajectory_store.sqlite'),
    enableSqlite: true,
    hotSessionLimit: 12,
    loadJsonFn: loadJsonHelper,
  });
  for (let i = 1; i <= 30; i++) {
    const cid = `${String(i).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
    boundedStore.setCachedTrajectory(cid, {
      signature: `v4:chunk:${i}`,
      title: `Chunk Session ${i}`,
      steps: [makeRichStep(1, { turnPrompt: `Chunk prompt ${i}` })],
    });
    if (boundedStore.getDirtySessionCount() >= 10) {
      assert.equal(boundedStore.flushTrajectoryCacheNow(), true);
      assert.equal(boundedStore.getDirtySessionCount(), 0);
      assert.equal(
        boundedStore.getHotSessionCount() <= 12,
        true,
        'chunked flush evicts overflow cold sessions immediately instead of pinning all dirty sessions in RAM'
      );
    }
  }
  assert.equal(boundedStore.getHotSessionCount(), 12);
  // Cold session #1 still hydrates rich detail_json losslessly on demand
  const hydratedFirst = boundedStore.getHydratedTrajectory('00000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(hydratedFirst?.steps?.[0]?.turnPrompt, 'Chunk prompt 1');

  // 2. End-to-end progressive rebuild across 45 live .db sessions + 1 archived deleted session
  const root = mkdtempSync(join(tmpdir(), 'ag-um-progressive-rebuild-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const geminiDir = join(root, '.gemini');
  const agyDir = join(geminiDir, 'antigravity');
  const convDir = join(agyDir, 'conversations');
  const dataDir = join(root, 'plugin-data');
  mkdirSync(convDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const sumDbPath = join(agyDir, 'conversation_summaries.db');
  const sumDb = new DatabaseSync(sumDbPath);
  sumDb.exec(`
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
    CREATE TABLE conversation_parents (conversation_id TEXT, parent_id TEXT);
  `);
  const insSum = sumDb.prepare(
    "INSERT INTO conversation_summaries (conversation_id, title, status, parent_conversation_id, step_count, last_modified_time, app_data_dir, raw_summary) VALUES (?, ?, 'CASCADE_RUN_STATUS_IDLE', '', 2, ?, 'antigravity', ?)"
  );

  const baseSec = Math.floor(Date.parse('2026-11-22T00:00:00Z') / 1000);
  const createConvSqlite = (cid, createdOffsetSec, promptText, inTok, outTok) => {
    const p = join(convDir, `${cid}.db`);
    const db = new DatabaseSync(p);
    db.exec(`
      CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    `);
    db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, 1, 1)').run(cid, cid);
    db.prepare('INSERT INTO steps VALUES (0, 14, 3, ?, ?)').run(
      Buffer.concat([
        encodeFieldBytes(1, encodeTimestamp(baseSec + createdOffsetSec)),
        encodeFieldBytes(20, Buffer.concat([encodeFieldVarint(2, 0), encodeFieldBytes(4, cid)])),
      ]),
      encodeFieldBytes(19, encodeFieldBytes(2, promptText))
    );
    db.prepare('INSERT INTO steps VALUES (1, 15, 3, ?, ?)').run(
      encodeStepMeta({
        createdSec: baseSec + createdOffsetSec + 5,
        finishedSec: baseSec + createdOffsetSec + 9,
        stepIndex: 1,
        originCid: cid,
        inputTokens: inTok,
        outputTokens: outTok,
      }),
      encodeFieldBytes(20, encodeFieldBytes(1, `Response for ${promptText}`))
    );
    db.close();
    return p;
  };

  const liveCids = [];
  for (let i = 1; i <= 45; i++) {
    const cid = `${String(i).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
    liveCids.push(cid);
    const modIso = new Date((baseSec + (100 - i) * 60) * 1000).toISOString();
    insSum.run(cid, `Live Session #${i}`, modIso, Buffer.alloc(0));
    createConvSqlite(cid, (100 - i) * 60, `Prompt for live session #${i}`, 10_000, 1_000);
  }
  const cidActive = liveCids[0];
  const cidOldHistorical = liveCids[44]; // oldest session -> guaranteed deferred past foreground budget (16)

  const cidDeleted = 'ffffffff-9999-4999-8999-999999999999';
  insSum.run(cidDeleted, 'Archived Deleted Session', '2026-11-21T00:00:00Z', Buffer.alloc(0));
  const deletedDbPath = createConvSqlite(cidDeleted, -3600, 'Archived prompt forever', 50_000, 5_000);
  sumDb.close();

  const apiUrl = new URL('../backend/api-actions.mjs', import.meta.url).href;
  const scannerUrl = new URL('../backend/local-scanner.mjs', import.meta.url).href;
  const cfgUrl = new URL('../backend/config.mjs', import.meta.url).href;
  const epUrl = new URL('../backend/endpoint-registry.mjs', import.meta.url).href;

  const script = `
    import { unlinkSync } from 'node:fs';
    import {
      executeRebuildCacheAction,
      executeSettingsAction,
      executeTelemetryAction,
    } from ${JSON.stringify(apiUrl)};
    import {
      getLocalCacheRebuildStatus,
      isLocalBackgroundRebuildActive,
      stopLocalBackgroundCacheRebuild,
    } from ${JSON.stringify(scannerUrl)};
    import { flushTrajectoryCacheNow } from ${JSON.stringify(cfgUrl)};
    import { getEndpointCacheStore } from ${JSON.stringify(epUrl)};
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

    const waitForDrainIdle = async (timeoutMs = 8000) => {
      const deadline = Date.now() + timeoutMs;
      while (isLocalBackgroundRebuildActive() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    // Initial full warm-up so all 46 sessions (45 live + 1 deleted-to-be) are stored in SQLite ledger
    await executeTelemetryAction({ conversationId: ${JSON.stringify(cidActive)}, force: true });
    await waitForDrainIdle();
    const initialFull = JSON.parse(
      (await executeTelemetryAction({ conversationId: ${JSON.stringify(cidActive)} })).body
    );
    flushTrajectoryCacheNow();
    const initialTotalTokens = initialFull.consumption.account.totalTokens;

    // Delete cidDeleted from Antigravity (.db + summary row) so it becomes archived
    unlinkSync(${JSON.stringify(deletedDbPath)});
    const sdb = new DatabaseSync(${JSON.stringify(sumDbPath)});
    sdb.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?').run(${JSON.stringify(cidDeleted)});
    sdb.close();

    // Monitor event-loop responsiveness while rebuild + foreground + background drain execute
    let heartbeatTicks = 0;
    let maxLoopGapMs = 0;
    let lastBeatMs = Date.now();
    const heartbeat = setInterval(() => {
      const now = Date.now();
      heartbeatTicks += 1;
      maxLoopGapMs = Math.max(maxLoopGapMs, now - lastBeatMs);
      lastBeatMs = now;
    }, 5);

    const tClear0 = Date.now();
    const rebuildRes1 = executeRebuildCacheAction();
    const clearElapsedMs = Date.now() - tClear0;
    const rebuildBody1 = JSON.parse(rebuildRes1.body);

    // Foreground poll for active session returns BEFORE all 45 sessions are rebuilt!
    const fgRes = JSON.parse(
      (await executeTelemetryAction({ conversationId: ${JSON.stringify(cidActive)}, force: true })).body
    );
    const fgRebuildStatus = fgRes.cacheRebuild;

    // Double-rebuild mid-drain cancels stale generation cleanly and restarts progressive rebuild
    const rebuildRes2 = executeRebuildCacheAction();
    const fgResAfterCancel = JSON.parse(
      (await executeTelemetryAction({ conversationId: ${JSON.stringify(cidActive)}, force: true })).body
    );

    // Concurrent API requests while background drain is active: settings + on-demand deferred historical conversation
    const [settingsDuringDrain, oldConvDuringDrain] = await Promise.all([
      Promise.resolve(executeSettingsAction(undefined)),
      executeTelemetryAction({
        scope: 'conversation',
        conversationId: ${JSON.stringify(cidOldHistorical)},
      }),
    ]);
    const oldConvPayload = JSON.parse(oldConvDuringDrain.body);

    await waitForDrainIdle();
    clearInterval(heartbeat);

    const finalPayload = JSON.parse(
      (await executeTelemetryAction({ conversationId: ${JSON.stringify(cidActive)} })).body
    );
    const hotCountAfter = getEndpointCacheStore(null).getHotSessionCount();
    await stopLocalBackgroundCacheRebuild();

    console.log(JSON.stringify({
      initialTotalTokens,
      rebuild1Ok: rebuildRes1.ok,
      rebuild2Ok: rebuildRes2.ok,
      clearElapsedMs,
      hintedTotal: rebuildBody1.totalLive || 0,
      fgActiveCid: fgRes.activeConversation?.cascadeId,
      fgActiveStepCount: fgRes.activeConversation?.recentSteps?.length || 0,
      fgRebuildActive: Boolean(fgRebuildStatus?.active),
      fgCompleted: fgRebuildStatus?.completed || 0,
      fgTotal: fgRebuildStatus?.total || 0,
      fgRemaining: fgRebuildStatus?.remaining || 0,
      fgAfterCancelActive: Boolean(fgResAfterCancel.cacheRebuild?.active),
      settingsStatusDuringDrain: settingsDuringDrain.status,
      oldConvCid: oldConvPayload.activeConversation?.cascadeId,
      oldConvStepCount: oldConvPayload.activeConversation?.recentSteps?.length || 0,
      oldConvTurnPrompt: oldConvPayload.activeConversation?.recentSteps?.[0]?.turnPrompt || '',
      heartbeatTicks,
      maxLoopGapMs,
      finalRebuildStatus: getLocalCacheRebuildStatus(),
      finalTotalTokens: finalPayload.consumption?.account?.totalTokens || 0,
      hotCountAfter,
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
  // 45 * (10k + 1k) + (50k + 5k) = 495,000 + 55,000 = 550,000
  assert.equal(out.initialTotalTokens, 550_000);
  assert.equal(out.rebuild1Ok, true);
  assert.equal(out.rebuild2Ok, true);
  assert.equal(out.clearElapsedMs < 1000, true, 'synchronous cache clear stays fast');
  assert.equal(out.hintedTotal, 45);
  assert.equal(out.fgActiveCid, cidActive);
  assert.equal(out.fgActiveStepCount, 1, 'foreground active conversation steps ready immediately');
  assert.equal(out.fgRebuildActive, true, 'background progressive drain scheduled for remaining historical sessions');
  assert.equal(out.fgCompleted > 0 && out.fgCompleted < out.fgTotal, true);
  assert.equal(out.fgRemaining > 0, true);
  assert.equal(out.fgAfterCancelActive, true, 're-triggering rebuild cleanly cancels prior generation and starts new drain');
  assert.equal(out.settingsStatusDuringDrain, 200, 'settings endpoint responds immediately during rebuild');
  assert.equal(out.oldConvCid, cidOldHistorical);
  assert.equal(out.oldConvStepCount, 1, 'clicking an undrained historical session loads its steps immediately on demand');
  assert.match(out.oldConvTurnPrompt, /Prompt for live session #45/);
  assert.equal(out.heartbeatTicks > 0, true, 'event loop timer macrotasks kept firing throughout progressive rebuild');
  assert.equal(out.finalRebuildStatus.active, false);
  assert.equal(out.finalRebuildStatus.remaining, 0);
  assert.equal(out.finalRebuildStatus.completed, out.finalRebuildStatus.total);
  assert.equal(out.finalTotalTokens, 550_000, 'all 45 live sessions + 1 archived deleted session accurately aggregated after drain');
  assert.equal(out.hotCountAfter <= DEFAULT_HOT_SESSION_LRU_LIMIT, true, 'hot LRU stays strictly within 64-session cap');
});

test('SettingsOtherTab renders live progressive cacheRebuild status, supports locale hot-switching, and auto-recovers on background completion', async (t) => {
  const { createMockDom } = await import('./mock-dom.mjs');
  const { document } = createMockDom();

  const origDocument = globalThis.document;
  const origWindow = globalThis.window;
  const origFetch = globalThis.fetch;
  const mockFetch = async (url) => {
    const u = String(url || '');
    if (u.includes('/api/cache/rebuild')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({
          ok: true,
          cacheRebuild: { active: false, completed: 0, total: 48, remaining: 48 },
        }),
        text: async () =>
          JSON.stringify({
            ok: true,
            cacheRebuild: { active: false, completed: 0, total: 48, remaining: 48 },
          }),
      };
    }
    const telemetryBody = {
      generatedAt: new Date().toISOString(),
      account: { status: 'connected', name: 'tester@example.com' },
      cacheRebuild: { active: true, completed: 17, total: 48, remaining: 31, updatedAtMs: 1000 },
      settings: { language: 'zh-CN' },
      quotaPools: [],
      conversations: [],
      activeConversation: { cascadeId: '', recentSteps: [], agents: [] },
      consumption: { range: 'all', account: { totalTokens: 0 }, daily: [] },
    };
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => telemetryBody,
      text: async () => JSON.stringify(telemetryBody),
    };
  };
  globalThis.document = document;
  globalThis.window = {
    location: { origin: 'http://127.0.0.1:41234', href: 'http://127.0.0.1:41234/' },
    addEventListener() {},
    removeEventListener() {},
    fetch: mockFetch,
  };
  globalThis.fetch = mockFetch;

  const [{ setI18nLanguage }, { stopAsyncTelemetryLoop }, { SettingsOtherTab }] = await Promise.all([
    import('../src/i18n/index.js'),
    import('../src/store/telemetryStore.js'),
    import('../src/views/settings/SettingsOtherTab.js'),
  ]);
  setI18nLanguage('zh-CN');
  const tab = SettingsOtherTab({ onLayoutChange: () => {} });

  t.after(() => {
    stopAsyncTelemetryLoop();
    tab.destroy();
    setI18nLanguage('zh-CN');
    globalThis.document = origDocument;
    globalThis.window = origWindow;
    globalThis.fetch = origFetch;
  });

  const baseSettings = { language: 'zh-CN', modelDisplayMode: 'short' };
  tab.refs.renderSettings(baseSettings, [], null, 'win32', null, {
    active: false,
    completed: 0,
    total: 0,
    remaining: 0,
  });

  const rebuildBtn = tab.refs.rebuildCacheBtn;
  const getMaintStatusText = () => {
    const statuses = tab.el.querySelectorAll('.settings-panel-status');
    return statuses[statuses.length - 1]?.textContent || '';
  };

  assert.equal(rebuildBtn.hasAttribute('disabled'), false);
  assert.match(rebuildBtn.textContent, /重建本地轨迹缓存/);

  // Click Rebuild -> foreground poll returns active progressive rebuild (17/48) after 220ms force-sync feedback minimum
  rebuildBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
  await new Promise((r) => setTimeout(r, 260));

  assert.equal(rebuildBtn.hasAttribute('disabled'), true, 'button stays disabled while background drain is active');
  assert.match(rebuildBtn.textContent, /重建中 \(17\/48\)…/);
  assert.equal(getMaintStatusText(), '重建中 (17/48)…');

  // Hot-switch language to en-US during active rebuild
  setI18nLanguage('en-US');
  tab.refs.refreshLabels();
  assert.equal(rebuildBtn.hasAttribute('disabled'), true);
  assert.match(rebuildBtn.textContent, /Rebuilding \(17\/48\)…/);
  assert.equal(getMaintStatusText(), 'Rebuilding (17/48)…');

  // Next poll advances background rebuild progress (33/48)
  tab.refs.renderSettings({ ...baseSettings, language: 'en-US' }, [], null, 'win32', null, {
    active: true,
    completed: 33,
    total: 48,
    remaining: 15,
    updatedAtMs: 2000,
  });
  assert.match(rebuildBtn.textContent, /Rebuilding \(33\/48\)…/);
  assert.equal(getMaintStatusText(), 'Rebuilding (33/48)…');

  // Switch back to zh-CN and deliver background drain completion -> auto re-enable + completion toast
  setI18nLanguage('zh-CN');
  tab.refs.refreshLabels();
  tab.refs.renderSettings(baseSettings, [], null, 'win32', null, {
    active: false,
    completed: 48,
    total: 48,
    remaining: 0,
    updatedAtMs: 3000,
  });
  assert.equal(rebuildBtn.hasAttribute('disabled'), false, 'button re-enabled automatically once background rebuild finishes');
  assert.match(rebuildBtn.textContent, /重建本地轨迹缓存/);
  assert.equal(getMaintStatusText(), '本地轨迹缓存已重建');
});

test('Progressive sync & rebuild hardening: silent modified-session drain, mid-rebuild swarm subagents, depth-2 root promotion, generation isolation, standalone stop, peer-archive truncate safety, and view-cache clear', async (t) => {
  const sqliteMod = process.getBuiltinModule?.('node:sqlite');
  if (!sqliteMod?.DatabaseSync) {
    t.skip('node:sqlite unavailable');
    return;
  }
  const { DatabaseSync } = sqliteMod;

  // 1. Peer-archive truncateAll safety: if another process archived a session while local store had empty memory,
  // SQLite truncateAll never wipes is_archived = 1 rows.
  const peerDir = mkdtempSync(join(tmpdir(), 'ag-um-peer-trunc-'));
  t.after(() => {
    rmSync(peerDir, { recursive: true, force: true });
  });
  const peerSqlPath = join(peerDir, 'trajectory_store.sqlite');
  const storeA = createTrajectoryCacheStore({
    cacheFilePath: join(peerDir, 'cache.json'),
    sqliteFilePath: peerSqlPath,
    enableSqlite: true,
    loadJsonFn: loadJsonHelper,
  });
  // Warm storeA empty so loadedOnce = true with 0 entries
  assert.equal(storeA.listCachedTrajectoryEntries().length, 0);

  // Simulate peer process writing an archived row directly into SQLite while syncExternalChangesIfNeeded is bypassed
  const peerDb = new DatabaseSync(peerSqlPath);
  peerDb
    .prepare(
      'INSERT INTO conversations (cascade_id, lower_id, is_archived, step_count, write_seq, updated_at_ms, meta_json) VALUES (?, ?, 1, 1, 99, ?, ?)'
    )
    .run(
      'deadbeef-0000-4000-8000-000000000001',
      'deadbeef-0000-4000-8000-000000000001',
      Date.now(),
      JSON.stringify({ signature: 'v4:archived', title: 'Peer Archived', archived: true })
    );
  peerDb
    .prepare(
      'INSERT INTO steps (cascade_id, pos, accounting_json, detail_json) VALUES (?, 0, ?, ?)'
    )
    .run(
      'deadbeef-0000-4000-8000-000000000001',
      JSON.stringify([1, 0, 'MODEL_PLACEHOLDER_M429', 'gemini-4-carbon-high', 'Gemini 4 Carbon (High)', 'API_PROVIDER_GOOGLE_GEMINI', 1700000000000, 5000, 0, 500, 100, 400, 6.0]),
      JSON.stringify({ turnPrompt: 'Preserved forever' })
    );
  peerDb.close();

  // Even if flushDeltaBatch is invoked with truncateAll: true directly on a fresh ledger handle, is_archived = 1 survives!
  const verifyDbBefore = new DatabaseSync(peerSqlPath);
  verifyDbBefore.close();
  storeA.clearCache({ liveCascadeIds: new Set() });
  const verifyDbAfter = new DatabaseSync(peerSqlPath);
  const survivedRow = verifyDbAfter
    .prepare('SELECT cascade_id, is_archived FROM conversations WHERE lower_id = ?')
    .get('deadbeef-0000-4000-8000-000000000001');
  const survivedStepCount = verifyDbAfter
    .prepare('SELECT COUNT(*) AS cnt FROM steps WHERE cascade_id = ?')
    .get('deadbeef-0000-4000-8000-000000000001')?.cnt;
  verifyDbAfter.close();
  assert.equal(survivedRow?.is_archived, 1, 'archived conversation survives clearCache / truncateAll');
  assert.equal(survivedStepCount, 1, 'archived conversation steps survive clearCache / truncateAll');

  // 2. End-to-end backend hardening across modified .db sessions, mid-rebuild swarm subagents,
  // depth-2 nested subagent root promotion, pre-rebuild generation isolation, and standalone-server stop()
  const root = mkdtempSync(join(tmpdir(), 'ag-um-rebuild-hardening-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const geminiDir = join(root, '.gemini');
  const agyDir = join(geminiDir, 'antigravity');
  const convDir = join(agyDir, 'conversations');
  const brainDir = join(agyDir, 'brain');
  const dataDir = join(root, 'plugin-data');
  mkdirSync(convDir, { recursive: true });
  mkdirSync(brainDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const sumDbPath = join(agyDir, 'conversation_summaries.db');
  const sumDb = new DatabaseSync(sumDbPath);
  sumDb.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT, preview TEXT, status TEXT, source TEXT,
      parent_conversation_id TEXT, nesting_depth INTEGER, agent_name TEXT,
      not_fully_idle INTEGER, killed INTEGER, step_count INTEGER,
      last_modified_time TEXT, app_data_dir TEXT, raw_summary BLOB
    );
    CREATE TABLE conversation_parents (conversation_id TEXT, parent_id TEXT);
  `);
  const insSum = sumDb.prepare(
    "INSERT INTO conversation_summaries (conversation_id, title, status, parent_conversation_id, step_count, last_modified_time, app_data_dir, raw_summary) VALUES (?, ?, 'CASCADE_RUN_STATUS_IDLE', ?, 2, ?, 'antigravity', ?)"
  );

  const baseSec = Math.floor(Date.parse('2026-11-24T00:00:00Z') / 1000);
  const createConvSqlite = (cid, createdOffsetSec, promptText, inTok) => {
    const p = join(convDir, `${cid}.db`);
    const db = new DatabaseSync(p);
    db.exec(`
      CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    `);
    db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, 1, 1)').run(cid, cid);
    db.prepare('INSERT INTO steps VALUES (0, 14, 3, ?, ?)').run(
      Buffer.concat([
        encodeFieldBytes(1, encodeTimestamp(baseSec + createdOffsetSec)),
        encodeFieldBytes(20, Buffer.concat([encodeFieldVarint(2, 0), encodeFieldBytes(4, cid)])),
      ]),
      encodeFieldBytes(19, encodeFieldBytes(2, promptText))
    );
    db.prepare('INSERT INTO steps VALUES (1, 15, 3, ?, ?)').run(
      encodeStepMeta({
        createdSec: baseSec + createdOffsetSec + 2,
        finishedSec: baseSec + createdOffsetSec + 5,
        stepIndex: 1,
        originCid: cid,
        inputTokens: inTok,
        outputTokens: 0,
      }),
      encodeFieldBytes(20, encodeFieldBytes(1, `Reply for ${promptText}`))
    );
    db.close();
    return p;
  };

  const cids = [];
  const dbPaths = [];
  for (let i = 1; i <= 50; i++) {
    const cid = `${String(i).padStart(8, '0')}-7777-4777-8777-777777777777`;
    cids.push(cid);
    const modIso = new Date((baseSec + (200 - i) * 60) * 1000).toISOString();
    insSum.run(cid, `Session #${i}`, '', modIso, Buffer.alloc(0));
    dbPaths.push(createConvSqlite(cid, i * 60, `Prompt #${i}`, 1_000));
  }
  // Swarm parent at index 35 (deferred past foreground budget & title loop 30) + 2 swarm workers
  const swarmParentCid = cids[35];
  const swarmSubA = 'aaaa0001-7777-4777-8777-777777777777';
  const swarmSubB = 'aaaa0002-7777-4777-8777-777777777777';
  createConvSqlite(swarmSubA, 500, 'Swarm worker A', 20_000);
  createConvSqlite(swarmSubB, 520, 'Swarm worker B', 30_000);
  const swarmDir = join(brainDir, swarmParentCid, '.system_generated', 'swarm');
  mkdirSync(swarmDir, { recursive: true });
  writeFileSync(
    join(swarmDir, 'members.json'),
    JSON.stringify({
      title: 'Test Swarm',
      members: {
        'worker-a': { name: 'worker-a', conversation_id: swarmSubA, role: 'worker', wake_mode: 'mentions' },
        'worker-b': { name: 'worker-b', conversation_id: swarmSubB, role: 'worker', wake_mode: 'mentions' },
      },
    })
  );

  // Depth-2 nested subagent chain (Root -> Sub1 -> Sub2, old timestamps so Root & Sub1 are deferred)
  const deepRoot = '99990000-7777-4777-8777-777777777777';
  const deepSub1 = '99990001-7777-4777-8777-777777777777';
  const deepSub2 = '99990002-7777-4777-8777-777777777777';
  insSum.run(deepRoot, 'Deep Root', '', new Date((baseSec + 5) * 1000).toISOString(), Buffer.alloc(0));
  insSum.run(deepSub1, 'Deep Sub1', deepRoot, new Date((baseSec + 10) * 1000).toISOString(), Buffer.alloc(0));
  insSum.run(deepSub2, 'Deep Sub2', deepSub1, new Date((baseSec + 15) * 1000).toISOString(), Buffer.alloc(0));
  createConvSqlite(deepRoot, 5, 'Deep root prompt', 8_000);
  createConvSqlite(deepSub1, 10, 'Deep sub1 prompt', 4_000);
  createConvSqlite(deepSub2, 15, 'Deep sub2 prompt', 2_000);
  sumDb.close();

  const step2TplB64 = encodeStepMeta({
    createdSec: baseSec + 99_999,
    finishedSec: baseSec + 100_002,
    stepIndex: 2,
    originCid: '00000010-7777-4777-8777-777777777777',
    inputTokens: 2_000,
    outputTokens: 0,
  }).toString('base64');

  const apiUrl = new URL('../backend/api-actions.mjs', import.meta.url).href;
  const scannerUrl = new URL('../backend/local-scanner.mjs', import.meta.url).href;
  const epUrl = new URL('../backend/endpoint-registry.mjs', import.meta.url).href;
  const standaloneUrl = new URL('../backend/standalone-server.mjs', import.meta.url).href;

  const childScript = `
    import { utimesSync } from 'node:fs';
    import { executeRebuildCacheAction, executeTelemetryAction } from ${JSON.stringify(apiUrl)};
    import {
      isLocalBackgroundRebuildActive,
      stopLocalBackgroundCacheRebuild,
    } from ${JSON.stringify(scannerUrl)};
    import { getEndpointCacheStore } from ${JSON.stringify(epUrl)};
    import { createStandaloneWebServer } from ${JSON.stringify(standaloneUrl)};
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

    const cids = ${JSON.stringify(cids)};
    const dbPaths = ${JSON.stringify(dbPaths)};
    const swarmParentCid = ${JSON.stringify(swarmParentCid)};
    const swarmSubB = ${JSON.stringify(swarmSubB)};
    const deepRoot = ${JSON.stringify(deepRoot)};
    const deepSub2 = ${JSON.stringify(deepSub2)};
    const store = getEndpointCacheStore(null);

    const waitDrain = async () => {
      const dl = Date.now() + 8000;
      while (isLocalBackgroundRebuildActive() && Date.now() < dl) {
        await new Promise((r) => setTimeout(r, 5));
      }
    };

    // Warm up all sessions
    await executeTelemetryAction({ conversationId: cids[0], force: true });
    await waitDrain();

    // (A) Modify 30 non-active .db files without clicking Rebuild Cache:
    // Drain updates all 30 modified sessions silently while cacheRebuild.active stays false!
    const tplBin = Buffer.from(${JSON.stringify(step2TplB64)}, 'base64').toString('binary');
    for (let i = 10; i < 40; i++) {
      const db = new DatabaseSync(dbPaths[i]);
      db.prepare('INSERT INTO steps VALUES (2, 15, 3, ?, ?)').run(
        Buffer.from(tplBin.replace('00000010-7777-4777-8777-777777777777', cids[i]), 'binary'),
        Buffer.from([0xa2, 0x01, 0x04, 0x0a, 0x02, 0x6f, 0x6b])
      );
      db.close();
      const fut = Math.floor(Date.now() / 1000) + 60;
      utimesSync(dbPaths[i], fut, fut);
    }
    const silentPoll1 = JSON.parse((await executeTelemetryAction({ conversationId: cids[0] })).body);
    const silentPollActive = Boolean(silentPoll1.cacheRebuild?.active);
    await waitDrain();
    let modifiedUpdatedCount = 0;
    for (let i = 10; i < 40; i++) {
      if ((store.getCachedTrajectory(cids[i])?.steps?.length || 0) === 2) modifiedUpdatedCount += 1;
    }

    // (B) Mid-rebuild click on deferred Swarm parent after its batch drains -> preserves 2 subagents!
    executeRebuildCacheAction();
    await executeTelemetryAction({ conversationId: cids[0], force: true });
    const dl = Date.now() + 5000;
    while ((!store.getCachedTrajectory(swarmParentCid) || !store.getCachedTrajectory(swarmSubB)) && Date.now() < dl) {
      await new Promise((r) => setTimeout(r, 2));
    }
    const midSwarmConv = JSON.parse(
      (await executeTelemetryAction({ scope: 'conversation', conversationId: swarmParentCid })).body
    );
    await waitDrain();

    // (C) Depth-2 nested subagent request right after Rebuild Cache -> promotes Deep Root immediately!
    executeRebuildCacheAction();
    const depth2Payload = JSON.parse(
      (await executeTelemetryAction({ conversationId: deepSub2, force: true })).body
    );
    await stopLocalBackgroundCacheRebuild();

    // (D) Pre-rebuild in-flight poll interrupted by executeRebuildCacheAction() writes 0 stale entries!
    executeRebuildCacheAction();
    const preRebuildScan = executeTelemetryAction({ conversationId: cids[0], force: false });
    await new Promise((r) => setImmediate(r));
    executeRebuildCacheAction();
    await preRebuildScan;
    const stalePollutedEntries = store.listCachedTrajectoryEntries().length;
    await stopLocalBackgroundCacheRebuild();

    // (E) standalone-server stop() cleanly stops active background rebuild!
    const srv = createStandaloneWebServer({ host: '127.0.0.1', port: 0 });
    await srv.start();
    executeRebuildCacheAction();
    await executeTelemetryAction({ conversationId: cids[0], force: true });
    const activeBeforeStop = isLocalBackgroundRebuildActive();
    await srv.stop();
    const activeAfterStop = isLocalBackgroundRebuildActive();

    console.log(JSON.stringify({
      silentPollActive,
      modifiedUpdatedCount,
      midSwarmSubCount: midSwarmConv.activeConversation?.subagentCount || 0,
      midSwarmAggTokens: midSwarmConv.activeConversation?.aggregated?.totalTokens || 0,
      depth2RootCid: depth2Payload.activeConversation?.cascadeId,
      depth2RootSteps: depth2Payload.activeConversation?.recentSteps?.length || 0,
      depth2AggTokens: depth2Payload.activeConversation?.aggregated?.totalTokens || 0,
      stalePollutedEntries,
      activeBeforeStop,
      activeAfterStop,
    }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', childScript], {
    env: {
      ...process.env,
      ANTIGRAVITY_GEMINI_DIR: geminiDir,
      ANTIGRAVITY_APP_DATA_DIR: '',
      USAGE_MONITOR_APP_DATA_DIR: '',
      ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
      ANTIGRAVITY_LS_ADDRESS: 'test.invalid',
    },
  });
  const res = JSON.parse(stdout.trim().split('\n').pop());
  assert.equal(res.silentPollActive, false, 'normal modified-session sync never hijacks cacheRebuild.active UI');
  assert.equal(res.modifiedUpdatedCount, 30, 'all 30 modified sessions refreshed by background drain');
  assert.equal(res.midSwarmSubCount, 2, 'mid-rebuild scope=conversation preserves swarm subagents');
  assert.equal(res.midSwarmAggTokens >= 51_000, true, 'mid-rebuild swarm family tokens preserved');
  assert.equal(res.depth2RootCid, deepRoot);
  assert.equal(res.depth2RootSteps, 1, 'depth-2 subagent request promotes root conversation steps immediately');
  assert.equal(res.depth2AggTokens, 14_000, 'depth-2 family tokens complete immediately');
  assert.equal(res.stalePollutedEntries, 0, 'pre-rebuild in-flight scan never pollutes freshly cleared cache');
  assert.equal(res.activeBeforeStop, true);
  assert.equal(res.activeAfterStop, false, 'standalone-server stop() cancels background rebuild cleanly');

  // 3. Frontend telemetryStore clears conversationViewCache on rebuild completion (active: true -> false)
  const { createMockDom } = await import('./mock-dom.mjs');
  const { document } = createMockDom();
  const origDoc = globalThis.document;
  const origWin = globalThis.window;
  const origFetch = globalThis.fetch;
  let mockPhase = 'rebuilding';
  const mockFetch = async (url) => {
    const u = String(url || '');
    const wrap = (b) => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => b,
      text: async () => JSON.stringify(b),
    });
    if (u.includes('scope=conversation')) {
      const subCnt = mockPhase === 'rebuilding' ? 0 : 2;
      return wrap({
        scope: 'conversation',
        activeCascadeId: swarmParentCid,
        needsBackgroundSync: false,
        activeConversation: {
          cascadeId: swarmParentCid,
          stepCount: 1,
          subagentCount: subCnt,
          totalTokens: 1000,
          recentSteps: [{ stepIndex: 1, totalTokens: 1000 }],
          agents: subCnt ? [{ cascadeId: swarmSubA }, { cascadeId: swarmSubB }] : [],
          aggregated: { totalTokens: subCnt ? 51000 : 1000, stepCount: 1 + subCnt },
        },
        quotas: { activePool: null, weekly: null },
        consumption: { session: { totalTokens: 1000 }, sessionPresets: {} },
      });
    }
    const reb = mockPhase === 'rebuilding';
    return wrap({
      timestamp: new Date().toISOString(),
      endpoint: { id: 'local', isRemote: false },
      account: { status: 'signedIn', email: 'test@example.com' },
      settings: { language: 'zh-CN' },
      cacheRebuild: { active: reb, completed: reb ? 17 : 50, total: 50, remaining: reb ? 33 : 0 },
      conversations: [{ cascadeId: cids[0], title: 'Active' }, { cascadeId: swarmParentCid, title: 'Swarm' }],
      activeConversation: {
        cascadeId: cids[0],
        stepCount: 1,
        subagentCount: 0,
        totalTokens: 1000,
        recentSteps: [{ stepIndex: 1, totalTokens: 1000 }],
        agents: [],
        aggregated: { totalTokens: 1000, stepCount: 1 },
      },
      consumption: {
        revision: reb ? 1 : 2,
        selectedRange: { key: 'today', label: '今日', startMs: 1, endMs: 2 },
        session: { totalTokens: 1000 },
        account: { totalTokens: reb ? 17000 : 50000 },
        presets: {},
        trendSeries: [],
        sourcesBreakdown: [],
        topConversations: [],
        topWorkspaces: [],
        monthlySeries: [],
      },
      quotas: { pools: [] },
      modelBreakdown: [],
    });
  };
  globalThis.document = document;
  globalThis.window = {
    location: { origin: 'http://127.0.0.1:41234', href: 'http://127.0.0.1:41234/' },
    addEventListener() {},
    removeEventListener() {},
    fetch: mockFetch,
  };
  globalThis.fetch = mockFetch;
  t.after(() => {
    globalThis.document = origDoc;
    globalThis.window = origWin;
    globalThis.fetch = origFetch;
  });

  const { fetchTelemetry, selectConversation, telemetryStore, stopAsyncTelemetryLoop } =
    await import('../src/store/telemetryStore.js');
  await fetchTelemetry({ force: false });
  await selectConversation(swarmParentCid);
  await selectConversation(cids[0]);
  mockPhase = 'done';
  await fetchTelemetry({ force: false });

  let firstFrameSubCount = null;
  const unsub = telemetryStore.subscribe(
    (st) => st,
    (st) => {
      if (
        firstFrameSubCount === null &&
        st.selectedConversationId === swarmParentCid &&
        st.telemetry?.activeConversation?.cascadeId === swarmParentCid
      ) {
        firstFrameSubCount = st.telemetry.activeConversation.subagentCount;
      }
    }
  );
  await selectConversation(swarmParentCid);
  unsub();
  stopAsyncTelemetryLoop();
  assert.equal(
    firstFrameSubCount,
    2,
    'conversationViewCache cleared on rebuild completion so stale 0-subagent slice is never rendered'
  );
});

test('SQLite ledger compacts step signatures to 64-bit hashes, releases signatures on cold LRU eviction, and detects single-step edits', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-um-sqlite-sig-opt-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const dbPath = join(dir, 'trajectory_store.sqlite');
  const store = createTrajectoryCacheStore({
    sqliteFilePath: dbPath,
    enableSqlite: true,
    hotSessionLimit: 2,
  });

  const ids = [
    'aaaa1111-1111-4111-8111-111111111111',
    'bbbb2222-2222-4222-8222-222222222222',
    'cccc3333-3333-4333-8333-333333333333',
  ];
  for (const id of ids) {
    store.setCachedTrajectory(id, {
      signature: 'v4:init',
      title: `Session ${id.slice(0, 4)}`,
      steps: [
        makeRichStep(1, { turnPrompt: `Prompt A for ${id}` }),
        makeRichStep(2, { turnPrompt: `Prompt B for ${id}`, inputTokens: 1200 }),
      ],
    });
  }
  assert.equal(store.flushTrajectoryCacheNow(), true);
  // With hotSessionLimit = 2, the oldest session is dehydrated to cold immediately after flush
  assert.equal(store.getHotSessionCount(), 2);
  assert.equal(store.isConversationCold(ids[0]), true);

  // Re-hydrate the evicted session, mutate a detail field on step 2, and flush again
  const hydrated = store.getHydratedTrajectory(ids[0]);
  assert.equal(store.isConversationCold(ids[0]), false);
  assert.equal(hydrated.steps[0].turnPrompt, `Prompt A for ${ids[0]}`);
  const updatedSteps = hydrated.steps.map((s, i) =>
    i === 1 ? { ...s, turnPrompt: 'Updated detail prompt after cold reload', inputTokens: 1550 } : s
  );
  store.setCachedTrajectory(ids[0], { ...hydrated, signature: 'v4:mut', steps: updatedSteps });
  assert.equal(store.flushTrajectoryCacheNow(), true);

  // Fresh reader from disk sees exact updated step 2 and intact step 1 via .iterate() cold hydrate + detail load
  const reader = createTrajectoryCacheStore({
    sqliteFilePath: dbPath,
    enableSqlite: true,
    hotSessionLimit: 4,
  });
  const reloaded = reader.getHydratedTrajectory(ids[0]);
  assert.equal(reloaded.steps.length, 2);
  assert.equal(reloaded.steps[0].turnPrompt, `Prompt A for ${ids[0]}`);
  assert.equal(reloaded.steps[1].turnPrompt, 'Updated detail prompt after cold reload');
  assert.equal(reloaded.steps[1].inputTokens, 1550);
});

test('loadExternalDeepStatsCache prunes ledger-covered entries, persists zero-unique skip memo, and restores data on cache loss or rebuild', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ag-um-deep-stats-skip-'));
  t.after(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  const geminiDir = join(rootDir, '.gemini');
  const brainDir = join(geminiDir, 'antigravity-ide', 'brain');
  const dataDir = join(rootDir, 'data');
  mkdirSync(brainDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const cid1 = '11111111-1111-4111-8111-111111111111';
  const cid2 = '22222222-2222-4222-8222-222222222222';
  const deepPath = join(brainDir, '.deep_stats_cache.json');
  const deepPayload = {
    accountName: 'user@example.com',
    titleMap: {
      [`ide:${cid1}`]: 'Covered Session 1',
      [`ide:${cid2}`]: 'Covered Session 2',
    },
    perConvo: {
      [`ide:${cid1}`]: {
        appSource: 'ide',
        entries: [
          { ts: '2026-11-20T10:00:00Z', model: 'gemini-2.5-pro', inp: 1000, cache: 0, out: 200, reasoning: 0 },
          { ts: '2026-11-20T10:01:00Z', model: 'gemini-2.5-pro', inp: 1500, cache: 0, out: 300, reasoning: 0 },
        ],
      },
      [`ide:${cid2}`]: {
        appSource: 'ide',
        entries: [
          { ts: '2026-11-20T11:00:00Z', model: 'gemini-2.5-pro', inp: 800, cache: 0, out: 100, reasoning: 0 },
        ],
      },
    },
  };
  writeFileSync(deepPath, JSON.stringify(deepPayload), 'utf8');

  const scannerUrl = new URL('../backend/local-scanner.mjs', import.meta.url).href;
  const configUrl = new URL('../backend/config.mjs', import.meta.url).href;
  const runChild = async (scriptBody) => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--input-type=module', '-e', scriptBody],
      {
        env: {
          ...process.env,
          ANTIGRAVITY_GEMINI_DIR: geminiDir,
          ANTIGRAVITY_EXECUTABLE_DATA_DIR: dataDir,
          ANTIGRAVITY_LS_ADDRESS: 'test.invalid',
        },
      }
    );
    return JSON.parse(stdout.trim().split('\n').pop());
  };

  // Pass 1: 100% covered -> pruned to empty Map + skip memo persisted; missing accountName -> lightweight metadata stub only (0 steps)
  const p1 = await runChild(`
    import { existsSync } from 'node:fs';
    import { loadExternalDeepStatsCache } from ${JSON.stringify(scannerUrl)};
    import { DEEP_STATS_COVERAGE_MEMO_FILE, clearRuntimeCaches } from ${JSON.stringify(configUrl)};
    const cid1 = ${JSON.stringify(cid1)};
    const cid2 = ${JSON.stringify(cid2)};
    const partialLive = new Map([
      [cid1, { title: 'Covered Session 1', accountName: '', steps: [{}, {}] }],
      [cid2, { title: 'Covered Session 2', accountName: 'user@example.com', steps: [{}] }],
    ]);
    const partialExt = loadExternalDeepStatsCache({ coveredByLive: partialLive });
    const partialSize = partialExt.size;
    const stub = partialExt.get('ide:' + cid1);
    const stubStepsLen = stub ? stub.steps.length : -1;
    const stubAcc = stub ? stub.accountName : '';

    clearRuntimeCaches();
    const fullLive = new Map([
      [cid1, { title: 'Covered Session 1', accountName: 'user@example.com', steps: [{}, {}] }],
      [cid2, { title: 'Covered Session 2', accountName: 'user@example.com', steps: [{}] }],
    ]);
    const fullExt = loadExternalDeepStatsCache({ coveredByLive: fullLive });
    const fullSize = fullExt.size;
    const memoWritten = existsSync(DEEP_STATS_COVERAGE_MEMO_FILE);

    // Uncovered entry (cid2 missing from live) MUST bypass pruned memo and recover cid2 steps
    const missingLive = new Map([
      [cid1, { title: 'Covered Session 1', accountName: 'user@example.com', steps: [{}, {}] }],
    ]);
    const recoveredExt = loadExternalDeepStatsCache({ coveredByLive: missingLive });
    console.log(JSON.stringify({
      partialSize,
      stubStepsLen,
      stubAcc,
      fullSize,
      memoWritten,
      recoveredSize: recoveredExt.size,
      recoveredCid2Steps: recoveredExt.get('ide:' + cid2)?.steps?.length || 0,
    }));
  `);
  assert.equal(p1.partialSize, 1);
  assert.equal(p1.stubStepsLen, 0, 'covered session missing only accountName keeps 0-step metadata stub');
  assert.equal(p1.stubAcc, 'user@example.com');
  assert.equal(p1.fullSize, 0, '100% covered sessions are pruned completely');
  assert.equal(p1.memoWritten, true, 'zero-unique skip memo persisted to disk');
  assert.equal(p1.recoveredSize, 1);
  assert.equal(p1.recoveredCid2Steps, 1, 'removing a covered session forces immediate recovery from deep stats');

  // Pass 2: fresh process cold boot hits persisted skip memo without parsing .deep_stats_cache.json, and clearRuntimeCaches() removes memo
  const p2 = await runChild(`
    import { existsSync, statSync, utimesSync, writeFileSync } from 'node:fs';
    import { loadExternalDeepStatsCache } from ${JSON.stringify(scannerUrl)};
    import { DEEP_STATS_COVERAGE_MEMO_FILE, clearRuntimeCaches } from ${JSON.stringify(configUrl)};
    const cid1 = ${JSON.stringify(cid1)};
    const cid2 = ${JSON.stringify(cid2)};
    const deepPath = ${JSON.stringify(deepPath)};
    const origStat = statSync(deepPath);
    // Replace contents with invalid JSON of identical byte length & mtime: if cold boot tried to JSON.parse it, we'd fail or miss recovery
    const corruptSameSize = 'X'.repeat(origStat.size);
    writeFileSync(deepPath, corruptSameSize, 'utf8');
    utimesSync(deepPath, origStat.atime, origStat.mtime);

    const fullLive = new Map([
      [cid1, { title: 'Covered Session 1', accountName: 'user@example.com', steps: [{}, {}] }],
      [cid2, { title: 'Covered Session 2', accountName: 'user@example.com', steps: [{}] }],
    ]);
    const skipped = loadExternalDeepStatsCache({ coveredByLive: fullLive });
    const memoBeforeClear = existsSync(DEEP_STATS_COVERAGE_MEMO_FILE);
    clearRuntimeCaches();
    const memoAfterClear = existsSync(DEEP_STATS_COVERAGE_MEMO_FILE);
    console.log(JSON.stringify({
      skippedSize: skipped.size,
      memoBeforeClear,
      memoAfterClear,
    }));
  `);
  assert.equal(p2.skippedSize, 0);
  assert.equal(p2.memoBeforeClear, true);
  assert.equal(p2.memoAfterClear, false, 'clearRuntimeCaches deletes persisted coverage skip memo');
});
