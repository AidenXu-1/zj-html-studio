// Only operate on an explicitly marked disposable vault; never the daily vault.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const vault = process.env.HTML_STUDIO_TEST_VAULT;
assert.ok(vault && path.isAbsolute(vault));
assert.equal((await fs.readFile(path.join(vault, ".html-studio-runtime-test"), "utf8")).trim(), "disposable-test-vault");
const browser = await chromium.connectOverCDP(process.env.HTML_STUDIO_TEST_CDP ?? "http://127.0.0.1:9234");
const context = browser.contexts()[0], main = context.pages().find(page => page.url().includes("/index.html"));
assert.ok(main); assert.equal(await main.evaluate(() => app.vault.adapter.getBasePath()), vault);
main.setDefaultTimeout(10000);
const artifacts = process.env.HTML_STUDIO_TEST_ARTIFACTS;
if (artifacts) await fs.mkdir(artifacts, { recursive: true });
const errors = [], checks = [], measurements = [], leafIds = [];
const observe = page => page.on("pageerror", error => errors.push(error.stack || error.message || String(error)));
context.pages().forEach(observe); context.on("page", observe);
const root = `zoom-regression-${Date.now()}`;
const fixed = await fs.readFile(new URL("../fixtures/fixed-canvas.html", import.meta.url), "utf8");
const delayed = `<!doctype html><style>html,body{height:100%;margin:0;overflow:hidden}.slide{position:absolute;inset:0;display:none;background:#ddd;padding:40px}.active{display:block}nav{position:fixed;bottom:20px;right:20px}</style>
${["First", "Needle second", "Needle third"].map((text, i) => `<section class="slide ${i === 0 ? "active" : ""}"><h1>${text}</h1></section>`).join("")}
<nav><button id="prev">Previous</button><button id="next">Next</button><span id="counter"></span></nav><script>let n=0;function show(){document.querySelectorAll('.slide').forEach((e,i)=>e.classList.toggle('active',i===n));document.querySelector('#counter').textContent=(n+1)+' / 3'};function go(delta){setTimeout(()=>{n=Math.max(0,Math.min(2,n+delta));show()},100)};document.querySelector('#prev').onclick=()=>go(-1);document.querySelector('#next').onclick=()=>go(1);show();</script>`;
const original = await main.evaluate(() => ({ settings: JSON.parse(JSON.stringify(app.plugins.plugins["zj-html-studio"].settings)),
  left: app.workspace.leftSplit.collapsed, right: app.workspace.rightSplit.collapsed }));
let passed = false, popout;
const sourceFrame = page => page.locator(".html-studio-preview-canvas:not(.html-studio-preview-candidate) .html-studio-iframe:visible");
const canvas = page => page.locator(".html-studio-preview-canvas:not(.html-studio-preview-candidate):visible");
const waitPage = async n => main.waitForFunction(n => app.plugins.plugins["zj-html-studio"].presenter.source?.getLectureContext()?.deck.current === n, n);
const selectZoom = async (page, value) => {
  await page.locator(".html-studio-zoom-label:visible").click();
  await page.getByText(value === 100 ? "100% · 默认" : `${value}%`, { exact: true }).click();
  await page.waitForFunction(value => document.querySelector(".html-studio-zoom-label")?.getAttribute("aria-label") === `缩放：${value}%`, value);
};
const geometry = async (page, label) => {
  const frame = sourceFrame(page);
  const outer = await frame.evaluate(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height,
    clientWidth: el.clientWidth, clientHeight: el.clientHeight }));
  const inner = await frame.contentFrame().locator("#stage").evaluate(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }));
  const value = { label, ...outer, actualWidth: inner.width * outer.width / outer.clientWidth,
    actualHeight: inner.height * outer.height / outer.clientHeight };
  measurements.push(value); return value;
};
try {
  await main.evaluate(async ({ root, fixed, delayed }) => {
    const plugin = app.plugins.plugins["zj-html-studio"];
    if (plugin.presenter.output) throw Error("Existing test projection must be closed first");
    await app.vault.createFolder(root);
    await app.vault.create(`${root}/fixed.html`, fixed); await app.vault.create(`${root}/delayed.html`, delayed);
    await app.vault.create(`${root}/notes.md`, "## 第 1 页\nNOTE_1\n\n## 第 2 页\nNOTE_2\n\n## 第 3 页\nNOTE_3");
    await plugin.setLectureAssociation(`${root}/delayed.html`, `${root}/notes.md`);
  }, { root, fixed, delayed });
  const id = await main.evaluate(async root => {
    const leaf = app.workspace.getLeaf("tab"); await leaf.openFile(app.vault.getAbstractFileByPath(`${root}/fixed.html`)); return leaf.id;
  }, root); leafIds.push(id);
  await main.waitForFunction(() => Boolean(app.plugins.plugins["zj-html-studio"].presenter.source?.getPresentationContext()));
  await main.bringToFront();
  const base = await geometry(main, "100%");
  for (const value of [50, 200, 125, 100]) {
    await selectZoom(main, value);
    const actual = await geometry(main, `${value}%`);
    assert.ok(Math.abs(actual.actualWidth / base.actualWidth - value / 100) < .01);
    assert.ok(Math.abs(actual.actualHeight / base.actualHeight - value / 100) < .01);
    assert.ok(Math.abs(actual.clientWidth - base.clientWidth) < 2);
    if (artifacts) await main.screenshot({ path: path.join(artifacts, `zoom-${value}.png`) });
  }
  checks.push("Real zoom menu scales the entire canvas at 50/125/200%, preserving the authored layout");
  await selectZoom(main, 200);
  await canvas(main).evaluate(el => { el.scrollLeft = 80; el.scrollTop = 40; });
  const previousToken = await main.evaluate(() => {
    const view = app.plugins.plugins["zj-html-studio"].presenter.source;
    const token = view.session.token; view.refreshPreview(); return token;
  });
  await main.waitForFunction(token => {
    const view = app.plugins.plugins["zj-html-studio"].presenter.source;
    return view.session.token !== token && !view.candidateHost;
  }, previousToken);
  assert.deepEqual(await canvas(main).evaluate(el => [el.scrollLeft, el.scrollTop]), [80, 40]);
  await main.evaluate(() => {
    window.__zoomFullscreenEntered = false; window.__zoomFullscreenLeft = false;
    window.electronWindow.once("enter-full-screen", () => { window.__zoomFullscreenEntered = true; });
    window.electronWindow.once("leave-full-screen", () => { window.__zoomFullscreenLeft = true; });
  });
  await main.locator(".html-studio-fullscreen-button:visible").click();
  await main.waitForFunction(() => Boolean(document.fullscreenElement));
  await main.waitForFunction(() => window.__zoomFullscreenEntered);
  measurements.push(await main.evaluate(() => {
    const el = document.fullscreenElement, rect = el.getBoundingClientRect(), css = getComputedStyle(el);
    return { label: "fullscreen", tag: el.tagName, connected: el.isConnected, className: el.className,
      transform: css.transform, width: css.width, height: css.height, rect: rect.toJSON(),
      viewport: [innerWidth, innerHeight], style: el.getAttribute("style") };
  }));
  await main.waitForFunction(() => document.fullscreenElement && getComputedStyle(document.fullscreenElement).transform === "none");
  await main.bringToFront();
  await main.keyboard.press("Escape");
  await main.waitForFunction(() => !document.fullscreenElement);
  await main.waitForFunction(() => window.__zoomFullscreenLeft);
  assert.deepEqual(await canvas(main).evaluate(el => [el.scrollLeft, el.scrollTop]), [80, 40]);
  assert.ok(Math.abs((await geometry(main, "after-fullscreen")).actualWidth / base.actualWidth - 2) < .01);
  checks.push("Refresh and fullscreen/Escape preserve local zoom and pan; fullscreen displays the complete course");

  // Hold a real refresh at its last asynchronous stage so a quick fullscreen
  // click cannot be missed by a timing-dependent test.
  const raceToken = await main.evaluate(() => {
    const view = app.plugins.plugins["zj-html-studio"].presenter.source;
    const original = view.refreshCandidateReadingState;
    window.__zoomRestoreRefresh = () => { view.refreshCandidateReadingState = original; };
    window.__zoomRefreshWaiting = false;
    view.refreshCandidateReadingState = async function (candidate) {
      await original.call(this, candidate);
      await new Promise(resolve => { window.__zoomReleaseRefresh = resolve; window.__zoomRefreshWaiting = true; });
    };
    window.__zoomRaceReload = view.reloadWithCandidateSession(view.file, "manual");
    return view.session.token;
  });
  await main.waitForFunction(() => window.__zoomRefreshWaiting);
  await main.evaluate(() => {
    window.__zoomFullscreenEntered = false; window.__zoomFullscreenLeft = false;
    window.electronWindow.once("enter-full-screen", () => { window.__zoomFullscreenEntered = true; });
    window.electronWindow.once("leave-full-screen", () => { window.__zoomFullscreenLeft = true; });
  });
  await main.locator(".html-studio-fullscreen-button:visible").click();
  await main.waitForFunction(() => document.fullscreenElement && window.__zoomFullscreenEntered);
  await main.evaluate(async () => {
    window.__zoomRestoreRefresh(); window.__zoomReleaseRefresh(); await window.__zoomRaceReload;
  });
  assert.equal(await main.evaluate(() => document.fullscreenElement === app.plugins.plugins["zj-html-studio"].presenter.source.activeIframe), true);
  assert.equal(await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.source.session.token), raceToken);
  await main.bringToFront(); await main.keyboard.press("Escape");
  await main.waitForFunction(token => {
    const view = app.plugins.plugins["zj-html-studio"].presenter.source;
    return !document.fullscreenElement && window.__zoomFullscreenLeft && view.session.token !== token && !view.candidateHost;
  }, raceToken);
  assert.deepEqual(await canvas(main).evaluate(el => [el.scrollLeft, el.scrollTop]), [80, 40]);
  checks.push("Entering fullscreen during an in-flight refresh keeps the course visible and applies refresh after Escape");

  assert.equal(await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.source.getPresentationContext().picture), true);
  const opened = context.waitForEvent("page"); await main.locator(".html-studio-projection-button:visible").click();
  const output = await opened;
  await main.waitForFunction(() => app.plugins.plugins["zj-html-studio"].presenter.output?.ready, null, { timeout: 20000 });
  await main.bringToFront();
  const frames = await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.output.view.picture.frames);
  await main.waitForFunction(frames => app.plugins.plugins["zj-html-studio"].presenter.output.view.picture.frames > frames + 2, frames);
  assert.ok(await output.locator(".html-studio-projection-picture").evaluate(img => img.naturalWidth > 100 && img.naturalHeight > 100));
  await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.stopProjection());
  checks.push("Picture projection continues delivering course-only frames at 200% with a scrolled preview");

  await selectZoom(main, 100);
  await main.evaluate(async root => {
    const p = app.plugins.plugins["zj-html-studio"].presenter;
    await p.source.leaf.openFile(app.vault.getAbstractFileByPath(`${root}/delayed.html`)); await p.showNotes();
  }, root);
  await main.waitForFunction(() => app.plugins.plugins["zj-html-studio"].presenter.source?.getLectureContext()?.deck.pages.length === 3);
  await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.jump(3)); await waitPage(3);
  await main.evaluate(() => { const view = app.plugins.plugins["zj-html-studio"].presenter.source; view.openSearch(); });
  await main.locator(".html-studio-search-bar input:visible").fill("Needle");
  await main.waitForFunction(() => app.plugins.plugins["zj-html-studio"].presenter.source.searchMatchPages.length === 2);
  await waitPage(3);
  await main.evaluate(() => {
    const leaf = app.plugins.plugins["zj-html-studio"].presenter.source.leaf;
    window.__zoomHome = { parent: leaf.parent, index: leaf.parent.children.indexOf(leaf) };
  });
  const moved = context.waitForEvent("page");
  await main.evaluate(() => { app.workspace.moveLeafToPopout(app.plugins.plugins["zj-html-studio"].presenter.source.leaf); });
  popout = await moved; await waitPage(3);
  await main.waitForFunction(() => app.plugins.plugins["zj-html-studio"].presenter.source.searchMatchPages.length === 2);
  assert.equal(await main.locator('input[aria-label="跳转到课件页码"]').inputValue(), "3");
  const placeholderId = await main.evaluate(() => {
    const leaf = app.plugins.plugins["zj-html-studio"].presenter.source.leaf;
    const placeholder = app.workspace.createLeafInParent(leaf.parent, leaf.parent.children.length);
    leaf.parent.removeChild(leaf); window.__zoomHome.parent.insertChild(window.__zoomHome.index, leaf);
    app.workspace.setActiveLeaf(leaf, { focus: true }); return placeholder.id;
  });
  await waitPage(3);
  const closed = popout.waitForEvent("close");
  await main.evaluate(id => app.workspace.iterateAllLeaves(leaf => { if (leaf.id === id) leaf.detach(); }), placeholderId);
  await closed;
  await main.waitForFunction(() => app.plugins.plugins["zj-html-studio"].presenter.source.searchMatchPages.length === 2);
  assert.equal(await main.locator('input[aria-label="跳转到课件页码"]').inputValue(), "3");
  checks.push("Retained search survives an async-navigation course moving out and back without cancelling page 3 restoration or notes");
  assert.deepEqual(errors, []); passed = true;
} catch (error) {
  checks.push({ failure: error.stack || String(error) });
  if (artifacts) await main.screenshot({ path: path.join(artifacts, "failure.png") });
  process.exitCode = 1;
} finally {
  await main.evaluate(async ({ root, original, leafIds, passed }) => {
    window.__zoomRestoreRefresh?.(); window.__zoomReleaseRefresh?.();
    await window.__zoomRaceReload;
    if (document.fullscreenElement) await document.exitFullscreen();
    const p = app.plugins.plugins["zj-html-studio"]; p.presenter.stopProjection(); await p.presenter.notes.flush();
    const leaves = []; app.workspace.iterateAllLeaves(leaf => { if (leafIds.includes(leaf.id)) leaves.push(leaf); });
    leaves.forEach(leaf => leaf.detach());
    p.settings = original.settings; await p.saveData(p.settings);
    app.workspace.leftSplit[original.left ? "collapse" : "expand"](); app.workspace.rightSplit[original.right ? "collapse" : "expand"]();
    if (passed) { const folder = app.vault.getAbstractFileByPath(root); if (folder) await app.vault.trash(folder, false); }
    delete window.__zoomHome;
    delete window.__zoomFullscreenEntered; delete window.__zoomFullscreenLeft;
    delete window.__zoomRestoreRefresh; delete window.__zoomReleaseRefresh;
    delete window.__zoomRaceReload; delete window.__zoomRefreshWaiting;
  }, { root, original, leafIds, passed });
  const result = { passed, checks, measurements, errors };
  if (artifacts) await fs.writeFile(path.join(artifacts, "results.json"), JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result) + "\n"); await browser.close();
}
