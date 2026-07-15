import path from "node:path";

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function decodeRequestPath(pathname: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new PathRequestError(400, "路径编码无法解析");
  }

  if (decoded.includes("\0")) {
    throw new PathRequestError(400, "路径包含无效字符");
  }

  return decoded.replace(/^[/\\]+/, "");
}

export function encodeRelativeUrlPath(relativePath: string): string {
  return relativePath
    .split(path.sep)
    .filter(segment => segment.length > 0)
    .map(segment => encodeURIComponent(segment))
    .join("/");
}

export class PathRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "PathRequestError";
  }
}
