import { describe, expect, test } from "bun:test";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { read } from "../../test/helpers/security-invariants.ts";

describe("I7 — Tauri ALLOWED_METHODS surface for T2 PR 3", () => {
  test("regression guard (green on day one by design): the connector write opt-in methods are not renderer-callable", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    for (const m of [
      "connector.writesEnable",
      "connector.writesDisable",
      "connector.writesStatus",
    ]) {
      expect(rust).not.toContain(`"${m}"`);
    }
  });

  test("ALLOWED_METHODS contains extension.checkForUpdates and extension.update", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    expect(rust).toContain(`"extension.checkForUpdates"`);
    expect(rust).toContain(`"extension.update"`);
  });

  test("extension.install stays absent from ALLOWED_METHODS (chain C1 / B1 audit)", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    expect(rust).not.toMatch(/^\s*"extension\.install",\s*$/m);
  });

  // Namespace-level, like the `computer.` check: a generated tool runs owner-approved,
  // network-reaching code, and `toolgen.invoke` executes it. The count cannot protect this -- a
  // one-for-one swap keeps it at 105 -- and a future `toolgen.*` verb should be absent by default.
  test("no toolgen.* method is exposed to the Tauri renderer (I7)", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    expect(rust).not.toContain("toolgen.");
  });

  test("allowlist_exact_size assertion is 141", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    expect(rust).toMatch(/assert_eq!\s*\(\s*ALLOWED_METHODS\.len\(\),\s*141\s*\)/);
  });

  // Role packs Project 4: 111 + 7 - 2 = 116; Project 5 (onboarding): + pack.install, decisions.status
  // = 118. By NAME, since a swap keeps the count.
  test("role packs desktop: only fleet.briefs/fleet.show, pack.install/pack.list and decisions.status are exposed from those namespaces", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    const start = rust.indexOf("pub const ALLOWED_METHODS: &[&str] = &[");
    const list = rust.slice(start, rust.indexOf("];", start));
    expect([...list.matchAll(/"(fleet\.[A-Za-z]+)"/g)].map((m) => m[1])).toEqual([
      "fleet.briefs",
      "fleet.show",
    ]);
    expect([...list.matchAll(/"(pack\.[A-Za-z]+)"/g)].map((m) => m[1])).toEqual([
      "pack.install",
      "pack.list",
    ]);
    expect([...list.matchAll(/"(decisions\.[A-Za-z]+)"/g)].map((m) => m[1])).toEqual([
      "decisions.status",
    ]);
    // pack.install resolves only once the owner answers, so the bridge must not time it out.
    expect(rust).toMatch(/assert_eq!\s*\(\s*NO_TIMEOUT_METHODS\.len\(\),\s*8\s*\)/);
    expect(rust).toContain('assert!(is_no_timeout_method("pack.install"));');
    for (const m of ["catalog.list", "agents.oncall", "agents.standup", "agents.changelog"]) {
      expect(list).toContain(`"${m}"`);
    }
  });

  // Phase 10 MB5, 127 -> 131: briefing.get|latest|list|status are renderer-callable reads; briefing.runNow
  // composes a briefing and shows a notification on the owner's machine, so it stays CLI-only. By NAME,
  // since a one-for-one swap keeps the count.
  test("briefing: the four reads are renderer-callable, runNow never is", async () => {
    const rust = stripComments(await read("packages/ui/src-tauri/src/gateway_bridge.rs"));
    for (const m of ["get", "latest", "list", "status"]) {
      expect(rust).toMatch(new RegExp(`^\\s*"briefing\\.${m}",\\s*$`, "m"));
      expect(rust).toContain(`assert!(is_method_allowed("briefing.${m}"));`);
      expect(rust).toContain(`assert!(!is_no_timeout_method("briefing.${m}"));`);
    }
    expect(rust).not.toMatch(/^\s*"briefing\.runNow",\s*$/m);
    expect(rust).toContain('assert!(!is_method_allowed("briefing.runNow"));');
  });

  // By NAME, as for every brief/verb pair: a one-for-one swap of pushedGet for pushedRetry keeps
  // the count at 107. pushedRetry starts an agent run on the owner's behalf; it stays CLI-only.
  // `oncall.now` (Phase 10 MB3) is the third read: a synchronous read of the local index, not long-running.
  test("oncall: the three reads (pushedGet, pushedList, now) are renderer-callable, pushedRetry never is", async () => {
    const rust = stripComments(await read("packages/ui/src-tauri/src/gateway_bridge.rs"));
    expect(rust).toMatch(/^\s*"oncall\.now",\s*$/m);
    expect(rust).toContain('assert!(is_method_allowed("oncall.now"));');
    expect(rust).toContain('assert!(!is_no_timeout_method("oncall.now"));');
    // `oncall.handoff` (Phase 17) is the fourth read: the shift brief from the local index, synchronous.
    expect(rust).toMatch(/^\s*"oncall\.handoff",\s*$/m);
    expect(rust).toContain('assert!(is_method_allowed("oncall.handoff"));');
    expect(rust).toContain('assert!(!is_no_timeout_method("oncall.handoff"));');
    expect(rust).toMatch(/^\s*"oncall\.pushedGet",\s*$/m);
    expect(rust).toMatch(/^\s*"oncall\.pushedList",\s*$/m);
    expect(rust).not.toMatch(/^\s*"oncall\.pushedRetry",\s*$/m);
    expect(rust).toContain('assert!(is_method_allowed("oncall.pushedList"));');
    expect(rust).toContain('assert!(is_method_allowed("oncall.pushedGet"));');
    expect(rust).toContain('assert!(!is_method_allowed("oncall.pushedRetry"));');
  });

  // By NAME again: the desktop Captures page reads; accepting, rejecting, revoking and purging
  // stay in a terminal, and the MCP-client door (capture.*) is never the renderer's (I28).
  test("captures: the two reads are renderer-callable, no owner verb is", async () => {
    const rust = stripComments(await read("packages/ui/src-tauri/src/gateway_bridge.rs"));
    expect(rust).toMatch(/^\s*"captures\.get",\s*$/m);
    expect(rust).toMatch(/^\s*"captures\.list",\s*$/m);
    expect(rust).not.toMatch(/^\s*"captures\.(?:accept|reject|revoke|purge)",\s*$/m);
    expect(rust).not.toMatch(/^\s*"capture\.[A-Za-z]+",\s*$/m);
    expect(rust).toContain('assert!(is_method_allowed("captures.list"));');
    expect(rust).toContain('assert!(is_method_allowed("captures.get"));');
    expect(rust).toContain('assert!(!is_method_allowed("captures.accept"));');
  });

  test("connector.list stays absent; connector.listStatus is the served one", async () => {
    // By NAME, because the count cannot protect a removal: swapping `connector.list` back in for
    // any other entry keeps the length at 105 and sails through. It was allowlisted with no
    // handler behind it from the day it was added, so the desktop got -32601 on every call; the
    // live resolution test in ipc/allowlist-resolves.test.ts is what caught it, and this pins the
    // specific regression that test would then have to re-catch.
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    expect(rust).not.toMatch(/^\s*"connector\.list",\s*$/m);
    expect(rust).toMatch(/^\s*"connector\.listStatus",\s*$/m);
  });

  // Same reasoning as `connector.list` above, and the same shape as the brief/verb pairs below:
  // the 2026-09-10 removal of the `connector.startAuth` alias was a one-for-one SWAP, not a
  // deletion — `connector.auth` had never been on the list, so the count stayed 105 and only the
  // enumeration moved. Getting this half wrong is worse than a plain removal: the renderer's only
  // auth path would fail -32601 on every call, which is exactly the S4-F2 defect the alias was
  // introduced to paper over.
  test("connector.auth is renderer-exposed; the removed connector.startAuth alias stays absent", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    expect(rust).toMatch(/^\s*"connector\.auth",\s*$/m);
    expect(rust).not.toMatch(/^\s*"connector\.startAuth",\s*$/m);
    // …and the Rust side asserts the same thing at runtime, not just by count.
    expect(rust).toContain(`assert!(is_method_allowed("connector.auth"));`);
    expect(rust).toContain(`assert!(!is_method_allowed("connector.startAuth"));`);
  });

  // The count above is NOT sufficient on its own — a one-for-one substitution (e.g.
  // agents.ownership swapped out for the LAN-forbidden ownership.refresh, which clears and
  // re-derives every ownership edge) leaves the count unchanged and would sail through. Name
  // the methods, mirroring the Rust-side `allowlist_ownership_brief_only` test.
  test("S1 ownership: agents.ownership is renderer-exposed; ownership.refresh stays absent", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    expect(rust).toContain("agents.ownership");
    expect(rust).not.toMatch(/^\s*"ownership\.refresh",\s*$/m);
  });

  // The count above is NOT sufficient on its own. A change that removes
  // agents.decisions and adds decisions.refresh — LAN-forbidden, and the verb
  // that can clear the whole decision store via decisions.rebuild — leaves the
  // count unchanged and would sail through. Name the methods.
  test("S1 decisions: agents.decisions is renderer-exposed; the pass verbs stay absent", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    expect(rust).toMatch(/^\s*"agents\.decisions",\s*$/m);
    expect(rust).not.toMatch(/^\s*"decisions\.refresh",\s*$/m);
    expect(rust).not.toMatch(/^\s*"decisions\.rebuild",\s*$/m);
    // …and the Rust side asserts the same thing at runtime, not just by count.
    expect(rust).toContain(`assert!(is_method_allowed("agents.decisions"));`);
    expect(rust).toContain(`assert!(!is_method_allowed("decisions.refresh"));`);
    expect(rust).toContain(`assert!(!is_method_allowed("decisions.rebuild"));`);
  });

  // Role packs Project 4 removed agents.preflight and agents.premortem (the latter was the one
  // renderer-callable entry that was not purely a read). By NAME, so a later swap that puts either
  // back keeps the count and still fails here; mirrors the Rust-side
  // `allowlist_preflight_and_premortem_removed` test.
  test("agents.premortem and agents.preflight are NOT renderer-exposed; premortem.refresh stays absent", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    expect(rust).not.toMatch(/^\s*"agents\.premortem",\s*$/m);
    expect(rust).not.toMatch(/^\s*"agents\.preflight",\s*$/m);
    expect(rust).not.toMatch(/^\s*"premortem\.refresh",\s*$/m);
    expect(rust).toContain(`assert!(!is_method_allowed("agents.premortem"));`);
    expect(rust).toContain(`assert!(!is_method_allowed("agents.preflight"));`);
    expect(rust).toContain(`assert!(!is_method_allowed("premortem.refresh"));`);
  });

  test("I29: the 4 egress read verbs are renderer-exposed; egress.prune (mutation) stays absent", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    for (const m of ["egress.head", "egress.list", "egress.proveWindow", "egress.verify"]) {
      expect(rust).toContain(`"${m}"`);
    }
    expect(rust).not.toMatch(/^\s*"egress\.prune",\s*$/m);
  });

  test("Slice 6c: read-only tribal.status/list allowed; control-plane tribal methods stay absent", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    for (const m of ["tribal.status", "tribal.list"]) {
      expect(rust).toContain(`"${m}"`);
    }
    for (const m of [
      "tribal.start",
      "tribal.stop",
      "tribal.dismiss",
      "tribal.scan",
      "tribal.capture",
    ]) {
      expect(rust).not.toMatch(new RegExp(`^\\s*"${m.replace(".", "\\.")}",\\s*$`, "m"));
    }
  });

  test("Slice 4: read-only admin/policy/team-audit methods are allowed; privileged policy/team-purge methods stay absent", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    // Read-only observability/admin surfaces are renderer-callable.
    for (const m of ["admin.status", "policy.show", "team.auditMerged"]) {
      expect(rust).toContain(`"${m}"`);
    }
    // Trust-establishing / destructive methods must NOT be renderer-callable.
    for (const m of ["policy.sign", "policy.trust", "policy.refetch", "team.purge"]) {
      expect(rust).not.toMatch(new RegExp(`^\\s*"${m.replace(".", "\\.")}",\\s*$`, "m"));
    }
  });

  test("Slice 2: renderer-SAFE team methods are allowed; secret/RCE-class ones stay absent", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    for (const m of [
      "federation.approvalRespond",
      "federation.quorumRespond",
      "hitl.listDelegations",
      "hitl.pendingQueue",
      "teamvault.list",
    ]) {
      expect(rust).toContain(`"${m}"`);
    }
    // Secret-writing / out-of-band / RCE-class team methods must NOT be renderer-callable.
    for (const m of [
      "teamvault.put",
      "teamvault.delete",
      "teamvault.grant",
      "teamvault.revoke",
      "hitl.delegate",
      "hitl.revokeDelegation",
      "federation.invoke",
      "federation.askInvoke",
    ]) {
      expect(rust).not.toMatch(new RegExp(`^\\s*"${m.replace(".", "\\.")}",\\s*$`, "m"));
    }
  });
});
