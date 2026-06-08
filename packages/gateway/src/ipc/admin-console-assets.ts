import { existsSync } from "node:fs";
import { join } from "node:path";

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  map: "application/json; charset=utf-8",
};

export function contentTypeFor(file: string): string {
  const ext = file.split(".").pop() ?? "";
  return TYPES[ext] ?? "application/octet-stream";
}

/** Translate a /admin/* request path to a relative asset name; reject traversal. */
export function safeAssetPath(pathname: string): string | undefined {
  let rel = pathname.replace(/^\/admin\/?/, "");
  if (rel === "") rel = "index.html";
  if (rel.includes("..") || rel.startsWith("/") || rel.includes("\\")) return undefined;
  return rel;
}

/**
 * Resolve the built console dist root. Returns undefined if not built.
 * NIMBUS_ADMIN_CONSOLE_DIST overrides. `baseDir` is the calling module's `import.meta.dir`
 * (http-server.ts → packages/gateway/src/ipc); the built console lives at
 * packages/admin-console/dist, i.e. three levels up (ipc→src→gateway→packages) then in.
 */
export function resolveConsoleDist(baseDir: string): string | undefined {
  const override = process.env["NIMBUS_ADMIN_CONSOLE_DIST"];
  if (override !== undefined && override.trim() !== "") {
    return existsSync(join(override, "index.html")) ? override : undefined;
  }
  const dist = join(baseDir, "..", "..", "..", "admin-console", "dist");
  return existsSync(join(dist, "index.html")) ? dist : undefined;
}
