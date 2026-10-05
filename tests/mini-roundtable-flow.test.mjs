import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createApp } from '../apps/api/dist/app.js';

// 真实页面逻辑与请求服务连接本机 HTTP 后台；不代替微信渲染、原生弹窗或真机验收。
const files = ['services/secretary', 'services/roundtables', 'pages/roundtable/index'];
const sources = new Map(files.map(file => [file, ts.transpileModule(fs.readFileSync(`apps/miniprogram/src/${file}.ts`, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 },
}).outputText]));
const until = async condition => {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('页面未在预期时间内完成请求');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
function client(base) {
  const storage = new Map(), modules = new Map(), timers = new Map();
  let page, id = 0, requests = 0;
  const wx = {
    getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key),
    showModal: options => options.success({ confirm: true, cancel: false }), navigateBack() {},
    request: options => {
      requests++;
      void (async () => {
        try {
          const response = await fetch(options.url, { method: options.method, headers: { 'Content-Type': 'application/json', ...options.header },
            body: options.data === undefined ? undefined : JSON.stringify(options.data), signal: AbortSignal.timeout(options.timeout) });
          const text = await response.text(); options.success({ statusCode: response.status, data: text ? JSON.parse(text) : '' });
        } catch { options.fail(); } finally { requests--; }
      })();
    },
  };
  const context = vm.createContext({ wx, exports: {},
    require: name => name.endsWith('config') ? { config: { mode: 'api', authMode: 'demo', apiBase: base } } : modules.get(name.endsWith('roundtables') ? 'services/roundtables' : 'services/secretary'),
    Page: value => { page = value; },
    setTimeout: callback => { timers.set(++id, callback); return id; }, clearTimeout: key => timers.delete(key),
  });
  for (const file of files) { context.exports = {}; vm.runInContext(`(function(exports, require) { ${sources.get(file)}\n})(exports, require);`, context); modules.set(file, context.exports); }
  page.setData = data => Object.assign(page.data, data);
  const idle = () => until(() => !page.data.busy && !page.data.loading && !page.data.syncing && !page.data.finding && requests === 0);
  return { page, api: modules.get('services/secretary'), rooms: modules.get('services/roundtables'),
    async open(roomId) { page.onLoad({ id: roomId }); page.onShow(); await idle(); }, idle,
    async tick() { assert.equal(timers.size, 1); const [key, fn] = [...timers][0]; timers.delete(key); fn(); await idle(); },
  };
}

test('两份独立页面通过真实 HTTP 完成加入、授权、撤回、重新发起和全员写入，伙伴自动看到结果', async () => {
  const app = await createApp({ storage: 'memory', authMode: 'demo', secretary: { mode: 'off' } });
  let a, b;
  try {
    await app.listen(0, '127.0.0.1'); const base = await app.getUrl(); a = client(base); b = client(base);
    const date = new Date(Date.now() + 8 * 3600_000 + 86400_000).toISOString().slice(0, 10);
    const room = await a.rooms.createRoom({ title: '双人自动同步验收', goal: '确认双方都能看到最终状态', dateFrom: date, dateTo: date,
      startTime: '09:00', endTime: '18:00', durationMinutes: 60 });
    await a.open(room.id); await b.rooms.joinRoom(room.inviteCode); await b.open(room.id); await a.tick();
    assert.equal(a.page.data.room.members.length, 2);
    a.page.consent(); b.page.consent(); await Promise.all([a.idle(), b.idle()]); await a.tick();
    assert.ok(a.page.data.room.members.every(member => member.shareBusy));
    await a.page.findTime(); a.page.chooseSlot({ currentTarget: { dataset: { index: 0 } } }); await a.idle(); await b.tick();
    assert.equal(b.page.data.proposal.status, 'OPEN');
    a.page.cancelProposal(); await a.idle(); await b.tick(); assert.equal(b.page.data.proposal.status, 'CANCELLED');
    await a.page.findTime(); a.page.chooseSlot({ currentTarget: { dataset: { index: 0 } } }); await a.idle(); await b.tick();
    a.page.decide({ currentTarget: { dataset: { decision: 'ACCEPT' } } }); await a.idle(); await b.tick();
    assert.equal(b.page.data.proposal.votes.filter(vote => vote.decision === 'ACCEPT').length, 1);
    assert.equal((await a.api.listArrangements()).length, 0); assert.equal((await b.api.listArrangements()).length, 0);
    b.page.decide({ currentTarget: { dataset: { decision: 'ACCEPT' } } }); await b.idle(); await a.tick();
    assert.equal(a.page.data.proposal.status, 'CONFIRMED'); assert.equal(b.page.data.proposal.status, 'CONFIRMED');
    for (const c of [a, b]) { const rows = await c.api.listArrangements(); assert.equal(rows.length, 1); assert.equal(rows[0].title, room.title); }
    a.page.remove({ currentTarget: { dataset: { id: a.page.data.room.members.find(member => !member.isMe).id } } }); await a.idle(); await b.tick();
    assert.equal(b.page.data.room, null); assert.equal(b.page.data.proposal, null); assert.equal(b.page.data.fresh, false);
  } finally { a?.page.onUnload(); b?.page.onUnload(); await app.close(); }
});
