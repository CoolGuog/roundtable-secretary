import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { inputObject, validateArrangement } from './store';
import { ReviewContext } from './reviews';
import { changeMeeting, meetingDto, SharedPreparation, SharedMinutes } from './shared-meeting';
type Person = ReviewContext['participants'][number];
type Vote = Person & { decision: 'PENDING' | 'ACCEPT' | 'DISPUTE'; note: string; at: string | null };
export type SharedTask = { id: string; title: string; details: string; dueDate: string; assignee: Person;
  source?: string;
  state: 'TODO' | 'DOING' | 'REVIEW' | 'DISPUTED' | 'DONE'; round: number; votes: Vote[];
  history: Array<{ at: string; actor: string; label: string; note: string }> };
type Notice = { id: string; taskId: string; section?: string; title: string; text: string; at: string; recipients: Array<{ userId: string; readAt: string | null }> };
export type WorkDocument = { version: number; tasks: SharedTask[]; notices: Notice[]; preparation?: SharedPreparation[]; minutes?: SharedMinutes[] };
export type WorkCommand = { kind: 'save' | 'action' | 'read' | 'prep-save' | 'prep-action' | 'minutes-save' | 'minutes-task'; id?: string; value: unknown };
export interface SharedWorkStore {
  get(userId: string, roomId: string): unknown;
  write(userId: string, roomId: string, command: WorkCommand): unknown;
  notifications(userId: string): unknown;
}
const empty = (): WorkDocument => ({ version: 0, tasks: [], notices: [], preparation: [], minutes: [] });
export function text(value: unknown, max: number, required = true) {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw new BadRequestException(`请填写${required ? '非空且' : ''}不超过 ${max} 字的内容`);
  return value.trim();
}
export function keys(input: Record<string, unknown>, allowed: string[]) { if (Object.keys(input).some(key => !allowed.includes(key))) throw new BadRequestException('不支持额外字段'); }
export function allowed(ok: unknown, message: string): asserts ok { if (!ok) throw new ForbiddenException(message); }
const active = (context: ReviewContext, p: Person) => context.participants.some(member => member.memberId === p.memberId && member.userId === p.userId);
export function changeWork(context: ReviewContext, current: WorkDocument | null, userId: string, command: WorkCommand): WorkDocument {
  const input = inputObject(command.value), work: WorkDocument = current ? JSON.parse(JSON.stringify(current)) : empty();
  const actor = context.participants.find(p => p.userId === userId);
  allowed(actor, '你已不是当前圆桌成员');
  if (command.kind === 'read') {
    keys(input, []); const notice = work.notices.find(n => n.id === command.id), recipient = notice?.recipients.find(r => r.userId === userId);
    if (!recipient) throw new NotFoundException('消息不存在或你不是接收人');
    recipient.readAt ??= new Date().toISOString(); return work;
  }
  if (!Number.isSafeInteger(input.version) || input.version !== work.version) throw new ConflictException('工作台已有更新，请刷新核对；不要自动重试写入');
  const at = new Date().toISOString(); let task: SharedTask, label: string, note = '';
  if (['prep-save', 'prep-action', 'minutes-save', 'minutes-task'].includes(command.kind)) {
    const event = changeMeeting(context, work, actor, command, input, at);
    return finishWork(work, context, userId, actor.name, at, event);
  }
  if (command.kind === 'save') {
    allowed(context.ownerId === userId, '只有发起人可以创建、编辑或重新分派任务');
    keys(input, ['version', 'title', 'details', 'dueDate', 'assigneeMemberId']);
    const person = context.participants.find(p => p.memberId === input.assigneeMemberId);
    if (!person) throw new BadRequestException('负责人必须是当前圆桌成员');
    const title = text(input.title, 60), details = text(input.details, 500, false);
    const { date: dueDate } = validateArrangement({ title, date: input.dueDate, startTime: '00:00', endTime: '00:01' });
    if (command.id) {
      const existing = work.tasks.find(t => t.id === command.id); if (!existing) throw new NotFoundException('任务不存在'); task = existing;
      if (!['TODO', 'DOING'].includes(task.state)) throw new ConflictException('请先重新打开任务，再修改或分派');
      Object.assign(task, { title, details, dueDate, assignee: { ...person }, state: 'TODO' }); label = '修改／重新分派任务';
    } else {
      if (work.tasks.length >= 50) throw new BadRequestException('每个圆桌最多 50 个协作任务');
      task = { id: randomUUID(), title, details, dueDate, assignee: { ...person }, state: 'TODO', round: 0, votes: [], history: [] };
      work.tasks.push(task); label = '分派新任务';
    }
    note = `负责人：${person.name}；截止：${dueDate}；${title}`;
  } else {
    keys(input, ['version', 'action', 'note']); const existing = work.tasks.find(t => t.id === command.id);
    if (!existing) throw new NotFoundException('任务不存在'); task = existing;
    note = text(input.note, 300, input.action !== 'start');
    if (input.action === 'start' || input.action === 'submit') {
      allowed(task.assignee.memberId === actor.memberId, '只有任务负责人本人可以执行或提交完成说明');
      if (!['TODO', 'DOING'].includes(task.state) || (input.action === 'start' && task.state !== 'TODO')) throw new ConflictException('任务状态已变化，请刷新');
      if (input.action === 'start') { task.state = 'DOING'; label = '开始执行'; }
      else {
        if (context.participants.length < 2) throw new BadRequestException('至少两名当前成员才能提交共同验收');
        task.round++; task.state = 'REVIEW'; label = '提交完成说明，等待全员验收';
        task.votes = context.participants.map(p => ({ ...p, decision: 'PENDING', note: '', at: null }));
      }
    } else if (input.action === 'accept' || input.action === 'dispute') {
      if (!['REVIEW', 'DISPUTED'].includes(task.state)) throw new ConflictException('任务尚未提交验收或已经完成');
      const vote = task.votes.find(p => p.memberId === actor.memberId);
      allowed(vote, '只有本轮提交时的验收成员可以表态');
      if (task.votes.some(p => !active(context, p))) throw new ConflictException('本轮有验收成员已退出，需重新打开并提交新一轮验收');
      Object.assign(vote, { decision: input.action === 'accept' ? 'ACCEPT' : 'DISPUTE', note, at });
      task.state = task.votes.some(v => v.decision === 'DISPUTE') ? 'DISPUTED' : task.votes.every(v => v.decision === 'ACCEPT') ? 'DONE' : 'REVIEW';
      label = input.action === 'accept' ? `第 ${task.round} 轮：本人确认验收` : `第 ${task.round} 轮：提出验收异议`;
      if (task.state === 'DONE') label += '，全员通过';
    } else if (input.action === 'reopen') {
      allowed(context.ownerId === userId || task.assignee.memberId === actor.memberId, '只有发起人或负责人可以重新打开');
      if (!['REVIEW', 'DISPUTED', 'DONE'].includes(task.state)) throw new ConflictException('当前状态不能重新打开');
      task.state = 'TODO'; task.votes = []; label = '重新打开；下次提交须重新逐人验收';
    } else throw new BadRequestException('未知任务操作');
  }
  if (task.history.length >= 50) throw new BadRequestException('该任务已达 50 条操作历史上限');
  task.history.push({ at, actor: actor.name, label, note });
  return finishWork(work, context, userId, actor.name, at, { id: task.id, title: task.title, label, section: 'tasks' });
}
function finishWork(work: WorkDocument, context: ReviewContext, userId: string, actor: string, at: string, event: { id: string; title: string; label: string; section: string }) {
  work.version++;
  // 消息与业务修改放在同一份持久文档/事务内；无业务写入就不产生消息。
  work.notices.push({ id: randomUUID(), taskId: event.id, section: event.section, title: event.title, text: `${actor}：${event.label}`, at,
    recipients: context.participants.filter(p => p.userId !== userId).map(p => ({ userId: p.userId, readAt: null })) });
  work.notices = work.notices.slice(-200);
  if (Buffer.byteLength(JSON.stringify(work), 'utf8') > 300_000) throw new BadRequestException('工作台已达容量上限，本次操作未保存');
  return work;
}
export function workDto(work: WorkDocument | null, context: ReviewContext, userId: string) {
  const value = work ?? empty(), actor = context.participants.find(p => p.userId === userId)!;
  return { version: value.version, canManage: context.ownerId === userId,
    ...meetingDto(value, context, userId),
    participants: context.participants.map(p => ({ memberId: p.memberId, name: p.name, isMe: p.userId === userId })),
    tasks: value.tasks.map(task => {
      const editable = ['TODO', 'DOING'].includes(task.state), reviewing = ['REVIEW', 'DISPUTED'].includes(task.state);
      return { id: task.id, title: task.title, details: task.details, dueDate: task.dueDate, state: task.state, round: task.round, history: task.history, source: task.source ?? '',
        assignee: { memberId: task.assignee.memberId, name: task.assignee.name, isMe: actor.memberId === task.assignee.memberId, active: active(context, task.assignee) },
        votes: task.votes.map(p => ({ memberId: p.memberId, name: p.name, isMe: p.userId === userId, active: active(context, p), decision: p.decision, note: p.note, at: p.at })),
        canEdit: context.ownerId === userId && editable, canStart: actor.memberId === task.assignee.memberId && task.state === 'TODO',
        canSubmit: actor.memberId === task.assignee.memberId && editable, canVote: reviewing && task.votes.some(p => p.memberId === actor.memberId) && task.votes.every(p => active(context, p)),
        canReopen: (context.ownerId === userId || actor.memberId === task.assignee.memberId) && !editable };
    }) };
}
export function noticeDto(work: WorkDocument, roomId: string, roomTitle: string, userId: string) {
  return work.notices.flatMap(n => {
    const recipient = n.recipients.find(r => r.userId === userId); if (!recipient) return [];
    return [{ id: n.id, roomId, roomTitle, taskId: n.taskId, section: n.section ?? 'tasks', title: n.title, text: n.text, at: n.at, readAt: recipient.readAt }];
  });
}
export class MemorySharedWork implements SharedWorkStore {
  private readonly documents = new Map<string, WorkDocument>();
  constructor(private readonly context: (userId: string, roomId: string) => ReviewContext, private readonly rooms: (userId: string) => Array<{ id: string; title: string }>) {}
  get(userId: string, roomId: string) { return workDto(this.documents.get(roomId) ?? null, this.context(userId, roomId), userId); }
  write(userId: string, roomId: string, command: WorkCommand) {
    const context = this.context(userId, roomId), result = changeWork(context, this.documents.get(roomId) ?? null, userId, command);
    this.documents.set(roomId, result); return command.kind === 'read' ? { read: true } : workDto(result, context, userId);
  }
  notifications(userId: string) {
    return this.rooms(userId).flatMap(r => this.documents.has(r.id) ? noticeDto(this.documents.get(r.id)!, r.id, r.title, userId) : [])
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).slice(0, 100);
  }
}
