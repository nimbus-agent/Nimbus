import { CI_RUN_EMITTED_KEYS } from "../../../packages/gateway/src/connectors/ci-run-meta.ts";
import { PR_EMITTED_KEYS } from "../../../packages/gateway/src/connectors/pr-meta.ts";
import type { WriterEmission } from "./writer-emissions.ts";

/**
 * Spec §5.2: the A1 emitted-keys tables are DATA the census trusts as writer emissions for their
 * `(service, type)` — `lane-contract-drift.test.ts` drives every real mapper and fails when a table
 * and the code disagree, which is what makes trusting them sound. Without this the census cannot
 * see a key written through `buildCiRunMetadata`/`buildPrMetadata` and reports every contract read
 * as dead. `line: 0` marks a table row, not a call site.
 */
const SOURCES = [
  {
    file: "packages/gateway/src/connectors/ci-run-meta.ts",
    itemType: "ci_run",
    table: CI_RUN_EMITTED_KEYS,
  },
  { file: "packages/gateway/src/connectors/pr-meta.ts", itemType: "pr", table: PR_EMITTED_KEYS },
] as const;

export function contractEmissions(): readonly WriterEmission[] {
  const out: WriterEmission[] = [];
  for (const src of SOURCES) {
    for (const [service, keys] of Object.entries(src.table) as [string, ReadonlySet<string>][]) {
      out.push({
        service,
        itemType: src.itemType,
        metadataKeys: [...keys].sort(),
        file: src.file,
        line: 0,
      });
    }
  }
  return out;
}
