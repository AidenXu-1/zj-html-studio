import { describe, expect, it, vi } from "vitest";
import { TFile, type WorkspaceLeaf } from "obsidian";
import type HtmlStudioPlugin from "../src/main";
import type { PreviewDocumentLoadTicket, PreviewSessionProbeResult } from "../src/server/preview-server";
import { HtmlPreviewView } from "../src/view/html-preview-view";

vi.mock("obsidian", () => ({ TFile: class {}, FileView: class {}, Modal: class {}, Notice: class {} }));
vi.mock("electron", () => ({ shell: {} }));

function fixture() {
  const win = {};
  const file = Object.assign(new TFile(), { path: "large.html", basename: "large" });
  const view = new HtmlPreviewView({} as WorkspaceLeaf, {
    createReloadRegistrationId: () => "test", presenter: { sourceChanged: vi.fn() },
    app: { workspace: { containerEl: { win: { setTimeout, clearTimeout } } } }
  } as unknown as HtmlStudioPlugin);
  Object.assign(view, { file, contentEl: { win }, iframeOwnerWindow: win,
    session: { token: "test", entryUrl: "http://127.0.0.1/large.html" },
    setStatus: vi.fn(), scheduleDiagnosticsRender: vi.fn(), updatePreviewLoadedStatus: vi.fn(), updateSearchState: vi.fn() });
  return { view, file, win };
}

describe("single-page lecture availability", () => {
  it("releases old-window listeners while its document is still alive", () => {
    const { view } = fixture();
    const win = Object.assign(new EventTarget(), { document: new EventTarget(), closed: false });
    const receive = vi.fn();
    Object.assign(view, { handleSearchBridgeMessage: receive });
    const internal = view as unknown as { bindWindowEvents(win: Window): void; windowEventCleanup: Map<Window, () => void> };
    internal.bindWindowEvents(win as unknown as Window);
    win.dispatchEvent(new MessageEvent("message"));
    expect(receive).toHaveBeenCalledOnce();
    win.dispatchEvent(new Event("pagehide"));
    win.closed = true;
    win.dispatchEvent(new MessageEvent("message"));
    expect(receive).toHaveBeenCalledOnce();
    expect(internal.windowEventCleanup.size).toBe(0);
  });

  it("finishes an in-flight reading-state request after its popout loses all timers", async () => {
    vi.useFakeTimers();
    try {
      const { view, win } = fixture();
      Object.assign(win, { setTimeout: vi.fn(() => 42), clearTimeout: vi.fn() });
      Object.assign(view, { searchBridgeReady: true, searchBridgePort: { postMessage: vi.fn() },
        session: { token: "test", searchChannel: "test" } });
      const internal = view as unknown as { captureLatestPageState(): Promise<void> };
      let settled = false;
      void internal.captureLatestPageState().then(() => { settled = true; });
      Object.assign(view, { contentEl: { win: { clearTimeout: vi.fn() } } });
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("waits through a load-time bridge reconnect before starting projection", async () => {
    vi.useFakeTimers();
    try {
      const { view, file, win } = fixture();
      Object.assign(win, { setTimeout });
      Object.assign(view, { captureLatestPageState: vi.fn(async () => undefined) });
      const realContext = { filePath: file.path, picture: true, deck: { current: 1, pages: [{ title: "large", hash: "" }] } };
      const context = vi.spyOn(view, "getPresentationContext");
      context.mockReturnValueOnce(null).mockReturnValueOnce(null).mockReturnValue(realContext as NonNullable<ReturnType<typeof view.getPresentationContext>>);
      const pending = view.capturePresentationContext();
      await vi.advanceTimersByTimeAsync(200);
      expect(await pending).toBe(realContext);
    } finally { vi.useRealTimers(); }
  });

  it("cancels a pending projection start if the source changes during reconnect", async () => {
    vi.useFakeTimers();
    try {
      const { view, win } = fixture();
      Object.assign(win, { setTimeout });
      Object.assign(view, { captureLatestPageState: vi.fn(async () => undefined) });
      const context = vi.spyOn(view, "getPresentationContext").mockReturnValue(null);
      const pending = view.capturePresentationContext();
      await vi.advanceTimersByTimeAsync(20);
      Object.assign(view, { file: Object.assign(new TFile(), { path: "another.html" }) });
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending).toBeNull();
      expect(context).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("does not strand startup when the source window discards its timers", async () => {
    vi.useFakeTimers();
    try {
      const { view, win } = fixture();
      Object.assign(win, { setTimeout: vi.fn(() => 0) });
      Object.assign(view, { captureLatestPageState: vi.fn(async () => undefined) });
      vi.spyOn(view, "getPresentationContext").mockReturnValue(null);
      let settled = false;
      void view.capturePresentationContext().then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(20);
      Object.assign(view, { session: null });
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("allows notes and picture projection after a verified non-bridge preview", () => {
    const { view, file } = fixture();
    expect(view.getLectureContext()).toBeNull();
    Object.assign(view, { singlePageLectureFile: file });
    expect(view.getLectureContext()).toEqual({ deck: { current: 1, pages: [{ title: "large" }] } });
    expect(view.getPresentationContext()).toMatchObject({ picture: true, deck: { canNavigate: false, current: 1 } });
  });

  it("never reuses the previous file or window's loading confirmation", () => {
    const { view, file } = fixture();
    Object.assign(view, { singlePageLectureFile: { ...file } });
    expect(view.getLectureContext()).toBeNull();
    Object.assign(view, { singlePageLectureFile: file, iframeOwnerWindow: {} });
    expect(view.getLectureContext()).toBeNull();
  });

  it("keeps a recognized deck on its real page", () => {
    const { view, file } = fixture();
    const deck = { current: 15, pages: Array.from({ length: 47 }, (_, i) => ({ title: `Page ${i + 1}`, hash: `#p${i + 1}` })) };
    Object.assign(view, { searchBridgeReady: true, documentRevision: "a".repeat(64), deckState: deck,
      lastPageReadingState: { vaultRelativePath: file.path } });
    expect(view.getLectureContext()?.deck.current).toBe(15);
  });

  it.each(["success", "failed GET", "another file", "another window", "another load", "child page"])(
    "requires a successful GET for this exact entry, file, load and window: %s", async scenario => {
      const { view, file } = fixture();
      const iframe = { isConnected: true } as HTMLIFrameElement;
      let finish!: (result: PreviewSessionProbeResult) => void;
      const ticket: PreviewDocumentLoadTicket = {
        url: `http://127.0.0.1/${scenario === "child page" ? "child" : "large"}.html`, cancel: vi.fn(),
        completion: new Promise(resolve => { finish = resolve; })
      };
      Object.assign(view, { initialDocumentLoadTicket: ticket, activeIframe: iframe });
      const verify = view as unknown as {
        verifyInitialIframeLoad(iframe: HTMLIFrameElement, token: string, ticket: PreviewDocumentLoadTicket, file: TFile): Promise<void>;
      };
      const pending = verify.verifyInitialIframeLoad(iframe, "test", ticket, file);
      expect(view.getLectureContext()).toBeNull();
      if (scenario === "another file") Object.assign(view, { file: Object.assign(new TFile(), { path: "other.html" }) });
      if (scenario === "another window") Object.assign(view, { iframeOwnerWindow: {} });
      if (scenario === "another load") Object.assign(view, { iframeLoadGeneration: 2 });
      finish({ ok: scenario !== "failed GET", statusCode: scenario === "failed GET" ? 404 : 200, searchBridgeAvailable: false });
      await pending;
      expect(Boolean(view.getLectureContext())).toBe(scenario === "success");
      expect(Boolean(view.getPresentationContext()?.picture)).toBe(scenario === "success");
    }
  );
});
