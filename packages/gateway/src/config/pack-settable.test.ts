import { describe, expect, test } from "bun:test";
import {
  checkPackFragment,
  PACK_FRAGMENT_MAX_BYTES,
  PACK_ID_RE,
  PACK_SETTABLE_ARRAYS,
  PACK_SETTABLE_KEYS,
  type PackJobChecker,
  parseAgentNameList,
} from "./pack-settable.ts";

const none: PackJobChecker = () => [];

function problemsOf(text: string, checker: PackJobChecker = none): readonly string[] {
  const r = checkPackFragment(text, checker);
  if (r.ok) throw new Error("expected a refusal");
  return r.problems;
}

describe("pack-settable allowlist", () => {
  test("the allowlist is exactly the v1 set", () => {
    expect(PACK_SETTABLE_KEYS.map((k) => `${k.section}.${k.key}`)).toEqual([
      "fleet.enabled",
      "fleet.min_idle_seconds",
      "fleet.require_ac_power",
      "fleet.retention_days",
      "oncall.push.enabled",
      "decisions.min_confidence",
    ]);
    expect(PACK_SETTABLE_ARRAYS.map((a) => a.header)).toEqual(["fleet.job"]);
    for (const k of PACK_SETTABLE_KEYS) {
      expect(k.why.length).toBeGreaterThan(0);
      expect(k.consumer).toBe(k.section === "decisions" ? "per-call" : "reactive");
    }
    for (const a of PACK_SETTABLE_ARRAYS) {
      expect(a.why.length).toBeGreaterThan(0);
      expect(a.consumer).toBe("reactive");
    }
  });

  test("accepts an allowlisted fragment", () => {
    const r = checkPackFragment(
      "[fleet]\nenabled = true\nretention_days = 7\n[decisions]\nmin_confidence = 0.7\n",
      none,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scalars.get("fleet.enabled")).toBe(true);
    expect(r.scalars.get("fleet.retention_days")).toBe(7);
    expect(r.scalars.get("decisions.min_confidence")).toBe(0.7);
  });

  test("[oncall.push] enabled is settable; its other keys are not", () => {
    const r = checkPackFragment("[oncall.push]\nenabled = true\n", none);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scalars.get("oncall.push.enabled")).toBe(true);
    expect(problemsOf('[oncall.push]\nchatops_namespace = "x"\n')).toContain(
      "[oncall.push] chatops_namespace is not pack-settable",
    );
  });

  test("names every off-list key", () => {
    const p = problemsOf(
      "[decisions]\nmin_confidence = 0.7\n[llm.remote.openai]\nenabled = true\n[fleet]\nallow_remote = true\n",
    );
    expect(p).toContain("[llm.remote.openai] enabled is not pack-settable");
    expect(p).toContain("[fleet] allow_remote is not pack-settable");
  });

  test("refuses a value its loader would reject or misread", () => {
    expect(problemsOf("[fleet]\nretention_days = 0\n")).toContain(
      "[fleet] retention_days = 0: expected an integer >= 1",
    );
    expect(problemsOf('[fleet]\nenabled = "yes"\n').join("\n")).toContain("expected true or false");
    expect(problemsOf("[fleet]\nmin_idle_seconds = -1\n")).toHaveLength(1);
    expect(problemsOf("[decisions]\nmin_confidence = 1.5\n")).toHaveLength(1);
  });

  test("refuses shapes the allowlist cannot express", () => {
    expect(problemsOf("x = 1\n")).toHaveLength(1);
    expect(problemsOf("[fleet\n")).toHaveLength(1);
    expect(problemsOf("[fleet]\nenabled\n")).toHaveLength(1);
    expect(problemsOf('[[filesystem.roots]]\npath = "x"\n')).toHaveLength(1);
    expect(problemsOf("[fleet]\nenabled = true\nenabled = false\n")).toHaveLength(1);
    expect(problemsOf('[[fleet.job]]\nagent = "x"\n')).toHaveLength(1);
    expect(problemsOf("[[fleet.job]]\n")).toHaveLength(1);
    expect(problemsOf('[[fleet.job]]\nname = ""\n')).toHaveLength(1);
    expect(problemsOf('[[fleet.job]]\nname = "a"\nname = "b"\n')).toHaveLength(1);
    expect(problemsOf("[llm.remote.openai]\n")).toHaveLength(1);
    expect(problemsOf(`# ${"x".repeat(PACK_FRAGMENT_MAX_BYTES)}\n`)).toHaveLength(1);
  });

  test("reports each problem once", () => {
    expect(problemsOf("[fleet\nenabled = true\n")).toHaveLength(1);
    const dup = problemsOf("[fleet]\nretention_days = 0\nretention_days = 5\n");
    expect(dup.some((p) => p.includes("expected an integer >= 1"))).toBe(true);
    expect(dup.some((p) => p.toLowerCase().includes("twice") || p.includes("duplicate"))).toBe(
      true,
    );
    let received = "";
    const spy: PackJobChecker = (t) => {
      received = t;
      return [];
    };
    expect(problemsOf('[[fleet.job]]\nagent = "x"\n', spy)).toHaveLength(1);
    expect(received).toBe("");
  });

  test("a job block with a line that is not key = value is refused before the job checker", () => {
    let calls = 0;
    const spy: PackJobChecker = () => {
      calls++;
      return [];
    };
    const problems = problemsOf(
      '[[fleet.job]]\nname = "a"\nagent = "standup"\ninterval_seconds = 60\ndesc = """\n',
      spy,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('[[fleet.job]] has a line that is not "key = value"');
    expect(calls).toBe(0);
  });

  test("min_confidence must be a plain decimal", () => {
    for (const v of ['""', "   ", "0x0", "0b0", "1e-1"]) {
      expect(problemsOf(`[decisions]\nmin_confidence = ${v}\n`)).toHaveLength(1);
    }
    for (const v of ["0", "1", "0.70", "+0.5"]) {
      expect(checkPackFragment(`[decisions]\nmin_confidence = ${v}\n`, none).ok).toBe(true);
    }
  });

  test("a comment-only fragment is a no-op layer", () => {
    const r = checkPackFragment("# nothing\n", none);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scalars.size).toBe(0);
    expect(r.jobNames).toEqual([]);
  });

  test("hands every fleet job block to the job checker", () => {
    let received = "";
    const spy: PackJobChecker = (t) => {
      received = t;
      return [];
    };
    const r = checkPackFragment(
      '[[fleet.job]]\nname = "a"\nagent = "x"\n[[fleet.job]]\nname = "b"\nagent = "y"\n',
      spy,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.jobNames).toEqual(["a", "b"]);
    expect(received.match(/\[\[fleet\.job\]\]/g)).toHaveLength(2);
    expect(received).toContain('name = "b"');
    expect(problemsOf('[[fleet.job]]\nname = "a"\n', () => ["job a: bad"])).toEqual(["job a: bad"]);
  });
});

describe("PACK_ID_RE", () => {
  test("accepts and rejects ids", () => {
    for (const ok of ["pm", "devops-1", "a_b"]) expect(PACK_ID_RE.test(ok)).toBe(true);
    for (const bad of ["PM", "-pm", "../x", "pm.toml", "", "a".repeat(65)]) {
      expect(PACK_ID_RE.test(bad)).toBe(false);
    }
  });

  test("refuses the Windows reserved device names as whole ids only", () => {
    const reserved = ["con", "prn", "aux", "nul"];
    for (let n = 1; n <= 9; n++) reserved.push(`com${n}`, `lpt${n}`);
    for (const bad of reserved) expect(PACK_ID_RE.test(bad)).toBe(false);
    for (const ok of ["console", "nul1", "com10", "lpt0", "com0", "auxiliary", "pm", "con-pm"]) {
      expect(PACK_ID_RE.test(ok)).toBe(true);
    }
  });
});

describe("[agents] visible", () => {
  const VIS = (v: string) => `[agents]
visible = ${v}
`;

  test("accepts [agents] visible with bare and prefixed names", () => {
    const r = checkPackFragment(VIS('["decisions", "agents.standup"]'), none);
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.lists.get("agents.visible")).toEqual(["decisions", "agents.standup"]);
    expect(r.scalars.size).toBe(0);
  });

  test("refuses an empty visible list", () => {
    expect(problemsOf(VIS("[]"))).toContain(
      '[agents] visible = []: expected a non-empty array of agent names, e.g. ["decisions", "standup"]',
    );
  });

  test("refuses a non-array", () => {
    expect(problemsOf(VIS('"decisions"')).join("\n")).toContain("[agents] visible");
  });

  test("refuses an unquoted name", () => {
    expect(problemsOf(VIS("[decisions, standup]")).join("\n")).toContain("[agents] visible");
  });

  test("refuses a trailing comma", () => {
    expect(problemsOf(VIS('["decisions",]')).join("\n")).toContain("[agents] visible");
  });

  test("refuses a 65-name list and accepts 64", () => {
    const many = (n: number) => `[${Array.from({ length: n }, () => '"a"').join(", ")}]`;
    expect(problemsOf(VIS(many(65))).join("\n")).toContain("[agents] visible");
    expect(parseAgentNameList(many(64))?.length).toBe(64);
  });

  test("accepts whitespace inside the brackets", () => {
    const r = checkPackFragment(VIS('[ "decisions" , "standup" ]'), none);
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.lists.get("agents.visible")).toEqual(["decisions", "standup"]);
  });

  test("refuses other [agents] keys", () => {
    for (const key of ["synthesis", "show", "hide"]) {
      const value = key === "synthesis" ? '"local"' : '["x"]';
      expect(
        problemsOf(`[agents]
${key} = ${value}
`),
      ).toContain(`[agents] ${key} is not pack-settable`);
    }
  });

  test("accepts an unknown but well-formed name", () => {
    const r = checkPackFragment(VIS('["standpu"]'), none);
    expect(r.ok).toBe(true);
  });

  test("refuses visible set twice", () => {
    expect(problemsOf('[agents]\nvisible = ["a"]\nvisible = ["b"]\n').join("\n")).toContain(
      "[agents] sets visible twice",
    );
  });
});
