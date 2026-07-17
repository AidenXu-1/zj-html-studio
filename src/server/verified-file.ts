import { constants as fsConstants, type BigIntStats, type Stats } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { isPathInside } from "./path-safety";

export type VerifiedFileFailureReason =
  | "identity-mismatch"
  | "identity-unavailable"
  | "missing-file"
  | "not-file"
  | "outside-scope";

export class VerifiedFileError extends Error {
  constructor(
    readonly reason: VerifiedFileFailureReason,
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = "VerifiedFileError";
  }
}

export interface VerifiedFile {
  fileHandle: FileHandle;
  fileStats: Stats;
  resolvedPath: string;
}

export interface VerifiedFileHooks {
  afterOpen?: () => Promise<void> | void;
  afterVerification?: () => Promise<void> | void;
  openFile?: (filePath: string, flags: string | number) => Promise<FileHandle>;
  signal?: AbortSignal;
}

export async function openVerifiedFile(
  candidatePath: string,
  allowedRoot: string,
  hooks: VerifiedFileHooks = {}
): Promise<VerifiedFile> {
  throwIfAborted(hooks.signal);
  if (!isPathInside(allowedRoot, candidatePath)) {
    throw new VerifiedFileError("outside-scope", "资源超出当前预览范围", 403);
  }

  let fileHandle: FileHandle;
  try {
    // Open the target first, then bind every path check to that exact handle identity.
    // This also gives in-scope symlinks the same behavior on POSIX and Windows.
    fileHandle = await (hooks.openFile ?? open)(
      candidatePath,
      process.platform === "win32"
        ? "r"
        : fsConstants.O_RDONLY | fsConstants.O_NONBLOCK
    );
  } catch {
    throwIfAborted(hooks.signal);
    await classifyOpenFailure(candidatePath, allowedRoot);
    throw new VerifiedFileError("missing-file", "没有找到这个预览资源", 404);
  }

  try {
    // Cancellation may happen while the OS-level open is still pending. Keep
    // this checkpoint inside the handle-owning try so every successful open
    // is closed before the verification lease can be released.
    throwIfAborted(hooks.signal);
    await runHook(hooks.afterOpen, hooks.signal);
    throwIfAborted(hooks.signal);
    const handleIdentity = await fileHandle.stat({ bigint: true });
    if (!handleIdentity.isFile()) {
      throw new VerifiedFileError("not-file", "请求目标不是文件", 404);
    }
    assertUsableIdentity(handleIdentity);

    const firstResolvedPath = await resolveAfterOpen(candidatePath);
    throwIfAborted(hooks.signal);
    assertInside(allowedRoot, firstResolvedPath);
    const firstPathIdentity = await stat(firstResolvedPath, { bigint: true });
    throwIfAborted(hooks.signal);
    assertSameIdentity(handleIdentity, firstPathIdentity);

    const secondResolvedPath = await resolveAfterOpen(candidatePath);
    throwIfAborted(hooks.signal);
    if (secondResolvedPath !== firstResolvedPath) throw identityMismatch();
    assertInside(allowedRoot, secondResolvedPath);
    const secondPathIdentity = await stat(secondResolvedPath, { bigint: true });
    throwIfAborted(hooks.signal);
    assertSameIdentity(handleIdentity, secondPathIdentity);

    const finalResolvedPath = await resolveAfterOpen(candidatePath);
    throwIfAborted(hooks.signal);
    if (finalResolvedPath !== secondResolvedPath) throw identityMismatch();
    assertInside(allowedRoot, finalResolvedPath);
    const finalHandleIdentity = await fileHandle.stat({ bigint: true });
    throwIfAborted(hooks.signal);
    assertSameIdentity(handleIdentity, finalHandleIdentity);

    const fileStats = await fileHandle.stat();
    await runHook(hooks.afterVerification, hooks.signal);
    throwIfAborted(hooks.signal);
    return {
      fileHandle,
      fileStats,
      resolvedPath: finalResolvedPath
    };
  } catch (error) {
    await fileHandle.close().catch(() => undefined);
    if (error instanceof VerifiedFileError || isAbortError(error)) throw error;
    throw identityMismatch();
  }
}

async function runHook(
  hook: (() => Promise<void> | void) | undefined,
  signal: AbortSignal | undefined
): Promise<void> {
  if (!hook) return;
  throwIfAborted(signal);
  const task = Promise.resolve(hook());
  if (!signal) {
    await task;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => reject(createAbortError());
    signal.addEventListener("abort", abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createAbortError();
}

function createAbortError(): Error {
  const error = new Error("File verification aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function classifyOpenFailure(candidatePath: string, allowedRoot: string): Promise<void> {
  try {
    const resolvedPath = await realpath(candidatePath);
    assertInside(allowedRoot, resolvedPath);
  } catch (error) {
    if (error instanceof VerifiedFileError) throw error;
  }
}

async function resolveAfterOpen(candidatePath: string): Promise<string> {
  try {
    return await realpath(candidatePath);
  } catch {
    throw identityMismatch();
  }
}

function assertInside(allowedRoot: string, resolvedPath: string): void {
  if (!isPathInside(allowedRoot, resolvedPath)) {
    throw new VerifiedFileError("outside-scope", "资源通过链接指向预览范围外", 403);
  }
}

function assertUsableIdentity(identity: BigIntStats): void {
  if (identity.ino === 0n) {
    throw new VerifiedFileError(
      "identity-unavailable",
      "当前文件系统无法证明资源身份，已停止读取",
      409
    );
  }
}

function assertSameIdentity(expected: BigIntStats, actual: BigIntStats): void {
  assertUsableIdentity(actual);
  if (expected.dev !== actual.dev || expected.ino !== actual.ino || !actual.isFile()) {
    throw identityMismatch();
  }
}

function identityMismatch(): VerifiedFileError {
  return new VerifiedFileError(
    "identity-mismatch",
    "资源在安全检查期间发生变化，已停止读取",
    409
  );
}
