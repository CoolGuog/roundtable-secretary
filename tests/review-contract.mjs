import assert from 'node:assert/strict';
export async function reviewContract(t, call, user) {
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  async function setup() {
    const a = await user('复盘发起人'), b = await user('复盘成员'), other = await user('无关成员');
    const room = await (await call('/roundtables', 'POST', a.token, { title: '虚构失败会议', goal: '复盘测试',
      dateFrom: today, dateTo: today, startTime: '09:00', endTime: '17:00', durationMinutes: 60 })).json();
    await call('/roundtables/join', 'POST', b.token, { code: room.inviteCode });
    const route = `/roundtables/${room.id}/review`;
    const read = async (who = a) => (await call(route, 'GET', who.token)).json();
    const view = await read();
    const input = { version: 0, date: today, outcome: 'NOT_HELD', facts: '虚构：材料未准备，场地也未开放。',
      allocations: view.participants.map(p => ({ memberId: p.memberId, percent: p.isMe ? 30 : 20, reason: '未按约定完成准备', action: '下次提前一天核对' })),
      externalPercent: 20, externalReason: '场地关闭', unassignedPercent: 30 };
    const edit = async (value = input, who = a) => call(route, 'PUT', who.token, value);
    const vote = async (who, version, decision = 'ACCEPT', comment = '') => call(route + '/vote', 'PUT', who.token, { version, decision, comment });
    return { a, b, other, room, route, read, input, edit, vote };
  }
  await t.test('复盘权限隔离、责任比例与事实校验，客户端不能伪造确认', async () => {
    const c = await setup();
    assert.equal((await call(c.route)).status, 401);
    assert.equal((await call(c.route, 'GET', c.other.token)).status, 404);
    assert.equal((await c.edit(c.input, c.b)).status, 403);
    for (const patch of [{ facts: '' }, { externalPercent: 10 }, { unassignedPercent: -1 }, { unassignedPercent: 30.5 },
      { date: '2026-02-30' }, { outcome: 'SUCCESS' }, { status: 'AGREED' }, { votes: [] }, { externalReason: '' },
      { allocations: c.input.allocations.map(row => ({ ...row, reason: '' })) },
      { allocations: [c.input.allocations[0], c.input.allocations[0]] }, { allocations: [{ ...c.input.allocations[0], memberId: 'stranger' }, c.input.allocations[1]] }]) {
      assert.equal((await c.edit({ ...c.input, ...patch })).status, 400, JSON.stringify(patch));
    }
    assert.equal((await c.read()).version, 0);
    assert.equal((await c.edit()).status, 200);
    assert.equal((await call(c.route + '/vote', 'PUT', c.a.token, { version: 1, decision: 'ACCEPT', comment: '', memberId: c.input.allocations[1].memberId })).status, 400);
    assert.equal(JSON.stringify(await c.read()).includes(c.b.user.id), false, '不返回账号 ID');
  });
  await t.test('逐人确认与异议，修订清空确认且保留历史；撤回共识仍留表态记录', async () => {
    const c = await setup(); await c.edit();
    let current = await c.read();
    assert.equal(current.revisions[0].status, 'PENDING'); assert.ok(current.revisions[0].votes.every(v => v.decision === 'PENDING'));
    assert.equal((await c.vote(c.b, 1, 'DISPUTE')).status, 400);
    assert.equal((await c.vote(c.b, 1, 'DISPUTE', '我已按时提交材料，请核对')).status, 200);
    assert.equal((await c.read()).revisions[0].status, 'DISPUTED');
    assert.equal((await c.vote(c.a, 1)).status, 409);
    await c.vote(c.a, 2); await c.vote(c.b, 3);
    current = await c.read(); assert.equal(current.revisions[0].status, 'AGREED'); assert.equal(current.revisions[0].unassignedPercent, 30);
    assert.equal(current.revisions[0].events[0].comment, '我已按时提交材料，请核对');
    await c.vote(c.b, 4, 'DISPUTE', '发现新的证据');
    assert.equal((await c.read()).revisions[0].status, 'DISPUTED');
    assert.equal((await c.edit({ ...c.input, version: 5, facts: '核对新证据后的修订' })).status, 200);
    current = await c.read(); assert.equal(current.revisions.length, 2); assert.equal(current.revisions[0].events.length, 4);
    assert.ok(current.revisions[1].votes.every(v => v.decision === 'PENDING'));
    assert.equal((await c.edit({ ...c.input, version: 5 })).status, 409);
    assert.deepEqual(await (await call('/me/arrangements', 'GET', c.a.token)).json(), []);
  });
  await t.test('移除异议成员不能抹掉责任与确认，后来者不能代签，重新加入可本人表态', async () => {
    const c = await setup(); await c.edit(); await c.vote(c.b, 1, 'DISPUTE', '不同意');
    const bMember = (await c.read(c.b)).participants.find(p => p.isMe);
    const updated = await (await call(`/roundtables/${c.room.id}/members/${bMember.memberId}`, 'DELETE', c.a.token)).json();
    assert.equal((await call(c.route, 'GET', c.b.token)).status, 404);
    let view = await c.read(); assert.equal(view.participants.length, 2); assert.equal(view.participants.find(p => p.memberId === bMember.memberId).active, false);
    assert.equal(view.revisions[0].status, 'DISPUTED');
    assert.equal((await c.edit({ ...c.input, version: 2, allocations: [c.input.allocations[0]] })).status, 400);
    await call('/roundtables/join', 'POST', c.other.token, { code: updated.inviteCode });
    assert.equal((await c.vote(c.other, 2)).status, 403);
    await call('/roundtables/join', 'POST', c.b.token, { code: updated.inviteCode });
    assert.equal((await c.vote(c.b, 2)).status, 200);
    view = await c.read(); assert.equal(view.participants.find(p => p.memberId === bMember.memberId).active, true);
  });
  await t.test('并发修订只有一个生效，并发表态不会覆盖他人结果', async () => {
    const c = await setup();
    let results = await Promise.all([c.edit(), c.edit({ ...c.input, facts: '另一份并发修订' })]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    results = await Promise.all([c.vote(c.a, 1), c.vote(c.b, 1)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    await c.vote(results[0].status === 409 ? c.a : c.b, 2);
    const view = await c.read(); assert.equal(view.version, 3); assert.equal(view.revisions[0].status, 'AGREED');
  });
  await t.test('关闭圆桌后仍可复盘，未来或不在圆桌范围的日期被拒绝', async () => {
    const c = await setup();
    await call(`/roundtables/${c.room.id}/close`, 'POST', c.a.token);
    assert.equal((await c.edit({ ...c.input, date: '2099-12-31' })).status, 400);
    assert.equal((await c.edit({ ...c.input, date: '2000-01-01' })).status, 400);
    assert.equal((await c.edit({ ...c.input, outcome: 'CANCELLED' })).status, 200);
    assert.equal((await c.vote(c.b, 1)).status, 200);
    assert.equal((await c.read()).revisions[0].outcome, 'CANCELLED');
  });
}
