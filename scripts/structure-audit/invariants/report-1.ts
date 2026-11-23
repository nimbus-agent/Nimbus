// Reports the static rules, part 1 of 4: runs each check in the original order and prints its ::error lines.
// Moved verbatim out of run() in check-nimbus-invariants.ts.

import type { FileEntry, Mode } from "./_shared.ts";
import { checkForwardShareConfinement } from "./actuation-embedding-registry.ts";
import {
  checkChatopsReplySurfaceInvariant,
  checkChatopsUnwrappedPost,
  checkChatopsWatcherNoticeCaller,
  checkChatopsWatcherPinned,
  checkConnectorWriteConfinement,
  checkPolicyTomlImportInvariant,
  checkPreflightRunnerInvariant,
  checkSharePublishConfinement,
  checkTribalKbWriteInvariant,
} from "./policy-chatops-writes.ts";
import { checkShareConsentBrokerConfinement } from "./share-sync-index-incident.ts";
import {
  checkFederationImportInvariant,
  checkIdentityTokenVaultInvariant,
  checkSpawnInvariant,
  checkTeamVaultPrefixInvariant,
  checkVaultKeyAllowList,
  checkWrapServerSpecInvariant,
  findDirectDbRunExec,
} from "./spawn-vault-db-identity.ts";

export function reportRulesPart1(files: readonly FileEntry[], mode: Mode): number {
  let exit = 0;
  if (mode === "spawn" || mode === "binary-only" || mode === "all") {
    const v = checkSpawnInvariant(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D10 spawn not via extensionProcessEnv: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "wrap-spec" || mode === "binary-only" || mode === "all") {
    const v = checkWrapServerSpecInvariant(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::I15 lazy-mesh file constructs ServerSpec without wrapServerSpec — I15 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "vault-key" || mode === "binary-only" || mode === "all") {
    const v = checkVaultKeyAllowList(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D11 vault-key constructed outside allow-list: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "db-run-exec" || mode === "binary-only" || mode === "all") {
    const v = findDirectDbRunExec(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D12 direct db.run/db.exec outside allow-list: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkFederationImportInvariant(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D13 federation file imports item-list-query outside query-gate.ts — I17 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkIdentityTokenVaultInvariant(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D14 identity token key used outside identity/ — I18 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkTeamVaultPrefixInvariant(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D15 teamvault. prefix composed outside team-vault-keys.ts — I19 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkPolicyTomlImportInvariant(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D16 parsePolicyToml imported outside policy/ — read EnforcedPolicy via policy-gate.ts; I22 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkChatopsReplySurfaceInvariant(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D17 chatops post tool referenced outside reply-dispatcher/transport — bypasses I23: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkChatopsWatcherPinned(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D17(d) the watcher-pinned channel referenced outside chatops types/dispatcher/boot and assemble — a pinned destination must come only from the owner's boot config (I23): ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkChatopsWatcherNoticeCaller(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D17(c) postWatcherNotice referenced outside chatops-boot/assemble — a watcher notice must reach a channel only through the ChatOps boot's bound poster (I23): ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkChatopsUnwrappedPost(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D17 buildConnectorPost/buildConnectorViewsOpen called without its ledgered wrapper (buildLedgeredChatPosts/buildLedgeredConfirmModal) — bypasses the I29 chatops egress ledger: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkPreflightRunnerInvariant(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D18 runPreflightCommand referenced outside preflight-gate/preflight-runner — bypasses I24: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkTribalKbWriteInvariant(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D19 tribal KB-write tool referenced outside the write-gate/connector sites — bypasses I25: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkConnectorWriteConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D20 connector write tool referenced/wired outside allowed sites — bypasses I26: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkSharePublishConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D21 share.publish action-type / share.signing.privkey vault-key referenced outside the gate/keypair sites — bypasses I27: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkShareConsentBrokerConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D21 createShare called outside the gate/share-rpc sites, or assemble.ts does not wire shareConsent.request as the approval dep — bypasses I27: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "binary-only" || mode === "all") {
    const v = checkForwardShareConfinement(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D21 forwardShare called outside share-forward.ts/federation-rpc.ts — bypasses I27 second emit chokepoint: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  return exit;
}
