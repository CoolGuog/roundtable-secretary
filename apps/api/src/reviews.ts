import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { inputObject, validateArrangement } from './store';

type Participant = { memberId: string; userId: string; name: string };
export type ReviewContext = { ownerId: string; dateFrom: string; dateTo: string; participants: Participant[] };
type Allocation = { memberId: string; percent: number; reason: string; action: string };
type Vote = { memberId: string; decision: 'PENDING' | 'ACCEPT' | 'DISPUTE'; comment: string; decidedAt: string | null };
type Revision = { revision: number; date: string; outcome: 'NOT_HELD' | 'CANCELLED'; facts: string; allocations: Allocation[];
  externalPercent: number; externalReason: string; unassignedPercent: number; createdAt: string; votes: Vote[];
  events: Array<Omit<Vote, 'decidedAt'> & { decidedAt: string }> };
export type ReviewDocument = { version: number; participants: Participant[]; revisions: Revision[] };
export type ReviewCommand = { kind: 'edit' | 'vote'; value: unknown };
export interface ReviewStore {
  get(userId: string, roomId: string): unknown;
  edit(userId: string, roomId: string, value: unknown): unknown;
  vote(userId: string, roomId: string, value: unknown): unknown;
}
const text = (value: unknown, max: number, required = false): string => {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw new BadRequestException(`请填写${required ? '非空且' : ''}不超过 ${max} 字的说明`);
  return value.trim();
};
const percent = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) throw new BadRequestException('责任比例须为 0 至 100 的整数');
  return value;
};
function keys(input: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new BadRequestException('不支持额外字段');
}
export function reviewStatus(revision: Revision) {
  return revision.votes.some(vote => vote.decision === 'DISPUTE') ? 'DISPUTED'
    : revision.votes.every(vote => vote.decision === 'ACCEPT') ? 'AGREED' : 'PENDING';
}
// 版本号覆盖内容与表态；旧页面或写入结果不明时不能覆盖别人的新结果。
export function changeReview(context: ReviewContext, current: ReviewDocument | null, userId: string, command: ReviewCommand): ReviewDocument {
  const input = inputObject(command.value);
  if (!Number.isInteger(input.version) || input.version !== (current?.version ?? 0)) throw new ConflictException('复盘已更新，请刷新核对后重新操作');
  const document: ReviewDocument = current ? JSON.parse(JSON.stringify(current)) : { version: 0, participants: context.participants, revisions: [] };
  if (command.kind === 'edit') {
    if (context.ownerId !== userId) throw new ForbiddenException('只有圆桌发起人可以提出或修订责任分配');
    keys(input, ['version', 'date', 'outcome', 'facts', 'allocations', 'externalPercent', 'externalReason', 'unassignedPercent']);
    if (document.revisions.length >= 20) throw new BadRequestException('本次复盘最多保留 20 个修订版本');
    const { date } = validateArrangement({ title: '会议复盘', date: input.date, startTime: '00:00', endTime: '00:01' });
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    if (date < context.dateFrom || date > context.dateTo || date > today) throw new BadRequestException('请选择圆桌日期范围内、今天或之前的会议日期');
    if (!['NOT_HELD', 'CANCELLED'].includes(String(input.outcome))) throw new BadRequestException('请选择未举办或已取消');
    if (!Array.isArray(input.allocations) || input.allocations.length !== document.participants.length) throw new BadRequestException('请保留最初复盘的全部参与者');
    const seen = new Set<string>();
    const allocations = input.allocations.map(value => {
      const row = inputObject(value); keys(row, ['memberId', 'percent', 'reason', 'action']);
      if (typeof row.memberId !== 'string' || seen.has(row.memberId) || !document.participants.some(p => p.memberId === row.memberId)) throw new BadRequestException('参与者重复或不属于本次复盘');
      seen.add(row.memberId);
      const share = percent(row.percent);
      return { memberId: row.memberId, percent: share, reason: text(row.reason, 200, share > 0), action: text(row.action, 200) };
    });
    const externalPercent = percent(input.externalPercent), unassignedPercent = percent(input.unassignedPercent);
    if (allocations.reduce((sum, row) => sum + row.percent, 0) + externalPercent + unassignedPercent !== 100) throw new BadRequestException('成员责任、外部原因与待查比例合计须为 100%');
    document.revisions.push({ revision: document.revisions.length + 1, date, outcome: input.outcome as Revision['outcome'],
      facts: text(input.facts, 1000, true), allocations, externalPercent, externalReason: text(input.externalReason, 300, externalPercent > 0),
      unassignedPercent, createdAt: new Date().toISOString(),
      votes: document.participants.map(p => ({ memberId: p.memberId, decision: 'PENDING', comment: '', decidedAt: null })), events: [] });
  } else {
    keys(input, ['version', 'decision', 'comment']);
    const participant = document.participants.find(p => p.userId === userId);
    if (!current) throw new NotFoundException('尚未提出复盘');
    if (!participant) throw new ForbiddenException('只有最初复盘参与者可以表态');
    if (input.decision !== 'ACCEPT' && input.decision !== 'DISPUTE') throw new BadRequestException('请选择确认或提出异议');
    const latest = document.revisions[document.revisions.length - 1];
    if (latest.events.length >= 100) throw new BadRequestException('本版表态记录已达上限，请发起人修订新版本');
    const comment = text(input.comment, 500, input.decision === 'DISPUTE');
    const vote = latest.votes.find(v => v.memberId === participant.memberId)!;
    Object.assign(vote, { decision: input.decision, comment, decidedAt: new Date().toISOString() });
    latest.events.push({ ...vote, decidedAt: vote.decidedAt! });
  }
  document.version++;
  // 页面同时展示当前记录与历史；限制整份记录，避免超出小程序 setData 容量。
  if (Buffer.byteLength(JSON.stringify(document), 'utf8') > 250_000) throw new BadRequestException('复盘历史已达容量上限，本次操作未保存');
  return document;
}
export function reviewDto(document: ReviewDocument | null, context: ReviewContext, userId: string) {
  const participants = (document?.participants ?? context.participants).map(p => ({ memberId: p.memberId, name: p.name,
    isMe: p.userId === userId, active: context.participants.some(member => member.userId === p.userId) }));
  return { version: document?.version ?? 0, canEdit: context.ownerId === userId, canVote: Boolean(document && participants.some(p => p.isMe)), participants,
    revisions: (document?.revisions ?? []).map(revision => ({ ...revision, status: reviewStatus(revision) })) };
}
export class MemoryReviews implements ReviewStore {
  private readonly documents = new Map<string, ReviewDocument>();
  constructor(private readonly context: (userId: string, roomId: string) => ReviewContext) {}
  get(userId: string, roomId: string) { return reviewDto(this.documents.get(roomId) ?? null, this.context(userId, roomId), userId); }
  private write(userId: string, roomId: string, command: ReviewCommand) {
    const context = this.context(userId, roomId);
    const document = changeReview(context, this.documents.get(roomId) ?? null, userId, command);
    this.documents.set(roomId, document); return reviewDto(document, context, userId);
  }
  edit(userId: string, roomId: string, value: unknown) { return this.write(userId, roomId, { kind: 'edit', value }); }
  vote(userId: string, roomId: string, value: unknown) { return this.write(userId, roomId, { kind: 'vote', value }); }
}
