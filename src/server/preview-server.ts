import type { ReadStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  request as httpRequest,
  type Server,
  type ServerResponse
} from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { clearTimeout as cancelProbeTimeout, setTimeout as scheduleProbeTimeout } from "node:timers";
import type { PreviewMode } from "../settings";
import { getContentSecurityPolicy, getPermissionsPolicy } from "./security-policy";
import { getMimeType } from "./mime-types";
import { assertUtf8HtmlEncoding, assertValidUtf8, UnsupportedHtmlEncodingError } from "./html-encoding";
import { decodeRequestPath, encodeRelativeUrlPath, isPathInside, PathRequestError, toVaultRelativePath } from "./path-safety";
import { parseByteRange } from "./range";
import {
  injectSearchBridge,
  injectSearchBridgeBuffer,
  MAX_SEARCH_BRIDGE_HTML_BYTES
} from "./search-bridge";
import { SearchTransformLimiter } from "./search-transform-limiter";
import { HtmlSnapshotLimiter } from "./html-snapshot-limiter";
import {
  openVerifiedFile,
  type VerifiedFile,
  VerifiedFileError,
  type VerifiedFileHooks
} from "./verified-file";

const HEADERS_TIMEOUT_MS = 10_000;
const KEEP_ALIVE_TIMEOUT_MS = 3_000;
const MAX_DIAGNOSTICS_PER_SESSION = 200;
const MAX_HEADERS_COUNT = 100;
export const MAX_HTML_PREVIEW_BYTES = 32 * 1024 * 1024;
const MAX_REQUESTS_PER_SOCKET = 100;
const MAX_RUNTIME_RESOURCES_PER_SESSION = 2_000;
const REQUEST_TIMEOUT_MS = 15_000;
const SOCKET_IDLE_TIMEOUT_MS = 30_000;
const HTML_VALIDATION_QUEUE_TIMEOUT_MS = 10_000;
export const PREVIEW_SESSION_PROBE_TIMEOUT_MS = 5_000;
export const PREVIEW_DOCUMENT_LOAD_TIMEOUT_MS = 15_000;

export interface PreviewServerLimits {
  maxActiveFileVerifications: number;
  maxActiveHtmlValidations: number;
  maxActiveResponses: number;
  maxActiveSessions: number;
  maxActiveStreams: number;
  maxActiveSearchTransforms: number;
  maxConcurrentFileVerificationsPerSession: number;
  maxConcurrentHtmlValidationsPerSession: number;
  maxConcurrentRequestsPerSession: number;
  maxConcurrentStreamsPerSession: number;
  maxConcurrentSearchTransformsPerSession: number;
  maxPendingCreations: number;
  maxPendingHtmlValidations: number;
  maxPendingHtmlValidationsPerSession: number;
  maxSockets: number;
}

export const PREVIEW_SERVER_HARD_LIMITS: Readonly<PreviewServerLimits> = Object.freeze({
  maxActiveFileVerifications: 64,
  maxActiveHtmlValidations: 2,
  maxActiveResponses: 256,
  maxActiveSessions: 64,
  maxActiveStreams: 128,
  maxActiveSearchTransforms: 2,
  maxConcurrentFileVerificationsPerSession: 8,
  maxConcurrentHtmlValidationsPerSession: 1,
  maxConcurrentRequestsPerSession: 24,
  maxConcurrentStreamsPerSession: 12,
  maxConcurrentSearchTransformsPerSession: 1,
  maxPendingCreations: 8,
  maxPendingHtmlValidations: 64,
  maxPendingHtmlValidationsPerSession: 8,
  maxSockets: 256
});

export interface PreviewServerResourceUsage {
  activeFileVerifications: number;
  activeHtmlValidations: number;
  activeResponses: number;
  activeSessions: number;
  activeStreams: number;
  activeSearchTransforms: number;
  pendingCreations: number;
  pendingHtmlValidations: number;
  sockets: number;
}

export type PreviewCapacityResource = "active-sessions" | "pending-creations";

export class PreviewCapacityError extends Error {
  readonly code = "PREVIEW_CAPACITY";

  constructor(
    readonly resource: PreviewCapacityResource,
    readonly limit: number
  ) {
    super(resource === "active-sessions"
      ? `预览会话已达到上限（${limit}），请先关闭一些 HTML 预览，或等待浏览器会话到期后再试`
      : `正在创建的预览已达到上限（${limit}），请稍后再试`);
    this.name = "PreviewCapacityError";
  }
}

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
  afterHtmlSnapshotReady?: (resolvedPath: string) => Promise<void> | void;
  fileVerificationHooks?: VerifiedFileHooks;
  limits?: Partial<PreviewServerLimits>;
  onDiagnostic?: (diagnostic: PreviewDiagnostic) => void;
  onResourceAccess?: (access: PreviewResourceAccess) => void;
  onServerError?: (error: Error) => void;
  probeTimeoutMs?: number;
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

export interface PreviewSessionProbeResult {
  cancelled?: boolean;
  ok: boolean;
  searchBridgeAvailable?: boolean;
  statusCode: number;
}

export interface PreviewDocumentLoadTicket {
  cancel: () => void;
  completion: Promise<PreviewSessionProbeResult>;
  url: string;
}

export interface PreviewScopeExpansionSuggestion {
  scopeRelativePath: string;
  targetRelativePath: string;
}

interface InternalSession extends PreviewSession {
  activeFileVerifications: Set<AbortController>;
  activeHtmlValidations: Set<AbortController>;
  activeResponses: Set<ServerResponse>;
  activeSearchTransforms: Set<AbortController>;
  activeStreams: Set<ReadStream>;
  bridgeNonce?: string;
  entryAbsolutePath: string;
  pendingDocumentLoad?: InternalDocumentLoadTicket;
  reportedDiagnostics: Set<string>;
  reportedResources: Set<string>;
  revoked: boolean;
  scopeAbsolutePath: string;
}

interface InternalDocumentLoadTicket {
  claimed: boolean;
  response?: ServerResponse;
  searchBridgeAvailable: boolean;
  settle: (result: PreviewSessionProbeResult) => void;
  target: string;
}

interface FileVerificationLease {
  controller: AbortController;
  release: () => void;
}

export class PreviewServer {
  private readonly activeFileVerifications = new Set<AbortController>();
  private readonly activeHtmlValidations = new Set<AbortController>();
  private readonly activeResponses = new Set<ServerResponse>();
  private readonly activeStreams = new Set<ReadStream>();
  private readonly htmlSnapshotLimiter: HtmlSnapshotLimiter;
  private readonly searchTransformLimiter = new SearchTransformLimiter();
  private disposed = false;
  private lifecycleGeneration = 0;
  private readonly limits: PreviewServerLimits;
  private readonly probeTimeoutMs: number;
  private pendingCreationsDrained: Promise<void> | null = null;
  private pendingCreations = 0;
  private resolvePendingCreationsDrained: (() => void) | null = null;
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
  ) {
    this.limits = resolvePreviewServerLimits(options.limits);
    this.htmlSnapshotLimiter = new HtmlSnapshotLimiter({
      maxActive: this.limits.maxActiveHtmlValidations,
      maxActivePerSession: this.limits.maxConcurrentHtmlValidationsPerSession,
      maxPending: this.limits.maxPendingHtmlValidations,
      maxPendingPerSession: this.limits.maxPendingHtmlValidationsPerSession,
      waitTimeoutMs: HTML_VALIDATION_QUEUE_TIMEOUT_MS
    });
    this.probeTimeoutMs = resolveProbeTimeout(options.probeTimeoutMs);
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  get resourceUsage(): PreviewServerResourceUsage {
    return {
      activeFileVerifications: this.activeFileVerifications.size,
      activeHtmlValidations: this.activeHtmlValidations.size,
      activeResponses: this.activeResponses.size,
      activeSessions: this.sessions.size,
      activeStreams: this.activeStreams.size,
      activeSearchTransforms: this.searchTransformLimiter.activeCount,
      pendingCreations: this.pendingCreations,
      pendingHtmlValidations: this.htmlSnapshotLimiter.pendingCount,
      sockets: this.sockets.size
    };
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
    this.reservePendingCreation();
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

      const token = this.createUniqueToken();
      const relativeEntry = path.relative(scopeAbsolutePath, entryAbsolutePath);
      const searchBridgeEnabled = Boolean(
        options.enableSearchBridge
        && entryStats.size <= MAX_SEARCH_BRIDGE_HTML_BYTES
      );
      const origin = `http://${token}.localhost:${this.port}`;
      const session: InternalSession = {
        id: randomBytes(12).toString("hex"),
        token,
        mode: options.mode ?? "safe",
        origin,
        entryUrl: `${origin}/${encodeRelativeUrlPath(relativeEntry)}`,
        searchChannel: searchBridgeEnabled ? randomBytes(24).toString("hex") : undefined,
        scopeRelativePath: toVaultRelativePath(vaultRoot, scopeAbsolutePath),
        scopeAbsolutePath,
        bridgeNonce: searchBridgeEnabled ? randomBytes(18).toString("hex") : undefined,
        entryAbsolutePath,
        activeFileVerifications: new Set(),
        activeHtmlValidations: new Set(),
        activeResponses: new Set(),
        activeSearchTransforms: new Set(),
        activeStreams: new Set(),
        reportedDiagnostics: new Set(),
        reportedResources: new Set(),
        revoked: false
      };

      this.sessions.set(token, session);
      created = true;
      return this.toPublicSession(session);
    } finally {
      this.releasePendingCreation();
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
      await this.pendingCreationsDrained;
      return;
    }
    this.disposed = true;
    this.lifecycleGeneration += 1;
    this.htmlSnapshotLimiter.stop();
    this.sessions.forEach(session => this.deactivateSession(session));
    this.sessions.clear();
    await this.stopListener();
    await this.pendingCreationsDrained;
  }

  async probeSessionEntry(token: string, signal?: AbortSignal): Promise<PreviewSessionProbeResult> {
    if (signal?.aborted) return { cancelled: true, ok: false, statusCode: 499 };
    if (this.disposed) return { ok: false, statusCode: 503 };
    const session = this.sessions.get(token);
    if (!session || !this.isSessionActive(session)) return { ok: false, statusCode: 403 };
    const port = this.port;
    if (port === null) return { ok: false, statusCode: 503 };
    let entryUrl: URL;
    try {
      entryUrl = new URL(session.entryUrl);
    } catch (error) {
      this.reportObserverError(error);
      return { ok: false, statusCode: 503 };
    }

    return new Promise<PreviewSessionProbeResult>(resolve => {
      let settled = false;
      let timeout: ReturnType<typeof scheduleProbeTimeout> | undefined;
      const settle = (result: PreviewSessionProbeResult): void => {
        if (settled) return;
        settled = true;
        if (timeout) cancelProbeTimeout(timeout);
        signal?.removeEventListener("abort", abortProbe);
        resolve(result);
      };
      const probe = httpRequest({
        headers: { Host: entryUrl.host },
        host: "127.0.0.1",
        method: "HEAD",
        path: `${entryUrl.pathname}${entryUrl.search}`,
        port
      }, response => {
        const statusCode = response.statusCode ?? 503;
        response.resume();
        response.once("aborted", () => settle({ ok: false, statusCode: 503 }));
        response.once("error", () => settle({ ok: false, statusCode: 503 }));
        response.once("end", () => settle({
          ok: statusCode >= 200 && statusCode < 300,
          statusCode
        }));
      });
      probe.once("error", () => settle({ ok: false, statusCode: 503 }));
      const abortProbe = (): void => {
        settle({ cancelled: true, ok: false, statusCode: 499 });
        probe.destroy();
      };
      signal?.addEventListener("abort", abortProbe, { once: true });
      if (signal?.aborted) {
        abortProbe();
        return;
      }
      timeout = scheduleProbeTimeout(() => {
        settle({ ok: false, statusCode: 504 });
        probe.destroy();
      }, this.probeTimeoutMs);
      probe.end();
    }).catch(error => {
      this.reportObserverError(error);
      return { ok: false, statusCode: 503 };
    });
  }

  beginSessionDocumentLoad(token: string, targetUrl: string): PreviewDocumentLoadTicket {
    if (this.disposed) throw new Error("预览服务已经永久停止");
    const session = this.sessions.get(token);
    if (!session || !this.isSessionActive(session)) throw new Error("预览会话无效或已结束");
    const target = new URL(targetUrl);
    if (target.origin !== session.origin) throw new Error("候选页面不属于当前预览会话");
    const targetRequest = `${target.pathname}${target.search}`;
    session.pendingDocumentLoad?.settle({ ok: false, statusCode: 409 });

    let resolveCompletion!: (result: PreviewSessionProbeResult) => void;
    const completion = new Promise<PreviewSessionProbeResult>(resolve => {
      resolveCompletion = resolve;
    });
    let settled = false;
    let timeout: ReturnType<typeof scheduleProbeTimeout> | undefined;
    const ticket: InternalDocumentLoadTicket = {
      claimed: false,
      searchBridgeAvailable: false,
      target: targetRequest,
      settle: result => {
        if (settled) return;
        settled = true;
        if (timeout) cancelProbeTimeout(timeout);
        if (session.pendingDocumentLoad === ticket) session.pendingDocumentLoad = undefined;
        resolveCompletion(result);
      }
    };
    session.pendingDocumentLoad = ticket;
    timeout = scheduleProbeTimeout(() => ticket.settle({ ok: false, statusCode: 504 }), PREVIEW_DOCUMENT_LOAD_TIMEOUT_MS);
    return {
      cancel: () => ticket.settle({ ok: false, statusCode: 499 }),
      completion,
      url: target.toString()
    };
  }

  async suggestScopeExpansion(
    token: string,
    resolvedPath: string
  ): Promise<PreviewScopeExpansionSuggestion | null> {
    if (this.disposed || !path.isAbsolute(resolvedPath)) return null;
    const session = this.sessions.get(token);
    if (!session || !this.isSessionActive(session)) return null;
    const vaultRoot = await this.getVaultRootRealPath();
    if (!isPathInside(vaultRoot, resolvedPath) || isPathInside(session.scopeAbsolutePath, resolvedPath)) {
      return null;
    }
    const verification = this.acquireFileVerification(session);
    if (typeof verification === "number") return null;

    let verifiedFile: VerifiedFile | undefined;
    try {
      verifiedFile = await openVerifiedFile(resolvedPath, vaultRoot, {
        ...this.options.fileVerificationHooks,
        signal: verification.controller.signal
      });
      if (!this.isSessionActive(session)) return null;
      if (isPathInside(session.scopeAbsolutePath, verifiedFile.resolvedPath)) return null;
      const expandedScope = findCommonDirectory(session.scopeAbsolutePath, verifiedFile.resolvedPath);
      if (!isPathInside(vaultRoot, expandedScope)) return null;
      return {
        scopeRelativePath: toVaultRelativePath(vaultRoot, expandedScope),
        targetRelativePath: toVaultRelativePath(vaultRoot, verifiedFile.resolvedPath)
      };
    } catch (error) {
      if (!(error instanceof VerifiedFileError) && !verification.controller.signal.aborted) {
        this.reportObserverError(error);
      }
      return null;
    } finally {
      await verifiedFile?.fileHandle.close().catch(error => this.reportObserverError(error));
      verification.release();
    }
  }

  private reservePendingCreation(): void {
    if (this.pendingCreations >= this.limits.maxPendingCreations) {
      throw new PreviewCapacityError("pending-creations", this.limits.maxPendingCreations);
    }
    if (this.sessions.size + this.pendingCreations >= this.limits.maxActiveSessions) {
      throw new PreviewCapacityError("active-sessions", this.limits.maxActiveSessions);
    }
    if (this.pendingCreations === 0) {
      this.pendingCreationsDrained = new Promise(resolve => {
        this.resolvePendingCreationsDrained = resolve;
      });
    }
    this.pendingCreations += 1;
  }

  private releasePendingCreation(): void {
    this.pendingCreations -= 1;
    if (this.pendingCreations !== 0) return;
    this.resolvePendingCreationsDrained?.();
    this.resolvePendingCreationsDrained = null;
    this.pendingCreationsDrained = null;
  }

  private createUniqueToken(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = randomBytes(16).toString("hex");
      if (!this.sessions.has(token)) return token;
    }
    throw new Error("预览服务无法生成唯一会话令牌");
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
        if (this.sockets.size >= this.limits.maxSockets) {
          socket.destroy();
          return;
        }
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
      this.activeStreams.clear();
      this.activeResponses.forEach(response => response.destroy());
      this.activeResponses.clear();
      this.sockets.forEach(socket => socket.destroy());
      this.sockets.clear();
      server?.closeIdleConnections();
      server?.closeAllConnections();
      if (!server) return;

      await new Promise<void>((resolve, reject) => {
        try {
          server.close(error => error ? reject(error) : resolve());
          server.closeIdleConnections();
          server.closeAllConnections();
          this.sockets.forEach(socket => socket.destroy());
          this.sockets.clear();
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
      if (!this.trackGlobalResponse(response)) {
        if (request.method === "GET") {
          session = this.findSessionByHost(request.headers.host);
          if (session) {
            this.trackPendingDocumentLoad(session, request, response, rawPath);
            this.reportDiagnostic({
              statusCode: 503,
              reason: "server-error",
              requestPath: rawPath,
              sessionId: session.id
            }, session);
          }
        }
        response.statusCode = 503;
        response.destroy();
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        this.respondWithError(response, 405, "只允许读取预览资源", "invalid-method", rawPath);
        return;
      }

      session = this.findSessionByHost(request.headers.host);
      if (!session) {
        this.respondWithError(response, 403, "预览会话无效或已结束", "invalid-host", rawPath);
        return;
      }
      this.trackPendingDocumentLoad(session, request, response, rawPath);
      if (!this.trackSessionResponse(session, response)) {
        this.respondWithError(
          response,
          429,
          "这个预览正在读取的资源过多，请稍后重试",
          "server-error",
          rawPath,
          session
        );
        return;
      }
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

      const verification = this.acquireFileVerification(session);
      if (typeof verification === "number") {
        this.respondWithError(
          response,
          verification,
          "预览服务正在核对的文件过多，请稍后重试",
          "server-error",
          rawPath,
          session
        );
        return;
      }

      let verifiedFile;
      const abortVerification = (): void => verification.controller.abort();
      let verificationReleased = false;
      const releaseVerification = (): void => {
        if (verificationReleased) return;
        verificationReleased = true;
        response.removeListener("close", abortVerification);
        verification.release();
      };
      response.once("close", abortVerification);
      try {
        verifiedFile = await openVerifiedFile(
          candidate,
          session.scopeAbsolutePath,
          {
            ...this.options.fileVerificationHooks,
            signal: verification.controller.signal
          }
        );
      } catch (error) {
        releaseVerification();
        if (verification.controller.signal.aborted || response.destroyed) return;
        if (error instanceof VerifiedFileError) {
          const reason: PreviewFailureReason = error.reason === "outside-scope"
            ? "outside-scope"
            : error.reason === "missing-file" || error.reason === "not-file"
              ? "missing-file"
              : "server-error";
          this.respondWithError(response, error.statusCode, error.message, reason, rawPath, session, candidate);
          return;
        }
        throw error;
      }
      if (response.destroyed || response.writableEnded || !this.isSessionActive(session)) {
        releaseVerification();
        await verifiedFile.fileHandle.close().catch(error => this.reportObserverError(error));
        response.destroy();
        return;
      }
      releaseVerification();

      let fileHandle: typeof verifiedFile.fileHandle | undefined = verifiedFile.fileHandle;
      const { fileStats, resolvedPath } = verifiedFile;
      let htmlBuffer: Buffer | undefined;
      let htmlValidation: FileVerificationLease | undefined;
      const releaseHtmlValidation = (): void => {
        htmlValidation?.release();
        htmlValidation = undefined;
      };
      const retainHtmlSnapshotUntilSent = (): void => {
        const validation = htmlValidation;
        htmlValidation = undefined;
        if (!validation) return;
        response.once("finish", validation.release);
        response.once("close", validation.release);
      };
      try {
        this.reportResourceAccess(session, rawPath, resolvedPath);

        const extension = path.extname(resolvedPath).toLowerCase();
        if (extension === ".html" || extension === ".htm") {
          if (fileStats.size > MAX_HTML_PREVIEW_BYTES) {
            this.respondWithError(
              response,
              413,
              `单个 HTML 最多 ${MAX_HTML_PREVIEW_BYTES / (1024 * 1024)} MiB，请把内嵌大资源拆为独立文件后重试`,
              "server-error",
              rawPath,
              session,
              resolvedPath
            );
            return;
          }
          const validationWaitController = new AbortController();
          const abortValidationWait = (): void => validationWaitController.abort();
          response.once("close", abortValidationWait);
          const acquiredValidation = await this.acquireHtmlValidation(
            session,
            validationWaitController.signal
          );
          response.removeListener("close", abortValidationWait);
          if (acquiredValidation === null) return;
          if (typeof acquiredValidation === "number") {
            this.respondWithError(
              response,
              acquiredValidation,
              "预览服务正在核对其他 HTML，请稍后重试",
              "server-error",
              rawPath,
              session,
              resolvedPath
            );
            return;
          }
          if (response.destroyed || !this.isSessionActive(session)) {
            acquiredValidation.release();
            return;
          }
          htmlValidation = acquiredValidation;
          const abortValidation = (): void => acquiredValidation.controller.abort();
          response.once("close", abortValidation);
          try {
            const snapshot = await readExactFileHandle(
              fileHandle,
              fileStats.size,
              acquiredValidation.controller.signal
            );
            if (!snapshot) {
              this.respondWithError(
                response,
                409,
                "HTML 在读取期间发生变化，请刷新后重试",
                "server-error",
                rawPath,
                session,
                resolvedPath
              );
              return;
            }
            await this.options.afterHtmlSnapshotReady?.(resolvedPath);
            assertUtf8HtmlEncoding(snapshot);
            assertValidUtf8(snapshot);
            htmlBuffer = snapshot;
          } catch (error) {
            if (acquiredValidation.controller.signal.aborted || response.destroyed || !this.isSessionActive(session)) {
              response.destroy();
              return;
            }
            if (error instanceof UnsupportedHtmlEncodingError) {
              this.respondWithError(
                response,
                415,
                error.message,
                "server-error",
                rawPath,
                session,
                resolvedPath
              );
              return;
            }
            throw error;
          } finally {
            response.removeListener("close", abortValidation);
          }
        }

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
        const pendingTicket = session.pendingDocumentLoad;
        if (pendingTicket?.response === response) {
          pendingTicket.searchBridgeAvailable = Boolean(bridgeNonce && session.searchChannel);
        }
        if (bridgeNonce && session.searchChannel) {
          if (request.method === "HEAD") {
            const injectedSuffixBytes = Buffer.byteLength(
              injectSearchBridge(
                "",
                bridgeNonce,
                session.searchChannel,
                session.mode !== "safe"
              ),
              "utf8"
            );
            response.writeHead(200, {
              ...this.securityHeaders(session.mode, session.origin, bridgeNonce),
              "Accept-Ranges": "none",
              "Content-Length": fileStats.size + injectedSuffixBytes,
              "Content-Type": "text/html; charset=utf-8"
            });
            retainHtmlSnapshotUntilSent();
            response.end();
            return;
          }
          const searchTransform = this.acquireSearchTransform(session);
          if (!searchTransform) {
            this.respondWithError(
              response,
              429,
              "本地查找正在处理其他页面，请稍后刷新重试",
              "server-error",
              rawPath,
              session,
              resolvedPath
            );
            return;
          }
          const abortSearchTransform = (): void => searchTransform.controller.abort();
          response.once("close", abortSearchTransform);
          try {
              if (!htmlBuffer) throw new Error("HTML 快照没有准备完成");
              if (!this.isSessionActive(session)) {
                response.destroy();
                return;
              }
              const body = injectSearchBridgeBuffer(
                htmlBuffer,
                bridgeNonce,
                session.searchChannel,
                session.mode !== "safe"
              );
              response.writeHead(200, {
                ...this.securityHeaders(session.mode, session.origin, bridgeNonce),
                "Accept-Ranges": "none",
                "Content-Length": body.byteLength,
                "Content-Type": "text/html; charset=utf-8"
              });
              retainHtmlSnapshotUntilSent();
              response.end(body);
              return;
          } catch (error) {
            if (searchTransform.controller.signal.aborted || response.destroyed || !this.isSessionActive(session)) {
              response.destroy();
              return;
            }
            throw error;
          } finally {
            response.removeListener("close", abortSearchTransform);
            searchTransform.release();
          }
        }

        const contentLength = range ? range.end - range.start + 1 : fileStats.size;
        const headers: Record<string, string | number> = {
          ...this.securityHeaders(session.mode, session.origin),
          "Accept-Ranges": "bytes",
          "Content-Length": contentLength,
          "Content-Type": getMimeType(path.extname(resolvedPath))
        };
        if (range) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${fileStats.size}`;

        if (htmlBuffer) {
          response.writeHead(range ? 206 : 200, headers);
          retainHtmlSnapshotUntilSent();
          if (request.method === "HEAD") response.end();
          else response.end(range ? htmlBuffer.subarray(range.start, range.end + 1) : htmlBuffer);
          return;
        }

        if (request.method !== "HEAD") {
          const streamCapacityStatus = this.getStreamCapacityStatus(session);
          if (streamCapacityStatus !== null) {
            this.respondWithError(
              response,
              streamCapacityStatus,
              "预览服务当前文件传输过多，请稍后重试",
              "server-error",
              rawPath,
              session
            );
            return;
          }
        }

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
        releaseVerification();
        releaseHtmlValidation();
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

  private trackGlobalResponse(response: ServerResponse): boolean {
    if (this.activeResponses.size >= this.limits.maxActiveResponses) return false;
    this.activeResponses.add(response);
    const release = (): void => {
      this.activeResponses.delete(response);
    };
    response.once("finish", release);
    response.once("close", release);
    return true;
  }

  private trackSessionResponse(session: InternalSession, response: ServerResponse): boolean {
    if (session.activeResponses.size >= this.limits.maxConcurrentRequestsPerSession) return false;
    session.activeResponses.add(response);
    const release = (): void => {
      session.activeResponses.delete(response);
    };
    response.once("finish", release);
    response.once("close", release);
    return true;
  }

  private trackPendingDocumentLoad(
    session: InternalSession,
    request: IncomingMessage,
    response: ServerResponse,
    rawPath: string
  ): void {
    const ticket = session.pendingDocumentLoad;
    if (!ticket || ticket.claimed || request.method !== "GET") return;
    let requestTarget: string;
    try {
      const url = new URL(rawPath, session.origin);
      requestTarget = `${url.pathname}${url.search}`;
    } catch {
      return;
    }
    if (requestTarget !== ticket.target) return;
    ticket.claimed = true;
    ticket.response = response;
    let finished = false;
    response.once("finish", () => {
      finished = true;
      const statusCode = response.statusCode || 503;
      ticket.settle({
        ok: statusCode >= 200 && statusCode < 300,
        ...(ticket.searchBridgeAvailable ? { searchBridgeAvailable: true } : {}),
        statusCode
      });
    });
    response.once("close", () => {
      if (!finished) ticket.settle({ ok: false, statusCode: 503 });
    });
  }

  private acquireFileVerification(session: InternalSession): FileVerificationLease | 429 | 503 {
    if (session.activeFileVerifications.size >= this.limits.maxConcurrentFileVerificationsPerSession) {
      return 429;
    }
    if (this.activeFileVerifications.size >= this.limits.maxActiveFileVerifications) return 503;

    const controller = new AbortController();
    session.activeFileVerifications.add(controller);
    this.activeFileVerifications.add(controller);
    let released = false;
    return {
      controller,
      release: () => {
        if (released) return;
        released = true;
        session.activeFileVerifications.delete(controller);
        this.activeFileVerifications.delete(controller);
      }
    };
  }

  private async acquireHtmlValidation(
    session: InternalSession,
    signal: AbortSignal
  ): Promise<FileVerificationLease | 429 | 503 | null> {
    const permit = await this.htmlSnapshotLimiter.acquire(session.id, signal);
    if (permit.status === "cancelled") return null;
    if (permit.status === "rejected") return permit.statusCode;
    if (signal.aborted || !this.isSessionActive(session)) {
      permit.release();
      return null;
    }
    const controller = new AbortController();
    session.activeHtmlValidations.add(controller);
    this.activeHtmlValidations.add(controller);
    let released = false;
    return {
      controller,
      release: () => {
        if (released) return;
        released = true;
        session.activeHtmlValidations.delete(controller);
        this.activeHtmlValidations.delete(controller);
        permit.release();
      }
    };
  }

  private getStreamCapacityStatus(session: InternalSession): 429 | 503 | null {
    if (session.activeStreams.size >= this.limits.maxConcurrentStreamsPerSession) return 429;
    if (this.activeStreams.size >= this.limits.maxActiveStreams) return 503;
    return null;
  }

  private acquireSearchTransform(session: InternalSession): FileVerificationLease | null {
    const releaseCapacity = this.searchTransformLimiter.acquire(
      session.id,
      this.limits.maxActiveSearchTransforms,
      this.limits.maxConcurrentSearchTransformsPerSession
    );
    if (!releaseCapacity) return null;
    const controller = new AbortController();
    session.activeSearchTransforms.add(controller);
    let released = false;
    return {
      controller,
      release: () => {
        if (released) return;
        released = true;
        session.activeSearchTransforms.delete(controller);
        releaseCapacity();
      }
    };
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
    this.htmlSnapshotLimiter.cancelSession(session.id);
    session.pendingDocumentLoad?.settle({ ok: false, statusCode: 403 });
    session.activeFileVerifications.forEach(controller => controller.abort());
    session.activeHtmlValidations.forEach(controller => controller.abort());
    session.activeSearchTransforms.forEach(controller => controller.abort());
    [...session.activeResponses].forEach(response => {
      this.activeResponses.delete(response);
      response.destroy();
    });
    [...session.activeStreams].forEach(stream => {
      this.activeStreams.delete(stream);
      stream.destroy();
    });
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
    const extension = path.extname(resolvedPath).toLowerCase();
    if ((extension !== ".html" && extension !== ".htm") || fileSize > MAX_SEARCH_BRIDGE_HTML_BYTES) {
      return undefined;
    }
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

function resolvePreviewServerLimits(overrides: Partial<PreviewServerLimits> | undefined): PreviewServerLimits {
  const limits: PreviewServerLimits = { ...PREVIEW_SERVER_HARD_LIMITS };
  if (!overrides) return limits;

  for (const key of Object.keys(overrides) as Array<keyof PreviewServerLimits>) {
    const value = overrides[key];
    if (value === undefined || !Number.isFinite(value)) continue;
    limits[key] = Math.max(1, Math.min(PREVIEW_SERVER_HARD_LIMITS[key], Math.floor(value)));
  }
  return limits;
}

function resolveProbeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return PREVIEW_SESSION_PROBE_TIMEOUT_MS;
  return Math.max(10, Math.min(PREVIEW_SESSION_PROBE_TIMEOUT_MS, Math.floor(value)));
}

function findCommonDirectory(currentScope: string, targetFile: string): string {
  let candidate = currentScope;
  while (!isPathInside(candidate, targetFile)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return parent;
    candidate = parent;
  }
  return candidate;
}

async function readExactFileHandle(
  fileHandle: VerifiedFile["fileHandle"],
  expectedBytes: number,
  signal?: AbortSignal
): Promise<Buffer | null> {
  throwIfAborted(signal);
  const initialStats = await fileHandle.stat({ bigint: true });
  throwIfAborted(signal);
  if (initialStats.size !== BigInt(expectedBytes)) return null;
  const buffer = Buffer.allocUnsafe(expectedBytes);
  let offset = 0;
  while (offset < buffer.length) {
    throwIfAborted(signal);
    const length = Math.min(256 * 1024, buffer.length - offset);
    const result = await fileHandle.read(buffer, offset, length, offset);
    throwIfAborted(signal);
    if (result.bytesRead === 0) return null;
    offset += result.bytesRead;
  }
  throwIfAborted(signal);
  const latestStats = await fileHandle.stat({ bigint: true });
  throwIfAborted(signal);
  return latestStats.dev === initialStats.dev
    && latestStats.ino === initialStats.ino
    && latestStats.size === initialStats.size
    && latestStats.mtimeNs === initialStats.mtimeNs
    && latestStats.ctimeNs === initialStats.ctimeNs
    ? buffer
    : null;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("Preview file read aborted");
  error.name = "AbortError";
  throw error;
}
