import { getRoom, isLocalRoomMode, Room } from '../../services/roundtables';
import { errorMessage, today } from '../../services/secretary';
import { MeetingWork, WorkTask, ActionCandidate, taskLabels, getMeetingWork, saveTask, changeTask, savePreparation,
  togglePreparation, addPreparationTemplate, saveMinutes, actionCandidates, importActions } from '../../services/meeting-work';
const labels: Record<string, string> = { start: '开始执行', submit: '提交完成说明', accept: '记录验收通过', reopen: '重新打开任务' };
Page({
  data: {
    id: '', local: isLocalRoomMode(), room: null as Room | null, work: null as MeetingWork | null,
    tab: 'tasks', tabs: [{ id: 'tasks', name: '补救任务' }, { id: 'prep', name: '会前清单' }, { id: 'minutes', name: '会议纪要' }],
    loading: false, busy: false, fresh: false, error: '', editor: '', editId: '', baseVersion: 0,
    title: '', owner: '本人', dueDate: today(), details: '', meetingDate: today(), summary: '', decisions: '', nextSteps: '',
    tasks: [] as object[], preparation: [] as object[], minutes: [] as object[], showHistory: false,
    counts: { tasks: 0, done: 0, overdue: 0, prep: 0, ready: 0 },
    actionId: '', action: '', actionLabel: '', actionNote: '', importKind: '', candidates: [] as ActionCandidate[],
  },
  _visible: false, _disposed: false, _epoch: 0,
  onLoad(options: Record<string, string | undefined>) { this.setData({ id: options.id ?? '', tab: ['tasks', 'prep', 'minutes'].includes(options.tab ?? '') ? options.tab : 'tasks' }); },
  onShow() { this._visible = true; void this.reload(); },
  onHide() { this._visible = false; this._epoch++; this.setData({ fresh: false }); },
  onUnload() { this.onHide(); this._disposed = true; },
  async onPullDownRefresh() { try { await this.reload(); } finally { wx.stopPullDownRefresh(); } },
  render(work: MeetingWork) {
    const day = today();
    this.setData({ work, tasks: work.tasks.map(task => ({ ...task, stateLabel: taskLabels[task.state], overdue: task.state !== 'DONE' && task.dueDate < day,
      history: [...task.history].reverse().map((event, index) => ({ ...event, key: index, time: new Date(new Date(event.at).getTime() + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ') })) })),
      preparation: work.preparation.map(item => ({ ...item, overdue: !item.done && item.dueDate < day })),
      minutes: this.data.showHistory ? [...work.minutes].reverse() : work.minutes.slice(-1),
      counts: { tasks: work.tasks.length, done: work.tasks.filter(task => task.state === 'DONE').length,
        overdue: work.tasks.filter(task => task.state !== 'DONE' && task.dueDate < day).length,
        prep: work.preparation.length, ready: work.preparation.filter(item => item.done).length } });
  },
  ready() { return this._visible && this.data.local && this.data.fresh && !this.data.loading && !this.data.busy; },
  async reload() {
    if (!this._visible || this.data.busy || !this.data.local) return;
    const epoch = ++this._epoch; this.setData({ loading: true, fresh: false, error: '' });
    try {
      const [room, work] = await Promise.all([getRoom(this.data.id), getMeetingWork(this.data.id)]);
      if (this._visible && epoch === this._epoch) { this.setData({ room, fresh: true }); this.render(work); }
    } catch (error) { if (this._visible && epoch === this._epoch) this.setData({ error: errorMessage(error) }); }
    finally { if (this._visible && epoch === this._epoch) this.setData({ loading: false }); }
  },
  onTab(event: WechatMiniprogram.TouchEvent) {
    const tab = String(event.currentTarget.dataset.tab);
    if (this.data.busy || this.data.editor || this.data.actionId || this.data.importKind || !['tasks', 'prep', 'minutes'].includes(tab)) return;
    this.setData({ tab, error: '' });
  },
  onField(event: WechatMiniprogram.Input) {
    const field = String(event.currentTarget.dataset.field);
    if (this.data.busy || !['title', 'owner', 'dueDate', 'details', 'meetingDate', 'summary', 'decisions', 'nextSteps', 'actionNote'].includes(field)) return;
    this.setData({ [field]: event.detail.value });
  },
  edit(event: WechatMiniprogram.TouchEvent) {
    if (!this.ready() || this.data.editor || this.data.actionId || this.data.importKind || !this.data.work) return;
    const kind = String(event.currentTarget.dataset.kind), editId = String(event.currentTarget.dataset.id ?? ''), work: MeetingWork = this.data.work;
    if (!['task', 'prep', 'minutes'].includes(kind)) return;
    if (kind === 'minutes') {
      const latest = work.minutes[work.minutes.length - 1];
      this.setData({ meetingDate: latest?.date ?? this.data.room!.dateFrom, summary: latest?.summary ?? '', decisions: latest?.decisions ?? '', nextSteps: latest?.nextSteps ?? '' });
    } else {
      const item = kind === 'task' ? work.tasks.find(task => task.id === editId) : work.preparation.find(entry => entry.id === editId);
      if (editId && !item) return;
      if (kind === 'task' && item && ['REVIEW', 'DONE'].includes((item as WorkTask).state)) return;
      this.setData({ title: item?.title ?? '', owner: item?.owner ?? '本人', dueDate: item?.dueDate ?? this.data.room!.dateFrom,
        details: item ? ('details' in item ? item.details : item.note) : '' });
    }
    this.setData({ editor: kind, editId, baseVersion: work.version, error: '' });
  },
  cancel() { if (!this.data.busy) this.setData({ editor: '', actionId: '', action: '', actionNote: '', importKind: '', candidates: [] }); },
  currentForm() {
    if (this.data.baseVersion !== this.data.work?.version) { this.setData({ error: '已有新记录，填写内容仍保留。请取消当前操作，核对最新版本后重开表单。' }); return false; }
    return true;
  },
  async submit() {
    if (!this.ready() || !this.data.editor || !this.currentForm()) return;
    const { id, baseVersion, editor, editId, title, owner, dueDate, details, meetingDate, summary, decisions, nextSteps } = this.data;
    await this.write(() => editor === 'task' ? saveTask(id, baseVersion, { title, owner, dueDate, details }, editId)
      : editor === 'prep' ? savePreparation(id, baseVersion, { title, owner, dueDate, note: details }, editId)
        : saveMinutes(id, baseVersion, { date: meetingDate, summary, decisions, nextSteps }));
  },
  taskAction(event: WechatMiniprogram.TouchEvent) {
    if (!this.ready() || this.data.editor || this.data.importKind || this.data.actionId) return;
    const action = String(event.currentTarget.dataset.action), id = String(event.currentTarget.dataset.id);
    if (!labels[action] || !this.data.work?.tasks.some((task: WorkTask) => task.id === id)) return;
    this.setData({ actionId: id, action, actionLabel: labels[action], actionNote: '', baseVersion: this.data.work.version, error: '' });
  },
  async submitAction() {
    if (!this.ready() || !this.data.actionId || !this.currentForm()) return;
    const { id, baseVersion, actionId, action, actionNote } = this.data;
    await this.write(() => changeTask(id, baseVersion, actionId, action, actionNote));
  },
  async togglePrep(event: WechatMiniprogram.TouchEvent) {
    if (!this.ready() || this.data.editor) return;
    await this.write(() => togglePreparation(this.data.id, this.data.work!.version, String(event.currentTarget.dataset.id)));
  },
  async addTemplate() {
    if (!this.ready() || this.data.editor) return;
    await this.write(() => addPreparationTemplate(this.data.id, this.data.work!.version, this.data.room!.dateFrom));
  },
  toggleHistory() { this.setData({ showHistory: !this.data.showHistory }); if (this.data.work) this.render(this.data.work); },
  async previewImport(event: WechatMiniprogram.TouchEvent) {
    if (!this.ready() || this.data.editor || this.data.actionId || this.data.importKind) return;
    const kind = String(event.currentTarget.dataset.kind); if (kind !== 'review' && kind !== 'minutes') return;
    const epoch = ++this._epoch; this.setData({ busy: true, error: '' });
    try {
      const candidates = await actionCandidates(this.data.id, kind);
      if (!this._visible || epoch !== this._epoch) return;
      const pending = candidates.filter(item => !this.data.work!.tasks.some((task: WorkTask) => task.source === item.source));
      this.setData({ candidates: pending, importKind: pending.length ? kind : '', dueDate: today(), baseVersion: this.data.work!.version,
        error: pending.length ? '' : '没有可转入的新事项。先保存复盘补救或纪要后续行动；同一版本的事项不会重复导入。' });
    } catch (error) { if (this._visible && epoch === this._epoch) this.setData({ error: errorMessage(error) }); }
    finally { if (!this._disposed) { this.setData({ busy: false }); if (this._visible && epoch !== this._epoch) void this.reload(); } }
  },
  async submitImport() {
    if (!this.ready() || !this.data.importKind || !this.currentForm()) return;
    const { id, baseVersion, importKind, candidates, dueDate } = this.data;
    await this.write(() => importActions(id, baseVersion, importKind as 'review' | 'minutes', candidates.map((item: ActionCandidate) => item.source), dueDate));
  },
  async write(operation: () => Promise<MeetingWork>) {
    const epoch = ++this._epoch; this.setData({ busy: true, error: '' });
    try {
      const work = await operation(); if (!this._visible || epoch !== this._epoch) return;
      this.setData({ editor: '', actionId: '', actionNote: '', importKind: '', candidates: [], fresh: true }); this.render(work);
      wx.showToast({ title: '本机记录已保存', icon: 'success' });
    } catch (error) { if (this._visible && epoch === this._epoch) this.setData({ fresh: false, error: `${errorMessage(error)} 填写内容已保留，请刷新核对后重试。` }); }
    finally { if (!this._disposed) { this.setData({ busy: false }); if (this._visible && epoch !== this._epoch) void this.reload(); } }
  },
});
