import { request } from "node:http";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PreviewServer, type PreviewSession } from "../src/server/preview-server";
import { resolveScopeMode } from "../src/settings";
import { analyzePreviewScope } from "../src/scope/dependency-analyzer";

describe("direct HTML opening", () => {
  let root: string;
  let server: PreviewServer;
  const options = {
    entryRelativePath: "course/index.html",
    scopeRelativePath: "",
    mode: "standard" as const,
    resourceFiles: ["shared/style.css", "notes/private.md"]
  };
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "html-studio-access-")));
    for (const dir of ["course/assets", "shared", "notes", ".private-config"]) {
      await mkdir(path.join(root, dir), { recursive: true });
    }
    for (const [file, body] of Object.entries({
      "course/index.html": "<button onclick='this.textContent=2'>1</button>",
      "course/assets/photo.png": "photo", "shared/style.css": "body{color:red}",
      "notes/private.md": "private-note", "notes/other.md": "another-note",
      "course/data.json": "{\"private\":true}", ".private-config/config.json": "secret-config"
    })) await writeFile(path.join(root, file), body);
    server = new PreviewServer(root);
  });
  afterEach(async () => { await server.stop(); await rm(root, { recursive: true, force: true }); });

  it("defaults to normal interaction and networking, preserving explicit restrictions", () => {
    expect(resolveScopeMode("course", [])).toBe("standard");
    expect(resolveScopeMode("", [])).toBe("standard");
    expect(resolveScopeMode("course", [], ["course"])).toBe("safe");
    expect(resolveScopeMode("course", [], [], ["course"])).toBe("interactive");
    expect(resolveScopeMode("course", [], [], [], [], "safe")).toBe("safe");
    expect(resolveScopeMode("course", [], [], [], ["course"], "safe")).toBe("standard");
    expect(resolveScopeMode("course", [], ["course"], [], ["course"])).toBe("safe");
  });

  it("loads companion assets without opening unrelated notes or data at a vault routing root", async () => {
    const session = await server.createSession(options);
    const page = await get(session, "/course/index.html");
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("connect-src 'self' http: https: ws: wss:");
    expect(page.headers["permissions-policy"]).toContain("clipboard-write=()");
    expect(page.headers["permissions-policy"]).toContain("camera=()");
    expect((await get(session, "/course/assets/photo.png")).status).toBe(200);
    expect((await get(session, "/shared/style.css")).status).toBe(200);
    for (const file of ["notes/private.md", "notes/other.md", "course/data.json", ".private-config/config.json"]) {
      const result = await get(session, `/${file}`);
      expect(result.status, file).toBe(403);
      expect(result.body).not.toMatch(/private-note|another-note|secret-config/);
    }
  });

  it("authorizes exactly one extra file, inherits it explicitly, and does not remember it on reopen", async () => {
    const initial = await server.createSession(options);
    const suggestion = await server.suggestScopeExpansion(initial.token, path.join(root, "course/data.json"));
    expect(suggestion?.targetRelativePath).toBe("course/data.json");
    const granted = await server.createSession({ ...options, approvedFiles: [suggestion!.targetRelativePath] });
    expect((await get(granted, "/course/data.json")).status).toBe(200);
    expect((await get(granted, "/notes/other.md")).status).toBe(403);
    const projection = await server.createSession({ ...options, approvedFiles: granted.approvedFiles });
    expect((await get(projection, "/course/data.json")).status).toBe(200);
    const reopened = await server.createSession(options);
    expect((await get(reopened, "/course/data.json")).status).toBe(403);
  });

  it("does not serve private or hidden files through resource-looking symlinks", async () => {
    await symlink(path.join(root, "notes/private.md"), path.join(root, "course/assets/leak.png"));
    await symlink(path.join(root, ".private-config/config.json"), path.join(root, "course/assets/config.js"));
    const session = await server.createSession(options);
    expect((await get(session, "/course/assets/leak.png")).status).toBe(403);
    expect((await get(session, "/course/assets/config.js")).status).toBe(403);
    expect(await server.suggestScopeExpansion(session.token, path.join(root, ".private-config/config.json"))).toBeNull();
  });

  it("keeps custom Obsidian configuration directories closed even when a page declares them", async () => {
    await server.stop();
    await mkdir(path.join(root, "course/settings"));
    await writeFile(path.join(root, "course/settings/plugin.js"), "const secret = 'configuration';");
    server = new PreviewServer(root, { protectedDirectories: ["course/settings"] });
    const session = await server.createSession({ ...options,
      resourceFiles: ["course/settings/plugin.js"], approvedFiles: ["course/settings/plugin.js"] });
    expect((await get(session, "/course/settings/plugin.js")).status).toBe(403);
    expect(await server.suggestScopeExpansion(session.token, path.join(root, "course/settings/plugin.js"))).toBeNull();
  });

  it("does not expose all vault attachments for a root-level HTML", async () => {
    await writeFile(path.join(root, "index.html"), "<h1>Root page</h1>");
    await writeFile(path.join(root, "photo.png"), "adjacent companion");
    const session = await server.createSession({ ...options, entryRelativePath: "index.html", resourceFiles: [] });
    expect((await get(session, "/photo.png")).status).toBe(200);
    expect((await get(session, "/course/assets/photo.png")).status).toBe(403);
    expect((await get(session, "/shared/style.css")).status).toBe(403);
  });

  it("loads a declared cross-folder resource alias but refuses a changed unapproved target", async () => {
    await writeFile(path.join(root, "shared/real.png"), "declared-image");
    await writeFile(path.join(root, "shared/other.png"), "unapproved-image");
    const alias = path.join(root, "shared/alias.png");
    await symlink(path.join(root, "shared/real.png"), alias);
    await writeFile(path.join(root, "course/index.html"), '<img src="../shared/alias.png">');
    const analysis = await analyzePreviewScope(root, options.entryRelativePath);
    const session = await server.createSession({ ...options, scopeRelativePath: analysis.scopeRelativePath,
      resourceFiles: analysis.dependencyRelativePaths });
    expect((await get(session, "/shared/alias.png")).body).toBe("declared-image");
    await rm(alias); await symlink(path.join(root, "shared/other.png"), alias);
    expect((await get(session, "/shared/alias.png")).status).toBe(403);
  });

  it("loads case aliases on a case-insensitive filesystem", async context => {
    await writeFile(path.join(root, "shared/real.png"), "declared-image");
    try { await realpath(path.join(root, "SHARED/REAL.PNG")); }
    catch { context.skip(); return; }
    await writeFile(path.join(root, "course/index.html"), '<img src="../SHARED/REAL.PNG">');
    const analysis = await analyzePreviewScope(root, options.entryRelativePath);
    const session = await server.createSession({ ...options, resourceFiles: analysis.dependencyRelativePaths });
    expect((await get(session, "/SHARED/REAL.PNG")).body).toBe("declared-image");
  });

  for (const kind of ["linked", "case alias"]) it(`protects the actual configuration directory through a ${kind} path`, async context => {
    await mkdir(path.join(root, "visible-config"));
    await writeFile(path.join(root, "visible-config/plugin.js"), "configuration-script");
    await writeFile(path.join(root, "visible-config/data.json"), "configuration-data");
    const configuredPath = kind === "linked" ? ".linked-config" : "VISIBLE-CONFIG";
    if (kind === "linked") await symlink(path.join(root, "visible-config"), path.join(root, configuredPath), "dir");
    try { await realpath(path.join(root, configuredPath)); }
    catch { context.skip(); return; }
    await server.stop();
    server = new PreviewServer(root, { protectedDirectories: [configuredPath] });
    const session = await server.createSession({ ...options,
      resourceFiles: ["visible-config/plugin.js"], approvedFiles: ["visible-config/data.json"] });
    expect((await get(session, "/visible-config/plugin.js")).status).toBe(403);
    expect((await get(session, "/visible-config/data.json")).status).toBe(403);
    expect(await server.suggestScopeExpansion(session.token, path.join(root, "visible-config/data.json"))).toBeNull();
  });

  it("rechecks a configuration directory link changed during a live session", async () => {
    await mkdir(path.join(root, "visible-config"));
    await writeFile(path.join(root, "visible-config/plugin.js"), "new-configuration-script");
    const configLink = path.join(root, ".linked-config");
    await symlink(path.join(root, ".private-config"), configLink, "dir");
    await server.stop();
    server = new PreviewServer(root, { protectedDirectories: [".linked-config"] });
    const session = await server.createSession({ ...options, resourceFiles: ["visible-config/plugin.js"] });
    await rm(configLink); await symlink(path.join(root, "visible-config"), configLink, "dir");
    expect((await get(session, "/visible-config/plugin.js")).status).toBe(403);
  });
});

function get(session: PreviewSession, pathname: string): Promise<{
  status: number; body: string; headers: Record<string, string | string[] | undefined>;
}> {
  const url = new URL(session.origin);
  return new Promise((resolve, reject) => {
    const call = request({ host: "127.0.0.1", port: url.port, path: pathname, headers: { Host: url.host } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString(), headers: response.headers }));
      response.on("error", reject);
    });
    call.on("error", reject);
    call.end();
  });
}
