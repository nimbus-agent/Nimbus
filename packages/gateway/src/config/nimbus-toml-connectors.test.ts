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
      /connectors\.powerbi\.team_entry is required/,
    );
  });

  it("throws when team_entry violates the entry-name rule (dots/upper)", () => {
    const raw = ["[connectors.bigeye]", 'credential = "team"', 'team_entry = "Prod.Bigeye"'].join(
      "\n",
    );
    expect(() => parseNimbusConnectorsToml(raw)).toThrow(
      /connectors\.bigeye\.team_entry .* invalid/,
    );
  });

  it("throws when the connector name is not one of the six warehouse/BI services", () => {
    const raw = ["[connectors.github]", 'credential = "team"', 'team_entry = "x"'].join("\n");
    expect(() => parseNimbusConnectorsToml(raw)).toThrow(
      /connectors\.github is not a supported team-credential connector/,
    );
  });
});
