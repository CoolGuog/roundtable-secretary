import 'reflect-metadata';
import {
  BadRequestException, Body, CanActivate, Controller, Delete, ExecutionContext,
  Get, HttpCode, Inject, Injectable, Module, NotFoundException, Param, Post, Put, Req, Res,
  ServiceUnavailableException, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import {
  Arrangement, User, PersonalStore, STORE,
  validateArrangement, validateArrangementPatch, validateName,
} from './store';
import { PostgresStore } from './postgres-store';
import { PersonalMemory, validateMemory } from './memory';
import { MemoryNegotiation } from './negotiation';
import { MemoryRooms } from './rooms';
import { MemoryReviews } from './reviews';
import {
  SECRETARY, SecretaryModel, SecretaryMode, SecretaryService, validateSecretaryText,
} from './secretary';
import { AUTH, AuthMode, AuthRuntime, createWechatExchange, validateLoginCode, WechatExchange } from './wechat-login';
import { configuredHttpModel, SECRETARY_ACCESS, SecretaryAccess } from './secretary-access';
import { arrangementFingerprint, assertReplay, requestKey } from './arrangement-request';
import { READINESS, Readiness } from './readiness';
import { assertProductionConfig } from './production';
import { LOGIN_ACCESS, LoginAccess } from './login-access';

type AuthRequest = {
  headers: { authorization?: string; 'idempotency-key'?: string }; userId?: string;
};

@Injectable()
class DemoStore implements PersonalStore {
  readonly persistence = 'memory' as const;
  checkReady() {}
  readonly rooms = new MemoryRooms(id => this.users.get(id)!.name);
  readonly reviews = new MemoryReviews((userId, roomId) => this.rooms.reviewContext(userId, roomId));
  readonly negotiation = new MemoryNegotiation({
    room: (userId, roomId) => this.rooms.core(userId, roomId),
    arrangements: userId => this.list(userId),
    createArrangements: entries => {
      // 全部校验和预生成成功后再写，避免后一个成员满额时只写入前一个成员。
      const counts = new Map<string, number>();
      const pending = entries.map(({ userId, value }) => {
        const input = validateArrangement(value);
        const count = (counts.get(userId) ?? this.arrangements.get(userId)!.size) + 1;
        if (count > 100) throw new BadRequestException('有成员的日程已达 100 条上限，无法写入');
        counts.set(userId, count);
        return { userId, item: { ...input, id: randomUUID(), createdAt: new Date().toISOString() } };
      });
      for (const { userId, item } of pending) this.arrangements.get(userId)!.set(item.id, item);
    },
    name: userId => this.users.get(userId)!.name,
  });
  private readonly users = new Map<string, User>();
  private readonly sessions = new Map<string, { userId: string; expiresAt: number }>();
  private readonly arrangements = new Map<string, Map<string, Arrangement>>();
  private readonly memories = new Map<string, Map<string, PersonalMemory>>();
  private readonly createRequests = new Map<string, { fingerprint: string; arrangementId: string }>();
  private hash(token: string) { return createHash('sha256').update(token).digest('hex'); }

  createSession(value: unknown) {
    const name = validateName(value);
    if (this.users.size >= 100) throw new BadRequestException('演示会话已达上限，请重启演示服务');
    const user: User = { id: randomUUID(), name: name.trim(), secretaryName: '小圆' };
    const token = randomBytes(32).toString('hex');
    this.users.set(user.id, user);
    this.arrangements.set(user.id, new Map());
    this.memories.set(user.id, new Map());
    this.sessions.set(this.hash(token), { userId: user.id, expiresAt: Date.now() + 3600_000 });
    return { token, user, expiresInSeconds: 3600, mode: 'local-demo' };
  }

  authenticate(token: string): string {
    const session = this.sessions.get(this.hash(token));
    if (!session || session.expiresAt <= Date.now()) throw new UnauthorizedException('演示会话已失效');
    return session.userId;
  }
  revokeSession(token: string) { this.sessions.delete(this.hash(token)); }

  profile(userId: string) { return this.users.get(userId)!; }
  list(userId: string) {
    return [...this.arrangements.get(userId)!.values()]
      .sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`));
  }
  create(userId: string, value: unknown, requestId?: unknown) {
    const input = validateArrangement(value);
    const key = requestKey(requestId), fingerprint = arrangementFingerprint(input);
    const previous = key ? this.createRequests.get(`${userId}:${key}`) : undefined;
    const records = this.arrangements.get(userId)!;
    if (previous) {
      const existing = records.get(previous.arrangementId);
      assertReplay(previous.fingerprint, fingerprint, Boolean(existing));
      return existing!;
    }
    if (records.size >= 100) throw new BadRequestException('演示最多保存 100 条安排');
    const item: Arrangement = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    records.set(item.id, item);
    if (key) this.createRequests.set(`${userId}:${key}`, { fingerprint, arrangementId: item.id });
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
  listMemories(userId: string) {
    return [...this.memories.get(userId)!.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }
  createMemory(userId: string, value: unknown) {
    const input = validateMemory(value);
    const records = this.memories.get(userId)!;
    if (records.size >= 100) throw new BadRequestException('最多保存 100 条个人记忆');
    const now = new Date().toISOString();
    const item: PersonalMemory = { ...input, id: randomUUID(), source: 'USER_INPUT', createdAt: now, updatedAt: now };
    records.set(item.id, item);
    return item;
  }
  updateMemory(userId: string, id: string, value: unknown) {
    const input = validateMemory(value);
    const records = this.memories.get(userId)!;
    const existing = records.get(id);
    if (!existing) throw new NotFoundException('个人记忆不存在');
    const item: PersonalMemory = { ...existing, ...input, source: 'USER_INPUT', updatedAt: new Date().toISOString() };
    records.set(id, item);
    return item;
  }
  removeMemory(userId: string, id: string) {
    if (!this.memories.get(userId)!.delete(id)) throw new NotFoundException('个人记忆不存在');
  }
}

@Injectable()
class SessionGuard implements CanActivate {
  constructor(@Inject(STORE) private readonly store: PersonalStore) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const match = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization || '');
    if (!match) throw new UnauthorizedException('请先登录');
    request.userId = await this.store.authenticate(match[1]);
    return true;
  }
}

@Controller()
class PublicController {
  constructor(
    @Inject(STORE) private readonly store: PersonalStore,
    @Inject(AUTH) private readonly auth: AuthRuntime,
    @Inject(SECRETARY) private readonly secretary: SecretaryService,
    @Inject(READINESS) private readonly readiness: Readiness,
    @Inject(LOGIN_ACCESS) private readonly loginAccess: LoginAccess,
  ) {}
  @Get('health') health() {
    return {
      status: 'ok', mode: this.auth.mode === 'wechat' ? 'local-wechat' : 'local-demo',
      // 接口永不接收模型密钥，密钥只从本机 .env 读取
      acceptsModelKeys: false, persistence: this.store.persistence, secretary: this.secretary.mode,
      deployment: this.auth.production ? 'production' : 'development',
    };
  }
  @Post('dev/sessions') session(@Body() body: unknown) {
    if (this.auth.mode !== 'demo') throw new NotFoundException();
    return this.store.createSession(body);
  }
  @Get('ready') async ready() {
    if (!await this.readiness.check()) throw new ServiceUnavailableException('后台存储暂未就绪');
    return { status: 'ready', persistence: this.store.persistence };
  }
  @Post('auth/wechat') login(@Body() body: unknown) {
    if (!this.auth.login) throw new NotFoundException();
    return this.loginAccess.run(() => this.auth.login!(validateLoginCode(body)));
  }
}

@Controller('me')
@UseGuards(SessionGuard)
class PersonalController {
  constructor(@Inject(STORE) private readonly store: PersonalStore, @Inject(SECRETARY) private readonly secretary: SecretaryService,
    @Inject(SECRETARY_ACCESS) private readonly secretaryAccess: SecretaryAccess) {}
  @Get() profile(@Req() request: AuthRequest) { return this.store.profile(request.userId!); }
  @Delete('session')
  @HttpCode(204)
  logout(@Req() request: AuthRequest) { return this.store.revokeSession(request.headers.authorization!.slice(7)); }
  @Get('arrangements') list(@Req() request: AuthRequest) { return this.store.list(request.userId!); }
  @Post('arrangements') create(@Req() request: AuthRequest, @Body() body: unknown) {
    return this.store.create(request.userId!, body, request.headers['idempotency-key']);
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
  @Get('memories') listMemories(@Req() request: AuthRequest) { return this.store.listMemories(request.userId!); }
  @Post('memories') createMemory(@Req() request: AuthRequest, @Body() body: unknown) {
    return this.store.createMemory(request.userId!, body);
  }
  @Put('memories/:id') updateMemory(@Req() request: AuthRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.store.updateMemory(request.userId!, id, body);
  }
  @Delete('memories/:id')
  @HttpCode(204)
  removeMemory(@Req() request: AuthRequest, @Param('id') id: string) { return this.store.removeMemory(request.userId!, id); }
  // 第 13 步：把一句话整理成「待确认」草稿。这里只返回草稿，写入日程要走上面的保存接口。
  @Get('secretary/status') secretaryStatus() { return this.secretaryAccess.status(); }
  @Post('secretary/draft')
  async draft(@Req() request: AuthRequest, @Body() body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'text')) {
      throw new BadRequestException('草稿请求只接受 text 字段');
    }
    const text = validateSecretaryText((body as { text?: unknown } | null)?.text);
    return this.secretaryAccess.run(request.userId!, async () => this.secretary.draft(text, await this.store.listMemories(request.userId!)));
  }
}

@Controller('roundtables')
@UseGuards(SessionGuard)
class RoundtableController {
  constructor(@Inject(STORE) private readonly store: PersonalStore) {}
  @Get(':id/review') review(@Req() req: AuthRequest, @Param('id') id: string) { return this.store.reviews.get(req.userId!, id); }
  @Put(':id/review') editReview(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: unknown) { return this.store.reviews.edit(req.userId!, id, body); }
  @Put(':id/review/vote') voteReview(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: unknown) { return this.store.reviews.vote(req.userId!, id, body); }
  @Get() list(@Req() req: AuthRequest) { return this.store.rooms.list(req.userId!); }
  @Post() create(@Req() req: AuthRequest, @Body() body: unknown) { return this.store.rooms.create(req.userId!, body); }
  @Post('join') join(@Req() req: AuthRequest, @Body() body: unknown) { return this.store.rooms.join(req.userId!, body); }
  @Get(':id') get(@Req() req: AuthRequest, @Param('id') id: string) { return this.store.rooms.get(req.userId!, id); }
  @Put(':id/membership') consent(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: unknown) { return this.store.rooms.consent(req.userId!, id, body); }
  @Delete(':id/membership') @HttpCode(204)
  leave(@Req() req: AuthRequest, @Param('id') id: string) { return this.store.rooms.leave(req.userId!, id); }
  @Post(':id/invitation') rotate(@Req() req: AuthRequest, @Param('id') id: string) { return this.store.rooms.rotate(req.userId!, id); }
  @Delete(':id/members/:memberId') remove(@Req() req: AuthRequest, @Param('id') id: string, @Param('memberId') memberId: string) { return this.store.rooms.remove(req.userId!, id, memberId); }
  @Post(':id/close') close(@Req() req: AuthRequest, @Param('id') id: string) { return this.store.rooms.close(req.userId!, id); }

  // 第 15 步：共同可用时间。只返回时段，不返回任何成员的安排标题。
  @Get(':id/availability')
  availability(@Req() req: AuthRequest, @Param('id') id: string) { return this.store.negotiation.availability(req.userId!, id); }
  // 第 16 步：提出方案 → 全员确认 → 写入各自日程。
  @Get(':id/proposal')
  async currentProposal(@Req() req: AuthRequest, @Param('id') id: string, @Res({ passthrough: true }) response: { status: (code: number) => void }) {
    const proposal = await this.store.negotiation.currentProposal(req.userId!, id);
    // 没有方案时给 204 而不是空响应体，前端不必猜「空字符串」是什么意思。
    if (!proposal) { response.status(204); return; }
    return proposal;
  }
  @Post(':id/proposals')
  createProposal(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.store.negotiation.createProposal(req.userId!, id, body);
  }
  @Put(':id/proposals/:proposalId')
  decide(@Req() req: AuthRequest, @Param('id') id: string, @Param('proposalId') proposalId: string, @Body() body: unknown) {
    return this.store.negotiation.decide(req.userId!, id, proposalId, body);
  }
  @Delete(':id/proposals/:proposalId')
  cancelProposal(@Req() req: AuthRequest, @Param('id') id: string, @Param('proposalId') proposalId: string) {
    return this.store.negotiation.cancel(req.userId!, id, proposalId);
  }
}

export async function createApp(options: {
  storage?: 'memory' | 'postgres'; databaseUrl?: string; authMode?: AuthMode;
  wechatAppId?: string; wechatSecret?: string; wechatExchange?: WechatExchange;
  secretary?: { mode?: SecretaryMode; model?: SecretaryModel | null };
} = {}) {
  const production = process.env.NODE_ENV === 'production';
  const storage = options.storage ?? process.env.STORAGE_MODE ?? 'memory';
  if (storage !== 'memory' && storage !== 'postgres') throw new Error('STORAGE_MODE 仅支持 memory 或 postgres');
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  const authMode = options.authMode ?? process.env.AUTH_MODE ?? 'demo';
  if (authMode !== 'demo' && authMode !== 'wechat') throw new Error('AUTH_MODE 仅支持 demo 或 wechat');
  const appId = options.wechatAppId ?? process.env.WECHAT_APP_ID;
  const secret = options.wechatSecret ?? process.env.WECHAT_APP_SECRET;
  if (authMode === 'wechat' && (storage !== 'postgres' || !appId || !/^wx[a-f0-9]{16}$/i.test(appId) || (!secret && !options.wechatExchange))) {
    throw new Error('微信登录需要 postgres 模式、有效 WECHAT_APP_ID 和后台 WECHAT_APP_SECRET');
  }
  if (storage === 'postgres' && !databaseUrl) throw new Error('postgres 模式必须配置 DATABASE_URL');
  // 模型密钥只从本机 .env 读取：接口不接受密钥，也不把密钥写入数据库或日志。
  const secretaryMode = (options.secretary?.mode ?? process.env.SECRETARY_MODE ?? 'off') as SecretaryMode;
  if (!['off', 'stub', 'http'].includes(secretaryMode)) throw new Error('SECRETARY_MODE 仅支持 off、stub 或 http');
  if (production) assertProductionConfig({ storage, authMode, databaseUrl, appId, secret,
    origin: process.env.PUBLIC_API_ORIGIN, host: process.env.HOST, secretaryMode,
    hasMock: Boolean(options.wechatExchange || options.secretary?.model),
  });
  let secretaryModel = options.secretary?.model ?? null;
  if (!secretaryModel && secretaryMode === 'http') {
    secretaryModel = configuredHttpModel(process.env);
  }
  const secretary = new SecretaryService(secretaryMode, secretaryModel ?? undefined);
  const secretaryAccess = new SecretaryAccess(secretary);
  // 配置校验全部通过后再连接数据库，避免无效模型配置留下数据库连接。
  const store = storage === 'postgres' ? await PostgresStore.connect(databaseUrl!, authMode === 'wechat' ? appId : undefined) : new DemoStore();
  const auth: AuthRuntime = { mode: authMode, production };
  if (authMode === 'wechat' && store instanceof PostgresStore) {
    const exchange = options.wechatExchange ?? createWechatExchange(appId!, secret!);
    auth.login = async code => store.createWechatSession((await exchange(code)).openId);
  }
  @Module({
    controllers: [PublicController, PersonalController, RoundtableController],
    providers: [
      { provide: STORE, useValue: store }, { provide: AUTH, useValue: auth },
      { provide: SECRETARY, useValue: secretary }, { provide: SECRETARY_ACCESS, useValue: secretaryAccess }, SessionGuard,
      { provide: READINESS, useValue: new Readiness(() => store.checkReady()) },
      { provide: LOGIN_ACCESS, useValue: new LoginAccess() },
    ],
  })
  class AppModule {}
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false, abortOnError: false, bodyParser: false });
  app.useBodyParser('json', { limit: '16kb' });
  app.enableShutdownHooks();
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.use((_req: unknown, res: { setHeader: (key: string, value: string) => void }, next: () => void) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  return app;
}
