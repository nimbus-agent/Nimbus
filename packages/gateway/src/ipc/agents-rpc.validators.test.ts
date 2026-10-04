import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { AgentsRpcError, dispatchAgentsRpc } from "./agents-rpc.ts";

/**
 * The per-agent validators `agents-rpc.params.test.ts` does not reach: the exact refusal each one
 * raises (and that it raises THAT one, not a sibling's), plus the defaults a lenient validator
 * fills in, observed on the brief the agent then builds.
 */

const openDbs: Database[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function indexDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  openDbs.push(db);
  return db;
}

/**
 * ONE index for every refusal: a refused call never reaches an agent, so nothing writes to it, and
 * migrating a fresh schema per call is what made this file slow.
 */
let refusalDb: Database;
beforeAll(() => {
  refusalDb = new Database(":memory:");
  LocalIndex.ensureSchema(refusalDb);
});
afterAll(() => {
  refusalDb.close();
});

/** The `-32602` message a dispatch rejects with. Resolving, or any other error, fails the test. */
async function invalidParams(method: string, params: unknown): Promise<string> {
  const out: unknown = await dispatchAgentsRpc(method, params, {
    db: refusalDb,
    notify: () => {},
  }).then(
    (hit) => new Error(`${method} accepted ${JSON.stringify(params)}: ${JSON.stringify(hit)}`),
    (e: unknown) => e,
  );
  expect(out).toBeInstanceOf(AgentsRpcError);
  expect((out as AgentsRpcError).rpcCode).toBe(-32602);
  return (out as AgentsRpcError).message;
}

type Ready = { findings: Record<string, unknown> };

/** Settles on `<kind>.briefReady` (rejects on `<kind>.briefError`) for a dispatch that hits. */
async function briefFor(kind: string, method: string, params: unknown): Promise<Ready> {
  let resolveReady!: (v: Ready) => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<Ready>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  const out = await dispatchAgentsRpc(method, params, {
    db: indexDb(),
    notify: (m: string, p: unknown) => {
      if (m === `${kind}.briefReady`) resolveReady(p as Ready);
      if (m === `${kind}.briefError`) rejectReady(new Error(JSON.stringify(p)));
    },
  });
  expect(out.kind).toBe("hit");
  return await ready;
}

describe("agents.expert", () => {
  test("a non-string topicOrFile is refused by type, before any length rule", async () => {
    for (const topicOrFile of [42, null, ["src/a.ts"]]) {
      expect(await invalidParams("agents.expert", { topicOrFile })).toBe(
        "topicOrFile must be a string",
      );
    }
  });
});

describe("the file subject of agents.ghost / agents.conflicts", () => {
  const SHAPE = "requires { file: string } or { service, repo, refAndPath }";

  test.each([["agents.ghost"], ["agents.conflicts"]])(
    "%s refuses a non-object payload with the shape it expects",
    async (method) => {
      for (const params of [null, [], "src/a.ts", 7]) {
        expect(await invalidParams(method, params)).toBe(SHAPE);
      }
    },
  );

  test("each forge field is type-checked, in the order service, repo, refAndPath", async () => {
    expect(await invalidParams("agents.ghost", { service: 7, repo: 7, refAndPath: 7 })).toBe(
      "service must be a string",
    );
    expect(await invalidParams("agents.ghost", { service: "github", repo: 7, refAndPath: 7 })).toBe(
      "repo must be a string",
    );
    expect(
      await invalidParams("agents.ghost", { service: "github", repo: "acme/web", refAndPath: 7 }),
    ).toBe("refAndPath must be a string");
  });

  test("a forge field is bounded AFTER the trim: blank and over-long are both refused", async () => {
    expect(
      await invalidParams("agents.conflicts", { service: "github", repo: "   ", refAndPath: "x" }),
    ).toBe("repo must be 1..2048 chars");
    expect(
      await invalidParams("agents.conflicts", {
        service: "github",
        repo: "acme/web",
        refAndPath: "p".repeat(2049),
      }),
    ).toBe("refAndPath must be 1..2048 chars");
  });
});

describe("agents.janitor", () => {
  test("a non-object payload is refused as such; an ARRAY gets past that check to resourceRef", async () => {
    for (const params of [null, "i-12345", 7]) {
      expect(await invalidParams("agents.janitor", params)).toBe(
        "agents.janitor: object params required",
      );
    }
    // The janitor check is `typeof === "object"` with no `Array.isArray`, so an array is judged
    // on its (missing) fields — still refused, by the field rule.
    for (const params of [[], { resourceRef: 7 }, { resourceRef: "   " }]) {
      expect(await invalidParams("agents.janitor", params)).toBe(
        "agents.janitor: resourceRef (non-empty string) required",
      );
    }
  });

  test("lenient fields fall back to their defaults rather than refusing", async () => {
    const { findings } = await briefFor("janitor", "agents.janitor", {
      resourceRef: "  i-12345  ",
      idleDays: 2.5,
      cleanupAction: "",
    });
    expect(findings["query"]).toEqual({ resourceRef: "i-12345", idleDays: 14 });
    expect(findings["cleanupAction"]).toBeNull();
    // No peers is a coverage gap; without allowGaps the proposal is withheld.
    expect(findings["proposalSuppressed"]).toBe(true);
  });

  test("supplied fields reach the brief: idle window, cleanup command and allowGaps", async () => {
    const { findings } = await briefFor("janitor", "agents.janitor", {
      resourceRef: "i-12345",
      idleDays: 3,
      cleanupAction: "aws ec2 terminate-instances --instance-ids i-12345",
      allowGaps: true,
    });
    expect(findings["query"]).toEqual({ resourceRef: "i-12345", idleDays: 3 });
    expect(findings["cleanupAction"]).toBe("aws ec2 terminate-instances --instance-ids i-12345");
    expect(findings["proposalSuppressed"]).toBe(false);
  });
});

describe("agents.preflight", () => {
  test("a non-object payload, then a missing ref, then a missing namespace — each its own refusal", async () => {
    for (const params of [null, "HEAD", 7]) {
      expect(await invalidParams("agents.preflight", params)).toBe(
        "agents.preflight: object params required",
      );
    }
    for (const params of [[], { ref: 7, namespace: "n" }, { ref: "  ", namespace: "n" }]) {
      expect(await invalidParams("agents.preflight", params)).toBe(
        "agents.preflight: ref (non-empty string) required",
      );
    }
    expect(await invalidParams("agents.preflight", { ref: "HEAD", namespace: 7 })).toBe(
      "agents.preflight: namespace (non-empty string) required",
    );
  });
});

describe("agents.decisions", () => {
  test("a non-object payload is refused (null/undefined are the defaults request instead)", async () => {
    for (const params of ["30d", 7, true]) {
      expect(await invalidParams("agents.decisions", params)).toBe("params must be an object");
    }
  });

  test("a non-string service is refused by name", async () => {
    expect(await invalidParams("agents.decisions", { service: 7 })).toBe(
      "service must be a string",
    );
  });
});

describe("agents.glossary", () => {
  test("null params are the list request; a valid limit reaches the query", async () => {
    const list = await briefFor("glossary", "agents.glossary", null);
    expect(list.findings["mode"]).toBe("list");
    expect((list.findings["query"] as { term: unknown }).term).toBeNull();

    const limited = await briefFor("glossary", "agents.glossary", { limit: 2 });
    expect(limited.findings["query"]).toEqual({ term: null, limit: 2 });
  });
});

describe("agents.why — an unparseable prUrl", () => {
  test("is not refused at the gate (it carries no userinfo to leak) and resolves as a miss", async () => {
    // `prUrlHasCredentials` cannot parse it, so it has no credentials to reject; the brief then
    // reports it unresolvable rather than the gate guessing at what the caller meant.
    const { findings } = await briefFor("why", "agents.why", { prUrl: "not a url" });
    expect(findings["query"]).toEqual({ ref: "not a url", line: null });
    expect(findings["changeSubject"]).toBeNull();
  });
});
