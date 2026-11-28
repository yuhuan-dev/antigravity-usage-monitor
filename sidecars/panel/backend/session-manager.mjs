/**
 * @fileoverview 本机三端会话扫描、遥测融合、迁移目录投影与双通道清理编排模块 (`session-manager.mjs`)。
 *
 * 定位：为 Usage Monitor 原生「会话中心（Session Hub）」提供一站式后端服务：
 * 1. 四路合并扫描本机 Desktop / CLI / 旧版 IDE 会话，融合本插件账本的 Token/费用/步数遥测，
 *    并在单次扫描内零重复读取地同步投影跨端迁移目录 (`migrationCatalog`)；
 * 2. 删除前精准影响面预览（按端运行态/在线接口能力、实时运行态核验、级联子代理、跨源仅索引、迁移归档保护）；
 * 3. 双通道删除（离线两阶段事务清理 + 运行中官方 `DeleteConversation` 在线删除）与历史已删会话账本隐私补扫。
 */

import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { extractShortPromptTitle } from '../shared/prompt-clean.mjs';
import {
  parseWorkspaceDisplayLabel,
  parseWorkspaceUrisColumn,
} from '../shared/workspace-uri.mjs';
import { parseIsoMs } from '../trajectory-metrics.mjs';
import { parseAnnotationPbtxtTitle } from './cli-sqlite-reader.mjs';
import { getLocalTrajectoryCacheStore } from './config.mjs';
import { computeStepCost, createStepModelResolver } from './model-pricing.mjs';
import {
  parseSummaryProtoIndexIds,
  readProtoString,
  readProtoVarint,
  readSubEnd,
  skipProtoField,
  toUint8Array,
} from './proto-wire.mjs';
import {
  cleanClientSessionsBatch,
  cleanupCrossClientIndexOnlyResiduals,
  clearElectronBrowserCachesIfIdle,
  expandStoreCascadeTargets,
  recoverPendingCleanups,
  redactDeletedLedgerSessions,
} from './session-cleaner.mjs';
import {
  deleteConversationOnline,
  detectOnlineDeleteClientsAsync,
  getConversationLiveState,
  invalidateOnlineDeleteEndpointCache,
  resolveClientOnlineDeleteEndpoint,
} from './session-online-delete.mjs';
import {
  SESSION_CLIENT_DEFS,
  cleanupLinkedMigrationSourcesForDeletedTargets,
  collectStoreArtifactIds,
  collectStoreIndexIds,
  decodeMetaBlobLight,
  decodeSummaryRelationsLight,
  detectRunningClients,
  detectRunningClientsAsync,
  extractDesktopProjectsFromSummaryMap,
  findProtectedMigrationArchives,
  getSessionClientDef,
  isDbLightSubagent,
  isForkSession,
  normalizeSessionUuid,
  readConversationParentsMap,
  resolveElectronAppDataDir,
  resolveGeminiDir,
  resolveLocalWorkspaceProjectDir,
  resolveMigrationBackupRoot,
  resolveNoFollowFile,
  resolveNoFollowPath,
  resolveScopedTrajectoryCacheStore,
  sumVerifiedDirTreeBytes,
} from './session-store.mjs';
import {
  computeSqliteWalSig,
  hasBuiltinNodeSqlite,
  normalizeSqliteIsoTime,
  withReadOnlySqliteDb,
} from './sqlite-client.mjs';

const TITLE_TRANSCRIPT_HEAD_BYTES = 128 * 1024;
const MAX_COLD_DB_INSPECTS_PER_CLIENT = 160;

// 最近扫描授权的项目目录白名单（供受控 reveal 校验使用）
const authorizedProjectDirs = new Set();

function rememberAuthorizedProjectDir(dirPath) {
  const clean = String(dirPath || '').trim();
  if (!clean) return;
  authorizedProjectDirs.add(clean);
  if (authorizedProjectDirs.size > 2000) {
    const first = authorizedProjectDirs.values().next().value;
    if (first) authorizedProjectDirs.delete(first);
  }
}

export function getAuthorizedRevealSnapshot() {
  return new Set(authorizedProjectDirs);
}

// ---------------------------------------------------------------------------
// 轻量磁盘/SQLite 读取辅助
// ---------------------------------------------------------------------------

const MAX_BRAIN_SIZE_CACHE = 8192;
const MAX_SESSION_META_CACHE = 4096;
const MAX_SUMMARY_SNAPSHOT_CACHE = 16;
const brainInfoMemo = new Map(); // absBrainPath -> { sig, sizeBytes, hasTranscript, transcriptPath, transcriptStat }
const dbLightMemo = new Map(); // absDbPath -> { sig: string, hasPromptTitle: boolean, data: object | null }
const transcriptTitleMemo = new Map(); // absTranscriptPath -> { sig: string, title: string }
const annotationTitleMemo = new Map(); // absAnnPath -> { sig: string, title: string }
const summarySnapshotMemo = new Map(); // `${dbPath}|${expectedAppDataDir}` -> { sig, snapshot }
const ledgerEntrySummaryMemo = new WeakMap(); // entry -> { stepsRef, stepCount, archived, summary }

function lruGet(map, key) {
  const hit = map.get(key);
  if (hit === undefined) return undefined;
  map.delete(key);
  map.set(key, hit);
  return hit;
}

function lruSet(map, key, val, maxSize) {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  while (map.size > maxSize) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function clearSessionManagerScanCaches() {
  brainInfoMemo.clear();
  dbLightMemo.clear();
  transcriptTitleMemo.clear();
  annotationTitleMemo.clear();
  summarySnapshotMemo.clear();
}

function resolveSyncOnlineDeleteClients(runningClients, options = {}) {
  const out = { desktop: false, cli: false, ide_legacy: false };
  if (!runningClients?.checked) return out;
  const ov = options?.onlineDeleteClientsOverride;
  if (ov && typeof ov === 'object') {
    out.desktop = Boolean(runningClients.desktop && ov.desktop);
    out.cli = Boolean(runningClients.cli && ov.cli);
  }
  return out;
}

function evaluateSessionDeleteCapability({
  runningClients,
  onlineDeleteClients,
  clientId,
  sessionRunning,
  indexOnly,
}) {
  if (!runningClients?.checked) {
    return { canDelete: false, deleteMode: 'blocked', deleteBlockedReason: 'process_check_failed' };
  }
  if (!runningClients[clientId]) {
    return { canDelete: true, deleteMode: 'offline', deleteBlockedReason: '' };
  }
  if (!onlineDeleteClients?.[clientId]) {
    return { canDelete: false, deleteMode: 'blocked', deleteBlockedReason: 'client_running' };
  }
  if (sessionRunning) {
    return { canDelete: false, deleteMode: 'blocked', deleteBlockedReason: 'session_running' };
  }
  if (indexOnly) {
    return { canDelete: false, deleteMode: 'blocked', deleteBlockedReason: 'index_only_online' };
  }
  return { canDelete: true, deleteMode: 'online', deleteBlockedReason: '' };
}

function lstatVerifiedChild(verifiedParentDir, childName, { expectFile = false, expectDir = false } = {}) {
  const seg = String(childName || '');
  if (!seg || seg === '.' || seg === '..' || seg.includes('/') || seg.includes('\\') || seg.includes('\0')) {
    return { ok: false, path: '', exists: false, stat: null };
  }
  const fullPath = join(verifiedParentDir, seg);
  try {
    const st = lstatSync(fullPath);
    if (st.isSymbolicLink()) return { ok: false, path: fullPath, exists: true, stat: st };
    if (expectFile && !st.isFile()) return { ok: false, path: fullPath, exists: true, stat: st };
    if (expectDir && !st.isDirectory()) return { ok: false, path: fullPath, exists: true, stat: st };
    return { ok: true, path: fullPath, exists: true, stat: st };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, path: fullPath, exists: false, stat: null };
    return { ok: false, path: fullPath, exists: false, stat: null };
  }
}

function lstatMtimeAndSizeSig(filePath) {
  try {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink()) return 'sym';
    return `${Math.trunc(st.mtimeMs)}:${st.size}`;
  } catch {
    return '0';
  }
}

function inspectBrainDirInfo(brainPath, brainStat, extraSig = '') {
  if (!brainPath || !brainStat || !brainStat.isDirectory()) {
    return { sizeBytes: 0, truncated: false, hasTranscript: false, transcriptPath: '', transcriptStat: null };
  }
  const sysCheck = lstatVerifiedChild(brainPath, '.system_generated', { expectDir: true });
  const sysDir = sysCheck.ok && sysCheck.exists ? sysCheck.path : '';
  const logsCheck = sysDir ? lstatVerifiedChild(sysDir, 'logs', { expectDir: true }) : null;
  const logsDir = logsCheck && logsCheck.ok && logsCheck.exists ? logsCheck.path : '';
  const stepsDir = sysDir ? join(sysDir, 'steps') : '';
  const tasksDir = sysDir ? join(sysDir, 'tasks') : '';
  const uploadsDir = join(brainPath, '.user_uploaded');
  const scratchDir = join(brainPath, 'scratch');
  const browserSandboxDir = join(brainPath, 'browser_sandbox');

  const fullLogCheck = logsDir
    ? lstatVerifiedChild(logsDir, 'transcript_full.jsonl', { expectFile: true })
    : null;
  const fullLogStat = fullLogCheck && fullLogCheck.ok && fullLogCheck.exists ? fullLogCheck.stat : null;
  const fullLogPath = fullLogStat ? fullLogCheck.path : '';

  const shortLogCheck = logsDir
    ? lstatVerifiedChild(logsDir, 'transcript.jsonl', { expectFile: true })
    : null;
  const shortLogStat = shortLogCheck && shortLogCheck.ok && shortLogCheck.exists ? shortLogCheck.stat : null;
  const shortLogPath = shortLogStat ? shortLogCheck.path : '';

  const transcriptPath = fullLogStat ? fullLogPath : shortLogStat ? shortLogPath : '';
  const transcriptStat = fullLogStat || shortLogStat || null;
  const hasTranscript = Boolean(transcriptStat);

  const sig = [
    Math.trunc(brainStat.mtimeMs),
    fullLogStat ? `${Math.trunc(fullLogStat.mtimeMs)}:${fullLogStat.size}` : '0',
    shortLogStat ? `${Math.trunc(shortLogStat.mtimeMs)}:${shortLogStat.size}` : '0',
    sysCheck.ok && sysCheck.exists && sysCheck.stat ? `${Math.trunc(sysCheck.stat.mtimeMs)}:${sysCheck.stat.size}` : '0',
    logsCheck && logsCheck.ok && logsCheck.exists && logsCheck.stat ? `${Math.trunc(logsCheck.stat.mtimeMs)}:${logsCheck.stat.size}` : '0',
    stepsDir ? lstatMtimeAndSizeSig(stepsDir) : '0',
    tasksDir ? lstatMtimeAndSizeSig(tasksDir) : '0',
    lstatMtimeAndSizeSig(uploadsDir),
    lstatMtimeAndSizeSig(scratchDir),
    lstatMtimeAndSizeSig(browserSandboxDir),
    extraSig || '',
  ].join('|');

  const hit = lruGet(brainInfoMemo, brainPath);
  if (hit && hit.sig === sig) {
    return hit;
  }

  // 全量递归统计 brain/<cid> 磁盘占用（含 .system_generated/steps、browser_sandbox、媒体与嵌套子目录），
  // 严格拦截符号链接并对遍历深度与条目数设置安全上界，通过 signature + LRU 缓存规避重复冷扫开销
  const { sizeBytes, truncated } = sumVerifiedDirTreeBytes(brainPath);
  const info = { sig, sizeBytes, truncated, hasTranscript, transcriptPath, transcriptStat };
  lruSet(brainInfoMemo, brainPath, info, MAX_BRAIN_SIZE_CACHE);
  return info;
}

function readAnnotationTitleCached(annPath, annStat) {
  const sig = annStat ? `${Math.trunc(annStat.mtimeMs)}:${annStat.size}` : lstatMtimeAndSizeSig(annPath);
  if (sig && sig !== '0' && sig !== 'sym') {
    const cached = lruGet(annotationTitleMemo, annPath);
    if (cached && cached.sig === sig) return cached.title;
  }
  let title = '';
  try {
    title = parseAnnotationPbtxtTitle(readFileSync(annPath, 'utf8'));
  } catch {
    title = '';
  }
  if (sig && sig !== '0' && sig !== 'sym') {
    lruSet(annotationTitleMemo, annPath, { sig, title }, MAX_SESSION_META_CACHE);
  }
  return title;
}

function readTranscriptHeadText(filePath, maxBytes = TITLE_TRANSCRIPT_HEAD_BYTES) {
  let fd = null;
  try {
    fd = openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
    if (bytesRead <= 0) return '';
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function isHiddenTranscriptStepStatus(rawStatus) {
  if (rawStatus === undefined || rawStatus === null || rawStatus === '') return false;
  const num = Number(rawStatus);
  if (num === 4 || num === 5 || num === 6) return true;
  const upper = String(rawStatus).trim().toUpperCase();
  return (
    upper === 'CLEARED' ||
    upper === 'INVALID' ||
    upper === 'CANCELED' ||
    upper === 'CANCELLED' ||
    upper === 'CORTEX_STEP_STATUS_CLEARED' ||
    upper === 'CORTEX_STEP_STATUS_INVALID' ||
    upper === 'CORTEX_STEP_STATUS_CANCELED'
  );
}

function extractTranscriptTextContent(entry) {
  if (!entry || typeof entry !== 'object') return '';
  if (typeof entry.content === 'string') return entry.content;
  if (typeof entry.text === 'string') return entry.text;
  if (typeof entry.message === 'string') return entry.message;
  if (Array.isArray(entry.content)) {
    const parts = [];
    for (const block of entry.content) {
      if (typeof block === 'string') {
        parts.push(block);
      } else if (block && typeof block === 'object') {
        if (block.thought === true || block.type === 'thinking') continue;
        if (typeof block.text === 'string') parts.push(block.text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

function extractFirstUserTitleFromTranscriptFile(filePath, fileStat = null) {
  const sig = fileStat
    ? `${Math.trunc(fileStat.mtimeMs)}:${fileStat.size}`
    : lstatMtimeAndSizeSig(filePath);
  if (sig && sig !== '0' && sig !== 'sym') {
    const cached = lruGet(transcriptTitleMemo, filePath);
    if (cached && cached.sig === sig) {
      return cached.title;
    }
  }
  const chunk = readTranscriptHeadText(filePath, TITLE_TRANSCRIPT_HEAD_BYTES);
  let title = '';
  if (chunk) {
    for (const rawLine of chunk.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (isHiddenTranscriptStepStatus(parsed?.status)) continue;
        const role = String(parsed?.role || '').trim().toLowerCase();
        const type = String(parsed?.type || '').trim().toUpperCase();
        if (role === 'user' || type === 'USER_INPUT' || type === 'CORTEX_STEP_TYPE_USER_INPUT') {
          const rawText = extractTranscriptTextContent(parsed);
          const candidate = extractShortPromptTitle(rawText, 76, { firstLineOnly: true });
          if (candidate) {
            title = candidate;
            break;
          }
        }
      } catch {
        // 忽略截断末行或损坏 JSON
      }
    }
  }
  if (sig && sig !== '0' && sig !== 'sym') {
    lruSet(transcriptTitleMemo, filePath, { sig, title }, MAX_SESSION_META_CACHE);
  }
  return title;
}

function decodeUserPromptFromStepPayload(rawBlob) {
  const buf = toUint8Array(rawBlob);
  if (!buf || buf.byteLength === 0) return '';
  const state = { off: 0 };
  const end = buf.byteLength;
  while (state.off < end) {
    const tag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 19 && wt === 2) {
      const uiEnd = readSubEnd(buf, state, end);
      let query = '';
      let userResponse = '';
      const items = [];
      while (state.off < uiEnd) {
        const uTag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, uiEnd)));
        const uFn = uTag >>> 3;
        const uWt = uTag & 7;
        if (uFn === 1 && uWt === 2) {
          query = readProtoString(buf, state, uiEnd);
        } else if (uFn === 2 && uWt === 2) {
          userResponse = readProtoString(buf, state, uiEnd);
        } else if (uFn === 3 && uWt === 2) {
          const itEnd = readSubEnd(buf, state, uiEnd);
          while (state.off < itEnd) {
            const iTag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, itEnd)));
            if ((iTag >>> 3) === 1 && (iTag & 7) === 2) {
              const txt = readProtoString(buf, state, itEnd);
              if (txt) items.push(txt);
            } else {
              skipProtoField(buf, state, iTag & 7, itEnd);
            }
          }
          state.off = itEnd;
        } else {
          skipProtoField(buf, state, uWt, uiEnd);
        }
      }
      state.off = uiEnd;
      return userResponse || items.join('\n') || query || '';
    }
    skipProtoField(buf, state, wt, end);
  }
  return '';
}

function inspectConversationDbLight(
  dbPath,
  { needPromptTitle = false, dbStat = null, walStat = null } = {}
) {
  const dbSig = dbStat
    ? `${Math.trunc(dbStat.mtimeMs)}:${dbStat.size}`
    : lstatMtimeAndSizeSig(dbPath);
  const walSize = Number(walStat?.size || 0);
  const walSig = walSize > 0 ? `${Math.trunc(walStat.mtimeMs)}:${walSize}` : '0';
  const sig = `${dbSig}|${walSig}`;
  if (dbSig && dbSig !== '0' && dbSig !== 'sym') {
    const cached = lruGet(dbLightMemo, dbPath);
    if (cached && cached.sig === sig && (!needPromptTitle || cached.hasPromptTitle)) {
      return cached.data;
    }
  }

  let result = null;
  try {
    result = withReadOnlySqliteDb(
      dbPath,
      (db) => {
        let trajectoryType = 0;
        let sourceNum = 0;
        try {
          const mr = db.prepare('SELECT trajectory_type, source FROM trajectory_meta LIMIT 1').get();
          trajectoryType = Number(mr?.trajectory_type || 0);
          sourceNum = Number(mr?.source || 0);
        } catch {
          // ignore
        }

        let stepCount = 0;
        let genCount = 0;
        let firstPromptTitle = '';
        try {
          const cRow = db.prepare('SELECT count(*) AS cnt FROM steps').get();
          stepCount = Math.max(0, Number(cRow?.cnt || 0));
          if (needPromptTitle && stepCount > 0) {
            const uiRows = db
              .prepare('SELECT step_payload FROM steps WHERE step_type = 14 ORDER BY idx ASC LIMIT 3')
              .all();
            for (const r of uiRows || []) {
              if (!r?.step_payload) continue;
              const raw = decodeUserPromptFromStepPayload(r.step_payload);
              const title = extractShortPromptTitle(raw, 76, { firstLineOnly: true });
              if (title) {
                firstPromptTitle = title;
                break;
              }
            }
          }
        } catch {
          // ignore
        }
        try {
          const gRow = db.prepare('SELECT count(*) AS cnt FROM gen_metadata').get();
          genCount = Math.max(0, Number(gRow?.cnt || 0));
        } catch {
          // ignore
        }

        let metaBlobInfo = {
          workspaceUri: '',
          projectId: '',
          parentConversationId: '',
          rootConversationId: '',
          nestingDepth: 0,
          hasSubagentSpec: false,
          createdMs: 0,
        };
        try {
          const br = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main' LIMIT 1").get();
          if (br?.data) metaBlobInfo = decodeMetaBlobLight(br.data);
        } catch {
          // ignore
        }

        return {
          trajectoryType,
          sourceNum,
          stepCount,
          genCount,
          firstPromptTitle,
          ...metaBlobInfo,
        };
      },
      { busyTimeoutMs: 120, maxAttempts: 1, dbStat, walStat, skipWalStat: walStat === null && dbStat !== null }
    );
  } catch {
    return null;
  }

  if (result && dbSig && dbSig !== '0' && dbSig !== 'sym') {
    lruSet(
      dbLightMemo,
      dbPath,
      { sig, hasPromptTitle: Boolean(needPromptTitle), data: result },
      MAX_SESSION_META_CACHE
    );
  }
  return result;
}

function readClientSummarySnapshot(clientRoot, expectedAppDataDir) {
  const sumCheck = resolveNoFollowFile(clientRoot, ['conversation_summaries.db']);
  const summaryMap = new Map();
  let parentTableMap = new Map();
  const sideQuestionParentMap = new Map();
  if (!sumCheck.ok || !sumCheck.exists || !hasBuiltinNodeSqlite()) {
    return { hasSummaryDb: Boolean(sumCheck.exists), summaryMap, parentTableMap, sideQuestionParentMap };
  }
  const walSig = computeSqliteWalSig(sumCheck.path);
  const cacheKey = `${sumCheck.path}|${expectedAppDataDir || ''}`;
  if (walSig.exists && walSig.sig) {
    const cached = lruGet(summarySnapshotMemo, cacheKey);
    if (cached && cached.sig === walSig.sig) {
      return cached.snapshot;
    }
  }
  try {
    withReadOnlySqliteDb(sumCheck.path, (db) => {
      let rows = [];
      try {
        rows = db
          .prepare(
            `SELECT
              conversation_id, title, preview, step_count, last_modified_time,
              workspace_uris, status, source, project_id, parent_conversation_id,
              nesting_depth, not_fully_idle, killed, app_data_dir, raw_summary
            FROM conversation_summaries`
          )
          .all();
      } catch {
        try {
          rows = db
            .prepare(
              `SELECT
                conversation_id, title, step_count, last_modified_time,
                workspace_uris, status, project_id, parent_conversation_id,
                nesting_depth, app_data_dir
              FROM conversation_summaries`
            )
            .all();
        } catch {
          rows = [];
        }
      }

      for (const row of rows || []) {
        const cid = normalizeSessionUuid(row?.conversation_id);
        if (!cid) continue;
        const rowDir = String(row?.app_data_dir || '').trim().toLowerCase();
        const isNative = !rowDir || rowDir === expectedAppDataDir;
        const prev = summaryMap.get(cid);
        if (!prev || (isNative && !prev._isNative)) {
          const rel = decodeSummaryRelationsLight(row);
          summaryMap.set(cid, { ...row, _isNative: isNative, _relations: rel });
          for (const sqId of rel.sideQuestionChildren) {
            if (sqId !== cid) {
              sideQuestionParentMap.set(sqId, cid);
            }
          }
        }
      }

      parentTableMap = readConversationParentsMap(db);
    });
  } catch {
    // 忽略读取异常
  }
  const snapshot = { hasSummaryDb: true, summaryMap, parentTableMap, sideQuestionParentMap };
  if (walSig.exists && walSig.sig) {
    lruSet(summarySnapshotMemo, cacheKey, { sig: walSig.sig, snapshot }, MAX_SUMMARY_SNAPSHOT_CACHE);
  }
  return snapshot;
}

function readClientMetadataCache(clientRoot) {
  const map = new Map();
  const check = resolveNoFollowFile(clientRoot, ['cache', 'conversation_metadata.json']);
  if (!check.ok || !check.exists) return map;
  try {
    const parsed = JSON.parse(readFileSync(check.path, 'utf8'));
    const convs = parsed?.conversations;
    if (convs && typeof convs === 'object') {
      for (const [rawId, val] of Object.entries(convs)) {
        const cid = normalizeSessionUuid(rawId);
        if (!cid || !val || typeof val !== 'object') continue;
        const sum = val.summary && typeof val.summary === 'object' ? val.summary : val;
        map.set(cid, {
          title: String(sum.Title || sum.title || '').trim(),
          preview: String(sum.Preview || sum.preview || '').trim(),
          workspaceUris: Array.isArray(sum.WorkspaceURIs)
            ? sum.WorkspaceURIs
            : parseWorkspaceUrisColumn(sum.workspace_uris || ''),
          updatedAtMs:
            parseIsoMs(sum.UpdatedAt || sum.updated_at || normalizeSqliteIsoTime(sum.last_modified_time)) || 0,
        });
      }
    }
  } catch {
    // ignore corrupt cache json
  }
  return map;
}

function buildLedgerTelemetryLookup(cacheStore, warnings = null) {
  const map = new Map();
  if (!cacheStore || typeof cacheStore.listCachedTrajectoryEntries !== 'function') {
    return map;
  }
  let entries = [];
  try {
    entries = cacheStore.listCachedTrajectoryEntries();
  } catch (err) {
    if (Array.isArray(warnings)) {
      warnings.push(`ledger_telemetry_unavailable: ${err?.message || 'read_failed'}`);
    }
    return map;
  }
  let resolveStepModel = null;
  try {
    resolveStepModel = createStepModelResolver();
  } catch {
    resolveStepModel = null;
  }

  for (const [rawId, entry] of entries) {
    const cid = normalizeSessionUuid(rawId);
    if (!cid || !entry || typeof entry !== 'object') continue;
    const steps = Array.isArray(entry.steps) ? entry.steps : [];
    const archived = Boolean(entry.archived);
    let summary = null;
    const cached = ledgerEntrySummaryMemo.get(entry);
    if (
      cached &&
      cached.stepsRef === steps &&
      cached.stepCount === steps.length &&
      cached.archived === archived
    ) {
      summary = cached.summary;
    } else {
      let totalTokens = 0;
      let costUsd = 0;
      for (const st of steps) {
        if (!st || typeof st !== 'object') continue;
        const inTok = Math.max(0, Number(st.inputTokens || 0));
        const cacheTok = Math.max(0, Number(st.cacheReadTokens || 0));
        const outTok = Math.max(0, Number(st.outputTokens || 0));
        totalTokens += inTok + cacheTok + outTok;
        if (resolveStepModel) {
          try {
            const mInfo = resolveStepModel(st);
            const c = computeStepCost(st, mInfo?.pricing);
            if (Number.isFinite(c) && c > 0) costUsd += c;
          } catch {
            // ignore
          }
        }
      }
      summary = {
        recorded: true,
        stepCount: steps.length,
        totalTokens,
        costUsd: +costUsd.toFixed(4),
        archived,
        hasUsage: steps.length > 0 || totalTokens > 0,
      };
      ledgerEntrySummaryMemo.set(entry, {
        stepsRef: steps,
        stepCount: steps.length,
        archived,
        summary,
      });
    }
    const prev = map.get(cid);
    if (!prev || summary.stepCount > prev.stepCount) {
      map.set(cid, summary);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// 四路扫描 + 账本遥测融合
// ---------------------------------------------------------------------------

function scanSingleClientSessions(
  def,
  {
    geminiDir,
    rawGeminiOverride,
    backupDir,
    runningClients,
    onlineDeleteClients,
    telemetryLookup,
    options,
    warnings,
  }
) {
  const clientRoot = join(geminiDir, def.dirName);
  const rootExists = existsSync(clientRoot);
  const isClientRunning = Boolean(runningClients[def.id]);
  const onlineDeleteSupported = Boolean(isClientRunning && onlineDeleteClients?.[def.id]);

  // 仅在进程枚举可信且该客户端未运行时尝试崩溃恢复
  if (rootExists && !options.skipRecovery && runningClients.checked && !isClientRunning) {
    const rec = recoverPendingCleanups(clientRoot, def, {
      geminiDir: rawGeminiOverride || geminiDir,
      backupDir,
      electronAppDataDir: options.electronAppDataDir,
      runningClients,
    });
    warnings.push(...rec.warnings);
  }

  if (!rootExists) {
    return {
      clientInfo: {
        id: def.id,
        dirName: def.dirName,
        rootPath: clientRoot,
        exists: false,
        running: isClientRunning,
        onlineDeleteSupported,
        sessionCount: 0,
        indexOnlyCount: 0,
        totalSizeBytes: 0,
      },
      sessions: [],
      migrationInfo: {
        clientInfo: {
          id: def.id,
          dirName: def.dirName,
          rootPath: clientRoot,
          exists: false,
          hasSummaryDb: false,
          canBeSource: false,
          canBeTarget: false,
          sessionCount: 0,
        },
        sessions: [],
        desktopProjects: def.id === 'desktop' ? extractDesktopProjectsFromSummaryMap(new Map()) : null,
      },
    };
  }

  const { hasSummaryDb, summaryMap, parentTableMap, sideQuestionParentMap } =
    readClientSummarySnapshot(clientRoot, def.appDataDir);
  const metadataCacheMap = readClientMetadataCache(clientRoot);
  const protectedArchives = findProtectedMigrationArchives({
    backupDir,
    geminiDir: rawGeminiOverride,
    clientId: def.id,
    clientRoot,
  });

  // 读取 .pb 摘要索引 UUID
  const protoIds = new Set();
  if (def.summaryProtoFile) {
    const pfCheck = resolveNoFollowFile(clientRoot, [def.summaryProtoFile]);
    if (pfCheck.ok && pfCheck.exists) {
      try {
        const parsed = parseSummaryProtoIndexIds(readFileSync(pfCheck.path), {
          isDesktop: Boolean(def.isDesktopProto),
          strict: false,
        });
        for (const id of parsed) protoIds.add(id);
      } catch {
        // ignore
      }
    }
  }

  // 扫描实体产物目录（仅对目录祖先做一次 no-follow 校验，热循环内仅校验单段子项）
  const dbFileSet = new Set();
  const pbFileSet = new Set();
  const walFileSet = new Set();
  const shmFileSet = new Set();
  const convCheck = resolveNoFollowPath(clientRoot, ['conversations']);
  const verifiedConvDir =
    convCheck.ok && convCheck.exists && convCheck.stat?.isDirectory() ? convCheck.path : '';
  if (verifiedConvDir) {
    try {
      for (const name of readdirSync(verifiedConvDir)) {
        const lower = name.toLowerCase();
        if (lower.endsWith('.db')) {
          const id = normalizeSessionUuid(lower.slice(0, -3));
          if (id) dbFileSet.add(id);
        } else if (lower.endsWith('.pb')) {
          const id = normalizeSessionUuid(lower.slice(0, -3));
          if (id) pbFileSet.add(id);
        } else if (lower.endsWith('.db-wal')) {
          walFileSet.add(lower);
        } else if (lower.endsWith('.db-shm')) {
          shmFileSet.add(lower);
        }
      }
    } catch {
      // ignore
    }
  }

  const brainSet = new Set();
  const brainCheck = resolveNoFollowPath(clientRoot, ['brain']);
  const verifiedBrainDir =
    brainCheck.ok && brainCheck.exists && brainCheck.stat?.isDirectory() ? brainCheck.path : '';
  if (verifiedBrainDir) {
    try {
      for (const name of readdirSync(verifiedBrainDir)) {
        const id = normalizeSessionUuid(name);
        if (id) brainSet.add(id);
      }
    } catch {
      // ignore
    }
  }

  const annSet = new Set();
  const annCheck = resolveNoFollowPath(clientRoot, ['annotations']);
  const verifiedAnnDir =
    annCheck.ok && annCheck.exists && annCheck.stat?.isDirectory() ? annCheck.path : '';
  if (verifiedAnnDir) {
    try {
      for (const name of readdirSync(verifiedAnnDir)) {
        const lower = name.toLowerCase();
        if (lower.endsWith('.pbtxt')) {
          const id = normalizeSessionUuid(lower.slice(0, -6));
          if (id) annSet.add(id);
        }
      }
    } catch {
      // ignore
    }
  }

  // 合并四路全部候选 ID
  const candidateIds = new Set([
    ...summaryMap.keys(),
    ...metadataCacheMap.keys(),
    ...protoIds,
    ...dbFileSet,
    ...pbFileSet,
    ...brainSet,
    ...annSet,
  ]);

  const rawRecords = new Map();
  const prelimCandidates = [];
  let coldTitleInspectCount = 0;
  let coldMetaInspectCount = 0;
  const MAX_COLD_META_INSPECTS_PER_CLIENT = 2500;

  for (const cid of candidateIds) {
    const summary = summaryMap.get(cid) || null;
    const metaCache = metadataCacheMap.get(cid) || null;
    const hasDb = dbFileSet.has(cid);
    const hasPb = pbFileSet.has(cid);
    const hasBrain = brainSet.has(cid);
    const hasAnn = annSet.has(cid);
    const hasIndex = Boolean(summary || metaCache || protoIds.has(cid));
    const protection = protectedArchives.get(cid) || null;

    // 仅剩跨端迁移归档保护 brain/<cid> 媒体目录、本地已无任何会话文件或索引时，属于已迁出静态附件池而非会话
    if (!hasDb && !hasPb && !hasAnn && !hasIndex && protection) {
      continue;
    }

    const indexOnly = hasIndex && !hasDb && !hasPb && !hasBrain && !hasAnn;

    // 精确统计磁盘体积与文件修改时间（涵盖 .db / .db-wal / .db-shm / .pb / brain/<cid> / annotations）
    let sizeBytes = 0;
    let dbSizeBytes = 0;
    let brainSizeBytes = 0;
    let fileMtimeMs = 0;
    let hasNonEmptyWal = false;
    let primaryFilePath = '';
    let dbStat = null;
    let walStat = null;
    let dbFilesSig = '';

    if (hasDb && verifiedConvDir) {
      const dbCheck = lstatVerifiedChild(verifiedConvDir, `${cid}.db`, { expectFile: true });
      if (dbCheck.ok && dbCheck.exists && dbCheck.stat) {
        dbStat = dbCheck.stat;
        primaryFilePath = dbCheck.path;
        const dbBytes = Number(dbCheck.stat.size || 0);
        sizeBytes += dbBytes;
        dbSizeBytes += dbBytes;
        fileMtimeMs = Math.max(fileMtimeMs, Number(dbCheck.stat.mtimeMs || 0));
        let walSigPart = '0';
        let shmSigPart = '0';
        if (walFileSet.has(`${cid}.db-wal`)) {
          const walCheck = lstatVerifiedChild(verifiedConvDir, `${cid}.db-wal`, { expectFile: true });
          if (walCheck.ok && walCheck.exists && walCheck.stat) {
            walStat = walCheck.stat;
            const ws = Number(walCheck.stat.size || 0);
            sizeBytes += ws;
            dbSizeBytes += ws;
            walSigPart = `${Math.trunc(walCheck.stat.mtimeMs)}:${ws}`;
            if (ws > 0) {
              hasNonEmptyWal = true;
              fileMtimeMs = Math.max(fileMtimeMs, Number(walCheck.stat.mtimeMs || 0));
            }
          }
        }
        if (shmFileSet.has(`${cid}.db-shm`)) {
          const shmCheck = lstatVerifiedChild(verifiedConvDir, `${cid}.db-shm`, { expectFile: true });
          if (shmCheck.ok && shmCheck.exists && shmCheck.stat) {
            const ss = Number(shmCheck.stat.size || 0);
            sizeBytes += ss;
            dbSizeBytes += ss;
            shmSigPart = `${Math.trunc(shmCheck.stat.mtimeMs)}:${ss}`;
          }
        }
        dbFilesSig = `${Math.trunc(dbCheck.stat.mtimeMs)}:${dbBytes}:${walSigPart}:${shmSigPart}`;
      }
    }
    if (hasPb && verifiedConvDir) {
      const pbCheck = lstatVerifiedChild(verifiedConvDir, `${cid}.pb`, { expectFile: true });
      if (pbCheck.ok && pbCheck.exists && pbCheck.stat) {
        if (!primaryFilePath) primaryFilePath = pbCheck.path;
        sizeBytes += Number(pbCheck.stat.size || 0);
        fileMtimeMs = Math.max(fileMtimeMs, Number(pbCheck.stat.mtimeMs || 0));
      }
    }

    let brainPath = '';
    let brainInfo = null;
    if (hasBrain && verifiedBrainDir) {
      const brCheck = lstatVerifiedChild(verifiedBrainDir, cid, { expectDir: true });
      if (brCheck.ok && brCheck.exists && brCheck.stat) {
        brainPath = brCheck.path;
        brainInfo = inspectBrainDirInfo(brCheck.path, brCheck.stat, dbFilesSig);
        brainSizeBytes = Number(brainInfo.sizeBytes || 0);
        sizeBytes += brainSizeBytes;
        if (!primaryFilePath) primaryFilePath = brCheck.path;
        fileMtimeMs = Math.max(fileMtimeMs, Number(brCheck.stat.mtimeMs || 0));
      }
    }

    let annTitle = '';
    if (hasAnn && verifiedAnnDir) {
      const annFile = lstatVerifiedChild(verifiedAnnDir, `${cid}.pbtxt`, { expectFile: true });
      if (annFile.ok && annFile.exists && annFile.stat) {
        sizeBytes += Number(annFile.stat.size || 0);
        if (!primaryFilePath) primaryFilePath = annFile.path;
        annTitle = readAnnotationTitleCached(annFile.path, annFile.stat);
      }
    }

    const summaryLastModMs = summary
      ? parseIsoMs(normalizeSqliteIsoTime(summary.last_modified_time)) || 0
      : 0;
    const cacheUpdatedMs = metaCache?.updatedAtMs || 0;
    const effectiveLastModMs =
      summaryLastModMs > 0
        ? hasNonEmptyWal
          ? Math.max(summaryLastModMs, fileMtimeMs)
          : summaryLastModMs
        : Math.max(cacheUpdatedMs, fileMtimeMs);

    prelimCandidates.push({
      cid,
      summary,
      metaCache,
      hasDb,
      hasPb,
      hasBrain,
      hasAnn,
      hasIndex,
      indexOnly,
      protection,
      sizeBytes,
      dbSizeBytes,
      brainSizeBytes,
      primaryFilePath,
      brainPath,
      brainInfo,
      dbStat,
      walStat,
      annTitle,
      effectiveLastModMs,
    });
  }

  // 按有效修改时间降序分配 .db 冷启动探测配额，确保最新会话始终优先解析标题与工作区
  prelimCandidates.sort((a, b) => (b.effectiveLastModMs || 0) - (a.effectiveLastModMs || 0));

  const sqliteSupported = hasBuiltinNodeSqlite();
  const migrationSessions = [];
  const MIGRATION_MAX_SESSIONS = 5000;

  for (const item of prelimCandidates) {
    const {
      cid,
      summary,
      metaCache,
      hasDb,
      hasPb,
      hasBrain,
      hasAnn,
      hasIndex,
      indexOnly,
      protection,
      sizeBytes,
      dbSizeBytes,
      brainSizeBytes,
      primaryFilePath,
      brainInfo,
      dbStat,
      walStat,
      annTitle,
      effectiveLastModMs,
    } = item;

    const sumTitle = String(summary?.title || '').trim();
    const sumPreview = String(summary?.preview || '').trim();
    const cacheTitle = String(metaCache?.title || '').trim();
    const cachePreview = String(metaCache?.preview || '').trim();
    const missingAllTitles = !annTitle && !sumTitle && !cacheTitle && !sumPreview && !cachePreview;

    let dbLight = null;
    if (hasDb && hasBuiltinNodeSqlite() && (!summary || missingAllTitles)) {
      const allowPromptProbe = missingAllTitles && coldTitleInspectCount < MAX_COLD_DB_INSPECTS_PER_CLIENT;
      const allowMetaProbe = !summary && coldMetaInspectCount < MAX_COLD_META_INSPECTS_PER_CLIENT;
      if (allowPromptProbe || allowMetaProbe) {
        if (allowPromptProbe) coldTitleInspectCount += 1;
        if (!summary) coldMetaInspectCount += 1;
        dbLight = inspectConversationDbLight(join(verifiedConvDir || join(clientRoot, 'conversations'), `${cid}.db`), {
          needPromptTitle: allowPromptProbe,
          dbStat,
          walStat,
        });
      }
    }

    // 过滤无索引、无 brain 且 steps 与 gen_metadata 均为空的空壳 .db
    if (
      hasDb &&
      !hasIndex &&
      !hasBrain &&
      !hasAnn &&
      dbLight &&
      dbLight.stepCount === 0 &&
      dbLight.genCount === 0
    ) {
      continue;
    }

    let transcriptTitle = '';
    if (missingAllTitles && brainInfo?.hasTranscript && brainInfo.transcriptPath) {
      transcriptTitle = extractFirstUserTitleFromTranscriptFile(
        brainInfo.transcriptPath,
        brainInfo.transcriptStat
      );
    }

    const title =
      annTitle ||
      sumTitle ||
      cacheTitle ||
      sumPreview ||
      cachePreview ||
      transcriptTitle ||
      String(dbLight?.firstPromptTitle || '').trim() ||
      cid.slice(0, 8);

    const uris = summary
      ? parseWorkspaceUrisColumn(summary.workspace_uris)
      : metaCache?.workspaceUris || [];
    const workspaceUri = uris[0] || String(dbLight?.workspaceUri || '').trim();
    const { name: workspaceName, displayPath: workspacePath } = parseWorkspaceDisplayLabel(workspaceUri);
    const projectDir = resolveLocalWorkspaceProjectDir(workspaceUri);
    if (projectDir) rememberAuthorizedProjectDir(projectDir);

    const sumRel = summary?._relations || (summary ? decodeSummaryRelationsLight(summary) : null);
    const nestingDepth = Math.max(
      Number(sumRel?.nestingDepth ?? summary?.nesting_depth ?? 0),
      Number(dbLight?.nestingDepth || 0)
    );
    const isSubagent = Boolean(sumRel?.isSubagent) || isDbLightSubagent(dbLight);
    const directParentId =
      sumRel?.parentConversationId ||
      normalizeSessionUuid(parentTableMap.get(cid)) ||
      (isSubagent ? normalizeSessionUuid(sideQuestionParentMap.get(cid)) : '') ||
      normalizeSessionUuid(dbLight?.parentConversationId) ||
      '';
    const fallbackRootId =
      isSubagent && !directParentId
        ? normalizeSessionUuid(sumRel?.rootConversationId || dbLight?.rootConversationId)
        : '';
    const parentConversationId =
      directParentId || (fallbackRootId && fallbackRootId !== cid ? fallbackRootId : '');
    const isFork = isForkSession({ parentConversationId, nestingDepth, isSubagent });

    const rawStatus = String(summary?.status || '').trim();
    const killed = Boolean(Number(summary?.killed || 0));
    const notFullyIdle = Boolean(Number(summary?.not_fully_idle || 0));
    const sessionRunning =
      !killed &&
      (rawStatus === 'CASCADE_RUN_STATUS_RUNNING' ||
        (notFullyIdle && rawStatus !== 'CASCADE_RUN_STATUS_IDLE'));

    const hasTranscript = Boolean(brainInfo?.hasTranscript);

    const ledgerTelemetry = telemetryLookup.get(cid) || null;

    const deleteCap = evaluateSessionDeleteCapability({
      runningClients,
      onlineDeleteClients,
      clientId: def.id,
      sessionRunning,
      indexOnly,
    });

    const dbStepCount = summary
      ? Math.max(0, Number(summary.step_count || 0))
      : Math.max(0, Number(dbLight?.stepCount || 0));
    const projectId = String(summary?.project_id || dbLight?.projectId || '').trim();
    if (
      sqliteSupported &&
      hasDb &&
      !isSubagent &&
      dbStepCount > 0 &&
      migrationSessions.length < MIGRATION_MAX_SESSIONS
    ) {
      migrationSessions.push({
        cascadeId: cid,
        clientId: def.id,
        title,
        stepCount: dbStepCount,
        lastModifiedMs: effectiveLastModMs,
        workspaceUri,
        workspaceName,
        workspacePath,
        projectId,
        sizeBytes,
        dbSizeBytes,
        hasBrain,
        isRunning: sessionRunning,
      });
    }

    rawRecords.set(cid, {
      sessionId: cid,
      cascadeId: cid,
      clientId: def.id,
      title,
      preview: sumPreview || cachePreview || '',
      workspaceUri,
      workspaceName,
      workspacePath,
      projectDir,
      sizeBytes,
      dbSizeBytes,
      brainSizeBytes,
      subagentSizeBytes: 0,
      lastModifiedMs: effectiveLastModMs,
      stepCount: Math.max(
        0,
        Number(summary?.step_count ?? dbLight?.stepCount ?? ledgerTelemetry?.stepCount ?? 0)
      ),
      indexOnly,
      hasDb,
      hasPb,
      hasBrain,
      hasTranscript,
      canReadMessages: Boolean(hasTranscript || hasDb),
      isSubagent,
      isFork,
      parentConversationId,
      nestingDepth,
      subagentCount: 0,
      sessionRunning,
      clientRunning: isClientRunning,
      canDelete: deleteCap.canDelete,
      deleteMode: deleteCap.deleteMode,
      deleteBlockedReason: deleteCap.deleteBlockedReason,
      protectedByMigration: Boolean(protection),
      primaryFilePath,
      telemetry: ledgerTelemetry || {
        recorded: false,
        stepCount: 0,
        totalTokens: 0,
        costUsd: 0,
        archived: false,
        hasUsage: false,
      },
    });
  }

  // 将同源有效父会话下的嵌套子代理（含多级嵌套）隐藏并累加父会话的 subagentCount 与占用存储体积（/fork 保持独立可见）
  const hiddenSubagents = new Set();
  for (const [cid, rec] of rawRecords.entries()) {
    if (!rec.isSubagent || !rec.parentConversationId) continue;
    const directParentExists = rawRecords.has(rec.parentConversationId);
    let cursor = rec.parentConversationId;
    let hops = 0;
    let rootParent = null;
    const seen = new Set([cid]);
    while (cursor && hops < 8 && !seen.has(cursor)) {
      seen.add(cursor);
      const anc = rawRecords.get(cursor);
      if (!anc) break;
      if (!anc.isSubagent) {
        rootParent = anc;
        break;
      }
      cursor = anc.parentConversationId;
      hops += 1;
    }
    if (rootParent) {
      const subBytes = Number(rec.sizeBytes || 0);
      rootParent.subagentCount += 1;
      rootParent.sizeBytes += subBytes;
      rootParent.dbSizeBytes += Number(rec.dbSizeBytes || 0);
      rootParent.brainSizeBytes += Number(rec.brainSizeBytes || 0);
      rootParent.subagentSizeBytes += subBytes;
      hiddenSubagents.add(cid);
    } else if (directParentExists) {
      hiddenSubagents.add(cid);
    }
  }

  for (const migItem of migrationSessions) {
    const rec = rawRecords.get(migItem.cascadeId);
    if (rec) {
      migItem.sizeBytes = Number(rec.sizeBytes || 0);
    }
  }

  let visibleCount = 0;
  let indexOnlyCount = 0;
  let totalSizeBytes = 0;
  const clientSessions = [];
  for (const [cid, rec] of rawRecords.entries()) {
    if (hiddenSubagents.has(cid)) continue;
    visibleCount += 1;
    if (rec.indexOnly) indexOnlyCount += 1;
    totalSizeBytes += Number(rec.sizeBytes || 0);
    clientSessions.push(rec);
  }

  const convExists = Boolean(verifiedConvDir);
  const migHasUsableData = convExists && (hasSummaryDb || migrationSessions.length > 0);
  const migCanBeTarget = Boolean(def.allowTarget && rootExists && convExists && hasSummaryDb);
  const migCanBeSource = Boolean(convExists && migrationSessions.length > 0);

  return {
    clientInfo: {
      id: def.id,
      dirName: def.dirName,
      rootPath: clientRoot,
      exists: true,
      running: isClientRunning,
      onlineDeleteSupported,
      sessionCount: visibleCount,
      indexOnlyCount,
      totalSizeBytes,
    },
    sessions: clientSessions,
    migrationInfo: {
      clientInfo: {
        id: def.id,
        dirName: def.dirName,
        rootPath: clientRoot,
        exists: migHasUsableData,
        hasSummaryDb,
        canBeSource: migCanBeSource,
        canBeTarget: migCanBeTarget,
        sessionCount: migrationSessions.length,
      },
      sessions: migrationSessions,
      desktopProjects: def.id === 'desktop' ? extractDesktopProjectsFromSummaryMap(summaryMap) : null,
    },
  };
}

function finalizeLocalSessionsScan(
  clients,
  allSessions,
  runningClients,
  onlineDeleteClients,
  warnings,
  migrationParts = []
) {
  allSessions.sort((a, b) => (b.lastModifiedMs || 0) - (a.lastModifiedMs || 0));
  const byClientSizeBytes = {
    desktop: clients.find((c) => c.id === 'desktop')?.totalSizeBytes || 0,
    cli: clients.find((c) => c.id === 'cli')?.totalSizeBytes || 0,
    ide_legacy: clients.find((c) => c.id === 'ide_legacy')?.totalSizeBytes || 0,
  };
  const totalSizeBytes = allSessions.reduce((sum, s) => sum + Number(s.sizeBytes || 0), 0);
  const counts = {
    total: allSessions.length,
    indexOnly: allSessions.filter((s) => s.indexOnly).length,
    totalSizeBytes,
    byClient: {
      desktop: clients.find((c) => c.id === 'desktop')?.sessionCount || 0,
      cli: clients.find((c) => c.id === 'cli')?.sessionCount || 0,
      ide_legacy: clients.find((c) => c.id === 'ide_legacy')?.sessionCount || 0,
    },
    byClientSizeBytes,
  };

  const sqliteSupported = hasBuiltinNodeSqlite();
  const migClients = [];
  const migSessionsByClient = {};
  let desktopProjects = [];
  for (const part of migrationParts) {
    if (!part?.clientInfo) continue;
    migClients.push(part.clientInfo);
    migSessionsByClient[part.clientInfo.id] = Array.isArray(part.sessions) ? part.sessions : [];
    if (part.clientInfo.id === 'desktop' && Array.isArray(part.desktopProjects)) {
      desktopProjects = part.desktopProjects;
    }
  }
  const detectedMigClients = migClients.filter((c) => c.exists);
  const hasAnyMigTarget = detectedMigClients.some((c) => c.canBeTarget);
  const migrationCatalog = {
    available: Boolean(sqliteSupported && detectedMigClients.length >= 2 && hasAnyMigTarget),
    sqliteSupported,
    clients: migClients,
    sessionsByClient: migSessionsByClient,
    desktopProjects,
  };

  return {
    ok: true,
    clients,
    runningClients,
    onlineDeleteClients: onlineDeleteClients || { desktop: false, cli: false, ide_legacy: false },
    sessions: allSessions,
    counts,
    migrationCatalog,
    warnings,
  };
}

/**
 * 扫描本机全部三个 Antigravity 客户端（Desktop / CLI / 旧版 IDE）会话，合并四路候选并融合本插件遥测账本。
 */
export function scanLocalSessions(options = {}) {
  const rawGeminiOverride = String(options.geminiDir || '').trim();
  const geminiDir = resolveGeminiDir(options.geminiDir);
  const backupDir = resolveMigrationBackupRoot(options.backupDir, rawGeminiOverride);
  const runningClients = detectRunningClients(options);
  const onlineDeleteClients = resolveSyncOnlineDeleteClients(runningClients, options);
  const warnings = [];
  if (!runningClients.checked) {
    warnings.push(`process_detection_unavailable: ${runningClients.error || 'unknown'}`);
  }
  const telemetryLookup = buildLedgerTelemetryLookup(
    resolveScopedTrajectoryCacheStore(options, getLocalTrajectoryCacheStore),
    warnings
  );
  const clients = [];
  const allSessions = [];
  const migrationParts = [];
  const ctx = {
    geminiDir,
    rawGeminiOverride,
    backupDir,
    runningClients,
    onlineDeleteClients,
    telemetryLookup,
    options,
    warnings,
  };
  for (const def of SESSION_CLIENT_DEFS) {
    const out = scanSingleClientSessions(def, ctx);
    clients.push(out.clientInfo);
    if (out.migrationInfo) migrationParts.push(out.migrationInfo);
    for (const s of out.sessions) allSessions.push(s);
  }
  return finalizeLocalSessionsScan(
    clients,
    allSessions,
    runningClients,
    onlineDeleteClients,
    warnings,
    migrationParts
  );
}

const yieldMacrotask = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 异步非阻塞版三端扫描（专供 Worker HTTP API 使用）：异步探测运行态进程与在线删除端点，
 * 并在各客户端间让出事件循环，避免同步进程枚举或大规模本地扫描阻塞 `/api/telemetry` 与 RPC 心跳。
 */
export async function scanLocalSessionsAsync(options = {}) {
  const rawGeminiOverride = String(options.geminiDir || '').trim();
  const geminiDir = resolveGeminiDir(options.geminiDir);
  const backupDir = resolveMigrationBackupRoot(options.backupDir, rawGeminiOverride);
  // 与账本加载并行发起异步进程探测，隐藏 Windows WMI/tasklist 子进程等待时间
  const runningClientsPromise = detectRunningClientsAsync(options);
  const warnings = [];
  await yieldMacrotask();
  const telemetryLookup = buildLedgerTelemetryLookup(
    resolveScopedTrajectoryCacheStore(options, getLocalTrajectoryCacheStore),
    warnings
  );
  const runningClients = await runningClientsPromise;
  if (!runningClients.checked) {
    warnings.push(`process_detection_unavailable: ${runningClients.error || 'unknown'}`);
  }
  const onlineDeleteClients = await detectOnlineDeleteClientsAsync(runningClients, options);
  const clients = [];
  const allSessions = [];
  const migrationParts = [];
  const ctx = {
    geminiDir,
    rawGeminiOverride,
    backupDir,
    runningClients,
    onlineDeleteClients,
    telemetryLookup,
    options,
    warnings,
  };
  for (const def of SESSION_CLIENT_DEFS) {
    await yieldMacrotask();
    const out = scanSingleClientSessions(def, ctx);
    clients.push(out.clientInfo);
    if (out.migrationInfo) migrationParts.push(out.migrationInfo);
    for (const s of out.sessions) allSessions.push(s);
  }
  return finalizeLocalSessionsScan(
    clients,
    allSessions,
    runningClients,
    onlineDeleteClients,
    warnings,
    migrationParts
  );
}

/**
 * 在 Sidecar 重启或消息缓存 LRU 淘汰后，按需为单个指定本地会话重新采集授权的项目目录与消息内 `file://` 路径白名单。
 *
 * @param {{ clientId: string, sessionId: string }} params
 * @param {{ geminiDir?: string }} [options={}]
 * @returns {Set<string>}
 */
export function authorizeSessionPathsForReveal({ clientId, sessionId } = {}, options = {}) {
  const def = getSessionClientDef(clientId);
  const cid = normalizeSessionUuid(sessionId);
  if (!def || !cid) return getAuthorizedRevealSnapshot();

  const geminiDir = resolveGeminiDir(options.geminiDir);
  const clientRoot = join(geminiDir, def.dirName);
  if (!existsSync(clientRoot)) return getAuthorizedRevealSnapshot();

  let workspaceUri = '';
  const sumCheck = resolveNoFollowFile(clientRoot, ['conversation_summaries.db']);
  if (sumCheck.ok && sumCheck.exists && hasBuiltinNodeSqlite()) {
    try {
      withReadOnlySqliteDb(sumCheck.path, (db) => {
        const row = db
          .prepare('SELECT workspace_uris FROM conversation_summaries WHERE conversation_id = ? LIMIT 1')
          .get(cid);
        const uris = parseWorkspaceUrisColumn(row?.workspace_uris);
        if (uris.length > 0) workspaceUri = uris[0];
      });
    } catch {
      // ignore
    }
  }
  if (!workspaceUri) {
    const metaCache = readClientMetadataCache(clientRoot).get(cid);
    if (metaCache?.workspaceUris?.length) {
      workspaceUri = metaCache.workspaceUris[0];
    }
  }
  if (!workspaceUri) {
    const dbCheck = resolveNoFollowFile(clientRoot, ['conversations', `${cid}.db`]);
    if (dbCheck.ok && dbCheck.exists && hasBuiltinNodeSqlite()) {
      const dbLight = inspectConversationDbLight(dbCheck.path, { needPromptTitle: false });
      if (dbLight?.workspaceUri) workspaceUri = dbLight.workspaceUri;
    }
  }
  const projectDir = resolveLocalWorkspaceProjectDir(workspaceUri);
  if (projectDir) rememberAuthorizedProjectDir(projectDir);

  return getAuthorizedRevealSnapshot();
}

// ---------------------------------------------------------------------------
// 清理影响面预览、双通道删除编排与账本补扫
// ---------------------------------------------------------------------------

const MAX_LIVE_PREVIEW_PROBES = 10;

function parseNormalizedTargetsByClient(targets) {
  const byClient = new Map();
  const dedupSeen = new Set();
  for (const item of Array.isArray(targets) ? targets : []) {
    const def = getSessionClientDef(item?.clientId);
    const cid = normalizeSessionUuid(item?.sessionId);
    if (!def || !cid) continue;
    const key = `${def.id}:${cid}`;
    if (dedupSeen.has(key)) continue;
    dedupSeen.add(key);
    if (!byClient.has(def.id)) byClient.set(def.id, []);
    byClient.get(def.id).push(cid);
  }
  return { byClient, dedupSeen };
}

function isSummaryRowRunning(summary) {
  if (!summary) return false;
  const rawStatus = String(summary.status || '').trim();
  const killed = Boolean(Number(summary.killed || 0));
  const notFullyIdle = Boolean(Number(summary.not_fully_idle || 0));
  return (
    !killed &&
    (rawStatus === 'CASCADE_RUN_STATUS_RUNNING' ||
      (notFullyIdle && rawStatus !== 'CASCADE_RUN_STATUS_IDLE'))
  );
}

/**
 * 针对指定目标 ID 轻量读取本地运行态与实体产物存在性（O(k)，无需扫描整个目录），
 * 用于在线删除预览与执行阶段的 `sessionRunning` / `indexOnly` 守卫。
 */
function inspectTargetSessionsForOnlineGuards(def, clientRoot, idList) {
  const map = new Map();
  if (!existsSync(clientRoot) || !Array.isArray(idList) || idList.length === 0) {
    return map;
  }
  const { summaryMap } = readClientSummarySnapshot(clientRoot, def.appDataDir);
  const convCheck = resolveNoFollowPath(clientRoot, ['conversations']);
  const verifiedConvDir =
    convCheck.ok && convCheck.exists && convCheck.stat?.isDirectory() ? convCheck.path : '';
  const brainCheck = resolveNoFollowPath(clientRoot, ['brain']);
  const verifiedBrainDir =
    brainCheck.ok && brainCheck.exists && brainCheck.stat?.isDirectory() ? brainCheck.path : '';
  const annCheck = resolveNoFollowPath(clientRoot, ['annotations']);
  const verifiedAnnDir =
    annCheck.ok && annCheck.exists && annCheck.stat?.isDirectory() ? annCheck.path : '';

  for (const cid of idList) {
    const summary = summaryMap.get(cid) || null;
    const hasDb = Boolean(
      verifiedConvDir && lstatVerifiedChild(verifiedConvDir, `${cid}.db`, { expectFile: true }).exists
    );
    const hasPb = Boolean(
      verifiedConvDir && lstatVerifiedChild(verifiedConvDir, `${cid}.pb`, { expectFile: true }).exists
    );
    const hasBrain = Boolean(
      verifiedBrainDir && lstatVerifiedChild(verifiedBrainDir, cid, { expectDir: true }).exists
    );
    const hasAnn = Boolean(
      verifiedAnnDir && lstatVerifiedChild(verifiedAnnDir, `${cid}.pbtxt`, { expectFile: true }).exists
    );
    const indexOnly = !hasDb && !hasPb && !hasBrain && !hasAnn;
    map.set(cid, {
      sessionRunning: isSummaryRowRunning(summary),
      indexOnly,
    });
  }
  return map;
}

function computeClientTargetsDiskSizeBytes(clientRoot, idIterable) {
  const uniqueIds = Array.from(new Set(idIterable || [])).filter(Boolean);
  if (uniqueIds.length === 0 || !existsSync(clientRoot)) return 0;

  const convCheck = resolveNoFollowPath(clientRoot, ['conversations']);
  const verifiedConvDir =
    convCheck.ok && convCheck.exists && convCheck.stat?.isDirectory() ? convCheck.path : '';
  const brainCheck = resolveNoFollowPath(clientRoot, ['brain']);
  const verifiedBrainDir =
    brainCheck.ok && brainCheck.exists && brainCheck.stat?.isDirectory() ? brainCheck.path : '';
  const annCheck = resolveNoFollowPath(clientRoot, ['annotations']);
  const verifiedAnnDir =
    annCheck.ok && annCheck.exists && annCheck.stat?.isDirectory() ? annCheck.path : '';

  let total = 0;
  for (const cid of uniqueIds) {
    let dbFilesSig = '';
    if (verifiedConvDir) {
      const dbCheck = lstatVerifiedChild(verifiedConvDir, `${cid}.db`, { expectFile: true });
      if (dbCheck.ok && dbCheck.exists && dbCheck.stat) {
        const dbBytes = Number(dbCheck.stat.size || 0);
        total += dbBytes;
        let walSigPart = '0';
        let shmSigPart = '0';
        const walCheck = lstatVerifiedChild(verifiedConvDir, `${cid}.db-wal`, { expectFile: true });
        if (walCheck.ok && walCheck.exists && walCheck.stat) {
          const ws = Number(walCheck.stat.size || 0);
          total += ws;
          walSigPart = `${Math.trunc(walCheck.stat.mtimeMs)}:${ws}`;
        }
        const shmCheck = lstatVerifiedChild(verifiedConvDir, `${cid}.db-shm`, { expectFile: true });
        if (shmCheck.ok && shmCheck.exists && shmCheck.stat) {
          const ss = Number(shmCheck.stat.size || 0);
          total += ss;
          shmSigPart = `${Math.trunc(shmCheck.stat.mtimeMs)}:${ss}`;
        }
        dbFilesSig = `${Math.trunc(dbCheck.stat.mtimeMs)}:${dbBytes}:${walSigPart}:${shmSigPart}`;
      }
      const pbCheck = lstatVerifiedChild(verifiedConvDir, `${cid}.pb`, { expectFile: true });
      if (pbCheck.ok && pbCheck.exists && pbCheck.stat) {
        total += Number(pbCheck.stat.size || 0);
      }
    }
    if (verifiedBrainDir) {
      const brCheck = lstatVerifiedChild(verifiedBrainDir, cid, { expectDir: true });
      if (brCheck.ok && brCheck.exists && brCheck.stat) {
        total += Number(inspectBrainDirInfo(brCheck.path, brCheck.stat, dbFilesSig).sizeBytes || 0);
      }
    }
    if (verifiedAnnDir) {
      const annCheckFile = lstatVerifiedChild(verifiedAnnDir, `${cid}.pbtxt`, { expectFile: true });
      if (annCheckFile.ok && annCheckFile.exists && annCheckFile.stat) {
        total += Number(annCheckFile.stat.size || 0);
      }
    }
  }
  return total;
}

function previewSessionCleanupCore({ targets = [], runningClients, onlineDeleteClients, options = {} }) {
  const rawGeminiOverride = String(options.geminiDir || '').trim();
  const geminiDir = resolveGeminiDir(options.geminiDir);
  const backupDir = resolveMigrationBackupRoot(options.backupDir, rawGeminiOverride);

  const { byClient, dedupSeen } = parseNormalizedTargetsByClient(targets);

  const blockedByRunning = [];
  const deletableTargets = [];
  const allDeletableIds = new Set();
  let offlineDeletableCount = 0;
  let onlineDeletableCount = 0;
  let protectedMigrationOnlineCount = 0;
  let cascadeSubagentCount = 0;
  let reclaimableSizeBytes = 0;
  let protectedOnlineSizeBytes = 0;
  const protectedMigrationItems = [];

  for (const [clientId, idList] of byClient.entries()) {
    const def = getSessionClientDef(clientId);
    const clientRoot = join(geminiDir, def.dirName);

    if (!runningClients.checked) {
      for (const cid of idList) {
        blockedByRunning.push({ clientId, sessionId: cid, reason: 'process_check_failed' });
      }
      continue;
    }

    const isRunning = Boolean(runningClients[clientId]);
    const isOnlineCapable = Boolean(isRunning && onlineDeleteClients?.[clientId]);
    if (isRunning && !isOnlineCapable) {
      for (const cid of idList) {
        blockedByRunning.push({ clientId, sessionId: cid, reason: 'client_running' });
      }
      continue;
    }

    const protectedMap = findProtectedMigrationArchives({
      backupDir,
      geminiDir: rawGeminiOverride,
      clientId,
      clientRoot,
    });

    if (!isRunning) {
      const { cascadeSubagentIds } = expandStoreCascadeTargets(clientRoot, new Set(idList));
      cascadeSubagentCount += cascadeSubagentIds.length;
      reclaimableSizeBytes += computeClientTargetsDiskSizeBytes(clientRoot, [
        ...idList,
        ...cascadeSubagentIds,
      ]);

      for (const cid of idList) {
        deletableTargets.push({ clientId, sessionId: cid, mode: 'offline' });
        offlineDeletableCount += 1;
        allDeletableIds.add(cid);
        const prot = protectedMap.get(cid);
        if (prot) {
          protectedMigrationItems.push({
            clientId,
            sessionId: cid,
            hasBrain: prot.hasBrain,
            mode: 'offline',
          });
        }
      }
      continue;
    }

    // 运行中客户端且支持在线删除：逐条检查运行中会话 / 仅索引残留 / 迁移归档保护
    const localGuards = inspectTargetSessionsForOnlineGuards(def, clientRoot, idList);
    const allowedOnlineIds = [];
    const protectedOnlineIds = [];
    for (const cid of idList) {
      const guard = localGuards.get(cid);
      if (guard?.sessionRunning) {
        blockedByRunning.push({ clientId, sessionId: cid, reason: 'session_running' });
        continue;
      }
      if (guard?.indexOnly) {
        blockedByRunning.push({ clientId, sessionId: cid, reason: 'index_only_online' });
        continue;
      }
      allowedOnlineIds.push(cid);
      deletableTargets.push({ clientId, sessionId: cid, mode: 'online' });
      onlineDeletableCount += 1;
      allDeletableIds.add(cid);
      const prot = protectedMap.get(cid);
      if (prot) {
        protectedMigrationOnlineCount += 1;
        protectedOnlineIds.push(cid);
        protectedMigrationItems.push({
          clientId,
          sessionId: cid,
          hasBrain: prot.hasBrain,
          mode: 'online',
        });
      }
    }
    if (allowedOnlineIds.length > 0) {
      const { cascadeSubagentIds } = expandStoreCascadeTargets(clientRoot, new Set(allowedOnlineIds));
      cascadeSubagentCount += cascadeSubagentIds.length;
      const clientAllBytes = computeClientTargetsDiskSizeBytes(clientRoot, [
        ...allowedOnlineIds,
        ...cascadeSubagentIds,
      ]);
      reclaimableSizeBytes += clientAllBytes;
      if (protectedOnlineIds.length > 0) {
        const nonProtectedIds = allowedOnlineIds.filter((cid) => !protectedMap.has(cid));
        const nonProtCascade =
          nonProtectedIds.length > 0
            ? expandStoreCascadeTargets(clientRoot, new Set(nonProtectedIds)).cascadeSubagentIds
            : [];
        const nonProtBytes = computeClientTargetsDiskSizeBytes(clientRoot, [
          ...nonProtectedIds,
          ...nonProtCascade,
        ]);
        protectedOnlineSizeBytes += Math.max(0, clientAllBytes - nonProtBytes);
      }
    }
  }

  // 收集其他未运行客户端中的同 ID 仅索引匹配，以及全量未运行客户端中的历史孤立索引
  const crossSourceIndexMatches = [];
  const orphanIndexMatches = [];
  const selectedKeySet = new Set(deletableTargets.map((t) => `${t.clientId}:${t.sessionId}`));

  if (runningClients.checked) {
    for (const def of SESSION_CLIENT_DEFS) {
      if (runningClients[def.id]) continue;
      const root = join(geminiDir, def.dirName);
      if (!existsSync(root)) continue;
      const artifactIds = collectStoreArtifactIds(root);
      const indexIds = collectStoreIndexIds(root, def);
      for (const idxId of indexIds) {
        if (artifactIds.has(idxId)) continue;
        const key = `${def.id}:${idxId}`;
        if (selectedKeySet.has(key)) continue;
        if (allDeletableIds.has(idxId)) {
          crossSourceIndexMatches.push({ clientId: def.id, sessionId: idxId });
        } else {
          orphanIndexMatches.push({ clientId: def.id, sessionId: idxId });
        }
      }
    }
  }

  return {
    ok: true,
    runningClients,
    onlineDeleteClients,
    requestedCount: dedupSeen.size,
    deletableCount: deletableTargets.length,
    offlineDeletableCount,
    onlineDeletableCount,
    protectedMigrationOnlineCount,
    reclaimableSizeBytes,
    protectedOnlineSizeBytes,
    blockedByRunning,
    cascadeSubagentCount,
    crossSourceIndexMatches,
    orphanIndexMatches,
    protectedMigrationItems,
    _deletableTargets: deletableTargets,
  };
}

/**
 * 预览删除指定目标时的完整影响面（同步离线版，保持向后兼容）：
 * 按端运行态拦截、级联子代理数、同 ID 跨源仅索引、历史孤立索引及受迁移归档保护提示。
 *
 * @param {{ targets: Array<{ clientId: string, sessionId: string }> }} params
 * @param {object} [options={}]
 */
export function previewSessionCleanup({ targets = [] } = {}, options = {}) {
  const runningClients = detectRunningClients(options);
  const onlineDeleteClients = resolveSyncOnlineDeleteClients(runningClients, options);
  const res = previewSessionCleanupCore({ targets, runningClients, onlineDeleteClients, options });
  delete res._deletableTargets;
  return res;
}

/**
 * 异步双通道清理影响面预览（供 HTTP API 使用）：支持自动探测运行中客户端的官方在线删除端点，
 * 并对少量在线删除目标实时复核 `GetConversation` 运行态与存在性。
 */
export async function previewSessionCleanupAsync({ targets = [] } = {}, options = {}) {
  const runningClients = await detectRunningClientsAsync(options);
  const onlineDeleteClients = await detectOnlineDeleteClientsAsync(runningClients, options);
  const res = previewSessionCleanupCore({ targets, runningClients, onlineDeleteClients, options });

  const onlineTargets = (res._deletableTargets || []).filter((t) => t.mode === 'online');
  const skipLiveProbeForMockClientsOnly = Boolean(
    options.onlineDeleteClientsOverride && !options.onlineEndpointsOverride
  );
  if (
    onlineTargets.length > 0 &&
    onlineTargets.length <= MAX_LIVE_PREVIEW_PROBES &&
    !skipLiveProbeForMockClientsOnly
  ) {
    const endpointByClient = new Map();
    const uniqueClients = Array.from(new Set(onlineTargets.map((t) => t.clientId)));
    await Promise.all(
      uniqueClients.map(async (cid) => {
        const ep = await resolveClientOnlineDeleteEndpoint(cid, options);
        if (ep) endpointByClient.set(cid, ep);
      })
    );

    const liveBlockedKeys = new Map(); // `${clientId}:${sessionId}` -> reason
    await Promise.all(
      onlineTargets.map(async (item) => {
        const ep = endpointByClient.get(item.clientId);
        if (!ep) {
          liveBlockedKeys.set(`${item.clientId}:${item.sessionId}`, 'client_running');
          return;
        }
        const live = await getConversationLiveState(ep, item.sessionId, options);
        if (live.ok && !live.found) {
          liveBlockedKeys.set(`${item.clientId}:${item.sessionId}`, 'not_found_in_running_client');
        } else if (live.ok && live.running) {
          liveBlockedKeys.set(`${item.clientId}:${item.sessionId}`, 'session_running');
        }
      })
    );

    if (liveBlockedKeys.size > 0) {
      const geminiDir = resolveGeminiDir(options.geminiDir);
      const keptTargets = [];
      for (const item of res._deletableTargets) {
        const key = `${item.clientId}:${item.sessionId}`;
        const blockReason = liveBlockedKeys.get(key);
        if (blockReason) {
          res.blockedByRunning.push({
            clientId: item.clientId,
            sessionId: item.sessionId,
            reason: blockReason,
          });
          res.onlineDeletableCount = Math.max(0, res.onlineDeletableCount - 1);
          res.deletableCount = Math.max(0, res.deletableCount - 1);
        } else {
          keptTargets.push(item);
        }
      }
      res.protectedMigrationItems = res.protectedMigrationItems.filter(
        (item) => !liveBlockedKeys.has(`${item.clientId}:${item.sessionId}`)
      );
      res.protectedMigrationOnlineCount = res.protectedMigrationItems.filter(
        (item) => item.mode === 'online'
      ).length;

      // 重算受影响的级联子代理总数与可释放磁盘空间
      let recalculatedCascade = 0;
      let recalculatedReclaimableBytes = 0;
      let recalculatedProtectedOnlineBytes = 0;
      const keptByClient = new Map();
      const protectedOnlineKeySet = new Set(
        res.protectedMigrationItems
          .filter((item) => item.mode === 'online')
          .map((item) => `${item.clientId}:${item.sessionId}`)
      );
      for (const item of keptTargets) {
        if (!keptByClient.has(item.clientId)) keptByClient.set(item.clientId, []);
        keptByClient.get(item.clientId).push(item.sessionId);
      }
      for (const [clientId, ids] of keptByClient.entries()) {
        const def = getSessionClientDef(clientId);
        if (!def) continue;
        const root = join(geminiDir, def.dirName);
        if (!existsSync(root)) continue;
        const { cascadeSubagentIds } = expandStoreCascadeTargets(root, new Set(ids));
        recalculatedCascade += cascadeSubagentIds.length;
        const clientAllBytes = computeClientTargetsDiskSizeBytes(root, [...ids, ...cascadeSubagentIds]);
        recalculatedReclaimableBytes += clientAllBytes;
        const clientProtectedOnline = ids.filter((cid) => protectedOnlineKeySet.has(`${clientId}:${cid}`));
        if (clientProtectedOnline.length > 0) {
          const nonProtIds = ids.filter((cid) => !protectedOnlineKeySet.has(`${clientId}:${cid}`));
          const nonProtCascade =
            nonProtIds.length > 0
              ? expandStoreCascadeTargets(root, new Set(nonProtIds)).cascadeSubagentIds
              : [];
          const nonProtBytes = computeClientTargetsDiskSizeBytes(root, [
            ...nonProtIds,
            ...nonProtCascade,
          ]);
          recalculatedProtectedOnlineBytes += Math.max(0, clientAllBytes - nonProtBytes);
        }
      }
      res.cascadeSubagentCount = recalculatedCascade;
      res.reclaimableSizeBytes = recalculatedReclaimableBytes;
      res.protectedOnlineSizeBytes = recalculatedProtectedOnlineBytes;

      // 若被拦截的目标在离线客户端有跨源索引匹配，从 crossSourceIndexMatches 降级移除
      const remainingIds = new Set(keptTargets.map((item) => item.sessionId));
      res.crossSourceIndexMatches = res.crossSourceIndexMatches.filter((m) =>
        remainingIds.has(m.sessionId)
      );
    }
  }

  delete res._deletableTargets;
  return res;
}

function finalizeDeletedSessionsPostCleanup({
  params,
  options,
  byClient,
  runningClients,
  geminiDir,
  rawGeminiOverride,
  backupDir,
  electronAppDataDir,
  deleted,
  failed,
  allDeletedIds,
  deletedByClientMap,
  onlineDeletedByClientMap = null,
  warnings,
  cascadeSubagentCount,
  protectedBrainKept,
  onlineDeletedCount = 0,
  offlineDeletedCount = 0,
}) {
  const redactLedger = params.redactLedger !== false;
  const clearBrowserCache = Boolean(params.clearBrowserCache);
  const includeOrphanIndexes = Boolean(params.includeOrphanIndexes);

  // 若勾选清理浏览器缓存但本批删的不是 desktop（例如只删了 CLI/旧 IDE），且 desktop 未运行，补充执行缓存清理
  if (clearBrowserCache && !byClient.has('desktop') && deleted.length > 0 && !runningClients.desktop) {
    const cacheRes = clearElectronBrowserCachesIfIdle({
      electronAppDataDir,
      geminiDir: rawGeminiOverride,
      runningClients,
    });
    warnings.push(...cacheRes.warnings);
  }

  // 跨端联动清理其他未运行客户端中的同 ID 仅索引，以及可选的历史孤立索引
  let extraOrphans = Array.isArray(params.orphanIndexTargets) ? params.orphanIndexTargets : [];
  if (includeOrphanIndexes && extraOrphans.length === 0 && runningClients.checked) {
    const prev = previewSessionCleanup(
      { targets: deleted },
      { geminiDir: rawGeminiOverride || geminiDir, backupDir, runningClientsOverride: runningClients }
    );
    extraOrphans = prev.orphanIndexMatches || [];
  }

  let crossOrphanCleanedCount = 0;
  if (allDeletedIds.size > 0 || extraOrphans.length > 0) {
    const crossRes = cleanupCrossClientIndexOnlyResiduals({
      deletedIds: allDeletedIds,
      extraOrphanTargets: extraOrphans,
      runningClients,
      geminiDir: rawGeminiOverride || geminiDir,
      backupDir,
      electronAppDataDir,
    });
    crossOrphanCleanedCount = crossRes.cleanedCount;
    warnings.push(...crossRes.warnings);
  }

  // 若删除的是由跨端 move 迁入的目标会话，同步清除其关联的源端明文归档备份及孤立源端 brain 媒体目录（仅未运行源端）
  if (deletedByClientMap.size > 0) {
    cleanupLinkedMigrationSourcesForDeletedTargets({
      backupDir,
      geminiDir: rawGeminiOverride || geminiDir,
      deletedByClient: deletedByClientMap,
      runningClients,
    });
  }

  // 在线账本隐私脱敏（作用于插件自有 SQLite 账本，Desktop 运行中亦可安全实时执行）
  let ledgerRedaction = {
    enabled: redactLedger,
    redactedConversations: 0,
    redactedSteps: 0,
    redactedBakConversations: 0,
  };
  if (redactLedger && allDeletedIds.size > 0) {
    const redRes = redactDeletedLedgerSessions({
      targetIds: allDeletedIds,
      sweepAllDeleted: false,
      geminiDir: rawGeminiOverride,
      backupDir,
      onlineDeletedByClient: onlineDeletedByClientMap,
      cacheStore: options.cacheStore,
      placeholderTitle: options.placeholderTitle,
    });
    ledgerRedaction = {
      enabled: true,
      redactedConversations: redRes.redactedConversations || 0,
      redactedSteps: redRes.redactedSteps || 0,
      redactedBakConversations: redRes.redactedBakConversations || 0,
    };
  }

  if (deleted.length > 0 || crossOrphanCleanedCount > 0) {
    clearSessionManagerScanCaches();
  }

  const deletedCount = deleted.length;
  const failedCount = failed.length;
  const firstError = deletedCount === 0 ? failed[0]?.error || 'delete_failed' : '';
  const conflictErrors = new Set([
    'client_running',
    'session_running',
    'protected_migration_online',
  ]);

  return {
    ok: deletedCount > 0,
    status: deletedCount > 0 ? 200 : conflictErrors.has(firstError) ? 409 : 400,
    ...(firstError ? { error: firstError } : {}),
    deletedCount,
    onlineDeletedCount,
    offlineDeletedCount,
    failedCount,
    cascadeSubagentCount,
    crossOrphanCleanedCount,
    protectedBrainKept,
    ledgerRedaction,
    deleted,
    failed,
    warnings,
  };
}

/**
 * 执行本地会话删除（同步离线版：按端运行态守卫 + 两阶段事务清理 + 跨源仅索引联动 + 账本脱敏）。
 *
 * @param {object} params
 * @param {object} [options={}]
 */
export function deleteLocalSessions(params = {}, options = {}) {
  const rawGeminiOverride = String(options.geminiDir || '').trim();
  const geminiDir = resolveGeminiDir(options.geminiDir);
  const backupDir = resolveMigrationBackupRoot(options.backupDir, rawGeminiOverride);
  const electronAppDataDir = resolveElectronAppDataDir({
    explicitAppDataDir: options.electronAppDataDir || '',
    explicitGeminiDir: rawGeminiOverride,
  });
  const runningClients = detectRunningClients({ ...options, forceRefresh: true });

  const clearBrowserCache = Boolean(params.clearBrowserCache);
  const preserveProtectedBrain = params.preserveProtectedBrain !== false;
  const { byClient, dedupSeen } = parseNormalizedTargetsByClient(params.targets);

  if (dedupSeen.size === 0) {
    return {
      ok: false,
      status: 400,
      error: 'no_sessions_selected',
      deletedCount: 0,
      onlineDeletedCount: 0,
      offlineDeletedCount: 0,
      failedCount: 0,
      deleted: [],
      failed: [],
      warnings: [],
    };
  }

  const deleted = [];
  const failed = [];
  const allDeletedIds = new Set();
  const deletedByClientMap = new Map();
  const warnings = [];
  let cascadeSubagentCount = 0;
  let offlineDeletedCount = 0;
  const protectedBrainKept = [];

  for (const [clientId, idList] of byClient.entries()) {
    const def = getSessionClientDef(clientId);
    const clientRoot = join(geminiDir, def.dirName);

    if (!runningClients.checked) {
      for (const cid of idList) {
        failed.push({ clientId, sessionId: cid, error: 'process_check_failed' });
      }
      continue;
    }
    if (runningClients[clientId]) {
      for (const cid of idList) {
        failed.push({ clientId, sessionId: cid, error: 'client_running' });
      }
      continue;
    }

    const protectedMap = findProtectedMigrationArchives({
      backupDir,
      geminiDir: rawGeminiOverride,
      clientId,
      clientRoot,
    });
    const protectedIds = new Set(protectedMap.keys());

    const batchRes = cleanClientSessionsBatch({
      clientDef: def,
      clientRoot,
      requestedIds: idList,
      protectedIds,
      preserveProtectedBrain,
      geminiDir: rawGeminiOverride || geminiDir,
      backupDir,
      electronAppDataDir,
      clearBrowserCache: clearBrowserCache && def.id === 'desktop',
      runningClients,
    });

    if (batchRes.succeeded.length > 0) {
      if (!deletedByClientMap.has(clientId)) deletedByClientMap.set(clientId, new Set());
      const clientSet = deletedByClientMap.get(clientId);
      for (const sid of batchRes.succeeded) {
        deleted.push({ clientId, sessionId: sid, mode: 'offline' });
        offlineDeletedCount += 1;
        allDeletedIds.add(sid);
        clientSet.add(sid);
      }
      for (const subId of batchRes.cascadeSubagentIds) {
        allDeletedIds.add(subId);
        clientSet.add(subId);
      }
    } else {
      for (const subId of batchRes.cascadeSubagentIds) {
        allDeletedIds.add(subId);
      }
    }
    cascadeSubagentCount += batchRes.cascadeSubagentIds.length;
    failed.push(...batchRes.failed);
    protectedBrainKept.push(...batchRes.protectedBrainKept);
    warnings.push(...batchRes.warnings);
  }

  return finalizeDeletedSessionsPostCleanup({
    params,
    options,
    byClient,
    runningClients,
    geminiDir,
    rawGeminiOverride,
    backupDir,
    electronAppDataDir,
    deleted,
    failed,
    allDeletedIds,
    deletedByClientMap,
    warnings,
    cascadeSubagentCount,
    protectedBrainKept,
    onlineDeletedCount: 0,
    offlineDeletedCount,
  });
}

/**
 * 异步双通道本地会话删除（供 HTTP API 使用）：
 * - 客户端未运行时走两阶段离线深度清理（`session-cleaner.mjs`）；
 * - 客户端运行中且存在已验证的本端 `product.v1.ConversationService` 时，经实时状态核验后通过官方
 *   `DeleteConversation` RPC 安全在线删除，并在完成后立即对本插件账本执行在线隐私脱敏。
 *
 * @param {object} params
 * @param {object} [options={}]
 */
export async function deleteLocalSessionsAsync(params = {}, options = {}) {
  const rawGeminiOverride = String(options.geminiDir || '').trim();
  const geminiDir = resolveGeminiDir(options.geminiDir);
  const backupDir = resolveMigrationBackupRoot(options.backupDir, rawGeminiOverride);
  const electronAppDataDir = resolveElectronAppDataDir({
    explicitAppDataDir: options.electronAppDataDir || '',
    explicitGeminiDir: rawGeminiOverride,
  });

  const clearBrowserCache = Boolean(params.clearBrowserCache);
  const preserveProtectedBrain = params.preserveProtectedBrain !== false;
  const { byClient, dedupSeen } = parseNormalizedTargetsByClient(params.targets);

  if (dedupSeen.size === 0) {
    return {
      ok: false,
      status: 400,
      error: 'no_sessions_selected',
      deletedCount: 0,
      onlineDeletedCount: 0,
      offlineDeletedCount: 0,
      failedCount: 0,
      deleted: [],
      failed: [],
      warnings: [],
    };
  }

  const runningClients = await detectRunningClientsAsync({ ...options, forceRefresh: true });
  const onlineDeleteClients = await detectOnlineDeleteClientsAsync(runningClients, {
    ...options,
    forceRefresh: true,
  });

  const deleted = [];
  const failed = [];
  const allDeletedIds = new Set();
  const deletedByClientMap = new Map();
  const onlineDeletedByClientMap = new Map();
  const warnings = [];
  let cascadeSubagentCount = 0;
  let onlineDeletedCount = 0;
  let offlineDeletedCount = 0;
  const protectedBrainKept = [];

  for (const [clientId, idList] of byClient.entries()) {
    const def = getSessionClientDef(clientId);
    const clientRoot = join(geminiDir, def.dirName);

    if (!runningClients.checked) {
      for (const cid of idList) {
        failed.push({ clientId, sessionId: cid, error: 'process_check_failed' });
      }
      continue;
    }

    const protectedMap = findProtectedMigrationArchives({
      backupDir,
      geminiDir: rawGeminiOverride,
      clientId,
      clientRoot,
    });

    // 通道 A：客户端未运行 -> 两阶段离线深度清理
    if (!runningClients[clientId]) {
      const batchRes = cleanClientSessionsBatch({
        clientDef: def,
        clientRoot,
        requestedIds: idList,
        protectedIds: new Set(protectedMap.keys()),
        preserveProtectedBrain,
        geminiDir: rawGeminiOverride || geminiDir,
        backupDir,
        electronAppDataDir,
        clearBrowserCache: clearBrowserCache && def.id === 'desktop',
        runningClients,
      });

      if (batchRes.succeeded.length > 0) {
        if (!deletedByClientMap.has(clientId)) deletedByClientMap.set(clientId, new Set());
        const clientSet = deletedByClientMap.get(clientId);
        for (const sid of batchRes.succeeded) {
          deleted.push({ clientId, sessionId: sid, mode: 'offline' });
          offlineDeletedCount += 1;
          allDeletedIds.add(sid);
          clientSet.add(sid);
        }
        for (const subId of batchRes.cascadeSubagentIds) {
          allDeletedIds.add(subId);
          clientSet.add(subId);
        }
      } else {
        for (const subId of batchRes.cascadeSubagentIds) {
          allDeletedIds.add(subId);
        }
      }
      cascadeSubagentCount += batchRes.cascadeSubagentIds.length;
      failed.push(...batchRes.failed);
      protectedBrainKept.push(...batchRes.protectedBrainKept);
      warnings.push(...batchRes.warnings);
      continue;
    }

    // 通道 B：客户端运行中 -> 仅允许通过已验证的本端官方 ConversationService RPC 删除
    if (!onlineDeleteClients[clientId]) {
      for (const cid of idList) {
        failed.push({ clientId, sessionId: cid, error: 'client_running' });
      }
      continue;
    }

    const endpoint = await resolveClientOnlineDeleteEndpoint(clientId, options);
    if (!endpoint) {
      for (const cid of idList) {
        failed.push({ clientId, sessionId: cid, error: 'client_running' });
      }
      continue;
    }

    const localGuards = inspectTargetSessionsForOnlineGuards(def, clientRoot, idList);
    if (!deletedByClientMap.has(clientId)) deletedByClientMap.set(clientId, new Set());
    if (!onlineDeletedByClientMap.has(clientId)) onlineDeletedByClientMap.set(clientId, new Set());
    const clientSet = deletedByClientMap.get(clientId);
    const onlineClientSet = onlineDeletedByClientMap.get(clientId);

    for (const cid of idList) {
      const guard = localGuards.get(cid);
      if (guard?.sessionRunning) {
        failed.push({ clientId, sessionId: cid, error: 'session_running' });
        continue;
      }
      if (guard?.indexOnly) {
        failed.push({ clientId, sessionId: cid, error: 'index_only_online' });
        continue;
      }
      // 在线官方接口会直接移除 brain/<cid>，若受迁移归档保护且未显式勾选彻底清理，拒绝静默销毁
      if (protectedMap.has(cid) && preserveProtectedBrain) {
        protectedBrainKept.push(cid);
        failed.push({ clientId, sessionId: cid, error: 'protected_migration_online' });
        continue;
      }

      // 实时核验运行态与存在性（防止列表加载后刚刚开始生成或仅存未加载的本地幽灵文件）
      const liveState = await getConversationLiveState(endpoint, cid, options);
      if (liveState.ok && !liveState.found) {
        failed.push({ clientId, sessionId: cid, error: 'not_found_in_running_client' });
        continue;
      }
      if (liveState.ok && liveState.running) {
        failed.push({ clientId, sessionId: cid, error: 'session_running' });
        continue;
      }
      if (!liveState.ok && !liveState.unimplemented) {
        if (liveState.authError || liveState.code === 'unavailable') {
          invalidateOnlineDeleteEndpointCache(clientId, rawGeminiOverride);
        }
        failed.push({
          clientId,
          sessionId: cid,
          error: liveState.authError
            ? 'online_auth_failed'
            : liveState.code === 'unavailable'
              ? 'online_endpoint_unavailable'
              : `online_check_failed:${liveState.error}`,
        });
        continue;
      }

      // 删除父会话前先采集嵌套子代理（/fork 保持独立不受级联）
      const { cascadeSubagentIds } = existsSync(clientRoot)
        ? expandStoreCascadeTargets(clientRoot, new Set([cid]))
        : { cascadeSubagentIds: [] };

      const delRes = await deleteConversationOnline(endpoint, cid, options);
      if (!delRes.ok) {
        if (delRes.authError || delRes.code === 'unavailable') {
          invalidateOnlineDeleteEndpointCache(clientId, rawGeminiOverride);
        }
        const errCode = delRes.notFound
          ? 'not_found_in_running_client'
          : delRes.unimplemented
            ? 'online_delete_unsupported'
            : delRes.authError
              ? 'online_auth_failed'
              : delRes.code === 'unavailable'
                ? 'online_endpoint_unavailable'
                : delRes.error || 'online_delete_failed';
        failed.push({ clientId, sessionId: cid, error: errCode });
        continue;
      }

      deleted.push({ clientId, sessionId: cid, mode: 'online' });
      onlineDeletedCount += 1;
      allDeletedIds.add(cid);
      clientSet.add(cid);
      onlineClientSet.add(cid);

      // 若宿主未自动级联移除嵌套子代理，顺带通过官方接口安全清理空闲子代理
      for (const subId of cascadeSubagentIds) {
        if (subId === cid || allDeletedIds.has(subId)) continue;
        const subLive = await getConversationLiveState(endpoint, subId, options);
        if (subLive.ok && !subLive.found) {
          cascadeSubagentCount += 1;
          allDeletedIds.add(subId);
          clientSet.add(subId);
          onlineClientSet.add(subId);
        } else if (subLive.ok && subLive.found && !subLive.running) {
          const subDel = await deleteConversationOnline(endpoint, subId, options);
          if (subDel.ok) {
            cascadeSubagentCount += 1;
            allDeletedIds.add(subId);
            clientSet.add(subId);
            onlineClientSet.add(subId);
          } else {
            warnings.push(`online_subagent_delete_skipped(${subId.slice(0, 8)}): ${subDel.error}`);
          }
        } else if (subLive.ok && subLive.running) {
          warnings.push(`online_subagent_running_kept(${subId.slice(0, 8)})`);
        }
      }
    }

    if (clientSet.size === 0) {
      deletedByClientMap.delete(clientId);
    }
    if (onlineClientSet.size === 0) {
      onlineDeletedByClientMap.delete(clientId);
    }
  }

  return finalizeDeletedSessionsPostCleanup({
    params,
    options,
    byClient,
    runningClients,
    geminiDir,
    rawGeminiOverride,
    backupDir,
    electronAppDataDir,
    deleted,
    failed,
    allDeletedIds,
    deletedByClientMap,
    onlineDeletedByClientMap,
    warnings,
    cascadeSubagentCount,
    protectedBrainKept,
    onlineDeletedCount,
    offlineDeletedCount,
  });
}

/**
 * 补扫本插件账本中所有已在本机三端删除的历史会话并执行在线隐私脱敏。
 *
 * @param {object} [options={}]
 */
export function sweepLedgerPrivacy(options = {}) {
  const res = redactDeletedLedgerSessions({
    sweepAllDeleted: true,
    geminiDir: options.geminiDir,
    backupDir: options.backupDir,
    extraLiveIds: options.extraLiveIds,
    cacheStore: options.cacheStore,
    placeholderTitle: options.placeholderTitle,
  });
  return {
    ok: Boolean(res.ok),
    status: res.ok ? 200 : 500,
    ...(res.error ? { error: res.error } : {}),
    redactedConversations: res.redactedConversations || 0,
    redactedSteps: res.redactedSteps || 0,
    redactedBakConversations: res.redactedBakConversations || 0,
    changedIds: res.changedIds || [],
  };
}
