import { ItemView, Notice, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type { PreviewSession, PreviewDocumentLoadTicket } from "../server/preview-server";
import type { SearchBridgeMessage } from "../server/search-bridge";
import { getPreviewIframeAllow, getPreviewIframeSandbox } from "../view/preview-mode";
import { parseDeckState, sameDeckStructure } from "./deck-state";
import type { PresentationContext, Presenter } from "./presenter";
import { remote } from "electron";
import { PictureProjection } from "./picture-projection";
import { ProjectionDisplay } from "./projection-display";

export const PROJECTION_VIEW_TYPE = "html-studio-projection";

export class ProjectionView extends ItemView {
  private presentationId = "";
  private context: PresentationContext | null = null;
  private session: PreviewSession | null = null;
  private iframe: HTMLIFrameElement | null = null;
  private port: MessagePort | null = null;
  private surface: HTMLElement | null = null;
  private message: HTMLElement | null = null;
  private controls: HTMLElement | null = null;
  private ticket: PreviewDocumentLoadTicket | null = null;
  private generation = 0;
  private desiredPage = 0;
  private acknowledgedPage = 0;
  private loaded = false;
  private verified = false;
  private ready = false;
  private started = false;
  private timeout = 0;
  private controlsTimer = 0;
  private syncTimer = 0;
  private hasWindowClass = false;
  private display: ProjectionDisplay | null = null;
  private displayStarted = false;
  private picture: PictureProjection | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly presenter: Presenter) { super(leaf); }
  private get timerWindow(): Window { return this.presenter.plugin.app.workspace.containerEl.win; }
  getViewType(): string { return PROJECTION_VIEW_TYPE; }
  getDisplayText(): string { return this.context ? `投屏演示 · ${this.context.fileName}` : "投屏演示"; }
  override getIcon(): string { return "projector"; }
  override getState(): Record<string, unknown> { return { id: this.presentationId }; }

  override async onOpen(): Promise<void> {
    this.contentEl.addClass("html-studio-projection");
    if (this.contentEl.win !== this.presenter.plugin.app.workspace.containerEl.win) {
      this.contentEl.doc.body.addClass("html-studio-projection-window");
      this.hasWindowClass = true;
    }
    this.contentEl.createDiv({ cls: "html-studio-projection-titlebar", text: "投屏演示", attr: { title: "拖动这里，将投屏窗口移到扩展屏" } });
    this.surface = this.contentEl.createDiv({ cls: "html-studio-projection-surface" });
    this.message = this.surface.createDiv({ cls: "html-studio-projection-message", text: "正在准备投屏…", attr: { role: "status" } });
    this.controls = this.contentEl.createDiv({ cls: "html-studio-projection-controls" });
    const fullscreen = this.controls.createEl("button", { text: "全屏演示", attr: { title: "也可以双击画面，按退出键返回" } });
    fullscreen.addEventListener("click", () => { void this.toggleFullscreen(); });
    const stop = this.controls.createEl("button", { text: "结束投屏" });
    stop.addEventListener("click", () => this.presenter.stopProjection());
    this.registerDomEvent(this.contentEl, "dblclick", event => {
      if ((event.target as HTMLElement).closest("button")) return;
      void this.toggleFullscreen();
    });
    this.registerDomEvent(this.contentEl, "mousemove", () => this.showControls());
    this.registerDomEvent(this.contentEl.doc, "fullscreenchange", () => {
      this.contentEl.toggleClass("is-fullscreen", Boolean(this.contentEl.doc.fullscreenElement) || Boolean(this.display?.fullscreen));
      if (!this.contentEl.doc.fullscreenElement) this.showControls();
    });
    this.registerDomEvent(this.contentEl.win, "message", event => this.connectBridge(event));
    this.registerDomEvent(this.contentEl.win, "pagehide", () => {
      // Window teardown can deliver the iframe's leaving message before onClose.
      // End the session first so normal window closure is not reported as a failure.
      if (this.presenter.output?.view === this) this.presenter.stopProjection();
      else this.stop();
    });
    this.registerDomEvent(this.contentEl.win, "keydown", event => {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Escape" && (this.contentEl.doc.fullscreenElement || this.display?.fullscreen)) {
        event.preventDefault();void this.toggleFullscreen();
      } else if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(event.key)) {
        event.preventDefault();this.presenter.jump(this.desiredPage + 1);
      } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) {
        event.preventDefault();this.presenter.jump(this.desiredPage - 1);
      } else if (event.key === "Home") { event.preventDefault();this.presenter.jump(1); }
      else if (event.key === "End") { event.preventDefault();this.presenter.jump(this.context?.deck.pages.length ?? 1); }
      else if (event.key.toLowerCase() === "f") { event.preventDefault();void this.toggleFullscreen(); }
    });
    this.showControls();
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    const id = typeof state === "object" && state !== null && "id" in state && typeof state.id === "string" ? state.id : "";
    this.presentationId = id;
    const record = this.presenter.attachProjection(id, this);
    if (!record || !this.hasWindowClass) {
      this.message?.setText("这次投屏已结束。请从课件工具栏重新开始。");
      return;
    }
    await this.loadPresentation(record.context);
  }

  override async onClose(): Promise<void> {
    this.stop();
    this.timerWindow.clearTimeout(this.controlsTimer);
    if (this.hasWindowClass) this.contentEl.doc.body.removeClass("html-studio-projection-window");
    this.contentEl.doc.body.removeClass("html-studio-projection-fullscreen");
    this.presenter.projectionClosed(this);
  }

  focusWindow(): void { this.contentEl.win.focus();this.showControls(); }

  async loadPresentation(context: PresentationContext): Promise<void> {
    this.stop();
    const generation = this.generation;
    this.context = context;
    this.desiredPage = context.deck.current;
    this.message?.setText("正在准备投屏…");
    this.message?.removeClass("is-hidden");
    if (context.picture) {
      const source = this.presenter.output?.source;
      const frame = source?.getProjectionElement?.();
      if (!frame || !this.surface || !source) { this.fail(); return; }
      this.timeout = this.timerWindow.setTimeout(() => this.fail(), 15_000);
      this.picture = new PictureProjection(frame, this.surface,
        () => this.presenter.output?.source === source && source.getProjectionElement?.() === frame,
        () => {
          if (generation !== this.generation) return;
          const first = !this.ready;
          this.ready = true;
          this.timerWindow.clearTimeout(this.timeout);this.timeout = 0;
          this.message?.addClass("is-hidden");
          this.presenter.acknowledgeProjection(this, source.getLectureContext()?.deck.current ?? 1);
          if (first) { this.displayStarted = true; void this.startDisplay(); }
        }, error => {
          if (generation !== this.generation) return;
          console.error("[ZJ HTML Studio] Course picture projection failed", error);
          this.fail();
        }, remote?.BrowserWindow, this.timerWindow);
      this.picture.start();
      return;
    }
    try {
      const session = await this.presenter.plugin.previewServer.createSession({
        entryRelativePath: context.filePath,
        expectedDocumentRevision: context.documentRevision,
        scopeRelativePath: context.scopeRelativePath,
        resourceFiles: context.resourceFiles,
        approvedFiles: context.approvedFiles,
        mode: context.mode,
        enableSearchBridge: true
      });
      if (generation !== this.generation || !this.surface?.isConnected) {
        await this.presenter.plugin.previewServer.revokeSession(session.token);
        return;
      }
      this.session = session;
      const url = new URL(session.entryUrl);
      url.hash = context.deck.pages[this.desiredPage - 1]!.hash;
      this.ticket = this.presenter.plugin.previewServer.beginSessionDocumentLoad(session.token, url.toString());
      const iframe = this.surface.createEl("iframe", { cls: "html-studio-projection-frame" });
      this.iframe = iframe;
      iframe.title = `投屏课件：${context.fileName}`;
      iframe.tabIndex = -1;
      iframe.setAttribute("sandbox", getPreviewIframeSandbox(context.mode, Boolean(session.searchChannel)));
      iframe.setAttribute("allow", getPreviewIframeAllow(context.mode));
      iframe.setAttribute("referrerpolicy", "no-referrer");
      iframe.allowFullscreen = true;
      iframe.addEventListener("load", () => {
        if (generation !== this.generation) return;
        if (this.ready) { this.fail(); return; }
        this.loaded = true;
        this.checkReady();
      });
      iframe.addEventListener("error", () => this.fail(), { once: true });
      this.timeout = this.timerWindow.setTimeout(() => this.fail(), 15_000);
      void this.ticket.completion.then(result => {
        if (generation !== this.generation) return;
        if (!result.ok || !result.searchBridgeAvailable) { this.fail(result.statusCode === 412 ? "document-changed" : undefined); return; }
        this.verified = true;
        this.checkReady();
      });
      iframe.src = this.ticket.url;
      this.started = true;
    } catch (error) {
      if (generation !== this.generation) return;
      console.error("[ZJ HTML Studio] Projection load failed", error);
      this.fail();
    }
  }

  syncPage(page: number): void {
    if (this.picture && this.presenter.output?.view === this) this.context = this.presenter.output.context;
    if (!this.context || page < 1 || page > this.context.deck.pages.length || !Number.isSafeInteger(page)) return;
    this.desiredPage = page;
    if (this.acknowledgedPage === page) return;
    if (this.port && this.session?.searchChannel) {
      this.port.postMessage({ channel: this.session.searchChannel, type: "html-studio-deck-go", page });
      if (!this.syncTimer) this.syncTimer = this.timerWindow.setTimeout(() => {
        this.syncTimer = 0;
        if (this.acknowledgedPage !== this.desiredPage) this.fail();
      }, 3_000);
    }
  }

  stop(): void {
    this.picture?.stop();this.picture = null;
    this.display?.dispose();this.display = null;this.displayStarted = false;
    this.generation += 1;
    this.ticket?.cancel();this.ticket = null;
    this.port?.close();this.port = null;
    this.iframe?.remove();this.iframe = null;
    this.timerWindow.clearTimeout(this.timeout);this.timeout = 0;
    this.timerWindow.clearTimeout(this.syncTimer);this.syncTimer = 0;
    this.loaded = false;this.verified = false;this.ready = false;this.started = false;
    this.acknowledgedPage = 0;
    const session = this.session;this.session = null;
    if (session) void this.presenter.plugin.previewServer.revokeSession(session.token).catch(error => {
      console.error("[ZJ HTML Studio] Projection cleanup failed", error);
    });
  }

  private connectBridge(event: MessageEvent<unknown>): void {
    const session = this.session;
    if (!this.started || !session?.searchChannel || event.source !== this.iframe?.contentWindow || event.origin !== session.origin) return;
    const data = event.data as Partial<SearchBridgeMessage> | null;
    if (!data || data.type !== "html-studio-search-ready" || data.channel !== session.searchChannel) return;
    const port = event.ports[0];
    if (!port) return;
    this.port?.close();this.port = port;
    port.addEventListener("message", message => {
      if (this.port !== port || this.session !== session) return;
      const value = message.data as Partial<SearchBridgeMessage> | null;
      if (!value || value.channel !== session.searchChannel) return;
      if (value.type === "html-studio-search-leaving") { this.fail(); return; }
      if (value.type !== "html-studio-page-state" && value.type !== "html-studio-page-state-restored") return;
      const state = parseDeckState(value.deck);
      if (!state || !this.context || !sameDeckStructure(state, this.context.deck)) return;
      if (value.pathname !== new URL(session.entryUrl).pathname) { this.fail(); return; }
      this.acknowledgedPage = state.current;
      if (state.current !== this.desiredPage) { this.syncPage(this.desiredPage); return; }
      this.timerWindow.clearTimeout(this.syncTimer);this.syncTimer = 0;
      this.checkReady();
      if (this.ready) this.presenter.acknowledgeProjection(this, state.current);
    });
    port.start();
    port.postMessage({ channel: session.searchChannel, type: "html-studio-page-state-request" });
    this.syncPage(this.desiredPage);
  }

  private checkReady(): void {
    if (!this.loaded || !this.verified || !this.port || this.acknowledgedPage !== this.desiredPage) return;
    this.ready = true;
    this.timerWindow.clearTimeout(this.timeout);this.timeout = 0;
    this.message?.addClass("is-hidden");
    this.iframe?.addClass("is-ready");
    this.presenter.acknowledgeProjection(this, this.acknowledgedPage);
    if (!this.displayStarted) {
      this.displayStarted = true;
      void this.startDisplay();
    }
  }

  private async startDisplay(): Promise<void> {
    const source = this.presenter.output?.source;
    if (!source) return;
    const sourceWindow = source.leaf.view.containerEl.win;
    let display: ProjectionDisplay | null = null;
    try {
      display = new ProjectionDisplay(this.contentEl.win, sourceWindow, remote?.screen ?? null,
        () => {
          this.presenter.stopProjection();
          new Notice("扩展屏已断开或切换为镜像，投屏已结束。本机课件仍停在当前页。");
        }, fullscreen => {
          this.contentEl.toggleClass("is-fullscreen", fullscreen);
          this.contentEl.doc.body.toggleClass("html-studio-projection-fullscreen", fullscreen);
          if (!fullscreen) this.showControls();
        }, remote?.BrowserWindow, this.timerWindow);
      this.display = display;
      const destination = await display.start();
      if (this.display !== display || !this.ready) return;
      if (destination === "external") {
        sourceWindow.focus();
        new Notice("课件已在扩展屏全屏显示。本机可以继续翻页、查看讲义；点击“结束投屏”即可收回。");
      } else {
        new Notice("演示窗口已打开。当前未找到独立扩展屏；连接后请在系统显示器设置中选“扩展显示”，再重新投屏。会议可单独共享此窗口。", 10_000);
      }
    } catch (error) {
      if ((display && this.display !== display) || !this.ready) return;
      console.error("[ZJ HTML Studio] Cannot place projection window", error);
      new Notice("演示窗口已打开，但未能自动移到扩展屏。可以手动拖过去，再点“全屏演示”。", 8_000);
    }
  }

  private fail(reason?: "document-changed"): void { this.stop();this.presenter.projectionFailed(this, reason); }

  private async toggleFullscreen(): Promise<void> {
    if (!this.surface || !this.ready) return;
    try {
      if (this.contentEl.doc.fullscreenElement) await this.contentEl.doc.exitFullscreen();
      else if (!this.display?.setFullscreen(!this.display.fullscreen)) await this.surface.requestFullscreen();
    } catch (error) {
      console.error("[ZJ HTML Studio] Projection fullscreen failed", error);
      new Notice("当前窗口未能进入全屏，请再双击一次画面，或使用窗口的系统全屏按钮。");
    }
  }

  private showControls(): void {
    if (this.contentEl.doc.fullscreenElement || this.display?.fullscreen) return;
    this.timerWindow.clearTimeout(this.controlsTimer);
    this.controls?.addClass("is-visible");
    this.controlsTimer = this.timerWindow.setTimeout(() => this.controls?.removeClass("is-visible"), 2_000);
  }
}
