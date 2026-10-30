import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Activity, ArrowDownToLine, ArrowUp, ArrowUpRight, AtSign, Check, CheckCheck, ChevronDown, ChevronRight, CircleAlert, Clock3, Code2, Copy, Database, ExternalLink, FileText, FlaskConical, HeartPulse, History, Leaf, LoaderCircle, MessageCircle, MessagesSquare, Pause, Play, Plus, Radio, Reply, RotateCcw, Search, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Terminal, X, Zap } from 'lucide-react';
import { BOT_ID, DEFAULT_SETTINGS, QQ_GROUP_ID, SPEAKERS } from '../shared.ts';
import type { Message, PublicState, Room, Run, Settings } from '../shared.ts';
import { TextureCard, TextureCardContent } from './components/ui/texture-card.tsx';

type Page = 'lab' | 'history' | 'settings' | 'model';
const time = (date: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(date));
const duration = (ms: number) => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
const elapsed = (run: Run, now: number) => Math.max(0, (run.endedAt ? Date.parse(run.endedAt) : now) - Date.parse(run.startedAt));
async function api(path: string, data?: unknown, room: Room = 'lab') {
  const response = await fetch('/api/' + path + '?room=' + room, data === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作未完成');
  return result;
}
function Button({ children, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) { return <button className={`button ${className}`} {...props}>{children}</button>; }
function Badge({ children, tone = '' }: { children: ReactNode; tone?: string }) { return <span className={`badge ${tone}`}>{children}</span>; }
function Avatar({ id, small = false, name }: { id: string; small?: boolean; name?: string }) {
  const speaker = SPEAKERS.find(s => s.id === id);
  return id === BOT_ID ? <img className={`avatar cat-avatar ${small ? 'small' : ''}`} src="/niko.svg" alt="喵酱" /> : <span className={`avatar ${speaker?.color || ''} ${small ? 'small' : ''}`}>{speaker?.name.slice(-1) || name?.slice(-1) || '?'}</span>;
}
function EmptyTrace() { return <div className="empty-trace"><div className="orbital"><HeartPulse size={23} /><i /><i /></div><h3>每一次沉默，也有迹可循</h3><p>发送几条消息，再运行一次心跳。<br />你会在这里看到判断、资料和生成过程。</p></div>; }

export default function App() {
  const [room, setRoom] = useState<Room>(() => localStorage.getItem('niko-room') === 'qq' ? 'qq' : 'lab');
  const isQQ = room === 'qq';
  const [state, setState] = useState<PublicState>();
  const [page, setPage] = useState<Page>('lab');
  const [connected, setConnected] = useState(false);
  const [toast, setToast] = useState('');
  const [now, setNow] = useState(Date.now());
  const [selectedId, setSelectedId] = useState<string>();
  const [confirmReset, setConfirmReset] = useState(false);
  const [showScenarios, setShowScenarios] = useState(false);
  const [scenarios, setScenarios] = useState<{ id: string; name: string; description: string }[]>([]);
  const [speaker, setSpeaker] = useState<string>(SPEAKERS[0].id);
  const [text, setText] = useState('');
  const [mention, setMention] = useState(false);
  const [replyTo, setReplyTo] = useState<Message>();
  const [sending, setSending] = useState(false);
  const chatViewport = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    setState(undefined); setConnected(false); setSelectedId(undefined); setReplyTo(undefined);
    localStorage.setItem('niko-room', room);
    const stream = new EventSource('/api/stream?room=' + room);
    stream.onmessage = event => { setState(JSON.parse(event.data)); setConnected(true); };
    stream.onerror = () => setConnected(false);
    api('scenarios').then(setScenarios).catch(() => {});
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => { stream.close(); clearInterval(timer); };
  }, [room]);
  useEffect(() => {
    if (state?.messages.length && chatViewport.current) chatViewport.current.scrollTo({ top: chatViewport.current.scrollHeight, behavior: 'smooth' });
  }, [state?.messages.length, state?.busy, page]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 4500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    if (!confirmReset && !showScenarios) return;
    const previous = document.activeElement as HTMLElement;
    const focusable = () => [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input') || [])];
    focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setConfirmReset(false); setShowScenarios(false); }
      if (event.key !== 'Tab') return;
      const items = focusable(), first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [confirmReset, showScenarios]);
  const action = async (path: string, data: unknown = {}) => { try { return await api(path, data, room); } catch (error) { setToast((error as Error).message); } };
  const latest = state?.runs.at(-1);
  const selected = state?.runs.find(r => r.id === selectedId) || latest;
  const pending = state?.messages.filter(m => m.seq > state.cursor && m.speakerId !== BOT_ID).length || 0;
  const model = state?.services.model;
  const countdown = state?.nextHeartbeatAt ? Math.max(0, Math.ceil((Date.parse(state.nextHeartbeatAt) - now) / 1000)) : null;
  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    const result = await action('messages', { speakerId: speaker, text, mentions: mention ? [BOT_ID] : [], replyTo: replyTo?.id });
    if (result) { setText(''); setReplyTo(undefined); setMention(false); composer.current?.focus(); }
    setSending(false);
  };

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#" aria-label="Niko 喵酱群聊实验室" onClick={e => { e.preventDefault(); setPage('lab'); }}><img src="/niko.svg" alt="" /><div><strong>niko<span>lab</span></strong><small>喵酱的群聊实验室</small></div><Badge>MVP</Badge></a>
      <div className="nav-label">工作台 <span>WORKSPACE</span></div>
      <nav aria-label="主导航">{([
        ['lab', MessagesSquare, '群聊实验室'], ['history', History, '心跳记录'], ['settings', SlidersHorizontal, '连接与参数'], ['model', Zap, '推理观察'],
      ] as const).map(([id, Icon, title]) => <button key={id} aria-label={title} className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => setPage(id)}><Icon size={18} /><span>{title}</span>{id === 'history' && <em>{state?.runs.length || 0}</em>}{page === id && <span className="nav-dot" />}</button>)}</nav>
      <div className="room-switcher" role="group" aria-label="切换会话"><button aria-label="本地模拟会话" aria-pressed={!isQQ} className={!isQQ ? 'active' : ''} onClick={() => setRoom('lab')}><FlaskConical size={16} /><span><strong>本地模拟</strong><small>周五摸鱼群 · 不外发</small></span></button><button aria-label={`QQ 限定测试群 ${QQ_GROUP_ID}`} aria-pressed={isQQ} className={isQQ ? 'active' : ''} onClick={() => setRoom('qq')}><MessagesSquare size={16} /><span><strong>QQ 限定测试群</strong><small>{QQ_GROUP_ID}</small></span><span className={`status-dot ${state?.qq?.ready ? 'green' : 'amber'}`} /></button></div>
      <div className="sidebar-note"><Leaf size={19} /><p>不是每句话都需要回复。<br />让她有一点自己的节奏。</p><div className="note-line" /></div>
      <div className="sidebar-bottom"><div className="local-chip"><span className={`status-dot ${model?.loraVerified ? 'green' : 'amber'}`} /><span>{model?.loraVerified ? 'source31 已连接' : '本地模型待就绪'}</span><ArrowUpRight size={13} /></div><div className="model-meta"><span>QWEN3 · 8B · LoRA</span><span>{model?.contextSize || '—'} CTX</span></div><div className="local-only"><ShieldCheck size={13} />运行于本机 <span>127.0.0.1</span></div></div>
    </aside>

    <div className="main-shell">
      <div className="topbar"><div><FlaskConical size={15} /><span>Workspace</span><ChevronRight size={13} /><strong>{({ lab: '群聊实验室', history: '心跳记录', settings: '连接与参数', model: '推理观察' })[page]}</strong></div><div><span className={`status-dot ${connected ? 'green' : 'amber'}`} /><span>{connected ? '观察连接正常' : '正在重新连接…'}</span><span className="top-divider" /><span className="workspace-avatar">G</span></div></div>
      <main>
        <header className="page-heading"><div><div className="eyebrow">A LITTLE ROOM FOR NIKO <span>✳</span></div><h1>{({ lab: '群聊实验室', history: '每一轮，都看得见', settings: '把节奏调成你喜欢的样子', model: '给小模型，一点余地' })[page]}</h1><p>{({ lab: '给她一个话题，也给她保持沉默的自由。', history: '从消息快照到最终发言，追踪每次判断的来龙去脉。', settings: '连接留在后端，阈值留在代码能解释的范围里。', model: '复用原版 source31，记录真实上下文与推理表现。' })[page]}</p></div><div className="heading-actions"><a className="button subtle" href={"/api/export?room=" + room} download><ArrowDownToLine size={15} />导出记录</a>{!isQQ && <Button className="subtle" onClick={() => setConfirmReset(true)}><Plus size={15} />新建实验</Button>}</div></header>
        {!connected && <div className="notice warning"><CircleAlert size={16} />后端连接暂时中断，正在自动重连。未发送的输入仍保留在页面中。</div>}
        {state?.storageError && <div className="notice warning"><CircleAlert size={16} />{state.storageError}</div>}

        {page === 'lab' && <>
          {isQQ && <div className={`notice ${state?.qq?.ready ? 'setup' : 'warning'}`}><ShieldCheck size={16} /><span>{state?.qq?.detail || '正在检查 QQ 连接…'}{state?.qq?.selfId && ` · 机器人 ${state.qq.selfId}`}</span></div>}
          <div className="session-toolbar"><div className="session-status"><span className={`status-dot ${state?.paused ? 'gray' : 'green pulse'}`} /><strong>{state?.busy ? '正在处理' : state?.paused ? '心跳已暂停' : '随机心跳运行中'}</strong><span className="toolbar-divider" /><span><Clock3 size={14} />{state?.settings.heartbeatMin || 5}–{state?.settings.heartbeatMax || 12}s</span>{countdown !== null && <span className="next-beat">下一次 {countdown}s</span>}{pending > 0 && <Badge tone="green">{pending} 条待处理</Badge>}</div><div className="toolbar-actions"><Button className="subtle compact" disabled={state?.busy} onClick={async () => { setSelectedId(undefined); const result = await action('tick'); if (result && !pending) setToast('没有新的群友消息，本轮已跳过'); }}><Radio size={15} />单步心跳</Button><Button className={state?.paused ? 'primary compact' : 'compact'} disabled={!state} onClick={() => action('pause', { paused: !state?.paused })}>{state?.paused ? <Play size={14} fill="currentColor" /> : <Pause size={14} />}{state?.paused ? '开始观察' : '暂停心跳'}</Button></div></div>
          {!state?.services.jevConfigured && <div className="notice setup"><span className="notice-icon"><Terminal size={15} /></span><span>还差一个 Jev 连接。填写 <code>.env</code> 后即可真实试聊，也可以先体验演示回放。</span><button onClick={() => setPage('settings')}>配置连接<ArrowUpRight size={13} /></button></div>}
          <div className="lab-grid">
            <section className="chat-panel" aria-label={isQQ ? "QQ 限定群聊" : "模拟群聊"}>
              <div className="room-heading"><div className="room-heading-main"><div className="room-hash">#</div><div><h2>{isQQ ? state?.qq?.groupName || "QQ 测试群" : "周五摸鱼群"} <Badge tone={isQQ ? "green" : ""}>{isQQ ? "QQ 实时" : "模拟会话"}</Badge></h2><p>{isQQ ? `${QQ_GROUP_ID} · 只在这个群收发` : "3 位群友，还有喵酱"}</p></div></div><div className="avatar-stack">{!isQQ && SPEAKERS.map(s => <Avatar key={s.id} id={s.id} small />)}<Avatar id={BOT_ID} small /></div></div>
              <div ref={chatViewport} className="chat-scroll" role="log" aria-live="polite" aria-label="聊天记录">
                <div className="day-marker"><span />今天 · {isQQ ? "QQ 实时记录" : "本地模拟"}<span /></div>
                {!state?.messages.length && <div className="chat-empty"><div className="cat-illustration"><span className="little-star one">✳</span><img src="/niko.svg" alt="等待聊天的喵酱" /><span className="little-star two">✧</span><span className="sleepy">z z</span></div><h2>{isQQ ? "等群里的一句话" : "今天，想聊点什么？"}</h2><p>{isQQ ? "在手机 QQ 的限定群发言，这里会显示真实消息。" : "切换群友，发几条消息。"}<br />喵酱会按自己的节奏，决定要不要接话。</p>{!isQQ && <button className="starter-chip" onClick={() => { setText('终于下班了，今晚吃什么？'); composer.current?.focus(); }}>从“今晚吃什么”开始 <ArrowUpRight size={13} /></button>}</div>}
                {state?.messages.map(message => {
                  const bot = message.speakerId === BOT_ID;
                  const quoted = state.messages.find(m => m.id === message.replyTo);
                  return <div key={message.id} className={`chat-message ${bot ? 'bot-message' : ''}`}><Avatar id={message.speakerId} name={message.speakerName} /><div className="message-body"><div className="message-heading"><strong>{message.speakerName}</strong>{bot && <span className="bot-label">BOT</span>}<time>{time(message.at)}</time><span className="message-id">#{message.id}</span>{message.sample && <span className="sample-label">演示</span>}</div><div className="message-bubble">{quoted && <div className="quoted-message"><Reply size={12} />{quoted.speakerName}：{quoted.text.slice(0, 90)}</div>}{message.mentions.includes(BOT_ID) && <span className="mention-inline">@喵酱 </span>}{message.text}</div>{bot && <div className="message-delivered"><CheckCheck size={12} />{message.sample ? '预录回复 · 未调用模型' : message.qq ? 'source31 · QQ 已确认送达' : 'source31 · 本地生成'}</div>}</div>{!isQQ && <button className="reply-action" aria-label={`回复${message.speakerName}的消息`} title="回复这条消息" onClick={() => { setReplyTo(message); composer.current?.focus(); }}><Reply size={15} /></button>}</div>;
                })}
                {state?.busy && <div className="thinking-row"><Avatar id={BOT_ID} small /><span className="thinking-dots"><i /><i /><i /></span><span>{latest?.phase}…</span>{latest?.mode === 'replay' && <Badge>演示回放</Badge>}</div>}
              </div>
              {!isQQ ? <div className="composer-area">
                <div className="speaker-row"><span>现在作为</span><div className="speaker-picker" role="group" aria-label="切换模拟发言人">{SPEAKERS.map(s => <button key={s.id} className={speaker === s.id ? 'selected' : ''} onClick={() => setSpeaker(s.id)}><Avatar id={s.id} small />{s.name}{speaker === s.id && <Check size={12} />}</button>)}</div><span className="composer-hint">模拟群成员</span></div>
                <div className="composer-box">
                  {replyTo && <div className="reply-preview"><Reply size={13} /><span>回复 {replyTo.speakerName}：{replyTo.text.slice(0, 60)}</span><button aria-label="取消回复" onClick={() => setReplyTo(undefined)}><X size={13} /></button></div>}
                  <textarea ref={composer} aria-label="群聊消息" value={text} maxLength={2000} onChange={e => setText(e.target.value)} placeholder="说点什么，让话题自然发生…" rows={2} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
                  <div className="composer-bottom"><button className={`mention-toggle ${mention ? 'selected' : ''}`} onClick={() => setMention(!mention)} aria-pressed={mention}><AtSign size={15} />喵酱{mention && <Check size={12} />}</button><span>Enter 发送 <kbd>⇧</kbd> 换行</span><button className="send-button" disabled={!text.trim() || sending} aria-label="发送消息" onClick={() => void send()}>{sending ? <LoaderCircle className="spin" size={18} /> : <ArrowUp size={19} />}</button></div>
                </div>
                <div className="replay-entry"><FlaskConical size={13} /><span>想先看看她的节奏？</span><button onClick={() => setShowScenarios(true)}>体验演示回放 <ChevronRight size={13} /></button></div>
              </div> : <div className="qq-readonly"><ShieldCheck size={16} /><div><strong>仅在 QQ 群 {QQ_GROUP_ID} 内测试</strong><p>请在手机 QQ 发言。网页只观察真实群聊；暂停心跳会取消本轮尚未发送的回复。</p></div></div>}
            </section>
            <Inspector run={selected} runs={state?.runs || []} now={now} contextSize={model?.contextSize || 0} select={setSelectedId} retry={id => { setSelectedId(undefined); void action('tick', { retry: id }); }} />
          </div>
          <div className="workspace-footnote"><ShieldCheck size={12} />{isQQ ? `仅收发 QQ 群 ${QQ_GROUP_ID}，其他群和私聊均忽略。` : "仅本地模拟，不向真实群发送消息。"}<span>Jev 判断时会发送这轮群聊片段；Exa 只接收搜索词。</span><span className="footnote-right">MADE FOR SMALL MOMENTS <Leaf size={12} /></span></div>
        </>}
        {page === 'history' && <section className="history-panel"><div className="section-title"><div><History size={18} /><h2>心跳轨迹</h2><Badge>{state?.runs.length || 0} 轮</Badge></div><span>失败不会无限重试，沉默也会被记录</span></div>{!state?.runs.length ? <EmptyTrace /> : <div className="run-table"><div className="run-table-header"><span>开始时间 / 运行</span><span>焦点消息</span><span>接话概率</span><span>结果</span><span>耗时</span></div>{state?.runs.slice().reverse().map(run => <button className="run-table-row" key={run.id} onClick={() => { setSelectedId(run.id); setPage('lab'); }}><span><strong>{time(run.startedAt)}</strong><small>{run.mode === 'replay' ? '演示回放' : run.trigger === 'heartbeat' ? '随机心跳' : run.trigger === 'retry' ? '手动重试' : '单步心跳'} · {run.id.slice(0, 6)}</small></span><span className="table-focus"><b>{run.snapshot.focus.speakerName}</b>{run.snapshot.focus.text}</span><span className="mono">{run.probabilities ? `${(run.replyDecision?.probability ?? run.probabilities.should_reply).toFixed(3)}${run.replyDecision?.source === 'mention' ? ' · @' : ''}` : '—'}</span><span><RunBadge run={run} /></span><span className="mono">{duration(elapsed(run, now))}<ChevronRight size={14} /></span></button>)}</div>}</section>}
        {page === 'settings' && <SettingsPage state={state} action={action} toast={setToast} />}
        {page === 'model' && <ModelPage state={state} action={action} />}
      </main>
    </div>
    {toast && <div className="toast" role="status"><CircleAlert size={16} /><span>{toast}</span><button aria-label="关闭提示" onClick={() => setToast('')}><X size={14} /></button></div>}
    {(confirmReset || showScenarios) && <div className="modal-backdrop" onClick={() => { setConfirmReset(false); setShowScenarios(false); }}><section ref={dialog} className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" onClick={e => e.stopPropagation()}><button className="modal-close" aria-label="关闭弹窗" onClick={() => { setConfirmReset(false); setShowScenarios(false); }}><X size={18} /></button>{confirmReset ? <><div className="modal-symbol"><Plus size={23} /></div><h2 id="modal-title">给话题一个新的开始</h2><p>这会暂停心跳、取消当前任务，并清空本实验的消息和轨迹。连接配置和模型文件会保留。</p><div className="modal-actions"><a className="button" href={"/api/export?room=" + room} download>先导出记录</a><Button className="primary" onClick={async () => { await action('reset'); setSelectedId(undefined); setReplyTo(undefined); setConfirmReset(false); }}>新建实验</Button></div></> : <><div className="modal-symbol"><FlaskConical size={23} /></div><h2 id="modal-title">先感受一下，她的节奏</h2><p>以下是明确标注的固定演示数据，不调用 Jev、Exa 或本地模型。示例会追加到当前聊天，心跳将暂停。</p><div className="scenario-list">{scenarios.map((scenario, i) => <button key={scenario.id} disabled={state?.busy} onClick={async () => { setSelectedId(undefined); const result = await action('replay', { id: scenario.id }); if (result) { setShowScenarios(false); setPage('lab'); } }}><span className="scenario-number">0{i + 1}</span><span><strong>{scenario.name}</strong><small>{scenario.description}</small></span><ArrowUpRight size={16} /></button>)}</div></>}</section></div>}
  </div>;
}

function RunBadge({ run }: { run: Run }) { return <Badge tone={run.status === 'replied' ? 'green' : run.status === 'error' ? 'amber' : ''}>{run.status === 'running' ? <><LoaderCircle size={11} className="spin" />处理中</> : run.status === 'replied' ? '已接话' : run.status === 'silent' ? '保持沉默' : run.status === 'error' ? '未完成' : '已取消'}</Badge>; }

function Inspector({ run, runs, now, contextSize, select, retry }: { run?: Run; runs: Run[]; now: number; contextSize: number; select: (id: string | undefined) => void; retry: (id: string) => void }) {
  const [detail, setDetail] = useState('snapshot');
  const [expanded, setExpanded] = useState(false);
  const configs = [
    ['should_reply', '应该接话', MessageCircle, '这句话，适合她接吗？'],
    ['needs_web', '需要联网', Search, '回应是否依赖外部资料？'],
    ['needs_memory', '需要回忆', Database, '是否缺少更早的聊天？'],
  ] as const;
  return <aside className="inspector" aria-label="心跳观察面板"><div className="inspector-heading"><div><Activity size={17} /><h2>心跳观察</h2></div><Badge tone={run?.mode === 'replay' ? 'amber' : 'green'}>{run?.mode === 'replay' ? '演示回放' : 'LIVE TRACE'}</Badge></div><div className="inspector-scroll">
    <TextureCard className="heartbeat-card"><TextureCardContent className="heartbeat-content"><div className="heartbeat-top"><span className="heartbeat-icon"><HeartPulse size={20} /></span><div><span className="micro-label">CURRENT HEARTBEAT</span><strong>{run ? run.phase : '等待第一次心跳'}</strong></div><span className="heartbeat-index">{run ? `#${String(runs.indexOf(run) + 1).padStart(3, '0')}` : '#000'}</span></div><svg className={`heartbeat-line ${run?.status === 'running' ? 'running' : ''}`} viewBox="0 0 300 42" aria-hidden="true"><path className="flat-line" d="M0 24H300" /><path d="M0 24H62L70 19L76 29L83 24H111L122 24L130 7L139 37L148 15L154 24H199L206 20L213 26L219 24H300" /></svg><div className="heartbeat-bottom"><span>{run ? `${run.snapshot.newMessages.length} 条新消息 · 快照序号 #${run.snapshot.through}` : '没有新群友消息时，会安静跳过'}</span><span>{run ? duration(elapsed(run, now)) : '—'}</span></div></TextureCardContent></TextureCard>
    {!run ? <EmptyTrace /> : <>
      <div className="focus-message"><span className="micro-label">本轮回应焦点 <code>#{run.snapshot.focus.id}</code></span><p><strong>{run.snapshot.focus.speakerName}</strong> {run.snapshot.focus.text}</p></div>
      <div className="inspector-section-label"><span>三个独立判断</span><span>JEV · NOUL</span></div>
      <div className="probabilities">{configs.map(([key, label, Icon, hint]) => {
        const raw = run.probabilities?.[key], p = key === 'should_reply' ? run.replyDecision?.probability ?? raw : raw, threshold = run.settings.thresholds[key], pass = p !== undefined && p >= threshold;
        return <div className={`probability ${pass ? 'passed' : ''}`} key={key}><div className="probability-title"><span className="probability-icon"><Icon size={15} /></span><div><strong>{label}</strong><small>{hint}</small></div><span className="probability-value">{p !== undefined ? `${(p * 100).toFixed(1)}%` : '—'}</span></div><div className="probability-bar"><span style={{ width: `${(p || 0) * 100}%` }} /><i style={{ left: `${threshold * 100}%` }} title={`阈值 ${threshold}`} /></div><div className="probability-meta"><code>{key}</code><span>阈值 ≥ {threshold.toFixed(2)}{p !== undefined && (pass ? ' · 通过' : ' · 未通过')}</span></div></div>;
      })}</div>
      {run.replyDecision?.source === 'mention' && <p className="probability-note">明确 @喵酱：程序按 100% 接话。Jev 原始 should_reply 为 {((run.probabilities?.should_reply || 0) * 100).toFixed(1)}%。</p>}
      <p className="probability-note">Jev 原始概率仍被保留；程序的 @ 规则和概率值都不代表实际准确率。</p>
      <div className="inspector-section-label"><span>这一轮发生了什么</span><span>EXECUTION</span></div>
      <ol className="steps">{run.steps.map((step, index) => <li className={`step ${step.status}`} key={index}><span className="step-symbol">{step.status === 'running' ? <LoaderCircle className="spin" size={13} /> : step.status === 'done' ? <Check size={12} /> : step.status === 'error' ? <X size={12} /> : <span>−</span>}</span><div><strong>{step.name}</strong>{step.detail && <p>{step.detail}</p>}</div><span className="step-time">{step.ms !== undefined ? duration(step.ms) : step.status === 'skipped' ? '跳过' : '进行中'}</span></li>)}</ol>
      {run.delivery && <div className="query-card"><span><ShieldCheck size={12} />QQ 送达回执</span><p>限定群 {run.delivery.groupId}{run.delivery.messageId && ` · 消息 ${run.delivery.messageId}`}</p><small>{run.delivery.status === 'sent' ? 'NapCat 已确认送达' : run.delivery.status === 'sending' ? '正在等待发送回执' : '送达状态未确认，请在 QQ 核对；不会重发'}</small></div>}
      {run.query && <div className="query-card"><span><Search size={12} />发送给 Exa 的搜索词</span><p>{run.query}</p>{run.search?.map((result, i) => <a key={result.url} href={result.url} target="_blank" rel="noreferrer"><span>[{i + 1}] {result.title}</span><ArrowUpRight size={12} /></a>)}</div>}
      {run.prompt && <div className="token-card"><div><span><Code2 size={14} />上下文占用</span><strong>{run.prompt.tokens.toLocaleString()} <small>/ {contextSize || '—'}</small></strong></div><div className="token-meter"><i style={{ width: `${Math.min(100, run.prompt.tokens / (contextSize || 4096) * 100)}%` }} /></div><p>网页摘要 {run.prompt.searchTokens} / {run.settings.searchTokenBudget} token <span>裁剪 {run.prompt.trimmed} 项</span></p>{run.tokenUsage && <p>输出 {run.tokenUsage.completion} token <span>{run.tokenUsage.perSecond?.toFixed(1) || '—'} token/s</span></p>}</div>}
      {run.error && <div className="run-error"><CircleAlert size={15} /><div><strong>本轮已停止，不会自动循环重试</strong><p>{run.error}</p>{run.delivery ? <p>已尝试向 QQ 发送。请先在群里核对；为避免重复发送，这轮不提供重试。</p> : <Button className="compact" onClick={() => retry(run.id)}><RotateCcw size={12} />重试这份快照</Button>}</div></div>}
      <button className="details-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><FileText size={14} />查看原始轨迹<ChevronDown size={14} className={expanded ? 'rotate' : ''} /></button>
      {expanded && <div className="raw-details"><div className="detail-tabs">{[['snapshot', '消息快照'], ['jev', 'Jev 原始值'], ['prompt', '模型输入']].map(([key, title]) => <button key={key} className={detail === key ? 'selected' : ''} onClick={() => setDetail(key)}>{title}</button>)}</div><pre>{JSON.stringify(detail === 'snapshot' ? run.snapshot : detail === 'jev' ? run.jevRaw || '尚未返回' : run.prompt || (run.mode === 'replay' ? '演示回放不构造模型请求' : '未调用生成器'), null, 2)}</pre></div>}
    </>}
    {runs.length > 0 && <div className="recent-runs"><div className="inspector-section-label"><span>最近心跳</span><button onClick={() => select(undefined)}>回到最新<ChevronRight size={11} /></button></div>{runs.slice(-4).reverse().map(r => <button className={run?.id === r.id ? 'selected' : ''} key={r.id} onClick={() => select(r.id)}><span className={`trace-dot ${r.status}`} /><span>{time(r.startedAt)}<small>{r.snapshot.newMessages.length} 条新消息{r.mode === 'replay' ? ' · 回放' : ''}</small></span><RunBadge run={r} /></button>)}</div>}
    </div><div className="inspector-footer"><span className="status-dot green" />固定快照 · 单任务处理 · 保留原始概率</div></aside>;
}

function SettingsPage({ state, action, toast }: { state?: PublicState; action: (path: string, data?: unknown) => Promise<any>; toast: (text: string) => void }) {
  const [draft, setDraft] = useState<Settings>(structuredClone(DEFAULT_SETTINGS));
  const settingsKey = JSON.stringify(state?.settings);
  useEffect(() => { if (state?.settings) setDraft(structuredClone(state.settings)); }, [settingsKey]);
  const number = (key: keyof Omit<Settings, 'thresholds' | 'jevModel'>, title: string, min: number, max: number, suffix: string) => <label className="number-field"><span>{title}</span><div><input aria-label={title} type="number" min={min} max={max} value={draft[key]} onChange={e => setDraft({ ...draft, [key]: Number(e.target.value) })} /><small>{suffix}</small></div></label>;
  return <div className="settings-layout"><section className="settings-main"><div className="settings-section"><div className="settings-title"><span className="settings-icon"><HeartPulse size={20} /></span><div><h2>给心跳一点随机</h2><p>每轮结束后重新抽取间隔，处理期间不积压任务。</p></div></div><div className="number-grid">{number('heartbeatMin', '间隔下限', 1, 120, '秒')}{number('heartbeatMax', '间隔上限', 1, 120, '秒')}</div><div className="range-illustration"><span>等待</span><i /><span className="beat-dot" /><b>{draft.heartbeatMin}–{draft.heartbeatMax}s</b><span className="beat-dot" /><i /><span>再看一眼</span></div></div>
    <div className="settings-section"><div className="settings-title"><span className="settings-icon"><Settings2 size={20} /></span><div><h2>判断阈值</h2><p>三个问题独立判断，仅接话通过后才执行其他分支。</p></div></div>{([['should_reply', '适合接话'], ['needs_web', '需要联网'], ['needs_memory', '需要历史记忆']] as const).map(([key, label]) => <label className="slider-field" key={key}><div><span>{label}<code>{key}</code></span><strong>{draft.thresholds[key].toFixed(2)}</strong></div><input aria-label={label + '阈值'} type="range" min="0" max="1" step="0.01" value={draft.thresholds[key]} onChange={e => setDraft({ ...draft, thresholds: { ...draft.thresholds, [key]: Number(e.target.value) } })} /><small>更容易触发<span>更保守</span></small></label>)}<div className="inline-note"><CircleAlert size={13} />阈值是控制参数；默认值未经过群聊准确率校准。</div></div>
    <div className="settings-section"><div className="settings-title"><span className="settings-icon"><Search size={20} /></span><div><h2>给搜索留一小块空间</h2><p>仅取 Exa highlights，裁剪后再次使用模型自己的 tokenizer 计数。</p></div></div><div className="number-grid">{number('searchResults', '最多搜索结果', 1, 5, '条')}{number('searchSnippetChars', '每条摘要上限', 400, 1000, '字符')}{number('searchTokenBudget', '摘要总 token 预算', 150, 1000, 'token')}{number('historyCount', '近期历史窗口', 2, 30, '条')}</div><div className="memory-disabled"><Database size={17} /><div><strong>历史记忆暂未启用</strong><p>保留检索接口；不会编造已取回的旧聊天。</p></div><Badge>OFF</Badge></div></div>
    <div className="settings-save"><span>修改从下一轮心跳生效。</span><Button className="primary" onClick={async () => { if (await action('settings', draft)) toast('参数已保存，将用于下一轮心跳'); }}><Check size={15} />保存参数</Button></div>
    </section><aside className="settings-aside"><TextureCard className="connection-card"><TextureCardContent><div className="card-kicker"><ShieldCheck size={16} />连接留在本机后端</div><h3>两把钥匙，就可以开始</h3><p>在下面的文件里填写 API 密钥。浏览器只接收配置状态，不会收到密钥。</p><div className="env-path"><FileText size={15} /><code>niko_harness/.env</code><button aria-label="复制 .env 路径" onClick={() => { void navigator.clipboard.writeText('/Users/admin/Desktop/Qwen3-8B-source31/niko_harness/.env'); toast('已复制 .env 路径'); }}><Copy size={14} /></button></div><div className="connection-item"><span className={`status-dot ${state?.services.jevConfigured ? 'green' : 'amber'}`} /><div><strong>TypeSafe · Jev</strong><code>TYPESAFE_API_KEY</code></div><Badge tone={state?.services.jevConfigured ? 'green' : 'amber'}>{state?.services.jevConfigured ? '已配置' : '待填写'}</Badge></div><div className="connection-item"><span className={`status-dot ${state?.services.exaConfigured ? 'green' : 'amber'}`} /><div><strong>Exa Search</strong><code>EXA_API_KEY</code></div><Badge tone={state?.services.exaConfigured ? 'green' : 'amber'}>{state?.services.exaConfigured ? '已配置' : '待填写'}</Badge></div><Button className="full" onClick={async () => { if (await action('reload-env')) toast('已重新读取本地 .env'); }} disabled={state?.busy}><RotateCcw size={14} />重新读取 .env</Button><p className="tiny-note">保存文件后点这里，无需重启页面。未配置搜索时，会显示“搜索未配置”。</p></TextureCardContent></TextureCard><div className="privacy-note"><Leaf size={20} /><h3>数据去向很简单</h3><p>Jev 接收本轮聊天片段与人设。Exa 接收清理过的搜索词。喵酱权重与最终文本生成都留在本机。</p><a href="https://docs.typesafe.ai/primitives/noul" target="_blank" rel="noreferrer">阅读 Noul 官方说明<ArrowUpRight size={13} /></a></div></aside></div>;
}

function ModelPage({ state, action }: { state?: PublicState; action: (path: string, data?: unknown) => Promise<any> }) {
  const [report, setReport] = useState<any>();
  const [starting, setStarting] = useState(false);
  useEffect(() => { api('model-report').then(setReport).catch(() => {}); }, []);
  const model = state?.services.model;
  const rows = report?.benchmark || [];
  return <div className="model-layout"><TextureCard className="model-hero"><TextureCardContent><div className="model-hero-top"><img src="/niko.svg" alt="" /><div><div className="micro-label">THE VOICE OF NIKO</div><h2>Qwen3-8B <span>source31</span></h2><p>原版 source31 LoRA · Q8_0 · llama.cpp / Metal</p></div><Badge tone={model?.loraVerified ? 'green' : 'amber'}>{model?.loraVerified ? 'LoRA 已核验' : '服务待就绪'}</Badge></div><div className="model-stats"><div><span>实际上下文</span><strong>{model?.contextSize?.toLocaleString() || '—'}<small>token</small></strong></div><div><span>LoRA 强度</span><strong>{model?.loraVerified ? '1.0' : '—'}<small>source31</small></strong></div><div><span>生成设置</span><strong>0.7<small>temperature</small></strong></div><div><span>并行任务</span><strong>1<small>固定快照</small></strong></div></div><div className="model-status-detail"><ShieldCheck size={15} /><span>{model?.detail || '正在检查…'}</span>{!model?.available && <Button className="compact" disabled={starting} onClick={async () => { setStarting(true); await action('model/start'); setStarting(false); }}>{starting ? <LoaderCircle size={13} className="spin" /> : <Play size={13} />}启动已有模型</Button>}</div></TextureCardContent></TextureCard>
    <div className="model-research-grid"><section className="research-card"><span className="research-icon"><Zap size={21} /></span><Badge tone="green">已实测</Badge><h3>4096，可以运行</h3><p>独立启动入口采用 4096 上下文、Q8 KV 缓存和 128 / 64 batch。复用现有底模和 LoRA，没有覆盖父目录设置。</p><p className="research-caveat">测试期间仍出现内存 warning。可运行不等于内存宽裕，长对话需继续观察。</p></section><section className="research-card"><span className="research-icon"><Code2 size={21} /></span><Badge>研究结论</Badge><h3>MTP 不是一个开关</h3><p>现有 Qwen3-8B 文件没有 MTP 预测头，无法只加参数启用。外部 draft 需要额外权重，还需验证与 source31 的适配。</p><p className="research-caveat">未下载其他模型；n-gram 无需额外权重，但本次小样本没有显示稳定收益，默认关闭。</p></section></div>
    {report?.localSmoke && <div className="notice warning"><CircleAlert size={16} /><span>长上下文压力测试：输入 {report.localSmoke.inputTokens} token，网页资料裁至 {report.localSmoke.searchTokens} token，生成约 {report.localSmoke.perSecond?.toFixed(1)} token/s。使用合成聊天与固定参考资料，未调用 Jev / Exa。长输入比上面的短回复测试慢。</span></div>}
    <section className="benchmark-panel"><div className="section-title"><div><Activity size={17} /><h2>这台 Mac 上的观测</h2></div><Badge>真实本地生成</Badge></div><p className="benchmark-note">同一输入、同一种子、LoRA 1.0。每个配置仅两次短回复；用于观察，不是全面性能评测。</p><div className="benchmark-table"><div className="benchmark-row header"><span>配置</span><span>前缀</span><span>生成速度</span><span>整轮耗时</span><span>输出</span></div>{rows.map((row: any, i: number) => <div className="benchmark-row" key={i}><span>{row.profile === '4096-f16-small-batch' ? 'F16 KV · batch 32' : row.profile === '4096-q8-batch128' ? 'Q8 KV · batch 128' : 'Q8 KV · n-gram'}</span><span>{row.warm_prefix ? '已缓存' : '首次'}</span><strong>{row.timings?.predicted_per_second?.toFixed(1)} <small>tok/s</small></strong><span>{row.wall_seconds?.toFixed(2)} s</span><span>{row.usage?.completion_tokens} token</span></div>)}</div>{!rows.length && <p className="muted">尚未读取到实测报告。</p>}</section>
    <div className="model-footer"><FileText size={15} /><span>完整记录：<code>reports/inference-benchmark.json</code></span><a href="https://github.com/ggml-org/llama.cpp/blob/e0f142d5ddc1461ce721644d92af33db23545105/docs/speculative.md" target="_blank" rel="noreferrer">推测解码说明<ExternalLink size={13} /></a></div>
  </div>;
}
