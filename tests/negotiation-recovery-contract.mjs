import assert from 'node:assert/strict';
const futureDate = () => new Date(Date.now() + 8 * 3600_000 + 2 * 86400_000).toISOString().slice(0, 10);
export async function negotiationRecoveryContract(t, call, user) {
  async function pair(label) {
    const a = await user(`${label}甲`), b = await user(`${label}乙`);
    const room = await (await call('/roundtables', 'POST', a.token, { title: label, goal: '虚构联调', dateFrom: futureDate(), dateTo: futureDate(), startTime: '09:00', endTime: '18:00', durationMinutes: 60 })).json();
    await call('/roundtables/join', 'POST', b.token, { code: room.inviteCode });
    for (const account of [a, b]) await call(`/roundtables/${room.id}/membership`, 'PUT', account.token, { shareBusy: true });
    const root = `/roundtables/${room.id}`;
    const propose = async () => {
      const availability = await (await call(root + '/availability', 'GET', a.token)).json();
      const response = await call(root + '/proposals', 'POST', a.token, availability.slots[0]);
      assert.equal(response.status, 201); return response.json();
    };
    return { a, b, room, root, propose };
  }
  await t.test('授权变更后不先读取旧方案也可直接发起新方案', async () => {
    const { a, b, root, propose } = await pair('重新发起');
    const first = await propose();
    await call(root + '/membership', 'PUT', b.token, { shareBusy: false });
    const second = await propose();
    assert.notEqual(first.id, second.id);
    assert.equal((await (await call(root + '/proposal', 'GET', a.token)).json()).id, second.id);
    assert.equal((await call(`${root}/proposals/${first.id}`, 'PUT', a.token, { decision: 'ACCEPT' })).status, 400);
  });
  await t.test('当前方案按时间显示；仅提案人能撤回，撤回后可重新发起', async () => {
    const { a, b, root, propose } = await pair('方案恢复');
    const first = await propose();
    for (const account of [a, b]) assert.equal((await call(`${root}/proposals/${first.id}`, 'PUT', account.token, { decision: 'ACCEPT' })).status, 200);
    assert.equal((await call(`${root}/proposals/${first.id}`, 'DELETE', a.token)).status, 400);
    const second = await propose();
    assert.equal((await call(`${root}/proposals/${second.id}`, 'DELETE', b.token)).status, 403);
    for (let i = 0; i < 2; i++) {
      const cancelled = await call(`${root}/proposals/${second.id}`, 'DELETE', a.token);
      assert.equal(cancelled.status, 200); assert.equal((await cancelled.json()).status, 'CANCELLED');
    }
    assert.equal((await (await call(root + '/proposal', 'GET', b.token)).json()).id, second.id);
    assert.equal((await call(`${root}/proposals/${second.id}`, 'PUT', b.token, { decision: 'ACCEPT' })).status, 400);
    const third = await propose();
    await call(`${root}/proposals/${third.id}`, 'PUT', b.token, { decision: 'REJECT' });
    assert.equal((await (await call(root + '/proposal', 'GET', a.token)).json()).id, third.id);
    for (const account of [a, b]) assert.equal((await (await call('/me/arrangements', 'GET', account.token)).json()).length, 1);
  });
  await t.test('全员写入失败不留下部分日程或失败投票，释放额度后可安全重试', async () => {
    const { a, b, root, propose } = await pair('满额回滚');
    let recordId;
    for (let i = 0; i < 100; i++) {
      const response = await call('/me/arrangements', 'POST', b.token, { title: '额度测试', date: futureDate(), startTime: '00:00', endTime: '01:00' });
      assert.equal(response.status, 201); recordId = (await response.json()).id;
    }
    const proposal = await propose();
    await call(`${root}/proposals/${proposal.id}`, 'PUT', a.token, { decision: 'ACCEPT' });
    assert.equal((await call(`${root}/proposals/${proposal.id}`, 'PUT', b.token, { decision: 'ACCEPT' })).status, 400);
    assert.equal((await (await call('/me/arrangements', 'GET', a.token)).json()).length, 0);
    assert.equal((await (await call('/me/arrangements', 'GET', b.token)).json()).length, 100);
    const pending = await (await call(root + '/proposal', 'GET', b.token)).json();
    assert.equal(pending.votes.find(vote => vote.isMe).decision, 'PENDING');
    await call(`/me/arrangements/${recordId}`, 'DELETE', b.token);
    const retried = await call(`${root}/proposals/${proposal.id}`, 'PUT', b.token, { decision: 'ACCEPT' });
    assert.equal(retried.status, 200); assert.equal((await retried.json()).status, 'CONFIRMED');
    assert.equal((await (await call('/me/arrangements', 'GET', a.token)).json()).length, 1);
    assert.equal((await (await call('/me/arrangements', 'GET', b.token)).json()).length, 100);
  });
}
