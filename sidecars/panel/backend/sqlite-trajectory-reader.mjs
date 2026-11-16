/**
 * @fileoverview Direct read-only SQLite + Protobuf reader for Antigravity
 * `conversation_summaries.db` and `conversations/<cascade_id>.db` (Option C).
 *
 * Eliminates `GetAllCascadeTrajectories` and `GetCascadeTrajectory` RPCs,
 * avoids loading 95%+ of `step_payload` overflow pages, and filters cloned
 * parent steps/generations on `SIDE_QUESTION` (`trajectory_type = 22`) and
 * cross-conversation forks.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync as NodeDatabaseSync } from 'node:sqlite';
import {
  pbDecodeCascadeTrajectorySummary,
  pbDecodeGeneratorMetadata,
  pbDecodeStepMetadata,
  pbDecodeStepPayload,
  pbDecodeTrajectoryMetadata,
  pbDecodeTrajectoryReference,
  pbMapStepStatus,
  pbMapStepType,
} from './protobuf-wire.mjs';

const SqliteDatabaseSync =
  typeof NodeDatabaseSync === 'function' ? NodeDatabaseSync : globalThis.DatabaseSync;

const SQLITE_DEFAULT_DIR_SCAN_TTL_MS = 30_000;
const SQLITE_MAX_SUMMARIES_MEMO = 8;
const SQLITE_IN_CLAUSE_CHUNK = 400;

const sqliteSummariesMemo = new Map();
const sqliteDirScanMemo = new Map();

function sqliteResolveDatabaseSync() {
  if (typeof SqliteDatabaseSync === 'function') return SqliteDatabaseSync;
  if (typeof globalThis.DatabaseSync === 'function') return globalThis.DatabaseSync;
  return null;
}

export function resetSqliteReaderCaches() {
  sqliteSummariesMemo.clear();
  sqliteDirScanMemo.clear();
}

/**
 * Computes a WAL-aware composite file signature (`db` + `db-wal`, ignoring `-shm`).
 *
 * @param {string} dbPath
 * @returns {{ exists: boolean, mtimeMs: number, sig: string }}
 */
export function computeSqliteWalFileSig(dbPath) {
  if (!dbPath || typeof dbPath !== 'string' || !existsSync(dbPath)) {
    return { exists: false, mtimeMs: 0, sig: '' };
  }
  let dbStat = null;
  try {
    dbStat = statSync(dbPath);
  } catch {
    return { exists: false, mtimeMs: 0, sig: '' };
  }
  if (!dbStat) {
    return { exists: false, mtimeMs: 0, sig: '' };
  }

  const walPath = `${dbPath}-wal`;
  let walStat = null;
  if (existsSync(walPath)) {
    try {
      walStat = statSync(walPath);
    } catch {
      walStat = null;
    }
  }

  const dbMtimeMs = Number(dbStat.mtimeMs || 0);
  const dbSize = Number(dbStat.size || 0);
  const walMtimeMs = Number(walStat?.mtimeMs || 0);
  const walSize = Number(walStat?.size || 0);
  const mtimeMs = Math.max(dbMtimeMs, walMtimeMs);
  const sig = `${Math.floor(dbMtimeMs)}:${dbSize}|${Math.floor(walMtimeMs)}:${walSize}`;

  return { exists: true, mtimeMs, sig };
}

/**
 * Checks whether `node:sqlite` `DatabaseSync` is available and `summariesDbPath` exists.
 *
 * @param {string} [summariesDbPath]
 * @returns {boolean}
 */
export function isSqliteReaderAvailable(summariesDbPath) {
  const DbSync = sqliteResolveDatabaseSync();
  const targetPath =
    summariesDbPath === undefined
      ? join(homedir(), '.gemini', 'antigravity', 'conversation_summaries.db')
      : summariesDbPath;
  return Boolean(typeof DbSync === 'function' && targetPath && existsSync(targetPath));
}

function sqliteIsBusyError(err) {
  const msg = String(err?.message || err?.code || '');
  return /SQLITE_BUSY|database is locked/i.test(msg);
}

function sqliteWithReadOnlyDb(dbPath, queryFn) {
  const DbSync = sqliteResolveDatabaseSync();
  if (typeof DbSync !== 'function') {
    throw new Error('DatabaseSync is not available in current runtime');
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    let db = null;
    try {
      db = new DbSync(dbPath, { readOnly: true, timeout: 2000 });
      try {
        db.exec('PRAGMA busy_timeout = 1000;');
      } catch {
        // Ignore if PRAGMA is unsupported by a custom test stub.
      }
      return queryFn(db);
    } catch (err) {
      if (attempt === 0 && sqliteIsBusyError(err)) {
        continue;
      }
      throw err;
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          // Ignore close error in finally.
        }
      }
    }
  }
  return null;
}

function sqliteNormalizeSqlTimestamp(raw) {
  const str = String(raw || '').trim();
  if (!str || str.startsWith('0001-01-01') || str.startsWith('1970-01-01 00:00:00')) {
    return '';
  }
  return str
    .replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/, '$1T$2')
    .replace(/\+00:00$/, 'Z');
}

function sqliteDefaultConversationsDirs() {
  const home = homedir();
  return [
    { dir: join(home, '.gemini', 'antigravity', 'conversations'), appSource: 'standalone' },
    { dir: join(home, '.gemini', 'antigravity-cli', 'conversations'), appSource: 'cli' },
  ];
}

function sqliteNormalizeConversationsDirs(conversationsDirs) {
  const rawList =
    Array.isArray(conversationsDirs) && conversationsDirs.length > 0
      ? conversationsDirs
      : sqliteDefaultConversationsDirs();
  const out = [];
  for (const item of rawList) {
    if (typeof item === 'string' && item.trim()) {
      const dir = item.trim();
      const appSource = /antigravity-cli/i.test(dir) ? 'cli' : 'standalone';
      out.push({ dir, appSource });
    } else if (item && typeof item === 'object' && typeof item.dir === 'string' && item.dir.trim()) {
      out.push({
        dir: item.dir.trim(),
        appSource: String(item.appSource || 'standalone').trim() || 'standalone',
      });
    }
  }
  return out;
}

function sqliteShouldPreferFileCandidate(existing, candidate) {
  if (!existing) return true;
  if (candidate.mtimeMs > existing.mtimeMs) return true;
  if (candidate.mtimeMs < existing.mtimeMs) return false;
  return candidate.appSource === 'standalone' && existing.appSource !== 'standalone';
}

/**
 * Reads `conversation_summaries` and `conversation_parents` from
 * `conversation_summaries.db`, memoized by WAL file signature.
 */
export function readSqliteConversationSummaries({
  summariesDbPath,
  forceRefresh = false,
} = {}) {
  const targetPath =
    summariesDbPath || join(homedir(), '.gemini', 'antigravity', 'conversation_summaries.db');
  const DbSync = sqliteResolveDatabaseSync();
  if (typeof DbSync !== 'function' || !targetPath || !existsSync(targetPath)) {
    return { available: false, sig: '', summaries: {}, sideQuestionParents: {} };
  }

  const walSig = computeSqliteWalFileSig(targetPath);
  if (!walSig.exists) {
    return { available: false, sig: '', summaries: {}, sideQuestionParents: {} };
  }

  const memoKey = `${targetPath}::${walSig.sig}`;
  if (!forceRefresh && sqliteSummariesMemo.has(memoKey)) {
    return sqliteSummariesMemo.get(memoKey);
  }

  const { summaries, sideQuestionParents } = sqliteWithReadOnlyDb(targetPath, (db) => {
    const summaryRows = db
      .prepare(
        `SELECT conversation_id, title, preview, step_count, last_modified_time,
                status, source, agent_name, parent_conversation_id, nesting_depth,
                not_fully_idle, killed, app_data_dir, raw_summary
         FROM conversation_summaries`
      )
      .all();

    let parentRows = [];
    try {
      parentRows = db
        .prepare('SELECT conversation_id, parent_id FROM conversation_parents')
        .all();
    } catch {
      parentRows = [];
    }

    const outSummaries = {};
    const outSideQuestionParents = {};

    for (const row of summaryRows) {
      const cid = String(row.conversation_id || '').trim().toLowerCase();
      if (!cid) continue;

      const decoded = row.raw_summary
        ? pbDecodeCascadeTrajectorySummary(row.raw_summary)
        : null;

      const sqlTitle = String(row.title || '');
      const sqlPreview = String(row.preview || '');
      const sqlStepCount = Number(row.step_count || 0);
      const sqlLastMod = sqliteNormalizeSqlTimestamp(row.last_modified_time);
      const sqlStatus = String(row.status || '');
      const sqlSource = String(row.source || '');
      const sqlAgentName = String(row.agent_name || '').trim();
      const sqlParentCid = String(row.parent_conversation_id || '').trim().toLowerCase();
      const sqlNestingDepth = Number(row.nesting_depth || 0);
      const sqlAppDataDir = String(row.app_data_dir || '');

      const rawMeta = decoded?.trajectoryMetadata || null;
      const parentConversationId =
        String(rawMeta?.parentConversationId || sqlParentCid || '')
          .trim()
          .toLowerCase();
      const rootConversationId =
        String(rawMeta?.rootConversationId || '')
          .trim()
          .toLowerCase();
      const agentName = String(rawMeta?.agentScript?.name || sqlAgentName || '').trim();
      const createdAt = String(rawMeta?.createdAt || decoded?.createdTime || '');
      const createdTime = String(decoded?.createdTime || rawMeta?.createdAt || '');
      const lastModifiedTime = String(decoded?.lastModifiedTime || sqlLastMod || createdTime || '');

      const sideQuestionIds = Array.isArray(decoded?.annotations?.sideQuestionCascadeIds)
        ? decoded.annotations.sideQuestionCascadeIds
        : [];
      const sideQuestionTitles = decoded?.annotations?.sideQuestionTitles || {};

      outSummaries[cid] = {
        summary: String(decoded?.summary || sqlPreview || ''),
        stepCount: Number(decoded?.stepCount ?? sqlStepCount ?? 0),
        lastModifiedTime,
        createdTime,
        status: String(decoded?.status || sqlStatus || ''),
        source: String(decoded?.source || sqlSource || ''),
        appDataDir: sqlAppDataDir,
        notFullyIdle: Boolean(decoded?.notFullyIdle ?? row.not_fully_idle),
        killed: Boolean(decoded?.killed ?? row.killed),
        annotations: {
          title: String(decoded?.annotations?.title || sqlTitle || ''),
          archived: Boolean(decoded?.annotations?.archived),
          sideQuestionCascadeIds: sideQuestionIds,
          sideQuestionTitles,
        },
        trajectoryMetadata: {
          createdAt,
          parentConversationId,
          rootConversationId,
          nestingDepth: Number(rawMeta?.nestingDepth ?? sqlNestingDepth ?? 0),
          subagentSpec: rawMeta?.subagentSpec || null,
          agentScript: agentName ? { name: agentName } : null,
        },
      };

      for (const sqId of sideQuestionIds) {
        const sqLower = String(sqId || '').trim().toLowerCase();
        if (!sqLower) continue;
        outSideQuestionParents[sqLower] = {
          parentConversationId: cid,
          title: String(sideQuestionTitles[sqLower] || ''),
        };
      }
      for (const [sqKey, sqTitle] of Object.entries(sideQuestionTitles)) {
        const sqLower = String(sqKey || '').trim().toLowerCase();
        if (!sqLower) continue;
        const existing = outSideQuestionParents[sqLower];
        outSideQuestionParents[sqLower] = {
          parentConversationId: existing?.parentConversationId || cid,
          title: String(sqTitle || existing?.title || ''),
        };
      }
    }

    for (const pRow of parentRows) {
      const sqLower = String(pRow.conversation_id || '').trim().toLowerCase();
      const parentLower = String(pRow.parent_id || '').trim().toLowerCase();
      if (!sqLower || !parentLower) continue;
      const parentSummary = outSummaries[parentLower];
      const titleFromParent = String(
        parentSummary?.annotations?.sideQuestionTitles?.[sqLower] ||
          outSideQuestionParents[sqLower]?.title ||
          ''
      );
      outSideQuestionParents[sqLower] = {
        parentConversationId: parentLower,
        title: titleFromParent,
      };
    }

    return { summaries: outSummaries, sideQuestionParents: outSideQuestionParents };
  });

  const payload = {
    available: true,
    sig: walSig.sig,
    summaries,
    sideQuestionParents,
  };

  if (sqliteSummariesMemo.size >= SQLITE_MAX_SUMMARIES_MEMO) {
    const oldestKey = sqliteSummariesMemo.keys().next().value;
    if (oldestKey !== undefined) sqliteSummariesMemo.delete(oldestKey);
  }
  sqliteSummariesMemo.set(memoKey, payload);
  return payload;
}

/**
 * Targeted O(1) WAL stat lookup for a single `cascadeId` without `readdirSync`.
 */
export function statSqliteConversationFile(cascadeId, { conversationsDirs } = {}) {
  const normCid = String(cascadeId || '').trim().toLowerCase();
  if (!normCid) return null;

  const dirs = sqliteNormalizeConversationsDirs(conversationsDirs);
  let best = null;
  for (const { dir, appSource } of dirs) {
    const dbPath = join(dir, `${normCid}.db`);
    const walInfo = computeSqliteWalFileSig(dbPath);
    if (!walInfo.exists) continue;
    const candidate = {
      cascadeId: normCid,
      dbPath,
      mtimeMs: walInfo.mtimeMs,
      sig: walInfo.sig,
      appSource,
    };
    if (sqliteShouldPreferFileCandidate(best, candidate)) {
      best = candidate;
    }
  }

  if (best) {
    const cacheKey = dirs.map((d) => `${d.appSource}:${d.dir}`).join('||');
    const cachedDirScan = sqliteDirScanMemo.get(cacheKey);
    if (cachedDirScan) {
      cachedDirScan.filesMap.set(normCid, best);
    }
  }
  return best;
}

/**
 * Discovers all `<cascade_id>.db` files across `conversationsDirs`, caching
 * directory listings for `dirScanTtlMs` (`30s` by default).
 */
export function discoverSqliteConversationFiles({
  conversationsDirs,
  forceScan = false,
  nowMs = Date.now(),
  dirScanTtlMs = SQLITE_DEFAULT_DIR_SCAN_TTL_MS,
} = {}) {
  const dirs = sqliteNormalizeConversationsDirs(conversationsDirs);
  const cacheKey = dirs.map((d) => `${d.appSource}:${d.dir}`).join('||');
  const cached = sqliteDirScanMemo.get(cacheKey);

  if (
    !forceScan &&
    cached &&
    dirScanTtlMs > 0 &&
    nowMs - cached.scannedAtMs < dirScanTtlMs
  ) {
    return new Map(cached.filesMap);
  }

  const filesMap = new Map();
  for (const { dir, appSource } of dirs) {
    if (!dir || !existsSync(dir)) continue;
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      entries = [];
    }
    for (const fileName of entries) {
      if (typeof fileName !== 'string' || !fileName.endsWith('.db') || fileName.length <= 3) {
        continue;
      }
      const cascadeId = fileName.slice(0, -3).trim().toLowerCase();
      if (!cascadeId) continue;
      const dbPath = join(dir, fileName);
      const walInfo = computeSqliteWalFileSig(dbPath);
      if (!walInfo.exists) continue;
      const candidate = {
        cascadeId,
        dbPath,
        mtimeMs: walInfo.mtimeMs,
        sig: walInfo.sig,
        appSource,
      };
      if (sqliteShouldPreferFileCandidate(filesMap.get(cascadeId), candidate)) {
        filesMap.set(cascadeId, candidate);
      }
    }
  }

  sqliteDirScanMemo.set(cacheKey, {
    scannedAtMs: nowMs,
    filesMap,
  });
  return new Map(filesMap);
}

function sqliteIsInvokeSubagentToolName(rawName) {
  return /^(?:default_api:)?invoke_subagent$/i.test(String(rawName || '').trim());
}

function sqliteMapRunningGenericToolStepType(rawToolName) {
  const name = String(rawToolName || '')
    .trim()
    .toLowerCase()
    .replace(/^default_api:/, '');
  if (!name) return 'CORTEX_STEP_TYPE_GENERIC';
  if (name === 'invoke_subagent') return 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT';
  if (name === 'run_command') return 'CORTEX_STEP_TYPE_RUN_COMMAND';
  if (name === 'command_status') return 'CORTEX_STEP_TYPE_COMMAND_STATUS';
  if (name === 'send_command_input') return 'CORTEX_STEP_TYPE_SEND_COMMAND_INPUT';
  if (name === 'read_file' || name === 'view_file' || name === 'view_file_outline' || name === 'view_code_item') {
    return 'CORTEX_STEP_TYPE_VIEW_FILE';
  }
  if (name === 'edit_file' || name === 'write_file' || name === 'write_to_file' || name === 'replace_file_content' || name === 'multi_replace_file_content') {
    return 'CORTEX_STEP_TYPE_CODE_ACTION';
  }
  if (name === 'grep_search' || name === 'ripgrep') return 'CORTEX_STEP_TYPE_GREP_SEARCH';
  if (name === 'find_by_name') return 'CORTEX_STEP_TYPE_FIND';
  if (name === 'list_dir') return 'CORTEX_STEP_TYPE_LIST_DIRECTORY';
  if (name === 'search_web') return 'CORTEX_STEP_TYPE_SEARCH_WEB';
  if (name === 'read_url_content' || name === 'fetch_url') return 'CORTEX_STEP_TYPE_READ_URL_CONTENT';
  if (name === 'ask_question') return 'CORTEX_STEP_TYPE_ASK_QUESTION';
  if (name === 'call_mcp_tool' || name.startsWith('mcp_') || name.startsWith('mcp-')) {
    return 'CORTEX_STEP_TYPE_MCP_TOOL';
  }
  if (name === 'list_resources') return 'CORTEX_STEP_TYPE_LIST_RESOURCES';
  if (name === 'read_resource') return 'CORTEX_STEP_TYPE_READ_RESOURCE';
  return 'CORTEX_STEP_TYPE_GENERIC';
}

function sqliteCleanFirstUserPrompt(rawText, maxChars = 80) {
  const singleLine = String(rawText || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!singleLine) return '';
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, maxChars - 1).trimEnd()}…`;
}

function sqliteHasContextBreakdownPayload(chat) {
  if (!chat || typeof chat !== 'object') return false;
  return Boolean(
    chat.chatStartMetadata?.contextWindowMetadata?.tokenBreakdown?.groups?.length ||
      chat.promptSections?.length ||
      chat.tools?.length ||
      chat.messagePrompts?.length
  );
}

/**
 * Reads a single `<cascade_id>.db` conversation trajectory using selective
 * header projection, cloned parent step filtering, and final-row context
 * breakdown decoding.
 */
export function readSqliteCascadeTrajectory(
  cascadeId,
  { dbPath, isRunning = false } = {}
) {
  let normCid = String(cascadeId || '').trim().toLowerCase();
  const resolvedDbPath =
    dbPath || (normCid ? statSqliteConversationFile(normCid)?.dbPath : '');
  if (!resolvedDbPath || !existsSync(resolvedDbPath)) {
    return null;
  }

  return sqliteWithReadOnlyDb(resolvedDbPath, (db) => {
    const metaRow = db
      .prepare(
        'SELECT trajectory_id, cascade_id, trajectory_type, source FROM trajectory_meta LIMIT 1'
      )
      .get();

    if (!normCid && metaRow?.cascade_id) {
      normCid = String(metaRow.cascade_id).trim().toLowerCase();
    }
    const trajectoryType = Number(metaRow?.trajectory_type || 0);
    const isSideQuestion = trajectoryType === 22;

    const blobRow = db
      .prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main' LIMIT 1")
      .get();
    const decodedTrajectoryMetadata = blobRow?.data
      ? pbDecodeTrajectoryMetadata(blobRow.data)
      : {
          createdAt: '',
          parentConversationId: '',
          rootConversationId: '',
          nestingDepth: 0,
          subagentSpec: null,
          agentScript: null,
        };

    let forkParentConversationId = '';
    try {
      const refRows = db
        .prepare('SELECT idx, data FROM parent_references ORDER BY idx')
        .all();
      for (const refRow of refRows) {
        if (!refRow?.data) continue;
        const ref = pbDecodeTrajectoryReference(refRow.data);
        const refCid = String(ref?.conversationId || '').trim().toLowerCase();
        if (refCid && (!normCid || refCid !== normCid)) {
          forkParentConversationId = refCid;
        }
      }
    } catch {
      forkParentConversationId = '';
    }

    const allStepRows = db
      .prepare('SELECT idx, step_type, status, metadata FROM steps ORDER BY idx')
      .all();

    const ownStepRecords = [];
    for (const row of allStepRows) {
      const rowIdx = Number(row.idx ?? 0);
      const metadata = pbDecodeStepMetadata(row.metadata, rowIdx);
      const originCid = String(metadata.sourceTrajectoryStepInfo?.cascadeId || '')
        .trim()
        .toLowerCase();
      const isClonedFromParent = Boolean(originCid && normCid && originCid !== normCid);
      if (isClonedFromParent) {
        continue;
      }
      ownStepRecords.push({
        rowIdx,
        stepTypeNum: Number(row.step_type || 0),
        statusNum: Number(row.status || 0),
        metadata,
      });
    }

    const runningTailStart = isRunning
      ? Math.max(0, ownStepRecords.length - 16)
      : ownStepRecords.length;

    let firstOwnUserInputRowIdx = -1;
    if (isSideQuestion) {
      for (const rec of ownStepRecords) {
        if (rec.stepTypeNum === 14) {
          firstOwnUserInputRowIdx = rec.rowIdx;
          break;
        }
      }
    }

    const payloadIndices = [];
    for (let i = 0; i < ownStepRecords.length; i++) {
      const rec = ownStepRecords[i];
      const inRunningTail = isRunning && i >= runningTailStart;
      const isInvSub =
        rec.stepTypeNum === 127 ||
        (rec.stepTypeNum === 132 &&
          sqliteIsInvokeSubagentToolName(rec.metadata?.toolCall?.name));

      if (
        rec.stepTypeNum === 15 ||
        isInvSub ||
        (isSideQuestion && rec.rowIdx === firstOwnUserInputRowIdx) ||
        (inRunningTail && (rec.stepTypeNum !== 132 || !rec.metadata?.toolCall?.argumentsJson))
      ) {
        payloadIndices.push(rec.rowIdx);
      }
    }

    const payloadMap = new Map();
    for (let offset = 0; offset < payloadIndices.length; offset += SQLITE_IN_CLAUSE_CHUNK) {
      const batch = payloadIndices.slice(offset, offset + SQLITE_IN_CLAUSE_CHUNK);
      const placeholders = batch.map(() => '?').join(',');
      const pRows = db
        .prepare(`SELECT idx, step_payload FROM steps WHERE idx IN (${placeholders})`)
        .all(...batch);
      for (const pRow of pRows) {
        if (pRow?.step_payload) {
          payloadMap.set(Number(pRow.idx), pRow.step_payload);
        }
      }
    }

    let firstOwnUserPrompt = '';
    const ownSteps = [];

    for (let i = 0; i < ownStepRecords.length; i++) {
      const rec = ownStepRecords[i];
      const inRunningTail = isRunning && i >= runningTailStart;
      const isInvSub =
        rec.stepTypeNum === 127 ||
        (rec.stepTypeNum === 132 &&
          sqliteIsInvokeSubagentToolName(rec.metadata?.toolCall?.name));

      let stepTypeStr = '';
      if (isInvSub) {
        stepTypeStr = 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT';
      } else if (rec.stepTypeNum === 132 && inRunningTail) {
        stepTypeStr = sqliteMapRunningGenericToolStepType(rec.metadata?.toolCall?.name);
      } else {
        stepTypeStr = pbMapStepType(rec.stepTypeNum);
      }

      const stepObj = {
        type: stepTypeStr,
        status: pbMapStepStatus(rec.statusNum),
        metadata: rec.metadata,
      };

      const rawPayload = payloadMap.get(rec.rowIdx);
      if (rawPayload) {
        const decodedPayload = pbDecodeStepPayload(rawPayload, {
          stepTypeNum: rec.stepTypeNum,
          isInvokeSubagent: isInvSub,
          keepTextSnippets: inRunningTail,
          keepUserInput: isSideQuestion && rec.rowIdx === firstOwnUserInputRowIdx,
        });
        if (decodedPayload.plannerResponse) {
          stepObj.plannerResponse = decodedPayload.plannerResponse;
        }
        if (decodedPayload.invokeSubagent) {
          stepObj.invokeSubagent = decodedPayload.invokeSubagent;
        }
        if (decodedPayload.userInputText && !firstOwnUserPrompt) {
          firstOwnUserPrompt = sqliteCleanFirstUserPrompt(decodedPayload.userInputText, 80);
        }
      }

      ownSteps.push(stepObj);
    }

    const genRows = db
      .prepare('SELECT idx, data FROM gen_metadata ORDER BY idx')
      .all();

    const ownGenRecords = [];
    for (const gRow of genRows) {
      if (!gRow?.data) continue;
      const gm = pbDecodeGeneratorMetadata(gRow.data, {
        includeContextBreakdown: false,
      });
      if (!gm) continue;
      const gmCid = String(gm.chatModel?.customMetadata?.cascade_id || '')
        .trim()
        .toLowerCase();
      if (gmCid && normCid && gmCid !== normCid) {
        continue;
      }
      ownGenRecords.push({ rawData: gRow.data, gm });
    }

    if (ownGenRecords.length > 0) {
      const lastEntry = ownGenRecords[ownGenRecords.length - 1];
      const fullLastGm = pbDecodeGeneratorMetadata(lastEntry.rawData, {
        includeContextBreakdown: true,
      });
      if (fullLastGm) {
        lastEntry.gm = fullLastGm;
      }
      if (
        !sqliteHasContextBreakdownPayload(lastEntry.gm?.chatModel) &&
        ownGenRecords.length >= 2
      ) {
        const prevEntry = ownGenRecords[ownGenRecords.length - 2];
        const fullPrevGm = pbDecodeGeneratorMetadata(prevEntry.rawData, {
          includeContextBreakdown: true,
        });
        if (fullPrevGm && sqliteHasContextBreakdownPayload(fullPrevGm.chatModel)) {
          prevEntry.gm = fullPrevGm;
        }
      }
    }

    const ownGeneratorMetadata = ownGenRecords.map((entry) => entry.gm);

    return {
      cascadeId: normCid,
      numTotalSteps: ownSteps.length,
      rawTableStepCount: allStepRows.length,
      trajectoryType,
      isSideQuestion,
      forkParentConversationId,
      firstOwnUserPrompt,
      trajectory: {
        metadata: decodedTrajectoryMetadata,
        steps: ownSteps,
        generatorMetadata: ownGeneratorMetadata,
      },
    };
  });
}
