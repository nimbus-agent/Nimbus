import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NimbusFleetJobToml } from "../config/fleet-toml.ts";
import { egressSourceTypeForClientKind } from "../egress/egress-bearing-kinds.ts";
import { buildFleetInvoker } from "../fleet/fleet-invoker.ts";
import {
  createFleetRemoteBudget,
  FleetRemoteRefusedError,
  wrapFleetSynthesisRouter,
} from "../fleet/fleet-synthesis-router.ts";
import { LocalIndex } from "../index/local-index.ts";
import { dispatchAgentsRpc } from "../ipc/agents-rpc.ts";
import { ClientKindStore } from "../ipc/server/client-kind.ts";
import type { ResolvedSynthesisProvider } from "../llm/router.ts";

/**
 * I38 — an unattended fleet run reaches a NON-LOCAL model only when `[fleet] allow_remote` is true
 * AND the run's remaining call budget covers it.
 *
 * THE GUARD THAT ALMOST MADE THIS BLOCK VACUOUS. At the DEFAULT `[agents] synthesis = "local"`,
 * `agents/_lib/synthesis-llm.ts` refuses a resolved REMOTE provider on its own, before the fleet
 * wrapper is relevant at all — so "no remote call happened" holds for a reason that has nothing to
 * do with I38, and the wiring test below would pass identically with the wrapper deleted. Every
 * test here that could be answered by an unrelated guard opens that guard deliberately: the wiring
 * test writes `synthesis = "allow-remote"` into its own config dir AND uses a NON-LOCAL provider,
 * so the fleet wrapper is the only thing left standing between the run and the model.
 */
describe("I38 — an unattended fleet run reaches a non-local model only under grant + budget", () => {
  const REMOTE_PROVIDER: ResolvedSynthesisProvider = {
    providerId: "anthropic",
    modelName: "opus",
    isLocal: false,
  };

  const FLEET_JOB: NimbusFleetJobToml = {
    name: "nightly-catchup",
    agent: "catchup",
    intervalSeconds: 1,
    params: {},
    digestMinDelta: 1,
    sweep: null,
  };

  /**
   * THE LOAD-BEARING TEST: it exercises the production WIRING, not the wrapper in isolation.
   * `fleet/fleet-invoker.ts` is the single place a fleet job's `SynthesisRunner` is built, and it
   * must build it with the WRAPPED router. Red-proved by substituting `deps.router` for
   * `wrapFleetSynthesisRouter(deps.router, deps.budget)` there: `generate` becomes 1 and the
   * attempt becomes `{ ok: true, ..., remote: true }`.
   *
   * Three conditions have to hold together or the assertion proves nothing:
   *   * `[agents] synthesis` must be "allow-remote" — under the DEFAULT "local", `synthesis-llm.ts`
   *     refuses the remote provider itself and `generate` stays 0 with the raw router too;
   *   * the resolved provider must be NON-LOCAL — the wrapper passes a local one through untouched
   *     (locality is I34's `provider.isLocal`, derived, never a vendor id);
   *   * the router must be reached THROUGH `ctx.runner`, which is what proves the wrap sits on the
   *     live path rather than on a copy the invoker kept to itself.
   */
  test("WIRING: the fleet invoker builds its runner with the WRAPPED router — no remote generate", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "nimbus-i38-"));
    writeFileSync(join(configDir, "nimbus.toml"), `[agents]\nsynthesis = "allow-remote"\n`, "utf8");
    try {
      const counts = { resolve: 0, generate: 0 };
      const db = new Database(":memory:");
      let attempt: unknown;
      const invoke = buildFleetInvoker({
        db,
        router: {
          resolveForSynthesis: async () => {
            counts.resolve += 1;
            return REMOTE_PROVIDER;
          },
          generateMarkdown: async () => {
            counts.generate += 1;
            return "a synthesized brief";
          },
        },
        // The grant half of I38: `[fleet] allow_remote` is false, so nothing may go out.
        budget: createFleetRemoteBudget(false, 0),
        index: new LocalIndex(db),
        configDir,
        timeoutMs: 30_000,
        dispatch: async (_m, _p, ctx) => {
          attempt = await ctx.runner?.run("summarise this brief");
          ctx.notify("catchup.briefReady", { sessionId: "s1", brief: "x", findings: {} });
          return { sessionId: "s1" };
        },
      });
      expect((await invoke(FLEET_JOB)).status).toBe("done");
      // Resolution HAPPENED — the run really did reach the router; it is the remote generate that
      // did not. Without this, `generate === 0` would also pass for a runner that never ran.
      expect(counts.resolve).toBeGreaterThan(0);
      expect(counts.generate).toBe(0);
      // Degrades exactly as `[agents] synthesis = "off"` would: the deterministic render, not an
      // error and not a downgrade nobody was told about.
      expect(attempt).toEqual({ ok: false, reason: "no_eligible_provider" });
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("without allow_remote, a remote provider is withheld AND refused (both doors)", async () => {
    const budget = createFleetRemoteBudget(false, 0);
    let generated = false;
    const wrapped = wrapFleetSynthesisRouter(
      {
        resolveForSynthesis: async () => REMOTE_PROVIDER,
        generateMarkdown: async () => {
          generated = true;
          return "should not happen";
        },
      },
      budget,
    );
    // Door 1 — the normal path: the provider is withheld, so the runner falls back.
    expect(await wrapped.resolveForSynthesis(true)).toBeUndefined();
    // Door 2 — a caller that obtained a remote provider some other way is refused outright.
    // Guarding only door 1 is the "fixing one door and leaving the adjacent one open" shape.
    await expect(wrapped.generateMarkdown("p", REMOTE_PROVIDER)).rejects.toThrow(/allow_remote/);
    expect(generated).toBe(false);
  });

  test("a frontier key enabled for interactive use does not itself grant the fleet anything", () => {
    // The capability belongs to `[fleet] allow_remote` alone — the same shape as I37's per-artifact
    // grant, where an `[llm.remote.<vendor>]` key that works for `nimbus ask` grants no vision.
    // A generous budget with the grant absent is still zero: the cap is CLAMPED at construction,
    // never merely consulted later, so no call site can spend against it by forgetting to ask.
    expect(createFleetRemoteBudget(false, 100).remaining()).toBe(0);
    expect(createFleetRemoteBudget(false, 100).consume()).toBe(false);
  });

  test("the budget is a hard stop, not a soft preference", () => {
    const budget = createFleetRemoteBudget(true, 2);
    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(false);
  });

  /**
   * What this test proves and — read the last assertion — what it deliberately does NOT.
   *
   * Door 2 (`generateMarkdown`) refuses an exhausted budget with a NAMED error, and that is worth
   * pinning: a warn-and-continue budget is a preference, and a preference is not an invariant.
   *
   * But door 2 is the second door, for a caller holding a provider it obtained some other way. The
   * PRODUCTION runner (`agents/_lib/synthesis-llm.ts`) resolves FIRST, and door 1 has already
   * withheld the provider by then — so the runner returns `{ok:false, reason:"no_eligible_provider"}`
   * with no `detail`, indistinguishable on the brief row from "no provider was configured". The
   * final assertion below is that silent path, asserted as the fact it is, NOT as disclosure.
   *
   * Door 1 is silent BY DESIGN — the wrapper discloses nothing per brief. The per-brief disclosure
   * lives one level up: the INVOKER (`fleet/fleet-invoker.ts`) writes `fleetRemoteWithheld` onto
   * the brief's synthesis provenance, proven end to end in
   * `packages/gateway/test/integration/fleet/fleet-i38-composed.test.ts`. Per run, the disclosure is
   * `fleet_run.remote_calls_made` beside `remote_call_budget`.
   */
  test("an exhausted budget is a HARD refusal at door 2 and a silent withhold at door 1", async () => {
    const budget = createFleetRemoteBudget(true, 1);
    const calls: string[] = [];
    const wrapped = wrapFleetSynthesisRouter(
      {
        resolveForSynthesis: async () => REMOTE_PROVIDER,
        generateMarkdown: async (_p, provider) => {
          calls.push(provider.providerId);
          return "md";
        },
      },
      budget,
    );
    await wrapped.generateMarkdown("p", REMOTE_PROVIDER);
    // The next call must THROW rather than quietly resolving local or returning a render: a
    // warn-and-continue budget is a preference, and a preference is not an invariant.
    await expect(wrapped.generateMarkdown("p", REMOTE_PROVIDER)).rejects.toBeInstanceOf(
      FleetRemoteRefusedError,
    );
    await expect(wrapped.generateMarkdown("p", REMOTE_PROVIDER)).rejects.toThrow(
      /exhausted its remote_call_budget/,
    );
    expect(calls).toEqual(["anthropic"]);
    // Door 1 closes too — SILENTLY. `undefined` is the same answer the runner gets when no remote
    // provider is configured at all, so the wrapper alone says nothing about the budget; the
    // invoker's `fleetRemoteWithheld` is what discloses it on the brief (see the comment above).
    expect(await wrapped.resolveForSynthesis(true)).toBeUndefined();
  });

  /**
   * ANTI-PATTERN TEST, not a wiring test — labelled so a future audit does not count it among the
   * tests proving I38 is wired. Its first half CANNOT detect the wrapper's absence: a local
   * provider passes through untouched BY DESIGN, so "the call went through" is what a pass-through
   * router does too. That is not a defect in the test, it is what the property IS.
   *
   * Its second half CAN: a provider whose id looks local (`ollama`) but declares `isLocal: false`
   * must be REFUSED, which only a present wrapper reading `provider.isLocal` does. Both halves
   * together pin the mistake in the direction that matters — recomputing locality from a vendor id
   * fails silently BOTH ways, refusing a genuinely local provider and admitting a remote one, and
   * a test covering only the first direction would let the dangerous half through.
   */
  test("ANTI-PATTERN: locality recomputed from the vendor id (the mistake I34 exists to prevent)", async () => {
    const budget = createFleetRemoteBudget(false, 0);
    let called = false;
    const wrapped = wrapFleetSynthesisRouter(
      {
        resolveForSynthesis: async () => undefined,
        generateMarkdown: async () => {
          called = true;
          return "ok";
        },
      },
      budget,
    );
    // Direction 1 — providerId reads remote, `isLocal` says otherwise, and `isLocal` governs.
    // (Passes with the wrapper removed; see the block comment.)
    await wrapped.generateMarkdown("p", { providerId: "openai", modelName: "m", isLocal: true });
    expect(called).toBe(true);
    // Direction 2 — the dangerous one, and the half that IS wrapper-detecting: a LOCAL-LOOKING
    // vendor id on a provider that declares itself non-local must still be refused.
    called = false;
    await expect(
      wrapped.generateMarkdown("p", { providerId: "ollama", modelName: "m", isLocal: false }),
    ).rejects.toThrow(/allow_remote/);
    expect(called).toBe(false);
  });

  test("a LOCAL provider resolves through untouched — a grant WIDENS, it never narrows", async () => {
    // The statement's "resolves to the local provider" half, on the door that actually resolves.
    // Everything else here proves what is WITHHELD; without this, a wrapper that returned
    // `undefined` unconditionally — withholding the local provider too, and so silently downgrading
    // every unattended brief to the deterministic render — would pass the whole block.
    const local: ResolvedSynthesisProvider = {
      providerId: "ollama",
      modelName: "qwen",
      isLocal: true,
    };
    const wrapped = wrapFleetSynthesisRouter(
      {
        resolveForSynthesis: async () => local,
        generateMarkdown: async () => "md",
      },
      // The most hostile budget there is: no grant, no cap. A local provider is unaffected by both.
      createFleetRemoteBudget(false, 0),
    );
    expect(await wrapped.resolveForSynthesis(true)).toBe(local);
    expect(await wrapped.generateMarkdown("p", local)).toBe("md");
  });

  test("a fleet brief appends no egress row — the fleet kind is non-bearing", () => {
    // Unattendedness is not egress. A fleet brief is written to local SQLite and read by the owner
    // on this machine; a fleet run's REMOTE synthesis, when granted, is ledgered by the `model`
    // class at the provider, which is where the bytes actually leave.
    expect(egressSourceTypeForClientKind("fleet")).toBeNull();
    // Not vacuous: the map is total over `ClientKind` and other kinds DO bear egress.
    expect(egressSourceTypeForClientKind("mcp")).toBe("mcp");
  });

  test("fleet is NOT declarable by a socket client — attribution stays a fact", () => {
    const store = new ClientKindStore();
    expect(store.declare("c1", "fleet")).toBe("unknown");
    // Not vacuous: `declare` really does honour the kinds it recognises.
    expect(new ClientKindStore().declare("c2", "mcp")).toBe("mcp");
  });

  test("a pushed brief appends no egress row — the push kind is non-bearing", () => {
    expect(egressSourceTypeForClientKind("push")).toBeNull();
    expect(egressSourceTypeForClientKind("mcp")).toBe("mcp"); // not vacuous
  });

  test("push is NOT declarable by a socket client — attribution stays a fact", () => {
    expect(new ClientKindStore().declare("c1", "push")).toBe("unknown");
    expect(new ClientKindStore().declare("c2", "mcp")).toBe("mcp"); // not vacuous
  });

  test("a push caller can never take oncall's owner-scoped (parameterless) shape", async () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    try {
      await expect(
        dispatchAgentsRpc("agents.oncall", {}, {
          db,
          notify: () => {},
          caller: { clientId: "x", kind: "push" },
        } as unknown as Parameters<typeof dispatchAgentsRpc>[2]),
      ).rejects.toThrow(/requires incidentId or service/);
    } finally {
      db.close();
    }
  });
});
