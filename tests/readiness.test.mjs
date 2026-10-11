import test from 'node:test';
import assert from 'node:assert/strict';
import { Readiness } from '../apps/api/dist/readiness.js';
import { createApp } from '../apps/api/dist/app.js';
import { STORE } from '../apps/api/dist/store.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('并发就绪探测共享查询，完成后短暂缓存并在过期后重新检查', async () => {
  let calls = 0, time = 0; const pending = deferred();
  const ready = new Readiness(() => { calls++; return pending.promise; }, 1000, 100, () => time);
  const checks = Array.from({ length: 20 }, () => ready.check());
  await Promise.resolve(); assert.equal(calls, 1); pending.resolve();
  assert.ok((await Promise.all(checks)).every(Boolean));
  assert.equal(await ready.check(), true); assert.equal(calls, 1);
  time = 101; assert.equal(await ready.check(), true); assert.equal(calls, 2);
});

test('探测同步或异步报错均失败，缓存过期后可恢复，不抛出数据库原始错误', async () => {
  let time = 0, failure = 'sync';
  const ready = new Readiness(() => {
    if (failure === 'sync') throw new Error('private database details');
    if (failure === 'async') return Promise.reject(new Error('secret'));
  }, 1000, 100, () => time);
  assert.equal(await ready.check(), false);
  time = 101; failure = 'async'; assert.equal(await ready.check(), false);
  time = 202; failure = ''; assert.equal(await ready.check(), true);
});

test('超时返回不可用且不堆积新探测；底层查询完成后恢复', async () => {
  let calls = 0; const pending = deferred();
  const ready = new Readiness(() => { calls++; return pending.promise; }, 10, 0);
  assert.deepEqual(await Promise.all([ready.check(), ready.check()]), [false, false]);
  assert.equal(await ready.check(), false); assert.equal(calls, 1);
  pending.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(await ready.check(), true); assert.equal(calls, 2);
});

test('健康接口保持存活语义，就绪失败为无缓存的 503 且不泄露错误', async () => {
  const app = await createApp({ storage: 'memory', authMode: 'demo', secretary: { mode: 'off' } });
  const store = app.get(STORE); store.checkReady = () => { throw new Error('postgresql://private:secret@internal/db'); };
  try {
    await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
    assert.equal((await fetch(base + '/health')).status, 200);
    const response = await fetch(base + '/ready'); assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { message: '后台存储暂未就绪', error: 'Service Unavailable', statusCode: 503 });
  } finally { await app.close(); }
});

test('内存就绪检查不创建会话、不调用模型，响应明确标识内存存储', async () => {
  let calls = 0;
  const app = await createApp({ storage: 'memory', authMode: 'demo', secretary: { mode: 'http', model: { name: 'test', complete: async () => { calls++; return null; } } } });
  try {
    await app.listen(0, '127.0.0.1');
    const response = await fetch((await app.getUrl()) + '/ready');
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'ready', persistence: 'memory' });
    assert.equal(calls, 0);
  } finally { await app.close(); }
});
