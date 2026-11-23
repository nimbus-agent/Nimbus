// Reports the static rules, part 4 of 4: runs each check in the original order and prints its ::error lines.
// Moved verbatim out of run() in check-nimbus-invariants.ts.

import { CO_OWNED_ENTITY_TYPES } from "../../../packages/gateway/src/graph/relationship-graph.ts";
import type { FileEntry, Mode } from "./_shared.ts";
import { checkFreeBusyConfinement } from "./free-busy.ts";
import { checkEpisodicMemoryConfinement } from "./episodic-memory.ts";
import {
  checkBrokeredFetchLiteralConfinement,
  checkGeneratedManifestConfinement,
} from "./migration-capture-toolgen.ts";
import {
  checkFlatUpsertGraphEntityCoOwnedTypes,
  checkListenerRegistryConfinement,
  checkSavedToolAccessorConfinement,
  checkSqliteRuntimeInit,
  checkToolgenVaultKeyConfinement,
} from "./sqlite-listeners-egress-graph.ts";

export function reportRulesPart4(files: readonly FileEntry[], mode: Mode): number {
  let exit = 0;
  if (mode === "binary-only" || mode === "all") {
    const v = checkBrokeredFetchLiteralConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D29(a) the nimbus/fetch method literal appears outside toolgen-types.ts — a producer/consumer copy that can drift; I39 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkGeneratedManifestConfinement(files);
    for (const e of v) {
      console.error(
        e.rule === "D29(b)-generated-manifest-network-nonempty"
          ? `::error file=${e.file},line=${e.line}::D29(b) toolgen-stub.ts assigns permissions.network a non-empty literal — a generated tool would spawn with network access; I39 regression: ${e.snippet}`
          : `::error file=${e.file},line=${e.line}::D29(b) buildGeneratedManifest defined outside toolgen-stub.ts — a second, unaudited manifest constructor; I39 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkToolgenVaultKeyConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D29(c) a toolgen. Vault-key prefix composed outside toolgen-credentials.ts — a second producer of the per-host credential keyspace; I39 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkSavedToolAccessorConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D29(d) a saved-tool private accessor/constant is named outside toolgen-saved-store.ts — a second, unverified read path for a saved artifact; I40 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkSqliteRuntimeInit(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D30 a file that can open a SQLite database does not call ensureFullSqlite() (platform/sqlite-runtime.ts). Database.setCustomSQLite is process-wide and only works before the first open, and a Worker is a separate realm — without the call, sqlite-vec cannot load on macOS and this process has no vector search, hybrid ranking or session-memory recall (issue #1029). Add the call before the open; in packages/cli or packages/ui the answer is that no database should be opened there at all: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkListenerRegistryConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D31 a listen site does not register with the live ListenerRegistry (locality/listener-registry.ts). The 'nimbus wow' locality panel reads processListeners.live() to show which listeners are open right now and whether each is loopback — a listen site that never registers makes that panel silently incomplete rather than visibly broken. Call registerListener() right after listen succeeds and unregister on every stop path: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkFlatUpsertGraphEntityCoOwnedTypes(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::flat upsertGraphEntity called with a co-owned type (${CO_OWNED_ENTITY_TYPES.join("/")}) — use upsertGraphEntityNamespaced instead, or the flat write wipes the other owner's namespace: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkFreeBusyConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D13(b) (${e.rule}) federated free/busy answering escapes its gate: only 30-minute blocks may leave, built by federation/free-busy-gate.ts from federation/_lib/free-busy-read.ts; I17 (b) regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkEpisodicMemoryConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D52 long-term episodic memory left its confinement (rule ${e.rule}) - its tables only in memory/episodic-store.ts, a turn recorded only from the ask turn's own input and reply, the memory built and its model attached only at boot, no remote-embedder route or network primitive in its modules, and the owner-turn gate kept in engine/run-ask/episodic.ts; I61 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  return exit;
}
