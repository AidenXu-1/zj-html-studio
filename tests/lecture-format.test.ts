import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { lectureFormatState, setLectureParagraph, toggleLectureBold } from "../src/presentation/lecture-format";

const state = (doc: string, from = 0, to = from): EditorState => EditorState.create({ doc, selection: { anchor: from, head: to }, extensions: [markdown()] });
describe("lecture formatting preserves content and has reversible actions", () => {
  it("replaces existing prefixes and returns to body without stacking", () => {
    let s = state("### 提示", 5);
    s = s.update(setLectureParagraph(s, "heading")).state;
    expect(s.doc.toString()).toBe("### 提示");
    s = s.update(setLectureParagraph(s, "bullet")).state;
    expect(s.doc.toString()).toBe("- 提示");
    s = s.update(setLectureParagraph(s, "number")).state;
    expect(s.doc.toString()).toBe("1. 提示");
    s = s.update(setLectureParagraph(s, "body")).state;
    expect(s.doc.toString()).toBe("提示");
  });
  it("formats all selected lines, preserving a following unselected line and indentation", () => {
    const s = state("苹果\n  香蕉\n后文", 0, 8);
    expect(s.update(setLectureParagraph(s, "number")).newDoc.toString()).toBe("1. 苹果\n  2. 香蕉\n后文");
  });
  it("leaves fenced and indented code untouched", () => {
    for (const text of ["```js\nconst a = 1;\n```", "    code"]) {
      const s = state(text, text.indexOf("code") >= 0 ? 5 : 8);
      expect(s.update(setLectureParagraph(s, "heading")).newDoc.toString()).toBe(text);
      expect(s.update(toggleLectureBold(s)).newDoc.toString()).toBe(text);
    }
  });
  it("toggles selected Chinese and reports the actual bold state", () => {
    let s = state("先问大家", 1, 4);
    s = s.update(toggleLectureBold(s)).state;
    expect(s.doc.toString()).toBe("先**问大家**");
    expect(lectureFormatState(s).bold).toBe(true);
    s = s.update(toggleLectureBold(s)).state;
    expect(s.doc.toString()).toBe("先问大家");
    expect(s.sliceDoc(s.selection.main.from, s.selection.main.to)).toBe("问大家");
  });
  it("supports an empty caret without inserting fake content and can immediately cancel", () => {
    let s = state("提示：", 3);
    s = s.update(toggleLectureBold(s)).state;
    expect(s.doc.toString()).toBe("提示：****");
    expect(lectureFormatState(s).bold).toBe(true);
    expect(s.update(toggleLectureBold(s)).newDoc.toString()).toBe("提示：");
    s = s.update({ changes: { from: s.selection.main.from, insert: "中文" }, selection: { anchor: 7 } }).state;
    expect(s.doc.toString()).toBe("提示：**中文**");
  });
  it("removes complete selected strong marks and handles underscore syntax", () => {
    for (const text of ["**重点**", "__重点__"]) {
      const s = state(text, 0, text.length);
      expect(s.update(toggleLectureBold(s)).newDoc.toString()).toBe("重点");
    }
  });
  it("does not add nested bold marks to a mixed selection", () => {
    const s = state("**重点**和说明", 0, 9);
    expect(s.update(toggleLectureBold(s)).newDoc.toString()).toBe("**重点和说明**");
  });
});
