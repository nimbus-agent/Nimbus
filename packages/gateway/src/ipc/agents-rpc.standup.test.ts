import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SynthesisRunner } from "../agents/_lib/synthesis-llm.ts";
import { LocalIndex } from "../index/local-index.ts";
import { AgentsRpcError, dispatchAgentsRpc } from "./agents-rpc.ts";

/**
 * `agents.standup` through the dispatcher: the `[user]` identity override read per call, the
 * 24-hour default window the handler supplies (the agent has no internal fallback), the runner
 * thread-through, and the two ways it can fail — an unresolvable identity is a `-32000` REFUSAL
 * the CLI prints verbatim, while any other fault propagates unchanged rather than being dressed
 * up as that refusal.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const openDbs: Database[] = [];
const tempDirs: string[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function indexDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  openDbs.push(db);
  return db;
}

function configDirWith(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-standup-rpc-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "nimbus.toml"), toml, "utf8");
  return dir;
}

type StandupReady = {
  sessionId: string;
  brief: string;
  findings: {
    kind: string;
    query: { sinceMs: number; nowMs: number };
    identity: { personId: string; source: string; personRowExists: boolean };
  };
  synthesis: { attempted: boolean; reason?: string };
};

/**
 * A `notify` that records every call and settles `ready` on `standup.briefReady` — rejecting on
 * `standup.briefError`, so a build failure surfaces as itself rather than as a timeout. The brief
 * is built in an un-awaited task AFTER the dispatch resolves, so the dispatch result alone says
 * nothing about what was built.
 */
function captureStandup() {
  const calls: Array<[string, unknown]> = [];
  let resolve!: (v: StandupReady) => void;
  let reject!: (e: Error) => void;
  const ready = new Promise<StandupReady>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const notify = (method: string, params: unknown): void => {
    calls.push([method, params]);
    if (method === "standup.briefReady") resolve(params as StandupReady);
    if (method === "standup.briefError") reject(new Error(JSON.stringify(params)));
  };
  return { calls, notify, ready };
}

const ME_TOML = '[user]\nme_person_id = "person-me"\n';

describe("agents.standup — identity from [user], window from the handler", () => {
  test("[user] me_person_id is the identity, verbatim, and the window defaults to 24 hours", async () => {
    const cap = captureStandup();
    const out = await dispatchAgentsRpc(
      "agents.standup",
      {},
      { db: indexDb(), notify: cap.notify, configDir: configDirWith(ME_TOML) },
    );
    expect(out.kind).toBe("hit");
    const sessionId = (out as { kind: "hit"; value: { sessionId: string } }).value.sessionId;
    expect(sessionId).toMatch(/^standup_\d+_[0-9a-f]{8}$/);

    const ready = await cap.ready;
    expect(ready.sessionId).toBe(sessionId);
    expect(ready.findings.kind).toBe("standup");
    expect(ready.findings.identity.personId).toBe("person-me");
    expect(ready.findings.identity.source).toBe("override");
    // No person row carries that id in an empty index — the override is taken as given, not
    // checked against the index (that is the brief's job to disclose, not the handler's).
    expect(ready.findings.identity.personRowExists).toBe(false);
    // The agent's `lookbackMs` is REQUIRED with no fallback of its own; the 24 h comes from here.
    expect(ready.findings.query.nowMs - ready.findings.query.sinceMs).toBe(DAY_MS);
    // No runner on the context: synthesis is not attempted at all.
    expect(ready.synthesis).toEqual({ attempted: false, reason: "disabled" });
  });

  test("an explicit sinceMs replaces the default window", async () => {
    const cap = captureStandup();
    await dispatchAgentsRpc(
      "agents.standup",
      { sinceMs: 2 * HOUR_MS },
      { db: indexDb(), notify: cap.notify, configDir: configDirWith(ME_TOML) },
    );
    const ready = await cap.ready;
    expect(ready.findings.query.nowMs - ready.findings.query.sinceMs).toBe(2 * HOUR_MS);
  });

  test("a runner on the context reaches synthesis with this brief's findings", async () => {
    const prompts: string[] = [];
    const runner: SynthesisRunner = {
      run: (prompt: string) => {
        prompts.push(prompt);
        return Promise.resolve({ ok: false, reason: "no_eligible_provider" });
      },
    };
    const cap = captureStandup();
    await dispatchAgentsRpc(
      "agents.standup",
      {},
      { db: indexDb(), notify: cap.notify, configDir: configDirWith(ME_TOML), runner },
    );
    const ready = await cap.ready;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("person-me");
    // The runner's own answer, distinct from the runner-less `reason: "disabled"` above.
    expect(ready.synthesis).toEqual({ attempted: false, reason: "no_eligible_provider" });
  });
});

describe("agents.standup — refusals", () => {
  // Neither shape supplies an override, so resolution falls to `git config user.email` (a
  // read-only spawn; `handleStandup` passes no `runGit` seam) — and this path supplies no OS
  // username at all, so that fallback answers nothing. Whatever this machine's git config says,
  // no email can match a person in an EMPTY index.
  test.each([
    ["no configDir", undefined],
    ["a configDir whose nimbus.toml has no [user] block", "[decisions]\nmin_confidence = 0.5\n"],
  ])(
    "an unresolvable identity (%s) is a -32000 refusal and emits nothing",
    async (_label, toml) => {
      const cap = captureStandup();
      const ctx =
        toml === undefined
          ? { db: indexDb(), notify: cap.notify }
          : { db: indexDb(), notify: cap.notify, configDir: configDirWith(toml) };
      const err: unknown = await dispatchAgentsRpc("agents.standup", {}, ctx).then(
        (hit) => new Error(`resolved: ${JSON.stringify(hit)}`),
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AgentsRpcError);
      expect((err as AgentsRpcError).rpcCode).toBe(-32000);
      expect((err as AgentsRpcError).message).toStartWith("ERR_STANDUP_IDENTITY_UNRESOLVED:");
      // Resolution runs BEFORE the brief is started, so a refusal leaves no briefError behind.
      expect(cap.calls).toEqual([]);
    },
  );

  test("any other fault propagates unchanged — it is not dressed up as the identity refusal", async () => {
    // An index with no schema: the override resolves without touching it, then the person lookup
    // fails on the missing table. That is an internal fault, not a refusal the caller can act on.
    const bare = new Database(":memory:");
    openDbs.push(bare);
    const cap = captureStandup();
    const err: unknown = await dispatchAgentsRpc(
      "agents.standup",
      {},
      { db: bare, notify: cap.notify, configDir: configDirWith(ME_TOML) },
    ).then(
      (hit) => new Error(`resolved: ${JSON.stringify(hit)}`),
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AgentsRpcError);
    expect((err as Error).message).toContain("no such table: person");
    expect(cap.calls).toEqual([]);
  });
});
