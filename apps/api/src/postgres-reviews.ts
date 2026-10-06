import { NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { changeReview, reviewDto, ReviewCommand, ReviewDocument, ReviewStore } from './reviews';
type Transaction = <T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
export class PostgresReviews implements ReviewStore {
  constructor(private readonly db: PrismaClient, private readonly transaction: Transaction, private readonly appId?: string) {}
  private async run(userId: string, roomId: string, command?: ReviewCommand) {
    if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(roomId)) throw new NotFoundException('圆桌不存在或你已不是成员');
    return this.transaction(async tx => {
      // 与成员变更同时访问圆桌行，串行化事务确保成员校验、版本检查及写入一致。
      await tx.$queryRaw`SELECT id FROM roundtables WHERE id = ${roomId}::uuid FOR UPDATE`;
      const room = await tx.roundtable.findFirst({ where: { id: roomId, owner: { wxAppId: this.appId ?? null }, members: { some: { userId } } },
        include: { members: { include: { user: { select: { displayName: true } } }, orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }] } } });
      if (!room) throw new NotFoundException('圆桌不存在或你已不是成员');
      const context = { ownerId: room.ownerId, dateFrom: room.dateFrom, dateTo: room.dateTo,
        participants: room.members.map(p => ({ memberId: p.id, userId: p.userId, name: p.user.displayName })) };
      const stored = await tx.meetingReview.findUnique({ where: { roomId } });
      let document = stored ? stored.document as unknown as ReviewDocument : null;
      if (command) {
        document = changeReview(context, document, userId, command);
        const data = { document: document as unknown as Prisma.InputJsonValue };
        await tx.meetingReview.upsert({ where: { roomId }, create: { roomId, ...data }, update: data });
      }
      return reviewDto(document, context, userId);
    });
  }
  get(userId: string, roomId: string) { return this.run(userId, roomId); }
  edit(userId: string, roomId: string, value: unknown) { return this.run(userId, roomId, { kind: 'edit', value }); }
  vote(userId: string, roomId: string, value: unknown) { return this.run(userId, roomId, { kind: 'vote', value }); }
}
