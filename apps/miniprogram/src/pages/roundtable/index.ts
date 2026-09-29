import { Room, getRoom, roomAction, isLocalRoomMode } from '../../services/roundtables';
import { errorMessage } from '../../services/secretary';
type Action = 'consent' | 'rotate' | 'close' | 'leave' | 'remove';
Page({
  data: { id: '', room: null as Room | null, loading: false, busy: false, error: '', local: isLocalRoomMode(), shareBusy: false, expiresLabel: '' },
  onLoad(options: Record<string, string | undefined>) { this.setData({ id: options.id || '' }); },
  onShow() { void this.reload(); },
  async reload() {
    if (!this.data.id) return;
    this.setData({ loading: true, room: null, error: '', shareBusy: false });
    try {
      const room = await getRoom(this.data.id);
      this.setData({ room, shareBusy: room.members.find(member => member.isMe)?.shareBusy || false,
        expiresLabel: room.inviteExpiresAt ? new Date(Date.parse(room.inviteExpiresAt) + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ') : '' });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ loading: false }); }
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
});
