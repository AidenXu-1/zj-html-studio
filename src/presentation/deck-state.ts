export const MAX_DECK_PAGES = 500;

export interface DeckPage {
  hash: string;
  title: string;
}

export interface DeckState {
  current: number;
  pages: DeckPage[];
  adapter?: "reveal" | "swiper" | "dom";
  canNavigate?: boolean;
}

/** Only data describing slides crosses the page bridge, never note contents. */
export function parseDeckState(value: unknown): DeckState | null {
  if (typeof value !== "object" || value === null) return null;
  const data = value as Partial<DeckState>;
  if (!Array.isArray(data.pages) || data.pages.length < 2 || data.pages.length > MAX_DECK_PAGES) return null;
  if (!isDeckPageNumber(data.current, data.pages.length)) return null;
  const adapter = data.adapter;
  if (adapter !== undefined && (!["reveal", "swiper", "dom"].includes(adapter) || typeof data.canNavigate !== "boolean")) return null;
  const pages: DeckPage[] = [];
  let scheme: string | undefined;
  for (const [index, item] of data.pages.entries()) {
    if (typeof item !== "object" || item === null) return null;
    const page = item as Partial<DeckPage>;
    if (typeof page.hash !== "string") return null;
    if (adapter) {
      if (page.hash !== `#@zj/${adapter}/${index + 1}` || typeof page.title !== "string" || page.title.length > 160) return null;
      pages.push({ hash: page.hash, title: page.title.replace(/\p{Cc}/gu, " ").trim() });
      continue;
    }
    const numberedId = /^#(p|slide-)(\d{1,3})$/i.exec(page.hash);
    const pageScheme = numberedId ? numberedId[1]!.toLowerCase() : /^#[1-9]\d{0,2}$/.test(page.hash) ? "keyboard" : null;
    if (!pageScheme || scheme && scheme !== pageScheme) return null;
    scheme = pageScheme;
    if (Number(numberedId ? numberedId[2] : page.hash.slice(1)) !== index + 1) return null;
    if (typeof page.title !== "string" || page.title.length > 160) return null;
    pages.push({ hash: page.hash, title: page.title.replace(/\p{Cc}/gu, " ").trim() });
  }
  return { current: data.current, pages, ...(adapter ? { adapter, canNavigate: data.canNavigate } : {}) };
}

export function isDeckPageNumber(value: unknown, total: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= total;
}

export function sameDeckStructure(left: DeckState, right: DeckState): boolean {
  return left.pages.length === right.pages.length
    && left.pages.every((page, index) => page.hash === right.pages[index]?.hash);
}
