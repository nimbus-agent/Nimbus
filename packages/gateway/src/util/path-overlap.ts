import path from "node:path";

/** The path module whose rules match `platform`, so a win32 path is parsed as one on any host. */
export function pathApiFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * Is `inner` the same as, or inside, `outer`? Case-insensitive on win32; another drive is never
 * inside.
 */
export function isSameOrInside(platform: NodeJS.Platform, inner: string, outer: string): boolean {
  const api = pathApiFor(platform);
  const norm = (p: string): string => (platform === "win32" ? api.normalize(p).toLowerCase() : p);
  const rel = api.relative(norm(outer), norm(inner));
  if (rel === "") return true;
  if (api.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${api.sep}`);
}

/** Two paths overlap when either is the same as, or inside, the other. */
export function pathsOverlap(platform: NodeJS.Platform, a: string, b: string): boolean {
  return isSameOrInside(platform, a, b) || isSameOrInside(platform, b, a);
}

/**
 * The first protected root that `candidate` overlaps in either direction — so a grant of `/` is
 * caught as surely as a grant of `<dataDir>/x`. Each root is compared by its configured spelling AND
 * its realpath; a root that does not exist yet keeps its spelling. Returns the root as configured.
 */
export function findProtectedOverlap(
  candidate: string,
  roots: readonly string[],
  platform: NodeJS.Platform,
  realpath: (p: string) => string,
): string | undefined {
  for (const root of roots) {
    let canonical = root;
    try {
      canonical = realpath(root);
    } catch {
      // Not created yet: compare by the configured spelling.
    }
    for (const r of new Set([root, canonical])) {
      if (pathsOverlap(platform, candidate, r)) return root;
    }
  }
  return undefined;
}
