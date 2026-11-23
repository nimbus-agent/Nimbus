import type { Database } from "bun:sqlite";
import { userInfo } from "node:os";

import { normalizeEmail } from "../../../people/person-store.ts";
import type { GapNote } from "../findings.ts";
import type { NegotiateInput, NegotiateSubject } from "../negotiate-types.ts";
import { defaultRunGitConfigUserEmail, type GitRunner, resolveSelfPerson } from "../self-person.ts";
import { classifyExplicitSubject, explicitSubjectGap, zeroEdgeSubjectGap } from "./subject-gaps.ts";

function safeOsUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
}

/**
 * Spec § 5.A0. `resolveOwner` (`ownership/owner-identity.ts`) emits `git:<email>` for a
 * blame email with no matching `person` row, so ownership recorded under an unmapped alias
 * is attributed to a SEPARATE graph entity and would silently vanish from a person-id-keyed
 * lane like `laneOwnership`. For the SELF subject we know the git email that self-resolution
 * attempted (whether or not it ended up mapping to a person), so we can name the gap
 * precisely instead of carrying a generic caveat. Never called for an explicit `--person`
 * subject: someone else's alias set is unknowable from here (see `countUnmappedOwnerIdentities`).
 */
export function detectUnmappedGitIdentity(db: Database, gitEmail: string | null): GapNote | null {
  if (gitEmail === null || gitEmail.trim() === "") return null;
  const row = db
    .query(
      `SELECT 1 AS n FROM graph_entity
        WHERE type = 'person' AND external_id = ? LIMIT 1`,
    )
    .get(`git:${normalizeEmail(gitEmail)}`) as { n?: number } | null;
  if (row === null) return null;
  return {
    category: "missing_user_identity",
    detail:
      "Some of your ownership is recorded under an unmapped git identity and is not counted here.",
    remediation:
      "Add that git email to your person record so blame lines written under it are attributed to you.",
  };
}

/**
 * `gitEmailAttempted` captures the raw email `resolveSelfPerson` tried against git config
 * (whether or not it ended up mapping to a `person` row) so `runNegotiate` can pass it to
 * `detectUnmappedGitIdentity`. It stays `null` whenever git was never consulted — e.g. an
 * `override`/explicit `mePersonIdOverride` short-circuits `resolveSelfPerson` before it
 * calls `runGit` at all — matching "call only when a git email is otherwise known" (Task 4
 * brief step 4).
 */
export async function resolveSubject(
  db: Database,
  input: NegotiateInput,
): Promise<{
  subject: NegotiateSubject;
  gitEmailAttempted: string | null;
  subjectGap: GapNote | null;
}> {
  let gitEmailAttempted: string | null = null;
  const baseRunGit = input.runGitOverride ?? defaultRunGitConfigUserEmail;
  const capturingRunGit: GitRunner = async () => {
    const raw = await baseRunGit();
    gitEmailAttempted = raw === null || raw.trim() === "" ? null : raw;
    return raw;
  };
  // Always resolve the local self id, even for an explicit `--person`: `isOther` means
  // "named someone other than the resolved local user" (see `NegotiateSubject.isOther`'s
  // docstring), which is a comparison, not a fact derivable from `--person` being present.
  const resolution = await resolveSelfPerson(db, {
    ...(input.mePersonIdOverride === undefined ? {} : { override: input.mePersonIdOverride }),
    runGit: capturingRunGit,
    osUsername: input.osUsernameOverride ?? safeOsUsername(),
  });
  if (input.personId !== undefined && input.personId.length > 0) {
    return {
      subject: {
        personId: input.personId,
        source: "explicit",
        displayName: personDisplayNameOrNull(db, input.personId),
        isOther: input.personId !== resolution.personId,
      },
      gitEmailAttempted,
      // The two arms fire only when the id is NOT a person row, so the zero-edge arm is the
      // fallback rather than an alternative — a `person` match reaches it, everything else
      // has already been described.
      subjectGap:
        explicitSubjectGap(classifyExplicitSubject(db, input.personId), input.personId) ??
        zeroEdgeSubjectGap(db, input.personId),
    };
  }
  return {
    subject: {
      personId: resolution.personId,
      source: resolution.source,
      displayName:
        resolution.personId === null ? null : personDisplayNameOrNull(db, resolution.personId),
      isOther: false,
    },
    gitEmailAttempted,
    // Was hard-coded `null`, which meant only an explicit `--person` could ever be disclosed —
    // and the split-identity failure was observed on the bare `nimbus negotiate` path, where
    // the resolver picks the subject and the user never named one.
    subjectGap: resolution.personId === null ? null : zeroEdgeSubjectGap(db, resolution.personId),
  };
}

function personDisplayNameOrNull(db: Database, personId: string): string | null {
  const row = db.query("SELECT display_name FROM person WHERE id = ?").get(personId) as {
    display_name: string | null;
  } | null;
  return row?.display_name ?? null;
}
