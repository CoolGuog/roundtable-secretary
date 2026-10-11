import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export function prepareDeepseekEnv(source, key, model = 'deepseek-flash') {
  if (typeof key !== 'string' || !/^[A-Za-z0-9._-]{16,512}$/.test(key)) throw new Error('Key 格式不正确，请重新复制；请勿把 Key 发到聊天中');
  if (typeof model !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(model)) throw new Error('模型名称格式不正确');
  if (parseEnv(source).NODE_ENV === 'production') throw new Error('此配置工具仅用于本机开发');
  const settings = { SECRETARY_MODE: 'http', SECRETARY_BASE_URL: 'https://api.deepseek.com', SECRETARY_MODEL: model,
    SECRETARY_API_KEY: key, SECRETARY_ALLOWED_HOSTS: 'api.deepseek.com', SECRETARY_ALLOWED_MODELS: model };
  const kept = source.split(/\r?\n/).filter(line => { const match = /^\s*(?:export\s+)?([A-Z_]+)\s*=/.exec(line); return !match || !(match[1] in settings); });
  return kept.join('\n').trimEnd() + '\n\n# DeepSeek: server-side only; never commit this file.\n' + Object.entries(settings).map(([name, value]) => `${name}=${value}`).join('\n') + '\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url)), file = path.join(root, '.env');
  const temporary = path.join(root, `.env.deepseek-${randomUUID()}`);
  try {
    if (process.argv.length > 2) throw new Error('请使用 model:setup 隐藏输入，不要把密钥放在命令行参数中');
    execFileSync('git', ['check-ignore', '--quiet', '.env'], { cwd: root, windowsHide: true, stdio: 'pipe' });
    let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 2048) throw new Error('输入过长'); }
    const { key, model } = JSON.parse(input.replace(/^\uFEFF/, ''));
    const source = fs.readFileSync(file, 'utf8'), result = prepareDeepseekEnv(source, key, model);
    fs.writeFileSync(temporary, '', { flag: 'wx', mode: 0o600 });
    if (process.platform === 'win32') {
      const account = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, encoding: 'utf8' });
      const sid = account.match(/S-1-5-\d+(?:-\d+)+/)?.[0];
      if (!sid) throw new Error('无法确认本机用户权限');
      execFileSync('icacls', [temporary, '/inheritance:r', '/grant:r', `*${sid}:(F)`, '*S-1-5-18:(F)'], { windowsHide: true, stdio: 'pipe' });
    }
    fs.writeFileSync(temporary, result); fs.renameSync(temporary, file);
    console.log('DeepSeek 配置已保存在本机 .env；数据库和微信配置保留，密钥未输出。');
  } catch {
    console.error('配置未完成：检查 Key/模型名称、.env 是否存在、Git 忽略规则和文件权限。密钥未输出。'); process.exitCode = 1;
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
