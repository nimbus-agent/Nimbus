// The A6 helper reads `nimbus agent status --json`. These tests build that document from the real
// status code over an in-memory machine, so a change to the status shape breaks the helper's test.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { applyPlan } from "../../packages/cli/src/agent-kits/apply.ts";
import { fakeMachine, HOME } from "../../packages/cli/src/agent-kits/fake-env.test-helpers.ts";
import { planKit } from "../../packages/cli/src/agent-kits/kits/index.ts";
import { planKitRemoval } from "../../packages/cli/src/agent-kits/removal.ts";
import { allKitStatuses, needsAttention } from "../../packages/cli/src/agent-kits/status.ts";
import {
  evaluate,
  FIXED_PROMPT,
  type Io,
  planText,
  rowText,
  run,
  type StatusJson,
} from "./verify-kit.ts";

const ROOT = join(import.meta.dir, "..", "..");

function statusOf(m: ReturnType<typeof fakeMachine>): StatusJson {
  const statuses = allKitStatuses(m.env);
  return JSON.parse(
    JSON.stringify({
      kits: statuses.map((s) => ({ ...s, agentVersion: "9.9.9" })),
      needsAttention: needsAttention(statuses),
    }),
  ) as StatusJson;
}

describe("evaluate", () => {
  test("not installed, installed, drifted, clean again, removed", async () => {
    const m = fakeMachine();
    expect(evaluate(statusOf(m), "codex", "user", "installed").pass).toBe(false);
    expect(evaluate(statusOf(m), "codex", "user", "removed").pass).toBe(true);

    await applyPlan(planKit("codex", m.env, "user"), m.fs, new Date(0));
    expect(evaluate(statusOf(m), "codex", "user", "installed").pass).toBe(true);
    expect(evaluate(statusOf(m), "codex", "user", "clean").pass).toBe(true);
    expect(evaluate(statusOf(m), "codex", "user", "drifted").pass).toBe(false);

    const rules = join(HOME, ".codex", "rules", "nimbus.rules");
    m.files.set(rules, (m.files.get(rules) ?? "").replace('"forbidden"', '"allow"'));
    expect(evaluate(statusOf(m), "codex", "user", "drifted").pass).toBe(true);
    expect(evaluate(statusOf(m), "codex", "user", "clean").pass).toBe(false);

    await applyPlan(planKit("codex", m.env, "user"), m.fs, new Date(1000));
    expect(evaluate(statusOf(m), "codex", "user", "clean").pass).toBe(true);

    await applyPlan(planKitRemoval("codex", m.env, "user"), m.fs, new Date(2000));
    expect(evaluate(statusOf(m), "codex", "user", "removed").pass).toBe(true);
    expect(evaluate(statusOf(m), "codex", "user", "installed").pass).toBe(false);
  });

  test("a scope the status does not list is a failure with a reason", () => {
    const r = evaluate(statusOf(fakeMachine()), "codex", "project", "installed");
    expect(r).toEqual({ pass: false, detail: "status has no entry for codex at project scope" });
  });
});

describe("the procedure and the helper agree", () => {
  test("the fixed prompt is the one in docs/agent-kits-verification.md", () => {
    const doc = readFileSync(join(ROOT, "docs/agent-kits-verification.md"), "utf8");
    expect(doc).toContain(FIXED_PROMPT);
  });

  test("the plan names the commands, keeps the claude-code user-scope server step, and never claims A6", () => {
    const text = planText("claude-code", "user");
    expect(text).toContain("nimbus agent uninstall claude-code --scope user");
    expect(text).toContain("claude mcp add --scope user nimbus");
    expect(planText("codex", "user")).not.toContain("claude mcp add");
    expect(text).toContain("A6 closes only when two rows are filled by a person");
  });

  test("a row has nine cells, na for a guidance-only kit, and no pipe inside a cell", () => {
    const row = rowText({
      kit: "cursor",
      agentVersion: "1|2",
      os: "win",
      by: "me",
      date: "2026-11-23",
      mcp: "pass",
      queue: "pass",
      blocked: "na",
      drift: "fail",
    });
    expect(row).toContain("not applicable (guidance only)");
    expect(row).toContain("FAIL");
    expect(row.split(" | ").length).toBe(9);
    expect(row).toContain("1/2");
  });
});

describe("run", () => {
  function io(statusText: string | undefined) {
    const out: string[] = [];
    const err: string[] = [];
    const h: Io = {
      out: (s) => void out.push(s),
      err: (s) => void err.push(s),
      status: () =>
        statusText === undefined
          ? { ok: false, reason: "no nimbus" }
          : { ok: true, text: statusText },
      today: () => "2026-11-23",
    };
    return { h, out, err };
  }

  test("check exits 0 on the expected answer, 1 on another, 2 on a bad call or a missing nimbus", async () => {
    const m = fakeMachine();
    await applyPlan(planKit("codex", m.env, "user"), m.fs, new Date(0));
    const doc = JSON.stringify(statusOf(m));
    const a = io(doc);
    expect(run(["check", "installed", "codex"], a.h)).toBe(0);
    expect(a.out.join("")).toContain("PASS installed codex (user)");
    expect(a.out.join("")).toContain("agent version: 9.9.9");
    expect(run(["check", "removed", "codex"], io(doc).h)).toBe(1);
    expect(run(["check", "bogus", "codex"], io(doc).h)).toBe(2);
    expect(run(["check", "installed", "codex"], io(undefined).h)).toBe(2);
    expect(run(["check", "installed", "codex"], io("not json").h)).toBe(2);
    expect(run(["check", "installed", "codex", "--scope", "x"], io(doc).h)).toBe(2);
  });

  test("plan and row print, and a bad call is a usage error", () => {
    const p = io(undefined);
    expect(run(["plan", "codex"], p.h)).toBe(0);
    expect(p.out.join("")).toContain(FIXED_PROMPT.split("\n")[0] ?? "");
    const r = io(undefined);
    const args = [
      "row",
      "codex",
      "--agent-version",
      "1.2",
      "--os",
      "linux",
      "--by",
      "me",
      "--mcp",
      "pass",
      "--queue",
      "pass",
      "--blocked",
      "pass",
      "--drift",
      "pass",
    ];
    expect(run(args, r.h)).toBe(0);
    expect(r.out.join("")).toContain(
      "| Codex | 1.2 | linux | pass | pass | pass | pass | 2026-11-23 | me |",
    );
    expect(run(["row", "codex"], io(undefined).h)).toBe(2);
    expect(run(["plan", "nope"], io(undefined).h)).toBe(2);
    expect(run([], io(undefined).h)).toBe(2);
  });
});
