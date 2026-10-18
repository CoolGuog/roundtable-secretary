import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { SecretaryService, HttpModel } from '../apps/api/dist/secretary.js';
import { createApp } from '../apps/api/dist/app.js';
import { repeatModules } from './mini-repeat-loader.mjs';

const base = { title: '上课', date: '2027-01-04', startTime: '08:30', endTime: '11:00', repeatKind: 'weekly', weekdays: [1,2,3,4,5], until: '2027-01-31' };
const model = items => new HttpModel({ baseUrl: 'https://api.deepseek.com', apiKey: 'fake-test-key', model: 'deepseek-flash', fetcher: async (_, options) => {
  const body = JSON.parse(options.body);
  assert.equal(body.max_tokens, 5000); assert.match(body.messages[0].content, /不用记入/);
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items, notes: ['游戏不记入'] }) } }] }));
} });
test('批量保留周规则，缺少结束日期或模糊时间留待确认，过滤模型额外字段', async () => {
  const service = new SecretaryService('http', model([base, { ...base, title: '午休', until: null }, { ...base, title: '学习', startTime: '下午', admin: true }]));
  const result = await service.drafts('工作日安排', [], new Date('2026-10-11T00:00:00Z'));
  assert.equal(result.items.length, 3); assert.equal(result.items[0].status, 'READY');
  assert.deepEqual(result.items[0].weekdays, [1,2,3,4,5]);
  assert.equal(result.items[1].status, 'NEEDS_INPUT'); assert.ok(result.items[1].missing.includes('until'));
  assert.equal(result.items[2].startTime, null); assert.equal(result.items[2].admin, undefined);
});
test('批量接口要求登录、限制输入和响应数量，不自动保存', async () => {
  const app = await createApp({ storage: 'memory', authMode: 'demo', secretary: { mode: 'http', model: model([base]) } });
  try {
    await app.listen(0, '127.0.0.1'); const url = await app.getUrl();
    const post = (path, body, token) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    assert.equal((await post('/me/secretary/drafts', { text: '上课' })).status, 401);
    const { token } = await (await post('/dev/sessions', { name: '批量测试' })).json();
    assert.equal((await post('/me/secretary/drafts', { text: 'a'.repeat(3001) }, token)).status, 400);
    assert.equal((await post('/me/secretary/drafts', { text: '上课', owner: 'other' }, token)).status, 400);
    assert.equal((await (await post('/me/secretary/drafts', { text: '上课' }, token)).json()).items.length, 1);
    assert.deepEqual(await (await fetch(url + '/me/arrangements', { headers: { Authorization: `Bearer ${token}` } })).json(), []);
  } finally { await app.close(); }
  await assert.rejects(new SecretaryService('http', model(Array(21).fill(base))).drafts('安排', []), /20|格式/);
});

function page(overrides = {}, confirm = true) {
  let p; const writes = [], dialogs = [];
  const compile = name => ts.transpileModule(fs.readFileSync(`apps/miniprogram/src/${name}.ts`, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const conflicts = {}; vm.runInNewContext(compile('services/arrangement-conflicts'), { exports: conflicts });
  const repeats = repeatModules({});
  class RequestError extends Error {}
  const api = { today: () => '2027-01-04', modeLabel: () => '测试', errorMessage: e => e.message, RequestError,
    listArrangements: async () => [], saveArrangement: async input => writes.push(input), ...overrides };
  vm.runInNewContext(compile('pages/secretary/index'), { exports: {}, require: name => name.endsWith('repeat-engine') ? repeats.get('./repeat-engine') : name.endsWith('arrangement-conflicts') ? conflicts : api,
    Page: value => p = value, wx: { showToast() {}, pageScrollTo() {}, showModal: async value => { dialogs.push(value); return { confirm }; } } });
  p.setData = patch => { for (const [key,value] of Object.entries(patch)) { const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.'); let target = p.data; for (const part of parts.slice(0,-1)) target = target[part]; target[parts.at(-1)] = value; } };
  p.data.batch = [base, { ...base, title: '午休', startTime: '12:00', endTime: '14:00' }].map(item => ({ ...item, status: 'READY', selected: true, saved: false }));
  return { p, writes, dialogs };
}
test('批量修改只更新草稿，取消确认或缺结束日期不写入', async () => {
  const { p, writes } = page({}, false);
  p.editBatch({ currentTarget: { dataset: { index: 0 } } });
  p.data.title = '修改后的课程'; await p.save(); assert.equal(writes.length, 0); assert.equal(p.data.batch[0].title, '修改后的课程');
  await p.saveBatch(); assert.equal(writes.length, 0);
  p.data.batch[1].until = null; await p.saveBatch(); assert.match(p.data.error, /结束日期/); assert.equal(writes.length, 0);
});
test('批量检测内部冲突；中途失败后重试跳过已保存项', async () => {
  let attempt = 0; const saved = [];
  const { p, dialogs } = page({ saveArrangement: async value => { if (++attempt === 2) throw Error('暂时失败'); saved.push(value.title); } });
  p.data.batch[1].startTime = '10:00';
  await p.saveBatch(); assert.match(dialogs[0].content, /重叠/); assert.equal(p.data.batch[0].saved, true); assert.equal(p.data.batch[1].saved, false);
  await p.saveBatch(); assert.deepEqual(saved, ['上课', '午休']);
});
test('课表全部保存后清空导入界面，中途失败保留文件和草稿',async()=>{
  const {p}=page();Object.assign(p.data,{courseBatch:true,courseText:'课表识别内容',courseFileName:'课表.pdf',courseImagePath:'temp.jpg',courseContext:'作息',courseNotes:['说明']});
  await p.saveBatch();assert.equal(p.data.batch.length,0);assert.equal(p.data.courseText,'');assert.equal(p.data.courseFileName,'');assert.equal(p.data.courseImagePath,'');assert.equal(p.data.courseBatch,false);
  const fail=page({saveArrangement:async()=>{throw Error('连接失败');}}).p;
  Object.assign(fail.data,{courseBatch:true,courseText:'保留文字',courseFileName:'课表.pdf'});
  await fail.saveBatch();assert.equal(fail.data.batch.length,2);assert.equal(fail.data.courseText,'保留文字');
});
