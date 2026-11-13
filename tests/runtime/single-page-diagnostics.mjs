// Native Chromium acceptance, exclusively inside a marked disposable Obsidian vault.
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
main.setDefaultTimeout(8000);
const artifacts = process.env.HTML_STUDIO_TEST_ARTIFACTS;
if (artifacts) await fs.mkdir(artifacts, { recursive: true });
const root = `single-page-diagnostics-${Date.now()}`;
const files = ["普通网页.html", "交互网页.html", "分页课件.html", "大文件网页.html"].map(name => `${root}/${name}`);
const original = await main.evaluate(() => ({
  settings: JSON.parse(JSON.stringify(app.plugins.plugins["zj-html-studio"].settings)),
  css: app.vault.getConfig("cssTheme"), theme: app.getTheme(),
  zoom: window.require("electron").webFrame.getZoomFactor()
}));
const checks = [], errors = [], layouts = [], notes = [];
main.on("pageerror", error => errors.push(error.stack ?? error.message));
const sidebar = () => main.locator(".html-studio-lecture:visible");
const input = () => sidebar().getByRole("textbox", { name: "跳转到课件页码" });
const editor = () => sidebar().locator(".cm-content");
const open = async file => {
  const opened = main.evaluate(async file => {
    await app.workspace.getLeaf("tab").openFile(app.vault.getAbstractFileByPath(file));
  }, file);
  // Large documents exceed dependency analysis's budget. Exercise the existing
  // folder-only safe fallback instead of granting access to the entire vault.
  if (file === files[3]) await main.getByRole("button", { name: "先预览", exact: true }).click();
  await opened;
  await main.waitForFunction(file => {
    const p = app.plugins.plugins["zj-html-studio"].presenter;
    return p.source?.file?.path === file && p.lectureContext;
  }, file);
};
const saved = () => sidebar().locator(".html-studio-lecture-save").filter({ hasText: /^已保存$/ }).waitFor();
const shot = async name => { if (artifacts) await main.screenshot({ path: path.join(artifacts, `${name}.png`) }); };
let passed = false;
try {
  await main.evaluate(async ({ root, files }) => {
    const p = app.plugins.plugins["zj-html-studio"];
    if (p.presenter.output) throw Error("Stop the existing test presentation first");
    await app.vault.createFolder(root);
    const missing = Array.from({ length: 15 }, (_, i) => `<img alt="插图 ${i + 1}" src="配套图片/未找到的配图-${i + 1}.png">`).join("");
    await app.vault.create(files[0], `<!doctype html><html><body><h1>普通网页</h1><p>只有一页，也可以记录讲义。</p>${missing}</body></html>`);
    await app.vault.create(files[1], '<!doctype html><html><body><h1>交互网页</h1><button onclick="this.textContent=\'已点击\'">练习</button></body></html>');
    await app.vault.create(files[3], `<!doctype html><html><body><h1>大文件网页</h1><!--${"x".repeat(5 * 1024 * 1024)}--></body></html>`);
    await app.vault.create(files[2], `<!doctype html><html><head><style>.slide{display:none}.slide.active{display:block}</style></head><body>${Array.from({ length: 47 }, (_, i) => `<section class="slide${i === 0 ? " active" : ""}" id="p${String(i + 1).padStart(2, "0")}"><h1>课件第 ${i + 1} 页</h1></section>`).join("")}<script>const show=()=>document.querySelectorAll('.slide').forEach(s=>s.classList.toggle('active','#'+s.id===(location.hash||'#p01')));addEventListener('hashchange',show);show();</script></body></html>`);
    p.settings.safeScopes.push(root);
    await p.saveData(p.settings);
  }, { root, files });

  await open(files[0]);
  await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.showNotes());
  await editor().waitFor();
  assert.equal(await input().inputValue(), "1");
  assert.match(await sidebar().locator(".html-studio-lecture-picker").innerText(), /\/ 1/);
  for (const name of ["课件上一页", "课件下一页"]) assert.equal(await sidebar().getByRole("button", { name, exact: true }).isDisabled(), true);
  assert.equal(await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.notePath), null);
  assert.equal(await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.context), null);
  await input().fill("2"); await input().press("Enter"); assert.equal(await input().inputValue(), "1");
  await sidebar().getByRole("button", { name: "选择课件页面", exact: true }).click();
  assert.equal(await sidebar().getByRole("option").count(), 1);
  await sidebar().getByRole("option").click();
  assert.equal(await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.source.lastPageReadingState.hash), "");
  checks.push("Safe ordinary HTML keeps 1 / 1 and disabled arrows; opening creates no note and page selection never injects an anchor");

  for (let cycle = 0; cycle < 2; cycle++) {
    await main.evaluate(() => app.workspace.rightSplit.collapse());
    await main.waitForTimeout(250);
    await main.evaluate(() => app.workspace.rightSplit.expand());
    await sidebar().getByRole("button", { name: "选择课件页面", exact: true }).click();
    await sidebar().getByRole("option").click();
  }
  checks.push("The page selector remains clickable above the status bar after repeated sidebar collapse and expansion");

  await editor().focus(); await main.keyboard.insertText("单页讲义：先介绍，再练习。"); await saved();
  const firstNote = await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.notePath);
  notes.push(firstNote); assert.ok(firstNote.startsWith("讲义库/"));
  assert.match(await main.evaluate(file => app.vault.read(app.vault.getAbstractFileByPath(file)), firstNote), /## 第 1 页[^]*单页讲义：先介绍，再练习。/);
  await main.evaluate(() => { for (const l of app.workspace.getLeavesOfType("html-studio-lecture")) l.detach(); });
  await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.showNotes());
  await editor().filter({ hasText: "单页讲义：先介绍，再练习。" }).waitFor();
  await shot("single-page");
  checks.push("First non-empty edit creates one managed Markdown note; reopening the sidebar restores page 1 content");

  await main.evaluate(async root => {
    const p = app.plugins.plugins["zj-html-studio"];
    p.settings.safeScopes = p.settings.safeScopes.filter(scope => scope !== root);
    p.settings.interactiveScopes.push(root); await p.saveData(p.settings);
  }, root);
  await open(files[1]); await editor().waitFor();
  assert.equal(await input().inputValue(), "1");
  assert.equal(await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.notePath), null);
  await editor().focus(); await main.keyboard.insertText("交互页独立讲义"); await saved();
  notes.push(await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.notePath));
  assert.notEqual(notes[0], notes[1]);
  checks.push("An interactive unnumbered HTML also supports a separate single-page note");

  await open(files[3]); await editor().waitFor();
  assert.equal(await input().inputValue(), "1");
  assert.equal(await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.source.searchBridgeReady), false);
  assert.equal(await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.context), null);
  assert.equal(await sidebar().getByRole("button", { name: "课件下一页", exact: true }).isDisabled(), true);
  checks.push("A 5 MiB HTML without a search bridge still exposes verified single-page notes, without enabling projection");
  await editor().focus(); await main.keyboard.insertText("大文件也能保留讲义"); await saved();
  notes.push(await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.notePath));
  const previousToken = await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.source.session.token);
  const refresh = main.getByRole("button", { name: "刷新", exact: true });
  if (await refresh.isVisible()) await refresh.click();
  else {
    await main.locator(".html-studio-more-button:visible").click();
    await main.getByText("刷新页面", { exact: true }).click();
  }
  await main.getByRole("button", { name: "先预览", exact: true }).click();
  await main.waitForFunction(previousToken => {
    const source = app.plugins.plugins["zj-html-studio"].presenter.source;
    return source.session?.token !== previousToken && source.singlePageLectureFile === source.file;
  }, previousToken);
  await editor().filter({ hasText: "大文件也能保留讲义" }).waitFor();
  assert.equal(await input().inputValue(), "1");
  checks.push("Refreshing a large HTML preserves its one-page lecture and saved content");

  await open(files[2]);
  for (const number of [15, 16, 15]) {
    await input().fill(String(number)); await input().press("Enter");
    await sidebar().locator(`.cm-content[aria-label="第 ${number} 页讲义"]`).waitFor();
    assert.equal(await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.context.deck.current), number);
  }
  assert.equal(await sidebar().getByRole("button", { name: "课件下一页", exact: true }).isDisabled(), false);
  checks.push("Recognized 47-page decks retain real page navigation and linked lecture updates at 15 → 16 → 15");

  await open(files[0]); await editor().filter({ hasText: "单页讲义" }).waitFor();
  await main.evaluate(() => {
    app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse();
    app.plugins.plugins["zj-html-studio"].presenter.source.toggleDiagnostics();
  });
  const drawer = main.locator(".html-studio-diagnostics.is-open:visible");
  await drawer.waitFor();
  assert.equal(await drawer.locator(".html-studio-diagnostic-card").count(), 15);
  const cases = [["", "moonstone", 1100, 1, "default-light"], ["", "obsidian", 1100, 1, "default-dark"],
    ["Primary", "obsidian", 1100, 1, "primary-dark"], ["Primary", "moonstone", 1100, 1, "primary-light"],
    ["Primary", "moonstone", 320, 1, "narrow"], ["Primary", "moonstone", 900, 1.25, "zoom-125"]];
  for (const [css, theme, width, zoom, label] of cases) {
    await main.evaluate(({ css, theme, width, zoom }) => {
      app.customCss.setTheme(css); app.changeTheme(theme); window.require("electron").webFrame.setZoomFactor(zoom);
      app.plugins.plugins["zj-html-studio"].presenter.source.contentEl.style.width = `${width}px`;
    }, { css, theme, width, zoom });
    await main.waitForTimeout(450);
    const layout = await drawer.evaluate(el => {
      const body = el.querySelector(".html-studio-diagnostics-body");
      const header = el.querySelector(".html-studio-diagnostics-header");
      return { height: el.clientHeight, scroll: el.scrollHeight, width: el.clientWidth, scrollWidth: el.scrollWidth,
        body: { height: body.clientHeight, scroll: body.scrollHeight, width: body.clientWidth, scrollWidth: body.scrollWidth },
        headerTop: header.getBoundingClientRect().top,
        cards: [...el.querySelectorAll(".html-studio-diagnostic-card")].map(c => ({height: c.clientHeight, scroll: c.scrollHeight})),
        headingColor: getComputedStyle(header.querySelector("strong")).color,
        normalColor: getComputedStyle(el).getPropertyValue("--text-normal").trim()
      };
    });
    assert.ok(layout.height >= 100);
    assert.ok(layout.body.height > 0 && layout.body.scroll > layout.body.height);
    assert.ok(layout.cards.every(card => card.height > 100 && card.scroll <= card.height + 1), `${label}: clipped cards`);
    assert.ok(layout.scrollWidth <= layout.width + 1 && layout.body.scrollWidth <= layout.body.width + 1, `${label}: horizontal overflow`);
    await drawer.locator(".html-studio-diagnostic-card").last().scrollIntoViewIfNeeded();
    const bottom = await drawer.evaluate(el => ({ scroll: el.querySelector(".html-studio-diagnostics-body").scrollTop, header: el.querySelector(".html-studio-diagnostics-header").getBoundingClientRect().top }));
    assert.ok(bottom.scroll > 0); assert.equal(bottom.header, layout.headerTop);
    await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.source.renderDiagnostics());
    assert.equal(await drawer.locator(".html-studio-diagnostics-body").evaluate(el => el.scrollTop), bottom.scroll);
    await drawer.locator(".html-studio-diagnostics-body").evaluate(el => { el.scrollTop = 0; });
    await shot(label);
    layouts.push({ label, ...layout });
  }
  checks.push("All 15 diagnostic cards remain readable, internally scroll to the last item and retain scroll position; default/Primary light/dark, narrow layout and 125% zoom pass");
  await drawer.getByRole("button", { name: "关闭页面信息", exact: true }).click();
  assert.equal(await main.locator(".html-studio-diagnostics.is-open").count(), 0);
  await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.showNotes());
  await editor().waitFor();
  await sidebar().getByRole("button", { name: "选择课件页面", exact: true }).click();
  await sidebar().getByRole("option").click();
  checks.push("After theme/zoom changes and reopening the sidebar, the page selector remains above the status bar and clickable");
  assert.deepEqual(errors, []);
  checks.push("Accessible close button closes the panel; no uncaught page errors");
  passed = true;
} finally {
  await main.evaluate(async ({ original, root, notes, passed }) => {
    const p = app.plugins.plugins["zj-html-studio"];
    p.presenter.source?.contentEl.style.removeProperty("width");
    window.require("electron").webFrame.setZoomFactor(original.zoom);
    app.customCss.setTheme(original.css); app.changeTheme(original.theme);
    await p.presenter.notes.flush();
    if (passed) {
      for (const leaf of app.workspace.getLeavesOfType("html-studio-lecture")) leaf.detach();
      app.workspace.iterateAllLeaves(leaf => { if (leaf.view.file?.path?.startsWith(root + "/")) leaf.detach(); });
      const folder = app.vault.getAbstractFileByPath(root); if (folder) await app.vault.trash(folder, false);
      for (const path of notes) { const file = app.vault.getAbstractFileByPath(path); if (file) await app.vault.trash(file, false); }
    }
    p.settings = original.settings; await p.saveData(p.settings);
  }, { original, root, notes, passed });
  if (artifacts) await fs.writeFile(path.join(artifacts, "results.json"), JSON.stringify({ checks, layouts, errors, passed }, null, 2));
  process.stdout.write(JSON.stringify({ checks, errors, passed }) + "\n");
  await browser.close();
}
