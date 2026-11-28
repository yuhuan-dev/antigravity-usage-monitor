/**
 * @fileoverview VS Code 官方扩展、Remote-SSH 端点隔离、远端 `agy` CLI 兜底与客户端状态同步回归测试。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  classifyDevToolsPortProduct,
  createDevToolsPortProber,
} from '../backend/devtools-port-probe.mjs';
import {
  clearRemoteEndpointRegistry,
  getRegisteredRemoteEndpoint,
  registerRemoteEndpoint,
  setRemoteWindowRpcInvoker,
} from '../backend/endpoint-registry.mjs';
import {
  IDE_SSH_REMOTE_PROBE_SH,
  createIdeRemoteSshCoordinator,
  parseRemoteProbeCapabilities,
} from '../backend/ide-remote-ssh.mjs';
import { callLsRpc } from '../backend/ls-rpc.mjs';
import { normalizeFullSettings } from '../backend/settings-schema.mjs';
import {
  createWindowBridgeController,
  ensureVsCodeRemoteDebuggingArgv,
  hasLocalAgyCli,
  hasLocalAgyCliPlugin,
  resolveVsCodeDevToolsPortCandidates,
} from '../backend/window-bridge.mjs';
import {
  WINDOW_BRIDGE_KEY,
  isVsCodeExtensionHost,
  isVsCodeHostUrl,
  resolveClientEffectiveOverlayMountMode,
} from '../shared/window-bridge-protocol.mjs';
import { parseIdeRemoteAuthority } from '../shared/workspace-uri.mjs';
import {
  buildExportableSettingsJson,
  parseImportedSettingsJson,
} from '../src/core/settingsBackup.js';
import { I18N_DICTIONARIES } from '../src/i18n/index.js';
import { I18N_MESSAGES_EN_US } from '../src/i18n/en-US.js';
import { extractHostRouteCascadeId } from '../src/store/telemetryStore.js';

test('VS Code settings schema, portable backup, and all supported i18n locales support vsCodeMountMode', () => {
  const def = normalizeFullSettings({});
  assert.equal(def.vsCodeMountMode, 'composer');
  assert.equal(def.windowMountMode, 'dual');
  assert.equal(normalizeFullSettings({ vsCodeMountMode: 'sidebar' }).vsCodeMountMode, 'composer');
  assert.equal(normalizeFullSettings({ vsCodeMountMode: 'dual' }).vsCodeMountMode, 'dual');
  assert.equal(normalizeFullSettings({ vsCodeMountMode: 'topbar' }).vsCodeMountMode, 'dual');

  const exported = buildExportableSettingsJson({ vsCodeMountMode: 'dual', windowMountMode: 'sidebar' });
  const imported = parseImportedSettingsJson(exported);
  assert.equal(imported.ok, true);
  assert.equal(imported.patch.vsCodeMountMode, 'dual');
  assert.equal(imported.patch.windowMountMode, 'sidebar');

  const locales = Object.values(I18N_DICTIONARIES);
  const baseKeys = Object.keys(I18N_MESSAGES_EN_US).sort();
  for (const dict of locales) {
    assert.ok(dict['settings.str.mountVsCodeComposer'], 'missing mountVsCodeComposer');
    assert.ok(dict['settings.str.mountVsCodeTopbar'], 'missing mountVsCodeTopbar');
    assert.deepEqual(Object.keys(dict).sort(), baseKeys);
  }
});

test('isVsCodeHostUrl and resolveClientEffectiveOverlayMountMode handle cross-platform URLs and forceTopbarMode', () => {
  assert.equal(
    isVsCodeHostUrl(
      'vscode-file://vscode-app/Applications/Visual%20Studio%20Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html'
    ),
    true
  );
  assert.equal(
    isVsCodeHostUrl(
      'vscode-file://vscode-app/c:/Users/dev/AppData/Local/Programs/Microsoft%20VS%20Code/resources/app/out/vs/code/electron-browser/workbench/workbench.html'
    ),
    true
  );
  assert.equal(
    isVsCodeHostUrl(
      'vscode-file://vscode-app/c:/Users/dev/AppData/Local/Programs/Microsoft%20VS%20Code%20Insiders/resources/app/out/vs/code/electron-browser/workbench/workbench.html'
    ),
    true
  );
  assert.equal(
    isVsCodeHostUrl(
      'vscode-file://vscode-app/usr/share/code/resources/app/out/vs/code/electron-browser/workbench/workbench.html'
    ),
    true
  );
  assert.equal(
    isVsCodeHostUrl('http://127.0.0.1:53000/c/11111111-2222-3333-4444-555555555555?extensionVariant=vs-code'),
    true
  );
  assert.equal(
    isVsCodeHostUrl(
      'vscode-file://vscode-app/c:/Program%20Files/Antigravity%20IDE/resources/app/out/vs/code/electron-browser/workbench/workbench.html'
    ),
    false
  );
  assert.equal(isVsCodeHostUrl('https://127.0.0.1:42100/c/11111111-2222-3333-4444-555555555555'), false);

  assert.equal(isVsCodeExtensionHost({ isVsCodeHost: true }), true);
  assert.equal(isVsCodeExtensionHost({ isVsCodeHost: false }), false);

  // forceTopbarMode must always resolve to 'dual' even when vsCodeMountMode is 'composer'
  assert.equal(
    resolveClientEffectiveOverlayMountMode(
      { windowMountMode: 'sidebar', enableWindowOverlay: false, vsCodeMountMode: 'composer' },
      { isVsCodeHost: true, forceTopbarMode: true, mountMode: 'dual' }
    ),
    'dual'
  );
  // Standard VS Code host ignores Desktop 'sidebar' mode
  assert.equal(
    resolveClientEffectiveOverlayMountMode(
      { windowMountMode: 'sidebar', enableWindowOverlay: false, vsCodeMountMode: 'composer' },
      { isVsCodeHost: true, forceTopbarMode: false, mountMode: 'composer' }
    ),
    'composer'
  );
  assert.equal(
    resolveClientEffectiveOverlayMountMode(
      { windowMountMode: 'sidebar', enableWindowOverlay: false, vsCodeMountMode: 'dual' },
      { isVsCodeHost: true, forceTopbarMode: false, mountMode: 'composer' }
    ),
    'dual'
  );
  // Desktop host continues honoring windowMountMode
  assert.equal(
    resolveClientEffectiveOverlayMountMode(
      { windowMountMode: 'sidebar', enableWindowOverlay: false, vsCodeMountMode: 'dual' },
      { isVsCodeHost: false, forceTopbarMode: false, mountMode: 'dual' }
    ),
    'sidebar'
  );
});

test('devtools-port-probe isolates vscode product without false positives on user folder names', async () => {
  assert.equal(
    classifyDevToolsPortProduct('C:\\Users\\dev\\AppData\\Roaming\\Code\\DevToolsActivePort'),
    'vscode'
  );
  assert.equal(
    classifyDevToolsPortProduct('/Users/dev/Library/Application Support/Code - Insiders/DevToolsActivePort'),
    'vscode'
  );
  assert.equal(
    classifyDevToolsPortProduct('/home/dev/.config/Code/DevToolsActivePort'),
    'vscode'
  );
  assert.equal(
    classifyDevToolsPortProduct('/home/dev/code/Antigravity/DevToolsActivePort'),
    'desktop'
  );
  assert.equal(
    classifyDevToolsPortProduct('C:\\Users\\dev\\AppData\\Roaming\\Antigravity IDE\\DevToolsActivePort'),
    'ide'
  );

  const prober = createDevToolsPortProber({
    fetchVersionFn: async (port) => ({
      Browser: 'Electron',
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/live-id`,
    }),
    fsOps: {
      existsSync: () => true,
      statSync: () => ({ mtimeMs: 1000, size: 32 }),
      readFileSync: (p) =>
        String(p).includes('Code')
          ? '9333\n/devtools/browser/live-id\n'
          : '9222\n/devtools/browser/live-id\n',
    },
  });
  const report = await prober.probeActiveDevToolsPorts({
    candidateFiles: [
      '/Users/dev/Library/Application Support/Antigravity/DevToolsActivePort',
      '/Users/dev/Library/Application Support/Code/DevToolsActivePort',
    ],
  });
  assert.deepEqual(report.livePorts, [9222, 9333]);
  assert.deepEqual(report.vsCodeLivePorts, [9333]);
});

test('local CLI/plugin detection handles Windows Path casing, disabled statusLine, and argv.json toggle', () => {
  const winFs = {
    existsFn: (p) => String(p).replace(/\\/g, '/').endsWith('/custom-bin/agy.cmd'),
    readFileFn: () => '{}',
  };
  assert.equal(
    hasLocalAgyCli({ Path: '"C:\\custom-bin";C:\\Windows' }, 'C:\\Users\\dev', winFs, 'win32'),
    true
  );

  const disabledStatusLineFs = {
    existsFn: (p) =>
      String(p).endsWith('antigravity-cli') || String(p).endsWith('settings.json'),
    readFileFn: () => JSON.stringify({ statusLine: { enabled: false, command: 'node cli-statusline.mjs' } }),
  };
  assert.equal(hasLocalAgyCliPlugin({}, '/fake-home', disabledStatusLineFs, 'linux'), false);

  const activeStatusLineFs = {
    existsFn: (p) =>
      String(p).endsWith('antigravity-cli') || String(p).endsWith('settings.json'),
    readFileFn: () => JSON.stringify({ statusLine: { enabled: true, command: 'node /opt/cli-statusline.mjs' } }),
  };
  assert.equal(hasLocalAgyCliPlugin({}, '/fake-home', activeStatusLineFs, 'linux'), true);

  const tmpHome = mkdtempSync(join(tmpdir(), 'um-vscode-argv-'));
  try {
    mkdirSync(join(tmpHome, '.vscode', 'extensions', 'ms-vscode-remote.remote-ssh-0.115.0'), {
      recursive: true,
    });
    writeFileSync(join(tmpHome, '.vscode', 'argv.json'), '// keep comment\n{\n\t"enable-crash-reporter": true\n}\n');

    // When enableRemoteSsh is false, Remote-SSH alone does not enable VS Code probing or argv provisioning
    assert.deepEqual(
      resolveVsCodeDevToolsPortCandidates({}, 'darwin', tmpHome, null, { enableRemoteSsh: false }),
      []
    );
    const skippedRes = ensureVsCodeRemoteDebuggingArgv({
      env: {},
      homeDir: tmpHome,
      enabled: true,
      enableRemoteSsh: false,
    });
    assert.equal(skippedRes.updated, false);

    // When enabled with enableRemoteSsh: true, writes managed "0" preserving comments
    const enabledRes = ensureVsCodeRemoteDebuggingArgv({
      env: {},
      homeDir: tmpHome,
      enabled: true,
      enableRemoteSsh: true,
    });
    assert.equal(enabledRes.updated, true);
    const afterEnable = readFileSync(join(tmpHome, '.vscode', 'argv.json'), 'utf8');
    assert.match(afterEnable, /"remote-debugging-port": "0"/);
    assert.match(afterEnable, /\/\/ keep comment/);

    // When disabled (autoConfigureLaunch = false), cleanly strips managed "0"
    const disabledRes = ensureVsCodeRemoteDebuggingArgv({
      env: {},
      homeDir: tmpHome,
      enabled: false,
      enableRemoteSsh: false,
    });
    assert.equal(disabledRes.removed, true);
    const afterDisable = readFileSync(join(tmpHome, '.vscode', 'argv.json'), 'utf8');
    assert.doesNotMatch(afterDisable, /remote-debugging-port/);
    assert.match(afterDisable, /\/\/ keep comment/);
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('ide-remote-ssh capabilities section gates plain SSH hosts from spawning tunnels while supporting remote CLI-only tunnels', async () => {
  assert.match(IDE_SSH_REMOTE_PROBE_SH, /===UM_CAPABILITIES===/);
  assert.match(IDE_SSH_REMOTE_PROBE_SH, /\.vscode-server/);

  assert.deepEqual(parseRemoteProbeCapabilities('===UM_DAEMON_JSON===\n{}\n'), {
    known: false,
    hasCli: false,
    hasCliPlugin: false,
    hasVsCodeExt: false,
  });
  assert.deepEqual(
    parseRemoteProbeCapabilities('===UM_CAPABILITIES===\nhasCli=1\nhasCliPlugin=1\nhasVsCodeExt=0\n'),
    {
      known: true,
      hasCli: true,
      hasCliPlugin: true,
      hasVsCodeExt: false,
    }
  );

  const tunnels = [];
  const coordinator = createIdeRemoteSshCoordinator({
    allowInTest: true,
    execSshProbeFn: async (args) => {
      const dest = args[args.indexOf('--') + 1];
      if (dest === 'cli-box') {
        return [
          '===UM_DAEMON_JSON===',
          '{"pid":999,"httpPort":54001,"csrfToken":"cli-csrf"}',
          '===UM_PS===',
          '999 /usr/local/bin/agy --hub',
          '===UM_CAPABILITIES===',
          'hasCli=1',
          'hasCliPlugin=1',
          'hasVsCodeExt=0',
        ].join('\n');
      }
      return [
        '===UM_DAEMON_JSON===',
        '===UM_PS===',
        '===UM_CAPABILITIES===',
        'hasCli=0',
        'hasCliPlugin=0',
        'hasVsCodeExt=0',
      ].join('\n');
    },
    openTunnelFn: async ({ parsedAuthority, remotePort }) => {
      let alive = true;
      const handle = {
        host: parsedAuthority.sshDestination,
        localPort: 61234,
        remotePort,
        closed: false,
        isAlive: () => alive,
        close: () => {
          alive = false;
          handle.closed = true;
        },
      };
      tunnels.push(handle);
      return handle;
    },
    handshakeFn: async (baseUrl, token) => baseUrl === 'http://127.0.0.1:61234' && token === 'cli-csrf',
  });

  const plainRes = await coordinator.resolveEndpointConnection({
    parsedAuthority: parseIdeRemoteAuthority('ssh-remote+plain-box'),
    requireCapabilities: true,
  });
  assert.equal(plainRes.ok, false);
  assert.equal(plainRes.reason, 'no_remote_plugin');
  assert.equal(plainRes.capabilities.known, true);
  assert.equal(plainRes.capabilities.hasCliPlugin, false);
  assert.equal(tunnels.length, 0);

  const cliRes = await coordinator.resolveEndpointConnection({
    parsedAuthority: parseIdeRemoteAuthority('ssh-remote+cli-box'),
    requireCapabilities: true,
  });
  assert.equal(cliRes.ok, true);
  assert.equal(cliRes.mode, 'tunnel');
  assert.equal(cliRes.baseUrl, 'http://127.0.0.1:61234');
  assert.equal(cliRes.capabilities.hasCliPlugin, true);
  assert.equal(cliRes.capabilities.hasVsCodeExt, false);
  assert.equal(tunnels.length, 1);

  coordinator.pruneInactiveHosts(new Set());
  assert.equal(tunnels[0].closed, true);
  assert.equal(coordinator.getActiveHostCount(), 0);
});

test('VS Code window gating: skips plain SSH/WSL, mounts remote/local CLI-only on Top Bar, mounts VS Code ext in Input Box even when Desktop is sidebar', async () => {
  clearRemoteEndpointRegistry();
  const tmpHome = mkdtempSync(join(tmpdir(), 'um-vscode-support-'));
  mkdirSync(join(tmpHome, '.gemini', 'antigravity-cli'), { recursive: true });
  mkdirSync(join(tmpHome, '.gemini', 'config', 'plugins', 'usage-monitor'), { recursive: true });
  writeFileSync(join(tmpHome, '.gemini', 'config', 'plugins', 'usage-monitor', 'plugin.json'), '{}');

  const probedSshHosts = [];
  const openedTunnels = [];

  const targets = [
    {
      id: 'page-ssh-plain',
      type: 'page',
      title: 'a.py — repo [SSH: plain-box]',
      url: 'vscode-file://vscode-app/Applications/Visual%20Studio%20Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/ssh-plain',
    },
    {
      id: 'page-wsl-plain',
      type: 'page',
      title: 'w.py — repo [WSL: Ubuntu]',
      url: `vscode-file://vscode-app/c:/Users/dev/AppData/Local/Programs/Microsoft%20VS%20Code/resources/app/out/vs/code/electron-browser/workbench/workbench.html?config=${encodeURIComponent(
        JSON.stringify({ remoteAuthority: 'wsl+Ubuntu' })
      )}`,
      webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/wsl-plain',
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
      url: 'vscode-file://vscode-app/c:/Users/dev/AppData/Local/Programs/Microsoft%20VS%20Code/resources/app/out/vs/code/electron-browser/workbench/workbench.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/local-cli',
    },
  ];

  const cdpSrv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/json/version') {
      res.end(
        JSON.stringify({
          Browser: 'Electron',
          webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/test',
        })
      );
      return;
    }
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
      if (this.url.includes('chat-ext') && expr.includes('__APP_CONFIG__')) {
        val = {
          origin: 'http://127.0.0.1:53000',
          csrfToken: 'tok-ext',
          observedCsrfToken: '',
        };
      } else if (expr.includes('ideRemoteAuthority')) {
        val = { ideRemoteAuthority: '', ideFolderUri: '', title: '', hostTheme: null };
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

  let remoteSshEnabled = true;
  const bridge = createWindowBridgeController({
    env: { ANTIGRAVITY_DEVTOOLS_PORT: String(cdpPort) },
    homeDir: tmpHome,
    getSettingsFn: () => ({
      windowMountMode: 'sidebar',
      enableWindowOverlay: false,
      vsCodeMountMode: 'composer',
      enableRemoteSshTelemetry: remoteSshEnabled,
    }),
    handleApiRequest: async () => ({ status: 200, body: '{}' }),
    getBundleVersionFn: () => 'test-vscode-v1',
    readAssetFn: async (p) => (String(p).endsWith('app.js') ? '/* __MOCK_APP_JS__ */' : '/* css */'),
    WebSocketImpl: FakeWS,
    getLocalHubPortsFn: () => ({ allPorts: new Set(), csrfTokens: new Set() }),
    autoConfigureIdeArgv: false,
    pollIntervalMs: 60000,
    ideRemoteSshOptions: {
      allowInTest: true,
      execSshProbeFn: async (args) => {
        const dest = args[args.indexOf('--') + 1];
        probedSshHosts.push(dest);
        if (dest === 'cli-box') {
          return [
            '===UM_DAEMON_JSON===',
            '{"pid":888,"httpPort":54100,"csrfToken":"cli-token"}',
            '===UM_PS===',
            '888 /usr/local/bin/agy --hub',
            '===UM_CAPABILITIES===',
            'hasCli=1',
            'hasCliPlugin=1',
            'hasVsCodeExt=0',
          ].join('\n');
        }
        return [
          '===UM_DAEMON_JSON===',
          '===UM_PS===',
          '===UM_CAPABILITIES===',
          'hasCli=0',
          'hasCliPlugin=0',
          'hasVsCodeExt=0',
        ].join('\n');
      },
      openTunnelFn: async ({ parsedAuthority, remotePort }) => {
        let alive = true;
        const h = {
          host: parsedAuthority.sshDestination,
          localPort: 61235,
          remotePort,
          closed: false,
          isAlive: () => alive,
          close: () => {
            alive = false;
            h.closed = true;
          },
        };
        openedTunnels.push(h);
        return h;
      },
      handshakeFn: async (baseUrl, token) =>
        baseUrl === 'http://127.0.0.1:61235' && token === 'cli-token',
    },
  });

  try {
    await bridge.syncAllWindows();

    // Plain SSH and WSL windows must both be skipped; WSL never triggers SSH probing
    assert.equal(
      evaluated.filter((e) => e.wsUrl.includes('ssh-plain') && e.isInject).length,
      0
    );
    assert.equal(
      evaluated.filter((e) => e.wsUrl.includes('wsl-plain') && e.isInject).length,
      0
    );
    assert.equal(probedSshHosts.includes('Ubuntu'), false);
    // Remote extension with direct chat auth skipped redundant SSH probe
    assert.equal(probedSshHosts.includes('ext-box'), false);

    // Remote CLI-only host mounted on Top Bar via isolated tunnel
    const sshCliInj = evaluated.filter((e) => e.wsUrl.includes('ssh-cli') && e.isInject);
    assert.equal(sshCliInj.length, 1);
    assert.equal(sshCliInj[0].mountDual, true);
    assert.equal(sshCliInj[0].forceTopbar, true);
    assert.equal(sshCliInj[0].isRemote, true);
    assert.equal(sshCliInj[0].cliLabel, true);

    // Remote VS Code ext chat iframe mounted in Input Box; main workbench not polluted
    const sshExtChatInj = evaluated.filter((e) => e.wsUrl.includes('chat-ext') && e.isInject);
    assert.equal(sshExtChatInj.length, 1);
    assert.equal(sshExtChatInj[0].mountComposer, true);
    assert.equal(
      evaluated.filter((e) => e.wsUrl.includes('ssh-ext') && e.isInject).length,
      0
    );

    // Local Windows VS Code with CLI-only plugin mounted on Top Bar
    const localCliInj = evaluated.filter((e) => e.wsUrl.includes('local-cli') && e.isInject);
    assert.equal(localCliInj.length, 1);
    assert.equal(localCliInj[0].mountDual, true);
    assert.equal(localCliInj[0].forceTopbar, true);

    // Disabling enableRemoteSshTelemetry must NOT inject local telemetry into Remote-SSH windows
    evaluated.length = 0;
    remoteSshEnabled = false;
    await bridge.syncAllWindows();
    assert.equal(
      evaluated.filter((e) => e.wsUrl.includes('ssh-cli') && e.isInject).length,
      0
    );
    assert.equal(
      evaluated.filter((e) => e.wsUrl.includes('ssh-plain') && e.isInject).length,
      0
    );
  } finally {
    await bridge.stop();
    cdpSrv.close();
    clearRemoteEndpointRegistry();
    rmSync(tmpHome, { recursive: true, force: true });
  }
  assert.equal(openedTunnels.length, 1);
  assert.equal(openedTunnels[0].closed, true);
});

test('extractHostRouteCascadeId prefers live DOM over stale pathname inside VS Code extension chat iframes', () => {
  const prevWin = globalThis.window;
  const prevDoc = globalThis.document;
  try {
    const stalePathId = '11111111-2222-3333-4444-555555555555';
    const liveDomId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    globalThis.window = {
      location: {
        pathname: `/c/${stalePathId}`,
        search: '?extensionView=true&extensionVariant=vs-code',
      },
      [WINDOW_BRIDGE_KEY]: {
        port: 9999,
        token: 'tok',
        isIdeChatFrame: true,
        isVsCodeHost: true,
        hostRouteCascadeId: stalePathId,
      },
    };
    globalThis.document = {
      activeElement: null,
      querySelector: (sel) =>
        sel.includes('conversation-view')
          ? { getAttribute: () => liveDomId, hasAttribute: () => false, getBoundingClientRect: () => ({ width: 320, height: 400 }) }
          : null,
      querySelectorAll: () => [
        {
          getAttribute: () => liveDomId,
          hasAttribute: () => false,
          getBoundingClientRect: () => ({ width: 320, height: 400 }),
          contains: () => false,
        },
      ],
    };
    assert.equal(extractHostRouteCascadeId(), liveDomId);
  } finally {
    if (prevWin === undefined) delete globalThis.window;
    else globalThis.window = prevWin;
    if (prevDoc === undefined) delete globalThis.document;
    else globalThis.document = prevDoc;
  }
});

test('tier1Only remote CLI endpoints never invoke Tier-2 CDP fallback or trip Tier-2 cooldown', async () => {
  clearRemoteEndpointRegistry();
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
    clearRemoteEndpointRegistry();
  }
});

test('compiled app.js bundle contains VS Code host helpers, labels, and forceTopbarMode support', () => {
  const appJs = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.ok(appJs.includes('mountVsCodeComposer'));
  assert.ok(appJs.includes('mountVsCodeTopbar'));
  assert.ok(appJs.includes('isVsCodeExtensionHost'));
  assert.ok(appJs.includes('resolveClientEffectiveOverlayMountMode'));
  assert.ok(appJs.includes('forceTopbarMode'));
  assert.ok(appJs.includes('selectedMatchesPrevRoute'));
});

test('remote capability probe requires hasCli=1 and checks statusLine.enabled, and pruneInactiveHosts normalizes keys', () => {
  assert.match(IDE_SSH_REMOTE_PROBE_SH, /if \[ "\$um_has_cli" = "1" \]; then/);
  assert.match(IDE_SSH_REMOTE_PROBE_SH, /l\.enabled!==false/);

  // Orphaned plugin.json / settings.json without agy CLI must never report hasCliPlugin: true
  assert.deepEqual(
    parseRemoteProbeCapabilities('===UM_CAPABILITIES===\nhasCli=0\nhasCliPlugin=1\nhasVsCodeExt=0\n'),
    {
      known: true,
      hasCli: false,
      hasCliPlugin: false,
      hasVsCodeExt: false,
    }
  );

  // Mixed-case host keys are normalized consistently across get/prune/dispose
  const coord = createIdeRemoteSshCoordinator({
    allowInTest: true,
    execSshProbeFn: async () =>
      '===UM_DAEMON_JSON===\n===UM_PS===\n===UM_CAPABILITIES===\nhasCli=0\nhasCliPlugin=0\nhasVsCodeExt=0\n',
  });
  return coord
    .resolveEndpointConnection({
      parsedAuthority: {
        isSshRemote: true,
        host: 'MixedBox',
        user: '',
        port: 0,
        sshDestination: 'MixedBox',
        stableHostKey: 'MixedBox',
        displayLabel: 'MixedBox',
      },
      requireCapabilities: true,
    })
    .then(() => {
      assert.equal(coord.getActiveHostCount(), 1);
      coord.pruneInactiveHosts(new Set(['MIXEDBOX']));
      assert.equal(coord.getActiveHostCount(), 1);
      coord.pruneInactiveHosts(new Set());
      assert.equal(coord.getActiveHostCount(), 0);
    });
});

test('disabled Remote-SSH blocks context-windows and host-i18n on VS Code chat frames, dual->composer disposes route watcher, and ssh-cli->ext switch preserves active tunnel', async () => {
  clearRemoteEndpointRegistry();
  const tmpHome = mkdtempSync(join(tmpdir(), 'um-vscode-reg-'));
  mkdirSync(join(tmpHome, '.vscode', 'extensions', 'ms-vscode-remote.remote-ssh-0.115.0'), {
    recursive: true,
  });
  writeFileSync(join(tmpHome, '.vscode', 'argv.json'), '{\n\t"enable-crash-reporter": true\n}\n');

  let currentTargets = [
    {
      id: 'page-ssh-mix',
      type: 'page',
      title: 'x.py — repo [SSH: mix-box]',
      url: 'vscode-file://vscode-app/Applications/Visual%20Studio%20Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9444/devtools/page/ssh-mix',
    },
    {
      id: 'page-devc',
      type: 'page',
      title: 'c.py — app [Dev Container: Node]',
      url: 'vscode-file://vscode-app/c:/Users/dev/AppData/Local/Programs/Microsoft%20VS%20Code/resources/app/out/vs/code/electron-browser/workbench/workbench.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9444/devtools/page/devc',
    },
  ];
  const extSubTargets = [
    {
      id: 'wv-ssh-mix',
      type: 'iframe',
      parentId: 'page-ssh-mix',
      url: 'vscode-webview://1/?extensionId=google.google-antigravity&remoteAuthority=ssh-remote%2Bmix-box&purpose=webviewView',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9444/devtools/page/wv-mix',
    },
    {
      id: 'chat-ssh-mix',
      type: 'iframe',
      parentId: 'wv-ssh-mix',
      url: 'http://127.0.0.1:53111/c/bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee?extensionView=true&extensionVariant=vs-code&remoteKind=ssh-remote',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9444/devtools/page/chat-mix',
    },
  ];

  const cdpSrv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/json/version') {
      res.end(
        JSON.stringify({
          Browser: 'Electron',
          webSocketDebuggerUrl: 'ws://127.0.0.1:9444/devtools/browser/test',
        })
      );
      return;
    }
    res.end(JSON.stringify(currentTargets));
  });
  await new Promise((r) => cdpSrv.listen(0, '127.0.0.1', r));
  const cdpPort = cdpSrv.address().port;

  const evalLog = [];
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
      evalLog.push({ wsUrl: this.url, expr });
      let val = false;
      if (this.url.includes('chat-mix') && expr.includes('__APP_CONFIG__')) {
        val = { origin: 'http://127.0.0.1:53111', csrfToken: 'tok-mix', observedCsrfToken: '' };
      } else if (expr.includes('ideRemoteAuthority')) {
        val = { ideRemoteAuthority: '', ideFolderUri: '', title: '', hostTheme: null };
      } else if (expr.includes('__MOCK_APP_JS__')) {
        val = {
          alive: true,
          dockKind: expr.includes('"mountMode":"composer"') ? 'composer' : 'ide-titlebar',
          visible: true,
        };
      } else if (expr.includes('__agUsageMonitorRouteWatcher') && expr.includes('readRouteId')) {
        val = { routeCascadeId: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', visible: true, focused: true };
      }
      queueMicrotask(() =>
        this._emit('message', {
          data: JSON.stringify({ id: msg.id, result: { result: { value: val } } }),
        })
      );
    }
    close() {}
  }

  let remoteSshEnabled = true;
  let vsCodeMountMode = 'dual';
  let cliRunning = true;
  let probeCount = 0;
  const tunnels = [];
  let hostI18nActive = false;
  let ctxWindows = {};

  const bridge = createWindowBridgeController({
    env: { ANTIGRAVITY_DEVTOOLS_PORT: String(cdpPort) },
    homeDir: tmpHome,
    getSettingsFn: () => ({
      windowMountMode: 'sidebar',
      enableWindowOverlay: false,
      vsCodeMountMode,
      enableRemoteSshTelemetry: remoteSshEnabled,
      autoConfigureLaunch: true,
      developerModeEnabled: Object.keys(ctxWindows).length > 0,
      riskyFeaturesEnabled: Object.keys(ctxWindows).length > 0,
      contextWindowRiskAccepted: Object.keys(ctxWindows).length > 0,
      modelContextWindows: ctxWindows,
      contextWindowMainEnabled: true,
    }),
    getHostI18nDescriptorFn: () =>
      hostI18nActive
        ? { active: true, revision: 'r1', getPayload: () => ({ locale: 'zh-CN', entries: {} }) }
        : { active: false, revision: '', getPayload: null },
    handleApiRequest: async () => ({ status: 200, body: '{}' }),
    getBundleVersionFn: () => 'test-vscode-reg-v1',
    readAssetFn: async (p) => (String(p).endsWith('app.js') ? '/* __MOCK_APP_JS__ */' : '/* css */'),
    WebSocketImpl: FakeWS,
    getLocalHubPortsFn: () => ({ allPorts: new Set(), csrfTokens: new Set() }),
    autoConfigureIdeArgv: true,
    pollIntervalMs: 60000,
    ideRemoteSshOptions: {
      allowInTest: true,
      execSshProbeFn: async () => {
        probeCount += 1;
        return [
          '===UM_DAEMON_JSON===',
          cliRunning ? '{"pid":777,"httpPort":54200,"csrfToken":"mix-cli-tok"}' : '',
          '===UM_PS===',
          cliRunning ? '777 /usr/local/bin/agy --hub' : '',
          '===UM_CAPABILITIES===',
          'hasCli=1',
          'hasCliPlugin=1',
          'hasVsCodeExt=0',
        ].join('\n');
      },
      openTunnelFn: async ({ parsedAuthority, remotePort }) => {
        let alive = true;
        const handle = {
          host: parsedAuthority.sshDestination,
          localPort: 61239,
          remotePort,
          closed: false,
          isAlive: () => alive,
          close: () => {
            alive = false;
            handle.closed = true;
          },
        };
        tunnels.push(handle);
        return handle;
      },
      handshakeFn: async (baseUrl, token) =>
        cliRunning && baseUrl === 'http://127.0.0.1:61239' && token === 'mix-cli-tok',
    },
  });

  try {
    // 1. CLI-only SSH window mounts with tunnel; Dev Container title-only window is skipped; argv.json provisioned
    await bridge.syncAllWindows();
    assert.equal(tunnels.length, 1);
    assert.equal(tunnels[0].closed, false);
    assert.equal(
      evalLog.filter((e) => e.wsUrl.includes('devc') && e.expr.includes('__MOCK_APP_JS__')).length,
      0
    );
    assert.match(readFileSync(join(tmpHome, '.vscode', 'argv.json'), 'utf8'), /"remote-debugging-port": "0"/);

    // 2. Opening VS Code ext chat iframe on the SAME SSH host must NOT close active tunnel when ssh-cli endpoint is pruned
    currentTargets = [currentTargets[0], ...extSubTargets];
    evalLog.length = 0;
    await bridge.syncAllWindows();
    assert.equal(tunnels[0].closed, false, 'switching ssh-cli -> ext on same host must keep SSH tunnel alive');
    // dual mode route probe installed watcher WITHOUT querySelector storm helper
    const routeProbeCall = evalLog.find(
      (e) => e.wsUrl.includes('chat-mix') && e.expr.includes('__agUsageMonitorRouteWatcher')
    );
    assert.ok(routeProbeCall, 'dual mode should probe chat iframe route');
    assert.equal(routeProbeCall.expr.includes('hasRouteRelevantNode'), false);

    // 3. Switching dual -> composer disposes passive route watcher in chat iframe before injecting overlay
    vsCodeMountMode = 'composer';
    evalLog.length = 0;
    await bridge.syncAllWindows();
    const composerInj = evalLog.find(
      (e) => e.wsUrl.includes('chat-mix') && e.expr.includes('__MOCK_APP_JS__')
    );
    assert.ok(composerInj);
    assert.ok(composerInj.expr.includes('window.__agUsageMonitorRouteWatcher?.dispose?.()'));

    // 4. Disabling enableRemoteSshTelemetry blocks overlay, context-windows, AND host-i18n on remote VS Code chat iframe,
    //    and strips managed remote-debugging-port from ~/.vscode/argv.json when Remote-SSH was the only reason
    remoteSshEnabled = false;
    hostI18nActive = true;
    ctxWindows = { 'MODEL_PLACEHOLDER_M26': 1000000 };
    evalLog.length = 0;
    await bridge.notifySettingChanged(false);
    assert.equal(
      evalLog.filter((e) => e.wsUrl.includes('chat-mix') && e.expr.includes('__MOCK_APP_JS__')).length,
      0
    );
    assert.equal(
      evalLog.filter((e) => e.wsUrl.includes('chat-mix') && e.expr.includes('__AGUsageMonitorContextWindows')).length,
      0
    );
    assert.equal(
      evalLog.filter((e) => e.wsUrl.includes('chat-mix') && e.expr.includes('__AGUsageMonitorHostI18n')).length,
      0
    );
    assert.doesNotMatch(
      readFileSync(join(tmpHome, '.vscode', 'argv.json'), 'utf8'),
      /remote-debugging-port/
    );

    // 5. Closing SSH windows prunes inactive hosts from coordinator (reopening triggers fresh SSH probe)
    remoteSshEnabled = true;
    hostI18nActive = false;
    ctxWindows = {};
    cliRunning = false;
    currentTargets = [currentTargets[0]];
    const probesBefore = probeCount;
    await bridge.notifySettingChanged(false);
    assert.ok(probeCount > probesBefore, 're-enabled SSH host should probe');
    currentTargets = [];
    await bridge.syncAllWindows();
    const probesAfterClose = probeCount;
    currentTargets = [
      {
        id: 'page-ssh-mix',
        type: 'page',
        title: 'x.py — repo [SSH: mix-box]',
        url: 'vscode-file://vscode-app/Applications/Visual%20Studio%20Code.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9444/devtools/page/ssh-mix',
      },
    ];
    await bridge.syncAllWindows();
    assert.ok(
      probeCount > probesAfterClose,
      'pruned inactive SSH host must re-probe cleanly when window reopens instead of staying in stale backoff'
    );
  } finally {
    await bridge.stop();
    cdpSrv.close();
    clearRemoteEndpointRegistry();
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('registerRemoteEndpoint clearConnection wipes stale baseUrl and csrfToken when remote CLI stops', () => {
  clearRemoteEndpointRegistry();
  try {
    const ep1 = registerRemoteEndpoint({
      origin: 'http://127.0.0.1:61240',
      baseUrl: 'http://127.0.0.1:61240',
      csrfToken: 'tok-live',
      tier1Verified: true,
      tier1Only: true,
      stableHostKey: 'ssh-cli:clear-conn-box',
      label: 'clear-conn-box (CLI)',
    });
    assert.equal(ep1.baseUrl, 'http://127.0.0.1:61240');
    assert.equal(ep1.csrfToken, 'tok-live');

    const ep2 = registerRemoteEndpoint({
      origin: '',
      baseUrl: '',
      csrfToken: '',
      tier1Verified: false,
      tier1Only: true,
      clearConnection: true,
      stableHostKey: 'ssh-cli:clear-conn-box',
      label: 'clear-conn-box (CLI)',
    });
    assert.equal(ep2.id, ep1.id);
    assert.equal(getRegisteredRemoteEndpoint(ep1.id).baseUrl, '');
    assert.equal(getRegisteredRemoteEndpoint(ep1.id).csrfToken, '');
  } finally {
    clearRemoteEndpointRegistry();
  }
});

test('P2-1 & P3-2: isVsCodeHostUrl ignores antigravity in ?config query, matches Arch /opt/visual-studio-code, and hasLocalAgyCli uses colon on non-Windows', () => {
  assert.equal(
    isVsCodeHostUrl(
      'vscode-file://vscode-app/c:/Users/dev/AppData/Local/Programs/Microsoft%20VS%20Code/resources/app/out/vs/code/electron-browser/workbench/workbench.html?config=' +
        encodeURIComponent(JSON.stringify({ folderUri: 'file:///f:/work/antigravity-usage-monitor' }))
    ),
    true
  );
  assert.equal(
    isVsCodeHostUrl(
      'vscode-file://vscode-app/opt/visual-studio-code/resources/app/out/vs/code/electron-browser/workbench/workbench.html'
    ),
    true
  );
  assert.equal(
    isVsCodeHostUrl(
      'vscode-file://vscode-app/c:/Program%20Files/Antigravity%20IDE/resources/app/out/vs/code/electron-browser/workbench/workbench.html'
    ),
    false
  );

  // Non-Windows PATH uses ':' separator even when running tests on Windows host
  const linuxFs = {
    existsFn: (p) => String(p).replace(/\\/g, '/').endsWith('/custom-linux-bin/agy'),
    readFileFn: () => '{}',
  };
  assert.equal(
    hasLocalAgyCli({ PATH: '/usr/bin:/custom-linux-bin' }, '/home/dev', linuxFs, 'linux'),
    true
  );
});

test('P1-1, P2-4 & P3-3: dual IDE + composer VS Code coexistence avoids route-watcher thrashing, empty composer route clears hostRouteCascadeId, and multi-window directChatAuth skips SSH probe', async () => {
  clearRemoteEndpointRegistry();
  const tmpHome = mkdtempSync(join(tmpdir(), 'um-vscode-coexist-'));
  mkdirSync(join(tmpHome, '.vscode', 'extensions', 'google.google-antigravity-1.0.0'), {
    recursive: true,
  });

  let chatUrl =
    'http://127.0.0.1:53222/c/11111111-2222-3333-4444-555555555555?extensionView=true&extensionVariant=vs-code';
  const buildTargets = () => [
    {
      id: 'ide-wb',
      type: 'page',
      title: 'main.ts — Antigravity IDE',
      url: 'vscode-file://vscode-app/c:/Program%20Files/Antigravity%20IDE/resources/app/out/vs/code/electron-browser/workbench/workbench.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9555/devtools/page/ide-wb',
    },
    {
      id: 'ide-wv',
      type: 'iframe',
      parentId: 'ide-wb',
      url: 'vscode-webview://1/?extensionId=google.google-antigravity&purpose=webviewView',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9555/devtools/page/ide-wv',
    },
    {
      id: 'ide-chat',
      type: 'iframe',
      parentId: 'ide-wv',
      url: 'http://127.0.0.1:53200/c/22222222-2222-3333-4444-555555555555?extensionView=true',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9555/devtools/page/ide-chat',
    },
    {
      id: 'vs-wb',
      type: 'page',
      title: 'index.ts — repo',
      url: 'vscode-file://vscode-app/c:/Users/dev/AppData/Local/Programs/Microsoft%20VS%20Code/resources/app/out/vs/code/electron-browser/workbench/workbench.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9555/devtools/page/vs-wb',
    },
    {
      id: 'vs-wv',
      type: 'iframe',
      parentId: 'vs-wb',
      url: 'vscode-webview://2/?extensionId=google.google-antigravity&purpose=webviewView',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9555/devtools/page/vs-wv',
    },
    {
      id: 'vs-chat',
      type: 'iframe',
      parentId: 'vs-wv',
      url: chatUrl,
      webSocketDebuggerUrl: 'ws://127.0.0.1:9555/devtools/page/vs-chat',
    },
    // Multi-window Remote-SSH: Window A has chat open (directChatAuth), Window B has no chat open
    {
      id: 'vs-ssh-a',
      type: 'page',
      title: 'a.py — repo [SSH: dual-win-box]',
      url: 'vscode-file://vscode-app/c:/Users/dev/AppData/Local/Programs/Microsoft%20VS%20Code/resources/app/out/vs/code/electron-browser/workbench/workbench.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9555/devtools/page/vs-ssh-a',
    },
    {
      id: 'vs-ssh-a-wv',
      type: 'iframe',
      parentId: 'vs-ssh-a',
      url: 'vscode-webview://3/?extensionId=google.google-antigravity&remoteAuthority=ssh-remote%2Bdual-win-box&purpose=webviewView',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9555/devtools/page/vs-ssh-a-wv',
    },
    {
      id: 'vs-ssh-a-chat',
      type: 'iframe',
      parentId: 'vs-ssh-a-wv',
      url: 'http://127.0.0.1:53255/c/33333333-2222-3333-4444-555555555555?extensionView=true&extensionVariant=vs-code&remoteKind=ssh-remote',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9555/devtools/page/vs-ssh-a-chat',
    },
    {
      id: 'vs-ssh-b',
      type: 'page',
      title: 'b.py — repo [SSH: dual-win-box]',
      url: 'vscode-file://vscode-app/c:/Users/dev/AppData/Local/Programs/Microsoft%20VS%20Code/resources/app/out/vs/code/electron-browser/workbench/workbench.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9555/devtools/page/vs-ssh-b',
    },
  ];

  const cdpSrv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/json/version') {
      res.end(
        JSON.stringify({
          Browser: 'Electron',
          webSocketDebuggerUrl: 'ws://127.0.0.1:9555/devtools/browser/test',
        })
      );
      return;
    }
    res.end(JSON.stringify(buildTargets()));
  });
  await new Promise((r) => cdpSrv.listen(0, '127.0.0.1', r));
  const cdpPort = cdpSrv.address().port;

  let sshProbeCalls = 0;
  const evalLog = [];
  const overlayState = new Map();

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
      evalLog.push({ wsUrl: this.url, expr });
      let val = false;
      if (this.url.includes('vs-ssh-a-chat') && expr.includes('__APP_CONFIG__')) {
        val = { origin: 'http://127.0.0.1:53255', csrfToken: 'tok-dual-win', observedCsrfToken: '' };
      } else if (expr.includes('ideRemoteAuthority')) {
        val = { ideRemoteAuthority: '', ideFolderUri: '', title: '', hostTheme: null };
      } else if (expr.includes('__MOCK_APP_JS__')) {
        const isComp = expr.includes('"mountMode":"composer"');
        const routeMatch = expr.match(/"hostRouteCascadeId":"([^"]*)"/);
        const epMatch = expr.match(/"endpointId":"([^"]*)"/);
        const labelMatch = expr.match(/"endpointLabel":"([^"]*)"/);
        const portMatch = expr.match(/"port":(\d+)/);
        overlayState.set(this.url, {
          alive: true,
          dockKind: isComp ? 'composer' : 'ide-titlebar',
          clientMountMode: isComp ? 'composer' : 'dual',
          bundleVersion: 'coexist-v1',
          bridgePort: portMatch ? Number(portMatch[1]) : 0,
          hasToken: true,
          isVsCodeHost: expr.includes('"isVsCodeHost":true'),
          forceTopbarMode: expr.includes('"forceTopbarMode":true'),
          endpointId: epMatch ? epMatch[1] : 'local',
          endpointLabel: labelMatch ? labelMatch[1] : '',
          hostRouteCascadeId: routeMatch ? routeMatch[1] : '',
        });
        val = { alive: true, dockKind: isComp ? 'composer' : 'ide-titlebar', visible: true };
      } else if (expr.includes('clientMountMode') && expr.includes('rpcBatch')) {
        val = overlayState.get(this.url) || {
          alive: false,
          dockKind: '',
          visible: true,
          bundleVersion: '',
          bridgePort: 0,
          hasToken: false,
          transportMode: 'http',
          endpointId: 'local',
          endpointLabel: '',
          hostRouteCascadeId: '',
          routeCascadeId: '',
          rpcBatch: [],
        };
      } else if (expr.includes('bridge["hostRouteCascadeId"] =')) {
        const m = expr.match(/bridge\["hostRouteCascadeId"\] = "([^"]*)"/);
        const st = overlayState.get(this.url);
        if (st && m) st.hostRouteCascadeId = m[1];
        val = true;
      } else if (expr.includes('readRouteId')) {
        val = { routeCascadeId: '22222222-2222-3333-4444-555555555555', visible: true, focused: true };
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
    getSettingsFn: () => ({
      windowMountMode: 'dual',
      enableWindowOverlay: true,
      vsCodeMountMode: 'composer',
      enableRemoteSshTelemetry: true,
    }),
    handleApiRequest: async () => ({ status: 200, body: '{}' }),
    getBundleVersionFn: () => 'coexist-v1',
    readAssetFn: async (p) => (String(p).endsWith('app.js') ? '/* __MOCK_APP_JS__ */' : '/* css */'),
    WebSocketImpl: FakeWS,
    getLocalHubPortsFn: () => ({ allPorts: new Set(), csrfTokens: new Set() }),
    autoConfigureIdeArgv: false,
    pollIntervalMs: 60000,
    ideRemoteSshOptions: {
      allowInTest: true,
      execSshProbeFn: async () => {
        sshProbeCalls += 1;
        return '===UM_DAEMON_JSON===\n===UM_PS===\n===UM_CAPABILITIES===\nhasCli=0\nhasCliPlugin=0\nhasVsCodeExt=1\n';
      },
    },
  });

  try {
    // Sync #1: mounts IDE (dual) + VS Code (composer) + Remote-SSH multi-window (directChatAuth)
    await bridge.syncAllWindows();
    assert.equal(sshProbeCalls, 0, 'directChatAuth fast path must skip SSH probe even with sibling chat-less window');
    assert.equal(
      overlayState.get('ws://127.0.0.1:9555/devtools/page/vs-chat')?.hostRouteCascadeId,
      '11111111-2222-3333-4444-555555555555'
    );

    // Sync #2: IDE chat iframe must NOT be disposed every poll when VS Code stays in composer mode
    evalLog.length = 0;
    await bridge.syncAllWindows();
    const ideChatDisposals = evalLog.filter(
      (e) =>
        e.wsUrl.includes('ide-chat') &&
        e.expr.includes('window.__agUsageMonitorRouteWatcher?.dispose?.()') &&
        !e.expr.includes('__MOCK_APP_JS__')
    );
    assert.equal(ideChatDisposals.length, 0, 'dual IDE route watcher must not be torn down on every poll');

    // Sync #3: Navigating VS Code composer chat iframe to blank "+ New Conversation" clears hostRouteCascadeId
    chatUrl = 'http://127.0.0.1:53222/?extensionView=true&extensionVariant=vs-code';
    await bridge.syncAllWindows();
    assert.equal(
      overlayState.get('ws://127.0.0.1:9555/devtools/page/vs-chat')?.hostRouteCascadeId,
      ''
    );
  } finally {
    await bridge.stop();
    cdpSrv.close();
    clearRemoteEndpointRegistry();
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('P1-2, P1-3 & P2-2: real DevToolsActivePort cleanup on disabling Remote-SSH disposes overlay/ctx/i18n hooks, and active VS Code does not mask unattached Desktop status', async () => {
  clearRemoteEndpointRegistry();
  const tmpHome = mkdtempSync(join(tmpdir(), 'um-vscode-port-clean-'));
  const appData = join(tmpHome, 'AppData', 'Roaming');
  mkdirSync(join(tmpHome, '.vscode', 'extensions', 'ms-vscode-remote.remote-ssh-0.115.0'), {
    recursive: true,
  });
  mkdirSync(join(appData, 'Code'), { recursive: true });

  const targets = [
    {
      id: 'vs-ssh-only',
      type: 'page',
      title: 'app.py — repo [SSH: clean-box]',
      url: 'vscode-file://vscode-app/c:/Users/dev/AppData/Local/Programs/Microsoft%20VS%20Code/resources/app/out/vs/code/electron-browser/workbench/workbench.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9666/devtools/page/vs-ssh-only',
    },
    {
      id: 'vs-ssh-wv',
      type: 'iframe',
      parentId: 'vs-ssh-only',
      url: 'vscode-webview://1/?extensionId=google.google-antigravity&remoteAuthority=ssh-remote%2Bclean-box&purpose=webviewView',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9666/devtools/page/vs-ssh-wv',
    },
    {
      id: 'vs-ssh-chat',
      type: 'iframe',
      parentId: 'vs-ssh-wv',
      url: 'http://127.0.0.1:53300/c/44444444-2222-3333-4444-555555555555?extensionView=true&extensionVariant=vs-code&remoteKind=ssh-remote',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9666/devtools/page/vs-ssh-chat',
    },
  ];

  let cdpPort = 0;
  const cdpSrv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/json/version') {
      res.end(
        JSON.stringify({
          Browser: 'Electron',
          webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/browser/live-vs`,
        })
      );
      return;
    }
    res.end(JSON.stringify(targets));
  });
  await new Promise((r) => cdpSrv.listen(0, '127.0.0.1', r));
  cdpPort = cdpSrv.address().port;
  writeFileSync(join(appData, 'Code', 'DevToolsActivePort'), `${cdpPort}\n/devtools/browser/live-vs\n`);

  const evalLog = [];
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
      evalLog.push({ wsUrl: this.url, expr });
      let val = false;
      if (this.url.includes('vs-ssh-chat') && expr.includes('__APP_CONFIG__')) {
        val = { origin: 'http://127.0.0.1:53300', csrfToken: 'tok-clean', observedCsrfToken: '' };
      } else if (expr.includes('ideRemoteAuthority')) {
        val = { ideRemoteAuthority: '', ideFolderUri: '', title: '', hostTheme: null };
      } else if (expr.includes('__MOCK_APP_JS__')) {
        val = { alive: true, dockKind: 'composer', visible: true };
      } else if (expr.includes('__AGUsageMonitorHostI18n')) {
        val = { applied: true, alive: true, needsApply: false };
      } else if (expr.includes('delete window["__AGUsageMonitorOverlay"]')) {
        val = true;
      }
      queueMicrotask(() =>
        this._emit('message', {
          data: JSON.stringify({ id: msg.id, result: { result: { value: val } } }),
        })
      );
    }
    close() {}
  }

  let remoteSshEnabled = true;
  const bridge = createWindowBridgeController({
    env: { APPDATA: appData, LOCALAPPDATA: appData },
    platform: 'win32',
    homeDir: tmpHome,
    getSettingsFn: () => ({
      windowMountMode: 'dual',
      enableWindowOverlay: true,
      vsCodeMountMode: 'composer',
      enableRemoteSshTelemetry: remoteSshEnabled,
      developerModeEnabled: true,
      riskyFeaturesEnabled: true,
      contextWindowRiskAccepted: true,
      modelContextWindows: { MODEL_PLACEHOLDER_M26: 1000000 },
      contextWindowMainEnabled: true,
    }),
    getHostI18nDescriptorFn: () => ({
      active: true,
      revision: 'r1',
      getPayload: () => ({ locale: 'zh-CN', entries: {} }),
    }),
    handleApiRequest: async () => ({ status: 200, body: '{}' }),
    getBundleVersionFn: () => 'port-clean-v1',
    readAssetFn: async (p) => (String(p).endsWith('app.js') ? '/* __MOCK_APP_JS__ */' : '/* css */'),
    WebSocketImpl: FakeWS,
    getLocalHubPortsFn: () => ({ allPorts: new Set(), csrfTokens: new Set() }),
    autoConfigureIdeArgv: false,
    pollIntervalMs: 60000,
  });

  try {
    // 1. Sync with Remote-SSH ON: injects overlay + context-windows + host-i18n via real DevToolsActivePort;
    //    meanwhile Desktop has no live port, so status must report 'no_devtools_port' (not masked by VS Code!)
    await bridge.syncAllWindows();
    assert.equal(
      evalLog.some((e) => e.wsUrl.includes('vs-ssh-chat') && e.expr.includes('__MOCK_APP_JS__')),
      true
    );
    assert.equal(
      evalLog.some(
        (e) =>
          e.wsUrl.includes('vs-ssh-chat') &&
          e.expr.includes('syncHostContextWindows') &&
          e.expr.includes('MODEL_PLACEHOLDER_M26')
      ),
      true
    );
    assert.equal(
      evalLog.some((e) => e.wsUrl.includes('vs-ssh-chat') && e.expr.includes('__AGUsageMonitorHostI18n')),
      true
    );
    assert.equal(
      bridge.getBridgeStatus().state,
      'no_devtools_port',
      'Active VS Code port must not hide Antigravity Desktop no_devtools_port notice'
    );

    // 2. Turn Remote-SSH OFF while ctx/i18n stay ON locally: remembered VS Code DevToolsActivePort must STILL
    //    be probed for one cleanup pass, disposing overlay + resetting context-windows + disposing host-i18n!
    remoteSshEnabled = false;
    evalLog.length = 0;
    await bridge.notifySettingChanged(true);
    assert.equal(
      evalLog.some(
        (e) =>
          e.wsUrl.includes('vs-ssh-chat') &&
          e.expr.includes('delete window["__AGUsageMonitorOverlay"]')
      ),
      true,
      'must dispose previously injected VS Code overlay via remembered DevToolsActivePort'
    );
    assert.equal(
      evalLog.some(
        (e) =>
          e.wsUrl.includes('vs-ssh-chat') &&
          e.expr.includes('syncHostContextWindows') &&
          !e.expr.includes('MODEL_PLACEHOLDER_M26')
      ),
      true,
      'must reset previously injected context-windows hook on disabled Remote-SSH chat iframe'
    );
    assert.equal(
      evalLog.some(
        (e) =>
          e.wsUrl.includes('vs-ssh-chat') &&
          e.expr.includes('__AGUsageMonitorHostI18n') &&
          e.expr.includes('dispose')
      ),
      true,
      'must dispose previously injected host-i18n translator on disabled Remote-SSH chat iframe'
    );

    // 3. Subsequent sync no longer probes the dropped VS Code port
    evalLog.length = 0;
    await bridge.syncAllWindows();
    assert.equal(evalLog.length, 0);
  } finally {
    await bridge.stop();
    cdpSrv.close();
    clearRemoteEndpointRegistry();
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('P2-3, P3-1 & P3-3: syncAllWindows recovers after rejection, VS Code stable/insiders variants stay isolated, and handshake_failed closes stale tunnel', async () => {
  // 1. P2-3: syncAllWindows pending queue recovers after in-flight rejection
  let shouldThrow = true;
  const tmpFlakyHome = mkdtempSync(join(tmpdir(), 'um-vscode-flaky-'));
  const flakyBridge = createWindowBridgeController({
    env: {},
    homeDir: tmpFlakyHome,
    getSettingsFn: () => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error('simulated transient settings read failure');
      }
      return { windowMountMode: 'sidebar', enableWindowOverlay: false };
    },
    handleApiRequest: async () => ({ status: 200, body: '{}' }),
    getBundleVersionFn: () => 'flaky-v1',
    readAssetFn: async () => '',
    autoConfigureIdeArgv: false,
    pollIntervalMs: 60000,
  });
  try {
    const p1 = flakyBridge.syncAllWindows();
    const p2 = flakyBridge.syncAllWindows();
    await assert.rejects(() => p1, /simulated transient/);
    const res2 = await p2;
    assert.equal(res2.ok, false);
    const res3 = await flakyBridge.syncAllWindows();
    assert.equal(typeof res3, 'object');
  } finally {
    await flakyBridge.stop();
    rmSync(tmpFlakyHome, { recursive: true, force: true });
  }

  // 2. P3-1: stripUnsupported cleans .vscode-insiders/argv.json while preserving .vscode/argv.json
  const tmpVarHome = mkdtempSync(join(tmpdir(), 'um-vscode-variant-'));
  try {
    mkdirSync(join(tmpVarHome, '.vscode', 'extensions', 'google.google-antigravity-1.0.0'), {
      recursive: true,
    });
    mkdirSync(join(tmpVarHome, '.vscode-insiders', 'extensions', 'ms-vscode-remote.remote-ssh-0.115.0'), {
      recursive: true,
    });
    writeFileSync(join(tmpVarHome, '.vscode', 'argv.json'), '{}');
    writeFileSync(join(tmpVarHome, '.vscode-insiders', 'argv.json'), '{}');

    ensureVsCodeRemoteDebuggingArgv({
      env: {},
      homeDir: tmpVarHome,
      enabled: true,
      enableRemoteSsh: true,
    });
    assert.match(readFileSync(join(tmpVarHome, '.vscode', 'argv.json'), 'utf8'), /remote-debugging-port/);
    assert.match(readFileSync(join(tmpVarHome, '.vscode-insiders', 'argv.json'), 'utf8'), /remote-debugging-port/);

    ensureVsCodeRemoteDebuggingArgv({
      env: {},
      homeDir: tmpVarHome,
      enabled: true,
      enableRemoteSsh: false,
      stripUnsupported: true,
    });
    assert.match(readFileSync(join(tmpVarHome, '.vscode', 'argv.json'), 'utf8'), /remote-debugging-port/);
    assert.doesNotMatch(
      readFileSync(join(tmpVarHome, '.vscode-insiders', 'argv.json'), 'utf8'),
      /remote-debugging-port/
    );
  } finally {
    rmSync(tmpVarHome, { recursive: true, force: true });
  }

  // 3. P3-3: handshake_failed closes stale tunnel instead of leaking process
  let now = 1_000_000;
  let allowHandshake = true;
  const tunnels = [];
  const coord = createIdeRemoteSshCoordinator({
    allowInTest: true,
    nowFn: () => now,
    execSshProbeFn: async () =>
      [
        '===UM_DAEMON_JSON===',
        '{"pid":501,"httpPort":54321,"csrfToken":"t1"}',
        '===UM_PS===',
        '501 /usr/local/bin/agy --hub',
        '===UM_CAPABILITIES===',
        'hasCli=1',
        'hasCliPlugin=1',
        'hasVsCodeExt=0',
      ].join('\n'),
    openTunnelFn: async ({ parsedAuthority, remotePort }) => {
      let alive = true;
      const h = {
        host: parsedAuthority.sshDestination,
        localPort: 61400 + tunnels.length,
        remotePort,
        closed: false,
        isAlive: () => alive,
        close: () => {
          alive = false;
          h.closed = true;
        },
      };
      tunnels.push(h);
      return h;
    },
    handshakeFn: async () => allowHandshake,
  });
  const auth = parseIdeRemoteAuthority('ssh-remote+hs-fail-box');
  const ok1 = await coord.resolveEndpointConnection({ parsedAuthority: auth, requireCapabilities: true });
  assert.equal(ok1.ok, true);
  assert.equal(tunnels.length, 1);
  assert.equal(tunnels[0].closed, false);

  // Advance past 20s healthy cache TTL and fail handshake -> stale tunnel must be closed
  now += 25_000;
  allowHandshake = false;
  const fail2 = await coord.resolveEndpointConnection({ parsedAuthority: auth, requireCapabilities: true });
  assert.equal(fail2.ok, false);
  assert.equal(fail2.reason, 'handshake_failed');
  assert.equal(tunnels[0].closed, true, 'stale tunnel must be closed on handshake_failed');
  coord.disposeAll();
});
