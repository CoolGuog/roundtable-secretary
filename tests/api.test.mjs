import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/api/dist/app.js';

let app, base;
before(async () => {
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
after(async () => { await app?.close(); });

async function call(path, method = 'GET', token, body) {
  return fetch(base + path, { method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function user(name) {
  const response = await call('/dev/sessions', 'POST', undefined, { name });
  assert.equal(response.status, 201);
  return response.json();
}
const sample = { title: '演示课程', date: '2026-09-23', startTime: '19:00', endTime: '20:00' };

test('健康状态明确为内存演示且不接收模型密钥', async () => {
  const response = await call('/health');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { status: 'ok', mode: 'local-demo', acceptsModelKeys: false, persistence: 'memory' });
});
test('匿名和伪造凭证不能读取个人数据', async () => {
  assert.equal((await call('/me/arrangements')).status, 401);
  assert.equal((await call('/me/arrangements', 'GET', 'a'.repeat(64))).status, 401);
});
test('保存与读取个人安排，另一用户不能读取或删除', async () => {
  const [a, b] = await Promise.all([user('甲'), user('乙')]);
  const created = await call('/me/arrangements', 'POST', a.token, sample);
  assert.equal(created.status, 201);
  const item = await created.json();
  assert.deepEqual(await (await call('/me/arrangements', 'GET', b.token)).json(), []);
  assert.equal((await call(`/me/arrangements/${item.id}`, 'DELETE', b.token)).status, 404);
  assert.equal((await (await call('/me/arrangements', 'GET', a.token)).json()).length, 1);
  assert.equal((await call(`/me/arrangements/${item.id}`, 'DELETE', a.token)).status, 204);
  assert.deepEqual(await (await call('/me/arrangements', 'GET', a.token)).json(), []);
});
test('拒绝伪造所属用户、无效日期及倒置时间', async () => {
  const a = await user('参数测试');
  for (const invalid of [
    { ...sample, ownerUserId: 'someone-else' },
    { ...sample, date: '2026-02-30' },
    { ...sample, startTime: '21:00' },
    { ...sample, startTime: '25:00' },
    { ...sample, title: ' ' },
  ]) assert.equal((await call('/me/arrangements', 'POST', a.token, invalid)).status, 400);
});
test('多用户并发写入不串号', async () => {
  const members = await Promise.all(Array.from({ length: 5 }, (_, i) => user(`并发${i}`)));
  await Promise.all(members.map((member, i) => call('/me/arrangements', 'POST', member.token, { ...sample, title: `安排${i}` })));
  for (let i = 0; i < members.length; i++) {
    const items = await (await call('/me/arrangements', 'GET', members[i].token)).json();
    assert.equal(items.length, 1);
    assert.equal(items[0].title, `安排${i}`);
  }
});
