import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildMiniRelease, verifyMiniRelease, releaseOrigin } from '../scripts/mini-release.mjs';

// 仅使用虚构配置编译本机夹具，绝不请求该地址。
const origin = 'https://api.release-fixture.cn';
const appId = 'wx0123456789abcdef';
const sourceConfig = "export const config = { mode: 'local', authMode: 'demo', apiBase: 'http://127.0.0.1:3000' };";

async function fixture(t) {
  const prefix = path.join(os.tmpdir(), 'roundtable-release-test-');
  const root = await fs.mkdtemp(prefix);
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(prefix)) && path.dirname(resolved) === path.resolve(os.tmpdir()));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const write = async (file, content) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  };
  await write('project.config.json', JSON.stringify({ appid: appId, setting: { urlCheck: false }, packOptions: { include: [{ value: '.env' }] } }));
  await write('project.private.config.json', '{"setting":{"urlCheck":false}}');
  await write('.env', 'WECHAT_APP_SECRET=private-marker');
  await write('apps/miniprogram/tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2018', module: 'commonjs', types: [], rootDir: 'src', strict: true }, include: ['src/**/*.ts'] }));
  await write('apps/miniprogram/src/services/config.ts', sourceConfig);
  await write('apps/miniprogram/src/app.ts', 'export const ready = true;');
  await write('apps/miniprogram/src/app.json', '{"pages":[]}');
  await write('apps/miniprogram/src/pages/index.wxml', '<view>测试</view>');
  await write('apps/miniprogram/src/.env', 'private-source-marker');
  await write('dist/miniprogram/stale.js', 'old-build-marker');
  return { root, write };
}

test('正式构建地址拒绝本机、演示域名、明文、非默认端口、凭证和路径', () => {
  assert.equal(releaseOrigin(origin + '/'), origin);
  for (const value of ['', 'http://api.release-fixture.cn', 'https://127.0.0.1', 'https://[::1]', 'https://localhost',
    'https://api.local', 'https://api.example.com', 'https://demo.test', 'https://api.invalid', 'https://api.release-fixture.cn:8443',
    origin + '/path', origin + '?secret=private', origin + '#secret', 'https://user:private@api.release-fixture.cn']) {
    assert.throws(() => releaseOrigin(value), error => !error.message.includes('private'));
  }
});

test('独立正式构建强制微信/HTTPS，隔离演示缓存和秘密，支持重复构建与变化检测', async t => {
  const { root } = await fixture(t);
  const first = await buildMiniRelease({ origin, root });
  assert.equal(first.passed, true); assert.equal(first.liveLoginVerified, false);
  assert.equal(await fs.readFile(path.join(root, 'apps/miniprogram/src/services/config.ts'), 'utf8'), sourceConfig);
  assert.equal(await fs.readFile(path.join(root, 'dist/miniprogram/stale.js'), 'utf8'), 'old-build-marker');
  const project = JSON.parse(await fs.readFile(path.join(first.directory, 'project.config.json'), 'utf8'));
  assert.equal(project.setting.urlCheck, true); assert.equal(project.packOptions, undefined);
  const manifest = JSON.parse(await fs.readFile(path.join(first.directory, 'release-manifest.json'), 'utf8'));
  assert.equal(manifest.appId, appId); assert.equal(manifest.apiOrigin, origin);
  assert.ok(Object.keys(manifest.files).includes('miniprogram/pages/index.wxml'));
  assert.equal(Object.keys(manifest.files).some(file => /private|\.env|stale/.test(file)), false);
  for (const file of Object.keys(manifest.files)) assert.doesNotMatch(await fs.readFile(path.join(first.directory, file), 'utf8'), /private-marker|private-source-marker/);
  const second = await buildMiniRelease({ origin, root });
  assert.notEqual(first.directory, second.directory);
  assert.equal((await verifyMiniRelease(first.directory)).passed, true);
  const configFile = path.join(first.directory, 'miniprogram/services/config.js');
  await fs.appendFile(configFile, '\n// changed');
  await assert.rejects(verifyMiniRelease(first.directory), /检查失败/);
  const privateFile = path.join(second.directory, 'project.private.config.json');
  await fs.writeFile(privateFile, '{"setting":{"urlCheck":false}}');
  await assert.rejects(verifyMiniRelease(second.directory), /检查失败/);
  await fs.writeFile(privateFile, '{"setting":{"urlCheck":true}}');
  assert.equal((await verifyMiniRelease(second.directory)).passed, true);
});

test('游客 AppID、无效域名和类型错误不能生成正式目录', async t => {
  const { root, write } = await fixture(t);
  await assert.rejects(buildMiniRelease({ origin: 'http://localhost:3000', root }), /正式地址/);
  await assert.rejects(fs.access(path.join(root, 'releases')));
  await write('project.config.json', '{"appid":"touristappid"}');
  await assert.rejects(buildMiniRelease({ origin, root }), /AppID/);
  await write('project.config.json', JSON.stringify({ appid: appId }));
  await write('apps/miniprogram/src/app.ts', 'const broken: string = 123;');
  await assert.rejects(buildMiniRelease({ origin, root }), /编译失败/);
  const entries = await fs.readdir(path.join(root, 'releases'));
  assert.ok(entries.every(entry => entry.startsWith('.building-')));
  for (const entry of entries) await assert.rejects(fs.access(path.join(root, 'releases', entry, 'project.config.json')));
});

test('完整小程序源码可在隔离目录生成正式模式产物，本机源码保持不变', async t => {
  const { root, write } = await fixture(t);
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = path.join(repository, 'apps/miniprogram/src');
  const original = await fs.readFile(path.join(source, 'services/config.ts'), 'utf8');
  await fs.cp(source, path.join(root, 'apps/miniprogram/src'), { recursive: true });
  const config = JSON.parse(await fs.readFile(path.join(repository, 'apps/miniprogram/tsconfig.json'), 'utf8'));
  config.compilerOptions.typeRoots = [path.join(repository, 'node_modules/@types'), path.join(repository, 'node_modules')];
  await write('apps/miniprogram/tsconfig.json', JSON.stringify(config));
  const result = await buildMiniRelease({ origin, root });
  assert.equal(result.passed, true); assert.ok(result.fileCount > 20);
  assert.equal(await fs.readFile(path.join(source, 'services/config.ts'), 'utf8'), original);
});
