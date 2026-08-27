import { describe, expect, test } from "bun:test";

const FILES = [
  "packages/gateway/src/llm/router.ts",
  "packages/gateway/src/llm/registry.ts",
  "packages/gateway/src/ipc/llm-rpc.ts",
  // Added after the whole-branch review: this file holds a FOURTH literal pair the
  // original three-file scan could not see (`KNOWN_LOCAL_RUNTIMES`). That one is
  // allow-listed below — it is the registry of runtimes this build knows how to
  // CONSTRUCT a provider for, not a copy of the locality definition — but it must be
  // allow-listed by name rather than by being invisible to the scan.
  "packages/gateway/src/platform/assemble.ts",
];

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

describe("local-ness has exactly one definition", () => {
  test("no file re-derives the local provider set from literals", async () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = await Bun.file(f).text();
      // The three copies this refactor collapsed: a literal pair of local ids. The
      // runtime registry is removed first, so allowing it cannot also blind the scan to
      // a SECOND pair added later in the same file.
      const scanned = src.replaceAll(ALLOWED_RUNTIME_REGISTRY, "");
      if (LOCAL_ID_PAIR.test(scanned)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  test("the allow-listed literal pair is still exactly the runtime registry", async () => {
    // Guards the allowance above: if `KNOWN_LOCAL_RUNTIMES` is renamed or reshaped, the
    // `replaceAll` silently stops matching and the scan quietly widens instead of failing.
    const src = await Bun.file("packages/gateway/src/platform/assemble.ts").text();
    expect(src).toContain(ALLOWED_RUNTIME_REGISTRY);
  });

  test("isLocal is read from the provider, never inferred from an id", async () => {
    // Positive property, not a missing-symbol check: every site that consults locality
    // reads it off a provider INSTANCE, and no locality decision anywhere in the scanned
    // set is made by comparing against a vendor-id literal.
    const readSites: string[] = [];
    const idDerived: string[] = [];
    for (const f of FILES) {
      const src = await Bun.file(f).text();
      for (const line of src.split("\n")) {
        // Comments describe the rule; only code can break it.
        const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
        if (!code.includes("isLocal")) continue;
        if (/(?:provider|p|r)\.isLocal\b/.test(code)) readSites.push(`${f}: ${code.trim()}`);
        if (VENDOR_ID_LITERAL.test(code)) idDerived.push(`${f}: ${code.trim()}`);
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
});
