import test from 'node:test';
import assert from 'node:assert/strict';
import { assertProductionConfig } from '../apps/api/dist/production.js';
import { LoginAccess } from '../apps/api/dist/login-access.js';
import { createApp } from '../apps/api/dist/app.js';

const config = { storage: 'postgres', authMode: 'wechat', databaseUrl: 'postgresql://test:pass@127.0.0.1:5432/test',
  appId: 'wx0123456789abcdef', secret: 'a'.repeat(32), origin: 'https://api.example.com', secretaryMode: 'off', hasMock: false };

test('生产配置拒绝演示身份、模拟服务、无密码数据库和非 HTTPS 公网根地址', () => {
  assert.doesNotThrow(() => assertProductionConfig(config));
  for (const change of [{ storage: 'memory' }, { authMode: 'demo' }, { secret: '' }, { secret: 'placeholder' },
    { appId: 'touristappid' }, { databaseUrl: 'postgresql://test@localhost/test' }, { host: '0.0.0.0' },
    { secretaryMode: 'stub' }, { hasMock: true }, ...['', 'http://api.example.com', 'https://127.0.0.1', 'https://[::1]',
      'https://localhost', 'https://api.local', 'https://api.example.com:8443', 'https://api.example.com/path',
      'https://user:private@api.example.com', 'https://api.example.com?secret=private'].map(origin => ({ origin }))]) {
    assert.throws(() => assertProductionConfig({ ...config, ...change }), error => !error.message.includes('private'));
  }
});

test('生产模式缺失必要配置时在数据库连接前拒绝启动', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { await assert.rejects(createApp({ storage: 'memory', authMode: 'demo', secretary: { mode: 'off' } }), /生产环境必须/); }
  finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});

test('登录并发上限拒绝第五个请求，失败后释放槽位', async () => {
  const access = new LoginAccess();
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const calls = Array.from({ length: 4 }, () => access.run(() => pending));
  let invoked = false;
  await assert.rejects(access.run(async () => { invoked = true; }), error => error.getStatus() === 429);
  assert.equal(invoked, false);
  finish('ok'); await Promise.all(calls);
  await assert.rejects(access.run(async () => { throw new Error('upstream'); }), /upstream/);
  assert.equal(await access.run(async () => 'recovered'), 'recovered');
});

test('登录失败也计入每分钟 60 次总额度，窗口到期恢复', async () => {
  let now = 0;
  const access = new LoginAccess(() => now);
  for (let i = 0; i < 60; i++) await assert.rejects(access.run(async () => { throw new Error('invalid'); }), /invalid/);
  await assert.rejects(access.run(async () => 'not called'), error => error.getStatus() === 429);
  now = 60_000;
  assert.equal(await access.run(async () => 'ok'), 'ok');
});

test('过大 JSON 请求返回 413，普通业务请求仍可处理', async () => {
  const app = await createApp({ storage: 'memory', authMode: 'demo', secretary: { mode: 'off' } });
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const post = name => fetch(base + '/dev/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    assert.equal((await post('x'.repeat(17 * 1024))).status, 413);
    assert.equal((await post('虚构请求')).status, 201);
  } finally { await app.close(); }
});
