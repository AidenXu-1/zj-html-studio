import { describe, expect, it } from "vitest";
import { PreviewCapacityError } from "../src/server/preview-server";
import {
  PreviewEntryProbeError,
  toUserFacingPreviewError
} from "../src/ui/error-message";

describe("consumer error messages", () => {
  it("never exposes raw filesystem paths or error codes", () => {
    const error = Object.assign(
      new Error("ENOENT: no such file or directory, open '<local-path>/private/page.html'"),
      { code: "ENOENT" }
    );

    const message = toUserFacingPreviewError(error, "page");
    expect(message).toContain("移动、改名或删除");
    expect(message).not.toContain("<local-path>");
    expect(message).not.toContain("ENOENT");
  });

  it("explains entry probe failures with recovery actions", () => {
    expect(toUserFacingPreviewError(new PreviewEntryProbeError(403), "page")).toContain("刷新");
    expect(toUserFacingPreviewError(new PreviewEntryProbeError(404), "page")).toContain("定位文件");
    expect(toUserFacingPreviewError(new PreviewEntryProbeError(409), "page")).toContain("安全检查期间");
    expect(toUserFacingPreviewError(new PreviewEntryProbeError(415), "page")).toContain("UTF-8");
    expect(toUserFacingPreviewError(new PreviewEntryProbeError(503), "page")).toContain("关闭暂时不用的预览");
  });

  it("turns capacity and permission failures into consumer language", () => {
    expect(toUserFacingPreviewError(new PreviewCapacityError("active-sessions", 64), "embed"))
      .toContain("安全上限");
    expect(toUserFacingPreviewError({ code: "EACCES" }, "page")).toContain("文件权限");
    expect(toUserFacingPreviewError({ code: "EMFILE" }, "browser")).toContain("打开的文件过多");
  });

  it("uses a safe context fallback for unknown internal errors", () => {
    const raw = new Error("sensitive internal detail <local-path>/private");
    expect(toUserFacingPreviewError(raw, "browser")).not.toContain("sensitive internal detail");
    expect(toUserFacingPreviewError(raw, "embed")).toContain("标签页");
    expect(toUserFacingPreviewError(raw, "source")).toContain("页面预览没有被修改");
  });
});
