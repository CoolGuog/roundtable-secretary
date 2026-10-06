import { Arrangement, listArrangements, errorMessage, today, modeLabel } from '../../services/secretary';
import { localTasksForStats, WorkTask } from '../../services/meeting-work';
import { weeklyView, shiftDate, weekStart } from '../../services/week-view';
Page({
  data: { mode: modeLabel(), anchor: today(), start: '', end: '', days: [] as object[], stats: {} as object,
    loading: false, loaded: false, error: '', taskError: '', taskStatsAvailable: false, canPrevious: true, canNext: true },
  _visible: false, _epoch: 0, _items: [] as Arrangement[], _tasks: null as WorkTask[] | null, _timer: null as number | null,
  onShow() { this._visible = true; void this.reload(); this.scheduleClock(); },
  onHide() { this._visible = false; this._epoch++; if (this._timer !== null) clearTimeout(this._timer); this._timer = null; },
  onUnload() { this.onHide(); },
  async onPullDownRefresh() { try { await this.reload(); } finally { wx.stopPullDownRefresh(); } },
  scheduleClock() {
    if (this._timer !== null) clearTimeout(this._timer);
    if (!this._visible) return;
    this._timer = setTimeout(() => { this._timer = null; if (this._visible) { if (this.data.loaded) this.render(); this.scheduleClock(); } }, 60_000 - Date.now() % 60_000);
  },
  render() { this.setData(weeklyView(this._items, this._tasks, this.data.anchor, new Date())); },
  async reload() {
    if (!this._visible) return;
    const epoch = ++this._epoch; this._items = []; this._tasks = null;
    this.setData({ loading: true, loaded: false, error: '', taskError: '', days: [], stats: {}, taskStatsAvailable: false });
    try {
      const [items, taskResult] = await Promise.all([listArrangements(), localTasksForStats().then(tasks => ({ tasks, error: '' }), error => ({ tasks: null, error: errorMessage(error) }))]);
      if (!this._visible || epoch !== this._epoch) return;
      this._items = items; this._tasks = taskResult.tasks; this.setData({ loaded: true, taskError: taskResult.error }); this.render();
    } catch (error) { if (this._visible && epoch === this._epoch) this.setData({ error: errorMessage(error) }); }
    finally { if (this._visible && epoch === this._epoch) this.setData({ loading: false }); }
  },
  onDate(event: WechatMiniprogram.PickerChange) {
    const anchor = String(event.detail.value);
    try { weekStart(anchor); this.setData({ anchor }); if (this.data.loaded) this.render(); }
    catch (error) { this.setData({ error: errorMessage(error) }); }
  },
  previous() { if (this.data.loaded && this.data.canPrevious) { const anchor = shiftDate(this.data.start, -7); this.setData({ anchor: anchor < '2020-01-01' ? '2020-01-01' : anchor }); this.render(); } },
  next() { if (this.data.loaded && this.data.canNext) { this.setData({ anchor: shiftDate(this.data.start, 7) }); this.render(); } },
  currentWeek() { this.setData({ anchor: today() }); if (this.data.loaded) this.render(); },
});
