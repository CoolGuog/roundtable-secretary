import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { Room, RoomStore, newInvitation, requireOpen, requireOwner, validateConsent, validateInvite, validateRoom } from './rooms';

const include = { members: { include: { user: { select: { displayName: true } } }, orderBy: [{ joinedAt: 'asc' as const }, { id: 'asc' as const }] } };
type DbRoom = Prisma.RoundtableGetPayload<{ include: typeof include }>;
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
type Transaction = <T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
function dto(room: DbRoom, userId: string): Room {
  return { id: room.id, title: room.title, goal: room.goal, dateFrom: room.dateFrom, dateTo: room.dateTo, startTime: room.startTime, endTime: room.endTime,
    durationMinutes: room.durationMinutes, status: room.status, version: room.version, createdAt: room.createdAt.toISOString(), isOwner: room.ownerId === userId,
    ...(room.ownerId === userId && room.status === 'OPEN' ? { inviteCode: room.inviteCode, inviteExpiresAt: room.inviteExpiresAt.toISOString() } : {}),
    members: room.members.map(member => ({ id: member.id, name: member.user.displayName, role: member.userId === room.ownerId ? 'OWNER' : 'MEMBER', isMe: member.userId === userId, shareBusy: member.shareBusy, consentUpdatedAt: member.consentUpdatedAt?.toISOString() ?? null })) };
}
export class PostgresRooms implements RoomStore {
  constructor(private readonly db: PrismaClient, private readonly transaction: Transaction, private readonly appId?: string) {}
  private where(userId: string): Prisma.RoundtableWhereInput { return { members: { some: { userId } }, owner: { wxAppId: this.appId ?? null } }; }
  private async accessible(tx: Prisma.TransactionClient, userId: string, id: string) {
    if (!uuid.test(id)) throw new NotFoundException('圆桌不存在或你已不是成员');
    const room = await tx.roundtable.findFirst({ where: { id, ...this.where(userId) }, include });
    if (!room) throw new NotFoundException('圆桌不存在或你已不是成员');
    return room;
  }
  private async quota(tx: Prisma.TransactionClient, userId: string) {
    if (await tx.roundtable.count({ where: { status: 'OPEN', ...this.where(userId) } }) >= 20) throw new BadRequestException('最多同时参与 20 个进行中的圆桌');
  }
  async list(userId: string) { return (await this.db.roundtable.findMany({ where: this.where(userId), include, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] })).map(room => dto(room, userId)); }
  async get(userId: string, id: string) { return dto(await this.accessible(this.db, userId, id), userId); }
  async create(userId: string, value: unknown) {
    const input = validateRoom(value);
    return this.transaction(async tx => {
      await this.quota(tx, userId);
      return dto(await tx.roundtable.create({ data: { ...input, ownerId: userId, ...newInvitation(), members: { create: { userId } } }, include }), userId);
    });
  }
  async join(userId: string, value: unknown) {
    const code = validateInvite(value);
    return this.transaction(async tx => {
      const room = await tx.roundtable.findFirst({ where: { inviteCode: code, status: 'OPEN', inviteExpiresAt: { gt: new Date() }, owner: { wxAppId: this.appId ?? null } }, include });
      if (!room) throw new NotFoundException('邀请码无效、已过期或圆桌已关闭');
      if (room.members.some(member => member.userId === userId)) return dto(room, userId);
      await this.quota(tx, userId);
      if (room.members.length >= 3) throw new BadRequestException('圆桌已满，首版最多 3 人');
      return dto(await tx.roundtable.update({ where: { id: room.id }, data: { version: { increment: 1 }, members: { create: { userId } } }, include }), userId);
    });
  }
  async consent(userId: string, id: string, value: unknown) {
    const shareBusy = validateConsent(value);
    return this.transaction(async tx => {
      const room = await this.accessible(tx, userId, id); requireOpen(room.status);
      const member = room.members.find(member => member.userId === userId)!;
      if (member.shareBusy === shareBusy) return dto(room, userId);
      await tx.roundtableMember.update({ where: { id: member.id }, data: { shareBusy, consentUpdatedAt: new Date() } });
      return dto(await tx.roundtable.update({ where: { id }, data: { version: { increment: 1 } }, include }), userId);
    });
  }
  async rotate(userId: string, id: string) {
    return this.transaction(async tx => {
      const room = await this.accessible(tx, userId, id); requireOwner(room.ownerId, userId); requireOpen(room.status);
      return dto(await tx.roundtable.update({ where: { id }, data: { ...newInvitation(), version: { increment: 1 } }, include }), userId);
    });
  }
  async remove(userId: string, id: string, memberId: string) {
    return this.transaction(async tx => {
      const room = await this.accessible(tx, userId, id); requireOwner(room.ownerId, userId); requireOpen(room.status);
      const member = room.members.find(member => member.id === memberId);
      if (!member) throw new NotFoundException('成员不存在');
      if (member.userId === userId) throw new BadRequestException('发起人不能移除自己，请关闭圆桌');
      await tx.roundtableMember.delete({ where: { id: memberId } });
      return dto(await tx.roundtable.update({ where: { id }, data: { ...newInvitation(), version: { increment: 1 } }, include }), userId);
    });
  }
  async leave(userId: string, id: string) {
    await this.transaction(async tx => {
      const room = await this.accessible(tx, userId, id);
      if (room.ownerId === userId) throw new BadRequestException('发起人不能退出，请关闭圆桌');
      await tx.roundtableMember.deleteMany({ where: { roomId: id, userId } });
      await tx.roundtable.update({ where: { id }, data: { version: { increment: 1 } } });
    });
  }
  async close(userId: string, id: string) {
    return this.transaction(async tx => {
      const room = await this.accessible(tx, userId, id); requireOwner(room.ownerId, userId);
      if (room.status === 'CLOSED') return dto(room, userId);
      await tx.roundtableMember.updateMany({ where: { roomId: id }, data: { shareBusy: false, consentUpdatedAt: new Date() } });
      return dto(await tx.roundtable.update({ where: { id }, data: { status: 'CLOSED', version: { increment: 1 } }, include }), userId);
    });
  }
}
