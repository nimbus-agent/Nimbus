import { describe, expect, test } from "bun:test";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { readDirFiles } from "../../test/helpers/security-invariants.ts";

// I35 / D26(c): a live session's entry holds a driver handle (`CuLaneHandle`) that can actuate with
// no envelope, consent or audit. The registry of them must stay private to `cu-gate.ts`: no other
// module may declare, create or export a binding that holds live sessions or lane handles, and no
// exported accessor may return one. (A type declaration is fine; a type is not a handle.)
const GATE = "computer-use/cu-gate.ts";
const TOP_LEVEL_BINDING =
  /^(?:export\s+)?(?:const|let|var)\s+\w+[^=;]*\b(?:LiveSession|CuLaneHandle)\b/m;
const EXPORTED_BINDING = /^export\s+(?:const|let|var)\s+\w+[^=;]*\b(?:LiveSession|CuLaneHandle)\b/m;
const NEW_REGISTRY = /new\s+(?:Map|Set|WeakMap|Array)\s*<[^>]*\b(?:LiveSession|CuLaneHandle)\b/;
const EXPORTED_RETURN =
  /export\s+(?:async\s+)?function\s+\w+\s*\([^)]*\)\s*:\s*[^{;]*\b(?:LiveSession|CuLaneHandle)\b/;
const EXPORTED_REGISTRY_NAME =
  /export\s+(?:const|let|var)\s+liveSessions\b|export\s*\{[^}]*\bliveSessions\b/;

describe("I35 — the live-session registry is private to cu-gate.ts", () => {
  test("no module outside cu-gate.ts holds, creates or returns live sessions or lane handles", async () => {
    const files = await readDirFiles("packages/gateway/src");
    const offenders: string[] = [];
    for (const f of files) {
      if (f.rel === GATE) continue;
      const src = stripComments(f.contents);
      for (const re of [TOP_LEVEL_BINDING, NEW_REGISTRY, EXPORTED_RETURN, EXPORTED_REGISTRY_NAME]) {
        if (re.test(src)) offenders.push(`${f.rel}: ${re}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("cu-gate.ts keeps the map unexported and exports nothing that holds or returns one", async () => {
    const files = await readDirFiles("packages/gateway/src");
    const gate = files.find((f) => f.rel === GATE);
    expect(gate).toBeDefined();
    const src = stripComments(gate?.contents ?? "");
    expect(src).toMatch(/^const liveSessions = new Map<string, LiveSession>\(\);$/m);
    for (const re of [EXPORTED_REGISTRY_NAME, EXPORTED_BINDING, EXPORTED_RETURN]) {
      expect(src).not.toMatch(re);
    }
  });

  test("the detector sees the shapes it exists to catch", () => {
    const any = (s: string): boolean =>
      [TOP_LEVEL_BINDING, NEW_REGISTRY, EXPORTED_RETURN, EXPORTED_REGISTRY_NAME].some((r) =>
        r.test(s),
      );
    for (const bad of [
      "export const liveSessions = new Map<string, LiveSession>();",
      "const m: Map<string, LiveSession> = x;",
      "export function lanes(): Map<string, CuLaneHandle> { return m; }",
      "export async function get(id: string): Promise<CuLaneHandle> { return h; }",
    ]) {
      expect(any(bad)).toBe(true);
    }
    expect(any("export interface LiveSession { lane: CuLaneHandle }")).toBe(false);
  });
});
