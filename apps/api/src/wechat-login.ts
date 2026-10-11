import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { inputObject } from './store';

export type AuthMode = 'demo' | 'wechat';
export type WechatExchange = (code: string) => Promise<{ openId: string }>;
export const AUTH = Symbol('authentication');
export interface AuthRuntime {
  mode: AuthMode;
  production?: boolean;
  login?: (code: string) => Promise<unknown>;
}
export function validateLoginCode(value: unknown): string {
  const input = inputObject(value);
  if (Object.keys(input).length !== 1 || typeof input.code !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(input.code)) {
    throw new BadRequestException('请提供有效的微信登录凭证');
  }
  return input.code;
}

// 仅调用微信官方地址。AppSecret、code、session_key 不进入日志，也不返回客户端。
export function createWechatExchange(appId: string, secret: string, fetcher: typeof fetch = fetch): WechatExchange {
  return async code => {
    let data: Record<string, unknown>;
    try {
      const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
      url.search = new URLSearchParams({ appid: appId, secret, js_code: code, grant_type: 'authorization_code' }).toString();
      const response = await fetcher(url, { signal: AbortSignal.timeout(8000), redirect: 'error' });
      if (!response.ok) throw new Error('upstream');
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('format');
      data = body as Record<string, unknown>;
    } catch { throw new ServiceUnavailableException('微信登录服务暂时不可用，请稍后重试'); }
    if (data.errcode === 40029 || data.errcode === 40163) throw new BadRequestException('微信登录凭证已失效，请重新登录');
    if ((data.errcode !== undefined && data.errcode !== 0) || typeof data.openid !== 'string' ||
        !data.openid || data.openid.length > 64 || typeof data.session_key !== 'string' || !data.session_key) {
      throw new ServiceUnavailableException('微信登录服务暂时不可用，请稍后重试');
    }
    return { openId: data.openid };
  };
}
