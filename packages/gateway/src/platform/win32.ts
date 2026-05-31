import { assemblePlatformServices } from "./assemble.ts";
import { createWindowsPaths } from "./paths.ts";
import type { PlatformServices } from "./types.ts";

export async function create(): Promise<PlatformServices> {
  const paths = createWindowsPaths();
  return assemblePlatformServices(paths);
}
