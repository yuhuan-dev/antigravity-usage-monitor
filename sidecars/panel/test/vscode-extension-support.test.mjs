/**
 * @fileoverview VS Code 官方扩展、Remote-SSH 端点隔离与远端 `agy` CLI 插件适配回归测试。
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { registerRemoteEndpoint, setRemoteWindowRpcInvoker } from '../backend/endpoint-registry.mjs';
import { callLsRpc } from '../backend/ls-rpc.mjs';
import {
  createRemoteCliBridge,
  parseRemoteCliProbeOutput,
  sanitizeSshHost,
} from '../backend/remote-cli-bridge.mjs';
import { normalizeFullSettings } from '../backend/settings-schema.mjs';
import {
  createWindowBridgeController,
  hasLocalAgyCli,
  hasLocalAgyCliPlugin,
} from '../backend/window-bridge.mjs';
import { isVsCodeExtensionHost } from '../shared/window-bridge-protocol.mjs';
import { I18N_MESSAGES_EN_US } from '../src/i18n/en-US.js';
import { I18N_MESSAGES_ZH_CN } from '../src/i18n/zh-CN.js';

test('VS Code settings schema defaults vsCodeMountMode to composer, rejects sidebar, and exposes Top Bar / Input Box labels', () => {
  const def = normalizeFullSettings({});
  assert.equal(def.vsCodeMountMode, 'composer');
  assert.equal(def.windowMountMode, 'dual');
  assert.equal(normalizeFullSettings({ vsCodeMountMode: 'sidebar' }).vsCodeMountMode, 'composer');
  assert.equal(normalizeFullSettings({ vsCodeMountMode: 'dual' }).vsCodeMountMode, 'dual');

  assert.equal(I18N_MESSAGES_ZH_CN['settings.str.mountVsCodeComposer'], '输入框');
  assert.equal(I18N_MESSAGES_ZH_CN['settings.str.mountVsCodeTopbar'], '顶部栏');
  assert.equal(I18N_MESSAGES_EN_US['settings.str.mountVsCodeComposer'], 'Input Box');
  assert.equal(I18N_MESSAGES_EN_US['settings.str.mountVsCodeTopbar'], 'Top Bar');

  const prevWindow = globalThis.window;
  try {
    globalThis.window = { __AGUsageMonitorBridge: { isVsCodeHost: true } };
    assert.equal(isVsCodeExtensionHost(), true);
    globalThis.window = { __AGUsageMonitorBridge: { isVsCodeHost: false } };
    assert.equal(isVsCodeExtensionHost(), false);
  } finally {
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
  }
});

test('hasLocalAgyCliPlugin requires both agy CLI and usage-monitor CLI plugin', () => {
  const fakeOnlyCli = {
    existsFn: (p) => String(p).endsWith('antigravity-cli'),
    readFileFn: () => '{}',
  };
  assert.equal(hasLocalAgyCli({}, '/fake-home', fakeOnlyCli), true);
  assert.equal(hasLocalAgyCliPlugin({}, '/fake-home', fakeOnlyCli), false);

  const fakeCliWithPlugin = {
    existsFn: (p) =>
      String(p).endsWith('antigravity-cli') ||
      String(p).endsWith(join('usage-monitor', 'plugin.json')),
    readFileFn: () => '{}',
  };
  assert.equal(hasLocalAgyCliPlugin({}, '/fake-home', fakeCliWithPlugin), true);
});

test('remote-cli-bridge validates SSH hostnames, probes remote CLI plugin, manages tunnels, and prunes cleanly', async () => {
  assert.equal(sanitizeSshHost('gpu-node'), 'gpu-node');
  assert.equal(sanitizeSshHost('user@10.0.0.8'), 'user@10.0.0.8');
  assert.equal(sanitizeSshHost('-oProxyCommand=bad'), '');
  assert.equal(sanitizeSshHost('bad host; rm -rf /'), '');

  assert.deepEqual(
    parseRemoteCliProbeOutput(
      'banner line\n{"hasCli":true,"hasCliPlugin":true,"pid":4321,"httpPort":51111,"httpsPort":51112,"csrfToken":"tok-cli"}\n'
    ),
    {
      hasCli: true,
      hasCliPlugin: true,
      pid: 4321,
      httpPort: 51111,
      httpsPort: 51112,
      csrfToken: 'tok-cli',
    }
  );

  const spawned = [];
  let changeEvents = 0;
  const cliBridge = createRemoteCliBridge({
    execFileFn: async (_cmd, args) => {
      const host = args[args.length - 2];
      if (host === 'cli-box') {
        return {
          stdout:
            '{"hasCli":true,"hasCliPlugin":true,"pid":999,"httpPort":54001,"httpsPort":54002,"csrfToken":"cli-csrf"}\n',
        };
      }
      return {
        stdout:
          '{"hasCli":false,"hasCliPlugin":false,"pid":0,"httpPort":0,"httpsPort":0,"csrfToken":""}\n',
      };
    },
    spawnFn: (_cmd, args) => {
      const proc = new EventEmitter();
      proc.killed = false;
      proc.args = args;
      proc.kill = () => {
        proc.killed = true;
        proc.emit('exit', 0);
      };
      proc.unref = () => {};
      spawned.push(proc);
      return proc;
    },
    allocatePortFn: async () => 61234,
    waitPortReadyFn: async () => true,
    onStateChanged: () => {
      changeEvents += 1;
    },
  });

  const cliState = await cliBridge.probeHostNow('cli-box');
  const plainState = await cliBridge.probeHostNow('plain-box');
  assert.equal(cliState.hasCliPlugin, true);
  assert.equal(cliState.tunnelReady, true);
  assert.equal(cliState.localPort, 61234);
  assert.equal(cliState.csrfToken, 'cli-csrf');
  assert.equal(plainState.hasCliPlugin, false);
  assert.equal(spawned.length, 1);
  assert.ok(changeEvents >= 1);

  cliBridge.pruneInactiveHosts(new Set());
  assert.equal(spawned[0].killed, true);
  assert.equal(cliBridge.getActiveTunnelCount(), 0);
  cliBridge.stopAll();
});

test('VS Code window gating: skips plain SSH, mounts remote/local CLI-only on Top Bar, mounts VS Code ext in Input Box even when Desktop is sidebar', async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'um-vscode-support-'));
  mkdirSync(join(tmpHome, '.gemini', 'antigravity-cli'), { recursive: true });
  mkdirSync(join(tmpHome, '.gemini', 'config', 'plugins', 'usage-monitor'), { recursive: true });
  writeFileSync(join(tmpHome, '.gemini', 'config', 'plugins', 'usage-monitor', 'plugin.json'), '{}');

  const spawned = [];
  const cliBridge = createRemoteCliBridge({
    execFileFn: async (_cmd, args) => {
      const host = args[args.length - 2];
      if (host === 'cli-box') {
        return {
          stdout:
            '{"hasCli":true,"hasCliPlugin":true,"pid":888,"httpPort":54100,"httpsPort":0,"csrfToken":"cli-token"}\n',
        };
      }
      return {
        stdout:
          '{"hasCli":false,"hasCliPlugin":false,"pid":0,"httpPort":0,"httpsPort":0,"csrfToken":""}\n',
      };
    },
    spawnFn: () => {
      const proc = new EventEmitter();
      proc.killed = false;
      proc.kill = () => {
        proc.killed = true;
        proc.emit('exit', 0);
      };
      proc.unref = () => {};
      spawned.push(proc);
      return proc;
    },
    allocatePortFn: async () => 61235,
    waitPortReadyFn: async () => true,
  });
  await cliBridge.probeHostNow('cli-box');
  await cliBridge.probeHostNow('plain-box');

  const targets = [
    {
      id: 'page-ssh-plain',
      type: 'page',
      title: 'a.py — repo [SSH: plain-box]',
      url: 'vscode-file://vscode-app/Applications/Visual%20Studio%20Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/ssh-plain',
    },
    {
      id: 'page-ssh-cli',
      type: 'page',
      title: 'b.py — repo [SSH: cli-box]',
      url: 'vscode-file://vscode-app/Applications/Visual%20Studio%20Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/ssh-cli',
    },
    {
      id: 'page-ssh-ext',
      type: 'page',
      title: 'c.py — repo [SSH: ext-box]',
      url: 'vscode-file://vscode-app/Applications/Visual%20Studio%20Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/ssh-ext',
    },
    {
      id: 'wv-ssh-ext',
      type: 'iframe',
      parentId: 'page-ssh-ext',
      url: 'vscode-webview://1/?extensionId=google.google-antigravity&remoteAuthority=ssh-remote%2Bext-box&purpose=webviewView',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/wv-ext',
    },
    {
      id: 'chat-ssh-ext',
      type: 'iframe',
      parentId: 'wv-ssh-ext',
      url: 'http://127.0.0.1:53000/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?extensionView=true&extensionVariant=vs-code&remoteKind=ssh-remote',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/chat-ext',
    },
    {
      id: 'page-local-cli-only',
      type: 'page',
      title: 'local.py — proj',
      url: 'vscode-file://vscode-app/Applications/Visual%20Studio%20Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/local-cli',
    },
  ];

  const cdpSrv = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(targets));
  });
  await new Promise((r) => cdpSrv.listen(0, '127.0.0.1', r));
  const cdpPort = cdpSrv.address().port;

  const evaluated = [];
  class FakeWS {
    constructor(url) {
      this.url = url;
      this._listeners = {};
      queueMicrotask(() => this._emit('open', {}));
    }
    addEventListener(ev, fn) {
      (this._listeners[ev] ||= []).push(fn);
    }
    _emit(ev, data) {
      for (const fn of this._listeners[ev] || []) fn(data);
    }
    send(raw) {
      const msg = JSON.parse(raw);
      const expr = String(msg?.params?.expression || '');
      const isInject = expr.includes('__MOCK_APP_JS__');
      evaluated.push({
        wsUrl: this.url,
        isInject,
        mountDual: expr.includes('"mountMode":"dual"'),
        mountComposer: expr.includes('"mountMode":"composer"'),
        forceTopbar: expr.includes('"forceTopbarMode":true'),
        isRemote: expr.includes('"isRemoteEndpoint":true'),
        cliLabel: expr.includes('"endpointLabel":"cli-box (CLI)"'),
      });
      let val = false;
      if (expr.includes('__APP_CONFIG__')) {
        val = {
          href: 'http://127.0.0.1:53000/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          origin: 'http://127.0.0.1:53000',
          port: 53000,
          csrfToken: 'tok-ext',
        };
      } else if (isInject) {
        val = {
          alive: true,
          dockKind: expr.includes('"mountMode":"composer"') ? 'composer' : 'ide-titlebar',
          visible: true,
        };
      }
      queueMicrotask(() =>
        this._emit('message', {
          data: JSON.stringify({ id: msg.id, result: { result: { value: val } } }),
        })
      );
    }
    close() {}
  }

  const bridge = createWindowBridgeController({
    env: { ANTIGRAVITY_DEVTOOLS_PORT: String(cdpPort) },
    homeDir: tmpHome,
    remoteCliBridge: cliBridge,
    getSettingsFn: () => ({
      windowMountMode: 'sidebar',
      enableWindowOverlay: false,
      vsCodeMountMode: 'composer',
    }),
    handleApiRequest: async () => ({ status: 200, body: '{}' }),
    getBundleVersionFn: () => 'test-vscode-v1',
    readAssetFn: async (p) => (String(p).endsWith('app.js') ? '/* __MOCK_APP_JS__ */' : '/* css */'),
    WebSocketImpl: FakeWS,
    getLocalHubPortsFn: () => ({ allPorts: new Set(), csrfTokens: new Set() }),
    autoConfigureIdeArgv: false,
    pollIntervalMs: 60000,
  });

  try {
    await bridge.syncAllWindows();

    assert.equal(
      evaluated.filter((e) => e.wsUrl.includes('ssh-plain') && e.isInject).length,
      0
    );

    const sshCliInj = evaluated.filter((e) => e.wsUrl.includes('ssh-cli') && e.isInject);
    assert.equal(sshCliInj.length, 1);
    assert.equal(sshCliInj[0].mountDual, true);
    assert.equal(sshCliInj[0].forceTopbar, true);
    assert.equal(sshCliInj[0].isRemote, true);
    assert.equal(sshCliInj[0].cliLabel, true);

    const sshExtChatInj = evaluated.filter((e) => e.wsUrl.includes('chat-ext') && e.isInject);
    assert.equal(sshExtChatInj.length, 1);
    assert.equal(sshExtChatInj[0].mountComposer, true);
    assert.equal(
      evaluated.filter((e) => e.wsUrl.includes('ssh-ext') && e.isInject).length,
      0
    );

    const localCliInj = evaluated.filter((e) => e.wsUrl.includes('local-cli') && e.isInject);
    assert.equal(localCliInj.length, 1);
    assert.equal(localCliInj[0].mountDual, true);
    assert.equal(localCliInj[0].forceTopbar, true);
  } finally {
    await bridge.stop();
    cdpSrv.close();
    rmSync(tmpHome, { recursive: true, force: true });
  }
  assert.equal(spawned[0].killed, true);
});

test('tier1Only remote CLI endpoints never invoke Tier-2 CDP fallback or trip Tier-2 cooldown', async () => {
  let tier2Called = false;
  setRemoteWindowRpcInvoker(async () => {
    tier2Called = true;
    return {};
  });
  try {
    const ep = registerRemoteEndpoint({
      origin: 'http://127.0.0.1:1',
      baseUrl: 'http://127.0.0.1:1',
      csrfToken: 'x',
      stableHostKey: 'ssh-cli:tier1only-test',
      tier1Only: true,
    });
    await assert.rejects(() => callLsRpc('GetUserStatus', {}, 1000, ep));
    assert.equal(tier2Called, false);
    assert.equal(ep.preferTier2UntilMs, 0);
  } finally {
    setRemoteWindowRpcInvoker(null);
  }
});

test('compiled app.js bundle contains VS Code host labels and forceTopbarMode support', () => {
  const appJs = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.ok(appJs.includes('mountVsCodeComposer'));
  assert.ok(appJs.includes('mountVsCodeTopbar'));
  assert.ok(appJs.includes('isVsCodeExtensionHost'));
  assert.ok(appJs.includes('forceTopbarMode'));
});
