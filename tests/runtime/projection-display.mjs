// Test only a marked disposable vault; an optional course must be a project copy.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const vault = process.env.HTML_STUDIO_TEST_VAULT;
assert.ok(vault && path.isAbsolute(vault));
assert.equal((await fs.readFile(path.join(vault, ".html-studio-runtime-test"), "utf8")).trim(), "disposable-test-vault");
const project = await fs.realpath(fileURLToPath(new URL("../../../..", import.meta.url)));
const sample = process.env.HTML_STUDIO_PROJECTION_SAMPLE;
const assets = process.env.HTML_STUDIO_PROJECTION_ASSETS;
const expectedPages = Number(process.env.HTML_STUDIO_PROJECTION_PAGES ?? 47);
assert.ok(Number.isInteger(expectedPages) && expectedPages >= 16 && expectedPages <= 500);
if (sample) assert.ok((await fs.realpath(sample)).startsWith(project + path.sep));
if (assets) {
 assert.ok(sample, "Assets must accompany an explicit project-local sample");
 assert.ok((await fs.realpath(assets)).startsWith(project + path.sep));
 assert.ok((await fs.stat(assets)).isDirectory());
}
const html = sample ? await fs.readFile(sample, "utf8") : `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:#101114;color:white}body{display:grid;place-items:center}
.deck{position:relative;width:min(100vw,177.77778vh);height:min(100vh,56.25vw);background:#181a22}
.slide{position:absolute;inset:0;display:none;padding:6%;box-sizing:border-box}.slide.active{display:block}
h1{font:5vw system-ui}p{font:2vw system-ui}</style></head><body><main class="deck">${Array.from({ length:47 }, (_,i)=>`<section class="slide" id="p${i+1}"><h1>演示第 ${i+1} 页</h1><p>完整画面 · 本机讲义独立显示</p></section>`).join("")}</main><script>
function render(){const page=Number(location.hash.slice(2))||1;document.querySelectorAll('.slide').forEach((s,i)=>s.classList.toggle('active',i+1===page))}addEventListener('hashchange',render);render();</script></body></html>`;
const browser = await chromium.connectOverCDP(process.env.HTML_STUDIO_TEST_CDP ?? "http://127.0.0.1:9234");
const context = browser.contexts()[0];
const main = context.pages().find(p=>p.url().includes("/index.html"));
assert.ok(main);
assert.equal(await main.evaluate(()=>app.vault.adapter.getBasePath()),vault);
const root = `projection-display-${Date.now()}`;
const artifacts = process.env.HTML_STUDIO_TEST_ARTIFACTS;
if(artifacts) await fs.mkdir(artifacts,{recursive:true});
const original = await main.evaluate(()=>({settings:JSON.parse(JSON.stringify(app.plugins.plugins["zj-html-studio"].settings)),sessions:app.plugins.plugins["zj-html-studio"].previewServer.activeSessionCount}));
const errors = [], checks = [];
let stage = "prepare";
const observe = p=>p.on("pageerror",error=>errors.push({stage, error:error.stack??error.message}));
context.pages().forEach(observe);context.on("page",observe);
let output, geometry, screens, result, sourceBefore;
try {
 await main.evaluate(async root=>{
  if(app.plugins.plugins["zj-html-studio"].presenter.output) throw new Error("Stop existing projection first");
  await app.vault.createFolder(root);
 },root);
 if(assets) {
  await fs.cp(assets,path.join(vault,root,path.basename(assets)),{recursive:true,errorOnExist:true,force:false});
  // Finish fixture creation before registering live reload dependencies. Late
  // filesystem create events would otherwise refresh a course during playback.
  const entries=await fs.readdir(assets,{recursive:true});
  const stats=await Promise.all(entries.map(entry=>fs.stat(path.join(assets,entry))));
  const count=stats.filter(stat=>stat.isFile()).length;
  await main.waitForFunction(({root,count})=>app.vault.getFiles().filter(file=>file.path.startsWith(root+"/")).length===count,{root,count},{timeout:15000});
 }
 const opening = main.evaluate(async ({root,html,expectedPages})=>{
  const plug=app.plugins.plugins["zj-html-studio"];
  assertNoProjection();
  function assertNoProjection(){if(plug.presenter.output) throw new Error("Stop existing projection first");}
  const file=await app.vault.create(`${root}/course.html`,html);
  await app.vault.create(`${root}/notes.md`,Array.from({length:expectedPages},(_,i)=>`## 第 ${i+1} 页\n\n讲述提示 ${i+1}：只显示在本机。\n`).join("\n"));
  await plug.setLectureAssociation(file.path,`${root}/notes.md`);
  plug.settings.standardScopes ??= []; plug.settings.standardScopes.push(root);await plug.saveData(plug.settings);
  await app.workspace.getLeaf("tab").openFile(file,{active:true});
 },{root,html,expectedPages});
 await opening;
 await main.waitForFunction(({root,expectedPages})=>{
  const context=app.plugins.plugins["zj-html-studio"].presenter.context;
  return context?.filePath===`${root}/course.html`&&context.deck.pages.length===expectedPages;
 },{root,expectedPages},{timeout:15000});
 await main.evaluate(async()=>{const p=app.plugins.plugins["zj-html-studio"].presenter;await p.showNotes();p.jump(15);});
 await main.waitForFunction(()=>app.plugins.plugins["zj-html-studio"].presenter.context?.deck.current===15);
 assert.equal(await main.evaluate(()=>app.plugins.plugins["zj-html-studio"].presenter.context.deck.pages.length),expectedPages);
 assert.equal(await main.getByRole("button",{name:"投屏演示",exact:true}).isEnabled(),true);
 checks.push(`Recognized ${expectedPages} pages and enabled the presentation button`);
 stage="open";
 sourceBefore=await main.evaluate(()=>({bounds:window.electronWindow.getBounds(),fullscreen:window.electronWindow.isFullScreen(),simple:window.electronWindow.isSimpleFullScreen?.()}));
 const opened=context.waitForEvent("page");
 await main.getByRole("button",{name:"投屏演示",exact:true}).click();
 output=await opened;
 await main.waitForFunction(()=>app.plugins.plugins["zj-html-studio"].presenter.output?.ready,null,{timeout:18000});
 // eslint-disable-next-line @typescript-eslint/no-require-imports -- This callback runs inside the marked Obsidian host, which supplies Electron.
 screens=await main.evaluate(()=>require("electron").remote.screen.getAllDisplays().map(d=>({id:d.id,label:d.label,bounds:d.bounds,internal:d.internal,scaleFactor:d.scaleFactor})));
 const sourceDisplay=screens.find(d=>sourceBefore.bounds.x>=d.bounds.x && sourceBefore.bounds.x<d.bounds.x+d.bounds.width);
 const target=screens.filter(d=>d.id!==sourceDisplay?.id && (d.bounds.x>=sourceDisplay.bounds.x+sourceDisplay.bounds.width || d.bounds.x+d.bounds.width<=sourceDisplay.bounds.x || d.bounds.y>=sourceDisplay.bounds.y+sourceDisplay.bounds.height || d.bounds.y+d.bounds.height<=sourceDisplay.bounds.y)).sort((a,b)=>Number(a.internal)-Number(b.internal)||a.id-b.id)[0];
 if(target) await output.waitForFunction(bounds=>{
  const actual=window.electronWindow.getBounds();
  return document.querySelector(".html-studio-projection")?.classList.contains("is-fullscreen") && Object.keys(bounds).every(key=>Math.abs(actual[key]-bounds[key])<2);
 },target.bounds,{timeout:8000});
 const automatic=await output.evaluate(()=>document.querySelector(".html-studio-projection")?.classList.contains("is-fullscreen"));
 stage="fullscreen";
 if(!automatic) await output.getByRole("button",{name:"全屏演示",exact:true}).click();
 await output.waitForFunction(()=>document.querySelector(".html-studio-projection")?.classList.contains("is-fullscreen"));
 if(target) await output.waitForFunction(target=>Math.abs(innerWidth*devicePixelRatio/target.scaleFactor-target.bounds.width)<2 && Math.abs(innerHeight*devicePixelRatio/target.scaleFactor-target.bounds.height)<2,target);
 geometry=await output.evaluate(()=>{
  const r=document.querySelector(".html-studio-projection-frame").getBoundingClientRect();
  return {frame:{x:r.x,y:r.y,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight},native:window.electronWindow.getBounds(),simple:window.electronWindow.isSimpleFullScreen?.()};
 });
 assert.ok(Math.abs(geometry.frame.x)<2 && Math.abs(geometry.frame.y)<2);
 assert.ok(Math.abs(geometry.frame.width-geometry.viewport.width)<2 && Math.abs(geometry.frame.height-geometry.viewport.height)<2);
 if(target) {
  assert.deepEqual(geometry.native,target.bounds,"Output must fill the independent external display");
  assert.deepEqual(await main.evaluate(()=>({bounds:window.electronWindow.getBounds(),fullscreen:window.electronWindow.isFullScreen(),simple:window.electronWindow.isSimpleFullScreen?.()})),sourceBefore,"Source window must remain on its original display");
  checks.push("Automatic fullscreen uses the external display; the local window is unchanged");
 }
 checks.push("Output covers the viewport without host title bar or notes");
 stage="navigate";
 const pages=[];
 for(const [step,page] of [15,16,15].entries()) {
  stage=`navigate-${step}-${page}`;
  await main.bringToFront();
  if(step===1) {
   const next=main.frameLocator(".html-studio-preview-canvas:not(.html-studio-preview-candidate) .html-studio-iframe:visible").locator("#next:visible, #nextBtn:visible").first();
   if(await next.count() && await next.isEnabled()) await next.click();
   else await main.getByRole("button",{name:"课件下一页",exact:true}).click();
  }
  if(step===2) {const input=main.getByRole("textbox",{name:"跳转到课件页码",exact:true});await input.fill("15");await input.press("Enter");}
  await main.waitForFunction(page=>{
   const p=app.plugins.plugins["zj-html-studio"].presenter;
   return p.context?.deck.current===page && p.output?.acknowledgedPage===page && p.output.ready && document.querySelector(".html-studio-lecture input")?.value===String(page);
  },page,{timeout:8000});
  const actual=await output.frameLocator(".html-studio-projection-frame").locator(".slide.active").evaluate(active=>Array.from(document.querySelectorAll(".slide")).indexOf(active)+1);
  assert.equal(actual,page);pages.push(page);
 }
 checks.push("Course, local notes and output follow 15 → 16 → 15");
 stage="screenshots";
 if(artifacts){
  // Wait for the author's finite entrance animations before taking visual evidence.
  // The DOM navigation acknowledgement can arrive before any text becomes visible.
  for(const [page,selector,name] of [[main,".html-studio-preview-canvas:not(.html-studio-preview-candidate) .html-studio-iframe:visible","laptop-15.png"],[output,".html-studio-projection-frame","output-15.png"]]) {
   await page.bringToFront();
   const frame=page.frameLocator(selector);
   await frame.locator(".slide.active").evaluate(async slide=>{
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    await Promise.allSettled(slide.getAnimations({subtree:true})
     .filter(animation=>Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)))
     .map(animation=>animation.finished));
   });
   await page.screenshot({path:path.join(artifacts,name),scale:"css"});
  }
 }
 stage="escape";
 await output.bringToFront();await output.keyboard.press("Escape");
 await output.waitForFunction(()=>!document.querySelector(".html-studio-projection")?.classList.contains("is-fullscreen"));
 assert.equal(await main.evaluate(()=>app.plugins.plugins["zj-html-studio"].presenter.context.deck.current),15);
 checks.push("Esc restores the output window without changing the page");
 stage="stop";
 const closed=output.waitForEvent("close");
 await main.evaluate(()=>app.plugins.plugins["zj-html-studio"].presenter.stopProjection());await closed;
 assert.equal(await main.evaluate(()=>app.plugins.plugins["zj-html-studio"].presenter.context.deck.current),15);
 checks.push("Stop closes output and preserves the local page");
 assert.deepEqual(errors,[]);
 result={passed:true,sample:Boolean(sample),expectedPages,automatic,screens,sourceBefore,geometry,pages,checks,errors};
} finally {
 const failure = !result ? await main.evaluate(()=>{
  const p=app.plugins.plugins["zj-html-studio"].presenter;
  return {sourcePage:p.context?.deck.current,desired:p.output?.desiredPage,acknowledged:p.output?.acknowledgedPage,ready:p.output?.ready,notes:document.querySelector(".html-studio-lecture input")?.value};
 }) : undefined;
 if(!geometry && output && !output.isClosed()) geometry=await output.evaluate(()=>({native:window.electronWindow.getBounds()}));
 await main.evaluate(async ({root,original})=>{
  const plug=app.plugins.plugins["zj-html-studio"];plug.presenter.stopProjection();
  app.workspace.getLeavesOfType("html-studio-preview").filter(l=>l.view.file?.path.startsWith(root+"/")).forEach(l=>l.detach());
  const folder=app.vault.getAbstractFileByPath(root);if(folder) await app.vault.delete(folder,true);
  await plug.saveData(original.settings);plug.settings=original.settings;
 },{root,original});
 await main.waitForFunction(count=>app.plugins.plugins["zj-html-studio"].previewServer.activeSessionCount===count,original.sessions);
 if(artifacts) await fs.writeFile(path.join(artifacts,"result.json"),JSON.stringify(result??{passed:false,stage,checks,errors,screens,sourceBefore,geometry,failure},null,2));
 await browser.close();
}
process.stdout.write(JSON.stringify(result)+"\n");
