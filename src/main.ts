import { FileSystemAdapter, Notice, Plugin } from "obsidian";
import { shell } from "electron";
import path from "node:path";
import { registerHtmlEmbedExtensions } from "./embed/embed-registry";
import { EmbedSessionLimiter } from "./embed/embed-session-limiter";
import { BoundedPathChangeLog, PreviewReloadRegistry } from "./reload/preview-reload-registry";
import {
  addSafeScope,
  addTrustedScope,
  DEFAULT_SETTINGS,
  isScopeTrusted,
  normalizeScopePath,
  removeSafeScope,
  removeTrustedScope,
  SerializedSettingsUpdater,
  type HtmlStudioSettings
} from "./settings";
import { PreviewServer, type PreviewDiagnostic } from "./server/preview-server";
import { HtmlPreviewView, HTML_PREVIEW_VIEW_TYPE } from "./view/html-preview-view";

const LOG_PREFIX = "[ZJ HTML Studio]";

export default class HtmlStudioPlugin extends Plugin {
  settings: HtmlStudioSettings = { ...DEFAULT_SETTINGS, safeScopes: [], trustedScopes: [] };
  previewServer!: PreviewServer;
  vaultBasePath = "";
  private readonly diagnosticSinks = new Map<string, (diagnostic: PreviewDiagnostic) => void>();
  private readonly embedSessionLimiter = new EmbedSessionLimiter(8);
  private readonly autoReloadListeners = new Set<() => void>();
  private readonly pathChangeLog = new BoundedPathChangeLog();
  private nextReloadRegistrationId = 0;
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

    this.vaultBasePath = adapter.getBasePath();
    this.previewServer = new PreviewServer(this.vaultBasePath, {
      onDiagnostic: diagnostic => this.diagnosticSinks.get(diagnostic.sessionId ?? "")?.(diagnostic),
      onResourceAccess: access => {
        const relativePath = path.relative(this.vaultBasePath, access.resolvedPath).split(path.sep).join("/");
        const registrationId = this.sessionReloadRegistrations.get(access.sessionId);
        if (registrationId && !relativePath.startsWith("..")) {
          this.reloadRegistry.addDependency(registrationId, relativePath);
        }
      },
      onServerError: error => console.error(`${LOG_PREFIX} Preview server error`, error)
    });

    this.registerView(HTML_PREVIEW_VIEW_TYPE, leaf => new HtmlPreviewView(leaf, this));
    this.registerExtensions(["html", "htm"], HTML_PREVIEW_VIEW_TYPE);
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

  isScopeTrusted(scopePath: string): boolean {
    return isScopeTrusted(scopePath, this.settings.trustedScopes, this.settings.safeScopes);
  }

  async trustScope(scopePath: string): Promise<void> {
    await this.settingsUpdater.update(current => ({
      ...current,
      safeScopes: removeSafeScope(scopePath, current.safeScopes),
      trustedScopes: addTrustedScope(scopePath, current.trustedScopes, current.safeScopes)
    }));
  }

  async untrustScope(scopePath: string): Promise<void> {
    await this.settingsUpdater.update(current => {
      const trustedScopes = removeTrustedScope(scopePath, current.trustedScopes);
      return {
        ...current,
        safeScopes: addSafeScope(scopePath, current.safeScopes, trustedScopes),
        trustedScopes
      };
    });
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

  private removeReloadSessionMappings(registrationId: string): void {
    this.sessionReloadRegistrations.forEach((mappedRegistrationId, sessionId) => {
      if (mappedRegistrationId === registrationId) this.sessionReloadRegistrations.delete(sessionId);
    });
  }
}
