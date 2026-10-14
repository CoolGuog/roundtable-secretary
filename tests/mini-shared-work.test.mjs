import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const compile = page => ts.transpileModule(fs.readFileSync(`apps/miniprogram/src/pages/${page}/index.ts`, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const clone = value => JSON.parse(JSON.stringify(value));
const view = { version: 1, canManage: true, participants: [{ memberId: 'm', name: '本人', isMe: true }], tasks: [{ id: 't', title: '测试任务', details: '', dueDate: '2026-10-07', state: 'TODO', round: 0, assignee: { memberId: 'm', name: '本人', isMe: true, active: true }, votes: [], history: [], canEdit: true, canStart: true, canSubmit: true, canVote: false, canReopen: false }] };
const event = dataset => ({ currentTarget: { dataset } });
function page(name, overrides = {}) {
 let p, writes = 0, reads = 0; const timers = new Map(); let next = 0;
 const api = { getSharedWork: async () => { reads++; return clone(view); }, saveSharedTask: async () => { writes++; return { ...clone(view), version: 2 }; }, actSharedTask: async () => { writes++; return { ...clone(view), version: 2 }; },
   sharedEnabled: () => true, taskStateNames: { TODO: '待开始' }, errorMessage: error => error.message, today: () => '2026-10-07', listNotices: async () => [], readNotice: async () => { writes++; },
   loadSecretaryStatus: async () => ({ mode: 'http', connectionVerified: false }), request: async () => { writes++; return { mode: 'http', connectionVerified: true }; }, ...overrides };
 vm.runInNewContext(compile(name), { exports: {}, require: () => api, Page: value => { p = value; }, wx: { showToast() {}, stopPullDownRefresh() {}, navigateTo() {} },
   setTimeout: callback => { const id = ++next; timers.set(id, () => { timers.delete(id); callback(); }); return id; }, clearTimeout: id => timers.delete(id) });
 p.setData = value => Object.assign(p.data, value); p._visible = true; return { p, writes: () => writes, reads: () => reads, timers };
}
test('协作任务只开放本人权限按钮，旧表单不能覆盖更新，重复点击只写一次', async () => {
 let finish; const c = page('shared-work', { saveSharedTask: () => new Promise(resolve => { finish = resolve; }) }); c.p.data.id = 'room'; await c.p.reload();
 c.p.act(event({ id: 't', action: 'accept' })); assert.equal(c.p.data.editor, '');
 c.p.edit(event({})); c.p.render({ ...clone(view), version: 2 }); await c.p.save(); assert.match(c.p.data.error, /伙伴已有/);
 c.p.cancel(); c.p.edit(event({})); const pending = c.p.save(); await c.p.save(); assert.equal(c.p.data.busy, true); finish({ ...clone(view), version: 3 }); await pending; assert.equal(c.p.data.editor, ''); c.p.onHide();
});
test('协作写入失败保留输入并禁用重试，刷新后仍检查原基线，停留刷新不在编辑时运行', async () => {
 let writes = 0; const c = page('shared-work', { saveSharedTask: async () => { writes++; throw Error('连接中断'); } }); c.p.data.id = 'room'; await c.p.reload(); c.p.edit(event({})); c.p.data.title = '未提交完';
 await c.p.save(); await c.p.save(); assert.equal(writes, 1); assert.equal(c.p.data.fresh, false); assert.equal(c.p.data.title, '未提交完');
 const reads = c.reads(); [...c.timers.values()][0](); assert.equal(c.reads(), reads); c.p.onHide(); assert.equal(c.timers.size, 0);
});
test('离页后的协作读取与写入不覆盖页面，卸载不继续定时器', async () => {
 let finish; const c = page('shared-work', { getSharedWork: () => new Promise(resolve => { finish = resolve; }) }); const pending = c.p.reload(); c.p.onHide(); finish(clone(view)); await pending; assert.equal(c.p.data.view, null); assert.equal(c.timers.size, 0);
 const d = page('shared-work', { actSharedTask: () => new Promise(resolve => { finish = resolve; }) }); await d.p.reload(); d.p.act(event({ id: 't', action: 'start' })); const saving = d.p.save(); d.p.onUnload(); d.p.setData = () => assert.fail('卸载后不更新'); finish(clone(view)); await saving; assert.equal(d.timers.size, 0);
});
test('消息加载失败保留已有数据但不伪造已读，失败和离页回调均受保护', async () => {
 let finish; const c = page('notifications', { readNotice: async () => { throw Error('标记失败'); } }); c.p.data.items = [{ id: 'n', roomId: 'r', readAt: null }]; await c.p.mark(event({ id: 'n' })); assert.equal(c.p.data.items[0].readAt, null); assert.match(c.p.data.error, /失败/);
 const d = page('notifications', { listNotices: () => new Promise(resolve => { finish = resolve; }) }); const pending = d.p.reload(); d.p.onUnload(); d.p.setData = () => assert.fail('卸载后不更新'); finish([]); await pending;
});
test('连接测试必须先明确确认，取消与离页不发请求，结果不明不能自动重试', async () => {
 const c = page('model-status'); await c.p.reload(); await c.p.check(); assert.equal(c.writes(), 0); c.p.prepare(); c.p.cancel(); await c.p.check(); assert.equal(c.writes(), 0);
 c.p.prepare(); await c.p.check(); assert.equal(c.writes(), 1); assert.equal(c.p.data.status.connectionVerified, true);
 const d = page('model-status', { request: async () => { throw Error('网络中断'); } }); await d.p.reload(); d.p.prepare(); await d.p.check(); assert.equal(d.p.data.fresh, false); d.p.prepare(); assert.equal(d.p.data.confirming, false);
 c.p.prepare(); c.p.onHide(); await c.p.check(); assert.equal(c.writes(), 1);
});

const meetingView = () => ({ ...clone(view), dateFrom: '2026-10-07', dateTo: '2026-10-08', preparation: [{ id: 'p', title: '材料', details: '', dueDate: '2026-10-07', done: false, doneAt: null, assignee: { memberId: 'other', name: '伙伴', active: true }, history: [], canEdit: true, canToggle: false }], minutes: [{ revision: 1, date: '2026-10-07', summary: '旧摘要', decisions: '', nextSteps: [] }, { revision: 2, date: '2026-10-08', summary: '新摘要', decisions: '记录', nextSteps: [{ index: 0, text: '下一步', taskId: '', canImport: true }] }] });
test('共享纪要使用最新版预填；行动预览和取消不写入，显式确认才分派', async () => {
 const calls = [], c = page('shared-work', { importSharedAction: async (...args) => { calls.push(args); return meetingView(); } });
 c.p.data.id = 'room'; c.p.render(meetingView()); c.p.editMinutes(); assert.equal(c.p.data.summary, '新摘要'); c.p.cancel();
 c.p.previewAction(event({ revision: 2, index: 0 })); assert.equal(c.p.data.editor, 'import'); assert.equal(c.p.data.details, '下一步'); assert.equal(calls.length, 0); c.p.cancel(); assert.equal(calls.length, 0);
 c.p.previewAction(event({ revision: 2, index: 0 })); await c.p.save(); assert.equal(calls.length, 1); assert.deepEqual(clone(calls[0]), ['room', 2, 0, { version: 1, dueDate: '2026-10-07', assigneeMemberId: 'm' }]); assert.equal(c.p.data.tab, 'tasks'); c.p.onHide();
});
test('共享准备本人权限、旧表单防覆盖以及纪要写入失败保留内容', async () => {
 const c = page('shared-work', { saveSharedMinutes: async () => { throw Error('连接中断'); } }); c.p.render(meetingView());
 c.p.togglePreparation(event({ id: 'p' })); assert.equal(c.p.data.editor, ''); c.p.editPreparation(event({ id: 'p' })); assert.equal(c.p.data.editor, 'preparation');
 c.p.render({ ...meetingView(), version: 2 }); await c.p.save(); assert.match(c.p.data.error, /伙伴已有/); c.p.cancel(); c.p.editMinutes(); c.p.data.summary = '保留未提交摘要';
 await c.p.save(); assert.equal(c.p.data.summary, '保留未提交摘要'); assert.equal(c.p.data.fresh, false); c.p.onHide();
 const d = page('shared-work'); d.p.render({ ...meetingView(), canManage: false }); d.p.editMinutes(); d.p.editPreparation(event({})); d.p.previewAction(event({ revision: 2, index: 0 })); assert.equal(d.p.data.editor, '');
});
