import test from 'node:test';
import assert from 'node:assert/strict';
import { compactExa, createProviders, judgeRequest, parseNoul, redactQuery } from '../server/providers.ts';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState, Harness, takeSnapshot } from '../server/core.ts';
import { BOT_ID, DEFAULT_SETTINGS } from '../shared.ts';
import type { Providers } from '../server/providers.ts';

test('the three named Noul answers retain the exact probabilities and reject invalid API shapes', () => {
  const raw = { answers: Object.fromEntries(Object.entries({ should_reply: 0.7123456, needs_web: 0.95, needs_memory: 0.02 }).map(([key, noul]) => [key, { type: 'noul', noul }])) };
  assert.deepEqual(parseNoul(raw), { should_reply: 0.7123456, needs_web: 0.95, needs_memory: 0.02 });
  assert.throws(() => parseNoul({ answers: { should_reply: { confidence: 0.9 } } }));
  assert.throws(() => parseNoul({ answers: { ...raw.answers, should_reply: { type: 'noul', noul: 1.1 } } }));
});

test('Jev questions share one focused state and do not ask for a draft or expression direction', () => {
  const h = new Harness(initialState(), {} as Providers, () => {});
  const focus = h.addMessage({ speakerId: 'aqing', text: '喵酱，你觉得呢？', mentions: [BOT_ID] });
  const request = judgeRequest(takeSnapshot(h.state)!, DEFAULT_SETTINGS, '原始喵酱人设');
  assert.equal(request.state.focus_message_id, focus.id);
  assert.equal(request.state.bot.name, '喵酱');
  assert.deepEqual(Object.keys(request.questions), ['should_reply', 'needs_web', 'needs_memory']);
  assert.ok(Object.values(request.questions).every(q => q.type === 'noul'));
});

test('Exa compaction bounds results, ignores full-page text, and rejects unsafe links', () => {
  const raw = { results: Array.from({ length: 20 }, (_, i) => ({ title: '新闻', url: i === 0 ? 'javascript:alert(1)' : `https://example.com/${i}`, highlights: ['a'.repeat(20_000)], text: 'NEVER_INCLUDE_FULL_PAGE'.repeat(1000) })) };
  const compact = compactExa(raw, DEFAULT_SETTINGS);
  assert.ok(compact.length <= DEFAULT_SETTINGS.searchResults);
  assert.ok(compact.every(r => r.snippet.length <= DEFAULT_SETTINGS.searchSnippetChars));
  assert.ok(!JSON.stringify(compact).includes('NEVER_INCLUDE_FULL_PAGE'));
  assert.ok(compact.every(r => r.url.startsWith('https://')));
});

test('query minimization removes simulation identities and common private identifiers', () => {
  const query = redactQuery('阿青 aqing 请查 Qwen3 发布 alice@example.com 13812345678 https://private.example/x /Users/admin/private.txt 密码:secret123');
  assert.match(query, /Qwen3/);
  for (const privatePart of ['阿青', 'aqing', 'alice', '13812345678', 'private.example', '/Users', 'secret123']) assert.ok(!query.includes(privatePart));
});

test('Jev and Exa adapters use documented request contracts and compact the response', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'niko-provider-'));
  const root = join(temp, 'harness');
  await mkdir(root);
  await writeFile(join(temp, 'system-prompt.txt'), 'fixture persona');
  await writeFile(join(temp, 'ui-config.json'), '{}');
  const oldJev = process.env.TYPESAFE_API_KEY, oldExa = process.env.EXA_API_KEY;
  process.env.TYPESAFE_API_KEY = 'fixture-jev'; process.env.EXA_API_KEY = 'fixture-exa';
  t.after(async () => {
    if (oldJev) process.env.TYPESAFE_API_KEY = oldJev; else delete process.env.TYPESAFE_API_KEY;
    if (oldExa) process.env.EXA_API_KEY = oldExa; else delete process.env.EXA_API_KEY;
    await rm(temp, { recursive: true });
  });
  const calls: { url: string; body: any; headers: any }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    calls.push({ url, body: JSON.parse(options.body as string), headers: options.headers });
    return Response.json(url.includes('typesafe') ? { answers: Object.fromEntries(['should_reply', 'needs_web', 'needs_memory'].map(key => [key, { type: 'noul', noul: 0.82 }])) } : { results: [{ title: 'fixture', url: 'https://example.com', highlights: ['a'.repeat(4000)], text: 'full text must be discarded' }] });
  });
  const h = new Harness(initialState(), {} as Providers, () => {});
  h.addMessage({ speakerId: 'aqing', text: '查一下最新消息', mentions: [BOT_ID] });
  const p = createProviders(root);
  await p.judge(takeSnapshot(h.state)!, DEFAULT_SETTINGS, new AbortController().signal);
  const results = await p.search('公开搜索主题', DEFAULT_SETTINGS, new AbortController().signal);
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(calls[0].headers.Authorization, 'Bearer fixture-jev');
  assert.equal(Object.keys(calls[0].body.questions).length, 3);
  assert.equal(calls[1].url, 'https://api.exa.ai/search');
  assert.equal(calls[1].headers['x-api-key'], 'fixture-exa');
  assert.deepEqual(calls[1].body.contents, { highlights: { maxCharacters: 420 } });
  assert.equal(calls[1].body.numResults, 3);
  assert.equal(results[0].snippet.length, 420);
});
