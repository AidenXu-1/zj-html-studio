export interface NativeWindowRegistry<T> {
  fromId(id: number): T | null;
}

/** A popout's remote objects belong to that popout's JavaScript context. Only
 * read its numeric ID; obtain callable proxies through the plugin's own context.
 * Otherwise a closed popout can leave callbacks attached to a destroyed realm. */
export function resolveNativeWindow<T>(win: Window, registry?: NativeWindowRegistry<T>): T | null {
  if (win.closed || !registry) return null;
  const id = (win as Window & { electronWindow?: { id?: unknown } }).electronWindow?.id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? registry.fromId(id) : null;
}
