import test from 'node:test';
import assert from 'node:assert/strict';
import { apiOrigin, checkApi } from '../scripts/check-api.mjs';

const fetcher = (persistence = 'postgres', mode = 'local-wechat') => async (url, options) => {
  assert.equal(options.redirect, 'error'); assert.ok(options.signal);
  return Response.json(url.endsWith('/ready') ? { status: 'ready', persistence } : { status: 'ok', persistence, mode });
};

test('生产检查同时要求 HTTPS、生产标记、PostgreSQL 和微信身份', async () => {
  const responder = (persistence = 'postgres', mode = 'local-wechat', deployment = 'production') => async url => Response.json(
    url.endsWith('/ready') ? { status: 'ready', persistence } : { status: 'ok', persistence, mode, deployment });
  const strict = { requireProduction: true };
  assert.equal((await checkApi('https://api.example.com', strict, responder())).passed, true);
  for (const response of [responder('memory'), responder('postgres', 'local-demo'), responder('postgres', 'local-wechat', 'development')]) {
    assert.equal((await checkApi('https://api.example.com', strict, response)).passed, false);
  }
  assert.equal((await checkApi('http://localhost:3000', strict, responder())).passed, false);
});

test('部署只读检查接受本机 HTTP 与 HTTPS 根地址，拒绝凭证、非本机明文与额外路径', () => {
  assert.equal(apiOrigin('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000');
  assert.equal(apiOrigin('https://api.example.com'), 'https://api.example.com');
  for (const value of ['bad', 'http://api.example.com', 'https://user:secret@api.example.com', 'https://api.example.com/path', 'https://api.example.com?secret=x', 'https://api.example.com#x', 'file:///tmp']) {
    assert.throws(() => apiOrigin(value), error => !error.message.includes('secret'));
  }
});

test('符合模式的服务通过只读检查，内存或演示模式不能冒充真实环境', async () => {
  const strict = { requirePostgres: true, requireWechat: true };
  assert.equal((await checkApi('https://api.example.com', strict, fetcher())).passed, true);
  const demo = await checkApi('http://localhost:3000', strict, fetcher('memory', 'local-demo'));
  assert.equal(demo.passed, false); assert.equal(demo.liveLoginVerified, false);
  assert.equal((await checkApi('http://localhost:3000', {}, fetcher('memory', 'local-demo'))).passed, true);
});

test('存活但未就绪、模式不一致、坏响应、连接错误都失败且不回显响应中的敏感内容', async () => {
  for (const responder of [
    async url => url.endsWith('/ready') ? new Response('private database', { status: 503 }) : fetcher()(url, { redirect: 'error', signal: {} }),
    async url => Response.json(url.endsWith('/ready') ? { status: 'ready', persistence: 'memory' } : { status: 'ok', persistence: 'postgres', mode: 'local-wechat' }),
    async () => Response.json({ status: 'ok', persistence: 'secret', mode: 'private' }),
    async () => new Response('private text'),
    async () => { throw new Error('secret=private'); },
  ]) {
    const result = await checkApi('https://api.example.com', {}, responder);
    assert.equal(result.passed, false); assert.doesNotMatch(JSON.stringify(result), /secret|private/);
  }
});
