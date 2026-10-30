import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Harness, initialState, takeSnapshot } from '../server/core.ts';
import { createProviders } from '../server/providers.ts';
import { BOT_ID, CONTEXT_SIZE } from '../shared.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const real = createProviders(root);
const model = await real.modelStatus();
assert.ok(model.available && model.loraVerified, model.detail);
assert.equal(model.contextSize, CONTEXT_SIZE);
const h = new Harness(initialState(), real, () => {});
for (let i = 0; i < 16; i++) h.addMessage({ speakerId: i % 2 ? 'aqing' : 'xiaobai', text: `背景消息 ${i}：` + '今天在群里讨论做饭、工作和周末安排。'.repeat(20) });
h.addMessage({ speakerId: 'yuzu', text: '喵酱，帮我查一下 TypeSafe Jev 的 Noul 返回什么？', mentions: [BOT_ID] });
const snapshot = takeSnapshot(h.state)!;
const signal = AbortSignal.timeout(180_000);
const queryStarted = performance.now();
let query: string | undefined, queryError: string | undefined;
try { query = await real.query(snapshot, signal); }
catch (error) { queryError = (error as Error).message; }
const queryMs = performance.now() - queryStarted;
const sources = Array.from({ length: 3 }, (_, i) => ({ title: `TypeSafe Noul 演示资料 ${i + 1}`, url: 'https://docs.typesafe.ai/primitives/noul', snippet: 'Noul 返回 yes 的概率，字段为 answers.问题名.noul，没有单独的 confidence。'.repeat(12).slice(0, 420) }));
let prompt: any;
const started = performance.now();
const completion = await real.generate(snapshot, h.state.settings, '以下是固定测试资料，不是本次真实 Exa 检索。记忆检索关闭。', sources, signal, value => { prompt = value; });
assert.ok(prompt.tokens + 192 + 96 <= CONTEXT_SIZE);
assert.ok(prompt.searchTokens <= h.state.settings.searchTokenBudget);
assert.ok(prompt.searchTokens > 0, 'required search references must survive the context budget');
assert.ok(prompt.trimmed > 0, 'stress fixture must exercise context trimming');
assert.ok(completion.text.length > 0);
const report = { utc: new Date().toISOString(), provenance: 'Real local source31 inference and tokenizer; synthetic group messages and reference documents. No Jev or Exa network call.', model, query, queryError, queryMs, generationMs: performance.now() - started, prompt, completion };
await mkdir(resolve(root, 'reports'), { recursive: true });
await writeFile(resolve(root, 'reports/local-smoke.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ model, query, queryError, inputTokens: prompt.tokens, searchTokens: prompt.searchTokens, trimmed: prompt.trimmed, output: completion.text, usage: completion.usage }, null, 2));
if (queryError) process.exitCode = 1;
