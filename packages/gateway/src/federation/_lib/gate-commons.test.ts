import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { SessionConsentCache } from "../consent-cache.ts";
import { NamespaceStore } from "../namespace-store.ts";
import type { ConsentPrompter } from "../query-gate.ts";
import { enforceCommonGate } from "./gate-commons.ts";

const METHOD = "federation.query" as const;

let db: Database;
let store: NamespaceStore;
const autoApprove: ConsentPrompter = async () => "approved";
const autoDeny: ConsentPrompter = async () => "denied";

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 33);
  store = new NamespaceStore(db);
  store.publish("project:zurich", [{ kind: "service", value: "github" }]);
});
afterEach(() => db.close());

function ctx(consent: ConsentPrompter, cache = new SessionConsentCache()) {
  return {
    db,
    store,
    consentCache: cache,
    prompt: consent,
    consentTimeoutMs: 1000,
    now: () => 100,
  };
}

const REQ = { peerId: "peerA", namespace: "project:zurich", purpose: "test" };

test("identity_invalid => no_grant error (opaque, no identity leak)", async () => {
  store.grant("project:zurich", "peerA", "viewer", true);
  const result = await enforceCommonGate(
    { ...ctx(autoDeny), identity: { enabled: true, isOperatorValid: () => false } },
    REQ,
    METHOD,
  );
  expect(result).toEqual({ kind: "error", error: "no_grant" });
  // Audit log records identity_invalid (not no_grant) for precision
  const row = db
    .query(`SELECT federation_json FROM audit_log WHERE federation_json IS NOT NULL`)
    .get() as { federation_json: string } | null;
  expect(row).not.toBeNull();
  expect(JSON.parse(row!.federation_json).decision).toBe("identity_invalid");
});

test("identity enabled but valid => passes through identity check", async () => {
  store.grant("project:zurich", "peerA", "viewer", true);
  const result = await enforceCommonGate(
    { ...ctx(autoDeny), identity: { enabled: true, isOperatorValid: () => true } },
    REQ,
    METHOD,
  );
  // Should pass the preamble (standing consent => no prompt needed)
  expect(result).toBeUndefined();
});

test("namespace_unknown => namespace_unknown error", async () => {
  const result = await enforceCommonGate(
    ctx(autoDeny),
    { peerId: "peerA", namespace: "no-such-ns", purpose: "test" },
    METHOD,
  );
  expect(result).toEqual({ kind: "error", error: "namespace_unknown" });
  const row = db
    .query(`SELECT federation_json FROM audit_log WHERE federation_json IS NOT NULL`)
    .get() as { federation_json: string } | null;
  expect(row).not.toBeNull();
  expect(JSON.parse(row!.federation_json).decision).toBe("namespace_unknown");
});

test("no_grant => no_grant error", async () => {
  // peerA has no grant for project:zurich
  const result = await enforceCommonGate(ctx(autoDeny), REQ, METHOD);
  expect(result).toEqual({ kind: "error", error: "no_grant" });
  const row = db
    .query(`SELECT federation_json FROM audit_log WHERE federation_json IS NOT NULL`)
    .get() as { federation_json: string } | null;
  expect(row).not.toBeNull();
  expect(JSON.parse(row!.federation_json).decision).toBe("no_grant");
});

test("standing grant => skips prompt, returns undefined (pass-through)", async () => {
  store.grant("project:zurich", "peerA", "viewer", true);
  // autoDeny would cause denial if prompt were called; standing grant skips it
  const result = await enforceCommonGate(ctx(autoDeny), REQ, METHOD);
  expect(result).toBeUndefined();
});

test("non-standing grant: cached false => consent_denied without prompting", async () => {
  store.grant("project:zurich", "peerA", "viewer", false);
  const cache = new SessionConsentCache();
  cache.set("peerA", "project:zurich", false);
  const result = await enforceCommonGate(ctx(autoApprove, cache), REQ, METHOD);
  expect(result).toEqual({ kind: "error", error: "consent_denied" });
});

test("non-standing grant: prompt approved => returns undefined (pass-through)", async () => {
  store.grant("project:zurich", "peerA", "viewer", false);
  const result = await enforceCommonGate(ctx(autoApprove), REQ, METHOD);
  expect(result).toBeUndefined();
});

test("non-standing grant: prompt denied => consent_denied", async () => {
  store.grant("project:zurich", "peerA", "viewer", false);
  const result = await enforceCommonGate(ctx(autoDeny), REQ, METHOD);
  expect(result).toEqual({ kind: "error", error: "consent_denied" });
});

test("non-standing grant: prompt timeout => timeout_waiting_for_consent", async () => {
  store.grant("project:zurich", "peerA", "viewer", false);
  const timeoutPrompt: ConsentPrompter = () =>
    new Promise((r) => setTimeout(() => r("timeout"), 5));
  const result = await enforceCommonGate(
    { ...ctx(timeoutPrompt), consentTimeoutMs: 1 },
    REQ,
    METHOD,
  );
  expect(result).toEqual({ kind: "error", error: "timeout_waiting_for_consent" });
  const row = db
    .query(`SELECT federation_json FROM audit_log WHERE federation_json IS NOT NULL`)
    .get() as { federation_json: string } | null;
  expect(row).not.toBeNull();
  expect(JSON.parse(row!.federation_json).decision).toBe("timeout");
});
