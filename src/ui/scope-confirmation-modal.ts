import { Modal, setIcon, type App } from "obsidian";
import type { ScopeAnalysis } from "../scope/dependency-analyzer";
import {
  canOfferEntryFolderSafeTrial,
  type ScopeConfirmationDecision
} from "../scope/resource-scope-policy";

export class ScopeConfirmationModal extends Modal {
  private resolveDecision: ((decision: ScopeConfirmationDecision) => void) | null = null;
  private settled = false;

  constructor(app: App, private readonly analysis: ScopeAnalysis) {
    super(app);
  }

  waitForDecision(): Promise<ScopeConfirmationDecision> {
    return new Promise(resolve => {
      this.resolveDecision = resolve;
      this.open();
    });
  }

  cancel(): void {
    this.settle("cancel");
    this.close();
  }

  override onOpen(): void {
    this.modalEl.addClass("html-studio-trust-modal");
    this.setTitle("这个页面需要更大的资源范围");

    const intro = this.contentEl.createDiv({ cls: "html-studio-trust-intro" });
    const icon = intro.createDiv({ cls: "html-studio-trust-icon" });
    setIcon(icon, "folder-key");
    intro.createEl("p", {
      text: "插件在创建本地预览会话前停了下来。请确认下面的范围确实属于这个页面。"
    });

    const scope = this.contentEl.createDiv({ cls: "html-studio-trust-scope" });
    scope.createSpan({ text: "页面将能够请求的文件夹" });
    scope.createEl("code", { text: this.analysis.scopeRelativePath || "整个知识仓库" });
    scope.createEl("small", { text: this.buildReasonText() });

    const footer = this.contentEl.createDiv({ cls: "html-studio-trust-footer" });
    footer.createSpan({
      text: "确认只负责创建资源范围；页面脚本是否运行仍由安全只读、本地交互或可信兼容决定。"
    });
    const actions = footer.createDiv({ cls: "html-studio-trust-actions" });
    const cancel = actions.createEl("button", { text: "取消打开" });
    cancel.addEventListener("click", () => this.cancel());
    if (canOfferEntryFolderSafeTrial(this.analysis)) {
      const safeTrial = actions.createEl("button", { text: "先按当前文件夹安全打开" });
      safeTrial.addEventListener("click", () => {
        this.settle("entry-folder-safe");
        this.close();
      });
    }
    const confirm = actions.createEl("button", { cls: "mod-cta", text: "确认这个范围" });
    confirm.addEventListener("click", () => {
      this.settle("requested-scope");
      this.close();
    });
  }

  override onClose(): void {
    this.settle("cancel");
    this.contentEl.empty();
  }

  private buildReasonText(): string {
    const reasons: string[] = [];
    if (this.analysis.scopeRelativePath === "") reasons.push("资源范围触及了整个知识仓库");
    if (this.analysis.climbLevels > 1) reasons.push(`资源跨越了 ${this.analysis.climbLevels} 层目录`);
    if (this.analysis.absoluteReferences.length > 0) reasons.push("页面包含网站根路径");
    if (this.analysis.escapedReferences.length > 0) reasons.push("页面包含尝试离开仓库的地址，这些读取仍会被阻止");
    return reasons.length > 0 ? reasons.join("；") : "资源范围比 HTML 所在文件夹更大";
  }

  private settle(decision: ScopeConfirmationDecision): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveDecision?.(decision);
    this.resolveDecision = null;
  }
}
