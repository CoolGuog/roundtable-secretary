import assert from 'node:assert/strict';
export async function sharedWorkContract(t, call, user) {
 const a = await user('工作发起人'), b = await user('工作负责人'), c = await user('旁观账号');
 const date = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
 const room = await (await call('/roundtables', 'POST', a.token, { title: '虚构协作工作台', goal: '完成任务并验收', dateFrom: date, dateTo: date, startTime: '09:00', endTime: '17:00', durationMinutes: 60 })).json();
 assert.equal((await call('/roundtables/join', 'POST', b.token, { code: room.inviteCode })).status, 201);
 const route = `/roundtables/${room.id}/work`, read = async token => (await call(route, 'GET', token)).json();
 let view = await read(a.token), taskId; const person = view.participants.find(p => !p.isMe);
 const input = { version: 0, title: '虚构：补齐材料', details: '逐项检查', dueDate: date, assigneeMemberId: person.memberId };
 const action = async (token, action, note, version = view.version) => call(`${route}/tasks/${taskId}/action`, 'PUT', token, { version, action, note });
 await t.test('协作任务鉴权和分派权限：外人不可读，不能伪造负责人或代替本人提交', async () => {
   assert.equal((await call(route)).status, 401); assert.equal((await call(route, 'GET', c.token)).status, 404);
   assert.equal((await call(`${route}/tasks`, 'POST', b.token, input)).status, 403);
   assert.equal((await call(`${route}/tasks`, 'POST', a.token, { ...input, userId: c.user.id })).status, 400);
   assert.equal((await call(`${route}/tasks`, 'POST', a.token, { ...input, assigneeMemberId: 'stranger' })).status, 400);
   const response = await call(`${route}/tasks`, 'POST', a.token, input); assert.equal(response.status, 201); view = await response.json(); taskId = view.tasks[0].id;
   assert.equal(view.tasks[0].assignee.name, '工作负责人'); assert.ok(!JSON.stringify(view).includes(b.user.id));
   assert.equal((await action(a.token, 'submit', '代交')).status, 403); assert.equal((await action(b.token, 'accept', '提前通过')).status, 409);
   assert.equal((await call(`${route}/tasks`, 'POST', a.token, input)).status, 409); assert.equal((await read(a.token)).tasks.length, 1);
 });
 await t.test('站内消息仅接收本人事件，已读不修改工作台版本，不能标记他人消息', async () => {
   const notices = await (await call('/me/notifications', 'GET', b.token)).json(); assert.equal(notices.length, 1); assert.equal(notices[0].readAt, null);
   assert.deepEqual(await (await call('/me/notifications', 'GET', c.token)).json(), []);
   assert.equal((await call(`${route}/notifications/${notices[0].id}`, 'PUT', a.token, {})).status, 404);
   assert.equal((await call(`${route}/notifications/${notices[0].id}`, 'PUT', b.token, { userId: a.user.id })).status, 400);
   for (let i = 0; i < 2; i++) assert.equal((await call(`${route}/notifications/${notices[0].id}`, 'PUT', b.token, {})).status, 200);
   assert.equal((await read(a.token)).version, view.version);
   assert.ok((await (await call('/me/notifications', 'GET', b.token)).json())[0].readAt);
 });
 await t.test('完成说明和验收意见必填，异议保留，全员本人确认才完成；重开清空当前表态', async () => {
   assert.equal((await action(b.token, 'submit', '')).status, 400);
   view = await (await action(b.token, 'start', '')).json(); assert.equal(view.tasks[0].state, 'DOING');
   view = await (await action(b.token, 'submit', '三份材料已经补齐')).json(); assert.equal(view.tasks[0].state, 'REVIEW');
   assert.equal((await action(a.token, 'accept', '')).status, 400);
   view = await (await action(a.token, 'dispute', '第二份材料仍有问题')).json(); assert.equal(view.tasks[0].state, 'DISPUTED');
   view = await (await action(b.token, 'accept', '本人完成核对')).json(); assert.equal(view.tasks[0].state, 'DISPUTED');
   view = await (await action(a.token, 'accept', '问题已解决，验收通过')).json(); assert.equal(view.tasks[0].state, 'DONE');
   assert.equal((await call(`${route}/tasks/${taskId}`, 'PUT', a.token, { ...input, version: view.version })).status, 409);
   view = await (await action(a.token, 'reopen', '补充新要求')).json(); assert.equal(view.tasks[0].state, 'TODO'); assert.equal(view.tasks[0].votes.length, 0);
   assert.ok(view.tasks[0].history.some(h => h.note === '第二份材料仍有问题'));
 });
 await t.test('并发表态只允许一个旧版本成功，刷新后另一成员可完成；不存在重复任务或事件', async () => {
   view = await (await action(b.token, 'submit', '第二轮重新核对')).json(); const version = view.version;
   const results = await Promise.all([action(a.token, 'accept', '发起人确认', version), action(b.token, 'accept', '负责人确认', version)]);
   assert.deepEqual(results.map(r => r.status).sort(), [200, 409]); view = await read(a.token);
   const index = results.findIndex(r => r.status === 409); view = await (await action(index === 0 ? a.token : b.token, 'accept', '刷新后本人确认')).json();
   assert.equal(view.tasks[0].state, 'DONE'); assert.equal(view.tasks[0].round, 2);
 });
 await t.test('退出后立即失去任务与消息权限，旧验收名单不可悄悄缩减，重开后才使用新名单', async () => {
   view = await (await action(a.token, 'reopen', '重新准备')).json(); view = await (await action(b.token, 'submit', '等待第三轮验收')).json();
   assert.equal((await call(`/roundtables/${room.id}/members/${person.memberId}`, 'DELETE', a.token)).status, 200);
   assert.equal((await call(route, 'GET', b.token)).status, 404); assert.deepEqual(await (await call('/me/notifications', 'GET', b.token)).json(), []);
   assert.equal((await action(a.token, 'accept', '不能绕过离开的成员')).status, 409);
   view = await (await action(a.token, 'reopen', '重新分派')).json();
   const mine = view.participants.find(p => p.isMe); view = await (await call(`${route}/tasks/${taskId}`, 'PUT', a.token, { ...input, version: view.version, assigneeMemberId: mine.memberId })).json();
   assert.equal((await action(a.token, 'submit', '一人不能共同验收')).status, 400);
   const updatedRoom = await (await call(`/roundtables/${room.id}`, 'GET', a.token)).json();
   assert.equal((await call('/roundtables/join', 'POST', c.token, { code: updatedRoom.inviteCode })).status, 201);
   view = await (await action(a.token, 'submit', '按新成员名单验收')).json();
   view = await (await action(a.token, 'accept', '我确认')).json(); view = await (await action(c.token, 'accept', '新成员本人确认')).json(); assert.equal(view.tasks[0].state, 'DONE');
 });
 return { a, c, room, route, expected: await read(a.token), notices: await (await call('/me/notifications', 'GET', c.token)).json() };
}
