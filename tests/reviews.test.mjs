import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/api/dist/app.js';
import { reviewContract } from './review-contract.mjs';
import { changeReview } from '../apps/api/dist/reviews.js';
test('会议复盘责任分配 HTTP 合约', async t => {
  const app = await createApp({ storage: 'memory', authMode: 'demo', secretary: { mode: 'off' } });
  try {
    await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
    const call = (route, method = 'GET', token, body) => fetch(base + route, { method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const user = async name => { const response = await call('/dev/sessions', 'POST', undefined, { name }); assert.equal(response.status, 201); return response.json(); };
    await reviewContract(t, call, user);
  } finally { await app.close(); }
});

test('长异议历史达到容量上限时拒绝新写入，保留旧版并限制页面载荷', () => {
  const date = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const context = { ownerId: 'owner', dateFrom: date, dateTo: date, participants: [{ memberId: 'member', userId: 'owner', name: '测试' }] };
  let current = null, rejected = false;
  for (let revision = 0; revision < 20 && !rejected; revision++) {
    current = changeReview(context, current, 'owner', { kind: 'edit', value: { version: current?.version ?? 0, date, outcome: 'NOT_HELD', facts: '虚构事实',
      allocations: [{ memberId: 'member', percent: 0, reason: '', action: '' }], externalPercent: 0, externalReason: '', unassignedPercent: 100 } });
    for (let i = 0; i < 100; i++) {
      const before = JSON.stringify(current);
      try { current = changeReview(context, current, 'owner', { kind: 'vote', value: { version: current.version, decision: 'DISPUTE', comment: '据'.repeat(500) } }); }
      catch (error) { assert.match(error.message, /容量上限/); assert.equal(JSON.stringify(current), before); rejected = true; break; }
      assert.ok(Buffer.byteLength(JSON.stringify(current), 'utf8') <= 250_000);
    }
  }
  assert.equal(rejected, true);
});
