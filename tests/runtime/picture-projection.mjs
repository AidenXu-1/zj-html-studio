import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
const vault=process.env.HTML_STUDIO_TEST_VAULT;
assert.ok(vault && path.isAbsolute(vault));
assert.equal((await fs.readFile(path.join(vault,'.html-studio-runtime-test'),'utf8')).trim(),'disposable-test-vault');
const browser=await chromium.connectOverCDP(process.env.HTML_STUDIO_TEST_CDP??'http://127.0.0.1:9234');
const main=browser.contexts()[0].pages().find(p=>p.url().includes('/index.html'));
assert.equal(await main.evaluate(()=>app.vault.adapter.getBasePath()),vault);
const out=process.env.HTML_STUDIO_TEST_ARTIFACTS;
await fs.mkdir(out,{recursive:true});
const errors=[];browser.contexts()[0].on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
main.on('pageerror',e=>errors.push(e.message));
const root=`picture-regression-${Date.now()}`;
const results=[];
const html=`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:rgb(180,20,20)}button{position:absolute;top:30px;left:30px}</style></head><body><button onclick="document.body.style.background='rgb(20,20,180)'">Change</button></body></html>`;
try {
  await main.evaluate(async()=>{await app.plugins.disablePlugin('zj-html-studio');await app.plugins.enablePlugin('zj-html-studio');});
  await main.evaluate(async({root,html})=>{
    await app.vault.createFolder(root);
    await app.vault.create(`${root}/unknown.html`,html);
    await app.vault.create(`${root}/note.md`,'## 第 1 页\nPRIVATE_LECTURE\n\n## 第 2 页\nSECOND_NOTE\n\n## 第 3 页\nTHIRD_NOTE');
    const plug=app.plugins.plugins['zj-html-studio'];await plug.setLectureAssociation(`${root}/unknown.html`,`${root}/note.md`);
    await app.workspace.getLeaf('tab').openFile(app.vault.getAbstractFileByPath(`${root}/unknown.html`));
  },{root,html});
  await main.waitForFunction(()=>app.plugins.plugins['zj-html-studio'].presenter.context?.picture===true);
  await main.evaluate(()=>app.plugins.plugins['zj-html-studio'].presenter.showNotes());
  await main.waitForFunction(()=>app.plugins.plugins['zj-html-studio'].presenter.lectureContext?.deck.pages.length===3);
  await main.evaluate(()=>app.plugins.plugins['zj-html-studio'].presenter.jump(2));
  await main.waitForFunction(()=>app.plugins.plugins['zj-html-studio'].presenter.lectureContext?.deck.current===2);
  results.push('unknown HTML: projection enabled; linked notes manually select page 2');
  const opened=browser.contexts()[0].waitForEvent('page');
  await main.locator('.html-studio-projection-button:visible').click();
  const output=await opened;
  await main.waitForFunction(()=>app.plugins.plugins['zj-html-studio'].presenter.output?.ready,null,{timeout:18000});
  const picture=output.locator('.html-studio-projection-picture');
  const color=()=>picture.evaluate(img=>{const c=document.createElement('canvas');c.width=1;c.height=1;const ctx=c.getContext('2d');ctx.drawImage(img,-img.naturalWidth/2,-img.naturalHeight/2);return [...ctx.getImageData(0,0,1,1).data];});
  let rgb=await color();assert.ok(rgb[0]>rgb[2]*2,`expected red ${rgb}`);
  const frames=()=>main.evaluate(()=>app.plugins.plugins['zj-html-studio'].presenter.output.view.picture.frames);
  // A previous test's toast can temporarily cover the course. Privacy pauses
  // are intentional; measure throughput only once unobscured frames resume.
  await main.waitForFunction(()=>app.plugins.plugins['zj-html-studio'].presenter.output.view.picture.frames>=3,null,{timeout:15000});
  const start=await frames();await new Promise(r=>setTimeout(r,2000));const fps=((await frames())-start)/2;
  assert.ok(fps>=3,`capture too slow: ${fps} fps`);
  const iframe=main.frameLocator('.html-studio-preview-canvas:not(.html-studio-preview-candidate) .html-studio-iframe:visible');
  await iframe.getByRole('button',{name:'Change'}).click();
  await output.waitForFunction(()=>{const img=document.querySelector('.html-studio-projection-picture');const c=document.createElement('canvas');c.width=1;c.height=1;const ctx=c.getContext('2d');ctx.drawImage(img,-img.naturalWidth/2,-img.naturalHeight/2);const d=ctx.getImageData(0,0,1,1).data;return d[2]>d[0]*2;});
  results.push({pictureTracksClicks:true,fps});
  await main.evaluate(()=>{
    const frame=app.plugins.plugins['zj-html-studio'].presenter.source.getProjectionElement();const r=frame.getBoundingClientRect();
    const el=document.createElement('div');el.id='capture-private-overlay';el.textContent='PRIVATE_LECTURE_SHOULD_NEVER_LEAVE';
    el.style.cssText=`position:fixed;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;background:#00ff00;z-index:999999;pointer-events:none`;
    document.body.append(el);
  });
  await new Promise(r=>setTimeout(r,250));const held=await frames();await new Promise(r=>setTimeout(r,500));assert.equal(await frames(),held);
  rgb=await color();assert.ok(rgb[2]>rgb[1]*2,`overlay leaked ${rgb}`);
  await main.evaluate(()=>document.querySelector('#capture-private-overlay').remove());
  await main.waitForFunction(held=>app.plugins.plugins['zj-html-studio'].presenter.output.view.picture.frames>held,held);
  results.push('pointer-events:none overlay pauses capture; no private pixels; resumes after dismissal');
  await main.evaluate(()=>window.electronWindow.webContents.setZoomFactor(1.25));
  await main.waitForFunction(held=>app.plugins.plugins['zj-html-studio'].presenter.output.view.picture.frames>held+2,await frames());
  rgb=await color();assert.ok(rgb[2]>rgb[0]*2);
  const sourceRatio=await main.evaluate(()=>{const r=app.plugins.plugins['zj-html-studio'].presenter.source.getProjectionElement().getBoundingClientRect();return r.width/r.height;});
  const imageRatio=await picture.evaluate(img=>img.naturalWidth/img.naturalHeight);
  assert.ok(Math.abs(sourceRatio-imageRatio)<.01,'125% zoom keeps the exact course aspect ratio');
  await main.evaluate(()=>window.electronWindow.webContents.setZoomFactor(1));
  await main.evaluate(()=>app.workspace.leftSplit.collapsed?app.workspace.leftSplit.expand():app.workspace.leftSplit.collapse());
  await main.waitForFunction(held=>app.plugins.plugins['zj-html-studio'].presenter.output.view.picture.frames>held+2,await frames());
  results.push('125% host zoom and sidebar resizing keep course-only capture and proportions');
  await main.evaluate(async()=>{window.__pictureSourceLeaf=app.plugins.plugins['zj-html-studio'].presenter.source.leaf;const parent=window.__pictureSourceLeaf.parent;const leaf=app.workspace.createLeafInParent(parent,parent.children.length);window.__pictureOtherLeaf=leaf;await leaf.setViewState({type:'empty',active:true});app.workspace.setActiveLeaf(leaf,{focus:true});});
  await main.waitForFunction(()=>app.plugins.plugins['zj-html-studio'].presenter.source.getProjectionElement().getBoundingClientRect().width===0);
  await new Promise(r=>setTimeout(r,250));const hidden=await frames();await new Promise(r=>setTimeout(r,400));assert.equal(await frames(),hidden);
  await main.evaluate(()=>{app.workspace.setActiveLeaf(window.__pictureSourceLeaf,{focus:true});window.__pictureOtherLeaf.detach();});
  await main.waitForFunction(held=>app.plugins.plugins['zj-html-studio'].presenter.output.view.picture.frames>held,hidden);
  results.push('switching away freezes the course instead of sharing another tab; returning resumes');

  await main.screenshot({path:path.join(out,'source.png')});await output.screenshot({path:path.join(out,'output.png')});
  if(!await output.locator('.html-studio-projection').evaluate(el=>el.classList.contains('is-fullscreen'))) {
    await output.getByRole('button',{name:'全屏演示',exact:true}).click({force:true});
  }
  await output.waitForFunction(()=>document.querySelector('.html-studio-projection').classList.contains('is-fullscreen'));
  await output.screenshot({path:path.join(out,'fullscreen.png')});
  await output.keyboard.press('Escape');
  await output.waitForFunction(()=>!document.querySelector('.html-studio-projection').classList.contains('is-fullscreen'));
  await main.evaluate(()=>app.plugins.plugins['zj-html-studio'].presenter.stopProjection());
  assert.equal(await main.evaluate(()=>app.plugins.plugins['zj-html-studio'].presenter.lectureContext.deck.current),2);
  results.push('fullscreen, Esc, stop retains manual note page');
  assert.deepEqual(errors,[]);
}catch(error){
  results.push({failed:error.stack,state:await main.evaluate(()=>{const p=app.plugins.plugins['zj-html-studio'].presenter;return {visibility:document.visibilityState,frames:p.output?.view?.picture?.frames,rect:p.source?.getProjectionElement()?.getBoundingClientRect().toJSON(),paused:p.output?.view?.picture?.stopped}})});
  await main.screenshot({path:path.join(out,'failure.png')});
  process.exitCode=1;
}finally{
  process.stdout.write(JSON.stringify({results,errors})+"\n");await fs.writeFile(path.join(out,'result.json'),JSON.stringify({results,errors},null,2));
  await main.evaluate(()=>{window.electronWindow.webContents.setZoomFactor(1);document.querySelector('#capture-private-overlay')?.remove();app.plugins.plugins['zj-html-studio'].presenter.stopProjection();});
  await browser.close();
}
