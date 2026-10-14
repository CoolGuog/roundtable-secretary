import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ReviewContext } from './reviews';
import type { WorkCommand, WorkDocument } from './shared-work';
import { allowed, keys, text } from './shared-work';
import { validateArrangement } from './store';
type Person = ReviewContext['participants'][number];
type History = { at: string; actor: string; label: string; note: string };
export type SharedPreparation = { id: string; title: string; details: string; dueDate: string; assignee: Person; done: boolean; doneAt: string | null; history: History[] };
export type SharedMinutes = { revision: number; date: string; summary: string; decisions: string; nextSteps: string[]; actor: string; at: string };
const date = (value: unknown) => validateArrangement({ title: '日期', date: value, startTime: '00:00', endTime: '00:01' }).date;
function assignee(context: ReviewContext, id: unknown) {
  const person = context.participants.find(p => p.memberId === id);
  if (!person) throw new BadRequestException('负责人必须是当前圆桌成员');
  return { ...person };
}
export function changeMeeting(context: ReviewContext, work: WorkDocument, actor: Person, command: WorkCommand, input: Record<string, unknown>, at: string) {
  const preparation = work.preparation ??= [], minutes = work.minutes ??= [];
  if (command.kind === 'prep-action') {
    keys(input, ['version', 'done', 'note']);
    const item = preparation.find(p => p.id === command.id);
    if (!item) throw new NotFoundException('准备事项不存在');
    allowed(item.assignee.memberId === actor.memberId, '只有负责人本人可以确认或撤回准备状态');
    if (typeof input.done !== 'boolean') throw new BadRequestException('准备状态必须是布尔值');
    if (input.done === item.done) throw new ConflictException('准备状态已变化，请刷新核对');
    const note = text(input.note, 300);
    if (item.history.length >= 50) throw new BadRequestException('该准备事项已达 50 条历史上限');
    item.done = input.done; item.doneAt = input.done ? at : null;
    const label = input.done ? '本人确认准备就绪' : '本人撤回准备就绪';
    item.history.push({ at, actor: actor.name, label, note });
    return { id: item.id, title: item.title, label, section: 'preparation' };
  }
  allowed(context.ownerId === actor.userId, '只有发起人可以分派准备事项、修订纪要或转入后续任务');
  if (command.kind === 'prep-save') {
    keys(input, ['version', 'title', 'details', 'dueDate', 'assigneeMemberId']);
    const value = { title: text(input.title, 60), details: text(input.details, 500, false), dueDate: date(input.dueDate), assignee: assignee(context, input.assigneeMemberId) };
    let item = preparation.find(p => p.id === command.id);
    if (command.id && !item) throw new NotFoundException('准备事项不存在');
    if (!item) {
      if (preparation.length >= 50) throw new BadRequestException('每个圆桌最多 50 个准备事项');
      item = { id: randomUUID(), ...value, done: false, doneAt: null, history: [] }; preparation.push(item);
    }
    if (item.history.length >= 50) throw new BadRequestException('该准备事项已达 50 条历史上限');
    Object.assign(item, value, { done: false, doneAt: null });
    const label = command.id ? '修改准备事项，等待负责人重新确认' : '分派会前准备';
    item.history.push({ at, actor: actor.name, label, note: `负责人：${value.assignee.name}；截止：${value.dueDate}；${value.title}；${value.details}` });
    return { id: item.id, title: item.title, label, section: 'preparation' };
  }
  if (command.kind === 'minutes-save') {
    keys(input, ['version', 'date', 'summary', 'decisions', 'nextSteps']);
    if (minutes.length >= 20) throw new BadRequestException('每个圆桌最多保留 20 版纪要');
    const meetingDate = date(input.date);
    if (meetingDate < context.dateFrom || meetingDate > context.dateTo) throw new BadRequestException('纪要日期必须在圆桌日期范围内');
    const summary = text(input.summary, 1500), decisions = text(input.decisions, 1000, false), raw = text(input.nextSteps, 1000, false);
    const nextSteps = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (nextSteps.length > 10 || nextSteps.some(s => s.length > 500)) throw new BadRequestException('后续行动最多 10 项，每行一项且不超过 500 字');
    const revision = minutes.length + 1;
    minutes.push({ revision, date: meetingDate, summary, decisions, nextSteps, actor: actor.name, at });
    return { id: String(revision), title: `第 ${revision} 版会议纪要`, label: '发布纪要修订（发起人记录）', section: 'minutes' };
  }
  if (command.kind !== 'minutes-task') throw new BadRequestException('未知工作台操作');
  keys(input, ['version', 'assigneeMemberId', 'dueDate']);
  const latest = minutes.at(-1), match = /^(\d+)\/(\d+)$/.exec(command.id ?? '');
  if (!latest || !match || Number(match[1]) !== latest.revision) throw new ConflictException('纪要已有更新，请从最新版预览后续行动');
  const index = Number(match[2]), line = latest.nextSteps[index];
  if (line === undefined) throw new NotFoundException('后续行动不存在');
  const source = `minutes:${latest.revision}:${index}`;
  if (work.tasks.some(t => t.source === source)) throw new ConflictException('这项行动已转入任务，请查看现有任务');
  if (work.tasks.length >= 50) throw new BadRequestException('每个圆桌最多 50 个协作任务');
  const person = assignee(context, input.assigneeMemberId), dueDate = date(input.dueDate), id = randomUUID();
  const label = `纪要第 ${latest.revision} 版第 ${index + 1} 项转入任务`;
  work.tasks.push({ id, title: line.slice(0, 60), details: line, dueDate, assignee: person, state: 'TODO', round: 0, votes: [], source,
    history: [{ at, actor: actor.name, label, note: `负责人：${person.name}；截止：${dueDate}；${line}` }] });
  return { id, title: line.slice(0, 60), label, section: 'tasks' };
}
export function meetingDto(work: WorkDocument, context: ReviewContext, userId: string) {
  const actor = context.participants.find(p => p.userId === userId)!;
  return { dateFrom: context.dateFrom, dateTo: context.dateTo,
    preparation: (work.preparation ?? []).map(p => ({ id: p.id, title: p.title, details: p.details, dueDate: p.dueDate, done: p.done, doneAt: p.doneAt, history: p.history,
      assignee: { memberId: p.assignee.memberId, name: p.assignee.name, isMe: p.assignee.memberId === actor.memberId,
        active: context.participants.some(m => m.memberId === p.assignee.memberId && m.userId === p.assignee.userId) },
      canEdit: context.ownerId === userId, canToggle: p.assignee.memberId === actor.memberId })),
    minutes: (work.minutes ?? []).map(m => ({ ...m, nextSteps: m.nextSteps.map((line, index) => ({ index, text: line,
      taskId: work.tasks.find(t => t.source === `minutes:${m.revision}:${index}`)?.id ?? '',
      canImport: context.ownerId === userId && m.revision === work.minutes!.at(-1)!.revision && !work.tasks.some(t => t.source === `minutes:${m.revision}:${index}`) })) })) };
}
