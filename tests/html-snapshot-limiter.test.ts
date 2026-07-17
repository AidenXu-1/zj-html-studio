import { describe, expect, it } from "vitest";
import { HtmlSnapshotLimiter } from "../src/server/html-snapshot-limiter";

function createLimiter(overrides: Partial<ConstructorParameters<typeof HtmlSnapshotLimiter>[0]> = {}): HtmlSnapshotLimiter {
  return new HtmlSnapshotLimiter({
    maxActive: 2,
    maxActivePerSession: 1,
    maxPending: 4,
    maxPendingPerSession: 2,
    waitTimeoutMs: 100,
    ...overrides
  });
}

describe("HTML snapshot limiter", () => {
  it("queues a normal multi-tab burst without exceeding active memory permits", async () => {
    const limiter = createLimiter();
    const signal = new AbortController().signal;
    const first = await limiter.acquire("one", signal);
    const second = await limiter.acquire("two", signal);
    const thirdPromise = limiter.acquire("three", signal);

    expect(first.status).toBe("acquired");
    expect(second.status).toBe("acquired");
    expect(limiter.activeCount).toBe(2);
    expect(limiter.pendingCount).toBe(1);
    if (first.status === "acquired") first.release();
    const third = await thirdPromise;
    expect(third.status).toBe("acquired");
    expect(limiter.activeCount).toBe(2);

    if (second.status === "acquired") second.release();
    if (third.status === "acquired") third.release();
    expect(limiter.activeCount).toBe(0);
    expect(limiter.pendingCount).toBe(0);
  });

  it("does not let a busy session block an eligible queued session", async () => {
    const limiter = createLimiter({ maxActive: 2 });
    const signal = new AbortController().signal;
    const first = await limiter.acquire("one", signal);
    const sameSession = limiter.acquire("one", signal);
    const other = await limiter.acquire("two", signal);

    expect(other.status).toBe("acquired");
    expect(limiter.pendingCount).toBe(1);
    if (other.status === "acquired") other.release();
    expect(limiter.pendingCount).toBe(1);
    if (first.status === "acquired") first.release();
    const same = await sameSession;
    expect(same.status).toBe("acquired");
    if (same.status === "acquired") same.release();
  });

  it("cancels queued work on request abort, session revoke, and permanent stop", async () => {
    const limiter = createLimiter({ maxActive: 1 });
    const active = await limiter.acquire("active", new AbortController().signal);
    const abortedController = new AbortController();
    const aborted = limiter.acquire("aborted", abortedController.signal);
    const revoked = limiter.acquire("revoked", new AbortController().signal);
    const stopped = limiter.acquire("stopped", new AbortController().signal);

    abortedController.abort();
    limiter.cancelSession("revoked");
    limiter.stop();
    await expect(aborted).resolves.toEqual({ status: "cancelled" });
    await expect(revoked).resolves.toEqual({ status: "cancelled" });
    await expect(stopped).resolves.toEqual({ status: "cancelled" });
    if (active.status === "acquired") active.release();
    expect(limiter.pendingCount).toBe(0);
  });

  it("bounds queued work per session and globally", async () => {
    const limiter = createLimiter({ maxActive: 1, maxPending: 2, maxPendingPerSession: 1 });
    const signal = new AbortController().signal;
    const active = await limiter.acquire("active", signal);
    void limiter.acquire("one", signal);
    await expect(limiter.acquire("one", signal)).resolves.toEqual({ status: "rejected", statusCode: 429 });
    void limiter.acquire("two", signal);
    await expect(limiter.acquire("three", signal)).resolves.toEqual({ status: "rejected", statusCode: 503 });
    limiter.stop();
    if (active.status === "acquired") active.release();
  });

  it("times out queued work without leaking capacity", async () => {
    const limiter = createLimiter({ maxActive: 1, waitTimeoutMs: 10 });
    const signal = new AbortController().signal;
    const active = await limiter.acquire("active", signal);

    await expect(limiter.acquire("waiting", signal))
      .resolves.toEqual({ status: "rejected", statusCode: 503 });
    expect(limiter.pendingCount).toBe(0);
    if (active.status === "acquired") active.release();
    expect(limiter.activeCount).toBe(0);
  });
});
