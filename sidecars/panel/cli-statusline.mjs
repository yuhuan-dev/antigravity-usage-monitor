/**
 * @fileoverview Antigravity CLI (`agy`) 轻量底部状态栏入口 (`cli-statusline.mjs`)。
 *
 * 由 `agy` TUI 在会话状态变更时通过 `statusLine` 配置拉起（300ms 节流，stdin 传入 `StatusLineData` JSON）：
 * 1. 秒级合并三路数据源：
 *    - `stdin` 实时状态（`agent_state`、`context_window.used_percentage`、`cost`、`subagents`、`cwd`）；
 *    - `~/.gemini/antigravity-cli/conversations/<cid>.db` 最新一步的纳秒级 `TPS` / `TTFT` / 缓存命中率；
 *    - `DATA_DIR/cli-status-snapshot.json` 中的官方配额池余量与跨端在线会话计数；
 * 2. 联动用户偏好设置中的胶囊槽位顺序（`topbarCapsuleSlots`）与开关（`enableCliStatusLine`），
 *    向 `stdout` 输出单行 24-bit ANSI 状态胶囊。
 *
 * 同时支持直接在 `/statusline` 命令末尾传入定制参数，及手动管理命令：
 * - `--slots tps,ttft,cache_hit,session_cost,quota_auto,context`（支持预设名 `compact` / `balanced` / `full` / `auto`）
 * - `--preset compact|balanced|full`
 * - `--multi` / `--no-multi`（开关多会话计数指示）
 * - `--anomaly` / `--no-anomaly`（开关最近一步异常角标）
 * - `--lang zh-CN|en-US|auto`、`--no-color`
 * - `node sidecars/panel/cli-statusline.mjs --install [--preset full --no-multi ...]`
 * - `node sidecars/panel/cli-statusline.mjs --uninstall`
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractLiveActivity,
  extractModelSteps,
  speedMetric,
  summarizeSpeed,
  summarizeTtft,
} from './trajectory-metrics.mjs';
import {
  readLocalSqliteLiveTail,
  readLocalSqliteParentLink,
  readLocalSqliteTrajectory,
  readLocalSummaryIndex,
} from './backend/cli-sqlite-reader.mjs';
import { computeSqliteWalSig, withReadOnlySqliteDb } from './backend/sqlite-client.mjs';
import {
  buildTranscriptFallbackTrajectory,
  resolveTranscriptPathInLogsDir,
} from './backend/transcript-fallback.mjs';
import {
  buildCliJsonStatusOutput,
  ensureCliStatusLineConfigured,
  formatCliStatusLineCapsule,
  normalizeCliStatusLineGaugeStyle,
} from './backend/cli-statusline-config.mjs';
import {
  CLI_STATUS_SNAPSHOT_FILE,
  CLI_STATUSLINE_PRESETS,
  DATA_DIR,
  TOPBAR_SLOT_KEYS,
  loadJson,
  loadSettings,
  normalizeCliStatusLineSlots,
  normalizeTopbarMultiSessionMode,
  resolveEffectiveCliStatusLineSlots,
  saveJson,
} from './backend/config.mjs';
import { computeStepCost, createStepModelResolver } from './backend/model-pricing.mjs';
import { isThirdPartyPoolText } from './shared/telemetry-display-rules.mjs';
import { normalizePathForWorkspaceMatch } from './shared/workspace-uri.mjs';

const CLI_RUNNING_STALE_MS = 10 * 60 * 1000;
const SNAPSHOT_LIVE_RUNNING_TTL_MS = 20 * 1000;
const SNAPSHOT_QUOTA_TTL_MS = 6 * 3600 * 1000;

function loadFreshestCliStatusSnapshot(geminiBase) {
  if (String(process.env.USAGE_MONITOR_DATA_DIR || '').trim()) {
    return loadJson(CLI_STATUS_SNAPSHOT_FILE, null);
  }
  const candidates = [
    CLI_STATUS_SNAPSHOT_FILE,
    join(geminiBase, 'antigravity', 'sidecar_data', 'usage-monitor', 'panel', 'data', 'cli-status-snapshot.json'),
    join(geminiBase, 'antigravity-cli', 'sidecar_data', 'usage-monitor', 'panel', 'data', 'cli-status-snapshot.json'),
  ];
  let best = null;
  let bestTs = -1;
  const seen = new Set();
  for (const file of candidates) {
    const key = process.platform === 'win32' ? file.toLowerCase() : file;
    if (seen.has(key)) continue;
    seen.add(key);
    const snap = loadJson(file, null);
    if (!snap || typeof snap !== 'object') continue;
    const ts = Number.isFinite(Number(snap.updatedAtMs)) ? Number(snap.updatedAtMs) : 0;
    if (!best || ts > bestTs) {
      best = snap;
      bestTs = ts;
    }
  }
  return best;
}

function readStdinJsonWithTimeout(timeoutMs = 220) {
  if (process.stdin.isTTY) {
    return Promise.resolve(null);
  }
  return new Promise((resolveDone) => {
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        process.stdin.pause();
      } catch {
        // 忽略关闭异常
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolveDone(null);
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolveDone(parsed && typeof parsed === 'object' ? parsed : null);
      } catch {
        resolveDone(null);
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    process.stdin.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    process.stdin.resume();
  });
}

function normalizePathForMatch(rawPath) {
  return normalizePathForWorkspaceMatch(rawPath);
}

function extractConversationIdFromStdin(stdinData) {
  if (!stdinData || typeof stdinData !== 'object') return '';
  const direct = String(
    stdinData.conversation_id ||
      stdinData.conversationId ||
      stdinData.session_id ||
      stdinData.sessionId ||
      process.env.ANTIGRAVITY_CONVERSATION_ID ||
      ''
  )
    .trim()
    .toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(direct)) {
    return direct;
  }
  const transcriptPath = String(stdinData.transcript_path || stdinData.transcriptPath || '');
  const m = transcriptPath.match(
    /[\\/]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[\\/]/i
  );
  return m ? m[1].toLowerCase() : '';
}

function findConversationIdByWorkspaceFts(cliRoot, cwd) {
  if (!cwd) return '';
  const summariesDbPath = join(cliRoot, 'conversation_summaries.db');
  if (!existsSync(summariesDbPath)) return '';

  const normCwd = normalizePathForMatch(cwd);
  if (!normCwd) return '';

  try {
    const matched = withReadOnlySqliteDb(summariesDbPath, (db) => {
      const rows = db
        .prepare(
          `SELECT conversation_id, workspace, last_modified_time
             FROM conversations_fts
            WHERE chunk_index = -1
            ORDER BY last_modified_time DESC
            LIMIT 40`
        )
        .all();
      for (const row of rows || []) {
        const ws = normalizePathForMatch(row?.workspace);
        const cid = String(row?.conversation_id || '').trim().toLowerCase();
        if (cid && ws && ws === normCwd) {
          return cid;
        }
      }
      return '';
    });
    return matched || '';
  } catch {
    // 忽略不存在 conversations_fts 表或读取失败
    return '';
  }
}

function resolveCliTranscriptPath(cliRoot, cid) {
  if (!cliRoot || !cid) return '';
  return resolveTranscriptPathInLogsDir(join(cliRoot, 'brain', cid, '.system_generated', 'logs'));
}

/**
 * 解析当前 CLI 窗口对应的本地 `.db`（或降级 `.pb` + `transcript.jsonl`）会话轨迹并计算最新测速、延迟、缓存与成本指标。
 *
 * @param {{ cliRoot: string, stdinData?: object|null, nowMs?: number }} params
 */
export function resolveCliLocalSessionMetrics({
  cliRoot,
  stdinData = null,
  nowMs = Date.now(),
}) {
  const convDir = join(cliRoot, 'conversations');
  const summariesMap = existsSync(cliRoot) ? readLocalSummaryIndex([cliRoot]) : new Map();

  let runningRootCount = 0;
  let runningSubCount = 0;
  const freshRunningRootIds = [];
  for (const [cidKey, summary] of summariesMap.entries()) {
    const isFreshRunning =
      summary.status === 'CASCADE_RUN_STATUS_RUNNING' &&
      summary.lastModifiedMs > 0 &&
      nowMs - summary.lastModifiedMs <= CLI_RUNNING_STALE_MS;
    if (!isFreshRunning) continue;
    if (summary.parentConversationId) runningSubCount += 1;
    else {
      runningRootCount += 1;
      freshRunningRootIds.push(String(cidKey || '').toLowerCase());
    }
  }

  if (!existsSync(convDir)) {
    return {
      found: false,
      runningRootCount,
      runningSubCount,
    };
  }

  let targetCid = extractConversationIdFromStdin(stdinData);
  const effectiveCwd =
    stdinData?.cwd ||
    stdinData?.workspace?.current_dir ||
    stdinData?.workspace?.project_dir ||
    '';
  if (!targetCid && effectiveCwd) {
    const ftsCid = findConversationIdByWorkspaceFts(cliRoot, effectiveCwd);
    if (
      ftsCid &&
      (existsSync(join(convDir, `${ftsCid}.db`)) || existsSync(join(convDir, `${ftsCid}.pb`)))
    ) {
      targetCid = ftsCid;
    }
  }

  let dbPath = targetCid ? join(convDir, `${targetCid}.db`) : '';
  let pbPath = targetCid ? join(convDir, `${targetCid}.pb`) : '';
  if (!targetCid || (!existsSync(dbPath) && !existsSync(pbPath))) {
    let candidates = [];
    try {
      const byCid = new Map();
      for (const name of readdirSync(convDir)) {
        const isDb = name.endsWith('.db');
        const isPb = !isDb && name.endsWith('.pb');
        if (!isDb && !isPb) continue;
        const cid = name.slice(0, -3).toLowerCase();
        const full = join(convDir, name);
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(full).mtimeMs || 0;
        } catch {
          // 忽略单文件 stat 异常
        }
        const existing = byCid.get(cid);
        if (!existing) {
          const summary = summariesMap.get(cid);
          byCid.set(cid, {
            cid,
            dbFull: isDb ? full : '',
            pbFull: isPb ? full : '',
            mtimeMs,
            isSubagent: Boolean(summary?.parentConversationId),
          });
        } else {
          if (isDb) existing.dbFull = full;
          if (isPb) existing.pbFull = full;
          if (mtimeMs > existing.mtimeMs) existing.mtimeMs = mtimeMs;
        }
      }
      candidates = Array.from(byCid.values()).sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch {
      candidates = [];
    }

    const picked = candidates.find((c) => !c.isSubagent) || candidates[0];
    if (picked) {
      targetCid = picked.cid;
      dbPath = picked.dbFull || join(convDir, `${picked.cid}.db`);
      pbPath = picked.pbFull || join(convDir, `${picked.cid}.pb`);
    }
  }

  const hasDbFile = Boolean(dbPath && existsSync(dbPath));
  const hasPbFile = Boolean(pbPath && existsSync(pbPath));
  if (!hasDbFile && !hasPbFile) {
    return {
      found: false,
      runningRootCount,
      runningSubCount,
    };
  }

  if (hasDbFile) {
    const parentLink = readLocalSqliteParentLink(dbPath);
    if (parentLink?.parentConversationId || parentLink?.rootConversationId) {
      const candidateRootId = parentLink.rootConversationId || parentLink.parentConversationId;
      const rootDb = join(convDir, `${candidateRootId}.db`);
      const rootPb = join(convDir, `${candidateRootId}.pb`);
      if (candidateRootId && (existsSync(rootDb) || existsSync(rootPb))) {
        targetCid = candidateRootId;
        dbPath = rootDb;
        pbPath = rootPb;
      }
    }
  } else {
    const summaryParent = summariesMap.get(targetCid)?.parentConversationId || '';
    if (summaryParent) {
      const rootDb = join(convDir, `${summaryParent}.db`);
      const rootPb = join(convDir, `${summaryParent}.pb`);
      if (existsSync(rootDb) || existsSync(rootPb)) {
        targetCid = summaryParent;
        dbPath = rootDb;
        pbPath = rootPb;
      }
    }
  }

  const walInfo = dbPath ? computeSqliteWalSig(dbPath) : { exists: false, mtimeMs: 0, sig: '' };
  let fallbackMtimeMs = 0;
  let fallbackSigPart = '';
  if (!walInfo.exists || (pbPath && existsSync(pbPath))) {
    const fbParts = [];
    if (pbPath) {
      try {
        const pbSt = statSync(pbPath, { throwIfNoEntry: false });
        if (pbSt) {
          fallbackMtimeMs = Math.max(fallbackMtimeMs, Number(pbSt.mtimeMs || 0));
          fbParts.push(`p:${Math.floor(Number(pbSt.mtimeMs || 0))}:${Number(pbSt.size || 0)}`);
        }
      } catch {
        // 忽略 stat 异常
      }
    }
    const trPath = resolveCliTranscriptPath(cliRoot, targetCid);
    if (trPath) {
      try {
        const trSt = statSync(trPath, { throwIfNoEntry: false });
        if (trSt) {
          fallbackMtimeMs = Math.max(fallbackMtimeMs, Number(trSt.mtimeMs || 0));
          fbParts.push(`t:${Math.floor(Number(trSt.mtimeMs || 0))}:${Number(trSt.size || 0)}`);
        }
      } catch {
        // 忽略 stat 异常
      }
    }
    fallbackSigPart = fbParts.join(',');
  }
  const dbMtimeMs = Math.max(walInfo.mtimeMs || 0, fallbackMtimeMs);
  const targetLower = String(targetCid || '').toLowerCase();
  const targetIsRunning = freshRunningRootIds.includes(targetLower);

  const effectiveDataDir = String(process.env.USAGE_MONITOR_DATA_DIR || '').trim() || DATA_DIR;
  const cliTrajMemoFile = join(effectiveDataDir, 'cli-statusline-traj-memo.json');
  const combinedSig = [walInfo.sig, fallbackSigPart].filter(Boolean).join('~');
  const prevMemo = combinedSig ? loadJson(cliTrajMemoFile, null) : null;
  const prevOtherCache =
    prevMemo && typeof prevMemo.otherWaiting === 'object' && prevMemo.otherWaiting !== null
      ? prevMemo.otherWaiting
      : {};
  const nextOtherCache = {};
  let memoDirty = false;

  let otherLocalWaiting = false;
  let checkedOthers = 0;
  for (const runCid of freshRunningRootIds) {
    if (!runCid || runCid === targetLower) continue;
    if (checkedOthers >= 3) break;
    const otherDb = join(convDir, `${runCid}.db`);
    const otherWal = computeSqliteWalSig(otherDb);
    if (!otherWal.exists) continue;
    checkedOthers += 1;
    const prevOther = prevOtherCache[otherDb];
    if (prevOther && prevOther.sig === otherWal.sig && typeof prevOther.waiting === 'boolean') {
      nextOtherCache[otherDb] = prevOther;
      if (prevOther.waiting) {
        otherLocalWaiting = true;
        break;
      }
      continue;
    }
    try {
      const otherTail = readLocalSqliteLiveTail(otherDb, 16);
      let isWaiting = false;
      if (otherTail && Array.isArray(otherTail.steps) && otherTail.steps.length > 0) {
        const otherAct = extractLiveActivity(otherTail.steps, true);
        isWaiting = Boolean(otherAct?.phase === 'waiting' || otherAct?.waitingApproval);
      }
      nextOtherCache[otherDb] = { sig: otherWal.sig, waiting: isWaiting };
      memoDirty = true;
      if (isWaiting) {
        otherLocalWaiting = true;
        break;
      }
    } catch {
      // 忽略单会话读取异常
    }
  }

  const targetMemoKey = combinedSig ? `v1::${targetCid}::${combinedSig}` : '';
  if (
    targetMemoKey &&
    prevMemo?.targetKey === targetMemoKey &&
    prevMemo?.metrics &&
    typeof prevMemo.metrics === 'object'
  ) {
    if (memoDirty) {
      saveJson(cliTrajMemoFile, {
        targetKey: targetMemoKey,
        metrics: prevMemo.metrics,
        otherWaiting: { ...prevOtherCache, ...nextOtherCache },
      });
    }
    const m = prevMemo.metrics;
    if (!m.found) {
      return {
        found: false,
        cascadeId: targetCid,
        dbMtimeMs,
        runningRootCount,
        runningSubCount,
        targetIsRunning,
        targetIsWaiting: Boolean(m.targetIsWaiting),
        targetWaitingApprovalFresh: Boolean(
          m.waitingApproval && dbMtimeMs > 0 && nowMs - dbMtimeMs <= CLI_RUNNING_STALE_MS
        ),
        otherLocalWaiting,
      };
    }
    return {
      found: true,
      cascadeId: targetCid,
      dbMtimeMs,
      stepCount: m.stepCount,
      runningRootCount,
      runningSubCount,
      targetIsRunning,
      targetIsWaiting: Boolean(m.targetIsWaiting),
      targetWaitingApprovalFresh: Boolean(
        m.waitingApproval && dbMtimeMs > 0 && nowMs - dbMtimeMs <= CLI_RUNNING_STALE_MS
      ),
      otherLocalWaiting,
      tps: m.tps,
      avgTps: m.avgTps,
      ttft: m.ttft,
      stepCost: m.stepCost,
      sessionCost: m.sessionCost,
      cacheHitPct: m.cacheHitPct,
      latestPromptTokens: m.latestPromptTokens,
      sessionTokens: m.sessionTokens,
      latestAnomaly: m.latestAnomaly,
      sessionAnomalyCount: m.sessionAnomalyCount,
      latestModelHint: m.latestModelHint,
      hasReportedLimit: m.hasReportedLimit,
      usedPct: m.usedPct,
    };
  }

  let traj = walInfo.exists
    ? readLocalSqliteTrajectory(dbPath, {
        cascadeId: targetCid,
        isRunning: targetIsRunning,
      })
    : null;
  if (traj?.parentConversationId) {
    const rootCid = traj.rootConversationId || traj.parentConversationId;
    const rootDb = join(convDir, `${rootCid}.db`);
    const rootPb = join(convDir, `${rootCid}.pb`);
    if (rootCid && rootCid !== targetCid) {
      if (existsSync(rootDb)) {
        const rootTraj = readLocalSqliteTrajectory(rootDb, { isRunning: true });
        if (rootTraj) {
          targetCid = rootCid;
          dbPath = rootDb;
          pbPath = rootPb;
          traj = rootTraj;
        } else if (existsSync(rootPb) || resolveCliTranscriptPath(cliRoot, rootCid)) {
          targetCid = rootCid;
          dbPath = rootDb;
          pbPath = rootPb;
          traj = null;
        }
      } else if (existsSync(rootPb) || resolveCliTranscriptPath(cliRoot, rootCid)) {
        targetCid = rootCid;
        dbPath = rootDb;
        pbPath = rootPb;
        traj = null;
      }
    }
  }
  if (!traj || !Array.isArray(traj.steps) || traj.steps.length === 0) {
    const fallbackTranscriptPath = resolveCliTranscriptPath(cliRoot, targetCid);
    traj = fallbackTranscriptPath
      ? buildTranscriptFallbackTrajectory(fallbackTranscriptPath, targetCid)
      : null;
  }

  if (!traj || !Array.isArray(traj.steps) || traj.steps.length === 0) {
    if (targetMemoKey) {
      saveJson(cliTrajMemoFile, {
        targetKey: targetMemoKey,
        metrics: { found: false, targetIsWaiting: false, waitingApproval: false },
        otherWaiting: { ...prevOtherCache, ...nextOtherCache },
      });
    }
    return {
      found: false,
      cascadeId: targetCid,
      dbMtimeMs,
      runningRootCount,
      runningSubCount,
      targetIsRunning: freshRunningRootIds.includes(String(targetCid || '').toLowerCase()),
      targetIsWaiting: false,
      targetWaitingApprovalFresh: false,
      otherLocalWaiting,
    };
  }

  const targetLiveAct = extractLiveActivity(traj.steps, true);
  const targetIsWaiting = Boolean(
    targetLiveAct?.phase === 'waiting' || targetLiveAct?.waitingApproval
  );
  const waitingApproval = Boolean(targetLiveAct?.waitingApproval);
  const targetWaitingApprovalFresh = Boolean(
    waitingApproval &&
      dbMtimeMs > 0 &&
      nowMs - dbMtimeMs <= CLI_RUNNING_STALE_MS
  );

  const steps = extractModelSteps(traj.steps, traj.generatorMetadata || []);
  if (steps.length === 0) {
    if (targetMemoKey) {
      saveJson(cliTrajMemoFile, {
        targetKey: targetMemoKey,
        metrics: { found: false, targetIsWaiting, waitingApproval },
        otherWaiting: { ...prevOtherCache, ...nextOtherCache },
      });
    }
    return {
      found: false,
      cascadeId: targetCid,
      dbMtimeMs,
      runningRootCount,
      runningSubCount,
      targetIsRunning,
      targetIsWaiting,
      targetWaitingApprovalFresh,
      otherLocalWaiting,
    };
  }

  const resolveStepModel = createStepModelResolver(new Map());
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;
  let sessionCostUsd = 0;
  let hasPricedStep = false;
  let latestStepCostUsd = null;
  let latestCacheHitPct = null;
  let latestPromptTokens = null;
  let latestContextTokens = 0;
  let latestLimitTokens = 0;
  let hasReportedLimit = false;
  let latestTps = null;
  let latestTtft = null;
  let sessionAnomalyCount = 0;
  let latestAnomaly = null;
  let latestModelHint = '';

  for (const step of steps) {
    const inTok = Math.max(0, Number(step.inputTokens || 0));
    const cacheTok = Math.max(0, Number(step.cacheReadTokens || 0));
    const outTok = Math.max(0, Number(step.outputTokens || 0));
    const promptTok = inTok + cacheTok;

    totalInputTokens += inTok;
    totalCacheReadTokens += cacheTok;
    totalOutputTokens += outTok;

    if (step.anomaly && Number(step.anomaly.count) > 0) {
      sessionAnomalyCount += Number(step.anomaly.count);
    }

    const modelInfo = resolveStepModel(step);
    if (modelInfo?.label || step.modelDisplayName || step.responseModel) {
      latestModelHint = String(
        modelInfo?.label || step.modelDisplayName || step.responseModel || ''
      ).trim();
    }
    const stepUsd = computeStepCost(step, modelInfo?.pricing || null);
    if (stepUsd !== null && Number.isFinite(stepUsd)) {
      sessionCostUsd += stepUsd;
      latestStepCostUsd = stepUsd;
      hasPricedStep = true;
    } else {
      latestStepCostUsd = null;
    }

    if (promptTok > 0) {
      latestCacheHitPct = +((cacheTok / promptTok) * 100).toFixed(1);
    }
    latestPromptTokens = promptTok;
    if (step.isCompactionStep) {
      if (Number(step.estimatedContextTokens || 0) > 0) {
        latestContextTokens = Number(step.estimatedContextTokens);
      }
    } else if (promptTok > 0) {
      latestContextTokens = promptTok + outTok;
    } else if (Number(step.estimatedContextTokens || 0) > 0) {
      latestContextTokens = Number(step.estimatedContextTokens);
    }
    if (Number(step.reportedContextLimitTokens || 0) > 0) {
      latestLimitTokens = Number(step.reportedContextLimitTokens);
      hasReportedLimit = true;
    } else if (!step.isCompactionStep && !hasReportedLimit && Number(step.maxContextBudgetTokens || 0) > 0) {
      latestLimitTokens = Number(step.maxContextBudgetTokens);
    }

    if (!step.isCompactionStep) {
      const sm = speedMetric(step);
      if (sm.value !== null && Number.isFinite(sm.value)) {
        latestTps = +sm.value.toFixed(1);
      }
      if (step.ttftSec !== null && Number.isFinite(step.ttftSec) && step.ttftSec >= 0) {
        latestTtft = step.ttftSec;
      }
    }
  }

  const lastStep = steps[steps.length - 1];
  if (lastStep?.anomaly && Number(lastStep.anomaly.count) > 0) {
    latestAnomaly = {
      primaryKind: String(lastStep.anomaly.primaryKind || 'error'),
      count: Number(lastStep.anomaly.count),
      severity: lastStep.anomaly.severity === 'danger' ? 'danger' : 'warn',
      totalDelaySec: Number(lastStep.anomaly.totalDelaySec || 0),
    };
  }

  const speedSum = summarizeSpeed(steps);
  const ttftSum = summarizeTtft(steps);
  const totalPromptAll = totalInputTokens + totalCacheReadTokens;
  const sessionCacheHitPct =
    totalPromptAll > 0 ? +((totalCacheReadTokens / totalPromptAll) * 100).toFixed(1) : null;

  const resolvedUsedPct =
    latestLimitTokens > 0 && latestContextTokens > 0
      ? Math.min(100, +((latestContextTokens / latestLimitTokens) * 100).toFixed(1))
      : null;
  const computedMetrics = {
    found: true,
    stepCount: steps.length,
    targetIsWaiting,
    waitingApproval,
    tps: latestTps,
    avgTps: speedSum?.avgTokPerSec != null ? +speedSum.avgTokPerSec.toFixed(1) : null,
    ttft: latestTtft ?? ttftSum?.avgSec ?? null,
    stepCost: latestStepCostUsd,
    sessionCost: hasPricedStep ? sessionCostUsd : null,
    cacheHitPct: latestCacheHitPct ?? sessionCacheHitPct,
    latestPromptTokens,
    sessionTokens: totalInputTokens + totalCacheReadTokens + totalOutputTokens,
    latestAnomaly,
    sessionAnomalyCount,
    latestModelHint,
    hasReportedLimit,
    usedPct: resolvedUsedPct,
  };
  if (targetMemoKey) {
    saveJson(cliTrajMemoFile, {
      targetKey: targetMemoKey,
      metrics: computedMetrics,
      otherWaiting: { ...prevOtherCache, ...nextOtherCache },
    });
  }

  return {
    found: true,
    cascadeId: targetCid,
    dbMtimeMs,
    stepCount: computedMetrics.stepCount,
    runningRootCount,
    runningSubCount,
    targetIsRunning,
    targetIsWaiting,
    targetWaitingApprovalFresh,
    otherLocalWaiting,
    tps: computedMetrics.tps,
    avgTps: computedMetrics.avgTps,
    ttft: computedMetrics.ttft,
    stepCost: computedMetrics.stepCost,
    sessionCost: computedMetrics.sessionCost,
    cacheHitPct: computedMetrics.cacheHitPct,
    latestPromptTokens: computedMetrics.latestPromptTokens,
    sessionTokens: computedMetrics.sessionTokens,
    latestAnomaly: computedMetrics.latestAnomaly,
    sessionAnomalyCount: computedMetrics.sessionAnomalyCount,
    latestModelHint: computedMetrics.latestModelHint,
    hasReportedLimit: computedMetrics.hasReportedLimit,
    usedPct: computedMetrics.usedPct,
  };
}

function buildStdinFallbackQuotas(stdinData) {
  const rawQuota = stdinData?.quota;
  if (!rawQuota || typeof rawQuota !== 'object' || Array.isArray(rawQuota)) {
    return null;
  }
  const pools = [];
  for (const [key, bucket] of Object.entries(rawQuota)) {
    if (!bucket || typeof bucket !== 'object' || bucket.disabled) continue;
    const frac = Number(bucket.remaining_fraction);
    if (!Number.isFinite(frac)) continue;
    const remainingPct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    const isThirdParty = isThirdPartyPoolText(key);
    pools.push({
      poolKey: isThirdParty ? 'Claude & GPT' : 'Gemini',
      poolLabel: key,
      family: isThirdParty ? 'claude' : 'gemini',
      remainingPct,
    });
  }
  if (pools.length === 0) return null;
  const modelStr = String(stdinData?.model?.id || stdinData?.model?.display_name || '');
  const activeIsThirdParty = isThirdPartyPoolText(modelStr);
  const matchingPools = pools.filter((p) =>
    activeIsThirdParty ? p.poolKey === 'Claude & GPT' : p.poolKey === 'Gemini'
  );
  const activePool = (matchingPools.length > 0 ? matchingPools : pools).reduce((minP, cur) =>
    cur.remainingPct < minP.remainingPct ? cur : minP
  );
  return {
    activePool,
    pools,
  };
}

function selectCliActiveQuotaPool(quotas, modelHint = '') {
  if (!quotas || typeof quotas !== 'object') return quotas || null;
  const pools = Array.isArray(quotas.pools) ? quotas.pools : [];
  const hint = String(modelHint || '').trim();
  if (!hint || pools.length <= 1) return quotas;

  const hintLower = hint.toLowerCase();
  const baseHint = hintLower.replace(/\s*\([^)]*\)\s*$/, '').trim();

  // 1. 优先按配额池内置模型清单精确/前缀匹配
  const exactPool = pools.find((p) => {
    const models = Array.isArray(p?.models) ? p.models : [];
    return models.some((m) => {
      const ml = String(m || '').trim().toLowerCase();
      return ml === hintLower || (baseHint && ml.startsWith(baseHint));
    });
  });
  if (exactPool) {
    return { ...quotas, activePool: exactPool };
  }

  // 2. 按模型家族匹配（Claude & GPT / Carbon / Argon / Gemini）
  const wantThirdParty = isThirdPartyPoolText(hint);
  const familyMatched = pools.filter((p) => {
    const pk = String(p?.poolKey || p?.poolLabel || p?.family || '').toLowerCase();
    if (wantThirdParty) return isThirdPartyPoolText(pk);
    if (/\bcarbon\b/i.test(hint) && pk.includes('carbon')) return true;
    if (/\bargon\b/i.test(hint) && pk.includes('argon')) return true;
    return !isThirdPartyPoolText(pk) && (pk.includes('gemini') || pk === 'default');
  });
  if (familyMatched.length > 0) {
    const activePool = familyMatched.reduce((minP, cur) =>
      Number(cur?.remainingPct ?? 100) < Number(minP?.remainingPct ?? 100) ? cur : minP
    );
    return { ...quotas, activePool };
  }
  return quotas;
}

/**
 * 解析通过 `/statusline` 传入 `cli-statusline.mjs` 的命令行参数。
 *
 * @param {string[]} [argv]
 */
export function parseCliStatusLineArgs(argv = []) {
  const out = {
    install: false,
    uninstall: false,
    help: false,
    resetFlags: false,
    slotsRaw: null,
    preset: '',
    showMultiSession: null,
    showAnomaly: null,
    language: '',
    noColor: false,
    style: '',
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = String(argv[i] || '').trim();
    if (!raw || raw === '--') continue;
    const eqIdx = raw.indexOf('=');
    const flag = eqIdx > 0 ? raw.slice(0, eqIdx) : raw;
    const readVal = () => {
      if (eqIdx > 0) return raw.slice(eqIdx + 1).trim();
      if (i + 1 < argv.length && !String(argv[i + 1]).startsWith('-')) {
        i += 1;
        return String(argv[i] || '').trim();
      }
      return '';
    };
    if (flag === '--install') out.install = true;
    else if (flag === '--uninstall') out.uninstall = true;
    else if (flag === '--help' || flag === '-h') out.help = true;
    else if (flag === '--reset-flags') out.resetFlags = true;
    else if (flag === '--slots') out.slotsRaw = readVal();
    else if (flag === '--preset') out.preset = readVal().toLowerCase();
    else if (flag === '--style') out.style = normalizeCliStatusLineGaugeStyle(readVal());
    else if (flag === '--json') out.json = true;
    else if (flag === '--multi' || flag === '--show-multi') out.showMultiSession = true;
    else if (flag === '--no-multi' || flag === '--hide-multi') out.showMultiSession = false;
    else if (flag === '--anomaly' || flag === '--show-anomaly') out.showAnomaly = true;
    else if (flag === '--no-anomaly' || flag === '--hide-anomaly') out.showAnomaly = false;
    else if (flag === '--lang') out.language = readVal();
    else if (flag === '--no-color') out.noColor = true;
  }
  return out;
}

export function buildPersistableStatusLineFlags(parsed) {
  const parts = [];
  if (parsed.slotsRaw && parsed.slotsRaw.toLowerCase() !== 'auto') {
    const norm = normalizeCliStatusLineSlots(parsed.slotsRaw);
    if (norm && norm.length > 0) parts.push(`--slots ${norm.join(',')}`);
  } else if (
    parsed.preset &&
    Object.prototype.hasOwnProperty.call(CLI_STATUSLINE_PRESETS, parsed.preset)
  ) {
    parts.push(`--preset ${parsed.preset}`);
  }
  if (parsed.style) parts.push(`--style ${normalizeCliStatusLineGaugeStyle(parsed.style)}`);
  if (parsed.showMultiSession === false) parts.push('--no-multi');
  else if (parsed.showMultiSession === true) parts.push('--multi');
  if (parsed.showAnomaly === false) parts.push('--no-anomaly');
  else if (parsed.showAnomaly === true) parts.push('--anomaly');
  if (parsed.language) parts.push(`--lang ${parsed.language}`);
  if (parsed.noColor) parts.push('--no-color');
  return parts.join(' ');
}

function formatCliStatusLineHelp() {
  return [
    'Antigravity Usage Monitor - CLI statusLine options:',
    '  --slots <list|auto>         Custom 1-6 slots (e.g. tps,ttft,session_cost,quota_auto,context)',
    '  --preset compact|balanced|full',
    '                              Built-in slot presets (3 / 5 / 6 slots)',
    '  --style pill|bar|compact    Gauge style (24-bit pill / transparent bar / plain text)',
    '  --json                      Output single-line structured JSON snapshot for scripts/prompts',
    '  --multi / --no-multi        Show or hide running sessions indicator',
    '  --anomaly / --no-anomaly    Show or hide latest-step anomaly badge (! 503 / ! 429)',
    '  --lang zh-CN|en-US|auto     Override display language',
    '  --no-color                  Disable ANSI colors',
    '  --install [flags...]        Install into ~/.gemini/antigravity-cli/settings.json',
    '  --uninstall                 Remove managed statusLine from CLI settings',
    `Available slot keys: ${TOPBAR_SLOT_KEYS.join(', ')}`,
  ].join('\n');
}

/**
 * 融合 `stdin` (`StatusLineData`)、本地 CLI SQLite 步骤指标及后台守护配额快照，生成胶囊上下文。
 */
export function buildMergedCliCapsuleContext({
  stdinData = null,
  localMetrics = null,
  snapshot = null,
  nowMs = Date.now(),
} = {}) {
  const agentState = String(stdinData?.agent_state || '').trim().toLowerCase();
  const stdinIsWaiting =
    agentState.includes('wait') ||
    agentState.includes('approv') ||
    agentState.includes('confirm') ||
    agentState.includes('permission') ||
    agentState.includes('consent') ||
    agentState.includes('review') ||
    agentState === 'ask' ||
    agentState === 'pending_user' ||
    Boolean(
      stdinData?.waiting_for_approval ||
        stdinData?.awaiting_approval ||
        stdinData?.has_pending_approval
    );
  const stdinIsRunning =
    !stdinIsWaiting &&
    (agentState === 'running' ||
      agentState === 'streaming' ||
      agentState === 'executing' ||
      agentState === 'thinking' ||
      agentState === 'working' ||
      agentState === 'tool_use' ||
      agentState === 'tool_executing' ||
      agentState === 'generating');

  const stdinSubagents = Array.isArray(stdinData?.subagents)
    ? stdinData.subagents.filter((s) => {
        const st = String(s?.state || s?.status || '').toUpperCase();
        return !st.includes('KILLED') && !st.includes('DONE') && !st.includes('COMPLETED');
      }).length
    : 0;

  const snapAgeMs =
    snapshot && Number.isFinite(Number(snapshot.updatedAtMs))
      ? Math.max(0, nowMs - Number(snapshot.updatedAtMs))
      : Infinity;
  const snapLiveFresh = snapAgeMs <= SNAPSHOT_LIVE_RUNNING_TTL_MS;
  const snapQuotaFresh = snapAgeMs <= SNAPSHOT_QUOTA_TTL_MS;

  const baseRunning = snapLiveFresh
    ? Math.max(0, Number(snapshot?.runningCount || 0))
    : Math.max(0, Number(localMetrics?.runningRootCount || 0));
  const localActiveRunning =
    stdinIsRunning ||
    stdinIsWaiting ||
    Boolean(localMetrics?.targetIsRunning) ||
    Boolean(localMetrics?.targetWaitingApprovalFresh);
  const runningCount = localActiveRunning ? Math.max(1, baseRunning) : baseRunning;

  const baseSubRunning = snapLiveFresh
    ? Math.max(0, Number(snapshot?.runningSubCount || 0))
    : Math.max(0, Number(localMetrics?.runningSubCount || 0));
  const runningSubCount = Math.max(stdinSubagents, baseSubRunning);

  const localTargetWaiting = Boolean(
    localMetrics?.targetWaitingApprovalFresh ||
      (localMetrics?.targetIsWaiting && localActiveRunning)
  );
  const localOtherWaiting = Boolean(localMetrics?.otherLocalWaiting);
  const localCidLower = String(localMetrics?.cascadeId || '').toLowerCase();
  const localDbNewerThanSnap =
    Number(localMetrics?.dbMtimeMs || 0) > Number(snapshot?.updatedAtMs || 0);
  let snapHasWaiting = false;
  if (snapLiveFresh) {
    if (
      Array.isArray(snapshot?.waitingCascadeIds) &&
      localCidLower &&
      localMetrics?.found &&
      localDbNewerThanSnap
    ) {
      // 本地 SQLite WAL 更新晚于桌面端快照时，当前 CLI 会话以本地 WAL 为准（恢复运行秒变绿），同时保留桌面端其他会话的等待态
      snapHasWaiting = snapshot.waitingCascadeIds.some(
        (id) => String(id || '').toLowerCase() && String(id || '').toLowerCase() !== localCidLower
      );
    } else {
      snapHasWaiting = Boolean(snapshot?.hasWaiting);
    }
  }
  const hasWaiting = stdinIsWaiting || localTargetWaiting || localOtherWaiting || snapHasWaiting;

  const stdinUsedPct = stdinData?.context_window?.used_percentage;
  // 优先采用本地轨迹里语言服务器官方上报的有效压缩上限（如 512k 压缩线），
  // 避免 agy stdin 按模型物理上限（如 1M）算出的占比和桌面端监控面板脱节
  const usedPct =
    localMetrics?.hasReportedLimit && localMetrics?.usedPct != null
      ? localMetrics.usedPct
      : stdinUsedPct != null && Number.isFinite(Number(stdinUsedPct))
        ? Math.max(0, Math.min(100, Number(stdinUsedPct)))
        : localMetrics?.usedPct ?? (snapLiveFresh ? snapshot?.activeConversation?.usedPct ?? null : null);

  const stdinTotalUsd = stdinData?.cost?.total_usd;
  const sessionCost =
    localMetrics?.sessionCost != null
      ? localMetrics.sessionCost
      : stdinTotalUsd != null && Number.isFinite(Number(stdinTotalUsd))
        ? Number(stdinTotalUsd)
        : null;

  const stdinInTok = Number(stdinData?.context_window?.total_input_tokens);
  const stdinOutTok = Number(stdinData?.context_window?.total_output_tokens);
  const stdinSessionTokens =
    Number.isFinite(stdinInTok) || Number.isFinite(stdinOutTok)
      ? Math.max(0, (Number.isFinite(stdinInTok) ? stdinInTok : 0) + (Number.isFinite(stdinOutTok) ? stdinOutTok : 0))
      : null;

  const snapActive =
    snapLiveFresh &&
    snapshot?.activeConversation &&
    (!localMetrics?.cascadeId || snapshot.activeConversation.cascadeId === localMetrics.cascadeId)
      ? snapshot.activeConversation
      : null;

  const activeModelHint = String(
    stdinData?.model?.display_name || stdinData?.model?.id || localMetrics?.latestModelHint || ''
  ).trim();
  const rawQuotas =
    (snapQuotaFresh && snapshot?.quotas) || buildStdinFallbackQuotas(stdinData) || null;
  const mergedQuotas = selectCliActiveQuotaPool(rawQuotas, activeModelHint);

  const hasTelemetry = Boolean(
    stdinData || localMetrics?.found || snapActive || mergedQuotas
  );
  const resolvedStepCount = localMetrics?.found
    ? Number(localMetrics.stepCount || 0)
    : snapActive?.stepCount != null
      ? Number(snapActive.stepCount)
      : stdinData
        ? 0
        : undefined;

  return {
    hasTelemetry,
    stepCount: resolvedStepCount,
    isRunning: stdinIsRunning || stdinIsWaiting,
    hasWaiting,
    runningCount,
    runningSubCount,
    usedPct,
    tps: localMetrics?.tps ?? snapActive?.latestTokPerSec ?? null,
    avgTps: localMetrics?.avgTps ?? snapActive?.avgTokPerSec ?? null,
    ttft: localMetrics?.ttft ?? snapActive?.latestTtftSec ?? null,
    stepCost: localMetrics?.stepCost ?? snapActive?.latestStepCostUsd ?? null,
    sessionCost: sessionCost ?? snapActive?.sessionCostUsd ?? null,
    cacheHitPct: localMetrics?.cacheHitPct ?? snapActive?.latestCacheHitPct ?? null,
    latestPromptTokens: localMetrics?.latestPromptTokens ?? snapActive?.latestPromptTokens ?? null,
    sessionTokens:
      localMetrics?.sessionTokens ?? stdinSessionTokens ?? snapActive?.totalTokens ?? null,
    latestAnomaly: localMetrics?.latestAnomaly ?? snapActive?.latestAnomaly ?? null,
    sessionAnomalyCount:
      localMetrics?.sessionAnomalyCount ?? snapActive?.sessionAnomalyCount ?? 0,
    quotas: mergedQuotas,
  };
}

export async function runCliStatusLineMain(argv = process.argv.slice(2)) {
  const cliArgs = parseCliStatusLineArgs(argv);
  if (cliArgs.help) {
    process.stdout.write(`${formatCliStatusLineHelp()}\n`);
    return;
  }
  if (cliArgs.install) {
    const extraFlags = buildPersistableStatusLineFlags(cliArgs);
    const res = ensureCliStatusLineConfigured({
      enabled: true,
      extraFlags,
      preserveManagedFlags: !cliArgs.resetFlags && !extraFlags && cliArgs.slotsRaw !== 'auto',
    });
    process.stdout.write(`${JSON.stringify(res)}\n`);
    return;
  }
  if (cliArgs.uninstall) {
    const res = ensureCliStatusLineConfigured({ enabled: false });
    process.stdout.write(`${JSON.stringify(res)}\n`);
    return;
  }

  const settings = loadSettings();
  if (settings?.enableCliStatusLine === false) {
    return;
  }

  const stdinData = await readStdinJsonWithTimeout(220);
  const nowMs = Date.now();
  const geminiBase =
    String(process.env.ANTIGRAVITY_GEMINI_DIR || '').trim() || join(homedir(), '.gemini');
  const cliRoot = join(geminiBase, 'antigravity-cli');

  const localMetrics = resolveCliLocalSessionMetrics({
    cliRoot,
    stdinData,
    nowMs,
  });
  const snapshot = loadFreshestCliStatusSnapshot(geminiBase);
  const slotCtx = buildMergedCliCapsuleContext({
    stdinData,
    localMetrics,
    snapshot,
    nowMs,
  });

  const terminalWidth = Number(stdinData?.terminal_width);
  let modelDisplayName = String(
    stdinData?.model?.display_name || stdinData?.model?.id || ''
  ).trim();
  if (!modelDisplayName && terminalWidth > 0) {
    const cliSettingsObj = loadJson(join(cliRoot, 'settings.json'), null);
    if (cliSettingsObj && typeof cliSettingsObj.model === 'string') {
      modelDisplayName = cliSettingsObj.model.trim();
    }
  }

  const useColor =
    !cliArgs.noColor &&
    (!Object.prototype.hasOwnProperty.call(process.env, 'NO_COLOR') ||
      String(process.env.NO_COLOR || '') === '');

  let effectiveSlots = null;
  if (cliArgs.slotsRaw !== null) {
    effectiveSlots =
      cliArgs.slotsRaw.toLowerCase() === 'auto'
        ? resolveEffectiveCliStatusLineSlots(settings)
        : normalizeCliStatusLineSlots(cliArgs.slotsRaw) ||
          resolveEffectiveCliStatusLineSlots(settings);
  } else if (
    cliArgs.preset &&
    Object.prototype.hasOwnProperty.call(CLI_STATUSLINE_PRESETS, cliArgs.preset)
  ) {
    effectiveSlots = [...CLI_STATUSLINE_PRESETS[cliArgs.preset]];
  } else {
    effectiveSlots = resolveEffectiveCliStatusLineSlots(settings);
  }

  if (cliArgs.json) {
    const jsonPayload = buildCliJsonStatusOutput(slotCtx, {
      modelDisplayName,
      modelEffort: typeof stdinData?.model?.effort === 'string' ? stdinData.model.effort : '',
      cycleMode: typeof stdinData?.cycle_mode === 'string' ? stdinData.cycle_mode : '',
      nowMs,
    });
    process.stdout.write(`${JSON.stringify(jsonPayload)}\n`);
    return;
  }

  const multiSessionMode =
    cliArgs.showMultiSession !== null
      ? cliArgs.showMultiSession
        ? 'show'
        : 'hide'
      : normalizeTopbarMultiSessionMode(
          settings?.topbarMultiSessionMode,
          settings?.showTopbarMultiSession
        );
  const line = formatCliStatusLineCapsule(slotCtx, {
    slots: effectiveSlots,
    gaugeStyle: cliArgs.style || undefined,
    multiSessionMode,
    showMultiSession: multiSessionMode !== 'hide',
    showAnomaly: cliArgs.showAnomaly !== null ? cliArgs.showAnomaly : true,
    language: cliArgs.language || settings?.language,
    color: useColor,
    terminalWidth: Number.isFinite(terminalWidth) && terminalWidth > 0 ? terminalWidth : 0,
    cycleMode: typeof stdinData?.cycle_mode === 'string' ? stdinData.cycle_mode : '',
    modelDisplayName,
    modelEffort: typeof stdinData?.model?.effort === 'string' ? stdinData.model.effort : '',
    vimMode: typeof stdinData?.vim?.mode === 'string' ? stdinData.vim.mode : '',
  });

  if (line) {
    process.stdout.write(`${line}\n`);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const isDirectEntry =
  (invokedPath && invokedPath === fileURLToPath(import.meta.url)) ||
  import.meta.url.endsWith('#autorun');
if (isDirectEntry) {
  runCliStatusLineMain().catch(() => {
    // 严格保证静默退出 0，绝不触发 CLI 连续 30 次失败熔断器
    process.exitCode = 0;
  });
}
