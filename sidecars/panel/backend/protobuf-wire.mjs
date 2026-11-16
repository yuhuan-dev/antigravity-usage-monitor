/**
 * @fileoverview Zero-dependency Uint8Array Protobuf wire decoder and official
 * Antigravity / Cortex enum mapping layer for Option C direct SQLite reading.
 *
 * Compatible with both native Node.js ESM (`node:sqlite` `DatabaseSync`
 * returning `Uint8Array` BLOBs) and `backend-harness.mjs` VM concatenation
 * (`stripModuleSyntax`).
 */

const pbTextDecoder =
  typeof TextDecoder === 'function' ? new TextDecoder('utf-8') : null;

const PB_MODEL_STATIC_MAP = Object.freeze({
  235: 'MODEL_CHAT_20706',
  246: 'MODEL_GOOGLE_GEMINI_2_5_PRO',
  269: 'MODEL_CHAT_23310',
  281: 'MODEL_CLAUDE_4_SONNET',
  282: 'MODEL_CLAUDE_4_SONNET_THINKING',
  290: 'MODEL_CLAUDE_4_OPUS',
  291: 'MODEL_CLAUDE_4_OPUS_THINKING',
  312: 'MODEL_GOOGLE_GEMINI_2_5_FLASH',
  313: 'MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING',
  323: 'MODEL_GOOGLE_GEMINI_TRAINING_POLICY',
  326: 'MODEL_GOOGLE_GEMINI_INTERNAL_BYOM',
  327: 'MODEL_GOOGLE_GEMINI_FOR_GOOGLE_2_5_PRO',
  328: 'MODEL_GOOGLE_GEMINI_NEMOSREEF',
  329: 'MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING_TOOLS',
  330: 'MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE',
  331: 'MODEL_GOOGLE_GEMINI_2_5_PRO_EVAL',
  332: 'MODEL_GOOGLE_GEMINI_2_5_FLASH_IMAGE_PREVIEW',
  333: 'MODEL_CLAUDE_4_5_SONNET',
  334: 'MODEL_CLAUDE_4_5_SONNET_THINKING',
  335: 'MODEL_GOOGLE_GEMINI_COMPUTER_USE_EXPERIMENTAL',
  336: 'MODEL_GOOGLE_GEMINI_HORIZONDAWN',
  337: 'MODEL_GOOGLE_GEMINI_PUREPRISM',
  338: 'MODEL_GOOGLE_GEMINI_GENTLEISLAND',
  339: 'MODEL_GOOGLE_GEMINI_RAINSONG',
  340: 'MODEL_CLAUDE_4_5_HAIKU',
  341: 'MODEL_CLAUDE_4_5_HAIKU_THINKING',
  342: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
  343: 'MODEL_GOOGLE_GEMINI_ORIONFIRE',
  344: 'MODEL_GOOGLE_GEMINI_INTERNAL_TAB_FLASH_LITE',
  345: 'MODEL_GOOGLE_GEMINI_INTERNAL_TAB_JUMP_FLASH_LITE',
  346: 'MODEL_GOOGLE_JARVIS_PROXY',
  347: 'MODEL_GOOGLE_GEMINI_COSMICFORGE',
  348: 'MODEL_GOOGLE_GEMINI_RIFTRUNNER',
  349: 'MODEL_GOOGLE_JARVIS_V4S',
  350: 'MODEL_GOOGLE_GEMINI_INFINITYJET',
  351: 'MODEL_GOOGLE_GEMINI_INFINITYBLOOM',
  352: 'MODEL_GOOGLE_GEMINI_RIFTRUNNER_THINKING_LOW',
  353: 'MODEL_GOOGLE_GEMINI_RIFTRUNNER_THINKING_HIGH',
  354: 'MODEL_GOOGLE_GEMINI_EXAMPLE_GEMAX_SAMPLER',
});

const PB_STEP_TYPE_MAP = Object.freeze({
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

const PB_STEP_STATUS_MAP = Object.freeze({
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

const PB_RUN_STATUS_MAP = Object.freeze({
  1: 'CASCADE_RUN_STATUS_IDLE',
  2: 'CASCADE_RUN_STATUS_RUNNING',
  3: 'CASCADE_RUN_STATUS_CANCELING',
  4: 'CASCADE_RUN_STATUS_BUSY',
});

const PB_TRAJECTORY_SOURCE_MAP = Object.freeze({
  1: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
  12: 'CORTEX_TRAJECTORY_SOURCE_INTERACTIVE_CASCADE',
  13: 'CORTEX_TRAJECTORY_SOURCE_REPLAY',
  15: 'CORTEX_TRAJECTORY_SOURCE_SDK',
  16: 'CORTEX_TRAJECTORY_SOURCE_SUBAGENT',
  17: 'CORTEX_TRAJECTORY_SOURCE_CLI',
  18: 'CORTEX_TRAJECTORY_SOURCE_JETBOX',
  19: 'CORTEX_TRAJECTORY_SOURCE_AGENT_API',
  20: 'CORTEX_TRAJECTORY_SOURCE_CIDER',
  21: 'CORTEX_TRAJECTORY_SOURCE_GEMINI_APP',
  22: 'CORTEX_TRAJECTORY_SOURCE_VSCODE',
  23: 'CORTEX_TRAJECTORY_SOURCE_VISUAL_STUDIO',
});

const PB_TOKEN_TYPE_MAP = Object.freeze({
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

const PB_TOKEN_SOURCE_MAP = Object.freeze({
  1: 'TOKEN_SOURCE_SYSTEM',
  2: 'TOKEN_SOURCE_USER',
});

const PB_CHAT_MESSAGE_SOURCE_MAP = Object.freeze({
  1: 'CHAT_MESSAGE_SOURCE_USER',
  2: 'CHAT_MESSAGE_SOURCE_SYSTEM',
  3: 'CHAT_MESSAGE_SOURCE_UNKNOWN',
  4: 'CHAT_MESSAGE_SOURCE_TOOL',
  5: 'CHAT_MESSAGE_SOURCE_SYSTEM_PROMPT',
  6: 'CHAT_MESSAGE_SOURCE_CONTEXT',
});

const PB_API_PROVIDER_MAP = Object.freeze({
  1: 'API_PROVIDER_INTERNAL',
  3: 'API_PROVIDER_GOOGLE_VERTEX',
  24: 'API_PROVIDER_GOOGLE_GEMINI',
  26: 'API_PROVIDER_ANTHROPIC_VERTEX',
  30: 'API_PROVIDER_GOOGLE_EVERGREEN',
  31: 'API_PROVIDER_OPENAI_VERTEX',
  32: 'API_PROVIDER_OPENAI_RESPONSES_VERTEX',
});

export function pbMapModelEnum(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v >= 1000) return `MODEL_PLACEHOLDER_M${Math.trunc(v) - 1000}`;
  return PB_MODEL_STATIC_MAP[Math.trunc(v)] || '';
}

export function pbMapStepType(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return '';
  return PB_STEP_TYPE_MAP[Math.trunc(v)] || '';
}

export function pbMapStepStatus(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return '';
  return PB_STEP_STATUS_MAP[Math.trunc(v)] || '';
}

export function pbMapRunStatus(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return '';
  return PB_RUN_STATUS_MAP[Math.trunc(v)] || '';
}

export function pbMapTrajectorySource(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return '';
  return PB_TRAJECTORY_SOURCE_MAP[Math.trunc(v)] || '';
}

export function pbMapTokenType(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return '';
  return PB_TOKEN_TYPE_MAP[Math.trunc(v)] || '';
}

export function pbMapTokenSource(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return '';
  return PB_TOKEN_SOURCE_MAP[Math.trunc(v)] || '';
}

export function pbMapChatMessageSource(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return '';
  return PB_CHAT_MESSAGE_SOURCE_MAP[Math.trunc(v)] || '';
}

export function pbMapApiProvider(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return '';
  return PB_API_PROVIDER_MAP[Math.trunc(v)] || '';
}

export function pbAsUint8Array(raw) {
  if (!raw) return null;
  if (raw instanceof Uint8Array) return raw;
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }
  if (raw instanceof ArrayBuffer) {
    return new Uint8Array(raw);
  }
  return null;
}

function pbDecodeUtf8(u8, start, end) {
  if (start >= end) return '';
  if (pbTextDecoder) {
    return pbTextDecoder.decode(u8.subarray(start, end));
  }
  if (typeof Buffer === 'function') {
    return Buffer.from(u8.buffer, u8.byteOffset + start, end - start).toString('utf8');
  }
  let out = '';
  for (let i = start; i < end; i++) {
    out += String.fromCharCode(u8[i]);
  }
  return out;
}

function pbCreateReader(raw) {
  const u8 = pbAsUint8Array(raw);
  if (!u8 || u8.length === 0) return null;
  return { u8, pos: 0, end: u8.length };
}

/**
 * Reads a Protobuf varint (up to 10 bytes, including 10-byte sign-extended
 * negative `int32`/`int64` values) as an unsigned 64-bit `BigInt`.
 */
export function pbReadVarintBigIntAt(raw, startPos = 0, endPos = null) {
  const u8 = pbAsUint8Array(raw);
  if (!u8) return { value: 0n, nextPos: startPos };
  const limit = endPos === null ? u8.length : Math.min(u8.length, endPos);
  const r = { u8, pos: startPos, end: limit };
  const value = pbReadVarint64(r, limit);
  return { value, nextPos: r.pos };
}

function pbReadVarint64(r, limit) {
  if (r.pos >= limit) return 0n;
  const b0 = r.u8[r.pos];
  if (b0 < 0x80) {
    r.pos += 1;
    return BigInt(b0);
  }
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10 && r.pos < limit; i++) {
    const byte = r.u8[r.pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return BigInt.asUintN(64, result);
    }
    shift += 7n;
  }
  while (r.pos < limit && (r.u8[r.pos++] & 0x80) !== 0) {
    // Drain malformed >10-byte varint continuation bytes safely.
  }
  return BigInt.asUintN(64, result);
}

function pbReadTag(r, limit) {
  if (r.pos >= limit) return 0;
  const b0 = r.u8[r.pos];
  if (b0 < 0x80) {
    r.pos += 1;
    return b0;
  }
  const b1 = r.pos + 1 < limit ? r.u8[r.pos + 1] : 0;
  if (b1 < 0x80 && r.pos + 1 < limit) {
    r.pos += 2;
    return (b0 & 0x7f) | (b1 << 7);
  }
  return Number(BigInt.asUintN(32, pbReadVarint64(r, limit)));
}

function pbReadInt32(r, limit) {
  return Number(BigInt.asIntN(32, pbReadVarint64(r, limit)));
}

function pbReadInt64(r, limit) {
  return BigInt.asIntN(64, pbReadVarint64(r, limit));
}

function pbReadUint32(r, limit) {
  return Number(BigInt.asUintN(32, pbReadVarint64(r, limit)));
}

function pbReadUint64Token(r, limit) {
  const u64 = BigInt.asUintN(64, pbReadVarint64(r, limit));
  return u64 <= 9007199254740991n ? Number(u64) : u64.toString();
}

function pbReadBool(r, limit) {
  return pbReadVarint64(r, limit) !== 0n;
}

function pbReadSubEnd(r, limit) {
  const byteLen = pbReadUint32(r, limit);
  return Math.min(limit, r.pos + byteLen);
}

function pbReadString(r, limit) {
  const subEnd = pbReadSubEnd(r, limit);
  const str = pbDecodeUtf8(r.u8, r.pos, subEnd);
  r.pos = subEnd;
  return str;
}

function pbReadRepeatedUint32(r, wireType, limit, outArr) {
  if (wireType === 2) {
    const subEnd = pbReadSubEnd(r, limit);
    while (r.pos < subEnd) {
      outArr.push(pbReadUint32(r, subEnd));
    }
    r.pos = subEnd;
  } else if (wireType === 0) {
    outArr.push(pbReadUint32(r, limit));
  } else {
    pbSkipField(r, wireType, limit);
  }
}

function pbReadRepeatedInt32(r, wireType, limit, outArr) {
  if (wireType === 2) {
    const subEnd = pbReadSubEnd(r, limit);
    while (r.pos < subEnd) {
      outArr.push(pbReadInt32(r, subEnd));
    }
    r.pos = subEnd;
  } else if (wireType === 0) {
    outArr.push(pbReadInt32(r, limit));
  } else {
    pbSkipField(r, wireType, limit);
  }
}

function pbSkipField(r, wireType, limit) {
  switch (wireType) {
    case 0:
      pbReadVarint64(r, limit);
      break;
    case 1:
      r.pos = Math.min(limit, r.pos + 8);
      break;
    case 2: {
      const len = pbReadUint32(r, limit);
      r.pos = Math.min(limit, r.pos + len);
      break;
    }
    case 5:
      r.pos = Math.min(limit, r.pos + 4);
      break;
    case 3: {
      while (r.pos < limit) {
        const innerTag = pbReadTag(r, limit);
        const innerWire = innerTag & 7;
        if (innerWire === 4) break;
        pbSkipField(r, innerWire, limit);
      }
      break;
    }
    case 4:
      break;
    default:
      r.pos = limit;
      break;
  }
}

/**
 * Formats a `google.protobuf.Timestamp` `{ seconds, nanos }` into an exact
 * RFC 3339 UTC string matching `speed-metrics.mjs` `timestampNs()` regex
 * `/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/`.
 */
export function pbFormatTimestamp(secondsInput, nanosInput = 0) {
  let sec = typeof secondsInput === 'bigint' ? secondsInput : BigInt(Math.trunc(Number(secondsInput || 0)));
  let nanos = Math.trunc(Number(nanosInput || 0));
  if (nanos < 0 || nanos >= 1_000_000_000) {
    const carry = BigInt(Math.floor(nanos / 1_000_000_000));
    sec += carry;
    nanos -= Number(carry) * 1_000_000_000;
  }
  if (sec <= 0n || sec > 253402300799n) {
    return '';
  }
  const baseIso = new Date(Number(sec) * 1000).toISOString().slice(0, 19);
  if (nanos === 0) {
    return `${baseIso}Z`;
  }
  if (nanos % 1_000_000 === 0) {
    return `${baseIso}.${String(nanos / 1_000_000).padStart(3, '0')}Z`;
  }
  if (nanos % 1_000 === 0) {
    return `${baseIso}.${String(nanos / 1_000).padStart(6, '0')}Z`;
  }
  return `${baseIso}.${String(nanos).padStart(9, '0')}Z`;
}

/**
 * Formats a `google.protobuf.Duration` `{ seconds, nanos }` into a Protobuf
 * Duration string matching `speed-metrics.mjs` `duration()` regex
 * `/^\d+(?:\.\d+)?s$/` (e.g. `"0.85s"`, `"11.156299627s"`, `"0s"`).
 */
export function pbFormatDuration(secondsInput, nanosInput = 0) {
  const sec = typeof secondsInput === 'bigint' ? secondsInput : BigInt(Math.trunc(Number(secondsInput || 0)));
  const nanos = BigInt(Math.trunc(Number(nanosInput || 0)));
  const totalNs = sec * 1_000_000_000n + nanos;
  if (totalNs < 0n) {
    return '';
  }
  if (totalNs === 0n) {
    return '0s';
  }
  const wholeSec = totalNs / 1_000_000_000n;
  const remNs = Number(totalNs % 1_000_000_000n);
  if (remNs === 0) {
    return `${wholeSec}s`;
  }
  const frac = String(remNs).padStart(9, '0').replace(/0+$/, '');
  return `${wholeSec}.${frac}s`;
}

function pbDecodeTimestampSub(r, subEnd) {
  let seconds = 0n;
  let nanos = 0;
  while (r.pos < subEnd) {
    const tag = pbReadTag(r, subEnd);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 1 && wireType === 0) {
      seconds = pbReadInt64(r, subEnd);
    } else if (fieldNo === 2 && wireType === 0) {
      nanos = pbReadInt32(r, subEnd);
    } else {
      pbSkipField(r, wireType, subEnd);
    }
  }
  r.pos = subEnd;
  return pbFormatTimestamp(seconds, nanos);
}

function pbDecodeDurationSub(r, subEnd) {
  let seconds = 0n;
  let nanos = 0;
  while (r.pos < subEnd) {
    const tag = pbReadTag(r, subEnd);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 1 && wireType === 0) {
      seconds = pbReadInt64(r, subEnd);
    } else if (fieldNo === 2 && wireType === 0) {
      nanos = pbReadInt32(r, subEnd);
    } else {
      pbSkipField(r, wireType, subEnd);
    }
  }
  r.pos = subEnd;
  return pbFormatDuration(seconds, nanos);
}

function pbDecodeStringMapEntrySub(r, subEnd, targetObj, lowerKey = false) {
  let k = '';
  let v = '';
  while (r.pos < subEnd) {
    const tag = pbReadTag(r, subEnd);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 1 && wireType === 2) {
      k = pbReadString(r, subEnd);
    } else if (fieldNo === 2 && wireType === 2) {
      v = pbReadString(r, subEnd);
    } else {
      pbSkipField(r, wireType, subEnd);
    }
  }
  r.pos = subEnd;
  const finalKey = lowerKey ? k.trim().toLowerCase() : k;
  if (finalKey) {
    targetObj[finalKey] = v;
  }
}

function pbDecodeSubagentSpecSub(r, subEnd) {
  let typeName = '';
  let role = '';
  while (r.pos < subEnd) {
    const tag = pbReadTag(r, subEnd);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 1 && wireType === 2) {
      typeName = pbReadString(r, subEnd).trim();
    } else if (fieldNo === 2 && wireType === 2) {
      role = pbReadString(r, subEnd).trim();
    } else {
      pbSkipField(r, wireType, subEnd);
    }
  }
  r.pos = subEnd;
  if (!typeName && !role) return null;
  return { typeName, role };
}

function pbDecodeSubagentResultSub(r, subEnd) {
  let conversationId = '';
  while (r.pos < subEnd) {
    const tag = pbReadTag(r, subEnd);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 1 && wireType === 2) {
      conversationId = pbReadString(r, subEnd).trim().toLowerCase();
    } else {
      pbSkipField(r, wireType, subEnd);
    }
  }
  r.pos = subEnd;
  return { conversationId };
}

function pbDecodeAgentScriptSub(r, subEnd) {
  let name = '';
  while (r.pos < subEnd) {
    const tag = pbReadTag(r, subEnd);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 1 && wireType === 2) {
      name = pbReadString(r, subEnd).trim();
    } else {
      pbSkipField(r, wireType, subEnd);
    }
  }
  r.pos = subEnd;
  return name ? { name } : null;
}

function pbDecodeTrajectoryMetadataSub(r, subEnd) {
  let createdAt = '';
  let parentConversationId = '';
  let rootConversationId = '';
  let nestingDepth = 0;
  let subagentSpec = null;
  let agentScript = null;

  while (r.pos < subEnd) {
    const tag = pbReadTag(r, subEnd);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 2 && wireType === 2) {
      createdAt = pbDecodeTimestampSub(r, pbReadSubEnd(r, subEnd));
    } else if (fieldNo === 4 && wireType === 2) {
      agentScript = pbDecodeAgentScriptSub(r, pbReadSubEnd(r, subEnd));
    } else if (fieldNo === 5 && wireType === 2) {
      parentConversationId = pbReadString(r, subEnd).trim().toLowerCase();
    } else if (fieldNo === 6 && wireType === 2) {
      rootConversationId = pbReadString(r, subEnd).trim().toLowerCase();
    } else if (fieldNo === 8 && wireType === 2) {
      subagentSpec = pbDecodeSubagentSpecSub(r, pbReadSubEnd(r, subEnd));
    } else if (fieldNo === 17 && wireType === 0) {
      nestingDepth = pbReadInt32(r, subEnd);
    } else {
      pbSkipField(r, wireType, subEnd);
    }
  }
  r.pos = subEnd;
  return {
    createdAt,
    parentConversationId,
    rootConversationId,
    nestingDepth,
    subagentSpec,
    agentScript,
  };
}

export function pbDecodeTrajectoryMetadata(rawBytes) {
  const r = pbCreateReader(rawBytes);
  if (!r) {
    return {
      createdAt: '',
      parentConversationId: '',
      rootConversationId: '',
      nestingDepth: 0,
      subagentSpec: null,
      agentScript: null,
    };
  }
  return pbDecodeTrajectoryMetadataSub(r, r.end);
}

function pbDecodeConversationAnnotationsSub(r, subEnd) {
  let title = '';
  let archived = false;
  const sideQuestionCascadeIds = [];
  const sideQuestionTitles = {};

  while (r.pos < subEnd) {
    const tag = pbReadTag(r, subEnd);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 1 && wireType === 2) {
      title = pbReadString(r, subEnd);
    } else if (fieldNo === 4 && wireType === 0) {
      archived = pbReadBool(r, subEnd);
    } else if (fieldNo === 17 && wireType === 2) {
      const sqId = pbReadString(r, subEnd).trim().toLowerCase();
      if (sqId) sideQuestionCascadeIds.push(sqId);
    } else if (fieldNo === 18 && wireType === 2) {
      pbDecodeStringMapEntrySub(r, pbReadSubEnd(r, subEnd), sideQuestionTitles, true);
    } else {
      pbSkipField(r, wireType, subEnd);
    }
  }
  r.pos = subEnd;
  return {
    title,
    archived,
    sideQuestionCascadeIds,
    sideQuestionTitles,
  };
}

export function pbDecodeCascadeTrajectorySummary(rawBytes) {
  const r = pbCreateReader(rawBytes);
  if (!r) return null;

  let summary = '';
  let stepCount = 0;
  let lastModifiedTime = '';
  let status = '';
  let createdTime = '';
  let annotations = {
    title: '',
    archived: false,
    sideQuestionCascadeIds: [],
    sideQuestionTitles: {},
  };
  let trajectoryMetadata = {
    createdAt: '',
    parentConversationId: '',
    rootConversationId: '',
    nestingDepth: 0,
    subagentSpec: null,
    agentScript: null,
  };
  let source = '';
  let notFullyIdle = false;
  let trajectoryType = 0;
  let killed = false;
  let forkParentConversationId = '';

  while (r.pos < r.end) {
    const tag = pbReadTag(r, r.end);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 1 && wireType === 2) {
      summary = pbReadString(r, r.end);
    } else if (fieldNo === 2 && wireType === 0) {
      stepCount = pbReadUint32(r, r.end);
    } else if (fieldNo === 3 && wireType === 2) {
      lastModifiedTime = pbDecodeTimestampSub(r, pbReadSubEnd(r, r.end));
    } else if (fieldNo === 5 && wireType === 0) {
      status = pbMapRunStatus(pbReadUint32(r, r.end));
    } else if (fieldNo === 7 && wireType === 2) {
      createdTime = pbDecodeTimestampSub(r, pbReadSubEnd(r, r.end));
    } else if (fieldNo === 15 && wireType === 2) {
      annotations = pbDecodeConversationAnnotationsSub(r, pbReadSubEnd(r, r.end));
    } else if (fieldNo === 17 && wireType === 2) {
      trajectoryMetadata = pbDecodeTrajectoryMetadataSub(r, pbReadSubEnd(r, r.end));
    } else if (fieldNo === 20 && wireType === 0) {
      source = pbMapTrajectorySource(pbReadUint32(r, r.end));
    } else if (fieldNo === 21 && wireType === 0) {
      notFullyIdle = pbReadBool(r, r.end);
    } else if (fieldNo === 22 && wireType === 0) {
      trajectoryType = pbReadUint32(r, r.end);
    } else if (fieldNo === 23 && wireType === 0) {
      killed = pbReadBool(r, r.end);
    } else if (fieldNo === 24 && wireType === 2) {
      forkParentConversationId = pbReadString(r, r.end).trim().toLowerCase();
    } else {
      pbSkipField(r, wireType, r.end);
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
    annotations,
    trajectoryMetadata,
  };
}

export function pbDecodeTrajectoryReference(rawBytes) {
  const r = pbCreateReader(rawBytes);
  if (!r) return null;

  let trajectoryId = '';
  let stepIndex = 0;
  let trajectoryType = 0;
  let stepType = '';
  let referenceType = 0;
  let conversationId = '';

  while (r.pos < r.end) {
    const tag = pbReadTag(r, r.end);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 1 && wireType === 2) {
      trajectoryId = pbReadString(r, r.end);
    } else if (fieldNo === 2 && wireType === 0) {
      stepIndex = pbReadInt32(r, r.end);
    } else if (fieldNo === 3 && wireType === 0) {
      trajectoryType = pbReadInt32(r, r.end);
    } else if (fieldNo === 4 && wireType === 0) {
      stepType = pbMapStepType(pbReadUint32(r, r.end));
    } else if (fieldNo === 5 && wireType === 0) {
      referenceType = pbReadInt32(r, r.end);
    } else if (fieldNo === 6 && wireType === 2) {
      conversationId = pbReadString(r, r.end).trim().toLowerCase();
    } else {
      pbSkipField(r, wireType, r.end);
    }
  }

  return {
    trajectoryId,
    stepIndex,
    trajectoryType,
    stepType,
    referenceType,
    conversationId,
  };
}

function pbDecodeModelUsageStatsSub(r, subEnd) {
  // Follow Proto3 JSON omission rules: leave zero/unset fields undefined so
  // speed-metrics.mjs handles responseOutputTokens and 0-output steps identically
  // to Connect RPC JSON.
  const usage = {};
  while (r.pos < subEnd) {
    const tag = pbReadTag(r, subEnd);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 1 && wireType === 0) {
      const m = pbMapModelEnum(pbReadUint32(r, subEnd));
      if (m) usage.model = m;
    } else if (fieldNo === 2 && wireType === 0) {
      const v = pbReadUint64Token(r, subEnd);
      if (v !== 0 && v !== '0') usage.inputTokens = v;
    } else if (fieldNo === 3 && wireType === 0) {
      const v = pbReadUint64Token(r, subEnd);
      if (v !== 0 && v !== '0') usage.outputTokens = v;
    } else if (fieldNo === 4 && wireType === 0) {
      const v = pbReadUint64Token(r, subEnd);
      if (v !== 0 && v !== '0') usage.cacheWriteTokens = v;
    } else if (fieldNo === 5 && wireType === 0) {
      const v = pbReadUint64Token(r, subEnd);
      if (v !== 0 && v !== '0') usage.cacheReadTokens = v;
    } else if (fieldNo === 6 && wireType === 0) {
      const ap = pbMapApiProvider(pbReadUint32(r, subEnd));
      if (ap) usage.apiProvider = ap;
    } else if (fieldNo === 9 && wireType === 0) {
      const v = pbReadUint64Token(r, subEnd);
      if (v !== 0 && v !== '0') usage.thinkingOutputTokens = v;
    } else if (fieldNo === 10 && wireType === 0) {
      const v = pbReadUint64Token(r, subEnd);
      if (v !== 0 && v !== '0') usage.responseOutputTokens = v;
    } else {
      pbSkipField(r, wireType, subEnd);
    }
  }
  r.pos = subEnd;
  return usage;
}

function pbDecodeRetryInfoSub(r, subEnd) {
  const info = {};
  while (r.pos < subEnd) {
    const tag = pbReadTag(r, subEnd);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 2 && wireType === 2) {
      info.usage = pbDecodeModelUsageStatsSub(r, pbReadSubEnd(r, subEnd));
    } else if (fieldNo === 3 && wireType === 2) {
      const err = pbReadString(r, subEnd);
      if (err) info.error = err;
    } else if (fieldNo === 4 && wireType === 2) {
      const tid = pbReadString(r, subEnd);
      if (tid) info.traceId = tid;
    } else {
      pbSkipField(r, wireType, subEnd);
    }
  }
  r.pos = subEnd;
  return info;
}

function pbDecodeToolCallSub(r, subEnd, includeArgs = true) {
  const tc = {};
  while (r.pos < subEnd) {
    const tag = pbReadTag(r, subEnd);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 1 && wireType === 2) {
      tc.id = pbReadString(r, subEnd);
    } else if (fieldNo === 2 && wireType === 2) {
      tc.name = pbReadString(r, subEnd);
    } else if (fieldNo === 3 && wireType === 2) {
      if (includeArgs) {
        tc.argumentsJson = pbReadString(r, subEnd);
      } else {
        pbSkipField(r, wireType, subEnd);
      }
    } else {
      pbSkipField(r, wireType, subEnd);
    }
  }
  r.pos = subEnd;
  return tc;
}

function pbDecodeSourceTrajectoryStepInfoSub(r, subEnd, fallbackStepIdx) {
  let trajectoryId = '';
  let stepIndex = fallbackStepIdx;
  let metadataIndex = 0;
  let cascadeId = '';
  let sawStepIndex = false;

  while (r.pos < subEnd) {
    const tag = pbReadTag(r, subEnd);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 1 && wireType === 2) {
      trajectoryId = pbReadString(r, subEnd);
    } else if (fieldNo === 2 && wireType === 0) {
      stepIndex = pbReadUint32(r, subEnd);
      sawStepIndex = true;
    } else if (fieldNo === 3 && wireType === 0) {
      metadataIndex = pbReadUint32(r, subEnd);
    } else if (fieldNo === 4 && wireType === 2) {
      cascadeId = pbReadString(r, subEnd).trim().toLowerCase();
    } else {
      pbSkipField(r, wireType, subEnd);
    }
  }
  r.pos = subEnd;
  if (!sawStepIndex) {
    stepIndex = fallbackStepIdx;
  }
  return {
    trajectoryId,
    stepIndex,
    metadataIndex,
    cascadeId,
  };
}

export function pbDecodeStepMetadata(rawBytes, fallbackStepIdx = 0) {
  const r = pbCreateReader(rawBytes);
  if (!r) {
    return {
      sourceTrajectoryStepInfo: {
        trajectoryId: '',
        stepIndex: fallbackStepIdx,
        metadataIndex: 0,
        cascadeId: '',
      },
    };
  }

  const meta = {};
  let retryInfos = null;

  while (r.pos < r.end) {
    const tag = pbReadTag(r, r.end);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 1 && wireType === 2) {
      const ts = pbDecodeTimestampSub(r, pbReadSubEnd(r, r.end));
      if (ts) meta.createdAt = ts;
    } else if (fieldNo === 4 && wireType === 2) {
      meta.toolCall = pbDecodeToolCallSub(r, pbReadSubEnd(r, r.end), true);
    } else if (fieldNo === 6 && wireType === 2) {
      const ts = pbDecodeTimestampSub(r, pbReadSubEnd(r, r.end));
      if (ts) meta.viewableAt = ts;
    } else if (fieldNo === 7 && wireType === 2) {
      const ts = pbDecodeTimestampSub(r, pbReadSubEnd(r, r.end));
      if (ts) meta.finishedGeneratingAt = ts;
    } else if (fieldNo === 8 && wireType === 2) {
      const ts = pbDecodeTimestampSub(r, pbReadSubEnd(r, r.end));
      if (ts) meta.completedAt = ts;
    } else if (fieldNo === 9 && wireType === 2) {
      meta.modelUsage = pbDecodeModelUsageStatsSub(r, pbReadSubEnd(r, r.end));
    } else if (fieldNo === 11 && wireType === 0) {
      const gm = pbMapModelEnum(pbReadUint32(r, r.end));
      if (gm) meta.generatorModel = gm;
    } else if (fieldNo === 20 && wireType === 2) {
      meta.sourceTrajectoryStepInfo = pbDecodeSourceTrajectoryStepInfoSub(
        r,
        pbReadSubEnd(r, r.end),
        fallbackStepIdx
      );
    } else if (fieldNo === 28 && wireType === 2) {
      if (!retryInfos) retryInfos = [];
      retryInfos.push(pbDecodeRetryInfoSub(r, pbReadSubEnd(r, r.end)));
    } else if (fieldNo === 30 && wireType === 2) {
      const ts = pbReadString(r, r.end);
      if (ts) meta.toolSummary = ts;
    } else if (fieldNo === 32 && wireType === 2) {
      const ts = pbDecodeTimestampSub(r, pbReadSubEnd(r, r.end));
      if (ts) meta.startedAt = ts;
    } else {
      pbSkipField(r, wireType, r.end);
    }
  }

  if (retryInfos) {
    meta.retryInfos = retryInfos;
  }
  if (!meta.sourceTrajectoryStepInfo) {
    meta.sourceTrajectoryStepInfo = {
      trajectoryId: '',
      stepIndex: fallbackStepIdx,
      metadataIndex: 0,
      cascadeId: '',
    };
  }
  return meta;
}

function pbDecodePlannerResponseSub(r, subEnd, keepTextSnippets) {
  const pr = {};
  let toolCalls = null;

  while (r.pos < subEnd) {
    const tag = pbReadTag(r, subEnd);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 1 && wireType === 2) {
      const resp = pbReadString(r, subEnd);
      if (resp) pr.response = resp;
    } else if (fieldNo === 3 && wireType === 2) {
      if (keepTextSnippets) {
        const th = pbReadString(r, subEnd);
        if (th) pr.thinking = th;
      } else {
        pbSkipField(r, wireType, subEnd);
      }
    } else if (fieldNo === 7 && wireType === 2) {
      if (!toolCalls) toolCalls = [];
      toolCalls.push(pbDecodeToolCallSub(r, pbReadSubEnd(r, subEnd), keepTextSnippets));
    } else if (fieldNo === 8 && wireType === 2) {
      const mod = pbReadString(r, subEnd);
      if (mod) pr.modifiedResponse = mod;
    } else if (fieldNo === 11 && wireType === 2) {
      const dur = pbDecodeDurationSub(r, pbReadSubEnd(r, subEnd));
      if (dur) pr.thinkingDuration = dur;
    } else if (fieldNo === 16 && wireType === 2) {
      if (keepTextSnippets) {
        const rth = pbReadString(r, subEnd);
        if (rth) pr.rawThinking = rth;
      } else {
        pbSkipField(r, wireType, subEnd);
      }
    } else {
      pbSkipField(r, wireType, subEnd);
    }
  }
  r.pos = subEnd;
  if (toolCalls) {
    pr.toolCalls = toolCalls;
  }
  return pr;
}

function pbDecodeTextOrScopeItemSub(r, subEnd) {
  let text = '';
  while (r.pos < subEnd) {
    const tag = pbReadTag(r, subEnd);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 1 && wireType === 2) {
      text = pbReadString(r, subEnd);
    } else {
      pbSkipField(r, wireType, subEnd);
    }
  }
  r.pos = subEnd;
  return text;
}

function pbDecodeUserInputSub(r, subEnd) {
  let query = '';
  let userResponse = '';
  let firstItem = '';
  while (r.pos < subEnd) {
    const tag = pbReadTag(r, subEnd);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 1 && wireType === 2) {
      query = pbReadString(r, subEnd);
    } else if (fieldNo === 2 && wireType === 2) {
      userResponse = pbReadString(r, subEnd);
    } else if (fieldNo === 3 && wireType === 2 && !firstItem) {
      firstItem = pbDecodeTextOrScopeItemSub(r, pbReadSubEnd(r, subEnd));
    } else {
      pbSkipField(r, wireType, subEnd);
    }
  }
  r.pos = subEnd;
  return userResponse || query || firstItem || '';
}

function pbDecodeInvokeSubagentPayloadSub(r, subEnd) {
  const subagents = [];
  const results = [];
  while (r.pos < subEnd) {
    const tag = pbReadTag(r, subEnd);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 1 && wireType === 2) {
      const spec = pbDecodeSubagentSpecSub(r, pbReadSubEnd(r, subEnd));
      subagents.push(spec || { typeName: '', role: '' });
    } else if (fieldNo === 2 && wireType === 2) {
      results.push(pbDecodeSubagentResultSub(r, pbReadSubEnd(r, subEnd)));
    } else {
      pbSkipField(r, wireType, subEnd);
    }
  }
  r.pos = subEnd;
  return { subagents, results };
}

function pbDecodeAnyForInvokeSubagentSub(r, subEnd) {
  let typeUrl = '';
  let valStart = 0;
  let valEnd = 0;
  while (r.pos < subEnd) {
    const tag = pbReadTag(r, subEnd);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 1 && wireType === 2) {
      typeUrl = pbReadString(r, subEnd);
    } else if (fieldNo === 2 && wireType === 2) {
      valEnd = pbReadSubEnd(r, subEnd);
      valStart = r.pos;
      r.pos = valEnd;
    } else {
      pbSkipField(r, wireType, subEnd);
    }
  }
  r.pos = subEnd;
  if (
    valEnd > valStart &&
    (typeUrl.endsWith('/exa.cortex.core.tools.InvokeSubagent') ||
      typeUrl === 'exa.cortex.core.tools.InvokeSubagent')
  ) {
    const innerR = { u8: r.u8, pos: valStart, end: valEnd };
    return pbDecodeInvokeSubagentPayloadSub(innerR, valEnd);
  }
  return null;
}

function pbDecodeGenericStepSub(r, subEnd) {
  let invokeSubagent = null;
  while (r.pos < subEnd) {
    const tag = pbReadTag(r, subEnd);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 2 && wireType === 2) {
      // GenericStepResult
      const resEnd = pbReadSubEnd(r, subEnd);
      while (r.pos < resEnd) {
        const resTag = pbReadTag(r, resEnd);
        const resField = resTag >>> 3;
        const resWire = resTag & 7;
        if (resField === 6 && resWire === 2) {
          invokeSubagent = pbDecodeAnyForInvokeSubagentSub(r, pbReadSubEnd(r, resEnd));
        } else {
          pbSkipField(r, resWire, resEnd);
        }
      }
      r.pos = resEnd;
    } else {
      pbSkipField(r, wireType, subEnd);
    }
  }
  r.pos = subEnd;
  return invokeSubagent;
}

export function pbDecodeStepPayload(
  rawBytes,
  {
    stepTypeNum = 0,
    isInvokeSubagent = false,
    keepTextSnippets = false,
    keepUserInput = false,
  } = {}
) {
  const r = pbCreateReader(rawBytes);
  if (!r) return {};

  const out = {};
  while (r.pos < r.end) {
    const tag = pbReadTag(r, r.end);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 20 && wireType === 2 && stepTypeNum === 15) {
      out.plannerResponse = pbDecodePlannerResponseSub(
        r,
        pbReadSubEnd(r, r.end),
        keepTextSnippets
      );
    } else if (fieldNo === 19 && wireType === 2 && keepUserInput) {
      out.userInputText = pbDecodeUserInputSub(r, pbReadSubEnd(r, r.end));
    } else if (fieldNo === 140 && wireType === 2 && isInvokeSubagent) {
      const inv = pbDecodeGenericStepSub(r, pbReadSubEnd(r, r.end));
      if (inv) out.invokeSubagent = inv;
    } else if (fieldNo === 143 && wireType === 2 && isInvokeSubagent) {
      out.invokeSubagent = pbDecodeInvokeSubagentPayloadSub(r, pbReadSubEnd(r, r.end));
    } else {
      pbSkipField(r, wireType, r.end);
    }
  }
  return out;
}

function pbDecodeTokenGroupSub(r, subEnd) {
  let name = '';
  let numTokens = 0;
  let children = null;

  while (r.pos < subEnd) {
    const tag = pbReadTag(r, subEnd);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 1 && wireType === 2) {
      name = pbReadString(r, subEnd);
    } else if (fieldNo === 2 && wireType === 2) {
      if (!children) children = [];
      children.push(pbDecodeTokenGroupSub(r, pbReadSubEnd(r, subEnd)));
    } else if (fieldNo === 3 && wireType === 0) {
      numTokens = pbReadInt32(r, subEnd);
    } else {
      pbSkipField(r, wireType, subEnd);
    }
  }
  r.pos = subEnd;
  const group = { name, numTokens };
  if (children) group.children = children;
  return group;
}

function pbDecodeTopLevelTokenGroupSub(r, subEnd) {
  let name = '';
  let type = '';
  let source = '';
  let numTokens = 0;
  let children = null;

  while (r.pos < subEnd) {
    const tag = pbReadTag(r, subEnd);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 1 && wireType === 2) {
      name = pbReadString(r, subEnd);
    } else if (fieldNo === 2 && wireType === 0) {
      type = pbMapTokenType(pbReadUint32(r, subEnd));
    } else if (fieldNo === 3 && wireType === 0) {
      source = pbMapTokenSource(pbReadUint32(r, subEnd));
    } else if (fieldNo === 4 && wireType === 0) {
      numTokens = pbReadInt32(r, subEnd);
    } else if (fieldNo === 5 && wireType === 2) {
      if (!children) children = [];
      children.push(pbDecodeTokenGroupSub(r, pbReadSubEnd(r, subEnd)));
    } else {
      pbSkipField(r, wireType, subEnd);
    }
  }
  r.pos = subEnd;
  const group = { name, numTokens };
  if (type) group.type = type;
  if (source) group.source = source;
  if (children) group.children = children;
  return group;
}

function pbDecodeTokenBreakdownSub(r, subEnd) {
  const groups = [];
  let totalTokens = 0;
  while (r.pos < subEnd) {
    const tag = pbReadTag(r, subEnd);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 1 && wireType === 2) {
      groups.push(pbDecodeTopLevelTokenGroupSub(r, pbReadSubEnd(r, subEnd)));
    } else if (fieldNo === 2 && wireType === 0) {
      totalTokens = pbReadInt32(r, subEnd);
    } else {
      pbSkipField(r, wireType, subEnd);
    }
  }
  r.pos = subEnd;
  return { groups, totalTokens };
}

function pbDecodeContextWindowMetadataSub(r, subEnd, includeContextBreakdown) {
  const cw = {};
  while (r.pos < subEnd) {
    const tag = pbReadTag(r, subEnd);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 1 && wireType === 0) {
      cw.estimatedTokensUsed = pbReadInt32(r, subEnd);
    } else if (fieldNo === 3 && wireType === 2) {
      if (includeContextBreakdown) {
        cw.tokenBreakdown = pbDecodeTokenBreakdownSub(r, pbReadSubEnd(r, subEnd));
      } else {
        pbSkipField(r, wireType, subEnd);
      }
    } else if (fieldNo === 4 && wireType === 0) {
      cw.maxContextTokens = pbReadInt32(r, subEnd);
    } else {
      pbSkipField(r, wireType, subEnd);
    }
  }
  r.pos = subEnd;
  return cw;
}

function pbDecodeChatStartMetadataSub(r, subEnd, includeContextBreakdown) {
  const cs = {};
  while (r.pos < subEnd) {
    const tag = pbReadTag(r, subEnd);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 2 && wireType === 0) {
      cs.checkpointIndex = pbReadInt32(r, subEnd);
    } else if (fieldNo === 4 && wireType === 2) {
      const ts = pbDecodeTimestampSub(r, pbReadSubEnd(r, subEnd));
      if (ts) cs.createdAt = ts;
    } else if (fieldNo === 10 && wireType === 2) {
      cs.contextWindowMetadata = pbDecodeContextWindowMetadataSub(
        r,
        pbReadSubEnd(r, subEnd),
        includeContextBreakdown
      );
    } else {
      pbSkipField(r, wireType, subEnd);
    }
  }
  r.pos = subEnd;
  return cs;
}

function pbDecodeChatMessagePromptSub(r, subEnd) {
  const msg = {};
  while (r.pos < subEnd) {
    const tag = pbReadTag(r, subEnd);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 2 && wireType === 0) {
      const src = pbMapChatMessageSource(pbReadUint32(r, subEnd));
      if (src) msg.source = src;
    } else if (fieldNo === 3 && wireType === 2) {
      msg.prompt = pbReadString(r, subEnd);
    } else if (fieldNo === 4 && wireType === 0) {
      const nt = pbReadUint32(r, subEnd);
      if (nt > 0) msg.numTokens = nt;
    } else {
      pbSkipField(r, wireType, subEnd);
    }
  }
  r.pos = subEnd;
  return msg;
}

function pbDecodeChatToolDefinitionSub(r, subEnd) {
  const tool = {};
  while (r.pos < subEnd) {
    const tag = pbReadTag(r, subEnd);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 1 && wireType === 2) {
      tool.name = pbReadString(r, subEnd);
    } else if (fieldNo === 2 && wireType === 2) {
      tool.description = pbReadString(r, subEnd);
    } else if (fieldNo === 3 && wireType === 2) {
      tool.jsonSchemaString = pbReadString(r, subEnd);
    } else if (fieldNo === 6 && wireType === 2) {
      const srv = pbReadString(r, subEnd);
      if (srv) tool.serverName = srv;
    } else {
      pbSkipField(r, wireType, subEnd);
    }
  }
  r.pos = subEnd;
  return tool;
}

function pbDecodePromptSectionSub(r, subEnd) {
  const sec = {};
  while (r.pos < subEnd) {
    const tag = pbReadTag(r, subEnd);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 1 && wireType === 2) {
      sec.title = pbReadString(r, subEnd);
    } else if (fieldNo === 2 && wireType === 2) {
      sec.content = pbReadString(r, subEnd);
    } else if (fieldNo === 6 && wireType === 0) {
      const tt = pbMapTokenType(pbReadUint32(r, subEnd));
      if (tt) sec.tokenType = tt;
    } else if (fieldNo === 7 && wireType === 0) {
      const ts = pbMapTokenSource(pbReadUint32(r, subEnd));
      if (ts) sec.tokenSource = ts;
    } else {
      pbSkipField(r, wireType, subEnd);
    }
  }
  r.pos = subEnd;
  return sec;
}

function pbDecodeChatModelMetadataSub(r, subEnd, includeContextBreakdown) {
  const chat = {};
  let messagePrompts = null;
  let tools = null;
  let promptSections = null;
  let customMetadata = null;

  while (r.pos < subEnd) {
    const tag = pbReadTag(r, subEnd);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 2 && wireType === 2) {
      if (includeContextBreakdown) {
        if (!messagePrompts) messagePrompts = [];
        messagePrompts.push(pbDecodeChatMessagePromptSub(r, pbReadSubEnd(r, subEnd)));
      } else {
        pbSkipField(r, wireType, subEnd);
      }
    } else if (fieldNo === 3 && wireType === 0) {
      const m = pbMapModelEnum(pbReadUint32(r, subEnd));
      if (m) chat.model = m;
    } else if (fieldNo === 4 && wireType === 2) {
      chat.usage = pbDecodeModelUsageStatsSub(r, pbReadSubEnd(r, subEnd));
    } else if (fieldNo === 8 && wireType === 2) {
      if (includeContextBreakdown) {
        if (!tools) tools = [];
        tools.push(pbDecodeChatToolDefinitionSub(r, pbReadSubEnd(r, subEnd)));
      } else {
        pbSkipField(r, wireType, subEnd);
      }
    } else if (fieldNo === 9 && wireType === 2) {
      chat.chatStartMetadata = pbDecodeChatStartMetadataSub(
        r,
        pbReadSubEnd(r, subEnd),
        includeContextBreakdown
      );
    } else if (fieldNo === 11 && wireType === 2) {
      const dur = pbDecodeDurationSub(r, pbReadSubEnd(r, subEnd));
      if (dur) chat.timeToFirstToken = dur;
    } else if (fieldNo === 12 && wireType === 2) {
      const dur = pbDecodeDurationSub(r, pbReadSubEnd(r, subEnd));
      if (dur) chat.streamingDuration = dur;
    } else if (fieldNo === 16 && wireType === 2) {
      if (includeContextBreakdown) {
        if (!promptSections) promptSections = [];
        promptSections.push(pbDecodePromptSectionSub(r, pbReadSubEnd(r, subEnd)));
      } else {
        pbSkipField(r, wireType, subEnd);
      }
    } else if (fieldNo === 19 && wireType === 2) {
      const rm = pbReadString(r, subEnd);
      if (rm) chat.responseModel = rm;
    } else if (fieldNo === 20 && wireType === 2) {
      if (!customMetadata) customMetadata = {};
      pbDecodeStringMapEntrySub(r, pbReadSubEnd(r, subEnd), customMetadata, false);
    } else if (fieldNo === 21 && wireType === 2) {
      const dn = pbReadString(r, subEnd);
      if (dn) chat.modelDisplayName = dn;
    } else {
      pbSkipField(r, wireType, subEnd);
    }
  }
  r.pos = subEnd;

  if (customMetadata) {
    chat.customMetadata = customMetadata;
    if (!chat.model && customMetadata.model_enum) {
      const fallbackEnum = String(customMetadata.model_enum).trim();
      if (fallbackEnum && !/^MODEL_(?:UNSPECIFIED|UNKNOWN)$/i.test(fallbackEnum) && fallbackEnum !== '0') {
        chat.model = fallbackEnum;
      }
    }
  }
  if (messagePrompts) chat.messagePrompts = messagePrompts;
  if (tools) chat.tools = tools;
  if (promptSections) chat.promptSections = promptSections;

  return chat;
}

function pbDecodePlannerConfigSub(r, subEnd) {
  const pc = {};
  while (r.pos < subEnd) {
    const tag = pbReadTag(r, subEnd);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 1 && wireType === 0) {
      const pm = pbMapModelEnum(pbReadUint32(r, subEnd));
      if (pm) pc.planModel = pm;
    } else if (fieldNo === 28 && wireType === 2) {
      const mn = pbReadString(r, subEnd);
      if (mn) pc.modelName = mn;
    } else if (fieldNo === 60 && wireType === 2) {
      const pecEnd = pbReadSubEnd(r, subEnd);
      let execModel = '';
      while (r.pos < pecEnd) {
        const pecTag = pbReadTag(r, pecEnd);
        const pecField = pecTag >>> 3;
        const pecWire = pecTag & 7;
        if (pecField === 1 && pecWire === 0) {
          execModel = pbMapModelEnum(pbReadUint32(r, pecEnd));
        } else {
          pbSkipField(r, pecWire, pecEnd);
        }
      }
      r.pos = pecEnd;
      if (execModel) {
        pc.planExecuteConfig = { executionModel: execModel };
      }
    } else {
      pbSkipField(r, wireType, subEnd);
    }
  }
  r.pos = subEnd;
  return pc;
}

export function pbDecodeGeneratorMetadata(
  rawBytes,
  { includeContextBreakdown = false } = {}
) {
  const r = pbCreateReader(rawBytes);
  if (!r) return null;

  const gm = { stepIndices: [] };
  while (r.pos < r.end) {
    const tag = pbReadTag(r, r.end);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 1 && wireType === 2) {
      gm.chatModel = pbDecodeChatModelMetadataSub(
        r,
        pbReadSubEnd(r, r.end),
        includeContextBreakdown
      );
    } else if (fieldNo === 2) {
      pbReadRepeatedUint32(r, wireType, r.end, gm.stepIndices);
    } else if (fieldNo === 3 && wireType === 2) {
      gm.plannerConfig = pbDecodePlannerConfigSub(r, pbReadSubEnd(r, r.end));
    } else if (fieldNo === 8) {
      // Optional repeated int32 mendel_experiment_ids (skip or consume packed/unpacked)
      if (wireType === 2 || wireType === 0) {
        pbReadRepeatedInt32(r, wireType, r.end, []);
      } else {
        pbSkipField(r, wireType, r.end);
      }
    } else {
      pbSkipField(r, wireType, r.end);
    }
  }
  return gm;
}
