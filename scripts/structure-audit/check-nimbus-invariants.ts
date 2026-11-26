#!/usr/bin/env bun

// Entry point of the static invariant auditor (D10 to D52). The rules live under ./invariants/. This file
// re-exports their public names (the unit tests import them from here), parses the mode, loads the
// source files, and runs the report parts in the original order with the original output.

import type { FileEntry, Mode } from "./invariants/_shared.ts";
import { reportRulesPart1 } from "./invariants/report-1.ts";
import { reportRulesPart2 } from "./invariants/report-2.ts";
import { reportRulesPart3 } from "./invariants/report-3.ts";
import { reportRulesPart4 } from "./invariants/report-4.ts";
import { assertScanIsMeaningful } from "./invariants/rule-anchors.ts";
import { collectDbRunCensus } from "./invariants/spawn-vault-db-identity.ts";
import { auditOutputPath, iterateSourceFiles } from "./lib.ts";

export type { FileEntry, Violation } from "./invariants/_shared.ts";
export {
  checkActuationConfinement,
  checkAgentEmitterImportConfinement,
  checkDriverImportConfinement,
  checkEmbeddingAppenderConfinement,
  checkForwardShareConfinement,
  checkRegistryAppenderConfinement,
} from "./invariants/actuation-embedding-registry.ts";
export {
  checkAgentDoorWindowRetired,
  checkAgentOriginWriter,
  checkOriginComparison,
  checkUserMcpCallFacts,
  checkUserMcpDoorReach,
} from "./invariants/agent-door.ts";
export { checkAgentDoorCheckOrder } from "./invariants/agent-door-order.ts";
export {
  checkBriefingConfinement,
  checkComputerUseBindingConfinement,
  checkFinopsConfinement,
  checkIncidentConfinement,
  checkLanBoxPathConfinement,
  checkToolgenModelDoorConfinement,
  checkWorkflowImportConfinement,
} from "./invariants/briefing-incident-workflow-toolgen.ts";
export { checkCostLineConfinement } from "./invariants/cost-line.ts";
export {
  checkBoundCapabilities,
  checkDriftCheckConfined,
  checkIacDiscard,
  checkWriteDirDeclarationConfined,
} from "./invariants/drift-bound-capabilities-iac.ts";
export { checkEpisodicMemoryConfinement } from "./invariants/episodic-memory.ts";
export {
  checkEvalConfinement,
  checkExtensionRoleConfinement,
  checkRunGrantTableConfinement,
  checkRunGrantWriters,
  checkTrustTableConfinement,
} from "./invariants/extension-grants-eval.ts";
export { checkFreeBusyConfinement } from "./invariants/free-busy.ts";
export {
  checkConnectorSpawnIsHidden,
  checkFleetClientKindConfinement,
  checkIncidentFindingConfinement,
  checkIncidentRemediationConfinement,
  checkPushClientKindConfinement,
  checkRunbookConfinement,
  checkRunConfinedConfinement,
} from "./invariants/incident-runbook-client-kinds.ts";
export { checkInvestigateLiveConfinement } from "./invariants/investigate-live.ts";
export {
  checkActDoorConfinement,
  checkAgentProvenanceWriters,
  checkBrokeredFetchLiteralConfinement,
  checkCaptureGateCallers,
  checkCaptureGateImporters,
  checkConfigReaderConfinement,
  checkGeneratedManifestConfinement,
  checkMigrationConfinement,
} from "./invariants/migration-capture-toolgen.ts";
export {
  checkBeforeStateRead,
  checkBoundWrites,
  checkConfirmComparison,
  checkModelWriteDoor,
} from "./invariants/model-write-door-bound-writes.ts";
export {
  checkChatopsReplySurfaceInvariant,
  checkChatopsUnwrappedPost,
  checkChatopsWatcherNoticeCaller,
  checkChatopsWatcherPinned,
  checkConnectorWriteConfinement,
  checkPolicyTomlImportInvariant,
  checkPreflightRunnerInvariant,
  checkSharePublishConfinement,
  checkTribalKbWriteInvariant,
} from "./invariants/policy-chatops-writes.ts";
export { assertScanIsMeaningful, RULE_ANCHORS } from "./invariants/rule-anchors.ts";
export { checkSchemaHistoryConfinement } from "./invariants/schema-history.ts";
export {
  checkChatReadMarkerConfinement,
  checkIncidentLinkMinting,
  checkIncidentRecordConfinement,
  checkItemHistoryConfinement,
  checkShareConsentBrokerConfinement,
  checkSyncContextNoRawHandles,
  checkWorkSnapshotConfinement,
} from "./invariants/share-sync-index-incident.ts";
export {
  checkFederationImportInvariant,
  checkIdentityTokenVaultInvariant,
  checkSpawnInvariant,
  checkTeamVaultPrefixInvariant,
  checkVaultKeyAllowList,
  checkWrapServerSpecInvariant,
  collectDbRunCensus,
  DB_RUN_EXEC_ALLOW_LIST,
  type DbRunHit,
  findDirectDbRunExec,
  I15_EXEMPT,
  LAZY_MESH_DIR,
  PLATFORM_VAULT_KEYS,
  VAULT_KEY_ALLOW_LIST,
} from "./invariants/spawn-vault-db-identity.ts";
export {
  bunSqliteImportBindsValue,
  checkEgressChokepointConfinement,
  checkFlatUpsertGraphEntityCoOwnedTypes,
  checkListenerRegistryConfinement,
  checkSavedToolAccessorConfinement,
  checkSqliteRuntimeInit,
  checkToolgenVaultKeyConfinement,
} from "./invariants/sqlite-listeners-egress-graph.ts";
export { checkPackLayerWriters, checkStandingApprovals } from "./invariants/standing-and-packs.ts";
export {
  checkCaptureTableConfinement,
  checkDoorApprovalConfinement,
  checkEmbeddingConstructorConfinement,
  checkMediaGrantStoreConfinement,
  checkRemoteVlmConfinement,
  checkVlmAppenderConfinement,
} from "./invariants/vlm-media-capture-door.ts";

function parseArgs(argv: readonly string[]): Mode {
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rule") {
      const r = argv[++i];
      if (
        r === "spawn" ||
        r === "wrap-spec" ||
        r === "vault-key" ||
        r === "db-run" ||
        r === "db-run-exec"
      ) {
        return r;
      }
      console.error(`unknown rule: ${r}`);
      process.exit(2);
    }
    if (a === "--binary-only") return "binary-only";
  }
  return "all";
}

async function loadFiles(): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  for await (const f of iterateSourceFiles()) {
    out.push({ relPath: f.relPath, contents: f.contents });
  }
  return out;
}

async function run(): Promise<void> {
  const mode = parseArgs(Bun.argv);
  const files = await loadFiles();

  // Before any rule runs, not after: a rule that examined nothing must not get the chance to
  // report clean. Exits 2 rather than 1 so "this auditor is broken" stays distinguishable from
  // "this auditor found a violation" — the same split `--db-run`'s exit codes already make.
  const missing = assertScanIsMeaningful(files);
  if (missing.length > 0) {
    console.error(
      `::error::structure audit scanned ${String(files.length)} file(s) but ${String(missing.length)} rule anchor(s) are absent, so D10-D22 would report clean without enforcing anything: ${missing.join(", ")}`,
    );
    console.error(
      "::error::Either a policed file moved (update RULE_ANCHORS in the same commit) or iterateSourceFiles() stopped reaching it (fix the glob/exclusions in scripts/structure-audit/lib.ts).",
    );
    process.exit(2);
  }

  let exit = 0;
  exit = Math.max(exit, reportRulesPart1(files, mode));
  exit = Math.max(exit, reportRulesPart2(files, mode));
  exit = Math.max(exit, reportRulesPart3(files, mode));
  exit = Math.max(exit, reportRulesPart4(files, mode));

  if (mode === "db-run" || mode === "all") {
    const census = collectDbRunCensus(files);
    const outPath = auditOutputPath("db-run-census.json");
    await Bun.write(outPath, `${JSON.stringify(census, null, 2)}\n`);
    console.log(`db-run census: ${census.length} hits → ${outPath}`);
    // db-run always exits 0 — it's a census, not a gate.
  }

  process.exit(exit);
}

if (import.meta.main) await run();
