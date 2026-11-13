import { ItemView, Menu, Notice, Scope, setIcon, type WorkspaceLeaf } from "obsidian";
import { PageMenu } from "../view/page-menu";
import { LectureEditor } from "./lecture-editor";
import { LECTURE_STYLES, type LectureParagraphStyle } from "./lecture-format";
import type { LectureDraft } from "./lecture-store";
import type { Presenter } from "./presenter";

export const LECTURE_VIEW_TYPE = "html-studio-lecture";

export class LectureView extends ItemView {
  private generation = 0;
  private draft: LectureDraft | null = null;
  private editor: LectureEditor | null = null;
  private pageMenu: PageMenu | null = null;
  private status: HTMLElement | null = null;
  private errorBox: HTMLElement | null = null;
  private closed = false;
  private pageStructure = "";
  private styleButton: HTMLButtonElement | null = null;
  private styleLabel: HTMLElement | null = null;
  private boldButton: HTMLButtonElement | null = null;
  private formatMenu: Menu | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly presenter: Presenter) {
    super(leaf);
    this.scope = new Scope(this.app.scope);
    // Obsidian handles formatting shortcuts before they reach embedded editors.
    this.scope.register(["Mod"], "b", () => {
      if (!this.editor?.view.hasFocus || this.editor.composing) return;
      this.editor.format("bold");
      return false;
    });
  }
  getViewType(): string { return LECTURE_VIEW_TYPE; }
  getDisplayText(): string { return "讲义"; }
  override getIcon(): string { return "notebook-pen"; }

  override async onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.addClass("html-studio-lecture");
    // Obsidian's status bar overlays the bottom of the right sidebar in some themes.
    let statusBar: HTMLElement | null = null;
    let insetFrame: number | null = null;
    const inset = (): void => {
      insetFrame = null;
      const currentBar = this.contentEl.doc.querySelector<HTMLElement>(".status-bar");
      if (currentBar !== statusBar) {
        if (statusBar) observer.unobserve(statusBar);
        statusBar = currentBar;
        if (statusBar) observer.observe(statusBar);
      }
      const view = this.contentEl.getBoundingClientRect();
      const bar = statusBar?.getBoundingClientRect();
      const overlap = bar && bar.width && bar.right > view.left && bar.left < view.right ? Math.max(0, Math.min(bar.height, view.bottom - bar.top)) : 0;
      this.contentEl.style.setProperty("--lecture-bottom-inset", `${overlap}px`);
    };
    // Layout events can fire before a sidebar has moved. Read its final position
    // in the next frame, and rebind if a theme replaced the status bar element.
    const scheduleInset = (): void => {
      if (insetFrame === null) insetFrame = this.contentEl.win.requestAnimationFrame(inset);
    };
    const observer = new ResizeObserver(scheduleInset);
    observer.observe(this.contentEl);
    this.register(() => {
      observer.disconnect();
      if (insetFrame !== null) this.contentEl.win.cancelAnimationFrame(insetFrame);
    });
    this.registerEvent(this.app.workspace.on("layout-change", scheduleInset));
    this.registerEvent(this.app.workspace.on("css-change", scheduleInset));
    // Expanding a sidebar moves this fixed-width view without resizing it.
    // The initial layout event precedes that animation's final position.
    this.registerDomEvent(this.contentEl.doc, "transitionend", event => {
      if ((event.target as Node | null)?.contains?.(this.contentEl)) scheduleInset();
    });
    scheduleInset();
    this.register(this.presenter.subscribe(() => { void this.render(); }));
    await this.render();
  }

  override async onClose(): Promise<void> {
    this.closed = true;
    this.generation += 1;
    const draft = this.draft;
    this.clear();
    if (draft) await this.presenter.notes.save(draft);
  }

  private async render(): Promise<void> {
    if (this.closed) return;
    this.updateStatus();
    // Keep the original page alive until the Chinese input method commits its text.
    if (this.editor?.composing) return;
    const context = this.presenter.lectureContext;
    const source = this.presenter.source?.file;
    const generation = ++this.generation;
    if (!source || !context) {
      if (this.draft) void this.presenter.notes.save(this.draft);
      this.clear();
      this.contentEl.createDiv({ cls: "html-studio-lecture-empty", text: source ? "课件载入后，这里会跟随显示本页讲义。" : "打开 HTML 课件，在这里写下讲述提示。" });
      return;
    }
    try {
      const draft = await this.presenter.notes.open(context, source, this.presenter.notePath);
      if (generation !== this.generation || this.closed) return;
      const structure = JSON.stringify([source.path, context.deck.pages]);
      if (draft === this.draft && this.editor && structure === this.pageStructure) {
        this.editor.setPath(draft.note?.path ?? source.path);
        this.editor.setText(draft.text);
        this.updateStatus();
        return;
      }
      const previous = this.draft;
      this.clear();
      if (previous) void this.presenter.notes.save(previous);
      this.draft = draft;
      this.pageStructure = structure;
      const header = this.contentEl.createDiv({ cls: "html-studio-lecture-header" });
      const heading = header.createDiv({ cls: "html-studio-lecture-heading" });
      heading.createSpan({ text: "本页讲义" });
      this.status = heading.createSpan({ cls: "html-studio-lecture-save", attr: { role: "status", "aria-live": "polite" } });
      this.createIcon(heading, "ellipsis", "讲义选项", event => this.showMenu(event));
      header.createEl("h2", { cls: "html-studio-lecture-slide-title", text: context.deck.pages[draft.page - 1]?.title || "第 " + draft.page + " 页" });
      const formats = header.createDiv({ cls: "html-studio-lecture-formats", attr: { role: "group", "aria-label": "讲义格式" } });
      this.styleButton = formats.createEl("button", { cls: "html-studio-lecture-style", attr: { "aria-label": "段落样式", "aria-haspopup": "menu", "aria-expanded": "false", title: "设置当前段落样式" } });
      this.styleLabel = this.styleButton.createSpan({ text: "正文" });
      setIcon(this.styleButton.createSpan({ cls: "html-studio-dropdown-icon", attr: { "aria-hidden": "true" } }), "chevron-down");
      this.styleButton.addEventListener("click", () => this.showFormatMenu());
      this.styleButton.addEventListener("keydown", event => { if (event.key === "ArrowDown") { event.preventDefault(); this.showFormatMenu(); } });
      formats.createSpan({ cls: "html-studio-format-divider", attr: { "aria-hidden": "true" } });
      this.boldButton = formats.createEl("button", { cls: "html-studio-lecture-bold", text: "加粗", attr: { "aria-pressed": "false", "aria-keyshortcuts": "Meta+B Control+B", title: "加粗；再次点击取消" } });
      this.boldButton.addEventListener("click", () => this.editor?.format("bold"));
      for (const button of [this.styleButton, this.boldButton]) {
        button.addEventListener("mousedown", event => event.preventDefault());
      }
      this.errorBox = this.contentEl.createDiv({ cls: "html-studio-lecture-save-error", attr: { role: "status" } });
      const body = this.contentEl.createDiv({ cls: "html-studio-lecture-body" });
      this.editor = new LectureEditor(body, this.app, this, draft.note?.path ?? source.path, draft.text, draft.page,
        text => this.presenter.notes.change(draft, text), () => { void this.render(); }, () => { void this.presenter.notes.save(draft); }, () => this.updateFormats());
      this.updateFormats();
      this.renderFooter();
      this.updateStatus();
    } catch (error) {
      if (generation !== this.generation) return;
      this.clear();
      const header = this.contentEl.createDiv({ cls: "html-studio-lecture-heading html-studio-lecture-header" });
      header.createSpan({ text: "本页讲义" });
      this.createIcon(header, "ellipsis", "讲义选项", event => this.showMenu(event));
      this.contentEl.createDiv({ cls: "html-studio-lecture-empty", text: error instanceof Error ? error.message : "讲义暂时无法读取，请从右上角打开完整笔记检查。" });
      this.renderFooter();
    }
  }

  private updateFormats(): void {
    const state = this.editor?.getFormatState();
    if (!state) return;
    this.styleLabel?.setText(LECTURE_STYLES[state.style]);
    this.boldButton?.setAttribute("aria-pressed", String(state.bold));
    if (this.styleButton) this.styleButton.disabled = state.disabled;
    if (this.boldButton) this.boldButton.disabled = state.disabled;
  }

  private showFormatMenu(): void {
    const button = this.styleButton, editor = this.editor;
    if (!button || !editor) return;
    if (this.formatMenu) { this.formatMenu.hide(); return; }
    const menu = new Menu().setUseNativeMenu(false);
    this.formatMenu = menu;
    button.setAttribute("aria-expanded", "true");
    const state = editor.getFormatState();
    const icons = { body: "type", heading: "heading", bullet: "list", number: "list-ordered" };
    for (const style of Object.keys(LECTURE_STYLES) as LectureParagraphStyle[]) {
      menu.addItem(item => item.setTitle(LECTURE_STYLES[style]).setIcon(icons[style]).setChecked(state.style === style)
        .onClick(() => editor.format(style)));
    }
    menu.onHide(() => { this.formatMenu = null; button.setAttribute("aria-expanded", "false"); });
    const rect = button.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 }, button.doc);
  }

  private renderFooter(): void {
    const context = this.presenter.lectureContext;
    if (!context) return;
    const nav = this.contentEl.createDiv({ cls: "html-studio-lecture-nav", attr: { "aria-label": "课件页码" } });
    const previous = this.createIcon(nav, "chevron-left", context.manual ? "上一页讲义" : "课件上一页", () => this.presenter.jump(context.deck.current - 1));
    previous.disabled = context.deck.current <= 1;
    const picker = nav.createDiv({ cls: "html-studio-lecture-picker" });
    const input = picker.createEl("input", { type: "text", attr: { "aria-label": context.manual ? "选择讲义页码" : "跳转到课件页码", title: context.manual ? "手动选择讲义页；课件画面保持不变" : "跳转到对应课件页", inputmode: "numeric", autocomplete: "off" } });
    input.value = String(context.deck.current);
    const jump = (): void => {
      const page = Number(input.value);
      if (Number.isSafeInteger(page) && page >= 1 && page <= context.deck.pages.length) this.presenter.jump(page);
      else input.value = String(context.deck.current);
    };
    input.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); jump(); }
      if (event.key === "Escape") input.value = String(context.deck.current);
      if (event.key === "ArrowDown" && !event.isComposing) { event.preventDefault(); open(); }
    });
    input.addEventListener("change", jump);
    picker.createSpan({ text: "/ " + context.deck.pages.length });
    const dropdown = this.createIcon(picker, "chevron-down", "选择课件页面", () => open());
    dropdown.addClass("html-studio-page-toggle");
    dropdown.setAttribute("aria-haspopup", "listbox");
    dropdown.setAttribute("aria-expanded", "false");
    this.pageMenu = new PageMenu(nav, true);
    const open = (): void => this.pageMenu?.open(dropdown, context.deck.pages.map((page, index) => ({ page: index + 1, title: page.title })), context.deck.current, page => this.presenter.jump(page));
    const next = this.createIcon(nav, "chevron-right", context.manual ? "下一页讲义" : "课件下一页", () => this.presenter.jump(context.deck.current + 1));
    next.disabled = context.deck.current >= context.deck.pages.length;
  }

  private updateStatus(): void {
    const draft = this.draft;
    if (!draft) return;
    this.status?.setText(draft.error ? "未保存" : draft.saving ? "保存中…" : draft.dirty ? "待保存" : draft.note ? "已保存" : "自动保存");
    const box = this.errorBox;
    if (!box || box.dataset.message === draft.error) return;
    box.dataset.message = draft.error;
    box.empty();
    box.hidden = !draft.error;
    if (!draft.error) return;
    box.createDiv({ text: draft.error });
    const retry = box.createEl("button", { text: "重试保存" });
    retry.addEventListener("click", () => { void this.presenter.notes.save(draft); });
    const copy = box.createEl("button", { text: "复制草稿" });
    copy.addEventListener("click", () => {
      void this.contentEl.win.navigator.clipboard.writeText(draft.text).then(() => new Notice("草稿已复制。"), () => new Notice("复制失败，请选中正文后复制。"));
    });
  }

  private showMenu(event: MouseEvent): void {
    const source = this.presenter.source?.file;
    if (!source) return;
    const draft = this.draft;
    const menu = new Menu();
    const afterSave = async (action: () => void | Promise<void>): Promise<void> => {
      if (draft) {
        await this.presenter.notes.save(draft);
        if (draft.dirty) { new Notice("本页还有未保存的内容，请先处理保存提示。"); return; }
      }
      await action();
    };
    menu.addItem(item => item.setTitle("关联已有讲义").setIcon("link").onClick(() => afterSave(() => this.presenter.chooseNote(source))));
    if (this.presenter.notePath) {
      menu.addItem(item => item.setTitle("打开完整笔记").setIcon("file-text").onClick(() => this.presenter.editNote()));
      menu.addItem(item => item.setTitle("取消关联，保留笔记").setIcon("unlink").onClick(() => afterSave(() => this.presenter.unlinkNote(source))));
    }
    menu.showAtMouseEvent(event);
  }

  private createIcon(parent: HTMLElement, icon: string, label: string, action: (event: MouseEvent) => void): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label, title: label } });
    setIcon(button, icon);
    button.addEventListener("click", action);
    return button;
  }

  private clear(): void {
    this.formatMenu?.hide();
    this.formatMenu = null;
    this.styleButton = this.boldButton = null;
    this.styleLabel = null;
    this.editor?.destroy();
    this.editor = null;
    this.pageMenu?.destroy();
    this.pageMenu = null;
    this.draft = null;
    this.status = this.errorBox = null;
    this.contentEl.empty();
  }
}
