// Reports the static rules, part 3 of 4: runs each check in the original order and prints its ::error lines.
// Moved verbatim out of run() in check-nimbus-invariants.ts.

import type { FileEntry, Mode } from "./_shared.ts";
import {
  checkBoundCapabilities,
  checkDriftCheckConfined,
  checkIacDiscard,
  checkWriteDirDeclarationConfined,
} from "./drift-bound-capabilities-iac.ts";
import {
  checkEvalConfinement,
  checkExtensionRoleConfinement,
  checkRunGrantTableConfinement,
  checkRunGrantWriters,
  checkTrustTableConfinement,
} from "./extension-grants-eval.ts";
import {
  checkActDoorConfinement,
  checkAgentProvenanceWriters,
  checkCaptureGateCallers,
  checkCaptureGateImporters,
  checkConfigReaderConfinement,
  checkMigrationConfinement,
} from "./migration-capture-toolgen.ts";
import {
  checkBeforeStateRead,
  checkBoundWrites,
  checkConfirmComparison,
  checkModelWriteDoor,
} from "./model-write-door-bound-writes.ts";
import { checkPackLayerWriters, checkStandingApprovals } from "./standing-and-packs.ts";
import {
  checkCaptureTableConfinement,
  checkMediaGrantStoreConfinement,
} from "./vlm-media-capture-door.ts";

export function reportRulesPart3(files: readonly FileEntry[], mode: Mode): number {
  let exit = 0;
  if (mode === "binary-only" || mode === "all") {
    const v = checkMediaGrantStoreConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D27(b) media_grant reached outside media-grant-store.ts — a caller can synthesise a grant or read around the active-row filter; I37 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkExtensionRoleConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D33(a) the __nimbus-extension role (or selfSpawn("extension")) named outside platform/runtime-layout.ts and extensions/extension-launch-command.ts — an extension entry could be spawned without the sandbox and the run grant: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkRunGrantTableConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D33(b) extension_run_grant reached outside extensions/run-grant-store.ts — a run grant could be created without the owner's extension.run approval: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkRunGrantWriters(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D33(c) a run-grant writer (upsertRunGrant/deleteRunGrant) named outside the store and the approve/revoke path — a run grant could be created or removed without the owner's extension.run approval: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkTrustTableConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D37 trust_statement or trust_feed_state reached outside extensions/trust/trust-store.ts — a trust statement could be stored, or the trust feed's floor moved, without the store's authority and admission checks: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkEvalConfinement(files);
    const D38_CLAUSE: Readonly<Record<string, string>> = {
      "eval-spec-builder-confined":
        "(a) buildExtensionEvalSpawnSpec named outside extensions/eval/eval-spawn-spec.ts and eval-runtime.ts",
      "eval-entry-command-confined":
        "(b) extensionEntryCommand named outside extensions/extension-launch-command.ts, extension-runtime.ts and eval/eval-spawn-spec.ts",
      "eval-imports-confined":
        "(c) a module under extensions/eval/ imports from vault/, egress/, ipc/, db/ or engine/executor",
      "eval-no-credentials": "(d) readCredentialEnv named under extensions/eval/",
      "eval-mcp-client-dynamic-only": "(e) @mastra/mcp imported statically under extensions/eval/",
    };
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D38${D38_CLAUSE[e.rule] ?? ""} — extension code could run for evaluation with network, credentials or gateway state, or the eval role's one stdout document could be corrupted (I49): ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkModelWriteDoor(files);
    const D39_CLAUSE: Readonly<Record<string, string>> = {
      "connector-write-tools-built-outside-door":
        "(a) tools built from the connector-write table outside engine/connector-write-agent-tools.ts",
      "connector-write-executor-read-confined":
        "(b) getAgentRequestConnectorWriteExecutor named outside agent-request-context.ts, run-ask.ts, agent.ts and the door",
      "connector-write-context-field-confined":
        "(b) the request-context field connectorWriteExecutor named outside agent-request-context.ts and run-ask.ts",
      "connector-write-builders-confined":
        "(e) buildConnectorWriteAgentTools named outside agent.ts and the door, or buildModelWriteExecutor outside run-ask.ts, or buildAgentWriteExecutor outside run-ask.ts and ipc/capture-rpc.ts, or buildWorkflowWriteExecutor outside run-ask.ts and gateway-main.ts",
      "connector-write-door-names-transport":
        "(c) the door names a connector transport (invokeConnectorWrite, withConnectorSession, createConnectorDispatcher, createConnectorWriteDispatcher or dispatch())",
      "connector-write-door-origin-model": '(d) the door carries no origin: "model"',
    };
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D39${D39_CLAUSE[e.rule] ?? ""} — the model could reach a connector write outside the owner-turn door, or without the no-delegation marker (I53): ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkBeforeStateRead(files);
    const D40_CLAUSE: Readonly<Record<string, string>> = {
      "before-read-literal-confined":
        "(a) the .before.read action-type literal outside engine/before-state.ts and connectors/registry.ts",
      "before-state-runner-confined":
        "(b) createBeforeStateRunner named outside engine/before-state.ts and run-ask.ts's newDoorExecutor or newWorkflowWriteExecutor",
      "before-read-guard-present":
        "(c) isBeforeReadActionType no longer called by engine/executor.ts or connectors/registry.ts",
    };
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D40${D40_CLAUSE[e.rule] ?? ""} — a before-state read could skip its guard or run on an executor other than the model door's (I53): ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkConfirmComparison(files);
    const D41_CLAUSE: Readonly<Record<string, string>> = {
      "confirm-channel-confined":
        "(a) requestConfirmedApproval named outside engine/executor.ts and engine/types.ts",
      "confirm-coordinator-confined":
        "(a) requestConfirmedConsent named outside engine/executor.ts and ipc/consent.ts",
      "confirm-render-confined":
        "(b) renderConfirmText named outside engine/executor.ts and connectors/connector-writes/confirm.ts",
      "confirm-comparison-confined":
        "(c) a confirmText or .typed comparison outside engine/executor.ts",
      "confirm-order-pinned":
        "(d) the executor's confirm phases are out of order or a Wave 4 write can reach the plain prompt",
    };
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D41${D41_CLAUSE[e.rule] ?? ""} — a Wave 4 write could be approved without the owner typing its confirm text, or the typed text could be judged somewhere other than the gate (I53, I20): ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = [
      ...checkBoundWrites(files),
      ...checkBoundCapabilities(files),
      ...checkDriftCheckConfined(files),
    ];
    const D42_CLAUSE: Readonly<Record<string, string>> = {
      "bound-prepare-literal-confined":
        "(a) the .write.prepare action-type literal outside engine/prepare-step.ts",
      "bound-name-confined":
        "(a)/(c) a bound-write name (injectBoundFields, runPrepareStep, isPrepareActionType, isPrepareToolId, renderUnifiedDiff, PREPARE_TOOL_IDS, writeTable, prepareToolIds) outside its files",
      "bound-order-pinned":
        "(b) the executor's prepare phase is out of order, or the injection is called from anywhere but dispatchBoundPhase",
      "bound-seam-not-production":
        "(c) production code passes the write-table or prepare-tool test seam",
      "bound-prepare-set-frozen": "(d) PREPARE_TOOL_IDS is mutable or mutated",
      "bound-public-gate-refuses":
        "(e) the public gate() could bind, or boundRefusal no longer refuses it first",
      "bound-capability-confined":
        "(h) the bound-write capabilities are named or built outside connectors/registry.ts and the executor",
      "bound-capability-calls":
        "(h) a bound-write capability is read or called outside the preflight and prepare phases",
      "bound-drift-confined":
        "(i) the drift check's flag, builder or method is set or called outside its one place",
    };
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D42${D42_CLAUSE[e.rule] ?? ""} — a bound write could be dispatched with values its own gate-run prepare step did not produce, or a caller could supply them (I54): ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkWriteDirDeclarationConfined(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D10 (user-write) a sandbox policy's write-directory declaration is named outside the policy wire and its checks — a spawn could be handed a directory write grant that no owner approved (I15): ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkIacDiscard(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D43 (${e.rule}) the gateway-internal discard of an unused change set is named or reachable outside the executor's discard step — a change set could be deleted without the owner's approval, or after a dispatch (I2 exception): ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkStandingApprovals(files);
    const D44_CLAUSE: Record<string, string> = {
      "standing-provenance-confined":
        "(a) an owner-workflow provenance is built, or its shape named, outside the workflow write step",
      "standing-tables-confined":
        "(b) a standing-rule table or one of its writers is reached outside the store",
      "standing-step-order-pinned":
        "(c) the standing-rule step is not called once in approvalPhase, after the confirm phase and before a delegate",
      "standing-outcome-confined":
        "(c) a standing_approved outcome is constructed, or the check named, outside the executor and the check",
      "standing-rules-dep-confined":
        "(e) the standing-rule dependencies are handed to an executor other than the workflow write executors",
      "standing-unattended-confined":
        "(d) the unattended executor option, its refusal text or the schedule trigger is used outside its confinement",
      "standing-learning-confined":
        "(f) a learning table, writer or the learning pass is reached outside the suggestion store, the pass and the workflow runner",
      "standing-guard-confined":
        "(g) the workflow guard module imports more than the step types and the sanitiser, a guard function is named outside the runner, rule derivation and the standing RPC, or the standing-rule step reads a guard",
    };
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D44 ${D44_CLAUSE[e.rule] ?? e.rule} — a write could run with no prompt that a live, owner-approved standing rule does not exactly cover (I55): ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkPackLayerWriters(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D36 a pack-layer writer (setPackLayer/removePackLayer) named outside packs/pack-layer-store.ts and packs/pack-install.ts — a role pack could change the owner's config without the owner's pack.install approval (I47): ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkConfigReaderConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D35 config read outside the layered reader (config/layered-config.ts) — a setting would ignore the active profile: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkMigrationConfinement(files);
    const D34_LETTER: Readonly<Record<string, string>> = {
      "migration-table-confined":
        "(a) connector_migration reached outside extensions/migration/migration-store.ts",
      "migration-grant-callers":
        "(b) approveMigratedExtensionRun named outside approve-run.ts and the migration engine",
      "migration-consent-raisers":
        "(c) the extension.migrate consent (migrationConsentViaGate / EXTENSION_MIGRATE_ACTION_TYPE / createMigrationEngine / the migrationEngine option / the literal) named outside the engine and the RPC path",
    };
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D34${D34_LETTER[e.rule] ?? ""} — a connector could be moved to an extension, or its grant written, without the owner's one extension.migrate approval: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const a = checkCaptureTableConfinement(files);
    for (const e of a) {
      console.error(
        `::error file=${e.file},line=${e.line}::D32(a) the capture table reached outside mcp-sink/capture-store.ts — I28 regression: ${e.snippet}`,
      );
    }
    const b = checkCaptureGateCallers(files);
    for (const e of b) {
      console.error(
        `::error file=${e.file},line=${e.line}::D32(b) a capture gate entry point named outside ipc/capture-rpc.ts and ipc/approvals-rpc.ts — I28 regression: ${e.snippet}`,
      );
    }
    const c = checkCaptureGateImporters(files);
    for (const e of c) {
      console.error(
        `::error file=${e.file},line=${e.line}::D32(c) capture-gate.ts value-imported outside ipc/capture-rpc.ts and ipc/approvals-rpc.ts — I28 regression: ${e.snippet}`,
      );
    }
    const d = checkAgentProvenanceWriters(files);
    for (const e of d) {
      console.error(
        `::error file=${e.file},line=${e.line}::D32(d) an agent-row writer reached outside the capture accept path — I28 regression: ${e.snippet}`,
      );
    }
    const e = checkActDoorConfinement(files);
    const D32_ACT_DOOR_LETTER: Readonly<Record<string, string>> = {
      "act-door-accept-action": "e) acceptAction named outside capture-act.ts/capture-gate.ts",
      "mcp-sink-no-executor-or-connectors":
        "f) an mcp-sink/ file imports engine/executor.ts or connectors/",
      "mcp-sink-mcptoolid-literal":
        "g) the mcpToolId literal under mcp-sink/ outside capture-validate.ts",
    };
    for (const v of e) {
      console.error(
        `::error file=${v.file},line=${v.line}::D32(${D32_ACT_DOOR_LETTER[v.rule] ?? v.rule} — act door confinement, I28 regression: ${v.snippet}`,
      );
    }
    if (a.length > 0 || b.length > 0 || c.length > 0 || d.length > 0 || e.length > 0) exit = 1;
  }
  return exit;
}
