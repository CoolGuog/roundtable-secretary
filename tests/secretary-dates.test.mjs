import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChinese, SecretaryService } from '../apps/api/dist/secretary.js';
import { isStale } from '../apps/api/dist/negotiation.js';

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
