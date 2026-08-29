#!/usr/bin/env bun
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const GATEWAY_MANIFEST = join(REPO_ROOT, "packages", "gateway", "package.json");

/**
 * Dependencies of the gateway that legitimately carry native code.
 *
 * `sqlite-vec` is the only one, and it is handled deliberately rather than bundled:
 * `compile-gateway.ts` copies its platform sidecar (`vec0.dll` / `.so` / `.dylib`) next to the
 * binary. That is the pattern a native dependency has to follow here — the compiled binary cannot
 * contain one, so it must be shipped alongside and loaded at runtime.
 *
 * Adding an entry means committing to that sidecar work on all three platforms. "It built on Linux
 * CI" is not evidence that it loads on a user's Windows machine.
 */
const ALLOWED_NATIVE: ReadonlySet<string> = new Set([
  "sqlite-vec",
  // Transitive via `@xenova/transformers`, so this audit never actually SAW it — the gate scans
  // declared dependencies only, and reported `ok` while the embedding worker was dead in every
  // install (#1396). Listed explicitly so the exemption is a recorded decision rather than a blind
  // spot, and so adding it to the manifest later does not read as new. The sidecar commitment it
  // implies is met by `copy-onnx-sidecar.ts`, called from `build-workers.ts`.
  "onnxruntime-node",
]);

export type NativeFinding = { readonly pkg: string; readonly evidence: readonly string[] };

/** Native artefacts a package ships: a prebuilt binary, or the gyp recipe to build one. */
export function nativeEvidence(dir: string): string[] {
  const hits: string[] = [];
  if (existsSync(join(dir, "binding.gyp"))) hits.push("binding.gyp");
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      // Never descend into a nested node_modules: those are OTHER packages. Counting their
      // artefacts here would attribute a dependency's native code to whoever hoisted it.
      if (e.isDirectory() && e.name !== "node_modules") stack.push(join(cur, e.name));
      else if (e.isFile() && e.name.endsWith(".node")) {
        hits.push(e.name);
        return hits;
      }
    }
  }
  return hits;
}

/**
 * Every package the gateway DECLARES, checked for native artefacts.
 *
 * SCOPE BOUND, stated plainly because it is narrower than it first appears: this reads the
 * gateway's own manifest and does NOT walk the transitive graph.
 *
 * That is not laziness — it is what is reliably computable here. A transitive walk was written
 * first and silently under-reported: `@mastra/core` declares 32 dependencies under npm ALIASES
 * (`@ai-sdk/provider-utils-v5` and friends), which resolve through bun's isolated `.bun` store.
 * Neither directory-walking `node_modules` nor `Bun.resolveSync` finds them from the package's own
 * directory, and `bun.lock` is JSONC that `Bun.file().json()` refuses. The walk reported a
 * 20-package closure for a tree of ~1,400 — a green result that meant "I could not see anything",
 * which is the worst kind of gate.
 *
 * What this DOES catch is the realistic regression: someone adds a native dependency to the
 * gateway's manifest, or bumps one that starts shipping a `.node`. The transitive case is covered
 * empirically instead, by `test:connector-boot` — it boots all 94 connectors out of the actually
 * compiled binary, so a native module that breaks loading fails there. That backstop is weaker on
 * one axis worth knowing: it runs on CI Linux, so it would not catch a module that loads there and
 * not on a user's Windows machine.
 */
export function checkGatewayNativeDeps(manifestPath: string = GATEWAY_MANIFEST): NativeFinding[] {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const declared = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies });
  const nodeModules = join(manifestPath, "..", "node_modules");
  const out: NativeFinding[] = [];
  for (const pkg of declared) {
    if (ALLOWED_NATIVE.has(pkg)) continue;
    const dir = join(nodeModules, ...pkg.split("/"));
    if (!existsSync(dir)) continue;
    const evidence = nativeEvidence(dir);
    if (evidence.length > 0) out.push({ pkg, evidence });
  }
  return out.sort((a, b) => a.pkg.localeCompare(b.pkg));
}

export function report(findings: readonly NativeFinding[], checked: number): number {
  for (const f of findings) {
    console.error(
      `::error file=packages/gateway/package.json::${f.pkg} ships native artefacts (${f.evidence.join(", ")}) — the gateway compiles to a single binary, which cannot bundle a native module. Ship it as a sidecar the way sqlite-vec is, or drop it`,
    );
  }
  console.log(
    findings.length === 0
      ? `gateway native deps: ok (${String(checked)} declared dependencies checked)`
      : `gateway native deps: ${String(findings.length)} violation(s)`,
  );
  return findings.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  const manifest = JSON.parse(readFileSync(GATEWAY_MANIFEST, "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const count = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).length;
  process.exit(report(checkGatewayNativeDeps(), count));
}
