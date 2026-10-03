import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { inputObject, validateArrangement } from './store';
import type { NegotiationRoom } from './negotiation';

export type RoomInput = { title: string; goal: string; dateFrom: string; dateTo: string; startTime: string; endTime: string; durationMinutes: number };
export type RoomMember = { id: string; name: string; role: 'OWNER' | 'MEMBER'; isMe: boolean; shareBusy: boolean; consentUpdatedAt: string | null };
export type Room = RoomInput & { id: string; status: 'OPEN' | 'CLOSED'; version: number; createdAt: string; isOwner: boolean; members: RoomMember[]; inviteCode?: string; inviteExpiresAt?: string };
export interface RoomStore {
  list(userId: string): Room[] | Promise<Room[]>;
  get(userId: string, id: string): Room | Promise<Room>;
  create(userId: string, value: unknown): Room | Promise<Room>;
  join(userId: string, value: unknown): Room | Promise<Room>;
  consent(userId: string, id: string, value: unknown): Room | Promise<Room>;
  rotate(userId: string, id: string): Room | Promise<Room>;
  remove(userId: string, id: string, memberId: string): Room | Promise<Room>;
  leave(userId: string, id: string): void | Promise<void>;
  close(userId: string, id: string): Room | Promise<Room>;
}
export function validateRoom(value: unknown): RoomInput {
  const input = inputObject(value);
  if (Object.keys(input).some(key => !['title', 'goal', 'dateFrom', 'dateTo', 'startTime', 'endTime', 'durationMinutes'].includes(key))) throw new BadRequestException('不支持额外字段');
  const first = validateArrangement({ title: input.title, date: input.dateFrom, startTime: input.startTime, endTime: input.endTime });
  const last = validateArrangement({ title: input.title, date: input.dateTo, startTime: input.startTime, endTime: input.endTime });
  const days = (Date.parse(last.date) - Date.parse(first.date)) / 86400_000;
  if (days < 0 || days > 30) throw new BadRequestException('日期范围须为顺序排列的 1 至 31 天');
  if (typeof input.goal !== 'string' || !input.goal.trim() || input.goal.trim().length > 500) throw new BadRequestException('活动目标须为 1 至 500 字');
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const duration = input.durationMinutes;
  if (typeof duration !== 'number' || !Number.isInteger(duration) || duration < 15 || duration > 240 || duration % 15 || duration > minutes(first.endTime) - minutes(first.startTime)) throw new BadRequestException('活动时长须为 15 至 240 分钟、15 的倍数，且不超过每日时间窗口');
  return { title: first.title, goal: input.goal.trim(), dateFrom: first.date, dateTo: last.date, startTime: first.startTime, endTime: first.endTime, durationMinutes: duration };
}
export function validateInvite(value: unknown) {
  const input = inputObject(value);
  if (Object.keys(input).length !== 1 || typeof input.code !== 'string' || !/^[a-f0-9]{20}$/i.test(input.code.trim())) throw new BadRequestException('请填写完整的 20 位邀请码');
  return input.code.trim().toUpperCase();
}
export function validateConsent(value: unknown) {
  const input = inputObject(value);
  if (Object.keys(input).length !== 1 || typeof input.shareBusy !== 'boolean') throw new BadRequestException('请明确选择是否授权本次忙闲信息');
  return input.shareBusy;
}
export const newInvitation = () => ({ inviteCode: randomBytes(10).toString('hex').toUpperCase(), inviteExpiresAt: new Date(Date.now() + 7 * 86400_000) });
export function requireOpen(status: string) { if (status !== 'OPEN') throw new BadRequestException('圆桌已关闭'); }
export function requireOwner(ownerId: string, userId: string) { if (ownerId !== userId) throw new ForbiddenException('只有发起人可以执行此操作'); }
type StoredRoom = RoomInput & { id: string; ownerId: string; status: 'OPEN' | 'CLOSED'; version: number; createdAt: string; inviteCode: string; inviteExpiresAt: Date;
  members: { id: string; userId: string; shareBusy: boolean; consentUpdatedAt: string | null }[] };

export class MemoryRooms implements RoomStore {
  private readonly rooms = new Map<string, StoredRoom>();
  constructor(private readonly name: (id: string) => string) {}
  private accessible(userId: string, id: string) {
    const room = this.rooms.get(id);
    if (!room || !room.members.some(member => member.userId === userId)) throw new NotFoundException('圆桌不存在或你已不是成员');
    return room;
  }
  private dto(room: StoredRoom, userId: string): Room {
    return { id: room.id, title: room.title, goal: room.goal, dateFrom: room.dateFrom, dateTo: room.dateTo, startTime: room.startTime, endTime: room.endTime,
      durationMinutes: room.durationMinutes, status: room.status, version: room.version, createdAt: room.createdAt, isOwner: room.ownerId === userId,
      ...(room.ownerId === userId && room.status === 'OPEN' ? { inviteCode: room.inviteCode, inviteExpiresAt: room.inviteExpiresAt.toISOString() } : {}),
      members: room.members.map(member => ({ id: member.id, name: this.name(member.userId), role: member.userId === room.ownerId ? 'OWNER' : 'MEMBER', isMe: member.userId === userId, shareBusy: member.shareBusy, consentUpdatedAt: member.consentUpdatedAt })) };
  }
  private quota(userId: string) {
    if ([...this.rooms.values()].filter(room => room.status === 'OPEN' && room.members.some(member => member.userId === userId)).length >= 20) throw new BadRequestException('最多同时参与 20 个进行中的圆桌');
  }
  list(userId: string) { return [...this.rooms.values()].filter(room => room.members.some(member => member.userId === userId)).reverse().map(room => this.dto(room, userId)); }
  get(userId: string, id: string) { return this.dto(this.accessible(userId, id), userId); }
  /** 协商模块内部使用：带成员 userId 的房间视图，不经过 HTTP 输出 */
  core(userId: string, id: string): NegotiationRoom {
    const room = this.accessible(userId, id);
    return { id: room.id, status: room.status, version: room.version, title: room.title,
      dateFrom: room.dateFrom, dateTo: room.dateTo, startTime: room.startTime, endTime: room.endTime,
      durationMinutes: room.durationMinutes, members: room.members.map(member => ({ userId: member.userId, shareBusy: member.shareBusy })) };
  }
  create(userId: string, value: unknown) {
    const input = validateRoom(value); this.quota(userId);
    const room: StoredRoom = { ...input, id: randomUUID(), ownerId: userId, status: 'OPEN', version: 1, createdAt: new Date().toISOString(), ...newInvitation(),
      members: [{ id: randomUUID(), userId, shareBusy: false, consentUpdatedAt: null }] };
    this.rooms.set(room.id, room); return this.dto(room, userId);
  }
  join(userId: string, value: unknown) {
    const code = validateInvite(value);
    const room = [...this.rooms.values()].find(room => room.inviteCode === code && room.status === 'OPEN' && room.inviteExpiresAt.getTime() > Date.now());
    if (!room) throw new NotFoundException('邀请码无效、已过期或圆桌已关闭');
    if (room.members.some(member => member.userId === userId)) return this.dto(room, userId);
    this.quota(userId);
    if (room.members.length >= 3) throw new BadRequestException('圆桌已满，首版最多 3 人');
    room.members.push({ id: randomUUID(), userId, shareBusy: false, consentUpdatedAt: null }); room.version++;
    return this.dto(room, userId);
  }
  consent(userId: string, id: string, value: unknown) {
    const shareBusy = validateConsent(value), room = this.accessible(userId, id); requireOpen(room.status);
    const member = room.members.find(member => member.userId === userId)!;
    if (member.shareBusy !== shareBusy) { member.shareBusy = shareBusy; member.consentUpdatedAt = new Date().toISOString(); room.version++; }
    return this.dto(room, userId);
  }
  rotate(userId: string, id: string) {
    const room = this.accessible(userId, id); requireOwner(room.ownerId, userId); requireOpen(room.status);
    Object.assign(room, newInvitation()); room.version++; return this.dto(room, userId);
  }
  remove(userId: string, id: string, memberId: string) {
    const room = this.accessible(userId, id); requireOwner(room.ownerId, userId); requireOpen(room.status);
    const member = room.members.find(member => member.id === memberId);
    if (!member) throw new NotFoundException('成员不存在');
    if (member.userId === userId) throw new BadRequestException('发起人不能移除自己，请关闭圆桌');
    room.members = room.members.filter(member => member.id !== memberId); Object.assign(room, newInvitation()); room.version++;
    return this.dto(room, userId);
  }
  leave(userId: string, id: string) {
    const room = this.accessible(userId, id);
    if (room.ownerId === userId) throw new BadRequestException('发起人不能退出，请关闭圆桌');
    room.members = room.members.filter(member => member.userId !== userId); room.version++;
  }
  close(userId: string, id: string) {
    const room = this.accessible(userId, id); requireOwner(room.ownerId, userId);
    if (room.status === 'OPEN') { room.status = 'CLOSED'; room.members.forEach(member => { member.shareBusy = false; member.consentUpdatedAt = new Date().toISOString(); }); room.version++; }
    return this.dto(room, userId);
  }
}
