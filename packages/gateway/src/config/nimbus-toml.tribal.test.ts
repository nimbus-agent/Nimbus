import { describe, expect, test } from "bun:test";
import { DEFAULT_NIMBUS_TRIBAL_TOML, parseNimbusTribalToml } from "./nimbus-toml.ts";

describe("parseNimbusTribalToml", () => {
  test("defaults: disabled, embedding match, empty channels, no targets", () => {
    expect(parseNimbusTribalToml("")).toEqual(DEFAULT_NIMBUS_TRIBAL_TOML);
  });

  test("parses [tribal] scalars + watch_channels + subtables", () => {
    const raw = `
[tribal]
enabled = true
match = "embedding+llm"
min_occurrences = 5
window_days = 7
cooldown_days = 60
watch_channels = ["C1", "C2"]

[tribal.notion]
database_id = "db_123"

[tribal.confluence]
space_key = "ENG"
parent_page_id = "9999"
`;
    const t = parseNimbusTribalToml(raw);
    expect(t.enabled).toBe(true);
    expect(t.match).toBe("embedding+llm");
    expect(t.minOccurrences).toBe(5);
    expect(t.windowDays).toBe(7);
    expect(t.cooldownDays).toBe(60);
    expect(t.watchChannels).toEqual(["C1", "C2"]);
    expect(t.notion).toEqual({ databaseId: "db_123" });
    expect(t.confluence).toEqual({ spaceKey: "ENG", parentPageId: "9999" });
  });

  test("invalid match falls back to embedding", () => {
    expect(parseNimbusTribalToml(`[tribal]\nmatch = "bogus"\n`).match).toBe("embedding");
  });

  // I25 fail-closed: a partially-configured KB target must NOT resolve a destination.
  test("partial [tribal.confluence] (missing parent_page_id) does not set confluence", () => {
    const cfg = parseNimbusTribalToml(`[tribal.confluence]\nspace_key = "ENG"\n`);
    expect(cfg.confluence).toBeUndefined();
  });

  test("empty [tribal.notion] database_id does not set notion", () => {
    const cfg = parseNimbusTribalToml(`[tribal.notion]\ndatabase_id = ""\n`);
    expect(cfg.notion).toBeUndefined();
  });
});
