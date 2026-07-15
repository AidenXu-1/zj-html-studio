export type InterruptedEmbedLoadAction = "continue" | "ignore" | "release";
export type EmbedReloadAction = "defer" | "ignore" | "reload";

export interface InterruptedEmbedLoadState {
  currentGeneration: number;
  generation: number;
  isVisible: boolean;
  unloaded: boolean;
}

export interface EmbedActivityState {
  acquiring: boolean;
  hasSession: boolean;
  hasSlot: boolean;
}

export function decideInterruptedEmbedLoad(state: InterruptedEmbedLoadState): InterruptedEmbedLoadAction {
  if (state.generation !== state.currentGeneration) return "ignore";
  if (state.unloaded || !state.isVisible) return "release";
  return "continue";
}

export function hasActiveEmbedWork(state: EmbedActivityState): boolean {
  return state.acquiring || state.hasSession || state.hasSlot;
}

export function decideEmbedReload(autoReload: boolean, isVisible: boolean, hasSlot: boolean): EmbedReloadAction {
  if (!autoReload) return "ignore";
  if (!isVisible || !hasSlot) return "defer";
  return "reload";
}
