import path from "node:path";

const MAX_LOCATION_COMPONENT_CHARACTERS = 4_096;
const MAX_SCROLL_OFFSET = 10_000_000;

export interface BridgePageState {
  hash?: string;
  pathname?: string;
  scrollX?: number;
  scrollY?: number;
  search?: string;
}

export interface PreviewReadingState {
  hash: string;
  scrollX: number;
  scrollY: number;
  search: string;
  vaultRelativePath: string;
}

export function parseBridgePageState(
  resourceScopePath: string,
  value: BridgePageState
): PreviewReadingState | null {
  if (typeof value.pathname !== "string" || value.pathname.length > MAX_LOCATION_COMPONENT_CHARACTERS) {
    return null;
  }
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(value.pathname).replace(/^\/+/, "");
  } catch {
    return null;
  }
  if (!decodedPath || decodedPath.includes("\0") || decodedPath.includes("\\")) return null;
  const pathSegments = decodedPath.split("/");
  if (pathSegments.includes("..")) return null;

  const scope = normalizeVaultPath(resourceScopePath);
  const relativePath = normalizeVaultPath(decodedPath);
  const vaultRelativePath = normalizeVaultPath(path.posix.join(scope, relativePath));
  if (!isPathWithinScope(vaultRelativePath, scope)) return null;

  const search = sanitizeSearch(value.search);
  const hash = sanitizeHash(value.hash);
  if (search === null || hash === null) return null;
  return {
    hash,
    scrollX: normalizeScrollOffset(value.scrollX),
    scrollY: normalizeScrollOffset(value.scrollY),
    search,
    vaultRelativePath
  };
}

export function buildReadingStateUrl(
  entryUrl: string,
  resourceScopePath: string,
  state: PreviewReadingState | null
): string {
  if (!state || !isReadingStateRestorable(resourceScopePath, state)) return entryUrl;
  const scope = normalizeVaultPath(resourceScopePath);
  const target = normalizeVaultPath(state.vaultRelativePath);
  const relativePath = path.posix.relative(scope, target);

  const url = new URL(entryUrl);
  url.pathname = `/${relativePath.split("/").map(segment => encodeURIComponent(segment)).join("/")}`;
  url.search = state.search;
  url.hash = state.hash;
  return url.toString();
}

export function isReadingStateRestorable(
  resourceScopePath: string,
  state: PreviewReadingState | null
): state is PreviewReadingState {
  if (!state) return false;
  const scope = normalizeVaultPath(resourceScopePath);
  const target = normalizeVaultPath(state.vaultRelativePath);
  if (!target || !isPathWithinScope(target, scope)) return false;
  const relativePath = path.posix.relative(scope, target);
  return Boolean(relativePath && relativePath !== ".." && !relativePath.startsWith("../"));
}

export function isSameReadingLocation(
  left: PreviewReadingState,
  right: PreviewReadingState
): boolean {
  return left.vaultRelativePath === right.vaultRelativePath
    && left.search === right.search
    && left.hash === right.hash;
}

function sanitizeSearch(value: string | undefined): string | null {
  if (value === undefined || value === "") return "";
  if (!value.startsWith("?") || value.length > MAX_LOCATION_COMPONENT_CHARACTERS) return null;
  return value;
}

function sanitizeHash(value: string | undefined): string | null {
  if (value === undefined || value === "") return "";
  if (!value.startsWith("#") || value.length > MAX_LOCATION_COMPONENT_CHARACTERS) return null;
  return value;
}

function normalizeScrollOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_SCROLL_OFFSET, Math.floor(value)));
}

function normalizeVaultPath(value: string): string {
  return value.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean).join("/");
}

function isPathWithinScope(candidate: string, scope: string): boolean {
  if (!scope) return candidate !== ".." && !candidate.startsWith("../");
  return candidate === scope || candidate.startsWith(`${scope}/`);
}
