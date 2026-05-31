export type ExclusionPattern =
  | { kind: "exact"; path: string }
  | { kind: "dirPrefix"; prefix: string }
  | { kind: "basenameRegex"; re: RegExp }
  | { kind: "pathRegex"; re: RegExp };

export const EXCLUSIONS: readonly ExclusionPattern[] = Object.freeze([
  { kind: "exact", path: "packages/gateway/src/vault/win32.ts" },
  { kind: "exact", path: "packages/gateway/src/vault/darwin.ts" },
  { kind: "exact", path: "packages/gateway/src/vault/linux.ts" },
  { kind: "exact", path: "packages/gateway/src/vault/ffi-ptr.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/win32.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/darwin.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/linux.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/browser.ts" },

  { kind: "exact", path: "packages/gateway/src/platform/sandbox/linux.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/sandbox/darwin.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/sandbox/win32.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/sandbox/orphan-reap.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/sandbox/sandbox-runner.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/index.ts" },
  { kind: "exact", path: "packages/gateway/src/vault/factory.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/sandbox/index.ts" },
  { kind: "exact", path: "packages/gateway/src/connectors/index.ts" },
  { kind: "exact", path: "packages/gateway/src/connectors/mapped-row.ts" },
  { kind: "exact", path: "packages/client/src/index.ts" },
  { kind: "exact", path: "packages/client/src/stream-events.ts" },
  { kind: "exact", path: "packages/sdk/src/ipc/index.ts" },

  { kind: "exact", path: "packages/gateway/src/platform/sandbox/sandbox-wrapper.ts" },
  { kind: "exact", path: "packages/sdk/src/testing/sandbox-probe.ts" },
  { kind: "exact", path: "packages/gateway/src/db/query-guard-worker.ts" },
  { kind: "exact", path: "packages/gateway/src/embedding/embedding-worker.ts" },
  {
    kind: "exact",
    path: "packages/gateway/src/embedding/load-feature-extraction-pipeline.ts",
  },
  { kind: "exact", path: "packages/gateway/src/index.ts" },
  { kind: "exact", path: "packages/cli/src/index.ts" },
  { kind: "exact", path: "packages/cli/src/lib/gateway-process.ts" },
  { kind: "exact", path: "packages/cli/src/commands/start.ts" },
  { kind: "exact", path: "packages/cli/src/commands/tui.tsx" },
  { kind: "exact", path: "packages/cli/src/commands/repl.ts" },
  { kind: "exact", path: "packages/cli/src/commands/doctor.ts" },

  { kind: "exact", path: "packages/gateway/src/connectors/lazy-mesh/slot.ts" },
  { kind: "exact", path: "packages/gateway/src/ipc/server/options.ts" },
  { kind: "exact", path: "packages/gateway/src/embedding/embedding-runtime.ts" },
  { kind: "exact", path: "packages/gateway/src/index/ranked-item.ts" },
  { kind: "exact", path: "packages/gateway/src/vault/nimbus-vault.ts" },
  { kind: "exact", path: "packages/gateway/src/ipc/agent-invoke.ts" },
  { kind: "exact", path: "packages/gateway/src/ipc/workflow-invoke.ts" },
  { kind: "exact", path: "packages/gateway/src/ipc/connector-rpc-handlers/context.ts" },

  { kind: "dirPrefix", prefix: "packages/gateway/src/perf/" },

  { kind: "dirPrefix", prefix: "packages/gateway/src-native/" },

  { kind: "pathRegex", re: /^packages\/gateway\/src\/index\/[^/]+-v\d+-sql\.ts$/ },

  { kind: "basenameRegex", re: /^types\.ts$/ },
  { kind: "basenameRegex", re: /-types\.ts$/ },

  { kind: "pathRegex", re: /^packages\/github-actions\/[^/]+\/src\/main\.ts$/ },

  { kind: "pathRegex", re: /^packages\/mcp-connectors\/[^/]+\/src\/server\.ts$/ },
]);

export function isExempt(relPath: string): boolean {
  const normalized = relPath.replaceAll("\\", "/");
  const basename = normalized.split("/").pop() ?? "";
  for (const pattern of EXCLUSIONS) {
    switch (pattern.kind) {
      case "exact":
        if (normalized === pattern.path) return true;
        break;
      case "dirPrefix":
        if (normalized.startsWith(pattern.prefix)) return true;
        break;
      case "basenameRegex":
        if (pattern.re.test(basename)) return true;
        break;
      case "pathRegex":
        if (pattern.re.test(normalized)) return true;
        break;
    }
  }
  return false;
}
