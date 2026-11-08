// packages/gateway/src/connectors/connector-writes/iac-plan-preview.test.ts
// Phase 9.7 D2 (Task 2): the pure plan-preview renderer over `terraform show -json` output.
//
// FIXTURE PROVENANCE. No `terraform` binary is installed where this was written, so the fixtures
// are built by hand to follow HashiCorp's documented JSON output format
// (https://developer.hashicorp.com/terraform/internals/json-format): top-level `format_version`,
// `terraform_version`, `resource_changes[]` (each `address`, `mode`, `type`, `name`,
// `provider_name`, optional `action_reason`, and a `change` of `actions`, `before`, `after`,
// `after_unknown`, `before_sensitive`, `after_sensitive`), `output_changes` (name -> change) and
// `errored` / `applyable`. ASSUMED from that document, not observed: the exact spelling of
// `action_reason` values and that `applyable` is false for a plan that cannot be applied. The
// coordinator's Task 0 re-records goldens from a real terraform.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { expectLinearGrowth } from "../../testing/linear-growth.ts";
import { IAC_LIMITS } from "./iac-limits.ts";
import { type PlanPreview, renderPlanPreview } from "./iac-plan-preview.ts";

const SHA = "a".repeat(64);

type Obj = Record<string, unknown>;

function change(
  address: string,
  actions: readonly string[],
  extra: {
    before?: unknown;
    after?: unknown;
    after_unknown?: unknown;
    before_sensitive?: unknown;
    after_sensitive?: unknown;
    action_reason?: string;
    type?: string;
    provider_name?: string;
    mode?: string;
  } = {},
): Obj {
  const out: Obj = {
    address,
    mode: extra.mode ?? "managed",
    type: extra.type ?? "aws_s3_bucket",
    name: "x",
    provider_name: extra.provider_name ?? "registry.terraform.io/hashicorp/aws",
    change: {
      actions,
      before: extra.before ?? null,
      after: extra.after ?? null,
      after_unknown: extra.after_unknown ?? {},
      before_sensitive: extra.before_sensitive ?? false,
      after_sensitive: extra.after_sensitive ?? {},
    },
  };
  if (extra.action_reason !== undefined) out["action_reason"] = extra.action_reason;
  return out;
}

function plan(resourceChanges: Obj[], over: Obj = {}): Obj {
  return {
    format_version: "1.2",
    terraform_version: "1.9.5",
    planned_values: {},
    resource_changes: resourceChanges,
    applyable: true,
    complete: true,
    errored: false,
    ...over,
  };
}

function render(p: unknown, limits?: Parameters<typeof renderPlanPreview>[2]): PlanPreview {
  const out = renderPlanPreview(p, SHA, limits);
  if (!out.ok) throw new Error(`refused: ${out.reason}`);
  return out.preview;
}

function reason(p: unknown, limits?: Parameters<typeof renderPlanPreview>[2]): string {
  const out = renderPlanPreview(p, SHA, limits);
  if (out.ok) throw new Error("expected a refusal");
  return out.reason;
}

const MIXED = plan(
  [
    change("aws_s3_bucket.new", ["create"], {
      after: { bucket: "new-bucket", acl: "private" },
      after_unknown: { id: true, arn: true },
    }),
    change("aws_s3_bucket.logs", ["update"], {
      before: { acl: "private", versioning: true, tags: { a: "1" } },
      after: { acl: "public-read", versioning: true, tags: { a: "1" } },
    }),
    change("aws_instance.web", ["delete", "create"], {
      before: { ami: "ami-1", instance_type: "t3.micro" },
      after: { ami: "ami-2", instance_type: "t3.micro" },
      action_reason: "replace_because_cannot_update",
    }),
    change("aws_instance.old", ["delete"], { before: { ami: "ami-9" } }),
    change("data.aws_caller_identity.me", ["read"], {
      mode: "data",
      type: "aws_caller_identity",
      after_unknown: { account_id: true },
    }),
    change("aws_vpc.main", ["no-op"], {
      before: { cidr: "10.0.0.0/16" },
      after: { cidr: "10.0.0.0/16" },
    }),
  ],
  {
    output_changes: {
      bucket_arn: {
        actions: ["create"],
        before: null,
        after: null,
        after_unknown: true,
        before_sensitive: false,
        after_sensitive: false,
      },
      unchanged: { actions: ["no-op"], before: 1, after: 1 },
    },
  },
);

describe("renderPlanPreview: shape and order", () => {
  const p = render(MIXED);

  test("counts come first, then the version, the plan hash and the reads", () => {
    expect(p.lines.slice(0, 4)).toEqual([
      "Deletes: 1, Replaces: 1, Creates: 1, Updates: 1",
      "Terraform 1.9.5",
      `Plan SHA-256: ${SHA}`,
      "Reads: 1",
    ]);
    expect(p.counts).toEqual({ create: 1, update: 1, delete: 1, replace: 1, read: 1 });
    expect(p.changeCount).toBe(4);
    expect(p.deleteCount).toBe(2);
  });

  test("the footer is last and states the change and delete counts", () => {
    expect(p.lines.at(-1)).toBe("End of plan: 4 changes (2 deletes)");
  });

  test("lists every non-no-op change once, in plan order, and no no-op", () => {
    const aws = "registry.terraform.io/hashicorp/aws";
    expect(p.lines.filter((l) => l.startsWith("["))).toEqual([
      `[create] aws_s3_bucket.new (aws_s3_bucket, ${aws})`,
      `[update] aws_s3_bucket.logs (aws_s3_bucket, ${aws})`,
      `[replace: delete, create] aws_instance.web (aws_s3_bucket, ${aws})`,
      `[delete] aws_instance.old (aws_s3_bucket, ${aws})`,
      `[read] data.aws_caller_identity.me (aws_caller_identity, ${aws})`,
    ]);
    expect(p.text).not.toContain("aws_vpc.main");
  });

  test("an update names the attributes that differ, with scalar values, and skips equal ones", () => {
    expect(p.lines).toContain('    acl: "private" -> "public-read"');
    expect(p.text).not.toContain("versioning");
    expect(p.text).not.toContain("tags");
  });

  test("a replace shows its action_reason and its changed attributes", () => {
    const i = p.lines.indexOf("    reason: replace_because_cannot_update");
    expect(i).toBeGreaterThan(0);
    expect(p.lines).toContain('    ami: "ami-1" -> "ami-2"');
  });

  test("a create or delete shows no attribute lines; an unknown output is named, not valued", () => {
    const head = p.lines.findIndex((l) => l.startsWith("[create]"));
    expect(p.lines[head + 1]).not.toMatch(/^ {4}/u);
    expect(p.lines).toContain("Outputs:");
    expect(p.lines).toContain("  bucket_arn: create");
    expect(p.text).not.toContain("unchanged");
  });

  test("bytes and sha256 describe the text exactly, and rendering is deterministic", () => {
    expect(p.bytes).toBe(Buffer.byteLength(p.text, "utf8"));
    expect(p.sha256).toBe(createHash("sha256").update(p.text).digest("hex"));
    expect(p.text).toBe(p.lines.join("\n"));
    expect(render(MIXED).sha256).toBe(p.sha256);
  });
});

describe("renderPlanPreview: values", () => {
  test("a sensitive value never prints, on either side, whatever its type", () => {
    const secret = "hunter2-SECRET";
    const p = render(
      plan([
        change("aws_db_instance.db", ["update"], {
          before: { password: secret, port: 5432, config: { token: secret } },
          after: { password: `${secret}-2`, port: 5433, config: { token: `${secret}-2` } },
          before_sensitive: { password: true, config: { token: true } },
          after_sensitive: { password: true, config: { token: true } },
        }),
      ]),
    );
    expect(p.text).not.toContain("SECRET");
    expect(p.lines).toContain("    password: (sensitive) -> (sensitive)");
    expect(p.lines).toContain("    config: (sensitive) -> (sensitive)");
    expect(p.lines).toContain("    port: 5432 -> 5433");
  });

  test("a wholly sensitive side (a bare true) hides every attribute of that side", () => {
    const p = render(
      plan([
        change("x.y", ["update"], {
          before: { a: "old-SECRET" },
          after: { a: "new" },
          before_sensitive: true,
          after_sensitive: {},
        }),
      ]),
    );
    expect(p.text).not.toContain("SECRET");
    expect(p.lines).toContain('    a: (sensitive) -> "new"');
  });

  test("a value known only after apply prints as such, a partly unknown object says so", () => {
    const p = render(
      plan([
        change("x.y", ["update"], {
          before: { id: "i-1", tags: { a: "1" } },
          after: { tags: { a: "1" } },
          after_unknown: { id: true, tags: { b: true } },
        }),
      ]),
    );
    expect(p.lines).toContain('    id: "i-1" -> (known after apply)');
    expect(p.lines).toContain("    tags: (object, 1 keys) -> (partly known after apply)");
  });

  test("a value over 120 characters is named by its length, not shown", () => {
    const long = "z".repeat(121);
    const p = render(
      plan([change("x.y", ["update"], { before: { a: long }, after: { a: "short" } })]),
    );
    expect(p.text).not.toContain("zzzz");
    expect(p.lines).toContain('    a: (string of 121 characters, not shown) -> "short"');
    const exact = "z".repeat(120);
    const q = render(
      plan([change("x.y", ["update"], { before: { a: exact }, after: { a: "short" } })]),
    );
    expect(q.text).toContain(`"${exact}"`);
  });

  test("objects, lists, null and absent values print as a description, never their content", () => {
    const p = render(
      plan([
        change("x.y", ["update"], {
          before: { o: { k: "SECRET-IN-OBJECT" }, l: [1, 2, 3], n: null },
          after: { o: { k: "other" }, l: [1, 2], z: true },
        }),
      ]),
    );
    expect(p.text).not.toContain("SECRET-IN-OBJECT");
    expect(p.lines).toContain("    o: (object, 1 keys) -> (object, 1 keys)");
    expect(p.lines).toContain("    l: (list, 3 items) -> (list, 2 items)");
    expect(p.lines).toContain("    n: null -> (none)");
    expect(p.lines).toContain("    z: (none) -> true");
  });

  test("a deep sensitive marker beyond the depth bound counts as sensitive (fail closed)", () => {
    let marker: unknown = true;
    for (let i = 0; i < 100; i += 1) marker = { k: marker };
    const p = render(
      plan([
        change("x.y", ["update"], {
          before: { a: "old-SECRET" },
          after: { a: "new" },
          before_sensitive: { a: marker },
        }),
      ]),
    );
    expect(p.text).not.toContain("SECRET");
  });
});

describe("renderPlanPreview: injective escaping (the D1c escapeDiffText approach)", () => {
  const BS = String.fromCharCode(92);

  test("bidi, zero-width and control characters in an address are escaped, never printed", () => {
    const p = render(plan([change(`aws_x.a‮b​c\u0007d\u001B[31m`, ["delete"], { before: {} })]));
    expect(p.text).toContain("aws_x.a\\u{202E}b\\u{200B}c\\u{0007}d\\u{001B}[31m");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the point of the assertion
    expect(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/u.test(p.text)).toBe(false);
  });

  test("a newline in a name cannot start a fake line", () => {
    const p = render(plan([change("a\n[delete] fake.resource", ["create"])]));
    expect(p.lines.filter((l) => l.startsWith("[delete]"))).toEqual([]);
    expect(p.text).toContain("a\\u{000A}[delete] fake.resource");
  });

  test("a literal backslash is doubled, so a typed escape cannot pass for a real one", () => {
    const real = render(plan([change("a‮b", ["create"])]));
    const typed = render(plan([change(`a${BS}u{202E}b`, ["create"])]));
    expect(typed.text).not.toBe(real.text);
    expect(typed.text).toContain(`a${BS}${BS}u{202E}b`);
    expect(real.text).toContain(`a${BS}u{202E}b`);
  });

  test("a quote inside a shown value cannot close the quoted value early", () => {
    const p = render(
      plan([change("x.y", ["update"], { before: { a: 'x" -> "y' }, after: { a: "z" } })]),
    );
    expect(p.lines).toContain(`    a: "x${BS}" -> ${BS}"y" -> "z"`);
  });

  test("two different names never render the same text (spot injectivity over a small alphabet)", () => {
    const alphabet = ["a", BS, "\n", "\t", "‮", '"', "u", "{", "}", "0"];
    const seen = new Map<string, string>();
    const build = (n: number, prefix: string): string[] =>
      n === 0 ? [prefix] : alphabet.flatMap((c) => build(n - 1, prefix + c));
    for (const name of build(3, "")) {
      const t = render(plan([change(name, ["create"])])).text;
      const earlier = seen.get(t);
      expect(earlier === undefined || earlier === name).toBe(true);
      seen.set(t, name);
    }
  });

  test("the version, type and provider are escaped too", () => {
    const p = render(
      plan([change("a.b", ["create"], { type: "t‮", provider_name: "p​" })], {
        terraform_version: "1.9‮",
      }),
    );
    expect(p.text).toContain("Terraform 1.9\\u{202E}");
    expect(p.text).toContain("(t\\u{202E}, p\\u{200B})");
  });
});

describe("renderPlanPreview: a plan the owner could not be shown is refused", () => {
  test.each([
    ["not an object", null],
    ["an array", []],
    ["no format_version", { ...plan([]), format_version: undefined }],
    ["an unknown major format_version", plan([], { format_version: "2.0" })],
    ["a non-numeric format_version", plan([], { format_version: "1.x" })],
    ["errored", plan([], { errored: true })],
    ["not applyable", plan([change("a.b", ["create"])], { applyable: false })],
    ["no terraform_version", plan([], { terraform_version: undefined })],
    ["resource_changes not a list", plan([], { resource_changes: {} })],
    ["a change that is not an object", plan(["x" as never])],
    ["no address", plan([{ ...change("a.b", ["create"]), address: undefined }])],
    ["a numeric address", plan([{ ...change("a.b", ["create"]), address: 5 }])],
    ["no type", plan([{ ...change("a.b", ["create"]), type: undefined }])],
    ["no provider_name", plan([{ ...change("a.b", ["create"]), provider_name: undefined }])],
    ["no change member", plan([{ ...change("a.b", ["create"]), change: undefined }])],
    ["actions not a list", plan([{ ...change("a.b", ["create"]), change: { actions: "create" } }])],
    ["an unknown action", plan([change("a.b", ["explode"])])],
    ["an unknown action pair", plan([change("a.b", ["create", "update"])])],
    ["an empty action list", plan([change("a.b", [])])],
    ["a no-op mixed with another", plan([change("a.b", ["no-op", "create"])])],
    ["output_changes not an object", plan([], { output_changes: [] })],
    ["an output change without actions", plan([], { output_changes: { o: {} } })],
    [
      "an output with an unknown action",
      plan([], { output_changes: { o: { actions: ["read"] } } }),
    ],
  ])("%s -> unshowable", (_name, p) => {
    expect(reason(p)).toBe("unshowable");
  });

  test("a bad plan hash is unshowable", () => {
    const out = renderPlanPreview(plan([]), "xyz");
    expect(out).toEqual({ ok: false, reason: "unshowable" });
  });

  test("an empty plan (no resource_changes at all) renders with zero counts", () => {
    const p = render({ ...plan([]), resource_changes: undefined });
    expect(p.lines[0]).toBe("Deletes: 0, Replaces: 0, Creates: 0, Updates: 0");
    expect(p.lines.at(-1)).toBe("End of plan: 0 changes (0 deletes)");
  });

  test("a plan holding only no-ops renders empty counts and lists nothing", () => {
    const p = render(plan([change("a.b", ["no-op"])]));
    expect(p.changeCount).toBe(0);
    expect(p.lines.some((l) => l.startsWith("["))).toBe(false);
  });

  test("a destroy plan counts every delete", () => {
    const p = render(
      plan([
        change("a.b", ["delete"], { before: { id: "1" } }),
        change("a.c", ["delete"], { before: { id: "2" } }),
      ]),
    );
    expect(p.lines[0]).toBe("Deletes: 2, Replaces: 0, Creates: 0, Updates: 0");
    expect(p.deleteCount).toBe(2);
  });
});

describe("renderPlanPreview: caps refuse, they never truncate", () => {
  test("500 changes render; 501 are refused tooLarge", () => {
    const n = (k: number) =>
      plan(Array.from({ length: k }, (_, i) => change(`a.r${String(i)}`, ["create"])));
    // 500 short lines fit the text cap, so only the change cap is in play at 501.
    const ok = render(n(500), { maxRenderedBytes: 10_000_000 });
    expect(ok.changeCount).toBe(500);
    expect(reason(n(501), { maxRenderedBytes: 10_000_000 })).toBe("tooLarge");
  });

  test("no-op entries do not count against the change cap", () => {
    const many = Array.from({ length: 600 }, (_, i) => change(`n.r${String(i)}`, ["no-op"]));
    expect(render(plan(many)).changeCount).toBe(0);
  });

  test("501 output changes are refused", () => {
    const outputs: Obj = {};
    for (let i = 0; i < 501; i += 1) outputs[`o${String(i)}`] = { actions: ["create"] };
    expect(reason(plan([], { output_changes: outputs }), { maxRenderedBytes: 10_000_000 })).toBe(
      "tooLarge",
    );
  });

  test("text over 64 KiB is refused, and exactly at the cap is accepted", () => {
    const rows = (k: number) =>
      plan(
        Array.from({ length: k }, (_, i) =>
          change(`aws_s3_bucket.${"b".repeat(100)}${String(i)}`, ["create"]),
        ),
      );
    // find the largest k that fits, then k+1 must be refused: the boundary is the byte cap exactly
    let fit = 0;
    for (let k = 1; k <= 500; k += 1) {
      const out = renderPlanPreview(rows(k), SHA);
      if (!out.ok) break;
      fit = k;
      expect(out.preview.bytes).toBeLessThanOrEqual(IAC_LIMITS.maxRenderedBytes);
    }
    expect(fit).toBeGreaterThan(100);
    expect(fit).toBeLessThan(500);
    expect(reason(rows(fit + 1))).toBe("tooLarge");
  });

  test("an update with thousands of changed attributes is refused, not shown partly", () => {
    const before: Obj = {};
    const after: Obj = {};
    for (let i = 0; i < 5000; i += 1) {
      before[`attr_${String(i)}`] = "a";
      after[`attr_${String(i)}`] = "b";
    }
    expect(reason(plan([change("a.b", ["update"], { before, after })]))).toBe("tooLarge");
  });

  test("the defaults come from IAC_LIMITS", () => {
    expect(IAC_LIMITS.maxChanges).toBe(500);
    expect(IAC_LIMITS.maxRenderedBytes).toBe(65_536);
  });
});

describe("renderPlanPreview: costs linear, not quadratic, time", () => {
  const bigLimits = { maxChanges: 1_000_000, maxRenderedBytes: 1_000_000_000 };

  test("changes: doubling the number of changes roughly doubles the time", () => {
    expectLinearGrowth({
      sizes: [500, 1000, 2000, 4000],
      repeats: 3,
      perSizeCeilingMs: 3000,
      makeCall: (n) => {
        const p = plan(
          Array.from({ length: n }, (_, i) =>
            change(`aws_s3_bucket.r${String(i)}`, ["update"], {
              before: { a: "x", b: 1, c: { d: 1 } },
              after: { a: "y", b: 2, c: { d: 2 } },
              after_unknown: { e: true },
            }),
          ),
        );
        return () => {
          expect(renderPlanPreview(p, SHA, bigLimits).ok).toBe(true);
        };
      },
    });
  });

  test("attributes: one update with doubling attribute counts", () => {
    expectLinearGrowth({
      sizes: [1000, 2000, 4000, 8000],
      repeats: 3,
      perSizeCeilingMs: 3000,
      makeCall: (n) => {
        const before: Obj = {};
        const after: Obj = {};
        for (let i = 0; i < n; i += 1) {
          before[`k${String(i)}`] = i;
          after[`k${String(i)}`] = i + 1;
        }
        const p = plan([change("a.b", ["update"], { before, after })]);
        return () => {
          expect(renderPlanPreview(p, SHA, bigLimits).ok).toBe(true);
        };
      },
    });
  });

  test("escaping: a long hostile address of escapable characters", () => {
    expectLinearGrowth({
      sizes: [25_000, 50_000, 100_000, 200_000],
      repeats: 3,
      perSizeCeilingMs: 3000,
      makeCall: (n) => {
        const p = plan([change(`\\‮\n`.repeat(Math.ceil(n / 3)).slice(0, n), ["create"])]);
        return () => {
          expect(renderPlanPreview(p, SHA, bigLimits).ok).toBe(true);
        };
      },
    });
  });

  test("sensitive markers: a wide nested marker is scanned once per attribute", () => {
    expectLinearGrowth({
      sizes: [1000, 2000, 4000, 8000],
      repeats: 3,
      perSizeCeilingMs: 3000,
      makeCall: (n) => {
        const marker: Obj = {};
        const value: Obj = {};
        for (let i = 0; i < n; i += 1) {
          marker[`k${String(i)}`] = false;
          value[`k${String(i)}`] = i;
        }
        const p = plan([
          change("a.b", ["update"], {
            before: { big: value },
            after: { big: { ...value, extra: 1 } },
            before_sensitive: { big: marker },
            after_sensitive: { big: marker },
          }),
        ]);
        return () => {
          expect(renderPlanPreview(p, SHA, bigLimits).ok).toBe(true);
        };
      },
    });
  });
});
