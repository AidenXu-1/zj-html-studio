import { request } from "node:http";
import { once } from "node:events";
import { createConnection } from "node:net";
import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_HTML_PREVIEW_BYTES,
  PreviewCapacityError,
  PreviewServer,
  type PreviewDiagnostic,
  type PreviewServerResourceUsage,
  type PreviewSession
} from "../src/server/preview-server";
import { MAX_SEARCH_BRIDGE_HTML_BYTES } from "../src/server/search-bridge";
import { canonicalizeVaultBasePath, toVaultRelativePath } from "../src/scope/vault-path";

interface HttpResult {
  body: string;
  headers: Record<string, string | string[] | undefined>;
  statusCode: number;
}

describe("PreviewServer", () => {
  let tempRoot: string;
  let server: PreviewServer;
  let session: PreviewSession;
  let diagnostics: PreviewDiagnostic[];

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "html-studio-test-"));
    await mkdir(path.join(tempRoot, "site", "course"), { recursive: true });
    await mkdir(path.join(tempRoot, "site", "images"), { recursive: true });
    await mkdir(path.join(tempRoot, "outside"), { recursive: true });
    await writeFile(path.join(tempRoot, "site", "course", "课程 演示.html"), "<h1>课程</h1>");
    await writeFile(path.join(tempRoot, "site", "course", "chapter.html"), "<h2>章节</h2>");
    await writeFile(path.join(tempRoot, "site", "images", "hero.svg"), "<svg>HTML Studio</svg>");
    await writeFile(path.join(tempRoot, "site", "video.mp4"), "0123456789");
    await writeFile(path.join(tempRoot, "outside", "secret.md"), "secret");

    diagnostics = [];
    server = new PreviewServer(tempRoot, {
      onDiagnostic: diagnostic => diagnostics.push(diagnostic)
    });
    session = await server.createSession({
      scopeRelativePath: "site",
      entryRelativePath: path.join("site", "course", "课程 演示.html")
    });
  });

  it("canonicalizes a symlinked vault root before mapping runtime resource paths", async () => {
    const linkedRoot = path.join(tempRoot, "vault-link");
    await symlink(path.join(tempRoot, "site"), linkedRoot, "dir");
    const canonicalRoot = await canonicalizeVaultBasePath(linkedRoot);

    expect(canonicalRoot).toBe(await realpath(path.join(tempRoot, "site")));
    expect(toVaultRelativePath(canonicalRoot, path.join(canonicalRoot, "course", "chapter.html")))
      .toBe("course/chapter.html");
    expect(toVaultRelativePath(canonicalRoot, path.join(canonicalRoot, "..draft.html")))
      .toBe("..draft.html");
    expect(toVaultRelativePath(canonicalRoot, path.join(tempRoot, "outside", "secret.md")))
      .toBeNull();
  });

  afterEach(async () => {
    await server.stop();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("serves Chinese paths, parent assets, and query strings", async () => {
    const page = await get(session, "/course/%E8%AF%BE%E7%A8%8B%20%E6%BC%94%E7%A4%BA.html?version=1");
    const image = await get(session, "/images/hero.svg?rev=2");

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("课程");
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["access-control-allow-origin"]).toBeUndefined();
    expect(image.statusCode).toBe(200);
    expect(image.body).toContain("HTML Studio");
    expect(page.headers["content-security-policy"]).toContain("sandbox allow-same-origin");
    expect(page.headers["content-security-policy"]).toContain("script-src 'none'");
    expect(page.headers["permissions-policy"]).toContain("clipboard-write=()");
  });

  it("isolates preview origins and invalidates revoked sessions", async () => {
    const second = await server.createSession({
      scopeRelativePath: "site",
      entryRelativePath: path.join("site", "course", "课程 演示.html")
    });

    expect(second.origin).not.toBe(session.origin);
    expect(server.activeSessionCount).toBe(2);

    await server.revokeSession(second.token);
    const revoked = await get(second, "/course/%E8%AF%BE%E7%A8%8B%20%E6%BC%94%E7%A4%BA.html");
    expect(revoked.statusCode).toBe(403);
    expect(server.activeSessionCount).toBe(1);
  });

  it("uses a random localhost origin while listening only on IPv4 loopback", () => {
    const hostname = new URL(session.origin).hostname;

    expect(hostname).toMatch(/^[a-f0-9]{32}\.localhost$/);
    expect(server.listeningAddress).toBe("127.0.0.1");
  });

  it("verifies an active entry without downloading its response body", async () => {
    await expect(server.probeSessionEntry(session.token)).resolves.toEqual({
      ok: true,
      statusCode: 200
    });
    expect(server.resourceUsage.activeResponses).toBe(0);
    expect(server.resourceUsage.activeStreams).toBe(0);
  });

  it("completes a document ticket only after the matching GET finishes", async () => {
    const ticket = server.beginSessionDocumentLoad(session.token, session.entryUrl);

    expect((await get(session, new URL(session.entryUrl).pathname, "HEAD")).statusCode).toBe(200);
    const pending = await Promise.race([ticket.completion.then(() => "settled"), delay(20, "pending")]);
    expect(pending).toBe("pending");
    expect((await get(session, new URL(session.entryUrl).pathname)).statusCode).toBe(200);
    await expect(ticket.completion).resolves.toEqual({ ok: true, statusCode: 200 });
  });

  it("reports whether the loaded document actually received the search bridge", async () => {
    const bridged = await server.createSession({
      ...defaultSessionOptions(),
      enableSearchBridge: true
    });
    const ticket = server.beginSessionDocumentLoad(bridged.token, bridged.entryUrl);

    expect((await get(bridged, new URL(bridged.entryUrl).pathname)).statusCode).toBe(200);
    await expect(ticket.completion).resolves.toEqual({
      ok: true,
      searchBridgeAvailable: true,
      statusCode: 200
    });
  });

  it("reports the real matching GET failure through a document ticket", async () => {
    await writeFile(
      path.join(tempRoot, "site", "course", "ticket-invalid.html"),
      Buffer.from([0x3c, 0x70, 0x3e, 0x80])
    );
    const invalid = await server.createSession({
      entryRelativePath: path.join("site", "course", "ticket-invalid.html"),
      scopeRelativePath: "site"
    });
    const ticket = server.beginSessionDocumentLoad(invalid.token, invalid.entryUrl);

    expect((await get(invalid, new URL(invalid.entryUrl).pathname)).statusCode).toBe(415);
    await expect(ticket.completion).resolves.toEqual({ ok: false, statusCode: 415 });
  });

  it("cancels a pending document ticket when its session is revoked", async () => {
    const ticket = server.beginSessionDocumentLoad(session.token, session.entryUrl);

    await server.revokeSession(session.token);
    await expect(ticket.completion).resolves.toEqual({ ok: false, statusCode: 403 });
  });

  it("reports when an entry disappears after session creation", async () => {
    await rename(
      path.join(tempRoot, "site", "course", "课程 演示.html"),
      path.join(tempRoot, "site", "course", "课程 演示-moved.html")
    );

    await expect(server.probeSessionEntry(session.token)).resolves.toEqual({
      ok: false,
      statusCode: 404
    });
  });

  it("reports revoked and permanently stopped entry probes without reopening the listener", async () => {
    await server.revokeSession(session.token);
    await expect(server.probeSessionEntry(session.token)).resolves.toEqual({
      ok: false,
      statusCode: 403
    });
    expect(server.listeningPort).toBeNull();

    await server.stop();
    await expect(server.probeSessionEntry(session.token)).resolves.toEqual({
      ok: false,
      statusCode: 503
    });
    expect(server.listeningPort).toBeNull();
  });

  it("times out a stalled entry probe and reclaims the request", async () => {
    await server.stop();
    let releaseVerification!: () => void;
    const verificationGate = new Promise<void>(resolve => {
      releaseVerification = resolve;
    });
    server = new PreviewServer(tempRoot, {
      fileVerificationHooks: { afterOpen: () => verificationGate },
      probeTimeoutMs: 25
    });
    session = await createDefaultSession(server);

    await expect(Promise.race([
      server.probeSessionEntry(session.token),
      delay(250, "hung")
    ])).resolves.toEqual({ ok: false, statusCode: 504 });
    await waitForUsage(server, usage => (
      usage.activeFileVerifications === 0
      && usage.activeResponses === 0
      && usage.activeStreams === 0
    ));
    releaseVerification();
  });

  it("blocks encoded traversal and records a useful diagnostic", async () => {
    const result = await get(session, "/%2e%2e%2foutside/secret.md");

    expect(result.statusCode).toBe(403);
    expect(result.body).toContain("超出当前预览范围");
    expect(diagnostics.at(-1)).toMatchObject({
      reason: "outside-scope",
      statusCode: 403,
      sessionId: session.id
    });
  });

  it("suggests only a verified in-vault expansion for a narrow live session", async () => {
    const narrow = await server.createSession({
      scopeRelativePath: "site/course",
      entryRelativePath: path.join("site", "course", "课程 演示.html")
    });
    const vaultRoot = await realpath(tempRoot);
    const target = path.join(vaultRoot, "site", "images", "hero.svg");

    await expect(server.suggestScopeExpansion(narrow.token, target)).resolves.toEqual({
      scopeRelativePath: "site",
      targetRelativePath: "site/images/hero.svg"
    });
    await expect(server.suggestScopeExpansion(narrow.token, path.join(vaultRoot, "missing.svg")))
      .resolves.toBeNull();
    expect(server.resourceUsage.activeFileVerifications).toBe(0);
  });

  it.runIf(process.platform !== "win32")("does not suggest a symlink that leaves the vault", async () => {
    const narrow = await server.createSession({
      scopeRelativePath: "site/course",
      entryRelativePath: path.join("site", "course", "课程 演示.html")
    });
    await symlink(
      "/etc/hosts",
      path.join(tempRoot, "site", "outside-link.md")
    );
    const vaultRoot = await realpath(tempRoot);

    await expect(server.suggestScopeExpansion(
      narrow.token,
      path.join(vaultRoot, "site", "outside-link.md")
    )).resolves.toBeNull();
    expect(server.resourceUsage.activeFileVerifications).toBe(0);
  });

  it("never suggests an expansion outside the vault or from a revoked session", async () => {
    const narrow = await server.createSession({
      scopeRelativePath: "site/course",
      entryRelativePath: path.join("site", "course", "课程 演示.html")
    });
    await expect(server.suggestScopeExpansion(narrow.token, path.resolve(tempRoot, "..", "secret.md")))
      .resolves.toBeNull();
    await server.revokeSession(narrow.token);
    await expect(server.suggestScopeExpansion(
      narrow.token,
      path.join(tempRoot, "site", "images", "hero.svg")
    )).resolves.toBeNull();
  });

  it.runIf(process.platform !== "win32")("blocks symbolic links that escape the preview scope", async () => {
    await symlink(path.join(tempRoot, "outside", "secret.md"), path.join(tempRoot, "site", "secret-link.md"));
    const result = await get(session, "/secret-link.md");

    expect(result.statusCode).toBe(403);
    expect(diagnostics.at(-1)?.reason).toBe("outside-scope");
  });

  it("fails closed when an opened path is replaced by an outside directory", async () => {
    const exchangePath = path.join(tempRoot, "site", "race-exchange");
    const retiredPath = path.join(tempRoot, "site", "race-retired");
    await mkdir(exchangePath);
    await writeFile(path.join(exchangePath, "secret.md"), "inside-snapshot");
    await server.stop();
    let swapped = false;
    server = new PreviewServer(tempRoot, {
      fileVerificationHooks: {
        afterOpen: async () => {
          if (swapped) return;
          swapped = true;
          await rename(exchangePath, retiredPath);
          await symlink(
            path.join(tempRoot, "outside"),
            exchangePath,
            process.platform === "win32" ? "junction" : "dir"
          );
        }
      },
      onDiagnostic: diagnostic => diagnostics.push(diagnostic)
    });
    session = await server.createSession({
      scopeRelativePath: "site",
      entryRelativePath: path.join("site", "course", "课程 演示.html")
    });

    const result = await get(session, "/race-exchange/secret.md");

    // POSIX resolves the replacement link outside the scope (403), while
    // Windows can observe the directory swap as an identity change (409).
    // Both outcomes fail closed before either file body can be returned.
    expect([403, 409]).toContain(result.statusCode);
    expect(result.body).not.toContain("secret");
    expect(diagnostics.at(-1)?.reason).toBe(
      result.statusCode === 403 ? "outside-scope" : "server-error"
    );
  });

  it("rejects a same-scope file identity swap after opening the original handle", async () => {
    const exchangePath = path.join(tempRoot, "site", "identity-exchange");
    const retiredPath = path.join(tempRoot, "site", "identity-retired");
    const replacementPath = path.join(tempRoot, "site", "identity-replacement");
    await mkdir(exchangePath);
    await mkdir(replacementPath);
    await writeFile(path.join(exchangePath, "page.html"), "original-identity");
    await writeFile(path.join(replacementPath, "page.html"), "replacement-identity");
    await server.stop();
    let swapped = false;
    server = new PreviewServer(tempRoot, {
      fileVerificationHooks: {
        afterOpen: async () => {
          if (swapped) return;
          swapped = true;
          await rename(exchangePath, retiredPath);
          await rename(replacementPath, exchangePath);
        }
      },
      onDiagnostic: diagnostic => diagnostics.push(diagnostic)
    });
    session = await server.createSession({
      scopeRelativePath: "site",
      entryRelativePath: path.join("site", "course", "课程 演示.html")
    });

    const result = await get(session, "/identity-exchange/page.html");

    expect(result.statusCode).toBe(409);
    expect(result.body).toContain("安全检查期间发生变化");
    expect(result.body).not.toContain("original-identity");
    expect(result.body).not.toContain("replacement-identity");
    expect(diagnostics.at(-1)?.reason).toBe("server-error");
  });

  it("supports HEAD and media byte ranges", async () => {
    const head = await get(session, "/video.mp4", "HEAD");
    const range = await get(session, "/video.mp4", "GET", { Range: "bytes=2-5" });

    expect(head.statusCode).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers["content-length"]).toBe("10");
    expect(range.statusCode).toBe(206);
    expect(range.body).toBe("2345");
    expect(range.headers["content-range"]).toBe("bytes 2-5/10");
  });

  it("stops listening after the final session is revoked", async () => {
    expect(server.listeningPort).not.toBeNull();
    await server.revokeSession(session.token);
    expect(server.listeningPort).toBeNull();
    expect(server.activeSessionCount).toBe(0);
  });

  it("uses a distinct CSP for an explicitly trusted session", async () => {
    const trusted = await server.createSession({
      scopeRelativePath: "site",
      entryRelativePath: path.join("site", "course", "课程 演示.html"),
      mode: "trusted"
    });

    const trustedPage = await get(trusted, "/course/%E8%AF%BE%E7%A8%8B%20%E6%BC%94%E7%A4%BA.html");
    expect(trustedPage.headers["content-security-policy"]).toContain("'unsafe-inline'");
    expect(trustedPage.headers["permissions-policy"]).toContain("clipboard-write=(self)");

    expect(trusted.origin).not.toBe(session.origin);
    const safePage = await get(session, "/course/%E8%AF%BE%E7%A8%8B%20%E6%BC%94%E7%A4%BA.html");
    expect(safePage.headers["content-security-policy"]).toContain("script-src 'none'");
  });

  it("serves a local-interaction session with scripts but without background networking", async () => {
    const interactive = await server.createSession({
      enableSearchBridge: true,
      scopeRelativePath: "site",
      entryRelativePath: path.join("site", "course", "课程 演示.html"),
      mode: "interactive"
    });

    const page = await get(interactive, "/course/%E8%AF%BE%E7%A8%8B%20%E6%BC%94%E7%A4%BA.html");
    const csp = String(page.headers["content-security-policy"]);
    expect(csp).toContain("'unsafe-inline'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(page.headers["permissions-policy"]).toContain("clipboard-write=()");
    expect(page.body).toContain(`)("${interactive.searchChannel}",false,true)`);
    expect(page.body).toContain("runManualSearch");
  });

  it("injects a nonce-only search bridge into opted-in local HTML pages", async () => {
    await writeFile(
      path.join(tempRoot, "site", "course", "课程 演示.html"),
      '<html><body><script>window.userScriptRan=true</script><h1>课程</h1></body></html>'
    );
    const searchable = await server.createSession({
      scopeRelativePath: "site",
      entryRelativePath: path.join("site", "course", "课程 演示.html"),
      enableSearchBridge: true
    });

    const page = await get(searchable, "/course/%E8%AF%BE%E7%A8%8B%20%E6%BC%94%E7%A4%BA.html");
    const head = await get(searchable, "/course/%E8%AF%BE%E7%A8%8B%20%E6%BC%94%E7%A4%BA.html", "HEAD");
    const asset = await get(searchable, "/images/hero.svg");
    const linkedPage = await get(searchable, "/course/chapter.html");
    const csp = String(page.headers["content-security-policy"]);

    expect(searchable.searchChannel).toMatch(/^[a-f0-9]{48}$/);
    expect(page.body).toContain("html-studio-search-ready");
    expect(page.body).toContain(`)("${searchable.searchChannel}",false,false)`);
    expect(page.body).toMatch(/<script nonce="[a-f0-9]{36}">/);
    expect(page.body).toContain("<script>window.userScriptRan=true</script>");
    expect(head.body).toBe("");
    expect(Number(head.headers["content-length"])).toBe(Buffer.byteLength(page.body));
    expect(csp).toContain("sandbox allow-scripts allow-same-origin");
    expect(csp).toMatch(/script-src 'nonce-[a-f0-9]{36}'/);
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(String(asset.headers["content-security-policy"])).toContain("script-src 'none'");
    expect(asset.body).not.toContain("html-studio-search-ready");
    expect(linkedPage.body).toContain("html-studio-search-ready");
    expect(server.resourceUsage.activeSearchTransforms).toBe(0);
  });

  it("keeps oversized HTML previewable without allocating a search transform", async () => {
    const oversizedPath = path.join(tempRoot, "site", "course", "oversized.html");
    await writeFile(oversizedPath, Buffer.alloc(MAX_SEARCH_BRIDGE_HTML_BYTES + 1, 97));
    const oversized = await server.createSession({
      enableSearchBridge: true,
      entryRelativePath: path.join("site", "course", "oversized.html"),
      scopeRelativePath: "site"
    });

    const page = await get(oversized, "/course/oversized.html");
    expect(oversized.searchChannel).toBeUndefined();
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain("html-studio-search-ready");
    expect(server.resourceUsage.activeSearchTransforms).toBe(0);
  });

  it("rejects a declared legacy HTML encoding instead of serving mojibake", async () => {
    await writeFile(
      path.join(tempRoot, "site", "course", "legacy.html"),
      Buffer.from('<meta charset="windows-1252"><p>caf\xe9</p>', "latin1")
    );
    const legacy = await server.createSession({
      entryRelativePath: path.join("site", "course", "legacy.html"),
      scopeRelativePath: "site"
    });

    const page = await get(legacy, "/course/legacy.html");
    expect(page.statusCode).toBe(415);
    expect(page.body).toContain("转换为 UTF-8");
  });

  it("rejects invalid UTF-8 discovered after the declaration prefix", async () => {
    const invalidBody = Buffer.concat([
      Buffer.alloc(4_096, 0x61),
      Buffer.from([0x80])
    ]);
    await writeFile(path.join(tempRoot, "site", "course", "invalid-utf8.html"), invalidBody);
    const invalid = await server.createSession({
      enableSearchBridge: true,
      entryRelativePath: path.join("site", "course", "invalid-utf8.html"),
      scopeRelativePath: "site"
    });

    const head = await get(invalid, "/course/invalid-utf8.html", "HEAD");
    const page = await get(invalid, "/course/invalid-utf8.html");
    const range = await get(invalid, "/course/invalid-utf8.html", "GET", { Range: "bytes=0-10" });
    expect(head.statusCode).toBe(415);
    expect(page.statusCode).toBe(415);
    expect(range.statusCode).toBe(415);
    expect(page.body).toContain("转换为 UTF-8");
    await expect(server.probeSessionEntry(invalid.token)).resolves.toEqual({
      ok: false,
      statusCode: 415
    });
  });

  it("rejects invalid UTF-8 at the tail of oversized non-bridge HTML", async () => {
    const invalidBody = Buffer.concat([
      Buffer.alloc(MAX_SEARCH_BRIDGE_HTML_BYTES + 256, 0x61),
      Buffer.from([0x80])
    ]);
    await writeFile(path.join(tempRoot, "site", "course", "oversized-invalid.html"), invalidBody);
    const invalid = await server.createSession({
      enableSearchBridge: true,
      entryRelativePath: path.join("site", "course", "oversized-invalid.html"),
      scopeRelativePath: "site"
    });

    expect(invalid.searchChannel).toBeUndefined();
    expect((await get(invalid, "/course/oversized-invalid.html", "HEAD")).statusCode).toBe(415);
    expect((await get(invalid, "/course/oversized-invalid.html")).statusCode).toBe(415);
  });

  it("validates UTF-8 sequences across scan chunk boundaries", async () => {
    const validBody = Buffer.concat([
      Buffer.alloc(256 * 1024 - 1, 0x61),
      Buffer.from("你", "utf8"),
      Buffer.from("</p>", "utf8")
    ]);
    await writeFile(path.join(tempRoot, "site", "course", "chunk-boundary.html"), validBody);
    const valid = await server.createSession({
      entryRelativePath: path.join("site", "course", "chunk-boundary.html"),
      scopeRelativePath: "site"
    });

    expect((await get(valid, "/course/chunk-boundary.html")).statusCode).toBe(200);
  });

  it("rejects a truncated UTF-8 sequence at EOF", async () => {
    await writeFile(
      path.join(tempRoot, "site", "course", "truncated-utf8.html"),
      Buffer.concat([Buffer.from("<p>"), Buffer.from([0xe4, 0xbd])])
    );
    const invalid = await server.createSession({
      entryRelativePath: path.join("site", "course", "truncated-utf8.html"),
      scopeRelativePath: "site"
    });

    expect((await get(invalid, "/course/truncated-utf8.html")).statusCode).toBe(415);
  });

  it("serves the verified HTML snapshot even if the file is rewritten before response", async () => {
    const filePath = path.join(tempRoot, "site", "course", "snapshot.html");
    const original = "<p>verified snapshot</p>";
    const replacement = Buffer.alloc(Buffer.byteLength(original), 0x61);
    replacement[replacement.length - 1] = 0x80;
    await writeFile(filePath, original);
    await server.stop();
    server = new PreviewServer(tempRoot, {
      afterHtmlSnapshotReady: async resolvedPath => {
        if (resolvedPath === filePath) await writeFile(filePath, replacement);
      }
    });
    const snapshot = await server.createSession({
      entryRelativePath: path.join("site", "course", "snapshot.html"),
      scopeRelativePath: "site"
    });

    const page = await get(snapshot, "/course/snapshot.html");
    expect(page.statusCode).toBe(200);
    expect(page.body).toBe(original);
  });

  it("queues a three-tab HTML restore burst while retaining only two snapshots", async () => {
    await server.stop();
    let entered = 0;
    let markTwoEntered!: () => void;
    let releaseSnapshots!: () => void;
    const twoEntered = new Promise<void>(resolve => {
      markTwoEntered = resolve;
    });
    const snapshotGate = new Promise<void>(resolve => {
      releaseSnapshots = resolve;
    });
    server = new PreviewServer(tempRoot, {
      afterHtmlSnapshotReady: async () => {
        entered += 1;
        if (entered === 2) markTwoEntered();
        await snapshotGate;
      },
      limits: {
        maxActiveHtmlValidations: 2,
        maxConcurrentHtmlValidationsPerSession: 1,
        maxPendingHtmlValidations: 3,
        maxPendingHtmlValidationsPerSession: 2
      }
    });
    const sessions = await Promise.all([
      createDefaultSession(server),
      createDefaultSession(server),
      createDefaultSession(server)
    ]);

    const probes = sessions.map(item => server.probeSessionEntry(item.token));
    await twoEntered;
    await delay(20);
    expect(server.resourceUsage).toMatchObject({
      activeHtmlValidations: 2,
      pendingHtmlValidations: 1
    });
    releaseSnapshots();
    await expect(Promise.all(probes)).resolves.toEqual([
      { ok: true, statusCode: 200 },
      { ok: true, statusCode: 200 },
      { ok: true, statusCode: 200 }
    ]);
    expect(server.resourceUsage).toMatchObject({
      activeHtmlValidations: 0,
      pendingHtmlValidations: 0
    });
  });

  it("cancels an entry probe before it can occupy a response or snapshot slot", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(server.probeSessionEntry(session.token, controller.signal)).resolves.toEqual({
      cancelled: true,
      ok: false,
      statusCode: 499
    });
    expect(server.resourceUsage).toMatchObject({
      activeHtmlValidations: 0,
      activeResponses: 0,
      pendingHtmlValidations: 0
    });
  });

  it("rejects HTML larger than the immutable snapshot limit", async () => {
    await writeFile(
      path.join(tempRoot, "site", "course", "too-large.html"),
      Buffer.alloc(MAX_HTML_PREVIEW_BYTES + 1, 0x61)
    );
    const oversized = await server.createSession({
      entryRelativePath: path.join("site", "course", "too-large.html"),
      scopeRelativePath: "site"
    });

    expect((await get(oversized, "/course/too-large.html")).statusCode).toBe(413);
  });

  it("gives stop priority over a concurrent session creation", async () => {
    await server.stop();
    server = new PreviewServer(tempRoot);

    const creating = server.createSession({
      scopeRelativePath: "site",
      entryRelativePath: path.join("site", "course", "课程 演示.html")
    });
    await server.stop();

    await expect(creating).rejects.toThrow("已经停止");
    expect(server.listeningPort).toBeNull();
    expect(server.activeSessionCount).toBe(0);
  });

  it("treats stop as terminal and never reopens a listener", async () => {
    await server.stop();

    await expect(server.createSession({
      scopeRelativePath: "site",
      entryRelativePath: path.join("site", "course", "课程 演示.html")
    })).rejects.toThrow("永久停止");
    expect(server.listeningPort).toBeNull();
    expect(server.activeSessionCount).toBe(0);
  });

  it("returns a structured error before active sessions can grow without bound", async () => {
    await server.stop();
    server = new PreviewServer(tempRoot, { limits: { maxActiveSessions: 2 } });
    session = await createDefaultSession(server);
    const second = await createDefaultSession(server);

    const rejected = server.createSession(defaultSessionOptions());
    await expect(rejected).rejects.toBeInstanceOf(PreviewCapacityError);
    await expect(rejected).rejects.toMatchObject({
      code: "PREVIEW_CAPACITY",
      limit: 2,
      resource: "active-sessions"
    });
    expect(server.resourceUsage.activeSessions).toBe(2);

    await Promise.all([server.revokeSession(session.token), server.revokeSession(second.token)]);
    expect(server.resourceUsage).toMatchObject({
      activeFileVerifications: 0,
      activeResponses: 0,
      activeSessions: 0,
      activeStreams: 0,
      pendingCreations: 0
    });
  });

  it("does not allow test overrides to raise the production session ceiling", async () => {
    await server.stop();
    server = new PreviewServer(tempRoot, { limits: { maxActiveSessions: 1_000 } });
    const created: PreviewSession[] = [];
    for (let index = 0; index < 64; index += 1) {
      created.push(await createDefaultSession(server));
    }

    await expect(createDefaultSession(server)).rejects.toMatchObject({
      code: "PREVIEW_CAPACITY",
      limit: 64,
      resource: "active-sessions"
    });
    expect(server.resourceUsage.activeSessions).toBe(64);

    await Promise.all(created.map(item => server.revokeSession(item.token)));
  });

  it("rejects excess pending creations before allocating session objects", async () => {
    await server.stop();
    server = new PreviewServer(tempRoot, {
      limits: { maxActiveSessions: 4, maxPendingCreations: 2 }
    });

    const first = server.createSession(defaultSessionOptions());
    const second = server.createSession(defaultSessionOptions());
    const rejected = server.createSession(defaultSessionOptions());

    await expect(rejected).rejects.toMatchObject({
      code: "PREVIEW_CAPACITY",
      limit: 2,
      resource: "pending-creations"
    });
    const created = await Promise.all([first, second]);
    session = created[0];
    expect(server.resourceUsage.pendingCreations).toBe(0);
    expect(server.resourceUsage.activeSessions).toBe(2);

    await Promise.all(created.map(item => server.revokeSession(item.token)));
    expect(server.resourceUsage.activeSessions).toBe(0);
  });

  it("caps sockets and releases them after stop", async () => {
    await server.stop();
    server = new PreviewServer(tempRoot, { limits: { maxSockets: 1 } });
    session = await createDefaultSession(server);
    const port = server.listeningPort!;
    const held = createConnection({ host: "127.0.0.1", port });
    held.on("error", () => undefined);
    await once(held, "connect");
    held.write("GET / HTTP/1.1\r\n");

    const rejected = createConnection({ host: "127.0.0.1", port });
    rejected.on("error", () => undefined);
    const rejectedClosed = once(rejected, "close");
    await expect(Promise.race([
      rejectedClosed.then(() => "closed"),
      delay(500, "timeout")
    ])).resolves.toBe("closed");
    expect(server.resourceUsage.sockets).toBe(1);

    const heldClosed = once(held, "close");
    await server.stop();
    await heldClosed;
    expect(server.resourceUsage.sockets).toBe(0);
    expect(held.destroyed).toBe(true);
  });

  it("caps concurrent responses and file streams", async () => {
    await writeFile(path.join(tempRoot, "site", "large.bin"), Buffer.alloc(8 * 1024 * 1024, 97));
    await server.stop();
    server = new PreviewServer(tempRoot, {
      onDiagnostic: diagnostic => diagnostics.push(diagnostic),
      limits: {
        maxActiveResponses: 2,
        maxActiveStreams: 1,
        maxConcurrentRequestsPerSession: 1,
        maxConcurrentStreamsPerSession: 1
      }
    });
    session = await createDefaultSession(server);
    const second = await createDefaultSession(server);
    const held = await openPausedGet(session, "/large.bin");

    expect((await get(session, "/images/hero.svg")).statusCode).toBe(429);
    expect((await get(second, "/large.bin")).statusCode).toBe(503);
    expect(server.resourceUsage).toMatchObject({ activeResponses: 1, activeStreams: 1 });

    held.close();
    await waitForUsage(server, usage => usage.activeResponses === 0 && usage.activeStreams === 0);
  });

  it("closes excess global responses before writing another payload", async () => {
    await writeFile(path.join(tempRoot, "site", "large.bin"), Buffer.alloc(8 * 1024 * 1024, 97));
    await server.stop();
    server = new PreviewServer(tempRoot, {
      onDiagnostic: diagnostic => diagnostics.push(diagnostic),
      limits: {
        maxActiveResponses: 1,
        maxActiveStreams: 2,
        maxConcurrentRequestsPerSession: 2
      }
    });
    session = await createDefaultSession(server);
    const second = await createDefaultSession(server);
    const held = await openPausedGet(session, "/large.bin");

    await expect(get(second, "/images/hero.svg")).rejects.toThrow();
    expect(diagnostics).toContainEqual(expect.objectContaining({
      reason: "server-error",
      requestPath: "/images/hero.svg",
      sessionId: second.id,
      statusCode: 503
    }));
    expect(server.resourceUsage).toMatchObject({ activeResponses: 1, activeStreams: 1 });

    held.close();
    await waitForUsage(server, usage => usage.activeResponses === 0 && usage.activeStreams === 0);
  });

  it("settles a matching document ticket immediately when global response capacity is full", async () => {
    await writeFile(path.join(tempRoot, "site", "large.bin"), Buffer.alloc(8 * 1024 * 1024, 97));
    await server.stop();
    server = new PreviewServer(tempRoot, {
      limits: {
        maxActiveResponses: 1,
        maxActiveStreams: 2,
        maxConcurrentRequestsPerSession: 2
      }
    });
    session = await createDefaultSession(server);
    const second = await createDefaultSession(server);
    const held = await openPausedGet(session, "/large.bin");
    const ticket = server.beginSessionDocumentLoad(second.token, second.entryUrl);

    await expect(get(second, new URL(second.entryUrl).pathname)).rejects.toThrow();
    await expect(ticket.completion).resolves.toEqual({ ok: false, statusCode: 503 });

    held.close();
    await waitForUsage(server, usage => usage.activeResponses === 0 && usage.activeStreams === 0);
  });

  it("caps file verification and reclaims an aborted request", async () => {
    await server.stop();
    let releaseVerification!: () => void;
    let markVerificationEntered!: () => void;
    let hookCalls = 0;
    const verificationGate = new Promise<void>(resolve => {
      releaseVerification = resolve;
    });
    const verificationEntered = new Promise<void>(resolve => {
      markVerificationEntered = resolve;
    });
    server = new PreviewServer(tempRoot, {
      fileVerificationHooks: {
        afterOpen: () => {
          hookCalls += 1;
          markVerificationEntered();
          return verificationGate;
        }
      },
      limits: {
        maxActiveFileVerifications: 1,
        maxConcurrentFileVerificationsPerSession: 1,
        maxConcurrentRequestsPerSession: 3
      }
    });
    session = await createDefaultSession(server);
    const second = await createDefaultSession(server);
    const url = new URL(session.origin);
    const first = request({
      host: "127.0.0.1",
      port: Number(url.port),
      path: "/images/hero.svg",
      headers: { Host: url.host }
    });
    first.on("error", () => undefined);
    first.end();
    await verificationEntered;

    expect(server.resourceUsage).toMatchObject({
      activeFileVerifications: 1,
      activeResponses: 1
    });
    expect((await get(session, "/images/hero.svg")).statusCode).toBe(429);
    expect((await get(second, "/images/hero.svg")).statusCode).toBe(503);
    expect(hookCalls).toBe(1);

    first.destroy();
    await waitForUsage(server, usage => (
      usage.activeFileVerifications === 0
      && usage.activeResponses === 0
      && usage.activeStreams === 0
    ));
    releaseVerification();
    expect((await get(session, "/images/hero.svg")).statusCode).toBe(200);
    expect(hookCalls).toBe(2);
  });

  it("aborts a stalled file verification when the service stops", async () => {
    await server.stop();
    let releaseVerification!: () => void;
    let markVerificationEntered!: () => void;
    const verificationGate = new Promise<void>(resolve => {
      releaseVerification = resolve;
    });
    const verificationEntered = new Promise<void>(resolve => {
      markVerificationEntered = resolve;
    });
    server = new PreviewServer(tempRoot, {
      fileVerificationHooks: {
        afterOpen: () => {
          markVerificationEntered();
          return verificationGate;
        }
      }
    });
    session = await createDefaultSession(server);
    const url = new URL(session.origin);
    const call = request({
      host: "127.0.0.1",
      port: Number(url.port),
      path: "/images/hero.svg",
      headers: { Host: url.host }
    });
    call.on("error", () => undefined);
    call.end();
    await verificationEntered;

    await expect(Promise.race([
      server.stop().then(() => "stopped"),
      delay(250, "timeout")
    ])).resolves.toBe("stopped");
    await waitForUsage(server, usage => (
      usage.activeFileVerifications === 0
      && usage.activeResponses === 0
      && usage.activeSessions === 0
      && usage.activeStreams === 0
      && usage.sockets === 0
    ));
    releaseVerification();
  });

  it("force-closes incomplete local connections during stop", async () => {
    const port = server.listeningPort;
    expect(port).not.toBeNull();
    const socket = createConnection({ host: "127.0.0.1", port: port! });
    socket.on("error", () => undefined);
    const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
    await once(socket, "connect");
    socket.write("GET /course/index.html HTTP/1.1\r\nHost: slow.localhost\r\n");

    await expect(Promise.race([
      server.stop().then(() => "stopped"),
      delay(250, "timeout")
    ])).resolves.toBe("stopped");
    await closed;
    expect(socket.destroyed).toBe(true);
  });

  it("aborts an active file transfer when its session is revoked", async () => {
    const size = 16 * 1024 * 1024;
    await writeFile(path.join(tempRoot, "site", "large.bin"), Buffer.alloc(size, 97));
    const survivor = await server.createSession({
      scopeRelativePath: "site",
      entryRelativePath: path.join("site", "course", "课程 演示.html")
    });
    const transfer = await getUntilRevoked(server, session, "/large.bin");

    expect(transfer.ended).toBe(false);
    expect(transfer.bytes).toBeLessThan(size);
    expect((await get(session, "/large.bin")).statusCode).toBe(403);
    expect(server.listeningPort).not.toBeNull();
    await server.revokeSession(survivor.token);
  });

  it("keeps diagnostics bounded across ten thousand unique failures", async () => {
    for (let index = 0; index < 10_000; index += 1) {
      const result = await get(session, `/missing-${index}.png`);
      expect(result.statusCode).toBe(404);
    }

    const sessionDiagnostics = diagnostics.filter(diagnostic => diagnostic.sessionId === session.id);
    expect(sessionDiagnostics).toHaveLength(201);
    expect(sessionDiagnostics.at(-1)?.reason).toBe("diagnostic-limit");
  }, 30_000);
});

function get(
  session: PreviewSession,
  requestPath: string,
  method = "GET",
  headers: Record<string, string> = {}
): Promise<HttpResult> {
  const url = new URL(session.origin);

  return new Promise((resolve, reject) => {
    const call = request({
      host: "127.0.0.1",
      port: Number(url.port),
      method,
      path: requestPath,
      headers: {
        Host: url.host,
        ...headers
      }
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
    });
    call.on("error", reject);
    call.end();
  });
}

function getUntilRevoked(
  server: PreviewServer,
  session: PreviewSession,
  requestPath: string
): Promise<{ bytes: number; ended: boolean }> {
  const url = new URL(session.origin);

  return new Promise((resolve, reject) => {
    let bytes = 0;
    let settled = false;
    const finish = (ended: boolean): void => {
      if (settled) return;
      settled = true;
      resolve({ bytes, ended });
    };
    const call = request({
      host: "127.0.0.1",
      port: Number(url.port),
      path: requestPath,
      headers: { Host: url.host }
    }, response => {
      let revoking = false;
      response.on("data", (chunk: Buffer) => {
        bytes += Buffer.byteLength(chunk);
        if (revoking) return;
        revoking = true;
        response.pause();
        void server.revokeSession(session.token).then(() => {
          response.resume();
        }, reject);
      });
      response.once("aborted", () => finish(false));
      response.once("error", () => finish(false));
      response.once("end", () => finish(true));
    });
    call.once("error", error => {
      if (settled) return;
      reject(error);
    });
    call.end();
  });
}

function defaultSessionOptions(): {
  entryRelativePath: string;
  scopeRelativePath: string;
} {
  return {
    scopeRelativePath: "site",
    entryRelativePath: path.join("site", "course", "课程 演示.html")
  };
}

function createDefaultSession(previewServer: PreviewServer): Promise<PreviewSession> {
  return previewServer.createSession(defaultSessionOptions());
}

function openPausedGet(
  previewSession: PreviewSession,
  requestPath: string
): Promise<{ close: () => void }> {
  const url = new URL(previewSession.origin);

  return new Promise((resolve, reject) => {
    const call = request({
      host: "127.0.0.1",
      port: Number(url.port),
      path: requestPath,
      headers: { Host: url.host }
    }, response => {
      response.pause();
      resolve({
        close: () => {
          response.destroy();
          call.destroy();
        }
      });
    });
    call.once("error", reject);
    call.end();
  });
}

async function waitForUsage(
  previewServer: PreviewServer,
  predicate: (usage: PreviewServerResourceUsage) => boolean
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate(previewServer.resourceUsage)) return;
    await delay(10);
  }
  throw new Error(`资源未在预期时间内回收：${JSON.stringify(previewServer.resourceUsage)}`);
}
