export interface HtmlSnapshotLimiterOptions {
  maxActive: number;
  maxActivePerSession: number;
  maxPending: number;
  maxPendingPerSession: number;
  waitTimeoutMs: number;
}

export type HtmlSnapshotPermitResult =
  | { release: () => void; status: "acquired" }
  | { status: "cancelled" }
  | { status: "rejected"; statusCode: 429 | 503 };

interface PendingPermit {
  abort: () => void;
  resolve: (result: HtmlSnapshotPermitResult) => void;
  sessionId: string;
  signal: AbortSignal;
  timer: ReturnType<typeof scheduleWaitTimeout>;
}

export class HtmlSnapshotLimiter {
  private active = 0;
  private readonly activeBySession = new Map<string, number>();
  private readonly pending: PendingPermit[] = [];
  private stopped = false;

  constructor(private readonly options: HtmlSnapshotLimiterOptions) {}

  get activeCount(): number {
    return this.active;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  acquire(sessionId: string, signal: AbortSignal): Promise<HtmlSnapshotPermitResult> {
    if (signal.aborted) return Promise.resolve({ status: "cancelled" });
    if (this.stopped) return Promise.resolve({ status: "rejected", statusCode: 503 });
    if (this.canAcquire(sessionId)) {
      return Promise.resolve(this.createPermit(sessionId));
    }

    const pendingForSession = this.pending.reduce(
      (count, item) => count + Number(item.sessionId === sessionId),
      0
    );
    if (pendingForSession >= this.options.maxPendingPerSession) {
      return Promise.resolve({ status: "rejected", statusCode: 429 });
    }
    if (this.pending.length >= this.options.maxPending) {
      return Promise.resolve({ status: "rejected", statusCode: 503 });
    }

    return new Promise(resolve => {
      const entry: PendingPermit = {
        abort: () => this.settlePending(entry, { status: "cancelled" }),
        resolve,
        sessionId,
        signal,
        timer: scheduleWaitTimeout(() => {
          this.settlePending(entry, { status: "rejected", statusCode: 503 });
        }, this.options.waitTimeoutMs)
      };
      this.pending.push(entry);
      signal.addEventListener("abort", entry.abort, { once: true });
    });
  }

  cancelSession(sessionId: string): void {
    [...this.pending]
      .filter(entry => entry.sessionId === sessionId)
      .forEach(entry => this.settlePending(entry, { status: "cancelled" }));
  }

  stop(): void {
    this.stopped = true;
    [...this.pending].forEach(entry => this.settlePending(entry, { status: "cancelled" }));
  }

  private canAcquire(sessionId: string): boolean {
    return this.active < this.options.maxActive
      && (this.activeBySession.get(sessionId) ?? 0) < this.options.maxActivePerSession;
  }

  private createPermit(sessionId: string): HtmlSnapshotPermitResult {
    this.active += 1;
    this.activeBySession.set(sessionId, (this.activeBySession.get(sessionId) ?? 0) + 1);
    let released = false;
    return {
      status: "acquired",
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
        const remaining = (this.activeBySession.get(sessionId) ?? 1) - 1;
        if (remaining === 0) this.activeBySession.delete(sessionId);
        else this.activeBySession.set(sessionId, remaining);
        this.drain();
      }
    };
  }

  private settlePending(entry: PendingPermit, result: HtmlSnapshotPermitResult): void {
    const index = this.pending.indexOf(entry);
    if (index < 0) return;
    this.pending.splice(index, 1);
    cancelWaitTimeout(entry.timer);
    entry.signal.removeEventListener("abort", entry.abort);
    entry.resolve(result);
    this.drain();
  }

  private drain(): void {
    if (this.stopped) return;
    while (this.active < this.options.maxActive) {
      const index = this.pending.findIndex(entry => this.canAcquire(entry.sessionId));
      if (index < 0) return;
      const entry = this.pending.splice(index, 1)[0]!;
      cancelWaitTimeout(entry.timer);
      entry.signal.removeEventListener("abort", entry.abort);
      if (entry.signal.aborted) {
        entry.resolve({ status: "cancelled" });
        continue;
      }
      entry.resolve(this.createPermit(entry.sessionId));
    }
  }
}
import { clearTimeout as cancelWaitTimeout, setTimeout as scheduleWaitTimeout } from "node:timers";
