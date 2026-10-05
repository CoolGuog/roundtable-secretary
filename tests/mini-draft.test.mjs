import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
class RequestError extends Error { constructor(message, statusCode) { super(message); this.statusCode = statusCode; } }
const conflictsModule = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/miniprogram/src/services/arrangement-conflicts.ts', 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: conflictsModule });
function page(result, status = { mode: 'stub', canGenerate: true, message: '本地规则' }, overrides = {}) {
  let instance, saves = 0;
  const api = { today: () => '2026-09-30', modeLabel: () => '测试', listArrangements: async () => [], saveArrangement: async () => saves++, draftFromText: async () => result, loadSecretaryStatus: async () => { if (status instanceof Error) throw status; return status; }, errorMessage: error => error.message };
  Object.assign(api, { RequestError }, overrides);
  const code = ts.transpileModule(fs.readFileSync('apps/miniprogram/src/pages/secretary/index.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(code, { exports: {}, require: name => name.endsWith('arrangement-conflicts') ? conflictsModule : api, wx: { showToast() {} }, Page: value => { instance = value; } });
  instance.setData = data => Object.assign(instance.data, data);
  instance.setData({ utterance: '开会', secretaryStatus: { mode: 'stub', canGenerate: true, message: '本地规则' } });
  return { instance, saves: () => saves };
}
test('不完整草稿清空旧字段并阻止保存，补全后才可写入', async () => {
  const c = page({ status: 'NEEDS_INPUT', title: '新安排', date: null, startTime: null, endTime: null, usedMemories: [], message: '请补全' });
  c.instance.setData({ title: '旧安排', date: '2026-10-10', startTime: '08:00', endTime: '09:00' });
  await c.instance.generate();
  assert.equal(c.instance.data.date, ''); assert.equal(c.instance.data.startTime, ''); assert.equal(c.instance.data.endTime, '');
  await c.instance.save(); assert.equal(c.saves(), 0); assert.match(c.instance.data.error, /补全/);
  c.instance.setData({ date: '2026-10-01', startTime: '09:00', endTime: '10:00' });
  await c.instance.save(); assert.equal(c.saves(), 1);
});

test('保存成功而数量读取失败时关闭表单，明确提示已保存，不留下可重复提交的内容', async () => {
  let reads = 0;
  const c = page(null, undefined, { listArrangements: async () => { if (++reads > 1) throw new Error('读取失败'); return []; } });
  c.instance.setData({ showForm: true, title: '会议', date: '2026-10-01', startTime: '09:00', endTime: '10:00' });
  await c.instance.save(); assert.equal(c.saves(), 1); assert.equal(c.instance.data.showForm, false); assert.equal(c.instance.data.title, '');
  assert.match(c.instance.data.error, /安排已保存/); await c.instance.save(); assert.equal(c.saves(), 1);
});

test('保存响应未收到时保留填写内容，并提示先查看日程或原样重试', async () => {
  const c = page(null, undefined, { saveArrangement: async () => { throw new RequestError('未响应', 0); } });
  c.instance.setData({ showForm: true, title: '会议', date: '2026-10-01', startTime: '09:00', endTime: '10:00' });
  await c.instance.save(); assert.equal(c.instance.data.showForm, true); assert.equal(c.instance.data.title, '会议');
  assert.equal(c.instance.data.saving, false); assert.match(c.instance.data.error, /原样重试/);
});

test('未开启或状态读取失败时不生成草稿，手动填写仍可用', async () => {
  const off = page(null, { mode: 'off', canGenerate: false, message: '未开启，可以手动填写' });
  await off.instance.refreshStatus(); await off.instance.generate(); assert.equal(off.instance.data.draft, null);
  assert.match(off.instance.data.error, /未开启/); off.instance.openForm(); assert.equal(off.instance.data.showForm, true);
  const failed = page(null, new Error('断网')); await failed.instance.refreshStatus();
  assert.equal(failed.instance.data.secretaryStatus, null); assert.equal(failed.instance.data.statusLoading, false);
  await failed.instance.generate(); assert.match(failed.instance.data.error, /重新读取/);
  failed.instance.openForm(); assert.equal(failed.instance.data.showForm, true);
});
test('模型不可用不显示可直接提交的旧表单，生成中不能保存', async () => {
  const c = page({ status: 'UNAVAILABLE', title: null, date: null, startTime: null, endTime: null, usedMemories: [], message: '暂不可用' });
  await c.instance.generate(); assert.equal(c.instance.data.showForm, false); assert.equal(c.instance.data.title, '');
  c.instance.setData({ drafting: true, title: '会议', date: '2026-10-01', startTime: '09:00', endTime: '10:00' });
  await c.instance.save(); assert.equal(c.saves(), 0);
});

test('本机追问携带用户修订的字段，连续补充后仍须明确保存', async () => {
  const calls = [];
  const partial = { status: 'NEEDS_INPUT', title: '开会', date: null, startTime: null, endTime: null, usedMemories: [], message: '哪一天？' };
  const c = page(partial, undefined, { draftFromText: async (text, previous) => { calls.push({ text, previous }); return partial; } });
  c.instance.setData({ secretaryStatus: { mode: 'local', canGenerate: true } });
  await c.instance.generate(); assert.equal(c.saves(), 0); assert.equal(c.instance.data.messages.length, 2);
  c.instance.setData({ title: '改过的标题', utterance: '明天' });
  await c.instance.sendReply(); assert.equal(calls[1].previous.title, '改过的标题'); assert.equal(calls[1].text, '明天');
  assert.equal(c.instance.data.turns, 2); assert.equal(c.saves(), 0);
  c.instance.setData({ turns: 6, utterance: '下午三点' }); await c.instance.sendReply(); assert.equal(calls.length, 2);
  c.instance.resetDraft(); assert.equal(c.instance.data.messages.length, 0); assert.equal(c.instance.data.draft, null);
});

test('离页或开始新安排后迟到草稿不能覆盖新页面，也不写入日程', async () => {
  for (const action of ['onHide', 'onUnload', 'resetDraft']) {
    let finish;
    const c = page(null, undefined, { draftFromText: () => new Promise(resolve => { finish = resolve; }) });
    const pending = c.instance.generate();
    c.instance[action]();
    finish({ status: 'READY', title: '旧结果', date: '2026-10-05', startTime: '15:00', endTime: '16:00', usedMemories: [], message: '旧结果' });
    await pending; assert.equal(c.instance.data.draft, null); assert.equal(c.saves(), 0);
  }
});

test('补充失败保留上轮草稿与输入，不能误增对话轮次', async () => {
  const c = page(null, undefined, { draftFromText: async () => { throw new Error('失败'); } });
  c.instance.setData({ secretaryStatus: { mode: 'local', canGenerate: true }, draft: { status: 'NEEDS_INPUT' },
    title: '保留标题', date: '', startTime: '', endTime: '', utterance: '明天', turns: 1 });
  await c.instance.sendReply(); assert.equal(c.instance.data.title, '保留标题'); assert.equal(c.instance.data.utterance, '明天');
  assert.equal(c.instance.data.turns, 1); assert.equal(c.instance.data.drafting, false);
});

const candidate = { showForm: true, title: '新会议', date: '2026-10-05', startTime: '09:30', endTime: '10:30' };
const overlap = { id: 'existing', title: '已有会议', date: '2026-10-05', startTime: '09:00', endTime: '10:00', createdAt: '' };

test('时间重叠先展示且不写入，明确再次确认后检查最新记录才保存', async () => {
  let reads = 0;
  const c = page(null, undefined, { listArrangements: async () => { reads++; return [overlap]; } });
  c.instance.setData(candidate);
  await c.instance.save({ type: 'tap' });
  assert.equal(c.saves(), 0); assert.equal(c.instance.data.conflicts[0].id, overlap.id);
  await c.instance.save(); assert.equal(c.saves(), 0, '普通确认不能绕过重叠提醒');
  await c.instance.confirmOverlap(); assert.equal(c.saves(), 1); assert.equal(reads, 4);
  assert.equal(c.instance.data.conflicts.length, 0); assert.equal(c.instance.data.showForm, false);
});

test('再次确认时冲突变化需要重新确认，草稿编辑也撤销旧授权', async () => {
  let items = [overlap];
  const c = page(null, undefined, { listArrangements: async () => items });
  c.instance.setData(candidate); await c.instance.save();
  items = [{ ...overlap, title: '伙伴更新的会议' }];
  await c.instance.confirmOverlap(); assert.equal(c.saves(), 0);
  assert.equal(c.instance.data.conflicts[0].title, '伙伴更新的会议');
  c.instance.onTitle({ detail: { value: '修改过的新会议' } });
  assert.equal(c.instance.data.conflicts.length, 0);
  await c.instance.confirmOverlap(); assert.equal(c.saves(), 0);
  await c.instance.confirmOverlap(); assert.equal(c.saves(), 1);
});

test('检查失败不宣称无冲突、不保存，保留草稿供重试', async () => {
  let failed = true;
  const c = page(null, undefined, { listArrangements: async () => { if (failed) throw new Error('断网'); return []; } });
  c.instance.setData(candidate); await c.instance.save();
  assert.equal(c.saves(), 0); assert.match(c.instance.data.error, /尚未保存/);
  assert.equal(c.instance.data.title, candidate.title); assert.equal(c.instance.data.checking, false);
  failed = false; await c.instance.save(); assert.equal(c.saves(), 1);
});

test('检查期间离页、关闭、重置、编辑或新生成均取消迟到的自动保存', async () => {
  for (const action of ['onHide', 'onUnload', 'closeForm', 'resetDraft', 'onTitle', 'onDate', 'onStart', 'onEnd', 'generate']) {
    let finish;
    const c = page({ status: 'READY', ...candidate, usedMemories: [], message: '新草稿' }, undefined,
      { listArrangements: () => new Promise(resolve => { finish = resolve; }) });
    c.instance.setData(candidate); const pending = c.instance.save();
    assert.equal(c.instance.data.checking, true);
    await c.instance[action]({ detail: { value: 'changed' } });
    finish([]); await pending;
    assert.equal(c.saves(), 0, action); assert.equal(c.instance.data.checking, false);
  }
});

test('重复点击与迟到检查不解锁较新的检查，不造成重复写入', async () => {
  const pendingReads = [];
  const c = page(null, undefined, { listArrangements: () => new Promise(resolve => pendingReads.push(resolve)) });
  c.instance.setData(candidate); const first = c.instance.save();
  await c.instance.save(); assert.equal(pendingReads.length, 1);
  c.instance.onTitle({ detail: { value: '另一条' } });
  const second = c.instance.save(); assert.equal(pendingReads.length, 2);
  pendingReads[0]([]); await first; assert.equal(c.instance.data.checking, true); assert.equal(c.saves(), 0);
  pendingReads[1]([overlap]); await second;
  assert.equal(c.instance.data.checking, false); assert.equal(c.saves(), 0); assert.equal(c.instance.data.conflicts.length, 1);
});

test('写入期间禁止修改或重复保存，卸载后不会更新页面', async () => {
  let finish, writes = 0;
  const c = page(null, undefined, { saveArrangement: () => { writes++; return new Promise(resolve => { finish = resolve; }); } });
  c.instance.setData(candidate); const pending = c.instance.save();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(c.instance.data.saving, true);
  await c.instance.save(); c.instance.onTitle({ detail: { value: '不应修改' } });
  assert.equal(c.instance.data.title, candidate.title); assert.equal(writes, 1);
  c.instance.onUnload(); c.instance.setData = () => assert.fail('卸载后不可更新');
  finish(); await pending;
});
