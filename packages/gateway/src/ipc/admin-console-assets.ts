import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { isCompiledBinary } from "../platform/runtime-layout.ts";
import { EMBEDDED_CONSOLE_ASSETS } from "./embedded-assets.ts";

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

export type ConsoleAssetResult =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "not-built" }
  | { readonly kind: "not-found" };

export interface ConsoleAssetDeps {
  /** True inside a `bun build --compile` executable. */
  readonly compiled: boolean;
  /** Relative asset name → absolute path. In a compiled binary this is the entire namespace. */
  readonly assets: Readonly<Record<string, string>>;
  /** `NIMBUS_ADMIN_CONSOLE_DIST`. Dev-tree only — a compiled binary ignores it. */
  readonly distOverride: string | undefined;
  readonly exists: (path: string) => boolean;
}

export const DEFAULT_CONSOLE_ASSET_DEPS: ConsoleAssetDeps = {
  compiled: isCompiledBinary(),
  assets: EMBEDDED_CONSOLE_ASSETS,
  distOverride: process.env["NIMBUS_ADMIN_CONSOLE_DIST"],
  exists: existsSync,
};

/**
 * The dev-tree dist directory: the override when it names a built console, else the directory
 * holding the embedded `index.html` — which under `bun` is the real `packages/admin-console/dist`.
 * Deriving it from the asset map is what keeps `import.meta.dir` out of this file; walking up from
 * that would resolve inside the read-only bunfs root in a compiled binary.
 */
function devConsoleDist(deps: ConsoleAssetDeps): string | undefined {
  const override = deps.distOverride;
  if (override !== undefined && override.trim() !== "") {
    return deps.exists(join(override, "index.html")) ? override : undefined;
  }
  const indexHtml = deps.assets["index.html"];
  if (indexHtml === undefined) return undefined;
  const dist = dirname(indexHtml);
  return deps.exists(join(dist, "index.html")) ? dist : undefined;
}

/**
 * Resolve a `/admin/*` asset name to a readable path.
 *
 * `rel` must already have passed `safeAssetPath`. Compiled, resolution is a lookup in a
 * three-entry map, so traversal is structurally impossible rather than rejected — there is no
 * directory to escape from. In a dev tree the lookup is a join against the dist directory, which
 * is why `safeAssetPath` remains load-bearing there.
 */
export function resolveConsoleAsset(
  rel: string,
  deps: ConsoleAssetDeps = DEFAULT_CONSOLE_ASSET_DEPS,
): ConsoleAssetResult {
  if (deps.compiled) {
    // hasOwn, not `deps.assets[rel] !== undefined`: "constructor" and "toString" are truthy on any
    // plain object and would otherwise resolve to a function.
    if (!Object.hasOwn(deps.assets, rel)) return { kind: "not-found" };
    const path = deps.assets[rel];
    return path === undefined ? { kind: "not-found" } : { kind: "file", path };
  }
  const dist = devConsoleDist(deps);
  if (dist === undefined) return { kind: "not-built" };
  const path = join(dist, rel);
  return deps.exists(path) ? { kind: "file", path } : { kind: "not-found" };
}
