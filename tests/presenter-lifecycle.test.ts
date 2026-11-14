import { describe, expect, it, vi } from "vitest";
import type HtmlStudioPlugin from "../src/main";
import { Presenter, type PresentationSource } from "../src/presentation/presenter";

vi.mock("obsidian", () => ({
  Component: class {}, FuzzySuggestModal: class {}, TFile: class {}, TFolder: class {}, Notice: class {}, normalizePath: (path: string) => path
}));
vi.mock("../src/presentation/lecture-view", () => ({ LECTURE_VIEW_TYPE: "lecture", LectureView: class {} }));
vi.mock("../src/presentation/projection-view", () => ({ PROJECTION_VIEW_TYPE: "projection", ProjectionView: class {} }));

function fixture() {
  const plugin = {
    manifest: { id: "zj-html-studio" }, settings: { lectureNotes: {} },
    app: { vault: { configDir: ".test-config", adapter: { exists: async () => false } } }
  } as unknown as HtmlStudioPlugin;
  const presenter = new Presenter(plugin);
  const source = (): PresentationSource => ({
    file: { path: "manual.html" },
    getPresentationContext: () => ({ deck: { current: 1, canNavigate: false } }),
    getLectureContext: () => ({ deck: { current: 1, pages: [{ title: "One" }, { title: "Two" }] } }),
    updatePresentationControls: () => {}
  }) as unknown as PresentationSource;
  const retained = () => (presenter as unknown as { manualSelection: { source: PresentationSource } | null }).manualSelection;
  return { presenter, source, retained };
}

describe("manual lecture selection lifecycle", () => {
  it("releases the selected preview when its source is closed", () => {
    const { presenter, source, retained } = fixture();
    const current = source();
    const close = presenter.registerSource(current);
    presenter.jump(2);
    expect(presenter.lectureContext?.deck.current).toBe(2);
    expect(retained()?.source).toBe(current);
    close();
    expect(presenter.source).toBeNull();
    expect(retained()).toBeNull();
  });

  it("keeps the active manual selection when a different preview closes", () => {
    const { presenter, source, retained } = fixture();
    const current = source();
    presenter.registerSource(current);
    const closeOther = presenter.registerSource(source());
    presenter.jump(2);
    closeOther();
    expect(retained()?.source).toBe(current);
    expect(presenter.lectureContext?.deck.current).toBe(2);
  });
});
