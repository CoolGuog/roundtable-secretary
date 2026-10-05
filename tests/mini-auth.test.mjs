import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const token = 'a'.repeat(64);
const nextToken = 'b'.repeat(64);
const key = 'roundtable.session.v2.wechat.http://127.0.0.1:3000';
const sample = { title: '虚构日程', date: '2026-10-01', startTime: '19:00', endTime: '20:00' };
function client(handler, initial = {}) {
  const storage = new Map(Object.entries(initial));
  let logins = 0;
  const calls = [];
  const wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    login: options => { logins++; queueMicrotask(() => options.success({ code: 'test-code' })); },
    request: options => { calls.push(options); queueMicrotask(() => handler(options)); },
  };
  const exports = {};
  const source = fs.readFileSync('apps/miniprogram/src/services/secretary.ts', 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = vm.createContext({ wx, exports, require: () => ({ config: { mode: 'api', authMode: 'wechat', apiBase: 'http://127.0.0.1:3000' } }) });
  vm.runInContext(js, context);
  return { api: exports, storage, calls, logins: () => logins };
}
const ok = (options, data) => options.success({ statusCode: 200, data });

test('保存响应丢失后手动重试复用编号，成功后的新保存使用新编号', async () => {
  let fail = true;
  const c = client(options => { if (fail) options.fail(); else ok(options, {}); }, { [key]: token });
  await assert.rejects(c.api.saveArrangement(sample)); fail = false; await c.api.saveArrangement(sample);
  const first = c.calls[0].header['Idempotency-Key'];
  assert.match(first, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(c.calls[1].header['Idempotency-Key'], first); assert.equal(c.calls.length, 2);
  await c.api.saveArrangement(sample); assert.notEqual(c.calls[2].header['Idempotency-Key'], first);
});

test('并发提交相同内容共用编号，编辑内容不会重用旧编号', async () => {
  const c = client(options => ok(options, {}), { [key]: token });
  await Promise.all([c.api.saveArrangement(sample), c.api.saveArrangement(sample)]);
  assert.equal(c.calls[0].header['Idempotency-Key'], c.calls[1].header['Idempotency-Key']);
  const failed = client(options => options.fail(), { [key]: token });
  await assert.rejects(failed.api.saveArrangement(sample)); await assert.rejects(failed.api.saveArrangement({ ...sample, title: '另一条安排' }));
  assert.notEqual(failed.calls[0].header['Idempotency-Key'], failed.calls[1].header['Idempotency-Key']);
});

test('并发读取共用一次 wx.login，不串成多个会话', async () => {
  const c = client(options => ok(options, options.url.endsWith('/auth/wechat') ? { token } : []));
  await Promise.all([c.api.listArrangements(), c.api.listArrangements()]);
  assert.equal(c.logins(), 1);
  assert.equal(c.calls.filter(call => call.url.endsWith('/auth/wechat')).length, 1);
  assert.equal(c.storage.get(key), token);
  assert.ok(c.calls.filter(call => call.url.endsWith('/arrangements')).every(call => call.header.Authorization === `Bearer ${token}`));
});
test('读取遇到 401 后重新登录并只重试一次', async () => {
  let reads = 0;
  const c = client(options => {
    if (options.url.endsWith('/auth/wechat')) return ok(options, { token: nextToken });
    if (++reads === 1) options.success({ statusCode: 401, data: {} });
    else ok(options, []);
  }, { [key]: token });
  await c.api.listArrangements();
  assert.equal(reads, 2);
  assert.equal(c.logins(), 1);
  assert.equal(c.storage.get(key), nextToken);
});
test('写入遇到 401 不自动重放，网络失败不清除有效令牌', async () => {
  const c = client(options => options.success({ statusCode: 401, data: {} }), { [key]: token });
  await assert.rejects(c.api.saveArrangement(sample), /登录已失效/);
  assert.equal(c.calls.length, 1);
  assert.equal(c.logins(), 0);
  assert.equal(c.storage.has(key), false);
  const failed = client(options => options.fail(), { [key]: token });
  await assert.rejects(failed.api.listArrangements(), error => error instanceof failed.api.RequestError && error.statusCode === 0 && /未收到后台响应/.test(error.message));
  assert.equal(failed.storage.get(key), token);
});

test('权限拒绝与服务故障携带状态码，网络超时写请求不自动重发', async () => {
  for (const statusCode of [403, 404, 503]) {
    const c = client(options => options.success({ statusCode, data: { message: '请求被拒绝' } }), { [key]: token });
    await assert.rejects(c.api.request('/roundtables/r', 'GET'), error => error instanceof c.api.RequestError && error.statusCode === statusCode);
    assert.equal(c.calls.length, 1); assert.equal(c.storage.get(key), token);
  }
  const c = client(options => options.fail(), { [key]: token });
  await assert.rejects(c.api.request('/roundtables/r/proposals/p', 'PUT', { decision: 'ACCEPT' }), error => error.statusCode === 0);
  assert.equal(c.calls.length, 1); assert.equal(c.storage.get(key), token);
});
test('退出登录撤销服务端会话，清理演示数据不影响微信会话', async () => {
  const c = client(options => ok(options, undefined), { [key]: token, 'roundtable.demo.arrangements.v1': [sample] });
  c.api.clearLocalDemo();
  assert.equal(c.storage.get(key), token);
  await c.api.logout();
  assert.equal(c.calls[0].method, 'DELETE');
  assert.ok(c.calls[0].url.endsWith('/me/session'));
  assert.equal(c.storage.has(key), false);
});
test('退出后到达的登录响应不能重新写入令牌', async () => {
  let release;
  const c = client(options => { release = () => ok(options, { token }); });
  const pending = c.api.login();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(release);
  await c.api.logout();
  release();
  await assert.rejects(pending, /登录已取消/);
  assert.equal(c.storage.has(key), false);
});
