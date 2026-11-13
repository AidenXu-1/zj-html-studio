import { existsSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import { analyzePreviewScope } from "../../src/scope/dependency-analyzer";
import { PreviewServer } from "../../src/server/preview-server";
import { resolveScopeMode } from "../../src/settings";
import { getPreviewIframeAllow, getPreviewIframeSandbox } from "../../src/view/preview-mode";

it("opens a large HTML interactively, loads online resources, and keeps notes and device permissions closed", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "html-studio-browser-")));
  const server = new PreviewServer(root);
  const networkRequests: string[] = [];
  let hostHtml = "";
  const online = createServer((req, res) => {
    networkRequests.push(req.url ?? "");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.url === "/host") {
      res.setHeader("Content-Type", "text/html");
      res.end(hostHtml);
    } else if (req.url === "/online.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end('document.body.dataset.onlineScript="loaded";');
    } else res.end("online-data");
  });
  await new Promise<void>(resolve => online.listen(0, "127.0.0.1", resolve));
  const address = online.address();
  if (!address || typeof address === "string") throw new Error("No local fixture port");
  const network = `http://127.0.0.1:${address.port}`;
  const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await chromium.launch({ executablePath: process.env.HTML_STUDIO_CHROMIUM_PATH
    ?? (existsSync(systemChrome) ? systemChrome : undefined), headless: true });
  try {
    await mkdir(path.join(root, "course"));
    await writeFile(path.join(root, "course", "private.md"), "PRIVATE_NOTE_MUST_NOT_LEAK");
    await writeFile(path.join(root, "course", "index.html"), `<!doctype html><meta charset="utf-8"><body>
      <!--${"x".repeat(6 * 1024 * 1024)}-->
      <button onclick="this.textContent='Clicked'">Next</button>
      <script src="${network}/online.js"></script><script>
      fetch('${network}/data').then(r=>r.text()).then(t=>document.body.dataset.network=t);
      fetch('private.md').then(async r=>{document.body.dataset.privateStatus=r.status;document.body.dataset.privateBody=await r.text()});
      try {parent.document.body.dataset.leaked='yes'} catch {document.body.dataset.isolated='yes'}
      </script></body>`);
    const analysis = await analyzePreviewScope(root, "course/index.html");
    expect(analysis.dependencyScopeAnalysis.complete).toBe(false);
    const mode = resolveScopeMode("course", []);
    const session = await server.createSession({ entryRelativePath: analysis.entryRelativePath,
      scopeRelativePath: analysis.scopeRelativePath, resourceFiles: analysis.dependencyRelativePaths, mode });
    const page = await browser.newPage();
    page.setDefaultTimeout(3500);
    hostHtml = `<iframe sandbox="${getPreviewIframeSandbox(mode)}" allow="${getPreviewIframeAllow(mode)}" src="${session.entryUrl}"></iframe>`;
    await page.goto(`${network}/host`);
    const frame = page.frameLocator("iframe");
    await frame.locator("button").click();
    await frame.locator("body[data-network='online-data'][data-private-status='403']").waitFor();
    expect(await frame.locator("button").innerText()).toBe("Clicked");
    const state = await frame.locator("body").evaluate(body => ({
      onlineScript: body.dataset.onlineScript,
      isolated: body.dataset.isolated,
      privateBody: body.dataset.privateBody,
      clipboardAllowed: (document as Document & { featurePolicy: { allowsFeature: (feature: string) => boolean } }).featurePolicy.allowsFeature("clipboard-write"),
      cameraAllowed: (document as Document & { featurePolicy: { allowsFeature: (feature: string) => boolean } }).featurePolicy.allowsFeature("camera")
    }));
    expect(state).toMatchObject({ onlineScript: "loaded", isolated: "yes", clipboardAllowed: false, cameraAllowed: false });
    expect(state.privateBody).not.toContain("PRIVATE_NOTE_MUST_NOT_LEAK");
    expect(networkRequests).toEqual(expect.arrayContaining(["/online.js", "/data"]));
  } finally {
    await browser.close();
    await server.stop();
    await new Promise<void>((resolve, reject) => online.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
