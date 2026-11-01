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
  /** `null` when any path is unchecked: neither a pass nor a refusal. */
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

function describePath(
  declared: string,
  access: "read" | "write",
  install: string | undefined,
  home: string,
  env: ExtensionRunGrantEnv,
): PreviewedPath | null {
  if (env.platform === "win32" && NETWORK_OR_DEVICE.test(declared)) {
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
  const unchecked = paths.some((p) => p.outcome === "not-checked");
  return {
    paths,
    checked: !unchecked,
    canRunHere: unchecked ? null : paths.every((p) => p.outcome === "allowed"),
    text: summarize(paths),
  };
}
