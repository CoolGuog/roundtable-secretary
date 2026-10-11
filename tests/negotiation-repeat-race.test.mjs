import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryNegotiation } from '../apps/api/dist/negotiation.js';

test('等待重复日程读取期间撤回方案，不能在恢复后写入已撤回的活动', async () => {
  let resume, started, writes = 0;
  const paused = new Promise(resolve => { started = resolve; });
  const room = { id: 'room', title: '讨论', status: 'OPEN', version: 1, dateFrom: '2027-01-04', dateTo: '2027-01-04', startTime: '09:00', endTime: '12:00', durationMinutes: 60,
    members: [{ userId: 'a', shareBusy: false }, { userId: 'b', shareBusy: false }] };
  const engine = new MemoryNegotiation({ room: () => structuredClone(room), name: id => id,
    arrangements: () => { started(); return new Promise(resolve => { resume = resolve; }); }, createArrangements: () => writes++ });
  const proposal = await engine.createProposal('a', 'room', { date: '2027-01-04', startTime: '10:00', endTime: '11:00' });
  await engine.decide('a', 'room', proposal.id, { decision: 'ACCEPT' });
  const final = engine.decide('b', 'room', proposal.id, { decision: 'ACCEPT' });
  await paused; engine.cancel('a', 'room', proposal.id); resume([]);
  // 下一位成员的读取也允许完成，然后必须检查方案仍然开放。
  await new Promise(setImmediate); resume([]);
  await assert.rejects(final, /方案已变化/); assert.equal(writes, 0);
  assert.equal(engine.currentProposal('a', 'room').status, 'CANCELLED');
});
