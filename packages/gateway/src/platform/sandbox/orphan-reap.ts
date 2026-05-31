const PREFIX = "nimbus-ext-";

export interface ReapOpts {
  enumProfiles: () => Promise<string[]>;
  deleteProfile: (name: string) => Promise<void>;
  liveExtensionIds: Set<string>;
}

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
