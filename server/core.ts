import { randomUUID } from 'node:crypto';
import { BOT_ID, BOT_NAME, DEFAULT_SETTINGS, EMPTY_MODEL, NO_REPLY, SPEAKERS } from '../shared.ts';
import type { Message, ModelStatus, PublicState, Run, Settings, Snapshot, State, Step } from '../shared.ts';
import type { Providers } from './providers.ts';
import { retrieveMemory } from './providers.ts';
import { expireRuns, repeatsReply } from './context.ts';

export function initialState(): State {
  return { messages: [], runs: [], cursor: 0, nextSeq: 1, paused: true, settings: structuredClone(DEFAULT_SETTINGS) };
}

export function validateSettings(input: unknown): Settings {
  const s = input as Settings;
  const number = (v: unknown, min: number, max: number, label: string, integer = false) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) throw new Error(`${label} 必须介于 ${min}–${max}${integer ? '，且为整数' : ''}`);
    return v;
  };
  if (!s || typeof s !== 'object') throw new Error('设置格式不正确');
  const heartbeatMin = number(s.heartbeatMin, 1, 120, '心跳下限');
  const heartbeatMax = number(s.heartbeatMax, 1, 120, '心跳上限');
  if (heartbeatMax < heartbeatMin) throw new Error('心跳上限不能小于下限');
  const sampling = { ...DEFAULT_SETTINGS.sampling, ...s.sampling };
  const mockSpeakers = s.mockSpeakers || DEFAULT_SETTINGS.mockSpeakers;
  if (!Array.isArray(mockSpeakers) || !mockSpeakers.length || mockSpeakers.length > 10 || new Set(mockSpeakers.map(s => s?.id)).size !== mockSpeakers.length || mockSpeakers.some(s => !s || typeof s.id !== 'string' || s.id === BOT_ID || !/^[\w-]{1,64}$/.test(s.id) || typeof s.name !== 'string' || !s.name.trim() || s.name.length > 40)) throw new Error('Mock 群友需为 1–10 位，名字不超过 40 字，身份不能重复或冒充喵酱');
  return {
    heartbeatMin, heartbeatMax,
    thresholds: {
      should_reply: number(s.thresholds?.should_reply, 0, 1, '接话阈值'),
      needs_web: number(s.thresholds?.needs_web, 0, 1, '搜索阈值'),
      needs_memory: number(s.thresholds?.needs_memory, 0, 1, '记忆阈值'),
    },
    searchResults: number(s.searchResults, 1, 5, '搜索条数', true),
    searchSnippetChars: number(s.searchSnippetChars, 400, 1000, '每条摘要长度', true),
    searchTokenBudget: number(s.searchTokenBudget, 150, 1000, '搜索 token 预算', true),
    jevModel: typeof s.jevModel === 'string' && /^[\w./-]{1,100}$/.test(s.jevModel) ? s.jevModel : 'jev-latest',
    sampling: {
      temperature: number(sampling.temperature, 0.1, 1.5, '温度'), top_p: number(sampling.top_p, 0.05, 1, 'Top P'),
      top_k: number(sampling.top_k, 0, 200, 'Top K', true), min_p: number(sampling.min_p, 0, 1, 'Min P'),
      repeat_penalty: number(sampling.repeat_penalty, 1, 1.5, '重复惩罚'), repeat_last_n: number(sampling.repeat_last_n, 0, 2048, '惩罚窗口', true),
      presence_penalty: number(sampling.presence_penalty, 0, 2, 'Presence penalty'), frequency_penalty: number(sampling.frequency_penalty, 0, 2, 'Frequency penalty'),
      max_tokens: number(sampling.max_tokens, 16, 512, '最大输出 token', true),
    },
    mockSpeakers: mockSpeakers.map(s => ({ id: s.id, name: s.name.trim() })),
  };
}

function mentionsBot(message: Message): boolean {
  return message.mentions.includes(BOT_ID) || /(?:^|\s)@喵酱(?=$|[\s，。！？、,:：.!?])/u.test(message.text);
}

export function takeSnapshot(state: State): Snapshot | null {
  const newMessages = state.messages.filter(m => m.seq > state.cursor && m.speakerId !== BOT_ID);
  if (!newMessages.length) return null;
  const focus = newMessages.findLast(mentionsBot)
    || newMessages.findLast(m => state.messages.find(r => r.id === m.replyTo)?.speakerId === BOT_ID)
    || newMessages[newMessages.length - 1];
  const messages = state.messages;
  return structuredClone({ messages, newMessages, focus, through: newMessages[newMessages.length - 1].seq });
}

export function isNoReply(text: string): boolean { return !text.trim() || text.trim() === NO_REPLY; }

export function retryableRun(state: State, id: string): Run {
  const run = state.runs.find(r => r.id === id);
  if (!run || run.status !== 'error' || run.mode !== 'live') throw new Error('只能手动重试失败的真实运行');
  if (run.expired) throw new Error('这份快照的原文已移出 2048 滚动窗口，不能重试');
  if (run.delivery) throw new Error('已尝试向 QQ 发出消息，请先在群里核对；为避免重复发送，不能重试这轮');
  const root = run.retriedFrom || run.id;
  if (state.runs.some(r => (r.id === root || r.retriedFrom === root) && ['replied', 'silent'].includes(r.status))) throw new Error('这份快照已经完成，不能重复回复');
  return run;
}

export class Harness {
  state: State;
  providers: Providers;
  onChange: () => void | Promise<void>;
  busy = false;
  nextHeartbeatAt: string | null = null;
  model: ModelStatus = { ...EMPTY_MODEL };
  storageError?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private epoch = 0;
  private compactQueue = Promise.resolve();
  private deliver?: (message: Message, run: Run, signal: AbortSignal) => Promise<void>;

  constructor(state: State, providers: Providers, onChange: () => void | Promise<void>, deliver?: (message: Message, run: Run, signal: AbortSignal) => Promise<void>) {
    this.state = state;
    this.providers = providers;
    this.onChange = onChange;
    this.deliver = deliver;
    this.state.paused = true;
    for (const message of state.messages) if (message.speakerId === BOT_ID) message.speakerName = BOT_NAME;
    for (const run of state.runs) {
      if (run.status === 'running') {
        if (run.delivery?.status === 'sending') run.delivery.status = 'uncertain';
        run.status = 'error';
        run.phase = '上次运行被中断，可手动重试';
        run.error = run.phase;
        run.endedAt = new Date().toISOString();
        state.cursor = Math.max(state.cursor, run.snapshot.through);
      }
    }
  }

  view(): PublicState {
    return {
      ...this.savedState(), busy: this.busy, nextHeartbeatAt: this.nextHeartbeatAt,
      services: { jevConfigured: Boolean(process.env.TYPESAFE_API_KEY), exaConfigured: this.providers.exaConfigured(), model: this.model },
      storageError: this.storageError,
    };
  }

  savedState(): State {
    const state = structuredClone(this.state);
    expireRuns(state, true);
    return state;
  }

  compactContext(): Promise<void> {
    const task = this.compactQueue.then(async () => {
      const state = this.state;
      let version: number, settings: Settings, result;
      do {
        version = state.nextSeq;
        settings = state.settings;
        result = await this.providers.window([...state.messages], AbortSignal.timeout(15_000), settings);
        if (state !== this.state) return;
      } while (version !== state.nextSeq || settings !== state.settings);
      const ids = new Set(result.messages.map(m => m.id));
      const removed = state.messages.filter(m => !ids.has(m.id));
      state.messages = result.messages;
      const expiredPrefix = removed.filter(m => m.seq < (result.messages[0]?.seq ?? Infinity));
      if (expiredPrefix.length) state.cursor = Math.max(state.cursor, ...expiredPrefix.map(m => m.seq));
      state.context = { tokens: result.tokens, budget: result.budget, exact: result.exact, discarded: (state.context?.discarded || 0) + removed.length };
      expireRuns(state);
    });
    this.compactQueue = task.catch(() => {});
    return task;
  }

  addMessage(input: { speakerId: string; text: string; replyTo?: string; mentions?: string[]; sample?: boolean }): Message {
    const speaker = this.state.settings.mockSpeakers.find(s => s.id === input.speakerId);
    if (!speaker) throw new Error('请选择一个模拟群友');
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000) throw new Error('消息需为 1–2000 个字符');
    if (input.replyTo && !this.state.messages.some(m => m.id === input.replyTo)) throw new Error('回复对象已不存在');
    if (input.mentions && (!Array.isArray(input.mentions) || input.mentions.some(id => ![BOT_ID, ...this.state.settings.mockSpeakers.map(s => s.id)].includes(id)))) throw new Error('@ 对象不正确');
    if (this.state.messages.length >= 1000) throw new Error('实验室已达到 1000 条消息，请先导出并新建实验');
    const seq = this.state.nextSeq++;
    const message: Message = { id: `m_${seq}`, seq, speakerId: speaker.id, speakerName: speaker.name, text: input.text.trim(), at: new Date().toISOString(), mentions: input.mentions || [], replyTo: input.replyTo || undefined, sample: input.sample === true };
    this.state.messages.push(message);
    this.onChange();
    return message;
  }

  receiveMessage(input: Omit<Message, 'seq'>): boolean {
    if (this.state.messages.some(m => m.id === input.id)) return false;
    if (this.state.messages.length >= 1000) {
      const index = this.state.messages.findIndex(m => m.seq <= this.state.cursor);
      if (index < 0) throw new Error('待处理 QQ 消息达到 1000 条，请先暂停并导出记录');
      this.state.messages.splice(index, 1);
    }
    this.state.messages.push({ ...input, seq: this.state.nextSeq++ });
    this.onChange();
    return true;
  }

  settings(settings: unknown) { this.state.settings = validateSettings(settings); this.onChange(); }

  pause(paused: boolean) {
    this.state.paused = paused;
    if (this.timer) clearTimeout(this.timer);
    this.nextHeartbeatAt = null;
    if (!paused && !this.busy) this.schedule();
    this.onChange();
  }

  private schedule() {
    if (this.state.paused || this.busy) return;
    if (this.timer) clearTimeout(this.timer);
    const { heartbeatMin: min, heartbeatMax: max } = this.state.settings;
    const ms = Math.round((min + Math.random() * (max - min)) * 1000);
    this.nextHeartbeatAt = new Date(Date.now() + ms).toISOString();
    this.timer = setTimeout(() => { void this.tick('heartbeat'); }, ms);
    this.onChange();
  }

  reset() {
    this.epoch++;
    this.controller?.abort(new Error('实验已重置'));
    if (this.timer) clearTimeout(this.timer);
    const settings = this.state.settings;
    this.state = { ...initialState(), settings };
    this.busy = false;
    this.nextHeartbeatAt = null;
    this.onChange();
  }

  cancelCurrent(reason = '服务正在停止') { this.controller?.abort(new Error(reason)); }

  async tick(trigger: Run['trigger'] = 'manual', options: { replay?: Providers; retry?: string } = {}): Promise<Run | null> {
    if (this.busy) throw new Error('当前心跳仍在处理，消息会留给下一轮');
    const captured = takeSnapshot(this.state);
    const capturedSettings = structuredClone(this.state.settings);
    this.busy = true;
    let previous: Run | undefined, snapshot: Snapshot | null;
    try {
      await this.compactContext();
      previous = options.retry ? retryableRun(this.state, options.retry) : undefined;
      const retained = new Set(this.state.messages.map(m => m.id));
      snapshot = previous ? structuredClone(previous.snapshot) : captured && takeSnapshot({ ...this.state, messages: captured.messages.filter(m => retained.has(m.id)) });
    } catch (error) {
      this.busy = false; this.storageError = `上下文准备失败：${(error as Error).message}`; this.schedule(); this.onChange(); throw error;
    }
    if (this.timer) clearTimeout(this.timer);
    this.nextHeartbeatAt = null;
    if (!snapshot) { this.busy = false; this.schedule(); this.onChange(); return null; }
    const epoch = this.epoch;
    const controller = new AbortController();
    this.controller = controller;
    const providers = options.replay || this.providers;
    const run: Run = {
      id: randomUUID(), mode: options.replay ? 'replay' : 'live', status: 'running', phase: '准备消息快照',
      startedAt: new Date().toISOString(), trigger, snapshot,
      settings: structuredClone(previous?.settings || capturedSettings), steps: [], retriedFrom: previous ? previous.retriedFrom || previous.id : undefined,
    };
    this.state.runs.push(run);
    this.state.runs = this.state.runs.slice(-100);
    this.busy = true;
    this.onChange();
    const current = () => { if (epoch !== this.epoch || controller.signal.aborted) throw new Error('实验已取消'); };
    const publish = () => { current(); this.onChange(); };
    const step = async <T>(name: string, task: () => Promise<T>, detail?: string): Promise<T> => {
      current();
      const row: Step = { name, status: 'running', at: new Date().toISOString(), detail };
      run.steps.push(row); run.phase = name; publish();
      const start = performance.now();
      try {
        const result = await task(); current(); row.status = 'done'; row.ms = Math.round(performance.now() - start); publish(); return result;
      } catch (error) {
        row.status = 'error'; row.ms = Math.round(performance.now() - start); row.detail = error instanceof Error ? error.message : '未知错误'; throw error;
      }
    };
    const skip = (name: string, detail: string) => { run.steps.push({ name, status: 'skipped', at: new Date().toISOString(), detail }); publish(); };
    try {
      if (previous?.probabilities) {
        run.probabilities = previous.probabilities;
        run.jevRaw = previous.jevRaw;
        skip('Jev 独立判断', '沿用这份快照已经成功取得的判断，不重复计费');
      } else {
        const judgment = await step('Jev 独立判断', () => providers.judge(snapshot, run.settings, controller.signal), run.mode === 'replay' ? '演示回放：使用固定测试数据，不调用 Jev' : '一次请求，三个独立 Noul；失败至多重试一次');
        run.probabilities = judgment.probabilities;
        run.jevRaw = judgment.raw;
      }
      run.replyDecision = mentionsBot(snapshot.focus)
        ? { probability: 1, source: 'mention' }
        : { probability: run.probabilities.should_reply, source: 'jev' };
      if (run.replyDecision.probability < run.settings.thresholds.should_reply) {
        run.status = 'silent'; run.phase = '选择沉默';
        skip('本地喵酱生成', '接话概率未达到阈值；本批消息已处理，不再重复判断');
      } else {
        if (run.probabilities.needs_web >= run.settings.thresholds.needs_web) {
          if (previous?.search) {
            run.query = previous.query; run.search = structuredClone(previous.search); run.searchStatus = previous.searchStatus;
            skip('Exa 搜索', '沿用这份快照已取得的网页资料，不重复搜索');
          }
          else if (!providers.exaConfigured()) { run.searchStatus = '搜索未配置；没有取得任何网页资料'; skip('Exa 搜索', run.searchStatus); }
          else {
            try {
              run.query = previous?.query || await step('提取最简搜索词', () => providers.query(snapshot, controller.signal), '本地 Qwen 仅提取焦点话题，程序执行搜索');
              run.search = await step('Exa 搜索', () => providers.search(run.query!, run.settings, controller.signal), `最多 ${run.settings.searchResults} 条，只取 highlights，每条 ≤${run.settings.searchSnippetChars} 字符`);
              run.searchStatus = run.search.length ? `取得 ${run.search.length} 条网页摘要；属于参考资料` : '搜索返回零条资料，不代表事实不存在';
            } catch (error) {
              current(); run.searchStatus = `搜索未成功：${error instanceof Error ? error.message : '未知错误'}；没有可靠外部资料`;
            }
          }
        } else { run.searchStatus = '本轮不需要搜索'; skip('Exa 搜索', run.searchStatus); }
        run.memoryStatus = run.probabilities.needs_memory >= run.settings.thresholds.needs_memory ? retrieveMemory().status : '本轮不需要检索历史记忆';
        skip('历史记忆', run.memoryStatus);
        const completion = await step('本地喵酱生成', () => providers.generate(snapshot, run.settings, `${run.searchStatus}。${run.memoryStatus}。`, run.search || [], controller.signal, prompt => {
          current(); run.prompt = prompt;
          if (prompt.messageIds) {
            const captured = new Set(snapshot.messages.map(m => m.id)), kept = new Set(prompt.messageIds);
            const before = this.state.messages.length;
            this.state.messages = this.state.messages.filter(m => !captured.has(m.id) || kept.has(m.id));
            if (this.state.context) this.state.context.discarded += before - this.state.messages.length;
          }
          publish();
        }), run.mode === 'replay' ? '演示回放：展示预录回复，不调用本地模型' : '校验 source31 LoRA → 原生模板计数 → 裁剪预算 → 普通文本生成');
        current();
        run.timings = completion.timings;
        run.tokenUsage = completion.usage;
        if (isNoReply(completion.text)) { run.status = 'silent'; run.phase = '喵酱选择沉默'; }
        else if (repeatsReply(completion.text, this.state.messages)) {
          run.status = 'silent'; run.phase = '拦截重复回复';
          skip('重复检查', '与最近四条自己的回复存在大段重复，已丢弃，不发送、不自动重试');
        }
        else {
          run.output = completion.text;
          const seq = this.state.nextSeq++;
          const message: Message = { id: `m_${seq}`, seq, speakerId: BOT_ID, speakerName: BOT_NAME, at: new Date().toISOString(), text: completion.text, mentions: [], replyTo: snapshot.focus.id, runId: run.id, sample: run.mode === 'replay' };
          if (this.deliver) {
            if (run.mode === 'replay') throw new Error('演示回放不能发送到 QQ');
            const row: Step = { name: '发送到限定 QQ 群', status: 'running', at: new Date().toISOString(), detail: '仅群 1104887928；等待 NapCat 返回消息 ID' };
            const start = performance.now();
            run.steps.push(row); run.phase = row.name; publish();
            try {
              current();
              run.delivery = { status: 'sending', groupId: snapshot.focus.qq?.groupId || '' };
              // Persist intent before the external effect; interrupted sends must not be retried blindly.
              await this.onChange();
              current();
              if (this.storageError) throw new Error('记录未能保存，已停止发送 QQ 消息');
              await this.deliver(message, run, controller.signal);
              row.status = 'done';
            } catch (error) {
              if (run.delivery) run.delivery.status = 'uncertain';
              row.status = 'error'; row.detail = error instanceof Error ? error.message : 'QQ 发送未确认'; throw error;
            } finally { row.ms = Math.round(performance.now() - start); }
            // Acknowledged external sends remain facts even if pause was pressed while awaiting the ACK.
            if (epoch !== this.epoch) throw new Error('实验已取消');
          }
          this.state.messages.push(message);
          run.status = 'replied'; run.phase = '回复已送达';
        }
      }
    } catch (error) {
      if (epoch === this.epoch) { run.status = 'error'; run.phase = '本轮未完成'; run.error = error instanceof Error ? error.message : '未知错误'; }
    } finally {
      if (epoch === this.epoch) {
        this.state.cursor = Math.max(this.state.cursor, snapshot.through);
        run.endedAt = new Date().toISOString();
        try { await this.compactContext(); } catch (error) { this.storageError = `上下文裁剪失败：${(error as Error).message}`; }
        this.busy = false;
        this.controller = undefined;
        this.schedule();
        this.onChange();
      }
    }
    return run;
  }
}

export const SCENARIOS = [
  { id: 'dinner', name: '今晚吃什么', description: '有人点名，喵酱自然接话', messages: [{ speakerId: 'aqing', text: '终于下班了，今晚吃什么？' }, { speakerId: 'xiaobai', text: '我投火锅一票！' }, { speakerId: 'aqing', text: '喵酱你呢？别又只想吃小鱼干。', mentions: [BOT_ID] }], probabilities: { should_reply: 0.94, needs_web: 0.03, needs_memory: 0.04 }, reply: '我投鸳鸯锅，别把猫辣没了。' },
  { id: 'silence', name: '群友互聊', description: '提到猫，不等于叫喵酱', messages: [{ speakerId: 'xiaobai', text: '阿青，你家猫今天还拆纸箱吗？', mentions: ['aqing'] }, { speakerId: 'aqing', text: '拆完了，现在睡在箱子里。' }], probabilities: { should_reply: 0.12, needs_web: 0.02, needs_memory: 0.05 }, reply: NO_REPLY },
  { id: 'search', name: '查一条资料', description: '观察查询与摘要分支，不调用 API', messages: [{ speakerId: 'yuzu', text: '喵酱，帮我查一下 Jev 的 Noul 到底返回什么？', mentions: [BOT_ID] }], probabilities: { should_reply: 0.97, needs_web: 0.92, needs_memory: 0.02 }, reply: 'Noul 返回的是“答案为是”的概率，0 到 1，没有单独的 confidence 字段。这个数也不代表我们这套群聊测试的准确率。' },
  { id: 'memory', name: '上次说的那个', description: '记忆关闭时坦诚缺少资料', messages: [{ speakerId: 'aqing', text: '喵酱，我上次跟你说的那家店叫什么来着？', mentions: [BOT_ID] }], probabilities: { should_reply: 0.96, needs_web: 0.08, needs_memory: 0.95 }, reply: '这段记录里没看到欸，你再给我一点线索？可不能随便给你编一家。' },
  { id: 'veto', name: '唤醒后仍沉默', description: '内部不回复标记不会发进聊天', messages: [{ speakerId: 'yuzu', text: '喵酱先别回，我还没说完。', mentions: [BOT_ID] }], probabilities: { should_reply: 0.76, needs_web: 0.01, needs_memory: 0.01 }, reply: NO_REPLY },
] as const;

export function replayProviders(id: string): Providers {
  const scenario = SCENARIOS.find(s => s.id === id);
  if (!scenario) throw new Error('没有这个演示回放');
  const delay = () => new Promise<void>(resolve => setTimeout(resolve, 350));
  return {
    window: async messages => ({ messages, tokens: 0, budget: 1760, exact: false }),
    exaConfigured: () => true,
    modelStatus: async () => ({ ...EMPTY_MODEL }),
    judge: async () => { await delay(); return { probabilities: { ...scenario.probabilities }, raw: { fixture: true, note: '固定演示值，并非 Jev 实测结果' } }; },
    query: async () => { await delay(); return 'TypeSafe Jev Noul response'; },
    search: async () => { await delay(); return [{ title: 'Noul · TypeSafe（回放资料，非实时搜索）', url: 'https://docs.typesafe.ai/primitives/noul', snippet: '演示摘要：Noul 返回 yes 的概率，字段为 answers.<id>.noul，没有单独的 confidence。' }]; },
    generate: async () => { await delay(); return { text: scenario.reply, timings: {}, usage: { prompt: 0, completion: 0 } }; },
  };
}
