import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Prisma, PrismaClient, Arrangement as DbArrangement, PersonalMemory as DbMemory } from '@prisma/client';
import { PersonalMemory, validateMemory } from './memory';
import { PostgresNegotiation } from './postgres-negotiation';
import { PostgresRooms } from './postgres-rooms';
import { createHash, randomBytes } from 'node:crypto';
import { Arrangement, PersonalStore, validateArrangement, validateArrangementPatch, validateName } from './store';
import { TIME_ZONE, beijingDate, beijingInstant, beijingTime } from './time';
import { arrangementFingerprint, assertReplay, requestKey } from './arrangement-request';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function memoryDto(item: DbMemory): PersonalMemory {
  return { id: item.id, category: item.category, label: item.label, content: item.content, source: item.source,
    createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() };
}
// 接口暂时保留 date + HH:mm；数据库统一存绝对时间，输入输出均按北京时间。
function toDto(item: DbArrangement): Arrangement {
  return { id: item.id, title: item.title, date: beijingDate(item.startsAt),
    startTime: beijingTime(item.startsAt), endTime: beijingTime(item.endsAt), createdAt: item.createdAt.toISOString() };
}

export class PostgresStore implements PersonalStore {
  readonly persistence = 'postgres' as const;
  readonly rooms: PostgresRooms;
  readonly negotiation: PostgresNegotiation;
  private constructor(private readonly db: PrismaClient, private readonly wechatAppId?: string) {
    this.rooms = new PostgresRooms(db, operation => this.transaction(operation), wechatAppId);
    this.negotiation = new PostgresNegotiation(db, operation => this.transaction(operation), wechatAppId);
  }
  static async connect(url: string, wechatAppId?: string) {
    const db = new PrismaClient({ datasources: { db: { url } }, log: [] });
    const store = new PostgresStore(db, wechatAppId);
    try { await db.$connect(); await store.checkReady(); }
    catch { await db.$disconnect(); throw new Error('数据库连接或迁移未就绪，请检查 DATABASE_URL 并执行 db:deploy'); }
    return store;
  }
  async checkReady() {
    // 只验证当前业务使用的表与列，不读取个人数据；索引、约束与迁移历史仍需部署时核对。
    await this.db.$transaction([
      this.db.$queryRaw`SELECT id, wx_app_id, wx_open_id, wx_union_id, display_name, secretary_name, created_at, updated_at FROM users LIMIT 0`,
      this.db.$queryRaw`SELECT token_hash, user_id, expires_at, created_at FROM demo_sessions LIMIT 0`,
      this.db.$queryRaw`SELECT token_hash, user_id, expires_at, created_at FROM wechat_sessions LIMIT 0`,
      this.db.$queryRaw`SELECT id, owner_id, title, starts_at, ends_at, timezone, scope, created_at, updated_at FROM arrangements LIMIT 0`,
      this.db.$queryRaw`SELECT user_id, request_key, fingerprint, arrangement_id, created_at FROM arrangement_create_requests LIMIT 0`,
      this.db.$queryRaw`SELECT id, user_id, category, label, content, source, source_ref, created_at, updated_at FROM personal_memories LIMIT 0`,
      this.db.$queryRaw`SELECT id, owner_id, title, goal, date_from, date_to, start_time, end_time, duration_minutes, status, version,
        invite_code, invite_expires_at, created_at, updated_at FROM roundtables LIMIT 0`,
      this.db.$queryRaw`SELECT id, room_id, user_id, share_busy, consent_updated_at, joined_at FROM roundtable_members LIMIT 0`,
      this.db.$queryRaw`SELECT id, room_id, date, start_time, end_time, room_version, status, created_by, expires_at, applied_at, created_at, updated_at FROM proposals LIMIT 0`,
      this.db.$queryRaw`SELECT id, proposal_id, user_id, decision, decided_at, updated_at FROM proposal_votes LIMIT 0`,
    ]);
  }
  async onModuleDestroy() { await this.db.$disconnect(); }
  private async transaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.db.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
      catch (error) {
        if (attempt >= 4 || !(error instanceof Prisma.PrismaClientKnownRequestError) || !['P2034', 'P2002'].includes(error.code)) throw error;
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
    if (this.wechatAppId) {
      const session = await this.db.wechatSession.findUnique({ where: { tokenHash: hash(token) }, include: { user: true } });
      if (!session || session.expiresAt.getTime() <= Date.now() || session.user.wxAppId !== this.wechatAppId) {
        throw new UnauthorizedException('登录已失效，请重新登录');
      }
      return session.userId;
    }
    const session = await this.db.demoSession.findUnique({ where: { tokenHash: hash(token) } });
    if (!session || session.expiresAt.getTime() <= Date.now()) throw new UnauthorizedException('演示会话已失效');
    return session.userId;
  }
  async createWechatSession(openId: string) {
    if (!this.wechatAppId) throw new Error('微信登录未启用');
    const appId = this.wechatAppId;
    const token = randomBytes(32).toString('hex');
    const expiresInSeconds = 7 * 24 * 3600;
    const user = await this.transaction(async tx => {
      const user = await tx.user.upsert({
        where: { wxAppId_wxOpenId: { wxAppId: appId, wxOpenId: openId } },
        create: { wxAppId: appId, wxOpenId: openId, displayName: '微信用户' }, update: {},
      });
      await tx.wechatSession.deleteMany({ where: { userId: user.id, expiresAt: { lte: new Date() } } });
      const older = await tx.wechatSession.findMany({ where: { userId: user.id }, orderBy: [{ createdAt: 'desc' }, { tokenHash: 'asc' }], skip: 4 });
      if (older.length) await tx.wechatSession.deleteMany({ where: { tokenHash: { in: older.map(item => item.tokenHash) } } });
      await tx.wechatSession.create({ data: { userId: user.id, tokenHash: hash(token), expiresAt: new Date(Date.now() + expiresInSeconds * 1000) } });
      return user;
    });
    return { token, user: { id: user.id, name: user.displayName, secretaryName: user.secretaryName }, expiresInSeconds, mode: 'wechat' };
  }
  async revokeSession(token: string) {
    if (this.wechatAppId) await this.db.wechatSession.deleteMany({ where: { tokenHash: hash(token) } });
    else await this.db.demoSession.deleteMany({ where: { tokenHash: hash(token) } });
  }
  async profile(userId: string) {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    return { id: user.id, name: user.displayName, secretaryName: user.secretaryName };
  }
  async list(userId: string) {
    return (await this.db.arrangement.findMany({ where: { ownerId: userId }, orderBy: [{ startsAt: 'asc' }, { id: 'asc' }] })).map(toDto);
  }
  async create(userId: string, value: unknown, requestId?: unknown) {
    const input = validateArrangement(value);
    const key = requestKey(requestId), fingerprint = arrangementFingerprint(input);
    return toDto(await this.transaction(async tx => {
      if (key) {
        const previous = await tx.arrangementCreateRequest.findUnique({ where: { userId_requestKey: { userId, requestKey: key } }, include: { arrangement: true } });
        if (previous) {
          assertReplay(previous.fingerprint, fingerprint, Boolean(previous.arrangement));
          return previous.arrangement!;
        }
      }
      if (await tx.arrangement.count({ where: { ownerId: userId } }) >= 100) throw new BadRequestException('演示最多保存 100 条安排');
      const arrangement = await tx.arrangement.create({ data: { ownerId: userId, title: input.title,
        startsAt: beijingInstant(input.date, input.startTime),
        endsAt: beijingInstant(input.date, input.endTime), timezone: TIME_ZONE, scope: 'PRIVATE' } });
      if (key) await tx.arrangementCreateRequest.create({ data: { userId, requestKey: key, fingerprint, arrangementId: arrangement.id } });
      return arrangement;
    }));
  }
  async update(userId: string, id: string, value: unknown) {
    const patch = validateArrangementPatch(value);
    if (!UUID_PATTERN.test(id)) throw new NotFoundException('安排不存在');
    return toDto(await this.transaction(async tx => {
      const existing = await tx.arrangement.findFirst({ where: { id, ownerId: userId } });
      if (!existing) throw new NotFoundException('安排不存在');
      // 只改传入的字段，未改的字段沿用原值，合并后再统一校验，避免改标题把时间改坏。
      const merged = validateArrangement({
        title: patch.title ?? existing.title,
        date: patch.date ?? beijingDate(existing.startsAt),
        startTime: patch.startTime ?? beijingTime(existing.startsAt),
        endTime: patch.endTime ?? beijingTime(existing.endsAt),
      });
      return tx.arrangement.update({ where: { id }, data: { title: merged.title,
        startsAt: beijingInstant(merged.date, merged.startTime),
        endsAt: beijingInstant(merged.date, merged.endTime), timezone: TIME_ZONE } });
    }));
  }
  async remove(userId: string, id: string) {
    if (!UUID_PATTERN.test(id)) throw new NotFoundException('安排不存在');
    const result = await this.db.arrangement.deleteMany({ where: { id, ownerId: userId } });
    if (result.count === 0) throw new NotFoundException('安排不存在');
  }
  async listMemories(userId: string) {
    return (await this.db.personalMemory.findMany({ where: { userId }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }] })).map(memoryDto);
  }
  async createMemory(userId: string, value: unknown) {
    const input = validateMemory(value);
    return memoryDto(await this.transaction(async tx => {
      if (await tx.personalMemory.count({ where: { userId } }) >= 100) throw new BadRequestException('最多保存 100 条个人记忆');
      return tx.personalMemory.create({ data: { ...input, userId, source: 'USER_INPUT' } });
    }));
  }
  async updateMemory(userId: string, id: string, value: unknown) {
    const input = validateMemory(value);
    if (!UUID_PATTERN.test(id)) throw new NotFoundException('个人记忆不存在');
    return memoryDto(await this.transaction(async tx => {
      if (!await tx.personalMemory.findFirst({ where: { id, userId } })) throw new NotFoundException('个人记忆不存在');
      return tx.personalMemory.update({ where: { id }, data: { ...input, source: 'USER_INPUT', sourceRef: null } });
    }));
  }
  async removeMemory(userId: string, id: string) {
    if (!UUID_PATTERN.test(id)) throw new NotFoundException('个人记忆不存在');
    if (!(await this.db.personalMemory.deleteMany({ where: { id, userId } })).count) throw new NotFoundException('个人记忆不存在');
  }
}
