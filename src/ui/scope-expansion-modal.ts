import { Modal, setIcon, type App } from "obsidian";
import type { PreviewMode } from "../settings";

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
    this.modalEl.addClass("html-studio-trust-modal");
    this.setTitle("临时扩大这个页面的资源范围？");
    const intro = this.contentEl.createDiv({ cls: "html-studio-trust-intro" });
    const icon = intro.createDiv({ cls: "html-studio-trust-icon" });
    setIcon(icon, "folder-key");
    intro.createEl("p", {
      text: "插件已经确认目标是知识仓库内当前存在的普通文件。扩大范围只对这个标签本次会话生效，不会保存为文件夹权限。"
    });

    this.renderScope("页面刚才尝试读取", this.options.targetRelativePath);
    this.renderScope("当前资源范围", this.options.currentScopePath || "整个知识仓库");
    this.renderScope("扩大后的资源范围", this.options.suggestedScopePath || "整个知识仓库");

    const risk = this.contentEl.createDiv({ cls: "html-studio-trust-scope" });
    risk.createSpan({ text: "当前页面权限" });
    risk.createEl("code", { text: modeLabel(this.options.mode) });
    risk.createEl("small", {
      text: this.options.mode === "trusted"
        ? "可信兼容仍允许页面脚本、联网和剪贴板。确认前请同时确认页面来源。"
        : this.options.mode === "interactive"
          ? "本地交互会运行页面脚本；常见请求通道受阻，但页面导航和 WebRTC 不作离线承诺。"
          : "安全只读继续阻止用户脚本和常见后台请求。"
    });

    const actions = this.contentEl.createDiv({ cls: "html-studio-trust-actions" });
    const cancel = actions.createEl("button", { text: "保持当前范围" });
    cancel.addEventListener("click", () => this.cancel());
    const confirm = actions.createEl("button", { cls: "mod-cta", text: "仅本次扩大范围" });
    confirm.addEventListener("click", () => {
      this.settle(true);
      this.close();
    });
  }

  override onClose(): void {
    this.settle(false);
    this.contentEl.empty();
  }

  private renderScope(label: string, value: string): void {
    const scope = this.contentEl.createDiv({ cls: "html-studio-trust-scope" });
    scope.createSpan({ text: label });
    scope.createEl("code", { text: value });
  }

  private settle(approved: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveDecision?.(approved);
    this.resolveDecision = null;
  }
}

function modeLabel(mode: PreviewMode): string {
  if (mode === "trusted") return "可信兼容";
  if (mode === "interactive") return "本地交互";
  return "安全只读";
}
