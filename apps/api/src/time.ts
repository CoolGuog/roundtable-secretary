// 北京时间规则的唯一来源：后端与小程序都以「北京时间（UTC+8）」解释日期与时刻。
// 中国全境不使用夏令时，偏移量恒为 +8 小时，因此用固定偏移换算是安全的，
// 不需要引入 tz 数据库；存储层仍然保存绝对时间，只在输入输出时做换算。
export const TIME_ZONE = 'Asia/Shanghai';
export const UTC_OFFSET_HOURS = 8;
const OFFSET_MS = UTC_OFFSET_HOURS * 3600_000;

function shiftedIso(date: Date): string {
  return new Date(date.getTime() + OFFSET_MS).toISOString();
}

/** 绝对时间 → 北京时间日期（YYYY-MM-DD） */
export function beijingDate(date: Date): string {
  return shiftedIso(date).slice(0, 10);
}

/** 绝对时间 → 北京时间时刻（HH:mm） */
export function beijingTime(date: Date): string {
  return shiftedIso(date).slice(11, 16);
}

/** 北京时间「日期 + 时刻」→ 绝对时间；日期或时刻非法时返回无效 Date */
export function beijingInstant(date: string, time: string): Date {
  return new Date(`${date}T${time}:00.000+08:00`);
}

/** 当前的北京时间日期（YYYY-MM-DD），用于默认选中"今天" */
export function beijingToday(): string {
  return beijingDate(new Date());
}
