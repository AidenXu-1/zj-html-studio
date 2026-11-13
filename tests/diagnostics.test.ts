import { describe, expect, it } from "vitest";
import {
  buildAnalysisDiagnostics,
  buildRuntimeDiagnostic,
  countAnalysisDiagnostics,
  formatDiagnosticRequestPath,
  formatDisplayDiagnosticResolvedPath,
  getDisplayDiagnosticKey,
  getScriptRestrictionPresentation,
  upsertDisplayDiagnostic
} from "../src/ui/diagnostics";
import type { ScopeAnalysis } from "../src/scope/dependency-analyzer";

describe("display diagnostics", () => {
  it("shows Chinese request paths readably without changing reserved URL separators", () => {
    expect(formatDiagnosticRequestPath("/" + encodeURIComponent("课程 配图") + "/图片%2F1.png")).toBe("/课程 配图/图片%2F1.png");
    expect(formatDiagnosticRequestPath("/图片.png?title=%E8%AF%BE%E7%A8%8B%26a%3Db")).toBe("/图片.png?title=课程%26a%3Db");
  });

  it("retains original paths containing malformed escapes or invisible controls", () => {
    for (const value of ["/图%片.png", "/bad%E8%AF.png", "/a%0Ab.png", "/a%E2%80%AEb.png"]) {
      expect(formatDiagnosticRequestPath(value)).toBe(value);
    }
  });

  it("turns analysis findings into plain-language cards", () => {
    const analysis: ScopeAnalysis = {
      absoluteReferences: ["/images/logo.svg"],
      climbLevels: 1,
      dependencyRelativePaths: ["output/index.html"],
      dependencyScopeAnalysis: { complete: true, reason: "complete", scannedBytes: 0 },
      entryByteSize: 0,
      entryRelativePath: "output/index.html",
      escapedReferences: ["index.html → ../../../secret.md"],
      externalReferences: [],
      missingReferences: ["output/images/missing.png"],
      pageScriptCount: 0,
      pageScriptAnalysis: { complete: true, reason: "complete", scannedCharacters: 0 },
      requiresConfirmation: true,
      scopeRelativePath: "output",
      warnings: []
    };

    const diagnostics = buildAnalysisDiagnostics(analysis);
    expect(diagnostics.map(item => item.title)).toEqual([
      "有一个本地资源没有找到",
      "页面使用了网站根路径",
      "资源地址超出了知识仓库"
    ]);
  });

  it("caps analysis card construction before allocating every diagnostic", () => {
    const analysis: ScopeAnalysis = {
      absoluteReferences: [],
      climbLevels: 0,
      dependencyRelativePaths: ["output/index.html"],
      dependencyScopeAnalysis: { complete: true, reason: "complete", scannedBytes: 0 },
      entryByteSize: 0,
      entryRelativePath: "output/index.html",
      escapedReferences: [],
      externalReferences: [],
      missingReferences: Array.from({ length: 1_000 }, (_, index) => `output/missing-${index}.png`),
      pageScriptCount: 0,
      pageScriptAnalysis: { complete: true, reason: "complete", scannedCharacters: 0 },
      requiresConfirmation: false,
      scopeRelativePath: "output",
      warnings: []
    };

    expect(countAnalysisDiagnostics(analysis)).toBe(1_000);
    expect(buildAnalysisDiagnostics(analysis, 100)).toHaveLength(100);
  });

  it("explains blocked page scripts only in safe mode", () => {
    const analysis: ScopeAnalysis = {
      absoluteReferences: [],
      climbLevels: 0,
      dependencyRelativePaths: ["output/index.html"],
      dependencyScopeAnalysis: { complete: true, reason: "complete", scannedBytes: 0 },
      entryByteSize: 0,
      entryRelativePath: "output/index.html",
      escapedReferences: [],
      externalReferences: [],
      missingReferences: [],
      pageScriptCount: 2,
      pageScriptAnalysis: { complete: true, reason: "complete", scannedCharacters: 0 },
      requiresConfirmation: false,
      scopeRelativePath: "output",
      warnings: []
    };

    expect(buildAnalysisDiagnostics(analysis, 100, "safe")).toEqual([
      expect.objectContaining({ title: "此页面已设为仅查看" })
    ]);
    expect(countAnalysisDiagnostics(analysis, "safe")).toBe(1);
    expect(buildAnalysisDiagnostics(analysis, 100, "interactive")).toEqual([]);
    expect(countAnalysisDiagnostics(analysis, "trusted")).toBe(0);
  });

  it("keeps scan budgets internal while offering recovery for explicit safe mode", () => {
    const incompleteAnalysisWarning = "文本依赖过大，只扫描前 5 MiB：output/index.html";
    const analysis: ScopeAnalysis = {
      absoluteReferences: [],
      climbLevels: 0,
      dependencyRelativePaths: ["output/index.html"],
      dependencyScopeAnalysis: { complete: false, reason: "file-too-large", scannedBytes: 5 * 1024 * 1024 },
      entryByteSize: 8 * 1024 * 1024,
      entryRelativePath: "output/index.html",
      escapedReferences: [],
      externalReferences: [],
      missingReferences: [],
      pageScriptCount: 0,
      pageScriptAnalysis: {
        complete: false,
        reason: "file-too-large",
        scannedCharacters: 5 * 1024 * 1024
      },
      requiresConfirmation: true,
      scopeRelativePath: "",
      warnings: [incompleteAnalysisWarning]
    };

    const presentation = getScriptRestrictionPresentation(analysis, "safe");
    expect(presentation?.title).toBe("此页面已设为仅查看");
    expect(presentation?.detail).toContain("恢复正常打开");
    for (const mode of ["safe", "interactive", "standard", "trusted"] as const) {
      expect(buildAnalysisDiagnostics(analysis, 100, mode)).toEqual([]);
      expect(countAnalysisDiagnostics(analysis, mode)).toBe(0);
      if (mode !== "safe") expect(getScriptRestrictionPresentation(analysis, mode)).toBeNull();
    }
  });

  it("replaces an embedded diagnostic absolute path before display", () => {
    const diagnostic = buildRuntimeDiagnostic({
      reason: "missing-file",
      requestPath: "/assets/missing.png",
      resolvedPath: "/vault/output/assets/missing.png",
      sessionId: "session",
      statusCode: 404
    });

    const displayed = formatDisplayDiagnosticResolvedPath(
      diagnostic,
      value => value.replace("/vault/", "")
    );

    expect(displayed.resolvedPath).toBe("output/assets/missing.png");
    expect(displayed.requestedPath).toBe("/assets/missing.png");
    expect(diagnostic.resolvedPath).toBe("/vault/output/assets/missing.png");
  });

  it("explains a blocked runtime request without leaking file content", () => {
    const result = buildRuntimeDiagnostic({
      reason: "outside-scope",
      requestPath: "/../secret.md",
      resolvedPath: "/vault/secret.md",
      sessionId: "session",
      statusCode: 403
    });

    expect(result.level).toBe("error");
    expect(result.title).toBe("资源超出了当前预览范围");
    expect(result.detail).toContain("单独允许");
    expect(result.scopeExpansionCandidatePath).toBe("/vault/secret.md");
  });

  it("merges the runtime form of a missing resource already found during analysis", () => {
    const analysisDiagnostic = {
      level: "warning" as const,
      title: "有一个本地资源没有找到",
      requestedPath: "output/assets/missing.ttf",
      detail: "确认文件是否被移动、改名或尚未生成。"
    };
    const runtimeDiagnostic = buildRuntimeDiagnostic({
      reason: "missing-file",
      requestPath: "/assets/missing.ttf",
      resolvedPath: "/vault/output/assets/missing.ttf",
      sessionId: "session",
      statusCode: 404
    });

    const diagnostics = upsertDisplayDiagnostic(
      [analysisDiagnostic],
      runtimeDiagnostic,
      value => value.startsWith("/vault/") ? value.slice("/vault/".length) : value
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      requestedPath: "output/assets/missing.ttf",
      resolvedPath: "/vault/output/assets/missing.ttf"
    });
  });

  it("does not merge different missing resources", () => {
    const first = buildRuntimeDiagnostic({
      reason: "missing-file",
      requestPath: "/assets/first.png",
      resolvedPath: "/vault/output/assets/first.png",
      sessionId: "session",
      statusCode: 404
    });
    const second = buildRuntimeDiagnostic({
      reason: "missing-file",
      requestPath: "/assets/second.png",
      resolvedPath: "/vault/output/assets/second.png",
      sessionId: "session",
      statusCode: 404
    });

    expect(upsertDisplayDiagnostic([first], second)).toHaveLength(2);
  });

  it("keeps a stable identity for diagnostics hidden beyond the display cap", () => {
    const analysisDiagnostic = {
      level: "warning" as const,
      title: "有一个本地资源没有找到",
      requestedPath: "output/assets/hidden.png"
    };
    const runtimeDiagnostic = buildRuntimeDiagnostic({
      reason: "missing-file",
      requestPath: "/assets/hidden.png",
      resolvedPath: "/vault/output/assets/hidden.png",
      statusCode: 404
    });
    const normalizePath = (value: string): string => value.startsWith("/vault/")
      ? value.slice("/vault/".length)
      : value;

    expect(getDisplayDiagnosticKey(analysisDiagnostic, normalizePath)).toBe(
      getDisplayDiagnosticKey(runtimeDiagnostic, normalizePath)
    );
  });
});
