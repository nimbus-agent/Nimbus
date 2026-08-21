const PREFIX = "nimbus-ext-";

export interface ReapOpts {
  enumProfiles: () => Promise<string[]>;
  /** `true` when the profile is gone. A refusal returns `false`; it must not throw or abort. */
  deleteProfile: (name: string) => Promise<boolean>;
  liveExtensionIds: Set<string>;
}

/**
 * Delete the AppContainer profiles in the `nimbus-ext-` namespace whose extension is no longer
 * installed, and return the ones that were ACTUALLY deleted.
 *
 * The returned list is the caller's log line ("reaped orphaned AppContainers"), so an attempted
 * deletion must not appear in it: the sweep is best-effort by design, and reporting a refusal as
 * a cleanup makes the one leftover a reader would want to know about the one the log says is
 * gone. Failures are still skipped rather than fatal — the next profile is always attempted.
 */
export async function reapOrphanedAppContainers(opts: ReapOpts): Promise<string[]> {
  const profiles = await opts.enumProfiles();
  const reaped: string[] = [];
  for (const profile of profiles) {
    if (!profile.startsWith(PREFIX)) continue;
    const extId = profile.slice(PREFIX.length);
    if (opts.liveExtensionIds.has(extId)) continue;
    if (await opts.deleteProfile(profile)) reaped.push(profile);
  }
  return reaped;
}
