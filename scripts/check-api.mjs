import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function apiOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请提供有效的后台根地址'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('后台地址须为 HTTPS 根地址或本机 HTTP 根地址，不能带凭证、路径、查询或片段');
  }
  return url.origin;
}

/** 只请求两个公开只读接口；不创建账号、不提交日程、不调用微信或模型。 */
export async function checkApi(value, { requirePostgres = false, requireWechat = false, requireProduction = false } = {}, fetcher = fetch) {
  if (requireProduction) { requirePostgres = true; requireWechat = true; }
  const origin = apiOrigin(value);
  async function read(route) {
    try {
      const response = await fetcher(origin + route, { signal: AbortSignal.timeout(3000), redirect: 'error' });
      if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
      const body = await response.json();
      if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: '响应格式不正确' };
      return { ok: true, body };
    } catch { return { ok: false, reason: '连接、超时、重定向或响应解析失败' }; }
  }
  const [health, ready] = await Promise.all([read('/health'), read('/ready')]);
  const healthValid = health.ok && health.body.status === 'ok' && ['local-demo', 'local-wechat'].includes(health.body.mode)
    && ['memory', 'postgres'].includes(health.body.persistence);
  const readyValid = ready.ok && ready.body.status === 'ready' && ['memory', 'postgres'].includes(ready.body.persistence);
  const checks = [
    { item: '进程存活', passed: Boolean(healthValid), note: healthValid ? '健康接口响应正常' : health.reason ?? '健康响应字段不正确' },
    { item: '存储就绪', passed: Boolean(readyValid), note: readyValid ? '就绪接口响应正常' : ready.reason ?? '就绪响应字段不正确' },
    { item: '存储模式一致', passed: Boolean(healthValid && readyValid && health.body.persistence === ready.body.persistence), note: '健康与就绪接口应报告同一存储模式' },
  ];
  if (requirePostgres) checks.push({ item: 'PostgreSQL 模式', passed: Boolean(healthValid && readyValid && health.body.persistence === 'postgres' && ready.body.persistence === 'postgres'), note: '持久化环境不能误用内存模式' });
  if (requireWechat) checks.push({ item: '微信身份模式', passed: Boolean(healthValid && health.body.mode === 'local-wechat'), note: '仅检查后台模式，不代表真实换码通过' });
  if (requireProduction) checks.push({ item: '生产 HTTPS 环境', passed: Boolean(origin.startsWith('https:') && healthValid && health.body.deployment === 'production'), note: '要求 HTTPS 和通过生产启动校验的后台；真实登录仍需单独验收' });
  return { passed: checks.every(check => check.passed), checks,
    ...(healthValid ? { persistence: health.body.persistence, authMode: health.body.mode === 'local-wechat' ? 'wechat' : 'demo' } : {}),
    liveLoginVerified: false, note: '只验证后台公开状态；不代表 HTTPS 证书部署、微信合法域名、真实登录或真机验收通过。' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), flags = new Set(['--require-postgres', '--require-wechat', '--require-production']);
    const addresses = args.filter(arg => !arg.startsWith('--'));
    if (addresses.length > 1 || args.some(arg => arg.startsWith('--') && !flags.has(arg))) throw new Error('用法：npm run check:api -- [后台根地址] [--require-postgres] [--require-wechat] [--require-production]');
    const result = await checkApi(addresses[0] ?? 'http://127.0.0.1:3000', { requirePostgres: args.includes('--require-postgres'), requireWechat: args.includes('--require-wechat'), requireProduction: args.includes('--require-production') });
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.passed ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
