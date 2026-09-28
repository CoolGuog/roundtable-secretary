import { config } from './config';

export interface ArrangementInput { title: string; date: string; startTime: string; endTime: string; }
export interface Arrangement extends ArrangementInput { id: string; createdAt: string; }
const dataKey = 'roundtable.demo.arrangements.v1';
const sessionKey = 'roundtable.demo.session.v1';

export function modeLabel() { return config.mode === 'local' ? '本机演示 · 未联网' : '本地后台 · 演示会话'; }
// 与 apps/api/src/time.ts 对齐：中国无夏令时，北京时间恒为 UTC+8。
// 不读取设备本地时区，避免换时区后"今天"和已存安排对不上。
export function today() { return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10); }
export function errorMessage(error: unknown) { return error instanceof Error ? error.message : '操作失败，请稍后重试'; }

function validate(input: ArrangementInput): ArrangementInput {
  const title = input.title.trim();
  if (!title || title.length > 60) throw new Error('请填写 1 至 60 字的安排名称');
  if (!input.date || !input.startTime || !input.endTime || input.startTime >= input.endTime) {
    throw new Error('结束时间须晚于开始时间，首版仅支持同日安排');
  }
  return { ...input, title };
}

// 注意：wx.request 不支持 PATCH，编辑统一走 PUT。
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
async function request<T>(path: string, method: Method, data?: object): Promise<T> {
  let token = wx.getStorageSync(sessionKey) as string;
  if (!token) {
    const session = await raw<{ token: string }>('/dev/sessions', 'POST', { name: '演示用户' });
    token = session.token;
    wx.setStorageSync(sessionKey, token);
  }
  return raw<T>(path, method, data, token);
}
function raw<T>(path: string, method: Method, data?: object, token?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    wx.request({
      url: config.apiBase + path, method, data, timeout: 10000,
      header: token ? { Authorization: `Bearer ${token}` } : {},
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(response.data as T);
        else if (response.statusCode === 401) {
          wx.removeStorageSync(sessionKey);
          reject(new Error('演示会话已失效，重试将创建新演示身份，无法自动找回旧身份的安排。'));
        } else if (response.statusCode === 404) reject(new Error('这条安排已不存在，请刷新后重试'));
        else reject(new Error((response.data as { message?: string })?.message || '服务暂时不可用'));
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
  const value = validate(input);
  if (config.mode === 'api') { await request('/me/arrangements', 'POST', value); return; }
  const records = await listArrangements();
  if (records.length >= 100) throw new Error('演示最多保存 100 条安排');
  records.push({ ...value, id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`, createdAt: new Date().toISOString() });
  wx.setStorageSync(dataKey, records);
}
export async function updateArrangement(id: string, input: ArrangementInput): Promise<void> {
  const value = validate(input);
  if (config.mode === 'api') { await request(`/me/arrangements/${encodeURIComponent(id)}`, 'PUT', value); return; }
  const records = await listArrangements();
  const index = records.findIndex(item => item.id === id);
  if (index < 0) throw new Error('这条安排已不存在，请刷新后重试');
  records[index] = { ...records[index], ...value };
  wx.setStorageSync(dataKey, records);
}
export async function deleteArrangement(id: string) {
  if (config.mode === 'api') { await request(`/me/arrangements/${encodeURIComponent(id)}`, 'DELETE'); return; }
  wx.setStorageSync(dataKey, (await listArrangements()).filter(item => item.id !== id));
}
export function clearLocalDemo() { wx.removeStorageSync(dataKey); wx.removeStorageSync(sessionKey); }
