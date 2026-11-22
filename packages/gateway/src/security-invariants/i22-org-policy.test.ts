import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { fakeVault, REPO_ROOT, read } from "../../test/helpers/security-invariants.ts";
import { CONNECTOR_SERVICE_IDS } from "../connectors/connector-catalog.ts";
import { createConnectorWriteDispatcher } from "../connectors/connector-write-dispatch.ts";
import { CONNECTOR_WRITES } from "../connectors/connector-write-registry.ts";
import {
  type ConnectorWriteContext,
  invokeConnectorWrite,
} from "../connectors/connector-write-transport.ts";
import {
  type LazyMeshToolMap,
  mcpClientToolKey,
  resolveServerTool,
} from "../connectors/lazy-mesh/tool-map.ts";
import { createConnectorDispatcher } from "../connectors/registry.ts";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { connectorAllowPredicate } from "../policy/connector-allowlist.ts";
import { type LocalBaseline, PolicyGate } from "../policy/policy-gate.ts";
import { refreshPolicy } from "../policy/policy-runtime.ts";
import { signPolicy } from "../policy/policy-signing.ts";
import { PolicyStore } from "../policy/policy-store.ts";
import { __setSessionSpawnerForTest } from "../teamvault/connector-session.ts";
import { spawnTeamToolAndCall, spawnTeamWriteAndCall } from "../teamvault/team-tool-spawn.ts";
import { encodeBase64 } from "../util/base64.ts";
import { generateEd25519Keypair } from "../util/ed25519.ts";

describe("I22 — org policy applied only from a signature-verified bundle, monotonic-stricter", () => {
  const baseline: LocalBaseline = {
    retentionDays: 7,
    hitlRequired: new Set(["git.force_push_main"]),
    quorum: new Map(),
    capabilitiesDisabled: new Set(),
  };

  function gateWith(toml: string, sig: string, pubkeyB64: string): PolicyGate {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 36);
    const store = new PolicyStore(db);
    store.pinAnchorPubkey(pubkeyB64, "manual", 1);
    store.persist({ toml, sig, org: "acme", version: 1, source: "peer", fetchedAt: 1 });
    return new PolicyGate(store, baseline);
  }

  // The ai_v2 capability lockoff rides on I22's enforced view, so it needs I22's coverage too.
  test("(cap-1) a SIGNATURE-VERIFIED policy disabling code_execution reaches EnforcedPolicy", () => {
    const kp = generateEd25519Keypair();
    const toml = `[policy]
version=1
org="acme"
[policy.capabilities.ai_v2]
code_execution=false
`;
    const gate = gateWith(
      toml,
      signPolicy(toml, encodeBase64(kp.privkey)),
      encodeBase64(kp.pubkey),
    );
    expect(gate.enforced().capabilitiesDisabled.has("code_execution")).toBe(true);
  });

  test("(cap-2) a TAMPERED policy cannot disable a capability", () => {
    // Same signature, body flipped. Rejected wholesale, so the gate falls back to the baseline
    // rather than honouring any value the forged body carried.
    const kp = generateEd25519Keypair();
    const good = `[policy]
version=1
org="acme"
[policy.capabilities.ai_v2]
code_execution=false
`;
    const sig = signPolicy(good, encodeBase64(kp.privkey));
    const forged = good.replace("version=1", "version=2");
    const gate = gateWith(forged, sig, encodeBase64(kp.pubkey));
    expect(gate.enforced().capabilitiesDisabled.has("code_execution")).toBe(false);
  });

  test("(cap-3) a capability disabled in the LOCAL baseline survives any policy", () => {
    // Resolution is a union, so no value a policy can carry removes an entry -- including a validly
    // signed `= true`, which parses to "disables nothing" rather than to a grant.
    const kp = generateEd25519Keypair();
    const toml = `[policy]
version=1
org="acme"
[policy.capabilities.ai_v2]
code_execution=true
`;
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 36);
    const store = new PolicyStore(db);
    store.pinAnchorPubkey(encodeBase64(kp.pubkey), "manual", 1);
    store.persist({
      toml,
      sig: signPolicy(toml, encodeBase64(kp.privkey)),
      org: "acme",
      version: 1,
      source: "peer",
      fetchedAt: 1,
    });
    const locked = new PolicyGate(store, {
      ...baseline,
      capabilitiesDisabled: new Set(["code_execution"]),
    });
    expect(locked.enforced().capabilitiesDisabled.has("code_execution")).toBe(true);
  });

  test("(cap-5) connector_write_model_access is an ai_v2 capability and its accessor fails closed", async () => {
    const { AI_V2_CAPABILITIES } = await import("../policy/types.ts");
    const { isConnectorWriteModelAccessEnabled } = await import(
      "../connectors/connector-writes/model-write-capability.ts"
    );
    expect([...AI_V2_CAPABILITIES]).toContain("connector_write_model_access");
    expect(isConnectorWriteModelAccessEnabled(undefined)).toBe(false);
    expect(
      isConnectorWriteModelAccessEnabled({
        capabilitiesDisabled: new Set(["connector_write_model_access"]),
      }),
    ).toBe(false);
    expect(isConnectorWriteModelAccessEnabled({ capabilitiesDisabled: new Set() })).toBe(true);
  });

  test("(cap-4) a signed user_mcp_model_access lockoff empties the model's user-MCP tool source", async () => {
    // The seventh ai_v2 name. Driven end to end over a REAL signed policy and a REAL migrated
    // user_mcp_connector table: a `--model` server that IS listed under an ungoverned gate is NOT
    // listed once the verified policy disables the capability (I42's org-policy lock-off).
    const { listPolicyGatedModelAccessibleUserMcpIds } = await import(
      "../connectors/user-mcp-model-capability.ts"
    );
    const { insertUserMcpConnector } = await import("../connectors/user-mcp-store.ts");
    const index = new Database(":memory:");
    LocalIndex.ensureSchema(index);
    insertUserMcpConnector(index, {
      service_id: "mcp_notes",
      command: "bun",
      args_json: "[]",
      read_paths_json: "[]",
      net_hosts_json: "[]",
      model_access: 1,
    });
    const kp = generateEd25519Keypair();
    const pub = encodeBase64(kp.pubkey);
    const allowToml = `[policy]\nversion=1\norg="acme"\n`;
    const allow = gateWith(allowToml, signPolicy(allowToml, encodeBase64(kp.privkey)), pub);
    // Non-vacuity: the same server IS offered when the policy does not lock it off.
    expect(listPolicyGatedModelAccessibleUserMcpIds(index, allow.enforced())).toEqual([
      "mcp_notes",
    ]);
    const lockToml = `[policy]\nversion=1\norg="acme"\n[policy.capabilities.ai_v2]\nuser_mcp_model_access=false\n`;
    const lock = gateWith(lockToml, signPolicy(lockToml, encodeBase64(kp.privkey)), pub);
    expect(lock.enforced().capabilitiesDisabled.has("user_mcp_model_access")).toBe(true);
    expect(listPolicyGatedModelAccessibleUserMcpIds(index, lock.enforced())).toEqual([]);
    // The same signed lock-off empties the extension half of the engine agent's source too (one
    // shared switch). Non-vacuity again: the extension IS listed under the allowing policy.
    const { listPolicyGatedModelAccessibleOwnerCodeServerIds } = await import(
      "../connectors/user-mcp-model-capability.ts"
    );
    const { insertExtensionRow, setExtensionTreeDigest } = await import(
      "../automation/extension-store.ts"
    );
    const { upsertRunGrant } = await import("../extensions/run-grant-store.ts");
    insertExtensionRow(index, {
      id: "com.example.notes",
      version: "1.0.0",
      install_path: "/x",
      manifest_hash: "m",
      entry_hash: "e",
      installed_at: 1,
      last_verified_at: 1,
    });
    setExtensionTreeDigest(index, "com.example.notes", "d".repeat(64));
    upsertRunGrant(index, {
      extension_id: "com.example.notes",
      service_id: "ext_com_example_notes",
      version: "1.0.0",
      tree_digest: "d".repeat(64),
      permissions_json: '{"network":[],"read":[],"write":[]}',
      model_access: 1,
      approved_at: 1,
      credentials_json: "{}",
    });
    expect(
      listPolicyGatedModelAccessibleOwnerCodeServerIds(index, allow.enforced(), () => false),
    ).toEqual(["mcp_notes", "ext_com_example_notes"]);
    expect(
      listPolicyGatedModelAccessibleOwnerCodeServerIds(index, lock.enforced(), () => false),
    ).toEqual([]);
    index.close();
  });

  test("(a) a tampered policy is rejected; the gate stays ungoverned (falls back to baseline)", () => {
    const kp = generateEd25519Keypair();
    const good = `[policy]\nversion=1\norg="acme"\n[policy.retention]\nmin_days=30\n`;
    const sig = signPolicy(good, encodeBase64(kp.privkey));
    const tampered = good.replace("min_days=30", "min_days=99");
    const gate = gateWith(tampered, sig, encodeBase64(kp.pubkey));
    expect(gate.status().signatureValid).toBe(false);
    expect(gate.enforced().retentionDays).toBe(7); // baseline, NOT 99
  });

  test("(c) every production ToolExecutor is handed a policy overlay — none defaults silently", async () => {
    // I22's resolution has always been correct and, until 2026-08-16, entirely unread:
    // `EnforcedPolicy.hitlRequired` was computed as a monotonic union and `isHitlRequiredByPolicy`
    // existed to read it, with ZERO production callers. An admin could sign
    // `[policy.hitl] require = [...]`, watch it verify, and get no gate — the B1
    // "defined but never wired" shape, on a documented invariant.
    //
    // Now that `gate()` consults it, the risk moves to partial wiring: one executor built without
    // the overlay is a hole that looks exactly like the rest of the system working. So this pins
    // that EVERY production construction site states its choice — the real overlay, or the named
    // `NO_POLICY_OVERLAY`. Same reason `NULL_EGRESS_SINK` is named rather than `undefined` (I29):
    // a site that simply forgot should be visible, not defaulted.
    const root = resolve(REPO_ROOT, "packages/gateway/src");
    const sites: { file: string; args: string }[] = [];
    for (const f of await readdir(root, { recursive: true })) {
      const rel = `packages/gateway/src/${f.replaceAll("\\", "/")}`;
      if (!rel.endsWith(".ts") || rel.endsWith(".test.ts")) continue;
      // Comments stripped first. Without it the sweep matches `executor.ts`'s own doc comment,
      // which SAYS `new ToolExecutor(...)` while explaining this very rule — a source-scanning
      // guard reporting on prose about itself. (It did, on the first run.)
      const src = stripComments(await readFile(resolve(REPO_ROOT, rel), "utf8"));
      let at = src.indexOf("new ToolExecutor(");
      while (at !== -1) {
        // Balanced scan: the argument list routinely contains nested calls such as
        // `makeEgressSink(index.getDatabase())`, which a non-nesting regex truncates.
        let depth = 0;
        let end = at + "new ToolExecutor".length;
        for (; end < src.length; end++) {
          const c = src[end];
          if (c === "(") depth++;
          else if (c === ")") {
            depth--;
            if (depth === 0) break;
          }
        }
        sites.push({ file: rel, args: src.slice(at, end + 1) });
        at = src.indexOf("new ToolExecutor(", end);
      }
    }

    // Non-vacuity: an empty sweep satisfies the filter below just as well as full compliance.
    expect(sites.length).toBeGreaterThanOrEqual(11);

    const unwired = sites
      .filter((s) => !/NO_POLICY_OVERLAY|policyHitl|isHitlRequiredByPolicy/.test(s.args))
      .map((s) => s.file);
    expect(unwired).toEqual([]);
  });

  test("(d) gate() ORs the overlay with the frozen set — it can add, never replace", async () => {
    // The behavioural proof lives in engine/executor-policy-hitl.test.ts. This is the shape
    // assertion that catches the refactor that would invert it: an `&&`, a ternary, or an
    // assignment would each turn a tighten-only ratchet into something a policy can loosen, which
    // is precisely what I2 says must be impossible.
    const src = await read("packages/gateway/src/engine/executor.ts");
    // I42's user-MCP floor sits between the two operands (also an OR), so the policy overlay is
    // still the LAST disjunct and never the only one.
    expect(src).toMatch(
      /const requiresHITL =\s*HITL_REQUIRED\.has\(action\.type\)\s*\|\|\s*isUserMcpActionType\(action\.type\)\s*\|\|\s*this\.requiredByPolicy\(action\.type\);/,
    );
  });

  test("(b) a valid policy below baseline cannot weaken HITL/quorum/retention", () => {
    const kp = generateEd25519Keypair();
    const toml = `[policy]\nversion=1\norg="acme"\n[policy.retention]\nmin_days=3\n[policy.hitl]\nrequire=[]\n`;
    const gate = gateWith(
      toml,
      signPolicy(toml, encodeBase64(kp.privkey)),
      encodeBase64(kp.pubkey),
    );
    expect(gate.enforced().retentionDays).toBe(7);
    expect(gate.enforced().hitlRequired.has("git.force_push_main")).toBe(true);
  });

  test("I22: multimodal_input is enforced, not merely listed", async () => {
    // Through PR 1 this capability was a real AI_V2_CAPABILITIES member whose lockoff did
    // nothing, because the dispatcher hardcoded `capabilityDisabled: false`. Every member but
    // the config-forward `local_finetuning` must now reach a gate (`user_mcp_model_access`'s is
    // pinned by `(cap-4)` above and the I42 block).
    // `read()`, not a bare relative `Bun.file("packages/...")`: CI's coverage job `cd`s into
    // `packages/gateway` before running `bun test`, so a cwd-relative path ENOENTs there while
    // resolving fine from the repo root. That is why this helper exists.
    const dispatchers = await read("packages/gateway/src/ipc/server/dispatchers.ts");
    expect(dispatchers).toContain("capabilitiesDisabled.has(MULTIMODAL_CAPABILITY)");
    const assemble = await read("packages/gateway/src/platform/assemble.ts");
    expect(assemble).toContain("ipcOpts.mediaRpcCtx");
  });

  // The connector allowlist (`EnforcedPolicy.connectorAllow`) OFF the mesh. The mesh drops a
  // blocked connector's tools from its own dispatcher map, but the connector-write transport spawns
  // its OWN session, so it checks the allowlist itself: (e) drives the predicate the gateway builds
  // on a real policy gate, (f) pins that the gateway hands the transport exactly that predicate,
  // (g) that the transport consults it before anything else. (h)/(i) pin what lets that
  // per-connector check cover the tool that RUNS: a bare tool id resolves only on the caller's own
  // server, never on a sibling server the same client carries.

  test("(e) the gateway's allowlist predicate decides from the policy gate's CURRENT policy", async () => {
    // `connectorAllowPredicate` is the decision every `connectorAllow` consumer is handed: the
    // mesh's tool filter, sync registration, the admin status report and the write transport.
    // Each consumer's own tests inject a predicate of their own, so without this case a decision
    // that inverted its membership test, ignored the list or captured it once would pass the whole
    // suite. Driven on a REAL gate, through the real apply path (`refreshPolicy`: verify, persist,
    // `applyVerified`); (f) pins that assemble.ts builds its predicate from this helper.
    const kp = generateEd25519Keypair();
    const pubkey = encodeBase64(kp.pubkey);
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 36);
    const store = new PolicyStore(db);
    store.pinAnchorPubkey(pubkey, "manual", 1);
    const gate = new PolicyGate(store, baseline);
    const ids = [...CONNECTOR_SERVICE_IDS];
    // Premise: the sibling server the bundle below leaves out is a catalogued connector.
    expect(ids).toContain("github_actions");
    const isConnectorAllowed = connectorAllowPredicate(gate);
    const allowedBy = (predicate: (serviceId: string) => boolean) =>
      ids.filter((id) => predicate(id));
    const apply = async (version: number, allow: string) => {
      const toml = `[policy]\nversion=${version}\norg="acme"\n[policy.connectors]\nallow=${allow}\n`;
      const out = await refreshPolicy({
        store,
        gate,
        pinnedPubkey: pubkey,
        nowMs: version,
        fetch: async () => ({ toml, sig: signPolicy(toml, encodeBase64(kp.privkey)) }),
      });
      expect(out.applied).toBe(true);
    };

    // 1. Ungoverned: no allowlist, so every catalogued connector is allowed.
    expect(allowedBy(isConnectorAllowed)).toEqual(ids);

    // 2. A signed allowlist naming only github, applied AFTER the predicate was built: github is
    //    the one connector allowed, its sibling server github_actions refused with the rest.
    await apply(1, `["github"]`);
    expect(allowedBy(isConnectorAllowed)).toEqual(["github"]);

    // 3. A later bundle without github: the SAME predicate refuses it on its next call.
    await apply(2, `["slack"]`);
    expect(allowedBy(isConnectorAllowed)).toEqual(["slack"]);

    // 4. A restart rehydrates the last-valid bundle, and a predicate built at boot agrees.
    expect(allowedBy(connectorAllowPredicate(new PolicyGate(store, baseline)))).toEqual(["slack"]);
  });

  test("(f) assemble.ts hands the write transport the policy gate's own allowlist, read per call", async () => {
    // The transport's own tests drive an INJECTED predicate, so they would pass just as well if
    // the gateway injected `() => true`. This pins the link they cannot see, from the policy gate
    // through the team-credential contexts and `PlatformServices` to the dispatcher the gateway
    // installs. Comments stripped: every pattern below is about code, never prose.
    const src = stripComments(await read("packages/gateway/src/platform/assemble.ts"));
    const bodyOf = (signature: string): string => {
      const at = src.indexOf(signature);
      expect(at, signature).toBeGreaterThan(-1);
      return src.slice(at, src.indexOf("\n}\n", at));
    };

    // 1. The predicate is `connectorAllowPredicate` over the gate this function built: the
    //    decision (e) drives, which reads `policyGate.enforced()` on every call. The value this
    //    function captures at boot for its audit rows (`enforcedConnectorAllow`) never changes.
    //    The helper is imported and named nowhere else, so no local copy can stand in for it.
    const boot = bodyOf("function bootPolicyGateWithConnectorAllowlist(");
    expect(boot).toContain(
      "return { policyStore, policyGate, isConnectorAllowed: connectorAllowPredicate(policyGate) };",
    );
    const imported = src.match(/import \{([^}]*)\} from "\.\.\/policy\/connector-allowlist\.ts";/);
    expect(imported?.[1]?.split(",").map((name) => name.trim())).toContain(
      "connectorAllowPredicate",
    );
    expect(src.match(/\bconnectorAllowPredicate\b/g)).toHaveLength(2);

    // 2. Booted ONCE, before the one construction of the team-credential contexts, which is handed
    //    that predicate.
    const booted =
      "const { policyStore, policyGate, isConnectorAllowed } = bootPolicyGateWithConnectorAllowlist(";
    expect(src.split(booted)).toHaveLength(2);
    const calls = [...src.matchAll(/(?<!function )buildTeamCredentialContexts\(/g)];
    expect(calls).toHaveLength(1);
    const callAt = calls[0]?.index ?? -1;
    expect(src.indexOf(booted)).toBeLessThan(callAt);
    expect(src.slice(callAt, src.indexOf("});", callAt))).toMatch(/\n\s*isConnectorAllowed,\n/);

    // 3. Inside, the transport's context carries the predicate it was handed, not a stand-in.
    const contexts = bodyOf("function buildTeamCredentialContexts(");
    expect(contexts).toMatch(/const \{[^}]*\bisConnectorAllowed\b[^}]*\} = deps;/);
    const literalAt = contexts.indexOf("const connectorWriteDeps: ConnectorWriteContext = {");
    expect(literalAt).toBeGreaterThan(-1);
    expect(contexts.slice(literalAt, contexts.indexOf("\n  };", literalAt))).toMatch(
      /\n\s*isConnectorAllowed,\n/,
    );

    // 4. That context leaves assembly as `PlatformServices.connectorWriteDeps`, unchanged: the
    //    services literal carries the binding itself, and `assemblePlatformServices` names it only
    //    at its destructuring, the ChatOps boot (pinned by (j)) and that literal, with no widened
    //    copy and no later reassignment. The gateway then wraps its executor's dispatcher in the
    //    write transport with exactly it.
    const assembly = bodyOf("export async function assemblePlatformServices(");
    expect(assembly).toContain("return services;");
    const servicesAt = assembly.indexOf("const services: PlatformServices = {");
    expect(servicesAt).toBeGreaterThan(-1);
    expect(assembly.slice(servicesAt, assembly.indexOf("\n  };", servicesAt))).toMatch(
      /\n\s*connectorWriteDeps,\n/,
    );
    // The destructuring from `buildTeamCredentialContexts`, the ChatOps boot (see (j)), the
    // services literal, the I28 act door's dispatcher inside the `captureRpcCtx.act` wiring, and —
    // the fifth — that wiring's typed-preview credential READ (`previewCredentialResolver`, which reads
    // `.credentialFor(s).credential` and adds the GitHub Enterprise Server instance, no copy of the context), both pinned exactly just below: five.
    expect(assembly.match(/\bconnectorWriteDeps\b/g)).toHaveLength(5);
    const captureAt = assembly.indexOf("ipcOpts.captureRpcCtx = {");
    expect(captureAt).toBeGreaterThan(-1);
    const captureCtx = assembly.slice(captureAt, assembly.indexOf("\n  };", captureAt));
    const actAt = captureCtx.indexOf("act: {");
    expect(actAt).toBeGreaterThan(-1);
    expect(captureCtx.slice(actAt)).toMatch(
      /^act: \{\s*dispatcher: createConnectorWriteDispatcher\(\s*createConnectorDispatcher\(meshDispatcherClient\(connectorMesh\)\),\s*connectorWriteDeps,?\s*\),/,
    );
    expect(captureCtx.match(/\bconnectorWriteDeps\b/g)).toHaveLength(2);
    expect(captureCtx).toContain(
      "previewCredentialFor: previewCredentialResolver(connectorWriteDeps, connectorMesh),",
    );
    const main = stripComments(await read("packages/gateway/src/gateway-main.ts"));
    expect(main).toMatch(
      /createConnectorWriteDispatcher\(\s*createConnectorDispatcher\(dispatcherClient\),\s*platform\.connectorWriteDeps,?\s*\)/,
    );
  });

  test("(j) the federated invoke gate and the ChatOps executor get that same allowlist and transport", async () => {
    // Two more off-mesh doors, each pinned from the boot predicate to its consumer. The invoke gate's
    // own tests drive an injected predicate, and the ChatOps boot takes its dispatcher as a dep, so
    // neither would notice a stand-in here. Comments stripped: every pattern below is about code.
    const src = stripComments(await read("packages/gateway/src/platform/assemble.ts"));
    const bodyOf = (signature: string): string => {
      const at = src.indexOf(signature);
      expect(at, signature).toBeGreaterThan(-1);
      return src.slice(at, src.indexOf("\n}\n", at));
    };
    const onlyCall = (name: string): string => {
      const calls = [...src.matchAll(new RegExp(`(?<!function )${name}\\(`, "g"))];
      expect(calls, name).toHaveLength(1);
      const at = calls[0]?.index ?? -1;
      return src.slice(at, src.indexOf("});", at));
    };

    // 1. Federation: the boot predicate itself reaches the anchor's team-vault backing, which
    //    `federation.invoke` hands to `answerFederatedInvoke`.
    expect(onlyCall("bootFederationIntoIpcOpts")).toMatch(/\n\s*isConnectorAllowed,\n/);
    const federation = bodyOf("async function bootFederationIntoIpcOpts(");
    expect(federation).toMatch(/const \{[^}]*\bisConnectorAllowed\b[^}]*\} = opts;/);
    const teamVaultAt = federation.indexOf("const teamVault = {");
    expect(teamVaultAt).toBeGreaterThan(-1);
    // The literal's last field ends the slice, so the shorthand need not be followed by a newline.
    expect(federation.slice(teamVaultAt, federation.indexOf("\n  };", teamVaultAt))).toMatch(
      /\n\s*isConnectorAllowed,(?:\n|$)/,
    );
    const rpc = stripComments(await read("packages/gateway/src/ipc/federation-rpc.ts"));
    expect(rpc).toMatch(
      /answerFederatedInvoke\([\s\S]*?isConnectorAllowed: tv\.isConnectorAllowed,/,
    );

    // 2. ChatOps: the executor's real dispatcher is wrapped in the write transport with the one
    //    `connectorWriteDeps`, exactly as `runAsk`'s is in gateway-main.ts, so an owner-approved write
    //    from chat selects its configured credential and asks the allowlist first.
    expect(onlyCall("bootChatopsIntoAssembly")).toMatch(/\n\s*connectorWriteDeps,\n/);
    const chatops = bodyOf("async function bootChatopsIntoAssembly(");
    expect(chatops).toMatch(/const \{[^}]*\bconnectorWriteDeps\b[^}]*\} = deps;/);
    expect(chatops).toMatch(
      /dispatcher:\s*chatopsE2eSinkDir === undefined \|\| chatopsE2eSinkDir === ""\s*\?\s*createConnectorWriteDispatcher\(\s*createConnectorDispatcher\(meshDispatcherClient\(connectorMesh\)\),\s*connectorWriteDeps,?\s*\)/,
    );
  });

  test("(g) the write transport refuses a blocked connector BEFORE it selects a credential", async () => {
    // Every dispatchable connector write, through the wrapper the gateway installs around the
    // executor's dispatcher. A blocked connector must reach neither credential selection
    // (`credentialFor`), nor the team hand-off, nor a spawn, whichever credential it is pinned to.
    const services = CONNECTOR_WRITES.map((w) => w.service);
    const listedKeys = CONNECTOR_WRITES.map((w) => mcpClientToolKey(w.service, w.toolId));
    const spawned: string[] = [];
    const ran: string[] = [];

    const runEveryWrite = async (allowed: boolean, credential: "personal" | "team") => {
      const seen = {
        asked: [] as string[],
        selected: [] as string[],
        handedOff: [] as string[],
        refused: 0,
        fellThrough: 0,
      };
      spawned.length = 0;
      ran.length = 0;
      const dispatcher = createConnectorWriteDispatcher(
        {
          dispatch: async () => {
            seen.fellThrough++;
            return {};
          },
        },
        {
          vault: fakeVault(),
          sandboxCwd: "/tmp",
          isConnectorAllowed: (service) => {
            seen.asked.push(service);
            return allowed;
          },
          credentialFor: (service) => {
            seen.selected.push(service);
            return credential === "team" ? { credential, teamEntry: "e" } : { credential };
          },
          runTeamInvoke: async (req) => {
            seen.handedOff.push(req.toolId);
            return {};
          },
        },
      );
      for (const w of CONNECTOR_WRITES) {
        try {
          await dispatcher.dispatch({ type: w.actionType, payload: {} });
        } catch (err) {
          expect(String(err)).toContain(
            `connectors.${w.service}: blocked by the org policy's connector allowlist (I22)`,
          );
          seen.refused++;
        }
      }
      return seen;
    };

    try {
      // Each session is served what a real one lists: every write, keyed `<server>_<tool>`.
      __setSessionSpawnerForTest((req) => {
        spawned.push(req.service);
        const listing: LazyMeshToolMap = {};
        for (const key of listedKeys) listing[key] = { execute: async () => void ran.push(key) };
        return { listTools: async () => listing, disconnect: async () => {} };
      });
      for (const credential of ["personal", "team"] as const) {
        const blocked = await runEveryWrite(false, credential);
        expect(blocked.asked).toEqual(services);
        expect(blocked.refused).toBe(CONNECTOR_WRITES.length);
        // Nothing past the check: no credential selected, no team hand-off, no process, no tool.
        expect(blocked.selected).toEqual([]);
        expect(blocked.handedOff).toEqual([]);
        expect(spawned).toEqual([]);
        expect(ran).toEqual([]);
        expect(blocked.fellThrough).toBe(0);

        // Control: allowed, the same writes DO select a credential and run, so the empty lists
        // above are the check's doing rather than a dispatcher that never got that far.
        const allowed = await runEveryWrite(true, credential);
        expect(allowed.refused).toBe(0);
        expect(allowed.selected).toEqual(services);
        expect(allowed.handedOff).toEqual(
          credential === "team" ? CONNECTOR_WRITES.map((w) => w.toolId) : [],
        );
        expect(spawned).toEqual(credential === "team" ? [] : services);
        expect(ran).toEqual(credential === "team" ? [] : listedKeys);
      }
    } finally {
      __setSessionSpawnerForTest(undefined);
    }
  });

  test("(h) a bare tool id never resolves onto a sibling server the same client carries", () => {
    // `MCPClient.listTools()` keys a tool `<server>_<tool>`, and one first-party server name can
    // extend another: the github spawner registers `github` AND `github_actions` in ONE client, so
    // `github_` + `actions_<tool>` spells github_actions' key exactly. The pairs are derived from
    // the catalogue, not listed, so a nested pair added later is covered the day it lands.
    const ids = [...CONNECTOR_SERVICE_IDS];
    const nested = ids.flatMap((outer) =>
      ids.filter((inner) => inner.startsWith(`${outer}_`)).map((inner) => [outer, inner] as const),
    );
    expect(nested).toContainEqual(["github", "github_actions"]);
    for (const [outer, inner] of nested) {
      const own = mcpClientToolKey(outer, "own_tool");
      const sibling = mcpClientToolKey(inner, "sibling_tool");
      const tools: LazyMeshToolMap = { [own]: {}, [sibling]: {} };
      // Premise: prefixed with the caller's server name, this bare id IS the sibling's listed key.
      const spelling = `${inner.slice(outer.length + 1)}_sibling_tool`;
      expect(mcpClientToolKey(outer, spelling)).toBe(sibling);
      expect(resolveServerTool(tools, outer, spelling), `${outer} <- ${spelling}`).toBeUndefined();
      // Controls: each server's own tool resolves by its bare id, the sibling's on ITS server.
      expect(resolveServerTool(tools, outer, "own_tool")).toBe(tools[own]);
      expect(resolveServerTool(tools, inner, "sibling_tool")).toBe(tools[sibling]);
    }
  });

  test("(i) every seam that resolves a bare id runs the NAMED connector's tool, so a blocked sibling stays blocked", async () => {
    // The github spawner's client as a real session lists it, and an org policy that allows
    // `github` but blocks `github_actions`. The write transport checks the connector it is ASKED
    // for, so the blocked tool, named as a bare id on the allowed server, must find nothing.
    const ran: string[] = [];
    const listing: LazyMeshToolMap = {};
    for (const [server, name] of [
      ["github", "github_pr_list"],
      ["github_actions", "gha_run_trigger"],
    ] as const) {
      const key = mcpClientToolKey(server, name);
      listing[key] = { execute: async () => void ran.push(key) };
    }
    const ctx: ConnectorWriteContext = {
      vault: fakeVault(),
      sandboxCwd: "/tmp",
      isConnectorAllowed: (service) => service !== "github_actions",
      credentialFor: () => ({ credential: "personal" }),
      runTeamInvoke: () => Promise.reject(new Error("not the team path")),
    };
    const personalWrite = (writeToolId: string) =>
      invokeConnectorWrite(ctx, { service: "github", writeToolId, args: {} });
    // The team-credentialed local write's seam (`localOpInvokeCtx` in assemble.ts).
    const teamWrite = (toolId: string) =>
      spawnTeamWriteAndCall({
        service: "github",
        toolId,
        args: {},
        vaultView: fakeVault(),
        sandboxCwd: "/tmp",
      });
    // The mesh dispatcher resolves a bare `mcpToolId` on the service of the action's type. The
    // mesh's own map is policy-filtered before it gets there, so for it the rule is what keeps a
    // bare id on the connector of the action even when both are allowed; same listing here.
    const mesh = createConnectorDispatcher({ listTools: async () => listing });
    const meshRun = (type: string, mcpToolId: string) =>
      mesh.dispatch({ type, payload: { mcpToolId } });

    try {
      __setSessionSpawnerForTest(() => ({
        listTools: async () => listing,
        disconnect: async () => {},
      }));
      // Premise: asked for by its own connector, the blocked tool never gets past the policy.
      await expect(
        invokeConnectorWrite(ctx, {
          service: "github_actions",
          writeToolId: "gha_run_trigger",
          args: {},
        }),
      ).rejects.toThrow("blocked by the org policy's connector allowlist (I22)");

      // The same tool spelled as a bare id on the ALLOWED server: the policy check passes, and
      // the lookup refuses the key, because a longer sibling server owns it.
      const spelling = "actions_gha_run_trigger";
      const miss = `connector-session: tool "${spelling}" not found for service "github"`;
      await expect(personalWrite(spelling)).rejects.toThrow(miss);
      await expect(teamWrite(spelling)).rejects.toThrow(miss);
      await expect(meshRun("github.workflow.run", spelling)).rejects.toThrow("Tool not found");
      expect(ran).toEqual([]);

      // Controls: each seam runs the named connector's own tool by its bare id.
      await personalWrite("github_pr_list");
      await teamWrite("github_pr_list");
      await meshRun("github.pr.list", "github_pr_list");
      expect(ran).toEqual([
        "github_github_pr_list",
        "github_github_pr_list",
        "github_github_pr_list",
      ]);

      // The one seam that must NOT resolve: the federated anchor's, whose id a grant was made on.
      // A bare id names nothing there; only the exact listed key runs.
      ran.length = 0;
      const federated = (toolId: string) =>
        spawnTeamToolAndCall({
          service: "github",
          toolId,
          args: {},
          vaultView: fakeVault(),
          sandboxCwd: "/tmp",
        });
      await expect(federated("github_pr_list")).rejects.toThrow(
        'connector-session: tool "github_pr_list" not found for service "github"',
      );
      await federated("github_github_pr_list");
      expect(ran).toEqual(["github_github_pr_list"]);
    } finally {
      __setSessionSpawnerForTest(undefined);
    }
  });
});
