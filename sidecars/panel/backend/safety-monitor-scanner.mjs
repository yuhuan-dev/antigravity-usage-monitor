/**
 * @fileoverview 只读、增量、低内存的 Antigravity 后台安全审查日志采集器（`safety-monitor-scanner.mjs`）。
 *
 * 针对 Antigravity 宿主后台静默运行、但不写入对话数据库/transcript 的安全审查调用
 * （`sir_flash_lite` / `MODEL_TIER_FLASH_LITE` 预检及升级后的 `severe_internal_risks_agy` / `gemini-4-hydrogen-sonar`）：
 * 1. 跨平台自动发现 Desktop `language_server.log` 与 CLI `log/cli-*.log`（避免与顶层 `cli.log` 双倍计数）；
 * 2. 使用 `openSync` + `fstatSync` 绕开 Windows NTFS 目录项 `Length=0` 缓存，以 `256 KB` 分块按字节偏移增量读取；
 * 3. 在行首做高速子串预过滤（跳过 ~97% 噪音行），按内嵌 glog 行头切分 Windows CLI 并发交错行，不硬编码 Go 源码行号；
 * 4. 维护 `activeByTid` 状态机关联同 goroutine 的 `Calling LLM` -> `streamGenerateContent` -> `Evaluation complete`；
 * 5. 将 1 分钟粒度滚动聚合桶与近期重型审查事件持久化到 `DATA_DIR/safety_monitor_state.json`，桌面端重启截断日志时不丢历史。
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  SAFETY_MONITOR_STATE_FILE,
  loadJson,
  lsRuntimeEndpoint,
  saveJson,
} from './config.mjs';

export const SM_STATE_SCHEMA_VERSION = 1;
export const SM_SCAN_MIN_INTERVAL_MS = 4000;
export const SM_PERSIST_MIN_INTERVAL_MS = 10_000;
export const SM_READ_CHUNK_BYTES = 256 * 1024;
export const SM_MAX_INITIAL_TAIL_BYTES = 32 * 1024 * 1024;
export const SM_MAX_BYTES_PER_SCAN = 16 * 1024 * 1024;
export const SM_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const SM_FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
export const SM_DAY_MS = 24 * 60 * 60 * 1000;
export const SM_MAX_RECENT_HEAVY_EVENTS = 512;
export const SM_MAX_ACTIVE_TIDS = 256;
export const SM_ACTIVE_TID_TTL_MS = 5 * 60 * 1000;
export const SM_MAX_CLI_LOG_FILES = 16;
export const SM_FLASH_LITE_5H_WARN_THRESHOLD = 3600;
export const SM_HEAVY_BURST_15M_COUNT = 5;
export const SM_HEAVY_LARGE_TRAJ_CHARS = 150_000;

const SM_CONJOINED_SPLIT_RE =
  /(?=(?:ERROR:\s+logging before google\.Init:\s+)?[IWEF]\d{4}\s+\d{2}:\d{2}:\d{2}\.\d{3,6}\s+\d+\s+[A-Za-z0-9_.-]+:\d+\])/;
const SM_GLOG_HEADER_RE =
  /^(?:ERROR:\s+logging before google\.Init:\s+)?([IWEF])(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3,6})\s+(\d+)\s+([A-Za-z0-9_.-]+):\d+\]\s*(.*)$/;
const SM_TRAJ_LEN_RE = /^LLM Monitor ([^:]+):\s*Trajectory formatted,\s*length:\s*(\d+)/;
const SM_START_EVAL_RE = /^LLM Monitor ([^:]+):\s*Starting evaluation\b/;
const SM_CALLING_LLM_RE = /^LLM Monitor ([^:]+):\s*Calling LLM\s*\(model:\s*([^)]+)\)/;
const SM_EVAL_COMPLETE_RE =
  /^LLM Monitor ([^:]+):\s*Evaluation complete\.\s*Triggered:\s*(true|false)\b/i;
const SM_RUNNER_FALLBACK_RE =
  /^Monitor ([^:]+):\s*parent\s+sir_flash_lite\s+failed,\s*running it anyway\b/i;
const SM_RUNNER_FINISHED_RE =
  /^Monitor ([^\s:]+)\s+FINISHED:\s*triggered=(true|false)\b.*?\bduration=([0-9.]+)(ns|µs|us|ms|s)\b/i;
const SM_STRICT_429_RE =
  /RESOURCE_EXHAUSTED|(?:http(?:\/\d(?:\.\d)?)?\s+status|status(?:_?code)?|http\s+error|error\s+code|code|got\s+status|returned)\s*[:=]?\s*429\b|\bhttp\s*429\b|\b429\s+too\s+many\s+requests\b/i;

function smNormalizePathKey(filePath, platform = process.platform) {
  const clean = String(filePath || '').trim();
  if (!clean) return '';
  if (platform === 'win32') {
    return clean.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  }
  return clean.replace(/\/+$/, '') || '/';
}

function smIsHeavyMonitor(name, model = '') {
  const n = String(name || '').toLowerCase();
  const m = String(model || '').toLowerCase();
  return n.includes('severe_internal_risks') || m.includes('sonar');
}

function smIsFlashLiteMonitor(name, model = '') {
  const n = String(name || '').toLowerCase();
  const m = String(model || '').toLowerCase();
  return n.includes('sir_flash_lite') || m.includes('flash_lite');
}

function smFastLineMayMatch(line) {
  if (!line || line.length < 24) return false;
  return (
    line.includes('LLM Monitor ') ||
    line.includes('streamGenerateContent') ||
    line.includes('Monitor ') ||
    line.includes('RESOURCE_EXHAUSTED') ||
    line.includes('parent sir_flash_lite') ||
    line.includes('running it anyway') ||
    line.includes('429')
  );
}

export function smIsStrictRateLimit429Line(sourceFile, msg) {
  const src = String(sourceFile || '').toLowerCase();
  if (src.includes('csrf_interceptor.go')) return false;
  let candidate = String(msg || '');
  if (!candidate) return false;
  if (src.includes('runner.go') && candidate.includes('reason=')) {
    candidate = candidate.replace(/reason="(?:\\.|[^"\\])*"/g, 'reason=""');
  }
  if (!candidate.includes('429') && !candidate.includes('RESOURCE_EXHAUSTED')) {
    return false;
  }
  return SM_STRICT_429_RE.test(candidate);
}

function smParseDurationMs(rawVal, unit) {
  const num = Number(rawVal);
  if (!Number.isFinite(num) || num < 0) return 0;
  const u = String(unit || '').toLowerCase();
  if (u === 's') return Math.round(num * 1000);
  if (u === 'ms') return Math.round(num);
  if (u === 'us' || u === 'µs') return Math.round(num / 1000);
  if (u === 'ns') return Math.round(num / 1_000_000);
  return 0;
}

export function smParseGlogTimestampMs(monthStr, dayStr, hourStr, minStr, secStr, fracStr, refMs) {
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const min = Number(minStr);
  const sec = Number(secStr);
  if (
    !Number.isFinite(month) ||
    month < 1 ||
    month > 12 ||
    !Number.isFinite(day) ||
    day < 1 ||
    day > 31
  ) {
    return 0;
  }
  const fracPadded = String(fracStr || '0').padEnd(3, '0').slice(0, 3);
  const ms = Number(fracPadded) || 0;
  const safeRef = Number.isFinite(refMs) && refMs > 0 ? refMs : Date.now();
  const refDate = new Date(safeRef);
  let year = refDate.getFullYear();
  let ts = new Date(year, month - 1, day, hour, min, sec, ms).getTime();
  if (!Number.isFinite(ts)) return 0;
  // 处理跨年日志边界（12 月旧日志在 1 月被读取，或反之）
  if (ts > safeRef + 2 * SM_DAY_MS) {
    ts = new Date(year - 1, month - 1, day, hour, min, sec, ms).getTime();
  } else if (ts < safeRef - 300 * SM_DAY_MS) {
    ts = new Date(year + 1, month - 1, day, hour, min, sec, ms).getTime();
  }
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * 跨平台自动发现只读安全审查日志文件（Desktop `language_server.log` 与 CLI `log/cli-*.log`）。
 */
export function discoverSafetyMonitorLogSources({
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  nowMs = Date.now(),
  existsSyncFn = existsSync,
  readdirSyncFn = readdirSync,
  statSyncFn = statSync,
} = {}) {
  const candidates = [];
  const seen = new Set();
  const pushSource = (filePath, kind) => {
    const clean = String(filePath || '').trim();
    if (!clean) return;
    const key = smNormalizePathKey(clean, platform);
    if (!key || seen.has(key)) return;
    try {
      if (!existsSyncFn(clean)) return;
    } catch {
      return;
    }
    seen.add(key);
    candidates.push({ path: clean, key, kind });
  };

  if (platform === 'win32') {
    const appData = String(env?.APPDATA || '').trim() || join(homeDir, 'AppData', 'Roaming');
    pushSource(join(appData, 'Antigravity', 'logs', 'language_server.log'), 'desktop');
  } else if (platform === 'darwin') {
    pushSource(
      join(homeDir, 'Library', 'Application Support', 'Antigravity', 'logs', 'language_server.log'),
      'desktop'
    );
  } else {
    const xdgConfig = String(env?.XDG_CONFIG_HOME || '').trim() || join(homeDir, '.config');
    pushSource(join(xdgConfig, 'Antigravity', 'logs', 'language_server.log'), 'desktop');
  }

  const geminiBase = String(env?.ANTIGRAVITY_GEMINI_DIR || '').trim() || join(homeDir, '.gemini');
  const cliBaseDir = join(geminiBase, 'antigravity-cli');
  const cliLogDir = join(cliBaseDir, 'log');
  let foundRotatedCliLogs = false;
  try {
    if (existsSyncFn(cliLogDir)) {
      const entries = readdirSyncFn(cliLogDir);
      const cliFiles = [];
      const cutoffMs = nowMs - SM_RETENTION_MS;
      for (const rawName of entries) {
        const name = typeof rawName === 'string' ? rawName : String(rawName?.name || '');
        if (!/^cli-.*\.log$/i.test(name)) continue;
        const full = join(cliLogDir, name);
        let mtimeMs = 0;
        try {
          mtimeMs = Number(statSyncFn(full)?.mtimeMs) || 0;
        } catch {
          mtimeMs = 0;
        }
        if (mtimeMs > 0 && mtimeMs < cutoffMs) continue;
        cliFiles.push({ full, mtimeMs });
      }
      if (cliFiles.length > 0) {
        foundRotatedCliLogs = true;
        cliFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
        for (const item of cliFiles.slice(0, SM_MAX_CLI_LOG_FILES)) {
          pushSource(item.full, 'cli');
        }
      }
    }
  } catch {
    // 忽略无权限或不存在的 CLI 日志目录
  }

  // 当 `log/cli-*.log` 存在时跳过顶层 `cli.log`，避免与最新一份轮转日志双倍计数
  if (!foundRotatedCliLogs) {
    pushSource(join(cliBaseDir, 'cli.log'), 'cli');
  }

  return candidates;
}

function smCreateEmptyMinuteBucket() {
  return {
    s: 0, // total streamGenerateContent
    h: 0, // hidden monitor streamGenerateContent (same tid)
    fl: 0, // sir_flash_lite calls
    flTrig: 0, // sir_flash_lite triggered=true
    sn: 0, // severe_internal_risks_agy / sonar calls
    snTrig: 0, // sonar triggered=true
    ch: 0, // heavy monitor trajectory formatted chars
    flCh: 0, // flash_lite trajectory formatted chars
    blMs: 0, // total monitor evaluation blocked duration (ms)
    r429: 0, // strict HTTP 429 / RESOURCE_EXHAUSTED count
    fb: 0, // parent sir_flash_lite failed, running it anyway fallback count
  };
}

function smSanitizeMinuteBucket(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {
    s: Math.max(0, Math.floor(Number(raw.s) || 0)),
    h: Math.max(0, Math.floor(Number(raw.h) || 0)),
    fl: Math.max(0, Math.floor(Number(raw.fl) || 0)),
    flTrig: Math.max(0, Math.floor(Number(raw.flTrig) || 0)),
    sn: Math.max(0, Math.floor(Number(raw.sn) || 0)),
    snTrig: Math.max(0, Math.floor(Number(raw.snTrig) || 0)),
    ch: Math.max(0, Math.floor(Number(raw.ch) || 0)),
    flCh: Math.max(0, Math.floor(Number(raw.flCh) || 0)),
    blMs: Math.max(0, Math.floor(Number(raw.blMs) || 0)),
    r429: Math.max(0, Math.floor(Number(raw.r429) || 0)),
    fb: Math.max(0, Math.floor(Number(raw.fb) || 0)),
  };
  const anyPositive =
    out.s > 0 ||
    out.h > 0 ||
    out.fl > 0 ||
    out.sn > 0 ||
    out.ch > 0 ||
    out.blMs > 0 ||
    out.r429 > 0 ||
    out.fb > 0;
  return anyPositive ? out : null;
}

function smSanitizeHeavyEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tsMs = Math.floor(Number(raw.tsMs) || 0);
  if (tsMs <= 0) return null;
  return {
    tsMs,
    startedAtMs: Math.max(0, Math.floor(Number(raw.startedAtMs) || tsMs)),
    name: String(raw.name || 'severe_internal_risks_agy').slice(0, 64),
    model: String(raw.model || 'gemini-4-hydrogen-sonar').slice(0, 64),
    trajChars: Math.max(0, Math.floor(Number(raw.trajChars) || 0)),
    triggered: raw.triggered === true,
    durationMs: Math.max(0, Math.min(120_000, Math.floor(Number(raw.durationMs) || 0))),
  };
}

/**
 * 汇总 `[sinceMs, untilMs]` 区间内的后台安全审查统计（供 5h/24h/7d 视图及配额周期对账复用）。
 */
export function summarizeSafetyMonitorWindow(minuteBuckets, recentHeavyEvents, sinceMs, untilMs) {
  const safeSince = Math.max(0, Number(sinceMs) || 0);
  const safeUntil = Math.max(safeSince, Number(untilMs) || Date.now());
  const startMin = Math.floor(safeSince / 60_000);
  const endMin = Math.floor(safeUntil / 60_000);

  let totalStreamGen = 0;
  let hiddenStreamGen = 0;
  let flashLiteCalls = 0;
  let flashLiteTriggered = 0;
  let heavyCalls = 0;
  let heavyTriggered = 0;
  let heavyTrajChars = 0;
  let flashLiteTrajChars = 0;
  let blockedMs = 0;
  let rateLimit429Count = 0;
  let fallbackCount = 0;

  if (minuteBuckets && typeof minuteBuckets === 'object') {
    for (const [k, b] of Object.entries(minuteBuckets)) {
      const m = Number(k);
      if (!Number.isFinite(m) || m < startMin || m > endMin || !b) continue;
      totalStreamGen += Number(b.s) || 0;
      hiddenStreamGen += Number(b.h) || 0;
      flashLiteCalls += Number(b.fl) || 0;
      flashLiteTriggered += Number(b.flTrig) || 0;
      heavyCalls += Number(b.sn) || 0;
      heavyTriggered += Number(b.snTrig) || 0;
      heavyTrajChars += Number(b.ch) || 0;
      flashLiteTrajChars += Number(b.flCh) || 0;
      blockedMs += Number(b.blMs) || 0;
      rateLimit429Count += Number(b.r429) || 0;
      fallbackCount += Number(b.fb) || 0;
    }
  }

  // 若精细重型事件数组覆盖区间，用精确毫秒边界校正边缘分钟的重型次数及字符量
  let exactHeavyCalls = 0;
  let exactHeavyTriggered = 0;
  let exactHeavyTrajChars = 0;
  let hasEventsInRange = false;
  if (Array.isArray(recentHeavyEvents) && recentHeavyEvents.length > 0) {
    const oldestEv = recentHeavyEvents[0].tsMs;
    if (oldestEv <= safeSince + 60_000) {
      hasEventsInRange = true;
      for (let i = 0; i < recentHeavyEvents.length; i += 1) {
        const ev = recentHeavyEvents[i];
        if (ev.tsMs < safeSince || ev.tsMs > safeUntil) continue;
        exactHeavyCalls += 1;
        if (ev.triggered) exactHeavyTriggered += 1;
        exactHeavyTrajChars += Number(ev.trajChars) || 0;
      }
    }
  }
  if (hasEventsInRange && exactHeavyCalls >= heavyCalls) {
    heavyCalls = exactHeavyCalls;
    heavyTriggered = exactHeavyTriggered;
    heavyTrajChars = exactHeavyTrajChars;
  }

  const totalMonitorCalls = flashLiteCalls + heavyCalls;
  const effectiveHiddenStream = Math.max(hiddenStreamGen, Math.min(totalStreamGen, totalMonitorCalls));
  const hiddenRatio =
    totalStreamGen > 0 ? +(effectiveHiddenStream / totalStreamGen).toFixed(4) : 0;
  const heavyFalseAlarmRate =
    heavyCalls > 0 ? +((heavyCalls - heavyTriggered) / heavyCalls).toFixed(4) : 0;

  return {
    totalStreamGen,
    hiddenStreamGen: effectiveHiddenStream,
    hiddenRatio,
    flashLiteCalls,
    flashLiteTriggered,
    heavyCalls,
    heavyTriggered,
    heavyFalseAlarmRate,
    heavyTrajChars,
    flashLiteTrajChars,
    blockedMs,
    rateLimit429Count,
    fallbackCount,
    estInputTokensLower: Math.round(heavyTrajChars / 4),
    estInputTokensUpper: Math.round(heavyTrajChars / 3),
  };
}

/**
 * 创建独立的安全审查日志扫描器实例（支持依赖注入与单元测试隔离）。
 */
export function createSafetyMonitorScanner({
  loadState = null,
  saveState = null,
  discoverSources = null,
  fsOps = null,
  scanMinIntervalMs = SM_SCAN_MIN_INTERVAL_MS,
  persistMinIntervalMs = SM_PERSIST_MIN_INTERVAL_MS,
  maxInitialTailBytes = SM_MAX_INITIAL_TAIL_BYTES,
  maxBytesPerScan = SM_MAX_BYTES_PER_SCAN,
} = {}) {
  const openFn = fsOps?.openSync ?? (typeof openSync === 'function' ? openSync : null);
  const fstatFn = fsOps?.fstatSync ?? (typeof fstatSync === 'function' ? fstatSync : null);
  const readFn = fsOps?.readSync ?? (typeof readSync === 'function' ? readSync : null);
  const closeFn = fsOps?.closeSync ?? (typeof closeSync === 'function' ? closeSync : null);
  const discoverFn = discoverSources || discoverSafetyMonitorLogSources;

  let hydrated = typeof loadState !== 'function';
  let lastScanMs = 0;
  let lastDiscoverMs = 0;
  let cachedSources = null;
  let lastPersistMs = 0;
  let cachedSnapshot = null;

  /** @type {Map<string, { offset: number, size: number, mtimeMs: number, partialLine: string, activeByTid: Map<string, object> }>} */
  const fileStates = new Map();
  /** @type {Record<string, ReturnType<typeof smCreateEmptyMinuteBucket>>} */
  let minuteBuckets = Object.create(null);
  /** @type {Array<{ tsMs: number, startedAtMs: number, name: string, model: string, trajChars: number, triggered: boolean, durationMs: number }>} */
  let recentHeavyEvents = [];
  let lastHeavyEventAtMs = 0;
  let lastAnyMonitorAtMs = 0;
  let lastFallbackAtMs = 0;
  let last429AtMs = 0;

  function ensureHydrated(nowMs) {
    if (hydrated) return;
    hydrated = true;
    try {
      const persisted = loadState?.();
      if (!persisted || typeof persisted !== 'object') return;
      if (Number(persisted.version) !== SM_STATE_SCHEMA_VERSION) return;

      if (persisted.files && typeof persisted.files === 'object') {
        for (const [k, rawF] of Object.entries(persisted.files)) {
          if (!k || !rawF || typeof rawF !== 'object') continue;
          const offset = Math.max(0, Math.floor(Number(rawF.offset) || 0));
          const size = Math.max(0, Math.floor(Number(rawF.size) || offset));
          const mtimeMs = Math.max(0, Number(rawF.mtimeMs) || 0);
          fileStates.set(k, {
            offset,
            size,
            mtimeMs,
            partialLine: '',
            activeByTid: new Map(),
          });
        }
      }
      if (persisted.minuteBuckets && typeof persisted.minuteBuckets === 'object') {
        for (const [minKey, rawBucket] of Object.entries(persisted.minuteBuckets)) {
          if (!/^\d+$/.test(minKey)) continue;
          const clean = smSanitizeMinuteBucket(rawBucket);
          if (clean) minuteBuckets[minKey] = clean;
        }
      }
      if (Array.isArray(persisted.recentHeavyEvents)) {
        for (const rawEv of persisted.recentHeavyEvents) {
          const clean = smSanitizeHeavyEvent(rawEv);
          if (clean) recentHeavyEvents.push(clean);
        }
        recentHeavyEvents.sort((a, b) => a.tsMs - b.tsMs);
      }
      lastHeavyEventAtMs = Math.max(0, Number(persisted.lastHeavyEventAtMs) || 0);
      lastAnyMonitorAtMs = Math.max(0, Number(persisted.lastAnyMonitorAtMs) || 0);
      lastFallbackAtMs = Math.max(0, Number(persisted.lastFallbackAtMs) || 0);
      last429AtMs = Math.max(0, Number(persisted.last429AtMs) || 0);
      pruneOldData(nowMs);
    } catch {
      // 忽略损坏的持久化状态，自动重建
    }
  }

  function pruneOldData(nowMs) {
    const minMinuteKey = Math.floor((nowMs - SM_RETENTION_MS) / 60_000);
    for (const k of Object.keys(minuteBuckets)) {
      if (Number(k) < minMinuteKey) {
        delete minuteBuckets[k];
      }
    }
    const minEventMs = nowMs - SM_RETENTION_MS;
    if (recentHeavyEvents.length > 0) {
      let dropIdx = 0;
      while (dropIdx < recentHeavyEvents.length && recentHeavyEvents[dropIdx].tsMs < minEventMs) {
        dropIdx += 1;
      }
      if (dropIdx > 0) recentHeavyEvents.splice(0, dropIdx);
      if (recentHeavyEvents.length > SM_MAX_RECENT_HEAVY_EVENTS) {
        recentHeavyEvents.splice(0, recentHeavyEvents.length - SM_MAX_RECENT_HEAVY_EVENTS);
      }
    }
  }

  function getOrCreateMinuteBucket(tsMs) {
    const key = String(Math.floor(tsMs / 60_000));
    let b = minuteBuckets[key];
    if (!b) {
      b = smCreateEmptyMinuteBucket();
      minuteBuckets[key] = b;
    }
    return b;
  }

  function recordHeavyEvent(ev) {
    const n = recentHeavyEvents.length;
    for (let i = n - 1; i >= Math.max(0, n - 8); i -= 1) {
      const prev = recentHeavyEvents[i];
      if (
        Math.abs(prev.tsMs - ev.tsMs) <= 5 &&
        prev.name === ev.name &&
        prev.trajChars === ev.trajChars
      ) {
        return false;
      }
    }
    recentHeavyEvents.push(ev);
    if (recentHeavyEvents.length > 1 && ev.tsMs < recentHeavyEvents[recentHeavyEvents.length - 2].tsMs) {
      recentHeavyEvents.sort((a, b) => a.tsMs - b.tsMs);
    }
    if (recentHeavyEvents.length > SM_MAX_RECENT_HEAVY_EVENTS) {
      recentHeavyEvents.splice(0, recentHeavyEvents.length - SM_MAX_RECENT_HEAVY_EVENTS);
    }
    if (ev.tsMs > lastHeavyEventAtMs) lastHeavyEventAtMs = ev.tsMs;
    return true;
  }

  function pruneActiveTids(activeByTid, refMs) {
    if (activeByTid.size === 0) return;
    for (const [tid, entry] of activeByTid.entries()) {
      if (refMs - (entry.lastSeenMs || 0) > SM_ACTIVE_TID_TTL_MS) {
        activeByTid.delete(tid);
      }
    }
    while (activeByTid.size > SM_MAX_ACTIVE_TIDS) {
      const oldestKey = activeByTid.keys().next().value;
      if (oldestKey === undefined) break;
      activeByTid.delete(oldestKey);
    }
  }

  function processSingleRecord(record, fileState, refMs, stats) {
    const m = SM_GLOG_HEADER_RE.exec(record);
    if (!m) return;
    const [, , mon, day, hh, mm, ss, frac, tid, sourceFile, msg] = m;
    const tsMs = smParseGlogTimestampMs(mon, day, hh, mm, ss, frac, refMs);
    if (tsMs <= 0) return;

    const srcLower = sourceFile.toLowerCase();
    const bucket = getOrCreateMinuteBucket(tsMs);

    if (smIsStrictRateLimit429Line(srcLower, msg)) {
      bucket.r429 += 1;
      if (tsMs > last429AtMs) last429AtMs = tsMs;
      stats.urgent = true;
      stats.mutated = true;
    }

    if (srcLower.includes('llm_monitor.go')) {
      const mStart = SM_START_EVAL_RE.exec(msg);
      if (mStart) {
        fileState.activeByTid.set(tid, {
          name: mStart[1].trim(),
          model: '',
          trajChars: 0,
          startedAtMs: tsMs,
          calledAtMs: 0,
          lastSeenMs: tsMs,
          countedCall: false,
        });
        return;
      }

      const mTraj = SM_TRAJ_LEN_RE.exec(msg);
      if (mTraj) {
        const name = mTraj[1].trim();
        const trajChars = Math.max(0, Number(mTraj[2]) || 0);
        const cur = fileState.activeByTid.get(tid) || {
          name,
          model: '',
          trajChars: 0,
          startedAtMs: tsMs,
          calledAtMs: 0,
          lastSeenMs: tsMs,
          countedCall: false,
        };
        cur.name = name;
        cur.trajChars = trajChars;
        cur.lastSeenMs = tsMs;
        fileState.activeByTid.set(tid, cur);
        return;
      }

      const mCall = SM_CALLING_LLM_RE.exec(msg);
      if (mCall) {
        const name = mCall[1].trim();
        const model = mCall[2].trim();
        const cur = fileState.activeByTid.get(tid) || {
          name,
          model,
          trajChars: 0,
          startedAtMs: tsMs,
          calledAtMs: tsMs,
          lastSeenMs: tsMs,
          countedCall: false,
        };
        cur.name = name;
        cur.model = model;
        cur.calledAtMs = tsMs;
        cur.lastSeenMs = tsMs;
        if (!cur.countedCall) {
          cur.countedCall = true;
          if (smIsHeavyMonitor(name, model)) {
            bucket.sn += 1;
            stats.urgent = true;
          } else if (smIsFlashLiteMonitor(name, model)) {
            bucket.fl += 1;
          }
          if (tsMs > lastAnyMonitorAtMs) lastAnyMonitorAtMs = tsMs;
          stats.mutated = true;
        }
        fileState.activeByTid.set(tid, cur);
        return;
      }

      const mDone = SM_EVAL_COMPLETE_RE.exec(msg);
      if (mDone) {
        const name = mDone[1].trim();
        const triggered = mDone[2].toLowerCase() === 'true';
        const cur = fileState.activeByTid.get(tid) || null;
        fileState.activeByTid.delete(tid);
        const model = cur?.model || '';
        const trajChars = Number(cur?.trajChars) || 0;
        const baseStart = cur?.startedAtMs || cur?.calledAtMs || 0;
        const durationMs =
          baseStart > 0 && tsMs >= baseStart ? Math.min(120_000, tsMs - baseStart) : 0;

        if (smIsHeavyMonitor(name, model)) {
          if (!cur?.countedCall) bucket.sn += 1;
          if (triggered) bucket.snTrig += 1;
          bucket.ch += trajChars;
          bucket.blMs += durationMs;
          recordHeavyEvent({
            tsMs,
            startedAtMs: baseStart || tsMs,
            name,
            model: model || 'gemini-4-hydrogen-sonar',
            trajChars,
            triggered,
            durationMs,
          });
          stats.urgent = true;
        } else if (smIsFlashLiteMonitor(name, model)) {
          if (!cur?.countedCall) bucket.fl += 1;
          if (triggered) bucket.flTrig += 1;
          bucket.flCh += trajChars;
          bucket.blMs += durationMs;
        }
        if (tsMs > lastAnyMonitorAtMs) lastAnyMonitorAtMs = tsMs;
        stats.mutated = true;
        return;
      }
      return;
    }

    if (srcLower.includes('http_helpers.go') && msg.includes('streamGenerateContent')) {
      bucket.s += 1;
      const active = fileState.activeByTid.get(tid);
      if (active && tsMs - (active.lastSeenMs || 0) <= 120_000) {
        bucket.h += 1;
        active.lastSeenMs = tsMs;
      }
      stats.mutated = true;
      return;
    }

    if (srcLower.includes('runner.go')) {
      const mFb = SM_RUNNER_FALLBACK_RE.exec(msg);
      if (mFb) {
        bucket.fb += 1;
        if (tsMs > lastFallbackAtMs) lastFallbackAtMs = tsMs;
        stats.urgent = true;
        stats.mutated = true;
        return;
      }
      const mFin = SM_RUNNER_FINISHED_RE.exec(msg);
      if (mFin) {
        const monName = mFin[1].trim();
        if (smIsHeavyMonitor(monName) || smIsFlashLiteMonitor(monName)) {
          const durMs = smParseDurationMs(mFin[3], mFin[4]);
          // 仅作为首轮不完整截断兜底：若前面未收到 llm_monitor complete，才补充耗时
          if (durMs > 0 && bucket.blMs === 0) {
            bucket.blMs += Math.min(120_000, durMs);
            stats.mutated = true;
          }
        }
      }
    }
  }

  function processRawLine(rawLine, fileState, refMs, stats) {
    if (!smFastLineMayMatch(rawLine)) return;
    if (rawLine.indexOf('] ', 30) !== rawLine.lastIndexOf('] ')) {
      const parts = rawLine.split(SM_CONJOINED_SPLIT_RE);
      for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i].trim();
        if (part && smFastLineMayMatch(part)) {
          processSingleRecord(part, fileState, refMs, stats);
        }
      }
      return;
    }
    processSingleRecord(rawLine.trim(), fileState, refMs, stats);
  }

  function scanSingleFile(source, nowMs, stats) {
    if (!openFn || !fstatFn || !readFn || !closeFn) return false;
    let fd = null;
    try {
      fd = openFn(source.path, 'r');
      const fst = fstatFn(fd);
      const liveSize = Math.max(0, Number(fst?.size) || 0);
      const liveMtimeMs = Math.max(0, Number(fst?.mtimeMs) || nowMs);

      let fState = fileStates.get(source.key);
      if (!fState) {
        fState = {
          offset: 0,
          size: 0,
          mtimeMs: 0,
          partialLine: '',
          activeByTid: new Map(),
        };
        fileStates.set(source.key, fState);
      }

      // 桌面端重启截断或日志轮转：重置文件偏移但完整保留已聚合的分钟桶与近期事件
      let skippedPartialHead = false;
      if (liveSize < fState.offset) {
        fState.offset = 0;
        fState.partialLine = '';
        fState.activeByTid.clear();
        stats.mutated = true;
      }

      if (liveSize === fState.offset) {
        fState.size = liveSize;
        fState.mtimeMs = liveMtimeMs;
        return true;
      }

      if (fState.offset === 0 && liveSize > maxInitialTailBytes) {
        fState.offset = liveSize - maxInitialTailBytes;
        fState.partialLine = '';
        skippedPartialHead = true;
      }

      const bytesRemaining = liveSize - fState.offset;
      const bytesBudget = Math.min(bytesRemaining, maxBytesPerScan);
      const chunkBuf = Buffer.allocUnsafe(Math.min(SM_READ_CHUNK_BYTES, bytesBudget));
      const decoder = new TextDecoder('utf-8');
      let pos = fState.offset;
      let consumed = 0;
      let carry = fState.partialLine || '';
      const refMs = liveMtimeMs > 0 ? liveMtimeMs : nowMs;

      while (consumed < bytesBudget) {
        const toRead = Math.min(chunkBuf.length, bytesBudget - consumed);
        const bytesRead = readFn(fd, chunkBuf, 0, toRead, pos);
        if (!bytesRead || bytesRead <= 0) break;
        pos += bytesRead;
        consumed += bytesRead;

        const text = carry + decoder.decode(chunkBuf.subarray(0, bytesRead), { stream: true });
        let lineStart = 0;
        for (let i = 0; i < text.length; i += 1) {
          if (text.charCodeAt(i) === 10) {
            let lineEnd = i;
            if (lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13) {
              lineEnd -= 1;
            }
            if (skippedPartialHead) {
              skippedPartialHead = false;
            } else if (lineEnd > lineStart) {
              processRawLine(text.slice(lineStart, lineEnd), fState, refMs, stats);
            }
            lineStart = i + 1;
          }
        }
        carry = lineStart < text.length ? text.slice(lineStart) : '';
        if (carry.length > 512 * 1024) {
          carry = '';
        }
      }

      const trailing = decoder.decode();
      if (trailing) carry += trailing;
      // 若读取到文件末尾且最后一行无换行符，尝试处理已完整落盘的日志行并仅保留极短未完残片
      if (pos >= liveSize && carry.length > 0 && SM_GLOG_HEADER_RE.test(carry)) {
        processRawLine(carry, fState, refMs, stats);
        carry = '';
      }

      fState.offset = pos;
      fState.size = liveSize;
      fState.mtimeMs = liveMtimeMs;
      fState.partialLine = carry;
      pruneActiveTids(fState.activeByTid, refMs);
      return true;
    } catch {
      return false;
    } finally {
      if (fd !== null) {
        try {
          closeFn(fd);
        } catch {
          // ignore close error
        }
      }
    }
  }

  function serializeState(nowMs) {
    const serializedFiles = {};
    for (const [k, f] of fileStates.entries()) {
      serializedFiles[k] = {
        offset: f.offset,
        size: f.size,
        mtimeMs: f.mtimeMs,
      };
    }
    return {
      version: SM_STATE_SCHEMA_VERSION,
      savedAt: new Date(nowMs).toISOString(),
      files: serializedFiles,
      minuteBuckets,
      recentHeavyEvents,
      lastHeavyEventAtMs,
      lastAnyMonitorAtMs,
      lastFallbackAtMs,
      last429AtMs,
    };
  }

  function persistIfNeeded(urgent, nowMs) {
    if (typeof saveState !== 'function') return;
    if (!urgent && lastPersistMs > 0 && nowMs - lastPersistMs < persistMinIntervalMs) {
      return;
    }
    lastPersistMs = nowMs;
    try {
      saveState(serializeState(nowMs));
    } catch {
      // 持久化失败不影响运行期主流程
    }
  }

  function buildSnapshot(nowMs, sourceCount) {
    const w5h = summarizeSafetyMonitorWindow(
      minuteBuckets,
      recentHeavyEvents,
      nowMs - SM_FIVE_HOURS_MS,
      nowMs
    );
    const w24h = summarizeSafetyMonitorWindow(
      minuteBuckets,
      recentHeavyEvents,
      nowMs - SM_DAY_MS,
      nowMs
    );
    const w7d = summarizeSafetyMonitorWindow(
      minuteBuckets,
      recentHeavyEvents,
      nowMs - SM_RETENTION_MS,
      nowMs
    );
    const w15m = summarizeSafetyMonitorWindow(
      minuteBuckets,
      recentHeavyEvents,
      nowMs - 15 * 60 * 1000,
      nowMs
    );

    const has429Fallback =
      w5h.fallbackCount > 0 || (w5h.rateLimit429Count > 0 && w5h.heavyCalls > 0);
    const hasHeavyBurst =
      w15m.heavyCalls >= SM_HEAVY_BURST_15M_COUNT &&
      w15m.heavyTrajChars / Math.max(1, w15m.heavyCalls) >= SM_HEAVY_LARGE_TRAJ_CHARS;
    const nearFlashLiteLimit = w5h.flashLiteCalls >= SM_FLASH_LITE_5H_WARN_THRESHOLD;

    return {
      scannedAtMs: nowMs,
      hasActiveSources: sourceCount > 0,
      sourceCount,
      window5h: w5h,
      window24h: w24h,
      window7d: w7d,
      lastHeavyEventAtMs: lastHeavyEventAtMs || null,
      lastAnyMonitorAtMs: lastAnyMonitorAtMs || null,
      lastFallbackAtMs: lastFallbackAtMs || null,
      last429AtMs: last429AtMs || null,
      alerts: {
        has429Fallback,
        hasHeavyBurst,
        nearFlashLiteLimit,
      },
      // 供 quota-reservation.mjs 做精确窗口对账（只读引用，不在热路径深拷贝）
      recentHeavyEvents,
      minuteBuckets,
    };
  }

  function refresh({ nowMs = Date.now(), force = false } = {}) {
    ensureHydrated(nowMs);
    if (
      !force &&
      cachedSnapshot &&
      lastScanMs > 0 &&
      nowMs >= lastScanMs &&
      nowMs - lastScanMs < scanMinIntervalMs
    ) {
      return cachedSnapshot;
    }

    lastScanMs = nowMs;
    const shouldRediscover =
      force ||
      !Array.isArray(cachedSources) ||
      scanMinIntervalMs === 0 ||
      nowMs - lastDiscoverMs >= 30_000;
    if (shouldRediscover) {
      cachedSources = discoverFn({ nowMs }) || [];
      lastDiscoverMs = nowMs;
    }
    const sources = cachedSources;
    const stats = { mutated: false, urgent: false };
    let activeSources = 0;
    for (let i = 0; i < sources.length; i += 1) {
      if (scanSingleFile(sources[i], nowMs, stats)) {
        activeSources += 1;
      }
    }
    pruneOldData(nowMs);
    if (stats.mutated) {
      persistIfNeeded(stats.urgent, nowMs);
    }
    cachedSnapshot = buildSnapshot(nowMs, activeSources);
    return cachedSnapshot;
  }

  function reset() {
    fileStates.clear();
    minuteBuckets = Object.create(null);
    recentHeavyEvents = [];
    lastHeavyEventAtMs = 0;
    lastAnyMonitorAtMs = 0;
    lastFallbackAtMs = 0;
    last429AtMs = 0;
    lastScanMs = 0;
    lastDiscoverMs = 0;
    cachedSources = null;
    lastPersistMs = 0;
    cachedSnapshot = null;
    hydrated = true;
  }

  return {
    refresh,
    reset,
    summarizeWindow: (sinceMs, untilMs) =>
      summarizeSafetyMonitorWindow(minuteBuckets, recentHeavyEvents, sinceMs, untilMs),
    _getState: () => serializeState(Date.now()),
  };
}

function smIsTestRuntime() {
  return (
    lsRuntimeEndpoint?.addr === 'test.invalid' ||
    String(process?.env?.ANTIGRAVITY_LS_ADDRESS || '').trim() === 'test.invalid'
  );
}

const defaultSafetyMonitorScanner = createSafetyMonitorScanner({
  loadState: () => {
    if (smIsTestRuntime()) return null;
    return loadJson(SAFETY_MONITOR_STATE_FILE, null);
  },
  saveState: (payload) => {
    if (smIsTestRuntime()) return;
    saveJson(SAFETY_MONITOR_STATE_FILE, payload);
  },
  discoverSources: (opts) => {
    if (smIsTestRuntime()) return [];
    return discoverSafetyMonitorLogSources(opts);
  },
});

/**
 * 刷新并返回本地后台安全审查日志快照（节流 + 增量读；测试环境下自动返回空快照）。
 */
export function refreshSafetyMonitorTelemetry(opts = {}) {
  return defaultSafetyMonitorScanner.refresh(opts);
}

/**
 * 清空默认安全审查扫描器内存态（供测试隔离使用）。
 */
export function resetSafetyMonitorState() {
  defaultSafetyMonitorScanner.reset();
}
