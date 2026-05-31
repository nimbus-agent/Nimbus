import { describe, expect, it } from "bun:test";

import { runCliJson, runCliOk, runCliOkThrowing } from "./run-cli-json.ts";

// Spawn the current Bun binary with `-e <js>` — present on every platform, no shell.
const BUN = process.execPath;
const evalCmd = (js: string): readonly string[] => [BUN, "-e", js];

describe("runCliJson", () => {
  it("rejects an empty command", async () => {
    expect(await runCliJson([], {})).toEqual({ ok: false, message: "empty command" });
  });

  it("parses JSON written to stdout", async () => {
    const r = await runCliJson(evalCmd("process.stdout.write(JSON.stringify({x:1,y:['a']}))"), {});
    expect(r).toEqual({ ok: true, data: { x: 1, y: ["a"] } });
  });

  it("returns data:null when stdout is empty", async () => {
    const r = await runCliJson(evalCmd("process.exit(0)"), {});
    expect(r).toEqual({ ok: true, data: null });
  });

  it("reports a non-zero exit with the stderr snippet", async () => {
    const r = await runCliJson(evalCmd("process.stderr.write('boom'); process.exit(3)"), {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("exited 3");
      expect(r.message).toContain("boom");
    }
  });

  it("reports invalid JSON from a successful command", async () => {
    const r = await runCliJson(evalCmd("process.stdout.write('not json')"), {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("invalid JSON from CLI");
    }
  });

  it("passes env through to the child", async () => {
    const r = await runCliJson(
      evalCmd("process.stdout.write(JSON.stringify(process.env.NIMBUS_RCJ_TEST ?? null))"),
      { NIMBUS_RCJ_TEST: "hello" },
    );
    expect(r).toEqual({ ok: true, data: "hello" });
  });
});

describe("runCliOk", () => {
  it("rejects an empty command", async () => {
    expect(await runCliOk([], {})).toEqual({ ok: false, message: "empty command" });
  });

  it("returns ok on a zero exit", async () => {
    expect(await runCliOk(evalCmd("process.exit(0)"), {})).toEqual({ ok: true });
  });

  it("returns the failure message on a non-zero exit", async () => {
    const r = await runCliOk(evalCmd("process.stderr.write('nope'); process.exit(2)"), {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("exited 2");
      expect(r.message).toContain("nope");
    }
  });
});

describe("runCliOkThrowing", () => {
  it("resolves on success", async () => {
    await expect(runCliOkThrowing(evalCmd("process.exit(0)"), {})).resolves.toBeUndefined();
  });

  it("throws on a non-zero exit", async () => {
    await expect(runCliOkThrowing(evalCmd("process.exit(1)"), {})).rejects.toThrow("exited 1");
  });
});
