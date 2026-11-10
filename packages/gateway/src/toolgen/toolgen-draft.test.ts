import { describe, expect, test } from "bun:test";
import {
  createDraftToolClosure,
  draftGeneratedTool,
  extractJsonPayload,
  type ToolgenDraftDeps,
} from "./toolgen-draft.ts";
import type { ToolgenError } from "./toolgen-types.ts";

const REQ = { sessionId: "s1", description: "list issues", hosts: ["api.github.com"] };
const SUBJECT = { hosts: ["api.github.com"], credentialHosts: [] };

const GOOD = JSON.stringify({
  inputSchema: { type: "object", properties: { owner: { type: "string" } }, required: ["owner"] },
  body: 'const r = await nimbusFetch("https://api.github.com/x"); return JSON.parse(r.body);',
});

function deps(
  replies: (string | null)[],
  extra: Partial<ToolgenDraftDeps> = {},
  isLocal = true,
): ToolgenDraftDeps {
  const queue = [...replies];
  return {
    generate: async () => {
      const next = queue.shift();
      return next === undefined || next === null ? null : { text: next, isLocal };
    },
    // Default TRUE so the pre-grounding gate is transparent to every test written before it: a
    // `null` reply still exercises the IN-LOOP refusal (including the two-part redraft message).
    // The tests that care about the pre-grounding refusal override it explicitly.
    hasDraftRoute: async () => true,
    findEndpoints: async () => [],
    ...extra,
  };
}

/**
 * Like `deps`, but records every prompt handed to `generate` — in call order — so a test can
 * inspect what the SECOND call actually said, not just that a second call happened.
 */
function depsCapturingPrompts(replies: (string | null)[]): {
  readonly deps: ToolgenDraftDeps;
  readonly prompts: string[];
} {
  const queue = [...replies];
  const prompts: string[] = [];
  return {
    prompts,
    deps: {
      generate: async (prompt) => {
        prompts.push(prompt);
        const next = queue.shift();
        return next === undefined || next === null ? null : { text: next, isLocal: true };
      },
      hasDraftRoute: async () => true,
      findEndpoints: async () => [],
    },
  };
}

// One bad reply per rung, reused by both the existing "redrafts once" cases and the new
// attribution tests below — same payloads, so the rung/reason each produces is pinned once.
const RUNG_1_BAD = "Here is your tool!"; // fails JSON.parse entirely
const RUNG_2_BAD = JSON.stringify({
  inputSchema: { type: "object", properties: { a: { type: "object" } } },
  body: "return 1;",
});
const RUNG_3_BAD = JSON.stringify({
  inputSchema: { type: "object", properties: {} },
  body: "const = ;",
});
const RUNG_4_BAD = JSON.stringify({
  inputSchema: { type: "object", properties: {} },
  body: 'await fetch("https://x");',
});

describe("extractJsonPayload", () => {
  const obj = '{"a":1}';

  test.each([
    ["bare JSON", obj],
    ["a fenced block", `\`\`\`json\n${obj}\n\`\`\``],
    ["an unlabelled fence", `\`\`\`\n${obj}\n\`\`\``],
    // THE case an anchored regex fails: a benign preamble would otherwise burn the single redraft.
    ["a fence with a preamble", `Here is the tool you asked for:\n\`\`\`json\n${obj}\n\`\`\``],
    [
      "a fence with a trailing note",
      `\`\`\`json\n${obj}\n\`\`\`\nLet me know if you need changes.`,
    ],
    ["a bare object with prose around it", `Sure! ${obj} Hope that helps.`],
  ])("extracts the object from %s", (_label, raw) => {
    expect(JSON.parse(extractJsonPayload(raw))).toEqual({ a: 1 });
  });

  test("a closing brace inside a string value does not truncate the object", () => {
    const withBrace = JSON.stringify({ body: "if (x) { return 1; }" });
    expect(JSON.parse(extractJsonPayload(`\`\`\`json\n${withBrace}\n\`\`\``))).toEqual({
      body: "if (x) { return 1; }",
    });
  });

  test("returns the input unchanged when there is no object to find, so rung 1 still fails", () => {
    expect(extractJsonPayload("no json here")).toBe("no json here");
  });
});

describe("draftGeneratedTool", () => {
  test("returns a validated body and schema on the first attempt", async () => {
    const out = await draftGeneratedTool(REQ, deps([GOOD]), SUBJECT);
    expect(out.attempts).toBe(1);
    expect(out.inputSchema.required).toEqual(["owner"]);
    expect(out.body).toContain("nimbusFetch");
    expect(out.grounding).toEqual({ kind: "description_only" });
  });

  test("a fenced reply with a preamble succeeds on the FIRST attempt", async () => {
    const out = await draftGeneratedTool(
      REQ,
      deps([`Here you go:\n\`\`\`json\n${GOOD}\n\`\`\``]),
      SUBJECT,
    );
    // The point is `attempts === 1`: a formatting artifact must not spend the redraft budget that
    // exists for real defects.
    expect(out.attempts).toBe(1);
  });

  test.each([
    ["prose instead of JSON", "Here is your tool!"],
    [
      "a nested-object schema",
      JSON.stringify({
        inputSchema: { type: "object", properties: { a: { type: "object" } } },
        body: "return 1;",
      }),
    ],
    [
      "a syntax error in the body",
      JSON.stringify({ inputSchema: { type: "object", properties: {} }, body: "const = ;" }),
    ],
    [
      "a forbidden global",
      JSON.stringify({
        inputSchema: { type: "object", properties: {} },
        body: 'await fetch("https://x");',
      }),
    ],
    ["a missing body key", JSON.stringify({ inputSchema: { type: "object", properties: {} } })],
  ])("redrafts once after %s, then succeeds", async (_label, bad) => {
    const out = await draftGeneratedTool(REQ, deps([bad, GOOD]), SUBJECT);
    expect(out.attempts).toBe(2);
  });

  test("refuses after two failures with ERR_TOOLGEN_DRAFT_INVALID", async () => {
    try {
      await draftGeneratedTool(REQ, deps(["nope", "still nope"]), SUBJECT);
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as ToolgenError).code).toBe("ERR_TOOLGEN_DRAFT_INVALID");
    }
  });

  // The CLI's local-model hint (`[llm] min_reasoning_params` / `drafting = "allow-remote"`) is
  // useful ONLY when the failing route was local -- so the thrown error must carry which route it
  // was, not just that the ladder failed twice.
  test("ERR_TOOLGEN_DRAFT_INVALID carries the LOCAL route's locality when a local model answered twice and failed", async () => {
    try {
      await draftGeneratedTool(REQ, deps(["nope", "still nope"], {}, true), SUBJECT);
      throw new Error("expected a throw");
    } catch (e) {
      const err = e as ToolgenError;
      expect(err.code).toBe("ERR_TOOLGEN_DRAFT_INVALID");
      expect(err.locality).toBe("local");
    }
  });

  test("ERR_TOOLGEN_DRAFT_INVALID carries the REMOTE route's locality when a remote model answered twice and failed", async () => {
    try {
      await draftGeneratedTool(REQ, deps(["nope", "still nope"], {}, false), SUBJECT);
      throw new Error("expected a throw");
    } catch (e) {
      const err = e as ToolgenError;
      expect(err.code).toBe("ERR_TOOLGEN_DRAFT_INVALID");
      expect(err.locality).toBe("remote");
    }
  });

  // FINDING 1: each redraft prompt must ATTRIBUTE the correct rung and reason, not just exist.
  // Swapping two rung labels or reordering two catch blocks would pass every test above this one.
  describe("redraft attribution", () => {
    test("a rung 1 (output envelope) failure is attributed by name and reason", async () => {
      const { deps: d, prompts } = depsCapturingPrompts([RUNG_1_BAD, GOOD]);
      const out = await draftGeneratedTool(REQ, d, SUBJECT);
      expect(out.attempts).toBe(2);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("Failed check: rung 1 (output envelope)");
      expect(prompts[1]).toContain("Reason: reply is not JSON:");
    });

    test.each(["[1,2]", "42", "null"])(
      "a reply that is valid JSON but not an object (%s) fails rung 1 by name",
      async (reply) => {
        const { deps: d, prompts } = depsCapturingPrompts([reply, GOOD]);
        const out = await draftGeneratedTool(REQ, d, SUBJECT);
        expect(out.attempts).toBe(2);
        expect(prompts[1]).toContain("Failed check: rung 1 (output envelope)");
        expect(prompts[1]).toContain("Reason: reply is not a JSON object");
      },
    );

    test("a rung 2 (input schema) failure is attributed by name and reason", async () => {
      const { deps: d, prompts } = depsCapturingPrompts([RUNG_2_BAD, GOOD]);
      const out = await draftGeneratedTool(REQ, d, SUBJECT);
      expect(out.attempts).toBe(2);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("Failed check: rung 2 (input schema)");
      expect(prompts[1]).toContain(
        'Reason: property "a" has unsupported type "object" (nested objects are not allowed)',
      );
    });

    test("a rung 3 (body syntax) failure is attributed by name and reason", async () => {
      const { deps: d, prompts } = depsCapturingPrompts([RUNG_3_BAD, GOOD]);
      const out = await draftGeneratedTool(REQ, d, SUBJECT);
      expect(out.attempts).toBe(2);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("Failed check: rung 3 (body syntax)");
      expect(prompts[1]).toContain("Reason: tool body does not parse:");
    });

    test("a rung 4 (forbidden globals) failure is attributed by name and reason", async () => {
      const { deps: d, prompts } = depsCapturingPrompts([RUNG_4_BAD, GOOD]);
      const out = await draftGeneratedTool(REQ, d, SUBJECT);
      expect(out.attempts).toBe(2);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("Failed check: rung 4 (forbidden globals)");
      expect(prompts[1]).toContain("Reason: tool body uses the global fetch()");
    });

    test("the final ERR_TOOLGEN_DRAFT_INVALID message names the SECOND attempt's rung, not the first's", async () => {
      // First attempt fails rung 2, second attempt fails rung 3 — `last` is reassigned each
      // iteration, so the thrown message must report rung 3, never the discarded rung 2.
      try {
        await draftGeneratedTool(REQ, deps([RUNG_2_BAD, RUNG_3_BAD]), SUBJECT);
        throw new Error("expected a throw");
      } catch (e) {
        const err = e as ToolgenError;
        expect(err.code).toBe("ERR_TOOLGEN_DRAFT_INVALID");
        expect(err.message).toContain("rung 3 (body syntax)");
        expect(err.message).not.toContain("rung 2 (input schema)");
      }
    });
  });

  test("never makes a third attempt", async () => {
    let calls = 0;
    const d: ToolgenDraftDeps = {
      generate: async () => {
        calls += 1;
        return { text: "nope", isLocal: true };
      },
      hasDraftRoute: async () => true,
      findEndpoints: async () => [],
    };
    await expect(draftGeneratedTool(REQ, d, SUBJECT)).rejects.toThrow();
    expect(calls).toBe(2);
  });

  // The description reaches `findEndpoints` -> `searchRankedAsync` -> `embedQueryDual`, and with a
  // remote embedder configured THAT is a real outbound request carrying the owner's text. So a
  // refusal that is decidable without a model must happen BEFORE the search, not after it — the
  // same ordering rule the gate applies to consent. Asserting the CALL COUNT rather than the
  // outcome: the thrown error was already correct when the search ran first.
  test("refuses BEFORE grounding when no drafting route exists — findEndpoints is never called", async () => {
    let searches = 0;
    const d: ToolgenDraftDeps = {
      generate: async () => {
        throw new Error("generate must not be reached either");
      },
      hasDraftRoute: async () => false,
      findEndpoints: async () => {
        searches += 1;
        return [];
      },
    };
    try {
      await draftGeneratedTool(REQ, d, SUBJECT);
      throw new Error("expected a throw");
    } catch (e) {
      const err = e as ToolgenError;
      expect(err.code).toBe("ERR_TOOLGEN_NO_DRAFT_MODEL");
      // The SAME message the in-loop first-attempt `null` produces — one fact, one wording.
      expect(err.message).toBe("no model is available to draft a tool body");
    }
    expect(searches).toBe(0);
  });

  test("locality is DERIVED from the provider, not from the config mode", async () => {
    const remote = await draftGeneratedTool(REQ, deps([GOOD], {}, false), SUBJECT);
    expect(remote.locality).toBe("remote");
    const local = await draftGeneratedTool(REQ, deps([GOOD], {}, true), SUBJECT);
    expect(local.locality).toBe("local");
  });

  test("refuses with ERR_TOOLGEN_NO_DRAFT_MODEL when no provider answers", async () => {
    // `null` on the FIRST attempt: there is no prior failure to report, so the message stays
    // exactly what it always was.
    try {
      await draftGeneratedTool(REQ, deps([null]), SUBJECT);
      throw new Error("expected a throw");
    } catch (e) {
      const err = e as ToolgenError;
      expect(err.code).toBe("ERR_TOOLGEN_NO_DRAFT_MODEL");
      expect(err.message).toBe("no model is available to draft a tool body");
      // No route answered AT ALL -- there is nothing to attribute a locality to.
      expect(err.locality).toBeUndefined();
    }
  });

  // FINDING 2: a `null` on the REDRAFT call must not discard the first attempt's real failure —
  // the owner must not be sent off to configure a model that demonstrably just answered.
  test("refuses with ERR_TOOLGEN_NO_DRAFT_MODEL naming the first attempt's failure when the redraft finds no model", async () => {
    try {
      await draftGeneratedTool(REQ, deps([RUNG_3_BAD, null]), SUBJECT);
      throw new Error("expected a throw");
    } catch (e) {
      const err = e as ToolgenError;
      expect(err.code).toBe("ERR_TOOLGEN_NO_DRAFT_MODEL");
      expect(err.message).toContain("rung 3 (body syntax)");
      expect(err.message).toContain("tool body does not parse:");
      expect(err.message).not.toBe("no model is available to draft a tool body");
      // The FIRST attempt answered and failed the ladder, but the redraft call itself got no
      // response -- `ERR_TOOLGEN_NO_DRAFT_MODEL` still reports no locality, since reusing the
      // first attempt's route would claim one for a call that never got an answer.
      expect(err.locality).toBeUndefined();
    }
  });

  test("reports endpoint grounding when the finder returns rows", async () => {
    const out = await draftGeneratedTool(
      REQ,
      deps([GOOD], {
        findEndpoints: async () => [
          { serviceName: "github-api", method: "GET", path: "/x", operationId: null, summary: "" },
        ],
      }),
      SUBJECT,
    );
    expect(out.grounding).toEqual({ kind: "endpoints", count: 1, services: ["github-api"] });
  });

  test("names credential HOSTS in the prompt and never a secret", async () => {
    // The types cannot carry a secret here at all (spec § 9.1) — `DraftSubject` holds names. This
    // asserts the rendered prompt too, since that is the artefact that would actually leave.
    let prompt = "";
    await draftGeneratedTool(
      REQ,
      // biome-ignore lint/complexity/noCommaOperator: capture the prompt inline, at the exact call site under test
      // biome-ignore lint/suspicious/noAssignInExpressions: same — the assignment IS the assertion fixture
      deps([GOOD], { generate: async (p) => ({ text: ((prompt = p), GOOD), isLocal: true }) }),
      { hosts: ["api.github.com"], credentialHosts: ["api.github.com"] },
    );
    expect(prompt).toContain("api.github.com");
    expect(prompt).not.toContain("s3cret");
  });

  test("the prompt names the NORMALISED hosts the broker will match", async () => {
    // The gate normalises before drafting, so a prompt built from raw `req.hosts` would tell the
    // model about a host (`https://api.github.com/v1`) the broker's `url.hostname` never matches.
    let prompt = "";
    await draftGeneratedTool(
      { ...REQ, hosts: ["https://api.github.com/v1"] },
      // biome-ignore lint/complexity/noCommaOperator: capture the prompt inline, at the exact call site under test
      // biome-ignore lint/suspicious/noAssignInExpressions: same — the assignment IS the assertion fixture
      deps([GOOD], { generate: async (p) => ({ text: ((prompt = p), GOOD), isLocal: true }) }),
      SUBJECT,
    );
    expect(prompt).toContain("api.github.com");
    expect(prompt).not.toContain("https://api.github.com/v1");
  });
});

describe("createDraftToolClosure", () => {
  test("binds the deps so the closure drafts exactly as draftGeneratedTool does", async () => {
    const draft = createDraftToolClosure(deps([GOOD]));
    const out = await draft(REQ, SUBJECT);
    expect(out.attempts).toBe(1);
    expect(out.inputSchema.required).toEqual(["owner"]);
  });
});
