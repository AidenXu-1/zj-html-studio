import { FileView, Notice, setIcon, type TFile, type WorkspaceLeaf } from "obsidian";
import { shell } from "electron";
import path from "node:path";
import type HtmlStudioPlugin from "../main";
import type { ScopeModeChange } from "../main";
import { analyzePreviewScope, type ScopeAnalysis } from "../scope/dependency-analyzer";
import { toVaultRelativePath } from "../scope/vault-path";
import { applyEntryFolderSafeTrial } from "../scope/resource-scope-policy";
import { getHtmlPermissionScopePath, type PreviewMode } from "../settings";
import { UnsupportedHtmlEncodingError } from "../server/html-encoding";
import type {
  PreviewDiagnostic,
  PreviewSession,
  PreviewSessionProbeResult
} from "../server/preview-server";
import type { SearchBridgeMessage } from "../server/search-bridge";
import { BrowserOpenModal } from "../ui/browser-open-modal";
import {
  buildAnalysisDiagnostics,
  buildRuntimeDiagnostic,
  countAnalysisDiagnostics,
  type DisplayDiagnostic,
  getScriptRestrictionPresentation,
  upsertDisplayDiagnostic
} from "../ui/diagnostics";
import { isFullscreenTarget, toggleFullscreenTarget } from "../ui/fullscreen";
import { ScopeConfirmationModal } from "../ui/scope-confirmation-modal";
import { ScopeExpansionModal } from "../ui/scope-expansion-modal";
import { TrustModeModal } from "../ui/trust-mode-modal";
import { PreviewEntryProbeError, toUserFacingPreviewError } from "../ui/error-message";
import {
  applyModeChoice,
  createPreviewRecoveryOptions,
  decideScopeModeChange,
  isPreviewModeDowngrade,
  isPolicyBoundLoadCurrent,
  resolvePreviewMode,
  resolveSessionlessPolicyReloadMode,
  shouldConfirmScope,
  type PreviewRecoveryOptions
} from "./preview-load-policy";
import { canOpenBrowserSession, MAX_BROWSER_SESSIONS_PER_VIEW } from "./browser-session-policy";
import { decideAutoReloadAction, isAutoReloadCandidateCurrent } from "./auto-reload-policy";
import { PreviewCandidateReadiness } from "./preview-candidate-readiness";
import {
  getPreviewIframeAllow,
  getPreviewIframeSandbox,
  getPreviewModePresentation
} from "./preview-mode";
import {
  isSourceReadCurrent,
  MAX_SOURCE_VIEW_BYTES,
  readSourceTextWithBudget,
  sourceViewBudget,
  type SourceViewBudgetLease,
  SourceViewCapacityError,
  SourceViewTooLargeError
} from "./source-read-policy";
import {
  buildSourceLineIndex,
  findTextOccurrences,
  getSourceLineScrollRatioFromIndex,
  moveSearchIndex,
  normalizeTextSearchQuery,
  type SourceLineIndex
} from "./text-search";
import { stepPreviewZoom } from "./zoom";
import {
  buildReadingStateUrl,
  isReadingStateRestorable,
  isSameReadingLocation,
  parseBridgePageState,
  type PreviewReadingState
} from "./preview-reading-state";

const BROWSER_SESSION_TTL_MS = 30 * 60 * 1_000;
const MAX_DISPLAY_DIAGNOSTICS = 100;
type ViewMode = "preview" | "source";

interface PreviewLoadOptions {
  confirmedScopePath?: string | null;
  modeOverride?: PreviewMode | null;
  preserveBrowserSessions?: boolean;
  preserveReadingState?: boolean;
}

interface SourceReadingState {
  focused: boolean;
  scrollLeft: number;
  scrollTop: number;
  searchIndex: number;
  selectionEnd: number;
  selectionStart: number;
}

interface PreparedPreviewCandidate {
  diagnostics: PreviewDiagnostic[];
  dependencies: Set<string>;
  host: HTMLElement;
  iframe: HTMLIFrameElement;
  port: MessagePort | null;
  restoreState: PreviewReadingState | null;
  session: PreviewSession;
  unregisterDiagnosticSink: () => void;
  unregisterResourceSink: () => void;
}

export const HTML_PREVIEW_VIEW_TYPE = "html-studio-preview";

export class HtmlPreviewView extends FileView {
  private activeIframe: HTMLIFrameElement | null = null;
  private analysis: ScopeAnalysis | null = null;
  private activePageRestoreState: PreviewReadingState | null = null;
  private autoReloadButton: HTMLButtonElement | null = null;
  private activeBrowserModal: BrowserOpenModal | null = null;
  private activeModeModal: TrustModeModal | null = null;
  private activeScopeModal: ScopeConfirmationModal | null = null;
  private activeScopeExpansionModal: ScopeExpansionModal | null = null;
  private readonly browserSessions = new Map<string, number>();
  private browserSessionOpenInProgress = false;
  private browserSessionGeneration = 0;
  private browserSessionProbeAbortController: AbortController | null = null;
  private confirmedScopePath: string | null = null;
  private candidateAbortController: AbortController | null = null;
  private candidateHost: HTMLElement | null = null;
  private candidateProbeAbortController: AbortController | null = null;
  private candidateTransitionGeneration = 0;
  private readonly reloadRegistrationId: string;
  private diagnosticBadge: HTMLElement | null = null;
  private deferredFullscreenReload = false;
  private deferredManualReload = false;
  private diagnostics: DisplayDiagnostic[] = [];
  private diagnosticsDrawer: HTMLElement | null = null;
  private diagnosticsRenderFrame: number | null = null;
  private fullscreenButton: HTMLButtonElement | null = null;
  private iframeHost: HTMLElement | null = null;
  private previewCanvas: HTMLElement | null = null;
  private loadAbortController: AbortController | null = null;
  private loadGeneration = 0;
  private lastPageReadingState: PreviewReadingState | null = null;
  private readingStateRevision = 0;
  private readonly readingStateWaiters = new Set<() => void>();
  private mode: PreviewMode = "safe";
  private modeOverride: PreviewMode | null = null;
  private modeButton: HTMLButtonElement | null = null;
  private previewPolicyGeneration = 0;
  private permissionScopePath: string | null = null;
  private searchBar: HTMLElement | null = null;
  private searchBridgePort: MessagePort | null = null;
  private searchBridgeReady = false;
  private searchButton: HTMLButtonElement | null = null;
  private searchCount: HTMLElement | null = null;
  private searchDebounceTimer: number | null = null;
  private searchHandshakeTimer: number | null = null;
  private searchInput: HTMLInputElement | null = null;
  private searchQuery = "";
  private searchRequestId = 0;
  private session: PreviewSession | null = null;
  private sourceHost: HTMLElement | null = null;
  private sourceBudgetLease: SourceViewBudgetLease | null = null;
  private sourceLoadPromise: Promise<boolean> | null = null;
  private sourceReadAbortController: AbortController | null = null;
  private sourceLoadGeneration = 0;
  private sourceLineIndex: SourceLineIndex | null = null;
  private pendingSourceReadingState: SourceReadingState | null = null;
  private sourcePositions: number[] = [];
  private sourceSearchIndex = -1;
  private sourceText: string | null = null;
  private sourceTextarea: HTMLTextAreaElement | null = null;
  private statusEl: HTMLElement | null = null;
  private suppressedDiagnostics = 0;
  private unregisterDiagnosticSink: (() => void) | null = null;
  private unregisterAutoReloadListener: (() => void) | null = null;
  private unregisterScopeModeListener: (() => void) | null = null;
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
    this.unregisterScopeModeListener = this.plugin.registerScopeModeListener(change => (
      this.handleScopeModeChange(change)
    ));
    this.registerDomEvent(this.contentEl.doc, "fullscreenchange", () => this.handleFullscreenChange());
    this.registerDomEvent(this.contentEl.win, "message", event => this.handleSearchBridgeMessage(event));
    this.registerDomEvent(this.contentEl, "keydown", event => {
      if (isImeComposing(event)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "f") {
        event.preventDefault();
        this.openSearch();
      }
    });
  }

  override async onLoadFile(file: TFile): Promise<void> {
    this.confirmedScopePath = null;
    this.mode = "safe";
    this.modeOverride = null;
    this.viewMode = "preview";
    this.zoom = 100;
    this.searchQuery = "";
    await this.loadPreview(file);
  }

  private async loadPreview(file: TFile, options: PreviewLoadOptions = {}): Promise<void> {
    const preservedSearchState = options.preserveReadingState
      ? {
        focused: this.contentEl.doc.activeElement === this.searchInput,
        open: this.searchBar?.hasClass("is-open") ?? false
      }
      : null;
    if (options.preserveReadingState) this.prepareReadingStateForReplacement();
    const generation = this.beginLoad();
    const policyGeneration = this.previewPolicyGeneration;
    const analysisStartCheckpoint = this.plugin.getVaultChangeCheckpoint();
    const previousDependencies = this.plugin.getPreviewDependencies(this.reloadRegistrationId);
    let requestedModeOverride = options.modeOverride ?? null;
    let recoveryMode = requestedModeOverride ?? this.mode;
    this.confirmedScopePath = options.confirmedScopePath ?? null;
    const signal = this.loadAbortController!.signal;
    const loadIsCurrent = (): boolean => (
      this.isLoadCurrent(generation, signal)
      && isPolicyBoundLoadCurrent({
        currentFilePath: this.file?.path ?? null,
        currentLoadGeneration: this.loadGeneration,
        currentPolicyGeneration: this.previewPolicyGeneration,
        filePath: file.path,
        loadGeneration: generation,
        policyGeneration
      })
    );
    await this.cleanupSession({
      preserveBrowserSessions: options.preserveBrowserSessions ?? false,
      preserveReloadRegistration: true
    });
    if (!loadIsCurrent()) return;

    this.analysis = null;
    this.permissionScopePath = null;
    this.diagnostics = [];
    this.suppressedDiagnostics = 0;
    this.mode = "safe";
    this.resetSearchBridge();
    if (!options.preserveReadingState) {
      this.activePageRestoreState = null;
      this.lastPageReadingState = null;
      this.pendingSourceReadingState = null;
    }
    this.releaseSourceContent();
    this.contentEl.empty();
    this.contentEl.addClass("html-studio-view");
    this.renderShell();
    this.restoreSearchBarAfterShell(preservedSearchState);
    this.setStatus("正在分析页面需要的资源…", "loading");

    try {
      let analysis = await analyzePreviewScope(this.plugin.vaultBasePath, file.path, { signal });
      if (!loadIsCurrent()) return;

      if (shouldConfirmScope(analysis.requiresConfirmation, this.confirmedScopePath, analysis.scopeRelativePath)) {
        const modal = new ScopeConfirmationModal(this.app, analysis);
        this.activeScopeModal = modal;
        const decision = await modal.waitForDecision();
        if (this.activeScopeModal === modal) this.activeScopeModal = null;
        if (!loadIsCurrent()) return;
        if (decision === "cancel") {
          this.clearReloadRegistration();
          this.confirmedScopePath = null;
          const message = "你取消了较大资源范围，本次没有创建本地预览会话。";
          this.setStatus(message, "error");
          this.renderFatalError(
            message,
            createPreviewRecoveryOptions(recoveryMode, null)
          );
          return;
        }
        if (decision === "entry-folder-safe") {
          analysis = applyEntryFolderSafeTrial(analysis);
          requestedModeOverride = "safe";
          recoveryMode = "safe";
          this.confirmedScopePath = null;
        } else {
          this.confirmedScopePath = analysis.scopeRelativePath;
        }
      }

      const mode = resolvePreviewMode(
        this.plugin.getScopeMode(getHtmlPermissionScopePath(file.path)),
        requestedModeOverride ?? undefined
      );
      recoveryMode = mode;
      if (!loadIsCurrent()) return;
      const session = await this.plugin.previewServer.createSession({
        enableSearchBridge: true,
        entryRelativePath: file.path,
        mode,
        scopeRelativePath: analysis.scopeRelativePath
      });
      if (!loadIsCurrent()) {
        await this.plugin.previewServer.revokeSession(session.token);
        return;
      }
      const probe = await this.plugin.previewServer.probeSessionEntry(session.token, signal);
      if (!loadIsCurrent()) {
        await this.plugin.previewServer.revokeSession(session.token);
        return;
      }
      if (!probe.ok) {
        await this.plugin.previewServer.revokeSession(session.token);
        throw new PreviewEntryProbeError(probe.statusCode);
      }

      this.analysis = analysis;
      this.permissionScopePath = getHtmlPermissionScopePath(file.path);
      const initialDiagnostics = buildAnalysisDiagnostics(analysis, MAX_DISPLAY_DIAGNOSTICS, mode);
      this.diagnostics = initialDiagnostics;
      this.suppressedDiagnostics = Math.max(0, countAnalysisDiagnostics(analysis, mode) - initialDiagnostics.length);
      this.mode = mode;
      this.modeOverride = requestedModeOverride;
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
      if (!loadIsCurrent() || isAbortError(error)) return;
      this.clearReloadRegistration();
      const recoveryScopePath = this.confirmedScopePath;
      this.confirmedScopePath = null;
      const message = toUserFacingPreviewError(error, "page");
      this.setStatus(message, "error");
      this.renderFatalError(
        message,
        createPreviewRecoveryOptions(recoveryMode, recoveryScopePath)
      );
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
    this.unregisterScopeModeListener?.();
    this.unregisterScopeModeListener = null;
  }

  refreshPreview(): void {
    if (!this.file || !this.getPreviewIframe() || !this.session || !this.analysis) return;
    if (isFullscreenTarget(this.getPreviewIframe(), this.contentEl.doc)) {
      this.deferredManualReload = true;
      this.setStatus("退出全屏后会刷新；当前页面继续保持。", "loading");
      return;
    }
    void this.reloadWithCandidateSession(this.file, "manual");
  }

  private beginLoad(): number {
    this.loadGeneration += 1;
    this.deferredFullscreenReload = false;
    this.deferredManualReload = false;
    this.cancelCandidateTransition();
    this.loadAbortController?.abort();
    this.cancelSourceRead();
    this.loadAbortController = new AbortController();
    this.activeScopeModal?.cancel();
    this.activeScopeModal = null;
    this.activeScopeExpansionModal?.cancel();
    this.activeScopeExpansionModal = null;
    this.activeBrowserModal?.cancel();
    this.activeBrowserModal = null;
    this.activeModeModal?.cancel();
    this.activeModeModal = null;
    return this.loadGeneration;
  }

  private cancelActiveLoad(): void {
    this.loadGeneration += 1;
    this.deferredFullscreenReload = false;
    this.deferredManualReload = false;
    this.cancelCandidateTransition();
    this.loadAbortController?.abort();
    this.loadAbortController = null;
    this.cancelSourceRead();
    this.activeScopeModal?.cancel();
    this.activeScopeModal = null;
    this.activeScopeExpansionModal?.cancel();
    this.activeScopeExpansionModal = null;
    this.activeBrowserModal?.cancel();
    this.activeBrowserModal = null;
    this.activeModeModal?.cancel();
    this.activeModeModal = null;
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
    this.statusEl.setAttribute("aria-live", "polite");
    this.statusEl.setAttribute("role", "status");
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
    bar.setAttribute("aria-hidden", "true");
    bar.setAttribute("inert", "");
    const icon = bar.createSpan({ cls: "html-studio-search-icon" });
    setIcon(icon, "search");
    this.searchInput = bar.createEl("input", {
      attr: {
        "aria-label": "查找当前 HTML 内容",
        maxlength: "500",
        placeholder: "查找当前 HTML 内容"
      },
      type: "search"
    });
    this.searchInput.value = this.searchQuery;
    this.searchInput.addEventListener("input", event => {
      this.searchQuery = this.searchInput?.value ?? "";
      if ("isComposing" in event && event.isComposing === true) return;
      this.scheduleSearch();
    });
    this.searchInput.addEventListener("compositionstart", () => this.clearSearchDebounce());
    this.searchInput.addEventListener("compositionend", () => {
      this.searchQuery = this.searchInput?.value ?? "";
      this.scheduleSearch();
    });
    this.searchInput.addEventListener("keydown", event => {
      if (isImeComposing(event)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeSearch();
        return;
      }
      if (event.key !== "Enter") return;
      event.preventDefault();
      this.runSearch(event.shiftKey ? "previous" : "next");
    });
    this.searchCount = bar.createSpan({ cls: "html-studio-search-count", text: "0 / 0" });
    this.searchCount.setAttribute("aria-live", "polite");
    this.searchCount.setAttribute("role", "status");
    this.createIconButton(bar, "chevron-up", "上一处", () => this.runSearch("previous"));
    this.createIconButton(bar, "chevron-down", "下一处", () => this.runSearch("next"));
    this.createIconButton(bar, "x", "关闭查找", () => this.closeSearch());
  }

  private restoreSearchBarAfterShell(state: { focused: boolean; open: boolean } | null): void {
    if (!state?.open || !this.searchBar) return;
    this.searchBar.addClass("is-open");
    this.searchBar.removeAttribute("aria-hidden");
    this.searchBar.removeAttribute("inert");
    if (state.focused) this.searchInput?.focus();
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
    this.prepareReadingStateForReplacement();
    this.resetSearchBridge();
    this.releaseSourceContent();
    this.activeIframe = null;
    this.iframeHost.empty();
    this.previewCanvas = this.iframeHost.createDiv({ cls: "html-studio-preview-canvas" });
    const iframe = this.previewCanvas.createEl("iframe", { cls: "html-studio-iframe" });
    iframe.title = `HTML 预览：${this.file?.name ?? "当前文件"}`;
    iframe.setAttribute("sandbox", getPreviewIframeSandbox(this.mode, Boolean(this.session.searchChannel)));
    iframe.setAttribute("allow", getPreviewIframeAllow(this.mode));
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.allowFullscreen = true;
    this.applyZoomToIframe(iframe);
    const sessionToken = this.session.token;
    this.activeIframe = iframe;
    this.bindActiveIframeLifecycle(iframe, sessionToken);
    iframe.addEventListener("load", () => {
      void this.verifyInitialIframeLoad(iframe, sessionToken);
    }, { once: true });
    const resourceScopePath = this.analysis?.scopeRelativePath ?? this.session.scopeRelativePath;
    const restoreState = isReadingStateRestorable(
      resourceScopePath,
      this.activePageRestoreState
    ) ? this.activePageRestoreState : null;
    this.activePageRestoreState = restoreState;
    const url = new URL(buildReadingStateUrl(
      this.session.entryUrl,
      resourceScopePath,
      restoreState
    ));
    iframe.src = url.toString();
    this.renderScriptRestrictionNotice();
    this.setStatus("正在打开 HTML 页面…", "loading");
    this.applyZoom();
    this.applyViewMode();
    if (this.viewMode === "source") void this.loadSource();
    this.updateFullscreenButton();
    this.renderDiagnostics();
  }

  private bindActiveIframeLifecycle(iframe: HTMLIFrameElement, sessionToken: string): void {
    iframe.addEventListener("load", () => {
      if (this.session?.token !== sessionToken || this.getPreviewIframe() !== iframe) return;
      this.resetSearchBridge();
      if (this.searchCount) this.searchCount.setText("当前页面不可用");
      this.setStatus("正在确认当前页面是否仍由本地预览保护…", "loading");
      this.updateSearchState();
      if (!this.session?.searchChannel) {
        this.updatePreviewLoadedStatus();
        return;
      }
      this.searchHandshakeTimer = this.contentEl.win.setTimeout(() => {
        this.searchHandshakeTimer = null;
        if (this.session?.token !== sessionToken || this.getPreviewIframe() !== iframe || this.searchBridgeReady) {
          return;
        }
        if (this.searchCount) this.searchCount.setText("查找不可用");
        this.updateSearchState();
      }, 1_500);
    });
    iframe.addEventListener("error", () => this.setStatus("页面容器加载失败，请打开诊断查看原因", "error"));
  }

  private async verifyInitialIframeLoad(iframe: HTMLIFrameElement, sessionToken: string): Promise<void> {
    const probe = await this.plugin.previewServer.probeSessionEntry(
      sessionToken,
      this.loadAbortController?.signal
    );
    if (probe.cancelled) return;
    if (this.session?.token !== sessionToken || this.getPreviewIframe() !== iframe) return;
    if (!probe.ok) {
      const message = toUserFacingPreviewError(new PreviewEntryProbeError(probe.statusCode), "page");
      this.setStatus(message, "error");
      const updated = upsertDisplayDiagnostic(this.diagnostics, {
        level: "error",
        title: "HTML 入口没有成功响应",
        detail: message
      });
      if (updated.length <= MAX_DISPLAY_DIAGNOSTICS) this.diagnostics = updated;
      else this.suppressedDiagnostics += 1;
      this.scheduleDiagnosticsRender();
      return;
    }
    this.updatePreviewLoadedStatus();
    this.updateSearchState();
  }

  private async preparePreviewCandidate(
    session: PreviewSession,
    analysis: ScopeAnalysis,
    mode: PreviewMode,
    parentSignal?: AbortSignal
  ): Promise<PreparedPreviewCandidate> {
    if (!this.iframeHost) throw new Error("预览容器尚未准备完成");
    this.cancelCandidateTransition();
    const transitionGeneration = this.candidateTransitionGeneration;
    const controller = new AbortController();
    this.candidateAbortController = controller;
    const abortFromParent = (): void => controller.abort();
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    if (parentSignal?.aborted) controller.abort();
    await this.captureLatestPageState();
    if (
      controller.signal.aborted
      || this.candidateTransitionGeneration !== transitionGeneration
    ) {
      parentSignal?.removeEventListener("abort", abortFromParent);
      if (this.candidateAbortController === controller) this.candidateAbortController = null;
      throw createCandidateAbortError();
    }

    const resourceScopePath = analysis.scopeRelativePath;
    const latestReadingState = this.lastPageReadingState ?? this.activePageRestoreState;
    const restoreState = isReadingStateRestorable(resourceScopePath, latestReadingState)
      ? latestReadingState
      : null;
    const targetUrl = buildReadingStateUrl(session.entryUrl, resourceScopePath, restoreState);
    const ticket = this.plugin.previewServer.beginSessionDocumentLoad(session.token, targetUrl);
    const host = this.contentEl.doc.body.createDiv({
      cls: "html-studio-preview-canvas html-studio-preview-candidate"
    });
    host.remove();
    host.setAttribute("aria-hidden", "true");
    host.setAttribute("inert", "");
    const iframe = host.createEl("iframe", { cls: "html-studio-iframe" });
    iframe.title = `正在验证：${this.file?.name ?? "当前 HTML"}`;
    iframe.tabIndex = -1;
    iframe.setAttribute("sandbox", getPreviewIframeSandbox(mode, Boolean(session.searchChannel)));
    iframe.setAttribute("allow", getPreviewIframeAllow(mode));
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.allowFullscreen = true;
    this.applyZoomToIframe(iframe);

    const diagnostics: PreviewDiagnostic[] = [];
    const dependencies = new Set<string>();
    const unregisterDiagnosticSink = this.plugin.registerDiagnosticSink(session.id, diagnostic => {
      diagnostics.push(diagnostic);
    });
    const unregisterResourceSink = this.plugin.registerResourceSink(session.id, relativePath => {
      dependencies.add(relativePath);
    });

    const bridge: {
      listener: ((event: MessageEvent<unknown>) => void) | null;
      port: MessagePort | null;
    } = { listener: null, port: null };
    const readiness = new PreviewCandidateReadiness(Boolean(restoreState));
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
      settled = true;
      resolveReady();
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      rejectReady(error);
    };
    const sendRestore = (): void => {
      if (!bridge.port || !restoreState || !readiness.canSendRestore) return;
      bridge.port.postMessage({
        channel: session.searchChannel,
        scrollX: restoreState.scrollX,
        scrollY: restoreState.scrollY,
        type: "html-studio-page-state-restore"
      });
    };
    const onWindowMessage = (event: MessageEvent<unknown>): void => {
      if (
        event.source !== iframe.contentWindow
        || event.origin !== session.origin
        || !session.searchChannel
        || !isSearchBridgeMessage(event.data)
        || event.data.type !== "html-studio-search-ready"
        || event.data.channel !== session.searchChannel
      ) return;
      const port = event.ports[0];
      if (!port) return;
      if (bridge.port && bridge.listener) {
        bridge.port.removeEventListener("message", bridge.listener);
        bridge.port.close();
      }
      bridge.port = port;
      readiness.markBridgeReady();
      bridge.listener = portEvent => {
        const data = portEvent.data;
        if (
          !isSearchBridgeMessage(data)
          || data.channel !== session.searchChannel
          || data.type !== "html-studio-page-state-restored"
        ) return;
        readiness.markRestoreReady();
        checkReady();
      };
      port.addEventListener("message", bridge.listener);
      port.start();
      sendRestore();
      checkReady();
    };
    let navigationStarted = false;
    let ticketReady = false;
    const onLoad = (): void => {
      if (!navigationStarted || !ticketReady) return;
      readiness.markIframeLoaded();
      checkReady();
    };
    const onError = (): void => fail(new PreviewEntryProbeError(503));
    const onAbort = (): void => fail(createCandidateAbortError());

    this.contentEl.win.addEventListener("message", onWindowMessage);
    iframe.addEventListener("load", onLoad);
    iframe.addEventListener("error", onError, { once: true });
    controller.signal.addEventListener("abort", onAbort, { once: true });
    timeout = this.contentEl.win.setTimeout(() => fail(new PreviewEntryProbeError(504)), 16_000);
    this.iframeHost.append(host);
    this.candidateHost = host;
    navigationStarted = true;
    iframe.src = ticket.url;
    void ticket.completion.then(result => {
      if (!result.ok) {
        fail(new PreviewEntryProbeError(result.statusCode));
        return;
      }
      ticketReady = true;
      readiness.configureBridgeRequirement(Boolean(result.searchBridgeAvailable));
      readiness.markTicketReady();
      sendRestore();
      checkReady();
    }, () => fail(new PreviewEntryProbeError(503)));

    try {
      await ready;
      if (bridge.port && bridge.listener) {
        bridge.port.removeEventListener("message", bridge.listener);
      }
      return {
        diagnostics,
        dependencies,
        host,
        iframe,
        port: bridge.port,
        restoreState,
        session,
        unregisterDiagnosticSink,
        unregisterResourceSink
      };
    } catch (error) {
      ticket.cancel();
      bridge.port?.close();
      unregisterDiagnosticSink();
      unregisterResourceSink();
      host.remove();
      await this.plugin.previewServer.revokeSession(session.token).catch(revokeError => {
        console.error("[ZJ HTML Studio] Failed to revoke rejected candidate", revokeError);
      });
      throw error;
    } finally {
      this.contentEl.win.clearTimeout(timeout);
      this.contentEl.win.removeEventListener("message", onWindowMessage);
      iframe.removeEventListener("load", onLoad);
      iframe.removeEventListener("error", onError);
      controller.signal.removeEventListener("abort", onAbort);
      parentSignal?.removeEventListener("abort", abortFromParent);
      if (this.candidateAbortController === controller) this.candidateAbortController = null;
      if (this.candidateHost === host && !host.isConnected) this.candidateHost = null;
    }
  }

  private promotePreviewCandidate(candidate: PreparedPreviewCandidate): void {
    this.resetSearchBridge();
    if (this.viewMode === "source") this.prepareReadingStateForReplacement();
    this.releaseSourceContent();
    this.activeIframe = null;
    this.previewCanvas?.remove();
    candidate.host.removeClass("html-studio-preview-candidate");
    candidate.host.removeAttribute("aria-hidden");
    candidate.host.removeAttribute("inert");
    candidate.iframe.removeAttribute("tabindex");
    candidate.iframe.title = `HTML 预览：${this.file?.name ?? "当前文件"}`;
    this.previewCanvas = candidate.host;
    this.activeIframe = candidate.iframe;
    this.candidateHost = null;
    this.bindActiveIframeLifecycle(candidate.iframe, candidate.session.token);
    candidate.unregisterDiagnosticSink();
    candidate.unregisterResourceSink();
    this.unregisterDiagnosticSink = this.plugin.registerDiagnosticSink(candidate.session.id, diagnostic => {
      this.addRuntimeDiagnostic(diagnostic);
    });
    candidate.diagnostics.forEach(diagnostic => this.mergeCandidateDiagnostic(diagnostic));
    if (candidate.port && candidate.session.searchChannel) {
      this.searchBridgePort = candidate.port;
      this.searchBridgeReady = true;
      candidate.port.addEventListener("message", event => {
        this.handleSearchBridgePortMessage(event.data, candidate.session.token, candidate.port!);
      });
      candidate.port.start();
    }
    this.activePageRestoreState = null;
    this.lastPageReadingState = candidate.restoreState;
    this.renderScriptRestrictionNotice();
    this.applyZoom();
    this.applyViewMode();
    if (this.viewMode === "source") {
      const normalizedSearchQuery = normalizeTextSearchQuery(this.searchQuery);
      const shouldResumeSearch = Boolean(
        this.searchBar?.hasClass("is-open") && normalizedSearchQuery
      );
      if (shouldResumeSearch) this.setSearchCountText("正在定位…");
      else if (this.searchBar?.hasClass("is-open")) this.updateSearchCount(0, 0);
      void this.loadSource().then(sourceReady => {
        if (
          sourceReady
          || this.session?.token !== candidate.session.token
          || this.viewMode !== "preview"
          || !this.searchBar?.hasClass("is-open")
        ) return;
        if (normalizeTextSearchQuery(this.searchQuery)) {
          this.setSearchCountText("正在定位…");
          this.runSearch("current");
        } else {
          this.updateSearchCount(0, 0);
        }
      });
    } else if (this.searchBar?.hasClass("is-open") && this.searchQuery) {
      this.setSearchCountText("正在定位…");
      this.runSearch("current");
    }
    this.updatePreviewLoadedStatus();
    this.updateToolbarState();
  }

  private async discardPreviewCandidate(candidate: PreparedPreviewCandidate): Promise<void> {
    candidate.unregisterDiagnosticSink();
    candidate.unregisterResourceSink();
    candidate.port?.close();
    candidate.host.remove();
    if (this.candidateHost === candidate.host) this.candidateHost = null;
    await this.plugin.previewServer.revokeSession(candidate.session.token).catch(error => {
      console.error("[ZJ HTML Studio] Failed to discard preview candidate", error);
    });
  }

  private async refreshCandidateReadingState(candidate: PreparedPreviewCandidate): Promise<void> {
    const port = candidate.port;
    const channel = candidate.session.searchChannel;
    if (!port || !channel) return;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await this.captureLatestPageState();
      const latestState = this.lastPageReadingState ?? this.activePageRestoreState;
      if (!isReadingStateRestorable(candidate.session.scopeRelativePath, latestState)) return;
      if (candidate.restoreState) {
        if (!isSameReadingLocation(candidate.restoreState, latestState)) {
          throw new PreviewEntryProbeError(409);
        }
      } else if (
        buildReadingStateUrl(
          candidate.session.entryUrl,
          candidate.session.scopeRelativePath,
          latestState
        ) !== candidate.session.entryUrl
      ) {
        throw new PreviewEntryProbeError(409);
      }
      candidate.restoreState = latestState;
      const revision = this.readingStateRevision;

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: unknown): void => {
          if (settled) return;
          settled = true;
          this.contentEl.win.clearTimeout(timeout);
          port.removeEventListener("message", onMessage);
          if (error) {
            reject(error instanceof Error ? error : new Error("Preview candidate state refresh failed"));
          }
          else resolve();
        };
        const onMessage = (event: MessageEvent<unknown>): void => {
          const data = event.data;
          if (
            !isSearchBridgeMessage(data)
            || data.channel !== channel
            || data.type !== "html-studio-page-state-restored"
          ) return;
          finish();
        };
        const timeout = this.contentEl.win.setTimeout(
          () => finish(new PreviewEntryProbeError(504)),
          500
        );
        port.addEventListener("message", onMessage);
        port.postMessage({
          channel,
          scrollX: latestState.scrollX,
          scrollY: latestState.scrollY,
          type: "html-studio-page-state-restore"
        });
      });
      if (revision === this.readingStateRevision) return;
    }
    throw new PreviewEntryProbeError(409);
  }

  private mergeCandidateDiagnostic(diagnostic: PreviewDiagnostic): void {
    const updated = upsertDisplayDiagnostic(
      this.diagnostics,
      buildRuntimeDiagnostic(diagnostic),
      value => path.isAbsolute(value) ? this.toVaultFriendlyPath(value) : value
    );
    if (updated.length <= MAX_DISPLAY_DIAGNOSTICS) this.diagnostics = updated;
    else this.suppressedDiagnostics += 1;
  }

  private cancelCandidateTransition(): void {
    this.candidateTransitionGeneration += 1;
    this.candidateProbeAbortController?.abort();
    this.candidateProbeAbortController = null;
    this.candidateAbortController?.abort();
    this.candidateAbortController = null;
    this.candidateHost?.remove();
    this.candidateHost = null;
  }

  private async probeCandidateSession(
    token: string,
    parentSignal?: AbortSignal
  ): Promise<PreviewSessionProbeResult> {
    this.candidateProbeAbortController?.abort();
    const controller = new AbortController();
    this.candidateProbeAbortController = controller;
    const abortFromParent = (): void => controller.abort();
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    if (parentSignal?.aborted) controller.abort();
    try {
      return await this.plugin.previewServer.probeSessionEntry(token, controller.signal);
    } finally {
      parentSignal?.removeEventListener("abort", abortFromParent);
      if (this.candidateProbeAbortController === controller) {
        this.candidateProbeAbortController = null;
      }
    }
  }

  private stopActivePreviewFailClosed(mode: PreviewMode, sessionToken: string): Promise<void> {
    this.cancelCandidateTransition();
    this.prepareReadingStateForReplacement();
    this.unregisterDiagnosticSink?.();
    this.unregisterDiagnosticSink = null;
    this.resetSearchBridge();
    this.releaseSourceContent();
    this.activeIframe = null;
    this.previewCanvas = null;
    this.iframeHost?.empty();
    this.session = null;
    this.mode = mode;
    this.modeOverride = mode;
    return this.plugin.previewServer.revokeSession(sessionToken);
  }

  private renderScriptRestrictionNotice(): void {
    const analysis = this.analysis;
    const canvas = this.previewCanvas;
    const session = this.session;
    if (!analysis || !canvas || !session) return;
    const presentation = getScriptRestrictionPresentation(analysis, this.mode);
    if (!presentation) return;

    const notice = canvas.createDiv({ cls: "html-studio-script-notice" });
    const icon = notice.createSpan({ cls: "html-studio-script-notice-icon" });
    setIcon(icon, "code-2");
    const copy = notice.createDiv({ cls: "html-studio-script-notice-copy" });
    copy.createEl("strong", { text: presentation.title });
    copy.createSpan({
      text: `${presentation.detail}切换后，常见后台请求和外部资源受阻，但 WebRTC 不作离线承诺。`
    });
    const switchButton = notice.createEl("button", { cls: "mod-cta", text: "本地交互打开" });
    switchButton.addEventListener("click", () => {
      void this.switchFromScriptNotice(switchButton, session.token, analysis);
    });
  }

  private async switchFromScriptNotice(
    button: HTMLButtonElement,
    sessionToken: string,
    analysis: ScopeAnalysis
  ): Promise<void> {
    button.disabled = true;
    try {
      const applied = await this.replacePreviewSessionMode("interactive", sessionToken, analysis);
      if (!applied) new Notice("页面刚刚发生了刷新，请再点一次“本地交互”。");
    } catch (error) {
      console.error("[ZJ HTML Studio] Failed to enable local interaction", error);
      new Notice(toUserFacingPreviewError(error, "page"));
      if (button.isConnected) button.disabled = false;
    }
  }

  private async toggleViewMode(): Promise<void> {
    if (this.viewMode === "source") {
      this.prepareReadingStateForReplacement();
      this.viewMode = "preview";
      this.releaseSourceContent();
      this.applyViewMode();
      this.updateToolbarState();
      if (this.searchBar?.hasClass("is-open")) this.runSearch("current");
      return;
    }
    const sourceReady = await this.loadSource();
    if (!sourceReady) return;
    this.viewMode = "source";
    this.applyViewMode();
    this.updateToolbarState();
    if (this.searchBar?.hasClass("is-open")) this.runSearch("current");
  }

  private loadSource(): Promise<boolean> {
    if (this.sourceLoadPromise) {
      if (this.sourceReadAbortController?.signal.aborted) {
        return this.sourceLoadPromise.then(() => this.loadSource());
      }
      return this.sourceLoadPromise;
    }
    let tracked: Promise<boolean>;
    tracked = this.performSourceLoad().finally(() => {
      if (this.sourceLoadPromise !== tracked) return;
      this.sourceLoadPromise = null;
      this.updateToolbarState();
    });
    this.sourceLoadPromise = tracked;
    this.updateToolbarState();
    return tracked;
  }

  private async performSourceLoad(): Promise<boolean> {
    const file = this.file;
    if (!file || !this.iframeHost) return false;
    const generation = this.loadGeneration;
    const filePath = file.path;
    let sourceText = this.sourceText;
    if (sourceText === null) {
      let budgetLease: SourceViewBudgetLease | null = null;
      const controller = new AbortController();
      this.sourceReadAbortController = controller;
      const requestGeneration = ++this.sourceLoadGeneration;
      try {
        const result = await readSourceTextWithBudget(
          this.plugin.vaultBasePath,
          file.path,
          sourceViewBudget,
          controller.signal
        );
        sourceText = result.text;
        budgetLease = result.lease;
      } catch (error) {
        if (!isSourceReadCurrent({
          currentFilePath: this.file?.path ?? null,
          currentLoadGeneration: this.loadGeneration,
          currentRequestGeneration: this.sourceLoadGeneration,
          filePath,
          loadGeneration: generation,
          requestGeneration
        })) return false;
        if (isAbortError(error)) return false;
        if (error instanceof SourceViewCapacityError) {
          if (this.viewMode === "source") {
            this.viewMode = "preview";
            this.applyViewMode();
            this.updateToolbarState();
          }
          new Notice("当前打开的源码页面较多。为保持 Obsidian 流畅，请先把一个源码页面切回预览后再试。");
          return false;
        }
        if (error instanceof SourceViewTooLargeError) {
          this.leaveOversizedSourceView();
          return false;
        }
        if (error instanceof UnsupportedHtmlEncodingError) {
          if (this.viewMode === "source") {
            this.viewMode = "preview";
            this.applyViewMode();
            this.updateToolbarState();
          }
          new Notice(`${error.message}。页面预览没有被修改。`);
          return false;
        }
        console.error("[ZJ HTML Studio] Source read failed", error);
        if (this.viewMode === "source") {
          this.viewMode = "preview";
          this.applyViewMode();
          this.updateToolbarState();
        }
        new Notice("源码暂时无法读取，页面预览没有被修改。请刷新后再试。");
        return false;
      } finally {
        if (this.sourceReadAbortController === controller) this.sourceReadAbortController = null;
      }
      if (!isSourceReadCurrent({
        currentFilePath: this.file?.path ?? null,
        currentLoadGeneration: this.loadGeneration,
        currentRequestGeneration: this.sourceLoadGeneration,
        filePath,
        loadGeneration: generation,
        requestGeneration
      })) {
        budgetLease.release();
        return false;
      }
      this.sourceBudgetLease = budgetLease;
      this.sourceText = sourceText;
      this.sourceLineIndex = buildSourceLineIndex(sourceText);
    }
    if (generation !== this.loadGeneration || this.file?.path !== filePath || !this.iframeHost) return false;
    if (!this.sourceHost) {
      this.sourceHost = this.iframeHost.createDiv({ cls: "html-studio-source-host is-hidden" });
      this.sourceTextarea = this.sourceHost.createEl("textarea", {
        cls: "html-studio-source",
        attr: { "aria-label": `${file.name} 只读源码`, readonly: "true", spellcheck: "false" }
      });
    }
    if (this.sourceTextarea) this.sourceTextarea.value = sourceText;
    this.restoreSourceReadingState();
    this.applyViewMode();
    return true;
  }

  private cancelSourceRead(): void {
    this.sourceLoadGeneration += 1;
    this.sourceReadAbortController?.abort();
  }

  private releaseSourceBudget(): void {
    this.sourceBudgetLease?.release();
    this.sourceBudgetLease = null;
  }

  private releaseSourceContent(): void {
    this.cancelSourceRead();
    this.releaseSourceBudget();
    this.sourceText = null;
    this.sourceLineIndex = null;
    this.sourcePositions = [];
    this.sourceSearchIndex = -1;
    if (this.sourceTextarea) this.sourceTextarea.value = "";
    this.sourceHost?.remove();
    this.sourceHost = null;
    this.sourceTextarea = null;
  }

  private leaveOversizedSourceView(): void {
    this.viewMode = "preview";
    this.applyViewMode();
    this.updateToolbarState();
    new Notice(`这个 HTML 超过 ${MAX_SOURCE_VIEW_BYTES / (1024 * 1024)} MiB。为避免 Obsidian 卡顿，已继续显示页面预览。`);
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
    this.applyZoomToIframe(iframe);
  }

  private applyZoomToIframe(iframe: HTMLIFrameElement): void {
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
    if (this.viewMode === "preview") {
      if (!this.session?.searchChannel) {
        new Notice(`这个 HTML 超过 ${MAX_SOURCE_VIEW_BYTES / (1024 * 1024)} MiB。为避免占用过多内存，页面查找没有启用。`);
        return;
      }
      if (!this.searchBridgeReady) {
        new Notice("当前页面尚未通过本地查找握手，可能正在跳转或仍在加载。插件没有发送你的查找词。");
        return;
      }
    }
    this.searchBar?.addClass("is-open");
    this.searchBar?.removeAttribute("aria-hidden");
    this.searchBar?.removeAttribute("inert");
    this.searchInput?.focus();
    this.searchInput?.select();
    this.runSearch("current");
  }

  private closeSearch(): void {
    this.searchBar?.removeClass("is-open");
    this.searchBar?.setAttribute("aria-hidden", "true");
    this.searchBar?.setAttribute("inert", "");
    if (this.searchQuery) {
      this.searchQuery = "";
      if (this.searchInput) this.searchInput.value = "";
      this.runSearch("current");
    }
    this.searchButton?.focus();
  }

  private runSearch(direction: "current" | "next" | "previous"): void {
    if (this.searchDebounceTimer !== null) {
      this.contentEl.win.clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
    }
    if (this.viewMode === "source") {
      this.runSourceSearch(direction);
      return;
    }
    const session = this.session;
    const channel = session?.searchChannel;
    const port = this.searchBridgePort;
    if (!session || !channel || !port || !this.searchBridgeReady) {
      if (this.searchCount) this.searchCount.setText("准备中");
      return;
    }
    port.postMessage({
      channel,
      direction,
      query: normalizeTextSearchQuery(this.searchQuery),
      requestId: ++this.searchRequestId,
      type: "html-studio-search"
    });
  }

  private scheduleSearch(): void {
    this.clearSearchDebounce();
    this.searchDebounceTimer = this.contentEl.win.setTimeout(() => {
      this.searchDebounceTimer = null;
      this.runSearch("current");
    }, 180);
  }

  private clearSearchDebounce(): void {
    if (this.searchDebounceTimer === null) return;
    this.contentEl.win.clearTimeout(this.searchDebounceTimer);
    this.searchDebounceTimer = null;
  }

  private runSourceSearch(direction: "current" | "next" | "previous"): void {
    if (this.sourceText === null || !this.sourceTextarea) {
      if (this.searchCount) this.searchCount.setText("准备中");
      return;
    }
    const query = normalizeTextSearchQuery(this.searchQuery);
    const positions = findTextOccurrences(this.sourceText, query);
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
    if (position !== undefined && query) {
      this.sourceTextarea.setSelectionRange(position, position + query.length);
      this.scrollSourcePositionIntoView(position);
    } else if (!query) {
      const caret = Math.min(this.sourceTextarea.selectionStart, this.sourceTextarea.value.length);
      this.sourceTextarea.setSelectionRange(caret, caret);
    }
    this.updateSearchCount(this.sourceSearchIndex + 1, this.sourcePositions.length);
  }

  private handleSearchBridgeMessage(event: MessageEvent<unknown>): void {
    const iframe = this.getPreviewIframe();
    const session = this.session;
    const channel = session?.searchChannel;
    if (
      !iframe?.contentWindow
      || !session
      || event.source !== iframe.contentWindow
      || event.origin !== session.origin
      || !channel
    ) return;
    if (
      !isSearchBridgeMessage(event.data)
      || event.data.type !== "html-studio-search-ready"
      || event.data.channel !== channel
    ) return;
    const port = event.ports[0];
    if (!port) return;
    this.resetSearchBridge();
    this.searchBridgePort = port;
    this.searchBridgeReady = true;
    const sessionToken = session.token;
    port.addEventListener("message", portEvent => {
      this.handleSearchBridgePortMessage(portEvent.data, sessionToken, port);
    });
    port.start();
    this.updatePreviewLoadedStatus();
    this.updateSearchState();
    if (this.activePageRestoreState) {
      port.postMessage({
        channel,
        scrollX: this.activePageRestoreState.scrollX,
        scrollY: this.activePageRestoreState.scrollY,
        type: "html-studio-page-state-restore"
      });
    }
    if (this.searchBar?.hasClass("is-open") && this.searchQuery) this.runSearch("current");
  }

  private handleSearchBridgePortMessage(
    value: unknown,
    sessionToken: string,
    port: MessagePort
  ): void {
    const channel = this.session?.searchChannel;
    if (
      this.session?.token !== sessionToken
      || this.searchBridgePort !== port
      || !channel
      || !isSearchBridgeMessage(value)
      || value.channel !== channel
    ) return;
    const data = value;
    if (data.type === "html-studio-search-leaving") {
      this.resetSearchBridge();
      if (this.searchCount) this.searchCount.setText("当前页面不可用");
      this.setStatus("页面正在离开本地文档；查找词不会发送到新页面。", "loading");
      this.updateSearchState();
      return;
    }
    if (
      data.type === "html-studio-page-state"
      || data.type === "html-studio-page-state-restored"
    ) {
      if (data.type === "html-studio-page-state" && this.activePageRestoreState) return;
      const state = parseBridgePageState(this.analysis?.scopeRelativePath ?? "", data);
      if (!state) return;
      this.lastPageReadingState = state;
      this.readingStateRevision += 1;
      this.readingStateWaiters.forEach(resolve => resolve());
      this.readingStateWaiters.clear();
      if (data.type === "html-studio-page-state-restored") {
        this.activePageRestoreState = null;
      }
      return;
    }
    if (data.type === "html-studio-search-open") {
      this.openSearch();
      return;
    }
    if (
      data.type === "html-studio-search-result"
      && data.requestId === this.searchRequestId
      && data.query === normalizeTextSearchQuery(this.searchQuery)
    ) {
      if (data.searchLimited) {
        const current = normalizeSearchResultNumber(data.current);
        const total = normalizeSearchResultNumber(data.total);
        this.setSearchCountText(
          data.found
            ? `已定位${total > 0 ? ` ${current} / ${total}` : ""} · 部分受限`
            : "未找到 · 部分受限",
          "页面包含复杂结构或插件无法安全遍历的动态区域；为保持 Obsidian 流畅，没有执行无上限的同步查找"
        );
        return;
      }
      if (data.searchInvalidated) {
        this.setSearchCountText("页面已变化", "请按上一处或下一处重新定位");
        return;
      }
      if (data.countReliable === false) {
        this.setSearchCountText(
          data.found ? "已定位" : "未找到",
          "页面查找由 Chromium 执行；为避免不准确，不显示估算总数"
        );
        return;
      }
      const total = normalizeSearchResultNumber(data.total);
      if (data.truncatedReason) {
        this.setSearchCountText(
          data.found ? `已定位 · 统计到 ${total} 处` : `已统计 ${total} 处`,
          "为保持 Obsidian 流畅，只统计了部分结果"
        );
        return;
      }
      if (data.countComplete !== true) {
        this.setSearchCountText(data.found ? "已定位 · 正在统计…" : "正在统计…");
        return;
      }
      this.updateSearchCount(
        normalizeSearchResultNumber(data.current),
        total
      );
    }
  }

  private resetSearchBridge(): void {
    this.searchRequestId += 1;
    this.readingStateWaiters.forEach(resolve => resolve());
    this.readingStateWaiters.clear();
    this.searchBridgeReady = false;
    this.searchBridgePort?.close();
    this.searchBridgePort = null;
    if (this.searchDebounceTimer !== null) {
      this.contentEl.win.clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
    }
    if (this.searchHandshakeTimer !== null) {
      this.contentEl.win.clearTimeout(this.searchHandshakeTimer);
      this.searchHandshakeTimer = null;
    }
  }

  private updateSearchCount(current: number, total: number): void {
    this.setSearchCountText(`${current} / ${total}`);
  }

  private async captureLatestPageState(): Promise<void> {
    const port = this.searchBridgePort;
    const channel = this.session?.searchChannel;
    if (!port || !channel || !this.searchBridgeReady) return;
    await new Promise<void>(resolve => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        this.readingStateWaiters.delete(finish);
        this.contentEl.win.clearTimeout(timeout);
        resolve();
      };
      const timeout = this.contentEl.win.setTimeout(finish, 80);
      this.readingStateWaiters.add(finish);
      port.postMessage({ channel, type: "html-studio-page-state-request" });
    });
  }

  private setSearchCountText(text: string, title = ""): void {
    if (!this.searchCount) return;
    this.searchCount.setText(text);
    this.searchCount.title = title;
    this.searchCount.setAttribute("aria-label", title ? `${text}。${title}` : text);
  }

  private updateSearchState(): void {
    if (!this.searchButton) return;
    const sourceActive = this.viewMode === "source";
    const bridgeUnavailable = !this.session?.searchChannel;
    this.searchButton.disabled = !sourceActive && !bridgeUnavailable && !this.searchBridgeReady;
    const label = sourceActive
      ? "查找当前 HTML 源码"
      : bridgeUnavailable
        ? "页面较大，点此查看查找限制"
        : this.searchButton.disabled
          ? "当前页面尚未通过本地查找握手"
          : "查找当前 HTML 内容";
    this.searchButton.title = label;
    this.searchButton.setAttribute("aria-label", label);
  }

  private prepareReadingStateForReplacement(): void {
    this.activePageRestoreState = this.lastPageReadingState ?? this.activePageRestoreState;
    this.lastPageReadingState = null;
    if (!this.sourceTextarea || this.pendingSourceReadingState) return;
    this.pendingSourceReadingState = {
      focused: this.contentEl.doc.activeElement === this.sourceTextarea,
      scrollLeft: this.sourceTextarea.scrollLeft,
      scrollTop: this.sourceTextarea.scrollTop,
      searchIndex: this.sourceSearchIndex,
      selectionEnd: this.sourceTextarea.selectionEnd,
      selectionStart: this.sourceTextarea.selectionStart
    };
  }

  private restoreSourceReadingState(): void {
    const textarea = this.sourceTextarea;
    if (!textarea) return;
    const state = this.pendingSourceReadingState;
    this.pendingSourceReadingState = null;
    const query = normalizeTextSearchQuery(this.searchQuery);
    if (this.searchBar?.hasClass("is-open") && !query) {
      this.sourcePositions = [];
      this.sourceSearchIndex = -1;
      this.updateSearchCount(0, 0);
      const caret = Math.min(state?.selectionStart ?? 0, textarea.value.length);
      textarea.setSelectionRange(caret, caret);
      if (state) {
        textarea.scrollLeft = state.scrollLeft;
        textarea.scrollTop = state.scrollTop;
        if (state.focused) textarea.focus();
      }
      return;
    }
    if (this.searchBar?.hasClass("is-open") && query && this.sourceText !== null) {
      this.sourcePositions = findTextOccurrences(this.sourceText, query);
      this.sourceSearchIndex = this.sourcePositions.length === 0
        ? -1
        : Math.max(0, Math.min(this.sourcePositions.length - 1, state?.searchIndex ?? 0));
      const position = this.sourcePositions[this.sourceSearchIndex];
      if (position !== undefined) {
        textarea.setSelectionRange(position, position + query.length);
        this.scrollSourcePositionIntoView(position);
      }
      this.updateSearchCount(this.sourceSearchIndex + 1, this.sourcePositions.length);
      if (state?.focused) textarea.focus();
      return;
    }
    if (!state) return;
    const maxSelection = textarea.value.length;
    textarea.setSelectionRange(
      Math.min(state.selectionStart, maxSelection),
      Math.min(state.selectionEnd, maxSelection)
    );
    textarea.scrollLeft = state.scrollLeft;
    textarea.scrollTop = state.scrollTop;
    if (state.focused) textarea.focus();
  }

  private scrollSourcePositionIntoView(position: number): void {
    if (!this.sourceTextarea || this.sourceText === null) return;
    const maxScrollTop = Math.max(0, this.sourceTextarea.scrollHeight - this.sourceTextarea.clientHeight);
    if (!this.sourceLineIndex) return;
    this.sourceTextarea.scrollTop = maxScrollTop * getSourceLineScrollRatioFromIndex(
      this.sourceText,
      this.sourceLineIndex,
      position
    );
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

  private handleFullscreenChange(): void {
    this.updateFullscreenButton();
    if (this.deferredManualReload && !isFullscreenTarget(this.getPreviewIframe(), this.contentEl.doc)) {
      this.deferredManualReload = false;
      if (this.file) void this.reloadWithCandidateSession(this.file, "manual");
      return;
    }
    if (!this.deferredFullscreenReload) return;
    if (isFullscreenTarget(this.getPreviewIframe(), this.contentEl.doc)) return;
    this.deferredFullscreenReload = false;
    void this.reloadAfterDependencyChange();
  }

  private getPreviewIframe(): HTMLIFrameElement | null {
    return this.activeIframe?.isConnected ? this.activeIframe : null;
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
    const primaryError = this.diagnostics.find(diagnostic => diagnostic.level === "error");
    setIcon(healthIcon, primaryError ? "octagon-alert" : "circle-check");
    const healthCopy = health.createDiv();
    healthCopy.createEl("strong", {
      text: primaryError
        ? `预览遇到需要处理的问题：${primaryError.title}`
        : this.session ? "本地隔离服务运行正常" : "正在准备本地服务"
    });
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
    if (diagnostic.scopeExpansionCandidatePath) {
      const expand = actions.createEl("button", { text: "检查可恢复范围" });
      expand.addEventListener("click", () => void this.expandScopeForDiagnostic(diagnostic, expand));
    }
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
    this.updatePreviewLoadedStatus();
    this.scheduleDiagnosticsRender();
  }

  private async expandScopeForDiagnostic(
    diagnostic: DisplayDiagnostic,
    button: HTMLButtonElement
  ): Promise<void> {
    const resolvedPath = diagnostic.scopeExpansionCandidatePath;
    const previousSession = this.session;
    const previousAnalysis = this.analysis;
    const file = this.file;
    if (!resolvedPath || !previousSession || !previousAnalysis || !file || button.disabled) return;

    const previousToken = previousSession.token;
    const generation = this.loadGeneration;
    let candidate: PreviewSession | null = null;
    let prepared: PreparedPreviewCandidate | null = null;
    button.disabled = true;
    try {
      const suggestion = await this.plugin.previewServer.suggestScopeExpansion(previousToken, resolvedPath);
      if (
        generation !== this.loadGeneration
        || this.session?.token !== previousToken
        || this.analysis !== previousAnalysis
        || this.file?.path !== file.path
      ) return;
      if (!suggestion) {
        new Notice("目标文件已不存在、已变化或不在知识仓库内，因此没有提供扩大范围授权。");
        return;
      }

      this.activeScopeExpansionModal?.cancel();
      const modal = new ScopeExpansionModal(this.app, {
        currentScopePath: previousAnalysis.scopeRelativePath,
        mode: this.mode,
        suggestedScopePath: suggestion.scopeRelativePath,
        targetRelativePath: suggestion.targetRelativePath
      });
      this.activeScopeExpansionModal = modal;
      const approved = await modal.waitForDecision();
      if (this.activeScopeExpansionModal === modal) this.activeScopeExpansionModal = null;
      if (!approved) return;
      if (
        generation !== this.loadGeneration
        || this.session?.token !== previousToken
        || this.analysis !== previousAnalysis
        || this.file?.path !== file.path
      ) {
        new Notice("页面状态已经变化，本次扩大范围没有应用。请从最新诊断重新确认。");
        return;
      }

      candidate = await this.plugin.previewServer.createSession({
        enableSearchBridge: true,
        entryRelativePath: file.path,
        mode: this.mode,
        scopeRelativePath: suggestion.scopeRelativePath
      });
      const nextAnalysis: ScopeAnalysis = {
        ...previousAnalysis,
        dependencyRelativePaths: [...new Set([
          ...previousAnalysis.dependencyRelativePaths,
          suggestion.targetRelativePath
        ])],
        requiresConfirmation: false,
        scopeRelativePath: suggestion.scopeRelativePath
      };
      const probe = await this.probeCandidateSession(candidate.token);
      if (probe.cancelled) {
        await this.plugin.previewServer.revokeSession(candidate.token);
        candidate = null;
        return;
      }
      if (!probe.ok) throw new PreviewEntryProbeError(probe.statusCode);
      prepared = await this.preparePreviewCandidate(candidate, nextAnalysis, this.mode);
      if (
        generation !== this.loadGeneration
        || this.session?.token !== previousToken
        || this.analysis !== previousAnalysis
        || this.file?.path !== file.path
      ) {
        await this.discardPreviewCandidate(prepared);
        prepared = null;
        candidate = null;
        return;
      }
      await this.refreshCandidateReadingState(prepared);
      if (
        generation !== this.loadGeneration
        || this.session?.token !== previousToken
        || this.analysis !== previousAnalysis
        || this.file?.path !== file.path
      ) {
        await this.discardPreviewCandidate(prepared);
        prepared = null;
        candidate = null;
        return;
      }

      this.unregisterDiagnosticSink?.();
      this.unregisterDiagnosticSink = null;
      this.analysis = nextAnalysis;
      this.confirmedScopePath = suggestion.scopeRelativePath;
      const initialDiagnostics = buildAnalysisDiagnostics(nextAnalysis, MAX_DISPLAY_DIAGNOSTICS, this.mode);
      this.diagnostics = initialDiagnostics;
      this.suppressedDiagnostics = Math.max(
        0,
        countAnalysisDiagnostics(nextAnalysis, this.mode) - initialDiagnostics.length
      );
      this.session = candidate;
      candidate = null;
      this.updateReloadRegistration(this.session.id, [
        ...nextAnalysis.dependencyRelativePaths,
        ...prepared.dependencies
      ]);
      this.promotePreviewCandidate(prepared);
      prepared = null;
      await this.plugin.previewServer.revokeSession(previousToken).catch(error => {
        console.error("[ZJ HTML Studio] Failed to retire previous scoped session", error);
      });
      new Notice("资源范围已仅为当前标签临时扩大；文件夹权限没有改变。");
    } catch (error) {
      if (prepared) {
        await this.discardPreviewCandidate(prepared);
        prepared = null;
        candidate = null;
      }
      if (candidate) {
        await this.plugin.previewServer.revokeSession(candidate.token).catch(revokeError => {
          console.error("[ZJ HTML Studio] Failed to revoke scope expansion candidate", revokeError);
        });
      }
      if (generation !== this.loadGeneration || isAbortError(error)) return;
      console.error("[ZJ HTML Studio] Scope expansion failed", error);
      new Notice(`${toUserFacingPreviewError(error, "page")} 当前页面仍保持原来的资源范围。`);
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  }

  private updatePreviewLoadedStatus(): void {
    const primaryError = this.diagnostics.find(diagnostic => diagnostic.level === "error");
    if (primaryError) {
      this.setStatus(`页面入口已验证，但仍有问题：${primaryError.title}`, "error");
      return;
    }

    const issueCount = this.diagnostics.length + this.suppressedDiagnostics;
    const scriptAnalysis = this.analysis?.pageScriptAnalysis;
    const scriptsBlocked = this.mode === "safe"
      && ((this.analysis?.pageScriptCount ?? 0) > 0 || scriptAnalysis?.complete === false);
    this.setStatus(
      scriptsBlocked
        ? scriptAnalysis?.complete === false
          ? "页面入口已验证，但脚本分析未完成；安全只读仍会阻止用户脚本"
          : `安全只读已关闭 ${this.analysis!.pageScriptCount} 个页面脚本；画面为空时请使用“本地交互”`
        : issueCount === 0
          ? "页面入口已验证，暂未发现资源问题"
          : `页面入口已验证，诊断记录了 ${issueCount} 个提醒`,
      "success"
    );
  }

  private toggleDiagnostics(): void {
    if (!this.diagnosticsDrawer) return;
    this.diagnosticsDrawer.toggleClass("is-open", !this.diagnosticsDrawer.hasClass("is-open"));
  }

  private openModeModal(): void {
    const analysis = this.analysis;
    const session = this.session;
    const permissionScopePath = this.permissionScopePath;
    if (!analysis || !session || permissionScopePath === null) return;
    const sessionToken = session.token;
    this.activeModeModal?.cancel();
    const modal = new TrustModeModal(this.app, {
      currentMode: this.mode,
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
                console.error("[ZJ HTML Studio] Failed to persist preview mode", error);
                new Notice("本次打开方式已经切换，但没有成功记住这个文件夹。");
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
    const file = this.file;
    const generation = this.loadGeneration;
    const policyGeneration = this.previewPolicyGeneration;
    if (!file || this.session?.token !== previousToken) return false;
    const previousMode = this.mode;
    const downgrade = isPreviewModeDowngrade(previousMode, mode);
    const transitionIsCurrent = (): boolean => (
      generation === this.loadGeneration
      && policyGeneration === this.previewPolicyGeneration
      && this.analysis === analysis
      && this.file?.path === file.path
    );

    if (downgrade) {
      const revokePrevious = this.stopActivePreviewFailClosed(mode, previousToken);
      await revokePrevious;
      if (!transitionIsCurrent()) return false;
    }

    let nextSession: PreviewSession | null = null;
    let prepared: PreparedPreviewCandidate | null = null;
    try {
      nextSession = await this.plugin.previewServer.createSession({
        enableSearchBridge: true,
        entryRelativePath: file.path,
        mode,
        scopeRelativePath: analysis.scopeRelativePath
      });
      const probe = await this.probeCandidateSession(nextSession.token);
      if (probe.cancelled) {
        await this.plugin.previewServer.revokeSession(nextSession.token);
        nextSession = null;
        return false;
      }
      if (!probe.ok) {
        await this.plugin.previewServer.revokeSession(nextSession.token);
        nextSession = null;
        throw new PreviewEntryProbeError(probe.statusCode);
      }
      if (!transitionIsCurrent()) {
        await this.plugin.previewServer.revokeSession(nextSession.token);
        return false;
      }
      prepared = await this.preparePreviewCandidate(nextSession, analysis, mode);
      if (!downgrade && transitionIsCurrent() && this.session?.token === previousToken) {
        await this.refreshCandidateReadingState(prepared);
      }
    } catch (error) {
      if (prepared) {
        await this.discardPreviewCandidate(prepared);
        prepared = null;
        nextSession = null;
      } else if (nextSession) {
        await this.plugin.previewServer.revokeSession(nextSession.token).catch(revokeError => {
          console.error("[ZJ HTML Studio] Failed to revoke rejected permission candidate", revokeError);
        });
        nextSession = null;
      }
      if (downgrade && transitionIsCurrent()) {
        this.clearReloadRegistration();
        const message = toUserFacingPreviewError(error, "page");
        this.setStatus(`旧的高权限页面已经停止。${message}`, "error");
        this.renderFatalError(
          `旧的高权限页面已经停止。${message}`,
          createPreviewRecoveryOptions(mode, this.confirmedScopePath)
        );
        this.updateToolbarState();
        this.activeModeModal?.cancel();
        this.activeModeModal = null;
      }
      throw error;
    }
    if (
      !transitionIsCurrent()
      || (!downgrade && this.session?.token !== previousToken)
    ) {
      if (prepared) await this.discardPreviewCandidate(prepared);
      else await this.plugin.previewServer.revokeSession(nextSession.token);
      return false;
    }

    this.unregisterDiagnosticSink?.();
    this.unregisterDiagnosticSink = null;
    this.session = nextSession;
    this.mode = mode;
    this.modeOverride = nextModeOverride;
    const initialDiagnostics = buildAnalysisDiagnostics(analysis, MAX_DISPLAY_DIAGNOSTICS, mode);
    this.diagnostics = initialDiagnostics;
    this.suppressedDiagnostics = Math.max(0, countAnalysisDiagnostics(analysis, mode) - initialDiagnostics.length);
    this.updateReloadRegistration(nextSession.id, [
      ...analysis.dependencyRelativePaths,
      ...prepared.dependencies
    ]);
    this.promotePreviewCandidate(prepared);
    if (!downgrade) {
      await this.plugin.previewServer.revokeSession(previousToken).catch(error => {
        console.error("[ZJ HTML Studio] Failed to retire previous permission session", error);
      });
    }
    return true;
  }

  private async handleScopeModeChange(change: ScopeModeChange): Promise<void> {
    const policyGeneration = ++this.previewPolicyGeneration;
    this.cancelCandidateTransition();
    const browserCleanup = change.forceSafeReset
      ? this.revokeAllBrowserSessions()
      : null;
    const session = this.session;
    if (!session) {
      const file = this.file;
      if (!file) {
        await browserCleanup;
        return;
      }
      const loadGeneration = this.loadGeneration;
      const permissionScopePath = getHtmlPermissionScopePath(file.path);
      const nextMode = this.plugin.getScopeMode(permissionScopePath);
      const reloadMode = resolveSessionlessPolicyReloadMode({
        forceSafeReset: change.forceSafeReset,
        modeOverride: this.modeOverride,
        persistentMode: nextMode
      });
      await browserCleanup;
      if (isPolicyBoundLoadCurrent({
        currentFilePath: this.file?.path ?? null,
        currentLoadGeneration: this.loadGeneration,
        currentPolicyGeneration: this.previewPolicyGeneration,
        filePath: file.path,
        loadGeneration,
        policyGeneration
      })) {
        await this.loadPreview(file, {
          confirmedScopePath: this.confirmedScopePath,
          modeOverride: reloadMode,
          preserveBrowserSessions: true,
          preserveReadingState: true
        });
      }
      return;
    }
    const analysis = this.analysis;
    const permissionScopePath = this.permissionScopePath;
    if (!analysis || permissionScopePath === null) {
      await browserCleanup;
      return;
    }
    const nextMode = this.plugin.getScopeMode(permissionScopePath);
    const action = decideScopeModeChange({
      currentMode: this.mode,
      forceSafeReset: change.forceSafeReset,
      modeOverride: this.modeOverride,
      persistentMode: nextMode
    });
    if (action === "ignore") {
      await browserCleanup;
      return;
    }
    if (action === "clear-override") {
      this.modeOverride = null;
      await browserCleanup;
      return;
    }
    if (action === "pin-current") {
      this.modeOverride = this.mode;
      await browserCleanup;
      return;
    }

    this.activeModeModal?.cancel();
    this.activeModeModal = null;
    const switching = this.replacePreviewSessionMode(nextMode, session.token, analysis, null);
    if (change.forceSafeReset) {
      await switching;
      await browserCleanup;
      return;
    }
    await switching;
  }

  private async revokeAllBrowserSessions(): Promise<void> {
    this.browserSessionGeneration += 1;
    this.browserSessionProbeAbortController?.abort();
    this.browserSessionProbeAbortController = null;
    const sessions = [...this.browserSessions.entries()];
    this.browserSessions.clear();
    sessions.forEach(([, timer]) => this.contentEl.win.clearTimeout(timer));
    const results = await Promise.allSettled(
      sessions.map(([token]) => this.plugin.previewServer.revokeSession(token))
    );
    results.forEach(result => {
      if (result.status === "rejected") {
        console.error("[ZJ HTML Studio] Browser permission reset cleanup failed", result.reason);
      }
    });
  }

  private async promptBrowserOpen(): Promise<void> {
    const analysis = this.analysis;
    if (!analysis || !this.file || !this.session) return;
    if (!this.ensureBrowserSessionCapacity()) return;
    this.activeBrowserModal?.cancel();
    const modal = new BrowserOpenModal(this.app, analysis.scopeRelativePath);
    this.activeBrowserModal = modal;
    const mode = await modal.waitForMode();
    if (this.activeBrowserModal === modal) this.activeBrowserModal = null;
    if (!mode || !this.file || this.analysis !== analysis || !this.session) return;
    await this.openBrowserSession(mode, analysis, this.file);
  }

  private async openBrowserSession(mode: PreviewMode, analysis: ScopeAnalysis, file: TFile): Promise<void> {
    if (this.browserSessionOpenInProgress) {
      new Notice("浏览器会话正在创建，请稍候。");
      return;
    }
    if (!this.ensureBrowserSessionCapacity()) return;
    this.browserSessionOpenInProgress = true;
    const browserSessionGeneration = this.browserSessionGeneration;
    const parentSessionToken = this.session?.token ?? null;
    let session: PreviewSession | null = null;
    try {
      session = await this.plugin.previewServer.createSession({
        entryRelativePath: file.path,
        mode,
        scopeRelativePath: analysis.scopeRelativePath
      });
      if (
        browserSessionGeneration !== this.browserSessionGeneration
        || this.session?.token !== parentSessionToken
        || this.analysis !== analysis
        || this.file?.path !== file.path
      ) {
        await this.plugin.previewServer.revokeSession(session.token);
        return;
      }
      const probeController = new AbortController();
      this.browserSessionProbeAbortController = probeController;
      const probe = await this.plugin.previewServer.probeSessionEntry(
        session.token,
        probeController.signal
      );
      if (this.browserSessionProbeAbortController === probeController) {
        this.browserSessionProbeAbortController = null;
      }
      if (probe.cancelled) {
        await this.plugin.previewServer.revokeSession(session.token);
        session = null;
        return;
      }
      if (!probe.ok) throw new PreviewEntryProbeError(probe.statusCode);
      if (
        browserSessionGeneration !== this.browserSessionGeneration
        || this.session?.token !== parentSessionToken
        || this.analysis !== analysis
        || this.file?.path !== file.path
      ) {
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
      new Notice(toUserFacingPreviewError(error, "browser"));
    } finally {
      this.browserSessionProbeAbortController = null;
      this.browserSessionOpenInProgress = false;
    }
  }

  private ensureBrowserSessionCapacity(): boolean {
    if (canOpenBrowserSession(this.browserSessions.size)) return true;
    new Notice(
      `当前 HTML 已有 ${MAX_BROWSER_SESSIONS_PER_VIEW} 个仍有效的系统浏览器会话。为避免旧页面突然失效，本次没有再打开。请等待最早会话在 30 分钟内自动到期，或关闭并重新打开当前 HTML 标签页后再试。`
    );
    return false;
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
      const presentation = getPreviewModePresentation(this.mode);
      this.modeButton.empty();
      const dot = this.modeButton.createSpan({ cls: "html-studio-mode-dot" });
      setIcon(dot, presentation.icon);
      this.modeButton.createSpan({ text: presentation.label });
      this.modeButton.toggleClass("is-interactive", this.mode === "interactive");
      this.modeButton.toggleClass("is-trusted", this.mode === "trusted");
      this.modeButton.title = presentation.title;
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
      const actionLabel = sourceActive ? "返回页面预览" : "查看只读源码";
      this.viewToggleButton.empty();
      const icon = this.viewToggleButton.createSpan();
      setIcon(icon, sourceActive ? "panel-top" : "code-2");
      this.viewToggleButton.createSpan({ text: sourceActive ? "预览" : "源码" });
      this.viewToggleButton.toggleClass("is-active", sourceActive);
      this.viewToggleButton.setAttribute("aria-pressed", sourceActive.toString());
      this.viewToggleButton.setAttribute("aria-label", actionLabel);
      this.viewToggleButton.title = actionLabel;
      this.viewToggleButton.disabled = !sourceActive && this.sourceLoadPromise !== null;
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
    this.statusEl.setAttribute("aria-live", state === "error" ? "assertive" : "polite");
    this.statusEl.setAttribute("role", state === "error" ? "alert" : "status");
  }

  private renderFatalError(message: string, recoveryOptions: PreviewRecoveryOptions): void {
    if (!this.iframeHost) return;
    this.iframeHost.empty();
    const error = this.iframeHost.createDiv({ cls: "html-studio-fatal-error" });
    const icon = error.createDiv();
    setIcon(icon, "file-warning");
    error.createEl("h3", { text: "这个 HTML 还没有打开" });
    error.createEl("p", { text: message });
    const retry = error.createEl("button", { text: "重新尝试", cls: "mod-cta" });
    retry.addEventListener("click", () => {
      if (this.file) void this.loadPreview(this.file, recoveryOptions);
    });
  }

  private async cleanupSession(options: {
    preserveBrowserSessions?: boolean;
    preserveReloadRegistration?: boolean;
  } = {}): Promise<void> {
    this.cancelCandidateTransition();
    this.resetSearchBridge();
    this.releaseSourceContent();
    const iframe = this.getPreviewIframe();
    this.activeIframe = null;
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
      this.browserSessionGeneration += 1;
      this.browserSessionProbeAbortController?.abort();
      this.browserSessionProbeAbortController = null;
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

  private async reloadWithCandidateSession(
    file: TFile,
    trigger: "auto" | "manual" = "auto"
  ): Promise<void> {
    const previousSession = this.session;
    const previousAnalysis = this.analysis;
    if (!previousSession || !previousAnalysis) {
      await this.loadPreview(file, {
        confirmedScopePath: this.confirmedScopePath,
        modeOverride: this.modeOverride,
        preserveBrowserSessions: true
      });
      return;
    }

    const previousToken = previousSession.token;
    const previousDependencies = this.plugin.getPreviewDependencies(this.reloadRegistrationId);
    const analysisStartCheckpoint = this.plugin.getVaultChangeCheckpoint();
    const generation = this.beginLoad();
    const signal = this.loadAbortController!.signal;
    const policyGeneration = this.previewPolicyGeneration;
    let modeIntent = this.modeOverride;
    let nextConfirmedScopePath = this.confirmedScopePath;
    let candidate: PreviewSession | null = null;
    let prepared: PreparedPreviewCandidate | null = null;
    this.setStatus(
      trigger === "manual" ? "正在后台验证刷新结果；当前页面继续保持…" : "检测到文件更新，正在后台验证新版本…",
      "loading"
    );

    try {
      let analysis = await analyzePreviewScope(this.plugin.vaultBasePath, file.path, { signal });
      if (!isAutoReloadCandidateCurrent({
        aborted: signal.aborted,
        currentGeneration: this.loadGeneration,
        currentToken: this.session?.token ?? null,
        generation,
        previousToken
      })) return;

      if (shouldConfirmScope(
        analysis.requiresConfirmation,
        nextConfirmedScopePath,
        analysis.scopeRelativePath
      )) {
        const modal = new ScopeConfirmationModal(this.app, analysis);
        this.activeScopeModal = modal;
        const decision = await modal.waitForDecision();
        if (this.activeScopeModal === modal) this.activeScopeModal = null;
        if (!isAutoReloadCandidateCurrent({
          aborted: signal.aborted,
          currentGeneration: this.loadGeneration,
          currentToken: this.session?.token ?? null,
          generation,
          previousToken
        })) return;
        if (decision === "cancel") {
          this.setStatus("新版本需要更大的资源范围；未获得确认，继续显示上一次可用版本。", "error");
          return;
        }
        if (decision === "entry-folder-safe") {
          analysis = applyEntryFolderSafeTrial(analysis);
          modeIntent = "safe";
          nextConfirmedScopePath = null;
        } else {
          nextConfirmedScopePath = analysis.scopeRelativePath;
        }
      }

      const permissionScopePath = getHtmlPermissionScopePath(file.path);
      let nextMode = resolvePreviewMode(
        this.plugin.getScopeMode(permissionScopePath),
        modeIntent ?? undefined
      );
      let nextModeOverride = modeIntent;
      if (nextMode !== this.mode) {
        if (isPreviewModeDowngrade(this.mode, nextMode)) {
          await this.stopActivePreviewFailClosed(nextMode, previousToken);
          if (generation !== this.loadGeneration || signal.aborted || this.file?.path !== file.path) return;
          await this.loadPreview(file, {
            confirmedScopePath: nextConfirmedScopePath,
            modeOverride: nextMode,
            preserveBrowserSessions: true,
            preserveReadingState: true
          });
          return;
        }
        nextMode = this.mode;
        nextModeOverride = this.mode;
      }
      if (policyGeneration !== this.previewPolicyGeneration) return;

      candidate = await this.plugin.previewServer.createSession({
        enableSearchBridge: true,
        entryRelativePath: file.path,
        mode: nextMode,
        scopeRelativePath: analysis.scopeRelativePath
      });
      const probe = await this.probeCandidateSession(candidate.token, signal);
      if (probe.cancelled) {
        await this.plugin.previewServer.revokeSession(candidate.token);
        candidate = null;
        return;
      }
      if (!probe.ok) {
        await this.plugin.previewServer.revokeSession(candidate.token);
        candidate = null;
        throw new PreviewEntryProbeError(probe.statusCode);
      }
      if (policyGeneration !== this.previewPolicyGeneration) {
        await this.plugin.previewServer.revokeSession(candidate.token);
        candidate = null;
        return;
      }
      prepared = await this.preparePreviewCandidate(candidate, analysis, nextMode, signal);
      if (!isAutoReloadCandidateCurrent({
        aborted: signal.aborted,
        currentGeneration: this.loadGeneration,
        currentToken: this.session?.token ?? null,
        generation,
        previousToken
      }) || policyGeneration !== this.previewPolicyGeneration) {
        await this.discardPreviewCandidate(prepared);
        prepared = null;
        candidate = null;
        return;
      }
      await this.refreshCandidateReadingState(prepared);
      if (!isAutoReloadCandidateCurrent({
        aborted: signal.aborted,
        currentGeneration: this.loadGeneration,
        currentToken: this.session?.token ?? null,
        generation,
        previousToken
      }) || policyGeneration !== this.previewPolicyGeneration) {
        await this.discardPreviewCandidate(prepared);
        prepared = null;
        candidate = null;
        return;
      }

      this.unregisterDiagnosticSink?.();
      this.unregisterDiagnosticSink = null;
      this.analysis = analysis;
      this.permissionScopePath = permissionScopePath;
      this.confirmedScopePath = nextConfirmedScopePath;
      this.mode = nextMode;
      this.modeOverride = nextModeOverride;
      const initialDiagnostics = buildAnalysisDiagnostics(analysis, MAX_DISPLAY_DIAGNOSTICS, nextMode);
      this.diagnostics = initialDiagnostics;
      this.suppressedDiagnostics = Math.max(
        0,
        countAnalysisDiagnostics(analysis, nextMode) - initialDiagnostics.length
      );
      this.session = candidate;
      candidate = null;
      this.updateReloadRegistration(this.session.id, [
        ...analysis.dependencyRelativePaths,
        ...prepared.dependencies
      ]);
      this.promotePreviewCandidate(prepared);
      prepared = null;
      await this.plugin.previewServer.revokeSession(previousToken).catch(error => {
        console.error("[ZJ HTML Studio] Failed to retire previous auto-reload session", error);
      });

      const relevantDependencies = [
        ...previousDependencies,
        ...analysis.dependencyRelativePaths,
        ...this.plugin.getPreviewDependencies(this.reloadRegistrationId)
      ];
      if (
        this.plugin.settings.autoReload
        && this.plugin.didVaultPathsChangeSince(analysisStartCheckpoint, relevantDependencies)
      ) {
        this.plugin.requestPreviewReload(this.reloadRegistrationId);
      }
    } catch (error) {
      if (prepared) {
        await this.discardPreviewCandidate(prepared);
        prepared = null;
        candidate = null;
      }
      if (candidate) {
        await this.plugin.previewServer.revokeSession(candidate.token).catch(revokeError => {
          console.error("[ZJ HTML Studio] Failed to revoke auto-reload candidate", revokeError);
        });
      }
      if (!this.isLoadCurrent(generation, signal) || isAbortError(error)) return;
      const message = toUserFacingPreviewError(error, "page");
      const updated = upsertDisplayDiagnostic(this.diagnostics, {
        level: "warning",
        title: trigger === "manual" ? "刷新没有应用" : "自动刷新没有应用新版本",
        detail: `${message} 当前仍显示上一次成功打开的版本。`
      });
      if (updated.length <= MAX_DISPLAY_DIAGNOSTICS) this.diagnostics = updated;
      else this.suppressedDiagnostics += 1;
      this.setStatus(
        `${trigger === "manual" ? "刷新没有应用" : "自动刷新没有应用新版本"}：${message} 当前仍显示上一次可用版本。`,
        "error"
      );
      this.scheduleDiagnosticsRender();
    }
  }

  private async reloadAfterDependencyChange(): Promise<void> {
    if (!this.file) return;
    const action = decideAutoReloadAction({
      enabled: this.plugin.settings.autoReload,
      hasSession: this.session !== null,
      isFullscreen: isFullscreenTarget(this.getPreviewIframe(), this.contentEl.doc)
    });
    if (action === "ignore") return;
    if (action === "defer-fullscreen") {
      this.deferredFullscreenReload = true;
      return;
    }
    if (action === "initial-load") {
      await this.loadPreview(this.file, {
        confirmedScopePath: this.confirmedScopePath,
        modeOverride: this.modeOverride,
        preserveBrowserSessions: true
      });
      return;
    }
    await this.reloadWithCandidateSession(this.file);
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
    return toVaultRelativePath(this.plugin.vaultBasePath, absolutePath)
      ?? "知识仓库之外（已阻止）";
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function createCandidateAbortError(): Error {
  const error = new Error("Candidate preview aborted");
  error.name = "AbortError";
  return error;
}

function isImeComposing(event: KeyboardEvent): boolean {
  return event.isComposing || (event as unknown as { keyCode?: number }).keyCode === 229;
}

function isSearchBridgeMessage(value: unknown): value is SearchBridgeMessage {
  if (typeof value !== "object" || value === null) return false;
  if (!("channel" in value) || typeof value.channel !== "string") return false;
  if (!("type" in value) || typeof value.type !== "string") return false;
  return [
    "html-studio-page-state",
    "html-studio-page-state-restored",
    "html-studio-search-leaving",
    "html-studio-search-open",
    "html-studio-search-ready",
    "html-studio-search-result"
  ].includes(value.type);
}

function samePositions(first: number[], second: number[]): boolean {
  return first.length === second.length && first.every((position, index) => position === second[index]);
}

function normalizeSearchResultNumber(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(10_000, Math.floor(value)));
}
