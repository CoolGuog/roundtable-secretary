import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { sampleRoom } from './room-contract.mjs';

function page(serviceOverrides = {}) {
  let definition, modal;
  const timers = new Map(); let timerId = 0;
  const calls = [];
  const source = fs.readFileSync('apps/miniprogram/src/pages/roundtable/index.ts', 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, {
    exports: {}, Page: value => { definition = value; },
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
    wx: { showModal: value => { modal = value; } },
    require: name => name.includes('roundtables') ? {
      isLocalRoomMode: () => false,
      getRoom: async () => definition.data.room,
      loadProposal: async () => definition.data.proposal,
      proposeSlot: async (id, slot) => { calls.push([id, { ...slot }]); definition.data.proposal = { id: 'new', ...slot, status: 'OPEN', votes: [] }; return definition.data.proposal; },
      ...serviceOverrides,
    } : { errorMessage: error => error.message, RequestError: class extends Error {} },
  });
  definition._visible = true;
  definition.data = { ...definition.data, fresh: true, id: 'room', room: { ...sampleRoom, id: 'room', status: 'OPEN', members: [{}, {}] },
    manualDate: sampleRoom.dateFrom, manualStart: '14:17', manualEnd: '15:17' };
  definition.setData = patch => Object.assign(definition.data, patch);
  return { page: definition, calls, timers, modal: () => modal };
}

test('手动选时弹窗取消不提案，确认只提交日期时间且返回待确认方案', async () => {
  const harness = page();
  harness.page.chooseManual();
  assert.equal(harness.calls.length, 0);
  harness.modal().success({ confirm: false });
  assert.equal(harness.page.data.busy, false);
  harness.page.chooseManual();
  harness.modal().success({ confirm: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(harness.calls, [['room', { date: sampleRoom.dateFrom, startTime: '14:17', endTime: '15:17' }]]);
  assert.equal(harness.page.data.proposal.status, 'OPEN');
});

test('提案人和其他成员接受后均显示已接受、等待反馈；重复接受不再弹窗', async () => {
  for (const createdByMe of [true, false]) {
    const proposal = { id: 'new', status: 'OPEN', stale: false, createdByMe, votes: [{ name: '我', isMe: true, decision: 'ACCEPT' }, { name: '伙伴', isMe: false, decision: 'PENDING' }] };
    const harness = page({ decideProposal: async () => proposal, loadProposal: async () => proposal });
    await harness.page.mutate(() => Promise.resolve(proposal), false, '你已接受，等待其他成员确认');
    assert.equal(harness.page.data.proposal.myDecision, 'ACCEPT');
    assert.equal(harness.page.data.proposal.status, 'OPEN');
    assert.equal(harness.page.data.error, '');
    assert.match(harness.page.data.toastMessage, /你已接受.*等待/);
    harness.page.decide({ currentTarget: { dataset: { decision: 'ACCEPT' } } });
    assert.equal(harness.modal(), undefined);
    await harness.page.readSnapshot(true);
    assert.equal(harness.page.data.proposal.myDecision, 'ACCEPT');
  }
});

test('最后一位接受后显示全员已接受；确认失败不伪装成已接受', async () => {
  const proposal = { id: 'new', status: 'CONFIRMED', stale: false, votes: [{ name: '我', isMe: true, decision: 'ACCEPT' }] };
  const completed = page({ decideProposal: async () => proposal, loadProposal: async () => proposal });
  await completed.page.mutate(() => Promise.resolve(proposal), false, '你已接受，等待其他成员确认');
  assert.equal(completed.page.data.proposal.status, 'CONFIRMED');
  assert.match(completed.page.data.toastMessage, /全员已接受/);
  const pending = { ...proposal, status: 'OPEN', votes: [{ name: '我', isMe: true, decision: 'PENDING' }] };
  const failed = page({ decideProposal: async () => { throw new Error('有安排冲突'); }, loadProposal: async () => pending });
  await failed.page.mutate(async () => { throw new Error('有安排冲突'); }, false, '你已接受，等待其他成员确认');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failed.page.data.proposal.myDecision, 'PENDING');
  assert.match(failed.page.data.toastMessage, /冲突/);
});

test('当天默认选未来时段；当天窗口已结束则选下一天，无后续日期则提示无未来时间', () => {
  const { page: view } = page();
  const room = { ...view.data.room, dateFrom: '2026-10-10', dateTo: '2026-10-11', startTime: '09:00', endTime: '21:00' };
  const afternoon = Date.parse('2026-10-10T15:04:00+08:00');
  const defaults = view.defaultManual(room, undefined, afternoon);
  assert.equal(defaults.manualStart, '15:30'); assert.equal(defaults.manualEnd, '16:30');
  const narrow = view.defaultManual({ ...room, endTime: '16:10' }, undefined, afternoon);
  assert.equal(narrow.manualStart, '15:05'); assert.equal(narrow.manualEnd, '16:05');
  const late = view.defaultManual(room, undefined, Date.parse('2026-10-10T20:30:00+08:00'));
  assert.equal(late.manualDate, '2026-10-11'); assert.equal(late.manualStart, '09:00');
  const exhausted = view.defaultManual({ ...room, dateTo: '2026-10-10' }, undefined, Date.parse('2026-10-10T20:30:00+08:00'));
  assert.equal(exhausted.manualStart, ''); assert.match(exhausted.manualNotice, /未来时间/);
  const pastDate = view.defaultManual(room, '2026-10-10', Date.parse('2026-10-11T10:00:00+08:00'));
  assert.equal(pastDate.manualStart, '');
});

test('浮层两秒消失；连续提示取消旧计时器；页面隐藏时清理', () => {
  const { page: view, timers } = page();
  view.notify('请选择更晚的时间');
  assert.equal(view.data.toastMessage, '请选择更晚的时间');
  assert.equal([...timers.values()][0].delay, 2000);
  view.notify('已更新提示'); assert.equal(timers.size, 1);
  [...timers.values()][0].callback(); assert.equal(view.data.toastMessage, '');
  timers.clear(); view.notify('新提示'); view.onHide();
  assert.equal(timers.size, 0); assert.equal(view.data.toastMessage, '');
});

test('手动开始时间自动带出约定时长；窗口外或时长错误不弹窗不提案', () => {
  const harness = page();
  harness.page.onManualStart({ detail: { value: '16:23' } });
  assert.equal(harness.page.data.manualEnd, '17:23');
  harness.page.onManualEnd({ detail: { value: '17:24' } });
  harness.page.chooseManual();
  assert.equal(harness.modal(), undefined); assert.equal(harness.calls.length, 0);
  assert.match(harness.page.data.error, /60 分钟/);
  harness.page.onManualStart({ detail: { value: '17:23' } });
  harness.page.chooseManual();
  assert.equal(harness.modal(), undefined);
});
