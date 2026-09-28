import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../apps/api/dist/app.js';

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
  const start = async () => {
    app = await createApp({ storage: 'postgres', databaseUrl });
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
    await start();
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
  } finally {
    await app?.close();
    // schema 名由本测试生成并验证，仅移除本轮隔离测试数据。
    try { await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await db.$disconnect(); }
  }
});
