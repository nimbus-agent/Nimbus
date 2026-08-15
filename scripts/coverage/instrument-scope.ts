// Decides whether the istanbul preload should instrument a given module.
// Scope-gate to FIRST-PARTY package src only — a broad filter lets Babel's own
// node_modules re-enter the onLoad hook and crashes Babel internals.
// `mcp-launcher` is a workspace package with its own tests, and build-lcov.sh
// has run them since #1047 — but its source was never in this scope, so nothing
// it loaded was instrumented and it produced no coverage records at all. The
// comment in build-lcov.sh describing that as a closed "measurement gap" was
// therefore only half true: the tests ran, the measurement still did not happen,
// and Sonar went on reporting resolve-binary.ts and exit-status.ts at 0%.
//
// `sdk` and `client` are NOT listed: those packages were extracted to their own
// repos (nimbus-sdk / nimbus-client) and no `packages/{sdk,client}/src/` path
// exists here any more. Dead alternations in a scope regex read as coverage
// that is being collected somewhere, which is exactly the confusion above.
const FIRST_PARTY = /\/packages\/(?:gateway|cli|mcp-launcher)\/src\//;
const CONNECTOR_SRC = /\/packages\/mcp-connectors\/(?:shared|[^/]+\/src)\//;
const GHA_SRC = /\/packages\/github-actions\/(?:shared|[^/]+\/src)\//;

export function shouldInstrument(absPath: string): boolean {
  const p = absPath.replaceAll("\\", "/");
  if (p.includes("/node_modules/")) return false;
  if (/\.(test|spec)\.[cm]?tsx?$/.test(p)) return false;
  return FIRST_PARTY.test(p) || CONNECTOR_SRC.test(p) || GHA_SRC.test(p);
}
