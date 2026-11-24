// packages/gateway/src/connectors/connector-writes/iac-plan-preview-moves.test.ts
// The apply preview shows a plan's MOVES (a `resource_changes` entry with `previous_address`; a
// move-only one is a `no-op`), as the refresh-only drift block already does. Fixtures follow
// HashiCorp's documented JSON output format (jsonplan); not recorded from a real terraform.
import { describe, expect, test } from "bun:test";
import { renderPlanPreview } from "./iac-plan-preview.ts";

const SHA = "a".repeat(64);
type Obj = Record<string, unknown>;

function change(
  address: string,
  actions: readonly string[],
  extra: { before?: unknown; after?: unknown } = {},
): Obj {
  return {
    address,
    mode: "managed",
    type: "aws_s3_bucket",
    name: "x",
    provider_name: "registry.terraform.io/hashicorp/aws",
    change: {
      actions,
      before: extra.before ?? null,
      after: extra.after ?? null,
      after_unknown: {},
      before_sensitive: false,
      after_sensitive: {},
    },
  };
}

function plan(resourceChanges: Obj[]): Obj {
  return {
    format_version: "1.2",
    terraform_version: "1.9.5",
    planned_values: {},
    resource_changes: resourceChanges,
    applyable: true,
    complete: true,
    errored: false,
  };
}

function render(p: unknown, limits?: Parameters<typeof renderPlanPreview>[2]) {
  const out = renderPlanPreview(p, SHA, limits);
  if (!out.ok) throw new Error(`refused: ${out.reason}`);
  return out.preview;
}

function reason(p: unknown, limits?: Parameters<typeof renderPlanPreview>[2]): string {
  const out = renderPlanPreview(p, SHA, limits);
  if (out.ok) throw new Error("expected a refusal");
  return out.reason;
}

describe("renderPlanPreview: moves in a normal plan (Terraform jsonplan previous_address)", () => {
  const PROVIDER = "registry.terraform.io/hashicorp/aws";
  const moved = (to: string, from: string, actions: readonly string[] = ["no-op"]): Obj => ({
    ...change(to, actions, { before: { a: 1 }, after: { a: actions[0] === "update" ? 2 : 1 } }),
    previous_address: from,
  });

  test("a move-only no-op is shown and counted", () => {
    const r = render(plan([moved("aws_s3_bucket.b", "aws_s3_bucket.a")]));
    expect(r.lines).toContain(
      `[moved in the state] aws_s3_bucket.a -> aws_s3_bucket.b (aws_s3_bucket, ${PROVIDER})`,
    );
    expect(r.counts.move).toBe(1);
    expect(r.lines[0]).toBe("Deletes: 0, Replaces: 0, Creates: 0, Updates: 0, Moves: 1");
    expect(r.lines.at(-1)).toBe("End of plan: 0 changes (0 deletes, 0 replaces), 1 moves");
    expect(r.changeCount).toBe(0);
  });

  test("a changed object that also moved names where it moved from", () => {
    const r = render(plan([moved("aws_s3_bucket.b", "aws_s3_bucket.a", ["update"])]));
    expect(r.lines).toContain(
      `[update] aws_s3_bucket.b (aws_s3_bucket, ${PROVIDER}) (moved from aws_s3_bucket.a)`,
    );
    expect(r.counts.update).toBe(1);
    expect(r.counts.move).toBe(0);
  });

  test("previous_address equal to address is not a move; a plan with no moves renders as before", () => {
    const r = render(plan([moved("aws_s3_bucket.a", "aws_s3_bucket.a")]));
    expect(r.counts.move).toBe(0);
    expect(r.text).not.toContain("moved");
    expect(r.lines[0]).toBe("Deletes: 0, Replaces: 0, Creates: 0, Updates: 0");
  });

  test("a non-string previous_address is unshowable, on a no-op and on a change", () => {
    for (const actions of [["no-op"], ["update"]]) {
      const bad = { ...moved("aws_s3_bucket.b", "x", actions), previous_address: 7 };
      expect(reason(plan([bad]))).toBe("unshowable");
    }
  });

  test("the previous address is escaped, so it cannot start a line of its own", () => {
    const r = render(plan([moved("aws_s3_bucket.b", "a\nDeletes: 0")]));
    expect(r.lines.some((l) => l.startsWith("Deletes: 0") && l.includes("moved"))).toBe(false);
    expect(r.text).toContain(String.raw`a\u{000A}Deletes: 0`);
  });

  test("moves count toward the change cap: a plan too large to show is refused", () => {
    const many = [
      moved("aws_s3_bucket.b", "aws_s3_bucket.a"),
      moved("aws_s3_bucket.d", "aws_s3_bucket.c"),
    ];
    expect(reason(plan(many), { maxChanges: 1 })).toBe("tooLarge");
  });
});
