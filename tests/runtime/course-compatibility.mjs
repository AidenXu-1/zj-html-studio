// Exercises two routes that a new, unrelated HTML course can enter.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const vault = process.env.HTML_STUDIO_TEST_VAULT, artifacts = process.env.HTML_STUDIO_TEST_ARTIFACTS;
assert.ok(vault && path.isAbsolute(vault) && artifacts);
assert.equal((await fs.readFile(path.join(vault, '.html-studio-runtime-test'), 'utf8')).trim(), 'disposable-test-vault');
const browser = await chromium.connectOverCDP(process.env.HTML_STUDIO_TEST_CDP ?? 'http://127.0.0.1:9234');
const context = browser.contexts()[0], main = context.pages().find(p => p.url() === 'app://obsidian.md/index.html');
assert.equal(await main.evaluate(() => app.vault.adapter.getBasePath()), vault);
await fs.mkdir(artifacts, { recursive: true });
const errors = [], checks = [];
let phase = 'setup';
const observe = p => p.on('pageerror', e => errors.push({ phase, message: e.message, stack: e.stack, url: p.url() }));
context.pages().forEach(observe); context.on('page', observe);
const root = `compatibility-${Date.now()}`;
const original = await main.evaluate(() => ({ theme: app.customCss.theme, settings: JSON.parse(JSON.stringify(app.plugins.plugins['zj-html-studio'].settings)) }));
const animated = `<!doctype html><style>html,body{margin:0;height:100%;overflow:hidden}.deck{height:100vh}.slide{display:none;height:90vh}.slide.active{display:block}nav{position:fixed;bottom:20px;left:20px}</style>
<main class="deck">${Array.from({ length: 20 }, (_, i) => `<section class="slide${i === 0 ? ' active' : ''}" id="p${String(i + 1).padStart(2, '0')}"><h1>Lesson ${i + 1}</h1></section>`).join('')}</main><nav><button id="prev">上一页</button><button id="next">下一页</button></nav>
<script>let current=0,busy=false;function show(n){if(busy)return;busy=true;setTimeout(()=>{current=Math.max(0,Math.min(19,n));document.querySelectorAll('.slide').forEach((el,i)=>el.classList.toggle('active',i===current));busy=false},260)}prev.onclick=()=>show(current-1);next.onclick=()=>show(current+1);</script>`;
const unknown = '<!doctype html><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#b41414;color:white}</style><h1>Unknown course</h1>';

async function stop() { await main.evaluate(() => app.plugins.plugins['zj-html-studio'].presenter.stopProjection()); }
async function open(name) {
  await main.evaluate(async ({ root, name }) => {
    const leaves = app.workspace.getLeavesOfType('html-studio-preview');
    const leaf = leaves[0] ?? app.workspace.getLeaf(false);
    await leaf.openFile(app.vault.getAbstractFileByPath(`${root}/${name}.html`));
    app.workspace.setActiveLeaf(leaf, { focus: true });
    leaves.slice(1).forEach(l => l.detach());
  }, { root, name });
}
async function project() {
  const opened = context.waitForEvent('page');
  await main.locator('.html-studio-projection-button:visible').click();
  const output = await opened;
  await main.waitForFunction(() => app.plugins.plugins['zj-html-studio'].presenter.output?.ready, null, { timeout: 18000 });
  return output;
}

try {
  await main.evaluate(async ({ root, animated, unknown }) => {
    await app.vault.createFolder(root);
    await app.vault.create(`${root}/animated.html`, animated);
    await app.vault.create(`${root}/unknown.html`, unknown);
    window.electronWindow.setBounds({ x: 0, y: 40, width: 1400, height: 950 });
    window.electronWindow.show(); window.electronWindow.focus();
  }, { root, animated, unknown });
  for (const test of ['floating-status-bar', 'animated-numbered-course']) {
    try {
      phase = test;
      if (test === 'floating-status-bar') {
        await main.evaluate(() => {
          app.customCss.setTheme('Primary'); app.workspace.rightSplit.collapse(); app.workspace.leftSplit.collapse();
          const item = document.createElement('div'); item.id = 'compatibility-status';
          item.className = 'status-bar-item'; item.textContent = 'Private status item 123456789'; document.querySelector('.status-bar').append(item);
        });
        await open('unknown');
        await main.waitForFunction(() => app.plugins.plugins['zj-html-studio'].presenter.context?.picture === true);
        await main.waitForTimeout(1200);
        const output = await project();
        const image = output.locator('.html-studio-projection-picture');
        assert.ok(await image.evaluate(el => el.complete && el.naturalWidth > 0));
        assert.equal(await main.evaluate(() => app.workspace.rightSplit.collapsed), true, 'must work without first opening lecture notes');
        await output.screenshot({ path: path.join(artifacts, 'unknown-output.png') });
        checks.push({ test, passed: true, notesClosed: true });
      } else {
        await main.evaluate(() => document.querySelector('#compatibility-status')?.remove());
        await open('animated');
        await main.waitForFunction(() => app.plugins.plugins['zj-html-studio'].presenter.context?.deck.pages.length === 20);
        await main.evaluate(() => app.plugins.plugins['zj-html-studio'].presenter.jump(15));
        await main.waitForFunction(() => app.plugins.plugins['zj-html-studio'].presenter.context?.deck.current === 15, null, { timeout: 8000 });
        const output = await project();
        assert.equal(await output.locator('.html-studio-projection-picture').count(), 0);
        const frame = output.frameLocator('.html-studio-projection-frame');
        await frame.locator('.active h1').filter({ hasText: 'Lesson 15' }).waitFor();
        for (const page of [2, 15]) {
          await main.evaluate(page => app.plugins.plugins['zj-html-studio'].presenter.jump(page), page);
          await main.waitForFunction(page => app.plugins.plugins['zj-html-studio'].presenter.output?.acknowledgedPage === page, page, { timeout: 12000 });
          await frame.locator('.active h1').filter({ hasText: `Lesson ${page}` }).waitFor();
        }
        checks.push({ test, passed: true, pages: '15 → 2 → 15' });
      }
    } catch (error) {
      checks.push({ test, failed: error.stack, geometry: await main.evaluate(() => ({
        frame: app.plugins.plugins['zj-html-studio'].presenter.source?.getProjectionElement()?.getBoundingClientRect().toJSON(),
        status: document.querySelector('.status-bar')?.getBoundingClientRect().toJSON()
      })) }); process.exitCode = 1;
      await main.screenshot({ path: path.join(artifacts, `${test}-failure.png`) });
    } finally { phase = `${test}:stop`; await stop(); }
  }
  assert.deepEqual(errors, []);
} finally {
  await main.evaluate(async ({ root, original }) => {
    const p = app.plugins.plugins['zj-html-studio']; p.presenter.stopProjection();
    document.querySelector('#compatibility-status')?.remove();
    app.workspace.getLeavesOfType('html-studio-preview').filter(l => l.view.file?.path.startsWith(root + '/')).forEach(l => l.detach());
    await app.workspace.getLeaf(false).setViewState({ type: 'empty', active: true });
    p.settings = original.settings; await p.saveData(p.settings); app.customCss.setTheme(original.theme);
  }, { root, original });
  await fs.writeFile(path.join(artifacts, 'result.json'), JSON.stringify({ checks, errors }, null, 2));
  process.stdout.write(JSON.stringify({ checks, errors }) + '\n'); await browser.close();
}
