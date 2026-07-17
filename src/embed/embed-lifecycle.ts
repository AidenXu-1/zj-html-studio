import { EmbedSessionCancelledError } from "./embed-session-limiter";

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

export class EmbedCandidateReadiness {
  private iframeLoaded = false;
  private responseFinished = false;

  get ready(): boolean {
    return this.iframeLoaded && this.responseFinished;
  }

  markIframeLoaded(): void {
    this.iframeLoaded = true;
  }

  markResponseFinished(): void {
    this.responseFinished = true;
  }
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

export async function createVerifiedEmbedSession<T>(
  create: () => Promise<T>,
  verify: (session: T) => Promise<void>,
  revoke: (session: T) => Promise<void>,
  isCurrent: () => boolean = () => true
): Promise<T> {
  const session = await create();
  try {
    if (!isCurrent()) throw new EmbedSessionCancelledError();
    await verify(session);
    if (!isCurrent()) throw new EmbedSessionCancelledError();
    return session;
  } catch (error) {
    await revoke(session);
    throw error;
  }
}
