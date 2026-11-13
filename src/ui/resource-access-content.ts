import { setIcon } from "obsidian";

export function renderResourceFilename(parent: HTMLElement, path: string): void {
  parent.createDiv({ cls: "html-studio-resource-filename", text: path.split("/").pop() ?? path, attr: { title: path } });
}

export function renderResourceRange(parent: HTMLElement, path: string): void {
  const row = parent.createDiv({ cls: "html-studio-resource-range" });
  setIcon(row.createSpan({ cls: "html-studio-resource-icon", attr: { "aria-hidden": "true" } }), "folder");
  const copy = row.createDiv();
  copy.createSpan({ text: "若允许，可读取" });
  copy.createEl("strong", { text: path.split("/").filter(Boolean).pop() || "整个知识库", attr: { title: path || "整个知识库" } });
  parent.createEl("p", { cls: "html-studio-resource-note", text: "也包括这个范围内的其他笔记和附件。" });
}

export function renderResourceDetails(parent: HTMLElement, fields: readonly { label: string; path: string }[], reasons: readonly string[]): void {
  const details = parent.createEl("details", { cls: "html-studio-resource-details" });
  const summary = details.createEl("summary");
  setIcon(summary.createSpan({ cls: "html-studio-dropdown-icon", attr: { "aria-hidden": "true" } }), "chevron-right");
  summary.createSpan({ text: "查看请求详情" });
  const body = details.createDiv({ cls: "html-studio-resource-detail-body" });
  for (const field of fields) {
    body.createEl("strong", { text: field.label });
    body.createEl("p", { text: field.path || "整个知识库" });
  }
  if (reasons.length) {
    body.createEl("strong", { text: "请求原因" });
    for (const reason of reasons) body.createEl("p", { text: reason });
  }
  body.createEl("p", { text: "联网、剪贴板等权限保持原设置。" });
}
