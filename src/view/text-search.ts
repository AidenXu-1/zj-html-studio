const MAX_SEARCH_RESULTS = 10_000;

export function findTextOccurrences(source: string, query: string): number[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [];

  const normalizedSource = source.toLocaleLowerCase();
  const positions: number[] = [];
  let cursor = 0;
  while (positions.length < MAX_SEARCH_RESULTS) {
    const position = normalizedSource.indexOf(normalizedQuery, cursor);
    if (position < 0) break;
    positions.push(position);
    cursor = position + Math.max(1, normalizedQuery.length);
  }
  return positions;
}

export function moveSearchIndex(current: number, total: number, direction: -1 | 1): number {
  if (total <= 0) return -1;
  if (current < 0 || current >= total) return direction === 1 ? 0 : total - 1;
  return (current + direction + total) % total;
}
