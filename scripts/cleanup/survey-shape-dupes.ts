import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { REPO_ROOT, relPath } from "./lib.ts";

interface ShapeGroup {
  name: string;
  glob: string;
  matches: string[];
}

async function lsOne(dir: string, suffix: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith(suffix)).map((e) => join(dir, e));
  } catch {
    return [];
  }
}

async function main() {
  const connectorsDir = `${REPO_ROOT}/packages/gateway/src/connectors`;
  const ipcDir = `${REPO_ROOT}/packages/gateway/src/ipc`;

  const groups: ShapeGroup[] = [
    {
      name: "connector sync handlers",
      glob: `${connectorsDir}/*-sync.ts`,
      matches: await lsOne(connectorsDir, "-sync.ts"),
    },
    {
      name: "connector mappings",
      glob: `${connectorsDir}/*-mapping.ts`,
      matches: await lsOne(connectorsDir, "-mapping.ts"),
    },
    {
      name: "IPC RPC dispatchers",
      glob: `${ipcDir}/*-rpc.ts`,
      matches: await lsOne(ipcDir, "-rpc.ts"),
    },
  ];

  // The "MCP connector servers" group was dropped when the connectors moved to
  // nimbus-agent/nimbus-mcp-servers. It already tolerated a missing directory, so leaving it would
  // have reported a group of zero forever — a survey that reads as "no duplication here" when it
  // simply stopped looking.

  const out: string[] = ["# Punch list — section 2b: Shape duplication", ""];
  for (const g of groups) {
    out.push(`## ${g.name} (${g.matches.length})`, "", `Glob: \`${relPath(g.glob)}\``, "");
    for (const m of g.matches) {
      out.push(`- \`${relPath(m)}\``);
    }
    out.push("");
  }
  out.push(
    "## Proposed extractions",
    "",
    "- `runConnectorSync` template + `Pagination`/`AuthHeaderProvider`/`RateLimitObserver` strategies — `packages/gateway/src/connectors/_lib/`",
    "- `createRpcDispatcher` — `packages/gateway/src/ipc/_lib/dispatcher.ts`",
    "- `buildIndexedItem` — `packages/gateway/src/connectors/_lib/item-builder.ts`",
    "- `registerReadOnlyConnectorTools` — `@nimbus-dev/sdk`",
  );

  const target = `${REPO_ROOT}/docs/superpowers/specs/punchlist/02b-shape-dupes.md`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${out.join("\n")}\n`, "utf8");
  console.log(`Wrote shape-dupe survey to ${relPath(target)}`);
}

await main();
