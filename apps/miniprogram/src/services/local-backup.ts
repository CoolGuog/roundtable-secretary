import { config } from './config';
import { localKeys, readLocal, commitLocalRestore } from './local-store';
import { dayAfter, occurs, RepeatSeries } from './repeat-engine';

type Row = Record<string, any>;
type Check = (value: any) => any;
export const backupLimit = 800_000;
export const backupNames = ['单次日程', '偏好与记忆', '圆桌', '会议复盘', '会议工作台', '重复日程规则'];
const names = ['arrangements', 'memories', 'rooms', 'reviews', 'workspaces', 'recurring'];
const idField = (name: string) => ['reviews', 'workspaces'].includes(name) ? 'roomId' : 'id';
function ensure(ok: unknown, message = '备份结构或字段无效，请使用本应用导出的完整备份'): asserts ok { if (!ok) throw new Error(message); }
function localOnly() { ensure(config.mode === 'local', '备份与恢复目前仅支持本机模式，不读取服务器记录'); }
const str = (max: number, empty = false): Check => v => { ensure(typeof v === 'string' && v.length <= max && (empty || v.trim().length > 0)); return v; };
const num = (min: number, max = Number.MAX_SAFE_INTEGER): Check => v => { ensure(Number.isSafeInteger(v) && v >= min && v <= max); return v; };
const one = (...values: any[]): Check => v => { ensure(values.includes(v)); return v; };
const bool = one(true, false), ident = str(160), text = str(500, true);
const date: Check = v => { str(10)(v); ensure(/^20\d{2}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v); return v; };
const workDate: Check = v => { date(v); ensure(v >= '2020-01-01'); return v; };
const timestamp: Check = v => { str(40)(v); ensure(/^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v))); return v; };
const time: Check = v => { str(5)(v); ensure(/^([01]\d|2[0-3]):[0-5]\d$/.test(v)); return v; };
const array = (check: Check, max: number): Check => v => { ensure(Array.isArray(v) && v.length <= max); return v.map(check); };
const object = (shape: Record<string, Check>): Check => v => {
  ensure(v !== null && typeof v === 'object' && !Array.isArray(v));
  ensure(Object.keys(v).length === Object.keys(shape).length && Object.keys(v).every(key => Object.prototype.hasOwnProperty.call(shape, key)));
  const output: Row = {}; for (const key of Object.keys(shape)) output[key] = shape[key](v[key]); return output;
};
const unique = (rows: Row[], field: string) => ensure(new Set(rows.map(row => row[field])).size === rows.length, '备份中含重复编号，请重新导出');
const arrangement = object({ id: ident, title: str(60), date, startTime: time, endTime: time, createdAt: timestamp });
const memory = object({ id: ident, category: one('PREFERENCE', 'CONSTRAINT', 'NOTE'), label: str(40), content: str(500), source: one('USER_INPUT', 'SECRETARY'), createdAt: timestamp, updatedAt: timestamp });
const member = object({ id: one('local-self'), name: str(40), role: one('OWNER'), isMe: one(true), shareBusy: bool, consentUpdatedAt: v => v === null ? null : timestamp(v) });
const room = object({ id: ident, title: str(60), goal: str(500), dateFrom: date, dateTo: date, startTime: time, endTime: time, durationMinutes: num(15, 240), status: one('OPEN', 'CLOSED'), version: num(1), createdAt: timestamp, isOwner: one(true), members: array(member, 1) });
const allocation = object({ memberId: one('local-self'), percent: num(0, 100), reason: str(200, true), action: str(200, true) });
const vote = object({ memberId: one('local-self'), decision: one('PENDING'), comment: one(''), decidedAt: one(null) });
const revision = object({ revision: num(1, 20), date, outcome: one('NOT_HELD', 'CANCELLED'), facts: str(1000), allocations: array(allocation, 1), externalPercent: num(0, 100), externalReason: str(300, true), unassignedPercent: num(0, 100), createdAt: timestamp, status: one('DRAFT'), votes: array(vote, 1), events: array(vote, 0) });
const review = object({ roomId: ident, view: object({ version: num(0), canEdit: one(true), canVote: one(false), participants: array(object({ memberId: one('local-self'), name: str(40), isMe: one(true), active: one(true) }), 1), revisions: array(revision, 20) }) });
const history = object({ at: timestamp, label: str(100), note: str(500, true) });
const task = object({ id: ident, title: str(60), owner: str(40), dueDate: workDate, details: text, state: one('TODO', 'DOING', 'REVIEW', 'DONE'), source: str(200, true), sourceLabel: str(100), history: array(history, 30) });
const prep = object({ id: ident, title: str(60), owner: str(40), dueDate: workDate, note: str(300, true), done: bool, doneAt: v => v === '' ? '' : timestamp(v), source: str(200, true) });
const minutes = object({ revision: num(1, 20), date: workDate, summary: str(1500), decisions: str(1000, true), nextSteps: str(1000, true), savedAt: timestamp });
const workspace = object({ roomId: ident, version: num(0), tasks: array(task, 50), preparation: array(prep, 50), minutes: array(minutes, 20) });
const repeatBase = object({ title: str(60), date, startTime: time, endTime: time });
const recurring: Check = value => {
  const row = object({ id: ident, title: str(60), date, startTime: time, endTime: time, createdAt: timestamp, repeat: v => v, exceptions: v => v })(value);
  ensure(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id), '重复日程编号无效');
  ensure(row.startTime < row.endTime, '重复日程起止时间无效');
  const hasUntil = row.repeat && Object.prototype.hasOwnProperty.call(row.repeat, 'until');
  const rule = object({ kind: one('daily', 'weekly'), weekdays: array(num(0, 6), 7), ...(hasUntil ? { until: str(10) } : {}) })(row.repeat);
  ensure(new Set(rule.weekdays).size === rule.weekdays.length && (rule.kind === 'daily' ? rule.weekdays.length === 0 && hasUntil : rule.weekdays.length > 0), '重复规则无效');
  // 从第一次起删除或分拆，会保留截止到开始日前一天的空历史段。
  if (hasUntil && rule.until !== dayAfter(row.date, -1)) { date(rule.until); ensure(rule.until >= row.date, '重复截止日期无效'); }
  row.repeat = { ...rule, weekdays: [...rule.weekdays].sort() };
  const exceptions = row.exceptions;
  ensure(exceptions !== null && typeof exceptions === 'object' && !Array.isArray(exceptions) && Object.keys(exceptions).length <= 500, '单次修改记录无效或超过 500 条');
  row.exceptions = {};
  for (const originalDate of Object.keys(exceptions).sort()) {
    date(originalDate); ensure(occurs(row as RepeatSeries, originalDate), '单次修改日期不属于重复规则');
    const entry = exceptions[originalDate] === null ? null : repeatBase(exceptions[originalDate]);
    if (entry) ensure(entry.startTime < entry.endTime, '单次修改起止时间无效');
    row.exceptions[originalDate] = entry;
  }
  return row;
};
const legacyShape = { arrangements: array(arrangement, 100), memories: array(memory, 100), rooms: array(room, 5000), reviews: array(review, 100), workspaces: array(workspace, 100) };
const dataShape = object({ ...legacyShape, recurring: array(recurring, 500) });
export function validateBackupData(value: unknown): Row {
  const data = dataShape(value);
  ensure(JSON.stringify(data).length <= backupLimit, '记录总量超过单份备份容量（80 万字符）');
  names.forEach(name => unique(data[name], idField(name)));
  data.arrangements.forEach((r: Row) => ensure(r.startTime < r.endTime, '日程起止时间无效'));
  ensure(data.rooms.filter((r: Row) => r.status === 'OPEN').length <= 20, '进行中的圆桌超过 20 个');
  const rooms = new Map<string, Row>(data.rooms.map((r: Row) => [r.id, r]));
  for (const r of data.rooms) {
    const days = (Date.parse(r.dateTo) - Date.parse(r.dateFrom)) / 86400_000;
    const span = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    ensure(days >= 0 && days <= 30 && r.members.length === 1 && r.durationMinutes % 15 === 0 && span(r.endTime) - span(r.startTime) >= r.durationMinutes, '圆桌日期、时长或成员无效');
  }
  function linked(id: string): Row { const r = rooms.get(id); ensure(r, '复盘或工作台缺少关联圆桌，请选择完整备份'); return r; }
  function inRoom(d: string, r: Row) { ensure(d >= r.dateFrom && d <= r.dateTo, '记录日期超出关联圆桌范围'); }
  for (const entry of data.reviews) {
    const r = linked(entry.roomId), view = entry.view;
    ensure(view.participants.length === 1 && view.version === view.revisions.length && JSON.stringify(view).length <= 80_000);
    view.revisions.forEach((rev: Row, index: number) => {
      inRoom(rev.date, r); ensure(rev.revision === index + 1 && rev.allocations.length === 1);
      const row = rev.allocations[0]; ensure(row.percent + rev.externalPercent + rev.unassignedPercent === 100 && (!row.percent || row.reason.trim()) && (!rev.externalPercent || rev.externalReason.trim()), '责任比例或依据无效');
    });
  }
  for (const w of data.workspaces) {
    const r = linked(w.roomId); ensure(JSON.stringify(w).length <= 80_000);
    unique(w.tasks, 'id'); unique(w.preparation, 'id');
    unique(w.tasks.filter((t: Row) => t.source), 'source'); unique(w.preparation.filter((t: Row) => t.source), 'source');
    w.preparation.forEach((p: Row) => ensure(p.done === Boolean(p.doneAt)));
    w.minutes.forEach((m: Row, index: number) => { inRoom(m.date, r); ensure(m.revision === index + 1); const lines = m.nextSteps.split('\n').filter((s: string) => s.trim()); ensure(lines.length <= 10 && lines.every((s: string) => s.trim().length <= 500)); });
  }
  return data;
}
function current() { const data: Row = {}; names.forEach((name, i) => { const value = readLocal(localKeys[i]); data[name] = value === '' || value === undefined || value === null ? [] : value; }); return validateBackupData(data); }
export function exportLocalBackup(): string {
  localOnly(); return JSON.stringify({ format: 'roundtable-local-backup', version: 2, exportedAt: new Date().toISOString(), data: current() }, null, 0);
}
function parse(source: string) {
  ensure(typeof source === 'string' && source.length <= backupLimit + 200, '备份文件过大');
  let value: unknown; try { value = JSON.parse(source.replace(/^\uFEFF/, '')); } catch { throw new Error('文件不是有效的 JSON 备份'); }
  const backup = object({ format: one('roundtable-local-backup'), version: one(1, 2), exportedAt: timestamp, data: v => v })(value);
  backup.data = validateBackupData(backup.version === 1 ? { ...object(legacyShape)(backup.data), recurring: [] } : backup.data);
  return backup;
}
export type BackupPreview = { exportedAt: string; counts: Array<{ name: string; incoming: number; added: number; skipped: number }>; added: number; baseline: string };
function prepare(source: string) {
  localOnly(); const backup = parse(source), before = current(), merged: Row = {}, counts: BackupPreview['counts'] = [];
  names.forEach((name, i) => {
    const field = idField(name), existing = new Map<string, Row>(before[name].map((r: Row) => [r[field], r])); let added = 0, skipped = 0;
    merged[name] = [...before[name]];
    for (const row of backup.data[name]) {
      const old = existing.get(row[field]);
      if (old) { ensure(JSON.stringify(old) === JSON.stringify(row), `${backupNames[i]}中有同编号的不同内容，为保留当前修改已停止导入；可在空白演示环境恢复旧备份`); skipped++; }
      else { merged[name].push(row); added++; }
    }
    counts.push({ name: backupNames[i], incoming: backup.data[name].length, added, skipped });
  });
  validateBackupData(merged);
  return { merged, preview: { exportedAt: backup.exportedAt, counts, added: counts.reduce((n, c) => n + c.added, 0), baseline: JSON.stringify(before) } };
}
export function previewLocalBackup(source: string): BackupPreview { return prepare(source).preview; }
export function restoreLocalBackup(source: string, baseline: string): number {
  const { merged, preview } = prepare(source);
  ensure(preview.baseline === baseline, '预览后本机记录已有变化，请重新预览再导入');
  if (preview.added) commitLocalRestore(names.map(name => merged[name]));
  return preview.added;
}
