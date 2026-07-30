# P6 Bypass-actor Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the `bypass_actors` field of every active org repo's `General` ruleset, which `audit:ruleset-drift` structurally cannot read, by pairing an owner-run audit with a credential-free attestation-freshness check in the weekly sweep.

**Architecture:** Two CLI gates share one pure diff function. `audit:bypass-actors` runs on the owner's machine (their `gh` token has `admin:org`, which *does* return `bypass_actors`), diffs live state against declared intent in `.github/rulesets/general-branch.json`, and on a green **and complete** read writes a committed attestation snapshot. `audit:bypass-attestation` runs in `org-drift-sweep` with no credential at all, re-running the same diff offline against that snapshot plus checking its freshness and repo coverage.

**Tech Stack:** Bun + TypeScript (strict), `bun:test`, `gh` CLI via the existing `_gh-audit.ts` helpers, Biome.

**Spec:** [`../specs/2026-07-30-p6-bypass-actor-audit-design.md`](../specs/2026-07-30-p6-bypass-actor-audit-design.md)
**Review response:** [`../specs/2026-07-30-p6-bypass-actor-audit-design-review-response.md`](../specs/2026-07-30-p6-bypass-actor-audit-design-review-response.md)

## Global Constraints

- **No `any`.** Use `unknown` for external data and narrow it. TypeScript strict mode is non-negotiable.
- **Branch:** work on `dev/asafgolombek/p6-bypass-actor-audit`. Never commit on `main`.
- **Prefer dependency injection over `mock.module`.** The clock is injected as `nowMs`; there is no `Date.now()` inside any pure function.
- **Every gate mirrors `check-ruleset-drift.ts`'s contract:** fail-soft when `gh` is unavailable, `--strict` in CI, a transient read failure degrades to `indeterminate` and is never recorded as a finding.
- **Both new `audit:*` scripts MUST be added to `CI_ONLY_GATES` in `scripts/lib/preflight-gates.ts`.** A `package.json` script that is neither in `PREFLIGHT_GATES` nor in that list fails the manifest drift test.
- **All fenced code blocks in any markdown you write need a language tag** (`audit:lint:markdown` enforces MD040).
- **Verification per task:** `bunx biome check packages scripts` (NOT `bun run lint` — it reports 0 files inside `.claude/worktrees/`), plus `bun test scripts/structure-audit/<file>.test.ts`.
- Run `bun install --frozen-lockfile` once in the worktree before starting; a fresh worktree has no `node_modules` and every gate fake-fails without it.

## File Structure

| File | Responsibility |
| --- | --- |
| `.github/rulesets/general-branch.json` | Declared intent: the `bypass` block + the fourth `$contributor_two` switch. Data only. |
| `scripts/structure-audit/check-bypass-actors.ts` | Types, config load + validation, the pure `diffBypassActors`, and Gate 1's CLI. |
| `scripts/structure-audit/_bypass-attestation.ts` | Attestation shape, parse, read, write. Shared by both gates; no network, no `gh`. |
| `scripts/structure-audit/check-bypass-attestation.ts` | Gate 2's pure `evaluateAttestation` + its CLI. Imports the diff from Gate 1's module. |
| `docs/structure-audit/bypass-actors-attestation.json` | The committed snapshot. Generated, never hand-edited. |
| `.github/workflows/org-drift-sweep.yml` | The `bypass-attestation` job. No token mint. |
| `scripts/lib/preflight-gates.ts` | `CI_ONLY_GATES` entries for both scripts. |
| `package.json` | The two `audit:*` script entries. |

`check-bypass-attestation.ts` importing from `check-bypass-actors.ts` is safe: the CLI body is guarded by `if (import.meta.main)`, which is false on import.

---

### Task 1: Declared bypass config + validation

**Files:**

- Modify: `.github/rulesets/general-branch.json`
- Create: `scripts/structure-audit/check-bypass-actors.ts`
- Test: `scripts/structure-audit/check-bypass-actors.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `BypassActor`, `DeclaredBypassFile`, `AuditResult`, `VALID_BYPASS_MODES`, `NULL_ID_ACTOR_TYPES`, `KNOWN_ACTOR_TYPES`, `loadDeclaredBypass(repoRoot: string): DeclaredBypassFile`, `validateDeclaredBypass(file: DeclaredBypassFile): string[]`.

- [ ] **Step 1: Update the declared config**

Replace `.github/rulesets/general-branch.json` in full. Three things change: the `$comment` and `$contributor_two.note` no longer claim bypass actors are ungated, a fourth switch is documented, and the new `bypass` block carries the machine-readable intent.

```json
{
  "$comment": "Desired shape of the 'General' branch ruleset on every active org repo. audit:ruleset-drift diffs `shared` against each repo in `repos`. NOT diffed there: `required_status_checks`/`code_quality` (per-repo CI shape) and `bypass_actors` (the CI App installation token cannot read org-level bypass actors — see the P1 progress log). Bypass actors are instead gated by the owner-run `audit:bypass-actors`, whose attestation the sweep's `audit:bypass-attestation` checks; both read the `bypass` block below.",
  "$contributor_two": {
    "note": "Solo-mode switches to flip when a second maintainer gains write access — one reviewed diff. All four are now drift-gated: three by audit:ruleset-drift (shared.pull_request) and two by audit:bypass-actors (the bypass block).",
    "switches": {
      "shared.pull_request.required_approving_review_count": { "solo": 0, "team": 1 },
      "shared.pull_request.require_code_owner_review": { "solo": false, "team": true },
      "shared.pull_request.require_last_push_approval": { "solo": false, "team": true },
      "bypass.by_repo[*].bypass_mode": { "solo": "always", "team": "pull_request" },
      "bypass.attestation_grace_days": { "solo": 90, "team": 30 }
    }
  },
  "shared": {
    "name": "General",
    "target": "branch",
    "enforcement": "active",
    "conditions_ref_include": ["refs/heads/main"],
    "conditions_ref_exclude": [],
    "required_rule_types": ["deletion", "non_fast_forward", "pull_request"],
    "pull_request": {
      "allowed_merge_methods": ["squash"],
      "dismiss_stale_reviews_on_push": true,
      "required_review_thread_resolution": true,
      "require_code_owner_review": false,
      "require_last_push_approval": false,
      "required_approving_review_count": 0
    }
  },
  "bypass": {
    "attestation_grace_days": 90,
    "by_repo": {
      "Nimbus": [{ "actor_type": "OrganizationAdmin", "bypass_mode": "always" }],
      "nimbus-client": [],
      "nimbus-sdk": [],
      "nimbus-vscode": [{ "actor_type": "OrganizationAdmin", "bypass_mode": "always" }],
      "nimbus-web-clipper": [{ "actor_type": "OrganizationAdmin", "bypass_mode": "always" }]
    }
  },
  "repos": ["Nimbus", "nimbus-client", "nimbus-sdk", "nimbus-vscode", "nimbus-web-clipper"]
}
```

- [ ] **Step 2: Write the failing test**

Create `scripts/structure-audit/check-bypass-actors.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import {
  type DeclaredBypassFile,
  loadDeclaredBypass,
  validateDeclaredBypass,
} from "./check-bypass-actors.ts";

/** A declared file that passes validation — the base each case mutates one field of. */
function goodFile(): DeclaredBypassFile {
  return {
    repos: ["Nimbus", "nimbus-sdk"],
    bypass: {
      attestation_grace_days: 90,
      by_repo: {
        Nimbus: [{ actor_type: "OrganizationAdmin", bypass_mode: "always" }],
        "nimbus-sdk": [],
      },
    },
  };
}

describe("validateDeclaredBypass", () => {
  test("accepts a well-formed file", () => {
    expect(validateDeclaredBypass(goodFile())).toEqual([]);
  });

  test("rejects a by_repo key set that does not match repos", () => {
    const f = goodFile();
    f.repos = ["Nimbus", "nimbus-sdk", "nimbus-client"];
    const errors = validateDeclaredBypass(f);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("do not match repos");
  });

  test("rejects an invalid bypass_mode by name, pointing at the config not the org", () => {
    const f = goodFile();
    f.bypass.by_repo["Nimbus"] = [{ actor_type: "OrganizationAdmin", bypass_mode: "alway" }];
    const errors = validateDeclaredBypass(f);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('invalid bypass_mode "alway"');
    expect(errors[0]).toContain("bypass.by_repo.Nimbus");
    expect(errors[0]).toContain("always|pull_request");
  });

  test("rejects a known-but-unsupported actor type distinctly from an unknown one", () => {
    const known = goodFile();
    known.bypass.by_repo["Nimbus"] = [{ actor_type: "Team", actor_id: 42, bypass_mode: "always" }];
    expect(validateDeclaredBypass(known)[0]).toContain("unsupported actor_type");

    const unknown = goodFile();
    unknown.bypass.by_repo["Nimbus"] = [{ actor_type: "Wizard", bypass_mode: "always" }];
    expect(validateDeclaredBypass(unknown)[0]).toContain("unknown actor_type");
  });

  test("rejects a non-positive or non-integer grace window", () => {
    for (const bad of [0, -1, 1.5]) {
      const f = goodFile();
      f.bypass.attestation_grace_days = bad;
      expect(validateDeclaredBypass(f)[0]).toContain("attestation_grace_days");
    }
  });
});

describe("loadDeclaredBypass", () => {
  test("the checked-in config is valid and covers all five active repos", () => {
    const file = loadDeclaredBypass(process.cwd());
    expect(validateDeclaredBypass(file)).toEqual([]);
    expect(file.repos.length).toBe(5);
    expect(Object.keys(file.bypass.by_repo).sort()).toEqual([...file.repos].sort());
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
bun test scripts/structure-audit/check-bypass-actors.test.ts
```

Expected: FAIL — `Cannot find module './check-bypass-actors.ts'`.

- [ ] **Step 4: Write the minimal implementation**

Create `scripts/structure-audit/check-bypass-actors.ts`. This step adds only the types, loader and validator; the diff and CLI arrive in Tasks 2 and 3.

```ts
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
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
bun test scripts/structure-audit/check-bypass-actors.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Lint and commit**

```bash
bunx biome check packages scripts
git add .github/rulesets/general-branch.json scripts/structure-audit/check-bypass-actors.ts scripts/structure-audit/check-bypass-actors.test.ts
git commit -m "feat(p6): declare machine-readable bypass intent + validate it

The intended bypass shape has lived in a JSON \$comment STRING since P1.
Prose in a comment is not a gate. Moves it into a real \`bypass\` block and
validates actor_type/bypass_mode/grace before any diffing, so a config typo
names the config rather than reading as org drift."
```

---

### Task 2: The pure diff

**Files:**

- Modify: `scripts/structure-audit/check-bypass-actors.ts`
- Test: `scripts/structure-audit/check-bypass-actors.test.ts`

**Interfaces:**

- Consumes: `BypassActor`, `AuditResult`, `NULL_ID_ACTOR_TYPES` from Task 1.
- Produces: `actorKey(a: BypassActor): string`, `diffBypassActors(repos: string[], declared: Record<string, BypassActor[]>, observed: Record<string, BypassActor[]>): AuditResult`. Task 4 calls `diffBypassActors` with the attested snapshot as `observed`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/structure-audit/check-bypass-actors.test.ts`:

```ts
import { actorKey, type BypassActor, diffBypassActors } from "./check-bypass-actors.ts";

const REPOS = ["Nimbus", "nimbus-sdk"];
const ADMIN: BypassActor = { actor_type: "OrganizationAdmin", bypass_mode: "always" };

function declared(): Record<string, BypassActor[]> {
  return { Nimbus: [ADMIN], "nimbus-sdk": [] };
}

/** Live shape: GitHub always includes actor_id, null for org-level actors. */
function observed(): Record<string, BypassActor[]> {
  return {
    Nimbus: [{ actor_type: "OrganizationAdmin", actor_id: null, bypass_mode: "always" }],
    "nimbus-sdk": [],
  };
}

describe("diffBypassActors", () => {
  test("passes when live matches declared, with actor_id null vs omitted", () => {
    const r = diffBypassActors(REPOS, declared(), observed());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("flags an unexpected bypass actor", () => {
    const live = observed();
    live["nimbus-sdk"] = [{ actor_type: "OrganizationAdmin", actor_id: null, bypass_mode: "always" }];
    const r = diffBypassActors(REPOS, declared(), live);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("nimbus-sdk: unexpected bypass actor");
  });

  test("flags a missing declared bypass actor", () => {
    const live = observed();
    live["Nimbus"] = [];
    const r = diffBypassActors(REPOS, declared(), live);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("Nimbus: missing declared bypass actor");
  });

  test("reports a widened bypass_mode as a mode change, not as add+remove", () => {
    const live = observed();
    live["Nimbus"] = [
      { actor_type: "OrganizationAdmin", actor_id: null, bypass_mode: "pull_request" },
    ];
    const r = diffBypassActors(REPOS, declared(), live);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toContain("bypass_mode: expected always, got pull_request");
  });

  test("treats a non-null-id actor type as a hard error, never normalizing it away", () => {
    const live = observed();
    live["nimbus-sdk"] = [{ actor_type: "Team", actor_id: 42, bypass_mode: "always" }];
    const r = diffBypassActors(REPOS, declared(), live);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("unsupported bypass actor type Team (id 42)");
  });

  test("flags a repo that is not declared at all", () => {
    const r = diffBypassActors([...REPOS, "nimbus-new"], declared(), observed());
    expect(r.errors[0]).toContain("nimbus-new: not declared in bypass.by_repo");
  });

  test("flags a declared repo with no observation", () => {
    const live = observed();
    delete live["nimbus-sdk"];
    const r = diffBypassActors(REPOS, declared(), live);
    expect(r.errors[0]).toContain("nimbus-sdk: no observed bypass_actors");
  });

  test("is order-independent across the actor set", () => {
    const twoDeclared: Record<string, BypassActor[]> = {
      Nimbus: [
        { actor_type: "OrganizationAdmin", bypass_mode: "always" },
        { actor_type: "OrganizationAdmin", actor_id: 7, bypass_mode: "always" },
      ],
      "nimbus-sdk": [],
    };
    const twoLive: Record<string, BypassActor[]> = {
      Nimbus: [
        { actor_type: "OrganizationAdmin", actor_id: 7, bypass_mode: "always" },
        { actor_type: "OrganizationAdmin", actor_id: null, bypass_mode: "always" },
      ],
      "nimbus-sdk": [],
    };
    expect(diffBypassActors(REPOS, twoDeclared, twoLive).ok).toBe(true);
  });
});

describe("actorKey", () => {
  test("normalizes an omitted actor_id to the same key as an explicit null", () => {
    expect(actorKey({ actor_type: "OrganizationAdmin", bypass_mode: "always" })).toBe(
      actorKey({ actor_type: "OrganizationAdmin", actor_id: null, bypass_mode: "always" }),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test scripts/structure-audit/check-bypass-actors.test.ts
```

Expected: FAIL — `actorKey` / `diffBypassActors` are not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `scripts/structure-audit/check-bypass-actors.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test scripts/structure-audit/check-bypass-actors.test.ts
```

Expected: PASS, 15 tests.

- [ ] **Step 5: Lint and commit**

```bash
bunx biome check packages scripts
git add scripts/structure-audit/check-bypass-actors.ts scripts/structure-audit/check-bypass-actors.test.ts
git commit -m "feat(p6): add the pure bypass-actor diff

Shared by both gates: Gate 1 feeds it live gh data, Gate 2 the attested
snapshot. A non-null-id actor type is a hard error rather than normalized
away, so a Team bypass added in the UI cannot read as green."
```

---

### Task 3: Attestation module + Gate 1 CLI

**Files:**

- Create: `scripts/structure-audit/_bypass-attestation.ts`
- Create: `scripts/structure-audit/_bypass-attestation.test.ts`
- Modify: `scripts/structure-audit/check-bypass-actors.ts` (append the CLI)

**Interfaces:**

- Consumes: `BypassActor`, `AuditResult`, `diffBypassActors`, `loadDeclaredBypass`, `validateDeclaredBypass` from Tasks 1–2; `isStrict`, `runGh`, `strictSkip`, `classifyReadFailure`, `isRecord` from `./_gh-audit.ts`.
- Produces: `Attestation`, `ATTESTATION_PATH`, `parseAttestation(raw: string): Attestation | "unparseable"`, `readAttestation(repoRoot: string): string | null`, `writeAttestation(repoRoot: string, a: Attestation): void`, and `decideAttestWrite(input): { write: boolean; reason?: string }`. Task 4 consumes `Attestation`, `parseAttestation`, `readAttestation`, `ATTESTATION_PATH`.

- [ ] **Step 1: Write the failing test**

Create `scripts/structure-audit/_bypass-attestation.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { decideAttestWrite, parseAttestation } from "./_bypass-attestation.ts";

describe("parseAttestation", () => {
  test("parses a well-formed attestation", () => {
    const raw = JSON.stringify({
      attested_at: "2026-07-30T06:15:00.000Z",
      attested_by: "asafgolombek",
      grace_days: 90,
      repos: ["Nimbus"],
      observed: { Nimbus: [] },
    });
    const parsed = parseAttestation(raw);
    expect(parsed).not.toBe("unparseable");
    if (parsed === "unparseable") throw new Error("unreachable");
    expect(parsed.attested_by).toBe("asafgolombek");
  });

  test("reports invalid JSON as unparseable", () => {
    expect(parseAttestation("{not json")).toBe("unparseable");
  });

  test("reports legal JSON that is not an object as unparseable", () => {
    expect(parseAttestation("[]")).toBe("unparseable");
    expect(parseAttestation('"a string"')).toBe("unparseable");
    expect(parseAttestation("null")).toBe("unparseable");
  });
});

describe("decideAttestWrite", () => {
  test("writes on a green, complete read", () => {
    expect(decideAttestWrite({ ok: true, queried: 5, total: 5, unreachable: [] }).write).toBe(true);
  });

  test("refuses on drift", () => {
    const d = decideAttestWrite({ ok: false, queried: 5, total: 5, unreachable: [] });
    expect(d.write).toBe(false);
    expect(d.reason).toContain("drift");
  });

  // The hole the design review caught: decideExit returns exit 0 for a partial
  // read with no drift, so keying --attest off the exit code alone would write an
  // attestation claiming 5 repos on 4 repos' evidence.
  test("refuses on a PARTIAL read even with zero drift", () => {
    const d = decideAttestWrite({
      ok: true,
      queried: 4,
      total: 5,
      unreachable: ["nimbus-sdk"],
    });
    expect(d.write).toBe(false);
    expect(d.reason).toContain("nimbus-sdk");
    expect(d.reason).toContain("read 4 of 5");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test scripts/structure-audit/_bypass-attestation.test.ts
```

Expected: FAIL — `Cannot find module './_bypass-attestation.ts'`.

- [ ] **Step 3: Write the attestation module**

Create `scripts/structure-audit/_bypass-attestation.ts`:

```ts
/**
 * The committed bypass-actor attestation: shape, parse, read, write.
 *
 * Shared by the owner-run gate (which writes it) and the sweep gate (which reads
 * it). No network and no `gh` — deliberately, since the sweep job must run with
 * no credential at all.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { BypassActor } from "./check-bypass-actors.ts";
import { isRecord } from "./_gh-audit.ts";

export const ATTESTATION_PATH = "docs/structure-audit/bypass-actors-attestation.json";

export interface Attestation {
  /** ISO-8601 UTC, from `new Date().toISOString()`. */
  attested_at: string;
  /** `gh api user` login, or "unknown" — diagnostic only, never a gating input. */
  attested_by: string;
  /** Denormalized for diagnostics ONLY; the gate reads grace from the config. */
  grace_days: number;
  /** Derived from the repos actually observed, never copied from config. */
  repos: string[];
  observed: Record<string, BypassActor[]>;
}

/** Parse a raw attestation blob. Anything that is not a JSON object is `unparseable`. */
export function parseAttestation(raw: string): Attestation | "unparseable" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "unparseable";
  }
  // Legal JSON can be a scalar, null or an array; none is a usable attestation.
  return isRecord(parsed) ? (parsed as unknown as Attestation) : "unparseable";
}

/** Read the attestation file, or `null` when it does not exist. */
export function readAttestation(repoRoot: string): string | null {
  try {
    return readFileSync(join(repoRoot, ATTESTATION_PATH), "utf8");
  } catch {
    return null;
  }
}

export function writeAttestation(repoRoot: string, attestation: Attestation): void {
  writeFileSync(join(repoRoot, ATTESTATION_PATH), `${JSON.stringify(attestation, null, 2)}\n`);
}

export interface AttestWriteInput {
  /** Whether the diff was clean. */
  ok: boolean;
  /** How many repos were read successfully. */
  queried: number;
  /** How many repos were declared. */
  total: number;
  unreachable: string[];
}

/**
 * Whether `--attest` may write.
 *
 * TWO conditions, and the second is not redundant: `decideExit` returns exit 0
 * for a partial read with no drift (correct for a reporting gate, wrong for an
 * attesting one). Writing there would produce an attestation whose `repos` field
 * claims full coverage on partial evidence, which the sweep gate would then
 * accept for the whole grace window. Attesting is interactive and re-runnable,
 * so refusing costs nothing.
 */
export function decideAttestWrite(input: AttestWriteInput): { write: boolean; reason?: string } {
  if (!input.ok) {
    return { write: false, reason: "refusing to attest: bypass-actor drift was found" };
  }
  if (input.unreachable.length > 0 || input.queried !== input.total) {
    return {
      write: false,
      reason: `cannot attest: ${input.unreachable.join(", ")} unreachable (read ${input.queried} of ${input.total})`,
    };
  }
  return { write: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test scripts/structure-audit/_bypass-attestation.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Append Gate 1's CLI**

Append to `scripts/structure-audit/check-bypass-actors.ts`:

```ts
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
    const actors = isRecord(live) && Array.isArray(live["bypass_actors"]) ? live["bypass_actors"] : [];
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
```

Add these imports at the top of `check-bypass-actors.ts`, beneath the existing `node:` imports:

```ts
import { isRecord, isStrict, runGh, strictSkip } from "./_gh-audit.ts";
import {
  ATTESTATION_PATH,
  decideAttestWrite,
  writeAttestation,
} from "./_bypass-attestation.ts";
```

- [ ] **Step 6: Add a decideExit test**

Append to `scripts/structure-audit/check-bypass-actors.test.ts`:

```ts
import { decideExit } from "./check-bypass-actors.ts";

describe("decideExit", () => {
  test("skips green when nothing was readable and not strict", () => {
    expect(decideExit({ queried: 0, errors: [], unreachable: ["Nimbus"] }).code).toBe(0);
  });

  test("fails when nothing was readable under --strict", () => {
    expect(decideExit({ queried: 0, errors: [], unreachable: ["Nimbus"], strict: true }).code).toBe(1);
  });

  test("keeps drift found on a reachable repo despite another repo failing", () => {
    const out = decideExit({ queried: 1, errors: ["Nimbus: unexpected"], unreachable: ["nimbus-sdk"] });
    expect(out.code).toBe(1);
    expect(out.message).toContain("Nimbus: unexpected");
    expect(out.message).toContain("could not query: nimbus-sdk");
  });

  test("passes with a warning on a partial read with no drift", () => {
    const out = decideExit({ queried: 4, errors: [], unreachable: ["nimbus-sdk"] });
    expect(out.code).toBe(0);
    expect(out.message).toContain("WARNING");
  });
});
```

- [ ] **Step 7: Run all tests and lint**

```bash
bun test scripts/structure-audit/check-bypass-actors.test.ts scripts/structure-audit/_bypass-attestation.test.ts
bunx biome check packages scripts
```

Expected: PASS, 25 tests total.

- [ ] **Step 8: Commit**

```bash
git add scripts/structure-audit/_bypass-attestation.ts scripts/structure-audit/_bypass-attestation.test.ts scripts/structure-audit/check-bypass-actors.ts scripts/structure-audit/check-bypass-actors.test.ts
git commit -m "feat(p6): add the owner-run bypass-actor gate + --attest

--attest requires BOTH a green diff and a complete read. The second guard is
not redundant: decideExit returns exit 0 for a partial read with no drift, so
keying the write off the exit code would attest full coverage on partial
evidence. The written repos field also derives from what was observed."
```

---

### Task 4: Gate 2 — the sweep's attestation check

**Files:**

- Create: `scripts/structure-audit/check-bypass-attestation.ts`
- Test: `scripts/structure-audit/check-bypass-attestation.test.ts`

**Interfaces:**

- Consumes: `Attestation`, `parseAttestation`, `readAttestation`, `ATTESTATION_PATH` from Task 3; `BypassActor`, `AuditResult`, `diffBypassActors`, `loadDeclaredBypass` from Tasks 1–2.
- Produces: `evaluateAttestation(input: AttestationCheckInput): AuditResult`, `FUTURE_TOLERANCE_MS`.

- [ ] **Step 1: Write the failing test**

Create `scripts/structure-audit/check-bypass-attestation.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import type { BypassActor } from "./check-bypass-actors.ts";
import { type AttestationCheckInput, evaluateAttestation } from "./check-bypass-attestation.ts";

const NOW = Date.parse("2026-07-30T12:00:00.000Z");
const DAY = 86_400_000;

const DECLARED: Record<string, BypassActor[]> = {
  Nimbus: [{ actor_type: "OrganizationAdmin", bypass_mode: "always" }],
  "nimbus-sdk": [],
};

function attestation(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    attested_at: new Date(NOW - 3 * DAY).toISOString(),
    attested_by: "asafgolombek",
    grace_days: 90,
    repos: ["Nimbus", "nimbus-sdk"],
    observed: {
      Nimbus: [{ actor_type: "OrganizationAdmin", actor_id: null, bypass_mode: "always" }],
      "nimbus-sdk": [],
    },
    ...overrides,
  });
}

function input(overrides: Partial<AttestationCheckInput> = {}): AttestationCheckInput {
  return {
    raw: attestation(),
    declaredRepos: ["Nimbus", "nimbus-sdk"],
    declaredBypass: DECLARED,
    graceDays: 90,
    nowMs: NOW,
    ...overrides,
  };
}

describe("evaluateAttestation", () => {
  test("passes on a fresh, complete, agreeing attestation", () => {
    const r = evaluateAttestation(input());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("reports an absent file distinctly from an unparseable one", () => {
    expect(evaluateAttestation(input({ raw: null })).errors[0]).toContain("no attestation file");
    expect(evaluateAttestation(input({ raw: "{oops" })).errors[0]).toContain("not valid JSON");
  });

  test("reports legal JSON that is not an object as unparseable", () => {
    expect(evaluateAttestation(input({ raw: "[]" })).errors[0]).toContain("not valid JSON");
  });

  test("fails one day past the grace window", () => {
    const raw = attestation({ attested_at: new Date(NOW - 91 * DAY).toISOString() });
    const r = evaluateAttestation(input({ raw }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("91d old (grace 90d)");
  });

  test("reads grace from config, not from the attestation's own grace_days", () => {
    const raw = attestation({ attested_at: new Date(NOW - 45 * DAY).toISOString(), grace_days: 90 });
    expect(evaluateAttestation(input({ raw, graceDays: 90 })).ok).toBe(true);
    // A hand-edited grace_days:90 cannot widen a config that says 30.
    expect(evaluateAttestation(input({ raw, graceDays: 30 })).ok).toBe(false);
  });

  // NaN comparisons are ALL false, so a naive `elapsed > grace` check PASSES.
  test("treats an unparseable attested_at as a finding, never as fresh", () => {
    const raw = attestation({ attested_at: "not-a-date" });
    const r = evaluateAttestation(input({ raw }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("not a parseable timestamp");
  });

  test("rejects a future-dated attestation beyond the skew tolerance", () => {
    const raw = attestation({ attested_at: new Date(NOW + 2 * 3_600_000).toISOString() });
    const r = evaluateAttestation(input({ raw }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("in the future");
  });

  test("tolerates small forward clock skew", () => {
    const raw = attestation({ attested_at: new Date(NOW + 10 * 60_000).toISOString() });
    expect(evaluateAttestation(input({ raw })).ok).toBe(true);
  });

  test("fails when a newly declared repo is not covered by the attestation", () => {
    const r = evaluateAttestation(
      input({
        declaredRepos: ["Nimbus", "nimbus-sdk", "nimbus-new"],
        declaredBypass: { ...DECLARED, "nimbus-new": [] },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("do not match declared repos"))).toBe(true);
  });

  // The second NaN fail-open: `elapsed > NaN` is false, so an unguarded missing
  // attestation_grace_days would report a 10-year-old attestation as fresh.
  test("a non-numeric grace window is a finding, not a silently disabled check", () => {
    const raw = attestation({ attested_at: new Date(NOW - 3650 * DAY).toISOString() });
    const r = evaluateAttestation(input({ raw, graceDays: Number.NaN }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("attestation_grace_days"))).toBe(true);
  });

  test("a zero or negative grace window is a finding", () => {
    for (const bad of [0, -30]) {
      const r = evaluateAttestation(input({ graceDays: bad }));
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes("attestation_grace_days"))).toBe(true);
    }
  });

  test("fails when the attested snapshot no longer agrees with declared intent", () => {
    const r = evaluateAttestation(
      input({ declaredBypass: { ...DECLARED, Nimbus: [] } }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("drifts from declared intent");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun test scripts/structure-audit/check-bypass-attestation.test.ts
```

Expected: FAIL — `Cannot find module './check-bypass-attestation.ts'`.

- [ ] **Step 3: Write the implementation**

Create `scripts/structure-audit/check-bypass-attestation.ts`:

```ts
#!/usr/bin/env bun

/**
 * audit:bypass-attestation — the sweep's half of the P6 bypass-actor gate.
 *
 * Runs with NO credential: it re-runs the same pure diff offline against the
 * committed attestation, and checks that the attestation is fresh, covers every
 * declared repo, and still agrees with declared intent.
 *
 * The gated property is NOT "the org is clean" — it is "a green attestation was
 * committed recently and still agrees with declared intent". The attestation is a
 * committed file and can be hand-edited; the real control is that it is PR-visible
 * and diff-reviewed. See the design's "What this does not prove".
 *
 * Deliberately sweep-only, never the preflight FAST tier: its red depends on the
 * OWNER's re-attestation cadence, so a stale attestation must never block an
 * external contributor's unrelated PR.
 */

import type { AuditResult, BypassActor } from "./check-bypass-actors.ts";
import {
  diffBypassActors,
  loadDeclaredBypass,
  validateDeclaredBypass,
} from "./check-bypass-actors.ts";
import { ATTESTATION_PATH, parseAttestation, readAttestation } from "./_bypass-attestation.ts";

/** Forward clock skew we absorb rather than treat as a hand edit. */
export const FUTURE_TOLERANCE_MS = 60 * 60 * 1000;

const DAY_MS = 86_400_000;

export interface AttestationCheckInput {
  /** Raw file contents, or `null` when the file is absent. */
  raw: string | null;
  declaredRepos: string[];
  declaredBypass: Record<string, BypassActor[]>;
  /** From `bypass.attestation_grace_days` — NEVER the attestation's own field. */
  graceDays: number;
  /** Injected so freshness is testable without touching the system clock. */
  nowMs: number;
}

export function evaluateAttestation(input: AttestationCheckInput): AuditResult {
  const { raw, declaredRepos, declaredBypass, graceDays, nowMs } = input;

  if (raw === null) {
    return {
      ok: false,
      errors: [
        `no attestation file at ${ATTESTATION_PATH} — run \`bun run audit:bypass-actors --attest\``,
      ],
    };
  }

  const parsed = parseAttestation(raw);
  if (parsed === "unparseable") {
    return { ok: false, errors: [`${ATTESTATION_PATH} is not valid JSON (or is not an object)`] };
  }

  const errors: string[] = [];

  // The SECOND NaN fail-open, one level up from `attested_at`. A missing
  // `attestation_grace_days` makes `graceDays * DAY_MS` NaN, and `elapsed > NaN`
  // is false — so deleting one config line would silently disable the freshness
  // check while the gate stayed green. Guarded here as well as in the CLI, since
  // this pure function is what the tests exercise.
  const graceValid = Number.isFinite(graceDays) && graceDays > 0;
  if (!graceValid) {
    errors.push(
      `grace window is not a positive number (${String(graceDays)}) — check bypass.attestation_grace_days`,
    );
  }

  const attestedAtMs = Date.parse(parsed.attested_at);
  if (Number.isNaN(attestedAtMs)) {
    // Every comparison with NaN is false, so a naive staleness check would PASS.
    errors.push(`attested_at "${parsed.attested_at}" is not a parseable timestamp`);
  } else {
    const elapsed = nowMs - attestedAtMs;
    if (elapsed < -FUTURE_TOLERANCE_MS) {
      errors.push(
        `attested_at is ${Math.round(-elapsed / 60_000)} minutes in the future — clock skew or a hand-edited file`,
      );
    } else if (graceValid && elapsed > graceDays * DAY_MS) {
      errors.push(
        `attestation is ${Math.floor(elapsed / DAY_MS)}d old (grace ${graceDays}d) — re-run \`bun run audit:bypass-actors --attest\``,
      );
    }
  }

  const attestedRepos = [...parsed.repos].sort();
  const declared = [...declaredRepos].sort();
  if (JSON.stringify(attestedRepos) !== JSON.stringify(declared)) {
    errors.push(
      `attested repos ${JSON.stringify(attestedRepos)} do not match declared repos ${JSON.stringify(declared)} — re-attest to cover the change`,
    );
  }

  const diff = diffBypassActors(declaredRepos, declaredBypass, parsed.observed);
  for (const err of diff.errors) {
    errors.push(`attested snapshot drifts from declared intent — ${err}`);
  }

  return { ok: errors.length === 0, errors };
}

if (import.meta.main) {
  const label = "audit:bypass-attestation";
  const file = loadDeclaredBypass(process.cwd());

  // Validate the declared config BEFORE consuming its grace window. Gate 1 does
  // this too; skipping it here would let a missing `attestation_grace_days`
  // reach the comparison as NaN and silently disable the freshness check.
  const configErrors = validateDeclaredBypass(file);
  if (configErrors.length > 0) {
    for (const err of configErrors) console.error(`${label}: ${err}`);
    process.exit(1);
  }

  const result = evaluateAttestation({
    raw: readAttestation(process.cwd()),
    declaredRepos: file.repos,
    declaredBypass: file.bypass.by_repo,
    graceDays: file.bypass.attestation_grace_days,
    nowMs: Date.now(),
  });

  if (!result.ok) {
    for (const err of result.errors) console.error(`${label}: ${err}`);
    // This gate takes no `--strict` branch, unlike every other sweep gate. Those
    // fail SOFT locally because they need `gh` auth an external contributor lacks.
    // This one reads two committed files and nothing else, so there is no
    // environment where it cannot run — an unreadable, stale or disagreeing
    // attestation is always a real finding. The workflow still passes `--strict`
    // for consistency; it is simply a no-op here.
    process.exit(1);
  }

  console.log(`${label}: OK (${file.repos.length} repos, grace ${file.bypass.attestation_grace_days}d)`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun test scripts/structure-audit/check-bypass-attestation.test.ts
```

Expected: PASS, 12 tests.

- [ ] **Step 5: Lint and commit**

```bash
bun test scripts/structure-audit/check-bypass-attestation.test.ts
bunx biome check packages scripts
git add scripts/structure-audit/check-bypass-attestation.ts scripts/structure-audit/check-bypass-attestation.test.ts
git commit -m "feat(p6): add the credential-free attestation gate

Checks freshness, repo coverage, and that the attested snapshot still agrees
with declared intent — the last catching a config edit without a re-attest.
Two fail-opens are handled explicitly: an unparseable attested_at yields NaN
(every comparison false, so a naive staleness check passes) and a future date
stays fresh until real time catches up."
```

---

### Task 5: Wiring — scripts, gate manifest, sweep job, stale comments

**Files:**

- Modify: `package.json`
- Modify: `scripts/lib/preflight-gates.ts:71-95` (`CI_ONLY_GATES`)
- Modify: `.github/workflows/org-drift-sweep.yml`
- Modify: `scripts/structure-audit/check-ruleset-drift.ts:115-123` and its `DesiredRulesetFile` docstring

**Interfaces:**

- Consumes: the two CLIs from Tasks 3–4.
- Produces: `audit:bypass-actors` and `audit:bypass-attestation` as runnable `bun run` scripts.

- [ ] **Step 1: Add the package.json scripts**

Beside the other sweep gates (after `"audit:review-coverage"`):

```json
    "audit:bypass-actors": "bun scripts/structure-audit/check-bypass-actors.ts",
    "audit:bypass-attestation": "bun scripts/structure-audit/check-bypass-attestation.ts",
```

- [ ] **Step 2: Add both to CI_ONLY_GATES**

In `scripts/lib/preflight-gates.ts`, append inside `CI_ONLY_GATES`:

```ts
  "audit:bypass-actors", // needs an OWNER gh token (admin:org) — the CI App token cannot read bypass_actors; an explicit human action, never a gate
  "audit:bypass-attestation", // local + deterministic, but its red depends on the OWNER's re-attestation cadence; sweep-only so a stale attestation never blocks a contributor's PR
```

- [ ] **Step 3: Verify the manifest drift test still passes**

```bash
bun test scripts/lib/
```

Expected: PASS. If it fails with "gate not in manifest", the names in Step 2 do not match `package.json` exactly.

- [ ] **Step 4: Add the sweep job**

In `.github/workflows/org-drift-sweep.yml`, after the `review-coverage` job. Note there is **no token mint and no `bun install`** — the gate reads a committed JSON file and uses no external dependency.

```yaml
  bypass-attestation:
    name: bypass-attestation
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - name: Checkout Nimbus
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Setup Bun
        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
        with:
          bun-version: latest
      # No App token: this gate reads only the committed attestation + declared
      # config. Reading bypass_actors needs Administration:write, which is the
      # whole reason the attestation indirection exists.
      - name: Audit the bypass-actor attestation
        run: bun scripts/structure-audit/check-bypass-attestation.ts --strict
```

- [ ] **Step 5: Correct the stale comments in check-ruleset-drift.ts**

Replace the comment block at lines 115-123 (beginning `// Bypass actors are intentionally NOT diffed.`) with:

```ts
  // Bypass actors are intentionally NOT diffed HERE. This gate's credential is a
  // repo-scoped App installation token with `Administration: read`, which returns
  // an EMPTY `bypass_actors` for org-level actors (OrganizationAdmin) — proven
  // live that adding `organization-administration: read` does not restore it, and
  // reading them would need `Administration: write`, which a read-only audit gate
  // must not hold. The field IS gated, by the owner-run `audit:bypass-actors`
  // plus the sweep's `audit:bypass-attestation`, both reading the `bypass` block
  // of .github/rulesets/general-branch.json. See docs/infrastructure-roadmap.md, P6.
```

Then update the `DesiredRulesetFile` docstring (around line 39-44), replacing the sentence "There are no per-repo overrides — bypass actors are intentionally not diffed (see `diffRuleset` / the P1 progress log), and everything else is uniform." with:

```ts
 * `shared` is uniform across repos; per-repo bypass intent lives in the sibling
 * `bypass` block and is consumed by check-bypass-actors.ts, not by this gate.
```

- [ ] **Step 6: Verify both scripts run**

```bash
bun run audit:bypass-actors
bun run audit:bypass-attestation
```

Expected: `audit:bypass-actors: OK (5 repos)`. `audit:bypass-attestation` will FAIL with "no attestation file" — correct, the file arrives in Task 6.

- [ ] **Step 7: Lint, workflow-lint and commit**

```bash
bunx biome check packages scripts
bun run audit:workflow-lint
bun run audit:action-sha-pins
git add package.json scripts/lib/preflight-gates.ts .github/workflows/org-drift-sweep.yml scripts/structure-audit/check-ruleset-drift.ts
git commit -m "feat(p6): wire both bypass gates; correct the now-stale ruleset-drift comments

Four places asserted bypass actors were ungated. ruleset-drift still does not
diff them — its credential cannot — but its comment now points at the gate that
does, rather than describing a follow-up."
```

---

### Task 6: Red-prove, attest, and close P6

**Files:**

- Create: `docs/structure-audit/bypass-actors-attestation.json` (generated)
- Modify: `docs/infrastructure-roadmap.md`

**Interfaces:**

- Consumes: everything from Tasks 1–5.
- Produces: a green `bypass-attestation` job in the sweep.

- [ ] **Step 1: Live red-prove the diff**

The gate ships green by construction (live state already matches declared), so this is the one live red-prove available. It mutates only the working tree — **no org setting is changed**.

```bash
bun -e 'const p=".github/rulesets/general-branch.json";const f=require("fs");const s=f.readFileSync(p,"utf8");f.writeFileSync(p,s.replace(/"bypass_mode": "always"/,"\"bypass_mode\": \"pull_request\""));'
grep -c 'pull_request"' .github/rulesets/general-branch.json
```

**Verify the mutation actually landed before trusting the result** — the `review-coverage` red-prove taught this. The `grep -c` must show the edit is present.

```bash
bun run audit:bypass-actors; echo "EXIT=$?"
```

Expected: `EXIT=1` with `Nimbus: OrganizationAdmin:null bypass_mode: expected pull_request, got always`.

- [ ] **Step 2: Revert the red-prove**

```bash
git checkout -- .github/rulesets/general-branch.json
bun run audit:bypass-actors; echo "EXIT=$?"
```

Expected: `EXIT=0`, `audit:bypass-actors: OK (5 repos)`.

- [ ] **Step 3: Red-prove the partial-read refusal**

Temporarily add a non-existent repo to `repos` and `bypass.by_repo` in `.github/rulesets/general-branch.json`:

```json
      "nimbus-does-not-exist": []
```

(add to both `repos` and `bypass.by_repo`), then:

```bash
bun run audit:bypass-actors --attest; echo "EXIT=$?"
git checkout -- .github/rulesets/general-branch.json
```

Expected: `EXIT=1` with `cannot attest: nimbus-does-not-exist unreachable (read 5 of 6)`, and **no attestation file written**. Confirm with `git status --short` showing no new file.

- [ ] **Step 4: Generate the real attestation**

```bash
bun run audit:bypass-actors --attest
cat docs/structure-audit/bypass-actors-attestation.json
```

Expected: `OK (5 repos) — wrote docs/structure-audit/bypass-actors-attestation.json`, and the file lists all five repos with `OrganizationAdmin`/`always` on Nimbus, nimbus-vscode and nimbus-web-clipper, `[]` on nimbus-client and nimbus-sdk.

- [ ] **Step 5: Verify Gate 2 now passes**

```bash
bun run audit:bypass-attestation; echo "EXIT=$?"
```

Expected: `EXIT=0`, `audit:bypass-attestation: OK (5 repos, grace 90d)`.

- [ ] **Step 6: Red-prove Gate 2's staleness path**

```bash
bun -e 'const p="docs/structure-audit/bypass-actors-attestation.json";const f=require("fs");const a=JSON.parse(f.readFileSync(p,"utf8"));a.attested_at=new Date(Date.now()-91*86400000).toISOString();f.writeFileSync(p,JSON.stringify(a,null,2)+"\n");'
bun run audit:bypass-attestation; echo "EXIT=$?"
git checkout -- docs/structure-audit/bypass-actors-attestation.json 2>/dev/null || bun run audit:bypass-actors --attest
```

Expected: `EXIT=1` with `attestation is 91d old (grace 90d)`. The final command restores a fresh attestation (the file is untracked until Step 8, so `git checkout` may fail — the `--attest` fallback handles it).

- [ ] **Step 7: Update the roadmap**

In `docs/infrastructure-roadmap.md`, change the P6 row's Status cell from `🔨 P6a + CLA done` to `✅ done — bypass-attestation green in sweep run <RUN_ID>` (fill in after Step 9), and change the Gate cell's trailing `Remaining: bypass-actor audit` to `bypass actors gated by the owner-run audit:bypass-actors + the sweep's audit:bypass-attestation`.

Add to the P6a progress log, replacing the `**Deferred:**` bullet's bypass-actor clause:

```markdown
- **Bypass-actor audit — CLOSED (2026-07-30).** The last P6 item. `audit:ruleset-drift`
  still cannot read `bypass_actors` (its App token gets an empty array; reading the
  field needs `Administration: write`, which a read-only gate must not hold), so the
  field is gated by a pair instead: the owner-run `audit:bypass-actors` diffs live
  state against a new machine-readable `bypass` block and writes a committed
  attestation, and the credential-free `audit:bypass-attestation` runs in the sweep
  checking freshness (90d, flipping to 30 at contributor-two), repo coverage, and
  that the snapshot still agrees with declared intent.
- **What the design review caught before any code existed.** `--attest` originally
  keyed off the diff alone. But `decideExit` returns exit 0 for a partial read with
  no drift — correct for a reporting gate, wrong for an attesting one — so a 4-of-5
  read would have written an attestation claiming five repos, which the sweep gate
  then accepts as full coverage for the whole grace window. `--attest` now requires
  a complete read, and the written `repos` field derives from what was observed.
- **Honest limit.** The attestation is a committed file and can be hand-edited, so
  the gate proves *a green attestation was committed recently and still agrees with
  declared intent*, not *the org is clean now*. The control is that the file is
  PR-visible and diff-reviewed. Residual exposure is bounded by the grace window.
```

Keep the remaining deferred items (private-repo ruleset protection stays blocked-on-Team).

- [ ] **Step 8: Full local verification**

```bash
bun test scripts/structure-audit/
bunx biome check packages scripts
bun run lint:markdown
bun run audit:doc-refs
bun run audit:status-drift
```

All must pass. Then commit:

```bash
git add docs/structure-audit/bypass-actors-attestation.json docs/infrastructure-roadmap.md
git commit -m "feat(p6): attest the live bypass state and close P6

Red-proved three ways before attesting: a flipped declared bypass_mode reds the
diff, an unreachable repo refuses to attest, and a backdated attestation reds
the sweep gate. Live state matches declared intent on all five repos."
```

- [ ] **Step 9: Push, PR, and prove it in the sweep**

```bash
git push -u origin dev/asafgolombek/p6-bypass-actor-audit
gh pr create --fill
```

After merge, dispatch the sweep and confirm the new job is green — **this is P6's actual bar, not the merge**:

```bash
gh workflow run org-drift-sweep.yml --ref main
gh run list --workflow=org-drift-sweep.yml --limit 1
```

Verify `bypass-attestation` is `success`, then backfill the run id into the roadmap row from Step 7 and commit that one-line change.

---

## Self-Review

**Spec coverage.** Gate 1 → Tasks 1-3. Gate 2 → Task 4. Config block + grace switch → Task 1. Stale-comment corrections (all four sites) → Task 1 (the two in `general-branch.json`) and Task 5 (the two in `check-ruleset-drift.ts`). Attestation shape → Task 3. Sweep placement + `CI_ONLY_GATES` → Task 5. Red-prove → Task 6 Steps 1-3 and 6. Definition of done items 1-6 → Task 6 Steps 4-9.

**Review-response coverage.** 1.2 partial-read guard → Task 3 (`decideAttestWrite` + its test) and Task 6 Step 3. 1.1 unsupported-actor hard error → Task 2. 1.3 NaN and future-date → Task 4. 2.1 `attested_by` → "unknown" → Task 3 Step 5. 2.3 enum validation → Task 1. 2.2 was declined, so no task — correct.

**Type consistency.** `AuditResult` is defined once in `check-bypass-actors.ts` and imported by Gate 2. `BypassActor` likewise. `diffBypassActors(repos, declared, observed)` keeps that argument order at all three call sites (Task 2 tests, Task 3 CLI, Task 4 `evaluateAttestation`). `ATTESTATION_PATH` is defined in `_bypass-attestation.ts` and used in Tasks 3 and 4.

**Plan-review disposition (2026-07-30).** Reviewed in
[`2026-07-30-p6-bypass-actor-audit-review.md`](./2026-07-30-p6-bypass-actor-audit-review.md);
2 adopted, 2 declined.

- **2.2 — adopted, and it found a second NaN fail-open.** Gate 2's CLI consumed
  `attestation_grace_days` without validating it. A missing value makes
  `graceDays * DAY_MS` NaN, and `elapsed > NaN` is false — verified: a
  3650-day-old attestation evaluates as *fresh*. Deleting one config line would
  have silently disabled the freshness check while the gate stayed green. Now
  guarded in both `evaluateAttestation` (so tests cover it) and the CLI, with
  two new tests. Same bug class as the `attested_at` NaN the design review
  caught, one level up.
- **1.1 — partially adopted.** `loadDeclaredBypass` now names the file on a parse
  failure instead of throwing a bare offset. Deliberately *not* given an
  `unparseable` verdict like the attestation's: that file is generated and could
  plausibly be corrupted, while this one is hand-authored and already covered by
  `biome check .`, so a parse failure is a broken repo rather than a runtime
  condition. The existing `loadDesiredFile` in `check-ruleset-drift.ts` has the
  identical bare `JSON.parse`; not touched here, as it is a working gate and out
  of scope.
- **1.2 (`--help`) — declined.** No gate in `scripts/structure-audit/` implements
  it (verified by grep). These are `bun run audit:*` entry points invoked from
  `package.json` and CI, not user-facing CLIs — `packages/cli` is the product's
  CLI. Adding help text to 2 of ~20 gates would create inconsistency without a
  consumer.
- **2.1 (`attested_by` env fallback) — declined; already litigated.** This repeats
  §2.1 of the design review response, where `git config`/`$USER` fallbacks were
  rejected because they name the environment rather than the credential that
  performed the read. The new motivation — easier offline `--attest` testing — is
  impossible by construction: `--attest` requires five successful `gh` reads, so
  offline it exits at `queried === 0` long before `attested_by` is resolved.
  `GITHUB_ACTOR` would be actively worse, naming a CI principal for a gate that
  is never meant to run in CI.

**One asymmetry worth flagging to the implementer:** Gate 2 is the only sweep gate with no `--strict` branch. Every other one fails soft locally because it needs `gh` auth that an external contributor lacks; Gate 2 reads two committed files and nothing else, so there is no environment in which it cannot run. The workflow still passes `--strict` for consistency with its siblings, where it is a no-op. This is explained in a comment at the exit site rather than left for a reader to infer.
