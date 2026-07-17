export type AutoReloadAction = "candidate" | "defer-fullscreen" | "ignore" | "initial-load";

export function decideAutoReloadAction(options: {
  enabled: boolean;
  hasSession: boolean;
  isFullscreen: boolean;
}): AutoReloadAction {
  if (!options.enabled) return "ignore";
  if (options.isFullscreen) return "defer-fullscreen";
  return options.hasSession ? "candidate" : "initial-load";
}

export function isAutoReloadCandidateCurrent(options: {
  aborted: boolean;
  currentGeneration: number;
  currentToken: string | null;
  generation: number;
  previousToken: string;
}): boolean {
  return !options.aborted
    && options.generation === options.currentGeneration
    && options.currentToken === options.previousToken;
}
