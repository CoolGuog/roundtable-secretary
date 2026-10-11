import { Room, Availability, Proposal, Slot, cancelProposal, decideProposal, getRoom, isLocalRoomMode, loadAvailability, loadProposal, proposeSlot, roomAction } from '../../services/roundtables';
import { errorMessage } from '../../services/secretary';
type Action = 'consent' | 'rotate' | 'close' | 'leave' | 'remove';
/** 同名成员也能安全作为列表 key */
type PageProposal = Proposal & { myDecision: 'PENDING' | 'ACCEPT' | 'REJECT' };
const withKeys = (proposal: Proposal): PageProposal => ({ ...proposal,
  myDecision: proposal.votes.find(vote => vote.isMe)?.decision ?? 'PENDING',
  votes: proposal.votes.map((vote, index) => ({ ...vote, key: `${index}-${vote.name}` })) });
Page({
  data: {
    id: '', room: null as Room | null, loading: false, busy: false, error: '', local: isLocalRoomMode(), shareBusy: false, expiresLabel: '',
    availability: null as Availability | null, proposal: null as PageProposal | null, finding: false,
    manualDate: '', manualStart: '', manualEnd: '', manualNotice: '', toastMessage: '',
  },
  toastTimer: null as ReturnType<typeof setTimeout> | null,
  notify(message: string, isError = true) {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.setData({ error: isError ? message : '', toastMessage: message });
    this.toastTimer = setTimeout(() => { this.setData({ toastMessage: '' }); this.toastTimer = null; }, 2000);
  },
  clearToast() {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = null;
    this.setData({ toastMessage: '' });
  },
  onHide() { this.clearToast(); },
  onUnload() { this.clearToast(); },
  onLoad(options: Record<string, string | undefined>) { this.setData({ id: options.id || '' }); },
  onShow() { void this.reload(); },
  async reload() {
    if (!this.data.id) return;
    this.setData({ loading: true, room: null, error: '', shareBusy: false, availability: null, proposal: null });
    try {
      const room = await getRoom(this.data.id);
      this.setData({ room, shareBusy: room.members.find(member => member.isMe)?.shareBusy || false,
        ...this.defaultManual(room),
        expiresLabel: room.inviteExpiresAt ? new Date(Date.parse(room.inviteExpiresAt) + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ') : '' });
      await this.refreshProposal();
    } catch (error) { this.notify(errorMessage(error)); }
    finally { this.setData({ loading: false }); }
  },
  async refreshProposal() {
    if (this.data.local || !this.data.room) return;
    try { const proposal = await loadProposal(this.data.id); this.setData({ proposal: proposal ? withKeys(proposal) : null }); }
    catch (error) { this.setData({ proposal: null }); this.notify(errorMessage(error)); }
  },
  async perform(action: Action, value?: boolean | string) {
    this.setData({ busy: true, error: '' });
    try {
      await roomAction(this.data.id, action, value);
      if (action === 'leave') { this.setData({ room: null }); wx.navigateBack(); }
      else await this.reload();
    } catch (error) {
      // 重新读取权限和成员状态，避免被移除后继续显示旧房间。
      await this.reload(); this.notify(errorMessage(error));
    } finally { this.setData({ busy: false }); }
  },
  consent() { if (!this.data.busy && !this.data.loading) void this.perform('consent', !this.data.shareBusy); },
  copyCode() {
    if (this.data.room?.inviteCode) wx.setClipboardData({ data: this.data.room.inviteCode, fail: () => this.notify('未能复制，请重试') });
  },
  confirm(action: Action, content: string, value?: string) {
    if (this.data.busy || this.data.loading) return;
    this.setData({ busy: true });
    wx.showModal({ title: '确认操作', content,
      success: result => { if (result.confirm) void this.perform(action, value); else this.setData({ busy: false }); },
      fail: () => { this.setData({ busy: false }); this.notify('未能打开确认窗口，请重试'); },
    });
  },
  rotate() { this.confirm('rotate', '更新后旧邀请码立即失效，已加入的成员不受影响。'); },
  closeRoom() { this.confirm('close', '关闭后不能再加入或修改授权，所有忙闲授权会撤回，记录仍可查看。'); },
  leave() { this.confirm('leave', '退出后不能再查看圆桌，本次忙闲授权会删除。'); },
  remove(e: WechatMiniprogram.TouchEvent) { this.confirm('remove', '移除该成员并更新邀请码，旧邀请码立即失效。', String(e.currentTarget.dataset.id)); },

  // ---- 第 15 步：共同可用时间 ----
  async findTime() {
    if (this.data.busy || this.data.loading || this.data.finding) return;
    this.setData({ finding: true, error: '' });
    try {
      const view = await loadAvailability(this.data.id);
      this.setData({ availability: { ...view, slots: view.slots.map(slot => ({ ...slot, key: `${slot.date} ${slot.startTime}` })) } });
      if (view.reason) this.notify(view.reason);
    } catch (error) { this.notify(errorMessage(error)); }
    finally { this.setData({ finding: false }); }
  },
  chooseSlot(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.loading) return;
    const slot = this.data.availability?.slots[Number(e.currentTarget.dataset.index)];
    if (!slot) return;
    this.confirmSlot({ date: slot.date, startTime: slot.startTime, endTime: slot.endTime });
  },
  endFor(start: string, duration: number) {
    const minutes = Number(start.slice(0, 2)) * 60 + Number(start.slice(3)) + duration;
    return minutes < 1440 ? `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` : '';
  },
  defaultManual(room: Room, selectedDate?: string, now = Date.now()) {
    const today = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
    let date = selectedDate ?? (room.dateFrom > today ? room.dateFrom : today);
    const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    const startFor = (day: string) => {
      if (day < today) return 1440;
      const currentMinute = (now - Date.parse(`${today}T00:00:00+08:00`)) / 60_000;
      const rounded = Math.max(minutes(room.startTime), day === today ? Math.ceil((currentMinute + 1) / 30) * 30 : 0);
      // 若半小时整点放不下，仍可默认选择下一分钟，避免把可用的短窗口判为已结束。
      return rounded + room.durationMinutes <= minutes(room.endTime) ? rounded
        : Math.max(minutes(room.startTime), day === today ? Math.floor(currentMinute) + 1 : 0);
    };
    let start = startFor(date);
    if (!selectedDate && start + room.durationMinutes > minutes(room.endTime)) {
      const tomorrow = new Date(Date.parse(`${date}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
      if (tomorrow <= room.dateTo) { date = tomorrow; start = startFor(date); }
    }
    if (date > room.dateTo || start + room.durationMinutes > minutes(room.endTime)) {
      return { manualDate: date > room.dateTo ? room.dateTo : date, manualStart: '', manualEnd: '', manualNotice: '这个日期已没有足够的未来时间，请选择更晚的日期；超出圆桌范围时需新建圆桌。' };
    }
    const time = `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`;
    return { manualDate: date, manualStart: time, manualEnd: this.endFor(time, room.durationMinutes), manualNotice: '' };
  },
  onManualDate(e: WechatMiniprogram.PickerChange) { this.setData(this.defaultManual(this.data.room!, String(e.detail.value))); },
  onManualStart(e: WechatMiniprogram.PickerChange) {
    const start = String(e.detail.value);
    this.setData({ manualStart: start, manualEnd: this.endFor(start, this.data.room!.durationMinutes), manualNotice: '' });
  },
  onManualEnd(e: WechatMiniprogram.PickerChange) { this.setData({ manualEnd: String(e.detail.value) }); },
  chooseManual() {
    const room = this.data.room;
    if (!room || room.status !== 'OPEN' || this.data.local || this.data.busy || this.data.loading || this.data.finding) return;
    const slot = { date: this.data.manualDate, startTime: this.data.manualStart, endTime: this.data.manualEnd };
    if ((!slot.startTime || !slot.endTime) && this.data.manualNotice) { this.notify(this.data.manualNotice); return; }
    const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    if (!slot.date || !slot.startTime || !slot.endTime || slot.date < room.dateFrom || slot.date > room.dateTo ||
      slot.startTime < room.startTime || slot.endTime > room.endTime || slot.endTime <= slot.startTime ||
      minutes(slot.endTime) - minutes(slot.startTime) !== room.durationMinutes) {
      this.notify(`请选择圆桌日期和每天时间窗口内的时段，活动时长须为 ${room.durationMinutes} 分钟。`); return;
    }
    if (Date.parse(`${slot.date}T${slot.startTime}:00+08:00`) <= Date.now()) {
      this.notify('请选择尚未开始的活动时间（北京时间），已过去的时间不能用于提案'); return;
    }
    this.confirmSlot(slot);
  },
  confirmSlot(slot: Slot) {
    this.setData({ busy: true });
    wx.showModal({ title: '提出这个时间', content: `${slot.date} ${slot.startTime}–${slot.endTime}\n全员接受后，会新增或更新本活动日程。`,
      success: result => { if (result.confirm) void this.propose(slot); else this.setData({ busy: false }); },
      fail: () => { this.setData({ busy: false }); this.notify('未能打开确认窗口，请重试'); },
    });
  },
  async propose(slot: Slot) {
    this.setData({ busy: true, error: '' });
    try {
      this.setData({ proposal: withKeys(await proposeSlot(this.data.id, slot)), availability: null });
    } catch (error) { this.notify(errorMessage(error)); void this.refreshProposal(); }
    finally { this.setData({ busy: false }); }
  },
  // ---- 第 16 步：全员确认后写入日程 ----
  decide(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.loading) return;
    const decision = String(e.currentTarget.dataset.decision) === 'REJECT' ? 'REJECT' : 'ACCEPT';
    const proposal = this.data.proposal;
    if (!proposal || proposal.status !== 'OPEN' || proposal.stale) return;
    if (decision === 'ACCEPT' && proposal.myDecision === 'ACCEPT') return;
    this.setData({ busy: true });
    const content = decision === 'ACCEPT'
      ? `接受 ${proposal.date} ${proposal.startTime}–${proposal.endTime}？\n全员接受后会写入你的日程。`
      : `拒绝这个时间？其他人需要重新协商。`;
    wx.showModal({ title: decision === 'ACCEPT' ? '接受方案' : '拒绝方案', content,
      success: result => { if (result.confirm) void this.submit(proposal.id, decision); else this.setData({ busy: false }); },
      fail: () => { this.setData({ busy: false }); this.notify('未能打开确认窗口，请重试'); },
    });
  },
  async submit(proposalId: string, decision: 'ACCEPT' | 'REJECT') {
    this.setData({ busy: true, error: '' });
    try {
      const proposal = withKeys(await decideProposal(this.data.id, proposalId, decision));
      this.setData({ proposal, availability: null });
      if (proposal.status === 'CONFIRMED') this.notify('全员已接受，已更新各自日程', false);
      else if (decision === 'ACCEPT') this.notify('你已接受，等待其他成员确认', false);
      else this.notify('你已拒绝，可以重新提出时间', false);
    } catch (error) { this.notify(errorMessage(error)); void this.refreshProposal(); }
    finally { this.setData({ busy: false }); }
  },
  cancelProposal() {
    if (this.data.busy || this.data.loading || !this.data.proposal?.createdByMe) return;
    const id = this.data.proposal.id;
    this.setData({ busy: true });
    wx.showModal({ title: '撤回这个方案？', content: '撤回后不再接受确认，也不会写入日程。你可以重新计算并提出方案。',
      success: async result => {
        try {
          if (!result.confirm) return;
          this.setData({ error: '', proposal: withKeys(await cancelProposal(this.data.id, id)), availability: null });
        } catch (error) { this.notify(errorMessage(error)); await this.refreshProposal(); }
        finally { this.setData({ busy: false }); }
      }, fail: () => { this.setData({ busy: false }); this.notify('未能打开确认窗口，请重试'); },
    });
  },
});
