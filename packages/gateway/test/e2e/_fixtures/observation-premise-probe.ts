// Run in a CHILD process by extension-observation.e2e.test.ts: `platform/sandbox/linux.ts` reads
// NIMBUS_SANDBOX_HELPER_PATH once, when the module loads, and the e2e tree shares one test process,
// so a probe in that process would see whatever an earlier file loaded. Prints one line: the reason
// this runner cannot confine the extension's network policy in per-host mode, or "OK".
import { decideNetworkMode } from "../../../src/platform/sandbox/linux.ts";
import { createSandboxRunner } from "../../../src/platform/sandbox/sandbox-runner.ts";

const declared = process.argv[2] ?? "";
const policy = {
  id: "extension-observation-e2e-probe",
  permissions: { network: [declared], filesystem: { read: [], write: [] } },
};

async function problem(): Promise<string | null> {
  // Per-host is the only mode that observes; the fallback with no helper reports nothing.
  const mode = decideNetworkMode(policy, { helperAvailable: true });
  if (mode !== "per-host") return `network mode is ${String(mode)}, not per-host`;
  // The production factory, which runs the forwarder's start probe as the gateway's does.
  const refusal = (await createSandboxRunner()).canConfine(policy);
  return refusal === null ? null : `canConfine refused: ${refusal}`;
}

try {
  process.stdout.write(`${(await problem()) ?? "OK"}\n`);
} catch (e) {
  process.stdout.write(`probe threw: ${e instanceof Error ? e.message : String(e)}\n`);
}
