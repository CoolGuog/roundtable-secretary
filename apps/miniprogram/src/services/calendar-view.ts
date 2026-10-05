import type { Arrangement } from './secretary';

export type CalendarFilter = 'all' | 'today' | 'upcoming' | 'past';
export type CalendarRecord = Arrangement & { state: string; stateLabel: string };
export type CalendarGroup = { date: string; label: string; records: CalendarRecord[] };
export const calendarFilters: Array<{ value: CalendarFilter; label: string }> = [
  { value: 'all', label: '全部' }, { value: 'today', label: '今天' },
  { value: 'upcoming', label: '未结束' }, { value: 'past', label: '已结束' },
];

// 仅生成当前账号列表的显示数据，不写入、删除或发起网络请求。
export function calendarView(items: Arrangement[], query: string, filter: CalendarFilter, date: string, now = new Date()) {
  const beijing = new Date(now.getTime() + 8 * 3600_000).toISOString();
  const today = beijing.slice(0, 10), clock = `${today} ${beijing.slice(11, 16)}`;
  const tomorrow = new Date(new Date(today + 'T00:00:00Z').getTime() + 86400_000).toISOString().slice(0, 10);
  const needle = query.trim().toLocaleLowerCase();
  const groups: CalendarGroup[] = [];
  let matchingCount = 0;
  const counts = { all: items.length, today: 0, upcoming: 0, past: 0 };
  for (const item of [...items].sort((a, b) => `${a.date} ${a.startTime} ${a.endTime} ${a.id}`.localeCompare(`${b.date} ${b.startTime} ${b.endTime} ${b.id}`))) {
    const ended = `${item.date} ${item.endTime}` <= clock;
    const started = `${item.date} ${item.startTime}` <= clock;
    const isToday = item.date === today;
    if (isToday) counts.today++;
    counts[ended ? 'past' : 'upcoming']++;
    if ((needle && !item.title.toLocaleLowerCase().includes(needle)) || (date && date !== item.date) ||
        (filter === 'today' && !isToday) || (filter === 'upcoming' && ended) || (filter === 'past' && !ended)) continue;
    matchingCount++;
    let group = groups[groups.length - 1];
    if (!group || group.date !== item.date) {
      const weekday = new Date(item.date + 'T00:00:00Z').getUTCDay();
      const prefix = isToday ? '今天 · ' : item.date === tomorrow ? '明天 · ' : '';
      group = { date: item.date, label: `${prefix}${item.date} · 周${'日一二三四五六'[weekday]}`, records: [] };
      groups.push(group);
    }
    group.records.push({ ...item, state: ended ? 'past' : started ? 'ongoing' : 'future',
      stateLabel: ended ? '已结束' : started ? '进行中' : '待开始' });
  }
  return { groups, matchingCount, counts, filterActive: Boolean(needle || date || filter !== 'all') };
}
