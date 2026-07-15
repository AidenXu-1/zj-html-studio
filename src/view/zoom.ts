export const MIN_PREVIEW_ZOOM = 50;
export const MAX_PREVIEW_ZOOM = 200;
export const PREVIEW_ZOOM_STEP = 10;

export function clampPreviewZoom(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.min(MAX_PREVIEW_ZOOM, Math.max(MIN_PREVIEW_ZOOM, Math.round(value)));
}

export function stepPreviewZoom(current: number, direction: -1 | 1): number {
  return clampPreviewZoom(current + direction * PREVIEW_ZOOM_STEP);
}
