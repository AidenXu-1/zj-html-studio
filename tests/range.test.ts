import { describe, expect, it } from "vitest";
import { parseByteRange } from "../src/server/range";

describe("byte ranges", () => {
  it("parses explicit, open-ended, and suffix ranges", () => {
    expect(parseByteRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
    expect(parseByteRange("bytes=6-", 10)).toEqual({ start: 6, end: 9 });
    expect(parseByteRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
  });

  it("rejects invalid or out-of-bounds ranges", () => {
    expect(parseByteRange("items=0-1", 10)).toBe("invalid");
    expect(parseByteRange("bytes=10-12", 10)).toBe("invalid");
    expect(parseByteRange("bytes=8-2", 10)).toBe("invalid");
    expect(parseByteRange("bytes=0-0", 0)).toBe("invalid");
  });
});
