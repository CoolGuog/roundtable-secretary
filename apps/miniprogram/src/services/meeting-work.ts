import { getRoom, isLocalRoomMode } from './roundtables';
import { getReview } from './reviews';

export type TaskState = 'TODO' | 'DOING' | 'REVIEW' | 'DONE';
export type WorkTask = { id: string; title: string; owner: string; dueDate: string; details: string; state: TaskState;
  source: string; sourceLabel: string; history: Array<{ at: string; label: string; note: string }> };
export type PrepItem = { id: string; title: string; owner: string; dueDate: string; note: string; done: boolean; doneAt: string; source: string };
export type Minutes = { revision: number; date: string; summary: string; decisions: string; nextSteps: string; savedAt: string };
export type MeetingWork = { roomId: string; version: number; tasks: WorkTask[]; preparation: PrepItem[]; minutes: Minutes[] };
export type TaskInput = Pick<WorkTask, 'title' | 'owner' | 'dueDate' | 'details'>;
export type PrepInput = Pick<PrepItem, 'title' | 'owner' | 'dueDate' | 'note'>;
export type MinutesInput = Pick<Minutes, 'date' | 'summary' | 'decisions' | 'nextSteps'>;
export type ActionCandidate = { source: string; sourceLabel: string; title: string; details: string; owner: string };
export const taskLabels: Record<TaskState, string> = { TODO: '待开始', DOING: '进行中', REVIEW: '待验收', DONE: '已完成' };
const key = 'roundtable.demo.meeting-work.v1';
function localOnly() { if (!isLocalRoomMode()) throw new Error('会议工作台目前仅支持本机记录，后台任务同步尚未接入'); }
function all(): MeetingWork[] { const value = wx.getStorageSync(key); return Array.isArray(value) ? value : []; }
function empty(roomId: string): MeetingWork { return { roomId, version: 0, tasks: [], preparation: [], minutes: [] }; }
const id = () => `work-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const bounded = (value: string, max: number, label: string, required = true) => {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw new Error(`${label}${required ? '须为 1 至' : '不超过'} ${max} 字`);
  return value.trim();
};
export function validWorkDate(value: string): boolean {
  const date = new Date(value + 'T00:00:00Z');
  return /^20\d{2}-\d{2}-\d{2}$/.test(value) && value >= '2020-01-01' && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function date(value: string) { if (!validWorkDate(value)) throw new Error('请选择 2020—2099 年的有效日期'); return value; }
function taskInput(value: TaskInput): TaskInput { return { title: bounded(value.title, 60, '任务名称'), owner: bounded(value.owner, 40, '负责人'),
  dueDate: date(value.dueDate), details: bounded(value.details, 500, '任务说明', false) }; }
export async function getMeetingWork(roomId: string): Promise<MeetingWork> {
  localOnly(); await getRoom(roomId); return all().find(item => item.roomId === roomId) ?? empty(roomId);
}
async function mutate(roomId: string, version: number, operation: (work: MeetingWork) => void): Promise<MeetingWork> {
  localOnly(); await getRoom(roomId);
  // 最后一次读取与写入之间不 await，避免同设备两个迟到操作互相覆盖。
  const records = all(), index = records.findIndex(item => item.roomId === roomId);
  const current = index < 0 ? empty(roomId) : records[index];
  if (!Number.isInteger(version) || current.version !== version) throw new Error('工作台已有更新，请刷新核对后重新操作');
  const work: MeetingWork = JSON.parse(JSON.stringify(current)); operation(work); work.version++;
  if (work.tasks.length > 50 || work.preparation.length > 50) throw new Error('每个圆桌最多记录 50 个任务和 50 项准备事项');
  if (JSON.stringify(work).length > 80_000) throw new Error('本圆桌记录已达容量上限，本次操作未保存');
  if (index < 0) { if (records.length >= 100) throw new Error('本机最多保存 100 个会议工作台'); records.push(work); }
  else records[index] = work;
  wx.setStorageSync(key, records); return work;
}
function log(task: WorkTask, label: string, note = '') {
  if (task.history.length >= 30) throw new Error('这条任务的操作记录已达 30 条上限');
  task.history.push({ at: new Date().toISOString(), label, note });
}
export function saveTask(roomId: string, version: number, input: TaskInput, taskId = '') {
  const value = taskInput(input);
  return mutate(roomId, version, work => {
    if (taskId) {
      const task = work.tasks.find(item => item.id === taskId); if (!task) throw new Error('任务已不存在');
      if (task.state === 'REVIEW' || task.state === 'DONE') throw new Error('待验收或已完成任务须先重新打开，再修改内容');
      Object.assign(task, value); log(task, '修改任务', `${value.title}；负责人 ${value.owner}；截止 ${value.dueDate}`);
    } else {
      const task: WorkTask = { ...value, id: id(), state: 'TODO', source: '', sourceLabel: '手动新增', history: [] };
      log(task, '创建任务'); work.tasks.push(task);
    }
  });
}
export function changeTask(roomId: string, version: number, taskId: string, action: string, note: string) {
  return mutate(roomId, version, work => {
    const task = work.tasks.find(item => item.id === taskId); if (!task) throw new Error('任务已不存在');
    const rules: Record<string, { from: TaskState[]; to: TaskState; label: string }> = {
      start: { from: ['TODO'], to: 'DOING', label: '开始执行' }, submit: { from: ['TODO', 'DOING'], to: 'REVIEW', label: '提交完成说明，待验收' },
      accept: { from: ['REVIEW'], to: 'DONE', label: '记录验收通过（本机）' }, reopen: { from: ['REVIEW', 'DONE'], to: 'TODO', label: '重新打开' },
    };
    const rule = rules[action]; if (!rule || !rule.from.includes(task.state)) throw new Error('任务状态已变化，请刷新');
    const value = bounded(note, 300, '完成／验收／重开说明', action !== 'start');
    log(task, rule.label, value); task.state = rule.to;
  });
}
export function savePreparation(roomId: string, version: number, input: PrepInput, itemId = '') {
  const value = { title: bounded(input.title, 60, '准备事项'), owner: bounded(input.owner, 40, '负责人'),
    dueDate: date(input.dueDate), note: bounded(input.note, 300, '备注', false) };
  return mutate(roomId, version, work => {
    if (itemId) {
      const item = work.preparation.find(entry => entry.id === itemId); if (!item) throw new Error('准备事项已不存在');
      Object.assign(item, value, { done: false, doneAt: '' });
    } else work.preparation.push({ ...value, id: id(), done: false, doneAt: '', source: '' });
  });
}
export function togglePreparation(roomId: string, version: number, itemId: string) {
  return mutate(roomId, version, work => {
    const item = work.preparation.find(entry => entry.id === itemId); if (!item) throw new Error('准备事项已不存在');
    item.done = !item.done; item.doneAt = item.done ? new Date().toISOString() : '';
  });
}
export function addPreparationTemplate(roomId: string, version: number, dueDate: string) {
  date(dueDate);
  return mutate(roomId, version, work => {
    for (const [index, title] of ['确认会议通知与时间', '检查场地或线上会议链接', '准备并核对会议材料', '测试设备、音视频和网络'].entries()) {
      const source = `preparation-default-${index}`;
      if (!work.preparation.some(item => item.source === source)) work.preparation.push({ id: id(), title, owner: '本人', dueDate, note: '', done: false, doneAt: '', source });
    }
  });
}
export async function saveMinutes(roomId: string, version: number, input: MinutesInput) {
  localOnly(); const room = await getRoom(roomId);
  const value = { date: date(input.date), summary: bounded(input.summary, 1500, '会议纪要'), decisions: bounded(input.decisions, 1000, '决议记录', false), nextSteps: bounded(input.nextSteps, 1000, '后续行动', false) };
  if (value.date < room.dateFrom || value.date > room.dateTo) throw new Error('纪要日期须在圆桌日期范围内');
  if (value.nextSteps.split('\n').filter(line => line.trim()).length > 10) throw new Error('后续行动最多 10 条，每行一条');
  if (value.nextSteps.split('\n').some(line => line.trim().length > 500)) throw new Error('每条后续行动不超过 500 字，便于转成任务');
  return mutate(roomId, version, work => {
    if (work.minutes.length >= 20) throw new Error('会议纪要最多保留 20 个版本');
    work.minutes.push({ ...value, revision: work.minutes.length + 1, savedAt: new Date().toISOString() });
  });
}
export async function actionCandidates(roomId: string, kind: 'review' | 'minutes'): Promise<ActionCandidate[]> {
  localOnly();
  if (kind === 'review') {
    const review = await getReview(roomId), latest = review.revisions[review.revisions.length - 1];
    return latest ? latest.allocations.filter(row => row.action.trim()).map(row => ({ source: `review:${latest.revision}:${row.memberId}`,
      sourceLabel: `复盘第 ${latest.revision} 版（草稿）`, title: row.action.slice(0, 60), details: row.action,
      owner: review.participants.find(p => p.memberId === row.memberId)?.name ?? '本人' })) : [];
  }
  const work = await getMeetingWork(roomId), latest = work.minutes[work.minutes.length - 1];
  return latest ? latest.nextSteps.split('\n').map(line => line.trim()).filter(Boolean).map((line, index) => ({
    source: `minutes:${latest.revision}:${index}`, sourceLabel: `纪要第 ${latest.revision} 版`, title: line.slice(0, 60), details: line, owner: '本人' })) : [];
}
export async function importActions(roomId: string, version: number, kind: 'review' | 'minutes', sources: string[], dueDate: string) {
  const candidates = await actionCandidates(roomId, kind); date(dueDate);
  if (!sources.length || new Set(sources).size !== sources.length || sources.some(source => !candidates.some(item => item.source === source))) throw new Error('来源事项已有变化，请重新预览');
  return mutate(roomId, version, work => {
    for (const source of sources) {
      if (work.tasks.some(task => task.source === source)) continue;
      const candidate = candidates.find(item => item.source === source)!;
      const task: WorkTask = { ...taskInput({ ...candidate, dueDate }), id: id(), state: 'TODO', source,
        sourceLabel: candidate.sourceLabel, history: [] };
      log(task, '从记录转为任务', candidate.sourceLabel); work.tasks.push(task);
    }
  });
}
export async function localTasksForStats(): Promise<WorkTask[] | null> {
  if (!isLocalRoomMode()) return null;
  return all().flatMap(work => work.tasks);
}
