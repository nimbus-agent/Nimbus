import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source pins for IC7b. The one child process of `nimbus incident debt` lives in `debt/git-history.ts`; no
 * file under `incident/**` or `agents/_lib/incident*` may spawn (that is what keeps I57 (a) true), and
 * nothing under `debt/` reaches the network, ChatOps, the egress ledger, federation, sharing or a connector.
 */

const SRC = join(import.meta.dir, "..");
const SPAWN =
  /\b(?:Bun\.spawn|Bun\.spawnSync|child_process|node:child_process|execFile|execSync)\b|\bspawn\s*\(/;
const NETWORK = /\bfetch\s*\(|\bBun\.serve\b|\bnode:(?:http|https|net|dgram)\b|\bWebSocket\b/;
const FORBIDDEN_IMPORT =
  /from\s+"(?:\.\.\/)+(?:egress|chatops|federation|share|connectors|engine|llm)\//;

function sources(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
      out.push({ path: p, text: readFileSync(p, "utf8") });
    }
  }
  return out;
}

const strip = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("IC7b confinement", () => {
  const debt = sources(join(SRC, "debt"));

  test("the scan is anchored: the debt directory has its four modules", () => {
    const names = debt.map((f) => f.path.split(/[\\/]/).pop()).sort();
    expect(names).toEqual(["debt-evidence.ts", "debt-scan.ts", "debt-types.ts", "git-history.ts"]);
  });

  test("only debt/git-history.ts spawns a process", () => {
    const spawners = debt.filter((f) => SPAWN.test(strip(f.text))).map((f) => f.path);
    expect(spawners.map((p) => p.endsWith("git-history.ts"))).toEqual([true]);
  });

  test("nothing under debt/ uses a network primitive or imports egress, chatops, federation, share, connectors, engine or llm", () => {
    for (const f of debt) {
      const code = strip(f.text);
      expect(NETWORK.test(code), f.path).toBe(false);
      expect(FORBIDDEN_IMPORT.test(code), f.path).toBe(false);
    }
  });

  test("no file under incident/** or agents/_lib/incident* spawns a process", () => {
    const incident = sources(join(SRC, "incident"));
    const lib = sources(join(SRC, "agents", "_lib")).filter((f) =>
      /[\\/]incident[\w.-]*\.ts$/.test(f.path),
    );
    expect(incident.length).toBeGreaterThan(10);
    expect(lib.length).toBeGreaterThan(0);
    for (const f of [...incident, ...lib]) expect(SPAWN.test(strip(f.text)), f.path).toBe(false);
  });

  test("the argv of the git call never takes a value from outside this module", () => {
    const text = strip(debt.find((f) => f.path.endsWith("git-history.ts"))?.text ?? "");
    const argvLines = text.split("\n").filter((l) => l.includes('["git", "-C"'));
    expect(argvLines).toHaveLength(1);
    expect(argvLines[0]).toContain('["git", "-C", root, ...GIT_GLOBAL_ARGS, ...subArgs]');
  });

  test("assemble wires the debt context into incidentRpcCtx with the git-aware roots, re-read per call", () => {
    const text = strip(readFileSync(join(SRC, "platform", "assemble.ts"), "utf8"));
    const start = text.indexOf("ipcOpts.incidentRpcCtx = {");
    expect(start).toBeGreaterThan(0);
    const block = text.slice(start, text.indexOf("};", start));
    expect(block).toContain("debt: {");
    expect(block).toMatch(/roots: \(\) =>\s+gitAwareRootPaths\(/);
    // the real git reader is the handler default; assemble injects none
    expect(block).not.toContain("git:");
  });
});
