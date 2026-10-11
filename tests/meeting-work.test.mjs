import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const code = ts.transpileModule(fs.readFileSync('apps/miniprogram/src/services/meeting-work.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText;
const clone = value => JSON.parse(JSON.stringify(value));
const input = { title: '核对材料', owner: '演示成员', dueDate: '2026-10-06', details: '逐项确认' };
function service(local = true) {
  const storage = new Map(), exports = {}; let fail = false, roomReads = 0;
  const review = { participants: [{ memberId: 'one', name: '演示成员' }], revisions: [{ revision: 1, allocations: [{ memberId: 'one', action: '补齐会议材料' }] }] };
  vm.runInNewContext(code, { exports, require: name => name.endsWith('/roundtables') ? { isLocalRoomMode: () => local, getRoom: async id => {
    roomReads++; if (id !== 'room') throw Error('圆桌不存在'); return { id, dateFrom: '2026-10-01', dateTo: '2026-10-31' }; } } : { getReview: async () => clone(review) },
    wx: { getStorageSync: key => storage.has(key) ? clone(storage.get(key)) : undefined,
      setStorageSync: (key, value) => { if (fail) throw Error('本机存储空间不足'); storage.set(key, clone(value)); } } });
  return { api: exports, review, storage, fail: () => { fail = true; }, reads: () => roomReads };
}
test('任务执行、完成说明、验收、重开保留记录，不能跳过验收或无说明标完成', async () => {
  const { api } = service(); let work = await api.saveTask('room', 0, input); const id = work.tasks[0].id;
  await assert.rejects(api.changeTask('room', 1, id, 'accept', '检查通过'), /状态/);
  work = await api.changeTask('room', 1, id, 'start', '开始核对'); assert.equal(work.tasks[0].state, 'DOING');
  await assert.rejects(api.changeTask('room', 2, id, 'submit', ''), /说明/);
  work = await api.changeTask('room', 2, id, 'submit', '材料已补齐'); assert.equal(work.tasks[0].state, 'REVIEW');
  await assert.rejects(api.saveTask('room', 3, { ...input, title: '偷偷修改' }, id), /重新打开/);
  work = await api.changeTask('room', 3, id, 'accept', '已检查三份文件'); assert.equal(work.tasks[0].state, 'DONE');
  work = await api.changeTask('room', 4, id, 'reopen', '还有一份待补'); assert.equal(work.tasks[0].state, 'TODO');
  assert.equal(work.tasks[0].history[3].note, '已检查三份文件');
  await api.saveTask('room', 5, { ...input, owner: '新负责人' }, id); assert.equal((await api.getMeetingWork('room')).tasks[0].owner, '新负责人');
});
test('并发提交与旧版本保护，不重复建任务，失败不损坏旧数据', async () => {
  const c = service();
  const results = await Promise.allSettled([c.api.saveTask('room', 0, input), c.api.saveTask('room', 0, input)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const before = clone(await c.api.getMeetingWork('room')); c.fail();
  await assert.rejects(c.api.changeTask('room', 1, before.tasks[0].id, 'start', ''), /存储空间不足/);
  assert.deepEqual(clone(await c.api.getMeetingWork('room')), before);
});
test('会前模板可重复点击且不重复，编辑已就绪事项后需要重新核对', async () => {
  const { api } = service(); let work = await api.addPreparationTemplate('room', 0, '2026-10-06');
  work = await api.addPreparationTemplate('room', 1, '2026-10-07'); assert.equal(work.preparation.length, 4);
  assert.ok(work.preparation.every(item => item.dueDate === '2026-10-06'));
  const id = work.preparation[0].id; work = await api.togglePreparation('room', 2, id); assert.equal(work.preparation[0].done, true);
  work = await api.savePreparation('room', 3, { title: '检查新时间通知', owner: '本人', dueDate: '2026-10-07', note: '时间有变' }, id);
  assert.equal(work.preparation[0].done, false); assert.equal(work.preparation[0].doneAt, '');
  await api.addPreparationTemplate('room', 4, '2026-10-08'); assert.equal((await api.getMeetingWork('room')).preparation.length, 4);
});
test('纪要保留旧版本，行动不会自动写入任务，无效日期与过长行动拒绝保存', async () => {
  const { api } = service(); const minutes = { date: '2026-10-06', summary: '讨论记录', decisions: '手动记下决定', nextSteps: '整理资料\n核对预算' };
  let work = await api.saveMinutes('room', 0, minutes); assert.equal(work.tasks.length, 0);
  work = await api.saveMinutes('room', 1, { ...minutes, summary: '修订记录' }); assert.equal(work.minutes[0].summary, '讨论记录');
  assert.equal(work.minutes[1].revision, 2);
  for (const patch of [{ date: '2026-02-30' }, { date: '2026-11-01' }, { summary: '' }, { nextSteps: '字'.repeat(501) }, { nextSteps: Array(11).fill('一条').join('\n') }]) {
    await assert.rejects(api.saveMinutes('room', 2, { ...minutes, ...patch }));
  }
  assert.equal((await api.getMeetingWork('room')).version, 2);
});
test('复盘与纪要预览导入，同版本去重、不覆盖已执行任务，旧来源不可冒用新版', async () => {
  const c = service(), { api } = c;
  const candidates = await api.actionCandidates('room', 'review'); assert.equal(candidates[0].owner, '演示成员');
  let work = await api.importActions('room', 0, 'review', candidates.map(item => item.source), '2026-10-06');
  work = await api.changeTask('room', 1, work.tasks[0].id, 'start', '已开始');
  work = await api.importActions('room', 2, 'review', candidates.map(item => item.source), '2026-10-08');
  assert.equal(work.tasks.length, 1); assert.equal(work.tasks[0].state, 'DOING'); assert.equal(work.tasks[0].dueDate, '2026-10-06');
  c.review.revisions.push({ revision: 2, allocations: [{ memberId: 'one', action: '核对新资料' }] });
  await assert.rejects(api.importActions('room', 3, 'review', candidates.map(item => item.source), '2026-10-06'), /来源/);
  await api.saveMinutes('room', 3, { date: '2026-10-06', summary: '纪要', decisions: '', nextSteps: '后续行动甲\n后续行动乙' });
  const notes = await api.actionCandidates('room', 'minutes'); assert.equal(notes.length, 2);
  work = await api.importActions('room', 4, 'minutes', notes.map(item => item.source), '2026-10-09');
  assert.equal(work.tasks.length, 3); assert.equal(work.tasks[1].sourceLabel, '纪要第 1 版');
});
test('导入超出任务配额整体失败，不出现部分导入', async () => {
  const { api } = service(); let work;
  for (let i = 0; i < 49; i++) work = await api.saveTask('room', i, { ...input, title: `任务${i}` });
  work = await api.saveMinutes('room', 49, { date: '2026-10-06', summary: '纪要', decisions: '', nextSteps: '甲\n乙' });
  const sources = (await api.actionCandidates('room', 'minutes')).map(item => item.source);
  await assert.rejects(api.importActions('room', 50, 'minutes', sources, '2026-10-07'), /50/);
  assert.equal((await api.getMeetingWork('room')).tasks.length, 49); assert.equal((await api.getMeetingWork('room')).version, 50);
});
test('后台模式不读取或写入本机会议数据，也不缓存后台成员信息', async () => {
  const c = service(false);
  await assert.rejects(c.api.getMeetingWork('room'), /本机/);
  await assert.rejects(c.api.saveTask('room', 0, input), /本机/);
  await assert.rejects(c.api.actionCandidates('room', 'review'), /本机/);
  assert.equal(await c.api.localTasksForStats(), null); assert.equal(c.reads(), 0); assert.equal(c.storage.size, 0);
});
