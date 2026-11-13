import { Modal, Notice, type App } from "obsidian";
import type { PreviewMode } from "../settings";
import { toUserFacingPreviewError } from "./error-message";

interface TrustModeModalOptions {
  currentMode: PreviewMode;
  onChoose: (mode: PreviewMode, remember: boolean) => boolean | Promise<boolean>;
  permissionScopePath: string;
  resourceScopePath: string;
  requestMode?: "standard" | "trusted";
}

/** Presents capabilities honestly while retaining the existing enforcement modes. */
export class TrustModeModal extends Modal {
  private cancelled = false;
  private applying = false;
  private remember = false;

  constructor(app: App, private readonly options: TrustModeModalOptions) { super(app); }

  override onOpen(): void {
    this.modalEl.addClass("html-studio-access-modal");
    if (this.options.requestMode) this.renderRequest(this.options.requestMode);
    else this.renderOverview();
  }

  override onClose(): void { this.cancelled = true; this.contentEl.empty(); }
  cancel(): void { this.close(); }

  private renderOverview(): void {
    this.contentEl.empty();
    this.setTitle("页面权限");
    this.contentEl.createEl("p", { cls: "html-studio-access-intro", text: "查看当前允许的功能，随时可以关闭。" });
    const rows = this.contentEl.createDiv({ cls: "html-studio-access-rows" });
    const interactive = this.options.currentMode !== "safe";
    const trusted = this.options.currentMode === "trusted";
    const online = trusted || this.options.currentMode === "standard";
    this.createPermissionRow(rows, "页面交互", "按钮、翻页与动画", interactive, button => {
      if (interactive) void this.apply("safe", false, button);
      else void this.apply("standard", false, button);
    });
    this.createPermissionRow(rows, "联网", "加载在线图片、字体及其他在线内容", online, button => {
      void this.apply(online ? "interactive" : "standard", false, button);
    });
    if (online) this.createPermissionRow(rows, "复制到剪贴板", "允许页面写入，不读取剪贴板", trusted, button => {
      if (trusted) void this.apply("standard", false, button);
      else this.renderRequest("trusted");
    });
    this.contentEl.createEl("p", { cls: "html-studio-access-note", text: "联网不会自动开放剪贴板、摄像头或麦克风。" });
    renderResourceScope(this.contentEl, this.options.resourceScopePath);
    const footer = this.contentEl.createDiv({ cls: "html-studio-access-actions" });
    const done = footer.createEl("button", { text: "完成", cls: "mod-cta" });
    done.addEventListener("click", () => this.close());
  }

  private createPermissionRow(parent: HTMLElement, title: string, detail: string, enabled: boolean, action: (button: HTMLButtonElement) => void): void {
    const row = parent.createDiv({ cls: "html-studio-access-row" });
    const copy = row.createDiv({ cls: "html-studio-access-copy" });
    copy.createEl("strong", { text: title });
    copy.createEl("p", { text: detail });
    const controls = row.createDiv({ cls: "html-studio-access-row-actions" });
    controls.createSpan({ cls: "html-studio-access-state", text: enabled ? "已启用" : "未启用" });
    const button = controls.createEl("button", { cls: "html-studio-text-action", text: enabled ? "关闭" : "启用…" });
    button.setAttribute("aria-label", `${enabled ? "关闭" : "启用"}${title}`);
    button.addEventListener("click", () => { if (!this.applying) action(button); });
  }

  private renderRequest(mode: "standard" | "trusted"): void {
    this.contentEl.empty();
    this.remember = false;
    this.setTitle(mode === "standard" ? "恢复正常打开？" : "允许复制到剪贴板？");
    this.contentEl.createEl("p", { cls: "html-studio-access-intro", text: mode === "standard"
      ? "恢复按钮、翻页、动画和在线内容。额外的本地文件仍需单独允许。"
      : "允许这个页面把内容复制到剪贴板。页面不能读取你已经复制的内容。" });
    renderResourceScope(this.contentEl, this.options.resourceScopePath);
    if (this.options.permissionScopePath) {
      const label = this.contentEl.createEl("label", { cls: "html-studio-access-remember" });
      const checkbox = label.createEl("input", { type: "checkbox" });
      checkbox.checked = false;
      checkbox.addEventListener("change", () => { this.remember = checkbox.checked; });
      const copy = label.createDiv();
      copy.createSpan({ text: `记住「${folderName(this.options.permissionScopePath)}」的选择` });
      copy.createEl("small", { text: "此文件夹的其他 HTML 也会使用，已单独设置的子文件夹除外。" });
      label.title = this.options.permissionScopePath;
    }
    const footer = this.contentEl.createDiv({ cls: "html-studio-access-actions" });
    const cancel = footer.createEl("button", { text: this.options.requestMode ? "暂不启用" : "返回" });
    cancel.addEventListener("click", () => {
      if (this.applying) return;
      if (this.options.requestMode) this.cancel(); else this.renderOverview();
    });
    const confirm = footer.createEl("button", { text: mode === "standard" ? "恢复正常打开" : "允许复制", cls: "mod-cta" });
    confirm.addEventListener("click", () => { void this.apply(mode, this.remember, confirm); });
  }

  private async apply(mode: PreviewMode, remember: boolean, button: HTMLButtonElement): Promise<void> {
    if (this.applying || this.cancelled) return;
    this.applying = true;
    const label = button.textContent ?? "重试";
    button.setText("正在更新…");
    this.contentEl.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input").forEach(el => { el.disabled = true; });
    try {
      const applied = await this.options.onChoose(mode, remember);
      if (this.cancelled) return;
      if (applied) { this.close(); return; }
      new Notice("页面刚刚发生了刷新，本次选择没有生效，请重新选择。");
    } catch (error) {
      if (this.cancelled) return;
      console.error("[ZJ HTML Studio] Failed to update preview mode", error);
      new Notice(toUserFacingPreviewError(error, "page"));
    } finally {
      this.applying = false;
      if (!this.cancelled) {
        button.setText(label);
        this.contentEl.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input").forEach(el => { el.disabled = false; });
      }
    }
  }
}

export function folderName(path: string): string { return path.split("/").filter(Boolean).pop() || "整个知识仓库"; }

export function renderResourceScope(parent: HTMLElement, scopePath: string): void {
  const details = parent.createEl("details", { cls: "html-studio-access-scope" });
  const summary = details.createEl("summary");
  summary.createSpan({ text: "本地文件访问" });
  summary.createSpan({ cls: "html-studio-folder-name", text: "课件与配套资源" });
  details.createEl("p", { cls: "html-studio-access-note", text: "额外的笔记和数据文件单独允许，仅对当前课件有效。不会自动开放整个知识库或插件配置。" });
}
