import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const input = { title: '保存重试验收', date: '2026-10-01', startTime: '14:00', endTime: '15:00' };
export async function arrangementRetryContract(t, call, user) {
  await t.test('相同请求并发与重试只创建一条，达到容量后仍可读取原结果', async () => {
    const a = await user('请求重试甲'), key = randomUUID(), headers = { 'Idempotency-Key': key };
    const responses = await Promise.all(Array.from({ length: 5 }, () => call('/me/arrangements', 'POST', a.token, input, headers)));
    assert.ok(responses.every(response => response.status === 201));
    const rows = await Promise.all(responses.map(response => response.json())); assert.equal(new Set(rows.map(row => row.id)).size, 1);
    assert.equal((await (await call('/me/arrangements', 'GET', a.token)).json()).length, 1);
    for (let i = 0; i < 99; i++) assert.equal((await call('/me/arrangements', 'POST', a.token, input)).status, 201);
    const retry = await call('/me/arrangements', 'POST', a.token, input, headers); assert.equal(retry.status, 201);
    assert.equal((await retry.json()).id, rows[0].id);
    assert.equal((await call('/me/arrangements', 'POST', a.token, input, { 'Idempotency-Key': randomUUID() })).status, 400);
  });
  await t.test('请求编号按用户隔离，同一编号不同内容拒绝且不覆盖原记录', async () => {
    const a = await user('编号隔离甲'), b = await user('编号隔离乙'), key = randomUUID();
    const original = await (await call('/me/arrangements', 'POST', a.token, input, { 'Idempotency-Key': key })).json();
    assert.equal((await call('/me/arrangements', 'POST', a.token, { ...input, title: '修改了内容' }, { 'Idempotency-Key': key })).status, 409);
    const other = await (await call('/me/arrangements', 'POST', b.token, input, { 'Idempotency-Key': key })).json();
    assert.notEqual(original.id, other.id);
    assert.equal((await (await call('/me/arrangements', 'GET', a.token)).json())[0].title, input.title);
  });
  await t.test('编辑后重试不还原旧内容，删除后重试不复活；新编号允许有意创建同内容', async () => {
    const a = await user('编辑删除重试'), key = randomUUID(), headers = { 'Idempotency-Key': key };
    const original = await (await call('/me/arrangements', 'POST', a.token, input, headers)).json();
    await call(`/me/arrangements/${original.id}`, 'PUT', a.token, { title: '后来修改' });
    const retry = await (await call('/me/arrangements', 'POST', a.token, input, headers)).json(); assert.equal(retry.title, '后来修改');
    await call(`/me/arrangements/${original.id}`, 'DELETE', a.token);
    assert.equal((await call('/me/arrangements', 'POST', a.token, input, headers)).status, 409);
    assert.equal((await (await call('/me/arrangements', 'GET', a.token)).json()).length, 0);
    assert.equal((await call('/me/arrangements', 'POST', a.token, input, { 'Idempotency-Key': randomUUID() })).status, 201);
  });
  await t.test('拒绝无效编号，编号大小写和名称首尾空格不影响原样重试', async () => {
    const a = await user('编号校验');
    assert.equal((await call('/me/arrangements', 'POST', a.token, input, { 'Idempotency-Key': 'invalid' })).status, 400);
    assert.equal((await (await call('/me/arrangements', 'GET', a.token)).json()).length, 0);
    const key = randomUUID();
    const original = await (await call('/me/arrangements', 'POST', a.token, { ...input, title: ' ' + input.title + ' ' }, { 'Idempotency-Key': key.toUpperCase() })).json();
    const replay = await (await call('/me/arrangements', 'POST', a.token, input, { 'Idempotency-Key': key })).json(); assert.equal(replay.id, original.id);
  });
}
