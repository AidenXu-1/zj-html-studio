// Synthetic fixtures only, in an explicitly disposable Obsidian instance.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const vault = process.env.HTML_STUDIO_TEST_VAULT;
const artifacts = process.env.HTML_STUDIO_TEST_ARTIFACTS;
assert.ok(vault && path.isAbsolute(vault) && artifacts);
assert.equal((await fs.readFile(path.join(vault, ".html-studio-runtime-test"), "utf8")).trim(), "disposable-test-vault");
const browser = await chromium.connectOverCDP(process.env.HTML_STUDIO_TEST_CDP ?? "http://127.0.0.1:9234");
const context = browser.contexts()[0];
const main = context.pages().find(page => page.url().includes("/index.html"));
assert.equal(await main.evaluate(() => app.vault.adapter.getBasePath()), vault);
main.setDefaultTimeout(8_000);
await fs.mkdir(artifacts, { recursive: true });
const checks = [], errors = [];
const observe = page => page.on("pageerror", error => errors.push(error.stack || error.message || String(error)));
context.pages().forEach(observe); context.on("page", observe);
const root = `universal-deck-${Date.now()}`;
const settings = await main.evaluate(() => JSON.parse(JSON.stringify(app.plugins.plugins["zj-html-studio"].settings)));
const note = n => Array.from({ length: n }, (_, i) => `## 第 ${i + 1} 页\n\nPRIVATE_NOTE_${i + 1}\n`).join("\n");
const html = controls => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;font:26px system-ui;color:#202c48}
.deck{height:100vh}.screen{display:none;height:100%;padding:5vw;box-sizing:border-box}.screen.active{display:block}
nav{position:fixed;bottom:20px;left:30px}button{padding:10px 20px}
</style></head><body><main class="deck">${[1,2,3].map((n,i) => `<section class="screen${i===0?' active':''}" id="${['cover','idea','closing'][i]}" style="background:${['#edf4ff','#e8f5ee','#fff0e4'][i]}"><h1>Lesson ${n}</h1><p>One source, one live course image.</p></section>`).join("")}</main>
<nav>${controls?'<button id="prev">上一页</button><button id="next">下一页</button>':'<button id="continue-course">继续课件</button>'}</nav><script>
let current=0;window.render=i=>{current=Math.max(0,Math.min(2,i));document.querySelectorAll('.screen').forEach((el,i)=>el.classList.toggle('active',i===current))};
${controls?"prev.onclick=()=>render(current-1);next.onclick=()=>render(current+1)":"document.getElementById('continue-course').onclick=()=>render(current+1)"}
</script></body></html>`;
const stop = () => main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.stopProjection());
const pageIs = async n => {
  await main.waitForFunction(n => app.plugins.plugins["zj-html-studio"].presenter.context?.deck.current === n, n);
  await main.locator(`.html-studio-lecture .cm-content[aria-label="第 ${n} 页讲义"]`).waitFor();
};
const open = async name => {
  await stop();
  await main.evaluate(async ({ root, name }) => {
    const tabs = app.workspace.rootSplit.children[0];
    const leaf = app.workspace.createLeafInParent(tabs, tabs.children.length);
    await leaf.openFile(app.vault.getAbstractFileByPath(`${root}/${name}.html`), { active: true });
    app.workspace.setActiveLeaf(leaf, { focus: true });
  }, { root, name });
  await main.waitForFunction(({ root, name }) => app.plugins.plugins["zj-html-studio"].presenter.context?.filePath === `${root}/${name}.html`, { root, name });
  await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.showNotes());
};
const start = async () => {
  const opened = context.waitForEvent("page");
  await main.locator(".html-studio-projection-button:visible").click();
  const output = await opened;
  await main.waitForFunction(() => app.plugins.plugins["zj-html-studio"].presenter.output?.ready, null, { timeout: 18_000 });
  return output;
};

try {
  await main.evaluate(async ({ root, controlled, observed, notes3, notes2 }) => {
    const plugin = app.plugins.plugins["zj-html-studio"];
    if (plugin.presenter.output) throw Error("An existing presentation is still active");
    await app.vault.createFolder(root);
    await app.vault.create(`${root}/controlled.html`, controlled);
    await app.vault.create(`${root}/observed.html`, observed);
    await app.vault.create(`${root}/plain.html`, '<!doctype html><body style="margin:0;background:#eee"><h1>Single page</h1></body>');
    await app.vault.create(`${root}/${root}-three.md`, notes3);
    await app.vault.create(`${root}/${root}-two.md`, notes2);
    for (const name of ["controlled", "observed"]) await plugin.setLectureAssociation(`${root}/${name}.html`, `${root}/${root}-three.md`);
  }, { root, controlled: html(true), observed: html(false), notes3: note(3), notes2: note(2) });

  await open("controlled");
  await pageIs(1);
  assert.equal(await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.context.deck.adapter), "dom");
  const output = await start();
  assert.equal(await output.locator(".html-studio-projection-picture").count(), 1);
  for (const n of [2, 3]) {
    await output.keyboard.press("ArrowRight"); await pageIs(n);
    await main.waitForFunction(n => app.plugins.plugins["zj-html-studio"].presenter.output.acknowledgedPage === n, n);
  }
  await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.jump(1)); await pageIs(1);
  await output.keyboard.press("ArrowRight"); await pageIs(2);
  checks.push("Arbitrary page IDs: output keyboard 1 → 2 → 3, local jump to 1 then output next to 2; notes follow actual page");
  await main.screenshot({ path: path.join(artifacts, "generic-source.png") });
  await output.screenshot({ path: path.join(artifacts, "generic-output.png") });
  await stop();
  await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.jump(3)); await pageIs(3);
  const session = await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.context.sessionId);
  await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.source.refreshPreview());
  await main.waitForFunction(old => app.plugins.plugins["zj-html-studio"].presenter.context?.sessionId !== old, session);
  await pageIs(3);
  assert.equal(await main.frameLocator('.html-studio-preview-canvas:not(.html-studio-preview-candidate) .html-studio-iframe:visible').locator('.screen.active').getAttribute('id'), 'closing');
  checks.push("Refresh replaces the preview only after restoring page 3; author HTML IDs and URL remain unchanged");

  for (let round = 0; round < 3; round++) {
    const pictureOutput = await start();
    const outputClosed = pictureOutput.waitForEvent("close", { timeout: 10000 });
    const moved = context.waitForEvent("page", { timeout: 10000 });
    await main.evaluate(() => { app.workspace.moveLeafToPopout(app.plugins.plugins["zj-html-studio"].presenter.source.leaf); });
    const sourceWindow = await moved;
    sourceWindow.setDefaultTimeout(8000);
    await main.waitForFunction(() => !app.plugins.plugins["zj-html-studio"].presenter.output);
    await outputClosed;
    await sourceWindow.frameLocator('.html-studio-iframe').locator('.screen.active').filter({ hasText: 'Lesson 3' }).waitFor();
    const placeholderId = await main.evaluate(() => {
      const source = app.plugins.plugins["zj-html-studio"].presenter.source;
      const placeholder = app.workspace.createLeafInParent(source.leaf.parent, source.leaf.parent.children.length);
      source.leaf.parent.removeChild(source.leaf);
      app.workspace.rootSplit.children[0].insertChild(0, source.leaf);
      app.workspace.setActiveLeaf(source.leaf, { focus: true });
      return placeholder.id;
    });
    await main.frameLocator('.html-studio-preview-canvas:not(.html-studio-preview-candidate) .html-studio-iframe:visible')
      .locator('.screen.active').filter({ hasText: 'Lesson 3' }).waitFor();
    await pageIs(3);
    const closed = sourceWindow.waitForEvent("close", { timeout: 10000 });
    await main.evaluate(id => app.workspace.iterateAllLeaves(leaf => { if (leaf.id === id) leaf.detach(); }), placeholderId);
    await closed;
  }
  checks.push("Three live picture-projection migrations stop output, retain page 3, move back and close the old window without exceptions");
  await main.evaluate(root => app.workspace.getLeavesOfType("html-studio-preview").filter(leaf => leaf.view.file?.path === `${root}/controlled.html`).forEach(leaf => leaf.detach()), root);

  await open("observed"); await pageIs(1);
  assert.equal(await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.context.deck.canNavigate), false);
  await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.jump(3));
  await main.waitForFunction(() => app.plugins.plugins["zj-html-studio"].presenter.lectureContext.deck.current === 3);
  assert.equal(await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.context.deck.current), 1);
  await main.frameLocator('.html-studio-preview-canvas:not(.html-studio-preview-candidate) .html-studio-iframe:visible').getByRole('button', { name: '继续课件' }).click();
  await pageIs(2);
  checks.push("Observable course: selecting notes does not pretend to flip the HTML; original course button resumes automatic notes following");

  await open("plain"); await pageIs(1);
  assert.equal(await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.lectureContext.deck.pages.length), 1);
  const associate = async (name, total) => {
    await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.chooseNote());
    await main.locator('.prompt-input').fill(`${root}-${name}`);
    await main.locator('.suggestion-item').filter({ hasText: `${root}-${name}` }).first().click();
    await main.waitForFunction(total => app.plugins.plugins["zj-html-studio"].presenter.lectureContext.deck.pages.length === total, total);
  };
  await associate("three", 3);
  await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.jump(3));
  await main.waitForFunction(() => app.plugins.plugins["zj-html-studio"].presenter.lectureContext.deck.current === 3);
  await associate("two", 2);
  assert.equal(await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.lectureContext.deck.current), 1);
  await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.unlinkNote());
  await main.waitForFunction(() => app.plugins.plugins["zj-html-studio"].presenter.lectureContext.deck.pages.length === 1);
  checks.push("Real note picker: first association shows 3 pages, replacement shows 2 and resets selection, unlink returns to 1/1 without deleting notes");
  assert.equal(await fs.readFile(path.join(vault, root, 'controlled.html'), 'utf8'), html(true));
  assert.deepEqual(errors, []);
} catch (error) {
  checks.push({ failed: error.stack }); process.exitCode = 1;
  await main.screenshot({ path: path.join(artifacts, "failure.png") });
} finally {
  await stop();
  await main.evaluate(async ({ root, settings }) => {
    const plugin = app.plugins.plugins["zj-html-studio"];
    await plugin.presenter.notes.flush();
    app.workspace.getLeavesOfType("html-studio-preview").filter(leaf => leaf.view.file?.path.startsWith(root + "/")).forEach(leaf => leaf.detach());
    plugin.settings = settings; await plugin.saveData(settings);
  }, { root, settings });
  await main.waitForFunction(root => ![...app.plugins.plugins["zj-html-studio"].previewServer.sessions.values()]
    .some(session => session.entryAbsolutePath.includes(`/${root}/`)), root);
  assert.deepEqual(errors, [], "Unexpected script errors, including window cleanup");
  await fs.writeFile(path.join(artifacts, "result.json"), JSON.stringify({ checks, errors }, null, 2));
  process.stdout.write(JSON.stringify({ checks, errors }) + "\n");
  await browser.close();
}
