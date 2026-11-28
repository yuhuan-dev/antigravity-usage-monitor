import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  encodeProtoBytesField,
  encodeProtoStringField,
  encodeProtoVarintField,
  filterSummaryProtoIndex,
  parseSummaryProtoIndexIds,
} from '../backend/proto-wire.mjs';
import {
  classifyRunningClientsFromProcesses,
  SESSION_CLIENT_DEFS,
  sumVerifiedDirTreeBytes,
} from '../backend/session-store.mjs';
import {
  cleanClientSessionsBatch,
  recoverPendingCleanups,
} from '../backend/session-cleaner.mjs';
import {
  clearOnlineDeleteEndpointCache,
  resolveClientOnlineDeleteEndpoint,
} from '../backend/session-online-delete.mjs';
import {
  clearSessionManagerScanCaches,
  deleteLocalSessions,
  deleteLocalSessionsAsync,
  previewSessionCleanup,
  previewSessionCleanupAsync,
  scanLocalSessions,
  scanLocalSessionsAsync,
  sweepLedgerPrivacy,
} from '../backend/session-manager.mjs';
import { revealLocalSessionPath } from '../backend/file-exporter.mjs';
import { dispatchBridgeApiRequest } from '../backend/api-actions.mjs';
import { createTrajectoryCacheStore } from '../backend/trajectory-cache-store.mjs';
import { createMockDom } from './mock-dom.mjs';

function initRichSummaryDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id text PRIMARY KEY,
      title text NOT NULL DEFAULT "",
      preview text NOT NULL DEFAULT "",
      step_count integer NOT NULL DEFAULT 0,
      last_modified_time datetime NOT NULL,
      workspace_uris text NOT NULL DEFAULT "",
      status text NOT NULL DEFAULT "",
      source text NOT NULL DEFAULT "",
      project_id text NOT NULL DEFAULT "",
      agent_name text NOT NULL DEFAULT "",
      parent_conversation_id text NOT NULL DEFAULT "",
      nesting_depth integer NOT NULL DEFAULT 0,
      not_fully_idle numeric NOT NULL DEFAULT false,
      killed numeric NOT NULL DEFAULT false,
      last_user_input_time datetime NOT NULL DEFAULT "",
      last_user_input_step_index integer NOT NULL DEFAULT -1,
      app_data_dir text NOT NULL DEFAULT "",
      raw_summary blob
    );
    CREATE VIRTUAL TABLE conversations_fts USING fts5(conversation_id UNINDEXED, title, preview);
    CREATE TABLE conversation_parents (
      conversation_id text PRIMARY KEY,
      parent_id text NOT NULL
    );
  `);
  return db;
}

function createMinimalConvDb(
  dbPath,
  {
    cid,
    tid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    trajectoryType = 4,
    source = 1,
    wsUri = 'file:///F:/demo-repo',
    parentConversationId = '',
    nestingDepth = 0,
    subagentSpec = null,
    userText = 'Hello assistant',
    assistantText = 'Hello user!',
    emptySteps = false,
  }
) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE trajectory_meta (
      trajectory_id text PRIMARY KEY,
      cascade_id text,
      trajectory_type integer,
      source integer
    );
    CREATE TABLE steps (
      idx integer PRIMARY KEY,
      step_type integer NOT NULL DEFAULT 0,
      status integer NOT NULL DEFAULT 3,
      metadata blob,
      step_payload blob
    );
    CREATE TABLE gen_metadata (idx integer PRIMARY KEY, data blob, size integer NOT NULL DEFAULT 0);
    CREATE TABLE trajectory_metadata_blob (id text PRIMARY KEY DEFAULT "main", data blob);
  `);
  db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, ?, ?)').run(tid, cid, trajectoryType, source);
  const metaParts = [encodeProtoStringField(6, cid), encodeProtoStringField(7, wsUri)];
  if (parentConversationId) metaParts.push(encodeProtoStringField(5, parentConversationId));
  if (nestingDepth > 0) metaParts.push(encodeProtoVarintField(17, nestingDepth));
  if (subagentSpec) {
    const sp = [];
    if (subagentSpec.typeName) sp.push(encodeProtoStringField(1, subagentSpec.typeName));
    if (subagentSpec.role) sp.push(encodeProtoStringField(2, subagentSpec.role));
    metaParts.push(encodeProtoBytesField(8, Buffer.concat(sp)));
  }
  db.prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)").run(Buffer.concat(metaParts));

  if (!emptySteps) {
    const userPayload = encodeProtoBytesField(19, encodeProtoStringField(2, userText));
    const asstPayload = encodeProtoBytesField(20, encodeProtoStringField(1, assistantText));
    db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (0, 14, ?)').run(userPayload);
    db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (1, 15, ?)').run(asstPayload);
  }
  db.close();
}

function makeProtoSummaryEntry(fieldNum, id, isTimestamp = false) {
  const inner = isTimestamp
    ? Buffer.concat([encodeProtoStringField(1, id), encodeProtoVarintField(2, 1795000000)])
    : Buffer.concat([encodeProtoStringField(1, id), encodeProtoBytesField(2, Buffer.from([0x0a, 0x02, 0x6f, 0x6b]))]);
  return encodeProtoBytesField(fieldNum, inner);
}

test('strict protobuf summary index parsing and filtering preserves unknown fields and rejects malformed/embedded-target bytes', () => {
  const idA = '11111111-1111-4111-8111-111111111111';
  const idB = '22222222-2222-4222-8222-222222222222';
  const unknownSafeField = encodeProtoBytesField(9, Buffer.from('opaque-header-v2', 'utf8'));

  const deskBuf = Buffer.concat([
    makeProtoSummaryEntry(1, idA, false),
    makeProtoSummaryEntry(1, idB, false),
    makeProtoSummaryEntry(2, idA, true),
    makeProtoSummaryEntry(2, idB, true),
    unknownSafeField,
  ]);

  const parsedIds = parseSummaryProtoIndexIds(deskBuf, { isDesktop: true, strict: true });
  assert.deepEqual([...parsedIds].sort(), [idA, idB]);

  const filtered = filterSummaryProtoIndex(deskBuf, new Set([idA]), { isDesktop: true });
  assert.equal(filtered.changed, true);
  assert.equal(filtered.removedCount, 2, 'Removes both tag 10 and desktop tag 18 entries for idA');
  const afterIds = parseSummaryProtoIndexIds(filtered.buffer, { isDesktop: true, strict: true });
  assert.deepEqual([...afterIds], [idB]);
  assert.ok(filtered.buffer.includes(unknownSafeField), 'Preserves unrelated unknown field byte-for-byte');

  // Unknown field mentioning target UUID must throw instead of silently leaking/corrupting
  const dangerousBuf = Buffer.concat([
    makeProtoSummaryEntry(1, idA, false),
    encodeProtoStringField(9, `refs:${idA}`),
  ]);
  assert.throws(
    () => filterSummaryProtoIndex(dangerousBuf, new Set([idA]), { isDesktop: true }),
    /Unsupported summary protobuf field/
  );

  // Truncated/malformed varint must throw in strict mode
  assert.throws(
    () => filterSummaryProtoIndex(Buffer.from([0x0a, 0x80, 0x80]), new Set([idA]), { isDesktop: false }),
    /Truncated protobuf/
  );
});

test('classifyRunningClientsFromProcesses accurately separates desktop, cli, ide_legacy and ignores plugin node processes', () => {
  assert.deepEqual(
    classifyRunningClientsFromProcesses([
      { name: 'node.exe', exe: 'C:\\Program Files\\nodejs\\node.exe', cmd: 'node F:\\antigravity-usage-monitor\\sidecars\\panel\\standalone.mjs' },
    ]),
    { desktop: false, cli: false, ide_legacy: false },
    'Never misclassifies Usage Monitor standalone/sidecar Node process as desktop host'
  );

  assert.deepEqual(
    classifyRunningClientsFromProcesses([
      { name: 'Antigravity.exe', exe: 'C:\\Users\\Me\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe', cmd: 'Antigravity.exe' },
    ]),
    { desktop: true, cli: false, ide_legacy: false }
  );

  assert.deepEqual(
    classifyRunningClientsFromProcesses([
      { name: 'language_server_windows_x64.exe', exe: 'C:\\bin\\language_server_windows_x64.exe', cmd: '--app_data_dir antigravity-cli --port 1234' },
      { name: 'Antigravity-IDE.exe', exe: 'C:\\Programs\\Antigravity-IDE\\Antigravity-IDE.exe', cmd: '' },
    ]),
    { desktop: false, cli: true, ide_legacy: true }
  );
});

test('three-client scan, /fork vs subagent, telemetry enrichment, and 3-tier message reader with step_index overwrite', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'ag-smgr-scan-'));
  const geminiDir = join(tempRoot, '.gemini');
  const ledgerDbPath = join(tempRoot, 'trajectory_store.sqlite');

  try {
    const deskRoot = join(geminiDir, 'antigravity');
    const cliRoot = join(geminiDir, 'antigravity-cli');
    const ideRoot = join(geminiDir, 'antigravity-ide');
    for (const r of [deskRoot, cliRoot, ideRoot]) {
      mkdirSync(join(r, 'conversations'), { recursive: true });
      mkdirSync(join(r, 'brain'), { recursive: true });
      mkdirSync(join(r, 'annotations'), { recursive: true });
      mkdirSync(join(r, 'cache'), { recursive: true });
    }

    const deskRootId = '11111111-1111-4111-8111-111111111101';
    const deskSubId = '11111111-1111-4111-8111-111111111102';
    const deskForkId = '11111111-1111-4111-8111-111111111103';
    const deskEmptyId = '11111111-1111-4111-8111-111111111104';
    const cliIndexOnlyId = '22222222-2222-4222-8222-222222222201';
    const ideLegacyId = '33333333-3333-4333-8333-333333333301';

    createMinimalConvDb(join(deskRoot, 'conversations', `${deskRootId}.db`), { cid: deskRootId });
    createMinimalConvDb(join(deskRoot, 'conversations', `${deskSubId}.db`), {
      cid: deskSubId,
      parentConversationId: deskRootId,
      nestingDepth: 1,
      subagentSpec: { typeName: 'research', role: 'Auditor' },
    });
    createMinimalConvDb(join(deskRoot, 'conversations', `${deskForkId}.db`), {
      cid: deskForkId,
      parentConversationId: deskRootId,
      nestingDepth: 0,
    });
    createMinimalConvDb(join(deskRoot, 'conversations', `${deskEmptyId}.db`), {
      cid: deskEmptyId,
      emptySteps: true,
    });
    createMinimalConvDb(join(ideRoot, 'conversations', `${ideLegacyId}.db`), {
      cid: ideLegacyId,
      userText: '<USER_REQUEST>Explain legacy IDE fallback</USER_REQUEST><SYSTEM_REMINDER>hidden</SYSTEM_REMINDER>',
      assistantText: 'Legacy SQLite steps decoded cleanly.',
    });

    // Write transcript_full.jsonl for deskRootId testing step_index overwrite, thought filtering, and file:// extraction
    const logsDir = join(deskRoot, 'brain', deskRootId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const transcriptLines = [
      JSON.stringify({
        step_index: 1,
        role: 'user',
        content: '<CONTEXT_SUMMARY>old</CONTEXT_SUMMARY><USER_REQUEST>Inspect app.js</USER_REQUEST><ADDITIONAL_METADATA>meta</ADDITIONAL_METADATA>',
      }),
      JSON.stringify({ step_index: 2, role: 'assistant', content: 'Draft answer that becomes a tool call' }),
      JSON.stringify({ step_index: 2, type: 'TOOL_CALL', content: 'read_file' }),
      JSON.stringify({ step_index: 3, role: 'assistant', thought: true, content: 'Secret reasoning' }),
      JSON.stringify({ step_index: 4, type: 'TOOL_RESULT', content: 'raw tool output' }),
      JSON.stringify({
        step_index: 5,
        role: 'assistant',
        content: 'See [main](file:///F:/demo-repo/index.js#L12) for details.',
      }),
    ];
    writeFileSync(join(logsDir, 'transcript_full.jsonl'), `${transcriptLines.join('\n')}\n`, 'utf8');

    const deskSum = initRichSummaryDb(join(deskRoot, 'conversation_summaries.db'));
    const insDesk = deskSum.prepare(
      `INSERT INTO conversation_summaries (
        conversation_id, title, preview, step_count, last_modified_time,
        workspace_uris, status, parent_conversation_id, nesting_depth, app_data_dir
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insDesk.run(deskRootId, 'Main Desktop Session', 'preview', 6, '2026-11-25 10:00:00+00:00', '["file:///f%3A/demo-repo"]', 'CASCADE_RUN_STATUS_IDLE', '', 0, 'antigravity');
    insDesk.run(deskSubId, 'Hidden Subagent', '', 2, '2026-11-25 09:59:00+00:00', '["file:///f%3A/demo-repo"]', 'CASCADE_RUN_STATUS_IDLE', deskRootId, 1, 'antigravity');
    insDesk.run(deskForkId, 'Forked Branch', '', 4, '2026-11-25 10:05:00+00:00', '["file:///f%3A/demo-repo"]', 'CASCADE_RUN_STATUS_IDLE', deskRootId, 0, 'antigravity');
    deskSum.close();

    // CLI index-only entry via jetbox_summaries_proto.pb + metadata cache
    writeFileSync(join(cliRoot, 'jetbox_summaries_proto.pb'), makeProtoSummaryEntry(1, cliIndexOnlyId, false));
    writeFileSync(
      join(cliRoot, 'cache', 'conversation_metadata.json'),
      JSON.stringify({ conversations: { [cliIndexOnlyId]: { summary: { Title: 'Ghost CLI Entry' } } } }),
      'utf8'
    );

    // Seed Usage Monitor ledger with telemetry for deskRootId
    const cacheStore = createTrajectoryCacheStore({ sqliteFilePath: ledgerDbPath, enableSqlite: true });
    cacheStore.setCachedTrajectory(deskRootId, {
      title: 'Main Desktop Session',
      appSource: 'standalone',
      steps: [
        {
          stepIndex: 1,
          createdAtMs: 1795000000000,
          modelKey: 'MODEL_CLAUDE_4_5_SONNET',
          inputTokens: 12000,
          cacheReadTokens: 8000,
          outputTokens: 1500,
          isComplete: true,
        },
      ],
    });
    cacheStore.flushTrajectoryCacheNow();

    const scan = scanLocalSessions({
      geminiDir,
      cacheStore,
      runningClientsOverride: { desktop: true, cli: false, ide_legacy: false, checked: true },
    });

    assert.equal(scan.ok, true);
    const ids = scan.sessions.map((s) => s.sessionId);
    assert.ok(ids.includes(deskRootId), 'Includes desktop root');
    assert.ok(ids.includes(deskForkId), 'Includes /fork session as first-class root');
    assert.ok(ids.includes(cliIndexOnlyId), 'Includes CLI index-only entry');
    assert.ok(ids.includes(ideLegacyId), 'Includes legacy IDE session on equal footing');
    assert.equal(ids.includes(deskSubId), false, 'Hides nested subagent under parent');
    assert.equal(ids.includes(deskEmptyId), false, 'Filters empty unindexed shell .db');

    const rootItem = scan.sessions.find((s) => s.sessionId === deskRootId);
    assert.equal(rootItem.subagentCount, 1);
    assert.equal(rootItem.canDelete, false, 'Running desktop client blocks deletion');
    assert.equal(rootItem.telemetry.recorded, true);
    assert.equal(rootItem.telemetry.totalTokens, 21500);

    const forkItem = scan.sessions.find((s) => s.sessionId === deskForkId);
    assert.equal(forkItem.isFork, true);

    const cliItem = scan.sessions.find((s) => s.sessionId === cliIndexOnlyId);
    assert.equal(cliItem.indexOnly, true);
    assert.equal(cliItem.canDelete, true, 'Idle CLI client allows deletion even when Desktop is running');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('transactional delete cascades subagents, preserves /fork, cleans all indexes/app_storage/caches, guards running clients & migration archives, and live-redacts ledger without token/cost drift', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'ag-smgr-clean-'));
  const geminiDir = join(tempRoot, '.gemini');
  const backupDir = join(tempRoot, 'backups');
  const appDataDir = join(tempRoot, 'AppData', 'Antigravity');
  const ledgerDbPath = join(tempRoot, 'trajectory_store.sqlite');
  const legacyCachePath = join(tempRoot, 'trajectory_usage_cache.json');
  const legacyBakPath = `${legacyCachePath}.bak`;

  try {
    const deskRoot = join(geminiDir, 'antigravity');
    const cliRoot = join(geminiDir, 'antigravity-cli');
    for (const r of [deskRoot, cliRoot]) {
      mkdirSync(join(r, 'conversations'), { recursive: true });
      mkdirSync(join(r, 'brain'), { recursive: true });
      mkdirSync(join(r, 'annotations'), { recursive: true });
      mkdirSync(join(r, 'presence'), { recursive: true });
      mkdirSync(join(r, 'cache'), { recursive: true });
      mkdirSync(join(r, 'logs'), { recursive: true });
      mkdirSync(join(r, 'sidecar_data', 'demo', 'panel', 'events'), { recursive: true });
    }
    mkdirSync(join(appDataDir, 'Cache'), { recursive: true });
    mkdirSync(join(appDataDir, 'Code Cache'), { recursive: true });
    writeFileSync(join(appDataDir, 'Cache', 'blob'), 'x', 'utf8');
    writeFileSync(join(appDataDir, 'Code Cache', 'js'), 'y', 'utf8');

    const parentId = '55555555-5555-4555-8555-555555555501';
    const subId = '55555555-5555-4555-8555-555555555502';
    const forkId = '55555555-5555-4555-8555-555555555503';
    const protectedId = '55555555-5555-4555-8555-555555555504';
    const sshId = '55555555-5555-4555-8555-555555555505';
    const keepCliId = '66666666-6666-4666-8666-666666666601';

    // Desktop artifacts
    createMinimalConvDb(join(deskRoot, 'conversations', `${parentId}.db`), { cid: parentId });
    createMinimalConvDb(join(deskRoot, 'conversations', `${subId}.db`), {
      cid: subId,
      parentConversationId: parentId,
      nestingDepth: 1,
    });
    createMinimalConvDb(join(deskRoot, 'conversations', `${forkId}.db`), {
      cid: forkId,
      parentConversationId: parentId,
      nestingDepth: 0,
    });
    mkdirSync(join(deskRoot, 'brain', parentId), { recursive: true });
    writeFileSync(join(deskRoot, 'brain', parentId, 'note.md'), 'secret', 'utf8');
    mkdirSync(join(deskRoot, 'brain', subId), { recursive: true });
    mkdirSync(join(deskRoot, 'brain', forkId), { recursive: true });
    // Protected migrated source: no live .db, has brain + archived-sources/<desktop>/<protectedId>_ts.db
    mkdirSync(join(deskRoot, 'brain', protectedId), { recursive: true });
    writeFileSync(join(deskRoot, 'brain', protectedId, 'img.png'), 'png', 'utf8');
    mkdirSync(join(backupDir, 'archived-sources', 'desktop'), { recursive: true });
    writeFileSync(join(backupDir, 'archived-sources', 'desktop', `${protectedId}_2026.db`), 'bak', 'utf8');
    writeFileSync(join(deskRoot, 'annotations', `${protectedId}.pbtxt`), 'title:"Migrated Src"\n', 'utf8');

    // Sidecar events: one for parentId, one for /fork (must be preserved!)
    writeFileSync(
      join(deskRoot, 'sidecar_data', 'demo', 'panel', 'events', 'evt-parent.json'),
      JSON.stringify({ payload: { conversationMetadata: { conversationId: parentId, metadata: { rootConversationId: parentId, nestingDepth: 0 } } } }),
      'utf8'
    );
    writeFileSync(
      join(deskRoot, 'sidecar_data', 'demo', 'panel', 'events', 'evt-fork.json'),
      JSON.stringify({ payload: { conversationMetadata: { conversationId: forkId, metadata: { rootConversationId: forkId, parentConversationId: parentId, nestingDepth: 0 } } } }),
      'utf8'
    );
    writeFileSync(join(deskRoot, 'logs', 'sidecar.log'), `keep line\ndelete ${parentId} line\nkeep2\n`, 'utf8');

    const deskSum = initRichSummaryDb(join(deskRoot, 'conversation_summaries.db'));
    const ins = deskSum.prepare(
      `INSERT INTO conversation_summaries (
        conversation_id, title, preview, step_count, last_modified_time,
        parent_conversation_id, nesting_depth, app_data_dir
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    ins.run(parentId, 'Top Secret Parent', 'SecretWordXYZ', 4, '2026-11-25 10:00:00+00:00', '', 0, 'antigravity');
    ins.run(subId, 'Nested Child', 'ChildWordXYZ', 2, '2026-11-25 10:00:00+00:00', parentId, 1, 'antigravity');
    ins.run(forkId, 'Fork Keep', 'ForkWordKeep', 4, '2026-11-25 10:01:00+00:00', parentId, 0, 'antigravity');
    deskSum.prepare('INSERT INTO conversations_fts (conversation_id, title, preview) VALUES (?, ?, ?)').run(parentId, 'Top Secret Parent', 'SecretWordXYZ');
    deskSum.prepare('INSERT INTO conversations_fts (conversation_id, title, preview) VALUES (?, ?, ?)').run(forkId, 'Fork Keep', 'ForkWordKeep');
    deskSum.prepare('INSERT INTO conversation_parents VALUES (?, ?)').run(subId, parentId);
    deskSum.close();

    writeFileSync(
      join(deskRoot, 'agyhub_summaries_proto.pb'),
      Buffer.concat([
        makeProtoSummaryEntry(1, parentId, false),
        makeProtoSummaryEntry(2, parentId, true),
        makeProtoSummaryEntry(1, forkId, false),
      ])
    );

    // CLI has a cross-client index-only mirror of parentId + a live keepCliId + history.jsonl
    writeFileSync(
      join(cliRoot, 'jetbox_summaries_proto.pb'),
      Buffer.concat([makeProtoSummaryEntry(1, parentId, false), makeProtoSummaryEntry(1, keepCliId, false)])
    );
    createMinimalConvDb(join(cliRoot, 'conversations', `${keepCliId}.db`), { cid: keepCliId });
    const historyKeepRaw = `{"conversationId":"${keepCliId}","prompt":"keep exact bytes"}\r\n`;
    const historyDropRaw = `{"conversationId":"${parentId}","prompt":"drop me"}\r\n`;
    writeFileSync(join(cliRoot, 'history.jsonl'), `${historyKeepRaw}${historyDropRaw}`, 'utf8');

    // app_storage.json referencing parentId and forkId
    writeFileSync(
      join(appDataDir, 'app_storage.json'),
      JSON.stringify({
        [`antigravity-multi-conversation-layout-v3-${parentId}`]: '{"open":true}',
        [`antigravity-multi-conversation-layout-v3-${forkId}`]: '{"open":true}',
        'antigravity-multi-conversation-layout-v3-index': JSON.stringify([parentId, forkId]),
        'aux-pane-v2-session': JSON.stringify({ conversationPanes: { [parentId]: { tab: 1 }, [forkId]: { tab: 2 } } }),
      }),
      'utf8'
    );

    // Seed SQLite ledger + .json.bak with parentId, forkId, and remote sshId
    writeFileSync(
      legacyBakPath,
      JSON.stringify({
        [parentId]: {
          title: 'Top Secret Parent',
          steps: [{ inputTokens: 500, outputTokens: 100, turnPrompt: 'My private API key prompt' }],
        },
        [forkId]: {
          title: 'Fork Keep',
          steps: [{ inputTokens: 200, outputTokens: 50, turnPrompt: 'Fork prompt stays' }],
        },
      }),
      'utf8'
    );

    const cacheStore = createTrajectoryCacheStore({
      cacheFilePath: legacyCachePath,
      sqliteFilePath: ledgerDbPath,
      enableSqlite: true,
    });
    cacheStore.setCachedTrajectory(parentId, {
      title: 'Top Secret Parent',
      appSource: 'standalone',
      swarmMeta: { title: 'Secret Swarm' },
      subagentSpec: { typeName: 'side_question', role: 'Private Q', initialPrompt: 'Secret initial' },
      steps: [
        {
          stepIndex: 0,
          createdAtMs: 1795000000000,
          modelKey: 'MODEL_CLAUDE_4_5_SONNET',
          inputTokens: 5000,
          cacheReadTokens: 1000,
          outputTokens: 800,
          turnPrompt: 'Sensitive user prompt',
          turnPromptClean: 'Sensitive user prompt',
          userPrompt: 'Sensitive user prompt',
          isComplete: true,
        },
      ],
    });
    cacheStore.setCachedTrajectory(forkId, {
      title: 'Fork Keep',
      appSource: 'standalone',
      steps: [{ stepIndex: 0, createdAtMs: 1795000001000, inputTokens: 100, outputTokens: 20, turnPrompt: 'Fork prompt' }],
    });
    cacheStore.setCachedTrajectory(sshId, {
      title: 'Remote SSH Task',
      appSource: 'ssh',
      steps: [{ stepIndex: 0, createdAtMs: 1795000002000, inputTokens: 300, outputTokens: 40, turnPrompt: 'SSH prompt' }],
    });
    cacheStore.flushTrajectoryCacheNow();

    // 1. Running desktop blocks deletion
    const blocked = deleteLocalSessions(
      { targets: [{ clientId: 'desktop', sessionId: parentId }] },
      { geminiDir, backupDir, electronAppDataDir: appDataDir, cacheStore, runningClientsOverride: { desktop: true, cli: false, ide_legacy: false, checked: true } }
    );
    assert.equal(blocked.ok, false);
    assert.equal(blocked.failed[0].error, 'client_running');
    assert.equal(existsSync(join(deskRoot, 'conversations', `${parentId}.db`)), true);

    // 2. Preview when all clients are idle
    const idleClients = { desktop: false, cli: false, ide_legacy: false, checked: true };
    const prev = previewSessionCleanup(
      { targets: [{ clientId: 'desktop', sessionId: parentId }, { clientId: 'desktop', sessionId: protectedId }] },
      { geminiDir, backupDir, runningClientsOverride: idleClients }
    );
    assert.equal(prev.deletableCount, 2);
    assert.equal(prev.cascadeSubagentCount, 1);
    assert.equal(prev.crossSourceIndexMatches.length, 1);
    assert.equal(prev.crossSourceIndexMatches[0].clientId, 'cli');
    assert.equal(prev.protectedMigrationItems.length, 1);

    // 3. Execute deletion with ledger redaction + browser cache clear
    const delRes = deleteLocalSessions(
      {
        targets: [
          { clientId: 'desktop', sessionId: parentId },
          { clientId: 'desktop', sessionId: protectedId },
        ],
        redactLedger: true,
        clearBrowserCache: true,
      },
      { geminiDir, backupDir, electronAppDataDir: appDataDir, cacheStore, runningClientsOverride: idleClients }
    );
    assert.equal(delRes.ok, true);
    assert.equal(delRes.deletedCount, 2);
    assert.equal(delRes.cascadeSubagentCount, 1);
    assert.equal(delRes.crossOrphanCleanedCount, 1);
    assert.deepEqual(delRes.protectedBrainKept, [protectedId]);
    assert.equal(delRes.ledgerRedaction.redactedConversations, 1);

    // Verify parent & nested subagent deleted, /fork & protected brain preserved
    assert.equal(existsSync(join(deskRoot, 'conversations', `${parentId}.db`)), false);
    assert.equal(existsSync(join(deskRoot, 'conversations', `${subId}.db`)), false);
    assert.equal(existsSync(join(deskRoot, 'brain', parentId)), false);
    assert.equal(existsSync(join(deskRoot, 'brain', subId)), false);
    assert.equal(existsSync(join(deskRoot, 'conversations', `${forkId}.db`)), true, '/fork must NOT be cascaded');
    assert.equal(existsSync(join(deskRoot, 'sidecar_data', 'demo', 'panel', 'events', 'evt-parent.json')), false);
    assert.equal(existsSync(join(deskRoot, 'sidecar_data', 'demo', 'panel', 'events', 'evt-fork.json')), true);
    assert.equal(existsSync(join(deskRoot, 'brain', protectedId, 'img.png')), true, 'Protected migration archive preserves source brain media');

    // Verify FTS5 rebuild, proto index, CLI cross-client residual, history.jsonl, app_storage.json, and caches
    const checkDeskSum = new DatabaseSync(join(deskRoot, 'conversation_summaries.db'), { readOnly: true });
    assert.equal(checkDeskSum.prepare("SELECT count(*) AS c FROM conversations_fts WHERE conversations_fts MATCH 'SecretWordXYZ'").get().c, 0);
    assert.equal(checkDeskSum.prepare('SELECT count(*) AS c FROM conversation_parents').get().c, 0);
    checkDeskSum.close();

    const cliProtoAfter = parseSummaryProtoIndexIds(readFileSync(join(cliRoot, 'jetbox_summaries_proto.pb')));
    assert.equal(cliProtoAfter.has(parentId), false);
    assert.equal(cliProtoAfter.has(keepCliId), true);

    const appStorageAfter = JSON.parse(readFileSync(join(appDataDir, 'app_storage.json'), 'utf8'));
    assert.equal(appStorageAfter[`antigravity-multi-conversation-layout-v3-${parentId}`], undefined);
    assert.ok(appStorageAfter[`antigravity-multi-conversation-layout-v3-${forkId}`]);
    assert.deepEqual(JSON.parse(appStorageAfter['antigravity-multi-conversation-layout-v3-index']), [forkId]);
    assert.equal(existsSync(join(appDataDir, 'Cache')), false);
    assert.equal(existsSync(join(appDataDir, 'Code Cache')), false);

    // Verify ledger redaction preserved 100% of token accounting while scrubbing all prompts/titles and bumping epoch
    const hydratedParent = cacheStore.getHydratedTrajectory(parentId);
    assert.equal(hydratedParent.title, '[Deleted Session]');
    assert.equal(hydratedParent.archived, true);
    assert.equal(hydratedParent.swarmMeta.title, '[Deleted Session]');
    assert.equal(hydratedParent.subagentSpec.initialPrompt, undefined);
    assert.equal(hydratedParent.subagentSpec.role, '[Deleted Session]');
    assert.equal(hydratedParent.steps[0].inputTokens, 5000, 'Token accounting 100% preserved');
    assert.equal(hydratedParent.steps[0].outputTokens, 800, 'Output token accounting 100% preserved');
    assert.equal(hydratedParent.steps[0].turnPrompt, undefined, 'turnPrompt scrubbed');
    assert.equal(hydratedParent.steps[0].userPrompt, undefined, 'userPrompt scrubbed');

    // Verify live fork & remote SSH entries untouched even after sweepLedgerPrivacy
    const sweepRes = sweepLedgerPrivacy({ geminiDir, cacheStore });
    assert.equal(sweepRes.ok, true);
    assert.equal(cacheStore.getHydratedTrajectory(forkId).title, 'Fork Keep');
    assert.equal(cacheStore.getHydratedTrajectory(sshId).title, 'Remote SSH Task');

    // Verify .json.bak redacted cleanly
    const bakAfter = JSON.parse(readFileSync(legacyBakPath, 'utf8'));
    assert.equal(bakAfter[parentId].title, '[Deleted Session]');
    assert.equal(bakAfter[parentId].steps[0].turnPrompt, undefined);
    assert.equal(bakAfter[parentId].steps[0].inputTokens, 500);
    assert.equal(bakAfter[forkId].title, 'Fork Keep');

    // Verify SQLite epoch incremented
    const verifyLedger = new DatabaseSync(ledgerDbPath, { readOnly: true });
    const epochVal = Number(verifyLedger.prepare("SELECT value FROM ledger_meta WHERE key = 'ledger_epoch'").get().value);
    assert.ok(epochVal >= 2, `Expected ledger_epoch >= 2, got ${epochVal}`);
    verifyLedger.close();
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('two-phase crash recovery rolls back uncommitted stage and finishes committed stage cleanly', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'ag-smgr-recover-'));
  const geminiDir = join(tempRoot, '.gemini');
  const deskRoot = join(geminiDir, 'antigravity');
  const deskDef = SESSION_CLIENT_DEFS.find((d) => d.id === 'desktop');

  try {
    mkdirSync(join(deskRoot, 'conversations'), { recursive: true });
    mkdirSync(join(deskRoot, 'cache'), { recursive: true });
    const cidA = '77777777-7777-4777-8777-777777777701';
    const cidB = '77777777-7777-4777-8777-777777777702';
    createMinimalConvDb(join(deskRoot, 'conversations', `${cidA}.db`), { cid: cidA });
    createMinimalConvDb(join(deskRoot, 'conversations', `${cidB}.db`), { cid: cidB });
    writeFileSync(join(deskRoot, 'cache', 'last_conversations.json'), JSON.stringify({ '/a': cidA, '/b': cidB }), 'utf8');
    const sumDb = initRichSummaryDb(join(deskRoot, 'conversation_summaries.db'));
    sumDb.prepare('INSERT INTO conversation_summaries (conversation_id, title, last_modified_time) VALUES (?, ?, ?)').run(cidA, 'Session A', '2026-11-25 10:00:00+00:00');
    sumDb.prepare('INSERT INTO conversation_summaries (conversation_id, title, last_modified_time) VALUES (?, ?, ?)').run(cidB, 'Session B', '2026-11-25 10:00:00+00:00');
    sumDb.close();

    // 1. Simulate crash right before commit (inside normal call, rollback runs immediately)
    const beforeRes = cleanClientSessionsBatch({
      clientDef: deskDef,
      clientRoot: deskRoot,
      requestedIds: [cidA],
      geminiDir,
      onBeforeCommit: () => {
        throw new Error('simulated_crash_before_commit');
      },
    });
    assert.equal(beforeRes.succeeded.length, 0);
    assert.equal(existsSync(join(deskRoot, 'conversations', `${cidA}.db`)), true, 'Uncommitted failure restores .db');
    assert.equal(JSON.parse(readFileSync(join(deskRoot, 'cache', 'last_conversations.json'), 'utf8'))['/a'], cidA);

    // 2. Simulate hard kill AFTER commit marker written (leaving .um-clean-<id> directory on disk)
    let leakedStageDir = '';
    const afterRes = cleanClientSessionsBatch({
      clientDef: deskDef,
      clientRoot: deskRoot,
      requestedIds: [cidB],
      geminiDir,
      onAfterCommitBeforePurge: ({ stageDir }) => {
        leakedStageDir = stageDir;
        throw new Error('simulated_power_loss_after_commit');
      },
    });
    assert.equal(afterRes.succeeded.length, 0);
    assert.ok(leakedStageDir && existsSync(leakedStageDir), 'Committed stage directory remains until recovery');

    // Run recovery: must finish purging committed stage & keep cidB deleted
    const rec = recoverPendingCleanups(deskRoot, deskDef, { geminiDir });
    assert.ok(rec.recovered >= 1);
    assert.equal(existsSync(leakedStageDir), false, 'Recovery removes committed stage directory');
    assert.equal(existsSync(join(deskRoot, 'conversations', `${cidB}.db`)), false);
    assert.equal(existsSync(join(deskRoot, 'conversations', `${cidA}.db`)), true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('revealLocalSessionPath enforces strict whitelist boundaries and invokes OS file manager safely', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'ag-smgr-reveal-'));
  const storeRoot = join(tempRoot, 'antigravity');
  const projDir = join(tempRoot, 'my-project');
  const outsideFile = join(tempRoot, 'secret.txt');
  mkdirSync(join(storeRoot, 'conversations'), { recursive: true });
  mkdirSync(projDir, { recursive: true });
  const targetDb = join(storeRoot, 'conversations', '11111111-1111-4111-8111-111111111111.db');
  writeFileSync(targetDb, 'db', 'utf8');
  writeFileSync(outsideFile, 'secret', 'utf8');

  try {
    const calls = [];
    const fakeSpawn = (cmd, args) => {
      calls.push({ cmd, args });
      return { on() {}, unref() {} };
    };

    const okFile = revealLocalSessionPath(targetDb, {
      allowedRoots: [storeRoot],
      allowedPaths: [projDir],
      platform: 'win32',
      spawnFn: fakeSpawn,
    });
    assert.equal(okFile.ok, true);
    assert.equal(calls[0].cmd, 'explorer.exe');
    assert.ok(calls[0].args[0].startsWith('/select,'));

    const okDir = revealLocalSessionPath(projDir, {
      allowedRoots: [storeRoot],
      allowedPaths: [projDir],
      platform: 'darwin',
      spawnFn: fakeSpawn,
    });
    assert.equal(okDir.ok, true);
    assert.equal(okDir.isDirectory, true);
    assert.equal(calls[1].cmd, 'open');

    const denied = revealLocalSessionPath(outsideFile, {
      allowedRoots: [storeRoot],
      allowedPaths: [projDir],
      platform: 'win32',
      spawnFn: fakeSpawn,
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 403);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('SessionManagerCard supports Shift range multi-select, multi-dimensional sorting, UUID bypass, inline confirm, and zero native inputs', async () => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const { document: doc } = createMockDom();
  globalThis.document = doc;
  globalThis.window = { document: doc };

  try {
    const { SessionManagerCard } = await import('../src/components/settings/SessionManagerCard.js');

    const s1 = '88888888-8888-4888-8888-888888888801';
    const s2 = '88888888-8888-4888-8888-888888888802';
    const s3 = '88888888-8888-4888-8888-888888888803';
    const s4 = '88888888-8888-4888-8888-888888888804';
    const sBlocked = '88888888-8888-4888-8888-888888888805';
    let deletePayload = null;
    const now = Date.now();
    const mockSessions = [
      {
        sessionId: s1,
        cascadeId: s1,
        clientId: 'cli',
        title: 'Newest Tiny Cheap',
        workspaceName: 'repo',
        sizeBytes: 1024,
        lastModifiedMs: now - 1000,
        indexOnly: false,
        canDelete: true,
        clientRunning: false,
        subagentCount: 2,
        telemetry: { recorded: true, stepCount: 5, totalTokens: 5000, costUsd: 0.12, hasUsage: true },
      },
      {
        sessionId: sBlocked,
        cascadeId: sBlocked,
        clientId: 'desktop',
        title: 'Blocked Running Middle',
        workspaceName: 'repo',
        sizeBytes: 4096,
        lastModifiedMs: now - 2000,
        indexOnly: false,
        canDelete: false,
        sessionRunning: true,
        clientRunning: true,
        deleteBlockedReason: 'session_running',
        subagentCount: 0,
        telemetry: { recorded: true, stepCount: 2, totalTokens: 1000, costUsd: 0.01, hasUsage: true },
      },
      {
        sessionId: s3,
        cascadeId: s3,
        clientId: 'cli',
        title: 'Huge File Session',
        workspaceName: 'repo',
        sizeBytes: 50 * 1024 * 1024,
        lastModifiedMs: now - 3000,
        indexOnly: false,
        canDelete: true,
        clientRunning: false,
        subagentCount: 0,
        telemetry: { recorded: true, stepCount: 10, totalTokens: 90000, costUsd: 1.5, hasUsage: true },
      },
      {
        sessionId: s4,
        cascadeId: s4,
        clientId: 'cli',
        title: 'Oldest Costliest Session',
        workspaceName: 'repo',
        sizeBytes: 8192,
        lastModifiedMs: now - 9000,
        indexOnly: false,
        canDelete: true,
        clientRunning: false,
        subagentCount: 0,
        telemetry: { recorded: true, stepCount: 20, totalTokens: 40000, costUsd: 9.8, hasUsage: true },
      },
      {
        sessionId: s2,
        cascadeId: s2,
        clientId: 'ide_legacy',
        title: 'Stale Index Entry',
        workspaceName: 'old',
        sizeBytes: 0,
        lastModifiedMs: now - 5000,
        indexOnly: true,
        canDelete: true,
        clientRunning: false,
        subagentCount: 0,
        telemetry: { recorded: false, stepCount: 0, totalTokens: 0, costUsd: 0, hasUsage: false },
      },
    ];

    const card = SessionManagerCard({
      loadList: async () => ({
        ok: true,
        clients: [
          { id: 'desktop', exists: true, running: true, onlineDeleteSupported: true, sessionCount: 1 },
          { id: 'cli', exists: true, running: false, sessionCount: 3 },
          { id: 'ide_legacy', exists: true, running: false, sessionCount: 1 },
        ],
        runningClients: { desktop: true, cli: false, ide_legacy: false, checked: true },
        onlineDeleteClients: { desktop: true, cli: false, ide_legacy: false },
        sessions: mockSessions,
        counts: { total: 5, indexOnly: 1, byClient: { desktop: 1, cli: 3, ide_legacy: 1 } },
        warnings: [],
      }),
      loadPreview: async ({ targets }) => ({
        ok: true,
        deletableCount: targets.length,
        cascadeSubagentCount: 2,
        crossSourceIndexMatches: [],
        orphanIndexMatches: [{ clientId: 'ide_legacy', sessionId: s2 }],
        protectedMigrationItems: [],
        blockedByRunning: [],
      }),
      runDelete: async (payload) => {
        deletePayload = payload;
        return {
          ok: true,
          deletedCount: payload.targets.length,
          failedCount: 0,
          cascadeSubagentCount: 2,
          crossOrphanCleanedCount: payload.includeOrphanIndexes ? 1 : 0,
          ledgerRedaction: { enabled: true, redactedConversations: 1, redactedSteps: 3 },
          deleted: payload.targets,
          failed: [],
          warnings: [],
        };
      },
    });

    await card.refs.ensureLoaded();

    // Design-system check: zero native checkboxes or selects, and zero message reader DOM
    assert.equal(card.el.querySelectorAll('input[type="checkbox"]').length, 0);
    assert.equal(card.el.querySelectorAll('select').length, 0);
    assert.equal(card.el.querySelector('.smgr-reader'), null, 'Message reader completely removed');

    // Hide index-only hides s2 by default, exact UUID search reveals it
    assert.equal(card.refs.listEl.querySelectorAll('.smgr-item').length, 4);
    card.refs.searchInput.value = s2;
    card.refs.searchInput.dispatchEvent({ type: 'input', target: card.refs.searchInput });
    assert.equal(card.refs.listEl.querySelectorAll('.smgr-item').length, 1);
    assert.equal(card.refs.listEl.querySelector('.smgr-item-title').textContent, 'Stale Index Entry');
    card.refs.searchInput.value = '';
    card.refs.searchInput.dispatchEvent({ type: 'input', target: card.refs.searchInput });

    // Sorting modes: time_desc (default) -> size_desc -> cost_desc -> tokens_desc -> time_asc -> time_desc
    const visibleTitles = () =>
      Array.from(card.refs.listEl.querySelectorAll('.smgr-item-title')).map((n) => n.textContent);
    const selectSort = (val) => {
      const trig = card.refs.sortSelect.el.querySelector('.select-trigger');
      trig.dispatchEvent({ type: 'click', target: trig, stopPropagation() {} });
      const opt = Array.from(card.refs.sortSelect.el.querySelectorAll('.select-option')).find(
        (n) => n.getAttribute('data-value') === val
      );
      assert.ok(opt, `Sort option ${val} rendered`);
      opt.dispatchEvent({ type: 'click', target: opt, stopPropagation() {} });
    };
    assert.equal(visibleTitles()[0], 'Newest Tiny Cheap');
    selectSort('size_desc');
    assert.equal(visibleTitles()[0], 'Huge File Session');
    selectSort('cost_desc');
    assert.equal(visibleTitles()[0], 'Oldest Costliest Session');
    selectSort('tokens_desc');
    assert.equal(visibleTitles()[0], 'Huge File Session');
    selectSort('time_asc');
    assert.equal(visibleTitles()[0], 'Oldest Costliest Session');
    selectSort('time_desc');
    assert.equal(visibleTitles()[0], 'Newest Tiny Cheap');

    // Shift+Click range multi-select: click row 0, then Shift+Click row 3 -> selects 0, 2, 3 and skips blocked row 1!
    let rows = card.refs.listEl.querySelectorAll('.smgr-item');
    rows[0].dispatchEvent({ type: 'click', target: rows[0], shiftKey: false });
    rows = card.refs.listEl.querySelectorAll('.smgr-item');
    rows[3].dispatchEvent({ type: 'click', target: rows[3], shiftKey: true, preventDefault() {} });
    rows = card.refs.listEl.querySelectorAll('.smgr-item');
    assert.equal(rows[0].classList.contains('is-checked'), true);
    assert.equal(rows[1].classList.contains('is-checked'), false, 'Shift range skips blocked non-deletable row');
    assert.equal(rows[2].classList.contains('is-checked'), true);
    assert.equal(rows[3].classList.contains('is-checked'), true);
    assert.equal(card.refs.batchDeleteBtn.hasAttribute('hidden'), false);
    assert.match(card.refs.batchDeleteBtn.textContent, /3/);

    // Clear selection, select single item, open inline confirm -> opt into orphan cleanup -> execute delete
    card.refs.toggleAllBtn.dispatchEvent({ type: 'click', target: card.refs.toggleAllBtn });
    assert.equal(card.refs.batchDeleteBtn.hasAttribute('hidden'), true);
    rows = card.refs.listEl.querySelectorAll('.smgr-item');
    rows[0].dispatchEvent({ type: 'click', target: rows[0] });
    card.refs.batchDeleteBtn.dispatchEvent({ type: 'click', target: card.refs.batchDeleteBtn });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(card.refs.confirmBoxEl.hasAttribute('hidden'), false);

    const orphanToggle = card.refs.confirmBoxEl.querySelector('.smgr-confirm-orphan-toggle');
    assert.ok(orphanToggle);
    orphanToggle.dispatchEvent({ type: 'click', target: orphanToggle });

    const execBtn = card.refs.confirmBoxEl.querySelector('.smgr-confirm-exec-btn');
    execBtn.dispatchEvent({ type: 'click', target: execBtn });
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(deletePayload);
    assert.equal(deletePayload.targets[0].sessionId, s1);
    assert.equal(deletePayload.includeOrphanIndexes, true);
    assert.equal(card.refs.resultBoxEl.hasAttribute('hidden'), false);

    card.destroy();
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  }
});

test('regressions: protected brain non-zombie & log purge, multi-hop /fork subagent guard, mtime cold-inspect priority, steps clone redaction, live side-question sweep guard, and file:// %23/punctuation reveal', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'ag-smgr-reg-'));
  const geminiDir = join(tempRoot, '.gemini');
  const backupDir = join(tempRoot, 'backups');
  const idle = { desktop: false, cli: false, ide_legacy: false, checked: true };

  try {
    // 1. Protected migration brain: deleting cleans logs, redacts ledger, keeps media, and never reappears as zombie
    const cliRoot = join(geminiDir, 'antigravity-cli');
    mkdirSync(join(cliRoot, 'annotations'), { recursive: true });
    mkdirSync(join(cliRoot, 'brain'), { recursive: true });
    mkdirSync(join(backupDir, 'archived-sources', 'cli'), { recursive: true });

    const protCid = '91111111-1111-4111-8111-111111111101';
    mkdirSync(join(cliRoot, 'brain', protCid, '.system_generated', 'logs'), { recursive: true });
    writeFileSync(join(cliRoot, 'brain', protCid, 'diagram.png'), 'PNG', 'utf8');
    writeFileSync(
      join(cliRoot, 'brain', protCid, '.system_generated', 'logs', 'transcript_full.jsonl'),
      `${JSON.stringify({ role: 'user', content: 'Sensitive archived prompt' })}\n`,
      'utf8'
    );
    writeFileSync(join(cliRoot, 'annotations', `${protCid}.pbtxt`), 'title:"Old Residual"\n', 'utf8');
    writeFileSync(join(backupDir, 'archived-sources', 'cli', `${protCid}_2026.db`), 'arc', 'utf8');

    const store = createTrajectoryCacheStore({
      sqliteFilePath: join(tempRoot, 'ledger.sqlite'),
      enableSqlite: true,
    });
    store.setCachedTrajectory(protCid, {
      title: 'Old Residual',
      appSource: 'cli',
      steps: [{ stepIndex: 0, createdAtMs: Date.now(), inputTokens: 400, outputTokens: 80, turnPrompt: 'Secret' }],
    });
    store.flushTrajectoryCacheNow();
    const hydratedBefore = store.getHydratedTrajectory(protCid);
    const prevStepsRef = hydratedBefore.steps;

    const delProt = deleteLocalSessions(
      { targets: [{ clientId: 'cli', sessionId: protCid }], redactLedger: true },
      { geminiDir, backupDir, cacheStore: store, runningClientsOverride: idle }
    );
    assert.equal(delProt.ok, true);
    assert.equal(delProt.ledgerRedaction.redactedConversations, 1, 'Protected-brain-only does not block ledger redaction');
    assert.equal(existsSync(join(cliRoot, 'brain', protCid, 'diagram.png')), true, 'Keeps media attachment');
    assert.equal(
      existsSync(join(cliRoot, 'brain', protCid, '.system_generated', 'logs')),
      false,
      'Purges plaintext transcript logs inside retained brain directory'
    );
    const hydratedAfter = store.getHydratedTrajectory(protCid);
    assert.notEqual(hydratedAfter.steps, prevStepsRef, 'Clones steps array reference to invalidate WeakMap caches');
    assert.equal(hydratedAfter.title, '[Deleted Session]');

    const afterScan = scanLocalSessions({ geminiDir, backupDir, cacheStore: store, runningClientsOverride: idle });
    assert.equal(
      afterScan.sessions.some((s) => s.sessionId === protCid),
      false,
      'Retained migration media directory never reappears as zombie session'
    );

    // 2. Multi-hop /fork (A -> fork B -> fork C, B -> subagent S) never over-deletes across /fork boundary
    const ideRoot = join(geminiDir, 'antigravity-ide');
    mkdirSync(join(ideRoot, 'conversations'), { recursive: true });
    mkdirSync(join(ideRoot, 'sidecar_data', 'p', 'panel', 'events'), { recursive: true });
    const rootA = '92222222-2222-4222-8222-222222222201';
    const forkB = '92222222-2222-4222-8222-222222222202';
    const forkC = '92222222-2222-4222-8222-222222222203';
    const subOfB = '92222222-2222-4222-8222-222222222204';

    createMinimalConvDb(join(ideRoot, 'conversations', `${rootA}.db`), { cid: rootA });
    createMinimalConvDb(join(ideRoot, 'conversations', `${forkB}.db`), {
      cid: forkB,
      parentConversationId: rootA,
      nestingDepth: 0,
    });
    const forkCDb = new DatabaseSync(join(ideRoot, 'conversations', `${forkB}.db`));
    forkCDb.close();
    createMinimalConvDb(join(ideRoot, 'conversations', `${forkC}.db`), {
      cid: forkC,
      parentConversationId: forkB,
      nestingDepth: 0,
    });
    // Patch rootConversationId=rootA into subOfB to verify parentConversationId boundary wins
    createMinimalConvDb(join(ideRoot, 'conversations', `${subOfB}.db`), {
      cid: subOfB,
      parentConversationId: forkB,
      nestingDepth: 1,
      subagentSpec: { typeName: 'research', role: 'ForkB Helper' },
    });
    const patchSubDb = new DatabaseSync(join(ideRoot, 'conversations', `${subOfB}.db`));
    patchSubDb
      .prepare("UPDATE trajectory_metadata_blob SET data = ? WHERE id = 'main'")
      .run(
        Buffer.concat([
          encodeProtoStringField(6, rootA),
          encodeProtoStringField(5, forkB),
          encodeProtoVarintField(17, 1),
        ])
      );
    patchSubDb.close();

    const forkCEvt = join(ideRoot, 'sidecar_data', 'p', 'panel', 'events', 'fork-c.json');
    writeFileSync(
      forkCEvt,
      JSON.stringify({
        payload: {
          conversationMetadata: {
            conversationId: forkC,
            metadata: { rootConversationId: rootA, parentConversationId: forkB, nestingDepth: 0 },
          },
        },
      }),
      'utf8'
    );

    const delA = deleteLocalSessions(
      { targets: [{ clientId: 'ide_legacy', sessionId: rootA }], redactLedger: false },
      { geminiDir, backupDir, cacheStore: store, runningClientsOverride: idle }
    );
    assert.equal(delA.ok, true);
    assert.equal(existsSync(join(ideRoot, 'conversations', `${subOfB}.db`)), true, 'Preserves subagent of live /fork B');
    assert.equal(existsSync(forkCEvt), true, 'Preserves sidecar event of 2nd-gen /fork C');

    // 3. Cold .db inspect mtime priority (>160 files) & resilient broken cacheStore fallback
    const oldDate = new Date(Date.now() - 86400_000 * 20);
    for (let i = 0; i < 162; i += 1) {
      const cid = `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
      const p = join(ideRoot, 'conversations', `${cid}.db`);
      createMinimalConvDb(p, { cid, userText: `Old #${i}` });
      utimesSync(p, oldDate, oldDate);
    }
    const newestRoot = 'ffffffff-ffff-4fff-8fff-fffffffffff1';
    const newestSub = 'ffffffff-ffff-4fff-8fff-fffffffffff2';
    createMinimalConvDb(join(ideRoot, 'conversations', `${newestRoot}.db`), {
      cid: newestRoot,
      userText: 'Newest Priority Session',
    });
    createMinimalConvDb(join(ideRoot, 'conversations', `${newestSub}.db`), {
      cid: newestSub,
      parentConversationId: newestRoot,
      nestingDepth: 1,
      subagentSpec: { typeName: 'research', role: 'Child' },
    });

    const brokenCacheStore = {
      listCachedTrajectoryEntries() {
        throw new Error('SQLITE_CANTOPEN');
      },
    };
    const bigScan = scanLocalSessions({
      geminiDir,
      backupDir,
      cacheStore: brokenCacheStore,
      runningClientsOverride: idle,
    });
    assert.equal(bigScan.ok, true);
    assert.ok(bigScan.warnings.some((w) => w.includes('ledger_telemetry_unavailable')));
    assert.equal(bigScan.sessions.find((s) => s.sessionId === newestRoot)?.title, 'Newest Priority Session');
    assert.equal(bigScan.sessions.some((s) => s.sessionId === newestSub), false, 'Nested subagent never leaks past 160 cap');

    // 4. sweepLedgerPrivacy protects live parent's RPC-only side-questions & missing geminiDir
    const liveParent = forkB;
    const rpcSideQ = '93333333-3333-4333-8333-333333333301';
    store.setCachedTrajectory(liveParent, {
      title: 'Live Fork B',
      appSource: 'standalone',
      subagentRefs: [{ cascadeId: rpcSideQ, typeName: 'side_question', role: 'Quick side question' }],
      steps: [{ stepIndex: 0, createdAtMs: Date.now(), inputTokens: 100, outputTokens: 10 }],
    });
    store.setCachedTrajectory(rpcSideQ, {
      title: 'Quick side question',
      appSource: 'standalone',
      isSideQuestion: true,
      parentConversationId: liveParent,
      subagentSpec: { typeName: 'side_question', role: 'Quick side question' },
      steps: [{ stepIndex: 0, createdAtMs: Date.now(), inputTokens: 50, outputTokens: 10, turnPrompt: 'Quick side question' }],
    });
    store.flushTrajectoryCacheNow();

    sweepLedgerPrivacy({ geminiDir, backupDir, cacheStore: store });
    assert.equal(store.getHydratedTrajectory(rpcSideQ).title, 'Quick side question');
    const emptySweep = sweepLedgerPrivacy({
      geminiDir: join(tempRoot, 'non-existent-gemini'),
      cacheStore: store,
    });
    assert.equal(emptySweep.redactedConversations, 0);
    assert.equal(store.getHydratedTrajectory(liveParent).title, 'Live Fork B');

    // 5. Bare file:// trailing punctuation & %23 (#) filename chip reveal
    const repoDir = join(tempRoot, 'repo');
    mkdirSync(repoDir, { recursive: true });
    const jsFile = join(repoDir, 'app.js');
    const sharpFile = join(repoDir, 'C#-notes.md');
    writeFileSync(jsFile, '1;', 'utf8');
    writeFileSync(sharpFile, '# C#', 'utf8');
    const repoSlash = repoDir.replace(/\\/g, '/');
    const repoUriBase = repoSlash.startsWith('/') ? `file://${repoSlash}` : `file:///${repoSlash}`;
    for (const href of [`${repoUriBase}/app.js`, `${repoUriBase}/C%23-notes.md#L8`]) {
      const rev = revealLocalSessionPath(href, {
        allowedRoots: [cliRoot],
        allowedPaths: [jsFile, sharpFile],
        spawnFn: () => ({ on() {}, unref() {} }),
      });
      assert.equal(rev.ok, true, `Expected 200 reveal for ${href}, got ${rev.status}: ${rev.error}`);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('SessionManagerCard wide split-view avoids duplicate DOM rows and callSessionManagerEndpoint handles 409/404 cleanly', async () => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevFetch = globalThis.fetch;
  const { document: doc } = createMockDom();
  globalThis.document = doc;

  const hits = [];
  let simulateLegacy404 = false;
  const mockFetch = async (url, init = {}) => {
    const pathname = String(url).replace(/^https?:\/\/[^/]+/, '');
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    hits.push(`${method} ${pathname}`);
    if (simulateLegacy404 && pathname.startsWith('/api/sessions/')) {
      return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
    }
    const out = await dispatchBridgeApiRequest(pathname, method, body, {
      sessionOptions: {
        runningClientsOverride: { desktop: true, cli: false, ide_legacy: false, checked: true },
      },
    });
    return {
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      json: async () => JSON.parse(out.body),
    };
  };
  globalThis.window = { document: doc, fetch: mockFetch };
  globalThis.fetch = mockFetch;

  try {
    const { SessionManagerCard } = await import('../src/components/settings/SessionManagerCard.js');
    const { deleteLocalSessionsAction } = await import('../src/store/telemetryStore.js');

    const cid1 = '95555555-5555-4555-8555-555555555501';
    const cid2 = '95555555-5555-4555-8555-555555555502';
    const sessions = [cid1, cid2].map((id, i) => ({
      sessionId: id,
      cascadeId: id,
      clientId: 'desktop',
      title: `Session ${i + 1}`,
      canDelete: true,
      clientRunning: false,
      indexOnly: false,
      subagentCount: 0,
      telemetry: { recorded: false },
    }));

    const wideCard = SessionManagerCard({
      initialWidth: 920,
      loadList: async () => ({
        ok: true,
        clients: [{ id: 'desktop', exists: true, running: false, sessionCount: 2 }],
        runningClients: { desktop: false, cli: false, ide_legacy: false, checked: true },
        sessions,
        counts: { total: 2, indexOnly: 0, byClient: { desktop: 2, cli: 0, ide_legacy: 0 } },
        warnings: [],
      }),
      loadMessages: async () => ({ ok: true, source: 'transcript_full', messages: [{ role: 'user', text: 'hello' }] }),
      loadPreview: async () => ({
        ok: true,
        deletableCount: 1,
        cascadeSubagentCount: 0,
        crossSourceIndexMatches: [],
        orphanIndexMatches: [],
        protectedMigrationItems: [],
        blockedByRunning: [],
      }),
      runDelete: (payload) => deleteLocalSessionsAction(payload),
    });

    await wideCard.refs.ensureLoaded();
    assert.equal(wideCard.refs.listEl.querySelectorAll('.smgr-item').length, 2, 'No duplicate DOM rows in split layout');

    // Trigger delete when backend reports 409 client_running -> single request, structured error, confirm box closed
    const chk = wideCard.refs.listEl.querySelector('.smgr-checkbox');
    chk.dispatchEvent({ type: 'click', target: chk, stopPropagation() {} });
    wideCard.refs.batchDeleteBtn.dispatchEvent({ type: 'click', target: wideCard.refs.batchDeleteBtn });
    await new Promise((r) => setTimeout(r, 15));
    hits.length = 0;
    const execBtn = wideCard.refs.confirmBoxEl.querySelector('.smgr-confirm-exec-btn');
    execBtn.dispatchEvent({ type: 'click', target: execBtn });
    await new Promise((r) => setTimeout(r, 25));

    assert.deepEqual(hits, ['POST /api/sessions/delete'], 'Does not double-fire /api/settings on 409');
    assert.equal(wideCard.refs.confirmBoxEl.hasAttribute('hidden'), true, 'Confirm drawer closes cleanly on 409');
    assert.equal(wideCard.refs.resultBoxEl.classList.contains('is-err'), true);

    // Genuine unregistered 404 route still falls back to POST /api/settings
    hits.length = 0;
    simulateLegacy404 = true;
    const fallbackRes = await deleteLocalSessionsAction({ targets: [{ clientId: 'desktop', sessionId: cid1 }] });
    assert.equal(fallbackRes.ok, false);
    assert.deepEqual(hits, ['POST /api/sessions/delete', 'POST /api/settings']);

    wideCard.destroy();
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.fetch = prevFetch;
  }
});

test('audit fixes: production parent_id & raw_summary relations, workspace reveal guard, cleared SQLite steps, fallback cache clear, CDP 409 non-replay, safeMarkdown fences/backticks/parens, and UI refresh/mode-switch sync', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'ag-smgr-audit-'));
  const geminiDir = join(tempRoot, '.gemini');
  const appDataDir = join(tempRoot, 'AppData', 'Antigravity');
  const deskRoot = join(geminiDir, 'antigravity');
  const deskDef = SESSION_CLIENT_DEFS.find((d) => d.id === 'desktop');
  const idle = { desktop: false, cli: false, ide_legacy: false, checked: true };

  try {
    mkdirSync(join(deskRoot, 'conversations'), { recursive: true });
    mkdirSync(join(deskRoot, 'brain'), { recursive: true });
    mkdirSync(join(appDataDir, 'Cache'), { recursive: true });
    writeFileSync(join(appDataDir, 'Cache', 'entry'), '1', 'utf8');

    const mainCid = 'a1000000-0000-4000-8000-000000000001';
    const sideQCid = 'a1000000-0000-4000-8000-000000000002';
    const rawSubCid = 'a1000000-0000-4000-8000-000000000003';
    const fn24ForkCid = 'a1000000-0000-4000-8000-000000000004';
    const sshWsCid = 'a1000000-0000-4000-8000-000000000005';
    const dotWsCid = 'a1000000-0000-4000-8000-000000000006';
    const sqlStepsCid = 'a1000000-0000-4000-8000-000000000007';

    createMinimalConvDb(join(deskRoot, 'conversations', `${mainCid}.db`), { cid: mainCid });
    createMinimalConvDb(join(deskRoot, 'conversations', `${sideQCid}.db`), {
      cid: sideQCid,
      trajectoryType: 22,
    });
    createMinimalConvDb(join(deskRoot, 'conversations', `${rawSubCid}.db`), {
      cid: rawSubCid,
      parentConversationId: mainCid,
      nestingDepth: 1,
    });
    createMinimalConvDb(join(deskRoot, 'conversations', `${fn24ForkCid}.db`), {
      cid: fn24ForkCid,
      parentConversationId: mainCid,
      nestingDepth: 0,
    });
    createMinimalConvDb(join(deskRoot, 'conversations', `${sshWsCid}.db`), {
      cid: sshWsCid,
      wsUri: 'vscode-remote://ssh-remote+prod-box/home/ubuntu/app',
    });
    createMinimalConvDb(join(deskRoot, 'conversations', `${dotWsCid}.db`), {
      cid: dotWsCid,
      wsUri: '.',
    });
    createMinimalConvDb(join(deskRoot, 'conversations', `${sqlStepsCid}.db`), {
      cid: sqlStepsCid,
      emptySteps: true,
    });
    const stepDb = new DatabaseSync(join(deskRoot, 'conversations', `${sqlStepsCid}.db`));
    stepDb
      .prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (0, 14, 5, ?)')
      .run(encodeProtoBytesField(19, encodeProtoStringField(2, 'CLEARED_DRAFT_PROMPT')));
    stepDb
      .prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (1, 14, 3, ?)')
      .run(encodeProtoBytesField(19, encodeProtoStringField(2, 'Active valid question')));
    stepDb
      .prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (2, 15, 6, ?)')
      .run(encodeProtoBytesField(20, encodeProtoStringField(1, 'CANCELED_ASSISTANT_DRAFT')));
    stepDb
      .prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (3, 15, 3, ?)')
      .run(encodeProtoBytesField(20, encodeProtoStringField(1, 'Active valid answer')));
    stepDb.close();

    const sumDb = initRichSummaryDb(join(deskRoot, 'conversation_summaries.db'));
    const ins = sumDb.prepare(`
      INSERT INTO conversation_summaries (
        conversation_id, title, step_count, last_modified_time, workspace_uris,
        status, parent_conversation_id, nesting_depth, app_data_dir, raw_summary
      ) VALUES (?, ?, 4, '2026-11-25 12:00:00+00:00', ?, 'CASCADE_RUN_STATUS_IDLE', '', 0, 'antigravity', ?)
    `);
    ins.run(
      mainCid,
      'Main Task',
      '["file:///F:/demo-repo"]',
      encodeProtoBytesField(15, encodeProtoStringField(17, sideQCid))
    );
    ins.run(
      sideQCid,
      'Side Question',
      '["file:///F:/demo-repo"]',
      Buffer.concat([encodeProtoVarintField(22, 22), encodeProtoStringField(24, mainCid)])
    );
    sumDb.prepare('INSERT INTO conversation_parents (conversation_id, parent_id) VALUES (?, ?)').run(sideQCid, mainCid);
    ins.run(
      rawSubCid,
      'RawMeta Subagent',
      '["file:///F:/demo-repo"]',
      encodeProtoBytesField(
        17,
        Buffer.concat([encodeProtoStringField(5, mainCid), encodeProtoVarintField(17, 1)])
      )
    );
    ins.run(fn24ForkCid, 'Fork via fn24', '["file:///F:/demo-repo"]', encodeProtoStringField(24, mainCid));
    ins.run(sshWsCid, 'SSH Workspace', '["vscode-remote://ssh-remote+prod-box/home/ubuntu/app"]', null);
    ins.run(dotWsCid, 'Dot Workspace', '["."]', null);
    ins.run(sqlStepsCid, 'SQLite Filtered Steps', '["file:///F:/demo-repo"]', null);
    sumDb.close();

    // 1. Scan hides side-question & raw_summary subagent, detects fn=24 /fork, and rejects non-local workspace URIs
    const scan = scanLocalSessions({ geminiDir, runningClientsOverride: idle });
    const ids = scan.sessions.map((s) => s.sessionId);
    assert.equal(ids.includes(sideQCid), false, 'Side question must be folded under parent');
    assert.equal(ids.includes(rawSubCid), false, 'raw_summary subagent must be folded under parent');
    assert.equal(scan.sessions.find((s) => s.sessionId === mainCid)?.subagentCount, 2);
    assert.equal(scan.sessions.find((s) => s.sessionId === fn24ForkCid)?.isFork, true);
    assert.equal(scan.sessions.find((s) => s.sessionId === sshWsCid)?.projectDir, '');
    assert.equal(scan.sessions.find((s) => s.sessionId === dotWsCid)?.projectDir, '');

    const { getAuthorizedRevealSnapshot } = await import('../backend/session-manager.mjs');
    const cwdReveal = revealLocalSessionPath(process.cwd(), {
      allowedRoots: [deskRoot],
      allowedPaths: getAuthorizedRevealSnapshot(),
      spawnFn: () => ({ on() {}, unref() {} }),
    });
    assert.equal(cwdReveal.ok, false, 'Dot workspace URI must never authorize process.cwd()');
    const dotLiteralReveal = revealLocalSessionPath('.', {
      allowedRoots: [deskRoot],
      allowedPaths: ['.'],
      spawnFn: () => ({ on() {}, unref() {} }),
    });
    assert.equal(dotLiteralReveal.ok, false, 'Relative path "." must be rejected at reveal gate');

    // 2. Delete cascades side-question + raw_summary subagent, preserves fn=24 /fork, and cleans parent_id rows
    const prev = previewSessionCleanup(
      { targets: [{ clientId: 'desktop', sessionId: mainCid }] },
      { geminiDir, runningClientsOverride: idle }
    );
    assert.equal(prev.cascadeSubagentCount, 2);

    const del = deleteLocalSessions(
      { targets: [{ clientId: 'desktop', sessionId: mainCid }], redactLedger: false },
      { geminiDir, runningClientsOverride: idle }
    );
    assert.equal(del.ok, true);
    assert.equal(del.cascadeSubagentCount, 2);
    assert.equal(existsSync(join(deskRoot, 'conversations', `${sideQCid}.db`)), false);
    assert.equal(existsSync(join(deskRoot, 'conversations', `${rawSubCid}.db`)), false);
    assert.equal(existsSync(join(deskRoot, 'conversations', `${fn24ForkCid}.db`)), true);

    const checkSum = new DatabaseSync(join(deskRoot, 'conversation_summaries.db'), { readOnly: true });
    assert.equal(checkSum.prepare('SELECT count(*) AS c FROM conversation_parents').get().c, 0);
    checkSum.close();

    // 4. Per-item batch fallback still clears browser cache when first item succeeds and last item fails
    if (process.platform !== 'win32') {
      // Also test via directory-in-file-slot on all platforms (including Windows!)
    }
    const failLastCid = 'a1000000-0000-4000-8000-000000000099';
    mkdirSync(join(deskRoot, 'conversations', `${failLastCid}.db`), { recursive: true }); // directory where regular file is expected -> not_a_regular_file
    const fallbackBatch = cleanClientSessionsBatch({
      clientDef: deskDef,
      clientRoot: deskRoot,
      requestedIds: [sshWsCid, failLastCid],
      geminiDir,
      electronAppDataDir: appDataDir,
      clearBrowserCache: true,
      runningClients: idle,
    });
    assert.deepEqual(fallbackBatch.succeeded, [sshWsCid]);
    assert.equal(fallbackBatch.failed.length, 1);
    assert.equal(existsSync(join(appDataDir, 'Cache')), false, 'Clears browser cache even when final item in fallback loop fails');

    // 5. CDP transport 409 business response preserves structured data without HTTP replay
    const { WINDOW_BRIDGE_KEY } = await import('../shared/window-bridge-protocol.mjs');
    const { deliverCdpBridgeResponses } = await import('../src/core/httpClient.js');
    const { deleteLocalSessionsAction } = await import('../src/store/telemetryStore.js');
    const prevWin = globalThis.window;
    const prevFetch = globalThis.fetch;
    const prevDoc = globalThis.document;
    let httpReplayCalls = 0;
    const fakeBridge = {
      port: 59998,
      token: 'tok',
      transportMode: 'cdp',
      __endpointId: 'local',
      rpcQueue: [],
      rpcPending: new Map(),
    };
    const blockedFetch = async () => {
      httpReplayCalls += 1;
      throw new TypeError('Failed to fetch');
    };
    const { document: doc } = createMockDom();
    globalThis.document = doc;
    globalThis.window = { document: doc, [WINDOW_BRIDGE_KEY]: fakeBridge, fetch: blockedFetch };
    globalThis.fetch = blockedFetch;
    try {
      const p409 = deleteLocalSessionsAction({
        targets: [{ clientId: 'desktop', sessionId: fn24ForkCid }],
      });
      await new Promise((r) => setTimeout(r, 5));
      const rpcReq = fakeBridge.rpcQueue.shift();
      assert.ok(rpcReq);
      deliverCdpBridgeResponses([
        {
          id: rpcReq.id,
          ok: false,
          status: 409,
          error: 'client_running',
          data: { ok: false, status: 409, error: 'client_running', deletedCount: 0, failedCount: 1 },
        },
      ]);
      const cdpRes = await p409;
      assert.equal(cdpRes.ok, false);
      assert.equal(cdpRes.error, 'client_running');
      assert.equal(httpReplayCalls, 0, 'Must never replay failed 409 mutation over HTTP');
      assert.equal(fakeBridge.transportMode, 'cdp', 'Keeps cdp transport mode intact');

      // 6. SettingsSessionsTab top thirdNavBar reuses single scan with zero redundant rescans
      const { SettingsSessionsTab } = await import('../src/views/settings/SettingsSessionsTab.js');

      let listLoads = 0;
      let migLoads = 0;
      globalThis.window.fetch = async (url) => {
        if (String(url).includes('/api/sessions/list')) {
          listLoads += 1;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              clients: [],
              runningClients: idle,
              sessions: [],
              counts: { total: 0, byClient: {} },
              migrationCatalog: {
                available: true,
                sqliteSupported: true,
                clients: [
                  { id: 'desktop', exists: true, canBeSource: true, canBeTarget: true, sessionCount: 1 },
                  { id: 'cli', exists: true, canBeSource: true, canBeTarget: true, sessionCount: 1 },
                ],
                sessionsByClient: { desktop: [], cli: [] },
                desktopProjects: [{ projectId: 'outside-of-project', isOutsideProject: true }],
              },
              warnings: [],
            }),
          };
        }
        if (String(url).includes('/api/session-migration/catalog')) {
          migLoads += 1;
          return { ok: true, status: 200, json: async () => ({ available: false, clients: [], sessionsByClient: {}, desktopProjects: [] }) };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      };
      globalThis.fetch = globalThis.window.fetch;
      delete globalThis.window[WINDOW_BRIDGE_KEY];
      const tab = SettingsSessionsTab({});
      await tab.refs.ensureLoaded();
      assert.equal(tab.refs.thirdNavBar.style.getPropertyValue('--thirdnav-count'), '2');
      assert.equal(tab.refs.thirdNavBar.style.getPropertyValue('--active-third-index'), '0');
      const modeBtns = tab.refs.thirdNavBar.querySelectorAll('button');
      assert.equal(modeBtns.length, 2);
      modeBtns[1].dispatchEvent({ type: 'click', target: modeBtns[1], stopPropagation() {}, preventDefault() {} });
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(tab.refs.thirdNavBar.style.getPropertyValue('--active-third-index'), '1');
      modeBtns[0].dispatchEvent({ type: 'click', target: modeBtns[0], stopPropagation() {}, preventDefault() {} });
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(tab.refs.thirdNavBar.style.getPropertyValue('--active-third-index'), '0');
      assert.equal(listLoads, 1, 'Switching between manage and migrate reuses the single scan with zero rescan');
      assert.equal(migLoads, 0, 'Migration mode hydrates directly from shared scan without extra catalog scan');
      // Refreshing from migration mode triggers one shared reload that updates both views
      await tab.refs.sessionMigrationCard.refs.reload();
      assert.equal(listLoads, 2, 'Migration refresh delegates to shared reload');
      assert.equal(migLoads, 0, 'Still zero separate migration catalog requests');
      tab.destroy();
    } finally {
      globalThis.document = prevDoc;
      globalThis.window = prevWin;
      globalThis.fetch = prevFetch;
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Session Hub hardens deferred Desktop app_storage receipt, full .system_generated purge, reader edge cases, and UI races', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'ag-smgr-hardening-'));
  const geminiDir = join(tempRoot, 'gemini');
  const backupDir = join(tempRoot, 'backups');
  const appDataDir = join(tempRoot, 'appdata');
  const idle = { desktop: false, cli: false, ide_legacy: false, checked: true };

  try {
    // 1. Deferred app_storage.json receipt when Desktop is running + full .system_generated / archived-sources scrub
    const cliRoot = join(geminiDir, 'antigravity-cli');
    mkdirSync(join(cliRoot, 'annotations'), { recursive: true });
    mkdirSync(join(cliRoot, 'brain'), { recursive: true });
    mkdirSync(join(backupDir, 'archived-sources', 'cli'), { recursive: true });
    mkdirSync(appDataDir, { recursive: true });

    const protCid = 'a1111111-1111-4111-8111-111111111101';
    const normCid = 'a1111111-1111-4111-8111-111111111102';
    mkdirSync(join(cliRoot, 'brain', protCid, '.system_generated', 'logs'), { recursive: true });
    mkdirSync(join(cliRoot, 'brain', protCid, '.system_generated', 'steps', '1'), { recursive: true });
    mkdirSync(join(cliRoot, 'brain', protCid, '.system_generated', 'tasks'), { recursive: true });
    mkdirSync(join(cliRoot, 'brain', protCid, 'scratch'), { recursive: true });
    writeFileSync(join(cliRoot, 'brain', protCid, 'chart.png'), 'PNG', 'utf8');
    writeFileSync(join(cliRoot, 'brain', protCid, '.system_generated', 'steps', '1', 'output.txt'), 'SECRET_ENV', 'utf8');
    writeFileSync(join(cliRoot, 'brain', protCid, '.system_generated', 'tasks', 't1.log'), 'SECRET_TASK', 'utf8');
    writeFileSync(join(cliRoot, 'brain', protCid, 'scratch', 'tmp.txt'), 'SECRET_SCRATCH', 'utf8');
    writeFileSync(join(cliRoot, 'annotations', `${protCid}.pbtxt`), 'title:"Prot CLI"\n', 'utf8');
    writeFileSync(join(cliRoot, 'annotations', `${normCid}.pbtxt`), 'title:"Norm CLI"\n', 'utf8');
    writeFileSync(join(backupDir, 'archived-sources', 'cli', `${protCid}_2026.db`), 'RAW_SQLITE', 'utf8');
    writeFileSync(
      join(appDataDir, 'app_storage.json'),
      JSON.stringify({
        [`antigravity-multi-conversation-layout-v3-${protCid}`]: '{"open":true}',
        [`antigravity-multi-conversation-layout-v3-${normCid}`]: '{"open":true}',
      }),
      'utf8'
    );

    const delWhileDesktopOpen = deleteLocalSessions(
      {
        targets: [
          { clientId: 'cli', sessionId: protCid },
          { clientId: 'cli', sessionId: normCid },
        ],
        redactLedger: true,
      },
      {
        geminiDir,
        backupDir,
        electronAppDataDir: appDataDir,
        runningClientsOverride: { desktop: true, cli: false, ide_legacy: false, checked: true },
      }
    );
    assert.equal(delWhileDesktopOpen.ok, true);
    assert.equal(existsSync(join(cliRoot, 'brain', protCid, 'chart.png')), true);
    assert.equal(existsSync(join(cliRoot, 'brain', protCid, '.system_generated')), false);
    assert.equal(existsSync(join(cliRoot, 'brain', protCid, 'scratch')), false);
    assert.equal(existsSync(join(backupDir, 'archived-sources', 'cli', `${protCid}_2026.db`)), false);
    assert.equal(existsSync(join(backupDir, 'archived-sources', 'cli', `${protCid}.protected.json`)), true);

    const storageWhileOpen = JSON.parse(readFileSync(join(appDataDir, 'app_storage.json'), 'utf8'));
    assert.ok(storageWhileOpen[`antigravity-multi-conversation-layout-v3-${protCid}`], 'Never mutates live Desktop app_storage.json');
    assert.ok(storageWhileOpen[`antigravity-multi-conversation-layout-v3-${normCid}`]);

    // Once Desktop closes, next scan recovers the deferred extras receipt using persisted backupDir
    const postCloseScan = scanLocalSessions({
      geminiDir,
      backupDir,
      electronAppDataDir: appDataDir,
      runningClientsOverride: idle,
    });
    assert.equal(postCloseScan.sessions.some((s) => s.sessionId === protCid), false);
    const storageAfterClose = JSON.parse(readFileSync(join(appDataDir, 'app_storage.json'), 'utf8'));
    assert.equal(storageAfterClose[`antigravity-multi-conversation-layout-v3-${protCid}`], undefined);
    assert.equal(storageAfterClose[`antigravity-multi-conversation-layout-v3-${normCid}`], undefined);

    // 2. Prompt <SYSTEM_MESSAGE> disclaimer, CLEARED/CANCELED JSONL, NOTIFY_USER SQLite, and >16MB streaming JSONL
    const { extractCleanUserRequestBody } = await import('../shared/prompt-clean.mjs');
    assert.equal(
      extractCleanUserRequestBody(
        'Fix bug\n\nThe following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\nhi\n</SYSTEM_MESSAGE>'
      ).trim(),
      'Fix bug'
    );
    assert.equal(
      extractCleanUserRequestBody(
        'The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\nhi\n</SYSTEM_MESSAGE>'
      ).trim(),
      ''
    );

    // 2. Frontend SessionManagerCard stale confirm & concurrent reload + endpoint switch
    const prevDoc = globalThis.document;
    const prevWin = globalThis.window;
    const prevFetch = globalThis.fetch;
    const { document: doc } = createMockDom();
    globalThis.document = doc;
    globalThis.window = { document: doc };
    try {
      const { SessionManagerCard } = await import('../src/components/settings/SessionManagerCard.js');
      const id1 = 'a3333333-3333-4333-8333-333333333301';
      const id2 = 'a3333333-3333-4333-8333-333333333302';
      let currentSessions = [
        { sessionId: id1, cascadeId: id1, clientId: 'cli', title: 'S1', canDelete: true, indexOnly: false, subagentCount: 0, telemetry: { recorded: false } },
        { sessionId: id2, cascadeId: id2, clientId: 'cli', title: 'S2', canDelete: true, indexOnly: false, subagentCount: 0, telemetry: { recorded: false } },
      ];
      let listCalls = 0;
      let releaseStaleReload = null;
      const card = SessionManagerCard({
        loadList: () => {
          listCalls += 1;
          const snap = currentSessions.slice();
          if (listCalls === 2) {
            return new Promise((res) => {
              releaseStaleReload = () =>
                res({
                  ok: true,
                  clients: [{ id: 'cli', exists: true, running: false, sessionCount: snap.length }],
                  runningClients: idle,
                  sessions: snap,
                  counts: { total: snap.length, indexOnly: 0, byClient: { cli: snap.length } },
                  warnings: [],
                });
            });
          }
          return Promise.resolve({
            ok: true,
            clients: [{ id: 'cli', exists: true, running: false, sessionCount: snap.length }],
            runningClients: idle,
            sessions: snap,
            counts: { total: snap.length, indexOnly: 0, byClient: { cli: snap.length } },
            warnings: [],
          });
        },
        loadPreview: async ({ targets }) => ({
          ok: true,
          deletableCount: targets.length,
          cascadeSubagentCount: 0,
          crossSourceIndexMatches: [],
          orphanIndexMatches: [],
          protectedMigrationItems: [],
          blockedByRunning: [],
        }),
        runDelete: async (payload) => {
          currentSessions = currentSessions.filter((s) => s.sessionId !== id1);
          return { ok: true, deletedCount: 1, deleted: payload.targets, failed: [], warnings: [] };
        },
      });
      await card.refs.ensureLoaded();
      card.refs.toggleAllBtn.dispatchEvent({ type: 'click', target: card.refs.toggleAllBtn });
      card.refs.batchDeleteBtn.dispatchEvent({ type: 'click', target: card.refs.batchDeleteBtn });
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(card.refs.confirmBoxEl.hasAttribute('hidden'), false);
      // Unchecking an item immediately closes the stale confirm drawer
      const cbs = card.refs.listEl.querySelectorAll('.smgr-checkbox');
      cbs[1].dispatchEvent({ type: 'click', target: cbs[1], stopPropagation() {} });
      assert.equal(card.refs.confirmBoxEl.hasAttribute('hidden'), true);

      // Re-open confirm for remaining checked S1 while a slow pre-delete reload is in flight
      card.refs.batchDeleteBtn.dispatchEvent({ type: 'click', target: card.refs.batchDeleteBtn });
      await new Promise((r) => setTimeout(r, 15));
      const pendingReload = card.refs.reload();
      const execBtn = card.refs.confirmBoxEl.querySelector('.smgr-confirm-exec-btn');
      execBtn.dispatchEvent({ type: 'click', target: execBtn });
      await new Promise((r) => setTimeout(r, 20));
      releaseStaleReload?.();
      await pendingReload;
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(card.refs.listEl.querySelectorAll('.smgr-item').length, 1);
      card.destroy();
    } finally {
      globalThis.document = prevDoc;
      globalThis.window = prevWin;
      globalThis.fetch = prevFetch;
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('vsim audit regressions: move->delete linked source scrub, evicted step_index tail safety, empty transcript fallback, CJK file:// & UNC block, reveal 403 self-heal, and <ol start>', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'ag-smgr-vsim-fixes-'));
  const geminiDir = join(tempRoot, '.gemini');
  const backupDir = join(tempRoot, 'backups');
  const appDataDir = join(tempRoot, 'appdata');
  const idle = { desktop: false, cli: false, ide_legacy: false, checked: true };

  try {
    const { migrateSessions } = await import('../backend/session-migrator.mjs');
    const deskRoot = join(geminiDir, 'antigravity');
    const cliRoot = join(geminiDir, 'antigravity-cli');
    for (const r of [deskRoot, cliRoot]) {
      mkdirSync(join(r, 'conversations'), { recursive: true });
      mkdirSync(join(r, 'brain'), { recursive: true });
      mkdirSync(join(r, 'annotations'), { recursive: true });
    }
    mkdirSync(appDataDir, { recursive: true });

    // 1. Move CLI -> Desktop then delete migrated target session -> scrubs source archived .db & orphan source brain
    const srcCid = 'b1000000-0000-4000-8000-000000000001';
    createMinimalConvDb(join(cliRoot, 'conversations', `${srcCid}.db`), {
      cid: srcCid,
      source: 17,
      userText: 'TOP_SECRET_MIGRATED_PROMPT',
    });
    mkdirSync(join(cliRoot, 'brain', srcCid, '.system_generated', 'logs'), { recursive: true });
    writeFileSync(join(cliRoot, 'brain', srcCid, 'walkthrough.md'), 'Sensitive walkthrough', 'utf8');
    const cliSum = initRichSummaryDb(join(cliRoot, 'conversation_summaries.db'));
    cliSum
      .prepare(
        `INSERT INTO conversation_summaries (conversation_id, title, step_count, last_modified_time, app_data_dir)
         VALUES (?, 'Move Source', 2, '2026-11-25 10:00:00+00:00', 'antigravity-cli')`
      )
      .run(srcCid);
    cliSum.close();
    const deskSum = initRichSummaryDb(join(deskRoot, 'conversation_summaries.db'));
    deskSum.close();

    const mig = migrateSessions(
      { sourceClient: 'cli', targetClient: 'desktop', mode: 'move', cascadeIds: [srcCid] },
      { geminiDir, backupDir, runningClientsOverride: idle }
    );
    assert.equal(mig.ok, true);
    const newCid = mig.results[0].newCascadeId;
    assert.equal(existsSync(mig.results[0].archivedSourcePath), true);

    const delMoved = deleteLocalSessions(
      { targets: [{ clientId: 'desktop', sessionId: newCid }] },
      { geminiDir, backupDir, electronAppDataDir: appDataDir, runningClientsOverride: idle }
    );
    assert.equal(delMoved.ok, true);
    assert.equal(existsSync(mig.results[0].archivedSourcePath), false, 'Purges plaintext archived-sources .db');
    assert.equal(existsSync(join(cliRoot, 'brain', srcCid)), false, 'Purges orphaned source brain directory');

    // 2. UNC path block & reveal 403 self-healing for authorized projectDir via sessionId
    const repoDir = join(tempRoot, 'cjk-repo');
    mkdirSync(repoDir, { recursive: true });
    const cjkCid = 'b4000000-0000-4000-8000-000000000004';
    const repoSlash = repoDir.replace(/\\/g, '/');
    const repoUri = repoSlash.startsWith('/') ? `file://${repoSlash}` : `file:///${repoSlash}`;
    createMinimalConvDb(join(cliRoot, 'conversations', `${cjkCid}.db`), {
      cid: cjkCid,
      wsUri: repoUri,
    });

    const selfHealOut = await dispatchBridgeApiRequest(
      '/api/sessions/reveal',
      'POST',
      { path: repoDir, clientId: 'cli', sessionId: cjkCid },
      { sessionOptions: { geminiDir }, spawnFn: () => ({ on() {}, unref() {} }) }
    );
    assert.equal(selfHealOut.status, 200, 'Re-authorizes session projectDir on 403 when clientId+sessionId are provided');

    const uncRev = revealLocalSessionPath('\\\\attacker.example.com\\share\\trap.txt', {
      allowedRoots: [cliRoot],
      allowedPaths: ['\\\\attacker.example.com\\share\\trap.txt'],
      platform: 'win32',
      spawnFn: () => ({ on() {}, unref() {} }),
    });
    assert.equal(uncRev.ok, false, 'UNC path must be rejected at reveal gate');

    // SessionManagerCard clears loading placeholder on scan failure and resets error banner on retry
    const prevDoc2 = globalThis.document;
    const { document: doc2 } = createMockDom();
    globalThis.document = doc2;
    try {
      const { SessionManagerCard } = await import('../src/components/settings/SessionManagerCard.js');
      let attempt = 0;
      const card = SessionManagerCard({
        loadList: async () => {
          attempt += 1;
          if (attempt === 1) throw new Error('Backend worker request timeout');
          return {
            ok: true,
            clients: [{ id: 'desktop', exists: true, running: false, sessionCount: 1, indexOnlyCount: 0 }],
            runningClients: { desktop: false, cli: false, ide_legacy: false, checked: true },
            sessions: [
              {
                sessionId: cjkCid,
                cascadeId: cjkCid,
                clientId: 'desktop',
                title: 'Recovered Session',
                preview: '',
                workspaceName: 'repo',
                workspacePath: 'F:/repo',
                sizeBytes: 1024,
                lastModifiedMs: Date.now(),
                indexOnly: false,
                canDelete: true,
                canReadMessages: true,
              },
            ],
            counts: { total: 1, indexOnly: 0, byClient: { desktop: 1, cli: 0, ide_legacy: 0 } },
            warnings: [],
          };
        },
      });
      await card.refs.reload();
      assert.equal(card.el.querySelector('.smgr-result').hasAttribute('hidden'), false, 'Error banner shown on timeout');
      assert.doesNotMatch(
        card.el.querySelector('.smgr-list').textContent,
        /正在扫描/,
        'Loading placeholder cleared after scan error instead of staying stuck'
      );
      await card.refs.reload();
      assert.equal(card.el.querySelector('.smgr-result').hasAttribute('hidden'), true, 'Stale error banner cleared on retry');
      assert.equal(card.el.querySelectorAll('.smgr-item').length, 1, 'Session list renders after retry succeeds');
      card.destroy();
    } finally {
      globalThis.document = prevDoc2;
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('online deletion while client is running: per-client hub discovery skips stale PID reuse, verifies Connect RPC headers, guards generating/indexOnly/migration-protected sessions, cascades subagents, and redacts ledger', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'ag-smgr-online-'));
  const geminiDir = join(tempRoot, '.gemini');
  const backupDir = join(tempRoot, 'backups');
  const appDataDir = join(tempRoot, 'AppData', 'Antigravity');
  const ledgerDbPath = join(tempRoot, 'trajectory_store.sqlite');
  const csrfToken = 'online-csrf-token-12345678';

  const deskRoot = join(geminiDir, 'antigravity');
  const cliRoot = join(geminiDir, 'antigravity-cli');
  const ideRoot = join(geminiDir, 'antigravity-ide');
  for (const r of [deskRoot, cliRoot, ideRoot]) {
    mkdirSync(join(r, 'conversations'), { recursive: true });
    mkdirSync(join(r, 'brain'), { recursive: true });
    mkdirSync(join(r, 'annotations'), { recursive: true });
    mkdirSync(join(r, 'daemon'), { recursive: true });
  }
  mkdirSync(join(appDataDir, 'Cache'), { recursive: true });
  writeFileSync(join(appDataDir, 'Cache', 'keep-while-running'), '1', 'utf8');

  const idleParentId = '91111111-1111-4111-8111-111111111101';
  const idleSubId = '91111111-1111-4111-8111-111111111102';
  const forkKeepId = '91111111-1111-4111-8111-111111111103';
  const genSummaryId = '91111111-1111-4111-8111-111111111104';
  const genLiveId = '91111111-1111-4111-8111-111111111105';
  const indexOnlyId = '91111111-1111-4111-8111-111111111106';
  const protectedOnlineId = '91111111-1111-4111-8111-111111111107';
  const ghostNotFoundId = '91111111-1111-4111-8111-111111111108';
  const cliLiveId = '92222222-2222-4222-8222-222222222201';

  // Fake live ConversationService state on ephemeral loopback HTTP server
  const liveConvs = new Map([
    [idleParentId, { id: idleParentId, state: { runState: 'RUN_STATE_IDLE' } }],
    [idleSubId, { id: idleSubId, state: { runState: 'RUN_STATE_IDLE' } }],
    [forkKeepId, { id: forkKeepId, state: { runState: 'RUN_STATE_IDLE' } }],
    [genSummaryId, { id: genSummaryId, state: { runState: 'RUN_STATE_RUNNING' } }],
    [genLiveId, { id: genLiveId, state: { runState: 'RUN_STATE_RUNNING' } }],
    [protectedOnlineId, { id: protectedOnlineId, state: { runState: 'RUN_STATE_IDLE' } }],
  ]);
  const rpcLog = [];

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const body = rawBody ? JSON.parse(rawBody) : {};
      const method = String(req.url || '').replace(/^\/product\.v1\.ConversationService\//, '');
      rpcLog.push({
        method,
        body,
        connectProto: req.headers['connect-protocol-version'],
        antigravityCsrf: req.headers['x-antigravity-csrf-token'],
        contentType: req.headers['content-type'],
      });
      if (req.headers['x-antigravity-csrf-token'] !== csrfToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'unauthenticated', message: 'bad csrf' }));
        return;
      }
      if (method === 'ListConversations') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ conversations: Array.from(liveConvs.values()).slice(0, body.pageSize || 1) }));
        return;
      }
      if (method === 'GetConversation') {
        const hit = liveConvs.get(body.conversationId);
        if (!hit) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 'not_found', message: 'conversation not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(hit));
        return;
      }
      if (method === 'DeleteConversation') {
        const cid = body.conversationId;
        if (!liveConvs.has(cid)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 'not_found', message: 'conversation not found' }));
          return;
        }
        liveConvs.delete(cid);
        // Simulate host LS removing on-disk files for the deleted conversation
        rmSync(join(deskRoot, 'conversations', `${cid}.db`), { force: true });
        rmSync(join(deskRoot, 'brain', cid), { recursive: true, force: true });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'unimplemented', message: 'unknown method' }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    clearOnlineDeleteEndpointCache();

    // Seed Desktop daemon dir with a PID-reused dead-port hub (older mtime) AND the real live hub
    const staleHubPath = join(deskRoot, 'daemon', 'hub_1.json');
    const liveHubPath = join(deskRoot, 'daemon', `hub_${port}.json`);
    writeFileSync(
      staleHubPath,
      JSON.stringify({ pid: process.pid, httpPort: 1, csrfToken: 'stale-token' }),
      'utf8'
    );
    const pastTime = new Date(Date.now() - 60_000);
    utimesSync(staleHubPath, pastTime, pastTime);
    writeFileSync(
      liveHubPath,
      JSON.stringify({ pid: process.pid, httpPort: port, csrfToken }),
      'utf8'
    );

    // Per-client isolation checks
    const deskEp = await resolveClientOnlineDeleteEndpoint('desktop', { geminiDir });
    assert.ok(deskEp && deskEp.baseUrl === `http://127.0.0.1:${port}`, 'Desktop resolves live hub and skips PID-reused stale hub');
    assert.equal(
      await resolveClientOnlineDeleteEndpoint('cli', { geminiDir }),
      null,
      'CLI must never inherit Desktop hub endpoint'
    );
    assert.equal(
      await resolveClientOnlineDeleteEndpoint('ide_legacy', { geminiDir }),
      null,
      'Legacy IDE is strictly offline-only'
    );

    // Seed Desktop sessions + CLI cross-client index residual + migration archive protection
    for (const cid of [idleParentId, genSummaryId, genLiveId, ghostNotFoundId]) {
      createMinimalConvDb(join(deskRoot, 'conversations', `${cid}.db`), { cid });
      mkdirSync(join(deskRoot, 'brain', cid), { recursive: true });
    }
    // Migrated source protected by archive: no live .db, retains brain media + annotation + archive backup
    mkdirSync(join(deskRoot, 'brain', protectedOnlineId), { recursive: true });
    writeFileSync(join(deskRoot, 'brain', protectedOnlineId, 'img.png'), 'png', 'utf8');
    writeFileSync(join(deskRoot, 'annotations', `${protectedOnlineId}.pbtxt`), 'title:"Protected Source"\n', 'utf8');
    createMinimalConvDb(join(deskRoot, 'conversations', `${idleSubId}.db`), {
      cid: idleSubId,
      parentConversationId: idleParentId,
      nestingDepth: 1,
      subagentSpec: { typeName: 'research', role: 'Helper' },
    });
    mkdirSync(join(deskRoot, 'brain', idleSubId), { recursive: true });
    createMinimalConvDb(join(deskRoot, 'conversations', `${forkKeepId}.db`), {
      cid: forkKeepId,
      parentConversationId: idleParentId,
      nestingDepth: 0,
    });
    mkdirSync(join(deskRoot, 'brain', forkKeepId), { recursive: true });
    mkdirSync(join(backupDir, 'archived-sources', 'desktop'), { recursive: true });
    writeFileSync(join(backupDir, 'archived-sources', 'desktop', `${protectedOnlineId}_2026.db`), 'bak', 'utf8');

    const deskSum = initRichSummaryDb(join(deskRoot, 'conversation_summaries.db'));
    const ins = deskSum.prepare(
      `INSERT INTO conversation_summaries (
        conversation_id, title, preview, step_count, last_modified_time,
        status, parent_conversation_id, nesting_depth, app_data_dir
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    ins.run(idleParentId, 'Online Deletable Parent', '', 4, '2026-11-26 10:00:00+00:00', 'CASCADE_RUN_STATUS_IDLE', '', 0, 'antigravity');
    ins.run(idleSubId, 'Online Nested Subagent', '', 2, '2026-11-26 10:00:00+00:00', 'CASCADE_RUN_STATUS_IDLE', idleParentId, 1, 'antigravity');
    ins.run(forkKeepId, 'Online Kept Fork', '', 3, '2026-11-26 10:01:00+00:00', 'CASCADE_RUN_STATUS_IDLE', idleParentId, 0, 'antigravity');
    ins.run(genSummaryId, 'Generating In Summary', '', 5, '2026-11-26 10:02:00+00:00', 'CASCADE_RUN_STATUS_RUNNING', '', 0, 'antigravity');
    // Stale IDLE in summary DB, but LIVE server reports RUN_STATE_RUNNING!
    ins.run(genLiveId, 'Just Started Generating', '', 5, '2026-11-26 10:03:00+00:00', 'CASCADE_RUN_STATUS_IDLE', '', 0, 'antigravity');
    ins.run(indexOnlyId, 'Index Only Residual', '', 1, '2026-11-26 09:00:00+00:00', 'CASCADE_RUN_STATUS_IDLE', '', 0, 'antigravity');
    ins.run(protectedOnlineId, 'Protected Source', '', 2, '2026-11-26 09:30:00+00:00', 'CASCADE_RUN_STATUS_IDLE', '', 0, 'antigravity');
    ins.run(ghostNotFoundId, 'Unindexed Ghost', '', 1, '2026-11-26 08:00:00+00:00', 'CASCADE_RUN_STATUS_IDLE', '', 0, 'antigravity');
    deskSum.prepare('INSERT INTO conversation_parents VALUES (?, ?)').run(idleSubId, idleParentId);
    deskSum.close();

    // Idle CLI has a cross-client index residual for idleParentId + a live CLI session
    createMinimalConvDb(join(cliRoot, 'conversations', `${cliLiveId}.db`), { cid: cliLiveId });
    writeFileSync(
      join(cliRoot, 'jetbox_summaries_proto.pb'),
      Buffer.concat([makeProtoSummaryEntry(1, idleParentId, false), makeProtoSummaryEntry(1, cliLiveId, false)])
    );

    const cacheStore = createTrajectoryCacheStore({ sqliteFilePath: ledgerDbPath, enableSqlite: true });
    cacheStore.setCachedTrajectory(idleParentId, {
      title: 'Online Deletable Parent',
      appSource: 'standalone',
      steps: [
        {
          stepIndex: 0,
          createdAtMs: 1795000000000,
          modelKey: 'MODEL_CLAUDE_4_5_SONNET',
          inputTokens: 4000,
          outputTokens: 600,
          turnPrompt: 'Secret online prompt',
          isComplete: true,
        },
      ],
    });
    cacheStore.flushTrajectoryCacheNow();

    const runningDesktop = { desktop: true, cli: false, ide_legacy: false, checked: true };
    const sessionOpts = {
      geminiDir,
      backupDir,
      electronAppDataDir: appDataDir,
      cacheStore,
      runningClientsOverride: runningDesktop,
    };

    // 1. Async scan reports Desktop online-delete capability and per-session modes accurately
    const scan = await scanLocalSessionsAsync(sessionOpts);
    assert.equal(scan.onlineDeleteClients.desktop, true);
    assert.equal(scan.onlineDeleteClients.cli, false);
    assert.equal(scan.onlineDeleteClients.ide_legacy, false);
    const deskClientInfo = scan.clients.find((c) => c.id === 'desktop');
    assert.equal(deskClientInfo.onlineDeleteSupported, true);

    const byId = new Map(
      scan.sessions.filter((s) => s.clientId === 'desktop').map((s) => [s.sessionId, s])
    );
    assert.equal(byId.get(idleParentId).canDelete, true);
    assert.equal(byId.get(idleParentId).deleteMode, 'online');
    assert.equal(byId.get(genSummaryId).canDelete, false);
    assert.equal(byId.get(genSummaryId).deleteBlockedReason, 'session_running');
    assert.equal(byId.get(indexOnlyId).canDelete, false);
    assert.equal(byId.get(indexOnlyId).deleteBlockedReason, 'index_only_online');

    // Single scan also produces migrationCatalog with zero duplicate disk/SQLite reads
    assert.ok(scan.migrationCatalog && scan.migrationCatalog.available === true, 'Shared scan projects migrationCatalog');
    const migDeskIds = new Set((scan.migrationCatalog.sessionsByClient?.desktop || []).map((s) => s.cascadeId));
    assert.equal(migDeskIds.has(idleParentId), true);
    assert.equal(migDeskIds.has(forkKeepId), true);
    assert.equal(migDeskIds.has(idleSubId), false, 'Nested subagent excluded from migrationCatalog');
    assert.equal(migDeskIds.has(indexOnlyId), false, 'Index-only residual excluded from migrationCatalog');

    // 2. Async preview catches live RUN_STATE_RUNNING, live not_found, indexOnly, and online migration protection
    const preview = await previewSessionCleanupAsync(
      {
        targets: [
          { clientId: 'desktop', sessionId: idleParentId },
          { clientId: 'desktop', sessionId: genSummaryId },
          { clientId: 'desktop', sessionId: genLiveId },
          { clientId: 'desktop', sessionId: indexOnlyId },
          { clientId: 'desktop', sessionId: protectedOnlineId },
          { clientId: 'desktop', sessionId: ghostNotFoundId },
        ],
      },
      sessionOpts
    );
    assert.equal(preview.onlineDeletableCount, 2, 'idleParentId + protectedOnlineId pass pre-check');
    assert.equal(preview.offlineDeletableCount, 0);
    assert.equal(preview.protectedMigrationOnlineCount, 1);
    assert.equal(preview.cascadeSubagentCount, 1);
    const blockedMap = new Map(preview.blockedByRunning.map((b) => [b.sessionId, b.reason]));
    assert.equal(blockedMap.get(genSummaryId), 'session_running');
    assert.equal(blockedMap.get(genLiveId), 'session_running', 'Live GetConversation caught newly-running session');
    assert.equal(blockedMap.get(indexOnlyId), 'index_only_online');
    assert.equal(blockedMap.get(ghostNotFoundId), 'not_found_in_running_client');

    // 3. Execute online delete via dispatchBridgeApiRequest (default preserveProtectedBrain: true)
    const delHttp = await dispatchBridgeApiRequest(
      '/api/sessions/delete',
      'POST',
      {
        targets: [
          { clientId: 'desktop', sessionId: idleParentId },
          { clientId: 'desktop', sessionId: genLiveId },
          { clientId: 'desktop', sessionId: indexOnlyId },
          { clientId: 'desktop', sessionId: protectedOnlineId },
          { clientId: 'desktop', sessionId: ghostNotFoundId },
        ],
        redactLedger: true,
        clearBrowserCache: true,
        preserveProtectedBrain: true,
      },
      { sessionOptions: sessionOpts }
    );
    assert.equal(delHttp.status, 200);
    const delBody = JSON.parse(delHttp.body);
    assert.equal(delBody.ok, true);
    assert.equal(delBody.deletedCount, 1);
    assert.equal(delBody.onlineDeletedCount, 1);
    assert.equal(delBody.offlineDeletedCount, 0);
    assert.equal(delBody.cascadeSubagentCount, 1, 'Cascaded idle nested subagent via official DeleteConversation');
    assert.equal(delBody.crossOrphanCleanedCount, 1, 'Cleaned idle CLI cross-client residual safely');
    assert.equal(delBody.ledgerRedaction.redactedConversations, 1, 'Live-redacted own plugin ledger');

    const failMap = new Map(delBody.failed.map((f) => [f.sessionId, f.error]));
    assert.equal(failMap.get(genLiveId), 'session_running');
    assert.equal(failMap.get(indexOnlyId), 'index_only_online');
    assert.equal(failMap.get(protectedOnlineId), 'protected_migration_online');
    assert.equal(failMap.get(ghostNotFoundId), 'not_found_in_running_client');

    // Verify wire headers, /fork preservation, browser cache untouched while Desktop running, and ledger redaction
    const deleteCalls = rpcLog.filter((c) => c.method === 'DeleteConversation');
    assert.deepEqual(
      deleteCalls.map((c) => c.body.conversationId),
      [idleParentId, idleSubId],
      'Called DeleteConversation only on idle parent and nested subagent (never on /fork or protected)'
    );
    assert.equal(deleteCalls[0].connectProto, '1');
    assert.equal(deleteCalls[0].antigravityCsrf, csrfToken);
    assert.equal(liveConvs.has(forkKeepId), true, '/fork must be preserved');
    assert.equal(liveConvs.has(protectedOnlineId), true, 'Protected source untouched unless opted in');
    assert.equal(existsSync(join(appDataDir, 'Cache', 'keep-while-running')), true, 'Desktop browser cache untouched while Desktop running');
    const cliProtoAfter = parseSummaryProtoIndexIds(readFileSync(join(cliRoot, 'jetbox_summaries_proto.pb')));
    assert.equal(cliProtoAfter.has(idleParentId), false);
    assert.equal(cliProtoAfter.has(cliLiveId), true);

    const hydrated = cacheStore.getHydratedTrajectory(idleParentId);
    assert.equal(hydrated.title, '[Deleted Session]');
    assert.equal(hydrated.steps[0].inputTokens, 4000, 'Token totals 100% preserved');
    assert.equal(hydrated.steps[0].turnPrompt, undefined, 'User prompt scrubbed');

    // 4. Explicitly opting in preserveProtectedBrain: false allows online deletion of protected source
    const purgeRes = await deleteLocalSessionsAsync(
      { targets: [{ clientId: 'desktop', sessionId: protectedOnlineId }], preserveProtectedBrain: false },
      sessionOpts
    );
    assert.equal(purgeRes.ok, true);
    assert.equal(purgeRes.onlineDeletedCount, 1);
    assert.equal(liveConvs.has(protectedOnlineId), false);
  } finally {
    clearOnlineDeleteEndpointCache();
    await new Promise((resolve) => server.close(resolve));
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('SessionManagerCard reflects online deletion mode, generating/indexOnly guards, and online protected opt-in', async () => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const { document: doc } = createMockDom();
  globalThis.document = doc;
  globalThis.window = { document: doc };

  try {
    const { SessionManagerCard } = await import('../src/components/settings/SessionManagerCard.js');
    const sidOk = 'a1111111-1111-4111-8111-111111111101';
    const sidGen = 'a1111111-1111-4111-8111-111111111102';
    const sidIdx = 'a1111111-1111-4111-8111-111111111103';

    let receivedDeletePayload = null;
    const card = SessionManagerCard({
      loadList: async () => ({
        ok: true,
        clients: [
          { id: 'desktop', exists: true, running: true, onlineDeleteSupported: true, sessionCount: 3, indexOnlyCount: 1 },
        ],
        runningClients: { desktop: true, cli: false, ide_legacy: false, checked: true },
        onlineDeleteClients: { desktop: true, cli: false, ide_legacy: false },
        sessions: [
          {
            sessionId: sidOk,
            cascadeId: sidOk,
            clientId: 'desktop',
            title: 'Idle Online Session',
            workspaceName: 'repo',
            sizeBytes: 4096,
            lastModifiedMs: Date.now() - 1000,
            indexOnly: false,
            sessionRunning: false,
            clientRunning: true,
            canDelete: true,
            deleteMode: 'online',
            deleteBlockedReason: '',
            protectedByMigration: true,
            telemetry: { recorded: false, stepCount: 0, totalTokens: 0, costUsd: 0, hasUsage: false },
          },
          {
            sessionId: sidGen,
            cascadeId: sidGen,
            clientId: 'desktop',
            title: 'Active Generating Session',
            workspaceName: 'repo',
            sizeBytes: 2048,
            lastModifiedMs: Date.now() - 2000,
            indexOnly: false,
            sessionRunning: true,
            clientRunning: true,
            canDelete: false,
            deleteMode: 'blocked',
            deleteBlockedReason: 'session_running',
            telemetry: { recorded: false, stepCount: 0, totalTokens: 0, costUsd: 0, hasUsage: false },
          },
          {
            sessionId: sidIdx,
            cascadeId: sidIdx,
            clientId: 'desktop',
            title: 'Index Only Ghost',
            workspaceName: 'repo',
            sizeBytes: 0,
            lastModifiedMs: Date.now() - 3000,
            indexOnly: true,
            sessionRunning: false,
            clientRunning: true,
            canDelete: false,
            deleteMode: 'blocked',
            deleteBlockedReason: 'index_only_online',
            telemetry: { recorded: false, stepCount: 0, totalTokens: 0, costUsd: 0, hasUsage: false },
          },
        ],
        counts: { total: 3, indexOnly: 1, byClient: { desktop: 3, cli: 0, ide_legacy: 0 } },
        warnings: [],
      }),
      loadPreview: async ({ targets }) => ({
        ok: true,
        runningClients: { desktop: true, cli: false, ide_legacy: false, checked: true },
        onlineDeleteClients: { desktop: true, cli: false, ide_legacy: false },
        deletableCount: targets.length,
        onlineDeletableCount: targets.length,
        offlineDeletableCount: 0,
        protectedMigrationOnlineCount: 1,
        protectedMigrationItems: [{ clientId: 'desktop', sessionId: sidOk, hasBrain: true, mode: 'online' }],
        cascadeSubagentCount: 0,
        crossSourceIndexMatches: [],
        orphanIndexMatches: [],
        blockedByRunning: [],
      }),
      runDelete: async (payload) => {
        receivedDeletePayload = payload;
        return {
          ok: true,
          deletedCount: 1,
          onlineDeletedCount: 1,
          offlineDeletedCount: 0,
          failedCount: 0,
          deleted: payload.targets,
          failed: [],
          warnings: [],
        };
      },
    });

    await card.refs.ensureLoaded();

    // Guard notice stays hidden when all running clients already support online deletion (no noisy banner)
    const noticeEl = card.el.querySelector('.smgr-guard-notice');
    assert.equal(noticeEl.hasAttribute('hidden'), true);

    // Reveal indexOnly to inspect all 3 rows
    card.refs.hideIdxBtn.dispatchEvent({ type: 'click', target: card.refs.hideIdxBtn });
    const rows = card.refs.listEl.querySelectorAll('.smgr-item');
    assert.equal(rows.length, 3);
    assert.equal(rows[0].querySelector('.smgr-checkbox').hasAttribute('disabled'), false, 'Idle Desktop session is checkable online');
    assert.equal(rows[1].querySelector('.smgr-checkbox').hasAttribute('disabled'), true, 'Generating session is disabled');
    assert.match(rows[1].querySelector('.smgr-checkbox').getAttribute('title'), /生成中|generating/i);
    assert.equal(rows[2].querySelector('.smgr-checkbox').hasAttribute('disabled'), true, 'Index-only session disabled while running');
    assert.match(rows[2].querySelector('.smgr-checkbox').getAttribute('title'), /仅索引|index-only/i);

    // Select online-protected session and open confirm drawer: Confirm button must stay disabled until user explicitly opts in
    rows[0].dispatchEvent({ type: 'click', target: rows[0] });
    card.refs.batchDeleteBtn.dispatchEvent({ type: 'click', target: card.refs.batchDeleteBtn });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(card.refs.confirmBoxEl.hasAttribute('hidden'), false);
    assert.equal(
      card.refs.confirmBoxEl.querySelector('.smgr-confirm-exec-btn').hasAttribute('disabled'),
      true,
      'Online migration-protected item requires explicit opt-in before deleting'
    );
    const protToggle = card.refs.confirmBoxEl.querySelector('.smgr-confirm-protected-toggle');
    assert.ok(protToggle);
    protToggle.dispatchEvent({ type: 'click', target: protToggle });
    const execBtnAfter = card.refs.confirmBoxEl.querySelector('.smgr-confirm-exec-btn');
    assert.equal(execBtnAfter.hasAttribute('disabled'), false, 'Confirm button enables once user checks purge opt-in');
    execBtnAfter.dispatchEvent({ type: 'click', target: execBtnAfter });
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(receivedDeletePayload);
    assert.equal(receivedDeletePayload.preserveProtectedBrain, false);
    assert.equal(receivedDeletePayload.clearBrowserCache, false, 'Never requests Desktop browser cache clear while Desktop is running');

    card.destroy();
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  }
});

test('accurate recursive brain storage size, .db/.db-wal/.db-shm summing, symlink skip, subagent rollup, client/total aggregates, and preview reclaimableSizeBytes', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'ag-smgr-storage-'));
  const geminiDir = join(tempRoot, '.gemini');
  const outsideSecretDir = join(tempRoot, 'outside-big-dir');
  const idle = { desktop: false, cli: false, ide_legacy: false, checked: true };

  try {
    clearSessionManagerScanCaches();
    const deskRoot = join(geminiDir, 'antigravity');
    const cliRoot = join(geminiDir, 'antigravity-cli');
    for (const r of [deskRoot, cliRoot]) {
      mkdirSync(join(r, 'conversations'), { recursive: true });
      mkdirSync(join(r, 'brain'), { recursive: true });
      mkdirSync(join(r, 'annotations'), { recursive: true });
    }
    mkdirSync(outsideSecretDir, { recursive: true });
    writeFileSync(join(outsideSecretDir, 'huge-outside.bin'), Buffer.alloc(2 * 1024 * 1024, 0x41));

    const parentId = 'c1000000-0000-4000-8000-000000000001';
    const childSubId = 'c1000000-0000-4000-8000-000000000002';
    const grandSubId = 'c1000000-0000-4000-8000-000000000003';
    const forkId = 'c1000000-0000-4000-8000-000000000004';
    const cliId = 'c2000000-0000-4000-8000-000000000001';

    createMinimalConvDb(join(deskRoot, 'conversations', `${parentId}.db`), { cid: parentId });
    createMinimalConvDb(join(deskRoot, 'conversations', `${childSubId}.db`), {
      cid: childSubId,
      parentConversationId: parentId,
      nestingDepth: 1,
      subagentSpec: { typeName: 'research', role: 'Child Worker' },
    });
    createMinimalConvDb(join(deskRoot, 'conversations', `${grandSubId}.db`), {
      cid: grandSubId,
      parentConversationId: childSubId,
      nestingDepth: 2,
      subagentSpec: { typeName: 'research', role: 'Grandchild Worker' },
    });
    createMinimalConvDb(join(deskRoot, 'conversations', `${forkId}.db`), {
      cid: forkId,
      parentConversationId: parentId,
      nestingDepth: 0,
    });
    createMinimalConvDb(join(cliRoot, 'conversations', `${cliId}.db`), { cid: cliId });

    // Companion SQLite WAL + SHM files on parentId
    const walBytes = 4096;
    const shmBytes = 32768;
    writeFileSync(join(deskRoot, 'conversations', `${parentId}.db-wal`), Buffer.alloc(walBytes, 0x11));
    writeFileSync(join(deskRoot, 'conversations', `${parentId}.db-shm`), Buffer.alloc(shmBytes, 0x22));

    // Nested brain files under parentId (including .system_generated/steps, browser_sandbox, scratch, and a junction/symlink to outside)
    const parentBrain = join(deskRoot, 'brain', parentId);
    mkdirSync(join(parentBrain, '.system_generated', 'logs'), { recursive: true });
    mkdirSync(join(parentBrain, '.system_generated', 'steps', '12', 'nested'), { recursive: true });
    mkdirSync(join(parentBrain, 'browser_sandbox', 'frames'), { recursive: true });
    mkdirSync(join(parentBrain, 'scratch', 'deep'), { recursive: true });
    writeFileSync(join(parentBrain, 'walkthrough.md'), Buffer.alloc(500, 0x61));
    writeFileSync(join(parentBrain, '.system_generated', 'logs', 'transcript_full.jsonl'), Buffer.alloc(1200, 0x62));
    writeFileSync(join(parentBrain, '.system_generated', 'steps', '12', 'output.txt'), Buffer.alloc(15000, 0x63));
    writeFileSync(join(parentBrain, '.system_generated', 'steps', '12', 'nested', 'chunk.bin'), Buffer.alloc(8000, 0x64));
    writeFileSync(join(parentBrain, 'browser_sandbox', 'frames', 'shot.png'), Buffer.alloc(25000, 0x65));
    writeFileSync(join(parentBrain, 'scratch', 'deep', 'notes.txt'), Buffer.alloc(300, 0x66));
    const expectedParentBrainBytes = 500 + 1200 + 15000 + 8000 + 25000 + 300;

    // Create symlink/junction pointing outside; scanner MUST skip it without counting the 2 MB outside file
    const linkPath = join(parentBrain, 'linked-outside');
    try {
      symlinkSync(outsideSecretDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // Ignore if environment disallows symlink/junction creation
    }

    // Subagent & grandchild brain artifacts
    mkdirSync(join(deskRoot, 'brain', childSubId, '.system_generated', 'steps', '1'), { recursive: true });
    writeFileSync(join(deskRoot, 'brain', childSubId, '.system_generated', 'steps', '1', 'out.txt'), Buffer.alloc(6000, 0x71));
    mkdirSync(join(deskRoot, 'brain', grandSubId, 'scratch'), { recursive: true });
    writeFileSync(join(deskRoot, 'brain', grandSubId, 'scratch', 'leaf.bin'), Buffer.alloc(4000, 0x72));

    // Fork and CLI brain artifacts + annotation
    mkdirSync(join(deskRoot, 'brain', forkId), { recursive: true });
    writeFileSync(join(deskRoot, 'brain', forkId, 'fork.md'), Buffer.alloc(2500, 0x73));
    mkdirSync(join(cliRoot, 'brain', cliId, '.system_generated', 'steps', '3'), { recursive: true });
    writeFileSync(join(cliRoot, 'brain', cliId, '.system_generated', 'steps', '3', 'cli.log'), Buffer.alloc(11000, 0x74));
    const cliAnnBytes = 42;
    writeFileSync(join(cliRoot, 'annotations', `${cliId}.pbtxt`), 'title:"CLI Storage Test"\n'.padEnd(cliAnnBytes, ' '), 'utf8');

    const deskSum = initRichSummaryDb(join(deskRoot, 'conversation_summaries.db'));
    const insDesk = deskSum.prepare(
      `INSERT INTO conversation_summaries (
        conversation_id, title, step_count, last_modified_time, status, parent_conversation_id, nesting_depth, app_data_dir
      ) VALUES (?, ?, 4, '2026-11-26 10:00:00+00:00', 'CASCADE_RUN_STATUS_IDLE', ?, ?, 'antigravity')`
    );
    insDesk.run(parentId, 'Parent With Nested Storage', '', 0);
    insDesk.run(childSubId, 'Child Subagent', parentId, 1);
    insDesk.run(grandSubId, 'Grandchild Subagent', childSubId, 2);
    insDesk.run(forkId, 'Independent Fork', parentId, 0);
    deskSum.prepare('INSERT INTO conversation_parents VALUES (?, ?)').run(childSubId, parentId);
    deskSum.prepare('INSERT INTO conversation_parents VALUES (?, ?)').run(grandSubId, childSubId);
    deskSum.close();

    const cliSum = initRichSummaryDb(join(cliRoot, 'conversation_summaries.db'));
    cliSum
      .prepare(
        `INSERT INTO conversation_summaries (
          conversation_id, title, step_count, last_modified_time, status, app_data_dir
        ) VALUES (?, 'CLI Session', 3, '2026-11-26 10:05:00+00:00', 'CASCADE_RUN_STATUS_IDLE', 'antigravity-cli')`
      )
      .run(cliId);
    cliSum.close();

    const parentDbRaw = statSync(join(deskRoot, 'conversations', `${parentId}.db`)).size;
    const childDbRaw = statSync(join(deskRoot, 'conversations', `${childSubId}.db`)).size;
    const grandDbRaw = statSync(join(deskRoot, 'conversations', `${grandSubId}.db`)).size;
    const forkDbRaw = statSync(join(deskRoot, 'conversations', `${forkId}.db`)).size;
    const cliDbRaw = statSync(join(cliRoot, 'conversations', `${cliId}.db`)).size;

    const expectedParentOwnDb = parentDbRaw + walBytes + shmBytes;
    const expectedSubTotal = (childDbRaw + 6000) + (grandDbRaw + 4000);
    const expectedParentTotal = expectedParentOwnDb + expectedParentBrainBytes + expectedSubTotal;
    const expectedForkTotal = forkDbRaw + 2500;
    const expectedCliTotal = cliDbRaw + 11000 + cliAnnBytes;

    // Also test bounded depth & entry caps on sumVerifiedDirTreeBytes directly
    const cappedDepth = sumVerifiedDirTreeBytes(parentBrain, { maxDepth: 0 });
    assert.equal(cappedDepth.sizeBytes, 500, 'maxDepth=0 counts only root-level files');
    assert.equal(cappedDepth.truncated, true);
    const cappedEntries = sumVerifiedDirTreeBytes(parentBrain, { maxEntries: 2 });
    assert.equal(cappedEntries.truncated, true);

    const scan = scanLocalSessions({ geminiDir, runningClientsOverride: idle });
    assert.equal(scan.ok, true);

    const parentRec = scan.sessions.find((s) => s.sessionId === parentId);
    const forkRec = scan.sessions.find((s) => s.sessionId === forkId);
    const cliRec = scan.sessions.find((s) => s.sessionId === cliId);

    assert.ok(parentRec && forkRec && cliRec);
    assert.equal(parentRec.subagentCount, 2, 'Rolls up both direct child and grandchild subagents');
    assert.equal(parentRec.sizeBytes, expectedParentTotal, 'Includes .db/.db-wal/.db-shm, deep brain tree, and rolled-up subagents while skipping symlink');
    assert.equal(parentRec.dbSizeBytes, expectedParentOwnDb + childDbRaw + grandDbRaw);
    assert.equal(parentRec.brainSizeBytes, expectedParentBrainBytes + 6000 + 4000);
    assert.equal(parentRec.subagentSizeBytes, expectedSubTotal);
    assert.equal(forkRec.sizeBytes, expectedForkTotal, '/fork stays independent and is not rolled into parent');
    assert.equal(cliRec.sizeBytes, expectedCliTotal);

    const deskClient = scan.clients.find((c) => c.id === 'desktop');
    const cliClient = scan.clients.find((c) => c.id === 'cli');
    assert.equal(deskClient.totalSizeBytes, expectedParentTotal + expectedForkTotal);
    assert.equal(cliClient.totalSizeBytes, expectedCliTotal);
    assert.equal(scan.counts.totalSizeBytes, expectedParentTotal + expectedForkTotal + expectedCliTotal);
    assert.equal(scan.counts.byClientSizeBytes.desktop, expectedParentTotal + expectedForkTotal);
    assert.equal(scan.counts.byClientSizeBytes.cli, expectedCliTotal);

    // migrationCatalog projection exposes full session sizeBytes + dbSizeBytes
    const migParent = scan.migrationCatalog.sessionsByClient.desktop.find((s) => s.cascadeId === parentId);
    assert.ok(migParent);
    assert.equal(migParent.sizeBytes, expectedParentTotal);
    assert.equal(migParent.dbSizeBytes, expectedParentOwnDb);

    // previewSessionCleanup calculates exact reclaimableSizeBytes (parent + cascaded subagents, excluding /fork)
    const preview = previewSessionCleanup(
      { targets: [{ clientId: 'desktop', sessionId: parentId }] },
      { geminiDir, runningClientsOverride: idle }
    );
    assert.equal(preview.cascadeSubagentCount, 2);
    assert.equal(preview.reclaimableSizeBytes, expectedParentTotal);
  } finally {
    clearSessionManagerScanCaches();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('formatCompactBytes (B/KB/MB/GB) and SessionManagerCard / SessionMigrationCard render per-session, total, filtered, selected, and reclaimable storage sizes', async () => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const { document: doc } = createMockDom();
  globalThis.document = doc;
  globalThis.window = { document: doc };

  try {
    const { formatCompactBytes } = await import('../src/core/formatters.js');
    const { SessionManagerCard } = await import('../src/components/settings/SessionManagerCard.js');
    const { SessionMigrationCard } = await import('../src/components/settings/SessionMigrationCard.js');

    // 1. formatCompactBytes unit coverage (edge cases + B / KB / MB / GB + rounding boundary promotion)
    assert.equal(formatCompactBytes(0), '0 B');
    assert.equal(formatCompactBytes(-128), '0 B');
    assert.equal(formatCompactBytes(Number.NaN), '0 B');
    assert.equal(formatCompactBytes(undefined), '0 B');
    assert.equal(formatCompactBytes(512), '512 B');
    assert.equal(formatCompactBytes(1024), '1 KB');
    assert.equal(formatCompactBytes(1536), '1.5 KB');
    assert.equal(formatCompactBytes(10 * 1024), '10 KB');
    assert.equal(formatCompactBytes(1023.9 * 1024), '1.0 MB');
    assert.equal(formatCompactBytes(50 * 1024 * 1024), '50.0 MB');
    assert.equal(formatCompactBytes(1023.99 * 1024 * 1024), '1.00 GB');
    assert.equal(formatCompactBytes(1.5 * 1024 * 1024 * 1024), '1.50 GB');
    assert.equal(formatCompactBytes(12.34 * 1024 * 1024 * 1024), '12.3 GB');

    const sLarge = 'd1000000-0000-4000-8000-000000000001';
    const sSmall = 'd1000000-0000-4000-8000-000000000002';
    const largeBytes = Math.round(1.5 * 1024 * 1024 * 1024); // 1.50 GB
    const smallBytes = 20 * 1024 * 1024; // 20.0 MB
    const now = Date.now();

    const card = SessionManagerCard({
      loadList: async () => ({
        ok: true,
        clients: [
          { id: 'desktop', exists: true, running: false, sessionCount: 1, totalSizeBytes: largeBytes },
          { id: 'cli', exists: true, running: false, sessionCount: 1, totalSizeBytes: smallBytes },
        ],
        runningClients: { desktop: false, cli: false, ide_legacy: false, checked: true },
        onlineDeleteClients: { desktop: false, cli: false, ide_legacy: false },
        sessions: [
          {
            sessionId: sLarge,
            cascadeId: sLarge,
            clientId: 'desktop',
            title: 'Large Media Session',
            workspaceName: 'app',
            sizeBytes: largeBytes,
            dbSizeBytes: 5 * 1024 * 1024,
            brainSizeBytes: largeBytes - 5 * 1024 * 1024,
            subagentSizeBytes: 120 * 1024 * 1024,
            lastModifiedMs: now - 1000,
            indexOnly: false,
            canDelete: true,
            subagentCount: 2,
            telemetry: { recorded: false },
          },
          {
            sessionId: sSmall,
            cascadeId: sSmall,
            clientId: 'cli',
            title: 'CLI Compact Session',
            workspaceName: 'cli-repo',
            sizeBytes: smallBytes,
            dbSizeBytes: 4 * 1024 * 1024,
            brainSizeBytes: 16 * 1024 * 1024,
            subagentSizeBytes: 0,
            lastModifiedMs: now - 2000,
            indexOnly: false,
            canDelete: true,
            subagentCount: 0,
            telemetry: { recorded: false },
          },
        ],
        counts: {
          total: 2,
          indexOnly: 0,
          totalSizeBytes: largeBytes + smallBytes,
          byClient: { desktop: 1, cli: 1, ide_legacy: 0 },
          byClientSizeBytes: { desktop: largeBytes, cli: smallBytes, ide_legacy: 0 },
        },
        warnings: [],
      }),
      loadPreview: async () => ({
        ok: true,
        deletableCount: 1,
        offlineDeletableCount: 1,
        onlineDeletableCount: 0,
        reclaimableSizeBytes: largeBytes,
        protectedOnlineSizeBytes: 0,
        cascadeSubagentCount: 2,
        crossSourceIndexMatches: [],
        orphanIndexMatches: [],
        protectedMigrationItems: [],
        blockedByRunning: [],
      }),
    });

    await card.refs.ensureLoaded();

    // Header total storage badge reflects full total
    assert.equal(card.refs.totalSizeBadge.hasAttribute('hidden'), false);
    assert.equal(card.refs.totalSizeBadge.textContent, formatCompactBytes(largeBytes + smallBytes));

    // Per-session cards render prominent .smgr-size-badge with breakdown tooltip and no duplicate size in .smgr-item-meta
    const items = card.refs.listEl.querySelectorAll('.smgr-item');
    assert.equal(items.length, 2);
    const largeBadge = items[0].querySelector('.smgr-size-badge');
    assert.ok(largeBadge);
    assert.equal(largeBadge.textContent, '1.50 GB');
    assert.equal(largeBadge.classList.contains('is-large'), true);
    assert.match(largeBadge.getAttribute('title'), /5\.0 MB/);
    assert.match(largeBadge.getAttribute('title'), /120\.0 MB/);
    assert.doesNotMatch(items[0].querySelector('.smgr-item-meta').textContent, /GB|MB/);

    // Filtering via search updates header total storage badge dynamically
    card.refs.searchInput.value = 'CLI Compact';
    card.refs.searchInput.dispatchEvent({ type: 'input', target: card.refs.searchInput });
    assert.equal(card.refs.totalSizeBadge.textContent, '20.0 MB');
    assert.equal(card.refs.totalSizeBadge.classList.contains('is-filtered'), true);
    card.refs.searchInput.value = '';
    card.refs.searchInput.dispatchEvent({ type: 'input', target: card.refs.searchInput });
    assert.equal(card.refs.totalSizeBadge.textContent, formatCompactBytes(largeBytes + smallBytes));

    // Selecting sessions shows selected total storage in action bar and reclaimable storage in confirm drawer
    assert.equal(card.refs.selectedSizeEl.hasAttribute('hidden'), true);
    const firstRow = card.refs.listEl.querySelectorAll('.smgr-item')[0];
    firstRow.dispatchEvent({ type: 'click', target: firstRow });
    assert.equal(card.refs.selectedSizeEl.hasAttribute('hidden'), false);
    assert.equal(card.refs.selectedSizeEl.textContent, '1.50 GB');

    card.refs.batchDeleteBtn.dispatchEvent({ type: 'click', target: card.refs.batchDeleteBtn });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(card.refs.confirmBoxEl.hasAttribute('hidden'), false);
    assert.match(card.refs.confirmBoxEl.textContent, /1\.50 GB/);

    card.destroy();

    // SessionMigrationCard displays compact storage size on migration rows
    const migCard = SessionMigrationCard({});
    migCard.refs.applyCatalog({
      available: true,
      sqliteSupported: true,
      clients: [
        { id: 'cli', exists: true, canBeSource: true, canBeTarget: true, sessionCount: 1 },
        { id: 'desktop', exists: true, canBeSource: true, canBeTarget: true, sessionCount: 0 },
      ],
      sessionsByClient: {
        cli: [
          {
            cascadeId: sSmall,
            clientId: 'cli',
            title: 'Migratable Session',
            stepCount: 8,
            sizeBytes: smallBytes,
            lastModifiedMs: now - 3000,
            workspaceName: 'cli-repo',
            isRunning: false,
          },
        ],
        desktop: [],
      },
      desktopProjects: [{ projectId: 'outside-of-project', isOutsideProject: true }],
    });
    const migMeta = migCard.el.querySelector('.smig-item-meta');
    assert.ok(migMeta);
    assert.match(migMeta.textContent, /20\.0 MB/);
    migCard.destroy();
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
  }
});
