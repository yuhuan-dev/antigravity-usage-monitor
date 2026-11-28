/**
 * @fileoverview 本地 Antigravity (Desktop / IDE / CLI) SQLite + WAL 会话摘要、轨迹直读与标题解析器。
 *
 * 核心能力：
 * 1. 解析 `<product>/annotations/<cascadeId>.pbtxt` 中的真实会话标题（兼容 UTF-8 直出与八进制/十六进制字节转义）；
 * 2. 通过 Node 22.5+ 内置 `node:sqlite`（只读 + `SQLITE_BUSY` 退避重试 + WAL `mtime+size` 复合签名缓存）扫描
 *    `<product>/conversation_summaries.db`（含 `raw_summary` 与 `conversation_parents` 表），还原会话摘要与旁路提问父子映射；
 * 3. 只读解码 `<product>/conversations/<cascadeId>.db`，自动过滤分叉/旁路提问克隆自父会话的步骤与 `gen_metadata`
 *    （`originCid !== cascadeId`），并对 `step_payload` 做按需列投影（仅读取 `USER_INPUT` 轮次提问、`INVOKE_SUBAGENT`
 *    及运行态末尾步骤，O(1) 跳过大体积工具输出页），完整保留耗时、TTFT、轮次导轨与 10 通道上下文构成。
 */

import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import { basename, join } from 'node:path';
import { extractShortPromptTitle } from '../shared/prompt-clean.mjs';
import {
  decodeWorkspaceFileUriToPath,
  parseWorkspaceUrisColumn,
} from '../shared/workspace-uri.mjs';
import { parseIsoMs } from '../trajectory-metrics.mjs';
import { ANNOTATION_DIRS, PRODUCT_DATA_ROOTS, localSummaryMemo } from './config.mjs';
import {
  SQLITE_IN_CHUNK_SIZE,
  computeSqliteWalSig,
  getNodeSqliteDatabaseSync,
  hasBuiltinNodeSqlite,
  isSqliteDbReadyForRead,
  normalizeSqliteIsoTime,
  withReadOnlySqliteDb,
} from './sqlite-client.mjs';
import {
  decodeProtoDurationSlice,
  decodeProtoMapStringEntry,
  decodeProtoTimestampSlice,
  readProtoString,
  readProtoVarint,
  readSubEnd,
  skipProtoField,
  toUint8Array,
  unescapePbtxtString,
} from './proto-wire.mjs';

export {
  computeSqliteWalSig,
  getNodeSqliteDatabaseSync,
  hasBuiltinNodeSqlite,
  isSqliteDbReadyForRead,
  withReadOnlySqliteDb,
};

const UUID_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 从 `annotations/<cascadeId>.pbtxt` 文本内容中提取顶层 `title` 字段。
 *
 * @param {string} rawText
 * @returns {string}
 */
export function parseAnnotationPbtxtTitle(rawText) {
  if (typeof rawText !== 'string' || !rawText) return '';
  const dq = rawText.match(/(?:^|\r?\n)\s*title\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (dq) {
    return unescapePbtxtString(dq[1]).trim();
  }
  const sq = rawText.match(/(?:^|\r?\n)\s*title\s*:\s*'((?:\\.|[^'\\])*)'/);
  if (sq) {
    return unescapePbtxtString(sq[1]).trim();
  }
  return '';
}

/**
 * 按会话 ID 在各产品目录的 `annotations/<cascadeId>.pbtxt` 中查找标题。
 *
 * @param {string} cascadeId
 * @param {string[]} [annotationDirs=ANNOTATION_DIRS]
 * @returns {string}
 */
export function readAnnotationTitleForCascade(cascadeId, annotationDirs = ANNOTATION_DIRS) {
  const normId = String(cascadeId || '').trim().toLowerCase();
  if (!normId) return '';
  const dirs = Array.isArray(annotationDirs) ? annotationDirs : [];
  for (const dir of dirs) {
    if (!dir) continue;
    const filePath = join(dir, `${normId}.pbtxt`);
    if (!existsSync(filePath)) continue;
    try {
      const title = parseAnnotationPbtxtTitle(readFileSync(filePath, 'utf8'));
      if (title) return title;
    } catch {
      // 忽略单文件读取失败
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// 零依赖轻量 Protobuf Wire 解码器（按需提取指标字段，O(1) 跳过大体积载荷）
// ---------------------------------------------------------------------------

const PROTO_STATIC_MODELS = Object.freeze({
  235: 'MODEL_CHAT_20706',
  246: 'MODEL_GOOGLE_GEMINI_2_5_PRO',
  269: 'MODEL_CHAT_23310',
  281: 'MODEL_CLAUDE_4_SONNET',
  282: 'MODEL_CLAUDE_4_SONNET_THINKING',
  290: 'MODEL_CLAUDE_4_OPUS',
  291: 'MODEL_CLAUDE_4_OPUS_THINKING',
  312: 'MODEL_GOOGLE_GEMINI_2_5_FLASH',
  313: 'MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING',
  327: 'MODEL_GOOGLE_GEMINI_FOR_GOOGLE_2_5_PRO',
  329: 'MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING_TOOLS',
  330: 'MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE',
  332: 'MODEL_GOOGLE_GEMINI_2_5_FLASH_IMAGE_PREVIEW',
  333: 'MODEL_CLAUDE_4_5_SONNET',
  334: 'MODEL_CLAUDE_4_5_SONNET_THINKING',
  340: 'MODEL_CLAUDE_4_5_HAIKU',
  341: 'MODEL_CLAUDE_4_5_HAIKU_THINKING',
  342: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
});

const PROTO_API_PROVIDERS = Object.freeze({
  1: 'API_PROVIDER_INTERNAL',
  3: 'API_PROVIDER_GOOGLE_VERTEX',
  24: 'API_PROVIDER_GOOGLE_GEMINI',
  26: 'API_PROVIDER_ANTHROPIC_VERTEX',
  30: 'API_PROVIDER_GOOGLE_EVERGREEN',
  31: 'API_PROVIDER_OPENAI_VERTEX',
  32: 'API_PROVIDER_OPENAI_RESPONSES_VERTEX',
});

const PROTO_STEP_TYPES = Object.freeze({
  5: 'CORTEX_STEP_TYPE_CODE_ACTION',
  7: 'CORTEX_STEP_TYPE_GREP_SEARCH',
  8: 'CORTEX_STEP_TYPE_VIEW_FILE',
  9: 'CORTEX_STEP_TYPE_LIST_DIRECTORY',
  14: 'CORTEX_STEP_TYPE_USER_INPUT',
  15: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
  17: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
  21: 'CORTEX_STEP_TYPE_RUN_COMMAND',
  23: 'CORTEX_STEP_TYPE_CHECKPOINT',
  25: 'CORTEX_STEP_TYPE_FIND',
  28: 'CORTEX_STEP_TYPE_COMMAND_STATUS',
  31: 'CORTEX_STEP_TYPE_READ_URL_CONTENT',
  33: 'CORTEX_STEP_TYPE_SEARCH_WEB',
  38: 'CORTEX_STEP_TYPE_MCP_TOOL',
  51: 'CORTEX_STEP_TYPE_LIST_RESOURCES',
  52: 'CORTEX_STEP_TYPE_READ_RESOURCE',
  81: 'CORTEX_STEP_TYPE_TASK_BOUNDARY',
  82: 'CORTEX_STEP_TYPE_NOTIFY_USER',
  85: 'CORTEX_STEP_TYPE_BROWSER_SUBAGENT',
  90: 'CORTEX_STEP_TYPE_EPHEMERAL_MESSAGE',
  91: 'CORTEX_STEP_TYPE_GENERATE_IMAGE',
  100: 'CORTEX_STEP_TYPE_SEND_COMMAND_INPUT',
  101: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
  127: 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT',
  132: 'CORTEX_STEP_TYPE_GENERIC',
  138: 'CORTEX_STEP_TYPE_ASK_QUESTION',
});

const PROTO_STEP_STATUSES = Object.freeze({
  1: 'CORTEX_STEP_STATUS_PENDING',
  2: 'CORTEX_STEP_STATUS_RUNNING',
  3: 'CORTEX_STEP_STATUS_DONE',
  4: 'CORTEX_STEP_STATUS_INVALID',
  5: 'CORTEX_STEP_STATUS_CLEARED',
  6: 'CORTEX_STEP_STATUS_CANCELED',
  7: 'CORTEX_STEP_STATUS_ERROR',
  8: 'CORTEX_STEP_STATUS_GENERATING',
  9: 'CORTEX_STEP_STATUS_WAITING',
  11: 'CORTEX_STEP_STATUS_QUEUED',
  12: 'CORTEX_STEP_STATUS_INTERRUPTED',
});

const ACTIVE_TASK_STEP_STATUS_NUMS = new Set([1, 2, 8, 9, 11]);
const ACTIVE_TASK_STATUS_SQL = '1, 2, 8, 9, 11';

const PROTO_RUN_STATUSES = Object.freeze({
  1: 'CASCADE_RUN_STATUS_IDLE',
  2: 'CASCADE_RUN_STATUS_RUNNING',
  3: 'CASCADE_RUN_STATUS_CANCELING',
  4: 'CASCADE_RUN_STATUS_BUSY',
});

const PROTO_TRAJECTORY_SOURCES = Object.freeze({
  1: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
  12: 'CORTEX_TRAJECTORY_SOURCE_INTERACTIVE_CASCADE',
  15: 'CORTEX_TRAJECTORY_SOURCE_SDK',
  16: 'CORTEX_TRAJECTORY_SOURCE_SUBAGENT',
  17: 'CORTEX_TRAJECTORY_SOURCE_CLI',
  18: 'CORTEX_TRAJECTORY_SOURCE_JETBOX',
  22: 'CORTEX_TRAJECTORY_SOURCE_VSCODE',
  23: 'CORTEX_TRAJECTORY_SOURCE_VISUAL_STUDIO',
});

const PROTO_TOKEN_TYPES = Object.freeze({
  1: 'TOKEN_TYPE_SYSTEM_PROMPT',
  2: 'TOKEN_TYPE_TOOLS',
  3: 'TOKEN_TYPE_RULES',
  4: 'TOKEN_TYPE_MCP_TOOLS',
  5: 'TOKEN_TYPE_SKILLS',
  6: 'TOKEN_TYPE_SUBAGENTS',
  7: 'TOKEN_TYPE_CHAT_MESSAGES',
  8: 'TOKEN_TYPE_WORKFLOWS',
  9: 'TOKEN_TYPE_PLUGINS',
  10: 'TOKEN_TYPE_FLOWS',
});

const PROTO_TOKEN_SOURCES = Object.freeze({
  1: 'TOKEN_SOURCE_SYSTEM',
  2: 'TOKEN_SOURCE_USER',
});

const PROTO_CHAT_MSG_SOURCES = Object.freeze({
  1: 'CHAT_MESSAGE_SOURCE_USER',
  2: 'CHAT_MESSAGE_SOURCE_SYSTEM',
  3: 'CHAT_MESSAGE_SOURCE_UNKNOWN',
  4: 'CHAT_MESSAGE_SOURCE_TOOL',
  5: 'CHAT_MESSAGE_SOURCE_SYSTEM_PROMPT',
  6: 'CHAT_MESSAGE_SOURCE_CONTEXT',
});

function decodeProtoModelEnumInt(val) {
  const n = Math.trunc(Number(val));
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1000 && n < 100000) {
    return `MODEL_PLACEHOLDER_M${n - 1000}`;
  }
  return PROTO_STATIC_MODELS[n] || '';
}

function decodeProtoStepTypeEnum(val) {
  const n = Math.trunc(Number(val));
  return PROTO_STEP_TYPES[n] || 'CORTEX_STEP_TYPE_GENERIC';
}

function decodeProtoStepStatusEnum(val) {
  const n = Math.trunc(Number(val));
  return PROTO_STEP_STATUSES[n] || 'CORTEX_STEP_STATUS_DONE';
}

function decodeProtoSubagentSpecSlice(buf, state, end) {
  let typeName = '';
  let role = '';
  while (state.off < end) {
    const tag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 1 && wt === 2) {
      typeName = readProtoString(buf, state, end).trim();
    } else if (fn === 2 && wt === 2) {
      role = readProtoString(buf, state, end).trim();
    } else {
      skipProtoField(buf, state, wt, end);
    }
  }
  state.off = end;
  return typeName || role ? { typeName, role } : null;
}

function decodeProtoTrajectoryMetadataSlice(buf, state, end) {
  let createdAt = '';
  let parentConversationId = '';
  let rootConversationId = '';
  let nestingDepth = 0;
  let subagentSpec = null;
  let agentScript = null;

  while (state.off < end) {
    const tag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 2 && wt === 2) {
      createdAt = decodeProtoTimestampSlice(buf, state, readSubEnd(buf, state, end));
    } else if (fn === 4 && wt === 2) {
      const asEnd = readSubEnd(buf, state, end);
      let name = '';
      while (state.off < asEnd) {
        const asTag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, asEnd)));
        if ((asTag >>> 3) === 1 && (asTag & 7) === 2) {
          name = readProtoString(buf, state, asEnd).trim();
        } else {
          skipProtoField(buf, state, asTag & 7, asEnd);
        }
      }
      state.off = asEnd;
      if (name) agentScript = { name };
    } else if (fn === 5 && wt === 2) {
      parentConversationId = readProtoString(buf, state, end).trim().toLowerCase();
    } else if (fn === 6 && wt === 2) {
      rootConversationId = readProtoString(buf, state, end).trim().toLowerCase();
    } else if (fn === 8 && wt === 2) {
      subagentSpec = decodeProtoSubagentSpecSlice(buf, state, readSubEnd(buf, state, end));
    } else if (fn === 17 && wt === 0) {
      nestingDepth = Number(BigInt.asIntN(32, readProtoVarint(buf, state, end)));
    } else {
      skipProtoField(buf, state, wt, end);
    }
  }
  state.off = end;
  return {
    createdAt,
    parentConversationId,
    rootConversationId,
    nestingDepth,
    subagentSpec,
    agentScript,
  };
}

function decodeProtoCascadeTrajectorySummary(rawBlob) {
  const buf = toUint8Array(rawBlob);
  if (!buf || buf.length === 0) return null;
  const state = { off: 0 };
  const end = buf.length;

  let summary = '';
  let stepCount;
  let lastModifiedTime = '';
  let status = '';
  let createdTime = '';
  let source = '';
  let notFullyIdle;
  let trajectoryType = 0;
  let killed;
  let forkParentConversationId = '';
  let title = '';
  let archived = false;
  const sideQuestionCascadeIds = [];
  const sideQuestionTitles = {};
  let trajectoryMetadata = null;

  while (state.off < end) {
    const tag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 1 && wt === 2) {
      summary = readProtoString(buf, state, end);
    } else if (fn === 2 && wt === 0) {
      stepCount = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    } else if (fn === 3 && wt === 2) {
      lastModifiedTime = decodeProtoTimestampSlice(buf, state, readSubEnd(buf, state, end));
    } else if (fn === 5 && wt === 0) {
      const sNum = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
      status = PROTO_RUN_STATUSES[sNum] || '';
    } else if (fn === 7 && wt === 2) {
      createdTime = decodeProtoTimestampSlice(buf, state, readSubEnd(buf, state, end));
    } else if (fn === 15 && wt === 2) {
      const annEnd = readSubEnd(buf, state, end);
      while (state.off < annEnd) {
        const aTag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, annEnd)));
        const aFn = aTag >>> 3;
        const aWt = aTag & 7;
        if (aFn === 1 && aWt === 2) {
          title = readProtoString(buf, state, annEnd);
        } else if (aFn === 4 && aWt === 0) {
          archived = readProtoVarint(buf, state, annEnd) !== 0n;
        } else if (aFn === 17 && aWt === 2) {
          const sqId = readProtoString(buf, state, annEnd).trim().toLowerCase();
          if (sqId) sideQuestionCascadeIds.push(sqId);
        } else if (aFn === 18 && aWt === 2) {
          const [k, v] = decodeProtoMapStringEntry(buf, state, readSubEnd(buf, state, annEnd));
          const lk = k.trim().toLowerCase();
          if (lk) sideQuestionTitles[lk] = v;
        } else {
          skipProtoField(buf, state, aWt, annEnd);
        }
      }
      state.off = annEnd;
    } else if (fn === 17 && wt === 2) {
      trajectoryMetadata = decodeProtoTrajectoryMetadataSlice(buf, state, readSubEnd(buf, state, end));
    } else if (fn === 20 && wt === 0) {
      const srcNum = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
      source = PROTO_TRAJECTORY_SOURCES[srcNum] || '';
    } else if (fn === 21 && wt === 0) {
      notFullyIdle = readProtoVarint(buf, state, end) !== 0n;
    } else if (fn === 22 && wt === 0) {
      trajectoryType = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    } else if (fn === 23 && wt === 0) {
      killed = readProtoVarint(buf, state, end) !== 0n;
    } else if (fn === 24 && wt === 2) {
      forkParentConversationId = readProtoString(buf, state, end).trim().toLowerCase();
    } else {
      skipProtoField(buf, state, wt, end);
    }
  }

  return {
    summary,
    stepCount,
    lastModifiedTime,
    createdTime,
    status,
    source,
    notFullyIdle,
    trajectoryType,
    killed,
    forkParentConversationId,
    annotations: {
      title,
      archived,
      sideQuestionCascadeIds,
      sideQuestionTitles,
    },
    trajectoryMetadata,
  };
}

/**
 * 读取并缓存各产品数据根目录（Desktop / IDE / CLI）下的 `conversation_summaries.db` 完整快照。
 * 使用 `.db` 与 `.db-wal` 复合签名做内存 Memoize，未发生写入时零 I/O 返回。
 *
 * @param {string[]} [productRoots=PRODUCT_DATA_ROOTS]
 * @param {{ forceRefresh?: boolean }} [options={}]
 */
export function readLocalSummarySnapshot(productRoots = PRODUCT_DATA_ROOTS, { forceRefresh = false } = {}) {
  const DatabaseSync = getNodeSqliteDatabaseSync();
  if (!DatabaseSync) {
    return { available: false, sig: '', byId: new Map(), summariesObj: {}, sideQuestionParents: {} };
  }
  const roots = Array.isArray(productRoots) ? productRoots : [];
  const sigParts = [];
  const targets = [];

  for (const root of roots) {
    if (!root) continue;
    const dbPath = join(root, 'conversation_summaries.db');
    const walInfo = computeSqliteWalSig(dbPath);
    if (!walInfo.exists) continue;
    sigParts.push(`${dbPath}:${walInfo.sig}`);
    targets.push({ rootName: basename(root).toLowerCase(), dbPath });
  }

  const rootsKey = roots
    .map((r) => String(r || '').trim())
    .filter(Boolean)
    .join('\n');

  if (targets.length === 0) {
    if (productRoots === PRODUCT_DATA_ROOTS) {
      localSummaryMemo.sig = '';
      localSummaryMemo.byId.clear();
      localSummaryMemo.available = false;
      localSummaryMemo.summariesObj = {};
      localSummaryMemo.sideQuestionParents = {};
    }
    if (rootsKey && localSummaryMemo.byRootsKey instanceof Map) {
      localSummaryMemo.byRootsKey.delete(rootsKey);
    }
    return { available: false, sig: '', byId: new Map(), summariesObj: {}, sideQuestionParents: {} };
  }

  const sig = sigParts.join('||');
  if (!forceRefresh) {
    if (
      productRoots === PRODUCT_DATA_ROOTS &&
      localSummaryMemo.sig === sig &&
      localSummaryMemo.available
    ) {
      return {
        available: true,
        sig,
        byId: localSummaryMemo.byId,
        summariesObj: localSummaryMemo.summariesObj || {},
        sideQuestionParents: localSummaryMemo.sideQuestionParents || {},
      };
    }
    if (rootsKey && localSummaryMemo.byRootsKey instanceof Map) {
      const cached = localSummaryMemo.byRootsKey.get(rootsKey);
      if (cached && cached.sig === sig && cached.available) {
        localSummaryMemo.byRootsKey.delete(rootsKey);
        localSummaryMemo.byRootsKey.set(rootsKey, cached);
        return {
          available: true,
          sig,
          byId: cached.byId,
          summariesObj: cached.summariesObj,
          sideQuestionParents: cached.sideQuestionParents,
        };
      }
    }
  }

  const nextMap = new Map();
  const nextSummariesObj = {};
  const nextSideQuestionParents = {};
  let anyDbSucceeded = false;

  for (const { rootName, dbPath } of targets) {
    try {
      withReadOnlySqliteDb(dbPath, (db) => {
        let rows = [];
        try {
          try {
            rows = db
              .prepare(
                `SELECT
                   conversation_id,
                   title,
                   preview,
                   status,
                   source,
                   parent_conversation_id,
                   nesting_depth,
                   agent_name,
                   not_fully_idle,
                   killed,
                   step_count,
                   last_modified_time,
                   app_data_dir,
                   workspace_uris,
                   raw_summary
                 FROM conversation_summaries`
              )
              .all();
          } catch {
            rows = db
              .prepare(
                `SELECT
                   conversation_id,
                   title,
                   preview,
                   status,
                   source,
                   parent_conversation_id,
                   nesting_depth,
                   agent_name,
                   not_fully_idle,
                   killed,
                   step_count,
                   last_modified_time,
                   app_data_dir,
                   raw_summary
                 FROM conversation_summaries`
              )
              .all();
          }
        } catch {
          rows = db
            .prepare(
              `SELECT
                 conversation_id,
                 title,
                 status,
                 parent_conversation_id,
                 agent_name,
                 not_fully_idle,
                 killed,
                 step_count,
                 last_modified_time,
                 app_data_dir
               FROM conversation_summaries`
            )
            .all();
        }
        anyDbSucceeded = true;

        let parentRows = [];
        try {
          parentRows = db
            .prepare('SELECT conversation_id, parent_id FROM conversation_parents')
            .all();
        } catch {
          parentRows = [];
        }

        for (const row of rows || []) {
          const cidLower = String(row?.conversation_id || '').trim().toLowerCase();
          if (!cidLower) continue;

          let decoded = null;
          if (row?.raw_summary) {
            try {
              decoded = decodeProtoCascadeTrajectorySummary(row.raw_summary);
            } catch {
              decoded = null;
            }
          }

          const appDataDir = String(row?.app_data_dir || '').trim().toLowerCase();
          const isNativeRootRow = Boolean(appDataDir && appDataDir === rootName);
          const sqlLastMod = normalizeSqliteIsoTime(row?.last_modified_time);
          const createdTime = String(
            decoded?.createdTime || decoded?.trajectoryMetadata?.createdAt || ''
          );
          const lastModifiedTime = String(decoded?.lastModifiedTime || sqlLastMod || createdTime || '');
          const lastModifiedMs = parseIsoMs(lastModifiedTime);
          const rawStatus = String(decoded?.status || row?.status || '').trim();
          const killed = Boolean(decoded?.killed ?? Number(row?.killed));
          const notFullyIdle = Boolean(decoded?.notFullyIdle ?? Number(row?.not_fully_idle) > 0);
          const isRunning =
            !killed &&
            (rawStatus === 'CASCADE_RUN_STATUS_RUNNING' ||
              (notFullyIdle && rawStatus !== 'CASCADE_RUN_STATUS_IDLE'));
          const effectiveStatus = isRunning
            ? 'CASCADE_RUN_STATUS_RUNNING'
            : rawStatus || 'CASCADE_RUN_STATUS_IDLE';

          const rawMeta = decoded?.trajectoryMetadata || null;
          const parentConversationId = String(
            rawMeta?.parentConversationId || row?.parent_conversation_id || ''
          )
            .trim()
            .toLowerCase();
          const rootConversationId = String(rawMeta?.rootConversationId || '').trim().toLowerCase();
          const agentName = String(
            rawMeta?.agentScript?.name || row?.agent_name || ''
          ).trim();
          const title = String(decoded?.annotations?.title || row?.title || '').trim();
          const stepCount = Math.max(
            0,
            Math.floor(Number(decoded?.stepCount ?? row?.step_count ?? 0) || 0)
          );
          const trajectoryType = Number(decoded?.trajectoryType || 0);
          const isSideQuestion = trajectoryType === 22;
          const forkParentConversationId = String(decoded?.forkParentConversationId || '')
            .trim()
            .toLowerCase();

          const sideQuestionIds = Array.isArray(decoded?.annotations?.sideQuestionCascadeIds)
            ? decoded.annotations.sideQuestionCascadeIds
            : [];
          const sideQuestionTitles = decoded?.annotations?.sideQuestionTitles || {};
          const workspaceUri = parseWorkspaceUrisColumn(row?.workspace_uris)[0] || '';

          const entry = {
            cascadeId: cidLower,
            title,
            status: effectiveStatus,
            parentConversationId,
            rootConversationId,
            agentName,
            subagentSpec: rawMeta?.subagentSpec || null,
            stepCount,
            lastModifiedTime,
            lastModifiedMs,
            createdTime,
            appDataDir,
            notFullyIdle,
            killed,
            isNativeRootRow,
            trajectoryType,
            isSideQuestion,
            forkParentConversationId,
            ...(workspaceUri ? { workspaceUri } : {}),
          };

          const summaryRpcShape = {
            summary: String(decoded?.summary || row?.preview || ''),
            stepCount,
            lastModifiedTime,
            createdTime,
            status: effectiveStatus,
            source: String(decoded?.source || row?.source || ''),
            appDataDir,
            notFullyIdle,
            killed,
            trajectoryType,
            isSideQuestion,
            forkParentConversationId,
            ...(workspaceUri
              ? { workspaces: [{ workspaceFolderAbsoluteUri: workspaceUri }] }
              : {}),
            annotations: {
              title,
              archived: Boolean(decoded?.annotations?.archived),
              sideQuestionCascadeIds: sideQuestionIds,
              sideQuestionTitles,
            },
            trajectoryMetadata: {
              createdAt: String(rawMeta?.createdAt || createdTime || ''),
              parentConversationId,
              rootConversationId,
              nestingDepth: Number(rawMeta?.nestingDepth ?? row?.nesting_depth ?? 0),
              subagentSpec: rawMeta?.subagentSpec || null,
              agentScript: agentName ? { name: agentName } : null,
            },
          };

          const prev = nextMap.get(cidLower);
          if (
            !prev ||
            (entry.isNativeRootRow && !prev.isNativeRootRow) ||
            (entry.isNativeRootRow === prev.isNativeRootRow &&
              entry.lastModifiedMs >= prev.lastModifiedMs)
          ) {
            nextMap.set(cidLower, entry);
            nextSummariesObj[cidLower] = summaryRpcShape;
          }

          if (isSideQuestion && forkParentConversationId) {
            const existingSq = nextSideQuestionParents[cidLower];
            nextSideQuestionParents[cidLower] = {
              parentConversationId: existingSq?.parentConversationId || forkParentConversationId,
              title: existingSq?.title || title || '',
            };
          }

          for (const sqId of sideQuestionIds) {
            const sqLower = String(sqId || '').trim().toLowerCase();
            if (!sqLower) continue;
            nextSideQuestionParents[sqLower] = {
              parentConversationId: cidLower,
              title: String(sideQuestionTitles[sqLower] || nextSideQuestionParents[sqLower]?.title || ''),
            };
          }
          for (const [sqKey, sqTitle] of Object.entries(sideQuestionTitles)) {
            const sqLower = String(sqKey || '').trim().toLowerCase();
            if (!sqLower) continue;
            const existingSq = nextSideQuestionParents[sqLower];
            nextSideQuestionParents[sqLower] = {
              parentConversationId: existingSq?.parentConversationId || cidLower,
              title: String(sqTitle || existingSq?.title || ''),
            };
          }
        }

        for (const pRow of parentRows || []) {
          const sqLower = String(pRow?.conversation_id || '').trim().toLowerCase();
          const parentLower = String(pRow?.parent_id || '').trim().toLowerCase();
          if (!sqLower || !parentLower) continue;
          const childSummary = nextSummariesObj[sqLower];
          if (
            childSummary &&
            !childSummary.isSideQuestion &&
            (childSummary.trajectoryMetadata?.subagentSpec ||
              (Number(childSummary.trajectoryType) > 0 && Number(childSummary.trajectoryType) !== 22))
          ) {
            // 排除通过 fork 创建的蜂群工蜂或常规子代理，避免误归入旁路提问
            continue;
          }
          const parentSummary = nextSummariesObj[parentLower];
          const titleFromParent = String(
            parentSummary?.annotations?.sideQuestionTitles?.[sqLower] ||
              nextSideQuestionParents[sqLower]?.title ||
              ''
          );
          nextSideQuestionParents[sqLower] = {
            parentConversationId: parentLower,
            title: titleFromParent,
          };
        }
      });
    } catch {
      // 忽略正在初始化或不可读的单个 SQLite 摘要库
    }
  }

  if (!anyDbSucceeded) {
    return { available: false, sig: '', byId: new Map(), summariesObj: {}, sideQuestionParents: {} };
  }

  if (productRoots === PRODUCT_DATA_ROOTS) {
    localSummaryMemo.sig = sig;
    localSummaryMemo.byId = nextMap;
    localSummaryMemo.available = true;
    localSummaryMemo.summariesObj = nextSummariesObj;
    localSummaryMemo.sideQuestionParents = nextSideQuestionParents;
    localSummaryMemo.refreshedAtMs = Date.now();
  } else if (rootsKey && localSummaryMemo.byRootsKey instanceof Map) {
    if (!localSummaryMemo.byRootsKey.has(rootsKey) && localSummaryMemo.byRootsKey.size >= 8) {
      localSummaryMemo.byRootsKey.delete(localSummaryMemo.byRootsKey.keys().next().value);
    }
    localSummaryMemo.byRootsKey.delete(rootsKey);
    localSummaryMemo.byRootsKey.set(rootsKey, {
      available: true,
      sig,
      byId: nextMap,
      summariesObj: nextSummariesObj,
      sideQuestionParents: nextSideQuestionParents,
    });
  }

  return {
    available: true,
    sig,
    byId: nextMap,
    summariesObj: nextSummariesObj,
    sideQuestionParents: nextSideQuestionParents,
  };
}

/**
 * 读取并缓存各产品数据根目录下的 `conversation_summaries.db` 摘要索引（返回 `Map`，保持向后兼容）。
 *
 * @param {string[]} [productRoots=PRODUCT_DATA_ROOTS]
 * @returns {Map<string, object>}
 */
export function readLocalSummaryIndex(productRoots = PRODUCT_DATA_ROOTS) {
  return readLocalSummarySnapshot(productRoots).byId;
}

function decodeProtoModelUsageSlice(buf, state, end) {
  const usage = {};
  while (state.off < end) {
    const tag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 1 && wt === 0) {
      const m = decodeProtoModelEnumInt(readProtoVarint(buf, state, end));
      if (m) usage.model = m;
    } else if (fn === 1 && wt === 2) {
      const m = readProtoString(buf, state, end).trim();
      if (m) usage.model = m;
    } else if (fn === 2 && wt === 0) {
      const v = Number(BigInt.asUintN(64, readProtoVarint(buf, state, end)));
      if (v > 0) usage.inputTokens = v;
    } else if (fn === 3 && wt === 0) {
      const v = Number(BigInt.asUintN(64, readProtoVarint(buf, state, end)));
      if (v > 0) usage.outputTokens = v;
    } else if (fn === 5 && wt === 0) {
      const v = Number(BigInt.asUintN(64, readProtoVarint(buf, state, end)));
      if (v > 0) usage.cacheReadTokens = v;
    } else if (fn === 6 && wt === 0) {
      const provNum = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
      const prov = PROTO_API_PROVIDERS[provNum] || '';
      if (prov) usage.apiProvider = prov;
    } else if (fn === 9 && wt === 0) {
      const v = Number(BigInt.asUintN(64, readProtoVarint(buf, state, end)));
      if (v > 0) usage.thinkingOutputTokens = v;
    } else if (fn === 10 && wt === 0) {
      const v = Number(BigInt.asUintN(64, readProtoVarint(buf, state, end)));
      if (v > 0) usage.responseOutputTokens = v;
    } else {
      skipProtoField(buf, state, wt, end);
    }
  }
  state.off = end;
  if (usage.inputTokens === undefined) usage.inputTokens = 0;
  if (usage.cacheReadTokens === undefined) usage.cacheReadTokens = 0;
  if (usage.outputTokens === undefined) usage.outputTokens = 0;
  return usage;
}

function decodeProtoChildTokenGroupSlice(buf, state, end, depth = 0) {
  let name = '';
  let type = '';
  let numTokens = 0;
  const children = [];

  while (state.off < end) {
    const tag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 1 && wt === 2) {
      name = readProtoString(buf, state, end);
    } else if (fn === 2 && wt === 2 && depth < 2) {
      // 子级 TokenGroup 的 children 位于 field 2
      children.push(decodeProtoChildTokenGroupSlice(buf, state, readSubEnd(buf, state, end), depth + 1));
    } else if (fn === 2 && wt === 0) {
      const tNum = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
      type = PROTO_TOKEN_TYPES[tNum] || '';
    } else if (fn === 3 && wt === 0) {
      // 子级 TokenGroup 的 numTokens 位于 field 3
      numTokens = Number(BigInt.asIntN(32, readProtoVarint(buf, state, end)));
    } else if (fn === 4 && wt === 0) {
      // 兼容直接按顶层结构编码的子组（numTokens 位于 field 4）
      numTokens = Number(BigInt.asIntN(32, readProtoVarint(buf, state, end)));
    } else if (fn === 5 && wt === 2 && depth < 2) {
      children.push(decodeProtoChildTokenGroupSlice(buf, state, readSubEnd(buf, state, end), depth + 1));
    } else {
      skipProtoField(buf, state, wt, end);
    }
  }
  state.off = end;
  return {
    name,
    ...(type ? { type } : {}),
    numTokens,
    ...(children.length > 0 ? { children } : {}),
  };
}

function decodeProtoTopTokenGroupSlice(buf, state, end) {
  let name = '';
  let type = '';
  let source = '';
  let numTokens = 0;
  const children = [];

  while (state.off < end) {
    const tag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 1 && wt === 2) {
      name = readProtoString(buf, state, end);
    } else if (fn === 2 && wt === 0) {
      const tNum = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
      type = PROTO_TOKEN_TYPES[tNum] || '';
    } else if (fn === 3 && wt === 0) {
      const sNum = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
      source = PROTO_TOKEN_SOURCES[sNum] || '';
    } else if (fn === 4 && wt === 0) {
      numTokens = Number(BigInt.asIntN(32, readProtoVarint(buf, state, end)));
    } else if (fn === 5 && wt === 2) {
      children.push(decodeProtoChildTokenGroupSlice(buf, state, readSubEnd(buf, state, end), 0));
    } else {
      skipProtoField(buf, state, wt, end);
    }
  }
  state.off = end;
  return {
    name,
    ...(type ? { type } : {}),
    ...(source ? { source } : {}),
    numTokens,
    ...(children.length > 0 ? { children } : {}),
  };
}

function decodeProtoContextWindowMetaSlice(buf, state, end, includeBreakdown) {
  let estimatedTokensUsed = 0;
  let maxContextTokens = 0;
  const groups = [];
  let totalTokens = 0;

  while (state.off < end) {
    const tag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 1 && wt === 0) {
      estimatedTokensUsed = Number(BigInt.asIntN(32, readProtoVarint(buf, state, end)));
    } else if (fn === 4 && wt === 0) {
      maxContextTokens = Number(BigInt.asIntN(32, readProtoVarint(buf, state, end)));
    } else if (fn === 3 && wt === 2) {
      if (includeBreakdown) {
        const tbEnd = readSubEnd(buf, state, end);
        while (state.off < tbEnd) {
          const tbTag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, tbEnd)));
          const tbFn = tbTag >>> 3;
          const tbWt = tbTag & 7;
          if (tbFn === 1 && tbWt === 2) {
            groups.push(decodeProtoTopTokenGroupSlice(buf, state, readSubEnd(buf, state, tbEnd)));
          } else if (tbFn === 2 && tbWt === 0) {
            totalTokens = Number(BigInt.asIntN(32, readProtoVarint(buf, state, tbEnd)));
          } else {
            skipProtoField(buf, state, tbWt, tbEnd);
          }
        }
        state.off = tbEnd;
      } else {
        skipProtoField(buf, state, wt, end);
      }
    } else {
      skipProtoField(buf, state, wt, end);
    }
  }
  state.off = end;

  return {
    ...(estimatedTokensUsed > 0 ? { estimatedTokensUsed } : {}),
    ...(maxContextTokens > 0 ? { maxContextTokens } : {}),
    ...(includeBreakdown && groups.length > 0
      ? { tokenBreakdown: { groups, ...(totalTokens > 0 ? { totalTokens } : {}) } }
      : {}),
  };
}

function decodeProtoRetryInfoSlice(buf, state, end) {
  const ri = {};
  while (state.off < end) {
    const rTag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    const rFn = rTag >>> 3;
    const rWt = rTag & 7;
    if (rFn === 2 && rWt === 2) {
      ri.usage = decodeProtoModelUsageSlice(buf, state, readSubEnd(buf, state, end));
    } else if (rFn === 3 && rWt === 2) {
      const errStr = readProtoString(buf, state, end).trim();
      if (errStr) {
        ri.error = errStr.length > 320 ? `${errStr.slice(0, 319)}…` : errStr;
      }
    } else if (rFn === 5 && rWt === 0) {
      const code = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
      if (code > 0) ri.reasonCode = code;
    } else if (rFn === 7 && rWt === 2) {
      const dur = decodeProtoDurationSlice(buf, state, readSubEnd(buf, state, end));
      if (dur) ri.retryDelay = dur;
    } else {
      skipProtoField(buf, state, rWt, end);
    }
  }
  state.off = end;
  return ri;
}

function decodeProtoErrorMessageSlice(buf, state, end) {
  let userErrorMessage = '';
  let shortError = '';
  let errorCode = 0;
  let shouldShowModel = false;
  let shouldShowUser = false;

  while (state.off < end) {
    const tag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 3 && wt === 2) {
      const eEnd = readSubEnd(buf, state, end);
      while (state.off < eEnd) {
        const eTag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, eEnd)));
        const eFn = eTag >>> 3;
        const eWt = eTag & 7;
        if (eFn === 1 && eWt === 2) {
          const s = readProtoString(buf, state, eEnd).trim();
          if (s) userErrorMessage = s.length > 240 ? `${s.slice(0, 239)}…` : s;
        } else if (eFn === 2 && eWt === 2) {
          const s = readProtoString(buf, state, eEnd).trim();
          if (s) shortError = s.length > 320 ? `${s.slice(0, 319)}…` : s;
        } else if (eFn === 7 && eWt === 0) {
          errorCode = Number(BigInt.asUintN(32, readProtoVarint(buf, state, eEnd)));
        } else {
          skipProtoField(buf, state, eWt, eEnd);
        }
      }
      state.off = eEnd;
    } else if (fn === 4 && wt === 0) {
      shouldShowModel = readProtoVarint(buf, state, end) !== 0n;
    } else if (fn === 5 && wt === 0) {
      shouldShowUser = readProtoVarint(buf, state, end) !== 0n;
    } else {
      skipProtoField(buf, state, wt, end);
    }
  }
  state.off = end;
  if (!userErrorMessage && !shortError && !errorCode) return null;
  return {
    error: {
      ...(userErrorMessage ? { userErrorMessage } : {}),
      ...(shortError ? { shortError } : {}),
      ...(errorCode > 0 ? { errorCode } : {}),
    },
    ...(shouldShowModel ? { shouldShowModel: true } : {}),
    ...(shouldShowUser ? { shouldShowUser: true } : {}),
  };
}

function decodeProtoChatModelMetaSlice(buf, state, end, includeBreakdown) {
  let model = '';
  let usage = null;
  let contextWindowMetadata = null;
  let timeToFirstToken = '';
  let streamingDuration = '';
  let responseModel = '';
  let modelDisplayName = '';
  let retryCount = 0;
  let retryInfos = null;
  const extraMeta = {};
  let messagePrompts = null;
  let tools = null;
  let promptSections = null;

  while (state.off < end) {
    const tag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 2 && wt === 2) {
      if (includeBreakdown) {
        const mpEnd = readSubEnd(buf, state, end);
        const msg = {};
        while (state.off < mpEnd) {
          const mTag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, mpEnd)));
          const mFn = mTag >>> 3;
          const mWt = mTag & 7;
          if (mFn === 2 && mWt === 0) {
            const src = PROTO_CHAT_MSG_SOURCES[Number(BigInt.asUintN(32, readProtoVarint(buf, state, mpEnd)))];
            if (src) msg.source = src;
          } else if (mFn === 3 && mWt === 2) {
            msg.prompt = readProtoString(buf, state, mpEnd);
          } else if (mFn === 4 && mWt === 0) {
            const nt = Number(BigInt.asUintN(32, readProtoVarint(buf, state, mpEnd)));
            if (nt > 0) msg.numTokens = nt;
          } else {
            skipProtoField(buf, state, mWt, mpEnd);
          }
        }
        state.off = mpEnd;
        if (!messagePrompts) messagePrompts = [];
        messagePrompts.push(msg);
      } else {
        skipProtoField(buf, state, wt, end);
      }
    } else if (fn === 3 && wt === 0) {
      const enumStr = decodeProtoModelEnumInt(readProtoVarint(buf, state, end));
      if (enumStr && !model) model = enumStr;
    } else if (fn === 4 && wt === 2) {
      usage = decodeProtoModelUsageSlice(buf, state, readSubEnd(buf, state, end));
    } else if (fn === 8 && wt === 2) {
      if (includeBreakdown) {
        const tdEnd = readSubEnd(buf, state, end);
        const tool = {};
        while (state.off < tdEnd) {
          const tTag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, tdEnd)));
          const tFn = tTag >>> 3;
          const tWt = tTag & 7;
          if (tFn === 1 && tWt === 2) tool.name = readProtoString(buf, state, tdEnd);
          else if (tFn === 2 && tWt === 2) tool.description = readProtoString(buf, state, tdEnd);
          else if (tFn === 3 && tWt === 2) tool.jsonSchemaString = readProtoString(buf, state, tdEnd);
          else if (tFn === 6 && tWt === 2) tool.serverName = readProtoString(buf, state, tdEnd);
          else skipProtoField(buf, state, tWt, tdEnd);
        }
        state.off = tdEnd;
        if (!tools) tools = [];
        tools.push(tool);
      } else {
        skipProtoField(buf, state, wt, end);
      }
    } else if (fn === 9 && wt === 2) {
      const csEnd = readSubEnd(buf, state, end);
      while (state.off < csEnd) {
        const csTag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, csEnd)));
        const csFn = csTag >>> 3;
        const csWt = csTag & 7;
        if (csFn === 10 && csWt === 2) {
          contextWindowMetadata = decodeProtoContextWindowMetaSlice(
            buf,
            state,
            readSubEnd(buf, state, csEnd),
            includeBreakdown
          );
        } else {
          skipProtoField(buf, state, csWt, csEnd);
        }
      }
      state.off = csEnd;
    } else if (fn === 11 && wt === 2) {
      timeToFirstToken = decodeProtoDurationSlice(buf, state, readSubEnd(buf, state, end));
    } else if (fn === 12 && wt === 2) {
      streamingDuration = decodeProtoDurationSlice(buf, state, readSubEnd(buf, state, end));
    } else if (fn === 14 && wt === 0) {
      retryCount = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    } else if (fn === 16 && wt === 2) {
      if (includeBreakdown) {
        const psEnd = readSubEnd(buf, state, end);
        const sec = {};
        while (state.off < psEnd) {
          const pTag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, psEnd)));
          const pFn = pTag >>> 3;
          const pWt = pTag & 7;
          if (pFn === 1 && pWt === 2) sec.title = readProtoString(buf, state, psEnd);
          else if (pFn === 2 && pWt === 2) sec.content = readProtoString(buf, state, psEnd);
          else if (pFn === 6 && pWt === 0) {
            const tt = PROTO_TOKEN_TYPES[Number(BigInt.asUintN(32, readProtoVarint(buf, state, psEnd)))];
            if (tt) sec.tokenType = tt;
          } else if (pFn === 7 && pWt === 0) {
            const ts = PROTO_TOKEN_SOURCES[Number(BigInt.asUintN(32, readProtoVarint(buf, state, psEnd)))];
            if (ts) sec.tokenSource = ts;
          } else {
            skipProtoField(buf, state, pWt, psEnd);
          }
        }
        state.off = psEnd;
        if (!promptSections) promptSections = [];
        promptSections.push(sec);
      } else {
        skipProtoField(buf, state, wt, end);
      }
    } else if (fn === 17 && wt === 2) {
      const ri = decodeProtoRetryInfoSlice(buf, state, readSubEnd(buf, state, end));
      if (!retryInfos) retryInfos = [];
      retryInfos.push(ri);
    } else if (fn === 19 && wt === 2) {
      responseModel = readProtoString(buf, state, end).trim();
    } else if (fn === 20 && wt === 2) {
      const [k, v] = decodeProtoMapStringEntry(buf, state, readSubEnd(buf, state, end));
      if (k && v) extraMeta[k] = v;
    } else if (fn === 21 && wt === 2) {
      modelDisplayName = readProtoString(buf, state, end).trim();
    } else {
      skipProtoField(buf, state, wt, end);
    }
  }
  state.off = end;

  if (extraMeta.model_enum) {
    const cleanEnum = extraMeta.model_enum.trim();
    if (cleanEnum && !/^MODEL_(?:UNSPECIFIED|UNKNOWN)$/i.test(cleanEnum) && cleanEnum !== '0') {
      model = cleanEnum;
      if (usage && !usage.model) {
        usage.model = model;
      }
    }
  }
  if (extraMeta.used_claude === 'true' && usage && !usage.apiProvider) {
    usage.apiProvider = 'API_PROVIDER_ANTHROPIC';
  }

  const hasRetryEvidence =
    retryCount > 0 || Boolean(retryInfos && retryInfos.some((r) => r?.error || r?.reasonCode));
  return {
    chatModel: {
      ...(model ? { model } : {}),
      ...(usage ? { usage } : {}),
      ...(contextWindowMetadata && Object.keys(contextWindowMetadata).length > 0
        ? { chatStartMetadata: { contextWindowMetadata } }
        : {}),
      ...(timeToFirstToken ? { timeToFirstToken } : {}),
      ...(streamingDuration ? { streamingDuration } : {}),
      ...(retryCount > 0 ? { retryCount } : {}),
      ...(hasRetryEvidence && retryInfos ? { retryInfos } : {}),
      ...(responseModel ? { responseModel } : {}),
      ...(modelDisplayName ? { modelDisplayName } : {}),
      ...(messagePrompts ? { messagePrompts } : {}),
      ...(tools ? { tools } : {}),
      ...(promptSections ? { promptSections } : {}),
    },
    extraMeta,
  };
}

function decodeProtoPlannerConfigSlice(buf, state, end) {
  const pc = {};
  while (state.off < end) {
    const tag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 1 && wt === 0) {
      const pm = decodeProtoModelEnumInt(readProtoVarint(buf, state, end));
      if (pm) pc.planModel = pm;
    } else if (fn === 28 && wt === 2) {
      const mn = readProtoString(buf, state, end).trim();
      if (mn) pc.modelName = mn;
    } else if (fn === 60 && wt === 2) {
      const pecEnd = readSubEnd(buf, state, end);
      let execModel = '';
      while (state.off < pecEnd) {
        const pTag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, pecEnd)));
        if ((pTag >>> 3) === 1 && (pTag & 7) === 0) {
          execModel = decodeProtoModelEnumInt(readProtoVarint(buf, state, pecEnd));
        } else {
          skipProtoField(buf, state, pTag & 7, pecEnd);
        }
      }
      state.off = pecEnd;
      if (execModel) pc.planExecuteConfig = { executionModel: execModel };
    } else {
      skipProtoField(buf, state, wt, end);
    }
  }
  state.off = end;
  return Object.keys(pc).length > 0 ? pc : null;
}

function decodeProtoGeneratorMeta(rawBlob, includeBreakdown = true) {
  const buf = toUint8Array(rawBlob);
  if (!buf || buf.length === 0) return null;
  const state = { off: 0 };
  const end = buf.length;
  const stepIndices = [];
  let chatDecoded = null;
  let plannerConfig = null;

  while (state.off < end) {
    const tag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 2 && wt === 0) {
      stepIndices.push(Number(BigInt.asUintN(32, readProtoVarint(buf, state, end))));
    } else if (fn === 2 && wt === 2) {
      const pEnd = readSubEnd(buf, state, end);
      while (state.off < pEnd) {
        stepIndices.push(Number(BigInt.asUintN(32, readProtoVarint(buf, state, pEnd))));
      }
      state.off = pEnd;
    } else if (fn === 1 && wt === 2) {
      chatDecoded = decodeProtoChatModelMetaSlice(
        buf,
        state,
        readSubEnd(buf, state, end),
        includeBreakdown
      );
    } else if (fn === 3 && wt === 2) {
      plannerConfig = decodeProtoPlannerConfigSlice(buf, state, readSubEnd(buf, state, end));
    } else {
      skipProtoField(buf, state, wt, end);
    }
  }

  if (!chatDecoded && !plannerConfig) return null;
  return {
    stepIndices,
    ...(chatDecoded ? { chatModel: chatDecoded.chatModel } : {}),
    ...(plannerConfig ? { plannerConfig } : {}),
    extraMeta: chatDecoded?.extraMeta || {},
  };
}

function decodeProtoToolCallSlice(buf, state, end, includeArgs = true) {
  const tc = {};
  while (state.off < end) {
    const tag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 1 && wt === 2) {
      tc.id = readProtoString(buf, state, end);
    } else if (fn === 2 && wt === 2) {
      tc.name = readProtoString(buf, state, end);
    } else if (fn === 3 && wt === 2) {
      if (includeArgs) {
        tc.argumentsJson = readProtoString(buf, state, end);
      } else {
        skipProtoField(buf, state, wt, end);
      }
    } else {
      skipProtoField(buf, state, wt, end);
    }
  }
  state.off = end;
  return tc;
}

function decodeProtoStepMeta(rawBlob, fallbackIdx) {
  const buf = toUint8Array(rawBlob);
  if (!buf || buf.length === 0) {
    return { sourceTrajectoryStepInfo: { stepIndex: fallbackIdx, cascadeId: '' } };
  }
  const state = { off: 0 };
  const end = buf.length;

  let createdAt = '';
  let viewableAt = '';
  let finishedGeneratingAt = '';
  let completedAt = '';
  let startedAt = '';
  let modelUsage = null;
  let generatorModel = '';
  let toolCall = null;
  let retryInfos = null;
  let toolSummary = '';
  let stepIndex = fallbackIdx;
  let sawStepIndex = false;
  let originCascadeId = '';

  while (state.off < end) {
    const tag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 1 && wt === 2) {
      createdAt = decodeProtoTimestampSlice(buf, state, readSubEnd(buf, state, end));
    } else if (fn === 4 && wt === 2) {
      toolCall = decodeProtoToolCallSlice(buf, state, readSubEnd(buf, state, end), true);
    } else if (fn === 6 && wt === 2) {
      viewableAt = decodeProtoTimestampSlice(buf, state, readSubEnd(buf, state, end));
    } else if (fn === 7 && wt === 2) {
      finishedGeneratingAt = decodeProtoTimestampSlice(buf, state, readSubEnd(buf, state, end));
    } else if (fn === 8 && wt === 2) {
      completedAt = decodeProtoTimestampSlice(buf, state, readSubEnd(buf, state, end));
    } else if (fn === 9 && wt === 2) {
      modelUsage = decodeProtoModelUsageSlice(buf, state, readSubEnd(buf, state, end));
    } else if (fn === 11 && wt === 0) {
      generatorModel = decodeProtoModelEnumInt(readProtoVarint(buf, state, end));
    } else if (fn === 20 && wt === 2) {
      const siEnd = readSubEnd(buf, state, end);
      while (state.off < siEnd) {
        const siTag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, siEnd)));
        const siFn = siTag >>> 3;
        const siWt = siTag & 7;
        if (siFn === 2 && siWt === 0) {
          stepIndex = Number(BigInt.asUintN(32, readProtoVarint(buf, state, siEnd)));
          sawStepIndex = true;
        } else if (siFn === 4 && siWt === 2) {
          originCascadeId = readProtoString(buf, state, siEnd).trim().toLowerCase();
        } else {
          skipProtoField(buf, state, siWt, siEnd);
        }
      }
      state.off = siEnd;
    } else if (fn === 28 && wt === 2) {
      const ri = decodeProtoRetryInfoSlice(buf, state, readSubEnd(buf, state, end));
      if (!retryInfos) retryInfos = [];
      retryInfos.push(ri);
    } else if (fn === 30 && wt === 2) {
      toolSummary = readProtoString(buf, state, end);
    } else if (fn === 32 && wt === 2) {
      startedAt = decodeProtoTimestampSlice(buf, state, readSubEnd(buf, state, end));
    } else {
      skipProtoField(buf, state, wt, end);
    }
  }

  return {
    ...(createdAt ? { createdAt } : {}),
    ...(viewableAt ? { viewableAt } : {}),
    ...(finishedGeneratingAt ? { finishedGeneratingAt } : {}),
    ...(completedAt ? { completedAt } : startedAt && !finishedGeneratingAt ? { completedAt: startedAt } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(generatorModel ? { generatorModel } : {}),
    ...(toolCall ? { toolCall } : {}),
    ...(retryInfos ? { retryInfos } : {}),
    ...(toolSummary ? { toolSummary } : {}),
    sourceTrajectoryStepInfo: {
      stepIndex: sawStepIndex ? stepIndex : fallbackIdx,
      ...(originCascadeId ? { cascadeId: originCascadeId } : {}),
    },
    ...(modelUsage ? { modelUsage } : {}),
  };
}

/**
 * 轻量解码 SQLite `steps.task_details` Protobuf 载荷，仅提取任务 ID、展示标题、描述与转后台时间戳，
 * 跳过大体积日志路径（`#2`）与实时输出片段（`#3`）以避免热路径内存分配。
 *
 * @param {Uint8Array|Buffer|null|undefined} rawBlob
 * @returns {{ id?: string, title?: string, description?: string, movedToBackgroundAt?: string } | null}
 */
export function decodeProtoTaskDetails(rawBlob) {
  const buf = toUint8Array(rawBlob);
  if (!buf || buf.length === 0) return null;
  const state = { off: 0 };
  const end = buf.length;

  let id = '';
  let description = '';
  let title = '';
  let movedToBackgroundAt = '';

  while (state.off < end) {
    const tag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 1 && wt === 2) {
      id = readProtoString(buf, state, end).trim();
    } else if (fn === 4 && wt === 2) {
      const rawDesc = readProtoString(buf, state, end).trim();
      description = rawDesc.length > 240 ? rawDesc.slice(0, 240) : rawDesc;
    } else if (fn === 7 && wt === 2) {
      const rawTitle = readProtoString(buf, state, end).trim();
      title = rawTitle.length > 120 ? rawTitle.slice(0, 120) : rawTitle;
    } else if (fn === 8 && wt === 2) {
      movedToBackgroundAt = decodeProtoTimestampSlice(buf, state, readSubEnd(buf, state, end));
    } else {
      skipProtoField(buf, state, wt, end);
    }
  }

  if (!id && !title && !description && !movedToBackgroundAt) return null;
  return {
    ...(id ? { id } : {}),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(movedToBackgroundAt ? { movedToBackgroundAt } : {}),
  };
}

function isDaemonBackgroundTaskCall(toolCall) {
  const rawArgs = String(toolCall?.argumentsJson || '').trim();
  if (!rawArgs || !/isdaemon/i.test(rawArgs)) return false;
  try {
    const parsed = JSON.parse(rawArgs);
    return parsed?.IsDaemon === true || parsed?.isDaemon === true;
  } catch {
    return /["']?isDaemon["']?\s*:\s*true\b/i.test(rawArgs);
  }
}

function fetchRunningTaskDetailsMap(db, runningIndices) {
  const out = new Map();
  if (!db || !Array.isArray(runningIndices) || runningIndices.length === 0) {
    return out;
  }
  try {
    for (let off = 0; off < runningIndices.length; off += SQLITE_IN_CHUNK_SIZE) {
      const batch = runningIndices.slice(off, off + SQLITE_IN_CHUNK_SIZE);
      const placeholders = batch.map(() => '?').join(',');
      for (const row of db
        .prepare(
          `SELECT idx, task_details FROM steps WHERE idx IN (${placeholders}) AND task_details IS NOT NULL AND length(task_details) > 0`
        )
        .iterate(...batch)) {
        if (!row?.task_details || row.task_details.byteLength <= 0) continue;
        try {
          const decoded = decodeProtoTaskDetails(row.task_details);
          if (decoded) out.set(Number(row.idx), decoded);
        } catch {
          // 忽略单步 task_details 解码异常
        }
      }
    }
  } catch {
    // 兼容不含 task_details 列的旧版 SQLite 表结构
  }
  return out;
}

function hasNonWhitespaceUtf8(buf, start, end) {
  for (let i = start; i < end; i++) {
    const b = buf[i];
    if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) return true;
  }
  return false;
}

function decodeProtoPlannerResponseSlice(buf, state, end, keepFullText) {
  const pr = {};
  let hasText = false;
  let toolCalls = null;

  while (state.off < end) {
    const tag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if ((fn === 1 || fn === 8) && wt === 2) {
      if (keepFullText) {
        const str = readProtoString(buf, state, end);
        if (str) {
          if (fn === 1) pr.response = str;
          else pr.modifiedResponse = str;
        }
      } else {
        const sEnd = readSubEnd(buf, state, end);
        if (!hasText && hasNonWhitespaceUtf8(buf, state.off, sEnd)) {
          hasText = true;
        }
        state.off = sEnd;
      }
    } else if ((fn === 3 || fn === 16) && wt === 2) {
      if (keepFullText) {
        const str = readProtoString(buf, state, end);
        if (str) {
          if (fn === 3) pr.thinking = str;
          else pr.rawThinking = str;
        }
      } else {
        skipProtoField(buf, state, wt, end);
      }
    } else if (fn === 7 && wt === 2) {
      if (!toolCalls) toolCalls = [];
      toolCalls.push(decodeProtoToolCallSlice(buf, state, readSubEnd(buf, state, end), keepFullText));
    } else if (fn === 11 && wt === 2) {
      const dur = decodeProtoDurationSlice(buf, state, readSubEnd(buf, state, end));
      if (dur) pr.thinkingDuration = dur;
    } else {
      skipProtoField(buf, state, wt, end);
    }
  }
  state.off = end;
  if (!keepFullText && hasText) {
    pr.response = '1';
  }
  if (toolCalls) {
    pr.toolCalls = toolCalls;
  }
  return pr;
}

function decodeProtoUserInputSlice(buf, state, end) {
  let query = '';
  let userResponse = '';
  const items = [];
  let hasMedia = false;

  while (state.off < end) {
    const tag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 1 && wt === 2) {
      query = readProtoString(buf, state, end);
    } else if (fn === 2 && wt === 2) {
      userResponse = readProtoString(buf, state, end);
    } else if (fn === 3 && wt === 2) {
      const itEnd = readSubEnd(buf, state, end);
      let itemText = '';
      while (state.off < itEnd) {
        const iTag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, itEnd)));
        if ((iTag >>> 3) === 1 && (iTag & 7) === 2) {
          itemText = readProtoString(buf, state, itEnd);
        } else {
          skipProtoField(buf, state, iTag & 7, itEnd);
        }
      }
      state.off = itEnd;
      if (itemText) items.push({ text: itemText });
    } else if ((fn === 4 || fn === 5 || fn === 6) && wt === 2) {
      const mEnd = readSubEnd(buf, state, end);
      if (mEnd > state.off) hasMedia = true;
      state.off = mEnd;
    } else {
      skipProtoField(buf, state, wt, end);
    }
  }
  state.off = end;

  const primaryText = userResponse || query || items.map((x) => x.text).join('\n') || '';
  if (!primaryText && !hasMedia) return null;
  return {
    ...(primaryText ? { userResponse: primaryText } : {}),
    ...(items.length > 0 ? { items } : {}),
    ...(hasMedia ? { media: [{}] } : {}),
  };
}

function decodeProtoInvokeSubagentSlice(buf, state, end) {
  const subagents = [];
  const results = [];
  while (state.off < end) {
    const tag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 1 && wt === 2) {
      const spec = decodeProtoSubagentSpecSlice(buf, state, readSubEnd(buf, state, end));
      subagents.push(spec || { typeName: '', role: '' });
    } else if (fn === 2 && wt === 2) {
      const resEnd = readSubEnd(buf, state, end);
      let conversationId = '';
      while (state.off < resEnd) {
        const rTag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, resEnd)));
        if ((rTag >>> 3) === 1 && (rTag & 7) === 2) {
          conversationId = readProtoString(buf, state, resEnd).trim().toLowerCase();
        } else {
          skipProtoField(buf, state, rTag & 7, resEnd);
        }
      }
      state.off = resEnd;
      results.push({ conversationId });
    } else {
      skipProtoField(buf, state, wt, end);
    }
  }
  state.off = end;
  return { subagents, results };
}

const imageDimsMemo = new Map();

function parseImageBufferDimensions(buf) {
  if (!buf || buf.length < 11) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf.length >= 24
  ) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  // JPEG: FF D8 ... SOF0..SOF3 (FF C0..C3)
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 <= buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        const height = buf.readUInt16BE(i + 5);
        const width = buf.readUInt16BE(i + 7);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      if (i + 4 > buf.length) break;
      const segLen = buf.readUInt16BE(i + 2);
      if (segLen < 2) break;
      i += 2 + segLen;
    }
    return null;
  }
  // WebP: RIFF....WEBP
  if (
    buf.length >= 30 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    const chunk = buf.subarray(12, 16).toString('ascii');
    if (chunk === 'VP8X' && buf.length >= 30) {
      const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (chunk === 'VP8 ' && buf.length >= 30) {
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (chunk === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >>> 14) & 0x3fff) + 1;
      return width > 0 && height > 0 ? { width, height } : null;
    }
  }
  return null;
}

/**
 * 仅读取本地生成图片文件前 32KB 头部字节解析真实像素尺寸（PNG / JPEG / WebP），用于精确匹配图片分辨率计费档位。
 *
 * @param {string} rawUri
 * @returns {{ width: number, height: number } | null}
 */
export function readLocalImageDimensionsFromUri(rawUri) {
  const localPath = decodeWorkspaceFileUriToPath(rawUri);
  if (!localPath) return null;
  if (imageDimsMemo.has(localPath)) {
    return imageDimsMemo.get(localPath);
  }
  let dims = null;
  try {
    if (existsSync(localPath)) {
      if (typeof openSync === 'function' && typeof readSync === 'function' && typeof closeSync === 'function') {
        const fd = openSync(localPath, 'r');
        try {
          const head = Buffer.allocUnsafe(32768);
          const bytesRead = readSync(fd, head, 0, head.length, 0);
          if (bytesRead >= 11) {
            dims = parseImageBufferDimensions(head.subarray(0, bytesRead));
          }
        } finally {
          closeSync(fd);
        }
      } else if (typeof readFileSync === 'function') {
        const raw = readFileSync(localPath);
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        dims = parseImageBufferDimensions(buf);
      }
    }
  } catch {
    dims = null;
  }
  if (dims) {
    if (imageDimsMemo.size >= 512) {
      const firstKey = imageDimsMemo.keys().next().value;
      if (firstKey !== undefined) imageDimsMemo.delete(firstKey);
    }
    imageDimsMemo.set(localPath, dims);
  }
  return dims;
}

function decodeProtoGenerateImageSlice(buf, state, end) {
  let prompt = '';
  let aspectRatio = '';
  let uri = '';
  let fileSizeBytes = 0;
  let modelName = '';
  let imageName = '';
  while (state.off < end) {
    const tag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 1 && wt === 2) {
      prompt = readProtoString(buf, state, end);
    } else if (fn === 3 && wt === 2) {
      aspectRatio = readProtoString(buf, state, end);
    } else if (fn === 4 && wt === 2) {
      uri = readProtoString(buf, state, end);
    } else if (fn === 5 && wt === 0) {
      fileSizeBytes = Number(readProtoVarint(buf, state, end));
    } else if (fn === 6 && wt === 2) {
      modelName = readProtoString(buf, state, end);
    } else if (fn === 8 && wt === 2) {
      imageName = readProtoString(buf, state, end);
    } else {
      skipProtoField(buf, state, wt, end);
    }
  }
  state.off = end;
  return { prompt, aspectRatio, uri, fileSizeBytes, modelName, imageName };
}

function decodeProtoGeneratedMediaSlice(buf, state, end) {
  let mimeType = '';
  let uri = '';
  while (state.off < end) {
    const tag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 1 && wt === 2) {
      mimeType = readProtoString(buf, state, end);
    } else if (fn === 5 && wt === 2) {
      uri = readProtoString(buf, state, end);
    } else {
      skipProtoField(buf, state, wt, end);
    }
  }
  state.off = end;
  return mimeType || uri ? { mimeType, uri } : null;
}

function decodeProtoGenericStepToolPayloadSlice(
  buf,
  state,
  end,
  { wantInvokeSubagent = false, wantGenerateImage = false } = {}
) {
  let invokeSubagent = null;
  let generateImage = null;
  let mediaFallback = null;
  while (state.off < end) {
    const tag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 2 && wt === 2) {
      const resEnd = readSubEnd(buf, state, end);
      while (state.off < resEnd) {
        const resTag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, resEnd)));
        const rFn = resTag >>> 3;
        const rWt = resTag & 7;
        if (rFn === 4 && rWt === 2 && wantGenerateImage) {
          mediaFallback = decodeProtoGeneratedMediaSlice(buf, state, readSubEnd(buf, state, resEnd));
        } else if (rFn === 6 && rWt === 2) {
          const anyEnd = readSubEnd(buf, state, resEnd);
          let typeUrl = '';
          let valStart = 0;
          let valEnd = 0;
          while (state.off < anyEnd) {
            const aTag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, anyEnd)));
            if ((aTag >>> 3) === 1 && (aTag & 7) === 2) {
              typeUrl = readProtoString(buf, state, anyEnd);
            } else if ((aTag >>> 3) === 2 && (aTag & 7) === 2) {
              valEnd = readSubEnd(buf, state, anyEnd);
              valStart = state.off;
              state.off = valEnd;
            } else {
              skipProtoField(buf, state, aTag & 7, anyEnd);
            }
          }
          state.off = anyEnd;
          if (valEnd > valStart) {
            if (
              wantInvokeSubagent &&
              (typeUrl.endsWith('/exa.cortex.core.tools.InvokeSubagent') ||
                typeUrl === 'exa.cortex.core.tools.InvokeSubagent')
            ) {
              invokeSubagent = decodeProtoInvokeSubagentSlice(buf, { off: valStart }, valEnd);
            } else if (
              wantGenerateImage &&
              (typeUrl.endsWith('/exa.cortex.core.tools.GenerateImage') ||
                typeUrl === 'exa.cortex.core.tools.GenerateImage')
            ) {
              generateImage = decodeProtoGenerateImageSlice(buf, { off: valStart }, valEnd);
            }
          }
        } else {
          skipProtoField(buf, state, rWt, resEnd);
        }
      }
      state.off = resEnd;
    } else {
      skipProtoField(buf, state, wt, end);
    }
  }
  state.off = end;
  if (generateImage || mediaFallback) {
    const resolvedUri = generateImage?.uri || mediaFallback?.uri || '';
    const dims = resolvedUri ? readLocalImageDimensionsFromUri(resolvedUri) : null;
    generateImage = {
      prompt: generateImage?.prompt || '',
      imageName: generateImage?.imageName || '',
      aspectRatio: generateImage?.aspectRatio || '',
      modelName: generateImage?.modelName || '',
      ...(generateImage?.fileSizeBytes > 0 ? { fileSizeBytes: generateImage.fileSizeBytes } : {}),
      ...(resolvedUri || mediaFallback?.mimeType
        ? {
            generatedMedia: {
              mimeType: mediaFallback?.mimeType || '',
              uri: resolvedUri,
            },
          }
        : {}),
      ...(dims ? { width: dims.width, height: dims.height } : {}),
    };
  }
  return { invokeSubagent, generateImage };
}

function decodeProtoSystemMessageSlice(buf, state, end) {
  let message = '';
  while (state.off < end) {
    const tag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 1 && wt === 2) {
      message = readProtoString(buf, state, end);
    } else {
      skipProtoField(buf, state, wt, end);
    }
  }
  state.off = end;
  return message;
}

function decodeProtoSelectiveStepPayload(
  rawBlob,
  {
    stepTypeNum,
    isInvokeSubagent,
    isGenerateImage = false,
    includeSystemMessage = false,
    keepFullText,
  }
) {
  const buf = toUint8Array(rawBlob);
  if (!buf || buf.length === 0) return {};
  const state = { off: 0 };
  const end = buf.length;
  const out = {};

  while (state.off < end) {
    const tag = Number(BigInt.asUintN(32, readProtoVarint(buf, state, end)));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 19 && wt === 2 && stepTypeNum === 14) {
      const ui = decodeProtoUserInputSlice(buf, state, readSubEnd(buf, state, end));
      if (ui) out.userInput = ui;
    } else if (fn === 20 && wt === 2 && stepTypeNum === 15) {
      out.plannerResponse = decodeProtoPlannerResponseSlice(
        buf,
        state,
        readSubEnd(buf, state, end),
        keepFullText
      );
    } else if (fn === 24 && wt === 2 && stepTypeNum === 17) {
      const em = decodeProtoErrorMessageSlice(buf, state, readSubEnd(buf, state, end));
      if (em) out.errorMessage = em;
    } else if (fn === 114 && wt === 2 && stepTypeNum === 101 && includeSystemMessage) {
      const sysMsg = decodeProtoSystemMessageSlice(buf, state, readSubEnd(buf, state, end));
      if (sysMsg) out.systemMessage = { message: sysMsg };
    } else if (fn === 140 && wt === 2 && (isInvokeSubagent || isGenerateImage)) {
      const toolParsed = decodeProtoGenericStepToolPayloadSlice(
        buf,
        state,
        readSubEnd(buf, state, end),
        { wantInvokeSubagent: isInvokeSubagent, wantGenerateImage: isGenerateImage }
      );
      if (toolParsed.invokeSubagent) out.invokeSubagent = toolParsed.invokeSubagent;
      if (toolParsed.generateImage) out.generateImage = toolParsed.generateImage;
    } else if (fn === 143 && wt === 2 && isInvokeSubagent) {
      out.invokeSubagent = decodeProtoInvokeSubagentSlice(buf, state, readSubEnd(buf, state, end));
    } else {
      skipProtoField(buf, state, wt, end);
    }
  }
  return out;
}

function isInvokeSubagentToolName(rawName) {
  return /^(?:default_api:)?invoke_subagent$/i.test(String(rawName || '').trim());
}

function isGenerateImageToolName(rawName) {
  return /^(?:default_api:)?generate_image$/i.test(String(rawName || '').trim());
}

function mapRunningGenericToolStepType(rawToolName) {
  const name = String(rawToolName || '')
    .trim()
    .toLowerCase()
    .replace(/^default_api:/, '');
  if (!name) return 'CORTEX_STEP_TYPE_GENERIC';
  if (name === 'invoke_subagent') return 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT';
  if (name === 'generate_image') return 'CORTEX_STEP_TYPE_GENERATE_IMAGE';
  if (name === 'run_command') return 'CORTEX_STEP_TYPE_RUN_COMMAND';
  if (name === 'command_status') return 'CORTEX_STEP_TYPE_COMMAND_STATUS';
  if (name === 'send_command_input') return 'CORTEX_STEP_TYPE_SEND_COMMAND_INPUT';
  if (
    name === 'read_file' ||
    name === 'view_file' ||
    name === 'view_file_outline' ||
    name === 'view_code_item'
  ) {
    return 'CORTEX_STEP_TYPE_VIEW_FILE';
  }
  if (
    name === 'edit_file' ||
    name === 'write_file' ||
    name === 'write_to_file' ||
    name === 'replace_file_content' ||
    name === 'multi_replace_file_content'
  ) {
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

function cleanShortPromptTitle(rawText, maxChars = 80) {
  return extractShortPromptTitle(rawText, maxChars);
}

function hasContextBreakdownPayload(chat) {
  if (!chat || typeof chat !== 'object') return false;
  return Boolean(
    chat.chatStartMetadata?.contextWindowMetadata?.tokenBreakdown?.groups?.length ||
      chat.promptSections?.length ||
      chat.tools?.length ||
      chat.messagePrompts?.length
  );
}

/**
 * 从单个会话的本地 SQLite 数据库（`<product>/conversations/<cascadeId>.db`）提取步骤元数据、按需载荷与生成器元数据。
 * 自动过滤分叉/旁路提问克隆自父会话的步骤（`originCid !== cascadeId`），并按需解码末尾上下文拆解。
 *
 * @param {string} dbFilePath
 * @param {{ cascadeId?: string, isRunning?: boolean }} [options={}]
 */
export function readLocalSqliteTrajectory(dbFilePath, options = {}) {
  if (!dbFilePath || !existsSync(dbFilePath)) return null;
  const DatabaseSync = getNodeSqliteDatabaseSync();
  if (!DatabaseSync) return null;

  let normCid = String(options?.cascadeId || '')
    .trim()
    .toLowerCase();
  if (!normCid) {
    const stem = basename(dbFilePath).replace(/\.db$/i, '').trim().toLowerCase();
    if (UUID_FILE_RE.test(stem)) {
      normCid = stem;
    }
  }
  const isRunning = Boolean(options?.isRunning);

  try {
    return withReadOnlySqliteDb(dbFilePath, (db) => {
      let trajectoryType = 0;
      try {
        const metaRow = db
          .prepare(
            'SELECT trajectory_id, cascade_id, trajectory_type, source FROM trajectory_meta LIMIT 1'
          )
          .get();
        if (!normCid && metaRow?.cascade_id) {
          normCid = String(metaRow.cascade_id).trim().toLowerCase();
        }
        trajectoryType = Number(metaRow?.trajectory_type || 0);
      } catch {
        // 兼容未包含 trajectory_meta 表的精简库
      }
      const isSideQuestion = trajectoryType === 22;

      let trajectoryMetadata = {
        createdAt: '',
        parentConversationId: '',
        rootConversationId: '',
        nestingDepth: 0,
        subagentSpec: null,
        agentScript: null,
      };
      try {
        const blobRow = db
          .prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main' LIMIT 1")
          .get();
        const blobBuf = toUint8Array(blobRow?.data);
        if (blobBuf && blobBuf.length > 0) {
          trajectoryMetadata = decodeProtoTrajectoryMetadataSlice(
            blobBuf,
            { off: 0 },
            blobBuf.length
          );
        }
      } catch {
        // 兼容未包含 trajectory_metadata_blob 表的库
      }

      let forkParentConversationId = '';
      try {
        const refRows = db.prepare('SELECT idx, data FROM parent_references ORDER BY idx ASC').all();
        for (const refRow of refRows || []) {
          const refBuf = toUint8Array(refRow?.data);
          if (!refBuf || refBuf.length === 0) continue;
          const st = { off: 0 };
          let refCid = '';
          while (st.off < refBuf.length) {
            const tag = Number(BigInt.asUintN(32, readProtoVarint(refBuf, st, refBuf.length)));
            if ((tag >>> 3) === 6 && (tag & 7) === 2) {
              refCid = readProtoString(refBuf, st, refBuf.length).trim().toLowerCase();
            } else {
              skipProtoField(refBuf, st, tag & 7, refBuf.length);
            }
          }
          if (refCid && (!normCid || refCid !== normCid)) {
            forkParentConversationId = refCid;
          }
        }
      } catch {
        // 兼容未包含 parent_references 表的库
      }

      const GEN_TAIL_RAW_WINDOW = 16;
      const ownGenRecords = [];
      const tailRawBuffers = new Map();
      let maxGenIdx = -1;
      let rootConversationId = trajectoryMetadata.rootConversationId || '';
      let parentConversationId = trajectoryMetadata.parentConversationId || '';

      for (const row of db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').iterate()) {
        const gIdx = Number(row?.idx);
        if (Number.isFinite(gIdx) && gIdx > maxGenIdx) {
          maxGenIdx = gIdx;
        }
        if (!row?.data) continue;
        try {
          const decoded = decodeProtoGeneratorMeta(row.data, false);
          if (!decoded) continue;
          const gmCid = String(decoded.extraMeta?.cascade_id || '')
            .trim()
            .toLowerCase();
          if (gmCid && normCid && gmCid !== normCid) {
            // 过滤旁路提问或会话分叉从父会话克隆来的历史生成器记录
            continue;
          }
          if (!rootConversationId && decoded.extraMeta?.root_cascade_id) {
            rootConversationId = String(decoded.extraMeta.root_cascade_id).trim().toLowerCase();
          }
          if (!parentConversationId && decoded.extraMeta?.parent_cascade_id) {
            parentConversationId = String(decoded.extraMeta.parent_cascade_id).trim().toLowerCase();
          }
          const recIdx = ownGenRecords.length;
          ownGenRecords.push({
            dbIdx: Number.isFinite(gIdx) ? gIdx : recIdx,
            byteLength: Number(row.data?.byteLength || 0),
            gm: decoded,
          });
          tailRawBuffers.set(recIdx, row.data);
          if (tailRawBuffers.size > GEN_TAIL_RAW_WINDOW) {
            tailRawBuffers.delete(tailRawBuffers.keys().next().value);
          }
        } catch {
          // 忽略单条损坏的 generatorMetadata
        }
      }

      if (ownGenRecords.length > 0) {
        // 从末尾向前定位最近一条包含完整上下文拆解（tokenBreakdown / promptSections / tools / messagePrompts）的记录，
        // 避免末尾紧跟 CHECKPOINT 压缩步或多条纯 plannerConfig 记录时漏解压缩前的静态上下文构成；
        // 若末尾完整记录因回退/中断成为 `stepIndices: []`，继续跳过被宿主裁剪的轻量记录并尝试补解更早的完整带索引记录。
        let foundUnindexedBreakdown = false;
        let selSingleGenStmt = null;
        for (let i = ownGenRecords.length - 1; i >= 0; i--) {
          const rec = ownGenRecords[i];
          if (foundUnindexedBreakdown && rec.byteLength <= 2048) {
            continue;
          }
          let rawBuf = tailRawBuffers.get(i);
          if (!rawBuf) {
            if (!selSingleGenStmt) {
              selSingleGenStmt = db.prepare('SELECT data FROM gen_metadata WHERE idx = ? LIMIT 1');
            }
            rawBuf = selSingleGenStmt.get(rec.dbIdx)?.data || null;
          }
          if (!rawBuf) continue;
          try {
            const fullDecoded = decodeProtoGeneratorMeta(rawBuf, true);
            if (fullDecoded) {
              rec.gm = fullDecoded;
              if (hasContextBreakdownPayload(fullDecoded.chatModel)) {
                if (Array.isArray(fullDecoded.stepIndices) && fullDecoded.stepIndices.length > 0) {
                  break;
                }
                foundUnindexedBreakdown = true;
              }
            }
          } catch {
            // 保留轻量版本
          }
        }
        tailRawBuffers.clear();
      }

      const generatorMetadata = [];
      const genByStep = new Map();
      for (const { gm } of ownGenRecords) {
        const gmItem = {
          stepIndices: gm.stepIndices,
          ...(gm.chatModel ? { chatModel: gm.chatModel } : {}),
          ...(gm.plannerConfig ? { plannerConfig: gm.plannerConfig } : {}),
        };
        generatorMetadata.push(gmItem);
        for (const sIdx of gm.stepIndices) {
          genByStep.set(Number(sIdx), gmItem);
        }
      }

      const ownStepRecords = [];
      let rawTableStepCount = 0;
      let maxRawStepIdx = -1;
      let foreignOriginStepCount = 0;
      let maxForeignOriginStepIndex = -1;
      for (const row of db
        .prepare('SELECT idx, step_type, status, metadata FROM steps ORDER BY idx ASC')
        .iterate()) {
        rawTableStepCount += 1;
        const idx = Number.isFinite(Number(row?.idx)) ? Number(row.idx) : ownStepRecords.length;
        if (idx > maxRawStepIdx) maxRawStepIdx = idx;
        const stepTypeNum = Number(row?.step_type || 0);
        const statusNum = Number(row?.status || 0);
        let metadata = { sourceTrajectoryStepInfo: { stepIndex: idx } };
        if (row?.metadata && row.metadata.byteLength > 0) {
          try {
            metadata = decodeProtoStepMeta(row.metadata, idx);
          } catch {
            // 忽略单步元数据解码异常
          }
        }
        const originCid = String(metadata.sourceTrajectoryStepInfo?.cascadeId || '')
          .trim()
          .toLowerCase();
        if (originCid && normCid && originCid !== normCid) {
          // 过滤克隆自父会话的步骤，防止双倍重复计费，同时记录跨源克隆步序上界以拦截 transcript 回退
          foreignOriginStepCount += 1;
          const foreignIdx = Number(metadata.sourceTrajectoryStepInfo?.stepIndex ?? idx);
          if (Number.isFinite(foreignIdx) && foreignIdx > maxForeignOriginStepIndex) {
            maxForeignOriginStepIndex = foreignIdx;
          }
          continue;
        }
        ownStepRecords.push({ idx, stepTypeNum, statusNum, metadata });
      }

      const isChildTrajectory =
        !isSideQuestion &&
        Boolean(
          trajectoryMetadata.parentConversationId ||
            parentConversationId ||
            (trajectoryMetadata.rootConversationId &&
              trajectoryMetadata.rootConversationId !== normCid) ||
            (rootConversationId && rootConversationId !== normCid) ||
            trajectoryMetadata.subagentSpec
        );

      const runningTailStart = isRunning
        ? Math.max(0, ownStepRecords.length - 16)
        : ownStepRecords.length;

      const payloadSpecsByIdx = new Map();
      const payloadIndices = [];
      try {
        for (let i = 0; i < ownStepRecords.length; i++) {
          const rec = ownStepRecords[i];
          const inRunningTail = isRunning && i >= runningTailStart;
          const isInvSub =
            rec.stepTypeNum === 127 ||
            (rec.stepTypeNum === 132 && isInvokeSubagentToolName(rec.metadata?.toolCall?.name));
          const isGenImg =
            rec.stepTypeNum === 91 ||
            (rec.stepTypeNum === 132 && isGenerateImageToolName(rec.metadata?.toolCall?.name));
          if (
            rec.stepTypeNum === 14 ||
            rec.stepTypeNum === 15 ||
            rec.stepTypeNum === 17 ||
            (isChildTrajectory && rec.stepTypeNum === 101) ||
            isInvSub ||
            isGenImg ||
            (inRunningTail && (rec.stepTypeNum !== 132 || !rec.metadata?.toolCall?.argumentsJson))
          ) {
            payloadIndices.push(rec.idx);
            payloadSpecsByIdx.set(rec.idx, {
              stepTypeNum: rec.stepTypeNum,
              isInvokeSubagent: isInvSub,
              isGenerateImage: isGenImg,
              includeSystemMessage: isChildTrajectory && rec.stepTypeNum === 101,
              keepFullText: inRunningTail,
            });
          }
        }
      } catch {
        // 忽略索引构建异常
      }

      const decodedPayloadByIdx = new Map();
      if (payloadIndices.length > 0) {
        const payloadChunkSize = Math.min(128, SQLITE_IN_CHUNK_SIZE);
        try {
          for (let off = 0; off < payloadIndices.length; off += payloadChunkSize) {
            const batch = payloadIndices.slice(off, off + payloadChunkSize);
            const placeholders = batch.map(() => '?').join(',');
            for (const pRow of db
              .prepare(`SELECT idx, step_payload FROM steps WHERE idx IN (${placeholders})`)
              .iterate(...batch)) {
              if (!pRow?.step_payload || pRow.step_payload.byteLength <= 0) continue;
              const pIdx = Number(pRow.idx);
              const spec = payloadSpecsByIdx.get(pIdx);
              if (!spec) continue;
              try {
                decodedPayloadByIdx.set(pIdx, decodeProtoSelectiveStepPayload(pRow.step_payload, spec));
              } catch {
                // 忽略单步载荷解析异常
              }
            }
          }
        } catch {
          // 兼容不含 step_payload 列的旧表
        }
      }
      payloadSpecsByIdx.clear();

      const runningTaskIndices = isRunning
        ? ownStepRecords
            .filter((rec) => ACTIVE_TASK_STEP_STATUS_NUMS.has(rec.statusNum))
            .map((rec) => rec.idx)
        : [];
      const taskDetailsByIdx =
        runningTaskIndices.length > 0 ? fetchRunningTaskDetailsMap(db, runningTaskIndices) : null;

      let firstOwnUserPrompt = '';
      const steps = [];
      for (let i = 0; i < ownStepRecords.length; i++) {
        const rec = ownStepRecords[i];
        const inRunningTail = isRunning && i >= runningTailStart;
        const isInvSub =
          rec.stepTypeNum === 127 ||
          (rec.stepTypeNum === 132 && isInvokeSubagentToolName(rec.metadata?.toolCall?.name));
        const isGenImg =
          rec.stepTypeNum === 91 ||
          (rec.stepTypeNum === 132 && isGenerateImageToolName(rec.metadata?.toolCall?.name));

        let type = '';
        if (isInvSub) {
          type = 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT';
        } else if (isGenImg) {
          type = 'CORTEX_STEP_TYPE_GENERATE_IMAGE';
        } else if (
          rec.stepTypeNum === 132 &&
          (inRunningTail || ACTIVE_TASK_STEP_STATUS_NUMS.has(rec.statusNum))
        ) {
          type = mapRunningGenericToolStepType(rec.metadata?.toolCall?.name);
        } else {
          type = decodeProtoStepTypeEnum(rec.stepTypeNum);
        }
        const status = decodeProtoStepStatusEnum(rec.statusNum);
        const metadata = rec.metadata;
        const stepIdx = metadata.sourceTrajectoryStepInfo?.stepIndex ?? rec.idx;
        const gm = genByStep.get(Number(stepIdx));
        if (metadata.modelUsage && gm?.chatModel?.model && !metadata.modelUsage.model) {
          metadata.modelUsage.model = gm.chatModel.model;
        }

        const stepObj = { idx: rec.idx, type, status, metadata };
        const taskDetails = taskDetailsByIdx?.get(rec.idx);
        if (taskDetails) {
          stepObj.taskDetails = taskDetails;
        }
        const decodedPayload = decodedPayloadByIdx.get(rec.idx);
        if (decodedPayload) {
          if (decodedPayload.userInput) {
            stepObj.userInput = decodedPayload.userInput;
            if (!firstOwnUserPrompt && decodedPayload.userInput.userResponse) {
              firstOwnUserPrompt = cleanShortPromptTitle(
                decodedPayload.userInput.userResponse,
                80
              );
            }
          }
          if (decodedPayload.systemMessage) {
            stepObj.systemMessage = decodedPayload.systemMessage;
            stepObj.content = decodedPayload.systemMessage.message;
          }
          if (decodedPayload.plannerResponse) {
            stepObj.plannerResponse = decodedPayload.plannerResponse;
          }
          if (decodedPayload.errorMessage) {
            stepObj.errorMessage = decodedPayload.errorMessage;
          }
          if (decodedPayload.invokeSubagent) {
            stepObj.invokeSubagent = decodedPayload.invokeSubagent;
          }
          if (decodedPayload.generateImage) {
            stepObj.generateImage = decodedPayload.generateImage;
          }
        }
        steps.push(stepObj);
      }

      const mergedMetadata = {
        ...trajectoryMetadata,
        parentConversationId: trajectoryMetadata.parentConversationId || parentConversationId,
        rootConversationId: trajectoryMetadata.rootConversationId || rootConversationId,
      };

      if (steps.length === 0 && generatorMetadata.length === 0 && !isSideQuestion) {
        if (options?.includeForeignStepBounds && foreignOriginStepCount > 0) {
          return {
            cascadeId: normCid,
            numTotalSteps: 0,
            rawTableStepCount,
            maxGenIdx,
            maxRawStepIdx,
            isChildTrajectory,
            trajectoryType,
            isSideQuestion: false,
            forkParentConversationId,
            firstOwnUserPrompt: '',
            steps: [],
            generatorMetadata: [],
            rootConversationId: mergedMetadata.rootConversationId,
            parentConversationId: mergedMetadata.parentConversationId,
            hasForeignOriginSteps: true,
            maxForeignOriginStepIndex,
            trajectory: {
              metadata: mergedMetadata,
              steps: [],
              generatorMetadata: [],
            },
          };
        }
        return null;
      }

      return {
        cascadeId: normCid,
        numTotalSteps: steps.length,
        rawTableStepCount,
        maxGenIdx,
        maxRawStepIdx,
        isChildTrajectory,
        trajectoryType,
        isSideQuestion,
        forkParentConversationId,
        firstOwnUserPrompt,
        steps,
        generatorMetadata,
        rootConversationId: mergedMetadata.rootConversationId,
        parentConversationId: mergedMetadata.parentConversationId,
        ...(foreignOriginStepCount > 0
          ? { hasForeignOriginSteps: true, maxForeignOriginStepIndex }
          : {}),
        trajectory: {
          metadata: mergedMetadata,
          steps,
          generatorMetadata,
        },
      };
    });
  } catch {
    return null;
  }
}

/**
 * 仅增量读取本地 SQLite 会话库在 `cursor.stableRawIdx` 之后的尾部步骤与新增 `gen_metadata`：
 * 若前缀行数/最大索引发生回退、截断或出现跨源克隆步骤，则返回 `null` 交由调用方自动回退全表扫描，
 * 确保增量结果与全量 `readLocalSqliteTrajectory` 逐字段一致。
 *
 * @param {string} dbFilePath
 * @param {{
 *   stableRawIdx: number,
 *   stableRawRowCount: number,
 *   stableMaxGenIdx: number,
 *   isChildTrajectory?: boolean,
 *   isSideQuestion?: boolean,
 *   trajectoryType?: number,
 *   forkParentConversationId?: string,
 *   firstOwnUserPrompt?: string,
 *   rootConversationId?: string,
 *   parentConversationId?: string,
 *   trajectoryMetadata?: object,
 * }} cursor
 * @param {{ cascadeId?: string, isRunning?: boolean }} [options={}]
 */
export function readLocalSqliteTrajectoryIncremental(dbFilePath, cursor, options = {}) {
  if (
    !dbFilePath ||
    !existsSync(dbFilePath) ||
    !cursor ||
    !Number.isFinite(Number(cursor.stableRawIdx)) ||
    !(Number(cursor.stableRawRowCount) > 0)
  ) {
    return null;
  }
  const DatabaseSync = getNodeSqliteDatabaseSync();
  if (!DatabaseSync) return null;

  let normCid = String(options?.cascadeId || '').trim().toLowerCase();
  if (!normCid) {
    const stem = basename(dbFilePath).replace(/\.db$/i, '').trim().toLowerCase();
    if (UUID_FILE_RE.test(stem)) normCid = stem;
  }
  const isRunning = Boolean(options?.isRunning);
  const stableRawIdx = Math.floor(Number(cursor.stableRawIdx));
  const stableRawRowCount = Math.floor(Number(cursor.stableRawRowCount));
  const stableMaxGenIdx = Number.isFinite(Number(cursor.stableMaxGenIdx))
    ? Math.floor(Number(cursor.stableMaxGenIdx))
    : -1;
  const isChildTrajectory = Boolean(cursor.isChildTrajectory);

  try {
    return withReadOnlySqliteDb(dbFilePath, (db) => {
      const stats = db.prepare('SELECT COUNT(*) AS cnt, MAX(idx) AS maxIdx FROM steps').get();
      const rawTableStepCount = Number(stats?.cnt || 0);
      const maxRawStepIdx = Number(stats?.maxIdx ?? -1);
      if (rawTableStepCount < stableRawRowCount || maxRawStepIdx < stableRawIdx) {
        return null;
      }
      const prefixCheck = db
        .prepare('SELECT COUNT(*) AS cnt, MAX(idx) AS maxIdx FROM steps WHERE idx <= ?')
        .get(stableRawIdx);
      if (
        !prefixCheck ||
        Number(prefixCheck.cnt || 0) !== stableRawRowCount ||
        Number(prefixCheck.maxIdx ?? -1) !== stableRawIdx
      ) {
        return null;
      }

      const ownGenRecords = [];
      const tailRawBuffers = new Map();
      let maxGenIdx = stableMaxGenIdx;
      for (const row of db
        .prepare('SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx ASC')
        .iterate(stableMaxGenIdx)) {
        const gIdx = Number(row?.idx);
        if (Number.isFinite(gIdx) && gIdx > maxGenIdx) {
          maxGenIdx = gIdx;
        }
        if (!row?.data) continue;
        try {
          const decoded = decodeProtoGeneratorMeta(row.data, false);
          if (!decoded) continue;
          const gmCid = String(decoded.extraMeta?.cascade_id || '')
            .trim()
            .toLowerCase();
          if (gmCid && normCid && gmCid !== normCid) {
            return null;
          }
          const recIdx = ownGenRecords.length;
          ownGenRecords.push({
            dbIdx: Number.isFinite(gIdx) ? gIdx : recIdx,
            byteLength: Number(row.data?.byteLength || 0),
            gm: decoded,
          });
          tailRawBuffers.set(recIdx, row.data);
          if (tailRawBuffers.size > 16) {
            tailRawBuffers.delete(tailRawBuffers.keys().next().value);
          }
        } catch {
          // 忽略单条损坏的 generatorMetadata
        }
      }

      let foundIndexedBreakdown = false;
      let foundUnindexedBreakdown = false;
      let selSingleGenStmt = null;
      for (let i = ownGenRecords.length - 1; i >= 0; i--) {
        const rec = ownGenRecords[i];
        if (foundUnindexedBreakdown && rec.byteLength <= 2048) {
          continue;
        }
        let rawBuf = tailRawBuffers.get(i);
        if (!rawBuf) {
          if (!selSingleGenStmt) {
            selSingleGenStmt = db.prepare('SELECT data FROM gen_metadata WHERE idx = ? LIMIT 1');
          }
          rawBuf = selSingleGenStmt.get(rec.dbIdx)?.data || null;
        }
        if (!rawBuf) continue;
        try {
          const fullDecoded = decodeProtoGeneratorMeta(rawBuf, true);
          if (fullDecoded) {
            rec.gm = fullDecoded;
            if (hasContextBreakdownPayload(fullDecoded.chatModel)) {
              if (Array.isArray(fullDecoded.stepIndices) && fullDecoded.stepIndices.length > 0) {
                foundIndexedBreakdown = true;
                break;
              }
              foundUnindexedBreakdown = true;
            }
          }
        } catch {
          // 保留轻量版本
        }
      }
      tailRawBuffers.clear();

      // 若尾部增量中未包含完整上下文拆解，从 stableMaxGenIdx 向前按需补读最近一条完整拆解（最多回溯 12 条）
      let fallbackPrefixBreakdownGm = null;
      if (!foundIndexedBreakdown && stableMaxGenIdx >= 0) {
        for (const row of db
          .prepare('SELECT idx, data FROM gen_metadata WHERE idx <= ? ORDER BY idx DESC LIMIT 12')
          .iterate(stableMaxGenIdx)) {
          if (!row?.data) continue;
          if (foundUnindexedBreakdown && Number(row.data.byteLength || 0) <= 2048) {
            continue;
          }
          try {
            const fullDecoded = decodeProtoGeneratorMeta(row.data, true);
            if (!fullDecoded) continue;
            const gmCid = String(fullDecoded.extraMeta?.cascade_id || '')
              .trim()
              .toLowerCase();
            if (gmCid && normCid && gmCid !== normCid) continue;
            if (hasContextBreakdownPayload(fullDecoded.chatModel)) {
              fallbackPrefixBreakdownGm = {
                stepIndices: fullDecoded.stepIndices,
                ...(fullDecoded.chatModel ? { chatModel: fullDecoded.chatModel } : {}),
                ...(fullDecoded.plannerConfig ? { plannerConfig: fullDecoded.plannerConfig } : {}),
              };
              if (Array.isArray(fullDecoded.stepIndices) && fullDecoded.stepIndices.length > 0) {
                break;
              }
              foundUnindexedBreakdown = true;
            }
          } catch {
            // 忽略单条解码异常
          }
        }
      }

      const generatorMetadata = [];
      const genByStep = new Map();
      if (fallbackPrefixBreakdownGm) {
        generatorMetadata.push(fallbackPrefixBreakdownGm);
        for (const sIdx of fallbackPrefixBreakdownGm.stepIndices || []) {
          genByStep.set(Number(sIdx), fallbackPrefixBreakdownGm);
        }
      }
      for (const { gm } of ownGenRecords) {
        const gmItem = {
          stepIndices: gm.stepIndices,
          ...(gm.chatModel ? { chatModel: gm.chatModel } : {}),
          ...(gm.plannerConfig ? { plannerConfig: gm.plannerConfig } : {}),
        };
        generatorMetadata.push(gmItem);
        for (const sIdx of gm.stepIndices) {
          genByStep.set(Number(sIdx), gmItem);
        }
      }

      const tailStepRecords = [];
      for (const row of db
        .prepare('SELECT idx, step_type, status, metadata FROM steps WHERE idx > ? ORDER BY idx ASC')
        .iterate(stableRawIdx)) {
        const idx = Number(row?.idx);
        if (!Number.isFinite(idx)) return null;
        const stepTypeNum = Number(row?.step_type || 0);
        const statusNum = Number(row?.status || 0);
        let metadata = { sourceTrajectoryStepInfo: { stepIndex: idx } };
        if (row?.metadata && row.metadata.byteLength > 0) {
          try {
            metadata = decodeProtoStepMeta(row.metadata, idx);
          } catch {
            // 忽略单步元数据解码异常
          }
        }
        const originCid = String(metadata.sourceTrajectoryStepInfo?.cascadeId || '')
          .trim()
          .toLowerCase();
        if (originCid && normCid && originCid !== normCid) {
          return null;
        }
        tailStepRecords.push({ idx, stepTypeNum, statusNum, metadata });
      }

      const runningTailStartGlobal = isRunning
        ? Math.max(0, rawTableStepCount - 16)
        : rawTableStepCount;

      const payloadSpecsByIdx = new Map();
      const payloadIndices = [];
      for (let i = 0; i < tailStepRecords.length; i++) {
        const rec = tailStepRecords[i];
        const inRunningTail = isRunning && stableRawRowCount + i >= runningTailStartGlobal;
        const isInvSub =
          rec.stepTypeNum === 127 ||
          (rec.stepTypeNum === 132 && isInvokeSubagentToolName(rec.metadata?.toolCall?.name));
        const isGenImg =
          rec.stepTypeNum === 91 ||
          (rec.stepTypeNum === 132 && isGenerateImageToolName(rec.metadata?.toolCall?.name));
        if (
          rec.stepTypeNum === 14 ||
          rec.stepTypeNum === 15 ||
          rec.stepTypeNum === 17 ||
          (isChildTrajectory && rec.stepTypeNum === 101) ||
          isInvSub ||
          isGenImg ||
          (inRunningTail && (rec.stepTypeNum !== 132 || !rec.metadata?.toolCall?.argumentsJson))
        ) {
          payloadIndices.push(rec.idx);
          payloadSpecsByIdx.set(rec.idx, {
            stepTypeNum: rec.stepTypeNum,
            isInvokeSubagent: isInvSub,
            isGenerateImage: isGenImg,
            includeSystemMessage: isChildTrajectory && rec.stepTypeNum === 101,
            keepFullText: inRunningTail,
          });
        }
      }

      const decodedPayloadByIdx = new Map();
      if (payloadIndices.length > 0) {
        const payloadChunkSize = Math.min(128, SQLITE_IN_CHUNK_SIZE);
        try {
          for (let off = 0; off < payloadIndices.length; off += payloadChunkSize) {
            const batch = payloadIndices.slice(off, off + payloadChunkSize);
            const placeholders = batch.map(() => '?').join(',');
            for (const pRow of db
              .prepare(`SELECT idx, step_payload FROM steps WHERE idx IN (${placeholders})`)
              .iterate(...batch)) {
              if (!pRow?.step_payload || pRow.step_payload.byteLength <= 0) continue;
              const pIdx = Number(pRow.idx);
              const spec = payloadSpecsByIdx.get(pIdx);
              if (!spec) continue;
              try {
                decodedPayloadByIdx.set(pIdx, decodeProtoSelectiveStepPayload(pRow.step_payload, spec));
              } catch {
                // 忽略单步载荷解析异常
              }
            }
          }
        } catch {
          // 兼容不含 step_payload 列的旧表
        }
      }
      payloadSpecsByIdx.clear();

      const runningTaskIndices = isRunning
        ? tailStepRecords
            .filter((rec) => ACTIVE_TASK_STEP_STATUS_NUMS.has(rec.statusNum))
            .map((rec) => rec.idx)
        : [];
      const taskDetailsByIdx =
        runningTaskIndices.length > 0 ? fetchRunningTaskDetailsMap(db, runningTaskIndices) : null;

      let tailFirstOwnUserPrompt = '';
      const steps = [];
      for (let i = 0; i < tailStepRecords.length; i++) {
        const rec = tailStepRecords[i];
        const inRunningTail = isRunning && stableRawRowCount + i >= runningTailStartGlobal;
        const isInvSub =
          rec.stepTypeNum === 127 ||
          (rec.stepTypeNum === 132 && isInvokeSubagentToolName(rec.metadata?.toolCall?.name));
        const isGenImg =
          rec.stepTypeNum === 91 ||
          (rec.stepTypeNum === 132 && isGenerateImageToolName(rec.metadata?.toolCall?.name));

        let type = '';
        if (isInvSub) {
          type = 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT';
        } else if (isGenImg) {
          type = 'CORTEX_STEP_TYPE_GENERATE_IMAGE';
        } else if (
          rec.stepTypeNum === 132 &&
          (inRunningTail || ACTIVE_TASK_STEP_STATUS_NUMS.has(rec.statusNum))
        ) {
          type = mapRunningGenericToolStepType(rec.metadata?.toolCall?.name);
        } else {
          type = decodeProtoStepTypeEnum(rec.stepTypeNum);
        }
        const status = decodeProtoStepStatusEnum(rec.statusNum);
        const metadata = rec.metadata;
        const stepIdx = metadata.sourceTrajectoryStepInfo?.stepIndex ?? rec.idx;
        const gm = genByStep.get(Number(stepIdx));
        if (metadata.modelUsage && gm?.chatModel?.model && !metadata.modelUsage.model) {
          metadata.modelUsage.model = gm.chatModel.model;
        }

        const stepObj = { idx: rec.idx, type, status, metadata };
        const taskDetails = taskDetailsByIdx?.get(rec.idx);
        if (taskDetails) {
          stepObj.taskDetails = taskDetails;
        }
        const decodedPayload = decodedPayloadByIdx.get(rec.idx);
        if (decodedPayload) {
          if (decodedPayload.userInput) {
            stepObj.userInput = decodedPayload.userInput;
            if (!tailFirstOwnUserPrompt && decodedPayload.userInput.userResponse) {
              tailFirstOwnUserPrompt = cleanShortPromptTitle(
                decodedPayload.userInput.userResponse,
                80
              );
            }
          }
          if (decodedPayload.systemMessage) {
            stepObj.systemMessage = decodedPayload.systemMessage;
            stepObj.content = decodedPayload.systemMessage.message;
          }
          if (decodedPayload.plannerResponse) {
            stepObj.plannerResponse = decodedPayload.plannerResponse;
          }
          if (decodedPayload.errorMessage) {
            stepObj.errorMessage = decodedPayload.errorMessage;
          }
          if (decodedPayload.invokeSubagent) {
            stepObj.invokeSubagent = decodedPayload.invokeSubagent;
          }
          if (decodedPayload.generateImage) {
            stepObj.generateImage = decodedPayload.generateImage;
          }
        }
        steps.push(stepObj);
      }

      const mergedMetadata = cursor.trajectoryMetadata || {
        parentConversationId: cursor.parentConversationId || '',
        rootConversationId: cursor.rootConversationId || '',
      };

      return {
        incremental: true,
        cascadeId: normCid,
        numTotalSteps: rawTableStepCount,
        rawTableStepCount,
        maxGenIdx,
        maxRawStepIdx,
        isChildTrajectory,
        trajectoryType: Number(cursor.trajectoryType || 0),
        isSideQuestion: Boolean(cursor.isSideQuestion),
        forkParentConversationId: cursor.forkParentConversationId || '',
        firstOwnUserPrompt: cursor.firstOwnUserPrompt || tailFirstOwnUserPrompt,
        steps,
        generatorMetadata,
        rootConversationId: cursor.rootConversationId || mergedMetadata.rootConversationId || '',
        parentConversationId:
          cursor.parentConversationId || mergedMetadata.parentConversationId || '',
        trajectory: {
          metadata: mergedMetadata,
          steps,
          generatorMetadata,
        },
      };
    });
  } catch {
    return null;
  }
}

/**
 * 轻量读取本地 SQLite 会话库的父/根会话关联（不扫描或解码 `steps` 全表），
 * 供 `cli-statusline.mjs` 在当前 ID 为子代理时快速跳转至根会话库。
 *
 * @param {string} dbFilePath
 * @returns {{ parentConversationId: string, rootConversationId: string } | null}
 */
export function readLocalSqliteParentLink(dbFilePath) {
  if (!dbFilePath || !existsSync(dbFilePath)) return null;
  const DatabaseSync = getNodeSqliteDatabaseSync();
  if (!DatabaseSync) return null;

  const stem = basename(dbFilePath).replace(/\.db$/i, '').trim().toLowerCase();
  const normCid = UUID_FILE_RE.test(stem) ? stem : '';

  try {
    return withReadOnlySqliteDb(dbFilePath, (db) => {
      let parentConversationId = '';
      let rootConversationId = '';
      try {
        const blobRow = db
          .prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main' LIMIT 1")
          .get();
        const blobBuf = toUint8Array(blobRow?.data);
        if (blobBuf && blobBuf.length > 0) {
          const tm = decodeProtoTrajectoryMetadataSlice(blobBuf, { off: 0 }, blobBuf.length);
          parentConversationId = tm.parentConversationId || '';
          rootConversationId = tm.rootConversationId || '';
        }
      } catch {
        // 兼容未包含 trajectory_metadata_blob 的精简库
      }

      if (!parentConversationId && !rootConversationId) {
        try {
          const genRow = db
            .prepare('SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 1')
            .get();
          if (genRow?.data) {
            const decoded = decodeProtoGeneratorMeta(genRow.data, false);
            const gmCid = String(decoded?.extraMeta?.cascade_id || '').trim().toLowerCase();
            if (!gmCid || !normCid || gmCid === normCid) {
              if (decoded?.extraMeta?.root_cascade_id) {
                rootConversationId = String(decoded.extraMeta.root_cascade_id).trim().toLowerCase();
              }
              if (decoded?.extraMeta?.parent_cascade_id) {
                parentConversationId = String(decoded.extraMeta.parent_cascade_id).trim().toLowerCase();
              }
            }
          }
        } catch {
          // 忽略 gen_metadata 探测异常
        }
      }

      return { parentConversationId, rootConversationId };
    });
  } catch {
    return null;
  }
}

/**
 * 仅读取本地 SQLite 会话库末尾 `tailLimit` 步（`ORDER BY idx DESC LIMIT ?`），
 * 供旁路运行会话活体检测（`extractLiveActivity`）使用，避免全表扫描与 `gen_metadata` 解码。
 *
 * @param {string} dbFilePath
 * @param {number} [tailLimit=16]
 * @returns {{ cascadeId: string, steps: object[] } | null}
 */
export function readLocalSqliteLiveTail(dbFilePath, tailLimit = 16) {
  if (!dbFilePath || !existsSync(dbFilePath)) return null;
  const DatabaseSync = getNodeSqliteDatabaseSync();
  if (!DatabaseSync) return null;

  const limit = Math.max(1, Math.min(64, Math.floor(Number(tailLimit) || 16)));
  let normCid = '';
  const stem = basename(dbFilePath).replace(/\.db$/i, '').trim().toLowerCase();
  if (UUID_FILE_RE.test(stem)) {
    normCid = stem;
  }

  try {
    return withReadOnlySqliteDb(dbFilePath, (db) => {
      if (!normCid) {
        try {
          const metaRow = db.prepare('SELECT cascade_id FROM trajectory_meta LIMIT 1').get();
          if (metaRow?.cascade_id) {
            normCid = String(metaRow.cascade_id).trim().toLowerCase();
          }
        } catch {
          // 忽略无 trajectory_meta 的库
        }
      }

      const descRows = db
        .prepare('SELECT idx, step_type, status, metadata FROM steps ORDER BY idx DESC LIMIT ?')
        .all(limit);
      if (!descRows || descRows.length === 0) {
        return { cascadeId: normCid, steps: [] };
      }

      const ascRows = descRows.slice().reverse();
      const ownStepRecords = [];
      const payloadIndices = [];
      for (const row of ascRows) {
        const idx = Number.isFinite(Number(row?.idx)) ? Number(row.idx) : ownStepRecords.length;
        const stepTypeNum = Number(row?.step_type || 0);
        const statusNum = Number(row?.status || 0);
        let metadata = { sourceTrajectoryStepInfo: { stepIndex: idx } };
        if (row?.metadata && row.metadata.byteLength > 0) {
          try {
            metadata = decodeProtoStepMeta(row.metadata, idx);
          } catch {
            // 忽略单步元数据解码异常
          }
        }
        const originCid = String(metadata.sourceTrajectoryStepInfo?.cascadeId || '')
          .trim()
          .toLowerCase();
        if (originCid && normCid && originCid !== normCid) continue;
        ownStepRecords.push({ idx, stepTypeNum, statusNum, metadata });
        if (stepTypeNum !== 132 || !metadata?.toolCall?.argumentsJson) {
          payloadIndices.push(idx);
        }
      }

      const payloadByIdx = new Map();
      if (payloadIndices.length > 0) {
        try {
          const placeholders = payloadIndices.map(() => '?').join(',');
          const pRows = db
            .prepare(`SELECT idx, step_payload FROM steps WHERE idx IN (${placeholders})`)
            .all(...payloadIndices);
          for (const pRow of pRows || []) {
            if (pRow?.step_payload && pRow.step_payload.byteLength > 0) {
              payloadByIdx.set(Number(pRow.idx), pRow.step_payload);
            }
          }
        } catch {
          // 兼容不含 step_payload 列的旧表
        }
      }

      const runningTaskIndices = ownStepRecords
        .filter((rec) => ACTIVE_TASK_STEP_STATUS_NUMS.has(rec.statusNum))
        .map((rec) => rec.idx);
      const taskDetailsByIdx =
        runningTaskIndices.length > 0 ? fetchRunningTaskDetailsMap(db, runningTaskIndices) : null;

      const steps = [];
      for (const rec of ownStepRecords) {
        const isInvSub =
          rec.stepTypeNum === 127 ||
          (rec.stepTypeNum === 132 && isInvokeSubagentToolName(rec.metadata?.toolCall?.name));
        let type = '';
        if (isInvSub) {
          type = 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT';
        } else if (rec.stepTypeNum === 132) {
          type = mapRunningGenericToolStepType(rec.metadata?.toolCall?.name);
        } else {
          type = decodeProtoStepTypeEnum(rec.stepTypeNum);
        }
        const status = decodeProtoStepStatusEnum(rec.statusNum);
        const stepObj = { idx: rec.idx, type, status, metadata: rec.metadata };
        const taskDetails = taskDetailsByIdx?.get(rec.idx);
        if (taskDetails) {
          stepObj.taskDetails = taskDetails;
        }
        const rawPayload = payloadByIdx.get(rec.idx);
        if (rawPayload) {
          try {
            const decodedPayload = decodeProtoSelectiveStepPayload(rawPayload, {
              stepTypeNum: rec.stepTypeNum,
              isInvokeSubagent: isInvSub,
              includeSystemMessage: false,
              keepFullText: true,
            });
            if (decodedPayload.userInput) stepObj.userInput = decodedPayload.userInput;
            if (decodedPayload.plannerResponse) stepObj.plannerResponse = decodedPayload.plannerResponse;
            if (decodedPayload.errorMessage) stepObj.errorMessage = decodedPayload.errorMessage;
            if (decodedPayload.invokeSubagent) stepObj.invokeSubagent = decodedPayload.invokeSubagent;
          } catch {
            // 忽略单步载荷解析异常
          }
        }
        steps.push(stepObj);
      }

      return { cascadeId: normCid, steps };
    });
  } catch {
    return null;
  }
}

/**
 * 轻量查询本地 SQLite 会话库中所有仍处于活跃态（`PENDING`/`RUNNING`/`GENERATING`/`WAITING`/`QUEUED`）
 * 且携带 `task_details` 的非守护后台任务步骤（跳过 `IsDaemon: true` 常驻进程与克隆自父会话的步骤）。
 *
 * 仅在摘要标记 `not_fully_idle = 1` 时按需调用，用于捕获「模型回合已结束但后台仍有命令/定时任务运行」的会话状态。
 *
 * @param {string} dbFilePath
 * @returns {object[]}
 */
export function readLocalSqliteActiveTasks(dbFilePath) {
  if (!dbFilePath || !existsSync(dbFilePath)) return [];
  const DatabaseSync = getNodeSqliteDatabaseSync();
  if (!DatabaseSync) return [];

  let normCid = '';
  const stem = basename(dbFilePath).replace(/\.db$/i, '').trim().toLowerCase();
  if (UUID_FILE_RE.test(stem)) {
    normCid = stem;
  }

  try {
    const res = withReadOnlySqliteDb(dbFilePath, (db) => {
      if (!normCid) {
        try {
          const metaRow = db.prepare('SELECT cascade_id FROM trajectory_meta LIMIT 1').get();
          if (metaRow?.cascade_id) {
            normCid = String(metaRow.cascade_id).trim().toLowerCase();
          }
        } catch {
          // 忽略无 trajectory_meta 的库
        }
      }

      let rows = [];
      try {
        rows = db
          .prepare(
            `SELECT idx, step_type, status, metadata, task_details
             FROM steps
             WHERE status IN (${ACTIVE_TASK_STATUS_SQL})
               AND task_details IS NOT NULL
               AND length(task_details) > 0
             ORDER BY idx ASC`
          )
          .all();
      } catch {
        // 兼容不含 task_details 列的旧版 SQLite 表结构
        return [];
      }
      if (!Array.isArray(rows) || rows.length === 0) return [];

      const activeTasks = [];
      for (const row of rows) {
        const idx = Number(row?.idx);
        if (!Number.isFinite(idx)) continue;
        const stepTypeNum = Number(row?.step_type || 0);
        const statusNum = Number(row?.status || 0);
        if (!ACTIVE_TASK_STEP_STATUS_NUMS.has(statusNum)) continue;

        let metadata = { sourceTrajectoryStepInfo: { stepIndex: idx } };
        if (row?.metadata && row.metadata.byteLength > 0) {
          try {
            metadata = decodeProtoStepMeta(row.metadata, idx);
          } catch {
            // 忽略单步元数据解码异常
          }
        }
        const originCid = String(metadata.sourceTrajectoryStepInfo?.cascadeId || '')
          .trim()
          .toLowerCase();
        if (originCid && normCid && originCid !== normCid) continue;
        if (isDaemonBackgroundTaskCall(metadata?.toolCall)) continue;

        let taskDetails = null;
        if (row?.task_details && row.task_details.byteLength > 0) {
          try {
            taskDetails = decodeProtoTaskDetails(row.task_details);
          } catch {
            taskDetails = null;
          }
        }
        if (!taskDetails) continue;

        const isInvSub =
          stepTypeNum === 127 ||
          (stepTypeNum === 132 && isInvokeSubagentToolName(metadata?.toolCall?.name));
        const type = isInvSub
          ? 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT'
          : stepTypeNum === 132
            ? mapRunningGenericToolStepType(metadata?.toolCall?.name)
            : decodeProtoStepTypeEnum(stepTypeNum);
        const status = decodeProtoStepStatusEnum(statusNum);
        activeTasks.push({ idx, type, status, metadata, taskDetails });
      }
      return activeTasks;
    });
    return Array.isArray(res) ? res : [];
  } catch {
    return [];
  }
}
