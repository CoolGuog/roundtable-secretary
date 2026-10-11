import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ArrangementInput } from './store';

export function requestKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) {
    throw new BadRequestException('保存请求编号格式不正确');
  }
  return value.toLowerCase();
}
export function arrangementFingerprint(input: ArrangementInput): string {
  return createHash('sha256').update(JSON.stringify([input.title, input.date, input.startTime, input.endTime])).digest('hex');
}
export function assertReplay(hash: string, expected: string, exists: boolean) {
  if (hash !== expected) throw new ConflictException('同一次保存的内容已变化，请先查看日程再重新创建');
  if (!exists) throw new ConflictException('这次保存的日程已被删除，请刷新查看，不会自动重新创建');
}
