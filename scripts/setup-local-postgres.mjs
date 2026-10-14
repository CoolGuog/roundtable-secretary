// 为当前 Windows 用户配置独立开发数据库。先将 EDB Windows 二进制包解压至下面的安装目录。
// 不覆盖已有 .env 或已有数据库；生成的凭证只写本机，不打印。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import net from 'node:net';

const project = resolve(fileURLToPath(new URL('..', import.meta.url)));
if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) throw new Error('此脚本仅供 Windows 本机开发');
const install = join(process.env.LOCALAPPDATA, 'RoundtableSecretary', 'postgres17');
const bin = join(install, 'pgsql', 'bin');
const data = join(install, 'data');
const envFile = join(project, '.env');
const port = 5432;
if (!existsSync(join(bin, 'initdb.exe'))) throw new Error('请先解压 PostgreSQL 二进制包');
if (existsSync(data) || existsSync(envFile)) throw new Error('已有数据库目录或 .env；停止以避免覆盖，请检查现有配置');
await new Promise((accept, reject) => {
  const server = net.createServer();
  server.once('error', () => reject(new Error('5432 端口已占用，请使用已有服务或调整端口')));
  server.listen(port, '127.0.0.1', () => server.close(accept));
});
function run(exe, args, options = {}) {
  const result = spawnSync(join(bin, exe), args, {
    encoding: 'utf8', windowsHide: true, timeout: 60000, ...options,
  });
  if (result.status !== 0) throw new Error(`${exe} 执行失败，请检查本机数据库日志；未输出凭证`);
  return result.stdout.trim();
}
const adminPassword = randomBytes(32).toString('hex');
const appPassword = randomBytes(32).toString('hex');
const adminFile = join(install, 'admin-password.txt');
mkdirSync(install, { recursive: true });
writeFileSync(adminFile, adminPassword, { flag: 'wx' });
run('initdb.exe', ['-D', data, '-U', 'rt_admin', '--pwfile', adminFile,
  '--auth=scram-sha-256', '--encoding=UTF8', '--locale=C']);
// postgresql.auto.conf 是 initdb 生成的配置，本脚本只初始化一次。
writeFileSync(join(data, 'postgresql.auto.conf'),
  "# RoundtableSecretary local development only\nlisten_addresses = '127.0.0.1'\nport = 5432\npassword_encryption = 'scram-sha-256'\n");
run('pg_ctl.exe', ['-D', data, '-l', join(install, 'server.log'), '-w', 'start']);
run('psql.exe', ['-h', '127.0.0.1', '-p', String(port), '-U', 'rt_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
  env: { ...process.env, PGPASSWORD: adminPassword },
  input: `CREATE ROLE rt_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${appPassword}';\nCREATE DATABASE roundtable_dev OWNER rt_app;\n`,
});
writeFileSync(envFile,
  `HOST=127.0.0.1\nPORT=3000\nSTORAGE_MODE=postgres\nDATABASE_URL=postgresql://rt_app:${appPassword}@127.0.0.1:${port}/roundtable_dev?schema=public\n`,
  { flag: 'wx' });
console.log('PostgreSQL 已初始化，独立开发库 roundtable_dev 已创建。');
console.log('仅监听 127.0.0.1:5432；应用使用非超级用户 rt_app。凭证已写入被 Git 忽略的 .env。');
