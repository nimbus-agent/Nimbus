import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FleetConfigError,
  type FleetJobChecker,
  loadNimbusFleetFromPath,
  type NimbusFleetJobToml,
  parseNimbusTomlFleet,
  parseNimbusTomlFleetJobs,
  resolveFleetJobs,
} from "./fleet-toml.ts";
import { type LayerRef, mergeLayerDocs, parseLayerDoc } from "./layered-merge.ts";

test("an absent [fleet] block is disabled with safe defaults", () => {
  const c = parseNimbusTomlFleet("");
  expect(c.enabled).toBe(false);
  expect(c.allowRemote).toBe(false);
  expect(c.remoteCallBudget).toBe(0);
  expect(c.minIdleSeconds).toBe(900);
  expect(c.requireAcPower).toBe(true);
  expect(c.retentionDays).toBe(14);
});

test("parses a full [fleet] block", () => {
  const c = parseNimbusTomlFleet(
    [
      "[fleet]",
      "enabled = true",
      "allow_remote = true",
      "remote_call_budget = 5",
      "min_idle_seconds = 60",
      "require_ac_power = false",
      "retention_days = 30",
    ].join("\n"),
  );
  expect(c).toEqual({
    enabled: true,
    allowRemote: true,
    remoteCallBudget: 5,
    minIdleSeconds: 60,
    requireAcPower: false,
    retentionDays: 30,
  });
});

test("allow_remote with a zero budget is refused, not silently allowed", () => {
  expect(() =>
    parseNimbusTomlFleet(["[fleet]", "allow_remote = true", "remote_call_budget = 0"].join("\n")),
  ).toThrow(/remote_call_budget/);
});

test("keys after a following table header do not leak into [fleet]", () => {
  const c = parseNimbusTomlFleet(
    ["[fleet]", "enabled = true", "[other]", "enabled = false"].join("\n"),
  );
  expect(c.enabled).toBe(true);
});

test("parses multiple [[fleet.job]] blocks with flat params", () => {
  const jobs = parseNimbusTomlFleetJobs(
    [
      "[[fleet.job]]",
      'name = "morning_catchup"',
      'agent = "catchup"',
      "interval_seconds = 86400",
      "since_ms = 86400000",
      'service = "github"',
      "",
      "[[fleet.job]]",
      'name = "weekly_ownership"',
      'agent = "ownership"',
      "interval_seconds = 604800",
    ].join("\n"),
  );
  expect(jobs).toHaveLength(2);
  expect(jobs[0]).toEqual({
    name: "morning_catchup",
    agent: "catchup",
    intervalSeconds: 86400,
    params: { sinceMs: 86400000, service: "github" },
    digestMinDelta: 1,
    sweep: null,
  });
  expect(jobs[1]?.params).toEqual({});
});

test("a block with no name and no agent is not a job at all — ignored", () => {
  expect(parseNimbusTomlFleetJobs(["[[fleet.job]]"].join("\n"))).toEqual([]);
});

test("a job missing a required key is REFUSED, never silently dropped or defaulted", () => {
  // Dropping it leaves the owner believing a job is configured that will never run. Defaulting
  // interval_seconds to a day guesses a schedule they did not choose. Both fail silently; a
  // throw is the only outcome they can see.
  expect(() =>
    parseNimbusTomlFleetJobs(["[[fleet.job]]", 'name = "x"', 'agent = "catchup"'].join("\n")),
  ).toThrow(/interval_seconds/);
  expect(() =>
    parseNimbusTomlFleetJobs(["[[fleet.job]]", 'name = "x"', "interval_seconds = 10"].join("\n")),
  ).toThrow(/agent/);
});

test("duplicate job names are refused — the name is the job_id primary key", () => {
  expect(() =>
    parseNimbusTomlFleetJobs(
      [
        "[[fleet.job]]",
        'name = "dup"',
        'agent = "catchup"',
        "interval_seconds = 1",
        "[[fleet.job]]",
        'name = "dup"',
        'agent = "ownership"',
        "interval_seconds = 1",
      ].join("\n"),
    ),
  ).toThrow(/duplicate/i);
});

test("retention_days = 0 is REFUSED — a zero-retention run deletes its own row", () => {
  // `pruneRuns` uses `started_at <= cutoff`, so at retention 0 the prune a run performs on
  // completion removes that same run, and `runOnce` returns a runId naming no row. There is no
  // safe reading of 0 here, so it is refused rather than silently defaulted.
  expect(() => parseNimbusTomlFleet(["[fleet]", "retention_days = 0"].join("\n"))).toThrow(
    /retention_days/,
  );
});

test("a negative retention_days is refused for the same reason", () => {
  expect(() => parseNimbusTomlFleet(["[fleet]", "retention_days = -1"].join("\n"))).toThrow(
    /retention_days/,
  );
});

test("retention_days = 1 is the minimum and is accepted", () => {
  expect(parseNimbusTomlFleet(["[fleet]", "retention_days = 1"].join("\n")).retentionDays).toBe(1);
});

test("remote_call_budget = 0 stays legal — it is the default and means no remote", () => {
  // The bound raised for retention_days must NOT be raised for this key: 0 is what
  // `allow_remote = false` implies, and DEFAULT_FLEET_CONFIG ships it.
  //
  // HONEST SCOPE, because a review caught this claiming more than it does. The `= 0` assertion
  // CANNOT detect the mutation it looks like it guards: `DEFAULT_FLEET_CONFIG.remoteCallBudget` is
  // already 0, so raising the shared arm to `n >= 1` makes the key ignored and the merged config
  // still reads 0. Explicit-zero and defaulted-zero are indistinguishable here by construction.
  //
  // The sibling `min_idle_seconds = 0` test is what actually catches a shared-arm raise, because
  // its default is 900 and the mutation makes the read value diverge. Verified by applying that
  // mutation: it fails and this one does not.
  //
  // The `= 3` assertion below is still worth its line, but for a DIFFERENT mutation — it goes red
  // if the key stops being read at all, e.g. dropped from the switch.
  expect(
    parseNimbusTomlFleet(["[fleet]", "remote_call_budget = 0"].join("\n")).remoteCallBudget,
  ).toBe(0);
  expect(
    parseNimbusTomlFleet(["[fleet]", "allow_remote = true", "remote_call_budget = 3"].join("\n"))
      .remoteCallBudget,
  ).toBe(3);
});

test("min_idle_seconds = 0 stays legal — it means no idle requirement", () => {
  expect(parseNimbusTomlFleet(["[fleet]", "min_idle_seconds = 0"].join("\n")).minIdleSeconds).toBe(
    0,
  );
});

describe("[[fleet.job]] digest_min_delta", () => {
  const job = (extra: string) =>
    `[[fleet.job]]\nname = "j"\nagent = "ghost"\ninterval_seconds = 3600\n${extra}\n`;

  test("defaults to 1", () => {
    expect(parseNimbusTomlFleetJobs(job(""))[0]?.digestMinDelta).toBe(1);
  });

  test("is read, and does NOT leak into agent params", () => {
    const j = parseNimbusTomlFleetJobs(job("digest_min_delta = 5"))[0];
    expect(j?.digestMinDelta).toBe(5);
    expect(j?.params).toEqual({}); // the trap: it must not appear here
  });

  test("refuses below 1", () => {
    expect(() => parseNimbusTomlFleetJobs(job("digest_min_delta = 0"))).toThrow(FleetConfigError);
    expect(() => parseNimbusTomlFleetJobs(job("digest_min_delta = -2"))).toThrow(FleetConfigError);
  });

  // Named the same way every sibling refusal in this parser is (`${name} requires agent`): with
  // several `[[fleet.job]]` blocks in one file, an unnamed refusal costs the owner a search.
  test("refuses below 1, naming the job", () => {
    expect(() => parseNimbusTomlFleetJobs(job("digest_min_delta = 0"))).toThrow(
      /\[\[fleet\.job\]\] j digest_min_delta/,
    );
  });

  test("a genuine agent param still reaches params", () => {
    expect(parseNimbusTomlFleetJobs(job('file = "src/a.ts"'))[0]?.params).toEqual({
      file: "src/a.ts",
    });
  });

  test("a malformed value falls through to the default rather than throwing", () => {
    // Writing a number the parser can read and refuse is a DIFFERENT act from writing nonsense:
    // `digest_min_delta = 0` is a config error, `digest_min_delta = "abc"` is a typo that should
    // leave the key at its default, exactly as every sibling key in this parser behaves.
    for (const raw of [
      'digest_min_delta = "abc"',
      "digest_min_delta = 1.5",
      "digest_min_delta = 3abc",
    ]) {
      const j = parseNimbusTomlFleetJobs(job(raw))[0];
      expect(j?.digestMinDelta).toBe(1);
      expect(j?.params).toEqual({});
    }
  });
});

describe("[[fleet.job]] sweep", () => {
  const base = `[[fleet.job]]\nname = "bus"\nagent = "ownership"\ninterval_seconds = 86400\n`;

  test("parses sweep, max_subjects and path_prefix, none of which reach params", () => {
    const [job] = parseNimbusTomlFleetJobs(
      `${base}sweep = "paths"\nmax_subjects = 200\npath_prefix = "packages/"\n`,
    );
    expect(job?.sweep).toEqual({ kind: "paths", maxSubjects: 200, pathPrefix: "packages/" });
    expect(job?.params).toEqual({});
  });

  test("a job without sweep has sweep: null", () => {
    expect(parseNimbusTomlFleetJobs(base)[0]?.sweep).toBeNull();
  });

  test.each([
    ["absent", ""],
    ["zero", "max_subjects = 0\n"],
    ["above 500 (refused, not clamped)", "max_subjects = 501\n"],
    ["non-integer", 'max_subjects = "lots"\n'],
  ])("rule 3: sweep with max_subjects %s is refused", (_label, line) => {
    expect(() => parseNimbusTomlFleetJobs(`${base}sweep = "paths"\n${line}`)).toThrow(
      /bus requires max_subjects between 1 and 500/,
    );
  });

  test("rule 4: max_subjects without sweep is refused", () => {
    expect(() => parseNimbusTomlFleetJobs(`${base}max_subjects = 5\n`)).toThrow(/without sweep/);
  });

  test("rule 4: path_prefix without sweep is refused", () => {
    expect(() => parseNimbusTomlFleetJobs(`${base}path_prefix = "src/"\n`)).toThrow(
      /without sweep/,
    );
  });

  test("rule 5: path_prefix on a kind that does not accept it is refused", () => {
    expect(() =>
      parseNimbusTomlFleetJobs(`${base}sweep = "services"\nmax_subjects = 5\npath_prefix = "x"\n`),
    ).toThrow(/path_prefix applies only to sweep = "paths" or "symbols"/);
  });

  test("an EMPTY path_prefix is refused, not read as 'no filter'", () => {
    // `""` prefixes every path, so it would silently mean "no narrowing" — a value the owner wrote
    // that does nothing. Refused like `digest_min_delta = 0`. NOT trimmed: a repo-relative path may
    // legally contain spaces, and trimming would silently change what the owner asked for.
    expect(() =>
      parseNimbusTomlFleetJobs(`${base}sweep = "paths"\nmax_subjects = 5\npath_prefix = ""\n`),
    ).toThrow(/bus path_prefix must not be empty/);
  });

  test("path_prefix whitespace is preserved verbatim", () => {
    const [job] = parseNimbusTomlFleetJobs(
      `${base}sweep = "paths"\nmax_subjects = 5\npath_prefix = "my docs/"\n`,
    );
    expect(job?.sweep?.pathPrefix).toBe("my docs/");
  });

  test("an unknown sweep kind is refused and names the valid set", () => {
    expect(() => parseNimbusTomlFleetJobs(`${base}sweep = "people"\nmax_subjects = 5\n`)).toThrow(
      /unknown sweep "people".*paths, services, symbols, terms/,
    );
  });
});

describe("parseNimbusTomlFleetJobs stays strict about enabled", () => {
  const head = '[[fleet.job]]\nname = "s"\n';

  test("a stub is refused", () => {
    expect(() => parseNimbusTomlFleetJobs(`${head}enabled = false\n`)).toThrow(
      "[[fleet.job]] s requires agent",
    );
  });

  test("a full disabled job is returned", () => {
    const jobs = parseNimbusTomlFleetJobs(
      `${head}agent = "standup"\ninterval_seconds = 60\nenabled = false\n`,
    );
    expect(jobs.map((j) => j.name)).toEqual(["s"]);
    expect(jobs[0]?.params).toEqual({});
  });

  test("an unreadable enabled is refused", () => {
    expect(() =>
      parseNimbusTomlFleetJobs(`${head}agent = "standup"\ninterval_seconds = 60\nenabled = 1\n`),
    ).toThrow("[[fleet.job]] s enabled must be true or false");
  });
});

describe("resolveFleetJobs: per-job resolution", () => {
  const packRef: LayerRef = { kind: "pack", id: "pm", path: join(tmpdir(), "pm.toml") };
  const baseRef: LayerRef = { kind: "base", id: "base", path: join(tmpdir(), "nimbus.toml") };
  const profileRef: LayerRef = {
    kind: "profile",
    id: "work",
    path: join(tmpdir(), "profiles", "work.toml"),
  };

  const block = (lines: readonly string[]): string => ["[[fleet.job]]", ...lines, ""].join("\n");
  const full = (name: string, extra: readonly string[] = []): string =>
    block([`name = "${name}"`, 'agent = "standup"', "interval_seconds = 3600", ...extra]);
  const stub = (name: string): string => block([`name = "${name}"`, "enabled = false"]);
  const sections = (...layers: readonly (readonly [LayerRef, string])[]) =>
    mergeLayerDocs(layers.map(([ref, text]) => parseLayerDoc(ref, text))).sections;

  test("a good job beside a bad one schedules the good one", () => {
    const r = resolveFleetJobs(
      sections([baseRef, full("a") + block(['name = "b"', 'agent = "standup"'])]),
    );
    expect(r.jobs.map((j) => j.name)).toEqual(["a"]);
    expect(r.dropped).toEqual([
      { name: "b", layer: baseRef, reason: "[[fleet.job]] b requires interval_seconds > 0" },
    ]);
  });

  test.each<[string, string, FleetJobChecker | undefined, string]>([
    [
      "missing agent",
      block(['name = "j"', "interval_seconds = 60"]),
      undefined,
      "[[fleet.job]] j requires agent",
    ],
    [
      "unknown sweep",
      full("j", ['sweep = "people"', "max_subjects = 5"]),
      undefined,
      '[[fleet.job]] j has unknown sweep "people" (expected one of paths, services, symbols, terms)',
    ],
    [
      "max_subjects = 0",
      full("j", ['sweep = "paths"', "max_subjects = 0"]),
      undefined,
      "[[fleet.job]] j requires max_subjects between 1 and 500 when sweep is set (refused, not " +
        "clamped; an unbounded sweep must not be expressible)",
    ],
    [
      "max_subjects without sweep",
      full("j", ["max_subjects = 5"]),
      undefined,
      "[[fleet.job]] j sets max_subjects or path_prefix without sweep",
    ],
    [
      "digest_min_delta = 0",
      full("j", ["digest_min_delta = 0"]),
      undefined,
      "[[fleet.job]] j digest_min_delta must be >= 1 (got 0); a zero would report every " +
        "metric, including unchanged ones",
    ],
    ["a checker reason", full("j"), () => "not eligible", "not eligible"],
  ])("each listed job-level error drops only its job: %s", (_label, bad, check, reason) => {
    const r = resolveFleetJobs(sections([baseRef, full("ok") + bad]), (job) =>
      job.name === "ok" ? undefined : check?.(job),
    );
    expect(r.jobs.map((j) => j.name)).toEqual(["ok"]);
    expect(r.dropped).toEqual([{ name: "j", layer: baseRef, reason }]);
  });

  test("a stub disables the pack job", () => {
    const r = resolveFleetJobs(sections([packRef, full("nightly")], [baseRef, stub("nightly")]));
    expect(r.jobs).toEqual([]);
    expect(r.disabled).toEqual([
      { name: "nightly", agent: null, origin: { layer: baseRef, replaces: [packRef] } },
    ]);
    expect(r.dropped).toEqual([]);
  });

  test("an orphan stub is inert", () => {
    const r = resolveFleetJobs(sections([baseRef, stub("lonely")]));
    expect(r.jobs).toEqual([]);
    expect(r.disabled).toEqual([
      { name: "lonely", agent: null, origin: { layer: baseRef, replaces: [] } },
    ]);
    expect(r.dropped).toEqual([]);
  });

  test("a full job with enabled = false is disabled and keeps its agent", () => {
    const r = resolveFleetJobs(sections([baseRef, full("off", ["enabled = false"])]));
    expect(r.jobs).toEqual([]);
    expect(r.disabled).toEqual([
      { name: "off", agent: "standup", origin: { layer: baseRef, replaces: [] } },
    ]);
  });

  test("a stub's other present fields are still validated", () => {
    const r = resolveFleetJobs(
      sections([baseRef, block(['name = "s"', "enabled = false", "max_subjects = 5"])]),
    );
    expect(r.disabled).toEqual([]);
    expect(r.dropped).toEqual([
      {
        name: "s",
        layer: baseRef,
        reason: "[[fleet.job]] s sets max_subjects or path_prefix without sweep",
      },
    ]);
  });

  test("a dropped override does not resurrect the lower job", () => {
    const r = resolveFleetJobs(
      sections([packRef, full("x")], [baseRef, block(['name = "x"', 'agent = "standup"'])]),
    );
    expect(r.jobs).toEqual([]);
    expect(r.dropped[0]?.name).toBe("x");
    expect(r.dropped[0]?.layer).toEqual(baseRef);
  });

  test("a duplicate in one file drops the later entry, even a stub", () => {
    const r = resolveFleetJobs(sections([baseRef, full("d") + stub("d")]));
    expect(r.jobs.map((j) => j.name)).toEqual(["d"]);
    expect(r.disabled).toEqual([]);
    expect(r.dropped).toEqual([
      { name: "d", layer: baseRef, reason: "[[fleet.job]] duplicate name: d" },
    ]);
  });

  test("a duplicate after a broken first copy is still dropped", () => {
    const r = resolveFleetJobs(
      sections([baseRef, block(['name = "d"', 'agent = "standup"']) + full("d")]),
    );
    expect(r.jobs).toEqual([]);
    expect(r.dropped).toEqual([
      { name: "d", layer: baseRef, reason: "[[fleet.job]] d requires interval_seconds > 0" },
      { name: "d", layer: baseRef, reason: "[[fleet.job]] duplicate name: d" },
    ]);
  });

  test("a block with no name is dropped with a null name and joins no duplicate check", () => {
    const r = resolveFleetJobs(
      sections([baseRef, block(['agent = "standup"', "interval_seconds = 60"]) + full("n")]),
    );
    expect(r.jobs.map((j) => j.name)).toEqual(["n"]);
    expect(r.dropped).toEqual([
      { name: null, layer: baseRef, reason: "[[fleet.job]] requires name" },
    ]);
  });

  test("an empty block is skipped, not dropped", () => {
    const r = resolveFleetJobs(sections([baseRef, block([]) + full("n")]));
    expect(r.jobs.map((j) => j.name)).toEqual(["n"]);
    expect(r.dropped).toEqual([]);
  });

  test("the checker does not run on a disabled job", () => {
    const seen: string[] = [];
    const r = resolveFleetJobs(
      sections([baseRef, full("on") + full("off", ["enabled = false"]) + stub("stub")]),
      (job: NimbusFleetJobToml) => {
        seen.push(job.name);
        return undefined;
      },
    );
    expect(seen).toEqual(["on"]);
    expect(r.disabled.map((d) => d.name)).toEqual(["off", "stub"]);
  });

  test('enabled = "no" drops the job with its reason', () => {
    const r = resolveFleetJobs(sections([baseRef, full("j", ['enabled = "no"'])]));
    expect(r.jobs).toEqual([]);
    expect(r.dropped).toEqual([
      { name: "j", layer: baseRef, reason: "[[fleet.job]] j enabled must be true or false" },
    ]);
  });

  test("enabled is reserved and never reaches the agent's params", () => {
    const r = resolveFleetJobs(sections([baseRef, full("j", ["enabled = true"])]));
    expect(r.jobs[0]?.params).toEqual({});
  });

  test("origins carries each scheduled job's layer and replaces", () => {
    const r = resolveFleetJobs(
      sections(
        [packRef, full("p") + full("shared")],
        [baseRef, full("shared")],
        [profileRef, full("mine")],
      ),
    );
    expect(r.jobs.map((j) => j.name).sort()).toEqual(["mine", "p", "shared"]);
    expect(r.origins.size).toBe(3);
    expect(r.origins.get("p")).toEqual({ layer: packRef, replaces: [] });
    expect(r.origins.get("shared")).toEqual({ layer: baseRef, replaces: [packRef] });
    expect(r.origins.get("mine")).toEqual({ layer: profileRef, replaces: [] });
  });

  test("digest_min_delta before name names the job", () => {
    const r = resolveFleetJobs(
      sections([baseRef, block(["digest_min_delta = 0", 'name = "nightly"', 'agent = "standup"'])]),
    );
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]?.reason).toContain("[[fleet.job]] nightly digest_min_delta must be >= 1");
  });
});

describe("loadNimbusFleetFromPath: per-job resolution", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const write = (text: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-fleet-resolve-"));
    tempDirs.push(dir);
    const p = join(dir, "nimbus.toml");
    writeFileSync(p, text, "utf8");
    return p;
  };

  test("a bad [fleet] table still throws", () => {
    const p = write("[fleet]\nallow_remote = true\n");
    expect(() => loadNimbusFleetFromPath(p)).toThrow(FleetConfigError);
  });

  test("a bad job drops only itself, and the checker is applied", () => {
    const p = write(
      [
        "[fleet]",
        "enabled = true",
        "[[fleet.job]]",
        'name = "a"',
        'agent = "standup"',
        "interval_seconds = 60",
        "[[fleet.job]]",
        'name = "b"',
        'agent = "standup"',
        "interval_seconds = 60",
        "[[fleet.job]]",
        'name = "c"',
        "interval_seconds = 60",
        "",
      ].join("\n"),
    );
    const loaded = loadNimbusFleetFromPath(p, (job) => (job.name === "b" ? "nope" : undefined));
    expect(loaded.config.enabled).toBe(true);
    expect(loaded.jobs.map((j) => j.name)).toEqual(["a"]);
    const base: LayerRef = { kind: "base", id: "base", path: p };
    expect(loaded.dropped).toEqual([
      { name: "b", layer: base, reason: "nope" },
      { name: "c", layer: base, reason: "[[fleet.job]] c requires agent" },
    ]);
  });
});
