// Real keyboard/mouse acceptance, restricted to an explicitly marked disposable vault.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const vaultPath = process.env.HTML_STUDIO_TEST_VAULT;
assert.ok(vaultPath && path.isAbsolute(vaultPath));
assert.equal((await fs.readFile(path.join(vaultPath, ".html-studio-runtime-test"), "utf8")).trim(), "disposable-test-vault");
const browser = await chromium.connectOverCDP(process.env.HTML_STUDIO_TEST_CDP ?? "http://127.0.0.1:9234");
const main = browser.contexts()[0].pages().find(page => page.url().includes("/index.html"));
assert.ok(main);
assert.equal(await main.evaluate(() => app.vault.adapter.getBasePath()), vaultPath);
main.setDefaultTimeout(8000);
const root = `lecture-editor-regression-${Date.now()}`;
const settings = await main.evaluate(() => JSON.parse(JSON.stringify(app.plugins.plugins["zj-html-studio"].settings)));
const artifacts = process.env.HTML_STUDIO_TEST_ARTIFACTS;
if (artifacts) await fs.mkdir(artifacts, { recursive: true });
const checks = [], errors = [];
main.on("pageerror", error => errors.push(error.stack ?? error.message));
const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#17191d;color:#eee;font:28px system-ui}.slide{display:none;padding:60px}.slide.active{display:block}</style></head><body>${Array.from({ length: 47 }, (_, i) => `<section id="p${String(i + 1).padStart(2, "0")}" class="slide${i === 0 ? " active" : ""}"><h1>第 ${i + 1} 页${[15, 16, 20].includes(i + 1) ? " · 知识库" : ""}</h1><p>${[15, 16, 20].includes(i + 1) ? "知识库帮助积累经验。知识库保留背景。" : "准备与练习"}</p>${i === 14 ? "<p>唯一提问</p>" : ""}</section>`).join("")}<script>const show=()=>document.querySelectorAll('.slide').forEach(s=>s.classList.toggle('active','#'+s.id===(location.hash||'#p01')));addEventListener('hashchange',show);show();</script></body></html>`;
const sidebar = () => main.locator(".html-studio-lecture:visible");
const content = () => sidebar().locator(".cm-content");
const pageInput = () => sidebar().getByRole("textbox", { name: "跳转到课件页码" });
const pageIs = async page => {
  await main.waitForFunction(page => app.plugins.plugins["zj-html-studio"].presenter.context?.deck.current === page, page);
  await sidebar().locator('.cm-content[aria-label="第 ' + page + ' 页讲义"]').waitFor();
};
const jump = async page => { await pageInput().fill(String(page)); await pageInput().press("Enter"); await pageIs(page); };
const type = async text => {
  await content().focus();
  await main.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
  await main.keyboard.insertText(text);
};
const saved = () => sidebar().locator(".html-studio-lecture-save").filter({ hasText: /^已保存$/ }).waitFor();
const documentText = () => main.evaluate(async () => { const p = app.plugins.plugins["zj-html-studio"].presenter; return app.vault.read(app.vault.getAbstractFileByPath(p.notePath)); });
let passed = false, notePath;
try {
  await main.evaluate(async ({ root, html }) => {
    const p = app.plugins.plugins["zj-html-studio"];
    if (p.presenter.output) throw Error("Stop an existing test presentation first");
    await app.vault.createFolder(root);
    await app.vault.create(`${root}/${root}.html`, html);
    p.settings.interactiveScopes.push(root); await p.saveData(p.settings);
    await app.workspace.getLeaf("tab").openFile(app.vault.getAbstractFileByPath(`${root}/${root}.html`));
  }, { root, html });
  await main.waitForFunction(root => app.plugins.plugins["zj-html-studio"].presenter.context?.filePath === `${root}/${root}.html`, root);
  await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.showNotes());
  await content().waitFor();
  assert.equal(await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.notePath), null);
  assert.equal(await sidebar().getByRole("button", { name: /编辑讲义|阅读讲义/ }).count(), 0);
  checks.push("Opening the sidebar creates no note and exposes one directly editable surface");

  await jump(15);
  await type("### 提示\n\n先问大家：知识库能帮什么忙？\n\n- 保留具体背景\n- **现场演示**");
  await saved();
  notePath = await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.notePath);
  assert.ok(notePath.startsWith("讲义库/"));
  assert.match(await documentText(), /## 第 15 页/);
  await jump(16);
  await type("第十六页的独立提示");
  await jump(15); await saved();
  assert.match(await content().innerText(), /先问大家/);
  assert.match(await documentText(), /第十六页的独立提示/);
  checks.push("First edit creates one centrally managed Markdown note; fast 15 → 16 → 15 saves each page correctly");

  const editState = () => main.evaluate(() => app.workspace.getLeavesOfType("html-studio-lecture")[0].view.editor.view.state.doc.toString());
  const selectText = (from, to = from) => main.evaluate(({ from, to }) => {
    const view = app.workspace.getLeavesOfType("html-studio-lecture")[0].view.editor.view;
    view.dispatch({ selection: { anchor: from, head: to } }); view.focus();
  }, { from, to });
  const style = async label => {
    await sidebar().getByRole("button", { name: "段落样式", exact: true }).click();
    await main.locator(".menu-item-title").filter({ hasText: new RegExp("^" + label + "$") }).click();
  };
  await type("讲述顺序\n第二个要点"); await selectText(0);
  await style("小标题");
  assert.equal(await editState(), "### 讲述顺序\n第二个要点");
  await style("小标题");
  assert.equal(await editState(), "### 讲述顺序\n第二个要点");
  await style("正文");
  await selectText(0, (await editState()).length);
  await style("项目列表"); assert.equal(await editState(), "- 讲述顺序\n- 第二个要点");
  await style("编号列表"); assert.equal(await editState(), "1. 讲述顺序\n2. 第二个要点");
  await style("正文"); assert.equal(await editState(), "讲述顺序\n第二个要点");
  await selectText(0, 4);
  await sidebar().getByRole("button", { name: "加粗", exact: true }).click();
  assert.equal(await editState(), "**讲述顺序**\n第二个要点");
  assert.equal(await sidebar().getByRole("button", { name: "加粗", exact: true }).getAttribute("aria-pressed"), "true");
  await sidebar().getByRole("button", { name: "加粗", exact: true }).click();
  assert.equal(await editState(), "讲述顺序\n第二个要点");
  await main.keyboard.press("Meta+z"); assert.equal(await editState(), "**讲述顺序**\n第二个要点");
  await main.keyboard.press("Meta+Shift+z"); assert.equal(await editState(), "讲述顺序\n第二个要点");
  await main.keyboard.press("Meta+b"); assert.equal(await editState(), "**讲述顺序**\n第二个要点");
  await type("1. 准备"); await main.keyboard.press("End"); await main.keyboard.press("Enter");
  assert.equal(await editState(), "1. 准备\n2. ");
  await main.keyboard.press("Enter"); assert.equal(await editState(), "1. 准备\n");
  await type("### 提示\n\n先问大家：知识库能帮什么忙？\n\n- 保留具体背景\n- **现场演示**"); await saved();
  checks.push("Chinese paragraph selector replaces styles without stacking; multi-line lists, bold state, keyboard shortcut, undo/redo and list continuation work in the real editor");

  const ime = await main.context().newCDPSession(main);
  await content().focus();
  await main.evaluate(() => {
    const editor = app.workspace.getLeavesOfType("html-studio-lecture")[0].view.editor.view;
    editor.dispatch({ selection: { anchor: editor.state.doc.length } }); editor.focus();
  });
  await ime.send("Input.imeSetComposition", { text: "中文组合输入", selectionStart: 6, selectionEnd: 6 });
  await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.jump(16));
  await main.waitForFunction(() => app.plugins.plugins["zj-html-studio"].presenter.context?.deck.current === 16);
  assert.equal(await content().getAttribute("aria-label"), "第 15 页讲义");
  await ime.send("Input.insertText", { text: "中文组合输入" });
  await pageIs(16);
  await jump(15); await saved();
  assert.match(await content().innerText(), /中文组合输入/);
  assert.doesNotMatch((await documentText()).split("## 第 16 页")[1], /中文组合输入/);
  await ime.detach();
  checks.push("Native Chromium Chinese composition stays attached to page 15 while the deck moves to 16, then commits to the correct page");

  await sidebar().getByRole("button", { name: "选择课件页面" }).click();
  const menu = sidebar().getByRole("listbox");
  assert.equal(await menu.getByRole("option").count(), 47);
  const geometry = await menu.evaluate(el => ({ height: el.getBoundingClientRect().height, scroll: el.scrollHeight, row: el.querySelector("button").getBoundingClientRect().height, bottom: el.getBoundingClientRect().bottom }));
  assert.ok(geometry.height <= 201 && geometry.height >= geometry.row * 5);
  assert.ok(geometry.scroll > geometry.height * 5);
  await main.keyboard.press("End"); await main.keyboard.press("Enter"); await pageIs(47);
  await pageInput().fill("999"); await pageInput().press("Enter"); assert.equal(await pageInput().inputValue(), "47");
  await jump(15);
  const layout = await sidebar().evaluate(el => ({ editor: el.querySelector(".html-studio-lecture-body").getBoundingClientRect().bottom, nav: el.querySelector(".html-studio-lecture-nav").getBoundingClientRect().top }));
  assert.ok(Math.abs(layout.editor - layout.nav) < 2);
  checks.push("Footer accepts page input, clamps invalid values and has exactly five visible dropdown rows with keyboard scrolling to page 47");

  await main.getByRole("button", { name: "查找当前 HTML 内容", exact: true }).filter({ visible: true }).click();
  const query = main.locator('.html-studio-search-bar.is-open input[type="search"]');
  const count = main.locator(".html-studio-search-bar.is-open .html-studio-search-count");
  await query.fill("知识库"); await count.filter({ hasText: "1 / 3 页" }).waitFor();
  await main.getByRole("button", { name: "下一个命中页", exact: true }).click(); await pageIs(16);
  await main.getByRole("button", { name: "下一个命中页", exact: true }).click(); await pageIs(20);
  await main.getByRole("button", { name: "上一个命中页", exact: true }).click(); await pageIs(16);
  await count.click();
  await main.locator(".html-studio-search-results").getByRole("option").first().click(); await pageIs(15);
  await query.fill("唯一提问"); await count.filter({ hasText: "1 / 1 页" }).waitFor();
  assert.equal(await main.getByRole("button", { name: "下一个命中页", exact: true }).isDisabled(), true);
  assert.doesNotMatch(await count.innerText(), /受限/);
  if (artifacts) await main.screenshot({ path: path.join(artifacts, "inline-lecture-search.png") });
  await query.press("Escape");
  checks.push("Search arrows navigate matching pages 15 → 16 → 20; result menu jumps to 15; one-page result disables arrows without opaque warnings");

  await main.evaluate(() => {
    window.__lectureProcess = app.vault.process;
    app.vault.process = async () => { throw Error("TEST_DISK_WRITE_FAILURE"); };
  });
  await type("保存失败也不能丢失这段草稿");
  await sidebar().locator(".html-studio-lecture-save-error").filter({ hasText: "TEST_DISK_WRITE_FAILURE" }).waitFor();
  const configDir = await main.evaluate(() => app.vault.configDir);
  const journal = await fs.readFile(path.join(vaultPath, configDir, "plugins/zj-html-studio/lecture-drafts.json"), "utf8");
  assert.match(journal, /保存失败也不能丢失这段草稿/);
  await main.evaluate(async root => {
    const old = app.plugins.plugins["zj-html-studio"].presenter.notes;
    await app.plugins.disablePlugin("zj-html-studio");
    await old.flush();
    await app.plugins.enablePlugin("zj-html-studio");
    await app.workspace.getLeaf("tab").openFile(app.vault.getAbstractFileByPath(`${root}/${root}.html`));
  }, root);
  await main.waitForFunction(root => app.plugins.plugins["zj-html-studio"].presenter.context?.filePath === `${root}/${root}.html`, root);
  await main.evaluate(() => { app.plugins.plugins["zj-html-studio"].presenter.jump(15); return app.plugins.plugins["zj-html-studio"].presenter.showNotes(); });
  await pageIs(15);
  assert.match(await content().innerText(), /保存失败也不能丢失这段草稿/);
  await main.evaluate(() => { app.vault.process = window.__lectureProcess; delete window.__lectureProcess; });
  await sidebar().getByRole("button", { name: "重试保存" }).click(); await saved();
  assert.match(await documentText(), /保存失败也不能丢失这段草稿/);
  checks.push("A failed disk write keeps the draft across plugin reload; retry saves successfully");

  await type("我的并发编辑");
  await main.evaluate(async () => {
    const p = app.plugins.plugins["zj-html-studio"].presenter;
    const file = app.vault.getAbstractFileByPath(p.notePath);
    await app.vault.process(file, text => text.replace("保存失败也不能丢失这段草稿", "另一个窗口的修改"));
  });
  await sidebar().locator(".html-studio-lecture-save-error").filter({ hasText: "别处修改过" }).waitFor();
  assert.match(await documentText(), /另一个窗口的修改/);
  assert.match(await content().innerText(), /我的并发编辑/);
  await main.evaluate(async () => {
    const p = app.plugins.plugins["zj-html-studio"].presenter;
    await app.vault.process(app.vault.getAbstractFileByPath(p.notePath), text => text.replace("另一个窗口的修改", "保存失败也不能丢失这段草稿"));
  });
  await sidebar().getByRole("button", { name: "重试保存" }).click(); await saved();
  checks.push("Concurrent changes to the same page are preserved and reported, with the unsaved sidebar draft retained");

  await main.evaluate(async () => {
    const leaves = app.workspace.getLeavesOfType("html-studio-lecture");
    for (const leaf of leaves) leaf.detach();
    await app.plugins.plugins["zj-html-studio"].presenter.showNotes();
  });
  await content().waitFor(); assert.match(await content().innerText(), /我的并发编辑/);
  assert.deepEqual(errors, []);
  checks.push("Closing and reopening the sidebar retains saved content without renderer errors");
  await main.evaluate(async () => {
    const p = app.plugins.plugins["zj-html-studio"].presenter;
    await app.vault.process(p.source.file, text => text.replace("</body>", '<section id="p48" class="slide"><h1>新增页面</h1></section></body>').replace("第 15 页 · 知识库", "更新后的第十五页"));
  });
  await main.waitForFunction(() => app.plugins.plugins["zj-html-studio"].presenter.context?.deck.pages.length === 48);
  await sidebar().getByRole("heading", { name: "更新后的第十五页" }).waitFor();
  await sidebar().getByRole("button", { name: "选择课件页面" }).click();
  assert.equal(await sidebar().getByRole("listbox").getByRole("option").count(), 48);
  await main.keyboard.press("Escape");
  assert.match(await content().innerText(), /我的并发编辑/);
  assert.deepEqual(errors, []);
  checks.push("Automatic HTML refresh updates the title and page menu after adding a slide, while retaining the current lecture content");
  const sizeGuard = await main.evaluate(async root => {
    const p = app.plugins.plugins["zj-html-studio"];
    const source = await app.vault.create(`${root}/oversized.html`, "<p>size test</p>");
    const draft = await p.presenter.notes.open({ ...p.presenter.context, deck: { current: 1, pages: [{ hash: "#p01", title: "size" }] } }, source, null);
    draft.text = "中".repeat(700_000); draft.dirty = true;
    await p.presenter.notes.save(draft);
    const result = { error: draft.error, noteCreated: Boolean(draft.note), linked: Boolean(p.settings.lectureNotes[source.path]) };
    draft.text = ""; await p.presenter.notes.save(draft);
    return result;
  }, root);
  assert.match(sizeGuard.error, /内容过长/);
  assert.equal(sizeGuard.noteCreated, false);
  assert.equal(sizeGuard.linked, false);
  checks.push("UTF-8 byte limit rejects an oversized Chinese draft before creating or linking a note");
  passed = true;
} finally {
  await main.evaluate(async ({ root, settings, notePath, passed }) => {
    if (window.__lectureProcess) { app.vault.process = window.__lectureProcess; delete window.__lectureProcess; }
    const p = app.plugins.plugins["zj-html-studio"];
    await p.presenter.notes.flush();
    if (passed) {
      for (const leaf of app.workspace.getLeavesOfType("html-studio-lecture")) leaf.detach();
      app.workspace.iterateAllLeaves(leaf => { if (leaf.view.file?.path?.startsWith(root + "/")) leaf.detach(); });
      const folder = app.vault.getAbstractFileByPath(root); if (folder) await app.vault.trash(folder, false);
      const note = notePath && app.vault.getAbstractFileByPath(notePath); if (note) await app.vault.trash(note, false);
    }
    p.settings = settings; await p.saveData(settings);
  }, { root, settings, notePath, passed });
  if (artifacts) await fs.writeFile(path.join(artifacts, "lecture-results.json"), JSON.stringify({ checks, errors, passed }, null, 2));
  process.stdout.write(JSON.stringify({ checks, errors, passed }) + "\n");
  await browser.close();
}
