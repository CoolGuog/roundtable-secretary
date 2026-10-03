import { Room, listRooms, createRoom, joinRoom, isLocalRoomMode } from '../../services/roundtables';
import { today, modeLabel, errorMessage } from '../../services/secretary';
Page({
  data: { rooms: [] as Room[], loading: false, busy: false, error: '', form: '', title: '', goal: '', dateFrom: today(), dateTo: today(), startTime: '09:00', endTime: '21:00',
    durationIndex: 3, durations: Array.from({ length: 16 }, (_, i) => `${(i + 1) * 15} 分钟`), code: '', local: isLocalRoomMode(), mode: modeLabel() },
  onShow() { this.setData({ form: '', code: '' }); void this.reload(); },
  async reload() {
    this.setData({ loading: true, rooms: [], error: '' });
    try { this.setData({ rooms: await listRooms() }); }
    catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ loading: false }); }
  },
  newRoom() { if (!this.data.busy) this.setData({ form: 'create', title: '', goal: '', error: '' }); },
  joinForm() { if (!this.data.busy) this.setData({ form: 'join', code: '', error: '' }); },
  cancel() { if (!this.data.busy) this.setData({ form: '', error: '' }); },
  onTitle(e: WechatMiniprogram.Input) { this.setData({ title: e.detail.value }); },
  onGoal(e: WechatMiniprogram.Input) { this.setData({ goal: e.detail.value }); },
  onCode(e: WechatMiniprogram.Input) { this.setData({ code: e.detail.value }); },
  onFrom(e: WechatMiniprogram.PickerChange) { this.setData({ dateFrom: String(e.detail.value) }); },
  onTo(e: WechatMiniprogram.PickerChange) { this.setData({ dateTo: String(e.detail.value) }); },
  onStart(e: WechatMiniprogram.PickerChange) { this.setData({ startTime: String(e.detail.value) }); },
  onEnd(e: WechatMiniprogram.PickerChange) { this.setData({ endTime: String(e.detail.value) }); },
  onDuration(e: WechatMiniprogram.PickerChange) { this.setData({ durationIndex: Number(e.detail.value) }); },
  async submit() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try {
      const { title, goal, dateFrom, dateTo, startTime, endTime, durationIndex, code, form } = this.data;
      const room = form === 'join' ? await joinRoom(code) : await createRoom({ title, goal, dateFrom, dateTo, startTime, endTime, durationMinutes: (durationIndex + 1) * 15 });
      this.setData({ form: '', title: '', goal: '', code: '' });
      wx.navigateTo({ url: `/pages/roundtable/index?id=${encodeURIComponent(room.id)}` });
    } catch (error) { this.setData({ error: errorMessage(error) }); }
    finally { this.setData({ busy: false }); }
  },
  open(e: WechatMiniprogram.TouchEvent) { wx.navigateTo({ url: `/pages/roundtable/index?id=${encodeURIComponent(String(e.currentTarget.dataset.id))}` }); },
});
