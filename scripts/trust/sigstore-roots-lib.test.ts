import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BAKED_SIGSTORE_TRUSTED_ROOTS } from "../../packages/gateway/src/extensions/registry/sigstore-trusted-roots.ts";
import { runCheck } from "./check-sigstore-roots.ts";
import { runRefresh } from "./refresh-sigstore-roots.ts";
import { ROOTS_MODULE_REL, renderRootsModule, validateTrustedRoots } from "./sigstore-roots-lib.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const lines = BAKED_SIGSTORE_TRUSTED_ROOTS.split("\n").filter((l) => l !== "");
const doc = (i: number): Record<string, unknown> =>
  JSON.parse(lines[i] ?? "{}") as Record<string, unknown>;
const jsonl = (...docs: unknown[]): string => `${docs.map((d) => JSON.stringify(d)).join("\n")}\n`;

describe("validateTrustedRoots", () => {
  test("the baked roots are public-good then GitHub", () => {
    expect(validateTrustedRoots(BAKED_SIGSTORE_TRUSTED_ROOTS)).toEqual(["public-good", "github"]);
  });

  test("anything but one root per instance, each with its material, is refused", () => {
    const [pg, gh] = [doc(0), doc(1)];
    const cases: Array<[string, string]> = [
      [jsonl(pg), "expected 2 trusted roots"],
      [jsonl(pg, pg), "two trusted roots for public-good"],
      [jsonl({ ...pg, mediaType: "x" }, gh), "unknown media type"],
      [
        jsonl({ ...pg, certificateAuthorities: [{ uri: "https://fulcio.example" }] }, gh),
        "unknown Fulcio instance",
      ],
      [jsonl({ ...pg, tlogs: [] }, gh), "no transparency or CT log"],
      [jsonl(pg, { ...gh, timestampAuthorities: [] }), "no timestamp authority"],
    ];
    for (const [text, message] of cases) {
      expect(() => validateTrustedRoots(text)).toThrow(message);
    }
  });
});

describe("the generated module", () => {
  test("is exactly what the refresh script renders", () => {
    const text = readFileSync(join(REPO_ROOT, ROOTS_MODULE_REL), "utf8");
    expect(text).toBe(renderRootsModule(BAKED_SIGSTORE_TRUSTED_ROOTS));
  });
});

describe("runCheck", () => {
  const log: string[] = [];
  const at = (over: Partial<Parameters<typeof runCheck>[0]>) =>
    runCheck({
      baked: BAKED_SIGSTORE_TRUSTED_ROOTS,
      moduleText: renderRootsModule(BAKED_SIGSTORE_TRUSTED_ROOTS),
      log: (l) => void log.push(l),
      ...over,
    });

  test("ok offline, and live when the roots are unchanged", () => {
    expect(at({})).toBe(0);
    expect(at({ live: () => BAKED_SIGSTORE_TRUSTED_ROOTS })).toBe(0);
  });

  test("a hand edit, moved live roots or an unreadable live source fail", () => {
    expect(at({ moduleText: "// edited" })).toBe(1);
    expect(at({ live: () => `${BAKED_SIGSTORE_TRUSTED_ROOTS} ` })).toBe(1);
    expect(
      at({
        live: () => {
          throw new Error("gh not found");
        },
      }),
    ).toBe(1);
    expect(log.some((l) => l.includes("trust:refresh-sigstore-roots"))).toBe(true);
  });
});

describe("runRefresh", () => {
  test("writes the rendered module for valid roots, and nothing for invalid ones", () => {
    const writes: Array<[string, string]> = [];
    const log: string[] = [];
    const deps = {
      modulePath: "m.ts",
      write: (p: string, t: string) => void writes.push([p, t]),
      log: (l: string) => void log.push(l),
    };
    expect(runRefresh({ ...deps, readLive: () => BAKED_SIGSTORE_TRUSTED_ROOTS })).toBe(0);
    expect(writes).toEqual([["m.ts", renderRootsModule(BAKED_SIGSTORE_TRUSTED_ROOTS)]]);
    expect(runRefresh({ ...deps, readLive: () => "{}" })).toBe(1);
    expect(writes).toHaveLength(1);
  });
});
