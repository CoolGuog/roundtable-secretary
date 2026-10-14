import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/api/dist/app.js';
import { sharedWorkContract } from './shared-work-contract.mjs';
import { changeWork } from '../apps/api/dist/shared-work.js';
test('协作任务与站内消息 HTTP 合约', async t => {
 const app = await createApp({ storage: 'memory', authMode: 'demo', secretary: { mode: 'off' } });
 try {
  await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
  const call = (route, method = 'GET', token, body) => fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const user = async name => (await call('/dev/sessions', 'POST', undefined, { name })).json();
  await sharedWorkContract(t, call, user);
 } finally { await app.close(); }
});
test('协作工作台容量与操作历史限制整体失败，不修改原文档或生成孤立消息', () => {
 const p = { userId: 'a', memberId: 'a-member', name: '甲' }, context = { ownerId: 'a', dateFrom: '2026-10-07', dateTo: '2026-10-07', participants: [p] };
 const input = { title: '任务', details: '', dueDate: '2026-10-07', assigneeMemberId: p.memberId }; let work = null;
 for (let i = 0; i < 50; i++) work = changeWork(context, work, 'a', { kind: 'save', value: { ...input, version: i } });
 const before = JSON.stringify(work); assert.throws(() => changeWork(context, work, 'a', { kind: 'save', value: { ...input, version: 50 } }), /50/); assert.equal(JSON.stringify(work), before);
 work.tasks[0].history = Array(50).fill({ at: new Date().toISOString(), actor: '甲', label: '测试', note: '' });
 const full = JSON.stringify(work); assert.throws(() => changeWork(context, work, 'a', { kind: 'action', id: work.tasks[0].id, value: { version: 50, action: 'start', note: '' } }), /历史/); assert.equal(JSON.stringify(work), full);
});
