import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { injectSearchBridge, type SearchBridgeMessage } from "../../src/server/search-bridge";

interface Harness {
  states: SearchBridgeMessage[];
  results: SearchBridgeMessage[];
  port: MessagePort;
}

let browser: Browser;
beforeAll(async () => {
  const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({
    executablePath: process.env.HTML_STUDIO_CHROMIUM_PATH ?? (existsSync(systemChrome) ? systemChrome : undefined),
    headless: true
  });
});
afterAll(async () => { await browser?.close(); });

const slides = [1, 2, 3].map(page => `<section class="slide${page === 1 ? " active" : ""}" id="p0${page}"><h1>Slide ${page}</h1></section>`).join("");
const delayedDeck = `<!doctype html><html><body>${slides}<span id="clock"></span><script>
const render=()=>document.querySelectorAll('.slide').forEach((s,i)=>s.classList.toggle('active',i+1===(Number(location.hash.slice(2))||1)));
addEventListener('hashchange',()=>setTimeout(render,150));
</script></body></html>`;
const keyboardDeck = readFileSync(new URL("../fixtures/keyboard-deck.html", import.meta.url), "utf8");
const slidePrefixDeck = readFileSync(new URL("../fixtures/slide-prefix-deck.html", import.meta.url), "utf8");

async function open(source: string): Promise<Page> {
  const page = await browser.newPage();
  await page.route("http://deck.test/**", route => route.fulfill({
    contentType: "text/html",
    body: injectSearchBridge(source, "test-nonce", "test-channel", true)
  }));
  await page.setContent(`<script>
    window.states=[];window.results=[];
    addEventListener('message',e=>{
      if(e.data?.type!=='html-studio-search-ready')return;
      window.port=e.ports[0];
      window.port.onmessage=e=>{if(e.data.type==='html-studio-page-state'||e.data.type==='html-studio-page-state-restored')window.states.push(e.data);if(e.data.type==='html-studio-search-result')window.results.push(e.data);};
      window.port.start();
    });
  </script><iframe src="http://deck.test/lesson.html"></iframe>`);
  return page;
}

async function waitForPage(page: Page, current: number): Promise<void> {
  await page.waitForFunction(current => (window as unknown as Harness).states.at(-1)?.deck?.current === current, current);
}

describe("actual Chromium page bridge", () => {
  it("recognizes 26 slide-prefixed pages, follows author controls, and restores the real page", async () => {
    const page = await open(slidePrefixDeck);
    try {
      await page.waitForFunction(() => (window as unknown as Harness).states.length > 0);
      expect((await page.evaluate(() => (window as unknown as Harness).states.at(-1)?.deck))?.pages).toHaveLength(26);
      for (const current of [15, 16, 15]) {
        await page.evaluate(current => (window as unknown as Harness).port.postMessage({ channel: "test-channel", type: "html-studio-deck-go", page: current }), current);
        await waitForPage(page, current);
        expect(await page.frameLocator("iframe").locator(".slide.active").getAttribute("id")).toBe(`slide-${current}`);
      }
      await page.frameLocator("iframe").locator("#next").click();
      await waitForPage(page, 16);
      await page.evaluate(() => (window as unknown as Harness).port.postMessage({ channel: "test-channel", type: "html-studio-page-state-restore", hash: "#slide-15" }));
      await page.waitForFunction(() => (window as unknown as Harness).states.some(s => s.type === "html-studio-page-state-restored" && s.deck?.current === 15));
    } finally { await page.close(); }
  });

  it("searches hidden slide-prefixed pages, retaining their inert navigation state", async () => {
    const page = await open(slidePrefixDeck);
    try {
      await page.waitForFunction(() => (window as unknown as Harness).states.length > 0);
      expect((await page.evaluate(() => (window as unknown as Harness).states.at(-1)?.deck))?.pages).toHaveLength(26);
      for (const [requestId, direction, current] of [[1, "current", 15], [2, "next", 16], [3, "previous", 15]] as const) {
        await page.evaluate(({ requestId, direction }) => (window as unknown as Harness).port.postMessage({ channel: "test-channel", type: "html-studio-search", query: "Shared", requestId, direction }), { requestId, direction });
        await page.waitForFunction(id => (window as unknown as Harness).results.some(result => result.requestId === id), requestId);
        expect(await page.evaluate(() => (window as unknown as Harness).results.at(-1))).toMatchObject({ found: true, matchPages: [15, 16], page: current });
        await waitForPage(page, current);
      }
      expect(await page.frameLocator("iframe").locator(".slide[inert]").count()).toBe(25);
    } finally { await page.close(); }
  });

  it("does not combine mixed slide identifiers or infer missing or duplicate active pages", async () => {
    for (const change of [
      "document.querySelector('#slide-02').id='p02'",
      "document.querySelector('#slide-02').id='slide-03'",
      "document.querySelector('#slide-02').remove()",
      "document.querySelector('#slide-02').classList.add('active')"
    ]) {
      const page = await open(slidePrefixDeck.replace("})();", `${change};})();`));
      try {
        await page.waitForFunction(() => (window as unknown as Harness).states.length > 0);
        expect(await page.evaluate(() => (window as unknown as Harness).states.at(-1)?.deck)).toBeNull();
      } finally { await page.close(); }
    }
  });

  it("restores numeric pages through the controller and lets the latest rapid jump win", async () => {
    const page = await open(keyboardDeck);
    try {
      await waitForPage(page, 1);
      await page.evaluate(() => (window as unknown as Harness).port.postMessage({
        channel: "test-channel", type: "html-studio-page-state-restore", hash: "#15"
      }));
      await page.waitForFunction(() => (window as unknown as Harness).states.some(s => s.type === "html-studio-page-state-restored" && s.deck?.current === 15));
      await page.evaluate(() => {
        for (const current of [35, 10, 42, 16]) (window as unknown as Harness).port.postMessage({ channel: "test-channel", type: "html-studio-deck-go", page: current });
      });
      await waitForPage(page, 16);
      await page.waitForTimeout(300);
      expect(await page.frameLocator("iframe").locator("#curno").textContent()).toBe("16");
    } finally { await page.close(); }
  });

  it("does not manufacture page changes when the author ignores keyboard commands", async () => {
    const page = await open(keyboardDeck.replace("document.addEventListener('keydown',e=>{", "document.addEventListener('unused',e=>{"));
    try {
      await waitForPage(page, 1);
      await page.evaluate(() => (window as unknown as Harness).port.postMessage({ channel: "test-channel", type: "html-studio-deck-go", page: 15 }));
      await page.waitForTimeout(400);
      expect(await page.evaluate(() => (window as unknown as Harness).states.at(-1)?.deck?.current)).toBe(1);
      expect(await page.frameLocator("iframe").locator(".slide.active h1").textContent()).toBe("Slide 1");
    } finally { await page.close(); }
  });

  it("uses the structural adapter when a keyboard course lacks the legacy counter or fixed-canvas names", async () => {
    for (const source of [keyboardDeck.replace('id="totno"', 'id="other"'), keyboardDeck.replace('id="viewport"', 'id="other"')]) {
      const page = await open(source);
      try {
        await page.frameLocator("iframe").locator(".slide.active").waitFor();
        await page.waitForFunction(() => (window as unknown as Harness).states.length > 0);
        expect(await page.evaluate(() => (window as unknown as Harness).states.at(-1)?.deck)).toMatchObject({ adapter: "dom", current: 1 });
      } finally { await page.close(); }
    }
  });

  it("searches large media courses without counting embedded script data as readable text", async () => {
    const page = await open(keyboardDeck + `<script type="application/json">${JSON.stringify("x".repeat(5 * 1024 * 1024))}</script>`);
    try {
      await waitForPage(page, 1);
      await page.evaluate(() => (window as unknown as Harness).port.postMessage({ channel: "test-channel", type: "html-studio-search", query: "Shared", requestId: 1 }));
      await page.waitForFunction(() => (window as unknown as Harness).results.length > 0);
      expect(await page.evaluate(() => (window as unknown as Harness).results.at(-1))).toMatchObject({ found: true, matchPages: [15, 16], page: 15 });
      await page.evaluate(() => (window as unknown as Harness).port.postMessage({ channel: "test-channel", type: "html-studio-deck-go", page: 15 }));
      await waitForPage(page, 15);
    } finally { await page.close(); }
  });

  it("finds hidden numeric slides and visits each matching page using author navigation", async () => {
    const page = await open(keyboardDeck);
    try {
      await waitForPage(page, 1);
      for (const [requestId, direction, current] of [[1, "current", 15], [2, "next", 16], [3, "previous", 15]] as const) {
        await page.evaluate(({ requestId, direction }) => (window as unknown as Harness).port.postMessage({ channel: "test-channel", type: "html-studio-search", query: "Shared", requestId, direction }), { requestId, direction });
        await page.waitForFunction(id => (window as unknown as Harness).results.some(result => result.requestId === id), requestId);
        expect(await page.evaluate(() => (window as unknown as Harness).results.at(-1))).toMatchObject({ found: true, matchPages: [15, 16], page: current });
        await waitForPage(page, current);
      }
    } finally { await page.close(); }
  });
  it("recognizes all 42 unnumbered slides and navigates through the author's keyboard controller", async () => {
    const page = await open(keyboardDeck);
    try {
      await waitForPage(page, 1);
      const state = await page.evaluate(() => (window as unknown as Harness).states.at(-1)?.deck);
      expect(state?.pages).toHaveLength(42);
      expect(state?.pages[14]).toEqual({ hash: "#15", title: "Slide 15" });
      for (const current of [15, 16, 15, 42, 1]) {
        await page.evaluate(current => (window as unknown as Harness).port.postMessage({
          channel: "test-channel", type: "html-studio-deck-go", page: current
        }), current);
        await waitForPage(page, current);
        expect(await page.frameLocator("iframe").locator(".slide.active h1").textContent()).toBe(`Slide ${current}`);
      }
      await page.frameLocator("iframe").locator("#next").click();
      await waitForPage(page, 2);
      expect(await page.frameLocator("iframe").locator(".slide[id]").count()).toBe(0);
    } finally { await page.close(); }
  });
  it("reports the rendered page after delayed navigation and controller jumps", async () => {
    const page = await open(delayedDeck);
    try {
      await waitForPage(page, 1);
      await page.frames()[1]!.evaluate(() => { location.hash = "p02"; });
      await waitForPage(page, 2);
      for (const current of [3, 1]) {
        await page.evaluate(current => (window as unknown as Harness).port.postMessage({
          channel: "test-channel", type: "html-studio-deck-go", page: current
        }), current);
        await waitForPage(page, current);
        expect(await page.frameLocator("iframe").locator(".slide.active").getAttribute("id")).toBe(`p0${current}`);
      }
      expect(await page.evaluate(() => (window as unknown as Harness).states.at(-1)?.documentRevision))
        .toBe(createHash("sha256").update(delayedDeck).digest("hex"));
    } finally { await page.close(); }
  });

  it("discovers slides generated after load and follows active classes without a hash event", async () => {
    const page = await open("<!doctype html><html><body><main></main></body></html>");
    try {
      await page.waitForFunction(() => (window as unknown as Harness).states.length > 0);
      await page.frames()[1]!.evaluate(() => {
        for (const page of [1, 2, 3]) {
          const slide = document.createElement("section");
          slide.id = `p0${page}`;
          slide.className = page === 1 ? "slide active" : "slide";
          const heading = document.createElement("h1");
          heading.textContent = `Slide ${page}`;
          slide.append(heading);
          document.querySelector("main")!.append(slide);
        }
      });
      await waitForPage(page, 1);
      await page.frames()[1]!.evaluate(() => {
        document.querySelector("#p01")!.classList.remove("active");
        document.querySelector("#p03")!.classList.add("active");
      });
      await waitForPage(page, 3);
    } finally { await page.close(); }
  });

  it("coalesces unrelated DOM changes without repeatedly publishing the same deck", async () => {
    const page = await open(delayedDeck);
    try {
      await waitForPage(page, 1);
      await page.waitForTimeout(200);
      const before = await page.evaluate(() => (window as unknown as Harness).states.length);
      await page.frames()[1]!.evaluate(() => {
        for (let i = 0; i < 1000; i++) document.querySelector("#clock")!.textContent = String(i);
      });
      await page.waitForTimeout(250);
      expect(await page.evaluate(() => (window as unknown as Harness).states.length)).toBe(before);
    } finally { await page.close(); }
  });

  it("restores the slide hash through the live port without reloading the iframe", async () => {
    const page = await open(delayedDeck);
    try {
      await waitForPage(page, 1);
      await page.evaluate(() => (window as unknown as Harness).port.postMessage({
        channel: "test-channel", type: "html-studio-page-state-restore", hash: "#p03", scrollX: 0, scrollY: 0
      }));
      await waitForPage(page, 3);
      await page.evaluate(() => (window as unknown as Harness).port.postMessage({
        channel: "test-channel", type: "html-studio-deck-go", page: 2
      }));
      await waitForPage(page, 2);
    } finally { await page.close(); }
  });
});
