import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if (existsSync('.env')) process.loadEnvFile('.env');
if (!process.env.DATABASE_URL) {
  console.error('需要在本机 .env 配置 DATABASE_URL。测试会创建并清理独立 schema，不重置 public。');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['--test', 'tests/postgres.test.mjs'], {
  stdio: 'inherit', env: { ...process.env, RUN_POSTGRES_TESTS: '1' },
});
process.exitCode = result.status ?? 1;
