import { config } from './config';
import { request } from './secretary';
export type SharedPerson = { memberId: string; name: string; isMe: boolean };
export type SharedTask = { id: string; title: string; details: string; dueDate: string; state: string; round: number;
  assignee: SharedPerson & { active: boolean }; votes: Array<SharedPerson & { active: boolean; decision: string; note: string; at: string | null }>;
  history: Array<{ at: string; actor: string; label: string; note: string }>;
  canEdit: boolean; canStart: boolean; canSubmit: boolean; canVote: boolean; canReopen: boolean };
export type SharedPreparation = { id: string; title: string; details: string; dueDate: string; done: boolean; doneAt: string | null; assignee: SharedPerson & { active: boolean }; history: SharedTask['history']; canEdit: boolean; canToggle: boolean };
export type SharedMinutes = { revision: number; date: string; summary: string; decisions: string; actor: string; at: string; nextSteps: Array<{ index: number; text: string; taskId: string; canImport: boolean }> };
export type SharedWork = { version: number; canManage: boolean; participants: SharedPerson[]; tasks: SharedTask[]; dateFrom: string; dateTo: string; preparation: SharedPreparation[]; minutes: SharedMinutes[] };
export type Notice = { id: string; roomId: string; roomTitle: string; taskId: string; section: string; title: string; text: string; at: string; readAt: string | null };
export const sharedEnabled = () => config.mode === 'api';
function path(id: string) { if (!sharedEnabled()) throw new Error('共同任务需要后台模式；本机记录不会发送给伙伴'); return `/roundtables/${encodeURIComponent(id)}/work`; }
export function getSharedWork(id: string) { return request<SharedWork>(path(id), 'GET'); }
export function saveSharedTask(id: string, taskId: string, value: object) { return request<SharedWork>(path(id) + '/tasks' + (taskId ? '/' + encodeURIComponent(taskId) : ''), taskId ? 'PUT' : 'POST', value); }
export function actSharedTask(id: string, taskId: string, value: object) { return request<SharedWork>(path(id) + '/tasks/' + encodeURIComponent(taskId) + '/action', 'PUT', value); }
export function saveSharedPreparation(id: string, itemId: string, value: object) { return request<SharedWork>(path(id) + '/preparation' + (itemId ? '/' + encodeURIComponent(itemId) : ''), itemId ? 'PUT' : 'POST', value); }
export function actSharedPreparation(id: string, itemId: string, value: object) { return request<SharedWork>(path(id) + '/preparation/' + encodeURIComponent(itemId) + '/action', 'PUT', value); }
export function saveSharedMinutes(id: string, value: object) { return request<SharedWork>(path(id) + '/minutes', 'POST', value); }
export function importSharedAction(id: string, revision: number, index: number, value: object) { return request<SharedWork>(path(id) + `/minutes/${revision}/actions/${index}`, 'POST', value); }
export function listNotices() { if (!sharedEnabled()) throw new Error('站内消息需要后台模式'); return request<Notice[]>('/me/notifications', 'GET'); }
export function readNotice(roomId: string, id: string) { return request(path(roomId) + '/notifications/' + encodeURIComponent(id), 'PUT', {}); }
export const taskStateNames: Record<string, string> = { TODO: '待开始', DOING: '进行中', REVIEW: '待全员验收', DISPUTED: '验收有异议', DONE: '全员验收通过' };
