/**
 * Windows AppContainer orphan-reap (Plan Task 11, T2 PR 1).
 *
 * Pure function: receives a `liveExtensionIds` set + injectable
 * `enumProfiles` + `deleteProfile` so the unit test can stub the
 * win32-specific Registry enumeration. The Gateway's win32
 * SandboxRunner (Task 12) supplies the real implementations.
 */

const PREFIX = "nimbus-ext-";

export interface ReapOpts {
  enumProfiles: () => Promise<string[]>;
  deleteProfile: (name: string) => Promise<void>;
  liveExtensionIds: Set<string>;
}

/**
 * Enumerate AppContainer profiles, identify ones whose name has the
 * `nimbus-ext-` prefix but whose extension id is NOT in the live set,
 * and delete each one. Returns the list of deleted profile names.
 */
export async function reapOrphanedAppContainers(opts: ReapOpts): Promise<string[]> {
  const profiles = await opts.enumProfiles();
  const reaped: string[] = [];
  for (const profile of profiles) {
    if (!profile.startsWith(PREFIX)) continue;
    const extId = profile.slice(PREFIX.length);
    if (opts.liveExtensionIds.has(extId)) continue;
    await opts.deleteProfile(profile);
    reaped.push(profile);
  }
  return reaped;
}
