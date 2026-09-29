import { config } from './config';
import { request } from './secretary';
export interface RoomInput { title: string; goal: string; dateFrom: string; dateTo: string; startTime: string; endTime: string; durationMinutes: number; }
export interface RoomMember { id: string; name: string; role: 'OWNER' | 'MEMBER'; isMe: boolean; shareBusy: boolean; consentUpdatedAt: string | null; }
export interface Room extends RoomInput { id: string; status: 'OPEN' | 'CLOSED'; version: number; createdAt: string; isOwner: boolean; members: RoomMember[]; inviteCode?: string; inviteExpiresAt?: string; }
const dataKey = 'roundtable.demo.rooms.v1';
export function isLocalRoomMode() { return config.mode === 'local'; }
function records(): Room[] { const value = wx.getStorageSync(dataKey); return Array.isArray(value) ? value : []; }
function validate(input: RoomInput): RoomInput {
  if (!input.title.trim() || input.title.trim().length > 60) throw new Error('名称须为 1 至 60 字');
  if (!input.goal.trim() || input.goal.trim().length > 500) throw new Error('目标须为 1 至 500 字');
  for (const date of [input.dateFrom, input.dateTo]) {
    if (!/^20\d{2}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('请选择有效日期');
  }
  const days = (Date.parse(input.dateTo) - Date.parse(input.dateFrom)) / 86400_000;
  if (days < 0 || days > 30) throw new Error('日期范围须为顺序排列的 1 至 31 天');
  if (![input.startTime, input.endTime].every(time => /^([01]\d|2[0-3]):[0-5]\d$/.test(time))) throw new Error('请选择有效时间');
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 15 || input.durationMinutes > 240 || input.durationMinutes % 15 || minutes(input.endTime) - minutes(input.startTime) < input.durationMinutes) throw new Error('活动时长须为 15 至 240 分钟、15 的倍数，且不超过每日时间窗口');
  return { ...input, title: input.title.trim(), goal: input.goal.trim() };
}
export interface Slot { date: string; startTime: string; endTime: string; key?: string; }
export interface Availability {
  slots: Slot[]; durationMinutes: number;
  window: { dateFrom: string; dateTo: string; startTime: string; endTime: string };
  coverage: { shared: number; total: number };
  /** 无解时的原因；有解则为 null */
  reason: string | null;
  /** 有解但覆盖不全等附加说明；无则为 null */
  note: string | null;
}
export type Decision = 'PENDING' | 'ACCEPT' | 'REJECT';
export interface ProposalVote { name: string; decision: Decision; decidedAt: string | null; isMe: boolean; }
export interface Proposal {
  id: string; roomId: string; date: string; startTime: string; endTime: string;
  status: 'OPEN' | 'CONFIRMED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED'; stale: boolean;
  expiresAt: string; createdAt: string; createdByMe: boolean; votes: ProposalVote[];
}
const needsServer = '协商需要后台模式：本机演示只有你一个人，无法计算共同时间';

export async function listRooms(): Promise<Room[]> { return isLocalRoomMode() ? records().reverse() : request('/roundtables', 'GET'); }
export async function getRoom(id: string): Promise<Room> {
  if (!isLocalRoomMode()) return request(`/roundtables/${encodeURIComponent(id)}`, 'GET');
  const room = records().find(room => room.id === id);
  if (!room) throw new Error('圆桌不存在');
  return room;
}
export async function createRoom(input: RoomInput): Promise<Room> {
  const value = validate(input);
  if (!isLocalRoomMode()) return request('/roundtables', 'POST', value);
  const all = records();
  if (all.filter(room => room.status === 'OPEN').length >= 20) throw new Error('最多同时参与 20 个进行中的圆桌');
  const room: Room = { ...value, id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`, status: 'OPEN', version: 1, createdAt: new Date().toISOString(), isOwner: true,
    members: [{ id: 'local-self', name: '本机演示用户', role: 'OWNER', isMe: true, shareBusy: false, consentUpdatedAt: null }] };
  all.push(room); wx.setStorageSync(dataKey, all); return room;
}
/** 共同可用时间。只返回时段，不含任何成员的日程标题。 */
export async function loadAvailability(id: string): Promise<Availability> {
  if (isLocalRoomMode()) throw new Error(needsServer);
  return request<Availability>(`/roundtables/${encodeURIComponent(id)}/availability`, 'GET');
}
/** 当前方案；没有方案时后台返回 204，这里统一收敛为 null */
export async function loadProposal(id: string): Promise<Proposal | null> {
  if (isLocalRoomMode()) throw new Error(needsServer);
  const data = await request<Proposal | ''>(`/roundtables/${encodeURIComponent(id)}/proposal`, 'GET');
  return data && typeof data === 'object' ? data : null;
}
export async function proposeSlot(id: string, slot: Slot): Promise<Proposal> {
  if (isLocalRoomMode()) throw new Error(needsServer);
  const { date, startTime, endTime } = slot;
  return request<Proposal>(`/roundtables/${encodeURIComponent(id)}/proposals`, 'POST', { date, startTime, endTime });
}
export async function decideProposal(id: string, proposalId: string, decision: 'ACCEPT' | 'REJECT'): Promise<Proposal> {
  if (isLocalRoomMode()) throw new Error(needsServer);
  return request<Proposal>(`/roundtables/${encodeURIComponent(id)}/proposals/${encodeURIComponent(proposalId)}`, 'PUT', { decision });
}
export async function joinRoom(code: string): Promise<Room> {
  if (isLocalRoomMode()) throw new Error('多人加入需要后台模式，本机演示只支持创建与查看');
  return request('/roundtables/join', 'POST', { code: code.trim() });
}
export async function roomAction(id: string, action: 'consent' | 'rotate' | 'close' | 'leave' | 'remove', value?: boolean | string): Promise<void> {
  if (!isLocalRoomMode()) {
    const base = `/roundtables/${encodeURIComponent(id)}`;
    if (action === 'consent') await request(base + '/membership', 'PUT', { shareBusy: value });
    else if (action === 'rotate') await request(base + '/invitation', 'POST');
    else if (action === 'close') await request(base + '/close', 'POST');
    else if (action === 'leave') await request(base + '/membership', 'DELETE');
    else await request(base + '/members/' + encodeURIComponent(String(value)), 'DELETE');
    return;
  }
  const all = records(), room = all.find(room => room.id === id);
  if (!room) throw new Error('圆桌不存在');
  if (room.status === 'CLOSED') throw new Error('圆桌已关闭');
  if (action === 'consent') { room.members[0].shareBusy = value === true; room.members[0].consentUpdatedAt = new Date().toISOString(); }
  else if (action === 'close') { room.status = 'CLOSED'; room.members[0].shareBusy = false; room.members[0].consentUpdatedAt = new Date().toISOString(); }
  else throw new Error('此操作需要后台模式');
  room.version++; wx.setStorageSync(dataKey, all);
}
