import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSetup, readMiniConfig } from '../scripts/check-setup.mjs';
test('配置检查读取实际配置值，不误用类型声明里的 local/demo', () => {
  const source = "export const config: { mode: 'local' | 'api'; authMode: 'demo' | 'wechat'; apiBase: string } = {mode: 'api', authMode: 'wechat', apiBase: 'https://example.test'};";
  assert.deepEqual(readMiniConfig(source), { mode: 'api', authMode: 'wechat', apiBase: 'https://example.test' });
});
test('配置报告不回显密钥、数据库凭证，也不把配置齐全当真实验收通过', () => {
  const secret = 'private-secret-marker';
  const env = { WECHAT_APP_ID: 'wx0123456789abcdef', WECHAT_APP_SECRET: secret, AUTH_MODE: 'wechat', STORAGE_MODE: 'postgres', DATABASE_URL: `postgresql://user:${secret}@127.0.0.1/db` };
  const result = inspectSetup({ appid: env.WECHAT_APP_ID }, { mode: 'api', authMode: 'wechat', apiBase: 'https://example.test' }, env);
  assert.equal(result.configurationComplete, true); assert.equal(result.liveLoginVerified, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(inspectSetup({ appid: env.WECHAT_APP_ID }, { mode: 'local', authMode: 'demo', apiBase: 'http://127.0.0.1:3000' }, {}).configurationComplete, false);
});
