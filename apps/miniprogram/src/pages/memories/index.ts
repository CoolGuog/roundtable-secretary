import { PersonalMemory, categories, categoryNames, listMemories, saveMemory, deleteMemory } from '../../services/memories';
import { errorMessage, modeLabel } from '../../services/secretary';

type MemoryView = PersonalMemory & { categoryName: string; sourceName: string; updatedLabel: string };
Page({
  data: {
    items: [] as MemoryView[], loading: false, busy: false, error: '', mode: modeLabel(), categoryNames,
    editorOpen: false, editingId: '', label: '', content: '', categoryIndex: 0,
  },
  onShow() { this.setData({ editorOpen: false, editingId: '', label: '', content: '', categoryIndex: 0 }); void this.reload(); },
  async reload() {
    this.setData({ loading: true, error: '', items: [] });
    try {
      const items = (await listMemories()).map(item => ({ ...item,
        categoryName: categoryNames[categories.indexOf(item.category)],
        sourceName: item.source === 'USER_INPUT' ? '手动录入' : '秘书提炼',
        updatedLabel: new Date(new Date(item.updatedAt).getTime() + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' '),
      }));
      this.setData({ items });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ loading: false }); }
  },
  add() {
    if (this.data.busy || this.data.loading) return;
    this.setData({ editorOpen: true, editingId: '', label: '', content: '', categoryIndex: 0, error: '' });
  },
  edit(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.loading) return;
    const item = this.data.items.find((entry: MemoryView) => entry.id === event.currentTarget.dataset.id);
    if (!item) return;
    this.setData({ editorOpen: true, editingId: item.id, label: item.label, content: item.content,
      categoryIndex: categories.indexOf(item.category), error: '' });
    wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },
  cancel() { if (!this.data.busy) this.setData({ editorOpen: false, editingId: '', label: '', content: '', error: '' }); },
  onLabel(event: WechatMiniprogram.Input) { this.setData({ label: event.detail.value }); },
  onContent(event: WechatMiniprogram.Input) { this.setData({ content: event.detail.value }); },
  onCategory(event: WechatMiniprogram.PickerChange) { this.setData({ categoryIndex: Number(event.detail.value) }); },
  async save() {
    if (this.data.busy || this.data.loading) return;
    this.setData({ busy: true, error: '' });
    try {
      await saveMemory({ label: this.data.label, content: this.data.content, category: categories[this.data.categoryIndex] }, this.data.editingId || undefined);
      this.setData({ editorOpen: false, editingId: '', label: '', content: '' });
      await this.reload();
      wx.showToast({ title: '记忆已保存', icon: 'success' });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ busy: false }); }
  },
  remove(event: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.loading) return;
    const id = String(event.currentTarget.dataset.id);
    const item = this.data.items.find((entry: MemoryView) => entry.id === id);
    if (!item) return;
    this.setData({ busy: true, error: '' });
    wx.showModal({ title: '删除这条记忆？', content: `“${item.label}”将被删除，其他记忆不受影响。`, confirmText: '删除',
      success: async result => {
        try {
          if (!result.confirm) return;
          await deleteMemory(id);
          if (this.data.editingId === id) this.setData({ editorOpen: false, editingId: '', label: '', content: '' });
          await this.reload();
          wx.showToast({ title: '已删除', icon: 'success' });
        } catch (error) { this.setData({ error: errorMessage(error) }); }
        finally { this.setData({ busy: false }); }
      }, fail: () => this.setData({ busy: false, error: '未能打开确认窗口，请重试' }),
    });
  },
});
