import { Database } from "bun:sqlite";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { AgentsRpcError, dispatchAgentsRpc } from "./agents-rpc.ts";
import type { ClientKind } from "./server/client-kind.ts";

/**
 * The exact refusals of the parameter validators `agents-rpc.ts` shares between agents —
 * `requireObjectPayload`, `optionalSinceMs`, `optionalBoundedString`, `optionalPositiveInteger` —
 * and of `requireCatchupParams`, which `agents.changelog` reuses under its own method name.
 *
 * One helper serves several methods, and each call site threads in the part of the message that
 * differs: the method, the bound and its label, `chars` against oncall's `characters`. A slip in
 * that threading changes a message, or a bound, on the wire — and the per-agent suites mostly
 * match a fragment (`"sinceMs must be"`) or only the code, which cannot see it. So this file pins
 * the WHOLE message at every call site, plus the two properties a helper now decides for all of
 * its callers at once: a length bound measured BEFORE the trim, and a value handed on AFTER it.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;
const SINCE_90_DAYS = `sinceMs must be a non-negative integer up to ${NINETY_DAYS_MS} ms (90 days)`;
const SINCE_365_DAYS = `sinceMs must be a non-negative integer up to ${YEAR_MS} ms (365 days)`;
const SERVICE_CHARS = "service must be a non-empty string up to 64 chars";
const ONCALL_SERVICE = "service must be a non-empty string up to 64 characters";
const ONCALL_INCIDENT = "incidentId must be a non-empty string up to 512 characters";
const PERSON_ID = "personId must be a non-empty string up to 256 chars";

/** 65 characters as given, 64 once trimmed: over a 64 bound only if it is measured first. */
const PADDED_SERVICE = ` ${"x".repeat(64)}`;

const openDbs: Database[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function makeCtx(kind?: ClientKind) {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  openDbs.push(db);
  const notify = mock((_method: string, _params: unknown) => {});
  return kind === undefined ? { db, notify } : { db, notify, caller: { clientId: "c1", kind } };
}

/** The `AgentsRpcError` a dispatch rejects with. Resolving, or any other error, fails the test. */
async function refusal(
  method: string,
  params: unknown,
  kind?: ClientKind,
): Promise<AgentsRpcError> {
  const out: unknown = await dispatchAgentsRpc(method, params, makeCtx(kind)).then(
    (hit) => new Error(`${method} accepted ${JSON.stringify(params)}: ${JSON.stringify(hit)}`),
    (e: unknown) => e,
  );
  expect(out).toBeInstanceOf(AgentsRpcError);
  return out as AgentsRpcError;
}

/** A `-32602` refusal carrying exactly `message`. */
async function expectInvalidParams(
  method: string,
  params: unknown,
  message: string,
  kind?: ClientKind,
): Promise<void> {
  const err = await refusal(method, params, kind);
  expect({ rpcCode: err.rpcCode, message: err.message }).toEqual({ rpcCode: -32602, message });
}

describe("an object-payload refusal names the method that was called", () => {
  // `agents.changelog` is the one that matters most: it shares `requireCatchupParams`, so the
  // method name in its refusal is a parameter it passes rather than a literal it owns.
  const METHODS = [
    "agents.catchup",
    "agents.changelog",
    "agents.huddle",
    "agents.standup",
    "agents.oncall",
    "agents.negotiate",
    "agents.ownership",
  ] as const;

  test.each(METHODS.map((m) => [m] as const))("%s", async (method) => {
    for (const params of [[], ["sinceMs"], "x", 7, true]) {
      await expectInvalidParams(method, params, `${method} requires an object payload`);
    }
  });
});

describe("sinceMs: each call site's own bound, and the label its refusal names", () => {
  const NINETY_DAY_METHODS = [
    "agents.catchup",
    "agents.changelog",
    "agents.huddle",
    "agents.standup",
    "agents.oncall",
  ] as const;

  test.each(NINETY_DAY_METHODS.map((m) => [m] as const))(
    "%s refuses anything but an integer in 0..90 days",
    async (method) => {
      for (const sinceMs of [NINETY_DAYS_MS + 1, -1, 1.5, "1", null]) {
        await expectInvalidParams(method, { sinceMs }, SINCE_90_DAYS);
      }
    },
  );

  test("agents.negotiate refuses outside 0..365 days, and says 365", async () => {
    for (const sinceMs of [YEAR_MS + 1, -1, 1.5]) {
      await expectInvalidParams("agents.negotiate", { sinceMs }, SINCE_365_DAYS);
    }
  });

  test("both ends of the range are accepted: the NEXT check is the one that refuses", async () => {
    // An accepted window would otherwise start a brief; pairing it with a field each validator
    // checks AFTER `sinceMs` proves the window passed without running an agent at all.
    for (const method of ["agents.catchup", "agents.changelog"]) {
      for (const sinceMs of [0, NINETY_DAYS_MS]) {
        await expectInvalidParams(method, { sinceMs, service: "" }, SERVICE_CHARS);
      }
    }
    for (const sinceMs of [0, YEAR_MS]) {
      await expectInvalidParams("agents.negotiate", { sinceMs, personId: "" }, PERSON_ID);
    }
    for (const sinceMs of [0, NINETY_DAYS_MS]) {
      const err = await refusal("agents.oncall", { sinceMs }, "http");
      expect(err.message).toStartWith(
        "agents.oncall requires incidentId or service on this surface",
      );
    }
  });
});

describe("bounded identifiers: measured BEFORE the trim, handed on AFTER it", () => {
  test("service is refused over 64 characters as given, and when blank, in chars", async () => {
    const CASES = [
      ["agents.catchup", {}],
      ["agents.changelog", {}],
      ["agents.impact", { fileOrPrUrl: "src/a.ts" }],
      ["agents.ownership", {}],
    ] as const;
    for (const [method, rest] of CASES) {
      await expectInvalidParams(method, { ...rest, service: PADDED_SERVICE }, SERVICE_CHARS);
      await expectInvalidParams(method, { ...rest, service: "   " }, SERVICE_CHARS);
    }
  });

  test("oncall's two identifiers keep their `characters` wording", async () => {
    await expectInvalidParams("agents.oncall", { service: PADDED_SERVICE }, ONCALL_SERVICE);
    await expectInvalidParams("agents.oncall", { service: "   " }, ONCALL_SERVICE);
    const paddedIncident = ` ${"x".repeat(512)}`;
    await expectInvalidParams("agents.oncall", { incidentId: paddedIncident }, ONCALL_INCIDENT);
    await expectInvalidParams("agents.oncall", { incidentId: "   " }, ONCALL_INCIDENT);
  });

  test("negotiate's personId is bounded at 256 as given", async () => {
    const paddedPerson = ` ${"x".repeat(256)}`;
    await expectInvalidParams("agents.negotiate", { personId: paddedPerson }, PERSON_ID);
    await expectInvalidParams("agents.negotiate", { personId: "   " }, PERSON_ID);
  });

  test("the value reaches the agent TRIMMED", async () => {
    // `oncall` echoes the identifier it searched for in its refusal, which makes the trim visible
    // without building a brief.
    const notFound = await refusal("agents.oncall", { incidentId: "  no-such-item  " });
    expect(notFound.message).toContain("has the id `no-such-item`.");
    const noIncident = await refusal("agents.oncall", { service: "  checkout  " });
    expect(noIncident.message).toContain("for service `checkout`.");
  });
});

describe("agents.oncall checks its parameters in a fixed order", () => {
  test("incidentId, then service, then exclusivity, then sinceMs, then the owner-scope bound", async () => {
    await expectInvalidParams("agents.oncall", { incidentId: 7, service: 7 }, ONCALL_INCIDENT);
    await expectInvalidParams(
      "agents.oncall",
      { incidentId: "a", service: "b", sinceMs: -1 },
      "agents.oncall accepts incidentId or service, not both — an explicit incident already " +
        "determines its service",
    );
    await expectInvalidParams("agents.oncall", { sinceMs: -1 }, SINCE_90_DAYS, "http");
  });
});

describe("a positive-integer refusal names its own field", () => {
  test("why's line, and glossary's and decisions' limit", async () => {
    for (const line of [0, -1, 1.5, "1"]) {
      for (const method of ["agents.why", "agents.whyPeek"]) {
        await expectInvalidParams(
          method,
          { ref: "src/a.ts", line },
          "line must be a positive integer",
        );
      }
    }
    for (const limit of [0, -1, 1.5, "1"]) {
      for (const method of ["agents.glossary", "agents.decisions"]) {
        await expectInvalidParams(method, { limit }, "limit must be a positive integer");
      }
    }
  });
});

describe("agents.changelog shares catchup's validator and still reaches its own agent", () => {
  test("with the window it asked for and its service trimmed", async () => {
    const ctx = makeCtx();
    const out = await dispatchAgentsRpc(
      "agents.changelog",
      { sinceMs: 3_600_000, service: "  svc  " },
      ctx,
    );
    expect(out.kind).toBe("hit");

    const deadline = Date.now() + 20_000;
    let ready: unknown;
    while (ready === undefined && Date.now() < deadline) {
      ready = ctx.notify.mock.calls.find(([method]) => method === "changelog.briefReady")?.[1];
      if (ready === undefined) await new Promise((r) => setTimeout(r, 25));
    }
    const query = (ready as { findings?: { query?: Record<string, unknown> } } | undefined)
      ?.findings?.query;
    expect(query?.["service"]).toBe("svc");
    // The builder turns the DURATION into an absolute cutoff once: nowMs - lookbackMs.
    expect(Number(query?.["nowMs"]) - Number(query?.["sinceMs"])).toBe(3_600_000);
  });
});
