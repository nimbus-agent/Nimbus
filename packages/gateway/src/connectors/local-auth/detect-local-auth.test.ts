import { describe, expect, test } from "bun:test";

import { ConnectorRpcError } from "../../ipc/connector-rpc-shared.ts";
import { detectLocalAuth, parseSources } from "./detect-local-auth.ts";
import type { LocalAuthHostDeps } from "./local-auth-host.ts";

function host(): LocalAuthHostDeps {
  return {
    run: async () => ({ ok: true, stdout: "dev\n", stderr: "", code: 0 }),
    which: (bin) => bin !== "kubectl",
    readFile: () => "github.com:\n    user: octocat\n",
    exists: () => true,
    env: {},
    platform: "linux",
    homeDir: "/home/u",
  };
}

describe("parseSources", () => {
  test("absent → every source", () => {
    expect(parseSources(undefined)).toEqual(["gh", "aws", "kubectl", "gcloud"]);
  });
  test("a valid subset, de-duplicated, in canonical order", () => {
    expect(parseSources(["kubectl", "gh", "gh"])).toEqual(["gh", "kubectl"]);
  });
  test("an unknown source or a non-array is refused", () => {
    expect(() => parseSources(["gcloud2"])).toThrow(ConnectorRpcError);
    expect(() => parseSources("gh")).toThrow(ConnectorRpcError);
  });
});

describe("detectLocalAuth", () => {
  test("runs the requested detectors and marks alreadyConfigured per service", async () => {
    const asked: string[] = [];
    // Includes "gcloud" so `LOCAL_AUTH_SERVICE.gcloud = "gcp"` is actually exercised here — a
    // prior version of this test requested only gh/aws/kubectl, so a wrong mapping (e.g. reusing
    // "gcp" for the wrong source, or a typo) would compute `alreadyConfigured` from the wrong
    // connector with this whole suite still green.
    const findings = await detectLocalAuth(["gh", "aws", "kubectl", "gcloud"], {
      host: host(),
      isConfigured: async (svc) => {
        asked.push(svc);
        return svc === "aws";
      },
    });
    expect(findings.map((f) => [f.source, f.status, f.alreadyConfigured])).toEqual([
      ["gh", "available", false],
      ["aws", "available", true],
      ["kubectl", "cli_not_found", false],
      // `host()`'s `run` always answers non-JSON stdout, so `detectGcloud` falls through to
      // `not_logged_in` regardless — the point of this row is `asked` below, not this status.
      ["gcloud", "not_logged_in", false],
    ]);
    expect(asked.sort()).toEqual(["aws", "gcp", "github", "kubernetes"]);
  });

  test("only the requested sources run", async () => {
    const findings = await detectLocalAuth(["aws"], {
      host: host(),
      isConfigured: async () => false,
    });
    expect(findings.map((f) => f.source)).toEqual(["aws"]);
  });
});
