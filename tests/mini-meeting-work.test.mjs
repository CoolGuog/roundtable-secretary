import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const compile = path => ts.transpileModule(fs.readFileSync(`apps/miniprogram/src/${path}.ts`, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText;
const clone = value => JSON.parse(JSON.stringify(value));
const room = { id: 'room', dateFrom: '2026-10-06', dateTo: '2026-10-07' };
const work = { roomId: 'room', version: 1, tasks: [{ id: 'task', title: '准备文件', owner: '本人', dueDate: '2026-10-06', details: '', state: 'TODO', source: '', sourceLabel: '手动新增', history: [] }], preparation: [], minutes: [] };
const event = dataset => ({ currentTarget: { dataset } });
function page(overrides = {}) {
  let instance, writes = 0;
  const api = { taskLabels: { TODO: '待开始' }, getMeetingWork: async () => clone(work), saveTask: async () => { writes++; return { ...clone(work), version: 2 }; },
    changeTask: async () => { writes++; return { ...clone(work), version: 2 }; }, actionCandidates: async () => [{ source: 'review:1:m', title: '补材料', details: '补材料', owner: '本人' }],
    importActions: async () => { writes++; return { ...clone(work), version: 2 }; }, ...overrides };
  vm.runInNewContext(compile('pages/meeting-work/index'), { exports: {}, require: name => name.endsWith('/roundtables') ? { getRoom: async () => clone(room), isLocalRoomMode: () => true }
    : name.endsWith('/secretary') ? { errorMessage: error => error.message, today: () => '2026-10-06' } : api,
    wx: { showToast() {}, stopPullDownRefresh() {} }, Page: value => { instance = value; } });
  instance.setData = data => Object.assign(instance.data, data); instance._visible = true; instance.data.id = 'room';
  instance.setData({ room: clone(room), fresh: true }); instance.render(clone(work));
  return { p: instance, writes: () => writes };
}
test('来源预览不保存，取消不写入，确认与连续点击只导入一次', async () => {
  let finish, imports = 0;
  const c = page({ importActions: () => { imports++; return new Promise(resolve => { finish = resolve; }); } });
  await c.p.previewImport(event({ kind: 'review' })); assert.equal(c.writes(), 0); assert.equal(c.p.data.candidates.length, 1);
  c.p.cancel(); assert.equal(c.p.data.importKind, '');
  await c.p.previewImport(event({ kind: 'review' })); const pending = c.p.submitImport(); await c.p.submitImport();
  assert.equal(imports, 1); finish({ ...clone(work), version: 2 }); await pending; assert.equal(c.p.data.importKind, '');
});
test('保存失败保留任务表单，刷新获得新版本也不能让旧表单覆盖它', async () => {
  let calls = 0;
  const c = page({ saveTask: async () => { calls++; throw Error('写入失败'); }, getMeetingWork: async () => ({ ...clone(work), version: 3 }) });
  c.p.edit(event({ kind: 'task', id: 'task' })); c.p.data.title = '填写中'; await c.p.submit();
  assert.equal(c.p.data.title, '填写中'); assert.equal(c.p.data.editor, 'task'); assert.equal(c.p.data.fresh, false);
  await c.p.submit(); assert.equal(calls, 1); await c.p.reload(); await c.p.submit(); assert.equal(calls, 1);
  assert.equal(c.p.data.baseVersion, 1); assert.match(c.p.data.error, /新记录/);
});
test('离页的迟到预览和保存不覆盖页面，返回后重新读取', async () => {
  let finish;
  const c = page({ actionCandidates: () => new Promise(resolve => { finish = resolve; }) });
  const preview = c.p.previewImport(event({ kind: 'review' })); c.p.onHide(); finish([{ source: 'old' }]); await preview;
  assert.equal(c.p.data.importKind, ''); assert.equal(c.p.data.busy, false);
  const d = page({ saveTask: () => new Promise(resolve => { finish = resolve; }) }); d.p.edit(event({ kind: 'task' }));
  const save = d.p.submit(); d.p.onUnload(); d.p.setData = () => assert.fail('卸载后不更新'); finish(clone(work)); await save;
});
test('状态操作绑定已读版本，刷新后不能误验收新版本，表单期间不切换标签', async () => {
  const c = page(); c.p.taskAction(event({ id: 'task', action: 'start' }));
  c.p.onTab(event({ tab: 'minutes' })); assert.equal(c.p.data.tab, 'tasks');
  c.p.render({ ...clone(work), version: 2 }); await c.p.submitAction(); assert.equal(c.writes(), 0);
  c.p.cancel(); c.p.render({ ...clone(work), tasks: [{ ...work.tasks[0], state: 'DONE' }] });
  c.p.edit(event({ kind: 'task', id: 'task' })); assert.equal(c.p.data.editor, '');
});

const weekModule = {}; vm.runInNewContext(compile('services/week-view'), { exports: weekModule });
function weekPage(overrides = {}) {
  let instance, reads = 0; const timers = new Map(); let next = 0;
  const api = { listArrangements: async () => { reads++; return [{ id: 'a', title: '会议', date: '2026-10-06', startTime: '10:00', endTime: '11:00' }]; },
    localTasksForStats: async () => [], ...overrides };
  vm.runInNewContext(compile('pages/week/index'), { exports: {}, require: name => name.endsWith('week-view') ? weekModule
    : { ...api, errorMessage: error => error.message, today: () => '2026-10-06', modeLabel: () => '测试' },
    setTimeout: callback => { timers.set(++next, callback); return next; }, clearTimeout: id => timers.delete(id),
    wx: { stopPullDownRefresh() {} }, Page: value => { instance = value; } });
  instance.setData = data => Object.assign(instance.data, data); instance._visible = true;
  return { p: instance, reads: () => reads, timers };
}
test('任务统计失败仍能展示日程，失败不显示为零任务；迟到读取不能覆盖离页状态', async () => {
  const c = weekPage({ localTasksForStats: async () => { throw Error('任务存储错误'); } }); await c.p.reload();
  assert.equal(c.p.data.loaded, true); assert.equal(c.p.data.stats.count, 1); assert.equal(c.p.data.taskStatsAvailable, false); assert.match(c.p.data.taskError, /错误/);
  let finish; const d = weekPage({ listArrangements: () => new Promise(resolve => { finish = resolve; }) });
  const pending = d.p.reload(); d.p.onHide(); finish([]); await pending; assert.equal(d.p.data.loaded, false);
});
test('翻周、选择日期与分钟状态刷新不额外读取后台，离页清理计时器', async () => {
  const c = weekPage(); await c.p.reload(); c.p.scheduleClock(); c.p.next(); assert.equal(c.p.data.start, '2026-10-12');
  c.p.previous(); assert.equal(c.p.data.stats.count, 1); c.p.currentWeek();
  c.p.onDate({ detail: { value: '2020-01-06' } }); c.p.previous(); assert.equal(c.p.data.start, '2019-12-30');
  assert.equal(c.p.data.canPrevious, false); [...c.timers.values()][0](); assert.equal(c.reads(), 1);
  c.p.onHide(); assert.equal(c.p._timer, null);
});
