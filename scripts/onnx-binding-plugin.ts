import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Embed the onnxruntime native binding into the worker bundle and load it from a real file at
 * runtime.
 *
 * `onnxruntime-node` loads its addon with a RELATIVE require:
 *
 *     require("../bin/napi-v3/<platform>/<arch>/onnxruntime_binding.node")
 *
 * Bundled into `dist/workers/embedding-worker.js` that becomes `dist/bin/...`, and inside a
 * compiled binary the worker runs from Bun's virtual FS, so it becomes `B:/~bin/...` — a path that
 * cannot exist. Either way the embedding runtime died at init and semantic search was silently
 * dead (#1396). Placing the file next to the bundled worker fixes the source tree ONLY; the
 * compiled binary still fails, which is what made the first attempt insufficient.
 *
 * The interception point is `onnxruntime-node/dist/binding.js`, NOT the `.node` specifier. That
 * module loads the addon with a TEMPLATE LITERAL:
 *
 *     exports.binding = require(`../bin/napi-v3/${process.platform}/${process.arch}/…node`);
 *
 * which the bundler cannot resolve statically, so it emits a RUNTIME require and no `onResolve`
 * hook on the specifier ever fires — the first version of this plugin filtered on the specifier
 * and silently did nothing, leaving the bundle byte-identical. Replacing the whole module is what
 * actually works, and it must keep `binding.js`'s exact shape: a named `binding` export plus the
 * `__esModule` marker its consumers read.
 *
 * Measured, not assumed — inside a real compiled binary:
 *   - a `.node` CAN be dlopen'd from an absolute path on disk;
 *   - `readFileSync` CAN read an embedded file synchronously.
 * Both are required for what follows, and a synchronous path is mandatory because we are replacing
 * a synchronous `require`.
 *
 * WHY EMBED rather than ship a sidecar beside the binary, the way `vec0` is shipped: both designs
 * need this same plugin, since the baked-in relative path has to be replaced regardless. They
 * differ only in where the bytes come from — so a sidecar buys no simplicity and costs a file that
 * must be added to SEVEN shipping paths (`install.sh`, `install.ps1`, `package-headless-bundle`,
 * `package-linux-installers`, `package-macos-installer.sh`, `package-windows-installer.ps1`,
 * `compile-gateway`). `copy-vec0-sidecar.ts` records that this exact mistake already happened once
 * and failed silently. Embedding touches none of them.
 *
 * The emitted module is COMMONJS on purpose. It replaces a `require()`, and an ESM module with a
 * default export would come back as `{ default: … }` through the interop, leaving
 * `binding.InferenceSession` undefined — a failure that would only appear at first use.
 */

const GATEWAY_PACKAGE_JSON = fileURLToPath(
  new URL("../packages/gateway/package.json", import.meta.url),
);

/**
 * Matches `onnxruntime-node/dist/binding.js` — the module whose template-literal require is the
 * problem. Anchored on the package directory so an unrelated `binding.js` elsewhere in the tree
 * cannot be swallowed by it.
 */
export const ADDON_FILENAME = "onnxruntime_binding.node";

export const ONNX_BINDING_FILTER = /onnxruntime-node.*binding[.]js$/;

/**
 * `onnxruntime-node` is TRANSITIVE (via `@xenova/transformers`), so resolution starts at the
 * gateway manifest and hops through the package that declares it.
 */
export function resolveOnnxBindingDirOrThrow(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const os = platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux";
  const rel = `bin/napi-v3/${os}/${arch}`;
  try {
    const req = createRequire(GATEWAY_PACKAGE_JSON);
    const transformersIndex = req.resolve("@xenova/transformers");
    const onnxIndex = createRequire(transformersIndex).resolve("onnxruntime-node");
    // `onnxIndex` is `.../onnxruntime-node/dist/index.js`; the bin tree sits two levels up.
    return join(dirname(dirname(onnxIndex)), ...rel.split("/"));
  } catch (e: unknown) {
    throw new Error(
      `onnx-binding-plugin: cannot resolve ${rel} for ${platform}/${arch}. Without it the ` +
        "embedding worker dies at init and semantic search is silently disabled. " +
        `Cause: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Addon plus every sibling it needs. See the header for why the siblings are not optional. */
export function readOnnxPayload(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): { name: string; bytes: Buffer }[] {
  const dir = resolveOnnxBindingDirOrThrow(platform, arch);
  const names = readdirSync(dir).filter((n) => !n.startsWith("."));
  if (!names.includes(ADDON_FILENAME)) {
    throw new Error(`onnx-binding-plugin: ${ADDON_FILENAME} missing from ${dir}`);
  }
  return names.map((name) => ({ name, bytes: readFileSync(join(dir, name)) }));
}

/**
 * CommonJS source that materialises the addon AND its sibling runtime library, then requires it.
 *
 * Both are mandatory. The addon declares `NEEDED libonnxruntime.so.1.14.0` with
 * `RPATH: [$ORIGIN/]` — verified with `readelf` — so it looks for the library in ITS OWN
 * directory. Extracting the addon alone produced, in a clean container:
 *
 *     libonnxruntime.so.1.14.0: cannot open shared object file: No such file or directory
 *
 * Files keep their ORIGINAL names, because `$ORIGIN` resolution matches on soname; the DIRECTORY
 * carries the content hash instead. That gives staleness protection without renaming a file whose
 * name is load-bearing.
 */
export function buildBindingModuleSource(payload: { name: string; bytes: Buffer }[]): string {
  const digest = createHash("sha256");
  for (const f of [...payload].sort((a, b) => a.name.localeCompare(b.name))) {
    digest.update(f.name).update(f.bytes);
  }
  const dirHash = digest.digest("hex").slice(0, 16);
  const entries = payload
    .map(
      (f) =>
        `  { name: ${JSON.stringify(f.name)}, sha: ${JSON.stringify(
          createHash("sha256").update(f.bytes).digest("hex"),
        )}, b64: ${JSON.stringify(f.bytes.toString("base64"))} }`,
    )
    .join(",\n");
  return `// GENERATED by scripts/onnx-binding-plugin.ts — replaces onnxruntime-node/dist/binding.js.
"use strict";
const fs = require("node:fs");
const { join } = require("node:path");
const { homedir, tmpdir } = require("node:os");
const { createHash, randomBytes } = require("node:crypto");
const { createRequire } = require("node:module");

const FILES = [
${entries}
];
const ADDON = ${JSON.stringify(ADDON_FILENAME)};

/**
 * A PER-USER directory, never the shared temp dir. On POSIX \`tmpdir()\` is world-writable, so a
 * local user could pre-create our path — and what lands there is dlopen'd into a process holding
 * Vault access.
 */
function baseDir() {
  if (process.platform === "win32") {
    const la = process.env.LOCALAPPDATA;
    if (la) return join(la, "Nimbus", "native");
  } else if (process.platform === "darwin") {
    const h = homedir();
    if (h) return join(h, "Library", "Caches", "Nimbus", "native");
  } else {
    const xdg = process.env.XDG_CACHE_HOME;
    if (xdg) return join(xdg, "nimbus", "native");
    const h = homedir();
    if (h) return join(h, ".cache", "nimbus", "native");
  }
  // Last resort only; the O_EXCL write and hash check below still hold here.
  return join(tmpdir(), "nimbus-native");
}

// Hash names the DIRECTORY, so every file inside keeps the name its soname requires.
const dir = join(baseDir(), "onnxruntime-${dirHash}");

/** Trust a file only if it is a REGULAR file whose CONTENT hashes to what we embedded. */
function isTrustedFile(p, sha, len) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  let actual;
  try {
    actual = fs.readFileSync(p);
  } catch {
    return false;
  }
  if (actual.length !== len) return false;
  return createHash("sha256").update(actual).digest("hex") === sha;
}

for (const f of FILES) {
  const bytes = Buffer.from(f.b64, "base64");
  const target = join(dir, f.name);
  if (isTrustedFile(target, f.sha, bytes.length)) continue;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Remove whatever occupies the path rather than writing THROUGH it.
  try {
    fs.lstatSync(target);
    fs.unlinkSync(target);
  } catch {
    /* nothing there, or already gone */
  }
  // \`wx\` is O_EXCL: FAILS on an existing path instead of following a planted symlink.
  const tmp = target + "." + String(process.pid) + "." + randomBytes(6).toString("hex") + ".tmp";
  fs.writeFileSync(tmp, bytes, { flag: "wx", mode: 0o600 });
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    if (!isTrustedFile(target, f.sha, bytes.length)) throw e;
  }
  if (!isTrustedFile(target, f.sha, bytes.length)) {
    throw new Error("onnxruntime payload " + f.name + " failed verification after extraction");
  }
}

// Same shape as the module this replaces: a named \`binding\` export plus the \`__esModule\`
// marker. An ESM default export would leave \`binding.InferenceSession\` undefined at first use.
Object.defineProperty(exports, "__esModule", { value: true });
exports.binding = createRequire(__filename)(join(dir, ADDON));
`;
}

/**
 * Bun build plugin. Intercepts the addon require and replaces it with the module above.
 *
 * Resolution is keyed to the BUILD host's platform/arch, which is what the compiled binary for
 * that host needs. A cross-compiled build would embed the wrong addon — out of scope here, and
 * called out so it is a known bound rather than a surprise.
 */
export const onnxBindingPlugin: import("bun").BunPlugin = {
  name: "embed-onnx-binding",
  setup(build) {
    build.onLoad({ filter: ONNX_BINDING_FILTER }, () => ({
      contents: buildBindingModuleSource(readOnnxPayload()),
      loader: "js",
    }));
  },
};
