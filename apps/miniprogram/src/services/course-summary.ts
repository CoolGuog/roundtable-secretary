import type { BatchItem } from './secretary';
export type CourseFailure = { title: string; reason: string };
export function summarizeCourses(items: BatchItem[], omitted: CourseFailure[]) {
  const failures: CourseFailure[] = [...omitted];
  let recognized = 0;
  for (const item of items) {
    const problems: string[] = [];
    if (item.recognitionIssue) problems.push(item.recognitionIssue);
    else if (/[.…]{2,}|…/.test(item.title || '')) problems.push('截图文字被截断，请补充完整名称或教室');
    if (!item.title) problems.push('课程名称未识别');
    if (!item.startTime || !item.endTime) problems.push('起止时间不完整');
    if (!item.date || (item.repeatKind !== 'once' && !item.until)) problems.push('日期范围待补充');
    if (item.repeatKind === 'weekly' && !item.weekdays?.length) problems.push('星期未识别');
    if (problems.length) failures.push({ title: item.title || '未辨认课程', reason: [...new Set(problems)].join('；') });
    else recognized++;
  }
  return { recognized, failures };
}
