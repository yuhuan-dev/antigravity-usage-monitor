/**
 * @fileoverview Antigravity IDE / 2.0 / CLI 独立后台守护进程 (`bridge-daemon.mjs`)。
 *
 * 由 `mcp-entry.mjs` 托管拉起（亦支持命令行 `--standalone` 直接启动），负责：
 * 1. 动态探测本机运行中的 `agy` (`daemon/hub_*.json` / `--hub` / `remote-control`) 或 `language_server` 端点；
 * 2. 在桌面端 / IDE 环境启动本地回环桥接服务并通过 CDP 挂载监控胶囊；
 * 3. 当配置了 `USAGE_MONITOR_STANDALONE_PORT` 或 `settings.json` 中的 `standalonePort`（`1024..65535`）时，
 *    自动在后台托管独立 Web 监控端口，无需手工另开进程；
 * 4. 收到父进程 `SHUTDOWN_DISPOSE` 指令或终止信号时，主动清理窗口浮层与独立端口并平滑退出。
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function startBridgeDaemon() {
  const [
    { bootBundleVersion, bootWindowBridgeRuntime, setStandalonePortListener },
    { computeRuntimeCodeVersion, loadSettings, normalizeStandalonePort },
    { createStandaloneWebServer, parseStandaloneCliArgs },
    { stopLocalBackgroundCacheRebuild },
  ] = await Promise.all([
    import('./backend/api-actions.mjs'),
    import('./backend/config.mjs'),
    import('./backend/standalone-server.mjs'),
    import('./backend/local-scanner.mjs'),
  ]);

  let shuttingDown = false;
  let sawShutdownDispose = false;
  let stdinBuf = '';
  let standaloneController = null;
  let activeStandalonePort = 0;
  let reconcileChain = Promise.resolve();

  const envArgs = parseStandaloneCliArgs([], process.env, { defaultPort: 0 });
  const envPinnedPort = envArgs.portExplicit ? normalizeStandalonePort(envArgs.port) : null;

  const triggerRestart = () => {
    void shutdown({ disposeWindows: false, exitCode: 0 });
  };

  const controller = bootWindowBridgeRuntime({
    allowDynamicLs: true,
    onRestart: triggerRestart,
  });

  const driftWatchTimer = setInterval(() => {
    if (shuttingDown) return;
    try {
      const diskVersion = String(computeRuntimeCodeVersion() || '');
      if (bootBundleVersion && diskVersion && diskVersion !== String(bootBundleVersion)) {
        triggerRestart();
      }
    } catch {
      // 忽略文件覆盖期间瞬态 stat 异常
    }
  }, 3000);
  driftWatchTimer.unref?.();

  function resolveDesiredStandalonePort(settingsOverride = null) {
    if (envPinnedPort !== null) {
      return envPinnedPort;
    }
    const settings = settingsOverride || loadSettings();
    return normalizeStandalonePort(settings?.standalonePort);
  }

  function scheduleStandaloneReconcile(targetPort) {
    reconcileChain = reconcileChain
      .then(async () => {
        if (shuttingDown) return;
        const nextPort = normalizeStandalonePort(targetPort);
        if (nextPort === activeStandalonePort && standaloneController) {
          return;
        }
        if (standaloneController) {
          const prev = standaloneController;
          standaloneController = null;
          activeStandalonePort = 0;
          await prev.stop().catch(() => {});
        }
        if (nextPort <= 0 || shuttingDown) {
          return;
        }
        try {
          const srv = createStandaloneWebServer({
            host: envArgs.host,
            port: nextPort,
            token: envArgs.token,
            onRestart: triggerRestart,
            skipStartupDiscovery: true,
          });
          const status = await srv.start();
          standaloneController = srv;
          activeStandalonePort = nextPort;
          console.error(`[usage-monitor] Auto-hosted standalone Web UI at ${status.url}`);
        } catch (err) {
          if (err?.code === 'EADDRINUSE') {
            console.error(
              `[usage-monitor] Standalone port ${nextPort} already in use; keeping existing listener.`
            );
          } else {
            console.error(`[usage-monitor] Auto-hosted standalone server skipped: ${err.message}`);
          }
        }
      })
      .catch(() => {});
  }

  setStandalonePortListener((updatedPort) => {
    if (envPinnedPort === null) {
      scheduleStandaloneReconcile(updatedPort);
    }
  });
  scheduleStandaloneReconcile(resolveDesiredStandalonePort());

  async function shutdown({ disposeWindows = false, exitCode = 0 } = {}) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(driftWatchTimer);
    setStandalonePortListener(null);
    const forceTimer = setTimeout(() => {
      process.exit(exitCode);
    }, 1500);
    forceTimer.unref?.();
    try {
      await stopLocalBackgroundCacheRebuild().catch(() => {});
      await Promise.allSettled([
        controller?.stop?.({ disposeWindows }),
        standaloneController?.stop?.(),
      ]);
    } catch {
      // 忽略退出清理异常
    } finally {
      clearTimeout(forceTimer);
      process.exit(exitCode);
    }
  }

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    stdinBuf += String(chunk || '');
    if (stdinBuf.includes('SHUTDOWN_DISPOSE')) {
      sawShutdownDispose = true;
      void shutdown({ disposeWindows: true, exitCode: 0 });
    } else if (stdinBuf.includes('SHUTDOWN_STANDBY')) {
      void shutdown({ disposeWindows: false, exitCode: 0 });
    } else if (stdinBuf.length > 4096) {
      stdinBuf = stdinBuf.slice(-1024);
    }
  });

  process.stdin.on('end', () => {
    void shutdown({ disposeWindows: sawShutdownDispose, exitCode: 0 });
  });
  process.stdin.on('close', () => {
    void shutdown({ disposeWindows: sawShutdownDispose, exitCode: 0 });
  });
  process.on('SIGTERM', () => {
    void shutdown({ disposeWindows: true, exitCode: 0 });
  });
  process.on('SIGINT', () => {
    void shutdown({ disposeWindows: true, exitCode: 0 });
  });

  process.stdin.resume();
  return controller;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  const cliArgs = process.argv.slice(2);
  if (cliArgs.includes('--standalone') || cliArgs.includes('--help') || cliArgs.includes('-h')) {
    void import('./standalone.mjs').then(({ runStandaloneCli }) => runStandaloneCli(cliArgs));
  } else {
    void startBridgeDaemon();
  }
}
