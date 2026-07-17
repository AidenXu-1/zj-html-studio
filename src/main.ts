import { FileSystemAdapter, Notice, Plugin } from "obsidian";
import { shell } from "electron";
import { registerHtmlEmbedExtensions } from "./embed/embed-registry";
import { EmbedSessionLimiter } from "./embed/embed-session-limiter";
import { BoundedPathChangeLog, PreviewReloadRegistry } from "./reload/preview-reload-registry";
import { canonicalizeVaultBasePath, toVaultRelativePath } from "./scope/vault-path";
import {
  addInteractiveScope,
  addSafeScope,
  addTrustedScope,
  DEFAULT_SETTINGS,
  normalizeScopePath,
  removeInteractiveScope,
  removeSafeScope,
  removeTrustedScope,
  resolveScopeMode,
  SerializedSettingsUpdater,
  type HtmlStudioSettings,
  type PreviewMode
} from "./settings";
import { PreviewServer, type PreviewDiagnostic } from "./server/preview-server";
import { HtmlStudioSettingTab } from "./ui/settings-tab";
import { HtmlPreviewView, HTML_PREVIEW_VIEW_TYPE } from "./view/html-preview-view";

const LOG_PREFIX = "[ZJ HTML Studio]";

export interface ScopeModeChange {
  forceSafeReset: boolean;
  scopePath: string | null;
}

type ScopeModeListener = (change: ScopeModeChange) => void | Promise<void>;

export default class HtmlStudioPlugin extends Plugin {
  settings: HtmlStudioSettings = { ...DEFAULT_SETTINGS, interactiveScopes: [], safeScopes: [], trustedScopes: [] };
  previewServer!: PreviewServer;
  vaultBasePath = "";
  private readonly diagnosticSinks = new Map<string, (diagnostic: PreviewDiagnostic) => void>();
  private readonly embedSessionLimiter = new EmbedSessionLimiter(8);
  private readonly autoReloadListeners = new Set<() => void>();
  private readonly scopeModeListeners = new Set<ScopeModeListener>();
  private readonly pathChangeLog = new BoundedPathChangeLog();
  private nextReloadRegistrationId = 0;
  private readonly resourceSinks = new Map<string, (relativePath: string) => void>();
  private readonly sessionReloadRegistrations = new Map<string, string>();
  private readonly reloadRegistry = new PreviewReloadRegistry(160, 2_000, (id, error) => {
    console.error(`${LOG_PREFIX} Auto reload failed for ${id}`, error);
  });
  private readonly settingsUpdater = new SerializedSettingsUpdater(
    () => this.settings,
    next => this.saveData(next),
    next => {
      this.settings = next;
    }
  );

  override async onload(): Promise<void> {
    await this.loadSettings();

    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice("这个插件目前只支持使用本地文件夹的 Obsidian 桌面仓库。");
      return;
    }

    this.vaultBasePath = await canonicalizeVaultBasePath(adapter.getBasePath());
    this.previewServer = new PreviewServer(this.vaultBasePath, {
      onDiagnostic: diagnostic => this.diagnosticSinks.get(diagnostic.sessionId ?? "")?.(diagnostic),
      onResourceAccess: access => {
        const relativePath = toVaultRelativePath(this.vaultBasePath, access.resolvedPath);
        if (relativePath !== null) this.resourceSinks.get(access.sessionId)?.(relativePath);
        const registrationId = this.sessionReloadRegistrations.get(access.sessionId);
        if (registrationId && relativePath !== null) {
          this.reloadRegistry.addDependency(registrationId, relativePath);
        }
      },
      onServerError: error => console.error(`${LOG_PREFIX} Preview server error`, error)
    });

    this.registerView(HTML_PREVIEW_VIEW_TYPE, leaf => new HtmlPreviewView(leaf, this));
    this.registerExtensions(["html", "htm"], HTML_PREVIEW_VIEW_TYPE);
    this.addSettingTab(new HtmlStudioSettingTab(this.app, this));
    try {
      if (!registerHtmlEmbedExtensions(this, this.embedSessionLimiter)) {
        console.warn(`${LOG_PREFIX} This Obsidian version does not expose the HTML embed registry.`);
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} HTML embed registration failed`, error);
      new Notice("HTML 标签页可以继续使用，但笔记内嵌入没有注册成功。");
    }
    this.register(() => {
      this.diagnosticSinks.clear();
      this.autoReloadListeners.clear();
      this.scopeModeListeners.clear();
      this.resourceSinks.clear();
      this.sessionReloadRegistrations.clear();
      this.reloadRegistry.clear();
      void this.previewServer.stop().catch(error => {
        console.error(`${LOG_PREFIX} Preview server cleanup failed`, error);
      });
    });

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on("modify", file => this.notifyFileChanged(file.path)));
      this.registerEvent(this.app.vault.on("create", file => this.notifyFileChanged(file.path)));
      this.registerEvent(this.app.vault.on("delete", file => this.notifyFileChanged(file.path)));
      this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
        this.notifyFileChanged(oldPath);
        this.notifyFileChanged(file.path);
      }));
    });

    this.addCommand({
      id: "reload-current-preview",
      name: "Reload current HTML preview",
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(HtmlPreviewView);
        if (!view) return false;
        if (!checking) view.refreshPreview();
        return true;
      }
    });
  }

  getVaultChangeCheckpoint(): number {
    return this.pathChangeLog.checkpoint();
  }

  createReloadRegistrationId(): string {
    this.nextReloadRegistrationId += 1;
    return `html-preview-view-${this.nextReloadRegistrationId}`;
  }

  registerDiagnosticSink(sessionId: string, sink: (diagnostic: PreviewDiagnostic) => void): () => void {
    this.diagnosticSinks.set(sessionId, sink);
    return () => this.diagnosticSinks.delete(sessionId);
  }

  registerResourceSink(sessionId: string, sink: (relativePath: string) => void): () => void {
    this.resourceSinks.set(sessionId, sink);
    return () => this.resourceSinks.delete(sessionId);
  }

  registerPreviewDependencies(
    registrationId: string,
    sessionId: string,
    dependencies: Iterable<string>,
    callback: () => void | Promise<void>
  ): () => void {
    this.removeReloadSessionMappings(registrationId);
    this.sessionReloadRegistrations.set(sessionId, registrationId);
    const unregister = this.reloadRegistry.register(registrationId, dependencies, callback);
    return () => {
      unregister();
      this.removeReloadSessionMappings(registrationId);
    };
  }

  updatePreviewDependencies(
    registrationId: string,
    sessionId: string,
    dependencies: Iterable<string>
  ): boolean {
    if (!this.reloadRegistry.replaceDependencies(registrationId, dependencies)) return false;
    this.removeReloadSessionMappings(registrationId);
    this.sessionReloadRegistrations.set(sessionId, registrationId);
    return true;
  }

  requestPreviewReload(registrationId: string): boolean {
    return this.reloadRegistry.requestReload(registrationId);
  }

  getPreviewDependencies(registrationId: string): string[] {
    return this.reloadRegistry.getDependencies(registrationId);
  }

  didVaultPathsChangeSince(checkpoint: number, paths: Iterable<string>): boolean {
    return this.pathChangeLog.hasAnySince(checkpoint, paths);
  }

  registerAutoReloadListener(listener: () => void): () => void {
    this.autoReloadListeners.add(listener);
    return () => this.autoReloadListeners.delete(listener);
  }

  registerScopeModeListener(listener: ScopeModeListener): () => void {
    this.scopeModeListeners.add(listener);
    return () => this.scopeModeListeners.delete(listener);
  }

  getScopeMode(scopePath: string): PreviewMode {
    return resolveScopeMode(
      scopePath,
      this.settings.trustedScopes,
      this.settings.safeScopes,
      this.settings.interactiveScopes
    );
  }

  async rememberScopeMode(scopePath: string, mode: PreviewMode): Promise<void> {
    const normalizedScopePath = normalizeScopePath(scopePath);
    await this.settingsUpdater.update(current => {
      let interactiveScopes = removeInteractiveScope(normalizedScopePath, current.interactiveScopes);
      let safeScopes = removeSafeScope(normalizedScopePath, current.safeScopes);
      let trustedScopes = removeTrustedScope(normalizedScopePath, current.trustedScopes);

      if (mode === "safe") safeScopes = addSafeScope(normalizedScopePath, safeScopes);
      if (mode === "interactive") interactiveScopes = addInteractiveScope(normalizedScopePath, interactiveScopes);
      if (mode === "trusted") trustedScopes = addTrustedScope(normalizedScopePath, trustedScopes);

      return { ...current, interactiveScopes, safeScopes, trustedScopes };
    });
    await this.notifyScopeModeChange({ forceSafeReset: false, scopePath: normalizedScopePath });
  }

  async removeScopeMode(scopePath: string, mode: PreviewMode): Promise<void> {
    const normalizedScopePath = normalizeScopePath(scopePath);
    await this.settingsUpdater.update(current => ({
      ...current,
      interactiveScopes: mode === "interactive"
        ? removeInteractiveScope(normalizedScopePath, current.interactiveScopes)
        : current.interactiveScopes,
      safeScopes: mode === "safe"
        ? removeSafeScope(normalizedScopePath, current.safeScopes)
        : current.safeScopes,
      trustedScopes: mode === "trusted"
        ? removeTrustedScope(normalizedScopePath, current.trustedScopes)
        : current.trustedScopes
    }));
    await this.notifyScopeModeChange({ forceSafeReset: false, scopePath: normalizedScopePath });
  }

  async resetScopeModes(): Promise<void> {
    await this.settingsUpdater.update(current => ({
      ...current,
      interactiveScopes: [],
      safeScopes: [],
      trustedScopes: []
    }));
    await this.notifyScopeModeChange({ forceSafeReset: true, scopePath: null });
  }

  async setAutoReload(enabled: boolean): Promise<void> {
    await this.settingsUpdater.update(current => ({ ...current, autoReload: enabled }));
    this.autoReloadListeners.forEach(listener => listener());
  }

  revealActiveFile(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("当前没有可以定位的 HTML 文件。");
      return;
    }
    shell.showItemInFolder((this.app.vault.adapter as FileSystemAdapter).getFullPath(file.path));
  }

  private async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<HtmlStudioSettings> | null;
    this.settings = {
      autoReload: stored?.autoReload ?? DEFAULT_SETTINGS.autoReload,
      interactiveScopes: Array.isArray(stored?.interactiveScopes)
        ? stored.interactiveScopes
          .filter((scope): scope is string => typeof scope === "string")
          .map(normalizeScopePath)
          .filter(Boolean)
        : [],
      safeScopes: Array.isArray(stored?.safeScopes)
        ? stored.safeScopes
          .filter((scope): scope is string => typeof scope === "string")
          .map(normalizeScopePath)
          .filter(Boolean)
        : [],
      trustedScopes: Array.isArray(stored?.trustedScopes)
        ? stored.trustedScopes
          .filter((scope): scope is string => typeof scope === "string")
          .map(normalizeScopePath)
          .filter(Boolean)
        : []
    };
  }

  private notifyFileChanged(filePath: string): void {
    this.pathChangeLog.record(filePath);
    if (this.settings.autoReload) this.reloadRegistry.notifyPathChanged(filePath);
  }

  private async notifyScopeModeChange(change: ScopeModeChange): Promise<void> {
    const results = await Promise.allSettled(
      [...this.scopeModeListeners].map(listener => Promise.resolve().then(() => listener(change)))
    );
    results.forEach(result => {
      if (result.status === "rejected") {
        console.error(`${LOG_PREFIX} Permission change propagation failed`, result.reason);
      }
    });
  }

  private removeReloadSessionMappings(registrationId: string): void {
    this.sessionReloadRegistrations.forEach((mappedRegistrationId, sessionId) => {
      if (mappedRegistrationId === registrationId) this.sessionReloadRegistrations.delete(sessionId);
    });
  }
}
