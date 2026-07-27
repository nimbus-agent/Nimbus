import { describe, expect, test } from "bun:test";

import { blankCredentialEnv, isCredentialEnvName } from "./hermetic-credentials.ts";

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

describe("the preload is actually wired", () => {
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
