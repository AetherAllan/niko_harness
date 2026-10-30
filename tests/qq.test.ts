import test from 'node:test';
import assert from 'node:assert/strict';
import { BOT_ID, QQ_GROUP_ID } from '../shared.ts';
import { groupMessage, outgoingGroupMessage } from '../server/qq.ts';
import { Harness, initialState } from '../server/core.ts';
import { redactQuery } from '../server/providers.ts';
import type { Providers } from '../server/providers.ts';

const self = '2032635652';
const incoming = (overrides: Record<string, unknown> = {}) => ({
  post_type: 'message', message_type: 'group', group_id: Number(QQ_GROUP_ID), self_id: Number(self),
  user_id: 123456789, message_id: -900, time: 1793354000,
  sender: { card: '测试群友', nickname: 'nickname' },
  message: [{ type: 'text', data: { text: '你觉得呢？' } }, { type: 'at', data: { qq: self } }, { type: 'reply', data: { id: '800' } }], ...overrides,
});
const providers: Providers = {
  exaConfigured: () => false,
  modelStatus: async () => ({ available: true, loraVerified: true, contextSize: 4096, model: 'test', adapter: 'test', detail: '' }),
  judge: async () => ({ probabilities: { should_reply: 1, needs_web: 0, needs_memory: 0 }, raw: {} }),
  query: async () => '', search: async () => [],
  generate: async () => ({ text: '大家好喵。', timings: {}, usage: { prompt: 1, completion: 1 } }),
};

test('QQ ingress rejects every other group, private chat, bot echoes, and wrong login identity', () => {
  assert.equal(groupMessage({ post_type: 'message', message_type: 'group', group_id: 1, get message() { throw new Error('must filter before content'); } }, self), null);
  assert.equal(groupMessage(incoming({ message_type: 'private' }), self), null);
  assert.equal(groupMessage(incoming({ post_type: 'message_sent' }), self), null);
  assert.equal(groupMessage(incoming({ user_id: Number(self) }), self), null);
  assert.equal(groupMessage(incoming({ self_id: 123 }), self), null);
  assert.equal(groupMessage(incoming({ message: '[CQ:at,qq=1]bad' }), self), null);
});

test('QQ ingress preserves speaker, timestamp, mentions and reply IDs; duplicate events do not trigger twice', () => {
  const message = groupMessage(incoming(), self)!;
  assert.equal(message.speakerName, '测试群友');
  assert.equal(message.text, '你觉得呢？');
  assert.deepEqual(message.mentions, [BOT_ID]);
  assert.equal(message.replyTo, `qq_${QQ_GROUP_ID}_800`);
  assert.deepEqual(message.qq, { groupId: QQ_GROUP_ID, messageId: '-900' });
  const h = new Harness(initialState(), providers, () => {});
  assert.equal(h.receiveMessage(message), true);
  assert.equal(h.receiveMessage(message), false);
  assert.equal(h.state.messages.length, 1);
  assert.equal(h.state.nextSeq, 2);
});

test('QQ egress pins the group and uses literal text segments, rejecting replay and mixed-room snapshots', async () => {
  let params: ReturnType<typeof outgoingGroupMessage> | undefined;
  const h = new Harness(initialState(), { ...providers, generate: async () => ({ text: '[CQ:at,qq=all]', timings: {}, usage: { prompt: 1, completion: 1 } }) }, () => {}, async (message, run) => {
    params = outgoingGroupMessage(message, run);
    run.delivery = { status: 'sent', groupId: QQ_GROUP_ID, messageId: '555' };
  });
  h.receiveMessage(groupMessage(incoming(), self)!);
  const run = (await h.tick())!;
  assert.equal(run.status, 'replied');
  assert.equal(params?.group_id, Number(QQ_GROUP_ID));
  assert.deepEqual(params?.message, [{ type: 'reply', data: { id: '-900' } }, { type: 'text', data: { text: '[CQ:at,qq=all]' } }]);
  const message = h.state.messages.at(-1)!;
  assert.throws(() => outgoingGroupMessage({ ...message, sample: true }, run));
  assert.throws(() => outgoingGroupMessage(message, { ...run, mode: 'replay' }));
  assert.throws(() => outgoingGroupMessage(message, { ...run, snapshot: { ...run.snapshot, focus: { ...run.snapshot.focus, qq: { groupId: '1', messageId: '-900' } } } }));
  assert.throws(() => outgoingGroupMessage(message, { ...run, snapshot: { ...run.snapshot, newMessages: [{ ...run.snapshot.focus, qq: undefined }] } }));
});

test('QQ send intent is persisted before delivery, uncertain sends cannot be retried, and restart preserves the guard', async () => {
  let persisted = false, attempted = 0;
  let h: Harness;
  h = new Harness(initialState(), providers, async () => {
    if (h.state.runs.at(-1)?.delivery?.status === 'sending') { await Promise.resolve(); persisted = true; }
  }, async () => { assert.equal(persisted, true); attempted++; throw new Error('ack lost'); });
  h.receiveMessage(groupMessage(incoming(), self)!);
  const run = (await h.tick())!;
  assert.equal(run.status, 'error');
  assert.equal(run.delivery?.status, 'uncertain');
  assert.equal(h.state.messages.filter(m => m.speakerId === BOT_ID).length, 0);
  assert.equal(await h.tick(), null);
  await assert.rejects(h.tick('retry', { retry: run.id }), /不能重试/);
  assert.equal(attempted, 1);
  const state = structuredClone(h.state);
  state.runs[0].status = 'running'; state.runs[0].delivery!.status = 'sending';
  const restarted = new Harness(state, providers, () => {});
  assert.equal(restarted.state.runs[0].delivery?.status, 'uncertain');
  await assert.rejects(restarted.tick('retry', { retry: run.id }), /不能重试/);
});

test('QQ participant names and IDs are stripped before public searches', () => {
  assert.equal(redactQuery('测试群友 帮忙找 Jev 文档 QQ123456789', ['测试群友']), '帮忙找 Jev 文档');
});

test('a QQ ACK received after pause is still recorded as delivered, and does not trigger self-replies', async () => {
  let h: Harness;
  h = new Harness(initialState(), providers, () => {}, async (_message, run) => {
    h.pause(true); h.cancelCurrent('QQ 自动回复已暂停');
    run.delivery = { status: 'sent', groupId: QQ_GROUP_ID, messageId: '555' };
  });
  h.receiveMessage(groupMessage(incoming(), self)!);
  const run = (await h.tick())!;
  assert.equal(run.status, 'replied');
  assert.equal(h.state.messages.at(-1)?.speakerId, BOT_ID);
  assert.equal(await h.tick(), null);
});
