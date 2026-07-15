import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "../server/path-safety";

const TEXT_DEPENDENCY_EXTENSIONS = new Set([".css", ".htm", ".html", ".js", ".mjs"]);
const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_REFERENCES_PER_FILE = 2_000;
const DEFAULT_MAX_TOTAL_REFERENCES = 2_000;
const DEFAULT_MAX_TOTAL_TEXT_BYTES = 25 * 1024 * 1024;

export interface ScopeAnalysisOptions {
  maxFileBytes?: number;
  maxFiles?: number;
  maxReferencesPerFile?: number;
  maxTotalReferences?: number;
  maxTotalTextBytes?: number;
  signal?: AbortSignal;
}

export interface ScopeAnalysis {
  absoluteReferences: string[];
  climbLevels: number;
  dependencyRelativePaths: string[];
  entryRelativePath: string;
  escapedReferences: string[];
  externalReferences: string[];
  missingReferences: string[];
  requiresConfirmation: boolean;
  scopeRelativePath: string;
  warnings: string[];
}

interface PendingFile {
  absolutePath: string;
  sourceReference: string;
}

interface ReferenceGroups {
  baseHref?: string;
  local: string[];
  external: string[];
  absolute: string[];
  referenceCount: number;
}

export async function analyzePreviewScope(
  vaultRoot: string,
  entryRelativePath: string,
  options: ScopeAnalysisOptions = {}
): Promise<ScopeAnalysis> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxReferencesPerFile = options.maxReferencesPerFile ?? DEFAULT_MAX_REFERENCES_PER_FILE;
  const maxTotalReferences = options.maxTotalReferences ?? DEFAULT_MAX_TOTAL_REFERENCES;
  const maxTotalTextBytes = options.maxTotalTextBytes ?? DEFAULT_MAX_TOTAL_TEXT_BYTES;
  throwIfAborted(options.signal);
  const vaultRootRealPath = await realpath(vaultRoot);
  throwIfAborted(options.signal);
  const entryCandidate = path.resolve(vaultRootRealPath, entryRelativePath);
  const entryAbsolutePath = await realpath(entryCandidate);
  throwIfAborted(options.signal);
  if (!isPathInside(vaultRootRealPath, entryAbsolutePath) || !(await stat(entryAbsolutePath)).isFile()) {
    throw new Error("HTML 文件不在当前仓库内");
  }

  const entryDirectory = path.dirname(entryAbsolutePath);
  const queue: PendingFile[] = [{ absolutePath: entryAbsolutePath, sourceReference: entryRelativePath }];
  const visited = new Set<string>();
  const dependencyPaths = new Set<string>([entryAbsolutePath]);
  const scopeCandidates = new Set<string>([entryAbsolutePath]);
  const externalReferences = new Set<string>();
  const absoluteReferences = new Set<string>();
  const escapedReferences = new Set<string>();
  const missingReferences = new Set<string>();
  const warnings = new Set<string>();
  let stoppedByBudget = false;
  let totalReferences = 0;
  let totalTextBytes = 0;

  while (queue.length > 0 && visited.size < maxFiles) {
    throwIfAborted(options.signal);
    const pending = queue.shift();
    if (!pending || visited.has(pending.absolutePath)) continue;
    visited.add(pending.absolutePath);

    const extension = path.extname(pending.absolutePath).toLowerCase();
    if (!TEXT_DEPENDENCY_EXTENSIONS.has(extension)) continue;

    let fileStats;
    try {
      fileStats = await stat(pending.absolutePath);
    } catch {
      missingReferences.add(toVaultDisplayPath(vaultRootRealPath, pending.absolutePath));
      continue;
    }
    throwIfAborted(options.signal);

    if (fileStats.size > maxFileBytes) {
      warnings.add(`跳过过大的文本依赖：${toVaultDisplayPath(vaultRootRealPath, pending.absolutePath)}`);
      continue;
    }

    if (totalTextBytes + fileStats.size > maxTotalTextBytes) {
      warnings.add(`文本依赖总大小达到 ${formatMiB(maxTotalTextBytes)} MiB 上限，已停止继续扫描`);
      stoppedByBudget = true;
      break;
    }

    const remainingReferenceBudget = maxTotalReferences - totalReferences;
    if (remainingReferenceBudget <= 0) {
      warnings.add(`资源地址总数达到 ${maxTotalReferences} 个上限，已停止继续收集`);
      stoppedByBudget = true;
      break;
    }

    const content = await readFile(pending.absolutePath, { encoding: "utf8", signal: options.signal });
    totalTextBytes += fileStats.size;
    const fileReferenceBudget = Math.min(maxReferencesPerFile, remainingReferenceBudget);
    const references = extractReferences(content, extension, fileReferenceBudget);
    const referenceCount = references.referenceCount;
    totalReferences += referenceCount;
    if (referenceCount >= fileReferenceBudget) {
      warnings.add(`单个文件的资源地址达到 ${fileReferenceBudget} 个上限，已停止继续收集这个文件的其余地址`);
    }
    references.external.forEach(reference => externalReferences.add(reference));

    let referenceDirectory = path.dirname(pending.absolutePath);
    let externalBase: string | null = null;
    if (references.baseHref) {
      const baseHref = references.baseHref.trim();
      if (isExternalReference(baseHref)) {
        externalBase = baseHref;
        externalReferences.add(baseHref);
      } else if (baseHref.startsWith("/")) {
        absoluteReferences.add(baseHref);
      } else {
        const cleanBase = stripQueryAndHash(baseHref);
        const decodedBase = safeDecodeURIComponent(cleanBase);
        const baseCandidate = path.resolve(referenceDirectory, decodedBase);
        if (!isPathInside(vaultRootRealPath, baseCandidate)) {
          escapedReferences.add(`${pending.sourceReference} → <base href="${baseHref}">`);
        } else {
          referenceDirectory = isDirectoryStyleBase(cleanBase) ? baseCandidate : path.dirname(baseCandidate);
        }
      }
    }

    if (externalBase) {
      [...references.local, ...references.absolute].forEach(reference => {
        try {
          externalReferences.add(new URL(reference, externalBase).href);
        } catch {
          externalReferences.add(reference);
        }
      });
      if (totalReferences >= maxTotalReferences) {
        warnings.add(`资源地址总数达到 ${maxTotalReferences} 个上限，已停止继续收集`);
        stoppedByBudget = true;
        break;
      }
      continue;
    }

    references.absolute.forEach(reference => absoluteReferences.add(reference));

    for (const reference of references.local) {
      const cleanPath = stripQueryAndHash(reference);
      if (!cleanPath) continue;

      const decodedPath = safeDecodeURIComponent(cleanPath);
      const candidate = path.resolve(referenceDirectory, decodedPath);
      if (!isPathInside(vaultRootRealPath, candidate)) {
        escapedReferences.add(`${pending.sourceReference} → ${reference}`);
        continue;
      }

      let resolved = candidate;
      let exists = true;
      try {
        resolved = await realpath(candidate);
      } catch {
        exists = false;
      }
      throwIfAborted(options.signal);

      if (exists && !isPathInside(vaultRootRealPath, resolved)) {
        escapedReferences.add(`${pending.sourceReference} → ${reference}`);
        continue;
      }

      const dependencyPath = exists ? resolved : candidate;
      dependencyPaths.add(dependencyPath);
      scopeCandidates.add(dependencyPath);
      const displayPath = toVaultDisplayPath(vaultRootRealPath, dependencyPath);

      if (!exists) {
        missingReferences.add(displayPath);
        continue;
      }

      queue.push({ absolutePath: dependencyPath, sourceReference: displayPath });
    }

    if (totalReferences >= maxTotalReferences) {
      warnings.add(`资源地址总数达到 ${maxTotalReferences} 个上限，已停止继续收集`);
      stoppedByBudget = true;
      break;
    }
  }

  if (queue.length > 0 && !stoppedByBudget) {
    warnings.add(`依赖数量超过 ${maxFiles} 个，已停止继续扫描`);
  }

  const scopeAbsolutePath = findCommonDirectory([...scopeCandidates]);
  if (!isPathInside(vaultRootRealPath, scopeAbsolutePath)) {
    throw new Error("计算出的预览范围超出了当前仓库");
  }

  const relativeFromScope = path.relative(scopeAbsolutePath, entryDirectory);
  const climbLevels = relativeFromScope === ""
    ? 0
    : relativeFromScope.split(path.sep).filter(Boolean).length;
  const scopeRelativePath = path.relative(vaultRootRealPath, scopeAbsolutePath);
  const requiresConfirmation = scopeRelativePath === ""
    || climbLevels > 1
    || escapedReferences.size > 0
    || absoluteReferences.size > 0;

  return {
    entryRelativePath: path.relative(vaultRootRealPath, entryAbsolutePath),
    scopeRelativePath,
    climbLevels,
    requiresConfirmation,
    dependencyRelativePaths: sortStrings([...dependencyPaths].map(dependency => toVaultDisplayPath(vaultRootRealPath, dependency))),
    externalReferences: sortStrings(externalReferences),
    absoluteReferences: sortStrings(absoluteReferences),
    escapedReferences: sortStrings(escapedReferences),
    missingReferences: sortStrings(missingReferences),
    warnings: sortStrings(warnings)
  };
}

export function extractReferences(
  content: string,
  extension: string,
  maxReferences = Number.POSITIVE_INFINITY
): ReferenceGroups {
  const references = new Set<string>();
  const normalizedExtension = extension.toLowerCase();
  let baseHref: string | undefined;

  if (normalizedExtension === ".html" || normalizedExtension === ".htm") {
    baseHref = firstAttributeMatch(content, /<base\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))[^>]*>/gi);
  }
  const resourceReferenceLimit = Math.max(0, maxReferences - (baseHref ? 1 : 0));

  if (normalizedExtension === ".html" || normalizedExtension === ".htm") {
    collectAttributeMatches(content, /\b(?:src|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi, references, value => [value], resourceReferenceLimit);
    collectAttributeMatches(content, /<link\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))[^>]*>/gi, references, value => [value], resourceReferenceLimit);
    collectAttributeMatches(content, /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi, references, splitSrcset, resourceReferenceLimit);
  }

  if (normalizedExtension === ".css" || normalizedExtension === ".html" || normalizedExtension === ".htm") {
    collectMatches(content, /url\(\s*["']?([^"')]+)["']?\s*\)/gi, references, value => [value], resourceReferenceLimit);
    collectMatches(content, /@import\s+(?:url\(\s*)?["']([^"']+)["']/gi, references, value => [value], resourceReferenceLimit);
  }

  if (normalizedExtension === ".js" || normalizedExtension === ".mjs" || normalizedExtension === ".html" || normalizedExtension === ".htm") {
    collectMatches(content, /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g, references, value => [value], resourceReferenceLimit);
    collectMatches(content, /\bimport\(\s*["']([^"']+)["']\s*\)/g, references, value => [value], resourceReferenceLimit);
    collectMatches(content, /\bnew\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g, references, value => [value], resourceReferenceLimit);
    collectMatches(content, /\bfetch\(\s*["']([^"']+)["']/g, references, value => [value], resourceReferenceLimit);
    collectMatches(content, /\bnew\s+(?:Shared)?Worker\(\s*["']([^"']+)["']/g, references, value => [value], resourceReferenceLimit);
  }

  const local: string[] = [];
  const external: string[] = [];
  const absolute: string[] = [];

  for (const rawReference of references) {
    const reference = rawReference.trim();
    if (!reference || reference.startsWith("#")) continue;
    if (reference.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(reference)) {
      external.push(reference);
    } else if (reference.startsWith("/")) {
      absolute.push(reference);
    } else if (reference.startsWith(".") || reference.includes("/") || hasAssetLikeExtension(reference)) {
      local.push(reference);
    }
  }

  return {
    baseHref,
    local: sortStrings(local),
    external: sortStrings(external),
    absolute: sortStrings(absolute),
    referenceCount: references.size + (baseHref ? 1 : 0)
  };
}

function collectAttributeMatches(
  content: string,
  expression: RegExp,
  target: Set<string>,
  transform: (value: string) => string[] = value => [value],
  maxReferences = Number.POSITIVE_INFINITY
): void {
  let match: RegExpExecArray | null;
  while (target.size < maxReferences && (match = expression.exec(content)) !== null) {
    const value = match[1] ?? match[2] ?? match[3];
    if (!value) continue;
    for (const reference of transform(value)) {
      if (target.size >= maxReferences) break;
      target.add(reference);
    }
  }
}

function firstAttributeMatch(content: string, expression: RegExp): string | undefined {
  const match = expression.exec(content);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function collectMatches(
  content: string,
  expression: RegExp,
  target: Set<string>,
  transform: (value: string) => string[] = value => [value],
  maxReferences = Number.POSITIVE_INFINITY
): void {
  let match: RegExpExecArray | null;
  while (target.size < maxReferences && (match = expression.exec(content)) !== null) {
    const value = match[1];
    if (!value) continue;
    for (const reference of transform(value)) {
      if (target.size >= maxReferences) break;
      target.add(reference);
    }
  }
}

function splitSrcset(value: string): string[] {
  return value
    .split(",")
    .map(candidate => candidate.trim().split(/\s+/, 1)[0] ?? "")
    .filter(Boolean);
}

function stripQueryAndHash(reference: string): string {
  return reference.split(/[?#]/, 1)[0] ?? "";
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function hasAssetLikeExtension(reference: string): boolean {
  const cleanReference = stripQueryAndHash(reference);
  return path.posix.extname(cleanReference) !== "";
}

function isExternalReference(reference: string): boolean {
  return reference.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(reference);
}

function isDirectoryStyleBase(reference: string): boolean {
  return reference === "" || reference.endsWith("/") || /(?:^|\/)\.{1,2}$/.test(reference);
}

function formatMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(Number.isInteger(bytes / (1024 * 1024)) ? 0 : 1);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Preview analysis aborted", "AbortError");
}

function findCommonDirectory(paths: string[]): string {
  const directories = paths.map(candidate => path.dirname(candidate));
  let common = directories[0];
  if (!common) throw new Error("没有可用于计算预览范围的路径");

  for (const directory of directories.slice(1)) {
    while (!isPathInside(common, directory)) {
      const parent = path.dirname(common);
      if (parent === common) return common;
      common = parent;
    }
  }
  return common;
}

function toVaultDisplayPath(vaultRoot: string, absolutePath: string): string {
  return path.relative(vaultRoot, absolutePath).split(path.sep).join("/");
}

function sortStrings(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}
