import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sampleRoom } from './room-contract.mjs';

const base = { title: '私密重复课程', date: '2027-01-04', startTime: '08:30', endTime: '10:00' };
const weekly = { ...base, repeat: { kind: 'weekly', weekdays: [1, 3] } };
const list = async (call, token, from = '2027-01-04', to = '2027-01-18') => {
  const response = await call(`/me/arrangements?from=${from}&to=${to}`, 'GET', token);
  assert.equal(response.status, 200); return response.json();
};
export async function recurrenceContract(t, call, user) {
  await t.test('每周无结束日期，远期按星期展开、用户隔离，创建并发重试只保存一次', async () => {
    const a = await user('重复甲'), b = await user('重复乙'), key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 3 }, () => call('/me/arrangements', 'POST', a.token, weekly, { 'Idempotency-Key': key })));
    for (const response of responses) assert.equal(response.status, 201);
    const ids = await Promise.all(responses.map(async response => (await response.json()).id));
    assert.equal(new Set(ids).size, 1);
    const rows = await list(call, a.token);
    assert.deepEqual(rows.map(row => row.date), ['2027-01-04', '2027-01-06', '2027-01-11', '2027-01-13', '2027-01-18']);
    assert.ok((await list(call, a.token, '2035-01-01', '2035-01-31')).length >= 8);
    assert.deepEqual(await list(call, b.token), []);
    assert.equal((await call(`/me/arrangements/${rows[0].id}?scope=future`, 'DELETE', b.token)).status, 404);
    assert.equal((await call('/me/arrangements', 'POST', a.token, { ...weekly, title: '不同内容' }, { 'Idempotency-Key': key })).status, 409);
    for (const query of ['from=2027-02-30&to=2027-03-01', 'from=2027-01-01&to=2027-12-31', 'from=x&from=y&to=2027-01-01'])
      assert.equal((await call(`/me/arrangements?${query}`, 'GET', a.token)).status, 400);
  });
  await t.test('仅本次改期不保留原时间，本次及以后修改与删除保留历史和单次例外', async () => {
    const a = await user('重复修改'); await call('/me/arrangements', 'POST', a.token, weekly);
    let rows = await list(call, a.token);
    const original = rows.find(row => row.date === '2027-01-06');
    assert.equal((await call(`/me/arrangements/${original.id}`, 'PUT', a.token, { ...base, date: '2027-01-07', title: '单次改期', scope: 'one' })).status, 200);
    rows = await list(call, a.token); assert.ok(!rows.some(row => row.date === '2027-01-06'));
    assert.equal(rows.find(row => row.date === '2027-01-07').title, '单次改期');
    const anchor = rows.find(row => row.date === '2027-01-11');
    assert.equal((await call(`/me/arrangements/${anchor.id}`, 'PUT', a.token, { ...base, date: '2027-01-11', title: '新课表', startTime: '10:00', endTime: '11:00', scope: 'future' })).status, 200);
    rows = await list(call, a.token);
    assert.equal(rows.find(row => row.date === '2027-01-04').startTime, '08:30');
    assert.equal(rows.find(row => row.date === '2027-01-07').title, '单次改期');
    assert.equal(rows.find(row => row.date === '2027-01-18').startTime, '10:00');
    const stop = rows.find(row => row.date === '2027-01-13');
    assert.equal((await call(`/me/arrangements/${stop.id}?scope=future`, 'DELETE', a.token)).status, 204);
    rows = await list(call, a.token); assert.ok(rows.every(row => row.date < '2027-01-13'));
    assert.equal((await call(`/me/arrangements/${rows[0].id}?scope=invalid`, 'DELETE', a.token)).status, 400);
    assert.equal((await call(`/me/arrangements/${rows[0].id}`, 'PUT', a.token, null)).status, 400);
    assert.equal((await call(`/me/arrangements/${rows[0].id}?scope=one`, 'DELETE', a.token)).status, 204);
    assert.ok(!(await list(call, a.token)).some(row => row.date === '2027-01-04'));
  });
  await t.test('每天重复包含结束当天，无结束日期、空星期及非法字段不允许保存', async () => {
    const a = await user('每天重复');
    for (const repeat of [{ kind: 'daily', weekdays: [] }, { kind: 'weekly', weekdays: [] }, { kind: 'weekly', weekdays: [7] }, { kind: 'weekly', weekdays: [1], ownerId: 'foreign' }])
      assert.equal((await call('/me/arrangements', 'POST', a.token, { ...base, repeat })).status, 400);
    assert.equal((await call('/me/arrangements', 'POST', a.token, { ...base, repeat: { kind: 'daily', weekdays: [], until: '2027-01-06' } })).status, 201);
    assert.deepEqual((await list(call, a.token)).map(row => row.date), ['2027-01-04', '2027-01-05', '2027-01-06']);
  });
  await t.test('圆桌远期计算排除重复课程；未授权成员重复冲突在最终确认时拦截且不泄露标题', async () => {
    const a = await user('重复协商甲'), b = await user('重复协商乙');
    const date = '2027-01-04';
    const roomResponse = await call('/roundtables', 'POST', a.token, { ...sampleRoom, dateFrom: date, dateTo: date, startTime: '09:00', endTime: '12:00' });
    assert.equal(roomResponse.status, 201); const room = await roomResponse.json();
    await call('/roundtables/join', 'POST', b.token, { code: room.inviteCode });
    await call(`/roundtables/${room.id}/membership`, 'PUT', a.token, { shareBusy: true });
    await call('/me/arrangements', 'POST', a.token, weekly);
    const availability = await call(`/roundtables/${room.id}/availability`, 'GET', a.token);
    const available = await availability.json();
    assert.ok(!JSON.stringify(available).includes(base.title));
    assert.ok(!available.slots.some(slot => slot.startTime < '10:00'));
    const proposalResponse = await call(`/roundtables/${room.id}/proposals`, 'POST', a.token, { date, startTime: '10:00', endTime: '11:00' });
    assert.equal(proposalResponse.status, 201); const proposal = await proposalResponse.json();
    await call('/me/arrangements', 'POST', b.token, { ...weekly, startTime: '10:00', endTime: '11:00' });
    await call(`/roundtables/${room.id}/proposals/${proposal.id}`, 'PUT', a.token, { decision: 'ACCEPT' });
    const blocked = await call(`/roundtables/${room.id}/proposals/${proposal.id}`, 'PUT', b.token, { decision: 'ACCEPT' });
    assert.equal(blocked.status, 400); assert.ok(!(await blocked.text()).includes(base.title));
    assert.ok((await list(call, a.token, date, date)).every(row => row.seriesId));
  });
}
