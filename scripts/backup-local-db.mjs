// Back up this project's local public schema without exposing connection secrets.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

if (existsSync('.env')) process.loadEnvFile('.env');
if (!process.env.DATABASE_URL || !process.env.LOCALAPPDATA) throw new Error('Local database configuration is missing');
const url = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Only local database backups are supported');
const install = join(process.env.LOCALAPPDATA, 'RoundtableSecretary', 'postgres17');
const directory = join(install, 'backups');
mkdirSync(directory, { recursive: true });
const output = join(directory, `before-integration-${Date.now()}.dump`);
const result = spawnSync(join(install, 'pgsql', 'bin', 'pg_dump.exe'),
  ['--format=custom', '--schema=public', '--file', output], {
    windowsHide: true, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432',
      PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password) },
  });
if (result.status !== 0) throw new Error('Local backup failed; migration must not proceed');
const verified = spawnSync(join(install, 'pgsql', 'bin', 'pg_restore.exe'), ['--list', output],
  { windowsHide: true, encoding: 'utf8', timeout: 30000 });
if (verified.status !== 0 || !verified.stdout.includes('TABLE')) throw new Error('Backup archive validation failed');
console.log(`Backup archive created and readable: ${output}`);
