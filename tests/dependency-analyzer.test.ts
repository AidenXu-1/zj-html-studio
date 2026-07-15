import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzePreviewScope, extractReferences } from "../src/scope/dependency-analyzer";

describe("dependency analyzer", () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(os.tmpdir(), "html-studio-scope-"));
    await mkdir(path.join(vaultRoot, "output", "cover"), { recursive: true });
    await mkdir(path.join(vaultRoot, "output", "images"), { recursive: true });
    await mkdir(path.join(vaultRoot, "output", "styles"), { recursive: true });
    await mkdir(path.join(vaultRoot, "output", "scripts"), { recursive: true });
    await mkdir(path.join(vaultRoot, "private"), { recursive: true });

    await writeFile(path.join(vaultRoot, "output", "cover", "预览.html"), `
      <link rel="stylesheet" href="../styles/theme.css?theme=dark">
      <img src="../images/hero.svg?rev=2">
      <img srcset="../images/hero.svg 1x, ../images/hero@2x.svg 2x">
      <script type="module" src="../scripts/app.mjs?v=1"></script>
      <a href="../private-note.md">普通链接不应扩大范围</a>
    `);
    await writeFile(path.join(vaultRoot, "output", "styles", "theme.css"), `
      body { background-image: url("../images/background.svg?from=css"); }
    `);
    await writeFile(path.join(vaultRoot, "output", "scripts", "app.mjs"), `
      import "./helper.mjs?v=2";
    `);
    await writeFile(path.join(vaultRoot, "output", "scripts", "helper.mjs"), "export const ready = true;");
    await writeFile(path.join(vaultRoot, "output", "images", "hero.svg"), "<svg />");
    await writeFile(path.join(vaultRoot, "output", "images", "hero@2x.svg"), "<svg />");
    await writeFile(path.join(vaultRoot, "output", "images", "background.svg"), "<svg />");
    await writeFile(path.join(vaultRoot, "private", "secret.md"), "secret");
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it("computes the smallest shared resource directory recursively", async () => {
    const result = await analyzePreviewScope(vaultRoot, path.join("output", "cover", "预览.html"));

    expect(result.scopeRelativePath).toBe("output");
    expect(result.climbLevels).toBe(1);
    expect(result.requiresConfirmation).toBe(false);
    expect(result.dependencyRelativePaths).toEqual(expect.arrayContaining([
      "output/cover/预览.html",
      "output/images/background.svg",
      "output/images/hero.svg",
      "output/scripts/app.mjs",
      "output/scripts/helper.mjs",
      "output/styles/theme.css"
    ]));
    expect(result.dependencyRelativePaths).not.toContain("output/private-note.md");
  });

  it("reports missing, external, and root-absolute references without silently widening the scope", async () => {
    await writeFile(path.join(vaultRoot, "output", "cover", "预览.html"), `
      <img src="../images/missing.png?rev=1">
      <img src="https://example.com/remote.png">
      <img src="data:image/png;base64,abc">
      <img src="/global/logo.svg">
    `);

    const result = await analyzePreviewScope(vaultRoot, path.join("output", "cover", "预览.html"));

    expect(result.scopeRelativePath).toBe("output");
    expect(result.missingReferences).toContain("output/images/missing.png");
    expect(result.externalReferences).toEqual(expect.arrayContaining([
      "data:image/png;base64,abc",
      "https://example.com/remote.png"
    ]));
    expect(result.absoluteReferences).toContain("/global/logo.svg");
    expect(result.requiresConfirmation).toBe(true);
  });

  it("reports references that escape the vault", async () => {
    await writeFile(path.join(vaultRoot, "output", "cover", "预览.html"), '<img src="../../../outside.png">');
    const result = await analyzePreviewScope(vaultRoot, path.join("output", "cover", "预览.html"));

    expect(result.escapedReferences).toHaveLength(1);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.scopeRelativePath).toBe("output/cover");
  });

  it("supports valid unquoted attributes and relative base href", async () => {
    await writeFile(path.join(vaultRoot, "output", "cover", "预览.html"), `
      <base href=../>
      <img src=images/hero.svg>
      <script src=scripts/app.mjs></script>
    `);

    const result = await analyzePreviewScope(vaultRoot, path.join("output", "cover", "预览.html"));

    expect(result.scopeRelativePath).toBe("output");
    expect(result.dependencyRelativePaths).toEqual(expect.arrayContaining([
      "output/images/hero.svg",
      "output/scripts/app.mjs"
    ]));
  });

  it("treats dot base href as the current document directory", async () => {
    await writeFile(path.join(vaultRoot, "output", "cover", "local.svg"), "<svg />");
    await writeFile(path.join(vaultRoot, "output", "cover", "预览.html"), `
      <base href=.>
      <img src=local.svg>
    `);

    const result = await analyzePreviewScope(vaultRoot, path.join("output", "cover", "预览.html"));

    expect(result.scopeRelativePath).toBe("output/cover");
    expect(result.dependencyRelativePaths).toContain("output/cover/local.svg");
  });

  it("enforces one reference budget across the whole analysis graph", async () => {
    await writeFile(path.join(vaultRoot, "output", "cover", "预览.html"), `
      <link rel=stylesheet href=../styles/one.css>
      <link rel=stylesheet href=../styles/two.css>
    `);
    await writeFile(path.join(vaultRoot, "output", "styles", "one.css"), `
      a { background: url(../images/one.png) }
      b { background: url(../images/two.png) }
      c { background: url(../images/three.png) }
    `);
    await writeFile(path.join(vaultRoot, "output", "styles", "two.css"), `
      d { background: url(../images/four.png) }
      e { background: url(../images/five.png) }
    `);

    const result = await analyzePreviewScope(
      vaultRoot,
      path.join("output", "cover", "预览.html"),
      { maxReferencesPerFile: 10, maxTotalReferences: 4 }
    );

    expect(result.warnings).toContain("资源地址总数达到 4 个上限，已停止继续收集");
    expect(result.missingReferences).toHaveLength(2);
    expect(result.dependencyRelativePaths.length).toBeLessThanOrEqual(5);
  });

  it("counts bare module imports against the whole-analysis reference budget", async () => {
    await writeFile(path.join(vaultRoot, "output", "cover", "预览.html"), `
      <script type=module src=../scripts/one.mjs></script>
    `);
    await writeFile(path.join(vaultRoot, "output", "scripts", "one.mjs"), `
      import "package-one";
      import "package-two";
      import "package-three";
      import "./two.mjs";
    `);
    await writeFile(path.join(vaultRoot, "output", "scripts", "two.mjs"), `
      import "../images/hidden.png";
    `);

    const result = await analyzePreviewScope(
      vaultRoot,
      path.join("output", "cover", "预览.html"),
      { maxReferencesPerFile: 10, maxTotalReferences: 4 }
    );

    expect(result.warnings).toContain("资源地址总数达到 4 个上限，已停止继续收集");
    expect(result.dependencyRelativePaths).not.toContain("output/scripts/two.mjs");
    expect(result.dependencyRelativePaths).not.toContain("output/images/hidden.png");
  });

  it("stops before the total text scanning budget is exceeded", async () => {
    const result = await analyzePreviewScope(
      vaultRoot,
      path.join("output", "cover", "预览.html"),
      { maxTotalTextBytes: 32 }
    );

    expect(result.warnings).toContain("文本依赖总大小达到 0.0 MiB 上限，已停止继续扫描");
    expect(result.dependencyRelativePaths).toEqual(["output/cover/预览.html"]);
  });

  it("can abort before filesystem analysis begins", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(analyzePreviewScope(
      vaultRoot,
      path.join("output", "cover", "预览.html"),
      { signal: controller.signal }
    )).rejects.toMatchObject({ name: "AbortError" });
  });

  it.runIf(process.platform !== "win32")("does not follow symbolic links outside the vault", async () => {
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "html-studio-outside-"));
    try {
      await writeFile(path.join(outsideRoot, "outside.css"), "body {}");
      await symlink(path.join(outsideRoot, "outside.css"), path.join(vaultRoot, "output", "styles", "linked.css"));
      await writeFile(path.join(vaultRoot, "output", "cover", "预览.html"), '<link rel="stylesheet" href="../styles/linked.css">');

      const result = await analyzePreviewScope(vaultRoot, path.join("output", "cover", "预览.html"));
      expect(result.escapedReferences).toHaveLength(1);
      expect(result.dependencyRelativePaths).not.toContain("output/styles/linked.css");
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

describe("reference extraction", () => {
  it("distinguishes local, external, and root-absolute references", () => {
    const result = extractReferences(`
      import "./local.mjs";
      import "package-name";
      const worker = new URL("../worker.js", import.meta.url);
      const remote = import("https://example.com/mod.mjs");
      const absolute = import("/assets/app.mjs");
    `, ".mjs");

    expect(result.local).toEqual(["../worker.js", "./local.mjs"]);
    expect(result.external).toEqual(["https://example.com/mod.mjs"]);
    expect(result.absolute).toEqual(["/assets/app.mjs"]);
    expect(result.referenceCount).toBe(5);
  });

  it("recognizes fetch, workers, and enforces a per-file reference cap", () => {
    const result = extractReferences(`
      fetch("./data.json");
      new Worker("./worker.js");
      new SharedWorker("./shared.js");
      fetch("./ignored.json");
    `, ".js", 3);

    expect(result.local).toEqual(["./data.json", "./ignored.json", "./worker.js"]);
    expect(result.local).toHaveLength(3);
  });
});
