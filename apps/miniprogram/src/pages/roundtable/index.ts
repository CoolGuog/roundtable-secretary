import { Room, Availability, Proposal, Slot, cancelProposal, decideProposal, getRoom, isLocalRoomMode, loadAvailability, loadProposal, proposeSlot, roomAction } from '../../services/roundtables';
import { errorMessage } from '../../services/secretary';
type Action = 'consent' | 'rotate' | 'close' | 'leave' | 'remove';
/** 同名成员也能安全作为列表 key */
const withKeys = (proposal: Proposal): Proposal => ({ ...proposal, votes: proposal.votes.map((vote, index) => ({ ...vote, key: `${index}-${vote.name}` })) });
Page({
  data: {
    id: '', room: null as Room | null, loading: false, busy: false, error: '', local: isLocalRoomMode(), shareBusy: false, expiresLabel: '',
    availability: null as Availability | null, proposal: null as Proposal | null, finding: false,
  },
  onLoad(options: Record<string, string | undefined>) { this.setData({ id: options.id || '' }); },
  onShow() { void this.reload(); },
  async reload() {
    if (!this.data.id) return;
    this.setData({ loading: true, room: null, error: '', shareBusy: false, availability: null, proposal: null });
    try {
      const room = await getRoom(this.data.id);
      this.setData({ room, shareBusy: room.members.find(member => member.isMe)?.shareBusy || false,
        expiresLabel: room.inviteExpiresAt ? new Date(Date.parse(room.inviteExpiresAt) + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ') : '' });
      await this.refreshProposal();
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ loading: false }); }
  },
  async refreshProposal() {
    if (this.data.local || !this.data.room) return;
    try { const proposal = await loadProposal(this.data.id); this.setData({ proposal: proposal ? withKeys(proposal) : null }); }
    catch (error) { this.setData({ proposal: null, error: errorMessage(error) }); }
  },
  async perform(action: Action, value?: boolean | string) {
    this.setData({ busy: true, error: '' });
    try {
      await roomAction(this.data.id, action, value);
      if (action === 'leave') { this.setData({ room: null }); wx.navigateBack(); }
      else await this.reload();
    } catch (error) {
      // 重新读取权限和成员状态，避免被移除后继续显示旧房间。
      await this.reload(); this.setData({ error: errorMessage(error) });
    } finally { this.setData({ busy: false }); }
  },
  consent() { if (!this.data.busy && !this.data.loading) void this.perform('consent', !this.data.shareBusy); },
  copyCode() {
    if (this.data.room?.inviteCode) wx.setClipboardData({ data: this.data.room.inviteCode, fail: () => this.setData({ error: '未能复制，请重试' }) });
  },
  confirm(action: Action, content: string, value?: string) {
    if (this.data.busy || this.data.loading) return;
    this.setData({ busy: true });
    wx.showModal({ title: '确认操作', content,
      success: result => { if (result.confirm) void this.perform(action, value); else this.setData({ busy: false }); },
      fail: () => this.setData({ busy: false, error: '未能打开确认窗口，请重试' }),
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
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ finding: false }); }
  },
  chooseSlot(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.loading) return;
    const slot = this.data.availability?.slots[Number(e.currentTarget.dataset.index)];
    if (!slot) return;
    this.setData({ busy: true });
    wx.showModal({ title: '提出这个时间', content: `${slot.date} ${slot.startTime}–${slot.endTime}\n全员接受后，会写入各自的日程。`,
      success: result => { if (result.confirm) void this.propose(slot); else this.setData({ busy: false }); },
      fail: () => this.setData({ busy: false, error: '未能打开确认窗口，请重试' }),
    });
  },
  async propose(slot: Slot) {
    this.setData({ busy: true, error: '' });
    try {
      this.setData({ proposal: withKeys(await proposeSlot(this.data.id, slot)), availability: null });
    } catch (error) { this.setData({ error: errorMessage(error) }); this.refreshProposal(); }
    finally { this.setData({ busy: false }); }
  },
  // ---- 第 16 步：全员确认后写入日程 ----
  decide(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.loading) return;
    const decision = String(e.currentTarget.dataset.decision) === 'REJECT' ? 'REJECT' : 'ACCEPT';
    const proposal = this.data.proposal;
    if (!proposal) return;
    this.setData({ busy: true });
    const content = decision === 'ACCEPT'
      ? `接受 ${proposal.date} ${proposal.startTime}–${proposal.endTime}？\n全员接受后会写入你的日程。`
      : `拒绝这个时间？其他人需要重新协商。`;
    wx.showModal({ title: decision === 'ACCEPT' ? '接受方案' : '拒绝方案', content,
      success: result => { if (result.confirm) void this.submit(proposal.id, decision); else this.setData({ busy: false }); },
      fail: () => this.setData({ busy: false, error: '未能打开确认窗口，请重试' }),
    });
  },
  async submit(proposalId: string, decision: 'ACCEPT' | 'REJECT') {
    this.setData({ busy: true, error: '' });
    try {
      const proposal = withKeys(await decideProposal(this.data.id, proposalId, decision));
      this.setData({ proposal, availability: null });
      if (proposal.status === 'CONFIRMED') wx.showToast({ title: '已写入各自日程', icon: 'success' });
    } catch (error) { this.setData({ error: errorMessage(error) }); this.refreshProposal(); }
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
        } catch (error) { this.setData({ error: errorMessage(error) }); await this.refreshProposal(); }
        finally { this.setData({ busy: false }); }
      }, fail: () => this.setData({ busy: false, error: '未能打开确认窗口，请重试' }),
    });
  },
});
