import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { HtmlPreviewView } from "../../src/view/html-preview-view";
import { unobscuredCourseRect } from "../../src/presentation/picture-projection";
import { FIXED_CANVAS_HTML } from "../fixtures/fixed-canvas";

vi.mock("obsidian", () => ({ TFile: class {}, FileView: class {}, Modal: class {}, Notice: class {} }));
vi.mock("electron", () => ({ shell: {} }));

const styles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
// Serialize the actual method; the browser invokes it with an explicit zoom receiver.
// eslint-disable-next-line @typescript-eslint/unbound-method -- Serialized, then called with an explicit zoom receiver in Chromium.
const apply = (HtmlPreviewView.prototype as unknown as { applyZoomToIframe(frame: HTMLIFrameElement): void }).applyZoomToIframe;
let browser: Browser;
const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.HTML_STUDIO_CHROMIUM_PATH
  ?? (existsSync(systemChrome) ? systemChrome : undefined), headless: true }); });
afterAll(async () => { await browser?.close(); });

async function mount(html: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await page.setContent(`<style>${styles}body{margin:0}#host{width:800px;height:500px;padding:0}
    #host.narrow{width:400px;height:300px}#host.offset{margin:50px 0 0 100px}
    .private-notes{position:absolute;left:900px;top:50px;width:300px;height:500px}
    .private-overlay{position:fixed;left:150px;top:100px;width:30px;height:20px;pointer-events:none}</style>
    <div id="host" class="html-studio-iframe-host"><div class="html-studio-preview-canvas"><iframe class="html-studio-iframe"></iframe></div></div>`);
  await page.addScriptTag({ content: `HTMLElement.prototype.setCssStyles=function(styles){Object.assign(this.style,styles)};
    HTMLElement.prototype.setCssProps=function(styles){for(const [key,value] of Object.entries(styles))this.style.setProperty(key,value)};
    HTMLElement.prototype.createDiv=function(options){const el=document.createElement('div');el.className=options.cls;this.append(el);return el};
    window.zoomFrame=function(value){(${apply.toString().replace(/^applyZoomToIframe\(/, "function(")}).call({zoom:value},document.querySelector('iframe'))}` });
  await page.addScriptTag({ content: `window.courseRect=()=>(${unobscuredCourseRect.toString()})(document.querySelector('iframe'))` });
  await page.locator("iframe").evaluate((frame, content) => { (frame as HTMLIFrameElement).srcdoc = content; }, html);
  await page.locator("iframe").contentFrame().locator("body").waitFor();
  return page;
}
async function zoom(page: Page, value: number): Promise<void> {
  await page.evaluate(value => (window as unknown as { zoomFrame(value: number): void }).zoomFrame(value), value);
}

describe("whole-page preview zoom", () => {
  for (const kind of ["responsive canvas", "ordinary document"]) {
    it(`${kind}: scales real pixels without changing the page's layout width`, async () => {
      const html = kind === "responsive canvas" ? FIXED_CANVAS_HTML.replace("#stage{", "#stage{flex-shrink:0;")
        : '<style>body{margin:0}h1{font:40px sans-serif;width:600px;margin:30px}p{width:700px}</style><h1>Readable heading</h1><p>Ordinary document content</p>';
      const page = await mount(html);
      try {
        const frame = page.locator("iframe").contentFrame();
        await zoom(page, 100);
        const selector = kind === "responsive canvas" ? "#stage" : "h1";
        const baseline = await frame.locator(selector).evaluate(el => el.getBoundingClientRect().width);
        for (const value of [200, 50, 125, 100]) {
          await zoom(page, value);
          await expect.poll(() => frame.locator("body").evaluate(() => innerWidth)).toBe(800);
          const geometry = await frame.locator(selector).evaluate(el => el.getBoundingClientRect().width);
          const iframe = await page.locator("iframe").boundingBox();
          const realWidth = geometry * iframe!.width / 800;
          expect(realWidth).toBeCloseTo(baseline * value / 100, 1);
          expect(iframe!.width).toBeCloseTo(800 * value / 100, 1);
          expect(iframe!.height).toBeCloseTo(500 * value / 100, 1);
          if (value === 50) {
            expect(iframe!.x).toBeCloseTo(200, 1); expect(iframe!.y).toBeCloseTo(125, 1);
            expect(await page.locator(".html-studio-preview-canvas").evaluate(el => [el.scrollWidth, el.scrollHeight])).toEqual([800, 500]);
          }
        }
        await page.locator("#host").evaluate(el => { el.classList.add("narrow"); });
        await expect.poll(() => frame.locator("body").evaluate(() => [innerWidth, innerHeight])).toEqual([400, 300]);
      } finally { await page.close(); }
    });
  }

  it("makes the enlarged right and bottom edges reachable and returns to a complete page at 100%", async () => {
    const page = await mount("<style>body{margin:0;height:100vh;background:white}</style><p>Course</p>");
    try {
      await zoom(page, 200);
      const canvas = page.locator(".html-studio-preview-canvas");
      expect(await canvas.evaluate(el => [el.scrollWidth, el.scrollHeight])).toEqual([1600, 1000]);
      await canvas.evaluate(el => { el.scrollLeft = 10000; el.scrollTop = 10000; });
      const rect = await page.locator("iframe").boundingBox();
      expect(rect!.x + rect!.width).toBeCloseTo(800, 1);
      expect(rect!.y + rect!.height).toBeCloseTo(500, 1);
      await zoom(page, 100);
      expect(await canvas.evaluate(el => [el.scrollLeft, el.scrollTop, el.scrollWidth, el.scrollHeight])).toEqual([0, 0, 800, 500]);
    } finally { await page.close(); }
  });

  it("projects only the visible course when zoomed and panned, and still refuses host overlays", async () => {
    const page = await mount("<p>Course</p>");
    const capture = () => page.evaluate(() => (window as unknown as { courseRect(): unknown }).courseRect());
    try {
      await page.locator("#host").evaluate(el => { el.classList.add("offset"); });
      await page.evaluate(() => {
        const aside = document.createElement("aside"); aside.textContent = "Private notes";
        aside.className = "private-notes"; document.body.append(aside);
      });
      for (const value of [100, 200, 125]) {
        await zoom(page, value);
        expect(await capture()).toEqual({ x: 100, y: 50, width: 800, height: 500 });
      }
      await page.locator(".html-studio-preview-canvas").evaluate(el => { el.scrollLeft = 150; el.scrollTop = 80; });
      expect(await capture()).toEqual({ x: 100, y: 50, width: 800, height: 500 });
      await page.evaluate(() => {
        const overlay = document.createElement("div"); overlay.id = "overlay"; overlay.textContent = "Private popup";
        overlay.className = "private-overlay"; document.body.append(overlay);
      });
      expect(await capture()).toBeNull();
      await page.locator("#overlay").evaluate(el => el.remove());
      await zoom(page, 50);
      expect(await capture()).toEqual({ x: 300, y: 175, width: 400, height: 250 });
    } finally { await page.close(); }
  });

  // Real fullscreen/Escape and restoration of zoom/pan are exercised in the
  // marked Obsidian runtime; macOS headless Chromium rejects fullscreen here.
});
