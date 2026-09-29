import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { sampleRoom } from './room-contract.mjs';
function client(mode = 'local') {
  const storage = new Map(), calls = [], exports = {};
  const source = fs.readFileSync('apps/miniprogram/src/services/roundtables.ts', 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, { exports,
    wx: { getStorageSync: key => structuredClone(storage.get(key)), setStorageSync: (key, value) => storage.set(key, structuredClone(value)) },
    require: name => name === './config' ? { config: { mode } } : { request: async (...args) => { calls.push(args); return []; } },
  });
  return { api: exports, calls, storage };
}
test('本机圆桌保存、授权、关闭；不伪造邀请码或多人加入', async () => {
  const { api, storage } = client();
  const room = await api.createRoom(sampleRoom);
  assert.equal(room.members.length, 1); assert.equal('inviteCode' in room, false);
  assert.equal((await api.listRooms()).length, 1);
  assert.equal(storage.get('roundtable.demo.rooms.v1')[0].title, sampleRoom.title);
  await assert.rejects(api.joinRoom('A'.repeat(20)), /后台模式/);
  await api.roomAction(room.id, 'consent', true);
  assert.equal((await api.getRoom(room.id)).members[0].shareBusy, true);
  await api.roomAction(room.id, 'close');
  assert.equal((await api.getRoom(room.id)).status, 'CLOSED');
  assert.equal((await api.getRoom(room.id)).members[0].shareBusy, false);
  await assert.rejects(api.roomAction(room.id, 'consent', true), /关闭/);
});
test('协商接口使用约定路由与方法，本机演示明确拒绝协商', async () => {
  const slot = { date: '2026-10-01', startTime: '09:00', endTime: '10:00' };
  const local = client();
  for (const call of [() => local.api.loadAvailability('id'), () => local.api.loadProposal('id'),
    () => local.api.proposeSlot('id', slot), () => local.api.decideProposal('id', 'p', 'ACCEPT')]) {
    await assert.rejects(call(), /协商需要后台模式/);
  }
  const c = client('api');
  await c.api.loadAvailability('id');
  await c.api.loadProposal('id');
  await c.api.proposeSlot('id', slot);
  await c.api.decideProposal('id', 'p', 'ACCEPT');
  assert.deepEqual(c.calls.map(call => [call[0], call[1]]), [
    ['/roundtables/id/availability', 'GET'], ['/roundtables/id/proposal', 'GET'],
    ['/roundtables/id/proposals', 'POST'], ['/roundtables/id/proposals/p', 'PUT'],
  ]);
  // 跨 realm 的对象原型不同，只能按内容比较
  assert.deepEqual({ ...c.calls[2][2] }, slot);
  assert.deepEqual({ ...c.calls[3][2] }, { decision: 'ACCEPT' });
});
test('本机日期和时间边界拒绝，API 操作使用约定路由与方法', async () => {
  const local = client();
  for (const value of [{ ...sampleRoom, dateFrom: '2026-02-30' }, { ...sampleRoom, durationMinutes: 61 }, { ...sampleRoom, endTime: '08:00' }, { ...sampleRoom, goal: ' ' }]) await assert.rejects(local.api.createRoom(value));
  assert.equal((await local.api.listRooms()).length, 0);
  const c = client('api');
  await c.api.listRooms(); await c.api.createRoom(sampleRoom); await c.api.joinRoom('A'.repeat(20));
  await c.api.getRoom('id'); await c.api.roomAction('id', 'consent', true); await c.api.roomAction('id', 'rotate');
  await c.api.roomAction('id', 'remove', 'member'); await c.api.roomAction('id', 'leave'); await c.api.roomAction('id', 'close');
  assert.deepEqual(c.calls.map(call => [call[0], call[1]]), [
    ['/roundtables', 'GET'], ['/roundtables', 'POST'], ['/roundtables/join', 'POST'], ['/roundtables/id', 'GET'],
    ['/roundtables/id/membership', 'PUT'], ['/roundtables/id/invitation', 'POST'], ['/roundtables/id/members/member', 'DELETE'], ['/roundtables/id/membership', 'DELETE'], ['/roundtables/id/close', 'POST'],
  ]);
  assert.equal(c.calls[4][2].shareBusy, true);
  assert.equal(c.storage.size, 0);
});
