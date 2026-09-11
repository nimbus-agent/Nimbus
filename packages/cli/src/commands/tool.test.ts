import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OutcomeSink, RunToolDeps, ToolClient } from "./tool.ts";
import {
  CLI_TOOLGEN_SESSION_ID,
  exitCodeForTool,
  formatToolApprovalPrompt,
  handleToolApprovalBroadcast,
  parseToolArgs,
  renderToolList,
  renderToolOutcome,
  runTool,
  TOOL_EXIT_CODES,
} from "./tool.ts";

describe("parseToolArgs", () => {
  test("create requires at least one --host", () => {
    expect(() => parseToolArgs(["create", "--description", "d"])).toThrow(/--host/);
  });

  test("create parses repeated --host flags", () => {
    const a = parseToolArgs([
      "create",
      "--description",
      "d",
      "--host",
      "a.example.com",
      "--host",
      "b.example.com",
    ]);
    expect(a).toMatchObject({ sub: "create", hosts: ["a.example.com", "b.example.com"] });
  });

  test("create parses repeatable --credential bindings", () => {
    const a = parseToolArgs([
      "create",
      "--description",
      "d",
      "--host",
      "a.example.com",
      "--credential",
      "a.example.com=tok",
    ]);
    expect(a).toMatchObject({ credentials: [{ host: "a.example.com", token: "tok" }] });
  });

  test("a --credential for a host not in --host is refused", () => {
    expect(() =>
      parseToolArgs([
        "create",
        "--description",
        "d",
        "--host",
        "a.example.com",
        "--credential",
        "b.example.com=tok",
      ]),
    ).toThrow(/not in --host/);
  });

  test("a --credential whose host differs only in CASE is accepted — the gateway lowercases", () => {
    // `normalizeHost` (gateway) lowercases, so these are ONE host there. Refusing them here was a
    // pure over-refusal: the owner is told their two flags disagree when the gateway would treat
    // them as identical. The raw spelling is preserved on the wire — the gateway normalises.
    const parsed = parseToolArgs([
      "create",
      "--description",
      "d",
      "--host",
      "a.example.com",
      "--credential",
      "A.Example.COM=tok",
    ]);
    expect(parsed).toMatchObject({ credentials: [{ host: "A.Example.COM", token: "tok" }] });
  });

  test("a --credential carrying a scheme is still refused here, and the message names both spellings", () => {
    // Stated over-refusal: `packages/cli` may not import gateway source, so the CLI deliberately
    // does NOT reimplement the rest of `normalizeHost` (scheme/port stripping) — one boundary, one
    // copy. The gateway would accept this pair; the CLI asks the owner to spell them the same way.
    expect(
      () =>
        parseToolArgs([
          "create",
          "--description",
          "d",
          "--host",
          "a.example.com",
          "--credential",
          "https://a.example.com/v1=tok",
        ]),
      // A plain string, not a regex: `toThrow` already does substring matching, and an unanchored
      // URL-shaped regex trips CodeQL's `js/regex/missing-regexp-anchor` — correctly in general,
      // since such a pattern would match arbitrary hosts either side if it were ever used to
      // VALIDATE a URL rather than to assert on an error message.
    ).toThrow("https://a.example.com/v1");
  });

  test("credential set requires a tool id, a host and exactly one scheme", () => {
    expect(() => parseToolArgs(["credential", "set", "tg_a", "a.example.com"])).toThrow(
      /--bearer|--header/,
    );
    expect(() =>
      parseToolArgs([
        "credential",
        "set",
        "tg_a",
        "a.example.com",
        "--bearer",
        "t",
        "--header",
        "X",
        "v",
      ]),
    ).toThrow(/exactly one/);
  });

  test("revoke requires a tool id", () => {
    expect(() => parseToolArgs(["revoke"])).toThrow(/tool id/);
  });

  test("save requires a tool id", () => {
    expect(() => parseToolArgs(["save"])).toThrow(/tool id/);
  });

  test("save parses a tool id", () => {
    expect(parseToolArgs(["save", "tg_a"])).toEqual({ sub: "save", toolId: "tg_a" });
  });

  test("save with a flag where the tool id belongs is refused, not read as an id", () => {
    expect(() => parseToolArgs(["save", "--force"])).toThrow(/tool id is required/);
  });

  test("an unknown subcommand is refused, not defaulted", () => {
    expect(() => parseToolArgs(["frobnicate"])).toThrow(/Usage/);
  });

  // Additional coverage beyond the brief's own test block.

  test("create keeps a token containing '=' intact (base64 padding)", () => {
    // Splitting on every "=" rather than the first would truncate a real base64 token.
    const a = parseToolArgs([
      "create",
      "--description",
      "d",
      "--host",
      "a.example.com",
      "--credential",
      "a.example.com=abc==",
    ]);
    expect(a).toMatchObject({ credentials: [{ host: "a.example.com", token: "abc==" }] });
  });

  test("create requires --description", () => {
    expect(() => parseToolArgs(["create", "--host", "a.example.com"])).toThrow(/--description/);
  });

  test("an unknown flag on create throws rather than being ignored", () => {
    expect(() =>
      parseToolArgs(["create", "--description", "d", "--host", "a.example.com", "--allow-net"]),
    ).toThrow(/Unknown flag/);
  });

  test("list parses --json", () => {
    expect(parseToolArgs(["list", "--json"])).toEqual({ sub: "list", json: true });
    expect(parseToolArgs(["list"])).toEqual({ sub: "list", json: false });
  });

  test("credential set parses a bearer scheme", () => {
    const a = parseToolArgs(["credential", "set", "tg_a", "a.example.com", "--bearer", "tok"]);
    expect(a).toEqual({
      sub: "credential-set",
      toolId: "tg_a",
      host: "a.example.com",
      scheme: { type: "bearer", token: "tok" },
    });
  });

  test("credential set parses a header scheme", () => {
    const a = parseToolArgs([
      "credential",
      "set",
      "tg_a",
      "a.example.com",
      "--header",
      "X-Api-Key",
      "secret",
    ]);
    expect(a).toEqual({
      sub: "credential-set",
      toolId: "tg_a",
      host: "a.example.com",
      scheme: { type: "header", headerName: "X-Api-Key", value: "secret" },
    });
  });

  test("credential set parses a basic scheme", () => {
    const a = parseToolArgs([
      "credential",
      "set",
      "tg_a",
      "a.example.com",
      "--basic",
      "user",
      "pass",
    ]);
    expect(a).toEqual({
      sub: "credential-set",
      toolId: "tg_a",
      host: "a.example.com",
      scheme: { type: "basic", username: "user", password: "pass" },
    });
  });

  test("credential set with an unknown subcommand under 'credential' is refused", () => {
    expect(() => parseToolArgs(["credential", "delete", "tg_a"])).toThrow(/Usage/);
  });

  test("empty argv is refused, not defaulted", () => {
    expect(() => parseToolArgs([])).toThrow(/Usage/);
  });
});

describe("TOOL_EXIT_CODES", () => {
  test("denial and refusal are distinguishable and in the reserved band", () => {
    expect(TOOL_EXIT_CODES.denied).toBe(126);
    expect(TOOL_EXIT_CODES.refused).toBe(127);
  });
});

describe("exitCodeForTool", () => {
  test("registered maps to 0, denied and refused map to the reserved band", () => {
    expect(exitCodeForTool({ status: "registered", toolId: "tg_a" })).toBe(0);
    expect(exitCodeForTool({ status: "denied" })).toBe(TOOL_EXIT_CODES.denied);
    expect(exitCodeForTool({ status: "refused", code: "ERR_TOOLGEN_DISABLED" })).toBe(
      TOOL_EXIT_CODES.refused,
    );
  });

  test("an unrecognised status maps to refused, never 0", () => {
    expect(exitCodeForTool({ status: "something-new" })).toBe(TOOL_EXIT_CODES.refused);
  });
});

describe("formatToolApprovalPrompt", () => {
  // Shared minimal values for the tests below that aren't exercising `inputSchema`/`grounding`
  // themselves -- an empty schema and an ungrounded draft, matching the CLI's own defaults for a
  // malformed broadcast.
  const NO_PARAMS = { type: "object" as const, properties: {} };
  const UNGROUNDED = { kind: "description_only" as const };

  test("shows the tool body VERBATIM, not a digest", () => {
    const text = formatToolApprovalPrompt({
      toolName: "generated_tg_a",
      description: "fetch weather",
      body: "export default async function main() { return 1; }",
      approvedHosts: ["api.example.com"],
      credentialHosts: [],
      inputSchema: NO_PARAMS,
      grounding: UNGROUNDED,
    });
    expect(text).toContain("export default async function main() { return 1; }");
  });

  test("lists the approved hosts and credential hosts", () => {
    const text = formatToolApprovalPrompt({
      toolName: "generated_tg_a",
      description: "d",
      body: "1",
      approvedHosts: ["a.example.com", "b.example.com"],
      credentialHosts: ["a.example.com"],
      inputSchema: NO_PARAMS,
      grounding: UNGROUNDED,
    });
    expect(text).toContain("a.example.com, b.example.com");
    expect(text.toLowerCase()).toContain("credential hosts:");
  });

  test("states an empty credential host list explicitly, not by omission", () => {
    const text = formatToolApprovalPrompt({
      toolName: "generated_tg_a",
      description: "d",
      body: "1",
      approvedHosts: ["a.example.com"],
      credentialHosts: [],
      inputSchema: NO_PARAMS,
      grounding: UNGROUNDED,
    });
    expect(text.toLowerCase()).toContain("credential hosts: none");
  });

  /**
   * I39's WHERE-not-WHAT residual, made real rather than merely documented in
   * docs/SECURITY-INVARIANTS.md. A real assertion on rendered output, not a snapshot -- a snapshot
   * would still pass if the line silently vanished from the template.
   */
  test("discloses that the host list bounds WHERE, never WHAT, a tool may send", () => {
    const text = formatToolApprovalPrompt({
      toolName: "generated_tg_a",
      description: "d",
      body: "1",
      approvedHosts: ["a.example.com"],
      credentialHosts: [],
      inputSchema: NO_PARAMS,
      grounding: UNGROUNDED,
    });
    expect(text).toContain(
      "note: an approved host may receive anything this tool can compute. The host list bounds",
    );
    expect(text).toContain("WHERE it may send, never WHAT.");
  });

  test("the approval prompt shows the parameters the owner is approving", () => {
    const out = formatToolApprovalPrompt({
      toolName: "generated_t1",
      description: "d",
      body: "return 1;",
      approvedHosts: ["api.github.com"],
      credentialHosts: [],
      inputSchema: {
        type: "object",
        properties: { owner: { type: "string" } },
        required: ["owner"],
      },
      grounding: { kind: "endpoints", count: 3, services: ["github-api"] },
    });
    expect(out).toContain("owner");
    expect(out).toContain("required");
    expect(out).toContain("3 indexed endpoint");
  });

  test("the prompt discloses when the draft was NOT grounded", () => {
    const out = formatToolApprovalPrompt({
      toolName: "generated_t1",
      description: "d",
      body: "return 1;",
      approvedHosts: ["api.github.com"],
      credentialHosts: [],
      inputSchema: NO_PARAMS,
      grounding: { kind: "description_only" },
    });
    expect(out).toContain("no indexed API specification");
  });
});

describe("handleToolApprovalBroadcast", () => {
  function harness(answer: unknown) {
    const shown: string[] = [];
    const answered: Array<{ requestId: string; approved: boolean }> = [];
    return {
      shown,
      answered,
      ask: async (message: string) => {
        shown.push(message);
        return answer;
      },
      respond: async (requestId: string, approved: boolean) => {
        answered.push({ requestId, approved });
      },
    };
  }

  const REQ = {
    requestId: "r1",
    toolName: "generated_tg_a",
    description: "d",
    body: "console.log(1)",
    approvedHosts: ["a.example.com"],
    credentialHosts: [],
  };

  test("approves only on an explicit true", async () => {
    const h = harness(true);
    await handleToolApprovalBroadcast(REQ, h.ask, h.respond);
    expect(h.answered).toEqual([{ requestId: "r1", approved: true }]);
    expect(h.shown[0]).toContain("console.log(1)");
  });

  test("a plain false is a denial", async () => {
    const h = harness(false);
    await handleToolApprovalBroadcast(REQ, h.ask, h.respond);
    expect(h.answered[0]?.approved).toBe(false);
  });

  // A review comment asked for `@clack/prompts`'s canonical `CANCEL_SYMBOL` here instead of the
  // registered symbol below, on the grounds that `isCancel(Symbol.for("clack:cancel"))` is false
  // and so this test never reaches the cancel arm. The first half is correct and is why the test
  // changed. The suggested fix is not available: `CANCEL_SYMBOL` is NOT exported by
  // `@clack/prompts` (v1.7) -- `isCancel` closes over a module-private, UNREGISTERED `Symbol()`,
  // verified by probing the package -- so importing it would not compile, and there is no value a
  // test can construct for which `isCancel` returns true.
  //
  // What actually makes cancellation safe is therefore not `isCancel` at all: it is the
  // `answer === true` conjunct, which admits ONLY the boolean. A cancel is one member of the set
  // of non-`true` answers, so pinning the whole set is a stronger statement than pinning the one
  // member would have been, and it does not depend on a private symbol staying private.
  test.each([
    ["a foreign symbol standing in for a cancel", Symbol.for("clack:cancel")],
    ["a bare symbol", Symbol("anything")],
    ["undefined, as an abandoned prompt yields", undefined],
    ["null", null],
    ["the STRING 'true', not the boolean", "true"],
    ["1, which is truthy but not true", 1],
    ["an object", {}],
  ])("%s is a denial, never an approval", async (_label, answer) => {
    const h = harness(answer);
    await handleToolApprovalBroadcast(REQ, h.ask, h.respond);
    expect(h.answered[0]?.approved).toBe(false);
  });

  test("a broadcast with no usable requestId is IGNORED, not answered", async () => {
    for (const bad of [{}, { requestId: "" }, { requestId: 7 }, undefined]) {
      const h = harness(true);
      await handleToolApprovalBroadcast(bad, h.ask, h.respond);
      expect(h.answered).toEqual([]);
      expect(h.shown).toEqual([]);
    }
  });

  test("survives non-string / non-array fields rather than throwing before responding", async () => {
    const h = harness(false);
    await handleToolApprovalBroadcast(
      { requestId: "r4", toolName: 7, body: {}, approvedHosts: "nope" },
      h.ask,
      h.respond,
    );
    expect(h.answered[0]?.requestId).toBe("r4");
    expect(h.shown[0]).toContain("none"); // malformed hosts render as "none", not a crash
  });

  test("a malformed inputSchema renders as 'none', never throws before responding", async () => {
    const h = harness(false);
    await handleToolApprovalBroadcast(
      { ...REQ, requestId: "r5", inputSchema: "not a schema" },
      h.ask,
      h.respond,
    );
    expect(h.answered[0]?.requestId).toBe("r5");
    expect(h.shown[0]).toContain("parameters:       none");
  });

  test("a malformed grounding renders as description_only, never throws before responding", async () => {
    const h = harness(false);
    await handleToolApprovalBroadcast(
      { ...REQ, requestId: "r6", grounding: { kind: "not-a-real-kind" } },
      h.ask,
      h.respond,
    );
    expect(h.answered[0]?.requestId).toBe("r6");
    expect(h.shown[0]).toContain("no indexed API specification");
  });

  test("an inputSchema/grounding entirely absent from the broadcast still renders safely", async () => {
    const h = harness(false);
    await handleToolApprovalBroadcast({ requestId: "r7" }, h.ask, h.respond);
    expect(h.answered[0]?.requestId).toBe("r7");
    expect(h.shown[0]).toContain("parameters:       none");
    expect(h.shown[0]).toContain("no indexed API specification");
  });
});

function fakeSink(): OutcomeSink & { readonly errText: string; readonly outText: string } {
  const errChunks: string[] = [];
  const outChunks: string[] = [];
  return {
    out: (s) => outChunks.push(s),
    err: (s) => errChunks.push(s),
    get errText() {
      return errChunks.join("");
    },
    get outText() {
      return outChunks.join("");
    },
  };
}

describe("renderToolOutcome — the drafting refusal is surfaced honestly", () => {
  // PR 1's special-cased ERR_TOOLGEN_DRAFT_NOT_IMPLEMENTED message (naming the design spec) is
  // gone -- the stub it explained no longer exists as a permanent-for-this-release refusal, so it
  // now falls through to the same generic "refused (<code>)" line as any other refusal code.
  test("ERR_TOOLGEN_DRAFT_NOT_IMPLEMENTED falls through to the generic refusal message", () => {
    const sink = fakeSink();
    renderToolOutcome({ status: "refused", code: "ERR_TOOLGEN_DRAFT_NOT_IMPLEMENTED" }, sink);
    expect(sink.errText).toContain("nimbus: refused (ERR_TOOLGEN_DRAFT_NOT_IMPLEMENTED)");
  });

  test("a different refused code still gets an honest, distinguishable message", () => {
    const err: string[] = [];
    renderToolOutcome(
      { status: "refused", code: "ERR_TOOLGEN_DISABLED" },
      { out: () => {}, err: (s) => err.push(s) },
    );
    expect(err.join("")).toContain("ERR_TOOLGEN_DISABLED");
  });

  test("registered prints the tool id to stdout", () => {
    const out: string[] = [];
    renderToolOutcome(
      { status: "registered", toolId: "tg_a" },
      { out: (s) => out.push(s), err: () => {} },
    );
    expect(out.join("")).toContain("tg_a");
  });

  test("ERR_TOOLGEN_DRAFT_INVALID from a local model names both ways out", () => {
    const sink = fakeSink();
    renderToolOutcome(
      { status: "refused", code: "ERR_TOOLGEN_DRAFT_INVALID", locality: "local" },
      sink,
    );
    expect(sink.errText).toContain("allow-remote");
    expect(sink.errText).toContain("min_reasoning_params");
  });

  // Suggesting a bigger local model to someone already on a frontier model is noise, not help.
  test("ERR_TOOLGEN_DRAFT_INVALID from a REMOTE model does NOT show the local-model hint", () => {
    const sink = fakeSink();
    renderToolOutcome(
      { status: "refused", code: "ERR_TOOLGEN_DRAFT_INVALID", locality: "remote" },
      sink,
    );
    expect(sink.errText).not.toContain("min_reasoning_params");
    expect(sink.errText).not.toContain("allow-remote");
  });

  // A refusal decided before drafting (e.g. disabled/policy) never carries a locality at all --
  // the hint must not fire just because the code happens to match with no locality present.
  test("ERR_TOOLGEN_DRAFT_INVALID with no locality at all does NOT show the hint", () => {
    const sink = fakeSink();
    renderToolOutcome({ status: "refused", code: "ERR_TOOLGEN_DRAFT_INVALID" }, sink);
    expect(sink.errText).not.toContain("min_reasoning_params");
  });

  test("ERR_TOOLGEN_DRAFT_NOT_IMPLEMENTED is gone from the CLI", () => {
    // Anchored to this test file's own directory, not the process cwd: the coverage-floor build
    // (scripts/coverage-floor/build-lcov.sh) `cd`s into each package before running its tests, so
    // a repo-root-relative path resolves wrong there even though it looks fine from repo root.
    expect(readFileSync(join(import.meta.dir, "tool.ts"), "utf8")).not.toContain(
      "DRAFT_NOT_IMPLEMENTED",
    );
  });
});

describe("renderToolList", () => {
  test("never renders a credential value -- only credential HOST names ever reach the wire shape", () => {
    const text = renderToolList([
      {
        toolId: "tg_a",
        toolName: "generated_tg_a",
        description: "d",
        approvedHosts: ["a.example.com"],
        credentialHosts: ["a.example.com"],
        approvedAt: 0,
        saved: false,
        needsCredentials: false,
        disabledReason: null,
      },
    ]);
    expect(text).toContain("credential hosts: a.example.com");
  });

  test("an empty list says so rather than printing nothing", () => {
    expect(renderToolList([])).toContain("No active generated tools");
  });

  test("marks a saved tool as saved and an ephemeral one as ephemeral", () => {
    const text = renderToolList([
      {
        toolId: "tg_saved",
        toolName: "generated_tg_saved",
        description: "d",
        approvedHosts: [],
        credentialHosts: [],
        approvedAt: 0,
        saved: true,
        needsCredentials: false,
        disabledReason: null,
      },
      {
        toolId: "tg_eph",
        toolName: "generated_tg_eph",
        description: "d",
        approvedHosts: [],
        credentialHosts: [],
        approvedAt: 0,
        saved: false,
        needsCredentials: false,
        disabledReason: null,
      },
    ]);
    expect(text).toContain("tg_saved  generated_tg_saved — d  (saved)");
    expect(text).toContain("tg_eph  generated_tg_eph — d  (ephemeral)");
  });

  test("shows a needs-credentials hint for a saved tool that lost its Vault binding", () => {
    const text = renderToolList([
      {
        toolId: "tg_a",
        toolName: "t",
        description: "d",
        approvedHosts: ["api.example.com"],
        credentialHosts: ["api.example.com"],
        approvedAt: 0,
        saved: true,
        needsCredentials: true,
        disabledReason: null,
      },
    ]);
    expect(text).toContain("needs credentials");
    expect(text).toContain("nimbus tool credential set");
  });

  test("shows a saved tool's disabledReason rather than hiding a broken one", () => {
    const text = renderToolList([
      {
        toolId: "tg_a",
        toolName: "t",
        description: "d",
        approvedHosts: [],
        credentialHosts: [],
        approvedAt: 0,
        saved: true,
        needsCredentials: false,
        disabledReason: "signature_mismatch",
      },
    ]);
    expect(text).toContain("DISABLED: signature_mismatch");
  });
});

function fakeDeps(over: Partial<RunToolDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const codes: number[] = [];
  const calls: Array<{ method: string; params: unknown }> = [];
  let notify: ((params: unknown) => unknown) | undefined;
  const client: ToolClient = {
    onNotification: (_m, h) => {
      notify = h;
    },
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === "toolgen.create") {
        return { status: "refused", code: "ERR_TOOLGEN_DISABLED" };
      }
      if (method === "toolgen.save") {
        return { status: "refused", code: "ERR_TOOLGEN_SAVE_DISABLED" };
      }
      if (method === "toolgen.list") {
        return { tools: [] };
      }
      return { matched: true };
    },
  };
  const base: RunToolDeps = {
    runWithClient: async (fn) => fn(client),
    ask: async () => true,
    sink: { out: (s) => out.push(s), err: (s) => err.push(s) },
    setExitCode: (c) => codes.push(c),
    isInteractiveTty: () => true,
    ...over,
  };
  return { out, err, codes, calls, notifier: () => notify, d: base };
}

describe("runTool create — non-TTY refusal (load-bearing #1)", () => {
  test("a non-interactive stdin refuses BEFORE any gateway call is made", async () => {
    const h = fakeDeps({ isInteractiveTty: () => false });
    await runTool(["create", "--description", "d", "--host", "a.example.com"], h.d);
    // This is the property that matters: if the TTY check were deleted, `calls` would contain a
    // `toolgen.create` entry. Asserting on the CALL LIST, not just the exit code, is what makes
    // this test fail for the right reason.
    expect(h.calls).toEqual([]);
    expect(h.codes).toEqual([TOOL_EXIT_CODES.refused]);
    expect(h.err.join("")).toContain("interactive TTY");
    expect(h.err.join("")).toContain("LAN-forbidden and local-only");
  });

  test("an interactive TTY proceeds to call the gateway", async () => {
    const h = fakeDeps({ isInteractiveTty: () => true });
    await runTool(["create", "--description", "d", "--host", "a.example.com"], h.d);
    expect(h.calls.some((c) => c.method === "toolgen.create")).toBe(true);
  });
});

describe("runTool create — the credential IS sent, as a bearer binding, once", () => {
  test("a --credential host=token pair reaches toolgen.create as {host, token}", async () => {
    const SECRET = "sk_live_now_sent_over_ipc_1a2b3c";
    const h = fakeDeps();
    await runTool(
      [
        "create",
        "--description",
        "d",
        "--host",
        "a.example.com",
        "--credential",
        `a.example.com=${SECRET}`,
      ],
      h.d,
    );
    const createCall = h.calls.find((c) => c.method === "toolgen.create");
    expect(createCall).toBeDefined();
    const params = createCall?.params as Record<string, unknown>;
    // The gateway now consumes this field (Task 10) -- the `<host>=<token>` the owner typed reaches
    // `toolgen.create` as exactly one `{host, token}` pair, not zero and not duplicated.
    expect(params["credentials"]).toEqual([{ host: "a.example.com", token: SECRET }]);
  });

  test("no --credential at all still sends an EMPTY credentials array, not an absent field", async () => {
    const h = fakeDeps();
    await runTool(["create", "--description", "d", "--host", "a.example.com"], h.d);
    const createCall = h.calls.find((c) => c.method === "toolgen.create");
    const params = createCall?.params as Record<string, unknown>;
    expect(params["credentials"]).toEqual([]);
  });
});

describe("runTool create — credentials never echoed (load-bearing #2)", () => {
  test("a --credential token never appears in any rendered output, including on failure", async () => {
    const SECRET = "sk_live_super_secret_value_9f8e7d";
    const h = fakeDeps();
    await runTool(
      [
        "create",
        "--description",
        "d",
        "--host",
        "a.example.com",
        "--credential",
        `a.example.com=${SECRET}`,
      ],
      h.d,
    );
    const everything = [...h.out, ...h.err].join("\n");
    expect(everything).not.toContain(SECRET);
  });

  test("a --bearer token given to credential set never appears in any rendered output", async () => {
    const SECRET = "sk_live_another_secret_value";
    const h = fakeDeps();
    await runTool(["credential", "set", "tg_a", "a.example.com", "--bearer", SECRET], h.d);
    const everything = [...h.out, ...h.err].join("\n");
    expect(everything).not.toContain(SECRET);
  });

  test("--json list output never carries a credential value", async () => {
    const client: ToolClient = {
      onNotification: () => {},
      call: async (method) => {
        if (method === "toolgen.list") {
          return {
            tools: [
              {
                toolId: "tg_a",
                toolName: "generated_tg_a",
                description: "d",
                approvedHosts: ["a.example.com"],
                credentialHosts: ["a.example.com"],
                approvedAt: 0,
              },
            ],
          };
        }
        return {};
      },
    };
    const h = fakeDeps({ runWithClient: async (fn) => fn(client) });
    await runTool(["list", "--json"], h.d);
    const text = h.out.join("");
    expect(text).toContain("a.example.com"); // the host is expected to show
    expect(text).not.toMatch(/token|bearer|password|secret/i);
  });
});

describe("runTool revoke — drops both halves via one RPC call (load-bearing #3)", () => {
  test("calls toolgen.revoke with the tool id -- the gateway-side handler drops the registry AND the on-disk script for this one call", async () => {
    const h = fakeDeps();
    await runTool(["revoke", "tg_a"], h.d);
    expect(h.calls).toEqual([{ method: "toolgen.revoke", params: { toolId: "tg_a" } }]);
    expect(h.out.join("")).toContain("Revoked tg_a");
  });
});

describe("runTool credential set — a real gateway call (no longer a permanent refusal stub)", () => {
  test("calls toolgen.credentialSet with the tool id, host, and a bearer binding", async () => {
    const h = fakeDeps();
    await runTool(["credential", "set", "tg_a", "a.example.com", "--bearer", "t"], h.d);
    expect(h.calls).toEqual([
      {
        method: "toolgen.credentialSet",
        params: {
          toolId: "tg_a",
          host: "a.example.com",
          binding: { type: "bearer", token: "t" },
        },
      },
    ]);
    expect(h.out.join("")).toContain("Credential bound for tg_a @ a.example.com");
  });

  test("sends a header binding as {type, headerName, value}", async () => {
    const h = fakeDeps();
    await runTool(
      ["credential", "set", "tg_a", "a.example.com", "--header", "X-Api-Key", "v"],
      h.d,
    );
    const call = h.calls.find((c) => c.method === "toolgen.credentialSet");
    expect((call?.params as { binding: unknown })?.binding).toEqual({
      type: "header",
      headerName: "X-Api-Key",
      value: "v",
    });
  });

  test("sends a basic binding as {type, username, password}", async () => {
    const h = fakeDeps();
    await runTool(["credential", "set", "tg_a", "a.example.com", "--basic", "u", "p"], h.d);
    const call = h.calls.find((c) => c.method === "toolgen.credentialSet");
    expect((call?.params as { binding: unknown })?.binding).toEqual({
      type: "basic",
      username: "u",
      password: "p",
    });
  });

  test("a gateway refusal (e.g. an unknown credential host) is reported and exits refused", async () => {
    // Mirrors the REAL gateway message shape (`ipc/toolgen-rpc.ts`'s `toolgen.credentialSet`
    // handler): named codes travel on `.code`, never embedded into `.message` -- see that file's
    // own comment on why (Task 1 of this branch reverted the embedded-code pattern once already).
    const h = fakeDeps({
      runWithClient: async (fn) =>
        fn({
          onNotification: () => {},
          call: async () => {
            throw new Error(
              'host "evil.com" (normalised: "evil.com") is not among tool "tg_a"\'s approved credential hosts: []',
            );
          },
        }),
    });
    await runTool(["credential", "set", "tg_a", "evil.com", "--bearer", "t"], h.d);
    expect(h.err.join("")).toContain("is not among tool");
    expect(h.err.join("")).toContain("approved credential hosts");
    expect(h.codes).toEqual([TOOL_EXIT_CODES.refused]);
  });
});

describe("runTool save — non-TTY refusal, mirroring create", () => {
  test("a non-interactive stdin refuses BEFORE any gateway call is made", async () => {
    const h = fakeDeps({ isInteractiveTty: () => false });
    await runTool(["save", "tg_a"], h.d);
    expect(h.calls).toEqual([]);
    expect(h.codes).toEqual([TOOL_EXIT_CODES.refused]);
    expect(h.err.join("")).toContain("interactive TTY");
    expect(h.err.join("")).toContain("LAN-forbidden and local-only");
  });
});

describe("runTool save — calls toolgen.save and renders every outcome", () => {
  test("nimbus tool save <id> calls toolgen.save with the tool id", async () => {
    const h = fakeDeps({
      runWithClient: async (fn) =>
        fn({
          onNotification: () => {},
          call: async (method, params) => {
            h.calls.push({ method, params });
            if (method === "toolgen.save") return { status: "saved", toolId: "tg_a" };
            return { matched: true };
          },
        }),
    });
    await runTool(["save", "tg_a"], h.d);
    expect(h.calls).toEqual([{ method: "toolgen.save", params: { toolId: "tg_a" } }]);
    expect(h.out.join("")).toContain("Tool saved: tg_a");
    // `runSaveCmd` always calls `setExitCode`, mirroring `runCreateCmd` -- a success still sets 0
    // explicitly rather than leaving the process's ambient default to do it.
    expect(h.codes).toEqual([0]);
  });

  test("with no id exits non-zero with usage", async () => {
    const h = fakeDeps();
    await runTool(["save"], h.d);
    expect(h.calls).toEqual([]);
    expect(h.codes).toEqual([TOOL_EXIT_CODES.refused]);
    expect(h.err.join("")).toContain("a tool id is required");
    expect(h.err.join("")).toContain("Usage");
  });

  test("already_saved and repaired both exit 0 -- neither is an error", async () => {
    for (const status of ["already_saved", "repaired"] as const) {
      const h = fakeDeps({
        runWithClient: async (fn) =>
          fn({ onNotification: () => {}, call: async () => ({ status, toolId: "tg_a" }) }),
      });
      await runTool(["save", "tg_a"], h.d);
      expect(h.codes).toEqual([0]);
      expect(h.out.join("")).toContain("tg_a");
    }
  });

  test("a denial is reported on stderr with the DENIED exit code, not confused with a refusal", async () => {
    const h = fakeDeps({
      runWithClient: async (fn) =>
        fn({ onNotification: () => {}, call: async () => ({ status: "denied" }) }),
    });
    await runTool(["save", "tg_a"], h.d);
    expect(h.codes).toEqual([TOOL_EXIT_CODES.denied]);
    expect(h.err.join("")).toContain("denied");
  });

  test("a refusal reports the code and exits refused", async () => {
    const h = fakeDeps({
      runWithClient: async (fn) =>
        fn({
          onNotification: () => {},
          call: async () => ({ status: "refused", code: "ERR_TOOLGEN_SAVE_NOT_LIVE" }),
        }),
    });
    await runTool(["save", "tg_a"], h.d);
    expect(h.codes).toEqual([TOOL_EXIT_CODES.refused]);
    expect(h.err.join("")).toContain("ERR_TOOLGEN_SAVE_NOT_LIVE");
  });
});

describe("runTool save — the save approval prompt discloses PERSISTENCE, and answers over its OWN broker", () => {
  test("registers toolgen.saveApprovalRequest and answers via toolgen.saveApprovalRespond -- never the create pair", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    let notify: ((params: unknown) => unknown) | undefined;
    const client: ToolClient = {
      onNotification: (method, h) => {
        // Only the SAVE method may be registered on this call -- registering
        // `toolgen.approvalRequest` here would mean `runSaveCmd` wired the wrong broker's prompt.
        expect(method).toBe("toolgen.saveApprovalRequest");
        notify = h;
      },
      call: async (method, params) => {
        calls.push({ method, params });
        if (method === "toolgen.save") {
          // Simulate the gateway broadcasting mid-call, the way `ConsentBroker.request` does.
          await notify?.({
            requestId: "r1",
            toolId: "tg_a",
            toolName: "generated_tg_a",
            description: "d",
            body: "return 1;",
            approvedHosts: ["a.example.com"],
            credentialHosts: [],
            initiator: "owner",
            persistence: true,
          });
          return { status: "saved", toolId: "tg_a" };
        }
        return { matched: true };
      },
    };
    const shown: string[] = [];
    const h = fakeDeps({
      runWithClient: async (fn) => fn(client),
      ask: async (message: string) => {
        shown.push(message);
        return true;
      },
    });
    await runTool(["save", "tg_a"], h.d);
    // The prompt discloses that this is a STANDING approval, distinct from create's copy.
    expect(shown[0]).toContain("EVERY future session");
    expect(shown[0]).toContain("STANDING APPROVAL");
    // Answered via the SAVE broker's own respond method, never `toolgen.approvalRespond`.
    const respond = calls.find((c) => c.method.endsWith("ApprovalRespond"));
    expect(respond?.method).toBe("toolgen.saveApprovalRespond");
    expect(respond?.params).toEqual({ requestId: "r1", approved: true });
  });
});

describe("runTool create — the approval prompt shows the VERBATIM body (load-bearing #4)", () => {
  test("the body the owner is asked to approve reaches `ask` unmodified", async () => {
    const BODY = "export default async function main() { return 42; }";
    const shown: string[] = [];
    const client: ToolClient = {
      onNotification: (_m, h) => {
        // Simulate the gateway broadcasting the approval request mid-call, the way
        // `createGeneratedTool` does via `ConsentBroker.request`.
        void h({
          requestId: "r1",
          toolId: "tg_a",
          toolName: "generated_tg_a",
          description: "d",
          body: BODY,
          approvedHosts: ["a.example.com"],
          credentialHosts: [],
          initiator: "owner",
        });
      },
      call: async (method) => {
        if (method === "toolgen.create") return { status: "registered", toolId: "tg_a" };
        return { matched: true };
      },
    };
    const h = fakeDeps({
      runWithClient: async (fn) => fn(client),
      ask: async (message: string) => {
        shown.push(message);
        return true;
      },
    });
    await runTool(["create", "--description", "d", "--host", "a.example.com"], h.d);
    expect(shown[0]).toContain(BODY);
  });
});

describe("runTool — CLI_TOOLGEN_SESSION_ID is stable across invocations", () => {
  test("create and list use the SAME session id, so list can find what create registered", async () => {
    const createH = fakeDeps();
    await runTool(["create", "--description", "d", "--host", "a.example.com"], createH.d);
    const createCall = createH.calls.find((c) => c.method === "toolgen.create");
    if (createCall === undefined) throw new Error("expected a toolgen.create call");
    expect((createCall.params as { sessionId: string }).sessionId).toBe(CLI_TOOLGEN_SESSION_ID);

    const listH = fakeDeps();
    await runTool(["list"], listH.d);
    const listCall = listH.calls.find((c) => c.method === "toolgen.list");
    if (listCall === undefined) throw new Error("expected a toolgen.list call");
    expect((listCall.params as { sessionId: string }).sessionId).toBe(CLI_TOOLGEN_SESSION_ID);
  });
});

describe("runTool orchestration — general", () => {
  test("an ARG error never opens a connection, and exits refused", async () => {
    const h = fakeDeps();
    await runTool(["create", "--allow-net"], h.d);
    expect(h.calls).toEqual([]);
    expect(h.codes).toEqual([TOOL_EXIT_CODES.refused]);
    expect(h.err.join("")).toContain("Unknown flag");
  });

  test("a transport failure is reported and exits refused, never 0", async () => {
    const h = fakeDeps({
      runWithClient: async () => {
        throw new Error("Gateway is not running");
      },
    });
    await runTool(["create", "--description", "d", "--host", "a.example.com"], h.d);
    expect(h.err.join("")).toContain("Gateway is not running");
    expect(h.codes).toEqual([TOOL_EXIT_CODES.refused]);
  });

  test("registers the approval handler, which answers over the SAME client", async () => {
    const h = fakeDeps();
    await runTool(["create", "--description", "d", "--host", "a.example.com"], h.d);
    const notify = h.notifier();
    expect(notify).toBeDefined();
    await notify?.({
      requestId: "r9",
      toolId: "tg_a",
      toolName: "generated_tg_a",
      description: "d",
      body: "1",
      approvedHosts: ["a.example.com"],
      credentialHosts: [],
    });
    const respond = h.calls.find((c) => c.method === "toolgen.approvalRespond");
    expect(respond?.params).toEqual({ requestId: "r9", approved: true });
  });
});
describe("parseToolArgs -- a flag whose value is missing is refused, never defaulted", () => {
  // A trailing flag with no value is the classic shell typo (`--host` then a newline). Defaulting
  // it to the empty string would approve a tool for a host list the owner did not type.
  test.each([
    ["--description at the end of argv", ["create", "--host", "a.example.com", "--description"]],
    ["--host at the end of argv", ["create", "--description", "d", "--host"]],
    ["--credential at the end of argv", ["create", "--description", "d", "--credential"]],
  ])("%s throws", (_label, argv) => {
    expect(() => parseToolArgs(argv)).toThrow(/requires a value/);
  });

  test.each([
    ["--bearer with no token", ["credential", "set", "tg_a", "h.example.com", "--bearer"]],
    ["--header with no value", ["credential", "set", "tg_a", "h.example.com", "--header", "X-A"]],
    ["--basic with no password", ["credential", "set", "tg_a", "h.example.com", "--basic", "u"]],
  ])("credential set: %s throws", (_label, argv) => {
    expect(() => parseToolArgs(argv)).toThrow(/requires a value/);
  });
});

describe("parseToolArgs -- malformed --credential is refused rather than half-read", () => {
  test.each([
    ["no '=' at all", "api.example.com"],
    ["a leading '=' (empty host)", "=token"],
  ])("%s is refused", (_label, raw) => {
    expect(() =>
      parseToolArgs([
        "create",
        "--description",
        "d",
        "--host",
        "api.example.com",
        "--credential",
        raw,
      ]),
    ).toThrow(/must be <host>=<token>/);
  });
});

describe("parseToolArgs -- the remaining refusal arms", () => {
  test("an unknown flag on list throws rather than being ignored", () => {
    expect(() => parseToolArgs(["list", "--verbose"])).toThrow(/Unknown flag/);
  });

  test("an unknown flag on credential set throws", () => {
    expect(() =>
      parseToolArgs(["credential", "set", "tg_a", "h.example.com", "--bearer", "t", "--force"]),
    ).toThrow(/Unknown flag/);
  });

  test("credential set with a tool id but no host names the missing host, not the tool id", () => {
    expect(() => parseToolArgs(["credential", "set", "tg_a", "--bearer", "t"])).toThrow(
      /a host is required/,
    );
  });

  test("credential set with neither a tool id nor a host names the tool id first", () => {
    expect(() => parseToolArgs(["credential", "set", "--bearer", "t"])).toThrow(
      /a tool id is required/,
    );
  });

  test("extra positionals past <tool-id> <host> are ignored rather than shifting the meaning", () => {
    // `positional[0]`/`[1]` are read by index, so a stray third word must not become the host.
    const parsed = parseToolArgs([
      "credential",
      "set",
      "tg_a",
      "h.example.com",
      "stray",
      "--bearer",
      "t",
    ]);
    expect(parsed).toMatchObject({ sub: "credential-set", toolId: "tg_a", host: "h.example.com" });
  });

  test("'nimbus tool credential' with no action at all is refused, not treated as 'set'", () => {
    expect(() => parseToolArgs(["credential"])).toThrow(/Unknown "nimbus tool credential"/);
  });

  test("revoke with a flag where the tool id belongs is refused, not read as an id", () => {
    expect(() => parseToolArgs(["revoke", "--all"])).toThrow(/a tool id is required/);
  });
});

describe("renderToolOutcome -- every status arm", () => {
  function sunk(): { sink: OutcomeSink; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return { sink: { out: (s) => out.push(s), err: (s) => err.push(s) }, out, err };
  }

  test("a DENIAL is reported on stderr and is not confused with a refusal", () => {
    const s = sunk();
    renderToolOutcome({ status: "denied" }, s.sink);
    expect(s.err.join("")).toContain("denied");
    // The owner said no; there is no error code to show and none is invented.
    expect(s.err.join("")).not.toContain("refused");
    expect(s.out).toHaveLength(0);
  });

  test("a registered outcome with no toolId says so rather than printing 'undefined'", () => {
    const s = sunk();
    renderToolOutcome({ status: "registered" }, s.sink);
    expect(s.out.join("")).toContain("(unknown id)");
  });

  test("a refusal with no code at all still names itself a refusal", () => {
    const s = sunk();
    renderToolOutcome({ status: "refused" }, s.sink);
    expect(s.err.join("")).toContain("unknown");
  });
});

describe("renderToolList -- a nonsensical approvedAt is disclosed, not rendered as a fake date", () => {
  test("a non-finite timestamp prints the raw value rather than 'Invalid Date'", () => {
    const rendered = renderToolList([
      {
        toolId: "tg_a",
        toolName: "t",
        description: "d",
        approvedHosts: ["api.example.com"],
        credentialHosts: [],
        approvedAt: Number.NaN,
        saved: false,
        needsCredentials: false,
        disabledReason: null,
      },
    ]);
    expect(rendered).toContain("unknown (NaN)");
  });
});

describe("runTool list -- a malformed wire shape degrades to fewer entries, never a wrong one", () => {
  function listing(res: unknown) {
    const h = fakeDeps({
      runWithClient: async (fn) =>
        fn({
          onNotification: () => {},
          call: async () => res,
        }),
    });
    return h;
  }

  test("entries missing a required string field are DROPPED, not rendered with blanks", async () => {
    const h = listing({
      tools: [
        {
          toolId: "tg_ok",
          toolName: "ok",
          description: "d",
          approvedHosts: [],
          credentialHosts: [],
        },
        { toolName: "no-id", description: "d" },
        { toolId: "tg_b", description: "d" },
        { toolId: "tg_c", toolName: "c" },
        "not an object at all",
      ],
    });
    await runTool(["list"], h.d);
    const out = h.out.join("");
    expect(out).toContain("tg_ok");
    expect(out).not.toContain("tg_b");
    expect(out).not.toContain("tg_c");
    expect(out).not.toContain("no-id");
  });

  test("a non-string host array is emptied rather than partially rendered", async () => {
    const h = listing({
      tools: [
        {
          toolId: "tg_a",
          toolName: "t",
          description: "d",
          approvedHosts: ["api.example.com", 42],
          credentialHosts: "not-an-array",
          approvedAt: "not-a-number",
        },
      ],
    });
    await runTool(["list"], h.d);
    const out = h.out.join("");
    // Neither the good element nor a coerced form of the bad one survives -- an all-or-nothing
    // read, so the owner never sees a host list that is a subset of the real one.
    expect(out).not.toContain("api.example.com");
    expect(out).toContain("hosts: none");
  });

  test("a response with no tools array at all renders the empty listing", async () => {
    const h = listing({ notTools: 1 });
    await runTool(["list"], h.d);
    expect(h.out.join("")).toContain("No active generated tools.");
  });

  test("a non-record response renders the empty listing rather than throwing", async () => {
    const h = listing("nope");
    await runTool(["list"], h.d);
    expect(h.out.join("")).toContain("No active generated tools.");
  });
});

describe("runTool -- a transport failure is reported and sets the refused exit code", () => {
  function throwing(thrown: unknown) {
    return fakeDeps({
      runWithClient: async () => {
        throw thrown;
      },
    });
  }

  test.each([
    ["list", ["list"]],
    ["revoke", ["revoke", "tg_a"]],
    ["create", ["create", "--description", "d", "--host", "api.example.com"]],
    ["save", ["save", "tg_a"]],
    ["credential set", ["credential", "set", "tg_a", "api.example.com", "--bearer", "t"]],
  ])("%s surfaces an Error's message", async (_label, argv) => {
    const h = throwing(new Error("gateway is not running"));
    await runTool(argv, h.d);
    expect(h.err.join("")).toContain("gateway is not running");
    expect(h.codes).toContain(TOOL_EXIT_CODES.refused);
  });

  test.each([
    ["list", ["list"]],
    ["revoke", ["revoke", "tg_a"]],
    ["create", ["create", "--description", "d", "--host", "api.example.com"]],
    ["save", ["save", "tg_a"]],
    ["credential set", ["credential", "set", "tg_a", "api.example.com", "--bearer", "t"]],
  ])("%s surfaces a NON-Error throw rather than printing nothing", async (_label, argv) => {
    // A rejected promise carrying a bare string is the shape that would otherwise render as
    // "undefined" and leave the operator with no idea what failed.
    const h = throwing("socket closed");
    await runTool(argv, h.d);
    expect(h.err.join("")).toContain("socket closed");
    expect(h.codes).toContain(TOOL_EXIT_CODES.refused);
  });

  test("an argv parse failure is reported before any gateway connection is attempted", async () => {
    const h = fakeDeps();
    await runTool(["nonsense"], h.d);
    expect(h.err.join("")).toContain('Unknown "nimbus tool" subcommand');
    expect(h.codes).toEqual([TOOL_EXIT_CODES.refused]);
    expect(h.calls).toHaveLength(0);
  });
});

describe("runTool revoke -- the success path reports the id it dropped", () => {
  test("prints the revoked tool id on stdout and leaves the exit code at 0", async () => {
    const h = fakeDeps();
    await runTool(["revoke", "tg_a"], h.d);
    expect(h.out.join("")).toContain("Revoked tg_a.");
    expect(h.codes).toHaveLength(0);
  });

  // This command is the WITHDRAWAL PATH the save prompt names by name ("...until you
  // `nimbus tool revoke` it"). An owner withdrawing a STANDING approval is told that a durable
  // copy was actually found and dropped -- not merely that a call returned.
  test("discloses that a SAVED copy was dropped, when the gateway says one was", async () => {
    const h = fakeDeps({
      runWithClient: async (fn) =>
        fn({
          onNotification: () => {},
          call: async () => ({ revoked: true, savedRemoved: true }),
        }),
    });
    await runTool(["revoke", "tg_a"], h.d);
    expect(h.out.join("")).toContain("Revoked tg_a.");
    expect(h.out.join("")).toContain("saved copy is gone");
    expect(h.codes).toHaveLength(0);
  });

  test("does NOT claim a saved copy was dropped when the gateway did not say so", async () => {
    // Fail-quiet on the disclosure specifically: an ephemeral-only revoke, and any gateway whose
    // response shape this CLI does not recognise, must not assert something durable was removed.
    const h = fakeDeps({
      runWithClient: async (fn) =>
        fn({ onNotification: () => {}, call: async () => ({ revoked: true }) }),
    });
    await runTool(["revoke", "tg_a"], h.d);
    expect(h.out.join("")).toContain("Revoked tg_a.");
    expect(h.out.join("")).not.toContain("saved copy");
  });
});
