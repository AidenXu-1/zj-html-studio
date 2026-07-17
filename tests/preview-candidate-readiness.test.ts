import { describe, expect, it } from "vitest";
import { PreviewCandidateReadiness } from "../src/view/preview-candidate-readiness";

describe("preview candidate readiness", () => {
  it("requires the real GET ticket and iframe load for a non-bridge page", () => {
    const state = new PreviewCandidateReadiness(false);
    state.configureBridgeRequirement(false);
    state.markTicketReady();
    expect(state.ready).toBe(false);
    state.markIframeLoaded();
    expect(state.ready).toBe(true);
  });

  it("rejects an early bridge until the loaded document reconnects", () => {
    const state = new PreviewCandidateReadiness(false);
    state.configureBridgeRequirement(true);
    state.markBridgeReady();
    state.markTicketReady();
    state.markIframeLoaded();
    expect(state.ready).toBe(false);
    state.markBridgeReady();
    expect(state.ready).toBe(true);
  });

  it("waits for scroll restoration after the post-load bridge", () => {
    const state = new PreviewCandidateReadiness(true);
    state.configureBridgeRequirement(true);
    state.markTicketReady();
    state.markIframeLoaded();
    state.markBridgeReady();
    expect(state.canSendRestore).toBe(true);
    expect(state.ready).toBe(false);
    state.markRestoreReady();
    expect(state.ready).toBe(true);
  });

  it("waits for the ticket to reveal whether the target page has a bridge", () => {
    const state = new PreviewCandidateReadiness(true);
    state.markTicketReady();
    state.markIframeLoaded();
    expect(state.ready).toBe(false);
    state.configureBridgeRequirement(false);
    expect(state.ready).toBe(true);
  });
});
