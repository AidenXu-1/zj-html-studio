import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, open, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  analyzePreviewScope,
  countHtmlExecutableScriptEntries,
  extractReferences,
  readTextFileHandleWithinBudget
} from "../src/scope/dependency-analyzer";
import {
  applyEntryFolderSafeTrial,
  canOfferEntryFolderSafeTrial
} from "../src/scope/resource-scope-policy";
import { scanHtmlDocument } from "../src/scope/bounded-html-parser";

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

  it("can safely trial a broad page with only its entry folder", async () => {
    const analysis = await analyzePreviewScope(vaultRoot, path.join("output", "cover", "预览.html"));
    const trial = applyEntryFolderSafeTrial(analysis);

    expect(canOfferEntryFolderSafeTrial(analysis)).toBe(true);
    expect(trial.scopeRelativePath).toBe("output/cover");
    expect(trial.requiresConfirmation).toBe(false);
    expect(trial.dependencyRelativePaths).toEqual(["output/cover/预览.html"]);
    expect(trial.warnings.at(-1)).toContain("跨目录依赖");
  });

  it("computes the smallest shared resource directory recursively", async () => {
    const result = await analyzePreviewScope(vaultRoot, path.join("output", "cover", "预览.html"));

    expect(result.scopeRelativePath).toBe("output");
    expect(result.climbLevels).toBe(1);
    expect(result.requiresConfirmation).toBe(false);
    expect(result.pageScriptCount).toBe(1);
    expect(result.pageScriptAnalysis).toMatchObject({
      complete: true,
      reason: "complete"
    });
    expect(result.pageScriptAnalysis.scannedCharacters).toBeGreaterThan(0);
    expect(result.entryByteSize).toBeGreaterThan(0);
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
    expect(result.externalReferences).toEqual(["https://example.com/remote.png"]);
    expect(result.absoluteReferences).toContain("/global/logo.svg");
    expect(result.requiresConfirmation).toBe(true);
  });

  it("bounds persistent reference text and conservatively widens an incomplete analysis", async () => {
    const longExternal = `https://example.com/${"x".repeat(20_000)}`;
    await writeFile(
      path.join(vaultRoot, "output", "cover", "预览.html"),
      `<img src="${longExternal}"><img src="https://example.com/short.png">`
    );

    const result = await analyzePreviewScope(vaultRoot, path.join("output", "cover", "预览.html"), {
      maxStoredReferenceCharacters: 1_024
    });

    expect(result.dependencyScopeAnalysis.complete).toBe(false);
    expect(result.scopeRelativePath).toBe("");
    expect(result.requiresConfirmation).toBe(true);
    expect(result.externalReferences.join("").length).toBeLessThanOrEqual(1_024);
    expect(result.warnings.join("\n")).toContain("资源地址文字达到");
  });

  it("infers the nearest existing site root for root-absolute resources", async () => {
    await mkdir(path.join(vaultRoot, "site", "pages"), { recursive: true });
    await mkdir(path.join(vaultRoot, "site", "assets"), { recursive: true });
    await writeFile(
      path.join(vaultRoot, "site", "pages", "index.html"),
      '<link rel="stylesheet" href="/assets/app.css"><h1>Course</h1>'
    );
    await writeFile(path.join(vaultRoot, "site", "assets", "app.css"), "h1 { color: green; }");

    const result = await analyzePreviewScope(vaultRoot, path.join("site", "pages", "index.html"));

    expect(result.scopeRelativePath).toBe("site");
    expect(result.absoluteReferences).toContain("/assets/app.css");
    expect(result.dependencyRelativePaths).toContain("site/assets/app.css");
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
    expect(result.pageScriptCount).toBe(0);
    expect(result.pageScriptAnalysis).toEqual({
      complete: false,
      reason: "budget-exhausted",
      scannedCharacters: 32
    });
    expect(result.scopeRelativePath).toBe("");
  });

  it("reports a lower-bound script count when the HTML scan budget is exhausted", async () => {
    const prefix = "<script>first()</script>";
    const content = `${prefix}${"x".repeat(256)}<button onclick="later()">later</button><img src="late.png">`;
    await writeFile(path.join(vaultRoot, "output", "cover", "预览.html"), content);

    const result = await analyzePreviewScope(
      vaultRoot,
      path.join("output", "cover", "预览.html"),
      { maxHtmlScanCharacters: prefix.length + 8 }
    );

    expect(result.pageScriptCount).toBe(1);
    expect(result.pageScriptAnalysis).toEqual({
      complete: false,
      reason: "budget-exhausted",
      scannedCharacters: prefix.length + 8
    });
    expect(result.warnings).toContain(
      `HTML 结构扫描达到 ${prefix.length + 8} 个字符上限；脚本数量和资源地址只代表已扫描部分`
    );
    expect(result.dependencyRelativePaths).not.toContain("output/cover/late.png");
  });

  it("distinguishes an oversized entry from a script-free entry", async () => {
    const content = `<script>render()</script>${"x".repeat(256)}`;
    await writeFile(path.join(vaultRoot, "output", "cover", "预览.html"), content);

    const result = await analyzePreviewScope(
      vaultRoot,
      path.join("output", "cover", "预览.html"),
      { maxFileBytes: 64 }
    );

    expect(result.entryByteSize).toBe(Buffer.byteLength(content));
    expect(result.pageScriptCount).toBe(1);
    expect(result.pageScriptAnalysis).toEqual({
      complete: false,
      reason: "file-too-large",
      scannedCharacters: 64
    });
    expect(result.dependencyScopeAnalysis).toMatchObject({
      complete: false,
      reason: "file-too-large",
      scannedBytes: 64
    });
    expect(result.scopeRelativePath).toBe("");
    expect(result.requiresConfirmation).toBe(true);
  });

  it("gives an oversized page a recoverable conservative scope after scanning its prefix", async () => {
    const content = `<img src="../images/hero.svg">${"x".repeat(256)}`;
    await writeFile(path.join(vaultRoot, "output", "cover", "预览.html"), content);

    const result = await analyzePreviewScope(
      vaultRoot,
      path.join("output", "cover", "预览.html"),
      { maxFileBytes: 64 }
    );

    expect(result.dependencyRelativePaths).toContain("output/images/hero.svg");
    expect(result.scopeRelativePath).toBe("");
    expect(result.requiresConfirmation).toBe(true);
    expect(result.warnings.join("\n")).toContain("保守资源范围");
  });

  it("keeps 16, 25, and 100 MiB pages recoverable when they use parent-folder resources", async () => {
    const entryPath = path.join(vaultRoot, "output", "cover", "预览.html");
    for (const sizeMiB of [16, 25, 100]) {
      const fileHandle = await open(entryPath, "w");
      try {
        await fileHandle.write('<img src="../images/hero.svg">');
        await fileHandle.truncate(sizeMiB * 1024 * 1024);
      } finally {
        await fileHandle.close();
      }

      const result = await analyzePreviewScope(vaultRoot, path.join("output", "cover", "预览.html"));
      expect(result.entryByteSize).toBe(sizeMiB * 1024 * 1024);
      expect(result.dependencyRelativePaths).toContain("output/images/hero.svg");
      expect(result.dependencyScopeAnalysis.complete).toBe(false);
      expect(result.scopeRelativePath).toBe("");
      expect(result.requiresConfirmation).toBe(true);
    }
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

  it("yields before a large synchronous scan so a newly requested cancellation wins", async () => {
    const entryPath = path.join(vaultRoot, "output", "cover", "预览.html");
    await writeFile(entryPath, `<div>${"x".repeat(2 * 1024 * 1024)}</div>`);
    const controller = new AbortController();
    const analysis = analyzePreviewScope(
      vaultRoot,
      path.join("output", "cover", "预览.html"),
      { signal: controller.signal }
    );
    setTimeout(() => controller.abort(), 0);

    await expect(analysis).rejects.toMatchObject({ name: "AbortError" });
  });

  it("checks an already-aborted signal inside each bounded scanner", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => scanHtmlDocument("<div>content</div>", { signal: controller.signal }))
      .toThrow(expect.objectContaining({ name: "AbortError" }));
    expect(() => extractReferences("body{background:url(a.png)}", ".css", 10, 1_000, controller.signal))
      .toThrow(expect.objectContaining({ name: "AbortError" }));
  });

  it("reads an opened file handle only up to the byte budget plus one sentinel byte", async () => {
    const filePath = path.join(vaultRoot, "output", "cover", "bounded.txt");
    await writeFile(filePath, "x".repeat(256));
    const fileHandle = await open(filePath, "r");
    try {
      const result = await readTextFileHandleWithinBudget(fileHandle, 64, undefined);
      expect(result).toEqual({ byteLength: 65, content: "x".repeat(64), exceeded: true });
    } finally {
      await fileHandle.close();
    }
  });

  it("honors an abort signal inside bounded file-handle reads", async () => {
    const filePath = path.join(vaultRoot, "output", "cover", "abort.txt");
    await writeFile(filePath, "x".repeat(256));
    const fileHandle = await open(filePath, "r");
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(readTextFileHandleWithinBudget(fileHandle, 64, controller.signal))
        .rejects.toMatchObject({ name: "AbortError" });
    } finally {
      await fileHandle.close();
    }
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

  it.runIf(process.platform !== "win32")("treats a referenced FIFO as unavailable without waiting for a writer", async () => {
    const fifoPath = path.join(vaultRoot, "output", "styles", "blocking.css");
    const created = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
    if (created.status !== 0) throw new Error(created.stderr || "mkfifo failed");
    await writeFile(
      path.join(vaultRoot, "output", "cover", "预览.html"),
      '<link rel="stylesheet" href="../styles/blocking.css">'
    );

    const startedAt = Date.now();
    const result = await analyzePreviewScope(vaultRoot, path.join("output", "cover", "预览.html"));
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result.missingReferences).toContain("output/styles/blocking.css");
  });

  it("leaves runtime-computed DOM resource paths for explicit recovery instead of guessing", async () => {
    await mkdir(path.join(vaultRoot, "dynamic", "pages"), { recursive: true });
    await mkdir(path.join(vaultRoot, "dynamic", "shared"), { recursive: true });
    await writeFile(path.join(vaultRoot, "dynamic", "shared", "runtime.svg"), "<svg />");
    await writeFile(path.join(vaultRoot, "dynamic", "pages", "index.html"), `
      <img id="runtime">
      <script>
        document.querySelector("#runtime").src = ["..", "shared", "runtime.svg"].join("/");
      </script>
    `);

    const result = await analyzePreviewScope(vaultRoot, path.join("dynamic", "pages", "index.html"));

    expect(result.scopeRelativePath).toBe("dynamic/pages");
    expect(result.dependencyRelativePaths).not.toContain("dynamic/shared/runtime.svg");
    expect(result.pageScriptCount).toBe(1);
  });
});

describe("reference extraction", () => {
  it("counts real script elements without treating commented markup as active", () => {
    expect(countHtmlExecutableScriptEntries(`
      <!-- <script src="ignored.js"></script> -->
      <script>document.body.dataset.ready = "yes";</script>
      <SCRIPT type="module" src="./app.mjs"></SCRIPT>
    `)).toBe(2);
  });

  it("counts executable script entry points and excludes inert or quoted pseudo markup", () => {
    expect(countHtmlExecutableScriptEntries(`
      <!-- <script src="comment.js"></script> -->
      <textarea><script>textareaOnly()</script></textarea>
      <title><script>titleOnly()</script></title>
      <template>
        <script>templateOnly()</script>
        <button onclick="templateOnly()">template</button>
        <a href="javascript:templateOnly()">template link</a>
      </template>
      <div data-example='<script onclick="quoted()"></script>'></div>
      <p>&lt;script&gt;escaped text&lt;/script&gt;</p>
      <script type="application/json">{"not":"executable"}</script>
      <script>const example = "<script>quoted in JavaScript</script>";</script>
      <button onclick="handleClick()">run</button>
      <a href="  JaVaScRiPt:run()">run link</a>
      <iframe src="javascript:frameRun()"></iframe>
      <img src="javascript:imageDoesNotExecute()">
    `)).toBe(4);
  });

  it.each<[string, string, number]>([
    ["ordinary script", "<script>run()</script>", 1],
    ["module script", "<script type=module>run()</script>", 1],
    ["JavaScript MIME script", "<script type='text/javascript'>run()</script>", 1],
    ["inert JSON data script", "<script type='application/json'>{}</script>", 0],
    ["inert plain-text script", "<script type='text/plain'>example</script>", 0],
    ["import map loading instruction", "<script type=importmap>{}</script>", 1],
    ["speculation rules loading instruction", "<script type=speculationrules>{}</script>", 1],
    ["window event handler", "<body onload='run()'>", 1],
    ["media event handler", "<video onloadeddata='run()'>", 1],
    ["pointer event handler", "<button onpointerdown='run()'>", 1],
    ["touch event handler", "<button ontouchstart='run()'>", 1],
    ["SVG SMIL begin handler", "<animate onbegin='run()'>", 1],
    ["SVG SMIL repeat and end handlers", "<animate onrepeat='again()' onend='done()'>", 2],
    ["empty known event handler", "<button onclick='   '>", 0],
    ["unknown on-prefix attributes are conservative", "<div once='value' oncustom='run()'>", 2],
    ["anchor JavaScript URL", "<a href='javascript:run()'>", 1],
    ["iframe JavaScript URL", "<iframe src='javascript:run()'></iframe>", 1],
    ["form JavaScript URL", "<form action='javascript:run()'>", 1],
    ["form-action JavaScript URL", "<button formaction='javascript:run()'>", 1],
    ["object JavaScript URL", "<object data='javascript:run()'>", 1],
    ["non-executable image JavaScript URL", "<img src='javascript:run()'>", 0]
  ])("isolates %s semantics", (_label, html, expected) => {
    expect(countHtmlExecutableScriptEntries(html)).toBe(expected);
  });

  it("conservatively counts every non-empty on-prefix attribute", () => {
    expect(countHtmlExecutableScriptEntries(`
      <div once="plain attribute" oncustom="unknown()" onclick="" onload="   " onfocus="&#32;"></div>
      <button onpointerdown="pointer()" ontouchstart="touch()">run</button>
      <video onloadeddata="media()"></video>
      <body onbeforeunload="leave()" onanimationend="animate()"></body>
    `)).toBe(7);
  });

  it("decodes browser character references before evaluating script semantics", () => {
    expect(countHtmlExecutableScriptEntries(`
      <script type="mod&#117;le">first()</script>
      <script type="mod&#x75le">second()</script>
      <a href="java&#115cript&colon;third()">run</a>
      <button onfuture="&#32;">only decoded whitespace</button>
    `)).toBe(3);
  });

  it("decodes named, decimal, hexadecimal, and semicolonless references in resource attributes", () => {
    const result = extractReferences(`
      <link rel="style&#115;heet" href="styles&sol;ma&#x69n&period;css">
      <img src="images&#47hero&#46;png">
      <script type="mod&#117le" src="scripts&#47;app&#46;mjs"></script>
    `, ".html");

    expect(result.local).toEqual([
      "images/hero.png",
      "scripts/app.mjs",
      "styles/main.css"
    ]);
  });

  it("extracts real resource elements without reading comments, inert text, or quoted pseudo tags", () => {
    const result = extractReferences(`
      <base href="../assets/">
      <!-- <img src="ignored-comment.png"> -->
      <textarea><img src="ignored-textarea.png"></textarea>
      <template><script src="template-script.js"></script></template>
      <div data-example='<link href="ignored-attribute.css">'></div>
      <link rel="stylesheet" href="styles/site.css">
      <img src="images/hero.png" srcset="images/hero.png 1x, images/hero@2x.png 2x">
      <script src="scripts/app.js"></script>
      <source src="media/clip.webm" srcset="media/clip-small.webm 480w, media/clip.webm 960w">
      <video src="media/movie.mp4" poster="images/poster.jpg"></video>
      <audio src="media/audio.mp3"></audio>
      <iframe src="frames/help.html"></iframe>
      <object data="documents/guide.pdf"></object>
    `, ".html");

    expect(result.baseHref).toBe("../assets/");
    expect(result.local).toEqual([
      "documents/guide.pdf",
      "frames/help.html",
      "images/hero.png",
      "images/hero@2x.png",
      "images/poster.jpg",
      "media/audio.mp3",
      "media/clip-small.webm",
      "media/clip.webm",
      "media/movie.mp4",
      "scripts/app.js",
      "styles/site.css",
      "template-script.js"
    ]);
  });

  it.each<[string, string, string[]]>([
    ["image src", "<img src='images/a.png'>", ["images/a.png"]],
    ["image srcset", "<img srcset='images/a.png 1x, images/b.png 2x'>", ["images/a.png", "images/b.png"]],
    ["stylesheet link href", "<link href='styles/a.css' rel='stylesheet'>", ["styles/a.css"]],
    ["preload link href", "<link rel='preload' href='fonts/a.woff2' as='font'>", ["fonts/a.woff2"]],
    ["canonical link does not load", "<link href='../canonical.html' rel='canonical'>", []],
    ["link without rel does not load", "<link href='../metadata.html'>", []],
    ["ordinary script src", "<script src='scripts/a.js'></script>", ["scripts/a.js"]],
    ["module script src", "<script src='scripts/a.mjs' type=module></script>", ["scripts/a.mjs"]],
    ["source src", "<source src='media/a.webm'>", ["media/a.webm"]],
    ["source srcset", "<source srcset='images/a.png 1x, images/b.png 2x'>", ["images/a.png", "images/b.png"]],
    ["video src", "<video src='media/a.mp4'></video>", ["media/a.mp4"]],
    ["video poster", "<video poster='images/poster.png'></video>", ["images/poster.png"]],
    ["audio src", "<audio src='media/a.mp3'></audio>", ["media/a.mp3"]],
    ["iframe src", "<iframe src='frames/a.html'></iframe>", ["frames/a.html"]],
    ["legacy frame src", "<frame src='frames/a.html'>", ["frames/a.html"]],
    ["embed src", "<embed src='media/a.pdf'>", ["media/a.pdf"]],
    ["track src", "<track src='media/a.vtt'>", ["media/a.vtt"]],
    ["object data", "<object data='media/a.pdf'></object>", ["media/a.pdf"]],
    ["image input src regardless of attribute order", "<input src='images/button.png' type=image>", ["images/button.png"]],
    ["div src", "<div src='ignored.png'></div>", []],
    ["div srcset", "<div srcset='ignored.png 1x'></div>", []],
    ["div poster", "<div poster='ignored.png'></div>", []],
    ["div data", "<div data='ignored.pdf'></div>", []],
    ["default input src", "<input src='ignored.png'>", []],
    ["JSON data script src", "<script src='ignored.json' type=application/json></script>", []],
    ["plain-text script src", "<script type=text/plain src='ignored.txt'></script>", []],
    ["import map src", "<script type=importmap src='ignored.json'></script>", []],
    ["speculation rules src", "<script type=speculationrules src='ignored.json'></script>", []],
    ["SVG image href", "<svg><image href='images/a.svg'></image></svg>", ["images/a.svg"]],
    ["SVG xlink href", "<svg><use xlink:href='icons.svg#check'></use></svg>", ["icons.svg#check"]],
    ["inline style URL", "<div style='background:url(images/a.png)'></div>", ["images/a.png"]],
    ["local HTML navigation", "<a href='../chapter.html#lesson'>next</a>", ["../chapter.html#lesson"]],
    ["external HTML navigation stays a navigation, not a resource", "<a href='https://example.com/chapter.html'>next</a>", []]
  ])("applies the real loading whitelist for %s", (_label, html, expected) => {
    expect(extractReferences(html, ".html").local).toEqual(expected);
  });

  it("does not describe embedded URL schemes as external network resources", () => {
    const result = extractReferences(`
      <img src="data:image/svg+xml,%3Csvg/%3E">
      <img src="blob:http://localhost/generated">
      <iframe src="about:blank"></iframe>
      <iframe src="javascript:document.body.textContent='local'"></iframe>
      <img src="https://example.com/remote.png">
    `, ".html");

    expect(result.external).toEqual(["https://example.com/remote.png"]);
  });

  it("extracts active and template-contained CSS and JavaScript resources", () => {
    const result = extractReferences(`
      <!-- fetch("comment.json"); url("comment.png") -->
      <textarea>fetch("textarea.json"); url("textarea.png")</textarea>
      <template>
        <style>body { background: url("template.png") }</style>
        <script>fetch("template.json")</script>
      </template>
      <div data-example='fetch("attribute.json"); url("attribute.png")'></div>
      <p>fetch("text.json"); url("text.png")</p>
      <style>body { background: url("styles/active.png") }</style>
      <script type="module">
        import "./scripts/active.mjs";
        fetch("./data/active.json");
      </script>
      <script type="application/json">{"path":"./ignored.json"}</script>
    `, ".html");

    expect(result.local).toEqual([
      "./data/active.json",
      "./scripts/active.mjs",
      "styles/active.png",
      "template.json",
      "template.png"
    ]);
  });

  it("expands scope for parent resources discovered in inline styles and linked chapters", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "html-studio-inline-scope-"));
    try {
      await mkdir(path.join(root, "output", "cover"), { recursive: true });
      await mkdir(path.join(root, "output", "images"), { recursive: true });
      await writeFile(path.join(root, "output", "chapter.html"), "<h1>Chapter</h1>");
      await writeFile(path.join(root, "output", "images", "hero.svg"), "<svg />");
      await writeFile(path.join(root, "output", "cover", "预览.html"), `
        <div style="background-image:url(../images/hero.svg)"></div>
        <a href="../chapter.html#lesson">next</a>
      `);

      const result = await analyzePreviewScope(root, path.join("output", "cover", "预览.html"));
      expect(result.scopeRelativePath).toBe("output");
      expect(result.dependencyRelativePaths).toEqual(expect.arrayContaining([
        "output/chapter.html",
        "output/images/hero.svg"
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds malformed unclosed HTML scans deterministically from 12 to 256 KiB", () => {
    const sizes = [12, 24, 48, 96, 192, 256].map(kib => kib * 1024);
    const malformedPrefixes = [
      "<link ",
      "<base ",
      "<script ",
      "<img srcset=\"",
      "<div data-long=\""
    ];

    for (const prefix of malformedPrefixes) {
      let previousWorkUnits = 0;
      for (const size of sizes) {
        const content = prefix.repeat(Math.ceil(size / prefix.length)).slice(0, size);
        const result = extractReferences(content, ".html", 2_000, size).htmlScan;

        expect(result).toBeDefined();
        if (!result) throw new Error("HTML scan metadata is required");
        expect(result.complete).toBe(true);
        expect(result.scannedCharacters).toBe(size);
        expect(result.workUnits).toBeLessThanOrEqual(size * 12);
        if (previousWorkUnits > 0) {
          expect(result.workUnits).toBeLessThanOrEqual(previousWorkUnits * 2 + 64 * 1024);
        }
        previousWorkUnits = result.workUnits;
      }
    }
  });

  it("keeps character-reference decoding linear with dense semicolonless input", () => {
    const sizes = [12, 24, 48, 96, 192, 256].map(kib => kib * 1024);
    let previousWorkUnits = 0;
    for (const size of sizes) {
      const wrapperStart = '<img src="';
      const wrapperEnd = '">';
      const payloadSize = size - wrapperStart.length - wrapperEnd.length;
      const payload = "&#x75m".repeat(Math.ceil(payloadSize / 6)).slice(0, payloadSize);
      const result = scanHtmlDocument(`${wrapperStart}${payload}${wrapperEnd}`, { maxReferences: 1 });

      expect(result.complete).toBe(true);
      expect(result.scannedCharacters).toBe(size);
      expect(result.workUnits).toBeLessThanOrEqual(size * 12);
      if (previousWorkUnits > 0) {
        expect(result.workUnits).toBeLessThanOrEqual(previousWorkUnits * 2 + 64 * 1024);
      }
      previousWorkUnits = result.workUnits;
    }
  });

  it("bounds malformed CSS and JavaScript scans on standalone files and HTML raw text", () => {
    const sizes = [12, 24, 48, 96, 192, 256].map(kib => kib * 1024);
    const cases = [
      { extension: ".css", prefix: "url(", wrapper: (payload: string): string => payload },
      { extension: ".css", prefix: "@import \"", wrapper: (payload: string): string => payload },
      { extension: ".js", prefix: "import x ", wrapper: (payload: string): string => payload },
      { extension: ".js", prefix: "fetch(\"", wrapper: (payload: string): string => payload },
      { extension: ".html", prefix: "import x ", wrapper: (payload: string): string => `<script>${payload}</script>` },
      { extension: ".html", prefix: "url(", wrapper: (payload: string): string => `<style>${payload}</style>` }
    ];

    for (const testCase of cases) {
      let previousWorkUnits = 0;
      for (const size of sizes) {
        const wrapperOverhead = testCase.wrapper("").length;
        const payloadSize = Math.max(0, size - wrapperOverhead);
        const payload = testCase.prefix.repeat(Math.ceil(payloadSize / testCase.prefix.length)).slice(0, payloadSize);
        const content = testCase.wrapper(payload);
        const result = extractReferences(content, testCase.extension, 2_000, size);
        const scan = testCase.extension === ".html" ? result.htmlScan : result.textScan;

        expect(content).toHaveLength(size);
        expect(scan).toBeDefined();
        if (!scan) throw new Error("Bounded scan metadata is required");
        expect(scan.complete).toBe(true);
        expect(scan.scannedCharacters).toBe(size);
        expect(scan.workUnits).toBeLessThanOrEqual(size * 20);
        if (previousWorkUnits > 0) {
          expect(scan.workUnits).toBeLessThanOrEqual(previousWorkUnits * 2 + 96 * 1024);
        }
        previousWorkUnits = scan.workUnits;
      }
    }
  });

  it("stops at an explicit character budget and reports partial findings", () => {
    const prefix = "<script></script>";
    const content = `${prefix}${"<button onclick=run>".repeat(32)}`;
    const maxCharacters = prefix.length + 5;

    const result = scanHtmlDocument(content, { maxCharacters });

    expect(result.complete).toBe(false);
    expect(result.reason).toBe("budget-exhausted");
    expect(result.scannedCharacters).toBe(maxCharacters);
    expect(result.pageScriptCount).toBe(1);
    expect(result.workUnits).toBeLessThanOrEqual(maxCharacters * 12);
  });

  it("marks a capped script-entry count as a lower bound even after scanning the whole document", () => {
    const result = scanHtmlDocument(
      "<script></script><button onclick=one></button><a href='javascript:two()'>run</a>",
      { maxPageScripts: 2 }
    );

    expect(result.complete).toBe(true);
    expect(result.pageScriptCount).toBe(2);
    expect(result.scriptCountComplete).toBe(false);
  });

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

  it("does not retain a single huge URL or exceed the cumulative character budget", () => {
    const huge = `https://example.com/${"x".repeat(20_000)}`;
    const medium = `https://example.com/${"y".repeat(700)}`;
    const result = extractReferences(
      `<img src="${huge}"><img src="${medium}"><img src="${medium}z">`,
      ".html",
      10,
      100_000,
      undefined,
      1_024
    );

    expect(result.storageTruncated).toBe(true);
    expect(result.storedReferenceCharacters).toBeLessThanOrEqual(1_024);
    expect(result.external).not.toContain(huge);
    expect(result.external.join("").length).toBeLessThanOrEqual(1_024);
  });
});
