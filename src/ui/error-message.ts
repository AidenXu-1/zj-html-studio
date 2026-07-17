export type PreviewErrorContext = "browser" | "embed" | "page" | "source";

export class PreviewEntryProbeError extends Error {
  readonly code: string;

  constructor(readonly statusCode: number) {
    super(`Preview entry probe failed with status ${statusCode}`);
    this.name = "PreviewEntryProbeError";
    this.code = `PREVIEW_ENTRY_${statusCode}`;
  }
}

export function toUserFacingPreviewError(error: unknown, context: PreviewErrorContext): string {
  const code = getErrorCode(error);
  if (code === "PREVIEW_ENTRY_403") return "这个本地预览会话已经失效。请刷新页面重新建立会话。";
  if (code === "PREVIEW_ENTRY_404") return "HTML 文件已经被移动、改名或删除。请定位文件后重新尝试。";
  if (code === "PREVIEW_ENTRY_409") return "文件在安全检查期间发生了变化。当前读取已停止，请刷新后重试。";
  if (code === "PREVIEW_ENTRY_413" || code === "PREVIEW_ENTRY_TOO_LARGE") {
    return "这个 HTML 超过插件内预览的稳定性上限。为避免 Obsidian 卡顿，请定位文件后交给系统浏览器打开。";
  }
  if (code === "PREVIEW_ENTRY_415") {
    return "这个 HTML 声明了当前版本不支持的文字编码。请先转换为 UTF-8，再重新打开。";
  }
  if (code === "PREVIEW_ENTRY_429" || code === "PREVIEW_ENTRY_503" || code === "PREVIEW_ENTRY_504") {
    return "本地预览服务当前较忙或已停止。请关闭暂时不用的预览，再刷新重试。";
  }
  if (code === "ENOENT") return "HTML 文件或依赖已经被移动、改名或删除。请定位文件后重新尝试。";
  if (code === "EACCES" || code === "EPERM") return "系统没有允许读取这个文件。请检查文件权限后重新尝试。";
  if (code === "EMFILE" || code === "ENFILE") return "系统同时打开的文件过多。请关闭部分预览后重新尝试。";
  if (code === "PREVIEW_CAPACITY" || getErrorName(error) === "PreviewCapacityError") {
    return "同时运行的 HTML 预览已经达到安全上限。请关闭暂时不用的标签或嵌入后重试。";
  }

  if (context === "source") return "源码暂时无法读取。页面预览没有被修改，可以稍后重试。";
  if (context === "embed") return "HTML 嵌入暂时无法打开。可以重新尝试，或在标签页中查看完整诊断。";
  if (context === "browser") return "系统浏览器没有打开。当前 Obsidian 预览仍可继续使用，请稍后重试。";
  return "HTML 页面暂时无法打开。请重新尝试；如果问题持续出现，可定位源文件检查是否完整。";
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function getErrorName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("name" in error)) return undefined;
  return typeof error.name === "string" ? error.name : undefined;
}
