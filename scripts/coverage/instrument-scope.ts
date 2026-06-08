// Decides whether the istanbul preload should instrument a given module.
// Scope-gate to FIRST-PARTY package src only — a broad filter lets Babel's own
// node_modules re-enter the onLoad hook and crashes Babel internals.
const FIRST_PARTY = /\/packages\/(?:gateway|cli|sdk|client)\/src\//;
const CONNECTOR_SRC = /\/packages\/mcp-connectors\/[^/]+\/src\//;

export function shouldInstrument(absPath: string): boolean {
  const p = absPath.replaceAll("\\", "/");
  if (p.includes("/node_modules/")) return false;
  if (/\.(test|spec)\.[cm]?tsx?$/.test(p)) return false;
  return FIRST_PARTY.test(p) || CONNECTOR_SRC.test(p);
}
