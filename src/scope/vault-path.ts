import { realpath } from "node:fs/promises";
import path from "node:path";

export async function canonicalizeVaultBasePath(basePath: string): Promise<string> {
  return realpath(basePath);
}

export function toVaultRelativePath(vaultBasePath: string, absolutePath: string): string | null {
  if (!path.isAbsolute(absolutePath)) return absolutePath.split(path.sep).join("/");
  const relative = path.relative(vaultBasePath, absolutePath);
  if (
    relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) return null;
  return relative.split(path.sep).join("/");
}
