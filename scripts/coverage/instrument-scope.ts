// Decides whether the istanbul preload should instrument a given module.
// Scope-gate to FIRST-PARTY package src only — a broad filter lets Babel's own
// node_modules re-enter the onLoad hook and crashes Babel internals.
// `sdk`, `client` and `mcp-launcher` are NOT listed: all three were extracted to
// their own repos (nimbus-sdk / nimbus-client / nimbus-mcp) and no
// `packages/{sdk,client,mcp-launcher}/src/` path exists here any more. Dead
// alternations in a scope regex read as coverage that is being collected
// somewhere, and this file has already been bitten by that class of confusion
// once: `mcp-launcher`'s tests ran under build-lcov.sh from #1047 while its
// source sat outside this scope, so it produced no coverage records at all and
// Sonar reported its files at 0% while a comment elsewhere called the gap closed.
// Keep this regex to packages that actually live here.
const FIRST_PARTY = /\/packages\/(?:gateway|cli)\/src\//;
const CONNECTOR_SRC = /\/packages\/mcp-connectors\/(?:shared|[^/]+\/src)\//;
const GHA_SRC = /\/packages\/github-actions\/(?:shared|[^/]+\/src)\//;

export function shouldInstrument(absPath: string): boolean {
  const p = absPath.replaceAll("\\", "/");
  if (p.includes("/node_modules/")) return false;
  if (/\.(test|spec)\.[cm]?tsx?$/.test(p)) return false;
  return FIRST_PARTY.test(p) || CONNECTOR_SRC.test(p) || GHA_SRC.test(p);
}
