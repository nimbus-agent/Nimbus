// Fake gh / aws / kubectl / gcloud for local-auth.e2e.test.ts. Selected by the wrapper that
// invokes it.
import { appendFileSync } from "node:fs";

const as = process.argv[2] ?? "";
const args = process.argv.slice(3);
const log = process.env["NIMBUS_SHIM_LOG"];
if (log !== undefined) appendFileSync(log, `${JSON.stringify([as, ...args])}\n`);

const cmd = args.join(" ");
const answers: Record<string, string> = {
  "aws configure list-profiles": "default\ndev\n",
  "aws configure get region --profile dev": "eu-west-1\n",
  "kubectl config get-contexts -o name": "kind-a\n",
  "kubectl config current-context": "kind-a\n",
  // No default project on purpose: `detectGcloud` reports `needs_project` for this account, the
  // one status besides `available` that `resolveTarget` (adopt-local-auth.ts) still offers —
  // exercising the same "supply a project at adopt time" path the unit tests cover.
  "gcloud config list --format json": `${JSON.stringify({ core: { account: "me@example.com" } })}\n`,
};
const key = `${as} ${cmd}`;
if (key in answers) {
  process.stdout.write(answers[key] ?? "");
  process.exit(0);
}
if (as === "gh" && cmd.startsWith("auth token")) {
  process.stdout.write("nimbus_SENTINEL_e2etest_token_0123\n");
  process.exit(0);
}
process.stderr.write(`shim: unexpected ${key}\n`);
process.exit(2);
