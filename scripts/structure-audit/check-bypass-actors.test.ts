import { describe, expect, test } from "bun:test";

import {
  actorKey,
  type BypassActor,
  type DeclaredBypassFile,
  decideExit,
  diffBypassActors,
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
