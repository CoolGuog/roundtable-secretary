import { HttpException } from '@nestjs/common';

export const LOGIN_ACCESS = Symbol('login-access');

// 单实例总量保护；每 IP 限流由直接面向公网的 Nginx 完成，不信任客户端转发头。
export class LoginAccess {
  private attempts: number[] = [];
  private active = 0;
  constructor(private readonly now: () => number = Date.now) {}
  async run<T>(action: () => Promise<T>): Promise<T> {
    const now = this.now();
    this.attempts = this.attempts.filter(time => time > now - 60_000);
    if (this.active >= 4 || this.attempts.length >= 60) {
      throw new HttpException('登录请求较多，请稍后重试', 429);
    }
    this.attempts.push(now);
    this.active++;
    try { return await action(); } finally { this.active--; }
  }
}
