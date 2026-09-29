import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/api/dist/app.js';
import { memoryContract, sampleMemory } from './memory-contract.mjs';
import { roomContract, sampleRoom } from './room-contract.mjs';

let app, base;
before(async () => {
  app = await createApp({ storage: 'memory', authMode: 'demo' });
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

test('内存演示记忆接口', t => memoryContract(t, call, user));
test('内存演示圆桌接口', t => roomContract(t, call, user));
test('圆桌最多参与 20 个进行中的房间，关闭后释放额度', async () => {
  const a = await user('圆桌配额');
  let id;
  for (let i = 0; i < 20; i++) {
    const response = await call('/roundtables', 'POST', a.token, sampleRoom);
    assert.equal(response.status, 201); id = (await response.json()).id;
  }
  assert.equal((await call('/roundtables', 'POST', a.token, sampleRoom)).status, 400);
  await call(`/roundtables/${id}/close`, 'POST', a.token);
  assert.equal((await call('/roundtables', 'POST', a.token, sampleRoom)).status, 201);
});
test('内存演示记忆达到配额后仍可编辑与删除', async () => {
  const a = await user('记忆配额');
  let id;
  for (let i = 0; i < 100; i++) {
    const response = await call('/me/memories', 'POST', a.token, sampleMemory);
    assert.equal(response.status, 201);
    id = (await response.json()).id;
  }
  assert.equal((await call('/me/memories', 'POST', a.token, sampleMemory)).status, 400);
  assert.equal((await call(`/me/memories/${id}`, 'PUT', a.token, sampleMemory)).status, 200);
  assert.equal((await call(`/me/memories/${id}`, 'DELETE', a.token)).status, 204);
  assert.equal((await call('/me/memories', 'POST', a.token, sampleMemory)).status, 201);
});

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
test('编辑安排：整体更新与只改标题', async () => {
  const a = await user('编辑测试');
  const created = await (await call('/me/arrangements', 'POST', a.token, sample)).json();
  const updated = await call(`/me/arrangements/${created.id}`, 'PUT', a.token,
    { title: '改过的标题', date: '2026-09-24', startTime: '08:30', endTime: '09:30' });
  assert.equal(updated.status, 200);
  const whole = await updated.json();
  assert.equal(whole.title, '改过的标题');
  assert.deepEqual([whole.date, whole.startTime, whole.endTime], ['2026-09-24', '08:30', '09:30']);
  assert.equal(whole.id, created.id);

  // 只传标题时，日期与时间必须保持原值，不能被清空。
  const partial = await (await call(`/me/arrangements/${created.id}`, 'PUT', a.token, { title: '只改标题' })).json();
  assert.deepEqual([partial.date, partial.startTime, partial.endTime], ['2026-09-24', '08:30', '09:30']);
  assert.deepEqual((await (await call('/me/arrangements', 'GET', a.token)).json()).length, 1);
});
test('编辑安排：越权、不存在与非法入参', async () => {
  const [a, b] = await Promise.all([user('编辑甲'), user('编辑乙')]);
  const created = await (await call('/me/arrangements', 'POST', a.token, sample)).json();
  // 别人的安排一律按"不存在"处理，不泄露是否存在。
  assert.equal((await call(`/me/arrangements/${created.id}`, 'PUT', b.token, { title: '越权' })).status, 404);
  assert.equal((await call('/me/arrangements/not-a-uuid', 'PUT', a.token, { title: '不存在' })).status, 404);
  assert.equal((await call(`/me/arrangements/${created.id}`, 'PUT', a.token, 'not-an-object')).status, 400);
  for (const invalid of [
    {},
    { title: ' ' },
    { unknown: 1 },
    { date: '2026-02-30' },
    { startTime: '25:00' },
    { endTime: '00:00' },
  ]) assert.equal((await call(`/me/arrangements/${created.id}`, 'PUT', a.token, invalid)).status, 400);
  // 被拒绝的编辑不能改动原记录。
  assert.equal((await (await call('/me/arrangements', 'GET', a.token)).json())[0].title, sample.title);
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
