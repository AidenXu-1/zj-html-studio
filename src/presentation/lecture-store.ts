import { Notice, TFile, TFolder, normalizePath } from "obsidian";
import type HtmlStudioPlugin from "../main";
import type { LectureContext } from "./presenter";
import { createLectureTemplate, lectureEditorText, MAX_LECTURE_NOTE_BYTES, normalizeLectureLinks, parseLectureNote, replaceLectureSection } from "./lecture-note";

export interface LectureDraft {
  source: TFile;
  note: TFile | null;
  page: number;
  title: string;
  base: string | null;
  text: string;
  dirty: boolean;
  saving: boolean;
  error: string;
  revision: number;
  pendingAssociation: boolean;
}
interface Recovery { source: string; note: string | null; page: number; title: string; base: string | null; text: string; pendingAssociation?: boolean }

/** Draft identity is captured when editing; a late save can never target the new slide. */
export class LectureStore {
  private drafts: LectureDraft[] = [];
  private recovered: Recovery[] = [];
  private tail: Promise<void> = Promise.resolve();
  private journal: Promise<void> = Promise.resolve();
  private pendingJournal: Promise<void> | null = null;
  private timers = new Map<LectureDraft, number>();
  private readonly recoveryPath: string;
  private journalUnreadable = false;
  readonly ready: Promise<void>;

  constructor(private readonly plugin: HtmlStudioPlugin, private readonly changed: () => void) {
    this.recoveryPath = normalizePath(`${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}/lecture-drafts.json`);
    this.ready = this.restore();
  }

  async open(context: LectureContext, source: TFile, notePath: string | null): Promise<LectureDraft> {
    await this.ready;
    const vault = this.plugin.app.vault;
    const file = notePath ? vault.getAbstractFileByPath(notePath) : null;
    if (notePath && (!(file instanceof TFile) || file.extension !== "md")) throw new Error("没有找到配套讲义，可在右上角重新关联。");
    let note = file instanceof TFile ? file : null;
    let existing = this.drafts.find(d => d.source === source && (d.note === note || (!note && d.pendingAssociation)) && d.page === context.deck.current);
    if (existing?.dirty || existing?.saving) return existing;
    if (note && note.stat.size > MAX_LECTURE_NOTE_BYTES) throw new Error("讲义较大，请从右上角打开完整笔记编辑。");
    let recovery = this.recovered.find(d => d.source === source.path && (d.note === (note?.path ?? null) || (!note && d.pendingAssociation)) && d.page === context.deck.current);
    if (!note && recovery?.pendingAssociation && recovery.note) {
      const pending = vault.getAbstractFileByPath(recovery.note);
      if (pending instanceof TFile && pending.extension === "md") note = pending;
    }
    const document = note ? await vault.read(note) : "";
    // Several sidebar notifications may read the same page concurrently. Reuse the
    // draft produced by the first read, including its consumed recovery record.
    existing = this.drafts.find(d => d.source === source && d.note === note && d.page === context.deck.current) ?? existing;
    if (existing?.dirty || existing?.saving) return existing;
    if (recovery && !this.recovered.includes(recovery)) recovery = undefined;
    const parsed = parseLectureNote(document);
    const page = context.deck.current;
    if (parsed.duplicatePages.has(page)) throw new Error("这一页存在重复标题，请先打开完整笔记整理。");
    const base = parsed.sections.get(page)?.raw ?? null;
    const draft: LectureDraft = existing ?? { source, note, page, title: context.deck.pages[page - 1]?.title ?? "", base, text: "", dirty: false, saving: false, error: "", revision: 0, pendingAssociation: Boolean(recovery?.pendingAssociation) };
    draft.base = recovery ? recovery.base : base;
    draft.text = recovery ? recovery.text : lectureEditorText(base ?? "");
    draft.dirty = Boolean(recovery);
    if (recovery) {
      draft.error = "已恢复上次未保存的内容，请核对后重试保存。";
      this.recovered = this.recovered.filter(item => item !== recovery);
    }
    if (!existing) this.drafts.push(draft);
    // Retain dirty recovery state, but do not hold every page of every visited course forever.
    this.drafts = this.drafts.filter(item => item !== draft);
    this.drafts.push(draft);
    const clean = this.drafts.filter(item => !item.dirty && !item.saving);
    if (clean.length > 40) {
      const expired = new Set(clean.slice(0, clean.length - 40));
      this.drafts = this.drafts.filter(item => !expired.has(item));
    }
    return draft;
  }

  change(draft: LectureDraft, text: string): void {
    draft.text = text;
    draft.dirty = true;
    draft.error = "";
    draft.revision += 1;
    this.changed();
    void this.persist().catch(() => { draft.error = "草稿暂时无法备份，请保持窗口打开并重试保存。"; this.changed(); });
    const win = this.plugin.app.workspace.containerEl.win;
    const previous = this.timers.get(draft);
    if (previous !== undefined) win.clearTimeout(previous);
    this.timers.set(draft, win.setTimeout(() => { this.timers.delete(draft); void this.save(draft); }, 500));
  }

  save(draft: LectureDraft): Promise<void> {
    const timer = this.timers.get(draft);
    if (timer !== undefined) { this.plugin.app.workspace.containerEl.win.clearTimeout(timer); this.timers.delete(draft); }
    const run = this.tail.then(async () => {
      if (!draft.dirty) return;
      const { text, revision } = draft;
      draft.saving = true;
      this.changed();
      try {
        await this.persist();
        if (Buffer.byteLength(text, "utf8") > MAX_LECTURE_NOTE_BYTES) throw new Error("这一页内容过长，请减少内容后保存。草稿已保留。");
        const vault = this.plugin.app.vault;
        if (vault.getAbstractFileByPath(draft.source.path) !== draft.source) throw new Error("课件已移除，草稿已保留。");
        let linked = this.plugin.settings.lectureNotes?.[draft.source.path] ?? null;
        if (!draft.note && !linked) {
          const pending = this.drafts.find(item => item.source === draft.source && item.pendingAssociation && item.note);
          const recovered = this.recovered.find(item => item.source === draft.source.path && item.pendingAssociation && item.note);
          const note = pending?.note ?? (recovered?.note ? vault.getAbstractFileByPath(recovered.note) : null);
          if (note instanceof TFile && note.extension === "md") { draft.note = note; draft.pendingAssociation = true; }
        }
        if (draft.note && draft.pendingAssociation && (!linked || linked === draft.note.path)) {
          await this.plugin.setLectureAssociation(draft.source.path, draft.note.path);
          draft.pendingAssociation = false;
          linked = draft.note.path;
        }
        if (draft.note && linked !== draft.note.path) throw new Error("讲义关联已改变，原页面草稿已保留。");
        if (!draft.note) {
          if (linked) {
            const note = vault.getAbstractFileByPath(linked);
            if (!(note instanceof TFile) || note.extension !== "md") throw new Error("讲义关联文件不存在，草稿已保留。");
            draft.note = note;
          } else {
            if (!text.trim()) { draft.dirty = draft.revision !== revision; return; }
            // Validate before creating anything. No empty files on mere preview.
            const template = createLectureTemplate(draft.source.name, draft.source.path, []);
            const document = replaceLectureSection(template, draft.page, null, text, draft.title);
            if (Buffer.byteLength(document, "utf8") > MAX_LECTURE_NOTE_BYTES) throw new Error("讲义内容过长，请减少内容后保存。草稿已保留。");
            const folder = "讲义库";
            const found = vault.getAbstractFileByPath(folder);
            if (found && !(found instanceof TFolder)) throw new Error("“讲义库”被同名文件占用，请重命名该文件后重试。");
            if (!found) await vault.createFolder(folder);
            const name = draft.source.basename.replace(/[\\/:*?"<>|]/g, "_").slice(0, 140) + " · 讲义";
            let path = `${folder}/${name}.md`, suffix = 2;
            while (vault.getAbstractFileByPath(path)) path = `${folder}/${name} ${suffix++}.md`;
            draft.note = await vault.create(path, document);
            draft.base = parseLectureNote(document).sections.get(draft.page)?.raw ?? null;
            draft.pendingAssociation = true;
            await this.persist();
            await this.plugin.setLectureAssociation(draft.source.path, draft.note.path);
            draft.pendingAssociation = false;
          }
        }
        const note = draft.note;
        if (!note || vault.getAbstractFileByPath(note.path) !== note) throw new Error("讲义已移除，草稿已保留。");
        if (note.stat.size > MAX_LECTURE_NOTE_BYTES) throw new Error("讲义较大，请打开完整笔记处理；草稿已保留。");
        const saved = await vault.process(note, current => {
          const next = replaceLectureSection(current, draft.page, draft.base, text, draft.title);
          if (Buffer.byteLength(next, "utf8") > MAX_LECTURE_NOTE_BYTES) throw new Error("讲义内容过长，请减少内容后保存。草稿已保留。");
          return next;
        });
        draft.base = parseLectureNote(saved).sections.get(draft.page)?.raw ?? null;
        draft.dirty = draft.revision !== revision;
        draft.error = "";
      } catch (error) {
        draft.error = error instanceof Error ? error.message : "讲义未保存，草稿已保留，请重试。";
        console.error("[ZJ HTML Studio] Lecture save failed", error);
      } finally {
        draft.saving = false;
        await this.persist().catch(() => { draft.error = "保存或备份失败，请保持窗口打开并重试。"; });
        this.changed();
      }
    });
    this.tail = run.catch(error => { console.error("[ZJ HTML Studio] Lecture queue failed", error); });
    return this.tail;
  }

  async flush(): Promise<void> {
    await Promise.all(this.drafts.filter(draft => draft.dirty).map(draft => this.save(draft)));
    await this.journal;
  }

  private persist(): Promise<void> {
    if (this.journalUnreadable) return Promise.reject(new Error("原草稿备份无法读取，已停止写入以保留原文件。请复制当前正文，并检查 lecture-drafts.json。"));
    if (this.pendingJournal) return this.pendingJournal;
    // Keep one in-flight write and at most one pending write. Capture the latest
    // drafts only when that write starts, so slow disks cannot queue full snapshots.
    const operation = this.journal.catch(() => {}).then(() => {
      this.pendingJournal = null;
      const records: Recovery[] = [...this.recovered, ...this.drafts.filter(d => d.dirty).map(d => ({
        source: d.source.path, note: d.note?.path ?? null, page: d.page, title: d.title, base: d.base, text: d.text, pendingAssociation: d.pendingAssociation
      }))];
      return this.plugin.app.vault.adapter.write(this.recoveryPath, JSON.stringify({ version: 1, drafts: records }));
    });
    this.pendingJournal = operation;
    this.journal = operation;
    return operation;
  }

  private async restore(): Promise<void> {
    try {
      const adapter = this.plugin.app.vault.adapter;
      if (!(await adapter.exists(this.recoveryPath))) return;
      const value: unknown = JSON.parse(await adapter.read(this.recoveryPath));
      if (!value || typeof value !== "object" || !("drafts" in value) || !Array.isArray(value.drafts)) throw new Error("Unknown lecture draft format");
      this.recovered = value.drafts.filter((item: unknown): item is Recovery => {
        if (!item || typeof item !== "object") return false;
        const d = item as Partial<Recovery>;
        return typeof d.source === "string" && (d.note === null || typeof d.note === "string")
          && Object.keys(normalizeLectureLinks({ [d.source]: d.note ?? "draft.md" })).length === 1
          && Number.isInteger(d.page) && d.page! >= 1 && d.page! <= 500 && typeof d.title === "string"
          && (d.base === null || typeof d.base === "string") && typeof d.text === "string";
      });
      if (this.recovered.length !== value.drafts.length) throw new Error("Unrecognized lecture draft entries");
      if (this.recovered.length) new Notice("发现未保存的讲义草稿，打开对应课件即可继续编辑。");
    } catch (error) {
      this.journalUnreadable = true;
      console.error("[ZJ HTML Studio] Cannot restore lecture drafts", error);
      new Notice("讲义草稿备份暂时无法读取，请保留插件目录中的 lecture-drafts.json 文件。");
    }
  }
}
