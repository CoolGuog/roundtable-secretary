import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const code = ts.transpileModule(fs.readFileSync('apps/miniprogram/src/pages/backup/index.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function page(overrides = {}) {
 let p, imports = 0, choose, clipboard, share; const files = new Map();
 const api = { exportLocalBackup: () => '{"backup":true}', previewLocalBackup: source => { if (source === 'bad') throw Error('损坏文件'); return { counts: [], added: 1, baseline: 'original', exportedAt: '2026-10-07T00:00:00.000Z' }; },
   restoreLocalBackup: () => { imports++; return 1; }, ...overrides };
 const wx = { env: { USER_DATA_PATH: '/test' }, getFileSystemManager: () => ({ writeFileSync: (path, value) => files.set(path, value), readFileSync: path => files.get(path) }),
   chooseMessageFile: options => { choose = options; }, setClipboardData: options => { clipboard = options; }, shareFileMessage: options => { share = options; } };
 vm.runInNewContext(code, { exports: {}, require: name => name.endsWith('local-backup') ? api : { isLocalRoomMode: () => true, errorMessage: error => error.message }, wx, Page: value => { p = value; } });
 p.setData = value => Object.assign(p.data, value); return { p, files, imports: () => imports, choose: () => choose, clipboard: () => clipboard, share: () => share };
}
test('备份文件按生成时快照保存；复制与分享需明确操作，不会自动发送', () => {
 const c = page(); c.p.generate(); assert.equal(c.p.data.ready, true); assert.equal(c.files.get('/test/roundtable-local-backup.json'), '{"backup":true}'); assert.equal(c.share(), undefined); assert.equal(c.clipboard(), undefined);
 c.p.copy(); assert.equal(c.clipboard().data, '{"backup":true}'); c.clipboard().complete(); c.p.shareFile(); assert.equal(c.share().filePath, '/test/roundtable-local-backup.json'); c.share().fail(); assert.match(c.p.data.message, /未完成/);
});
test('预览和取消不写入；明确确认一次，重复点击或改文本不能复用旧确认', () => {
 const c = page(); c.p.data.source = 'valid'; c.p.previewText(); assert.equal(c.imports(), 0); c.p.cancel(); c.p.restore(); assert.equal(c.imports(), 0);
 c.p.previewText(); c.p.input({ detail: { value: 'changed' } }); c.p.restore(); assert.equal(c.imports(), 0);
 c.p.previewText(); c.p.restore(); c.p.restore(); assert.equal(c.imports(), 1); assert.equal(c.p.data.source, '');
});
test('损坏文件清除旧预览；恢复失败保留文本但要求重新预览', () => {
 const c = page({ restoreLocalBackup: () => { throw Error('记录已有变化'); } }); c.p.data.source = 'valid'; c.p.previewText(); c.p.restore(); assert.equal(c.p.data.preview, false); assert.equal(c.p.data.source, 'valid'); assert.match(c.p.data.error, /变化/);
 c.p.previewText(); c.p.input({ detail: { value: 'bad' } }); c.p.previewText(); assert.equal(c.p.data.preview, false); assert.match(c.p.data.error, /损坏/);
});
test('文件选择支持取消和超限，离页撤销确认，卸载后迟到回调不更新', () => {
 const c = page(); c.p.chooseFile(); c.choose().fail(); c.choose().complete(); assert.equal(c.p.data.busy, false);
 c.p.chooseFile(); c.choose().success({ tempFiles: [{ path: '/large', size: 3_200_001 }] }); c.choose().complete(); assert.match(c.p.data.error, /容量/);
 c.p.data.source = 'valid'; c.p.previewText(); c.p.onHide(); c.p.restore(); assert.equal(c.imports(), 0);
 c.p.chooseFile(); c.p.onUnload(); c.p.setData = () => assert.fail('卸载后不更新'); c.choose().success({ tempFiles: [{ path: '/x', size: 5 }] }); c.choose().complete();
});
test('原生文件读取后只预览，拒绝过大剪贴板文本且后台模式不生成', () => {
 const c = page(); c.files.set('/selected', 'valid'); c.p.chooseFile(); c.choose().success({ tempFiles: [{ path: '/selected', size: 5 }] }); c.choose().complete(); assert.equal(c.p.data.preview, true); assert.equal(c.imports(), 0);
 c.p._export = 'x'.repeat(60001); c.p.data.ready = true; c.p.copy(); assert.equal(c.clipboard(), undefined); assert.match(c.p.data.error, /6 万/);
 c.p.data.local = false; c.p.generate(); assert.equal(c.files.has('/test/roundtable-local-backup.json'), false);
});
