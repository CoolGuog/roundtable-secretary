import { getSharedWork, saveSharedTask, actSharedTask, SharedWork, SharedTask, SharedPerson, sharedEnabled, taskStateNames } from '../../services/shared-work';
import { errorMessage, today } from '../../services/secretary';
import { saveSharedPreparation, actSharedPreparation, saveSharedMinutes, importSharedAction, SharedPreparation, SharedMinutes } from '../../services/shared-work';
Page({
  data: { id: '', enabled: sharedEnabled(), view: null as SharedWork | null, loading: false, busy: false, fresh: false, error: '',
    tab: 'tasks', editor: '', taskId: '', baseVersion: 0, title: '', details: '', dueDate: today(), assigneeIndex: 0, action: '', note: '', actionLabel: '',
    meetingDate: '', summary: '', decisions: '', nextSteps: '', revision: 0, stepIndex: 0, done: false, readyCount: 0 },
  _visible: false, _disposed: false, _epoch: 0, _timer: null as number | null,
  onLoad(query: { id?: string; tab?: string }) { this.setData({ id: query.id ?? '', tab: ['tasks', 'preparation', 'minutes'].includes(query.tab ?? '') ? query.tab! : 'tasks' }); },
  onShow() { this._visible = true; this._disposed = false; if (this.data.enabled) void this.reload(); },
  onHide() { this._visible = false; this._epoch++; if (this._timer !== null) clearTimeout(this._timer); this._timer = null; },
  onUnload() { this.onHide(); this._disposed = true; },
  schedule() { if (this._timer !== null) clearTimeout(this._timer); if (this._visible) this._timer = setTimeout(() => { this._timer = null; if (!this.data.editor && !this.data.busy) void this.reload(); else this.schedule(); }, 15000); },
  async onPullDownRefresh() { try { await this.reload(); } finally { wx.stopPullDownRefresh(); } },
  render(view: SharedWork) { this.setData({ view: { ...view, tasks: view.tasks.map(t => ({ ...t, stateLabel: taskStateNames[t.state] ?? t.state, history: [...t.history].reverse() })),
    preparation: (view.preparation ?? []).map(p => ({ ...p, history: [...p.history].reverse() })), minutes: [...(view.minutes ?? [])].reverse() }, readyCount: (view.preparation ?? []).filter(p => p.done && p.assignee.active).length, fresh: true }); },
  switchTab(event: WechatMiniprogram.BaseEvent) { const tab = String(event.currentTarget.dataset.tab); if (!this.data.busy && !this.data.editor && ['tasks', 'preparation', 'minutes'].includes(tab)) this.setData({ tab }); },
  editPreparation(event: WechatMiniprogram.BaseEvent) {
    if (!this._visible || !this.data.fresh || this.data.busy || this.data.editor || !this.data.view?.canManage) return;
    const id = String(event.currentTarget.dataset.id ?? ''), item = this.data.view.preparation.find((p: SharedPreparation) => p.id === id);
    if (id && !item?.canEdit) return;
    this.setData({ editor: 'preparation', taskId: id, baseVersion: this.data.view.version, title: item?.title ?? '', details: item?.details ?? '', dueDate: item?.dueDate ?? this.data.view.dateFrom,
      assigneeIndex: Math.max(0, this.data.view.participants.findIndex((p: SharedPerson) => p.memberId === item?.assignee.memberId)), error: '' });
  },
  togglePreparation(event: WechatMiniprogram.BaseEvent) {
    if (!this._visible || !this.data.fresh || this.data.busy || this.data.editor || !this.data.view) return;
    const item = this.data.view.preparation.find((p: SharedPreparation) => p.id === event.currentTarget.dataset.id); if (!item?.canToggle) return;
    this.setData({ editor: 'prep-action', taskId: item.id, done: !item.done, note: '', action: 'preparation', actionLabel: item.done ? '撤回准备就绪' : '本人确认准备就绪', baseVersion: this.data.view.version, error: '' });
  },
  editMinutes() {
    if (!this._visible || !this.data.fresh || this.data.busy || this.data.editor || !this.data.view?.canManage) return;
    const latest: SharedMinutes | undefined = this.data.view.minutes[0];
    this.setData({ editor: 'minutes', baseVersion: this.data.view.version, meetingDate: latest?.date ?? this.data.view.dateFrom, summary: latest?.summary ?? '', decisions: latest?.decisions ?? '', nextSteps: latest?.nextSteps.map(s => s.text).join('\n') ?? '', error: '' });
  },
  previewAction(event: WechatMiniprogram.BaseEvent) {
    if (!this._visible || !this.data.fresh || this.data.busy || this.data.editor || !this.data.view?.canManage) return;
    const revision = Number(event.currentTarget.dataset.revision), stepIndex = Number(event.currentTarget.dataset.index);
    const item = this.data.view.minutes.find((m: SharedMinutes) => m.revision === revision)?.nextSteps.find((s: SharedMinutes['nextSteps'][number]) => s.index === stepIndex); if (!item?.canImport) return;
    this.setData({ editor: 'import', revision, stepIndex, baseVersion: this.data.view.version, title: item.text.slice(0, 60), details: item.text, dueDate: today(), assigneeIndex: 0, error: '' });
  },
  async reload() {
    if (!this._visible || !this.data.enabled || this.data.busy || this.data.loading) return;
    const epoch = ++this._epoch; this.setData({ loading: true, fresh: false, error: '' });
    try { const view = await getSharedWork(this.data.id); if (this._visible && epoch === this._epoch) this.render(view); }
    catch (error) { if (this._visible && epoch === this._epoch) this.setData({ error: errorMessage(error) }); }
    finally { if (!this._disposed && epoch === this._epoch) this.setData({ loading: false }); else if (!this._disposed) { this.setData({ loading: false }); if (this._visible) void this.reload(); } this.schedule(); }
  },
  edit(event: WechatMiniprogram.BaseEvent) {
    if (!this._visible || !this.data.fresh || this.data.busy || this.data.editor || !this.data.view?.canManage) return;
    const id = String(event.currentTarget.dataset.id ?? ''), task = this.data.view.tasks.find((t: SharedTask) => t.id === id);
    if (id && !task?.canEdit) return;
    this.setData({ editor: 'task', taskId: id, baseVersion: this.data.view.version, title: task?.title ?? '', details: task?.details ?? '', dueDate: task?.dueDate ?? today(),
      assigneeIndex: Math.max(0, this.data.view.participants.findIndex((p: SharedPerson) => p.memberId === task?.assignee.memberId)), error: '' });
  },
  act(event: WechatMiniprogram.BaseEvent) {
    if (!this._visible || !this.data.fresh || this.data.busy || this.data.editor || !this.data.view) return;
    const id = String(event.currentTarget.dataset.id), action = String(event.currentTarget.dataset.action), task = this.data.view.tasks.find((t: SharedTask) => t.id === id);
    if (!task) return;
    const permissions: Record<string, boolean> = { start: task.canStart, submit: task.canSubmit, accept: task.canVote, dispute: task.canVote, reopen: task.canReopen };
    if (!permissions[action]) return;
    const labels: Record<string, string> = { start: '开始执行', submit: '提交完成说明', accept: '我确认验收', dispute: '我有异议', reopen: '重新打开任务' };
    this.setData({ editor: 'action', taskId: id, action, actionLabel: labels[action], note: '', baseVersion: this.data.view.version, error: '' });
  },
  field(event: WechatMiniprogram.Input) { const key = String(event.currentTarget.dataset.field); if (!this.data.busy && ['title', 'details', 'dueDate', 'note', 'meetingDate', 'summary', 'decisions', 'nextSteps'].includes(key)) this.setData({ [key]: event.detail.value }); },
  assignee(event: WechatMiniprogram.PickerChange) { if (!this.data.busy) this.setData({ assigneeIndex: Number(event.detail.value) }); },
  cancel() { if (!this.data.busy) this.setData({ editor: '', note: '', error: '' }); },
  async save() {
    if (!this._visible || !this.data.fresh || this.data.busy || this.data.loading || !this.data.editor || !this.data.view) return;
    if (this.data.baseVersion !== this.data.view.version) { this.setData({ error: '伙伴已有新记录，请取消编辑，核对后重新操作。' }); return; }
    const data = this.data, epoch = ++this._epoch; this.setData({ busy: true, error: '' });
    try {
      const assignment = { version: data.baseVersion, dueDate: data.dueDate, assigneeMemberId: data.view!.participants[data.assigneeIndex]?.memberId };
      let view: SharedWork;
      if (data.editor === 'task') view = await saveSharedTask(data.id, data.taskId, { ...assignment, title: data.title, details: data.details });
      else if (data.editor === 'preparation') view = await saveSharedPreparation(data.id, data.taskId, { ...assignment, title: data.title, details: data.details });
      else if (data.editor === 'prep-action') view = await actSharedPreparation(data.id, data.taskId, { version: data.baseVersion, done: data.done, note: data.note });
      else if (data.editor === 'minutes') view = await saveSharedMinutes(data.id, { version: data.baseVersion, date: data.meetingDate, summary: data.summary, decisions: data.decisions, nextSteps: data.nextSteps });
      else if (data.editor === 'import') view = await importSharedAction(data.id, data.revision, data.stepIndex, assignment);
      else view = await actSharedTask(data.id, data.taskId, { version: data.baseVersion, action: data.action, note: data.note });
      if (this._visible && epoch === this._epoch) { this.render(view); this.setData({ editor: '', note: '', ...(data.editor === 'import' ? { tab: 'tasks' } : {}) }); wx.showToast({ title: '已记录本人操作', icon: 'success' }); }
    } catch (error) { if (this._visible && epoch === this._epoch) this.setData({ fresh: false, error: errorMessage(error) + '；请先刷新核对结果，再决定下一步。' }); }
    finally { if (!this._disposed) { this.setData({ busy: false }); if (this._visible && epoch !== this._epoch) void this.reload(); } this.schedule(); }
  },
});
