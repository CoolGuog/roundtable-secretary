import { config } from './config';

export interface ArrangementInput { title: string; date: string; startTime: string; endTime: string; }
export interface Arrangement extends ArrangementInput { id: string; createdAt: string; }
const dataKey = 'roundtable.demo.arrangements.v1';
const sessionKey = 'roundtable.demo.session.v1';

export function modeLabel() { return config.mode === 'local' ? '本机演示 · 未联网' : '本地后台 · 内存演示'; }
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function errorMessage(error: unknown) { return error instanceof Error ? error.message : '操作失败，请稍后重试'; }

async function request<T>(path: string, method: 'GET' | 'POST' | 'DELETE', data?: object): Promise<T> {
  let token = wx.getStorageSync(sessionKey) as string;
  if (!token) {
    const session = await raw<{ token: string }>('/dev/sessions', 'POST', { name: '演示用户' });
    token = session.token;
    wx.setStorageSync(sessionKey, token);
  }
  return raw<T>(path, method, data, token);
}
function raw<T>(path: string, method: 'GET' | 'POST' | 'DELETE', data?: object, token?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    wx.request({
      url: config.apiBase + path, method, data, timeout: 10000,
      header: token ? { Authorization: `Bearer ${token}` } : {},
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(response.data as T);
        else if (response.statusCode === 401) {
          wx.removeStorageSync(sessionKey);
          reject(new Error('演示会话已失效，请重试。后台重启后旧数据会清空。'));
        } else reject(new Error((response.data as { message?: string })?.message || '服务暂时不可用'));
      },
      fail() { reject(new Error('无法连接本地后台，请确认服务已启动，或切回本机演示模式。')); },
    });
  });
}

export async function listArrangements(): Promise<Arrangement[]> {
  if (config.mode === 'api') return request<Arrangement[]>('/me/arrangements', 'GET');
  const records = wx.getStorageSync(dataKey);
  return (Array.isArray(records) ? records : [])
    .sort((a: Arrangement, b: Arrangement) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`));
}
export async function saveArrangement(input: ArrangementInput): Promise<void> {
  if (!input.title.trim() || input.title.trim().length > 60) throw new Error('请填写 1 至 60 字的安排名称');
  if (!input.date || !input.startTime || !input.endTime || input.startTime >= input.endTime) {
    throw new Error('结束时间须晚于开始时间，首版仅支持同日安排');
  }
  const value = { ...input, title: input.title.trim() };
  if (config.mode === 'api') { await request('/me/arrangements', 'POST', value); return; }
  const records = await listArrangements();
  if (records.length >= 100) throw new Error('演示最多保存 100 条安排');
  records.push({ ...value, id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`, createdAt: new Date().toISOString() });
  wx.setStorageSync(dataKey, records);
}
export async function deleteArrangement(id: string) {
  if (config.mode === 'api') { await request(`/me/arrangements/${encodeURIComponent(id)}`, 'DELETE'); return; }
  wx.setStorageSync(dataKey, (await listArrangements()).filter(item => item.id !== id));
}
export function clearLocalDemo() { wx.removeStorageSync(dataKey); wx.removeStorageSync(sessionKey); }
