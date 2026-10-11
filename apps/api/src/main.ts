import { createApp } from './app';
import { existsSync } from 'node:fs';

async function main() {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const host = process.env.HOST || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error('后台只允许绑定本机地址，由 HTTPS 代理提供公网访问');
  }
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('无效端口');
  const app = await createApp();
  await app.listen(port, host);
  console.log(`圆桌秘书后台已启动，环境：${process.env.NODE_ENV === 'production' ? 'production' : 'development'}，端口：${port}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
