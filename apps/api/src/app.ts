import 'reflect-metadata';
import {
  BadRequestException, Body, CanActivate, Controller, Delete, ExecutionContext,
  Get, HttpCode, Inject, Injectable, Module, NotFoundException, Param, Post, Put, Req,
  UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import {
  Arrangement, User, PersonalStore, STORE,
  validateArrangement, validateArrangementPatch, validateName,
} from './store';
import { PostgresStore } from './postgres-store';

type AuthRequest = {
  headers: { authorization?: string }; userId?: string;
};

@Injectable()
class DemoStore implements PersonalStore {
  readonly persistence = 'memory' as const;
  private readonly users = new Map<string, User>();
  private readonly sessions = new Map<string, { userId: string; expiresAt: number }>();
  private readonly arrangements = new Map<string, Map<string, Arrangement>>();
  private hash(token: string) { return createHash('sha256').update(token).digest('hex'); }

  createSession(value: unknown) {
    const name = validateName(value);
    if (this.users.size >= 100) throw new BadRequestException('演示会话已达上限，请重启演示服务');
    const user: User = { id: randomUUID(), name: name.trim(), secretaryName: '小圆' };
    const token = randomBytes(32).toString('hex');
    this.users.set(user.id, user);
    this.arrangements.set(user.id, new Map());
    this.sessions.set(this.hash(token), { userId: user.id, expiresAt: Date.now() + 3600_000 });
    return { token, user, expiresInSeconds: 3600, mode: 'local-demo' };
  }

  authenticate(token: string): string {
    const session = this.sessions.get(this.hash(token));
    if (!session || session.expiresAt <= Date.now()) throw new UnauthorizedException('演示会话已失效');
    return session.userId;
  }

  profile(userId: string) { return this.users.get(userId)!; }
  list(userId: string) {
    return [...this.arrangements.get(userId)!.values()]
      .sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`));
  }
  create(userId: string, value: unknown) {
    const input = validateArrangement(value);
    const records = this.arrangements.get(userId)!;
    if (records.size >= 100) throw new BadRequestException('演示最多保存 100 条安排');
    const item: Arrangement = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    records.set(item.id, item);
    return item;
  }
  update(userId: string, id: string, value: unknown) {
    const patch = validateArrangementPatch(value);
    const records = this.arrangements.get(userId)!;
    const existing = records.get(id);
    if (!existing) throw new NotFoundException('安排不存在');
    const merged = validateArrangement({
      title: existing.title, date: existing.date,
      startTime: existing.startTime, endTime: existing.endTime, ...patch,
    });
    const item: Arrangement = { ...merged, id: existing.id, createdAt: existing.createdAt };
    records.set(id, item);
    return item;
  }
  remove(userId: string, id: string) {
    if (!this.arrangements.get(userId)!.delete(id)) throw new NotFoundException('安排不存在');
  }
}

@Injectable()
class SessionGuard implements CanActivate {
  constructor(@Inject(STORE) private readonly store: PersonalStore) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const match = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization || '');
    if (!match) throw new UnauthorizedException('需要有效的演示会话');
    request.userId = await this.store.authenticate(match[1]);
    return true;
  }
}

@Controller()
class PublicController {
  constructor(@Inject(STORE) private readonly store: PersonalStore) {}
  @Get('health') health() {
    return { status: 'ok', mode: 'local-demo', acceptsModelKeys: false, persistence: this.store.persistence };
  }
  @Post('dev/sessions') session(@Body() body: unknown) { return this.store.createSession(body); }
}

@Controller('me')
@UseGuards(SessionGuard)
class PersonalController {
  constructor(@Inject(STORE) private readonly store: PersonalStore) {}
  @Get() profile(@Req() request: AuthRequest) { return this.store.profile(request.userId!); }
  @Get('arrangements') list(@Req() request: AuthRequest) { return this.store.list(request.userId!); }
  @Post('arrangements') create(@Req() request: AuthRequest, @Body() body: unknown) {
    return this.store.create(request.userId!, body);
  }
  // 用 PUT 而不是 PATCH：微信小程序的 wx.request 不支持 PATCH 方法。
  // 语义为"替换这条安排"，也接受只传部分字段——未传的字段保持原值。
  @Put('arrangements/:id')
  update(@Req() request: AuthRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.store.update(request.userId!, id, body);
  }
  @Delete('arrangements/:id')
  @HttpCode(204)
  remove(@Req() request: AuthRequest, @Param('id') id: string) { return this.store.remove(request.userId!, id); }
}

export async function createApp(options: { storage?: 'memory' | 'postgres'; databaseUrl?: string } = {}) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('此阶段仅支持本机演示，禁止作为生产后台启动');
  }
  const storage = options.storage ?? process.env.STORAGE_MODE ?? 'memory';
  if (storage !== 'memory' && storage !== 'postgres') throw new Error('STORAGE_MODE 仅支持 memory 或 postgres');
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (storage === 'postgres' && !databaseUrl) throw new Error('postgres 模式必须配置 DATABASE_URL');
  const store = storage === 'postgres' ? await PostgresStore.connect(databaseUrl!) : new DemoStore();
  @Module({ controllers: [PublicController, PersonalController], providers: [{ provide: STORE, useValue: store }, SessionGuard] })
  class AppModule {}
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  app.enableShutdownHooks();
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.use((_req: unknown, res: { setHeader: (key: string, value: string) => void }, next: () => void) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  return app;
}
