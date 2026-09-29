import assert from 'node:assert/strict';
export const sampleRoom = { title: '虚构周末打球', goal: '约一次共同活动', dateFrom: '2026-10-01', dateTo: '2026-10-03', startTime: '09:00', endTime: '18:00', durationMinutes: 60 };
export async function roomContract(t, call, user) {
  await t.test('创建、邀请码加入、重复加入与非成员隔离；DTO 不泄漏身份和个人数据', async () => {
    const a = await user('圆桌甲'), b = await user('圆桌乙'), c = await user('旁观者');
    assert.equal((await call('/roundtables')).status, 401);
    assert.equal((await call('/roundtables', 'POST', a.token, { ...sampleRoom, ownerId: b.user.id })).status, 400);
    await call('/me/memories', 'POST', a.token, { category: 'NOTE', label: '私密测试', content: '不应该出现在圆桌里的秘密' });
    const response = await call('/roundtables', 'POST', a.token, sampleRoom);
    assert.equal(response.status, 201);
    const room = await response.json();
    assert.equal(room.members.length, 1);
    assert.equal(room.members[0].shareBusy, false);
    assert.match(room.inviteCode, /^[A-F0-9]{20}$/);
    assert.equal((await call(`/roundtables/${room.id}`, 'GET', b.token)).status, 404);
    assert.deepEqual(await (await call('/roundtables', 'GET', b.token)).json(), []);
    const joined = await call('/roundtables/join', 'POST', b.token, { code: room.inviteCode.toLowerCase() });
    assert.equal(joined.status, 201);
    const view = await joined.json();
    assert.equal(view.members.length, 2);
    assert.equal(view.isOwner, false);
    assert.equal('inviteCode' in view, false);
    assert.ok(!JSON.stringify(view).includes(a.user.id));
    assert.ok(!JSON.stringify(view).includes('不应该出现在圆桌里的秘密'));
    assert.ok(view.members.every(member => !('userId' in member)));
    const repeated = await (await call('/roundtables/join', 'POST', b.token, { code: room.inviteCode })).json();
    assert.equal(repeated.members.length, 2);
    assert.equal(repeated.version, view.version);
    for (const [path, method, body] of [[`/roundtables/${room.id}`, 'GET'], [`/roundtables/${room.id}/membership`, 'PUT', { shareBusy: true }], [`/roundtables/${room.id}/close`, 'POST']]) {
      assert.equal((await call(path, method, c.token, body)).status, 404);
    }
    assert.equal((await call('/roundtables/not-a-uuid', 'GET', a.token)).status, 404);
  });
  await t.test('授权只能更改本人，更新邀请码后旧码失效，移除成员即时撤权并轮换邀请码', async () => {
    const a = await user('管理甲'), b = await user('管理乙');
    let room = await (await call('/roundtables', 'POST', a.token, sampleRoom)).json();
    let view = await (await call('/roundtables/join', 'POST', b.token, { code: room.inviteCode })).json();
    const id = room.id, memberId = view.members.find(member => member.isMe).id;
    assert.equal((await call(`/roundtables/${id}/membership`, 'PUT', a.token, { shareBusy: true, memberId })).status, 400);
    assert.equal((await call(`/roundtables/${id}/membership`, 'PUT', b.token, { shareBusy: 'true' })).status, 400);
    view = await (await call(`/roundtables/${id}/membership`, 'PUT', b.token, { shareBusy: true })).json();
    assert.equal(view.members.find(member => member.isMe).shareBusy, true);
    assert.equal(view.members.find(member => !member.isMe).shareBusy, false);
    assert.ok(view.members.find(member => member.isMe).consentUpdatedAt);
    view = await (await call(`/roundtables/${id}/membership`, 'PUT', b.token, { shareBusy: false })).json();
    assert.equal(view.members.find(member => member.isMe).shareBusy, false);
    for (const [path, method] of [[`/roundtables/${id}/invitation`, 'POST'], [`/roundtables/${id}/close`, 'POST'], [`/roundtables/${id}/members/${memberId}`, 'DELETE']]) assert.equal((await call(path, method, b.token)).status, 403);
    const oldCode = room.inviteCode;
    room = await (await call(`/roundtables/${id}/invitation`, 'POST', a.token)).json();
    assert.notEqual(room.inviteCode, oldCode);
    assert.equal((await call('/roundtables/join', 'POST', b.token, { code: oldCode })).status, 404);
    const beforeRemoval = room.inviteCode;
    room = await (await call(`/roundtables/${id}/members/${memberId}`, 'DELETE', a.token)).json();
    assert.equal(room.members.length, 1);
    assert.notEqual(room.inviteCode, beforeRemoval);
    assert.equal((await call(`/roundtables/${id}`, 'GET', b.token)).status, 404);
    assert.equal((await call('/roundtables/join', 'POST', b.token, { code: beforeRemoval })).status, 404);
    assert.equal((await call(`/roundtables/${id}/members/${room.members[0].id}`, 'DELETE', a.token)).status, 400);
  });
  await t.test('人数上限、成员退出、关闭撤销授权，关闭操作幂等且禁止再加入', async () => {
    const a = await user('关闭甲'), b = await user('关闭乙'), c = await user('关闭丙'), d = await user('关闭丁');
    let room = await (await call('/roundtables', 'POST', a.token, sampleRoom)).json();
    const { id, inviteCode: code } = room;
    for (const token of [b.token, c.token]) assert.equal((await call('/roundtables/join', 'POST', token, { code })).status, 201);
    assert.equal((await call('/roundtables/join', 'POST', d.token, { code })).status, 400);
    assert.equal((await call(`/roundtables/${id}/membership`, 'DELETE', a.token)).status, 400);
    assert.equal((await call(`/roundtables/${id}/membership`, 'DELETE', b.token)).status, 204);
    assert.equal((await call(`/roundtables/${id}`, 'GET', b.token)).status, 404);
    await call(`/roundtables/${id}/membership`, 'PUT', c.token, { shareBusy: true });
    room = await (await call(`/roundtables/${id}/close`, 'POST', a.token)).json();
    assert.equal(room.status, 'CLOSED');
    assert.ok(room.members.every(member => !member.shareBusy));
    assert.equal('inviteCode' in room, false);
    assert.equal((await (await call(`/roundtables/${id}/close`, 'POST', a.token)).json()).version, room.version);
    assert.equal((await call('/roundtables/join', 'POST', b.token, { code })).status, 404);
    assert.equal((await call(`/roundtables/${id}/membership`, 'PUT', c.token, { shareBusy: true })).status, 400);
    assert.equal((await call(`/roundtables/${id}/invitation`, 'POST', a.token)).status, 400);
  });
  await t.test('日期、时长、活动目标和邀请码格式校验', async () => {
    const a = await user('圆桌校验');
    for (const input of [{}, { ...sampleRoom, goal: ' ' }, { ...sampleRoom, title: '字'.repeat(61) }, { ...sampleRoom, goal: '字'.repeat(501) }, { ...sampleRoom, dateFrom: '2026-02-30' }, { ...sampleRoom, dateTo: '2026-09-30' }, { ...sampleRoom, dateTo: '2026-11-02' }, { ...sampleRoom, durationMinutes: 61 }, { ...sampleRoom, durationMinutes: 0 }, { ...sampleRoom, durationMinutes: 300 }, { ...sampleRoom, endTime: '09:30' }]) {
      assert.equal((await call('/roundtables', 'POST', a.token, input)).status, 400);
    }
    for (const value of [{}, { code: '' }, { code: 'A'.repeat(20), userId: a.user.id }]) assert.equal((await call('/roundtables/join', 'POST', a.token, value)).status, 400);
    assert.deepEqual(await (await call('/roundtables', 'GET', a.token)).json(), []);
  });
}
