import type { DeckPage } from "./deck-state";

export interface LectureSection {
  page: number;
  title: string;
  markdown: string;
  line: number;
  bodyStart: number;
  bodyEnd: number;
  raw: string;
}

export interface ParsedLectureNote {
  sections: Map<number, LectureSection>;
  duplicatePages: Set<number>;
}

export const MAX_LECTURE_NOTE_BYTES = 2 * 1024 * 1024;

/** Numbered H2 headings are stable even when other headings or code are edited. */
export function parseLectureNote(markdown: string): ParsedLectureNote {
  const sections = new Map<number, LectureSection>();
  const duplicatePages = new Set<number>();
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const offsets = [0, ...Array.from(markdown.matchAll(/\r\n|\r|\n/g), match => match.index + match[0].length)];
  let fence: { character: string; length: number } | null = null;
  let frontmatter = lines[0]?.trim() === "---";
  let current: { page: number; title: string; line: number } | null = null;
  let body: string[] = [];
  const finish = (endLine = lines.length): void => {
    if (!current) return;
    if (sections.has(current.page) || duplicatePages.has(current.page)) {
      sections.delete(current.page);
      duplicatePages.add(current.page);
    } else {
      const bodyStart = offsets[current.line + 1] ?? markdown.length;
      const bodyEnd = offsets[endLine] ?? markdown.length;
      sections.set(current.page, { ...current, markdown: body.join("\n").trim(), bodyStart, bodyEnd, raw: markdown.slice(bodyStart, bodyEnd) });
    }
    current = null;
    body = [];
  };
  for (const [lineNumber, line] of lines.entries()) {
    if (frontmatter) {
      if (lineNumber > 0 && /^(---|\.\.\.)\s*$/.test(line)) frontmatter = false;
      continue;
    }
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      body.push(line);
      if (fenceMatch?.[1]?.[0] === fence.character
        && fenceMatch[1].length >= fence.length && !fenceMatch[2]?.trim()) fence = null;
      continue;
    }
    if (fenceMatch?.[1]) {
      fence = { character: fenceMatch[1][0]!, length: fenceMatch[1].length };
      body.push(line);
      continue;
    }
    const heading = /^ {0,3}##\s+(?:第\s*(\d{1,3})\s*页|P(\d{1,3}))(?=\s|[·:：|｜、.。-]|$)(.*?)(?:\s+#+\s*)?$/i.exec(line);
    if (heading) {
      finish(lineNumber);
      const page = Number(heading[1] ?? heading[2]);
      if (page >= 1 && page <= 500) {
        current = { page, title: (heading[3] ?? "").replace(/^[\s·:：|｜、.。-]+/, "").trim(), line: lineNumber };
      }
    } else if (/^ {0,3}#{1,2}\s/.test(line)) {
      finish(lineNumber);
    } else if (current) body.push(line);
  }
  finish();
  return { sections, duplicatePages };
}

/** Editing only the content range preserves other pages, attributes and CRLF bytes. */
export function lectureEditorText(raw: string): string {
  return raw.replace(/^(?:[ \t]*(?:\r\n|\r|\n))+/, "").replace(/(?:(?:\r\n|\r|\n)[ \t]*)+$/, "").replace(/\r\n?/g, "\n");
}

export function replaceLectureSection(document: string, page: number, expected: string | null, text: string, title = ""): string {
  if (!Number.isInteger(page) || page < 1 || page > 500) throw new Error("页码无效，草稿已保留。");
  const parsed = parseLectureNote(document);
  if (parsed.duplicatePages.has(page)) throw new Error("这一页有重复的分页标题，请先在完整笔记中整理。草稿已保留。");
  const section = parsed.sections.get(page);
  if ((section?.raw ?? null) !== expected) {
    if (section && lectureEditorText(section.raw) === text) return document;
    throw new Error("这一页刚在别处修改过，草稿已保留。请打开完整笔记核对后再保存。");
  }
  const probe = parseLectureNote(`## 第 ${page} 页\n${text}\n## 第 501 页\n`);
  if (probe.sections.size !== 1 || probe.duplicatePages.size || lectureEditorText(probe.sections.get(page)?.raw ?? "") !== lectureEditorText(text)) {
    throw new Error("本页含有分页标题或未结束的代码块，请先调整；草稿已保留。");
  }
  const eol = document.includes("\r\n") ? "\r\n" : "\n";
  const value = text.replace(/\r\n?/g, "\n").replace(/\n/g, eol);
  if (!section) {
    const next = document + (document.endsWith(eol + eol) ? "" : document.endsWith(eol) ? eol : eol + eol)
      + `## 第 ${page} 页${title ? ` · ${escapeHeading(title)}` : ""}${eol}${eol}${value}${eol}${eol}`;
    if (!parseLectureNote(next).sections.has(page)) throw new Error("笔记中的代码块尚未结束，草稿已保留。");
    return next;
  }
  const leading = /^(?:[ \t]*(?:\r\n|\r|\n))*/.exec(section.raw)?.[0] ?? "";
  const trailing = /(?:(?:\r\n|\r|\n)[ \t]*)*$/.exec(section.raw)?.[0] ?? "";
  const blank = !section.raw.trim();
  const replacement = (blank ? eol : leading) + value + (blank ? eol + eol : trailing || eol);
  return document.slice(0, section.bodyStart) + replacement + document.slice(section.bodyEnd);
}

export function createLectureTemplate(fileName: string, filePath: string, pages: readonly DeckPage[]): string {
  const title = escapeHeading(fileName.replace(/\.html?$/i, ""));
  return [
    "---",
    `html-studio-source: ${JSON.stringify(filePath)}`,
    "---",
    "",
    `# ${title} · 逐页讲义`,
    "",
    "> 在每个“第 N 页”标题下维护讲述提示与大纲。课件翻页时，右侧讲义会跟随显示。",
    "",
    ...pages.flatMap((page, index) => [
      `## 第 ${index + 1} 页${page.title ? ` · ${escapeHeading(page.title)}` : ""}`,
      "", "### 讲述提示", "", "<!-- 写下这一页要提醒自己的内容。 -->", "", "### 本页大纲", "", ""
    ])
  ].join("\n");
}

export function normalizeLectureLinks(value: unknown): Record<string, string> {
  const links: Record<string, string> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return links;
  for (const [source, target] of Object.entries(value).slice(0, 5_000)) {
    if (typeof target !== "string" || !isRelativeNotePath(source, /\.html?$/i)
      || !isRelativeNotePath(target, /\.md$/i)) continue;
    Object.defineProperty(links, source, { value: target, enumerable: true, configurable: true, writable: true });
  }
  return links;
}

export function renameLectureLinks(links: Record<string, string>, oldPath: string, newPath: string): Record<string, string> {
  const rename = (value: string): string => value === oldPath ? newPath
    : value.startsWith(`${oldPath}/`) ? newPath + value.slice(oldPath.length) : value;
  return normalizeLectureLinks(Object.fromEntries(Object.entries(links).map(([source, target]) => [rename(source), rename(target)])));
}

function isRelativeNotePath(value: string, extension: RegExp): boolean {
  return value.length <= 4_096 && extension.test(value) && !value.startsWith("/")
    && !/[\p{Cc}\\]/u.test(value) && !value.split("/").some(part => part === "." || part === "..");
}

function escapeHeading(value: string): string {
  return value.replace(/\p{Cc}/gu, " ").replace(/[\\`*_{}[\]()#+.!<>|]/g, "\\$&").slice(0, 200).trim();
}
