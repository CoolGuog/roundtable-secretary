import { config } from './config';
import { request } from './secretary';

export type MemoryCategory = 'PREFERENCE' | 'CONSTRAINT' | 'NOTE';
export interface MemoryInput { category: MemoryCategory; label: string; content: string; }
export interface PersonalMemory extends MemoryInput { id: string; source: 'USER_INPUT' | 'SECRETARY'; createdAt: string; updatedAt: string; }
const dataKey = 'roundtable.demo.memories.v1';
export const categories: MemoryCategory[] = ['PREFERENCE', 'CONSTRAINT', 'NOTE'];
export const categoryNames = ['偏好', '限制', '备忘'];

function validate(input: MemoryInput): MemoryInput {
  if (!categories.includes(input.category)) throw new Error('请选择偏好、限制或备忘');
  const label = input.label.trim(), content = input.content.trim();
  if (!label || label.length > 40) throw new Error('标题须为 1 至 40 字');
  if (!content || content.length > 500) throw new Error('内容须为 1 至 500 字');
  return { category: input.category, label, content };
}
function localRecords(): PersonalMemory[] {
  const records = wx.getStorageSync(dataKey);
  return Array.isArray(records) ? records : [];
}
export async function listMemories(): Promise<PersonalMemory[]> {
  if (config.mode === 'api') return request<PersonalMemory[]>('/me/memories', 'GET');
  return localRecords().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}
export async function saveMemory(input: MemoryInput, id?: string): Promise<void> {
  const value = validate(input);
  if (config.mode === 'api') {
    await request(id ? `/me/memories/${encodeURIComponent(id)}` : '/me/memories', id ? 'PUT' : 'POST', value);
    return;
  }
  // 本机读改写保持同步，避免两次保存之间互相覆盖。
  const records = localRecords();
  const now = new Date().toISOString();
  if (id) {
    const index = records.findIndex(item => item.id === id);
    if (index < 0) throw new Error('这条记忆已不存在，请刷新后重试');
    records[index] = { ...records[index], ...value, source: 'USER_INPUT', updatedAt: now };
  } else {
    if (records.length >= 100) throw new Error('最多保存 100 条个人记忆');
    records.push({ ...value, id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`, source: 'USER_INPUT', createdAt: now, updatedAt: now });
  }
  wx.setStorageSync(dataKey, records);
}
export async function deleteMemory(id: string): Promise<void> {
  if (config.mode === 'api') { await request(`/me/memories/${encodeURIComponent(id)}`, 'DELETE'); return; }
  const records = localRecords();
  if (!records.some(item => item.id === id)) throw new Error('这条记忆已不存在，请刷新后重试');
  wx.setStorageSync(dataKey, records.filter(item => item.id !== id));
}
