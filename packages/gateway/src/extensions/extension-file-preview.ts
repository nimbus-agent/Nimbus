import type { SandboxPermissions } from "@nimbus-dev/registry-format";
import { isSameOrInside, pathApiFor } from "../util/path-overlap.ts";
import { checkDeclaredPath, type ExtensionRunGrantEnv } from "./extension-run-grants.ts";
import { oneLine } from "./install-plan-text.ts";
import { ExtensionRunGrantError } from "./run-grant-error.ts";

export type FileOutcome =
  | "allowed"
  | "not-checked"
  | "protected"
  | "missing"
  | "relative"
  | "self-write";

export type BroadPath = "filesystem-root" | "drive-root" | "home" | "above-home";

export type PreviewedPath = {
  readonly path: string;
  readonly access: "read" | "write";
  readonly outcome: FileOutcome;
  readonly broad: BroadPath | null;
  readonly text: string;
};

export type FilePreview = {
  readonly paths: readonly PreviewedPath[];
  /** True only when every path was checked: false with no environment, or with any `not-checked` path. */
  readonly checked: boolean;
  /** False when any path is refused; otherwise `null` when any is unchecked: neither a pass nor a refusal. */
  readonly canRunHere: boolean | null;
  readonly text: string;
};

type RefusalOutcome = "protected" | "missing" | "relative" | "self-write";

const REFUSAL_OUTCOME: Readonly<Record<string, RefusalOutcome>> = {
  ERR_EXTENSION_GRANT_PROTECTED: "protected",
  ERR_EXTENSION_GRANT_PATH_MISSING: "missing",
  ERR_EXTENSION_GRANT_PATH_RELATIVE: "relative",
  ERR_EXTENSION_GRANT_SELF_WRITE: "self-write",
};

const OUTCOME_SUFFIX: Readonly<Record<RefusalOutcome, string>> = {
  protected: " (can't run here: overlaps Nimbus's data)",
  missing: " (doesn't exist here)",
  relative: " (relative path, not allowed)",
  "self-write": " (can't run here: overlaps the extension's own files)",
};

/** The outcome a path refusal maps to; `undefined` for any other refusal, which is not ours to describe. */
export function refusalOutcome(e: ExtensionRunGrantError): RefusalOutcome | undefined {
  return REFUSAL_OUTCOME[e.code];
}

const BROAD_SUFFIX: Readonly<Record<BroadPath, string>> = {
  "filesystem-root": " (the whole filesystem)",
  "drive-root": " (a whole drive)",
  home: " (your entire home folder)",
  "above-home": " (includes your home folder)",
};

function canonicalOrSelf(env: ExtensionRunGrantEnv, p: string): string {
  try {
    return env.realpath(p);
  } catch {
    return p;
  }
}

function broadKind(canonical: string, home: string, env: ExtensionRunGrantEnv): BroadPath | null {
  const api = pathApiFor(env.platform);
  if (api.parse(canonical).root === canonical) {
    return env.platform === "win32" ? "drive-root" : "filesystem-root";
  }
  const insideHome = isSameOrInside(env.platform, canonical, home);
  const containsHome = isSameOrInside(env.platform, home, canonical);
  if (insideHome && containsHome) return "home";
  return containsHome ? "above-home" : null;
}

/**
 * On Windows a path that begins with two slashes of either kind names a network share or a device
 * (UNC `host\share`, `//host/share`, the `\\?\UNC` and `\\.\pipe` prefixes). Resolving one touches
 * the network (a blocked event loop, SMB, possibly an NTLM offer) from a preview that runs before
 * any consent and leaves no egress row, so such a path is never handed to `realpath`.
 */
const NETWORK_OR_DEVICE = /^[\\/]{2}/;

/**
 * Linux and macOS have the same trap in the `-hosts` automount map, conventionally at `/net` and
 * enabled by default on macOS: resolving `/net/<host>/x` contacts the host the path names. A map
 * mounted elsewhere is not detected; other maps name only servers an administrator chose. A `..`
 * segment is never resolved either: `normalize` would erase `/net` from the spelling, while
 * `realpath` walks through it. The manifest validator refuses `..`, so no valid path loses anything.
 */
function reachesNetworkWhenResolved(declared: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return NETWORK_OR_DEVICE.test(declared);
  if (declared.split("/").includes("..")) return true;
  const normal = pathApiFor(platform).normalize(declared);
  const spelled = platform === "darwin" ? normal.toLowerCase() : normal;
  return spelled === "/net" || spelled.startsWith("/net/");
}

function describePath(
  declared: string,
  access: "read" | "write",
  install: string | undefined,
  home: string,
  env: ExtensionRunGrantEnv,
): PreviewedPath | null {
  if (reachesNetworkWhenResolved(declared, env.platform)) {
    const path = oneLine(declared);
    return {
      path,
      access,
      outcome: "not-checked",
      broad: null,
      text: `${path} (network or device path, not checked here)`,
    };
  }
  let canonical: string | null;
  try {
    canonical = checkDeclaredPath(declared, access, install, env);
  } catch (e) {
    if (!(e instanceof ExtensionRunGrantError)) throw e;
    const outcome = refusalOutcome(e);
    if (outcome === undefined) throw e;
    const path = oneLine(declared);
    return {
      path,
      access,
      outcome,
      broad: null,
      text: `${path}${OUTCOME_SUFFIX[outcome]}`,
    };
  }
  if (canonical === null) return null;
  const path = oneLine(canonical);
  const broad = broadKind(canonical, home, env);
  return {
    path,
    access,
    outcome: "allowed",
    broad,
    text: broad === null ? path : `${path}${BROAD_SUFFIX[broad]}`,
  };
}

function summarize(paths: readonly PreviewedPath[]): string {
  const list = (access: "read" | "write"): string => {
    const texts = paths.filter((p) => p.access === access).map((p) => p.text);
    return texts.length === 0 ? "none" : texts.join(", ");
  };
  return `reads ${list("read")} · writes ${list("write")}`;
}

/** A refusal found is a refusal, even beside a path nobody could check. */
function canRunFrom(paths: readonly PreviewedPath[]): boolean | null {
  if (paths.some((p) => p.outcome !== "allowed" && p.outcome !== "not-checked")) return false;
  return paths.some((p) => p.outcome === "not-checked") ? null : true;
}

/**
 * Predicts, before install, what the run approval's own path check will say about each declared
 * path, through that same check. "Here" is deliberate: the approval stays authoritative. With no
 * environment to ask, nothing is claimed either way.
 */
export function previewFileGrants(
  declared: SandboxPermissions["filesystem"],
  env: ExtensionRunGrantEnv | undefined,
  opts: { readonly installPath?: string; readonly homeDir: string },
): FilePreview {
  if (env === undefined) {
    const mk = (p: string, access: "read" | "write"): PreviewedPath => {
      const path = oneLine(p);
      return { path, access, outcome: "not-checked", broad: null, text: path };
    };
    const paths = [
      ...declared.read.map((p) => mk(p, "read")),
      ...declared.write.map((p) => mk(p, "write")),
    ];
    return {
      paths,
      checked: false,
      canRunHere: null,
      text: `${summarize(paths)} (not checked here)`,
    };
  }
  const install =
    opts.installPath === undefined ? undefined : canonicalOrSelf(env, opts.installPath);
  const home = canonicalOrSelf(env, opts.homeDir);
  const paths: PreviewedPath[] = [];
  const add = (list: readonly string[], access: "read" | "write"): void => {
    for (const p of list) {
      const d = describePath(p, access, install, home, env);
      if (d !== null) paths.push(d);
    }
  };
  add(declared.read, "read");
  add(declared.write, "write");
  return {
    paths,
    checked: paths.every((p) => p.outcome !== "not-checked"),
    canRunHere: canRunFrom(paths),
    text: summarize(paths),
  };
}
