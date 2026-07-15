import { describe, expect, it } from "vitest";
import {
  decideEmbedReload,
  decideInterruptedEmbedLoad,
  hasActiveEmbedWork
} from "../src/embed/embed-lifecycle";

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
});
