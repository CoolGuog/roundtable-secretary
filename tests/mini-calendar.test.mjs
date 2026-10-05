import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(fs.readFileSync('apps/miniprogram/src/pages/calendar/index.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
}).outputText;
const event = id => ({ currentTarget: { dataset: { id } } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
const display = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/miniprogram/src/services/calendar-view.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
}).outputText, { exports: display });
function setup() {
  let page;
  let time = Date.parse('2026-10-02T02:30:00Z'), timerId = 0, reads = 0;
  const timers = new Map();
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [time])); } static now() { return time; } }
  const modals = [], deleted = [], updated = [], toasts = [];
  const rows = [{ id: 'a', title: '课程讨论', date: '2026-10-02', startTime: '09:00', endTime: '10:00' },
    { id: 'b', title: '读书', date: '2026-10-02', startTime: '11:00', endTime: '12:00' }];
  const api = {
    modeLabel: () => '后台模式', errorMessage: error => error.message,
    listArrangements: async () => { reads++; return structuredClone(rows); },
    deleteArrangement: async id => { deleted.push(id); rows.splice(rows.findIndex(row => row.id === id), 1); },
    updateArrangement: async (id, fields) => { updated.push(id); Object.assign(rows.find(row => row.id === id), fields); },
  };
  vm.runInNewContext(source, { exports: {}, require: name => name.endsWith('calendar-view') ? display : api, Page: value => { page = value; }, Date: Clock,
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
    wx: { showModal: modal => modals.push(modal), showToast: toast => toasts.push(toast), switchTab() {} },
  });
  page.setData = data => Object.assign(page.data, data);
  return { page, api, rows, modals, deleted, updated, toasts, timers, reads: () => reads,
    tick(value) { time = Date.parse(value); const jobs = [...timers.values()]; timers.clear(); jobs.forEach(job => job()); },
    async open() { page.onShow(); await settle(); } };
}

test('删除确认显示具体名称，取消不写入；连续点击只打开一次弹窗', async () => {
  const c = setup(); await c.open();
  c.page.remove(event('a')); c.page.remove(event('b')); c.page.openEdit(event('b'));
  assert.equal(c.modals.length, 1); assert.equal(c.page.data.editingId, '');
  assert.match(c.modals[0].content, /课程讨论/); assert.doesNotMatch(c.modals[0].title, /演示/);
  await c.modals[0].success({ confirm: false });
  assert.equal(c.deleted.length, 0); assert.equal(c.page.data.deletingId, '');
  c.page.remove(event('b')); assert.equal(c.modals.length, 2);
});

test('确认删除后只删除目标，关闭对应编辑框并保留其他记录', async () => {
  const c = setup(); await c.open(); c.page.openEdit(event('a')); c.page.remove(event('a'));
  await c.modals[0].success({ confirm: true });
  assert.deepEqual(c.deleted, ['a']); assert.equal(c.page.data.editingId, '');
  assert.equal(c.page.data.items.length, 1); assert.equal(c.page.data.items[0].id, 'b');
  assert.equal(c.page.data.deletingId, '');
});

test('离开再返回后旧弹窗确认失效，不能删除旧页面记录', async () => {
  const c = setup(); await c.open(); c.page.remove(event('a')); c.page.onHide(); await c.open();
  await c.modals[0].success({ confirm: true }); await settle();
  assert.equal(c.deleted.length, 0); assert.equal(c.page.data.deletingId, '');
  c.page.remove(event('a')); await c.modals[1].success({ confirm: true });
  assert.deepEqual(c.deleted, ['a']);
});

test('弹窗或删除请求失败会解锁并展示错误，不自动重放删除', async () => {
  const c = setup(); await c.open(); c.page.remove(event('a')); c.modals[0].fail();
  assert.equal(c.page.data.deletingId, ''); assert.match(c.page.data.error, /确认窗口/);
  let writes = 0; c.api.deleteArrangement = async () => { writes++; throw new Error('网络中断'); };
  c.page.remove(event('a')); await c.modals[1].success({ confirm: true });
  assert.equal(writes, 1); assert.equal(c.page.data.deletingId, ''); assert.match(c.page.data.error, /网络中断/);
});

test('保存期间不能换编辑目标或删除，离页后的保存不弹成功提示', async () => {
  const c = setup(); await c.open(); const pending = deferred();
  c.api.updateArrangement = () => pending.promise;
  c.page.openEdit(event('a')); const saving = c.page.submitEdit();
  c.page.openEdit(event('b')); c.page.remove(event('a'));
  assert.equal(c.page.data.editingId, 'a'); assert.equal(c.modals.length, 0);
  c.page.onHide(); await c.open(); pending.resolve(); await saving; await settle();
  assert.equal(c.toasts.length, 0); assert.equal(c.page.data.saving, false);
  assert.equal(c.page.data.items.length, 2);
});

test('离页前的慢读取和更早的刷新不能覆盖最新列表', async () => {
  const c = setup(); await c.open(); const pending = deferred(), normalRead = c.api.listArrangements;
  c.api.listArrangements = () => pending.promise; const oldRead = c.page.reload();
  c.page.onHide(); c.rows[0].title = '最新名称'; c.api.listArrangements = normalRead; await c.open();
  pending.resolve([{ id: 'old', title: '旧会话记录' }]); await oldRead;
  assert.equal(c.page.data.items[0].title, '最新名称'); assert.equal(c.page.data.loading, false);
  const stale = deferred(); c.api.listArrangements = () => stale.promise; const first = c.page.reload();
  c.api.listArrangements = normalRead; await c.page.reload(); stale.resolve([]); await first;
  assert.equal(c.page.data.items.length, 2);
});

test('搜索和分类不额外读取或写入，清除条件恢复列表', async () => {
  const c = setup(); await c.open(); const reads = c.reads();
  c.page.onSearch({ detail: { value: '  课程 ' } });
  assert.equal(c.page.data.matchingCount, 1); assert.equal(c.page.data.items.length, 2);
  c.page.onFilter({ currentTarget: { dataset: { filter: 'upcoming' } } });
  assert.equal(c.page.data.matchingCount, 0);
  c.page.clearFilters(); assert.equal(c.page.data.matchingCount, 2); assert.equal(c.page.data.filterActive, false);
  assert.equal(c.reads(), reads); assert.equal(c.updated.length, 0); assert.equal(c.deleted.length, 0);
});

test('编辑后重新应用筛选，消失的结果不代表记录被删除', async () => {
  const c = setup(); await c.open(); c.page.onSearch({ detail: { value: '课程' } });
  c.page.openEdit(event('a')); c.page.onEditTitle({ detail: { value: '项目复盘' } });
  await c.page.submitEdit();
  assert.equal(c.page.data.matchingCount, 0); assert.equal(c.page.data.items.length, 2); assert.equal(c.page.data.query, '课程');
  assert.equal(c.page.data.editingId, ''); c.page.clearFilters();
  assert.equal(c.page.data.groups[0].records[0].title, '项目复盘');
});

test('读取期间改筛选按最新条件显示，失败不会冒充空列表成功', async () => {
  const c = setup(); await c.open(); const pending = deferred();
  c.api.listArrangements = () => pending.promise; const read = c.page.reload();
  c.page.onSearch({ detail: { value: '读书' } }); pending.resolve(structuredClone(c.rows)); await read;
  assert.equal(c.page.data.matchingCount, 1); assert.equal(c.page.data.groups[0].records[0].id, 'b');
  c.api.listArrangements = async () => { throw new Error('连接中断'); }; await c.page.reload();
  assert.equal(c.page.data.groups.length, 0); assert.equal(c.page.data.error, '连接中断');
});

test('分钟边界重算状态不请求后台，跨日更新且离页取消计时器', async () => {
  const c = setup(); await c.open(); const reads = c.reads();
  assert.equal(c.timers.size, 1); assert.equal(c.page.data.counts.past, 1);
  c.tick('2026-10-02T04:00:00Z'); assert.equal(c.page.data.counts.past, 2);
  c.page.onFilter({ currentTarget: { dataset: { filter: 'today' } } });
  c.tick('2026-10-02T16:00:00Z'); assert.equal(c.page.data.matchingCount, 0);
  assert.equal(c.reads(), reads); c.page.onHide(); assert.equal(c.timers.size, 0);
  await c.open(); assert.equal(c.timers.size, 1); c.page.onUnload(); assert.equal(c.timers.size, 0);
});
