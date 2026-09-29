import assert from 'node:assert/strict';

// 与后端同一规则：一切按北京时间（UTC+8）取"今天"
const beijing = (days = 0) => new Date(Date.now() + 8 * 3600_000 + days * 86_400_000).toISOString().slice(0, 10);
const draft = async (call, token, text) => (await call('/me/secretary/draft', 'POST', token, { text })).json();

/** 秘书草稿契约：内存与数据库两种存储共用 */
export async function secretaryContract(t, call, user) {
  await t.test('一句话生成待确认草稿，并且绝不自动写入日程', async () => {
    const a = await user('秘书甲');
    const result = await draft(call, a.token, '明天下午三点到四点和导师开会');
    assert.equal(result.status, 'READY');
    assert.equal(result.date, beijing(1));
    assert.equal(result.startTime, '15:00');
    assert.equal(result.endTime, '16:00');
    assert.ok(result.title.includes('导师'), `标题未提取到事件：${result.title}`);
    assert.equal(result.confidence, 'HIGH');
    assert.equal(result.message, '已生成草稿，确认后才会写入你的日程');
    // 这条是本步的核心立场：草稿只是草稿
    assert.equal((await (await call('/me/arrangements', 'GET', a.token)).json()).length, 0);
  });

  await t.test('只说了开始时间：默认一小时并如实说明是推断', async () => {
    const a = await user('秘书乙');
    const result = await draft(call, a.token, '后天上午九点体检');
    assert.equal(result.date, beijing(2));
    assert.equal(result.startTime, '09:00');
    assert.equal(result.endTime, '10:00');
    assert.equal(result.confidence, 'MEDIUM');
    assert.ok(result.reasons.some(reason => reason.includes('默认')), '未说明时长是推断来的');
  });

  await t.test('信息不足时明确列出缺什么，不给编造的时段', async () => {
    const a = await user('秘书丙');
    const result = await draft(call, a.token, '随便');
    assert.equal(result.status, 'NEEDS_INPUT');
    assert.ok(result.missing.includes('date'));
    assert.ok(result.missing.includes('startTime'));
    assert.deepEqual(await (await call('/me/arrangements', 'GET', a.token)).json(), []);
  });

  await t.test('个人记忆里的限制会提醒冲突，但不替用户改决定', async () => {
    const a = await user('秘书丁');
    const memory = await (await call('/me/memories', 'POST', a.token, {
      category: 'CONSTRAINT', label: '晚上不运动', content: '晚上八点以后不要安排任何运动',
    })).json();
    assert.ok(memory.id);
    const result = await draft(call, a.token, '明天晚上八点半跑步');
    assert.equal(result.status, 'READY');
    assert.equal(result.startTime, '20:30');
    assert.ok(result.reasons.some(reason => reason.includes('冲突')), '未提示与个人记忆冲突');
    assert.ok(result.usedMemories.includes('晚上不运动'));
    assert.equal(result.confidence, 'MEDIUM');
    // 提醒归提醒，草稿仍然按用户说的保留
    assert.equal(result.endTime, '21:30');
  });

  await t.test('未登录、空描述、超长描述都被拒绝', async () => {
    const a = await user('秘书戊');
    assert.equal((await call('/me/secretary/draft', 'POST', undefined, { text: '明天开会' })).status, 401);
    assert.equal((await call('/me/secretary/draft', 'POST', a.token, { text: '   ' })).status, 400);
    assert.equal((await call('/me/secretary/draft', 'POST', a.token, { text: '安'.repeat(201) })).status, 400);
  });
}
