import type { ScopeAnalysis } from "../scope/dependency-analyzer";
import type { PreviewMode } from "../settings";
import type { PreviewDiagnostic } from "../server/preview-server";

export type DiagnosticLevel = "error" | "warning";

export interface DisplayDiagnostic {
  detail?: string;
  level: DiagnosticLevel;
  requestedPath?: string;
  resolvedPath?: string;
  scopeExpansionCandidatePath?: string;
  title: string;
}

/** Display only: preserve reserved separators, malformed URLs and control bytes. */
export function formatDiagnosticRequestPath(value: string): string {
  try {
    const decoded = decodeURI(value);
    return /[\p{Cc}\p{Cf}]/u.test(decoded) ? value : decoded;
  } catch {
    return value;
  }
}

export interface ScriptRestrictionPresentation {
  detail: string;
  title: string;
}

export function getScriptRestrictionPresentation(
  analysis: ScopeAnalysis,
  mode: PreviewMode = "safe"
): ScriptRestrictionPresentation | null {
  if (mode !== "safe") return null;

  if (analysis.pageScriptAnalysis.complete && analysis.pageScriptCount === 0) return null;
  return { title: "此页面已设为仅查看", detail: "按钮、翻页和动画暂未运行，可恢复正常打开。" };
}

export function formatDisplayDiagnosticResolvedPath(
  diagnostic: DisplayDiagnostic,
  formatPath: (value: string) => string
): DisplayDiagnostic {
  if (!diagnostic.resolvedPath) return diagnostic;
  return {
    ...diagnostic,
    resolvedPath: formatPath(diagnostic.resolvedPath)
  };
}

export function countAnalysisDiagnostics(analysis: ScopeAnalysis, mode: PreviewMode = "safe"): number {
  return analysis.missingReferences.length
    + analysis.absoluteReferences.length
    + analysis.escapedReferences.length
    + (mode === "safe" && analysis.pageScriptCount > 0 ? 1 : 0);
}

export function buildAnalysisDiagnostics(
  analysis: ScopeAnalysis,
  maxDiagnostics = Number.POSITIVE_INFINITY,
  mode: PreviewMode = "safe"
): DisplayDiagnostic[] {
  const diagnostics: DisplayDiagnostic[] = [];
  const add = (factory: () => DisplayDiagnostic): void => {
    if (diagnostics.length < maxDiagnostics) diagnostics.push(factory());
  };

  const scriptRestriction = getScriptRestrictionPresentation(analysis, mode);
  // A bounded scan is an internal state, not a broken page. Keep runtime
  // failures actionable and describe an explicit script restriction only
  // when scripts were positively detected.
  if (scriptRestriction && analysis.pageScriptCount > 0) {
    add(() => ({
      level: "warning",
      title: scriptRestriction.title,
      detail: scriptRestriction.detail
    }));
  }

  analysis.missingReferences.forEach(reference => add(() => ({
    level: "warning",
    title: "有一个本地资源没有找到",
    requestedPath: reference,
    detail: "确认文件是否被移动、改名或尚未生成。"
  })));

  analysis.absoluteReferences.forEach(reference => add(() => ({
    level: "warning",
    title: "页面使用了网站根路径",
    requestedPath: reference,
    detail: "这个地址会从当前资源范围的根目录开始寻找。"
  })));

  analysis.escapedReferences.forEach(reference => add(() => ({
    level: "error",
    title: "资源地址超出了知识仓库",
    requestedPath: reference,
    detail: "ZJ HTML Studio 已阻止这次读取。"
  })));

  return diagnostics;
}

export function buildRuntimeDiagnostic(diagnostic: PreviewDiagnostic): DisplayDiagnostic {
  const titles: Record<PreviewDiagnostic["reason"], string> = {
    "diagnostic-limit": "页面产生了过多不同的资源错误",
    "invalid-host": "预览会话已经失效",
    "invalid-method": "页面尝试执行不允许的本地操作",
    "invalid-path": "资源地址无法解析",
    "missing-file": "有一个本地资源没有找到",
    "file-not-authorized": "这个文件需要你允许读取",
    "outside-scope": "资源超出了当前预览范围",
    "server-error": "本地预览服务发生错误"
  };

  return {
    level: diagnostic.statusCode >= 500 || diagnostic.reason === "outside-scope" ? "error" : "warning",
    title: titles[diagnostic.reason],
    requestedPath: diagnostic.requestPath,
    resolvedPath: diagnostic.resolvedPath,
    scopeExpansionCandidatePath: (diagnostic.reason === "outside-scope" || diagnostic.reason === "file-not-authorized")
      ? diagnostic.resolvedPath
      : undefined,
    detail: (diagnostic.reason === "outside-scope" || diagnostic.reason === "file-not-authorized")
      ? "课件继续显示。需要这个文件时，可以单独允许，不会开放它所在的整个文件夹。"
      : diagnostic.reason === "diagnostic-limit"
        ? "为避免 Obsidian 卡顿，后续重复或新增错误已停止逐条记录。"
        : undefined
  };
}

export function upsertDisplayDiagnostic(
  diagnostics: DisplayDiagnostic[],
  incoming: DisplayDiagnostic,
  normalizePath: (value: string) => string = value => value
): DisplayDiagnostic[] {
  const incomingKey = getDisplayDiagnosticKey(incoming, normalizePath);
  const index = diagnostics.findIndex(item => getDisplayDiagnosticKey(item, normalizePath) === incomingKey);

  if (index === -1) return [...diagnostics, incoming];

  const existing = diagnostics[index]!;
  const merged: DisplayDiagnostic = {
    ...existing,
    level: existing.level === "error" || incoming.level === "error" ? "error" : "warning",
    detail: existing.detail ?? incoming.detail,
    requestedPath: existing.requestedPath ?? incoming.requestedPath,
    resolvedPath: existing.resolvedPath ?? incoming.resolvedPath,
    scopeExpansionCandidatePath: existing.scopeExpansionCandidatePath ?? incoming.scopeExpansionCandidatePath
  };

  return diagnostics.map((item, itemIndex) => itemIndex === index ? merged : item);
}

export function getDisplayDiagnosticKey(
  diagnostic: DisplayDiagnostic,
  normalizePath: (value: string) => string
): string {
  const resourcePath = diagnostic.resolvedPath ?? diagnostic.requestedPath;
  const identity = resourcePath ? normalizePath(resourcePath) : diagnostic.detail ?? "";
  return `${diagnostic.title}\u0000${identity}`;
}
