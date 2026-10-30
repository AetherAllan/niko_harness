import { createServer } from 'node:http';
import type { ServerResponse, IncomingMessage } from 'node:http';
import { readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Harness, initialState, replayProviders, retryableRun, SCENARIOS, validateSettings } from './core.ts';
import { createProviders } from './providers.ts';
import { QQBridge } from './qq.ts';
import { QQ_GROUP_ID } from '../shared.ts';
import type { Room, State } from '../shared.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data');
const LOGS = resolve(ROOT, 'logs');
const envKeys = ['TYPESAFE_API_KEY', 'EXA_API_KEY', 'NAPCAT_WS_URL', 'NAPCAT_TOKEN'] as const;
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
async function reloadEnv() {
  const parsed = parseEnv(await readFile(resolve(ROOT, '.env'), 'utf8'));
  for (const key of envKeys) {
    const value = parsed[key]?.trim() || originalEnv[key];
    if (value) process.env[key] = value;
    else delete process.env[key];
  }
  for (const key of ['LLAMA_BASE_URL', 'PORT']) if (parsed[key]) process.env[key] = parsed[key];
  await chmod(resolve(ROOT, '.env'), 0o600);
}
await reloadEnv();
const PORT = Number(process.env.PORT || 4317);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error('PORT 必须为 1024–65535');
await Promise.all([mkdir(DATA, { recursive: true, mode: 0o700 }), mkdir(LOGS, { recursive: true, mode: 0o700 })]);

const stateFile = (room: Room) => resolve(DATA, room === 'qq' ? `qq-${QQ_GROUP_ID}.json` : 'state.json');
async function loadState(room: Room): Promise<State> {
 try {
  const state = JSON.parse(await readFile(stateFile(room), 'utf8'));
  if (!Array.isArray(state.messages) || !Array.isArray(state.runs) || !Number.isInteger(state.cursor) || !Number.isInteger(state.nextSeq)) throw new Error('状态文件结构不正确');
  state.settings = validateSettings(state.settings);
  return state;
} catch (error: any) {
  if (error.code !== 'ENOENT') throw new Error(`无法读取 ${stateFile(room)}，原文件已保留：${error.message}`);
  return initialState();
 }
}
const [state, qqState] = await Promise.all([loadState('lab'), loadState('qq')]);

const clients = new Map<ServerResponse, Room>();
let writeQueue = Promise.resolve();
const roomHarness = (room: Room) => room === 'qq' ? qqHarness : harness;
const view = (room: Room) => ({ ...roomHarness(room).view(), room, qq: qqBridge.status });
const broadcast = () => {
  const text = { lab: `data: ${JSON.stringify(view('lab'))}\n\n`, qq: `data: ${JSON.stringify(view('qq'))}\n\n` };
  for (const [response, room] of clients) {
    if (response.writableLength > 2_000_000) { response.destroy(); clients.delete(response); }
    else response.write(text[room]);
  }
};
const persist = (room: Room) => {
  const target = roomHarness(room);
  writeQueue = writeQueue.then(async () => {
    await target.compactContext();
    const serialized = JSON.stringify(target.savedState());
    const path = stateFile(room);
    await writeFile(path + '.tmp', serialized, { mode: 0o600 });
    await rename(path + '.tmp', path);
    target.storageError = undefined;
  }).catch((error: Error) => { target.storageError = `保存失败：${error.message}`; broadcast(); });
  broadcast();
  return writeQueue;
};
const harness = new Harness(state, createProviders(ROOT), () => persist('lab'));
const qqHarness = new Harness(qqState, createProviders(ROOT), () => persist('qq'), (message, run, signal) => qqBridge.deliver(message, run, signal));
const qqBridge = new QQBridge(message => { qqHarness.receiveMessage(message); }, broadcast);
await Promise.all([harness.compactContext(), qqHarness.compactContext()]);
const server = createServer();
const dev = process.argv.includes('--dev');
const vite = dev ? await (await import('vite')).createServer({
  configFile: resolve(ROOT, 'vite.config.ts'), root: ROOT,
  server: { middlewareMode: true, hmr: { server, host: '127.0.0.1', port: PORT } }, appType: 'spa',
}) : undefined;

function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('请求必须为 application/json');
  const parts: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 32_768) throw new Error('请求超过 32 KiB');
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
const safeHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const safeOrigins = new Set([...safeHosts].map(host => 'http://' + host));

server.on('request', async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  if (!safeHosts.has(request.headers.host || '') || (request.headers.origin && !safeOrigins.has(request.headers.origin))) return json(response, { error: '仅允许本机同源请求' }, 403);
  const url = new URL(request.url || '/', `http://127.0.0.1:${PORT}`);
  try {
    const room = url.searchParams.get('room') || 'lab';
    if (room !== 'lab' && room !== 'qq') return json(response, { error: '没有这个会话' }, 400);
    const harness = roomHarness(room);
    if (url.pathname === '/api/health') return json(response, { app: 'niko-harness', status: 'ok' });
    if (url.pathname === '/api/state' && request.method === 'GET') return json(response, view(room));
    if (url.pathname === '/api/scenarios' && request.method === 'GET') return json(response, SCENARIOS.map(({ id, name, description }) => ({ id, name, description })));
    if (url.pathname === '/api/export' && request.method === 'GET') {
      response.setHeader('Content-Disposition', 'attachment; filename="niko-experiment.json"');
      return json(response, { exportedAt: new Date().toISOString(), ...view(room) });
    }
    if (url.pathname === '/api/model-report' && request.method === 'GET') {
      let benchmark = [];
      let localSmoke;
      try { benchmark = JSON.parse(await readFile(resolve(ROOT, 'reports/inference-benchmark.json'), 'utf8')); } catch { /* No benchmark yet. */ }
      try {
        const smoke = JSON.parse(await readFile(resolve(ROOT, 'reports/local-smoke.json'), 'utf8'));
        localSmoke = { inputTokens: smoke.prompt.tokens, searchTokens: smoke.prompt.searchTokens, trimmed: smoke.prompt.trimmed, perSecond: smoke.completion.usage.perSecond, generationMs: smoke.generationMs };
      } catch { /* No local smoke report yet. */ }
      return json(response, { benchmark, localSmoke, model: harness.model });
    }
    if (url.pathname === '/api/stream' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      response.write(`data: ${JSON.stringify(view(room))}\n\n`);
      clients.set(response, room);
      request.on('close', () => clients.delete(response));
      return;
    }
    if (request.method === 'POST') {
      const input = await body(request);
      if (url.pathname === '/api/messages') {
        if (room === 'qq') throw new Error('QQ 会话只接收真实群消息；请在手机 QQ 的限定群内发言');
        const message = harness.addMessage(input);
        await harness.compactContext();
        if (!harness.state.messages.some(m => m.id === message.id)) throw new Error('这条消息超过 2048 的可用窗口，原文未保留，请缩短后再发');
        return json(response, message, 201);
      }
      if (url.pathname === '/api/settings') { harness.settings(input); return json(response, { ok: true }); }
      if (url.pathname === '/api/pause') {
        if (typeof input.paused !== 'boolean') throw new Error('paused 必须为布尔值');
        if (!input.paused && !process.env.TYPESAFE_API_KEY) throw new Error('请先在 .env 配置 Jev 密钥，或使用明确标注的演示回放');
        if (!input.paused && room === 'qq' && !qqBridge.status.ready) throw new Error(qqBridge.status.detail);
        if (input.paused && room === 'qq') harness.cancelCurrent('QQ 自动回复已暂停');
        harness.pause(input.paused); return json(response, { ok: true });
      }
      if (url.pathname === '/api/tick') {
        if (room === 'qq' && !qqBridge.status.ready) throw new Error(qqBridge.status.detail);
        if (harness.busy) return json(response, { error: '当前心跳仍在处理' }, 409);
        if (input.retry) retryableRun(harness.state, input.retry);
        void harness.tick(input.retry ? 'retry' : 'manual', { retry: input.retry }).catch((e: Error) => console.error(e.message));
        return json(response, { ok: true }, 202);
      }
      if (url.pathname === '/api/reset') {
        if (room === 'qq') throw new Error('QQ 测试记录不能从实验室清空；请先导出保存');
        harness.reset(); return json(response, { ok: true });
      }
      if (url.pathname === '/api/replay') {
        if (room === 'qq') throw new Error('QQ 会话禁止演示回放，避免把测试数据发送到群');
        if (harness.busy) return json(response, { error: '请等待本轮处理完成' }, 409);
        const scenario = SCENARIOS.find(s => s.id === input.id);
        if (!scenario) throw new Error('没有这个回放');
        harness.pause(true);
        for (const message of scenario.messages) harness.addMessage({ ...message, mentions: 'mentions' in message ? [...message.mentions] : [], sample: true });
        void harness.tick('manual', { replay: replayProviders(scenario.id) });
        return json(response, { ok: true }, 202);
      }
      if (url.pathname === '/api/reload-env') {
        if (roomHarness('lab').busy || qqHarness.busy) throw new Error('请等待本轮结束后重新读取 .env');
        await reloadEnv(); roomHarness('lab').providers = createProviders(ROOT); qqHarness.providers = createProviders(ROOT); qqBridge.start(); broadcast(); return json(response, { ok: true });
      }
      if (url.pathname === '/api/model/start') {
        if (roomHarness('lab').busy || qqHarness.busy) throw new Error('请等待所有会话的本轮结束');
        const { stdout } = await promisify(execFile)('python3', [resolve(ROOT, 'scripts/model.py'), 'start'], { cwd: ROOT, timeout: 250_000, maxBuffer: 30_000 });
        harness.model = await harness.providers.modelStatus(); broadcast(); return json(response, { ok: true, detail: stdout });
      }
      return json(response, { error: '没有这个操作' }, 404);
    }
    if (url.pathname.startsWith('/api/')) return json(response, { error: '没有这个接口' }, 404);
    if (vite) return vite.middlewares(request, response);
    if (!['GET', 'HEAD'].includes(request.method || '')) return json(response, { error: 'Method not allowed' }, 405);
    const dist = resolve(ROOT, 'dist');
    let path = resolve(dist, '.' + decodeURIComponent(url.pathname));
    if (path !== dist && !path.startsWith(dist + sep)) return json(response, { error: '路径无效' }, 403);
    if (!extname(path)) path = resolve(dist, 'index.html');
    if (!existsSync(path)) return json(response, { error: '资源不存在；首次启动请先 npm run build' }, 404);
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'");
    response.writeHead(200, { 'Content-Type': `${types[extname(path)] || 'application/octet-stream'}; charset=utf-8` });
    response.end(request.method === 'HEAD' ? undefined : await readFile(path));
  } catch (error: any) {
    if (response.headersSent) response.destroy();
    else json(response, { error: error.message || '操作未完成' }, 400);
  }
});

async function refreshModel() { const model = await harness.providers.modelStatus(); harness.model = model; qqHarness.model = model; broadcast(); }
const monitor = setInterval(() => { void refreshModel(); for (const response of clients.keys()) response.write(': keep-alive\n\n'); }, 20_000);
server.listen(PORT, '127.0.0.1', async () => {
  await writeFile(resolve(LOGS, 'harness.pid'), String(process.pid));
  console.log(`Niko Harness → http://127.0.0.1:${PORT}`);
  console.log(`本地配置：${resolve(ROOT, '.env')}（仅后端读取）`);
  persist('lab'); persist('qq'); qqBridge.start(); void refreshModel();
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; clearInterval(monitor); });
async function shutdown() {
  harness.pause(true); harness.cancelCurrent(); clearInterval(monitor);
  qqHarness.pause(true); qqHarness.cancelCurrent(); qqBridge.stop();
  for (const response of clients.keys()) response.end();
  await new Promise<void>(done => setTimeout(done, 100));
  await writeQueue;
  await vite?.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
