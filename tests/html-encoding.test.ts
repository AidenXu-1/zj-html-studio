import { describe, expect, it } from "vitest";
import {
  assertUtf8HtmlEncoding,
  assertValidUtf8,
  UnsupportedHtmlEncodingError
} from "../src/server/html-encoding";

describe("HTML encoding policy", () => {
  it("accepts UTF-8 declarations in either supported meta form", () => {
    expect(() => assertUtf8HtmlEncoding(Buffer.from('<meta charset="UTF-8"><p>ok</p>'))).not.toThrow();
    expect(() => assertUtf8HtmlEncoding(Buffer.from(
      '<meta content="text/html; charset=utf8" http-equiv="Content-Type"><p>ok</p>'
    ))).not.toThrow();
  });

  it("rejects actual non-UTF-8 declarations", () => {
    expect(() => assertUtf8HtmlEncoding(Buffer.from('<meta charset="windows-1252"><p>bad</p>')))
      .toThrow(UnsupportedHtmlEncodingError);
  });

  it("ignores encoding examples inside comments and raw-text elements", () => {
    const source = [
      '<!-- <meta charset="gbk"> -->',
      '<script>const example = \'<meta charset="windows-1252">\';</script>',
      '<style>.note::after { content: \'<meta charset="big5">\'; }</style>',
      '<meta charset="utf-8">'
    ].join("");
    expect(() => assertUtf8HtmlEncoding(Buffer.from(source))).not.toThrow();
  });

  it("does not treat a content attribute without http-equiv as an encoding declaration", () => {
    expect(() => assertUtf8HtmlEncoding(Buffer.from(
      '<meta name="description" content="example; charset=gbk"><p>ok</p>'
    ))).not.toThrow();
  });

  it("continues scanning after a literal less-than sign in text", () => {
    expect(() => assertUtf8HtmlEncoding(Buffer.from('1 < 2 <meta charset="gbk">')))
      .toThrow(UnsupportedHtmlEncodingError);
  });

  it("rejects invalid UTF-8 bytes when the complete file is available", () => {
    expect(() => assertValidUtf8(Buffer.from([0x3c, 0x70, 0x3e, 0x80])))
      .toThrow(UnsupportedHtmlEncodingError);
  });
});
