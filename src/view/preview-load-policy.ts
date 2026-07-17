import { normalizeScopePath, type PreviewMode } from "../settings";

const PREVIEW_MODE_PRIVILEGE: Record<PreviewMode, number> = {
  safe: 0,
  interactive: 1,
  trusted: 2
};

export interface PreviewRecoveryOptions {
  confirmedScopePath: string | null;
  modeOverride: PreviewMode;
  preserveBrowserSessions: true;
}

export type ScopeModeChangeAction = "clear-override" | "downgrade" | "ignore" | "pin-current";

export function resolvePreviewMode(persistentMode: PreviewMode, modeOverride?: PreviewMode): PreviewMode {
  return modeOverride ?? persistentMode;
}

export function resolveSessionlessPolicyReloadMode(options: {
  forceSafeReset: boolean;
  modeOverride: PreviewMode | null;
  persistentMode: PreviewMode;
}): PreviewMode {
  if (options.forceSafeReset) return "safe";
  return resolvePreviewMode(options.persistentMode, options.modeOverride ?? undefined);
}

export function isPolicyBoundLoadCurrent(options: {
  currentFilePath: string | null;
  currentLoadGeneration: number;
  currentPolicyGeneration: number;
  filePath: string;
  loadGeneration: number;
  policyGeneration: number;
}): boolean {
  return options.currentFilePath === options.filePath
    && options.currentLoadGeneration === options.loadGeneration
    && options.currentPolicyGeneration === options.policyGeneration;
}

export function createPreviewRecoveryOptions(
  failedMode: PreviewMode,
  confirmedScopePath: string | null
): PreviewRecoveryOptions {
  return {
    confirmedScopePath,
    modeOverride: failedMode,
    preserveBrowserSessions: true
  };
}

export function isPreviewModeDowngrade(currentMode: PreviewMode, nextMode: PreviewMode): boolean {
  return PREVIEW_MODE_PRIVILEGE[nextMode] < PREVIEW_MODE_PRIVILEGE[currentMode];
}

export function decideScopeModeChange(options: {
  currentMode: PreviewMode;
  forceSafeReset: boolean;
  modeOverride: PreviewMode | null;
  persistentMode: PreviewMode;
}): ScopeModeChangeAction {
  if (options.modeOverride !== null && !options.forceSafeReset) return "ignore";
  if (options.persistentMode === options.currentMode) {
    return options.forceSafeReset ? "clear-override" : "ignore";
  }
  return isPreviewModeDowngrade(options.currentMode, options.persistentMode)
    ? "downgrade"
    : "pin-current";
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
