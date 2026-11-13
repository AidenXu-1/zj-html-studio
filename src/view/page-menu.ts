/** A bounded page list shared by search and the lecture footer. */
export class PageMenu {
  readonly element: HTMLElement;
  private active = 0;
  private rows: HTMLButtonElement[] = [];
  private trigger: HTMLElement | null = null;
  private onOutside = (event: Event): void => {
    if (!event.composedPath().includes(this.element) && !event.composedPath().includes(this.trigger!)) this.close();
  };

  constructor(parent: HTMLElement, above = false) {
    this.element = parent.createDiv({ cls: `html-studio-page-menu${above ? " is-above" : ""}`, attr: { role: "listbox", "aria-label": "选择页面" } });
    this.element.hidden = true;
    this.element.addEventListener("keydown", event => {
      if (event.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); this.close(); this.trigger?.focus(); }
      const next = event.key === "ArrowDown" ? this.active + 1 : event.key === "ArrowUp" ? this.active - 1
        : event.key === "Home" ? 0 : event.key === "End" ? this.rows.length - 1 : null;
      if (next !== null) { event.preventDefault(); this.active = Math.max(0, Math.min(this.rows.length - 1, next)); this.rows[this.active]?.focus(); }
    });
    parent.doc.addEventListener("pointerdown", this.onOutside, true);
  }

  open(trigger: HTMLElement, pages: readonly { page: number; title: string }[], current: number, choose: (page: number) => void): void {
    if (!this.element.hidden) { this.close(); return; }
    this.trigger = trigger;
    trigger.setAttribute("aria-expanded", "true");
    this.element.empty();
    this.rows = pages.map(({ page, title }) => {
      const row = this.element.createEl("button", { cls: "html-studio-page-option", attr: { role: "option", "aria-selected": String(page === current), title: `第 ${page} 页 · ${title}` } });
      row.createSpan({ cls: "html-studio-page-number", text: String(page) });
      row.createSpan({ text: title || `第 ${page} 页` });
      row.addEventListener("focus", () => { this.active = this.rows.indexOf(row); });
      row.addEventListener("click", () => { this.close(); trigger.focus(); choose(page); });
      return row;
    });
    this.element.hidden = false;
    this.active = Math.max(0, pages.findIndex(item => item.page === current));
    this.rows[this.active]?.focus();
    this.rows[this.active]?.scrollIntoView({ block: "nearest" });
  }

  close(): void { this.element.hidden = true; this.trigger?.setAttribute("aria-expanded", "false"); }
  destroy(): void { this.element.doc.removeEventListener("pointerdown", this.onOutside, true); this.element.remove(); }
}
