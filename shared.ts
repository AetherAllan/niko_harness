export const BOT_ID = 'niko';
export const BOT_NAME = '喵酱';
export const NO_REPLY = '[[NO_REPLY]]';
export const QQ_GROUP_ID = '1104887928';
export const CONTEXT_SIZE = 2048;
export const OUTPUT_TOKENS = 192;
export const CONTEXT_MARGIN = 96;
export const REPLY_SAMPLING = { repeat_penalty: 1.12, repeat_last_n: 512, presence_penalty: 0.8 };
export type Room = 'lab' | 'qq';
export interface QQOrigin { groupId: string; messageId: string }
export interface QQStatus {
  enabled: boolean;
  connected: boolean;
  ready: boolean;
  groupId: string;
  groupName?: string;
  selfId?: string;
  detail: string;
  lastReceivedAt?: string;
  lastSentAt?: string;
  members?: { id: string; name: string }[];
}
export const SPEAKERS = [
  { id: 'aqing', name: '阿青', color: 'sage' },
  { id: 'xiaobai', name: '小白', color: 'lavender' },
  { id: 'yuzu', name: '柚子', color: 'peach' },
] as const;

export interface Message {
  id: string;
  seq: number;
  speakerId: string;
  speakerName: string;
  at: string;
  text: string;
  mentions: string[];
  replyTo?: string;
  runId?: string;
  sample?: boolean;
  qq?: QQOrigin;
}
export interface Settings {
  heartbeatMin: number;
  heartbeatMax: number;
  thresholds: { should_reply: number; needs_web: number; needs_memory: number };
  searchResults: number;
  searchSnippetChars: number;
  searchTokenBudget: number;
  jevModel: string;
  sampling: { temperature: number; top_p: number; top_k: number; min_p: number; repeat_penalty: number; repeat_last_n: number; presence_penalty: number; frequency_penalty: number; max_tokens: number };
  mockSpeakers: { id: string; name: string }[];
}
export const DEFAULT_SETTINGS: Settings = {
  heartbeatMin: 5,
  heartbeatMax: 12,
  thresholds: { should_reply: 0.7, needs_web: 0.75, needs_memory: 0.75 },
  searchResults: 3,
  searchSnippetChars: 420,
  searchTokenBudget: 300,
  jevModel: 'jev-latest',
  sampling: { temperature: 0.8, top_p: 0.8, top_k: 20, min_p: 0, ...REPLY_SAMPLING, frequency_penalty: 0, max_tokens: OUTPUT_TOKENS },
  mockSpeakers: SPEAKERS.map(({ id, name }) => ({ id, name })),
};
export type Probabilities = Settings['thresholds'];
export interface SearchResult { title: string; url: string; snippet: string; publishedDate?: string }
export interface ModelStatus {
  available: boolean;
  loraVerified: boolean;
  contextSize: number;
  model: string;
  adapter: string;
  detail: string;
}
export interface Step {
  name: string;
  status: 'running' | 'done' | 'skipped' | 'error';
  at: string;
  ms?: number;
  detail?: string;
}
export interface Snapshot { messages: Message[]; newMessages: Message[]; focus: Message; through: number }
export interface ContextWindow { messages: Message[]; tokens: number; budget: number; exact: boolean }
export interface Run {
  id: string;
  mode: 'live' | 'replay';
  status: 'running' | 'replied' | 'silent' | 'error' | 'cancelled';
  phase: string;
  startedAt: string;
  endedAt?: string;
  trigger: 'manual' | 'heartbeat' | 'retry';
  snapshot: Snapshot;
  settings: Settings;
  probabilities?: Probabilities;
  replyDecision?: { probability: number; source: 'mention' | 'jev' };
  jevRaw?: unknown;
  steps: Step[];
  query?: string;
  search?: SearchResult[];
  searchStatus?: string;
  memoryStatus?: string;
  prompt?: { messages: { role: string; content: string }[]; tokens: number; budget: number; searchTokens: number; trimmed: number; messageIds?: string[] };
  output?: string;
  error?: string;
  timings?: Record<string, number>;
  tokenUsage?: { prompt: number; completion: number; perSecond?: number; cached?: number };
  retriedFrom?: string;
  delivery?: { status: 'sending' | 'sent' | 'uncertain'; groupId: string; messageId?: string };
  expired?: boolean;
}
export interface State {
  messages: Message[];
  runs: Run[];
  cursor: number;
  nextSeq: number;
  paused: boolean;
  settings: Settings;
  context?: { tokens: number; budget: number; exact: boolean; discarded: number };
}
export interface PublicState extends State {
  busy: boolean;
  nextHeartbeatAt: string | null;
  services: { jevConfigured: boolean; exaConfigured: boolean; model: ModelStatus };
  storageError?: string;
  room?: Room;
  qq?: QQStatus;
}
export const EMPTY_MODEL: ModelStatus = {
  available: false, loraVerified: false, contextSize: 0, model: 'Qwen3-8B · source31', adapter: '', detail: '正在检查本地模型服务…',
};
