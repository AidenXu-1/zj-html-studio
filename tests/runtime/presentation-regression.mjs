// Run only against an explicitly marked, disposable Obsidian test vault.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const vaultPath = process.env.HTML_STUDIO_TEST_VAULT;
assert.ok(vaultPath && path.isAbsolute(vaultPath), "Set HTML_STUDIO_TEST_VAULT to a disposable test vault");
assert.equal((await fs.readFile(path.join(vaultPath, ".html-studio-runtime-test"), "utf8")).trim(), "disposable-test-vault");
const browser = await chromium.connectOverCDP(process.env.HTML_STUDIO_TEST_CDP ?? "http://127.0.0.1:9234");
const context = browser.contexts()[0];
const main = context.pages().find(page => page.url().includes("/index.html"));
assert.ok(main, "Obsidian main window was not found");
assert.equal(await main.evaluate(() => app.vault.adapter.getBasePath()), vaultPath);
const root = `html-studio-regression-${Date.now()}`;
const savedSettings = await main.evaluate(() => JSON.parse(JSON.stringify(app.plugins.plugins["zj-html-studio"].settings)));
const artifacts = process.env.HTML_STUDIO_TEST_ARTIFACTS;
if (artifacts) await fs.mkdir(artifacts, { recursive: true });
const results = [];
const pageErrors = [];
let currentCase = "setup";
let currentStep = "setup";
const observe = page => page.on("pageerror", error => pageErrors.push({
  case: currentCase, step: currentStep, message: error.message, stack: error.stack
}));
context.pages().forEach(observe);
context.on("page", observe);
const deck = delay => `<!doctype html><html><head><style>
body{margin:0;background:#16171b;color:white;font:24px system-ui}.slide{display:none;padding:4vw}.slide.active{display:block}nav{position:fixed;bottom:12px;right:12px}button{padding:12px}
</style></head><body>${Array.from({ length: 47 }, (_, i) => `<section id="p${String(i + 1).padStart(2, "0")}" class="slide"><h1>Page ${i + 1}</h1><p class="version">REVISION_ONE</p></section>`).join("")}
<nav><button id="prev">Previous</button><button id="next">Next</button></nav><script>
const render=()=>{const page=Math.max(1,Math.min(47,Number(location.hash.slice(2))||1));document.querySelectorAll('.slide').forEach((s,i)=>{s.classList.toggle('active',i+1===page);s.setAttribute('aria-hidden',String(i+1!==page));});};
addEventListener('hashchange',()=>setTimeout(render,${delay}));render();
document.querySelector('#next').onclick=()=>location.hash='p'+String(Math.min(47,(Number(location.hash.slice(2))||1)+1)).padStart(2,'0');
document.querySelector('#prev').onclick=()=>location.hash='p'+String(Math.max(1,(Number(location.hash.slice(2))||1)-1)).padStart(2,'0');
</script></body></html>`;
const note = Array.from({ length: 47 }, (_, i) => `## 第 ${i + 1} 页\n\nNOTE_${i + 1}\n`).join("\n");
const run = async (name, fn) => {
  currentCase = name;
  try { await fn(); results.push({ name, passed: true }); }
  catch (error) {
    const state = await main.evaluate(() => {
      const p = app.plugins.plugins["zj-html-studio"].presenter;
      const s = p.source;
      return {page:p.context?.deck.current,bridge:s?.searchBridgeReady,ownerBound:s?.windowEventCleanup?.has(s.contentEl.win),ownerMain:s?.contentEl.win===window,windows:s?.windowEventCleanup?.size,frameTitle:s?.activeIframe?.title,note:document.querySelector(".html-studio-lecture input")?.value};
    });
    results.push({ name, passed: false, error: error.stack || String(error),state });
  }
  process.stdout.write(JSON.stringify(results.at(-1)) + "\n");
};
const stop = () => main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.stopProjection());
const open = async name => {
  currentStep = `open ${name}`;
  await stop();
  await main.evaluate(async ({ root, name }) => {
    const old = app.workspace.getLeavesOfType("html-studio-preview").filter(leaf => leaf.view.file?.path.startsWith(root + "/"));
    const tabs = app.workspace.rootSplit.children[0];
    const leaf = app.workspace.createLeafInParent(tabs, tabs.children.length);
    await leaf.openFile(app.vault.getAbstractFileByPath(`${root}/${name}.html`), { active: true });
    old.forEach(leaf => leaf.detach());
  }, { root, name });
  await main.waitForFunction(({ root, name }) => {
    const p = app.plugins.plugins["zj-html-studio"].presenter;
    return p.context?.filePath === `${root}/${name}.html` && p.context.deck.current === 1 && p.context.deck.pages.length === 47 && p.source.searchBridgeReady;
  }, { root, name }, { timeout: 8000 });
};
const jump = page => main.evaluate(page => app.plugins.plugins["zj-html-studio"].presenter.jump(page), page);
const matching = async (page, projected = false) => {
  await main.waitForFunction(({ page, projected }) => {
    const p = app.plugins.plugins["zj-html-studio"].presenter;
    return p.context?.deck.current === page && document.querySelector(".html-studio-lecture input")?.value === String(page)
      && document.querySelector(".html-studio-lecture")?.textContent.includes(`NOTE_${page}`)
      && (!projected || p.output?.ready && p.output.acknowledgedPage === page);
  }, { page, projected }, { timeout: 6000 });
};
const start = async () => {
  const opened = context.waitForEvent("page");
  await main.evaluate(() => {
    const p = app.plugins.plugins["zj-html-studio"].presenter;
    return p.startProjection(p.source);
  });
  const output = await opened;
  await main.waitForFunction(() => app.plugins.plugins["zj-html-studio"].presenter.output?.ready, null, { timeout: 18000 });
  return output;
};
const actualPage = async (window, selector) => window.frameLocator(selector).locator(".slide.active").getAttribute("id");

try {
  await main.evaluate(async ({ root, sync, delayed, note }) => {
    const plug = app.plugins.plugins["zj-html-studio"];
    if (plug.presenter.output) throw new Error("Stop existing presentation before running regression tests");
    await app.vault.createFolder(root);
    for (const [name, html] of [["sync", sync], ["delayed", delayed], ["revision", sync]]) {
      await app.vault.create(`${root}/${name}.html`, html);
      await app.vault.create(`${root}/${name}.md`, note);
      await plug.setLectureAssociation(`${root}/${name}.html`, `${root}/${name}.md`);
    }
    plug.settings.interactiveScopes.push(root);
    await plug.saveData(plug.settings);
  }, { root, sync: deck(0), delayed: deck(150), note });

  await run("delayed slide: source, notes and fullscreen output follow 15 → 16 → 15", async () => {
    await open("delayed"); await jump(15); await matching(15);
    const output = await start();
    // A connected external display is placed asynchronously after the first
    // frame is ready. Clicking fullscreen during that move would toggle it twice.
    const automaticFullscreen = await main.evaluate(() => {
      const display = app.plugins.plugins["zj-html-studio"].presenter.output?.view?.display;
      if (!display?.source || !display.screen) return false;
      const source = display.screen.getDisplayMatching(display.source.getBounds());
      const a = source.bounds;
      return display.screen.getAllDisplays().some(other => {
        const b = other.bounds;
        return other.id !== source.id && (b.x >= a.x + a.width || b.x + b.width <= a.x
          || b.y >= a.y + a.height || b.y + b.height <= a.y);
      });
    });
    if (automaticFullscreen) {
      await output.waitForFunction(() => document.querySelector(".html-studio-projection")?.classList.contains("is-fullscreen"), null, { timeout: 6000 });
    } else {
      await output.getByRole("button", { name: "全屏演示", exact: true }).click();
    }
    await output.waitForFunction(() => document.querySelector(".html-studio-projection")?.classList.contains("is-fullscreen"));
    const geometry = await output.evaluate(() => {
      const r = document.querySelector(".html-studio-projection-frame").getBoundingClientRect();
      return { x:r.x,y:r.y,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight };
    });
    assert.ok(Math.abs(geometry.x) < 2 && Math.abs(geometry.y) < 2, "Fullscreen output has no host title bar or blank margin");
    assert.ok(Math.abs(geometry.width - geometry.viewportWidth) < 2 && Math.abs(geometry.height - geometry.viewportHeight) < 2, "Course uses the entire output viewport");
    for (const page of [16, 15]) {
      await jump(page); await matching(page, true);
      assert.equal(await actualPage(main, ".html-studio-preview-canvas:not(.html-studio-preview-candidate) .html-studio-iframe:visible"), `p${page}`);
      assert.equal(await actualPage(output, ".html-studio-projection-frame"), `p${page}`);
    }
    if (artifacts) {
      await main.screenshot({ path: path.join(artifacts, "source-page-15.png") });
      await output.screenshot({ path: path.join(artifacts, "output-page-15.png") });
    }
    await output.keyboard.press("Escape");
    await output.waitForFunction(() => !document.fullscreenElement && !document.querySelector(".html-studio-projection")?.classList.contains("is-fullscreen"));
    assert.equal(await actualPage(output, ".html-studio-projection-frame"), "p15");
    await stop(); await matching(15);
    await main.evaluate(() => {
      window.__presentationFullscreenReady = false;
      window.electronWindow.once("enter-full-screen", () => { window.__presentationFullscreenReady = true; });
    });
    await main.locator(".html-studio-fullscreen-button:visible").click();
    await main.waitForFunction(() => Boolean(document.fullscreenElement));
    await main.waitForFunction(() => window.__presentationFullscreenReady, null, { timeout: 6000 });
    await main.bringToFront();
    await main.keyboard.press("Escape");
    await main.waitForFunction(() => !document.fullscreenElement);
    await matching(15);
  });

  await run("modified HTML is refused before projection displays different bytes; refresh recovers", async () => {
    await open("revision"); await jump(15); await matching(15);
    await main.evaluate(async root => {
      const plug = app.plugins.plugins["zj-html-studio"];
      await plug.setAutoReload(false);
      const file = app.vault.getAbstractFileByPath(`${root}/revision.html`);
      await app.vault.modify(file, (await app.vault.read(file)).replaceAll("REVISION_ONE", "REVISION_TWO"));
      await plug.presenter.startProjection(plug.presenter.source);
    }, root);
    await main.waitForFunction(() => !app.plugins.plugins["zj-html-studio"].presenter.output, null, { timeout: 6000 });
    assert.equal(await main.frameLocator(".html-studio-preview-canvas:not(.html-studio-preview-candidate) .html-studio-iframe:visible").locator(".slide.active .version").innerText(), "REVISION_ONE");
    assert.ok((await main.locator(".notice").allTextContents()).some(text => text.includes("课件文件已修改")));
    if (artifacts) await main.screenshot({ path: path.join(artifacts, "version-change-notice.png") });
    await main.evaluate(() => app.plugins.plugins["zj-html-studio"].presenter.source.refreshPreview());
    await main.frameLocator(".html-studio-preview-canvas:not(.html-studio-preview-candidate) .html-studio-iframe:visible").locator(".slide.active .version").filter({ hasText: "REVISION_TWO" }).waitFor();
    await matching(15);
    const output = await start();
    assert.equal(await output.frameLocator(".html-studio-projection-frame").locator(".slide.active .version").innerText(), "REVISION_TWO");
    await stop();
  });

  await run("moving a live tab to a popout and back retains page, notes and projection", async () => {
    await open("sync"); await jump(15); await matching(15);
    for (let round = 0; round < 6; round++) {
      currentStep = `move to popout ${round + 1}`;
      const opened = context.waitForEvent("page");
      await main.evaluate(() => { app.workspace.moveLeafToPopout(app.plugins.plugins["zj-html-studio"].presenter.source.leaf); });
      const popout = await opened;
      await matching(15);
      currentStep = "next in popout";
      await popout.frameLocator(".html-studio-iframe").locator("#next").click();
      await matching(16);
      assert.equal(await actualPage(popout, ".html-studio-iframe"), "p16");
      const output = await start();
      assert.equal(await actualPage(output, ".html-studio-projection-frame"), "p16");
      await stop();
      currentStep = `move back ${round + 1}`;
      const placeholderId = await main.evaluate(() => {
        const source = app.plugins.plugins["zj-html-studio"].presenter.source;
        const placeholder = app.workspace.createLeafInParent(source.leaf.parent, source.leaf.parent.children.length);
        source.leaf.parent.removeChild(source.leaf);
        app.workspace.rootSplit.children[0].insertChild(0, source.leaf);
        app.workspace.setActiveLeaf(source.leaf, { focus: true });
        return placeholder.id;
      });
      await main.frameLocator(".html-studio-preview-canvas:not(.html-studio-preview-candidate) .html-studio-iframe:visible").locator(".slide.active").waitFor();
      await matching(16);
      await jump(15); await matching(15);
      assert.equal(await actualPage(main, ".html-studio-preview-canvas:not(.html-studio-preview-candidate) .html-studio-iframe:visible"), "p15");
      currentStep = "close old window";
      const closed = popout.waitForEvent("close");
      // Let Obsidian close its last tab/window; CDP Target.closeTarget bypasses its
      // native teardown and can itself produce closed-renderer errors.
      await main.evaluate(id => app.workspace.iterateAllLeaves(leaf => {
        if (leaf.id === id) leaf.detach();
      }), placeholderId);
      await closed;
    }
  });

  currentStep = "rename";
  await run("two consecutive note renames survive a pending save", async () => {
    await stop();
    const result = await main.evaluate(async root => {
      const plug = app.plugins.plugins["zj-html-studio"];
      const file = await app.vault.create(`${root}/rename-a.md`, "## 第 1 页\nNOTE\n");
      await plug.setLectureAssociation(`${root}/sync.html`, file.path);
      const originalSave = plug.saveData;
      let pending = Promise.resolve();
      plug.saveData = async function(value) {
        pending = new Promise(resolve => setTimeout(resolve, 300)).then(() => originalSave.call(this, value));
        return pending;
      };
      try {
        await app.vault.rename(file, `${root}/rename-b.md`);
        await app.vault.rename(file, `${root}/rename-c.md`);
        await plug.setAutoReload(plug.settings.autoReload); // Drain the same settings queue.
        const linked = plug.settings.lectureNotes[`${root}/sync.html`];
        return { linked, exists: Boolean(app.vault.getAbstractFileByPath(linked)) };
      } finally { await pending; plug.saveData = originalSave; }
    }, root);
    assert.equal(result.linked, `${root}/rename-c.md`); assert.equal(result.exists, true);
  });
} finally {
  currentStep = "cleanup";
  await main.evaluate(async ({ root, settings }) => {
    const plug = app.plugins.plugins["zj-html-studio"];
    plug.presenter.stopProjection();
    app.workspace.getLeavesOfType("html-studio-preview").filter(leaf => leaf.view.file?.path.startsWith(root + "/")).forEach(leaf => leaf.detach());
    const folder = app.vault.getAbstractFileByPath(root);
    if (folder) await app.vault.delete(folder, true);
    await plug.setAutoReload(settings.autoReload);
    await plug.saveData(settings); plug.settings = settings;
  }, { root, settings: savedSettings });
  // Closing the test tab can reveal an existing Markdown tab with HTML embeds.
  // Require every session owned by this run to close; unrelated embeds may load.
  await main.waitForFunction(root => ![...app.plugins.plugins["zj-html-studio"].previewServer.sessions.values()]
    .some(session => session.entryAbsolutePath.includes(`/${root}/`)), root);
  await browser.close();
}
if (artifacts) await fs.writeFile(path.join(artifacts, "results.json"), JSON.stringify({ results, pageErrors, sessionsRestored: true }, null, 2));
assert.deepEqual(pageErrors, [], "Unexpected script errors");
assert.ok(results.length === 4 && results.every(result => result.passed), "Presentation regressions failed");
