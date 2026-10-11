import { RepeatSeries, RepeatBase, RepeatRule, repeatRule, expandRepeat, occurrenceId, reviseRepeat } from './repeat-engine';
const key = 'roundtable.demo.recurring.v1';
const rows = (): RepeatSeries[] => { const value = wx.getStorageSync(key); return Array.isArray(value) ? value : []; };
const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const n = Math.floor(Math.random() * 16); return (c === 'x' ? n : (n & 3) | 8).toString(16); });
export function localRepeated(from: string, to: string) { return rows().flatMap(series => expandRepeat(series, from, to)); }
export function saveLocalRepeated(input: RepeatBase & { repeat: RepeatRule }) {
  const records = rows();
  if (records.length >= 500) throw new Error('重复安排及修改版本最多保存 500 组');
  records.push({ ...input, repeat: repeatRule(input.repeat, input.date), id: uuid(), createdAt: new Date().toISOString(), exceptions: {} });
  wx.setStorageSync(key, records);
}
export function changeLocalRepeated(id: string, scope: string, value: RepeatBase | null) {
  const parsed = occurrenceId(id), records = rows(), index = records.findIndex(row => row.id === parsed.seriesId);
  if (index < 0) throw new Error('重复安排不存在');
  const changed = reviseRepeat(records[index], parsed.date, scope, value);
  if (changed.next && records.length >= 500) throw new Error('重复安排及修改版本已达上限');
  records[index] = changed.previous;
  if (changed.next) records.push({ ...changed.next, id: uuid(), createdAt: new Date().toISOString() });
  wx.setStorageSync(key, records);
}
