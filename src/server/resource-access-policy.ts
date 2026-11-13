import path from "node:path";
import { realpath } from "node:fs/promises";
import { isPathInside } from "./path-safety";

// Deliberately excludes notes, generic data and configuration. An HTML reference
// is a request, not user consent to read arbitrary vault content.
const COMPANION_EXTENSIONS = new Set([
  ".html", ".htm", ".css", ".js", ".mjs", ".wasm",
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif", ".ico", ".bmp",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac",
  ".mp4", ".webm", ".mov", ".m4v", ".ogv", ".vtt", ".srt", ".pdf"
]);

/** Routing may widen on refresh, but authorization remains a set of files. */
export function getGrantedResourceScope(scope: string, approvedFiles: readonly string[]): string {
  let root = scope;
  for (const file of approvedFiles) {
    while (root && !file.startsWith(`${root}/`)) {
      root = root.includes("/") ? root.slice(0, root.lastIndexOf("/")) : "";
    }
  }
  return root;
}

export function isShareableFile(vaultRoot: string, absolutePath: string, protectedDirectories: readonly string[] = []): boolean {
  if (!isPathInside(vaultRoot, absolutePath)) return false;
  if (protectedDirectories.some(folder => isPathInside(path.resolve(vaultRoot, folder), absolutePath))) return false;
  const segments = path.relative(vaultRoot, absolutePath).split(path.sep);
  return segments.every(segment => segment !== "" && !segment.startsWith("."));
}

export class ResourceAccessPolicy {
  private readonly resources: Set<string>;
  private readonly approvals: Set<string>;

  constructor(
    private readonly vaultRoot: string,
    private readonly entry: string,
    resourceFiles: readonly string[] = [],
    approvedFiles: readonly string[] = [],
    private readonly protectedDirectories: readonly string[] = []
  ) {
    this.resources = new Set(resourceFiles.map(file => path.resolve(vaultRoot, file)));
    this.approvals = new Set(approvedFiles.map(file => path.resolve(vaultRoot, file)));
  }

  async isShareable(candidate: string, resolved: string): Promise<boolean> {
    if (!isShareableFile(this.vaultRoot, candidate, this.protectedDirectories)
      || !isShareableFile(this.vaultRoot, resolved, this.protectedDirectories)) return false;
    // Resolve on every check: configuration directories can be links, case aliases,
    // or be moved while a preview is open. Never silently ignore lookup failures.
    for (const folder of this.protectedDirectories) {
      let actualFolder: string;
      try {
        actualFolder = await realpath(path.resolve(this.vaultRoot, folder));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT"
          || (error as NodeJS.ErrnoException).code === "ENOTDIR") continue;
        throw error;
      }
      if (isPathInside(actualFolder, candidate) || isPathInside(actualFolder, resolved)) return false;
    }
    return true;
  }

  async allows(candidate: string, resolved: string): Promise<boolean> {
    if (candidate === this.entry && resolved === this.entry) return true;
    if (!await this.isShareable(candidate, resolved)) return false;
    // A grant names the canonical file, never the folder or a symlink's new target.
    if (this.approvals.has(resolved)) return true;
    // Authorization follows the verified target. The analyzer records real paths,
    // so a legitimate symlink or case alias need not appear as a second resource.
    // A link to a note/config file still fails the target's checks and extension.
    return this.isCompanion(resolved);
  }

  private isCompanion(file: string): boolean {
    if (!COMPANION_EXTENSIONS.has(path.extname(file).toLowerCase())) return false;
    if (this.resources.has(file)) return true;
    const folder = path.dirname(this.entry);
    if (!isPathInside(folder, file)) return false;
    // A root-level HTML must not expose attachments throughout the vault.
    if (folder === this.vaultRoot && path.dirname(file) !== folder) {
      return /^(?:assets|images|img|media|fonts|scripts|styles)[/\\]/i.test(path.relative(folder, file));
    }
    return true;
  }
}
