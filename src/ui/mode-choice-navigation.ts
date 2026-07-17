import type { PreviewMode } from "../settings";

const PREVIEW_MODES: readonly PreviewMode[] = ["safe", "interactive", "trusted"];

export function movePreviewModeSelection(
  currentMode: PreviewMode,
  key: string
): PreviewMode {
  if (key === "Home") return PREVIEW_MODES[0]!;
  if (key === "End") return PREVIEW_MODES.at(-1)!;
  const currentIndex = PREVIEW_MODES.indexOf(currentMode);
  if (key === "ArrowDown" || key === "ArrowRight") {
    return PREVIEW_MODES[(currentIndex + 1) % PREVIEW_MODES.length]!;
  }
  if (key === "ArrowUp" || key === "ArrowLeft") {
    return PREVIEW_MODES[(currentIndex - 1 + PREVIEW_MODES.length) % PREVIEW_MODES.length]!;
  }
  return currentMode;
}
