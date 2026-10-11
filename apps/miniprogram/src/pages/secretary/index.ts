import {
  today, modeLabel, listArrangements, saveArrangement, draftFromText, draftsFromText, BatchItem, errorMessage, ScheduleDraft, loadSecretaryStatus, SecretaryStatus, RequestError,
} from '../../services/secretary';
import type { Arrangement } from '../../services/secretary';
import { validateDraft, findConflicts, conflictSignature } from '../../services/arrangement-conflicts';
import { repeatRule, expandRepeat, RepeatSeries } from '../../services/repeat-engine';

Page({
  data: {
    batch: [] as BatchItem[], batchNotes: [] as string[], batchModel: '', batchEdit: -1,
    mode: modeLabel(), count: 0, showForm: false, formSource: 'manual', saving: false, error: '',
    title: '', date: today(), startTime: '19:00', endTime: '20:00',
    utterance: '', drafting: false, draft: null as ScheduleDraft | null, draftMemoryNote: '',
    secretaryStatus: null as SecretaryStatus | null, statusLoading: false, statusError: '',
    messages: [] as Array<{ id: number; role: string; text: string }>, turns: 0,
    checking: false, conflicts: [] as Arrangement[],
    repeatKind: 'once', repeatOptions: ['仅当天', '每天', '每周固定'], repeatIndex: 0,
    weekdays: [{ value: 1, label: '周一' }, { value: 2, label: '周二' }, { value: 3, label: '周三' }, { value: 4, label: '周四' }, { value: 5, label: '周五' }, { value: 6, label: '周六' }, { value: 0, label: '周日' }],
    repeatDays: [] as number[], repeatUntil: today(),
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
    this.setData({ statusLoading: true, statusError: '', error: '', secretaryStatus: null });
    try { const status = await loadSecretaryStatus(); if (epoch === this._statusEpoch) this.setData({ secretaryStatus: status }); }
    catch (error) { if (epoch === this._statusEpoch) this.setData({ statusError: errorMessage(error) }); }
    finally { if (epoch === this._statusEpoch) this.setData({ statusLoading: false }); }
  },
  openForm() { if (!this.data.drafting && !this.data.saving) this.setData({ showForm: true, formSource: 'manual', batchEdit: -1, error: '' }); },
  closeForm() { if (!this.data.saving) { this.invalidateConflicts(); this.setData({ showForm: false }); } },
  onUtterance(event: WechatMiniprogram.Input) { this.setData({ utterance: event.detail.value }); },
  onTitle(event: WechatMiniprogram.Input) { if (!this.data.saving) { this.invalidateConflicts(); this.setData({ title: event.detail.value, error: '' }); } },
  onDate(event: WechatMiniprogram.PickerChange) { if (!this.data.saving) { this.invalidateConflicts(); this.setData({ date: String(event.detail.value), error: '' }); } },
  onStart(event: WechatMiniprogram.PickerChange) { if (!this.data.saving) { this.invalidateConflicts(); this.setData({ startTime: String(event.detail.value), error: '' }); } },
  onEnd(event: WechatMiniprogram.PickerChange) { if (!this.data.saving) { this.invalidateConflicts(); this.setData({ endTime: String(event.detail.value), error: '' }); } },
  onRepeat(event: WechatMiniprogram.PickerChange) {
    if (this.data.saving) return;
    const index = Number(event.detail.value); this.invalidateConflicts();
    const day = new Date((this.data.date || today()) + 'T00:00:00Z').getUTCDay();
    this.setData({ repeatIndex: index, repeatKind: ['once', 'daily', 'weekly'][index], repeatUntil: new Date(Date.parse((this.data.date || today()) + 'T00:00:00Z') + 30 * 86400000).toISOString().slice(0, 10), repeatDays: [day], weekdays: this.data.weekdays.map((item: { value: number; label: string }) => ({ ...item, checked: item.value === day })) });
  },
  onRepeatDays(event: WechatMiniprogram.CheckboxGroupChange) { if (!this.data.saving) { this.invalidateConflicts(); const days = event.detail.value.map(Number); this.setData({ repeatDays: days, weekdays: this.data.weekdays.map((item: { value: number; label: string }) => ({ ...item, checked: days.includes(item.value) })) }); } },
  onRepeatUntil(event: WechatMiniprogram.PickerChange) { if (!this.data.saving) { this.invalidateConflicts(); this.setData({ repeatUntil: String(event.detail.value) }); } },
  resetDraft() {
    if (this.data.saving) return;
    this._draftEpoch++;
    this.invalidateConflicts();
    this.setData({ batch: [], batchNotes: [], batchEdit: -1, utterance: '', drafting: false, draft: null, draftMemoryNote: '', messages: [], turns: 0,
      showForm: false, title: '', date: today(), startTime: '19:00', endTime: '20:00', error: '', repeatKind: 'once', repeatIndex: 0, repeatDays: [] });
  },
  sendReply() { return this.generate(true); },
  // 只整理成草稿：解析出来的字段填进下面的表单，仍然要用户点一次确认才写入。
  async generate(continuing: unknown = false) {
    if (this.data.drafting || this.data.saving || this.data.statusLoading) return;
    if (this.data.secretaryStatus?.mode === 'http') return this.generateBatch();
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
        formSource: 'draft',
        ...(followup ? {} : { repeatKind: 'once', repeatIndex: 0, repeatDays: [] }),
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
  async generateBatch() {
    const text = this.data.utterance.trim();
    if (!text || text.length > 3000) { this.setData({ error: '请填写1至3000字的安排描述' }); return; }
    if (this.data.batch.some((item: BatchItem) => !item.saved)) {
      const result = await wx.showModal({ title: '重新整理？', content: '将替换当前尚未保存的草稿，请先保存需要保留的内容。' });
      if (!result.confirm) return;
    }
    const epoch = ++this._draftEpoch;
    this.setData({ drafting: true, error: '', showForm: false, batchEdit: -1 });
    try {
      const result = await draftsFromText(text);
      if (epoch !== this._draftEpoch) return;
      this.setData({ batch: result.items.map(item => ({ ...item, selected: true, saved: false })), batchNotes: result.notes, batchModel: result.model, draft: null,
        messages: [{ id: 0, role: 'user', text }, { id: 1, role: 'secretary', text: `整理出 ${result.items.length} 类安排。请逐条核对，补充重复起止日期；确认后才会写入。` }] });
    } catch (error) { if (epoch === this._draftEpoch) this.setData({ error: errorMessage(error) }); }
    finally { if (epoch === this._draftEpoch) this.setData({ drafting: false }); }
  },
  toggleBatch(event: WechatMiniprogram.TouchEvent) {
    const index = Number(event.currentTarget.dataset.index);
    const item = this.data.batch[index];
    if (!item || item.saved || this.data.saving || this.data.drafting) return;
    this.setData({ [`batch[${index}].selected`]: !item.selected });
  },
  editBatch(event: WechatMiniprogram.TouchEvent) {
    const index = Number(event.currentTarget.dataset.index), item = this.data.batch[index];
    if (!item || item.saved || item.uncertain || this.data.saving || this.data.drafting) return;
    this.invalidateConflicts();
    this.setData({ batchEdit: index, showForm: true, formSource: 'batch', title: item.title || '', date: item.date || '', startTime: item.startTime || '', endTime: item.endTime || '',
      repeatKind: item.repeatKind, repeatIndex: ['once', 'daily', 'weekly'].indexOf(item.repeatKind), repeatDays: item.weekdays, repeatUntil: item.until || '',
      weekdays: this.data.weekdays.map((day: { value: number; label: string }) => ({ ...day, checked: item.weekdays.includes(day.value) })) });
    wx.pageScrollTo({ selector: '#batch-editor', duration: 200 });
  },
  async saveBatch() {
    if (this.data.saving || this.data.drafting || this.data.checking || this.data.showForm) return;
    const selected = (this.data.batch as BatchItem[]).map((item, index) => ({ item, index })).filter(({ item }) => item.selected && !item.saved);
    if (!selected.length) { this.setData({ error: '请先勾选要保存的安排' }); return; }
    const inputs: Array<{ index: number; input: import('../../services/secretary').ArrangementInput }> = [];
    try {
      for (const { item, index } of selected) {
        const input: import('../../services/secretary').ArrangementInput = { title: item.title || '', date: item.date || '', startTime: item.startTime || '', endTime: item.endTime || '' };
        const invalid = validateDraft(input); if (invalid) throw new Error(`第${index + 1}条：${invalid}`);
        if (item.repeatKind !== 'once') {
          if (!item.until) throw new Error(`第${index + 1}条：请设置重复结束日期`);
          input.repeat = repeatRule({ kind: item.repeatKind, weekdays: item.weekdays, until: item.until }, input.date);
        }
        inputs.push({ index, input });
      }
    } catch (error) { this.setData({ error: errorMessage(error) }); return; }
    this.setData({ saving: true, error: '' });
    const epoch = ++this._checkEpoch;
    let saved = 0;
    try {
      const previews: Arrangement[] = [];
      const overlaps = new Set<string>();
      for (const { index, input } of inputs) {
        const end = input.repeat ? [input.repeat.until!, new Date(Date.parse(input.date) + 30 * 86400000).toISOString().slice(0, 10)].sort()[0] : input.date;
        const existing = await listArrangements(input.date, end);
        const occurrences = input.repeat ? expandRepeat({ ...input, repeat: input.repeat, id: `batch-${index}`, createdAt: '', exceptions: {} }, input.date, end) : [{ ...input, id: `batch-${index}`, createdAt: '' }];
        for (const occurrence of occurrences) for (const conflict of findConflicts(occurrence, [...existing, ...previews])) overlaps.add(`${input.title} / ${conflict.title}`);
        previews.push(...occurrences);
      }
      if (this._disposed || epoch !== this._checkEpoch) return;
      const result = await wx.showModal({ title: `确认写入 ${inputs.length} 类安排？`, content: overlaps.size ? `发现重叠：${[...overlaps].slice(0, 5).join('；')}。仍要保存吗？重复安排检查开始日起31天。` : '已检查开始日起31天内的日程。重复事项将按所选规则和结束日期写入。', confirmText: overlaps.size ? '仍然保存' : '确认写入' });
      if (!result.confirm || this._disposed || epoch !== this._checkEpoch) return;
      for (const { index, input } of inputs) {
        try { await saveArrangement(input); }
        catch (error) {
          if (error instanceof RequestError && error.statusCode === 0) this.setData({ [`batch[${index}].uncertain`]: true });
          throw error;
        }
        saved++;
        this.setData({ [`batch[${index}].saved`]: true, [`batch[${index}].selected`]: false, [`batch[${index}].uncertain`]: false });
      }
      wx.showToast({ title: `已保存${saved}类安排`, icon: 'success' });
      try { const records = await listArrangements(); if (!this._disposed) this.setData({ count: records.length }); } catch { /* 保存状态已记录，数量下次进入时刷新。 */ }
    } catch (error) { this.setData({ error: `本次已保存${saved}类；其余保留供重试。${errorMessage(error)}` }); }
    finally { if (!this._disposed) this.setData({ saving: false }); }
  },
  confirmOverlap() { return this.save(true); },
  async save(allowOverlap: unknown = false) {
    if (this._disposed || this.data.saving || this.data.drafting || this.data.checking) return;
    const { title, date, startTime, endTime } = this.data;
    const input: import('../../services/secretary').ArrangementInput = { title: title.trim(), date, startTime, endTime };
    if (this.data.repeatKind !== 'once') {
      try { input.repeat = repeatRule({ kind: this.data.repeatKind, weekdays: this.data.repeatDays, until: this.data.repeatUntil }, date); }
      catch (error) { this.setData({ error: errorMessage(error) }); return; }
    }
    const invalid = validateDraft(input);
    if (invalid) { this.invalidateConflicts(); this.setData({ error: invalid }); return; }
    if (this.data.formSource === 'batch' && this.data.batchEdit >= 0) {
      if (input.repeat && !input.repeat.until) { this.setData({ error: '请设置重复结束日期' }); return; }
      const index = this.data.batchEdit;
      this.setData({ [`batch[${index}]`]: { ...this.data.batch[index], ...input, repeatKind: this.data.repeatKind, weekdays: this.data.repeatDays, until: input.repeat?.until || null, status: 'READY', missing: [] }, showForm: false, batchEdit: -1 });
      return;
    }
    const epoch = ++this._checkEpoch;
    const reviewed = allowOverlap === true ? this._conflictSignature : '';
    this.setData({ checking: true, error: '' });
    try {
      const checkedEnd = input.repeat ? input.repeat.until && input.repeat.until < new Date(Date.parse(date) + 30 * 86400000).toISOString().slice(0, 10) ? input.repeat.until : new Date(Date.parse(date) + 30 * 86400000).toISOString().slice(0, 10) : date;
      const items = await listArrangements(date, checkedEnd);
      if (epoch !== this._checkEpoch) return;
      const occurrences = input.repeat ? expandRepeat({ ...input, repeat: input.repeat, id: 'preview', createdAt: '', exceptions: {} } as RepeatSeries, date, checkedEnd) : [input];
      const conflicts = items.filter(item => occurrences.some(occurrence => findConflicts(occurrence, [item]).length > 0));
      const signature = conflictSignature(input, conflicts) + JSON.stringify(input.repeat);
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
      this.setData({ showForm: false, title: '', utterance: '', draft: null, draftMemoryNote: '', turns: 0, repeatKind: 'once', repeatIndex: 0, repeatDays: [],
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
