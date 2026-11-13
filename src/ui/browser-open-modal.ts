import { Modal, type App } from "obsidian";
import type { PreviewMode } from "../settings";
import { renderResourceScope } from "./trust-mode-modal";

export class BrowserOpenModal extends Modal {
  private resolveMode: ((mode: PreviewMode | null) => void) | null = null;
  private settled = false;

  constructor(app: App, private readonly scopePath: string, private readonly currentMode: PreviewMode = "safe") { super(app); }

  waitForMode(): Promise<PreviewMode | null> {
    return new Promise(resolve => { this.resolveMode = resolve; this.open(); });
  }
  cancel(): void { this.settle(null); this.close(); }

  override onOpen(): void {
    this.modalEl.addClass("html-studio-access-modal");
    this.setTitle("在浏览器中打开？");
    this.contentEl.createEl("p", { cls: "html-studio-access-intro", text: this.currentMode === "safe"
      ? "以只读方式继续查看。页面交互、常见联网请求和剪贴板保持关闭。"
      : this.currentMode === "interactive"
        ? "继续允许页面交互。常见联网请求、外部资源和剪贴板写入保持关闭。"
        : this.currentMode === "standard"
          ? "继续显示课件、运行交互和加载在线内容。本地文件访问与当前课件相同。"
          : "将允许页面交互、联网和剪贴板写入。浏览器还可能允许表单、弹窗和下载，仅打开你确认可信的页面。" });
    this.contentEl.createEl("p", { cls: "html-studio-access-note", text: this.currentMode === "safe"
      ? "链接或页面跳转仍可能打开外部地址。此窗口将在预览关闭或 30 分钟后失效。"
      : "页面跳转与点对点通信仍可能联网。此窗口将在预览关闭或 30 分钟后失效。" });
    renderResourceScope(this.contentEl, this.scopePath);
    const footer = this.contentEl.createDiv({ cls: "html-studio-access-actions" });
    const cancel = footer.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.cancel());
    if (this.currentMode !== "safe") {
      const safe = footer.createEl("button", { text: "只读打开" });
      safe.addEventListener("click", () => this.choose("safe"));
    }
    const confirm = footer.createEl("button", { text: this.currentMode === "trusted" ? "允许并打开" : "在浏览器中打开", cls: "mod-cta" });
    confirm.addEventListener("click", () => this.choose(this.currentMode));
  }
  override onClose(): void { this.settle(null); this.contentEl.empty(); }
  private choose(mode: PreviewMode): void { this.settle(mode); this.close(); }
  private settle(mode: PreviewMode | null): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveMode?.(mode);
    this.resolveMode = null;
  }
}
