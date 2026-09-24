import 'reflect-metadata';
import {
  BadRequestException, Body, CanActivate, Controller, Delete, ExecutionContext,
  Get, HttpCode, Injectable, Module, NotFoundException, Param, Post, Req,
  UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomBytes, randomUUID, createHash } from 'node:crypto';

type ArrangementInput = {
  title: string; date: string; startTime: string; endTime: string;
};
type Arrangement = ArrangementInput & { id: string; createdAt: string };
type User = { id: string; name: string; secretaryName: string };
type AuthRequest = {
  headers: { authorization?: string }; userId?: string;
};

function inputObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('请求格式不正确');
  }
  return value as Record<string, unknown>;
}

function validateArrangement(value: unknown): ArrangementInput {
  const input = inputObject(value);
  const expected = ['title', 'date', 'startTime', 'endTime'];
  if (Object.keys(input).some(key => !expected.includes(key))) {
    throw new BadRequestException('不支持额外字段');
  }
  const { title, date, startTime, endTime } = input;
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 60) {
    throw new BadRequestException('请填写 1 至 60 字的安排名称');
  }
  if (typeof date !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(date)) {
    throw new BadRequestException('日期格式不正确');
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new BadRequestException('日期不存在');
  }
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (typeof startTime !== 'string' || typeof endTime !== 'string' ||
      !timePattern.test(startTime) || !timePattern.test(endTime) || startTime >= endTime) {
    throw new BadRequestException('结束时间须晚于开始时间，首版仅支持同日安排');
  }
  return { title: title.trim(), date, startTime, endTime };
}

@Injectable()
class DemoStore {
  private readonly users = new Map<string, User>();
  private readonly sessions = new Map<string, { userId: string; expiresAt: number }>();
  private readonly arrangements = new Map<string, Map<string, Arrangement>>();
  private hash(token: string) { return createHash('sha256').update(token).digest('hex'); }

  createSession(value: unknown) {
    const { name } = inputObject(value);
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 20) {
      throw new BadRequestException('名称须为 1 至 20 字');
    }
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
  remove(userId: string, id: string) {
    if (!this.arrangements.get(userId)!.delete(id)) throw new NotFoundException('安排不存在');
  }
}

@Injectable()
class SessionGuard implements CanActivate {
  constructor(private readonly store: DemoStore) {}
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const match = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization || '');
    if (!match) throw new UnauthorizedException('需要有效的演示会话');
    request.userId = this.store.authenticate(match[1]);
    return true;
  }
}

@Controller()
class PublicController {
  constructor(private readonly store: DemoStore) {}
  @Get('health') health() {
    return { status: 'ok', mode: 'local-demo', acceptsModelKeys: false, persistence: 'memory' };
  }
  @Post('dev/sessions') session(@Body() body: unknown) { return this.store.createSession(body); }
}

@Controller('me')
@UseGuards(SessionGuard)
class PersonalController {
  constructor(private readonly store: DemoStore) {}
  @Get() profile(@Req() request: AuthRequest) { return this.store.profile(request.userId!); }
  @Get('arrangements') list(@Req() request: AuthRequest) { return this.store.list(request.userId!); }
  @Post('arrangements') create(@Req() request: AuthRequest, @Body() body: unknown) {
    return this.store.create(request.userId!, body);
  }
  @Delete('arrangements/:id')
  @HttpCode(204)
  remove(@Req() request: AuthRequest, @Param('id') id: string) { this.store.remove(request.userId!, id); }
}

@Module({ controllers: [PublicController, PersonalController], providers: [DemoStore, SessionGuard] })
class AppModule {}

export async function createApp() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('此阶段仅支持本机演示，禁止作为生产后台启动');
  }
  const app = await NestFactory.create(AppModule, { logger: false });
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.use((_req: unknown, res: { setHeader: (key: string, value: string) => void }, next: () => void) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  return app;
}
