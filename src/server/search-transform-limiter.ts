export class SearchTransformLimiter {
  private active = 0;
  private readonly activeBySession = new Map<string, number>();

  get activeCount(): number {
    return this.active;
  }

  acquire(
    sessionId: string,
    maxGlobal: number,
    maxPerSession: number
  ): (() => void) | null {
    const sessionActive = this.activeBySession.get(sessionId) ?? 0;
    if (this.active >= maxGlobal || sessionActive >= maxPerSession) return null;
    this.active += 1;
    this.activeBySession.set(sessionId, sessionActive + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const remaining = (this.activeBySession.get(sessionId) ?? 1) - 1;
      if (remaining <= 0) this.activeBySession.delete(sessionId);
      else this.activeBySession.set(sessionId, remaining);
    };
  }
}
