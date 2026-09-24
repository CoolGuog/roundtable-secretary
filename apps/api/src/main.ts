import { createApp } from './app';

async function main() {
  const host = process.env.HOST || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error('演示后台只允许绑定本机地址');
  }
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('无效端口');
  const app = await createApp();
  await app.listen(port, host);
  console.log(`圆桌秘书演示后台：http://${host}:${port}（内存数据，重启清空，不接收模型密钥）`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
