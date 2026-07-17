import { describe, expect, it } from "vitest";
import {
  applyModeChoice,
  createPreviewRecoveryOptions,
  decideScopeModeChange,
  isPreviewModeDowngrade,
  isPolicyBoundLoadCurrent,
  resolvePreviewMode,
  resolveSessionlessPolicyReloadMode,
  shouldConfirmScope
} from "../src/view/preview-load-policy";
import { movePreviewModeSelection } from "../src/ui/mode-choice-navigation";
import {
  decideAutoReloadAction,
  isAutoReloadCandidateCurrent
} from "../src/view/auto-reload-policy";

describe("preview load policy", () => {
  it("defers fullscreen auto reloads and otherwise preserves a live candidate path", () => {
    expect(decideAutoReloadAction({ enabled: true, hasSession: true, isFullscreen: true }))
      .toBe("defer-fullscreen");
    expect(decideAutoReloadAction({ enabled: true, hasSession: true, isFullscreen: false }))
      .toBe("candidate");
    expect(decideAutoReloadAction({ enabled: true, hasSession: false, isFullscreen: false }))
      .toBe("initial-load");
    expect(decideAutoReloadAction({ enabled: false, hasSession: true, isFullscreen: false }))
      .toBe("ignore");
  });

  it("rejects stale candidate reloads before they can replace the visible page", () => {
    const current = {
      aborted: false,
      currentGeneration: 4,
      currentToken: "old-token",
      generation: 4,
      previousToken: "old-token"
    };
    expect(isAutoReloadCandidateCurrent(current)).toBe(true);
    expect(isAutoReloadCandidateCurrent({ ...current, aborted: true })).toBe(false);
    expect(isAutoReloadCandidateCurrent({ ...current, currentGeneration: 5 })).toBe(false);
    expect(isAutoReloadCandidateCurrent({ ...current, currentToken: "new-token" })).toBe(false);
  });

  it("moves permission choices with standard radio-group keyboard keys", () => {
    expect(movePreviewModeSelection("safe", "ArrowRight")).toBe("interactive");
    expect(movePreviewModeSelection("interactive", "ArrowDown")).toBe("trusted");
    expect(movePreviewModeSelection("trusted", "ArrowRight")).toBe("safe");
    expect(movePreviewModeSelection("safe", "ArrowLeft")).toBe("trusted");
    expect(movePreviewModeSelection("interactive", "Home")).toBe("safe");
    expect(movePreviewModeSelection("safe", "End")).toBe("trusted");
  });

  it("keeps a temporary safe choice across reload under a persistently trusted scope", () => {
    expect(resolvePreviewMode("trusted", "safe")).toBe("safe");
  });

  it("keeps a temporary trusted choice across reload under a persistently safe scope", () => {
    expect(resolvePreviewMode("safe", "trusted")).toBe("trusted");
  });

  it("keeps a temporary local-interaction choice across reload", () => {
    expect(resolvePreviewMode("safe", "interactive")).toBe("interactive");
  });

  it("uses the persistent rule when there is no current-tab override", () => {
    expect(resolvePreviewMode("trusted")).toBe("trusted");
    expect(resolvePreviewMode("interactive")).toBe("interactive");
    expect(resolvePreviewMode("safe")).toBe("safe");
  });

  it("never re-upgrades a sessionless fail-closed transition from a stale persistent rule", () => {
    expect(resolveSessionlessPolicyReloadMode({
      forceSafeReset: false,
      modeOverride: "safe",
      persistentMode: "trusted"
    })).toBe("safe");
    expect(resolveSessionlessPolicyReloadMode({
      forceSafeReset: false,
      modeOverride: "interactive",
      persistentMode: "trusted"
    })).toBe("interactive");
    expect(resolveSessionlessPolicyReloadMode({
      forceSafeReset: true,
      modeOverride: "trusted",
      persistentMode: "trusted"
    })).toBe("safe");
  });

  it("abandons a delayed sessionless policy reload after file or generation changes", () => {
    const current = {
      currentFilePath: "pages/current.html",
      currentLoadGeneration: 7,
      currentPolicyGeneration: 4,
      filePath: "pages/current.html",
      loadGeneration: 7,
      policyGeneration: 4
    };
    expect(isPolicyBoundLoadCurrent(current)).toBe(true);
    expect(isPolicyBoundLoadCurrent({
      ...current,
      currentFilePath: "pages/next.html"
    })).toBe(false);
    expect(isPolicyBoundLoadCurrent({
      ...current,
      currentLoadGeneration: 8
    })).toBe(false);
    expect(isPolicyBoundLoadCurrent({
      ...current,
      currentPolicyGeneration: 5
    })).toBe(false);
  });

  it("pins recovery to the failed mode and preserves browser sessions", () => {
    expect(createPreviewRecoveryOptions("safe", "output/course")).toEqual({
      confirmedScopePath: "output/course",
      modeOverride: "safe",
      preserveBrowserSessions: true
    });
  });

  it("identifies only transitions that reduce page capabilities", () => {
    expect(isPreviewModeDowngrade("trusted", "interactive")).toBe(true);
    expect(isPreviewModeDowngrade("trusted", "safe")).toBe(true);
    expect(isPreviewModeDowngrade("interactive", "safe")).toBe(true);
    expect(isPreviewModeDowngrade("safe", "interactive")).toBe(false);
    expect(isPreviewModeDowngrade("interactive", "trusted")).toBe(false);
    expect(isPreviewModeDowngrade("safe", "safe")).toBe(false);
  });

  it("propagates persistent downgrades without silently upgrading live pages", () => {
    expect(decideScopeModeChange({
      currentMode: "trusted",
      forceSafeReset: false,
      modeOverride: null,
      persistentMode: "safe"
    })).toBe("downgrade");
    expect(decideScopeModeChange({
      currentMode: "safe",
      forceSafeReset: false,
      modeOverride: null,
      persistentMode: "trusted"
    })).toBe("pin-current");
  });

  it("keeps explicit tab choices unless the user resets every permission", () => {
    expect(decideScopeModeChange({
      currentMode: "trusted",
      forceSafeReset: false,
      modeOverride: "trusted",
      persistentMode: "safe"
    })).toBe("ignore");
    expect(decideScopeModeChange({
      currentMode: "trusted",
      forceSafeReset: true,
      modeOverride: "trusted",
      persistentMode: "safe"
    })).toBe("downgrade");
    expect(decideScopeModeChange({
      currentMode: "safe",
      forceSafeReset: true,
      modeOverride: "trusted",
      persistentMode: "safe"
    })).toBe("clear-override");
  });

  it("reuses approval for the same or a narrower resource scope", () => {
    expect(shouldConfirmScope(true, "output", "output")).toBe(false);
    expect(shouldConfirmScope(true, "output", "output/course/assets")).toBe(false);
  });

  it("asks again when the resource scope expands or moves to a sibling", () => {
    expect(shouldConfirmScope(true, "output/course", "output")).toBe(true);
    expect(shouldConfirmScope(true, "output/course", "output/share")).toBe(true);
  });

  it("treats a confirmed vault-root scope as covering every narrower scope", () => {
    expect(shouldConfirmScope(true, "", "output/course")).toBe(false);
    expect(shouldConfirmScope(false, null, "output/course")).toBe(false);
  });

  it("never persists a mode choice when a concurrent reload superseded the switch", async () => {
    let persisted = false;
    const applied = await applyModeChoice(
      async () => false,
      async () => {
        persisted = true;
      }
    );

    expect(applied).toBe(false);
    expect(persisted).toBe(false);
  });

  it("persists a remembered mode only after the live session switch succeeds", async () => {
    const order: string[] = [];
    const applied = await applyModeChoice(
      async () => {
        order.push("switched");
        return true;
      },
      async () => {
        order.push("persisted");
      }
    );

    expect(applied).toBe(true);
    expect(order).toEqual(["switched", "persisted"]);
  });
});
