import test from 'node:test';
import assert from 'node:assert/strict';
import { conversation, expireRuns, fitTail, repeatsReply } from '../server/context.ts';
import { Harness, initialState, retryableRun, takeSnapshot } from '../server/core.ts';
import { BOT_ID, DEFAULT_SETTINGS } from '../shared.ts';
import type { Message, Run } from '../shared.ts';
import type { Providers } from '../server/providers.ts';

const message = (seq: number, speakerId = 'aqing', text = `message ${seq}`): Message => ({ id: `m_${seq}`, seq, speakerId, speakerName: speakerId === BOT_ID ? '喵酱' : speakerId, at: new Date(0).toISOString(), text, mentions: [] });
const mock: Providers = {
  window: async messages => ({ messages: messages.slice(-3), tokens: 100, budget: 1760, exact: true }),
  judge: async () => ({ probabilities: { should_reply: 1, needs_web: 0, needs_memory: 0 }, raw: {} }),
  exaConfigured: () => false, modelStatus: async () => { throw new Error('unused'); },
  query: async () => '', search: async () => [],
  generate: async () => ({ text: '我换个话题好了，今天想出去晒晒太阳。', timings: {}, usage: { prompt: 100, completion: 10 } }),
};

test('all group members stay chronological and the bot speaks in native assistant turns', () => {
  const history = [message(1, 'alice'), message(2, BOT_ID, '旧回复'), message(3, 'bob'), message(4, 'carol')];
  const prompt = conversation('角色', history, history[0]);
  assert.deepEqual(prompt.map(m => m.role), ['system', 'user', 'assistant', 'user', 'user', 'user']);
  assert.equal(prompt[2].content, '旧回复');
  assert.match(prompt[1].content, /alice/); assert.match(prompt[3].content, /bob/); assert.match(prompt[4].content, /carol/);
  assert.match(prompt.at(-1)!.content, /#m_1/);
  assert.equal(prompt.filter(m => m.role === 'user').some(m => m.content.includes('旧回复')), false);
});

test('token fitting keeps the longest recent suffix and drops a single oversized message', async () => {
  const history = Array.from({ length: 8 }, (_, i) => message(i + 1));
  const fitted = await fitTail(history, 40, async messages => 10 + messages.length * 10);
  assert.deepEqual(fitted.messages.map(m => m.seq), [6, 7, 8]);
  assert.equal(fitted.tokens, 40);
  const oversized = await fitTail([message(1, 'alice', 'large')], 40, async messages => messages.length ? 100 : 10);
  assert.deepEqual(oversized.messages, []);
  const preserved = await fitTail([message(1, 'alice', 'small'), message(2, 'alice', 'x'.repeat(100))], 40, async messages => 10 + messages.reduce((sum, m) => sum + m.text.length, 0));
  assert.deepEqual(preserved.messages.map(m => m.seq), [1]);
});

test('expired chat is removed from state, copied prompts, raw Jev requests and outputs, and cannot be retried', () => {
  const state = initialState();
  const old = message(1, 'alice', 'OLD_PRIVATE_CONTENT');
  const retained = message(2, 'bob', 'new topic');
  state.messages = [retained];
  state.runs.push({ id: 'old', mode: 'live', status: 'error', phase: 'failed', startedAt: new Date(0).toISOString(), trigger: 'manual', snapshot: { messages: [old, retained], newMessages: [old], focus: old, through: 1 }, settings: DEFAULT_SETTINGS, steps: [], prompt: { messages: [{ role: 'user', content: old.text }], tokens: 20, budget: 1760, searchTokens: 0, trimmed: 0 }, jevRaw: { chat: old.text }, output: old.text, query: old.text, search: [{ title: old.text, snippet: old.text, url: 'https://example.com' }] });
  expireRuns(state);
  assert.ok(!JSON.stringify(state).includes('OLD_PRIVATE_CONTENT'));
  assert.equal(state.runs[0].expired, true);
  assert.throws(() => retryableRun(state, 'old'), /移出/);
});

test('rolling retention consumes expired backlog and keeps generation snapshots frozen during new arrivals', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  const h = new Harness(initialState(), { ...mock, window: async messages => { if (first) { first = false; await gate; } return { messages: messages.slice(-3), tokens: 100, budget: 1760, exact: true }; } }, () => {});
  h.addMessage({ speakerId: 'aqing', text: 'first' });
  const task = h.tick();
  const later = h.addMessage({ speakerId: 'xiaobai', text: 'arrived during tokenization' });
  release();
  const run = (await task)!;
  assert.equal(run.snapshot.through, 1);
  assert.equal(takeSnapshot(h.state)?.newMessages[0].id, later.id);
  for (let i = 0; i < 5; i++) h.addMessage({ speakerId: 'aqing', text: `next ${i}` });
  await h.compactContext();
  assert.equal(h.state.messages.length, 3);
  assert.equal(h.state.context?.discarded, 5);
  assert.ok(h.state.cursor >= 5);
  assert.equal(h.savedState().runs[0].expired, true);
});

test('a repeated long reply is suppressed before QQ delivery while short normal replies remain allowed', async () => {
  const repeated = '喵～我可是会变猫娘的哦！要不我们来做点心吧，我保证不会糟蹋你的驴打滚！';
  assert.equal(repeatsReply('@海胆头 ' + repeated, [message(1, BOT_ID, '@另一个人 ' + repeated)]), true);
  assert.equal(repeatsReply('好的', [message(1, BOT_ID, '好的')]), false);
  assert.equal(repeatsReply('我换个开头，但是接下来还是' + repeated, [message(1, BOT_ID, repeated)]), true);
  assert.equal(repeatsReply('喵～你说什么啊？我可是在认真跟你聊天呢！要不要来点心？保证不会糟蹋你的驴打滚！喵～', [message(1, BOT_ID, '喵～你是不是又在纠结什么奇怪的提示词啦？别太认真啦，我可是会变猫娘的哦！要不要来点心？保证不会糟蹋你的驴打滚！喵～')]), true);
  let sent = 0;
  const state = initialState(); state.messages = [message(1, BOT_ID, repeated), message(2, 'aqing', '别复读了')]; state.nextSeq = 3;
  const h = new Harness(state, { ...mock, generate: async () => ({ text: repeated, timings: {}, usage: { prompt: 1, completion: 1 } }) }, () => {}, async () => { sent++; });
  const run = (await h.tick())!;
  assert.equal(run.status, 'silent'); assert.equal(run.phase, '拦截重复回复'); assert.equal(sent, 0);
  assert.equal(h.state.messages.length, 2);
});
