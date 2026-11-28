import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { finopsSyncOptions } from "./finops-options.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nimbus-finops-opts-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (text: string) => writeFileSync(join(dir, "nimbus.toml"), text);

describe("finopsSyncOptions", () => {
  test("defaults when nothing is configured", () => {
    const o = finopsSyncOptions(dir);
    expect(o.maxSeries()).toBe(500);
    expect(o.githubOrgs()).toEqual([]);
    expect(o.gitlab()).toMatchObject({ groups: [], ratePerMinute: null });
    expect(o.aws()).toEqual({ export: null, costExplorer: false });
  });

  test("each getter reads the config at call time, so an edit applies to the next run", () => {
    const o = finopsSyncOptions(dir);
    write(
      '[finops]\nmax_series = 42\n\n[cost.github]\norgs = ["acme"]\n\n[cost.gitlab]\ngroups = ["g"]\nrate_per_minute = 0.01\n\n[cost.aws]\nexport = "s3://my-bucket/focus"\ncost_explorer = true\n',
    );
    expect(o.maxSeries()).toBe(42);
    expect(o.githubOrgs()).toEqual(["acme"]);
    expect(o.gitlab()).toMatchObject({ groups: ["g"], ratePerMinute: 0.01 });
    expect(o.aws()).toEqual({
      export: { bucket: "my-bucket", prefix: "focus" },
      costExplorer: true,
    });
    write("[finops]\nmax_series = 7\n");
    expect(o.maxSeries()).toBe(7);
    expect(o.aws()).toEqual({ export: null, costExplorer: false });
  });

  test("a refused cost config reads as null for the cost syncs that keep their cursor", () => {
    write('[cost.aws]\nbogus = "x"\n');
    const o = finopsSyncOptions(dir);
    expect(o.gitlab()).toBeNull();
    expect(o.aws()).toBeNull();
    expect(o.githubOrgs()).toEqual([]);
  });
});
