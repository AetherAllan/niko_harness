import { randomUUID } from 'node:crypto';
import { BOT_ID, QQ_GROUP_ID } from '../shared.ts';
import type { Message, QQStatus, Run } from '../shared.ts';

const numericId = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) || typeof value === 'string' && /^-?\d{1,20}$/.test(value) ? String(value) : '';
const messageId = (id: string) => `qq_${QQ_GROUP_ID}_${id}`;

export function groupMessage(event: any, selfId: string): Omit<Message, 'seq'> | null {
  // Filter before reading or storing message contents. Private chats and every other group are out of scope.
  if (event?.post_type !== 'message' || event.message_type !== 'group' || String(event.group_id) !== QQ_GROUP_ID) return null;
  const sender = numericId(event.user_id), id = numericId(event.message_id);
  if (!selfId || String(event.self_id) !== selfId || !sender || sender === selfId || !id || !Array.isArray(event.message)) return null;
  const mentions: string[] = [];
  const text: string[] = [];
  let replyTo: string | undefined;
  for (const part of event.message.slice(0, 100)) {
    if (part?.type === 'text' && typeof part.data?.text === 'string') text.push(part.data.text);
    else if (part?.type === 'at') {
      const target = numericId(part.data?.qq);
      if (target) { mentions.push(target === selfId ? BOT_ID : `qq_${target}`); if (target !== selfId) text.push(` @QQ${target} `); }
      else if (part.data?.qq === 'all') text.push(' @全体成员 ');
    } else if (part?.type === 'reply') {
      const quoted = numericId(part.data?.id);
      if (quoted) replyTo = messageId(quoted);
    } else if (part?.type === 'image') text.push('[图片，未识别内容]');
    else if (part?.type === 'face') text.push('[QQ表情]');
    else if (part?.type === 'record') text.push('[语音，未识别内容]');
    else if (part?.type === 'video') text.push('[视频，未识别内容]');
  }
  const body = text.join('').trim();
  if (!body && !mentions.includes(BOT_ID)) return null;
  const nickname = event.sender?.card || event.sender?.nickname || `QQ${sender}`;
  const timestamp = typeof event.time === 'number' && Number.isFinite(event.time) && event.time > 0 && event.time < 4_000_000_000 ? new Date(event.time * 1000).toISOString() : new Date().toISOString();
  return {
    id: messageId(id), speakerId: `qq_${sender}`, speakerName: String(nickname).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 60),
    at: timestamp, text: body.slice(0, 2000) || '（@喵酱）', mentions: [...new Set(mentions)], replyTo,
    qq: { groupId: QQ_GROUP_ID, messageId: id },
  };
}

export function outgoingGroupMessage(message: Message, run: Run) {
  if (run.mode !== 'live' || message.sample || message.speakerId !== BOT_ID || run.snapshot.focus.qq?.groupId !== QQ_GROUP_ID || run.snapshot.newMessages.some(m => m.qq?.groupId !== QQ_GROUP_ID)) throw new Error('QQ 发送被阻止：只允许真实消息发到群 1104887928');
  if (!message.text.trim() || message.text.length > 4000) throw new Error('QQ 回复长度不正确');
  const content: { type: string; data: Record<string, string> }[] = [];
  const reply = numericId(run.snapshot.focus.qq.messageId);
  if (reply) content.push({ type: 'reply', data: { id: reply } });
  content.push({ type: 'text', data: { text: message.text } });
  // Array text prevents model output such as [CQ:at,...] from becoming an executable message segment.
  return { group_id: Number(QQ_GROUP_ID), message: content };
}

export class QQBridge {
  status: QQStatus = { enabled: false, connected: false, ready: false, groupId: QQ_GROUP_ID, detail: 'NapCat 未配置' };
  private socket?: WebSocket;
  private reconnect?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private receive: (message: Omit<Message, 'seq'>) => void;
  private changed: () => void;

  constructor(receive: (message: Omit<Message, 'seq'>) => void, changed: () => void) { this.receive = receive; this.changed = changed; }

  start() {
    this.stop(); this.stopped = false;
    const address = process.env.NAPCAT_WS_URL;
    this.status = { enabled: Boolean(address), connected: false, ready: false, groupId: QQ_GROUP_ID, detail: address ? '正在连接本机 NapCat…' : 'NapCat 未配置' };
    if (!address) { this.changed(); return; }
    let url: URL;
    try {
      url = new URL(address);
      if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || !process.env.NAPCAT_TOKEN) throw new Error();
      url.searchParams.set('access_token', process.env.NAPCAT_TOKEN);
    } catch { this.status.detail = 'NapCat 必须使用带 Token 的本机 ws:// 地址'; this.changed(); return; }
    const socket = this.socket = new WebSocket(url);
    this.changed();
    const handshake = setTimeout(() => { if (!this.status.ready) socket.close(); }, 15_000);
    socket.addEventListener('open', () => { void this.verify(socket).catch(error => { if (socket !== this.socket) return; this.status.detail = error.message; this.changed(); socket.close(); }); });
    socket.addEventListener('message', event => {
      if (socket !== this.socket || typeof event.data !== 'string' || event.data.length > 65_536) return;
      let data: any;
      try { data = JSON.parse(event.data); } catch { return; }
      if (!data || typeof data !== 'object') return;
      const pending = this.pending.get(data.echo);
      if (pending) {
        clearTimeout(pending.timer); this.pending.delete(data.echo);
        if (data.status === 'ok' && data.retcode === 0) pending.resolve(data.data);
        else pending.reject(new Error(`NapCat 请求失败（retcode ${Number(data.retcode) || '未知'}）`));
        return;
      }
      if (data.post_type === 'meta_event' && data.meta_event_type === 'heartbeat' && data.status?.online === false) { this.status.ready = false; this.status.detail = 'QQ 已离线，等待重新登录'; this.changed(); socket.close(); return; }
      if (!this.status.ready) return;
      const message = groupMessage(data, this.status.selfId || '');
      if (!message) return;
      try { this.receive(message); this.status.lastReceivedAt = new Date().toISOString(); this.changed(); }
      catch (error) { this.status.detail = `接收已暂停：${(error as Error).message}`; this.status.ready = false; this.changed(); }
    });
    socket.addEventListener('error', () => { /* close schedules the bounded reconnect; do not log URLs containing credentials. */ });
    socket.addEventListener('close', () => {
      clearTimeout(handshake);
      if (socket !== this.socket) return;
      this.status.connected = false; this.status.ready = false;
      if (!this.status.detail.includes('失败') && !this.status.detail.includes('离线')) this.status.detail = 'NapCat 未连接，等待 QQ 登录或服务启动';
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('NapCat 连接中断；发送结果可能不确定')); }
      this.pending.clear(); this.changed();
      if (!this.stopped) this.reconnect = setTimeout(() => this.start(), 5000);
    });
  }

  private async verify(socket: WebSocket) {
    const info = await this.call('get_login_info', {});
    const selfId = numericId(info?.user_id);
    if (!selfId) throw new Error('无法确认机器人 QQ 登录身份');
    const [group, member] = await Promise.all([
      this.call('get_group_info', { group_id: Number(QQ_GROUP_ID), no_cache: true }),
      this.call('get_group_member_info', { group_id: Number(QQ_GROUP_ID), user_id: Number(selfId), no_cache: true }),
    ]);
    if (String(group?.group_id) !== QQ_GROUP_ID || String(member?.user_id) !== selfId || socket !== this.socket) throw new Error('机器人不在允许测试的群 1104887928');
    this.status = { ...this.status, connected: true, ready: true, selfId, groupName: String(group.group_name || QQ_GROUP_ID).slice(0, 80), detail: '已连接；仅接收和发送群 1104887928 的消息' };
    this.changed();
  }

  private call(action: 'get_login_info' | 'get_group_info' | 'get_group_member_info' | 'send_group_msg', params: unknown): Promise<any> {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('NapCat 尚未连接'));
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(echo); reject(new Error('NapCat 响应超时；若已尝试发送，请在群里核对')); }, 12_000);
      this.pending.set(echo, { resolve, reject, timer });
      try { this.socket!.send(JSON.stringify({ action, params, echo })); }
      catch { clearTimeout(timer); this.pending.delete(echo); reject(new Error('NapCat 发送失败')); }
    });
  }

  async deliver(message: Message, run: Run, signal: AbortSignal) {
    signal.throwIfAborted();
    const params = outgoingGroupMessage(message, run);
    if (!this.status.ready) throw new Error('QQ 尚未登录或指定群未通过检查，未发送回复');
    const result = await this.call('send_group_msg', params);
    const id = numericId(result?.message_id);
    if (!id) throw new Error('NapCat 未返回发送消息 ID，请在群里核对');
    message.id = messageId(id); message.qq = { groupId: QQ_GROUP_ID, messageId: id };
    run.delivery = { status: 'sent', groupId: QQ_GROUP_ID, messageId: id };
    this.status.lastSentAt = new Date().toISOString(); this.changed();
  }

  stop() {
    this.stopped = true;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.socket?.close(); this.socket = undefined;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('NapCat 连接已停止')); }
    this.pending.clear();
  }
}
