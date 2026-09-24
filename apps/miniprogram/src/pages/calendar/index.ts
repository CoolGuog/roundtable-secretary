import { Arrangement, listArrangements, deleteArrangement, errorMessage, modeLabel } from '../../services/secretary';

Page({
  data: { items: [] as Arrangement[], loading: false, error: '', mode: modeLabel() },
  onShow() { this.reload(); },
  async reload() {
    this.setData({ loading: true, error: '' });
    try { this.setData({ items: await listArrangements() }); }
    catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ loading: false }); }
  },
  add() { wx.switchTab({ url: '/pages/secretary/index' }); },
  remove(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id);
    wx.showModal({ title: '删除这条演示安排？', content: '删除后不会影响其他记录。', confirmText: '删除',
      success: async result => {
        if (!result.confirm) return;
        try { await deleteArrangement(id); await this.reload(); }
        catch (error) { this.setData({ error: errorMessage(error) }); }
      },
    });
  },
});
