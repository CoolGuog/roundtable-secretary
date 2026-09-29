import { BadRequestException } from '@nestjs/common';
import { inputObject } from './store';

export type MemoryInput = { category: 'PREFERENCE' | 'CONSTRAINT' | 'NOTE'; label: string; content: string };
export type PersonalMemory = MemoryInput & { id: string; source: 'USER_INPUT' | 'SECRETARY'; createdAt: string; updatedAt: string };

export function validateMemory(value: unknown): MemoryInput {
  const input = inputObject(value);
  if (Object.keys(input).some(key => !['category', 'label', 'content'].includes(key))) throw new BadRequestException('不支持额外字段');
  if (!['PREFERENCE', 'CONSTRAINT', 'NOTE'].includes(input.category as string)) throw new BadRequestException('请选择偏好、限制或备忘');
  if (typeof input.label !== 'string' || !input.label.trim() || input.label.trim().length > 40) throw new BadRequestException('标题须为 1 至 40 字');
  if (typeof input.content !== 'string' || !input.content.trim() || input.content.trim().length > 500) throw new BadRequestException('内容须为 1 至 500 字');
  return { category: input.category as MemoryInput['category'], label: input.label.trim(), content: input.content.trim() };
}
