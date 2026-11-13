import { describe, expect, it, vi } from "vitest";
import { TFile, type WorkspaceLeaf } from "obsidian";
import { LectureView } from "../src/presentation/lecture-view";
import type { LectureDraft } from "../src/presentation/lecture-store";
import type { Presenter } from "../src/presentation/presenter";

const menus = vi.hoisted(() => [] as { title: string; click?: () => Promise<void> }[][]);
vi.mock("obsidian", () => ({
  TFile: class {},
  ItemView: class { app = { scope: {} }; }, Scope: class { register() {} }, Notice: class {},
  Menu: class {
    items: { title: string; click?: () => Promise<void> }[] = [];
    constructor() { menus.push(this.items); }
    addItem(callback: (item: unknown) => void) {
      const row: { title: string; click?: () => Promise<void> } = { title: "" };
      const item = {
        setTitle: (title: string) => { row.title = title; return item; },
        setIcon: () => item,
        onClick: (click: () => Promise<void>) => { row.click = click; return item; }
      };
      callback(item); this.items.push(row); return this;
    }
    showAtMouseEvent() {}
  }
}));
vi.mock("../src/presentation/lecture-editor", () => ({ LectureEditor: class {} }));

describe("lecture association action identity", () => {
  it.each(["switch", "close"])("keeps the original target when the sidebar changes during saving: %s", async change => {
    const first = Object.assign(new TFile(), { path: "A.html" }), second = Object.assign(new TFile(), { path: "B.html" });
    const draft = { source: first, dirty: true } as LectureDraft;
    let active = first, release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const links: Record<string, string> = { "A.html": "A.md", "B.html": "B.md" };
    const presenter = {
      get source() { return { file: active }; },
      get notePath() { return links[active.path]; },
      notes: { save: async () => { await pending; draft.dirty = false; } },
      unlinkNote: async (target: TFile = active) => { delete links[target.path]; }
    } as unknown as Presenter;
    const view = new LectureView({} as WorkspaceLeaf, presenter);
    const state = view as unknown as { draft: LectureDraft | null; showMenu(event: MouseEvent): void };
    state.draft = draft;
    state.showMenu({} as MouseEvent);
    const action = menus.at(-1)!.find(item => item.title === "取消关联，保留笔记")!.click!();
    active = second;
    state.draft = change === "switch" ? { source: second, dirty: false } as LectureDraft : null;
    release(); await action;
    expect(links).toEqual({ "B.html": "B.md" });
  });
});
