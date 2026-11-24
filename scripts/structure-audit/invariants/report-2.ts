// Reports the static rules, part 2 of 4: runs each check in the original order and prints its ::error lines.
// Moved verbatim out of run() in check-nimbus-invariants.ts.

import type { FileEntry, Mode } from "./_shared.ts";
import {
  checkActuationConfinement,
  checkAgentEmitterImportConfinement,
  checkDriverImportConfinement,
  checkEmbeddingAppenderConfinement,
  checkRegistryAppenderConfinement,
} from "./actuation-embedding-registry.ts";
import {
  checkAgentDoorWindowRetired,
  checkAgentOriginWriter,
  checkOriginComparison,
  checkUserMcpCallFacts,
  checkUserMcpDoorReach,
} from "./agent-door.ts";
import { checkAgentDoorCheckOrder } from "./agent-door-order.ts";
import {
  checkBriefingConfinement,
  checkComputerUseBindingConfinement,
  checkFinopsConfinement,
  checkIncidentConfinement,
  checkLanBoxPathConfinement,
  checkToolgenModelDoorConfinement,
  checkWorkflowImportConfinement,
} from "./briefing-incident-workflow-toolgen.ts";
import {
  checkConnectorSpawnIsHidden,
  checkFleetClientKindConfinement,
  checkIncidentFindingConfinement,
  checkIncidentRemediationConfinement,
  checkPushClientKindConfinement,
  checkRunbookConfinement,
  checkRunConfinedConfinement,
} from "./incident-runbook-client-kinds.ts";
import { checkInvestigateLiveConfinement } from "./investigate-live.ts";
import {
  checkChatReadMarkerConfinement,
  checkIncidentLinkMinting,
  checkIncidentRecordConfinement,
  checkItemHistoryConfinement,
  checkSyncContextNoRawHandles,
  checkWorkSnapshotConfinement,
} from "./share-sync-index-incident.ts";
import { checkEgressChokepointConfinement } from "./sqlite-listeners-egress-graph.ts";
import {
  checkDoorApprovalConfinement,
  checkEmbeddingConstructorConfinement,
  checkRemoteVlmConfinement,
  checkVlmAppenderConfinement,
} from "./vlm-media-capture-door.ts";

export function reportRulesPart2(files: readonly FileEntry[], mode: Mode): number {
  let exit = 0;
  if (mode === "binary-only" || mode === "all") {
    const handleViolations = checkSyncContextNoRawHandles(files);
    for (const e of handleViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D24 a syncable reached a raw vault/db handle — capabilities are the only route: ${e.snippet}`,
      );
    }
    if (handleViolations.length > 0) exit = 1;
    const briefingViolations = checkBriefingConfinement(files);
    for (const e of briefingViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D45 the morning briefing reached outside its local sinks (rule ${e.rule}) — no ChatOps/egress/federation/share import, no connectors value import, no network primitive: ${e.snippet}`,
      );
    }
    if (briefingViolations.length > 0) exit = 1;
    const finopsViolations = checkFinopsConfinement(files);
    for (const e of finopsViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D48 FinOps cost code reached outside the machine (rule ${e.rule}) — no ChatOps/egress/federation/share/llm/engine/agents import, no connectors value import, no network primitive: ${e.snippet}`,
      );
    }
    if (finopsViolations.length > 0) exit = 1;
    const boxViolations = checkLanBoxPathConfinement(files);
    for (const e of boxViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D47 the LAN static-box seal (sealBoxFrame/openBoxFrame/nacl.box) used outside ipc/lan-legacy.ts and ipc/lan-crypto.ts — a record could be sealed under the static identity key, with no forward secrecy (I56): ${e.snippet}`,
      );
    }
    if (boxViolations.length > 0) exit = 1;
    const snapshotViolations = checkWorkSnapshotConfinement(files);
    for (const e of snapshotViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D24 work_snapshot written outside its store (rule work-snapshot-confined) — the replaceWorkSnapshot capability is the only route: ${e.snippet}`,
      );
    }
    if (snapshotViolations.length > 0) exit = 1;
    const markerViolations = checkChatReadMarkerConfinement(files);
    for (const e of markerViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D24 chat_read_marker written outside its store (rule chat-read-marker-confined) — the setChatReadMarkers capability is the only route: ${e.snippet}`,
      );
    }
    if (markerViolations.length > 0) exit = 1;
    const historyViolations = checkItemHistoryConfinement(files);
    for (const e of historyViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D46(b) item_history written outside its module (rule item-history-confined) — index/item-history.ts is the only writer: ${e.snippet}`,
      );
    }
    if (historyViolations.length > 0) exit = 1;
    const incidentViolations = checkIncidentConfinement(files);
    for (const e of incidentViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D46(a) incident assembly reached outside the local index (rule ${e.rule}) - no ChatOps/egress/federation/share import, no connectors value import, no network primitive: ${e.snippet}`,
      );
    }
    if (incidentViolations.length > 0) exit = 1;
    const incidentRecordViolations = checkIncidentRecordConfinement(files);
    for (const e of incidentRecordViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D46(d) an incident record table, or the pushed briefs built from one, written or erased outside its owner (rule ${e.rule}) - incident/incident-store.ts, incident/incident-erasure.ts and oncall-push/push-store.ts are the only writers: ${e.snippet}`,
      );
    }
    if (incidentRecordViolations.length > 0) exit = 1;
    const remediationViolations = checkIncidentRemediationConfinement(files);
    for (const e of remediationViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D46(c) an engine-proposed action built or its tables written outside incident/remediation.ts and incident/proposal-store.ts (rule ${e.rule}): ${e.snippet}`,
      );
    }
    if (remediationViolations.length > 0) exit = 1;
    const findingViolations = checkIncidentFindingConfinement(files);
    for (const e of findingViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D46(f) an incident finding or anomaly baseline table written outside incident/finding-store.ts (rule ${e.rule}): ${e.snippet}`,
      );
    }
    if (findingViolations.length > 0) exit = 1;
    const runbookViolations = checkRunbookConfinement(files);
    for (const e of runbookViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D46(g) a runbook step built, its read type spelled, its table written or the runbook folder read outside runbook/runbook-run.ts, engine/runbook-read.ts, incident/runbook-step-store.ts and runbook/runbook-loader.ts (rule ${e.rule}): ${e.snippet}`,
      );
    }
    if (runbookViolations.length > 0) exit = 1;
    const investigateLiveViolations = checkInvestigateLiveConfinement(files);
    for (const e of investigateLiveViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D46(h) a live investigation read built, wired or imported outside investigation/investigation-live.ts and its wiring (rule ${e.rule}): ${e.snippet}`,
      );
    }
    if (investigateLiveViolations.length > 0) exit = 1;
    const incidentLinkViolations = checkIncidentLinkMinting(files);
    for (const e of incidentLinkViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D46(e) the incident link minted, declared or spelled into a row outside its owners (rule ${e.rule}) - incident/incident-link-mint.ts is the only constructor, engine/incident-link.ts the only declaration, and only incident/action-links.ts and audit/incident-replay.ts read a quoted "incident": key: ${e.snippet}`,
      );
    }
    if (incidentLinkViolations.length > 0) exit = 1;
    const workflowImportViolations = checkWorkflowImportConfinement(files);
    for (const e of workflowImportViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D50 the signed workflow import left its confinement (rule ${e.rule}) - workflow_import, importWorkflowBundle and upsertWorkflowByName only at their sites, no rule or learning table or schedule writer in the import modules, no rule-path read of provenance, and no ChatOps/egress/federation import, connectors value import or network primitive in them: ${e.snippet}`,
      );
    }
    if (workflowImportViolations.length > 0) exit = 1;
    const toolgenModelDoorViolations = checkToolgenModelDoorConfinement(files);
    for (const e of toolgenModelDoorViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D51 the model's door to saved generated tools left its confinement (rule ${e.rule}) - buildModelGeneratedTools only from engine/agent.ts, buildGeneratedTools only from the door, invokeSavedTool only from the CLI path and the door's binding, the owner-only approval slot set only by runAsk, and "tool.model.invoke" only in the door and the executor: ${e.snippet}`,
      );
    }
    if (toolgenModelDoorViolations.length > 0) exit = 1;
    const computerUseBindingViolations = checkComputerUseBindingConfinement(files);
    for (const e of computerUseBindingViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D26(d) the model's computer-use binding left its confinement (rule ${e.rule}) - buildComputerUseTools only from engine/agent.ts, the computerUse slot set only by runAsk, liveSessionLane only in the gate and the resolver, the kind map only at the IPC entry, and the unicast prompt raised only from assemble: ${e.snippet}`,
      );
    }
    if (computerUseBindingViolations.length > 0) exit = 1;
    const doorApprovalViolations = checkDoorApprovalConfinement(files);
    for (const e of doorApprovalViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D49(b) connector_write_door_approval named outside its store (rule door-approval-confined) — connectors/connector-writes/door-approval-store.ts is the only module that reads or writes it: ${e.snippet}`,
      );
    }
    if (doorApprovalViolations.length > 0) exit = 1;
    const doorTableViolations = checkAgentDoorWindowRetired(files);
    for (const e of doorTableViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D49(a) a retired deprecation-window name (the proposability table, actDoorRefusal, the capture legacy flag) is back in production source, or the agent door's constructor is named outside its sites (rule ${e.rule}) — createAgentDoor is built only in platform/assemble.ts: ${e.snippet}`,
      );
    }
    if (doorTableViolations.length > 0) exit = 1;
    const agentOriginViolations = checkAgentOriginWriter(files);
    for (const e of agentOriginViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D49(c) origin: "agent" or a proposer property written outside ipc/capture-rpc.ts buildActDeps (rule agent-origin-written-once): ${e.snippet}`,
      );
    }
    if (agentOriginViolations.length > 0) exit = 1;
    const originCompareViolations = checkOriginComparison(files);
    for (const e of originCompareViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D49(d) an action's origin compared with a literal outside engine/outside-origin.ts (rule origin-compared-once) — call isOutsideOrigin or isAgentOrigin: ${e.snippet}`,
      );
    }
    if (originCompareViolations.length > 0) exit = 1;
    const checkOrderViolations = checkAgentDoorCheckOrder(files);
    for (const e of checkOrderViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D49(e) the agent door's three check points are out of order or missing (rule agent-door-check-order) — the verdict and the definition check precede the write at submit and the claim at approval, and the vetoing consent is the executor's: ${e.snippet}`,
      );
    }
    if (checkOrderViolations.length > 0) exit = 1;
    const callFactsViolations = checkUserMcpCallFacts(files);
    for (const e of callFactsViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D49(g) the user-MCP call facts (userMcpCall) named or written outside their sites (rule user-mcp-call-facts-confined) — only ipc/capture-rpc.ts writes them, and engine/{types,executor,user-mcp-call-block}.ts name them: ${e.snippet}`,
      );
    }
    if (callFactsViolations.length > 0) exit = 1;
    const doorReachViolations = checkUserMcpDoorReach(files);
    for (const e of doorReachViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D49(h) the stripped user-MCP listing or the door-approval delete named outside their sites (rule user-mcp-door-reach-confined) — listUserMcpToolDefinitions only in the mesh, the assembly and the connector RPC, and its injected name listUserMcpDefinitions only in the door runtime, the connector RPC with its agent-writes and model-writes handlers, and the assembly; removeDoorApprovals only in its store and the disable, remove and add handlers: ${e.snippet}`,
      );
    }
    if (doorReachViolations.length > 0) exit = 1;
    const spawnViolations = checkConnectorSpawnIsHidden(files);
    for (const e of spawnViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D25 a connector called Bun.spawn — use platform/spawn-capture.ts, which passes windowsHide (the detached Gateway pops a console window otherwise): ${e.snippet}`,
      );
    }
    if (spawnViolations.length > 0) exit = 1;
    const v = checkRunConfinedConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D23 runConfined called outside exec-gate.ts/exec-run.ts — bypasses the I33 code-execution gate: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
    const fleetKindViolations = checkFleetClientKindConfinement(files);
    for (const e of fleetKindViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D28 fleet ClientKind breach — the unattended-fleet attribution is named outside client-kind.ts/egress-bearing-kinds.ts/fleet-invoker.ts, a second path able to file briefs as fleet work without the scheduler's checks (I38): ${e.snippet}`,
      );
    }
    if (fleetKindViolations.length > 0) exit = 1;
    const pushKindViolations = checkPushClientKindConfinement(files);
    for (const e of pushKindViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D28 push ClientKind breach — the on-call push attribution is named outside client-kind.ts/egress-bearing-kinds.ts/push-runner.ts, a second path able to file briefs as pushed work without the runner's checks: ${e.snippet}`,
      );
    }
    if (pushKindViolations.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const actuationViolations = checkActuationConfinement(files);
    for (const e of actuationViolations) {
      console.error(
        `::error file=${e.file},line=${e.line}::D26 performActuation called outside cu-gate.ts/cu-actuate.ts — bypasses the I35 computer-use actuation gate: ${e.snippet}`,
      );
    }
    if (actuationViolations.length > 0) exit = 1;
    const driverImportViolations = checkDriverImportConfinement(files);
    for (const e of driverImportViolations) {
      console.error(
        e.rule === "D26-lane-constructor"
          ? `::error file=${e.file},line=${e.line}::D26(c) a computer-use lane constructor (openBrowserLane/openTerminalLane) is named outside its own definition file and platform/assemble.ts — a live lane obtained here can be driven with no envelope, classification, consent or audit row (I35): ${e.snippet}`
          : `::error file=${e.file},line=${e.line}::D26(b) browser-driving capability (automation library import, or a CDP Domain.method literal) outside computer-use/cu-lanes/ — a second path to the host that never passes the I35 gate: ${e.snippet}`,
      );
    }
    if (driverImportViolations.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkEgressChokepointConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D22 egress chokepoint breach (connectors.dispatch outside executor.ts, appendEgressEntry outside egress/, recordAgentBriefEgress outside agents-rpc.ts, or registerRoute outside llm/registry.ts) — bypasses I29: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkAgentEmitterImportConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D22(d) agent emitter imported outside ipc/agents-rpc.ts — a second entry point would serve a brief with no egress row; I29 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkEmbeddingAppenderConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D22(f) wrapLedgeredEmbedder referenced outside the three construction sites/embedding-egress.ts — an unrecorded remote embed; I29 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkRegistryAppenderConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D22(h) ${e.rule}: recordRegistryEgress outside egress/registry-egress.ts + extensions/registry/registry-fetch.ts, or a bare fetch( under extensions/ outside registry-fetch.ts — an unrecorded registry request; I29 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkEmbeddingConstructorConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D22(f) createOpenAIEmbedder constructed outside the three construction sites/its own definition — a NEW remote embedder built without the wrapLedgeredEmbedder decorator; I29 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkVlmAppenderConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D22(g) a VlmProvider constructed or wrapped outside egress/vlm-egress.ts + build-media-pass-deps.ts — an unrecorded vision egress path; I29 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkRemoteVlmConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D27(a) a non-local VlmProvider constructed outside build-media-pass-deps.ts, or not wrapped by wrapLedgeredVlm — an ungated remote describe; I37 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  return exit;
}
