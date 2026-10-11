import {
  today, modeLabel, listArrangements, saveArrangement, draftFromText, errorMessage, ScheduleDraft, loadSecretaryStatus, SecretaryStatus, RequestError,
} from '../../services/secretary';
import type { Arrangement } from '../../services/secretary';
import { validateDraft, findConflicts, conflictSignature } from '../../services/arrangement-conflicts';

Page({
  data: {
    mode: modeLabel(), count: 0, showForm: false, saving: false, error: '',
    title: '', date: today(), startTime: '19:00', endTime: '20:00',
    utterance: '', drafting: false, draft: null as ScheduleDraft | null, draftMemoryNote: '',
    secretaryStatus: null as SecretaryStatus | null, statusLoading: false, statusError: '',
    messages: [] as Array<{ id: number; role: string; text: string }>, turns: 0,
    checking: false, conflicts: [] as Arrangement[],
  },
  _statusEpoch: 0,
  _draftEpoch: 0,
  _checkEpoch: 0, _countEpoch: 0, _conflictSignature: '', _disposed: false,
  async onShow() {
    const epoch = ++this._countEpoch;
    void this.refreshStatus();
    try { const items = await listArrangements(); if (epoch === this._countEpoch) this.setData({ count: items.length }); }
    catch (error) { if (epoch === this._countEpoch) this.setData({ count: 0, error: errorMessage(error) }); }
  },
  onHide() { this._statusEpoch++; this._draftEpoch++; this._countEpoch++; this.invalidateConflicts(); this.setData({ drafting: false }); },
  onUnload() { this.onHide(); this._disposed = true; },
  invalidateConflicts() {
    this._checkEpoch++; this._conflictSignature = '';
    this.setData({ checking: false, conflicts: [] });
  },
  async refreshStatus() {
    const epoch = ++this._statusEpoch;
    this.setData({ statusLoading: true, statusError: '', secretaryStatus: null });
    try { const status = await loadSecretaryStatus(); if (epoch === this._statusEpoch) this.setData({ secretaryStatus: status }); }
    catch (error) { if (epoch === this._statusEpoch) this.setData({ statusError: errorMessage(error) }); }
    finally { if (epoch === this._statusEpoch) this.setData({ statusLoading: false }); }
  },
  openForm() { if (!this.data.drafting && !this.data.saving) this.setData({ showForm: true, error: '' }); },
  closeForm() { if (!this.data.saving) { this.invalidateConflicts(); this.setData({ showForm: false }); } },
  onUtterance(event: WechatMiniprogram.Input) { this.setData({ utterance: event.detail.value }); },
  onTitle(event: WechatMiniprogram.Input) { if (!this.data.saving) { this.invalidateConflicts(); this.setData({ title: event.detail.value, error: '' }); } },
  onDate(event: WechatMiniprogram.PickerChange) { if (!this.data.saving) { this.invalidateConflicts(); this.setData({ date: String(event.detail.value), error: '' }); } },
  onStart(event: WechatMiniprogram.PickerChange) { if (!this.data.saving) { this.invalidateConflicts(); this.setData({ startTime: String(event.detail.value), error: '' }); } },
  onEnd(event: WechatMiniprogram.PickerChange) { if (!this.data.saving) { this.invalidateConflicts(); this.setData({ endTime: String(event.detail.value), error: '' }); } },
  resetDraft() {
    if (this.data.saving) return;
    this._draftEpoch++;
    this.invalidateConflicts();
    this.setData({ utterance: '', drafting: false, draft: null, draftMemoryNote: '', messages: [], turns: 0,
      showForm: false, title: '', date: today(), startTime: '19:00', endTime: '20:00', error: '' });
  },
  sendReply() { return this.generate(true); },
  // 只整理成草稿：解析出来的字段填进下面的表单，仍然要用户点一次确认才写入。
  async generate(continuing: unknown = false) {
    if (this.data.drafting || this.data.saving || this.data.statusLoading) return;
    if (!this.data.secretaryStatus?.canGenerate) {
      this.setData({ error: this.data.secretaryStatus?.message || '请先重新读取秘书状态，也可以手动填写安排' }); return;
    }
    const followup = continuing === true;
    if (followup && (this.data.secretaryStatus.mode !== 'local' || !this.data.draft)) return;
    if (followup && this.data.turns >= 6) { this.setData({ error: '这条安排已补充 6 轮，请直接修改下方表单，或开始新安排' }); return; }
    const utterance = this.data.utterance.trim();
    if (!utterance) { this.setData({ error: '请先说一句你想安排的事' }); return; }
    const previous = followup ? { title: this.data.title || null, date: this.data.date || null,
      startTime: this.data.startTime || null, endTime: this.data.endTime || null } : null;
    const epoch = ++this._draftEpoch;
    this.invalidateConflicts();
    const messages = followup ? this.data.messages : [];
    this.setData({ drafting: true, error: '', ...(followup ? {} : { draft: null, draftMemoryNote: '', showForm: false,
      title: '', date: '', startTime: '', endTime: '', messages: [], turns: 0 }) });
    try {
      const draft = await draftFromText(utterance, previous);
      if (epoch !== this._draftEpoch) return;
      const reply = draft.status === 'READY' ? `${draft.message}\n当前草稿：${draft.title}，${draft.date} ${draft.startTime}—${draft.endTime}。` : draft.message;
      this.setData({
        draft,
        utterance: draft.status === 'UNAVAILABLE' ? utterance : '',
        turns: (followup ? this.data.turns : 0) + 1,
        messages: [...messages, { id: messages.length, role: 'user', text: utterance }, { id: messages.length + 1, role: 'secretary', text: reply }],
        draftMemoryNote: draft.usedMemories.length ? `参考了你的记忆：${draft.usedMemories.join('、')}` : '',
        title: draft.title ?? '',
        date: draft.date ?? '',
        startTime: draft.startTime ?? '',
        endTime: draft.endTime ?? '',
        showForm: draft.status !== 'UNAVAILABLE',
        error: draft.status === 'UNAVAILABLE' ? draft.message : '',
      });
    } catch (error) { if (epoch === this._draftEpoch) this.setData({ error: errorMessage(error) }); }
    finally { if (epoch === this._draftEpoch) this.setData({ drafting: false }); }
  },
  confirmOverlap() { return this.save(true); },
  async save(allowOverlap: unknown = false) {
    if (this._disposed || this.data.saving || this.data.drafting || this.data.checking) return;
    const { title, date, startTime, endTime } = this.data;
    const input = { title: title.trim(), date, startTime, endTime };
    const invalid = validateDraft(input);
    if (invalid) { this.invalidateConflicts(); this.setData({ error: invalid }); return; }
    const epoch = ++this._checkEpoch;
    const reviewed = allowOverlap === true ? this._conflictSignature : '';
    this.setData({ checking: true, error: '' });
    try {
      const items = await listArrangements();
      if (epoch !== this._checkEpoch) return;
      const conflicts = findConflicts(input, items);
      const signature = conflictSignature(input, conflicts);
      this.setData({ count: items.length, conflicts });
      if (conflicts.length && reviewed !== signature) {
        this._conflictSignature = signature;
        return;
      }
    } catch (error) {
      if (epoch === this._checkEpoch) {
        this._conflictSignature = '';
        this.setData({ conflicts: [], error: `暂时无法检查时间冲突，尚未保存。${errorMessage(error)} 请重试。` });
      }
      return;
    } finally { if (epoch === this._checkEpoch) this.setData({ checking: false }); }
    if (epoch !== this._checkEpoch) return;
    this._countEpoch++;
    this.setData({ saving: true, error: '' });
    try {
      await saveArrangement(input);
      if (this._disposed) return;
      this.invalidateConflicts();
      this.setData({ showForm: false, title: '', utterance: '', draft: null, draftMemoryNote: '', turns: 0,
        messages: [...this.data.messages, { id: this.data.messages.length, role: 'secretary', text: '已保存到日程。可以开始下一条安排。' }] });
      wx.showToast({ title: '安排已保存', icon: 'success' });
      const countEpoch = ++this._countEpoch;
      try {
        const items = await listArrangements();
        if (countEpoch === this._countEpoch) this.setData({ count: items.length });
      } catch { if (countEpoch === this._countEpoch) this.setData({ error: '安排已保存，但数量暂未更新；请到日程页刷新查看，无需再次保存。' }); }
    } catch (error) {
      if (!this._disposed) this.setData({ error: error instanceof RequestError && error.statusCode === 0
        ? '保存结果尚未确认。可先到日程页查看；本次运行内原样重试不会重复创建。' : errorMessage(error) });
    } finally { if (!this._disposed) this.setData({ saving: false }); }
  },
  openCalendar() { wx.switchTab({ url: '/pages/calendar/index' }); },
});
