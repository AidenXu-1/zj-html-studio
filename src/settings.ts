export type PreviewMode = "safe" | "trusted";

export interface HtmlStudioSettings {
  autoReload: boolean;
  safeScopes: string[];
  trustedScopes: string[];
}

export const DEFAULT_SETTINGS: HtmlStudioSettings = {
  autoReload: true,
  safeScopes: [],
  trustedScopes: []
};

export class SerializedSettingsUpdater<T> {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly getCurrent: () => T,
    private readonly save: (next: T) => Promise<void>,
    private readonly commit: (next: T) => void
  ) {}

  update(mutator: (current: T) => T): Promise<void> {
    const operation = this.tail.then(async () => {
      const next = mutator(this.getCurrent());
      await this.save(next);
      this.commit(next);
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }
}

export function normalizeScopePath(scopePath: string): string {
  const segments = scopePath
    .replaceAll("\\", "/")
    .split("/")
    .filter(segment => segment !== "" && segment !== ".");
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === "..") {
      if (normalized.length === 0) return "";
      normalized.pop();
    } else {
      normalized.push(segment);
    }
  }
  return normalized.join("/");
}

export function isScopeTrusted(
  scopePath: string,
  trustedScopes: readonly string[],
  safeScopes: readonly string[] = []
): boolean {
  const normalizedScope = normalizeScopePath(scopePath);
  if (!normalizedScope) return false;

  const trustedDepth = deepestMatchingScope(normalizedScope, trustedScopes);
  const safeDepth = deepestMatchingScope(normalizedScope, safeScopes);
  return trustedDepth >= 0 && trustedDepth > safeDepth;
}

export function addTrustedScope(
  scopePath: string,
  trustedScopes: readonly string[],
  safeScopes: readonly string[] = []
): string[] {
  const normalizedScope = normalizeScopePath(scopePath);
  if (!normalizedScope) return [...trustedScopes];
  if (trustedScopes.some(existing => normalizeScopePath(existing) === normalizedScope)) return [...trustedScopes];

  return [
    ...trustedScopes.filter(existing => normalizeScopePath(existing) !== normalizedScope),
    normalizedScope
  ].sort((left, right) => left.localeCompare(right));
}

export function removeTrustedScope(scopePath: string, trustedScopes: readonly string[]): string[] {
  const normalizedScope = normalizeScopePath(scopePath);
  return trustedScopes.filter(existing => normalizeScopePath(existing) !== normalizedScope);
}

export function addSafeScope(
  scopePath: string,
  safeScopes: readonly string[],
  trustedScopes: readonly string[] = []
): string[] {
  const normalizedScope = normalizeScopePath(scopePath);
  if (!normalizedScope) return [...safeScopes];
  if (safeScopes.some(existing => normalizeScopePath(existing) === normalizedScope)) return [...safeScopes];

  return [
    ...safeScopes.filter(existing => normalizeScopePath(existing) !== normalizedScope),
    normalizedScope
  ].sort((left, right) => left.localeCompare(right));
}

export function removeSafeScope(scopePath: string, safeScopes: readonly string[]): string[] {
  const normalizedScope = normalizeScopePath(scopePath);
  return safeScopes.filter(existing => normalizeScopePath(existing) !== normalizedScope);
}

function deepestMatchingScope(scopePath: string, candidates: readonly string[]): number {
  let deepest = -1;
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeScopePath(candidate);
    if (!normalizedCandidate) continue;
    if (scopePath !== normalizedCandidate && !scopePath.startsWith(`${normalizedCandidate}/`)) continue;
    deepest = Math.max(deepest, normalizedCandidate.split("/").length);
  }
  return deepest;
}
