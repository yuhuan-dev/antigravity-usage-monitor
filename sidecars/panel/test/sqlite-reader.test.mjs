import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';

import {
  pbAsUint8Array,
  pbDecodeCascadeTrajectorySummary,
  pbDecodeGeneratorMetadata,
  pbDecodeStepMetadata,
  pbDecodeStepPayload,
  pbFormatDuration,
  pbFormatTimestamp,
  pbMapApiProvider,
  pbMapChatMessageSource,
  pbMapModelEnum,
  pbMapRunStatus,
  pbMapStepStatus,
  pbMapStepType,
  pbMapTokenSource,
  pbMapTokenType,
  pbMapTrajectorySource,
  pbReadVarintBigIntAt,
} from '../backend/protobuf-wire.mjs';

import {
  computeSqliteWalFileSig,
  discoverSqliteConversationFiles,
  isSqliteReaderAvailable,
  readSqliteCascadeTrajectory,
  readSqliteConversationSummaries,
  resetSqliteReaderCaches,
  statSqliteConversationFile,
} from '../backend/sqlite-trajectory-reader.mjs';

import {
  extractLiveActivity,
  extractModelSteps,
} from '../speed-metrics.mjs';

import { stripModuleSyntax } from '../scripts/build-bundle.mjs';
import { backendHarness } from './backend-harness.mjs';

// --- Minimal Protobuf Wire Encoder Helpers for Deterministic Test Fixtures ---

function encVarint(val) {
  let v = typeof val === 'bigint' ? BigInt.asUintN(64, val) : BigInt.asUintN(64, BigInt(val));
  const out = [];
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return Uint8Array.from(out);
}

function encTag(fieldNo, wireType) {
  return encVarint((BigInt(fieldNo) << 3n) | BigInt(wireType));
}

function concatBytes(...chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

function encBytesField(fieldNo, payload) {
  const u8 = payload instanceof Uint8Array ? payload : Buffer.from(String(payload), 'utf8');
  return concatBytes(encTag(fieldNo, 2), encVarint(u8.length), u8);
}

function encVarintField(fieldNo, val) {
  return concatBytes(encTag(fieldNo, 0), encVarint(val));
}

function encTimestamp(seconds, nanos = 0) {
  const parts = [];
  if (seconds !== 0 && seconds !== 0n) parts.push(encVarintField(1, seconds));
  if (nanos !== 0) parts.push(encVarintField(2, nanos));
  return concatBytes(...parts);
}

function encDuration(seconds, nanos = 0) {
  const parts = [];
  if (seconds !== 0 && seconds !== 0n) parts.push(encVarintField(1, seconds));
  if (nanos !== 0) parts.push(encVarintField(2, nanos));
  return concatBytes(...parts);
}

function encMapEntry(key, value) {
  return concatBytes(encBytesField(1, key), encBytesField(2, value));
}

function createConversationSchema(db) {
  db.exec(`
    PRAGMA journal_mode = wal;
    PRAGMA page_size = 32768;
    CREATE TABLE trajectory_meta (
      trajectory_id text PRIMARY KEY,
      cascade_id text,
      trajectory_type integer,
      source integer
    );
    CREATE TABLE trajectory_metadata_blob (
      id text DEFAULT "main" PRIMARY KEY,
      data blob
    );
    CREATE TABLE steps (
      idx integer PRIMARY KEY,
      step_type integer NOT NULL DEFAULT 0,
      status integer NOT NULL DEFAULT 0,
      has_subtrajectory numeric NOT NULL DEFAULT false,
      metadata blob,
      error_details blob,
      permissions blob,
      task_details blob,
      render_info blob,
      step_payload blob,
      step_format integer NOT NULL DEFAULT 0
    );
    CREATE TABLE gen_metadata (
      idx integer PRIMARY KEY,
      data blob,
      size integer NOT NULL DEFAULT 0
    );
    CREATE TABLE parent_references (
      idx integer PRIMARY KEY,
      data blob
    );
  `);
}

function createSummariesSchema(db) {
  db.exec(`
    PRAGMA journal_mode = wal;
    CREATE TABLE conversation_summaries (
      conversation_id text PRIMARY KEY,
      title text NOT NULL DEFAULT "",
      preview text NOT NULL DEFAULT "",
      step_count integer NOT NULL DEFAULT 0,
      last_modified_time datetime NOT NULL DEFAULT "",
      workspace_uris text NOT NULL DEFAULT "",
      status text NOT NULL DEFAULT "",
      source text NOT NULL DEFAULT "",
      project_id text NOT NULL DEFAULT "",
      agent_name text NOT NULL DEFAULT "",
      parent_conversation_id text NOT NULL DEFAULT "",
      nesting_depth integer NOT NULL DEFAULT 0,
      battle_id text NOT NULL DEFAULT "",
      winning_conversation_id text NOT NULL DEFAULT "",
      not_fully_idle numeric NOT NULL DEFAULT false,
      killed numeric NOT NULL DEFAULT false,
      last_user_input_time datetime NOT NULL DEFAULT "",
      last_user_input_step_index integer NOT NULL DEFAULT -1,
      app_data_dir text NOT NULL DEFAULT "",
      raw_summary blob,
      group_id text NOT NULL DEFAULT ""
    );
    CREATE TABLE conversation_parents (
      conversation_id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL
    ) WITHOUT ROWID;
  `);
}

test('protobuf-wire: 10-byte negative int32, 64-bit uint64, packed/unpacked step_indices, Timestamp/Duration & Model enums', () => {
  // 10-byte sign-extended -1 varint: ff ff ff ff ff ff ff ff ff 01
  const minusOneBytes = Uint8Array.from([
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
  ]);
  const parsedNeg = pbReadVarintBigIntAt(minusOneBytes, 0);
  assert.equal(parsedNeg.nextPos, 10);
  assert.equal(Number(BigInt.asIntN(32, parsedNeg.value)), -1);

  // Zero/Unspecified enum rule: 0 -> '' across all enum tables
  assert.equal(pbMapModelEnum(0), '');
  assert.equal(pbMapModelEnum(1437), 'MODEL_PLACEHOLDER_M437');
  assert.equal(pbMapModelEnum(1000), 'MODEL_PLACEHOLDER_M0');
  assert.equal(pbMapModelEnum(246), 'MODEL_GOOGLE_GEMINI_2_5_PRO');
  assert.equal(pbMapModelEnum(333), 'MODEL_CLAUDE_4_5_SONNET');
  assert.equal(pbMapModelEnum(342), 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM');
  assert.equal(pbMapModelEnum(999), '');

  assert.equal(pbMapStepType(0), '');
  assert.equal(pbMapStepType(15), 'CORTEX_STEP_TYPE_PLANNER_RESPONSE');
  assert.equal(pbMapStepType(23), 'CORTEX_STEP_TYPE_CHECKPOINT');
  assert.equal(pbMapStepType(132), 'CORTEX_STEP_TYPE_GENERIC');
  assert.equal(pbMapStepStatus(0), '');
  assert.equal(pbMapStepStatus(3), 'CORTEX_STEP_STATUS_DONE');
  assert.equal(pbMapRunStatus(0), '');
  assert.equal(pbMapRunStatus(2), 'CASCADE_RUN_STATUS_RUNNING');
  assert.equal(pbMapTrajectorySource(0), '');
  assert.equal(pbMapTrajectorySource(17), 'CORTEX_TRAJECTORY_SOURCE_CLI');
  assert.equal(pbMapTokenType(0), '');
  assert.equal(pbMapTokenType(1), 'TOKEN_TYPE_SYSTEM_PROMPT');
  assert.equal(pbMapTokenType(2), 'TOKEN_TYPE_TOOLS');
  assert.equal(pbMapTokenType(7), 'TOKEN_TYPE_CHAT_MESSAGES');
  assert.equal(pbMapTokenSource(0), '');
  assert.equal(pbMapTokenSource(1), 'TOKEN_SOURCE_SYSTEM');
  assert.equal(pbMapChatMessageSource(0), '');
  assert.equal(pbMapChatMessageSource(4), 'CHAT_MESSAGE_SOURCE_TOOL');
  assert.equal(pbMapApiProvider(0), '');
  assert.equal(pbMapApiProvider(24), 'API_PROVIDER_GOOGLE_GEMINI');
  assert.equal(pbMapApiProvider(26), 'API_PROVIDER_ANTHROPIC_VERTEX');

  // Timestamp & Duration string formatting
  assert.equal(pbFormatTimestamp(0n, 0), '');
  assert.equal(pbFormatTimestamp(-62135596800n, 0), ''); // Go zero time 0001-01-01
  assert.equal(pbFormatTimestamp(1794756590n, 0), '2026-11-15T15:29:50Z');
  assert.equal(pbFormatTimestamp(1794756590n, 123000000), '2026-11-15T15:29:50.123Z');
  assert.equal(pbFormatTimestamp(1794756590n, 586340060), '2026-11-15T15:29:50.586340060Z');

  assert.equal(pbFormatDuration(0n, 0), '0s');
  assert.equal(pbFormatDuration(0n, 850000000), '0.85s');
  assert.equal(pbFormatDuration(11n, 156299627), '11.156299627s');
  assert.equal(pbFormatDuration(-1n, 0), '');

  // Packed (wireType=2) AND unpacked (wireType=0) step_indices + 10-byte checkpoint_index = -1 + 64-bit uint64 tokens
  const packedIndices = concatBytes(encVarint(1), encVarint(2));
  const chatStart = concatBytes(
    concatBytes(encTag(2, 0), minusOneBytes), // checkpoint_index = -1
    encBytesField(10, concatBytes(encVarintField(1, 42000), encVarintField(4, 512000)))
  );
  const bigInputTokens = 5_000_000_123n; // > 2^32 uint64
  const usageBytes = concatBytes(
    encVarintField(1, 1437),
    encVarintField(2, bigInputTokens),
    encVarintField(3, 250n),
    encVarintField(6, 24)
  );
  const chatModelBytes = concatBytes(
    encVarintField(3, 0), // model = 0 -> falls back to custom_metadata.model_enum
    encBytesField(4, usageBytes),
    encBytesField(9, chatStart),
    encBytesField(11, encDuration(0, 850000000)),
    encBytesField(12, encDuration(2, 150000000)),
    encBytesField(19, 'gemini-4-carbon'),
    encBytesField(20, encMapEntry('model_enum', 'MODEL_PLACEHOLDER_M437')),
    encBytesField(21, 'Gemini 4 Carbon (High)')
  );
  const gmWire = concatBytes(
    encBytesField(1, chatModelBytes),
    encBytesField(2, packedIndices), // packed [1, 2]
    encVarintField(2, 3)             // unpacked 3
  );

  const gm = pbDecodeGeneratorMetadata(gmWire);
  assert.deepEqual(gm.stepIndices, [1, 2, 3]);
  assert.equal(gm.chatModel.chatStartMetadata.checkpointIndex, -1);
  assert.equal(gm.chatModel.usage.inputTokens, 5_000_000_123);
  assert.equal(gm.chatModel.model, 'MODEL_PLACEHOLDER_M437');
  assert.equal(gm.chatModel.timeToFirstToken, '0.85s');
  assert.equal(gm.chatModel.streamingDuration, '2.15s');

  // Verify exact nanosecond boundary (0.499999999s vs 0.500000001s) in extractModelSteps
  const mkStep = (idx, endNanos) => {
    const metaBytes = concatBytes(
      encBytesField(1, encTimestamp(1794756590n, 0)),
      encBytesField(7, encTimestamp(1794756590n, endNanos)),
      encBytesField(
        9,
        concatBytes(
          encVarintField(1, 1437),
          encVarintField(2, 1000),
          encVarintField(3, 100),
          encVarintField(6, 24)
        )
      ),
      encBytesField(20, concatBytes(encVarintField(2, idx), encBytesField(4, 'cid-ns')))
    );
    return {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: pbDecodeStepMetadata(metaBytes, idx),
    };
  };

  const extractedNs = extractModelSteps([mkStep(0, 499_999_999), mkStep(1, 500_000_001)], []);
  assert.equal(extractedNs[0].speedReason, 'short_timing');
  assert.equal(extractedNs[0].totalTokPerSec, null);
  assert.equal(extractedNs[1].speedReason, null);
  assert.ok(extractedNs[1].totalTokPerSec > 199.9 && extractedNs[1].totalTokPerSec < 200.1);
});

test('CHECKPOINT (step_type = 23) with model=0 and no gen_metadata infers model & blocks stale contextBreakdown', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-sqlite-cp-'));
  try {
    const cid = 'aaaaaaaa-1111-4444-8888-cccccccccccc';
    const dbPath = path.join(tmpDir, `${cid}.db`);
    const db = new DatabaseSync(dbPath);
    try {
      createConversationSchema(db);
      db.prepare(
        'INSERT INTO trajectory_meta (trajectory_id, cascade_id, trajectory_type, source) VALUES (?, ?, ?, ?)'
      ).run('traj-1', cid, 4, 1);
      db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run(
        'main',
        encBytesField(2, encTimestamp(1794750000n, 0))
      );

      // Step 1: Normal PLANNER_RESPONSE with M437 and 180k context breakdown
      const step1Meta = concatBytes(
        encBytesField(1, encTimestamp(1794750010n, 0)),
        encBytesField(7, encTimestamp(1794750015n, 0)),
        encBytesField(
          9,
          concatBytes(
            encVarintField(1, 1437), // M437
            encVarintField(2, 150000),
            encVarintField(3, 300),
            encVarintField(5, 30000),
            encVarintField(6, 24),
            encVarintField(9, 200),
            encVarintField(10, 100)
          )
        ),
        encBytesField(20, concatBytes(encVarintField(2, 1), encBytesField(4, cid)))
      );
      const step1Payload = encBytesField(
        20,
        concatBytes(encBytesField(1, 'Working on task...'), encBytesField(11, encDuration(2, 0)))
      );
      db.prepare(
        'INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)'
      ).run(1, 15, 3, step1Meta, step1Payload);

      const tbGroup = concatBytes(
        encBytesField(1, 'System Prompt'),
        encVarintField(2, 1),
        encVarintField(3, 1),
        encVarintField(4, 12000)
      );
      const gm0 = concatBytes(
        encBytesField(
          1,
          concatBytes(
            encVarintField(3, 1437),
            encBytesField(4, concatBytes(encVarintField(1, 1437), encVarintField(2, 150000), encVarintField(3, 300))),
            encBytesField(
              9,
              encBytesField(
                10,
                concatBytes(
                  encVarintField(1, 180000),
                  encBytesField(3, concatBytes(encBytesField(1, tbGroup), encVarintField(2, 12000))),
                  encVarintField(4, 512000)
                )
              )
            ),
            encBytesField(11, encDuration(0, 750000000)),
            encBytesField(12, encDuration(4, 250000000)),
            encBytesField(19, 'gemini-4-carbon'),
            encBytesField(20, encMapEntry('cascade_id', cid)),
            encBytesField(21, 'Gemini 4 Carbon (High)')
          )
        ),
        encBytesField(2, encVarint(1))
      );
      db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(0, gm0, gm0.length);

      // Step 2: CHECKPOINT (step_type = 23) with model_usage.model = 0 and NO gen_metadata row!
      const step2Meta = concatBytes(
        encBytesField(1, encTimestamp(1794750020n, 0)),
        encBytesField(8, encTimestamp(1794750026n, 0)),
        encBytesField(
          9,
          concatBytes(
            encVarintField(1, 0), // model = 0 -> must decode to '' so inferCompactionStepModels runs!
            encVarintField(2, 180500),
            encVarintField(3, 1200),
            encVarintField(6, 24)
          )
        ),
        encBytesField(20, concatBytes(encVarintField(2, 2), encBytesField(4, cid)))
      );
      db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(
        2,
        23,
        3,
        step2Meta
      );
    } finally {
      db.close();
    }

    const trajRes = readSqliteCascadeTrajectory(cid, { dbPath });
    assert.ok(trajRes);
    const steps = extractModelSteps(trajRes.trajectory.steps, trajRes.trajectory.generatorMetadata);
    assert.equal(steps.length, 2);

    assert.equal(steps[0].isCompactionStep, false);
    assert.equal(steps[0].modelKey, 'MODEL_PLACEHOLDER_M437');
    assert.equal(steps[0].contextBreakdown?.systemPromptTokens, 12000);

    assert.equal(steps[1].isCompactionStep, true);
    assert.equal(steps[1].modelKey, 'MODEL_PLACEHOLDER_M437');
    assert.equal(steps[1].modelSource, 'inferred_compaction');
    assert.equal(steps[1].responseModel, 'gemini-4-carbon');
    assert.equal(steps[1].modelDisplayName, 'Gemini 4 Carbon (High)');
    assert.equal(steps[1].speedReason, 'compaction');
    assert.equal(steps[1].speedSampleEligible, false);
    // Compaction reset barrier: newly completed CHECKPOINT step must NOT inherit pre-compaction contextBreakdown
    assert.equal(steps[1].contextBreakdown, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SIDE_QUESTION (trajectory_type = 22) filters cloned parent steps & gen_metadata while keeping genuine own steps', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-sqlite-sq-'));
  try {
    const parentCid = '11111111-2222-4333-8444-555555555555';
    const sqCid = '99999999-8888-4777-8666-444444444444';
    const sqDbPath = path.join(tmpDir, `${sqCid}.db`);

    const db = new DatabaseSync(sqDbPath);
    try {
      createConversationSchema(db);
      db.prepare(
        'INSERT INTO trajectory_meta (trajectory_id, cascade_id, trajectory_type, source) VALUES (?, ?, ?, ?)'
      ).run('traj-sq', sqCid, 22, 1);
      db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run(
        'main',
        encBytesField(2, encTimestamp(1794760000n, 0))
      );
      // Fork reference pointing to parentCid
      db.prepare('INSERT INTO parent_references (idx, data) VALUES (?, ?)').run(
        0,
        concatBytes(
          encBytesField(1, 'traj-parent'),
          encVarintField(2, 1),
          encVarintField(3, 4),
          encVarintField(5, 2),
          encBytesField(6, parentCid)
        )
      );

      // Step 0 & Step 1: Cloned from parentCid (including a parent invoke_subagent!)
      const clonedPlanMeta = concatBytes(
        encBytesField(1, encTimestamp(1794759000n, 0)),
        encBytesField(7, encTimestamp(1794759005n, 0)),
        encBytesField(
          9,
          concatBytes(encVarintField(1, 1437), encVarintField(2, 99999), encVarintField(3, 888))
        ),
        encBytesField(20, concatBytes(encVarintField(2, 0), encBytesField(4, parentCid)))
      );
      db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(
        0,
        15,
        3,
        clonedPlanMeta
      );

      const clonedSubMeta = concatBytes(
        encBytesField(1, encTimestamp(1794759006n, 0)),
        encBytesField(4, concatBytes(encBytesField(1, 'tc-0'), encBytesField(2, 'invoke_subagent'))),
        encBytesField(20, concatBytes(encVarintField(2, 1), encBytesField(4, parentCid)))
      );
      db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(
        1,
        132,
        3,
        clonedSubMeta
      );

      // Cloned parent gen_metadata row 0
      const clonedGm = concatBytes(
        encBytesField(
          1,
          concatBytes(
            encVarintField(3, 1437),
            encBytesField(4, concatBytes(encVarintField(1, 1437), encVarintField(2, 99999), encVarintField(3, 888))),
            encBytesField(20, encMapEntry('cascade_id', parentCid))
          )
        ),
        encBytesField(2, encVarint(0))
      );
      db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(
        0,
        clonedGm,
        clonedGm.length
      );

      // Step 2: Genuine own Side Question USER_INPUT
      const ownUserMeta = concatBytes(
        encBytesField(1, encTimestamp(1794760001n, 0)),
        encBytesField(20, concatBytes(encVarintField(2, 2), encBytesField(4, sqCid)))
      );
      const ownUserPayload = encBytesField(
        19,
        encBytesField(2, '  为什么这里要用 BigInt 处理纳秒？\n第二行补充  ')
      );
      db.prepare(
        'INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)'
      ).run(2, 14, 3, ownUserMeta, ownUserPayload);

      // Step 3: Genuine own Side Question PLANNER_RESPONSE
      const ownPlanMeta = concatBytes(
        encBytesField(1, encTimestamp(1794760002n, 0)),
        encBytesField(7, encTimestamp(1794760004n, 0)),
        encBytesField(
          9,
          concatBytes(
            encVarintField(1, 1525),
            encVarintField(2, 102000),
            encVarintField(3, 180),
            encVarintField(6, 24)
          )
        ),
        encBytesField(20, concatBytes(encVarintField(2, 3), encBytesField(4, sqCid)))
      );
      const ownPlanPayload = encBytesField(
        20,
        concatBytes(encBytesField(1, '因为 IEEE-754 双精度上限是 9e15。'), encBytesField(11, encDuration(0, 600000000)))
      );
      db.prepare(
        'INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)'
      ).run(3, 15, 3, ownPlanMeta, ownPlanPayload);

      // Genuine own gen_metadata row 1
      const ownGm = concatBytes(
        encBytesField(
          1,
          concatBytes(
            encVarintField(3, 1525),
            encBytesField(4, concatBytes(encVarintField(1, 1525), encVarintField(2, 102000), encVarintField(3, 180))),
            encBytesField(11, encDuration(0, 420000000)),
            encBytesField(12, encDuration(1, 580000000)),
            encBytesField(19, 'gemini-4-hydrogen'),
            encBytesField(20, encMapEntry('cascade_id', sqCid)),
            encBytesField(21, 'Gemini 4 Hydrogen (High)')
          )
        ),
        encBytesField(2, encVarint(3))
      );
      db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(
        1,
        ownGm,
        ownGm.length
      );
    } finally {
      db.close();
    }

    const trajRes = readSqliteCascadeTrajectory(sqCid, { dbPath: sqDbPath });
    assert.equal(trajRes.trajectoryType, 22);
    assert.equal(trajRes.isSideQuestion, true);
    assert.equal(trajRes.forkParentConversationId, parentCid);
    assert.equal(trajRes.rawTableStepCount, 4);
    assert.equal(trajRes.numTotalSteps, 2);
    assert.equal(trajRes.firstOwnUserPrompt, '为什么这里要用 BigInt 处理纳秒？ 第二行补充');
    assert.equal(trajRes.trajectory.generatorMetadata.length, 1);

    const modelSteps = extractModelSteps(
      trajRes.trajectory.steps,
      trajRes.trajectory.generatorMetadata
    );
    assert.equal(modelSteps.length, 1);
    assert.equal(modelSteps[0].stepIndex, 3);
    assert.equal(modelSteps[0].modelKey, 'MODEL_PLACEHOLDER_M525');
    assert.equal(modelSteps[0].inputTokens, 102000);
    assert.equal(modelSteps[0].outputTokens, 180);
    assert.equal(modelSteps[0].ttftSec, 0.42);
    assert.equal(modelSteps[0].hasVisibleText, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('step_type = 132 GENERIC invoke_subagent Any decoding + 10-dimension TokenBreakdown + Stage 2 fallbacks', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-sqlite-sub-10d-'));
  try {
    const cid = '22222222-3333-4444-8555-666666666666';
    const childCid = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
    const dbPath = path.join(tmpDir, `${cid}.db`);

    const db = new DatabaseSync(dbPath);
    try {
      createConversationSchema(db);
      db.prepare(
        'INSERT INTO trajectory_meta (trajectory_id, cascade_id, trajectory_type, source) VALUES (?, ?, ?, ?)'
      ).run('traj-main', cid, 4, 1);
      db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run(
        'main',
        concatBytes(
          encBytesField(2, encTimestamp(1794770000n, 0)),
          encBytesField(6, cid)
        )
      );

      // Step 0: GENERIC (132) invoke_subagent step with Any payload
      const invokeAnyVal = concatBytes(
        encBytesField(
          1,
          concatBytes(
            encBytesField(1, 'research'),
            encBytesField(2, 'Schema Reverse Engineer'),
            encBytesField(3, 'Huge initial prompt skipped')
          )
        ),
        encBytesField(2, encBytesField(1, childCid.toUpperCase()))
      );
      const invokeStepPayload = encBytesField(
        140, // generic
        encBytesField(
          2, // GenericStepResult
          encBytesField(
            6, // google.protobuf.Any payload
            concatBytes(
              encBytesField(1, 'type.googleapis.com/exa.cortex.core.tools.InvokeSubagent'),
              encBytesField(2, invokeAnyVal)
            )
          )
        )
      );
      const invokeMeta = concatBytes(
        encBytesField(1, encTimestamp(1794770005n, 0)),
        encBytesField(
          4,
          concatBytes(
            encBytesField(1, 'call-sub-1'),
            encBytesField(2, 'default_api:invoke_subagent'),
            encBytesField(3, JSON.stringify({ Role: 'Schema Reverse Engineer', TypeName: 'research' }))
          )
        ),
        encBytesField(20, concatBytes(encVarintField(2, 0), encBytesField(4, cid)))
      );
      db.prepare(
        'INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)'
      ).run(0, 132, 3, invokeMeta, invokeStepPayload);

      // Step 1: PLANNER_RESPONSE with full 10D TokenBreakdown
      const planMeta = concatBytes(
        encBytesField(1, encTimestamp(1794770010n, 0)),
        encBytesField(7, encTimestamp(1794770015n, 0)),
        encBytesField(
          9,
          concatBytes(
            encVarintField(1, 1437),
            encVarintField(2, 20000),
            encVarintField(3, 500),
            encVarintField(5, 30000),
            encVarintField(6, 24)
          )
        ),
        encBytesField(20, concatBytes(encVarintField(2, 1), encBytesField(4, cid)))
      );
      const planPayload = encBytesField(
        20,
        concatBytes(
          encBytesField(1, 'Subagent completed.'),
          encBytesField(7, concatBytes(encBytesField(1, 'tc-1'), encBytesField(2, 'read_file')))
        )
      );
      db.prepare(
        'INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)'
      ).run(1, 15, 3, planMeta, planPayload);

      const sysGroup = concatBytes(
        encBytesField(1, 'System Prompt'),
        encVarintField(2, 1), // TOKEN_TYPE_SYSTEM_PROMPT
        encVarintField(3, 1),
        encVarintField(4, 15000),
        encBytesField(5, concatBytes(encBytesField(1, 'identity'), encVarintField(3, 7000))),
        encBytesField(5, concatBytes(encBytesField(1, 'skills'), encVarintField(3, 3000))),
        encBytesField(5, concatBytes(encBytesField(1, 'user_rules'), encVarintField(3, 4000))),
        encBytesField(5, concatBytes(encBytesField(1, 'mcp_servers'), encVarintField(3, 1000)))
      );
      const toolsGroup = concatBytes(
        encBytesField(1, 'Tools'),
        encVarintField(2, 2), // TOKEN_TYPE_TOOLS
        encVarintField(3, 1),
        encVarintField(4, 6500),
        encBytesField(5, concatBytes(encBytesField(1, 'run_command'), encVarintField(3, 5000))),
        encBytesField(5, concatBytes(encBytesField(1, 'mcp_exa_web_search_exa'), encVarintField(3, 1500)))
      );
      const msgsGroup = concatBytes(
        encBytesField(1, 'Chat Messages'),
        encVarintField(2, 7), // TOKEN_TYPE_CHAT_MESSAGES
        encVarintField(3, 2),
        encVarintField(4, 28500),
        encBytesField(5, concatBytes(encBytesField(1, '0: USER_INPUT'), encVarintField(3, 500))),
        encBytesField(5, concatBytes(encBytesField(1, '1: PLANNER_RESPONSE'), encVarintField(3, 6000))),
        encBytesField(5, concatBytes(encBytesField(1, '2: GENERIC'), encVarintField(3, 18000))),
        encBytesField(5, concatBytes(encBytesField(1, '3: SYSTEM_MESSAGE'), encVarintField(3, 2500))),
        encBytesField(5, concatBytes(encBytesField(1, '4: CHECKPOINT'), encVarintField(3, 1500)))
      );
      const tbBytes = concatBytes(
        encBytesField(1, sysGroup),
        encBytesField(1, toolsGroup),
        encBytesField(1, msgsGroup),
        encVarintField(2, 50000)
      );
      const gmBytes = concatBytes(
        encBytesField(
          1,
          concatBytes(
            encVarintField(3, 1437),
            encBytesField(4, concatBytes(encVarintField(1, 1437), encVarintField(2, 20000), encVarintField(3, 500))),
            encBytesField(
              9,
              encBytesField(
                10,
                concatBytes(
                  encVarintField(1, 50000),
                  encBytesField(3, tbBytes),
                  encVarintField(4, 512000)
                )
              )
            ),
            encBytesField(11, encDuration(1, 250000000)),
            encBytesField(12, encDuration(3, 750000000)),
            encBytesField(19, 'gemini-4-carbon'),
            encBytesField(20, encMapEntry('cascade_id', cid))
          )
        ),
        encBytesField(2, encVarint(1))
      );
      db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(
        0,
        gmBytes,
        gmBytes.length
      );
    } finally {
      db.close();
    }

    const trajRes = readSqliteCascadeTrajectory(cid, { dbPath });
    const subStep = trajRes.trajectory.steps[0];
    assert.equal(subStep.type, 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT');
    assert.deepEqual(subStep.invokeSubagent, {
      subagents: [{ typeName: 'research', role: 'Schema Reverse Engineer' }],
      results: [{ conversationId: childCid }],
    });

    const modelSteps = extractModelSteps(
      trajRes.trajectory.steps,
      trajRes.trajectory.generatorMetadata
    );
    assert.equal(modelSteps.length, 1);
    assert.equal(modelSteps[0].hasVisibleText, true);
    assert.equal(modelSteps[0].hasToolCalls, true);
    assert.deepEqual(modelSteps[0].contextBreakdown, {
      messagesTokens: 28500,
      userInputTokens: 500,
      assistantTokens: 6000,
      toolResultsTokens: 18000,
      subagentTokens: 2500,
      checkpointTokens: 1500,
      systemToolsTokens: 5000,
      mcpToolsTokens: 2500, // 1000 from mcp_servers + 1500 from mcp_exa_web_search_exa
      skillsTokens: 3000,
      systemPromptTokens: 7000,
      userRulesTokens: 4000,
      totalTokens: 50000,
    });

    // Stage 2 fallback test when tokenBreakdown.groups is absent (UTF-8 byte estimation, omitted numTokens)
    const stage2ChatBytes = concatBytes(
      encVarintField(3, 1437),
      encBytesField(16, concatBytes(encBytesField(1, 'skills'), encBytesField(2, 'abcdef'))), // 6 bytes -> 2 tokens
      encBytesField(16, concatBytes(encBytesField(1, 'user_rules'), encBytesField(2, '123456789'))), // 9 bytes -> 3 tokens
      encBytesField(8, concatBytes(encBytesField(1, 'run_command'), encBytesField(2, 'exec'))), // 15 bytes -> 5 tokens
      encBytesField(8, concatBytes(encBytesField(1, 'mcp_exa_search'), encBytesField(2, 'ab'))), // 16 bytes -> 6 tokens
      encBytesField(2, concatBytes(encVarintField(2, 4), encBytesField(3, 'tool output!'))), // 12 bytes -> 4 tokens
      encBytesField(2, concatBytes(encVarintField(2, 1), encBytesField(3, 'hello!'))) // 6 bytes -> 2 tokens
    );
    const stage2Gm = pbDecodeGeneratorMetadata(encBytesField(1, stage2ChatBytes), {
      includeContextBreakdown: true,
    });
    const stage2Steps = extractModelSteps(
      [
        {
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          status: 'CORTEX_STEP_STATUS_DONE',
          metadata: {
            createdAt: '2026-11-16T00:00:00Z',
            finishedGeneratingAt: '2026-11-16T00:00:02Z',
            modelUsage: { model: 'MODEL_PLACEHOLDER_M437', inputTokens: 22, outputTokens: 10 },
            sourceTrajectoryStepInfo: { stepIndex: 0 },
          },
        },
      ],
      [{ ...stage2Gm, stepIndices: [0] }]
    );
    assert.deepEqual(stage2Steps[0].contextBreakdown, {
      messagesTokens: 6,
      userInputTokens: 2,
      assistantTokens: 0,
      toolResultsTokens: 4,
      subagentTokens: 0,
      checkpointTokens: 0,
      systemToolsTokens: 5,
      mcpToolsTokens: 6,
      skillsTokens: 2,
      systemPromptTokens: 0,
      userRulesTokens: 3,
      totalTokens: 22,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Active WAL uncheckpointed writes update computeSqliteWalFileSig & invalidate summaries memo + running liveActivity', () => {
  resetSqliteReaderCaches();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-sqlite-wal-'));
  try {
    const summariesDbPath = path.join(tmpDir, 'conversation_summaries.db');
    const convDir = path.join(tmpDir, 'conversations');
    const cliDir = path.join(tmpDir, 'antigravity-cli', 'conversations');
    fs.mkdirSync(convDir, { recursive: true });
    fs.mkdirSync(cliDir, { recursive: true });

    const rootCid = 'aaaa1111-2222-4333-8444-555555555555';
    const sqCid = 'bbbb1111-2222-4333-8444-555555555555';
    const cliCid = 'cccc1111-2222-4333-8444-555555555555';

    // Keep writer handle open with wal_autocheckpoint = 0 so writes land exclusively in .db-wal!
    const writer = new DatabaseSync(summariesDbPath);
    try {
      createSummariesSchema(writer);
      writer.exec('PRAGMA wal_autocheckpoint = 0;');

      const rawSummary1 = concatBytes(
        encBytesField(1, 'Initial preview'),
        encVarintField(2, 4),
        encBytesField(3, encTimestamp(1794780000n, 0)),
        encVarintField(5, 1), // IDLE
        encBytesField(7, encTimestamp(1794779000n, 0)),
        encBytesField(
          15,
          concatBytes(
            encBytesField(1, 'Root Session Title'),
            encBytesField(17, sqCid.toUpperCase()),
            encBytesField(18, encMapEntry(sqCid.toUpperCase(), 'Side Question Title'))
          )
        ),
        encBytesField(17, concatBytes(encBytesField(2, encTimestamp(1794779000n, 0)), encBytesField(6, rootCid)))
      );

      writer
        .prepare(
          `INSERT INTO conversation_summaries
           (conversation_id, title, preview, step_count, last_modified_time, status, raw_summary)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          rootCid,
          'Root Session Title',
          'Initial preview',
          4,
          '2026-11-15 22:00:00+00:00',
          'CASCADE_RUN_STATUS_IDLE',
          rawSummary1
        );
      writer
        .prepare('INSERT INTO conversation_parents (conversation_id, parent_id) VALUES (?, ?)')
        .run(sqCid, rootCid);

      assert.equal(isSqliteReaderAvailable(summariesDbPath), true);
      assert.equal(isSqliteReaderAvailable(path.join(tmpDir, 'nonexistent.db')), false);

      const sigBefore = computeSqliteWalFileSig(summariesDbPath);
      assert.equal(sigBefore.exists, true);

      const res1 = readSqliteConversationSummaries({ summariesDbPath });
      assert.equal(res1.available, true);
      assert.equal(res1.summaries[rootCid].stepCount, 4);
      assert.equal(res1.summaries[rootCid].status, 'CASCADE_RUN_STATUS_IDLE');
      assert.deepEqual(res1.sideQuestionParents[sqCid], {
        parentConversationId: rootCid,
        title: 'Side Question Title',
      });

      // Memo hit check
      const res1Cached = readSqliteConversationSummaries({ summariesDbPath });
      assert.equal(res1Cached, res1);

      // Write an uncheckpointed WAL frame via writer (changing status -> RUNNING and step_count -> 9)
      const rawSummary2 = concatBytes(
        encBytesField(1, 'Initial preview'),
        encVarintField(2, 9),
        encBytesField(3, encTimestamp(1794780050n, 0)),
        encVarintField(5, 2), // RUNNING
        encBytesField(7, encTimestamp(1794779000n, 0)),
        encBytesField(15, encBytesField(1, 'Root Session Title'))
      );
      writer
        .prepare(
          'UPDATE conversation_summaries SET step_count = ?, status = ?, raw_summary = ? WHERE conversation_id = ?'
        )
        .run(9, 'CASCADE_RUN_STATUS_RUNNING', rawSummary2, rootCid);

      const sigAfter = computeSqliteWalFileSig(summariesDbPath);
      assert.notEqual(sigAfter.sig, sigBefore.sig, 'WAL append must change composite file signature');

      const res2 = readSqliteConversationSummaries({ summariesDbPath });
      assert.notEqual(res2, res1);
      assert.equal(res2.summaries[rootCid].stepCount, 9);
      assert.equal(res2.summaries[rootCid].status, 'CASCADE_RUN_STATUS_RUNNING');

      // Test discoverSqliteConversationFiles + statSqliteConversationFile + running tail liveActivity
      const rootDbPath = path.join(convDir, `${rootCid}.db`);
      const cliDbPath = path.join(cliDir, `${cliCid}.db`);
      const convWriter = new DatabaseSync(rootDbPath);
      const cliWriter = new DatabaseSync(cliDbPath);
      try {
        createConversationSchema(convWriter);
        convWriter.exec('PRAGMA wal_autocheckpoint = 0;');
        convWriter
          .prepare(
            'INSERT INTO trajectory_meta (trajectory_id, cascade_id, trajectory_type, source) VALUES (?, ?, ?, ?)'
          )
          .run('t-root', rootCid, 4, 1);

        const runningToolMeta = concatBytes(
          encBytesField(1, encTimestamp(1794780051n, 0)),
          encBytesField(
            4,
            concatBytes(
              encBytesField(1, 'tc-run'),
              encBytesField(2, 'run_command'),
              encBytesField(
                3,
                JSON.stringify({ CommandLine: 'npm test', toolSummary: 'Run unit tests' })
              )
            )
          ),
          encBytesField(20, concatBytes(encVarintField(2, 0), encBytesField(4, rootCid)))
        );
        convWriter
          .prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)')
          .run(0, 132, 2, runningToolMeta); // status = 2 (RUNNING)

        createConversationSchema(cliWriter);
        cliWriter
          .prepare(
            'INSERT INTO trajectory_meta (trajectory_id, cascade_id, trajectory_type, source) VALUES (?, ?, ?, ?)'
          )
          .run('t-cli', cliCid, 4, 17);

        const customDirs = [
          { dir: convDir, appSource: 'standalone' },
          { dir: cliDir, appSource: 'cli' },
        ];
        const discovered = discoverSqliteConversationFiles({
          conversationsDirs: customDirs,
          nowMs: 1000,
        });
        assert.equal(discovered.size, 2);
        assert.equal(discovered.get(rootCid).appSource, 'standalone');
        assert.equal(discovered.get(cliCid).appSource, 'cli');

        const statFast = statSqliteConversationFile(rootCid, {
          conversationsDirs: customDirs,
        });
        assert.equal(statFast.dbPath, rootDbPath);

        const runningTraj = readSqliteCascadeTrajectory(rootCid, {
          dbPath: rootDbPath,
          isRunning: true,
        });
        assert.equal(runningTraj.trajectory.steps[0].type, 'CORTEX_STEP_TYPE_RUN_COMMAND');
        const liveAct = extractLiveActivity(runningTraj.trajectory.steps, true, 1794780050000);
        assert.equal(liveAct.phase, 'tool');
        assert.equal(liveAct.label, '执行命令');
        assert.match(liveAct.detail, /Run unit tests/);
      } finally {
        convWriter.close();
        cliWriter.close();
      }
    } finally {
      writer.close();
    }
  } finally {
    resetSqliteReaderCaches();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('stripModuleSyntax & VM sandbox concatenation compatibility (without TextDecoder in VM realm)', () => {
  const wireSrc = fs.readFileSync(
    new URL('../backend/protobuf-wire.mjs', import.meta.url),
    'utf8'
  );
  const readerSrc = fs.readFileSync(
    new URL('../backend/sqlite-trajectory-reader.mjs', import.meta.url),
    'utf8'
  );
  const combinedStripped = stripModuleSyntax(`${wireSrc}\n${readerSrc}`);

  assert.equal(/\bimport\s+/.test(combinedStripped), false);
  assert.equal(/\bexport\s+/.test(combinedStripped), false);

  const ctx = {
    Buffer,
    existsSync: () => false,
    readdirSync: () => [],
    statSync: () => ({ mtimeMs: 0, size: 0 }),
    homedir: () => '/test-home',
    join: path.join,
    DatabaseSync,
  };

  vm.runInNewContext(
    `${combinedStripped}\nglobalThis.vmExports = { pbMapModelEnum, pbFormatTimestamp, isSqliteReaderAvailable, readSqliteConversationSummaries, pbAsUint8Array };`,
    ctx
  );

  assert.equal(ctx.vmExports.pbMapModelEnum(1437), 'MODEL_PLACEHOLDER_M437');
  assert.equal(ctx.vmExports.pbMapModelEnum(0), '');
  assert.equal(ctx.vmExports.pbFormatTimestamp(1794756590n, 0), '2026-11-15T15:29:50Z');
  assert.equal(ctx.vmExports.isSqliteReaderAvailable(), false);
  const emptyRes = ctx.vmExports.readSqliteConversationSummaries();
  assert.equal(emptyRes.available, false);
});

test('end-to-end buildTelemetryPayloadInternal via SQLite Direct: zero trajectory RPCs, Side Question child badge, main context protection, and old cloned-step cache upgrade', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'um-e2e-sqlite-'));
  try {
    const agyDir = path.join(tmpHome, '.gemini', 'antigravity');
    const convDir = path.join(agyDir, 'conversations');
    fs.mkdirSync(convDir, { recursive: true });

    const rootCid = 'aaaa1111-2222-4333-8444-555555555555';
    const subCid = 'bbbb1111-2222-4333-8444-555555555555';
    const sqCid = 'cccc1111-2222-4333-8444-555555555555';
    const emptySqCid = 'dddd1111-2222-4333-8444-555555555555';

    // 1. Build conversation_summaries.db
    const sumDb = new DatabaseSync(path.join(agyDir, 'conversation_summaries.db'));
    try {
      createSummariesSchema(sumDb);
      const rootRawSummary = concatBytes(
        encBytesField(1, 'Main Engineering Task'),
        encVarintField(2, 2),
        encBytesField(3, encTimestamp(1794800010n, 0)),
        encVarintField(5, 1),
        encBytesField(7, encTimestamp(1794800000n, 0)),
        encBytesField(
          15,
          concatBytes(
            encBytesField(1, 'Main Engineering Task'),
            encBytesField(17, sqCid),
            encBytesField(17, emptySqCid),
            encBytesField(18, encMapEntry(sqCid, 'WAL 并发锁机制提问'))
          )
        )
      );
      sumDb
        .prepare(
          'INSERT INTO conversation_summaries (conversation_id, title, step_count, last_modified_time, status, raw_summary) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(rootCid, 'Main Engineering Task', 2, '2026-11-16 03:33:30+00:00', 'CASCADE_RUN_STATUS_IDLE', rootRawSummary);

      const subRawSummary = concatBytes(
        encVarintField(2, 1),
        encBytesField(3, encTimestamp(1794800020n, 0)),
        encVarintField(5, 1),
        encBytesField(7, encTimestamp(1794800012n, 0)),
        encBytesField(
          17,
          concatBytes(
            encBytesField(5, rootCid),
            encBytesField(6, rootCid),
            encBytesField(8, concatBytes(encBytesField(1, 'self'), encBytesField(2, 'Schema Auditor'))),
            encVarintField(17, 1)
          )
        )
      );
      sumDb
        .prepare(
          'INSERT INTO conversation_summaries (conversation_id, step_count, last_modified_time, status, parent_conversation_id, nesting_depth, raw_summary) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(subCid, 1, '2026-11-16 03:33:40+00:00', 'CASCADE_RUN_STATUS_IDLE', rootCid, 1, subRawSummary);

      sumDb
        .prepare('INSERT INTO conversation_parents (conversation_id, parent_id) VALUES (?, ?)')
        .run(sqCid, rootCid);
      sumDb
        .prepare('INSERT INTO conversation_parents (conversation_id, parent_id) VALUES (?, ?)')
        .run(emptySqCid, rootCid);
    } finally {
      sumDb.close();
    }

    // 2. Root conversation .db (context breakdown = 42,000 tokens)
    const rootDb = new DatabaseSync(path.join(convDir, `${rootCid}.db`));
    try {
      createConversationSchema(rootDb);
      rootDb
        .prepare('INSERT INTO trajectory_meta (trajectory_id, cascade_id, trajectory_type, source) VALUES (?, ?, ?, ?)')
        .run('traj-root', rootCid, 4, 1);
      rootDb
        .prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)')
        .run('main', encBytesField(6, rootCid));
      rootDb
        .prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)')
        .run(
          0,
          15,
          3,
          concatBytes(
            encBytesField(1, encTimestamp(1794800001n, 0)),
            encBytesField(7, encTimestamp(1794800006n, 0)),
            encBytesField(9, concatBytes(encVarintField(1, 1437), encVarintField(2, 10000), encVarintField(3, 500), encVarintField(5, 30000), encVarintField(6, 24))),
            encBytesField(20, concatBytes(encVarintField(2, 0), encBytesField(4, rootCid)))
          ),
          encBytesField(20, encBytesField(1, 'Main response'))
        );
      const rootGm = concatBytes(
        encBytesField(
          1,
          concatBytes(
            encVarintField(3, 1437),
            encBytesField(4, concatBytes(encVarintField(1, 1437), encVarintField(2, 10000), encVarintField(3, 500), encVarintField(5, 30000))),
            encBytesField(
              9,
              encBytesField(
                10,
                concatBytes(
                  encVarintField(1, 42000),
                  encBytesField(
                    3,
                    concatBytes(
                      encBytesField(1, concatBytes(encBytesField(1, 'System Prompt'), encVarintField(2, 1), encVarintField(4, 12000))),
                      encBytesField(1, concatBytes(encBytesField(1, 'Chat Messages'), encVarintField(2, 7), encVarintField(4, 30000)))
                    )
                  ),
                  encVarintField(4, 256000)
                )
              )
            ),
            encBytesField(11, encDuration(1, 0)),
            encBytesField(19, 'gemini-4-carbon'),
            encBytesField(20, encMapEntry('cascade_id', rootCid)),
            encBytesField(21, 'Gemini 4 Carbon (Medium)')
          )
        ),
        encBytesField(2, encVarint(0))
      );
      rootDb.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(0, rootGm, rootGm.length);
    } finally {
      rootDb.close();
    }

    // 3. Subagent .db (context = 18,000 tokens)
    const subDb = new DatabaseSync(path.join(convDir, `${subCid}.db`));
    try {
      createConversationSchema(subDb);
      subDb
        .prepare('INSERT INTO trajectory_meta (trajectory_id, cascade_id, trajectory_type, source) VALUES (?, ?, ?, ?)')
        .run('traj-sub', subCid, 4, 1);
      subDb
        .prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)')
        .run(
          'main',
          concatBytes(
            encBytesField(5, rootCid),
            encBytesField(6, rootCid),
            encBytesField(8, concatBytes(encBytesField(1, 'self'), encBytesField(2, 'Schema Auditor')))
          )
        );
      subDb
        .prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)')
        .run(
          0,
          15,
          3,
          concatBytes(
            encBytesField(1, encTimestamp(1794800013n, 0)),
            encBytesField(7, encTimestamp(1794800018n, 0)),
            encBytesField(9, concatBytes(encVarintField(1, 1525), encVarintField(2, 5000), encVarintField(3, 250), encVarintField(6, 24))),
            encBytesField(20, concatBytes(encVarintField(2, 0), encBytesField(4, subCid)))
          ),
          encBytesField(20, encBytesField(1, 'Subagent report'))
        );
    } finally {
      subDb.close();
    }

    // 4. Side Question .db (most recent timestamp! Has 1 cloned parent step + 1 own step with 95,000 context tokens)
    const sqDb = new DatabaseSync(path.join(convDir, `${sqCid}.db`));
    try {
      createConversationSchema(sqDb);
      sqDb
        .prepare('INSERT INTO trajectory_meta (trajectory_id, cascade_id, trajectory_type, source) VALUES (?, ?, ?, ?)')
        .run('traj-sq', sqCid, 22, 1);
      // Real Antigravity SIDE_QUESTION DBs store root_conversation_id = sqCid (itself) in trajectory_metadata_blob!
      sqDb
        .prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)')
        .run('main', encBytesField(6, sqCid));
      sqDb
        .prepare('INSERT INTO parent_references (idx, data) VALUES (?, ?)')
        .run(0, concatBytes(encVarintField(2, 0), encVarintField(5, 2), encBytesField(6, rootCid)));
      // Cloned parent step 0 (40,500 tokens — MUST NOT be double-counted!)
      sqDb
        .prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)')
        .run(
          0,
          15,
          3,
          concatBytes(
            encBytesField(1, encTimestamp(1794800001n, 0)),
            encBytesField(7, encTimestamp(1794800006n, 0)),
            encBytesField(9, concatBytes(encVarintField(1, 1437), encVarintField(2, 10000), encVarintField(3, 500), encVarintField(5, 30000))),
            encBytesField(20, concatBytes(encVarintField(2, 0), encBytesField(4, rootCid)))
          )
        );
      // Genuine Side Question step 1 (newest step at t=1794800035, 3,000 input + 100 output = 3,100 tokens, context = 95,000)
      sqDb
        .prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)')
        .run(
          1,
          15,
          3,
          concatBytes(
            encBytesField(1, encTimestamp(1794800030n, 0)),
            encBytesField(7, encTimestamp(1794800035n, 0)),
            encBytesField(9, concatBytes(encVarintField(1, 1418), encVarintField(2, 3000), encVarintField(3, 100), encVarintField(6, 24))),
            encBytesField(20, concatBytes(encVarintField(2, 1), encBytesField(4, sqCid)))
          ),
          encBytesField(20, encBytesField(1, 'WAL readers do not block writers.'))
        );
      const sqGm = concatBytes(
        encBytesField(
          1,
          concatBytes(
            encVarintField(3, 1418),
            encBytesField(4, concatBytes(encVarintField(1, 1418), encVarintField(2, 3000), encVarintField(3, 100))),
            encBytesField(
              9,
              encBytesField(
                10,
                concatBytes(
                  encVarintField(1, 95000),
                  encBytesField(3, encBytesField(1, concatBytes(encBytesField(1, 'Chat Messages'), encVarintField(2, 7), encVarintField(4, 95000)))),
                  encVarintField(4, 256000)
                )
              )
            ),
            encBytesField(19, 'gemini-4-argon-b'),
            encBytesField(20, encMapEntry('cascade_id', sqCid))
          )
        ),
        encBytesField(2, encVarint(1))
      );
      sqDb.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(0, sqGm, sqGm.length);
    } finally {
      sqDb.close();
    }

    // 5. Empty 0-own-step Side Question .db (only cloned parent step -> must be suppressed from child list!)
    const emptySqDb = new DatabaseSync(path.join(convDir, `${emptySqCid}.db`));
    try {
      createConversationSchema(emptySqDb);
      emptySqDb
        .prepare('INSERT INTO trajectory_meta (trajectory_id, cascade_id, trajectory_type, source) VALUES (?, ?, ?, ?)')
        .run('traj-sq-empty', emptySqCid, 22, 1);
      emptySqDb
        .prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)')
        .run(
          0,
          15,
          3,
          concatBytes(
            encBytesField(1, encTimestamp(1794800001n, 0)),
            encBytesField(9, concatBytes(encVarintField(1, 1437), encVarintField(2, 10000), encVarintField(3, 500))),
            encBytesField(20, concatBytes(encVarintField(2, 0), encBytesField(4, rootCid)))
          )
        );
    } finally {
      emptySqDb.close();
    }

    // Pre-populate legacy non-sqlite cache with inflated Side Question steps to verify automatic purge!
    const h = backendHarness({
      useRealSqlite: true,
      homeDir: tmpHome,
      cache: {
        [sqCid]: {
          signature: 'v10-model-identity:disk:1',
          steps: [
            { stepIndex: 0, modelKey: 'MODEL_PLACEHOLDER_M437', inputTokens: 999999, cacheReadTokens: 0, outputTokens: 1000 },
          ],
        },
      },
    });

    const p = await h.buildTelemetryPayloadInternal('');

    // Zero trajectory RPCs ever sent to language_server!
    const rpcMethods = h.state.calls.map((c) => c.method);
    assert.equal(rpcMethods.includes('GetAllCascadeTrajectories'), false);
    assert.equal(rpcMethods.includes('GetCascadeTrajectory'), false);

    // Top-level conversation list has ONLY rootCid (no subagent or Side Question hex orphans, and emptySqCid is hidden)
    assert.equal(p.conversations.length, 1);
    assert.equal(p.conversations[0].cascadeId, rootCid);
    assert.equal(p.conversations[0].subagentCount, 2); // 1 real subagent + 1 non-empty Side Question!

    // Exact total token accounting without cloned parent double-counting:
    // root (10000 + 30000 + 500 = 40500) + sub (5250) + sq own (3100) = 48,850 tokens!
    assert.equal(p.consumption.account.totalTokens, 48850);
    assert.equal(p.consumption.session.totalTokens, 48850);
    assert.equal(p.consumption.account.calls, 3);

    // Child badges & labels: 子1 (Schema Auditor) first, then 旁1 (WAL 并发锁机制提问)
    const agents = p.activeConversation.agents;
    assert.equal(agents.length, 3);
    assert.equal(agents[1].badgeText, '子1');
    assert.equal(agents[1].shortLabel, '子代理 #1');
    assert.equal(agents[1].role, 'Schema Auditor');
    assert.equal(agents[2].badgeText, '旁1');
    assert.equal(agents[2].shortLabel, '旁路提问 #1');
    assert.equal(agents[2].role, 'WAL 并发锁机制提问');
    assert.equal(agents[2].context.totalTokens, 95000);

    // Aggregated view protects mainline context (42,000 or subagent mainline, NOT overwritten by Side Question's 95,000!)
    assert.equal(p.activeConversation.aggregated.role, '主代理 + 1 子代理 + 1 旁问');
    assert.notEqual(p.activeConversation.aggregated.context.totalTokens, 95000);
    assert.equal(agents[0].context.totalTokens, 42000);
  } finally {
    resetSqliteReaderCaches();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
