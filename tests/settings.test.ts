import { describe, expect, it } from "vitest";
import {
  addSafeScope,
  addTrustedScope,
  isScopeTrusted,
  normalizeScopePath,
  removeSafeScope,
  removeTrustedScope,
  SerializedSettingsUpdater
} from "../src/settings";

describe("trusted scope settings", () => {
  it("normalizes vault paths", () => {
    expect(normalizeScopePath("/outputs\\courses/./demo")).toBe("outputs/courses/demo");
    expect(normalizeScopePath("outputs/courses/../assets")).toBe("outputs/assets");
    expect(normalizeScopePath("../../outside")).toBe("");
  });

  it("trusts a folder and its children without trusting siblings", () => {
    const trusted = ["outputs/articles"];
    expect(isScopeTrusted("outputs/articles/2026-07", trusted)).toBe(true);
    expect(isScopeTrusted("outputs/courses", trusted)).toBe(false);
    expect(isScopeTrusted("", trusted)).toBe(false);
  });

  it("preserves child rules when a parent is trusted", () => {
    const result = addTrustedScope("outputs", ["outputs/articles", "plugin-workspace"]);
    expect(result).toEqual(["outputs", "outputs/articles", "plugin-workspace"]);
  });

  it("can revoke an exact trusted scope", () => {
    expect(removeTrustedScope("outputs", ["outputs", "plugin-workspace"])).toEqual(["plugin-workspace"]);
  });

  it("lets an explicit safe child override inherited parent trust", () => {
    const trustedScopes = ["output"];
    const safeScopes = addSafeScope("output/course", []);

    expect(isScopeTrusted("output/course", trustedScopes, safeScopes)).toBe(false);
    expect(isScopeTrusted("output/course/lesson", trustedScopes, safeScopes)).toBe(false);
    expect(isScopeTrusted("output/share", trustedScopes, safeScopes)).toBe(true);
    expect(isScopeTrusted("output/course", trustedScopes, removeSafeScope("output/course", safeScopes))).toBe(true);
  });

  it("records an exact remembered rule even when the same mode is inherited", () => {
    expect(addTrustedScope("output/course", ["output"])).toEqual(["output", "output/course"]);
    expect(addSafeScope("output/course", ["output"])).toEqual(["output", "output/course"]);
  });

  it("lets a more specific trusted child override an explicit safe parent", () => {
    const safeScopes = ["output"];
    const trustedScopes = addTrustedScope("output/course", [], safeScopes);

    expect(isScopeTrusted("output/course", trustedScopes, safeScopes)).toBe(true);
    expect(isScopeTrusted("output/share", trustedScopes, safeScopes)).toBe(false);
  });

  it("lets a deeper safe choice override a trusted rule between safe ancestors", () => {
    const trustedScopes = ["output/course"];
    const safeScopes = addSafeScope("output/course/lesson", ["output"], trustedScopes);

    expect(isScopeTrusted("output/course", trustedScopes, safeScopes)).toBe(true);
    expect(isScopeTrusted("output/course/lesson", trustedScopes, safeScopes)).toBe(false);
    expect(safeScopes).toEqual(["output", "output/course/lesson"]);
  });

  it("does not erase a deeper safe exception when a trusted parent becomes safe", () => {
    const trustedScopes = removeTrustedScope("output", ["output", "output/course"]);
    const safeScopes = addSafeScope(
      "output",
      ["output/course/lesson"],
      trustedScopes
    );

    expect(safeScopes).toEqual(["output", "output/course/lesson"]);
    expect(trustedScopes).toEqual(["output/course"]);
    expect(isScopeTrusted("output/share", trustedScopes, safeScopes)).toBe(false);
    expect(isScopeTrusted("output/course", trustedScopes, safeScopes)).toBe(true);
    expect(isScopeTrusted("output/course/lesson", trustedScopes, safeScopes)).toBe(false);
  });

  it("does not erase a deeper trusted exception when a safe parent becomes trusted", () => {
    const safeScopes = removeSafeScope("output", ["output", "output/course"]);
    const trustedScopes = addTrustedScope(
      "output",
      ["output/course/lesson"],
      safeScopes
    );

    expect(trustedScopes).toEqual(["output", "output/course/lesson"]);
    expect(safeScopes).toEqual(["output/course"]);
    expect(isScopeTrusted("output/share", trustedScopes, safeScopes)).toBe(true);
    expect(isScopeTrusted("output/course", trustedScopes, safeScopes)).toBe(false);
    expect(isScopeTrusted("output/course/lesson", trustedScopes, safeScopes)).toBe(true);
  });

  it("serializes concurrent settings writes against the latest committed value", async () => {
    let current = { autoReload: true, safeScopes: [] as string[], trustedScopes: [] as string[] };
    const saved: typeof current[] = [];
    let releaseFirst: (() => void) | undefined;
    const updater = new SerializedSettingsUpdater(
      () => current,
      async next => {
        if (saved.length === 0) await new Promise<void>(resolve => {
          releaseFirst = resolve;
        });
        saved.push(next);
      },
      next => {
        current = next;
      }
    );

    const trust = updater.update(value => ({
      ...value,
      trustedScopes: addTrustedScope("output/course", value.trustedScopes)
    }));
    const autoReload = updater.update(value => ({ ...value, autoReload: false }));
    await Promise.resolve();
    releaseFirst?.();
    await Promise.all([trust, autoReload]);

    expect(current).toEqual({
      autoReload: false,
      safeScopes: [],
      trustedScopes: ["output/course"]
    });
    expect(saved).toHaveLength(2);
  });
});
