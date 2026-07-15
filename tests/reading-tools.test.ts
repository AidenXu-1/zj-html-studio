import { describe, expect, it } from "vitest";
import { EmbedSessionCancelledError, EmbedSessionLimiter } from "../src/embed/embed-session-limiter";
import { parseHtmlEmbedSize } from "../src/embed/embed-size";
import { injectSearchBridge } from "../src/server/search-bridge";
import { isSourceReadCurrent } from "../src/view/source-read-policy";
import { findTextOccurrences, moveSearchIndex } from "../src/view/text-search";
import { clampPreviewZoom, stepPreviewZoom } from "../src/view/zoom";

describe("reading tools", () => {
  it("clamps and steps preview zoom", () => {
    expect(clampPreviewZoom(10)).toBe(50);
    expect(clampPreviewZoom(240)).toBe(200);
    expect(stepPreviewZoom(100, 1)).toBe(110);
    expect(stepPreviewZoom(50, -1)).toBe(50);
  });

  it("finds source occurrences and wraps navigation", () => {
    expect(findTextOccurrences("Alpha alpha ALPHA", "alpha")).toEqual([0, 6, 12]);
    expect(moveSearchIndex(-1, 3, 1)).toBe(0);
    expect(moveSearchIndex(0, 3, -1)).toBe(2);
    expect(moveSearchIndex(2, 3, 1)).toBe(0);
  });

  it("parses Obsidian embed dimensions without accepting CSS", () => {
    expect(parseHtmlEmbedSize("760", "430")).toEqual({ width: 760, height: 430, aspectRatio: 760 / 430 });
    expect(parseHtmlEmbedSize(null, null)).toEqual({ width: null, height: 480, aspectRatio: null });
    expect(parseHtmlEmbedSize("99999", "20")).toEqual({ width: 4096, height: 160, aspectRatio: 4096 / 160 });
    expect(parseHtmlEmbedSize("100%;color:red", "auto")).toEqual({ width: null, height: 480, aspectRatio: null });
  });

  it("appends the nonce-protected search bridge without rewriting user HTML", () => {
    const source = "<html><body><h1>Page</h1></body></html>";
    const result = injectSearchBridge(source, "nonce123", "channel456");
    expect(result.startsWith(source)).toBe(true);
    expect(result.slice(source.length)).toContain('<script nonce="nonce123">');
    expect(result.slice(source.length)).toContain('const c="channel456"');
  });

  it("does not inject into body-like text inside scripts or comments", () => {
    const source = '<html><body><script>const marker="</body>";</script><!-- </html> --><p>Page</p></body></html>';
    const result = injectSearchBridge(source, "nonce123", "channel456");
    expect(result.slice(0, source.length)).toBe(source);
    expect(result.slice(source.length)).toMatch(/^<script nonce="nonce123">/);
  });

  it("accepts source text only from the latest request for the current file", () => {
    const current = {
      currentFilePath: "pages/current.html",
      currentLoadGeneration: 5,
      currentRequestGeneration: 8,
      filePath: "pages/current.html",
      loadGeneration: 5,
      requestGeneration: 8
    };
    expect(isSourceReadCurrent(current)).toBe(true);
    expect(isSourceReadCurrent({ ...current, requestGeneration: 7 })).toBe(false);
    expect(isSourceReadCurrent({ ...current, loadGeneration: 4 })).toBe(false);
    expect(isSourceReadCurrent({ ...current, filePath: "pages/previous.html" })).toBe(false);
  });
});

describe("EmbedSessionLimiter", () => {
  it("keeps active sessions bounded and serves the queue", async () => {
    const limiter = new EmbedSessionLimiter(1);
    const releaseA = await limiter.acquire("a");
    let resolved = false;
    const pendingB = limiter.acquire("b").then(release => {
      resolved = true;
      return release;
    });
    await Promise.resolve();
    expect(limiter.activeCount).toBe(1);
    expect(limiter.waitingCount).toBe(1);
    expect(resolved).toBe(false);

    releaseA();
    const releaseB = await pendingB;
    expect(limiter.activeCount).toBe(1);
    expect(limiter.waitingCount).toBe(0);
    releaseB();
    expect(limiter.activeCount).toBe(0);
  });

  it("can cancel an offscreen queued embed", async () => {
    const limiter = new EmbedSessionLimiter(1);
    const release = await limiter.acquire("active");
    const queued = limiter.acquire("queued");
    limiter.cancel("queued");
    expect(limiter.waitingCount).toBe(0);
    await expect(queued).rejects.toBeInstanceOf(EmbedSessionCancelledError);
    release();
  });
});
