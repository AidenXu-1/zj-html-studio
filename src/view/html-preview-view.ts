import { FileView, Notice, setIcon, type TFile, type WorkspaceLeaf } from "obsidian";
import { shell } from "electron";
import path from "node:path";
import type HtmlStudioPlugin from "../main";
import { analyzePreviewScope, type ScopeAnalysis } from "../scope/dependency-analyzer";
import type { PreviewMode } from "../settings";
import type { PreviewDiagnostic, PreviewSession } from "../server/preview-server";
import type { SearchBridgeMessage } from "../server/search-bridge";
import { BrowserOpenModal } from "../ui/browser-open-modal";
import {
  buildAnalysisDiagnostics,
  buildRuntimeDiagnostic,
  countAnalysisDiagnostics,
  type DisplayDiagnostic,
  upsertDisplayDiagnostic
} from "../ui/diagnostics";
import { isFullscreenTarget, toggleFullscreenTarget } from "../ui/fullscreen";
import { ScopeConfirmationModal } from "../ui/scope-confirmation-modal";
import { TrustModeModal } from "../ui/trust-mode-modal";
import { applyModeChoice, resolvePreviewMode, shouldConfirmScope } from "./preview-load-policy";
import { isSourceReadCurrent } from "./source-read-policy";
import { findTextOccurrences, moveSearchIndex } from "./text-search";
import { stepPreviewZoom } from "./zoom";

const BROWSER_SESSION_TTL_MS = 30 * 60 * 1_000;
const MAX_DISPLAY_DIAGNOSTICS = 100;
type ViewMode = "preview" | "source";

interface PreviewLoadOptions {
  confirmedScopePath?: string | null;
  modeOverride?: PreviewMode;
  preserveBrowserSessions?: boolean;
}

export const HTML_PREVIEW_VIEW_TYPE = "html-studio-preview";

export class HtmlPreviewView extends FileView {
  private analysis: ScopeAnalysis | null = null;
  private autoReloadButton: HTMLButtonElement | null = null;
  private activeBrowserModal: BrowserOpenModal | null = null;
  private activeScopeModal: ScopeConfirmationModal | null = null;
  private readonly browserSessions = new Map<string, number>();
  private confirmedScopePath: string | null = null;
  private readonly reloadRegistrationId: string;
  private diagnosticBadge: HTMLElement | null = null;
  private diagnostics: DisplayDiagnostic[] = [];
  private diagnosticsDrawer: HTMLElement | null = null;
  private diagnosticsRenderFrame: number | null = null;
  private fullscreenButton: HTMLButtonElement | null = null;
  private iframeHost: HTMLElement | null = null;
  private previewCanvas: HTMLElement | null = null;
  private loadAbortController: AbortController | null = null;
  private loadGeneration = 0;
  private mode: PreviewMode = "safe";
  private modeButton: HTMLButtonElement | null = null;
  private searchBar: HTMLElement | null = null;
  private searchBridgeReady = false;
  private searchButton: HTMLButtonElement | null = null;
  private searchCount: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private searchQuery = "";
  private session: PreviewSession | null = null;
  private sourceHost: HTMLElement | null = null;
  private sourceLoadGeneration = 0;
  private sourcePositions: number[] = [];
  private sourceSearchIndex = -1;
  private sourceText: string | null = null;
  private sourceTextarea: HTMLTextAreaElement | null = null;
  private statusEl: HTMLElement | null = null;
  private suppressedDiagnostics = 0;
  private unregisterDiagnosticSink: (() => void) | null = null;
  private unregisterAutoReloadListener: (() => void) | null = null;
  private unregisterReloadDependencies: (() => void) | null = null;
  private viewMode: ViewMode = "preview";
  private viewToggleButton: HTMLButtonElement | null = null;
  private zoom = 100;
  private zoomInButton: HTMLButtonElement | null = null;
  private zoomLabel: HTMLButtonElement | null = null;
  private zoomOutButton: HTMLButtonElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: HtmlStudioPlugin
  ) {
    super(leaf);
    this.reloadRegistrationId = plugin.createReloadRegistrationId();
  }

  getViewType(): string {
    return HTML_PREVIEW_VIEW_TYPE;
  }

  getIcon(): string {
    return "file-code-2";
  }

  override async onOpen(): Promise<void> {
    this.unregisterAutoReloadListener = this.plugin.registerAutoReloadListener(() => this.updateToolbarState());
    this.registerDomEvent(this.contentEl.doc, "fullscreenchange", () => this.updateFullscreenButton());
    this.registerDomEvent(this.contentEl.win, "message", event => this.handleSearchBridgeMessage(event));
    this.registerDomEvent(this.contentEl, "keydown", event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "f") {
        event.preventDefault();
        this.openSearch();
      }
    });
  }

  override async onLoadFile(file: TFile): Promise<void> {
    this.confirmedScopePath = null;
    this.viewMode = "preview";
    this.zoom = 100;
    this.searchQuery = "";
    await this.loadPreview(file);
  }

  private async loadPreview(file: TFile, options: PreviewLoadOptions = {}): Promise<void> {
    const generation = this.beginLoad();
    const analysisStartCheckpoint = this.plugin.getVaultChangeCheckpoint();
    const previousDependencies = this.plugin.getPreviewDependencies(this.reloadRegistrationId);
    this.confirmedScopePath = options.confirmedScopePath ?? null;
    const signal = this.loadAbortController!.signal;
    await this.cleanupSession({
      preserveBrowserSessions: options.preserveBrowserSessions ?? false,
      preserveReloadRegistration: true
    });
    if (!this.isLoadCurrent(generation, signal)) return;

    this.analysis = null;
    this.diagnostics = [];
    this.suppressedDiagnostics = 0;
    this.mode = "safe";
    this.searchBridgeReady = false;
    this.sourceLoadGeneration += 1;
    this.sourceText = null;
    this.sourcePositions = [];
    this.sourceSearchIndex = -1;
    this.contentEl.empty();
    this.contentEl.addClass("html-studio-view");
    this.renderShell();
    this.setStatus("正在分析页面需要的资源…", "loading");

    try {
      const analysis = await analyzePreviewScope(this.plugin.vaultBasePath, file.path, { signal });
      if (!this.isLoadCurrent(generation, signal)) return;

      if (shouldConfirmScope(analysis.requiresConfirmation, this.confirmedScopePath, analysis.scopeRelativePath)) {
        const modal = new ScopeConfirmationModal(this.app, analysis);
        this.activeScopeModal = modal;
        const approved = await modal.waitForDecision();
        if (this.activeScopeModal === modal) this.activeScopeModal = null;
        if (!this.isLoadCurrent(generation, signal)) return;
        if (!approved) {
          this.clearReloadRegistration();
          this.confirmedScopePath = null;
          const message = "你取消了较大资源范围，本次没有创建本地预览会话。";
          this.setStatus(message, "error");
          this.renderFatalError(message);
          return;
        }
        this.confirmedScopePath = analysis.scopeRelativePath;
      }

      const mode = resolvePreviewMode(
        this.plugin.isScopeTrusted(analysis.scopeRelativePath),
        options.modeOverride
      );
      const session = await this.plugin.previewServer.createSession({
        enableSearchBridge: true,
        entryRelativePath: file.path,
        mode,
        scopeRelativePath: analysis.scopeRelativePath
      });
      if (!this.isLoadCurrent(generation, signal)) {
        await this.plugin.previewServer.revokeSession(session.token);
        return;
      }

      this.analysis = analysis;
      const initialDiagnostics = buildAnalysisDiagnostics(analysis, MAX_DISPLAY_DIAGNOSTICS);
      this.diagnostics = initialDiagnostics;
      this.suppressedDiagnostics = Math.max(0, countAnalysisDiagnostics(analysis) - initialDiagnostics.length);
      this.mode = mode;
      this.session = session;
      this.unregisterDiagnosticSink = this.plugin.registerDiagnosticSink(session.id, diagnostic => {
        this.addRuntimeDiagnostic(diagnostic);
      });
      this.updateReloadRegistration(session.id, analysis.dependencyRelativePaths);
      this.updateToolbarState();
      this.renderIframe();
      const relevantDependencies = [
        ...previousDependencies,
        ...analysis.dependencyRelativePaths
      ];
      if (
        this.plugin.settings.autoReload
        && this.plugin.didVaultPathsChangeSince(analysisStartCheckpoint, relevantDependencies)
      ) {
        this.plugin.requestPreviewReload(this.reloadRegistrationId);
      }
    } catch (error) {
      if (!this.isLoadCurrent(generation, signal) || isAbortError(error)) return;
      this.clearReloadRegistration();
      this.confirmedScopePath = null;
      const message = error instanceof Error ? error.message : "HTML 页面无法打开";
      this.setStatus(message, "error");
      this.renderFatalError(message);
    }
  }

  override async onUnloadFile(_file: TFile): Promise<void> {
    this.cancelActiveLoad();
    await this.cleanupSession();
  }

  override async onClose(): Promise<void> {
    this.cancelActiveLoad();
    await this.cleanupSession();
    this.unregisterAutoReloadListener?.();
    this.unregisterAutoReloadListener = null;
  }

  refreshPreview(): void {
    const iframe = this.getPreviewIframe();
    if (!iframe || !this.session) return;
    const url = new URL(this.session.entryUrl);
    url.searchParams.set("html-studio-reload", Date.now().toString());
    this.searchBridgeReady = false;
    this.sourceLoadGeneration += 1;
    this.sourceText = null;
    iframe.src = url.toString();
    this.setStatus("正在重新加载…", "loading");
    this.updateSearchState();
    if (this.viewMode === "source") void this.loadSource();
  }

  private beginLoad(): number {
    this.loadGeneration += 1;
    this.loadAbortController?.abort();
    this.loadAbortController = new AbortController();
    this.activeScopeModal?.cancel();
    this.activeScopeModal = null;
    this.activeBrowserModal?.cancel();
    this.activeBrowserModal = null;
    return this.loadGeneration;
  }

  private cancelActiveLoad(): void {
    this.loadGeneration += 1;
    this.loadAbortController?.abort();
    this.loadAbortController = null;
    this.activeScopeModal?.cancel();
    this.activeScopeModal = null;
    this.activeBrowserModal?.cancel();
    this.activeBrowserModal = null;
  }

  private isLoadCurrent(generation: number, signal: AbortSignal): boolean {
    return generation === this.loadGeneration && !signal.aborted;
  }

  private renderShell(): void {
    const toolbar = this.contentEl.createDiv({ cls: "html-studio-toolbar" });
    const left = toolbar.createDiv({ cls: "html-studio-toolbar-group" });
    this.modeButton = left.createEl("button", { cls: "html-studio-mode-button" });
    this.modeButton.addEventListener("click", () => this.openModeModal());

    const scope = left.createDiv({ cls: "html-studio-scope-pill", text: "资源范围：分析中" });
    scope.dataset.role = "scope";

    this.autoReloadButton = left.createEl("button", { cls: "html-studio-auto-reload" });
    this.autoReloadButton.addEventListener("click", () => {
      void this.toggleAutoReload();
    });

    const right = toolbar.createDiv({ cls: "html-studio-toolbar-group html-studio-toolbar-actions" });
    this.viewToggleButton = this.createToolbarButton(right, "code-2", "源码", () => {
      void this.toggleViewMode();
    });
    this.viewToggleButton.addClass("html-studio-view-toggle");

    const zoomGroup = right.createDiv({ cls: "html-studio-zoom-group" });
    this.zoomOutButton = this.createIconButton(zoomGroup, "minus", "缩小", () => this.changeZoom(-1));
    this.zoomLabel = zoomGroup.createEl("button", { cls: "html-studio-zoom-label", text: `${this.zoom}%` });
    this.zoomLabel.title = "回到 100%";
    this.zoomLabel.addEventListener("click", () => this.resetZoom());
    this.zoomInButton = this.createIconButton(zoomGroup, "plus", "放大", () => this.changeZoom(1));

    this.searchButton = this.createToolbarButton(right, "search", "查找", () => this.toggleSearch());
    this.searchButton.disabled = true;
    this.createToolbarButton(right, "refresh-cw", "刷新", () => this.refreshPreview());
    this.createToolbarButton(right, "external-link", "浏览器", () => {
      void this.promptBrowserOpen();
    });
    this.fullscreenButton = this.createToolbarButton(right, "maximize-2", "全屏", () => {
      void this.toggleFullscreen();
    });
    this.fullscreenButton.addClass("html-studio-fullscreen-button");
    this.fullscreenButton.disabled = true;
    this.createToolbarButton(right, "locate-fixed", "源文件", () => {
      void this.plugin.revealActiveFile();
    });
    const diagnosticButton = this.createToolbarButton(right, "scan-search", "诊断", () => this.toggleDiagnostics());
    diagnosticButton.addClass("html-studio-diagnostic-button");
    this.diagnosticBadge = diagnosticButton.createSpan({ cls: "html-studio-diagnostic-badge" });

    this.renderSearchBar();
    this.statusEl = this.contentEl.createDiv({ cls: "html-studio-status" });
    const body = this.contentEl.createDiv({ cls: "html-studio-body" });
    this.iframeHost = body.createDiv({ cls: "html-studio-iframe-host" });
    this.diagnosticsDrawer = body.createDiv({ cls: "html-studio-diagnostics is-open" });
  }

  private createIconButton(
    parent: HTMLElement,
    iconName: string,
    label: string,
    callback: () => void
  ): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "html-studio-icon-button" });
    setIcon(button, iconName);
    button.setAttribute("aria-label", label);
    button.title = label;
    button.addEventListener("click", callback);
    return button;
  }

  private renderSearchBar(): void {
    const bar = this.contentEl.createDiv({ cls: "html-studio-search-bar" });
    this.searchBar = bar;
    const icon = bar.createSpan({ cls: "html-studio-search-icon" });
    setIcon(icon, "search");
    this.searchInput = bar.createEl("input", {
      attr: { "aria-label": "查找当前 HTML 内容", placeholder: "查找当前 HTML 内容" },
      type: "search"
    });
    this.searchInput.value = this.searchQuery;
    this.searchInput.addEventListener("input", () => {
      this.searchQuery = this.searchInput?.value ?? "";
      this.runSearch("current");
    });
    this.searchInput.addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      this.runSearch(event.shiftKey ? "previous" : "next");
    });
    this.searchCount = bar.createSpan({ cls: "html-studio-search-count", text: "0 / 0" });
    this.createIconButton(bar, "chevron-up", "上一处", () => this.runSearch("previous"));
    this.createIconButton(bar, "chevron-down", "下一处", () => this.runSearch("next"));
    this.createIconButton(bar, "x", "关闭查找", () => this.closeSearch());
  }

  private createToolbarButton(
    parent: HTMLElement,
    iconName: string,
    label: string,
    callback: () => void
  ): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "html-studio-tool-button" });
    const icon = button.createSpan();
    setIcon(icon, iconName);
    button.createSpan({ text: label });
    button.setAttribute("aria-label", label);
    button.addEventListener("click", callback);
    return button;
  }

  private renderIframe(): void {
    if (!this.iframeHost || !this.session) return;
    this.iframeHost.empty();
    this.sourceHost = null;
    this.sourceTextarea = null;
    this.previewCanvas = this.iframeHost.createDiv({ cls: "html-studio-preview-canvas" });
    const iframe = this.previewCanvas.createEl("iframe", { cls: "html-studio-iframe" });
    iframe.setAttribute(
      "sandbox",
      this.mode === "trusted"
        ? "allow-scripts allow-same-origin"
        : this.session.searchChannel ? "allow-scripts" : ""
    );
    iframe.setAttribute("allow", this.mode === "trusted" ? "clipboard-write; fullscreen" : "fullscreen");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.allowFullscreen = true;
    iframe.addEventListener("load", () => {
      const issueCount = this.diagnostics.length + this.suppressedDiagnostics;
      this.setStatus(
        issueCount === 0 ? "页面已载入，暂未发现资源问题" : `页面已载入，诊断记录了 ${issueCount} 个提醒`,
        "success"
      );
      this.updateSearchState();
    });
    iframe.addEventListener("error", () => this.setStatus("页面容器加载失败，请打开诊断查看原因", "error"));
    const url = new URL(this.session.entryUrl);
    url.searchParams.set("html-studio-mode", this.mode);
    iframe.src = url.toString();
    this.setStatus("正在打开 HTML 页面…", "loading");
    this.applyZoom();
    this.applyViewMode();
    if (this.viewMode === "source") void this.loadSource();
    this.updateFullscreenButton();
    this.renderDiagnostics();
  }

  private async toggleViewMode(): Promise<void> {
    this.viewMode = this.viewMode === "preview" ? "source" : "preview";
    if (this.viewMode === "source") await this.loadSource();
    this.applyViewMode();
    this.updateToolbarState();
    if (this.searchBar?.hasClass("is-open")) this.runSearch("current");
  }

  private async loadSource(): Promise<void> {
    const file = this.file;
    if (!file || !this.iframeHost) return;
    const generation = this.loadGeneration;
    const filePath = file.path;
    let sourceText = this.sourceText;
    if (sourceText === null) {
      const requestGeneration = ++this.sourceLoadGeneration;
      try {
        sourceText = await this.app.vault.cachedRead(file);
      } catch (error) {
        if (!isSourceReadCurrent({
          currentFilePath: this.file?.path ?? null,
          currentLoadGeneration: this.loadGeneration,
          currentRequestGeneration: this.sourceLoadGeneration,
          filePath,
          loadGeneration: generation,
          requestGeneration
        })) return;
        console.error("[ZJ HTML Studio] Source read failed", error);
        new Notice("源码暂时无法读取，请刷新后再试。");
        return;
      }
      if (!isSourceReadCurrent({
        currentFilePath: this.file?.path ?? null,
        currentLoadGeneration: this.loadGeneration,
        currentRequestGeneration: this.sourceLoadGeneration,
        filePath,
        loadGeneration: generation,
        requestGeneration
      })) return;
      this.sourceText = sourceText;
    }
    if (generation !== this.loadGeneration || this.file?.path !== filePath || !this.iframeHost) return;
    if (!this.sourceHost) {
      this.sourceHost = this.iframeHost.createDiv({ cls: "html-studio-source-host is-hidden" });
      this.sourceTextarea = this.sourceHost.createEl("textarea", {
        cls: "html-studio-source",
        attr: { "aria-label": `${file.name} 只读源码`, readonly: "true", spellcheck: "false" }
      });
    }
    if (this.sourceTextarea) this.sourceTextarea.value = sourceText;
    this.applyViewMode();
  }

  private applyViewMode(): void {
    const sourceActive = this.viewMode === "source";
    this.previewCanvas?.toggleClass("is-hidden", sourceActive);
    this.sourceHost?.toggleClass("is-hidden", !sourceActive);
    this.iframeHost?.toggleClass("is-source-mode", sourceActive);
  }

  private changeZoom(direction: -1 | 1): void {
    this.zoom = stepPreviewZoom(this.zoom, direction);
    this.applyZoom();
    this.updateToolbarState();
  }

  private resetZoom(): void {
    this.zoom = 100;
    this.applyZoom();
    this.updateToolbarState();
  }

  private applyZoom(): void {
    const iframe = this.getPreviewIframe();
    if (!iframe) return;
    const scale = this.zoom / 100;
    iframe.setCssStyles({
      width: `${100 / scale}%`,
      height: `${100 / scale}%`,
      transform: `scale(${scale})`
    });
  }

  private toggleSearch(): void {
    if (this.searchBar?.hasClass("is-open")) this.closeSearch();
    else this.openSearch();
  }

  private openSearch(): void {
    if (this.viewMode === "preview" && !this.searchBridgeReady) {
      new Notice("页面查找还在准备，请稍后再试。");
      return;
    }
    this.searchBar?.addClass("is-open");
    this.searchInput?.focus();
    this.searchInput?.select();
    this.runSearch("current");
  }

  private closeSearch(): void {
    this.searchBar?.removeClass("is-open");
    if (this.searchQuery) {
      this.searchQuery = "";
      if (this.searchInput) this.searchInput.value = "";
      this.runSearch("current");
    }
  }

  private runSearch(direction: "current" | "next" | "previous"): void {
    if (this.viewMode === "source") {
      this.runSourceSearch(direction);
      return;
    }
    const iframe = this.getPreviewIframe();
    const channel = this.session?.searchChannel;
    if (!iframe?.contentWindow || !channel || !this.searchBridgeReady) {
      if (this.searchCount) this.searchCount.setText("准备中");
      return;
    }
    iframe.contentWindow.postMessage({
      channel,
      direction,
      query: this.searchQuery,
      type: "html-studio-search"
    }, "*");
  }

  private runSourceSearch(direction: "current" | "next" | "previous"): void {
    if (this.sourceText === null || !this.sourceTextarea) {
      if (this.searchCount) this.searchCount.setText("准备中");
      return;
    }
    const positions = findTextOccurrences(this.sourceText, this.searchQuery);
    if (direction === "current" || !samePositions(positions, this.sourcePositions)) {
      this.sourcePositions = positions;
      this.sourceSearchIndex = positions.length > 0 ? 0 : -1;
    } else {
      this.sourceSearchIndex = moveSearchIndex(
        this.sourceSearchIndex,
        positions.length,
        direction === "previous" ? -1 : 1
      );
    }
    const position = this.sourcePositions[this.sourceSearchIndex];
    if (position !== undefined && this.searchQuery) {
      this.sourceTextarea.focus();
      this.sourceTextarea.setSelectionRange(position, position + this.searchQuery.trim().length);
    } else if (!this.searchQuery) {
      this.sourceTextarea.setSelectionRange(0, 0);
    }
    this.updateSearchCount(this.sourceSearchIndex + 1, this.sourcePositions.length);
  }

  private handleSearchBridgeMessage(event: MessageEvent<unknown>): void {
    const iframe = this.getPreviewIframe();
    const channel = this.session?.searchChannel;
    if (!iframe?.contentWindow || event.source !== iframe.contentWindow || !channel) return;
    if (!isSearchBridgeMessage(event.data) || event.data.channel !== channel) return;
    if (event.data.type === "html-studio-search-ready") {
      this.searchBridgeReady = true;
      this.updateSearchState();
      if (this.searchBar?.hasClass("is-open") && this.searchQuery) this.runSearch("current");
      return;
    }
    if (event.data.type === "html-studio-search-open") {
      this.openSearch();
      return;
    }
    if (event.data.type === "html-studio-search-result" && event.data.query === this.searchQuery) {
      this.updateSearchCount(event.data.current ?? 0, event.data.total ?? 0);
    }
  }

  private updateSearchCount(current: number, total: number): void {
    this.searchCount?.setText(`${current} / ${total}`);
  }

  private updateSearchState(): void {
    if (!this.searchButton) return;
    this.searchButton.disabled = this.viewMode === "preview" && !this.searchBridgeReady;
    this.searchButton.title = this.searchButton.disabled ? "页面查找正在准备" : "查找当前 HTML 内容";
  }

  private async toggleFullscreen(): Promise<void> {
    const iframe = this.getPreviewIframe();

    try {
      const result = await toggleFullscreenTarget(iframe, this.contentEl.doc);
      if (result === "not-ready") new Notice("HTML 页面还在准备，请稍后再试。");
      if (result === "unsupported") new Notice("当前系统不支持这个全屏方式。");
    } catch (error) {
      console.error("[ZJ HTML Studio] Fullscreen request failed", error);
      new Notice("系统没有允许进入全屏，请再试一次。");
    }

    this.updateFullscreenButton();
  }

  private updateFullscreenButton(): void {
    if (!this.fullscreenButton) return;
    const iframe = this.getPreviewIframe();
    const active = isFullscreenTarget(iframe, this.contentEl.doc);
    const label = active ? "退出全屏" : "全屏";

    this.fullscreenButton.empty();
    const icon = this.fullscreenButton.createSpan();
    setIcon(icon, active ? "minimize-2" : "maximize-2");
    this.fullscreenButton.createSpan({ text: label });
    this.fullscreenButton.disabled = iframe === null || this.viewMode === "source";
    this.fullscreenButton.toggleClass("is-active", active);
    this.fullscreenButton.setAttribute("aria-label", label);
    this.fullscreenButton.setAttribute("aria-pressed", active.toString());
    this.fullscreenButton.title = active ? "按 Esc 也可以退出全屏" : "让当前 HTML 铺满屏幕";
  }

  private getPreviewIframe(): HTMLIFrameElement | null {
    return this.iframeHost?.querySelector("iframe") ?? null;
  }

  private renderDiagnostics(): void {
    if (this.diagnosticsRenderFrame !== null) {
      this.contentEl.win.cancelAnimationFrame(this.diagnosticsRenderFrame);
      this.diagnosticsRenderFrame = null;
    }
    if (!this.diagnosticsDrawer) return;
    const drawer = this.diagnosticsDrawer;
    drawer.empty();

    const visibleCount = this.diagnostics.length;
    const totalCount = visibleCount + this.suppressedDiagnostics;
    const header = drawer.createDiv({ cls: "html-studio-diagnostics-header" });
    header.createEl("strong", { text: "页面诊断" });
    header.createSpan({
      cls: "html-studio-diagnostics-count",
      text: totalCount === 0
        ? "没有提醒"
        : this.suppressedDiagnostics > 0
          ? `${visibleCount} 条可见，${this.suppressedDiagnostics} 条已折叠`
          : `${visibleCount} 个提醒`
    });
    const close = header.createEl("button", { text: "×", cls: "html-studio-diagnostics-close" });
    close.addEventListener("click", () => drawer.removeClass("is-open"));

    const health = drawer.createDiv({ cls: "html-studio-health" });
    const healthIcon = health.createSpan();
    setIcon(healthIcon, "circle-check");
    const healthCopy = health.createDiv();
    healthCopy.createEl("strong", { text: this.session ? "本地隔离服务运行正常" : "正在准备本地服务" });
    healthCopy.createSpan({ text: "诊断只记录路径和原因，不保存页面正文。" });

    if (visibleCount === 0) {
      drawer.createDiv({ cls: "html-studio-empty-diagnostics", text: "当前没有发现资源问题。" });
    } else {
      this.diagnostics.forEach(diagnostic => this.renderDiagnosticCard(drawer, diagnostic));
    }

    drawer.createDiv({
      cls: "html-studio-diagnostics-footer",
      text: this.suppressedDiagnostics > 0
        ? `为保护 Obsidian 性能，最多绘制 ${MAX_DISPLAY_DIAGNOSTICS} 条诊断，其余已合并计数。`
        : "关闭最后一个 HTML 预览后，本地服务会自动停止。"
    });

    if (this.diagnosticBadge) {
      this.diagnosticBadge.setText(totalCount > MAX_DISPLAY_DIAGNOSTICS ? `${MAX_DISPLAY_DIAGNOSTICS}+` : totalCount.toString());
      this.diagnosticBadge.toggleClass("is-hidden", totalCount === 0);
    }
  }

  private scheduleDiagnosticsRender(): void {
    if (this.diagnosticsRenderFrame !== null) return;
    this.diagnosticsRenderFrame = this.contentEl.win.requestAnimationFrame(() => {
      this.diagnosticsRenderFrame = null;
      this.renderDiagnostics();
    });
  }

  private renderDiagnosticCard(parent: HTMLElement, diagnostic: DisplayDiagnostic): void {
    const card = parent.createDiv({ cls: `html-studio-diagnostic-card is-${diagnostic.level}` });
    const title = card.createDiv({ cls: "html-studio-diagnostic-title" });
    const icon = title.createSpan();
    setIcon(icon, diagnostic.level === "error" ? "octagon-alert" : "triangle-alert");
    title.createEl("strong", { text: diagnostic.title });

    const body = card.createDiv({ cls: "html-studio-diagnostic-content" });
    if (diagnostic.requestedPath) this.renderPathField(body, "页面请求", diagnostic.requestedPath);
    if (diagnostic.resolvedPath) this.renderPathField(body, "实际寻找", this.toVaultFriendlyPath(diagnostic.resolvedPath));
    if (diagnostic.detail) body.createEl("p", { text: diagnostic.detail });

    const actions = body.createDiv({ cls: "html-studio-diagnostic-actions" });
    const locate = actions.createEl("button", { text: "定位源文件", cls: "mod-cta" });
    locate.addEventListener("click", () => void this.plugin.revealActiveFile());
    const retry = actions.createEl("button", { text: "刷新重试" });
    retry.addEventListener("click", () => this.refreshPreview());
  }

  private renderPathField(parent: HTMLElement, label: string, value: string): void {
    const field = parent.createDiv({ cls: "html-studio-path-field" });
    field.createSpan({ text: label });
    field.createEl("code", { text: value });
  }

  private addRuntimeDiagnostic(diagnostic: PreviewDiagnostic): void {
    const incoming = buildRuntimeDiagnostic(diagnostic);
    const updated = upsertDisplayDiagnostic(
      this.diagnostics,
      incoming,
      value => path.isAbsolute(value) ? this.toVaultFriendlyPath(value) : value
    );

    if (updated.length <= MAX_DISPLAY_DIAGNOSTICS) {
      this.diagnostics = updated;
    } else if (diagnostic.reason === "diagnostic-limit") {
      this.diagnostics = [...this.diagnostics.slice(0, MAX_DISPLAY_DIAGNOSTICS - 1), incoming];
      this.suppressedDiagnostics += 1;
    } else {
      this.suppressedDiagnostics += 1;
    }
    this.scheduleDiagnosticsRender();
  }

  private toggleDiagnostics(): void {
    if (!this.diagnosticsDrawer) return;
    this.diagnosticsDrawer.toggleClass("is-open", !this.diagnosticsDrawer.hasClass("is-open"));
  }

  private openModeModal(): void {
    const analysis = this.analysis;
    const session = this.session;
    if (!analysis || !session) return;
    const sessionToken = session.token;
    new TrustModeModal(this.app, {
      currentMode: this.mode,
      scopePath: analysis.scopeRelativePath,
      onChoose: async (mode, remember) => {
        if (this.session?.token !== sessionToken) return;
        const applied = await applyModeChoice(
          () => this.replacePreviewSessionMode(mode, sessionToken, analysis),
          remember
            ? async () => {
              try {
                if (mode === "trusted") await this.plugin.trustScope(analysis.scopeRelativePath);
                if (mode === "safe") await this.plugin.untrustScope(analysis.scopeRelativePath);
              } catch (error) {
                console.error("[ZJ HTML Studio] Failed to persist preview mode", error);
                new Notice("本次打开方式已经切换，但没有成功记住这个文件夹。");
              }
            }
            : undefined
        );
        if (!applied) {
          new Notice("页面刚刚发生了刷新，本次选择没有生效，请再选一次。");
        }
      }
    }).open();
  }

  private async replacePreviewSessionMode(
    mode: PreviewMode,
    previousToken: string,
    analysis: ScopeAnalysis
  ): Promise<boolean> {
    const file = this.file;
    const generation = this.loadGeneration;
    if (!file || this.session?.token !== previousToken) return false;

    const nextSession = await this.plugin.previewServer.createSession({
      enableSearchBridge: true,
      entryRelativePath: file.path,
      mode,
      scopeRelativePath: analysis.scopeRelativePath
    });
    if (generation !== this.loadGeneration || this.session?.token !== previousToken || this.analysis !== analysis) {
      await this.plugin.previewServer.revokeSession(nextSession.token);
      return false;
    }

    this.unregisterDiagnosticSink?.();
    this.unregisterDiagnosticSink = null;
    this.session = nextSession;
    this.mode = mode;
    this.searchBridgeReady = false;
    const initialDiagnostics = buildAnalysisDiagnostics(analysis, MAX_DISPLAY_DIAGNOSTICS);
    this.diagnostics = initialDiagnostics;
    this.suppressedDiagnostics = Math.max(0, countAnalysisDiagnostics(analysis) - initialDiagnostics.length);
    this.unregisterDiagnosticSink = this.plugin.registerDiagnosticSink(nextSession.id, diagnostic => {
      this.addRuntimeDiagnostic(diagnostic);
    });
    this.updateReloadRegistration(nextSession.id, analysis.dependencyRelativePaths);
    await this.plugin.previewServer.revokeSession(previousToken);
    this.updateToolbarState();
    this.renderIframe();
    return true;
  }

  private async promptBrowserOpen(): Promise<void> {
    const analysis = this.analysis;
    if (!analysis || !this.file || !this.session) return;
    this.activeBrowserModal?.cancel();
    const modal = new BrowserOpenModal(this.app, analysis.scopeRelativePath);
    this.activeBrowserModal = modal;
    const mode = await modal.waitForMode();
    if (this.activeBrowserModal === modal) this.activeBrowserModal = null;
    if (!mode || !this.file || this.analysis !== analysis || !this.session) return;
    await this.openBrowserSession(mode, analysis, this.file);
  }

  private async openBrowserSession(mode: PreviewMode, analysis: ScopeAnalysis, file: TFile): Promise<void> {
    let session: PreviewSession | null = null;
    try {
      session = await this.plugin.previewServer.createSession({
        entryRelativePath: file.path,
        mode,
        scopeRelativePath: analysis.scopeRelativePath
      });
      if (!this.session || this.analysis !== analysis || this.file?.path !== file.path) {
        await this.plugin.previewServer.revokeSession(session.token);
        return;
      }

      const token = session.token;
      const timer = this.contentEl.win.setTimeout(() => {
        this.browserSessions.delete(token);
        void this.plugin.previewServer.revokeSession(token).catch(error => {
          console.error("[ZJ HTML Studio] Browser session expiry failed", error);
        });
      }, BROWSER_SESSION_TTL_MS);
      this.browserSessions.set(token, timer);
      await shell.openExternal(session.entryUrl);
    } catch (error) {
      if (session) {
        const timer = this.browserSessions.get(session.token);
        if (timer) this.contentEl.win.clearTimeout(timer);
        this.browserSessions.delete(session.token);
        await this.plugin.previewServer.revokeSession(session.token).catch(revokeError => {
          console.error("[ZJ HTML Studio] Failed to revoke browser session after open error", revokeError);
        });
      }
      console.error("[ZJ HTML Studio] Browser open failed", error);
      new Notice("系统浏览器没有打开，请重试。");
    }
  }

  private async toggleAutoReload(): Promise<void> {
    if (!this.autoReloadButton) return;
    this.autoReloadButton.disabled = true;
    try {
      await this.plugin.setAutoReload(!this.plugin.settings.autoReload);
    } catch (error) {
      console.error("[ZJ HTML Studio] Auto reload setting failed", error);
      new Notice("自动刷新设置没有保存成功，请重试。");
    } finally {
      if (this.autoReloadButton) this.autoReloadButton.disabled = false;
      this.updateToolbarState();
    }
  }

  private updateToolbarState(): void {
    if (this.modeButton) {
      this.modeButton.empty();
      const dot = this.modeButton.createSpan({ cls: "html-studio-mode-dot" });
      setIcon(dot, this.mode === "trusted" ? "shield-check" : "shield");
      this.modeButton.createSpan({ text: this.mode === "trusted" ? "可信兼容" : "安全只读" });
      this.modeButton.toggleClass("is-trusted", this.mode === "trusted");
      this.modeButton.title = this.mode === "trusted"
        ? "页面脚本、联网和当前资源范围读取已授权"
        : "页面脚本、后台网络请求、外部资源和剪贴板已关闭；页面跳转仍可能离开本地预览";
    }

    const scope = this.contentEl.querySelector<HTMLElement>("[data-role=scope]");
    if (scope && this.analysis) {
      scope.setText(`资源范围：${this.analysis.scopeRelativePath || "整个知识仓库"}`);
      scope.title = this.analysis.scopeRelativePath || "整个知识仓库";
    }

    if (this.autoReloadButton) {
      this.autoReloadButton.empty();
      this.autoReloadButton.createSpan({ cls: "html-studio-switch" });
      this.autoReloadButton.createSpan({ text: "自动刷新" });
      this.autoReloadButton.toggleClass("is-on", this.plugin.settings.autoReload);
      this.autoReloadButton.setAttribute("aria-pressed", this.plugin.settings.autoReload.toString());
    }

    if (this.viewToggleButton) {
      const sourceActive = this.viewMode === "source";
      this.viewToggleButton.empty();
      const icon = this.viewToggleButton.createSpan();
      setIcon(icon, sourceActive ? "panel-top" : "code-2");
      this.viewToggleButton.createSpan({ text: sourceActive ? "预览" : "源码" });
      this.viewToggleButton.toggleClass("is-active", sourceActive);
      this.viewToggleButton.setAttribute("aria-pressed", sourceActive.toString());
    }

    const zoomDisabled = this.viewMode === "source";
    if (this.zoomLabel) {
      this.zoomLabel.setText(`${this.zoom}%`);
      this.zoomLabel.disabled = zoomDisabled;
    }
    if (this.zoomOutButton) this.zoomOutButton.disabled = zoomDisabled || this.zoom <= 50;
    if (this.zoomInButton) this.zoomInButton.disabled = zoomDisabled || this.zoom >= 200;
    this.updateSearchState();
    this.updateFullscreenButton();

    this.renderDiagnostics();
  }

  private setStatus(message: string, state: "error" | "loading" | "success"): void {
    if (!this.statusEl) return;
    this.statusEl.setText(message);
    this.statusEl.dataset.state = state;
  }

  private renderFatalError(message: string): void {
    if (!this.iframeHost) return;
    this.iframeHost.empty();
    const error = this.iframeHost.createDiv({ cls: "html-studio-fatal-error" });
    const icon = error.createDiv();
    setIcon(icon, "file-warning");
    error.createEl("h3", { text: "这个 HTML 还没有打开" });
    error.createEl("p", { text: message });
    const retry = error.createEl("button", { text: "重新尝试", cls: "mod-cta" });
    retry.addEventListener("click", () => {
      if (this.file) void this.onLoadFile(this.file);
    });
  }

  private async cleanupSession(options: {
    preserveBrowserSessions?: boolean;
    preserveReloadRegistration?: boolean;
  } = {}): Promise<void> {
    const iframe = this.getPreviewIframe();
    const doc = this.contentEl.doc;
    if (isFullscreenTarget(iframe, doc) && doc.exitFullscreen) {
      try {
        await doc.exitFullscreen();
      } catch (error) {
        console.error("[ZJ HTML Studio] Fullscreen cleanup failed", error);
      }
    }
    this.unregisterDiagnosticSink?.();
    this.unregisterDiagnosticSink = null;
    if (!options.preserveReloadRegistration) {
      this.clearReloadRegistration();
      this.confirmedScopePath = null;
    }

    if (this.diagnosticsRenderFrame !== null) {
      this.contentEl.win.cancelAnimationFrame(this.diagnosticsRenderFrame);
      this.diagnosticsRenderFrame = null;
    }

    const tokens = options.preserveBrowserSessions ? [] : [...this.browserSessions.entries()];
    if (!options.preserveBrowserSessions) {
      this.browserSessions.clear();
      tokens.forEach(([, timer]) => this.contentEl.win.clearTimeout(timer));
    }
    const session = this.session;
    this.session = null;
    const revokeTokens = [session?.token, ...tokens.map(([token]) => token)].filter((token): token is string => Boolean(token));
    const results = await Promise.allSettled(revokeTokens.map(token => this.plugin.previewServer.revokeSession(token)));
    results.forEach(result => {
      if (result.status === "rejected") {
        console.error("[ZJ HTML Studio] Preview session cleanup failed", result.reason);
      }
    });
  }

  private async reloadAfterDependencyChange(): Promise<void> {
    if (!this.file || !this.plugin.settings.autoReload) return;
    await this.loadPreview(this.file, {
      confirmedScopePath: this.confirmedScopePath,
      modeOverride: this.mode,
      preserveBrowserSessions: true
    });
  }

  private clearReloadRegistration(): void {
    this.unregisterReloadDependencies?.();
    this.unregisterReloadDependencies = null;
  }

  private updateReloadRegistration(sessionId: string, dependencies: Iterable<string>): void {
    if (this.unregisterReloadDependencies) {
      const updated = this.plugin.updatePreviewDependencies(
        this.reloadRegistrationId,
        sessionId,
        dependencies
      );
      if (updated) return;
      this.unregisterReloadDependencies = null;
    }

    this.unregisterReloadDependencies = this.plugin.registerPreviewDependencies(
      this.reloadRegistrationId,
      sessionId,
      dependencies,
      () => this.reloadAfterDependencyChange()
    );
  }

  private toVaultFriendlyPath(absolutePath: string): string {
    const relative = path.relative(this.plugin.vaultBasePath, absolutePath);
    return relative.startsWith("..") ? absolutePath : relative.split(path.sep).join("/");
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function isSearchBridgeMessage(value: unknown): value is SearchBridgeMessage {
  if (typeof value !== "object" || value === null) return false;
  if (!("channel" in value) || typeof value.channel !== "string") return false;
  if (!("type" in value) || typeof value.type !== "string") return false;
  return [
    "html-studio-search-open",
    "html-studio-search-ready",
    "html-studio-search-result"
  ].includes(value.type);
}

function samePositions(first: number[], second: number[]): boolean {
  return first.length === second.length && first.every((position, index) => position === second[index]);
}
