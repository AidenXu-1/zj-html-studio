// Compare approved and candidate styles on the same native Obsidian DOM.
// Restricted to a marked disposable vault; optional baseline is supplied by the caller.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const vault = process.env.HTML_STUDIO_TEST_VAULT;
assert.ok(vault && path.isAbsolute(vault));
assert.equal((await fs.readFile(path.join(vault, ".html-studio-runtime-test"), "utf8")).trim(), "disposable-test-vault");
const candidate = await fs.readFile(new URL("../../styles.css", import.meta.url), "utf8");
const baseline = process.env.HTML_STUDIO_BASELINE_CSS ? await fs.readFile(process.env.HTML_STUDIO_BASELINE_CSS, "utf8") : null;
const artifacts = process.env.HTML_STUDIO_TEST_ARTIFACTS;
if (artifacts) await fs.mkdir(artifacts, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.HTML_STUDIO_TEST_CDP ?? "http://127.0.0.1:9234");
const context = browser.contexts()[0];
const main = context.pages().find(page => page.url().includes("/index.html"));
assert.ok(main);
assert.equal(await main.evaluate(() => app.vault.adapter.getBasePath()), vault);
main.setDefaultTimeout(10000);
const root = `style-regression-${Date.now()}`;
const original = await main.evaluate(() => ({ css: app.vault.getConfig("cssTheme"), theme: app.getTheme(),
  settings: JSON.parse(JSON.stringify(app.plugins.plugins["zj-html-studio"].settings)) }));
const results = [], errors = [];
main.on("pageerror", error => errors.push(error.message));
const source = () => main.locator(".html-studio-view:visible");
const notes = () => main.locator(".html-studio-lecture:visible");
const apply = async (page, css, legacy) => {
  await page.evaluate(({ css, legacy }) => {
    const sheet = [...document.querySelectorAll("style")].find(el => el.textContent.includes(".html-studio-preview-surface"));
    if (!sheet) throw Error("Plugin stylesheet was not found");
    sheet.textContent = css;
    if (!document.getElementById("style-test-stabilizer")) {
      const stable = document.createElement("style"); stable.id = "style-test-stabilizer";
      stable.textContent = "*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}";
      document.head.append(stable);
    }
    // The old version used inline zoom. Reproduce that cascade for a fair baseline.
    document.querySelectorAll(".html-studio-iframe").forEach(frame => {
      const scale = Number(getComputedStyle(frame.parentElement).getPropertyValue("--html-studio-preview-zoom")) || 1;
      for (const name of ["width", "height", "transform"]) frame.style.removeProperty(name);
      if (legacy) Object.assign(frame.style, { width: `${100 / scale}%`, height: `${100 / scale}%`, transform: `scale(${scale})` });
    });
  }, { css, legacy });
  await page.waitForTimeout(200);
};
const snapshot = page => page.evaluate(() => {
  const roots = ".html-studio-view,.html-studio-lecture,.html-studio-access-modal,.html-studio-trust-modal,.html-studio-projection,.html-studio-embed-container";
  const props = ["display", "width", "height", "padding", "margin", "borderWidth", "borderRadius", "boxShadow", "backgroundColor", "backgroundImage", "color", "fontSize", "fontWeight", "lineHeight", "overflow", "gridTemplateColumns", "gridTemplateRows", "transform"];
  return [...document.querySelectorAll(roots)].flatMap(root => [root, ...root.querySelectorAll("*")]).filter(el => el.getClientRects().length && !el.closest("svg")).map(el => {
    const style = getComputedStyle(el), rect = el.getBoundingClientRect();
    return { tag: el.tagName, cls: el.className, box: [rect.x, rect.y, rect.width, rect.height].map(v => Math.round(v * 100) / 100), ...Object.fromEntries(props.map(key => [key, style[key]])) };
  });
});
const compare = async (name, page = main, screenshot = false) => {
  let before;
  if (baseline) {
    await apply(page, baseline, true);
    before = await snapshot(page);
    if (artifacts && screenshot) await page.screenshot({ path: path.join(artifacts, `${name}-before.png`) });
  }
  await apply(page, candidate, false);
  const after = await snapshot(page);
  if (artifacts && screenshot) await page.screenshot({ path: path.join(artifacts, `${name}-after.png`) });
  const differences = [];
  if (before) {
    if (before.length !== after.length) differences.push({ beforeCount: before.length, afterCount: after.length });
    for (let i = 0; i < Math.min(before.length, after.length); i++) {
      const delta = Object.keys(before[i]).filter(key => JSON.stringify(before[i][key]) !== JSON.stringify(after[i][key]));
      if (delta.length) differences.push({ i, cls: before[i].cls, changes: Object.fromEntries(delta.map(key => [key, [before[i][key], after[i][key]]])) });
    }
  }
  results.push({ name, elements: after.length, differences });
  process.stdout.write(`${name}: ${after.length} elements, ${differences.length} differences\n`);
};
try {
  await main.evaluate(async root => {
    const plugin = app.plugins.plugins["zj-html-studio"];
    if (plugin.presenter.output) throw Error("Stop the existing presentation first");
    for (const leaf of app.workspace.getLeavesOfType("html-studio-preview")) if (leaf.view.file?.path.startsWith("style-regression-")) leaf.detach();
    await app.vault.createFolder(root);
    const slides = Array.from({ length: 6 }, (_, i) => `<section id="p0${i + 1}" class="slide"><h1>课件 ${i + 1} · 样式验证</h1><p>统一样式与知识库</p></section>`).join("");
    await app.vault.create(`${root}/Demo.html`, `<!doctype html><style>body{margin:0;background:#172026;color:#fff;font:28px system-ui}.slide{display:none;padding:40px}.slide.active{display:block}</style>${slides}<script>const show=()=>document.querySelectorAll('.slide').forEach(s=>s.classList.toggle('active','#'+s.id===(location.hash||'#p01')));addEventListener('hashchange',show);show()</script><img src="missing.png">`);
    await app.vault.create(`${root}/Notes.md`, Array.from({ length: 6 }, (_, i) => `## 第 ${i + 1} 页\n\n### 讲述提示\n\n先问一个问题。\n\n- 第一项\n- **第二项**\n\n结尾。\n`).join("\n"));
    await plugin.setLectureAssociation(`${root}/Demo.html`, `${root}/Notes.md`);
    await app.workspace.getLeaf("tab").openFile(app.vault.getAbstractFileByPath(`${root}/Demo.html`));
  }, root);
  await main.waitForFunction(root => { const p = app.plugins.plugins["zj-html-studio"].presenter; return p.source?.file?.path === `${root}/Demo.html` && p.context?.deck.pages.length === 6 && p.source.searchBridgeReady; }, root);
  await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.showNotes());
  await notes().locator(".cm-content").waitFor();
  for (const css of ["", "Primary"]) for (const theme of ["obsidian", "moonstone"]) {
    await main.evaluate(({ css, theme }) => { app.customCss.setTheme(css); app.changeTheme(theme); }, { css, theme });
    await main.waitForTimeout(500);
    const label = `${css || "Default"}-${theme}`;
    await compare(`${label}-preview`, main, true);
    await notes().getByRole("button", { name: "选择课件页面", exact: true }).click();
    await compare(`${label}-page-menu`);
    await notes().getByRole("option").first().click();
    await notes().locator(".cm-content").click();
    await compare(`${label}-editing`);
    await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.source.openSearch());
    await source().locator(".html-studio-search-bar input").fill("知识库");
    await source().locator(".html-studio-search-count").filter({ hasText: "6" }).waitFor();
    await source().locator(".html-studio-search-count").click();
    await compare(`${label}-search-menu`);
    await source().getByRole("option").first().click();
    await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.source.closeSearch());
    await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.source.toggleDiagnostics());
    await compare(`${label}-diagnostics`);
    await source().evaluate(el => el.style.setProperty("width", "420px"));
    await compare(`${label}-narrow-diagnostics`);
    await source().getByRole("button", { name: "关闭页面信息", exact: true }).click();
    assert.equal(await source().locator(".html-studio-body").evaluate(el => el.classList.contains("is-showing-diagnostics")), false);
    await compare(`${label}-narrow-closed`);
    await source().evaluate(el => el.style.removeProperty("width"));
    await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.source.openModeModal());
    await main.locator(".html-studio-access-modal").waitFor();
    await compare(`${label}-permissions`);
    await main.bringToFront(); await main.keyboard.press("Escape");
  }
  for (const zoom of [50, 200, 100]) {
    await main.evaluate(zoom => { const view = app.plugins.plugins["zj-html-studio"].presenter.source; view.zoom = zoom; view.applyZoom(); view.updateToolbarState(); }, zoom);
    await compare(`zoom-${zoom}`);
    // Actual fullscreen/Escape is covered by zoom-regression.mjs. Replacing
    // the entire host stylesheet mid-fullscreen can interrupt the OS transition.
  }
  await source().getByRole("button", { name: "源码", exact: true }).click();
  await compare("source");
  await source().getByRole("button", { name: "预览", exact: true }).click();
  const opened = context.waitForEvent("page");
  await source().getByRole("button", { name: "投屏演示", exact: true }).click();
  const output = await opened;
  await main.waitForFunction(() => app.plugins.plugins["zj-html-studio"].presenter.output?.ready);
  await compare("projection", output, true);
  await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.stopProjection());
  await main.evaluate(async root => {
    const file = await app.vault.create(`${root}/Embed.md`, `![[${root}/Demo.html|500x300]]`);
    await app.workspace.getLeaf("tab").openFile(file, { state: { mode: "preview" } });
  }, root);
  await main.locator(".html-studio-embed:visible iframe").waitFor();
  await compare("markdown-embed");
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(results.filter(r => r.differences.length).length, 0, "Style differences: see report.json");
} finally {
  await apply(main, candidate, false).catch(() => {});
  await main.evaluate(async ({ root, original }) => {
    const plugin = app.plugins.plugins["zj-html-studio"];
    if (document.fullscreenElement) await document.exitFullscreen();
    await plugin.presenter.stopProjection();
    for (const leaf of app.workspace.getLeavesOfType("html-studio-preview")) if (leaf.view.file?.path.startsWith(root + "/")) leaf.detach();
    plugin.settings = original.settings; await plugin.saveData(plugin.settings);
    document.getElementById("style-test-stabilizer")?.remove();
    app.customCss.setTheme(original.css); app.changeTheme(original.theme);
    const folder = app.vault.getAbstractFileByPath(root); if (folder) await app.vault.delete(folder, true);
  }, { root, original }).catch(error => errors.push(error.message));
  if (artifacts) await fs.writeFile(path.join(artifacts, "report.json"), JSON.stringify({ results, errors }, null, 2));
  await browser.close();
}
