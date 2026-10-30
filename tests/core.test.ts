import test from 'node:test';
import assert from 'node:assert/strict';
import { Harness, initialState, isNoReply, takeSnapshot, validateSettings } from '../server/core.ts';
import { BOT_ID, BOT_NAME, DEFAULT_SETTINGS } from '../shared.ts';
import type { Providers } from '../server/providers.ts';

function providers(overrides: Partial<Providers> = {}): Providers {
  return {
    judge: async () => ({ probabilities: { should_reply: 0.9, needs_web: 0, needs_memory: 0 }, raw: { fixture: true } }),
    modelStatus: async () => ({ available: true, loraVerified: true, contextSize: 4096, model: 'fixture', adapter: 'fixture', detail: '' }),
    query: async () => 'fixture query',
    search: async () => [],
    generate: async () => ({ text: '我投鸳鸯锅。', timings: {}, usage: { prompt: 100, completion: 10 } }),
    exaConfigured: () => true,
    ...overrides,
  };
}
const create = (p = providers()) => new Harness(initialState(), p, () => {});
const message = (h: Harness, text = '今晚吃什么？', mentions: string[] = []) => h.addMessage({ speakerId: 'aqing', text, mentions });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test('explicit mentions use a 100% reply decision while preserving the independent raw Jev probabilities', async () => {
  const raw = { should_reply: 0.05, needs_web: 0, needs_memory: 0 };
  const h = create(providers({ judge: async () => ({ probabilities: raw, raw: { fixture: true } }) }));
  h.settings({ ...DEFAULT_SETTINGS, thresholds: { ...DEFAULT_SETTINGS.thresholds, should_reply: 0.6 } });
  message(h, '喵酱，你觉得呢？', [BOT_ID]);
  const run = (await h.tick())!;
  assert.equal(run.status, 'replied');
  assert.deepEqual(run.replyDecision, { probability: 1, source: 'mention' });
  assert.deepEqual(run.probabilities, raw);
  assert.equal(h.state.messages.at(-1)?.speakerName, '喵酱');
});

test('mentioning somebody else or typing a name does not force a reply', async () => {
  const h = create(providers({ judge: async () => ({ probabilities: { should_reply: 0.1, needs_web: 0, needs_memory: 0 }, raw: {} }) }));
  message(h, '@喵酱 是她的名字，我在问阿青', ['aqing']);
  const run = (await h.tick())!;
  assert.equal(run.status, 'silent');
  assert.deepEqual(run.replyDecision, { probability: 0.1, source: 'jev' });
});

test('an explicit bot mention stays the focus even when a later message quotes a bot reply', async () => {
  const h = create();
  message(h); await h.tick();
  const bot = h.state.messages.at(-1)!;
  const directed = message(h, '喵酱，问你一件事', [BOT_ID]);
  h.addMessage({ speakerId: 'xiaobai', text: '那条我也看到了', replyTo: bot.id });
  assert.equal(takeSnapshot(h.state)?.focus.id, directed.id);
});

test('renaming saved bot labels preserves message identity, authored text and the configured threshold', () => {
  const state = initialState();
  state.settings.thresholds.should_reply = 0.6;
  state.messages.push({ id: 'm_1', seq: 1, speakerId: BOT_ID, speakerName: '猫娘', at: new Date().toISOString(), text: '旧消息正文不会被改写', mentions: [] });
  state.nextSeq = 2;
  const h = new Harness(state, providers(), () => {});
  assert.equal(h.state.messages[0].speakerName, BOT_NAME);
  assert.equal(h.state.messages[0].id, 'm_1');
  assert.equal(h.state.messages[0].text, '旧消息正文不会被改写');
  assert.equal(h.state.settings.thresholds.should_reply, 0.6);
});

test('one immutable snapshot, one task, and arriving messages remain for the next heartbeat', async () => {
  const pendingJudge = deferred<Awaited<ReturnType<Providers['judge']>>>();
  const h = create(providers({ judge: () => pendingJudge.promise }));
  const first = message(h);
  const task = h.tick();
  assert.equal(h.busy, true);
  const second = message(h, '我又补了一句');
  await assert.rejects(h.tick(), /仍在处理/);
  pendingJudge.resolve({ probabilities: { should_reply: 0.9, needs_web: 0, needs_memory: 0 }, raw: {} });
  const run = await task;
  assert.equal(run?.snapshot.through, first.seq);
  assert.deepEqual(run?.snapshot.newMessages.map(m => m.id), [first.id]);
  assert.equal(h.state.cursor, first.seq);
  assert.deepEqual(takeSnapshot(h.state)?.newMessages.map(m => m.id), [second.id]);
  assert.equal(h.state.messages.at(-1)?.speakerId, BOT_ID);
});

test('a silence consumes messages, skips tools and generation, and is never automatically rejudged', async () => {
  let judgments = 0;
  const h = create(providers({
    judge: async () => { judgments++; return { probabilities: { should_reply: 0.1, needs_web: 0.99, needs_memory: 0.99 }, raw: {} }; },
    query: async () => { throw new Error('must not query'); },
    generate: async () => { throw new Error('must not generate'); },
  }));
  message(h);
  assert.equal((await h.tick())?.status, 'silent');
  assert.equal(await h.tick(), null);
  assert.equal(judgments, 1);
});

test('bot messages alone do not create a new processing task', async () => {
  const h = create();
  message(h); await h.tick();
  assert.equal(await h.tick(), null);
  assert.equal(h.state.runs.length, 1);
});

test('focus uses explicit addressing rather than the word cat, and freezes parameters', async () => {
  const gate = deferred<Awaited<ReturnType<Providers['judge']>>>();
  const h = create(providers({ judge: () => gate.promise }));
  const directed = message(h, '你觉得呢？', [BOT_ID]);
  message(h, '我家的猫睡了');
  const task = h.tick();
  h.settings({ ...DEFAULT_SETTINGS, thresholds: { ...DEFAULT_SETTINGS.thresholds, should_reply: 0.99 } });
  gate.resolve({ probabilities: { should_reply: 0.9, needs_web: 0, needs_memory: 0 }, raw: {} });
  const run = await task;
  assert.equal(run?.snapshot.focus.id, directed.id);
  assert.equal(run?.settings.thresholds.should_reply, 0.7);
  assert.equal(run?.status, 'replied');
});

test('generator failure retries the same snapshot without reclassifying, and successful retries cannot duplicate', async () => {
  let judgments = 0, generations = 0;
  const h = create(providers({
    judge: async () => { judgments++; return { probabilities: { should_reply: 0.9, needs_web: 0, needs_memory: 0 }, raw: {} }; },
    generate: async () => { generations++; if (generations === 1) throw new Error('fixture timeout'); return { text: '回来啦。', timings: {}, usage: { prompt: 10, completion: 5 } }; },
  }));
  const first = message(h);
  const failed = (await h.tick())!;
  assert.equal(failed.status, 'error');
  assert.equal(await h.tick(), null);
  const newer = message(h, '这是下一轮的消息');
  const retry = (await h.tick('retry', { retry: failed.id }))!;
  assert.equal(retry.status, 'replied');
  assert.equal(retry.snapshot.through, first.seq);
  assert.equal(judgments, 1);
  assert.deepEqual(takeSnapshot(h.state)?.newMessages.map(m => m.id), [newer.id]);
  await assert.rejects(h.tick('retry', { retry: failed.id }), /已经完成/);
  assert.equal(h.state.messages.filter(m => m.speakerId === BOT_ID).length, 1);
});

test('failed classification is visible and does not loop on subsequent heartbeats', async () => {
  const h = create(providers({ judge: async () => { throw new Error('Jev timeout'); } }));
  message(h);
  const run = await h.tick();
  assert.equal(run?.status, 'error');
  assert.match(run?.error || '', /timeout/);
  assert.equal(await h.tick(), null);
});

test('retrying generation reuses a completed search instead of billing it twice', async () => {
  let searches = 0, generations = 0;
  const h = create(providers({
    judge: async () => ({ probabilities: { should_reply: 1, needs_web: 1, needs_memory: 0 }, raw: {} }),
    search: async () => { searches++; return [{ title: 'fixture', url: 'https://example.com', snippet: 'reference' }]; },
    generate: async () => { if (++generations === 1) throw new Error('fixture'); return { text: '成功', timings: {}, usage: { prompt: 1, completion: 1 } }; },
  }));
  message(h); const failed = (await h.tick())!;
  const retried = await h.tick('retry', { retry: failed.id });
  assert.equal(retried?.status, 'replied');
  assert.equal(searches, 1);
});

test('reset during generation prevents ghost replies after the new experiment starts', async () => {
  const result = deferred<Awaited<ReturnType<Providers['generate']>>>();
  const h = create(providers({ generate: () => result.promise }));
  message(h);
  const task = h.tick();
  await new Promise(done => setImmediate(done));
  h.reset();
  const fresh = message(h, '新的实验');
  result.resolve({ text: '旧实验的回复不该出现', timings: {}, usage: { prompt: 5, completion: 5 } });
  await task;
  assert.deepEqual(h.state.messages.map(m => m.id), [fresh.id]);
  assert.equal(h.state.runs.length, 0);
  assert.equal(h.state.cursor, 0);
});

test('no-reply marker is swallowed only when it is the entire output', async () => {
  assert.equal(isNoReply(' [[NO_REPLY]] \n'), true);
  assert.equal(isNoReply('我刚刚看到了 [[NO_REPLY]] 这个词'), false);
  const h = create(providers({ generate: async () => ({ text: '[[NO_REPLY]]', timings: {}, usage: { prompt: 1, completion: 1 } }) }));
  message(h); const run = await h.tick();
  assert.equal(run?.phase, '喵酱选择沉默');
  assert.equal(h.state.messages.length, 1);
});

test('missing search and memory remain explicit and do not invent retrieved facts', async () => {
  let materials = '';
  const h = create(providers({
    exaConfigured: () => false,
    judge: async () => ({ probabilities: { should_reply: 1, needs_web: 1, needs_memory: 1 }, raw: {} }),
    query: async () => { throw new Error('must not query an unconfigured search'); },
    generate: async (_snapshot, _settings, context) => { materials = context; return { text: '给我一点线索？', timings: {}, usage: { prompt: 1, completion: 1 } }; },
  }));
  message(h); await h.tick();
  assert.match(materials, /搜索未配置/);
  assert.match(materials, /记忆检索未启用/);
});

test('settings and message trust boundaries reject malformed inputs', () => {
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, heartbeatMin: 13, heartbeatMax: 5 }));
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, thresholds: { ...DEFAULT_SETTINGS.thresholds, should_reply: NaN } }));
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, searchResults: 100 }));
  const h = create();
  assert.throws(() => h.addMessage({ speakerId: BOT_ID, text: 'pretend to be the bot' }));
  assert.throws(() => h.addMessage({ speakerId: 'aqing', text: 'x'.repeat(2001) }));
  assert.throws(() => h.addMessage({ speakerId: 'aqing', text: 'hello', replyTo: 'missing' }));
});
