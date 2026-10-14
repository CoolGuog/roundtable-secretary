import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const code = new Map();
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const key = name => `roundtable.demo.${name}.v1`;
function client(mode = 'local') {
  const storage = new Map(), modules = new Map(); let fault = () => false, writes = 0;
  const wx = { getStorageSync: k => copy(storage.get(k)),
    setStorageSync: (k, value) => { writes++; if (fault(k, 'set')) throw Error('空间不足'); storage.set(k, copy(value)); },
    removeStorageSync: k => { if (fault(k, 'remove')) throw Error('存储故障'); storage.delete(k); } };
  function load(name) {
    if (name === './config') return { config: { mode } };
    if (modules.has(name)) return modules.get(name);
    const exports = {}; modules.set(name, exports);
    if (!code.has(name)) code.set(name, ts.transpileModule(fs.readFileSync(`apps/miniprogram/src/services/${name.slice(2)}.ts`, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
    vm.runInNewContext(code.get(name), { exports, require: load, wx }); return exports;
  }
  return { api: load('./local-backup'), load, storage, setFault: fn => { fault = fn; }, writes: () => writes };
}
async function fixture(c) {
  await c.load('./secretary').saveArrangement({ title: '虚构备份日程', date: '2026-10-01', startTime: '09:00', endTime: '10:00' });
  await c.load('./memories').saveMemory({ category: 'NOTE', label: '虚构备忘', content: '提前准备' });
  const room = await c.load('./roundtables').createRoom({ title: '虚构会议', goal: '核对工作', dateFrom: '2026-10-01', dateTo: '2026-10-03', startTime: '09:00', endTime: '17:00', durationMinutes: 60 });
  await c.load('./reviews').saveReview(room.id, { version: 0, date: '2026-10-01', outcome: 'NOT_HELD', facts: '虚构：材料不足', allocations: [{ memberId: 'local-self', percent: 40, reason: '未核对', action: '补齐资料' }], externalPercent: 0, externalReason: '', unassignedPercent: 60 });
  const service = c.load('./meeting-work');
  let work = await service.saveTask(room.id, 0, { title: '补材料', owner: '本人', dueDate: '2026-10-03', details: '全部补齐' });
  work = await service.changeTask(room.id, work.version, work.tasks[0].id, 'submit', '已准备好');
  work = await service.changeTask(room.id, work.version, work.tasks[0].id, 'accept', '本机核对通过');
  work = await service.addPreparationTemplate(room.id, work.version, '2026-10-03');
  await service.saveMinutes(room.id, work.version, { date: '2026-10-01', summary: '虚构纪要', decisions: '下次重试', nextSteps: '再次核对' });
  return room.id;
}
test('五类实际服务数据完整往返，导出不包含会话；导入只新增，重复导入零写入', async () => {
  const source = client(), roomId = await fixture(source); source.storage.set('roundtable.session.v2.demo.test', 'secret-token');
  const raw = source.api.exportLocalBackup(); assert.ok(!raw.includes('secret-token'));
  const target = client(), preview = target.api.previewLocalBackup(raw); assert.equal(target.writes(), 0); assert.equal(preview.added, 5);
  assert.equal(target.api.restoreLocalBackup(raw, preview.baseline), 5);
  const work = await target.load('./meeting-work').getMeetingWork(roomId);
  assert.equal(work.tasks[0].state, 'DONE'); assert.equal(work.tasks[0].history[2].note, '本机核对通过'); assert.equal(work.preparation.length, 4); assert.equal(work.minutes[0].nextSteps, '再次核对');
  assert.deepEqual(JSON.parse(target.api.exportLocalBackup()).data, JSON.parse(raw).data);
  const n = target.writes(), again = target.api.previewLocalBackup(raw); assert.equal(target.api.restoreLocalBackup(raw, again.baseline), 0); assert.equal(target.writes(), n);
});
test('同编号差异、预览后修改与容量溢出均不写入，原有内容保留', async () => {
  const source = client(); await fixture(source); const raw = source.api.exportLocalBackup();
  const target = client(); const preview = target.api.previewLocalBackup(raw);
  await target.load('./secretary').saveArrangement({ title: '新增', date: '2026-10-02', startTime: '10:00', endTime: '11:00' });
  let n = target.writes(); assert.throws(() => target.api.restoreLocalBackup(raw, preview.baseline), /已有变化/); assert.equal(target.writes(), n);
  const fresh = target.api.previewLocalBackup(raw); target.api.restoreLocalBackup(raw, fresh.baseline);
  const rows = target.storage.get(key('arrangements')); rows.find(r => r.title === '虚构备份日程').title = '已在本机修改';
  n = target.writes(); assert.throws(() => target.api.previewLocalBackup(raw), /不同内容/); assert.equal(target.writes(), n);
  const full = client(), item = JSON.parse(raw).data.arrangements[0]; full.storage.set(key('arrangements'), Array.from({ length: 100 }, (_, i) => ({ ...item, id: `full-${i}` })));
  assert.throws(() => full.api.previewLocalBackup(raw)); assert.equal(full.writes(), 0);
});
test('日程保存与恢复相邻发生不相互覆盖，并发新增也不丢失', async () => {
  const source = client(); await fixture(source); const raw = source.api.exportLocalBackup(), target = client();
  const api = target.load('./secretary'), input = { title: '新增中的安排', date: '2026-10-02', startTime: '10:00', endTime: '11:00' };
  const saving = api.saveArrangement(input), p = target.api.previewLocalBackup(raw);
  target.api.restoreLocalBackup(raw, p.baseline); await saving;
  await Promise.all([api.saveArrangement({ ...input, title: '新增甲' }), api.saveArrangement({ ...input, title: '新增乙' })]);
  assert.equal((await api.listArrangements()).length, 4);
});
test('恶意、损坏、跨模式、孤立引用、重复编号和未知版本备份拒绝导入', async () => {
  const c = client(); await fixture(c); const valid = JSON.parse(c.api.exportLocalBackup()); const target = client();
  const cases = [x => { x.version = 9; }, x => { x.token = 'credential'; }, x => { x.data.rooms[0].members[0].isMe = false; },
    x => { x.data.arrangements[0].date = '2026-02-30'; }, x => { x.data.arrangements[0].endTime = '08:00'; },
    x => { x.data.reviews[0].view.revisions[0].status = 'AGREED'; }, x => { x.data.rooms = []; },
    x => { x.data.workspaces[0].tasks.push(copy(x.data.workspaces[0].tasks[0])); }, x => { x.data.reviews[0].view.revisions[0].allocations[0].percent = 99; },
    x => { x.data.workspaces[0].minutes[0].nextSteps = Array(11).fill('超限').join('\n'); },
    x => { x.data.memories[0].content = '字'.repeat(501); }];
  for (const alter of cases) { const x = copy(valid); alter(x); assert.throws(() => target.api.previewLocalBackup(JSON.stringify(x))); }
  for (const text of ['{bad', 'null', JSON.stringify(valid).replace('"version":2', '"__proto__":{},"version":2'), ' '.repeat(800201)]) assert.throws(() => target.api.previewLocalBackup(text));
  assert.equal(target.writes(), 0); const api = client('api'); assert.throws(() => api.api.exportLocalBackup(), /本机/); assert.throws(() => api.api.previewLocalBackup(JSON.stringify(valid)), /本机/); assert.equal(api.writes(), 0);
});
test('事务任一阶段写入失败均恢复旧数据，凭证保持不变', async () => {
  const source = client(); await fixture(source); const raw = source.api.exportLocalBackup();
  for (const failKey of ['roundtable.local-restore-journal.v1', ...source.load('./local-store').localKeys]) {
    const target = client(); target.storage.set('session', 'keep'); const preview = target.api.previewLocalBackup(raw); let once = true;
    target.setFault(k => { if (once && k === failKey) { once = false; return true; } return false; });
    assert.throws(() => target.api.restoreLocalBackup(raw, preview.baseline));
    assert.equal(target.storage.get('session'), 'keep'); assert.ok(!target.storage.has('roundtable.local-restore-journal.v1'));
    assert.equal(JSON.parse(target.api.exportLocalBackup()).data.arrangements.length, 0);
  }
});
test('中断或回退失败保留日志，其他业务读取前自动重试，失败期间禁止业务写入', async () => {
  const source = client(); await fixture(source); const raw = source.api.exportLocalBackup(), target = client(); const preview = target.api.previewLocalBackup(raw);
  target.setFault(k => k === key('memories'));
  assert.throws(() => target.api.restoreLocalBackup(raw, preview.baseline), /暂时停止修改/);
  assert.ok(target.storage.has('roundtable.local-restore-journal.v1'));
  await assert.rejects(target.load('./secretary').listArrangements(), /暂时停止修改/);
  await assert.rejects(target.load('./secretary').saveArrangement({ title: '禁止写入', date: '2026-10-03', startTime: '10:00', endTime: '11:00' }), /暂时停止修改/);
  target.setFault(() => false); assert.equal((await target.load('./secretary').listArrangements()).length, 0); assert.ok(!target.storage.has('roundtable.local-restore-journal.v1'));
  // 模拟写入中断后新运行实例仍能使用落盘日志恢复。
  target.storage.set('roundtable.local-restore-journal.v1', target.load('./local-store').localKeys.map(k => ({ key: k, value: [] })));
  target.storage.set(key('rooms'), JSON.parse(raw).data.rooms); const restarted = client(); for (const [k, v] of target.storage) restarted.storage.set(k, copy(v));
  assert.equal((await restarted.load('./roundtables').listRooms()).length, 0);
});
test('删除提交日志失败也回退；损坏原数据或日志不静默丢弃', async () => {
  const source = client(); await fixture(source); const raw = source.api.exportLocalBackup(), target = client(); const p = target.api.previewLocalBackup(raw); let once = true;
  target.setFault((k, op) => { if (op === 'remove' && once) { once = false; return true; } return false; });
  assert.throws(() => target.api.restoreLocalBackup(raw, p.baseline), /原有记录已恢复/);
  target.storage.set(key('memories'), { broken: true }); assert.throws(() => target.api.exportLocalBackup());
  target.storage.set('roundtable.local-restore-journal.v1', [{ key: 'session', value: [] }]);
  await assert.rejects(target.load('./roundtables').listRooms(), /日志损坏/);
});

const course = { title: '虚构课程', date: '2027-01-04', startTime: '08:30', endTime: '10:00' };
async function repeatedFixture(c) {
  const api = c.load('./secretary');
  await api.saveArrangement({ ...course, repeat: { kind: 'weekly', weekdays: [1, 3] } });
  const find = async date => (await api.listArrangements('2027-01-04', '2027-01-31')).find(row => row.date === date);
  await api.updateArrangement((await find('2027-01-06')).id, { ...course, date: '2027-01-07', title: '单次调课' }, 'one');
  await api.deleteArrangement((await find('2027-01-13')).id, 'one');
  await api.updateArrangement((await find('2027-01-11')).id, { ...course, date: '2027-01-11', startTime: '10:00', endTime: '11:00' }, 'future');
  await api.saveArrangement({ ...course, title: '每天练习', repeat: { kind: 'daily', weekdays: [], until: '2027-01-06' } });
}

test('新版备份完整保留重复规则、截止、调课、跳过和后续分拆，远期仍可展开', async () => {
  const source = client(); await fixture(source); await repeatedFixture(source);
  const raw = source.api.exportLocalBackup(), backup = JSON.parse(raw), target = client();
  assert.equal(backup.version, 2); assert.equal(backup.data.recurring.length, 3);
  assert.equal(backup.data.arrangements.length, 1, '不把重复展开结果保存为单次日程');
  const preview = target.api.previewLocalBackup(raw); assert.equal(preview.added, 8); assert.equal(preview.counts[5].incoming, 3);
  target.api.restoreLocalBackup(raw, preview.baseline);
  for (const [from, to] of [['2027-01-01', '2027-01-31'], ['2035-01-01', '2035-01-31']]) {
    assert.deepEqual(copy(await target.load('./secretary').listArrangements(from, to)), copy(await source.load('./secretary').listArrangements(from, to)));
  }
  const rows = await target.load('./secretary').listArrangements('2027-01-01', '2027-01-31');
  assert.equal(rows.find(r => r.date === '2027-01-07').title, '单次调课');
  assert.ok(!rows.some(r => r.date === '2027-01-13'));
  assert.deepEqual(JSON.parse(target.api.exportLocalBackup()).data, backup.data);
  const writes = target.writes(); target.api.restoreLocalBackup(raw, target.api.previewLocalBackup(raw).baseline); assert.equal(target.writes(), writes);
});

test('旧版五类备份可恢复，保留已有课程；旧版中夹带重复规则与新版缺失规则均拒绝', async () => {
  const source = client(); await fixture(source); const backup = JSON.parse(source.api.exportLocalBackup()); backup.version = 1; delete backup.data.recurring;
  const target = client(); await repeatedFixture(target); const before = copy(target.storage.get(key('recurring'))), raw = JSON.stringify(backup);
  const preview = target.api.previewLocalBackup(raw); assert.equal(preview.counts[5].incoming, 0); assert.equal(preview.added, 5);
  target.api.restoreLocalBackup(raw, preview.baseline); assert.deepEqual(target.storage.get(key('recurring')), before);
  assert.equal(JSON.parse(target.api.exportLocalBackup()).version, 2);
  backup.data.recurring = []; assert.throws(() => target.api.previewLocalBackup(JSON.stringify(backup)));
  delete backup.data.recurring; backup.version = 2; assert.throws(() => target.api.previewLocalBackup(JSON.stringify(backup)));
});

test('从第一次起取消或分拆的空历史段可备份；跨年最低日期仍可恢复', async () => {
  for (const first of ['2000-01-01', '2027-01-04']) {
    const c = client(), api = c.load('./secretary');
    await api.saveArrangement({ ...course, date: first, repeat: { kind: 'daily', weekdays: [], until: '2027-01-06' } });
    const row = (await api.listArrangements(first, first))[0]; await api.deleteArrangement(row.id, 'future');
    const raw = c.api.exportLocalBackup(), target = client(); target.api.restoreLocalBackup(raw, target.api.previewLocalBackup(raw).baseline);
    assert.equal((await target.load('./secretary').listArrangements(first, first)).length, 0);
  }
  const c = client(), api = c.load('./secretary'); await api.saveArrangement({ ...course, repeat: { kind: 'weekly', weekdays: [1] } });
  const row = (await api.listArrangements(course.date, course.date))[0]; await api.updateArrangement(row.id, { ...course, title: '首次起调整' }, 'future');
  assert.equal(JSON.parse(c.api.exportLocalBackup()).data.recurring.length, 2);
});

test('重复规则同编号冲突与预览后调课均阻止恢复，字段顺序不造成伪冲突', async () => {
  const c = client(); await repeatedFixture(c); const raw = c.api.exportLocalBackup(), backup = JSON.parse(raw);
  const series = backup.data.recurring[0]; series.repeat = { weekdays: [3, 1], until: series.repeat.until, kind: 'weekly' };
  assert.equal(c.api.previewLocalBackup(JSON.stringify(backup)).added, 0);
  series.title = '试图覆盖'; const n = c.writes(); assert.throws(() => c.api.previewLocalBackup(JSON.stringify(backup)), /不同内容/); assert.equal(c.writes(), n);
  const target = client(), preview = target.api.previewLocalBackup(raw); await repeatedFixture(target);
  const writes = target.writes(); assert.throws(() => target.api.restoreLocalBackup(raw, preview.baseline), /已有变化/); assert.equal(target.writes(), writes);
});

test('重复备份拒绝畸形规则、超限、非法例外和额外字段，失败不写入', async () => {
  const source = client(); await repeatedFixture(source); const valid = JSON.parse(source.api.exportLocalBackup()), target = client();
  const cases = [r => { r.id = 'bad'; }, r => { r.repeat.kind = 'monthly'; }, r => { r.repeat.weekdays = [1, 1]; },
    r => { r.repeat.weekdays = [7]; }, r => { r.repeat.weekdays = []; }, r => { r.repeat.until = '2027-02-30'; },
    r => { r.repeat.until = '2027-01-02'; }, r => { r.repeat.session = 'token'; }, r => { r.exceptions = []; },
    r => { r.exceptions['2027-01-05'] = null; }, r => { r.exceptions['2027-01-11'] = null; },
    r => { r.exceptions['2027-01-06'].endTime = '08:00'; }, r => { r.exceptions['2027-01-06'].date = '2027-02-30'; },
    r => { r.exceptions['2027-01-06'].session = 'token'; }, r => { r.exceptions = JSON.parse('{"__proto__":null}'); },
    r => { r.repeat = { kind: 'daily', weekdays: [] }; }, r => { r.repeat = { kind: 'daily', weekdays: [1], until: '2027-01-10' }; },
    r => { r.exceptions = Object.fromEntries(Array.from({ length: 501 }, (_, i) => ['invalid-' + i, null])); }];
  for (const alter of cases) { const b = copy(valid); alter(b.data.recurring[0]); assert.throws(() => target.api.previewLocalBackup(JSON.stringify(b))); }
  const duplicate = copy(valid); duplicate.data.recurring.push(copy(duplicate.data.recurring[0])); assert.throws(() => target.api.previewLocalBackup(JSON.stringify(duplicate)), /重复编号/);
  const full = copy(valid); full.data.recurring = Array(501).fill(full.data.recurring[0]); assert.throws(() => target.api.previewLocalBackup(JSON.stringify(full)));
  assert.equal(target.writes(), 0);
});

test('旧五类恢复日志不改重复规则；六类日志跨重启恢复课程，回退失败阻止调课', async () => {
  const c = client(); await repeatedFixture(c); const before = copy(c.storage.get(key('recurring'))), journalKey = 'roundtable.local-restore-journal.v1';
  c.storage.set(journalKey, c.load('./local-store').localKeys.slice(0, 5).map(k => ({ key: k, value: [] })));
  await c.load('./secretary').listArrangements(course.date, course.date); assert.deepEqual(c.storage.get(key('recurring')), before);
  const source = client(); await fixture(source); const raw = source.api.exportLocalBackup(), preview = c.api.previewLocalBackup(raw);
  c.setFault(k => k === key('recurring')); assert.throws(() => c.api.restoreLocalBackup(raw, preview.baseline), /暂时停止修改/);
  assert.equal(c.storage.get(journalKey).length, 6);
  const id = `r:${before[0].id}:${course.date}`;
  await assert.rejects(c.load('./secretary').updateArrangement(id, { ...course, title: '禁止修改' }, 'one'), /暂时停止修改/);
  const restarted = client(); for (const [k, v] of c.storage) restarted.storage.set(k, copy(v));
  await restarted.load('./secretary').listArrangements(course.date, course.date);
  assert.deepEqual(restarted.storage.get(key('recurring')), before); assert.ok(!restarted.storage.has(journalKey));
  assert.equal(restarted.storage.get(key('arrangements')).length, 0);
});
