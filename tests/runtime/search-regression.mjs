// This acceptance runner is deliberately restricted to a disposable vault.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const vaultPath = process.env.HTML_STUDIO_TEST_VAULT;
assert.ok(vaultPath && path.isAbsolute(vaultPath), "Set HTML_STUDIO_TEST_VAULT to a disposable vault");
assert.equal((await fs.readFile(path.join(vaultPath, ".html-studio-runtime-test"), "utf8")).trim(), "disposable-test-vault");
const browser = await chromium.connectOverCDP(process.env.HTML_STUDIO_TEST_CDP ?? "http://127.0.0.1:9234");
const main = browser.contexts()[0].pages().find(page => page.url().includes("/index.html"));
assert.ok(main);
assert.equal(await main.evaluate(() => app.vault.adapter.getBasePath()), vaultPath);
const root = `html-studio-search-regression-${Date.now()}`;
const savedSettings = await main.evaluate(() => JSON.parse(JSON.stringify(app.plugins.plugins["zj-html-studio"].settings)));
const artifacts = process.env.HTML_STUDIO_TEST_ARTIFACTS;
if (artifacts) await fs.mkdir(artifacts, { recursive: true });
const pageErrors = [], checks = [];
main.on("pageerror", error => pageErrors.push(error.message));
const html = `<!doctype html><html><head><style>
body{margin:0;background:#14151a;color:#eee;font:28px system-ui;user-select:none}.slide{display:none;padding:60px}.slide.active{display:block}p{line-height:2}
</style></head><body><section id="p01" class="slide active"><h1>课程起点</h1><p>这一页还没有关键词</p></section><section id="p02" class="slide"><h1>使用知识库</h1><p>知识库保留具体业务背景</p></section><section id="p03" class="slide"><h1>练习</h1><p>把知识库经验写下来</p></section><script>
const render=()=>document.querySelectorAll('.slide').forEach(s=>s.classList.toggle('active','#'+s.id===(location.hash||'#p01')));addEventListener('hashchange',()=>setTimeout(render,150));render();
</script></body></html>`;
const source = () => main.locator('.html-studio-preview-canvas:not(.html-studio-preview-candidate) .html-studio-iframe:visible');
const searchInput = () => main.locator('.html-studio-search-bar.is-open input[type="search"]');
const count = () => main.locator(".html-studio-search-bar.is-open .html-studio-search-count");
const pageNumber = () => main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.context?.deck.current);
const painted = () => source().contentFrame().locator("body").evaluate(() => {
  const matches = [];
  CSS.highlights.forEach(highlight => highlight.forEach(range => matches.push(range.toString())));
  return matches;
});
const waitCount = async text => {
  await count().filter({ hasText: text }).waitFor({ timeout: 6000 });
};
let output;
try {
  await main.evaluate(async ({ root, html }) => {
    const p = app.plugins.plugins["zj-html-studio"];
    if (p.presenter.output) throw Error("Stop an existing test presentation first");
    await app.vault.createFolder(root);
    await app.vault.create(`${root}/lesson.html`, html);
    await app.vault.create(`${root}/lesson.md`, "## 第 1 页\nNOTE_1\n\n## 第 2 页\nNOTE_2\n\n## 第 3 页\nNOTE_3\n");
    await p.setLectureAssociation(`${root}/lesson.html`, `${root}/lesson.md`);
    p.settings.interactiveScopes.push(root);
    await p.saveData(p.settings);
    await app.workspace.getLeaf("tab").openFile(app.vault.getAbstractFileByPath(`${root}/lesson.html`));
  }, { root, html });
  await main.waitForFunction(root => app.plugins.plugins["zj-html-studio"].presenter.context?.filePath === `${root}/lesson.html`, root);
  const opened = browser.contexts()[0].waitForEvent("page");
  await main.evaluate(() => { const p = app.plugins.plugins["zj-html-studio"].presenter; return p.startProjection(p.source); });
  output = await opened;
  await main.waitForFunction(() => app.plugins.plugins["zj-html-studio"].presenter.output?.ready);
  await source().contentFrame().getByRole("heading", { name: "课程起点" }).click();
  await main.keyboard.press(process.platform === "darwin" ? "Meta+f" : "Control+f");
  await searchInput().waitFor();
  checks.push("Cmd/Ctrl+F opens plugin search from inside the HTML");

  await searchInput().evaluate(input => {
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    input.value = "知识库";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true, data: "知识库" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", isComposing: true }));
  });
  await main.waitForTimeout(250);
  assert.equal(await pageNumber(), 1);
  await searchInput().evaluate(input => input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "知识库" })));
  await waitCount("1 / 2");
  await main.waitForFunction(() => app.plugins.plugins["zj-html-studio"].presenter.output?.acknowledgedPage === 2);
  assert.equal(await pageNumber(), 2);
  assert.match(await main.locator(".html-studio-lecture .cm-content").innerText(), /NOTE_2/);
  assert.equal(await output.frameLocator(".html-studio-projection-frame").locator(".slide.active").getAttribute("id"), "p02");
  assert.ok((await painted()).includes("知识库"));
  checks.push("Chinese composition completes before searching; cross-slide results update source, notes and output");

  await searchInput().press("Enter"); await waitCount("2 / 2");
  await searchInput().press("Shift+Enter"); await waitCount("1 / 2");
  assert.equal(await searchInput().evaluate(input => document.activeElement === input), true);
  checks.push("Enter and Shift+Enter move through results with input focus retained");
  if (artifacts) await main.screenshot({ path: path.join(artifacts, "search-highlight.png") });
  await searchInput().fill(""); await waitCount("0 / 0"); assert.deepEqual(await painted(), []);
  await searchInput().fill("未出现的词"); await waitCount("没有找到");
  checks.push("clear and no-result state remove stale highlights");

  await searchInput().fill("知识库"); await waitCount("1 / 2");
  const oldSession = await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.context.sessionId);
  const refresh = main.getByRole("button", { name: "刷新", exact: true }).filter({ visible: true });
  if (await refresh.isVisible()) await refresh.click();
  else {
    await main.locator(".html-studio-more-button:visible").click();
    await main.getByText("刷新页面", { exact: true }).click();
  }
  await main.waitForFunction(old => {
    const context = app.plugins.plugins["zj-html-studio"].presenter.context;
    return context && context.sessionId !== old && context.deck.current === 2;
  }, oldSession);
  await waitCount("1 / 2");
  assert.equal(await pageNumber(), 2);
  checks.push("refresh retains search query and slide location");
  await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.stopProjection());
  await main.getByRole("button", { name: "源码", exact: true }).filter({ visible: true }).click();
  await searchInput().fill("课程起点"); await waitCount("1 / 1");
  await searchInput().press("Escape");
  assert.equal(await main.locator(".html-studio-search-bar.is-open").count(), 0);
  await main.getByRole("button", { name: "预览", exact: true }).filter({ visible: true }).click();
  await main.waitForFunction(() => app.plugins.plugins["zj-html-studio"].presenter.context?.deck.current === 2);
  checks.push("source search, Escape and return to preview retain the course page");
  assert.deepEqual(pageErrors, []);
} finally {
  await main.evaluate(async ({ root, savedSettings }) => {
    const p = app.plugins.plugins["zj-html-studio"];
    p.presenter.stopProjection();
    app.workspace.iterateAllLeaves(leaf => { if (leaf.view.file?.path?.startsWith(root + "/")) leaf.detach(); });
    const folder = app.vault.getAbstractFileByPath(root);
    if (folder) await app.vault.trash(folder, false);
    p.settings = savedSettings; await p.saveData(savedSettings);
  }, { root, savedSettings });
  if (artifacts) await fs.writeFile(path.join(artifacts, "results.json"), JSON.stringify({ checks, pageErrors }, null, 2));
  process.stdout.write(JSON.stringify({ checks, pageErrors }) + "\n");
  await browser.close();
}
