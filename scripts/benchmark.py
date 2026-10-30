from pathlib import Path
import json
import time
from model import api, memory, owned_pid, start, stop

ROOT = Path(__file__).resolve().parents[1]
PROMPT = (ROOT.parent / 'system-prompt.txt').read_text().strip()
rows = []
try:
    healthy = api('/health').get('status') == 'ok'
except OSError:
    healthy = False
if healthy and owned_pid() is None:
    raise SystemExit('A separately owned model is running; benchmark will not interrupt it.')
for name, kv, batch, ubatch, spec in [
    ('4096-f16-small-batch', 'f16', 32, 16, 'none'),
    ('4096-q8-batch128', 'q8_0', 128, 64, 'none'),
    ('4096-q8-ngram', 'q8_0', 128, 64, 'ngram-simple'),
]:
    stop()
    before = memory()
    start(4096, batch, ubatch, kv, spec)
    messages = [
        {'role': 'system', 'content': PROMPT + '\n这是群聊记录。只说你自己的一两句话，不替别人续写。'},
        {'role': 'user', 'content': '[阿青/u1] 今天终于下班了，脑袋空空的。\n[小白/u2] 我在考虑今晚吃火锅。\n[柚子/u3] 可是太辣了吧。\n[阿青/u1，@猫娘] 你想吃什么？不用长篇大论，随便聊两句。'},
    ]
    for cached in [False, True]:
        request = dict(model='Qwen3-8B-source31-Q8_0', messages=messages, temperature=0.7, top_p=0.8, top_k=20, min_p=0, seed=31031, max_tokens=64, stream=False, cache_prompt=True, chat_template_kwargs={'enable_thinking': False}, tools=[])
        started = time.monotonic()
        response = api('/v1/chat/completions', request, timeout=180)
        row = {'profile': name, 'warm_prefix': cached, 'wall_seconds': time.monotonic() - started, 'timings': response.get('timings'), 'usage': response.get('usage'), 'reply': response['choices'][0]['message']['content'], 'before': before, 'after': memory(), 'adapters': api('/lora-adapters')}
        rows.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
    (ROOT / 'reports').mkdir(exist_ok=True)
    (ROOT / 'reports/inference-benchmark.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2))
stop()
start(4096, 128, 64, 'q8_0', 'none')
