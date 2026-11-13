// Run only against an explicitly marked, disposable Obsidian vault.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const vault = process.env.HTML_STUDIO_TEST_VAULT;
assert.ok(vault && path.isAbsolute(vault));
assert.equal((await fs.readFile(path.join(vault, ".html-studio-runtime-test"), "utf8")).trim(), "disposable-test-vault");
const sample = process.env.HTML_STUDIO_CANVAS_SAMPLE;
const project = await fs.realpath(fileURLToPath(new URL("../../../..", import.meta.url)));
if (sample) assert.ok((await fs.realpath(sample)).startsWith(project + path.sep), "Sample must be a local project copy");
const html = sample ? await fs.readFile(sample, "utf8")
  : await fs.readFile(new URL("../fixtures/fixed-canvas.html", import.meta.url), "utf8") + `<!--${"x".repeat(5 * 1024 * 1024)}-->`;
const browser = await chromium.connectOverCDP(process.env.HTML_STUDIO_TEST_CDP ?? "http://127.0.0.1:9234");
const main = browser.contexts()[0].pages().find(page => page.url().includes("/index.html"));
assert.ok(main);
assert.equal(await main.evaluate(() => app.vault.adapter.getBasePath()), vault);
main.setDefaultTimeout(10000);
const artifacts = process.env.HTML_STUDIO_TEST_ARTIFACTS;
if (artifacts) await fs.mkdir(artifacts, { recursive: true });
const root = `fixed-canvas-${Date.now()}`, file = `${root}/整页缩放.html`;
const original = await main.evaluate(() => ({ settings: JSON.parse(JSON.stringify(app.plugins.plugins["zj-html-studio"].settings)),
  left: app.workspace.leftSplit.collapsed, right: app.workspace.rightSplit.collapsed }));
if (artifacts) await fs.writeFile(path.join(artifacts, "before.json"), JSON.stringify(original, null, 2));
const leafIds = [], checks = [], layouts = [], errors = [];
main.on("pageerror", error => errors.push(error.stack ?? error.message));
const source = () => main.locator(".html-studio-preview-canvas:not(.html-studio-preview-candidate) .html-studio-iframe:visible");
const frame = () => source().contentFrame();
let baseline, passed = false;
const measure = async label => {
  await frame().locator("#stage").waitFor();
  await main.waitForTimeout(450); // Let the actual sidebar transition and resize handler settle.
  await frame().locator("#stage").evaluate(async stage => {
    await document.fonts.ready;
    await Promise.all(stage.getAnimations({ subtree: true })
      .filter(animation => Number.isFinite(animation.effect.getComputedTiming().endTime))
      .map(animation => animation.finished.catch(() => {})));
  });
  const geometry = await frame().locator("#stage").evaluate(stage => {
    const r = stage.getBoundingClientRect();
    const title = stage.querySelector(".slide.active h1, .slide.active h2").getBoundingClientRect();
    return { width: stage.clientWidth, height: stage.clientHeight, viewportWidth: innerWidth, viewportHeight: innerHeight,
      left: r.left, top: r.top, right: r.right, bottom: r.bottom, ratio: r.width / r.height,
      titleWidth: title.width / r.width, titleLeft: (title.left - r.left) / r.width,
      titleTop: (title.top - r.top) / r.height };
  });
  layouts.push({ label, ...geometry });
  assert.equal(geometry.width, 1280, label); assert.equal(geometry.height, 720, label);
  assert.ok(Math.abs(geometry.ratio - 16 / 9) < 0.0001, label);
  assert.ok(geometry.left >= -1 && geometry.top >= -1, label);
  assert.ok(geometry.right <= geometry.viewportWidth + 1 && geometry.bottom <= geometry.viewportHeight + 1, label);
  if (!baseline) baseline = geometry;
  for (const name of ["titleWidth", "titleLeft", "titleTop"]) assert.ok(Math.abs(geometry[name] - baseline[name]) < 0.0001, `${label}: ${name}`);
};
try {
  await main.evaluate(async ({ root, file, html }) => {
    const p = app.plugins.plugins["zj-html-studio"];
    if (p.presenter.output) throw Error("Stop the existing test presentation first");
    await app.vault.createFolder(root); await app.vault.create(file, html);
    p.settings.interactiveScopes.push(root); await p.saveData(p.settings);
  }, { root, file, html });
  const id = await main.evaluate(() => app.workspace.getLeaf("tab").id); leafIds.push(id);
  const opening = main.evaluate(async ({ id, file }) => {
    let selected; app.workspace.iterateAllLeaves(leaf => { if (leaf.id === id) selected = leaf; });
    await selected.openFile(app.vault.getAbstractFileByPath(file));
  }, { id, file });
  await opening;
  for (const [left, right, label] of [[true, true, "both-sidebars"], [true, false, "left-sidebar"], [false, true, "right-sidebar"], [false, false, "wide"]]) {
    await main.evaluate(({ left, right }) => {
      app.workspace.leftSplit[left ? "expand" : "collapse"](); app.workspace.rightSplit[right ? "expand" : "collapse"]();
    }, { left, right });
    await measure(label);
    if (artifacts && ["both-sidebars", "wide"].includes(label)) await source().screenshot({ path: path.join(artifacts, `${label}.png`) });
  }
  checks.push("Both, left, right and no sidebar preserve the 1280 × 720 canvas, text proportions and all four visible edges");
  for (const [width, height] of [[620, 520], [1024, 350], [320, 500]]) {
    await main.evaluate(({ width, height }) => {
      const el = app.plugins.plugins["zj-html-studio"].presenter.source.contentEl;
      el.setCssProps({ width: `${width}px`, height: `${height}px`, flex: "none" });
    }, { width, height });
    await measure(`${width}x${height}`);
  }
  checks.push("Narrow and short preview areas keep the complete canvas and unchanged composition");
  await main.evaluate(() => {
    const el = app.plugins.plugins["zj-html-studio"].presenter.source.contentEl;
    for (const name of ["width", "height", "flex"]) el.style.removeProperty(name);
  });
  for (const zoom of [50, 150, 100]) {
    await main.evaluate(zoom => { const source = app.plugins.plugins["zj-html-studio"].presenter.source; source.zoom = zoom; source.applyZoom(); source.updateToolbarState(); }, zoom);
    await measure(`zoom-${zoom}`);
  }
  checks.push("Existing 50%, 150% and 100% controls retain the canvas ratio");
  await frame().locator("#next").click();
  const pageCounter = sample ? "#curno" : "#page";
  assert.equal((await frame().locator(pageCounter).innerText()).trim(), sample ? "2" : "2 / 2");
  baseline = undefined; await measure("page-2");
  checks.push("The deck's own next button still works and page two retains the canvas ratio");
  // Fullscreen and native Escape are verified through the app UI separately.
  assert.deepEqual(errors, []); passed = true;
} finally {
  await main.evaluate(async ({ original, root, leafIds, passed }) => {
    if (document.fullscreenElement) await document.exitFullscreen();
    const p = app.plugins.plugins["zj-html-studio"], leaves = [];
    app.workspace.iterateAllLeaves(leaf => { if (leafIds.includes(leaf.id)) leaves.push(leaf); });
    for (const leaf of leaves) { leaf.view.activeScopeModal?.cancel(); leaf.detach(); }
    app.workspace.leftSplit[original.left ? "collapse" : "expand"](); app.workspace.rightSplit[original.right ? "collapse" : "expand"]();
    if (passed) { const folder = app.vault.getAbstractFileByPath(root); if (folder) await app.vault.trash(folder, false); }
    p.settings = original.settings; await p.saveData(p.settings);
  }, { original, root, leafIds, passed });
  const result = { passed, checks, layouts, errors, sample: Boolean(sample) };
  if (artifacts) await fs.writeFile(path.join(artifacts, "results.json"), JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify({ passed, checks, errors }) + "\n"); await browser.close();
}
