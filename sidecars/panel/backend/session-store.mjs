/**
 * @fileoverview 本地 Antigravity 三端会话存储共享安全底座 (`session-store.mjs`)。
 *
 * 为 `session-manager.mjs`、`session-cleaner.mjs` 与 `session-migrator.mjs` 提供单一事实来源：
 * 1. 统一三端注册表（Desktop App `antigravity`、CLI `antigravity-cli`、旧版 IDE `antigravity-ide`）；
 * 2. 严格 36 位 UUID 校验与逐级 `lstatSync` 不跟随符号链接的路径安全原语；
 * 3. 跨平台按客户端进程守卫（运行中客户端保守阻断删除，无法枚举时安全失败）；
 * 4. 统一嵌套子代理 / 旁路提问 vs `/fork` 独立会话判定；
 * 5. 存储产物/索引/全量存活 ID 采集及跨端迁移归档保护检测。
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  decodeWorkspaceFileUriToPath,
  parseWorkspaceDisplayLabel,
  parseWorkspaceUrisColumn,
} from '../shared/workspace-uri.mjs';
import { parseIsoMs } from '../trajectory-metrics.mjs';
import { DATA_DIR } from './config.mjs';
import { parseSummaryProtoIndexIds, readProtoVarint, splitProtoRawFields } from './proto-wire.mjs';
import {
  getNodeSqliteDatabaseSync,
  isSqliteBusyError,
  normalizeSqliteIsoTime,
  withReadOnlySqliteDb,
} from './sqlite-client.mjs';

export const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SESSION_CLIENT_DEFS = Object.freeze([
  Object.freeze({
    id: 'desktop',
    dirName: 'antigravity',
    appDataDir: 'antigravity',
    trajectorySourceNum: 1,
    allowTarget: true,
    summaryProtoFile: 'agyhub_summaries_proto.pb',
    isDesktopProto: true,
    hasHistoryJsonl: false,
    hasAppStorage: true,
  }),
  Object.freeze({
    id: 'cli',
    dirName: 'antigravity-cli',
    appDataDir: 'antigravity-cli',
    trajectorySourceNum: 17,
    allowTarget: true,
    summaryProtoFile: 'jetbox_summaries_proto.pb',
    isDesktopProto: false,
    hasHistoryJsonl: true,
    hasAppStorage: false,
  }),
  Object.freeze({
    id: 'ide_legacy',
    dirName: 'antigravity-ide',
    appDataDir: 'antigravity-ide',
    trajectorySourceNum: 1,
    allowTarget: false,
    summaryProtoFile: 'agyhub_summaries_proto.pb',
    isDesktopProto: true,
    hasHistoryJsonl: false,
    hasAppStorage: false,
  }),
]);

export const MIGRATION_OUTSIDE_PROJECT_ID = 'outside-of-project';
export const MIGRATION_CLI_PROJECT_ID = 'default-cli-project';

/**
 * 从桌面端 `conversation_summaries` 映射表提取可供跨端迁移绑定的项目列表（与 `session-manager` / `session-migrator` 共用）。
 *
 * @param {Map<string, object>} summaryMap
 * @returns {Array<object>}
 */
export function extractDesktopProjectsFromSummaryMap(summaryMap) {
  const byProjectId = new Map();
  if (summaryMap && typeof summaryMap.values === 'function') {
    for (const row of summaryMap.values()) {
      const source = String(row?.source || '').trim();
      const projectId = String(row?.project_id || '').trim();
      if (source === 'CORTEX_TRAJECTORY_SOURCE_CLI') continue;
      if (
        !projectId ||
        projectId === MIGRATION_CLI_PROJECT_ID ||
        projectId === MIGRATION_OUTSIDE_PROJECT_ID
      ) {
        continue;
      }
      const uris = parseWorkspaceUrisColumn(row?.workspace_uris);
      const primaryUri = uris[0] || '';
      const lastModifiedMs = parseIsoMs(normalizeSqliteIsoTime(row?.last_modified_time)) || 0;
      const prev = byProjectId.get(projectId);
      if (!prev) {
        const { name, displayPath } = parseWorkspaceDisplayLabel(primaryUri);
        byProjectId.set(projectId, {
          projectId,
          name: name || projectId.slice(0, 8),
          workspaceUri: primaryUri,
          workspacePath: displayPath,
          conversationCount: 1,
          lastModifiedMs,
        });
      } else {
        prev.conversationCount += 1;
        if (lastModifiedMs > prev.lastModifiedMs) {
          prev.lastModifiedMs = lastModifiedMs;
          if (primaryUri) {
            const { name, displayPath } = parseWorkspaceDisplayLabel(primaryUri);
            prev.workspaceUri = primaryUri;
            prev.workspacePath = displayPath;
            if (name) prev.name = name;
          }
        }
      }
    }
  }
  const sorted = [...byProjectId.values()].sort(
    (a, b) => b.lastModifiedMs - a.lastModifiedMs || b.conversationCount - a.conversationCount
  );
  sorted.push({
    projectId: MIGRATION_OUTSIDE_PROJECT_ID,
    name: '',
    workspaceUri: '',
    workspacePath: '',
    conversationCount: 0,
    lastModifiedMs: 0,
    isOutsideProject: true,
  });
  return sorted;
}

export function getSessionClientDef(clientId) {
  const id = String(clientId || '').trim().toLowerCase();
  return SESSION_CLIENT_DEFS.find((item) => item.id === id) || null;
}

export function isValidSessionUuid(rawId) {
  return typeof rawId === 'string' && SESSION_UUID_RE.test(rawId.trim());
}

export function normalizeSessionUuid(rawId) {
  const str = String(rawId || '').trim().toLowerCase();
  return SESSION_UUID_RE.test(str) ? str : '';
}

export function resolveGeminiDir(explicitGeminiDir) {
  const override = String(explicitGeminiDir || '').trim();
  if (override) return resolve(override);
  const envDir = String(process.env.ANTIGRAVITY_GEMINI_DIR || '').trim();
  return resolve(envDir || join(homedir(), '.gemini'));
}

export function resolveMigrationBackupRoot(explicitBackupDir, explicitGeminiDir = '') {
  const override = String(explicitBackupDir || '').trim();
  if (override) return resolve(override);
  const geminiOverride = String(explicitGeminiDir || '').trim();
  if (geminiOverride) {
    return resolve(join(geminiOverride, '.um-session-migration-backups'));
  }
  return resolve(join(DATA_DIR, 'session-migration-backups'));
}

export function resolveScopedTrajectoryCacheStore(options = {}, fallbackGetter = null) {
  if (options && options.cacheStore !== undefined) {
    return options.cacheStore;
  }
  if (options && String(options.geminiDir || '').trim()) {
    return null;
  }
  return typeof fallbackGetter === 'function' ? fallbackGetter() : null;
}

export function resolveClientRoot(clientId, explicitGeminiDir) {
  const def = typeof clientId === 'object' && clientId ? clientId : getSessionClientDef(clientId);
  if (!def) return '';
  return join(resolveGeminiDir(explicitGeminiDir), def.dirName);
}

/**
 * 解析 Antigravity Desktop 的 Electron 应用数据目录（承载 `app_storage.json`、`Cache`、`Code Cache`）。
 * 当显式指定了隔离的 `explicitGeminiDir` 而未显式传入 `explicitAppDataDir` 时返回空串，绝不越界触碰宿主真实目录。
 *
 * @param {{
 *   platform?: string,
 *   homeDir?: string,
 *   appDataEnv?: string,
 *   xdgConfigHome?: string,
 *   explicitAppDataDir?: string,
 *   explicitGeminiDir?: string,
 * }} [options={}]
 * @returns {string}
 */
export function resolveElectronAppDataDir({
  platform = process.platform,
  homeDir = homedir(),
  appDataEnv = process.env.APPDATA || '',
  xdgConfigHome = process.env.XDG_CONFIG_HOME || '',
  explicitAppDataDir = '',
  explicitGeminiDir = '',
} = {}) {
  const override = String(explicitAppDataDir || '').trim();
  if (override) return resolve(override);
  if (String(explicitGeminiDir || '').trim()) {
    return '';
  }
  if (platform === 'win32') {
    const base = String(appDataEnv || '').trim() || join(homeDir, 'AppData', 'Roaming');
    return resolve(join(base, 'Antigravity'));
  }
  if (platform === 'darwin') {
    return resolve(join(homeDir, 'Library', 'Application Support', 'Antigravity'));
  }
  const xdg = String(xdgConfigHome || '').trim();
  const base = xdg || join(homeDir, '.config');
  return resolve(join(base, 'Antigravity'));
}

// ---------------------------------------------------------------------------
// 符号链接与路径穿越防护原语
// ---------------------------------------------------------------------------

/**
 * 判断候选路径是否严格位于受控根目录之内（支持 Windows 大小写不敏感匹配）。
 *
 * @param {string} candidatePath
 * @param {string} rootPath
 * @param {string} [platform=process.platform]
 * @returns {boolean}
 */
export function isPathInsideRoot(candidatePath, rootPath, platform = process.platform) {
  const absCand = resolve(String(candidatePath || ''));
  const absRoot = resolve(String(rootPath || ''));
  if (!absCand || !absRoot) return false;
  const cmpCand = platform === 'win32' ? absCand.toLowerCase() : absCand;
  const cmpRoot = platform === 'win32' ? absRoot.toLowerCase() : absRoot;
  if (cmpCand === cmpRoot) return true;
  const rel = relative(cmpRoot, cmpCand);
  return Boolean(rel && !rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * 在给定根目录下逐级校验相对路径段，严禁路径穿越、空段与任意一级符号链接。
 * 注意：仅对 `rootDir` 自身及内部各级 `segments` 执行 `lstatSync`，避免在 macOS `/var -> /private/var`
 * 临时目录祖先软链下误报。
 *
 * @param {string} rootDir
 * @param {string[]} relSegments
 * @returns {{ ok: boolean, path: string, exists: boolean, stat: import('node:fs').Stats | null, error?: string }}
 */
export function resolveNoFollowPath(rootDir, relSegments = []) {
  const absRoot = resolve(String(rootDir || ''));
  if (!absRoot) {
    return { ok: false, path: '', exists: false, stat: null, error: 'invalid_root' };
  }
  try {
    const rootStat = lstatSync(absRoot);
    if (rootStat.isSymbolicLink()) {
      return { ok: false, path: absRoot, exists: true, stat: rootStat, error: 'symlink_not_allowed' };
    }
    if (!rootStat.isDirectory()) {
      return { ok: false, path: absRoot, exists: true, stat: rootStat, error: 'root_not_directory' };
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ok: false, path: absRoot, exists: false, stat: null, error: 'root_missing' };
    }
    return { ok: false, path: absRoot, exists: false, stat: null, error: err?.message || 'lstat_failed' };
  }

  let current = absRoot;
  let lastStat = null;
  let exists = true;

  for (const rawSeg of relSegments) {
    const seg = String(rawSeg ?? '');
    if (
      !seg ||
      seg === '.' ||
      seg === '..' ||
      seg.includes('/') ||
      seg.includes('\\') ||
      seg.includes('\0')
    ) {
      return { ok: false, path: '', exists: false, stat: null, error: 'invalid_path_segment' };
    }
    const next = join(current, seg);
    if (!isPathInsideRoot(next, absRoot)) {
      return { ok: false, path: '', exists: false, stat: null, error: 'path_escape' };
    }
    if (exists) {
      try {
        const st = lstatSync(next);
        if (st.isSymbolicLink()) {
          return { ok: false, path: next, exists: true, stat: st, error: 'symlink_not_allowed' };
        }
        lastStat = st;
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          exists = false;
          lastStat = null;
        } else {
          return { ok: false, path: next, exists: false, stat: null, error: err?.message || 'lstat_failed' };
        }
      }
    }
    current = next;
  }

  return { ok: true, path: current, exists, stat: lastStat };
}

/**
 * 逐级校验不跟随符号链接的普通文件路径（存在时必须为常规文件，非目录、非符号链接）。
 *
 * @param {string} rootDir
 * @param {string[]} relSegments
 * @returns {{ ok: boolean, path: string, exists: boolean, stat: import('node:fs').Stats | null, error?: string }}
 */
export function resolveNoFollowFile(rootDir, relSegments = []) {
  const res = resolveNoFollowPath(rootDir, relSegments);
  if (!res.ok) return res;
  if (res.exists && res.stat && !res.stat.isFile()) {
    return { ok: false, path: res.path, exists: true, stat: res.stat, error: 'not_a_regular_file' };
  }
  return res;
}

// ---------------------------------------------------------------------------
// 统一 SQLite 写连接重试原语
// ---------------------------------------------------------------------------

/**
 * 以短连接重试模式打开可写 SQLite 数据库（每次执行完在 `finally` 中安全关闭，防 Windows 句柄滞留）。
 *
 * @template T
 * @param {string} dbPath
 * @param {(db: import('node:sqlite').DatabaseSync) => T} fn
 * @param {{ busyTimeoutMs?: number, maxAttempts?: number }} [options={}]
 * @returns {T}
 */
export function withWritableSqliteDb(dbPath, fn, { busyTimeoutMs = 3000, maxAttempts = 3 } = {}) {
  const DatabaseSync = getNodeSqliteDatabaseSync();
  if (!DatabaseSync) {
    throw new Error('Built-in node:sqlite is unavailable');
  }
  const attempts = Math.max(1, Math.floor(Number(maxAttempts) || 3));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let db = null;
    try {
      db = new DatabaseSync(dbPath);
      db.exec(`PRAGMA busy_timeout = ${Math.max(200, Math.floor(Number(busyTimeoutMs) || 3000))};`);
      return fn(db);
    } catch (err) {
      if (attempt + 1 < attempts && isSqliteBusyError(err)) {
        continue;
      }
      throw err;
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          // 忽略关闭异常
        }
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 统一根会话 / 嵌套子代理 / /fork 判定
// ---------------------------------------------------------------------------

export function decodeMetaBlobLight(rawBlob) {
  const fields = splitProtoRawFields(rawBlob);
  let workspaceUri = '';
  let projectId = '';
  let parentConversationId = '';
  let rootConversationId = '';
  let nestingDepth = 0;
  let hasSubagentSpec = false;
  let createdMs = 0;
  for (const field of fields) {
    if (field.fn === 7 && field.wt === 2 && !workspaceUri) {
      workspaceUri = field.payload.toString('utf8').trim();
    } else if (field.fn === 1 && field.wt === 2 && !workspaceUri) {
      const wsFields = splitProtoRawFields(field.payload);
      const fn1 = wsFields.find((item) => item.fn === 1 && item.wt === 2);
      if (fn1) workspaceUri = fn1.payload.toString('utf8').trim();
    } else if (field.fn === 18 && field.wt === 2) {
      projectId = field.payload.toString('utf8').trim();
    } else if (field.fn === 5 && field.wt === 2) {
      parentConversationId = field.payload.toString('utf8').trim().toLowerCase();
    } else if (field.fn === 6 && field.wt === 2) {
      rootConversationId = field.payload.toString('utf8').trim().toLowerCase();
    } else if (field.fn === 8 && field.wt === 2 && field.payload.length > 0) {
      const specFields = splitProtoRawFields(field.payload);
      if (
        specFields.some(
          (sf) =>
            (sf.fn === 1 || sf.fn === 2) &&
            sf.wt === 2 &&
            sf.payload.toString('utf8').trim().length > 0
        )
      ) {
        hasSubagentSpec = true;
      }
    } else if (field.fn === 17 && field.wt === 0) {
      const st = { off: 0 };
      const depth = Number(BigInt.asIntN(32, readProtoVarint(field.payload, st, field.payload.length)));
      if (Number.isFinite(depth) && depth > 0) nestingDepth = depth;
    } else if (field.fn === 2 && field.wt === 2 && !createdMs) {
      const tsFields = splitProtoRawFields(field.payload);
      const secField = tsFields.find((item) => item.fn === 1 && item.wt === 0);
      if (secField) {
        const st = { off: 0 };
        const sec = Number(BigInt.asIntN(64, readProtoVarint(secField.payload, st, secField.payload.length)));
        if (Number.isFinite(sec) && sec > 0) createdMs = sec * 1000;
      }
    }
  }
  return {
    workspaceUri,
    projectId,
    parentConversationId,
    rootConversationId,
    nestingDepth,
    hasSubagentSpec,
    createdMs,
  };
}

/**
 * 判断实体 `.db` 轻量元数据是否属于嵌套子代理或旁路提问。
 * 注意：`/fork` 会话虽带有 `parentConversationId`，但 `nestingDepth === 0` 且无子代理标记，
 * 属于独立一等根会话，此处返回 `false`。
 *
 * @param {object | null | undefined} dbLight
 * @returns {boolean}
 */
export function isDbLightSubagent(dbLight) {
  if (!dbLight) return false;
  return Boolean(
    dbLight.trajectoryType === 22 ||
      dbLight.sourceNum === 16 ||
      Number(dbLight.nestingDepth || 0) > 0 ||
      dbLight.hasSubagentSpec
  );
}

/**
 * 将 `workspace_uris` 条目安全解析为本机绝对目录路径；严格拒绝 `vscode-remote://` 等远程协议及 `.` / `..` 相对路径。
 *
 * @param {unknown} rawWorkspaceUri
 * @returns {string}
 */
export function resolveLocalWorkspaceProjectDir(rawWorkspaceUri) {
  const raw = String(rawWorkspaceUri || '').trim();
  if (!raw) return '';
  if (
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) &&
    !/^file:\/\//i.test(raw) &&
    !/^[a-zA-Z]:[\\/]/.test(raw)
  ) {
    return '';
  }
  const decoded = decodeWorkspaceFileUriToPath(raw);
  if (!decoded || decoded.startsWith('//')) return '';
  if (!/^[a-zA-Z]:\//.test(decoded) && !decoded.startsWith('/')) {
    return '';
  }
  return decoded;
}

/**
 * 动态探测 `conversation_parents` 表中的父会话列名（生产库为 `parent_id`，兼容旧测试 `parent_conversation_id`）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {'parent_id' | 'parent_conversation_id' | ''}
 */
export function resolveConversationParentsColumn(db) {
  try {
    const cols = db.prepare('PRAGMA table_info(conversation_parents)').all();
    if (!Array.isArray(cols) || cols.length === 0) return '';
    const names = new Set(cols.map((c) => String(c?.name || '').trim().toLowerCase()));
    if (names.has('parent_id')) return 'parent_id';
    if (names.has('parent_conversation_id')) return 'parent_conversation_id';
  } catch {
    // 表不存在或不可读
  }
  return '';
}

/**
 * 读取 `conversation_summaries.db` 中 `conversation_parents` 表的 `childCid -> parentCid` 映射。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Map<string, string>}
 */
export function readConversationParentsMap(db) {
  const map = new Map();
  const parentCol = resolveConversationParentsColumn(db);
  if (!parentCol) return map;
  try {
    const rows = db.prepare(`SELECT conversation_id, ${parentCol} AS parent_val FROM conversation_parents`).all();
    for (const row of rows || []) {
      const cid = normalizeSessionUuid(row?.conversation_id);
      const pid = normalizeSessionUuid(row?.parent_val);
      if (cid && pid && cid !== pid) {
        map.set(cid, pid);
      }
    }
  } catch {
    // 忽略查询异常
  }
  return map;
}

/**
 * 从 `conversation_parents` 表中删除与目标会话集合关联的父子记录（自适应 `parent_id` / `parent_conversation_id`）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Iterable<string>} targetIds
 */
export function deleteConversationParentsByIds(db, targetIds) {
  const parentCol = resolveConversationParentsColumn(db);
  if (!parentCol) return;
  const stmt = db.prepare(
    `DELETE FROM conversation_parents WHERE conversation_id = ? OR ${parentCol} = ?`
  );
  for (const rawId of targetIds || []) {
    const cid = normalizeSessionUuid(rawId);
    if (cid) {
      stmt.run(cid, cid);
    }
  }
}

/**
 * 单遍轻量提取 `conversation_summaries` 行的子代理/旁路提问判定、父级/根级 UUID 及旁路提问子会话列表。
 *
 * @param {object | null | undefined} summary
 * @returns {{
 *   isSubagent: boolean,
 *   nestingDepth: number,
 *   parentConversationId: string,
 *   rootConversationId: string,
 *   forkParentId: string,
 *   sideQuestionChildren: string[],
 * }}
 */
export function decodeSummaryRelationsLight(summary) {
  if (!summary || typeof summary !== 'object') {
    return {
      isSubagent: false,
      nestingDepth: 0,
      parentConversationId: '',
      rootConversationId: '',
      forkParentId: '',
      sideQuestionChildren: [],
    };
  }
  const sqlParentId = normalizeSessionUuid(summary.parent_conversation_id);
  const sqlDepth = Math.max(0, Number(summary.nesting_depth || 0));
  const sourceStr = String(summary.source || '').trim();

  let trajectoryType = 0;
  let sourceNum = 0;
  let forkParentId = '';
  let metaParentId = '';
  let metaRootId = '';
  let metaDepth = 0;
  let hasSubagentSpec = false;
  const sideQuestionChildren = [];

  if (summary.raw_summary) {
    const rawFields = splitProtoRawFields(summary.raw_summary);
    for (const f of rawFields) {
      if (f.fn === 22 && f.wt === 0) {
        const st = { off: 0 };
        trajectoryType = Number(BigInt.asUintN(32, readProtoVarint(f.payload, st, f.payload.length)));
      } else if (f.fn === 20 && f.wt === 0) {
        const st = { off: 0 };
        sourceNum = Number(BigInt.asUintN(32, readProtoVarint(f.payload, st, f.payload.length)));
      } else if (f.fn === 24 && f.wt === 2) {
        forkParentId = normalizeSessionUuid(f.payload.toString('utf8'));
      } else if (f.fn === 17 && f.wt === 2) {
        const sumMeta = decodeMetaBlobLight(f.payload);
        metaParentId = normalizeSessionUuid(sumMeta.parentConversationId);
        metaRootId = normalizeSessionUuid(sumMeta.rootConversationId);
        metaDepth = Math.max(metaDepth, Number(sumMeta.nestingDepth || 0));
        if (sumMeta.hasSubagentSpec) hasSubagentSpec = true;
      } else if (f.fn === 15 && f.wt === 2 && f.payload.length > 0) {
        const annFields = splitProtoRawFields(f.payload);
        for (const af of annFields) {
          if (af.fn === 17 && af.wt === 2) {
            const sqId = normalizeSessionUuid(af.payload.toString('utf8'));
            if (sqId) sideQuestionChildren.push(sqId);
          } else if (af.fn === 18 && af.wt === 2 && af.payload.length > 0) {
            const entryFields = splitProtoRawFields(af.payload);
            const kField = entryFields.find((ef) => ef.fn === 1 && ef.wt === 2);
            if (kField) {
              const sqId = normalizeSessionUuid(kField.payload.toString('utf8'));
              if (sqId) sideQuestionChildren.push(sqId);
            }
          }
        }
      }
    }
  }

  const nestingDepth = Math.max(sqlDepth, metaDepth);
  const isSubagent = Boolean(
    nestingDepth > 0 ||
      sourceStr === 'CORTEX_TRAJECTORY_SOURCE_SUBAGENT' ||
      trajectoryType === 22 ||
      sourceNum === 16 ||
      hasSubagentSpec
  );
  const parentConversationId = sqlParentId || metaParentId || forkParentId || '';

  return {
    isSubagent,
    nestingDepth,
    parentConversationId,
    rootConversationId: metaRootId,
    forkParentId,
    sideQuestionChildren,
  };
}

/**
 * 判断 `conversation_summaries.db` 摘要行是否属于嵌套子代理或旁路提问（放行 `/fork`）。
 *
 * @param {object | null | undefined} summary
 * @returns {boolean}
 */
export function isSummarySubagent(summary) {
  return Boolean(summary && decodeSummaryRelationsLight(summary).isSubagent);
}

/**
 * 判断是否属于 `/fork` 派生独立会话（具有父会话 ID，但非嵌套子代理且 `nestingDepth === 0`）。
 *
 * @param {{ parentConversationId?: string, nestingDepth?: number, isSubagent?: boolean }} info
 * @returns {boolean}
 */
export function isForkSession({ parentConversationId = '', nestingDepth = 0, isSubagent = false } = {}) {
  return Boolean(String(parentConversationId || '').trim() && !isSubagent && Number(nestingDepth || 0) === 0);
}

// ---------------------------------------------------------------------------
// 跨平台按客户端进程守卫
// ---------------------------------------------------------------------------

function normalizeProcName(rawName, rawExe) {
  const fromName = String(rawName || '').trim();
  const fromExe = String(rawExe || '').trim();
  const leaf = (fromName || (fromExe ? basename(fromExe.replace(/\\/g, '/')) : '')).toLowerCase();
  return leaf.replace(/\.exe$/i, '');
}

/**
 * 纯函数：根据进程快照列表精准归类本机三个 Antigravity 客户端的运行状态。
 * 严格排除 Usage Monitor 插件自身进程，避免误将面板守护进程判定为桌面端运行中。
 *
 * @param {Array<{ name?: string, exe?: string, cmd?: string }>} processes
 * @returns {{ desktop: boolean, cli: boolean, ide_legacy: boolean }}
 */
export function classifyRunningClientsFromProcesses(processes = []) {
  const state = {
    desktop: false,
    cli: false,
    ide_legacy: false,
  };
  if (!Array.isArray(processes)) return state;

  for (const proc of processes) {
    if (!proc || typeof proc !== 'object') continue;
    const name = normalizeProcName(proc.name, proc.exe);
    const exeNorm = String(proc.exe || '').replace(/\\/g, '/').toLowerCase();
    const cmdNorm = String(proc.cmd || '').replace(/\\/g, '/').toLowerCase();
    const combined = `${exeNorm} ${cmdNorm}`;

    // 显式跳过本插件自己的 Node/Sidecar/桥接进程
    if (
      (name === 'node' || name === 'node.exe' || name === 'bun' || name === 'deno') &&
      !combined.includes('antigravity-cli')
    ) {
      continue;
    }

    // 1. 旧版 IDE 主进程或子进程
    if (
      name === 'antigravity ide' ||
      name === 'antigravity-ide' ||
      name === 'antigravity-insiders' ||
      name === 'antigravity-ide helper' ||
      exeNorm.includes('antigravity ide.app/') ||
      exeNorm.includes('/antigravity-ide/')
    ) {
      state.ide_legacy = true;
      continue;
    }

    // 2. CLI 主进程
    if (name === 'agy' || name === 'antigravity-cli') {
      state.cli = true;
      continue;
    }

    // 3. Desktop App 主进程或 Helper
    if (
      name === 'antigravity' ||
      name === 'antigravity helper' ||
      name === 'agy-desktop-helper' ||
      exeNorm.includes('/antigravity.app/') ||
      /\/antigravity\/antigravity(\.exe)?$/.test(exeNorm)
    ) {
      state.desktop = true;
      continue;
    }

    // 4. Language Server / AgentAPI 辅助进程：优先按 --app_data_dir 或可执行路径精确分端
    if (name.startsWith('language_server') || name === 'agentapi' || name.startsWith('agentapi-')) {
      const appDataMatch = cmdNorm.match(/--app_data_dir(?:=|\s+)["']?([^\s"']+)/);
      const appDataVal = appDataMatch ? appDataMatch[1] : '';
      if (
        appDataVal === 'antigravity-ide' ||
        appDataVal.endsWith('/antigravity-ide') ||
        combined.includes('antigravity-ide') ||
        combined.includes('antigravity ide') ||
        combined.includes('antigravity-insiders')
      ) {
        state.ide_legacy = true;
      } else if (
        appDataVal === 'antigravity-cli' ||
        appDataVal.endsWith('/antigravity-cli') ||
        combined.includes('antigravity-cli') ||
        combined.includes('jetbox')
      ) {
        state.cli = true;
      } else if (
        appDataVal === 'antigravity' ||
        appDataVal.endsWith('/antigravity') ||
        combined.includes('/antigravity/') ||
        combined.includes('antigravity.app') ||
        combined.includes('agyhub')
      ) {
        state.desktop = true;
      } else {
        // 无法细分归属的 Antigravity language_server 保守计入 desktop
        state.desktop = true;
      }
    }
  }

  return state;
}

const execFileAsync = promisify(execFile);
const RUNNING_CLIENTS_CACHE_TTL_MS = 4000;
let runningClientsMemo = {
  platform: '',
  atMs: 0,
  result: null,
};
let inFlightRunningClientsPromise = null;

export function clearRunningClientsCache() {
  runningClientsMemo = { platform: '', atMs: 0, result: null };
  inFlightRunningClientsPromise = null;
}

const WIN_WMI_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  "Get-CimInstance Win32_Process -Filter \"Name LIKE 'language_server%' OR Name LIKE 'agentapi%'\" | Select-Object Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
];

function parseWmiProcessRows(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr.map((row) => ({
    name: String(row?.Name || ''),
    exe: String(row?.ExecutablePath || ''),
    cmd: String(row?.CommandLine || ''),
  }));
}

function parseTasklistCsvRows(csv) {
  const rows = [];
  for (const line of String(csv || '').split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)"/);
    if (m && m[1]) {
      rows.push({ name: m[1], exe: '', cmd: '' });
    }
  }
  return rows;
}

function mergeTasklistWithWmiRows(taskRows, detailedLsRows) {
  if (!Array.isArray(detailedLsRows) || detailedLsRows.length === 0) return taskRows;
  const nonLsRows = taskRows.filter((r) => {
    const n = normalizeProcName(r.name, '');
    return !(n.startsWith('language_server') || n === 'agentapi' || n.startsWith('agentapi-'));
  });
  return [...nonLsRows, ...detailedLsRows];
}

function needsLsDisambiguation(taskRows) {
  return taskRows.some((r) => {
    const n = normalizeProcName(r.name, '');
    return n.startsWith('language_server') || n === 'agentapi' || n.startsWith('agentapi-');
  });
}

function enumerateWindowsWmiDisambiguation() {
  const raw = execFileSync('powershell.exe', WIN_WMI_ARGS, {
    encoding: 'utf8',
    timeout: 3500,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return parseWmiProcessRows(raw);
}

async function enumerateWindowsWmiDisambiguationAsync() {
  const { stdout } = await execFileAsync('powershell.exe', WIN_WMI_ARGS, {
    encoding: 'utf8',
    timeout: 3500,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return parseWmiProcessRows(stdout);
}

function enumerateWindowsProcesses() {
  let taskRows = null;
  try {
    const csv = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      timeout: 2500,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    taskRows = parseTasklistCsvRows(csv);
  } catch (taskErr) {
    if (taskErr?.code !== 'ENOENT') {
      throw taskErr;
    }
  }

  if (taskRows !== null) {
    if (!needsLsDisambiguation(taskRows)) {
      return taskRows;
    }
    try {
      return mergeTasklistWithWmiRows(taskRows, enumerateWindowsWmiDisambiguation());
    } catch {
      // WMI 受阻时回退保留 tasklist 主进程快照（language_server 保守计入 desktop）
    }
    return taskRows;
  }

  // 极端精简环境缺失 tasklist.exe 时回退 PowerShell
  const raw = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress',
    ],
    {
      encoding: 'utf8',
      timeout: 4500,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }
  );
  return parseWmiProcessRows(raw);
}

async function enumerateWindowsProcessesAsync() {
  let taskRows = null;
  try {
    const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      timeout: 2500,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    taskRows = parseTasklistCsvRows(stdout);
  } catch (taskErr) {
    if (taskErr?.code !== 'ENOENT') {
      throw taskErr;
    }
  }

  if (taskRows !== null) {
    if (!needsLsDisambiguation(taskRows)) {
      return taskRows;
    }
    try {
      return mergeTasklistWithWmiRows(taskRows, await enumerateWindowsWmiDisambiguationAsync());
    } catch {
      // WMI 受阻时回退保留 tasklist 主进程快照
    }
    return taskRows;
  }

  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress',
    ],
    {
      encoding: 'utf8',
      timeout: 4500,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    }
  );
  return parseWmiProcessRows(stdout);
}

function parsePosixPsRows(raw) {
  const rows = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.search(/\s/);
    if (spaceIdx < 0) {
      rows.push({ name: basename(trimmed), exe: trimmed, cmd: trimmed });
    } else {
      const comm = trimmed.slice(0, spaceIdx).trim();
      const args = trimmed.slice(spaceIdx + 1).trim();
      rows.push({ name: basename(comm), exe: comm, cmd: args });
    }
  }
  return rows;
}

function enumeratePosixPsProcesses() {
  const raw = execFileSync('ps', ['-axo', 'comm=,args='], {
    encoding: 'utf8',
    timeout: 3500,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return parsePosixPsRows(raw);
}

async function enumeratePosixPsProcessesAsync() {
  const { stdout } = await execFileAsync('ps', ['-axo', 'comm=,args='], {
    encoding: 'utf8',
    timeout: 3500,
    maxBuffer: 8 * 1024 * 1024,
  });
  return parsePosixPsRows(stdout);
}

function enumerateLinuxProcProcesses() {
  const entries = readdirSync('/proc');
  const rows = [];
  for (const pid of entries) {
    if (!/^\d+$/.test(pid)) continue;
    let exe = '';
    let cmd = '';
    try {
      exe = readlinkSync(`/proc/${pid}/exe`);
    } catch {
      // 权限不足时忽略 exe
    }
    try {
      const rawCmd = readFileSync(`/proc/${pid}/cmdline`);
      cmd = rawCmd.toString('utf8').replace(/\0+/g, ' ').trim();
    } catch {
      // 进程可能已退出
    }
    if (!exe && !cmd) continue;
    const firstArg = cmd.split(/\s+/)[0] || '';
    const name = basename(exe || firstArg);
    rows.push({ name, exe, cmd });
  }
  return rows;
}

/**
 * 探测当前本机正在运行的 Antigravity 客户端。
 * 当进程枚举失败时返回 `checked: false`，由清理器采用安全失败策略拒绝删除。
 *
 * @param {{
 *   platform?: string,
 *   processListProvider?: () => Array<{ name?: string, exe?: string, cmd?: string }>,
 *   runningClientsOverride?: { desktop?: boolean, cli?: boolean, ide_legacy?: boolean, checked?: boolean },
 * }} [options={}]
 * @returns {{ desktop: boolean, cli: boolean, ide_legacy: boolean, checked: boolean, error?: string }}
 */
export function detectRunningClients(options = {}) {
  if (options?.runningClientsOverride && typeof options.runningClientsOverride === 'object') {
    return {
      desktop: Boolean(options.runningClientsOverride.desktop),
      cli: Boolean(options.runningClientsOverride.cli),
      ide_legacy: Boolean(options.runningClientsOverride.ide_legacy),
      checked: options.runningClientsOverride.checked !== false,
      ...(options.runningClientsOverride.error ? { error: String(options.runningClientsOverride.error) } : {}),
    };
  }

  const hasCustomProvider = typeof options?.processListProvider === 'function';
  const platform = options?.platform || process.platform;
  const nowMs = Date.now();
  if (
    !hasCustomProvider &&
    !options?.forceRefresh &&
    runningClientsMemo.result &&
    runningClientsMemo.platform === platform &&
    nowMs - runningClientsMemo.atMs >= 0 &&
    nowMs - runningClientsMemo.atMs < RUNNING_CLIENTS_CACHE_TTL_MS
  ) {
    return { ...runningClientsMemo.result };
  }

  try {
    let list;
    if (hasCustomProvider) {
      list = options.processListProvider();
    } else if (platform === 'win32') {
      list = enumerateWindowsProcesses();
    } else if (platform === 'linux') {
      try {
        list = enumerateLinuxProcProcesses();
      } catch {
        list = enumeratePosixPsProcesses();
      }
    } else {
      list = enumeratePosixPsProcesses();
    }
    const classified = classifyRunningClientsFromProcesses(list);
    const out = { ...classified, checked: true };
    if (!hasCustomProvider) {
      runningClientsMemo = { platform, atMs: Date.now(), result: out };
    }
    return { ...out };
  } catch (err) {
    const failedOut = {
      desktop: false,
      cli: false,
      ide_legacy: false,
      checked: false,
      error: err?.message || 'process_enumeration_failed',
    };
    if (!hasCustomProvider) {
      runningClientsMemo = { platform, atMs: Date.now(), result: failedOut };
    }
    return { ...failedOut };
  }
}

export async function detectRunningClientsAsync(options = {}) {
  if (options?.runningClientsOverride && typeof options.runningClientsOverride === 'object') {
    return detectRunningClients(options);
  }
  const hasCustomProvider = typeof options?.processListProvider === 'function';
  if (hasCustomProvider) {
    return detectRunningClients(options);
  }
  const platform = options?.platform || process.platform;
  const nowMs = Date.now();
  if (
    !options?.forceRefresh &&
    runningClientsMemo.result &&
    runningClientsMemo.platform === platform &&
    nowMs - runningClientsMemo.atMs >= 0 &&
    nowMs - runningClientsMemo.atMs < RUNNING_CLIENTS_CACHE_TTL_MS
  ) {
    return { ...runningClientsMemo.result };
  }
  if (!options?.forceRefresh && inFlightRunningClientsPromise) {
    const res = await inFlightRunningClientsPromise;
    return { ...res };
  }

  const runPromise = (async () => {
    try {
      let list;
      if (platform === 'win32') {
        list = await enumerateWindowsProcessesAsync();
      } else if (platform === 'linux') {
        try {
          list = enumerateLinuxProcProcesses();
        } catch {
          list = await enumeratePosixPsProcessesAsync();
        }
      } else {
        list = await enumeratePosixPsProcessesAsync();
      }
      const classified = classifyRunningClientsFromProcesses(list);
      const out = { ...classified, checked: true };
      runningClientsMemo = { platform, atMs: Date.now(), result: out };
      return out;
    } catch (err) {
      const failedOut = {
        desktop: false,
        cli: false,
        ide_legacy: false,
        checked: false,
        error: err?.message || 'process_enumeration_failed',
      };
      runningClientsMemo = { platform, atMs: Date.now(), result: failedOut };
      return failedOut;
    }
  })();

  if (!options?.forceRefresh) {
    inFlightRunningClientsPromise = runPromise.finally(() => {
      if (inFlightRunningClientsPromise === runPromise) {
        inFlightRunningClientsPromise = null;
      }
    });
  }
  const out = await runPromise;
  return { ...out };
}

// ---------------------------------------------------------------------------
// 存储产物、索引与迁移归档保护采集
// ---------------------------------------------------------------------------

/**
 * 收集单个客户端存储目录中的全部实体产物 UUID（`.db` / `.pb` / `brain/` / `annotations/` / `presence/`）。
 * 当传入 `excludeProtectedBrainOnlyIds` 时，仅剩受迁移归档保护 `brain/<id>` 媒体目录而无其他实体产物的条目
 * 不计入存活会话实体（该目录仅作为迁入端历史图片的静态附件池保留）。
 *
 * @param {string} clientRoot
 * @param {{ excludeProtectedBrainOnlyIds?: Set<string> | null }} [options={}]
 * @returns {Set<string>}
 */
export function collectStoreArtifactIds(clientRoot, { excludeProtectedBrainOnlyIds = null } = {}) {
  const ids = new Set();
  if (!clientRoot || !existsSync(clientRoot)) return ids;

  const convCheck = resolveNoFollowPath(clientRoot, ['conversations']);
  if (convCheck.ok && convCheck.exists && convCheck.stat?.isDirectory()) {
    try {
      for (const name of readdirSync(convCheck.path)) {
        const lower = name.toLowerCase();
        if (lower.endsWith('.db')) {
          const id = normalizeSessionUuid(lower.slice(0, -3));
          if (id) ids.add(id);
        } else if (lower.endsWith('.pb')) {
          const id = normalizeSessionUuid(lower.slice(0, -3));
          if (id) ids.add(id);
        }
      }
    } catch {
      // 忽略目录读取错误
    }
  }

  const annCheck = resolveNoFollowPath(clientRoot, ['annotations']);
  if (annCheck.ok && annCheck.exists && annCheck.stat?.isDirectory()) {
    try {
      for (const name of readdirSync(annCheck.path)) {
        const lower = name.toLowerCase();
        if (lower.endsWith('.pbtxt')) {
          const id = normalizeSessionUuid(lower.slice(0, -6));
          if (id) ids.add(id);
        }
      }
    } catch {
      // 忽略目录读取错误
    }
  }

  const presCheck = resolveNoFollowPath(clientRoot, ['presence']);
  if (presCheck.ok && presCheck.exists && presCheck.stat?.isDirectory()) {
    try {
      for (const name of readdirSync(presCheck.path)) {
        const lower = name.toLowerCase();
        if (lower.endsWith('.lock')) {
          const id = normalizeSessionUuid(lower.slice(0, -5));
          if (id) ids.add(id);
        }
      }
    } catch {
      // 忽略目录读取错误
    }
  }

  const brainCheck = resolveNoFollowPath(clientRoot, ['brain']);
  if (brainCheck.ok && brainCheck.exists && brainCheck.stat?.isDirectory()) {
    try {
      for (const name of readdirSync(brainCheck.path)) {
        const id = normalizeSessionUuid(name);
        if (!id) continue;
        if (excludeProtectedBrainOnlyIds?.has(id) && !ids.has(id)) {
          continue;
        }
        ids.add(id);
      }
    } catch {
      // 忽略目录读取错误
    }
  }

  return ids;
}

/**
 * 收集单个客户端存储目录中的全部索引 UUID（`conversation_summaries.db`、`.pb` 摘要索引及 `cache/*.json`）。
 *
 * @param {string} clientRoot
 * @param {typeof SESSION_CLIENT_DEFS[number]} clientDef
 * @returns {Set<string>}
 */
export function collectStoreIndexIds(clientRoot, clientDef) {
  const ids = new Set();
  if (!clientRoot || !existsSync(clientRoot)) return ids;

  // 1. conversation_summaries.db
  const sumCheck = resolveNoFollowFile(clientRoot, ['conversation_summaries.db']);
  if (sumCheck.ok && sumCheck.exists) {
    try {
      withReadOnlySqliteDb(sumCheck.path, (db) => {
        try {
          const rows = db.prepare('SELECT conversation_id FROM conversation_summaries').all();
          for (const row of rows || []) {
            const id = normalizeSessionUuid(row?.conversation_id);
            if (id) ids.add(id);
          }
        } catch {
          // 忽略缺表
        }
      });
    } catch {
      // 忽略只读异常
    }
  }

  // 2. Protobuf 摘要索引（agyhub / jetbox）
  const protoFiles = clientDef?.summaryProtoFile ? [clientDef.summaryProtoFile] : [];
  for (const pf of protoFiles) {
    const pfCheck = resolveNoFollowFile(clientRoot, [pf]);
    if (pfCheck.ok && pfCheck.exists) {
      try {
        const raw = readFileSync(pfCheck.path);
        const parsed = parseSummaryProtoIndexIds(raw, {
          isDesktop: Boolean(clientDef?.isDesktopProto),
          strict: false,
        });
        for (const id of parsed) ids.add(id);
      } catch {
        // 忽略读取异常
      }
    }
  }

  // 3. cache/conversation_metadata.json
  const metaCheck = resolveNoFollowFile(clientRoot, ['cache', 'conversation_metadata.json']);
  if (metaCheck.ok && metaCheck.exists) {
    try {
      const parsed = JSON.parse(readFileSync(metaCheck.path, 'utf8'));
      const convMap = parsed && typeof parsed === 'object' ? parsed.conversations : null;
      if (convMap && typeof convMap === 'object') {
        for (const key of Object.keys(convMap)) {
          const id = normalizeSessionUuid(key);
          if (id) ids.add(id);
        }
      }
    } catch {
      // 忽略 JSON 损坏
    }
  }

  // 4. cache/last_conversations.json
  const lastCheck = resolveNoFollowFile(clientRoot, ['cache', 'last_conversations.json']);
  if (lastCheck.ok && lastCheck.exists) {
    try {
      const parsed = JSON.parse(readFileSync(lastCheck.path, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const val of Object.values(parsed)) {
          const id = normalizeSessionUuid(val);
          if (id) ids.add(id);
        }
      }
    } catch {
      // 忽略 JSON 损坏
    }
  }

  return ids;
}

/**
 * 收集单个客户端存储目录中的全部存活 UUID（实体产物 ∪ 索引条目）。
 *
 * @param {string} clientRoot
 * @param {typeof SESSION_CLIENT_DEFS[number]} clientDef
 * @param {{ excludeProtectedBrainOnlyIds?: Set<string> | null }} [options={}]
 * @returns {Set<string>}
 */
export function collectStoreLiveIds(clientRoot, clientDef, options = {}) {
  const ids = collectStoreArtifactIds(clientRoot, options);
  for (const id of collectStoreIndexIds(clientRoot, clientDef)) {
    ids.add(id);
  }
  return ids;
}

/**
 * 判断 `geminiDir` 下是否存在至少一个本机客户端存储根目录（防止目录未挂载时误判全量已删）。
 *
 * @param {{ geminiDir?: string }} [options={}]
 * @returns {boolean}
 */
export function hasAnyClientStoreDir(options = {}) {
  const geminiDir = resolveGeminiDir(options.geminiDir);
  return SESSION_CLIENT_DEFS.some((def) => existsSync(join(geminiDir, def.dirName)));
}

/**
 * 汇总本机全部三端存储中的存活会话 UUID（用于外部 `app_storage.json` 清理和账本脱敏安全门槛）。
 * 默认排除「仅剩跨端迁移归档保护 `brain/<id>` 媒体目录而无任何会话文件/索引」的已迁出源 ID。
 *
 * @param {{ geminiDir?: string, backupDir?: string }} [options={}]
 * @returns {Set<string>}
 */
export function collectAllStoresLiveIds(options = {}) {
  const geminiDir = resolveGeminiDir(options.geminiDir);
  const backupDir = resolveMigrationBackupRoot(options.backupDir, options.geminiDir);
  const excludeIdsByClient = options.excludeIdsByClient instanceof Map ? options.excludeIdsByClient : null;
  const all = new Set();
  for (const def of SESSION_CLIENT_DEFS) {
    const root = join(geminiDir, def.dirName);
    if (!existsSync(root)) continue;
    const protectedMap = findProtectedMigrationArchives({
      backupDir,
      geminiDir: options.geminiDir,
      clientId: def.id,
      clientRoot: root,
    });
    const protectedIds = protectedMap.size > 0 ? new Set(protectedMap.keys()) : null;
    const clientExcluded = excludeIdsByClient?.get(def.id) || null;
    for (const id of collectStoreLiveIds(root, def, { excludeProtectedBrainOnlyIds: protectedIds })) {
      if (clientExcluded && clientExcluded.has(id)) continue;
      all.add(id);
    }
  }
  return all;
}

/**
 * 检测某个客户端中受「跨端完整迁移」归档保护的源会话：
 * 当 `DATA_DIR/session-migration-backups/archived-sources/<clientId>/<uuid>_*.db` 存在，
 * 且该客户端 `conversations/<uuid>.db` 已被移走时，说明该会话的 `brain/<uuid>/` 可能仍被迁入后的目标会话
 * 通过绝对图片路径引用，清理时需保护提醒。
 *
 * @param {{ backupDir?: string, geminiDir?: string, clientId: string, clientRoot: string }} params
 * @returns {Map<string, { archivePath: string, brainDir: string, hasBrain: boolean }>}
 */
export function findProtectedMigrationArchives({ backupDir = '', geminiDir = '', clientId, clientRoot }) {
  const protectedMap = new Map();
  const def = getSessionClientDef(clientId);
  if (!def || !clientRoot) return protectedMap;
  const archiveDir = join(resolveMigrationBackupRoot(backupDir, geminiDir), 'archived-sources', def.id);
  if (!existsSync(archiveDir)) return protectedMap;

  let entries = [];
  try {
    entries = readdirSync(archiveDir);
  } catch {
    return protectedMap;
  }

  for (const name of entries) {
    const lowerName = name.toLowerCase();
    let cid = '';
    if (lowerName.endsWith('.db')) {
      const match = name.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_/i);
      if (match) cid = match[1].toLowerCase();
    } else if (lowerName.endsWith('.protected.json')) {
      const match = name.match(
        /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.protected\.json$/i
      );
      if (match) cid = match[1].toLowerCase();
    }
    if (!cid || protectedMap.has(cid)) continue;
    const liveDbPath = join(clientRoot, 'conversations', `${cid}.db`);
    if (existsSync(liveDbPath)) continue;
    const brainDir = join(clientRoot, 'brain', cid);
    protectedMap.set(cid, {
      archivePath: join(archiveDir, name),
      brainDir,
      hasBrain: existsSync(brainDir),
    });
  }
  return protectedMap;
}

/**
 * 在跨端 `move` 迁移提交后写入源会话与目标新会话的保护关联标记，以便目标会话后续永久删除时同步清除源端归档明文与孤立附件。
 *
 * @param {{
 *   backupDir?: string,
 *   geminiDir?: string,
 *   sourceClientId: string,
 *   sourceSessionId: string,
 *   targetClientId: string,
 *   targetSessionId: string,
 * }} params
 */
export function recordMigrationProtectionLink({
  backupDir = '',
  geminiDir = '',
  sourceClientId,
  sourceSessionId,
  targetClientId,
  targetSessionId,
}) {
  const srcDef = getSessionClientDef(sourceClientId);
  const dstDef = getSessionClientDef(targetClientId);
  const srcCid = normalizeSessionUuid(sourceSessionId);
  const dstCid = normalizeSessionUuid(targetSessionId);
  if (!srcDef || !dstDef || !srcCid || !dstCid) return false;

  const archiveDir = join(resolveMigrationBackupRoot(backupDir, geminiDir), 'archived-sources', srcDef.id);
  if (!existsSync(archiveDir)) return false;
  const markerCheck = resolveNoFollowPath(archiveDir, [`${srcCid}.protected.json`]);
  if (!markerCheck.ok) return false;
  if (markerCheck.exists && markerCheck.stat && !markerCheck.stat.isFile()) return false;
  try {
    writeFileSync(
      markerCheck.path,
      `${JSON.stringify({
        cascadeId: srcCid,
        sourceClient: srcDef.id,
        targetClient: dstDef.id,
        targetCascadeId: dstCid,
        migratedAtMs: Date.now(),
      })}\n`,
      'utf8'
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 当目标客户端删除已迁入会话时，反向查找其关联的源端归档记录，彻底清除源端 `archived-sources/<src>/<srcCid>_*.db`
 * 明文备份与孤立的 `brain/<srcCid>` 附件目录（若源客户端未在运行），杜绝隐私明文与孤儿文件残留。
 *
 * @param {{
 *   backupDir?: string,
 *   geminiDir?: string,
 *   deletedByClient: Map<string, Set<string>> | Record<string, Iterable<string>>,
 *   runningClients?: { desktop?: boolean, cli?: boolean, ide_legacy?: boolean, checked?: boolean } | null,
 *   allLiveIdsAfterDelete?: Set<string> | null,
 * }} params
 */
export function cleanupLinkedMigrationSourcesForDeletedTargets({
  backupDir = '',
  geminiDir = '',
  deletedByClient,
  runningClients = null,
  allLiveIdsAfterDelete = null,
}) {
  const resolvedGemini = resolveGeminiDir(geminiDir);
  const resolvedBackup = resolveMigrationBackupRoot(backupDir, geminiDir);
  const targetLookup = new Map();
  if (deletedByClient instanceof Map) {
    for (const [clientId, ids] of deletedByClient.entries()) {
      const set = new Set();
      for (const id of ids || []) {
        const norm = normalizeSessionUuid(id);
        if (norm) set.add(norm);
      }
      if (set.size > 0) targetLookup.set(clientId, set);
    }
  } else if (deletedByClient && typeof deletedByClient === 'object') {
    for (const [clientId, ids] of Object.entries(deletedByClient)) {
      const set = new Set();
      for (const id of ids || []) {
        const norm = normalizeSessionUuid(id);
        if (norm) set.add(norm);
      }
      if (set.size > 0) targetLookup.set(clientId, set);
    }
  }
  if (targetLookup.size === 0) {
    return { removedArchiveFiles: 0, removedSourceBrains: 0 };
  }

  let removedArchiveFiles = 0;
  let removedSourceBrains = 0;

  for (const srcDef of SESSION_CLIENT_DEFS) {
    const archiveDir = join(resolvedBackup, 'archived-sources', srcDef.id);
    if (!existsSync(archiveDir)) continue;
    let entries = [];
    try {
      entries = readdirSync(archiveDir);
    } catch {
      continue;
    }

    const purgeSrcCids = new Set();
    for (const name of entries) {
      if (!name.toLowerCase().endsWith('.protected.json')) continue;
      const markerCheck = resolveNoFollowFile(archiveDir, [name]);
      if (!markerCheck.ok || !markerCheck.exists) continue;
      try {
        const parsed = JSON.parse(readFileSync(markerCheck.path, 'utf8'));
        const srcCid = normalizeSessionUuid(parsed?.cascadeId || name.slice(0, -'.protected.json'.length));
        const dstClient = String(parsed?.targetClient || '').trim().toLowerCase();
        const dstCid = normalizeSessionUuid(parsed?.targetCascadeId);
        if (srcCid && dstClient && dstCid && targetLookup.get(dstClient)?.has(dstCid)) {
          purgeSrcCids.add(srcCid);
        }
      } catch {
        // 忽略损坏的标记文件
      }
    }

    if (purgeSrcCids.size === 0) continue;

    const cleanRes = cleanupProtectedMigrationArchives({
      backupDir: resolvedBackup,
      geminiDir: resolvedGemini,
      clientId: srcDef.id,
      sessionIds: purgeSrcCids,
      keepProtectionMarker: false,
    });
    removedArchiveFiles += cleanRes.removedFiles;

    const srcRunning = Boolean(runningClients && (!runningClients.checked || runningClients[srcDef.id]));
    if (!srcRunning) {
      const srcRoot = join(resolvedGemini, srcDef.dirName);
      for (const srcCid of purgeSrcCids) {
        if (allLiveIdsAfterDelete?.has(srcCid)) continue;
        const liveDbCheck = resolveNoFollowFile(srcRoot, ['conversations', `${srcCid}.db`]);
        if (!liveDbCheck.ok || liveDbCheck.exists) continue;
        const brainCheck = resolveNoFollowPath(srcRoot, ['brain', srcCid]);
        if (brainCheck.ok && brainCheck.exists) {
          try {
            rmSync(brainCheck.path, { recursive: true, force: true });
            removedSourceBrains += 1;
          } catch {
            // 忽略源端只读移除异常
          }
        }
      }
    }
  }

  return { removedArchiveFiles, removedSourceBrains };
}

/**
 * 补扫 `archived-sources/*` 中源会话与迁入目标会话均已不存在的陈旧明文 `.db` 备份。
 *
 * @param {{ backupDir?: string, geminiDir?: string, allLiveIds: Set<string> }} params
 */
export function sweepOrphanedMigrationArchiveDbs({ backupDir = '', geminiDir = '', allLiveIds }) {
  if (!(allLiveIds instanceof Set)) return { removedFiles: 0 };
  const resolvedBackup = resolveMigrationBackupRoot(backupDir, geminiDir);
  let removedFiles = 0;

  for (const srcDef of SESSION_CLIENT_DEFS) {
    const archiveDir = join(resolvedBackup, 'archived-sources', srcDef.id);
    if (!existsSync(archiveDir)) continue;
    let entries = [];
    try {
      entries = readdirSync(archiveDir);
    } catch {
      continue;
    }

    const markerTargetBySrc = new Map();
    for (const name of entries) {
      if (!name.toLowerCase().endsWith('.protected.json')) continue;
      const check = resolveNoFollowFile(archiveDir, [name]);
      if (!check.ok || !check.exists) continue;
      try {
        const parsed = JSON.parse(readFileSync(check.path, 'utf8'));
        const srcCid = normalizeSessionUuid(parsed?.cascadeId || name.slice(0, -'.protected.json'.length));
        const dstCid = normalizeSessionUuid(parsed?.targetCascadeId);
        if (srcCid) markerTargetBySrc.set(srcCid, dstCid || '');
      } catch {
        // ignore
      }
    }

    const deadSrcCids = new Set();
    for (const name of entries) {
      const dbMatch = name.match(
        /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_.*\.db$/i
      );
      if (!dbMatch) continue;
      const srcCid = dbMatch[1].toLowerCase();
      if (allLiveIds.has(srcCid)) continue;
      const linkedTarget = markerTargetBySrc.get(srcCid) || '';
      if (linkedTarget && allLiveIds.has(linkedTarget)) continue;
      if (!markerTargetBySrc.has(srcCid)) continue;
      deadSrcCids.add(srcCid);
    }

    if (deadSrcCids.size > 0) {
      const res = cleanupProtectedMigrationArchives({
        backupDir: resolvedBackup,
        geminiDir,
        clientId: srcDef.id,
        sessionIds: deadSrcCids,
        keepProtectionMarker: false,
      });
      removedFiles += res.removedFiles;
    }
  }

  return { removedFiles };
}

/**
 * 在删除受迁移保护的源会话时，清除 `archived-sources/<clientId>/<cid>_*.db` 明文数据库副本：
 * - `keepProtectionMarker === true`：写入不含任何对话明文的 `<cid>.protected.json` 轻量标记，
 *   确保保留下来的 `brain/<cid>` 媒体目录不会被误扫为僵尸会话；
 * - `keepProtectionMarker === false`：连同轻量标记一并彻底移除。
 *
 * @param {{
 *   backupDir?: string,
 *   geminiDir?: string,
 *   clientId: string,
 *   sessionIds: Iterable<string>,
 *   keepProtectionMarker?: boolean,
 * }} params
 */
export function cleanupProtectedMigrationArchives({
  backupDir = '',
  geminiDir = '',
  clientId,
  sessionIds = [],
  keepProtectionMarker = false,
}) {
  const def = getSessionClientDef(clientId);
  if (!def) return { removedFiles: 0 };
  const targetSet = new Set();
  for (const raw of sessionIds || []) {
    const norm = normalizeSessionUuid(raw);
    if (norm) targetSet.add(norm);
  }
  if (targetSet.size === 0) return { removedFiles: 0 };

  const archiveDir = join(resolveMigrationBackupRoot(backupDir, geminiDir), 'archived-sources', def.id);
  if (!existsSync(archiveDir)) return { removedFiles: 0 };

  let entries = [];
  try {
    entries = readdirSync(archiveDir);
  } catch {
    return { removedFiles: 0 };
  }

  let removedFiles = 0;
  const matchedCids = new Set();

  for (const name of entries) {
    const dbMatch = name.match(
      /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_.*\.db(?:-(?:wal|shm|journal))?$/i
    );
    if (dbMatch) {
      const cid = dbMatch[1].toLowerCase();
      if (targetSet.has(cid)) {
        matchedCids.add(cid);
        const check = resolveNoFollowFile(archiveDir, [name]);
        if (check.ok && check.exists) {
          try {
            rmSync(check.path, { force: true });
            removedFiles += 1;
          } catch {
            // 忽略归档清理异常
          }
        }
      }
      continue;
    }

    if (!keepProtectionMarker) {
      const markerMatch = name.match(
        /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.protected\.json$/i
      );
      if (markerMatch && targetSet.has(markerMatch[1].toLowerCase())) {
        const check = resolveNoFollowFile(archiveDir, [name]);
        if (check.ok && check.exists) {
          try {
            rmSync(check.path, { force: true });
            removedFiles += 1;
          } catch {
            // 忽略标记移除异常
          }
        }
      }
    }
  }

  if (keepProtectionMarker && matchedCids.size > 0) {
    for (const cid of matchedCids) {
      const markerCheck = resolveNoFollowPath(archiveDir, [`${cid}.protected.json`]);
      if (markerCheck.ok && !markerCheck.exists) {
        try {
          writeFileSync(
            markerCheck.path,
            `${JSON.stringify({ cascadeId: cid, scrubbedAtMs: Date.now() })}\n`,
            'utf8'
          );
        } catch {
          // 忽略只读目录异常
        }
      }
    }
  }

  return { removedFiles };
}

const DEFAULT_MAX_DIR_WALK_DEPTH = 12;
const DEFAULT_MAX_DIR_WALK_ENTRIES = 20000;

/**
 * 递归统计已校验目录树内所有常规文件的真实磁盘占用字节数：
 * - 使用显式栈迭代，避免深层目录递归爆栈；
 * - 逐项以 `dirent.isSymbolicLink()` + `lstatSync` 双重拦截符号链接与 NTFS 联接点，永不跟随软链；
 * - 对最大深度与最大遍历条目数做安全上界，防止畸形目录树拖死扫描。
 *
 * @param {string} rootDir
 * @param {{ maxDepth?: number, maxEntries?: number }} [options={}]
 * @returns {{ sizeBytes: number, truncated: boolean }}
 */
export function sumVerifiedDirTreeBytes(
  rootDir,
  { maxDepth = DEFAULT_MAX_DIR_WALK_DEPTH, maxEntries = DEFAULT_MAX_DIR_WALK_ENTRIES } = {}
) {
  const cleanRoot = String(rootDir || '').trim();
  if (!cleanRoot) return { sizeBytes: 0, truncated: false };
  try {
    const rootStat = lstatSync(cleanRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return { sizeBytes: 0, truncated: false };
    }
  } catch {
    return { sizeBytes: 0, truncated: false };
  }

  const depthLimit = Math.max(0, Number(maxDepth) || 0);
  const entryLimit = Math.max(1, Number(maxEntries) || DEFAULT_MAX_DIR_WALK_ENTRIES);
  const stack = [{ dirPath: cleanRoot, depth: 0 }];
  let sizeBytes = 0;
  let visitedEntries = 0;
  let truncated = false;

  while (stack.length > 0) {
    const { dirPath, depth } = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (visitedEntries >= entryLimit) {
        truncated = true;
        return { sizeBytes, truncated };
      }
      visitedEntries += 1;
      if (!entry || entry.isSymbolicLink()) continue;
      const name = String(entry.name || '');
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
        continue;
      }
      const childPath = join(dirPath, name);
      let st = null;
      try {
        st = lstatSync(childPath);
      } catch {
        continue;
      }
      if (!st || st.isSymbolicLink()) continue;
      if (st.isFile()) {
        sizeBytes += Number(st.size || 0);
      } else if (st.isDirectory()) {
        if (depth < depthLimit) {
          stack.push({ dirPath: childPath, depth: depth + 1 });
        } else {
          truncated = true;
        }
      }
    }
  }

  return { sizeBytes, truncated };
}
