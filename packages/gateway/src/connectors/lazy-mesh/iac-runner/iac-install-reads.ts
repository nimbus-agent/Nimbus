// packages/gateway/src/connectors/lazy-mesh/iac-runner/iac-install-reads.ts
// What a CLI child may READ of its own install (invariants I15, I50; static D43(d)). Pure path
// rules, split out of `iac-runner.ts` with no behaviour change: they decide which paths a profile
// is handed as read grants, but build no profile.
import { dirname } from "node:path";
import { isSameOrInside, pathApiFor, pathsOverlap } from "../../../util/path-overlap.ts";

/** The CLIs an iac or kube child runs. */
export type IacBinary = "terraform" | "aws" | "kubectl";

/** Is `p` under a directory the operating system owns (so a read grant there is neither needed nor safe)? */
export function isSystemOwnedDir(p: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return true;
  const roots = [
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/etc",
    "/System",
    "/Library",
    "/private/etc",
  ];
  return roots.some((r) => p === r || p.startsWith(`${r}/`));
}

/** The folders an install directory must not be, hold or sit in: where the gateway reads them from. */
export interface InstallReadEnv {
  readonly homeDir: string;
  readonly tmpDir: string;
  readonly protectedRoots: readonly string[];
}

/** Directory names that are shared or personal, never "an install of one tool". */
const SHARED_DIR_NAMES: ReadonlySet<string> = new Set([
  "bin",
  "sbin",
  "downloads",
  "desktop",
  "documents",
  "tmp",
  "temp",
]);
/** A path segment under which a read grant would expose credentials or personal state. */
const SENSITIVE_SEGMENTS: ReadonlySet<string> = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".azure",
  ".kube",
]);

/**
 * Is `tree` a directory dedicated to one tool's install, safe to hand to a networked, credentialed
 * child as a read grant? Not a root; deep enough to be a product directory (three segments); not a
 * shared or personal folder, a dotfile folder or one under a credential folder; not home or temp or
 * a folder that holds them; and not overlapping a Nimbus folder in either direction.
 */
function isVettedInstallRoot(
  tree: string,
  installEnv: InstallReadEnv,
  platform: NodeJS.Platform,
): boolean {
  const api = pathApiFor(platform);
  const segments = tree.split(api.sep).filter((s) => s !== "");
  if (segments.length < 3) return false;
  const last = (segments.at(-1) ?? "").toLowerCase();
  if (SHARED_DIR_NAMES.has(last) || last.startsWith(".")) return false;
  if (segments.some((s) => SENSITIVE_SEGMENTS.has(s.toLowerCase()))) return false;
  if (
    isSameOrInside(platform, installEnv.homeDir, tree) ||
    isSameOrInside(platform, installEnv.tmpDir, tree)
  ) {
    return false;
  }
  return !installEnv.protectedRoots.some((r) => pathsOverlap(platform, tree, r));
}

/**
 * What the CLI child may READ of its own install, POSIX only (a Windows grant on a tree under
 * `C:\Program Files` fails in the helper and the image loads without one) and never for a
 * system-owned binary (bubblewrap and the sandbox profile already carry `/usr`). Terraform is one
 * static binary: the FILE alone is granted, never its directory, so a binary left in the home
 * directory, `~/Downloads` or `~/.local/bin` exposes nothing else to a child that has the network
 * and a cloud credential. The `aws` CLI needs its install directory as well; it gets it only when
 * that directory is a vetted install root (see {@link isVettedInstallRoot}), else only the file
 * (the call then fails, which is the safe direction).
 */
export function installReads(
  binaryRealPath: string | undefined,
  platform: NodeJS.Platform,
  tool: IacBinary,
  installEnv: InstallReadEnv,
): string[] {
  if (binaryRealPath === undefined || platform === "win32") return [];
  const tree = dirname(binaryRealPath);
  if (isSystemOwnedDir(tree, platform)) return [];
  if (tool !== "aws" || !isVettedInstallRoot(tree, installEnv, platform)) return [binaryRealPath];
  return [binaryRealPath, tree];
}
