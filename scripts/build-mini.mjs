import { spawnSync } from 'node:child_process';
import { readdir, mkdir, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'apps/miniprogram/tsconfig.json'], {
  cwd: root, stdio: 'inherit',
});
if (result.status !== 0) process.exit(result.status || 1);
async function copyAssets(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(destination, entry.name);
    if (entry.isDirectory()) await copyAssets(from, to);
    else if (/\.(json|wxml|wxss)$/.test(entry.name)) await copyFile(from, to);
  }
}
await copyAssets(join(root, 'apps/miniprogram/src'), join(root, 'dist/miniprogram'));
console.log('小程序已构建至 dist/miniprogram，请在微信开发者工具导入项目根目录。');
