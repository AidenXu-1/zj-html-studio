import { request } from "node:http";
import { once } from "node:events";
import { createConnection } from "node:net";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PreviewServer, type PreviewDiagnostic, type PreviewSession } from "../src/server/preview-server";

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

  it.runIf(process.platform !== "win32")("blocks symbolic links that escape the preview scope", async () => {
    await symlink(path.join(tempRoot, "outside", "secret.md"), path.join(tempRoot, "site", "secret-link.md"));
    const result = await get(session, "/secret-link.md");

    expect(result.statusCode).toBe(403);
    expect(diagnostics.at(-1)?.reason).toBe("outside-scope");
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
  });
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
