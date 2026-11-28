/**
 * @fileoverview Host theme snapshot store (`host-theme-store.mjs`).
 *
 * Coordinates live CDP-probed host CSS variables, multi-process bridge lease handoff,
 * native `/preload.js` observations, and atomic disk persistence (`host-theme-cache.json`)
 * so sidecar aux panes immediately retain exact host colors across plugin restarts.
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, SHARED_BRIDGE_LEASE_FILE, loadJson, saveJson } from './config.mjs';
import {
  getHostThemeSignature,
  normalizeHostThemeSnapshot,
} from '../shared/host-theme.mjs';

export const HOST_THEME_CACHE_FILE = join(DATA_DIR, 'host-theme-cache.json');
const DEFAULT_BRIDGE_LEASE_FILE = SHARED_BRIDGE_LEASE_FILE;
const LEASE_FRESH_WINDOW_MS = 45_000;

let liveCdpState = { snapshot: null, sig: '', updatedAtMs: 0 };
let livePreloadState = { snapshot: null, sig: '', updatedAtMs: 0 };
let lastPersistedDiskSig = '';
let diskReadMemo = { path: '', mtimeMs: -1, snapshot: null };
let leaseReadMemo = { path: '', mtimeMs: -1, snapshot: null, leaseUpdatedAtMs: 0 };

function isTestHarnessProcess() {
  return String(process?.env?.ANTIGRAVITY_LS_ADDRESS || '').trim() === 'test.invalid';
}

function readCachedJsonMemoized(filePath, memo, extractFn) {
  if (!filePath) return null;
  try {
    const st = statSync(filePath);
    const mtimeMs = Number(st.mtimeMs || 0);
    if (memo.path === filePath && memo.mtimeMs === mtimeMs) {
      return memo;
    }
    const raw = loadJson(filePath, null);
    const extracted = extractFn(raw);
    memo.path = filePath;
    memo.mtimeMs = mtimeMs;
    memo.snapshot = extracted.snapshot;
    if ('leaseUpdatedAtMs' in memo) {
      memo.leaseUpdatedAtMs = extracted.leaseUpdatedAtMs || 0;
    }
    return memo;
  } catch {
    memo.path = filePath;
    memo.mtimeMs = -1;
    memo.snapshot = null;
    if ('leaseUpdatedAtMs' in memo) {
      memo.leaseUpdatedAtMs = 0;
    }
    return null;
  }
}

function persistSnapshotIfChanged(snapshot, sig, cacheFilePath) {
  if (!snapshot || !sig || !cacheFilePath) return false;
  if (isTestHarnessProcess() && cacheFilePath === HOST_THEME_CACHE_FILE) {
    return false;
  }
  if (cacheFilePath === HOST_THEME_CACHE_FILE && sig === lastPersistedDiskSig) {
    return false;
  }
  try {
    saveJson(cacheFilePath, snapshot);
    if (cacheFilePath === HOST_THEME_CACHE_FILE) {
      lastPersistedDiskSig = sig;
    }
    diskReadMemo = { path: '', mtimeMs: -1, snapshot: null };
    return true;
  } catch {
    return false;
  }
}

/**
 * Record a live host theme snapshot probed directly from the Antigravity host window via CDP.
 *
 * @param {unknown} rawSnapshot
 * @param {{ persist?: boolean, cacheFilePath?: string, nowMs?: number }} [options]
 */
export function recordLiveCdpHostTheme(
  rawSnapshot,
  { persist = true, cacheFilePath = HOST_THEME_CACHE_FILE, nowMs = Date.now() } = {}
) {
  const normalized = normalizeHostThemeSnapshot(
    rawSnapshot && typeof rawSnapshot === 'object'
      ? { ...rawSnapshot, source: 'cdp', updatedAtMs: Number(rawSnapshot.updatedAtMs) || nowMs }
      : null
  );
  if (!normalized) return null;
  const sig = getHostThemeSignature(normalized);
  if (!sig) return null;
  liveCdpState = { snapshot: normalized, sig, updatedAtMs: normalized.updatedAtMs || nowMs };
  if (persist) {
    persistSnapshotIfChanged(normalized, sig, cacheFilePath);
  }
  return normalized;
}

function mergeHostThemeVars(primary, secondary) {
  if (!primary) return secondary || null;
  if (!secondary) return primary;
  return {
    ...primary,
    vars: {
      ...(secondary.vars || {}),
      ...(primary.vars || {}),
    },
  };
}

/**
 * Record a native host theme snapshot observed from Antigravity's `/preload.js` in the sidecar pane.
 *
 * @param {unknown} rawSnapshot
 * @param {{ persist?: boolean, cacheFilePath?: string, nowMs?: number }} [options]
 */
export function recordPreloadHostTheme(
  rawSnapshot,
  { persist = true, cacheFilePath = HOST_THEME_CACHE_FILE, nowMs = Date.now() } = {}
) {
  const normalized = normalizeHostThemeSnapshot(
    rawSnapshot && typeof rawSnapshot === 'object'
      ? { ...rawSnapshot, source: 'preload', updatedAtMs: Number(rawSnapshot.updatedAtMs) || nowMs }
      : null
  );
  if (!normalized) return null;
  const sig = getHostThemeSignature(normalized);
  if (!sig) return null;
  livePreloadState = { snapshot: normalized, sig, updatedAtMs: normalized.updatedAtMs || nowMs };
  if (persist) {
    const persistedSnapshot = liveCdpState.snapshot
      ? mergeHostThemeVars(normalized, liveCdpState.snapshot)
      : normalized;
    const persistedSig = getHostThemeSignature(persistedSnapshot);
    if (persistedSig) {
      persistSnapshotIfChanged(persistedSnapshot, persistedSig, cacheFilePath);
    }
  }
  return normalized;
}

/**
 * Resolve the most authoritative available host theme snapshot across:
 * 1. Live CDP probe in this process;
 * 2. Fresh leader lease file (`window-bridge-lease.json`) when running as a follower worker;
 * 3. Live `/preload.js` observation in this process (preferred if newer than CDP);
 * 4. Persisted disk cache (`host-theme-cache.json`) for non-CDP or cold restart recovery.
 *
 * @param {{ cacheFilePath?: string, leaseFilePath?: string, nowMs?: number }} [options]
 */
export function getEffectiveHostTheme({
  cacheFilePath = HOST_THEME_CACHE_FILE,
  leaseFilePath = DEFAULT_BRIDGE_LEASE_FILE,
  nowMs = Date.now(),
} = {}) {
  let cdpCandidate = liveCdpState.snapshot;
  let cdpAt = liveCdpState.updatedAtMs;

  if (!isTestHarnessProcess() || leaseFilePath !== DEFAULT_BRIDGE_LEASE_FILE) {
    const leaseInfo = readCachedJsonMemoized(leaseFilePath, leaseReadMemo, (raw) => {
      const leaseUpdatedAtMs = Number(raw?.updatedAtMs || 0);
      const snapshot = normalizeHostThemeSnapshot(raw?.hostTheme);
      return { snapshot, leaseUpdatedAtMs };
    });
    if (
      leaseInfo?.snapshot &&
      leaseInfo.leaseUpdatedAtMs > 0 &&
      nowMs - leaseInfo.leaseUpdatedAtMs >= -5000 &&
      nowMs - leaseInfo.leaseUpdatedAtMs <= LEASE_FRESH_WINDOW_MS
    ) {
      const leaseAt = leaseInfo.snapshot.updatedAtMs || leaseInfo.leaseUpdatedAtMs;
      if (!cdpCandidate || leaseAt > cdpAt) {
        cdpCandidate = leaseInfo.snapshot;
        cdpAt = leaseAt;
      }
    }
  }

  const preloadCandidate = livePreloadState.snapshot;
  const preloadAt = livePreloadState.updatedAtMs;

  if (cdpCandidate && preloadCandidate) {
    const primary = preloadAt > cdpAt ? preloadCandidate : cdpCandidate;
    const secondary = preloadAt > cdpAt ? cdpCandidate : preloadCandidate;
    return mergeHostThemeVars(primary, secondary);
  }
  if (cdpCandidate) return cdpCandidate;
  if (preloadCandidate) return preloadCandidate;

  if (!isTestHarnessProcess() || cacheFilePath !== HOST_THEME_CACHE_FILE) {
    const diskInfo = readCachedJsonMemoized(cacheFilePath, diskReadMemo, (raw) => ({
      snapshot: normalizeHostThemeSnapshot(raw),
    }));
    if (diskInfo?.snapshot) {
      return diskInfo.snapshot;
    }
  }

  return null;
}

/**
 * Reset in-memory host theme store state (test helper).
 */
export function resetHostThemeStoreForTests() {
  liveCdpState = { snapshot: null, sig: '', updatedAtMs: 0 };
  livePreloadState = { snapshot: null, sig: '', updatedAtMs: 0 };
  lastPersistedDiskSig = '';
  diskReadMemo = { path: '', mtimeMs: -1, snapshot: null };
  leaseReadMemo = { path: '', mtimeMs: -1, snapshot: null, leaseUpdatedAtMs: 0 };
}
