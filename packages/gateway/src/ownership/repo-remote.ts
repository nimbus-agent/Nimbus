import { extensionProcessEnv } from "../extensions/spawn-env.ts";
import { stripAffixChars } from "../util/strip-affixes.ts";

export type RemoteRef = { readonly service: string; readonly ownerName: string };
export type RemoteSpawn = typeof Bun.spawn;

const GIT_TIMEOUT_MS = 30_000;

const HOST_TO_SERVICE: ReadonlyMap<string, string> = new Map([
  ["github.com", "github"],
  ["gitlab.com", "gitlab"],
  ["bitbucket.org", "bitbucket"],
]);

/** Mirrors `runGit` in `connectors/blame-index-sync.ts`: I1 env scoping, a
 * bounded timeout, and a catch that degrades to an empty result rather than
 * throwing (AbortError, git not on PATH, spawn failure). */
async function runGit(
  root: string,
  args: readonly string[],
  spawn: RemoteSpawn,
): Promise<{ code: number; out: string }> {
  try {
    const proc = spawn(["git", "-C", root, ...args], {
      env: extensionProcessEnv({}),
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
    });
    const code = await proc.exited;
    const out = await new Response(proc.stdout).text();
    return { code, out };
  } catch {
    return { code: 1, out: "" };
  }
}

/** `host` + `owner/name` from an ssh or https remote URL; null if the host is
 * not one we can form a `repo` entity id for, or the path is not `owner/name`. */
export function parseRemoteUrl(url: string): RemoteRef | null {
  const raw = url.trim();
  if (raw === "") return null;

  let host: string;
  let path: string;
  const sshMatch = /^[^@\s]+@([^:\s]+):(.+)$/.exec(raw);
  if (sshMatch?.[1] !== undefined && sshMatch[2] !== undefined) {
    host = sshMatch[1];
    path = sshMatch[2];
  } else {
    try {
      const u = new URL(raw);
      host = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  }

  const service = HOST_TO_SERVICE.get(host.toLowerCase());
  if (service === undefined) return null;

  // A linear scan, not `.replace(/\/+$/, "")`: that trailing-anchored form is
  // retried from every start offset, so a long run of slashes that does not
  // reach the end backtracks quadratically (Sonar `typescript:S8786`). Remote
  // URLs come from `git remote -v` in a repo the user may not control.
  let p = stripAffixChars(path, "/");
  if (p.toLowerCase().endsWith(".git")) p = p.slice(0, -4);
  const parts = p.split("/").filter((s) => s !== "");
  if (parts.length !== 2) return null;
  return { service, ownerName: `${parts[0] ?? ""}/${parts[1] ?? ""}` };
}

/**
 * `origin` when present; otherwise the SOLE remote if there is exactly one.
 *
 * Two-or-more without `origin` returns null on purpose. In a fork workflow
 * `origin` is the user's fork and `upstream` is canonical, so "pick the first"
 * binds a service to the wrong repository — and does it silently, which is a
 * worse failure than no binding. Ambiguity fails closed rather than guessing.
 */
export function selectRemoteName(names: readonly string[]): string | null {
  if (names.includes("origin")) return "origin";
  return names.length === 1 ? (names[0] ?? null) : null;
}

export async function resolveRepoRemote(
  root: string,
  spawn: RemoteSpawn = Bun.spawn,
): Promise<RemoteRef | null> {
  const listed = await runGit(root, ["remote"], spawn);
  if (listed.code !== 0) return null;
  const names = listed.out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const chosen = selectRemoteName(names);
  if (chosen === null) return null;
  const url = await runGit(root, ["remote", "get-url", chosen], spawn);
  if (url.code !== 0) return null;
  return parseRemoteUrl(url.out.trim());
}
