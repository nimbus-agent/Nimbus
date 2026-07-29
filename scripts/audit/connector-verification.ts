/**
 * Classify each first-party MCP connector by what evidence exists that it
 * actually works. This is a STATIC audit: it proves a connector registers
 * tools and issues outbound calls, NOT that any live API accepted them.
 * Launch copy must not describe `tier1` as "verified against the live API".
 */

export type ConnectorTier = "tier1" | "implemented" | "unknown";

export type ConnectorEvidence = {
  readonly id: string;
  readonly hasTools: boolean;
  readonly hasTests: boolean;
  readonly makesOutboundCalls: boolean;
  readonly tier: ConnectorTier;
};

export type ClassifyInput = {
  readonly id: string;
  /** File names within the connector's `src/` directory. */
  readonly files: readonly string[];
  /** Full text of every `.ts` source file in that directory. */
  readonly sources: readonly string[];
};

/**
 * Tool-registration detection.
 *
 * The dominant idiom in this tree is NOT a method call. `mcp-tool-kit.ts`
 * exposes `createZodToolRegistrar(createRegisterSimpleTool(mcp))`, which
 * returns a curried function invoked bare — `reg("k8s_pod_list", desc,
 * schema, handler)`. Matching only `reg.tool(` filed 61 of 94 connectors as
 * `unknown`, kubernetes among them; since kubernetes is the known-good
 * reference, that was the regex being wrong, not the connectors.
 *
 * The alternatives are the shared bootstrap `runReadOnlyMcpConnector(name,
 * (reg) => ...)` — where `server.ts` is four lines and the `reg(...)` calls
 * live in a sibling `tools.ts` — and the per-connector helpers
 * (`registerGithubTool`, `registerSimpleTool`, `registerStorybookTools`).
 *
 * The bare-call arm is anchored to line start (`m` flag) rather than a bare
 * `\breg\(`, so an unrelated identifier mid-expression cannot be mistaken for
 * a registrar.
 */
const TOOL_REGISTRATION =
  /\b(reg|registrar)\.tool\(|registerTool\(|register[A-Z]\w*Tools?\(|createZodToolRegistrar\(|(?:build|run)ReadOnlyMcpConnector\(|^[ \t]*reg\(/m;

/**
 * Outbound-call detection — case-insensitive and helper-aware on purpose.
 *
 * Connectors here rarely call `fetch` directly; they route through
 * `mcp-connectors/shared/`: `fetchWithTimeout`, `fetchBearerJson` and
 * `makeRestFetcher` for HTTP, and `runCliJson` / `runCliOk` /
 * `runCliOkThrowing` for CLI-backed connectors (kubernetes shells out to
 * kubectl; aws, gcp, azure and iac do the same). Matching only `\bfetch(`
 * would file every CLI-backed connector as `unknown` and understate the
 * product — the exact false negative this audit exists to avoid.
 *
 * There are deliberately NO cloud-SDK patterns: `packages/mcp-connectors/`
 * has zero cloud-SDK runtime dependencies (verified 2026-07-28), and the
 * published SDK is dep-free by policy. Adding speculative SDK regexes would
 * only create false positives.
 */
const OUTBOUND_CALL = /fetch\w*\(|Bun\.spawn\(|execFile\(|spawnSync\(|runCli\w*\(/i;

export function classifyConnector(input: ClassifyInput): ConnectorEvidence {
  const blob = input.sources.join("\n");
  const hasTools = TOOL_REGISTRATION.test(blob);
  const makesOutboundCalls = OUTBOUND_CALL.test(blob);
  const hasTests = input.files.some((f) => f.endsWith(".test.ts"));

  let tier: ConnectorTier = "unknown";
  if (hasTools && makesOutboundCalls) {
    tier = hasTests ? "tier1" : "implemented";
  }

  return { id: input.id, hasTools, hasTests, makesOutboundCalls, tier };
}

export function summarize(rows: readonly ConnectorEvidence[]): {
  tier1: number;
  implemented: number;
  unknown: number;
  total: number;
} {
  return {
    tier1: rows.filter((r) => r.tier === "tier1").length,
    implemented: rows.filter((r) => r.tier === "implemented").length,
    unknown: rows.filter((r) => r.tier === "unknown").length,
    total: rows.length,
  };
}

if (import.meta.main) {
  const { readdirSync, readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");

  const root = join(import.meta.dir, "..", "..", "packages", "mcp-connectors");
  const rows: ConnectorEvidence[] = [];

  for (const id of readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "shared")
    .map((e) => e.name)
    .sort()) {
    const srcDir = join(root, id, "src");
    if (!existsSync(srcDir)) {
      rows.push(classifyConnector({ id, files: [], sources: [] }));
      continue;
    }
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
    const sources = files.map((f) => readFileSync(join(srcDir, f), "utf8"));
    rows.push(classifyConnector({ id, files, sources }));
  }

  const s = summarize(rows);
  console.log("# Connector verification audit\n");
  console.log("STATIC audit only — proves tool registration and outbound calls,");
  console.log("NOT that any live API accepted a request.\n");
  console.log(`| Connector | Tier | Tools | Outbound | Tests |`);
  console.log(`| --- | --- | --- | --- | --- |`);
  for (const r of rows) {
    console.log(
      `| ${r.id} | ${r.tier} | ${r.hasTools ? "yes" : "no"} | ${r.makesOutboundCalls ? "yes" : "no"} | ${r.hasTests ? "yes" : "no"} |`,
    );
  }
  console.log(
    `\ntier1=${String(s.tier1)} implemented=${String(s.implemented)} unknown=${String(s.unknown)} total=${String(s.total)}`,
  );
}
