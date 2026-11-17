import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source pins for IC9b. Under `incident-update/`, ONLY `update-send.ts` reaches the connector row table, the
 * incident-link minter or an executor (it hands the owner's linked action to `execute()`); the draft and the
 * scribe import no connectors, egress, ChatOps, federation, share, engine or model module, make no request and
 * spawn nothing. The scribe writes only its own queue directory.
 */

const DIR = import.meta.dir;
const NETWORK = /\bfetch\s*\(|\bBun\.serve\b|\bnode:(?:http|https|net|dgram)\b|\bWebSocket\b/;
const SPAWN =
  /\b(?:Bun\.spawn|Bun\.spawnSync|node:child_process|child_process|execFile|execSync)\b/;
const FORBIDDEN_IMPORT =
  /from\s+"(?:\.\.\/)+(?:egress|chatops|federation|share|connectors|engine|llm)\//;
const ACTION_IMPORT = /from\s+"(?:\.\.\/)+(?:connectors\/|engine\/|incident\/incident-link-mint)/;

const strip = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function sources(): { name: string; text: string }[] {
  return readdirSync(DIR)
    .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))
    .map((name) => ({ name, text: strip(readFileSync(join(DIR, name), "utf8")) }));
}

describe("IC9b confinement", () => {
  test("the scan is anchored: the directory has its three modules", () => {
    expect(
      sources()
        .map((f) => f.name)
        .sort(),
    ).toEqual(["scribe.ts", "update-draft.ts", "update-send.ts"]);
  });

  test("only update-send.ts imports the row table, the link minter or the engine", () => {
    for (const f of sources()) {
      if (f.name === "update-send.ts") {
        expect(f.text).toMatch(ACTION_IMPORT);
        continue;
      }
      expect(f.text, f.name).not.toMatch(FORBIDDEN_IMPORT);
      expect(f.text, f.name).not.toMatch(ACTION_IMPORT);
    }
  });

  test("nothing here makes a request or spawns a process", () => {
    for (const f of sources()) {
      expect(f.text, f.name).not.toMatch(NETWORK);
      expect(f.text, f.name).not.toMatch(SPAWN);
    }
  });

  test("the send never dispatches itself: it only calls execute()", () => {
    const send = sources().find((f) => f.name === "update-send.ts")?.text ?? "";
    expect(send).toMatch(/\.executor\.execute\(action\)/);
    expect(send).not.toMatch(/\.dispatch\(/);
    expect(send).not.toMatch(/\borigin\s*:|\bproposer\s*:|\bprovenance\s*:/);
  });

  test("the scribe's queue file holds the three metadata keys and nothing else", () => {
    const scribe = sources().find((f) => f.name === "scribe.ts")?.text ?? "";
    const writes = [...scribe.matchAll(/writeFileSync\(([^;]*)\);/g)].map((m) => m[1]);
    expect(writes).toEqual(["tmp, JSON.stringify({ recordId, version, queuedAtMs: deps.now() })"]);
  });
});
