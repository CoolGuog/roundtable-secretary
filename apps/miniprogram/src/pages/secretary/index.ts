import {
  today, modeLabel, listArrangements, saveArrangement, draftFromText, errorMessage, ScheduleDraft,
} from '../../services/secretary';

Page({
  data: {
    mode: modeLabel(), count: 0, showForm: false, saving: false, error: '',
    title: '', date: today(), startTime: '19:00', endTime: '20:00',
    utterance: '', drafting: false, draft: null as ScheduleDraft | null, draftMemoryNote: '',
  },
  async onShow() {
    try { this.setData({ count: (await listArrangements()).length, error: '' }); }
    catch (error) { this.setData({ count: 0, error: errorMessage(error) }); }
  },
  openForm() { this.setData({ showForm: true, error: '' }); },
  closeForm() { if (!this.data.saving) this.setData({ showForm: false }); },
  onUtterance(event: WechatMiniprogram.Input) { this.setData({ utterance: event.detail.value }); },
  onTitle(event: WechatMiniprogram.Input) { this.setData({ title: event.detail.value }); },
  onDate(event: WechatMiniprogram.PickerChange) { this.setData({ date: String(event.detail.value) }); },
  onStart(event: WechatMiniprogram.PickerChange) { this.setData({ startTime: String(event.detail.value) }); },
  onEnd(event: WechatMiniprogram.PickerChange) { this.setData({ endTime: String(event.detail.value) }); },
  // 只整理成草稿：解析出来的字段填进下面的表单，仍然要用户点一次确认才写入。
  async generate() {
    if (this.data.drafting) return;
    this.setData({ drafting: true, error: '' });
    try {
      const draft = await draftFromText(this.data.utterance);
      this.setData({
        draft,
        draftMemoryNote: draft.usedMemories.length ? `参考了你的记忆：${draft.usedMemories.join('、')}` : '',
        title: draft.title ?? this.data.title,
        date: draft.date ?? this.data.date,
        startTime: draft.startTime ?? this.data.startTime,
        endTime: draft.endTime ?? this.data.endTime,
        showForm: true,
        error: draft.status === 'UNAVAILABLE' ? draft.message : '',
      });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ drafting: false }); }
  },
  async save() {
    if (this.data.saving) return;
    this.setData({ saving: true, error: '' });
    try {
      const { title, date, startTime, endTime } = this.data;
      await saveArrangement({ title, date, startTime, endTime });
      this.setData({ showForm: false, title: '', utterance: '', draft: null, draftMemoryNote: '', count: (await listArrangements()).length });
      wx.showToast({ title: '安排已保存', icon: 'success' });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ saving: false }); }
  },
  openCalendar() { wx.switchTab({ url: '/pages/calendar/index' }); },
});
