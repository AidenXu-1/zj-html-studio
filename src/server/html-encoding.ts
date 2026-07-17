import { isUtf8 } from "node:buffer";

const ENCODING_SNIFF_BYTES = 4_096;

export class UnsupportedHtmlEncodingError extends Error {
  constructor(readonly encodingLabel: string) {
    super(`当前版本不支持 ${encodingLabel} 编码的 HTML，请先转换为 UTF-8`);
    this.name = "UnsupportedHtmlEncodingError";
  }
}

export function assertUtf8HtmlEncoding(buffer: Buffer): void {
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) throw new UnsupportedHtmlEncodingError("UTF-16 LE");
    if (buffer[0] === 0xfe && buffer[1] === 0xff) throw new UnsupportedHtmlEncodingError("UTF-16 BE");
  }
  const prefix = buffer.subarray(0, ENCODING_SNIFF_BYTES).toString("latin1");
  const declared = findDeclaredEncoding(prefix);
  if (!declared) return;
  const normalized = declared.toLowerCase().replace(/[_\s]/g, "-");
  if (normalized === "utf-8" || normalized === "utf8") return;
  throw new UnsupportedHtmlEncodingError(declared);
}

export function assertValidUtf8(buffer: Buffer): void {
  if (!isUtf8(buffer)) throw new UnsupportedHtmlEncodingError("非 UTF-8");
}

function findDeclaredEncoding(prefix: string): string | null {
  let cursor = 0;
  while (cursor < prefix.length) {
    const tagStart = prefix.indexOf("<", cursor);
    if (tagStart < 0) return null;
    if (prefix.startsWith("<!--", tagStart)) {
      const commentEnd = prefix.indexOf("-->", tagStart + 4);
      if (commentEnd < 0) return null;
      cursor = commentEnd + 3;
      continue;
    }

    const tag = readTag(prefix, tagStart);
    if (!tag) return null;
    cursor = tag.end;
    if (tag.closing) continue;
    if (tag.name === "meta") {
      const encoding = getMetaEncoding(tag.source);
      if (encoding) return encoding;
    }
    if (!RAW_TEXT_TAGS.has(tag.name)) continue;
    if (tag.name === "plaintext") return null;
    const closingStart = prefix.toLowerCase().indexOf(`</${tag.name}`, cursor);
    if (closingStart < 0) return null;
    const closingTag = readTag(prefix, closingStart);
    if (!closingTag) return null;
    cursor = closingTag.end;
  }
  return null;
}

const RAW_TEXT_TAGS = new Set([
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
  "script",
  "style",
  "textarea",
  "title",
  "xmp"
]);

interface HtmlTag {
  closing: boolean;
  end: number;
  name: string;
  source: string;
}

function readTag(source: string, start: number): HtmlTag | null {
  let cursor = start + 1;
  const closing = source[cursor] === "/";
  if (closing) cursor += 1;
  while (isHtmlSpace(source[cursor])) cursor += 1;
  const nameStart = cursor;
  if (/[a-z]/i.test(source.charAt(cursor))) {
    while (cursor < source.length && /[a-z0-9:-]/i.test(source.charAt(cursor))) cursor += 1;
  }
  if (cursor === nameStart) {
    if (source[nameStart] !== "!" && source[nameStart] !== "?") {
      return { closing, end: start + 1, name: "", source: "<" };
    }
    const end = findTagEnd(source, cursor);
    return end < 0 ? null : { closing, end: end + 1, name: "", source: source.slice(start, end + 1) };
  }
  const name = source.slice(nameStart, cursor).toLowerCase();
  const end = findTagEnd(source, cursor);
  return end < 0 ? null : { closing, end: end + 1, name, source: source.slice(start, end + 1) };
}

function findTagEnd(source: string, start: number): number {
  let quote = "";
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") return cursor;
  }
  return -1;
}

function getMetaEncoding(tag: string): string | null {
  const attributes = parseAttributes(tag);
  const direct = attributes.get("charset")?.trim();
  if (direct) return direct;
  if (attributes.get("http-equiv")?.trim().toLowerCase() !== "content-type") return null;
  return attributes.get("content")?.match(/(?:^|;)\s*charset\s*=\s*([^\s;]+)/i)?.[1] ?? null;
}

function parseAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  let cursor = tag.search(/\s/);
  if (cursor < 0) return attributes;

  while (cursor < tag.length) {
    while (isHtmlSpace(tag[cursor])) cursor += 1;
    if (cursor >= tag.length || tag[cursor] === ">" || tag[cursor] === "/") break;
    const nameStart = cursor;
    while (cursor < tag.length && !/[\s=/>]/.test(tag.charAt(cursor))) cursor += 1;
    const name = tag.slice(nameStart, cursor).toLowerCase();
    while (isHtmlSpace(tag[cursor])) cursor += 1;
    let value = "";
    if (tag[cursor] === "=") {
      cursor += 1;
      while (isHtmlSpace(tag[cursor])) cursor += 1;
      const quote = tag[cursor] === '"' || tag[cursor] === "'" ? tag[cursor] : "";
      if (quote) cursor += 1;
      const valueStart = cursor;
      if (quote) {
        while (cursor < tag.length && tag[cursor] !== quote) cursor += 1;
        value = tag.slice(valueStart, cursor);
        if (tag[cursor] === quote) cursor += 1;
      } else {
        while (cursor < tag.length && !/[\s>]/.test(tag.charAt(cursor))) cursor += 1;
        value = tag.slice(valueStart, cursor);
      }
    }
    if (name && !attributes.has(name)) attributes.set(name, value);
  }
  return attributes;
}

function isHtmlSpace(value: string | undefined): boolean {
  return value === "\t" || value === "\n" || value === "\f" || value === "\r" || value === " ";
}
