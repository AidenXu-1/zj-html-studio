import { Component, Notice, setIcon, type TFile } from "obsidian";
import type HtmlStudioPlugin from "../main";
import { analyzePreviewScope, type ScopeAnalysis } from "../scope/dependency-analyzer";
import type { PreviewMode } from "../settings";
import type { PreviewSession } from "../server/preview-server";
import { countAnalysisDiagnostics } from "../ui/diagnostics";
import { isFullscreenTarget, toggleFullscreenTarget } from "../ui/fullscreen";
import { ScopeConfirmationModal } from "../ui/scope-confirmation-modal";
import { shouldConfirmScope } from "../view/preview-load-policy";
import { decideEmbedReload, decideInterruptedEmbedLoad, hasActiveEmbedWork } from "./embed-lifecycle";
import { EmbedSessionCancelledError, type EmbedSessionLimiter } from "./embed-session-limiter";
import { parseHtmlEmbedSize } from "./embed-size";

const OFFSCREEN_RELEASE_DELAY_MS = 12_000;

export interface HtmlEmbedContext {
  containerEl: HTMLElement;
}

export class HtmlEmbed extends Component {
  private acquireGeneration = 0;
  private acquiring = false;
  private activeScopeModal: ScopeConfirmationModal | null = null;
  private confirmedScopePath: string | null = null;
  private diagnosticCount = 0;
  private generation = 0;
  private initialized = false;
  private iframe: HTMLIFrameElement | null = null;
  private isVisible = true;
  private observer: IntersectionObserver | null = null;
  private pendingAnalysis: ScopeAnalysis | null = null;
  private releaseSlot: (() => void) | null = null;
  private reloadPending = false;
  private reloadRegistrationId: string;
  private root: HTMLElement | null = null;
  private session: PreviewSession | null = null;
  private status: HTMLElement | null = null;
  private releaseTimer: number | null = null;
  private unloaded = false;
  private unregisterDiagnosticSink: (() => void) | null = null;
  private unregisterReloadDependencies: (() => void) | null = null;

  constructor(
    private readonly plugin: HtmlStudioPlugin,
    private readonly context: HtmlEmbedContext,
    private readonly file: TFile,
    private readonly limiter: EmbedSessionLimiter
  ) {
    super();
    this.reloadRegistrationId = plugin.createReloadRegistrationId();
  }

  override onload(): void {
    this.initialize();
  }

  loadFile(): void {
    this.initialize();
  }

  override onunload(): void {
    this.unloaded = true;
    this.generation += 1;
    this.clearReleaseTimer();
    this.observer?.disconnect();
    this.observer = null;
    this.activeScopeModal?.cancel();
    this.activeScopeModal = null;
    this.acquireGeneration += 1;
    this.limiter.cancel(this.reloadRegistrationId);
    void this.cleanupPreview(true);
  }

  private initialize(): void {
    if (this.initialized || this.unloaded) return;
    this.initialized = true;
    const container = this.context.containerEl;
    container.empty();
    container.addClass("html-studio-embed-container");

    const size = parseHtmlEmbedSize(container.getAttribute("width"), container.getAttribute("height"));
    this.root = container.createDiv({ cls: "html-studio-embed" });
    this.root.setCssStyles({
      aspectRatio: size.aspectRatio?.toString() ?? "",
      height: size.aspectRatio === null ? `${size.height}px` : "",
      width: size.width === null ? "100%" : `${size.width}px`
    });

    if (container.closest(".canvas-node")) {
      this.renderCanvasPlaceholder();
      return;
    }

    this.renderWaiting("接近可见区后自动加载…");
    const win = container.win;
    const Observer = (win as Window & { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
    if (typeof Observer !== "function") {
      this.isVisible = true;
      this.requestSession();
      return;
    }

    this.isVisible = false;
    const observer = new Observer(entries => {
      const entry = entries.at(-1);
      if (!entry) return;
      this.isVisible = entry.isIntersecting;
      if (this.isVisible) {
        this.clearReleaseTimer();
        if (this.reloadPending) {
          if (this.releaseSlot) void this.reloadAfterDependencyChange();
          else {
            this.reloadPending = false;
            this.requestSession();
          }
        } else if (!this.pendingAnalysis) {
          this.requestSession();
        }
      } else if (hasActiveEmbedWork({
        acquiring: this.acquiring,
        hasSession: this.session !== null,
        hasSlot: this.releaseSlot !== null
      })) {
        this.scheduleRelease();
      }
    }, { rootMargin: "600px 0px" });
    this.observer = observer;
    observer.observe(this.root);
  }

  private requestSession(analysis?: ScopeAnalysis): void {
    if (this.unloaded || !this.isVisible || this.acquiring || this.session || this.releaseSlot) return;
    const acquireGeneration = ++this.acquireGeneration;
    this.acquiring = true;
    this.renderWaiting(this.limiter.activeCount > 0 ? "正在等待预览名额…" : "正在分析 HTML 资源…");
    void this.limiter.acquire(this.reloadRegistrationId).then(release => {
      if (acquireGeneration !== this.acquireGeneration) {
        release();
        return;
      }
      this.acquiring = false;
      if (this.unloaded || !this.isVisible || this.session || this.releaseSlot) {
        release();
        return;
      }
      this.releaseSlot = release;
      void this.loadPreview(analysis);
    }).catch(error => {
      if (acquireGeneration !== this.acquireGeneration) return;
      this.acquiring = false;
      if (error instanceof EmbedSessionCancelledError) return;
      this.renderError(error instanceof Error ? error.message : "嵌入预览无法排队");
    });
  }

  private async loadPreview(cachedAnalysis?: ScopeAnalysis): Promise<void> {
    const generation = ++this.generation;
    const analysisStartCheckpoint = this.plugin.getVaultChangeCheckpoint();
    const previousDependencies = this.plugin.getPreviewDependencies(this.reloadRegistrationId);
    this.renderWaiting("正在分析 HTML 资源…");
    try {
      const analysis = cachedAnalysis ?? await analyzePreviewScope(this.plugin.vaultBasePath, this.file.path);
      if (this.handleInterruptedLoad(generation)) return;
      if (shouldConfirmScope(analysis.requiresConfirmation, this.confirmedScopePath, analysis.scopeRelativePath)) {
        this.pendingAnalysis = analysis;
        this.clearReloadRegistration();
        this.releaseActiveSlot();
        this.renderScopeConfirmation(analysis);
        return;
      }

      this.pendingAnalysis = null;
      const mode: PreviewMode = this.plugin.isScopeTrusted(analysis.scopeRelativePath) ? "trusted" : "safe";
      const session = await this.plugin.previewServer.createSession({
        entryRelativePath: this.file.path,
        mode,
        scopeRelativePath: analysis.scopeRelativePath
      });
      if (this.handleInterruptedLoad(generation)) {
        await this.plugin.previewServer.revokeSession(session.token);
        return;
      }

      this.session = session;
      this.diagnosticCount = countAnalysisDiagnostics(analysis);
      this.unregisterDiagnosticSink = this.plugin.registerDiagnosticSink(session.id, () => {
        this.diagnosticCount += 1;
        this.updateStatus(mode, analysis.scopeRelativePath);
      });
      this.updateReloadRegistration(session.id, analysis.dependencyRelativePaths);
      this.renderPreview(mode, analysis.scopeRelativePath);
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
      if (this.handleInterruptedLoad(generation)) return;
      this.clearReloadRegistration();
      this.releaseActiveSlot();
      this.renderError(error instanceof Error ? error.message : "HTML 嵌入无法打开");
    }
  }

  private renderPreview(mode: PreviewMode, scopePath: string): void {
    const root = this.root;
    const session = this.session;
    if (!root || !session) return;
    root.empty();
    const toolbar = root.createDiv({ cls: "html-studio-embed-toolbar" });
    const identity = toolbar.createDiv({ cls: "html-studio-embed-identity" });
    const icon = identity.createSpan();
    setIcon(icon, "file-code-2");
    identity.createSpan({ cls: "html-studio-embed-name", text: this.file.name });
    const modePill = identity.createSpan({
      cls: `html-studio-embed-mode is-${mode}`,
      text: mode === "trusted" ? "可信" : "安全"
    });
    modePill.title = scopePath ? `资源范围：${scopePath}` : "资源范围：整个知识仓库";

    const actions = toolbar.createDiv({ cls: "html-studio-embed-actions" });
    this.createAction(actions, "refresh-cw", "刷新", () => void this.reloadPreview());
    this.createAction(actions, "maximize-2", "全屏", () => void this.toggleFullscreen());
    this.createAction(actions, "panel-top-open", "在标签页打开", () => this.openInTab());

    const frameHost = root.createDiv({ cls: "html-studio-embed-frame-host" });
    this.iframe = frameHost.createEl("iframe", { cls: "html-studio-embed-iframe" });
    this.iframe.setAttribute("sandbox", mode === "trusted" ? "allow-scripts allow-same-origin" : "");
    this.iframe.setAttribute("allow", mode === "trusted" ? "clipboard-write; fullscreen" : "fullscreen");
    this.iframe.setAttribute("referrerpolicy", "no-referrer");
    this.iframe.allowFullscreen = true;
    this.iframe.addEventListener("load", () => this.updateStatus(mode, scopePath));
    this.iframe.addEventListener("error", () => {
      void this.cleanupPreview(true).then(() => {
        this.renderError("页面容器加载失败，可在标签页中打开查看诊断。");
      });
    });
    this.iframe.src = session.entryUrl;
    this.status = root.createDiv({ cls: "html-studio-embed-status", text: "正在加载…" });
  }

  private renderWaiting(message: string): void {
    const root = this.root;
    if (!root) return;
    root.empty();
    const placeholder = root.createDiv({ cls: "html-studio-embed-placeholder" });
    const icon = placeholder.createSpan();
    setIcon(icon, "loader-circle");
    placeholder.createSpan({ text: message });
  }

  private renderError(message: string): void {
    const root = this.root;
    if (!root) return;
    root.empty();
    const placeholder = root.createDiv({ cls: "html-studio-embed-placeholder is-error" });
    const icon = placeholder.createSpan();
    setIcon(icon, "file-warning");
    const copy = placeholder.createDiv();
    copy.createEl("strong", { text: "这个 HTML 暂时没有打开" });
    copy.createEl("p", { text: message });
    const retry = copy.createEl("button", { cls: "mod-cta", text: "重新尝试" });
    retry.addEventListener("click", () => this.requestSession(this.pendingAnalysis ?? undefined));
  }

  private renderScopeConfirmation(analysis: ScopeAnalysis): void {
    const root = this.root;
    if (!root) return;
    root.empty();
    const placeholder = root.createDiv({ cls: "html-studio-embed-placeholder is-confirm" });
    const icon = placeholder.createSpan();
    setIcon(icon, "folder-key");
    const copy = placeholder.createDiv();
    copy.createEl("strong", { text: "需要确认资源范围" });
    copy.createEl("p", { text: analysis.scopeRelativePath || "这个页面需要读取整个知识仓库。" });
    const confirm = copy.createEl("button", { cls: "mod-cta", text: "查看并确认" });
    confirm.addEventListener("click", () => void this.confirmScope(analysis));
    const open = copy.createEl("button", { text: "在标签页打开" });
    open.addEventListener("click", () => this.openInTab());
  }

  private renderCanvasPlaceholder(): void {
    const root = this.root;
    if (!root) return;
    root.empty();
    const placeholder = root.createDiv({ cls: "html-studio-embed-placeholder" });
    const icon = placeholder.createSpan();
    setIcon(icon, "layout-dashboard");
    const copy = placeholder.createDiv();
    copy.createEl("strong", { text: "Canvas 预览本轮未开启" });
    copy.createEl("p", { text: "可以在 HTML 标签页中完整查看。" });
    const open = copy.createEl("button", { cls: "mod-cta", text: "在标签页打开" });
    open.addEventListener("click", () => this.openInTab());
  }

  private createAction(parent: HTMLElement, iconName: string, label: string, callback: () => void): void {
    const button = parent.createEl("button", { cls: "html-studio-embed-action" });
    setIcon(button, iconName);
    button.setAttribute("aria-label", label);
    button.title = label;
    button.addEventListener("click", callback);
  }

  private async confirmScope(analysis: ScopeAnalysis): Promise<void> {
    this.activeScopeModal?.cancel();
    const modal = new ScopeConfirmationModal(this.plugin.app, analysis);
    this.activeScopeModal = modal;
    const approved = await modal.waitForDecision();
    if (this.activeScopeModal === modal) this.activeScopeModal = null;
    if (!approved || this.unloaded || this.pendingAnalysis !== analysis) return;
    this.confirmedScopePath = analysis.scopeRelativePath;
    this.pendingAnalysis = null;
    this.reloadPending = false;
    this.requestSession();
  }

  private async reloadPreview(): Promise<void> {
    this.reloadPending = false;
    if (!this.releaseSlot) {
      this.requestSession();
      return;
    }
    await this.cleanupPreview(false);
    if (!this.unloaded && this.isVisible) await this.loadPreview();
  }

  private async reloadAfterDependencyChange(): Promise<void> {
    const action = decideEmbedReload(
      this.plugin.settings.autoReload,
      this.isVisible,
      this.releaseSlot !== null
    );
    if (action === "ignore") {
      this.reloadPending = false;
      return;
    }
    if (action === "defer") {
      this.reloadPending = true;
      return;
    }
    await this.reloadPreview();
  }

  private updateReloadRegistration(sessionId: string, dependencies: Iterable<string>): void {
    if (this.unregisterReloadDependencies) {
      const updated = this.plugin.updatePreviewDependencies(this.reloadRegistrationId, sessionId, dependencies);
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

  private updateStatus(mode: PreviewMode, scopePath: string): void {
    if (!this.status) return;
    const issueText = this.diagnosticCount === 0 ? "无资源提醒" : `${this.diagnosticCount} 个资源提醒`;
    const modeText = mode === "trusted" ? "可信兼容" : "安全只读";
    this.status.setText(`${modeText} · ${issueText} · ${scopePath || "整个知识仓库"}`);
  }

  private async toggleFullscreen(): Promise<void> {
    try {
      const result = await toggleFullscreenTarget(this.iframe, this.context.containerEl.doc);
      if (result === "not-ready") new Notice("HTML 嵌入还在准备，请稍后再试。");
      if (result === "unsupported") new Notice("当前系统不支持这个全屏方式。");
    } catch (error) {
      console.error("[ZJ HTML Studio] Embed fullscreen failed", error);
      new Notice("系统没有允许进入全屏，请再试一次。");
    }
  }

  private openInTab(): void {
    void this.plugin.app.workspace.getLeaf("tab").openFile(this.file);
  }

  private scheduleRelease(): void {
    if (this.releaseTimer !== null) return;
    this.releaseTimer = this.context.containerEl.win.setTimeout(() => {
      this.releaseTimer = null;
      if (this.isVisible || isFullscreenTarget(this.iframe, this.context.containerEl.doc)) return;
      this.generation += 1;
      this.acquireGeneration += 1;
      this.limiter.cancel(this.reloadRegistrationId);
      this.acquiring = false;
      void this.cleanupPreview(true).then(() => {
        if (!this.unloaded && !this.isVisible) this.renderWaiting("已暂停，滚回附近后自动继续。");
      });
    }, OFFSCREEN_RELEASE_DELAY_MS);
  }

  private clearReleaseTimer(): void {
    if (this.releaseTimer === null) return;
    this.context.containerEl.win.clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
  }

  private async cleanupPreview(releaseSlot: boolean): Promise<void> {
    this.unregisterDiagnosticSink?.();
    this.unregisterDiagnosticSink = null;
    const iframe = this.iframe;
    const doc = this.context.containerEl.doc;
    if (isFullscreenTarget(iframe, doc) && doc.exitFullscreen) {
      await doc.exitFullscreen().catch(error => {
        console.error("[ZJ HTML Studio] Embed fullscreen cleanup failed", error);
      });
    }
    this.iframe = null;
    const session = this.session;
    this.session = null;
    if (releaseSlot) {
      this.clearReloadRegistration();
      this.releaseActiveSlot();
    }
    if (session) {
      await this.plugin.previewServer.revokeSession(session.token).catch(error => {
        console.error("[ZJ HTML Studio] Embed session cleanup failed", error);
      });
    }
  }

  private releaseActiveSlot(): void {
    const release = this.releaseSlot;
    this.releaseSlot = null;
    release?.();
  }

  private clearReloadRegistration(): void {
    this.unregisterReloadDependencies?.();
    this.unregisterReloadDependencies = null;
  }

  private handleInterruptedLoad(generation: number): boolean {
    const action = decideInterruptedEmbedLoad({
      currentGeneration: this.generation,
      generation,
      isVisible: this.isVisible,
      unloaded: this.unloaded
    });
    if (action === "continue") return false;
    if (action === "release") {
      this.pendingAnalysis = null;
      this.clearReloadRegistration();
      this.releaseActiveSlot();
      if (!this.unloaded) this.renderWaiting("已暂停，滚回附近后自动继续。");
    }
    return true;
  }
}
