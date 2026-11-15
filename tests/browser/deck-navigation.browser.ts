import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { injectSearchBridge, type SearchBridgeMessage } from "../../src/server/search-bridge";

interface Harness { states: SearchBridgeMessage[]; port: MessagePort }
let browser: Browser;
beforeAll(async () => {
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({ executablePath: process.env.HTML_STUDIO_CHROMIUM_PATH ?? (existsSync(chrome) ? chrome : undefined), headless: true });
});
afterAll(async () => { await browser?.close(); });

function course(numericIds: boolean, delay: number): string {
  return `<!doctype html><style>html,body{margin:0;height:100%;overflow:hidden}.deck{height:100vh}.slide{display:none;height:90vh}.slide.active{display:block}</style>
  <main class="deck">${Array.from({ length: 20 }, (_, i) => `<section class="slide${i === 0 ? " active" : ""}" id="${numericIds ? "p" + String(i + 1).padStart(2, "0") : "chapter-" + i}"><h1>Page ${i + 1}</h1></section>`).join("")}</main>
  <button id="prev">上一页</button><button id="next">下一页</button><script>
  let current=0,busy=false;function show(n){if(busy)return;busy=true;setTimeout(()=>{current=Math.max(0,Math.min(19,n));document.querySelectorAll('.slide').forEach((el,i)=>el.classList.toggle('active',i===current));busy=false},${delay})}
  prev.onclick=()=>show(current-1);next.onclick=()=>show(current+1);
  </script>`;
}

async function open(html: string): Promise<Page> {
  const page = await browser.newPage();
  await page.route("http://navigation.test/**", route => route.fulfill({ contentType: "text/html", body: injectSearchBridge(html, "nonce", "channel", true) }));
  await page.setContent(`<script>window.states=[];addEventListener('message',e=>{if(e.data?.type!=='html-studio-search-ready')return;window.port=e.ports[0];port.onmessage=e=>{if(e.data.type.includes('page-state'))states.push(e.data)};port.start()})</script><iframe style="width:900px;height:650px" src="http://navigation.test/course.html"></iframe>`);
  await page.waitForFunction(() => (window as unknown as Harness).states.at(-1)?.deck?.current === 1);
  return page;
}

describe("course navigation independent of naming and animation speed", () => {
  it("keeps numbered native-control decks on the same controller during cross-fades", async () => {
    const html=course(true,0).replace('.slide{display:none;height:90vh}.slide.active{display:block}',
      '.slide{position:absolute;inset:0;opacity:0;transition:opacity .6s}.slide.active{opacity:1}button{position:relative;z-index:2}');
    const page=await open(html);
    try {
      expect(await page.evaluate(()=>(window as unknown as Harness).states.at(-1)?.deck?.adapter)).toBe('dom');
      await page.waitForTimeout(650);
      await page.evaluate(()=>{(window as unknown as Harness).states=[];});
      await page.frameLocator('iframe').locator('#next').click();
      await page.waitForTimeout(100);
      expect(await page.frameLocator('iframe').locator('.slide').evaluateAll(slides=>slides.filter(slide=>Number(getComputedStyle(slide).opacity)>0).length)).toBe(2);
      await page.evaluate(()=>(window as unknown as Harness).port.postMessage({channel:'channel',type:'html-studio-page-state-request'}));
      await page.waitForFunction(()=>(window as unknown as Harness).states.at(-1)?.deck?.current===2);
      await page.waitForTimeout(450);
      const states=await page.evaluate(()=>(window as unknown as Harness).states.map(s=>s.deck));
      expect(states.every(deck=>deck?.adapter==='dom' && deck.pages[0]?.hash==='#@zj/dom/1')).toBe(true);
    }finally{await page.close();}
  });
  it("uses working native controls when numbered slide IDs do not implement hash navigation", async () => {
    const page = await open(course(true, 0));
    try {
      await page.evaluate(() => (window as unknown as Harness).port.postMessage({ channel: "channel", type: "html-studio-deck-go", page: 3 }));
      await page.waitForFunction(() => (window as unknown as Harness).states.at(-1)?.deck?.current === 3, null, { timeout: 4000 });
      expect(await page.frameLocator("iframe").locator(".active h1").textContent()).toBe("Page 3");
    } finally { await page.close(); }
  });

  it("finishes a distant jump while the author's animated controls keep making progress", async () => {
    const page = await open(course(false, 260));
    try {
      await page.evaluate(() => (window as unknown as Harness).port.postMessage({ channel: "channel", type: "html-studio-deck-go", page: 15 }));
      await page.waitForFunction(() => (window as unknown as Harness).states.at(-1)?.deck?.current === 15, null, { timeout: 7000 });
      expect(await page.frameLocator("iframe").locator(".active h1").textContent()).toBe("Page 15");
    } finally { await page.close(); }
  });
});
