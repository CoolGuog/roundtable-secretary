import test from 'node:test';
import assert from 'node:assert/strict';
import { createWechatExchange, validateLoginCode } from '../apps/api/dist/wechat-login.js';
import { createApp } from '../apps/api/dist/app.js';

test('微信换码仅访问官方地址，返回自建身份所需的 OpenID', async () => {
  const exchange = createWechatExchange('wx0123456789abcdef', 'test-secret', async (url, options) => {
    assert.equal(url.origin + url.pathname, 'https://api.weixin.qq.com/sns/jscode2session');
    assert.equal(url.searchParams.get('js_code'), 'one-time-code');
    assert.equal(url.searchParams.get('grant_type'), 'authorization_code');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    return Response.json({ openid: 'test-openid', session_key: 'never-return-this', unionid: 'not-needed' });
  });
  assert.deepEqual(await exchange('one-time-code'), { openId: 'test-openid' });
});
test('无效换码返回明确错误，上游异常不会泄露凭证', async () => {
  for (const errcode of [40029, 40163]) {
    const exchange = createWechatExchange('app', 'secret', async () => Response.json({ errcode, errmsg: 'sensitive-upstream' }));
    await assert.rejects(exchange('code'), error => error.getStatus() === 400 && !error.message.includes('sensitive'));
  }
  for (const fetcher of [
    async () => { throw new Error('request contains secret=top-secret'); },
    async () => new Response('down', { status: 502 }),
    async () => Response.json({ errcode: 40013, errmsg: 'private-config' }),
    async () => Response.json({ openid: 'test', session_key: '' }),
    async () => Response.json(null),
  ]) {
    const exchange = createWechatExchange('app', 'top-secret', fetcher);
    await assert.rejects(exchange('code'), error => error.getStatus() === 503 && !/secret|private/.test(error.message));
  }
});
test('登录只接受 code，拒绝前端指定用户与身份', () => {
  assert.equal(validateLoginCode({ code: 'valid-code' }), 'valid-code');
  for (const body of [null, {}, { code: '' }, { code: 'a b' }, { code: 'x'.repeat(257) }, { code: 'x', openid: 'victim' }, { code: 'x', userId: 'victim' }]) {
    assert.throws(() => validateLoginCode(body), error => error.getStatus() === 400);
  }
});
test('微信模式配置缺失时拒绝启动，演示模式不开放微信登录', async () => {
  await assert.rejects(createApp({ storage: 'memory', authMode: 'wechat' }), /微信登录需要/);
  await assert.rejects(createApp({ storage: 'postgres', authMode: 'wechat', wechatAppId: 'bad', wechatSecret: 'test' }), /微信登录需要/);
  const app = await createApp({ storage: 'memory', authMode: 'demo' });
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    assert.equal((await fetch(`${base}/auth/wechat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'x' }) })).status, 404);
    const session = await (await fetch(`${base}/dev/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '测试' }) })).json();
    const headers = { Authorization: `Bearer ${session.token}` };
    assert.equal((await fetch(`${base}/me/session`, { method: 'DELETE', headers })).status, 204);
    assert.equal((await fetch(`${base}/me`, { headers })).status, 401);
  } finally { await app.close(); }
});
