import type { PreviewMode } from "../settings";

interface PreviewModePresentation {
  icon: string;
  label: string;
  shortLabel: string;
  title: string;
}

const MODE_PRESENTATION: Record<PreviewMode, PreviewModePresentation> = {
  safe: {
    icon: "shield",
    label: "安全只读",
    shortLabel: "安全",
    title: "已关闭页面脚本、常见后台请求、外部资源和剪贴板；链接或跳转仍可能离开本地预览。"
  },
  interactive: {
    icon: "mouse-pointer-click",
    label: "本地交互",
    shortLabel: "交互",
    title: "页面脚本和范围内资源可用；常见 fetch、XHR、WebSocket 与外部资源受阻，但页面导航和 WebRTC 不作离线承诺。"
  },
  trusted: {
    icon: "shield-check",
    label: "可信兼容",
    shortLabel: "可信",
    title: "页面脚本、模块、后台联网、外部资源和剪贴板可用；Obsidian 内仍限制表单、弹窗和下载。"
  }
};

export function getPreviewModePresentation(mode: PreviewMode): PreviewModePresentation {
  return MODE_PRESENTATION[mode];
}

export function getPreviewIframeAllow(mode: PreviewMode): string {
  return mode === "trusted" ? "clipboard-write; fullscreen" : "fullscreen";
}

export function getPreviewIframeSandbox(mode: PreviewMode, hasSafeSearchBridge = false): string {
  if (mode === "safe") return hasSafeSearchBridge ? "allow-scripts allow-same-origin" : "";
  return "allow-scripts allow-same-origin";
}
