import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpModel, SecretaryService } from '../apps/api/dist/secretary.js';
import { SecretaryAccess, configuredHttpModel } from '../apps/api/dist/secretary-access.js';
import { createApp } from '../apps/api/dist/app.js';
import { prepareDeepseekEnv } from '../scripts/configure-deepseek.mjs';
import { parseEnv } from 'node:util';

const secret = 'sk-only-fake-testing-key';
const tomorrow = new Date(Date.now() + 32 * 3600000).toISOString().slice(0, 10);
const fields = { title: '课程讨论', date: tomorrow, startTime: '15:00', endTime: '16:00' };
const response = (content = JSON.stringify(fields), finish_reason = 'stop') => new Response(JSON.stringify({ choices: [{ finish_reason, message: { content } }] }));
const model = fetcher => new HttpModel({ baseUrl: 'https://api.deepseek.com', apiKey: secret, model: 'deepseek-flash', fetcher });

test('Agent模型接收工具结果与公开反馈，返回动作且拒绝未知工具',async()=>{
  let sent;
  const agent={candidates:[{date:tomorrow,startTime:'15:00',endTime:'16:00'}],offer:0,tools:{read_busy:[true],read_preferences:[]}};
  const result=await model(async(_url,options)=>{sent=JSON.parse(options.body);return response(JSON.stringify({action:'answer',choice:0,decision:'accept'}));}).complete({text:'',today:tomorrow,memories:[],agent});
  assert.equal(result.choice,0);assert.deepEqual(JSON.parse(sent.messages[1].content),agent);
  assert.match(sent.messages[0].content,/true表示可用/);assert.match(sent.messages[0].content,/不得重复调用/);
  await assert.rejects(()=>model(async()=>response('{"action":"delete_schedule"}')).complete({text:'',today:tomorrow,memories:[],agent}),/有效工具动作/);
});

test('DeepSeek 请求使用官方地址、JSON 与非思考模式；限制偏好数量且不传内部标识', async () => {
  let body;
  const m = model(async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options.headers.Authorization, `Bearer ${secret}`); assert.equal(options.redirect, 'error');
    body = JSON.parse(options.body); assert.equal(body.thinking.type, 'disabled'); assert.equal(body.response_format.type, 'json_object');
    assert.equal(body.max_tokens, 800); assert.equal(body.stream, false); assert.ok(options.signal instanceof AbortSignal);
    return response();
  });
  const service = new SecretaryService('http', m), status = new SecretaryAccess(service);
  assert.equal(status.status().connectionVerified, false);
  const memories = Array.from({ length: 25 }, (_, i) => ({ id: `secret-id-${i}`, ownerId: 'hidden-owner', category: 'PREFERENCE', label: `偏好${i}`, content: '喜欢下午' }));
  const draft = await service.draft('明天下午三点到四点讨论课程', memories);
  assert.equal(draft.status, 'READY'); assert.equal(draft.model, 'deepseek-flash'); assert.equal(status.status().connectionVerified, true);
  const serialized = JSON.stringify(body); assert.ok(!serialized.includes(secret)); assert.ok(!serialized.includes('hidden-owner'));
  assert.ok(!serialized.includes('secret-id')); assert.ok(serialized.includes('偏好19')); assert.ok(!serialized.includes('偏好20'));
});

test('上游错误、空输出、截断、超大正文、坏 JSON 与超时均脱敏且不冒充成功', async () => {
  for (const [status, hint] of [[401, /密钥/], [402, /余额/], [429, /繁忙/], [404, /配置/], [500, /暂时/]]) {
    const draft = await new SecretaryService('http', model(async () => new Response(secret, { status }))).draft('测试', []);
    assert.equal(draft.status, 'UNAVAILABLE'); assert.match(draft.message, hint); assert.ok(!JSON.stringify(draft).includes(secret));
  }
  const bad = [() => response(''), () => response('{}'), () => response(JSON.stringify(fields), 'length'),
    () => new Response(secret), () => new Response('a'.repeat(262145)), () => { throw new DOMException(secret, 'TimeoutError'); },
    () => { throw new Error(secret); }];
  for (const fake of bad) {
    const service = new SecretaryService('http', model(async () => fake()));
    const draft = await service.draft('测试', []); assert.equal(draft.status, 'UNAVAILABLE');
    assert.ok(!JSON.stringify(draft).includes(secret)); assert.equal(service.lastSuccessfulAt, null);
  }
});

test('配置只替换模型字段，保留数据库配置，拒绝密钥和模型中的换行注入', () => {
  const source = '# preserved\nDATABASE_URL=postgresql://fake-user:fake-password@localhost/db\nSECRETARY_MODE=off\nSECRETARY_MODEL=old\nSECRETARY_MODEL=duplicate\n';
  const changed = prepareDeepseekEnv(source, secret), parsed = parseEnv(changed);
  assert.equal(parsed.DATABASE_URL, parseEnv(source).DATABASE_URL); assert.equal(parsed.SECRETARY_MODE, 'http');
  assert.equal(parsed.SECRETARY_ALLOWED_HOSTS, 'api.deepseek.com'); assert.equal(parsed.SECRETARY_MODEL, 'deepseek-flash');
  assert.equal(changed.match(/^SECRETARY_MODEL=/gm).length, 1); assert.ok(changed.startsWith('# preserved'));
  assert.ok(configuredHttpModel(parsed) instanceof HttpModel);
  assert.throws(() => prepareDeepseekEnv(source, secret + '\nHOST=0.0.0.0'));
  assert.throws(() => prepareDeepseekEnv(source, secret, 'model\nSECRETARY_MODE=stub'));
  assert.throws(() => prepareDeepseekEnv('NODE_ENV=production', secret));
});

test('HTTP 草稿接入只读取本人的偏好，返回真实模型标识，确认前不保存日程', async () => {
  const prompts = [];
  const app = await createApp({ storage: 'memory', authMode: 'demo', secretary: { mode: 'http', model: model(async (_url, options) => { prompts.push(options.body); return response(); }) } });
  try {
    await app.listen(0, '127.0.0.1'); const base = await app.getUrl();
    const call = (route, token, data) => fetch(base + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
    const a = await (await call('/dev/sessions', null, { name: '甲' })).json(), b = await (await call('/dev/sessions', null, { name: '乙' })).json();
    await call('/me/memories', a.token, { category: 'PREFERENCE', label: '甲的偏好', content: '喜欢下午讨论' });
    await call('/me/memories', b.token, { category: 'PREFERENCE', label: '乙的私密偏好', content: '不应出现在甲的请求里' });
    const draft = await (await call('/me/secretary/draft', a.token, { text: '明天下午三点到四点讨论课程项目' })).json();
    assert.equal(draft.status, 'READY'); assert.equal(draft.model, 'deepseek-flash');
    assert.ok(prompts[0].includes('甲的偏好')); assert.ok(!prompts[0].includes('乙的私密偏好'));
    assert.deepEqual(await (await call('/me/arrangements', a.token)).json(), []);
    assert.equal((await (await call('/me/secretary/status', a.token)).json()).connectionVerified, true);
  } finally { await app.close(); }
});
