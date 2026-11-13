import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { PreviewServer } from "../../src/server/preview-server";
import { FIXED_CANVAS_HTML } from "../fixtures/fixed-canvas";

let browser: Browser;
let server: PreviewServer;
let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.resolve("tests/fixtures/.fixed-canvas-"));
  await writeFile(path.join(root, "small.html"), FIXED_CANVAS_HTML);
  // Exercise the no-search-bridge response path, like a deck with embedded fonts.
  await writeFile(path.join(root, "large.html"), FIXED_CANVAS_HTML + `<!--${"x".repeat(5 * 1024 * 1024)}-->`);
  await writeFile(path.join(root, "authored.html"), FIXED_CANVAS_HTML.replace("#stage{", "#stage{flex-shrink:1;"));
  server = new PreviewServer(root);
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({ executablePath: process.env.HTML_STUDIO_CHROMIUM_PATH
    ?? (existsSync(chrome) ? chrome : undefined), headless: true });
});
afterAll(async () => {
  await browser?.close(); await server?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("fixed presentation canvas in Chromium", () => {
  it("respects explicit flex sizing written by the document author", async () => {
    const session = await server.createSession({ entryRelativePath: "authored.html", scopeRelativePath: "", mode: "interactive" });
    const page = await browser.newPage({ viewport: { width: 904, height: 829 } });
    try {
      await page.goto(session.entryUrl);
      expect(await page.locator("#stage").evaluate(stage => stage.clientWidth)).toBe(904);
    } finally { await page.close(); await server.revokeSession(session.token); }
  });
  for (const name of ["small.html", "large.html"]) it(`fits ${name} as one unchanged canvas across sidebar/window sizes`, async () => {
    const session = await server.createSession({ entryRelativePath: name, scopeRelativePath: "", mode: "interactive", enableSearchBridge: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    try {
      await page.goto(session.entryUrl);
      for (const [width, height] of [[1638, 829], [904, 829], [620, 520], [1024, 350], [320, 500]]) {
        await page.setViewportSize({ width: width!, height: height! });
        await page.waitForFunction(() => {
          const stage = document.getElementById("stage")!;
          const scale = new DOMMatrixReadOnly(getComputedStyle(stage).transform).a;
          return Math.abs(scale - Math.min(innerWidth / 1280, innerHeight / 720, 1)) < 0.00001;
        });
        const geometry = await page.locator("#stage").evaluate(stage => {
          const canvas = stage.getBoundingClientRect(), title = stage.querySelector(".title")!.getBoundingClientRect();
          const circle = stage.querySelector(".circle")!.getBoundingClientRect();
          return { width: stage.clientWidth, height: stage.clientHeight, ratio: canvas.width / canvas.height,
            left: canvas.left, top: canvas.top, right: canvas.right, bottom: canvas.bottom,
            titleWidth: title.width / canvas.width, titleLeft: (title.left - canvas.left) / canvas.width,
            circleRatio: circle.width / circle.height };
        });
        expect(geometry.width).toBe(1280); expect(geometry.height).toBe(720);
        expect(geometry.ratio).toBeCloseTo(16 / 9, 4); expect(geometry.circleRatio).toBeCloseTo(1, 4);
        expect(geometry.titleWidth).toBeCloseTo(900 / 1280, 4); expect(geometry.titleLeft).toBeCloseTo(100 / 1280, 4);
        expect(geometry.left).toBeGreaterThanOrEqual(-1); expect(geometry.top).toBeGreaterThanOrEqual(-1);
        expect(geometry.right).toBeLessThanOrEqual(width! + 1); expect(geometry.bottom).toBeLessThanOrEqual(height! + 1);
      }
      await page.setViewportSize({ width: 904, height: 829 });
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect.poll(() => page.locator("#page").textContent()).toBe("2 / 2");
    } finally { await page.close(); await server.revokeSession(session.token); }
  });
});
