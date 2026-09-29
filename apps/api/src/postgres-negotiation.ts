import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  Availability, Decision, NegotiationRoom, NegotiationStore, Proposal, PROPOSAL_TTL_MS,
  availabilityOf, isStale, sameSlot, validateDecision, validateProposalInput, withinWindow,
} from './negotiation';
import { ArrangementInput } from './store';
import { TIME_ZONE, beijingInstant } from './time';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Transaction = <T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
const votes = { votes: { include: { user: { select: { displayName: true } } }, orderBy: [{ id: 'asc' as const }] } };
type DbProposal = Prisma.ProposalGetPayload<{ include: typeof votes }>;
type Interval = { start: number; end: number };

export class PostgresNegotiation implements NegotiationStore {
  constructor(private readonly db: PrismaClient, private readonly transaction: Transaction, private readonly appId?: string) {}
  private async loadRoom(tx: Prisma.TransactionClient, userId: string, roomId: string): Promise<NegotiationRoom> {
    if (!UUID_PATTERN.test(roomId)) throw new NotFoundException('圆桌不存在或你已不是成员');
    const room = await tx.roundtable.findFirst({
      where: { id: roomId, members: { some: { userId } }, owner: { wxAppId: this.appId ?? null } },
      include: { members: { orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }] } },
    });
    if (!room) throw new NotFoundException('圆桌不存在或你已不是成员');
    return { id: room.id, status: room.status, version: room.version, title: room.title,
      dateFrom: room.dateFrom, dateTo: room.dateTo, startTime: room.startTime, endTime: room.endTime,
      durationMinutes: room.durationMinutes,
      members: room.members.map(member => ({ userId: member.userId, shareBusy: member.shareBusy })) };
  }
  /** 只读取已授权成员的忙区间，且只取起止时间，不读标题 */
  private async busy(tx: Prisma.TransactionClient, room: NegotiationRoom): Promise<Interval[]> {
    const shared = room.members.filter(member => member.shareBusy).map(member => member.userId);
    if (!shared.length) return [];
    const from = beijingInstant(room.dateFrom, '00:00');
    const to = beijingInstant(room.dateTo, '23:59');
    const rows = await tx.arrangement.findMany({
      where: { ownerId: { in: shared }, startsAt: { lt: to }, endsAt: { gt: from } },
      select: { startsAt: true, endsAt: true },
    });
    return rows.map(row => ({ start: row.startsAt.getTime(), end: row.endsAt.getTime() }));
  }
  private async compute(tx: Prisma.TransactionClient, room: NegotiationRoom): Promise<Availability> {
    return availabilityOf(room, await this.busy(tx, room));
  }
  private dto(proposal: DbProposal, room: NegotiationRoom, userId: string): Proposal {
    return { id: proposal.id, roomId: proposal.roomId, date: proposal.date, startTime: proposal.startTime, endTime: proposal.endTime,
      status: proposal.status, stale: isStale(proposal, room.version), expiresAt: proposal.expiresAt.toISOString(),
      createdAt: proposal.createdAt.toISOString(), createdByMe: proposal.createdById === userId,
      votes: proposal.votes.map(vote => ({ name: vote.user.displayName, decision: vote.decision,
        decidedAt: vote.decidedAt?.toISOString() ?? null, isMe: vote.userId === userId })) };
  }
  async availability(userId: string, roomId: string): Promise<Availability> {
    const room = await this.loadRoom(this.db, userId, roomId);
    if (room.status !== 'OPEN') throw new BadRequestException('圆桌已关闭，不能再协商');
    return this.compute(this.db, room);
  }
  async createProposal(userId: string, roomId: string, value: unknown): Promise<Proposal> {
    const slot = validateProposalInput(value);
    return this.transaction(async tx => {
      const room = await this.loadRoom(tx, userId, roomId);
      if (room.status !== 'OPEN') throw new BadRequestException('圆桌已关闭，不能再协商');
      if (!withinWindow(room, slot)) throw new BadRequestException('所选时段不在圆桌约定的日期与时间窗口内');
      const available = await this.compute(tx, room);
      if (!available.slots.some(item => sameSlot(item, slot))) {
        throw new BadRequestException(available.reason ?? '该时段已不是当前的共同可用时间，请重新计算后选择');
      }
      if (await tx.proposal.count({ where: { roomId, status: 'OPEN' } })) {
        throw new BadRequestException('已有一个待确认方案，请先完成确认或等它失效');
      }
      const proposal = await tx.proposal.create({ data: { ...slot, roomId, roomVersion: room.version, createdById: userId,
        expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
        votes: { create: room.members.map(member => ({ userId: member.userId, decision: 'PENDING' as Decision })) } }, include: votes });
      return this.dto(proposal, room, userId);
    });
  }
  async currentProposal(userId: string, roomId: string): Promise<Proposal | null> {
    const room = await this.loadRoom(this.db, userId, roomId);
    let proposal = await this.db.proposal.findFirst({
      where: { roomId }, include: votes,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
    });
    if (!proposal) return null;
    // 已过期的方案在这里落定为 EXPIRED：确认路径上抛异常会被事务回滚，不适合写状态。
    if (isStale(proposal, room.version)) {
      proposal = await this.db.proposal.update({ where: { id: proposal.id }, data: { status: 'EXPIRED' }, include: votes });
    }
    return this.dto(proposal, room, userId);
  }
  async decide(userId: string, roomId: string, proposalId: string, value: unknown): Promise<Proposal> {
    const decision = validateDecision(value);
    return this.transaction(async tx => {
      const room = await this.loadRoom(tx, userId, roomId);
      // 先校验格式：Prisma 对 UUID 字段传入非法字符串会抛查询错误，而不是返回空结果。
      if (!UUID_PATTERN.test(proposalId)) throw new NotFoundException('方案不存在');
      const proposal = await tx.proposal.findFirst({ where: { id: proposalId, roomId }, include: votes });
      if (!proposal) throw new NotFoundException('方案不存在');
      if (proposal.status !== 'OPEN') throw new BadRequestException('该方案已结束，请重新协商');
      if (isStale(proposal, room.version)) {
        throw new BadRequestException('圆桌成员或授权已变化，或方案已过期，请重新计算后发起');
      }
      await tx.proposalVote.update({ where: { proposalId_userId: { proposalId: proposal.id, userId } }, data: { decision, decidedAt: new Date() } });
      const start = beijingInstant(proposal.date, proposal.startTime);
      const end = beijingInstant(proposal.date, proposal.endTime);
      if (decision === 'REJECT') {
        return this.dto(await tx.proposal.update({ where: { id: proposal.id }, data: { status: 'REJECTED' }, include: votes }), room, userId);
      }
      const accepted = await tx.proposalVote.count({ where: { proposalId: proposal.id, decision: 'ACCEPT' } });
      if (accepted < room.members.length) {
        return this.dto(await tx.proposal.findFirstOrThrow({ where: { id: proposal.id }, include: votes }), room, userId);
      }
      // 全员接受：写入前最后一次冲突检查，任何成员有安排就整体放弃，避免写出互相冲突的日程。
      for (const member of room.members) {
        const conflict = await tx.arrangement.count({ where: { ownerId: member.userId, startsAt: { lt: end }, endsAt: { gt: start } } });
        if (conflict) throw new BadRequestException('有成员在该时段已有其他安排，请重新选择时间');
      }
      for (const member of room.members) {
        if (await tx.arrangement.count({ where: { ownerId: member.userId } }) >= 100) {
          throw new BadRequestException('有成员的日程已达 100 条上限，无法写入');
        }
        const input: ArrangementInput = { title: room.title, date: proposal.date, startTime: proposal.startTime, endTime: proposal.endTime };
        await tx.arrangement.create({ data: { ownerId: member.userId, title: input.title,
          startsAt: beijingInstant(input.date, input.startTime), endsAt: beijingInstant(input.date, input.endTime),
          timezone: TIME_ZONE, scope: 'PRIVATE' } });
      }
      return this.dto(await tx.proposal.update({ where: { id: proposal.id }, data: { status: 'CONFIRMED', appliedAt: new Date() }, include: votes }), room, userId);
    });
  }
}
