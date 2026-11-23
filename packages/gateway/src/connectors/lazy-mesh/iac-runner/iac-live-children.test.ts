// packages/gateway/src/connectors/lazy-mesh/iac-runner/iac-live-children.test.ts
// The live-children record and the boot sweep, driven directly (no runner, no child process).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { IacLiveChildren } from "./iac-live-children.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "nimbus-iac-live-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function fresh(isPidAlive?: (pid: number) => boolean): {
  live: IacLiveChildren;
  dir: string;
  removed: string[];
} {
  n += 1;
  const dir = join(root, `iac-${String(n)}`);
  const removed: string[] = [];
  const live = new IacLiveChildren(dir, (p) => removed.push(p) && undefined, isPidAlive);
  return { live, dir, removed };
}
const file = (dir: string): string => join(dir, "live-children.json");

describe("pidAlive", () => {
  test("the injected probe wins; without one, signal 0 says this process is alive", () => {
    expect(fresh(() => false).live.pidAlive(process.pid)).toBe(false);
    expect(fresh().live.pidAlive(process.pid)).toBe(true);
  });

  test("a pid that does not exist is not alive", () => {
    // A pid far above any allocation on the three platforms.
    expect(fresh().live.pidAlive(2_147_483_000)).toBe(false);
  });
});

describe("recordLive and forgetLive", () => {
  test("a record is written atomically, replaced per pid and forgotten", () => {
    const { live, dir } = fresh();
    live.recordLive(10, "/w");
    live.recordLive(11, undefined);
    live.recordLive(10, undefined);
    expect(JSON.parse(readFileSync(file(dir), "utf8"))).toEqual([{ pid: 11 }, { pid: 10 }]);
    live.forgetLive(11);
    expect(JSON.parse(readFileSync(file(dir), "utf8"))).toEqual([{ pid: 10 }]);
  });

  test("an unreadable record is never overwritten", () => {
    const { live, dir } = fresh();
    mkdirSync(dir, { recursive: true });
    writeFileSync(file(dir), "not json");
    live.recordLive(1, undefined);
    live.forgetLive(1);
    expect(readFileSync(file(dir), "utf8")).toBe("not json");
  });
});

describe("sweep and liveRecordRefusal", () => {
  test("every malformed shape of the record fails closed and nothing is deleted", () => {
    for (const body of ["{}", '[{"pid":"x"}]', '[{"pid":1.5}]', "[null]"]) {
      const { live, dir, removed } = fresh(() => false);
      mkdirSync(dir, { recursive: true });
      writeFileSync(file(dir), body);
      live.sweep();
      expect(removed, body).toEqual([]);
      expect(live.liveRecordRefusal(), body).toBeDefined();
    }
  });

  test("a record that parses again lifts the refusal and keeps its live children as orphans", () => {
    const { live, dir } = fresh((pid) => pid === 7);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file(dir), "not json");
    live.sweep();
    expect(live.liveRecordRefusal()).toBeDefined();
    writeFileSync(file(dir), JSON.stringify([{ pid: 7, workdir: "/w" }, { pid: 8 }]));
    expect(live.liveRecordRefusal()).toBeUndefined();
    expect(live.orphans).toEqual([{ pid: 7, workdir: "/w" }]);
    expect(JSON.parse(readFileSync(file(dir), "utf8"))).toEqual([{ pid: 7, workdir: "/w" }]);
  });

  test("a sweep runs once; a live recorded child keeps every run directory", () => {
    const { live, dir, removed } = fresh(() => true);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file(dir), JSON.stringify([{ pid: 5 }]));
    live.sweep();
    live.sweep();
    expect(removed).toEqual([]);
    expect(live.orphans).toEqual([{ pid: 5 }]);
  });

  test("a missing record sweeps the five run directories once", () => {
    const { live, removed } = fresh(() => false);
    live.sweep();
    live.sweep();
    expect(removed.map((p) => basename(p))).toEqual([
      "staging",
      "approved",
      "scratch",
      "cwd",
      "kube",
    ]);
  });

  test("a removal that throws does not stop the sweep", () => {
    n += 1;
    const dir = join(root, `iac-${String(n)}`);
    let calls = 0;
    const live = new IacLiveChildren(
      dir,
      () => {
        calls += 1;
        throw new Error("busy");
      },
      () => false,
    );
    live.sweep();
    expect(calls).toBe(5);
  });
});
