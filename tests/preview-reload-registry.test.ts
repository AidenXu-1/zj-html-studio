import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BoundedPathChangeLog,
  PreviewReloadRegistry,
  type ReloadErrorHandler,
  type TimerScheduler
} from "../src/reload/preview-reload-registry";

const TEST_TIMER_SCHEDULER: TimerScheduler = {
  clearTimeout: handle => globalThis.clearTimeout(handle),
  setTimeout: (callback, delayMs) => Number(globalThis.setTimeout(callback, delayMs))
};

function createRegistry(
  debounceMs = 160,
  maxDependencies = 2_000,
  onError: ReloadErrorHandler = () => undefined
): PreviewReloadRegistry {
  return new PreviewReloadRegistry(debounceMs, maxDependencies, onError, TEST_TIMER_SCHEDULER);
}

describe("PreviewReloadRegistry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reloads only previews that depend on the changed file", async () => {
    vi.useFakeTimers();
    const registry = createRegistry(100);
    const articleReload = vi.fn();
    const courseReload = vi.fn();
    registry.register("article", ["output/article.html", "output/images/hero.png"], articleReload);
    registry.register("course", ["course/deck.html"], courseReload);

    registry.notifyPathChanged("output/images/hero.png");
    await vi.advanceTimersByTimeAsync(100);

    expect(articleReload).toHaveBeenCalledOnce();
    expect(courseReload).not.toHaveBeenCalled();
  });

  it("debounces repeated changes for the same preview", async () => {
    vi.useFakeTimers();
    const registry = createRegistry(100);
    const reload = vi.fn();
    registry.register("preview", ["output/index.html", "output/style.css"], reload);

    registry.notifyPathChanged("output/index.html");
    await vi.advanceTimersByTimeAsync(60);
    registry.notifyPathChanged("output/style.css");
    await vi.advanceTimersByTimeAsync(99);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("learns successful runtime dependencies and forgets closed previews", async () => {
    vi.useFakeTimers();
    const registry = createRegistry(10);
    const reload = vi.fn();
    const unregister = registry.register("preview", ["output/index.html"], reload);
    registry.addDependency("preview", "output/runtime/data.json");

    registry.notifyPathChanged("output/runtime/data.json");
    await vi.advanceTimersByTimeAsync(10);
    expect(reload).toHaveBeenCalledOnce();

    unregister();
    registry.notifyPathChanged("output/index.html");
    await vi.advanceTimersByTimeAsync(10);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("cancels a scheduled reload when a failed or cancelled view unregisters", async () => {
    vi.useFakeTimers();
    const registry = createRegistry(10);
    const reload = vi.fn();
    const unregister = registry.register("preview", ["output/index.html"], reload);

    registry.notifyPathChanged("output/index.html");
    unregister();
    await vi.advanceTimersByTimeAsync(10);

    expect(reload).not.toHaveBeenCalled();
  });

  it("drops a pending follow-up when a running view unregisters", async () => {
    vi.useFakeTimers();
    const registry = createRegistry(10);
    let releaseFirst: (() => void) | undefined;
    const reload = vi.fn(async () => {
      await new Promise<void>(resolve => {
        releaseFirst = resolve;
      });
    });
    const unregister = registry.register("preview", ["output/index.html"], reload);

    registry.notifyPathChanged("output/index.html");
    await vi.advanceTimersByTimeAsync(10);
    registry.notifyPathChanged("output/index.html");
    await vi.advanceTimersByTimeAsync(10);
    unregister();
    releaseFirst?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(reload).toHaveBeenCalledOnce();
  });

  it("serializes reloads and coalesces changes that arrive while a reload is running", async () => {
    vi.useFakeTimers();
    const registry = createRegistry(10);
    let releaseFirst: (() => void) | undefined;
    let concurrent = 0;
    let maxConcurrent = 0;
    const reload = vi.fn(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      if (reload.mock.calls.length === 1) {
        await new Promise<void>(resolve => {
          releaseFirst = resolve;
        });
      }
      concurrent -= 1;
    });
    registry.register("preview", ["output/index.html"], reload);

    registry.notifyPathChanged("output/index.html");
    await vi.advanceTimersByTimeAsync(10);
    registry.notifyPathChanged("output/index.html");
    await vi.advanceTimersByTimeAsync(10);

    expect(reload).toHaveBeenCalledOnce();
    releaseFirst?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).toHaveBeenCalledTimes(2);
    expect(maxConcurrent).toBe(1);
  });

  it("routes async callback failures to the error handler", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const registry = createRegistry(10, 100, onError);
    registry.register("preview", ["output/index.html"], async () => {
      throw new Error("reload failed");
    });

    registry.notifyPathChanged("output/index.html");
    await vi.advanceTimersByTimeAsync(10);

    expect(onError).toHaveBeenCalledWith("preview", expect.objectContaining({ message: "reload failed" }));
  });

  it("caps learned dependencies per preview", async () => {
    vi.useFakeTimers();
    const registry = createRegistry(10, 2);
    const reload = vi.fn();
    registry.register("preview", ["a.html", "b.css", "c.png"], reload);

    expect(registry.addDependency("preview", "a.html")).toBe(true);
    expect(registry.addDependency("preview", "runtime.json")).toBe(false);
    registry.notifyPathChanged("c.png");
    await vi.advanceTimersByTimeAsync(10);
    expect(reload).not.toHaveBeenCalled();
  });

  it("replaces dependencies without dropping a pending reload", async () => {
    vi.useFakeTimers();
    const registry = createRegistry(10);
    let releaseFirst: (() => void) | undefined;
    const reload = vi.fn(async () => {
      if (reload.mock.calls.length === 1) {
        await new Promise<void>(resolve => {
          releaseFirst = resolve;
        });
      }
    });
    registry.register("stable-view", ["output/index.html"], reload);

    registry.notifyPathChanged("output/index.html");
    await vi.advanceTimersByTimeAsync(10);
    expect(registry.replaceDependencies("stable-view", ["output/index.html", "output/new.css"])).toBe(true);
    registry.notifyPathChanged("output/index.html");
    await vi.advanceTimersByTimeAsync(10);
    releaseFirst?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("can request another reload when the dependency graph changed during analysis", async () => {
    vi.useFakeTimers();
    const registry = createRegistry(10);
    const reload = vi.fn();
    registry.register("stable-view", ["output/index.html"], reload);

    expect(registry.requestReload("stable-view")).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(reload).toHaveBeenCalledOnce();
    expect(registry.requestReload("missing-view")).toBe(false);
  });
});

describe("BoundedPathChangeLog", () => {
  it("replays relevant new dependencies without reacting to unrelated files", () => {
    const changes = new BoundedPathChangeLog();
    const checkpoint = changes.checkpoint();
    changes.record("notes/unrelated.md");
    changes.record("output/new.css");

    expect(changes.hasAnySince(checkpoint, ["output/index.html", "output/new.css"])).toBe(true);
    expect(changes.hasAnySince(checkpoint, ["output/index.html", "output/old.css"])).toBe(false);
  });

  it("falls back to a conservative reload after the bounded log overflows", () => {
    const changes = new BoundedPathChangeLog(2);
    const checkpoint = changes.checkpoint();
    changes.record("one.md");
    changes.record("two.md");
    changes.record("three.md");

    expect(changes.hasAnySince(checkpoint, ["output/index.html"])).toBe(true);
  });
});
