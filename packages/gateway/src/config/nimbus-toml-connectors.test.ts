import { describe, expect, it } from "bun:test";
import { parseNimbusConnectorsToml } from "./nimbus-toml-connectors.ts";

describe("parseNimbusConnectorsToml", () => {
  it("returns an empty map when no [connectors.*] section is present (default personal)", () => {
    const cfg = parseNimbusConnectorsToml("");
    expect(cfg.size).toBe(0);
  });

  it("parses a team connector with a team_entry", () => {
    const raw = [
      "[connectors.snowflake]",
      'credential = "team"',
      'team_entry = "prod-snowflake"',
    ].join("\n");
    const cfg = parseNimbusConnectorsToml(raw);
    expect(cfg.get("snowflake")).toEqual({ credential: "team", teamEntry: "prod-snowflake" });
  });

  it("parses an explicit personal connector (no team_entry)", () => {
    const raw = ["[connectors.tableau]", 'credential = "personal"'].join("\n");
    const cfg = parseNimbusConnectorsToml(raw);
    expect(cfg.get("tableau")).toEqual({ credential: "personal" });
  });

  it("throws when credential is not personal|team", () => {
    const raw = ["[connectors.looker]", 'credential = "shared"'].join("\n");
    expect(() => parseNimbusConnectorsToml(raw)).toThrow(
      /connectors\.looker\.credential.*personal.*team/,
    );
  });

  it("throws when credential = team but team_entry is absent", () => {
    const raw = ["[connectors.powerbi]", 'credential = "team"'].join("\n");
    expect(() => parseNimbusConnectorsToml(raw)).toThrow(
      /\[connectors\.powerbi\] requires team_entry/,
    );
  });

  it("throws when team_entry violates the entry-name rule (dots/upper)", () => {
    const raw = ["[connectors.bigeye]", 'credential = "team"', 'team_entry = "Prod.Bigeye"'].join(
      "\n",
    );
    expect(() => parseNimbusConnectorsToml(raw)).toThrow(
      /\[connectors\.bigeye\] team_entry .* invalid/,
    );
  });

  it("throws when the connector name is not a supported team-credential connector", () => {
    const raw = ["[connectors.github]", 'credential = "team"', 'team_entry = "x"'].join("\n");
    expect(() => parseNimbusConnectorsToml(raw)).toThrow(
      /connectors\.github is not a supported team-credential connector/,
    );
  });

  it("accepts the W1 GitOps/ML write connectors (argocd/flux/mlflow) with a team credential", () => {
    for (const svc of ["argocd", "flux", "mlflow"] as const) {
      const raw = [`[connectors.${svc}]`, 'credential = "team"', `team_entry = "prod-${svc}"`].join(
        "\n",
      );
      expect(parseNimbusConnectorsToml(raw).get(svc)).toEqual({
        credential: "team",
        teamEntry: `prod-${svc}`,
      });
    }
  });

  it("implicit personal default — no credential key yields { credential: 'personal' }", () => {
    const raw = "[connectors.snowflake]\n";
    const cfg = parseNimbusConnectorsToml(raw);
    expect(cfg.get("snowflake")).toEqual({ credential: "personal" });
  });

  it("duplicate table sections merge (last-key-wins)", () => {
    const raw = [
      "[connectors.snowflake]",
      'credential = "team"',
      "[connectors.snowflake]",
      'team_entry = "prod-snowflake"',
    ].join("\n");
    const cfg = parseNimbusConnectorsToml(raw);
    expect(cfg.get("snowflake")).toEqual({ credential: "team", teamEntry: "prod-snowflake" });
  });

  it("CRLF line endings parse identically to LF", () => {
    const raw = [
      "[connectors.snowflake]",
      'credential = "team"',
      'team_entry = "prod-snowflake"',
    ].join("\r\n");
    const cfg = parseNimbusConnectorsToml(raw);
    expect(cfg.get("snowflake")).toEqual({ credential: "team", teamEntry: "prod-snowflake" });
  });
});
