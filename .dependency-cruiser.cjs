// dependency-cruiser config for the B3 structure audit.
// Encodes D1 (forbidden cross-package imports), D2 (cycles within a workspace),
// D3 (PAL leakage). Run via `bun run audit:boundaries`.

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
    {
      name: "mcp-connectors-only-import-sdk",
      severity: "error",
      comment: "First-party MCP connectors depend only on @nimbus-dev/sdk.",
      from: { path: "^packages/mcp-connectors/[^/]+/src" },
      to: {
        path: "^packages/(gateway|cli|ui)/",
      },
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
