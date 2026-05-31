export const DEFAULT_CONNECTIVITY_PROBE_HOST = "one.one.one.one";

export async function isOnline(
  probeHost: string = DEFAULT_CONNECTIVITY_PROBE_HOST,
): Promise<boolean> {
  try {
    await Bun.dns.lookup(probeHost);
    return true;
  } catch {
    return false;
  }
}
