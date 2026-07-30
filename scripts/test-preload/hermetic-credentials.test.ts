import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  blankCredentialEnv,
  isBehaviourMarkerEnvName,
  isBlankedEnvName,
  isCredentialEnvName,
} from "./hermetic-credentials.ts";

describe("isCredentialEnvName", () => {
  test("matches the credentials that actually leaked", () => {
    // The pair from #812 — a real Google OAuth desktop client on the developer's box.
    expect(isCredentialEnvName("NIMBUS_OAUTH_GOOGLE_CLIENT_ID")).toBe(true);
    expect(isCredentialEnvName("NIMBUS_OAUTH_GOOGLE_CLIENT_SECRET")).toBe(true);
    expect(isCredentialEnvName("NIMBUS_GITHUB_PAT")).toBe(true);
    expect(isCredentialEnvName("OPENAI_API_KEY")).toBe(true);
    expect(isCredentialEnvName("ANTHROPIC_API_KEY")).toBe(true);
    expect(isCredentialEnvName("NIMBUS_AWS_SECRET_ACCESS_KEY")).toBe(true);
  });

  test("leaves settings alone — a model name or a host is not a secret", () => {
    // Blanking these would change behaviour under test rather than protect anything.
    expect(isCredentialEnvName("NIMBUS_AGENT_MODEL")).toBe(false);
    expect(isCredentialEnvName("NIMBUS_OPENAI_CLASSIFIER_MODEL")).toBe(false);
    expect(isCredentialEnvName("NIMBUS_WORKDAY_TENANT_HOST")).toBe(false);
    expect(isCredentialEnvName("NIMBUS_CONFIG_DIR")).toBe(false);
  });

  test("requires an owned prefix — foreign credentials are not ours to clear", () => {
    // SONAR_TOKEN / CODACY_API_TOKEN belong to CI tooling, not to the gateway. Clearing
    // them inside `bun test` would protect nothing and could break a tool that reads them.
    expect(isCredentialEnvName("SONAR_TOKEN")).toBe(false);
    expect(isCredentialEnvName("CODACY_API_TOKEN")).toBe(false);
    expect(isCredentialEnvName("GITHUB_TOKEN")).toBe(false);
  });
});

describe("blankCredentialEnv", () => {
  test("blanks to empty string rather than deleting", () => {
    // Config reads `processEnvGet(x) ?? ""`, so "" and absent are equivalent to it — but ""
    // additionally survives code that only tests `in process.env`.
    const env: Record<string, string | undefined> = {
      NIMBUS_OAUTH_GOOGLE_CLIENT_SECRET: "real-secret",
      NIMBUS_AGENT_MODEL: "some-model",
    };
    const blanked = blankCredentialEnv(env);

    expect(blanked).toEqual(["NIMBUS_OAUTH_GOOGLE_CLIENT_SECRET"]);
    expect(env["NIMBUS_OAUTH_GOOGLE_CLIENT_SECRET"]).toBe("");
    expect("NIMBUS_OAUTH_GOOGLE_CLIENT_SECRET" in env).toBe(true);
    expect(env["NIMBUS_AGENT_MODEL"]).toBe("some-model");
  });

  test("reports names only — a value must never reach the return path", () => {
    const secret = "GOCSPX-not-a-real-one";
    const env: Record<string, string | undefined> = { NIMBUS_OAUTH_GOOGLE_CLIENT_SECRET: secret };
    const blanked = blankCredentialEnv(env);
    expect(blanked.join(",")).not.toContain(secret);
  });

  test("ignores already-empty and undefined entries", () => {
    const env: Record<string, string | undefined> = {
      NIMBUS_GITHUB_PAT: "",
      NIMBUS_SLACK_TOKEN: undefined,
    };
    expect(blankCredentialEnv(env)).toEqual([]);
  });
});

describe("isBehaviourMarkerEnvName (#967)", () => {
  test("matches the marker that silently reddened the updater wiring test", () => {
    // resolveDistributionChannel() reads this and concludes "package-manager install,
    // self-update disabled" — which made createUpdaterFromConfig return undefined and
    // failed an assertion that had nothing to do with the environment.
    expect(isBehaviourMarkerEnvName("NIMBUS_DISTRIBUTION_CHANNEL")).toBe(true);
    expect(isBlankedEnvName("NIMBUS_DISTRIBUTION_CHANNEL")).toBe(true);
  });

  test("is not a credential — the two categories stay distinct", () => {
    // It carries no secret; it is blanked for determinism, not for containment.
    expect(isCredentialEnvName("NIMBUS_DISTRIBUTION_CHANNEL")).toBe(false);
  });

  test("does not blank unrelated settings by pattern", () => {
    // Enumerated, not suffix-matched: `_CHANNEL` is too generic to blank wholesale.
    expect(isBehaviourMarkerEnvName("NIMBUS_SLACK_CHANNEL")).toBe(false);
    expect(isBehaviourMarkerEnvName("NIMBUS_AGENT_MODEL")).toBe(false);
    expect(isBlankedEnvName("NIMBUS_AGENT_MODEL")).toBe(false);
  });

  test("blankCredentialEnv clears markers alongside credentials", () => {
    const env: Record<string, string | undefined> = {
      NIMBUS_DISTRIBUTION_CHANNEL: "msi",
      NIMBUS_GITHUB_PAT: "ghp_notreal",
      NIMBUS_AGENT_MODEL: "some-model",
    };
    expect(blankCredentialEnv(env)).toEqual(["NIMBUS_DISTRIBUTION_CHANNEL", "NIMBUS_GITHUB_PAT"]);
    // "" is what resolveDistributionChannel treats as absent: it guards with
    // `if (raw && KNOWN_CHANNELS.has(raw))`, so an empty value falls through to
    // the path heuristics exactly as an unset var would.
    expect(env["NIMBUS_DISTRIBUTION_CHANNEL"]).toBe("");
    expect(env["NIMBUS_AGENT_MODEL"]).toBe("some-model");
  });
});

describe("the preload is actually wired", () => {
  /**
   * Run a child Bun process that reports what it sees for the marker.
   *
   * Asserting on THIS process would be vacuous: CI never sets
   * `NIMBUS_DISTRIBUTION_CHANNEL`, so `process.env[...] ?? "" === ""` passes
   * whether or not the preload runs — it would still be green with the preload
   * deleted, which is the one thing it exists to catch. A child with the marker
   * explicitly set is the only way to observe the blanking actually happening.
   */
  function markerSeenByChild(withPreload: boolean): string | undefined {
    const preloadPath = join(import.meta.dir, "hermetic-credentials.ts");
    const args = withPreload
      ? ["bun", "--preload", preloadPath, "-e", READ_MARKER]
      : ["bun", "-e", READ_MARKER];
    const proc = Bun.spawnSync(args, {
      env: {
        ...process.env,
        NIMBUS_DISTRIBUTION_CHANNEL: "msi",
        NIMBUS_TEST_PRELOAD_QUIET: "1",
      },
    });
    const out = new TextDecoder().decode(proc.stdout).trim();
    return (JSON.parse(out) as { marker?: string }).marker;
  }

  const READ_MARKER =
    "console.log(JSON.stringify({ marker: process.env.NIMBUS_DISTRIBUTION_CHANNEL }))";

  test("the preload blanks a behaviour marker that IS set in the environment", () => {
    // A developer who installed Nimbus through the MSI/Homebrew/apt has this
    // exported, and #967 is exactly what happens when it survives into the suite.
    expect(markerSeenByChild(true)).toBe("");
  });

  test("control: the same child WITHOUT the preload sees the real value", () => {
    // Proves the previous assertion is caused by the preload rather than by the
    // variable being absent — without this pair, a no-op preload reads as a pass.
    expect(markerSeenByChild(false)).toBe("msi");
  });

  test("credential vars are blank in this very process", () => {
    // The load-bearing assertion. The unit tests above prove the predicate; this proves the
    // preload RAN — the failure mode in #812 was a blanking step that was correct in isolation
    // and never took effect. Reads process.env directly: if bunfig's `preload` were dropped,
    // a developer with credentials configured would go red here instead of silently making
    // live API calls from the test suite.
    for (const name of Object.keys(process.env)) {
      if (isCredentialEnvName(name)) {
        expect(process.env[name], `${name} survived the preload`).toBe("");
      }
    }
  });
});
