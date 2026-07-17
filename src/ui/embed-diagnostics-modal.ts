import { Modal, setIcon, type App } from "obsidian";
import type { DisplayDiagnostic } from "./diagnostics";

interface EmbedDiagnosticsModalOptions {
  diagnostics: readonly DisplayDiagnostic[];
  onOpenInTab: () => void;
  suppressedCount: number;
}

export class EmbedDiagnosticsModal extends Modal {
  constructor(app: App, private readonly options: EmbedDiagnosticsModalOptions) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("html-studio-embed-diagnostics-modal");
    this.setTitle("HTML 嵌入诊断");
    const visibleCount = this.options.diagnostics.length;
    const totalCount = visibleCount + this.options.suppressedCount;
    this.contentEl.createEl("p", {
      text: totalCount === 0
        ? "当前没有发现资源问题。"
        : this.options.suppressedCount > 0
          ? `显示 ${visibleCount} 条，另有 ${this.options.suppressedCount} 条已折叠。`
          : `当前记录了 ${visibleCount} 个提醒。`
    });

    const list = this.contentEl.createDiv({ cls: "html-studio-embed-diagnostic-list" });
    for (const diagnostic of this.options.diagnostics) {
      const card = list.createDiv({ cls: `html-studio-diagnostic-card is-${diagnostic.level}` });
      const title = card.createDiv({ cls: "html-studio-diagnostic-title" });
      const icon = title.createSpan();
      setIcon(icon, diagnostic.level === "error" ? "octagon-alert" : "triangle-alert");
      title.createEl("strong", { text: diagnostic.title });
      const body = card.createDiv({ cls: "html-studio-diagnostic-content" });
      if (diagnostic.requestedPath) this.renderPath(body, "页面请求", diagnostic.requestedPath);
      if (diagnostic.resolvedPath) this.renderPath(body, "实际寻找", diagnostic.resolvedPath);
      if (diagnostic.detail) body.createEl("p", { text: diagnostic.detail });
    }

    const actions = this.contentEl.createDiv({ cls: "html-studio-trust-actions" });
    const close = actions.createEl("button", { text: "关闭" });
    close.addEventListener("click", () => this.close());
    const open = actions.createEl("button", { cls: "mod-cta", text: "在标签页处理" });
    open.addEventListener("click", () => {
      this.options.onOpenInTab();
      this.close();
    });
  }

  private renderPath(parent: HTMLElement, label: string, value: string): void {
    const field = parent.createDiv({ cls: "html-studio-path-field" });
    field.createSpan({ text: label });
    field.createEl("code", { text: value });
  }
}
