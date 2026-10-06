import { request, today } from './secretary';
import { getRoom, isLocalRoomMode } from './roundtables';
export type ReviewParticipant = { memberId: string; name: string; isMe: boolean; active: boolean };
export type ReviewAllocation = { memberId: string; percent: number; reason: string; action: string };
export type ReviewInput = { version: number; date: string; outcome: 'NOT_HELD' | 'CANCELLED'; facts: string;
  allocations: ReviewAllocation[]; externalPercent: number; externalReason: string; unassignedPercent: number };
export type ReviewVote = { memberId: string; decision: 'PENDING' | 'ACCEPT' | 'DISPUTE'; comment: string; decidedAt: string | null };
export type ReviewRevision = Omit<ReviewInput, 'version'> & { revision: number; createdAt: string; status: 'DRAFT' | 'PENDING' | 'DISPUTED' | 'AGREED'; votes: ReviewVote[]; events: ReviewVote[] };
export type ReviewView = { version: number; canEdit: boolean; canVote: boolean; participants: ReviewParticipant[]; revisions: ReviewRevision[] };
const key = 'roundtable.demo.reviews.v1';
function records(): Array<{ roomId: string; view: ReviewView }> { const value = wx.getStorageSync(key); return Array.isArray(value) ? value : []; }
export function validateReview(value: ReviewInput): string {
  const date = new Date(value.date + 'T00:00:00Z');
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(value.date) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.date || value.date > today()) return '请选择今天或之前的有效会议日期';
  if (!['NOT_HELD', 'CANCELLED'].includes(value.outcome)) return '请选择会议结果';
  if (!value.facts.trim() || value.facts.trim().length > 1000) return '请填写 1 至 1000 字的事实经过和依据';
  const percentages = [...value.allocations.map(row => row.percent), value.externalPercent, value.unassignedPercent];
  if (percentages.some(n => !Number.isInteger(n) || n < 0 || n > 100)) return '每项比例须为 0 至 100 的整数';
  if (percentages.reduce((sum, n) => sum + n, 0) !== 100) return '成员责任、外部原因与待查合计须为 100%';
  if (value.allocations.some(row => (row.percent > 0 && !row.reason.trim()) || row.reason.length > 200 || row.action.length > 200)) return '分配责任时请填写依据，成员依据和改进事项各不超过 200 字';
  if ((value.externalPercent > 0 && !value.externalReason.trim()) || value.externalReason.length > 300) return '请填写外部原因说明，不超过 300 字';
  return '';
}
export async function getReview(roomId: string): Promise<ReviewView> {
  if (!isLocalRoomMode()) return request(`/roundtables/${encodeURIComponent(roomId)}/review`, 'GET');
  const room = await getRoom(roomId);
  return records().find(item => item.roomId === roomId)?.view ?? { version: 0, canEdit: room.isOwner, canVote: false,
    participants: room.members.map(p => ({ memberId: p.id, name: p.name, isMe: p.isMe, active: true })), revisions: [] };
}
export async function saveReview(roomId: string, input: ReviewInput): Promise<ReviewView> {
  const invalid = validateReview(input); if (invalid) throw new Error(invalid);
  if (!isLocalRoomMode()) return request(`/roundtables/${encodeURIComponent(roomId)}/review`, 'PUT', input);
  const room = await getRoom(roomId), current = await getReview(roomId);
  if (!room.isOwner) throw new Error('只有发起人可以修订复盘');
  if (input.version !== current.version) throw new Error('复盘已更新，请刷新核对后重新操作');
  if (input.date < room.dateFrom || input.date > room.dateTo) throw new Error('会议日期须在圆桌日期范围内');
  if (current.revisions.length >= 20) throw new Error('本次复盘最多保留 20 个版本');
  if (input.allocations.length !== current.participants.length || new Set(input.allocations.map(row => row.memberId)).size !== current.participants.length ||
    input.allocations.some(row => !current.participants.some(p => p.memberId === row.memberId))) throw new Error('请保留最初复盘的全部参与者');
  const { version, ...fields } = input;
  const view: ReviewView = { ...current, version: version + 1, canVote: false, revisions: [...current.revisions, { ...fields,
    revision: current.revisions.length + 1, createdAt: new Date().toISOString(), status: 'DRAFT',
    votes: current.participants.map(p => ({ memberId: p.memberId, decision: 'PENDING', comment: '', decidedAt: null })), events: [] }] };
  if (JSON.stringify(view).length > 80_000) throw new Error('本机复盘历史已达容量上限，本次操作未保存');
  const all = records(), index = all.findIndex(item => item.roomId === roomId);
  if ((index < 0 ? 0 : all[index].view.version) !== input.version) throw new Error('复盘已更新，请刷新核对后重新操作');
  if (index < 0) { if (all.length >= 100) throw new Error('本机最多保存 100 份会议复盘'); all.push({ roomId, view }); }
  else all[index] = { roomId, view };
  wx.setStorageSync(key, all); return view;
}
export async function voteReview(roomId: string, version: number, decision: 'ACCEPT' | 'DISPUTE', comment: string): Promise<ReviewView> {
  if (isLocalRoomMode()) throw new Error('本机草稿不能代替其他成员确认，逐人表态需要后台模式');
  return request(`/roundtables/${encodeURIComponent(roomId)}/review/vote`, 'PUT', { version, decision, comment });
}
