import consoleIndexHtml from "../../../admin-console/dist/index.html" with { type: "file" };
import consoleMainJs from "../../../admin-console/dist/main.js" with { type: "file" };
import consoleStylesCss from "../../../admin-console/dist/styles.css" with { type: "file" };
import openapiV1Yaml from "../../openapi/v1.yaml" with { type: "file" };

/**
 * Assets baked into the executable.
 *
 * `bun build --compile` embeds a `{ type: "file" }` import and rewrites it to the file's path
 * inside the binary; under `bun` the same import is the real path on disk. Nothing here is derived
 * from `import.meta.dir`, which in a compiled binary is the virtual root `/$bunfs/root`
 * (`B:\~BUN\root` on Windows) and yields paths that do not exist.
 *
 * Embedded files land in a FLAT bunfs root under content-hashed names — `main.js` becomes
 * something like `/$bunfs/root/main-zf9wbt8q.js` — so there is no directory to join a request path
 * against. The map below is the whole namespace: a lookup either hits one of three keys or misses.
 *
 * The console's build output is exactly these three files (`bun build src/main.ts --outdir dist
 * --minify`, plus a copy of `index.html` and `src/styles.css`). Adding a fourth means adding an
 * import here; `embedded-assets.test.ts` asserts the key set.
 */
export const EMBEDDED_CONSOLE_ASSETS: Readonly<Record<string, string>> = Object.freeze({
  "index.html": consoleIndexHtml,
  "main.js": consoleMainJs,
  "styles.css": consoleStylesCss,
});

/** Absolute path to the OpenAPI document. Committed source, so no build step gates it. */
export const EMBEDDED_OPENAPI_YAML: string = openapiV1Yaml;
