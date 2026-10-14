import { createApp } from '../apps/api/dist/app.js';
if (process.env.NODE_ENV === 'production') throw new Error('演示服务不允许在 production 环境启动');
// 不读取 .env；明确使用内存、演示身份和本地规则，不连接真实模型或数据库。
const app = await createApp({ storage: 'memory', authMode: 'demo', secretary: { mode: 'stub' } });
try {
  await app.listen(3302, '127.0.0.1');
  console.log('本机演示后台：http://127.0.0.1:3302；内存记录重启清空，不使用真实微信身份或模型。');
  const stop = async () => { await app.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
} catch { await app.close(); console.error('本机演示后台未能启动，请检查 3302 端口是否已被占用。'); process.exitCode = 1; }
