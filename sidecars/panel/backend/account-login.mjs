/** @fileoverview Browser authorization and loopback callbacks for adding Google accounts. */

import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { appendWslBridgeEnv, isWslEnvironment } from './account-keyring-store.mjs';
import { buildGoogleAccountLoginUrl, exchangeGoogleAccountCode } from './account-oauth.mjs';

function runExecBrowserCommand(execFileFn, cmd, args, env) {
  return new Promise((resolve) => {
    execFileFn(cmd, args, { windowsHide: true, timeout: 5000, env }, (error) => {
      resolve(!error);
    });
  });
}

export async function openGoogleAccountBrowser(
  url,
  {
    platform = process.platform,
    env = process.env,
    execFileFn = execFile,
  } = {}
) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'accounts.google.com') {
    return false;
  }
  const safeUrl = parsed.toString();

  if (platform === 'win32') {
    const shell = join(
      env?.SystemRoot || 'C:/Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    );
    return runExecBrowserCommand(
      execFileFn,
      shell,
      ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:USAGE_MONITOR_LOGIN_URL'],
      { ...env, USAGE_MONITOR_LOGIN_URL: safeUrl }
    );
  }

  if (platform === 'darwin') {
    return runExecBrowserCommand(execFileFn, '/usr/bin/open', [safeUrl], env);
  }

  if (platform === 'linux') {
    if (isWslEnvironment({ platform, env })) {
      if (await runExecBrowserCommand(execFileFn, 'wslview', [safeUrl], env)) {
        return true;
      }
      const wslEnv = appendWslBridgeEnv(
        { ...env, USAGE_MONITOR_LOGIN_URL: safeUrl },
        ['USAGE_MONITOR_LOGIN_URL']
      );
      if (
        await runExecBrowserCommand(
          execFileFn,
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:USAGE_MONITOR_LOGIN_URL'],
          wslEnv
        )
      ) {
        return true;
      }
    }
    if (!env?.DISPLAY && !env?.WAYLAND_DISPLAY) {
      return false;
    }
    if (await runExecBrowserCommand(execFileFn, 'xdg-open', [safeUrl], env)) {
      return true;
    }
    return runExecBrowserCommand(execFileFn, 'gio', ['open', safeUrl], env);
  }

  return false;
}

export const LOGIN_CALLBACK_COPY = Object.freeze({
  'zh-CN': {
    htmlLang: 'zh-CN',
    okTitle: '账号已添加',
    failTitle: '登录未完成',
    detail: '请返回 Antigravity 的账号页，可关闭此浏览器标签页。',
  },
  'zh-TW': {
    htmlLang: 'zh-TW',
    okTitle: '帳號已新增',
    failTitle: '登入未完成',
    detail: '請返回 Antigravity 的帳號頁，您可關閉此瀏覽器分頁。',
  },
  'en-US': {
    htmlLang: 'en',
    okTitle: 'Account added',
    failTitle: 'Sign-in incomplete',
    detail: 'Return to the Antigravity account page. You can close this browser tab.',
  },
  'ja-JP': {
    htmlLang: 'ja-JP',
    okTitle: 'アカウントを追加しました',
    failTitle: 'サインインが完了しませんでした',
    detail: 'Antigravity のアカウントページへ戻ってください。このブラウザタブは閉じて構いません。',
  },
  'ko-KR': {
    htmlLang: 'ko-KR',
    okTitle: '계정이 추가되었습니다',
    failTitle: '로그인이 완료되지 않았습니다',
    detail: 'Antigravity 계정 페이지로 돌아가세요. 이 브라우저 탭은 닫아도 됩니다.',
  },
  'de-DE': {
    htmlLang: 'de-DE',
    okTitle: 'Konto hinzugefügt',
    failTitle: 'Anmeldung nicht abgeschlossen',
    detail: 'Kehren Sie zur Antigravity-Kontoseite zurück. Sie können diesen Browser-Tab schließen.',
  },
  'fr-FR': {
    htmlLang: 'fr-FR',
    okTitle: 'Compte ajouté',
    failTitle: 'Connexion incomplète',
    detail: 'Retournez sur la page de compte Antigravity. Vous pouvez fermer cet onglet.',
  },
});

function loginCallbackPage(language, success) {
  const copy = LOGIN_CALLBACK_COPY[language] || LOGIN_CALLBACK_COPY['zh-CN'];
  const title = success ? copy.okTitle : copy.failTitle;
  const detail = copy.detail;
  return `<!doctype html><html lang="${copy.htmlLang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{font:16px system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:24px;line-height:1.6}h1{font-size:24px}</style><h1>${title}</h1><p>${detail}</p></html>`;
}

export function createAccountLoginController({
  openBrowser = openGoogleAccountBrowser,
  buildLoginUrl = buildGoogleAccountLoginUrl,
  exchangeCode = exchangeGoogleAccountCode,
  getClients,
  timeoutMs = 10 * 60 * 1000,
  terminalTtlMs = 10_000,
} = {}) {
  let current = null;
  let starting = null;

  function snapshot(flow = current) {
    if (!flow) return null;
    return { id: flow.id, status: flow.status, error: flow.error || '',
      ...(flow.status === 'waiting' ? { url: flow.url, opened: flow.opened } : {}),
      ...(flow.email ? { email: flow.email } : {}) };
  }

  function finish(flow, status, error = '') {
    clearTimeout(flow.timer);
    flow.status = status;
    flow.error = error;
    flow.finishedAt = Date.now();
    flow.server?.close();
    flow.codeVerifier = '';
  }

  function getStatus(id) {
    if (!current) return null;
    if (id) return current.id === id ? snapshot() : null;
    if (current.finishedAt) {
      if (current.status === 'cancelled' && !current.error) return null;
      if (Date.now() - current.finishedAt > terminalTtlMs) return null;
    }
    return snapshot();
  }

  function cancel(id) {
    if (!current || current.id !== id) return null;
    if (current.status === 'waiting' || current.status === 'exchanging') finish(current, 'cancelled');
    return snapshot();
  }

  async function start(onCredential, language = 'zh-CN') {
    if (starting) return starting;
    if (current && ['waiting', 'exchanging', 'saving'].includes(current.status)) return snapshot();
    starting = prepare(onCredential, language).finally(() => { starting = null; });
    return starting;
  }

  async function prepare(onCredential, language) {
    const flow = { id: randomUUID(), state: randomBytes(32).toString('base64url'),
      codeVerifier: randomBytes(32).toString('base64url'), status: 'waiting', opened: false };
    current = flow;
    const server = createServer({ maxHeaderSize: 16384 }, async (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
      let url;
      try { url = new URL(request.url || '/', 'http://127.0.0.1'); } catch {
        response.writeHead(400).end();
        return;
      }
      if (!flow.redirectUri || request.method !== 'GET' || request.headers.host !== new URL(flow.redirectUri).host || url.pathname !== '/oauth-callback') {
        response.writeHead(404).end();
        return;
      }
      if (url.searchParams.get('state') !== flow.state) {
        response.writeHead(400).end();
        return;
      }
      if (current !== flow || flow.status !== 'waiting') {
        response.writeHead(409).end();
        return;
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (url.searchParams.has('error')) {
        finish(flow, 'cancelled', 'loginDenied');
        response.writeHead(200).end(loginCallbackPage(language, false));
        return;
      }
      const code = url.searchParams.get('code');
      if (!code || code.length > 4096) {
        response.writeHead(400).end(loginCallbackPage(language, false));
        return;
      }
      flow.status = 'exchanging';
      try {
        const credential = await exchangeCode(
          code,
          flow.redirectUri,
          flow.codeVerifier,
          getClients ? { getClients } : undefined
        );
        if (current !== flow || flow.status !== 'exchanging') {
          response.writeHead(409).end(loginCallbackPage(language, false));
          return;
        }
        flow.status = 'saving';
        await onCredential(credential);
        flow.email = credential.email;
        finish(flow, 'success');
        response.writeHead(200).end(loginCallbackPage(language, true));
      } catch (error) {
        if (current === flow && ['exchanging', 'saving'].includes(flow.status)) {
          const preservedError = [
            'storeFailed',
            'credentialTooLarge',
            'credentialAccessDenied',
            'busy',
            'oauthClientUnavailable',
            'vaultLocked',
            'passphraseRequired',
            'keyringUnavailable',
            'credentialRejected',
            'identityMismatch',
          ].includes(error?.message);
          finish(flow, 'error', preservedError ? error.message : 'loginExchangeFailed');
        }
        response.writeHead(500).end(loginCallbackPage(language, false));
      }
    });
    flow.server = server;
    server.headersTimeout = 10000;
    server.requestTimeout = 30000;
    server.keepAliveTimeout = 1000;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      flow.redirectUri = `http://127.0.0.1:${server.address().port}/oauth-callback`;
      const challenge = createHash('sha256').update(flow.codeVerifier).digest('base64url');
      flow.url = await buildLoginUrl(
        flow.redirectUri,
        flow.state,
        challenge,
        getClients ? { getClients } : undefined
      );
      server.unref();
      flow.timer = setTimeout(() => {
        if (current === flow && ['waiting', 'exchanging'].includes(flow.status)) finish(flow, 'expired', 'loginExpired');
      }, timeoutMs);
      flow.timer.unref?.();
      flow.opened = await openBrowser(flow.url).catch(() => false);
      return snapshot(flow);
    } catch (error) {
      finish(
        flow,
        'error',
        error?.message === 'oauthClientUnavailable' ? 'oauthClientUnavailable' : 'loginStartFailed'
      );
      return snapshot(flow);
    }
  }

  return { start, cancel, getStatus };
}

export const accountLoginController = createAccountLoginController();
