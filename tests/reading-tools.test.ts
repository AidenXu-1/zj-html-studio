import { describe, expect, it } from "vitest";
import { EmbedSessionCancelledError, EmbedSessionLimiter } from "../src/embed/embed-session-limiter";
import { parseHtmlEmbedSize } from "../src/embed/embed-size";
import { injectSearchBridge } from "../src/server/search-bridge";
import { SearchTransformLimiter } from "../src/server/search-transform-limiter";
import {
  canOpenSourceView,
  isSourceReadCurrent,
  MAX_SOURCE_VIEW_BYTES,
  normalizeSourceTextForTextarea
} from "../src/view/source-read-policy";
import {
  buildSourceLineIndex,
  findTextOccurrences,
  getSourceLineScrollRatio,
  MAX_TEXT_SEARCH_QUERY_CHARACTERS,
  moveSearchIndex,
  normalizeTextSearchQuery
} from "../src/view/text-search";
import {
  getPreviewIframeAllow,
  getPreviewIframeSandbox,
  getPreviewModePresentation
} from "../src/view/preview-mode";
import { clampPreviewZoom, stepPreviewZoom } from "../src/view/zoom";

describe("reading tools", () => {
  it("bounds search bridge transforms globally and per session", () => {
    const limiter = new SearchTransformLimiter();
    const releaseA = limiter.acquire("a", 2, 1);
    const releaseB = limiter.acquire("b", 2, 1);

    expect(releaseA).not.toBeNull();
    expect(releaseB).not.toBeNull();
    expect(limiter.acquire("a", 2, 1)).toBeNull();
    expect(limiter.acquire("c", 2, 1)).toBeNull();
    expect(limiter.activeCount).toBe(2);
    releaseA?.();
    releaseA?.();
    expect(limiter.activeCount).toBe(1);
    expect(limiter.acquire("c", 2, 1)).not.toBeNull();
  });

  it("clamps and steps preview zoom", () => {
    expect(clampPreviewZoom(10)).toBe(50);
    expect(clampPreviewZoom(240)).toBe(200);
    expect(stepPreviewZoom(100, 1)).toBe(110);
    expect(stepPreviewZoom(50, -1)).toBe(50);
  });

  it("finds source occurrences and wraps navigation", () => {
    expect(findTextOccurrences("Alpha alpha ALPHA", "alpha")).toEqual([0, 6, 12]);
    expect(findTextOccurrences("a.b A.B", "a.b")).toEqual([0, 4]);
    expect(moveSearchIndex(-1, 3, 1)).toBe(0);
    expect(moveSearchIndex(0, 3, -1)).toBe(2);
    expect(moveSearchIndex(2, 3, 1)).toBe(0);
    expect(normalizeTextSearchQuery(`  ${"x".repeat(600)}  `)).toHaveLength(MAX_TEXT_SEARCH_QUERY_CHARACTERS);
    const emojiBoundary = `${"x".repeat(MAX_TEXT_SEARCH_QUERY_CHARACTERS - 1)}😀tail`;
    const normalizedEmojiBoundary = normalizeTextSearchQuery(emojiBoundary);
    expect(normalizedEmojiBoundary).toHaveLength(MAX_TEXT_SEARCH_QUERY_CHARACTERS - 1);
    expect(normalizedEmojiBoundary.endsWith("\ud83d")).toBe(false);
  });

  it("scrolls source matches by actual line rather than character ratio", () => {
    const source = `${"x".repeat(10_000)}\nshort\ntarget\nend`;
    const position = source.indexOf("target");

    expect(getSourceLineScrollRatio(source, position)).toBeCloseTo(2 / 3);
    expect(position / source.length).toBeGreaterThan(0.99);
  });

  it("keeps Windows and legacy Mac source search offsets aligned with textarea selection", () => {
    const source = normalizeSourceTextForTextarea("first\r\nsecond\rneedle\nend");
    const position = source.indexOf("needle");

    expect(source).toBe("first\nsecond\nneedle\nend");
    expect(getSourceLineScrollRatio(source, position)).toBeCloseTo(2 / 3);
    expect(source.slice(position, position + "needle".length)).toBe("needle");
  });

  it("keeps the source line index sparse even for newline-heavy input", () => {
    const source = "\n".repeat(MAX_SOURCE_VIEW_BYTES);
    const index = buildSourceLineIndex(source);

    expect(index.totalBreaks).toBe(MAX_SOURCE_VIEW_BYTES);
    expect(index.breaksAtBlock.byteLength).toBeLessThan(1024);
  });

  it("keeps source view reads inside a consumer-safe memory bound", () => {
    expect(canOpenSourceView(MAX_SOURCE_VIEW_BYTES)).toBe(true);
    expect(canOpenSourceView(MAX_SOURCE_VIEW_BYTES + 1)).toBe(false);
    expect(canOpenSourceView(Number.NaN)).toBe(false);
  });

  it("parses Obsidian embed dimensions without accepting CSS", () => {
    expect(parseHtmlEmbedSize("760", "430")).toEqual({ width: 760, height: 430, aspectRatio: 760 / 430 });
    expect(parseHtmlEmbedSize(null, null)).toEqual({ width: null, height: 480, aspectRatio: null });
    expect(parseHtmlEmbedSize("99999", "20")).toEqual({ width: 4096, height: 160, aspectRatio: 4096 / 160 });
    expect(parseHtmlEmbedSize("100%;color:red", "auto")).toEqual({ width: null, height: 480, aspectRatio: null });
  });

  it("places the nonce-protected search bridge before user HTML", () => {
    const source = '<!-- banner --><!doctype html><html lang="zh"><head data-theme="paper"><meta charset="utf-8"></head><body><h1>Page</h1></body></html>';
    const result = injectSearchBridge(source, "nonce123", "channel456");
    expect(result.startsWith('<!-- banner --><!doctype html><html lang="zh"><head data-theme="paper"><script nonce="nonce123">')).toBe(true);
    expect(result.indexOf("<script")).toBeGreaterThan(result.indexOf("<head"));
    expect(result.indexOf("<script nonce")).toBeLessThan(result.indexOf("<meta charset"));
    expect(result).toContain(')("channel456",false,false)');
    expect(result).toContain("document.currentScript?.remove()");
    expect(result).toContain("if(parent===top)");
    expect(result).toContain("document.createTreeWalker");
    expect(result).toContain("complexityUnits");
    expect(result).toContain("element.shadowRoot");
    expect(result).toContain("trackedClosedShadowRoots");
    expect(result).toContain("searchLimited: true");
    expect(result).toContain("countReliable: false");
    expect(result).toContain("latestSearchRequestId");
    expect(result).not.toContain("innerText");
    expect(result).toContain("getSelection()?.removeAllRanges()");
    expect(result).toContain("html-studio-page-state-restored");
    expect(result).toContain("history.pushState");
  });

  it("disables synchronous page find for declarative closed shadow roots", () => {
    const source = '<html><body><template shadowrootmode="closed"><p>private component</p></template></body></html>';
    const result = injectSearchBridge(source, "nonce123", "channel456");

    expect(result).toContain(')("channel456",true,false)');
    expect(result).toContain("hasDeclarativeClosedShadowRoot");
  });

  it("decodes declarative shadow mode entities without matching tutorial text", () => {
    const shadow = injectSearchBridge(
      '<template shadowrootmode="cl&#111;sed"><p>private</p></template>',
      "nonce123",
      "channel456"
    );
    const tutorial = injectSearchBridge(
      '<pre>Use shadowrootmode="closed" for private components</pre><!-- shadowrootmode="closed" -->',
      "nonce123",
      "channel456"
    );

    expect(shadow).toContain(')("channel456",true,false)');
    expect(tutorial).toContain(')("channel456",false,false)');
  });

  it("finds closed shadow roots nested inside an active declarative open root", () => {
    const activeNested = injectSearchBridge(
      '<x-outer><template shadowrootmode="open"><x-inner><template shadowrootmode="closed"><p>private</p></template></x-inner></template></x-outer>',
      "nonce123",
      "channel456"
    );
    const inertNested = injectSearchBridge(
      '<template><x-inner><template shadowrootmode="closed"><p>inert example</p></template></x-inner></template>',
      "nonce123",
      "channel456"
    );

    expect(activeNested).toContain(')("channel456",true,false)');
    expect(inertNested).toContain(')("channel456",false,false)');
  });

  it("uses bounded manual search when page scripts can create opaque realms", () => {
    const result = injectSearchBridge(
      "<html><body><p>interactive page</p></body></html>",
      "nonce123",
      "channel456",
      true
    );

    expect(result).toContain(')("channel456",false,true)');
    expect(result).toContain("runManualSearch");
    expect(result).toContain("installValueMutationHook");
    expect(result).toContain("nativeCheckVisibility");
    expect(result).toContain("textGroups");
    expect(result).toContain("searchLimited: true");
  });

  it("runs the bridge before malformed raw text and page CSP can block it", () => {
    const source = '<html><head><meta http-equiv="Content-Security-Policy" content="script-src \'none\'"></head><body><script>const marker="</body>";';
    const result = injectSearchBridge(source, "nonce123", "channel456");
    expect(result).toMatch(/^<html><head><script nonce="nonce123">/);
    expect(result.indexOf("<script nonce")).toBeLessThan(result.indexOf("<meta"));
    expect(result.endsWith(source.slice("<html><head>".length))).toBe(true);
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

  it("maps all three modes to consistent labels and iframe capabilities", () => {
    expect(getPreviewModePresentation("safe").label).toBe("安全只读");
    expect(getPreviewModePresentation("interactive").label).toBe("本地交互");
    expect(getPreviewModePresentation("trusted").label).toBe("可信兼容");
    expect(getPreviewIframeSandbox("safe", true)).toBe("allow-scripts allow-same-origin");
    expect(getPreviewIframeSandbox("interactive")).toBe("allow-scripts allow-same-origin");
    expect(getPreviewIframeAllow("interactive")).toBe("fullscreen");
    expect(getPreviewIframeAllow("trusted")).toContain("clipboard-write");
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
