import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { injectSearchBridge, type SearchBridgeMessage } from "../../src/server/search-bridge";
interface Harness { states: SearchBridgeMessage[]; port: MessagePort }
// Optional integration suite uses exact upstream distributions, without bundling
// framework code in the plugin or downloading anything during a normal test run.
const assets = process.env.HTML_STUDIO_FRAMEWORK_ASSETS;
let browser: Browser;
beforeAll(async () => {
  if (!assets) return;
  const chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser=await chromium.launch({executablePath:process.env.HTML_STUDIO_CHROMIUM_PATH??(existsSync(chrome)?chrome:undefined),headless:true});
});
afterAll(async()=>{await browser?.close();});
describe.skipIf(!assets)("actual upstream course frameworks",()=>{
  it.each(["", "html{overflow:hidden}body{height:100vh;overflow:auto}", "html,body{height:100%;overflow:hidden}.article-shell{height:100vh;overflow:auto}"])("does not turn an article with a large photo carousel into a course: %s",async rootStyle=>{
    const page=await browser.newPage();
    const js=readFileSync(path.join(assets!,"swiper/swiper-bundle.min.js"),"utf8");
    const css=readFileSync(path.join(assets!,"swiper/swiper-bundle.min.css"),"utf8");
    const html=`<!doctype html><meta charset="utf-8"><style>${css}body{margin:0}.swiper{width:100%;height:50vh}article{height:1400px}${rootStyle}</style><div class="article-shell"><div class="swiper"><div class="swiper-wrapper"><div class="swiper-slide">Photo one</div><div class="swiper-slide">Photo two</div></div></div><article><h1>Long article</h1><p>Independent reading content below the photographs.</p></article></div><script>${js}</script><script>new Swiper('.swiper',{speed:0})</script>`;
    await page.route('http://framework.test/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:injectSearchBridge(html,'nonce','channel',true)}));
    await page.setContent(`<script>window.states=[];addEventListener('message',e=>{if(e.data?.type!=='html-studio-search-ready')return;window.port=e.ports[0];port.onmessage=e=>{if(e.data.type==='html-studio-page-state')states.push(e.data)};port.start()})</script><iframe style="width:1000px;height:700px" src="http://framework.test/article.html"></iframe>`);
    try{
      await page.waitForFunction(()=>(window as unknown as Harness).states.length>0);
      await page.waitForTimeout(150);
      expect(await page.evaluate(()=>(window as unknown as Harness).states.at(-1)?.deck)).toBeNull();
    }finally{await page.close();}
  });
  for(const framework of ["reveal","swiper","swiper-virtual"]){
    it(`${framework}: follows native changes and jumps without counting fragments or loop copies`,async()=>{
      const page=await browser.newPage();page.setDefaultTimeout(5_000);
      const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
      const reveal=framework==="reveal";
      const js=readFileSync(path.join(assets!,reveal?"reveal/dist/reveal.js":"swiper/swiper-bundle.min.js"),"utf8");
      const css=readFileSync(path.join(assets!,reveal?"reveal/dist/reveal.css":"swiper/swiper-bundle.min.css"),"utf8");
      const body=reveal?'<div class="reveal"><div class="slides"><section><h1>First</h1><p class="fragment">Animation</p></section><section><section><h1>Second</h1></section><section><h1>Third</h1></section></section></div></div>':'<div class="swiper"><div class="swiper-wrapper">'+(framework==="swiper"?[1,2,3,4,5,6].map(n=>`<div class="swiper-slide"><h1>Page ${n}</h1></div>`).join(""):"")+'</div></div>';
      const init=reveal?'Reveal.initialize({embedded:true,transition:"none",controls:false});':framework==="swiper"?'window.course=new Swiper(".swiper",{loop:true,speed:0});':'window.course=new Swiper(".swiper",{speed:0,virtual:{enabled:true,slides:Array.from({length:20},(_,i)=>"<h1>Page "+(i+1)+"</h1>")}});';
      const html=`<!doctype html><html><head><meta charset="utf-8"><style>${css}html,body,.swiper{height:100%;width:100%;margin:0}</style></head><body>${body}<script>${js}</script><script>${init}</script></body></html>`;
      await page.route("http://framework.test/**",route=>route.fulfill({contentType:"text/html; charset=utf-8",body:injectSearchBridge(html,"nonce","channel",true)}));
      await page.setContent(`<script>window.states=[];addEventListener('message',e=>{if(e.data?.type!=='html-studio-search-ready')return;window.port=e.ports[0];port.onmessage=e=>{if(e.data.type==='html-studio-page-state')states.push(e.data)};port.start()})</script><iframe style="width:1000px;height:700px" src="http://framework.test/a.html"></iframe>`);
      try {
        await page.waitForFunction(()=>(window as unknown as Harness).states.at(-1)?.deck?.current===1);
        expect((await page.evaluate(()=>(window as unknown as Harness).states.at(-1)?.deck))?.pages).toHaveLength(reveal?3:framework==="swiper"?6:20);
        for(const current of [3,2,1]){
          await page.evaluate(current=>(window as unknown as Harness).port.postMessage({channel:"channel",type:"html-studio-deck-go",page:current}),current);
          await page.waitForFunction(current=>(window as unknown as Harness).states.at(-1)?.deck?.current===current,current);
        }
        expect(errors).toEqual([]);
      }catch(error){
        process.stderr.write(JSON.stringify(await page.evaluate(()=>(window as unknown as Harness).states.slice(-5)))+"\n");
        process.stderr.write(JSON.stringify(await page.frames()[1]!.evaluate(()=>{const s=(window as unknown as {course?:{slides:Element[];params:unknown;realIndex:number;virtual:unknown}}).course;return {slides:Array.from(s?.slides??[]).map(e=>({id:e.getAttribute("data-swiper-slide-index"),cls:e.className})),realIndex:s?.realIndex,virtualCount:(s?.virtual as {slides?:unknown[]})?.slides?.length,paramsVirtual:(s?.params as {virtual?:unknown})?.virtual};}))+"\n");
        throw error;
      }finally{await page.close();}
    });
  }
});
