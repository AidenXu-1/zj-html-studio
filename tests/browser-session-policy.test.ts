import { describe, expect, it } from "vitest";
import {
  canOpenBrowserSession,
  MAX_BROWSER_SESSIONS_PER_VIEW
} from "../src/view/browser-session-policy";

describe("browser session policy", () => {
  it("allows sessions below the per-view hard limit", () => {
    expect(canOpenBrowserSession(0)).toBe(true);
    expect(canOpenBrowserSession(MAX_BROWSER_SESSIONS_PER_VIEW - 1)).toBe(true);
  });

  it("rejects sessions at or above the per-view hard limit", () => {
    expect(canOpenBrowserSession(MAX_BROWSER_SESSIONS_PER_VIEW)).toBe(false);
    expect(canOpenBrowserSession(MAX_BROWSER_SESSIONS_PER_VIEW + 1)).toBe(false);
  });
});
