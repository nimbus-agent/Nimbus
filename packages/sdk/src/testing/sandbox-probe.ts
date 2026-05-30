/**
 * Sandbox probe binary — invoked by `runSandboxContractTests`.
 *
 * The probe is a tiny standalone program that the contract harness forks
 * (typically wrapped by the gateway's sandbox runner) to exercise one
 * specific capability and report the outcome via process exit code.
 *
 * Exit codes:
 *   0  — expected pass (network reach to a listed host succeeded)
 *   2  — unexpected outcome (test fails)
 *   10 — expected EACCES/EPERM on filesystem read (sandbox enforced)
 *   11 — expected ECONNREFUSED/EPERM/EHOSTUNREACH/ENETUNREACH on network
 *
 * Invocation:
 *   bun sandbox-probe.ts --probe=<name> --arg=<value>
 *
 * Probes:
 *   network-listed   — HEAD-fetch https://<arg>/ ; succeed if 2xx-4xx
 *   network-unlisted — fetch http://192.0.2.1 (TEST-NET-1); succeed if blocked
 *   fs-denied        — read a known-protected path; succeed if EACCES
 */

const probe = process.argv.find((a) => a.startsWith("--probe="))?.slice(8);
const arg = process.argv.find((a) => a.startsWith("--arg="))?.slice(6);

function errorCode(e: unknown): string | undefined {
  return (
    (e as { code?: string; cause?: { code?: string } }).code ??
    (e as { cause?: { code?: string } }).cause?.code
  );
}

async function probeNetworkListed(): Promise<number> {
  const url = `https://${arg ?? ""}/`;
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.status >= 200 && res.status < 500 ? 0 : 2;
  } catch {
    return 2;
  }
}

async function probeNetworkUnlisted(): Promise<number> {
  try {
    await fetch("http://192.0.2.1");
    return 2;
  } catch (e: unknown) {
    const code = errorCode(e);
    if (
      code === "ECONNREFUSED" ||
      code === "EPERM" ||
      code === "EHOSTUNREACH" ||
      code === "ENETUNREACH"
    ) {
      return 11;
    }
    return 2;
  }
}

async function probeFsDenied(): Promise<number> {
  const path =
    process.platform === "win32" ? String.raw`C:\Windows\System32\config\SAM` : "/etc/passwd";
  try {
    await Bun.file(path).text();
    return 2;
  } catch (e: unknown) {
    const code = (e as { code?: string }).code;
    if (code === "EACCES" || code === "EPERM" || code === "EBUSY") return 10;
    return 2;
  }
}

async function main(): Promise<void> {
  if (probe === "network-listed") process.exit(await probeNetworkListed());
  if (probe === "network-unlisted") process.exit(await probeNetworkUnlisted());
  if (probe === "fs-denied") process.exit(await probeFsDenied());
  process.exit(2);
}

export {};

await main();
