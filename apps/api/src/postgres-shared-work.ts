import { NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { changeWork, noticeDto, SharedWorkStore, WorkCommand, WorkDocument, workDto } from './shared-work';
type Transaction = <T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
export class PostgresSharedWork implements SharedWorkStore {
  constructor(private readonly db: PrismaClient, private readonly transaction: Transaction, private readonly appId?: string) {}
  private async run(userId: string, roomId: string, command?: WorkCommand) {
    if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(roomId)) throw new NotFoundException('圆桌不存在或你已不是成员');
    return this.transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM roundtables WHERE id = ${roomId}::uuid FOR UPDATE`;
      const room = await tx.roundtable.findFirst({ where: { id: roomId, owner: { wxAppId: this.appId ?? null }, members: { some: { userId } } },
        include: { members: { include: { user: { select: { displayName: true } } }, orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }] } } });
      if (!room) throw new NotFoundException('圆桌不存在或你已不是成员');
      const context = { ownerId: room.ownerId, dateFrom: room.dateFrom, dateTo: room.dateTo,
        participants: room.members.map(p => ({ memberId: p.id, userId: p.userId, name: p.user.displayName })) };
      const stored = await tx.sharedWorkspace.findUnique({ where: { roomId } }); let document = stored ? stored.document as unknown as WorkDocument : null;
      if (command) {
        document = changeWork(context, document, userId, command);
        const data = { document: document as unknown as Prisma.InputJsonValue };
        await tx.sharedWorkspace.upsert({ where: { roomId }, create: { roomId, ...data }, update: data });
      }
      return command?.kind === 'read' ? { read: true } : workDto(document, context, userId);
    });
  }
  get(userId: string, roomId: string) { return this.run(userId, roomId); }
  write(userId: string, roomId: string, command: WorkCommand) { return this.run(userId, roomId, command); }
  async notifications(userId: string) {
    const rooms = await this.db.sharedWorkspace.findMany({ where: { room: { owner: { wxAppId: this.appId ?? null }, members: { some: { userId } } } },
      include: { room: { select: { title: true } } }, orderBy: { updatedAt: 'desc' } });
    return rooms.flatMap(r => noticeDto(r.document as unknown as WorkDocument, r.roomId, r.room.title, userId))
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).slice(0, 100);
  }
}
