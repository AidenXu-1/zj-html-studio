import { constants as fsConstants, type ReadStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import type { PreviewMode } from "../settings";
import { getContentSecurityPolicy, getPermissionsPolicy } from "./security-policy";
import { getMimeType } from "./mime-types";
import { decodeRequestPath, encodeRelativeUrlPath, isPathInside, PathRequestError, toVaultRelativePath } from "./path-safety";
import { parseByteRange } from "./range";
import { injectSearchBridge, MAX_SEARCH_BRIDGE_HTML_BYTES } from "./search-bridge";

const HEADERS_TIMEOUT_MS = 10_000;
const KEEP_ALIVE_TIMEOUT_MS = 3_000;
const MAX_DIAGNOSTICS_PER_SESSION = 200;
const MAX_HEADERS_COUNT = 100;
const MAX_REQUESTS_PER_SOCKET = 100;
const MAX_RUNTIME_RESOURCES_PER_SESSION = 2_000;
const REQUEST_TIMEOUT_MS = 15_000;
const SOCKET_IDLE_TIMEOUT_MS = 30_000;

export type PreviewFailureReason =
  | "diagnostic-limit"
  | "invalid-host"
  | "invalid-method"
  | "invalid-path"
  | "missing-file"
  | "outside-scope"
  | "server-error";

export interface PreviewDiagnostic {
  reason: PreviewFailureReason;
  requestPath: string;
  resolvedPath?: string;
  sessionId?: string;
  statusCode: number;
}

export interface PreviewServerOptions {
  onDiagnostic?: (diagnostic: PreviewDiagnostic) => void;
  onResourceAccess?: (access: PreviewResourceAccess) => void;
  onServerError?: (error: Error) => void;
}

export interface PreviewResourceAccess {
  requestPath: string;
  resolvedPath: string;
  sessionId: string;
}

export interface CreatePreviewSessionOptions {
  enableSearchBridge?: boolean;
  entryRelativePath: string;
  mode?: PreviewMode;
  scopeRelativePath: string;
}

export interface PreviewSession {
  entryUrl: string;
  id: string;
  mode: PreviewMode;
  origin: string;
  searchChannel?: string;
  scopeRelativePath: string;
  token: string;
}

interface InternalSession extends PreviewSession {
  activeResponses: Set<ServerResponse>;
  activeStreams: Set<ReadStream>;
  bridgeNonce?: string;
  entryAbsolutePath: string;
  reportedDiagnostics: Set<string>;
  reportedResources: Set<string>;
  revoked: boolean;
  scopeAbsolutePath: string;
}

export class PreviewServer {
  private readonly activeStreams = new Set<ReadStream>();
  private disposed = false;
  private lifecycleGeneration = 0;
  private pendingCreations = 0;
  private port: number | null = null;
  private readonly sessions = new Map<string, InternalSession>();
  private readonly sockets = new Set<Socket>();
  private server: Server | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private vaultRootRealPath: string | null = null;

  constructor(
    private readonly vaultRoot: string,
    private readonly options: PreviewServerOptions = {}
  ) {}

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  get listeningPort(): number | null {
    return this.port;
  }

  get listeningAddress(): string | null {
    const address = this.server?.address();
    return typeof address === "object" && address !== null ? address.address : null;
  }

  async createSession(options: CreatePreviewSessionOptions): Promise<PreviewSession> {
    if (this.disposed) throw new Error("预览服务已经永久停止，不能再创建会话");
    const generation = this.lifecycleGeneration;
    this.pendingCreations += 1;
    let created = false;

    try {
      this.assertGeneration(generation);
      const vaultRoot = await this.getVaultRootRealPath();
      this.assertGeneration(generation);

      const scopeCandidate = path.resolve(vaultRoot, options.scopeRelativePath);
      if (!isPathInside(vaultRoot, scopeCandidate)) {
        throw new Error("预览资源范围超出了仓库");
      }

      const scopeAbsolutePath = await realpath(scopeCandidate);
      const scopeStats = await stat(scopeAbsolutePath);
      this.assertGeneration(generation);
      if (!scopeStats.isDirectory() || !isPathInside(vaultRoot, scopeAbsolutePath)) {
        throw new Error("预览资源范围不是仓库内的目录");
      }

      const entryCandidate = path.resolve(vaultRoot, options.entryRelativePath);
      const entryAbsolutePath = await realpath(entryCandidate);
      const entryStats = await stat(entryAbsolutePath);
      this.assertGeneration(generation);
      if (!entryStats.isFile() || !isPathInside(scopeAbsolutePath, entryAbsolutePath)) {
        throw new Error("HTML 文件不在预览资源范围内");
      }

      await this.ensureStarted(generation);
      this.assertGeneration(generation);
      if (this.port === null) throw new Error("预览服务未能取得端口");

      const token = randomBytes(16).toString("hex");
      const relativeEntry = path.relative(scopeAbsolutePath, entryAbsolutePath);
      const origin = `http://${token}.localhost:${this.port}`;
      const session: InternalSession = {
        id: randomBytes(12).toString("hex"),
        token,
        mode: options.mode ?? "safe",
        origin,
        entryUrl: `${origin}/${encodeRelativeUrlPath(relativeEntry)}`,
        searchChannel: options.enableSearchBridge ? randomBytes(24).toString("hex") : undefined,
        scopeRelativePath: toVaultRelativePath(vaultRoot, scopeAbsolutePath),
        scopeAbsolutePath,
        bridgeNonce: options.enableSearchBridge ? randomBytes(18).toString("hex") : undefined,
        entryAbsolutePath,
        activeResponses: new Set(),
        activeStreams: new Set(),
        reportedDiagnostics: new Set(),
        reportedResources: new Set(),
        revoked: false
      };

      this.sessions.set(token, session);
      created = true;
      return this.toPublicSession(session);
    } finally {
      this.pendingCreations -= 1;
      if (!created && this.pendingCreations === 0 && this.sessions.size === 0) {
        await this.stopListener();
      }
    }
  }

  async revokeSession(token: string): Promise<void> {
    const session = this.sessions.get(token);
    if (session) {
      this.sessions.delete(token);
      this.deactivateSession(session);
    }
    if (this.sessions.size === 0 && this.pendingCreations === 0) await this.stopListener();
  }

  async stop(): Promise<void> {
    if (this.disposed) {
      await this.stopListener();
      return;
    }
    this.disposed = true;
    this.lifecycleGeneration += 1;
    this.sessions.forEach(session => this.deactivateSession(session));
    this.sessions.clear();
    await this.stopListener();
  }

  private assertGeneration(expected: number): void {
    if (this.disposed || expected !== this.lifecycleGeneration) {
      throw new Error("预览服务已经停止，本次加载已取消");
    }
  }

  private async getVaultRootRealPath(): Promise<string> {
    this.vaultRootRealPath ??= await realpath(this.vaultRoot);
    return this.vaultRootRealPath;
  }

  private async ensureStarted(generation: number): Promise<void> {
    if (this.stopPromise) await this.stopPromise;
    this.assertGeneration(generation);
    if (this.server?.listening) return;
    if (this.startPromise) {
      await this.startPromise;
      this.assertGeneration(generation);
      return;
    }

    this.startPromise = this.startListener().finally(() => {
      this.startPromise = null;
    });
    await this.startPromise;
    this.assertGeneration(generation);
  }

  private startListener(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
        void this.handleRequest(request, response);
      });
      server.requestTimeout = REQUEST_TIMEOUT_MS;
      server.headersTimeout = HEADERS_TIMEOUT_MS;
      server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
      server.maxHeadersCount = MAX_HEADERS_COUNT;
      server.maxRequestsPerSocket = MAX_REQUESTS_PER_SOCKET;
      server.setTimeout(SOCKET_IDLE_TIMEOUT_MS, socket => socket.destroy());
      server.on("connection", socket => {
        this.sockets.add(socket);
        socket.once("close", () => this.sockets.delete(socket));
      });
      server.on("clientError", (_error, socket) => socket.destroy());

      const onStartupError = (error: Error): void => {
        try {
          server.close();
        } catch {
          // A bind failure can arrive before the server reaches a closable state.
        }
        reject(error);
      };
      server.once("error", onStartupError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onStartupError);
        server.on("error", error => this.reportObserverError(error));
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          reject(new Error("预览服务未能绑定 TCP 端口"));
          return;
        }
        this.server = server;
        this.port = address.port;
        resolve();
      });
    });
  }

  private async stopListener(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;

    this.stopPromise = (async () => {
      if (this.startPromise) {
        try {
          await this.startPromise;
        } catch {
          // Startup already failed; there may be no listener left to close.
        }
      }

      const server = this.server;
      this.server = null;
      this.port = null;

      this.activeStreams.forEach(stream => stream.destroy());
      this.sockets.forEach(socket => socket.destroy());
      server?.closeIdleConnections();
      server?.closeAllConnections();
      if (!server) return;

      await new Promise<void>((resolve, reject) => {
        try {
          server.close(error => error ? reject(error) : resolve());
          server.closeIdleConnections();
          server.closeAllConnections();
          this.sockets.forEach(socket => socket.destroy());
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ERR_SERVER_NOT_RUNNING") {
            resolve();
          } else {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
      });
    })().finally(() => {
      this.stopPromise = null;
    });

    return this.stopPromise;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const rawPath = request.url ?? "/";
    let session: InternalSession | undefined;

    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        this.respondWithError(response, 405, "只允许读取预览资源", "invalid-method", rawPath);
        return;
      }

      session = this.findSessionByHost(request.headers.host);
      if (!session) {
        this.respondWithError(response, 403, "预览会话无效或已结束", "invalid-host", rawPath);
        return;
      }
      session.activeResponses.add(response);
      response.once("close", () => session?.activeResponses.delete(response));
      if (!this.isSessionActive(session)) {
        response.destroy();
        return;
      }

      const url = new URL(rawPath, session.origin);
      const relativePath = decodeRequestPath(url.pathname);
      const candidate = path.resolve(session.scopeAbsolutePath, relativePath);
      if (!isPathInside(session.scopeAbsolutePath, candidate)) {
        this.respondWithError(response, 403, "资源超出当前预览范围", "outside-scope", rawPath, session, candidate);
        return;
      }

      let resolvedPath: string;
      try {
        resolvedPath = await realpath(candidate);
      } catch {
        this.respondWithError(response, 404, "没有找到这个预览资源", "missing-file", rawPath, session, candidate);
        return;
      }
      if (!this.isSessionActive(session)) {
        response.destroy();
        return;
      }

      if (!isPathInside(session.scopeAbsolutePath, resolvedPath)) {
        this.respondWithError(response, 403, "资源通过链接指向预览范围外", "outside-scope", rawPath, session, resolvedPath);
        return;
      }

      let fileHandle;
      try {
        fileHandle = await open(resolvedPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      } catch {
        this.respondWithError(response, 404, "没有找到这个预览资源", "missing-file", rawPath, session, resolvedPath);
        return;
      }

      try {
        const fileStats = await fileHandle.stat();
        if (!this.isSessionActive(session)) {
          response.destroy();
          return;
        }
        if (!fileStats.isFile()) {
          this.respondWithError(response, 404, "请求目标不是文件", "missing-file", rawPath, session, resolvedPath);
          return;
        }

        this.reportResourceAccess(session, rawPath, resolvedPath);

        const range = parseByteRange(request.headers.range, fileStats.size);
        if (range === "invalid") {
          response.writeHead(416, {
            ...this.securityHeaders(session.mode, session.origin),
            "Accept-Ranges": "bytes",
            "Content-Range": `bytes */${fileStats.size}`
          });
          response.end();
          return;
        }

        const bridgeNonce = this.getBridgeNonce(session, resolvedPath, fileStats.size, range === null);
        if (bridgeNonce && session.searchChannel) {
          const sourceBuffer = Buffer.alloc(fileStats.size);
          const { bytesRead } = await fileHandle.read(sourceBuffer, 0, sourceBuffer.length, 0);
          if (!this.isSessionActive(session)) {
            response.destroy();
            return;
          }
          const source = sourceBuffer.subarray(0, bytesRead).toString("utf8");
          const body = Buffer.from(injectSearchBridge(source, bridgeNonce, session.searchChannel), "utf8");
          response.writeHead(200, {
            ...this.securityHeaders(session.mode, session.origin, bridgeNonce),
            "Accept-Ranges": "none",
            "Content-Length": body.byteLength,
            "Content-Type": "text/html; charset=utf-8"
          });
          if (request.method === "HEAD") response.end();
          else response.end(body);
          return;
        }

        const contentLength = range ? range.end - range.start + 1 : fileStats.size;
        const headers: Record<string, string | number> = {
          ...this.securityHeaders(session.mode, session.origin),
          "Accept-Ranges": "bytes",
          "Content-Length": contentLength,
          "Content-Type": getMimeType(path.extname(resolvedPath))
        };
        if (range) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${fileStats.size}`;

        response.writeHead(range ? 206 : 200, headers);
        if (request.method === "HEAD") {
          response.end();
          return;
        }

        const stream = fileHandle.createReadStream(range ? { start: range.start, end: range.end } : undefined);
        fileHandle = undefined;
        this.activeStreams.add(stream);
        session.activeStreams.add(stream);
        const release = (): void => {
          this.activeStreams.delete(stream);
          session?.activeStreams.delete(stream);
        };
        stream.once("close", release);
        stream.once("error", error => response.destroy(error));
        response.once("close", () => {
          if (!stream.closed) stream.destroy();
        });
        stream.pipe(response);
      } finally {
        if (fileHandle) {
          await fileHandle.close().catch(error => this.reportObserverError(error));
        }
      }
    } catch (error) {
      if (error instanceof PathRequestError) {
        this.respondWithError(response, error.statusCode, error.message, "invalid-path", rawPath, session);
        return;
      }

      this.respondWithError(response, 500, "预览服务读取文件时发生错误", "server-error", rawPath, session);
    }
  }

  private reportResourceAccess(session: InternalSession, requestPath: string, resolvedPath: string): void {
    if (session.reportedResources.has(resolvedPath)) return;
    if (session.reportedResources.size >= MAX_RUNTIME_RESOURCES_PER_SESSION) return;
    session.reportedResources.add(resolvedPath);
    try {
      this.options.onResourceAccess?.({ requestPath, resolvedPath, sessionId: session.id });
    } catch (error) {
      this.reportObserverError(error);
    }
  }

  private isSessionActive(session: InternalSession): boolean {
    return !session.revoked && this.sessions.get(session.token) === session;
  }

  private deactivateSession(session: InternalSession): void {
    if (session.revoked) return;
    session.revoked = true;
    [...session.activeResponses].forEach(response => response.destroy());
    [...session.activeStreams].forEach(stream => stream.destroy());
    session.activeResponses.clear();
    session.activeStreams.clear();
  }

  private findSessionByHost(hostHeader: string | undefined): InternalSession | undefined {
    if (!hostHeader) return undefined;
    try {
      const hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
      if (!hostname.endsWith(".localhost")) return undefined;
      const token = hostname.slice(0, -".localhost".length);
      return this.sessions.get(token);
    } catch {
      return undefined;
    }
  }

  private respondWithError(
    response: ServerResponse,
    statusCode: number,
    message: string,
    reason: PreviewFailureReason,
    requestPath: string,
    session?: InternalSession,
    resolvedPath?: string
  ): void {
    this.reportDiagnostic({
      statusCode,
      reason,
      requestPath,
      resolvedPath,
      sessionId: session?.id
    }, session);

    if (response.headersSent) {
      response.end();
      return;
    }

    response.writeHead(statusCode, {
      ...this.securityHeaders(session?.mode ?? "safe", session?.origin),
      "Content-Type": "text/plain; charset=utf-8"
    });
    response.end(message);
  }

  private reportDiagnostic(diagnostic: PreviewDiagnostic, session?: InternalSession): void {
    if (!session) {
      try {
        this.options.onDiagnostic?.(diagnostic);
      } catch (error) {
        this.reportObserverError(error);
      }
      return;
    }

    const key = `${diagnostic.reason}\u0000${diagnostic.requestPath}\u0000${diagnostic.resolvedPath ?? ""}`;
    if (session.reportedDiagnostics.has(key)) return;
    if (session.reportedDiagnostics.size >= MAX_DIAGNOSTICS_PER_SESSION) {
      const limitKey = "__diagnostic_limit__";
      if (session.reportedDiagnostics.has(limitKey)) return;
      session.reportedDiagnostics.add(limitKey);
      try {
        this.options.onDiagnostic?.({
          reason: "diagnostic-limit",
          requestPath: "",
          sessionId: session.id,
          statusCode: 429
        });
      } catch (error) {
        this.reportObserverError(error);
      }
      return;
    }

    session.reportedDiagnostics.add(key);
    try {
      this.options.onDiagnostic?.(diagnostic);
    } catch (error) {
      this.reportObserverError(error);
    }
  }

  private reportObserverError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    try {
      this.options.onServerError?.(normalized);
    } catch {
      // The final error observer must never break the HTTP request path.
    }
  }

  private getBridgeNonce(
    session: InternalSession,
    resolvedPath: string,
    fileSize: number,
    isFullResponse: boolean
  ): string | undefined {
    if (!isFullResponse || !session.bridgeNonce || !session.searchChannel) return undefined;
    if (resolvedPath !== session.entryAbsolutePath || fileSize > MAX_SEARCH_BRIDGE_HTML_BYTES) return undefined;
    return session.bridgeNonce;
  }

  private securityHeaders(mode: PreviewMode, origin?: string, bridgeNonce?: string): Record<string, string> {
    return {
      "Cache-Control": "no-store",
      "Content-Security-Policy": getContentSecurityPolicy(mode, origin, bridgeNonce),
      "Origin-Agent-Cluster": "?1",
      "Permissions-Policy": getPermissionsPolicy(mode),
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff"
    };
  }

  private toPublicSession(session: InternalSession): PreviewSession {
    return {
      entryUrl: session.entryUrl,
      id: session.id,
      mode: session.mode,
      origin: session.origin,
      searchChannel: session.searchChannel,
      scopeRelativePath: session.scopeRelativePath,
      token: session.token
    };
  }
}
