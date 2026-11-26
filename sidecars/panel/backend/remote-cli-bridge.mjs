/**
 * @fileoverview Remote-SSH 远端 `agy` CLI 插件探测与按需本地 SSH 隧道管理器 (`remote-cli-bridge.mjs`)。
 *
 * 适用场景：
 * 当 VS Code 通过 Remote-SSH 连接远端服务器，但远端**未安装/未打开 VS Code Antigravity 扩展**、
 * 仅安装了 **`agy` CLI 及其 `usage-monitor` 插件**时：
 * 1. 通过单次非交互 `ssh -o BatchMode=yes` 探测远端是否存在 `agy` CLI + `usage-monitor` 插件，
 *    以及当前存活的 `daemon/hub_*.json`（优先 `~/.gemini/antigravity-cli/daemon`，次选 `~/.gemini/antigravity/daemon`）；
 * 2. 探测结果按主机名缓存并后台异步刷新，绝不阻塞主窗口 CDP 巡检循环（无插件或不可达主机缓存 60s，几乎零开销）；
 * 3. 若远端检测到存活 `hub_*.json`，按需拉起单条回环端口转发 `ssh -N -L 127.0.0.1:<localPort>:127.0.0.1:<remotePort>`，
 *    供 `ls-rpc.mjs` 通过 Tier-1 回环 HTTP/HTTPS 直连拉取远端 `agy` 实时遥测；
 * 4. 当对应 Remote-SSH 窗口关闭或插件退出时自动终止隧道子进程，不留孤儿进程。
 */

import { execFile, spawn } from 'node:child_process';
import net from 'node:net';

const SSH_HOST_RE = /^[a-zA-Z0-9._@:+-]{1,128}$/;
const DEFAULT_NEGATIVE_TTL_MS = 60_000;
const DEFAULT_POSITIVE_IDLE_TTL_MS = 15_000;
const DEFAULT_POSITIVE_ACTIVE_TTL_MS = 30_000;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/**
 * 严格校验 SSH Host 别名，拒绝以 `-` 开头或含空白/shell 元字符的输入。
 *
 * @param {unknown} rawHost
 * @returns {string}
 */
export function sanitizeSshHost(rawHost) {
  const clean = String(rawHost || '').trim();
  if (!clean || clean.startsWith('-') || !SSH_HOST_RE.test(clean)) {
    return '';
  }
  return clean;
}

/**
 * 单次远端 POSIX `sh` 探测脚本：
 * - 检测远端是否安装 `agy` CLI 与 `usage-monitor` CLI 插件；
 * - 若存在，按 mtime 倒序扫描 `antigravity-cli/daemon/hub_*.json` 与 `antigravity/daemon/hub_*.json`，
 *   验证 `kill -0 $pid` 存活后输出单行 JSON。
 */
export const REMOTE_CLI_PROBE_COMMAND = [
  'sh -c \'',
  'has_cli=0; ',
  'if command -v agy >/dev/null 2>&1 || [ -x "$HOME/.local/bin/agy" ] || [ -x "$HOME/.gemini/bin/agy" ] || [ -d "$HOME/.gemini/antigravity-cli" ]; then has_cli=1; fi; ',
  'has_plugin=0; ',
  'if [ -f "$HOME/.gemini/config/plugins/usage-monitor/plugin.json" ] || [ -f "$HOME/.gemini/antigravity-cli/plugins/usage-monitor/plugin.json" ] || grep -qsE "usage-monitor|cli-statusline" "$HOME/.gemini/antigravity-cli/settings.json" 2>/dev/null; then has_plugin=1; fi; ',
  'http_port=0; https_port=0; pid=0; csrf=""; ',
  'if [ "$has_plugin" = "1" ]; then ',
  '  for d in "$HOME/.gemini/antigravity-cli/daemon" "$HOME/.gemini/antigravity/daemon"; do ',
  '    [ -d "$d" ] || continue; ',
  '    for f in $(ls -1t "$d"/hub_*.json 2>/dev/null); do ',
  '      [ -f "$f" ] || continue; ',
  '      p=$(sed -n "s/.*\\\"pid\\\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p" "$f" | head -n 1); ',
  '      if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then ',
  '        hp=$(sed -n "s/.*\\\"httpPort\\\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p" "$f" | head -n 1); ',
  '        sp=$(sed -n "s/.*\\\"httpsPort\\\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p" "$f" | head -n 1); ',
  '        tk=$(sed -n "s/.*\\\"csrfToken\\\"[[:space:]]*:[[:space:]]*\\\"\\([^\\\"]*\\)\\\".*/\\1/p" "$f" | head -n 1); ',
  '        if [ -n "$hp" ] || [ -n "$sp" ]; then ',
  '          pid="$p"; http_port="${hp:-0}"; https_port="${sp:-0}"; csrf="$tk"; break 2; ',
  '        fi; ',
  '      fi; ',
  '    done; ',
  '  done; ',
  'fi; ',
  'printf "{\\"hasCli\\":%s,\\"hasCliPlugin\\":%s,\\"pid\\":%s,\\"httpPort\\":%s,\\"httpsPort\\":%s,\\"csrfToken\\":\\"%s\\"}\\n" ',
  '"$([ "$has_cli" = "1" ] && echo true || echo false)" ',
  '"$([ "$has_plugin" = "1" ] && echo true || echo false)" ',
  '"${pid:-0}" "${http_port:-0}" "${https_port:-0}" "$csrf"',
  '\'',
].join('');

/**
 * 解析远端 SSH 探测输出的单行 JSON。
 *
 * @param {string} rawStdout
 * @returns {{ hasCli: boolean, hasCliPlugin: boolean, pid: number, httpPort: number, httpsPort: number, csrfToken: string } | null}
 */
export function parseRemoteCliProbeOutput(rawStdout) {
  const lines = String(rawStdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const obj = JSON.parse(line);
      if (!obj || typeof obj !== 'object') continue;
      const toPort = (v) => {
        const n = Number(v || 0);
        return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 0;
      };
      const pidNum = Number(obj.pid || 0);
      return {
        hasCli: obj.hasCli === true,
        hasCliPlugin: obj.hasCliPlugin === true,
        pid: Number.isInteger(pidNum) && pidNum > 0 ? pidNum : 0,
        httpPort: toPort(obj.httpPort),
        httpsPort: toPort(obj.httpsPort),
        csrfToken: String(obj.csrfToken || '').trim(),
      };
    } catch {
      // 继续尝试前一行
    }
  }
  return null;
}

function defaultAllocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref?.();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? Number(addr.port || 0) : 0;
      srv.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error('Failed to allocate loopback port'));
      });
    });
  });
}

function defaultWaitForTcpPort(port, timeoutMs = 2500) {
  const deadline = Date.now() + Math.max(300, timeoutMs);
  return new Promise((resolve) => {
    const tryOnce = () => {
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      const sock = net.createConnection({ host: '127.0.0.1', port });
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        try {
          sock.destroy();
        } catch {
          // 忽略销毁异常
        }
        if (ok) {
          resolve(true);
        } else if (Date.now() + 120 < deadline) {
          const timer = setTimeout(tryOnce, 120);
          timer.unref?.();
        } else {
          resolve(false);
        }
      };
      sock.setTimeout(350);
      sock.once('connect', () => finish(true));
      sock.once('timeout', () => finish(false));
      sock.once('error', () => finish(false));
    };
    tryOnce();
  });
}

function defaultExecFile(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/**
 * 创建 Remote-SSH 远端 CLI 插件探测器与 SSH 回环隧道管理器。
 *
 * @param {{
 *   execFileFn?: (cmd: string, args: string[], opts: object) => Promise<{ stdout: string, stderr?: string }>,
 *   spawnFn?: typeof spawn,
 *   allocatePortFn?: () => Promise<number>,
 *   waitPortReadyFn?: (port: number, timeoutMs?: number) => Promise<boolean>,
 *   onStateChanged?: () => void,
 *   negativeTtlMs?: number,
 *   positiveIdleTtlMs?: number,
 *   positiveActiveTtlMs?: number,
 *   probeTimeoutMs?: number,
 * }} [options]
 */
export function createRemoteCliBridge(options = {}) {
  const execFileFn = options.execFileFn || defaultExecFile;
  const spawnFn = options.spawnFn || spawn;
  const allocatePortFn = options.allocatePortFn || defaultAllocateLoopbackPort;
  const waitPortReadyFn = options.waitPortReadyFn || defaultWaitForTcpPort;
  const onStateChanged = typeof options.onStateChanged === 'function' ? options.onStateChanged : null;
  const negativeTtlMs = Math.max(5_000, Number(options.negativeTtlMs) || DEFAULT_NEGATIVE_TTL_MS);
  const positiveIdleTtlMs = Math.max(
    3_000,
    Number(options.positiveIdleTtlMs) || DEFAULT_POSITIVE_IDLE_TTL_MS
  );
  const positiveActiveTtlMs = Math.max(
    5_000,
    Number(options.positiveActiveTtlMs) || DEFAULT_POSITIVE_ACTIVE_TTL_MS
  );
  const probeTimeoutMs = Math.max(1_000, Number(options.probeTimeoutMs) || DEFAULT_PROBE_TIMEOUT_MS);

  /** @type {Map<string, any>} */
  const cacheByHost = new Map();
  /** @type {Map<string, Promise<any>>} */
  const inFlightProbes = new Map();
  /** @type {Map<string, { proc: any, localPort: number, remotePort: number, protocol: string, ready: boolean, closing: boolean }>} */
  const tunnelsByHost = new Map();
  let stopped = false;

  function killTunnel(host) {
    const entry = tunnelsByHost.get(host);
    if (!entry) return;
    entry.closing = true;
    tunnelsByHost.delete(host);
    try {
      entry.proc?.kill?.('SIGTERM');
    } catch {
      // 忽略子进程清理异常
    }
  }

  async function ensureTunnelForHost(host, remotePort, protocol) {
    if (stopped || !host || !remotePort) return null;
    const existing = tunnelsByHost.get(host);
    if (existing && !existing.closing && existing.remotePort === remotePort && existing.protocol === protocol) {
      return existing;
    }
    if (existing) {
      killTunnel(host);
    }

    let localPort = 0;
    try {
      localPort = await allocatePortFn();
    } catch {
      return null;
    }
    if (stopped || !localPort) return null;

    let proc = null;
    try {
      proc = spawnFn(
        'ssh',
        [
          '-N',
          '-o',
          'BatchMode=yes',
          '-o',
          'ExitOnForwardFailure=yes',
          '-o',
          'ConnectTimeout=5',
          '-o',
          'ServerAliveInterval=15',
          '-o',
          'ServerAliveCountMax=3',
          '-L',
          `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
          '--',
          host,
        ],
        { stdio: 'ignore' }
      );
      proc?.unref?.();
    } catch {
      return null;
    }

    const tunnelEntry = {
      proc,
      localPort,
      remotePort,
      protocol,
      ready: false,
      closing: false,
    };
    tunnelsByHost.set(host, tunnelEntry);

    const onTunnelExit = () => {
      const cur = tunnelsByHost.get(host);
      if (cur === tunnelEntry) {
        tunnelsByHost.delete(host);
        const cached = cacheByHost.get(host);
        if (cached) {
          cached.localPort = 0;
          cached.tunnelReady = false;
          // 隧道异常断开后缩短下次重探时间，尽快重连
          cached.expiresAtMs = Math.min(cached.expiresAtMs || 0, Date.now() + 2000);
        }
        if (!tunnelEntry.closing && !stopped) {
          onStateChanged?.();
        }
      }
    };
    proc?.once?.('exit', onTunnelExit);
    proc?.once?.('error', onTunnelExit);

    const isReady = await waitPortReadyFn(localPort, 2500).catch(() => false);
    if (stopped || tunnelEntry.closing || tunnelsByHost.get(host) !== tunnelEntry) {
      return null;
    }
    if (!isReady) {
      killTunnel(host);
      return null;
    }
    tunnelEntry.ready = true;
    return tunnelEntry;
  }

  function scheduleProbe(host) {
    if (stopped || !host) return null;
    const existingPromise = inFlightProbes.get(host);
    if (existingPromise) return existingPromise;

    const prev = cacheByHost.get(host) || null;
    const promise = (async () => {
      try {
        const res = await execFileFn(
          'ssh',
          [
            '-o',
            'BatchMode=yes',
            '-o',
            'ConnectTimeout=3',
            '-o',
            'NumberOfPasswordPrompts=0',
            '--',
            host,
            REMOTE_CLI_PROBE_COMMAND,
          ],
          { timeout: probeTimeoutMs, maxBuffer: 64 * 1024 }
        );
        const parsed = parseRemoteCliProbeOutput(res?.stdout || '');
        if (!parsed) {
          killTunnel(host);
          const next = {
            host,
            status: 'error',
            hasCli: false,
            hasCliPlugin: false,
            remotePort: 0,
            protocol: 'http',
            csrfToken: '',
            localPort: 0,
            tunnelReady: false,
            updatedAtMs: Date.now(),
            expiresAtMs: Date.now() + negativeTtlMs,
          };
          cacheByHost.set(host, next);
          return next;
        }

        if (!parsed.hasCliPlugin) {
          killTunnel(host);
          const next = {
            host,
            status: 'absent',
            hasCli: parsed.hasCli,
            hasCliPlugin: false,
            remotePort: 0,
            protocol: 'http',
            csrfToken: '',
            localPort: 0,
            tunnelReady: false,
            updatedAtMs: Date.now(),
            expiresAtMs: Date.now() + negativeTtlMs,
          };
          cacheByHost.set(host, next);
          if (prev?.hasCliPlugin) onStateChanged?.();
          return next;
        }

        const remotePort = parsed.httpPort || parsed.httpsPort || 0;
        const protocol = parsed.httpPort ? 'http' : 'https';
        let localPort = 0;
        let tunnelReady = false;
        if (remotePort > 0 && parsed.csrfToken) {
          const tun = await ensureTunnelForHost(host, remotePort, protocol);
          if (tun && tun.ready) {
            localPort = tun.localPort;
            tunnelReady = true;
          }
        } else {
          killTunnel(host);
        }

        const next = {
          host,
          status: 'ready',
          hasCli: parsed.hasCli,
          hasCliPlugin: true,
          remotePort,
          protocol,
          csrfToken: parsed.csrfToken,
          localPort,
          tunnelReady,
          updatedAtMs: Date.now(),
          expiresAtMs: Date.now() + (tunnelReady ? positiveActiveTtlMs : positiveIdleTtlMs),
        };
        cacheByHost.set(host, next);

        const changed =
          !prev ||
          prev.hasCliPlugin !== next.hasCliPlugin ||
          prev.localPort !== next.localPort ||
          prev.csrfToken !== next.csrfToken ||
          prev.tunnelReady !== next.tunnelReady;
        if (changed && !stopped) {
          onStateChanged?.();
        }
        return next;
      } catch {
        // SSH 不可达或需要交互认证时静默缓存负结果，不弹窗不刷屏
        const existingTun = tunnelsByHost.get(host);
        if (existingTun && existingTun.ready && prev?.hasCliPlugin) {
          // 已有存活隧道时保留状态并稍后重试
          prev.expiresAtMs = Date.now() + positiveIdleTtlMs;
          return prev;
        }
        killTunnel(host);
        const next = {
          host,
          status: 'error',
          hasCli: false,
          hasCliPlugin: false,
          remotePort: 0,
          protocol: 'http',
          csrfToken: '',
          localPort: 0,
          tunnelReady: false,
          updatedAtMs: Date.now(),
          expiresAtMs: Date.now() + negativeTtlMs,
        };
        cacheByHost.set(host, next);
        return next;
      } finally {
        inFlightProbes.delete(host);
      }
    })();

    inFlightProbes.set(host, promise);
    return promise;
  }

  /**
   * 同步获取某 SSH 主机的远端 CLI 插件状态；若缓存过期则在后台异步触发单次探测。
   *
   * @param {string} rawHost
   * @returns {{
   *   host: string,
   *   status: string,
   *   hasCli: boolean,
   *   hasCliPlugin: boolean,
   *   remotePort: number,
   *   protocol: string,
   *   csrfToken: string,
   *   localPort: number,
   *   tunnelReady: boolean,
   * }}
   */
  function getOrScheduleHost(rawHost) {
    const host = sanitizeSshHost(rawHost);
    if (!host) {
      return {
        host: '',
        status: 'invalid',
        hasCli: false,
        hasCliPlugin: false,
        remotePort: 0,
        protocol: 'http',
        csrfToken: '',
        localPort: 0,
        tunnelReady: false,
      };
    }
    const now = Date.now();
    const cached = cacheByHost.get(host);
    if (!cached || now >= Number(cached.expiresAtMs || 0)) {
      void scheduleProbe(host);
    }
    if (cached) {
      const tun = tunnelsByHost.get(host);
      return {
        ...cached,
        localPort: tun && tun.ready ? tun.localPort : 0,
        tunnelReady: Boolean(tun && tun.ready),
      };
    }
    return {
      host,
      status: 'pending',
      hasCli: false,
      hasCliPlugin: false,
      remotePort: 0,
      protocol: 'http',
      csrfToken: '',
      localPort: 0,
      tunnelReady: false,
    };
  }

  /**
   * 清理已不再活跃（窗口已关闭或已改用 VS Code 扩展）的 SSH 隧道。
   *
   * @param {Set<string>} activeHosts
   */
  function pruneInactiveHosts(activeHosts) {
    const keep = activeHosts instanceof Set ? activeHosts : new Set();
    for (const host of Array.from(tunnelsByHost.keys())) {
      if (!keep.has(host)) {
        killTunnel(host);
      }
    }
  }

  function stopAll() {
    stopped = true;
    for (const host of Array.from(tunnelsByHost.keys())) {
      killTunnel(host);
    }
    cacheByHost.clear();
    inFlightProbes.clear();
  }

  return {
    getOrScheduleHost,
    probeHostNow: (rawHost) => {
      const host = sanitizeSshHost(rawHost);
      return host ? scheduleProbe(host) : Promise.resolve(null);
    },
    pruneInactiveHosts,
    stopAll,
    getActiveTunnelCount: () => tunnelsByHost.size,
  };
}
