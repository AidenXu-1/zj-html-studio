import { describe, expect, it, vi } from "vitest";
import { resolveNativeWindow } from "../src/presentation/native-window";

describe("native window ownership", () => {
  it("only takes an ID from the popout and uses callable objects owned by the plugin", () => {
    const foreign = new Proxy({ id: 7 }, {
      get(target, key) {
        if (key !== "id") throw new Error("Foreign renderer is no longer callable");
        return target.id;
      }
    });
    const local = { getBounds: vi.fn(() => ({ x: 100, y: 200 })) };
    const registry = { fromId: vi.fn(() => local) };
    const resolved = resolveNativeWindow({ electronWindow: foreign } as unknown as Window, registry);
    expect(resolved?.getBounds()).toEqual({ x: 100, y: 200 });
    expect(registry.fromId).toHaveBeenCalledWith(7);
  });

  it("never reads a closed renderer or invents a native target", () => {
    const registry = { fromId: vi.fn(() => null) };
    const closed = { closed: true, get electronWindow() { throw new Error("Destroyed renderer"); } };
    expect(resolveNativeWindow(closed as unknown as Window, registry)).toBeNull();
    for (const id of [undefined, null, "1", -1, 0, 1.5, NaN]) {
      expect(resolveNativeWindow({ electronWindow: { id } } as unknown as Window, registry)).toBeNull();
    }
    expect(registry.fromId).not.toHaveBeenCalled();
    expect(resolveNativeWindow({ electronWindow: { id: 7 } } as unknown as Window)).toBeNull();
  });
});
