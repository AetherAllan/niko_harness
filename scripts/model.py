"""An isolated launcher for the existing GGUF files; never edits the parent setup."""
from pathlib import Path
import argparse
import fcntl
import json
import os
import signal
import socket
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MODEL_ROOT = ROOT.parent
BINARY = MODEL_ROOT / 'llama.cpp/build/bin/llama-server'
URL = 'http://127.0.0.1:8080'
LOGS = ROOT / 'logs'
PID_FILE = LOGS / 'model.pid'


def api(path, data=None, timeout=5):
    request = urllib.request.Request(URL + path, data=None if data is None else json.dumps(data).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def memory():
    return {key: subprocess.check_output(cmd, text=True).strip() for key, cmd in {
        'pressure': ['sysctl', '-n', 'kern.memorystatus_vm_pressure_level'],
        'swap': ['sysctl', 'vm.swapusage'],
    }.items()}


def owned_pid():
    try:
        pid = int(PID_FILE.read_text().strip())
        command = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True).stdout.strip()
        expected = json.loads((LOGS / 'model-command.json').read_text())
        return pid if command == ' '.join(expected) else None
    except (OSError, ValueError):
        return None


def stop():
    pid = owned_pid()
    if pid is None:
        print('No Harness-owned model to stop. Existing external services are left alone.', flush=True)
        return
    os.kill(pid, signal.SIGTERM)
    for _ in range(90):
        if owned_pid() is None:
            PID_FILE.unlink(missing_ok=True)
            print('Harness model stopped.', flush=True)
            return
        time.sleep(0.3)
    raise RuntimeError('Model did not stop; inspect logs/model.log.')


def start(ctx=4096, batch=128, ubatch=64, kv='q8_0', spec='none'):
    try:
        health = api('/health')
    except OSError:
        health = None
    if health and health.get('status') == 'ok':
        props = api('/props')
        adapters = api('/lora-adapters')
        expected = str(MODEL_ROOT / 'models/source31-lora-f16.gguf')
        if not any(a.get('path') == expected and a.get('scale') == 1 for a in adapters):
            raise RuntimeError('Port 8080 is serving a model without source31 at scale 1.0. No existing service was changed.')
        print(json.dumps({'reused': True, 'context': props['default_generation_settings']['n_ctx'], 'adapters': adapters}, ensure_ascii=False), flush=True)
        return
    try:
        connection = socket.create_connection(('127.0.0.1', 8080), timeout=1)
    except OSError:
        connection = None
    if connection:
        connection.close()
        raise RuntimeError('Port 8080 is already occupied or loading. Existing process left untouched; wait for it or inspect its logs.')
    files = [BINARY, MODEL_ROOT / 'models/Qwen3-8B-Q8_0.gguf', MODEL_ROOT / 'models/source31-lora-f16.gguf']
    for path in files:
        if not path.is_file():
            raise RuntimeError(f'Missing existing model file: {path}. No download was attempted.')
    command = [
        str(BINARY), '--model', str(files[1]), '--alias', 'Qwen3-8B-source31-Q8_0',
        '--host', '127.0.0.1', '--port', '8080', '--offline', '--log-verbosity', '3',
        '--device', 'MTL0', '--n-gpu-layers', '99', '--fit', 'off',
        '--ctx-size', str(ctx), '--parallel', '1', '--batch-size', str(batch), '--ubatch-size', str(ubatch),
        '--threads', '4', '--flash-attn', 'on', '--cache-ram', '0',
        '--cache-type-k', kv, '--cache-type-v', kv,
        '--lora-scaled', str(files[2]) + ':1.0', '--jinja', '--reasoning', 'off',
        '--temp', '0.7', '--top-p', '0.8', '--top-k', '20', '--min-p', '0', '--predict', '192',
        '--metrics', '--spec-type', spec,
    ]
    if spec != 'none':
        command.extend(['--spec-draft-n-max', '4'])
    LOGS.mkdir(exist_ok=True)
    (LOGS / 'model-command.json').write_text(json.dumps(command, indent=2) + '\n')
    env = {k: v for k, v in os.environ.items() if not k.startswith('LLAMA_ARG_') and k != 'LLAMA_API_KEY'}
    with (LOGS / 'model.log').open('ab', buffering=0) as log:
        child = subprocess.Popen(command, cwd=MODEL_ROOT, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    PID_FILE.write_text(str(child.pid))
    print(f'Loading existing Q8_0 + source31: ctx={ctx}, KV={kv}, batch={batch}/{ubatch}, spec={spec}', flush=True)
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise RuntimeError('llama-server exited. See logs/model.log.')
        try:
            if api('/health').get('status') == 'ok':
                adapters = api('/lora-adapters')
                assert any(a['path'] == str(files[2]) and a['scale'] == 1 for a in adapters), adapters
                actual = api('/props')['default_generation_settings']['n_ctx']
                assert actual == ctx, actual
                print(json.dumps({'ready': URL, 'context': actual, 'source31_scale': 1.0, 'memory': memory()}, ensure_ascii=False), flush=True)
                return
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError('Model startup timed out. See logs/model.log.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['start', 'stop'])
    parser.add_argument('--ctx', type=int, choices=[2048, 4096], default=4096)
    parser.add_argument('--batch', type=int, default=128)
    parser.add_argument('--ubatch', type=int, default=64)
    parser.add_argument('--kv', choices=['f16', 'q8_0'], default='q8_0')
    parser.add_argument('--spec', choices=['none', 'ngram-simple'], default='none')
    args = parser.parse_args()
    LOGS.mkdir(exist_ok=True)
    with (LOGS / 'model-control.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            stop() if args.action == 'stop' else start(args.ctx, args.batch, args.ubatch, args.kv, args.spec)
        except Exception as error:
            raise SystemExit(f'ERROR: {error}')
