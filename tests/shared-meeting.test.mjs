import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/api/dist/app.js';
import { changeWork, workDto } from '../apps/api/dist/shared-work.js';
import { sharedMeetingContract } from './shared-meeting-contract.mjs';
test('共享会前准备、纪要与行动 HTTP 合约', async t => {
 const app = await createApp({ storage: 'memory', authMode: 'demo', secretary: { mode: 'off' } });
 try {
   await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
   const call = (route, method = 'GET', token, body) => fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
   const user = async name => (await call('/dev/sessions', 'POST', undefined, { name })).json();
   await sharedMeetingContract(t, call, user);
 } finally { await app.close(); }
});
const person = { memberId: 'member', userId: 'user', name: '测试成员' };
const context = { ownerId: 'user', dateFrom: '2026-10-08', dateTo: '2026-10-08', participants: [person] };
const input = { title: '材料', details: '', dueDate: '2026-10-08', assigneeMemberId: person.memberId };
const old = () => ({ version: 0, tasks: [], notices: [] });
test('旧工作台文档无新字段仍可读取与升级，原始文档不变', () => {
 const work = old(), dto = workDto(work, context, 'user'); assert.deepEqual(dto.preparation, []); assert.deepEqual(dto.minutes, []);
 const updated = changeWork(context, work, 'user', { kind: 'prep-save', value: { ...input, version: 0 } });
 assert.equal(updated.preparation.length, 1); assert.deepEqual(work, old());
});
test('准备事项数量与历史、纪要版本及总容量上限原子失败', () => {
 let work = old();
 for (let i = 0; i < 50; i++) work = changeWork(context, work, 'user', { kind: 'prep-save', value: { ...input, version: work.version } });
 function fails(command, pattern) { const before = JSON.stringify(work); assert.throws(() => changeWork(context, work, 'user', command), pattern); assert.equal(JSON.stringify(work), before); }
 fails({ kind: 'prep-save', value: { ...input, version: work.version } }, /50/);
 work.preparation[0].history = Array(50).fill({ at: '', actor: '', label: '', note: '' });
 fails({ kind: 'prep-action', id: work.preparation[0].id, value: { version: work.version, done: true, note: '完成' } }, /历史/);
 work = old(); const draft = { date: '2026-10-08', summary: '摘要', decisions: '', nextSteps: '' };
 for (let i = 0; i < 20; i++) work = changeWork(context, work, 'user', { kind: 'minutes-save', value: { ...draft, version: work.version } });
 fails({ kind: 'minutes-save', value: { ...draft, version: work.version } }, /20/);
 work = old(); work.notices = [{ id: 'large', taskId: '', title: '文'.repeat(100000), text: '', at: '', recipients: [] }];
 fails({ kind: 'minutes-save', value: { ...draft, version: 0 } }, /容量/);
});
