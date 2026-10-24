// The role packs that ship inside the gateway. Imported statically so `bun build --compile` embeds
// them; parsed at module load, so a malformed file fails the first import rather than an install.

import { parseRolePackManifestValue, type RolePackManifest } from "@nimbus-dev/registry-format";
import devops from "./bundled/devops.json" with { type: "json" };
import pm from "./bundled/pm.json" with { type: "json" };

const entries: readonly RolePackManifest[] = [pm, devops].map((raw) =>
  parseRolePackManifestValue(raw),
);

export const BUNDLED_PACKS: ReadonlyMap<string, RolePackManifest> = new Map(
  entries.map((m) => [m.id, m]),
);
