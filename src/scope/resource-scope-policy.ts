import { getHtmlPermissionScopePath, normalizeScopePath } from "../settings";
import type { ScopeAnalysis } from "./dependency-analyzer";

export type ScopeConfirmationDecision = "cancel" | "entry-folder-safe" | "requested-scope";

export function canOfferEntryFolderSafeTrial(analysis: ScopeAnalysis): boolean {
  const entryFolder = getHtmlPermissionScopePath(analysis.entryRelativePath);
  return entryFolder !== "" && normalizeScopePath(analysis.scopeRelativePath) !== entryFolder;
}

export function applyEntryFolderSafeTrial(analysis: ScopeAnalysis): ScopeAnalysis {
  const entryFolder = getHtmlPermissionScopePath(analysis.entryRelativePath);
  if (!entryFolder) return analysis;
  const retainedDependencies = analysis.dependencyRelativePaths.filter(path => isInScope(path, entryFolder));
  const omittedCount = analysis.dependencyRelativePaths.length - retainedDependencies.length;
  const warning = omittedCount > 0
    ? `安全试开未授权 ${omittedCount} 个跨目录依赖；页面主体可先查看，缺失资源会出现在诊断中`
    : "安全试开只允许读取 HTML 所在文件夹";
  return {
    ...analysis,
    climbLevels: 0,
    dependencyRelativePaths: retainedDependencies,
    requiresConfirmation: false,
    scopeRelativePath: entryFolder,
    warnings: [...analysis.warnings, warning]
  };
}

function isInScope(candidatePath: string, scopePath: string): boolean {
  const candidate = normalizeScopePath(candidatePath);
  const scope = normalizeScopePath(scopePath);
  return candidate === scope || candidate.startsWith(`${scope}/`);
}
