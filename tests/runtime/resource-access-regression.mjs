// Run only against an explicitly marked, disposable Obsidian test vault.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const vault = process.env.HTML_STUDIO_TEST_VAULT;
assert.ok(vault && path.isAbsolute(vault));
assert.equal((await fs.readFile(path.join(vault, ".html-studio-runtime-test"), "utf8")).trim(), "disposable-test-vault");
const browser = await chromium.connectOverCDP(process.env.HTML_STUDIO_TEST_CDP ?? "http://127.0.0.1:9234");
const context = browser.contexts()[0];
const main = context.pages().find(page => page.url().includes("/index.html"));
assert.ok(main);
assert.equal(await main.evaluate(() => app.vault.adapter.getBasePath()), vault);
main.setDefaultTimeout(10000);
const original = await main.evaluate(() => JSON.parse(JSON.stringify(app.plugins.plugins["zj-html-studio"].settings)));
const root = `resource-regression-${Date.now()}`;
const artifacts = process.env.HTML_STUDIO_TEST_ARTIFACTS;
if (artifacts) await fs.mkdir(artifacts, { recursive: true });
const results = [], errors = [];
const observe = page => page.on("pageerror", error => errors.push(error.message));
context.pages().forEach(observe); context.on("page", observe);
const frame = () => main.locator(".html-studio-preview-canvas:not(.html-studio-preview-candidate) .html-studio-iframe:visible").last().contentFrame();
const state = () => main.evaluate(() => {
  const s = app.plugins.plugins["zj-html-studio"].presenter.source;
  return { mode: s?.mode, token: s?.session?.token, origin: s?.session?.origin,
    sessionScope: s?.session?.scopeRelativePath, analysisScope: s?.analysis?.scopeRelativePath,
    grants: s?.approvedResourceFiles, resources: s?.analysis?.dependencyRelativePaths,
    reading: s?.lastPageReadingState, deck: s?.deckState?.current, diagnostics: s?.diagnostics };
});
const closeTestLeaves = () => main.evaluate(async root => {
  const p = app.plugins.plugins["zj-html-studio"];
  await p.presenter.stopProjection();
  for (const leaf of app.workspace.getLeavesOfType("html-studio-preview")) {
    if (leaf.view.file?.path.startsWith(root + "/")) { leaf.view.activeScopeExpansionModal?.cancel(); leaf.detach(); }
  }
}, root);
const run = async (name, test) => {
  try { await test(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.stack, state: await state() }); }
  finally { await closeTestLeaves(); }
  process.stdout.write(JSON.stringify(results.at(-1)) + "\n");
};
const html = (extra, css = true, version = "ONE") => `<!doctype html><html><head><meta charset="utf-8">
  ${css ? '<link rel="stylesheet" href="../shared/style.css">' : ""}<style>
  body{font:24px system-ui;background:#16171b;color:white}.slide{display:none;padding:4vw}.slide.active{display:block}</style></head><body>
  ${Array.from({ length: 47 }, (_, i) => `<section class="slide" id="p${String(i + 1).padStart(2, "0")}"><h1 class="version">${version}</h1><p>Page ${i + 1}</p></section>`).join("")}
  <script>const render=()=>{const page=Number(location.hash.slice(2))||1;document.querySelectorAll('.slide').forEach((s,i)=>{s.classList.toggle('active',i+1===page);s.setAttribute('aria-hidden',String(i+1!==page))})};addEventListener('hashchange',render);render();
  const extra=['..','extras','${extra}'].join('%2F');fetch(extra).then(r=>{document.body.dataset.extraStatus=r.status});</script></body></html>`;
const open = async name => {
  await main.evaluate(async ({ file }) => {
    const p = app.plugins.plugins["zj-html-studio"];
    p.settings = { ...p.settings, defaultMode: "standard", safeScopes: [], interactiveScopes: [], trustedScopes: [], standardScopes: [], autoReload: false };
    const leaf = app.workspace.getLeaf("tab"); await leaf.openFile(app.vault.getAbstractFileByPath(file), { active: true });
  }, { file: `${root}/course/${name}.html` });
  await frame().locator("body[data-extra-status='403']").waitFor();
};
const allowFile = async name => {
  await main.evaluate(() => { const s = app.plugins.plugins["zj-html-studio"].presenter.source; if (!s.diagnosticsDrawer?.hasClass("is-open")) s.toggleDiagnostics(); });
  await main.locator(".html-studio-diagnostic-card").filter({ hasText: name }).first().getByRole("button", { name: "允许读取此文件…", exact: true }).click();
  await main.locator(".html-studio-resource-modal:visible").getByRole("button", { name: "允许读取", exact: true }).click();
  await frame().locator("body[data-extra-status='200']").waitFor();
};
const jump = page => main.evaluate(page => app.plugins.plugins["zj-html-studio"].presenter.jump(page), page);
const matching = async (page, output = false) => {
  await main.waitForFunction(({ page, output }) => {
    const p = app.plugins.plugins["zj-html-studio"].presenter;
    return p.context?.deck.current === page && document.querySelector(".html-studio-lecture input")?.value === String(page)
      && (!output || p.output?.ready && p.output.acknowledgedPage === page);
  }, { page, output }, { timeout: 8000 });
};
try {
  await main.evaluate(async ({ root, png, json, narrow }) => {
    const p = app.plugins.plugins["zj-html-studio"]; if (p.presenter.output) throw Error("Stop existing projection first");
    for (const dir of [root, `${root}/course`, `${root}/shared`, `${root}/extras`]) await app.vault.createFolder(dir);
    await app.vault.create(`${root}/shared/style.css`, "body{margin:0}");
    await app.vault.create(`${root}/extras/secret.png`, "SYNTHETIC_IMAGE");
    await app.vault.create(`${root}/extras/data.json`, '{"synthetic":true}');
    await app.vault.create(`${root}/extras/neighbor.json`, '{"notApproved":true}');
    for (const [name, html] of [["png", png], ["json", json], ["narrow", narrow]]) {
      await app.vault.create(`${root}/course/${name}.html`, html);
      await app.vault.create(`${root}/course/${name}.md`, Array.from({ length: 47 }, (_, i) => `## 第 ${i + 1} 页\n\nNOTE_${i + 1}\n`).join("\n"));
      await p.setLectureAssociation(`${root}/course/${name}.html`, `${root}/course/${name}.md`);
    }
  }, { root, png: html("secret.png"), json: html("data.json"), narrow: html("data.json", false) });

  await run("reset revokes an external image even after interaction is restored", async () => {
    await open("png"); await allowFile("secret.png");
    await main.evaluate(() => app.plugins.plugins["zj-html-studio"].resetScopeModes());
    const reset = await state(); assert.equal(reset.mode, "safe"); assert.deepEqual(reset.grants, []);
    const response = await fetch(new URL("/extras/secret.png", reset.origin));
    assert.equal(response.status, 403, "reset must revoke the actual file, not only clear the displayed grant list");
    await main.evaluate(() => { const s = app.plugins.plugins["zj-html-studio"].presenter.source; return s.replacePreviewSessionMode("standard", s.session.token, s.analysis); });
    await frame().locator("body[data-extra-status='403']").waitFor();
    assert.ok(!(await state()).resources.includes(`${root}/extras/secret.png`));
  });

  await run("refresh narrows analysis without losing the granted file, page, notes or projection", async () => {
    await open("json"); await allowFile("data.json"); await jump(15); await matching(15);
    const before = await state();
    await main.evaluate(async ({ file, html }) => { await app.vault.modify(app.vault.getAbstractFileByPath(file), html); },
      { file: `${root}/course/json.html`, html: html("data.json", false, "TWO") });
    await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.source.refreshPreview());
    await main.waitForFunction(token => {
      const s = app.plugins.plugins["zj-html-studio"].presenter.source;
      return s.session?.token !== token || s.diagnostics?.some(d => /刷新/.test(d.title + d.detail));
    }, before.token, { timeout: 18000 });
    assert.equal(await frame().locator(".slide.active .version").innerText(), "TWO");
    await matching(15);
    const after = await state();
    assert.equal(after.analysisScope, `${root}/course`); assert.equal(after.sessionScope, root);
    assert.equal(after.reading.vaultRelativePath, `${root}/course/json.html`);
    await frame().locator("body[data-extra-status='200']").waitFor();
    assert.equal((await fetch(new URL("/extras/neighbor.json", after.origin))).status, 403);
    const opened = context.waitForEvent("page");
    await main.evaluate(() => { const p = app.plugins.plugins["zj-html-studio"].presenter; return p.startProjection(p.source); });
    const output = await opened; await matching(15, true);
    for (const page of [16, 15]) {
      await jump(page); await matching(page, true);
      assert.equal(await output.frameLocator(".html-studio-projection-frame").locator(".slide.active").getAttribute("id"), `p${page}`);
    }
    if (artifacts) await main.screenshot({ path: path.join(artifacts, "refreshed-page-15.png") });
    await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.stopProjection()); await matching(15);
  });

  await run("allowing a file outside an initially narrow scope retains the source and page", async () => {
    await open("narrow"); await jump(15); await matching(15); await allowFile("data.json"); await matching(15);
    const current = await state();
    assert.equal(current.analysisScope, `${root}/course`); assert.equal(current.sessionScope, root);
    assert.equal(current.reading.vaultRelativePath, `${root}/course/narrow.html`);
    await jump(16); await matching(16); await jump(15); await matching(15);
  });
} finally {
  await closeTestLeaves();
  await main.evaluate(async original => { const p = app.plugins.plugins["zj-html-studio"]; p.settings = original; await p.saveData(original); }, original);
  if (artifacts) await fs.writeFile(path.join(artifacts, "results.json"), JSON.stringify({ results, errors }, null, 2));
  await browser.close();
}
assert.deepEqual(errors, []);
assert.equal(results.length, 3);
assert.ok(results.every(result => result.passed), "Resource access regression failed");
