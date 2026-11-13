import { resolveNativeWindow, type NativeWindowRegistry } from "./native-window";

export interface DisplayBounds { x: number; y: number; width: number; height: number }
export interface PresentationDisplay {
  id: number;
  label?: string;
  internal?: boolean;
  bounds: DisplayBounds;
  workArea: DisplayBounds;
}
export interface PresentationScreen {
  getAllDisplays(): PresentationDisplay[];
  getDisplayMatching(bounds: DisplayBounds): PresentationDisplay;
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
}
export interface PresentationWindow {
  getBounds(): DisplayBounds;
  setBounds(bounds: DisplayBounds): void;
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  setFullScreen(value: boolean): void;
  isSimpleFullScreen?(): boolean;
  setSimpleFullScreen?(value: boolean): void;
  setWindowButtonVisibility?(value: boolean): void;
  on?(event: string, listener: () => void): unknown;
  removeListener?(event: string, listener: () => void): unknown;
}

function validBounds(bounds: DisplayBounds): boolean {
  return [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    && bounds.width > 0 && bounds.height > 0;
}

/** All coordinates stay in the OS's logical pixels, including Retina displays. */
export function choosePresentationDisplay(displays: PresentationDisplay[], sourceId: number): PresentationDisplay | null {
  const source = displays.find(display => display.id === sourceId);
  if (!source || !validBounds(source.bounds)) return null;
  const overlaps = (other: DisplayBounds): boolean =>
    Math.min(source.bounds.x + source.bounds.width, other.x + other.width) > Math.max(source.bounds.x, other.x)
    && Math.min(source.bounds.y + source.bounds.height, other.y + other.height) > Math.max(source.bounds.y, other.y);
  return displays.filter(display => display.id !== sourceId && validBounds(display.bounds)
    && validBounds(display.workArea) && !overlaps(display.bounds))
    .sort((a, b) => Number(Boolean(a.internal)) - Number(Boolean(b.internal)) || a.id - b.id)[0] ?? null;
}

function nativeWindow(win: Window, registry?: NativeWindowRegistry<PresentationWindow>): PresentationWindow | null {
  const value = resolveNativeWindow(win, registry);
  return value && typeof value.getBounds === "function" && typeof value.setBounds === "function"
    && typeof value.setFullScreen === "function" && typeof value.isFullScreen === "function"
    && typeof value.isDestroyed === "function" ? value : null;
}

/** Controls only the dedicated output window; never the source's native window. */
export class ProjectionDisplay {
  private targetId: number | null = null;
  private timer = 0;
  private listening = false;
  private disposed = false;
  private native: PresentationWindow | null;
  private source: PresentationWindow | null;
  private readonly events = ["display-added", "display-removed", "display-metrics-changed"];

  constructor(private output: Window | null, main: Window,
    private screen: PresentationScreen | null,
    private lost: (() => void) | null, private changed: ((fullscreen: boolean) => void) | null,
    registry?: NativeWindowRegistry<PresentationWindow>, private timers: Window | null = main) {
    this.native = output && output !== main ? nativeWindow(output, registry) : null;
    this.source = nativeWindow(main, registry);
    if (this.native === this.source) this.native = null;
    this.native?.on?.("enter-full-screen", this.nativeFullscreenChanged);
    this.native?.on?.("leave-full-screen", this.nativeFullscreenChanged);
  }

  get fullscreen(): boolean {
    return Boolean(!this.disposed && this.native && !this.native.isDestroyed()
      && (this.native.isSimpleFullScreen?.() || this.native.isFullScreen()));
  }

  async start(): Promise<"external" | "window"> {
    if (this.disposed || !this.native || !this.source || !this.screen) return "window";
    const target = choosePresentationDisplay(this.screen.getAllDisplays(), this.screen.getDisplayMatching(this.source.getBounds()).id);
    if (!target) return "window";
    const area = target.workArea;
    this.native.setBounds({ x: area.x, y: area.y, width: Math.min(1100, area.width), height: Math.min(700, area.height) });
    // On macOS setBounds can finish before the window's screen changes. Entering
    // simple fullscreen at that point uses the old screen and moves back there.
    const placed = await this.waitUntil(() => this.windowIsOn(target.id));
    if (this.disposed || this.native.isDestroyed()) return "window";
    if (!placed) throw new Error("Projection window placement did not reach the target display");
    this.setFullscreen(true);
    const filled = await this.waitUntil(() => {
      if (!this.fullscreen || !this.windowIsOn(target.id)) return false;
      const actual = this.native!.getBounds();
      const current = this.screen!.getAllDisplays().find(display => display.id === target.id);
      return Boolean(current && (["x", "y", "width", "height"] as const)
        .every(key => Math.abs(actual[key] - current.bounds[key]) < 2));
    });
    if (this.disposed || this.native.isDestroyed()) return "window";
    if (!filled) {
      this.setFullscreen(false);
      throw new Error("Projection fullscreen did not fill the target display");
    }
    this.targetId = target.id;
    this.listen();
    return "external";
  }

  private windowIsOn(id: number): boolean {
    if (!this.native || !this.screen || !this.output) return false;
    const rendered = this.output.screen as Screen & { availLeft?: number; availTop?: number };
    const area = { x: rendered.availLeft ?? NaN, y: rendered.availTop ?? NaN,
      width: rendered.availWidth, height: rendered.availHeight };
    return validBounds(area) && this.screen.getDisplayMatching(area).id === id
      && this.screen.getDisplayMatching(this.native.getBounds()).id === id;
  }

  private async waitUntil(ready: () => boolean): Promise<boolean> {
    const deadline = Date.now() + 2_500;
    while (!this.disposed && this.native && !this.native.isDestroyed()) {
      if (ready()) return true;
      if (Date.now() >= deadline) return false;
      const timers = this.timers;
      if (!timers) return false;
      await new Promise<void>(resolve => timers.setTimeout(resolve, 50));
    }
    return false;
  }

  setFullscreen(value: boolean): boolean {
    if (this.disposed || !this.native || this.native.isDestroyed()) return false;
    // A user may have used the system green button; exit the mode actually active.
    if (process.platform === "darwin" && this.native.setSimpleFullScreen
      && (this.native.isSimpleFullScreen?.() || !this.native.isFullScreen())) this.native.setSimpleFullScreen(value);
    else this.native.setFullScreen(value);
    if (process.platform === "darwin") this.native.setWindowButtonVisibility?.(!value);
    this.changed?.(value);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.timers?.clearTimeout(this.timer);
      if (this.listening) for (const event of this.events) this.screen?.removeListener(event, this.topologyChanged);
      this.native?.removeListener?.("enter-full-screen", this.nativeFullscreenChanged);
      this.native?.removeListener?.("leave-full-screen", this.nativeFullscreenChanged);
    } finally {
      this.listening = false;
      this.targetId = null;
      // Electron may retain removed remote callbacks until a later collection.
      // Those callbacks must no longer keep the closed window or its view alive.
      this.output = null;
      this.native = null;
      this.source = null;
      this.screen = null;
      this.lost = null;
      this.changed = null;
      this.timers = null;
    }
  }

  private listen(): void {
    if (this.listening) return;
    for (const event of this.events) this.screen?.on(event, this.topologyChanged);
    this.listening = true;
  }

  private nativeFullscreenChanged = (): void => {
    if (this.disposed) return;
    const fullscreen = this.fullscreen;
    if (process.platform === "darwin") this.native?.setWindowButtonVisibility?.(!fullscreen);
    this.changed?.(fullscreen);
  };

  private topologyChanged = (): void => {
    const timers = this.timers;
    if (this.disposed || !timers) return;
    timers.clearTimeout(this.timer);
    this.timer = timers.setTimeout(() => {
      if (this.targetId === null || !this.screen || !this.source || !this.native || this.native.isDestroyed()) return;
      const displays = this.screen.getAllDisplays();
      const sourceId = this.screen.getDisplayMatching(this.source.getBounds()).id;
      const target = displays.find(display => display.id === this.targetId);
      // A mirror switch can keep a physical display ID while removing its independent area.
      if (!target || !choosePresentationDisplay(displays.filter(display => display.id === sourceId || display.id === this.targetId), sourceId)) {
        const lost = this.lost;
        this.dispose();
        lost?.();
      }
    }, 200);
  };
}
