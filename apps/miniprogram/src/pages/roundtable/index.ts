import { Room, Availability, Proposal, cancelProposal, decideProposal, getRoom, isLocalRoomMode, loadAvailability, loadProposal, proposeSlot, roomAction } from '../../services/roundtables';
import { errorMessage, RequestError } from '../../services/secretary';

type Action = 'consent' | 'rotate' | 'close' | 'leave' | 'remove';
const withKeys = (proposal: Proposal): Proposal => ({ ...proposal, votes: proposal.votes.map((vote, index) => ({ ...vote, key: `${index}-${vote.name}` })) });
const denied = (error: unknown) => error instanceof RequestError && [401, 403, 404].includes(error.statusCode);
Page({
  data: {
    id: '', room: null as Room | null, loading: false, busy: false, error: '', local: isLocalRoomMode(), shareBusy: false, expiresLabel: '',
    availability: null as Availability | null, proposal: null as Proposal | null, finding: false,
    syncing: false, fresh: false, syncError: '', lastSync: '',
  },
  _visible: false, _disposed: false, _epoch: 0, _viewEpoch: 0, _failures: 0, _proposalSignature: '',
  _timer: undefined as ReturnType<typeof setTimeout> | undefined,
  onLoad(options: Record<string, string | undefined>) { this.setData({ id: options.id || '' }); },
  onShow() {
    this._visible = true; this._viewEpoch++;
    this.setData({ loading: false, finding: false, syncing: false, fresh: false }); void this.reload();
  },
  onHide() { this._visible = false; this._viewEpoch++; this._epoch++; this.stopRefresh(); },
  onUnload() { this.onHide(); this._disposed = true; },
  async onPullDownRefresh() {
    try { await this.reload(); } finally { wx.stopPullDownRefresh(); }
  },
  stopRefresh() { if (this._timer !== undefined) clearTimeout(this._timer); this._timer = undefined; },
  scheduleRefresh() {
    this.stopRefresh();
    if (!this._visible || this.data.local || this.data.room?.status !== 'OPEN') return;
    this._timer = setTimeout(() => {
      this._timer = undefined;
      if (this.data.busy || this.data.loading || this.data.finding || this.data.syncing) this.scheduleRefresh();
      else void this.readSnapshot(true);
    }, this._failures ? Math.min(30000, this._failures * 10000) : 5000);
  },
  async reload() {
    if (this.data.busy) return;
    this.setData({ error: '' });
    await this.readSnapshot(false);
  },
  async readSnapshot(silent: boolean) {
    if (!this.data.id || !this._visible) return;
    this.stopRefresh();
    const epoch = ++this._epoch;
    this.setData({ syncing: true, ...(!silent ? { loading: true, fresh: false, finding: false, availability: null } : {}) });
    try {
      const room = await getRoom(this.data.id);
      if (!this._visible || epoch !== this._epoch) return;
      const proposal = this.data.local ? null : await loadProposal(this.data.id);
      if (!this._visible || epoch !== this._epoch) return;
      const signature = JSON.stringify(proposal);
      const changed = room.version !== this.data.room?.version || signature !== this._proposalSignature;
      this._proposalSignature = signature; this._failures = 0;
      this.setData({ room, proposal: proposal ? withKeys(proposal) : null, shareBusy: room.members.find(member => member.isMe)?.shareBusy || false,
        expiresLabel: room.inviteExpiresAt ? new Date(Date.parse(room.inviteExpiresAt) + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ') : '',
        fresh: true, syncError: '', lastSync: new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 19),
        ...(changed ? { availability: null } : {}),
      });
    } catch (error) {
      if (!this._visible || epoch !== this._epoch) return;
      this._failures++;
      this.setData({ fresh: false, syncError: errorMessage(error), availability: null,
        ...(denied(error) ? { room: null, proposal: null, shareBusy: false, expiresLabel: '', lastSync: '' } : {}),
      });
    } finally {
      if (this._visible && epoch === this._epoch) {
        this.setData({ syncing: false, loading: false }); this.scheduleRefresh();
      }
    }
  },
  lock() {
    if (!this._visible || this.data.busy || this.data.loading || this.data.finding || !this.data.fresh) return false;
    // 写操作开始后，之前发出的只读响应不得覆盖新的结果。
    this._epoch++; this.stopRefresh(); this.setData({ busy: true, syncing: false, error: '' }); return true;
  },
  unlock() {
    if (!this._disposed) {
      this.setData({ busy: false });
      if (this._visible && !this.data.fresh && !this.data.syncError) void this.readSnapshot(false);
      else this.scheduleRefresh();
    }
  },
  async mutate(work: () => Promise<unknown>, leave = false) {
    const viewEpoch = this._viewEpoch;
    try {
      await work();
      if (!this._visible || viewEpoch !== this._viewEpoch) return;
      if (leave) { this.setData({ room: null, proposal: null, availability: null, fresh: false }); wx.navigateBack(); }
      else await this.readSnapshot(false);
    } catch (error) {
      if (!this._visible || viewEpoch !== this._viewEpoch) return;
      // 网络超时不等于后台未执行；只重新读取结果，绝不自动重放写入。
      await this.readSnapshot(false);
      if (this._visible && viewEpoch === this._viewEpoch) this.setData({ error: error instanceof RequestError && error.statusCode === 0
        ? '未收到操作结果，已尝试刷新。请查看当前状态后再操作。' : errorMessage(error) });
    } finally { this.unlock(); }
  },
  consent() {
    if (this.lock()) void this.mutate(() => roomAction(this.data.id, 'consent', !this.data.shareBusy));
  },
  copyCode() {
    if (this.data.fresh && this.data.room?.inviteCode) wx.setClipboardData({ data: this.data.room.inviteCode, fail: () => this.setData({ error: '未能复制，请重试' }) });
  },
  confirmWork(title: string, content: string, work: () => Promise<unknown>, leave = false) {
    if (!this.lock()) return;
    const viewEpoch = this._viewEpoch;
    wx.showModal({ title, content,
      success: result => {
        if (result.confirm && this._visible && viewEpoch === this._viewEpoch) void this.mutate(work, leave);
        else this.unlock();
      },
      fail: () => { if (!this._disposed) this.setData({ error: '未能打开确认窗口，请重试' }); this.unlock(); },
    });
  },
  confirm(action: Action, content: string, value?: string) {
    this.confirmWork('确认操作', content, () => roomAction(this.data.id, action, value), action === 'leave');
  },
  rotate() { this.confirm('rotate', '更新后旧邀请码立即失效，已加入的成员不受影响。'); },
  closeRoom() { this.confirm('close', '关闭后不能再加入或修改授权，所有忙闲授权会撤回，记录仍可查看。'); },
  leave() { this.confirm('leave', '退出后不能再查看圆桌，本次忙闲授权会删除。'); },
  remove(e: WechatMiniprogram.TouchEvent) { this.confirm('remove', '移除该成员并更新邀请码，旧邀请码立即失效。', String(e.currentTarget.dataset.id)); },
  async findTime() {
    if (this.data.busy || this.data.loading || this.data.finding || !this.data.fresh || !this._visible) return;
    this.stopRefresh(); const epoch = ++this._epoch;
    this.setData({ finding: true, syncing: false, error: '', availability: null });
    try {
      const view = await loadAvailability(this.data.id);
      if (this._visible && epoch === this._epoch) this.setData({ availability: { ...view, slots: view.slots.map(slot => ({ ...slot, key: `${slot.date} ${slot.startTime}` })) } });
    } catch (error) {
      if (this._visible && epoch === this._epoch) {
        this.setData({ error: errorMessage(error) }); await this.readSnapshot(false);
      }
    } finally {
      if (!this._disposed && this._visible && epoch === this._epoch) { this.setData({ finding: false }); this.scheduleRefresh(); }
    }
  },
  chooseSlot(e: WechatMiniprogram.TouchEvent) {
    const slot = this.data.availability?.slots[Number(e.currentTarget.dataset.index)];
    if (!slot) return;
    this.confirmWork('提出这个时间', `${slot.date} ${slot.startTime}–${slot.endTime}\n全员接受后，会写入各自的日程。`, () => proposeSlot(this.data.id, slot));
  },
  decide(e: WechatMiniprogram.TouchEvent) {
    const decision = String(e.currentTarget.dataset.decision) === 'REJECT' ? 'REJECT' : 'ACCEPT';
    const proposal = this.data.proposal;
    if (!proposal || proposal.status !== 'OPEN' || proposal.stale) return;
    this.confirmWork(decision === 'ACCEPT' ? '接受方案' : '拒绝方案', decision === 'ACCEPT'
      ? `接受 ${proposal.date} ${proposal.startTime}–${proposal.endTime}？\n全员接受后会写入你的日程。` : '拒绝这个时间？其他人需要重新协商。',
      () => decideProposal(this.data.id, proposal.id, decision));
  },
  cancelProposal() {
    const proposal = this.data.proposal;
    if (!proposal?.createdByMe || proposal.status !== 'OPEN') return;
    this.confirmWork('撤回这个方案？', '撤回后不再接受确认，也不会写入日程。你可以重新计算并提出方案。', () => cancelProposal(this.data.id, proposal.id));
  },
});
