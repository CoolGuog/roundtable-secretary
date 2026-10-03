import assert from 'node:assert/strict';

export const sampleMemory = { category: 'PREFERENCE', label: '活动时段', content: '周末下午方便' };
export async function memoryContract(t, call, user) {
  await t.test('记忆增改删、来源、更新时间及用户隔离', async () => {
    const a = await user('记忆甲'), b = await user('记忆乙');
    assert.equal((await call('/me/memories')).status, 401);
    assert.equal((await call('/me/memories', 'POST', 'a'.repeat(64), sampleMemory)).status, 401);
    const created = await call('/me/memories', 'POST', a.token, sampleMemory);
    assert.equal(created.status, 201);
    const item = await created.json();
    assert.equal(item.source, 'USER_INPUT');
    assert.ok(Number.isFinite(Date.parse(item.updatedAt)));
    assert.deepEqual(Object.keys(item).sort(), ['id', 'category', 'label', 'content', 'source', 'createdAt', 'updatedAt'].sort());
    assert.deepEqual(await (await call('/me/memories', 'GET', b.token)).json(), []);
    const route = `/me/memories/${item.id}`;
    assert.equal((await call(route, 'PUT', b.token, sampleMemory)).status, 404);
    assert.equal((await call(route, 'DELETE', b.token)).status, 404);
    const changed = await call(route, 'PUT', a.token, { category: 'CONSTRAINT', label: ' 时间限制 ', content: ' 周一晚上不参加活动 ' });
    assert.equal(changed.status, 200);
    const edited = await changed.json();
    assert.equal(edited.label, '时间限制');
    assert.equal(edited.content, '周一晚上不参加活动');
    assert.equal(edited.category, 'CONSTRAINT');
    assert.equal(edited.createdAt, item.createdAt);
    assert.ok(edited.updatedAt >= item.updatedAt);
    assert.deepEqual(await (await call('/me/memories', 'GET', a.token)).json(), [edited]);
    assert.equal((await call(route, 'DELETE', a.token)).status, 204);
    assert.equal((await call(route, 'DELETE', a.token)).status, 404);
    assert.equal((await call(route, 'PUT', a.token, sampleMemory)).status, 404);
    assert.deepEqual(await (await call('/me/memories', 'GET', a.token)).json(), []);
  });
  await t.test('记忆拒绝越权字段、伪造来源、超长内容与无效类型，失败不改数据', async () => {
    const a = await user('记忆校验');
    const item = await (await call('/me/memories', 'POST', a.token, sampleMemory)).json();
    for (const value of [null, [], {}, { ...sampleMemory, category: 'UNKNOWN' }, { ...sampleMemory, category: {} },
      { ...sampleMemory, label: ' ' }, { ...sampleMemory, content: ' ' }, { ...sampleMemory, label: '字'.repeat(41) },
      { ...sampleMemory, content: '字'.repeat(501) }, { ...sampleMemory, userId: a.user.id },
      { ...sampleMemory, source: 'SECRETARY' }, { ...sampleMemory, sourceRef: 'forged' }, { ...sampleMemory, id: item.id }]) {
      assert.equal((await call('/me/memories', 'POST', a.token, value)).status, 400);
      assert.equal((await call(`/me/memories/${item.id}`, 'PUT', a.token, value)).status, 400);
    }
    for (const method of ['PUT', 'DELETE']) assert.equal((await call('/me/memories/not-a-uuid', method, a.token, method === 'PUT' ? sampleMemory : undefined)).status, 404);
    assert.deepEqual(await (await call('/me/memories', 'GET', a.token)).json(), [item]);
    const boundary = await call('/me/memories', 'POST', a.token, { category: 'NOTE', label: '字'.repeat(40), content: '字'.repeat(500) });
    assert.equal(boundary.status, 201);
  });
}
