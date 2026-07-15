export interface FullscreenTargetLike {
  requestFullscreen?: () => Promise<void>;
}

export interface FullscreenDocumentLike {
  exitFullscreen?: () => Promise<void>;
  fullscreenElement: FullscreenTargetLike | null;
}

export type FullscreenToggleResult = "entered" | "exited" | "not-ready" | "unsupported";

export async function toggleFullscreenTarget(
  target: FullscreenTargetLike | null,
  fullscreenDocument: FullscreenDocumentLike
): Promise<FullscreenToggleResult> {
  if (!target) return "not-ready";

  if (fullscreenDocument.fullscreenElement === target) {
    if (!fullscreenDocument.exitFullscreen) return "unsupported";
    await fullscreenDocument.exitFullscreen();
    return "exited";
  }

  if (!target.requestFullscreen) return "unsupported";
  await target.requestFullscreen();
  return "entered";
}

export function isFullscreenTarget(
  target: FullscreenTargetLike | null,
  fullscreenDocument: FullscreenDocumentLike
): boolean {
  return target !== null && fullscreenDocument.fullscreenElement === target;
}
