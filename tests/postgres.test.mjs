import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../apps/api/dist/app.js';
import { memoryContract, sampleMemory } from './memory-contract.mjs';
import { roomContract, sampleRoom } from './room-contract.mjs';
import { negotiationContract } from './negotiation-contract.mjs';
import { secretaryContract } from './secretary-contract.mjs';
import { StubModel } from '../apps/api/dist/secretary.js';
import { negotiationRecoveryContract } from './negotiation-recovery-contract.mjs';

test('PostgreSQL 持久化、隔离、过期与并发配额', { skip: !process.env.RUN_POSTGRES_TESTS }, async t => {
  assert.ok(process.env.DATABASE_URL, '需要本机 DATABASE_URL');
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), '自动测试仅连接本机数据库');
  const schema = `rt_test_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^rt_test_[a-f0-9]{32}$/);
  url.searchParams.set('schema', schema);
  const databaseUrl = url.toString();
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  let app, base;
  const start = async (authMode = 'demo', wechatAppId = 'wx0123456789abcdef') => {
    app = await createApp({ storage: 'postgres', databaseUrl, authMode, wechatAppId,
      wechatExchange: async code => ({ openId: code === 'code-B' ? 'openid-B' : 'openid-A' }),
      secretary: { mode: 'stub', model: new StubModel() } });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  };
  const call = (route, method = 'GET', token, body) => fetch(base + route, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const user = async name => {
    const response = await call('/dev/sessions', 'POST', undefined, { name });
    assert.equal(response.status, 201);
    return response.json();
  };
  const sample = { title: '虚构数据库日程', date: '2026-10-01', startTime: '00:15', endTime: '01:00' };
  try {
    const migration = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 60_000,
    });
    // 不输出迁移日志，避免失败诊断意外包含连接信息。
    assert.equal(migration.status, 0, '隔离测试 schema 迁移失败');
    const drift = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-schema-datasource', 'prisma/schema.prisma', '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code'], {
      env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(drift.status, 0, '迁移后的数据库结构与 Prisma 模型不一致');
    await start();
    await memoryContract(t, call, user);
    await roomContract(t, call, user);
    await negotiationContract(t, call, user);
    await negotiationRecoveryContract(t, call, user);
    await t.test('并发发起只保留一个开放方案，过期后直接重提，全员并发确认只写一次', async () => {
      const a = await user('并发提案甲'), b = await user('并发提案乙');
      const date = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
      const room = await (await call('/roundtables', 'POST', a.token, { ...sampleRoom, dateFrom: date, dateTo: date })).json();
      await call('/roundtables/join', 'POST', b.token, { code: room.inviteCode });
      const route = `/roundtables/${room.id}`;
      for (const account of [a, b]) await call(route + '/membership', 'PUT', account.token, { shareBusy: true });
      const slot = (await (await call(route + '/availability', 'GET', a.token)).json()).slots[0];
      const results = await Promise.all([a, b].map(account => call(route + '/proposals', 'POST', account.token, slot)));
      assert.equal(results.filter(response => response.status === 201).length, 1);
      assert.ok(results.every(response => [201, 400].includes(response.status)));
      const old = await results.find(response => response.status === 201).json();
      await db.proposal.update({ where: { id: old.id }, data: { expiresAt: new Date(0) } });
      const fresh = await call(route + '/proposals', 'POST', a.token, slot);
      assert.equal(fresh.status, 201);
      const proposal = await fresh.json();
      const votes = await Promise.all([a, b].map(account => call(`${route}/proposals/${proposal.id}`, 'PUT', account.token, { decision: 'ACCEPT' })));
      assert.ok(votes.every(response => response.status === 200));
      assert.equal((await (await call(route + '/proposal', 'GET', a.token)).json()).status, 'CONFIRMED');
      for (const account of [a, b]) assert.equal(await db.arrangement.count({ where: { ownerId: account.user.id } }), 1);
    });
    await t.test('撤回与最终确认竞争时整体确认或整体撤回，不留下部分日程', async () => {
      const a = await user('竞争甲'), b = await user('竞争乙');
      const date = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
      const room = await (await call('/roundtables', 'POST', a.token, { ...sampleRoom, dateFrom: date, dateTo: date })).json();
      await call('/roundtables/join', 'POST', b.token, { code: room.inviteCode });
      const route = `/roundtables/${room.id}`;
      for (const account of [a, b]) await call(route + '/membership', 'PUT', account.token, { shareBusy: true });
      const slot = (await (await call(route + '/availability', 'GET', a.token)).json()).slots[0];
      const proposal = await (await call(route + '/proposals', 'POST', a.token, slot)).json();
      await call(`${route}/proposals/${proposal.id}`, 'PUT', a.token, { decision: 'ACCEPT' });
      const results = await Promise.all([call(`${route}/proposals/${proposal.id}`, 'DELETE', a.token), call(`${route}/proposals/${proposal.id}`, 'PUT', b.token, { decision: 'ACCEPT' })]);
      assert.ok(results.every(response => [200, 400].includes(response.status)));
      const current = await (await call(route + '/proposal', 'GET', a.token)).json();
      assert.ok(['CONFIRMED', 'CANCELLED'].includes(current.status));
      for (const account of [a, b]) assert.equal(await db.arrangement.count({ where: { ownerId: account.user.id } }), current.status === 'CONFIRMED' ? 1 : 0);
    });
    await secretaryContract(t, call, user);
    await t.test('圆桌并发加入不超员，重复加入不重复创建，重启保留，邀请过期失效', async () => {
      const a = await user('并发发起'), b = await user('并发伙伴');
      const room = await (await call('/roundtables', 'POST', a.token, sampleRoom)).json();
      const same = await Promise.all(Array.from({ length: 3 }, () => call('/roundtables/join', 'POST', b.token, { code: room.inviteCode })));
      assert.ok(same.every(response => response.status === 201));
      const others = await Promise.all([user('候选甲'), user('候选乙'), user('候选丙')]);
      const joined = await Promise.all(others.map(member => call('/roundtables/join', 'POST', member.token, { code: room.inviteCode })));
      assert.equal(joined.filter(response => response.status === 201).length, 1);
      assert.ok(joined.every(response => [201, 400].includes(response.status)));
      assert.equal(await db.roundtableMember.count({ where: { roomId: room.id } }), 3);
      await app.close(); app = undefined; await start();
      assert.equal((await (await call(`/roundtables/${room.id}`, 'GET', a.token)).json()).members.length, 3);
      await db.roundtable.update({ where: { id: room.id }, data: { inviteExpiresAt: new Date(0) } });
      assert.equal((await call('/roundtables/join', 'POST', b.token, { code: room.inviteCode })).status, 404);
    });
    await t.test('圆桌并发创建不突破 20 个活跃房间', async () => {
      const a = await user('数据库圆桌配额');
      for (let i = 0; i < 19; i++) assert.equal((await call('/roundtables', 'POST', a.token, sampleRoom)).status, 201);
      const responses = await Promise.all(Array.from({ length: 3 }, () => call('/roundtables', 'POST', a.token, sampleRoom)));
      assert.equal(responses.filter(response => response.status === 201).length, 1);
      assert.ok(responses.every(response => [201, 400].includes(response.status)));
      assert.equal(await db.roundtable.count({ where: { ownerId: a.user.id, status: 'OPEN' } }), 20);
    });
    await t.test('记忆跨重启保留，编辑秘书来源后转为用户录入并清除内部引用', async () => {
      const m = await user('记忆重启');
      const item = await (await call('/me/memories', 'POST', m.token, sampleMemory)).json();
      await db.personalMemory.update({ where: { id: item.id }, data: { source: 'SECRETARY', sourceRef: 'private-test-ref' } });
      await app.close(); app = undefined;
      await start();
      const records = await (await call('/me/memories', 'GET', m.token)).json();
      assert.equal(records[0].id, item.id);
      assert.equal(records[0].source, 'SECRETARY');
      assert.equal('sourceRef' in records[0], false);
      assert.equal((await call(`/me/memories/${item.id}`, 'PUT', m.token, sampleMemory)).status, 200);
      const row = await db.personalMemory.findUniqueOrThrow({ where: { id: item.id } });
      assert.equal(row.source, 'USER_INPUT');
      assert.equal(row.sourceRef, null);
    });
    await t.test('记忆并发新增不会突破单用户 100 条配额', async () => {
      const m = await user('记忆并发');
      await db.personalMemory.createMany({ data: Array.from({ length: 99 }, () => ({ userId: m.user.id, ...sampleMemory })) });
      const responses = await Promise.all(Array.from({ length: 4 }, () => call('/me/memories', 'POST', m.token, sampleMemory)));
      assert.equal(responses.filter(response => response.status === 201).length, 1);
      assert.ok(responses.every(response => [201, 400].includes(response.status)));
      assert.equal(await db.personalMemory.count({ where: { userId: m.user.id } }), 100);
    });
    const a = await user('甲');
    const b = await user('乙');
    let id;
    await t.test('健康状态、北京时间转换及私密默认值', async () => {
      assert.equal((await (await call('/health')).json()).persistence, 'postgres');
      const response = await call('/me/arrangements', 'POST', a.token, sample);
      assert.equal(response.status, 201);
      const record = await response.json();
      id = record.id;
      assert.equal(record.date, sample.date);
      assert.equal(record.startTime, sample.startTime);
      const row = await db.arrangement.findUniqueOrThrow({ where: { id } });
      assert.equal(row.startsAt.toISOString(), '2026-09-30T16:15:00.000Z');
      assert.equal(row.scope, 'PRIVATE');
      const session = await db.demoSession.findUniqueOrThrow({ where: { tokenHash: createHash('sha256').update(a.token).digest('hex') } });
      assert.notEqual(session.tokenHash, a.token);
    });
    await t.test('真实关闭应用再重建后，同一令牌仍能读取日程', async () => {
      await app.close(); app = undefined;
      await start();
      const records = await (await call('/me/arrangements', 'GET', a.token)).json();
      assert.equal(records.length, 1);
      assert.equal(records[0].id, id);
    });
    await t.test('编辑安排：按北京时间落库、只改标题不动时间、越权拒绝', async () => {
      const updated = await call(`/me/arrangements/${id}`, 'PUT', a.token,
        { title: '改过的日程', date: '2026-10-03', startTime: '00:15', endTime: '01:00' });
      assert.equal(updated.status, 200);
      let row = await db.arrangement.findUniqueOrThrow({ where: { id } });
      assert.equal(row.title, '改过的日程');
      assert.equal(row.startsAt.toISOString(), '2026-10-02T16:15:00.000Z');
      assert.equal(row.endsAt.toISOString(), '2026-10-02T17:00:00.000Z');

      const partial = await call(`/me/arrangements/${id}`, 'PUT', a.token, { title: '只改标题' });
      assert.equal(partial.status, 200);
      row = await db.arrangement.findUniqueOrThrow({ where: { id } });
      assert.equal(row.title, '只改标题');
      assert.equal(row.startsAt.toISOString(), '2026-10-02T16:15:00.000Z');

      // 别人的安排按"不存在"处理；被拒绝的编辑不能改动原记录。
      assert.equal((await call(`/me/arrangements/${id}`, 'PUT', b.token, { title: '越权' })).status, 404);
      assert.equal((await call('/me/arrangements/not-a-uuid', 'PUT', a.token, { title: '不存在' })).status, 404);
      for (const invalid of [{}, { title: ' ' }, { unknown: 1 }, { date: '2026-02-30' }, { startTime: '25:00' }, { endTime: '00:00' }]) {
        assert.equal((await call(`/me/arrangements/${id}`, 'PUT', a.token, invalid)).status, 400);
      }
      assert.equal(await db.arrangement.count({ where: { ownerId: a.user.id } }), 1);
    });
    await t.test('匿名、伪造会话、越权及无效输入拒绝', async () => {
      assert.equal((await call('/me/arrangements')).status, 401);
      assert.equal((await call('/me/arrangements', 'GET', 'a'.repeat(64))).status, 401);
      assert.deepEqual(await (await call('/me/arrangements', 'GET', b.token)).json(), []);
      assert.equal((await call(`/me/arrangements/${id}`, 'DELETE', b.token)).status, 404);
      assert.equal((await call('/me/arrangements/not-a-uuid', 'DELETE', a.token)).status, 404);
      for (const invalid of [{ ...sample, ownerUserId: b.user.id }, { ...sample, date: '2026-02-30' }, { ...sample, endTime: '00:00' }]) {
        assert.equal((await call('/me/arrangements', 'POST', a.token, invalid)).status, 400);
      }
    });
    await t.test('本人删除及重复删除', async () => {
      assert.equal((await call(`/me/arrangements/${id}`, 'DELETE', a.token)).status, 204);
      assert.equal((await call(`/me/arrangements/${id}`, 'DELETE', a.token)).status, 404);
    });
    await t.test('99 条时并发新增不能突破 100 条上限', async () => {
      await db.arrangement.createMany({ data: Array.from({ length: 99 }, (_, i) => ({ ownerId: a.user.id, title: `配额${i}`,
        startsAt: new Date('2026-10-01T10:00:00Z'), endsAt: new Date('2026-10-01T11:00:00Z') })) });
      const responses = await Promise.all(Array.from({ length: 4 }, () => call('/me/arrangements', 'POST', a.token, sample)));
      assert.equal(responses.filter(response => response.status === 201).length, 1);
      assert.ok(responses.every(response => [201, 400].includes(response.status)));
      assert.equal(await db.arrangement.count({ where: { ownerId: a.user.id } }), 100);
      assert.equal(await db.arrangement.count({ where: { ownerId: b.user.id } }), 0);
    });
    await t.test('过期会话失效且不删除已有数据', async () => {
      await db.demoSession.updateMany({ where: { userId: a.user.id }, data: { expiresAt: new Date(0) } });
      assert.equal((await call('/me/arrangements', 'GET', a.token)).status, 401);
      assert.equal(await db.arrangement.count({ where: { ownerId: a.user.id } }), 100);
    });
    await app.close(); app = undefined;
    await start('wechat');
    const login = async code => {
      const response = await call('/auth/wechat', 'POST', undefined, { code });
      assert.equal(response.status, 201);
      const session = await response.json();
      assert.deepEqual(Object.keys(session.user).sort(), ['id', 'name', 'secretaryName']);
      assert.equal(session.mode, 'wechat');
      assert.ok(!JSON.stringify(session).includes('openid'));
      return session;
    };
    const wa = await login('code-A');
    const wb = await login('code-B');
    let wechatRecord;
    let wechatMemory;
    let wechatRoom;
    await t.test('微信模式关闭演示入口，拒绝演示令牌与伪造身份', async () => {
      assert.equal((await call('/dev/sessions', 'POST', undefined, { name: 'test' })).status, 404);
      assert.equal((await call('/me', 'GET', b.token)).status, 401);
      assert.equal((await call('/auth/wechat', 'POST', undefined, { code: 'code-A', openid: 'victim' })).status, 400);
      const created = await call('/me/arrangements', 'POST', wa.token, sample);
      assert.equal(created.status, 201);
      wechatRecord = await created.json();
      const memoryResponse = await call('/me/memories', 'POST', wa.token, sampleMemory);
      assert.equal(memoryResponse.status, 201);
      wechatMemory = await memoryResponse.json();
      wechatRoom = await (await call('/roundtables', 'POST', wa.token, sampleRoom)).json();
      assert.equal((await call('/roundtables/join', 'POST', wb.token, { code: wechatRoom.inviteCode })).status, 201);
      assert.deepEqual(await (await call('/me/memories', 'GET', wb.token)).json(), []);
      assert.equal((await call(`/me/memories/${wechatMemory.id}`, 'PUT', wb.token, sampleMemory)).status, 404);
      assert.equal((await call(`/me/memories/${wechatMemory.id}`, 'DELETE', wb.token)).status, 404);
      assert.deepEqual(await (await call('/me/arrangements', 'GET', wb.token)).json(), []);
      assert.equal((await call(`/me/arrangements/${wechatRecord.id}`, 'PUT', wb.token, { title: '越权' })).status, 404);
      assert.equal((await call(`/me/arrangements/${wechatRecord.id}`, 'DELETE', wb.token)).status, 404);
    });
    await t.test('微信用户跨重启及重新登录回到同一账号，过期与退出令牌失效', async () => {
      await app.close(); app = undefined;
      await start('wechat');
      assert.equal((await call('/me', 'GET', wa.token)).status, 200);
      await db.wechatSession.updateMany({ where: { userId: wa.user.id }, data: { expiresAt: new Date(0) } });
      assert.equal((await call('/me', 'GET', wa.token)).status, 401);
      const renewed = await login('code-A-new');
      assert.equal(renewed.user.id, wa.user.id);
      assert.equal((await (await call(`/roundtables/${wechatRoom.id}`, 'GET', renewed.token)).json()).members.length, 2);
      assert.notEqual(renewed.token, wa.token);
      assert.equal((await (await call('/me/arrangements', 'GET', renewed.token)).json())[0].id, wechatRecord.id);
      assert.equal((await (await call('/me/memories', 'GET', renewed.token)).json())[0].id, wechatMemory.id);
      assert.equal((await call('/me/session', 'DELETE', renewed.token)).status, 204);
      assert.equal((await call('/me', 'GET', renewed.token)).status, 401);
      assert.equal(await db.arrangement.count({ where: { ownerId: wa.user.id } }), 1);
    });
    await t.test('并发登录不创建重复用户，会话数量有上限', async () => {
      const sessions = await Promise.all([login('code-A-1'), login('code-A-2')]);
      assert.ok(sessions.every(session => session.user.id === wa.user.id));
      for (let i = 0; i < 6; i++) await login(`code-A-${i + 3}`);
      assert.equal(await db.user.count({ where: { wxAppId: 'wx0123456789abcdef', wxOpenId: 'openid-A' } }), 1);
      assert.equal(await db.wechatSession.count({ where: { userId: wa.user.id } }), 5);
    });
    await t.test('不同 AppID 的相同 OpenID 不会串号或复用令牌', async () => {
      const prior = await login('code-A');
      await app.close(); app = undefined;
      await start('wechat', 'wxfedcba9876543210');
      assert.equal((await call('/me', 'GET', prior.token)).status, 401);
      const anotherApp = await login('code-A');
      assert.notEqual(anotherApp.user.id, wa.user.id);
      assert.equal((await call('/roundtables/join', 'POST', anotherApp.token, { code: wechatRoom.inviteCode })).status, 404);
      assert.deepEqual(await (await call('/me/arrangements', 'GET', anotherApp.token)).json(), []);
      assert.deepEqual(await (await call('/me/memories', 'GET', anotherApp.token)).json(), []);
    });
  } finally {
    await app?.close();
    // schema 名由本测试生成并验证，仅移除本轮隔离测试数据。
    try { await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await db.$disconnect(); }
  }
});
