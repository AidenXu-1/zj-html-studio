interface Waiter {
  id: string;
  reject: (error: Error) => void;
  resolve: (release: () => void) => void;
}

export class EmbedSessionCancelledError extends Error {
  constructor() {
    super("嵌入预览排队已取消");
    this.name = "EmbedSessionCancelledError";
  }
}

export class EmbedSessionLimiter {
  private readonly active = new Set<string>();
  private readonly waiters: Waiter[] = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("嵌入会话上限必须是正整数");
  }

  get activeCount(): number {
    return this.active.size;
  }

  get waitingCount(): number {
    return this.waiters.length;
  }

  acquire(id: string): Promise<() => void> {
    if (this.active.has(id) || this.waiters.some(waiter => waiter.id === id)) {
      return Promise.reject(new Error("同一嵌入不能重复申请会话"));
    }
    if (this.active.size < this.limit) return Promise.resolve(this.activate(id));
    return new Promise((resolve, reject) => this.waiters.push({ id, reject, resolve }));
  }

  cancel(id: string): void {
    const index = this.waiters.findIndex(waiter => waiter.id === id);
    if (index < 0) return;
    const [waiter] = this.waiters.splice(index, 1);
    waiter?.reject(new EmbedSessionCancelledError());
  }

  private activate(id: string): () => void {
    this.active.add(id);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active.delete(id);
      this.activateNext();
    };
  }

  private activateNext(): void {
    const waiter = this.waiters.shift();
    if (!waiter) return;
    waiter.resolve(this.activate(waiter.id));
  }
}
