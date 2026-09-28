import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Prisma, PrismaClient, Arrangement as DbArrangement } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { Arrangement, PersonalStore, validateArrangement, validateName } from './store';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
// 接口暂时保留 date + HH:mm；数据库统一存绝对时间，输入输出均按北京时间。
function toDto(item: DbArrangement): Arrangement {
  const local = (value: Date) => new Date(value.getTime() + 8 * 3600_000).toISOString();
  return { id: item.id, title: item.title, date: local(item.startsAt).slice(0, 10),
    startTime: local(item.startsAt).slice(11, 16), endTime: local(item.endsAt).slice(11, 16), createdAt: item.createdAt.toISOString() };
}

export class PostgresStore implements PersonalStore {
  readonly persistence = 'postgres' as const;
  private constructor(private readonly db: PrismaClient) {}
  static async connect(url: string) {
    const db = new PrismaClient({ datasources: { db: { url } }, log: [] });
    try { await db.$connect(); await db.demoSession.count(); }
    catch { await db.$disconnect(); throw new Error('数据库连接或迁移未就绪，请检查 DATABASE_URL 并执行 db:deploy'); }
    return new PostgresStore(db);
  }
  async onModuleDestroy() { await this.db.$disconnect(); }
  private async transaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.db.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
      catch (error) {
        if (attempt >= 4 || !(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2034') throw error;
      }
    }
  }
  async createSession(value: unknown) {
    const name = validateName(value);
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 3600_000);
    const user = await this.transaction(async tx => {
      if (await tx.demoSession.count({ where: { expiresAt: { gt: new Date() } } }) >= 100) {
        throw new BadRequestException('有效演示会话已达上限，请等待会话过期');
      }
      return tx.user.create({ data: { displayName: name, demoSessions: { create: { tokenHash: hash(token), expiresAt } } } });
    });
    return { token, user: { id: user.id, name: user.displayName, secretaryName: user.secretaryName }, expiresInSeconds: 3600, mode: 'local-demo' };
  }
  async authenticate(token: string) {
    const session = await this.db.demoSession.findUnique({ where: { tokenHash: hash(token) } });
    if (!session || session.expiresAt.getTime() <= Date.now()) throw new UnauthorizedException('演示会话已失效');
    return session.userId;
  }
  async profile(userId: string) {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    return { id: user.id, name: user.displayName, secretaryName: user.secretaryName };
  }
  async list(userId: string) {
    return (await this.db.arrangement.findMany({ where: { ownerId: userId }, orderBy: [{ startsAt: 'asc' }, { id: 'asc' }] })).map(toDto);
  }
  async create(userId: string, value: unknown) {
    const input = validateArrangement(value);
    return toDto(await this.transaction(async tx => {
      if (await tx.arrangement.count({ where: { ownerId: userId } }) >= 100) throw new BadRequestException('演示最多保存 100 条安排');
      return tx.arrangement.create({ data: { ownerId: userId, title: input.title,
        startsAt: new Date(`${input.date}T${input.startTime}:00+08:00`),
        endsAt: new Date(`${input.date}T${input.endTime}:00+08:00`), timezone: 'Asia/Shanghai', scope: 'PRIVATE' } });
    }));
  }
  async remove(userId: string, id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new NotFoundException('安排不存在');
    const result = await this.db.arrangement.deleteMany({ where: { id, ownerId: userId } });
    if (result.count === 0) throw new NotFoundException('安排不存在');
  }
}
