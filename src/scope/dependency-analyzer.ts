import type { Stats } from "node:fs";
import { realpath, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isPathInside, toVaultRelativePath } from "../server/path-safety";
import { openVerifiedFile, VerifiedFileError } from "../server/verified-file";
import { scanHtmlDocument, type HtmlScanResult } from "./bounded-html-parser";
import {
  scanCssReferences,
  scanJavaScriptReferences,
  type TextReferenceScanResult
} from "./bounded-reference-scanner";

const TEXT_DEPENDENCY_EXTENSIONS = new Set([".css", ".htm", ".html", ".js", ".mjs"]);
const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_REFERENCES_PER_FILE = 2_000;
const DEFAULT_MAX_TOTAL_REFERENCES = 2_000;
const DEFAULT_MAX_STORED_REFERENCE_CHARACTERS = 1 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_TEXT_BYTES = 25 * 1024 * 1024;
export const MAX_REFERENCE_CHARACTERS = 16 * 1024;
const FILE_READ_CHUNK_BYTES = 64 * 1024;
const MAX_ROOT_ABSOLUTE_FILESYSTEM_PROBES = 256;

export interface ScopeAnalysisOptions {
  maxHtmlScanCharacters?: number;
  maxFileBytes?: number;
  maxFiles?: number;
  maxReferencesPerFile?: number;
  maxStoredReferenceCharacters?: number;
  maxTotalReferences?: number;
  maxTotalTextBytes?: number;
  signal?: AbortSignal;
}

export type PageScriptAnalysisReason = "complete" | "file-too-large" | "budget-exhausted";

export interface PageScriptAnalysis {
  /** When false, pageScriptCount is only a lower bound from the scanned prefix. */
  complete: boolean;
  reason: PageScriptAnalysisReason;
  scannedCharacters: number;
}

export interface DependencyScopeAnalysis {
  /** False means the returned scope was conservatively widened because some references were not inspected. */
  complete: boolean;
  reason: PageScriptAnalysisReason;
  scannedBytes: number;
}

export interface ScopeAnalysis {
  absoluteReferences: string[];
  climbLevels: number;
  dependencyRelativePaths: string[];
  dependencyScopeAnalysis: DependencyScopeAnalysis;
  entryByteSize: number;
  entryRelativePath: string;
  escapedReferences: string[];
  externalReferences: string[];
  missingReferences: string[];
  pageScriptAnalysis: PageScriptAnalysis;
  /** Executable entry points: script elements, on* handlers, and executable javascript: URLs. */
  pageScriptCount: number;
  requiresConfirmation: boolean;
  scopeRelativePath: string;
  warnings: string[];
}

interface PendingFile {
  absolutePath: string;
  sourceReference: string;
}

interface BoundedTextRead {
  byteLength: number;
  content?: string;
  exceeded: boolean;
}

interface RootAbsoluteResolutionState {
  exhausted: boolean;
  inferredRoot: string | null;
  probes: number;
}

export interface ReferenceGroups {
  baseHref?: string;
  htmlScan?: HtmlScanResult;
  textScan?: TextReferenceScanResult;
  local: string[];
  external: string[];
  absolute: string[];
  referenceCount: number;
  storageTruncated: boolean;
  storedReferenceCharacters: number;
}

export async function analyzePreviewScope(
  vaultRoot: string,
  entryRelativePath: string,
  options: ScopeAnalysisOptions = {}
): Promise<ScopeAnalysis> {
  const maxFiles = normalizeBoundedLimit(options.maxFiles, DEFAULT_MAX_FILES);
  const maxFileBytes = normalizeBoundedLimit(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  const maxReferencesPerFile = normalizeBoundedLimit(
    options.maxReferencesPerFile,
    DEFAULT_MAX_REFERENCES_PER_FILE
  );
  const maxTotalReferences = normalizeBoundedLimit(options.maxTotalReferences, DEFAULT_MAX_TOTAL_REFERENCES);
  const maxStoredReferenceCharacters = normalizeBoundedLimit(
    options.maxStoredReferenceCharacters,
    DEFAULT_MAX_STORED_REFERENCE_CHARACTERS
  );
  const maxTotalTextBytes = normalizeBoundedLimit(options.maxTotalTextBytes, DEFAULT_MAX_TOTAL_TEXT_BYTES);
  const maxHtmlScanCharacters = normalizeBoundedLimit(options.maxHtmlScanCharacters, maxFileBytes);
  throwIfAborted(options.signal);
  const vaultRootRealPath = await realpath(vaultRoot);
  throwIfAborted(options.signal);
  const entryCandidate = path.resolve(vaultRootRealPath, entryRelativePath);
  const entryAbsolutePath = await realpath(entryCandidate);
  throwIfAborted(options.signal);
  if (!isPathInside(vaultRootRealPath, entryAbsolutePath)) {
    throw new Error("HTML 文件不在当前仓库内");
  }
  const entryStats = await stat(entryAbsolutePath);
  if (!entryStats.isFile()) throw new Error("HTML 文件不在当前仓库内");
  let entryByteSize = entryStats.size;

  const entryDirectory = path.dirname(entryAbsolutePath);
  const entryExtension = path.extname(entryAbsolutePath).toLowerCase();
  const entryIsHtml = entryExtension === ".html" || entryExtension === ".htm";
  const queue: PendingFile[] = [{ absolutePath: entryAbsolutePath, sourceReference: entryRelativePath }];
  let queueIndex = 0;
  const visited = new Set<string>();
  const dependencyPaths = new Set<string>([entryAbsolutePath]);
  const scopeCandidates = new Set<string>([entryAbsolutePath]);
  const externalReferences = new Set<string>();
  const absoluteReferences = new Set<string>();
  const escapedReferences = new Set<string>();
  const missingReferences = new Set<string>();
  const warnings = new Set<string>();
  let stoppedByBudget = false;
  let pageScriptCount = 0;
  let pageScriptAnalysis: PageScriptAnalysis = entryIsHtml
    ? { complete: false, reason: "budget-exhausted", scannedCharacters: 0 }
    : { complete: true, reason: "complete", scannedCharacters: 0 };
  let totalReferences = 0;
  let totalStoredReferenceCharacters = 0;
  let totalTextBytes = 0;
  let dependencyScopeAnalysis: DependencyScopeAnalysis = {
    complete: true,
    reason: "complete",
    scannedBytes: 0
  };
  const rootAbsoluteResolution: RootAbsoluteResolutionState = {
    exhausted: false,
    inferredRoot: null,
    probes: 0
  };

  while (queueIndex < queue.length && visited.size < maxFiles) {
    throwIfAborted(options.signal);
    const pending = queue[queueIndex];
    queueIndex += 1;
    if (!pending || visited.has(pending.absolutePath)) continue;
    visited.add(pending.absolutePath);

    const extension = path.extname(pending.absolutePath).toLowerCase();
    if (!TEXT_DEPENDENCY_EXTENSIONS.has(extension)) continue;

    let fileHandle: FileHandle;
    let verifiedFileStats: Stats;
    try {
      const verifiedFile = await openVerifiedFile(pending.absolutePath, vaultRootRealPath);
      fileHandle = verifiedFile.fileHandle;
      verifiedFileStats = verifiedFile.fileStats;
    } catch (error) {
      if (error instanceof VerifiedFileError && error.reason === "outside-scope") {
        escapedReferences.add(pending.sourceReference);
        dependencyScopeAnalysis = markScopeAnalysisIncomplete(dependencyScopeAnalysis, "budget-exhausted");
        continue;
      }
      missingReferences.add(toVaultRelativePath(vaultRootRealPath, pending.absolutePath));
      continue;
    }
    let content: string;
    let stopAfterCurrentFile = false;
    let currentFileExceededReason: Exclude<PageScriptAnalysisReason, "complete"> | null = null;
    try {
      throwIfAborted(options.signal);
      const fileStats = verifiedFileStats;
      throwIfAborted(options.signal);
      if (!fileStats.isFile()) {
        missingReferences.add(toVaultRelativePath(vaultRootRealPath, pending.absolutePath));
        continue;
      }
      if (pending.absolutePath === entryAbsolutePath) entryByteSize = fileStats.size;

      const remainingTextBytes = maxTotalTextBytes - totalTextBytes;
      if (remainingTextBytes <= 0) {
        warnings.add(`文本依赖总大小达到 ${formatMiB(maxTotalTextBytes)} MiB 上限，已停止继续扫描`);
        dependencyScopeAnalysis = markScopeAnalysisIncomplete(dependencyScopeAnalysis, "budget-exhausted");
        stoppedByBudget = true;
        break;
      }

      const remainingReferenceBudget = maxTotalReferences - totalReferences;
      if (remainingReferenceBudget <= 0) {
        warnings.add(`资源地址总数达到 ${maxTotalReferences} 个上限，已停止继续收集`);
        dependencyScopeAnalysis = markScopeAnalysisIncomplete(dependencyScopeAnalysis, "budget-exhausted");
        stoppedByBudget = true;
        break;
      }

      const allowedReadBytes = Math.min(maxFileBytes, remainingTextBytes);
      const boundedRead = await readTextFileHandleWithinBudget(fileHandle, allowedReadBytes, options.signal);
      if (boundedRead.exceeded) {
        const latestStats = await fileHandle.stat();
        if (pending.absolutePath === entryAbsolutePath) {
          entryByteSize = Math.max(entryByteSize, latestStats.size, boundedRead.byteLength);
        }
        if (maxFileBytes <= remainingTextBytes) {
          currentFileExceededReason = "file-too-large";
          warnings.add(`文本依赖过大，只扫描前 ${formatMiB(maxFileBytes)} MiB：${toVaultRelativePath(vaultRootRealPath, pending.absolutePath)}`);
          dependencyScopeAnalysis = markScopeAnalysisIncomplete(dependencyScopeAnalysis, "file-too-large");
        } else {
          currentFileExceededReason = "budget-exhausted";
          warnings.add(`文本依赖总大小达到 ${formatMiB(maxTotalTextBytes)} MiB 上限，已停止继续扫描`);
          dependencyScopeAnalysis = markScopeAnalysisIncomplete(dependencyScopeAnalysis, "budget-exhausted");
          stoppedByBudget = true;
          stopAfterCurrentFile = true;
        }
      }
      if (boundedRead.content === undefined) throw new Error("读取文本依赖失败");
      content = boundedRead.content;
      const scannedBytes = Math.min(boundedRead.byteLength, allowedReadBytes);
      totalTextBytes += scannedBytes;
      dependencyScopeAnalysis.scannedBytes += scannedBytes;
    } finally {
      await fileHandle.close();
    }

    const remainingReferenceBudget = maxTotalReferences - totalReferences;
    const fileReferenceBudget = Math.min(maxReferencesPerFile, remainingReferenceBudget);
    if (content.length >= 256 * 1024) await yieldForCancellation(options.signal);
    throwIfAborted(options.signal);
    const references = extractReferences(
      content,
      extension,
      fileReferenceBudget,
      maxHtmlScanCharacters,
      options.signal,
      Math.max(0, maxStoredReferenceCharacters - totalStoredReferenceCharacters)
    );
    throwIfAborted(options.signal);
    if (references.htmlScan && !references.htmlScan.complete) {
      warnings.add(`HTML 结构扫描达到 ${maxHtmlScanCharacters} 个字符上限；脚本数量和资源地址只代表已扫描部分`);
      dependencyScopeAnalysis = markScopeAnalysisIncomplete(dependencyScopeAnalysis, "budget-exhausted");
    }
    if (references.htmlScan && !references.htmlScan.scriptCountComplete) {
      warnings.add("页面脚本入口达到计数上限；脚本数量只代表已发现下限");
    }
    if (references.textScan && !references.textScan.complete) {
      warnings.add(`文本引用扫描达到 ${maxHtmlScanCharacters} 个字符上限；资源地址只代表已扫描部分`);
      dependencyScopeAnalysis = markScopeAnalysisIncomplete(dependencyScopeAnalysis, "budget-exhausted");
    }
    if (pending.absolutePath === entryAbsolutePath && entryIsHtml && references.htmlScan) {
      pageScriptCount = references.htmlScan.pageScriptCount;
      pageScriptAnalysis = {
        complete: currentFileExceededReason === null
          && references.htmlScan.complete
          && references.htmlScan.scriptCountComplete,
        reason: currentFileExceededReason
          ? currentFileExceededReason
          : references.htmlScan.complete && references.htmlScan.scriptCountComplete
          ? "complete"
          : "budget-exhausted",
        scannedCharacters: references.htmlScan.scannedCharacters
      };
    }
    const referenceCount = references.referenceCount;
    totalReferences += referenceCount;
    totalStoredReferenceCharacters += references.storedReferenceCharacters;
    if (references.storageTruncated) {
      warnings.add(`资源地址文字达到 ${maxStoredReferenceCharacters} 个字符总上限，或单条地址超过 ${MAX_REFERENCE_CHARACTERS} 个字符；过长地址未保留，资源范围已保守收紧`);
      dependencyScopeAnalysis = markScopeAnalysisIncomplete(dependencyScopeAnalysis, "budget-exhausted");
      stoppedByBudget = true;
      stopAfterCurrentFile = true;
    }
    if (referenceCount >= fileReferenceBudget) {
      warnings.add(`单个文件的资源地址达到 ${fileReferenceBudget} 个上限，已停止继续收集这个文件的其余地址`);
      dependencyScopeAnalysis = markScopeAnalysisIncomplete(dependencyScopeAnalysis, "budget-exhausted");
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
        const resolvedBase = await findExistingRootAbsoluteDependency(
          vaultRootRealPath,
          entryDirectory,
          baseHref,
          rootAbsoluteResolution,
          options.signal
        );
        if (resolvedBase) {
          scopeCandidates.add(resolvedBase);
          referenceDirectory = isDirectoryStyleBase(stripQueryAndHash(baseHref))
            ? resolvedBase
            : path.dirname(resolvedBase);
        }
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
        dependencyScopeAnalysis = markScopeAnalysisIncomplete(dependencyScopeAnalysis, "budget-exhausted");
        stoppedByBudget = true;
        break;
      }
      if (stopAfterCurrentFile) break;
      continue;
    }

    for (const reference of references.absolute) {
      absoluteReferences.add(reference);
      const dependencyPath = await findExistingRootAbsoluteDependency(
        vaultRootRealPath,
        entryDirectory,
        reference,
        rootAbsoluteResolution,
        options.signal
      );
      if (!dependencyPath) continue;
      dependencyPaths.add(dependencyPath);
      scopeCandidates.add(dependencyPath);
      const displayPath = toVaultRelativePath(vaultRootRealPath, dependencyPath);
      queue.push({ absolutePath: dependencyPath, sourceReference: displayPath });
    }
    if (rootAbsoluteResolution.exhausted) {
      warnings.add(`网站根路径探测达到 ${MAX_ROOT_ABSOLUTE_FILESYSTEM_PROBES} 次上限，已停止继续推断站点根目录`);
      dependencyScopeAnalysis = markScopeAnalysisIncomplete(dependencyScopeAnalysis, "budget-exhausted");
    }

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
      const displayPath = toVaultRelativePath(vaultRootRealPath, dependencyPath);

      if (!exists) {
        missingReferences.add(displayPath);
        continue;
      }

      queue.push({ absolutePath: dependencyPath, sourceReference: displayPath });
    }

    if (totalReferences >= maxTotalReferences) {
      warnings.add(`资源地址总数达到 ${maxTotalReferences} 个上限，已停止继续收集`);
      dependencyScopeAnalysis = markScopeAnalysisIncomplete(dependencyScopeAnalysis, "budget-exhausted");
      stoppedByBudget = true;
      break;
    }
    if (stopAfterCurrentFile) break;
  }

  if (queueIndex < queue.length && !stoppedByBudget) {
    warnings.add(`依赖数量超过 ${maxFiles} 个，已停止继续扫描`);
    dependencyScopeAnalysis = markScopeAnalysisIncomplete(dependencyScopeAnalysis, "budget-exhausted");
  }

  if (!dependencyScopeAnalysis.complete) {
    warnings.add("资源分析未完成；为避免大文件出现无法恢复的缺图或缺样式，确认后将使用整个知识仓库作为保守资源范围");
  }
  const scopeAbsolutePath = dependencyScopeAnalysis.complete
    ? findCommonDirectory([...scopeCandidates])
    : vaultRootRealPath;
  if (!isPathInside(vaultRootRealPath, scopeAbsolutePath)) {
    throw new Error("计算出的预览范围超出了当前仓库");
  }

  const relativeFromScope = path.relative(scopeAbsolutePath, entryDirectory);
  const climbLevels = relativeFromScope === ""
    ? 0
    : relativeFromScope.split(path.sep).filter(Boolean).length;
  const scopeRelativePath = toVaultRelativePath(vaultRootRealPath, scopeAbsolutePath);
  const requiresConfirmation = scopeRelativePath === ""
    || climbLevels > 1
    || escapedReferences.size > 0
    || absoluteReferences.size > 0;

  return {
    entryRelativePath: toVaultRelativePath(vaultRootRealPath, entryAbsolutePath),
    entryByteSize,
    scopeRelativePath,
    climbLevels,
    requiresConfirmation,
    dependencyRelativePaths: sortStrings([...dependencyPaths].map(dependency => toVaultRelativePath(vaultRootRealPath, dependency))),
    dependencyScopeAnalysis,
    externalReferences: sortStrings(externalReferences),
    absoluteReferences: sortStrings(absoluteReferences),
    escapedReferences: sortStrings(escapedReferences),
    missingReferences: sortStrings(missingReferences),
    pageScriptAnalysis,
    pageScriptCount,
    warnings: sortStrings(warnings)
  };
}

export function countHtmlExecutableScriptEntries(content: string): number {
  return scanHtmlDocument(content, { maxReferences: 0 }).pageScriptCount;
}

/** @deprecated Use countHtmlExecutableScriptEntries for the precise semantics. */
export function countHtmlScriptElements(content: string): number {
  return countHtmlExecutableScriptEntries(content);
}

export function extractReferences(
  content: string,
  extension: string,
  maxReferences = Number.POSITIVE_INFINITY,
  maxHtmlScanCharacters = DEFAULT_MAX_FILE_BYTES,
  signal?: AbortSignal,
  maxStoredReferenceCharacters = DEFAULT_MAX_STORED_REFERENCE_CHARACTERS
): ReferenceGroups {
  const references = new Set<string>();
  const normalizedExtension = extension.toLowerCase();
  let rawBaseHref: string | undefined;
  let htmlScan: HtmlScanResult | undefined;
  let textScan: TextReferenceScanResult | undefined;

  if (normalizedExtension === ".html" || normalizedExtension === ".htm") {
    htmlScan = scanHtmlDocument(content, {
      maxCharacters: maxHtmlScanCharacters,
      maxReferences,
      signal
    });
    rawBaseHref = htmlScan.baseHref;
  }
  const resourceReferenceLimit = Math.max(0, maxReferences - (rawBaseHref ? 1 : 0));

  if (htmlScan) {
    for (const reference of htmlScan.resourceReferences) {
      if (references.size >= resourceReferenceLimit) break;
      references.add(reference);
    }
  }
  if (normalizedExtension === ".css") {
    textScan = scanCssReferences(content, {
      maxCharacters: maxHtmlScanCharacters,
      maxReferences: resourceReferenceLimit,
      signal
    });
  } else if (normalizedExtension === ".js" || normalizedExtension === ".mjs") {
    textScan = scanJavaScriptReferences(content, {
      maxCharacters: maxHtmlScanCharacters,
      maxReferences: resourceReferenceLimit,
      signal
    });
  }
  if (textScan) {
    for (const reference of textScan.references) {
      if (references.size >= resourceReferenceLimit) break;
      references.add(reference);
    }
  }

  const local: string[] = [];
  const external: string[] = [];
  const absolute: string[] = [];
  const storedCharacterLimit = Math.max(0, Math.floor(maxStoredReferenceCharacters));
  let storedReferenceCharacters = 0;
  let storageTruncated = false;
  let baseHref: string | undefined;

  const storeReference = (reference: string): boolean => {
    if (
      reference.length > MAX_REFERENCE_CHARACTERS
      || reference.length > storedCharacterLimit - storedReferenceCharacters
    ) {
      storageTruncated = true;
      return false;
    }
    storedReferenceCharacters += reference.length;
    return true;
  };

  if (rawBaseHref !== undefined) {
    const normalizedBaseHref = rawBaseHref.trim();
    if (normalizedBaseHref && storeReference(normalizedBaseHref)) baseHref = normalizedBaseHref;
  }

  for (const rawReference of references) {
    const reference = rawReference.trim();
    if (!reference || reference.startsWith("#")) continue;
    if (/^(?:about|blob|data|javascript):/i.test(reference)) continue;
    if (!storeReference(reference)) continue;
    if (reference.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(reference)) {
      external.push(reference);
    } else if (reference.startsWith("/")) {
      absolute.push(reference);
    } else if (reference.startsWith(".") || reference.includes("/") || hasAssetLikeExtension(reference)) {
      local.push(reference);
    }
  }

  return {
    ...(baseHref === undefined ? {} : { baseHref }),
    ...(htmlScan === undefined ? {} : { htmlScan }),
    ...(textScan === undefined ? {} : { textScan }),
    local: sortStrings(local),
    external: sortStrings(external),
    absolute: sortStrings(absolute),
    referenceCount: references.size + (rawBaseHref ? 1 : 0),
    storageTruncated,
    storedReferenceCharacters
  };
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

function normalizeBoundedLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(fallback, Math.max(0, Math.floor(value)));
}

export async function readTextFileHandleWithinBudget(
  fileHandle: FileHandle,
  maxBytes: number,
  signal: AbortSignal | undefined
): Promise<BoundedTextRead> {
  const byteLimit = Math.max(0, Math.floor(maxBytes));
  const buffer = Buffer.allocUnsafe(byteLimit + 1);
  let byteLength = 0;
  while (byteLength < buffer.length) {
    throwIfAborted(signal);
    const length = Math.min(FILE_READ_CHUNK_BYTES, buffer.length - byteLength);
    const result = await fileHandle.read(buffer, byteLength, length, byteLength);
    throwIfAborted(signal);
    if (result.bytesRead === 0) break;
    byteLength += result.bytesRead;
  }
  if (byteLength > byteLimit) {
    return {
      byteLength,
      content: buffer.subarray(0, byteLimit).toString("utf8"),
      exceeded: true
    };
  }
  return {
    byteLength,
    content: buffer.subarray(0, byteLength).toString("utf8"),
    exceeded: false
  };
}

function markScopeAnalysisIncomplete(
  current: DependencyScopeAnalysis,
  reason: Exclude<PageScriptAnalysisReason, "complete">
): DependencyScopeAnalysis {
  return {
    ...current,
    complete: false,
    reason: current.reason === "budget-exhausted" || reason === "budget-exhausted"
      ? "budget-exhausted"
      : "file-too-large"
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Preview analysis aborted", "AbortError");
}

async function yieldForCancellation(signal: AbortSignal | undefined): Promise<void> {
  await delay(0, undefined, signal ? { signal } : undefined);
  throwIfAborted(signal);
}

async function findExistingRootAbsoluteDependency(
  vaultRoot: string,
  entryDirectory: string,
  reference: string,
  state: RootAbsoluteResolutionState,
  signal: AbortSignal | undefined
): Promise<string | null> {
  const cleanReference = stripQueryAndHash(reference);
  const decodedReference = safeDecodeURIComponent(cleanReference).replace(/^[/\\]+/, "");
  if (!decodedReference || decodedReference.split(/[\\/]/).includes("..")) return null;

  let candidateRoot = state.inferredRoot ?? entryDirectory;
  while (isPathInside(vaultRoot, candidateRoot)) {
    throwIfAborted(signal);
    if (state.probes >= MAX_ROOT_ABSOLUTE_FILESYSTEM_PROBES) {
      state.exhausted = true;
      return null;
    }
    state.probes += 1;
    const candidate = path.resolve(candidateRoot, decodedReference);
    if (isPathInside(candidateRoot, candidate)) {
      try {
        const resolved = await realpath(candidate);
        throwIfAborted(signal);
        if (isPathInside(vaultRoot, resolved)) {
          state.inferredRoot ??= candidateRoot;
          return resolved;
        }
      } catch {
        // Try the next project-root candidate. A site may live below the vault root.
      }
    }
    if (state.inferredRoot || candidateRoot === vaultRoot) break;
    const parent = path.dirname(candidateRoot);
    if (parent === candidateRoot) break;
    candidateRoot = parent;
  }
  return null;
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

function sortStrings(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}
