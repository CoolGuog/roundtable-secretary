// Generate two simulator projects from the same build. No .env or backend files are copied.
import { cp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'dist', 'miniprogram');
const project = JSON.parse(await readFile(join(root, 'project.config.json'), 'utf8'));
const localOnly = process.argv.includes('--local');
for (const identity of localOnly ? ['local'] : ['A', 'B', 'C']) {
  const preview = join(root, 'dist', `demo-${identity}`);
  const mini = join(preview, 'miniprogram');
  await mkdir(preview, { recursive: true });
  await cp(source, mini, { recursive: true });
  // This is generated runtime configuration, not a source file.
  await writeFile(join(mini, 'services', 'config.js'),
    `"use strict";\nexports.config = ${JSON.stringify(localOnly ? { mode: 'local', authMode: 'demo', apiBase: 'http://127.0.0.1:3000' } : { mode: 'api', authMode: 'demo', apiBase: 'http://127.0.0.1:3000', demoIdentity: identity })};\n`);
  const app = JSON.parse(await readFile(join(mini, 'app.json'), 'utf8'));
  app.window.navigationBarTitleText = localOnly ? '圆桌秘书 · 本机工作台' : `圆桌秘书 · 学生${identity}`;
  await writeFile(join(mini, 'app.json'), JSON.stringify(app, null, 2));
  await writeFile(join(preview, 'project.config.json'), JSON.stringify({ ...project,
    projectname: `roundtable-demo-${identity}`, miniprogramRoot: 'miniprogram/',
    description: `Local demo identity ${identity}`, setting: { ...project.setting, urlCheck: true },
  }, null, 2));
  // Local simulator only. Public settings retain domain validation.
  await writeFile(join(preview, 'project.private.config.json'), JSON.stringify({
    projectname: `roundtable-demo-${identity}`, setting: { urlCheck: false },
  }, null, 2));
  console.log(`${localOnly ? '本机工作台' : `测试学生 ${identity}`}: ${preview}`);
}
console.log(localOnly ? '导入此目录验收本机会议工作台；记录仅存在本机，不代表多人同步。' : '分别导入A、B、C目录，在三个窗口编译；三个项目连接同一个后台，演示会话缓存独立。');
