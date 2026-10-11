import { getRoom, isLocalRoomMode, Room } from '../../services/roundtables';
import { errorMessage, RequestError, today } from '../../services/secretary';
import { getReview, saveReview, voteReview, ReviewInput, ReviewView, validateReview } from '../../services/reviews';
const statuses = { DRAFT: '本机草稿', PENDING: '待逐人确认', DISPUTED: '存在异议', AGREED: '已达成共识' };
const decisions = { PENDING: '待表态', ACCEPT: '已确认', DISPUTE: '有异议' };
type FormRow = { memberId: string; name: string; percent: string; reason: string; action: string };
const integer = (value: string) => /^\d{1,3}$/.test(value) ? Number(value) : NaN;
Page({
  data: {
    id: '', room: null as Room | null, view: null as ReviewView | null, local: isLocalRoomMode(),
    loading: false, busy: false, fresh: false, error: '', editor: false, showHistory: false,
    date: '', outcomes: ['未能举办', '已取消'], outcomeIndex: 0, facts: '', rows: [] as FormRow[],
    externalPercent: '0', externalReason: '', unassignedPercent: '100', total: 100, baseVersion: 0, comment: '',
    display: [] as object[], currentStatus: '', today: today(),
  },
  _visible: false, _disposed: false, _epoch: 0,
  onLoad(options: Record<string, string | undefined>) { this.setData({ id: options.id || '' }); },
  openWork() { if (this._visible && this.data.local && this.data.room && !this.data.busy && !this.data.editor) wx.navigateTo({ url: `/pages/meeting-work/index?id=${encodeURIComponent(this.data.id)}&tab=tasks` }); },
  onShow() { this._visible = true; void this.reload(); },
  onHide() { this._visible = false; this._epoch++; this.setData({ fresh: false }); },
  onUnload() { this.onHide(); this._disposed = true; },
  async onPullDownRefresh() { try { await this.reload(); } finally { wx.stopPullDownRefresh(); } },
  render(view: ReviewView) {
    const names = new Map(view.participants.map(p => [p.memberId, p.name + (p.isMe ? '（我）' : '') + (p.active ? '' : '（已离开圆桌）')]));
    const revisions = this.data.showHistory ? [...view.revisions].reverse() : view.revisions.slice(-1);
    this.setData({ view, currentStatus: view.revisions.length ? statuses[view.revisions[view.revisions.length - 1].status] : '尚未记录',
      display: revisions.map(revision => ({ ...revision, statusLabel: statuses[revision.status],
        allocations: revision.allocations.map(row => ({ ...row, name: names.get(row.memberId) })),
        votes: revision.votes.map(row => ({ ...row, name: names.get(row.memberId), label: decisions[row.decision] })),
        events: revision.events.map((row, index) => ({ ...row, key: index, name: names.get(row.memberId), label: decisions[row.decision],
          time: row.decidedAt ? new Date(new Date(row.decidedAt).getTime() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ') : '' })),
      })) });
  },
  async reload() {
    if (!this._visible || this.data.busy) return;
    const epoch = ++this._epoch; this.setData({ loading: true, fresh: false, error: '' });
    try {
      const [room, view] = await Promise.all([getRoom(this.data.id), getReview(this.data.id)]);
      if (!this._visible || epoch !== this._epoch) return;
      this.setData({ room, fresh: true }); this.render(view);
    } catch (error) {
      if (this._visible && epoch === this._epoch) {
        this.setData({ error: errorMessage(error) });
        if (error instanceof RequestError && [401, 403, 404].includes(error.statusCode)) this.setData({ room: null, view: null, display: [], editor: false, facts: '', rows: [], comment: '', externalReason: '' });
      }
    } finally { if (this._visible && epoch === this._epoch) this.setData({ loading: false }); }
  },
  toggleHistory() { this.setData({ showHistory: !this.data.showHistory }); if (this.data.view) this.render(this.data.view); },
  edit() {
    if (!this._visible || !this.data.fresh || this.data.busy || this.data.loading || !this.data.view?.canEdit) return;
    const view: ReviewView = this.data.view, latest = view.revisions[view.revisions.length - 1];
    this.setData({ editor: true, baseVersion: view.version, date: latest?.date ?? this.data.room?.dateFrom ?? today(),
      outcomeIndex: latest?.outcome === 'CANCELLED' ? 1 : 0, facts: latest?.facts ?? '',
      rows: view.participants.map(p => { const row = latest?.allocations.find(a => a.memberId === p.memberId);
        return { memberId: p.memberId, name: p.name, percent: String(row?.percent ?? 0), reason: row?.reason ?? '', action: row?.action ?? '' }; }),
      externalPercent: String(latest?.externalPercent ?? 0), externalReason: latest?.externalReason ?? '', unassignedPercent: String(latest?.unassignedPercent ?? 100), total: 100, error: '' });
  },
  cancelEdit() { if (!this.data.busy) this.setData({ editor: false }); },
  onField(event: WechatMiniprogram.Input) {
    if (this.data.busy) return;
    const field = String(event.currentTarget.dataset.field);
    if (!['date', 'facts', 'externalPercent', 'externalReason', 'unassignedPercent', 'comment'].includes(field)) return;
    this.setData({ [field]: event.detail.value }); this.updateTotal();
  },
  onOutcome(event: WechatMiniprogram.PickerChange) { if (!this.data.busy) this.setData({ outcomeIndex: Number(event.detail.value) === 1 ? 1 : 0 }); },
  onRow(event: WechatMiniprogram.Input) {
    if (this.data.busy) return;
    const { id, field } = event.currentTarget.dataset;
    if (!['percent', 'reason', 'action'].includes(String(field))) return;
    this.setData({ rows: this.data.rows.map((row: FormRow) => row.memberId === id ? { ...row, [String(field)]: event.detail.value } : row) }); this.updateTotal();
  },
  updateTotal() {
    const numbers = [...this.data.rows.map((row: FormRow) => integer(row.percent)), integer(this.data.externalPercent), integer(this.data.unassignedPercent)];
    this.setData({ total: numbers.some(Number.isNaN) ? '待补全' : numbers.reduce((sum: number, n: number) => sum + n, 0) });
  },
  async submit() {
    if (!this.data.editor || !this.data.fresh || this.data.loading || this.data.busy || !this._visible) return;
    if (this.data.baseVersion !== this.data.view?.version) { this.setData({ error: '复盘已有更新，请取消编辑并核对最新版本后再修订' }); return; }
    const input: ReviewInput = { version: this.data.baseVersion, date: this.data.date, outcome: this.data.outcomeIndex ? 'CANCELLED' : 'NOT_HELD', facts: this.data.facts.trim(),
      allocations: this.data.rows.map((row: FormRow) => ({ memberId: row.memberId, percent: integer(row.percent), reason: row.reason.trim(), action: row.action.trim() })),
      externalPercent: integer(this.data.externalPercent), externalReason: this.data.externalReason.trim(), unassignedPercent: integer(this.data.unassignedPercent) };
    const error = validateReview(input); if (error) { this.setData({ error }); return; }
    await this.write(() => saveReview(this.data.id, input), true);
  },
  async vote(event: WechatMiniprogram.TouchEvent) {
    if (!this.data.view?.canVote || this.data.local || this.data.editor || !this.data.fresh || this.data.loading || this.data.busy || !this._visible) return;
    const decision = event.currentTarget.dataset.decision;
    if (decision !== 'ACCEPT' && decision !== 'DISPUTE') return;
    const comment = this.data.comment.trim();
    if (comment.length > 500 || (decision === 'DISPUTE' && !comment)) { this.setData({ error: '提出异议时请填写理由，不超过 500 字' }); return; }
    await this.write(() => voteReview(this.data.id, this.data.view!.version, decision, comment), false);
  },
  async write(operation: () => Promise<ReviewView>, editing: boolean) {
    const epoch = ++this._epoch; this.setData({ busy: true, error: '' });
    try {
      const view = await operation();
      if (!this._visible || epoch !== this._epoch) return;
      this.setData({ editor: editing ? false : this.data.editor, comment: '', fresh: true }); this.render(view);
      wx.showToast({ title: this.data.local ? '复盘草稿已保存' : '复盘已更新', icon: 'success' });
    } catch (error) {
      if (this._visible && epoch === this._epoch) this.setData({ fresh: false, error: `${errorMessage(error)} 请先刷新核对结果；不会自动重复提交，填写内容已保留。` });
    } finally {
      if (!this._disposed) {
        this.setData({ busy: false });
        if (this._visible && epoch !== this._epoch) void this.reload();
      }
    }
  },
});
