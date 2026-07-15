import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeRequestPath,
  encodeRelativeUrlPath,
  isPathInside,
  PathRequestError,
  toVaultRelativePath
} from "../src/server/path-safety";

describe("path safety", () => {
  it("recognizes paths inside a root", () => {
    const root = path.resolve("/vault/site");
    expect(isPathInside(root, path.join(root, "images", "hero.png"))).toBe(true);
    expect(isPathInside(root, path.resolve(root, "..", "secret.md"))).toBe(false);
  });

  it("decodes valid URL paths and strips the leading slash", () => {
    expect(decodeRequestPath("/%E8%AF%BE%E7%A8%8B/demo.html")).toBe("课程/demo.html");
  });

  it("rejects malformed URL encoding", () => {
    expect(() => decodeRequestPath("/%E0%A4%A")).toThrow(PathRequestError);
  });

  it("encodes each path segment without losing directories", () => {
    expect(encodeRelativeUrlPath(path.join("课程 演示", "第一页.html"))).toBe("%E8%AF%BE%E7%A8%8B%20%E6%BC%94%E7%A4%BA/%E7%AC%AC%E4%B8%80%E9%A1%B5.html");
  });

  it("returns vault-relative paths with forward slashes on every platform", () => {
    const root = path.resolve("vault");
    expect(toVaultRelativePath(root, path.join(root, "output", "cover"))).toBe("output/cover");
  });
});
