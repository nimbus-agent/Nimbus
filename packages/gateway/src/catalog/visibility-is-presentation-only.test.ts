// Agent visibility is PRESENTATION ONLY: it shapes what `nimbus catalog` and `config explain`
// show, and nothing else. No gate, dispatcher, HTTP route, MCP tool, fleet or ChatOps path may
// read it, so hiding an agent can never refuse a call. This guard pins that structurally.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseNimbusAgentsToml } from "../config/nimbus-toml.ts";

const SRC = join(import.meta.dir, "..");

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** `//` and `/* *\/` comments removed, so a doc mention does not count but real code does. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const FILES = listSourceFiles(SRC).map((full) => ({
  rel: relative(SRC, full).split(sep).join("/"),
  code: stripComments(readFileSync(full, "utf8")),
}));

const RESOLVER_ALLOWED = new Set([
  "catalog/agent-visibility.ts",
  "catalog/catalog-list.ts",
  "ipc/diagnostics-rpc.ts",
]);

function isEnforcementSurface(rel: string): boolean {
  return (
    rel === "ipc/agents-rpc.ts" ||
    /^ipc\/http-[^/]*\.ts$/.test(rel) ||
    rel.startsWith("fleet/") ||
    rel.startsWith("chatops/") ||
    rel.startsWith("agent-runs/") ||
    rel.startsWith("engine/") ||
    rel.startsWith("mcp-sink/")
  );
}

const CATALOG_IMPORT =
  /\bfrom\s+["'][^"']*\/catalog\/[^"']*["']|\bimport\s*\(\s*["'][^"']*\/catalog\//;

describe("agent visibility is presentation only", () => {
  test("the scan sees the gateway source", () => {
    expect(FILES.some((f) => f.rel === "catalog/agent-visibility.ts")).toBe(true);
    expect(FILES.some((f) => f.rel === "ipc/agents-rpc.ts")).toBe(true);
  });

  test("(a) resolveAgentVisibility is named only by the catalog and config explain", () => {
    const offenders = FILES.filter(
      (f) => /\bresolveAgentVisibility\b/.test(f.code) && !RESOLVER_ALLOWED.has(f.rel),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  test("(b) no gate, dispatcher or unattended path imports from catalog/", () => {
    const offenders = FILES.filter(
      (f) => isEnforcementSurface(f.rel) && CATALOG_IMPORT.test(f.code),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  test("(c) the [agents] loader reads only synthesis settings", () => {
    const parsed = parseNimbusAgentsToml(
      '[agents]\nsynthesis = "off"\nshow = ["standup"]\nhide = ["oncall"]\nvisible = ["why"]\n',
    );
    expect(Object.keys(parsed).sort()).toEqual(["synthesis", "synthesisTimeoutMs"]);
  });
});
