// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these fixtures are
// GitHub Actions expressions (`${{ secrets.X }}`), not JS template literals.
// Writing them any other way would stop testing the matcher against the exact
// syntax it has to parse in real workflow files.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CREDENTIAL_REGISTRY } from "../release/credential-registry.ts";
import {
  collectWorkflowSecrets,
  documentedSecrets,
  evaluateInventory,
  UNDOCUMENTABLE_SECRETS,
} from "./check-secret-inventory.ts";

const wf = (path: string, text: string) => ({ path, text });

describe("collectWorkflowSecrets", () => {
  test("finds a dotted secrets reference and attributes it to its workflow", () => {
    const m = collectWorkflowSecrets([wf("release.yml", "token: ${{ secrets.GPG_PASSPHRASE }}")]);
    expect(m.get("GPG_PASSPHRASE")).toEqual(["release.yml"]);
  });

  test("finds the bracket form", () => {
    const m = collectWorkflowSecrets([wf("a.yml", "${{ secrets['SONAR_TOKEN'] }}")]);
    expect(m.has("SONAR_TOKEN")).toBe(true);
  });

  test("finds the double-quoted bracket form", () => {
    const m = collectWorkflowSecrets([wf("a.yml", '${{ secrets["SONAR_TOKEN"] }}')]);
    expect(m.has("SONAR_TOKEN")).toBe(true);
  });

  test("attributes one secret to every workflow that names it, without duplicates", () => {
    const m = collectWorkflowSecrets([
      wf("a.yml", "${{ secrets.X }} and again ${{ secrets.X }}"),
      wf("b.yml", "${{ secrets.X }}"),
    ]);
    expect(m.get("X")).toEqual(["a.yml", "b.yml"]);
  });

  test("does not match a lowercase or non-secret expression", () => {
    const m = collectWorkflowSecrets([wf("a.yml", "${{ env.FOO }} ${{ secrets.lower }}")]);
    expect(m.size).toBe(0);
  });
});

describe("documentedSecrets", () => {
  test("reads backtick-quoted UPPER_SNAKE tokens anywhere in the doc", () => {
    const doc = "| `RELEASE_BOT_CLIENT_ID` | mint | ... |\n\nProse naming `GPG_PASSPHRASE` too.";
    const d = documentedSecrets(doc);
    expect(d.has("RELEASE_BOT_CLIENT_ID")).toBe(true);
    expect(d.has("GPG_PASSPHRASE")).toBe(true);
  });

  test("a struck-through retired entry still counts as documented", () => {
    // A retired secret is documented *as retired* — that is a deliberate record,
    // not an omission, so it must not be reported as missing if still referenced.
    expect(documentedSecrets("| ~~`CODECOV_TOKEN`~~ | Retired |").has("CODECOV_TOKEN")).toBe(true);
  });

  test("ignores short or lowercase tokens", () => {
    const d = documentedSecrets("`ok` `abc` `lower_case` `AB`");
    expect(d.size).toBe(0);
  });
});

describe("evaluateInventory", () => {
  const used = new Map<string, string[]>([
    ["IN_BOTH", ["a.yml"]],
    ["DOC_ONLY", ["b.yml", "c.yml"]],
    ["REGISTRY_ONLY", ["d.yml"]],
    ["IN_NEITHER", ["e.yml"]],
    ["GITHUB_TOKEN", ["f.yml"]],
  ]);
  const documented = new Set(["IN_BOTH", "DOC_ONLY", "ONLY_IN_DOC"]);
  const registered = new Set(["IN_BOTH", "REGISTRY_ONLY"]);
  const run = () => evaluateInventory(used, documented, registered, UNDOCUMENTABLE_SECRETS);

  test("a secret in both inventories is not a finding", () => {
    expect(run().some((x) => x.secret === "IN_BOTH")).toBe(false);
  });

  test("documented but unregistered => missingFrom registry, naming its workflows", () => {
    const f = run().find((x) => x.secret === "DOC_ONLY");
    expect(f?.missingFrom).toBe("registry");
    expect(f?.workflows).toEqual(["b.yml", "c.yml"]);
  });

  test("registered but undocumented => missingFrom doc", () => {
    expect(run().find((x) => x.secret === "REGISTRY_ONLY")?.missingFrom).toBe("doc");
  });

  test("absent from both => missingFrom both", () => {
    expect(run().find((x) => x.secret === "IN_NEITHER")?.missingFrom).toBe("both");
  });

  test("GITHUB_TOKEN is excluded — it is provided, never provisioned", () => {
    expect(run().some((x) => x.secret === "GITHUB_TOKEN")).toBe(false);
  });

  test("an inventory entry with no local consumer is NEVER a finding", () => {
    // ci-secrets.md documents VSCE_PAT/OVSX_PAT/NPM_TOKEN, which belong to other
    // repos' workflows. Gating that direction would push us to DELETE true
    // information from the inventory.
    expect(run().some((x) => x.secret === "ONLY_IN_DOC")).toBe(false);
  });

  test("everything covered => no findings", () => {
    expect(
      evaluateInventory(
        new Map([["IN_BOTH", ["a.yml"]]]),
        documented,
        registered,
        UNDOCUMENTABLE_SECRETS,
      ),
    ).toEqual([]);
  });
});

describe("the committed tree", () => {
  test("every secret this repo's workflows consume is in BOTH inventories", () => {
    const root = join(import.meta.dir, "..", "..");
    const dir = join(root, ".github", "workflows");
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .map((f) => wf(f, readFileSync(join(dir, f), "utf8")));
    const doc = readFileSync(join(root, "docs", "ci-secrets.md"), "utf8");

    const findings = evaluateInventory(
      collectWorkflowSecrets(files),
      documentedSecrets(doc),
      new Set(CREDENTIAL_REGISTRY.map((c) => c.name)),
      UNDOCUMENTABLE_SECRETS,
    );
    expect(findings.map((f) => `${f.secret} (missing from ${f.missingFrom})`)).toEqual([]);
  });
});
