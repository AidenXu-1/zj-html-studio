import { describe, expect, it } from "vitest";
import {
  createVerifiedEmbedSession,
  decideEmbedReload,
  decideInterruptedEmbedLoad,
  EmbedCandidateReadiness,
  hasActiveEmbedWork
} from "../src/embed/embed-lifecycle";
import { EmbedSessionCancelledError } from "../src/embed/embed-session-limiter";

describe("HTML embed lifecycle", () => {
  it("releases a slot when the current load becomes invisible or unloads", () => {
    expect(decideInterruptedEmbedLoad({
      currentGeneration: 4,
      generation: 4,
      isVisible: false,
      unloaded: false
    })).toBe("release");
    expect(decideInterruptedEmbedLoad({
      currentGeneration: 4,
      generation: 4,
      isVisible: true,
      unloaded: true
    })).toBe("release");
  });

  it("does not release a shared slot from an older load", () => {
    expect(decideInterruptedEmbedLoad({
      currentGeneration: 5,
      generation: 4,
      isVisible: true,
      unloaded: false
    })).toBe("ignore");
    expect(decideInterruptedEmbedLoad({
      currentGeneration: 5,
      generation: 4,
      isVisible: false,
      unloaded: false
    })).toBe("ignore");
    expect(decideInterruptedEmbedLoad({
      currentGeneration: 5,
      generation: 4,
      isVisible: false,
      unloaded: true
    })).toBe("ignore");
  });

  it("continues only the current visible load", () => {
    expect(decideInterruptedEmbedLoad({
      currentGeneration: 4,
      generation: 4,
      isVisible: true,
      unloaded: false
    })).toBe("continue");
  });

  it("does not schedule offscreen cleanup for an embed that never started", () => {
    expect(hasActiveEmbedWork({ acquiring: false, hasSession: false, hasSlot: false })).toBe(false);
    expect(hasActiveEmbedWork({ acquiring: true, hasSession: false, hasSlot: false })).toBe(true);
    expect(hasActiveEmbedWork({ acquiring: false, hasSession: true, hasSlot: true })).toBe(true);
  });

  it("defers reloads while offscreen and ignores them when auto reload is disabled", () => {
    expect(decideEmbedReload(true, false, true)).toBe("defer");
    expect(decideEmbedReload(true, true, false)).toBe("defer");
    expect(decideEmbedReload(false, false, true)).toBe("ignore");
  });

  it("reloads a visible embed that owns an active slot", () => {
    expect(decideEmbedReload(true, true, true)).toBe("reload");
  });

  it("promotes an embed candidate only after both the real response and iframe load finish", () => {
    const responseFirst = new EmbedCandidateReadiness();
    responseFirst.markResponseFinished();
    expect(responseFirst.ready).toBe(false);
    responseFirst.markIframeLoaded();
    expect(responseFirst.ready).toBe(true);

    const iframeFirst = new EmbedCandidateReadiness();
    iframeFirst.markIframeLoaded();
    expect(iframeFirst.ready).toBe(false);
    iframeFirst.markResponseFinished();
    expect(iframeFirst.ready).toBe(true);
  });

  it("revokes a provisional session when its in-flight probe is cancelled", async () => {
    const session = { token: "provisional" };
    const revoked: string[] = [];
    const cancelled = new Error("cancelled");

    await expect(createVerifiedEmbedSession(
      async () => session,
      async () => {
        throw cancelled;
      },
      async candidate => {
        revoked.push(candidate.token);
      }
    )).rejects.toBe(cancelled);
    expect(revoked).toEqual(["provisional"]);
  });

  it("transfers ownership only after verification succeeds", async () => {
    const session = { token: "verified" };
    let revokeCount = 0;

    await expect(createVerifiedEmbedSession(
      async () => session,
      async () => undefined,
      async () => {
        revokeCount += 1;
      }
    )).resolves.toBe(session);
    expect(revokeCount).toBe(0);
  });

  it("revokes after a slow create is cancelled without starting the probe", async () => {
    const session = { token: "late" };
    let verifyCount = 0;
    let revokeCount = 0;

    await expect(createVerifiedEmbedSession(
      async () => session,
      async () => {
        verifyCount += 1;
      },
      async () => {
        revokeCount += 1;
      },
      () => false
    )).rejects.toBeInstanceOf(EmbedSessionCancelledError);
    expect(verifyCount).toBe(0);
    expect(revokeCount).toBe(1);
  });
});
