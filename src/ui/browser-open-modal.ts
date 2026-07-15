import { Modal, setIcon, type App } from "obsidian";
import type { PreviewMode } from "../settings";

export class BrowserOpenModal extends Modal {
  private resolveMode: ((mode: PreviewMode | null) => void) | null = null;
  private settled = false;

  constructor(app: App, private readonly scopePath: string) {
    super(app);
  }

  waitForMode(): Promise<PreviewMode | null> {
    return new Promise(resolve => {
      this.resolveMode = resolve;
      this.open();
    });
  }

  cancel(): void {
    this.settle(null);
    this.close();
  }

  override onOpen(): void {
    this.modalEl.addClass("html-studio-trust-modal");
    this.setTitle("选择浏览器打开方式");

    const intro = this.contentEl.createDiv({ cls: "html-studio-trust-intro" });
    const icon = intro.createDiv({ cls: "html-studio-trust-icon" });
    setIcon(icon, "external-link");
    intro.createEl("p", {
      text: "系统浏览器不使用 Obsidian 里的 iframe 沙箱，因此插件会创建一个新的短期会话，并重新执行安全策略。"
    });

    const choices = this.contentEl.createDiv({ cls: "html-studio-trust-choices" });
    this.createAction(
      choices,
      "shield",
      "安全只读打开",
      "脚本、后台网络请求、外部资源和剪贴板保持关闭；页面里的链接或跳转仍可能离开当前地址。",
      "安全打开",
      "mod-cta",
      () => this.choose("safe")
    );
    this.createAction(
      choices,
      "shield-alert",
      "可信浏览器打开",
      "页面可以运行脚本、联网，并读取下面资源范围。只用于你自己生成或确认可信的页面。",
      "授权并打开",
      "mod-warning",
      () => this.choose("trusted")
    );

    const scope = this.contentEl.createDiv({ cls: "html-studio-trust-scope" });
    scope.createSpan({ text: "可信浏览器打开时可以读取" });
    scope.createEl("code", { text: this.scopePath || "整个知识仓库" });
    scope.createEl("small", { text: "浏览器会话在当前预览关闭或 30 分钟后自动失效。" });

    const footer = this.contentEl.createDiv({ cls: "html-studio-trust-footer" });
    const actions = footer.createDiv({ cls: "html-studio-trust-actions" });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.cancel());
  }

  override onClose(): void {
    this.settle(null);
    this.contentEl.empty();
  }

  private createAction(
    parent: HTMLElement,
    iconName: string,
    title: string,
    description: string,
    buttonText: string,
    buttonClass: string,
    action: () => void
  ): void {
    const card = parent.createDiv({ cls: "html-studio-trust-choice html-studio-browser-choice" });
    const icon = card.createSpan({ cls: "html-studio-browser-icon" });
    setIcon(icon, iconName);
    const copy = card.createDiv();
    copy.createEl("strong", { text: title });
    copy.createEl("p", { text: description });
    const button = card.createEl("button", { text: buttonText, cls: `html-studio-browser-action ${buttonClass}` });
    button.addEventListener("click", event => {
      event.stopPropagation();
      action();
    });
    card.addEventListener("click", action);
  }

  private choose(mode: PreviewMode): void {
    this.settle(mode);
    this.close();
  }

  private settle(mode: PreviewMode | null): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveMode?.(mode);
    this.resolveMode = null;
  }
}
