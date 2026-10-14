export type RepeatRule = { kind: 'daily' | 'weekly'; weekdays: number[]; until?: string };
export type RepeatBase = { title: string; date: string; startTime: string; endTime: string };
export type RepeatSeries = RepeatBase & { id: string; createdAt: string; repeat: RepeatRule; exceptions: Record<string, RepeatBase | null> };
export const dayAfter = (date: string, offset: number) => new Date(Date.parse(date + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
export function validDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const day = new Date(value + 'T00:00:00Z');
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value;
}
export function repeatRule(value: unknown, start: string): RepeatRule {
  const rule = value as RepeatRule;
  if (!rule || typeof rule !== 'object' || !['daily', 'weekly'].includes(rule.kind) || Object.keys(rule).some(key => !['kind', 'weekdays', 'until'].includes(key))) throw new Error('重复规则不正确');
  if (!Array.isArray(rule.weekdays) || rule.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6) || new Set(rule.weekdays).size !== rule.weekdays.length) throw new Error('请选择有效的星期');
  if (rule.kind === 'weekly' && !rule.weekdays.length) throw new Error('每周重复至少选择一个星期');
  if (rule.kind === 'daily' && (!validDay(rule.until) || rule.until < start)) throw new Error('每天重复需要选择不早于开始日期的结束日期');
  if (rule.until !== undefined && (!validDay(rule.until) || rule.until < start)) throw new Error('重复结束日期不正确');
  return { kind: rule.kind, weekdays: rule.kind === 'daily' ? [] : [...rule.weekdays].sort(), ...(rule.until ? { until: rule.until } : {}) };
}
export function repeatWindow(from?: string, to?: string) {
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  if (from === undefined && to === undefined) return { from: dayAfter(today, -7), to: dayAfter(today, 30) };
  if (!validDay(from) || !validDay(to) || to < from || Date.parse(to) - Date.parse(from) > 62 * 86400000) throw new Error('请选择不超过 63 天的日期范围');
  return { from, to };
}
export function occurs(series: RepeatSeries, date: string) {
  return date >= series.date && (!series.repeat.until || date <= series.repeat.until) &&
    (series.repeat.kind === 'daily' || series.repeat.weekdays.includes(new Date(date + 'T00:00:00Z').getUTCDay()));
}
export function expandRepeat(series: RepeatSeries, from: string, to: string) {
  const result: Array<RepeatBase & { id: string; createdAt: string; repeatLabel: string; seriesId: string; repeatKind: 'daily' | 'weekly'; repeatUntil?: string }> = [];
  const label = series.repeat.kind === 'daily' ? '每天重复' : '每周' + series.repeat.weekdays.map(day => '日一二三四五六'[day]).join('、');
  const emit = (date: string, value: RepeatBase) => {
    if (value.date >= from && value.date <= to) result.push({ ...value, id: `r:${series.id}:${date}`, createdAt: series.createdAt, seriesId: series.id, repeatLabel: label, repeatKind: series.repeat.kind, repeatUntil: series.repeat.until });
  };
  for (let date = from; date <= to; date = dayAfter(date, 1)) {
    if (occurs(series, date) && !Object.prototype.hasOwnProperty.call(series.exceptions, date)) emit(date, { title: series.title, date, startTime: series.startTime, endTime: series.endTime });
  }
  for (const [date, value] of Object.entries(series.exceptions)) if (value) emit(date, value);
  return result;
}
export function occurrenceId(id: string) {
  const match = /^r:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(20\d{2}-\d{2}-\d{2})$/i.exec(id);
  if (!match || !validDay(match[2])) throw new Error('重复安排不存在');
  return { seriesId: match[1], date: match[2] };
}
export function changeRepeat(series: RepeatSeries, date: string, scope: unknown, value: RepeatBase | null): RepeatSeries {
  if (scope !== 'one' && scope !== 'future') throw new Error('请选择仅本次或本次及以后');
  if (!occurs(series, date) || series.exceptions[date] === null) throw new Error('重复安排不存在');
  if (Object.keys(series.exceptions).length >= 500 && !Object.prototype.hasOwnProperty.call(series.exceptions, date)) throw new Error('单独修改记录已达上限');
  const next = JSON.parse(JSON.stringify(series)) as RepeatSeries;
  if (scope === 'one') { next.exceptions[date] = value; return next; }
  throw new Error('future changes require splitting');
}
export function reviseRepeat(series: RepeatSeries, date: string, scope: unknown, value: RepeatBase | null, until?: unknown) {
  if (until !== undefined && (scope !== 'future' || !validDay(until) || until < date)) throw new Error('结束日期须不早于本次日期，且只能修改本次及以后的重复规则');
  if (scope !== 'future') return { previous: changeRepeat(series, date, scope, value), next: null };
  if (!occurs(series, date) || series.exceptions[date] === null) throw new Error('重复安排不存在');
  if (value && value.date !== date) throw new Error('修改本次及以后时请保持日期不变；只改本次可单独调整日期');
  const previous = JSON.parse(JSON.stringify(series)) as RepeatSeries;
  previous.repeat.until = dayAfter(date, -1);
  for (const key of Object.keys(previous.exceptions)) if (key >= date) delete previous.exceptions[key];
  if (!value) return { previous, next: null };
  const next: RepeatSeries = { ...series, ...value, repeat: { ...series.repeat }, exceptions: {} };
  if (typeof until === 'string') next.repeat.until = until;
  for (const [key, exception] of Object.entries(series.exceptions)) if (key > date) next.exceptions[key] = exception;
  if (typeof until === 'string') for (const [key, exception] of Object.entries(next.exceptions)) if (key > until || (exception && exception.date > until)) delete next.exceptions[key];
  return { previous, next };
}
