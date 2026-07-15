import type { ScopeAnalysis } from "../scope/dependency-analyzer";
import type { PreviewDiagnostic } from "../server/preview-server";

export type DiagnosticLevel = "error" | "warning";

export interface DisplayDiagnostic {
  detail?: string;
  level: DiagnosticLevel;
  requestedPath?: string;
  resolvedPath?: string;
  title: string;
}

export function countAnalysisDiagnostics(analysis: ScopeAnalysis): number {
  return analysis.missingReferences.length
    + analysis.absoluteReferences.length
    + analysis.escapedReferences.length
    + analysis.warnings.length;
}

export function buildAnalysisDiagnostics(
  analysis: ScopeAnalysis,
  maxDiagnostics = Number.POSITIVE_INFINITY
): DisplayDiagnostic[] {
  const diagnostics: DisplayDiagnostic[] = [];
  const add = (factory: () => DisplayDiagnostic): void => {
    if (diagnostics.length < maxDiagnostics) diagnostics.push(factory());
  };

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

  analysis.warnings.forEach(warning => add(() => ({
    level: "warning",
    title: "依赖分析没有完全覆盖",
    detail: warning
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
    "outside-scope": "资源超出了当前预览范围",
    "server-error": "本地预览服务发生错误"
  };

  return {
    level: diagnostic.statusCode >= 500 || diagnostic.reason === "outside-scope" ? "error" : "warning",
    title: titles[diagnostic.reason],
    requestedPath: diagnostic.requestPath,
    resolvedPath: diagnostic.resolvedPath,
    detail: diagnostic.reason === "outside-scope"
      ? "ZJ HTML Studio 已阻止这次读取。如确实需要，请先确认页面来源和资源范围。"
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
  const incomingKey = displayDiagnosticKey(incoming, normalizePath);
  const index = diagnostics.findIndex(item => displayDiagnosticKey(item, normalizePath) === incomingKey);

  if (index === -1) return [...diagnostics, incoming];

  const existing = diagnostics[index]!;
  const merged: DisplayDiagnostic = {
    ...existing,
    level: existing.level === "error" || incoming.level === "error" ? "error" : "warning",
    detail: existing.detail ?? incoming.detail,
    requestedPath: existing.requestedPath ?? incoming.requestedPath,
    resolvedPath: existing.resolvedPath ?? incoming.resolvedPath
  };

  return diagnostics.map((item, itemIndex) => itemIndex === index ? merged : item);
}

function displayDiagnosticKey(
  diagnostic: DisplayDiagnostic,
  normalizePath: (value: string) => string
): string {
  const resourcePath = diagnostic.resolvedPath ?? diagnostic.requestedPath;
  const identity = resourcePath ? normalizePath(resourcePath) : diagnostic.detail ?? "";
  return `${diagnostic.title}\u0000${identity}`;
}
