import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import ts from 'typescript';

export function readMiniConfig(source) {
  const file = ts.createSourceFile('config.ts', source, ts.ScriptTarget.Latest, true);
  const values = {};
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'config' && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      for (const property of node.initializer.properties) if (ts.isPropertyAssignment(property) && ts.isStringLiteral(property.initializer)) {
        values[property.name.getText(file).replaceAll(/['"]/g, '')] = property.initializer.text;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file); return values;
}
export function inspectSetup(project, mini, env) {
  const appIdValid = /^wx[a-f0-9]{16}$/i.test(project.appid ?? '');
  let https = false;
  try { const url = new URL(mini.apiBase); https = url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; } catch {}
  const checks = [
    { item: '项目 AppID', configured: appIdValid, note: '格式检查通过仍需开发者工具验证账号权限' },
    { item: '后台 AppID', configured: appIdValid && env.WECHAT_APP_ID === project.appid, note: '须与 project.config.json 一致' },
    { item: '后台 AppSecret', configured: Boolean(env.WECHAT_APP_SECRET?.trim()), note: '只检查是否填写，不输出内容、不联网换码' },
    { item: '数据库配置', configured: env.STORAGE_MODE === 'postgres' && Boolean(env.DATABASE_URL), note: '数据库连通性与迁移另用 npm run db:status 检查' },
    { item: '后台微信模式', configured: env.AUTH_MODE === 'wechat', note: 'AUTH_MODE=wechat' },
    { item: '小程序微信模式', configured: mini.mode === 'api' && mini.authMode === 'wechat', note: '修改 config.ts 后需重新构建' },
    { item: 'HTTPS 后台地址', configured: https, note: '地址格式符合要求仍需配置微信合法域名并验证可达性' },
  ];
  return { checks, configurationComplete: checks.every(check => check.configured),
    liveLoginVerified: false, note: '本检查只验证本机配置，不代表微信登录、域名平台配置或真机验收通过。' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const localEnv = fs.existsSync(path.join(root, '.env')) ? parseEnv(fs.readFileSync(path.join(root, '.env'), 'utf8')) : {};
    const project = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'));
    const mini = readMiniConfig(fs.readFileSync(path.join(root, 'apps/miniprogram/src/services/config.ts'), 'utf8'));
    const result = inspectSetup(project, mini, { ...localEnv, ...process.env });
    console.log(JSON.stringify(result, null, 2));
  } catch { console.error('配置检查无法完成，请检查项目配置文件是否存在且格式正确。'); process.exitCode = 1; }
}
