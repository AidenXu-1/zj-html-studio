import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  estimateSourceMemoryBytes,
  MAX_SOURCE_VIEW_BYTES,
  normalizeSourceTextForTextarea,
  readSourceTextWithinLimit,
  readSourceTextWithBudget,
  SourceViewBudget,
  SourceViewCapacityError,
  SourceViewTooLargeError
} from "../src/view/source-read-policy";
import { UnsupportedHtmlEncodingError } from "../src/server/html-encoding";

describe("source view reads", () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(path.join(os.tmpdir(), "html-studio-source-"));
    await mkdir(path.join(vaultRoot, "pages"), { recursive: true });
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it("reads a verified in-vault HTML file without changing its text", async () => {
    const source = "<!doctype html><h1>你好，HTML</h1>";
    await writeFile(path.join(vaultRoot, "pages", "index.html"), source);

    await expect(readSourceTextWithinLimit(vaultRoot, "pages/index.html")).resolves.toBe(source);
  });

  it("rejects a file that grows beyond the hard source-view limit", async () => {
    await writeFile(
      path.join(vaultRoot, "pages", "large.html"),
      Buffer.alloc(MAX_SOURCE_VIEW_BYTES + 1, 97)
    );

    await expect(readSourceTextWithinLimit(vaultRoot, "pages/large.html"))
      .rejects.toBeInstanceOf(SourceViewTooLargeError);
  });

  it("rejects legacy encodings instead of displaying silent mojibake", async () => {
    await writeFile(
      path.join(vaultRoot, "pages", "utf16.html"),
      Buffer.from([0xff, 0xfe, 0x3c, 0x00, 0x68, 0x00, 0x31, 0x00, 0x3e, 0x00])
    );

    await expect(readSourceTextWithinLimit(vaultRoot, "pages/utf16.html"))
      .rejects.toBeInstanceOf(UnsupportedHtmlEncodingError);
  });

  it("rejects invalid UTF-8 without an encoding declaration", async () => {
    await writeFile(
      path.join(vaultRoot, "pages", "invalid.html"),
      Buffer.from([0x3c, 0x70, 0x3e, 0x80])
    );

    await expect(readSourceTextWithinLimit(vaultRoot, "pages/invalid.html"))
      .rejects.toBeInstanceOf(UnsupportedHtmlEncodingError);
  });

  it("uses a hard count and retained-memory budget with idempotent release", () => {
    const budget = new SourceViewBudget(2, 240);
    const first = budget.acquire(10);
    const second = budget.acquire(15);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(budget.activeCount).toBe(2);
    expect(budget.retainedMemoryBytes).toBe(200);
    expect(budget.acquire(0)).toBeNull();
    first?.release();
    first?.release();
    expect(budget.activeCount).toBe(1);
    expect(budget.retainedMemoryBytes).toBe(120);
    expect(budget.acquire(10)).not.toBeNull();
  });

  it("accounts for decoding, newline normalization, textarea storage, and indexes", () => {
    expect(estimateSourceMemoryBytes(0)).toBe(1);
    expect(estimateSourceMemoryBytes(1)).toBe(8);
    expect(estimateSourceMemoryBytes(MAX_SOURCE_VIEW_BYTES)).toBe(32 * 1024 * 1024);
  });

  it("normalizes CRLF and legacy CR exactly like a textarea value", () => {
    expect(normalizeSourceTextForTextarea("first\r\nsecond\rthird\nfourth"))
      .toBe("first\nsecond\nthird\nfourth");
  });

  it("returns source offsets in the same newline coordinate space as the textarea", async () => {
    await writeFile(
      path.join(vaultRoot, "pages", "windows.html"),
      "alpha\r\nneedle-one\rneedle-two"
    );

    await expect(readSourceTextWithinLimit(vaultRoot, "pages/windows.html"))
      .resolves.toBe("alpha\nneedle-one\nneedle-two");
  });

  it("reserves an operation slot before the verified size is known", () => {
    const budget = new SourceViewBudget(1, 100);
    const reservation = budget.reserve();

    expect(reservation).not.toBeNull();
    expect(budget.activeCount).toBe(1);
    expect(budget.retainedMemoryBytes).toBe(0);
    expect(budget.reserve()).toBeNull();
    expect(reservation?.retain(10)).toBe(true);
    expect(budget.retainedMemoryBytes).toBe(80);
    reservation?.release();
    expect(budget.activeCount).toBe(0);
    expect(budget.retainedMemoryBytes).toBe(0);
  });

  it("reserves the verified file size before allocating source content", async () => {
    await writeFile(path.join(vaultRoot, "pages", "budgeted.html"), "x");
    const budget = new SourceViewBudget(1, 7);

    await expect(readSourceTextWithBudget(
      vaultRoot,
      "pages/budgeted.html",
      budget
    )).rejects.toBeInstanceOf(SourceViewCapacityError);
    expect(budget.activeCount).toBe(0);
    expect(budget.retainedMemoryBytes).toBe(0);
  });

  it("honors cancellation before a source read starts", async () => {
    await writeFile(path.join(vaultRoot, "pages", "cancelled.html"), "<p>cancel</p>");
    const controller = new AbortController();
    controller.abort();

    await expect(readSourceTextWithinLimit(
      vaultRoot,
      "pages/cancelled.html",
      controller.signal
    )).rejects.toMatchObject({ name: "AbortError" });
  });

  it.runIf(process.platform !== "win32")("rejects a source symlink that leaves the vault", async () => {
    await symlink("/etc/hosts", path.join(vaultRoot, "pages", "outside.html"));

    await expect(readSourceTextWithinLimit(vaultRoot, "pages/outside.html")).rejects.toThrow();
  });
});
