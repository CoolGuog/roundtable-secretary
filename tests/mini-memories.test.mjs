import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const key = 'roundtable.demo.memories.v1';
const sample = { category: 'PREFERENCE', label: '活动时间', content: '周末下午' };
function client(mode = 'local') {
  const storage = new Map(), calls = [];
  const cache = {};
  const config = { mode, authMode: 'demo', apiBase: 'http://127.0.0.1:3000' };
  const wx = {
    getStorageSync: key => structuredClone(storage.get(key)),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: key => storage.delete(key),
    request: options => { calls.push(options); queueMicrotask(() => options.success({ statusCode: options.url.endsWith('/dev/sessions') ? 201 : 200,
      data: options.url.endsWith('/dev/sessions') ? { token: 'a'.repeat(64) } : [] })); },
  };
  function load(name) {
    if (name === './config') return { config };
    if (cache[name]) return cache[name];
    const exports = cache[name] = {};
    const source = fs.readFileSync(`apps/miniprogram/src/services/${name.slice(2)}.ts`, 'utf8');
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(js, { wx, exports, require: load });
    return exports;
  }
  return { api: load('./memories'), secretary: load('./secretary'), storage, calls };
}
test('本机记忆连续保存不丢失，编辑不新增，删除与清除演示数据正确', async () => {
  const c = client();
  await Promise.all([c.api.saveMemory(sample), c.api.saveMemory({ ...sample, label: '另一条' })]);
  const records = await c.api.listMemories();
  assert.equal(records.length, 2);
  const id = records.find(item => item.label === sample.label).id;
  await c.api.saveMemory({ ...sample, content: '  编辑后的内容  ' }, id);
  assert.equal((await c.api.listMemories()).length, 2);
  assert.equal((await c.api.listMemories()).find(item => item.id === id).content, '编辑后的内容');
  await c.api.deleteMemory(id);
  await assert.rejects(c.api.saveMemory(sample, id), /已不存在/);
  await assert.rejects(c.api.deleteMemory(id), /已不存在/);
  c.secretary.clearLocalDemo();
  assert.equal(c.storage.has(key), false);
  assert.equal(c.calls.length, 0);
});
test('本机校验与容量限制，失败不覆盖已存记录', async () => {
  const c = client();
  for (const invalid of [{ ...sample, label: ' ' }, { ...sample, content: '字'.repeat(501) }, { ...sample, category: 'INVALID' }]) {
    await assert.rejects(c.api.saveMemory(invalid));
  }
  for (let i = 0; i < 100; i++) await c.api.saveMemory(sample);
  await assert.rejects(c.api.saveMemory(sample), /100/);
  assert.equal((await c.api.listMemories()).length, 100);
});
test('API 记忆复用会话，使用 GET/POST/PUT/DELETE 且不落入本机演示存储', async () => {
  const c = client('api');
  await Promise.all([c.api.listMemories(), c.secretary.listArrangements()]);
  await c.api.saveMemory(sample);
  await c.api.saveMemory(sample, 'record-id');
  await c.api.deleteMemory('record-id');
  assert.equal(c.calls.filter(call => call.url.endsWith('/dev/sessions')).length, 1);
  assert.deepEqual(c.calls.filter(call => call.url.includes('/memories')).map(call => call.method), ['GET', 'POST', 'PUT', 'DELETE']);
  assert.ok(c.calls.filter(call => call.url.includes('/me/')).every(call => call.header.Authorization === `Bearer ${'a'.repeat(64)}`));
  assert.equal(c.storage.has(key), false);
});
