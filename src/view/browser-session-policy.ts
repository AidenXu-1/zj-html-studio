export const MAX_BROWSER_SESSIONS_PER_VIEW = 8;

export function canOpenBrowserSession(
  activeSessionCount: number,
  sessionLimit = MAX_BROWSER_SESSIONS_PER_VIEW
): boolean {
  return activeSessionCount < sessionLimit;
}
