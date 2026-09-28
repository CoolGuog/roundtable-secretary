import { BadRequestException } from '@nestjs/common';

export type ArrangementInput = { title: string; date: string; startTime: string; endTime: string };
export type Arrangement = ArrangementInput & { id: string; createdAt: string };
export type User = { id: string; name: string; secretaryName: string };
export const STORE = Symbol('personal-store');
export interface PersonalStore {
  readonly persistence: 'memory' | 'postgres';
  createSession(value: unknown): unknown;
  authenticate(token: string): string | Promise<string>;
  profile(userId: string): User | Promise<User>;
  list(userId: string): Arrangement[] | Promise<Arrangement[]>;
  create(userId: string, value: unknown): Arrangement | Promise<Arrangement>;
  update(userId: string, id: string, value: unknown): Arrangement | Promise<Arrangement>;
  remove(userId: string, id: string): void | Promise<void>;
}
export function inputObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('请求格式不正确');
  return value as Record<string, unknown>;
}
export function validateName(value: unknown): string {
  const { name } = inputObject(value);
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 20) throw new BadRequestException('名称须为 1 至 20 字');
  return name.trim();
}
export function validateArrangement(value: unknown): ArrangementInput {
  const input = inputObject(value);
  if (Object.keys(input).some(key => !['title', 'date', 'startTime', 'endTime'].includes(key))) throw new BadRequestException('不支持额外字段');
  const { title, date, startTime, endTime } = input;
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 60) throw new BadRequestException('请填写 1 至 60 字的安排名称');
  if (typeof date !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException('日期格式不正确');
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new BadRequestException('日期不存在');
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (typeof startTime !== 'string' || typeof endTime !== 'string' || !timePattern.test(startTime) || !timePattern.test(endTime) || startTime >= endTime) {
    throw new BadRequestException('结束时间须晚于开始时间，首版仅支持同日安排');
  }
  return { title: title.trim(), date, startTime, endTime };
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 编辑只校验"传了哪些字段"，跨字段规则（开始早于结束）在合并后统一走 validateArrangement。 */
export function validateArrangementPatch(value: unknown): Partial<ArrangementInput> {
  const input = inputObject(value);
  const keys = Object.keys(input);
  if (keys.length === 0) throw new BadRequestException('没有需要修改的内容');
  if (keys.some(key => !['title', 'date', 'startTime', 'endTime'].includes(key))) throw new BadRequestException('不支持额外字段');
  const patch: Partial<ArrangementInput> = {};
  if ('title' in input) {
    const { title } = input;
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 60) throw new BadRequestException('请填写 1 至 60 字的安排名称');
    patch.title = title.trim();
  }
  if ('date' in input) {
    const { date } = input;
    if (typeof date !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException('日期格式不正确');
    const parsed = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new BadRequestException('日期不存在');
    patch.date = date;
  }
  for (const key of ['startTime', 'endTime'] as const) {
    if (!(key in input)) continue;
    const time = input[key];
    if (typeof time !== 'string' || !TIME_PATTERN.test(time)) throw new BadRequestException('时间格式不正确');
    patch[key] = time;
  }
  return patch;
}
