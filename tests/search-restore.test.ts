import { describe, expect, it, vi } from "vitest";
import { TFile, type WorkspaceLeaf } from "obsidian";
import type HtmlStudioPlugin from "../src/main";
import type { SearchBridgeMessage } from "../src/server/search-bridge";
import { HtmlPreviewView } from "../src/view/html-preview-view";

vi.mock("obsidian", () => ({ TFile: class {}, FileView: class {}, Modal: class {}, Notice: class {} }));
vi.mock("electron", () => ({ shell: {} }));

class BridgePort extends EventTarget {
  readonly sent: { message: SearchBridgeMessage; current: number | null }[] = [];
  readonly start = vi.fn();
  readonly close = vi.fn();
  constructor(private readonly current: () => number | null) { super(); }
  postMessage(message: SearchBridgeMessage): void {
    this.sent.push({ message, current: this.current() });
  }
  receive(message: SearchBridgeMessage): void {
    this.dispatchEvent(new MessageEvent("message", { data: message }));
  }
}

function fixture(restoring = true) {
  const win = {};
  const iframe = { isConnected: true, contentWindow: {} };
  const file = Object.assign(new TFile(), { path: "course.html", name: "course.html", basename: "course" });
  const view = new HtmlPreviewView({} as WorkspaceLeaf, {
    createReloadRegistrationId: () => "search-restore",
    presenter: { sourceChanged: vi.fn() },
    app: { workspace: { containerEl: { win: { setTimeout, clearTimeout } } } }
  } as unknown as HtmlStudioPlugin);
  const search = { open: true };
  Object.assign(view, {
    file, contentEl: { win }, iframeOwnerWindow: win, activeIframe: iframe,
    session: { token: "session", searchChannel: "channel", origin: "http://127.0.0.1:1234", entryUrl: "http://127.0.0.1:1234/course.html", scopeRelativePath: "" },
    activePageRestoreState: restoring ? { vaultRelativePath: "course.html", page: 3, hash: "", search: "", scrollX: 0, scrollY: 0 } : null,
    searchBar: { hasClass: () => search.open }, searchQuery: "Needle",
    updatePreviewLoadedStatus: vi.fn(), updateSearchState: vi.fn()
  });
  const internal = view as unknown as {
    handleSearchBridgeMessage(event: MessageEvent): void;
    runSearch(direction: "current" | "next" | "previous", targetPage?: number): void;
  };
  const connect = (): BridgePort => {
    const port = new BridgePort(() => view.getLectureContext()?.deck.current ?? null);
    internal.handleSearchBridgeMessage({
      source: iframe.contentWindow, origin: "http://127.0.0.1:1234",
      data: { channel: "channel", type: "html-studio-search-ready" }, ports: [port]
    } as unknown as MessageEvent);
    return port;
  };
  const state = (page: number, restored = false): SearchBridgeMessage => ({
    channel: "channel", type: restored ? "html-studio-page-state-restored" : "html-studio-page-state",
    pathname: "/course.html", search: "", hash: "", page, scrollX: 0, scrollY: 0,
    documentRevision: "a".repeat(64),
    deck: { adapter: "dom", canNavigate: true, current: page, pages: [1, 2, 3].map(n => ({ hash: `#@zj/dom/${n}`, title: `Lesson ${n}` })) }
  });
  return { view, search, connect, state, internal };
}

describe("retained search during page restoration", () => {
  it("waits for the restored page before searching a recreated course", () => {
    // A real delayed-button deck was left on page 2 when the host sent search
    // while restoring page 3. It never acknowledged restore, stranding notes.
    const { view, connect, state } = fixture();
    const port = connect();
    expect(port.sent.map(item => item.message.type)).toEqual(["html-studio-page-state-restore"]);
    port.receive(state(2));
    expect(view.getLectureContext()).toBeNull();
    expect(port.sent).toHaveLength(1);
    port.receive(state(3, true));
    expect(view.getLectureContext()?.deck.current).toBe(3);
    expect(port.sent).toHaveLength(2);
    expect(port.sent[1]).toMatchObject({ current: 3, message: { type: "html-studio-search", query: "Needle", direction: "current" } });
    port.receive(state(3));
    expect(port.sent).toHaveLength(2);
  });

  it("ignores a late restore confirmation from the replaced connection", () => {
    const { view, connect, state } = fixture();
    const oldPort = connect(), port = connect();
    expect(oldPort.close).toHaveBeenCalledOnce();
    oldPort.receive(state(3, true));
    expect(view.getLectureContext()).toBeNull();
    expect(port.sent.map(item => item.message.type)).toEqual(["html-studio-page-state-restore"]);
    port.receive(state(3, true));
    expect(port.sent.filter(item => item.message.type === "html-studio-search")).toHaveLength(1);
    expect(view.getLectureContext()?.deck.current).toBe(3);
  });

  it("does not restart a search that was closed while the page was restoring", () => {
    const { view, search, connect, state, internal } = fixture();
    const port = connect();
    search.open = false;
    Object.assign(view, { searchQuery: "" });
    internal.runSearch("current");
    port.receive(state(3, true));
    expect(view.getLectureContext()?.deck.current).toBe(3);
    expect(port.sent.filter(item => item.message.type === "html-studio-search" && item.message.query)).toHaveLength(0);
  });

  it("executes only the latest requested search destination after restoration", () => {
    const { connect, state, internal } = fixture();
    const port = connect();
    internal.runSearch("next");
    internal.runSearch("previous", 2);
    expect(port.sent.map(item => item.message.type)).toEqual(["html-studio-page-state-restore"]);
    port.receive(state(3, true));
    expect(port.sent).toHaveLength(2);
    expect(port.sent[1]).toMatchObject({ current: 3, message: { type: "html-studio-search", query: "Needle", direction: "previous", targetPage: 2 } });
  });

  it("starts retained search immediately when no reading position needs restoration", () => {
    const { connect } = fixture(false);
    expect(connect().sent.map(item => item.message.type)).toEqual(["html-studio-search"]);
  });
});
