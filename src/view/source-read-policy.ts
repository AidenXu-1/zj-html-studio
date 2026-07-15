export interface SourceReadState {
  currentFilePath: string | null;
  currentLoadGeneration: number;
  currentRequestGeneration: number;
  filePath: string;
  loadGeneration: number;
  requestGeneration: number;
}

export function isSourceReadCurrent(state: SourceReadState): boolean {
  return state.requestGeneration === state.currentRequestGeneration
    && state.loadGeneration === state.currentLoadGeneration
    && state.filePath === state.currentFilePath;
}
