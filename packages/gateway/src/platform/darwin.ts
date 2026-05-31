import { assemblePlatformServices } from "./assemble.ts";
import { createDarwinPaths } from "./paths.ts";
import type { PlatformServices } from "./types.ts";

export async function create(): Promise<PlatformServices> {
  const paths = createDarwinPaths();
  return assemblePlatformServices(paths);
}
