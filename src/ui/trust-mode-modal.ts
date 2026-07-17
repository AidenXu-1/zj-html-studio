import { Modal, Notice, setIcon } from "obsidian";
import type { App } from "obsidian";
import type { PreviewMode } from "../settings";
import { toUserFacingPreviewError } from "./error-message";
import { movePreviewModeSelection } from "./mode-choice-navigation";

const MODE_ACTION_LABELS: Record<PreviewMode, string> = {
  safe: "安全只读",
  interactive: "本地交互打开",
  trusted: "可信打开"
};

interface TrustModeModalOptions {
  currentMode: PreviewMode;
  onChoose: (mode: PreviewMode, remember: boolean) => boolean | Promise<boolean>;
  permissionScopePath: string;
  resourceScopePath: string;
}

export class TrustModeModal extends Modal {
  private cancelled = false;
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
      text: "按页面来源和需要选择权限。页面里的链接或跳转在三种模式下仍可能离开本地预览。"
    });

    const choices = this.contentEl.createDiv({ cls: "html-studio-trust-choices" });
    choices.setAttribute("role", "radiogroup");
    choices.setAttribute("aria-label", "页面打开方式");
    const safeChoice = this.createChoice(
      choices,
      "safe",
      "安全只读",
      "适合来源不明的页面。排版和本地媒体可查看，脚本、后台网络请求、外部资源和剪贴板关闭。",
      true
    );
    const interactiveChoice = this.createChoice(
      choices,
      "interactive",
      "本地交互",
      "只适合你自己制作并检查过的本地课件。页面脚本和范围内资源可用；常见 fetch、XHR、WebSocket 与外部资源受阻，页面导航和 WebRTC 仍可能产生网络活动。",
      false
    );
    const trustedChoice = this.createChoice(
      choices,
      "trusted",
      "可信兼容",
      "适合你自己生成的课程和公众号页面。脚本、模块、网络请求和剪贴板可用；Obsidian 内仍限制表单提交、弹窗和下载。",
      false
    );

    const permissionScope = this.contentEl.createDiv({ cls: "html-studio-trust-scope" });
    permissionScope.createSpan({ text: "记住选择时适用的 HTML 文件夹" });
    permissionScope.createEl("code", {
      text: this.options.permissionScopePath || "仓库根目录（不能永久记住）"
    });
    permissionScope.createEl("small", {
      text: "这里只决定该文件夹内 HTML 的默认打开方式，不会扩大页面可读取的本地资源。更具体的子文件夹规则优先。"
    });

    const resourceScope = this.contentEl.createDiv({ cls: "html-studio-trust-scope" });
    resourceScope.createSpan({ text: "这个页面可以读取的本地资源范围" });
    resourceScope.createEl("code", { text: this.options.resourceScopePath || "整个知识仓库" });
    resourceScope.createEl("small", {
      text: "本地交互和可信页面都看不到 Obsidian 主窗口，也不能读取这个文件夹之外的知识内容。本地交互会阻止常见后台请求，但页面导航与点对点通信不作离线承诺。"
    });

    const footer = this.contentEl.createDiv({ cls: "html-studio-trust-footer" });
    const rememberLabel = footer.createEl("label", { cls: "html-studio-remember" });
    const checkbox = rememberLabel.createEl("input", { type: "checkbox" });
    checkbox.disabled = this.options.permissionScopePath === "";
    checkbox.addEventListener("change", () => {
      this.remember = checkbox.checked;
    });
    rememberLabel.createSpan({
      text: this.options.permissionScopePath === ""
        ? "仓库根目录中的 HTML 不能永久记住权限"
        : "记住这个 HTML 文件夹的选择"
    });

    const actions = footer.createDiv({ cls: "html-studio-trust-actions" });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.cancel());
    const confirm = actions.createEl("button", { cls: "mod-cta", text: MODE_ACTION_LABELS[this.mode] });
    confirm.addEventListener("click", () => {
      void this.confirmChoice(confirm);
    });

    const updateSelection = (): void => {
      for (const choice of [safeChoice, interactiveChoice, trustedChoice]) {
        const selected = choice.dataset.mode === this.mode;
        choice.toggleClass("is-selected", selected);
        choice.setAttribute("aria-checked", selected.toString());
        choice.tabIndex = selected ? 0 : -1;
      }
      confirm.setText(MODE_ACTION_LABELS[this.mode]);
    };
    const modeChoices: Record<PreviewMode, HTMLButtonElement> = {
      safe: safeChoice,
      interactive: interactiveChoice,
      trusted: trustedChoice
    };
    const selectMode = (mode: PreviewMode, focus: boolean): void => {
      this.mode = mode;
      updateSelection();
      if (focus) modeChoices[mode].focus();
    };
    for (const choice of Object.values(modeChoices)) {
      choice.addEventListener("click", () => selectMode(choice.dataset.mode as PreviewMode, false));
      choice.addEventListener("keydown", event => {
        const nextMode = movePreviewModeSelection(this.mode, event.key);
        if (nextMode === this.mode && !["Home", "End"].includes(event.key)) return;
        event.preventDefault();
        selectMode(nextMode, true);
      });
    }
    updateSelection();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  cancel(): void {
    this.cancelled = true;
    this.close();
  }

  private async confirmChoice(confirm: HTMLButtonElement): Promise<void> {
    if (confirm.disabled) return;
    confirm.disabled = true;
    try {
      const applied = await this.options.onChoose(this.mode, this.remember);
      if (this.cancelled) return;
      if (!applied) {
        new Notice("页面刚刚发生了刷新，本次选择没有生效，请重新选择。");
        confirm.disabled = false;
        return;
      }
      this.close();
    } catch (error) {
      if (this.cancelled) return;
      console.error("[ZJ HTML Studio] Failed to update preview mode", error);
      new Notice(toUserFacingPreviewError(error, "page"));
      confirm.disabled = false;
    }
  }

  private createChoice(
    parent: HTMLElement,
    mode: PreviewMode,
    title: string,
    description: string,
    recommended: boolean
  ): HTMLButtonElement {
    const choice = parent.createEl("button", { cls: "html-studio-trust-choice", type: "button" });
    choice.dataset.mode = mode;
    choice.setAttribute("role", "radio");
    choice.createSpan({ cls: "html-studio-radio" });
    const copy = choice.createDiv();
    copy.createEl("strong", { text: title });
    copy.createEl("p", { text: description });
    if (recommended) choice.createSpan({ cls: "html-studio-recommended", text: "推荐" });
    return choice;
  }
}
