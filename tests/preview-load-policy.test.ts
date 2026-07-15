import { describe, expect, it } from "vitest";
import { applyModeChoice, resolvePreviewMode, shouldConfirmScope } from "../src/view/preview-load-policy";

describe("preview load policy", () => {
  it("keeps a temporary safe choice across reload under a persistently trusted scope", () => {
    expect(resolvePreviewMode(true, "safe")).toBe("safe");
  });

  it("keeps a temporary trusted choice across reload under a persistently safe scope", () => {
    expect(resolvePreviewMode(false, "trusted")).toBe("trusted");
  });

  it("uses the persistent rule when there is no current-tab override", () => {
    expect(resolvePreviewMode(true)).toBe("trusted");
    expect(resolvePreviewMode(false)).toBe("safe");
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
