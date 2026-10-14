import { BadRequestException, NotFoundException, HttpException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { inputObject, validateArrangement } from './store';
import { requestKey, assertReplay } from './arrangement-request';
import { RepeatSeries, repeatRule, expandRepeat, occurrenceId, occurs, reviseRepeat } from './repeat-engine';

export class RepeatedArrangements {
  private memory = new Map<string, { ownerId: string; document: RepeatSeries; requestKey: string | null; fingerprint: string }>();
  constructor(private db?: PrismaClient) {}
  private async transaction<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt++) {
      try { return await this.db!.$transaction(run, { isolationLevel: 'Serializable' }); }
      catch (error) {
        if (error instanceof HttpException) throw error;
        if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2034', 'P2002'].includes(error.code) && attempt < 3) continue;
        throw new ServiceUnavailableException('重复安排暂时无法保存，请刷新后重试');
      }
    }
    throw new ServiceUnavailableException('重复安排暂时无法保存，请刷新后重试');
  }
  async documents(ownerId: string): Promise<RepeatSeries[]> {
    if (this.db) return (await this.db.recurringArrangement.findMany({ where: { ownerId } })).map(row => row.document as unknown as RepeatSeries);
    return [...this.memory.values()].filter(row => row.ownerId === ownerId).map(row => structuredClone(row.document));
  }
  async list(ownerId: string, from: string, to: string) { return (await this.documents(ownerId)).flatMap(series => expandRepeat(series, from, to)); }
  async create(ownerId: string, value: unknown, requestId?: unknown) {
    try {
      const input = inputObject(value), { repeat, ...base } = input;
      const fields = validateArrangement(base), rule = repeatRule(repeat, fields.date);
      const key = requestKey(requestId) ?? null, fingerprint = JSON.stringify({ ...fields, repeat: rule });
      const document: RepeatSeries = { ...fields, repeat: rule, id: randomUUID(), createdAt: new Date().toISOString(), exceptions: {} };
      if (this.db) return await this.transaction(async tx => {
        const old = key ? await tx.recurringArrangement.findUnique({ where: { ownerId_requestKey: { ownerId, requestKey: key } } }) : null;
        if (old) { assertReplay(old.fingerprint, fingerprint, true); return old.document; }
        if (await tx.recurringArrangement.count({ where: { ownerId } }) >= 500) throw new BadRequestException('重复安排及修改版本最多保存 500 组');
        await tx.recurringArrangement.create({ data: { id: document.id, ownerId, document: document as unknown as Prisma.InputJsonValue, requestKey: key, fingerprint } });
        return document;
      });
      const rows = [...this.memory.values()].filter(row => row.ownerId === ownerId);
      const old = key ? rows.find(row => row.requestKey === key) : undefined;
      if (old) { assertReplay(old.fingerprint, fingerprint, true); return old.document; }
      if (rows.length >= 500) throw new Error('重复安排及修改版本最多保存 500 组');
      this.memory.set(document.id, { ownerId, document, requestKey: key, fingerprint }); return document;
    } catch (error) { if (error instanceof HttpException) throw error; throw new BadRequestException(error instanceof Error ? error.message : '无法保存重复安排'); }
  }
  async change(ownerId: string, id: string, scope: unknown, value: unknown | null) {
    let parsed: ReturnType<typeof occurrenceId>;
    try { parsed = occurrenceId(id); } catch { throw new NotFoundException('重复安排不存在'); }
    const apply = (series: RepeatSeries) => {
      if (!occurs(series, parsed.date) || series.exceptions[parsed.date] === null) throw new NotFoundException('重复安排不存在');
      const { repeatUntil, ...fields } = value === null ? {} : inputObject(value);
      const input = value === null ? null : validateArrangement(fields);
      try {
        const changed = reviseRepeat(series, parsed.date, scope, input, repeatUntil);
        if (changed.next) changed.next = { ...changed.next, id: randomUUID(), createdAt: new Date().toISOString() };
        return changed;
      } catch (error) { throw new BadRequestException(error instanceof Error ? error.message : '重复安排操作失败'); }
    };
    if (this.db) return this.transaction(async tx => {
      const row = await tx.recurringArrangement.findFirst({ where: { id: parsed.seriesId, ownerId } });
      if (!row) throw new NotFoundException('重复安排不存在');
      const changed = apply(row.document as unknown as RepeatSeries);
      if (changed.next && await tx.recurringArrangement.count({ where: { ownerId } }) >= 500) throw new BadRequestException('重复安排及修改版本已达上限');
      await tx.recurringArrangement.update({ where: { id: row.id }, data: { document: changed.previous as unknown as Prisma.InputJsonValue } });
      if (changed.next) await tx.recurringArrangement.create({ data: { id: changed.next.id, ownerId, document: changed.next as unknown as Prisma.InputJsonValue, fingerprint: '', requestKey: null } });
    });
    const row = this.memory.get(parsed.seriesId);
    if (!row || row.ownerId !== ownerId) throw new NotFoundException('重复安排不存在');
    const changed = apply(row.document);
    if (changed.next && [...this.memory.values()].filter(item => item.ownerId === ownerId).length >= 500) throw new BadRequestException('重复安排及修改版本已达上限');
    row.document = changed.previous;
    if (changed.next) this.memory.set(changed.next.id, { ownerId, document: changed.next, fingerprint: '', requestKey: null });
  }
}
