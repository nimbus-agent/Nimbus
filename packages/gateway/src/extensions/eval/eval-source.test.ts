import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeBase64, generateEd25519Keypair, signManifest } from "../verify-signature.ts";
import {
  discardEvalStage,
  // biome-ignore lint/suspicious/noShadowRestrictedNames: the contract name (spec 4.6)
  EvalError,
  type EvalErrorCode,
  evalFilesDigest,
  loadEvalPackage,
  stageEvalPackage,
} from "./eval-source.ts";

const SUITE = {
  format: 1,
  name: "basic",
  cases: [{ name: "c1", tool: "echo", input: { a: 1 }, expect: { rubric: "exact", value: "x" } }],
};

let root: string;
let pkg: string;
let sandbox: string;

function write(rel: string, content: string): void {
  const p = join(pkg, ...rel.split("/"));
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
}

function baseManifest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "acme.thing", version: "1.0.0", entry: "dist/index.js", permissions: {}, ...extra };
}

function layout(manifest: Record<string, unknown>, withSuite = true): void {
  write("nimbus.extension.json", JSON.stringify(manifest));
  write("dist/index.js", "console.log(1);");
  write("README.md", "hi");
  write("src/index.ts", "secret source");
  write("node_modules/dep/index.js", "dep");
  if (withSuite) write("evals/basic.eval.json", JSON.stringify(SUITE));
}

async function codeOf(p: Promise<unknown>): Promise<EvalErrorCode | string> {
  try {
    await p;
    return "no error";
  } catch (e) {
    return e instanceof EvalError ? e.code : `other: ${String(e)}`;
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "eval-source-"));
  pkg = join(root, "pkg");
  sandbox = join(root, "sandbox");
  mkdirSync(pkg);
  mkdirSync(sandbox);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("loadEvalPackage", () => {
  test("an unsigned package loads", async () => {
    layout(baseManifest());
    const src = await loadEvalPackage(pkg);
    expect(src.extensionId).toBe("acme.thing");
    expect(src.version).toBe("1.0.0");
    expect(src.entryRel).toBe("dist/index.js");
    expect(src.suites).toHaveLength(1);
    expect(src.files).toContain("dist/index.js");
    expect(src.files).not.toContain("src/index.ts");
    expect(src.filesDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a signed package loads; a tampered one is refused", async () => {
    const { privkey, pubkey } = generateEd25519Keypair();
    const m = baseManifest({ publisher: { id: "acme", key: encodeBase64(pubkey) } });
    const signature = await signManifest(m, privkey);
    layout({ ...m, signature });
    expect((await loadEvalPackage(pkg)).extensionId).toBe("acme.thing");
    layout({ ...m, signature, version: "9.9.9" });
    expect(await codeOf(loadEvalPackage(pkg))).toBe("ERR_EVAL_SIGNATURE_INVALID");
  });

  test("a relative dir is refused", async () => {
    expect(await codeOf(loadEvalPackage("rel/dir"))).toBe("ERR_EVAL_PACKAGE_INVALID");
  });

  test("a missing manifest is refused", async () => {
    expect(await codeOf(loadEvalPackage(pkg))).toBe("ERR_EVAL_PACKAGE_INVALID");
  });

  test("a manifest the parser rejects is refused", async () => {
    write("nimbus.extension.json", JSON.stringify({ id: "", version: "" }));
    expect(await codeOf(loadEvalPackage(pkg))).toBe("ERR_EVAL_PACKAGE_INVALID");
  });

  test("a legacy-named manifest is refused", async () => {
    write("nimbus-extension.json", JSON.stringify(baseManifest()));
    expect(await codeOf(loadEvalPackage(pkg))).toBe("ERR_EVAL_PACKAGE_INVALID");
  });

  test("a starter pack is refused", async () => {
    write(
      "nimbus.extension.json",
      JSON.stringify({ id: "acme.pack", version: "1.0.0", kind: "starter-pack", permissions: {} }),
    );
    try {
      await loadEvalPackage(pkg);
      throw new Error("expected refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(EvalError);
      expect((e as EvalError).code).toBe("ERR_EVAL_PACKAGE_INVALID");
    }
  });

  test("an entry outside the package files is refused", async () => {
    layout(baseManifest({ entry: "../outside.js" }));
    expect(await codeOf(loadEvalPackage(pkg))).toBe("ERR_EVAL_PACKAGE_INVALID");
  });

  test("an entry that names a missing file is refused", async () => {
    layout(baseManifest({ entry: "dist/nope.js" }));
    expect(await codeOf(loadEvalPackage(pkg))).toBe("ERR_EVAL_PACKAGE_INVALID");
  });

  test("no evals/ is ERR_EVAL_NO_SUITES", async () => {
    layout(baseManifest(), false);
    expect(await codeOf(loadEvalPackage(pkg))).toBe("ERR_EVAL_NO_SUITES");
  });

  test("a malformed suite is ERR_EVAL_SUITE_INVALID", async () => {
    layout(baseManifest(), false);
    write("evals/bad.eval.json", "{ not json");
    expect(await codeOf(loadEvalPackage(pkg))).toBe("ERR_EVAL_SUITE_INVALID");
  });

  test("suiteFile selects one suite; an unknown one has none", async () => {
    layout(baseManifest());
    write("evals/other.eval.json", JSON.stringify({ ...SUITE, name: "other" }));
    const one = await loadEvalPackage(pkg, { suiteFile: "evals/other.eval.json" });
    expect(one.suites.map((s) => s.name)).toEqual(["other"]);
    expect(await codeOf(loadEvalPackage(pkg, { suiteFile: "evals/zzz.eval.json" }))).toBe(
      "ERR_EVAL_NO_SUITES",
    );
  });
});

describe("evalFilesDigest", () => {
  test("changes when a file's bytes change and is order-independent", () => {
    layout(baseManifest());
    const a = evalFilesDigest(pkg, ["dist/index.js", "README.md"]);
    expect(evalFilesDigest(pkg, ["README.md", "dist/index.js"])).toBe(a);
    write("README.md", "changed");
    expect(evalFilesDigest(pkg, ["dist/index.js", "README.md"])).not.toBe(a);
  });

  test("refuses a directory", () => {
    layout(baseManifest());
    expect(() => evalFilesDigest(pkg, ["dist"])).toThrow();
  });
});

describe("stageEvalPackage", () => {
  test("copies only the package files and the entry is inside the stage", async () => {
    layout(baseManifest());
    const src = await loadEvalPackage(pkg);
    const st = stageEvalPackage(src, sandbox);
    expect(st.stagePath.startsWith(join(sandbox, "ext-stage", "eval-"))).toBe(true);
    expect(st.serviceId).toBe(src.serviceId);
    expect(existsSync(st.entryPath)).toBe(true);
    expect(st.entryPath.startsWith(st.stagePath)).toBe(true);
    expect(existsSync(join(st.stagePath, "evals", "basic.eval.json"))).toBe(true);
    expect(existsSync(join(st.stagePath, "nimbus.extension.json"))).toBe(true);
    expect(existsSync(join(st.stagePath, "src"))).toBe(false);
    expect(existsSync(join(st.stagePath, "node_modules"))).toBe(false);
    discardEvalStage(st);
    expect(existsSync(st.stagePath)).toBe(false);
  });

  test("two stages of one package get different roots", async () => {
    layout(baseManifest());
    const src = await loadEvalPackage(pkg);
    const a = stageEvalPackage(src, sandbox);
    const b = stageEvalPackage(src, sandbox);
    expect(a.stagePath).not.toBe(b.stagePath);
    discardEvalStage(a);
    expect(existsSync(b.stagePath)).toBe(true);
  });

  test("a file changed between load and stage is refused and leaves no stage", async () => {
    layout(baseManifest());
    const src = await loadEvalPackage(pkg);
    write("dist/index.js", "tampered();");
    expect(() => stageEvalPackage(src, sandbox)).toThrow(/staged copy differs/);
    expect(readdirSync(join(sandbox, "ext-stage"))).toHaveLength(0);
  });

  test("a vanished source file is a staging failure", async () => {
    layout(baseManifest());
    const src = await loadEvalPackage(pkg);
    rmSync(join(pkg, "dist", "index.js"));
    expect(() => stageEvalPackage(src, sandbox)).toThrow(/could not be made/);
  });

  test("an entry that resolves outside the stage is refused", async () => {
    layout(baseManifest());
    const src = await loadEvalPackage(pkg);
    const evil = { ...src, entryRel: "../escape.js" };
    expect(() => stageEvalPackage(evil, sandbox)).toThrow(EvalError);
  });
});
