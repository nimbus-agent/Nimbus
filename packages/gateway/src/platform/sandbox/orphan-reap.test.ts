import { describe, expect, it } from "bun:test";
import { reapOrphanedAppContainers } from "./orphan-reap.ts";

describe("reapOrphanedAppContainers", () => {
  it("deletes profiles with nimbus-ext- prefix not in the live set", async () => {
    const enumProfiles = async () => ["nimbus-ext-known", "nimbus-ext-orphan", "other"];
    const deleted: string[] = [];
    const deleteProfile = async (name: string) => {
      deleted.push(name);
      return true;
    };

    await reapOrphanedAppContainers({
      enumProfiles,
      deleteProfile,
      liveExtensionIds: new Set(["known"]),
    });

    expect(deleted).toEqual(["nimbus-ext-orphan"]);
  });

  it("ignores profiles without the nimbus-ext- prefix", async () => {
    const enumProfiles = async () => ["random-app", "nimbus-ext-x"];
    const deleted: string[] = [];
    const deleteProfile = async (name: string) => {
      deleted.push(name);
      return true;
    };

    await reapOrphanedAppContainers({
      enumProfiles,
      deleteProfile,
      liveExtensionIds: new Set(["x"]),
    });
    expect(deleted).toEqual([]);
  });
});
