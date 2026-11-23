import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const IPC_DIR = resolve(import.meta.dir, "..", "..", "src", "ipc");

/**
 * The source text of the local HTTP API: the request pipeline (`ipc/http-server.ts`) first, then
 * each route-family module it was split into (`ipc/http-server/*.ts`, in name order). Resolved
 * from this file, never from the process CWD, so it works under CI's sharded runner.
 *
 * One entry per file, because the files are separate modules: a scan that transpiles must do so
 * per file (concatenated modules redeclare each other's imports).
 */
export async function readHttpServerSources(): Promise<string[]> {
  const familyDir = join(IPC_DIR, "http-server");
  const files = [
    join(IPC_DIR, "http-server.ts"),
    ...readdirSync(familyDir)
      .filter((name) => name.endsWith(".ts"))
      .sort()
      .map((name) => join(familyDir, name)),
  ];
  return await Promise.all(files.map((file) => Bun.file(file).text()));
}

/** `readHttpServerSources()` as Bun transpiles it: comments gone, one printed shape per call. */
export async function readHttpServerCode(): Promise<string> {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const sources = await readHttpServerSources();
  return sources.map((source) => transpiler.transformSync(source)).join("\n");
}
