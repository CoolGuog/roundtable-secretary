import test from 'node:test';
import assert from 'node:assert/strict';
import { SecretaryAccess } from '../apps/api/dist/secretary-access.js';
import { SecretaryService } from '../apps/api/dist/secretary.js';
import { createApp } from '../apps/api/dist/app.js';
test('模型探测用虚构内容且不带记忆，成功只对本人有效，过期或失败后撤销', async () => {
 let now = 0, fail = false, seen;
 const access = new SecretaryAccess(new SecretaryService('http', { name: 'test-adapter', complete: async value => { seen = value; return fail ? null : { title: '连接测试', date: value.today, startTime: '09:00', endTime: '10:00' }; } }), () => now);
 assert.equal((await access.probe('a')).connectionVerified, true); assert.deepEqual(seen.memories, []); assert.match(seen.text, /连接测试/);
 assert.equal(access.status('b').connectionVerified, false); now = 600001; assert.equal(access.status('a').connectionVerified, false);
 await access.probe('a'); fail = true; assert.equal((await access.probe('a')).connectionVerified, false);
 for (const mode of ['off', 'stub']) await assert.rejects(new SecretaryAccess(new SecretaryService(mode)).probe('a'), /本地规则/);
});
test('连接检查接口鉴权、拒绝参数且受限流，不读取个人记忆或写日程', async () => {
 let calls = 0; const app = await createApp({ storage: 'memory', authMode: 'demo', secretary: { mode: 'http', model: { name: 'test', complete: async value => {
   calls++; assert.deepEqual(value.memories, []); return { title: '测试', date: value.today, startTime: '09:00', endTime: '10:00' }; } } } });
 try {
  await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
  const call = (route, method, token, body) => fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const token = (await (await call('/dev/sessions', 'POST', undefined, { name: '模型测试' })).json()).token;
  await call('/me/memories', 'POST', token, { category: 'NOTE', label: '私有内容', content: '不能用于连接测试' });
  const route = '/me/secretary/connection-check'; assert.equal((await call(route, 'POST', undefined, {})).status, 401);
  for (const body of [{ apiKey: 'no' }, { text: '私有内容' }, { baseUrl: 'https://invalid' }]) assert.equal((await call(route, 'POST', token, body)).status, 400);
  assert.equal(calls, 0);
  for (let i = 0; i < 6; i++) assert.equal((await call(route, 'POST', token, {})).status, 201);
  assert.equal((await call(route, 'POST', token, {})).status, 429); assert.equal(calls, 6);
  assert.deepEqual(await (await call('/me/arrangements', 'GET', token)).json(), []);
 } finally { await app.close(); }
});
