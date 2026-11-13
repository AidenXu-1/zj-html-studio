import { describe, expect, it } from "vitest";
import { lectureEditorText, parseLectureNote, replaceLectureSection } from "../src/presentation/lecture-note";

describe("editing just one lecture page", () => {
  const document = "---\r\nsource: lesson.html\r\n---\r\n# 讲义\r\n\r\n## 第 15 页 · 提问\r\n\r\n### 提示\r\n原文  \r\n下一行\r\n\r\n## 第 16 页\r\n\r\n[[笔记]] ![[图片.png]]\r\n";
  const raw = (doc: string, page = 15): string | null => parseLectureNote(doc).sections.get(page)?.raw ?? null;
  it("keeps frontmatter, headings, other pages and CRLF bytes exactly", () => {
    const section = parseLectureNote(document).sections.get(15)!;
    const result = replaceLectureSection(document, 15, section.raw, "### 提示\n新文字  \n下一行");
    expect(result.slice(0, section.bodyStart)).toBe(document.slice(0, section.bodyStart));
    expect(result.endsWith(document.slice(section.bodyEnd))).toBe(true);
    expect(raw(result)).toBe("\r\n### 提示\r\n新文字  \r\n下一行\r\n\r\n");
    expect(result.replace(/\r\n/g, "")).not.toContain("\n");
  });
  it("preserves indented code and Markdown hard breaks in the editable value", () => {
    expect(lectureEditorText("\n    code\ntext  \nnext\n\n")).toBe("    code\ntext  \nnext");
  });
  it("merges an unrelated page edited elsewhere", () => {
    const concurrent = document.replace("[[笔记]]", "[[新笔记]]");
    const result = replaceLectureSection(concurrent, 15, raw(document), "我的提示");
    expect(raw(result, 16)).toBe(raw(concurrent, 16));
    expect(lectureEditorText(raw(result)!)).toBe("我的提示");
  });
  it("rejects a simultaneous edit to the same page instead of overwriting it", () => {
    expect(() => replaceLectureSection(document.replace("原文", "别人修改"), 15, raw(document), "我的提示")).toThrow("别处修改过");
  });
  it("accepts an idempotent retry after a successful write", () => {
    const saved = replaceLectureSection(document, 15, raw(document), "新正文");
    expect(replaceLectureSection(saved, 15, raw(document), "新正文")).toBe(saved);
  });
  it("adds a missing page without rewriting existing sections", () => {
    const saved = replaceLectureSection(document, 47, null, "**结语**", "结束");
    expect(saved.startsWith(document)).toBe(true);
    expect(lectureEditorText(raw(saved, 47)!)).toBe("**结语**");
  });
  it("allows a page to be emptied", () => {
    expect(lectureEditorText(raw(replaceLectureSection(document, 15, raw(document), ""))!)).toBe("");
  });
  it("retains fenced code, links, embeds and checklists", () => {
    const text = "### 提示\n- [ ] **任务** [[链接]]\n\n![[图片.png]]\n\n```md\n## 第 16 页\n```";
    const result = replaceLectureSection(document, 15, raw(document), text);
    expect(lectureEditorText(raw(result)!)).toBe(text);
    expect(raw(result, 16)).toBe(raw(document, 16));
  });
  it.each(["## 第 16 页\n非法分页", "# 总标题\n后文", "## 普通标题\n后文", "```js\n未结束"])("rejects structure that would swallow or split another page: %s", text => {
    expect(() => replaceLectureSection(document, 15, raw(document), text)).toThrow("草稿已保留");
  });
  it("rejects ambiguous duplicate headings and an unclosed fence in the outer document", () => {
    expect(() => replaceLectureSection(document + "\n## 第 15 页\n重复", 15, raw(document), "新")).toThrow("重复");
    expect(() => replaceLectureSection(document + "\n```\ncode", 47, null, "新")).toThrow("代码块");
  });
});
