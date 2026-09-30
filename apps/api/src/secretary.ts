import { BadRequestException } from '@nestjs/common';
import { PersonalMemory } from './memory';
import { beijingDate, beijingInstant } from './time';

// 个人秘书：把一句话变成「待确认」的日程草稿。
// 这里只做理解与整理，绝不自动写入日程——写入永远要用户点一次确认。
// 三种模式：
//   off  未接入模型（默认），明确告诉用户不可用，不伪装成"听懂了"
//   stub 本地规则解析，用于测试与无密钥演示，结果可解释
//   http 调用 OpenAI 兼容接口，密钥只从本机 .env 读取，接口永不接收密钥
export type SecretaryMode = 'off' | 'stub' | 'http';
export const SECRETARY = Symbol('secretary');

export type DraftStatus = 'READY' | 'NEEDS_INPUT' | 'UNAVAILABLE';
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export type Draft = {
  status: DraftStatus;
  title: string | null;
  date: string | null;
  startTime: string | null;
  endTime: string | null;
  confidence: Confidence;
  missing: string[];
  reasons: string[];
  usedMemories: string[];
  model: string;
  message: string;
};

export const MAX_TEXT_LENGTH = 200;
const DEFAULT_DURATION_MINUTES = 60;
const MODEL_TIMEOUT_MS = 8000;
const MAX_MEMORIES_TO_MODEL = 20;

export function validateSecretaryText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestException('请先说一句你想安排的事');
  const text = value.trim();
  if (text.length > MAX_TEXT_LENGTH) throw new BadRequestException(`描述请控制在 ${MAX_TEXT_LENGTH} 字以内`);
  return text;
}

// ---------- 北京时间下的日期运算 ----------

function dayOffset(base: string, days: number): string {
  const anchor = beijingInstant(base, '12:00');
  return beijingDate(new Date(anchor.getTime() + days * 86_400_000));
}

function weekdayOf(date: string): number {
  // 0=周日 … 6=周六；用中午锚点避免 +08:00 凌晨换算回退到前一天
  return beijingInstant(date, '12:00').getUTCDay();
}

/** 本周一（以周一为一周起点） */
function mondayOf(date: string): string {
  return dayOffset(date, -((weekdayOf(date) + 6) % 7));
}

// ---------- 中文日期与时刻解析 ----------

const WEEKDAYS: Array<[RegExp, number]> = [
  [/一/, 1], [/二/, 2], [/三/, 3], [/四/, 4], [/五/, 5], [/六/, 6], [/日|天/, 0],
];

const DAY_PERIODS: Array<[RegExp, [string, string], string]> = [
  [/清晨|早上|早晨|上午/, ['08:00', '12:00'], '上午'],
  [/中午|午休|午间/, ['12:00', '14:00'], '中午'],
  [/下午/, ['13:00', '18:00'], '下午'],
  [/傍晚|黄昏/, ['17:00', '19:00'], '傍晚'],
  [/晚上|晚间|夜里|晚上/, ['19:00', '22:00'], '晚上'],
];

function pad(value: number): string { return String(value).padStart(2, '0'); }
function isValidDate(value: string): boolean {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function timeFrom(total: number): string {
  return `${pad(Math.floor(total / 60) % 24)}:${pad(total % 60)}`;
}

type DateHit = { date: string; reason: string; span: [number, number]; guessed: boolean };

function parseDate(text: string, today: string): DateHit | null {
  const explicit = /(20\d{2})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?/.exec(text);
  if (explicit) {
    const date = `${explicit[1]}-${pad(Number(explicit[2]))}-${pad(Number(explicit[3]))}`;
    return isValidDate(date) ? { date, reason: `按明确日期 ${date} 理解`, span: [explicit.index, explicit.index + explicit[0].length], guessed: false } : null;
  }
  const relative: Array<[RegExp, number, string]> = [
    [/大后天/, 3, '大后天'], [/后天/, 2, '后天'], [/明天|明日|明儿/, 1, '明天'], [/今天|今日|今晚|今儿/, 0, '今天'],
  ];
  for (const [pattern, offset, label] of relative) {
    const match = pattern.exec(text);
    if (match) return { date: dayOffset(today, offset), reason: `「${label}」按北京时间换算为 ${dayOffset(today, offset)}`, span: [match.index, match.index + match[0].length], guessed: false };
  }

  const weekMatch = /(下{1,2}个?|本|这)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/.exec(text);
  if (weekMatch) {
    const target = WEEKDAYS.find(([p]) => p.test(weekMatch[2]))![1];
    const monday = mondayOf(today);
    let date = dayOffset(monday, (target + 6) % 7);
    const prefix = weekMatch[1] ?? '';
    let reason: string;
    if (/下/.test(prefix)) {
      date = dayOffset(date, prefix.includes('下下') ? 14 : 7);
      reason = `「${prefix}周${weekMatch[2]}」按北京时间换算为 ${date}`;
    } else if (date < today && !prefix) {
      date = dayOffset(date, 7);
      reason = `本周${weekMatch[2]}已过，按下一个${weekMatch[2]}（${date}）理解`;
    } else {
      reason = `「${prefix}周${weekMatch[2]}」按北京时间换算为 ${date}`;
    }
    return { date, reason, span: [weekMatch.index, weekMatch.index + weekMatch[0].length], guessed: !prefix };
  }

  const monthDay = /(\d{1,2})\s*[月\/\-]\s*(\d{1,2})\s*日?/.exec(text);
  if (monthDay) {
    const month = Number(monthDay[1]), day = Number(monthDay[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let date = `${today.slice(0, 4)}-${pad(month)}-${pad(day)}`;
      if (isValidDate(date)) {
        let reason = `按 ${month} 月 ${day} 日理解`;
        if (date < today) { date = `${Number(today.slice(0, 4)) + 1}-${pad(month)}-${pad(day)}`; reason = `${month} 月 ${day} 日已过，按次年 ${date} 理解`; }
        return isValidDate(date) ? { date, reason, span: [monthDay.index, monthDay.index + monthDay[0].length], guessed: false } : null;
      }
    }
  }
  return null;
}

const CN_DIGIT: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 支持「三点半」「十四点」这类中文写法，解析不出返回 null */
function cnNumber(text: string): number | null {
  if (/^\d{1,2}$/.test(text)) return Number(text);
  if (!/^[零一二两三四五六七八九十]{1,3}$/.test(text)) return null;
  if (text === '十') return 10;
  if (text.startsWith('十')) return 10 + (CN_DIGIT[text.slice(1)] ?? 0);
  if (text.includes('十')) {
    const [head, tail] = text.split('十');
    return (CN_DIGIT[head] ?? 0) * 10 + (tail ? CN_DIGIT[tail] ?? 0 : 0);
  }
  return CN_DIGIT[text] ?? null;
}

const NUMBER = '(\\d{1,2}|[零一二两三四五六七八九十]{1,3})';

function toMinutes(hour: number, half: boolean, minute: number | undefined, meridiem: 'AM' | 'PM' | null): number {
  let h = hour;
  if (meridiem === 'PM' && h < 12) h += 12;
  if (meridiem === 'AM' && h === 12) h = 0;
  return h * 60 + (half ? 30 : (minute ?? 0));
}

type TimeHit = { start: number; end: number | null; reason: string; span: [number, number]; guessedEnd: boolean };

function readClock(text: string, meridiem: 'AM' | 'PM' | null, from: number): { minutes: number; span: [number, number]; reason: string } | null {
  const source = text.slice(from);
  const colon = new RegExp(`${NUMBER}\\s*[:：]\\s*(\\d{2})`).exec(source);
  if (colon) {
    const hour = cnNumber(colon[1]);
    if (hour != null && hour < 24 && Number(colon[2]) < 60) {
      const minutes = toMinutes(hour, false, Number(colon[2]), meridiem);
      return clock(from + colon.index, colon[0].length, minutes, timeFrom(minutes));
    }
    return null;
  }
  const point = new RegExp(`${NUMBER}\\s*点\\s*(半|(\\d{1,2})\\s*分?)?`).exec(source);
  if (point) {
    const hour = cnNumber(point[1]);
    if (hour != null && hour < 24 && Number(point[3] ?? 0) < 60) {
      const minutes = toMinutes(hour, point[2] === '半', point[3] ? Number(point[3]) : undefined, meridiem);
      return clock(from + point.index, point[0].length, minutes, `${timeFrom(minutes)}`);
    }
    return null;
  }
  const plain = new RegExp(`${NUMBER}\\s*[点时]`).exec(source);
  if (plain) {
    const hour = cnNumber(plain[1]);
    if (hour != null && hour < 24) {
      const minutes = toMinutes(hour, false, 0, meridiem);
      return clock(from + plain.index, plain[0].length, minutes, `${timeFrom(minutes)}`);
    }
  }
  return null;
}

function clock(index: number, length: number, minutes: number, label: string) {
  return { minutes, span: [index, index + length] as [number, number], reason: label };
}

function parseTime(text: string): TimeHit | null {
  const meridiem: 'AM' | 'PM' | null = /下午|晚上|傍晚|黄昏|夜里|晚间/.test(text) ? 'PM' : (/上午|早上|早晨|清晨/.test(text) ? 'AM' : null);
  const period = DAY_PERIODS.find(([pattern]) => pattern.test(text));
  const clockPart = `${NUMBER}\\s*(?:[:：]\\s*\\d{2}|点\\s*(?:半|\\d{1,2}\\s*分?)?|点时?)`;

  const range = new RegExp(`(.{0,12}?)\\s*(?:到|至|-|—|~)\\s*(${clockPart})`).exec(text);
  if (range) {
    const head = readClock(range[1], meridiem, 0);
    const tailAt = range.index + range[0].length - range[2].length;
    const tail = readClock(text, meridiem, tailAt);
    // head 的位置是相对 range[1] 的，要换算回原文本，否则会删错字
    if (head && tail && tail.minutes > head.minutes) {
      return { start: head.minutes, end: tail.minutes, reason: `时段取 ${timeFrom(head.minutes)} 至 ${timeFrom(tail.minutes)}`, span: [range.index + head.span[0], tail.span[1]], guessedEnd: false };
    }
  }

  const single = readClock(text, meridiem, 0);
  // 出现了明确但无效的时刻时，不退回“下午”等模糊时段并伪造一个有效时间。
  if (!single && /[\d零一二两三四五六七八九十]+\s*(?:[:：]|点|时)/.test(text)) return null;
  const duration = /(\d{1,2}(?:\.\d)?)\s*(?:个)?\s*(小时|分钟)/.exec(text);
  if (single) {
    if (duration) {
      const amount = Number(duration[1]);
      const end = single.minutes + (duration[2] === '小时' ? amount * 60 : amount);
      if (end <= 24 * 60) {
        return { start: single.minutes, end, reason: `从 ${timeFrom(single.minutes)} 起持续 ${amount} ${duration[2]}`, span: [single.span[0], duration.index + duration[0].length], guessedEnd: false };
      }
    }
    return { start: single.minutes, end: single.minutes + DEFAULT_DURATION_MINUTES, reason: `只说了开始时间，默认按 ${DEFAULT_DURATION_MINUTES} 分钟`, span: single.span, guessedEnd: true };
  }
  if (period) {
    const [start, end] = period[1];
    return { start: minutesOf(start), end: Math.min(minutesOf(end), minutesOf(start) + 120), reason: `只说了「${period[2]}」，按 ${start} 起 2 小时内理解`, span: [0, 0], guessedEnd: true };
  }
  return null;
}

function strip(text: string, spans: Array<[number, number]>): string {
  let result = '';
  let cursor = 0;
  for (const [from, to] of spans.filter(span => span[1] > span[0]).sort((a, b) => a[0] - b[0])) {
    if (from >= cursor) { result += text.slice(cursor, from); cursor = to; }
  }
  result += text.slice(cursor);
  return result
    .replace(/^(?:今天|明天|后天|大后天|早上|上午|中午|下午|傍晚|晚上|清晨|早晨|夜里)+/, '')
    .replace(/^[,，、。:：\s在去要]+/, '')
    .replace(/[,，、。:：\s]+$/, '')
    .split(/[,，。;；\n]/)[0]
    .replace(/\s+/g, ' ')
    .trim();
}

/** 本地规则解析：不联网、可解释，解析不出就如实说解析不出 */
export function parseChinese(text: string, today: string): { title: string | null; date: string | null; startTime: string | null; endTime: string | null; reasons: string[]; guessed: boolean } {
  const reasons: string[] = [];
  const dateHit = parseDate(text, today);
  const timeHit = parseTime(text);
  if (dateHit) reasons.push(dateHit.reason);
  if (timeHit) reasons.push(timeHit.reason);
  const title = strip(text, [dateHit?.span ?? [0, 0], timeHit?.span ?? [0, 0]]) || null;
  if (!title) reasons.push('没听出安排名称，请补一句做什么');
  return {
    title: title && title.length > 60 ? title.slice(0, 60) : title,
    date: dateHit?.date ?? null,
    startTime: timeHit && timeHit.start >= 0 && timeHit.start < 1440 ? timeFrom(timeHit.start) : null,
    endTime: timeHit?.end != null && timeHit.end < 1440 && timeHit.end > timeHit.start ? timeFrom(timeHit.end) : null,
    reasons,
    guessed: Boolean(timeHit?.guessedEnd) || Boolean(dateHit?.guessed),
  };
}

// ---------- 个人记忆的冲突提醒 ----------

const NEGATIVE = /不|别|勿|避免|拒绝|不能|不要|尽量不/;

function periodOf(text: string): [number, number] | null {
  const period = DAY_PERIODS.find(([pattern]) => pattern.test(text));
  if (period) return [minutesOf(period[1][0]), minutesOf(period[1][1])];
  return null;
}

function clockPoints(text: string): number[] {
  const points: number[] = [];
  const pattern = new RegExp(`(下午|晚上|傍晚|夜里|晚间)?\\s*${NUMBER}\\s*(?:[:：]\\s*(\\d{2})|点\\s*(?:(\\d{1,2})\\s*分?)?)`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const hour = cnNumber(match[2]);
    if (hour == null) continue;
    const pm = Boolean(match[1]) && hour < 12;
    points.push((pm ? hour + 12 : hour) * 60 + Number(match[3] ?? match[4] ?? 0));
  }
  return points;
}

/** 只提示、不替用户做决定：命中返回可读说明，没命中返回空数组 */
export function memoryConflicts(draft: { date: string | null; startTime: string | null; endTime: string | null }, memories: PersonalMemory[]): string[] {
  if (!draft.startTime || !draft.endTime) return [];
  const start = minutesOf(draft.startTime), end = minutesOf(draft.endTime);
  const notes: string[] = [];
  for (const memory of memories) {
    if (memory.category === 'NOTE' || !NEGATIVE.test(memory.content)) continue;
    const period = periodOf(memory.content);
    if (period && start < period[1] && period[0] < end) {
      notes.push(`与你记过的「${memory.label}」可能冲突：${memory.content.slice(0, 40)}`);
      continue;
    }
    if (clockPoints(memory.content).some(point => point >= start && point < end)) {
      notes.push(`与你记过的「${memory.label}」可能冲突：${memory.content.slice(0, 40)}`);
    }
  }
  return notes.slice(0, 3);
}

// ---------- 模型适配 ----------

export type ModelRequest = { text: string; today: string; memories: PersonalMemory[] };
export interface SecretaryModel {
  readonly name: string;
  complete(request: ModelRequest): Promise<Record<string, unknown> | null>;
}

export class StubModel implements SecretaryModel {
  readonly name = 'stub';
  async complete(request: ModelRequest): Promise<Record<string, unknown> | null> {
    const parsed = parseChinese(request.text, request.today);
    return { title: parsed.title, date: parsed.date, startTime: parsed.startTime, endTime: parsed.endTime, guessed: parsed.guessed, reasons: parsed.reasons };
  }
}

const SYSTEM_PROMPT = [
  '你是个人日程秘书，只做一件事：把用户的一句话整理成日程草稿。',
  '所有日期与时刻都按北京时间（UTC+8）解释。',
  '只输出一个 JSON 对象，不要解释、不要加代码块标记。',
  '字段：title（不超过 60 字）、date（YYYY-MM-DD）、startTime（HH:mm）、endTime（HH:mm）。',
  '信息不足时对应字段填 null，绝对不要猜测或编造。',
  '没有明确结束时间时 endTime 填 null，不要擅自假定时长。',
].join('\n');

function buildPrompt(request: ModelRequest): string {
  const memories = request.memories.slice(0, MAX_MEMORIES_TO_MODEL)
    .map(memory => `- [${memory.category}] ${memory.label}: ${memory.content.slice(0, 200)}`).join('\n');
  return [
    `今天是北京时间 ${request.today}。`,
    memories ? `用户记过的偏好与限制：\n${memories}` : '用户没有记过偏好与限制。',
    `请把下面这句话整理成日程草稿：\n${request.text}`,
  ].join('\n');
}

function extractJson(raw: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidate = (fenced ? fenced[1] : raw).trim();
  const start = candidate.indexOf('{'), end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

export type HttpModelOptions = { baseUrl: string; apiKey: string; model: string; fetcher?: typeof fetch; timeoutMs?: number };

export class HttpModel implements SecretaryModel {
  constructor(private readonly options: HttpModelOptions) {}
  get name() { return this.options.model; }
  async complete(request: ModelRequest): Promise<Record<string, unknown> | null> {
    const fetcher = this.options.fetcher ?? fetch;
    const response = await fetcher(`${this.options.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.apiKey}` },
      body: JSON.stringify({
        model: this.options.model, temperature: 0,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: buildPrompt(request) }],
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? MODEL_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`模型返回 ${response.status}`);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    return typeof content === 'string' ? extractJson(content) : null;
  }
}

// ---------- 草稿服务 ----------

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function readField(raw: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

export class SecretaryService {
  readonly mode: SecretaryMode;
  private readonly model: SecretaryModel | null;
  constructor(mode: SecretaryMode, model: SecretaryModel | null = mode === 'stub' ? new StubModel() : null) {
    this.mode = mode;
    this.model = model;
  }

  /** 只生成草稿。写入日程必须由用户另行确认，这里没有任何写入路径。 */
  async draft(text: string, memories: PersonalMemory[], now: Date = new Date()): Promise<Draft> {
    const today = beijingDate(now);
    if (this.mode === 'off' || !this.model) {
      return { status: 'UNAVAILABLE', title: null, date: null, startTime: null, endTime: null, confidence: 'LOW',
        missing: ['title', 'date', 'startTime', 'endTime'], reasons: ['后台未接入模型'], usedMemories: [], model: 'off',
        message: '未接入模型，请手动填写安排' };
    }

    let raw: Record<string, unknown> | null = null;
    try {
      raw = await this.model.complete({ text, today, memories });
    } catch {
      raw = null;
    }
    if (!raw) {
      return { status: 'UNAVAILABLE', title: null, date: null, startTime: null, endTime: null, confidence: 'LOW',
        missing: ['title', 'date', 'startTime', 'endTime'], reasons: ['模型暂时没有返回结果'], usedMemories: [], model: this.model.name,
        message: '模型暂时不可用，请手动填写安排' };
    }

    const reasons: string[] = Array.isArray(raw.reasons)
      ? raw.reasons.filter((item): item is string => typeof item === 'string').slice(0, 5) : [];
    const missing: string[] = [];

    const rawTitle = readField(raw, ['title', 'subject', 'name']);
    const title = rawTitle && rawTitle.length <= 60 ? rawTitle : null;
    if (title) reasons.push(`理解为「${title}」`);
    else {
      missing.push('title');
      if (rawTitle) reasons.push('模型给出的名称超过 60 字，请精简');
    }

    const date = readField(raw, ['date', 'day']);
    let validDate: string | null = null;
    if (date && isValidDate(date) && date >= today) validDate = date;
    else if (date) reasons.push(`模型给出的日期「${date}」不可用（格式不对或早于今天），请确认`);
    if (!validDate) missing.push('date');

    const startTime = readField(raw, ['startTime', 'start_time', 'start']);
    const endTime = readField(raw, ['endTime', 'end_time', 'end']);
    let validStart: string | null = TIME_PATTERN.test(startTime ?? '') ? startTime! : null;
    let validEnd: string | null = TIME_PATTERN.test(endTime ?? '') ? endTime! : null;
    if (validStart && validEnd && validStart >= validEnd) {
      reasons.push('模型给出的结束时间不晚于开始时间，请确认');
      validEnd = null;
    }
    if (!validStart) missing.push('startTime');
    if (!validEnd) missing.push('endTime');

    const guessed = raw.guessed === true || (!validEnd && Boolean(validStart));
    const conflicts = memoryConflicts({ date: validDate, startTime: validStart, endTime: validEnd }, memories);
    reasons.push(...conflicts);

    const ready = missing.length === 0;
    const confidence: Confidence = !ready ? 'LOW' : (guessed || conflicts.length > 0 ? 'MEDIUM' : 'HIGH');
    const usedMemories = conflicts.length > 0 || this.mode === 'http'
      ? [...new Set(memories.slice(0, MAX_MEMORIES_TO_MODEL).map(memory => memory.label))].slice(0, 10)
      : [];

    return {
      status: ready ? 'READY' : 'NEEDS_INPUT',
      title,
      date: validDate, startTime: validStart, endTime: validEnd,
      confidence, missing, reasons, usedMemories, model: this.model.name,
      message: ready ? '已生成草稿，确认后才会写入你的日程' : '还有信息没确定，请补全后再保存',
    };
  }
}
