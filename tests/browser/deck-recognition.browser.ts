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
async function open(html: string, restorePage?: number): Promise<Page> {
  const page = await browser.newPage();
  await page.route("http://deck.test/**", route => route.fulfill({ contentType: "text/html", body: injectSearchBridge(html, "nonce", "channel", true) }));
  await page.setContent(`<script>window.states=[];addEventListener('message',e=>{if(e.data?.type!=='html-studio-search-ready')return;window.port=e.ports[0];port.onmessage=e=>{if(e.data.type.includes('page-state'))states.push(e.data)};port.start();${restorePage ? `port.postMessage({channel:'channel',type:'html-studio-page-state-restore',page:${restorePage},hash:''});` : ''}})</script><iframe style="width:900px;height:650px" src="http://deck.test/a.html"></iframe>`);
  await page.waitForFunction(() => (window as unknown as Harness).states.length > 0);
  return page;
}
const generic = (controls = true) => `<!doctype html><style>body{margin:0}.deck{height:100vh}.screen{display:none;height:90vh}.screen.is-current{display:block}</style><main class="deck">${[1,2,3].map((n,i)=>`<section class="screen${i===0?' is-current':''}" id="${['cover','chapter-zero','ending'][i]}"><h1>Lesson ${n}</h1></section>`).join('')}</main>${controls?'<button id="prev">上一页</button><button id="next">下一页</button>':''}<script>let n=0;window.render=i=>{n=Math.max(0,Math.min(2,i));document.querySelectorAll('.screen').forEach((s,i)=>s.classList.toggle('is-current',i===n))};${controls?"prev.onclick=()=>render(n-1);next.onclick=()=>render(n+1);":""}</script>`;
async function jump(page: Page, n: number): Promise<void> {
  await page.evaluate(n => (window as unknown as Harness).port.postMessage({ channel:"channel",type:"html-studio-deck-go",page:n }),n);
  await page.waitForFunction(n=>(window as unknown as Harness).states.at(-1)?.deck?.current===n,n);
}
describe("general course recognition",()=>{
  it("recognizes arbitrary names and uses original buttons without changing IDs",async()=>{
    const page=await open(generic());
    try {
      expect((await page.evaluate(()=>(window as unknown as Harness).states.at(-1)?.deck))?.pages).toHaveLength(3);
      await jump(page,3);await jump(page,2);
      expect(await page.frameLocator('iframe').locator('.is-current').getAttribute('id')).toBe('chapter-zero');
    }finally{await page.close();}
  });
  it("follows an observable course even when it has no known navigation control",async()=>{
    const page=await open(generic(false));
    try {
      expect(await page.evaluate(()=>(window as unknown as Harness).states.at(-1)?.deck)).toMatchObject({current:1,canNavigate:false});
      await page.frames()[1]!.evaluate(()=>{(window as unknown as {render:(n:number)=>void}).render(2);});
      await page.waitForFunction(()=>(window as unknown as Harness).states.at(-1)?.deck?.current===3);
    }finally{await page.close();}
  });
  it("does not treat a normal article or two independent slide shows as a single deck",async()=>{
    for(const html of ['<main><section><h1>A</h1></section><section><h1>B</h1></section></main>',generic().replace('</main>','</main><div class="deck"><section class="screen is-current">Other</section><section class="screen">Hidden</section></div>')]){
      const page=await open(html);
      try{expect(await page.evaluate(()=>(window as unknown as Harness).states.at(-1)?.deck)).toBeNull();}finally{await page.close();}
    }
  });
  it("recognizes unnamed pages and restores the page without rewriting its URL",async()=>{
    const page=await open(generic().replace(/ id="(cover|chapter-zero|ending)"/g,""));
    try{
      await jump(page,3);
      expect(await page.frames()[1]!.evaluate(()=>location.hash)).toBe("");
      await page.evaluate(()=>(window as unknown as Harness).port.postMessage({channel:"channel",type:"html-studio-page-state-restore",page:2,hash:""}));
      await page.waitForFunction(()=>(window as unknown as Harness).states.at(-1)?.deck?.current===2);
      expect(await page.frames()[1]!.evaluate(()=>location.hash)).toBe("");
    }finally{await page.close();}
  });
  it("cross-checks counters and rejects ordinary full-size tab panels",async()=>{
    for(const html of [generic().replace('</main>','</main><span id="page-counter">1 / 90</span>'),generic(false).replace('class="deck"','class="tabs"').replace('.deck{','.tabs{')]){
      const page=await open(html);
      try{expect(await page.evaluate(()=>(window as unknown as Harness).states.at(-1)?.deck)).toBeNull();}finally{await page.close();}
    }
  });
  it("recognizes a course using only display state, without an active class",async()=>{
    const source=generic(false).replace('.screen.is-current{display:block}','').replace('class="screen is-current"','class="screen" style="display:block"');
    const page=await open(source);
    try{expect(await page.evaluate(()=>(window as unknown as Harness).states.at(-1)?.deck)).toMatchObject({adapter:"dom",current:1,canNavigate:false});}finally{await page.close();}
  });
  it("keeps notes on a confirmed page during a cross-fade and follows the settled page",async()=>{
    const html=generic().replace('.screen{display:none;height:90vh}.screen.is-current{display:block}', '.screen{position:absolute;inset:0;opacity:0;transition:opacity .4s;pointer-events:none}.screen.is-current{opacity:1}');
    const page=await open(html);
    try{
      await page.waitForFunction(()=>(window as unknown as Harness).states.at(-1)?.deck?.current===1);
      await page.frameLocator('iframe').locator('#next').click();
      await page.waitForTimeout(180);
      expect((await page.evaluate(()=>(window as unknown as Harness).states.at(-1)?.deck))?.current).toBe(1);
      await page.waitForFunction(()=>(window as unknown as Harness).states.at(-1)?.deck?.current===2);
    }finally{await page.close();}
  });
  it("waits for asynchronously created pages before confirming a refresh restore",async()=>{
    const [markup,script]=generic().split('<script>');
    const html=`<!doctype html><script>setTimeout(()=>{document.body.insertAdjacentHTML('beforeend',${JSON.stringify(markup!.replace('<!doctype html>',''))});${script!.replace('</script>','')}},600)</script>`;
    const page=await open(html,3);
    try{
      await page.waitForTimeout(150);
      expect(await page.evaluate(()=>(window as unknown as Harness).states.filter(s=>s.type==='html-studio-page-state-restored'))).toHaveLength(0);
      await page.waitForFunction(()=>(window as unknown as Harness).states.some(s=>s.type==='html-studio-page-state-restored'&&s.page===3));
      expect(await page.frameLocator('iframe').locator('.is-current').getAttribute('id')).toBe('ending');
      expect(await page.frames()[1]!.evaluate(()=>location.hash)).toBe('');
    }finally{await page.close();}
  });
  it("does not acknowledge a page that disappeared from the refreshed course",async()=>{
    const page=await open(generic(),4);
    try{
      await page.waitForTimeout(300);
      expect(await page.evaluate(()=>(window as unknown as Harness).states.filter(s=>s.type==='html-studio-page-state-restored'))).toHaveLength(0);
    }finally{await page.close();}
  });
});
