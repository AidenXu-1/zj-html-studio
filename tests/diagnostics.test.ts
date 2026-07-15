import { describe, expect, it } from "vitest";
import {
  buildAnalysisDiagnostics,
  buildRuntimeDiagnostic,
  countAnalysisDiagnostics,
  upsertDisplayDiagnostic
} from "../src/ui/diagnostics";
import type { ScopeAnalysis } from "../src/scope/dependency-analyzer";

describe("display diagnostics", () => {
  it("turns analysis findings into plain-language cards", () => {
    const analysis: ScopeAnalysis = {
      absoluteReferences: ["/images/logo.svg"],
      climbLevels: 1,
      dependencyRelativePaths: ["output/index.html"],
      entryRelativePath: "output/index.html",
      escapedReferences: ["index.html → ../../../secret.md"],
      externalReferences: [],
      missingReferences: ["output/images/missing.png"],
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
      entryRelativePath: "output/index.html",
      escapedReferences: [],
      externalReferences: [],
      missingReferences: Array.from({ length: 1_000 }, (_, index) => `output/missing-${index}.png`),
      requiresConfirmation: false,
      scopeRelativePath: "output",
      warnings: []
    };

    expect(countAnalysisDiagnostics(analysis)).toBe(1_000);
    expect(buildAnalysisDiagnostics(analysis, 100)).toHaveLength(100);
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
    expect(result.detail).toContain("已阻止");
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
});
