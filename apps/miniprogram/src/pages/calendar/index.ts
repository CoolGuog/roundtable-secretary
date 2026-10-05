import {
  Arrangement, listArrangements, updateArrangement, deleteArrangement, errorMessage, modeLabel,
} from '../../services/secretary';
import { CalendarFilter, CalendarGroup, calendarFilters, calendarView } from '../../services/calendar-view';

Page({
  data: {
    items: [] as Arrangement[], loading: false, error: '', mode: modeLabel(),
    editingId: '', editTitle: '', editDate: '', editStart: '', editEnd: '', saving: false, deletingId: '',
    query: '', filter: 'all' as CalendarFilter, selectedDate: '', filters: calendarFilters,
    groups: [] as CalendarGroup[], matchingCount: 0, filterActive: false,
    counts: { all: 0, today: 0, upcoming: 0, past: 0 },
  },
  _visible: false, _disposed: false, _viewEpoch: 0, _readEpoch: 0,
  _clockTimer: null as number | null,
  onShow() { this._visible = true; this._viewEpoch++; this.setData({ editingId: '', editTitle: '', editDate: '', editStart: '', editEnd: '' }); void this.reload(); this.scheduleClock(); },
  onHide() { this._visible = false; this._viewEpoch++; this._readEpoch++; if (this._clockTimer !== null) clearTimeout(this._clockTimer); this._clockTimer = null; },
  onUnload() { this.onHide(); this._disposed = true; },
  scheduleClock() {
    if (this._clockTimer !== null) clearTimeout(this._clockTimer);
    if (!this._visible) return;
    this._clockTimer = setTimeout(() => {
      this._clockTimer = null;
      if (this._visible) { this.refreshView(); this.scheduleClock(); }
    }, 60_000 - Date.now() % 60_000);
  },
  refreshView() {
    this.setData(calendarView(this.data.items, this.data.query, this.data.filter, this.data.selectedDate, new Date()));
  },
  onSearch(event: WechatMiniprogram.Input) { this.setData({ query: event.detail.value.slice(0, 60) }); this.refreshView(); },
  onFilter(event: WechatMiniprogram.TouchEvent) {
    const filter = event.currentTarget.dataset.filter as CalendarFilter;
    if (!calendarFilters.some(entry => entry.value === filter)) return;
    this.setData({ filter }); this.refreshView();
  },
  onSelectedDate(event: WechatMiniprogram.PickerChange) { this.setData({ selectedDate: String(event.detail.value) }); this.refreshView(); },
  clearFilters() { this.setData({ query: '', filter: 'all', selectedDate: '' }); this.refreshView(); },
  async reload() {
    if (!this._visible) return;
    const epoch = ++this._readEpoch;
    this.setData({ loading: true, error: '', items: [] });
    this.refreshView();
    try {
      const items = await listArrangements();
      if (this._visible && epoch === this._readEpoch) { this.setData({ items }); this.refreshView(); }
    }
    catch (error) { if (this._visible && epoch === this._readEpoch) this.setData({ error: errorMessage(error) }); }
    finally { if (this._visible && epoch === this._readEpoch) this.setData({ loading: false }); }
  },
  add() { wx.switchTab({ url: '/pages/secretary/index' }); },
  openEdit(event: WechatMiniprogram.TouchEvent) {
    if (!this._visible || this.data.loading || this.data.saving || this.data.deletingId) return;
    const id = String(event.currentTarget.dataset.id);
    const item = this.data.items.find((entry: Arrangement) => entry.id === id);
    if (!item) { this.setData({ error: '这条安排已不存在，请刷新后重试' }); return; }
    this.setData({ editingId: id, editTitle: item.title, editDate: item.date,
      editStart: item.startTime, editEnd: item.endTime, error: '' });
  },
  closeEdit() { if (!this.data.saving && !this.data.deletingId) this.setData({ editingId: '' }); },
  onEditTitle(event: WechatMiniprogram.Input) { this.setData({ editTitle: event.detail.value }); },
  onEditDate(event: WechatMiniprogram.PickerChange) { this.setData({ editDate: String(event.detail.value) }); },
  onEditStart(event: WechatMiniprogram.PickerChange) { this.setData({ editStart: String(event.detail.value) }); },
  onEditEnd(event: WechatMiniprogram.PickerChange) { this.setData({ editEnd: String(event.detail.value) }); },
  async submitEdit() {
    if (!this._visible || this.data.saving || this.data.deletingId || this.data.loading || !this.data.editingId) return;
    const viewEpoch = this._viewEpoch;
    this.setData({ saving: true, error: '' });
    try {
      const { editingId, editTitle, editDate, editStart, editEnd } = this.data;
      await updateArrangement(editingId, { title: editTitle, date: editDate, startTime: editStart, endTime: editEnd });
      if (!this._visible || viewEpoch !== this._viewEpoch) return;
      this.setData({ editingId: '' });
      await this.reload();
      if (this._visible && viewEpoch === this._viewEpoch) wx.showToast({ title: '安排已更新', icon: 'success' });
    } catch (error) { if (this._visible && viewEpoch === this._viewEpoch) this.setData({ error: errorMessage(error) }); }
    finally {
      if (!this._disposed) {
        this.setData({ saving: false });
        if (this._visible && viewEpoch !== this._viewEpoch) void this.reload();
      }
    }
  },
  remove(event: WechatMiniprogram.TouchEvent) {
    if (!this._visible || this.data.loading || this.data.saving || this.data.deletingId) return;
    const id = String(event.currentTarget.dataset.id);
    const item = this.data.items.find((entry: Arrangement) => entry.id === id);
    if (!item) { this.setData({ error: '这条安排已不存在，请刷新后重试' }); return; }
    const viewEpoch = this._viewEpoch;
    this.setData({ deletingId: id, error: '' });
    wx.showModal({ title: '删除这条安排？', content: `“${item.title}”将被删除，其他记录不受影响。`, confirmText: '删除',
      success: async result => {
        try {
          if (!result.confirm || !this._visible || viewEpoch !== this._viewEpoch) return;
          await deleteArrangement(id);
          if (!this._visible || viewEpoch !== this._viewEpoch) return;
          if (this.data.editingId === id) this.setData({ editingId: '', editTitle: '', editDate: '', editStart: '', editEnd: '' });
          await this.reload();
        } catch (error) { if (this._visible && viewEpoch === this._viewEpoch) this.setData({ error: errorMessage(error) }); }
        finally {
          if (!this._disposed) {
            this.setData({ deletingId: '' });
            if (this._visible && viewEpoch !== this._viewEpoch) void this.reload();
          }
        }
      },
      fail: () => {
        if (!this._disposed) this.setData({ deletingId: '', ...(this._visible && viewEpoch === this._viewEpoch ? { error: '未能打开确认窗口，请重试' } : {}) });
      },
    });
  },
});
