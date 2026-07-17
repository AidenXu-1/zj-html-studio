import { realpath } from "node:fs/promises";
import path from "node:path";
import { assertUtf8HtmlEncoding, assertValidUtf8 } from "../server/html-encoding";
import { openVerifiedFile } from "../server/verified-file";

export const MAX_SOURCE_VIEW_BYTES = 4 * 1024 * 1024;
export const MAX_ACTIVE_SOURCE_VIEWS = 4;
export const MAX_RETAINED_SOURCE_MEMORY_BYTES = 32 * 1024 * 1024;

export interface SourceViewBudgetLease {
  release: () => void;
}

interface SourceViewBudgetReservation extends SourceViewBudgetLease {
  retain: (fileBytes: number) => boolean;
}

export class SourceViewBudget {
  private active = 0;
  private retainedBytes = 0;

  constructor(
    private readonly maxActive = MAX_ACTIVE_SOURCE_VIEWS,
    private readonly maxRetainedBytes = MAX_RETAINED_SOURCE_MEMORY_BYTES
  ) {}

  get activeCount(): number {
    return this.active;
  }

  get retainedMemoryBytes(): number {
    return this.retainedBytes;
  }

  acquire(fileBytes: number): SourceViewBudgetLease | null {
    const reservation = this.reserve();
    if (!reservation) return null;
    if (!reservation.retain(fileBytes)) {
      reservation.release();
      return null;
    }
    return reservation;
  }

  reserve(): SourceViewBudgetReservation | null {
    if (this.active >= this.maxActive) return null;
    this.active += 1;
    let retainedBytes = 0;
    let released = false;
    return {
      retain: fileBytes => {
        if (released || retainedBytes !== 0 || !canOpenSourceView(fileBytes)) return false;
        const nextRetainedBytes = estimateSourceMemoryBytes(fileBytes);
        if (this.retainedBytes + nextRetainedBytes > this.maxRetainedBytes) return false;
        retainedBytes = nextRetainedBytes;
        this.retainedBytes += retainedBytes;
        return true;
      },
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.retainedBytes -= retainedBytes;
      }
    };
  }
}

export const sourceViewBudget = new SourceViewBudget();

export interface SourceReadState {
  currentFilePath: string | null;
  currentLoadGeneration: number;
  currentRequestGeneration: number;
  filePath: string;
  loadGeneration: number;
  requestGeneration: number;
}

export function isSourceReadCurrent(state: SourceReadState): boolean {
  return state.requestGeneration === state.currentRequestGeneration
    && state.loadGeneration === state.currentLoadGeneration
    && state.filePath === state.currentFilePath;
}

export class SourceViewTooLargeError extends Error {
  constructor(readonly limitBytes = MAX_SOURCE_VIEW_BYTES) {
    super(`源码查看最多读取 ${formatMiB(limitBytes)} MiB`);
    this.name = "SourceViewTooLargeError";
  }
}

export class SourceViewCapacityError extends Error {
  constructor() {
    super("当前打开或正在读取的源码页面较多");
    this.name = "SourceViewCapacityError";
  }
}

export function canOpenSourceView(fileSize: number): boolean {
  return Number.isFinite(fileSize) && fileSize >= 0 && fileSize <= MAX_SOURCE_VIEW_BYTES;
}

export function estimateSourceMemoryBytes(fileSize: number): number {
  if (!Number.isFinite(fileSize) || fileSize < 0) return Number.POSITIVE_INFINITY;
  // The read buffer, decoded text, newline-normalized text, textarea value,
  // and small indexes can briefly coexist. Use a conservative worst-case
  // multiplier instead of relying on V8's one-byte string optimization.
  return Math.max(1, Math.ceil(fileSize) * 8);
}

export function normalizeSourceTextForTextarea(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

export async function readSourceTextWithinLimit(
  vaultRoot: string,
  fileRelativePath: string,
  signal?: AbortSignal
): Promise<string> {
  return (await readVerifiedSource(vaultRoot, fileRelativePath, signal)).text;
}

export async function readSourceTextWithBudget(
  vaultRoot: string,
  fileRelativePath: string,
  budget: SourceViewBudget,
  signal?: AbortSignal
): Promise<{ lease: SourceViewBudgetLease; text: string }> {
  const result = await readVerifiedSource(vaultRoot, fileRelativePath, signal, budget);
  if (!result.lease) throw new SourceViewCapacityError();
  return { lease: result.lease, text: result.text };
}

async function readVerifiedSource(
  vaultRoot: string,
  fileRelativePath: string,
  signal: AbortSignal | undefined,
  budget?: SourceViewBudget
): Promise<{ lease: SourceViewBudgetLease | null; text: string }> {
  const reservation = budget?.reserve() ?? null;
  if (budget && !reservation) throw new SourceViewCapacityError();
  const lease: SourceViewBudgetLease | null = reservation;
  let verifiedFile: Awaited<ReturnType<typeof openVerifiedFile>> | null = null;
  let result: { lease: SourceViewBudgetLease | null; text: string } | null = null;
  let failure: unknown = null;
  try {
    const resolvedVaultRoot = await realpath(vaultRoot);
    verifiedFile = await openVerifiedFile(
      path.resolve(resolvedVaultRoot, fileRelativePath),
      resolvedVaultRoot,
      { signal }
    );
    if (verifiedFile.fileStats.size > MAX_SOURCE_VIEW_BYTES) throw new SourceViewTooLargeError();
    if (reservation && !reservation.retain(verifiedFile.fileStats.size)) throw new SourceViewCapacityError();
    const buffer = await readFileHandleExactly(
      verifiedFile.fileHandle,
      verifiedFile.fileStats.size,
      signal
    );
    if (buffer === null) throw new Error("源码在读取期间发生变化");
    assertUtf8HtmlEncoding(buffer);
    assertValidUtf8(buffer);
    result = { lease, text: normalizeSourceTextForTextarea(buffer.toString("utf8")) };
  } catch (error) {
    failure = error;
  }
  if (verifiedFile) {
    try {
      await verifiedFile.fileHandle.close();
    } catch (error) {
      if (failure === null) failure = error;
    }
  }
  if (failure !== null) {
    lease?.release();
    throw failure instanceof Error
      ? failure
      : new Error(typeof failure === "string" ? failure : "源码读取失败");
  }
  return result!;
}

async function readFileHandleExactly(
  fileHandle: Awaited<ReturnType<typeof openVerifiedFile>>["fileHandle"],
  expectedBytes: number,
  signal: AbortSignal | undefined
): Promise<Buffer | null> {
  if (signal?.aborted) throw createAbortError();
  const initialStats = await fileHandle.stat({ bigint: true });
  if (signal?.aborted) throw createAbortError();
  if (initialStats.size !== BigInt(expectedBytes)) return null;
  const buffer = Buffer.allocUnsafe(expectedBytes);
  let offset = 0;
  while (offset < buffer.length) {
    if (signal?.aborted) throw createAbortError();
    const length = Math.min(256 * 1024, buffer.length - offset);
    const result = await fileHandle.read(buffer, offset, length, offset);
    if (signal?.aborted) throw createAbortError();
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset !== expectedBytes) return null;
  if (signal?.aborted) throw createAbortError();
  const latestStats = await fileHandle.stat({ bigint: true });
  if (signal?.aborted) throw createAbortError();
  return latestStats.dev === initialStats.dev
    && latestStats.ino === initialStats.ino
    && latestStats.size === initialStats.size
    && latestStats.mtimeNs === initialStats.mtimeNs
    && latestStats.ctimeNs === initialStats.ctimeNs
    ? buffer
    : null;
}

function createAbortError(): Error {
  const error = new Error("Source read aborted");
  error.name = "AbortError";
  return error;
}

function formatMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(0);
}
