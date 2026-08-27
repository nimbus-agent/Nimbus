import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * Scan targets, resolved relative to THIS FILE — never to the process working directory.
 *
 * The CWD-relative form (`Bun.file("packages/gateway/src/llm/router.ts")`) that shipped here
 * only resolved when `bun test` happened to be invoked from the repo root. On CI it threw
 * `ENOENT` and all three tests failed — but the failure mode this guards against is worse than
 * a red test: a structural scan whose targets silently do not resolve reports an empty offender
 * list and passes, which is exactly what a file-not-found returning empty text would have
 * produced. `label` stays repo-relative POSIX so failure output and the file-set assertion below
 * read the same on every OS (and so splitting on `":"` cannot hit a Windows drive letter).
 */
const HERE = import.meta.dir;
const FILES: ReadonlyArray<{ label: string; path: string }> = [
  { label: "packages/gateway/src/llm/router.ts", path: join(HERE, "router.ts") },
  { label: "packages/gateway/src/llm/registry.ts", path: join(HERE, "registry.ts") },
  { label: "packages/gateway/src/ipc/llm-rpc.ts", path: join(HERE, "..", "ipc", "llm-rpc.ts") },
  // Added after the whole-branch review: this file holds a FOURTH literal pair the
  // original three-file scan could not see (`KNOWN_LOCAL_RUNTIMES`). That one is
  // allow-listed below — it is the registry of runtimes this build knows how to
  // CONSTRUCT a provider for, not a copy of the locality definition — but it must be
  // allow-listed by name rather than by being invisible to the scan.
  {
    label: "packages/gateway/src/platform/assemble.ts",
    path: join(HERE, "..", "platform", "assemble.ts"),
  },
];

const ASSEMBLE = "packages/gateway/src/platform/assemble.ts";

async function readTarget(label: string): Promise<string> {
  const target = FILES.find((f) => f.label === label);
  if (target === undefined) throw new Error(`not a scan target: ${label}`);
  const src = await Bun.file(target.path).text();
  // A scan over an empty string finds nothing and passes. Fail loudly instead: this guard's
  // whole value is that it actually read the file it claims to have read.
  if (src.trim() === "") throw new Error(`scan target is empty or unreadable: ${target.path}`);
  return src;
}

// The one literal pair that is NOT a locality copy. `KNOWN_LOCAL_RUNTIMES` gates
// `[llm.local.<name>].runtime` before `buildLlmRegistryFromToml` picks a provider class:
// a runtime it does not name (`"vllm"`) is dropped rather than silently constructed as
// Ollama. Nothing reads it to decide whether a provider is local — that is
// `provider.isLocal`, asserted positively below — and deleting it would not change any
// locality answer, only re-open the silent-misconstruction hole.
const ALLOWED_RUNTIME_REGISTRY = 'const KNOWN_LOCAL_RUNTIMES = new Set(["ollama", "llamacpp"]);';

const LOCAL_ID_PAIR = /\["ollama",\s*"llamacpp"\]/;
// A quoted vendor id. Locality must never be decided by comparing against one of these.
const VENDOR_ID_LITERAL = /"(ollama|llamacpp|remote)"/;

/**
 * A provider-id comparison against a vendor literal, in either operand order —
 * `route.provider.providerId === "ollama"`, `"llamacpp" !== p.providerId`.
 *
 * Checked INDEPENDENTLY of whether the line also mentions `isLocal`, which is the gap the
 * previous version left wide open: it only recorded a vendor literal when the SAME line read
 * `isLocal`, so an added `if (route.provider.providerId === "ollama") …` locality branch —
 * precisely the re-derivation this whole file exists to forbid — evaded the guard entirely by
 * not spelling the word.
 *
 * Keyed on the `providerId` token rather than on any vendor literal, so the legitimate
 * RUNTIME dispatch in `assemble.ts` (`route.runtime === "llamacpp" ? … : …`, which chooses a
 * provider CLASS and a default port, not a locality) is not a false positive.
 */
const PROVIDER_ID_COMPARISON =
  /(?:providerId\s*[=!]==?\s*"(?:ollama|llamacpp|remote)")|(?:"(?:ollama|llamacpp|remote)"\s*[=!]==?\s*(?:[\w$.]*\.)?providerId\b)/;

/** A membership check over a provider id: `SET.has(x.providerId)`, `[…].includes(providerId)`. */
const PROVIDER_ID_MEMBERSHIP = /\.(?:has|includes)\(\s*(?:[\w$.]*\.)?providerId\b/;

/** Strips line comments so prose describing the rule cannot trip the checks that enforce it. */
function codeOf(line: string): string {
  return line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
}

describe("local-ness has exactly one definition", () => {
  test("no file re-derives the local provider set from literals", async () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = await readTarget(f.label);
      // The three copies this refactor collapsed: a literal pair of local ids. The
      // runtime registry is removed first, so allowing it cannot also blind the scan to
      // a SECOND pair added later in the same file.
      const scanned = src.replaceAll(ALLOWED_RUNTIME_REGISTRY, "");
      if (LOCAL_ID_PAIR.test(scanned)) offenders.push(f.label);
    }
    expect(offenders).toEqual([]);
  });

  test("the allow-listed literal pair is still exactly the runtime registry", async () => {
    // Guards the allowance above: if `KNOWN_LOCAL_RUNTIMES` is renamed or reshaped, the
    // `replaceAll` silently stops matching and the scan quietly widens instead of failing.
    const src = await readTarget(ASSEMBLE);
    expect(src).toContain(ALLOWED_RUNTIME_REGISTRY);
  });

  test("isLocal is read from the provider, never inferred from an id", async () => {
    // Positive property, not a missing-symbol check: every site that consults locality
    // reads it off a provider INSTANCE, and no locality decision anywhere in the scanned
    // set is made by comparing against a vendor-id literal.
    const readSites: string[] = [];
    const idDerived: string[] = [];
    for (const f of FILES) {
      const src = await readTarget(f.label);
      for (const line of src.split("\n")) {
        // Comments describe the rule; only code can break it.
        const code = codeOf(line);
        if (!code.includes("isLocal")) continue;
        if (/(?:provider|p|r)\.isLocal\b/.test(code)) readSites.push(`${f.label}: ${code.trim()}`);
        if (VENDOR_ID_LITERAL.test(code)) idDerived.push(`${f.label}: ${code.trim()}`);
      }
    }
    // Locality is derived from a vendor id NOWHERE.
    expect(idDerived).toEqual([]);
    // And it is actually read off the provider — in the router (the resolution path), the
    // registry (the capability-floor walk) and the IPC surface (what the CLI renders).
    const files = new Set(readSites.map((s) => s.split(":")[0]));
    expect([...files].sort()).toEqual([
      "packages/gateway/src/ipc/llm-rpc.ts",
      "packages/gateway/src/llm/registry.ts",
      "packages/gateway/src/llm/router.ts",
    ]);
  });

  test("no provider-id comparison or membership check, on ANY line", async () => {
    // The independent half (see PROVIDER_ID_COMPARISON): a locality branch keyed on a vendor
    // id is forbidden whether or not the word `isLocal` appears beside it.
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = await readTarget(f.label);
      for (const line of src.split("\n")) {
        const code = codeOf(line);
        if (PROVIDER_ID_COMPARISON.test(code) || PROVIDER_ID_MEMBERSHIP.test(code)) {
          offenders.push(`${f.label}: ${code.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the vendor-id detectors actually match the shapes they forbid", async () => {
    // Red-proves the guard above without editing production source: the detectors must fire
    // on every re-derivation shape, including the ones with no `isLocal` on the line. A
    // structural test whose regex silently matches nothing is the failure this file already
    // shipped once (CWD-relative paths) — assert the detectors, not just their verdict.
    for (const shape of [
      'if (route.provider.providerId === "ollama") return true;',
      'const local = p.providerId !== "remote";',
      'if ("llamacpp" === provider.providerId) { }',
    ]) {
      expect(PROVIDER_ID_COMPARISON.test(shape)).toBe(true);
    }
    for (const shape of [
      "if (LOCAL_IDS.has(route.provider.providerId)) return true;",
      "const local = LOCAL_IDS.includes(providerId);",
    ]) {
      expect(PROVIDER_ID_MEMBERSHIP.test(shape)).toBe(true);
    }
    // And must NOT fire on the legitimate runtime dispatch in assemble.ts, or the guard
    // becomes noise someone loosens.
    expect(
      PROVIDER_ID_COMPARISON.test('route.runtime === "llamacpp" ? "llamacpp" : "ollama"'),
    ).toBe(false);
    expect(PROVIDER_ID_MEMBERSHIP.test("KNOWN_LOCAL_RUNTIMES.has(route.runtime)")).toBe(false);
    // The scan targets resolve: a path typo must fail, not scan an empty string.
    await expect(readTarget(ASSEMBLE)).resolves.toContain("buildLlmRegistryFromToml");
  });
});
