// packages/gateway/src/connectors/connector-writes/confirm.test.ts
import { describe, expect, test } from "bun:test";
import { CONFIRM_NO_TARGET_REASON, confirmPromptLine, renderConfirmText } from "./confirm.ts";
import { type ConnectorWriteRow, row, textField, withConfirm, withPreview } from "./types.ts";

function confirmRow(template: string, actionType = "github.pr.merge"): ConnectorWriteRow {
  return withConfirm(row("github_pr_merge", actionType, "mesh", 4), { template });
}

function text(r: ConnectorWriteRow, input: unknown): string {
  const out = renderConfirmText(r, input);
  if (!out.ok) throw new Error(out.reason);
  return out.text;
}

function reason(r: ConnectorWriteRow, input: unknown): string {
  const out = renderConfirmText(r, input);
  if (out.ok) throw new Error(`expected a refusal, got ${out.text}`);
  return out.reason;
}

describe("renderConfirmText", () => {
  test("renders <service>/<template> from strings and numbers", () => {
    const r = confirmRow("{owner}/{repo}#{pullNumber}");
    expect(text(r, { owner: "acme", repo: "api", pullNumber: 42 })).toBe("github/acme/api#42");
  });

  test("uses the service of the action type", () => {
    const r = confirmRow("{name}@{id}", "argocd.app.rollback");
    expect(text(r, { name: "web", id: 12 })).toBe("argocd/web@12");
  });

  test("an array joins with single spaces in input order (a comma is outside the confirm character set); two arrays work", () => {
    const r = confirmRow("{instanceIds}", "aws.ec2.instance.stop");
    expect(text(r, { instanceIds: ["i-0a1", "i-0b2"] })).toBe("aws/i-0a1 i-0b2");
    const two = confirmRow("{a}/{b}");
    expect(text(two, { a: ["x", "y"], b: ["z", 3] })).toBe("github/x y/z 3");
  });

  test("a value with a single interior ASCII space renders as it is", () => {
    const r = confirmRow("{a}/{b}");
    expect(text(r, { a: "my app", b: ["p", "r"] })).toBe("github/my app/p r");
  });

  test("a value the normaliser would change is refused, so the text is injective in the dispatched value", () => {
    const r = confirmRow("{a}");
    const nbsp = String.fromCharCode(0xa0);
    for (const bad of [
      "deploy  prod",
      " deploy prod",
      "deploy prod ",
      "deploy\tprod",
      "deploy\nprod",
      `deploy${nbsp}prod`,
      "deploy prod",
      "deploy　prod",
      "x\u{2028}",
    ]) {
      expect(reason(r, { a: bad }), JSON.stringify(bad)).toBe(
        "confirm: field a is not a usable value",
      );
    }
    // An array element is held to the same rule.
    expect(reason(r, { a: ["ok", "two  spaces"] })).toBe("confirm: field a is not a usable value");
    expect(text(r, { a: "deploy prod" })).toBe("github/deploy prod");
  });

  test("tail8 keeps the last 8 characters, or the whole id when shorter", () => {
    const r = confirmRow("{eventId:tail8}", "outlook.calendar.delete");
    expect(text(r, { eventId: "AAMkAGI2THVSAAA1B2c3D4" })).toBe("outlook/A1B2c3D4");
    expect(text(r, { eventId: "short" })).toBe("outlook/short");
    expect(text(r, { eventId: "12345678" })).toBe("outlook/12345678");
  });

  test.each([
    ["unset", {}],
    ["undefined", { a: undefined }],
    ["null", { a: null }],
    ["empty string", { a: "" }],
    ["whitespace only", { a: " \t " }],
    ["boolean", { a: true }],
    ["object", { a: { x: 1 } }],
    ["NaN", { a: Number.NaN }],
    ["Infinity", { a: Number.POSITIVE_INFINITY }],
    ["empty array", { a: [] }],
    ["array holding an object", { a: ["x", { y: 1 }] }],
    ["array holding an empty string", { a: ["x", ""] }],
    ["array holding null", { a: [null] }],
  ])("refuses %s", (_name, input) => {
    expect(reason(confirmRow("{a}"), input)).toBe("confirm: field a is not a usable value");
  });

  test("refuses an inherited key", () => {
    expect(reason(confirmRow("{constructor}"), {})).toBe(
      "confirm: field constructor is not a usable value",
    );
  });

  test("refuses the preview's (not set) placeholder text", () => {
    expect(reason(confirmRow("{a}"), { a: "(not set)" })).toBe(
      "confirm: the target has characters that cannot be typed",
    );
  });

  test("refuses control characters, bidi marks, zero-width marks and non-ASCII", () => {
    const r = confirmRow("{a}");
    for (const bad of [
      "a\u0007b",
      "a\u001bb",
      "a\u{202e}b",
      "a\u{2066}b",
      "a\u{200b}b",
      "a\u{feff}b",
      "café",
      "a…b",
      "a\b",
      "a(b)",
      "a~b",
    ]) {
      expect(reason(r, { a: bad })).toBe("confirm: the target has characters that cannot be typed");
    }
  });

  test("the cap is 200 characters: 200 passes, 201 is refused, never truncated", () => {
    const r = confirmRow("{a}");
    const room = 200 - "github/".length;
    expect(text(r, { a: "x".repeat(room) })).toHaveLength(200);
    expect(reason(r, { a: "x".repeat(room + 1) })).toBe("confirm: the target is too long to type");
  });

  test("a row with no confirm, a malformed stored template and a non-object input are refused", () => {
    expect(reason(row("x_y", "x.y", "mesh", 4), {})).toBe(CONFIRM_NO_TARGET_REASON);
    const bad: ConnectorWriteRow = {
      ...row("x_y", "x.y", "mesh", 4),
      confirm: { template: "none" },
    };
    expect(reason(bad, {})).toBe("confirm: template names no placeholder");
    const ok = confirmRow("{a}");
    for (const input of [undefined, null, "s", 5, ["a"], new Date()]) {
      expect(reason(ok, input)).toBe("confirm: the tool input is not an object");
    }
  });

  test("a null-prototype input is a plain object", () => {
    const input = Object.assign(Object.create(null) as Record<string, unknown>, { a: "ok" });
    expect(text(confirmRow("{a}"), input)).toBe("github/ok");
  });

  test("no refusal reason carries an input value", () => {
    const r = confirmRow("{a}");
    expect(reason(r, { a: "secret\u0007value" })).not.toContain("secret");
  });
});

describe("the confirm text is injective across adjacent fields and array elements", () => {
  test.each([
    ["{owner}/{repo}", { owner: "a/b", repo: "c" }],
    ["{jobName}#{buildNumber}", { jobName: "a#1", buildNumber: 2 }],
    ["scale {deploymentName} to {replicas}", { deploymentName: "web to 5", replicas: 3 }],
    ["{a}/{b}", { a: ["x y"], b: "z" }],
    ["{instanceIds}", { instanceIds: ["i-1 i-2", "i-3"] }],
  ])("%s with %j is refused before the prompt", (template, input) => {
    expect(reason(confirmRow(template), input)).toMatch(
      /^confirm: field [A-Za-z]+ is not a usable value$/,
    );
  });

  test("D1: only the separator that FOLLOWS a field constrains it, so the LAST field may hold a slash, a space or the template's own separators", () => {
    // These two were refused before D1; the field is the last one, so nothing after it can be confused.
    expect(text(confirmRow("{owner}/{repo}"), { owner: "a", repo: "b/c" })).toBe("github/a/b/c");
    expect(
      text(confirmRow("scale {d} to {replicas}", "k8s.deployment.scale"), {
        d: "web",
        replicas: "3 to 4",
      }),
    ).toBe("k8s/scale web to 3 to 4");
  });

  test("D1: a slashed branch and an image tail are accepted where they come last", () => {
    const del = confirmRow("delete {owner}/{repo}@{branch}", "github.branch.delete");
    expect(text(del, { owner: "acme", repo: "api", branch: "feat/x" })).toBe(
      "github/delete acme/api@feat/x",
    );
    const dep = confirmRow("deploy {p}/{r}/{s} {image:tail8}", "gcp.cloud_run.deploy");
    expect(
      text(dep, {
        p: "proj",
        r: "us-east1",
        s: "api",
        image: "gcr.io/proj/api@sha256:0123456789abcdef",
      }),
    ).toBe("gcp/deploy proj/us-east1/api 89abcdef");
  });

  test("D1: a value holding the separator that follows it is still refused", () => {
    const del = confirmRow("delete {owner}/{repo}@{branch}", "github.branch.delete");
    for (const input of [
      { owner: "a/b", repo: "api", branch: "x" },
      { owner: "acme", repo: "a@b", branch: "x" },
    ]) {
      expect(reason(del, input)).toMatch(/^confirm: field (owner|repo) is not a usable value$/);
    }
  });

  test("D1: literal text AFTER the last field constrains it too (round 2), and a separator of letters only is matched as a whole text", () => {
    const trailing = confirmRow("a {x} units");
    expect(reason(trailing, { x: "1 2" })).toBe("confirm: field x is not a usable value");
    expect(reason(trailing, { x: "5 units" })).toBe("confirm: field x is not a usable value");
    expect(text(trailing, { x: "12" })).toBe("github/a 12 units");
    // Letters only: the whole text is what is refused, not each letter.
    const word = confirmRow("{x}ab{y}");
    expect(reason(word, { x: "cab", y: "1" })).toBe("confirm: field x is not a usable value");
    expect(text(word, { x: "c", y: "ab" })).toBe("github/cabab");
  });

  test("D1: the first occurrence of the separator in value+separator must be the separator itself (an overlap cannot shift the split)", () => {
    // x = "ab" with separator "aba" would render "ababa", which reads back as x = "" then "aba".
    const overlap = confirmRow("{x}aba{y}");
    expect(reason(overlap, { x: "ab", y: "1" })).toBe("confirm: field x is not a usable value");
    expect(text(overlap, { x: "xy", y: "1" })).toBe("github/xyaba1");
  });

  test("realistic values are still accepted, and a single placeholder keeps its charset", () => {
    expect(text(confirmRow("{owner}/{repo}"), { owner: "acme", repo: "api" })).toBe(
      "github/acme/api",
    );
    expect(text(confirmRow("scale {d} to {n}", "k8s.deployment.scale"), { d: "web", n: 3 })).toBe(
      "k8s/scale web to 3",
    );
    expect(
      text(confirmRow("deploy {p}/{r}/{s}", "gcp.run.deploy"), {
        p: "proj",
        r: "us-central1",
        s: "svc",
      }),
    ).toBe("gcp/deploy proj/us-central1/svc");
    expect(
      text(confirmRow("{projectPath}", "gitlab.pipeline.cancel"), { projectPath: "grp/sub/proj" }),
    ).toBe("gitlab/grp/sub/proj");
  });
});

describe("confirmPromptLine", () => {
  test("is the fixed line", () => {
    expect(confirmPromptLine("github/acme/api#42")).toBe(
      "To approve, type exactly: github/acme/api#42",
    );
  });
});

describe("withConfirm declaration checks", () => {
  const base = row("t_x", "t.x", "write", 4);
  const withSecret = withPreview(base, {
    target: "{name}",
    summary: "s",
    fields: [
      textField("name"),
      { key: "apiToken", label: "t", kind: "secret" },
      { key: "blob", label: "b", kind: "secret" },
    ],
  });

  test("a valid template is stored on a frozen copy", () => {
    const r = withConfirm(base, { template: "{a}/{b:tail8}" });
    expect(r.confirm).toEqual({ template: "{a}/{b:tail8}" });
    expect(Object.isFrozen(r)).toBe(true);
    expect(base.confirm).toBeUndefined();
  });

  test("a whenUnset alternative is stored, parsed and held to the same rules", () => {
    const ok = withConfirm(base, {
      template: "set {a}",
      whenUnset: { field: "v", template: "remove {a}" },
    });
    expect(ok.confirm?.whenUnset).toEqual({ field: "v", template: "remove {a}" });
    expect(() =>
      withConfirm(base, { template: "set {a}", whenUnset: { field: "v", template: "remove" } }),
    ).toThrow(/whenUnset template names no placeholder/);
    expect(() =>
      withConfirm(base, { template: "set {a}", whenUnset: { field: "a", template: "remove {a}" } }),
    ).toThrow(/whenUnset field is also a placeholder/);
    expect(() =>
      withConfirm(base, {
        template: "set {a}",
        whenUnset: { field: "v", template: "remove {apiToken}" },
      }),
    ).toThrow(/secret-looking field/);
  });

  test("refuses a template with no placeholder, an unknown shape or modifier", () => {
    expect(() => withConfirm(base, { template: "fixed" })).toThrow(/names no placeholder/);
    expect(() => withConfirm(base, { template: "{a" })).toThrow(/unclosed/);
    expect(() => withConfirm(base, { template: "{a:head8}" })).toThrow(/unknown modifier/);
  });

  test("refuses a placeholder the preview marks secret, though the name looks innocent", () => {
    expect(() => withConfirm(withSecret, { template: "{blob}" })).toThrow(/secret-looking field/);
  });

  test("refuses a sensitive-looking name with a preview template", () => {
    expect(() => withConfirm(withSecret, { template: "{apiToken}" })).toThrow(
      /secret-looking field/,
    );
  });

  test("refuses a sensitive-looking name on a row with no preview template", () => {
    for (const n of ["password", "clientSecret", "access_token", "apiKey", "bearer", "auth"]) {
      expect(() => withConfirm(base, { template: `{${n}}` })).toThrow(/secret-looking field/);
    }
  });

  test("a name that merely contains a sensitive word is allowed", () => {
    expect(() => withConfirm(base, { template: "{author}/{keywords}" })).not.toThrow();
  });
});

describe("a Windows working directory is typeable (platform equality)", () => {
  test("iac/C:\\infra\\prod renders and a typed exact match is the confirm text", () => {
    const r = withConfirm(row("iac_terraform_apply", "iac.terraform.apply", "mesh", 4), {
      template: "{workingDirectory}",
    });
    const wd = `C:${String.fromCharCode(92)}infra${String.fromCharCode(92)}prod`;
    expect(wd).toBe("C:\\infra\\prod"); // cross-platform-ok
    expect(text(r, { workingDirectory: wd })).toBe(`iac/${wd}`);
  });
});
