export interface HtmlEmbedSize {
  aspectRatio: number | null;
  height: number;
  width: number | null;
}

export const DEFAULT_EMBED_HEIGHT = 480;
export const MIN_EMBED_DIMENSION = 160;
export const MAX_EMBED_DIMENSION = 4_096;

export function parseHtmlEmbedSize(widthAttribute: string | null, heightAttribute: string | null): HtmlEmbedSize {
  const width = parseDimension(widthAttribute);
  const height = parseDimension(heightAttribute);
  return {
    aspectRatio: width !== null && height !== null ? width / height : null,
    width,
    height: height ?? DEFAULT_EMBED_HEIGHT
  };
}

function parseDimension(value: string | null): number | null {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(MAX_EMBED_DIMENSION, Math.max(MIN_EMBED_DIMENSION, Math.round(parsed)));
}
