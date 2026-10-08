/**
 * The `git_commit` metadata contract (filesystem connector). Adds the author email that lets
 * `expert`'s commit-authorship lane attribute a commit (PR A2). Same omission rule as the other
 * contract modules: an empty email is omitted, never written as `""`.
 */

/** Bump when the mapper starts writing a key consumers may rely on. Drives `rebody` eligibility. */
export const GIT_COMMIT_META_VERSION = 1;

export function buildGitCommitMetadata(
  raw: Readonly<Record<string, unknown>>,
  fields: { readonly authorEmail?: string | undefined },
): Record<string, unknown> {
  const out: Record<string, unknown> = Object.fromEntries(
    Object.entries(raw).filter(([k]) => k !== "author_email" && k !== "meta_v"),
  );
  if (fields.authorEmail !== undefined && fields.authorEmail !== "") {
    out["author_email"] = fields.authorEmail;
  }
  out["meta_v"] = GIT_COMMIT_META_VERSION;
  return out;
}
