// Direct opening and exact-file consent, only in a marked disposable Obsidian vault.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const vault = process.env.HTML_STUDIO_TEST_VAULT;
assert.ok(vault && path.isAbsolute(vault));
assert.equal((await fs.readFile(path.join(vault, ".html-studio-runtime-test"), "utf8")).trim(), "disposable-test-vault");
const browser = await chromium.connectOverCDP(process.env.HTML_STUDIO_TEST_CDP ?? "http://127.0.0.1:9234");
const main = browser.contexts()[0].pages().find(page => page.url().includes("/index.html"));
assert.ok(main);
assert.equal(await main.evaluate(() => app.vault.adapter.getBasePath()), vault);
main.setDefaultTimeout(10000);
const artifacts = process.env.HTML_STUDIO_TEST_ARTIFACTS;
if (artifacts) await fs.mkdir(artifacts, { recursive: true });
const root = `default-opening-${Date.now()}`, folder = `${root}/course`, file = `${folder}/course.html`;
const original = await main.evaluate(() => ({ settings: JSON.parse(JSON.stringify(app.plugins.plugins["zj-html-studio"].settings)),
  theme: app.getTheme(), css: app.vault.getConfig("cssTheme"), zoom: window.require("electron").webFrame.getZoomFactor() }));
const checks = [], errors = [], leafIds = [], layouts = [];
main.on("pageerror", error => errors.push(error.stack ?? error.message));
const modal = () => main.locator(".html-studio-resource-modal:visible");
const source = () => main.locator(".html-studio-preview-canvas:not(.html-studio-preview-candidate) .html-studio-iframe:visible").last();
const state = () => main.evaluate(() => {
  const s = app.plugins.plugins["zj-html-studio"].presenter.source;
  return { mode: s?.mode, token: s?.session?.token, grants: s?.session?.approvedFiles ?? [] };
});
const open = async () => {
  leafIds.push(await main.evaluate(async file => {
    const leaf = app.workspace.getLeaf("tab"); await leaf.openFile(app.vault.getAbstractFileByPath(file), { active: true }); return leaf.id;
  }, file));
  await source().contentFrame().locator("body[data-private-status='403']").waitFor();
  assert.equal(await modal().count(), 0);
};
const grant = async () => {
  await main.evaluate(() => { const s = app.plugins.plugins["zj-html-studio"].presenter.source; if (!s.diagnosticsDrawer?.hasClass("is-open")) s.toggleDiagnostics(); });
  await main.locator(".html-studio-diagnostic-card").filter({ hasText: "data.json" }).first()
    .getByRole("button", { name: "允许读取此文件…", exact: true }).click();
  await modal().waitFor();
};
let passed = false;
try {
  await main.evaluate(async ({ root, folder, file }) => {
    const p = app.plugins.plugins["zj-html-studio"];
    if (p.presenter.output) throw Error("Stop existing test projection first");
    p.settings = { ...p.settings, defaultMode: "standard", safeScopes: [], interactiveScopes: [], trustedScopes: [], standardScopes: [] };
    await app.vault.createFolder(root); await app.vault.createFolder(folder);
    await app.vault.create(`${root}/style.css`, "body{font:24px system-ui;padding:40px}button{padding:12px}");
    await app.vault.create(`${folder}/data.json`, '{"lesson":"approved-data"}');
    await app.vault.create(`${folder}/private.md`, "PRIVATE_NOTE_MUST_NOT_LEAK");
    await app.vault.create(file, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="../style.css"></head><body>
      <h1>直接打开 HTML</h1><p>翻页、动画与在线内容可以直接使用。</p><!--${"x".repeat(6 * 1024 * 1024)}-->
      <button onclick="this.textContent='交互正常'">测试交互</button><script>
      fetch('data.json').then(async r=>{document.body.dataset.dataStatus=r.status;document.body.dataset.dataBody=await r.text()});
      fetch('private.md').then(async r=>{document.body.dataset.privateStatus=r.status;document.body.dataset.privateBody=await r.text()});
      document.body.dataset.node=typeof require;
      </script></body></html>`);
  }, { root, folder, file });
  await open();
  assert.equal((await state()).mode, "standard");
  assert.equal(await main.locator(".html-studio-script-notice:visible").count(), 0);
  await source().contentFrame().getByRole("button", { name: "测试交互" }).click();
  assert.equal(await source().contentFrame().getByRole("button", { name: "交互正常" }).count(), 1);
  assert.equal(await source().contentFrame().locator("body").getAttribute("data-node"), "undefined");
  checks.push("Large HTML opens without a dialog or script warning; interaction works and Node is unavailable");
  if (artifacts) await main.locator(".html-studio-view:visible").last().screenshot({ path: path.join(artifacts, "direct-opening.png") });
  await grant();
  assert.doesNotMatch(await modal().innerText(), /整个知识库|扩大范围/);
  for (const [theme, width, height, zoom, label] of [["moonstone", 480, 650, 1, "light"], ["obsidian", 480, 650, 1, "dark"], ["moonstone", 320, 390, 1.25, "narrow"]]) {
    await main.evaluate(({ theme, width, height, zoom }) => {
      app.changeTheme(theme); window.require("electron").webFrame.setZoomFactor(zoom);
      const el = document.querySelector(".html-studio-resource-modal"); el.style.width = `${width}px`; el.style.maxHeight = `${height}px`;
    }, { theme, width, height, zoom });
    await modal().locator("details").evaluate(el => { el.open = true; });
    const geometry = await modal().evaluate(el => {
      const r = el.getBoundingClientRect(); const buttons = [...el.querySelectorAll("button")].map(b => b.getBoundingClientRect());
      return { overflow: el.scrollWidth > el.clientWidth + 1,
        inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        visible: buttons.every(b => b.top >= r.top && b.bottom <= r.bottom && b.left >= r.left && b.right <= r.right), height: r.height };
    });
    assert.equal(geometry.overflow, false); assert.equal(geometry.visible, true); assert.equal(geometry.inViewport, true);
    layouts.push({ label, ...geometry });
    // Element clipping in CDP does not account for Electron's page zoom.
    // Capture the whole viewport at non-default zoom to preserve visible bounds.
    if (artifacts) {
      const target = zoom === 1 ? modal() : main;
      await target.screenshot({ path: path.join(artifacts, `${label}.png`) });
    }
  }
  await main.keyboard.press("Escape"); assert.deepEqual((await state()).grants, []);
  checks.push("Dialog remains usable in light/dark and narrow zoomed windows; Escape grants nothing");
  await main.evaluate(() => window.require("electron").webFrame.setZoomFactor(1));
  await grant(); await modal().getByRole("button", { name: "允许读取", exact: true }).click();
  await source().contentFrame().locator("body[data-data-status='200'][data-private-status='403']").waitFor();
  assert.deepEqual((await state()).grants, [`${folder}/data.json`]);
  assert.doesNotMatch(await source().contentFrame().locator("body").getAttribute("data-private-body"), /PRIVATE_NOTE/);
  checks.push("Only the approved file becomes readable; neighboring Markdown remains blocked");
  const before = (await state()).token;
  await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.source.refreshPreview());
  await main.waitForFunction(token => app.plugins.plugins["zj-html-studio"].presenter.source?.session?.token !== token, before);
  await source().contentFrame().locator("body[data-data-status='200'][data-private-status='403']").waitFor();
  checks.push("Refresh keeps only the selected file grant");
  const activeToken = (await state()).token;
  await main.evaluate(() => app.plugins.plugins["zj-html-studio"].resetScopeModes());
  assert.equal((await state()).mode, "safe");
  assert.deepEqual((await state()).grants, []);
  assert.equal(await main.evaluate(async token => (await app.plugins.plugins["zj-html-studio"].previewServer.probeSessionEntry(token)).statusCode, activeToken), 403);
  checks.push("Global restriction reset revokes temporary file grants and the previous session");
  await main.evaluate(() => app.plugins.plugins["zj-html-studio"].setDefaultInteraction(true));
  await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.source.leaf.detach());
  await open(); await source().contentFrame().locator("body[data-data-status='403']").waitFor();
  assert.deepEqual((await state()).grants, []);
  checks.push("Reopening discards temporary file consent");
  assert.deepEqual(errors, []); passed = true;
} finally {
  await main.evaluate(async ({ original, leafIds }) => {
    const leaves = []; app.workspace.iterateAllLeaves(leaf => { if (leafIds.includes(leaf.id)) leaves.push(leaf); });
    for (const leaf of leaves) { leaf.view.activeScopeExpansionModal?.cancel(); leaf.detach(); }
    app.plugins.plugins["zj-html-studio"].settings = original.settings;
    await app.plugins.plugins["zj-html-studio"].saveData(original.settings);
    window.require("electron").webFrame.setZoomFactor(original.zoom); app.customCss.setTheme(original.css); app.changeTheme(original.theme);
  }, { original, leafIds });
  const result = { checks, layouts, errors, passed };
  if (artifacts) await fs.writeFile(path.join(artifacts, "results.json"), JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result) + "\n"); await browser.close();
}
