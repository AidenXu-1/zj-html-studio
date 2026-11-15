// An audience viewport must not inherit the presenter's sidebar sizes or zoom.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const vault=process.env.HTML_STUDIO_TEST_VAULT, artifacts=process.env.HTML_STUDIO_TEST_ARTIFACTS;
assert.ok(vault && path.isAbsolute(vault) && artifacts);
assert.equal((await fs.readFile(path.join(vault,'.html-studio-runtime-test'),'utf8')).trim(),'disposable-test-vault');
const browser=await chromium.connectOverCDP(process.env.HTML_STUDIO_TEST_CDP??'http://127.0.0.1:9234');
const context=browser.contexts()[0], main=context.pages().find(p=>p.url()==='app://obsidian.md/index.html');
assert.equal(await main.evaluate(()=>app.vault.adapter.getBasePath()),vault);
await fs.mkdir(artifacts,{recursive:true});
const errors=[], checks=[];
const observe=p=>p.on('pageerror',e=>errors.push(e.message));context.pages().forEach(observe);context.on('page',observe);
const root=`independent-projection-${Date.now()}`;
const html=`<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#222}
#stage{position:absolute;left:50%;top:50%;width:1920px;height:1080px;transform-origin:0 0}
.slide{position:absolute;inset:0;display:none;background:#fff;color:#123;font:80px system-ui;padding:100px;box-sizing:border-box}.slide.active{display:block}
nav{position:fixed;bottom:15px;right:15px}button{font:20px system-ui}
</style><main id="stage">${Array.from({length:46},(_,i)=>`<section class="slide${i===0?' active':''}" id="chapter-name-${i}"><h1>Lesson ${i+1}</h1></section>`).join('')}</main><nav><button id="prev">上一页</button><span id="page-number">1 / 46</span><button id="next">下一页</button></nav><script>
let current=0;const slides=[...document.querySelectorAll('.slide')];function show(n){current=Math.max(0,Math.min(45,n));slides.forEach((s,i)=>s.classList.toggle('active',i===current));document.querySelector('#page-number').textContent=(current+1)+' / 46'}
prev.onclick=()=>show(current-1);next.onclick=()=>show(current+1);function fit(){const s=Math.min(innerWidth/1920,innerHeight/1080);stage.style.transform='scale('+s+') translate(-50%,-50%)'}addEventListener('resize',fit);fit();
</script>`;
const original=await main.evaluate(()=>({theme:app.customCss.theme,settings:JSON.parse(JSON.stringify(app.plugins.plugins['zj-html-studio'].settings))}));
const configDir=await main.evaluate(()=>app.vault.configDir);
try{
  await main.evaluate(async({root,html})=>{
    await app.vault.createFolder(root);await app.vault.create(`${root}/deck.html`,html);
    await app.vault.create(`${root}/notes.md`,Array.from({length:46},(_,i)=>`## 第 ${i+1} 页\n\nPRIVATE_NOTE_${i+1}\n`).join('\n'));
    const p=app.plugins.plugins['zj-html-studio'];await p.setLectureAssociation(`${root}/deck.html`,`${root}/notes.md`);
    await app.workspace.getLeaf('tab').openFile(app.vault.getAbstractFileByPath(`${root}/deck.html`));
    window.electronWindow.setBounds({x:0,y:40,width:1400,height:950});window.electronWindow.show();window.electronWindow.focus();
  },{root,html});
  await main.waitForFunction(()=>app.plugins.plugins['zj-html-studio'].presenter.context?.deck.pages.length===46);
  for(const theme of ['', 'Primary']){
    if(theme && !await fs.stat(path.join(vault,configDir,'themes',theme,'theme.css')).catch(()=>null))continue;
    await main.evaluate(theme=>app.customCss.setTheme(theme),theme);
    await main.evaluate(()=>{app.workspace.rightSplit.collapse();app.workspace.leftSplit.collapse();});
    await main.evaluate(()=>app.plugins.plugins['zj-html-studio'].presenter.jump(15));
    await main.waitForFunction(()=>app.plugins.plugins['zj-html-studio'].presenter.context?.deck.current===15);
    const opening=context.waitForEvent('page');
    await main.locator('.html-studio-projection-button:visible').click();const output=await opening;
    await main.waitForFunction(()=>app.plugins.plugins['zj-html-studio'].presenter.output?.ready,null,{timeout:18000});
    assert.equal(await output.locator('.html-studio-projection-picture').count(),0,'navigable decks need their own viewport');
    const frame=output.frameLocator('.html-studio-projection-frame');
    await frame.locator('.slide.active h1').filter({hasText:'Lesson 15'}).waitFor();
    assert.equal(await output.locator('.html-studio-projection-frame').evaluate(el=>new URL(el.src).hash),'','adapter identifiers must not become author URL fragments');
    // With an external monitor, page readiness precedes native fullscreen and
    // the author's resize callback. Establish the baseline after both finish.
    const target = await main.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- The marked Obsidian test host supplies Electron.
      const screen = require('electron').remote.screen;
      const source = screen.getDisplayMatching(window.electronWindow.getBounds());
      return screen.getAllDisplays().find(d => d.id !== source.id && (
        d.bounds.x >= source.bounds.x + source.bounds.width || d.bounds.x + d.bounds.width <= source.bounds.x
        || d.bounds.y >= source.bounds.y + source.bounds.height || d.bounds.y + d.bounds.height <= source.bounds.y))?.bounds ?? null;
    });
    if (target) await output.waitForFunction(bounds => {
      const actual = window.electronWindow.getBounds();
      return document.querySelector('.html-studio-projection')?.classList.contains('is-fullscreen')
        && Object.keys(bounds).every(key => Math.abs(actual[key] - bounds[key]) < 2);
    }, target);
    await frame.locator('#stage').evaluate(async el => {
      const deadline = Date.now() + 5000;
      while (Math.abs(el.getBoundingClientRect().width - Math.min(innerWidth, innerHeight * 16 / 9)) > 1) {
        if (Date.now() > deadline) throw Error('Audience canvas did not finish resizing');
        await new Promise(requestAnimationFrame);
      }
    });
    const geometry=()=>frame.locator('#stage').evaluate(el=>({w:innerWidth,h:innerHeight,x:el.getBoundingClientRect().x,y:el.getBoundingClientRect().y,width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}));
    const expected=await geometry();
    assert.ok(Math.abs(expected.width/expected.height-16/9)<0.001);
    const widths=[];
    for(const [left,right] of [[true,true],[false,true],[true,false],[false,false]]){
      await main.evaluate(([left,right])=>{app.workspace.leftSplit[left?'expand':'collapse']();app.workspace.rightSplit[right?'expand':'collapse']();},[left,right]);
      await main.waitForTimeout(1800);
      assert.equal(await main.evaluate(()=>app.plugins.plugins['zj-html-studio'].presenter.context?.deck.pages.length),46);
      assert.equal(await main.evaluate(()=>app.plugins.plugins['zj-html-studio'].presenter.output?.ready),true);
      assert.deepEqual(await geometry(),expected,'sidebar layout changed audience layout');
      widths.push(await main.locator('.html-studio-preview-canvas:not(.html-studio-preview-candidate) .html-studio-iframe:visible').evaluate(el=>el.getBoundingClientRect().width));
    }
    assert.ok(Math.max(...widths)-Math.min(...widths)>200,'source sidebar sizes must really change');
    for(const n of [16,15]){
      await main.evaluate(n=>app.plugins.plugins['zj-html-studio'].presenter.jump(n),n);
      await main.waitForFunction(n=>app.plugins.plugins['zj-html-studio'].presenter.output?.acknowledgedPage===n,n);
      await frame.locator('.slide.active h1').filter({hasText:`Lesson ${n}`}).waitFor();
      assert.deepEqual(await geometry(),expected);
    }
    assert.ok(!await output.locator('body').textContent().then(t=>t.includes('PRIVATE_NOTE')));
    await output.screenshot({path:path.join(artifacts,`${theme||'default'}-output.png`)});
    await main.evaluate(()=>app.plugins.plugins['zj-html-studio'].presenter.stopProjection());
    assert.equal(await main.evaluate(()=>app.plugins.plugins['zj-html-studio'].presenter.context.deck.current),15);
    checks.push({theme:theme||'Default',sourceWidths:widths,audience:expected,pages:'15 → 16 → 15',notesIsolated:true});
  }
  assert.deepEqual(errors,[]);
}catch(error){checks.push({failed:error.stack});process.exitCode=1;}
finally{
  await main.evaluate(async({root,original})=>{const p=app.plugins.plugins['zj-html-studio'];p.presenter.stopProjection();app.workspace.getLeavesOfType('html-studio-preview').filter(l=>l.view.file?.path.startsWith(root+'/')).forEach(l=>l.detach());p.settings=original.settings;await p.saveData(p.settings);app.customCss.setTheme(original.theme);},{root,original});
  await fs.writeFile(path.join(artifacts,'result.json'),JSON.stringify({checks,errors},null,2));process.stdout.write(JSON.stringify({checks,errors})+'\n');await browser.close();
}
