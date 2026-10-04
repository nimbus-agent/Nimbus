// dependency-cruiser config for the B3 structure audit.
// Encodes D1 (forbidden cross-package imports), D2 (cycles within a workspace),
// D3 (PAL leakage). Run via `bun run audit:boundaries`, i.e.
// `scripts/structure-audit/check-boundaries.ts`. Do not run `depcruise` on it directly:
// dependency-cruiser needs `typescript` <7, and only the wrapper's preload guarantees it
// one. A bare run can skip every .ts file and still report "no dependency violations".
// The wrapper also FAILS on a rule here whose from/to path matches no cruised module, so a
// rule cannot outlive the code it governs. `mcp-connectors-only-import-sdk` was deleted
// on that basis: the connectors left for nimbus-agent/nimbus-mcp-servers in #1347
// (2026-08-27), and a separate repository cannot import this one's source at all.

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ─────────────────── D2: no cycles ───────────────────
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular imports forbidden inside any workspace.",
      from: {},
      to: { circular: true },
    },

    // ─────── D1: forbidden cross-package source imports ───────
    {
      name: "cli-no-import-gateway",
      severity: "error",
      comment: "CLI must talk to gateway via IPC, never source imports.",
      from: { path: "^packages/cli/src" },
      to: { path: "^packages/gateway/src" },
    },
    {
      name: "ui-no-import-gateway",
      severity: "error",
      comment: "UI must talk to gateway via IPC, never source imports.",
      from: { path: "^packages/ui/src" },
      to: { path: "^packages/gateway/src" },
    },

    // ─────────── D3: PAL leakage ───────────
    {
      name: "pal-isolation",
      severity: "error",
      comment:
        "Only platform/index.ts (and tests) may import win32/darwin/linux directly. " +
        "Business logic uses the PlatformServices interface.",
      from: {
        path: "^packages/gateway/src/",
        pathNot: ["^packages/gateway/src/platform/index\\.ts$", "\\.test\\.ts$", "/test/"],
      },
      to: {
        path: "^packages/gateway/src/platform/(win32|darwin|linux)\\.ts$",
      },
    },
  ],

  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
    includeOnly: "^packages/",
    exclude: {
      path: ["\\.test\\.ts$", "\\.test\\.tsx$", "/dist/", "node_modules", "/__fixtures__/"],
    },
  },
};
