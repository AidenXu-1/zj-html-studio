import { describe, expect, it } from "vitest";
import {
  buildReadingStateUrl,
  isReadingStateRestorable,
  isSameReadingLocation,
  parseBridgePageState
} from "../src/view/preview-reading-state";

describe("preview reading state", () => {
  it("maps a local subpage into a broader replacement scope", () => {
    const state = parseBridgePageState("site", {
      hash: "#lesson-2",
      pathname: "/course/chapter%202.html",
      scrollX: 12.8,
      scrollY: 640.9,
      search: "?student=1"
    });

    expect(state).toEqual({
      hash: "#lesson-2",
      scrollX: 12,
      scrollY: 640,
      search: "?student=1",
      vaultRelativePath: "site/course/chapter 2.html"
    });
    expect(buildReadingStateUrl(
      "http://token.localhost:1234/site/course/index.html",
      "",
      state
    )).toBe("http://token.localhost:1234/site/course/chapter%202.html?student=1#lesson-2");
  });

  it.each([
    "?flag",
    "?q=a%20b",
    "?first=1&&second=2&",
    "?signature=a%2Fb%3D%3D"
  ])("preserves the page query byte-for-byte: %s", search => {
    const state = parseBridgePageState("site", {
      pathname: "/course/chapter.html",
      search
    });

    expect(state?.search).toBe(search);
    expect(buildReadingStateUrl(
      "http://token.localhost:1234/course/index.html",
      "site",
      state
    )).toContain(search);
  });

  it("does not restore a page that is outside the replacement scope", () => {
    const state = parseBridgePageState("site", { pathname: "/shared/chapter.html" });

    expect(buildReadingStateUrl(
      "http://token.localhost:1234/course/index.html",
      "site/course",
      state
    )).toBe("http://token.localhost:1234/course/index.html");
    expect(isReadingStateRestorable("site/course", state)).toBe(false);
  });

  it("distinguishes a newer scroll position from navigation during candidate loading", () => {
    const initial = {
      hash: "#lesson-2",
      scrollX: 0,
      scrollY: 120,
      search: "?from=index",
      vaultRelativePath: "pages/chapter.html"
    };

    expect(isSameReadingLocation(initial, { ...initial, scrollY: 980 })).toBe(true);
    expect(isSameReadingLocation(initial, { ...initial, hash: "#lesson-3" })).toBe(false);
    expect(isSameReadingLocation(initial, {
      ...initial,
      vaultRelativePath: "pages/appendix.html"
    })).toBe(false);
  });

  it.each([
    "/../secret.html",
    "/%2e%2e/secret.html",
    "/folder%5c..%5csecret.html",
    "/%E0%A4%A"
  ])("rejects an unsafe or malformed bridge path: %s", pathname => {
    expect(parseBridgePageState("site", { pathname })).toBeNull();
  });
});
