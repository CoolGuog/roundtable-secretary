import { Notice, listNotices, readNotice, sharedEnabled } from '../../services/shared-work';
import { errorMessage } from '../../services/secretary';
Page({
  data: { enabled: sharedEnabled(), items: [] as Notice[], loading: false, busy: false, error: '', unread: 0 },
  _visible: false, _epoch: 0, _disposed: false,
  onShow() { this._visible = true; if (this.data.enabled) void this.reload(); },
  onHide() { this._visible = false; this._epoch++; }, onUnload() { this.onHide(); this._disposed = true; },
  async onPullDownRefresh() { try { await this.reload(); } finally { wx.stopPullDownRefresh(); } },
  async reload() {
    if (!this._visible || !this.data.enabled || this.data.loading || this.data.busy) return;
    const epoch = ++this._epoch; this.setData({ loading: true, error: '' });
    try { const items = await listNotices(); if (this._visible && epoch === this._epoch) this.setData({ items, unread: items.filter(n => !n.readAt).length }); }
    catch (error) { if (this._visible && epoch === this._epoch) this.setData({ error: errorMessage(error) }); }
    finally { if (!this._disposed) this.setData({ loading: false }); if (this._visible && epoch !== this._epoch) void this.reload(); }
  },
  open(event: WechatMiniprogram.BaseEvent) { const item = this.data.items.find((n: Notice) => n.id === event.currentTarget.dataset.id); if (item && this._visible && !this.data.busy) wx.navigateTo({ url: `/pages/shared-work/index?id=${encodeURIComponent(item.roomId)}&tab=${encodeURIComponent(item.section ?? 'tasks')}` }); },
  async mark(event: WechatMiniprogram.BaseEvent) {
    if (!this._visible || this.data.busy || this.data.loading) return;
    const item = this.data.items.find((n: Notice) => n.id === event.currentTarget.dataset.id); if (!item || item.readAt) return;
    const epoch = ++this._epoch; this.setData({ busy: true, error: '' }); let success = false;
    try { await readNotice(item.roomId, item.id); success = true; }
    catch (error) { if (this._visible && epoch === this._epoch) this.setData({ error: errorMessage(error) }); }
    finally { if (!this._disposed) this.setData({ busy: false }); if (this._visible && success) void this.reload(); }
  },
});
