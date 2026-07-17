import { describe, expect, it } from "vitest";
import {
  getContentSecurityPolicy,
  getPermissionsPolicy,
  SAFE_CONTENT_SECURITY_POLICY,
  SENSITIVE_PERMISSION_FEATURES,
  TRUSTED_CONTENT_SECURITY_POLICY,
  WEBRTC_RUNTIME_ENFORCEMENT_STATUS
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
    expect(getPermissionsPolicy("safe")).toContain("clipboard-read=()");
    expect(SAFE_CONTENT_SECURITY_POLICY).not.toContain("http:");
  });

  it("allows compatibility features only in explicitly trusted mode", () => {
    expect(TRUSTED_CONTENT_SECURITY_POLICY).toContain("'unsafe-inline'");
    expect(TRUSTED_CONTENT_SECURITY_POLICY).toContain("connect-src 'self' http: https: ws: wss:");
    expect(TRUSTED_CONTENT_SECURITY_POLICY).toContain("base-uri 'self' http: https:");
    expect(getPermissionsPolicy("trusted")).toContain("clipboard-write=(self)");
    expect(getPermissionsPolicy("trusted")).toContain("fullscreen=(self)");
  });

  it("runs local scripts while blocking listed fetch-style channels in local-interaction mode", () => {
    const csp = getContentSecurityPolicy("interactive", "http://token.localhost:1234");

    expect(csp).toContain("sandbox allow-scripts allow-same-origin");
    expect(csp).toContain("script-src http://token.localhost:1234 'unsafe-inline'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("worker-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("https:");
    expect(getPermissionsPolicy("interactive")).toContain("clipboard-write=()");
  });

  it.each(["safe", "interactive"] as const)(
    "explicitly closes every sensitive browser capability in %s mode",
    mode => {
      const policy = getPermissionsPolicy(mode);

      for (const feature of SENSITIVE_PERMISSION_FEATURES) {
        expect(policy).toContain(`${feature}=()`);
      }
    }
  );

  it("keeps trusted mode limited to the two capabilities currently promised", () => {
    const policy = getPermissionsPolicy("trusted");

    expect(policy).toContain("clipboard-write=(self)");
    expect(policy).toContain("fullscreen=(self)");
    for (const feature of SENSITIVE_PERMISSION_FEATURES) {
      if (feature === "clipboard-write") continue;
      expect(policy).toContain(`${feature}=()`);
    }
  });

  it("keeps the best-effort WebRTC directive without claiming current Obsidian enforcement", () => {
    const safe = getContentSecurityPolicy("safe", "http://token.localhost:1234");
    const interactive = getContentSecurityPolicy("interactive", "http://token.localhost:1234");

    expect(safe).toContain("webrtc 'none'");
    expect(interactive).toContain("webrtc 'none'");
    expect(TRUSTED_CONTENT_SECURITY_POLICY).not.toContain("webrtc 'none'");
    expect(WEBRTC_RUNTIME_ENFORCEMENT_STATUS).toBe("not-enforced-in-obsidian-1.12.7");
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
