/**
 * @fileoverview 本地磁盘会话文件发现、外部 IDE/CLI 深层统计缓存加载与历史轨迹增量同步。
 *
 * 负责：
 * 1. 扫描 `~/.gemini/antigravity/conversations` 下的本地 `.db` / `.pb` / `.db-wal` 会话文件及修改时间；
 * 2. 读取跨端共享的 `.deep_stats_cache.json`（兼容 IDE / CLI / Standalone 多端步骤数据合并与账号归属隔离）；
 * 3. 将 Language Server 摘要、本地磁盘文件与内存缓存三方会话列表按大小写不敏感键对齐，并以受控并发（最多 4 路）
 *    拉取新增或 Schema 过期的会话轨迹步骤，持久化至 `trajectory_usage_cache.json`。
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import {
  extractLiveActivity,
  extractModelSteps,
  extractSwarmMetaFromSteps,
  getMaxMeaningfulStepIndex,
  isParkedOnSwarmWait,
  parseIsoMs,
  parseSwarmWorkerRole,
} from '../trajectory-metrics.mjs';
import {
  ANNOTATION_DIRS,
  archiveLocalTrajectory,
  hasUsageHistory,
  getCachedTrajectory,
  BRAIN_DIR,
  BRAIN_DIRS,
  CACHE_SCHEMA_VERSION,
  CONVERSATIONS_DIR,
  CONVERSATION_DIRS,
  DEEP_STATS_CACHE_CANDIDATES,
  externalDeepStatsMemo,
  loadJson,
} from './config.mjs';
import { getEndpointCacheStore, getRegisteredRemoteEndpoint } from './endpoint-registry.mjs';
import {
  computeSqliteWalSig,
  hasBuiltinNodeSqlite,
  readAnnotationTitleForCascade,
  readLocalSqliteTrajectory,
  readLocalSummaryIndex,
} from './cli-sqlite-reader.mjs';
import { callLsRpc } from './ls-rpc.mjs';
import { formatGenericModelSlug, getBaseModelLabel } from './model-pricing.mjs';
import { PLACEHOLDER_MAP } from './pricing-catalog.mjs';

const CONV_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(db|pb|db-wal)$/i;
const TRANSCRIPT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 联合扫描本地多端（Desktop / CLI / IDE）的 `conversations` 与 `brain/<id>/.system_generated/logs/transcript.jsonl`，
 * 按小写 `cascadeId` 归并关联磁盘文件路径。
 *
 * @returns {{map: Map<string, string[]>, storeDirs: Map<string, string[]>, readable: Set<string>, complete: boolean}}
 */
function discoverLocalConversationFiles() {
  const readable = new Set();
  let complete = true;
  function names(dir, options) {
    try {
      const result = readdirSync(dir, options);
      if (!options?.withFileTypes) readable.add(dir);
      return result;
    } catch (error) {
      if (error.code !== 'ENOENT') complete = false;
      return [];
    }
  }
  const map = new Map();
  const storeDirs = new Map();
  function addFile(id, dir, path) {
    if (!map.has(id)) {
      map.set(id, []);
      storeDirs.set(id, []);
    }
    map.get(id).push(path);
    if (!storeDirs.get(id).includes(dir)) storeDirs.get(id).push(dir);
  }
  const convDirs = [...CONVERSATION_DIRS];
  const brainDirs = [...BRAIN_DIRS];
  const profileDirs = new Set();
  const base = join(homedir(), '.cc-switch', 'agy');
  for (const profile of names(base, { withFileTypes: true })) {
    if (profile.isSymbolicLink()) {
      complete = false;
      continue;
    }
    if (!profile.isDirectory()) continue;
    const root = join(base, profile.name, 'antigravity-cli');
    const conversations = join(root, 'conversations');
    const brain = join(root, 'brain');
    convDirs.push(conversations);
    brainDirs.push(brain);
    profileDirs.add(conversations);
    profileDirs.add(brain);
  }
  const include = (dir, id) => !profileDirs.has(dir) || map.has(id) || getCachedTrajectory(id) || hasUsageHistory(id);
  for (const dir of convDirs) {
    for (const rawName of names(dir)) {
      const name = String(rawName || '');
      const m = name.match(CONV_FILE_RE);
      if (!m) continue;
      const cascadeId = m[1].toLowerCase();
      if (!include(dir, cascadeId)) continue;
      addFile(cascadeId, dir, join(dir, name));
    }
  }

  for (const dir of brainDirs) {
    for (const rawName of names(dir)) {
      const name = String(rawName || '').trim();
      const cascadeId = name.toLowerCase();
      if (!TRANSCRIPT_UUID_RE.test(cascadeId) || !include(dir, cascadeId)) continue;
      const transcriptPath = join(dir, name, '.system_generated', 'logs', 'transcript.jsonl');
      try {
        if (!statSync(transcriptPath).isFile()) continue;
      } catch (error) {
        if (error.code !== 'ENOENT') complete = false;
        continue;
      }
      addFile(cascadeId, dir, transcriptPath);
    }
  }

  const annotationDirs = Array.isArray(ANNOTATION_DIRS) ? ANNOTATION_DIRS : [];
  if (annotationDirs.length > 0 && map.size > 0) {
    for (const annDir of annotationDirs) {
      if (!annDir || !existsSync(annDir)) continue;
      try {
        for (const rawName of readdirSync(annDir)) {
          const name = String(rawName || '');
          if (!name.toLowerCase().endsWith('.pbtxt')) continue;
          const cascadeId = name.slice(0, -6).toLowerCase();
          const fileList = map.get(cascadeId);
          if (fileList) {
            fileList.push(join(annDir, name));
          }
        }
      } catch {
        // 忽略注释目录读取异常
      }
    }
  }
  for (const dirs of storeDirs.values()) dirs.sort();
  return { map, storeDirs, readable, complete };
}

const firstMissingAt = new Map();
const MISSING_GRACE_MS = 60_000;

function readConversationMtime(files = []) {
  let mtimeMs = 0;
  for (const nameOrPath of files) {
    try {
      const fullPath = /[\\/]|^[a-zA-Z]:/.test(nameOrPath)
        ? nameOrPath
        : join(CONVERSATIONS_DIR, nameOrPath);
      mtimeMs = Math.max(mtimeMs, Number(statSync(fullPath)?.mtimeMs || 0));
    } catch {
      // 轨迹文件可能在目录枚举后被宿主删除。
    }
  }
  return mtimeMs;
}

/**
 * 加载并解析跨端（IDE / Standalone / JetBrains）写入的 `.deep_stats_cache.json` 缓存。
 * 使用文件签名 (`mtimeMs + size`) 进行 Memoize，文件未变化时直接返回内存 Map。
 *
 * @returns {Map<string, {cascadeId: string, appSource: string, accountName: string, title: string, lastModifiedMs: number, steps: object[]}>}
 */
export function loadExternalDeepStatsCache() {
  const sigParts = [];
  const existingFiles = [];
  for (const candidate of DEEP_STATS_CACHE_CANDIDATES) {
    if (!existsSync(candidate)) continue;
    try {
      const st = statSync(candidate);
      sigParts.push(`${candidate}:${st.mtimeMs || 0}:${st.size || 0}`);
      existingFiles.push(candidate);
    } catch {
      // 忽略 stat 异常
    }
  }
  if (existingFiles.length === 0) {
    return new Map();
  }
  const sig = sigParts.join('|');
  if (externalDeepStatsMemo.sig === sig && externalDeepStatsMemo.convos.size > 0) {
    return externalDeepStatsMemo.convos;
  }

  const convos = new Map();
  const runtimeDisplayMap = new Map();

  for (const filePath of existingFiles) {
    const raw = loadJson(filePath, null);
    if (!raw || typeof raw.perConvo !== 'object' || !raw.perConvo) continue;
    const fileAccountName = String(raw.accountName || raw.email || '').trim();

    for (const item of Object.values(raw.perConvo)) {
      for (const e of item?.entries || []) {
        const intrinsicDisplay =
          PLACEHOLDER_MAP[e?.modelRuntimeId]?.label ||
          formatGenericModelSlug(e?.modelCanonicalId || e?.model);
        const isSessionDisplayAgg = /^session-display:/i.test(String(e?.modelAggregationId || ''));
        const usableDisplayHint =
          e?.modelDisplayName &&
          !(
            isSessionDisplayAgg &&
            intrinsicDisplay &&
            getBaseModelLabel(e.modelDisplayName) !== getBaseModelLabel(intrinsicDisplay)
          )
            ? e.modelDisplayName
            : '';
        const display =
          usableDisplayHint ||
          intrinsicDisplay ||
          formatGenericModelSlug(e?.modelAggregationId);
        if (!display) continue;
        const base = getBaseModelLabel(display);
        if (e?.modelRuntimeId && !runtimeDisplayMap.has(e.modelRuntimeId)) {
          runtimeDisplayMap.set(e.modelRuntimeId, base);
        }
        if (e?.model && !runtimeDisplayMap.has(e.model)) {
          runtimeDisplayMap.set(e.model, base);
        }
      }
    }

    const titleMap = raw.titleMap || {};
    for (const [fullKey, item] of Object.entries(raw.perConvo)) {
      const rawEntries = item?.entries;
      if (!Array.isArray(rawEntries) || rawEntries.length === 0) continue;
      const colonIdx = fullKey.indexOf(':');
      const appSource = item?.appSource || (colonIdx > 0 ? fullKey.slice(0, colonIdx) : 'ide');
      const cascadeId = (colonIdx > 0 ? fullKey.slice(colonIdx + 1) : fullKey).toLowerCase();
      const mapKey = `${appSource}:${cascadeId}`;
      const existing = convos.get(mapKey);
      if (existing && existing.steps.length >= rawEntries.length) continue;

      const itemAccountName = String(
        item?.accountName || item?.email || fileAccountName || ''
      ).trim();

      const steps = [];
      let lastModifiedMs = 0;
      for (let idx = 0; idx < rawEntries.length; idx++) {
        const e = rawEntries[idx];
        const inputTokens = Math.max(0, Math.floor(Number(e?.inp) || 0));
        const cacheReadTokens = Math.max(0, Math.floor(Number(e?.cache) || 0));
        const responseTokens = Math.max(0, Math.floor(Number(e?.out) || 0));
        const thinkingTokens = Math.max(0, Math.floor(Number(e?.reasoning) || 0));
        const outputTokens = responseTokens + thinkingTokens;
        if (inputTokens === 0 && cacheReadTokens === 0 && outputTokens === 0) continue;
        const createdAtMs = e?.ts ? Date.parse(e.ts) || 0 : 0;
        if (createdAtMs > lastModifiedMs) lastModifiedMs = createdAtMs;
        const stepIntrinsicLabel =
          PLACEHOLDER_MAP[e?.modelRuntimeId]?.label ||
          formatGenericModelSlug(e?.modelCanonicalId || e?.model);
        const isSessionDisplayAgg = /^session-display:/i.test(String(e?.modelAggregationId || ''));
        const safeStepDisplayName =
          e?.modelDisplayName &&
          !(
            isSessionDisplayAgg &&
            stepIntrinsicLabel &&
            getBaseModelLabel(e.modelDisplayName) !== getBaseModelLabel(stepIntrinsicLabel)
          )
            ? e.modelDisplayName
            : '';
        const resolvedDisplay =
          safeStepDisplayName ||
          stepIntrinsicLabel ||
          runtimeDisplayMap.get(e?.model) ||
          runtimeDisplayMap.get(e?.modelRuntimeId) ||
          formatGenericModelSlug(e?.modelAggregationId) ||
          '';
        const rawUpstreamCandidate = String(e?.model || e?.modelCanonicalId || '').trim();
        const inferredResponseModel =
          /^session:/i.test(String(e?.modelAggregationId || '')) &&
          rawUpstreamCandidate &&
          !/^MODEL_/i.test(rawUpstreamCandidate) &&
          !/\s/.test(rawUpstreamCandidate)
            ? rawUpstreamCandidate
            : '';
        steps.push({
          stepIndex: idx + 1,
          createdAt: e?.ts || '',
          createdAtMs,
          modelKey: e?.modelCanonicalId || e?.model || e?.modelRuntimeId || 'unknown',
          modelDisplayName: resolvedDisplay,
          ...(inferredResponseModel ? { responseModel: inferredResponseModel } : {}),
          apiProvider: e?.provider || '',
          appSource,
          inputTokens,
          cacheReadTokens,
          outputTokens,
          thinkingTokens,
          responseTokens,
        });
      }
      if (steps.length > 0) {
        convos.set(mapKey, {
          cascadeId,
          appSource,
          accountName: itemAccountName,
          title: titleMap[fullKey] || titleMap[cascadeId] || cascadeId.slice(0, 8),
          lastModifiedMs,
          steps,
        });
      }
    }
  }

  externalDeepStatsMemo.sig = sig;
  externalDeepStatsMemo.convos = convos;
  return convos;
}

const MAX_CONCURRENT_RPC = 4;
const LEGACY_MIGRATION_BATCH_SIZE = 8;
const stepFieldChecks = new WeakMap();

function normalizeOwnerAccount(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * 为会话步骤维护细粒度账号归属：
 * - 已存在于旧缓存中的历史步骤保留原归属账号（兼容跨账号续聊同一会话）；
 * - 切换账号后在该会话中新产生的步骤写入当前活跃账号 `step.accountName`，仅供「可用额度」按账号隔离统计。
 */
function attachStepAccountOwners(steps, prev, currentAccountName, entryAccountName) {
  if (!Array.isArray(steps) || steps.length === 0) return steps;
  const activeOwner = normalizeOwnerAccount(currentAccountName);
  const entryOwner = normalizeOwnerAccount(entryAccountName);
  const prevOwner = normalizeOwnerAccount(prev?.accountName);
  const prevSteps = Array.isArray(prev?.steps) ? prev.steps : [];

  if (prevSteps.length === 0) {
    const initialOwner = prevOwner || activeOwner || entryOwner;
    if (!initialOwner || initialOwner === entryOwner) return steps;
    return steps.map((s) => ({ ...s, accountName: initialOwner }));
  }

  const prevByIndex = new Map();
  let maxPrevStepIndex = -1;
  let maxPrevCreatedAtMs = 0;
  for (const ps of prevSteps) {
    if (!ps || typeof ps !== 'object') continue;
    const idx = Number(ps.stepIndex);
    if (Number.isFinite(idx)) {
      prevByIndex.set(idx, ps);
      if (idx > maxPrevStepIndex) maxPrevStepIndex = idx;
    }
    const cMs = Number(ps.createdAtMs || 0);
    if (cMs > maxPrevCreatedAtMs) maxPrevCreatedAtMs = cMs;
  }

  let mutated = false;
  const out = steps.map((s) => {
    const idx = Number(s?.stepIndex);
    const matchedPrev = Number.isFinite(idx) ? prevByIndex.get(idx) : null;
    let stepOwner = '';
    if (matchedPrev) {
      stepOwner = normalizeOwnerAccount(matchedPrev.accountName) || prevOwner;
    } else {
      const cMs = Number(s?.createdAtMs || 0);
      const isHistoricalBackfill =
        (Number.isFinite(idx) && maxPrevStepIndex >= 0 && idx <= maxPrevStepIndex) ||
        (cMs > 0 && maxPrevCreatedAtMs > 0 && cMs <= maxPrevCreatedAtMs);
      stepOwner = isHistoricalBackfill ? prevOwner || activeOwner : activeOwner || prevOwner;
    }
    const storedAccount = stepOwner && stepOwner !== entryOwner ? stepOwner : undefined;
    if (s?.accountName === storedAccount) return s;
    mutated = true;
    if (storedAccount) {
      return { ...s, accountName: storedAccount };
    }
    const { accountName: _removed, ...rest } = s;
    return rest;
  });
  return mutated ? out : steps;
}
const MAX_SUBAGENT_RECONCILE_DEPTH = 4;
const FAILED_RPC_COOLDOWN_MS = 60_000;
const ACTIVE_FAILED_RPC_COOLDOWN_MS = 15_000;
const TRANSCRIPT_TAIL_MAX_BYTES = 96 * 1024;
const MAX_TRANSCRIPT_MEMO_ENTRIES = 64;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const failedFetchCooldownMap = new Map();
const liveActivityMemo = new Map();
const transcriptTailMemo = new Map();
const swarmManifestMemo = new Map();

export function clearScannerRuntimeMemos(endpointId = null) {
  if (endpointId && endpointId !== 'local') {
    const ep = getRegisteredRemoteEndpoint(endpointId);
    if (ep) {
      ep.failedFetchCooldownMap.clear();
      ep.liveActivityMemo.clear();
    }
    return;
  }
  failedFetchCooldownMap.clear();
  firstMissingAt.clear();
  liveActivityMemo.clear();
  transcriptTailMemo.clear();
  swarmManifestMemo.clear();
}

function findSwarmMembersPath(cascadeId) {
  if (!cascadeId) return '';
  const normId = String(cascadeId).trim().toLowerCase();
  if (!UUID_RE.test(normId)) return '';
  const dirs = Array.isArray(BRAIN_DIRS) && BRAIN_DIRS.length > 0 ? BRAIN_DIRS : [BRAIN_DIR];
  let bestPath = '';
  let bestMtime = -1;
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = join(dir, normId, '.system_generated', 'swarm', 'members.json');
    if (!existsSync(candidate)) continue;
    if (dirs.length === 1) return candidate;
    try {
      const mtime = Number(statSync(candidate)?.mtimeMs || 0);
      if (mtime > bestMtime) {
        bestMtime = mtime;
        bestPath = candidate;
      }
    } catch {
      if (!bestPath) bestPath = candidate;
    }
  }
  return bestPath;
}

/**
 * 按会话 ID 精确读取本地 `brain/<cascadeId>/.system_generated/swarm/members.json` 蜂群花名册（O(1) 定点读取 + `mtimeMs + size` 缓存）。
 *
 * @param {string} cascadeId
 * @returns {{
 *   title: string,
 *   coordinator: object|null,
 *   membersByCid: Map<string, object>,
 *   membersByName: Map<string, object>,
 *   workerRefs: Array<object>
 * } | null}
 */
export function readSwarmManifestForCascade(cascadeId) {
  if (!cascadeId) return null;
  const normId = String(cascadeId).trim().toLowerCase();
  if (!UUID_RE.test(normId)) return null;
  const membersPath = findSwarmMembersPath(normId);
  if (!membersPath) {
    swarmManifestMemo.delete(normId);
    return null;
  }
  try {
    const st = statSync(membersPath);
    const mtimeMs = Number(st?.mtimeMs || 0);
    const size = Number(st?.size || 0);
    const cached = swarmManifestMemo.get(normId);
    if (
      cached &&
      cached.path === membersPath &&
      cached.mtimeMs === mtimeMs &&
      cached.size === size &&
      size > 0
    ) {
      return cached.manifest;
    }
    const raw = readFileSync(membersPath, 'utf8');
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return null;

    const title = String(parsed.title || '').trim();
    const rawMembers = parsed.members && typeof parsed.members === 'object' ? parsed.members : {};
    const membersByCid = new Map();
    const membersByName = new Map();
    const workerRefs = [];
    let coordinator = null;

    for (const [rawKey, m] of Object.entries(rawMembers)) {
      if (!m || typeof m !== 'object') continue;
      const memberName = String(m.name || rawKey || '').replace(/^@+/, '').trim();
      const cid = String(m.conversation_id || m.conversationId || '').trim().toLowerCase();
      if (!cid || !UUID_RE.test(cid)) continue;
      const role = String(m.role || '').trim().toLowerCase();
      const wakeMode = String(m.wake_mode || m.wakeMode || '').trim().toLowerCase();
      const killed = Boolean(m.killed);
      const workspaceMode = String(m.workspace_mode || m.workspaceMode || 'inherit').trim();
      const model = String(m.applied_model || m.model || m.desired_model || '').trim();
      const entry = {
        memberName,
        conversationId: cid,
        role,
        wakeMode,
        killed,
        workspaceMode,
        model,
      };
      membersByCid.set(cid, entry);
      if (memberName) {
        membersByName.set(memberName.toLowerCase(), entry);
      }
      if (role === 'coordinator' || cid === normId) {
        coordinator = entry;
      } else {
        workerRefs.push({
          cascadeId: cid,
          role: memberName ? `Swarm Worker (${memberName})` : 'Swarm Worker',
          typeName: 'worker',
          memberName,
          createdTimeMs: 0,
          spawnOrder: null,
        });
      }
    }

    const manifest = { title, coordinator, membersByCid, membersByName, workerRefs };
    if (swarmManifestMemo.size >= MAX_TRANSCRIPT_MEMO_ENTRIES && !swarmManifestMemo.has(normId)) {
      const oldestKey = swarmManifestMemo.keys().next().value;
      if (oldestKey !== undefined) swarmManifestMemo.delete(oldestKey);
    }
    swarmManifestMemo.set(normId, { path: membersPath, mtimeMs, size, manifest });
    return manifest;
  } catch {
    return null;
  }
}

function findTranscriptPath(cascadeId) {
  if (!cascadeId) return '';
  const normId = String(cascadeId).trim().toLowerCase();
  if (!UUID_RE.test(normId)) return '';
  const dirs = Array.isArray(BRAIN_DIRS) && BRAIN_DIRS.length > 0 ? BRAIN_DIRS : [BRAIN_DIR];
  let bestPath = '';
  let bestMtime = -1;
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = join(dir, normId, '.system_generated', 'logs', 'transcript.jsonl');
    if (!existsSync(candidate)) continue;
    if (dirs.length === 1) return candidate;
    try {
      const mtime = Number(statSync(candidate)?.mtimeMs || 0);
      if (mtime > bestMtime) {
        bestMtime = mtime;
        bestPath = candidate;
      }
    } catch {
      if (!bestPath) bestPath = candidate;
    }
  }
  return bestPath;
}

function inferConversationAppSource(diskFiles = [], extMatch = null) {
  if (extMatch?.appSource && extMatch.appSource !== 'standalone') {
    return extMatch.appSource;
  }
  for (const filePath of Array.isArray(diskFiles) ? diskFiles : []) {
    const s = String(filePath || '');
    if (/[\\/]antigravity-cli(?:[\\/]|$)/i.test(s)) return 'cli';
    if (/[\\/]antigravity-ide(?:[\\/]|$)/i.test(s)) return 'ide';
  }
  return '';
}

function extractOfflineUserTitle(rawContent) {
  if (typeof rawContent !== 'string' || !rawContent.trim()) return '';
  const withoutSummary = rawContent
    .replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, '')
    .replace(/<SYSTEM_MESSAGE>[\s\S]*$/i, '');
  const reqMatches = [...withoutSummary.matchAll(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/gi)];
  const body =
    reqMatches.length > 0
      ? reqMatches[reqMatches.length - 1][1]
      : withoutSummary.replace(/<ADDITIONAL_METADATA>[\s\S]*$/i, '');
  const firstLine = String(body || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .find(Boolean);
  if (!firstLine) return '';
  return firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine;
}

function hasLocalSqliteDb(diskFiles = []) {
  return Array.isArray(diskFiles) && diskFiles.some((f) => /\.db$/i.test(String(f || '')));
}

function resolveBestSqliteDbInfo(diskFiles = []) {
  if (!Array.isArray(diskFiles) || diskFiles.length === 0) return null;
  let best = null;
  for (const rawPath of diskFiles) {
    const p = String(rawPath || '').trim();
    if (!/\.db$/i.test(p)) continue;
    const fullPath = /[\\/]|^[a-zA-Z]:/.test(p) ? p : join(CONVERSATIONS_DIR, p);
    const walInfo = computeSqliteWalSig(fullPath);
    if (!walInfo.exists) continue;
    if (!best || walInfo.mtimeMs > best.mtimeMs) {
      best = {
        dbPath: fullPath,
        mtimeMs: walInfo.mtimeMs,
        sig: walInfo.sig,
      };
    }
  }
  return best;
}

function findBestSqliteDbPath(diskFiles = []) {
  return resolveBestSqliteDbInfo(diskFiles)?.dbPath || '';
}

function inferAppSourceFromSummary(sourceEnum = '', diskFiles = [], fallback = '') {
  const fromDisk = inferConversationAppSource(diskFiles, null);
  if (fromDisk) return fromDisk;
  const src = String(sourceEnum || '').toUpperCase();
  if (src.includes('CLI')) return 'cli';
  if (src.includes('VSCODE') || src.includes('JETBOX') || src.includes('VISUAL_STUDIO')) {
    return 'ide';
  }
  return fallback || 'standalone';
}

function enrichSqliteStepsFromTranscriptIfNeeded(cidLower, sqliteSteps) {
  if (!cidLower || !Array.isArray(sqliteSteps) || sqliteSteps.length === 0) {
    return { firstUserTitle: '' };
  }
  const needsTranscriptBackfill = sqliteSteps.some(
    (s) =>
      (s?.type === 'CORTEX_STEP_TYPE_USER_INPUT' && !s.userInput) ||
      (s?.type === 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE' && !s.content && !s.systemMessage) ||
      (s?.metadata?.modelUsage && !s.metadata.modelUsage.model)
  );
  if (!needsTranscriptBackfill) {
    return { firstUserTitle: '' };
  }
  const transcriptPath = findTranscriptPath(cidLower);
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return { firstUserTitle: '' };
  }
  let raw = '';
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return { firstUserTitle: '' };
  }
  if (typeof raw !== 'string' || !raw.trim()) {
    return { firstUserTitle: '' };
  }

  let firstUserTitle = '';
  const byStepIdx = new Map();
  let lineOrdinal = 0;
  for (const rawLine of raw.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object') continue;
      const idx = Number.isFinite(Number(parsed.step_index))
        ? Number(parsed.step_index)
        : lineOrdinal;
      lineOrdinal += 1;
      byStepIdx.set(idx, parsed);
      const upperType = String(parsed.type || '').trim().toUpperCase();
      if (
        !firstUserTitle &&
        (upperType === 'USER_INPUT' ||
          upperType === 'CORTEX_STEP_TYPE_USER_INPUT' ||
          (parsed.userInput && typeof parsed.userInput === 'object'))
      ) {
        firstUserTitle = extractOfflineUserTitle(
          typeof parsed.content === 'string'
            ? parsed.content
            : parsed.userInput?.userResponse || ''
        );
      }
    } catch {
      // 忽略损坏 JSON 行
    }
  }

  let maxSqliteIdx = -1;
  for (const sq of sqliteSteps) {
    const sIdx = Number(sq?.metadata?.sourceTrajectoryStepInfo?.stepIndex ?? sq?.idx);
    if (Number.isFinite(sIdx) && sIdx > maxSqliteIdx) maxSqliteIdx = sIdx;
    const tLine = byStepIdx.get(sIdx);
    if (!tLine) continue;
    if (sq.type === 'CORTEX_STEP_TYPE_USER_INPUT' && !sq.userInput) {
      if (typeof tLine.content === 'string') sq.content = tLine.content;
      if (tLine.userInput) sq.userInput = tLine.userInput;
      if (Array.isArray(tLine.media)) sq.media = tLine.media;
    } else if (
      sq.type === 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE' &&
      !sq.content &&
      typeof tLine.content === 'string'
    ) {
      sq.content = tLine.content;
    } else if (sq.metadata?.modelUsage && !sq.metadata.modelUsage.model) {
      const fallbackModel = String(tLine.model || tLine.generator_model || '').trim();
      if (fallbackModel) sq.metadata.modelUsage.model = fallbackModel;
    }
  }

  return { firstUserTitle };
}

function filterClonedTrajectorySteps(rawSteps, generatorMeta, targetCidLower) {
  if (!targetCidLower) {
    return { steps: rawSteps || [], generatorMeta: generatorMeta || [] };
  }
  const filteredSteps = (rawSteps || []).filter((s) => {
    const originCid = String(s?.metadata?.sourceTrajectoryStepInfo?.cascadeId || '')
      .trim()
      .toLowerCase();
    return !originCid || originCid === targetCidLower;
  });
  const filteredGen = (generatorMeta || []).filter((gm) => {
    const gmCid = String(gm?.chatModel?.customMetadata?.cascade_id || '')
      .trim()
      .toLowerCase();
    return !gmCid || gmCid === targetCidLower;
  });
  return { steps: filteredSteps, generatorMeta: filteredGen };
}

/**
 * 当 Language Server RPC 离线或跨端不可达（如 `agy` CLI 独立会话目录）时，优先融合本地 SQLite
 * (`conversations/<id>.db` + `conversation_summaries.db` + `annotations/<id>.pbtxt`) 与 `transcript.jsonl`
 * （及可选 `.deep_stats_cache.json`）恢复完整步骤耗时、TTFT、思考/正文拆分、10 通道上下文构成与真实标题。
 */
function loadOfflineTranscriptConversation(conv, diskFiles, externalByLower, localSummary = null) {
  const cidLower = String(conv?.cascadeId || '').trim().toLowerCase();
  if (!cidLower) return null;
  const extMatch = externalByLower?.get(cidLower) || null;
  const sqliteDbPath = findBestSqliteDbPath(diskFiles);
  const sqliteTraj = sqliteDbPath ? readLocalSqliteTrajectory(sqliteDbPath) : null;
  const transcriptPath = findTranscriptPath(cidLower);

  const transcriptLines = [];
  if (transcriptPath && existsSync(transcriptPath)) {
    try {
      const raw = readFileSync(transcriptPath, 'utf8');
      if (typeof raw === 'string' && raw.trim()) {
        for (const line of raw.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object') {
              transcriptLines.push(parsed);
            }
          } catch {
            // 忽略尾部半行或损坏 JSON 行
          }
        }
      }
    } catch {
      // 忽略文件读取失败
    }
  }

  if (!sqliteTraj && transcriptLines.length === 0 && !extMatch) {
    return null;
  }

  let firstUserTitle = '';
  const transcriptByStepIdx = new Map();
  for (let rawIdx = 0; rawIdx < transcriptLines.length; rawIdx++) {
    const line = transcriptLines[rawIdx];
    const sIdx = Number.isFinite(Number(line.step_index)) ? Number(line.step_index) : rawIdx;
    transcriptByStepIdx.set(sIdx, line);
    const upperType = String(line.type || '').trim().toUpperCase();
    if (
      !firstUserTitle &&
      (upperType === 'USER_INPUT' ||
        upperType === 'CORTEX_STEP_TYPE_USER_INPUT' ||
        (line.userInput && typeof line.userInput === 'object'))
    ) {
      firstUserTitle = extractOfflineUserTitle(
        typeof line.content === 'string' ? line.content : line.userInput?.userResponse || ''
      );
    }
  }

  let steps = [];
  let fromSqlite = false;

  if (sqliteTraj && sqliteTraj.steps.length > 0) {
    fromSqlite = true;
    const sqliteRawSteps = [];
    let maxSqliteStepIdx = -1;
    let modelOrdinal = 0;

    for (const sq of sqliteTraj.steps) {
      const sIdx = Number(sq.metadata?.sourceTrajectoryStepInfo?.stepIndex ?? sq.idx);
      if (Number.isFinite(sIdx) && sIdx > maxSqliteStepIdx) {
        maxSqliteStepIdx = sIdx;
      }
      const tLine = transcriptByStepIdx.get(sIdx) || null;
      if (sq.type === 'CORTEX_STEP_TYPE_USER_INPUT') {
        sqliteRawSteps.push({
          type: sq.type,
          status: sq.status,
          ...(typeof tLine?.content === 'string' ? { content: tLine.content } : {}),
          ...(tLine?.userInput ? { userInput: tLine.userInput } : {}),
          ...(Array.isArray(tLine?.media) ? { media: tLine.media } : {}),
          metadata: sq.metadata,
        });
        continue;
      }
      if (sq.type === 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE') {
        const sysText =
          typeof sq.content === 'string' && sq.content
            ? sq.content
            : typeof tLine?.content === 'string'
              ? tLine.content
              : '';
        if (sysText) {
          sqliteRawSteps.push({
            type: sq.type,
            status: sq.status,
            content: sysText,
            metadata: sq.metadata,
          });
        }
        continue;
      }
      if (sq.type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE') {
        sqliteRawSteps.push({
          type: sq.type,
          status: sq.status,
          ...(sq.errorMessage ? { errorMessage: sq.errorMessage } : {}),
          ...(typeof tLine?.error === 'string' && tLine.error ? { error: tLine.error } : {}),
          ...(typeof tLine?.content === 'string' && tLine.content ? { content: tLine.content } : {}),
          metadata: sq.metadata,
        });
        continue;
      }

      const rawUsage = sq.metadata?.modelUsage || sq.metadata?.retryInfos?.[0]?.usage;
      if (rawUsage) {
        const deepStep = extMatch?.steps?.[modelOrdinal] || null;
        modelOrdinal += 1;
        const mu = { ...rawUsage };
        if (!mu.model) {
          const fallbackModel = String(
            tLine?.model || tLine?.generator_model || deepStep?.modelKey || ''
          ).trim();
          if (fallbackModel) mu.model = fallbackModel;
        }
        if (!mu.responseModel && (tLine?.response_model || deepStep?.responseModel)) {
          mu.responseModel = String(tLine?.response_model || deepStep?.responseModel).trim();
        }
        sqliteRawSteps.push({
          type: sq.type,
          status: sq.status,
          plannerResponse: {
            response: typeof tLine?.content === 'string' ? tLine.content : '',
            thinking: typeof tLine?.thinking === 'string' ? tLine.thinking : '',
            toolCalls: Array.isArray(tLine?.tool_calls) ? tLine.tool_calls : [],
          },
          metadata: {
            ...sq.metadata,
            modelUsage: mu,
          },
        });
      }
    }

    // 补充可能已刷入 transcript.jsonl 但尚未刷入 SQLite 的尾部步骤
    for (const [sIdx, line] of transcriptByStepIdx.entries()) {
      if (sIdx <= maxSqliteStepIdx) continue;
      const upperType = String(line.type || '').trim().toUpperCase();
      if (
        upperType === 'USER_INPUT' ||
        upperType === 'CORTEX_STEP_TYPE_USER_INPUT' ||
        (line.userInput && typeof line.userInput === 'object') ||
        upperType === 'SYSTEM_MESSAGE' ||
        upperType === 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE' ||
        upperType === 'ERROR_MESSAGE' ||
        upperType === 'CORTEX_STEP_TYPE_ERROR_MESSAGE'
      ) {
        sqliteRawSteps.push(line);
      } else if (
        line.input_tokens !== undefined ||
        line.cache_read_tokens !== undefined ||
        line.output_tokens !== undefined
      ) {
        const tailStatus = String(line.status || '').trim().toUpperCase();
        sqliteRawSteps.push({
          type:
            upperType === 'CHECKPOINT' || upperType === 'CORTEX_STEP_TYPE_CHECKPOINT'
              ? 'CORTEX_STEP_TYPE_CHECKPOINT'
              : String(line.type || 'PLANNER_RESPONSE'),
          status: /CANCEL/.test(tailStatus)
            ? 'CORTEX_STEP_STATUS_CANCELED'
            : /ERROR/.test(tailStatus)
              ? 'CORTEX_STEP_STATUS_ERROR'
              : /INTERRUPT/.test(tailStatus)
                ? 'CORTEX_STEP_STATUS_INTERRUPTED'
                : 'CORTEX_STEP_STATUS_DONE',
          plannerResponse: {
            response: typeof line.content === 'string' ? line.content : '',
            thinking: typeof line.thinking === 'string' ? line.thinking : '',
            toolCalls: Array.isArray(line.tool_calls) ? line.tool_calls : [],
          },
          metadata: {
            createdAt: String(line.created_at || line.createdAt || ''),
            sourceTrajectoryStepInfo: { stepIndex: sIdx },
            modelUsage: {
              model: String(line.model || line.generator_model || 'unknown').trim() || 'unknown',
              inputTokens: line.input_tokens ?? 0,
              cacheReadTokens: line.cache_read_tokens ?? 0,
              outputTokens: line.output_tokens ?? 0,
            },
          },
        });
      }
    }

    steps = extractModelSteps(sqliteRawSteps, sqliteTraj.generatorMetadata || []);
  }

  if (steps.length === 0 && transcriptLines.length > 0) {
    const syntheticSteps = [];
    let modelOrdinal = 0;

    for (let rawIdx = 0; rawIdx < transcriptLines.length; rawIdx++) {
      const line = transcriptLines[rawIdx];
      const rawType = String(line.type || '').trim();
      const upperType = rawType.toUpperCase();
      if (
        upperType === 'USER_INPUT' ||
        upperType === 'CORTEX_STEP_TYPE_USER_INPUT' ||
        (line.userInput && typeof line.userInput === 'object') ||
        upperType === 'SYSTEM_MESSAGE' ||
        upperType === 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE' ||
        upperType === 'ERROR_MESSAGE' ||
        upperType === 'CORTEX_STEP_TYPE_ERROR_MESSAGE'
      ) {
        syntheticSteps.push(line);
        continue;
      }

      if (line.metadata?.modelUsage) {
        syntheticSteps.push(line);
        modelOrdinal += 1;
        continue;
      }

      const hasTokenCounts =
        line.input_tokens !== undefined ||
        line.cache_read_tokens !== undefined ||
        line.output_tokens !== undefined;
      if (!hasTokenCounts) continue;

      const deepStep = extMatch?.steps?.[modelOrdinal] || null;
      modelOrdinal += 1;
      const isCheckpoint =
        upperType === 'CHECKPOINT' || upperType === 'CORTEX_STEP_TYPE_CHECKPOINT';
      const rawStatus = String(line.status || '').trim().toUpperCase();
      const mappedStatus = /CANCEL/.test(rawStatus)
        ? 'CORTEX_STEP_STATUS_CANCELED'
        : /ERROR/.test(rawStatus)
          ? 'CORTEX_STEP_STATUS_ERROR'
          : /INTERRUPT/.test(rawStatus)
            ? 'CORTEX_STEP_STATUS_INTERRUPTED'
            : 'CORTEX_STEP_STATUS_DONE';
      const finishedAt = String(
        line.finished_generating_at ||
          line.finishedGeneratingAt ||
          line.completed_at ||
          line.completedAt ||
          ''
      ).trim();
      const modelKey =
        String(line.model || line.generator_model || deepStep?.modelKey || 'unknown').trim() ||
        'unknown';
      const responseModel = String(line.response_model || deepStep?.responseModel || '').trim();
      const apiProvider = String(line.api_provider || deepStep?.apiProvider || '').trim();
      const modelDisplayName = String(
        line.model_display_name || deepStep?.modelDisplayName || ''
      ).trim();
      const thinkingTokens = Number(line.thinking_tokens ?? deepStep?.thinkingTokens ?? 0) || 0;
      const responseTokens = line.response_tokens ?? deepStep?.responseTokens;

      syntheticSteps.push({
        type: isCheckpoint ? 'CORTEX_STEP_TYPE_CHECKPOINT' : rawType || 'PLANNER_RESPONSE',
        status: mappedStatus,
        plannerResponse: {
          response: typeof line.content === 'string' ? line.content : '',
          thinking: typeof line.thinking === 'string' ? line.thinking : '',
          toolCalls: Array.isArray(line.tool_calls) ? line.tool_calls : [],
          ...(thinkingTokens > 0 ? { thinkingTokens } : {}),
          ...(responseTokens !== undefined ? { responseTokens } : {}),
        },
        metadata: {
          createdAt: String(line.created_at || line.createdAt || deepStep?.createdAt || ''),
          ...(finishedAt ? { finishedGeneratingAt: finishedAt } : {}),
          sourceTrajectoryStepInfo: {
            stepIndex: Number.isFinite(Number(line.step_index)) ? Number(line.step_index) : rawIdx,
          },
          modelUsage: {
            model: modelKey,
            ...(responseModel ? { responseModel } : {}),
            ...(apiProvider ? { apiProvider } : {}),
            inputTokens: line.input_tokens ?? deepStep?.inputTokens ?? 0,
            cacheReadTokens: line.cache_read_tokens ?? deepStep?.cacheReadTokens ?? 0,
            outputTokens: line.output_tokens ?? deepStep?.outputTokens ?? 0,
            ...(thinkingTokens > 0 ? { thinkingOutputTokens: thinkingTokens } : {}),
            ...(responseTokens !== undefined ? { responseOutputTokens: responseTokens } : {}),
          },
          ...(modelDisplayName
            ? { generatorMetadata: [{ chatModel: { modelDisplayName } }] }
            : {}),
        },
      });
    }

    steps = syntheticSteps.length > 0 ? extractModelSteps(syntheticSteps, []) : [];
  }

  if (steps.length === 0 && Array.isArray(extMatch?.steps) && extMatch.steps.length > 0) {
    const extSynthetic = extMatch.steps.map((ds, idx) => ({
      type: 'PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      plannerResponse: {
        ...(ds.thinkingTokens > 0 ? { thinkingTokens: ds.thinkingTokens } : {}),
        ...(ds.responseTokens !== undefined ? { responseTokens: ds.responseTokens } : {}),
      },
      metadata: {
        createdAt: ds.createdAt || '',
        sourceTrajectoryStepInfo: { stepIndex: ds.stepIndex ?? idx + 1 },
        modelUsage: {
          model: ds.modelKey || 'unknown',
          ...(ds.responseModel ? { responseModel: ds.responseModel } : {}),
          ...(ds.apiProvider ? { apiProvider: ds.apiProvider } : {}),
          inputTokens: ds.inputTokens || 0,
          cacheReadTokens: ds.cacheReadTokens || 0,
          outputTokens: ds.outputTokens || 0,
          ...(ds.thinkingTokens > 0 ? { thinkingOutputTokens: ds.thinkingTokens } : {}),
          ...(ds.responseTokens !== undefined
            ? { responseOutputTokens: ds.responseTokens }
            : {}),
        },
        ...(ds.modelDisplayName
          ? { generatorMetadata: [{ chatModel: { modelDisplayName: ds.modelDisplayName } }] }
          : {}),
      },
    }));
    steps = extractModelSteps(extSynthetic, []);
  }

  const defaultShortId = cidLower.slice(0, 8);
  const nonShortTitle = (t) => {
    const clean = String(t || '').trim();
    return clean && clean.toLowerCase() !== defaultShortId ? clean : '';
  };
  const annotationTitle = nonShortTitle(readAnnotationTitleForCascade(cidLower));
  const summaryTitle = nonShortTitle(localSummary?.title);
  const currentTitle = nonShortTitle(conv.title);
  const extTitle = nonShortTitle(extMatch?.title);
  const resolvedTitle =
    annotationTitle ||
    summaryTitle ||
    currentTitle ||
    extTitle ||
    firstUserTitle ||
    String(conv.title || '').trim() ||
    conv.cascadeId.slice(0, 8);

  const parentConversationId = String(
    localSummary?.parentConversationId ||
      sqliteTraj?.parentConversationId ||
      conv.parentConversationId ||
      ''
  )
    .trim()
    .toLowerCase();
  const rawRootCid = String(sqliteTraj?.rootConversationId || conv.rootConversationId || '')
    .trim()
    .toLowerCase();
  const rootConversationId =
    rawRootCid && rawRootCid !== cidLower ? rawRootCid : parentConversationId;

  const lastStepMs = steps[steps.length - 1]?.createdAtMs || 0;
  return {
    steps,
    fromSqlite,
    title: resolvedTitle,
    accountName: extMatch?.accountName || '',
    appSource: inferConversationAppSource(diskFiles, extMatch),
    parentConversationId,
    rootConversationId,
    lastModifiedMs: Math.max(
      conv.lastModifiedMs || 0,
      localSummary?.lastModifiedMs || 0,
      extMatch?.lastModifiedMs || 0,
      lastStepMs
    ),
    subagentRefs: [],
  };
}

/**
 * 读取指定会话在本地 `brain/<cascadeId>/.system_generated/logs/transcript.jsonl` 的尾部步骤。
 * 采用 `mtimeMs + size` 签名缓存与尾部 96KB 定长切片读取，避免长会话大文件全量读取阻塞事件循环。
 *
 * @param {string} cascadeId
 * @param {number} [maxLines=24]
 * @returns {object[]}
 */
function readTranscriptTailSteps(cascadeId, maxLines = 24) {
  if (!cascadeId) return [];
  const normId = String(cascadeId).trim().toLowerCase();
  if (!UUID_RE.test(normId)) return [];
  const transcriptPath = findTranscriptPath(normId);
  if (!transcriptPath) return [];
  try {
    const st = statSync(transcriptPath);
    const mtimeMs = Number(st?.mtimeMs || 0);
    const size = Number(st?.size || 0);
    const cached = transcriptTailMemo.get(normId);
    if (
      cached &&
      cached.path === transcriptPath &&
      cached.mtimeMs === mtimeMs &&
      cached.size === size &&
      size > 0
    ) {
      return cached.steps;
    }

    let raw = '';
    if (
      size > TRANSCRIPT_TAIL_MAX_BYTES &&
      typeof openSync === 'function' &&
      typeof readSync === 'function' &&
      typeof closeSync === 'function'
    ) {
      const fd = openSync(transcriptPath, 'r');
      try {
        const buf = Buffer.allocUnsafe(TRANSCRIPT_TAIL_MAX_BYTES);
        const bytesRead = readSync(
          fd,
          buf,
          0,
          TRANSCRIPT_TAIL_MAX_BYTES,
          size - TRANSCRIPT_TAIL_MAX_BYTES
        );
        raw = buf.toString('utf8', 0, bytesRead);
        const trimmedRaw = raw.replace(/[\r\n]+$/, '');
        const firstNewline = trimmedRaw.indexOf('\n');
        if (firstNewline >= 0 && !trimmedRaw.trimStart().startsWith('{')) {
          raw = trimmedRaw.slice(firstNewline + 1);
        } else {
          raw = trimmedRaw;
        }
      } finally {
        try {
          closeSync(fd);
        } catch {
          // 忽略关闭异常
        }
      }
    } else {
      raw = readFileSync(transcriptPath, 'utf8');
    }

    if (typeof raw !== 'string' || !raw.trim()) {
      transcriptTailMemo.set(normId, { path: transcriptPath, mtimeMs, size, steps: [] });
      return [];
    }
    const lines = raw.trim().split(/\r?\n/);
    const tail = lines.slice(-maxLines);
    const steps = [];
    for (const line of tail) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
          steps.push(parsed);
        }
      } catch {
        // 忽略头部被截断或末尾正在写入的半行 JSON
      }
    }
    if (transcriptTailMemo.size >= MAX_TRANSCRIPT_MEMO_ENTRIES && !transcriptTailMemo.has(normId)) {
      const oldestKey = transcriptTailMemo.keys().next().value;
      if (oldestKey !== undefined) transcriptTailMemo.delete(oldestKey);
    }
    transcriptTailMemo.set(normId, { path: transcriptPath, mtimeMs, size, steps });
    return steps;
  } catch {
    return [];
  }
}

function scoreLiveActivitySpecificity(act) {
  if (!act || typeof act !== 'object') return 0;
  const sig = String(act.signature || '');
  if (sig.startsWith('compacting:') || sig.startsWith('compacting-done:')) {
    return 5;
  }
  if (
    sig.startsWith('planner-tool:') ||
    sig.startsWith('step-run:') ||
    sig.startsWith('pending-tool:')
  ) {
    return 4;
  }
  if (
    sig.startsWith('responding:') ||
    sig.startsWith('thinking:') ||
    sig.startsWith('responding-done:') ||
    sig.startsWith('thinking-done:')
  ) {
    return 3;
  }
  if (
    sig.startsWith('post-tool-think:') ||
    sig.startsWith('post-step-tool:')
  ) {
    return 2;
  }
  return 1;
}

function resolveBestLiveActivity(
  cascadeId,
  rpcRawSteps,
  isRunning,
  fallbackMs,
  { isRemote = false, liveActivityMemoMap = liveActivityMemo } = {}
) {
  if (!isRunning) return null;
  const hasRpcSteps = Array.isArray(rpcRawSteps) && rpcRawSteps.length > 0;
  const rpcAct = hasRpcSteps ? extractLiveActivity(rpcRawSteps, true, fallbackMs) : null;
  const transcriptSteps = isRemote ? [] : readTranscriptTailSteps(cascadeId);
  const transcriptAct =
    transcriptSteps.length > 0 ? extractLiveActivity(transcriptSteps, true, fallbackMs) : null;

  if (rpcAct && transcriptAct) {
    // 1. 先按真实 Cortex 步骤序号对齐比较：尚未刷入 transcript.jsonl 的新步骤（如正在进行的 CHECKPOINT 压缩或流式回复）优先采用 RPC
    const rpcStepIdx = getMaxMeaningfulStepIndex(rpcRawSteps);
    const transStepIdx = getMaxMeaningfulStepIndex(transcriptSteps);
    if (rpcStepIdx >= 0 && transStepIdx >= 0 && rpcStepIdx !== transStepIdx) {
      return rpcStepIdx > transStepIdx ? rpcAct : transcriptAct;
    }

    // 2. 同一步骤序号下优先采用语义更明确的状态（上下文压缩 > 工具执行 > 流式生成 > 工具后置思考）
    const rpcScore = scoreLiveActivitySpecificity(rpcAct);
    const transScore = scoreLiveActivitySpecificity(transcriptAct);
    if (rpcScore !== transScore) {
      return rpcScore > transScore ? rpcAct : transcriptAct;
    }

    // 3. 同一步骤且均为压缩态时，优先采用携带精确完成时刻的 RPC 状态；常规步骤则优先采用含完整参数的 transcript.jsonl
    const rpcMs = Number(rpcAct.startedAtMs || 0);
    const transMs = Number(transcriptAct.startedAtMs || 0);
    if (rpcAct.phase === 'compacting' && rpcMs !== transMs) {
      return rpcMs >= transMs ? rpcAct : transcriptAct;
    }
    return transcriptAct;
  }
  return (
    transcriptAct ||
    rpcAct ||
    liveActivityMemoMap.get(String(cascadeId || '').toLowerCase()) ||
    extractLiveActivity([], true, fallbackMs)
  );
}

/**
 * 清洗并裁剪 `subagentSpec`，仅保留 UI 与分组所需的 `typeName` 和 `role`，
 * 剔除体积较大的 `initialPrompt`，避免膨胀 `trajectory_usage_cache.json`。
 *
 * @param {object|null|undefined} rawSpec
 * @returns {{ typeName: string, role: string } | null}
 */
function sanitizeSubagentSpec(rawSpec) {
  if (!rawSpec || typeof rawSpec !== 'object') return null;
  const typeName = String(rawSpec.typeName || '').trim();
  const role = String(rawSpec.role || '').trim();
  if (!typeName && !role) return null;
  return { typeName, role };
}

/**
 * 按字段合并两个来源的 `subagentSpec`，避免仅含 `typeName` 的元数据覆盖掉父步骤中的 `role`。
 *
 * @param {object|null|undefined} primary
 * @param {object|null|undefined} secondary
 * @returns {{ typeName: string, role: string } | null}
 */
function mergeSubagentSpecs(primary, secondary) {
  const a = sanitizeSubagentSpec(primary);
  const b = sanitizeSubagentSpec(secondary);
  if (!a && !b) return null;
  return {
    typeName: a?.typeName || b?.typeName || '',
    role: a?.role || b?.role || '',
  };
}

/**
 * 从主/父会话的原始轨迹步骤 (`CORTEX_STEP_TYPE_INVOKE_SUBAGENT`) 中提取派生子代理列表。
 *
 * @param {object[]} [rawSteps=[]]
 * @returns {Array<{ cascadeId: string, role: string, typeName: string, createdTimeMs: number, spawnOrder: number }>}
 */
function extractSubagentRefsFromSteps(rawSteps = []) {
  const refsMap = new Map();
  let orderCounter = 0;
  for (const st of rawSteps || []) {
    const inv = st?.invokeSubagent;
    if (!inv) continue;
    let toolArgs = {};
    const argsJson = st?.metadata?.toolCall?.argumentsJson;
    if (typeof argsJson === 'string' && argsJson.trim()) {
      try {
        toolArgs = JSON.parse(argsJson);
      } catch {
        // 忽略非标准 JSON
      }
    }
    const subSpecs = Array.isArray(inv.subagents) ? inv.subagents : [];
    const results = Array.isArray(inv.results) ? inv.results : [];
    const createdTimeMs = parseIsoMs(st?.metadata?.createdAt) || 0;
    const count = Math.max(
      subSpecs.length,
      results.length,
      inv.conversationId || inv.subagentConversationId ? 1 : 0
    );
    for (let idx = 0; idx < count; idx++) {
      const resItem = results[idx] || {};
      const specItem = subSpecs[idx] || (subSpecs.length === 1 ? subSpecs[0] : {}) || {};
      const fallbackInvCid =
        idx === 0 || count === 1 ? inv.conversationId || inv.subagentConversationId || '' : '';
      const cid = String(
        resItem.conversationId ||
          resItem.subagentConversationId ||
          resItem.cascadeId ||
          specItem.conversationId ||
          specItem.subagentConversationId ||
          specItem.cascadeId ||
          fallbackInvCid
      )
        .trim()
        .toLowerCase();
      if (!cid) continue;
      const role = String(specItem.role || toolArgs.Role || toolArgs.role || '').trim();
      const typeName = String(
        specItem.typeName || toolArgs.TypeName || toolArgs.typeName || ''
      ).trim();
      const prev = refsMap.get(cid);
      refsMap.set(cid, {
        cascadeId: cid,
        role: role || prev?.role || '',
        typeName: typeName || prev?.typeName || '',
        createdTimeMs: createdTimeMs || prev?.createdTimeMs || 0,
        spawnOrder: prev ? prev.spawnOrder : orderCounter++,
      });
    }
  }
  return Array.from(refsMap.values());
}

/**
 * 从 `GetCascadeTrajectory` 响应的 `trajectory.metadata` 中提取子代理归属关系与角色元数据。
 *
 * @param {object} trajRes
 * @param {object} [fallback={}]
 */
function extractTrajectorySubagentMeta(trajRes, fallback = {}) {
  const meta =
    trajRes?.trajectory?.metadata ||
    trajRes?.trajectory?.trajectoryMetadata ||
    trajRes?.trajectoryMetadata ||
    {};
  const parentConversationId = String(
    meta.parentConversationId || fallback.parentConversationId || ''
  )
    .trim()
    .toLowerCase();
  const rootConversationId = String(
    meta.rootConversationId || fallback.rootConversationId || parentConversationId || ''
  )
    .trim()
    .toLowerCase();
  const subagentSpec = mergeSubagentSpecs(meta.subagentSpec, fallback.subagentSpec);
  const agentScriptName = String(
    meta.agentScript?.name || fallback.agentScriptName || ''
  ).trim();
  const createdTimeMs =
    parseIsoMs(meta.createdAt || meta.createdTime) || fallback.createdTimeMs || 0;
  return {
    parentConversationId,
    rootConversationId,
    subagentSpec,
    agentScriptName,
    createdTimeMs,
  };
}

/**
 * 枚举所有会话（合并 LS `trajectorySummaries`、本地磁盘文件与 `trajectoryCache`），
 * 选定当前活跃会话，并以最多 4 路并发增量同步更新了的会话轨迹。
 *
 * @param {{
 *   summariesObj?: Record<string, object>,
 *   currentAccountName?: string|null,
 *   requestedConvId?: string,
 *   forceRefresh?: boolean
 * }} params
 * @returns {Promise<{
 *   conversations: object[],
 *   activeConvSummary: object|null,
 *   activeCascadeId: string|null
 * }>}
 */
export async function enumerateAndSyncConversations({
  summariesObj = {},
  sideQuestionParents = {},
  summariesAvailable = false,
  currentAccountName = '',
  requestedConvId = '',
  forceRefresh = false,
  endpoint = null,
}) {
  const isRemote = Boolean(endpoint && endpoint.isRemote);
  const cacheStore = getEndpointCacheStore(endpoint);
  const getEntry = cacheStore.getCachedTrajectory;
  const setEntry = (id, entry) => {
    const dirs = diskStores.get(id.toLowerCase()) || getEntry(id)?.localStoreDirs;
    if (dirs) entry.localStoreDirs = dirs;
    cacheStore.setCachedTrajectory(id, entry);
  };
  const removeEntry = cacheStore.removeCachedTrajectory;
  const listEntries = cacheStore.listCachedTrajectoryEntries;
  const hasPendingSave = cacheStore.hasPendingTrajectoryCacheSave;
  const persistCacheIfNeeded = cacheStore.persistTrajectoryCacheIfNeeded;
  const activeCooldownMap = isRemote ? endpoint.failedFetchCooldownMap : failedFetchCooldownMap;
  const activeLiveActivityMemo = isRemote ? endpoint.liveActivityMemo : liveActivityMemo;
  const maxConcurrentRpc = isRemote ? 2 : MAX_CONCURRENT_RPC;

  const nowSweepMs = Date.now();
  if (forceRefresh) {
    activeCooldownMap.clear();
  } else {
    for (const [k, rec] of activeCooldownMap.entries()) {
      const failedAt = typeof rec === 'number' ? rec : rec?.failedAt || 0;
      const cooldownMs = typeof rec === 'number' ? FAILED_RPC_COOLDOWN_MS : rec?.cooldownMs || FAILED_RPC_COOLDOWN_MS;
      if (nowSweepMs - failedAt >= cooldownMs) {
        activeCooldownMap.delete(k);
      }
    }
  }

  let cacheDirty = hasPendingSave();
  const diskScan = isRemote ? null : discoverLocalConversationFiles();
  const diskConvMap = diskScan?.map || new Map();
  const diskStores = diskScan?.storeDirs || new Map();
  const hidden = new Set();
  const archived = id => !isRemote && Boolean(id) && !diskConvMap.has(id) &&
    !summariesByLower.has(id) && hasUsageHistory(id);
  const unavailable = id => hidden.has(id) || archived(id);

  // 构建大小写不敏感索引，将同一会话的不同大小写键合并至唯一规范键（优先保留 summariesObj 中的原始键以兼容 RPC）
  const mergedSideQuestionParents = { ...(sideQuestionParents || {}) };
  const canonicalIdByLower = new Map();
  const summariesByLower = new Map();
  for (const [rawId, summary] of Object.entries(summariesObj || {})) {
    const lower = String(rawId || '').trim().toLowerCase();
    if (!lower) continue;
    canonicalIdByLower.set(lower, rawId);
    summariesByLower.set(lower, summary);

    const sqIds = summary?.annotations?.sideQuestionCascadeIds;
    const sqTitles = summary?.annotations?.sideQuestionTitles || {};
    if (Array.isArray(sqIds)) {
      for (const sqId of sqIds) {
        const sqLower = String(sqId || '').trim().toLowerCase();
        if (!sqLower) continue;
        mergedSideQuestionParents[sqLower] = {
          parentConversationId: lower,
          title: String(sqTitles[sqLower] || mergedSideQuestionParents[sqLower]?.title || ''),
        };
      }
    }
    if (sqTitles && typeof sqTitles === 'object') {
      for (const [sqKey, sqTitle] of Object.entries(sqTitles)) {
        const sqLower = String(sqKey || '').trim().toLowerCase();
        if (!sqLower) continue;
        const prevSq = mergedSideQuestionParents[sqLower];
        mergedSideQuestionParents[sqLower] = {
          parentConversationId: prevSq?.parentConversationId || lower,
          title: String(sqTitle || prevSq?.title || ''),
        };
      }
    }
    const isSummarySideQ =
      Boolean(summary?.isSideQuestion) ||
      Number(summary?.trajectoryType) === 22 ||
      summary?.trajectoryType === 'CORTEX_TRAJECTORY_TYPE_SIDE_QUESTION';
    const forkParent = String(summary?.forkParentConversationId || '').trim().toLowerCase();
    if (isSummarySideQ && forkParent) {
      const prevSq = mergedSideQuestionParents[lower];
      mergedSideQuestionParents[lower] = {
        parentConversationId: prevSq?.parentConversationId || forkParent,
        title: String(prevSq?.title || summary?.annotations?.title || ''),
      };
    }
  }

  if (!isRemote) {
    for (const [key, entry] of listEntries()) {
      const id = key.toLowerCase();
      if (!UUID_RE.test(id)) continue;
      let dirs = diskStores.get(id);
      if (dirs && Array.isArray(entry.localStoreDirs)) {
        const inaccessible = entry.localStoreDirs.filter(dir => !diskScan.readable.has(dir));
        if (inaccessible.length) {
          dirs = [...new Set([...dirs, ...inaccessible])].sort();
          diskStores.set(id, dirs);
        }
      }
      if (dirs && !isDeepStrictEqual(entry.localStoreDirs, dirs)) {
        setEntry(key, { ...entry, localStoreDirs: dirs });
        cacheDirty = true;
      }

      if (dirs || summariesByLower.has(id)) {
        firstMissingAt.delete(id);
        continue;
      }
      const knownDirs = Array.isArray(entry.localStoreDirs) ? entry.localStoreDirs : [...diskScan.readable].filter(dir =>
        inferAppSourceFromSummary('', [dir]) === (entry.appSource || 'standalone'));
      const observedOnDisk = Boolean(entry.localStoreDirs?.length || entry.diskMtimeMs > 0 || entry.offlineSqliteTelemetry);
      const canConfirm = diskScan.complete && knownDirs.length && knownDirs.every(dir => diskScan.readable.has(dir)) &&
        currentAccountName !== null && (!entry.accountName || entry.accountName === currentAccountName);
      if (!canConfirm) {
        firstMissingAt.delete(id);
        continue;
      }
      if (!observedOnDisk && !summariesAvailable) continue;
      hidden.add(id);
      if (!observedOnDisk) continue;
      const since = firstMissingAt.get(id);
      if (since === undefined || since > nowSweepMs) firstMissingAt.set(id, nowSweepMs);
      else if (nowSweepMs - since >= MISSING_GRACE_MS) {
        archiveLocalTrajectory(key);
        firstMissingAt.delete(id);
        cacheDirty = true;
      }
    }
  }

  for (const [rawCacheKey] of listEntries()) {
    const lower = String(rawCacheKey || '').trim().toLowerCase();
    if (!lower || unavailable(lower)) continue;
    const existingCanon = canonicalIdByLower.get(lower);
    if (!existingCanon) {
      // 标准 UUID 统一收敛为小写键，避免大小写分裂产生双份条目
      const normalizedKey = UUID_RE.test(rawCacheKey) ? lower : rawCacheKey;
      if (normalizedKey !== rawCacheKey) {
        setEntry(normalizedKey, getEntry(rawCacheKey));
        removeEntry(rawCacheKey);
        cacheDirty = true;
      }
      canonicalIdByLower.set(lower, normalizedKey);
    } else if (existingCanon !== rawCacheKey) {
      const targetEntry = getEntry(existingCanon);
      const dupEntry = getEntry(rawCacheKey);
      if (!targetEntry || (dupEntry?.steps?.length || 0) > (targetEntry?.steps?.length || 0)) {
        setEntry(existingCanon, dupEntry);
      }
      removeEntry(rawCacheKey);
      cacheDirty = true;
    }
  }

  for (const diskLowerId of diskConvMap.keys()) {
    if (!canonicalIdByLower.has(diskLowerId)) {
      canonicalIdByLower.set(diskLowerId, diskLowerId);
    }
  }

  // 从所有本地缓存会话收集 subagentRefs，确保跨账号切换时历史会话与派生子代理均不丢失
  for (const [, entry] of listEntries()) {
    for (const ref of entry?.subagentRefs || []) {
      const refCid = String(ref?.cascadeId || '').trim().toLowerCase();
      if (refCid && !unavailable(refCid) && !canonicalIdByLower.has(refCid)) {
        canonicalIdByLower.set(refCid, refCid);
      }
    }
  }

  const localSummaryByLower = isRemote ? new Map() : readLocalSummaryIndex();
  const sqliteAvailable = isRemote ? false : hasBuiltinNodeSqlite();
  const STALE_LOCAL_RUNNING_MAX_AGE_MS = 10 * 60_000;
  const reqLower = String(requestedConvId || '').trim().toLowerCase();
  const rawConversations = [];
  for (const [cidLower, cascadeId] of canonicalIdByLower.entries()) {
    const item = summariesByLower.get(cidLower);
    const localSum = item ? null : localSummaryByLower.get(cidLower) || null;
    const cached = getEntry(cascadeId);
    const diskFiles = diskConvMap.get(cidLower) || [];
    const sqliteDbInfo = sqliteAvailable ? resolveBestSqliteDbInfo(diskFiles) : null;
    const dbPath = sqliteDbInfo?.dbPath || '';
    const diskFileSig = sqliteDbInfo?.sig || '';
    const lastModifiedTime = item?.lastModifiedTime || item?.createdTime || '';
    const summaryMtimeMs = parseIsoMs(lastModifiedTime);
    const rawDiskMtimeMs = summaryMtimeMs ? null : readConversationMtime(diskFiles);
    const diskMtimeMs = sqliteDbInfo
      ? Math.max(rawDiskMtimeMs || 0, sqliteDbInfo.mtimeMs || 0)
      : rawDiskMtimeMs;
    const appSource = isRemote
      ? 'ssh'
      : inferAppSourceFromSummary(
          item?.source || '',
          diskFiles,
          cached?.appSource || 'standalone'
        );

    const sqParentInfo = mergedSideQuestionParents[cidLower] || null;
    const isSideQuestion = Boolean(
      sqParentInfo ||
        item?.isSideQuestion ||
        Number(item?.trajectoryType) === 22 ||
        item?.trajectoryType === 'CORTEX_TRAJECTORY_TYPE_SIDE_QUESTION' ||
        localSum?.isSideQuestion ||
        Number(localSum?.trajectoryType) === 22 ||
        cached?.isSideQuestion ||
        cached?.subagentSpec?.typeName === 'side_question'
    );

    const rawMeta = item?.trajectoryMetadata || item?.metadata || {};
    const parentConversationId = String(
      rawMeta.parentConversationId ||
        sqParentInfo?.parentConversationId ||
        item?.forkParentConversationId ||
        localSum?.parentConversationId ||
        localSum?.forkParentConversationId ||
        cached?.parentConversationId ||
        cached?.parentCascadeId ||
        ''
    ).toLowerCase();
    const rawRootCid = String(
      rawMeta.rootConversationId || localSum?.rootConversationId || ''
    )
      .trim()
      .toLowerCase();
    const cachedRootCid = String(cached?.rootConversationId || '').trim().toLowerCase();
    const rootConversationId =
      (rawRootCid && rawRootCid !== cidLower ? rawRootCid : '') ||
      (cachedRootCid && cachedRootCid !== cidLower ? cachedRootCid : '') ||
      parentConversationId ||
      '';
    const localAgentSpec =
      parentConversationId && (localSum?.subagentSpec || localSum?.agentName)
        ? localSum.subagentSpec || { role: localSum.agentName }
        : null;
    const primarySpec = isSideQuestion
      ? {
          typeName: 'side_question',
          role: String(sqParentInfo?.title || item?.annotations?.title || localSum?.title || '').trim(),
        }
      : rawMeta.subagentSpec;
    const subagentSpec = mergeSubagentSpecs(
      primarySpec,
      mergeSubagentSpecs(localAgentSpec, cached?.subagentSpec)
    );
    const agentScriptName = rawMeta.agentScript?.name || cached?.agentScriptName || '';
    const createdTimeMs =
      parseIsoMs(item?.createdTime || rawMeta?.createdAt || localSum?.createdTime) ||
      cached?.createdTimeMs ||
      0;
    const spawnOrder = Number.isFinite(cached?.spawnOrder) ? cached.spawnOrder : null;
    const subagentRefs = Array.isArray(cached?.subagentRefs) ? cached.subagentRefs : null;
    const isSubagent =
      isSideQuestion ||
      Boolean(cached?.isSubagent) ||
      Boolean(parentConversationId) ||
      Boolean(rootConversationId && rootConversationId !== cidLower);
    const isKilled = Boolean(item?.killed || localSum?.killed);
    const latestLocalTouchMs = Math.max(diskMtimeMs || 0, localSum?.lastModifiedMs || 0);
    const localStatus =
      !isKilled &&
      localSum?.status === 'CASCADE_RUN_STATUS_RUNNING' &&
      latestLocalTouchMs > 0 &&
      nowSweepMs - latestLocalTouchMs <= STALE_LOCAL_RUNNING_MAX_AGE_MS
        ? 'CASCADE_RUN_STATUS_RUNNING'
        : 'IDLE';

    if (item) {
      const lastModifiedMs =
        summaryMtimeMs || diskMtimeMs || cached?.lastModifiedMs || 0;
      const rawSummaryStepCount = Number(item?.stepCount || 0);
      const modelStepCount = Array.isArray(cached?.steps)
        ? cached.steps.length
        : isSideQuestion
          ? 0
          : rawSummaryStepCount;
      rawConversations.push({
        cascadeId,
        title:
          sqParentInfo?.title ||
          item?.annotations?.title ||
          item?.summary ||
          cached?.title ||
          (isSideQuestion ? '旁路提问' : cascadeId.slice(0, 8)),
        stepCount: modelStepCount,
        rawStepCount: rawSummaryStepCount,
        status: isKilled ? 'IDLE' : item?.status || '',
        killed: isKilled,
        lastModifiedTime,
        lastModifiedMs,
        diskMtimeMs,
        dbPath,
        diskFileSig,
        appSource,
        inSummaries: true,
        isSubagent,
        isSideQuestion,
        parentConversationId,
        rootConversationId,
        subagentSpec,
        agentScriptName,
        createdTimeMs,
        spawnOrder,
        subagentRefs,
      });
    } else if (cached) {
      const lastStepMs = cached.steps?.[cached.steps.length - 1]?.createdAtMs || 0;
      const cachedStepCount = Number(cached.steps?.length || 0);
      rawConversations.push({
        cascadeId,
        title:
          sqParentInfo?.title ||
          localSum?.title ||
          cached.title ||
          (isSideQuestion ? '旁路提问' : cascadeId.slice(0, 8)),
        stepCount: cachedStepCount,
        rawStepCount: localSum?.stepCount || cached.rawStepCount || cachedStepCount,
        status: localStatus,
        killed: isKilled,
        lastModifiedTime: localSum?.lastModifiedTime || '',
        lastModifiedMs: Math.max(
          cached.lastModifiedMs || 0,
          lastStepMs,
          diskMtimeMs || 0,
          localSum?.lastModifiedMs || 0
        ),
        diskMtimeMs,
        dbPath,
        diskFileSig,
        appSource,
        inSummaries: false,
        isSubagent,
        isSideQuestion,
        parentConversationId,
        rootConversationId,
        subagentSpec,
        agentScriptName,
        createdTimeMs,
        spawnOrder,
        subagentRefs,
      });
    } else {
      rawConversations.push({
        cascadeId,
        title:
          sqParentInfo?.title ||
          localSum?.title ||
          (isSideQuestion ? '旁路提问' : cascadeId.slice(0, 8)),
        stepCount: 0,
        rawStepCount: localSum?.stepCount || 0,
        status: localStatus,
        killed: isKilled,
        lastModifiedTime: localSum?.lastModifiedTime || '',
        lastModifiedMs: Math.max(diskMtimeMs || 0, localSum?.lastModifiedMs || 0),
        diskMtimeMs,
        dbPath,
        diskFileSig,
        appSource,
        inSummaries: false,
        needsInitialLoad: true,
        isSubagent,
        isSideQuestion,
        parentConversationId,
        rootConversationId,
        subagentSpec,
        agentScriptName,
        createdTimeMs,
        spawnOrder: null,
        subagentRefs: null,
      });
    }
  }

  rawConversations.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);

  const attemptedFetchIds = new Set();
  const nowPollMs = Date.now();

  function buildConvSig(conv) {
    if (conv.dbPath && conv.diskFileSig && sqliteAvailable) {
      return `${CACHE_SCHEMA_VERSION}:sqlite:${conv.rawStepCount ?? conv.stepCount}:${conv.lastModifiedTime || ''}:${conv.diskFileSig}`;
    }
    return conv.inSummaries
      ? `${CACHE_SCHEMA_VERSION}:${conv.rawStepCount ?? conv.stepCount}:${conv.lastModifiedTime}`
      : `${CACHE_SCHEMA_VERSION}:disk:${Math.floor(conv.diskMtimeMs || conv.lastModifiedMs || 0)}`;
  }

  function isFetchInCooldown(conv, sig) {
    if (forceRefresh) return false;
    const key = `${conv.cascadeId.toLowerCase()}::${sig}`;
    const rec = activeCooldownMap.get(key);
    if (!rec) return false;
    const failedAt = typeof rec === 'number' ? rec : rec.failedAt;
    const cooldownMs = typeof rec === 'number' ? FAILED_RPC_COOLDOWN_MS : rec.cooldownMs;
    if (nowPollMs - failedAt >= cooldownMs) {
      activeCooldownMap.delete(key);
      return false;
    }
    return true;
  }

  /**
   * 检查缓存条目是否缺少最新分解字段（含 10 通道上下文细分字段 `toolResultsTokens`）。
   */
  function hasMissingStepFields(cached) {
    const steps = cached?.steps || [];
    const lastCachedStep = steps[steps.length - 1];
    if (!lastCachedStep) return false;
    if (!Object.prototype.hasOwnProperty.call(lastCachedStep, 'contextBreakdown')) {
      return true;
    }
    const { missingResponseModel, missingToolResultsTokens } = readStepFieldChecks(steps);
    return missingResponseModel || missingToolResultsTokens;
  }

  function readStepFieldChecks(steps) {
    const known = stepFieldChecks.get(steps);
    if (known) return known;
    let missingToolResultsTokens = false;
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i]?.contextBreakdown) {
        missingToolResultsTokens = !Object.prototype.hasOwnProperty.call(
          steps[i].contextBreakdown,
          'toolResultsTokens'
        );
        break;
      }
    }
    const checks = {
      missingResponseModel: steps.some((s) => !Object.prototype.hasOwnProperty.call(s, 'responseModel')),
      missingToolResultsTokens,
      hasIncompleteTiming: steps.some((s) => s.speedReason === 'incomplete_or_invalid_timing'),
    };
    stepFieldChecks.set(steps, checks);
    return checks;
  }

  let lazyExternalByLower = null;

  /**
   * 批量拉取会话轨迹并提取步骤、子代理元数据 (`trajectory.metadata`) 与子代理调用引用 (`invokeSubagent`)。
   *
   * @param {object[]} targetConvs
   */
  async function fetchTrajectoryBatch(targetConvs) {
    for (const c of targetConvs) {
      attemptedFetchIds.add(c.cascadeId.toLowerCase());
    }
    for (let i = 0; i < targetConvs.length; i += maxConcurrentRpc) {
      const batch = targetConvs.slice(i, i + maxConcurrentRpc);
      await Promise.all(
        batch.map(async (conv) => {
          const sig = buildConvSig(conv);
          const cooldownKey = `${conv.cascadeId.toLowerCase()}::${sig}`;
          const isRunning = conv.status === 'CASCADE_RUN_STATUS_RUNNING';
          const isReq = Boolean(reqLower && conv.cascadeId.toLowerCase() === reqLower);
          const prev = getEntry(conv.cascadeId);
          let partialTailSteps = [];
          let hasTailStepInfo = false;
          try {
            const cidLower = conv.cascadeId.toLowerCase();
            let trajRes = null;
            let loadedViaSqlite = false;
            let transcriptFirstTitle = '';
            if (!isRemote && conv.dbPath && sqliteAvailable) {
              const sqlRes = readLocalSqliteTrajectory(conv.dbPath, {
                cascadeId: conv.cascadeId,
                isRunning,
              });
              if (sqlRes && Array.isArray(sqlRes.trajectory?.steps)) {
                trajRes = sqlRes;
                loadedViaSqlite = true;
                const enriched = enrichSqliteStepsFromTranscriptIfNeeded(
                  cidLower,
                  trajRes.trajectory.steps
                );
                transcriptFirstTitle = enriched.firstUserTitle || '';
              }
            }
            if (!trajRes) {
              trajRes = await callLsRpc(
                'GetCascadeTrajectory',
                { cascadeId: conv.cascadeId },
                5000,
                endpoint
              );
            }
            if (!Array.isArray(trajRes?.trajectory?.steps)) {
              throw new Error('Trajectory steps unavailable');
            }
            const rawStepsUnfiltered = trajRes.trajectory.steps;
            if (!loadedViaSqlite && Number(trajRes.numTotalSteps) > rawStepsUnfiltered.length) {
              if (rawStepsUnfiltered.length > 0) {
                partialTailSteps = rawStepsUnfiltered;
                const tailIdx =
                  rawStepsUnfiltered[rawStepsUnfiltered.length - 1]?.metadata?.sourceTrajectoryStepInfo
                    ?.stepIndex;
                hasTailStepInfo = Number.isFinite(Number(tailIdx));
              }
              throw new Error('Incomplete trajectory; retaining cached usage');
            }
            activeCooldownMap.delete(cooldownKey);
            const rawGenMeta = trajRes?.trajectory?.generatorMetadata || [];
            const { steps: rawSteps, generatorMeta } = loadedViaSqlite
              ? { steps: rawStepsUnfiltered, generatorMeta: rawGenMeta }
              : filterClonedTrajectorySteps(rawStepsUnfiltered, rawGenMeta, cidLower);
            const steps = extractModelSteps(rawSteps, generatorMeta);
            const nextLast = steps[steps.length - 1];

            // 提取轨迹内携带的子代理归属元数据、旁路提问父归属与派生的子代理引用列表
            const sqParentInfo = mergedSideQuestionParents[cidLower] || null;
            const extractedMeta = extractTrajectorySubagentMeta(trajRes, conv);
            const detectedSideQuestion = Boolean(
              trajRes?.isSideQuestion ||
                Number(trajRes?.trajectoryType) === 22 ||
                trajRes?.trajectoryType === 'CORTEX_TRAJECTORY_TYPE_SIDE_QUESTION' ||
                conv.isSideQuestion ||
                sqParentInfo
            );
            const defaultShortId = cidLower.slice(0, 8);
            const nonShortTitle = (t) => {
              const clean = String(t || '').trim();
              return clean && clean.toLowerCase() !== defaultShortId ? clean : '';
            };

            if (detectedSideQuestion) {
              const parentCid = String(
                sqParentInfo?.parentConversationId ||
                  trajRes?.forkParentConversationId ||
                  extractedMeta.parentConversationId ||
                  conv.parentConversationId ||
                  ''
              )
                .trim()
                .toLowerCase();
              const sqTitle = String(
                sqParentInfo?.title ||
                  trajRes?.firstOwnUserPrompt ||
                  transcriptFirstTitle ||
                  (prev?.isSideQuestion ? nonShortTitle(prev?.title) : '') ||
                  nonShortTitle(conv.title) ||
                  ''
              ).trim();
              const cleanSqRole = sqTitle && sqTitle !== '旁路提问' ? sqTitle : '';
              conv.isSideQuestion = true;
              conv.parentConversationId = parentCid;
              const extRoot = String(extractedMeta.rootConversationId || '').trim().toLowerCase();
              const prevConvRoot = String(conv.rootConversationId || '').trim().toLowerCase();
              conv.rootConversationId =
                (extRoot && extRoot !== cidLower ? extRoot : '') ||
                (prevConvRoot && prevConvRoot !== cidLower ? prevConvRoot : '') ||
                parentCid ||
                '';
              conv.title = cleanSqRole || '旁路提问';
              conv.subagentSpec = {
                typeName: 'side_question',
                role: cleanSqRole || '旁路提问',
              };
              conv.agentScriptName = '';
              conv.createdTimeMs =
                extractedMeta.createdTimeMs || steps[0]?.createdAtMs || conv.createdTimeMs || 0;
              conv.isSubagent = Boolean(conv.parentConversationId || conv.rootConversationId);
            } else {
              conv.parentConversationId = extractedMeta.parentConversationId;
              conv.rootConversationId = extractedMeta.rootConversationId;
              conv.subagentSpec = extractedMeta.subagentSpec;
              conv.agentScriptName = extractedMeta.agentScriptName;
              conv.createdTimeMs = extractedMeta.createdTimeMs;
              conv.isSubagent =
                Boolean(conv.parentConversationId) ||
                Boolean(
                  conv.rootConversationId && conv.rootConversationId !== cidLower
                );
              if (!isRemote && !nonShortTitle(conv.title)) {
                const annTitle = nonShortTitle(readAnnotationTitleForCascade(cidLower));
                const resolvedFallbackTitle =
                  annTitle || trajRes?.firstOwnUserPrompt || transcriptFirstTitle;
                if (resolvedFallbackTitle) {
                  conv.title = resolvedFallbackTitle;
                }
              }
            }
            if (loadedViaSqlite && Number.isFinite(trajRes?.rawTableStepCount) && !conv.inSummaries) {
              conv.rawStepCount = trajRes.rawTableStepCount;
            }

            const subagentRefs = extractSubagentRefsFromSteps(rawSteps);
            const rpcSwarmMeta = extractSwarmMetaFromSteps(rawSteps);
            const ownSwarmManifest =
              !isRemote && !conv.isSubagent ? readSwarmManifestForCascade(cidLower) : null;
            if (ownSwarmManifest?.workerRefs?.length) {
              const seenRefCids = new Set(subagentRefs.map((r) => r.cascadeId));
              for (const wRef of ownSwarmManifest.workerRefs) {
                if (!seenRefCids.has(wRef.cascadeId)) {
                  seenRefCids.add(wRef.cascadeId);
                  subagentRefs.push(wRef);
                }
              }
            }
            const resolvedSwarmTitle = !conv.isSubagent
              ? String(ownSwarmManifest?.title || rpcSwarmMeta?.title || '').trim()
              : '';
            if (!nonShortTitle(conv.title) && resolvedSwarmTitle) {
              conv.title = resolvedSwarmTitle;
            }
            conv.subagentRefs = subagentRefs;

            const lastStepMs = nextLast?.createdAtMs || 0;
            const resolvedLastModMs = Math.max(conv.lastModifiedMs || 0, lastStepMs);
            conv.lastModifiedMs = resolvedLastModMs;
            conv.stepCount = steps.length;
            const finalSig = buildConvSig(conv);

            const isParkedSwarm = isParkedOnSwarmWait(rawSteps);
            const effectiveIsRunning = isRunning && !isParkedSwarm;
            if (!effectiveIsRunning && conv.status === 'CASCADE_RUN_STATUS_RUNNING') {
              conv.status = 'IDLE';
            }

            const liveAct = resolveBestLiveActivity(
              conv.cascadeId,
              rawSteps,
              effectiveIsRunning,
              resolvedLastModMs || conv.createdTimeMs || 0,
              { isRemote, liveActivityMemoMap: activeLiveActivityMemo }
            );
            if (liveAct && liveAct.actionKey !== 'swarm_wait') {
              conv.liveActivity = liveAct;
              activeLiveActivityMemo.set(cidLower, liveAct);
            } else {
              if (liveAct?.actionKey === 'swarm_wait') {
                conv.status = 'IDLE';
              }
              conv.liveActivity = null;
              activeLiveActivityMemo.delete(cidLower);
            }

            const entryAccountName = prev?.accountName || currentAccountName || '';
            const stepsWithOwners = attachStepAccountOwners(
              steps,
              prev,
              currentAccountName,
              entryAccountName
            );
            const cacheEntry = {
              signature: finalSig,
              accountName: entryAccountName,
              title: conv.title,
              lastModifiedMs: resolvedLastModMs,
              diskMtimeMs:
                conv.diskMtimeMs ?? readConversationMtime(diskConvMap.get(cidLower)),
              rawStepCount: conv.rawStepCount ?? stepsWithOwners.length,
              wasRunning: conv.status === 'CASCADE_RUN_STATUS_RUNNING',
              contextLimitTelemetry: true,
              speedClearedTelemetry: true,
              turnRailTelemetry: true,
              wakeupTurnTelemetry: true,
              contextGroupsTelemetry: 2,
              anomalyTelemetry: 1,
              steps: stepsWithOwners,
              subagentRefs,
            };
            if (rpcSwarmMeta) cacheEntry.swarmMeta = rpcSwarmMeta;
            if (isParkedSwarm) cacheEntry.parkedOnSwarmWait = true;
            if (conv.diskFileSig) cacheEntry.diskFileSig = conv.diskFileSig;
            if (conv.appSource && conv.appSource !== 'standalone') {
              cacheEntry.appSource = conv.appSource;
            }
            if (conv.isSideQuestion) {
              cacheEntry.isSideQuestion = true;
            }
            if (conv.isSubagent) {
              cacheEntry.parentConversationId = conv.parentConversationId;
              cacheEntry.rootConversationId = conv.rootConversationId;
              if (conv.subagentSpec) cacheEntry.subagentSpec = conv.subagentSpec;
              if (conv.agentScriptName) cacheEntry.agentScriptName = conv.agentScriptName;
              if (conv.createdTimeMs) cacheEntry.createdTimeMs = conv.createdTimeMs;
              if (Number.isFinite(conv.spawnOrder)) cacheEntry.spawnOrder = conv.spawnOrder;
            }

            const metaChanged =
              !Array.isArray(prev?.subagentRefs) ||
              JSON.stringify(prev?.subagentRefs) !== JSON.stringify(subagentRefs) ||
              !isDeepStrictEqual(prev?.swarmMeta || null, cacheEntry.swarmMeta || null) ||
              Boolean(prev?.parkedOnSwarmWait) !== Boolean(cacheEntry.parkedOnSwarmWait) ||
              (prev?.rootConversationId || '') !== (cacheEntry.rootConversationId || '') ||
              Boolean(prev?.isSideQuestion) !== Boolean(cacheEntry.isSideQuestion);
            const stepsChanged =
              !prev ||
              Boolean(prev.offlineTranscriptFallback) ||
              prev.signature !== finalSig ||
              Boolean(prev.wasRunning) !== Boolean(cacheEntry.wasRunning) ||
              !prev.contextLimitTelemetry ||
              !prev.speedClearedTelemetry ||
              !prev.turnRailTelemetry ||
              !prev.contextGroupsTelemetry ||
              !prev.anomalyTelemetry ||
              metaChanged ||
              !isDeepStrictEqual(prev.steps, stepsWithOwners);

            if (!stepsChanged) cacheEntry.steps = prev.steps;
            setEntry(conv.cascadeId, cacheEntry);
            if (stepsChanged) {
              cacheDirty = true;
            }
          } catch (err) {
            let offlineRecovered = false;
            if (!isRemote && !conv.inSummaries && (!prev || prev.offlineTranscriptFallback)) {
              if (!lazyExternalByLower) {
                lazyExternalByLower = new Map();
                for (const ext of loadExternalDeepStatsCache().values()) {
                  const extCid = String(ext?.cascadeId || '').toLowerCase();
                  if (!extCid) continue;
                  const existingExt = lazyExternalByLower.get(extCid);
                  if (!existingExt || (ext.steps?.length || 0) > (existingExt.steps?.length || 0)) {
                    lazyExternalByLower.set(extCid, ext);
                  }
                }
              }
              const cidLower = conv.cascadeId.toLowerCase();
              const diskFiles = diskConvMap.get(cidLower) || [];
              const offlineFallback = loadOfflineTranscriptConversation(
                conv,
                diskFiles,
                lazyExternalByLower,
                localSummaryByLower.get(cidLower) || null
              );
              if (offlineFallback) {
                offlineRecovered = true;
                conv.title = offlineFallback.title;
                conv.lastModifiedMs = offlineFallback.lastModifiedMs;
                conv.stepCount = offlineFallback.steps.length;
                conv.subagentRefs = offlineFallback.subagentRefs;
                if (offlineFallback.parentConversationId) {
                  conv.parentConversationId = offlineFallback.parentConversationId;
                }
                if (offlineFallback.rootConversationId) {
                  conv.rootConversationId = offlineFallback.rootConversationId;
                }
                conv.isSubagent =
                  Boolean(conv.parentConversationId) ||
                  Boolean(conv.rootConversationId && conv.rootConversationId !== cidLower);
                const resolvedDiskMtime = conv.diskMtimeMs ?? readConversationMtime(diskFiles);
                const offlineAccountName =
                  prev?.accountName || offlineFallback.accountName || currentAccountName || '';
                const offlineStepsWithOwners = attachStepAccountOwners(
                  offlineFallback.steps,
                  prev,
                  offlineFallback.accountName || currentAccountName,
                  offlineAccountName
                );
                const offlineEntry = {
                  signature: sig,
                  accountName: offlineAccountName,
                  title: offlineFallback.title,
                  ...(offlineFallback.appSource ? { appSource: offlineFallback.appSource } : {}),
                  lastModifiedMs: offlineFallback.lastModifiedMs,
                  diskMtimeMs: resolvedDiskMtime,
                  wasRunning: isRunning,
                  offlineTranscriptFallback: true,
                  ...(offlineFallback.fromSqlite ? { offlineSqliteTelemetry: true } : {}),
                  contextLimitTelemetry: true,
                  speedClearedTelemetry: true,
                  turnRailTelemetry: true,
                  contextGroupsTelemetry: 2,
                  anomalyTelemetry: 1,
                  steps: offlineStepsWithOwners,
                  subagentRefs: offlineFallback.subagentRefs,
                };
                if (conv.isSubagent) {
                  offlineEntry.parentConversationId = conv.parentConversationId;
                  offlineEntry.rootConversationId = conv.rootConversationId;
                  if (conv.subagentSpec) offlineEntry.subagentSpec = conv.subagentSpec;
                  if (conv.agentScriptName) offlineEntry.agentScriptName = conv.agentScriptName;
                  if (conv.createdTimeMs) offlineEntry.createdTimeMs = conv.createdTimeMs;
                  if (Number.isFinite(conv.spawnOrder)) offlineEntry.spawnOrder = conv.spawnOrder;
                }
                const changed =
                  !prev ||
                  prev.signature !== sig ||
                  prev.title !== offlineEntry.title ||
                  Boolean(prev.wasRunning) !== isRunning ||
                  Boolean(prev.offlineSqliteTelemetry) !== Boolean(offlineEntry.offlineSqliteTelemetry) ||
                  !isDeepStrictEqual(prev.steps, offlineEntry.steps);
                if (!changed) offlineEntry.steps = prev.steps;
                setEntry(conv.cascadeId, offlineEntry);
                if (changed) {
                  cacheDirty = true;
                }
              }
            }
            if (
              !offlineRecovered &&
              !(
                !conv.inSummaries &&
                /(?:\(404\)|\bnot_found\b|Language Server address unavailable)/i.test(
                  String(err?.message || '')
                )
              )
            ) {
              console.error(`Failed loading trajectory ${conv.cascadeId}: ${err.message}`);
            }
            if (!(isRunning && (hasTailStepInfo || offlineRecovered))) {
              const cooldownMs =
                isRunning || isReq ? ACTIVE_FAILED_RPC_COOLDOWN_MS : FAILED_RPC_COOLDOWN_MS;
              activeCooldownMap.set(cooldownKey, { failedAt: nowPollMs, cooldownMs });
            }
            const tailStepsOnErr =
              partialTailSteps.length > 0
                ? partialTailSteps
                : isRemote
                  ? []
                  : readTranscriptTailSteps(conv.cascadeId);
            const parkedOnErr =
              tailStepsOnErr.length > 0
                ? isParkedOnSwarmWait(tailStepsOnErr)
                : Boolean(prev?.parkedOnSwarmWait) && prev.signature === sig;
            if (!isRunning || (!offlineRecovered && parkedOnErr)) {
              if (isRunning) {
                conv.status = 'IDLE';
                conv.liveActivity = null;
              }
              activeLiveActivityMemo.delete(conv.cascadeId.toLowerCase());
            } else {
              const fallbackLive = resolveBestLiveActivity(
                conv.cascadeId,
                partialTailSteps,
                true,
                conv.lastModifiedMs || conv.createdTimeMs || 0,
                { isRemote, liveActivityMemoMap: activeLiveActivityMemo }
              );
              conv.liveActivity = fallbackLive;
              if (fallbackLive) {
                activeLiveActivityMemo.set(conv.cascadeId.toLowerCase(), fallbackLive);
              }
            }
            if (
              !offlineRecovered &&
              prev &&
              getEntry(conv.cascadeId) === prev &&
              String(prev.signature || '').startsWith(`${CACHE_SCHEMA_VERSION}:`) &&
              !Array.isArray(prev.subagentRefs)
            ) {
              setEntry(conv.cascadeId, { ...prev, subagentRefs: [] });
              cacheDirty = true;
            }
          }
        })
      );
    }
  }

  // 阶段 1：拉取常规新增/变更会话，以及摘要列表中尚未提取 subagentRefs 的会话
  // 旧缓存只补读当前会话的宿主上限，避免重拉全部历史轨迹。
  const contextTelemetryCascadeId = reqLower || rawConversations[0]?.cascadeId.toLowerCase();
  const selectedRootId = rawConversations.find(
    (c) => c.cascadeId.toLowerCase() === contextTelemetryCascadeId
  )?.rootConversationId || contextTelemetryCascadeId;
  function hasMissingTurnRailFields(cached) {
    const steps = cached?.steps || [];
    const lastCachedStep = steps[steps.length - 1];
    if (!lastCachedStep) return false;
    return !Object.prototype.hasOwnProperty.call(lastCachedStep, 'turnIndex');
  }
  function hasDroppedContextGroups(cached) {
    if (cached?.contextGroupsTelemetry === 2) return false;
    const steps = cached?.steps || [];
    if (steps.some((st) => st?.isCompactionStep)) {
      return true;
    }
    if (cached?.contextGroupsTelemetry) return false;
    for (let i = steps.length - 1; i >= 0; i--) {
      const st = steps[i];
      if (!st || st.isCompactionStep) break;
      if (st.contextBreakdown) {
        const cb = st.contextBreakdown;
        const cbSum =
          Number(cb.totalTokens || 0) ||
          Number(cb.messagesTokens || 0) +
            Number(cb.systemToolsTokens || 0) +
            Number(cb.mcpToolsTokens || 0) +
            Number(cb.skillsTokens || 0) +
            Number(cb.systemPromptTokens || 0) +
            Number(cb.userRulesTokens || 0);
        return Number(st.estimatedContextTokens || 0) > cbSum;
      }
    }
    return false;
  }

  function needsWakeupTurnRefresh(conv, cached) {
    if (!conv?.isSubagent || conv.isSideQuestion || cached?.wakeupTurnTelemetry) return false;
    const steps = cached?.steps || [];
    return steps.length > 0 && steps.every((s) => !s?.turnIndex);
  }

  let remainingTimingRefreshes = LEGACY_MIGRATION_BATCH_SIZE;
  const toFetch = rawConversations.filter((conv) => {
    const sig = buildConvSig(conv);
    if (isFetchInCooldown(conv, sig)) return false;
    const isRunning = conv.status === 'CASCADE_RUN_STATUS_RUNNING';
    const cached = getEntry(conv.cascadeId);
    if (!cached || conv.needsInitialLoad) return true;
    const lowerCid = conv.cascadeId.toLowerCase();
    const isSelectedFamily =
      lowerCid === contextTelemetryCascadeId ||
      lowerCid === selectedRootId ||
      Boolean(conv.rootConversationId && conv.rootConversationId.toLowerCase() === selectedRootId);
    if (!cached.contextLimitTelemetry && lowerCid === contextTelemetryCascadeId) return true;
    if (
      (!cached.turnRailTelemetry ||
        !cached.anomalyTelemetry ||
        hasMissingTurnRailFields(cached) ||
        needsWakeupTurnRefresh(conv, cached) ||
        hasDroppedContextGroups(cached)) &&
      isSelectedFamily
    ) {
      return true;
    }
    const hasCurrentSchema = String(cached.signature || '').startsWith(
      `${CACHE_SCHEMA_VERSION}:`
    );
    if (!hasCurrentSchema) return true;
    if (
      conv.dbPath &&
      sqliteAvailable &&
      !String(cached.signature || '').startsWith(`${CACHE_SCHEMA_VERSION}:sqlite:`)
    ) {
      return true;
    }
    if (hasMissingStepFields(cached)) return true;
    const missingSubagentRefs = !Array.isArray(cached.subagentRefs);
    if (!conv.inSummaries) {
      if (isRunning || cached.wasRunning) return true;
      if (conv.dbPath && sqliteAvailable) {
        return cached.signature !== sig;
      }
      if (
        cached.offlineTranscriptFallback &&
        !cached.offlineSqliteTelemetry &&
        hasBuiltinNodeSqlite() &&
        hasLocalSqliteDb(diskConvMap.get(lowerCid))
      ) {
        return true;
      }
      const localSum = localSummaryByLower.get(lowerCid);
      if (cached.offlineTranscriptFallback && localSum?.title && cached.title !== localSum.title) {
        return true;
      }
      if (missingSubagentRefs && lowerCid === reqLower) {
        return true;
      }
      if (
        conv.diskMtimeMs > 0 &&
        conv.diskMtimeMs > (cached.diskMtimeMs || cached.lastModifiedMs || 0)
      ) return true;
    } else {
      if (
        cached.offlineTranscriptFallback ||
        missingSubagentRefs ||
        cached.signature !== sig ||
        isRunning ||
        cached.wasRunning
      ) {
        return true;
      }
    }
    // 保留已有效的历史测速，按批补读需要确认原始状态与生成结束时间的旧步骤。
    if (!cached.speedClearedTelemetry && readStepFieldChecks(cached.steps).hasIncompleteTiming) {
      if (conv.cascadeId.toLowerCase() === selectedRootId || conv.rootConversationId === selectedRootId) return true;
      if (remainingTimingRefreshes > 0) {
        remainingTimingRefreshes -= 1;
        return true;
      }
    }
    return false;
  });

  await fetchTrajectoryBatch(toFetch);

  /**
   * 阶段 2：根据父会话的 `subagentRefs` 将子代理归属关系、角色名称与启动顺序回填至子代理会话，
   * 支持多层嵌套子代理（主会话 -> 子代理 -> 二级子代理）逐层补拉与归属收敛。
   */
  async function reconcileParentSubagentRefs() {
    for (let depth = 0; depth < MAX_SUBAGENT_RECONCILE_DEPTH; depth++) {
      const byLowerId = new Map(rawConversations.map((c) => [c.cascadeId.toLowerCase(), c]));
      const missingSubagentsToFetch = [];

      for (const parentConv of [...rawConversations]) {
        const parentCached = getEntry(parentConv.cascadeId);
        const baseRefs = parentConv.subagentRefs || parentCached?.subagentRefs || [];
        const swarmManifest =
          !isRemote && !parentConv.isSubagent
            ? readSwarmManifestForCascade(parentConv.cascadeId)
            : null;
        let refs = baseRefs;
        if (swarmManifest?.workerRefs?.length) {
          const merged = Array.isArray(baseRefs) ? baseRefs.slice() : [];
          const seenRefCids = new Set(merged.map((r) => String(r?.cascadeId || '').toLowerCase()));
          for (const wRef of swarmManifest.workerRefs) {
            if (!seenRefCids.has(wRef.cascadeId)) {
              seenRefCids.add(wRef.cascadeId);
              merged.push(wRef);
            }
          }
          refs = merged;
        }
        if (!Array.isArray(refs) || refs.length === 0) continue;

        const parentId = parentConv.cascadeId.toLowerCase();
        const rootId = (
          parentConv.rootConversationId ||
          parentConv.parentConversationId ||
          parentId
        ).toLowerCase();

        for (const ref of refs) {
          const subCid = String(ref?.cascadeId || '').trim().toLowerCase();
          if (!subCid || subCid === parentId || unavailable(subCid)) continue;

          const canonSubId = canonicalIdByLower.get(subCid) || subCid;
          canonicalIdByLower.set(subCid, canonSubId);
          let subConv = byLowerId.get(subCid);
          const subCached = getEntry(subConv?.cascadeId || canonSubId);
          if (!subConv) {
            const subDiskFiles = diskConvMap.get(subCid) || [];
            const subDbInfo = sqliteAvailable ? resolveBestSqliteDbInfo(subDiskFiles) : null;
            const diskMtimeMs = Math.max(
              readConversationMtime(subDiskFiles),
              subDbInfo?.mtimeMs || 0
            );
            const lastStepMs = subCached?.steps?.[subCached.steps.length - 1]?.createdAtMs || 0;
            const stepCount = Number(subCached?.steps?.length || 0);
            subConv = {
              cascadeId: canonSubId,
              title: ref.role || subCached?.title || canonSubId.slice(0, 8),
              stepCount,
              rawStepCount: stepCount,
              status: 'IDLE',
              lastModifiedTime: '',
              lastModifiedMs: Math.max(
                subCached?.lastModifiedMs || 0,
                lastStepMs,
                diskMtimeMs,
                ref.createdTimeMs || 0
              ),
              diskMtimeMs,
              dbPath: subDbInfo?.dbPath || '',
              diskFileSig: subDbInfo?.sig || '',
              appSource: isRemote
                ? 'ssh'
                : inferAppSourceFromSummary('', subDiskFiles, subCached?.appSource || 'standalone'),
              inSummaries: false,
              needsInitialLoad: !subCached,
              isSubagent: true,
              isSideQuestion: false,
              parentConversationId: parentId,
              rootConversationId: rootId,
              subagentSpec: mergeSubagentSpecs(ref, subCached?.subagentSpec),
              agentScriptName: subCached?.agentScriptName || '',
              createdTimeMs: ref.createdTimeMs || subCached?.createdTimeMs || 0,
              spawnOrder: Number.isFinite(ref.spawnOrder) ? ref.spawnOrder : null,
              subagentRefs: Array.isArray(subCached?.subagentRefs) ? subCached.subagentRefs : null,
            };
            rawConversations.push(subConv);
            byLowerId.set(subCid, subConv);
          } else {
            subConv.isSubagent = true;
            subConv.parentConversationId = subConv.parentConversationId || parentId;
            subConv.rootConversationId = subConv.rootConversationId || rootId;
            subConv.subagentSpec = mergeSubagentSpecs(subConv.subagentSpec, ref);
            if (ref.createdTimeMs && !subConv.createdTimeMs) {
              subConv.createdTimeMs = ref.createdTimeMs;
            }
            if (Number.isFinite(ref.spawnOrder) && !Number.isFinite(subConv.spawnOrder)) {
              subConv.spawnOrder = ref.spawnOrder;
            }
            if (Array.isArray(subCached?.steps)) {
              subConv.stepCount = subCached.steps.length;
            }
          }

          const targetCacheKey = subConv.cascadeId;
          const existingSubCache = getEntry(targetCacheKey);
          const isSelectedSubFamily = rootId === selectedRootId;
          const hasValidSubCache =
            existingSubCache &&
            !(existingSubCache.offlineTranscriptFallback && subConv.inSummaries) &&
            String(existingSubCache.signature || '').startsWith(
              subConv.dbPath && sqliteAvailable
                ? `${CACHE_SCHEMA_VERSION}:sqlite:`
                : `${CACHE_SCHEMA_VERSION}:`
            ) &&
            !hasMissingStepFields(existingSubCache) &&
            (!isSelectedSubFamily ||
              (Boolean(existingSubCache.turnRailTelemetry) &&
                Boolean(existingSubCache.anomalyTelemetry) &&
                !hasMissingTurnRailFields(existingSubCache) &&
                !needsWakeupTurnRefresh(subConv, existingSubCache) &&
                !hasDroppedContextGroups(existingSubCache)));

          if (hasValidSubCache) {
            const updatedMetadata = {};
            if (existingSubCache.parentConversationId !== subConv.parentConversationId) {
              updatedMetadata.parentConversationId = subConv.parentConversationId;
            }
            if (existingSubCache.rootConversationId !== subConv.rootConversationId) {
              updatedMetadata.rootConversationId = subConv.rootConversationId;
            }
            const nextSpec = sanitizeSubagentSpec(subConv.subagentSpec);
            if (
              nextSpec &&
              JSON.stringify(existingSubCache.subagentSpec || null) !== JSON.stringify(nextSpec)
            ) {
              updatedMetadata.subagentSpec = nextSpec;
            }
            if (
              subConv.createdTimeMs &&
              existingSubCache.createdTimeMs !== subConv.createdTimeMs
            ) {
              updatedMetadata.createdTimeMs = subConv.createdTimeMs;
            }
            if (
              Number.isFinite(subConv.spawnOrder) &&
              existingSubCache.spawnOrder !== subConv.spawnOrder
            ) {
              updatedMetadata.spawnOrder = subConv.spawnOrder;
            }
            if (!Array.isArray(existingSubCache.subagentRefs)) {
              updatedMetadata.subagentRefs = [];
            }
            if (Object.keys(updatedMetadata).length > 0) {
              setEntry(targetCacheKey, { ...existingSubCache, ...updatedMetadata });
              cacheDirty = true;
            }
          } else {
            const subSig = buildConvSig(subConv);
            if (!attemptedFetchIds.has(subCid) && !isFetchInCooldown(subConv, subSig)) {
              missingSubagentsToFetch.push(subConv);
            }
          }
        }
      }

      if (missingSubagentsToFetch.length === 0) break;
      await fetchTrajectoryBatch(missingSubagentsToFetch);
    }
  }

  await reconcileParentSubagentRefs();

  // 阶段 3：对剩余尚未标记 subagentRefs 的纯磁盘历史会话每次增量迁移最多 8 个，避免单次轮询阻塞
  const remainingLegacyDiskConvs = rawConversations
    .filter((c) => {
      const sig = buildConvSig(c);
      if (attemptedFetchIds.has(c.cascadeId.toLowerCase()) || isFetchInCooldown(c, sig)) {
        return false;
      }
      const cached = getEntry(c.cascadeId);
      return cached && !Array.isArray(cached.subagentRefs);
    })
    .slice(0, LEGACY_MIGRATION_BATCH_SIZE);

  if (remainingLegacyDiskConvs.length > 0) {
    await fetchTrajectoryBatch(remainingLegacyDiskConvs);
    await reconcileParentSubagentRefs();
  }

  // 阶段 4：将多层嵌套子代理的 rootConversationId 沿着父链向上收敛至最顶层根会话，防止二级子代理丢失
  const byId = new Map(rawConversations.map((c) => [c.cascadeId.toLowerCase(), c]));
  for (const conv of rawConversations) {
    if (!conv.isSubagent) continue;
    const cid = conv.cascadeId.toLowerCase();
    let candidate = (conv.rootConversationId || conv.parentConversationId || '').toLowerCase();
    if (candidate === cid) {
      candidate = (conv.parentConversationId || '').toLowerCase();
    }
    const visited = new Set([cid]);
    while (candidate && !visited.has(candidate)) {
      visited.add(candidate);
      const ancestor = byId.get(candidate);
      if (!ancestor || !ancestor.isSubagent) break;
      const nextUp = (
        ancestor.parentConversationId ||
        ancestor.rootConversationId ||
        ''
      ).toLowerCase();
      if (!nextUp || nextUp === candidate) break;
      candidate = nextUp;
    }
    if (candidate && candidate !== conv.rootConversationId) {
      conv.rootConversationId = candidate;
      const cached = getEntry(conv.cascadeId);
      if (cached && cached.rootConversationId !== candidate) {
        setEntry(conv.cascadeId, { ...cached, rootConversationId: candidate });
        cacheDirty = true;
      }
    }
  }

  if (!isRemote) {
    for (const entry of [...rawConversations, ...listEntries().map(([, cached]) => cached)]) {
      for (const field of ['rootConversationId', 'parentConversationId', 'parentCascadeId']) {
        const id = entry[field]?.toLowerCase();
        if (archived(id)) {
          delete entry[field];
          cacheDirty = true;
        }
      }
      if (entry.subagentRefs?.some(ref => archived(ref.cascadeId?.toLowerCase()))) {
        entry.subagentRefs = entry.subagentRefs.filter(ref => !archived(ref.cascadeId?.toLowerCase()));
        cacheDirty = true;
      }
    }
  }

  const hasRunningSessions = rawConversations.some(
    (c) => c.status === 'CASCADE_RUN_STATUS_RUNNING'
  );
  if (cacheDirty || (hasPendingSave() && !hasRunningSessions)) {
    persistCacheIfNeeded({ hasRunningSessions });
  }

  // 确保所有处于 RUNNING 状态的会话（含本轮未触发 RPC 拉取的会话）都同步了最新的实时动作摘要，并剔除已进入 swarm_wait 待命的假运行态
  for (const conv of rawConversations) {
    if (conv.status === 'CASCADE_RUN_STATUS_RUNNING') {
      if (!conv.liveActivity) {
        const cachedConv = getEntry(conv.cascadeId);
        const parkedByCache =
          Boolean(cachedConv?.parkedOnSwarmWait) &&
          cachedConv.signature === buildConvSig(conv);
        const tailSteps = isRemote ? [] : readTranscriptTailSteps(conv.cascadeId);
        const isParked = tailSteps.length > 0 ? isParkedOnSwarmWait(tailSteps) : parkedByCache;
        if (isParked) {
          conv.status = 'IDLE';
          conv.liveActivity = null;
          activeLiveActivityMemo.delete(conv.cascadeId.toLowerCase());
          continue;
        }
        const fallbackMs = conv.lastModifiedMs || conv.createdTimeMs || 0;
        const resolved = resolveBestLiveActivity(conv.cascadeId, [], true, fallbackMs, {
          isRemote,
          liveActivityMemoMap: activeLiveActivityMemo,
        });
        if (resolved?.actionKey === 'swarm_wait') {
          conv.status = 'IDLE';
          conv.liveActivity = null;
          activeLiveActivityMemo.delete(conv.cascadeId.toLowerCase());
          continue;
        }
        conv.liveActivity = resolved;
        if (resolved) {
          activeLiveActivityMemo.set(conv.cascadeId.toLowerCase(), resolved);
        }
      } else if (conv.liveActivity.actionKey === 'swarm_wait') {
        conv.status = 'IDLE';
        conv.liveActivity = null;
        activeLiveActivityMemo.delete(conv.cascadeId.toLowerCase());
      }
    } else {
      conv.liveActivity = null;
      activeLiveActivityMemo.delete(conv.cascadeId.toLowerCase());
    }
  }

  // 按最终收敛的 rootConversationId 将所有层级的子代理挂载至对应顶层根会话下；孤儿子代理绝不提升为顶层根会话
  const subagentsByRoot = new Map();
  const conversations = [];

  for (const conv of rawConversations) {
    const cid = conv.cascadeId.toLowerCase();
    const rootId = (conv.rootConversationId || conv.parentConversationId || '').toLowerCase();
    const rootTarget = byId.get(rootId);
    if (conv.isSubagent || conv.isSideQuestion) {
      if (
        conv.isSideQuestion &&
        Number(conv.stepCount || 0) === 0 &&
        conv.status !== 'CASCADE_RUN_STATUS_RUNNING' &&
        cid !== reqLower
      ) {
        continue;
      }
      if (
        rootId &&
        rootId !== cid &&
        rootTarget &&
        !rootTarget.isSubagent &&
        !rootTarget.isSideQuestion
      ) {
        if (!subagentsByRoot.has(rootId)) {
          subagentsByRoot.set(rootId, []);
        }
        subagentsByRoot.get(rootId).push(conv);
      } else if (conv.isSideQuestion && cid === reqLower) {
        conversations.push(conv);
      }
    } else {
      conversations.push(conv);
    }
  }

  for (const rootConv of conversations) {
    const cid = rootConv.cascadeId.toLowerCase();
    const rootCached = getEntry(rootConv.cascadeId);
    const swarmManifest = isRemote ? null : readSwarmManifestForCascade(cid);
    const swarmTitle = String(swarmManifest?.title || rootCached?.swarmMeta?.title || '').trim();
    if (swarmTitle) {
      rootConv.swarmTitle = swarmTitle;
      const curTitle = String(rootConv.title || '').trim();
      if (!curTitle || curTitle.toLowerCase() === cid.slice(0, 8)) {
        rootConv.title = swarmTitle;
      }
    }
    if (swarmManifest?.coordinator?.killed || rootConv.killed) {
      rootConv.status = 'IDLE';
      rootConv.liveActivity = null;
    }

    const subs = subagentsByRoot.get(cid) || [];
    const rpcKilledByMember = new Map();
    const mergeRpcKilled = (killedMap) => {
      if (!killedMap || typeof killedMap !== 'object') return;
      for (const [memberKey, killMs] of Object.entries(killedMap)) {
        const normMember = String(memberKey || '').trim().toLowerCase();
        if (!normMember) continue;
        const numMs = Number(killMs || 0);
        const prevMs = rpcKilledByMember.get(normMember);
        if (prevMs === undefined || numMs > prevMs) {
          rpcKilledByMember.set(normMember, numMs);
        }
      }
    };
    mergeRpcKilled(rootCached?.swarmMeta?.killedMembers);
    for (const s of subs) {
      mergeRpcKilled(getEntry(s.cascadeId)?.swarmMeta?.killedMembers);
    }

    let swarmCount = 0;
    for (const s of subs) {
      const subLower = s.cascadeId.toLowerCase();
      const mEntry = swarmManifest?.membersByCid.get(subLower) || null;
      const subCached = getEntry(s.cascadeId);
      const parsedSwarm = !s.isSideQuestion
        ? parseSwarmWorkerRole({
            role: s.subagentSpec?.role || subCached?.subagentSpec?.role || '',
            typeName: s.subagentSpec?.typeName || subCached?.subagentSpec?.typeName || '',
            agentScriptName: s.agentScriptName || subCached?.agentScriptName || '',
            memberName: mEntry?.memberName || '',
          })
        : { isSwarmWorker: false };
      if (parsedSwarm.isSwarmWorker) {
        swarmCount += 1;
        s.isSwarmWorker = true;
        s.swarmMemberName = parsedSwarm.memberName;
        s.isSwarmAuxiliary = Boolean(parsedSwarm.isAuxiliary);
        const memberKey = String(parsedSwarm.memberName || '').trim().toLowerCase();
        const rpcKilledAtMs =
          memberKey && rpcKilledByMember.has(memberKey)
            ? rpcKilledByMember.get(memberKey)
            : undefined;
        const subCreatedMs =
          s.createdTimeMs || subCached?.createdTimeMs || subCached?.steps?.[0]?.createdAtMs || 0;
        const subLastStepMs =
          subCached?.steps?.[subCached.steps.length - 1]?.createdAtMs || 0;
        const killedByRpc =
          rpcKilledAtMs !== undefined &&
          !(
            rpcKilledAtMs > 0 &&
            ((subCreatedMs > 0 && subCreatedMs > rpcKilledAtMs) ||
              subLastStepMs > rpcKilledAtMs)
          );
        s.killed = Boolean(s.killed || (mEntry ? mEntry.killed : killedByRpc));
        if (s.killed) {
          s.status = 'IDLE';
          s.liveActivity = null;
          activeLiveActivityMemo.delete(subLower);
          s.swarmState = 'killed';
        } else if (s.status === 'CASCADE_RUN_STATUS_RUNNING') {
          const parkedInManifest =
            Boolean(mEntry) &&
            (mEntry.wakeMode === 'mentions' || mEntry.wakeMode === 'anything') &&
            (!s.liveActivity || s.liveActivity.signature === 'init:0');
          if (s.liveActivity?.actionKey === 'swarm_wait' || parkedInManifest) {
            s.status = 'IDLE';
            s.liveActivity = null;
            activeLiveActivityMemo.delete(subLower);
            s.swarmState = 'waiting';
          } else {
            s.swarmState = 'working';
          }
        } else {
          s.swarmState = 'waiting';
        }
      }
    }

    subs.sort((a, b) => {
      const aSide = Boolean(a.isSideQuestion);
      const bSide = Boolean(b.isSideQuestion);
      if (aSide !== bSide) {
        return aSide ? 1 : -1;
      }
      if (
        !aSide &&
        a.parentConversationId === b.parentConversationId &&
        Number.isFinite(a.spawnOrder) &&
        Number.isFinite(b.spawnOrder) &&
        a.spawnOrder !== b.spawnOrder
      ) {
        return a.spawnOrder - b.spawnOrder;
      }
      const aStart =
        a.createdTimeMs ||
        getEntry(a.cascadeId)?.steps?.[0]?.createdAtMs ||
        a.lastModifiedMs ||
        0;
      const bStart =
        b.createdTimeMs ||
        getEntry(b.cascadeId)?.steps?.[0]?.createdAtMs ||
        b.lastModifiedMs ||
        0;
      return aStart - bStart || String(a.cascadeId).localeCompare(String(b.cascadeId));
    });
    rootConv.subagents = subs;
    rootConv.subagentCount = subs.length;
    rootConv.swarmCount = swarmCount;
    rootConv.totalStepCount =
      Number(rootConv.stepCount || 0) +
      subs.reduce((sum, s) => sum + Number(s.stepCount || 0), 0);
    const maxSubModMs = subs.reduce((m, s) => Math.max(m, s.lastModifiedMs || 0), 0);
    rootConv.groupLastModifiedMs = Math.max(rootConv.lastModifiedMs || 0, maxSubModMs);
  }

  conversations.sort(
    (a, b) =>
      (b.groupLastModifiedMs || b.lastModifiedMs || 0) -
      (a.groupLastModifiedMs || a.lastModifiedMs || 0)
  );

  // 选定当前活跃根会话：若指定了有效 requestedConvId（支持根会话 ID 或子代理 ID）则优先使用，否则取最近修改的根会话
  const activeConvSummary =
    (reqLower &&
      (conversations.find((c) => c.cascadeId.toLowerCase() === reqLower) ||
        conversations.find((c) =>
          (c.subagents || []).some((s) => s.cascadeId.toLowerCase() === reqLower)
        ))) ||
    conversations[0] ||
    null;
  const safeReqId =
    requestedConvId && !/[\\/]|\.\./.test(String(requestedConvId)) ? requestedConvId : null;
  const activeCascadeId = activeConvSummary?.cascadeId ||
    (safeReqId && !unavailable(reqLower) && !reqLower.startsWith('usage-history:') ? safeReqId : null);

  return {
    conversations,
    activeConvSummary,
    activeCascadeId,
  };
}
