import { describe, expect, test } from "bun:test";

import {
  type AdoptParams,
  type ConnectorDetectDeps,
  type FindingWire,
  runConnectorDetect,
  summarizeLocalLogins,
} from "./connector-detect.ts";

const GH: FindingWire = {
  source: "gh",
  status: "available",
  alreadyConfigured: false,
  host: "github.com",
  accounts: ["octocat", "work-user"],
  activeAccount: "octocat",
};
const AWS: FindingWire = {
  source: "aws",
  status: "available",
  alreadyConfigured: true,
  profiles: ["dev"],
};
const KUBE: FindingWire = {
  source: "kubectl",
  status: "cli_not_found",
  reason: "kubectl is not installed (not found on PATH)",
  alreadyConfigured: false,
};
const GCLOUD_NEEDS: FindingWire = {
  source: "gcloud",
  status: "needs_project",
  reason: "gcloud has no default project — name one to use",
  alreadyConfigured: false,
  account: "me@example.com",
  project: null,
};

function deps(over: Partial<ConnectorDetectDeps> & { answers?: string[] } = {}): {
  deps: ConnectorDetectDeps;
  out: string[];
  adopted: AdoptParams[];
  sourcesAsked: Array<readonly string[] | undefined>;
} {
  const out: string[] = [];
  const adopted: AdoptParams[] = [];
  const sourcesAsked: Array<readonly string[] | undefined> = [];
  const answers = [...(over.answers ?? [])];
  return {
    out,
    adopted,
    sourcesAsked,
    deps: {
      detect: async (s) => {
        sourcesAsked.push(s);
        return [GH, AWS, KUBE];
      },
      adopt: async (p) => {
        adopted.push(p);
        return {
          ok: true,
          source: p.source,
          service: p.source === "gh" ? "github" : p.source,
          verified: "verified",
          scopes: ["repo", "read:org"],
        };
      },
      interactive: true,
      ask: async () => answers.shift() ?? "",
      log: (l) => out.push(l),
      ...over,
    },
  };
}

describe("nimbus connector detect", () => {
  test("--json prints the findings and adopts nothing", async () => {
    const d = deps();
    await runConnectorDetect(["--json"], d.deps);
    expect(JSON.parse(d.out.join("\n"))).toEqual([GH, AWS, KUBE]);
    expect(d.adopted).toEqual([]);
  });

  test("non-interactive lists findings, adopts nothing, and says how to adopt", async () => {
    const d = deps({ interactive: false });
    await runConnectorDetect([], d.deps);
    const text = d.out.join("\n");
    expect(text).toContain("octocat");
    expect(text).toContain("not installed");
    expect(text).toContain("in a terminal");
    expect(d.adopted).toEqual([]);
  });

  test("interactive: Enter picks the preselected ACTIVE account; configured aws is skipped", async () => {
    const d = deps({ answers: [""] });
    await runConnectorDetect([], d.deps);
    expect(d.adopted).toEqual([{ source: "gh", account: "octocat", replace: false }]);
    const text = d.out.join("\n");
    expect(text).toContain("aws is already configured");
    expect(text).toContain("repo, read:org");
  });

  test("a numbered answer picks that account; 0 skips", async () => {
    const pick2 = deps({ answers: ["2"] });
    await runConnectorDetect(["--source", "gh"], pick2.deps);
    expect(pick2.adopted).toEqual([{ source: "gh", account: "work-user", replace: false }]);
    expect(pick2.sourcesAsked).toEqual([["gh"]]);

    const skip = deps({ answers: ["0"] });
    await runConnectorDetect([], skip.deps);
    expect(skip.adopted).toEqual([]);
  });

  test("--replace re-offers an already-configured source", async () => {
    const d = deps({ answers: [""] });
    await runConnectorDetect(["--replace"], d.deps);
    expect(d.adopted).toContainEqual({ source: "aws", profile: "dev", replace: true });
  });

  test("a declined consent prompt is reported as skipped, not as an error", async () => {
    const d = deps({
      answers: [""],
      adopt: async () => ({ status: "rejected", reason: "User declined consent gate." }),
    });
    await runConnectorDetect([], d.deps);
    expect(d.out.join("\n")).toContain("Skipped — not approved");
  });

  test("a reference source prints the must-be-able-to-authenticate hint", async () => {
    const d = deps({ answers: [""] });
    await runConnectorDetect(["--replace", "--source", "aws"], d.deps);
    expect(d.out.join("\n")).toContain("aws sso login --profile dev");
  });

  test("an adopt error is printed and the walk continues", async () => {
    let n = 0;
    const d = deps({
      answers: ["", ""],
      adopt: async () => {
        n += 1;
        throw new Error('ERR_LOCAL_AUTH_SOURCE_CHANGED: gh account "octocat" is no longer listed');
      },
    });
    await runConnectorDetect(["--replace"], d.deps);
    expect(n).toBe(2);
    expect(d.out.join("\n")).toContain("ERR_LOCAL_AUTH_SOURCE_CHANGED");
  });

  test("an unknown flag or source is a usage error", async () => {
    await expect(runConnectorDetect(["--bogus"], deps().deps)).rejects.toThrow(
      /Usage: nimbus connector detect/,
    );
    await expect(runConnectorDetect(["--source", "svn"], deps().deps)).rejects.toThrow(/Usage/);
  });
});

describe("summarizeLocalLogins", () => {
  test("counts adoptable (available, not yet configured) findings", () => {
    expect(summarizeLocalLogins([GH, AWS, KUBE])).toBe(
      "Found 1 local login Nimbus can reuse — run: nimbus connector detect",
    );
    expect(summarizeLocalLogins([AWS, KUBE])).toBeNull();
  });

  test("pluralizes when more than one finding is adoptable", () => {
    const unconfiguredAws: FindingWire = { ...AWS, alreadyConfigured: false };
    expect(summarizeLocalLogins([GH, unconfiguredAws, KUBE])).toBe(
      "Found 2 local logins Nimbus can reuse — run: nimbus connector detect",
    );
  });
});

// Branches the Step 2 fixtures above never reach: a reason-less refusal, an out-of-range
// numbered pick, the two non-"verified" report states, a bare trailing `--source`, an empty
// offer, and a kubectl finding that is itself adoptable (the fixtures above only ever offer
// gh/aws — KUBE is always `cli_not_found`, so `choices()`'s context arm, `chooseOne`'s final
// `context` return, and `referenceHint`'s kubectl arm are otherwise dead in this test file).
describe("nimbus connector detect — additional branches", () => {
  test("a refusal with no reason omits the trailing dash", async () => {
    const noReason: FindingWire = {
      source: "kubectl",
      status: "cli_not_found",
      alreadyConfigured: false,
    };
    const d = deps({ detect: async () => [noReason] });
    await runConnectorDetect([], d.deps);
    const text = d.out.join("\n");
    expect(text).toContain("cli not found");
    expect(text).not.toContain("cli not found —");
  });

  test("an out-of-range numbered answer is treated as skip", async () => {
    const d = deps({ answers: ["5"] });
    await runConnectorDetect([], d.deps);
    expect(d.adopted).toEqual([]);
    expect(d.out.join("\n")).toContain("Not a choice — skipping.");
  });

  test("an unverified or unreported adoption is reported distinctly from verified", async () => {
    const unverified = deps({
      answers: [""],
      adopt: async (p) => ({
        ok: true,
        source: p.source,
        service: "github",
        verified: "unverified",
        scopes: [],
      }),
    });
    await runConnectorDetect([], unverified.deps);
    expect(unverified.out.join("\n")).toContain("stored, NOT verified");

    const unreported = deps({
      answers: [""],
      adopt: async (p) => ({
        ok: true,
        source: p.source,
        service: "github",
        verified: null,
        scopes: [],
      }),
    });
    await runConnectorDetect([], unreported.deps);
    const text = unreported.out.join("\n");
    expect(text).toContain("github connected (stored).");
    expect(text).toContain("(not reported)");
  });

  test("a trailing --source with no value is a usage error", async () => {
    await expect(runConnectorDetect(["--source"], deps().deps)).rejects.toThrow(/Usage/);
  });

  test("no adoptable findings offers nothing and adopts nothing", async () => {
    const configured: FindingWire = { ...GH, alreadyConfigured: true };
    const d = deps({ detect: async () => [configured, AWS] });
    await runConnectorDetect([], d.deps);
    expect(d.adopted).toEqual([]);
    expect(d.out.join("\n")).not.toContain("Connecting");
  });

  test("an adoptable kubectl finding offers its current context and the kubectl hint", async () => {
    const kubeAvailable: FindingWire = {
      source: "kubectl",
      status: "available",
      alreadyConfigured: false,
      kubeconfig: "~/.kube/config",
      contexts: ["ctx-a", "ctx-b"],
      currentContext: "ctx-a",
    };
    const d = deps({ detect: async () => [kubeAvailable], answers: [""] });
    await runConnectorDetect([], d.deps);
    expect(d.adopted).toEqual([{ source: "kubectl", context: "ctx-a", replace: false }]);
    expect(d.out.join("\n")).toContain("kubectl must be able to reach context ctx-a");
  });
});

describe("nimbus connector detect — gcloud", () => {
  test("needs_project asks for a project id and adopts with it", async () => {
    const d = deps({ answers: ["acme-prod"], detect: async () => [GCLOUD_NEEDS] });
    await runConnectorDetect([], d.deps);
    expect(d.adopted).toEqual([{ source: "gcloud", project: "acme-prod", replace: false }]);
  });

  test("--project supplies it non-interactively-in-spirit (no question asked)", async () => {
    let asked = 0;
    const d = deps({
      detect: async () => [GCLOUD_NEEDS],
      ask: async () => {
        asked += 1;
        return "";
      },
    });
    await runConnectorDetect(["--project", "acme-prod"], d.deps);
    expect(asked).toBe(0);
    expect(d.adopted).toEqual([{ source: "gcloud", project: "acme-prod", replace: false }]);
  });

  test("an empty project answer skips gcloud", async () => {
    const d = deps({ answers: [""], detect: async () => [GCLOUD_NEEDS] });
    await runConnectorDetect([], d.deps);
    expect(d.adopted).toEqual([]);
  });

  test("an already-available gcloud finding (default project known) adopts it without asking", async () => {
    const gcloudAvailable: FindingWire = {
      source: "gcloud",
      status: "available",
      alreadyConfigured: false,
      account: "me@example.com",
      project: "acme-prod",
    };
    let asked = 0;
    const d = deps({
      detect: async () => [gcloudAvailable],
      ask: async () => {
        asked += 1;
        return "";
      },
    });
    await runConnectorDetect([], d.deps);
    expect(asked).toBe(0);
    expect(d.adopted).toEqual([{ source: "gcloud", project: "acme-prod", replace: false }]);
  });

  // I-1 regression: the explicit flag must win over gcloud's own detected default, matching the
  // gateway's `resolveTarget` (`req.project ?? f.project`) — proven wrong once (the flag was
  // silently dropped whenever the finding already carried a project), so both directions of
  // `available` + `--project` are pinned here rather than just the no-flag case above.
  test("--project overrides an available finding's own detected default project", async () => {
    const gcloudAvailable: FindingWire = {
      source: "gcloud",
      status: "available",
      alreadyConfigured: false,
      account: "me@example.com",
      project: "detected-default",
    };
    const d = deps({ detect: async () => [gcloudAvailable] });
    await runConnectorDetect(["--project", "explicit-override"], d.deps);
    expect(d.adopted).toEqual([{ source: "gcloud", project: "explicit-override", replace: false }]);
  });

  test("without --project, an available finding's own detected default is used", async () => {
    const gcloudAvailable: FindingWire = {
      source: "gcloud",
      status: "available",
      alreadyConfigured: false,
      account: "me@example.com",
      project: "detected-default",
    };
    const d = deps({ detect: async () => [gcloudAvailable] });
    await runConnectorDetect([], d.deps);
    expect(d.adopted).toEqual([{ source: "gcloud", project: "detected-default", replace: false }]);
  });

  test("--source gcloud is accepted and renders as its own kind — not the kubectl fallback branch", async () => {
    const sourcesAsked: Array<readonly string[] | undefined> = [];
    const d = deps({
      answers: [""],
      detect: async (s) => {
        sourcesAsked.push(s);
        return [GCLOUD_NEEDS];
      },
    });
    await runConnectorDetect(["--source", "gcloud"], d.deps);
    const text = d.out.join("\n");
    expect(text).toContain("me@example.com  project: (none)");
    expect(text).not.toContain("contexts:");
    expect(sourcesAsked).toEqual([["gcloud"]]);
  });

  test("the gcloud reference hint names the login it must stay signed into", async () => {
    const d = deps({ answers: ["acme-prod"], detect: async () => [GCLOUD_NEEDS] });
    await runConnectorDetect([], d.deps);
    expect(d.out.join("\n")).toContain("gcloud must be logged in as this account");
  });

  test("--project with an unknown flag or missing value is a usage error", async () => {
    await expect(runConnectorDetect(["--project"], deps().deps)).rejects.toThrow(/Usage/);
    await expect(runConnectorDetect(["--project", ""], deps().deps)).rejects.toThrow(/Usage/);
  });

  test("a whitespace-only --project value is a usage error, matching an empty one", async () => {
    await expect(runConnectorDetect(["--project", "   "], deps().deps)).rejects.toThrow(/Usage/);
  });

  test("--project trims surrounding whitespace before it reaches AdoptParams", async () => {
    const d = deps({ detect: async () => [GCLOUD_NEEDS] });
    await runConnectorDetect(["--project", "  acme-prod  "], d.deps);
    expect(d.adopted).toEqual([{ source: "gcloud", project: "acme-prod", replace: false }]);
  });

  // Re-adopt-after-unset: the owner adopted gcloud once (gcp becomes configured), then ran
  // `gcloud config unset project`. detect now reports `needs_project` + `alreadyConfigured`.
  // `adoptable()` correctly withholds it without --replace, but the "already configured" hint
  // must still fire — it used to gate on `status === "available"` only and stayed silent here,
  // leaving the owner with nothing but the raw "needs project" reason line.
  test("a needs_project finding that is already configured prints the --replace hint, not silence", async () => {
    const reconfigured: FindingWire = { ...GCLOUD_NEEDS, alreadyConfigured: true };
    const d = deps({ detect: async () => [reconfigured] });
    await runConnectorDetect([], d.deps);
    expect(d.adopted).toEqual([]);
    expect(d.out.join("\n")).toContain(
      "gcp is already configured — pass --replace to overwrite it.",
    );
  });

  test("--replace re-offers a needs_project finding that is already configured", async () => {
    const reconfigured: FindingWire = { ...GCLOUD_NEEDS, alreadyConfigured: true };
    const d = deps({ answers: ["acme-prod"], detect: async () => [reconfigured] });
    await runConnectorDetect(["--replace"], d.deps);
    expect(d.adopted).toEqual([{ source: "gcloud", project: "acme-prod", replace: true }]);
  });
});
