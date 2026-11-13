import { Component, FuzzySuggestModal, Notice, TFile, type WorkspaceLeaf } from "obsidian";
import type HtmlStudioPlugin from "../main";
import type { PreviewMode } from "../settings";
import type { DeckState } from "./deck-state";
import { isDeckPageNumber, sameDeckStructure } from "./deck-state";
import { MAX_LECTURE_NOTE_BYTES, parseLectureNote } from "./lecture-note";
import { LectureView, LECTURE_VIEW_TYPE } from "./lecture-view";
import { ProjectionView, PROJECTION_VIEW_TYPE } from "./projection-view";
import { LectureStore } from "./lecture-store";

export interface PresentationContext {
  resourceFiles?: readonly string[];
  approvedFiles?: readonly string[];
  filePath: string;
  fileName: string;
  sessionId: string;
  documentRevision: string;
  scopeRelativePath: string;
  mode: PreviewMode;
  deck: DeckState;
  picture?: boolean;
}

/** Notes need page titles and numbers, never preview permissions or navigation URLs. */
export interface LectureContext {
  deck: { current: number; pages: { title: string }[] };
  manual?: boolean;
}

export interface PresentationSource {
  readonly leaf: WorkspaceLeaf;
  readonly file: TFile | null;
  getPresentationContext(): PresentationContext | null;
  getLectureContext(): LectureContext | null;
  getProjectionElement?(): HTMLIFrameElement | null;
  capturePresentationContext(): Promise<PresentationContext | null>;
  goToPresentationPage(page: number): boolean;
  updatePresentationControls(): void;
}

export interface ProjectionRecord {
  id: string;
  source: PresentationSource;
  context: PresentationContext;
  leaf: WorkspaceLeaf;
  view: ProjectionView | null;
  ready: boolean;
  acknowledgedPage: number | null;
}

/** Keeps notes in Obsidian and sends only the selected slide to the output view. */
export class Presenter extends Component {
  private readonly sources = new Set<PresentationSource>();
  private readonly listeners = new Set<() => void>();
  private readonly revealedFiles = new WeakMap<PresentationSource, string>();
  private activeSource: PresentationSource | null = null;
  private projection: ProjectionRecord | null = null;
  private starting = false;
  private disposed = false;
  private sequence = 0;
  readonly notes: LectureStore;
  private manualSelection: { source: PresentationSource; path: string; current: number; observed: number } | null = null;
  private manualPages = new Map<string, { key: string; pages: { title: string }[] }>();
  private manualReads = new Map<string, string>();

  constructor(readonly plugin: HtmlStudioPlugin) { super(); this.notes = new LectureStore(plugin, () => this.notify()); }

  override onload(): void {
    this.plugin.registerView(LECTURE_VIEW_TYPE, leaf => new LectureView(leaf, this));
    this.plugin.registerView(PROJECTION_VIEW_TYPE, leaf => new ProjectionView(leaf, this));
    this.registerEvent(this.plugin.app.workspace.on("active-leaf-change", leaf => {
      const source = [...this.sources].find(item => item.leaf === leaf);
      if (source) { this.activeSource = source; this.sourceChanged(source); }
    }));
    this.registerEvent(this.plugin.app.vault.on("modify", file => {
      if (file.path === this.notePath) { if (this.source) void this.refreshManualPages(this.source); this.notify(); }
    }));
    this.registerEvent(this.plugin.app.vault.on("create", file => {
      if (file.path === this.notePath) { if (this.source) void this.refreshManualPages(this.source); this.notify(); }
    }));
    this.registerEvent(this.plugin.app.vault.on("delete", file => {
      if (file.path === this.notePath || this.notePath?.startsWith(`${file.path}/`)) this.notify();
    }));
    this.registerEvent(this.plugin.app.vault.on("rename", (_file, oldPath) => {
      void this.plugin.renameLectureAssociations(oldPath, _file.path).then(() => this.notify(), error => {
        console.error("[ZJ HTML Studio] Lecture association rename failed", error);
        new Notice("讲义关联未能随改名保存，请重新关联这份讲义。");
      });
    }));
    this.plugin.addCommand({
      id: "show-current-lecture",
      name: "Show current slide notes",
      callback: () => { void this.showNotes(); }
    });
    this.plugin.addCommand({
      id: "start-projection",
      name: "Present current HTML in a separate window",
      checkCallback: checking => {
        const source = this.activeSource;
        if (!source?.getPresentationContext()) return false;
        if (!checking) void this.startProjection(source);
        return true;
      }
    });
  }

  override onunload(): void {
    void this.notes.flush().catch(error => console.error("[ZJ HTML Studio] Lecture flush failed", error));
    this.disposed = true;
    this.stopProjection();
    this.listeners.clear();
    this.sources.clear();
  }

  get source(): PresentationSource | null { return this.projection?.source ?? this.activeSource; }
  get context(): PresentationContext | null { return this.source?.getPresentationContext() ?? null; }
  get lectureContext(): LectureContext | null {
    const source = this.source, context = source?.getLectureContext();
    if (!source?.file || !context) return null;
    const manual = source.getPresentationContext()?.deck.canNavigate === false;
    if (!manual) return context;
    const known = source.getPresentationContext()?.deck.adapter;
    const cached = this.manualPages.get(source.file.path);
    const pages = !known && cached?.pages.length ? cached.pages : context.deck.pages;
    const selection = this.manualSelection;
    const current = selection?.source === source && selection.path === source.file.path && selection.observed === context.deck.current
      ? Math.min(selection.current, pages.length) : context.deck.current;
    return { manual: true, deck: { current, pages } };
  }
  get notePath(): string | null {
    const file = this.source?.file;
    return file ? this.plugin.settings.lectureNotes?.[file.path] ?? null : null;
  }
  get output(): ProjectionRecord | null { return this.projection; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  registerSource(source: PresentationSource): () => void {
    this.sources.add(source);
    if (!this.activeSource) this.activeSource = source;
    return () => {
      this.sourceStopped(source);
      this.sources.delete(source);
      if (this.activeSource === source) this.activeSource = null;
      if (this.manualSelection?.source === source) this.manualSelection = null;
      this.notify();
    };
  }

  sourceChanged(source: PresentationSource): void {
    if (this.disposed || !this.sources.has(source)) return;
    let context = source.getPresentationContext();
    if (this.manualSelection?.source === source && this.manualSelection.observed !== source.getLectureContext()?.deck.current) this.manualSelection = null;
    void this.refreshManualPages(source);
    const output = this.projection;
    if (output?.source === source) {
      if (context && output.context.picture) context = { ...context, picture: true };
      if (!context || context.filePath !== output.context.filePath || context.mode !== output.context.mode
        || context.scopeRelativePath !== output.context.scopeRelativePath
        || (!output.context.picture && context.sessionId === output.context.sessionId && !sameDeckStructure(context.deck, output.context.deck))) {
        this.stopProjection();
        new Notice("课件页码或允许范围已改变，投屏已结束。需要时可重新开始。");
      } else {
        const reload = context.sessionId !== output.context.sessionId;
        output.context = context;
        if (reload) {
          output.ready = false;
          output.acknowledgedPage = null;
          void output.view?.loadPresentation(context);
        } else {
          if (!output.context.picture) {
            output.ready = output.acknowledgedPage === context.deck.current;
          }
          output.view?.syncPage(context.deck.current);
        }
      }
    }
    if (this.activeSource === source && source.file) {
      const filePath = source.file.path;
      if (this.plugin.settings.lectureNotes?.[filePath] && this.revealedFiles.get(source) !== filePath) {
        this.revealedFiles.set(source, filePath);
        void this.showNotes(false);
      }
    }
    source.updatePresentationControls();
    this.notify();
  }

  sourceStopped(source: PresentationSource): void {
    if (this.projection?.source === source) this.stopProjection();
    this.revealedFiles.delete(source);
    this.notify();
  }

  async showNotes(focus = true, source?: PresentationSource): Promise<void> {
    if (source && !this.projection) this.activeSource = source;
    try {
      await this.plugin.app.workspace.ensureSideLeaf(LECTURE_VIEW_TYPE, "right", { active: focus, reveal: true });
      if (this.source) await this.refreshManualPages(this.source);
      this.notify();
    } catch (error) {
      console.error("[ZJ HTML Studio] Cannot show lecture sidebar", error);
      new Notice("讲义侧栏暂时无法打开，请稍后再试。");
    }
  }

  jump(page: number): void {
    const source = this.source;
    const lecture = this.lectureContext;
    if (source?.file && lecture?.manual && isDeckPageNumber(page, lecture.deck.pages.length)) {
      this.manualSelection = { source, path: source.file.path, current: page, observed: source.getLectureContext()?.deck.current ?? 1 };
      this.notify();
      return;
    }
    const context = source?.getPresentationContext();
    if (!context || !isDeckPageNumber(page, context.deck.pages.length)) return;
    if (!source?.goToPresentationPage(page)) new Notice("课件正在更新，请稍后再翻页。");
  }

  chooseNote(source = this.source?.file): void {
    if (!source) { new Notice("请先打开一份 HTML 课件。"); return; }
    new LectureNotePicker(this.plugin, file => {
      if (this.plugin.app.vault.getAbstractFileByPath(source.path) !== source) {
        new Notice("原课件已移除，本次未更改讲义关联。"); return;
      }
      void this.plugin.setLectureAssociation(source.path, file.path).then(async () => {
        this.manualSelection = null;
        this.manualPages.delete(source.path);
        await Promise.all([...this.sources].filter(item => item.file === source).map(item => this.refreshManualPages(item)));
        this.notify();
      }, error => {
        console.error("[ZJ HTML Studio] Cannot associate lecture note", error);
        new Notice("没有保存讲义关联，请稍后再试。");
      });
    }).open();
  }

  async editNote(): Promise<void> {
    const notePath = this.notePath;
    const page = this.lectureContext?.deck.current;
    if (!notePath) return;
    const file = this.plugin.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile) || file.extension !== "md") { new Notice("讲义笔记没有找到，请重新关联。"); return; }
    try {
      let line = 0;
      if (file.stat.size <= MAX_LECTURE_NOTE_BYTES && page) {
        line = parseLectureNote(await this.plugin.app.vault.cachedRead(file)).sections.get(page)?.line ?? 0;
      }
      const leaf = this.plugin.app.workspace.getLeaf("tab");
      await leaf.openFile(file, { active: true, state: { mode: "source" }, eState: { line, focus: true } });
    } catch (error) {
      console.error("[ZJ HTML Studio] Cannot open lecture editor", error);
      new Notice("讲义暂时无法打开，请从文件列表重试。");
    }
  }

  async unlinkNote(source = this.source?.file): Promise<void> {
    if (!source) return;
    if (this.plugin.app.vault.getAbstractFileByPath(source.path) !== source) {
      new Notice("原课件已移除，本次未更改讲义关联。"); return;
    }
    try {
      await this.plugin.setLectureAssociation(source.path, null);
      this.manualPages.delete(source.path);
      if (this.manualSelection?.path === source.path) this.manualSelection = null;
      this.notify();
      new Notice("已取消关联，讲义笔记保留。");
    } catch (error) {
      console.error("[ZJ HTML Studio] Cannot unlink lecture note", error);
      new Notice("没有保存关联更改，请稍后再试。");
    }
  }

  async startProjection(source: PresentationSource): Promise<void> {
    if (this.disposed || this.starting) return;
    if (this.projection) {
      if (this.projection.source !== source) {
        new Notice("另一份课件正在投屏，请先结束那次投屏。");
      } else this.projection.view?.focusWindow();
      return;
    }
    this.starting = true;
    let record: ProjectionRecord | null = null;
    try {
      const context = await source.capturePresentationContext();
      if (!context || this.disposed || !this.sources.has(source)) {
        new Notice("课件还没有加载完成，请待画面显示后再投屏。");
        return;
      }
      const leaf = this.plugin.app.workspace.openPopoutLeaf({ size: { width: 1100, height: 700 } });
      leaf.setPinned(true);
      record = { id: `projection-${++this.sequence}`, source, context, leaf, view: null, ready: false, acknowledgedPage: null };
      this.projection = record;
      // Obsidian returns the leaf before its DOM has moved into the new window.
      // Bind the view's message/fullscreen listeners only after that move.
      await this.waitForProjectionWindow(record);
      if (this.projection !== record || this.disposed) return;
      await leaf.setViewState({ type: PROJECTION_VIEW_TYPE, state: { id: record.id }, active: true });
      if (this.projection !== record) return;
      source.updatePresentationControls();
      this.notify();
      if (this.notePath) await this.showNotes(false);
    } catch (error) {
      if (record && this.projection === record) this.stopProjection();
      console.error("[ZJ HTML Studio] Cannot start projection", error);
      new Notice("投屏未能打开，本机课件可以继续使用。请稍后再试。");
    } finally { this.starting = false; }
  }

  attachProjection(id: string, view: ProjectionView): ProjectionRecord | null {
    const record = this.projection;
    if (!record || record.id !== id || record.leaf !== view.leaf) return null;
    record.view = view;
    return record;
  }

  acknowledgeProjection(view: ProjectionView, page: number): void {
    const record = this.projection;
    if (!record || record.view !== view) return;
    if (record.ready && record.acknowledgedPage === page) return;
    record.acknowledgedPage = page;
    record.ready = Boolean(record.context.picture) || page === record.context.deck.current;
    record.source.updatePresentationControls();
    this.notify();
  }

  projectionClosed(view: ProjectionView): void {
    const record = this.projection;
    if (!record || record.view !== view) return;
    this.projection = null;
    record.source.updatePresentationControls();
    this.notify();
  }

  projectionFailed(view: ProjectionView, reason?: "document-changed"): void {
    if (this.projection?.view !== view) return;
    this.stopProjection();
    new Notice(reason === "document-changed"
      ? "课件文件已修改，请先刷新本机课件再投屏。当前画面和页码已保留。"
      : "投屏连接未能保持同步，已结束投屏。本机仍停在当前页，可以重新开始。");
  }

  stopProjection(): void {
    const record = this.projection;
    if (!record) return;
    this.projection = null;
    record.view?.stop();
    record.leaf.detach();
    const sourceWindow = record.source.leaf.view.containerEl.win;
    if (!sourceWindow.closed) sourceWindow.focus();
    record.source.updatePresentationControls();
    this.notify();
  }

  private async waitForProjectionWindow(record: ProjectionRecord): Promise<void> {
    const mainWindow = this.plugin.app.workspace.containerEl.win;
    const deadline = Date.now() + 10_000;
    while (this.projection === record && !this.disposed) {
      const element = record.leaf.view.containerEl;
      if (element.isConnected && element.win !== mainWindow) return;
      if (Date.now() >= deadline) throw new Error("Projection window did not become available");
      await new Promise<void>(resolve => mainWindow.setTimeout(resolve, 50));
    }
  }

  private async refreshManualPages(source: PresentationSource): Promise<void> {
    const path = source.file?.path;
    if (!path) return;
    const notePath = this.plugin.settings.lectureNotes?.[path];
    const file = notePath ? this.plugin.app.vault.getAbstractFileByPath(notePath) : null;
    if (!(file instanceof TFile) || file.stat.size > MAX_LECTURE_NOTE_BYTES) {
      if (this.manualPages.delete(path)) this.notify();
      return;
    }
    const key = `${file.path}:${file.stat.mtime}:${file.stat.size}`;
    if (this.manualPages.get(path)?.key === key || this.manualReads.get(path) === key) return;
    this.manualReads.set(path, key);
    try {
      const parsed = parseLectureNote(await this.plugin.app.vault.cachedRead(file));
      if (this.disposed || this.manualReads.get(path) !== key || this.plugin.settings.lectureNotes?.[path] !== file.path) return;
      const total = Math.min(500, Math.max(1, ...parsed.sections.keys()));
      const pages = Array.from({ length: total }, (_, index) => ({ title: parsed.sections.get(index + 1)?.title ?? `第 ${index + 1} 页` }));
      this.manualPages.set(path, { key, pages });
      this.notify();
    } catch (error) { console.error("[ZJ HTML Studio] Cannot read manual lecture index", error); }
    finally { if (this.manualReads.get(path) === key) this.manualReads.delete(path); }
  }

  private notify(): void { this.listeners.forEach(listener => listener()); }
}

class LectureNotePicker extends FuzzySuggestModal<TFile> {
  constructor(private readonly plugin: HtmlStudioPlugin, private readonly choose: (file: TFile) => void) {
    super(plugin.app);
    this.setPlaceholder("选择配套讲义笔记");
    this.setInstructions([{ command: "↑↓", purpose: "选择笔记" }, { command: "Enter", purpose: "关联讲义" }]);
  }
  getItems(): TFile[] { return this.plugin.app.vault.getMarkdownFiles(); }
  getItemText(file: TFile): string { return file.path; }
  onChooseItem(file: TFile): void { this.choose(file); }
}
