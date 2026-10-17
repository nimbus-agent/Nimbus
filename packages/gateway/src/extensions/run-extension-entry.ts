import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

/** The process effects the role has; injected only by its unit test, never by production. */
export interface RunExtensionEntryDeps {
  readonly exit: (code: number) => void;
  readonly importModule: (href: string) => Promise<unknown>;
  readonly writeStderr: (text: string) => void;
}

const PROCESS_DEPS: RunExtensionEntryDeps = {
  exit: (code) => process.exit(code),
  importModule: (href) => import(href),
  writeStderr: (text) => {
    process.stderr.write(text);
  },
};

/**
 * The `__nimbus-extension` self-role: `import()` an approved extension's entry file so it can run
 * as an MCP stdio server under the sandbox. Like the connector role this stays THIN — only
 * `node:path`/`node:url` — so an extension process never evaluates the gateway module graph
 * (`entry-graph.test.ts` enforces that). The path is supplied by the gateway's spawner, which
 * resolved it inside the extension's verified per-spawn stage (I43); a relative or missing path is
 * refused rather than imported. A throwing entry exits 2 with its message AND stack on stderr.
 */
export async function runExtensionEntry(
  entryPath: string | undefined,
  deps: RunExtensionEntryDeps = PROCESS_DEPS,
): Promise<void> {
  if (entryPath === undefined || entryPath === "" || !isAbsolute(entryPath)) {
    deps.writeStderr("nimbus-gateway: extension role needs an absolute entry path\n");
    deps.exit(2);
    return;
  }
  try {
    await deps.importModule(pathToFileURL(entryPath).href);
  } catch (err: unknown) {
    deps.writeStderr(`nimbus-gateway: ${err instanceof Error ? err.message : String(err)}\n`);
    if (err instanceof Error && err.stack !== undefined) deps.writeStderr(`${err.stack}\n`);
    deps.exit(2);
  }
}
