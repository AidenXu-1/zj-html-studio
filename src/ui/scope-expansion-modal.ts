import { Modal, type App } from "obsidian";
import type { PreviewMode } from "../settings";
import { renderResourceDetails, renderResourceFilename } from "./resource-access-content";

interface ScopeExpansionModalOptions {
  currentScopePath: string;
  mode: PreviewMode;
  suggestedScopePath: string;
  targetRelativePath: string;
}

export class ScopeExpansionModal extends Modal {
  private resolveDecision: ((approved: boolean) => void) | null = null;
  private settled = false;

  constructor(app: App, private readonly options: ScopeExpansionModalOptions) {
    super(app);
  }

  waitForDecision(): Promise<boolean> {
    return new Promise(resolve => {
      this.resolveDecision = resolve;
      this.open();
    });
  }

  cancel(): void {
    this.settle(false);
    this.close();
  }

  override onOpen(): void {
    this.modalEl.addClass("html-studio-access-modal", "html-studio-resource-modal");
    this.setTitle("允许读取这个文件？");
    const body = this.contentEl.createDiv({ cls: "html-studio-resource-body" });
    renderResourceFilename(body, this.options.targetRelativePath);
    body.createEl("p", { cls: "html-studio-access-intro", text: "页面正在请求课件配套资源之外的文件。" });
    renderResourceDetails(body, [
      { label: "文件位置", path: this.options.targetRelativePath }
    ], []);
    if (this.options.mode === "trusted" || this.options.mode === "standard") body.createEl("p", {
      cls: "html-studio-resource-hint",
      text: "此页面可以联网，允许后也能读取和使用这个文件的内容。"
    });
    const footer = this.contentEl.createDiv({ cls: "html-studio-resource-footer" });
    footer.createEl("p", { cls: "html-studio-resource-hint", text: "只允许这一个文件，关闭课件后失效。其他文件不会一并开放。" });
    const actions = footer.createDiv({ cls: "html-studio-access-actions" });
    const cancel = actions.createEl("button", { text: "暂不允许" });
    cancel.addEventListener("click", () => this.cancel());
    const confirm = actions.createEl("button", { cls: "mod-cta", text: "允许读取" });
    confirm.addEventListener("click", () => {
      this.settle(true);
      this.close();
    });
  }

  override onClose(): void {
    this.settle(false);
    this.contentEl.empty();
  }

  private settle(approved: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveDecision?.(approved);
    this.resolveDecision = null;
  }
}
