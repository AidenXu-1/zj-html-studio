import { describe, expect, it, vi } from "vitest";
import { TFile, TFolder } from "obsidian";
import type HtmlStudioPlugin from "../src/main";
import { LectureStore } from "../src/presentation/lecture-store";

vi.mock("obsidian", () => ({
  TFile: class {}, TFolder: class {}, Notice: class {}, normalizePath: (path: string) => path
}));

function fixture() {
  const file = (path: string): TFile => Object.assign(new TFile(), {
    path, name: path.split("/").at(-1)!, basename: path.split("/").at(-1)!.replace(/\.[^.]+$/, ""),
    extension: path.split(".").at(-1)!, stat: { size: 0, ctime: 0, mtime: 0 }
  });
  const source = file("course.html");
  const files = new Map<string, TFile | TFolder>([[source.path, source]]);
  const documents = new Map<string, string>();
  const links: Record<string, string> = {};
  const adapter = {
    exists: async () => false,
    write: vi.fn(async (path: string, text: string) => { documents.set(path, text); })
  };
  const vault = {
    configDir: "custom-config", adapter,
    getAbstractFileByPath: (path: string) => files.get(path) ?? null,
    read: async (note: TFile) => documents.get(note.path) ?? "",
    createFolder: async (path: string) => { files.set(path, Object.assign(new TFolder(), { path })); },
    create: async (path: string, text: string) => {
      const note = file(path); files.set(path, note); documents.set(path, text); return note;
    },
    process: async (note: TFile, update: (text: string) => string) => {
      const next = update(documents.get(note.path) ?? ""); documents.set(note.path, next); return next;
    }
  };
  const plugin = {
    manifest: { id: "zj-html-studio" }, settings: { lectureNotes: links },
    app: { vault, workspace: { containerEl: { win: { setTimeout: () => 1, clearTimeout: () => {} } } } },
    setLectureAssociation: async (source: string, note: string) => { links[source] = note; }
  } as unknown as HtmlStudioPlugin;
  const store = new LectureStore(plugin, () => {});
  const context = { deck: { current: 1, pages: [{ title: "Course" }] } };
  return { store, source, context, adapter, documents, links };
}

describe("lecture first-save timing", () => {
  it("coalesces edits during a slow backup and writes the latest draft next", async () => {
    const f = fixture();
    const draft = await f.store.open(f.context, f.source, null);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.adapter.write.mockImplementationOnce(async (path, text) => {
      await gate; f.documents.set(path, text);
    });
    f.store.change(draft, "first draft");
    await vi.waitFor(() => expect(f.adapter.write).toHaveBeenCalledTimes(1));
    for (let i = 1; i <= 100; i++) f.store.change(draft, `${"正文".repeat(32_768)} EDIT-${i}`);
    release();
    await vi.waitFor(() => expect(f.documents.get("custom-config/plugins/zj-html-studio/lecture-drafts.json")).toContain("EDIT-100"));
    expect(f.adapter.write).toHaveBeenCalledTimes(2);
  });

  it("waits for pending edits on flush and saves both pages without losing the latest text", async () => {
    const f = fixture();
    const first = await f.store.open(f.context, f.source, null);
    const second = await f.store.open({ deck: { current: 2, pages: [{ title: "One" }, { title: "Two" }] } }, f.source, null);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.adapter.write.mockImplementationOnce(async (path, text) => {
      await gate; f.documents.set(path, text);
    });
    f.store.change(first, "old");
    await vi.waitFor(() => expect(f.adapter.write).toHaveBeenCalledTimes(1));
    f.store.change(first, "第一页最新内容");
    f.store.change(second, "第二页最新内容");
    let flushed = false;
    const pending = f.store.flush().then(() => { flushed = true; });
    await vi.waitFor(() => expect(first.saving).toBe(true));
    expect(flushed).toBe(false);
    release(); await pending;
    const note = f.documents.get(f.links[f.source.path]!);
    expect(note).toContain("第一页最新内容");
    expect(note).toContain("第二页最新内容");
    expect(first.dirty || second.dirty).toBe(false);
    expect(JSON.parse(f.documents.get("custom-config/plugins/zj-html-studio/lecture-drafts.json")!)).toEqual({ version: 1, drafts: [] });
  });

  it("retries the latest pending backup after the in-flight write fails", async () => {
    const f = fixture();
    const draft = await f.store.open(f.context, f.source, null);
    let fail!: () => void;
    const gate = new Promise<void>((_, reject) => { fail = () => reject(new Error("slow disk write failed")); });
    f.adapter.write.mockImplementationOnce(async () => { await gate; });
    f.store.change(draft, "old");
    await vi.waitFor(() => expect(f.adapter.write).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 50; i++) f.store.change(draft, `latest-${i}`);
    fail();
    await vi.waitFor(() => expect(f.documents.get("custom-config/plugins/zj-html-studio/lecture-drafts.json")).toContain("latest-49"));
    expect(f.adapter.write).toHaveBeenCalledTimes(2);
    await f.store.flush();
    expect(draft.error).toBe("");
    expect(f.documents.get(f.links[f.source.path]!)).toContain("latest-49");
  });

  it("keeps text typed while a blank first save is waiting, including its recovery copy", async () => {
    const f = fixture();
    const draft = await f.store.open(f.context, f.source, null);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.adapter.write.mockImplementationOnce(async (path, text) => {
      await gate; f.documents.set(path, text);
    });
    f.store.change(draft, " ");
    const pending = f.store.save(draft);
    await vi.waitFor(() => expect(draft.saving).toBe(true));
    f.store.change(draft, "需要保留的真实讲义");
    release(); await pending;
    expect(draft.dirty).toBe(true);
    expect(f.documents.get("custom-config/plugins/zj-html-studio/lecture-drafts.json")).toContain("需要保留的真实讲义");
    expect((await f.store.open(f.context, f.source, null)).text).toBe("需要保留的真实讲义");
    await f.store.save(draft);
    expect(draft.dirty).toBe(false);
    expect(f.documents.get(f.links[f.source.path]!)).toContain("需要保留的真实讲义");
    expect([...f.documents.keys()].filter(path => path.endsWith(".md"))).toHaveLength(1);
  });

  it("does not create an empty note when the blank draft has not changed", async () => {
    const f = fixture();
    const draft = await f.store.open(f.context, f.source, null);
    f.store.change(draft, " \n "); await f.store.save(draft);
    expect(draft.dirty).toBe(false);
    expect(f.links).toEqual({});
    expect([...f.documents.keys()].filter(path => path.endsWith(".md"))).toEqual([]);
  });
});
