import { Modal, type App } from "obsidian";
import type { ScopeAnalysis } from "../scope/dependency-analyzer";
import { getHtmlPermissionScopePath } from "../settings";
import { renderResourceDetails, renderResourceFilename, renderResourceRange } from "./resource-access-content";
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
    this.modalEl.addClass("html-studio-access-modal", "html-studio-resource-modal");
    this.setTitle("打开前确认文件访问");
    const canPreview = canOfferEntryFolderSafeTrial(this.analysis);
    const entryFolder = getHtmlPermissionScopePath(this.analysis.entryRelativePath);
    const body = this.contentEl.createDiv({ cls: "html-studio-resource-body" });
    renderResourceFilename(body, this.analysis.entryRelativePath);
    const incomplete = !this.analysis.dependencyScopeAnalysis.complete;
    body.createEl("p", { cls: "html-studio-access-intro", text: incomplete
      ? this.analysis.dependencyScopeAnalysis.reason === "file-too-large"
        ? "这份 HTML 较大，尚未确认全部配套文件的位置。"
        : "页面内容较多，尚未确认全部配套文件的位置。"
      : !entryFolder
        ? "这份 HTML 位于知识库最外层，读取范围覆盖整个知识库。"
        : this.analysis.scopeRelativePath !== entryFolder
          ? "页面引用了所在文件夹之外的图片、样式或其他文件。"
          : "请确认这份页面可以读取的文件夹。" });
    renderResourceRange(body, this.analysis.scopeRelativePath);
    renderResourceDetails(body, [
      { label: "HTML 文件", path: this.analysis.entryRelativePath },
      { label: "当前文件夹", path: entryFolder },
      { label: "请求读取的范围", path: this.analysis.scopeRelativePath }
    ], this.buildReasons());

    const footer = this.contentEl.createDiv({ cls: "html-studio-resource-footer" });
    footer.createEl("p", { cls: "html-studio-resource-hint", text: canPreview
      ? "先预览只读取当前文件夹，页面交互暂不启用。"
      : "仅对本次打开有效，页面现有功能权限保持不变。" });
    const actions = footer.createDiv({ cls: "html-studio-access-actions" });
    const cancel = actions.createEl("button", { text: "取消", cls: "html-studio-resource-cancel" });
    cancel.addEventListener("click", () => this.cancel());
    const confirm = actions.createEl("button", { cls: canPreview ? "" : "mod-cta", text: "允许并打开" });
    confirm.addEventListener("click", () => {
      this.settle("requested-scope");
      this.close();
    });
    if (canPreview) {
      const safeTrial = actions.createEl("button", { text: "先预览", cls: "mod-cta" });
      safeTrial.addEventListener("click", () => {
        this.settle("entry-folder-safe");
        this.close();
      });
    }
  }

  override onClose(): void {
    this.settle("cancel");
    this.contentEl.empty();
  }

  private buildReasons(): string[] {
    const reasons: string[] = [];
    if (!this.analysis.dependencyScopeAnalysis.complete) {
      reasons.push("文件分析尚未完成，更大的读取范围不代表已经确认需要全部文件。");
    } else if (this.analysis.climbLevels > 0) {
      reasons.push("配套文件分布在当前文件夹之外，因此读取范围包含它们共同所在的文件夹。");
    }
    if (this.analysis.absoluteReferences.length > 0) reasons.push("页面使用了从网站根目录开始的文件地址。");
    if (this.analysis.escapedReferences.length > 0) reasons.push("指向知识库外的文件仍无法读取。");
    return reasons;
  }

  private settle(decision: ScopeConfirmationDecision): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveDecision?.(decision);
    this.resolveDecision = null;
  }
}
