import { describe, expect, it } from "vitest";
import { parseDeckState, sameDeckStructure, isDeckPageNumber } from "../src/presentation/deck-state";
import { createLectureTemplate, normalizeLectureLinks, parseLectureNote, renameLectureLinks } from "../src/presentation/lecture-note";

const pages = Array.from({ length: 47 }, (_, index) => ({ hash: `#p${String(index + 1).padStart(2, "0")}`, title: `Slide ${index + 1}` }));

describe("presentation slide protocol", () => {
  it("accepts slide-prefixed page identifiers while rejecting mixed, missing and malformed identifiers", () => {
    const prefixed = Array.from({ length: 26 }, (_, i) => ({ hash: `#slide-${String(i + 1).padStart(2, "0")}`, title: `Slide ${i + 1}` }));
    for (const current of [15, 16, 15]) {
      expect(parseDeckState({ current, pages: prefixed })).toEqual({ current, pages: prefixed });
    }
    for (const hash of ["#p01", "#1", "#slide-00", "#slide-02", "#slide-001?x=1", "#slide-1/x", "#slide-x", "#slide-0001"]) {
      expect(parseDeckState({ current: 1, pages: [{ ...prefixed[0], hash }, ...prefixed.slice(1)] })).toBeNull();
    }
    expect(parseDeckState({ current: 1, pages: [...prefixed.slice(0, 14), ...prefixed.slice(15)] })).toBeNull();
  });

  it("accepts a consistent numeric slide sequence and rejects mixed or malformed schemes", () => {
    const numbered = Array.from({ length: 42 }, (_, i) => ({ hash: `#${i + 1}`, title: `Slide ${i + 1}` }));
    expect(parseDeckState({ current: 15, pages: numbered })?.pages).toHaveLength(42);
    for (const hash of ["#p1", "#0", "#2", "#01", "#1?x=1", "#1/x"]) {
      expect(parseDeckState({ current: 1, pages: [{ ...numbered[0], hash }, ...numbered.slice(1)] })).toBeNull();
    }
  });
  it("tracks 15 → 16 → 15 without changing the slide mapping", () => {
    const states = [15, 16, 15].map(current => parseDeckState({ current, pages }));
    expect(states.map(state => state?.current)).toEqual([15, 16, 15]);
    expect(states.every(state => state && sameDeckStructure(state, states[0]!))).toBe(true);
  });

  it("rejects malformed, missing, duplicate, reordered and external slide identifiers", () => {
    expect(parseDeckState({ current: 0, pages })).toBeNull();
    expect(parseDeckState({ current: 48, pages })).toBeNull();
    expect(parseDeckState({ current: 1.5, pages })).toBeNull();
    expect(parseDeckState({ current: 15, pages: [...pages.slice(0, 14), ...pages.slice(15)] })).toBeNull();
    expect(parseDeckState({ current: 15, pages: [pages[1], pages[0], ...pages.slice(2)] })).toBeNull();
    expect(parseDeckState({ current: 1, pages: [{ hash: "https://example.com", title: "A" }, pages[1]] })).toBeNull();
    expect(parseDeckState({ current: 1, pages: [{ hash: "#p01", title: "x".repeat(161) }, pages[1]] })).toBeNull();
    expect(isDeckPageNumber(Number.NaN, 47)).toBe(false);
  });
});

describe("ordinary Markdown lecture notes", () => {
  it("reads only the requested numbered section, with nested headings intact", () => {
    const parsed = parseLectureNote("# 讲义\n\n## 第 15 页 · 现场比较\n\n### 提示\n先问学员。\n\n### 大纲\n- 第一步\n\n## 第 16 页 · 提问\n\n换一个问题。\n## 课后资料\n不要投屏。");
    expect(parsed.sections.get(15)?.markdown).toBe("### 提示\n先问学员。\n\n### 大纲\n- 第一步");
    expect(parsed.sections.get(16)?.markdown).toBe("换一个问题。");
    expect(parsed.sections.get(15)?.line).toBe(2);
    expect(parsed.sections.has(14)).toBe(false);
  });

  it("does not treat frontmatter or fenced examples as page headings", () => {
    const parsed = parseLectureNote("---\nexample: |\n  ## 第 1 页\n---\n## 第 15 页\n~~~md\n## 第 16 页\n~~~\n正文\n```\n## 第 17 页\n```\n## 第 18 页\n最后");
    expect([...parsed.sections.keys()]).toEqual([15, 18]);
    expect(parsed.sections.get(15)?.markdown).toContain("## 第 16 页");
  });

  it("fails visibly on duplicate page headings instead of showing arbitrary notes", () => {
    const parsed = parseLectureNote("## 第 15 页\n第一份\n## 第 15 页 · 重复\n第二份\n## 第 16 页\n独立内容");
    expect(parsed.sections.has(15)).toBe(false);
    expect(parsed.duplicatePages.has(15)).toBe(true);
    expect(parsed.sections.get(16)?.markdown).toBe("独立内容");
  });

  it("creates all 47 page sections and escapes HTML-provided titles", () => {
    const template = createLectureTemplate("课程.html", "课程/课程.html", pages);
    const parsed = parseLectureNote(template);
    expect(parsed.sections.size).toBe(47);
    expect(parsed.sections.get(15)?.title).toBe("Slide 15");
    const escaped = createLectureTemplate("x.html", "x.html", [{ hash: "#p01", title: "![[私密笔记]] <img>\n## 第 2 页" }]);
    expect(escaped).not.toContain("![[私密笔记]]");
    expect(parseLectureNote(escaped).sections.size).toBe(1);
  });

  it("normalizes Windows line endings and leaves unrelated note text out", () => {
    const parsed = parseLectureNote("开场介绍\r\n## P15 · 准备\r\n内容\r\n## 第 16 页\r\n");
    expect(parsed.sections.get(15)?.markdown).toBe("内容");
    expect(parsed.sections.get(16)?.markdown).toBe("");
  });

  it("retains relative links and rejects paths outside the vault", () => {
    expect(normalizeLectureLinks({ "课件/a.html": "讲义/a.md", "../b.html": "讲义/b.md", "c.html": "/secret.md", "x.html": "../x.md", "note.md": "a.md" })).toEqual({ "课件/a.html": "讲义/a.md" });
  });

  it("updates both note and source links when files or folders are renamed", () => {
    const links = { "课程/a.html": "课程/讲义.md", "other.html": "其他.md" };
    expect(renameLectureLinks(links, "课程", "新课程")).toEqual({ "新课程/a.html": "新课程/讲义.md", "other.html": "其他.md" });
    expect(renameLectureLinks(links, "课程/讲义.md", "讲述.md")["课程/a.html"]).toBe("讲述.md");
  });
});
