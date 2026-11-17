import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { INCIDENT_USAGE } from "./incident-format.ts";
import {
  parseDest,
  parseUpdateArgs,
  realUpdateFs,
  runUpdateWith,
  type UpdateArgs,
  type UpdateFs,
} from "./incident-update.ts";

const REC = "inc_0123456789abcdef";

type Call = { method: string; params: unknown };

function client(replies: Record<string, unknown>): {
  calls: Call[];
  c: { call<T>(method: string, params?: unknown): Promise<T> };
} {
  const calls: Call[] = [];
  return {
    calls,
    c: {
      call: async <T>(method: string, params?: unknown): Promise<T> => {
        calls.push({ method, params });
        if (!(method in replies)) throw new Error(`unexpected ${method}`);
        return replies[method] as T;
      },
    },
  };
}

function sink(): {
  out: string[];
  err: string[];
  s: { out(x: string): void; err(x: string): void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, s: { out: (x) => out.push(x), err: (x) => err.push(x) } };
}

function memFs(files: Record<string, string> = {}): UpdateFs & { files: Record<string, string> } {
  return {
    files,
    readText(path) {
      const v = files[path];
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
    writeText(path, text, exclusive) {
      if (exclusive && path in files) {
        const e = new Error("exists") as Error & { code: string };
        e.code = "EEXIST";
        throw e;
      }
      files[path] = text;
    },
  };
}

const DRAFT = {
  recordId: REC,
  version: 2,
  currentVersion: 2,
  audience: "stakeholders",
  text: "Incident update: x\u001b[31m\nStatus: Ongoing\n",
};

describe("parseUpdateArgs", () => {
  test("draft, send and queue forms", () => {
    expect(parseUpdateArgs([REC])).toEqual({ mode: "draft", id: REC, json: false, force: false });
    expect(
      parseUpdateArgs([REC, "--audience", "engineers", "--version", "3", "--out", "u.txt"]),
    ).toEqual({
      mode: "draft",
      id: REC,
      audience: "engineers",
      version: 3,
      json: false,
      force: false,
      out: "u.txt",
    });
    expect(parseUpdateArgs([REC, "--send", "slack:C0STATUS", "--from", "u.txt"])).toEqual({
      mode: "send",
      id: REC,
      dest: { platform: "slack", channel: "C0STATUS" },
      from: "u.txt",
    });
    expect(parseUpdateArgs(["--queued", "--json"])).toEqual({ mode: "queue", json: true });
  });

  test("usage errors", () => {
    for (const argv of [
      [],
      ["--queued", REC],
      [REC, "--audience", "everyone"],
      [REC, "--version", "0"],
      [REC, "--from", "u.txt"],
      [REC, "--send", "slack:C0", "--out", "x"],
      [REC, "--send", "slack:C0STATUS", "--json"],
      [REC, "--send", "email:a@b"],
      [REC, "--send", "slack:#general"],
      [REC, "extra", "positional"],
    ]) {
      expect(parseUpdateArgs(argv)).toBeUndefined();
    }
  });

  test("parseDest", () => {
    expect(parseDest("teams:team-1/19:abc@thread.tacv2")).toEqual({
      platform: "teams",
      teamId: "team-1",
      channelId: "19:abc@thread.tacv2",
    });
    expect(parseDest("teams:team-1")).toBeUndefined();
    expect(parseDest("teams:/19:x")).toBeUndefined();
    expect(parseDest("teams:t/not-a-thread")).toBeUndefined();
  });

  test("the incident usage lists update", () => {
    expect(INCIDENT_USAGE).toContain("nimbus incident update");
  });
});

describe("runUpdateWith", () => {
  test("a draft declares the CLI kind, prints the text with control characters stripped", async () => {
    const { calls, c } = client({ "client.declareKind": {}, "incident.update": DRAFT });
    const out = sink();
    const code = await runUpdateWith(c, parseUpdateArgs([REC]) as UpdateArgs, out.s, memFs());
    expect(code).toBe(0);
    expect(calls.map((x) => x.method).at(-1)).toBe("incident.update");
    expect(calls.at(-1)?.params).toEqual({ id: REC });
    expect(out.out.join("")).not.toContain("\u001b");
    expect(out.out.join("")).toContain("Status: Ongoing");
  });

  test("--out writes the file and refuses to overwrite without --force", async () => {
    const { c } = client({ "client.declareKind": {}, "incident.update": DRAFT });
    const fs = memFs({ "u.txt": "old" });
    const out = sink();
    expect(
      await runUpdateWith(c, parseUpdateArgs([REC, "--out", "u.txt"]) as UpdateArgs, out.s, fs),
    ).toBe(1);
    expect(fs.files["u.txt"]).toBe("old");
    expect(
      await runUpdateWith(
        c,
        parseUpdateArgs([REC, "--out", "u.txt", "--force"]) as UpdateArgs,
        out.s,
        fs,
      ),
    ).toBe(0);
    expect(fs.files["u.txt"]).toBe(DRAFT.text);
  });

  test("--send with --from sends the file's text to the channel", async () => {
    const { calls, c } = client({
      "client.declareKind": {},
      "incident.updateSend": { outcome: "sent" },
    });
    const out = sink();
    const code = await runUpdateWith(
      c,
      parseUpdateArgs([REC, "--send", "slack:C0STATUS", "--from", "u.txt"]) as UpdateArgs,
      out.s,
      memFs({ "u.txt": "edited text" }),
    );
    expect(code).toBe(0);
    expect(calls.at(-1)).toEqual({
      method: "incident.updateSend",
      params: { id: REC, platform: "slack", channel: "C0STATUS", text: "edited text" },
    });
    expect(out.out.join("")).toBe("Sent.\n");
  });

  test("--send without --from drafts first, then sends that text; a refusal exits 1", async () => {
    const { calls, c } = client({
      "client.declareKind": {},
      "incident.update": DRAFT,
      "incident.updateSend": {
        outcome: "refused",
        code: "ERR_INCIDENT_UPDATE_REFUSED",
        reason: "a broadcast mention",
      },
    });
    const out = sink();
    const code = await runUpdateWith(
      c,
      parseUpdateArgs([REC, "--send", "teams:t1/19:a@thread.tacv2"]) as UpdateArgs,
      out.s,
      memFs(),
    );
    expect(code).toBe(1);
    const sent = calls.find((x) => x.method === "incident.updateSend");
    expect(sent?.params).toEqual({
      id: REC,
      platform: "teams",
      teamId: "t1",
      channelId: "19:a@thread.tacv2",
      text: DRAFT.text,
    });
    expect(out.err.join("")).toContain("Not sent (ERR_INCIDENT_UPDATE_REFUSED)");
  });

  test("an unreadable --from file sends nothing", async () => {
    const { calls, c } = client({});
    const out = sink();
    const code = await runUpdateWith(
      c,
      parseUpdateArgs([REC, "--send", "slack:C0STATUS", "--from", "missing.txt"]) as UpdateArgs,
      out.s,
      memFs(),
    );
    expect(code).toBe(1);
    expect(calls).toEqual([]);
  });

  test("--queued lists the waiting drafts, or says none are", async () => {
    const one = client({
      "client.declareKind": {},
      "incident.updateQueue": { entries: [{ recordId: REC, version: 2, queuedAtMs: 0 }] },
    });
    const out = sink();
    expect(await runUpdateWith(one.c, { mode: "queue", json: false }, out.s, memFs())).toBe(0);
    expect(out.out.join("")).toContain(`${REC} v2  queued 1970-01-01 00:00 UTC`);
    const none = client({ "client.declareKind": {}, "incident.updateQueue": { entries: [] } });
    const out2 = sink();
    await runUpdateWith(none.c, { mode: "queue", json: false }, out2.s, memFs());
    expect(out2.out.join("")).toContain("No update drafts are waiting");
  });
});

describe("runUpdateWith: other outcomes", () => {
  test("--json prints the draft reply; an older version says the current one", async () => {
    const older = { ...DRAFT, version: 1, currentVersion: 3 };
    const j = client({ "session.declareKind": {}, "incident.update": older });
    const out = sink();
    await runUpdateWith(j.c, parseUpdateArgs([REC, "--json"]) as UpdateArgs, out.s, memFs());
    expect(JSON.parse(out.out.join(""))).toEqual(older);
    const t = client({ "session.declareKind": {}, "incident.update": older });
    const out2 = sink();
    await runUpdateWith(
      t.c,
      parseUpdateArgs([REC, "--version", "1"]) as UpdateArgs,
      out2.s,
      memFs(),
    );
    expect(out2.err.join("")).toContain("This is version 1; the record is now at version 3.");
  });

  test("a declined send says nothing was posted; a gateway error exits 1 with the message", async () => {
    const d = client({
      "session.declareKind": {},
      "incident.updateSend": { outcome: "denied", reason: "the owner declined" },
    });
    const out = sink();
    const code = await runUpdateWith(
      d.c,
      parseUpdateArgs([REC, "--send", "slack:C0STATUS", "--from", "u.txt"]) as UpdateArgs,
      out.s,
      memFs({ "u.txt": "x" }),
    );
    expect(code).toBe(1);
    expect(out.err.join("")).toBe("Not sent: the owner declined. Nothing was posted.\n");
    const e = client({ "session.declareKind": {} });
    const out2 = sink();
    expect(await runUpdateWith(e.c, parseUpdateArgs([REC]) as UpdateArgs, out2.s, memFs())).toBe(1);
    expect(out2.err.join("")).toContain("unexpected incident.update");
  });

  test("--queued --json prints the reply", async () => {
    const q = client({ "session.declareKind": {}, "incident.updateQueue": { entries: [] } });
    const out = sink();
    await runUpdateWith(q.c, { mode: "queue", json: true }, out.s, memFs());
    expect(JSON.parse(out.out.join(""))).toEqual({ entries: [] });
  });
});

describe("realUpdateFs", () => {
  test("writes 0600 files under a created directory, refuses an existing one when exclusive, caps reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-update-fs-"));
    try {
      const p = join(dir, "sub", "u.txt");
      realUpdateFs.writeText(p, "hello", true);
      expect(realUpdateFs.readText(p, 100)).toBe("hello");
      expect(() => realUpdateFs.writeText(p, "again", true)).toThrow();
      realUpdateFs.writeText(p, "again", false);
      expect(realUpdateFs.readText(p, 100)).toBe("again");
      expect(() => realUpdateFs.readText(p, 2)).toThrow(/larger than 2 bytes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
