import { describe, expect, it } from "bun:test";
import { TEAM_VAULT_PREFIX, teamVaultKey } from "./team-vault-keys.ts";

describe("teamVaultKey", () => {
  it("composes teamvault.<entry>.<connectorKey>", () => {
    expect(teamVaultKey("prod-aws", "aws.access_key_id")).toBe(
      "teamvault.prod-aws.aws.access_key_id",
    );
  });

  it("exposes the reserved prefix", () => {
    expect(TEAM_VAULT_PREFIX).toBe("teamvault.");
    expect(teamVaultKey("x", "slack.oauth").startsWith(TEAM_VAULT_PREFIX)).toBe(true);
  });

  it("rejects an entry with a dot (would corrupt the keyspace)", () => {
    expect(() => teamVaultKey("a.b", "slack.oauth")).toThrow(/entry/i);
  });

  it("rejects an empty entry or key", () => {
    expect(() => teamVaultKey("", "slack.oauth")).toThrow();
    expect(() => teamVaultKey("ok", "")).toThrow();
  });
});
