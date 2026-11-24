import { describe, expect, test } from "bun:test";

import { parseUpdateArgs, realUpdateFs, runUpdateWith, UPDATE_USAGE } from "./incident-update.ts";

const REC = "inc_0123456789abcdef";

function harness(replies: Record<string, unknown>) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { method: string; params: unknown }[] = [];
  const ipc = {
    call: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      return method === "session.declareKind" ? {} : replies[method];
    },
  };
  return {
    out,
    err,
    calls,
    ipc: ipc as never,
    sink: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
  };
}

const reply = (over: Record<string, unknown> = {}) => ({
  recordId: REC,
  version: 1,
  currentVersion: 1,
  audience: "stakeholders",
  text: "LEAD PARAGRAPH\n\nFACTS\n",
  lead: "LEAD PARAGRAPH",
  synthesis: { attempted: true, used: true, model: "m1" },
  ...over,
});

describe("nimbus incident update --synthesize", () => {
  test("parses for a draft only; a send or the queue refuses it", () => {
    expect(parseUpdateArgs([REC, "--synthesize"])).toMatchObject({
      mode: "draft",
      synthesize: true,
    });
    expect(parseUpdateArgs([REC])).not.toHaveProperty("synthesize");
    expect(parseUpdateArgs([REC, "--synthesize", "--send", "slack:C0123ABC"])).toBeUndefined();
    expect(parseUpdateArgs(["--queued", "--synthesize"])).toBeUndefined();
    expect(UPDATE_USAGE).toContain("[--synthesize]");
  });

  test("calls the synthesize method with the same parameters and prints the lead plus the facts", async () => {
    const h = harness({ "incident.updateSynthesize": reply() });
    const code = await runUpdateWith(
      h.ipc,
      {
        mode: "draft",
        id: REC,
        audience: "engineers",
        json: false,
        force: false,
        synthesize: true,
      },
      h.sink,
      realUpdateFs,
    );
    expect(code).toBe(0);
    expect(h.calls.map((c) => c.method)).toEqual([
      "session.declareKind",
      "incident.updateSynthesize",
    ]);
    expect(h.calls[1]?.params).toEqual({ id: REC, audience: "engineers" });
    expect(h.out.join("")).toContain("LEAD PARAGRAPH");
    expect(h.err.join("")).toContain("first paragraph was written by m1");
  });

  test("without the flag the plain update method is the only one called", async () => {
    const h = harness({ "incident.update": { ...reply(), lead: undefined, synthesis: undefined } });
    await runUpdateWith(
      h.ipc,
      { mode: "draft", id: REC, json: false, force: false },
      h.sink,
      realUpdateFs,
    );
    expect(h.calls.map((c) => c.method)).toEqual(["session.declareKind", "incident.update"]);
    expect(h.err.join("")).toBe("");
  });

  test("no model, and a discarded lead, are each said plainly", async () => {
    const none = harness({
      "incident.updateSynthesize": reply({
        lead: null,
        synthesis: { attempted: false, reason: "disabled" },
      }),
    });
    await runUpdateWith(
      none.ipc,
      { mode: "draft", id: REC, json: false, force: false, synthesize: true },
      none.sink,
      realUpdateFs,
    );
    expect(none.err.join("")).toContain("No model was used (disabled)");
    const dropped = harness({
      "incident.updateSynthesize": reply({
        lead: null,
        synthesis: { attempted: true, used: false, reason: "contract_violation" },
      }),
    });
    await runUpdateWith(
      dropped.ipc,
      { mode: "draft", id: REC, json: false, force: false, synthesize: true },
      dropped.sink,
      realUpdateFs,
    );
    expect(dropped.err.join("")).toContain("lead was not used (contract_violation)");
  });

  test("a send never calls the synthesize method: the owner approves exactly the text they hold", async () => {
    const h = harness({ "incident.updateSend": { outcome: "sent" } });
    await runUpdateWith(
      h.ipc,
      { mode: "send", id: REC, dest: { platform: "slack", channel: "C0123ABC" } },
      h.sink,
      { ...realUpdateFs, readText: () => "x" },
    );
    expect(h.calls.map((c) => c.method)).not.toContain("incident.updateSynthesize");
  });
});
