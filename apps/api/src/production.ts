import { isIP } from 'node:net';

// 只检查配置，不连接网络，也不把配置值放进错误消息。
export function assertProductionConfig(config: {
  storage: string; authMode: string; databaseUrl?: string; appId?: string; secret?: string;
  origin?: string; host?: string; secretaryMode: string; hasMock: boolean;
}) {
  if (config.storage !== 'postgres' || config.authMode !== 'wechat') {
    throw new Error('生产环境必须使用 PostgreSQL 与微信身份模式');
  }
  if (!/^wx[a-f0-9]{16}$/i.test(config.appId ?? '') || !/^[a-f0-9]{32}$/i.test(config.secret ?? '')) {
    throw new Error('生产环境需要有效的 WECHAT_APP_ID 和 WECHAT_APP_SECRET');
  }
  try {
    const db = new URL(config.databaseUrl ?? '');
    if (!['postgres:', 'postgresql:'].includes(db.protocol) || !db.hostname || !db.username || !db.password || db.pathname.length < 2) throw new Error();
  } catch { throw new Error('生产环境需要含账号、密码和库名的 PostgreSQL 连接配置'); }
  try {
    const origin = new URL(config.origin ?? '');
    if (origin.protocol !== 'https:' || origin.port || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
        !origin.hostname.includes('.') || isIP(origin.hostname) || origin.hostname.startsWith('[') || /\.(localhost|local|test|invalid)$/.test(origin.hostname)) throw new Error();
  } catch { throw new Error('PUBLIC_API_ORIGIN 必须是使用默认 HTTPS 端口的公网域名根地址'); }
  if ((config.host ?? '127.0.0.1') !== '127.0.0.1') throw new Error('生产后台仅监听 127.0.0.1，由本机 HTTPS 代理提供访问');
  if (config.secretaryMode === 'stub' || config.hasMock) throw new Error('生产环境禁止模拟微信换码和模拟模型');
}
