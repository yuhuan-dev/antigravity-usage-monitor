import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_REPO_ROOT,
  collectReleaseRuntimeFiles,
  packReleaseZip,
} from '../scripts/pack-release-zip.mjs';

test('pack-release-zip ships only runtime-essential files, excludes dev bloat, and extracts a self-contained runnable plugin', async (t) => {
  const relFiles = collectReleaseRuntimeFiles(DEFAULT_REPO_ROOT);

  // Required runtime files exist in whitelist
  for (const mustHave of [
    'plugin.json',
    'mcp_config.json',
    'pricing-catalog.json',
    'LICENSE',
    'assets/logo.svg',
    'sidecars/panel/sidecar.json',
    'sidecars/panel/index.html',
    'sidecars/panel/app.js',
    'sidecars/panel/styles.css',
    'sidecars/panel/main.mjs',
    'sidecars/panel/mcp-entry.mjs',
    'sidecars/panel/bridge-daemon.mjs',
    'sidecars/panel/standalone.mjs',
    'sidecars/panel/cli-statusline.mjs',
    'sidecars/panel/trajectory-metrics.mjs',
    'sidecars/panel/backend/api-actions.mjs',
    'sidecars/panel/backend/devtools-port-probe.mjs',
    'sidecars/panel/backend/ide-remote-ssh.mjs',
    'sidecars/panel/backend/vscode-host-support.mjs',
    'sidecars/panel/backend/session-store.mjs',
    'sidecars/panel/backend/session-cleaner.mjs',
    'sidecars/panel/backend/session-manager.mjs',
    'sidecars/panel/backend/session-online-delete.mjs',
    'sidecars/panel/backend/host-i18n/index.mjs',
    'sidecars/panel/backend/account-credentials.ps1',
    'sidecars/panel/backend/account-keyring-store.mjs',
    'sidecars/panel/backend/account-switch-posix-worker.mjs',
    'sidecars/panel/shared/settings-normalization.mjs',
    'sidecars/panel/shared/host-i18n-protocol.mjs',
    'sidecars/panel/shared/workspace-uri.mjs',
  ]) {
    assert.ok(relFiles.includes(mustHave), `Release whitelist must include ${mustHave}`);
  }

  // Non-runtime dev/doc/test/preview files and standalone repository language packs must NEVER enter the release ZIP
  for (const rel of relFiles) {
    assert.doesNotMatch(rel, /^host-i18n\//);
    assert.doesNotMatch(rel, /^sidecars\/panel\/(?:src|test|scripts)\//);
    assert.doesNotMatch(rel, /\.png$/i);
    assert.doesNotMatch(rel, /^README/i);
    assert.doesNotMatch(rel, /^\.gitignore$/);
    assert.doesNotMatch(rel, /(?:^|\/)(?:\.git|\.data|node_modules|plan|dist)(?:\/|$)/);
  }
  assert.equal(relFiles.includes('sidecars/panel/package.json'), false);

  const workDir = mkdtempSync(join(tmpdir(), 'ag-um-pack-test-'));
  t.after(() => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup error
    }
  });

  const zipPath = join(workDir, 'usage-monitor.zip');
  const extractDir = join(workDir, 'extracted');
  const summary = packReleaseZip({ repoRoot: DEFAULT_REPO_ROOT, outFile: zipPath });

  assert.ok(existsSync(zipPath));
  assert.ok(summary.zipBytes > 100 * 1024, 'ZIP should contain compiled assets and backend');
  assert.ok(
    summary.zipBytes < 1250 * 1024,
    `Runtime-only ZIP should stay compact (<1250 KB), got ${(summary.zipBytes / 1024).toFixed(1)} KB`
  );

  // Extract via OS-native expander (same path used by plugin-updater.mjs, where extractDir already exists)
  mkdirSync(extractDir, { recursive: true });
  if (process.platform === 'win32') {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath.replace(/'/g, "''")}', '${extractDir.replace(/'/g, "''")}')`,
      ],
      { stdio: 'pipe', windowsHide: true }
    );
  } else {
    execFileSync('unzip', ['-oq', zipPath, '-d', extractDir], { stdio: 'pipe' });
  }

  const pluginRoot = join(extractDir, 'usage-monitor');
  assert.ok(existsSync(join(pluginRoot, 'plugin.json')));
  const manifest = JSON.parse(readFileSync(join(pluginRoot, 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'usage-monitor');
  assert.ok(existsSync(join(pluginRoot, manifest.logo)));
  const sidecarManifest = JSON.parse(readFileSync(join(pluginRoot, 'sidecars/panel/sidecar.json'), 'utf8'));
  assert.equal(sidecarManifest.display_name, 'Usage Monitor');
  assert.equal(sidecarManifest.ui_config?.display_name, 'Usage Monitor');
  assert.equal(sidecarManifest.ui_config?.views?.[0]?.title, 'Usage Monitor');

  // Verify zero broken syntax and clean standalone ESM load from the extracted clean tree (no src/, test/, package.json)
  for (const rel of relFiles) {
    if (rel.endsWith('.mjs') || rel === 'sidecars/panel/app.js') {
      execFileSync(process.execPath, ['--check', join(pluginRoot, rel)], { stdio: 'pipe' });
    }
  }

  const apiMod = await import(pathToFileURL(join(pluginRoot, 'sidecars/panel/backend/api-actions.mjs')).href);
  assert.equal(typeof apiMod.executeTelemetryAction, 'function');
  const cliMod = await import(pathToFileURL(join(pluginRoot, 'sidecars/panel/cli-statusline.mjs')).href);
  assert.equal(typeof cliMod.runCliStatusLineMain, 'function');
});
