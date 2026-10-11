import type { Arrangement, ArrangementInput } from './secretary';

export function validateDraft(input: ArrangementInput): string {
  if (!input.title.trim() || !input.date || !input.startTime || !input.endTime) return '请补全名称、日期和起止时间后再保存';
  if (input.title.trim().length > 60) return '安排名称请控制在 60 字以内';
  const date = new Date(input.date + 'T00:00:00Z');
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(input.date) || input.date < '2020-01-01' ||
      !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== input.date) return '请选择有效日期（2020—2099 年）';
  const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (!clock.test(input.startTime) || !clock.test(input.endTime) || input.startTime >= input.endTime) return '结束时间须晚于开始时间，当前仅支持同日安排';
  return '';
}

// 半开区间：上一条结束时立即开始下一条不算重叠。只接收当前用户自己的列表。
export function findConflicts(input: ArrangementInput, items: Arrangement[]): Arrangement[] {
  return items.filter(item => item.date === input.date && item.startTime < input.endTime && input.startTime < item.endTime)
    .sort((a, b) => `${a.startTime} ${a.endTime} ${a.id}`.localeCompare(`${b.startTime} ${b.endTime} ${b.id}`));
}

// 二次确认只针对用户看过的草稿和冲突；其他设备修改后必须重新展示。
export function conflictSignature(input: ArrangementInput, conflicts: Arrangement[]): string {
  return JSON.stringify([input.title, input.date, input.startTime, input.endTime,
    conflicts.map(item => [item.id, item.title, item.date, item.startTime, item.endTime])]);
}
