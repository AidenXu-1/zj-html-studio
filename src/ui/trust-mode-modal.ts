import { Modal, Notice, setIcon } from "obsidian";
import type { App } from "obsidian";
import type { PreviewMode } from "../settings";

interface TrustModeModalOptions {
  currentMode: PreviewMode;
  onChoose: (mode: PreviewMode, remember: boolean) => void | Promise<void>;
  scopePath: string;
}

export class TrustModeModal extends Modal {
  private mode: PreviewMode;
  private remember = false;

  constructor(
    app: App,
    private readonly options: TrustModeModalOptions
  ) {
    super(app);
    this.mode = options.currentMode;
  }

  override onOpen(): void {
    this.modalEl.addClass("html-studio-trust-modal");
    this.setTitle("选择这个页面的打开方式");

    const intro = this.contentEl.createDiv({ cls: "html-studio-trust-intro" });
    const icon = intro.createDiv({ cls: "html-studio-trust-icon" });
    setIcon(icon, "shield-check");
    intro.createEl("p", {
      text: "安全只读会关闭页面脚本、后台网络请求和外部资源加载。页面里的链接或跳转仍可能离开本地预览。"
    });

    const choices = this.contentEl.createDiv({ cls: "html-studio-trust-choices" });
    const safeChoice = this.createChoice(
      choices,
      "safe",
      "安全只读",
      "适合来源不明的页面。排版和本地媒体可查看，脚本、后台网络请求、外部资源和剪贴板关闭。",
      true
    );
    const trustedChoice = this.createChoice(
      choices,
      "trusted",
      "可信兼容",
      "适合你自己生成的课程和公众号页面。脚本、模块、网络请求和剪贴板可用；Obsidian 内仍限制表单提交、弹窗和下载。",
      false
    );

    const scope = this.contentEl.createDiv({ cls: "html-studio-trust-scope" });
    scope.createSpan({ text: "允许使用的资源范围" });
    scope.createEl("code", { text: this.options.scopePath || "整个知识仓库" });
    scope.createEl("small", {
      text: "可信页面看不到 Obsidian 主窗口，也不能读取这个文件夹之外的知识内容，但可以向外联网。"
    });

    const footer = this.contentEl.createDiv({ cls: "html-studio-trust-footer" });
    const rememberLabel = footer.createEl("label", { cls: "html-studio-remember" });
    const checkbox = rememberLabel.createEl("input", { type: "checkbox" });
    checkbox.disabled = this.options.scopePath === "";
    checkbox.addEventListener("change", () => {
      this.remember = checkbox.checked;
    });
    rememberLabel.createSpan({ text: this.options.scopePath === "" ? "整个仓库不能被永久信任" : "记住这个文件夹的选择" });

    const actions = footer.createDiv({ cls: "html-studio-trust-actions" });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", { cls: "mod-cta", text: this.mode === "safe" ? "安全只读" : "可信打开" });
    confirm.addEventListener("click", () => {
      void this.confirmChoice(confirm);
    });

    const updateSelection = (): void => {
      safeChoice.toggleClass("is-selected", this.mode === "safe");
      trustedChoice.toggleClass("is-selected", this.mode === "trusted");
      confirm.setText(this.mode === "safe" ? "安全只读" : "可信打开");
    };
    safeChoice.addEventListener("click", () => {
      this.mode = "safe";
      updateSelection();
    });
    trustedChoice.addEventListener("click", () => {
      this.mode = "trusted";
      updateSelection();
    });
    updateSelection();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private async confirmChoice(confirm: HTMLButtonElement): Promise<void> {
    if (confirm.disabled) return;
    confirm.disabled = true;
    try {
      await this.options.onChoose(this.mode, this.remember);
      this.close();
    } catch (error) {
      console.error("[ZJ HTML Studio] Failed to update preview mode", error);
      new Notice("打开方式没有保存成功，请重试。");
      confirm.disabled = false;
    }
  }

  private createChoice(
    parent: HTMLElement,
    mode: PreviewMode,
    title: string,
    description: string,
    recommended: boolean
  ): HTMLElement {
    const choice = parent.createDiv({ cls: "html-studio-trust-choice" });
    choice.dataset.mode = mode;
    choice.createSpan({ cls: "html-studio-radio" });
    const copy = choice.createDiv();
    copy.createEl("strong", { text: title });
    copy.createEl("p", { text: description });
    if (recommended) choice.createSpan({ cls: "html-studio-recommended", text: "推荐" });
    return choice;
  }
}
