import { Component, MarkdownRenderer, type App } from "obsidian";
import { EditorState, StateEffect, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, placeholder, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, insertNewlineContinueMarkupCommand, deleteMarkupBackward } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { lectureFormatState, setLectureParagraph, toggleLectureBold, type LectureParagraphStyle } from "./lecture-format";

const focusChanged = StateEffect.define<boolean>();
const focused = StateField.define({ create: () => false, update: (value, transaction) => {
  for (const effect of transaction.effects) if (effect.is(focusChanged)) value = effect.value;
  return value;
} });
const renderedComponents = new WeakMap<HTMLElement, Component>();

/** Render inactive blocks, edit the original Markdown at the caret. No HTML round trip. */
class MarkdownBlock extends WidgetType {
  constructor(private readonly app: App, private readonly owner: Component, private readonly path: string, private readonly text: string, private readonly from: number) { super(); }
  override eq(other: MarkdownBlock): boolean { return this.text === other.text && this.from === other.from && this.path === other.path; }
  toDOM(view: EditorView): HTMLElement {
    // Global createDiv is detached; adopt it so pop-out editors own their widgets.
    const element = view.dom.doc.adoptNode(createDiv({ cls: "html-studio-lecture-block markdown-rendered" }));
    const component = this.owner.addChild(new Component());
    renderedComponents.set(element, component);
    void MarkdownRenderer.render(this.app, this.text, element, this.path, component).then(() => {
      if (element.isConnected) view.requestMeasure();
    }, error => {
      console.error("[ZJ HTML Studio] Lecture block render failed", error);
      element.setText(this.text);
    });
    element.addEventListener("mousedown", event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      view.dispatch({ selection: { anchor: this.from }, effects: focusChanged.of(true) });
      view.focus();
    });
    return element;
  }
  override ignoreEvent(): boolean { return true; }
  override destroy(element: HTMLElement): void {
    const component = renderedComponents.get(element);
    if (component) this.owner.removeChild(component);
    renderedComponents.delete(element);
  }
}

export class LectureEditor {
  readonly view: EditorView;
  private updating = false;
  constructor(parent: HTMLElement, app: App, owner: Component, private path: string, text: string, page: number, onChange: (text: string) => void, onCompositionEnd: () => void, onBlur: () => void, onFormatChange: () => void = () => {}) {
    const decorate = (state: EditorState): DecorationSet => {
      const ranges: Range<Decoration>[] = [];
      const active = state.field(focused);
      let count = 0;
      for (let node = syntaxTree(state).topNode.firstChild; node && count++ < 1_000; node = node.nextSibling) {
        const editing = active && state.selection.ranges.some(range => range.from <= node.to && range.to >= node.from);
        if (!editing && node.to > node.from) ranges.push(Decoration.replace({
          widget: new MarkdownBlock(app, owner, this.path, state.sliceDoc(node.from, node.to), node.from), block: true
        }).range(node.from, node.to));
      }
      return Decoration.set(ranges, true);
    };
    const blocks = StateField.define<DecorationSet>({ create: decorate, update: (_value, transaction) => decorate(transaction.state), provide: field => EditorView.decorations.from(field) });
    this.view = new EditorView({ parent, root: parent.doc, state: EditorState.create({ doc: text, extensions: [
      markdown({ addKeymap: false }), history(), keymap.of([
        { key: "Mod-b", run: () => { this.format("bold"); return true; } },
        { key: "Enter", run: insertNewlineContinueMarkupCommand({ nonTightLists: false }) },
        { key: "Backspace", run: deleteMarkupBackward }, ...defaultKeymap, ...historyKeymap
      ]), EditorView.lineWrapping,
      focused, blocks, placeholder("写下这一页的讲述提示…"),
      EditorView.contentAttributes.of({ "aria-label": `第 ${page} 页讲义`, "aria-multiline": "true", spellcheck: "false" }),
      EditorView.updateListener.of(update => {
        if (update.docChanged && !this.updating) onChange(update.state.doc.toString());
        if (update.docChanged || update.selectionSet || update.focusChanged) onFormatChange();
      }),
      EditorView.domEventHandlers({
        focus: (_event, view) => { view.dispatch({ effects: focusChanged.of(true) }); },
        blur: (_event, view) => { view.dispatch({ effects: focusChanged.of(false) }); onBlur(); },
        compositionend: () => { parent.win.setTimeout(onCompositionEnd, 0); }
      })
    ] }) });
  }

  get composing(): boolean { return this.view.composing; }
  setPath(path: string): void {
    if (path === this.path) return;
    this.path = path;
    this.view.dispatch({});
  }
  setText(text: string): void {
    if (this.view.state.doc.toString() === text) return;
    this.updating = true;
    try { this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } }); }
    finally { this.updating = false; }
  }
  getFormatState(): ReturnType<typeof lectureFormatState> { return lectureFormatState(this.view.state); }
  format(kind: "bold" | LectureParagraphStyle): void {
    if (this.view.composing) return;
    this.view.dispatch(kind === "bold" ? toggleLectureBold(this.view.state) : setLectureParagraph(this.view.state, kind));
    this.view.focus();
  }
  destroy(): void { this.view.destroy(); }
}
