import test from 'node:test';
import assert from 'node:assert/strict';
import { backendHarness } from './backend-harness.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const store = '/test-home/.gemini/antigravity/conversations';
const profiles = '/test-home/.cc-switch/agy';

function fixture({ cache, diskDirs = { [store]: [] } } = {}) {
  let now = Date.parse('2026-11-20T12:00:00Z');
  const userStatus = { email: 'owner@example.test' };
  const entry = {
    title: 'Private session title', appSource: 'standalone', accountName: userStatus.email,
    diskMtimeMs: now - 10_000, localStoreDirs: [store],
    steps: [{
      createdAtMs: now - 10_000, modelKey: 'gemini-4-carbon-high', inputTokens: 70_000, cacheReadTokens: 20_000,
      outputTokens: 10_000, userPrompt: 'Private prompt', responseText: 'Private response',
    }],
  };
  const h = backendHarness({ cache: cache || { [id]: entry }, userStatus, diskDirs, clock: () => now });
  return { ...h, report: () => h.buildTelemetryPayloadInternal(id, true, {range: 'all'}),
    advance: () => { now += 60_001; }, diskDirs };
}

test('confirmed local deletion drops session details and keeps usage through restart and external cleaning', async () => {
  const h = fixture();
  h.flushTrajectoryCacheNow();
  const before = h.state.saves.at(-1).data;
  const during = await h.report();
  assert.equal(during.conversations.length, 0);
  assert.equal(during.consumption.account.totalTokens, 100_000);
  assert.ok(during.consumption.account.costUsd > 0);
  assert.ok(h.getCachedTrajectory(id));
  h.advance();
  const after = await h.report();
  assert.equal(after.conversations.length, 0);
  assert.equal(after.consumption.account.calls, 1);
  assert.equal(h.getCachedTrajectory(id), undefined);
  const saved = h.state.saves.at(-1).data;
  assert.doesNotMatch(JSON.stringify(saved), new RegExp(id + '|Private'));

  delete before[id];
  for (const cache of [before, saved]) {
    const restored = fixture({ cache });
    const p = await restored.report();
    assert.equal(p.conversations.length, 0);
    assert.equal(p.consumption.account.totalTokens, 100_000);
    assert.equal(p.consumption.account.calls, 1);
    assert.equal(p.consumption.account.costUsd, during.consumption.account.costUsd);
  }
});

test('account switches, unreadable stores and a surviving profile interrupt deletion confirmation', async () => {
  const h = fixture();
  await h.report();
  h.advance();
  h.state.userStatus.email = 'other@example.test';
  assert.equal((await h.report()).conversations[0].title, 'Private session title');
  h.state.userStatus.email = 'owner@example.test';
  h.diskDirs[store] = Object.assign(new Error('busy'), { code: 'EACCES' });
  await h.report();
  assert.ok(h.getCachedTrajectory(id));
  h.diskDirs[store] = [];
  h.diskDirs[profiles] = ['work'];
  h.diskDirs[profiles + '/work/antigravity-cli/conversations'] = [id + '.db'];
  await h.report();
  h.advance();
  assert.equal((await h.report()).conversations[0].cascadeId, id);
  assert.ok(h.getCachedTrajectory(id));
  delete h.diskDirs[profiles];
  await h.report();
  assert.ok(h.getCachedTrajectory(id));
});

test('legacy cache without disk provenance is hidden only with a readable matching store and summaries', async () => {
  const h = fixture();
  const entry = h.getCachedTrajectory(id);
  delete entry.localStoreDirs;
  delete entry.diskMtimeMs;
  assert.equal((await h.report()).conversations.length, 0);
  h.advance();
  await h.report();
  assert.ok(h.getCachedTrajectory(id));
  delete h.diskDirs[store];
  assert.equal((await h.report()).conversations[0].cascadeId, id);
});

test('restored and external copies contribute usage only once', async () => {
  const h = fixture();
  h.flushTrajectoryCacheNow();
  const saved = h.state.saves.at(-1).data;
  const live = structuredClone(saved[id]);
  delete saved[id];
  const old = fixture({ cache: saved });
  old.state.deepStats = { perConvo: { ['ide:' + id.toUpperCase()]: {
    entries: [{ ts: live.steps[0].createdAt, inp: 70_000, cache: 20_000, out: 10_000 }],
  } } };
  let report = await old.report();
  assert.equal(report.consumption.account.totalTokens, 100_000);
  assert.equal(report.consumption.account.calls, 1);
  assert.equal(report.conversations.length, 0);
  const restored = fixture({ cache: { ...saved, [id]: live }, diskDirs: { [store]: [id + '.pb'] } });
  report = await restored.report();
  assert.equal(report.conversations[0].cascadeId, id);
  assert.equal(report.consumption.account.calls, 1);
  assert.equal(report.consumption.account.totalTokens, 100_000);
});

test('a stale parent reference cannot recreate a deleted child or retain its identifier after confirmation', async () => {
  const h = fixture();
  h.flushTrajectoryCacheNow();
  const cache = h.state.saves.at(-1).data;
  cache['live-parent'] = { title: 'parent', steps: [], subagentRefs: [{ cascadeId: id, role: 'worker' }] };
  const current = fixture({ cache });
  await current.report();
  current.advance();
  const result = await current.report();
  assert.doesNotMatch(JSON.stringify(result.conversations), new RegExp(id));
  assert.doesNotMatch(JSON.stringify(current.state.saves.at(-1).data), new RegExp(id + '|Private'));
});

test('a live file or host summary stays selectable after the grace period', async () => {
  const h = fixture();
  h.diskDirs[store] = [id + '.pb'];
  for (let i = 0; i < 2; i++) {
    assert.equal((await h.report()).conversations[0].cascadeId, id);
    h.advance();
  }
  h.diskDirs[store] = [];
  h.state.summaries[id] = { summary: 'Still active' };
  for (let i = 0; i < 2; i++) {
    assert.equal((await h.report()).conversations[0].cascadeId, id);
    h.advance();
  }
  assert.ok(h.getCachedTrajectory(id));
});
