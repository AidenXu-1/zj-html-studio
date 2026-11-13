import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { injectSearchBridge, type SearchBridgeMessage } from "../../src/server/search-bridge";

interface Harness { results: SearchBridgeMessage[]; port: MessagePort }
let browser: Browser;
beforeAll(async () => {
  const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({ executablePath: process.env.HTML_STUDIO_CHROMIUM_PATH
    ?? (existsSync(systemChrome) ? systemChrome : undefined), headless: true });
});
afterAll(async () => { await browser?.close(); });

async function open(body: string, dynamic = true): Promise<Page> {
  const page = await browser.newPage();
  await page.route("http://search.test/**", route => route.fulfill({ contentType: "text/html",
    body: injectSearchBridge(`<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`, "test-nonce", "test-channel", dynamic) }));
  await page.setContent(`<input id="query" aria-label="Search"><script>
    window.results=[];
    addEventListener('message',event=>{
      if(event.data?.type!=='html-studio-search-ready')return;
      window.port=event.ports[0];
      window.port.onmessage=event=>{if(event.data.type==='html-studio-search-result')window.results.push(event.data);};
      window.port.start();
    });
  </script><iframe style="width:800px;height:600px" src="http://search.test/document.html"></iframe>`);
  await page.frameLocator("iframe").locator("body").waitFor();
  await page.waitForFunction(() => Boolean((window as unknown as Harness).port));
  await page.locator("#query").focus();
  return page;
}

async function search(page: Page, query: string, direction = "current", targetPage?: number): Promise<SearchBridgeMessage> {
  const requestId = await page.evaluate(({ query, direction, targetPage }) => {
    const harness = window as unknown as Harness;
    const requestId = (harness.results.at(-1)?.requestId ?? 0) + 1;
    harness.port.postMessage({ channel: "test-channel", type: "html-studio-search", requestId, query, direction, targetPage });
    return requestId;
  }, { query, direction, targetPage });
  await page.waitForFunction(id => (window as unknown as Harness).results.some(result => result.requestId === id), requestId);
  return page.evaluate(() => (window as unknown as Harness).results.at(-1)!);
}

const textPage = '<p id="first">个人<strong>知识</strong>库</p><p id="second">知识库</p><span id="clock">00:00</span>';
describe("page search in actual Chromium", () => {
  it("searches a long readable document while ignoring large script and style bodies", async () => {
    const content = "<p>" + "readable words ".repeat(90_000) + "</p><p>Unique target</p>";
    const page = await open(`<script type="application/json">${JSON.stringify("x".repeat(5 * 1024 * 1024))}</script><style>/*${"x".repeat(600_000)}*/</style>${content}`);
    try {
      expect(await search(page, "Unique target")).toMatchObject({ found: true, total: 1 });
      expect(await search(page, "absent value")).toMatchObject({ found: false, total: 0 });
    } finally { await page.close(); }
  });

  it("bounds frequent-word results in a long paragraph and accepts a following query", async () => {
    const page = await open(`<p>${"needle ".repeat(150_000)}</p><p>Last target</p>`);
    try {
      expect(await search(page, "needle")).toMatchObject({ found: true, total: 5_000, truncatedReason: "matches" });
      expect(await search(page, "Last target")).toMatchObject({ found: true, total: 1 });
    } finally { await page.close(); }
  });

  it("does not report a complete no-match when readable content exceeds the work budget", async () => {
    const page = await open(`<p>${"x".repeat(2 * 1024 * 1024 + 1)}</p><p>Unique target</p>`);
    try {
      expect(await search(page, "Unique target")).toMatchObject({ found: false, countComplete: false, searchLimited: true, searchInvalidated: true });
    } finally { await page.close(); }
  });

  it("finds Chinese across inline elements and wraps next and previous without stealing input focus", async () => {
    const page = await open(textPage);
    try {
      for (const [direction, current] of [["current", 1], ["next", 2], ["next", 1], ["previous", 2]] as const) {
        expect(await search(page, "知识库", direction)).toMatchObject({ found: true, current, total: 2 });
        expect(await page.locator("#query").evaluate(element => element === document.activeElement)).toBe(true);
      }
    } finally { await page.close(); }
  });

  it("paints the match even when the document disables text selection", async () => {
    const page = await open(`<style>body{user-select:none;background:#111;color:#fff;font:32px system-ui}</style>${textPage}`);
    try {
      expect(await search(page, "知识库")).toMatchObject({ found: true, total: 2 });
      const painted = await page.frameLocator("iframe").locator("body").evaluate(() => {
        const painted: string[] = [];
        CSS.highlights.forEach((highlight, name) => {
          const background = getComputedStyle(document.body, `::highlight(${name})`).backgroundColor;
          if (background !== "rgba(0, 0, 0, 0)") highlight.forEach(range => {
            if (range instanceof Range) painted.push(range.toString());
          });
        });
        return painted;
      });
      expect(painted).toContain("知识库");
      await search(page, "");
      expect(await page.frameLocator("iframe").locator("body").evaluate(() => CSS.highlights.size)).toBe(0);
    } finally { await page.close(); }
  });

  it("continues to the next result after an unrelated counter changes", async () => {
    const page = await open(textPage);
    try {
      expect(await search(page, "知识库")).toMatchObject({ current: 1, total: 2 });
      await page.frameLocator("iframe").locator("#clock").evaluate(element => { element.textContent = "00:01"; });
      expect(await search(page, "知识库", "next")).toMatchObject({ found: true, current: 2, total: 2 });
    } finally { await page.close(); }
  });

  it("ignores hidden text and gives a clean empty result when cleared or unmatched", async () => {
    const page = await open(`${textPage}<div hidden>知识库</div><div aria-hidden="true">知识库</div><p style="display:none">知识库</p>`);
    try {
      expect(await search(page, "知识库")).toMatchObject({ found: true, total: 2 });
      expect(await search(page, "未出现的词")).toMatchObject({ found: false, total: 0 });
      expect(await search(page, "")).toMatchObject({ found: false, current: 0, total: 0, countComplete: true });
    } finally { await page.close(); }
  });

  it("finds visible text inside a display:contents wrapper", async () => {
    const page = await open('<p>个人<span style="display:contents">知识库</span></p>');
    try {
      expect(await search(page, "知识库")).toMatchObject({ found: true, total: 1 });
    } finally { await page.close(); }
  });

  it("scrolls the actual match into view inside a long paragraph", async () => {
    const page = await open(`<p style="width:100px;line-height:24px">${"普通文字 ".repeat(500)}最终命中词</p>`);
    try {
      expect(await search(page, "最终命中词")).toMatchObject({ found: true });
      const rect = await page.frameLocator("iframe").locator("body").evaluate(() => {
        const rect = getSelection()!.getRangeAt(0).getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: innerHeight };
      });
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.bottom).toBeLessThanOrEqual(rect.height);
    } finally { await page.close(); }
  });

  it("updates after content is removed and clears the old highlight", async () => {
    const page = await open(textPage);
    try {
      await search(page, "知识库");
      await page.frameLocator("iframe").locator("body").evaluate(() => {
        document.querySelector("#first")!.remove(); document.querySelector("#second")!.remove();
      });
      await page.waitForFunction(() => (window as unknown as Harness).results.at(-1)?.total === 0);
      expect(await page.frameLocator("iframe").locator("body").evaluate(() => CSS.highlights.size)).toBe(0);
    } finally { await page.close(); }
  });

  it("treats punctuation as literal text and accepts emoji queries", async () => {
    const page = await open('<p>价格 (A+B)? 🧠 知识库</p><p>价格 AAAB</p>');
    try {
      expect(await search(page, "(A+B)?")).toMatchObject({ found: true, total: 1 });
      expect(await search(page, "🧠")).toMatchObject({ found: true, total: 1 });
    } finally { await page.close(); }
  });

  it("retains native search for safe static HTML", async () => {
    const page = await open(textPage, false);
    try {
      expect(await search(page, "知识库")).toMatchObject({ found: true });
      expect(await page.frameLocator("iframe").locator("body").evaluate(() => getSelection()?.toString())).toBe("知识库");
      expect(await search(page, "未出现的词")).toMatchObject({ found: false });
    } finally { await page.close(); }
  });

  it("finds content on another slide and follows the deck's navigation rather than revealing hidden slides", async () => {
    const page = await open(`<style>.slide{display:none}.slide.active{display:block}</style>
      <section id="p01" class="slide active"><h1>第一页</h1><p>这里介绍课程</p></section>
      <section id="p02" class="slide"><h1>第二页</h1><p>知识库能保留业务背景</p></section>
      <section id="p03" class="slide"><h1>第三页</h1><p>知识库帮助复用经验</p></section>
      <script>addEventListener('hashchange',()=>setTimeout(()=>document.querySelectorAll('.slide').forEach(s=>s.classList.toggle('active','#'+s.id===location.hash)),150))</script>`);
    try {
      expect(await search(page, "知识库")).toMatchObject({ found: true, total: 2, current: 1 });
      expect(await page.frameLocator("iframe").locator(".slide.active").getAttribute("id")).toBe("p02");
      expect(await search(page, "知识库", "next")).toMatchObject({ found: true, current: 2 });
      expect(await page.frameLocator("iframe").locator(".slide.active").getAttribute("id")).toBe("p03");
      expect(await search(page, "知识库", "previous")).toMatchObject({ found: true, current: 1 });
      expect(await page.frameLocator("iframe").locator(".slide.active").getAttribute("id")).toBe("p02");
      // A manual page change while search is open must not be pulled back by a
      // queued result refresh. The next deliberate search can navigate again.
      await page.frameLocator("iframe").locator("body").evaluate(() => { location.hash = "p01"; });
      await page.waitForTimeout(550);
      expect(await page.frameLocator("iframe").locator(".slide.active").getAttribute("id")).toBe("p01");
      expect(await search(page, "知识库", "next")).toMatchObject({ found: true, current: 1 });
      expect(await page.frameLocator("iframe").locator(".slide.active").getAttribute("id")).toBe("p02");
    } finally { await page.close(); }
  });

  it("groups repeated matches by slide and accepts direct page selection", async () => {
    const page = await open(`<style>.slide{display:none}.slide.active{display:block}</style>
      <section id="p01" class="slide active"><h1>知识库</h1><p>知识库</p></section>
      <section id="p02" class="slide"><h1>空白</h1></section>
      <section id="p03" class="slide"><h1>知识库</h1><p>知识库</p></section>
      <script>addEventListener('hashchange',()=>document.querySelectorAll('.slide').forEach(s=>s.classList.toggle('active','#'+s.id===location.hash)))</script>`);
    try {
      expect(await search(page, "知识库")).toMatchObject({ matchPages: [1, 3], page: 1, total: 4 });
      expect(await search(page, "知识库", "next")).toMatchObject({ matchPages: [1, 3], page: 3 });
      expect(await search(page, "知识库", "next")).toMatchObject({ page: 1 });
      expect(await search(page, "知识库", "current", 3)).toMatchObject({ page: 3 });
      expect(await page.frameLocator("iframe").locator("body").evaluate(() => {
        let count = 0; CSS.highlights.forEach(highlight => count += highlight.size); return count;
      })).toBe(2);
      expect(await search(page, "知识库", "previous")).toMatchObject({ page: 1 });
    } finally { await page.close(); }
  });
});
