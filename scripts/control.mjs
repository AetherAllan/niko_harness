import { readFile, open, mkdir } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const env = parseEnv(await readFile(resolve(root, '.env'), 'utf8'));
const port = Number(env.PORT || 4317);
const url = `http://127.0.0.1:${port}`;
if (process.argv[2] === 'stop') {
  try {
    const pid = Number(await readFile(resolve(root, 'logs/harness.pid'), 'utf8'));
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    if (command.includes(resolve(root, 'server/index.ts'))) {
      process.kill(pid, 'SIGTERM');
      for (let i = 0; i < 60; i++) {
        try { process.kill(pid, 0); } catch { break; }
        await new Promise(done => setTimeout(done, 100));
      }
      console.log('Harness stopped.');
    }
    else console.log('No matching Harness process.');
  } catch { console.log('Harness is already stopped.'); }
} else if (process.argv[2] === 'start') {
  try {
    const response = await fetch(url + '/api/health', { signal: AbortSignal.timeout(1500) });
    if ((await response.json()).app !== 'niko-harness') throw new Error('Port is occupied by another application.');
    console.log(`Already running: ${url}`);
    if (process.argv.includes('--open')) execFileSync('/usr/bin/open', [url]);
    process.exit(0);
  } catch (error) {
    if (error.message === 'Port is occupied by another application.') throw error;
  }
  await mkdir(resolve(root, 'logs'), { recursive: true });
  const log = await open(resolve(root, 'logs/harness.log'), 'a');
  const child = spawn(process.execPath, [resolve(root, 'server/index.ts')], { cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd] });
  child.unref();
  await log.close();
  for (let i = 0; i < 100; i++) {
    await new Promise(done => setTimeout(done, 200));
    try {
      const response = await fetch(url + '/api/health', { signal: AbortSignal.timeout(1000) });
      if ((await response.json()).app === 'niko-harness') { console.log(`Ready: ${url}`); if (process.argv.includes('--open')) execFileSync('/usr/bin/open', [url]); process.exit(0); }
    } catch { /* Wait for the local listener. */ }
  }
  throw new Error('Startup timed out; inspect logs/harness.log.');
} else throw new Error('Usage: node scripts/control.mjs start|stop');
