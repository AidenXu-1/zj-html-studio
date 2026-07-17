import { Component, Notice, setIcon, type TFile } from "obsidian";
import type HtmlStudioPlugin from "../main";
import type { ScopeModeChange } from "../main";
import { analyzePreviewScope, type ScopeAnalysis } from "../scope/dependency-analyzer";
import { applyEntryFolderSafeTrial } from "../scope/resource-scope-policy";
import { toVaultRelativePath } from "../scope/vault-path";
import { getHtmlPermissionScopePath, type PreviewMode } from "../settings";
import type {
  PreviewDiagnostic,
  PreviewSession,
  PreviewSessionProbeResult
} from "../server/preview-server";
import {
  buildAnalysisDiagnostics,
  buildRuntimeDiagnostic,
  type DisplayDiagnostic,
  formatDisplayDiagnosticResolvedPath,
  getDisplayDiagnosticKey,
  getScriptRestrictionPresentation,
  upsertDisplayDiagnostic
} from "../ui/diagnostics";
import { EmbedDiagnosticsModal } from "../ui/embed-diagnostics-modal";
import { PreviewEntryProbeError, toUserFacingPreviewError } from "../ui/error-message";
import { isFullscreenTarget, toggleFullscreenTarget } from "../ui/fullscreen";
import { ScopeConfirmationModal } from "../ui/scope-confirmation-modal";
import { TrustModeModal } from "../ui/trust-mode-modal";
import {
  applyModeChoice,
  decideScopeModeChange,
  isPreviewModeDowngrade,
  shouldConfirmScope
} from "../view/preview-load-policy";
import {
  getPreviewIframeAllow,
  getPreviewIframeSandbox,
  getPreviewModePresentation
} from "../view/preview-mode";
import {
  createVerifiedEmbedSession,
  decideEmbedReload,
  decideInterruptedEmbedLoad,
  EmbedCandidateReadiness,
  hasActiveEmbedWork
} from "./embed-lifecycle";
import { EmbedSessionCancelledError, type EmbedSessionLimiter } from "./embed-session-limiter";
import { parseHtmlEmbedSize } from "./embed-size";

const OFFSCREEN_RELEASE_DELAY_MS = 12_000;
const MAX_EMBED_DIAGNOSTICS = 100;
const EMBED_CANDIDATE_TIMEOUT_MS = 16_000;

interface PreparedEmbedCandidate {
  dependencies: Set<string>;
  diagnostics: PreviewDiagnostic[];
  host: HTMLElement;
  iframe: HTMLIFrameElement;
  layout: HTMLElement;
  status: HTMLElement;
  toolbar: HTMLElement;
  unregisterDiagnosticSink: () => void;
  unregisterResourceSink: () => void;
}

export interface HtmlEmbedContext {
  containerEl: HTMLElement;
}

export class HtmlEmbed extends Component {
  private acquireGeneration = 0;
  private acquiring = false;
  private activeScopeModal: ScopeConfirmationModal | null = null;
  private confirmedScopePath: string | null = null;
  private currentMode: PreviewMode = "safe";
  private currentAnalysis: ScopeAnalysis | null = null;
  private candidateHost: HTMLElement | null = null;
  private candidateIframe: HTMLIFrameElement | null = null;
  private candidateLoadAbortController: AbortController | null = null;
  private activeDiagnosticsModal: EmbedDiagnosticsModal | null = null;
  private activeModeModal: TrustModeModal | null = null;
  private diagnosticCount = 0;
  private diagnosticButton: HTMLButtonElement | null = null;
  private diagnosticIdentities = new Set<string>();
  private diagnostics: DisplayDiagnostic[] = [];
  private entryProbeAbortController: AbortController | null = null;
  private generation = 0;
  private initialized = false;
  private iframe: HTMLIFrameElement | null = null;
  private isVisible = true;
  private modeOverride: PreviewMode | null = null;
  private observer: IntersectionObserver | null = null;
  private pendingAnalysis: ScopeAnalysis | null = null;
  private pendingFocusAction: string | null = null;
  private permissionScopePath: string | null = null;
  private releaseSlot: (() => void) | null = null;
  private reloadPending = false;
  private reloadRegistrationId: string;
  private root: HTMLElement | null = null;
  private session: PreviewSession | null = null;
  private status: HTMLElement | null = null;
  private suppressedDiagnostics = 0;
  private releaseTimer: number | null = null;
  private unloaded = false;
  private unregisterDiagnosticSink: (() => void) | null = null;
  private unregisterReloadDependencies: (() => void) | null = null;
  private unregisterScopeModeListener: (() => void) | null = null;

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
    this.cancelCandidateLoad();
    this.cancelEntryProbe();
    this.generation += 1;
    this.clearReleaseTimer();
    this.observer?.disconnect();
    this.observer = null;
    this.activeScopeModal?.cancel();
    this.activeScopeModal = null;
    this.activeDiagnosticsModal?.close();
    this.activeDiagnosticsModal = null;
    this.activeModeModal?.cancel();
    this.activeModeModal = null;
    this.unregisterScopeModeListener?.();
    this.unregisterScopeModeListener = null;
    this.acquireGeneration += 1;
    this.limiter.cancel(this.reloadRegistrationId);
    void this.cleanupPreview(true);
  }

  private initialize(): void {
    if (this.initialized || this.unloaded) return;
    this.initialized = true;
    const container = this.context.containerEl;
    this.registerDomEvent(container.doc, "fullscreenchange", () => this.handleFullscreenChange());
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
      this.renderError(toUserFacingPreviewError(error, "embed"));
    });
  }

  private async loadPreview(cachedAnalysis?: ScopeAnalysis): Promise<void> {
    this.cancelEntryProbe();
    const generation = ++this.generation;
    const analysisStartCheckpoint = this.plugin.getVaultChangeCheckpoint();
    const previousDependencies = this.plugin.getPreviewDependencies(this.reloadRegistrationId);
    this.renderWaiting("正在分析 HTML 资源…");
    let provisionalSession: PreviewSession | null = null;
    let prepared: PreparedEmbedCandidate | null = null;
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
      const permissionScopePath = getHtmlPermissionScopePath(this.file.path);
      const mode = this.modeOverride ?? this.plugin.getScopeMode(permissionScopePath);
      provisionalSession = await this.createVerifiedPreviewSession(
        analysis,
        mode,
        () => !this.unloaded && this.isVisible && this.generation === generation
      );
      prepared = await this.prepareEmbedCandidate(
        provisionalSession,
        mode,
        () => !this.unloaded && this.isVisible && this.generation === generation
      );
      if (this.handleInterruptedLoad(generation)) {
        this.discardPreparedEmbedCandidate(prepared);
        prepared = null;
        await this.plugin.previewServer.revokeSession(provisionalSession.token);
        provisionalSession = null;
        return;
      }

      const runtimeDependencies = [...prepared.dependencies];
      this.commitPreviewSession(provisionalSession, analysis, permissionScopePath, mode, prepared);
      provisionalSession = null;
      prepared = null;
      const relevantDependencies = [
        ...previousDependencies,
        ...analysis.dependencyRelativePaths,
        ...runtimeDependencies
      ];
      if (
        this.plugin.settings.autoReload
        && this.plugin.didVaultPathsChangeSince(analysisStartCheckpoint, relevantDependencies)
      ) {
        this.plugin.requestPreviewReload(this.reloadRegistrationId);
      }
    } catch (error) {
      if (prepared) this.discardPreparedEmbedCandidate(prepared);
      if (provisionalSession) {
        await this.plugin.previewServer.revokeSession(provisionalSession.token).catch(revokeError => {
          console.error("[ZJ HTML Studio] Failed to revoke rejected embed candidate", revokeError);
        });
      }
      if (this.handleInterruptedLoad(generation)) return;
      this.clearReloadRegistration();
      this.releaseActiveSlot();
      this.renderError(toUserFacingPreviewError(error, "embed"));
    }
  }

  private commitPreviewSession(
    session: PreviewSession,
    analysis: ScopeAnalysis,
    permissionScopePath: string,
    mode: PreviewMode,
    prepared?: PreparedEmbedCandidate
  ): void {
    this.unregisterDiagnosticSink?.();
    this.unregisterDiagnosticSink = null;
    prepared?.unregisterDiagnosticSink();
    prepared?.unregisterResourceSink();
    this.session = session;
    this.ensureScopeModeListener();
    this.currentAnalysis = analysis;
    this.currentMode = mode;
    this.permissionScopePath = permissionScopePath;
    this.diagnostics = [];
    this.suppressedDiagnostics = 0;
    this.diagnosticIdentities.clear();
    buildAnalysisDiagnostics(analysis, Number.POSITIVE_INFINITY, mode)
      .forEach(diagnostic => this.rememberDisplayDiagnostic(diagnostic));
    prepared?.diagnostics.forEach(diagnostic => {
      this.rememberDisplayDiagnostic(buildRuntimeDiagnostic(diagnostic));
    });
    this.updateDiagnosticCount();
    this.unregisterDiagnosticSink = this.plugin.registerDiagnosticSink(session.id, diagnostic => {
      this.rememberDisplayDiagnostic(buildRuntimeDiagnostic(diagnostic));
      this.updateDiagnosticCount();
      this.updateStatus(mode, analysis.scopeRelativePath);
    });
    this.updateReloadRegistration(session.id, [
      ...analysis.dependencyRelativePaths,
      ...(prepared?.dependencies ?? [])
    ]);
    this.renderPreview(mode, analysis.scopeRelativePath, analysis, prepared);
  }

  private renderPreview(
    mode: PreviewMode,
    scopePath: string,
    analysis: ScopeAnalysis,
    prepared?: PreparedEmbedCandidate
  ): void {
    const root = this.root;
    const session = this.session;
    if (!root || !session) return;
    let layout: HTMLElement;
    let toolbar: HTMLElement;
    if (prepared) {
      Array.from(root.children).forEach(child => {
        if (child !== prepared.layout) child.remove();
      });
      layout = prepared.layout;
      layout.removeClass("html-studio-embed-candidate-layout");
      layout.removeAttribute("aria-hidden");
      layout.removeAttribute("inert");
      layout.removeAttribute("style");
      toolbar = prepared.toolbar;
      toolbar.empty();
    } else {
      root.empty();
      layout = root.createDiv({ cls: "html-studio-embed-layout" });
      toolbar = layout.createDiv({ cls: "html-studio-embed-toolbar" });
    }
    const identity = toolbar.createDiv({ cls: "html-studio-embed-identity" });
    const icon = identity.createSpan();
    setIcon(icon, "file-code-2");
    identity.createSpan({ cls: "html-studio-embed-name", text: this.file.name });
    const presentation = getPreviewModePresentation(mode);
    const modePill = identity.createEl("button", {
      cls: `html-studio-embed-mode is-${mode}`,
      text: presentation.shortLabel,
      type: "button"
    });
    modePill.setAttribute("aria-label", `更改打开方式，当前为${presentation.label}`);
    modePill.dataset.htmlStudioAction = "mode";
    modePill.title = scopePath
      ? `更改打开方式 · 资源范围：${scopePath}`
      : "更改打开方式 · 资源范围：整个知识仓库";
    modePill.addEventListener("click", () => this.openModeModal());

    const actions = toolbar.createDiv({ cls: "html-studio-embed-actions" });
    this.createAction(actions, "refresh-cw", "刷新", () => void this.reloadPreview());
    this.diagnosticButton = this.createAction(
      actions,
      "scan-search",
      this.diagnosticCount === 0 ? "诊断：没有提醒" : `诊断：${this.diagnosticCount} 个提醒`,
      () => this.openDiagnostics()
    );
    this.createAction(actions, "maximize-2", "全屏", () => void this.toggleFullscreen());
    this.createAction(actions, "panel-top-open", "在标签页打开", () => this.openInTab());

    const frameHost = prepared?.host ?? layout.createDiv({ cls: "html-studio-embed-frame-host" });
    this.iframe = prepared?.iframe ?? frameHost.createEl("iframe", { cls: "html-studio-embed-iframe" });
    if (prepared) {
      frameHost.removeClass("html-studio-embed-candidate-host");
      frameHost.addClass("html-studio-embed-frame-host");
      frameHost.removeAttribute("aria-hidden");
      frameHost.removeAttribute("inert");
      frameHost.removeAttribute("style");
      prepared.iframe.removeAttribute("tabindex");
      if (this.candidateHost === frameHost) this.candidateHost = null;
      if (this.candidateIframe === prepared.iframe) this.candidateIframe = null;
    }
    this.iframe.title = `HTML 嵌入预览：${this.file.name}`;
    this.iframe.setAttribute("sandbox", getPreviewIframeSandbox(mode));
    this.iframe.setAttribute("allow", getPreviewIframeAllow(mode));
    this.iframe.setAttribute("referrerpolicy", "no-referrer");
    this.iframe.allowFullscreen = true;
    if (!prepared) {
      this.iframe.addEventListener("load", () => this.updateStatus(mode, scopePath));
      this.iframe.addEventListener("error", () => {
        void this.cleanupPreview(true).then(() => {
          this.renderError("页面容器加载失败，可在标签页中打开查看诊断。");
        });
      });
      this.iframe.src = session.entryUrl;
    }
    if (getScriptRestrictionPresentation(analysis, mode)) {
      this.renderEmbedScriptNotice(frameHost, analysis);
    }
    this.status = prepared?.status ?? layout.createDiv({ cls: "html-studio-embed-status" });
    this.status.setText("正在加载…");
    this.status.setAttribute("aria-live", "polite");
    this.status.setAttribute("role", "status");
    if (prepared) this.updateStatus(mode, scopePath);
    this.restoreFocusedAction();
  }

  private renderEmbedScriptNotice(parent: HTMLElement, analysis: ScopeAnalysis): void {
    const presentation = getScriptRestrictionPresentation(analysis, this.currentMode);
    if (!presentation) return;
    const notice = parent.createDiv({ cls: "html-studio-script-notice is-embed" });
    const icon = notice.createSpan({ cls: "html-studio-script-notice-icon" });
    setIcon(icon, "code-2");
    const copy = notice.createDiv({ cls: "html-studio-script-notice-copy" });
    copy.createEl("strong", { text: presentation.title });
    copy.createSpan({ text: presentation.detail });
    const button = notice.createEl("button", { cls: "mod-cta", text: "本地交互打开" });
    button.addEventListener("click", () => {
      const session = this.session;
      const analysis = this.currentAnalysis;
      if (!session || !analysis) return;
      button.disabled = true;
      void this.replacePreviewSessionMode("interactive", session.token, analysis).catch(error => {
        console.error("[ZJ HTML Studio] Failed to switch embed to local interactive mode", error);
        new Notice(toUserFacingPreviewError(error, "embed"));
      }).finally(() => {
        if (button.isConnected) button.disabled = false;
      });
    });
  }

  private renderWaiting(message: string): void {
    const root = this.root;
    if (!root) return;
    root.empty();
    const placeholder = root.createDiv({ cls: "html-studio-embed-placeholder" });
    placeholder.setAttribute("aria-live", "polite");
    placeholder.setAttribute("role", "status");
    const icon = placeholder.createSpan();
    setIcon(icon, "loader-circle");
    placeholder.createSpan({ text: message });
  }

  private renderError(message: string): void {
    const root = this.root;
    if (!root) return;
    root.empty();
    const placeholder = root.createDiv({ cls: "html-studio-embed-placeholder is-error" });
    placeholder.setAttribute("aria-live", "assertive");
    placeholder.setAttribute("role", "alert");
    const icon = placeholder.createSpan();
    setIcon(icon, "file-warning");
    const copy = placeholder.createDiv();
    copy.createEl("strong", { text: "这个 HTML 暂时没有打开" });
    copy.createEl("p", { text: message });
    const retry = copy.createEl("button", { cls: "mod-cta", text: "重新尝试" });
    retry.addEventListener("click", () => this.requestSession(this.pendingAnalysis ?? undefined));
    if (this.pendingFocusAction) {
      this.pendingFocusAction = null;
      retry.focus();
    }
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

  private createAction(
    parent: HTMLElement,
    iconName: string,
    label: string,
    callback: () => void
  ): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "html-studio-embed-action" });
    setIcon(button, iconName);
    button.setAttribute("aria-label", label);
    button.dataset.htmlStudioAction = iconName;
    button.title = label;
    button.addEventListener("click", callback);
    return button;
  }

  private openDiagnostics(): void {
    this.activeDiagnosticsModal?.close();
    const modal = new EmbedDiagnosticsModal(this.plugin.app, {
      diagnostics: this.diagnostics.map(diagnostic => formatDisplayDiagnosticResolvedPath(
        diagnostic,
        value => this.toVaultFriendlyPath(value)
      )),
      onOpenInTab: () => this.openInTab(),
      suppressedCount: this.suppressedDiagnostics
    });
    this.activeDiagnosticsModal = modal;
    modal.open();
  }

  private openModeModal(): void {
    const analysis = this.currentAnalysis;
    const session = this.session;
    const permissionScopePath = this.permissionScopePath;
    if (!analysis || !session || permissionScopePath === null) return;
    const sessionToken = session.token;
    this.activeModeModal?.cancel();
    const modal = new TrustModeModal(this.plugin.app, {
      currentMode: this.currentMode,
      permissionScopePath,
      resourceScopePath: analysis.scopeRelativePath,
      onChoose: async (mode, remember) => {
        if (this.session?.token !== sessionToken) return false;
        let persisted = false;
        const applied = await applyModeChoice(
          () => this.replacePreviewSessionMode(mode, sessionToken, analysis),
          remember
            ? async () => {
              try {
                await this.plugin.rememberScopeMode(permissionScopePath, mode);
                persisted = true;
              } catch (error) {
                console.error("[ZJ HTML Studio] Failed to persist embed mode", error);
                new Notice("本次嵌入打开方式已经切换，但没有成功记住这个文件夹。");
              }
            }
            : undefined
        );
        if (applied && remember && persisted) this.modeOverride = null;
        return applied;
      }
    });
    this.activeModeModal = modal;
    modal.open();
  }

  private async replacePreviewSessionMode(
    mode: PreviewMode,
    previousToken: string,
    analysis: ScopeAnalysis,
    nextModeOverride: PreviewMode | null = mode
  ): Promise<boolean> {
    if (this.session?.token !== previousToken || this.currentAnalysis !== analysis || !this.releaseSlot) {
      return false;
    }
    const downgrade = isPreviewModeDowngrade(this.currentMode, mode);
    let transitionGeneration = this.generation;
    let oldSessionStopped = false;
    let nextSession: PreviewSession | null = null;
    let prepared: PreparedEmbedCandidate | null = null;

    try {
      if (downgrade) {
        this.cancelEntryProbe();
        transitionGeneration = ++this.generation;
        this.acquireGeneration += 1;
        this.unregisterDiagnosticSink?.();
        this.unregisterDiagnosticSink = null;
        this.unregisterScopeModeListener?.();
        this.unregisterScopeModeListener = null;
        this.clearReloadRegistration();
        this.session = null;
        this.iframe = null;
        this.currentMode = mode;
        this.modeOverride = mode;
        this.renderWaiting("旧的高权限页面已停止，正在按更低权限重开…");
        oldSessionStopped = true;
        await this.plugin.previewServer.revokeSession(previousToken);
        if (!this.isVisible) {
          this.modeOverride = nextModeOverride;
          this.releaseActiveSlot();
          this.renderWaiting("权限已收紧，滚回附近后按更低权限继续。");
          return true;
        }
      }

      const transitionIsCurrent = (): boolean => (
        !this.unloaded
        && this.isVisible
        && this.releaseSlot !== null
        && this.currentAnalysis === analysis
        && this.generation === transitionGeneration
        && (downgrade ? this.session === null : this.session?.token === previousToken)
      );
      nextSession = await this.createVerifiedPreviewSession(analysis, mode, transitionIsCurrent);
      prepared = await this.prepareEmbedCandidate(nextSession, mode, transitionIsCurrent);
      if (!transitionIsCurrent()) {
        this.discardPreparedEmbedCandidate(prepared);
        prepared = null;
        await this.plugin.previewServer.revokeSession(nextSession.token);
        nextSession = null;
        return false;
      }

      this.modeOverride = nextModeOverride;
      this.commitPreviewSession(
        nextSession,
        analysis,
        getHtmlPermissionScopePath(this.file.path),
        mode,
        prepared
      );
      prepared = null;
      nextSession = null;
      if (!downgrade) {
        await this.plugin.previewServer.revokeSession(previousToken).catch(error => {
          console.error("[ZJ HTML Studio] Failed to retire previous embed session", error);
        });
      }
      return true;
    } catch (error) {
      if (prepared) this.discardPreparedEmbedCandidate(prepared);
      if (nextSession) {
        await this.plugin.previewServer.revokeSession(nextSession.token).catch(revokeError => {
          console.error("[ZJ HTML Studio] Failed to revoke embed mode candidate", revokeError);
        });
      }
      if (oldSessionStopped && this.generation === transitionGeneration && !this.unloaded) {
        this.clearReloadRegistration();
        this.releaseActiveSlot();
        const message = toUserFacingPreviewError(error, "embed");
        this.renderError(`旧的高权限页面已经停止。${message}`);
        this.activeModeModal?.cancel();
        this.activeModeModal = null;
      }
      throw error;
    }
  }

  private async createVerifiedPreviewSession(
    analysis: ScopeAnalysis,
    mode: PreviewMode,
    isCurrent: () => boolean = () => true
  ): Promise<PreviewSession> {
    return createVerifiedEmbedSession(
      () => this.plugin.previewServer.createSession({
        entryRelativePath: this.file.path,
        mode,
        scopeRelativePath: analysis.scopeRelativePath
      }),
      async session => {
        const probe = await this.probeSessionEntry(session.token);
        if (!probe.ok) throw new PreviewEntryProbeError(probe.statusCode);
      },
      async session => {
        await this.plugin.previewServer.revokeSession(session.token);
      },
      isCurrent
    );
  }

  private async prepareEmbedCandidate(
    session: PreviewSession,
    mode: PreviewMode,
    isCurrent: () => boolean
  ): Promise<PreparedEmbedCandidate> {
    const root = this.root;
    if (!root) throw new Error("嵌入容器尚未准备完成");
    this.cancelCandidateLoad();
    const controller = new AbortController();
    this.candidateLoadAbortController = controller;
    const ticket = this.plugin.previewServer.beginSessionDocumentLoad(session.token, session.entryUrl);
    const layout = root.createDiv({
      cls: "html-studio-embed-layout html-studio-embed-candidate-layout"
    });
    layout.setAttribute("aria-hidden", "true");
    layout.setAttribute("inert", "");
    const toolbar = layout.createDiv({ cls: "html-studio-embed-toolbar" });
    const host = layout.createDiv({
      cls: "html-studio-embed-frame-host html-studio-embed-candidate-host"
    });
    this.candidateHost = host;
    const iframe = host.createEl("iframe", { cls: "html-studio-embed-iframe" });
    this.candidateIframe = iframe;
    iframe.title = `正在验证：${this.file.name}`;
    iframe.tabIndex = -1;
    iframe.setAttribute("sandbox", getPreviewIframeSandbox(mode));
    iframe.setAttribute("allow", getPreviewIframeAllow(mode));
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.allowFullscreen = true;
    const status = layout.createDiv({ cls: "html-studio-embed-status", text: "正在加载…" });

    const diagnostics: PreviewDiagnostic[] = [];
    const dependencies = new Set<string>();
    const unregisterDiagnosticSink = this.plugin.registerDiagnosticSink(session.id, diagnostic => {
      diagnostics.push(diagnostic);
    });
    const unregisterResourceSink = this.plugin.registerResourceSink(session.id, relativePath => {
      dependencies.add(relativePath);
    });
    const readiness = new EmbedCandidateReadiness();
    let navigationStarted = false;
    let settled = false;
    let timeout = 0;
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const checkReady = (): void => {
      if (settled || !readiness.ready) return;
      if (!isCurrent()) {
        settled = true;
        rejectReady(new EmbedSessionCancelledError());
        return;
      }
      settled = true;
      resolveReady();
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      rejectReady(error);
    };
    const onLoad = (): void => {
      if (!navigationStarted) return;
      readiness.markIframeLoaded();
      checkReady();
    };
    const onError = (): void => fail(new PreviewEntryProbeError(503));
    const onAbort = (): void => fail(new EmbedSessionCancelledError());
    iframe.addEventListener("load", onLoad);
    iframe.addEventListener("error", onError, { once: true });
    controller.signal.addEventListener("abort", onAbort, { once: true });
    timeout = this.context.containerEl.win.setTimeout(
      () => fail(new PreviewEntryProbeError(504)),
      EMBED_CANDIDATE_TIMEOUT_MS
    );
    navigationStarted = true;
    iframe.src = ticket.url;
    void ticket.completion.then(result => {
      if (!result.ok) {
        fail(new PreviewEntryProbeError(result.statusCode));
        return;
      }
      readiness.markResponseFinished();
      checkReady();
    }, () => fail(new PreviewEntryProbeError(503)));

    try {
      await ready;
      if (!isCurrent()) throw new EmbedSessionCancelledError();
      return {
        dependencies,
        diagnostics,
        host,
        iframe,
        layout,
        status,
        toolbar,
        unregisterDiagnosticSink,
        unregisterResourceSink
      };
    } catch (error) {
      ticket.cancel();
      unregisterDiagnosticSink();
      unregisterResourceSink();
      layout.remove();
      if (this.candidateHost === host) this.candidateHost = null;
      if (this.candidateIframe === iframe) this.candidateIframe = null;
      throw error;
    } finally {
      this.context.containerEl.win.clearTimeout(timeout);
      iframe.removeEventListener("load", onLoad);
      iframe.removeEventListener("error", onError);
      controller.signal.removeEventListener("abort", onAbort);
      if (this.candidateLoadAbortController === controller) {
        this.candidateLoadAbortController = null;
      }
    }
  }

  private cancelCandidateLoad(): void {
    this.candidateLoadAbortController?.abort();
    this.candidateLoadAbortController = null;
    this.candidateHost?.closest(".html-studio-embed-candidate-layout")?.remove();
    this.candidateHost = null;
    this.candidateIframe = null;
  }

  private discardPreparedEmbedCandidate(candidate: PreparedEmbedCandidate): void {
    candidate.unregisterDiagnosticSink();
    candidate.unregisterResourceSink();
    candidate.layout.remove();
    if (this.candidateHost === candidate.host) this.candidateHost = null;
    if (this.candidateIframe === candidate.iframe) this.candidateIframe = null;
  }

  private async probeSessionEntry(token: string): Promise<PreviewSessionProbeResult> {
    this.cancelEntryProbe();
    const controller = new AbortController();
    this.entryProbeAbortController = controller;
    try {
      const result = await this.plugin.previewServer.probeSessionEntry(token, controller.signal);
      if (result.cancelled) throw new EmbedSessionCancelledError();
      return result;
    } finally {
      if (this.entryProbeAbortController === controller) this.entryProbeAbortController = null;
    }
  }

  private cancelEntryProbe(): void {
    this.entryProbeAbortController?.abort();
    this.entryProbeAbortController = null;
  }

  private async confirmScope(analysis: ScopeAnalysis): Promise<void> {
    this.activeScopeModal?.cancel();
    const modal = new ScopeConfirmationModal(this.plugin.app, analysis);
    this.activeScopeModal = modal;
    const decision = await modal.waitForDecision();
    if (this.activeScopeModal === modal) this.activeScopeModal = null;
    if (decision === "cancel" || this.unloaded || this.pendingAnalysis !== analysis) return;
    const selectedAnalysis = decision === "entry-folder-safe"
      ? applyEntryFolderSafeTrial(analysis)
      : analysis;
    if (decision === "entry-folder-safe") {
      this.modeOverride = "safe";
      this.confirmedScopePath = null;
    } else {
      this.confirmedScopePath = analysis.scopeRelativePath;
    }
    this.pendingAnalysis = null;
    this.reloadPending = false;
    this.requestSession(selectedAnalysis);
  }

  private async reloadPreview(): Promise<void> {
    this.reloadPending = false;
    this.pendingFocusAction ??= this.captureFocusedAction();
    if (!this.releaseSlot || !this.session || !this.currentAnalysis) {
      this.requestSession();
      return;
    }
    await this.reloadWithCandidateSession("manual");
  }

  private async reloadWithCandidateSession(reason: "auto" | "manual" = "auto"): Promise<void> {
    const previousSession = this.session;
    const previousAnalysis = this.currentAnalysis;
    if (!previousSession || !previousAnalysis || !this.releaseSlot) {
      await this.reloadPreview();
      return;
    }

    const previousToken = previousSession.token;
    const focusAction = this.captureFocusedAction();
    this.cancelEntryProbe();
    const generation = ++this.generation;
    const analysisStartCheckpoint = this.plugin.getVaultChangeCheckpoint();
    const previousDependencies = this.plugin.getPreviewDependencies(this.reloadRegistrationId);
    const permissionScopePath = getHtmlPermissionScopePath(this.file.path);
    let nextConfirmedScopePath = this.confirmedScopePath;
    let candidate: PreviewSession | null = null;
    let prepared: PreparedEmbedCandidate | null = null;
    if (this.status) {
      this.status.setText(reason === "manual"
        ? "正在后台验证刷新结果…"
        : "检测到更新，正在后台验证新版本…");
      this.status.setAttribute("role", "status");
      this.status.setAttribute("aria-live", "polite");
    }

    try {
      let analysis = await analyzePreviewScope(this.plugin.vaultBasePath, this.file.path);
      if (this.unloaded || !this.isVisible || this.generation !== generation || this.session?.token !== previousToken) {
        return;
      }
      if (shouldConfirmScope(
        analysis.requiresConfirmation,
        nextConfirmedScopePath,
        analysis.scopeRelativePath
      )) {
        const modal = new ScopeConfirmationModal(this.plugin.app, analysis);
        this.activeScopeModal = modal;
        const decision = await modal.waitForDecision();
        if (this.activeScopeModal === modal) this.activeScopeModal = null;
        if (this.unloaded || this.generation !== generation || this.session?.token !== previousToken) return;
        if (decision === "cancel") {
          this.setCandidateReloadError("新版本需要更大的资源范围；未获得确认，继续显示上一次可用版本。");
          return;
        }
        if (decision === "entry-folder-safe") {
          analysis = applyEntryFolderSafeTrial(analysis);
          this.modeOverride = "safe";
          nextConfirmedScopePath = null;
        } else {
          nextConfirmedScopePath = analysis.scopeRelativePath;
        }
      }

      let nextMode = this.modeOverride ?? this.plugin.getScopeMode(permissionScopePath);
      let nextModeOverride = this.modeOverride;
      if (nextMode !== this.currentMode) {
        if (isPreviewModeDowngrade(this.currentMode, nextMode)) {
          this.modeOverride = nextMode;
          this.confirmedScopePath = nextConfirmedScopePath;
          this.pendingFocusAction = focusAction;
          await this.cleanupPreview(false);
          if (!this.unloaded && this.isVisible) await this.loadPreview(analysis);
          return;
        }
        nextMode = this.currentMode;
        nextModeOverride = this.currentMode;
      }

      const candidateIsCurrent = (): boolean => (
        !this.unloaded
        && this.isVisible
        && this.generation === generation
        && this.session?.token === previousToken
      );
      candidate = await this.createVerifiedPreviewSession(analysis, nextMode, candidateIsCurrent);
      prepared = await this.prepareEmbedCandidate(candidate, nextMode, candidateIsCurrent);
      if (
        !candidateIsCurrent()
      ) {
        this.discardPreparedEmbedCandidate(prepared);
        prepared = null;
        await this.plugin.previewServer.revokeSession(candidate.token);
        candidate = null;
        return;
      }

      this.confirmedScopePath = nextConfirmedScopePath;
      this.modeOverride = nextModeOverride;
      this.pendingFocusAction = focusAction;
      const runtimeDependencies = [...prepared.dependencies];
      this.commitPreviewSession(candidate, analysis, permissionScopePath, nextMode, prepared);
      prepared = null;
      candidate = null;
      await this.plugin.previewServer.revokeSession(previousToken).catch(error => {
        console.error("[ZJ HTML Studio] Failed to retire previous embed auto-reload session", error);
      });

      const relevantDependencies = [
        ...previousDependencies,
        ...analysis.dependencyRelativePaths,
        ...runtimeDependencies
      ];
      if (
        this.plugin.settings.autoReload
        && this.plugin.didVaultPathsChangeSince(analysisStartCheckpoint, relevantDependencies)
      ) {
        this.plugin.requestPreviewReload(this.reloadRegistrationId);
      }
    } catch (error) {
      if (prepared) this.discardPreparedEmbedCandidate(prepared);
      if (candidate) {
        await this.plugin.previewServer.revokeSession(candidate.token).catch(revokeError => {
          console.error("[ZJ HTML Studio] Failed to revoke embed auto-reload candidate", revokeError);
        });
      }
      if (this.unloaded || this.generation !== generation || this.session?.token !== previousToken) return;
      const message = toUserFacingPreviewError(error, "embed");
      this.setCandidateReloadError(
        reason === "manual"
          ? `刷新没有应用新版本：${message} 当前仍显示上一次可用版本。`
          : `自动刷新没有应用新版本：${message} 当前仍显示上一次可用版本。`,
        reason === "manual" ? "刷新没有应用新版本" : "自动刷新没有应用新版本"
      );
    }
  }

  private setCandidateReloadError(message: string, title = "自动刷新没有应用新版本"): void {
    this.rememberDisplayDiagnostic({
      level: "warning",
      title,
      detail: message
    });
    this.updateDiagnosticCount();
    if (!this.status) return;
    this.status.setText(message);
    this.status.setAttribute("aria-live", "assertive");
    this.status.setAttribute("role", "alert");
  }

  private rememberDisplayDiagnostic(incoming: DisplayDiagnostic): void {
    const normalizePath = (value: string): string => this.toVaultFriendlyPath(value);
    const identity = getDisplayDiagnosticKey(incoming, normalizePath);
    if (this.diagnosticIdentities.has(identity)) {
      const updated = upsertDisplayDiagnostic(this.diagnostics, incoming, normalizePath);
      if (updated.length === this.diagnostics.length) this.diagnostics = updated;
      return;
    }

    this.diagnosticIdentities.add(identity);
    if (this.diagnostics.length < MAX_EMBED_DIAGNOSTICS) {
      this.diagnostics = upsertDisplayDiagnostic(this.diagnostics, incoming, normalizePath);
      return;
    }
    this.suppressedDiagnostics += 1;
  }

  private captureFocusedAction(): string | null {
    const root = this.root;
    const active = this.context.containerEl.doc.activeElement as HTMLElement | null;
    if (!root || !active || !root.contains(active)) return null;
    return active.closest<HTMLElement>("[data-html-studio-action]")?.dataset.htmlStudioAction ?? null;
  }

  private restoreFocusedAction(): void {
    const action = this.pendingFocusAction;
    this.pendingFocusAction = null;
    if (!action || !this.root) return;
    this.root.querySelector<HTMLElement>(`[data-html-studio-action="${action}"]`)?.focus();
  }

  private async reloadAfterDependencyChange(): Promise<void> {
    if (
      this.plugin.settings.autoReload
      && isFullscreenTarget(this.iframe, this.context.containerEl.doc)
    ) {
      this.reloadPending = true;
      return;
    }
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
    await this.reloadWithCandidateSession();
  }

  private handleFullscreenChange(): void {
    if (!this.reloadPending || this.unloaded || !this.isVisible) return;
    if (isFullscreenTarget(this.iframe, this.context.containerEl.doc)) return;
    this.reloadPending = false;
    void this.reloadAfterDependencyChange();
  }

  private async handleScopeModeChange(change: ScopeModeChange): Promise<void> {
    const analysis = this.currentAnalysis;
    const session = this.session;
    const permissionScopePath = this.permissionScopePath;
    if (!analysis || !session || permissionScopePath === null) return;
    const nextMode = this.plugin.getScopeMode(permissionScopePath);
    const action = decideScopeModeChange({
      currentMode: this.currentMode,
      forceSafeReset: change.forceSafeReset,
      modeOverride: this.modeOverride,
      persistentMode: nextMode
    });
    if (action === "ignore") return;
    if (action === "clear-override") {
      this.modeOverride = null;
      return;
    }
    if (action === "pin-current") {
      this.modeOverride = this.currentMode;
      return;
    }

    this.activeModeModal?.cancel();
    this.activeModeModal = null;
    await this.replacePreviewSessionMode(nextMode, session.token, analysis, null);
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
    const issueText = this.diagnosticCount === 0 ? "无提醒" : `${this.diagnosticCount} 个提醒`;
    const modeText = getPreviewModePresentation(mode).label;
    const analysis = this.currentAnalysis;
    const scriptRestriction = analysis
      ? getScriptRestrictionPresentation(analysis, mode)
      : null;
    if (scriptRestriction) {
      const scriptText = analysis?.pageScriptAnalysis.complete === false
        ? "脚本分析未完成"
        : `已关闭 ${analysis!.pageScriptCount} 个页面脚本`;
      this.status.setText(`${modeText} ${scriptText} · ${issueText} · ${scopePath || "整个知识仓库"}`);
      return;
    }
    this.status.setText(`${modeText} · ${issueText} · ${scopePath || "整个知识仓库"}`);
  }

  private updateDiagnosticCount(): void {
    this.diagnosticCount = this.diagnostics.length + this.suppressedDiagnostics;
    if (!this.diagnosticButton) return;
    const label = this.diagnosticCount === 0
      ? "诊断：没有提醒"
      : `诊断：${this.diagnosticCount} 个提醒`;
    this.diagnosticButton.setAttribute("aria-label", label);
    this.diagnosticButton.title = label;
  }

  private toVaultFriendlyPath(value: string): string {
    return toVaultRelativePath(this.plugin.vaultBasePath, value)
      ?? "知识仓库之外（已阻止）";
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
      this.cancelEntryProbe();
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
    this.cancelCandidateLoad();
    this.cancelEntryProbe();
    this.activeModeModal?.cancel();
    this.activeModeModal = null;
    this.unregisterDiagnosticSink?.();
    this.unregisterDiagnosticSink = null;
    this.unregisterScopeModeListener?.();
    this.unregisterScopeModeListener = null;
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

  private ensureScopeModeListener(): void {
    if (this.unregisterScopeModeListener) return;
    this.unregisterScopeModeListener = this.plugin.registerScopeModeListener(change => (
      this.handleScopeModeChange(change)
    ));
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
