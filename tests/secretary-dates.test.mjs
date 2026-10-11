import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChinese, SecretaryService } from '../apps/api/dist/secretary.js';
import { isStale, availabilityOf } from '../apps/api/dist/negotiation.js';

test('明确年份、下下周和无效日期不会被误解为其他日期', () => {
  assert.equal(parseChinese('2027年2月10日下午三点开会', '2026-09-30').date, '2027-02-10');
  assert.equal(parseChinese('2027-02-10下午三点开会', '2026-09-30').date, '2027-02-10');
  assert.equal(parseChinese('下下周三下午三点开会', '2026-09-30').date, '2026-10-14');
  assert.equal(parseChinese('本周一下午三点开会', '2026-09-30').date, '2026-09-28');
  for (const text of ['2月30日下午三点开会', '2027年2月29日下午三点开会']) assert.equal(parseChinese(text, '2026-09-30').date, null);
});
test('无效时刻不会滚动为其他时间，跨午夜结束须补充而非取模', () => {
  for (const text of ['明天下午15:90开会', '明天25点开会', '明天24:00开会']) assert.equal(parseChinese(text, '2026-09-30').startTime, null);
  assert.equal(parseChinese('明天23点半开会', '2026-09-30').endTime, null);
});
test('模型返回不存在的日期不能生成可保存的草稿', async () => {
  const model = { name: 'test', complete: async () => ({ title: '会议', date: '2027-02-30', startTime: '10:00', endTime: '11:00' }) };
  const draft = await new SecretaryService('http', model).draft('会议', [], new Date('2026-09-30T00:00:00Z'));
  assert.equal(draft.status, 'NEEDS_INPUT'); assert.equal(draft.date, null); assert.ok(draft.missing.includes('date'));
});
test('活动开始时间已过即失效，即使 24 小时有效期未结束', () => {
  const proposal = { status: 'OPEN', date: '2026-09-30', startTime: '09:00', expiresAt: new Date('2026-10-01T00:00:00Z'), roomVersion: 1 };
  assert.equal(isStale(proposal, 1, Date.parse('2026-09-30T01:00:01Z')), true);
});

test('当天上午虽空闲但已过去，只推荐下午未来时间；剩余被占用时明确说明未来无空档', () => {
  const room = { id: 'room', status: 'OPEN', version: 1, title: '活动', dateFrom: '2026-10-10', dateTo: '2026-10-10', startTime: '09:00', endTime: '21:00', durationMinutes: 60, members: [{ userId: 'a', shareBusy: true }, { userId: 'b', shareBusy: true }] };
  const now = new Date('2026-10-10T15:04:00+08:00');
  const available = availabilityOf(room, [], now);
  assert.equal(available.slots[0].startTime, '15:30');
  assert.ok(available.slots.every(slot => slot.startTime > '15:04'));
  const blocked = availabilityOf(room, [{ start: Date.parse('2026-10-10T14:27:00+08:00'), end: Date.parse('2026-10-10T21:00:00+08:00') }], now);
  assert.equal(blocked.slots.length, 0); assert.match(blocked.reason, /未来共同空档/); assert.match(blocked.reason, /已过去/);
  const ended = availabilityOf(room, [], new Date('2026-10-10T20:30:00+08:00'));
  assert.equal(ended.slots.length, 0); assert.match(ended.reason, /没有足够的未来时间/);
});
