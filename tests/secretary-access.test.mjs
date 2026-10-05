import test from 'node:test';
import assert from 'node:assert/strict';
import { SecretaryAccess, configuredHttpModel } from '../apps/api/dist/secretary-access.js';
import { SecretaryService, HttpModel } from '../apps/api/dist/secretary.js';
import { createApp } from '../apps/api/dist/app.js';

const limited = error => error.getStatus() === 429;
test('同一账号并发调用只执行一次，其他账号独立，失败后释放锁', async () => {
  const access = new SecretaryAccess(new SecretaryService('stub'));
  let release, calls = 0;
  const first = access.run('a', () => { calls++; return new Promise(resolve => { release = resolve; }); });
  await assert.rejects(access.run('a', async () => calls++), limited);
  assert.equal(await access.run('b', async () => 'b'), 'b'); assert.equal(calls, 1);
  release('ok'); assert.equal(await first, 'ok');
  await assert.rejects(access.run('a', async () => { throw new Error('上游失败'); }), /上游失败/);
  assert.equal(await access.run('a', async () => '恢复'), '恢复');
});
test('每分钟额度到期恢复，拒绝调用不会执行回调，失败也计入调用次数', async () => {
  let now = 0, calls = 0; const access = new SecretaryAccess(new SecretaryService('stub'), () => now);
  for (let i = 0; i < 6; i++) await assert.rejects(access.run('a', async () => { calls++; throw new Error('失败'); }), /失败/);
  await assert.rejects(access.run('a', async () => calls++), error => limited(error) && error.getResponse().retryAfterSeconds === 60);
  assert.equal(calls, 6); now = 59999; await assert.rejects(access.run('a', async () => calls++), limited);
  now = 60000; await access.run('a', async () => calls++); assert.equal(calls, 7);
});
test('全局最多四条并发，释放后可恢复，未开启模式不消耗生成次数', async () => {
  const access = new SecretaryAccess(new SecretaryService('stub')), releases = [];
  const pending = Array.from({ length: 4 }, (_, i) => access.run(String(i), () => new Promise(resolve => releases.push(resolve))));
  await assert.rejects(access.run('fifth', async () => {}), limited);
  releases.forEach(release => release()); await Promise.all(pending);
  await access.run('fifth', async () => {});
  const off = new SecretaryAccess(new SecretaryService('off'));
  for (let i = 0; i < 10; i++) await off.run('a', async () => {});
  assert.equal(off.status().canGenerate, false); assert.equal(access.status().connectionVerified, false);
});
test('模型与地址白名单精确匹配，拒绝明文、凭证、IP、非标准端口和伪造域名', () => {
  const env = { SECRETARY_API_KEY: 'private-test-key', SECRETARY_MODEL: 'allowed-model', SECRETARY_ALLOWED_MODELS: 'allowed-model', SECRETARY_ALLOWED_HOSTS: 'model.example.com', SECRETARY_BASE_URL: 'https://model.example.com/v1' };
  assert.ok(configuredHttpModel(env) instanceof HttpModel);
  for (const change of [{ SECRETARY_MODEL: 'other' }, { SECRETARY_ALLOWED_MODELS: '' },
    ...['http://model.example.com/v1', 'https://model.example.com.attacker.test', 'https://user:pass@model.example.com',
      'https://model.example.com:444/v1', 'https://model.example.com/v1?key=secret', 'https://model.example.com/#fragment',
      'https://127.0.0.1', 'https://[::1]', 'not-a-url'].map(SECRETARY_BASE_URL => ({ SECRETARY_BASE_URL }))]) {
    assert.throws(() => configuredHttpModel({ ...env, ...change }), error => !error.message.includes(env.SECRETARY_API_KEY) && !error.message.includes('user:pass'));
  }
});
test('HTTP 模型不跟随重定向，网络错误仍降级为不可用', async () => {
  let calls = 0;
  const model = new HttpModel({ model: 'test', apiKey: 'private-test-key', baseUrl: 'https://model.example.com/v1', fetcher: async (_url, options) => {
    calls++; assert.equal(options.redirect, 'error'); throw new Error('模拟重定向拒绝');
  } });
  const result = await new SecretaryService('http', model).draft('明天开会', []);
  assert.equal(result.status, 'UNAVAILABLE'); assert.equal(calls, 1); assert.ok(!JSON.stringify(result).includes('private-test-key'));
});
test('真实 HTTP 状态接口鉴权且不调用模型，客户端不能指定密钥、模型或其他用户', async () => {
  let calls = 0; const app = await createApp({ storage: 'memory', authMode: 'demo', secretary: { mode: 'http', model: { name: 'test', complete: async () => { calls++; return null; } } } });
  try {
    await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
    const request = (path, token, body) => fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal((await request('/me/secretary/status')).status, 401);
    const a = await (await request('/dev/sessions', undefined, { name: '甲' })).json();
    const b = await (await request('/dev/sessions', undefined, { name: '乙' })).json();
    const status = await (await request('/me/secretary/status', a.token)).json();
    assert.equal(status.canGenerate, true); assert.equal(status.connectionVerified, false); assert.equal(status.acceptsModelKeys, false); assert.equal(calls, 0);
    for (const field of ['apiKey', 'model', 'baseUrl', 'userId']) assert.equal((await request('/me/secretary/draft', a.token, { text: '明天开会', [field]: 'forged' })).status, 400);
    for (let i = 0; i < 6; i++) assert.equal((await request('/me/secretary/draft', a.token, { text: '明天开会' })).status, 201);
    assert.equal((await request('/me/secretary/draft', a.token, { text: '明天开会' })).status, 429);
    assert.equal((await request('/me/secretary/draft', b.token, { text: '明天开会' })).status, 201); assert.equal(calls, 7);
    assert.deepEqual(await (await request('/me/arrangements', a.token)).json(), []);
  } finally { await app.close(); }
});
