import {
  Arrangement, listArrangements, updateArrangement, deleteArrangement, errorMessage, modeLabel,
} from '../../services/secretary';

Page({
  data: {
    items: [] as Arrangement[], loading: false, error: '', mode: modeLabel(),
    editingId: '', editTitle: '', editDate: '', editStart: '', editEnd: '', saving: false,
  },
  onShow() { this.reload(); },
  async reload() {
    this.setData({ loading: true, error: '' });
    try { this.setData({ items: await listArrangements() }); }
    catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ loading: false }); }
  },
  add() { wx.switchTab({ url: '/pages/secretary/index' }); },
  openEdit(event: WechatMiniprogram.TouchEvent) {
    const id = String(event.currentTarget.dataset.id);
    const item = this.data.items.find((entry: Arrangement) => entry.id === id);
    if (!item) { this.setData({ error: '这条安排已不存在，请刷新后重试' }); return; }
    this.setData({ editingId: id, editTitle: item.title, editDate: item.date,
      editStart: item.startTime, editEnd: item.endTime, error: '' });
  },
  closeEdit() { if (!this.data.saving) this.setData({ editingId: '' }); },
  onEditTitle(event: WechatMiniprogram.Input) { this.setData({ editTitle: event.detail.value }); },
  onEditDate(event: WechatMiniprogram.PickerChange) { this.setData({ editDate: String(event.detail.value) }); },
  onEditStart(event: WechatMiniprogram.PickerChange) { this.setData({ editStart: String(event.detail.value) }); },
  onEditEnd(event: WechatMiniprogram.PickerChange) { this.setData({ editEnd: String(event.detail.value) }); },
  async submitEdit() {
    if (this.data.saving) return;
    this.setData({ saving: true, error: '' });
    try {
      const { editingId, editTitle, editDate, editStart, editEnd } = this.data;
      await updateArrangement(editingId, { title: editTitle, date: editDate, startTime: editStart, endTime: editEnd });
      this.setData({ editingId: '' });
      await this.reload();
      wx.showToast({ title: '安排已更新', icon: 'success' });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ saving: false }); }
  },
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
