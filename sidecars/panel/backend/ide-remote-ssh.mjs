/**
 * @fileoverview Antigravity IDE Remote-SSH 远端守护发现、已转发端口握手配对与受管回环隧道池。
 *
 * 严格遵循零侵入与非交互原则：
 * 1. 全程使用 `ssh -T -n -o BatchMode=yes` 单趟只读探测远端 `daemon/{hub,ls}_*.json`（兼容单对象与 `agy 2.35+` 多行/多块 JSON）
 *    及 `agy` / `language_server` 进程监听端口（直接复用 `ls-discovery.mjs` 解析原语）；
 * 2. 优先拿发现到的远端 `csrfToken` 与 IDE 已转发至本机的回环端口做 `GetUserStatus` 握手（Tier 1a，零额外隧道）；
 * 3. 若远端端口尚未转发至本机，按需拉起严格绑定 `127.0.0.1` 的受管 `ssh -N -L` 隧道（Tier 1b），随端点淘汰确定性回收；
 * 4. 遇到密码认证或 2FA 主机立即快速失败并进入指数退避（`30s -> 120s -> 300s`），绝不挂起轮询或弹窗打扰用户。
 */

import { lsRuntimeEndpoint } from './config.mjs';
import {
  parseLinuxProcNetTcpPorts,
  parseLsArgsFromCommandLine,
  parseSsListeningPorts,
} from './ls-discovery.mjs';

const IDE_SSH_SECTION_DAEMON = '===UM_DAEMON_JSON===';
const IDE_SSH_SECTION_PS = '===UM_PS===';
const IDE_SSH_SECTION_PROC = '===UM_PROC_FD===';
const IDE_SSH_SECTION_NET = '===UM_PROC_NET===';
const IDE_SSH_SECTION_SS = '===UM_SS===';
const IDE_SSH_SECTION_CAPABILITIES = '===UM_CAPABILITIES===';

const IDE_SSH_BACKOFF_STEPS_MS = Object.freeze([30_000, 120_000, 300_000]);
const IDE_SSH_ABSENT_BACKOFF_STEPS_MS = Object.freeze([60_000, 180_000, 300_000]);
const IDE_SSH_CLI_IDLE_RETRY_MS = 15_000;
const IDE_SSH_HEALTHY_CACHE_TTL_MS = 20_000;
const IDE_SSH_MAX_HOSTS = 32;
const IDE_SSH_MAX_TUNNEL_PORT_ATTEMPTS = 4;
const IDE_SSH_TIER1B_MAX_BUDGET_MS = 12_000;

export const IDE_SSH_REMOTE_PROBE_SH = [
  `echo "${IDE_SSH_SECTION_DAEMON}"`,
  'for d in "$HOME"/.gemini/*/daemon "$HOME"/.antigravity-ide-server/data/User/globalStorage/*/daemon "$HOME"/.antigravity-ide-server/*/daemon "$HOME"/.vscode-server/data/User/globalStorage/*/daemon "$HOME"/.vscode-server-insiders/data/User/globalStorage/*/daemon; do',
  '  [ -d "$d" ] || continue',
  '  for f in "$d"/hub_*.json "$d"/ls_*.json; do',
  '    [ -f "$f" ] || continue',
  '    cat "$f" 2>/dev/null; printf "\\n"',
  '  done',
  'done',
  `echo "${IDE_SSH_SECTION_PS}"`,
  'uid="$(id -u 2>/dev/null)"',
  'ps -u "$uid" -o pid=,args= 2>/dev/null || ps ax -o pid=,args= 2>/dev/null || true',
  `echo "${IDE_SSH_SECTION_SS}"`,
  'ss -H -lntp 2>/dev/null || true',
  `echo "${IDE_SSH_SECTION_PROC}"`,
  'for p in $(ps -u "$uid" -o pid= 2>/dev/null); do',
  '  [ -d "/proc/$p/fd" ] || continue',
  '  cmd="$(tr "\\0" " " < "/proc/$p/cmdline" 2>/dev/null)"',
  '  case "$cmd" in *agy*|*antigravity*|*language_server*)',
  '    for fd in /proc/"$p"/fd/*; do',
  '      lnk="$(readlink "$fd" 2>/dev/null)"',
  '      case "$lnk" in socket:\\[*\\]) echo "$p $lnk" ;; esac',
  '    done',
  '  ;; esac',
  'done',
  `echo "${IDE_SSH_SECTION_NET}"`,
  'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null || true',
  `echo "${IDE_SSH_SECTION_CAPABILITIES}"`,
  'um_has_cli=0',
  'if command -v agy >/dev/null 2>&1 || [ -x "$HOME/.local/bin/agy" ] || [ -x "$HOME/.gemini/bin/agy" ] || [ -d "$HOME/.gemini/antigravity-cli" ]; then um_has_cli=1; fi',
  'um_has_cli_plugin=0',
  'if [ "$um_has_cli" = "1" ]; then',
  '  if [ -f "$HOME/.gemini/config/plugins/usage-monitor/plugin.json" ] || [ -f "$HOME/.gemini/antigravity-cli/plugins/usage-monitor/plugin.json" ]; then',
  '    um_has_cli_plugin=1',
  '  elif [ -f "$HOME/.gemini/antigravity-cli/settings.json" ]; then',
  '    if command -v node >/dev/null 2>&1; then',
  '      node -e \'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").replace(/^\\uFEFF/,""));const l=s&&s.statusLine;process.exit(l&&typeof l==="object"&&l.enabled!==false&&/cli-statusline\\.mjs|usage-monitor/i.test(String(l.command||""))?0:1)}catch{process.exit(1)}\' "$HOME/.gemini/antigravity-cli/settings.json" 2>/dev/null && um_has_cli_plugin=1',
  '    elif grep -qsE "cli-statusline\\.mjs|usage-monitor" "$HOME/.gemini/antigravity-cli/settings.json" 2>/dev/null && ! grep -qsE \'"enabled"[[:space:]]*:[[:space:]]*false\' "$HOME/.gemini/antigravity-cli/settings.json" 2>/dev/null; then',
  '      um_has_cli_plugin=1',
  '    fi',
  '  fi',
  'fi',
  'um_has_vscode_ext=0',
  'for ext_dir in "$HOME"/.vscode-server/extensions/google.google-antigravity* "$HOME"/.vscode-server-insiders/extensions/google.google-antigravity*; do',
  '  if [ -e "$ext_dir" ]; then um_has_vscode_ext=1; break; fi',
  'done',
  'printf "hasCli=%s\\nhasCliPlugin=%s\\nhasVsCodeExt=%s\\n" "$um_has_cli" "$um_has_cli_plugin" "$um_has_vscode_ext"',
].join('\n');

let ideSshNodeDepsPromise = null;

async function getIdeSshNodeDeps() {
  if (!ideSshNodeDepsPromise) {
    ideSshNodeDepsPromise = Promise.all([
      import('node:child_process'),
      import('node:net'),
      import('node:http'),
      import('node:https'),
    ]).then(([cpMod, netMod, httpMod, httpsMod]) => ({
      execFile: cpMod.execFile || cpMod.default?.execFile,
      spawn: cpMod.spawn || cpMod.default?.spawn,
      net: netMod.default || netMod,
      http: httpMod.default || httpMod,
      https: httpsMod.default || httpsMod,
    }));
  }
  return ideSshNodeDepsPromise;
}

/**
 * 从可能包含单个多行格式化 JSON、JSON Lines 或多个拼接 JSON 块的远端守护文件输出中提取全部顶层对象。
 *
 * @param {string} rawText
 * @returns {Array<{ pid: number, httpPort: number, httpsPort: number, csrfToken: string }>}
 */
export function parseRemoteDaemonJsonObjects(rawText) {
  const text = String(rawText || '');
  if (!text.trim()) return [];

  const extractedObjects = [];
  let depth = 0;
  let objStart = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth += 1;
    } else if (ch === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && objStart >= 0) {
          const slice = text.slice(objStart, i + 1);
          objStart = -1;
          try {
            const parsed = JSON.parse(slice);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              extractedObjects.push(parsed);
            }
          } catch {
            // 忽略半截写入或损坏的单个 JSON 块
          }
        }
      }
    }
  }

  const results = [];
  const seen = new Set();
  for (const obj of extractedObjects) {
    const pid = Number(obj.pid || obj.processId || 0) || 0;
    const rawHttp = Number(
      obj.httpPort || obj.port || obj.serverPort || obj.backendPort || obj.hubPort || 0
    );
    const rawHttps = Number(obj.httpsPort || obj.httpsServerPort || 0);
    const httpPort = Number.isInteger(rawHttp) && rawHttp > 0 && rawHttp <= 65535 ? rawHttp : 0;
    const httpsPort =
      Number.isInteger(rawHttps) && rawHttps > 0 && rawHttps <= 65535 ? rawHttps : 0;
    const csrfToken = String(obj.csrfToken || obj.csrf_token || '').trim();
    if (!httpPort && !httpsPort && !csrfToken) continue;
    const key = `${pid}:${httpPort}:${httpsPort}:${csrfToken}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ pid, httpPort, httpsPort, csrfToken });
  }
  return results;
}

/**
 * 解析单趟非交互 SSH 探测脚本返回的标准输出，合并守护 JSON 与进程监听端口候选。
 *
 * @param {string} stdoutText
 * @returns {Array<{ pid: number, ports: number[], httpsPorts: number[], csrfToken: string, source: 'daemon'|'proc' }>}
 */
export function parseRemoteProbeStdout(stdoutText) {
  const raw = String(stdoutText || '');
  if (!raw.trim()) return [];

  const markers = [
    IDE_SSH_SECTION_DAEMON,
    IDE_SSH_SECTION_PS,
    IDE_SSH_SECTION_SS,
    IDE_SSH_SECTION_PROC,
    IDE_SSH_SECTION_NET,
    IDE_SSH_SECTION_CAPABILITIES,
  ];
  const sections = new Map();
  let currentMarker = '';
  const bufByMarker = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (markers.includes(trimmed)) {
      currentMarker = trimmed;
      if (!bufByMarker.has(currentMarker)) bufByMarker.set(currentMarker, []);
      continue;
    }
    if (currentMarker) {
      bufByMarker.get(currentMarker).push(line);
    }
  }
  for (const [k, lines] of bufByMarker.entries()) {
    sections.set(k, lines.join('\n'));
  }

  // 若调用方直接传入裸 JSON 文本（无分段头），兼容作为守护 JSON 解析
  const daemonRaw = sections.has(IDE_SSH_SECTION_DAEMON)
    ? sections.get(IDE_SSH_SECTION_DAEMON)
    : !sections.size
      ? raw
      : '';
  const psRaw = sections.get(IDE_SSH_SECTION_PS) || '';
  const ssRaw = sections.get(IDE_SSH_SECTION_SS) || '';
  const procFdRaw = sections.get(IDE_SSH_SECTION_PROC) || '';
  const procNetRaw = sections.get(IDE_SSH_SECTION_NET) || '';

  const livePids = new Set();
  const procEntries = [];
  for (const rawLine of psRaw.split(/\r?\n/)) {
    const m = rawLine.trim().match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const cmd = m[2];
    if (!Number.isInteger(pid) || pid <= 0) continue;
    livePids.add(pid);
    const parsedCmd = parseLsArgsFromCommandLine(cmd);
    if (parsedCmd.isHub || parsedCmd.isLanguageServer) {
      procEntries.push({
        pid,
        hubPort: parsedCmd.hubPort || 0,
        csrfToken: parsedCmd.csrfToken || '',
      });
    }
  }

  const inodesByPid = new Map();
  for (const rawLine of procFdRaw.split(/\r?\n/)) {
    const m = rawLine.trim().match(/^(\d+)\s+socket:\[(\d+)\]$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!inodesByPid.has(pid)) inodesByPid.set(pid, new Set());
    inodesByPid.get(pid).add(m[2]);
  }

  const out = [];
  const seenKeys = new Set();

  for (const d of parseRemoteDaemonJsonObjects(daemonRaw)) {
    if (d.pid > 0 && livePids.size > 0 && !livePids.has(d.pid)) {
      continue;
    }
    const ports = [];
    const httpsPorts = [];
    if (d.httpPort > 0) ports.push(d.httpPort);
    if (d.httpsPort > 0) {
      httpsPorts.push(d.httpsPort);
      if (!ports.includes(d.httpsPort)) ports.push(d.httpsPort);
    }
    const key = `d:${d.pid}:${ports.join(',')}:${d.csrfToken}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    out.push({
      pid: d.pid,
      ports,
      httpsPorts,
      csrfToken: d.csrfToken,
      source: 'daemon',
    });
  }

  for (const p of procEntries) {
    const portSet = new Set();
    if (p.hubPort > 0) portSet.add(p.hubPort);
    for (const sp of parseSsListeningPorts(ssRaw, p.pid)) {
      portSet.add(sp);
    }
    const inodes = inodesByPid.get(p.pid);
    if (inodes && inodes.size > 0 && procNetRaw) {
      for (const np of parseLinuxProcNetTcpPorts(procNetRaw, inodes)) {
        portSet.add(np);
      }
    }
    const ports = Array.from(portSet);
    if (ports.length === 0 && !p.csrfToken) continue;
    const key = `p:${p.pid}:${ports.join(',')}:${p.csrfToken}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    out.push({
      pid: p.pid,
      ports,
      httpsPorts: [],
      csrfToken: p.csrfToken,
      source: 'proc',
    });
  }

  out.sort((a, b) => {
    const aScore = (a.source === 'daemon' ? 4 : 0) + (a.csrfToken ? 2 : 0) + (a.ports.length ? 1 : 0);
    const bScore = (b.source === 'daemon' ? 4 : 0) + (b.csrfToken ? 2 : 0) + (b.ports.length ? 1 : 0);
    return bScore - aScore;
  });

  return out;
}

/**
 * 解析单趟非交互 SSH 探测输出中的 `===UM_CAPABILITIES===` 分段，识别远端是否安装了
 * `agy` CLI、`usage-monitor` CLI 插件或 VS Code 官方 Antigravity 扩展。
 *
 * @param {string} stdoutText
 * @returns {{ known: boolean, hasCli: boolean, hasCliPlugin: boolean, hasVsCodeExt: boolean }}
 */
export function parseRemoteProbeCapabilities(stdoutText) {
  const empty = { known: false, hasCli: false, hasCliPlugin: false, hasVsCodeExt: false };
  const raw = String(stdoutText || '');
  if (!raw.includes(IDE_SSH_SECTION_CAPABILITIES)) {
    return empty;
  }
  const lines = raw.split(/\r?\n/);
  let inSection = false;
  const out = { known: true, hasCli: false, hasCliPlugin: false, hasVsCodeExt: false };
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed === IDE_SSH_SECTION_CAPABILITIES) {
      inSection = true;
      continue;
    }
    if (inSection && trimmed.startsWith('===UM_') && trimmed.endsWith('===')) {
      break;
    }
    if (!inSection || !trimmed) continue;
    if (trimmed === 'hasCli=1' || trimmed === 'hasCli=true') out.hasCli = true;
    else if (trimmed === 'hasCliPlugin=1' || trimmed === 'hasCliPlugin=true') out.hasCliPlugin = true;
    else if (trimmed === 'hasVsCodeExt=1' || trimmed === 'hasVsCodeExt=true') out.hasVsCodeExt = true;
  }
  if (!out.hasCli) {
    out.hasCliPlugin = false;
  }
  return out;
}

function validateIdeSshAuthority(parsedAuthority) {
  if (!parsedAuthority || parsedAuthority.isSshRemote !== true) return null;
  const dest = String(parsedAuthority.sshDestination || '').trim();
  const host = String(parsedAuthority.host || '').trim();
  if (!dest || !host || dest.startsWith('-') || host.startsWith('-')) return null;
  if (/[\s\0-\x1f\x7f[\]]/.test(dest)) return null;
  const port = Number(parsedAuthority.port || 0);
  if (port !== 0 && (!Number.isInteger(port) || port < 1 || port > 65535)) return null;
  const portArgs = port > 0 ? ['-p', String(port)] : [];
  return { dest, portArgs };
}

/**
 * 构造防参数注入的非交互 `ssh` 远端发现命令参数数组。
 *
 * @param {{ isSshRemote?: boolean, host?: string, sshDestination?: string, port?: number }} parsedAuthority
 * @param {number} [connectTimeoutSec=5]
 * @returns {string[]|null}
 */
export function buildSshProbeCommandArgs(parsedAuthority, connectTimeoutSec = 5) {
  const validated = validateIdeSshAuthority(parsedAuthority);
  if (!validated) return null;

  const timeoutSec = Math.max(2, Math.min(15, Math.round(Number(connectTimeoutSec) || 5)));

  return [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'NumberOfPasswordPrompts=0',
    '-o',
    'KbdInteractiveAuthentication=no',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    `ConnectTimeout=${timeoutSec}`,
    ...validated.portArgs,
    '--',
    validated.dest,
    'sh',
    '-s',
  ];
}

async function defaultHandshakeLsOrigin(baseUrl, csrfToken, timeoutMs = 1200) {
  const { http, https } = await getIdeSshNodeDeps();
  const parsed = new URL(`${String(baseUrl).replace(/\/+$/, '')}/exa.language_server_pb.LanguageServerService/GetUserStatus`);
  const isHttps = parsed.protocol === 'https:';
  const mod = isHttps ? https : http;
  const payload = '{}';
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(payload)),
    ...(csrfToken ? { 'x-codeium-csrf-token': csrfToken } : {}),
  };

  return new Promise((resolve) => {
    let settled = false;
    let hardTimer = null;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      if (hardTimer) {
        clearTimeout(hardTimer);
        hardTimer = null;
      }
      resolve(Boolean(ok));
    };
    const req = mod.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers,
        timeout: timeoutMs,
        ...(isHttps ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        res.on('error', () => done(false));
        if (res.statusCode !== 200) {
          res.resume();
          done(false);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (body.length < 32768) body += chunk;
        });
        res.on('end', () => {
          try {
            const obj = JSON.parse(body);
            done(Boolean(obj && typeof obj === 'object'));
          } catch {
            done(false);
          }
        });
      }
    );
    hardTimer = setTimeout(() => {
      req.destroy();
      done(false);
    }, timeoutMs + 50);
    hardTimer.unref?.();
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      done(false);
    });
    req.on('error', () => done(false));
    req.write(payload);
    req.end();
  });
}

async function allocateEphemeralLoopbackPort() {
  const { net } = await getIdeSshNodeDeps();
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref?.();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? Number(addr.port || 0) : 0;
      srv.close((err) => {
        if (err || !port) reject(err || new Error('Failed to allocate loopback port'));
        else resolve(port);
      });
    });
  });
}

async function probeTcpLoopbackOnce(net, port, timeoutMs = 200) {
  return new Promise((resolve) => {
    let settled = false;
    const sock = net.createConnection({ host: '127.0.0.1', port });
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {}
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

async function defaultOpenLoopbackSshTunnel({
  parsedAuthority,
  remotePort,
  readyTimeoutMs = 5500,
}) {
  const validated = validateIdeSshAuthority(parsedAuthority);
  if (!validated) {
    throw new Error('Invalid SSH authority for loopback tunnel');
  }
  if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort > 65535) {
    throw new Error('Invalid remote port for loopback tunnel');
  }
  const { spawn, net } = await getIdeSshNodeDeps();
  if (typeof spawn !== 'function') {
    throw new Error('child_process.spawn unavailable');
  }
  const localPort = await allocateEphemeralLoopbackPort();
  const args = [
    '-T',
    '-N',
    '-o',
    'BatchMode=yes',
    '-o',
    'NumberOfPasswordPrompts=0',
    '-o',
    'KbdInteractiveAuthentication=no',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=2',
    '-o',
    'ConnectTimeout=5',
    ...validated.portArgs,
    '-L',
    `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    '--',
    validated.dest,
  ];

  const child = spawn('ssh', args, {
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref?.();

  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  child.once('error', () => {
    exited = true;
  });

  // OpenSSH 在远端 KEX 与公钥鉴权完成后才在本地绑定 `-L` 端口（WAN 下通常需 400ms~2500ms）
  const deadline = Date.now() + Math.max(500, Number(readyTimeoutMs) || 5500);
  let listening = false;
  while (!exited && Date.now() < deadline) {
    if (await probeTcpLoopbackOnce(net, localPort, 180)) {
      listening = true;
      break;
    }
    if (exited) break;
    await new Promise((r) => setTimeout(r, 85));
  }

  if (!listening || exited) {
    exited = true;
    try {
      child.kill();
    } catch {}
    throw new Error(
      exited ? 'SSH loopback tunnel exited during startup' : 'SSH loopback tunnel listen timeout'
    );
  }

  return {
    localPort,
    remotePort,
    isAlive: () => !exited && child.exitCode === null && !child.killed,
    close: () => {
      exited = true;
      try {
        child.kill();
      } catch {
        // 忽略隧道关闭异常
      }
    },
  };
}

/**
 * 创建按主机隔离的 IDE Remote-SSH 守护发现与回环隧道协调器。
 *
 * @param {{
 *   execSshProbeFn?: ((args: string[], timeoutMs: number) => Promise<string>)|null,
 *   handshakeFn?: ((baseUrl: string, csrfToken: string, timeoutMs?: number) => Promise<boolean>)|null,
 *   openTunnelFn?: ((params: { parsedAuthority: object, remotePort: number }) => Promise<{ localPort: number, remotePort: number, isAlive: () => boolean, close: () => void }>)|null,
 *   nowFn?: () => number,
 *   allowInTest?: boolean,
 * }} [options]
 */
export function createIdeRemoteSshCoordinator(options = {}) {
  const nowFn = options.nowFn || Date.now;
  const handshakeFn = options.handshakeFn || defaultHandshakeLsOrigin;
  const openTunnelFn = options.openTunnelFn || defaultOpenLoopbackSshTunnel;
  const allowInTest = Boolean(options.allowInTest);

  const execSshProbe =
    options.execSshProbeFn ||
    (async (sshArgs, timeoutMs = 6500) => {
      const { execFile } = await getIdeSshNodeDeps();
      if (typeof execFile !== 'function') {
        throw new Error('child_process.execFile unavailable');
      }
      return new Promise((resolve, reject) => {
        const child = execFile(
          'ssh',
          sshArgs,
          {
            windowsHide: true,
            timeout: timeoutMs,
            maxBuffer: 512 * 1024,
          },
          (err, stdout) => {
            if (err) {
              reject(err);
              return;
            }
            resolve(String(stdout || ''));
          }
        );
        if (child?.stdin) {
          child.stdin.on('error', () => {
            // 忽略远端提前关闭管道导致的 EPIPE
          });
          child.stdin.end(`${IDE_SSH_REMOTE_PROBE_SH}\n`);
        }
      });
    });

  /**
   * @type {Map<string, {
   *   failCount: number,
   *   backoffUntilMs: number,
   *   resolvedBaseUrl: string,
   *   resolvedCsrfToken: string,
   *   resolvedMode: 'forwarded'|'tunnel'|'',
   *   verifiedAtMs: number,
   *   tunnel: { localPort: number, remotePort: number, isAlive: () => boolean, close: () => void }|null,
   *   inFlight: Promise<any>|null,
   * }>}
   */
  const hostStateMap = new Map();

  const emptyCapabilities = Object.freeze({
    known: false,
    hasCli: false,
    hasCliPlugin: false,
    hasVsCodeExt: false,
  });

  function getOrCreateHostState(stableHostKey) {
    const key = String(stableHostKey || '').trim().toLowerCase();
    let st = hostStateMap.get(key);
    if (!st) {
      if (hostStateMap.size >= IDE_SSH_MAX_HOSTS) {
        const oldestKey = hostStateMap.keys().next().value;
        if (oldestKey !== undefined) {
          disposeHost(oldestKey);
        }
      }
      st = {
        disposed: false,
        failCount: 0,
        absentCount: 0,
        backoffUntilMs: 0,
        discoveredTokens: [],
        triedForwardedInBackoff: new Set(),
        capabilities: { ...emptyCapabilities },
        resolvedBaseUrl: '',
        resolvedCsrfToken: '',
        resolvedMode: '',
        verifiedAtMs: 0,
        tunnel: null,
        inFlight: null,
      };
      hostStateMap.set(key, st);
    }
    return st;
  }

  function closeHostTunnel(st) {
    if (st?.tunnel) {
      try {
        st.tunnel.close();
      } catch {
        // 忽略关闭异常
      }
      st.tunnel = null;
    }
  }

  function disposeHost(stableHostKey) {
    const key = String(stableHostKey || '').trim().toLowerCase();
    const st = hostStateMap.get(key);
    if (!st) return;
    st.disposed = true;
    closeHostTunnel(st);
    hostStateMap.delete(key);
  }

  function disposeAll() {
    for (const st of hostStateMap.values()) {
      st.disposed = true;
      closeHostTunnel(st);
    }
    hostStateMap.clear();
  }

  function pruneInactiveHosts(activeHostKeys) {
    const keep = new Set();
    if (activeHostKeys && typeof activeHostKeys[Symbol.iterator] === 'function') {
      for (const rawKey of activeHostKeys) {
        const normKey = String(rawKey || '').trim().toLowerCase();
        if (normKey) keep.add(normKey);
      }
    }
    for (const key of Array.from(hostStateMap.keys())) {
      if (!keep.has(key)) {
        disposeHost(key);
      }
    }
  }

  /**
   * 解析目标 IDE / VS Code Remote-SSH 主机的最佳回环 RPC 连接参数（优先配对已转发端口，按需建立回环隧道）。
   *
   * @param {{
   *   parsedAuthority: { isSshRemote: boolean, host: string, user: string, port: number, sshDestination: string, stableHostKey: string, displayLabel: string },
   *   forwardedOrigins?: string[],
   *   requireCapabilities?: boolean,
   * }} params
   */
  async function resolveEndpointConnection({
    parsedAuthority,
    forwardedOrigins = [],
    requireCapabilities = false,
  } = {}) {
    if (!parsedAuthority?.isSshRemote || !parsedAuthority.stableHostKey) {
      return {
        ok: false,
        reason: 'not_ssh_remote',
        baseUrl: '',
        csrfToken: '',
        mode: '',
        capabilities: { ...emptyCapabilities },
      };
    }
    if (lsRuntimeEndpoint.addr === 'test.invalid' && !allowInTest && !options.execSshProbeFn) {
      return {
        ok: false,
        reason: 'test_sandbox_skipped',
        baseUrl: '',
        csrfToken: '',
        mode: '',
        capabilities: { ...emptyCapabilities },
      };
    }

    const hostKey = parsedAuthority.stableHostKey;
    const st = getOrCreateHostState(hostKey);
    const nowMs = nowFn();

    const cleanForwarded = Array.from(
      new Set(
        (Array.isArray(forwardedOrigins) ? forwardedOrigins : [])
          .map((o) => String(o || '').trim().replace(/\/+$/, ''))
          .filter((o) => /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/i.test(o))
      )
    );

    if (
      st.resolvedBaseUrl &&
      nowMs - st.verifiedAtMs < IDE_SSH_HEALTHY_CACHE_TTL_MS &&
      (st.resolvedMode !== 'tunnel' || st.tunnel?.isAlive?.())
    ) {
      return {
        ok: true,
        cached: true,
        baseUrl: st.resolvedBaseUrl,
        csrfToken: st.resolvedCsrfToken,
        mode: st.resolvedMode,
        capabilities: { ...st.capabilities },
      };
    }

    if (nowMs < st.backoffUntilMs) {
      // 若此前因无聊天子帧导致隧道失败退避，随后用户打开了聊天面板出现新的已转发端口，允许零 SSH 开销尝试一次本地配对
      const untriedOrigins = cleanForwarded.filter((o) => !st.triedForwardedInBackoff.has(o));
      if (untriedOrigins.length > 0 && st.discoveredTokens.length > 0) {
        for (const origin of untriedOrigins) {
          st.triedForwardedInBackoff.add(origin);
          for (const tok of st.discoveredTokens) {
            if (await handshakeFn(origin, tok, 1000)) {
              if (st.disposed) {
                return {
                  ok: false,
                  reason: 'disposed',
                  baseUrl: '',
                  csrfToken: '',
                  mode: '',
                  capabilities: { ...st.capabilities },
                };
              }
              closeHostTunnel(st);
              st.failCount = 0;
              st.absentCount = 0;
              st.backoffUntilMs = 0;
              st.triedForwardedInBackoff.clear();
              st.resolvedBaseUrl = origin;
              st.resolvedCsrfToken = tok;
              st.resolvedMode = 'forwarded';
              st.verifiedAtMs = nowFn();
              return {
                ok: true,
                baseUrl: origin,
                csrfToken: tok,
                mode: 'forwarded',
                capabilities: { ...st.capabilities },
              };
            }
          }
        }
      }
      return {
        ok: false,
        reason: 'backoff',
        backoffUntilMs: st.backoffUntilMs,
        baseUrl: cleanForwarded[0] || '',
        csrfToken: '',
        mode: '',
        capabilities: { ...st.capabilities },
      };
    }

    if (st.inFlight) {
      return st.inFlight;
    }

    st.inFlight = (async () => {
      // 若之前已有已验证连接但刚过 TTL，先做一次轻量握手续期，避免每 20s 重复跑 ssh 子进程
      if (
        st.resolvedBaseUrl &&
        (st.resolvedMode !== 'tunnel' || st.tunnel?.isAlive?.()) &&
        (await handshakeFn(st.resolvedBaseUrl, st.resolvedCsrfToken, 1000))
      ) {
        if (st.disposed) {
          closeHostTunnel(st);
          return {
            ok: false,
            reason: 'disposed',
            baseUrl: '',
            csrfToken: '',
            mode: '',
            capabilities: { ...st.capabilities },
          };
        }
        st.verifiedAtMs = nowFn();
        return {
          ok: true,
          cached: true,
          baseUrl: st.resolvedBaseUrl,
          csrfToken: st.resolvedCsrfToken,
          mode: st.resolvedMode,
          capabilities: { ...st.capabilities },
        };
      }

      const sshArgs = buildSshProbeCommandArgs(parsedAuthority, 5);
      if (!sshArgs) {
        return {
          ok: false,
          reason: 'invalid_authority',
          baseUrl: '',
          csrfToken: '',
          mode: '',
          capabilities: { ...st.capabilities },
        };
      }

      let probeStdout = '';
      try {
        probeStdout = await execSshProbe(sshArgs, 6500);
      } catch {
        if (st.disposed) {
          return {
            ok: false,
            reason: 'disposed',
            baseUrl: '',
            csrfToken: '',
            mode: '',
            capabilities: { ...st.capabilities },
          };
        }
        st.failCount += 1;
        const stepIdx = Math.min(st.failCount - 1, IDE_SSH_BACKOFF_STEPS_MS.length - 1);
        st.backoffUntilMs = nowFn() + IDE_SSH_BACKOFF_STEPS_MS[stepIdx];
        st.triedForwardedInBackoff.clear();
        closeHostTunnel(st);
        st.resolvedBaseUrl = '';
        st.resolvedCsrfToken = '';
        st.resolvedMode = '';
        return {
          ok: false,
          reason: 'ssh_probe_failed',
          backoffUntilMs: st.backoffUntilMs,
          baseUrl: cleanForwarded[0] || '',
          csrfToken: '',
          mode: '',
          capabilities: { ...st.capabilities },
        };
      }
      if (st.disposed) {
        return {
          ok: false,
          reason: 'disposed',
          baseUrl: '',
          csrfToken: '',
          mode: '',
          capabilities: { ...st.capabilities },
        };
      }

      const probedCapabilities = parseRemoteProbeCapabilities(probeStdout);
      if (probedCapabilities.known) {
        st.capabilities = probedCapabilities;
      }

      // 标准 VS Code Remote-SSH 未打开扩展时：若远端既无 VS Code Antigravity 扩展也无 agy CLI 插件，绝不拉起隧道
      if (
        requireCapabilities &&
        st.capabilities.known &&
        !st.capabilities.hasCliPlugin &&
        !st.capabilities.hasVsCodeExt &&
        cleanForwarded.length === 0
      ) {
        closeHostTunnel(st);
        st.resolvedBaseUrl = '';
        st.resolvedCsrfToken = '';
        st.resolvedMode = '';
        st.absentCount += 1;
        const absIdx = Math.min(st.absentCount - 1, IDE_SSH_ABSENT_BACKOFF_STEPS_MS.length - 1);
        st.backoffUntilMs = nowFn() + IDE_SSH_ABSENT_BACKOFF_STEPS_MS[absIdx];
        st.triedForwardedInBackoff.clear();
        return {
          ok: false,
          reason: 'no_remote_plugin',
          backoffUntilMs: st.backoffUntilMs,
          baseUrl: '',
          csrfToken: '',
          mode: '',
          capabilities: { ...st.capabilities },
        };
      }
      st.absentCount = 0;

      const candidates = parseRemoteProbeStdout(probeStdout);
      if (candidates.length === 0) {
        closeHostTunnel(st);
        st.resolvedBaseUrl = '';
        st.resolvedCsrfToken = '';
        st.resolvedMode = '';
        st.failCount += 1;
        const retryDelayMs =
          st.capabilities.known && st.capabilities.hasCliPlugin && !st.capabilities.hasVsCodeExt
            ? IDE_SSH_CLI_IDLE_RETRY_MS
            : IDE_SSH_BACKOFF_STEPS_MS[0];
        st.backoffUntilMs = nowFn() + retryDelayMs;
        st.triedForwardedInBackoff.clear();
        return {
          ok: false,
          reason: 'no_remote_daemon',
          backoffUntilMs: st.backoffUntilMs,
          baseUrl: cleanForwarded[0] || '',
          csrfToken: '',
          mode: '',
          capabilities: { ...st.capabilities },
        };
      }

      // Tier 1a: 优先与 IDE 已经转发到本机的回环聊天端口做 GetUserStatus 握手（零额外隧道）
      const uniqueTokens = Array.from(
        new Set(candidates.map((c) => c.csrfToken).filter(Boolean))
      );
      st.discoveredTokens = uniqueTokens;
      if (cleanForwarded.length > 0) {
        const tokensToTry = uniqueTokens.length > 0 ? uniqueTokens : [''];
        for (const origin of cleanForwarded) {
          for (const tok of tokensToTry) {
            if (await handshakeFn(origin, tok, 1200)) {
              if (st.disposed) {
                return {
                  ok: false,
                  reason: 'disposed',
                  baseUrl: '',
                  csrfToken: '',
                  mode: '',
                  capabilities: { ...st.capabilities },
                };
              }
              closeHostTunnel(st);
              st.failCount = 0;
              st.backoffUntilMs = 0;
              st.triedForwardedInBackoff.clear();
              st.resolvedBaseUrl = origin;
              st.resolvedCsrfToken = tok;
              st.resolvedMode = 'forwarded';
              st.verifiedAtMs = nowFn();
              return {
                ok: true,
                baseUrl: origin,
                csrfToken: tok,
                mode: 'forwarded',
                capabilities: { ...st.capabilities },
              };
            }
          }
        }
      }

      // Tier 1b: 远端端口尚未转发至本机时，按需建立 127.0.0.1 受管回环隧道（去重且限制单轮尝试上限与总预算）
      const maxTunnelPorts = Math.max(
        1,
        Number(options.maxTunnelPortAttempts) || IDE_SSH_MAX_TUNNEL_PORT_ATTEMPTS
      );
      const tier1bDeadlineMs =
        nowFn() + Math.max(500, Number(options.tier1bMaxBudgetMs) || IDE_SSH_TIER1B_MAX_BUDGET_MS);
      const triedTunnelKeys = new Set();
      let tunnelAttempts = 0;

      outerTunnelLoop: for (const cand of candidates) {
        const httpsSet = new Set(cand.httpsPorts || []);
        for (const remotePort of cand.ports) {
          if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort > 65535) continue;
          const dedupeKey = `${remotePort}:${cand.csrfToken || ''}`;
          if (triedTunnelKeys.has(dedupeKey)) continue;
          if (tunnelAttempts >= maxTunnelPorts || nowFn() >= tier1bDeadlineMs) {
            break outerTunnelLoop;
          }
          triedTunnelKeys.add(dedupeKey);
          tunnelAttempts += 1;
          let tunnelHandle = null;
          try {
            tunnelHandle = await openTunnelFn({ parsedAuthority, remotePort });
            if (st.disposed) {
              tunnelHandle?.close?.();
              return {
                ok: false,
                reason: 'disposed',
                baseUrl: '',
                csrfToken: '',
                mode: '',
                capabilities: { ...st.capabilities },
              };
            }
            const protos = httpsSet.has(remotePort) ? ['https', 'http'] : ['http', 'https'];
            for (const proto of protos) {
              const candidateBaseUrl = `${proto}://127.0.0.1:${tunnelHandle.localPort}`;
              for (const attempt of [0, 1]) {
                if (attempt > 0) {
                  await new Promise((r) => setTimeout(r, 150));
                }
                if (await handshakeFn(candidateBaseUrl, cand.csrfToken, 1200)) {
                  if (st.disposed) {
                    tunnelHandle.close();
                    return {
                      ok: false,
                      reason: 'disposed',
                      baseUrl: '',
                      csrfToken: '',
                      mode: '',
                      capabilities: { ...st.capabilities },
                    };
                  }
                  closeHostTunnel(st);
                  st.tunnel = tunnelHandle;
                  st.failCount = 0;
                  st.backoffUntilMs = 0;
                  st.triedForwardedInBackoff.clear();
                  st.resolvedBaseUrl = candidateBaseUrl;
                  st.resolvedCsrfToken = cand.csrfToken;
                  st.resolvedMode = 'tunnel';
                  st.verifiedAtMs = nowFn();
                  return {
                    ok: true,
                    baseUrl: candidateBaseUrl,
                    csrfToken: cand.csrfToken,
                    mode: 'tunnel',
                    capabilities: { ...st.capabilities },
                  };
                }
              }
            }
            tunnelHandle.close();
          } catch {
            tunnelHandle?.close?.();
          }
        }
      }

      closeHostTunnel(st);
      st.resolvedBaseUrl = '';
      st.resolvedCsrfToken = '';
      st.resolvedMode = '';
      st.failCount += 1;
      const stepIdx = Math.min(st.failCount - 1, IDE_SSH_BACKOFF_STEPS_MS.length - 1);
      st.backoffUntilMs = nowFn() + IDE_SSH_BACKOFF_STEPS_MS[stepIdx];
      st.triedForwardedInBackoff = new Set(cleanForwarded);
      return {
        ok: false,
        reason: 'handshake_failed',
        backoffUntilMs: st.backoffUntilMs,
        baseUrl: cleanForwarded[0] || '',
        csrfToken: uniqueTokens[0] || '',
        mode: '',
        capabilities: { ...st.capabilities },
      };
    })().finally(() => {
      st.inFlight = null;
    });

    return st.inFlight;
  }

  return {
    resolveEndpointConnection,
    disposeHost,
    disposeAll,
    pruneInactiveHosts,
    getActiveHostCount: () => hostStateMap.size,
  };
}
