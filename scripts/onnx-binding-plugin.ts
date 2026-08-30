import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
export const ONNX_BINDING_FILTER = /onnxruntime-node.*binding[.]js$/;

/**
 * `onnxruntime-node` is TRANSITIVE (via `@xenova/transformers`), so resolution starts at the
 * gateway manifest and hops through the package that declares it.
 */
export function resolveOnnxBindingOrThrow(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const os = platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux";
  const rel = `bin/napi-v3/${os}/${arch}/onnxruntime_binding.node`;
  try {
    const req = createRequire(GATEWAY_PACKAGE_JSON);
    const transformersIndex = req.resolve("@xenova/transformers");
    const onnxIndex = createRequire(transformersIndex).resolve("onnxruntime-node");
    // `onnxIndex` is `.../onnxruntime-node/dist/index.js`; the binding sits two levels up.
    return join(dirname(dirname(onnxIndex)), ...rel.split("/"));
  } catch (e: unknown) {
    throw new Error(
      `onnx-binding-plugin: cannot resolve ${rel} for ${platform}/${arch}. Without it the ` +
        "embedding worker dies at init and semantic search is silently disabled. " +
        `Cause: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * CommonJS source that materialises the binding beside the OS temp dir and requires it.
 *
 * The filename carries a content hash so an upgrade cannot keep loading a stale binding — the
 * classic failure of "extract once if absent". Publication is write-to-temp-then-rename so two
 * gateways starting concurrently cannot observe a half-written addon; if the rename loses the
 * race, the winner's file is already correct, since the name is the hash of these exact bytes.
 */
export function buildBindingModuleSource(bytes: Buffer): string {
  const b64 = bytes.toString("base64");
  const sha = createHash("sha256").update(bytes).digest("hex");
  return `// GENERATED by scripts/onnx-binding-plugin.ts — replaces onnxruntime-node/dist/binding.js.
"use strict";
const fs = require("node:fs");
const { join } = require("node:path");
const { homedir, tmpdir } = require("node:os");
const { createHash, randomBytes } = require("node:crypto");
const { createRequire } = require("node:module");

const BYTES = Buffer.from(${JSON.stringify(b64)}, "base64");
const SHA256 = ${JSON.stringify(sha)};

/**
 * A PER-USER directory, never the shared temp dir.
 *
 * On POSIX \`tmpdir()\` is world-writable, so any local user could pre-create our path. That is
 * not theoretical here: what gets written is then dlopen'd into the gateway, which holds Vault
 * access, so a hostile file at that path is arbitrary code execution as this user.
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
  // Last resort only. The O_EXCL write and hash check below still hold here.
  return join(tmpdir(), "nimbus-native");
}

const dir = baseDir();
const target = join(dir, "onnxruntime_binding-" + SHA256.slice(0, 16) + ".node");

/**
 * Trust the file on disk only if it is a REGULAR file whose CONTENT hashes to what we embedded.
 *
 * The previous check compared \`statSync(target).size\` — size is not identity, and \`statSync\`
 * follows symlinks, so a malicious library padded to the same byte length passed it and was
 * loaded. \`lstatSync\` does not follow, and the hash makes length irrelevant.
 */
function isTrustedFile(p) {
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
  if (actual.length !== BYTES.length) return false;
  return createHash("sha256").update(actual).digest("hex") === SHA256;
}

if (!isTrustedFile(target)) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Remove whatever occupies the path rather than writing THROUGH it — writing through a symlink
  // is the arbitrary-overwrite half of the same problem.
  try {
    fs.lstatSync(target);
    fs.unlinkSync(target);
  } catch {
    /* nothing there, or already gone — both fine */
  }
  // \`wx\` is O_EXCL: it FAILS on an existing path instead of following a symlink planted there.
  // The random suffix keeps two concurrent starts from colliding on the same scratch name.
  const tmp = target + "." + String(process.pid) + "." + randomBytes(6).toString("hex") + ".tmp";
  fs.writeFileSync(tmp, BYTES, { flag: "wx", mode: 0o600 });
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    // Losing the race is fine ONLY if what won verifies; otherwise surface the failure.
    if (!isTrustedFile(target)) throw e;
  }
  if (!isTrustedFile(target)) {
    throw new Error("onnxruntime addon at " + target + " failed verification after extraction");
  }
}

// Same shape as the module this replaces: a named \`binding\` export plus the \`__esModule\`
// marker. Returning the addon as a default export instead would leave \`binding.InferenceSession\`
// undefined at first use rather than failing at load.
Object.defineProperty(exports, "__esModule", { value: true });
exports.binding = createRequire(__filename)(target);
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
      contents: buildBindingModuleSource(readFileSync(resolveOnnxBindingOrThrow())),
      loader: "js",
    }));
  },
};
