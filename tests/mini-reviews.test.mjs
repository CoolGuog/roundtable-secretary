import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const compile = file => ts.transpileModule(fs.readFileSync(`apps/miniprogram/src/${file}.ts`, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText;
const clone = value => JSON.parse(JSON.stringify(value));
const room = { id: 'room', isOwner: true, dateFrom: '2026-10-01', dateTo: '2026-10-05', members: [{ id: 'me', name: '本人', isMe: true }] };
const emptyView = { version: 0, canEdit: true, canVote: false, participants: [{ memberId: 'me', name: '本人', isMe: true, active: true }], revisions: [] };
const input = { version: 0, date: '2026-10-01', outcome: 'NOT_HELD', facts: '虚构会议未举办',
  allocations: [{ memberId: 'me', percent: 30, reason: '没有完成约定准备', action: '提前核对' }], externalPercent: 20, externalReason: '停电', unassignedPercent: 50 };
function service() {
  const storage = new Map(), exports = {};
  vm.runInNewContext(compile('services/reviews'), { exports, require: name => name.endsWith('roundtables')
    ? { isLocalRoomMode: () => true, getRoom: async () => clone(room) } : { today: () => '2026-10-05' },
    wx: { getStorageSync: key => storage.has(key) ? clone(storage.get(key)) : undefined, setStorageSync: (key, value) => storage.set(key, clone(value)) } });
  return exports;
}
test('本机复盘保留历史但不伪造多人共识，拒绝本机代签', async () => {
  const api = service(); const first = await api.saveReview('room', clone(input));
  assert.equal(first.revisions[0].status, 'DRAFT'); assert.equal(first.canVote, false);
  assert.equal(first.revisions[0].votes[0].decision, 'PENDING');
  await assert.rejects(api.voteReview('room', 1, 'ACCEPT', ''), /不能代替/);
  await api.saveReview('room', { ...clone(input), version: 1, facts: '第二次修订' });
  const view = await api.getReview('room'); assert.equal(view.revisions.length, 2); assert.equal(view.revisions[0].facts, input.facts);
});
test('本机比例及日期校验，重复并发提交只有一份生效', async () => {
  const api = service();
  for (const patch of [{ facts: '' }, { unassignedPercent: 49 }, { externalPercent: -1 }, { externalReason: '' }, { date: '2099-01-01' }]) {
    await assert.rejects(api.saveReview('room', { ...clone(input), ...patch }));
  }
  const results = await Promise.allSettled([api.saveReview('room', clone(input)), api.saveReview('room', clone(input))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await api.getReview('room')).revisions.length, 1);
});
function page(overrides = {}, local = true) {
  let instance, writes = 0;
  const api = { ...service(), getReview: async () => clone(emptyView), saveReview: async () => { writes++; return clone(emptyView); },
    voteReview: async () => { writes++; return clone(emptyView); }, ...overrides };
  class RequestError extends Error { constructor(message, statusCode) { super(message); this.statusCode = statusCode; } }
  vm.runInNewContext(compile('pages/review/index'), { exports: {}, require: name => name.endsWith('roundtables') ? { getRoom: async () => clone(room), isLocalRoomMode: () => local }
    : name.endsWith('/reviews') ? api : { errorMessage: error => error.message, RequestError, today: () => '2026-10-05' },
    wx: { showToast() {}, stopPullDownRefresh() {} }, Page: value => { instance = value; } });
  instance.setData = data => Object.assign(instance.data, data); instance._visible = true; instance.data.id = 'room';
  return { instance, writes: () => writes, RequestError };
}
function form(p) {
  p.setData({ fresh: true, room: clone(room), view: clone(emptyView) }); p.edit();
  p.setData({ facts: input.facts, date: input.date, rows: [{ ...clone(input.allocations[0]), name: '本人', percent: '30' }], externalPercent: '20', externalReason: '停电', unassignedPercent: '50' });
}
test('页面非法合计不提交；成功保存才关闭编辑，重复点击只提交一次', async () => {
  let finish, count = 0;
  const c = page({ saveReview: () => { count++; return new Promise(resolve => { finish = resolve; }); } }); form(c.instance);
  c.instance.data.unassignedPercent = '49'; await c.instance.submit(); assert.equal(count, 0);
  c.instance.data.unassignedPercent = '50'; const pending = c.instance.submit(); await c.instance.submit();
  assert.equal(count, 1); finish(clone(emptyView)); await pending; assert.equal(c.instance.data.editor, false);
});
test('写入结果不明保留表单并禁止自动重试，刷新不悄悄改写提交基线', async () => {
  let count = 0;
  const c = page({ saveReview: async () => { count++; throw new Error('未收到响应'); }, getReview: async () => ({ ...clone(emptyView), version: 2 }) }); form(c.instance);
  await c.instance.submit(); assert.equal(c.instance.data.editor, true); assert.equal(c.instance.data.fresh, false); assert.equal(c.instance.data.facts, input.facts);
  await c.instance.submit(); assert.equal(count, 1);
  await c.instance.reload(); assert.equal(c.instance.data.baseVersion, 0); assert.equal(c.instance.data.view.version, 2);
  assert.equal(c.instance.data.facts, input.facts);
  await c.instance.submit(); assert.equal(count, 1, '刷新不能让旧草稿获得新版本写权限');
});
test('离页后的读取或保存不覆盖页面，重返可读到已经完成的结果', async () => {
  let finish;
  const c = page({ getReview: () => new Promise(resolve => { finish = resolve; }) });
  const reading = c.instance.reload(); c.instance.onHide(); finish(clone(emptyView)); await reading;
  assert.equal(c.instance.data.view, null);
  const d = page({ saveReview: () => new Promise(resolve => { finish = resolve; }) }); form(d.instance);
  const writing = d.instance.submit(); d.instance.onUnload(); d.instance.setData = () => assert.fail('卸载后不可更新'); finish(clone(emptyView)); await writing;
});
test('异议必须填写说明，本机和非参与者不能表态', async () => {
  const c = page({}, false); c.instance.setData({ fresh: true, view: { ...clone(emptyView), canVote: true } });
  await c.instance.vote({ currentTarget: { dataset: { decision: 'DISPUTE' } } }); assert.equal(c.writes(), 0);
  c.instance.data.comment = '请核对原始记录'; await c.instance.vote({ currentTarget: { dataset: { decision: 'DISPUTE' } } }); assert.equal(c.writes(), 1);
  const local = page(); local.instance.setData({ fresh: true, view: { ...clone(emptyView), canVote: true } });
  await local.instance.vote({ currentTarget: { dataset: { decision: 'ACCEPT' } } }); assert.equal(local.writes(), 0);
});
