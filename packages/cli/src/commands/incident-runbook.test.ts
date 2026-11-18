import { describe, expect, test } from "bun:test";

import { INCIDENT_USAGE } from "./incident-format.ts";
import {
  formatRunbooks,
  parseRunbookArgs,
  type RunbooksReplyLike,
  type RunReplyLike,
  runRunbookWith,
} from "./incident-runbook.ts";

const TTY = { stdin: true, stdout: true };

describe("parseRunbookArgs", () => {
  test("list, a named runbook, a step and a done", () => {
    expect(parseRunbookArgs(["inc_1"])).toEqual({ id: "inc_1", json: false });
    expect(parseRunbookArgs(["inc_1", "--json", "--runbook", "pay"])).toEqual({
      id: "inc_1",
      json: true,
      runbook: "pay",
    });
    expect(parseRunbookArgs(["--runbook", "pay", "inc_1", "--step", "3"])).toEqual({
      id: "inc_1",
      json: false,
      runbook: "pay",
      step: 3,
    });
    expect(parseRunbookArgs(["inc_1", "--runbook", "pay", "--done", "50", "--json"])).toMatchObject(
      { done: 50 },
    );
    expect(INCIDENT_USAGE).toContain("nimbus incident runbook <id>");
  });

  test("malformed, duplicated, conflicting and consent-shortcut forms are refused", () => {
    for (const bad of [
      [],
      ["inc_1", "inc_2"],
      ["inc_1", "--json", "--json"],
      ["inc_1", "--runbook", "Bad Name"],
      ["inc_1", "--runbook"],
      ["inc_1", "--step", "1"],
      ["inc_1", "--runbook", "p", "--step", "0"],
      ["inc_1", "--runbook", "p", "--step", "51"],
      ["inc_1", "--runbook", "p", "--step", "x"],
      ["inc_1", "--runbook", "p", "--step", "1", "--done", "2"],
      ["inc_1", "--runbook", "p", "--step", "1", "--json"],
      ["inc_1", "--runbook", "p", "--step", "1", "--yes"],
      ["inc_1", "-y"],
      ["inc_1", "--script-consent-source=x"],
      ["--weird"],
    ]) {
      expect(parseRunbookArgs(bad), bad.join(" ")).toBeUndefined();
    }
  });
});

const REPLY: RunbooksReplyLike = {
  recordId: "inc_0000000000000001",
  version: 2,
  advisory: false,
  runbooks: [
    {
      name: "pay-rollback",
      description: "Roll \u001b[31mback\u001b[0m",
      file: "pay.toml",
      matched: true,
      steps: [
        { n: 1, kind: "check", text: "Open the dashboard", status: "done" },
        {
          n: 2,
          kind: "read",
          service: "argocd",
          tool: "argocd_get",
          params: { name: "{binding.argocd_app}" },
          status: null,
        },
        {
          n: 3,
          kind: "action",
          tool: "argocd_app_rollback",
          params: { name: "{binding.argocd_app}", id: 6 },
          wave: 4,
          reversibility: "reversible",
          status: "ok",
        },
        {
          n: 4,
          kind: "action",
          tool: "x_delete",
          params: {},
          wave: null,
          reversibility: "irreversible",
          status: null,
        },
        {
          n: 5,
          kind: "action",
          tool: "x_post",
          params: null,
          wave: 2,
          reversibility: "unknown",
          status: null,
        },
      ],
    },
    { name: "other", description: null, file: "o.toml", matched: false, steps: [] },
  ],
  errors: [{ file: "bad.toml", reason: "the file is not valid TOML" }],
};

describe("formatRunbooks", () => {
  test("each step with its kind, label and state; refused files; control text stripped", () => {
    const out = formatRunbooks(REPLY);
    expect(out).toContain("Incident inc_0000000000000001 (record version 2). Advisory mode: off.");
    expect(out).toContain("Runbook pay-rollback - pay.toml");
    expect(out).not.toContain("\u001b");
    expect(out).toContain("1. check: Open the dashboard [done]");
    expect(out).toContain("2. read argocd argocd_get name={binding.argocd_app}");
    expect(out).toContain(
      "3. action [reversible, wave 4] argocd_app_rollback name={binding.argocd_app} id=6 [ok]",
    );
    expect(out).toContain("4. action [IRREVERSIBLE] x_delete");
    expect(out).toContain("5. action [reversibility unknown, wave 2] x_post");
    expect(out).toContain("Runbook other (does not match this record) - o.toml");
    expect(out).toContain("  - bad.toml: the file is not valid TOML");
    expect(out).toContain(
      "Run a step: nimbus incident runbook inc_0000000000000001 --runbook <name> --step <n>",
    );
  });

  test("no runbook and advisory mode read so", () => {
    const out = formatRunbooks({ ...REPLY, advisory: true, runbooks: [], errors: [] });
    expect(out).toContain("Advisory mode: ON - runbook actions are shown, not run.");
    expect(out).toContain("No runbook in your runbooks folder matches this record.");
    expect(out).not.toContain("Run a step");
  });
});

function fake(replies: Record<string, unknown>, fail?: string) {
  const calls: { method: string; params: unknown }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  return {
    calls,
    out,
    err,
    c: {
      call: async <T>(method: string, params?: unknown): Promise<T> => {
        calls.push({ method, params });
        if (fail === method)
          throw new Error("ERR_RUNBOOK_NOT_MATCHED: runbook pay does not match\u0007");
        return replies[method] as T;
      },
    },
    sink: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
  };
}

const OK_READ: RunReplyLike = {
  runbook: "pay",
  step: 2,
  kind: "read",
  actionId: "act_1",
  status: "ok",
  nonHuman: false,
  result: { a: "x\u001b[2J" },
};

describe("runRunbookWith", () => {
  test("lists (text and JSON), declaring the connection first", async () => {
    const f = fake({ "incident.runbooks": REPLY });
    expect(await runRunbookWith(f.c, { id: "inc_1", json: false }, f.sink, TTY)).toBe(0);
    expect(f.calls.map((c) => c.method)).toEqual(["session.declareKind", "incident.runbooks"]);
    expect(f.out.join("")).toContain("Runbook pay-rollback");
    const j = fake({ "incident.runbooks": REPLY });
    await runRunbookWith(j.c, { id: "inc_1", json: true, runbook: "pay" }, j.sink, TTY);
    expect(j.calls[1]?.params).toEqual({ id: "inc_1", runbook: "pay" });
    expect(JSON.parse(j.out.join(""))).toMatchObject({ recordId: "inc_0000000000000001" });
  });

  test("a step needs a terminal and sends nothing without one", async () => {
    const f = fake({});
    const code = await runRunbookWith(
      f.c,
      { id: "i", json: false, runbook: "pay", step: 2 },
      f.sink,
      {
        stdin: false,
        stdout: true,
      },
    );
    expect(code).toBe(2);
    expect(f.calls).toEqual([]);
  });

  test("a read prints its result stripped; a withheld result says so; an action prints its id", async () => {
    const f = fake({ "incident.runbookRun": OK_READ });
    expect(
      await runRunbookWith(f.c, { id: "i", json: false, runbook: "pay", step: 2 }, f.sink, TTY),
    ).toBe(0);
    expect(f.calls[1]).toEqual({
      method: "incident.runbookRun",
      params: { id: "i", runbook: "pay", step: 2 },
    });
    expect(f.out.join("")).toContain("Done. Step 2 of pay, action act_1.");
    expect(f.out.join("")).not.toContain("\u001b");
    const w = fake({
      "incident.runbookRun": { ...OK_READ, result: undefined, resultWithheld: true },
    });
    await runRunbookWith(w.c, { id: "i", json: false, runbook: "pay", step: 2 }, w.sink, TTY);
    expect(w.out.join("")).toContain("The result is too large to show here.");
    const a = fake({ "incident.runbookRun": { ...OK_READ, kind: "action", result: undefined } });
    await runRunbookWith(a.c, { id: "i", json: false, runbook: "pay", step: 3 }, a.sink, TTY);
    expect(a.out.join("")).toBe("Done. Step 2 of pay, action act_1.\n");
  });

  test("a denial, a non-human approval and a failure exit 1 with the reason", async () => {
    for (const [reply, text] of [
      [{ ...OK_READ, status: "denied", reason: "declined" }, "Not run: declined"],
      [{ ...OK_READ, status: "denied", nonHuman: true }, "did not come from a person"],
      [{ ...OK_READ, status: "failed" }, "Failed: no reason given"],
    ] as const) {
      const f = fake({ "incident.runbookRun": reply });
      expect(
        await runRunbookWith(f.c, { id: "i", json: false, runbook: "pay", step: 2 }, f.sink, TTY),
      ).toBe(1);
      expect(f.err.join("")).toContain(text);
    }
  });

  test("done marks a check; a refusal prints its code (stripped), or JSON with --json", async () => {
    const f = fake({ "incident.runbookDone": { status: "done" } });
    expect(
      await runRunbookWith(f.c, { id: "i", json: false, runbook: "pay", done: 1 }, f.sink, TTY),
    ).toBe(0);
    expect(f.calls[1]).toEqual({
      method: "incident.runbookDone",
      params: { id: "i", runbook: "pay", step: 1 },
    });
    expect(f.out.join("")).toBe("Marked step 1 of pay done.\n");
    const dj = fake({ "incident.runbookDone": { runbook: "pay", step: 1, status: "done" } });
    expect(
      await runRunbookWith(dj.c, { id: "i", json: true, runbook: "pay", done: 1 }, dj.sink, TTY),
    ).toBe(0);
    expect(JSON.parse(dj.out.join(""))).toEqual({ runbook: "pay", step: 1, status: "done" });
    const e = fake({}, "incident.runbookDone");
    expect(
      await runRunbookWith(e.c, { id: "i", json: false, runbook: "pay", done: 1 }, e.sink, TTY),
    ).toBe(1);
    expect(e.err.join("")).toBe("ERR_RUNBOOK_NOT_MATCHED: runbook pay does not match\n");
    const j = fake({}, "incident.runbooks");
    expect(await runRunbookWith(j.c, { id: "i", json: true }, j.sink, TTY)).toBe(1);
    expect(JSON.parse(j.out.join(""))).toMatchObject({
      error: expect.stringContaining("ERR_RUNBOOK"),
    });
  });
});
