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
