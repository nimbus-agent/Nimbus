import { describe, expect, test } from "bun:test";

import {
  actorKey,
  assessBypassReadCapability,
  type BypassActor,
  capabilityErrors,
  type DeclaredBypassFile,
  decideExit,
  diffBypassActors,
  loadDeclaredBypass,
  parseOAuthScopes,
  probeCredentialScopes,
  scopesCanReadBypassActors,
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

  test("Finding 2: rejects a null-id-eligible actor_type carrying a numeric actor_id, distinctly from an unknown type", () => {
    const f = goodFile();
    f.bypass.by_repo["Nimbus"] = [
      { actor_type: "OrganizationAdmin", actor_id: 4382579, bypass_mode: "always" },
    ];
    const errors = validateDeclaredBypass(f);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("OrganizationAdmin");
    expect(errors[0]).toContain("numeric actor_id (4382579)");
    expect(errors[0]).toContain("not human-reviewable");
    expect(errors[0]).not.toContain("unsupported actor_type");
    expect(errors[0]).not.toContain("unknown actor_type");
  });
});

describe("loadDeclaredBypass", () => {
  test("the checked-in config is valid and covers all seven active repos", () => {
    const file = loadDeclaredBypass(process.cwd());
    expect(validateDeclaredBypass(file)).toEqual([]);
    // The count is deliberately exact rather than a floor: adding a repo to the
    // managed set must be a reviewed decision, not something that rides along.
    // create-nimbus-connector was the sixth — it publishes to npm and had been
    // outside every drift gate. nimbus-mcp is the seventh, added when
    // packages/mcp-launcher was extracted to its own repo and began publishing
    // @nimbus-dev/mcp; it is declared with an EMPTY bypass list, matching
    // nimbus-sdk and nimbus-client rather than nimbus-vscode's OrganizationAdmin
    // entry, because nothing about it needs a manual-publish escape hatch.
    expect(file.repos.length).toBe(7);
    expect(file.repos).toContain("create-nimbus-connector");
    expect(file.repos).toContain("nimbus-mcp");
    expect(file.bypass.by_repo["nimbus-mcp"]).toEqual([]);
    expect(Object.keys(file.bypass.by_repo).sort()).toEqual([...file.repos].sort());
  });
});

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
    live["nimbus-sdk"] = [
      { actor_type: "OrganizationAdmin", actor_id: null, bypass_mode: "always" },
    ];
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
    // A legitimately-passing single-repo set: one null-id OrganizationAdmin on
    // Nimbus, nothing on nimbus-sdk, reordered relative to `declared()`/
    // `observed()`. (A SECOND actor on one repo is no longer expressible here
    // without either a duplicate identity — Finding 1 — or a numeric actor_id
    // — Finding 2 — both of which are now hard errors by design; see
    // "is order-independent on the error path" below for that case instead.)
    const oneDeclared: Record<string, BypassActor[]> = {
      "nimbus-sdk": [],
      Nimbus: [{ actor_type: "OrganizationAdmin", bypass_mode: "always" }],
    };
    const oneLive: Record<string, BypassActor[]> = {
      Nimbus: [{ actor_type: "OrganizationAdmin", actor_id: null, bypass_mode: "always" }],
      "nimbus-sdk": [],
    };
    expect(diffBypassActors(REPOS, oneDeclared, oneLive).ok).toBe(true);
  });

  test("is order-independent on the error path: same findings regardless of input order", () => {
    // Two repos, each contributing one finding, checked in both orders.
    const declaredTwoRepos: Record<string, BypassActor[]> = {
      Nimbus: [{ actor_type: "OrganizationAdmin", bypass_mode: "always" }],
      "nimbus-sdk": [{ actor_type: "OrganizationAdmin", bypass_mode: "always" }],
    };
    const liveTwoRepos: Record<string, BypassActor[]> = {
      // Nimbus: a numeric-id OrganizationAdmin — unsupported (Finding 2).
      Nimbus: [{ actor_type: "OrganizationAdmin", actor_id: 7, bypass_mode: "always" }],
      // nimbus-sdk: a duplicated identity — Finding 1.
      "nimbus-sdk": [
        { actor_type: "OrganizationAdmin", actor_id: null, bypass_mode: "always" },
        { actor_type: "OrganizationAdmin", actor_id: null, bypass_mode: "pull_request" },
      ],
    };
    const forward = diffBypassActors(["Nimbus", "nimbus-sdk"], declaredTwoRepos, liveTwoRepos);
    const reversed = diffBypassActors(["nimbus-sdk", "Nimbus"], declaredTwoRepos, liveTwoRepos);
    expect(forward.ok).toBe(false);
    expect(reversed.ok).toBe(false);
    expect([...forward.errors].sort()).toEqual([...reversed.errors].sort());
  });

  test("Finding 1: a duplicate OBSERVED identity is a hard error, never normalized to the last entry", () => {
    // Proven failure: declared has a single pull_request-mode actor; observed
    // repeats the same identity as `always` then `pull_request`. Map-based
    // dedup on actorIdentity would keep only the LAST entry (pull_request),
    // matching declared and returning a false green — silently discarding the
    // more permissive `always` bypass, which is exactly what this gate exists
    // to catch.
    const declaredOne: Record<string, BypassActor[]> = {
      Nimbus: [{ actor_type: "OrganizationAdmin", bypass_mode: "pull_request" }],
    };
    const dupedActors: BypassActor[] = [
      { actor_type: "OrganizationAdmin", actor_id: null, bypass_mode: "always" },
      { actor_type: "OrganizationAdmin", actor_id: null, bypass_mode: "pull_request" },
    ];
    const r = diffBypassActors(["Nimbus"], declaredOne, { Nimbus: dupedActors });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain(
      "duplicate observed bypass actor identity OrganizationAdmin:null",
    );

    // Order-dependence proof: swapping the two observed entries must NOT change
    // the verdict (both must be errors — this was the reported symptom).
    const rSwapped = diffBypassActors(["Nimbus"], declaredOne, {
      Nimbus: [...dupedActors].reverse(),
    });
    expect(rSwapped.ok).toBe(false);
  });

  test("Finding 1: a duplicate DECLARED identity is also a hard error", () => {
    const declaredDuped: Record<string, BypassActor[]> = {
      Nimbus: [
        { actor_type: "OrganizationAdmin", bypass_mode: "always" },
        { actor_type: "OrganizationAdmin", bypass_mode: "pull_request" },
      ],
    };
    const live: Record<string, BypassActor[]> = {
      Nimbus: [{ actor_type: "OrganizationAdmin", actor_id: null, bypass_mode: "always" }],
    };
    const r = diffBypassActors(["Nimbus"], declaredDuped, live);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain(
      "duplicate declared bypass actor identity OrganizationAdmin:null",
    );
  });

  test("Finding 2: a numeric-id OrganizationAdmin is a hard error on the diff side, not merely 'unknown type'", () => {
    const live = observed();
    live["nimbus-sdk"] = [{ actor_type: "OrganizationAdmin", actor_id: 7, bypass_mode: "always" }];
    const r = diffBypassActors(REPOS, declared(), live);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("unsupported bypass actor type OrganizationAdmin");
    expect(r.errors[0]).toContain("numeric actor_id (7)");
    expect(r.errors[0]).toContain("not human-reviewable");
    expect(r.errors[0]).not.toContain("unknown actor_type");
  });
});

describe("actorKey", () => {
  test("normalizes an omitted actor_id to the same key as an explicit null", () => {
    expect(actorKey({ actor_type: "OrganizationAdmin", bypass_mode: "always" })).toBe(
      actorKey({ actor_type: "OrganizationAdmin", actor_id: null, bypass_mode: "always" }),
    );
  });
});

describe("decideExit", () => {
  test("skips green when nothing was readable and not strict", () => {
    expect(decideExit({ queried: 0, errors: [], unreachable: ["Nimbus"] }).code).toBe(0);
  });

  test("fails when nothing was readable under --strict", () => {
    expect(decideExit({ queried: 0, errors: [], unreachable: ["Nimbus"], strict: true }).code).toBe(
      1,
    );
  });

  test("keeps drift found on a reachable repo despite another repo failing", () => {
    const out = decideExit({
      queried: 1,
      errors: ["Nimbus: unexpected"],
      unreachable: ["nimbus-sdk"],
    });
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

const ORG_ADMIN: BypassActor = {
  actor_type: "OrganizationAdmin",
  actor_id: null,
  bypass_mode: "always",
};

describe("assessBypassReadCapability (#961)", () => {
  test("verified when a repo declaring actors actually reads them back", () => {
    const verdict = assessBypassReadCapability({
      declared: { Nimbus: [ORG_ADMIN], "nimbus-sdk": [] },
      observed: { Nimbus: [ORG_ADMIN], "nimbus-sdk": [] },
    });
    expect(verdict).toEqual({ kind: "verified", witness: "Nimbus" });
  });

  test("blind when every declared-non-empty repo reads back empty", () => {
    // The proven App-token behaviour: bypass_actors comes back empty for org-level actors.
    const verdict = assessBypassReadCapability({
      declared: { Nimbus: [ORG_ADMIN], "nimbus-vscode": [ORG_ADMIN], "nimbus-sdk": [] },
      observed: { Nimbus: [], "nimbus-vscode": [], "nimbus-sdk": [] },
    });
    expect(verdict).toEqual({ kind: "blind", declaredNonEmpty: ["Nimbus", "nimbus-vscode"] });
  });

  test("one surviving witness is enough — a genuine single removal is not called blind", () => {
    const verdict = assessBypassReadCapability({
      declared: { Nimbus: [ORG_ADMIN], "nimbus-vscode": [ORG_ADMIN] },
      observed: { Nimbus: [], "nimbus-vscode": [ORG_ADMIN] },
    });
    expect(verdict.kind).toBe("verified");
  });

  test("no-positive-control once bypass.by_repo is all-empty — the future state #961 is about", () => {
    const verdict = assessBypassReadCapability({
      declared: { Nimbus: [], "nimbus-sdk": [] },
      observed: { Nimbus: [], "nimbus-sdk": [] },
    });
    expect(verdict).toEqual({ kind: "no-positive-control" });
  });

  test("an unreachable repo is absence of evidence, not evidence of blindness", () => {
    // `observed` only carries repos actually queried; a declared-non-empty repo that
    // failed to read must not be counted as a repo that read empty.
    const verdict = assessBypassReadCapability({
      declared: { Nimbus: [ORG_ADMIN], "nimbus-vscode": [ORG_ADMIN] },
      observed: { Nimbus: [ORG_ADMIN] },
    });
    expect(verdict).toEqual({ kind: "verified", witness: "Nimbus" });
  });
});

describe("parseOAuthScopes / scopesCanReadBypassActors (#961)", () => {
  test("parses a classic token's scope header case-insensitively", () => {
    expect(parseOAuthScopes("HTTP/2 200\r\nX-OAuth-Scopes: admin:org, repo\r\n")).toEqual([
      "admin:org",
      "repo",
    ]);
    expect(parseOAuthScopes("x-oauth-scopes: repo\n")).toEqual(["repo"]);
  });

  test("absent header is UNDEFINED, not an empty list", () => {
    // An App installation token / fine-grained PAT sends no header at all. That is
    // "unknown", and must not be conflated with a token that has zero scopes.
    expect(parseOAuthScopes("HTTP/2 200\r\ncontent-type: application/json\r\n")).toBeUndefined();
    expect(parseOAuthScopes("x-oauth-scopes: \n")).toEqual([]);
  });

  test("only admin:org (or site_admin) demonstrates capability", () => {
    expect(scopesCanReadBypassActors(["admin:org"])).toBe(true);
    expect(scopesCanReadBypassActors(["site_admin"])).toBe(true);
    expect(scopesCanReadBypassActors(["repo", "read:org"])).toBe(false);
    expect(scopesCanReadBypassActors([])).toBe(false);
    expect(scopesCanReadBypassActors(undefined)).toBe(false);
  });
});

describe("capabilityErrors (#961) — fail-closed", () => {
  test("verified is the only silent path", () => {
    expect(capabilityErrors({ kind: "verified", witness: "Nimbus" }, undefined)).toEqual([]);
  });

  test("blind fails closed and names the repos that read empty", () => {
    const errs = capabilityErrors({ kind: "blind", declaredNonEmpty: ["Nimbus"] }, ["admin:org"]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("Nimbus");
    expect(errs[0]).toContain("Refusing to report a clean read");
  });

  test("no-positive-control passes only when the token proves admin:org", () => {
    expect(capabilityErrors({ kind: "no-positive-control" }, ["admin:org", "repo"])).toEqual([]);
  });

  test("no-positive-control fails closed for an App/fine-grained token (no scope header)", () => {
    // THE #961 scenario: all-empty config + a credential that cannot see the field.
    // Without this, the diff is green, the read is complete, decideAttestWrite permits
    // the write, and a false-clean attestation is honoured for the full grace window.
    const errs = capabilityErrors({ kind: "no-positive-control" }, undefined);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("no X-OAuth-Scopes header");
    expect(errs[0]).toContain("Refusing to report a clean read");
  });

  test("no-positive-control fails closed for a token holding the wrong scopes", () => {
    const errs = capabilityErrors({ kind: "no-positive-control" }, ["repo", "read:org"]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("scopes: repo, read:org");
  });
});

describe("probeCredentialScopes (#961)", () => {
  test("returns the parsed scopes when gh succeeds", () => {
    expect(
      probeCredentialScopes(() => ({
        ok: true,
        stdout: "HTTP/2 200\r\nX-OAuth-Scopes: admin:org\r\n\r\n{}",
        stderr: "",
      })),
    ).toEqual(["admin:org"]);
  });

  test("returns undefined when gh fails, so the caller fails closed", () => {
    expect(
      probeCredentialScopes(() => ({ ok: false, stdout: "", stderr: "HTTP 401" })),
    ).toBeUndefined();
  });
});
