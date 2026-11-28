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
import { isDeepStrictEqual } from 'node:util';
import { extractShortPromptTitle } from '../shared/prompt-clean.mjs';
import {
  extractActiveBackgroundTasks,
  extractLatestTaskSteps,
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
  BRAIN_DIR,
  BRAIN_DIRS,
  CACHE_SCHEMA_VERSION,
  CONVERSATIONS_DIR,
  CONVERSATION_DIRS,
  DEEP_STATS_CACHE_CANDIDATES,
  DEEP_STATS_COVERAGE_MEMO_FILE,
  externalDeepStatsMemo,
  loadJson,
  localSummaryMemo,
  saveJson,
} from './config.mjs';
import { getEndpointCacheStore, getRegisteredRemoteEndpoint } from './endpoint-registry.mjs';
import {
  computeSqliteWalSig,
  hasBuiltinNodeSqlite,
  isSqliteDbReadyForRead,
  readAnnotationTitleForCascade,
  readLocalImageDimensionsFromUri,
  readLocalSqliteActiveTasks,
  readLocalSqliteTrajectory,
  readLocalSqliteTrajectoryIncremental,
  readLocalSummaryIndex,
  readLocalSummarySnapshot,
} from './cli-sqlite-reader.mjs';
import { callLsRpc } from './ls-rpc.mjs';
import { formatGenericModelSlug, getBaseModelLabel } from './model-pricing.mjs';
import { PLACEHOLDER_MAP } from './pricing-catalog.mjs';
import {
  readTranscriptJsonlLines,
  resolveTranscriptPathInLogsDir,
  synthesizeTranscriptModelStep,
} from './transcript-fallback.mjs';

const CONV_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(db|pb|db-wal)$/i;
const TRANSCRIPT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const brainDirListingMemo = new Map();
const knownExistingTranscriptPaths = new Set();
let knownBrainCascadeSet = null;
let knownBrainCascadeSetRootsKey = '';

/**
 * 联合扫描本地多端（Desktop / CLI / IDE）的 `conversations` 与 `brain/<id>/.system_generated/logs/transcript.jsonl`，
 * 按小写 `cascadeId` 归并关联磁盘文件路径，并汇报目录可读性与扫描完整性。
 *
 * @returns {{ map: Map<string, string[]>, complete: boolean, readableDirs: Set<string> }}
 */
function scanLocalConversationFiles() {
  const map = new Map();
  const readableDirs = new Set();
  let complete = true;
  const convDirs =
    Array.isArray(CONVERSATION_DIRS) && CONVERSATION_DIRS.length > 0
      ? CONVERSATION_DIRS
      : [CONVERSATIONS_DIR];
  for (const dir of convDirs) {
    if (!dir || !existsSync(dir)) continue;
    try {
      const names = readdirSync(dir);
      readableDirs.add(dir);
      for (const rawName of names) {
        const name = String(rawName || '');
        const m = name.match(CONV_FILE_RE);
        if (!m) continue;
        const cascadeId = m[1].toLowerCase();
        if (!map.has(cascadeId)) map.set(cascadeId, []);
        map.get(cascadeId).push(join(dir, name));
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        complete = false;
      }
    }
  }

  const brainDirs =
    Array.isArray(BRAIN_DIRS) && BRAIN_DIRS.length > 0 ? BRAIN_DIRS : [BRAIN_DIR];
  const nextBrainUuidSet = new Set();
  for (const dir of brainDirs) {
    if (!dir || !existsSync(dir)) continue;
    try {
      const dirSt = statSync(dir);
      const dirMtimeMs = Math.floor(dirSt?.mtimeMs || 0);
      let cachedListing = dirMtimeMs > 0 ? brainDirListingMemo.get(dir) : null;
      if (!cachedListing || cachedListing.mtimeMs !== dirMtimeMs) {
        const uuidItems = [];
        for (const rawName of readdirSync(dir)) {
          const name = String(rawName || '').trim();
          const cascadeId = name.toLowerCase();
          if (!TRANSCRIPT_UUID_RE.test(cascadeId)) continue;
          uuidItems.push({ name, cascadeId });
        }
        cachedListing = { mtimeMs: dirMtimeMs, uuidItems };
        if (dirMtimeMs > 0) {
          brainDirListingMemo.set(dir, cachedListing);
        }
      }
      readableDirs.add(dir);
      for (const { name, cascadeId } of cachedListing.uuidItems) {
        nextBrainUuidSet.add(cascadeId);
        const transcriptPath = join(dir, name, '.system_generated', 'logs', 'transcript.jsonl');
        if (!knownExistingTranscriptPaths.has(transcriptPath)) {
          if (!existsSync(transcriptPath)) continue;
          if (dirMtimeMs > 0) {
            knownExistingTranscriptPaths.add(transcriptPath);
          }
        }
        if (!map.has(cascadeId)) map.set(cascadeId, []);
        map.get(cascadeId).push(transcriptPath);
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        complete = false;
      }
    }
  }
  knownBrainCascadeSet = nextBrainUuidSet.size > 0 ? nextBrainUuidSet : null;
  knownBrainCascadeSetRootsKey = brainDirs.join('|');

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
  return { map, complete, readableDirs };
}

function discoverLocalConversationFiles() {
  return scanLocalConversationFiles().map;
}

function readConversationMtime(files = []) {
  let mtimeMs = 0;
  for (const nameOrPath of files) {
    try {
      const fullPath = /[\\/]|^[a-zA-Z]:/.test(nameOrPath)
        ? nameOrPath
        : join(CONVERSATIONS_DIR, nameOrPath);
      const st = statSync(fullPath);
      if (/\.db-wal$/i.test(fullPath) && Number(st?.size || 0) <= 0) continue;
      mtimeMs = Math.max(mtimeMs, Number(st?.mtimeMs || 0));
    } catch {
      // 轨迹文件可能在目录枚举后被宿主删除。
    }
  }
  return mtimeMs;
}

function isVirtualDeepStatsMemoPath(filePath) {
  const norm = String(filePath || '').replace(/\\/g, '/');
  return !norm || norm.startsWith('/test/') || norm.startsWith('/test-home/');
}

function isDeepStatsCoveragePairsSatisfied(coveredPairs, coveredByLive) {
  if (!(coveredByLive instanceof Map) || !Array.isArray(coveredPairs)) return false;
  for (let i = 0; i < coveredPairs.length; i += 1) {
    const rec = coveredPairs[i];
    if (!Array.isArray(rec) || rec.length < 2) return false;
    const cid = rec[0];
    const minSteps = Number(rec[1]) || 0;
    const needsAcc = rec[2] === 1;
    const needsTitle = rec[3] === 1;
    const live = coveredByLive.get(cid);
    if (!live || (live.steps?.length || 0) < minSteps) return false;
    if (needsAcc && !live.accountName) return false;
    if (needsTitle && !live.title) return false;
  }
  return true;
}

function computeDeepStatsFilesSig() {
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
  return { sig: sigParts.join('|'), existingFiles };
}

function findCoveredPairMinSteps(coveredPairs, cidLower) {
  if (!Array.isArray(coveredPairs) || !cidLower) return -1;
  for (let i = 0; i < coveredPairs.length; i += 1) {
    const rec = coveredPairs[i];
    if (Array.isArray(rec) && rec[0] === cidLower) {
      return Number(rec[1]) || 0;
    }
  }
  return -1;
}

/**
 * 加载并解析跨端（IDE / Standalone / JetBrains）写入的 `.deep_stats_cache.json` 缓存。
 * 使用文件签名 (`mtimeMs + size`) 进行 Memoize；当传入 `coveredByLive`（常规聚合路径）时，
 * 自动剪枝已被本地 SQLite 账本完整覆盖的旧会话，并在 100% 覆盖时持久化轻量校验签名以避免下次冷启动整文件读入。
 * 当传入 `targetCascadeId` 时，仅解析目标单会话且不污染全局 `externalDeepStatsMemo`。
 *
 * @param {{ coveredByLive?: Map<string, object> | null, targetCascadeId?: string }} [options={}]
 * @returns {Map<string, {cascadeId: string, appSource: string, accountName: string, title: string, lastModifiedMs: number, steps: object[]}>}
 */
export function loadExternalDeepStatsCache({ coveredByLive = null, targetCascadeId = '' } = {}) {
  const { sig, existingFiles } = computeDeepStatsFilesSig();
  if (existingFiles.length === 0) {
    return new Map();
  }
  const targetCidLower = String(targetCascadeId || '').trim().toLowerCase();
  const isSingleTargetLookup = Boolean(targetCidLower);
  const allowPrune = !isSingleTargetLookup && coveredByLive instanceof Map;

  if (!isSingleTargetLookup && externalDeepStatsMemo.sig === sig && externalDeepStatsMemo.loaded) {
    if (!externalDeepStatsMemo.pruned) {
      return externalDeepStatsMemo.convos;
    }
    if (
      allowPrune &&
      isDeepStatsCoveragePairsSatisfied(externalDeepStatsMemo.coveredPairs, coveredByLive)
    ) {
      return externalDeepStatsMemo.convos;
    }
  }

  // 常规聚合冷启动快路径：若上次已验证 100% 会话都被本地账本覆盖且本次逐条校验仍满足，直接跳过整文件 JSON 读取
  if (allowPrune && !isVirtualDeepStatsMemoPath(DEEP_STATS_COVERAGE_MEMO_FILE)) {
    const persisted = loadJson(DEEP_STATS_COVERAGE_MEMO_FILE, null);
    if (
      persisted &&
      persisted.version === 1 &&
      persisted.sig === sig &&
      Array.isArray(persisted.coveredPairs) &&
      isDeepStatsCoveragePairsSatisfied(persisted.coveredPairs, coveredByLive)
    ) {
      externalDeepStatsMemo.sig = sig;
      externalDeepStatsMemo.loaded = true;
      externalDeepStatsMemo.pruned = true;
      externalDeepStatsMemo.coveredPairs = persisted.coveredPairs;
      externalDeepStatsMemo.convos = new Map();
      return externalDeepStatsMemo.convos;
    }
  }

  const convos = new Map();
  const coveredPairs = allowPrune ? [] : null;
  const coveredMap = allowPrune ? new Map() : null;
  const runtimeDisplayMap = new Map();
  const extStringPool = new Map();
  const internExtStr = (val) => {
    if (typeof val !== 'string' || val.length === 0) return '';
    if (val.length > 96) return val;
    const hit = extStringPool.get(val);
    if (hit !== undefined) return hit;
    if (extStringPool.size >= 4096) extStringPool.clear();
    extStringPool.set(val, val);
    return val;
  };

  for (const filePath of existingFiles) {
    const raw = loadJson(filePath, null);
    if (!raw || typeof raw.perConvo !== 'object' || !raw.perConvo) continue;
    const fileAccountName = internExtStr(String(raw.accountName || raw.email || '').trim());

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
        const base = internExtStr(getBaseModelLabel(display));
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
      const appSource = internExtStr(
        item?.appSource || (colonIdx > 0 ? fullKey.slice(0, colonIdx) : 'ide')
      );
      const cascadeId = (colonIdx > 0 ? fullKey.slice(colonIdx + 1) : fullKey).toLowerCase();
      if (isSingleTargetLookup && cascadeId !== targetCidLower) continue;
      const mapKey = `${appSource}:${cascadeId}`;
      const existing = convos.get(mapKey);
      if (existing && existing.steps.length >= rawEntries.length) continue;

      const itemAccountName = internExtStr(
        String(item?.accountName || item?.email || fileAccountName || '').trim()
      );
      const resolvedTitle = titleMap[fullKey] || titleMap[cascadeId] || cascadeId.slice(0, 8);

      // 若本地账本已持有 >= 该条目全部有效步骤，则跳过构建重型 steps 数组
      if (allowPrune) {
        const liveEntry = coveredByLive.get(cascadeId);
        const liveLen = liveEntry?.steps?.length || 0;
        if (liveEntry && liveLen > 0) {
          let validStepCount = 0;
          for (let idx = 0; idx < rawEntries.length; idx += 1) {
            const e = rawEntries[idx];
            const inp = Math.max(0, Math.floor(Number(e?.inp) || 0));
            const cache = Math.max(0, Math.floor(Number(e?.cache) || 0));
            const out =
              Math.max(0, Math.floor(Number(e?.out) || 0)) +
              Math.max(0, Math.floor(Number(e?.reasoning) || 0));
            if (inp > 0 || cache > 0 || out > 0) validStepCount += 1;
          }
          if (validStepCount === 0) continue;
          if (liveLen >= validStepCount) {
            const needsAcc = Boolean(itemAccountName);
            const needsTitle = Boolean(resolvedTitle && resolvedTitle !== cascadeId.slice(0, 8));
            if ((!needsAcc || liveEntry.accountName) && (!needsTitle || liveEntry.title)) {
              const prevRec = coveredMap.get(cascadeId);
              if (!prevRec) {
                coveredMap.set(cascadeId, [
                  cascadeId,
                  validStepCount,
                  needsAcc ? 1 : 0,
                  needsTitle ? 1 : 0,
                ]);
              } else {
                if (validStepCount > prevRec[1]) prevRec[1] = validStepCount;
                if (needsAcc) prevRec[2] = 1;
                if (needsTitle) prevRec[3] = 1;
              }
              continue;
            }
            // 步骤已覆盖但本地缺 accountName / title：仅保留零步骤的轻量元数据存根
            if (!existing) {
              convos.set(mapKey, {
                cascadeId,
                appSource,
                accountName: itemAccountName,
                title: resolvedTitle,
                lastModifiedMs: 0,
                steps: [],
              });
            }
            continue;
          }
        }
      }

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
        const resolvedDisplay = internExtStr(
          safeStepDisplayName ||
            stepIntrinsicLabel ||
            runtimeDisplayMap.get(e?.model) ||
            runtimeDisplayMap.get(e?.modelRuntimeId) ||
            formatGenericModelSlug(e?.modelAggregationId) ||
            ''
        );
        const rawUpstreamCandidate = String(e?.model || e?.modelCanonicalId || '').trim();
        const inferredResponseModel =
          /^session:/i.test(String(e?.modelAggregationId || '')) &&
          rawUpstreamCandidate &&
          !/^MODEL_/i.test(rawUpstreamCandidate) &&
          !/\s/.test(rawUpstreamCandidate)
            ? internExtStr(rawUpstreamCandidate)
            : '';
        steps.push({
          stepIndex: idx + 1,
          createdAtMs,
          modelKey: internExtStr(
            e?.modelCanonicalId || e?.model || e?.modelRuntimeId || 'unknown'
          ),
          modelDisplayName: resolvedDisplay,
          ...(inferredResponseModel ? { responseModel: inferredResponseModel } : {}),
          apiProvider: internExtStr(e?.provider || ''),
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
          title: resolvedTitle,
          lastModifiedMs,
          steps,
        });
      }
    }
  }

  if (isSingleTargetLookup) {
    return convos;
  }

  if (allowPrune) {
    for (const rec of coveredMap.values()) {
      coveredPairs.push(rec);
    }
  }

  externalDeepStatsMemo.sig = sig;
  externalDeepStatsMemo.loaded = true;
  externalDeepStatsMemo.pruned = allowPrune;
  externalDeepStatsMemo.coveredPairs = coveredPairs;
  externalDeepStatsMemo.convos = convos;

  if (
    allowPrune &&
    convos.size === 0 &&
    coveredPairs.length > 0 &&
    !isVirtualDeepStatsMemoPath(DEEP_STATS_COVERAGE_MEMO_FILE)
  ) {
    try {
      saveJson(DEEP_STATS_COVERAGE_MEMO_FILE, {
        version: 1,
        sig,
        coveredPairs,
      });
    } catch {
      // 忽略覆盖跳过缓存落盘异常
    }
  }

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
const MAX_PRESERVED_BREAKDOWN_STEPS = 64;

function extractStaticContextFromStep(st) {
  const bd = st?.contextBreakdown;
  if (!bd || typeof bd !== 'object') return null;
  const sysPrompt = Math.max(0, Number(bd.systemPromptTokens || 0));
  const sysTools = Math.max(0, Number(bd.systemToolsTokens || 0));
  const mcpTools = Math.max(0, Number(bd.mcpToolsTokens || 0));
  const skills = Math.max(0, Number(bd.skillsTokens || 0));
  const userRules = Math.max(0, Number(bd.userRulesTokens || 0));
  const staticSum = sysPrompt + sysTools + mcpTools + skills + userRules;
  if (staticSum <= 0) return null;

  const rawTotal =
    Number(bd.totalTokens || 0) ||
    staticSum +
      Math.max(0, Number(bd.messagesTokens || 0)) ||
    staticSum +
      Math.max(0, Number(bd.userInputTokens || 0)) +
      Math.max(0, Number(bd.assistantTokens || 0)) +
      Math.max(0, Number(bd.toolResultsTokens || 0)) +
      Math.max(0, Number(bd.subagentTokens || 0)) +
      Math.max(0, Number(bd.checkpointTokens || 0));
  const promptTokens =
    Math.max(0, Number(st?.inputTokens || 0)) + Math.max(0, Number(st?.cacheReadTokens || 0));
  const scale =
    rawTotal > 0 && promptTokens >= rawTotal * 0.5 ? promptTokens / rawTotal : 1;

  return {
    systemPromptTokens: Math.round(sysPrompt * scale),
    systemToolsTokens: Math.round(sysTools * scale),
    mcpToolsTokens: Math.round(mcpTools * scale),
    skillsTokens: Math.round(skills * scale),
    userRulesTokens: Math.round(userRules * scale),
  };
}

function isSameHistoricalStep(nextStep, prevStep) {
  if (!nextStep || !prevStep || typeof nextStep !== 'object' || typeof prevStep !== 'object') {
    return false;
  }
  if (Number(nextStep.stepIndex) !== Number(prevStep.stepIndex)) return false;
  if (Boolean(nextStep.isCompactionStep) !== Boolean(prevStep.isCompactionStep)) return false;
  if (
    Number(nextStep.inputTokens || 0) !== Number(prevStep.inputTokens || 0) ||
    Number(nextStep.cacheReadTokens || 0) !== Number(prevStep.cacheReadTokens || 0) ||
    Number(nextStep.outputTokens || 0) !== Number(prevStep.outputTokens || 0)
  ) {
    return false;
  }
  const nextTs = Number(nextStep.createdAtMs || 0);
  const prevTs = Number(prevStep.createdAtMs || 0);
  if (nextTs > 0 && prevTs > 0 && Math.abs(nextTs - prevTs) > 2000) {
    return false;
  }
  return true;
}

function isSameStepSlot(nextStep, prevStep) {
  if (!nextStep || !prevStep || typeof nextStep !== 'object' || typeof prevStep !== 'object') {
    return false;
  }
  if (Number(nextStep.stepIndex) !== Number(prevStep.stepIndex)) return false;
  if (Boolean(nextStep.isCompactionStep) !== Boolean(prevStep.isCompactionStep)) return false;
  if (Boolean(nextStep.isImageGenStep) !== Boolean(prevStep.isImageGenStep)) return false;
  const nextTs = Number(nextStep.createdAtMs || 0);
  const prevTs = Number(prevStep.createdAtMs || 0);
  if (nextTs > 0 && prevTs > 0) {
    if (Math.abs(nextTs - prevTs) > 2000) return false;
    if (
      nextTs !== prevTs &&
      prevStep.isComplete === true &&
      nextStep.isComplete === true &&
      (Number(nextStep.inputTokens || 0) !== Number(prevStep.inputTokens || 0) ||
        Number(nextStep.cacheReadTokens || 0) !== Number(prevStep.cacheReadTokens || 0) ||
        Number(nextStep.outputTokens || 0) !== Number(prevStep.outputTokens || 0))
    ) {
      return false;
    }
    return true;
  }
  const prevHasTokens =
    Number(prevStep.inputTokens || 0) +
      Number(prevStep.cacheReadTokens || 0) +
      Number(prevStep.outputTokens || 0) >
    0;
  if (
    prevHasTokens &&
    prevStep.isComplete !== false &&
    (Number(nextStep.inputTokens || 0) !== Number(prevStep.inputTokens || 0) ||
      Number(nextStep.cacheReadTokens || 0) !== Number(prevStep.cacheReadTokens || 0) ||
      Number(nextStep.outputTokens || 0) !== Number(prevStep.outputTokens || 0))
  ) {
    return false;
  }
  return true;
}

/**
 * 宿主执行「撤销到此处」回退对话分支时，保留已发生过的历史调用步骤并标记 `isReverted: true`，
 * 确保历史 Token / 费用 / 额度统计不回缩，同时支持回退后继续在同一 `stepIndex` 上分叉产生新步骤。
 */
function mergeRetainedRevertedSteps(liveSteps, prev) {
  const safeLive = Array.isArray(liveSteps) ? liveSteps : [];
  if (!prev || prev.offlineTranscriptFallback) return safeLive;
  const isLegacySchemaPrev =
    !prev.contextLimitTelemetry ||
    !prev.speedClearedTelemetry ||
    !prev.turnRailTelemetry ||
    Number(prev.contextGroupsTelemetry || 0) < 3 ||
    !prev.anomalyTelemetry ||
    !prev.imageGenTelemetry;
  if (isLegacySchemaPrev) return safeLive;
  const prevSteps = Array.isArray(prev.steps) ? prev.steps : [];
  if (prevSteps.length === 0) return safeLive;

  const liveByIndex = new Map();
  for (const st of safeLive) {
    if (!st || typeof st !== 'object') continue;
    const idx = Number(st.stepIndex);
    if (Number.isFinite(idx)) {
      liveByIndex.set(idx, st);
    }
  }

  const retainedReverted = [];
  for (const ps of prevSteps) {
    if (!ps || typeof ps !== 'object') continue;
    const idx = Number(ps.stepIndex);
    const liveMatch = Number.isFinite(idx) ? liveByIndex.get(idx) : null;
    if (ps.isReverted) {
      if (liveMatch && isSameHistoricalStep(liveMatch, ps)) {
        continue;
      }
      retainedReverted.push(ps);
      continue;
    }
    if (!liveMatch || !isSameStepSlot(liveMatch, ps)) {
      retainedReverted.push({ ...ps, isReverted: true });
    }
  }

  if (retainedReverted.length === 0) return safeLive;

  const merged = [...safeLive, ...retainedReverted];
  merged.sort((a, b) => {
    const ta = Number(a?.createdAtMs || 0);
    const tb = Number(b?.createdAtMs || 0);
    if (ta !== tb) return ta - tb;
    const ia = Number(a?.stepIndex ?? 0);
    const ib = Number(b?.stepIndex ?? 0);
    if (ia !== ib) return ia - ib;
    return (a?.isReverted ? 0 : 1) - (b?.isReverted ? 0 : 1);
  });
  return merged;
}

/**
 * 宿主只保留末尾一条完整 `gen_metadata` 并裁剪历史拆解；对话运行或回退重扫时，
 * 为当前活跃窗口内（最近压缩前锚点至末尾，最多保留 64 步）完全匹配的未变更历史步保留已缓存的 `contextBreakdown`，
 * 同时维护紧凑的 5 通道静态基线，确保回退到任意较早轮次后上下文窗口拆解不归零。
 */
function preserveCachedContextTelemetry(steps, prev) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return {
      steps,
      lastKnownStaticContext: prev?.lastKnownStaticContext || null,
    };
  }

  let preservedSteps = steps;
  const prevSteps = Array.isArray(prev?.steps) ? prev.steps : [];
  if (prevSteps.length > 0) {
    const prevWithBdByIdx = new Map();
    for (const ps of prevSteps) {
      if (!ps || typeof ps !== 'object' || !ps.contextBreakdown) continue;
      const idx = Number(ps.stepIndex);
      if (Number.isFinite(idx) && (!ps.isReverted || !prevWithBdByIdx.has(idx))) {
        prevWithBdByIdx.set(idx, ps);
      }
    }

    if (prevWithBdByIdx.size > 0) {
      let lastCompIdx = -1;
      for (let i = steps.length - 1; i >= 0; i -= 1) {
        if (steps[i]?.isCompactionStep) {
          lastCompIdx = i;
          break;
        }
      }
      let keepStartIdx = Math.max(0, steps.length - MAX_PRESERVED_BREAKDOWN_STEPS);
      if (lastCompIdx >= 0) {
        const anchorIdx = Math.max(0, lastCompIdx - 1);
        keepStartIdx = Math.max(keepStartIdx, anchorIdx);
      }

      let mutated = false;
      const nextList = steps.map((st, pos) => {
        if (!st || st.isCompactionStep || st.contextBreakdown || pos < keepStartIdx) {
          return st;
        }
        const idx = Number(st.stepIndex);
        const matchedPrev = Number.isFinite(idx) ? prevWithBdByIdx.get(idx) : null;
        if (!matchedPrev || !isSameHistoricalStep(st, matchedPrev)) {
          return st;
        }
        mutated = true;
        return {
          ...st,
          contextBreakdown: matchedPrev.contextBreakdown,
          ...(!st.reportedContextLimitTokens && matchedPrev.reportedContextLimitTokens
            ? {
                reportedContextLimitTokens: matchedPrev.reportedContextLimitTokens,
                maxContextBudgetTokens: matchedPrev.maxContextBudgetTokens,
              }
            : {}),
        };
      });
      if (mutated) {
        preservedSteps = nextList;
      }
    }
  }

  let lastKnownStaticContext = null;
  for (let i = preservedSteps.length - 1; i >= 0; i -= 1) {
    const extracted = extractStaticContextFromStep(preservedSteps[i]);
    if (extracted) {
      lastKnownStaticContext = extracted;
      break;
    }
  }
  if (!lastKnownStaticContext && prev?.lastKnownStaticContext) {
    lastKnownStaticContext = prev.lastKnownStaticContext;
  }

  return { steps: preservedSteps, lastKnownStaticContext };
}

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
      if (!ps.isReverted) {
        prevByIndex.set(idx, ps);
      }
      if (idx > maxPrevStepIndex) maxPrevStepIndex = idx;
    }
    const cMs = Number(ps.createdAtMs || 0);
    if (cMs > maxPrevCreatedAtMs) maxPrevCreatedAtMs = cMs;
  }

  let mutated = false;
  const out = steps.map((s) => {
    const idx = Number(s?.stepIndex);
    const candidatePrev = Number.isFinite(idx) ? prevByIndex.get(idx) : null;
    const matchedPrev = candidatePrev && isSameStepSlot(s, candidatePrev) ? candidatePrev : null;
    let stepOwner = '';
    if (matchedPrev) {
      stepOwner = normalizeOwnerAccount(matchedPrev.accountName) || prevOwner;
    } else {
      const cMs = Number(s?.createdAtMs || 0);
      const isHistoricalBackfill =
        (!candidatePrev && Number.isFinite(idx) && maxPrevStepIndex >= 0 && idx <= maxPrevStepIndex) ||
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
/**
 * 将旧版缓存签名中 0 字节 `.db-wal` 的非零 mtime 规范化为 `|0:0`（仅当主库签名和 `walSize=0` 完全一致时生效），
 * 避免从 PR #38 前升级后把数百个未变更的本地 SQLite 历史库一次性全部重扫。
 *
 * @param {string} sigStr
 * @returns {string}
 */
export function normalizeEmptyWalSqliteSig(sigStr) {
  const s = String(sigStr || '');
  if (!s.includes(':sqlite:')) return s;
  return s.replace(/\|\d+:0(?=~fb:|$)/, '|0:0');
}

const MAX_SUBAGENT_RECONCILE_DEPTH = 4;
const FAILED_RPC_COOLDOWN_MS = 60_000;
const ACTIVE_FAILED_RPC_COOLDOWN_MS = 15_000;
const REMOTE_FAILED_RPC_COOLDOWN_MS = 15 * 60_000;
const REMOTE_ACTIVE_FAILED_RPC_COOLDOWN_MS = 30_000;
const NOT_FOUND_RPC_COOLDOWN_MS = 30 * 60_000;
const REMOTE_TRAJECTORY_RPC_TIMEOUT_MS = 12_000;
const REMOTE_POLL_TRAJECTORY_BUDGET_MS = 18_000;
const REMOTE_MIN_REMAINING_BUDGET_MS = 2_500;
const REMOTE_BACKGROUND_FETCH_LIMIT = 2;
const REMOTE_CONSECUTIVE_TIMEOUT_BREAKER = 2;
const TRANSCRIPT_TAIL_MAX_BYTES = 96 * 1024;
const MAX_TRANSCRIPT_MEMO_ENTRIES = 64;
const LS_SCAN_TIME_SLICE_MS = 12;
const LS_SCAN_CHUNK_FLUSH_SIZE = 20;
const LS_SCAN_FOREGROUND_BUDGET = 16;
const LS_SCAN_BG_DRAIN_BATCH = 16;
const LS_SCAN_BG_INTER_BATCH_DELAY_MS = 4;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const failedFetchCooldownMap = new Map();
const liveActivityMemo = new Map();
const transcriptTailMemo = new Map();
const transcriptBackfillMemo = new Map();
const stepTitleProbeMemo = new Map();
const MAX_STEP_TITLE_PROBE_MEMO = 2048;
const sqliteIncrementalCursorMap = new Map();
const MAX_SQLITE_INCREMENTAL_CURSORS = 32;
const activeTasksMemo = new Map();
const MAX_ACTIVE_TASKS_MEMO = 32;
const swarmManifestMemo = new Map();
let lastKnownLocalLiveCascadeIds = null;

let localRebuildGeneration = 0;
let localBackgroundDrainStopped = false;
let activeLocalBackgroundDrain = null;
let localRebuildBatchHook = null;
let localRebuildState = {
  armed: false,
  active: false,
  generation: 0,
  completed: 0,
  total: 0,
  remaining: 0,
  updatedAtMs: 0,
};

function lsScanCanYieldMacrotask() {
  return typeof setImmediate === 'function';
}

function lsScanYieldMacrotask() {
  if (typeof setImmediate === 'function') {
    return new Promise((resolve) => setImmediate(resolve));
  }
  return Promise.resolve();
}

const pendingBgDrainDelayWakers = new Set();

function wakePendingBackgroundDrainDelays() {
  if (pendingBgDrainDelayWakers.size === 0) return;
  for (const wake of [...pendingBgDrainDelayWakers]) {
    wake();
  }
}

function lsScanWaitUnrefDelay(delayMs = LS_SCAN_BG_INTER_BATCH_DELAY_MS) {
  if (typeof setTimeout === 'function') {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const done = () => {
        if (settled) return;
        settled = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        pendingBgDrainDelayWakers.delete(done);
        resolve();
      };
      pendingBgDrainDelayWakers.add(done);
      timer = setTimeout(done, delayMs);
      timer?.unref?.();
    });
  }
  return lsScanYieldMacrotask();
}

function lsScanCreateTimeSliceYielder(budgetMs = LS_SCAN_TIME_SLICE_MS) {
  if (!lsScanCanYieldMacrotask()) {
    return {
      maybeYield: () => null,
      forceYield: () => Promise.resolve(),
    };
  }
  const nowFn =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? () => performance.now()
      : () => Date.now();
  let sliceStartMs = nowFn();
  let pendingYield = null;
  async function waitForSliceTurn() {
    while (nowFn() - sliceStartMs >= budgetMs) {
      if (!pendingYield) {
        pendingYield = lsScanYieldMacrotask().finally(() => {
          pendingYield = null;
          sliceStartMs = nowFn();
        });
      }
      await pendingYield;
    }
  }
  return {
    maybeYield() {
      if (nowFn() - sliceStartMs < budgetMs) return null;
      return waitForSliceTurn();
    },
    forceYield() {
      if (!pendingYield) {
        pendingYield = lsScanYieldMacrotask().finally(() => {
          pendingYield = null;
          sliceStartMs = nowFn();
        });
      }
      return pendingYield;
    },
  };
}

export function getLocalRebuildGeneration() {
  return localRebuildGeneration;
}

export function setLocalBackgroundRebuildHook(hookFn) {
  localRebuildBatchHook = typeof hookFn === 'function' ? hookFn : null;
}

export function getLocalCacheRebuildStatus() {
  return {
    active: Boolean(localRebuildState.active),
    completed: Number(localRebuildState.completed || 0),
    total: Number(localRebuildState.total || 0),
    remaining: Number(localRebuildState.remaining || 0),
    updatedAtMs: Number(localRebuildState.updatedAtMs || 0),
  };
}

export function isLocalBackgroundRebuildActive() {
  return Boolean(
    localRebuildState.active || localRebuildState.armed || activeLocalBackgroundDrain
  );
}

export function resetLocalCacheRebuildState({ totalHint = 0, armed = false } = {}) {
  localRebuildGeneration += 1;
  localBackgroundDrainStopped = false;
  activeLocalBackgroundDrain = null;
  wakePendingBackgroundDrainDelays();
  const cleanTotal = Math.max(0, Math.floor(Number(totalHint) || 0));
  localRebuildState = {
    armed: Boolean(armed),
    active: false,
    generation: localRebuildGeneration,
    completed: 0,
    total: cleanTotal,
    remaining: cleanTotal,
    updatedAtMs: Date.now(),
  };
}

export async function stopLocalBackgroundCacheRebuild() {
  localBackgroundDrainStopped = true;
  localRebuildGeneration += 1;
  const pending = activeLocalBackgroundDrain;
  activeLocalBackgroundDrain = null;
  wakePendingBackgroundDrainDelays();
  localRebuildState = {
    ...localRebuildState,
    armed: false,
    active: false,
    remaining: 0,
    updatedAtMs: Date.now(),
  };
  if (pending) {
    try {
      await pending;
    } catch {
      // Ignore background drain cancellation errors during shutdown
    }
  }
}

/**
 * 收集目标端点当前仍存活的原始会话源 ID 集合（供「重建缓存」区分“存活待重扫会话”和“原对话已被删除需永久归档留存会话”）。
 *
 * @param {object|null} [endpoint=null]
 * @returns {Set<string> | null}
 */
export function collectAuthoritativeLiveCascadeIds(endpoint = null) {
  if (endpoint && endpoint.isRemote) {
    return endpoint.lastKnownLiveCascadeIds instanceof Set
      ? new Set(endpoint.lastKnownLiveCascadeIds)
      : null;
  }
  const convDirs =
    Array.isArray(CONVERSATION_DIRS) && CONVERSATION_DIRS.length > 0
      ? CONVERSATION_DIRS
      : [CONVERSATIONS_DIR];
  const hasAnyLocalConvDir = convDirs.some((d) => Boolean(d && existsSync(d)));
  localSummaryMemo.sig = '';
  localSummaryMemo.byRootsKey.clear();
  brainDirListingMemo.clear();
  knownExistingTranscriptPaths.clear();
  const diskConvMap = discoverLocalConversationFiles();
  const localSnap = readLocalSummarySnapshot();
  if (!hasAnyLocalConvDir && diskConvMap.size === 0 && !localSnap.available) {
    return lastKnownLocalLiveCascadeIds instanceof Set
      ? new Set(lastKnownLocalLiveCascadeIds)
      : null;
  }
  const liveIds = new Set();
  for (const id of diskConvMap.keys()) liveIds.add(String(id).toLowerCase());
  for (const id of localSnap.byId.keys()) liveIds.add(String(id).toLowerCase());
  const localStore = getEndpointCacheStore(null);
  const cachedEntries = localStore.listCachedTrajectoryEntries();
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const [rawKey, entry] of cachedEntries) {
      const lower = String(rawKey || '').toLowerCase();
      if (!lower) continue;
      if (liveIds.has(lower)) {
        for (const ref of entry?.subagentRefs || []) {
          const refLower = String(ref?.cascadeId || '').trim().toLowerCase();
          if (refLower && !liveIds.has(refLower)) {
            liveIds.add(refLower);
            expanded = true;
          }
        }
      } else {
        const parentLower = String(entry?.parentConversationId || entry?.parentCascadeId || '')
          .trim()
          .toLowerCase();
        const rootLower = String(entry?.rootConversationId || '').trim().toLowerCase();
        if (
          (parentLower && liveIds.has(parentLower)) ||
          (rootLower && liveIds.has(rootLower))
        ) {
          liveIds.add(lower);
          expanded = true;
        }
      }
    }
  }
  return liveIds;
}

export function clearScannerRuntimeMemos(endpointId = null, { totalHint = 0, armed = false } = {}) {
  if (endpointId && endpointId !== 'local') {
    const ep = getRegisteredRemoteEndpoint(endpointId);
    if (ep) {
      ep.failedFetchCooldownMap.clear();
      ep.liveActivityMemo.clear();
      ep.lastKnownLiveCascadeIds = null;
    }
    return;
  }
  resetLocalCacheRebuildState({ totalHint, armed });
  failedFetchCooldownMap.clear();
  liveActivityMemo.clear();
  transcriptTailMemo.clear();
  transcriptBackfillMemo.clear();
  stepTitleProbeMemo.clear();
  sqliteIncrementalCursorMap.clear();
  activeTasksMemo.clear();
  swarmManifestMemo.clear();
  brainDirListingMemo.clear();
  knownExistingTranscriptPaths.clear();
  knownBrainCascadeSet = null;
  lastKnownLocalLiveCascadeIds = null;
}

function setSqliteIncrementalCursor(cidLower, cursor) {
  if (!cidLower) return;
  sqliteIncrementalCursorMap.delete(cidLower);
  if (!cursor) return;
  if (sqliteIncrementalCursorMap.size >= MAX_SQLITE_INCREMENTAL_CURSORS) {
    const oldestKey = sqliteIncrementalCursorMap.keys().next().value;
    if (oldestKey !== undefined) sqliteIncrementalCursorMap.delete(oldestKey);
  }
  sqliteIncrementalCursorMap.set(cidLower, cursor);
}

function readCachedActiveBackgroundTasks(cidLower, dbPath, diskFileSig) {
  if (!cidLower || !dbPath) return [];
  const sig = String(diskFileSig || '');
  const cached = activeTasksMemo.get(cidLower);
  if (cached && cached.dbPath === dbPath && sig && cached.diskFileSig === sig) {
    return cached.tasks;
  }
  const tasks = readLocalSqliteActiveTasks(dbPath);
  if (activeTasksMemo.size >= MAX_ACTIVE_TASKS_MEMO && !activeTasksMemo.has(cidLower)) {
    const oldestKey = activeTasksMemo.keys().next().value;
    if (oldestKey !== undefined) activeTasksMemo.delete(oldestKey);
  }
  activeTasksMemo.set(cidLower, { dbPath, diskFileSig: sig, tasks });
  return tasks;
}

function isUserInputRawStep(step) {
  if (!step || typeof step !== 'object') return false;
  const t = String(step.type || '').toUpperCase();
  return t.includes('USER_INPUT') || Boolean(step.userInput && typeof step.userInput === 'object');
}

function resolveTurnTaskStepsFromRaw(rawSteps, prevTaskSteps = null) {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return prevTaskSteps || null;
  }
  let lastUserPos = -1;
  for (let i = rawSteps.length - 1; i >= 0; i -= 1) {
    if (isUserInputRawStep(rawSteps[i])) {
      lastUserPos = i;
      break;
    }
  }
  if (lastUserPos >= 0) {
    return extractLatestTaskSteps(rawSteps, lastUserPos + 1);
  }
  return extractLatestTaskSteps(rawSteps, 0) || prevTaskSteps || null;
}

function mergeLiveStepsWithActiveBackgroundTasks(rawSteps, activeBackgroundTasks) {
  const base = Array.isArray(rawSteps) ? rawSteps : [];
  if (!Array.isArray(activeBackgroundTasks) || activeBackgroundTasks.length === 0) {
    return base;
  }
  if (base.length === 0) {
    return activeBackgroundTasks;
  }
  const existingIdx = new Set();
  for (const st of base) {
    const idx = Number(st?.idx ?? st?.metadata?.sourceTrajectoryStepInfo?.stepIndex);
    if (Number.isFinite(idx)) existingIdx.add(idx);
  }
  const missing = [];
  for (const bg of activeBackgroundTasks) {
    const idx = Number(bg?.idx ?? bg?.metadata?.sourceTrajectoryStepInfo?.stepIndex);
    if (!Number.isFinite(idx) || !existingIdx.has(idx)) {
      missing.push(bg);
    }
  }
  return missing.length > 0 ? [...missing, ...base] : base;
}

function collectOrchestratorExecModelsFromRaw(rawSteps = [], generatorMeta = []) {
  const out = new Set();
  const collectPc = (pc) => {
    const execModel = pc?.planExecuteConfig?.executionModel;
    if (typeof execModel !== 'string' || !execModel.trim()) return;
    const cleanExec = execModel.trim();
    const cleanPlan = String(pc?.planModel || '').trim();
    if (
      /orchestrator|MODEL_PLACEHOLDER_M(?:667|681|537)\b/i.test(
        `${pc?.modelName || ''} ${cleanPlan}`
      ) ||
      (cleanPlan && cleanExec !== cleanPlan)
    ) {
      out.add(cleanExec);
    }
  };
  for (const gm of generatorMeta || []) {
    collectPc(gm?.plannerConfig);
  }
  for (const st of rawSteps || []) {
    const inlineList = st?.metadata?.generatorMetadata;
    if (Array.isArray(inlineList)) {
      for (const g of inlineList) collectPc(g?.plannerConfig);
    }
  }
  return Array.from(out);
}

function findLastExplicitDonorStep(steps, maxCount) {
  const limit = Math.min(Array.isArray(steps) ? steps.length : 0, maxCount);
  for (let i = limit - 1; i >= 0; i -= 1) {
    const st = steps[i];
    if (
      st &&
      !st.isImageGenStep &&
      st.modelKey &&
      st.modelKey !== 'unknown' &&
      st.modelSource !== 'inferred_compaction' &&
      st.modelSource !== 'legacy_unverified'
    ) {
      return st;
    }
  }
  return null;
}

/**
 * 为已完整解析的本地 SQLite 会话构建无损增量尾读游标：
 * 切点落在倒数第 3 条已完成且非压缩的模型步（`M_cut`），保证 `M_cut` 及之前的所有步骤均已闭合
 * （不会再挂接尾部错误、不会触发末尾 `contextBreakdown` 回填、也不等待后向压缩捐赠者）。
 */
function buildSqliteIncrementalCursor({
  trajRes,
  rawSteps,
  generatorMeta,
  extractedSteps,
  mergedSteps,
  subagentRefs,
  rpcSwarmMeta,
  prevCursor = null,
}) {
  if (!trajRes || trajRes.hasForeignOriginSteps || rpcSwarmMeta) {
    return null;
  }
  if (!Array.isArray(extractedSteps) || extractedSteps.length < 8) {
    return null;
  }
  if (!Array.isArray(mergedSteps) || mergedSteps.some((st) => Boolean(st?.isReverted))) {
    return null;
  }

  // 仅当存在至少 2 条后续模型步保护切点且切点与下一模型步之间无悬挂错误步时才切分，保证前缀 100% 不可变
  const errorRawIdxSet = new Set();
  for (const s of rawSteps || []) {
    const t = String(s?.type || '').trim().toUpperCase();
    if (
      t === 'CORTEX_STEP_TYPE_ERROR_MESSAGE' ||
      t === 'ERROR_MESSAGE' ||
      Boolean(s?.errorMessage && typeof s.errorMessage === 'object')
    ) {
      const eIdx = Number(s?.idx ?? s?.metadata?.sourceTrajectoryStepInfo?.stepIndex);
      if (Number.isFinite(eIdx)) errorRawIdxSet.add(eIdx);
    }
  }
  const hasErrorBetween = (afterIdx, beforeIdx) => {
    if (errorRawIdxSet.size === 0) return false;
    for (const eIdx of errorRawIdxSet) {
      if (eIdx > afterIdx && eIdx < beforeIdx) return true;
    }
    return false;
  };
  let cutModelPos = -1;
  for (let i = extractedSteps.length - 3; i >= 0; i -= 1) {
    const cand = extractedSteps[i];
    const nextModel = extractedSteps[i + 1];
    if (
      cand &&
      cand.isComplete === true &&
      !cand.isCompactionStep &&
      Number.isFinite(Number(cand.stepIndex)) &&
      Number.isFinite(Number(nextModel?.stepIndex)) &&
      !hasErrorBetween(Number(cand.stepIndex), Number(nextModel.stepIndex))
    ) {
      cutModelPos = i;
      break;
    }
  }
  if (cutModelPos < 4) return null;

  const cutStep = extractedSteps[cutModelPos];
  const stableRawIdx = Math.floor(Number(cutStep.stepIndex));

  // 统计 rawSteps 中 idx <= stableRawIdx 的精确行数及切点前的原始信息
  let stableRawRowCount = 0;
  let prefixSubagentRefs = [];
  let hasHumanUserTurn = Boolean(prevCursor?.hasHumanUserTurn);
  let lastCompactionStepIdx = Number.isFinite(Number(prevCursor?.lastCompactionStepIdx))
    ? Number(prevCursor.lastCompactionStepIdx)
    : -1;
  if (prevCursor && trajRes.incremental) {
    let addedPrefixRows = 0;
    const newlyFrozenRaw = [];
    for (const s of rawSteps || []) {
      const idx = Number(s?.idx ?? s?.metadata?.sourceTrajectoryStepInfo?.stepIndex);
      if (!Number.isFinite(idx) || idx > stableRawIdx) break;
      addedPrefixRows += 1;
      newlyFrozenRaw.push(s);
      if (
        !hasHumanUserTurn &&
        (s?.type === 'CORTEX_STEP_TYPE_USER_INPUT' ||
          s?.type === 'USER_INPUT' ||
          (s?.userInput && typeof s.userInput === 'object'))
      ) {
        hasHumanUserTurn = true;
      }
    }
    if (addedPrefixRows === 0) {
      // 切点尚未前移，直接沿用原切点仅刷新 stepsRef 与最新任务步骤清单
      const nextTaskSteps = resolveTurnTaskStepsFromRaw(rawSteps, prevCursor.lastTaskSteps || null);
      return {
        ...prevCursor,
        stepsRef: mergedSteps,
        ...(nextTaskSteps ? { lastTaskSteps: nextTaskSteps } : { lastTaskSteps: null }),
      };
    }
    stableRawRowCount = prevCursor.stableRawRowCount + addedPrefixRows;
    const mergedRefs = Array.isArray(prevCursor.prefixSubagentRefs)
      ? prevCursor.prefixSubagentRefs.slice()
      : [];
    const seen = new Set(mergedRefs.map((r) => r.cascadeId));
    for (const r of extractSubagentRefsFromSteps(newlyFrozenRaw)) {
      if (!seen.has(r.cascadeId)) {
        seen.add(r.cascadeId);
        mergedRefs.push(r);
      }
    }
    prefixSubagentRefs = mergedRefs;
  } else {
    if (!Array.isArray(rawSteps) || rawSteps.length < 64) {
      return null;
    }
    const prefixRaw = [];
    for (const s of rawSteps) {
      const idx = Number(s?.idx ?? s?.metadata?.sourceTrajectoryStepInfo?.stepIndex);
      if (!Number.isFinite(idx) || idx > stableRawIdx) break;
      prefixRaw.push(s);
      if (
        !hasHumanUserTurn &&
        (s?.type === 'CORTEX_STEP_TYPE_USER_INPUT' ||
          s?.type === 'USER_INPUT' ||
          (s?.userInput && typeof s.userInput === 'object'))
      ) {
        hasHumanUserTurn = true;
      }
    }
    if (prefixRaw.length === 0) return null;
    stableRawRowCount = prefixRaw.length;
    prefixSubagentRefs = extractSubagentRefsFromSteps(prefixRaw);
  }

  for (let i = 0; i <= cutModelPos; i += 1) {
    const st = extractedSteps[i];
    if (st?.isCompactionStep && Number.isFinite(Number(st.stepIndex))) {
      lastCompactionStepIdx = Math.max(lastCompactionStepIdx, Number(st.stepIndex));
    }
  }

  const stableModelStepsCount = cutModelPos + 1;
  const turnCounter = Number.isFinite(Number(cutStep.turnIndex)) ? Number(cutStep.turnIndex) : 0;
  const activeTurnIndex = cutStep.turnIndex ?? null;
  const orchSet = new Set([
    ...(Array.isArray(prevCursor?.orchestratorExecModels) ? prevCursor.orchestratorExecModels : []),
    ...collectOrchestratorExecModelsFromRaw(rawSteps, generatorMeta),
  ]);

  // 保留最近 4 条 gen_metadata 留给下次增量查询重读，确保边界步总能命中对应 gen_metadata
  const stableMaxGenIdx = Math.max(-1, Number(trajRes.maxGenIdx ?? -1) - 4);
  const lastTaskSteps = resolveTurnTaskStepsFromRaw(
    rawSteps,
    prevCursor?.lastTaskSteps || null
  );

  return {
    stepsRef: mergedSteps,
    stableRawIdx,
    stableRawRowCount,
    stableModelStepsCount,
    stableMaxGenIdx,
    turnCounter,
    activeTurnIndex,
    hasHumanUserTurn,
    lastCompactionStepIdx,
    lastKnownGmStepIdx: stableRawIdx,
    orchestratorExecModels: Array.from(orchSet),
    lastExplicitDonorStep: findLastExplicitDonorStep(extractedSteps, stableModelStepsCount),
    lastTaskSteps,
    prefixSubagentRefs,
    isChildTrajectory: Boolean(trajRes.isChildTrajectory),
    isSideQuestion: Boolean(trajRes.isSideQuestion),
    trajectoryType: Number(trajRes.trajectoryType || 0),
    forkParentConversationId: trajRes.forkParentConversationId || '',
    firstOwnUserPrompt: trajRes.firstOwnUserPrompt || '',
    rootConversationId: trajRes.rootConversationId || '',
    parentConversationId: trajRes.parentConversationId || '',
    trajectoryMetadata: trajRes.trajectory?.metadata || null,
  };
}

function findSwarmMembersPath(cascadeId) {
  if (!cascadeId) return '';
  const normId = String(cascadeId).trim().toLowerCase();
  if (!UUID_RE.test(normId)) return '';
  const dirs = Array.isArray(BRAIN_DIRS) && BRAIN_DIRS.length > 0 ? BRAIN_DIRS : [BRAIN_DIR];
  if (
    knownBrainCascadeSet &&
    knownBrainCascadeSetRootsKey === dirs.join('|') &&
    !knownBrainCascadeSet.has(normId)
  ) {
    return '';
  }
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
    const candidate = resolveTranscriptPathInLogsDir(
      join(dir, normId, '.system_generated', 'logs')
    );
    if (!candidate) continue;
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
  return extractShortPromptTitle(rawContent, 48, { firstLineOnly: true });
}

const MAX_TITLE_PROBE_CACHE = 2000;
const titleProbeCache = new Map();

function isMeaningfulTitle(rawTitle, cidLower = '') {
  const clean = String(rawTitle || '').trim();
  if (!clean) return false;
  const low = clean.toLowerCase();
  if (cidLower && (low === cidLower || low === cidLower.slice(0, 8))) return false;
  if (UUID_RE.test(clean)) return false;
  return true;
}

function pickFirstMeaningfulTitle(cidLower, candidates = []) {
  for (const cand of candidates) {
    if (isMeaningfulTitle(cand, cidLower)) {
      return String(cand).trim();
    }
  }
  return '';
}

function extractFirstStepTurnTitle(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return '';
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    if (!st) continue;
    const raw = st.turnPromptClean || st.turnPrompt || '';
    if (!raw) continue;
    const title = extractOfflineUserTitle(raw);
    if (title) return title;
  }
  return '';
}

function readLocalTranscriptHeadTitle(cidLower) {
  if (!cidLower || !UUID_RE.test(cidLower)) return '';
  const transcriptPath = findTranscriptPath(cidLower);
  if (!transcriptPath || !existsSync(transcriptPath)) return '';
  try {
    const fd = openSync(transcriptPath, 'r');
    let chunk = '';
    try {
      const buf = Buffer.allocUnsafe(32768);
      const bytesRead = readSync(fd, buf, 0, buf.length, 0);
      if (bytesRead > 0) chunk = buf.toString('utf8', 0, bytesRead);
    } finally {
      closeSync(fd);
    }
    if (!chunk) return '';
    for (const rawLine of chunk.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!trimmed || !trimmed.startsWith('{')) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const upperType = String(parsed?.type || '').toUpperCase();
      if (
        upperType === 'USER_INPUT' ||
        upperType === 'CORTEX_STEP_TYPE_USER_INPUT' ||
        (parsed?.userInput && typeof parsed.userInput === 'object')
      ) {
        const title = extractOfflineUserTitle(
          typeof parsed.content === 'string'
            ? parsed.content
            : parsed.userInput?.userResponse || ''
        );
        if (title) return title;
      }
    }
  } catch {
    // 忽略单文件头部读取异常
  }
  return '';
}

function probeLocalFallbackTitle(cidLower, mtimeSig = 0) {
  if (!cidLower) return '';
  const sig = Number(mtimeSig) || 0;
  const cached = titleProbeCache.get(cidLower);
  if (cached && cached.sig === sig) {
    return cached.title;
  }
  const annTitle = readAnnotationTitleForCascade(cidLower);
  const resolved = isMeaningfulTitle(annTitle, cidLower)
    ? String(annTitle).trim()
    : readLocalTranscriptHeadTitle(cidLower);
  const finalTitle = isMeaningfulTitle(resolved, cidLower) ? String(resolved).trim() : '';
  if (titleProbeCache.size >= MAX_TITLE_PROBE_CACHE && !titleProbeCache.has(cidLower)) {
    const oldestKey = titleProbeCache.keys().next().value;
    if (oldestKey !== undefined) titleProbeCache.delete(oldestKey);
  }
  titleProbeCache.set(cidLower, { sig, title: finalTitle });
  return finalTitle;
}

function hasLocalSqliteDb(diskFiles = []) {
  return Array.isArray(diskFiles) && diskFiles.some((f) => /\.db$/i.test(String(f || '')));
}

function hasLocalPbFile(diskFiles = []) {
  return Array.isArray(diskFiles) && diskFiles.some((f) => /\.pb$/i.test(String(f || '')));
}

/**
 * 计算本地 `.pb` 与 `transcript.jsonl` 辅助轨迹文件的复合签名（`mtimeMs + size`）。
 * 仅在会话不存在有效 SQLite 主库、或同时存在 `.pb` / 处于 `offlineTranscriptFallback` 模式时按需调用，
 * 确保主 `.db` 因 `database is locked` 沦为空壳而实际数据写入 `.pb` + `transcript.jsonl` 时仍能实时感知变更。
 *
 * @param {string[]} [diskFiles=[]]
 * @returns {{ mtimeMs: number, sig: string }}
 */
function computeFallbackDiskInfo(diskFiles = []) {
  if (!Array.isArray(diskFiles) || diskFiles.length === 0) {
    return { mtimeMs: 0, sig: '' };
  }
  let mtimeMs = 0;
  const parts = [];
  for (const rawPath of diskFiles) {
    const p = String(rawPath || '').trim();
    const isPb = /\.pb$/i.test(p);
    const isTranscript = /\.jsonl$/i.test(p);
    if (!isPb && !isTranscript) continue;
    try {
      const fullPath = /[\\/]|^[a-zA-Z]:/.test(p) ? p : join(CONVERSATIONS_DIR, p);
      const st = statSync(fullPath, { throwIfNoEntry: false });
      if (!st) continue;
      const m = Number(st.mtimeMs || 0);
      const sz = Number(st.size || 0);
      if (m > mtimeMs) mtimeMs = m;
      parts.push(`${isPb ? 'p' : 't'}:${Math.floor(m)}:${sz}`);
    } catch {
      // 忽略单文件瞬时 stat 异常
    }
  }
  if (parts.length > 1) parts.sort();
  return { mtimeMs, sig: parts.join(',') };
}

function resolveBestSqliteDbInfo(diskFiles = [], { skipMissingWalFromListing = false } = {}) {
  if (!Array.isArray(diskFiles) || diskFiles.length === 0) return null;
  let walPathsLower = null;
  if (skipMissingWalFromListing) {
    for (const rawPath of diskFiles) {
      const s = String(rawPath || '').trim();
      if (/\.db-wal$/i.test(s)) {
        if (!walPathsLower) walPathsLower = new Set();
        const fullWal = /[\\/]|^[a-zA-Z]:/.test(s) ? s : join(CONVERSATIONS_DIR, s);
        walPathsLower.add(fullWal.toLowerCase());
      }
    }
  }
  let best = null;
  for (const rawPath of diskFiles) {
    const p = String(rawPath || '').trim();
    if (!/\.db$/i.test(p)) continue;
    const fullPath = /[\\/]|^[a-zA-Z]:/.test(p) ? p : join(CONVERSATIONS_DIR, p);
    const skipWalCheck =
      skipMissingWalFromListing &&
      (!walPathsLower || !walPathsLower.has(`${fullPath.toLowerCase()}-wal`));
    const walInfo = computeSqliteWalSig(fullPath, { skipWalCheck });
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

const TRANSCRIPT_BACKFILL_STREAM_THRESHOLD_BYTES = 512 * 1024;
const TRANSCRIPT_BACKFILL_CHUNK_BYTES = 256 * 1024;

function parseTranscriptStepIndexFast(lineStr) {
  const keyPos = lineStr.indexOf('"step_index"');
  if (keyPos < 0) return null;
  let pos = keyPos + 12;
  const len = lineStr.length;
  while (pos < len && (lineStr.charCodeAt(pos) === 32 || lineStr.charCodeAt(pos) === 9 || lineStr.charCodeAt(pos) === 58)) {
    pos += 1;
  }
  if (pos >= len) return null;
  const start = pos;
  while (pos < len) {
    const ch = lineStr.charCodeAt(pos);
    if (ch >= 48 && ch <= 57) {
      pos += 1;
    } else {
      break;
    }
  }
  if (pos === start) return null;
  const n = Number(lineStr.slice(start, pos));
  return Number.isFinite(n) ? n : null;
}

function buildCompactTranscriptPatch(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const patch = {};
  let hasAny = false;
  if (typeof parsed.content === 'string' && parsed.content.length > 0) {
    patch.content = parsed.content.length > 4096 ? parsed.content.slice(0, 4096) : parsed.content;
    hasAny = true;
  }
  if (parsed.userInput && typeof parsed.userInput === 'object') {
    patch.userInput = parsed.userInput;
    hasAny = true;
  }
  if (Array.isArray(parsed.media) && parsed.media.length > 0) {
    patch.media = parsed.media;
    hasAny = true;
  }
  const fallbackModel = String(parsed.model || parsed.generator_model || '').trim();
  if (fallbackModel) {
    patch.model = fallbackModel;
    hasAny = true;
  }
  return hasAny ? patch : null;
}

function scanTranscriptBackfillLines(
  transcriptPath,
  { startOffset = 0, fileSize = 0, startLineOrdinal = 0, neededIdxSet, needFirstUserTitle }
) {
  let firstUserTitle = '';
  let lineOrdinal = startLineOrdinal;
  let maxScannedIdx = -1;
  let scannedBytes = startOffset;
  const patchesByIdx = new Map();

  const processLine = (rawLine) => {
    const trimmed = rawLine.trim();
    if (!trimmed) return;
    const curOrd = lineOrdinal;
    lineOrdinal += 1;

    const fastIdx = parseTranscriptStepIndexFast(trimmed);
    const effectiveIdx = fastIdx !== null ? fastIdx : curOrd;
    if (effectiveIdx > maxScannedIdx) maxScannedIdx = effectiveIdx;

    const wantsIdx = neededIdxSet.has(effectiveIdx);
    const maybeUserTitle =
      needFirstUserTitle &&
      !firstUserTitle &&
      (trimmed.includes('USER_INPUT') || trimmed.includes('"userInput"'));
    if (!wantsIdx && !maybeUserTitle) {
      return;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object') return;
      const parsedIdx = Number.isFinite(Number(parsed.step_index))
        ? Number(parsed.step_index)
        : curOrd;
      if (parsedIdx > maxScannedIdx) maxScannedIdx = parsedIdx;
      if (neededIdxSet.has(parsedIdx)) {
        const patch = buildCompactTranscriptPatch(parsed);
        if (patch) {
          patchesByIdx.set(parsedIdx, patch);
        }
      }
      if (needFirstUserTitle && !firstUserTitle) {
        const upperType = String(parsed.type || '').trim().toUpperCase();
        if (
          upperType === 'USER_INPUT' ||
          upperType === 'CORTEX_STEP_TYPE_USER_INPUT' ||
          (parsed.userInput && typeof parsed.userInput === 'object')
        ) {
          firstUserTitle = extractOfflineUserTitle(
            typeof parsed.content === 'string'
              ? parsed.content
              : parsed.userInput?.userResponse || ''
          );
        }
      }
    } catch {
      // 忽略损坏 JSON 行
    }
  };

  const useChunkedStream =
    fileSize > TRANSCRIPT_BACKFILL_STREAM_THRESHOLD_BYTES &&
    typeof openSync === 'function' &&
    typeof readSync === 'function' &&
    typeof closeSync === 'function';

  if (useChunkedStream) {
    const fd = openSync(transcriptPath, 'r');
    try {
      const chunkBuf = Buffer.allocUnsafe(TRANSCRIPT_BACKFILL_CHUNK_BYTES);
      let offset = startOffset;
      let remainder = null;
      while (offset < fileSize) {
        const toRead = Math.min(TRANSCRIPT_BACKFILL_CHUNK_BYTES, fileSize - offset);
        const bytesRead = readSync(fd, chunkBuf, 0, toRead, offset);
        if (bytesRead <= 0) break;
        offset += bytesRead;
        let lineStart = 0;
        for (let i = 0; i < bytesRead; i += 1) {
          if (chunkBuf[i] !== 0x0a) continue;
          const slice = chunkBuf.subarray(lineStart, i);
          const lineStr = remainder
            ? Buffer.concat([remainder, slice]).toString('utf8')
            : slice.toString('utf8');
          remainder = null;
          processLine(lineStr);
          lineStart = i + 1;
        }
        if (lineStart < bytesRead) {
          const tail = Buffer.from(chunkBuf.subarray(lineStart, bytesRead));
          remainder = remainder ? Buffer.concat([remainder, tail]) : tail;
        }
      }
      if (remainder && remainder.length > 0) {
        // 仅在文件完整读至尾部时消费最后一行；保留完整已换行位置作为安全续读偏移
        scannedBytes = offset - remainder.length;
        processLine(remainder.toString('utf8'));
      } else {
        scannedBytes = offset;
      }
    } finally {
      try {
        closeSync(fd);
      } catch {
        // 忽略关闭异常
      }
    }
  } else {
    const raw = readFileSync(transcriptPath, 'utf8');
    if (typeof raw !== 'string' || !raw.trim()) {
      return { firstUserTitle: '', patchesByIdx, scannedBytes: fileSize, lineOrdinal, maxScannedIdx };
    }
    let pos = 0;
    while (pos <= raw.length) {
      const nl = raw.indexOf('\n', pos);
      if (nl < 0) {
        if (pos < raw.length) processLine(raw.slice(pos));
        break;
      }
      processLine(raw.slice(pos, nl));
      pos = nl + 1;
    }
    scannedBytes = fileSize;
  }

  return { firstUserTitle, patchesByIdx, scannedBytes, lineOrdinal, maxScannedIdx };
}

function enrichSqliteStepsFromTranscriptIfNeeded(
  cidLower,
  sqliteSteps,
  { hasHumanUserStep = null } = {}
) {
  if (!cidLower || !Array.isArray(sqliteSteps) || sqliteSteps.length === 0) {
    return { firstUserTitle: '' };
  }
  const hasHuman =
    typeof hasHumanUserStep === 'boolean'
      ? hasHumanUserStep
      : sqliteSteps.some((s) => s?.type === 'CORTEX_STEP_TYPE_USER_INPUT');

  const neededIdxSet = new Set();
  for (const s of sqliteSteps) {
    const needsThis =
      (s?.type === 'CORTEX_STEP_TYPE_USER_INPUT' && !s.userInput) ||
      (!hasHuman && s?.type === 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE' && !s.content && !s.systemMessage) ||
      (s?.metadata?.modelUsage && !s.metadata.modelUsage.model);
    if (!needsThis) continue;
    const sIdx = Number(s?.metadata?.sourceTrajectoryStepInfo?.stepIndex ?? s?.idx);
    if (Number.isFinite(sIdx)) {
      neededIdxSet.add(sIdx);
    }
  }
  if (neededIdxSet.size === 0) {
    return { firstUserTitle: '' };
  }

  const transcriptPath = findTranscriptPath(cidLower);
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return { firstUserTitle: '' };
  }

  let mtimeMs = 0;
  let fileSize = 0;
  try {
    const st = statSync(transcriptPath);
    mtimeMs = Math.floor(Number(st?.mtimeMs || 0));
    fileSize = Math.max(0, Number(st?.size || 0));
  } catch {
    return { firstUserTitle: '' };
  }

  let memo = transcriptBackfillMemo.get(cidLower) || null;
  let allCovered = false;
  if (memo && memo.path === transcriptPath && fileSize >= memo.size) {
    if (memo.mtimeMs === mtimeMs && memo.size === fileSize) {
      allCovered = true;
      for (const idx of neededIdxSet) {
        if (!memo.coveredIndices.has(idx)) {
          allCovered = false;
          break;
        }
      }
    } else if (fileSize > memo.size) {
      allCovered = true;
      for (const idx of neededIdxSet) {
        if (!memo.coveredIndices.has(idx) || idx > memo.maxScannedIdx) {
          allCovered = false;
          break;
        }
      }
    }
  }

  if (!allCovered) {
    const canAppendOnly =
      Boolean(
        memo &&
          memo.path === transcriptPath &&
          fileSize > memo.size &&
          memo.scannedBytes > 0 &&
          memo.scannedBytes <= fileSize
      ) &&
      Array.from(neededIdxSet).every(
        (idx) => memo.coveredIndices.has(idx) || idx > memo.maxScannedIdx
      );

    try {
      if (canAppendOnly) {
        const missingNew = new Set();
        for (const idx of neededIdxSet) {
          if (!memo.coveredIndices.has(idx)) missingNew.add(idx);
        }
        const delta = scanTranscriptBackfillLines(transcriptPath, {
          startOffset: memo.scannedBytes,
          fileSize,
          startLineOrdinal: memo.lineOrdinal,
          neededIdxSet: missingNew,
          needFirstUserTitle: !memo.firstUserTitle,
        });
        for (const [k, v] of delta.patchesByIdx.entries()) {
          memo.patchesByIdx.set(k, v);
        }
        for (const idx of missingNew) {
          memo.coveredIndices.add(idx);
        }
        if (!memo.firstUserTitle && delta.firstUserTitle) {
          memo.firstUserTitle = delta.firstUserTitle;
        }
        memo.mtimeMs = mtimeMs;
        memo.size = fileSize;
        memo.scannedBytes = delta.scannedBytes;
        memo.lineOrdinal = delta.lineOrdinal;
        if (delta.maxScannedIdx > memo.maxScannedIdx) {
          memo.maxScannedIdx = delta.maxScannedIdx;
        }
      } else {
        const scanned = scanTranscriptBackfillLines(transcriptPath, {
          startOffset: 0,
          fileSize,
          startLineOrdinal: 0,
          neededIdxSet,
          needFirstUserTitle: true,
        });
        memo = {
          path: transcriptPath,
          mtimeMs,
          size: fileSize,
          scannedBytes: scanned.scannedBytes,
          lineOrdinal: scanned.lineOrdinal,
          maxScannedIdx: scanned.maxScannedIdx,
          firstUserTitle: scanned.firstUserTitle,
          patchesByIdx: scanned.patchesByIdx,
          coveredIndices: new Set(neededIdxSet),
        };
      }
      if (transcriptBackfillMemo.has(cidLower)) {
        transcriptBackfillMemo.delete(cidLower);
      } else if (transcriptBackfillMemo.size >= MAX_TRANSCRIPT_MEMO_ENTRIES) {
        const oldestKey = transcriptBackfillMemo.keys().next().value;
        if (oldestKey !== undefined) transcriptBackfillMemo.delete(oldestKey);
      }
      transcriptBackfillMemo.set(cidLower, memo);
    } catch {
      return { firstUserTitle: '' };
    }
  }

  const patchesByIdx = memo?.patchesByIdx;
  if (patchesByIdx && patchesByIdx.size > 0) {
    for (const sq of sqliteSteps) {
      const sIdx = Number(sq?.metadata?.sourceTrajectoryStepInfo?.stepIndex ?? sq?.idx);
      const tLine = patchesByIdx.get(sIdx);
      if (!tLine) continue;
      if (sq.type === 'CORTEX_STEP_TYPE_USER_INPUT' && !sq.userInput) {
        if (typeof tLine.content === 'string') sq.content = tLine.content;
        if (tLine.userInput) sq.userInput = tLine.userInput;
        if (Array.isArray(tLine.media)) sq.media = tLine.media;
      } else if (
        !hasHuman &&
        sq.type === 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE' &&
        !sq.content &&
        typeof tLine.content === 'string'
      ) {
        sq.content = tLine.content;
      } else if (sq.metadata?.modelUsage && !sq.metadata.modelUsage.model) {
        if (tLine.model) sq.metadata.modelUsage.model = tLine.model;
      }
    }
  }

  return { firstUserTitle: memo?.firstUserTitle || '' };
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

function unwrapOfflineToolArgString(val) {
  if (typeof val !== 'string') return '';
  const trimmed = val.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed.trim();
    } catch {
      // 忽略非标准二次转义
    }
  }
  return trimmed.replace(/^"+|"+$/g, '').trim();
}

function extractSubagentRefsFromTranscriptLines(transcriptLines = [], baseSteps = [], cidLower = '') {
  const refs = extractSubagentRefsFromSteps(baseSteps);
  const byCid = new Map(refs.map((r) => [r.cascadeId, r]));
  let nextOrder = refs.length;
  const pendingSpecs = [];
  const pendingByCallId = new Map();

  for (const line of transcriptLines || []) {
    if (!line || typeof line !== 'object') continue;
    const createdTimeMs = parseIsoMs(line.created_at || line.createdAt) || 0;
    const toolCalls = Array.isArray(line.tool_calls) ? line.tool_calls : [];
    for (const tc of toolCalls) {
      const name = String(tc?.name || tc?.tool_name || '').trim().toLowerCase();
      if (name === 'invoke_subagent' || name === 'default_api:invoke_subagent') {
        const args = tc?.args || tc?.arguments || {};
        const callId = String(tc?.id || tc?.call_id || tc?.tool_call_id || '').trim();
        const spec = {
          callId,
          role: unwrapOfflineToolArgString(args.Role ?? args.role ?? ''),
          typeName: unwrapOfflineToolArgString(args.TypeName ?? args.typeName ?? ''),
          createdTimeMs,
          consumed: false,
        };
        pendingSpecs.push(spec);
        if (callId) pendingByCallId.set(callId, spec);
      }
    }
    const content = typeof line.content === 'string' ? line.content : '';
    if (content && content.includes('Created the following subagent')) {
      const resultCallId = String(line.tool_call_id || line.call_id || '').trim();
      const matches = content.matchAll(
        /"conversationId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi
      );
      for (const m of matches) {
        const subCid = String(m[1] || '').trim().toLowerCase();
        if (!subCid || subCid === cidLower) continue;
        let spec = null;
        if (resultCallId && pendingByCallId.has(resultCallId)) {
          const direct = pendingByCallId.get(resultCallId);
          if (direct && !direct.consumed) {
            direct.consumed = true;
            spec = direct;
          }
        }
        if (!spec) {
          while (pendingSpecs.length > 0 && pendingSpecs[0].consumed) {
            pendingSpecs.shift();
          }
          spec = pendingSpecs.shift() || null;
          if (spec) spec.consumed = true;
        }
        const prev = byCid.get(subCid);
        const merged = {
          cascadeId: subCid,
          role: spec?.role || prev?.role || '',
          typeName: spec?.typeName || prev?.typeName || '',
          createdTimeMs: createdTimeMs || spec?.createdTimeMs || prev?.createdTimeMs || 0,
          spawnOrder: prev ? prev.spawnOrder : nextOrder++,
        };
        byCid.set(subCid, merged);
      }
    }
  }

  const swarmManifest = cidLower ? readSwarmManifestForCascade(cidLower) : null;
  if (swarmManifest?.workerRefs?.length) {
    for (const wRef of swarmManifest.workerRefs) {
      if (wRef?.cascadeId && !byCid.has(wRef.cascadeId)) {
        byCid.set(wRef.cascadeId, wRef);
      }
    }
  }
  return Array.from(byCid.values());
}

/**
 * 当 Language Server RPC 离线、跨端不可达（如 `agy` CLI 独立会话目录）或本地 `.db` 因初始化锁冲突降级为 `.pb` 空壳时，
 * 优先融合本地可用 SQLite、`conversation_summaries.db`、`annotations/<id>.pbtxt` 与 `transcript.jsonl`
 * （及可选 `.deep_stats_cache.json`）恢复模型步骤、Token 消耗、轮次提问、派生子代理与真实标题。
 */
function loadOfflineTranscriptConversation(
  conv,
  diskFiles,
  externalByLower,
  localSummary = null,
  { skipSqlite = false } = {}
) {
  const cidLower = String(conv?.cascadeId || '').trim().toLowerCase();
  if (!cidLower) return null;
  const extMatch = externalByLower?.get(cidLower) || null;
  const sqliteDbPath = skipSqlite ? '' : findBestSqliteDbPath(diskFiles);
  const sqliteTraj = sqliteDbPath
    ? readLocalSqliteTrajectory(sqliteDbPath, {
        cascadeId: cidLower,
        includeForeignStepBounds: true,
      })
    : null;
  const transcriptPath = findTranscriptPath(cidLower);

  const transcriptLines = transcriptPath ? readTranscriptJsonlLines(transcriptPath) : [];

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

  if (sqliteTraj && (sqliteTraj.steps.length > 0 || sqliteTraj.hasForeignOriginSteps)) {
    fromSqlite = true;
    const sqliteRawSteps = [];
    let maxSqliteStepIdx = Number.isFinite(sqliteTraj.maxForeignOriginStepIndex)
      ? Number(sqliteTraj.maxForeignOriginStepIndex)
      : -1;
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

  if (!fromSqlite && steps.length === 0 && transcriptLines.length > 0) {
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
      syntheticSteps.push(
        synthesizeTranscriptModelStep(line, { stepIndex: rawIdx, deepStep })
      );
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
        createdAt:
          ds.createdAt || (ds.createdAtMs > 0 ? new Date(ds.createdAtMs).toISOString() : ''),
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
  const offlineSubagentRefs = extractSubagentRefsFromTranscriptLines(
    transcriptLines,
    sqliteTraj?.steps || [],
    cidLower
  );
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
    subagentRefs: offlineSubagentRefs,
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
    sig.startsWith('pending-tool:') ||
    sig.startsWith('bg-task:')
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
  { isRemote = false, liveActivityMemoMap = liveActivityMemo, fallbackTaskSteps = null } = {}
) {
  if (!isRunning) return null;
  const hasRpcSteps = Array.isArray(rpcRawSteps) && rpcRawSteps.length > 0;
  const rpcAct = hasRpcSteps ? extractLiveActivity(rpcRawSteps, true, fallbackMs) : null;
  const transcriptSteps = isRemote ? [] : readTranscriptTailSteps(cascadeId);
  const transcriptAct =
    transcriptSteps.length > 0 ? extractLiveActivity(transcriptSteps, true, fallbackMs) : null;

  const hasUserTurnAfter = (steps, afterIdx) =>
    Array.isArray(steps) &&
    steps.some((st) => {
      const idx = Number(
        st?.step_index ?? st?.stepIndex ?? st?.idx ?? st?.metadata?.sourceTrajectoryStepInfo?.stepIndex
      );
      return isUserInputRawStep(st) && Number.isFinite(idx) && idx > afterIdx;
    });

  const attachTaskSteps = (winner, ...candidates) => {
    if (!winner || winner.taskSteps) return winner;
    for (const cand of candidates) {
      if (cand && Number(cand.total) > 0) {
        return { ...winner, taskSteps: cand };
      }
    }
    return winner;
  };

  if (rpcAct && transcriptAct) {
    const rpcIsBgTask = String(rpcAct.signature || '').startsWith('bg-task:');
    const rpcScore = scoreLiveActivitySpecificity(rpcAct);
    const transScore = scoreLiveActivitySpecificity(transcriptAct);
    const rpcStepIdx = getMaxMeaningfulStepIndex(rpcRawSteps);
    const transStepIdx = getMaxMeaningfulStepIndex(transcriptSteps);
    const transcriptHasNewUserTurn =
      rpcStepIdx >= 0 && hasUserTurnAfter(transcriptSteps, rpcStepIdx);
    const rpcHasNewUserTurn =
      transStepIdx >= 0 && hasUserTurnAfter(rpcRawSteps, transStepIdx);

    // 0. SQLite/RPC 确认后台任务运行中时，不因 transcript 尾部已写入本轮结束回复（responding-done）而覆盖后台任务状态
    if (rpcIsBgTask && transScore < 4 && !transcriptHasNewUserTurn) {
      return attachTaskSteps(rpcAct, transcriptAct.taskSteps, fallbackTaskSteps);
    }

    // 1. 先按真实 Cortex 步骤序号对齐比较：尚未刷入 transcript.jsonl 的新步骤（如正在进行的 CHECKPOINT 压缩或流式回复）优先采用 RPC
    if (rpcStepIdx >= 0 && transStepIdx >= 0 && rpcStepIdx !== transStepIdx) {
      if (rpcStepIdx > transStepIdx) {
        return rpcHasNewUserTurn
          ? rpcAct
          : attachTaskSteps(rpcAct, transcriptAct.taskSteps, fallbackTaskSteps);
      }
      return transcriptHasNewUserTurn
        ? transcriptAct
        : attachTaskSteps(transcriptAct, rpcAct.taskSteps, fallbackTaskSteps);
    }

    // 2. 同一步骤序号下优先采用语义更明确的状态（上下文压缩 > 工具/后台任务执行 > 流式生成 > 工具后置思考）
    if (rpcScore !== transScore) {
      return rpcScore > transScore
        ? attachTaskSteps(rpcAct, transcriptAct.taskSteps, fallbackTaskSteps)
        : attachTaskSteps(transcriptAct, rpcAct.taskSteps, fallbackTaskSteps);
    }

    // 3. 同一步骤且均为压缩态时，优先采用携带精确完成时刻的 RPC 状态；常规步骤则优先采用含完整参数的 transcript.jsonl
    const rpcMs = Number(rpcAct.startedAtMs || 0);
    const transMs = Number(transcriptAct.startedAtMs || 0);
    if (rpcAct.phase === 'compacting' && rpcMs !== transMs) {
      return rpcMs >= transMs
        ? attachTaskSteps(rpcAct, transcriptAct.taskSteps, fallbackTaskSteps)
        : attachTaskSteps(transcriptAct, rpcAct.taskSteps, fallbackTaskSteps);
    }
    return attachTaskSteps(transcriptAct, rpcAct.taskSteps, fallbackTaskSteps);
  }
  const chosen =
    transcriptAct ||
    rpcAct ||
    liveActivityMemoMap.get(String(cascadeId || '').toLowerCase()) ||
    extractLiveActivity([], true, fallbackMs);
  return attachTaskSteps(chosen, fallbackTaskSteps);
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
  summariesFromLocalDb = false,
  summariesAvailable = false,
  sideQuestionParents = {},
  currentAccountName = '',
  requestedConvId = '',
  forceRefresh = false,
  progressiveLocalSync = false,
  expectedGeneration = null,
  endpoint = null,
}) {
  const isRemote = Boolean(endpoint && endpoint.isRemote);
  const scanGeneration =
    !isRemote && Number.isInteger(expectedGeneration)
      ? expectedGeneration
      : localRebuildGeneration;
  const isStaleLocalGeneration = () => !isRemote && scanGeneration !== localRebuildGeneration;
  const fgShouldAbort = isRemote ? null : isStaleLocalGeneration;
  const sliceYielder = lsScanCreateTimeSliceYielder(LS_SCAN_TIME_SLICE_MS);
  const cacheStore = getEndpointCacheStore(endpoint);
  const getEntry = cacheStore.getCachedTrajectory;
  const getHydratedEntry =
    typeof cacheStore.getHydratedTrajectory === 'function'
      ? cacheStore.getHydratedTrajectory
      : getEntry;
  const setEntry = isRemote
    ? cacheStore.setCachedTrajectory
    : (cid, entry) => {
        if (isStaleLocalGeneration()) return;
        cacheStore.setCachedTrajectory(cid, entry);
      };
  const removeEntry = isRemote
    ? cacheStore.removeCachedTrajectory
    : (cid) => {
        if (isStaleLocalGeneration()) return;
        cacheStore.removeCachedTrajectory(cid);
      };
  const listEntries = cacheStore.listCachedTrajectoryEntries;
  const hasPendingSave = cacheStore.hasPendingTrajectoryCacheSave;
  const persistCacheIfNeeded = isRemote
    ? cacheStore.persistTrajectoryCacheIfNeeded
    : (opts) => {
        if (isStaleLocalGeneration()) return;
        cacheStore.persistTrajectoryCacheIfNeeded(opts);
      };
  const activeCooldownMap = isRemote ? endpoint.failedFetchCooldownMap : failedFetchCooldownMap;
  const activeLiveActivityMemo = isRemote ? endpoint.liveActivityMemo : liveActivityMemo;
  const maxConcurrentRpc = isRemote ? 1 : MAX_CONCURRENT_RPC;
  let remoteConsecutiveTimeouts = 0;
  let remainingRemoteBackgroundBudget = REMOTE_BACKGROUND_FETCH_LIMIT;
  let remoteFetchStartedAtMs = 0;

  const getRemoteRemainingBudgetMs = () => {
    if (!isRemote) return Infinity;
    if (remoteFetchStartedAtMs <= 0) return REMOTE_POLL_TRAJECTORY_BUDGET_MS;
    return Math.max(0, REMOTE_POLL_TRAJECTORY_BUDGET_MS - (Date.now() - remoteFetchStartedAtMs));
  };

  const isRemoteFetchHalted = () =>
    isRemote &&
    (remoteConsecutiveTimeouts >= REMOTE_CONSECUTIVE_TIMEOUT_BREAKER ||
      getRemoteRemainingBudgetMs() < REMOTE_MIN_REMAINING_BUDGET_MS);

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
  const diskScan = isRemote
    ? { map: new Map(), complete: true, readableDirs: new Set() }
    : scanLocalConversationFiles();
  const diskConvMap = diskScan.map;

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

  for (const [rawCacheKey] of listEntries()) {
    const lower = String(rawCacheKey || '').trim().toLowerCase();
    if (!lower) continue;
    const existingCanon = canonicalIdByLower.get(lower);
    if (!existingCanon) {
      // 标准 UUID 统一收敛为小写键，避免大小写分裂产生双份条目
      const normalizedKey = UUID_RE.test(rawCacheKey) ? lower : rawCacheKey;
      if (normalizedKey !== rawCacheKey) {
        const prevVal = getEntry(rawCacheKey);
        if (prevVal) {
          setEntry(normalizedKey, prevVal);
          cacheDirty = true;
        }
      }
      canonicalIdByLower.set(lower, normalizedKey);
    } else if (existingCanon !== rawCacheKey) {
      const targetEntry = getEntry(existingCanon);
      const dupEntry = getEntry(rawCacheKey);
      const winner =
        !targetEntry || (dupEntry?.steps?.length || 0) > (targetEntry?.steps?.length || 0)
          ? dupEntry
          : targetEntry;
      if (winner) {
        setEntry(existingCanon, winner);
        cacheDirty = true;
      }
    }
  }

  for (const diskLowerId of diskConvMap.keys()) {
    if (!canonicalIdByLower.has(diskLowerId)) {
      canonicalIdByLower.set(diskLowerId, diskLowerId);
    }
  }

  // 从未归档的本地缓存会话收集 subagentRefs，确保跨账号切换时活跃历史会话与派生子代理均不丢失
  for (const [, entry] of listEntries()) {
    if (!isRemote && entry?.archived) continue;
    for (const ref of entry?.subagentRefs || []) {
      const refCid = String(ref?.cascadeId || '').trim().toLowerCase();
      if (refCid && !canonicalIdByLower.has(refCid)) {
        canonicalIdByLower.set(refCid, refCid);
      }
    }
  }

  const localSummaryByLower = isRemote ? new Map() : readLocalSummaryIndex();
  const sqliteAvailable = isRemote ? false : hasBuiltinNodeSqlite();
  const observedLiveIds = new Set();
  for (const k of summariesByLower.keys()) observedLiveIds.add(k);
  for (const k of localSummaryByLower.keys()) observedLiveIds.add(k);
  for (const k of diskConvMap.keys()) observedLiveIds.add(k);
  for (const [rawKey, entry] of listEntries()) {
    const lower = String(rawKey || '').toLowerCase();
    if (!observedLiveIds.has(lower)) continue;
    for (const ref of entry?.subagentRefs || []) {
      const refCid = String(ref?.cascadeId || '').trim().toLowerCase();
      if (refCid) {
        const refEntry = getEntry(canonicalIdByLower.get(refCid) || refCid);
        if (!refEntry?.archived) {
          observedLiveIds.add(refCid);
        }
      }
    }
  }
  const hasAuthoritativeSourceSnapshot = isRemote
    ? summariesByLower.size > 0
    : summariesByLower.size > 0 || localSummaryByLower.size > 0 || diskConvMap.size > 0;
  const hasReadableLocalStore = !isRemote && diskScan.readableDirs.size > 0;
  const hasConfirmedLocalAuthority = Boolean(
    !isRemote &&
      diskScan.complete &&
      (hasReadableLocalStore
        ? summariesAvailable || hasAuthoritativeSourceSnapshot
        : hasAuthoritativeSourceSnapshot)
  );
  const hiddenArchivedIds = new Set();
  if (hasAuthoritativeSourceSnapshot) {
    if (isRemote && endpoint) {
      endpoint.lastKnownLiveCascadeIds = observedLiveIds;
    } else if (!isRemote) {
      lastKnownLocalLiveCascadeIds = observedLiveIds;
    }
  }
  const normalizedPollAccount = normalizeOwnerAccount(currentAccountName);
  const STALE_LOCAL_RUNNING_MAX_AGE_MS = 10 * 60_000;
  const reqLower = String(requestedConvId || '').trim().toLowerCase();
  const rawConversations = [];
  let enumCount = 0;
  for (const [cidLower, cascadeId] of canonicalIdByLower.entries()) {
    enumCount += 1;
    if ((enumCount & 31) === 0) {
      const ypEnum = sliceYielder.maybeYield();
      if (ypEnum) await ypEnum;
    }
    const item = summariesByLower.get(cidLower);
    const localSum = localSummaryByLower.get(cidLower) || null;
    let cached = getEntry(cascadeId);
    const diskFiles = diskConvMap.get(cidLower) || [];
    const sqliteDbInfo = sqliteAvailable
      ? resolveBestSqliteDbInfo(diskFiles, { skipMissingWalFromListing: true })
      : null;
    const dbPath = sqliteDbInfo?.dbPath || '';
    const diskFileSig = sqliteDbInfo?.sig || '';
    const hasPbFile = !isRemote && hasLocalPbFile(diskFiles);
    const needFallbackDiskInfo =
      !isRemote &&
      diskFiles.length > 0 &&
      (!sqliteDbInfo || hasPbFile || Boolean(cached?.offlineTranscriptFallback));
    const fallbackDiskInfo = needFallbackDiskInfo ? computeFallbackDiskInfo(diskFiles) : null;
    const fallbackDiskSig = fallbackDiskInfo?.sig || '';
    const lastModifiedTime = item?.lastModifiedTime || item?.createdTime || '';
    const summaryMtimeMs = parseIsoMs(lastModifiedTime);
    const rawDiskMtimeMs = summaryMtimeMs ? null : readConversationMtime(diskFiles);
    const baseDiskMtimeMs = sqliteDbInfo
      ? Math.max(rawDiskMtimeMs || 0, sqliteDbInfo.mtimeMs || 0)
      : rawDiskMtimeMs;
    const diskMtimeMs = fallbackDiskInfo
      ? Math.max(baseDiskMtimeMs || 0, fallbackDiskInfo.mtimeMs || 0)
      : baseDiskMtimeMs;
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
    const baseConvStatus = item ? (isKilled ? 'IDLE' : item?.status || '') : localStatus;
    let activeBackgroundTasks = [];
    let isBackgroundTaskOnly = false;
    if (
      !isRemote &&
      !isKilled &&
      dbPath &&
      sqliteAvailable &&
      baseConvStatus !== 'CASCADE_RUN_STATUS_RUNNING' &&
      Boolean(localSum?.notFullyIdle)
    ) {
      activeBackgroundTasks = readCachedActiveBackgroundTasks(cidLower, dbPath, diskFileSig);
      if (activeBackgroundTasks.length > 0) {
        isBackgroundTaskOnly = true;
      }
    }
    const resolvedConvStatus =
      activeBackgroundTasks.length > 0 ? 'CASCADE_RUN_STATUS_RUNNING' : baseConvStatus;

    const rawWsList = Array.isArray(item?.workspaces) ? item.workspaces : [];
    const rpcWorkspaceUri = String(
      rawWsList[0]?.workspaceFolderAbsoluteUri ||
        rawWsList[0]?.gitRootAbsoluteUri ||
        item?.workspaceFolderAbsoluteUri ||
        item?.workspaceUri ||
        ''
    ).trim();
    const workspaceUri = String(
      rpcWorkspaceUri || localSum?.workspaceUri || cached?.workspaceUri || ''
    ).trim();

    const hasLiveBacking = Boolean(
      item ||
        localSum ||
        diskFiles.length > 0 ||
        observedLiveIds.has(cidLower)
    );
    if (!isRemote && cached) {
      if (cached.archived && hasLiveBacking) {
        const unarchived = { ...cached };
        delete unarchived.archived;
        setEntry(cascadeId, unarchived);
        cached = getEntry(cascadeId) || unarchived;
        cacheDirty = true;
      } else if (!hasLiveBacking) {
        if (cached.archived) {
          hiddenArchivedIds.add(cidLower);
          continue;
        }
        const cachedOwner = normalizeOwnerAccount(cached.accountName);
        const sameOrUnknownAccount =
          currentAccountName !== null &&
          (!normalizedPollAccount || !cachedOwner || cachedOwner === normalizedPollAccount);
        const parentRefLower = String(
          rootConversationId || parentConversationId || ''
        ).toLowerCase();
        const linkedToLiveParent = Boolean(parentRefLower && observedLiveIds.has(parentRefLower));
        if (hasConfirmedLocalAuthority && sameOrUnknownAccount && !linkedToLiveParent) {
          if ((cached.steps?.length || 0) > 0) {
            setEntry(cascadeId, { ...cached, archived: true });
          } else {
            removeEntry(cascadeId);
          }
          cacheDirty = true;
          hiddenArchivedIds.add(cidLower);
          continue;
        }
      }
    }

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
          pickFirstMeaningfulTitle(cidLower, [
            sqParentInfo?.title,
            item?.annotations?.title,
            item?.summary,
            localSum?.title,
            cached?.title,
          ]) || (isSideQuestion ? '旁路提问' : cascadeId.slice(0, 8)),
        stepCount: modelStepCount,
        rawStepCount: rawSummaryStepCount,
        status: resolvedConvStatus,
        ...(isBackgroundTaskOnly ? { isBackgroundTaskOnly: true } : {}),
        ...(activeBackgroundTasks.length > 0 ? { activeBackgroundTasks } : {}),
        killed: isKilled,
        lastModifiedTime,
        lastModifiedMs,
        diskMtimeMs,
        dbPath,
        diskFileSig,
        fallbackDiskSig,
        appSource,
        ...(workspaceUri ? { workspaceUri } : {}),
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
          pickFirstMeaningfulTitle(cidLower, [
            sqParentInfo?.title,
            localSum?.title,
            cached.title,
          ]) || (isSideQuestion ? '旁路提问' : cascadeId.slice(0, 8)),
        stepCount: cachedStepCount,
        rawStepCount: localSum?.stepCount || cached.rawStepCount || cachedStepCount,
        status: resolvedConvStatus,
        ...(isBackgroundTaskOnly ? { isBackgroundTaskOnly: true } : {}),
        ...(activeBackgroundTasks.length > 0 ? { activeBackgroundTasks } : {}),
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
        fallbackDiskSig,
        appSource,
        ...(workspaceUri ? { workspaceUri } : {}),
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
          pickFirstMeaningfulTitle(cidLower, [
            sqParentInfo?.title,
            localSum?.title,
          ]) || (isSideQuestion ? '旁路提问' : cascadeId.slice(0, 8)),
        stepCount: 0,
        rawStepCount: localSum?.stepCount || 0,
        status: resolvedConvStatus,
        ...(isBackgroundTaskOnly ? { isBackgroundTaskOnly: true } : {}),
        ...(activeBackgroundTasks.length > 0 ? { activeBackgroundTasks } : {}),
        killed: isKilled,
        lastModifiedTime: localSum?.lastModifiedTime || '',
        lastModifiedMs: Math.max(diskMtimeMs || 0, localSum?.lastModifiedMs || 0),
        diskMtimeMs,
        dbPath,
        diskFileSig,
        fallbackDiskSig,
        appSource,
        ...(workspaceUri ? { workspaceUri } : {}),
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
    const fbSuffix = conv.fallbackDiskSig ? `~fb:${conv.fallbackDiskSig}` : '';
    if (conv.dbPath && conv.diskFileSig && sqliteAvailable) {
      return `${CACHE_SCHEMA_VERSION}:sqlite:${conv.rawStepCount ?? conv.stepCount}:${conv.lastModifiedTime || ''}:${conv.diskFileSig}${fbSuffix}`;
    }
    const base = conv.inSummaries
      ? `${CACHE_SCHEMA_VERSION}:${conv.rawStepCount ?? conv.stepCount}:${conv.lastModifiedTime}`
      : `${CACHE_SCHEMA_VERSION}:disk:${Math.floor(conv.diskMtimeMs || conv.lastModifiedMs || 0)}`;
    return `${base}${fbSuffix}`;
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
    if (cached?._stepFlags) {
      return Boolean(cached._stepFlags.hasMissingStepFields);
    }
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
  const pollSwarmManifestByCid = new Map();
  const getPollSwarmManifest = (cascadeId) => {
    if (isRemote || !cascadeId) return null;
    const key = String(cascadeId).trim().toLowerCase();
    if (pollSwarmManifestByCid.has(key)) return pollSwarmManifestByCid.get(key);
    const val = readSwarmManifestForCascade(key);
    pollSwarmManifestByCid.set(key, val);
    return val;
  };

  /**
   * 批量拉取会话轨迹并提取步骤、子代理元数据 (`trajectory.metadata`) 与子代理调用引用 (`invokeSubagent`)。
   *
   * @param {object[]} targetConvs
   */
  async function fetchTrajectoryBatch(targetConvs, { shouldAbort = null } = {}) {
    if (!Array.isArray(targetConvs) || targetConvs.length === 0) return;
    if (isRemote && remoteFetchStartedAtMs <= 0) {
      remoteFetchStartedAtMs = Date.now();
    }
    for (const c of targetConvs) {
      attemptedFetchIds.add(c.cascadeId.toLowerCase());
    }
    for (let i = 0; i < targetConvs.length; i += maxConcurrentRpc) {
      if (isRemoteFetchHalted() || shouldAbort?.()) {
        break;
      }
      const ypBatch = sliceYielder.maybeYield();
      if (ypBatch) await ypBatch;
      if (shouldAbort?.()) {
        break;
      }
      const batch = targetConvs.slice(i, i + maxConcurrentRpc);
      await Promise.all(
        batch.map(async (conv) => {
          const ypItem = sliceYielder.maybeYield();
          if (ypItem) await ypItem;
          if (shouldAbort?.()) return;
          const sig = buildConvSig(conv);
          const cooldownKey = `${conv.cascadeId.toLowerCase()}::${sig}`;
          const isRunning = conv.status === 'CASCADE_RUN_STATUS_RUNNING';
          const isReq = Boolean(reqLower && conv.cascadeId.toLowerCase() === reqLower);
          const prev = getHydratedEntry(conv.cascadeId);
          let partialTailSteps = [];
          let hasTailStepInfo = false;
          let sqliteNotReady = false;
          let sqliteProbedEmpty = false;
          try {
            const cidLower = conv.cascadeId.toLowerCase();
            let trajRes = null;
            let loadedViaSqlite = false;
            let usedIncrementalSqlite = false;
            let incrementalTailModelSteps = null;
            let prevCursorForInc = null;
            let transcriptFirstTitle = '';
            if (!isRemote && conv.dbPath && sqliteAvailable) {
              if (!isSqliteDbReadyForRead(conv.dbPath)) {
                sqliteNotReady = true;
              } else {
                const candCursor = !forceRefresh
                  ? sqliteIncrementalCursorMap.get(cidLower) || null
                  : null;
                const canUseIncremental = Boolean(
                  candCursor &&
                    prev &&
                    prev.steps === candCursor.stepsRef &&
                    !prev.offlineTranscriptFallback &&
                    prev.contextLimitTelemetry &&
                    prev.speedClearedTelemetry &&
                    prev.turnRailTelemetry &&
                    Number(prev.contextGroupsTelemetry || 0) >= 3 &&
                    prev.anomalyTelemetry &&
                    prev.imageGenTelemetry &&
                    !hasMissingStepFields(prev) &&
                    !hasMissingTurnRailFields(prev) &&
                    Array.isArray(prev.subagentRefs) &&
                    !prev.swarmMeta &&
                    prev.steps.length >= candCursor.stableModelStepsCount
                );
                if (canUseIncremental) {
                  const incRes = readLocalSqliteTrajectoryIncremental(conv.dbPath, candCursor, {
                    cascadeId: conv.cascadeId,
                    isRunning,
                  });
                  if (incRes && Array.isArray(incRes.trajectory?.steps)) {
                    const tailEnriched = enrichSqliteStepsFromTranscriptIfNeeded(
                      cidLower,
                      incRes.trajectory.steps,
                      { hasHumanUserStep: candCursor.hasHumanUserTurn }
                    );
                    const tailSwarm = extractSwarmMetaFromSteps(incRes.trajectory.steps);
                    if (!tailSwarm) {
                      const tailModelSteps = extractModelSteps(
                        incRes.trajectory.steps,
                        incRes.trajectory.generatorMetadata || [],
                        {
                          turnCounter: candCursor.turnCounter,
                          activeTurnIndex: candCursor.activeTurnIndex,
                          hasHumanUserTurn: candCursor.hasHumanUserTurn,
                          lastCompactionStepIdx: candCursor.lastCompactionStepIdx,
                          lastKnownGmStepIdx: candCursor.lastKnownGmStepIdx,
                          orchestratorExecModels: candCursor.orchestratorExecModels,
                          lastExplicitDonorStep: candCursor.lastExplicitDonorStep,
                        }
                      );
                      if (tailModelSteps.length > 0) {
                        trajRes = incRes;
                        loadedViaSqlite = true;
                        usedIncrementalSqlite = true;
                        prevCursorForInc = candCursor;
                        incrementalTailModelSteps = tailModelSteps;
                        transcriptFirstTitle = tailEnriched.firstUserTitle || '';
                      }
                    }
                  }
                }
                if (!trajRes) {
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
                  } else {
                    sqliteProbedEmpty = true;
                    const diskFilesForEmptyCheck = diskConvMap.get(cidLower) || [];
                    if (
                      !isRunning &&
                      Number(conv.rawStepCount || 0) === 0 &&
                      !hasLocalPbFile(diskFilesForEmptyCheck) &&
                      !findTranscriptPath(cidLower)
                    ) {
                      // 已初始化但确实为 0 步（无 .pb 降级文件、摘要 0 步且无 transcript）的空本地会话，直接归档空缓存避免无意义 RPC 超时
                      trajRes = {
                        cascadeId: cidLower,
                        numTotalSteps: 0,
                        rawTableStepCount: 0,
                        steps: [],
                        generatorMetadata: [],
                        trajectory: { metadata: {}, steps: [], generatorMetadata: [] },
                      };
                      loadedViaSqlite = true;
                    }
                  }
                }
              }
            }
            if (!trajRes) {
              const rpcTimeoutMs = isRemote
                ? Math.min(
                    REMOTE_TRAJECTORY_RPC_TIMEOUT_MS,
                    Math.max(REMOTE_MIN_REMAINING_BUDGET_MS, getRemoteRemainingBudgetMs())
                  )
                : 5000;
              trajRes = await callLsRpc(
                'GetCascadeTrajectory',
                { cascadeId: conv.cascadeId },
                rpcTimeoutMs,
                endpoint
              );
              if (shouldAbort?.()) return;
            }
            if (isRemote) {
              remoteConsecutiveTimeouts = 0;
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
            if (!isRemote && !loadedViaSqlite) {
              for (const rawSt of rawSteps) {
                const gi = rawSt?.generateImage;
                const mediaUri = gi?.generatedMedia?.uri;
                if (gi && mediaUri && !(Number(gi.width) > 0 && Number(gi.height) > 0)) {
                  const dims = readLocalImageDimensionsFromUri(mediaUri);
                  if (dims) {
                    gi.width = dims.width;
                    gi.height = dims.height;
                  }
                }
              }
            }
            const steps = usedIncrementalSqlite
              ? prev.steps
                  .slice(0, prevCursorForInc.stableModelStepsCount)
                  .concat(incrementalTailModelSteps)
              : extractModelSteps(rawSteps, generatorMeta);
            if (
              steps.length === 0 &&
              (prev?.steps?.length || 0) > 0 &&
              !prev.offlineTranscriptFallback &&
              !conv.inSummaries &&
              !conv.dbPath
            ) {
              throw new Error('Empty orphan trajectory; retaining cached usage');
            }
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

            const tailSubagentRefs = extractSubagentRefsFromSteps(rawSteps);
            let subagentRefs;
            if (usedIncrementalSqlite && Array.isArray(prevCursorForInc?.prefixSubagentRefs)) {
              subagentRefs = prevCursorForInc.prefixSubagentRefs.slice();
              const seenIncRefs = new Set(subagentRefs.map((r) => r.cascadeId));
              for (const r of tailSubagentRefs) {
                if (r?.cascadeId && !seenIncRefs.has(r.cascadeId)) {
                  seenIncRefs.add(r.cascadeId);
                  subagentRefs.push(r);
                }
              }
            } else {
              subagentRefs = tailSubagentRefs;
            }
            const rpcSwarmMeta = usedIncrementalSqlite ? null : extractSwarmMetaFromSteps(rawSteps);
            const ownSwarmManifest =
              !isRemote && !conv.isSubagent ? getPollSwarmManifest(cidLower) : null;
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

            const liveStepsForActivity = mergeLiveStepsWithActiveBackgroundTasks(
              rawSteps,
              conv.activeBackgroundTasks
            );
            let detectedBgTasks = extractActiveBackgroundTasks(liveStepsForActivity);
            if (!isRunning && !conv.killed && detectedBgTasks.length > 0) {
              conv.status = 'CASCADE_RUN_STATUS_RUNNING';
              conv.isBackgroundTaskOnly = true;
              conv.activeBackgroundTasks = detectedBgTasks.map((t) => t.step);
            }
            const isRunningAfterBg = conv.status === 'CASCADE_RUN_STATUS_RUNNING';
            const hasActiveBgTasks =
              detectedBgTasks.length > 0 ||
              (Array.isArray(conv.activeBackgroundTasks) && conv.activeBackgroundTasks.length > 0);
            const isParkedSwarm = !hasActiveBgTasks && isParkedOnSwarmWait(rawSteps);
            const effectiveIsRunning = isRunningAfterBg && !isParkedSwarm;
            if (!effectiveIsRunning && conv.status === 'CASCADE_RUN_STATUS_RUNNING') {
              conv.status = 'IDLE';
            }

            const prevStoredTaskSteps =
              prevCursorForInc?.lastTaskSteps ||
              activeLiveActivityMemo.get(cidLower)?.taskSteps ||
              null;
            const fallbackTaskSteps = resolveTurnTaskStepsFromRaw(rawSteps, prevStoredTaskSteps);
            const liveAct = resolveBestLiveActivity(
              conv.cascadeId,
              liveStepsForActivity,
              effectiveIsRunning,
              resolvedLastModMs || conv.createdTimeMs || 0,
              {
                isRemote,
                liveActivityMemoMap: activeLiveActivityMemo,
                fallbackTaskSteps,
              }
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
            const contextPreserved = preserveCachedContextTelemetry(steps, prev);
            const stepsWithOwners = attachStepAccountOwners(
              contextPreserved.steps,
              prev,
              currentAccountName,
              entryAccountName
            );
            const mergedSteps = mergeRetainedRevertedSteps(stepsWithOwners, prev);
            const preservedRawStepCount = conv.rawStepCount ?? steps.length;
            conv.rawStepCount = preservedRawStepCount;
            conv.stepCount = mergedSteps.length;
            const cacheEntry = {
              signature: finalSig,
              accountName: entryAccountName,
              title: conv.title,
              lastModifiedMs: resolvedLastModMs,
              diskMtimeMs:
                conv.diskMtimeMs ?? readConversationMtime(diskConvMap.get(cidLower)),
              rawStepCount: preservedRawStepCount,
              wasRunning: conv.status === 'CASCADE_RUN_STATUS_RUNNING',
              contextLimitTelemetry: true,
              speedClearedTelemetry: true,
              turnRailTelemetry: true,
              wakeupTurnTelemetry: true,
              contextGroupsTelemetry: 3,
              anomalyTelemetry: 1,
              imageGenTelemetry: 1,
              steps: mergedSteps,
              ...(contextPreserved.lastKnownStaticContext
                ? { lastKnownStaticContext: contextPreserved.lastKnownStaticContext }
                : {}),
              subagentRefs,
            };
            if (rpcSwarmMeta) cacheEntry.swarmMeta = rpcSwarmMeta;
            if (isParkedSwarm) cacheEntry.parkedOnSwarmWait = true;
            if (conv.diskFileSig) cacheEntry.diskFileSig = conv.diskFileSig;
            if (conv.workspaceUri) cacheEntry.workspaceUri = conv.workspaceUri;
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
              !isDeepStrictEqual(
                prev?.lastKnownStaticContext || null,
                cacheEntry.lastKnownStaticContext || null
              ) ||
              Boolean(prev?.parkedOnSwarmWait) !== Boolean(cacheEntry.parkedOnSwarmWait) ||
              (prev?.rootConversationId || '') !== (cacheEntry.rootConversationId || '') ||
              Boolean(prev?.isSideQuestion) !== Boolean(cacheEntry.isSideQuestion);
            const stepsContentChanged =
              !prev || !isDeepStrictEqual(prev.steps, mergedSteps);
            const stepsChanged =
              stepsContentChanged ||
              Boolean(prev.offlineTranscriptFallback) ||
              prev.signature !== finalSig ||
              Boolean(prev.wasRunning) !== Boolean(cacheEntry.wasRunning) ||
              !prev.contextLimitTelemetry ||
              !prev.speedClearedTelemetry ||
              !prev.turnRailTelemetry ||
              Number(prev.contextGroupsTelemetry || 0) < 3 ||
              !prev.anomalyTelemetry ||
              !prev.imageGenTelemetry ||
              metaChanged;

            if (!stepsContentChanged) cacheEntry.steps = prev.steps;
            setEntry(conv.cascadeId, cacheEntry);
            if (!isRemote && loadedViaSqlite) {
              const nextCursor = buildSqliteIncrementalCursor({
                trajRes,
                rawSteps,
                generatorMeta,
                extractedSteps: steps,
                mergedSteps: cacheEntry.steps,
                subagentRefs,
                rpcSwarmMeta,
                prevCursor: usedIncrementalSqlite ? prevCursorForInc : null,
              });
              setSqliteIncrementalCursor(cidLower, nextCursor);
            } else {
              sqliteIncrementalCursorMap.delete(cidLower);
            }
            if (stepsChanged) {
              cacheDirty = true;
            }
          } catch (err) {
            let offlineRecovered = false;
            const cidLower = conv.cascadeId.toLowerCase();
            const diskFiles = isRemote ? [] : diskConvMap.get(cidLower) || [];
            if (!isRemote && (!prev || prev.offlineTranscriptFallback)) {
              if (!lazyExternalByLower) {
                lazyExternalByLower = new Map();
                const liveCoverageMap = new Map();
                for (const [rawId, cachedItem] of cacheStore.listCachedTrajectoryEntries()) {
                  const lid = String(rawId || '').toLowerCase();
                  if (!lid || !cachedItem || typeof cachedItem !== 'object') continue;
                  const prevCov = liveCoverageMap.get(lid);
                  if (!prevCov || (cachedItem.steps?.length || 0) > (prevCov.steps?.length || 0)) {
                    liveCoverageMap.set(lid, cachedItem);
                  }
                }
                for (const ext of loadExternalDeepStatsCache({ coveredByLive: liveCoverageMap }).values()) {
                  const extCid = String(ext?.cascadeId || '').toLowerCase();
                  if (!extCid) continue;
                  const existingExt = lazyExternalByLower.get(extCid);
                  if (!existingExt || (ext.steps?.length || 0) > (existingExt.steps?.length || 0)) {
                    lazyExternalByLower.set(extCid, ext);
                  }
                }
              }
              let coveredMinSteps = -1;
              if (
                !lazyExternalByLower.has(cidLower) &&
                externalDeepStatsMemo.pruned &&
                Array.isArray(externalDeepStatsMemo.coveredPairs)
              ) {
                coveredMinSteps = findCoveredPairMinSteps(
                  externalDeepStatsMemo.coveredPairs,
                  cidLower
                );
                if (coveredMinSteps > 0 && (!prev || (prev.steps?.length || 0) < coveredMinSteps)) {
                  for (const ext of loadExternalDeepStatsCache({ targetCascadeId: cidLower }).values()) {
                    const existingExt = lazyExternalByLower.get(cidLower);
                    if (!existingExt || (ext.steps?.length || 0) > (existingExt.steps?.length || 0)) {
                      lazyExternalByLower.set(cidLower, ext);
                    }
                  }
                }
              }
              const offlineFallback = loadOfflineTranscriptConversation(
                conv,
                diskFiles,
                lazyExternalByLower,
                localSummaryByLower.get(cidLower) || null,
                { skipSqlite: sqliteProbedEmpty || sqliteNotReady }
              );
              if (
                offlineFallback &&
                coveredMinSteps > 0 &&
                Array.isArray(prev?.steps) &&
                prev.steps.length >= coveredMinSteps &&
                offlineFallback.steps.length < prev.steps.length
              ) {
                offlineFallback.steps = prev.steps;
                offlineFallback.lastModifiedMs = Math.max(
                  Number(offlineFallback.lastModifiedMs || 0),
                  Number(prev.lastModifiedMs || 0)
                );
              }
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
                const offlinePreserved = preserveCachedContextTelemetry(offlineFallback.steps, prev);
                const offlineStepsWithOwners = attachStepAccountOwners(
                  offlinePreserved.steps,
                  prev,
                  offlineFallback.accountName || currentAccountName,
                  offlineAccountName
                );
                const offlineEntry = {
                  signature: sig,
                  accountName: offlineAccountName,
                  title: offlineFallback.title,
                  ...(offlineFallback.appSource ? { appSource: offlineFallback.appSource } : {}),
                  ...(conv.workspaceUri ? { workspaceUri: conv.workspaceUri } : {}),
                  ...(conv.diskFileSig ? { diskFileSig: conv.diskFileSig } : {}),
                  lastModifiedMs: offlineFallback.lastModifiedMs,
                  diskMtimeMs: resolvedDiskMtime,
                  rawStepCount: conv.rawStepCount ?? offlineStepsWithOwners.length,
                  wasRunning: isRunning,
                  offlineTranscriptFallback: true,
                  ...(offlineFallback.fromSqlite ? { offlineSqliteTelemetry: true } : {}),
                  contextLimitTelemetry: true,
                  speedClearedTelemetry: true,
                  turnRailTelemetry: true,
                  wakeupTurnTelemetry: true,
                  contextGroupsTelemetry: 3,
                  anomalyTelemetry: 1,
                  steps: offlineStepsWithOwners,
                  ...(offlinePreserved.lastKnownStaticContext
                    ? { lastKnownStaticContext: offlinePreserved.lastKnownStaticContext }
                    : {}),
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
                  JSON.stringify(prev.subagentRefs || []) !== JSON.stringify(offlineEntry.subagentRefs || []) ||
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
              !prev &&
              !isRemote &&
              (sqliteProbedEmpty || (!sqliteNotReady && hasLocalPbFile(diskFiles)))
            ) {
              // 本地 .db 为空壳或会话仅落盘加密 .pb、且连 transcript.jsonl 与 RPC 均无法恢复步骤时，避免顶栏继续虚标原始 step_count
              conv.stepCount = 0;
            }
            if (
              !offlineRecovered &&
              !(
                (!conv.inSummaries || summariesFromLocalDb || conv.appSource === 'cli') &&
                /(?:\(404\)|\bnot_found\b|Language Server address unavailable)/i.test(
                  String(err?.message || '')
                )
              )
            ) {
              console.error(`Failed loading trajectory ${conv.cascadeId}: ${err.message}`);
            }
            const errText = String(err?.message || '');
            const isNotFoundErr = /(?:\(404\)|\bnot_found\b)/i.test(errText);
            const isTimeoutErr = /(?:timed\s*out|timeout|etimedout|aborted)/i.test(errText);
            if (isRemote && isTimeoutErr) {
              remoteConsecutiveTimeouts += 1;
            }
            if (!(isRunning && (hasTailStepInfo || offlineRecovered))) {
              const cooldownMs = isNotFoundErr
                ? NOT_FOUND_RPC_COOLDOWN_MS
                : isRemote
                  ? isRunning || isReq
                    ? REMOTE_ACTIVE_FAILED_RPC_COOLDOWN_MS
                    : REMOTE_FAILED_RPC_COOLDOWN_MS
                  : isRunning || isReq
                    ? ACTIVE_FAILED_RPC_COOLDOWN_MS
                    : FAILED_RPC_COOLDOWN_MS;
              activeCooldownMap.set(cooldownKey, { failedAt: Date.now(), cooldownMs });
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
      if (
        !isRemote &&
        cacheDirty &&
        cacheStore.isSqliteBacked &&
        typeof cacheStore.getDirtySessionCount === 'function' &&
        cacheStore.getDirtySessionCount() >= LS_SCAN_CHUNK_FLUSH_SIZE &&
        !shouldAbort?.() &&
        !isStaleLocalGeneration()
      ) {
        if (cacheStore.flushTrajectoryCacheNow()) {
          cacheDirty = false;
        }
        await sliceYielder.forceYield();
      }
    }
  }

  // 阶段 1：拉取常规新增/变更会话，以及摘要列表中尚未提取 subagentRefs 的会话
  // 旧缓存只补读当前会话的宿主上限，避免重拉全部历史轨迹。
  const contextTelemetryCascadeId = reqLower || rawConversations[0]?.cascadeId.toLowerCase();
  const selectedRootId = rawConversations.find(
    (c) => c.cascadeId.toLowerCase() === contextTelemetryCascadeId
  )?.rootConversationId || contextTelemetryCascadeId;
  function hasMissingTurnRailFields(cached) {
    if (cached?._stepFlags) {
      return Boolean(cached._stepFlags.hasMissingTurnRailFields);
    }
    const steps = cached?.steps || [];
    const lastCachedStep = steps[steps.length - 1];
    if (!lastCachedStep) return false;
    return !Object.prototype.hasOwnProperty.call(lastCachedStep, 'turnIndex');
  }
  function hasDroppedContextGroups(cached) {
    const grpVer = Number(cached?.contextGroupsTelemetry || 0);
    if (grpVer >= 3) return false;
    const steps = cached?.steps || [];
    if (grpVer === 2) {
      if (cached?._stepFlags) {
        return steps.length > 0 && !cached._stepFlags.hasAnyContextBreakdown;
      }
      return steps.length > 0 && !steps.some((st) => Boolean(st?.contextBreakdown));
    }
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
    if (cached?._stepFlags) {
      return (cached.steps?.length || 0) > 0 && !cached._stepFlags.hasAnyTurnIndex;
    }
    const steps = cached?.steps || [];
    return steps.length > 0 && steps.every((s) => !s?.turnIndex);
  }

  let remainingTimingRefreshes = LEGACY_MIGRATION_BATCH_SIZE;
  const toFetch = rawConversations.filter((conv) => {
    const sig = buildConvSig(conv);
    if (isFetchInCooldown(conv, sig)) return false;
    const isRunning = conv.status === 'CASCADE_RUN_STATUS_RUNNING';
    let cached = getEntry(conv.cascadeId);
    if (!cached || conv.needsInitialLoad) return true;
    const lowerCid = conv.cascadeId.toLowerCase();
    const hasLiveBacking = Boolean(
      conv.inSummaries ||
        conv.dbPath ||
        (diskConvMap.get(lowerCid)?.length || 0) > 0 ||
        observedLiveIds.has(lowerCid)
    );
    if (cached.archived && hasLiveBacking) {
      const unarchived = { ...cached };
      delete unarchived.archived;
      setEntry(conv.cascadeId, unarchived);
      cached = getEntry(conv.cascadeId) || unarchived;
      cacheDirty = true;
    } else if (
      !hasLiveBacking &&
      (cached.steps?.length || 0) > 0 &&
      !cached.offlineTranscriptFallback
    ) {
      if (cached.archived) {
        return false;
      }
      if (hasAuthoritativeSourceSnapshot) {
        const cachedOwner = normalizeOwnerAccount(cached.accountName);
        const sameOrUnknownAccount =
          !normalizedPollAccount || !cachedOwner || cachedOwner === normalizedPollAccount;
        const parentRefLower = String(
          conv.rootConversationId || conv.parentConversationId || ''
        ).toLowerCase();
        const linkedToLiveParent = Boolean(parentRefLower && observedLiveIds.has(parentRefLower));
        if (sameOrUnknownAccount && !linkedToLiveParent) {
          setEntry(conv.cascadeId, { ...cached, archived: true });
          cacheDirty = true;
          return false;
        }
      }
    }
    const isSelectedFamily =
      lowerCid === contextTelemetryCascadeId ||
      lowerCid === selectedRootId ||
      Boolean(conv.rootConversationId && conv.rootConversationId.toLowerCase() === selectedRootId);
    if (!cached.contextLimitTelemetry && lowerCid === contextTelemetryCascadeId) return true;
    const isImgGenAgent =
      String(
        conv.subagentSpec?.typeName ||
          cached.subagentSpec?.typeName ||
          cached.agentTypeName ||
          ''
      )
        .trim()
        .toLowerCase() === 'image-generator';
    if (!cached.imageGenTelemetry && isImgGenAgent) {
      return true;
    }
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
    let sigMatches = cached.signature === sig;
    if (
      !sigMatches &&
      conv.dbPath &&
      sqliteAvailable &&
      normalizeEmptyWalSqliteSig(cached.signature) === sig
    ) {
      setEntry(conv.cascadeId, { ...cached, signature: sig });
      cacheDirty = true;
      sigMatches = true;
    }
    if (!conv.inSummaries) {
      if (conv.dbPath && sqliteAvailable) {
        if (
          Boolean(isRunning) !== Boolean(cached.wasRunning) ||
          !sigMatches ||
          (isRunning && !activeLiveActivityMemo.has(lowerCid))
        ) {
          return true;
        }
        if (isRunning) {
          const prevLive = activeLiveActivityMemo.get(lowerCid);
          if (prevLive) {
            conv.liveActivity = prevLive;
          }
        }
        return false;
      }
      if (isRunning || cached.wasRunning) return true;
      if (
        cached.offlineTranscriptFallback &&
        !cached.offlineSqliteTelemetry &&
        hasBuiltinNodeSqlite() &&
        hasLocalSqliteDb(diskConvMap.get(lowerCid)) &&
        !String(cached.signature || '').startsWith(`${CACHE_SCHEMA_VERSION}:sqlite:`)
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
      const shouldRetryOfflineUpgrade =
        Boolean(cached.offlineTranscriptFallback) &&
        (!summariesFromLocalDb ||
          conv.appSource !== 'cli' ||
          (forceRefresh && lowerCid === reqLower));
      if (!isRemote && conv.dbPath && sqliteAvailable) {
        if (
          shouldRetryOfflineUpgrade ||
          missingSubagentRefs ||
          !sigMatches ||
          Boolean(isRunning) !== Boolean(cached.wasRunning) ||
          (isRunning && !activeLiveActivityMemo.has(lowerCid))
        ) {
          return true;
        }
        return false;
      }
      if (
        shouldRetryOfflineUpgrade ||
        missingSubagentRefs ||
        !sigMatches ||
        isRunning ||
        cached.wasRunning
      ) {
        return true;
      }
    }
    // 保留已有效的历史测速，按批补读需要确认原始状态与生成结束时间的旧步骤。
    const hasIncompleteTiming = cached?._stepFlags
      ? Boolean(cached._stepFlags.hasIncompleteTiming)
      : readStepFieldChecks(cached.steps).hasIncompleteTiming;
    if (!cached.speedClearedTelemetry && hasIncompleteTiming) {
      if (conv.cascadeId.toLowerCase() === selectedRootId || conv.rootConversationId === selectedRootId) return true;
      if (remainingTimingRefreshes > 0) {
        remainingTimingRefreshes -= 1;
        return true;
      }
    }
    return false;
  });

  let fetchQueue = toFetch;
  const useProgressiveLocal =
    !isRemote && Boolean(progressiveLocalSync) && lsScanCanYieldMacrotask();
  let deferredConvs = [];
  const deferredCidSet = new Set();

  if (isRemote && toFetch.length > 0) {
    const priorityConvs = [];
    const backgroundConvs = [];
    for (const conv of toFetch) {
      const lowerCid = conv.cascadeId.toLowerCase();
      const isPriority =
        conv.status === 'CASCADE_RUN_STATUS_RUNNING' ||
        lowerCid === reqLower ||
        lowerCid === contextTelemetryCascadeId ||
        lowerCid === selectedRootId ||
        Boolean(conv.rootConversationId && conv.rootConversationId.toLowerCase() === selectedRootId);
      if (isPriority) {
        priorityConvs.push(conv);
      } else if (remainingRemoteBackgroundBudget > 0) {
        backgroundConvs.push(conv);
        remainingRemoteBackgroundBudget -= 1;
      }
    }
    fetchQueue = [...priorityConvs, ...backgroundConvs];
  } else if (useProgressiveLocal && toFetch.length > 0) {
    const priorityConvs = [];
    const nonPriorityConvs = [];
    for (const conv of toFetch) {
      const lowerCid = conv.cascadeId.toLowerCase();
      const parentLower = String(conv.parentConversationId || '').toLowerCase();
      const rootLower = String(conv.rootConversationId || '').toLowerCase();
      const isPriority =
        conv.status === 'CASCADE_RUN_STATUS_RUNNING' ||
        lowerCid === reqLower ||
        lowerCid === contextTelemetryCascadeId ||
        lowerCid === selectedRootId ||
        Boolean(parentLower && parentLower === selectedRootId) ||
        Boolean(rootLower && rootLower === selectedRootId);
      if (isPriority) {
        priorityConvs.push(conv);
      } else {
        nonPriorityConvs.push(conv);
      }
    }
    const drainAlreadyRunning =
      Boolean(activeLocalBackgroundDrain) && localRebuildState.generation === scanGeneration;
    if (drainAlreadyRunning) {
      fetchQueue = priorityConvs;
      deferredConvs = nonPriorityConvs;
    } else if (nonPriorityConvs.length > LS_SCAN_FOREGROUND_BUDGET) {
      fetchQueue = [
        ...priorityConvs,
        ...nonPriorityConvs.slice(0, LS_SCAN_FOREGROUND_BUDGET),
      ];
      deferredConvs = nonPriorityConvs.slice(LS_SCAN_FOREGROUND_BUDGET);
    } else {
      fetchQueue = toFetch;
    }
    for (const dc of deferredConvs) {
      deferredCidSet.add(dc.cascadeId.toLowerCase());
    }
  }

  await fetchTrajectoryBatch(fetchQueue, { shouldAbort: fgShouldAbort });

  if (deferredCidSet.size > 0 && reqLower && !isStaleLocalGeneration()) {
    const rawByLower = new Map(rawConversations.map((c) => [c.cascadeId.toLowerCase(), c]));
    const visitedAnc = new Set([reqLower]);
    let frontier = [rawByLower.get(reqLower)].filter(Boolean);
    for (let hop = 0; hop < 8 && frontier.length > 0 && deferredCidSet.size > 0; hop++) {
      if (isStaleLocalGeneration()) break;
      const promotedBatch = [];
      const nextFrontier = [];
      for (const cur of frontier) {
        for (const rawAnc of [cur.parentConversationId, cur.rootConversationId]) {
          const cleanAnc = String(rawAnc || '').trim().toLowerCase();
          if (!cleanAnc || visitedAnc.has(cleanAnc)) continue;
          visitedAnc.add(cleanAnc);
          const ancConv = rawByLower.get(cleanAnc);
          if (!ancConv) continue;
          nextFrontier.push(ancConv);
          if (deferredCidSet.has(cleanAnc)) {
            deferredCidSet.delete(cleanAnc);
            promotedBatch.push(ancConv);
          }
        }
      }
      if (promotedBatch.length > 0) {
        await fetchTrajectoryBatch(promotedBatch, { shouldAbort: fgShouldAbort });
      }
      frontier = nextFrontier;
    }
  }

  /**
   * 阶段 2：根据父会话的 `subagentRefs` 将子代理归属关系、角色名称与启动顺序回填至子代理会话，
   * 支持多层嵌套子代理（主会话 -> 子代理 -> 二级子代理）逐层补拉与归属收敛。
   */
  async function reconcileParentSubagentRefs({
    candidateParents = null,
    skipDeferredSet = null,
    shouldAbort = null,
  } = {}) {
    let currentParents = candidateParents ? [...candidateParents] : null;
    for (let depth = 0; depth < MAX_SUBAGENT_RECONCILE_DEPTH; depth++) {
      if (shouldAbort?.()) break;
      const byLowerId = new Map(rawConversations.map((c) => [c.cascadeId.toLowerCase(), c]));
      const missingSubagentsToFetch = [];
      const parentsToInspect = currentParents || [...rawConversations];

      for (const parentConv of parentsToInspect) {
        if (shouldAbort?.()) break;
        const parentId = parentConv.cascadeId.toLowerCase();
        if (skipDeferredSet && skipDeferredSet.has(parentId)) {
          continue;
        }
        const parentCached = getEntry(parentConv.cascadeId);
        const baseRefs = parentConv.subagentRefs || parentCached?.subagentRefs || [];
        const swarmManifest =
          !isRemote && !parentConv.isSubagent
            ? getPollSwarmManifest(parentConv.cascadeId)
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

        const rootId = (
          parentConv.rootConversationId ||
          parentConv.parentConversationId ||
          parentId
        ).toLowerCase();

        for (const ref of refs) {
          const subCid = String(ref?.cascadeId || '').trim().toLowerCase();
          if (!subCid || subCid === parentId || hiddenArchivedIds.has(subCid)) continue;
          if (skipDeferredSet) {
            skipDeferredSet.delete(subCid);
          }

          const canonSubId = canonicalIdByLower.get(subCid) || subCid;
          canonicalIdByLower.set(subCid, canonSubId);
          let subConv = byLowerId.get(subCid);
          const subCached = getEntry(subConv?.cascadeId || canonSubId);
          if (!subConv) {
            const subDiskFiles = diskConvMap.get(subCid) || [];
            const subDbInfo = sqliteAvailable ? resolveBestSqliteDbInfo(subDiskFiles) : null;
            const subNeedFb =
              !isRemote &&
              subDiskFiles.length > 0 &&
              (!subDbInfo ||
                hasLocalPbFile(subDiskFiles) ||
                Boolean(subCached?.offlineTranscriptFallback));
            const subFallbackInfo = subNeedFb ? computeFallbackDiskInfo(subDiskFiles) : null;
            const diskMtimeMs = Math.max(
              readConversationMtime(subDiskFiles),
              subDbInfo?.mtimeMs || 0,
              subFallbackInfo?.mtimeMs || 0
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
              fallbackDiskSig: subFallbackInfo?.sig || '',
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
          const subSig = buildConvSig(subConv);
          const canUpgradeOfflineSub =
            Boolean(existingSubCache?.offlineTranscriptFallback && subConv.inSummaries) &&
            (!summariesFromLocalDb || subConv.appSource !== 'cli') &&
            !attemptedFetchIds.has(subCid) &&
            !isFetchInCooldown(subConv, subSig);
          const isImgGenSub =
            String(
              subConv.subagentSpec?.typeName ||
                existingSubCache?.subagentSpec?.typeName ||
                existingSubCache?.agentTypeName ||
                ''
            )
              .trim()
              .toLowerCase() === 'image-generator';
          const hasValidSubCache =
            existingSubCache &&
            !canUpgradeOfflineSub &&
            String(existingSubCache.signature || '').startsWith(
              subConv.dbPath && sqliteAvailable
                ? `${CACHE_SCHEMA_VERSION}:sqlite:`
                : `${CACHE_SCHEMA_VERSION}:`
            ) &&
            !hasMissingStepFields(existingSubCache) &&
            (!isImgGenSub || Boolean(existingSubCache.imageGenTelemetry)) &&
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
            if (!attemptedFetchIds.has(subCid) && !isFetchInCooldown(subConv, subSig)) {
              missingSubagentsToFetch.push(subConv);
            }
          }
        }
      }

      if (missingSubagentsToFetch.length === 0 || isRemoteFetchHalted()) break;
      let subagentFetchQueue = missingSubagentsToFetch;
      if (isRemote) {
        const prioritySubs = [];
        const backgroundSubs = [];
        for (const subConv of missingSubagentsToFetch) {
          const isPrioritySub =
            subConv.status === 'CASCADE_RUN_STATUS_RUNNING' ||
            subConv.cascadeId.toLowerCase() === reqLower ||
            Boolean(subConv.rootConversationId && subConv.rootConversationId.toLowerCase() === selectedRootId);
          if (isPrioritySub) {
            prioritySubs.push(subConv);
          } else if (remainingRemoteBackgroundBudget > 0) {
            backgroundSubs.push(subConv);
            remainingRemoteBackgroundBudget -= 1;
          }
        }
        subagentFetchQueue = [...prioritySubs, ...backgroundSubs];
      }
      if (subagentFetchQueue.length === 0 || shouldAbort?.()) break;
      await fetchTrajectoryBatch(subagentFetchQueue, { shouldAbort });
      if (currentParents) {
        currentParents = subagentFetchQueue;
      }
    }
  }

  await reconcileParentSubagentRefs({
    skipDeferredSet: deferredCidSet.size > 0 ? deferredCidSet : null,
    shouldAbort: fgShouldAbort,
  });

  // 阶段 3：对剩余尚未标记 subagentRefs 的纯磁盘历史会话每次增量迁移最多 8 个（远端共享整轮背景额度），避免单次轮询阻塞
  const legacyBatchCap = isRemote
    ? isRemoteFetchHalted()
      ? 0
      : Math.min(LEGACY_MIGRATION_BATCH_SIZE, remainingRemoteBackgroundBudget)
    : deferredCidSet.size > 0
      ? 0
      : LEGACY_MIGRATION_BATCH_SIZE;
  const remainingLegacyDiskConvs =
    legacyBatchCap > 0
      ? rawConversations
          .filter((c) => {
            const sig = buildConvSig(c);
            if (attemptedFetchIds.has(c.cascadeId.toLowerCase()) || isFetchInCooldown(c, sig)) {
              return false;
            }
            const cached = getEntry(c.cascadeId);
            return cached && !Array.isArray(cached.subagentRefs);
          })
          .slice(0, legacyBatchCap)
      : [];

  if (remainingLegacyDiskConvs.length > 0 && !isStaleLocalGeneration()) {
    if (isRemote) {
      remainingRemoteBackgroundBudget = Math.max(
        0,
        remainingRemoteBackgroundBudget - remainingLegacyDiskConvs.length
      );
    }
    await fetchTrajectoryBatch(remainingLegacyDiskConvs, { shouldAbort: fgShouldAbort });
    await reconcileParentSubagentRefs({ shouldAbort: fgShouldAbort });
  }

  // 阶段 4：将多层嵌套子代理的 rootConversationId 沿着父链向上收敛至最顶层根会话，防止二级子代理丢失
  function convergeSubagentRootChain(targetConvs, lookupById) {
    for (const conv of targetConvs) {
      if (!conv?.isSubagent) continue;
      const cid = conv.cascadeId.toLowerCase();
      let candidate = (conv.rootConversationId || conv.parentConversationId || '').toLowerCase();
      if (candidate === cid) {
        candidate = (conv.parentConversationId || '').toLowerCase();
      }
      const visited = new Set([cid]);
      while (candidate && !visited.has(candidate)) {
        visited.add(candidate);
        const ancestor = lookupById.get(candidate);
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
  }

  const byId = new Map(rawConversations.map((c) => [c.cascadeId.toLowerCase(), c]));
  convergeSubagentRootChain(rawConversations, byId);

  const hasRunningSessions = rawConversations.some(
    (c) => c.status === 'CASCADE_RUN_STATUS_RUNNING'
  );
  if (cacheDirty || (hasPendingSave() && !hasRunningSessions)) {
    persistCacheIfNeeded({ hasRunningSessions });
    cacheDirty = false;
  }

  function isDeferredConvAlreadySynced(conv) {
    if (!conv) return true;
    const curCached = getEntry(conv.cascadeId);
    if (!curCached || curCached.offlineTranscriptFallback || curCached.wasRunning) {
      return false;
    }
    const sig = buildConvSig(conv);
    if (curCached.signature !== sig) return false;
    if (
      conv.dbPath &&
      sqliteAvailable &&
      !String(curCached.signature || '').startsWith(`${CACHE_SCHEMA_VERSION}:sqlite:`)
    ) {
      return false;
    }
    if (hasMissingStepFields(curCached) || !Array.isArray(curCached.subagentRefs)) {
      return false;
    }
    const hasIncompleteTiming = curCached._stepFlags
      ? Boolean(curCached._stepFlags.hasIncompleteTiming)
      : readStepFieldChecks(curCached.steps).hasIncompleteTiming;
    if (!curCached.speedClearedTelemetry && hasIncompleteTiming) {
      return false;
    }
    return true;
  }

  let snapshotDeferredCascadeIds = null;
  if (!isRemote && useProgressiveLocal) {
    const remainingDeferred =
      deferredCidSet.size > 0
        ? deferredConvs.filter(
            (c) =>
              deferredCidSet.has(c.cascadeId.toLowerCase()) &&
              !isDeferredConvAlreadySynced(c) &&
              !isFetchInCooldown(c, buildConvSig(c))
          )
        : [];
    if (remainingDeferred.length > 0) {
      snapshotDeferredCascadeIds = new Set(
        remainingDeferred.map((c) => c.cascadeId.toLowerCase())
      );
    }
    const trackRebuildProgress =
      scanGeneration === localRebuildGeneration &&
      Boolean(localRebuildState.armed || localRebuildState.active);
    if (
      remainingDeferred.length > 0 &&
      !activeLocalBackgroundDrain &&
      scanGeneration === localRebuildGeneration &&
      !localBackgroundDrainStopped
    ) {
      if (trackRebuildProgress) {
        const totalToRebuild = Math.max(rawConversations.length, localRebuildState.total || 0);
        localRebuildState = {
          armed: false,
          active: true,
          generation: scanGeneration,
          completed: Math.max(0, totalToRebuild - remainingDeferred.length),
          total: Math.max(totalToRebuild, remainingDeferred.length),
          remaining: remainingDeferred.length,
          updatedAtMs: Date.now(),
        };
      }
      const shouldAbortBg = () =>
        scanGeneration !== localRebuildGeneration || localBackgroundDrainStopped;
      const drainQueue = remainingDeferred.slice();
      const drainTask = (async () => {
        for (let off = 0; off < drainQueue.length; off += LS_SCAN_BG_DRAIN_BATCH) {
          if (shouldAbortBg()) return;
          await lsScanWaitUnrefDelay(LS_SCAN_BG_INTER_BATCH_DELAY_MS);
          if (shouldAbortBg()) return;
          const rawChunk = drainQueue.slice(off, off + LS_SCAN_BG_DRAIN_BATCH);
          for (let j = off; j < Math.min(drainQueue.length, off + LS_SCAN_BG_DRAIN_BATCH); j++) {
            drainQueue[j] = null;
          }
          const pendingChunk = [];
          for (const conv of rawChunk) {
            if (!conv || isDeferredConvAlreadySynced(conv)) {
              continue;
            }
            attemptedFetchIds.delete(conv.cascadeId.toLowerCase());
            pendingChunk.push(conv);
          }
          if (pendingChunk.length > 0) {
            const rawLenBefore = rawConversations.length;
            await fetchTrajectoryBatch(pendingChunk, { shouldAbort: shouldAbortBg });
            if (shouldAbortBg()) return;
            await reconcileParentSubagentRefs({
              candidateParents: pendingChunk,
              shouldAbort: shouldAbortBg,
            });
            if (shouldAbortBg()) return;
            const latestById = new Map(rawConversations.map((c) => [c.cascadeId.toLowerCase(), c]));
            const touchedSubs = [
              ...pendingChunk.filter((c) => c.isSubagent),
              ...rawConversations.slice(rawLenBefore),
            ];
            if (touchedSubs.length > 0) {
              convergeSubagentRootChain(touchedSubs, latestById);
            }
            const batchModifiedCache = Boolean(cacheDirty || hasPendingSave());
            if (!shouldAbortBg() && batchModifiedCache) {
              cacheStore.flushTrajectoryCacheNow();
              cacheDirty = false;
            }
            if (batchModifiedCache || trackRebuildProgress) {
              localRebuildBatchHook?.({ finished: false });
            }
          }
          if (shouldAbortBg()) return;
          if (trackRebuildProgress) {
            const rem = Math.max(0, drainQueue.length - (off + LS_SCAN_BG_DRAIN_BATCH));
            const tot = Math.max(localRebuildState.total || 0, rawConversations.length);
            localRebuildState = {
              armed: false,
              active: rem > 0,
              generation: scanGeneration,
              completed: Math.max(0, tot - rem),
              total: tot,
              remaining: rem,
              updatedAtMs: Date.now(),
            };
          }
        }
        if (!shouldAbortBg()) {
          if (cacheDirty || hasPendingSave()) {
            cacheStore.flushTrajectoryCacheNow();
            cacheDirty = false;
          }
          if (trackRebuildProgress) {
            const finalTotal = Math.max(localRebuildState.total || 0, rawConversations.length);
            localRebuildState = {
              armed: false,
              active: false,
              generation: scanGeneration,
              completed: finalTotal,
              total: finalTotal,
              remaining: 0,
              updatedAtMs: Date.now(),
            };
          }
          localRebuildBatchHook?.({ finished: true });
        }
      })().finally(() => {
        if (activeLocalBackgroundDrain === drainTask) {
          activeLocalBackgroundDrain = null;
        }
      });
      activeLocalBackgroundDrain = drainTask;
    } else if (
      remainingDeferred.length === 0 &&
      !activeLocalBackgroundDrain &&
      trackRebuildProgress
    ) {
      const doneTotal = Math.max(rawConversations.length, localRebuildState.total || 0);
      localRebuildState = {
        armed: false,
        active: false,
        generation: scanGeneration,
        completed: doneTotal,
        total: doneTotal,
        remaining: 0,
        updatedAtMs: Date.now(),
      };
    }
  } else if (
    !isRemote &&
    !activeLocalBackgroundDrain &&
    (localRebuildState.armed || localRebuildState.active) &&
    scanGeneration === localRebuildGeneration
  ) {
    const doneTotal = Math.max(rawConversations.length, localRebuildState.total || 0);
    localRebuildState = {
      armed: false,
      active: false,
      generation: scanGeneration,
      completed: doneTotal,
      total: doneTotal,
      remaining: 0,
      updatedAtMs: Date.now(),
    };
  }

  // 确保所有处于 RUNNING 状态的会话（含本轮未触发 RPC 拉取的会话）都同步了最新的实时动作摘要，并剔除已进入 swarm_wait 待命的假运行态
  for (const conv of rawConversations) {
    if (conv.status === 'CASCADE_RUN_STATUS_RUNNING') {
      if (!conv.liveActivity) {
        const cidLower = conv.cascadeId.toLowerCase();
        const hasActiveBgTasks =
          Array.isArray(conv.activeBackgroundTasks) && conv.activeBackgroundTasks.length > 0;
        if (!hasActiveBgTasks) {
          const cachedConv = getEntry(conv.cascadeId);
          const parkedByCache =
            Boolean(cachedConv?.parkedOnSwarmWait) &&
            cachedConv.signature === buildConvSig(conv);
          const tailSteps = isRemote ? [] : readTranscriptTailSteps(conv.cascadeId);
          const isParked = tailSteps.length > 0 ? isParkedOnSwarmWait(tailSteps) : parkedByCache;
          if (isParked) {
            conv.status = 'IDLE';
            conv.liveActivity = null;
            activeLiveActivityMemo.delete(cidLower);
            continue;
          }
        }
        const fallbackMs = conv.lastModifiedMs || conv.createdTimeMs || 0;
        const memoTaskSteps =
          activeLiveActivityMemo.get(cidLower)?.taskSteps ||
          sqliteIncrementalCursorMap.get(cidLower)?.lastTaskSteps ||
          null;
        const resolved = resolveBestLiveActivity(
          conv.cascadeId,
          hasActiveBgTasks ? conv.activeBackgroundTasks : [],
          true,
          fallbackMs,
          {
            isRemote,
            liveActivityMemoMap: activeLiveActivityMemo,
            fallbackTaskSteps: memoTaskSteps,
          }
        );
        if (resolved?.actionKey === 'swarm_wait' && !hasActiveBgTasks) {
          conv.status = 'IDLE';
          conv.liveActivity = null;
          activeLiveActivityMemo.delete(cidLower);
          continue;
        }
        conv.liveActivity = resolved;
        if (resolved) {
          activeLiveActivityMemo.set(cidLower, resolved);
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

  let titleBackfillDirty = false;
  let titleLoopCount = 0;
  for (const rootConv of conversations) {
    titleLoopCount += 1;
    if ((titleLoopCount & 23) === 0) {
      const ypTitle = sliceYielder.maybeYield();
      if (ypTitle) await ypTitle;
    }
    const cid = rootConv.cascadeId.toLowerCase();
    const isDeferredRoot = deferredCidSet.has(cid);
    const rootCached = getEntry(rootConv.cascadeId);
    const swarmManifest =
      isRemote || (isDeferredRoot && titleLoopCount > 30) ? null : getPollSwarmManifest(cid);
    const swarmTitle = String(swarmManifest?.title || rootCached?.swarmMeta?.title || '').trim();
    if (swarmTitle) {
      rootConv.swarmTitle = swarmTitle;
      if (!isMeaningfulTitle(rootConv.title, cid)) {
        rootConv.title = swarmTitle;
      }
    }
    if (!isMeaningfulTitle(rootConv.title, cid)) {
      const localSumTitle = localSummaryByLower.get(cid)?.title || '';
      let recoveredTitle = pickFirstMeaningfulTitle(cid, [
        localSumTitle,
        rootCached?.title,
      ]);
      if (!recoveredTitle && rootCached) {
        const probeKey = `${isRemote ? `${String(endpoint?.id || 'remote')}#${Number(endpoint?.instanceId || 0)}` : 'local'}::${cid}`;
        const accRev = Number(rootCached._accountingRev || 0);
        const stepsLen = Array.isArray(rootCached.steps) ? rootCached.steps.length : 0;
        const cachedProbe = stepTitleProbeMemo.get(probeKey);
        if (cachedProbe && accRev > 0 && cachedProbe.accRev === accRev && cachedProbe.stepsLen === stepsLen) {
          recoveredTitle = cachedProbe.title;
        } else if (
          rootCached._coldSteps &&
          rootCached._stepFlags &&
          rootCached._stepFlags.hasAnyTurnIndex === false
        ) {
          recoveredTitle = '';
          if (stepTitleProbeMemo.size >= MAX_STEP_TITLE_PROBE_MEMO) {
            stepTitleProbeMemo.delete(stepTitleProbeMemo.keys().next().value);
          }
          stepTitleProbeMemo.set(probeKey, { accRev, stepsLen, title: '' });
        } else {
          const titleSourceEntry = rootCached._coldSteps
            ? getHydratedEntry(rootConv.cascadeId) || rootCached
            : rootCached;
          recoveredTitle = pickFirstMeaningfulTitle(cid, [
            extractFirstStepTurnTitle(titleSourceEntry?.steps),
          ]);
          if (stepTitleProbeMemo.has(probeKey)) {
            stepTitleProbeMemo.delete(probeKey);
          } else if (stepTitleProbeMemo.size >= MAX_STEP_TITLE_PROBE_MEMO) {
            stepTitleProbeMemo.delete(stepTitleProbeMemo.keys().next().value);
          }
          stepTitleProbeMemo.set(probeKey, { accRev, stepsLen, title: recoveredTitle || '' });
        }
      }
      if (!recoveredTitle && !isRemote && (!isDeferredRoot || titleLoopCount <= 30)) {
        recoveredTitle = probeLocalFallbackTitle(
          cid,
          rootConv.diskMtimeMs || rootConv.lastModifiedMs || 0
        );
      }
      if (recoveredTitle) {
        rootConv.title = recoveredTitle;
        const curRootCached = getEntry(rootConv.cascadeId) || rootCached;
        if (curRootCached && curRootCached.title !== recoveredTitle) {
          setEntry(rootConv.cascadeId, { ...curRootCached, title: recoveredTitle });
          titleBackfillDirty = true;
        }
      }
    }
    const latestRootCached = getEntry(rootConv.cascadeId);
    if (rootConv.workspaceUri && latestRootCached && latestRootCached.workspaceUri !== rootConv.workspaceUri) {
      setEntry(rootConv.cascadeId, { ...latestRootCached, workspaceUri: rootConv.workspaceUri });
      titleBackfillDirty = true;
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

  if (titleBackfillDirty) {
    const hasRunningSessions = rawConversations.some(
      (c) => c.status === 'CASCADE_RUN_STATUS_RUNNING'
    );
    persistCacheIfNeeded({ hasRunningSessions });
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
  const activeCascadeId =
    activeConvSummary?.cascadeId ||
    (safeReqId && !hiddenArchivedIds.has(reqLower) ? safeReqId : null);

  return {
    conversations,
    activeConvSummary,
    activeCascadeId,
    deferredCascadeIds: snapshotDeferredCascadeIds,
  };
}
