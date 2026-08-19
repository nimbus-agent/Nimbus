import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetPersonaWarningsForTest, resolvePersona } from "./persona.ts";

function tmpConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "nimbus-persona-"));
}

// `warnedIssues` is module-scoped and survives between tests in this file. Without this reset
// the warn-once test passes only while it is the FIRST test to use `tone = "tree"` — a second
// test using the same bad value later would see zero warnings and fail confusingly, and a
// reordering would break it silently. Clearing per test makes the count assertion mean what
// it says.
beforeEach(() => {
  resetPersonaWarningsForTest();
});

describe("resolvePersona", () => {
  test("reads nimbus.toml when no profile is active", () => {
    const dir = tmpConfigDir();
    writeFileSync(join(dir, "nimbus.toml"), `[persona]\ntone = "verbose"\n`, "utf8");
    delete process.env["NIMBUS_PROFILE"];
    expect(resolvePersona(dir).tone).toBe("verbose");
  });

  test("reads the PROFILE toml when NIMBUS_PROFILE is set — the point of A2", () => {
    const dir = tmpConfigDir();
    writeFileSync(join(dir, "nimbus.toml"), `[persona]\ntone = "verbose"\n`, "utf8");
    writeFileSync(join(dir, "nimbus.work.toml"), `[persona]\ntone = "terse"\n`, "utf8");
    process.env["NIMBUS_PROFILE"] = "work";
    try {
      expect(resolvePersona(dir).tone).toBe("terse");
    } finally {
      delete process.env["NIMBUS_PROFILE"];
    }
  });

  test("missing config dir yields the neutral default rather than throwing", () => {
    expect(resolvePersona(join(tmpdir(), "nimbus-persona-does-not-exist"))).toEqual({
      tone: "neutral",
      voice: "neutral",
    });
  });

  test("re-reads on every call — an edit is picked up with no restart (D3)", () => {
    const dir = tmpConfigDir();
    const path = join(dir, "nimbus.toml");
    delete process.env["NIMBUS_PROFILE"];
    writeFileSync(path, `[persona]\ntone = "terse"\n`, "utf8");
    expect(resolvePersona(dir).tone).toBe("terse");
    writeFileSync(path, `[persona]\ntone = "casual"\n`, "utf8");
    expect(resolvePersona(dir).tone).toBe("casual");
  });

  test("warns once per distinct bad value, naming key, value and fallback", () => {
    const dir = tmpConfigDir();
    delete process.env["NIMBUS_PROFILE"];
    writeFileSync(join(dir, "nimbus.toml"), `[persona]\ntone = "tree"\n`, "utf8");
    const warnings: string[] = [];
    const logger = {
      warn: (_o: unknown, msg: string) => {
        warnings.push(msg);
      },
    };
    resolvePersona(dir, logger);
    resolvePersona(dir, logger);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("tone");
    expect(warnings[0]).toContain("tree");
    expect(warnings[0]).toContain("neutral");
  });

  test("warns again on a DIFFERENT bad value for the same key — memo is keyed on key=value, not a boolean-per-key", () => {
    const dir = tmpConfigDir();
    const path = join(dir, "nimbus.toml");
    delete process.env["NIMBUS_PROFILE"];
    const warnings: string[] = [];
    const logger = {
      warn: (_o: unknown, msg: string) => {
        warnings.push(msg);
      },
    };

    writeFileSync(path, `[persona]\ntone = "tree"\n`, "utf8");
    resolvePersona(dir, logger);
    expect(warnings).toHaveLength(1);

    // A boolean-per-key (or single-boolean) memo would stay silent here, because "tone" was
    // already warned once. The key=value memo warns again, because "tone=bark" is a distinct
    // memo entry from "tone=tree".
    writeFileSync(path, `[persona]\ntone = "bark"\n`, "utf8");
    resolvePersona(dir, logger);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("tone");
    expect(warnings[1]).toContain("bark");
    expect(warnings[1]).toContain("neutral");

    // Resolving again with the same (now-seen) bad value must not warn a third time.
    resolvePersona(dir, logger);
    expect(warnings).toHaveLength(2);
  });
});
