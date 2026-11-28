/**
 * @fileoverview Incremental SQLite trajectory & permanent usage ledger engine (`trajectory-sqlite-ledger.mjs`).
 *
 * Architecture:
 * 1. Short-lived connections (`open -> WAL/NORMAL/busy_timeout -> tx -> close` in `finally`) prevent Windows
 *    file-handle lock retention (`EBUSY`) across Sidecar, `bridge-daemon.mjs`, and `standalone.mjs`.
 * 2. Two-tier step storage:
 *    - `accounting_json`: compact 21-slot tuple holding scalar billing/timing/model/anomaly fields; cold
 *      conversations keep only interned slim objects in V8 memory (`~80ms` startup for `57k+` steps).
 *    - `detail_json`: lossless remainder (`contextBreakdown`, `turnPrompt*`, ISO timestamps, context limits, etc.),
 *      lazily hydrated on demand (`~1ms`) only for active/inspected conversations via a 24-entry LRU.
 * 3. Step-level `O(delta)` incremental `UPSERT` with tail truncation (`DELETE ... WHERE pos >= ?`) on conversation
 *    undo/branching, plus `ledger_epoch` + `write_seq` cross-process WAL synchronization.
 */

import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { inferCompactionStepModels, normalizeCachedStep } from '../trajectory-metrics.mjs';
import { isPlainObject } from './http-helpers.mjs';
import {
  SQLITE_IN_CHUNK_SIZE,
  computeSqliteWalSig,
  getNodeSqliteDatabaseSync,
  isSqliteBusyError,
} from './sqlite-client.mjs';

export const LEDGER_SCHEMA_VERSION = '1';
export const DEFAULT_REDACTED_SESSION_TITLE = '[Deleted Session]';
const TSL_BUSY_TIMEOUT_WRITE_MS = 3000;
const TSL_BUSY_TIMEOUT_READ_MS = 1500;
const TSL_MAX_BUSY_ATTEMPTS = 3;
const TSL_REDACTED_STEP_DETAIL_KEYS = Object.freeze(['turnPrompt', 'turnPromptClean', 'userPrompt']);

/**
 * 原地/浅拷贝脱敏账本会话元数据对象（隐藏标题、Swarm 标题、子代理初始提示词及旁路提问角色），
 * 完整保留所有计费、模型与归属统计元数据。
 *
 * @param {Record<string, any>} rawMeta
 * @param {{ placeholderTitle?: string }} [options={}]
 * @returns {{ meta: Record<string, any>, changed: boolean }}
 */
export function redactLedgerMetaObject(
  rawMeta,
  { placeholderTitle = DEFAULT_REDACTED_SESSION_TITLE } = {}
) {
  const placeholder = String(placeholderTitle || DEFAULT_REDACTED_SESSION_TITLE).trim() || DEFAULT_REDACTED_SESSION_TITLE;
  const meta = isPlainObject(rawMeta) ? { ...rawMeta } : {};
  let changed = false;

  if (typeof meta.title === 'string' && meta.title.trim() && meta.title !== placeholder) {
    meta.title = placeholder;
    changed = true;
  }
  if (isPlainObject(meta.swarmMeta)) {
    const nextSwarm = { ...meta.swarmMeta };
    if (
      typeof nextSwarm.title === 'string' &&
      nextSwarm.title.trim() &&
      nextSwarm.title !== placeholder
    ) {
      nextSwarm.title = placeholder;
      meta.swarmMeta = nextSwarm;
      changed = true;
    }
  }
  if (isPlainObject(meta.subagentSpec)) {
    const nextSpec = { ...meta.subagentSpec };
    let specChanged = false;
    if (Object.prototype.hasOwnProperty.call(nextSpec, 'initialPrompt') && nextSpec.initialPrompt) {
      delete nextSpec.initialPrompt;
      specChanged = true;
    }
    if (
      String(nextSpec.typeName || '').trim().toLowerCase() === 'side_question' &&
      typeof nextSpec.role === 'string' &&
      nextSpec.role.trim() &&
      nextSpec.role !== placeholder
    ) {
      nextSpec.role = placeholder;
      specChanged = true;
    }
    if (specChanged) {
      meta.subagentSpec = nextSpec;
      changed = true;
    }
  }
  if (meta.archived !== true) {
    meta.archived = true;
    changed = true;
  }
  return { meta, changed };
}

/**
 * 脱敏单步 `detail_json` 对象中的用户输入提示词字段，100% 保留其余上下文构成、时间戳与模型诊断字段。
 *
 * @param {Record<string, any> | null} rawDetail
 * @returns {{ detail: Record<string, any> | null, changed: boolean }}
 */
export function redactLedgerStepDetailObject(rawDetail) {
  if (!isPlainObject(rawDetail)) {
    return { detail: rawDetail ?? null, changed: false };
  }
  let changed = false;
  const next = { ...rawDetail };
  for (const key of TSL_REDACTED_STEP_DETAIL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(next, key) && next[key] !== undefined && next[key] !== '') {
      delete next[key];
      changed = true;
    }
  }
  if (!changed) {
    return { detail: rawDetail, changed: false };
  }
  return {
    detail: Object.keys(next).length > 0 ? next : null,
    changed: true,
  };
}

const TSL_FLAG_COMPACTION = 1 << 0;
const TSL_FLAG_IMAGE_GEN = 1 << 1;
const TSL_FLAG_COMPLETE = 1 << 2;
const TSL_FLAG_SPEED_ELIGIBLE = 1 << 3;
const TSL_FLAG_VISIBLE_TEXT = 1 << 4;
const TSL_FLAG_TOOL_CALLS = 1 << 5;
const TSL_FLAG_REVERTED = 1 << 6;

const TSL_CORE_STEP_KEYS = new Set([
  'stepIndex',
  'createdAtMs',
  'isCompactionStep',
  'isImageGenStep',
  'isComplete',
  'speedSampleEligible',
  'hasVisibleText',
  'hasToolCalls',
  'isReverted',
  'modelKey',
  'responseModel',
  'apiProvider',
  'modelDisplayName',
  'modelSource',
  'modelIdentityVersion',
  'inputTokens',
  'cacheReadTokens',
  'outputTokens',
  'thinkingTokens',
  'responseTokens',
  'totalDurationSec',
  'totalTokPerSec',
  'nativeTtftSec',
  'speedReason',
  'measurementVersion',
  'accountName',
  'anomaly',
]);

function tslCreateInternPool() {
  const pool = new Map();
  return function internString(val) {
    if (typeof val !== 'string' || val.length === 0) return '';
    if (val.length > 96) return val;
    const hit = pool.get(val);
    if (hit !== undefined) return hit;
    if (pool.size >= 4096) pool.clear();
    pool.set(val, val);
    return val;
  };
}

/**
 * 为单步 `accounting_json` 与可选 `detail_json` 计算紧凑的双路 FNV-1a 64-bit 摘要签名，
 * 避免在 `persistedByLower` 中常驻保存每步数百至上千字节的原始 JSON 字符串。
 *
 * @param {string} accJson
 * @param {string | null | undefined} detJson
 * @returns {string}
 */
function tslHashStepStorageSig(accJson, detJson) {
  const a = typeof accJson === 'string' ? accJson : '';
  const hasDet = typeof detJson === 'string';
  const d = hasDet ? detJson : '';
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < a.length; i += 1) {
    const c = a.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b);
  }
  if (hasDet) {
    h1 = Math.imul(h1 ^ 0x0a, 0x01000193);
    h2 = Math.imul(h2 ^ 0x55, 0x85ebca6b);
    for (let i = 0; i < d.length; i += 1) {
      const c = d.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193);
      h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b);
    }
  }
  return `${a.length}:${hasDet ? d.length : -1}:${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}`;
}

/**
 * Computes conversation-level `O(1)` step completeness and model-limit metadata
 * so scanner `toFetch` checks and `buildKnownUpstreamModelMap` never need to hydrate cold `detail_json`.
 *
 * @param {object[]} steps
 * @returns {{
 *   hasMissingStepFields: boolean,
 *   hasMissingTurnRailFields: boolean,
 *   hasAnyTurnIndex: boolean,
 *   hasIncompleteTiming: boolean,
 *   modelLimits: Array<[string, number, number]>,
 * }}
 */
export function computePrecomputedStepFlags(steps) {
  const list = Array.isArray(steps) ? steps : [];
  if (list.length === 0) {
    return {
      hasMissingStepFields: false,
      hasMissingTurnRailFields: false,
      hasAnyTurnIndex: false,
      hasAnyContextBreakdown: false,
      hasIncompleteTiming: false,
      modelLimits: [],
    };
  }
  const lastStep = list[list.length - 1];
  const lastHasContextBdProp = Boolean(
    lastStep && Object.prototype.hasOwnProperty.call(lastStep, 'contextBreakdown')
  );
  const lastHasTurnIdxProp = Boolean(
    lastStep && Object.prototype.hasOwnProperty.call(lastStep, 'turnIndex')
  );
  let missingResponseModel = false;
  let missingToolResultsTokens = false;
  let checkedLastBd = false;
  let hasAnyTurnIndex = false;
  let hasAnyContextBreakdown = false;
  let hasIncompleteTiming = false;
  const limitsMap = new Map();

  for (let i = list.length - 1; i >= 0; i -= 1) {
    const st = list[i];
    if (!st || typeof st !== 'object') continue;
    if (st.contextBreakdown && typeof st.contextBreakdown === 'object') {
      hasAnyContextBreakdown = true;
      if (!checkedLastBd) {
        checkedLastBd = true;
        missingToolResultsTokens = !Object.prototype.hasOwnProperty.call(
          st.contextBreakdown,
          'toolResultsTokens'
        );
      }
    }
    if (!Object.prototype.hasOwnProperty.call(st, 'responseModel')) {
      missingResponseModel = true;
    }
    if (st.turnIndex) {
      hasAnyTurnIndex = true;
    }
    if (st.speedReason === 'incomplete_or_invalid_timing') {
      hasIncompleteTiming = true;
    }
    if (
      !st.isCompactionStep &&
      !st.isImageGenStep &&
      Number(st.reportedContextLimitTokens) > 0 &&
      st.modelKey &&
      st.modelKey !== 'unknown'
    ) {
      const atMs = Number.isFinite(Number(st.createdAtMs)) ? Number(st.createdAtMs) : 0;
      const prev = limitsMap.get(st.modelKey);
      if (!prev || atMs > prev.at) {
        limitsMap.set(st.modelKey, {
          tokens: Number(st.reportedContextLimitTokens),
          at: atMs,
        });
      }
    }
  }

  const modelLimits = [];
  for (const [modelKey, info] of limitsMap.entries()) {
    modelLimits.push([modelKey, info.tokens, info.at]);
  }

  return {
    hasMissingStepFields: !lastHasContextBdProp || missingResponseModel || missingToolResultsTokens,
    hasMissingTurnRailFields: !lastHasTurnIdxProp,
    hasAnyTurnIndex,
    hasAnyContextBreakdown,
    hasIncompleteTiming,
    modelLimits,
  };
}

/**
 * Splits a full normalized step object into a compact 21-slot accounting tuple and an optional detail object.
 *
 * @param {object} step
 * @returns {{ accountingTuple: any[], detailObj: Record<string, any> | null }}
 */
export function splitStepForStorage(step) {
  const s = step && typeof step === 'object' ? step : {};
  let flags = 0;
  if (s.isCompactionStep) flags |= TSL_FLAG_COMPACTION;
  if (s.isImageGenStep) flags |= TSL_FLAG_IMAGE_GEN;
  if (s.isComplete) flags |= TSL_FLAG_COMPLETE;
  if (s.speedSampleEligible) flags |= TSL_FLAG_SPEED_ELIGIBLE;
  if (s.hasVisibleText) flags |= TSL_FLAG_VISIBLE_TEXT;
  if (s.hasToolCalls) flags |= TSL_FLAG_TOOL_CALLS;
  if (s.isReverted) flags |= TSL_FLAG_REVERTED;

  const accountingTuple = [
    s.stepIndex ?? null,
    Number(s.createdAtMs || 0),
    flags,
    s.modelKey || '',
    s.responseModel ?? '',
    s.apiProvider || '',
    s.modelDisplayName || '',
    s.modelSource || '',
    s.modelIdentityVersion ?? null,
    Number(s.inputTokens || 0),
    Number(s.cacheReadTokens || 0),
    Number(s.outputTokens || 0),
    Number(s.thinkingTokens || 0),
    s.responseTokens !== undefined && s.responseTokens !== null
      ? Number(s.responseTokens)
      : Math.max(0, Number(s.outputTokens || 0) - Number(s.thinkingTokens || 0)),
    s.totalDurationSec ?? null,
    s.totalTokPerSec ?? null,
    s.nativeTtftSec ?? null,
    s.speedReason ?? null,
    s.measurementVersion ?? null,
    s.accountName ?? null,
    s.anomaly ?? null,
  ];

  let detailObj = null;
  for (const key of Object.keys(s)) {
    if (TSL_CORE_STEP_KEYS.has(key)) continue;
    if (s[key] === undefined) continue;
    if (!detailObj) detailObj = {};
    detailObj[key] = s[key];
  }
  return { accountingTuple, detailObj };
}

/**
 * Rebuilds a fixed-shape slim step object from a compact accounting tuple (or legacy plain object).
 *
 * @param {any[] | Record<string, any>} rawAccounting
 * @param {(val: string) => string} [internFn]
 * @returns {object}
 */
function isSqliteCorruptError(err) {
  const msg = String(err?.message || err?.errstr || err?.code || '');
  return /SQLITE_CORRUPT|SQLITE_NOTADB|database disk image is malformed|file is not a database/i.test(
    msg
  );
}

function tslQuarantineCorruptDbFiles(sqliteFilePath) {
  if (!sqliteFilePath || !existsSync(sqliteFilePath)) return '';
  const stamp = Date.now();
  const quarantineBase = `${sqliteFilePath}.corrupt.${stamp}`;
  for (const suffix of ['', '-wal', '-shm']) {
    const src = `${sqliteFilePath}${suffix}`;
    if (!existsSync(src)) continue;
    try {
      renameSync(src, `${quarantineBase}${suffix}`);
    } catch {
      try {
        rmSync(src, { force: true });
      } catch {
        // Ignore cleanup failure
      }
    }
  }
  return quarantineBase;
}

export function buildSlimStepFromAccounting(rawAccounting, internFn = (v) => v || '') {
  if (!Array.isArray(rawAccounting)) {
    if (isPlainObject(rawAccounting)) {
      const { accountingTuple } = splitStepForStorage(rawAccounting);
      return buildSlimStepFromAccounting(accountingTuple, internFn);
    }
    return {};
  }
  const t = rawAccounting;
  const flags = Number(t[2] || 0);
  const slim = {
    stepIndex: t[0] ?? null,
    createdAtMs: Number(t[1] || 0),
    isCompactionStep: Boolean(flags & TSL_FLAG_COMPACTION),
    ...(flags & TSL_FLAG_IMAGE_GEN ? { isImageGenStep: true } : {}),
    isComplete: Boolean(flags & TSL_FLAG_COMPLETE),
    speedSampleEligible: Boolean(flags & TSL_FLAG_SPEED_ELIGIBLE),
    hasVisibleText: Boolean(flags & TSL_FLAG_VISIBLE_TEXT),
    hasToolCalls: Boolean(flags & TSL_FLAG_TOOL_CALLS),
    ...(flags & TSL_FLAG_REVERTED ? { isReverted: true } : {}),
    modelKey: internFn(t[3] || ''),
    responseModel: internFn(t[4] || ''),
    apiProvider: internFn(t[5] || ''),
    modelDisplayName: internFn(t[6] || ''),
    modelSource: internFn(t[7] || ''),
    modelIdentityVersion: t[8] ?? null,
    inputTokens: Number(t[9] || 0),
    cacheReadTokens: Number(t[10] || 0),
    outputTokens: Number(t[11] || 0),
    thinkingTokens: Number(t[12] || 0),
    responseTokens: Number(t[13] || 0),
    totalDurationSec: t[14] ?? null,
    totalTokPerSec: t[15] ?? null,
    nativeTtftSec: t[16] ?? null,
    speedReason: t[17] ? internFn(t[17]) : null,
    measurementVersion: t[18] ?? null,
  };
  if (t[19]) {
    slim.accountName = internFn(t[19]);
  }
  if (t[20]) {
    slim.anomaly = t[20];
  }
  Object.defineProperty(slim, '_isSlimStep', {
    value: true,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return slim;
}

/**
 * Merges a slim accounting step and parsed `detail_json` object into a complete step object.
 *
 * @param {object | any[]} accountingOrSlim
 * @param {Record<string, any> | null | undefined} detailObj
 * @param {(val: string) => string} [internFn]
 * @returns {object}
 */
export function mergeStepFromStorage(accountingOrSlim, detailObj, internFn) {
  const base = Array.isArray(accountingOrSlim)
    ? buildSlimStepFromAccounting(accountingOrSlim, internFn)
    : { ...(accountingOrSlim || {}) };
  if (detailObj && typeof detailObj === 'object' && !Array.isArray(detailObj)) {
    return { ...base, ...detailObj };
  }
  return base;
}

/**
 * Converts a hydrated in-memory step into its cold slim representation, releasing heavy `detail` properties.
 *
 * @param {object} step
 * @param {(val: string) => string} [internFn]
 * @returns {object}
 */
export function dehydrateStepForColdMemory(step, internFn) {
  const { accountingTuple } = splitStepForStorage(step);
  return buildSlimStepFromAccounting(accountingTuple, internFn);
}

function tslSerializeEntryHeader(entry) {
  const meta = {};
  for (const [k, v] of Object.entries(entry || {})) {
    if (k === 'steps' || k === '_coldSteps') continue;
    if (v !== undefined) meta[k] = v;
  }
  if (!meta._stepFlags && Array.isArray(entry?.steps) && !entry._coldSteps) {
    meta._stepFlags = computePrecomputedStepFlags(entry.steps);
  }
  return meta;
}

function tslWithSqliteConnection(dbPath, { readOnly = false }, fn) {
  const DatabaseSync = getNodeSqliteDatabaseSync();
  if (!DatabaseSync) {
    throw new Error('node:sqlite DatabaseSync unavailable');
  }
  if (!readOnly) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  for (let attempt = 0; attempt < TSL_MAX_BUSY_ATTEMPTS; attempt += 1) {
    let db = null;
    try {
      db = readOnly ? new DatabaseSync(dbPath, { readOnly: true }) : new DatabaseSync(dbPath);
      if (readOnly) {
        db.exec(`PRAGMA busy_timeout = ${TSL_BUSY_TIMEOUT_READ_MS};`);
      } else {
        db.exec(
          `PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = ${TSL_BUSY_TIMEOUT_WRITE_MS};`
        );
      }
      return fn(db);
    } catch (err) {
      if (attempt + 1 < TSL_MAX_BUSY_ATTEMPTS && isSqliteBusyError(err)) {
        continue;
      }
      throw err;
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          // Ignore close error
        }
      }
    }
  }
  return null;
}

function tslEnsureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      cascade_id TEXT PRIMARY KEY,
      lower_id TEXT NOT NULL UNIQUE,
      is_archived INTEGER NOT NULL DEFAULT 0,
      step_count INTEGER NOT NULL DEFAULT 0,
      write_seq INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL DEFAULT 0,
      meta_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conv_write_seq ON conversations(write_seq);
    CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at_ms);
    CREATE TABLE IF NOT EXISTS steps (
      cascade_id TEXT NOT NULL,
      pos INTEGER NOT NULL,
      accounting_json TEXT NOT NULL,
      detail_json TEXT,
      PRIMARY KEY (cascade_id, pos)
    );
  `);
  const verRow = db
    .prepare("SELECT value FROM ledger_meta WHERE key = 'schema_version'")
    .get();
  if (!verRow) {
    db.prepare("INSERT OR REPLACE INTO ledger_meta (key, value) VALUES ('schema_version', ?)").run(
      LEDGER_SCHEMA_VERSION
    );
  }
  const epochRow = db
    .prepare("SELECT value FROM ledger_meta WHERE key = 'ledger_epoch'")
    .get();
  if (!epochRow) {
    db.prepare("INSERT OR REPLACE INTO ledger_meta (key, value) VALUES ('ledger_epoch', '1')").run();
  }
  const seqRow = db
    .prepare("SELECT value FROM ledger_meta WHERE key = 'last_write_seq'")
    .get();
  if (!seqRow) {
    db.prepare("INSERT OR REPLACE INTO ledger_meta (key, value) VALUES ('last_write_seq', '0')").run();
  }
}

function tslReadMetaInt(db, key, fallback = 0) {
  const row = db.prepare('SELECT value FROM ledger_meta WHERE key = ?').get(key);
  const num = Number(row?.value);
  return Number.isFinite(num) && num >= 0 ? Math.floor(num) : fallback;
}

function tslArchiveLegacyJsonToBak(legacyJsonPath) {
  if (!legacyJsonPath || !existsSync(legacyJsonPath)) return;
  const bakPath = `${legacyJsonPath}.bak`;
  try {
    if (existsSync(bakPath)) {
      rmSync(bakPath, { force: true });
    }
    renameSync(legacyJsonPath, bakPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
  }
}

/**
 * Creates a short-connection SQLite trajectory ledger controller for one database file.
 *
 * @param {{
 *   sqliteFilePath: string,
 *   legacyJsonPath?: string,
 *   loadJsonFn?: (filePath: string, fallback: any) => any,
 * }} options
 */
export function createTrajectorySqliteLedger({
  sqliteFilePath,
  legacyJsonPath = '',
  loadJsonFn = null,
}) {
  const internString = tslCreateInternPool();
  // Tracks per-conversation persisted signatures (`{ metaJson, stepSigs: string[] }`) for O(delta) step writes
  const persistedByLower = new Map();
  let localEpoch = 1;
  let localWriteSeq = 0;
  let lastSeenWalSig = '';

  function refreshWalSigAfterOwnWrite() {
    lastSeenWalSig = computeSqliteWalSig(sqliteFilePath).sig;
  }

  function normalizeLegacyEntriesForMigration(rawLoaded) {
    const dedupedByLower = new Map();
    if (!isPlainObject(rawLoaded)) return dedupedByLower;
    for (const [rawId, rawEntry] of Object.entries(rawLoaded)) {
      const id = String(rawId || '').trim();
      const lower = id.toLowerCase();
      if (!lower || !isPlainObject(rawEntry)) continue;
      const rawSteps = Array.isArray(rawEntry.steps) ? rawEntry.steps.filter(isPlainObject) : [];
      const normalized = inferCompactionStepModels(
        rawSteps.map((s) => normalizeCachedStep(s)).filter(Boolean)
      );
      const canonId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
        ? lower
        : id;
      const prev = dedupedByLower.get(lower);
      if (!prev || normalized.length >= prev.entry.steps.length) {
        dedupedByLower.set(lower, {
          cascadeId: canonId,
          lowerId: lower,
          entry: { ...rawEntry, steps: normalized },
        });
      }
    }
    return dedupedByLower;
  }

  function openAndHydrateInitialCore() {
    let migratedLegacy = false;
    const bakJsonPath = legacyJsonPath ? `${legacyJsonPath}.bak` : '';
    const hasLegacyJsonOnDisk = Boolean(
      legacyJsonPath && typeof loadJsonFn === 'function' && existsSync(legacyJsonPath)
    );
    const dbExistsBefore = existsSync(sqliteFilePath);

    if (!dbExistsBefore || hasLegacyJsonOnDisk) {
      tslWithSqliteConnection(sqliteFilePath, { readOnly: false }, (db) => {
        tslEnsureSchema(db);
        const migRow = db
          .prepare("SELECT value FROM ledger_meta WHERE key = 'migrated_legacy_json'")
          .get();
        if (migRow?.value === '1') return;

        let rawLoaded = null;
        if (typeof loadJsonFn === 'function') {
          if (legacyJsonPath && existsSync(legacyJsonPath)) {
            rawLoaded = loadJsonFn(legacyJsonPath, null);
          } else if (!dbExistsBefore && bakJsonPath && existsSync(bakJsonPath)) {
            rawLoaded = loadJsonFn(bakJsonPath, null);
          }
        }

        db.exec('BEGIN IMMEDIATE');
        try {
          const migRowInTx = db
            .prepare("SELECT value FROM ledger_meta WHERE key = 'migrated_legacy_json'")
            .get();
          if (migRowInTx?.value !== '1') {
            let seq = tslReadMetaInt(db, 'last_write_seq', 0);
            const nowMs = Date.now();
            if (rawLoaded && isPlainObject(rawLoaded)) {
              const deduped = normalizeLegacyEntriesForMigration(rawLoaded);
              const insConv = db.prepare(`
                INSERT OR REPLACE INTO conversations (
                  cascade_id, lower_id, is_archived, step_count, write_seq, updated_at_ms, meta_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
              `);
              const insStep = db.prepare(`
                INSERT OR REPLACE INTO steps (cascade_id, pos, accounting_json, detail_json)
                VALUES (?, ?, ?, ?)
              `);
              for (const { cascadeId, lowerId, entry } of deduped.values()) {
                seq += 1;
                const steps = entry.steps || [];
                const header = tslSerializeEntryHeader(entry);
                const metaJson = JSON.stringify(header);
                const archivedInt = entry.archived ? 1 : 0;
                insConv.run(cascadeId, lowerId, archivedInt, steps.length, seq, nowMs, metaJson);
                const stepSigs = new Array(steps.length);
                for (let pos = 0; pos < steps.length; pos += 1) {
                  const { accountingTuple, detailObj } = splitStepForStorage(steps[pos]);
                  const accJson = JSON.stringify(accountingTuple);
                  const detJson = detailObj ? JSON.stringify(detailObj) : null;
                  insStep.run(cascadeId, pos, accJson, detJson);
                  stepSigs[pos] = tslHashStepStorageSig(accJson, detJson);
                }
                persistedByLower.set(lowerId, {
                  cascadeId,
                  metaJson,
                  archivedInt,
                  stepSigs,
                });
              }
              migratedLegacy = true;
            }
            db.prepare(
              "INSERT OR REPLACE INTO ledger_meta (key, value) VALUES ('last_write_seq', ?)"
            ).run(String(seq));
            db.prepare(
              "INSERT OR REPLACE INTO ledger_meta (key, value) VALUES ('migrated_legacy_json', '1')"
            ).run();
          }
          db.exec('COMMIT');
        } catch (err) {
          try {
            db.exec('ROLLBACK');
          } catch {
            // Ignore rollback error
          }
          throw err;
        }
      });

      if (migratedLegacy || hasLegacyJsonOnDisk) {
        tslArchiveLegacyJsonToBak(legacyJsonPath);
      }
    }

    return hydrateAllSlimFromDb();
  }

  /**
   * Initializes schema, migrates legacy `.json` inside a single `BEGIN IMMEDIATE` transaction if needed,
   * self-heals corrupted SQLite images by quarantining `.corrupt.<ts>` and recovering from `.json.bak`,
   * and hydrates all conversations in cold slim accounting mode.
   */
  function openAndHydrateInitial() {
    try {
      return openAndHydrateInitialCore();
    } catch (err) {
      if (!isSqliteCorruptError(err)) {
        throw err;
      }
      persistedByLower.clear();
      const quarantined = tslQuarantineCorruptDbFiles(sqliteFilePath);
      console.error(
        `Quarantined corrupt SQLite trajectory ledger (${quarantined || sqliteFilePath}): ${err.message}`
      );
      return openAndHydrateInitialCore();
    }
  }

  function hydrateAllSlimFromDb() {
    if (!existsSync(sqliteFilePath)) {
      localEpoch = 1;
      localWriteSeq = 0;
      lastSeenWalSig = '';
      return { cacheObj: Object.create(null) };
    }
    const cacheObj = Object.create(null);
    tslWithSqliteConnection(sqliteFilePath, { readOnly: true }, (db) => {
      localEpoch = tslReadMetaInt(db, 'ledger_epoch', 1);
      localWriteSeq = tslReadMetaInt(db, 'last_write_seq', 0);
      const convRows = db
        .prepare(
          'SELECT cascade_id, lower_id, is_archived, step_count, meta_json FROM conversations'
        )
        .all();

      for (const row of convRows) {
        let meta = {};
        try {
          meta = JSON.parse(row.meta_json) || {};
        } catch {
          meta = {};
        }
        const entry = {
          ...meta,
          ...(row.is_archived ? { archived: true } : {}),
          _coldSteps: true,
          steps: [],
        };
        if (!row.is_archived && entry.archived) {
          delete entry.archived;
        }
        cacheObj[row.cascade_id] = entry;
        if (!persistedByLower.has(row.lower_id)) {
          persistedByLower.set(row.lower_id, {
            cascadeId: row.cascade_id,
            metaJson: row.meta_json,
            archivedInt: row.is_archived ? 1 : 0,
            stepSigs: null,
          });
        }
      }

      const HYDRATE_STEP_CHUNK_SIZE = 4096;
      const firstChunkStmt = db.prepare(
        `SELECT cascade_id, pos, accounting_json
         FROM steps
         ORDER BY cascade_id ASC, pos ASC
         LIMIT ?`
      );
      const nextChunkStmt = db.prepare(
        `SELECT cascade_id, pos, accounting_json
         FROM steps
         WHERE cascade_id > ? OR (cascade_id = ? AND pos > ?)
         ORDER BY cascade_id ASC, pos ASC
         LIMIT ?`
      );
      let chunk = firstChunkStmt.all(HYDRATE_STEP_CHUNK_SIZE);
      while (chunk.length > 0) {
        for (let i = 0; i < chunk.length; i += 1) {
          const sRow = chunk[i];
          const target = cacheObj[sRow.cascade_id];
          if (!target) continue;
          let parsedAcc = null;
          try {
            parsedAcc = JSON.parse(sRow.accounting_json);
          } catch {
            continue;
          }
          target.steps.push(buildSlimStepFromAccounting(parsedAcc, internString));
        }
        if (chunk.length < HYDRATE_STEP_CHUNK_SIZE) break;
        const lastRow = chunk[chunk.length - 1];
        chunk = nextChunkStmt.all(lastRow.cascade_id, lastRow.cascade_id, lastRow.pos, HYDRATE_STEP_CHUNK_SIZE);
      }
    });
    lastSeenWalSig = computeSqliteWalSig(sqliteFilePath).sig;
    return { cacheObj };
  }

  /**
   * Synchronously hydrates full `detail_json` rows for a single cold conversation (`<1.5ms`).
   *
   * @param {string} cascadeId
   * @param {object} currentEntry
   * @returns {object[] | null}
   */
  function loadHydratedStepsForConversation(cascadeId, currentEntry) {
    if (!cascadeId || !currentEntry || !existsSync(sqliteFilePath)) return null;
    const slimSteps = Array.isArray(currentEntry.steps) ? currentEntry.steps : [];
    if (slimSteps.length === 0) return [];

    return tslWithSqliteConnection(sqliteFilePath, { readOnly: true }, (db) => {
      const lower = String(cascadeId).toLowerCase();
      const convRow = db
        .prepare('SELECT cascade_id FROM conversations WHERE lower_id = ?')
        .get(lower);
      const dbCid = convRow?.cascade_id || cascadeId;
      const detailRows = db
        .prepare(
          'SELECT pos, accounting_json, detail_json FROM steps WHERE cascade_id = ? ORDER BY pos ASC'
        )
        .all(dbCid);
      if (!detailRows || detailRows.length === 0) {
        return slimSteps.map((s) => ({ ...s }));
      }
      const hydrated = new Array(detailRows.length);
      const hydratedStepSigs = new Array(detailRows.length);
      let posAligned = true;
      for (let i = 0; i < detailRows.length; i += 1) {
        const r = detailRows[i];
        if (Number(r.pos) !== i) {
          posAligned = false;
        }
        let acc = null;
        let det = null;
        try {
          acc = JSON.parse(r.accounting_json);
        } catch {
          acc = slimSteps[i] || {};
        }
        if (r.detail_json) {
          try {
            det = JSON.parse(r.detail_json);
          } catch {
            det = null;
          }
        }
        hydratedStepSigs[i] = tslHashStepStorageSig(r.accounting_json, r.detail_json);
        hydrated[i] = mergeStepFromStorage(acc, det, internString);
      }
      if (posAligned) {
        const prevDigest = persistedByLower.get(lower);
        if (prevDigest && prevDigest.cascadeId === dbCid && !prevDigest.stepSigs) {
          prevDigest.stepSigs = hydratedStepSigs;
        }
      }
      return hydrated;
    });
  }

  /**
   * Persists dirty conversations and removals incrementally inside a single `BEGIN IMMEDIATE` transaction.
   *
   * @param {{
   *   upserts: Array<{ cascadeId: string, entry: object }>,
   *   removals: string[],
   *   bumpEpoch?: boolean,
   *   truncateAll?: boolean,
   * }} batch
   */
  function flushDeltaBatch({
    upserts = [],
    removals = [],
    bumpEpoch = false,
    truncateAll = false,
  } = {}) {
    if (upserts.length === 0 && removals.length === 0 && !bumpEpoch && !truncateAll) {
      return true;
    }
    tslWithSqliteConnection(sqliteFilePath, { readOnly: false }, (db) => {
      tslEnsureSchema(db);
      db.exec('BEGIN IMMEDIATE');
      try {
        let seq = tslReadMetaInt(db, 'last_write_seq', localWriteSeq);
        let epoch = tslReadMetaInt(db, 'ledger_epoch', localEpoch);
        const nowMs = Date.now();

        if (bumpEpoch || truncateAll || removals.length > 0) {
          epoch += 1;
          db.prepare(
            "INSERT OR REPLACE INTO ledger_meta (key, value) VALUES ('ledger_epoch', ?)"
          ).run(String(epoch));
        }

        if (truncateAll) {
          const hasArchivedInDb = Boolean(
            db.prepare('SELECT 1 FROM conversations WHERE is_archived = 1 LIMIT 1').get()
          );
          if (!hasArchivedInDb) {
            db.exec('DELETE FROM steps; DELETE FROM conversations;');
            persistedByLower.clear();
          } else {
            db.exec(`
              DELETE FROM steps WHERE cascade_id NOT IN (
                SELECT cascade_id FROM conversations WHERE is_archived = 1
              );
              DELETE FROM conversations WHERE is_archived = 0;
            `);
            for (const [k, digest] of persistedByLower.entries()) {
              if (!digest?.archivedInt) {
                persistedByLower.delete(k);
              }
            }
          }
        } else if (removals.length > 0) {
          const lowerSet = new Set();
          const stepCidSet = new Set();
          for (const rawRem of removals) {
            const rawStr = String(rawRem || '').trim();
            if (!rawStr) continue;
            const lower = rawStr.toLowerCase();
            lowerSet.add(lower);
            stepCidSet.add(rawStr);
            const knownDigest = persistedByLower.get(lower);
            if (knownDigest?.cascadeId) {
              stepCidSet.add(knownDigest.cascadeId);
            }
            persistedByLower.delete(lower);
          }
          const lowerList = Array.from(lowerSet);
          for (let off = 0; off < lowerList.length; off += SQLITE_IN_CHUNK_SIZE) {
            const chunk = lowerList.slice(off, off + SQLITE_IN_CHUNK_SIZE);
            const placeholders = chunk.map(() => '?').join(',');
            const existingRows = db
              .prepare(`SELECT cascade_id FROM conversations WHERE lower_id IN (${placeholders})`)
              .all(...chunk);
            for (const row of existingRows || []) {
              if (row?.cascade_id) {
                stepCidSet.add(row.cascade_id);
              }
            }
          }
          const stepCidList = Array.from(stepCidSet);
          for (let off = 0; off < stepCidList.length; off += SQLITE_IN_CHUNK_SIZE) {
            const chunk = stepCidList.slice(off, off + SQLITE_IN_CHUNK_SIZE);
            const placeholders = chunk.map(() => '?').join(',');
            db.prepare(`DELETE FROM steps WHERE cascade_id IN (${placeholders})`).run(...chunk);
          }
          for (let off = 0; off < lowerList.length; off += SQLITE_IN_CHUNK_SIZE) {
            const chunk = lowerList.slice(off, off + SQLITE_IN_CHUNK_SIZE);
            const placeholders = chunk.map(() => '?').join(',');
            db.prepare(`DELETE FROM conversations WHERE lower_id IN (${placeholders})`).run(
              ...chunk
            );
          }
        }

        if (upserts.length > 0) {
          const selExisting = db.prepare(
            'SELECT cascade_id, step_count FROM conversations WHERE lower_id = ?'
          );
          const upConv = db.prepare(`
            INSERT OR REPLACE INTO conversations (
              cascade_id, lower_id, is_archived, step_count, write_seq, updated_at_ms, meta_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `);
          const upStep = db.prepare(`
            INSERT OR REPLACE INTO steps (cascade_id, pos, accounting_json, detail_json)
            VALUES (?, ?, ?, ?)
          `);
          const upSlimStepKeepDetail = db.prepare(`
            INSERT INTO steps (cascade_id, pos, accounting_json, detail_json)
            VALUES (?, ?, ?, NULL)
            ON CONFLICT(cascade_id, pos) DO UPDATE SET
              accounting_json = excluded.accounting_json
          `);
          const truncSteps = db.prepare('DELETE FROM steps WHERE cascade_id = ? AND pos >= ?');
          const rekeyStepsCid = db.prepare('UPDATE steps SET cascade_id = ? WHERE cascade_id = ?');

          for (const { cascadeId, entry } of upserts) {
            if (!cascadeId || !entry || typeof entry !== 'object') continue;
            const lower = String(cascadeId).toLowerCase();
            const prevDbRow = selExisting.get(lower);
            if (prevDbRow?.cascade_id && prevDbRow.cascade_id !== cascadeId) {
              rekeyStepsCid.run(cascadeId, prevDbRow.cascade_id);
            }

            const prevDigest = persistedByLower.get(lower) || null;
            const header = tslSerializeEntryHeader(entry);
            const metaJson = JSON.stringify(header);
            const archivedInt = entry.archived ? 1 : 0;
            const steps = Array.isArray(entry.steps) ? entry.steps : [];

            // When an entry is still in `_coldSteps` mode (only metadata such as `signature`, `title`,
            // `workspaceUri`, or `archived` changed without hydrating `detail_json`), NEVER overwrite
            // `detail_json` with NULL or truncate newer steps written concurrently by a peer process.
            if (entry._coldSteps) {
              if (prevDbRow) {
                const preservedStepCount = Math.max(steps.length, Number(prevDbRow.step_count || 0));
                if (
                  prevDigest &&
                  prevDigest.cascadeId === cascadeId &&
                  prevDigest.metaJson === metaJson &&
                  prevDigest.archivedInt === archivedInt &&
                  prevDbRow.cascade_id === cascadeId &&
                  Number(prevDbRow.step_count || 0) === preservedStepCount
                ) {
                  continue;
                }
                seq += 1;
                upConv.run(cascadeId, lower, archivedInt, preservedStepCount, seq, nowMs, metaJson);
                persistedByLower.set(lower, {
                  cascadeId,
                  metaJson,
                  archivedInt,
                  stepSigs:
                    preservedStepCount === steps.length ? prevDigest?.stepSigs || null : null,
                });
                continue;
              }

              // Cold entry flushed when row was absent in `conversations` (e.g. after external reset):
              // insert accounting tuples without ever clobbering any existing `detail_json`.
              for (let pos = 0; pos < steps.length; pos += 1) {
                const { accountingTuple } = splitStepForStorage(steps[pos]);
                upSlimStepKeepDetail.run(cascadeId, pos, JSON.stringify(accountingTuple));
              }
              seq += 1;
              upConv.run(cascadeId, lower, archivedInt, steps.length, seq, nowMs, metaJson);
              persistedByLower.set(lower, {
                cascadeId,
                metaJson,
                archivedInt,
                stepSigs: null,
              });
              continue;
            }

            const prevStepSigs =
              prevDigest?.cascadeId === cascadeId && Array.isArray(prevDigest.stepSigs)
                ? prevDigest.stepSigs
                : null;
            const nextStepSigs = new Array(steps.length);
            let anyStepWritten = false;

            for (let pos = 0; pos < steps.length; pos += 1) {
              const rawStep = steps[pos];
              const { accountingTuple, detailObj } = splitStepForStorage(rawStep);
              const accJson = JSON.stringify(accountingTuple);
              const detJson = detailObj ? JSON.stringify(detailObj) : null;
              const isUnexpandedSlim = Boolean(rawStep?._isSlimStep === true && detJson === null);
              const sig = tslHashStepStorageSig(accJson, detJson);
              nextStepSigs[pos] = sig;
              if (!prevStepSigs || prevStepSigs[pos] !== sig) {
                if (isUnexpandedSlim) {
                  upSlimStepKeepDetail.run(cascadeId, pos, accJson);
                } else {
                  upStep.run(cascadeId, pos, accJson, detJson);
                }
                anyStepWritten = true;
              }
            }

            const prevCount = prevDbRow
              ? Number(prevDbRow.step_count || 0)
              : prevStepSigs
                ? prevStepSigs.length
                : 0;
            if (steps.length < prevCount) {
              truncSteps.run(cascadeId, steps.length);
              anyStepWritten = true;
            }

            if (
              anyStepWritten ||
              !prevDigest ||
              prevDigest.cascadeId !== cascadeId ||
              prevDigest.metaJson !== metaJson ||
              prevDigest.archivedInt !== archivedInt ||
              prevCount !== steps.length
            ) {
              seq += 1;
              upConv.run(cascadeId, lower, archivedInt, steps.length, seq, nowMs, metaJson);
            }

            persistedByLower.set(lower, {
              cascadeId,
              metaJson,
              archivedInt,
              stepSigs: nextStepSigs,
            });
          }
        }

        db.prepare(
          "INSERT OR REPLACE INTO ledger_meta (key, value) VALUES ('last_write_seq', ?)"
        ).run(String(seq));
        db.exec('COMMIT');
        localEpoch = epoch;
        localWriteSeq = seq;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Ignore rollback error
        }
        throw err;
      }
    });

    refreshWalSigAfterOwnWrite();
    return true;
  }

  /**
   * Checks WAL composite signature and pulls incremental updates or epoch resets written by peer processes.
   *
   * @returns {{
   *   changed: boolean,
   *   fullReset?: boolean,
   *   cacheObj?: Record<string, any>,
   *   updatedEntries?: Array<{ cascadeId: string, lowerId: string, entry: object }>,
   * }}
   */
  function syncExternalChangesIfNeeded() {
    const walInfo = computeSqliteWalSig(sqliteFilePath);
    if (!walInfo.exists || !walInfo.sig || walInfo.sig === lastSeenWalSig) {
      return { changed: false };
    }

    let fullResetNeeded = false;
    const updatedEntries = [];

    tslWithSqliteConnection(sqliteFilePath, { readOnly: true }, (db) => {
      const dbEpoch = tslReadMetaInt(db, 'ledger_epoch', 1);
      const dbSeq = tslReadMetaInt(db, 'last_write_seq', 0);
      if (dbEpoch !== localEpoch) {
        fullResetNeeded = true;
        return;
      }
      if (dbSeq <= localWriteSeq) {
        localWriteSeq = dbSeq;
        return;
      }
      const changedConvs = db
        .prepare(
          `SELECT cascade_id, lower_id, is_archived, step_count, write_seq, meta_json
           FROM conversations
           WHERE write_seq > ?
           ORDER BY write_seq ASC`
        )
        .all(localWriteSeq);
      const selSteps = db.prepare(
        'SELECT pos, accounting_json FROM steps WHERE cascade_id = ? ORDER BY pos ASC'
      );
      for (const row of changedConvs) {
        let meta = {};
        try {
          meta = JSON.parse(row.meta_json) || {};
        } catch {
          meta = {};
        }
        const sRows = selSteps.all(row.cascade_id);
        const slimSteps = [];
        for (const sr of sRows) {
          try {
            slimSteps.push(buildSlimStepFromAccounting(JSON.parse(sr.accounting_json), internString));
          } catch {
            // Skip malformed step JSON
          }
        }
        const entry = {
          ...meta,
          ...(row.is_archived ? { archived: true } : {}),
          _coldSteps: true,
          steps: slimSteps,
        };
        if (!row.is_archived && entry.archived) {
          delete entry.archived;
        }
        persistedByLower.set(row.lower_id, {
          cascadeId: row.cascade_id,
          metaJson: row.meta_json,
          archivedInt: row.is_archived ? 1 : 0,
          stepSigs: null,
        });
        updatedEntries.push({
          cascadeId: row.cascade_id,
          lowerId: row.lower_id,
          entry,
        });
      }
      localWriteSeq = dbSeq;
    });

    if (fullResetNeeded) {
      persistedByLower.clear();
      const full = hydrateAllSlimFromDb();
      return { changed: true, fullReset: true, cacheObj: full.cacheObj };
    }

    lastSeenWalSig = walInfo.sig;
    if (updatedEntries.length === 0) {
      return { changed: false };
    }
    return { changed: true, fullReset: false, updatedEntries };
  }

  /**
   * 在单事务内在线脱敏指定已删会话的标题、Swarm 标题、子代理初始提示词及步骤明文提示词，
   * 100% 保留 `accounting_json` 与用量统计，递增 `ledger_epoch` 并执行 WAL 截断检查点清除旧明文页。
   *
   * @param {Iterable<string>} targetIds
   * @param {{ placeholderTitle?: string }} [options={}]
   * @returns {{ redactedConversations: number, redactedSteps: number, changedIds: string[] }}
   */
  function redactConversations(targetIds, { placeholderTitle = DEFAULT_REDACTED_SESSION_TITLE } = {}) {
    const lowers = [];
    const seen = new Set();
    for (const raw of targetIds || []) {
      const lower = String(raw || '').trim().toLowerCase();
      if (!lower || seen.has(lower)) continue;
      seen.add(lower);
      lowers.push(lower);
    }
    if (lowers.length === 0 || !existsSync(sqliteFilePath)) {
      return { redactedConversations: 0, redactedSteps: 0, changedIds: [] };
    }

    let redactedConversations = 0;
    let redactedSteps = 0;
    const changedIds = [];

    tslWithSqliteConnection(sqliteFilePath, { readOnly: false }, (db) => {
      tslEnsureSchema(db);
      db.exec('PRAGMA secure_delete = ON;');
      db.exec('BEGIN IMMEDIATE');
      try {
        let seq = tslReadMetaInt(db, 'last_write_seq', localWriteSeq);
        let epoch = tslReadMetaInt(db, 'ledger_epoch', localEpoch);
        const nowMs = Date.now();

        const selConv = db.prepare(
          'SELECT cascade_id, lower_id, is_archived, meta_json FROM conversations WHERE lower_id = ?'
        );
        const updConv = db.prepare(
          'UPDATE conversations SET is_archived = 1, write_seq = ?, updated_at_ms = ?, meta_json = ? WHERE lower_id = ?'
        );
        const selSteps = db.prepare(
          'SELECT pos, detail_json FROM steps WHERE cascade_id = ? AND detail_json IS NOT NULL'
        );
        const updStep = db.prepare(
          'UPDATE steps SET detail_json = ? WHERE cascade_id = ? AND pos = ?'
        );

        let anyChanged = false;

        for (const lower of lowers) {
          const convRow = selConv.get(lower);
          if (!convRow) continue;

          let parsedMeta = {};
          try {
            parsedMeta = JSON.parse(convRow.meta_json) || {};
          } catch {
            parsedMeta = {};
          }
          const { meta: nextMeta, changed: metaChanged } = redactLedgerMetaObject(parsedMeta, {
            placeholderTitle,
          });

          const stepRows = selSteps.all(convRow.cascade_id) || [];
          let convStepsChanged = 0;
          for (const sr of stepRows) {
            let parsedDet = null;
            try {
              parsedDet = JSON.parse(sr.detail_json);
            } catch {
              continue;
            }
            const { detail: nextDet, changed: detChanged } = redactLedgerStepDetailObject(parsedDet);
            if (!detChanged) continue;
            updStep.run(nextDet ? JSON.stringify(nextDet) : null, convRow.cascade_id, sr.pos);
            convStepsChanged += 1;
            redactedSteps += 1;
          }

          if (metaChanged || !convRow.is_archived || convStepsChanged > 0) {
            seq += 1;
            const nextMetaJson = JSON.stringify(nextMeta);
            updConv.run(seq, nowMs, nextMetaJson, lower);
            persistedByLower.set(lower, {
              cascadeId: convRow.cascade_id,
              metaJson: nextMetaJson,
              archivedInt: 1,
              stepSigs: null,
            });
            redactedConversations += 1;
            changedIds.push(convRow.cascade_id);
            anyChanged = true;
          }
        }

        if (anyChanged) {
          epoch += 1;
          db.prepare(
            "INSERT OR REPLACE INTO ledger_meta (key, value) VALUES ('ledger_epoch', ?)"
          ).run(String(epoch));
          db.prepare(
            "INSERT OR REPLACE INTO ledger_meta (key, value) VALUES ('last_write_seq', ?)"
          ).run(String(seq));
        }

        db.exec('COMMIT');
        localEpoch = epoch;
        localWriteSeq = seq;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Ignore rollback error
        }
        throw err;
      }

      if (redactedConversations > 0 || redactedSteps > 0) {
        try {
          db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        } catch {
          // 忽略检查点异常，已提交数据安全无损
        }
      }
    });

    if (redactedConversations > 0 || redactedSteps > 0) {
      refreshWalSigAfterOwnWrite();
    }
    return { redactedConversations, redactedSteps, changedIds };
  }

  /**
   * 在单事务内将跨端 `move` 迁移的源会话账本条目无损重绑到新分配的 `toCascadeId`，
   * 保留全部历史步级 `accounting_json` 与 `detail_json`，同时消除源 ID 永久归档导致的双倍计费。
   *
   * @param {Array<{ fromCascadeId: string, toCascadeId: string, patchMeta?: Record<string, any> }>} rekeySpecs
   * @returns {{ rekeyedCount: number, pairs: Array<{ fromCascadeId: string, toCascadeId: string }> }}
   */
  function rekeyConversations(rekeySpecs = []) {
    const validSpecs = [];
    const seenFrom = new Set();
    for (const raw of Array.isArray(rekeySpecs) ? rekeySpecs : []) {
      const fromLower = String(raw?.fromCascadeId || '').trim().toLowerCase();
      const toCid = String(raw?.toCascadeId || '').trim();
      const toLower = toCid.toLowerCase();
      if (!fromLower || !toLower || fromLower === toLower || seenFrom.has(fromLower)) continue;
      seenFrom.add(fromLower);
      validSpecs.push({
        fromLower,
        toCid,
        toLower,
        patchMeta: isPlainObject(raw?.patchMeta) ? raw.patchMeta : null,
      });
    }
    if (validSpecs.length === 0 || !existsSync(sqliteFilePath)) {
      return { rekeyedCount: 0, pairs: [] };
    }

    const pairs = [];
    tslWithSqliteConnection(sqliteFilePath, { readOnly: false }, (db) => {
      tslEnsureSchema(db);
      db.exec('BEGIN IMMEDIATE');
      try {
        let seq = tslReadMetaInt(db, 'last_write_seq', localWriteSeq);
        let epoch = tslReadMetaInt(db, 'ledger_epoch', localEpoch);
        const nowMs = Date.now();

        const selConv = db.prepare(
          'SELECT cascade_id, lower_id, is_archived, step_count, meta_json FROM conversations WHERE lower_id = ?'
        );
        const delConv = db.prepare('DELETE FROM conversations WHERE lower_id = ?');
        const delSteps = db.prepare('DELETE FROM steps WHERE cascade_id = ?');
        const moveSteps = db.prepare('UPDATE steps SET cascade_id = ? WHERE cascade_id = ?');
        const insConv = db.prepare(`
          INSERT OR REPLACE INTO conversations (
            cascade_id, lower_id, is_archived, step_count, write_seq, updated_at_ms, meta_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        for (const { fromLower, toCid, toLower, patchMeta } of validSpecs) {
          const srcRow = selConv.get(fromLower);
          if (!srcRow) continue;

          const dstRow = selConv.get(toLower);
          const prevFromDigest = persistedByLower.get(fromLower) || null;

          if (dstRow && Number(dstRow.step_count || 0) >= Number(srcRow.step_count || 0)) {
            delSteps.run(srcRow.cascade_id);
            delConv.run(fromLower);
            persistedByLower.delete(fromLower);
            pairs.push({ fromCascadeId: srcRow.cascade_id, toCascadeId: dstRow.cascade_id });
            continue;
          }

          if (dstRow) {
            delSteps.run(dstRow.cascade_id);
            delConv.run(toLower);
            persistedByLower.delete(toLower);
          }

          let parsedMeta = {};
          try {
            parsedMeta = JSON.parse(srcRow.meta_json) || {};
          } catch {
            parsedMeta = {};
          }
          const mergedMeta = patchMeta ? { ...parsedMeta, ...patchMeta } : { ...parsedMeta };
          delete mergedMeta.signature;
          let archivedInt = srcRow.is_archived ? 1 : 0;
          if (patchMeta && Object.prototype.hasOwnProperty.call(patchMeta, 'archived')) {
            archivedInt = patchMeta.archived ? 1 : 0;
          }
          if (!archivedInt && mergedMeta.archived) {
            delete mergedMeta.archived;
          } else if (archivedInt) {
            mergedMeta.archived = true;
          }
          const nextMetaJson = JSON.stringify(mergedMeta);

          moveSteps.run(toCid, srcRow.cascade_id);
          delConv.run(fromLower);
          seq += 1;
          insConv.run(
            toCid,
            toLower,
            archivedInt,
            Number(srcRow.step_count || 0),
            seq,
            nowMs,
            nextMetaJson
          );

          persistedByLower.delete(fromLower);
          persistedByLower.set(toLower, {
            cascadeId: toCid,
            metaJson: nextMetaJson,
            archivedInt,
            stepSigs: prevFromDigest?.stepSigs || null,
          });
          pairs.push({ fromCascadeId: srcRow.cascade_id, toCascadeId: toCid });
        }

        if (pairs.length > 0) {
          epoch += 1;
          db.prepare(
            "INSERT OR REPLACE INTO ledger_meta (key, value) VALUES ('ledger_epoch', ?)"
          ).run(String(epoch));
          db.prepare(
            "INSERT OR REPLACE INTO ledger_meta (key, value) VALUES ('last_write_seq', ?)"
          ).run(String(seq));
        }

        db.exec('COMMIT');
        localEpoch = epoch;
        localWriteSeq = seq;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Ignore rollback error
        }
        throw err;
      }
    });

    if (pairs.length > 0) {
      refreshWalSigAfterOwnWrite();
    }
    return { rekeyedCount: pairs.length, pairs };
  }

  function releasePersistedStepSigs(lowerId) {
    const key = String(lowerId || '').trim().toLowerCase();
    if (!key) return;
    const prev = persistedByLower.get(key);
    if (prev && prev.stepSigs) {
      prev.stepSigs = null;
    }
  }

  return {
    sqliteFilePath,
    internString,
    openAndHydrateInitial,
    loadHydratedStepsForConversation,
    flushDeltaBatch,
    syncExternalChangesIfNeeded,
    redactConversations,
    rekeyConversations,
    releasePersistedStepSigs,
    dehydrateStep: (step) => dehydrateStepForColdMemory(step, internString),
  };
}
