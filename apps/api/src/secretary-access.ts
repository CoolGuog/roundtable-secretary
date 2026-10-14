import { BadRequestException, HttpException } from '@nestjs/common';
import { isIP } from 'node:net';
import { HttpModel, SecretaryService } from './secretary';

/** 只读取后台配置，不接受请求中指定服务地址、模型或密钥。 */
export function configuredHttpModel(env: Record<string, string | undefined>) {
  const apiKey = env.SECRETARY_API_KEY?.trim(), model = env.SECRETARY_MODEL?.trim();
  if (!apiKey || !model) throw new Error('http 模式需要后台 SECRETARY_API_KEY 与 SECRETARY_MODEL');
  const models = (env.SECRETARY_ALLOWED_MODELS ?? '').split(',').map(item => item.trim()).filter(Boolean);
  if (!models.includes(model)) throw new Error('SECRETARY_MODEL 必须在 SECRETARY_ALLOWED_MODELS 白名单内');
  let url: URL;
  try { url = new URL(env.SECRETARY_BASE_URL ?? 'https://api.openai.com/v1'); }
  catch { throw new Error('SECRETARY_BASE_URL 必须是有效 HTTPS 地址'); }
  const hosts = (env.SECRETARY_ALLOWED_HOSTS ?? 'api.openai.com').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port ||
      isIP(url.hostname) || url.hostname.includes(':') || !url.hostname.includes('.') || !hosts.includes(url.hostname)) {
    throw new Error('模型地址必须使用白名单中的 HTTPS 域名和标准端口，不能含凭证、查询参数或片段');
  }
  return new HttpModel({ apiKey, model, baseUrl: url.href.replace(/\/+$/, '') });
}

export const SECRETARY_ACCESS = Symbol('secretary-access');
const WINDOW_MS = 60000, PER_USER = 6, GLOBAL_CONCURRENT = 4, MAX_USERS = 10000;
/** 单进程防重复与限流；不是持久化计费额度，重启后清空。 */
export class SecretaryAccess {
  private readonly probes = new Map<string, { at: number; ok: boolean }>();
  private readonly users = new Map<string, { starts: number[]; active: boolean }>();
  private active = 0;
  constructor(private readonly secretary: SecretaryService, private readonly clock = Date.now) {}
  status(userId?: string) {
    for (const [id, result] of this.probes) if (result.at < this.clock() - 600000) this.probes.delete(id);
    const probe = userId ? this.probes.get(userId) : undefined;
    return { mode: this.secretary.mode, canGenerate: this.secretary.mode !== 'off',
      connectionVerified: this.secretary.mode === 'http' && (userId ? probe?.ok === true : Boolean(this.secretary.lastSuccessfulAt)),
      connectionCheckedAt: probe ? new Date(probe.at).toISOString() : null, model: this.secretary.modelName, acceptsModelKeys: false,
      limits: { requestsPerMinute: PER_USER, concurrentPerUser: 1, concurrentTotal: GLOBAL_CONCURRENT, persistent: false },
      message: this.secretary.mode === 'off' ? '秘书整理未开启，可以手动填写安排'
        : this.secretary.mode === 'stub' ? '使用本地规则整理，不会请求外部模型'
        : '已配置外部模型，生成时会发送你的描述和个人记忆；连接是否可用以本次结果为准' };
  }
  async probe(userId: string) {
    if (this.secretary.mode !== 'http') throw new BadRequestException('尚未配置外部模型；本地规则不能作为真实模型连接验收');
    return this.run(userId, async () => {
      // 固定虚构内容，无记忆读取，也没有日程写入；仍计入正常调用限制。
      const result = await this.secretary.draft('明天上午九点到十点进行连接测试', []);
      const ok = result.status === 'READY';
      this.status(userId);
      if (this.probes.size >= MAX_USERS && !this.probes.has(userId)) this.probes.delete(this.probes.keys().next().value!);
      this.probes.set(userId, { at: this.clock(), ok });
      return { ...this.status(userId), message: ok ? '本次外部模型返回了有效草稿。测试只用虚构内容，没有读取记忆或保存日程；结果保留 10 分钟。' : '本次连接测试未取得有效草稿，请检查后台配置或稍后手动重试。' };
    });
  }
  private reject(message: string, seconds: number): never {
    throw new HttpException({ statusCode: 429, message, retryAfterSeconds: seconds }, 429);
  }
  async run<T>(userId: string, work: () => Promise<T>): Promise<T> {
    if (this.secretary.mode === 'off') return work();
    const now = this.clock();
    // 清除过期用户，限制常驻内存；有正在执行的调用时保留锁。
    for (const [id, state] of this.users) {
      state.starts = state.starts.filter(start => start > now - WINDOW_MS);
      if (!state.active && state.starts.length === 0) this.users.delete(id);
    }
    const state = this.users.get(userId) ?? { starts: [], active: false };
    if (state.active) this.reject('上一条草稿仍在生成，请等待完成后再试', 1);
    if (state.starts.length >= PER_USER) {
      const seconds = Math.max(1, Math.ceil((state.starts[0] + WINDOW_MS - now) / 1000));
      this.reject(`草稿生成较频繁，请 ${seconds} 秒后再试`, seconds);
    }
    if (this.active >= GLOBAL_CONCURRENT || (!this.users.has(userId) && this.users.size >= MAX_USERS)) {
      this.reject('秘书当前较忙，请稍后再试', 2);
    }
    state.active = true; state.starts.push(now); this.users.set(userId, state); this.active++;
    try {
      const result = await work();
      const value = result as { model?: unknown; status?: unknown; items?: unknown } | null;
      if (this.secretary.mode === 'http' && value && value.model === this.secretary.modelName &&
          (value.status === 'READY' || (Array.isArray(value.items) && value.items.length > 0))) {
        this.status(userId);
        if (this.probes.size >= MAX_USERS && !this.probes.has(userId)) this.probes.delete(this.probes.keys().next().value!);
        this.probes.set(userId, { at: this.clock(), ok: true });
      }
      return result;
    }
    finally { state.active = false; this.active--; }
  }
}
