const MAX_SEARCH_RESULTS = 10_000;
const SOURCE_LINE_INDEX_BLOCK_CHARACTERS = 64 * 1024;
export const MAX_TEXT_SEARCH_QUERY_CHARACTERS = 500;

export interface SourceLineIndex {
  breaksAtBlock: Uint32Array;
  totalBreaks: number;
}

export function findTextOccurrences(source: string, query: string): number[] {
  const normalizedQuery = normalizeTextSearchQuery(query);
  if (!normalizedQuery) return [];

  const positions: number[] = [];
  const matcher = new RegExp(escapeRegularExpression(normalizedQuery), "giu");
  for (const match of source.matchAll(matcher)) {
    if (match.index === undefined) continue;
    positions.push(match.index);
    if (positions.length >= MAX_SEARCH_RESULTS) break;
  }
  return positions;
}

export function normalizeTextSearchQuery(query: string): string {
  const trimmed = query.trim();
  if (trimmed.length <= MAX_TEXT_SEARCH_QUERY_CHARACTERS) return trimmed;
  let end = MAX_TEXT_SEARCH_QUERY_CHARACTERS;
  if (isHighSurrogate(trimmed.charCodeAt(end - 1)) && isLowSurrogate(trimmed.charCodeAt(end))) end -= 1;
  return trimmed.slice(0, end);
}

export function moveSearchIndex(current: number, total: number, direction: -1 | 1): number {
  if (total <= 0) return -1;
  if (current < 0 || current >= total) return direction === 1 ? 0 : total - 1;
  return (current + direction + total) % total;
}

export function getSourceLineScrollRatio(source: string, position: number): number {
  return getSourceLineScrollRatioFromIndex(source, buildSourceLineIndex(source), position);
}

export function buildSourceLineIndex(source: string): SourceLineIndex {
  const breaksAtBlock = new Uint32Array(
    Math.ceil(source.length / SOURCE_LINE_INDEX_BLOCK_CHARACTERS) + 1
  );
  let block = 1;
  let totalBreaks = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (index === block * SOURCE_LINE_INDEX_BLOCK_CHARACTERS) {
      breaksAtBlock[block] = totalBreaks;
      block += 1;
    }
    if (source.charCodeAt(index) === 0x0a) totalBreaks += 1;
  }
  while (block < breaksAtBlock.length) {
    breaksAtBlock[block] = totalBreaks;
    block += 1;
  }
  return { breaksAtBlock, totalBreaks };
}

export function getSourceLineScrollRatioFromIndex(
  source: string,
  lineIndex: SourceLineIndex,
  position: number
): number {
  if (lineIndex.totalBreaks === 0) return 0;
  const clampedPosition = Math.max(0, Math.min(source.length, Math.floor(position)));
  const block = Math.min(
    lineIndex.breaksAtBlock.length - 1,
    Math.floor(clampedPosition / SOURCE_LINE_INDEX_BLOCK_CHARACTERS)
  );
  let breaks = lineIndex.breaksAtBlock[block] ?? 0;
  const start = block * SOURCE_LINE_INDEX_BLOCK_CHARACTERS;
  for (let index = start; index < clampedPosition; index += 1) {
    if (source.charCodeAt(index) === 0x0a) breaks += 1;
  }
  return breaks / lineIndex.totalBreaks;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}
