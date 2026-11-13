import { type ChangeSpec, type EditorState, type TransactionSpec } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

export type LectureParagraphStyle = "body" | "heading" | "bullet" | "number";
export const LECTURE_STYLES = { body: "正文", heading: "小标题", bullet: "项目列表", number: "编号列表" } as const;

function lineStyle(text: string): { style: LectureParagraphStyle; indent: string; prefix: string } {
  const match = /^( {0,3})(#{1,6}[\t ]+|[-+*][\t ]+|\d+[.)][\t ]+)/.exec(text);
  const prefix = match?.[2] ?? "";
  return { style: prefix.startsWith("#") ? "heading" : /^\d/.test(prefix) ? "number" : prefix ? "bullet" : "body", indent: match?.[1] ?? /^ {0,3}/.exec(text)![0], prefix };
}

function insideCode(state: EditorState, position: number): boolean {
  for (let node = syntaxTree(state).resolveInner(position, 1); node; node = node.parent!) {
    if (["FencedCode", "CodeBlock", "InlineCode"].includes(node.name)) return true;
  }
  return false;
}

function strongRange(state: EditorState): { from: number; to: number } | null {
  const range = state.selection.main;
  for (let node = syntaxTree(state).resolveInner(range.from, 1); node; node = node.parent!) {
    if (node.name === "StrongEmphasis" && range.to <= node.to
      && (range.empty ? range.from >= node.from + 2 && range.from <= node.to - 2 : range.to > node.from)) return { from: node.from, to: node.to };
  }
  return null;
}

function emptyBold(state: EditorState): boolean {
  const { from, empty } = state.selection.main;
  return empty && state.sliceDoc(Math.max(0, from - 2), from) === "**" && state.sliceDoc(from, from + 2) === "**";
}

export function lectureFormatState(state: EditorState): { style: LectureParagraphStyle; bold: boolean; disabled: boolean } {
  return { style: lineStyle(state.doc.lineAt(state.selection.main.from).text).style,
    bold: Boolean(strongRange(state)) || emptyBold(state), disabled: insideCode(state, state.selection.main.from) };
}

/** Replace line prefixes in one undo step; preserve indentation and all body text. */
export function setLectureParagraph(state: EditorState, style: LectureParagraphStyle): TransactionSpec {
  const { from, to } = state.selection.main;
  const start = state.doc.lineAt(from).number;
  const end = state.doc.lineAt(to > from && state.doc.lineAt(to).from === to ? to - 1 : to).number;
  const changes: ChangeSpec[] = [];
  let number = 1;
  for (let i = start; i <= end; i++) {
    const line = state.doc.line(i);
    if (insideCode(state, line.from + Math.max(0, line.text.search(/\S/)))) continue;
    if (!line.text.trim() && start !== end) continue;
    const old = lineStyle(line.text);
    if (old.style === style && (style !== "heading" || old.prefix === "### ")) { number++; continue; }
    const prefix = style === "heading" ? "### " : style === "bullet" ? "- " : style === "number" ? `${number}. ` : "";
    changes.push({ from: line.from + old.indent.length, to: line.from + old.indent.length + old.prefix.length, insert: prefix });
    number++;
  }
  const changeSet = state.changes(changes);
  return { changes: changeSet, selection: state.selection.map(changeSet, 1), userEvent: "input.format" };
}

/** Toggle semantic Markdown marks without inserting sample words into a user's note. */
export function toggleLectureBold(state: EditorState): TransactionSpec {
  const { from, to, empty } = state.selection.main;
  if (insideCode(state, from)) return {};
  const strong = strongRange(state);
  if (strong || emptyBold(state)) {
    const start = strong?.from ?? from - 2, end = strong?.to ?? to + 2;
    const changes = state.changes([{ from: start, to: start + 2 }, { from: end - 2, to: end }]);
    const clamp = (position: number): number => Math.max(start, Math.min(end - 4, changes.mapPos(position)));
    return { changes, selection: { anchor: clamp(from), head: clamp(to) }, userEvent: "input.format" };
  }
  if (empty) return { changes: { from, insert: "****" }, selection: { anchor: from + 2 }, userEvent: "input.format" };
  // Remove existing strong marks fully enclosed by the selection before applying one pair.
  let text = state.sliceDoc(from, to);
  const marks: { from: number; to: number }[] = [];
  syntaxTree(state).iterate({ from, to, enter: node => {
    if (node.name === "StrongEmphasis" && node.from >= from && node.to <= to) {
      marks.push({ from: node.from - from, to: node.from - from + 2 }, { from: node.to - from - 2, to: node.to - from });
    }
  } });
  for (const mark of marks.sort((a, b) => b.from - a.from)) text = text.slice(0, mark.from) + text.slice(mark.to);
  return { changes: { from, to, insert: `**${text}**` }, selection: { anchor: from + 2, head: from + 2 + text.length }, userEvent: "input.format" };
}
