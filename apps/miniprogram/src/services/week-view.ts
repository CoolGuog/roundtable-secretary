import type { Arrangement } from './secretary';
import type { WorkTask } from './meeting-work';
export const shiftDate = (date: string, days: number) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400_000).toISOString().slice(0, 10);
export function weekStart(date: string): string {
  const parsed = new Date(date + 'T00:00:00Z');
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(date) || date < '2020-01-01' || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error('请选择 2020—2099 年的有效日期');
  return shiftDate(date, -((parsed.getUTCDay() + 6) % 7));
}
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
export function weeklyView(items: Arrangement[], tasks: WorkTask[] | null, anchor: string, now = new Date()) {
  const start = weekStart(anchor), end = shiftDate(start, 6);
  const instant = new Date(now.getTime() + 8 * 3600_000).toISOString(), today = instant.slice(0, 10), clock = instant.slice(11, 16);
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = shiftDate(start, index);
    const records = items.filter(item => item.date === date).sort((a, b) => `${a.startTime} ${a.endTime} ${a.id}`.localeCompare(`${b.startTime} ${b.endTime} ${b.id}`));
    let occupied = 0, until = 0, scheduled = 0;
    for (const item of records) {
      const from = minutes(item.startTime), to = minutes(item.endTime);
      scheduled += to - from; occupied += Math.max(0, to - Math.max(from, until)); until = Math.max(until, to);
    }
    return { date, label: `${date === today ? '今天 · ' : ''}周${'一二三四五六日'[index]} · ${date}`, occupiedMinutes: occupied, scheduledMinutes: scheduled,
      records: records.map(item => ({ ...item, stateLabel: `${item.date} ${item.endTime}` <= `${today} ${clock}` ? '已结束'
        : `${item.date} ${item.startTime}` <= `${today} ${clock}` ? '进行中' : '待开始' })) };
  });
  const inWeek = tasks?.filter(task => task.dueDate >= start && task.dueDate <= end) ?? [];
  return { start, end, days, canPrevious: shiftDate(start, -1) >= '2020-01-01', canNext: shiftDate(start, 7) <= '2099-12-31',
    stats: { count: days.reduce((sum, day) => sum + day.records.length, 0),
      occupiedMinutes: days.reduce((sum, day) => sum + day.occupiedMinutes, 0),
      ended: days.reduce((sum, day) => sum + day.records.filter(item => item.stateLabel === '已结束').length, 0),
      taskCount: inWeek.length, taskDone: inWeek.filter(task => task.state === 'DONE').length,
      taskPending: inWeek.filter(task => task.state !== 'DONE').length, taskOverdue: inWeek.filter(task => task.state !== 'DONE' && task.dueDate < today).length },
    taskStatsAvailable: tasks !== null };
}
