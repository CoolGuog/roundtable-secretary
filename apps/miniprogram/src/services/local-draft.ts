import type { ScheduleDraft } from './secretary';

export type DraftFields = Pick<ScheduleDraft, 'title' | 'date' | 'startTime' | 'endTime'>;
const keys = ['title', 'date', 'startTime', 'endTime'] as const;
const questions = { title: '这条安排要做什么？', date: '安排在哪一天？例如“明天”或“下周三”。',
  startTime: '几点开始？请说明上午或下午，例如“下午三点”。', endTime: '几点结束，或者持续多久？例如“16:00结束”或“持续一小时”。' };
const pad = (n: number) => String(n).padStart(2, '0');
const time = (n: number) => `${pad(Math.floor(n / 60))}:${pad(n % 60)}`;
const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
const cn = (value: string): number => {
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value.includes('十')) { const [a, b] = value.split('十'); return (a ? digits[a] : 1) * 10 + (b ? digits[b] : 0); }
  return digits[value] ?? NaN;
};
function validDate(value: string, today: string) {
  const instant = new Date(value + 'T00:00:00Z');
  return /^20\d{2}-\d{2}-\d{2}$/.test(value) && Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === value && value >= today;
}
const validTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

// 确定性本机规则：只补充能辨认的字段，不联网、不存储、不推断默认时长。
export function localDraft(text: string, previous: DraftFields | null, today: string): ScheduleDraft {
  const value: DraftFields = { title: previous?.title ?? null, date: previous?.date ?? null,
    startTime: previous?.startTime ?? null, endTime: previous?.endTime ?? null };
  const reasons: string[] = ['本机规则整理，未调用 AI，也未写入日程'];
  let rest = text.trim();
  const explicit = /(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})日?/.exec(rest);
  const relative = /大后天|后天|明天|明日|今天/.exec(rest);
  const week = /(下下|下|本|这)?(?:周|星期)([一二三四五六日天])/.exec(rest);
  const md = /(\d{1,2})月(\d{1,2})日?/.exec(rest);
  let date: string | undefined;
  let token = '';
  const dayOffset = (days: number) => new Date(new Date(today + 'T00:00:00Z').getTime() + days * 86400_000).toISOString().slice(0, 10);
  if (explicit) { date = `${explicit[1]}-${pad(+explicit[2])}-${pad(+explicit[3])}`; token = explicit[0]; }
  else if (relative) { date = dayOffset(({ 今天: 0, 明天: 1, 明日: 1, 后天: 2, 大后天: 3 } as Record<string, number>)[relative[0]]); token = relative[0]; }
  else if (week) {
    const target = '一二三四五六日'.indexOf(week[2] === '天' ? '日' : week[2]);
    const weekday = (new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7;
    let offset = target - weekday + (week[1] === '下下' ? 14 : week[1] === '下' ? 7 : 0);
    if (!week[1] && offset < 0) offset += 7;
    date = dayOffset(offset); token = week[0];
  } else if (md) { date = `${today.slice(0, 4)}-${pad(+md[1])}-${pad(+md[2])}`; token = md[0]; }
  if (date !== undefined) {
    value.date = validDate(date, today) ? date : null; rest = rest.replace(token, '');
    reasons.push(value.date ? `日期按北京时间理解为 ${date}` : '这个日期不存在或已过去，请重新说明日期');
  }

  const duration = /(?:持续)?\s*(半|\d+(?:\.\d+)?|[一二两三四五六七八九十]+)(个半|半|个)?\s*(小时|分钟)/.exec(rest);
  if (duration) rest = rest.replace(duration[0], '');
  const clockPattern = /(上午|早上|下午|晚上|中午)?\s*(\d{1,2}|[零一二两三四五六七八九十]+)(?:(?:[:：])(\d{2})|点(?:(半)|(\d{1,2})分?)?)/g;
  const clocks: Array<{ value: string | null; period: string; match: string }> = [];
  let hit: RegExpExecArray | null;
  while ((hit = clockPattern.exec(rest))) {
    const period = hit[1] || clocks[0]?.period || '';
    const hour = cn(hit[2]), minute = hit[4] ? 30 : Number(hit[3] ?? hit[5] ?? 0);
    const colon = hit[3] !== undefined;
    const ambiguous = !colon && !period && hour >= 1 && hour <= 12;
    const h = /下午|晚上/.test(period) && hour < 12 ? hour + 12 : period === '中午' && hour < 11 ? hour + 12 : hour;
    clocks.push({ value: !ambiguous && hour >= 0 && hour < 24 && minute < 60 && h < 24 ? time(h * 60 + minute) : null, period, match: hit[0] });
  }
  if (clocks.length > 2) {
    value.startTime = null; value.endTime = null; reasons.push('这句话包含多个时刻，请一次说明一条安排的起止时间');
  } else if (clocks.length === 2) {
    value.startTime = clocks[0].value; value.endTime = clocks[1].value;
  } else if (clocks.length === 1) {
    const isEnd = /结束/.test(text) || /^\s*到/.test(text) || Boolean(previous?.startTime && !previous.endTime && !/开始|改|调整/.test(text));
    if (isEnd) value.endTime = clocks[0].value;
    else { value.startTime = clocks[0].value; value.endTime = null; }
  }
  for (const clock of clocks) rest = rest.replace(clock.match, '');
  if (clocks.some(clock => !clock.value)) reasons.push('时刻不明确或无效，请使用“下午三点”或“15:00”');
  if (duration) {
    const amount = duration[1] === '半' ? 0.5 : cn(duration[1]) + (/半/.test(duration[2] ?? '') ? 0.5 : 0);
    const length = amount * (duration[3] === '小时' ? 60 : 1);
    const end = value.startTime ? minutes(value.startTime) + length : NaN;
    value.endTime = length > 0 && Number.isInteger(end) && end < 1440 ? time(end) : null;
    if (!value.endTime) reasons.push('请先明确开始时间；时长须有效且不能跨日');
  }

  const named = /(?:名称|标题)(?:改为|改成|是|叫|为|[:：])\s*(.+)/.exec(text);
  rest = rest.replace(/(?:上午|下午|早上|晚上|中午|开始|结束|持续)/g, '')
    .replace(/^(?:(?:我想|请|帮我|安排一下|安排|记一下|改到|改为|改成|在|到|至)|[\s，。,:：-])+/g, '')
    .replace(/[\s，。,:：-]+$/g, '').trim();
  if (named) value.title = named[1].trim();
  else if (!previous?.title && rest && !/^(好|好的|谢谢|随便|不知道|都行|改|一下)$/.test(rest)) value.title = rest;
  if (value.title && value.title.length > 60) { value.title = null; reasons.push('安排名称不能超过 60 字'); }
  if (value.date && !validDate(value.date, today)) value.date = null;
  if (value.startTime && !validTime(value.startTime)) value.startTime = null;
  if (value.endTime && !validTime(value.endTime)) value.endTime = null;
  if (value.startTime && value.endTime && value.startTime >= value.endTime) { value.endTime = null; reasons.push('结束时间须晚于开始时间，目前支持同日安排'); }
  const understood = date !== undefined || clocks.length > 0 || Boolean(duration || named || (!previous?.title && value.title));
  if (!understood) reasons.push('这句暂时没识别出可补充的字段；已有信息保持不变，也可以直接修改表单');
  const missing = keys.filter(key => !value[key]);
  return { ...value, status: missing.length ? 'NEEDS_INPUT' : 'READY', confidence: missing.length ? 'LOW' : 'MEDIUM', missing,
    reasons, usedMemories: [], model: '本机规则', message: missing.length ? questions[missing[0]] : understood ? '草稿已整理好，请核对后点击“确认保存”' : '这句暂时没听懂，草稿保持不变；请具体说明日期、时间或“标题改为…”' };
}
