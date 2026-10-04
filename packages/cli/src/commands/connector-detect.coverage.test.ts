import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureOutput } from "../../test/helpers/cli-output.ts";
import { isolatePlatformEnv } from "../../test/helpers/isolate-platform-env.ts";
import { GatewayNotRunningError } from "../lib/with-gateway-ipc.ts";
import type { CliPlatformPaths } from "../paths.ts";
import {
  type AdoptParams,
  type ConnectorDetectDeps,
  defaultConnectorDetectDeps,
  type FindingWire,
  runConnectorDetect,
} from "./connector-detect.ts";

/**
 * Branches `connector-detect.test.ts` leaves unexercised: findings whose optional fields the
 * gateway omitted, an offered source with nothing to pick, a non-Error adopt failure, and the
 * production deps — exercised against an EMPTY temp data dir, so no real `gateway.json` is read.
 */

function deps(over: Partial<ConnectorDetectDeps> & { answers?: string[] } = {}): {
  deps: ConnectorDetectDeps;
  out: string[];
  adopted: AdoptParams[];
  questions: string[];
} {
  const out: string[] = [];
  const adopted: AdoptParams[] = [];
  const questions: string[] = [];
  const answers = [...(over.answers ?? [])];
  return {
    out,
    adopted,
    questions,
    deps: {
      detect: async () => [],
      adopt: async (p) => {
        adopted.push(p);
        return { ok: true, source: p.source, service: p.source, verified: "verified", scopes: [] };
      },
      interactive: true,
      ask: async (q) => {
        questions.push(q);
        return answers.shift() ?? "";
      },
      log: (l) => out.push(l),
      ...over,
    },
  };
}

describe("finding lines when the gateway omitted optional fields", () => {
  test("each source renders its own neutral fallback rather than 'undefined'", async () => {
    const findings: FindingWire[] = [
      { source: "gh", status: "cli_not_found", alreadyConfigured: false },
      { source: "aws", status: "cli_not_found", alreadyConfigured: false },
      { source: "kubectl", status: "cli_not_found", alreadyConfigured: false },
      { source: "gcloud", status: "cli_not_found", alreadyConfigured: false },
    ];
    const d = deps({ detect: async () => findings, interactive: false });
    await runConnectorDetect([], d.deps);
    expect(d.out).toEqual([
      "Local logins Nimbus can reuse:",
      "  gh       github.com    ·  cli not found",
      "  aws      profiles:   ·  cli not found",
      "  kubectl    contexts:   ·  cli not found",
      "  gcloud     project: (none)  ·  cli not found",
    ]);
    expect(d.out.join("\n")).not.toContain("undefined");
    expect(d.adopted).toEqual([]);
  });

  test("a gcloud finding with a null account renders the project alone", async () => {
    const d = deps({
      detect: async () => [
        {
          source: "gcloud",
          status: "cli_not_found",
          alreadyConfigured: false,
          account: null,
          project: "acme-prod",
        },
      ],
      interactive: false,
    });
    await runConnectorDetect([], d.deps);
    expect(d.out[1]).toBe("  gcloud     project: acme-prod  ·  cli not found");
  });

  test("a source this CLI does not know (a newer gateway) is listed under its own name, not crashed on", async () => {
    // `FindingWire` is asserted off the wire, never validated, so a gateway newer than this CLI can
    // report a fifth source — which makes the `never` default in the line renderer reachable at
    // run time. The status is one nothing is ever offered for, so only the listing runs: this pins
    // the rendering alone, not what an offer of an unknown source would do.
    const fromNewerGateway = JSON.parse(
      '[{"source":"azure","status":"cli_not_found","alreadyConfigured":false}]',
    ) as FindingWire[];
    const d = deps({ detect: async () => fromNewerGateway });
    await runConnectorDetect([], d.deps);
    expect(d.out).toEqual(["Local logins Nimbus can reuse:", "  azure    azure  ·  cli not found"]);
    expect(d.questions).toEqual([]);
    expect(d.adopted).toEqual([]);
  });
});

describe("interactive picks with partial findings", () => {
  test("an available gh login with no accounts listed has nothing to pick — adopts nothing, asks nothing", async () => {
    const d = deps({
      detect: async () => [{ source: "gh", status: "available", alreadyConfigured: false }],
    });
    await runConnectorDetect([], d.deps);
    expect(d.adopted).toEqual([]);
    expect(d.questions).toEqual([]);
    expect(d.out.join("\n")).not.toContain("Connecting gh");
  });

  test("an available aws login with no profiles listed adopts nothing", async () => {
    const d = deps({
      detect: async () => [{ source: "aws", status: "available", alreadyConfigured: false }],
    });
    await runConnectorDetect([], d.deps);
    expect(d.adopted).toEqual([]);
    expect(d.out.join("\n")).not.toContain("Connecting aws");
  });

  test("an available kubectl login with no contexts listed adopts nothing", async () => {
    const d = deps({
      detect: async () => [{ source: "kubectl", status: "available", alreadyConfigured: false }],
    });
    await runConnectorDetect([], d.deps);
    expect(d.adopted).toEqual([]);
    expect(d.out.join("\n")).not.toContain("Connecting kubectl");
  });

  test("with no active gh account reported, Enter falls back to the FIRST listed account", async () => {
    const d = deps({
      detect: async () => [
        {
          source: "gh",
          status: "available",
          alreadyConfigured: false,
          accounts: ["first-user", "second-user"],
          activeAccount: null,
        },
      ],
      answers: [""],
    });
    await runConnectorDetect([], d.deps);
    expect(d.out).toContain("    1) first-user  (default)");
    expect(d.out).toContain("    2) second-user");
    expect(d.questions).toEqual(["  [Enter = 1, 0 = skip] "]);
    expect(d.adopted).toEqual([{ source: "gh", account: "first-user", replace: false }]);
  });

  test("with no current kubectl context, the first is the default and a number picks another", async () => {
    const d = deps({
      detect: async () => [
        {
          source: "kubectl",
          status: "available",
          alreadyConfigured: false,
          contexts: ["ctx-a", "ctx-b"],
        },
      ],
      answers: ["2"],
    });
    await runConnectorDetect([], d.deps);
    expect(d.out).toContain("    1) ctx-a  (default)");
    expect(d.adopted).toEqual([{ source: "kubectl", context: "ctx-b", replace: false }]);
    expect(d.out).toContain(
      "  kubectl must be able to reach context ctx-b when Nimbus syncs (refresh its login if it uses an exec plugin).",
    );
  });

  test("a non-Error adopt failure is printed verbatim and does not throw", async () => {
    const d = deps({
      detect: async () => [
        { source: "aws", status: "available", alreadyConfigured: false, profiles: ["dev"] },
      ],
      adopt: async () => {
        throw "gateway hung up";
      },
    });
    await runConnectorDetect([], d.deps);
    expect(d.out).toContain("Connecting aws — approve the prompt to continue.");
    expect(d.out).toContain("  ✗ gateway hung up");
  });
});

describe("defaultConnectorDetectDeps — the production wiring", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });
  beforeEach(() => {
    // In the whole-suite run another file may have installed `test/helpers/cli-mocks.ts`'s module
    // mocks, whose fake gateway-state reader returns this global. Clearing it keeps "no gateway"
    // true under both the real reader (an empty temp dir) and that fake.
    delete (globalThis as { __nimbusCliFixture?: unknown }).__nimbusCliFixture;
  });

  function emptyPaths(): CliPlatformPaths {
    const root = mkdtempSync(join(tmpdir(), "nimbus-cdetect-"));
    roots.push(root);
    return {
      configDir: join(root, "config"),
      dataDir: join(root, "data"),
      logDir: join(root, "data", "logs"),
      socketPath: join(root, "gw.sock"),
      extensionsDir: join(root, "ext"),
      tempDir: join(root, "tmp"),
    };
  }

  test("detect and adopt look the gateway up under the CALLER's paths — and refuse with none there", async () => {
    // The paths are demo-rooted, so the refusal names the DEMO start command: that is what proves
    // these paths reached the lookup (`nimbus init` hands its own). Were they dropped, the lookup
    // would fall back to the platform default and the refusal would name plain `nimbus start`.
    // That default is isolated below, so such a regression looks in a never-created root rather
    // than a developer's real profile (macOS excepted — see `isolatePlatformEnv`'s stated bound).
    const restoreEnv = isolatePlatformEnv(join(tmpdir(), "nimbus-cdetect-defaults-never-created"));
    const refusals: unknown[] = [];
    try {
      const d = defaultConnectorDetectDeps({ ...emptyPaths(), demo: true });
      for (const step of [
        () => d.detect(undefined),
        () => d.detect(["gh"]),
        () => d.adopt({ source: "gh", account: "octocat", replace: false }),
      ]) {
        await step().then(
          () => refusals.push("resolved"),
          (e: unknown) => refusals.push(e),
        );
      }
    } finally {
      restoreEnv();
    }
    expect(refusals).toHaveLength(3);
    for (const e of refusals) {
      expect(e).toBeInstanceOf(GatewayNotRunningError);
      expect((e as Error).message).toBe(
        "Gateway is not running (demo root). Start with: nimbus --demo start",
      );
    }
  });

  test("interactive is true only when BOTH stdin and stdout are terminals", () => {
    const saved = {
      stdin: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
      stdout: Object.getOwnPropertyDescriptor(process.stdout, "isTTY"),
    };
    const setTty = (stdin: boolean, stdout: boolean): void => {
      Object.defineProperty(process.stdin, "isTTY", { value: stdin, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: stdout, configurable: true });
    };
    const results: boolean[] = [];
    try {
      for (const [stdin, stdout] of [
        [true, true],
        [true, false],
        [false, true],
      ] as const) {
        setTty(stdin, stdout);
        results.push(defaultConnectorDetectDeps().interactive);
      }
    } finally {
      for (const [stream, desc] of [
        [process.stdin, saved.stdin],
        [process.stdout, saved.stdout],
      ] as const) {
        if (desc === undefined) delete (stream as unknown as { isTTY?: boolean }).isTTY;
        else Object.defineProperty(stream, "isTTY", desc);
      }
    }
    expect(results).toEqual([true, false, false]);
  });

  test("log writes one line to stdout", () => {
    const out = captureOutput();
    try {
      defaultConnectorDetectDeps().log("  ✓ github connected (verified).");
    } finally {
      out.restore();
    }
    expect(out.stdout).toBe("  ✓ github connected (verified).\n");
  });

  test("with no deps, a bad flag is refused before the gateway is ever consulted", async () => {
    // The production deps are built, but parsing fails first — so no detect call is attempted.
    // Were that to regress, the gateway lookup would land in this never-created root instead.
    const restoreEnv = isolatePlatformEnv(join(tmpdir(), "nimbus-cdetect-env-never-created"));
    try {
      await expect(runConnectorDetect(["--bogus"])).rejects.toThrow(
        /^Usage: nimbus connector detect/,
      );
    } finally {
      restoreEnv();
    }
  });
});
