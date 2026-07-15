import type { PreviewMode } from "../settings";

const SAFE_CSP_PREFIX = [
  "sandbox allow-same-origin",
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "form-action 'none'"
];

const TRUSTED_CSP_DIRECTIVES = [
  "default-src 'self' http: https: data: blob:",
  "script-src 'self' http: https: data: blob: 'unsafe-inline' 'unsafe-eval'",
  "connect-src 'self' http: https: ws: wss:",
  "frame-src 'self' http: https: data: blob:",
  "child-src 'self' http: https: data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "style-src 'self' http: https: data: 'unsafe-inline'",
  "img-src 'self' http: https: data: blob:",
  "font-src 'self' http: https: data:",
  "media-src 'self' http: https: data: blob:"
];

export const SAFE_CONTENT_SECURITY_POLICY = [
  ...SAFE_CSP_PREFIX,
  "base-uri 'none'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:"
].join("; ");
export const TRUSTED_CONTENT_SECURITY_POLICY = TRUSTED_CSP_DIRECTIVES.join("; ");

export function getContentSecurityPolicy(mode: PreviewMode, origin?: string): string {
  if (mode === "trusted") return TRUSTED_CONTENT_SECURITY_POLICY;
  if (!origin) return SAFE_CONTENT_SECURITY_POLICY;
  return [
    ...SAFE_CSP_PREFIX,
    `base-uri ${origin}`,
    `style-src ${origin} 'unsafe-inline'`,
    `img-src ${origin} data: blob:`,
    `font-src ${origin} data:`,
    `media-src ${origin} data: blob:`
  ].join("; ");
}

export function getPermissionsPolicy(mode: PreviewMode): string {
  return mode === "trusted"
    ? "clipboard-write=(self), fullscreen=(self)"
    : "clipboard-write=(), fullscreen=(self)";
}
