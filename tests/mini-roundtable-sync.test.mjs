import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

class RequestError extends Error { constructor(message, statusCode) { super(message); this.statusCode = statusCode; } }
const room = () => ({ id: 'r', title: '伙伴活动', status: 'OPEN', version: 1, isOwner: true, members: [{ id: 'm', name: '我', isMe: true, shareBusy: true }] });
const proposal = status => ({ id: 'p', status, stale: false, createdByMe: true, votes: [{ name: '伙伴', isMe: false, decision: status === 'CONFIRMED' ? 'ACCEPT' : 'PENDING', decidedAt: null }] });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
const source = ts.transpileModule(fs.readFileSync('apps/miniprogram/src/pages/roundtable/index.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
}).outputText;
function setup(local = false) {
  let page, nextTimer = 0, stopped = 0, reads = 0, writes = 0, modal;
  const timers = new Map();
  const state = { room: room(), proposal: proposal('OPEN'), availability: { slots: [{ date: '2026-10-01', startTime: '09:00', endTime: '10:00' }] } };
  const api = {
    isLocalRoomMode: () => local,
    getRoom: async () => { reads++; return structuredClone(state.room); },
    loadProposal: async () => structuredClone(state.proposal),
    loadAvailability: async () => structuredClone(state.availability),
    roomAction: async () => { writes++; },
    decideProposal: async () => { writes++; }, cancelProposal: async () => { writes++; }, proposeSlot: async () => { writes++; },
  };
  vm.runInNewContext(source, { exports: {}, require: name => name.endsWith('roundtables') ? api : { RequestError, errorMessage: error => error.message },
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id),
    wx: { stopPullDownRefresh: () => stopped++, showModal: options => { modal = options; }, navigateBack() {} }, Page: value => { page = value; },
  });
  page.setData = data => Object.assign(page.data, data);
  page.onLoad({ id: 'r' });
  return { page, api, state, timers, reads: () => reads, writes: () => writes, stopped: () => stopped, modal: () => modal,
    async open() { page.onShow(); await settle(); },
    async tick() { assert.equal(timers.size, 1); const [id, timer] = [...timers][0]; timers.delete(id); timer.fn(); await settle(); return timer.delay; },
  };
}

test('前台自动读取伙伴的加入、授权和最终确认，关闭圆桌后停止轮询', async () => {
  const c = setup(); await c.open();
  assert.equal(c.page.data.proposal.status, 'OPEN');
  c.state.room.members.push({ id: 'm2', name: '伙伴', isMe: false, shareBusy: true }); c.state.room.version++;
  c.state.proposal = proposal('CONFIRMED');
  assert.equal(await c.tick(), 5000);
  assert.equal(c.page.data.room.members.length, 2); assert.equal(c.page.data.proposal.status, 'CONFIRMED');
  c.state.room.status = 'CLOSED'; await c.tick(); assert.equal(c.timers.size, 0);
});

test('状态未变保留候选，成员或投票变化后清除旧候选', async () => {
  const c = setup(); await c.open(); await c.page.findTime();
  assert.equal(c.page.data.availability.slots.length, 1); await c.tick();
  assert.equal(c.page.data.availability.slots.length, 1);
  c.state.proposal.votes[0].decision = 'ACCEPT'; await c.tick(); assert.equal(c.page.data.availability, null);
  await c.page.findTime(); c.state.room.version++; await c.tick(); assert.equal(c.page.data.availability, null);
});

test('断网保留上次内容但禁止写入，退避后恢复更新', async () => {
  const c = setup(); await c.open(); const normalRead = c.api.getRoom;
  c.api.getRoom = async () => { throw new RequestError('网络中断', 0); };
  await c.tick(); assert.equal(c.page.data.room.id, 'r'); assert.equal(c.page.data.fresh, false);
  c.page.consent(); assert.equal(c.writes(), 0); assert.match(c.page.data.syncError, /网络/);
  assert.equal(await c.tick(), 10000); assert.equal(await c.tick(), 20000); assert.equal(await c.tick(), 30000);
  c.api.getRoom = normalRead; await c.tick(); assert.equal(c.page.data.fresh, true); assert.equal(c.page.data.syncError, '');
  assert.equal(await c.tick(), 5000);
});

test('被移除后清除成员、邀请码、方案及旧候选并停止轮询', async () => {
  const c = setup(); await c.open(); await c.page.findTime();
  c.api.loadProposal = async () => { throw new RequestError('不再是成员', 404); };
  await c.tick();
  for (const field of ['room', 'proposal', 'availability']) assert.equal(c.page.data[field], null);
  assert.equal(c.page.data.shareBusy, false); assert.equal(c.page.data.lastSync, ''); assert.equal(c.timers.size, 0);
  c.page.cancelProposal(); c.page.consent(); assert.equal(c.writes(), 0);
});

test('较早的慢请求不能覆盖较新的刷新结果', async () => {
  const c = setup(); await c.open(); const old = deferred(); const normalRead = c.api.getRoom;
  c.api.getRoom = () => old.promise; const first = c.page.readSnapshot(true);
  c.api.getRoom = normalRead; c.state.room.version = 2; c.state.room.title = '最新活动'; await c.page.reload();
  old.resolve({ ...room(), title: '旧活动' }); await first;
  assert.equal(c.page.data.room.title, '最新活动'); assert.equal(c.timers.size, 1);
});

test('写操作会使之前的轮询响应失效，不会覆盖已确认结果', async () => {
  const c = setup(); await c.open(); const old = deferred();
  const normalProposal = c.api.loadProposal; c.api.loadProposal = () => old.promise;
  const read = c.page.readSnapshot(true); await settle();
  assert.equal(c.page.lock(), true); c.api.loadProposal = normalProposal;
  await c.page.mutate(async () => { c.state.proposal = proposal('CONFIRMED'); });
  old.resolve(proposal('OPEN')); await read;
  assert.equal(c.page.data.proposal.status, 'CONFIRMED'); assert.equal(c.page.data.busy, false);
});

test('写请求超时后只查询结果，不自动重发且不误报为未保存', async () => {
  const c = setup(); await c.open(); let writes = 0;
  c.api.decideProposal = async () => { writes++; c.state.proposal = proposal('CONFIRMED'); throw new RequestError('超时', 0); };
  c.page.decide({ currentTarget: { dataset: { decision: 'ACCEPT' } } }); c.modal().success({ confirm: true }); await settle();
  assert.equal(writes, 1); assert.equal(c.page.data.proposal.status, 'CONFIRMED'); assert.equal(c.page.data.busy, false);
  assert.match(c.page.data.error, /查看当前状态/); await c.tick(); assert.equal(writes, 1);
});

test('隐藏或销毁页面后不轮询，迟到的请求不更新页面，重新进入会读取', async () => {
  const c = setup(); await c.open(); const slow = deferred(); const normalRead = c.api.getRoom;
  c.api.getRoom = () => slow.promise; const pending = c.page.readSnapshot(true); c.page.onHide();
  const saved = JSON.stringify(c.page.data); slow.resolve({ ...room(), title: '迟到' }); await pending;
  assert.equal(JSON.stringify(c.page.data), saved); assert.equal(c.timers.size, 0);
  c.api.getRoom = normalRead; c.state.room.title = '重进后'; await c.open(); assert.equal(c.page.data.room.title, '重进后');
  c.page.onUnload(); assert.equal(c.timers.size, 0);
});

test('离开期间未确认的弹窗不执行操作，返回后可恢复刷新', async () => {
  const c = setup(); await c.open(); c.page.cancelProposal(); c.page.onHide(); await c.open();
  c.modal().success({ confirm: true }); await settle();
  assert.equal(c.writes(), 0); assert.equal(c.page.data.busy, false); assert.equal(c.page.data.fresh, true); assert.equal(c.timers.size, 1);
});

test('写入期间切出再返回，完成后解除忙碌并读取结果', async () => {
  const c = setup(); await c.open(); const pending = deferred(); c.page.lock();
  const mutation = c.page.mutate(() => pending.promise); c.page.onHide(); await c.open();
  c.state.proposal = proposal('CONFIRMED'); pending.resolve(); await mutation; await settle();
  assert.equal(c.page.data.busy, false); assert.equal(c.page.data.loading, false); assert.equal(c.page.data.fresh, true);
  assert.equal(c.page.data.proposal.status, 'CONFIRMED');
});

test('刷新会作废旧的候选计算，迟到的结果不能恢复失效候选', async () => {
  const c = setup(); await c.open(); const slow = deferred(); c.api.loadAvailability = () => slow.promise;
  const finding = c.page.findTime(); c.state.room.version++; await c.page.reload(); slow.resolve(c.state.availability); await finding;
  assert.equal(c.page.data.availability, null); assert.equal(c.page.data.finding, false);
});

test('下拉刷新失败也停止动画；本机演示不会创建自动请求', async () => {
  const c = setup(true); await c.open(); assert.equal(c.timers.size, 0); assert.equal(c.page.data.proposal, null);
  c.api.getRoom = async () => { throw new RequestError('离线', 0); }; await c.page.onPullDownRefresh();
  assert.equal(c.stopped(), 1); assert.equal(c.page.data.loading, false); assert.equal(c.timers.size, 0);
});
