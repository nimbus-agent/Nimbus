import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { SessionConsentCache } from "./consent-cache.ts";
import { NamespaceStore } from "./namespace-store.ts";
import type { ConsentPrompter } from "./query-gate.ts";
import { answerFederatedQuery } from "./query-gate.ts";

let db: Database;
let store: NamespaceStore;
const autoApprove: ConsentPrompter = async () => "approved";
const autoDeny: ConsentPrompter = async () => "denied";

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 33);
  store = new NamespaceStore(db);
  db.run(`INSERT INTO item (id,service,type,external_id,title,body_preview,modified_at,synced_at,metadata)
          VALUES ('github:pr1','github','pull_request','pr1','Fix auth','body1',10,1,'{"secret":"x"}')`);
  db.run(`INSERT INTO item (id,service,type,external_id,title,body_preview,modified_at,synced_at,metadata)
          VALUES ('github:pr2','github','pull_request','pr2','Add cache','body2',20,1,'{"secret":"y"}')`);
  db.run(`INSERT INTO item (id,service,type,external_id,title,body_preview,modified_at,synced_at,metadata)
          VALUES ('gmail:e1','gmail','email','e1','Salaries','TOP SECRET',30,1,'{"secret":"z"}')`);
  store.publish("project:zurich", [
    { kind: "service", value: "github" },
    { kind: "type", value: "pull_request" },
  ]);
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

test("granted viewer with standing consent gets only declared items, audited", async () => {
  store.grant("project:zurich", "peerA", "viewer", true);
  const res = await answerFederatedQuery(ctx(autoDeny), {
    peerId: "peerA",
    request: { namespace: "project:zurich", purpose: "review" },
  });
  expect(res.kind).toBe("ok");
  if (res.kind !== "ok") return;
  expect(res.response.items.map((i) => i.id).sort()).toEqual(["github:pr1", "github:pr2"]);
  for (const it of res.response.items) {
    expect(Object.keys(it).sort()).toEqual([
      "id",
      "modifiedAt",
      "service",
      "snippet",
      "title",
      "type",
    ]);
  }
  const audited = db
    .query(`SELECT COUNT(*) AS n FROM audit_log WHERE federation_json IS NOT NULL`)
    .get() as { n: number };
  expect(audited.n).toBe(1);
});

test("no grant => empty + audited rejection", async () => {
  const res = await answerFederatedQuery(ctx(autoApprove), {
    peerId: "stranger",
    request: { namespace: "project:zurich", purpose: "snoop" },
  });
  expect(res.kind).toBe("error");
  if (res.kind === "error") expect(res.error).toBe("no_grant");
  const row = db
    .query(`SELECT federation_json FROM audit_log WHERE federation_json IS NOT NULL`)
    .get() as { federation_json: string };
  expect(JSON.parse(row.federation_json).decision).toBe("no_grant");
});

test("undeclared type request returns empty (no leak that email exists)", async () => {
  store.grant("project:zurich", "peerA", "viewer", true);
  const res = await answerFederatedQuery(ctx(autoDeny), {
    peerId: "peerA",
    request: { namespace: "project:zurich", purpose: "review", types: ["email"] },
  });
  expect(res.kind).toBe("ok");
  if (res.kind === "ok") expect(res.response.items).toEqual([]);
});

test("revoked grant => empty even if session consent was cached", async () => {
  const cache = new SessionConsentCache();
  store.grant("project:zurich", "peerA", "viewer", false);
  cache.set("peerA", "project:zurich", true);
  store.revoke("project:zurich", "peerA");
  cache.invalidateNamespace("project:zurich");
  const res = await answerFederatedQuery(ctx(autoDeny, cache), {
    peerId: "peerA",
    request: { namespace: "project:zurich", purpose: "review" },
  });
  expect(res.kind).toBe("error");
});

test("non-standing grant: consent timeout => timeout_waiting_for_consent", async () => {
  store.grant("project:zurich", "peerA", "viewer", false);
  const timeoutPrompt: ConsentPrompter = () =>
    new Promise((r) => setTimeout(() => r("timeout"), 5));
  const res = await answerFederatedQuery(
    { ...ctx(timeoutPrompt), consentTimeoutMs: 1 },
    {
      peerId: "peerA",
      request: { namespace: "project:zurich", purpose: "review" },
    },
  );
  expect(res.kind).toBe("error");
  if (res.kind === "error") expect(res.error).toBe("timeout_waiting_for_consent");
});

test("unknown namespace => namespace_unknown", async () => {
  store.grant("project:zurich", "peerA", "viewer", true);
  const res = await answerFederatedQuery(ctx(autoDeny), {
    peerId: "peerA",
    request: { namespace: "no-such-ns", purpose: "review" },
  });
  expect(res.kind).toBe("error");
  if (res.kind === "error") expect(res.error).toBe("namespace_unknown");
});

test("namespace with no declared filters returns empty (never dumps the index)", async () => {
  store.publish("wide-open", []);
  store.grant("wide-open", "peerA", "viewer", true);
  const res = await answerFederatedQuery(ctx(autoDeny), {
    peerId: "peerA",
    request: { namespace: "wide-open", purpose: "review" },
  });
  expect(res.kind).toBe("ok");
  if (res.kind === "ok") expect(res.response.items).toEqual([]);
});

test("non-standing grant: approval is cached and answers", async () => {
  store.grant("project:zurich", "peerA", "viewer", false);
  const cache = new SessionConsentCache();
  const res = await answerFederatedQuery(ctx(autoApprove, cache), {
    peerId: "peerA",
    request: { namespace: "project:zurich", purpose: "review" },
  });
  expect(res.kind).toBe("ok");
  if (res.kind === "ok") expect(res.response.items.length).toBe(2);
  // a second query uses the cached approval (autoDeny would otherwise deny) and still answers
  const res2 = await answerFederatedQuery(ctx(autoDeny, cache), {
    peerId: "peerA",
    request: { namespace: "project:zurich", purpose: "review" },
  });
  expect(res2.kind).toBe("ok");
});

test("non-standing grant: cached denial => consent_denied without prompting", async () => {
  const cache = new SessionConsentCache();
  store.grant("project:zurich", "peerA", "viewer", false);
  cache.set("peerA", "project:zurich", false);
  const res = await answerFederatedQuery(ctx(autoApprove, cache), {
    peerId: "peerA",
    request: { namespace: "project:zurich", purpose: "review" },
  });
  expect(res.kind).toBe("error");
  if (res.kind === "error") expect(res.error).toBe("consent_denied");
});

test("non-standing grant: fresh denial => consent_denied and caches the denial", async () => {
  const cache = new SessionConsentCache();
  store.grant("project:zurich", "peerA", "viewer", false);
  const res = await answerFederatedQuery(ctx(autoDeny, cache), {
    peerId: "peerA",
    request: { namespace: "project:zurich", purpose: "review" },
  });
  expect(res.kind).toBe("error");
  if (res.kind === "error") expect(res.error).toBe("consent_denied");
  expect(cache.get("peerA", "project:zurich")).toBe(false);
});

test("service-only namespace honours a peer's type narrowing", async () => {
  store.publish("svc-only", [{ kind: "service", value: "github" }]);
  store.grant("svc-only", "peerA", "viewer", true);
  const res = await answerFederatedQuery(ctx(autoDeny), {
    peerId: "peerA",
    request: { namespace: "svc-only", purpose: "review", types: ["pull_request"] },
  });
  expect(res.kind).toBe("ok");
  if (res.kind === "ok") expect(res.response.items.length).toBe(2);
});
