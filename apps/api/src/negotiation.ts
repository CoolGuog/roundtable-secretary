// 圆桌协商：共同可用时间计算 + 方案确认闭环。
//
// 隐私边界（这一版刻意收紧）：
//   1. 只有显式授权（shareBusy=true）的成员，其日程才会参与计算；
//   2. 参与计算的只有「起止时间」，标题、备注一概不读、不外传；
//   3. 未授权成员的安排完全不参与，但结果会标注覆盖率，避免误以为人人都在。
//
// 时间口径同全局约定：输入输出一律北京时间，内部比较用绝对时间。
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ArrangementInput, inputObject } from './store';
import { beijingInstant, beijingTime } from './time';

export type Slot = { date: string; startTime: string; endTime: string };
export type Decision = 'PENDING' | 'ACCEPT' | 'REJECT';
export type ProposalStatus = 'OPEN' | 'CONFIRMED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';

/** 计算共同可用时间所需的最小房间信息 */
export type NegotiationRoom = {
  id: string; status: 'OPEN' | 'CLOSED'; version: number; title: string;
  dateFrom: string; dateTo: string; startTime: string; endTime: string; durationMinutes: number;
  members: { userId: string; shareBusy: boolean }[];
};

export type Availability = {
  slots: Slot[];
  durationMinutes: number;
  window: { dateFrom: string; dateTo: string; startTime: string; endTime: string };
  coverage: { shared: number; total: number };
  /** 无解时的原因；有解则为 null */
  reason: string | null;
  /** 有解但覆盖不全等附加说明；无则为 null */
  note: string | null;
};

/** 对外只给「谁、什么态度、什么时候」，不给 userId：圆桌内不需要也不应该暴露内部身份 */
export type ProposalVote = { name: string; decision: Decision; decidedAt: string | null; isMe: boolean };
export type Proposal = {
  id: string; roomId: string; date: string; startTime: string; endTime: string;
  status: ProposalStatus; stale: boolean; expiresAt: string; createdAt: string;
  createdByMe: boolean;
  votes: ProposalVote[];
};

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^20\d{2}-\d{2}-\d{2}$/;
/** 候选起点的枚举步长 */
const STEP_MINUTES = 30;
/** 每个空闲段最多给出的候选数 */
const PER_SEGMENT = 3;
/** 一次最多返回的候选数 */
const MAX_SLOTS = 6;
/** 方案有效期：超过后不能再确认 */
export const PROPOSAL_TTL_MS = 24 * 3600_000;

function clip(busy: Interval[], from: number, to: number): Interval[] {
  return busy
    .map(item => ({ start: Math.max(item.start, from), end: Math.min(item.end, to) }))
    .filter(item => item.start < item.end)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function merge(intervals: Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const item of intervals) {
    const last = result[result.length - 1];
    if (last && item.start <= last.end) last.end = Math.max(last.end, item.end);
    else result.push({ ...item });
  }
  return result;
}

function pushSlots(slots: Slot[], date: string, segmentStart: number, segmentEnd: number, durationMs: number, now: number, limit: number) {
  const stepMs = STEP_MINUTES * 60_000;
  let taken = 0;
  for (let start = segmentStart; start + durationMs <= segmentEnd && taken < PER_SEGMENT; start += stepMs) {
    if (start < now) continue;
    const end = start + durationMs;
    slots.push({ date, startTime: format(start), endTime: format(end) });
    if (slots.length >= limit) break;
    taken++;
  }
  return taken;
}

function format(absolute: number): string {
  return beijingTime(new Date(absolute));
}

/**
 * 在圆桌的日期区间与每日时间窗口内，找出所有授权成员都空闲的时段。
 * 只做区间求交，不读取任何日程标题。
 */
export function findSlots(window: NegotiationRoom, busy: Interval[], now: Date, limit = MAX_SLOTS): Slot[] {
  const slots: Slot[] = [];
  const durationMs = window.durationMinutes * 60_000;
  const nowMs = now.getTime();
  const firstDay = Date.parse(`${window.dateFrom}T00:00:00.000Z`);
  const lastDay = Date.parse(`${window.dateTo}T00:00:00.000Z`);
  for (let day = firstDay; day <= lastDay && slots.length < limit; day += 86400_000) {
    const date = new Date(day).toISOString().slice(0, 10);
    const windowStart = beijingInstant(date, window.startTime).getTime();
    const windowEnd = beijingInstant(date, window.endTime).getTime();
    if (windowEnd - windowStart < durationMs) continue;
    const occupied = merge(clip(busy, windowStart, windowEnd));
    let cursor = windowStart;
    for (const item of occupied) {
      if (item.start > cursor) pushSlots(slots, date, cursor, item.start, durationMs, nowMs, limit);
      cursor = Math.max(cursor, item.end);
      if (slots.length >= limit) break;
    }
    if (slots.length < limit && windowEnd > cursor) pushSlots(slots, date, cursor, windowEnd, durationMs, nowMs, limit);
  }
  return slots;
}

export type Interval = { start: number; end: number };

/**
 * 汇总协商结果。至少要有两位成员、且至少一人授权，才认为「算得出有意义的共同时间」，
 * 否则宁可返回空列表加原因，也不给出一个看起来成立、实际没有依据的时段。
 */
export function availabilityOf(room: NegotiationRoom, busy: Interval[], now = new Date()): Availability {
  const coverage = { shared: room.members.filter(member => member.shareBusy).length, total: room.members.length };
  const window = { dateFrom: room.dateFrom, dateTo: room.dateTo, startTime: room.startTime, endTime: room.endTime };
  const empty = (reason: string): Availability => ({ slots: [], durationMinutes: room.durationMinutes, window, coverage, reason, note: null });
  if (coverage.total < 2) return empty(noSlotReason(room, coverage));
  if (coverage.shared === 0) return empty(noSlotReason(room, coverage));
  const slots = findSlots(room, busy, now);
  const note = coverage.shared < coverage.total && slots.length > 0
    ? `还有 ${coverage.total - coverage.shared} 位成员未授权忙闲，其安排未纳入计算，结果可能与其已有安排冲突` : null;
  return { slots, durationMinutes: room.durationMinutes, window, coverage, reason: slots.length ? null : noSlotReason(room, coverage), note };
}

export function noSlotReason(window: NegotiationRoom, coverage: { shared: number; total: number }): string {
  if (coverage.total < 2) return '圆桌只有一位成员，邀请其他人加入后才能协商共同时间';
  if (coverage.shared === 0) return '还没有成员授权忙闲信息，无法计算共同时间';
  return `在 ${window.dateFrom} 至 ${window.dateTo} 的每日 ${window.startTime}–${window.endTime} 内，` +
    `找不到 ${window.durationMinutes} 分钟的共同空档，可以放宽日期范围或时段后重试`;
}

export function validateProposalInput(value: unknown): Slot {
  const input = inputObject(value);
  const keys = Object.keys(input);
  if (keys.some(key => !['date', 'startTime', 'endTime'].includes(key)) || keys.length !== 3) {
    throw new BadRequestException('请选择日期与起止时间');
  }
  const { date, startTime, endTime } = input;
  if (typeof date !== 'string' || !DATE_PATTERN.test(date)) throw new BadRequestException('日期格式不正确');
  if (typeof startTime !== 'string' || !TIME_PATTERN.test(startTime)) throw new BadRequestException('开始时间格式不正确');
  if (typeof endTime !== 'string' || !TIME_PATTERN.test(endTime)) throw new BadRequestException('结束时间格式不正确');
  if (startTime >= endTime) throw new BadRequestException('结束时间须晚于开始时间');
  return { date, startTime, endTime };
}

export function validateDecision(value: unknown): Exclude<Decision, 'PENDING'> {
  const input = inputObject(value);
  if (Object.keys(input).length !== 1 || (input.decision !== 'ACCEPT' && input.decision !== 'REJECT')) {
    throw new BadRequestException('请明确选择接受或拒绝');
  }
  return input.decision;
}

/** 候选时段是否落在圆桌窗口内且时长与约定一致 */
export function withinWindow(window: NegotiationRoom, slot: Slot): boolean {
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  return slot.date >= window.dateFrom && slot.date <= window.dateTo
    && slot.startTime >= window.startTime && slot.endTime <= window.endTime
    && minutes(slot.endTime) - minutes(slot.startTime) === window.durationMinutes;
}

export const sameSlot = (a: Slot, b: Slot) => a.date === b.date && a.startTime === b.startTime && a.endTime === b.endTime;

/** 两段区间是否重叠（半开区间 [start, end)） */
export const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && bStart < aEnd;

type StoredProposal = {
  id: string; roomId: string; date: string; startTime: string; endTime: string;
  roomVersion: number; status: ProposalStatus; createdById: string;
  expiresAt: Date; appliedAt: Date | null; createdAt: string;
  votes: { userId: string; decision: Decision; decidedAt: string | null }[];
};

export type NegotiationDeps = {
  room: (userId: string, roomId: string) => NegotiationRoom;
  arrangements: (userId: string) => { date: string; startTime: string; endTime: string }[];
  createArrangements: (entries: { userId: string; value: ArrangementInput }[]) => void;
  name: (userId: string) => string;
};

export interface NegotiationStore {
  availability(userId: string, roomId: string): Availability | Promise<Availability>;
  createProposal(userId: string, roomId: string, value: unknown): Proposal | Promise<Proposal>;
  currentProposal(userId: string, roomId: string): Proposal | null | Promise<Proposal | null>;
  decide(userId: string, roomId: string, proposalId: string, value: unknown): Proposal | Promise<Proposal>;
  cancel(userId: string, roomId: string, proposalId: string): Proposal | Promise<Proposal>;
}

/** 计算某房间当前方案是否已失效（过期，或圆桌成员/授权已变） */
export function isStale(proposal: Pick<StoredProposal, 'status' | 'expiresAt' | 'roomVersion' | 'date' | 'startTime'>, roomVersion: number, now = Date.now()) {
  if (proposal.status !== 'OPEN') return false;
  return proposal.expiresAt.getTime() <= now || proposal.roomVersion !== roomVersion || beijingInstant(proposal.date, proposal.startTime).getTime() <= now;
}

export class MemoryNegotiation implements NegotiationStore {
  private readonly proposals: StoredProposal[] = [];
  constructor(private readonly deps: NegotiationDeps) {}
  private busy(room: NegotiationRoom): Interval[] {
    return room.members
      .filter(member => member.shareBusy)
      .flatMap(member => this.deps.arrangements(member.userId).map(item => ({
        start: beijingInstant(item.date, item.startTime).getTime(),
        end: beijingInstant(item.date, item.endTime).getTime(),
      })));
  }
  private dto(proposal: StoredProposal, room: NegotiationRoom, userId: string): Proposal {
    return { id: proposal.id, roomId: proposal.roomId, date: proposal.date, startTime: proposal.startTime, endTime: proposal.endTime,
      status: proposal.status, stale: isStale(proposal, room.version), expiresAt: proposal.expiresAt.toISOString(), createdAt: proposal.createdAt,
      createdByMe: proposal.createdById === userId,
      votes: proposal.votes.map(vote => ({ name: this.deps.name(vote.userId), decision: vote.decision,
        decidedAt: vote.decidedAt, isMe: vote.userId === userId })) };
  }
  private open(roomId: string) { return this.proposals.find(item => item.roomId === roomId && item.status === 'OPEN'); }
  private latest(roomId: string) {
    return [...this.proposals].reverse().find(item => item.roomId === roomId) ?? null;
  }
  availability(userId: string, roomId: string): Availability {
    const room = this.deps.room(userId, roomId);
    if (room.status !== 'OPEN') throw new BadRequestException('圆桌已关闭，不能再协商');
    return availabilityOf(room, this.busy(room));
  }
  createProposal(userId: string, roomId: string, value: unknown): Proposal {
    const room = this.deps.room(userId, roomId);
    if (room.status !== 'OPEN') throw new BadRequestException('圆桌已关闭，不能再协商');
    const slot = validateProposalInput(value);
    if (!withinWindow(room, slot)) throw new BadRequestException('所选时段不在圆桌约定的日期与时间窗口内');
    const available = this.availability(userId, roomId);
    if (!available.slots.some(item => sameSlot(item, slot))) {
      throw new BadRequestException(available.reason ?? '该时段已不是当前的共同可用时间，请重新计算后选择');
    }
    const existing = this.open(roomId);
    if (existing && isStale(existing, room.version)) existing.status = 'EXPIRED';
    if (this.open(roomId)) throw new BadRequestException('已有一个待确认方案，请先完成确认或撤回');
    const proposal: StoredProposal = { ...slot, id: randomUUID(), roomId, roomVersion: room.version, status: 'OPEN',
      createdById: userId, expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS), appliedAt: null, createdAt: new Date().toISOString(),
      votes: room.members.map(member => ({ userId: member.userId, decision: 'PENDING' as Decision, decidedAt: null })) };
    this.proposals.push(proposal);
    return this.dto(proposal, room, userId);
  }
  currentProposal(userId: string, roomId: string): Proposal | null {
    const room = this.deps.room(userId, roomId);
    const proposal = this.open(roomId) ?? this.latest(roomId);
    if (!proposal) return null;
    if (isStale(proposal, room.version)) proposal.status = 'EXPIRED';
    return this.dto(proposal, room, userId);
  }
  decide(userId: string, roomId: string, proposalId: string, value: unknown): Proposal {
    const decision = validateDecision(value);
    const room = this.deps.room(userId, roomId);
    const proposal = this.proposals.find(item => item.id === proposalId && item.roomId === roomId);
    if (!proposal) throw new NotFoundException('方案不存在');
    if (proposal.status !== 'OPEN') throw new BadRequestException('该方案已结束，请重新协商');
    // 只报错不改状态：这次调用会被事务回滚，状态更新交给下一次读取时落定。
    if (isStale(proposal, room.version)) {
      throw new BadRequestException('圆桌成员或授权已变化，或方案已过期，请重新计算后发起');
    }
    const vote = proposal.votes.find(item => item.userId === userId);
    if (!vote) throw new NotFoundException('方案不存在');
    if (decision === 'REJECT') proposal.status = 'REJECTED';
    else if (proposal.votes.every(item => item.userId === userId || item.decision === 'ACCEPT')) {
      const start = beijingInstant(proposal.date, proposal.startTime).getTime();
      const end = beijingInstant(proposal.date, proposal.endTime).getTime();
      // 写入前统一检查：任何成员在该时段已有安排都整体放弃，避免写出互相冲突的日程。
      for (const member of room.members) {
        const conflict = this.deps.arrangements(member.userId).some(item =>
          overlaps(start, end, beijingInstant(item.date, item.startTime).getTime(), beijingInstant(item.date, item.endTime).getTime()));
        if (conflict) throw new BadRequestException('有成员在该时段已有其他安排，请重新选择时间');
      }
      this.deps.createArrangements(room.members.map(member => ({ userId: member.userId,
        value: { title: room.title, date: proposal.date, startTime: proposal.startTime, endTime: proposal.endTime } })));
      proposal.status = 'CONFIRMED';
      proposal.appliedAt = new Date();
    }
    vote.decision = decision;
    vote.decidedAt = new Date().toISOString();
    return this.dto(proposal, room, userId);
  }
  cancel(userId: string, roomId: string, proposalId: string): Proposal {
    const room = this.deps.room(userId, roomId);
    const proposal = this.proposals.find(item => item.id === proposalId && item.roomId === roomId);
    if (!proposal) throw new NotFoundException('方案不存在');
    if (proposal.createdById !== userId) throw new ForbiddenException('只有提案人可以撤回方案');
    if (proposal.status === 'CANCELLED') return this.dto(proposal, room, userId);
    if (proposal.status !== 'OPEN') throw new BadRequestException('该方案已结束，不能撤回');
    proposal.status = 'CANCELLED';
    return this.dto(proposal, room, userId);
  }
}
