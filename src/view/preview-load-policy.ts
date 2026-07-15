import { normalizeScopePath, type PreviewMode } from "../settings";

export function resolvePreviewMode(persistentlyTrusted: boolean, modeOverride?: PreviewMode): PreviewMode {
  return modeOverride ?? (persistentlyTrusted ? "trusted" : "safe");
}

export function shouldConfirmScope(
  requiresConfirmation: boolean,
  confirmedScopePath: string | null,
  requestedScopePath: string
): boolean {
  if (!requiresConfirmation) return false;
  if (confirmedScopePath === null) return true;
  return !scopeCovers(confirmedScopePath, requestedScopePath);
}

export async function applyModeChoice(
  switchMode: () => Promise<boolean>,
  persistMode?: () => Promise<void>
): Promise<boolean> {
  const applied = await switchMode();
  if (!applied) return false;
  await persistMode?.();
  return true;
}

function scopeCovers(coveringScopePath: string, requestedScopePath: string): boolean {
  const covering = normalizeScopePath(coveringScopePath);
  const requested = normalizeScopePath(requestedScopePath);
  if (!covering) return true;
  return requested === covering || requested.startsWith(`${covering}/`);
}
