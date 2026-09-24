import { today, modeLabel, listArrangements, saveArrangement, errorMessage } from '../../services/secretary';

Page({
  data: {
    mode: modeLabel(), count: 0, showForm: false, saving: false, error: '',
    title: '', date: today(), startTime: '19:00', endTime: '20:00',
  },
  async onShow() {
    try { this.setData({ count: (await listArrangements()).length, error: '' }); }
    catch (error) { this.setData({ error: errorMessage(error) }); }
  },
  openForm() { this.setData({ showForm: true, error: '' }); },
  closeForm() { if (!this.data.saving) this.setData({ showForm: false }); },
  onTitle(event: WechatMiniprogram.Input) { this.setData({ title: event.detail.value }); },
  onDate(event: WechatMiniprogram.PickerChange) { this.setData({ date: String(event.detail.value) }); },
  onStart(event: WechatMiniprogram.PickerChange) { this.setData({ startTime: String(event.detail.value) }); },
  onEnd(event: WechatMiniprogram.PickerChange) { this.setData({ endTime: String(event.detail.value) }); },
  async save() {
    if (this.data.saving) return;
    this.setData({ saving: true, error: '' });
    try {
      const { title, date, startTime, endTime } = this.data;
      await saveArrangement({ title, date, startTime, endTime });
      this.setData({ showForm: false, title: '', count: (await listArrangements()).length });
      wx.showToast({ title: '安排已保存', icon: 'success' });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ saving: false }); }
  },
  openCalendar() { wx.switchTab({ url: '/pages/calendar/index' }); },
});
