import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compiler = path.join(repository, 'node_modules/typescript/bin/tsc');

export function releaseOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        isIP(url.hostname) || !url.hostname.includes('.') || url.hostname.startsWith('[') ||
        /(^|\.)(localhost|local|test|invalid|example)$/.test(url.hostname) ||
        /(^|\.)example\.(com|org|net)$/.test(url.hostname) || url.hostname.endsWith('.')) throw new Error();
    return url.origin;
  } catch { throw new Error('正式地址必须为实际域名的 HTTPS 根地址，不能使用本机、IP、示例域名、凭证或额外路径'); }
}

async function filesUnder(directory, prefix = '') {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error('发布目录不接受符号链接');
    if (entry.isDirectory()) files.push(...await filesUnder(path.join(directory, entry.name), relative + '/'));
    else if (entry.isFile()) files.push(relative);
    else throw new Error('发布目录包含不支持的文件');
  }
  return files.sort();
}

async function hashes(directory) {
  const result = {};
  for (const file of await filesUnder(directory)) {
    if (file === 'release-manifest.json' || file === 'project.private.config.json') continue;
    result[file] = createHash('sha256').update(await fs.readFile(path.join(directory, file))).digest('hex');
  }
  return result;
}

function compiledConfig(source) {
  const parsed = ts.createSourceFile('config.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const configs = [];
  for (const statement of parsed.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) continue;
    const expression = statement.expression;
    if (expression.left.getText(parsed) !== 'exports.config' || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isObjectLiteralExpression(expression.right)) continue;
    const config = {};
    for (const field of expression.right.properties) {
      if (!ts.isPropertyAssignment(field) || !ts.isStringLiteral(field.initializer)) throw new Error('发布配置格式不正确');
      const key = field.name.getText(parsed).replaceAll(/['"]/g, '');
      if (Object.hasOwn(config, key)) throw new Error('发布配置包含重复字段');
      config[key] = field.initializer.text;
    }
    configs.push(config);
  }
  if (configs.length !== 1) throw new Error('发布配置缺失或重复');
  return configs[0];
}

export async function verifyMiniRelease(directory) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'release-manifest.json'), 'utf8'));
    const project = JSON.parse(await fs.readFile(path.join(directory, 'project.config.json'), 'utf8'));
    const config = compiledConfig(await fs.readFile(path.join(directory, 'miniprogram/services/config.js'), 'utf8'));
    let privateProject = {};
    try { privateProject = JSON.parse(await fs.readFile(path.join(directory, 'project.private.config.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const actual = await hashes(directory);
    if (manifest.version !== 1 || !/^[a-f0-9]{64}$/.test(actual['miniprogram/app.json'] ?? '') ||
        JSON.stringify(actual) !== JSON.stringify(manifest.files) ||
        Object.keys(actual).some(file => file !== 'project.config.json' && !/^miniprogram\/.+\.(js|json|wxml|wxss)$/.test(file)) ||
        !/^wx[a-f0-9]{16}$/i.test(project.appid ?? '') || project.appid !== manifest.appId ||
        project.compileType !== 'miniprogram' || project.miniprogramRoot !== 'miniprogram/' || project.setting?.urlCheck !== true ||
        (privateProject.setting?.urlCheck !== undefined && privateProject.setting.urlCheck !== true) ||
        config.mode !== 'api' || config.authMode !== 'wechat' || Object.keys(config).length !== 3 ||
        config.apiBase !== releaseOrigin(config.apiBase) || config.apiBase !== manifest.apiOrigin) throw new Error();
    return { passed: true, appId: project.appid, apiOrigin: config.apiBase, fileCount: Object.keys(actual).length,
      liveLoginVerified: false, note: '仅验证产物配置与文件一致性；不验证来源可信度、域名可达性、微信登录或真机。' };
  } catch { throw new Error('正式产物检查失败：文件缺失、变化或发布配置不合格，请重新构建'); }
}

export async function buildMiniRelease({ origin, root = repository }) {
  const apiOrigin = releaseOrigin(origin);
  const project = JSON.parse(await fs.readFile(path.join(root, 'project.config.json'), 'utf8'));
  if (!/^wx[a-f0-9]{16}$/i.test(project.appid ?? '')) throw new Error('正式构建需要实际小程序 AppID');
  const source = path.join(root, 'apps/miniprogram/src');
  // 编译器只读已检查的源码，拒绝可能把目录外内容带进发布包的链接。
  const assets = await filesUnder(source);
  const parent = path.join(root, 'releases');
  await fs.mkdir(parent, { recursive: true });
  const suffix = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const staging = path.join(parent, '.building-' + suffix);
  const destination = path.join(parent, 'mini-' + suffix);
  await fs.mkdir(staging);
  // 失败留在 .building-*；只有完整校验成功才改名为正式目录。
  const mini = path.join(staging, 'miniprogram');
  const result = spawnSync(process.execPath, [compiler, '-p', path.join(root, 'apps/miniprogram/tsconfig.json'), '--outDir', mini,
    '--noEmitOnError', 'true', '--sourceMap', 'false', '--declaration', 'false', '--incremental', 'false'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('小程序类型编译失败；未生成正式发布目录，请运行 npm run typecheck 查看源码错误');
  for (const file of assets.filter(file => /\.(json|wxml|wxss)$/.test(file))) {
    await fs.mkdir(path.dirname(path.join(mini, file)), { recursive: true });
    await fs.copyFile(path.join(source, file), path.join(mini, file));
  }
  await fs.mkdir(path.join(mini, 'services'), { recursive: true });
  await fs.writeFile(path.join(mini, 'services/config.js'), '"use strict";\nexports.config = ' + JSON.stringify({ mode: 'api', authMode: 'wechat', apiBase: apiOrigin }) + ';\n');
  const outputProject = { description: '圆桌秘书正式环境构建', projectname: 'roundtable-secretary-release', appid: project.appid,
    compileType: 'miniprogram', miniprogramRoot: 'miniprogram/', setting: { es6: true, minified: true, urlCheck: true, minifyWXSS: true, minifyWXML: true } };
  await fs.writeFile(path.join(staging, 'project.config.json'), JSON.stringify(outputProject, null, 2) + '\n');
  const git = args => spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  const revision = git(['rev-parse', 'HEAD']), status = git(['status', '--porcelain']);
  const manifest = { version: 1, builtAt: new Date().toISOString(), appId: project.appid, apiOrigin,
    sourceRevision: revision.status === 0 && /^[a-f0-9]{40,64}$/.test(revision.stdout.trim()) ? revision.stdout.trim() : null,
    sourceDirty: status.status === 0 ? Boolean(status.stdout.trim()) : null, liveLoginVerified: false, files: await hashes(staging) };
  await fs.writeFile(path.join(staging, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await verifyMiniRelease(staging);
  await fs.rename(staging, destination);
  return { directory: destination, ...await verifyMiniRelease(destination) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || !['--api-origin', '--verify'].includes(args[0])) throw new Error('用法：npm run build:mini:release -- --api-origin https://实际域名，或 npm run check:mini:release -- 发布目录');
    const result = args[0] === '--verify' ? await verifyMiniRelease(path.resolve(args[1])) : await buildMiniRelease({ origin: args[1] });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    // 不输出编译器诊断和输入路径；诊断可能包含源码内的配置值。
    console.error(error.code ? '正式构建无法读取或写入项目文件，请检查项目与目录权限' : error.message);
    process.exitCode = 1;
  }
}
