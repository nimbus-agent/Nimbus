#!/usr/bin/env bun

/**
 * audit:bypass-actors — asserts each active org repo's `General` ruleset carries
 * exactly the bypass actors declared in `.github/rulesets/general-branch.json`.
 *
 * Why this is a SEPARATE gate from audit:ruleset-drift: that gate's credential is
 * a repo-scoped App installation token with `Administration: read`, and GitHub
 * returns an EMPTY `bypass_actors` to it for org-level actors. Proven live that
 * `organization-administration: read` does not restore the field, and reading it
 * otherwise needs `Administration: write` — which a read-only audit gate must not
 * hold. So this one runs from the OWNER's machine (an `admin:org` token does
 * return the field) and leaves a committed attestation the sweep can check
 * without any credential at all. See docs/infrastructure-roadmap.md, P6.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ATTESTATION_PATH, decideAttestWrite, writeAttestation } from "./_bypass-attestation.ts";
import { classifyReadFailure, isRecord, isStrict, runGh, strictSkip } from "./_gh-audit.ts";

export interface AuditResult {
  ok: boolean;
  errors: string[];
}

/** One entry of a ruleset's `bypass_actors` array. */
export interface BypassActor {
  actor_type: string;
  /** `null` for org-level actors; a numeric id for Team/Integration/RepositoryRole. */
  actor_id?: number | null;
  bypass_mode: string;
}

export interface DeclaredBypassFile {
  repos: string[];
  bypass: {
    attestation_grace_days: number;
    by_repo: Record<string, BypassActor[]>;
  };
}

export const VALID_BYPASS_MODES: readonly string[] = ["always", "pull_request"];

/**
 * The only actor types this gate supports — those whose `actor_id` is null.
 *
 * Not a portability concern (there is no staging org; every sweep gate hard-codes
 * `nimbus-agent`) but a REVIEWABILITY one: the entire control here is that the
 * config and attestation are PR-visible and diff-reviewed, and `"actor_id":
 * 4382579` is not something a human reviewer can check. Supporting a numeric-id
 * actor requires resolving ids to names first — see the design's 1.1 response.
 */
export const NULL_ID_ACTOR_TYPES: readonly string[] = ["OrganizationAdmin"];

/** Every actor type GitHub can return, used only to sharpen the validation error. */
export const KNOWN_ACTOR_TYPES: readonly string[] = [
  "OrganizationAdmin",
  "Team",
  "Integration",
  "RepositoryRole",
  "DeployKey",
];

/**
 * True only for an actor this gate can render human-checkably: a type in
 * `NULL_ID_ACTOR_TYPES` carrying an actually-null `actor_id`. Checking the type
 * name alone is not enough — a null-id type can still show up with a numeric id
 * (e.g. a GitHub API quirk or a hand-edited config), and that is exactly the
 * shape the reviewability rationale above exists to reject.
 */
function isSupportedActor(actor: BypassActor): boolean {
  return NULL_ID_ACTOR_TYPES.includes(actor.actor_type) && (actor.actor_id ?? null) === null;
}

const DECLARED_PATH = ".github/rulesets/general-branch.json";

export function loadDeclaredBypass(repoRoot: string): DeclaredBypassFile {
  const raw = readFileSync(join(repoRoot, DECLARED_PATH), "utf8");
  try {
    return JSON.parse(raw) as DeclaredBypassFile;
  } catch (err) {
    // Deliberately NOT an "unparseable" verdict like the attestation's. That file
    // is generated and could plausibly be corrupted; THIS one is hand-authored and
    // already covered by `biome check .`, so a parse failure means a broken repo,
    // not a runtime condition to degrade around. Rethrow with the path so the
    // failure names the file instead of a bare character offset.
    throw new Error(
      `${DECLARED_PATH} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Validates the DECLARED config before any diffing.
 *
 * A typo like `"alway"` would already red the gate by mismatching live
 * `"always"` — but as `bypass_mode: expected alway, got always`, which points the
 * reader at the ORG when the defect is in the CONFIG. Validating first turns that
 * into a finding that names the file. Same red, correct target.
 */
export function validateDeclaredBypass(file: DeclaredBypassFile): string[] {
  const errors: string[] = [];

  const declaredRepos = Object.keys(file.bypass.by_repo).sort();
  const repos = [...file.repos].sort();
  if (JSON.stringify(declaredRepos) !== JSON.stringify(repos)) {
    errors.push(
      `bypass.by_repo keys ${JSON.stringify(declaredRepos)} do not match repos ${JSON.stringify(repos)}`,
    );
  }

  for (const [repo, actors] of Object.entries(file.bypass.by_repo)) {
    for (const actor of actors) {
      if (!VALID_BYPASS_MODES.includes(actor.bypass_mode)) {
        errors.push(
          `invalid bypass_mode "${actor.bypass_mode}" in bypass.by_repo.${repo} (expected ${VALID_BYPASS_MODES.join("|")})`,
        );
      }
      if (!NULL_ID_ACTOR_TYPES.includes(actor.actor_type)) {
        errors.push(
          KNOWN_ACTOR_TYPES.includes(actor.actor_type)
            ? `unsupported actor_type "${actor.actor_type}" in bypass.by_repo.${repo} — only null-id org-level actors (${NULL_ID_ACTOR_TYPES.join("|")}) are supported`
            : `unknown actor_type "${actor.actor_type}" in bypass.by_repo.${repo}`,
        );
      } else if ((actor.actor_id ?? null) !== null) {
        // The type is null-id-eligible, but THIS entry carries a numeric id — the
        // exact shape the reviewability rationale (see NULL_ID_ACTOR_TYPES above)
        // exists to reject. Distinct message from "unsupported actor_type" above:
        // the type is fine, the numeric id is the defect.
        errors.push(
          `bypass.by_repo.${repo} declares "${actor.actor_type}" with a numeric actor_id (${actor.actor_id}) — unsupported: a numeric id is not human-reviewable in a PR diff`,
        );
      }
    }
  }

  const grace = file.bypass.attestation_grace_days;
  if (!Number.isInteger(grace) || grace <= 0) {
    errors.push(`bypass.attestation_grace_days must be a positive integer, got ${String(grace)}`);
  }

  return errors;
}

/** Stable identity of an actor INCLUDING its mode — an omitted id equals an explicit null. */
export function actorKey(actor: BypassActor): string {
  return `${actor.actor_type}:${actor.actor_id ?? "null"}:${actor.bypass_mode}`;
}

/** Identity WITHOUT the mode, so a mode change reports as a change, not add+remove. */
function actorIdentity(actor: BypassActor): string {
  return `${actor.actor_type}:${actor.actor_id ?? "null"}`;
}

/**
 * Identity keys that occur more than once in an actor array.
 *
 * `new Map(array.map(...))` silently keeps only the LAST entry for a repeated
 * key — a duplicate identity (e.g. the same actor listed twice with different
 * `bypass_mode`s) would otherwise be discarded with no signal, and which entry
 * "wins" depends on array order. Both sides of the diff must be checked before
 * either is turned into a Map.
 */
function duplicateIdentities(actors: BypassActor[]): string[] {
  const counts = new Map<string, number>();
  for (const actor of actors) {
    const id = actorIdentity(actor);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
}

/**
 * Pure diff — the whole verdict, so both gates share it and neither needs network.
 * Gate 1 passes live `gh` data as `observed`; Gate 2 passes the attested snapshot.
 *
 * Findings are directional because the repairs differ: "someone added an override"
 * is a different job from "an intended override was removed".
 */
export function diffBypassActors(
  repos: string[],
  declared: Record<string, BypassActor[]>,
  observed: Record<string, BypassActor[]>,
): AuditResult {
  const errors: string[] = [];

  for (const repo of repos) {
    const want = declared[repo];
    if (want === undefined) {
      errors.push(`${repo}: not declared in bypass.by_repo`);
      continue;
    }
    const got = observed[repo];
    if (got === undefined) {
      errors.push(`${repo}: no observed bypass_actors`);
      continue;
    }

    // A duplicate identity must never be silently resolved by `Map` keeping the
    // last entry — that would discard the most permissive bypass_mode with no
    // signal, and the surviving entry would depend on array order. Checked on
    // BOTH sides before either is turned into a Map.
    const wantDupes = duplicateIdentities(want);
    if (wantDupes.length > 0) {
      for (const id of wantDupes) {
        errors.push(
          `${repo}: duplicate declared bypass actor identity ${id} in bypass.by_repo.${repo}`,
        );
      }
      continue;
    }
    const gotDupes = duplicateIdentities(got);
    if (gotDupes.length > 0) {
      for (const id of gotDupes) {
        errors.push(
          `${repo}: duplicate observed bypass actor identity ${id} — cannot safely diff against declared intent`,
        );
      }
      continue;
    }

    // An actor we cannot render human-checkably is a hard error, never silently
    // normalized — otherwise a Team bypass, or a null-id type carrying a numeric
    // id, added in the UI reads green. The two cases get DISTINCT messages: an
    // unknown/non-null-id type is a type problem, but a null-id type carrying a
    // numeric actor_id is a reviewability problem, not a type problem — saying
    // "unknown type" there would misdescribe the defect.
    const unsupported = got.filter((a) => !isSupportedActor(a));
    if (unsupported.length > 0) {
      for (const actor of unsupported) {
        errors.push(
          NULL_ID_ACTOR_TYPES.includes(actor.actor_type)
            ? `${repo}: unsupported bypass actor type ${actor.actor_type} with a numeric actor_id (${actor.actor_id}) — a numeric id is not human-reviewable in a PR diff`
            : `${repo}: unsupported bypass actor type ${actor.actor_type} (id ${actor.actor_id ?? "null"}) — declared bypass intent supports only null-id org-level actors`,
        );
      }
      continue;
    }

    const wantById = new Map(want.map((a) => [actorIdentity(a), a]));
    const gotById = new Map(got.map((a) => [actorIdentity(a), a]));

    for (const [identity, actor] of gotById) {
      const expected = wantById.get(identity);
      if (expected === undefined) {
        errors.push(`${repo}: unexpected bypass actor: ${actorKey(actor)}`);
        continue;
      }
      if (expected.bypass_mode !== actor.bypass_mode) {
        errors.push(
          `${repo}: ${identity} bypass_mode: expected ${expected.bypass_mode}, got ${actor.bypass_mode}`,
        );
      }
    }
    for (const [identity, actor] of wantById) {
      if (!gotById.has(identity)) {
        errors.push(`${repo}: missing declared bypass actor: ${actorKey(actor)}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Whether this run's reads can be TRUSTED to reflect the org, as opposed to
 * reflecting a credential that cannot see `bypass_actors` at all (#961).
 *
 * The gate reads an absent-or-empty `bypass_actors` as `[]`, and `[]` diffs
 * cleanly against a declared `[]`. So "this repo has no bypass actors" and "my
 * token cannot see them" are the same observation — and the second is not
 * hypothetical, it is the proven behaviour of the App installation token, which
 * is the entire reason this gate is separate from `audit:ruleset-drift`.
 *
 * Today the config is accidentally load-bearing: three repos declare a non-empty
 * actor list, so a blind credential reds immediately with three `missing declared
 * bypass actor` findings. The moment `bypass.by_repo` is all-`[]` — which is the
 * program's stated direction — that accident is gone and a blind read produces a
 * green diff, a complete read, and a false-clean attestation honoured for the
 * full 90-day grace window.
 */
export type CapabilityVerdict =
  /** At least one repo whose declared intent is non-empty actually read non-empty. */
  | { kind: "verified"; witness: string }
  /** Every repo whose declared intent is non-empty read empty — almost certainly blind. */
  | { kind: "blind"; declaredNonEmpty: string[] }
  /** Nothing is declared non-empty, so no positive control exists in the data. */
  | { kind: "no-positive-control" };

/**
 * The cheapest correct probe: use the DECLARED non-empty repos as a positive
 * control. If every one of them reads empty, that is far more likely a blind
 * credential than a simultaneous org-wide bypass removal — and the two are worth
 * distinguishing precisely because the second is the outcome the program wants,
 * so it is the moment someone will be tempted to believe the green.
 *
 * Only repos actually queried this run are considered; an unreachable repo is
 * absence of evidence, not evidence of blindness.
 */
export function assessBypassReadCapability(input: {
  declared: Record<string, BypassActor[]>;
  observed: Record<string, BypassActor[]>;
}): CapabilityVerdict {
  const { declared, observed } = input;
  const declaredNonEmpty = Object.keys(observed)
    .filter((repo) => (declared[repo] ?? []).length > 0)
    .sort();

  if (declaredNonEmpty.length === 0) {
    return { kind: "no-positive-control" };
  }
  const witness = declaredNonEmpty.find((repo) => (observed[repo] ?? []).length > 0);
  if (witness !== undefined) {
    return { kind: "verified", witness };
  }
  return { kind: "blind", declaredNonEmpty };
}

/**
 * Fallback for the all-empty config, where no positive control exists in the
 * data: ask the CREDENTIAL directly.
 *
 * Reading org-level `bypass_actors` needs `admin:org` — the same finding that
 * root-caused the App `403` in the P2 progress log. A classic OAuth/PAT token
 * advertises its grants in `X-OAuth-Scopes`; an App installation token and a
 * fine-grained PAT send no such header, which is reported as UNKNOWN rather than
 * as absence, because "no header" must not be read as "no scope" — nor as "fine".
 */
export function parseOAuthScopes(headerBlock: string): string[] | undefined {
  const match = /^x-oauth-scopes:\s*(.*)$/im.exec(headerBlock);
  if (match === null) return undefined;
  return (match[1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** `admin:org` (or the broader `site_admin`) is what exposes org-level bypass actors. */
export function scopesCanReadBypassActors(scopes: string[] | undefined): boolean {
  if (scopes === undefined) return false;
  return scopes.includes("admin:org") || scopes.includes("site_admin");
}

/** Impure companion: ask GitHub what the ambient credential is allowed to do. */
export function probeCredentialScopes(
  run: (args: string[]) => { ok: boolean; stdout: string; stderr: string } = runGh,
): string[] | undefined {
  const res = run(["gh", "api", "-i", "user"]);
  if (!res.ok) return undefined;
  return parseOAuthScopes(res.stdout);
}

/**
 * Turns a verdict into findings. Fail-closed by construction: the only silent
 * path is `verified`, and the only way to reach it is to have actually SEEN an
 * actor this run.
 */
export function capabilityErrors(
  verdict: CapabilityVerdict,
  scopes: string[] | undefined,
): string[] {
  if (verdict.kind === "verified") return [];
  if (verdict.kind === "blind") {
    return [
      `every repo declaring a non-empty bypass actor list read back EMPTY (${verdict.declaredNonEmpty.join(", ")}) — ` +
        `this is far more likely a credential that cannot see bypass_actors than a simultaneous org-wide removal. ` +
        `Re-run with a personal admin:org token, not an App installation token. Refusing to report a clean read.`,
    ];
  }
  // no-positive-control: nothing declared non-empty, so the data cannot vouch
  // for the credential and the credential must vouch for itself.
  if (scopesCanReadBypassActors(scopes)) return [];
  return [
    `no repo declares a non-empty bypass actor list, so an empty read cannot be distinguished from a blind credential, ` +
      `and the token does not demonstrate admin:org ` +
      `(${scopes === undefined ? "no X-OAuth-Scopes header — App installation or fine-grained token" : `scopes: ${scopes.join(", ") || "none"}`}). ` +
      `Re-run with a personal admin:org token. Refusing to report a clean read.`,
  ];
}

/**
 * Exit decision for the per-repo loop.
 *
 * INVARIANT, mirroring check-ruleset-drift: real drift on a reachable repo is
 * never discarded because a DIFFERENT repo's read failed. `queried === 0` is
 * the skip-green case — but ONLY when there are also no errors. A confirmed
 * 404 (repo absent) is folded into `errors` even when it drove `queried` to 0
 * (e.g. every declared repo turned out to be renamed/deleted); that is real
 * signal that `gh` worked, not "nothing was readable", so it must never be
 * swallowed by the soft skip.
 */
export function decideExit(input: {
  queried: number;
  errors: string[];
  unreachable: string[];
  strict?: boolean;
}): { code: 0 | 1; message: string } {
  const { queried, errors, unreachable, strict = false } = input;

  if (queried === 0 && errors.length === 0) return strictSkip("audit:bypass-actors", strict);

  if (errors.length > 0) {
    const lines = errors.map((err) => `audit:bypass-actors: ${err}`);
    if (unreachable.length > 0) {
      lines.push(`audit:bypass-actors: WARNING — could not query: ${unreachable.join(", ")}`);
    }
    return { code: 1, message: lines.join("\n") };
  }

  if (unreachable.length > 0) {
    return {
      code: 0,
      message: `audit:bypass-actors: OK (${queried} repos) — WARNING: could not query ${unreachable.join(", ")}`,
    };
  }

  return { code: 0, message: `audit:bypass-actors: OK (${queried} repos)` };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const strict = isStrict(argv, process.env);
  const attest = argv.includes("--attest");
  const label = "audit:bypass-actors";
  const file = loadDeclaredBypass(process.cwd());

  const configErrors = validateDeclaredBypass(file);
  if (configErrors.length > 0) {
    for (const err of configErrors) console.error(`${label}: ${err}`);
    process.exit(1);
  }

  const observed: Record<string, BypassActor[]> = {};
  const unreachable: string[] = [];
  // A confirmed 404 on the repo itself is NOT "unreachable" — that bucket is for
  // transient/indeterminate failures (5xx, rate-limit, network) that must never
  // be read as a finding. A 404 means the repo is genuinely absent (renamed or
  // deleted), which is real drift: it must exit 1, never a soft "could not
  // query" warning that leaves the gate green. Mirrors check-cla-coverage.ts's
  // classifyReadFailure handling.
  const absentErrors: string[] = [];
  let queried = 0;

  for (const repo of file.repos) {
    const listResult = runGh([
      "gh",
      "api",
      `repos/nimbus-agent/${repo}/rulesets`,
      "--jq",
      '.[] | select(.name=="General") | .id',
    ]);
    if (!listResult.ok) {
      if (classifyReadFailure(listResult.httpStatus) === "absent") {
        absentErrors.push(
          `${repo}: repository not found (HTTP 404 on rulesets) — likely renamed or deleted; update bypass.by_repo if intentional`,
        );
      } else {
        unreachable.push(repo);
      }
      continue;
    }
    const id = listResult.stdout.trim();
    if (id === "") {
      // gh succeeded and simply found no matching ruleset — real drift, not a skip.
      queried += 1;
      observed[repo] = [];
      continue;
    }

    const detail = runGh(["gh", "api", `repos/nimbus-agent/${repo}/rulesets/${id}`]);
    if (!detail.ok) {
      if (classifyReadFailure(detail.httpStatus) === "absent") {
        absentErrors.push(
          `${repo}: repository not found (HTTP 404 on rulesets/${id}) — likely renamed or deleted; update bypass.by_repo if intentional`,
        );
      } else {
        unreachable.push(repo);
      }
      continue;
    }

    queried += 1;
    const live: unknown = JSON.parse(detail.stdout);
    const actors =
      isRecord(live) && Array.isArray(live["bypass_actors"]) ? live["bypass_actors"] : [];
    observed[repo] = actors.filter(isRecord) as unknown as BypassActor[];
  }

  const diffResult = diffBypassActors(Object.keys(observed), file.bypass.by_repo, observed);

  // #961: a clean diff is only meaningful if the credential could see the field
  // at all. Probed only when something was actually read — with `queried === 0`
  // the strict-skip path below already owns the outcome, and probing there would
  // turn an unauthenticated contributor's soft skip into a hard red.
  let capabilityFindings: string[] = [];
  if (queried > 0) {
    const verdict = assessBypassReadCapability({ declared: file.bypass.by_repo, observed });
    // Only pay for the network probe when the data cannot vouch for itself.
    const scopes = verdict.kind === "no-positive-control" ? probeCredentialScopes() : undefined;
    capabilityFindings = capabilityErrors(verdict, scopes);
  }

  const result: AuditResult = {
    ok: diffResult.ok && absentErrors.length === 0 && capabilityFindings.length === 0,
    errors: [...capabilityFindings, ...absentErrors, ...diffResult.errors],
  };
  const outcome = decideExit({ queried, errors: result.errors, unreachable, strict });

  if (attest) {
    const decision = decideAttestWrite({
      ok: result.ok,
      queried,
      total: file.repos.length,
      unreachable,
    });
    if (!decision.write) {
      if (outcome.code === 1) console.error(outcome.message);
      console.error(`${label}: ${decision.reason ?? "refusing to attest"}`);
      process.exit(1);
    }
    const who = runGh(["gh", "api", "user", "--jq", ".login"]);
    writeAttestation(process.cwd(), {
      attested_at: new Date().toISOString(),
      attested_by: who.ok ? who.stdout.trim() : "unknown",
      grace_days: file.bypass.attestation_grace_days,
      repos: Object.keys(observed).sort(),
      observed,
    });
    console.log(`${label}: OK (${queried} repos) — wrote ${ATTESTATION_PATH}`);
    process.exit(0);
  }

  if (outcome.code === 1) console.error(outcome.message);
  else if (outcome.message.includes("skipped")) console.warn(outcome.message);
  else console.log(outcome.message);
  process.exit(outcome.code);
}
