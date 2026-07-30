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
import { isRecord, isStrict, runGh, strictSkip } from "./_gh-audit.ts";

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

    // An actor type we cannot render human-checkably is a hard error, never
    // silently normalized — otherwise a Team bypass added in the UI reads green.
    const unsupported = got.filter((a) => !NULL_ID_ACTOR_TYPES.includes(a.actor_type));
    if (unsupported.length > 0) {
      for (const actor of unsupported) {
        errors.push(
          `${repo}: unsupported bypass actor type ${actor.actor_type} (id ${actor.actor_id ?? "null"}) — declared bypass intent supports only null-id org-level actors`,
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
 * Exit decision for the per-repo loop.
 *
 * INVARIANT, mirroring check-ruleset-drift: real drift on a reachable repo is
 * never discarded because a DIFFERENT repo's read failed. `queried === 0` is the
 * only skip-green case.
 */
export function decideExit(input: {
  queried: number;
  errors: string[];
  unreachable: string[];
  strict?: boolean;
}): { code: 0 | 1; message: string } {
  const { queried, errors, unreachable, strict = false } = input;

  if (queried === 0) return strictSkip("audit:bypass-actors", strict);

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
      unreachable.push(repo);
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
      unreachable.push(repo);
      continue;
    }

    queried += 1;
    const live: unknown = JSON.parse(detail.stdout);
    const actors =
      isRecord(live) && Array.isArray(live["bypass_actors"]) ? live["bypass_actors"] : [];
    observed[repo] = actors.filter(isRecord) as unknown as BypassActor[];
  }

  const result = diffBypassActors(file.repos, file.bypass.by_repo, observed);
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
