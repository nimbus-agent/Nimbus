// packages/gateway/src/engine/iac-settle.test.ts
// Phase 9.7 D2 (Task 3): the settlers. Real temp directories and the real filesystem ops; the only
// fake is the `terraform show -json` call (no terraform is installed where this was written).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IAC_LIMITS } from "../connectors/connector-writes/iac-limits.ts";
import { installedConnectorsPackageRoot } from "../connectors/testing/connector-write-registrations.ts";
import { expectLinearGrowth } from "../testing/linear-growth.ts";
import {
  type BoundWriteCapabilities,
  nodeSettleFs,
  type SettleFs,
  settleCfnChangeSet,
  settleTerraformPlan,
  type TerraformSettleOps,
} from "./iac-settle.ts";
import { PREPARE_REFUSALS, PrepareRefusedError } from "./prepare-step.ts";

const BS = String.fromCharCode(92);
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const PLAN_BYTES = Buffer.from("not-a-real-plan-file-just-bytes\u0000\u0001");
const PLAN_ID = "0123456789abcdef0123456789abcdef";
const WORKDIR = join(tmpdir(), "wd-not-touched");

let root: string;
let staging: string;
let approvedRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "iac-settle-"));
  staging = join(root, "staging", "run1");
  approvedRoot = join(root, "approved");
  mkdirSync(join(staging, PLAN_ID), { recursive: true });
});

// A settled plan directory is 0o500 (the applying child may only read it), so on POSIX its
// entries cannot be unlinked until it is writable again. Restore owner write on every directory
// under the temp root, never following a link, before removing it.
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

function writePlan(name = "plan.tfplan", bytes: Uint8Array = PLAN_BYTES): string {
  const p = join(staging, PLAN_ID, name);
  writeFileSync(p, bytes);
  return p;
}

const mkReply = (planFile: string, over: Record<string, unknown> = {}) => ({
  planId: PLAN_ID,
  planFile,
  planSha256: sha("what the planning child CLAIMS"),
  hasChanges: true,
  ...over,
});

/** Documented `terraform show -json` shape (see iac-plan-preview.test.ts for provenance). */
const PLAN_JSON = {
  format_version: "1.2",
  terraform_version: "1.9.5",
  applyable: true,
  errored: false,
  resource_changes: [
    {
      address: "aws_s3_bucket.b",
      type: "aws_s3_bucket",
      provider_name: "registry.terraform.io/hashicorp/aws",
      change: { actions: ["create"], before: null, after: { bucket: "b" } },
    },
    {
      address: "aws_instance.i",
      type: "aws_instance",
      provider_name: "registry.terraform.io/hashicorp/aws",
      change: { actions: ["delete", "create"], before: { ami: "a" }, after: { ami: "b" } },
    },
  ],
};

interface ShowCall {
  readonly workingDirectory: string;
  readonly planFile: string;
}

/** An honest fake of the show child: it hashes the file it is handed, as the connector does. */
function honestShow(calls: ShowCall[], plan: unknown = PLAN_JSON): TerraformSettleOps["show"] {
  return (args) => {
    calls.push(args);
    return Promise.resolve({
      planJson: JSON.stringify(plan),
      planSha256: sha(readFileSync(args.planFile)),
    });
  };
}

let nextRun = 0;
function runId(): string {
  nextRun += 1;
  return `run${String(nextRun).padStart(29, "0")}`;
}
function ops(over: Partial<TerraformSettleOps> = {}): TerraformSettleOps {
  return {
    fs: nodeSettleFs(),
    show: honestShow([]),
    randomHex: runId,
    ...over,
  };
}

const request = (
  planFile: string,
  over: Partial<Parameters<typeof settleTerraformPlan>[1]> = {},
): Parameters<typeof settleTerraformPlan>[1] => ({
  destroy: false,
  workingDirectory: WORKDIR,
  reply: mkReply(planFile),
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

describe("settleTerraformPlan: the happy path", () => {
  test("moves the plan, hashes the moved bytes itself, shows what show -json said, binds its own values", async () => {
    const calls: ShowCall[] = [];
    const planFile = writePlan();
    const out = await settleTerraformPlan(ops({ show: honestShow(calls) }), request(planFile));
    const moved = out.values["planFile"] ?? "";
    expect(moved.startsWith(approvedRoot)).toBe(true);
    expect(moved).toContain(PLAN_ID);
    expect(moved.endsWith("plan.tfplan")).toBe(true);
    expect(out.values["planSha256"]).toBe(sha(PLAN_BYTES));
    expect(Object.keys(out.values).sort()).toEqual(["planFile", "planSha256"]);
    // The staging file is gone and the moved file holds exactly the planned bytes.
    expect(existsSync(planFile)).toBe(false);
    expect(readFileSync(moved).equals(PLAN_BYTES)).toBe(true);
    // The show child is handed the MOVED file and the workdir.
    expect(calls).toEqual([{ workingDirectory: WORKDIR, planFile: moved }]);
    // The preview is the renderer's, led by the counts.
    expect(out.plan?.lines[0]).toBe("Deletes: 0, Replaces: 1, Creates: 1, Updates: 0");
    expect(out.plan?.text).toContain(`Plan SHA-256: ${sha(PLAN_BYTES)}`);
    expect(out.fields).toEqual([
      { label: "Plan SHA-256", value: sha(PLAN_BYTES) },
      { label: "Workdir", value: WORKDIR },
      { label: "Changes", value: "2 to add, 0 to change, 1 to destroy" },
    ]);
  });

  test("the moved plan is read-only (the applying child can only read it)", async () => {
    const out = await settleTerraformPlan(ops(), request(writePlan()));
    const moved = out.values["planFile"] ?? "";
    expect(() => writeFileSync(moved, "tampered")).toThrow();
    expect(readFileSync(moved).equals(PLAN_BYTES)).toBe(true);
  });

  test("a destroy plan is destroy.tfplan, and each kind refuses the other's name", async () => {
    const destroyFile = writePlan("destroy.tfplan");
    const out = await settleTerraformPlan(
      ops(),
      request(destroyFile, { destroy: true, reply: mkReply(destroyFile) }),
    );
    expect((out.values["planFile"] ?? "").endsWith("destroy.tfplan")).toBe(true);

    const applyAsDestroy = writePlan("plan.tfplan");
    expect(
      await refusal(
        settleTerraformPlan(
          ops(),
          request(applyAsDestroy, { destroy: true, reply: mkReply(applyAsDestroy) }),
        ),
      ),
    ).toBe(PREPARE_REFUSALS.unbound);
  });

  test("the planning child's planSha256 is ignored: the bound hash is the gateway's own", async () => {
    const planFile = writePlan();
    const forged = "f".repeat(64);
    const out = await settleTerraformPlan(
      ops(),
      request(planFile, { reply: mkReply(planFile, { planSha256: forged }) }),
    );
    expect(out.values["planSha256"]).toBe(sha(PLAN_BYTES));
    expect(out.values["planSha256"]).not.toBe(forged);
    expect(JSON.stringify(out)).not.toContain(forged);
  });

  test("two settles use two run directories", async () => {
    const a = await settleTerraformPlan(ops(), request(writePlan()));
    mkdirSync(join(staging, PLAN_ID), { recursive: true });
    const b = await settleTerraformPlan(ops(), request(writePlan()));
    expect(a.values["planFile"]).not.toBe(b.values["planFile"]);
  });

  test("cleanup removes the run's approved directory and the staging directory, even read-only, and is idempotent", async () => {
    const out = await settleTerraformPlan(ops(), request(writePlan()));
    const moved = out.values["planFile"] ?? "";
    expect(existsSync(moved)).toBe(true);
    await out.cleanup();
    expect(existsSync(moved)).toBe(false);
    expect(existsSync(staging)).toBe(false);
    expect(existsSync(approvedRoot)).toBe(true);
    await out.cleanup();
  });
});

describe("settleTerraformPlan: the planFile path is the gateway's to check", () => {
  test("a plan outside the run's staging directory is refused", async () => {
    const outside = join(root, "elsewhere", PLAN_ID);
    mkdirSync(outside, { recursive: true });
    const p = join(outside, "plan.tfplan");
    writeFileSync(p, PLAN_BYTES);
    expect(await refusal(settleTerraformPlan(ops(), request(p)))).toBe(PREPARE_REFUSALS.unbound);
    expect(existsSync(p)).toBe(true);
  });

  test("a sibling directory whose name merely starts with the staging name is refused", async () => {
    const sibling = join(root, "staging", "run1-evil", PLAN_ID);
    mkdirSync(sibling, { recursive: true });
    const p = join(sibling, "plan.tfplan");
    writeFileSync(p, PLAN_BYTES);
    expect(await refusal(settleTerraformPlan(ops(), request(p)))).toBe(PREPARE_REFUSALS.unbound);
  });

  test("a plan directory whose name is not the reply's planId is refused", async () => {
    const other = "fedcba9876543210fedcba9876543210";
    mkdirSync(join(staging, other), { recursive: true });
    const p = join(staging, other, "plan.tfplan");
    writeFileSync(p, PLAN_BYTES);
    expect(await refusal(settleTerraformPlan(ops(), request(p)))).toBe(PREPARE_REFUSALS.unbound);
  });

  test.each([
    ["a planId that is not 32 lower-case hex", { planId: "NOT-HEX" }],
    ["a missing planId", { planId: undefined }],
    ["a planId with a path separator", { planId: `..${BS}..` }],
    ["a non-string planFile", { planFile: 7 }],
    ["a relative planFile", { planFile: "plan.tfplan" }],
    ["a device-form planFile", { planFile: `${BS}${BS}?${BS}C:${BS}x${BS}plan.tfplan` }],
    ["a UNC-form planFile", { planFile: `${BS}${BS}host${BS}share${BS}plan.tfplan` }],
    ["a // planFile", { planFile: "//host/share/plan.tfplan" }],
  ])("refuses %s", async (_name, over) => {
    const planFile = writePlan();
    const reply = mkReply(planFile, over as Record<string, unknown>);
    expect(await refusal(settleTerraformPlan(ops(), request(planFile, { reply })))).toBe(
      PREPARE_REFUSALS.unbound,
    );
  });

  test("a reply that is not an object is refused", async () => {
    for (const reply of [null, "x", 3, [], undefined]) {
      mkdirSync(join(staging, PLAN_ID), { recursive: true });
      expect(await refusal(settleTerraformPlan(ops(), request(writePlan(), { reply })))).toBe(
        PREPARE_REFUSALS.unbound,
      );
    }
  });

  test("a missing file and a directory in its place are refused", async () => {
    expect(
      await refusal(settleTerraformPlan(ops(), request(join(staging, PLAN_ID, "plan.tfplan")))),
    ).toBe(PREPARE_REFUSALS.unbound);
    mkdirSync(join(staging, PLAN_ID, "plan.tfplan"), { recursive: true });
    expect(
      await refusal(settleTerraformPlan(ops(), request(join(staging, PLAN_ID, "plan.tfplan")))),
    ).toBe(PREPARE_REFUSALS.unbound);
  });

  test("a symlink in place of the plan file is refused", async () => {
    const target = join(root, "target.bin");
    writeFileSync(target, PLAN_BYTES);
    const link = join(staging, PLAN_ID, "plan.tfplan");
    try {
      symlinkSync(target, link);
    } catch {
      return; // creating a link needs a privilege this machine lacks; the fake-fs test below covers the branch
    }
    expect(await refusal(settleTerraformPlan(ops(), request(link)))).toBe(PREPARE_REFUSALS.unbound);
    expect(existsSync(target)).toBe(true);
  });

  test("a symlinked plan directory is refused", async () => {
    const real = join(root, "real-plan-dir");
    mkdirSync(real);
    writeFileSync(join(real, "plan.tfplan"), PLAN_BYTES);
    const lnk = join(staging, "linked-id");
    try {
      symlinkSync(real, lnk, "junction");
    } catch {
      return;
    }
    const reply = mkReply(join(lnk, "plan.tfplan"), { planId: "linked-id" });
    expect(
      await refusal(settleTerraformPlan(ops(), request(join(lnk, "plan.tfplan"), { reply }))),
    ).toBe(PREPARE_REFUSALS.unbound);
    // The junction was removed with the staging directory; its target was not touched.
    expect(existsSync(join(real, "plan.tfplan"))).toBe(true);
    // Also with a well-formed id: the directory named by the id is a junction to elsewhere.
    mkdirSync(staging, { recursive: true });
    const idDir = join(staging, "ffffffffffffffffffffffffffffffff");
    try {
      symlinkSync(real, idDir, "junction");
    } catch {
      return;
    }
    const r2 = mkReply(join(idDir, "plan.tfplan"), { planId: "ffffffffffffffffffffffffffffffff" });
    expect(
      await refusal(settleTerraformPlan(ops(), request(join(idDir, "plan.tfplan"), { reply: r2 }))),
    ).toBe(PREPARE_REFUSALS.unbound);
    expect(existsSync(join(real, "plan.tfplan"))).toBe(true);
  });

  test("a hard-linked plan file is refused", async () => {
    const outside = join(root, "outside.bin");
    writeFileSync(outside, PLAN_BYTES);
    const p = join(staging, PLAN_ID, "plan.tfplan");
    linkSync(outside, p);
    expect(await refusal(settleTerraformPlan(ops(), request(p)))).toBe(PREPARE_REFUSALS.unbound);
    expect(readFileSync(outside).equals(PLAN_BYTES)).toBe(true);
  });

  test("a plan file over the gateway's size cap is refused", async () => {
    const p = writePlan();
    expect(
      await refusal(
        settleTerraformPlan(ops(), request(p), { maxPlanFileBytes: PLAN_BYTES.length - 1 }),
      ),
    ).toBe(PREPARE_REFUSALS.unbound);
    expect(IAC_LIMITS.maxPlanFileBytes).toBe(16 * 1024 * 1024);
  });
});

describe("settleTerraformPlan: hasChanges is a strict boolean gate", () => {
  test("false refuses with nothingToApply and leaves nothing behind", async () => {
    const p = writePlan();
    expect(
      await refusal(
        settleTerraformPlan(ops(), request(p, { reply: mkReply(p, { hasChanges: false }) })),
      ),
    ).toBe(PREPARE_REFUSALS.nothingToApply);
    expect(existsSync(staging)).toBe(false);
  });

  test.each([
    ["missing", undefined],
    ["the string true", "true"],
    ["1", 1],
    ["null", null],
  ])("%s refuses as unbound", async (_n, value) => {
    const p = writePlan();
    expect(
      await refusal(
        settleTerraformPlan(ops(), request(p, { reply: mkReply(p, { hasChanges: value }) })),
      ),
    ).toBe(PREPARE_REFUSALS.unbound);
  });
});

describe("settleTerraformPlan: the show step is verified, never trusted", () => {
  const withShow = (show: TerraformSettleOps["show"]) => ops({ show });

  test("a show reply whose hash differs from the gateway's own is refused", async () => {
    const out = settleTerraformPlan(
      withShow(() =>
        Promise.resolve({ planJson: JSON.stringify(PLAN_JSON), planSha256: "0".repeat(64) }),
      ),
      request(writePlan()),
    );
    expect(await refusal(out)).toBe(PREPARE_REFUSALS.unbound);
  });

  test("a show reply that is not an object, or whose hash is not a string, is refused", async () => {
    for (const reply of [null, "x", [], { planJson: "{}" }, { planJson: "{}", planSha256: 5 }]) {
      expect(
        await refusal(
          settleTerraformPlan(
            withShow(() => Promise.resolve(reply)),
            request(writePlan()),
          ),
        ),
      ).toBe(PREPARE_REFUSALS.unbound);
      mkdirSync(join(staging, PLAN_ID), { recursive: true });
    }
  });

  test.each([
    ["planJson not a string", { planJson: { a: 1 } }],
    ["planJson not JSON", { planJson: "terraform: not json" }],
    ["planJson a JSON array", { planJson: "[]" }],
    [
      "planJson an unknown format_version",
      { planJson: JSON.stringify({ ...PLAN_JSON, format_version: "2.0" }) },
    ],
    ["an errored plan", { planJson: JSON.stringify({ ...PLAN_JSON, errored: true }) }],
  ])("%s -> unshowable", async (_n, patch) => {
    const p = writePlan();
    const out = settleTerraformPlan(
      withShow(() =>
        Promise.resolve({ planJson: "", planSha256: sha(PLAN_BYTES), ...(patch as object) }),
      ),
      request(p),
    );
    expect(await refusal(out)).toBe(PREPARE_REFUSALS.unshowable);
  });

  test("planJson over the 4 MiB cap is refused before it is parsed", async () => {
    const out = settleTerraformPlan(
      withShow(() => Promise.resolve({ planJson: "x".repeat(100), planSha256: sha(PLAN_BYTES) })),
      request(writePlan()),
      { maxPlanJsonBytes: 99 },
    );
    expect(await refusal(out)).toBe(PREPARE_REFUSALS.unshowable);
    expect(IAC_LIMITS.maxPlanJsonBytes).toBe(4 * 1024 * 1024);
  });

  test("a plan over 500 changes, or a text over the cap, is refused with diffTooLarge", async () => {
    const many = {
      ...PLAN_JSON,
      resource_changes: Array.from({ length: 501 }, (_, i) => ({
        address: `a.r${String(i)}`,
        type: "t",
        provider_name: "p",
        change: { actions: ["create"] },
      })),
    };
    expect(
      await refusal(settleTerraformPlan(ops({ show: honestShow([], many) }), request(writePlan()))),
    ).toBe(PREPARE_REFUSALS.diffTooLarge);
  });

  test("a show failure that is a PrepareRefusedError keeps its own reason", async () => {
    const out = settleTerraformPlan(
      withShow(() => Promise.reject(new PrepareRefusedError(PREPARE_REFUSALS.timeout))),
      request(writePlan()),
    );
    expect(await refusal(out)).toBe(PREPARE_REFUSALS.timeout);
  });

  test("any other failure is the fixed settleFailed, and the error text goes nowhere", async () => {
    const out = settleTerraformPlan(
      withShow(() => Promise.reject(new Error("SECRET-PATH /home/x/credentials"))),
      request(writePlan()),
    );
    const reason = await refusal(out);
    expect(reason).toBe(PREPARE_REFUSALS.settleFailed);
    expect(reason).not.toContain("SECRET");
  });

  test.each(["hash mismatch", "unshowable", "show failure"])(
    "after a refusal (%s) the moved plan and the staging directory are gone",
    async (kind) => {
      const show: TerraformSettleOps["show"] =
        kind === "hash mismatch"
          ? () => Promise.resolve({ planJson: "{}", planSha256: "0".repeat(64) })
          : kind === "unshowable"
            ? () => Promise.resolve({ planJson: "nope", planSha256: sha(PLAN_BYTES) })
            : () => Promise.reject(new Error("boom"));
      await refusal(settleTerraformPlan(withShow(show), request(writePlan())));
      expect(existsSync(staging)).toBe(false);
      expect(existsSync(approvedRoot) ? readdirCount(approvedRoot) : 0).toBe(0);
    },
  );
});

function readdirCount(dir: string): number {
  return readdirSync(dir).length;
}

describe("settleTerraformPlan: the filesystem after the move is re-checked", () => {
  const swap = (patch: Partial<SettleFs>): SettleFs => ({ ...nodeSettleFs(), ...patch });

  test("a moved file that stats as a link is refused", async () => {
    const real = nodeSettleFs();
    let calls = 0;
    const fs = swap({
      lstat: async (p) => {
        const st = await real.lstat(p);
        calls += 1;
        // the first lstat is the staging file; the second is the moved file
        return st !== undefined && calls >= 2 ? { ...st, isSymbolicLink: true } : st;
      },
    });
    expect(await refusal(settleTerraformPlan(ops({ fs }), request(writePlan())))).toBe(
      PREPARE_REFUSALS.unbound,
    );
  });

  test("a moved file that is gone is refused", async () => {
    const real = nodeSettleFs();
    let calls = 0;
    const fs = swap({
      lstat: async (p) => {
        calls += 1;
        return calls >= 2 ? undefined : real.lstat(p);
      },
    });
    expect(await refusal(settleTerraformPlan(ops({ fs }), request(writePlan())))).toBe(
      PREPARE_REFUSALS.unbound,
    );
  });

  test("bytes read back over the cap are refused", async () => {
    const fs = swap({ readFile: async () => new Uint8Array(PLAN_BYTES.length + 10) });
    expect(
      await refusal(
        settleTerraformPlan(ops({ fs }), request(writePlan()), {
          maxPlanFileBytes: PLAN_BYTES.length,
        }),
      ),
    ).toBe(PREPARE_REFUSALS.unbound);
  });

  test("a filesystem error is the fixed settleFailed", async () => {
    const fs = swap({
      move: () => Promise.reject(new Error("EXDEV /secret/location")),
    });
    const reason = await refusal(settleTerraformPlan(ops({ fs }), request(writePlan())));
    expect(reason).toBe(PREPARE_REFUSALS.settleFailed);
  });
});

describe("nodeSettleFs", () => {
  test("move falls back to copy and unlink across devices, and rethrows other errors", async () => {
    const a = join(root, "a.bin");
    const b = join(root, "b.bin");
    writeFileSync(a, PLAN_BYTES);
    const exdev = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    await nodeSettleFs({ rename: () => Promise.reject(exdev) }).move(a, b);
    expect(existsSync(a)).toBe(false);
    expect(readFileSync(b).equals(PLAN_BYTES)).toBe(true);
    // A fresh source for the second case: re-writing `a` after checking it reads as a race.
    const a2 = join(root, "a-eperm.bin");
    writeFileSync(a2, PLAN_BYTES);
    const eperm = Object.assign(new Error("denied"), { code: "EPERM" });
    await expect(
      nodeSettleFs({ rename: () => Promise.reject(eperm) }).move(a2, join(root, "c")),
    ).rejects.toThrow("denied");
    expect(existsSync(a2)).toBe(true);
  });

  test("the copy fallback never overwrites an existing destination", async () => {
    const a = join(root, "a2.bin");
    const b = join(root, "b2.bin");
    writeFileSync(a, PLAN_BYTES);
    writeFileSync(b, "existing");
    const exdev = Object.assign(new Error("cross-device"), { code: "EXDEV" });
    await expect(
      nodeSettleFs({ rename: () => Promise.reject(exdev) }).move(a, b),
    ).rejects.toThrow();
    expect(readFileSync(b, "utf8")).toBe("existing");
  });

  test("mkdirNew refuses an existing directory", async () => {
    const fs = nodeSettleFs();
    const d = join(root, "new-dir");
    await fs.mkdirNew(d);
    await expect(fs.mkdirNew(d)).rejects.toThrow();
  });

  test("lstat is undefined for a missing path", async () => {
    expect(await nodeSettleFs().lstat(join(root, "nope"))).toBeUndefined();
  });

  test("removeTree on a missing path is a no-op", async () => {
    await expect(nodeSettleFs().removeTree(join(root, "nope"))).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// CloudFormation

const TEMPLATE = '{"Resources":{"B":{"Type":"AWS::S3::Bucket"}}}';
const T_SHA = sha(TEMPLATE);
const NAME = `nimbus-${T_SHA}-0123456789ab`;
const ARN = `arn:aws:cloudformation:eu-west-1:123456789012:changeSet/${NAME}/11111111-2222-3333-4444-555555555555`;
const CHANGE = {
  action: "Add",
  logicalId: "B",
  resourceType: "AWS::S3::Bucket",
  replacement: "False",
  scope: [] as string[],
};

/** The shape connectors/iac/src/tools.ts `changeSetCreate` replies with (pinned against its source below). */
function cfnReply(over: Record<string, unknown> = {}) {
  return {
    changeSetId: ARN,
    changeSetName: NAME,
    stackId: "arn:aws:cloudformation:eu-west-1:123456789012:stack/app/aaaa",
    stackName: "app",
    changeSetType: "UPDATE",
    templateSha256: T_SHA,
    capabilities: [] as string[],
    changes: [CHANGE],
    ...over,
  };
}

const cfnInput = (over: Record<string, unknown> = {}) => ({
  stackName: "app",
  templateBody: TEMPLATE,
  ...over,
});

function cfnRefusal(reply: unknown, input: Record<string, unknown> = cfnInput()): string {
  try {
    settleCfnChangeSet({ input, reply });
  } catch (e) {
    if (e instanceof PrepareRefusedError) return e.reason;
    throw e;
  }
  throw new Error("expected a PrepareRefusedError");
}

describe("settleCfnChangeSet", () => {
  test("a consistent reply binds exactly the change set ARN and shows the stack, account, region and template", () => {
    const out = settleCfnChangeSet({ input: cfnInput(), reply: cfnReply() });
    expect(out.values).toEqual({ changeSetId: ARN });
    expect(out.fields.map((f) => f.label)).toEqual([
      "Stack",
      "Account / Region",
      "Change set type",
      "Capabilities",
      "Template",
      "Changes",
    ]);
    expect(out.fields.find((f) => f.label === "Account / Region")?.value).toBe(
      "123456789012 / eu-west-1",
    );
    expect(out.fields.find((f) => f.label === "Capabilities")?.value).toBe("(none)");
    expect(out.fields.find((f) => f.label === "Template")?.value).toBe(
      `${String(Buffer.byteLength(TEMPLATE))} bytes, sha256 ${T_SHA.slice(0, 16)}`,
    );
    expect(out.plan?.lines.at(-1)).toBe(
      "End of change set: 1 changes (0 removals or replacements)",
    );
    expect(out.plan?.sha256).toBe(sha(out.plan?.text ?? ""));
  });

  test("removals and replacements are listed first", () => {
    const changes = [
      { ...CHANGE, logicalId: "Add1" },
      { ...CHANGE, action: "Modify", logicalId: "Rep", replacement: "True" },
      { ...CHANGE, action: "Remove", logicalId: "Gone" },
      {
        ...CHANGE,
        action: "Modify",
        logicalId: "Mod",
        replacement: "False",
        scope: ["Properties"],
      },
    ];
    const out = settleCfnChangeSet({ input: cfnInput(), reply: cfnReply({ changes }) });
    const heads = (out.plan?.lines ?? []).filter((l) => l.startsWith("["));
    expect(heads.map((l) => l.split(" ")[1])).toEqual(["Rep", "Gone", "Add1", "Mod"]);
    expect(out.plan?.lines.at(-1)).toBe(
      "End of change set: 4 changes (2 removals or replacements)",
    );
  });

  test("capabilities are compared as a set and shown", () => {
    const caps = ["CAPABILITY_NAMED_IAM", "CAPABILITY_IAM"];
    const out = settleCfnChangeSet({
      input: cfnInput({ capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"] }),
      reply: cfnReply({ capabilities: caps }),
    });
    expect(out.fields.find((f) => f.label === "Capabilities")?.value).toBe(
      "CAPABILITY_IAM, CAPABILITY_NAMED_IAM",
    );
  });

  test.each([
    ["a different stack", cfnReply({ stackName: "other" })],
    ["a different template hash", cfnReply({ templateSha256: sha("another template") })],
    [
      "a change set name that carries another hash",
      cfnReply({ changeSetName: `nimbus-${sha("x")}-0123456789ab` }),
    ],
    ["a change set name with a short suffix", cfnReply({ changeSetName: `nimbus-${T_SHA}-0123` })],
    [
      "a change set name with an upper-case suffix",
      cfnReply({ changeSetName: `nimbus-${T_SHA}-0123456789AB` }),
    ],
    ["a change set name that is not nimbus-made", cfnReply({ changeSetName: "prod-hotfix" })],
    [
      "an ARN whose name segment differs from the name",
      cfnReply({
        changeSetId: `arn:aws:cloudformation:eu-west-1:123456789012:changeSet/nimbus-${T_SHA}-ffffffffffff/11111111-2222-3333-4444-555555555555`,
      }),
    ],
    ["an ARN that is not a change set ARN", cfnReply({ changeSetId: "arn:aws:s3:::bucket" })],
    ["a file:// id", cfnReply({ changeSetId: "file:///etc/passwd" })],
    ["a missing change set id", cfnReply({ changeSetId: undefined })],
    ["an extra capability", cfnReply({ capabilities: ["CAPABILITY_IAM"] })],
    ["a repeated capability", cfnReply({ capabilities: ["CAPABILITY_IAM", "CAPABILITY_IAM"] })],
    ["capabilities that are not a list", cfnReply({ capabilities: "none" })],
    ["a change set type that is neither", cfnReply({ changeSetType: "IMPORT" })],
    ["a template hash that is not a string", cfnReply({ templateSha256: 1 })],
  ])("%s -> unbound", (_name, reply) => {
    expect(cfnRefusal(reply)).toBe(PREPARE_REFUSALS.unbound);
  });

  test.each([
    ["another template's hash", `nimbus-${sha("x")}-0123456789ab`],
    ["a short suffix", `nimbus-${T_SHA}-0123`],
    ["a name that is not nimbus-made", "prod-hotfix"],
  ])(
    "a change set name AND ARN that agree but do not carry this template's hash (%s) -> unbound",
    (_n, name) => {
      const id = `arn:aws:cloudformation:eu-west-1:123456789012:changeSet/${name}/11111111-2222-3333-4444-555555555555`;
      expect(cfnRefusal(cfnReply({ changeSetName: name, changeSetId: id }))).toBe(
        PREPARE_REFUSALS.unbound,
      );
    },
  );

  test("a missing capability (input asks for one, the reply has none) -> unbound", () => {
    expect(cfnRefusal(cfnReply(), cfnInput({ capabilities: ["CAPABILITY_AUTO_EXPAND"] }))).toBe(
      PREPARE_REFUSALS.unbound,
    );
  });

  test("a reply that is not an object -> unbound", () => {
    for (const r of [null, "x", 1, [], undefined])
      expect(cfnRefusal(r)).toBe(PREPARE_REFUSALS.unbound);
  });

  test("an input with a non-string stack name or template -> unbound (the gate refused it earlier; defence in depth)", () => {
    expect(cfnRefusal(cfnReply(), { stackName: 1, templateBody: TEMPLATE })).toBe(
      PREPARE_REFUSALS.unbound,
    );
    expect(cfnRefusal(cfnReply(), { stackName: "app", templateBody: 1 })).toBe(
      PREPARE_REFUSALS.unbound,
    );
  });

  test("the template hash is of the UTF-8 bytes", () => {
    const tpl = "# café\n{}";
    const name = `nimbus-${sha(tpl)}-0123456789ab`;
    const arn = `arn:aws:cloudformation:us-east-1:123456789012:changeSet/${name}/11111111-2222-3333-4444-555555555555`;
    const out = settleCfnChangeSet({
      input: cfnInput({ templateBody: tpl }),
      reply: cfnReply({ templateSha256: sha(tpl), changeSetName: name, changeSetId: arn }),
    });
    expect(out.values["changeSetId"]).toBe(arn);
  });

  test.each([
    ["more than 500 changes", cfnReply({ changes: Array.from({ length: 501 }, () => CHANGE) })],
    ["changes not a list", cfnReply({ changes: {} })],
    ["a change that is not an object", cfnReply({ changes: ["x"] })],
    ["a change with no logicalId", cfnReply({ changes: [{ ...CHANGE, logicalId: undefined }] })],
    ["a change with a numeric action", cfnReply({ changes: [{ ...CHANGE, action: 1 }] })],
    [
      "a change whose scope is not a list",
      cfnReply({ changes: [{ ...CHANGE, scope: "Properties" }] }),
    ],
    ["a change whose scope holds a number", cfnReply({ changes: [{ ...CHANGE, scope: [1] }] })],
    [
      "a change with a non-string physicalId",
      cfnReply({ changes: [{ ...CHANGE, physicalId: 5 }] }),
    ],
  ])("%s -> unshowable", (_name, reply) => {
    expect(cfnRefusal(reply)).toBe(PREPARE_REFUSALS.unshowable);
  });

  test("500 changes are accepted; a change set whose text is over the cap is refused diffTooLarge", () => {
    expect(
      settleCfnChangeSet({
        input: cfnInput(),
        reply: cfnReply({ changes: Array.from({ length: 500 }, () => CHANGE) }),
      }).fields.find((f) => f.label === "Changes")?.value,
    ).toBe("500");
    const fat = Array.from({ length: 500 }, (_, i) => ({
      ...CHANGE,
      logicalId: `${"L".repeat(200)}${String(i)}`,
    }));
    expect(cfnRefusal(cfnReply({ changes: fat }))).toBe(PREPARE_REFUSALS.diffTooLarge);
  });

  test("bidi, control and newline characters in a change are escaped injectively", () => {
    const evil = { ...CHANGE, logicalId: `A\u202EB\n[Remove] Fake`, physicalId: `p\u200B` };
    const out = settleCfnChangeSet({ input: cfnInput(), reply: cfnReply({ changes: [evil] }) });
    const text = out.plan?.text ?? "";
    expect(text).toContain("A\\u{202E}B\\u{000A}[Remove] Fake");
    expect(text).toContain("p\\u{200B}");
    expect((out.plan?.lines ?? []).filter((l) => l.startsWith("[Remove]"))).toEqual([]);
  });

  test("forged extra fields in the reply are ignored", () => {
    const out = settleCfnChangeSet({
      input: cfnInput(),
      reply: cfnReply({
        changeSetIdOverride: "arn:evil",
        values: { changeSetId: "arn:evil" },
        planSha256: "f".repeat(64),
      }),
    });
    expect(out.values).toEqual({ changeSetId: ARN });
    expect(JSON.stringify(out)).not.toContain("evil");
  });

  test("cleanup is a no-op (the discard of an unused change set is the gate's step)", async () => {
    await expect(
      settleCfnChangeSet({ input: cfnInput(), reply: cfnReply() }).cleanup(),
    ).resolves.toBeUndefined();
  });

  test("the change text costs linear time in the size of the change list", () => {
    expectLinearGrowth({
      sizes: [25_000, 50_000, 100_000, 200_000],
      repeats: 3,
      perSizeCeilingMs: 3000,
      makeCall: (n) => {
        // one change whose logical id is n escapable characters; the cap is lifted for the timing
        const evil = { ...CHANGE, logicalId: `\u202E\n`.repeat(Math.ceil(n / 2)).slice(0, n) };
        const reply = cfnReply({ changes: [evil] });
        return () => {
          settleCfnChangeSet({ input: cfnInput(), reply }, { maxRenderedBytes: 1_000_000_000 });
        };
      },
    });
  });
});

describe("the connector's writers (source pins, so the fixtures cannot drift from them)", () => {
  const src = readFileSync(
    join(installedConnectorsPackageRoot(), "connectors", "iac", "src", "tools.ts"),
    "utf8",
  );

  test("the Terraform plan reply is {planId, planFile, planSha256, hasChanges: code === 2}", () => {
    expect(src).toContain("jsonResult({ planId, planFile, planSha256, hasChanges: r.code === 2 })");
    expect(src).toContain('randomBytes(16).toString("hex")');
    expect(src).toContain('const PLAN_NAME = "plan.tfplan"');
    expect(src).toContain('const DESTROY_PLAN_NAME = "destroy.tfplan"');
    expect(src).toContain(
      "const planFile = join(planDir, destroy ? DESTROY_PLAN_NAME : PLAN_NAME)",
    );
  });

  test("the change set reply carries exactly the keys the CFN settler cross-checks", () => {
    const m = /const reply = \{([^}]*)\};/u.exec(src);
    const keys = (m?.[1] ?? "")
      .split(",")
      .map((k) => k.trim().split(":")[0]?.trim())
      .filter((k) => k !== undefined && k !== "");
    expect(keys).toEqual([
      "changeSetId",
      "changeSetName",
      "stackId",
      "stackName",
      "changeSetType",
      "templateSha256",
      "capabilities",
      "changes",
    ]);
    expect(Object.keys(cfnReply())).toEqual(keys as string[]);
  });

  test("the change set name is nimbus-<template sha256>-<12 hex> and the ARN regex has the name as its second segment", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the connector source text, searched for literally
    expect(src).toContain('`nimbus-${templateSha256}-${randomBytes(6).toString("hex")}`');
    expect(src).toContain('arn.split("/")[1]');
    expect(src).toContain(
      "/^arn:aws[a-z-]*:cloudformation:[a-z0-9-]+:\\d{12}:changeSet\\/[A-Za-z][-A-Za-z0-9]{0,127}\\/[0-9a-f-]{36}$/",
    );
  });

  test("a change row is {action, logicalId, physicalId?, resourceType, replacement, scope}", () => {
    expect(src).toContain('action: str(c["Action"]) ?? "unknown"');
    expect(src).toContain('logicalId: str(c["LogicalResourceId"]) ?? ""');
    expect(src).toContain('scope: stringList(c["Scope"])');
    expect(src).toContain("row.physicalId = physical");
  });

  test("show -json replies {planJson, planSha256} (planJson the raw text)", () => {
    expect(src).toContain("jsonResult({ planJson: r.stdout, planSha256 })");
  });
});

describe("BoundWriteCapabilities (type only here; the dispatcher and the gate wire it later)", () => {
  test("is satisfiable by an object with settle and preflight", () => {
    const caps: BoundWriteCapabilities = {
      settle: () => Promise.reject(new Error("unused")),
      preflight: () =>
        Promise.resolve({
          ok: false,
          reason: "iac: the working directory is not an approved directory",
        }),
    };
    expect(typeof caps.settle).toBe("function");
    expect(typeof caps.preflight).toBe("function");
  });
});
