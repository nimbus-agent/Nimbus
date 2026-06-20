import { afterEach, describe, expect, test } from "bun:test";

import { runGcloudCommand } from "./gcloud-runner.ts";

type SpawnArgs = Parameters<typeof Bun.spawn>;
type BunWithSpawn = { spawn: typeof Bun.spawn };

const realSpawn = Bun.spawn;
afterEach(() => {
  (Bun as unknown as BunWithSpawn).spawn = realSpawn;
});

/** Replace Bun.spawn with a fake; returns the captured argv + env. */
function stubSpawn(
  impl: (
    argv: string[],
    opts: { env: Record<string, string> },
  ) => {
    exited: Promise<number>;
    stdout: string;
  },
): { calls: { argv: string[]; env: Record<string, string> }[] } {
  const calls: { argv: string[]; env: Record<string, string> }[] = [];
  const fake = ((argv: SpawnArgs[0], opts?: SpawnArgs[1]) => {
    const a = argv as string[];
    const env = (opts?.env ?? {}) as Record<string, string>;
    calls.push({ argv: a, env });
    const r = impl(a, { env });
    return { exited: r.exited, stdout: r.stdout } as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn;
  (Bun as unknown as BunWithSpawn).spawn = fake;
  return { calls };
}

describe("runGcloudCommand", () => {
  test("returns ok + stdout text on exit code 0", async () => {
    stubSpawn(() => ({ exited: Promise.resolve(0), stdout: '[{"a":1}]' }));
    const res = await runGcloudCommand(["gcloud", "logging", "sinks", "list"], "/creds.json");
    expect(res.ok).toBe(true);
    expect(res.text).toBe('[{"a":1}]');
  });

  test("returns ok:false on a non-zero exit code (text still captured)", async () => {
    stubSpawn(() => ({ exited: Promise.resolve(1), stdout: "boom" }));
    const res = await runGcloudCommand(["gcloud", "ai", "models", "list"], "/creds.json");
    expect(res.ok).toBe(false);
    expect(res.text).toBe("boom");
  });

  test("passes the argv through and scopes GOOGLE_APPLICATION_CREDENTIALS into the env (I1)", async () => {
    const { calls } = stubSpawn(() => ({ exited: Promise.resolve(0), stdout: "[]" }));
    await runGcloudCommand(["gcloud", "x"], "/path/to/creds.json");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toEqual(["gcloud", "x"]);
    expect(calls[0]!.env["GOOGLE_APPLICATION_CREDENTIALS"]).toBe("/path/to/creds.json");
  });

  test("degrades to { ok:false, text:'' } when spawn throws (gcloud missing)", async () => {
    stubSpawn(() => {
      throw new Error("ENOENT: gcloud not found");
    });
    const res = await runGcloudCommand(["gcloud", "x"], "/creds.json");
    expect(res).toEqual({ ok: false, text: "" });
  });
});
