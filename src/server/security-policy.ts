import type { PreviewMode } from "../settings";

const SAFE_CSP_PREFIX = [
  "default-src 'none'",
  "connect-src 'none'",
  "webrtc 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "form-action 'none'"
];

export const WEBRTC_RUNTIME_ENFORCEMENT_STATUS = "not-enforced-in-obsidian-1.12.7" as const;

export const SENSITIVE_PERMISSION_FEATURES = [
  "accelerometer",
  "bluetooth",
  "camera",
  "clipboard-read",
  "clipboard-write",
  "display-capture",
  "geolocation",
  "gyroscope",
  "magnetometer",
  "microphone",
  "midi",
  "payment",
  "serial",
  "usb"
] as const;

const TRUSTED_CSP_DIRECTIVES = [
  "default-src 'self' http: https: data: blob:",
  "script-src 'self' http: https: data: blob: 'unsafe-inline' 'unsafe-eval'",
  "connect-src 'self' http: https: ws: wss:",
  "frame-src 'self' http: https: data: blob:",
  "child-src 'self' http: https: data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self' http: https:",
  "style-src 'self' http: https: data: 'unsafe-inline'",
  "img-src 'self' http: https: data: blob:",
  "font-src 'self' http: https: data:",
  "media-src 'self' http: https: data: blob:"
];

export const SAFE_CONTENT_SECURITY_POLICY = [
  "sandbox allow-same-origin",
  ...SAFE_CSP_PREFIX,
  "script-src 'none'",
  "base-uri 'none'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:"
].join("; ");
export const TRUSTED_CONTENT_SECURITY_POLICY = TRUSTED_CSP_DIRECTIVES.join("; ");

export function getContentSecurityPolicy(mode: PreviewMode, origin?: string, bridgeNonce?: string): string {
  if (mode === "trusted") return TRUSTED_CONTENT_SECURITY_POLICY;
  if (mode === "interactive" && origin) {
    return [
      "sandbox allow-scripts allow-same-origin",
      ...SAFE_CSP_PREFIX,
      `script-src ${origin} 'unsafe-inline'`,
      `base-uri ${origin}`,
      `style-src ${origin} 'unsafe-inline'`,
      `img-src ${origin} data: blob:`,
      `font-src ${origin} data:`,
      `media-src ${origin} data: blob:`
    ].join("; ");
  }
  if (!origin) return SAFE_CONTENT_SECURITY_POLICY;
  return [
    bridgeNonce ? "sandbox allow-scripts allow-same-origin" : "sandbox allow-same-origin",
    ...SAFE_CSP_PREFIX,
    bridgeNonce ? `script-src 'nonce-${bridgeNonce}'` : "script-src 'none'",
    `base-uri ${origin}`,
    `style-src ${origin} 'unsafe-inline'`,
    `img-src ${origin} data: blob:`,
    `font-src ${origin} data:`,
    `media-src ${origin} data: blob:`
  ].join("; ");
}

export function getPermissionsPolicy(mode: PreviewMode): string {
  const closedSensitiveFeatures = SENSITIVE_PERMISSION_FEATURES
    .filter(feature => mode !== "trusted" || feature !== "clipboard-write")
    .map(feature => `${feature}=()`);
  const promisedFeatures = mode === "trusted"
    ? ["clipboard-write=(self)", "fullscreen=(self)"]
    : ["fullscreen=(self)"];
  return [...closedSensitiveFeatures, ...promisedFeatures].join(", ");
}
