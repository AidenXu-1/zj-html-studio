export interface ByteRange {
  end: number;
  start: number;
}

export function parseByteRange(header: string | undefined, size: number): ByteRange | null | "invalid" {
  if (!header) return null;
  if (size <= 0) return "invalid";

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return "invalid";

  const rawStart = match[1] ?? "";
  const rawEnd = match[2] ?? "";
  if (rawStart === "" && rawEnd === "") return "invalid";

  if (rawStart === "") {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return "invalid";
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1
    };
  }

  const start = Number(rawStart);
  const requestedEnd = rawEnd === "" ? size - 1 : Number(rawEnd);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)) return "invalid";
  if (start < 0 || requestedEnd < start || start >= size) return "invalid";

  return {
    start,
    end: Math.min(requestedEnd, size - 1)
  };
}
