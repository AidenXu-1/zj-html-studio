import { describe, expect, it, vi } from "vitest";
import {
  isFullscreenTarget,
  toggleFullscreenTarget,
  type FullscreenDocumentLike,
  type FullscreenTargetLike
} from "../src/ui/fullscreen";

describe("fullscreen controls", () => {
  it("enters fullscreen for the current preview", async () => {
    const requestFullscreen = vi.fn(async () => undefined);
    const target: FullscreenTargetLike = { requestFullscreen };
    const fullscreenDocument: FullscreenDocumentLike = { fullscreenElement: null };

    await expect(toggleFullscreenTarget(target, fullscreenDocument)).resolves.toBe("entered");
    expect(requestFullscreen).toHaveBeenCalledOnce();
  });

  it("exits when the current preview is already fullscreen", async () => {
    const target: FullscreenTargetLike = {};
    const exitFullscreen = vi.fn(async () => undefined);
    const fullscreenDocument: FullscreenDocumentLike = {
      exitFullscreen,
      fullscreenElement: target
    };

    await expect(toggleFullscreenTarget(target, fullscreenDocument)).resolves.toBe("exited");
    expect(exitFullscreen).toHaveBeenCalledOnce();
  });

  it("reports unavailable and unsupported states without throwing", async () => {
    const fullscreenDocument: FullscreenDocumentLike = { fullscreenElement: null };

    await expect(toggleFullscreenTarget(null, fullscreenDocument)).resolves.toBe("not-ready");
    await expect(toggleFullscreenTarget({}, fullscreenDocument)).resolves.toBe("unsupported");
  });

  it("recognizes only the fullscreen element for this preview", () => {
    const target: FullscreenTargetLike = {};
    const other: FullscreenTargetLike = {};

    expect(isFullscreenTarget(target, { fullscreenElement: target })).toBe(true);
    expect(isFullscreenTarget(target, { fullscreenElement: other })).toBe(false);
    expect(isFullscreenTarget(null, { fullscreenElement: null })).toBe(false);
  });
});
