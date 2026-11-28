import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import {
  IDE_SSH_REMOTE_PROBE_SH,
  parseRemoteProbeStdout,
} from '../backend/ide-remote-ssh.mjs';
import {
  createMacOsLaunchWrapper,
  inspectMacOsLaunchWrapperStatus,
  removeMacOsLaunchWrapper,
  resolveWindowsPowerShellExecutable,
  triggerDesktopHostRelaunch,
} from '../backend/desktop-launcher-config.mjs';

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test(
  'POSIX native smoke: sh -s stdin probe (and zsh login-shell wrapping) preserves ===UM_DAEMON_JSON=== and parses daemon JSON',
  { skip: process.platform === 'win32' },
  () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-posix-ssh-smoke-'));
    try {
      const daemonDir = path.join(tmpHome, '.gemini', 'antigravity', 'daemon');
      fs.mkdirSync(daemonDir, { recursive: true });
      fs.writeFileSync(
        path.join(daemonDir, 'hub_native.json'),
        JSON.stringify(
          {
            pid: process.pid,
            httpPort: 43210,
            httpsPort: 43211,
            csrfToken: 'native-posix-daemon-tok',
          },
          null,
          2
        ) + '\n',
        'utf8'
      );

      const shStdout = execFileSync('/bin/sh', ['-s'], {
        encoding: 'utf8',
        input: `${IDE_SSH_REMOTE_PROBE_SH}\n`,
        env: { ...process.env, HOME: tmpHome },
      });
      assert.equal(shStdout.includes('===UM_DAEMON_JSON==='), true);
      const parsed = parseRemoteProbeStdout(shStdout);
      assert.ok(
        parsed.some(
          (c) =>
            c.source === 'daemon' &&
            c.csrfToken === 'native-posix-daemon-tok' &&
            c.ports.includes(43210)
        ),
        `Expected real daemon candidate from sh -s, got: ${JSON.stringify(parsed)}`
      );

      // Verify zsh login shell (default on macOS) cleanly executes `sh -s` without glob errors
      if (fs.existsSync('/bin/zsh')) {
        const zshStdout = execFileSync('/bin/zsh', ['-c', 'sh -s'], {
          encoding: 'utf8',
          input: `${IDE_SSH_REMOTE_PROBE_SH}\n`,
          env: { ...process.env, HOME: tmpHome },
        });
        const parsedZsh = parseRemoteProbeStdout(zshStdout);
        assert.ok(
          parsedZsh.some((c) => c.csrfToken === 'native-posix-daemon-tok'),
          'zsh login shell invoking sh -s must extract daemon JSON cleanly'
        );
      }
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }
);

test(
  'macOS native smoke: BSD ps + awk ENVIRON finds bundle PID without self-match and managed .app wrapper round-trips cleanly',
  { skip: process.platform !== 'darwin' },
  async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-darwin-smoke-'));
    let mainChild = null;
    let helperChild = null;
    try {
      const appsDir = path.join(tmpHome, 'Applications');
      const fakeApp = path.join(appsDir, 'Antigravity.app');
      const macOsDir = path.join(fakeApp, 'Contents', 'MacOS');
      const resDir = path.join(fakeApp, 'Contents', 'Resources');
      fs.mkdirSync(macOsDir, { recursive: true });
      fs.mkdirSync(resDir, { recursive: true });

      const mainBin = path.join(macOsDir, 'Antigravity');
      const helperBin = path.join(macOsDir, 'Antigravity Helper');
      fs.symlinkSync(process.execPath, mainBin);
      fs.symlinkSync(process.execPath, helperBin);

      let capturedMac = null;
      const relaunchPlan = await triggerDesktopHostRelaunch({
        platform: 'darwin',
        homeDir: tmpHome,
        preferredProduct: 'desktop',
        allowInTest: true,
        spawnFn: async (_file, args, opts) => {
          capturedMac = { script: args[1], env: opts.env };
          return { pid: 1 };
        },
      });
      assert.equal(relaunchPlan.ok, true);
      assert.ok(capturedMac?.script && capturedMac?.env?.AGY_BUNDLE_MACOS);

      // Extract exact find_main_pids / find_bundle_pids / is_alive definitions from production script
      const fnPrefix = capturedMac.script.split('; if osascript ')[0].replace(/^sleep [^;]+;\s*/, '');

      // Before spawning: is_alive must be false (proves zero self-match on real BSD ps!)
      const beforeOut = execFileSync('/bin/sh', ['-c', `${fnPrefix}; if is_alive; then echo ALIVE; else echo DEAD; fi`], {
        encoding: 'utf8',
        env: { ...process.env, ...capturedMac.env },
      }).trim();
      assert.equal(beforeOut, 'DEAD', 'is_alive must NOT self-match on real macOS BSD ps');

      // Spawn fake main + helper processes under Contents/MacOS/ (argv[0] preserves bundle path on macOS BSD ps)
      mainChild = spawn(mainBin, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
      helperChild = spawn(helperBin, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
      await waitMs(180);

      const liveMainPids = execFileSync('/bin/sh', ['-c', `${fnPrefix}; find_main_pids`], {
        encoding: 'utf8',
        env: { ...process.env, ...capturedMac.env },
      })
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      assert.equal(
        liveMainPids.includes(String(mainChild.pid)),
        true,
        `find_main_pids must detect live main PID ${mainChild.pid}, got: ${JSON.stringify(liveMainPids)}`
      );
      assert.equal(
        liveMainPids.includes(String(helperChild.pid)),
        false,
        'find_main_pids must exclude Helper process'
      );

      mainChild.kill('SIGTERM');
      await waitMs(120);

      const afterOut = execFileSync('/bin/sh', ['-c', `${fnPrefix}; if is_alive; then echo ALIVE; else echo DEAD; fi`], {
        encoding: 'utf8',
        env: { ...process.env, ...capturedMac.env },
      }).trim();
      assert.equal(afterOut, 'DEAD', 'is_alive must immediately turn false after main process exits');

      // Also verify real macOS wrapper creation + lsregister + removal in isolated temp homeDir
      const created = await createMacOsLaunchWrapper({
        product: 'desktop',
        platform: 'darwin',
        homeDir: tmpHome,
        allowInTest: true,
      });
      assert.equal(created.ok, true);
      assert.equal(inspectMacOsLaunchWrapperStatus({ platform: 'darwin', homeDir: tmpHome }).desktopExists, true);
      const removed = removeMacOsLaunchWrapper({
        product: 'desktop',
        platform: 'darwin',
        homeDir: tmpHome,
        allowInTest: true,
      });
      assert.equal(removed.ok, true);
      assert.equal(inspectMacOsLaunchWrapperStatus({ platform: 'darwin', homeDir: tmpHome }).exists, false);
    } finally {
      try {
        mainChild?.kill('SIGKILL');
      } catch {}
      try {
        helperChild?.kill('SIGKILL');
      } catch {}
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  }
);

test(
  'Linux native smoke: collect_pids() resolves symlinked launcher binary against real /proc/<pid>/exe',
  { skip: process.platform !== 'linux' },
  async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-linux-smoke-'));
    let child = null;
    try {
      // Avoid /bin/sleep which on Ubuntu 25.10+/26.04 is a uutils multi-call coreutils binary
      // that dispatches on argv[0] and exits immediately when invoked via a symlink named "antigravity".
      const candidateSpecs = [
        { bin: '/usr/bin/python3', args: ['-c', 'import time; time.sleep(30)'] },
        { bin: '/usr/bin/perl', args: ['-e', 'sleep 30'] },
        { bin: '/usr/bin/bash', args: ['-c', 'while :; do read -t 30 <> <(:) 2>/dev/null || sleep 1; done'] },
        { bin: '/bin/bash', args: ['-c', 'while :; do read -t 30 <> <(:) 2>/dev/null || sleep 1; done'] },
        { bin: '/bin/sleep', args: ['30'] },
        { bin: '/usr/bin/sleep', args: ['30'] },
      ];
      const chosen = candidateSpecs.find((c) => fs.existsSync(c.bin));
      assert.ok(chosen, 'Expected a standalone Linux binary for symlink process smoke test');
      const symlinkBin = path.join(tmpDir, 'antigravity');
      fs.symlinkSync(chosen.bin, symlinkBin);

      let capturedLinux = null;
      const relaunchPlan = await triggerDesktopHostRelaunch({
        platform: 'linux',
        homeDir: tmpDir,
        preferredProduct: 'desktop',
        allowInTest: true,
        existsFn: (p) => p === symlinkBin,
        env: { ...process.env, APPIMAGE: '' },
        execFileFn: async () => `${symlinkBin}\n`,
        spawnFn: async (_file, args, opts) => {
          capturedLinux = { script: args[1], env: opts.env };
          return { pid: 1 };
        },
      });
      assert.equal(relaunchPlan.ok, true);
      assert.equal(capturedLinux?.env?.AGY_RELAUNCH_EXE, symlinkBin);

      child = spawn(symlinkBin, chosen.args, { stdio: 'ignore' });
      await waitMs(150);
      assert.equal(
        child.exitCode,
        null,
        `Spawned symlinked test process (${chosen.bin}) exited prematurely with code ${child.exitCode}`
      );

      const fnPrefix = capturedLinux.script.split('; pids=')[0].replace(/^sleep [^;]+;\s*/, '');
      const foundPids = execFileSync('/bin/sh', ['-c', `${fnPrefix}; collect_pids`], {
        encoding: 'utf8',
        env: { ...process.env, ...capturedLinux.env },
      })
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      assert.equal(
        foundPids.includes(String(child.pid)),
        true,
        `collect_pids() must match symlinked process PID ${child.pid} (${chosen.bin}) via readlink -f, got: ${JSON.stringify(foundPids)}`
      );
      assert.equal(
        foundPids.includes(String(process.pid)),
        false,
        'collect_pids() must not match unrelated node test runner'
      );
    } finally {
      try {
        child?.kill('SIGKILL');
      } catch {}
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
);

test(
  'Windows native smoke: out-of-job relaunch dispatcher verifies .ack sentinel and falls back cleanly when WMI Create silently fails',
  { skip: process.platform !== 'win32' },
  async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-win32-smoke-'));
    try {
      const psExe = resolveWindowsPowerShellExecutable(process.env);
      const fakeExe = path.join(tmpDir, 'Antigravity.exe');
      fs.writeFileSync(fakeExe, 'MZ', 'utf8');

      let capturedArgs = null;
      let capturedEnv = null;
      const planRes = await triggerDesktopHostRelaunch({
        platform: 'win32',
        homeDir: tmpDir,
        preferredProduct: 'desktop',
        stalePortFiles: [path.join(tmpDir, 'Antigravity', 'DevToolsActivePort')],
        env: { ...process.env, USAGE_MONITOR_HOST_EXE: fakeExe, TEMP: tmpDir },
        allowInTest: true,
        execFileFn: async (_file, args, opts) => {
          capturedArgs = args;
          capturedEnv = opts?.env;
          return '{"ok":true,"method":"shell_application"}';
        },
      });
      assert.equal(planRes.ok, true);
      const dispatchPs = capturedArgs[capturedArgs.length - 1];
      const generatedPs1 = capturedEnv.AGY_RELAUNCH_PS1;
      assert.equal(fs.existsSync(generatedPs1), true);

      // 1. Validate Windows PowerShell 5.1 AST syntax on production-generated inner .ps1
      const astOut = execFileSync(
        psExe,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `$t = $null; $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${generatedPs1.replace(/'/g, "''")}', [ref]$t, [ref]$e); Write-Output ("AST_ERR=" + $e.Count)`,
        ],
        { encoding: 'utf8', input: '', windowsHide: true, timeout: 10000 }
      ).trim();
      assert.equal(astOut, 'AST_ERR=0', `Generated Windows relaunch .ps1 must have 0 parse errors, got: ${astOut}`);

      const writeHarmlessProbe = (ps1File, outFile) => {
        const lines = [
          "param([string]$HostElevated = '0')",
          'if ($PSCommandPath) {',
          "  try { [System.IO.File]::WriteAllText(($PSCommandPath + '.ack'), [string]$PID) } catch {}",
          '}',
          'Start-Sleep -Milliseconds 120',
          `[System.IO.File]::WriteAllText('${outFile.replace(/'/g, "''")}', "OK:" + $HostElevated, [System.Text.Encoding]::UTF8)`,
          'if ($PSCommandPath) {',
          "  $ackPath = $PSCommandPath + '.ack'",
          '  if (Test-Path -LiteralPath $ackPath) { Remove-Item -LiteralPath $ackPath -Force -ErrorAction SilentlyContinue }',
          '  if (Test-Path -LiteralPath $PSCommandPath) { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue }',
          '}',
        ].join('\r\n');
        fs.writeFileSync(ps1File, `\uFEFF${lines}\r\n`, 'utf8');
      };

      const waitForFile = async (filePath, maxMs = 3000) => {
        const deadline = Date.now() + maxMs;
        while (Date.now() < deadline) {
          if (fs.existsSync(filePath)) return true;
          await waitMs(50);
        }
        return fs.existsSync(filePath);
      };

      // 2. Native execution of unaltered WIN_OUT_OF_JOB_DISPATCH_PS
      const probe1 = path.join(tmpDir, 'probe-default.ps1');
      const out1 = path.join(tmpDir, 'probe-default.txt');
      writeHarmlessProbe(probe1, out1);
      const rawOut1 = execFileSync(
        psExe,
        ['-Sta', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', dispatchPs],
        {
          encoding: 'utf8',
          input: '',
          windowsHide: true,
          timeout: 12000,
          env: { ...process.env, AGY_PS_EXE: psExe, AGY_RELAUNCH_PS1: probe1 },
        }
      ).trim();
      const parsed1 = JSON.parse(rawOut1.split(/\r?\n/).pop());
      assert.equal(parsed1.ok, true);
      assert.equal(await waitForFile(out1), true, 'Default Windows dispatch must execute probe .ps1');
      assert.match(fs.readFileSync(out1, 'utf8').replace(/^\uFEFF/, ''), /^OK:[01]$/);
      await waitMs(150);
      assert.equal(fs.existsSync(probe1), false, 'Probe .ps1 must self-delete');
      assert.equal(fs.existsSync(`${probe1}.ack`), false, 'Probe .ack sentinel must self-delete');

      // 3. Simulate HIPS/AV blocking WmiPrvSE.exe -> powershell.exe while WMI Create still returns ReturnValue=0
      const simulatedBlockedWmiPs = dispatchPs
        .replace('if ($isElev -and -not $shellPreservesElev)', 'if ($true)')
        .replaceAll(
          "([wmiclass]'Win32_Process').Create($fullCmd)",
          '[pscustomobject]@{ ReturnValue = 0; ProcessId = 999999 }'
        );
      const probe2 = path.join(tmpDir, 'probe-hips-fallback.ps1');
      const out2 = path.join(tmpDir, 'probe-hips-fallback.txt');
      writeHarmlessProbe(probe2, out2);
      const rawOut2 = execFileSync(
        psExe,
        [
          '-Sta',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          simulatedBlockedWmiPs,
        ],
        {
          encoding: 'utf8',
          input: '',
          windowsHide: true,
          timeout: 12000,
          env: { ...process.env, AGY_PS_EXE: psExe, AGY_RELAUNCH_PS1: probe2 },
        }
      ).trim();
      const parsed2 = JSON.parse(rawOut2.split(/\r?\n/).pop());
      assert.equal(parsed2.ok, true);
      assert.notEqual(
        parsed2.method,
        'wmi_elevated',
        'Must not false-positive report wmi_elevated when WMI child fails to write .ack'
      );
      assert.equal(await waitForFile(out2), true, 'Fallback after silent WMI block must execute probe .ps1');
      await waitMs(150);
      assert.equal(fs.existsSync(probe2), false);
      assert.equal(fs.existsSync(`${probe2}.ack`), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
);
