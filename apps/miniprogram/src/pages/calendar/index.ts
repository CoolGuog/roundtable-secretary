import {
  Arrangement, listArrangements, updateArrangement, deleteArrangement, errorMessage, modeLabel,
} from '../../services/secretary';
import { CalendarFilter, CalendarGroup, calendarFilters, calendarView } from '../../services/calendar-view';

const currentDay = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const shiftDay = (date: string, offset: number) => new Date(Date.parse(date + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
Page({
  onFeedbackDismiss() { this.setData({ error: '' }); },
  data: {
    items: [] as Arrangement[], loading: false, error: '', mode: modeLabel(),
    editingId: '', editTitle: '', editDate: '', editStart: '', editEnd: '', saving: false, deletingId: '',
    query: '', filter: 'all' as CalendarFilter, selectedDate: currentDay(), filters: calendarFilters, category: 'all', toolsOpen: false,
    categories: [{ value: 'all', label: '全部' }, { value: 'once', label: '单次' }, { value: 'daily', label: '每天' }, { value: 'weekly', label: '每周固定' }],
    categoryCounts: { all: 0, once: 0, daily: 0, weekly: 0 }, days: [] as Array<{ date: string; label: string; number: string }>,
    groups: [] as CalendarGroup[], matchingCount: 0, filterActive: false,
    counts: { all: 0, today: 0, upcoming: 0, past: 0 },
    editScope: 'one', editRepeated: false, editUntil: '',
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
    const date = this.data.selectedDate;
    const onDay = this.data.items.filter((item: Arrangement) => item.date === date);
    const type = (item: Arrangement) => item.repeatKind || (item.seriesId ? item.repeatLabel === '每天重复' ? 'daily' : 'weekly' : 'once');
    const categoryCounts = { all: onDay.length, once: 0, daily: 0, weekly: 0 };
    for (const item of onDay) categoryCounts[type(item) as 'once' | 'daily' | 'weekly']++;
    const filtered = onDay.filter((item: Arrangement) => this.data.category === 'all' || type(item) === this.data.category);
    const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
    const monday = shiftDay(date, -((weekday + 6) % 7));
    const days = Array.from({ length: 7 }, (_, index) => { const day = shiftDay(monday, index); return { date: day, label: '一二三四五六日'[index], number: day.slice(8) }; });
    this.setData({ ...calendarView(filtered, this.data.query, this.data.filter, date, new Date()), categoryCounts, days,
      filterActive: Boolean(this.data.query.trim() || this.data.filter !== 'all' || this.data.category !== 'all' || date !== currentDay()) });
  },
  toggleTools() { this.setData({ toolsOpen: !this.data.toolsOpen }); },
  onCategory(event: WechatMiniprogram.TouchEvent) { const category = String(event.currentTarget.dataset.category); if (this.data.categories.some((entry: { value: string }) => entry.value === category)) { this.setData({ category }); this.refreshView(); } },
  onDay(event: WechatMiniprogram.TouchEvent) { this.selectDay(String(event.currentTarget.dataset.date)); },
  selectDay(date: string) { if (date < '2020-01-01' || date > '2099-12-31') return; this.setData({ selectedDate: date }); this.refreshView(); void this.reload(); },
  previousDay() { this.selectDay(shiftDay(this.data.selectedDate, -1)); },
  nextDay() { this.selectDay(shiftDay(this.data.selectedDate, 1)); },
  today() { this.selectDay(currentDay()); },
  onSearch(event: WechatMiniprogram.Input) { this.setData({ query: event.detail.value.slice(0, 60) }); this.refreshView(); },
  onFilter(event: WechatMiniprogram.TouchEvent) {
    const filter = event.currentTarget.dataset.filter as CalendarFilter;
    if (!calendarFilters.some(entry => entry.value === filter)) return;
    this.setData({ filter }); this.refreshView();
  },
  onSelectedDate(event: WechatMiniprogram.PickerChange) { this.selectDay(String(event.detail.value)); },
  clearFilters() { const changedRange = this.data.selectedDate !== currentDay(); this.setData({ query: '', filter: 'all', category: 'all', selectedDate: currentDay() }); this.refreshView(); if (changedRange) void this.reload(); },
  async reload() {
    if (!this._visible) return;
    const epoch = ++this._readEpoch;
    this.setData({ loading: true, error: '', items: [] });
    this.refreshView();
    try {
      const items = await listArrangements(this.data.selectedDate || undefined, this.data.selectedDate || undefined);
      if (this._visible && epoch === this._readEpoch) { this.setData({ items }); this.refreshView(); }
    }
    catch (error) { if (this._visible && epoch === this._readEpoch) this.setData({ error: errorMessage(error) }); }
    finally { if (this._visible && epoch === this._readEpoch) this.setData({ loading: false }); }
  },
  add() { wx.switchTab({ url: '/pages/secretary/index' }); },
  openWeek() { wx.navigateTo({ url: '/pages/week/index' }); },
  openEdit(event: { currentTarget: { dataset: Record<string, string> } }) {
    if (!this._visible || this.data.loading || this.data.saving || this.data.deletingId) return;
    const id = String(event.currentTarget.dataset.id);
    const item = this.data.items.find((entry: Arrangement) => entry.id === id);
    if (!item) { this.setData({ error: '这条安排已不存在，请刷新后重试' }); return; }
    if (item.seriesId && !event.currentTarget.dataset.scope) {
      const epoch = this._viewEpoch; this.setData({ saving: true });
      wx.showActionSheet({ itemList: ['仅修改本次', '修改本次及以后'],
        success: result => { if (this._visible && epoch === this._viewEpoch) { this.setData({ saving: false }); this.openEdit({ currentTarget: { dataset: { id, scope: result.tapIndex === 0 ? 'one' : 'future' } } }); } },
        complete: () => { if (!this._disposed) this.setData({ saving: false }); },
      }); return;
    }
    this.setData({ editingId: id, editTitle: item.title, editDate: item.seriesId && event.currentTarget.dataset.scope === 'future' ? id.split(':')[2] : item.date,
      editStart: item.startTime, editEnd: item.endTime, editUntil: item.repeatUntil || '', error: '', editRepeated: Boolean(item.seriesId), editScope: event.currentTarget.dataset.scope || 'one' });
  },
  closeEdit() { if (!this.data.saving && !this.data.deletingId) this.setData({ editingId: '' }); },
  onEditTitle(event: WechatMiniprogram.Input) { this.setData({ editTitle: event.detail.value }); },
  onEditDate(event: WechatMiniprogram.PickerChange) { this.setData({ editDate: String(event.detail.value) }); },
  onEditStart(event: WechatMiniprogram.PickerChange) { this.setData({ editStart: String(event.detail.value) }); },
  onEditEnd(event: WechatMiniprogram.PickerChange) { this.setData({ editEnd: String(event.detail.value) }); },
  onEditUntil(event: WechatMiniprogram.PickerChange) { this.setData({ editUntil: String(event.detail.value) }); },
  async submitEdit() {
    if (!this._visible || this.data.saving || this.data.deletingId || this.data.loading || !this.data.editingId) return;
    const viewEpoch = this._viewEpoch;
    this.setData({ saving: true, error: '' });
    try {
      const { editingId, editTitle, editDate, editStart, editEnd } = this.data;
      await updateArrangement(editingId, { title: editTitle, date: editDate, startTime: editStart, endTime: editEnd,
        ...(this.data.editRepeated && this.data.editScope === 'future' && this.data.editUntil ? { repeatUntil: this.data.editUntil } : {}) }, this.data.editScope);
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
  remove(event: { currentTarget: { dataset: Record<string, string> } }) {
    if (!this._visible || this.data.loading || this.data.saving || this.data.deletingId) return;
    const id = String(event.currentTarget.dataset.id);
    const item = this.data.items.find((entry: Arrangement) => entry.id === id);
    if (!item) { this.setData({ error: '这条安排已不存在，请刷新后重试' }); return; }
    if (item.seriesId && !event.currentTarget.dataset.scope) {
      const epoch = this._viewEpoch; this.setData({ deletingId: id });
      wx.showActionSheet({ itemList: ['仅删除本次', '删除本次及以后'],
        success: result => { if (this._visible && epoch === this._viewEpoch) { this.setData({ deletingId: '' }); this.remove({ currentTarget: { dataset: { id, scope: result.tapIndex === 0 ? 'one' : 'future' } } }); } },
        fail: () => { if (!this._disposed) this.setData({ deletingId: '' }); },
      }); return;
    }
    const scope = event.currentTarget.dataset.scope || 'one';
    const viewEpoch = this._viewEpoch;
    this.setData({ deletingId: id, error: '' });
    wx.showModal({ title: scope === 'future' ? '删除本次及以后？' : '删除这条安排？', content: scope === 'future' ? `“${item.title}”从 ${item.date} 起不再重复，之前的历史保留。` : `“${item.title}”本次将被删除，其他记录不受影响。`, confirmText: '删除',
      success: async result => {
        try {
          if (!result.confirm || !this._visible || viewEpoch !== this._viewEpoch) return;
          await deleteArrangement(id, scope);
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
