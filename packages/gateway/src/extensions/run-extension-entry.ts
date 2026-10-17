import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The `__nimbus-extension` self-role: `import()` an installed extension's entry file so it can run
 * as an MCP stdio server under the sandbox. Like the connector role this stays THIN — only
 * `node:path`/`node:url` — so an extension process never evaluates the gateway module graph
 * (`entry-graph.test.ts` enforces that). The path is supplied by the gateway's spawner, which
 * resolved it inside the install tree; a relative or missing path is refused rather than imported.
 */
export async function runExtensionEntry(entryPath: string | undefined): Promise<void> {
  if (entryPath === undefined || entryPath === "" || !isAbsolute(entryPath)) {
    process.stderr.write("nimbus-gateway: extension role needs an absolute entry path\n");
    process.exit(2);
  }
  try {
    await import(pathToFileURL(entryPath).href);
  } catch (err: unknown) {
    process.stderr.write(`nimbus-gateway: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
