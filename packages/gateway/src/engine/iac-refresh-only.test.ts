// packages/gateway/src/engine/iac-refresh-only.test.ts
// OR-S4-DRIFT: the refresh-only side of the Terraform settler. Real temp directories and the real
// filesystem ops; the only fake is the `terraform show -json` call (no terraform is installed
// where this was written, so the plan JSON below follows HashiCorp's documented format).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlanPreview } from "../connectors/connector-writes/iac-plan-preview.ts";
import {
  DESTROY_PLAN_NAME,
  PLAN_NAME,
  planFileName,
  REFRESH_PLAN_NAME,
  refreshOnlyRefusal,
  settledFields,
} from "./iac-refresh-only.ts";
import { nodeSettleFs, settleTerraformPlan, type TerraformSettleOps } from "./iac-settle.ts";
import { PREPARE_REFUSALS, PrepareRefusedError } from "./prepare-step.ts";

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const BYTES = Buffer.from("refresh-only-plan-bytes");
const PLAN_ID = "0123456789abcdef0123456789abcdef";
const WORKDIR = join(tmpdir(), "wd-refresh-not-touched");

let root: string;
let staging: string;
let approvedRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "iac-refresh-"));
  staging = join(root, "staging", "run1");
  approvedRoot = join(root, "approved");
  mkdirSync(join(staging, PLAN_ID), { recursive: true });
});

// A settled plan directory is 0o500, so on POSIX its entries cannot be unlinked until it is
// writable again.
function makeTreeRemovable(dir: string): void {
  if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return;
  chmodSync(dir, 0o700);
  for (const name of readdirSync(dir)) {
    const child = join(dir, name);
    if (lstatSync(child).isDirectory()) makeTreeRemovable(child);
  }
}

afterEach(() => {
  makeTreeRemovable(root);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const PROVIDER = "registry.terraform.io/hashicorp/aws";
const noOp = (address: string) => ({
  address,
  type: "aws_instance",
  provider_name: PROVIDER,
  change: { actions: ["no-op"], before: { ami: "a" }, after: { ami: "a" } },
});
const drifted = (address: string, secret = "hunter2-ami") => ({
  address,
  type: "aws_instance",
  provider_name: PROVIDER,
  change: { actions: ["update"], before: { ami: "a" }, after: { ami: secret, tags: { k: "v" } } },
});
const refreshPlan = (over: Record<string, unknown> = {}) => ({
  format_version: "1.2",
  terraform_version: "1.9.5",
  applyable: true,
  errored: false,
  resource_drift: [drifted("aws_instance.web")],
  resource_changes: [noOp("aws_instance.web")],
  ...over,
});

function writePlan(name = REFRESH_PLAN_NAME): string {
  const p = join(staging, PLAN_ID, name);
  writeFileSync(p, BYTES);
  return p;
}

let nextRun = 0;
function ops(plan: unknown): TerraformSettleOps {
  return {
    fs: nodeSettleFs(),
    show: (args) =>
      Promise.resolve({
        planJson: JSON.stringify(plan),
        planSha256: sha(readFileSync(args.planFile)),
      }),
    randomHex: () => {
      nextRun += 1;
      return `run${String(nextRun).padStart(29, "0")}`;
    },
  };
}

const request = (planFile: string, over: Record<string, unknown> = {}) => ({
  destroy: false,
  refreshOnly: true,
  workingDirectory: WORKDIR,
  reply: { planId: PLAN_ID, planFile, planSha256: "f".repeat(64), hasChanges: true },
  stagingDir: staging,
  approvedRoot,
  ...over,
});

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PrepareRefusedError) return e.reason;
    throw e;
  }
  throw new Error("expected a PrepareRefusedError");
}

describe("settleTerraformPlan for a refresh-only plan", () => {
  test("settles refresh.tfplan, binds the gateway's own values and shows the drift by name, never a value", async () => {
    const planFile = writePlan();
    const out = await settleTerraformPlan(ops(refreshPlan()), request(planFile));
    const moved = out.values["planFile"] ?? "";
    expect(moved.endsWith(REFRESH_PLAN_NAME)).toBe(true);
    expect(Object.keys(out.values).sort()).toEqual(["planFile", "planSha256"]);
    expect(out.values["planSha256"]).toBe(sha(BYTES));
    expect(out.plan?.lines[0]).toBe("Deletes: 0, Replaces: 0, Creates: 0, Updates: 0");
    expect(out.plan?.driftCount).toBe(1);
    const text = out.plan?.text ?? "";
    expect(text).toContain("[changed outside Terraform] aws_instance.web");
    expect(text).toContain("changed: ami");
    expect(text).toContain("changed: tags");
    expect(text).toContain(`Plan SHA-256: ${sha(BYTES)}`);
    expect(text).not.toContain("hunter2-ami");
    expect(out.fields).toEqual([
      { label: "Plan SHA-256", value: sha(BYTES) },
      { label: "Workdir", value: WORKDIR },
      {
        label: "Accepts",
        value: "1 objects changed outside Terraform into the state; no infrastructure changes",
      },
    ]);
    await out.cleanup();
    expect(existsSync(staging)).toBe(false);
  });

  test("a data-source read is not a change", async () => {
    const plan = refreshPlan({
      resource_changes: [
        noOp("aws_instance.web"),
        {
          address: "data.aws_ami.x",
          mode: "data",
          type: "aws_ami",
          provider_name: PROVIDER,
          change: { actions: ["read"], before: null, after: { id: "ami-1" } },
        },
      ],
    });
    const out = await settleTerraformPlan(ops(plan), request(writePlan()));
    expect(out.plan?.text).toContain("Reads: 1");
    await out.cleanup();
  });

  test.each([
    ["an update", { actions: ["update"], before: { a: 1 }, after: { a: 2 } }],
    ["a create", { actions: ["create"], before: null, after: { a: 1 } }],
    ["a delete", { actions: ["delete"], before: { a: 1 }, after: null }],
    ["a replace", { actions: ["delete", "create"], before: { a: 1 }, after: { a: 2 } }],
  ])(
    "a plan that holds %s is refused as not refresh-only, leaving nothing behind",
    async (_n, change) => {
      const plan = refreshPlan({
        resource_changes: [
          noOp("aws_instance.web"),
          { address: "aws_s3_bucket.b", type: "aws_s3_bucket", provider_name: PROVIDER, change },
        ],
      });
      expect(await refusal(settleTerraformPlan(ops(plan), request(writePlan())))).toBe(
        PREPARE_REFUSALS.notRefreshOnly,
      );
      expect(existsSync(staging)).toBe(false);
      expect(existsSync(approvedRoot) ? readdirSync(approvedRoot) : []).toEqual([]);
    },
  );

  test.each([[[{ action: "x" }]], ["x"]])(
    "a plan that saves provider actions (%p) is refused as not refresh-only",
    async (actions) => {
      const plan = refreshPlan({ action_invocations: actions });
      expect(await refusal(settleTerraformPlan(ops(plan), request(writePlan())))).toBe(
        PREPARE_REFUSALS.notRefreshOnly,
      );
    },
  );

  test("a plan with no drift to accept is nothingToApply", async () => {
    const plan = refreshPlan({ resource_drift: [] });
    expect(await refusal(settleTerraformPlan(ops(plan), request(writePlan())))).toBe(
      PREPARE_REFUSALS.nothingToApply,
    );
  });

  test("drift that is not the documented shape cannot be shown", async () => {
    const plan = refreshPlan({ resource_drift: "nope" });
    expect(await refusal(settleTerraformPlan(ops(plan), request(writePlan())))).toBe(
      PREPARE_REFUSALS.unshowable,
    );
  });

  test("more drifted objects than the block lists is refused, never approved unseen", async () => {
    const many = Array.from({ length: 101 }, (_x, i) => drifted(`aws_instance.i${String(i)}`));
    const plan = refreshPlan({ resource_drift: many });
    expect(await refusal(settleTerraformPlan(ops(plan), request(writePlan())))).toBe(
      PREPARE_REFUSALS.diffTooLarge,
    );
  });

  // Terraform puts a move-only object in a refresh-only plan's resource_drift as a no-op with
  // previous_address (jsonplan/plan.go, v1.9.5): accepting the plan moves it in the state.
  const movedOnly = (from: string, to: string) => ({ ...noOp(to), previous_address: from });

  test("a move-only object beside attribute drift is shown with both addresses and counted", async () => {
    const plan = refreshPlan({
      resource_drift: [
        drifted("aws_instance.web"),
        movedOnly("aws_instance.old", "aws_instance.db"),
      ],
    });
    const out = await settleTerraformPlan(ops(plan), request(writePlan()));
    expect(out.plan?.driftCount).toBe(2);
    expect(out.plan?.text).toContain(
      `[moved in the state] aws_instance.old -> aws_instance.db (aws_instance, ${PROVIDER})`,
    );
    await out.cleanup();
  });

  test("a plan that only moves objects is shown, not refused as nothing to apply", async () => {
    const plan = refreshPlan({ resource_drift: [movedOnly("aws_instance.a", "aws_instance.b")] });
    const out = await settleTerraformPlan(ops(plan), request(writePlan()));
    expect(out.plan?.driftCount).toBe(1);
    expect(out.plan?.text).toContain("[moved in the state] aws_instance.a -> aws_instance.b");
    await out.cleanup();
  });

  test("a drifted object that also moved names where it moved from", async () => {
    const both = { ...drifted("aws_instance.new"), previous_address: "aws_instance.prev" };
    const out = await settleTerraformPlan(
      ops(refreshPlan({ resource_drift: [both] })),
      request(writePlan()),
    );
    expect(out.plan?.text).toContain(
      `[changed outside Terraform] aws_instance.new (aws_instance, ${PROVIDER}) (moved from aws_instance.prev)`,
    );
    await out.cleanup();
  });

  test("a previous_address that is not a string cannot be shown", async () => {
    const bad = { ...noOp("aws_instance.b"), previous_address: 7 };
    const plan = refreshPlan({ resource_drift: [drifted("aws_instance.web"), bad] });
    expect(await refusal(settleTerraformPlan(ops(plan), request(writePlan())))).toBe(
      PREPARE_REFUSALS.unshowable,
    );
  });

  test("hasChanges false (the state would not change) is nothingToApply", async () => {
    const p = writePlan();
    const req = request(p, { reply: { planId: PLAN_ID, planFile: p, hasChanges: false } });
    expect(await refusal(settleTerraformPlan(ops(refreshPlan()), req))).toBe(
      PREPARE_REFUSALS.nothingToApply,
    );
  });

  test.each([PLAN_NAME, DESTROY_PLAN_NAME])(
    "the file name is the kind: %s is refused for it",
    async (name) => {
      const p = writePlan(name);
      expect(await refusal(settleTerraformPlan(ops(refreshPlan()), request(p)))).toBe(
        PREPARE_REFUSALS.unbound,
      );
    },
  );

  test.each([false, true])(
    "an apply or destroy settle (destroy=%p) refuses refresh.tfplan",
    async (destroy) => {
      const p = writePlan(REFRESH_PLAN_NAME);
      expect(
        await refusal(
          settleTerraformPlan(ops(refreshPlan()), request(p, { refreshOnly: false, destroy })),
        ),
      ).toBe(PREPARE_REFUSALS.unbound);
    },
  );

  test("an ordinary apply still shows its counts, not a drift line", async () => {
    const p = writePlan(PLAN_NAME);
    const plan = refreshPlan({
      resource_changes: [
        {
          address: "aws_s3_bucket.b",
          type: "aws_s3_bucket",
          provider_name: PROVIDER,
          change: { actions: ["create"], before: null, after: { b: 1 } },
        },
      ],
    });
    const out = await settleTerraformPlan(ops(plan), request(p, { refreshOnly: false }));
    expect(out.fields?.[2]).toEqual({
      label: "Changes",
      value: "1 to add, 0 to change, 0 to destroy",
    });
    await out.cleanup();
  });
});

describe("the pure helpers", () => {
  test("planFileName names each kind", () => {
    expect(planFileName({ destroy: false })).toBe(PLAN_NAME);
    expect(planFileName({ destroy: true })).toBe(DESTROY_PLAN_NAME);
    expect(planFileName({ destroy: false, refreshOnly: true })).toBe(REFRESH_PLAN_NAME);
    expect(planFileName({ destroy: true, refreshOnly: true })).toBe(REFRESH_PLAN_NAME);
  });

  const preview = (over: Partial<PlanPreview>): PlanPreview =>
    ({
      changeCount: 0,
      driftCount: 2,
      driftLines: ["Drift: 2 objects", "  [x] a", "  [x] b"],
      counts: { create: 0, update: 0, delete: 0, replace: 0, read: 0 },
      ...over,
    }) as PlanPreview;

  test("refreshOnlyRefusal accepts only a plan with no change and listed drift", () => {
    expect(refreshOnlyRefusal(preview({}), {})).toBeUndefined();
    expect(refreshOnlyRefusal(preview({}), { action_invocations: [] })).toBeUndefined();
    expect(refreshOnlyRefusal(preview({}), "not an object")).toBeUndefined();
    expect(refreshOnlyRefusal(preview({ changeCount: 1 }), {})).toBe(
      PREPARE_REFUSALS.notRefreshOnly,
    );
    expect(refreshOnlyRefusal(preview({ driftCount: null }), {})).toBe(PREPARE_REFUSALS.unshowable);
    expect(refreshOnlyRefusal(preview({ driftCount: 0 }), {})).toBe(
      PREPARE_REFUSALS.nothingToApply,
    );
    expect(refreshOnlyRefusal(preview({ driftLines: ["Drift: 2 objects (too many)"] }), {})).toBe(
      PREPARE_REFUSALS.diffTooLarge,
    );
  });

  test("settledFields reads the drift count, defaulting an unreadable one to 0", () => {
    const fields = settledFields(preview({ driftCount: null }), "/w", "a".repeat(64), true);
    expect(fields[2]?.value).toStartWith("0 objects");
  });
});
