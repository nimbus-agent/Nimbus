import type { Database } from "bun:sqlite";
import {
  findPersonByCanonicalEmail,
  findPersonByGithubLogin,
  normalizeEmail,
} from "../../people/person-store.ts";

export type SelfPersonSource = "override" | "git" | "os" | "unresolved";

export type SelfPersonResolution = {
  personId: string | null;
  source: SelfPersonSource;
};

export type GitRunner = () => Promise<string | null>;

export type ResolveSelfPersonInput = {
  override?: string;
  runGit?: GitRunner;
  osUsername?: string;
};

export async function defaultRunGitConfigUserEmail(
  spawn: typeof Bun.spawn = Bun.spawn,
): Promise<string | null> {
  try {
    const proc = spawn(["git", "config", "user.email"], {
      stdout: "pipe",
      stderr: "ignore",
      // The detached Gateway has no console of its own; without this the child gets a visible
      // one on Windows. See `connectors/blame-index-sync.ts`.
      windowsHide: true,
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return null;
    return out;
  } catch {
    return null;
  }
}

export async function resolveByGitEmail(
  db: Database,
  deps: { runGit: GitRunner },
): Promise<string | null> {
  const raw = await deps.runGit();
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const email = normalizeEmail(trimmed);
  const person = findPersonByCanonicalEmail(db, email);
  return person?.id ?? null;
}

export function resolveByOsUsername(db: Database, deps: { osUsername: string }): string | null {
  const u = deps.osUsername.trim();
  if (u.length === 0) return null;
  const person = findPersonByGithubLogin(db, u);
  return person?.id ?? null;
}

export async function resolveSelfPerson(
  db: Database,
  input: ResolveSelfPersonInput,
): Promise<SelfPersonResolution> {
  if (input.override !== undefined && input.override.length > 0) {
    return { personId: input.override, source: "override" };
  }
  const runGit = input.runGit ?? defaultRunGitConfigUserEmail;
  const fromGit = await resolveByGitEmail(db, { runGit });
  if (fromGit !== null) return { personId: fromGit, source: "git" };
  const osUsername = input.osUsername ?? "";
  const fromOs = resolveByOsUsername(db, { osUsername });
  if (fromOs !== null) return { personId: fromOs, source: "os" };
  return { personId: null, source: "unresolved" };
}
