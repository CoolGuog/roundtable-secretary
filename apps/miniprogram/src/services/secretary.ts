import { config } from './config';
import { localDraft, DraftFields } from './local-draft';

export interface ArrangementInput { title: string; date: string; startTime: string; endTime: string; }
export interface Arrangement extends ArrangementInput { id: string; createdAt: string; }
const dataKey = 'roundtable.demo.arrangements.v1';
const legacySessionKey = 'roundtable.demo.session.v1';
const sessionKey = () => `roundtable.session.v2.${config.authMode}.${config.apiBase}`;
let sessionPromise: Promise<string> | undefined;
let sessionEpoch = 0;
// 仅在本次小程序运行期间保留待确认请求，不把安排内容落入 API 模式的本机存储。
const pendingSaves = new Map<string, string>();
const createRequestId = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
  const value = Math.floor(Math.random() * 16); return (char === 'x' ? value : (value & 3) | 8).toString(16);
});
export class RequestError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}
class LoginExpired extends RequestError {
  constructor(message: string) { super(message, 401); }
}

export type DraftStatus = 'READY' | 'NEEDS_INPUT' | 'UNAVAILABLE';
export interface SecretaryStatus {
  mode: 'local' | 'off' | 'stub' | 'http'; canGenerate: boolean; connectionVerified: boolean; message: string;
}
export async function loadSecretaryStatus(): Promise<SecretaryStatus> {
  if (config.mode === 'local') return { mode: 'local', canGenerate: true, connectionVerified: false, message: '本机规则秘书：支持补充日期和时间，不联网、不调用 AI；确认后才保存' };
  return request('/me/secretary/status', 'GET');
}
export interface ScheduleDraft {
  status: DraftStatus; title: string | null; date: string | null; startTime: string | null; endTime: string | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'; missing: string[]; reasons: string[]; usedMemories: string[];
  model: string; message: string;
}

export function modeLabel() { return config.mode === 'local' ? '本机演示 · 未联网' : config.authMode === 'wechat' ? '本地后台 · 微信登录' : '本地后台 · 演示会话'; }
export function loginEnabled() { return config.mode === 'api' && config.authMode === 'wechat'; }
export function hasLogin() { return Boolean(wx.getStorageSync(sessionKey())); }
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
export async function request<T>(path: string, method: Method, data?: object, requestId?: string): Promise<T> {
  const token = await ensureSession();
  try { return await raw<T>(path, method, data, token, requestId); }
  catch (error) {
    // 仅重试读取，写入失败让用户确认后重试，避免网络不确定性造成重复保存。
    if (error instanceof LoginExpired && config.authMode === 'wechat' && method === 'GET') {
      return raw<T>(path, method, data, await ensureSession());
    }
    throw error;
  }
}
function ensureSession(): Promise<string> {
  const cached = wx.getStorageSync(sessionKey());
  if (typeof cached === 'string' && /^[a-f0-9]{64}$/.test(cached)) return Promise.resolve(cached);
  if (sessionPromise) return sessionPromise;
  const epoch = sessionEpoch;
  const promise = (async () => {
    const session = config.authMode === 'wechat'
      ? await raw<{ token: string }>('/auth/wechat', 'POST', { code: await wechatCode() })
      : await raw<{ token: string }>('/dev/sessions', 'POST', { name: '演示用户' });
    if (epoch !== sessionEpoch) throw new Error('登录已取消，请重试');
    if (typeof session.token !== 'string' || !/^[a-f0-9]{64}$/.test(session.token)) throw new Error('登录响应无效，请重试');
    wx.setStorageSync(sessionKey(), session.token);
    return session.token;
  })();
  sessionPromise = promise;
  void promise.finally(() => { if (sessionPromise === promise) sessionPromise = undefined; }).catch(() => {});
  return promise;
}
function wechatCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.login({ timeout: 10000, success(result) {
      if (result.code) resolve(result.code);
      else reject(new Error('无法取得微信登录凭证，请重新登录'));
    }, fail() { reject(new Error('微信登录失败，请确认网络与小程序开发者权限')); } });
  });
}
export async function login() {
  if (!loginEnabled()) throw new Error('当前未启用微信登录');
  await request('/me', 'GET');
}
export async function logout() {
  const token = wx.getStorageSync(sessionKey()) as string;
  if (token) {
    try { await raw('/me/session', 'DELETE', undefined, token); }
    catch (error) { if (!(error instanceof LoginExpired)) throw error; }
  }
  sessionEpoch++;
  pendingSaves.clear();
  sessionPromise = undefined;
  wx.removeStorageSync(sessionKey());
}
function raw<T>(path: string, method: Method, data?: object, token?: string, requestId?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    wx.request({
      url: config.apiBase + path, method, data, timeout: 10000,
      header: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(requestId ? { 'Idempotency-Key': requestId } : {}) },
      success(response) {
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(response.data as T);
        else if (response.statusCode === 401) {
          if (token && wx.getStorageSync(sessionKey()) === token) wx.removeStorageSync(sessionKey());
          reject(new LoginExpired(config.authMode === 'wechat' ? '登录已失效，请重新登录后重试' : '演示会话已失效，重试将创建新演示身份，无法自动找回旧身份的安排。'));
        } else if (response.statusCode === 404) reject(new RequestError(path.startsWith('/roundtables') ? ((response.data as { message?: string })?.message || '圆桌不存在或你已不是成员') : path.startsWith('/me/memories/') ? '这条记忆已不存在，请刷新后重试' : path.startsWith('/me/arrangements/') ? '这条安排已不存在，请刷新后重试' : '登录方式与后台配置不一致，请检查运行配置', 404));
        else reject(new RequestError((response.data as { message?: string })?.message || '服务暂时不可用', response.statusCode));
      },
      fail() { reject(new RequestError('未收到后台响应，请检查网络和后台服务后刷新。', 0)); },
    });
  });
}

// 只生成草稿，不写入。写入必须走 saveArrangement，也就是用户点一次"确认保存"。
export async function draftFromText(text: string, previous: DraftFields | null = null): Promise<ScheduleDraft> {
  const value = text.trim();
  if (!value) throw new Error('请先说一句你想安排的事');
  if (value.length > 200) throw new Error('描述请控制在 200 字以内');
  if (config.mode === 'local') return localDraft(value, previous, today());
  return request<ScheduleDraft>('/me/secretary/draft', 'POST', { text: value });
}

export async function listArrangements(): Promise<Arrangement[]> {
  if (config.mode === 'api') return request<Arrangement[]>('/me/arrangements', 'GET');
  const records = wx.getStorageSync(dataKey);
  return (Array.isArray(records) ? records : [])
    .sort((a: Arrangement, b: Arrangement) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`));
}
export async function saveArrangement(input: ArrangementInput): Promise<void> {
  const value = validate(input);
  if (config.mode === 'api') {
    const signature = JSON.stringify([sessionKey(), value.title, value.date, value.startTime, value.endTime]);
    let id = pendingSaves.get(signature);
    if (!id) {
      if (pendingSaves.size >= 100) throw new Error('待确认的保存较多，请先查看日程，确认结果后重新打开小程序');
      id = createRequestId(); pendingSaves.set(signature, id);
    }
    await request('/me/arrangements', 'POST', value, id);
    // 成功后再提交相同内容视为用户有意创建另一条；失败则保留编号供手动重试。
    if (pendingSaves.get(signature) === id) pendingSaves.delete(signature);
    return;
  }
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
export function clearLocalDemo() {
  wx.removeStorageSync('roundtable.demo.rooms.v1');
  wx.removeStorageSync('roundtable.demo.memories.v1');
  wx.removeStorageSync(dataKey); wx.removeStorageSync(legacySessionKey);
  if (config.authMode === 'demo') { sessionEpoch++; sessionPromise = undefined; pendingSaves.clear(); wx.removeStorageSync(sessionKey()); }
}
