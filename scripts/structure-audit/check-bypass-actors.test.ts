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
