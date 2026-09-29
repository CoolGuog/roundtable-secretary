import assert from 'node:assert/strict';
import { sampleRoom } from './room-contract.mjs';

const room = { ...sampleRoom };
const DAY = room.dateFrom;
const arrangement = (date, startTime, endTime, title = '已有安排') => ({ title, date, startTime, endTime });

/** 新建一个「两人、双方授权」的圆桌，返回各自的 token 与房间 id */
async function pair(call, user, prefix = '协商') {
  const a = await user(`${prefix}甲`), b = await user(`${prefix}乙`);
  const created = await (await call('/roundtables', 'POST', a.token, room)).json();
  await call('/roundtables/join', 'POST', b.token, { code: created.inviteCode });
  await call(`/roundtables/${created.id}/membership`, 'PUT', a.token, { shareBusy: true });
  await call(`/roundtables/${created.id}/membership`, 'PUT', b.token, { shareBusy: true });
  return { a, b, id: created.id };
}
const availability = async (call, token, id) => (await call(`/roundtables/${id}/availability`, 'GET', token)).json();

export async function negotiationContract(t, call, user) {
  await t.test('共同可用时间：排除忙时段、不泄露标题、未授权不参与', async () => {
    const { a, b, id } = await pair(call, user);
    assert.equal((await call(`/roundtables/${id}/availability`, 'GET', a.token)).status, 200);
    // 甲在 10:00–12:00 有安排，标题不得出现在协商结果里
    await call('/me/arrangements', 'POST', a.token, arrangement(DAY, '10:00', '12:00', '绝密诊断'));
    const view = await availability(call, a.token, id);
    assert.equal(view.coverage.shared, 2);
    assert.equal(view.reason, null);
    assert.ok(view.slots.length > 0);
    assert.ok(!JSON.stringify(view.slots).includes('绝密诊断'));
    assert.ok(!JSON.stringify(view).includes('userId'));
    assert.ok(view.slots.some(slot => slot.date === DAY && slot.startTime === '09:00' && slot.endTime === '10:00'));
    // 与 10:00–12:00 重叠的时段不应成为候选
    const clash = view.slots.filter(slot => slot.date === DAY && slot.startTime < '12:00' && slot.endTime > '10:00');
    assert.deepEqual(clash, []);
    // 未授权的安排不参与计算，但要在覆盖率里说清楚
    await call(`/roundtables/${id}/membership`, 'PUT', b.token, { shareBusy: false });
    const partial = await availability(call, a.token, id);
    assert.equal(partial.coverage.shared, 1);
    assert.match(partial.note, /还有 1 位成员未授权/);
  });

  await t.test('无解时明确说明原因', async () => {
    const a = await user('无解甲');
    const single = await (await call('/roundtables', 'POST', a.token, room)).json();
    const alone = await availability(call, a.token, single.id);
    assert.deepEqual(alone.slots, []);
    assert.match(alone.reason, /只有一位成员/);

    const { a: owner, b, id } = await pair(call, user, '无解');
    const none = await availability(call, owner.token, id);
    assert.ok(none.slots.length > 0);
    // 双方三天都排满
    for (const token of [owner.token, b.token]) {
      for (const date of [room.dateFrom, '2026-10-02', room.dateTo]) {
        await call('/me/arrangements', 'POST', token, arrangement(date, '09:00', '18:00'));
      }
    }
    const full = await availability(call, owner.token, id);
    assert.deepEqual(full.slots, []);
    assert.match(full.reason, /找不到 60 分钟的共同空档/);
  });

  await t.test('方案确认闭环：全员接受后写入各自日程，且不会重复写入', async () => {
    const { a, b, id } = await pair(call, user, '闭环');
    const slots = (await availability(call, a.token, id)).slots;
    const slot = slots[0];
    const created = await call(`/roundtables/${id}/proposals`, 'POST', a.token, slot);
    assert.equal(created.status, 201);
    let proposal = await created.json();
    assert.equal(proposal.status, 'OPEN');
    assert.equal(proposal.stale, false);
    assert.equal(proposal.votes.length, 2);
    assert.ok(proposal.votes.every(vote => vote.decision === 'PENDING'));
    assert.ok(proposal.votes.some(vote => vote.isMe));
    assert.ok(!JSON.stringify(proposal.votes).includes(a.user.id));

    // 非候选时段、窗口外时段、重复发起都要拒绝
    const busy = arrangement(DAY, '10:00', '11:00');
    await call('/me/arrangements', 'POST', a.token, busy);
    const refreshed = await availability(call, a.token, id);
    assert.equal((await call(`/roundtables/${id}/proposals`, 'POST', a.token, { date: DAY, startTime: '10:00', endTime: '11:00' })).status, 400);
    assert.equal((await call(`/roundtables/${id}/proposals`, 'POST', a.token, { date: DAY, startTime: '07:00', endTime: '08:00' })).status, 400);
    assert.equal((await call(`/roundtables/${id}/proposals`, 'POST', a.token, { ...refreshed.slots[0], endTime: '23:00' })).status, 400);
    assert.equal((await call(`/roundtables/${id}/proposals`, 'POST', b.token, slot)).status, 400);
    // 清理这条安排，避免影响后续断言
    const mine = (await (await call('/me/arrangements', 'GET', a.token)).json()).find(item => item.title === '已有安排');
    await call(`/me/arrangements/${mine.id}`, 'DELETE', a.token);

    // 只有一方接受：不写入
    proposal = await (await call(`/roundtables/${id}/proposals/${proposal.id}`, 'PUT', b.token, { decision: 'ACCEPT' })).json();
    assert.equal(proposal.status, 'OPEN');
    // 从甲的视角看，甲自己还没有表态
    assert.equal((await (await call(`/roundtables/${id}/proposal`, 'GET', a.token)).json()).votes.find(vote => vote.isMe).decision, 'PENDING');
    assert.equal((await (await call('/me/arrangements', 'GET', b.token)).json()).length, 0);

    // 全员接受：写入各自日程
    proposal = await (await call(`/roundtables/${id}/proposals/${proposal.id}`, 'PUT', a.token, { decision: 'ACCEPT' })).json();
    assert.equal(proposal.status, 'CONFIRMED');
    for (const account of [a, b]) {
      const items = await (await call('/me/arrangements', 'GET', account.token)).json();
      const written = items.filter(item => item.date === slot.date && item.startTime === slot.startTime);
      assert.equal(written.length, 1);
      assert.equal(written[0].title, room.title);
    }
    // 幂等：已结束的方案不能再投票，也不会再写一遍
    assert.equal((await call(`/roundtables/${id}/proposals/${proposal.id}`, 'PUT', a.token, { decision: 'ACCEPT' })).status, 400);
    assert.equal((await (await call('/me/arrangements', 'GET', a.token)).json()).length, 1);
    const current = await (await call(`/roundtables/${id}/proposal`, 'GET', a.token)).json();
    assert.equal(current.status, 'CONFIRMED');
    assert.equal(current.stale, false);
  });

  await t.test('有人拒绝则不写入，可重新发起新方案', async () => {
    const { a, b, id } = await pair(call, user, '拒绝');
    const slot = (await availability(call, a.token, id)).slots[0];
    let proposal = await (await call(`/roundtables/${id}/proposals`, 'POST', a.token, slot)).json();
    proposal = await (await call(`/roundtables/${id}/proposals/${proposal.id}`, 'PUT', b.token, { decision: 'REJECT' })).json();
    assert.equal(proposal.status, 'REJECTED');
    assert.equal((await (await call('/me/arrangements', 'GET', a.token)).json()).length, 0);
    assert.equal((await call(`/roundtables/${id}/proposals/${proposal.id}`, 'PUT', a.token, { decision: 'ACCEPT' })).status, 400);
    const next = await call(`/roundtables/${id}/proposals`, 'POST', a.token, (await availability(call, a.token, id)).slots[1] ?? slot);
    assert.equal(next.status, 201);
    const again = await next.json();
    assert.equal(again.status, 'OPEN');
    assert.equal((await (await call(`/roundtables/${id}/proposal`, 'GET', a.token)).json()).id, again.id);
  });

  await t.test('成员或授权变化后，旧方案失效，防止用过期信息写入日程', async () => {
    const { a, b, id } = await pair(call, user, '失效');
    const slot = (await availability(call, a.token, id)).slots[0];
    const proposal = await (await call(`/roundtables/${id}/proposals`, 'POST', a.token, slot)).json();
    await call(`/roundtables/${id}/membership`, 'DELETE', b.token);
    const stale = await (await call(`/roundtables/${id}/proposals/${proposal.id}`, 'PUT', a.token, { decision: 'ACCEPT' })).json();
    assert.match(stale.message, /成员或授权已变化/);
    assert.equal((await (await call('/me/arrangements', 'GET', a.token)).json()).length, 0);
    // 读取时才把失效落定为 EXPIRED：确认路径上抛异常会被事务回滚，不适合写状态
    const view = await (await call(`/roundtables/${id}/proposal`, 'GET', a.token)).json();
    assert.equal(view.status, 'EXPIRED');
    assert.equal(view.stale, false);
  });

  await t.test('未授权成员的安排不参与计算，但写入前仍会拦截冲突', async () => {
    const a = await user('冲突甲'), b = await user('冲突乙'), c = await user('冲突丙');
    const created = await (await call('/roundtables', 'POST', a.token, room)).json();
    for (const account of [b, c]) await call('/roundtables/join', 'POST', account.token, { code: created.inviteCode });
    await call(`/roundtables/${created.id}/membership`, 'PUT', a.token, { shareBusy: true });
    await call(`/roundtables/${created.id}/membership`, 'PUT', b.token, { shareBusy: true });
    // 丙未授权，他在该时段的安排不会被算进候选
    const slots = (await availability(call, a.token, created.id)).slots;
    const slot = slots[0];
    await call('/me/arrangements', 'POST', c.token, arrangement(slot.date, slot.startTime, slot.endTime, '丙的私事'));
    const proposal = await (await call(`/roundtables/${created.id}/proposals`, 'POST', a.token, slot)).json();
    await call(`/roundtables/${created.id}/proposals/${proposal.id}`, 'PUT', b.token, { decision: 'ACCEPT' });
    // 丙未授权忙闲，但他仍是成员，方案同样需要他确认
    await call(`/roundtables/${created.id}/proposals/${proposal.id}`, 'PUT', c.token, { decision: 'ACCEPT' });
    const blocked = await call(`/roundtables/${created.id}/proposals/${proposal.id}`, 'PUT', a.token, { decision: 'ACCEPT' });
    assert.equal(blocked.status, 400);
    assert.match((await blocked.json()).message, /已有其他安排/);
    for (const account of [a, b]) assert.equal((await (await call('/me/arrangements', 'GET', account.token)).json()).length, 0);
    assert.equal((await (await call('/me/arrangements', 'GET', c.token)).json()).length, 1);
  });

  await t.test('方案接口校验：格式、越权与不存在', async () => {
    const { a, b, id } = await pair(call, user, '校验');
    const outsider = await user('旁观甲');
    assert.equal((await call(`/roundtables/${id}/availability`, 'GET', outsider.token)).status, 404);
    assert.equal((await call(`/roundtables/${id}/proposal`, 'GET', outsider.token)).status, 404);
    assert.equal((await call(`/roundtables/${id}/proposal`, 'GET', a.token)).status, 204);
    assert.equal((await call(`/roundtables/${id}/proposals`, 'POST', a.token, {})).status, 400);
    assert.equal((await call(`/roundtables/${id}/proposals`, 'POST', a.token, { date: '2026-10-01', startTime: '9:00', endTime: '10:00' })).status, 400);
    assert.equal((await call(`/roundtables/${id}/proposals`, 'POST', a.token, { date: '2026-10-01', startTime: '10:00', endTime: '10:00' })).status, 400);
    assert.equal((await call(`/roundtables/${id}/proposals`, 'POST', a.token, { date: '2026-10-01', startTime: '09:00', endTime: '10:00', title: 'x' })).status, 400);
    assert.equal((await call(`/roundtables/${id}/proposals`, 'POST', outsider.token, (await availability(call, a.token, id)).slots[0])).status, 404);
    const slot = (await availability(call, a.token, id)).slots[0];
    const proposal = await (await call(`/roundtables/${id}/proposals`, 'POST', a.token, slot)).json();
    assert.equal((await call(`/roundtables/${id}/proposals/${proposal.id}`, 'PUT', a.token, {})).status, 400);
    assert.equal((await call(`/roundtables/${id}/proposals/${proposal.id}`, 'PUT', a.token, { decision: 'MAYBE' })).status, 400);
    assert.equal((await call(`/roundtables/${id}/proposals/${proposal.id}`, 'PUT', a.token, { decision: 'ACCEPT', extra: 1 })).status, 400);
    assert.equal((await call(`/roundtables/${id}/proposals/not-a-uuid`, 'PUT', a.token, { decision: 'ACCEPT' })).status, 404);
    assert.equal((await call(`/roundtables/${id}/proposals/${proposal.id}`, 'PUT', outsider.token, { decision: 'REJECT' })).status, 404);
    assert.equal((await call(`/roundtables/${id}/proposals`, 'POST', b.token, {})).status, 400);
  });
}
