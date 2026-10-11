/** 存储探测共享正在执行的请求，短暂缓存结果；超时后也不堆积新的数据库查询。 */
export class Readiness {
  private pending?: Promise<boolean>;
  private completed?: { ok: boolean; at: number };
  constructor(private readonly probe: () => void | Promise<void>, private readonly timeoutMs = 2000,
    private readonly cacheMs = 1000, private readonly clock = Date.now) {}
  async check(): Promise<boolean> {
    if (this.completed && this.clock() - this.completed.at < this.cacheMs) return this.completed.ok;
    if (!this.pending) {
      this.pending = Promise.resolve().then(() => this.probe()).then(() => true, () => false).then(ok => {
        this.completed = { ok, at: this.clock() }; this.pending = undefined; return ok;
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.pending, new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), this.timeoutMs); })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
}

export const READINESS = Symbol('readiness');
