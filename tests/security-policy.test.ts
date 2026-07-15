import { describe, expect, it } from "vitest";
import {
  getContentSecurityPolicy,
  getPermissionsPolicy,
  SAFE_CONTENT_SECURITY_POLICY,
  TRUSTED_CONTENT_SECURITY_POLICY
} from "../src/server/security-policy";

describe("preview security policies", () => {
  it("blocks scripts, connections, nested pages, forms, and clipboard in safe mode", () => {
    const csp = getContentSecurityPolicy("safe", "http://token.localhost:1234");

    expect(csp).toContain("sandbox allow-same-origin");
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("img-src http://token.localhost:1234 data: blob:");
    expect(getPermissionsPolicy("safe")).toContain("clipboard-write=()");
    expect(SAFE_CONTENT_SECURITY_POLICY).not.toContain("http:");
  });

  it("allows compatibility features only in explicitly trusted mode", () => {
    expect(TRUSTED_CONTENT_SECURITY_POLICY).toContain("'unsafe-inline'");
    expect(TRUSTED_CONTENT_SECURITY_POLICY).toContain("connect-src 'self' http: https: ws: wss:");
    expect(getPermissionsPolicy("trusted")).toContain("clipboard-write=(self)");
  });

  it("allows only the plugin nonce when a safe search bridge is enabled", () => {
    const csp = getContentSecurityPolicy("safe", "http://token.localhost:1234", "bridge-nonce");

    expect(csp).toContain("sandbox allow-scripts allow-same-origin");
    expect(csp).toContain("script-src 'nonce-bridge-nonce'");
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(csp).not.toContain("script-src 'none'");
    expect(csp).toContain("connect-src 'none'");
  });
});
