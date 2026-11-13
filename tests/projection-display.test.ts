/* eslint-disable @typescript-eslint/unbound-method -- Assertions inspect mock call history; they do not invoke detached methods. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { choosePresentationDisplay, ProjectionDisplay, type DisplayBounds, type PresentationDisplay, type PresentationScreen, type PresentationWindow } from "../src/presentation/projection-display";

const display = (id: number, x = 0, y = 0, width = 1728, height = 1117): PresentationDisplay => ({
  id, internal: id === 1, bounds: { x, y, width, height }, workArea: { x, y: y + 30, width, height: height - 30 }
});
afterEach(() => vi.useRealTimers());

describe("presentation display choice", () => {
  it("requires an independent display; neither a single screen nor a mirrored area qualifies", () => {
    expect(choosePresentationDisplay([display(1)], 1)).toBeNull();
    expect(choosePresentationDisplay([display(1), display(2)], 1)).toBeNull();
    expect(choosePresentationDisplay([display(1), display(2, 600)], 1)).toBeNull();
  });
  it("keeps negative coordinates and Retina logical dimensions unchanged", () => {
    const left = display(2, -1920, -200, 1920, 1080);
    expect(choosePresentationDisplay([display(1), left], 1)).toEqual(left);
  });
  it("selects outside the source display even if the source is not the primary screen", () => {
    expect(choosePresentationDisplay([display(1), display(2, 1728)], 2)?.id).toBe(1);
  });
  it("chooses an external screen predictably when several independent areas exist", () => {
    expect(choosePresentationDisplay([display(3, 3840), display(1), display(2, 1728)], 1)?.id).toBe(2);
  });
  it("rejects malformed or unknown geometry", () => {
    expect(choosePresentationDisplay([display(1), display(2, NaN)], 1)).toBeNull();
    expect(choosePresentationDisplay([display(1), display(2, 1728, 0, 0)], 1)).toBeNull();
    expect(choosePresentationDisplay([display(1)], 50)).toBeNull();
  });
});

function setup() {
  vi.useFakeTimers();
  let displays = [display(1), display(2, 1728, 0, 1920, 1080)];
  const listeners = new Map<string, Set<() => void>>();
  const mainBounds = { x: 20, y: 40, width: 900, height: 700 };
  let bounds: DisplayBounds = { ...mainBounds };
  const domScreen = { availLeft: 0, availTop: 30, width: 1728, height: 1117, availWidth: 1728, availHeight: 1087 };
  const updateScreen = (d: PresentationDisplay) => Object.assign(domScreen, {
    availLeft: d.workArea.x, availTop: d.workArea.y, width: d.bounds.width, height: d.bounds.height,
    availWidth: d.workArea.width, availHeight: d.workArea.height
  });
  let fullscreen = false;
  let restoreBounds = bounds;
  const setFullscreen = (value: boolean) => {
    fullscreen = value;
    if (value) {
      restoreBounds = bounds;
      bounds = { ...displays.find(d => d.workArea.x === domScreen.availLeft)!.bounds };
    } else bounds = restoreBounds;
  };
  const native: PresentationWindow = {
    getBounds: () => bounds, setBounds: vi.fn((next: DisplayBounds) => { bounds = next;updateScreen(displays.find(d => next.x >= d.bounds.x && next.x < d.bounds.x + d.bounds.width)!); }), isDestroyed: () => false,
    isFullScreen: () => fullscreen, setFullScreen: vi.fn(setFullscreen),
    isSimpleFullScreen: () => fullscreen, setSimpleFullScreen: vi.fn(setFullscreen),
    setWindowButtonVisibility: vi.fn()
  };
  const source: PresentationWindow = { ...native, getBounds: () => mainBounds, setBounds: vi.fn(), setFullScreen: vi.fn(), setSimpleFullScreen: vi.fn() };
  const screen: PresentationScreen = {
    getAllDisplays: () => displays,
    getDisplayMatching: rectangle => displays.find(d => rectangle.x >= d.bounds.x && rectangle.x < d.bounds.x + d.bounds.width) ?? displays[0]!,
    on: (event, fn) => { const group = listeners.get(event) ?? new Set(); group.add(fn); listeners.set(event, group); },
    removeListener: (event, fn) => listeners.get(event)?.delete(fn)
  };
  const main = { electronWindow: { id: 1 }, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout } as unknown as Window;
  const output = { electronWindow: { id: 2 }, screen: domScreen, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout } as unknown as Window;
  const registry = { fromId: (id: number) => id === 1 ? source : id === 2 ? native : null };
  const lost = vi.fn(), changed = vi.fn();
  const controller = new ProjectionDisplay(output, main, screen, lost, changed, registry);
  return { controller, native, source, output, main, lost, changed, screen, listeners, domScreen, updateScreen, registry,
    change: (next: PresentationDisplay[]) => { displays = next; listeners.get("display-removed")?.forEach(fn => fn()); vi.advanceTimersByTime(250); } };
}

describe("projection window lifecycle", () => {
  it("releases windows and view callbacks even while remote callback disposal is delayed", () => {
    const { controller, output, main, native, source, screen, lost, changed } = setup();
    controller.dispose();
    for (const retained of [output, main, native, source, screen, lost, changed]) {
      expect(Object.values(controller)).not.toContain(retained);
    }
    controller.dispose();
    expect(controller.fullscreen).toBe(false);
    expect(controller.setFullscreen(true)).toBe(false);
    expect(changed).not.toHaveBeenCalled();
  });
  it("places and fullscreens only the dedicated output, without scaling coordinates twice", async () => {
    const { controller, native, source, changed } = setup();
    expect(await controller.start()).toBe("external");
    expect(native.setBounds).toHaveBeenCalledWith({ x: 1728, y: 30, width: 1100, height: 700 });
    expect(controller.fullscreen).toBe(true);
    expect(source.setBounds).not.toHaveBeenCalled();
    expect(source.setFullScreen).not.toHaveBeenCalled();
    expect(source.setSimpleFullScreen).not.toHaveBeenCalled();
    expect(changed).toHaveBeenLastCalledWith(true);
    controller.setFullscreen(false);
    expect(controller.fullscreen).toBe(false);
  });
  it("never fullscreens the source if the popout did not become a separate window", async () => {
    const { main, source, screen, registry } = setup();
    const controller = new ProjectionDisplay(main, main, screen, vi.fn(), vi.fn(), registry);
    expect(await controller.start()).toBe("window");
    expect(controller.setFullscreen(true)).toBe(false);
    expect(source.setFullScreen).not.toHaveBeenCalled();
  });
  it("does not fullscreen when the host refuses to move the output", async () => {
    const { controller, native } = setup();
    native.setBounds = vi.fn();
    const result = expect(controller.start()).rejects.toThrow("placement");
    await vi.runAllTimersAsync();await result;
    expect(controller.fullscreen).toBe(false);
  });
  it("waits for the window's screen to follow its bounds before entering fullscreen", async () => {
    const { controller, native, domScreen, updateScreen } = setup();
    const place = native.setBounds;
    native.setBounds = vi.fn((next: DisplayBounds) => {
      const before = { ...domScreen };place(next);Object.assign(domScreen, before);
      setTimeout(() => updateScreen(display(2, 1728, 0, 1920, 1080)), 200);
    });
    const started = controller.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(controller.fullscreen).toBe(false);
    await vi.runAllTimersAsync();
    expect(await started).toBe("external");
    expect(native.getBounds()).toEqual(display(2, 1728, 0, 1920, 1080).bounds);
  });
  it("does not claim success when fullscreen moves back to the source display", async () => {
    const { controller, native, updateScreen } = setup();
    const enter = native.setSimpleFullScreen!;
    native.setSimpleFullScreen = native.setFullScreen = vi.fn((value: boolean) => {
      if (value) updateScreen(display(1));
      enter(value);
    });
    const result = expect(controller.start()).rejects.toThrow("fullscreen");
    await vi.runAllTimersAsync();await result;
    expect(controller.fullscreen).toBe(false);
  });
  it("does not fullscreen after the output is closed while placement is pending", async () => {
    const { controller, native, domScreen } = setup();
    const place = native.setBounds;
    native.setBounds = vi.fn((next: DisplayBounds) => { const before = { ...domScreen };place(next);Object.assign(domScreen, before); });
    const started = controller.start();controller.dispose();
    await vi.runAllTimersAsync();
    expect(await started).toBe("window");
    expect(native.setSimpleFullScreen).not.toHaveBeenCalled();
    expect(native.setFullScreen).not.toHaveBeenCalled();
  });
  it("stops once when the target is removed and releases listeners", async () => {
    const { controller, change, lost, listeners } = setup();
    await controller.start();change([display(1)]);change([display(1)]);
    expect(lost).toHaveBeenCalledOnce();
    expect([...listeners.values()].every(group => group.size === 0)).toBe(true);
  });
  it("detects a mirror transition even when the physical display id remains", async () => {
    const { controller, change, lost } = setup();
    await controller.start();change([display(1), display(2)]);
    expect(lost).toHaveBeenCalledOnce();
  });
  it("preserves the session when only display scale or size changes", async () => {
    const { controller, change, lost } = setup();
    await controller.start();change([display(1), display(2, 1728, 0, 1280, 720)]);
    expect(lost).not.toHaveBeenCalled();
  });
  it("clears a pending topology check when the user ends projection", async () => {
    const { controller, listeners, lost } = setup();
    await controller.start();listeners.get("display-removed")?.forEach(fn => fn());
    controller.dispose();vi.advanceTimersByTime(1000);
    expect(lost).not.toHaveBeenCalled();
  });
  it("ignores a delayed remote display callback after disposal", async () => {
    const { controller, listeners, lost, changed } = setup();
    await controller.start();
    const late = [...listeners.get("display-removed")!];
    changed.mockClear();
    controller.dispose();
    late.forEach(callback => callback());
    await vi.runAllTimersAsync();
    expect(lost).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });
});
/* eslint-enable @typescript-eslint/unbound-method -- Mock call assertions end here. */
