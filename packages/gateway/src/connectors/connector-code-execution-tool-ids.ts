import { matchesBareOrNamespacedToolId } from "./namespaced-tool-id.ts";

/**
 * Connector tools a federated peer could use to run CALLER-DIRECTED CODE on the machine executing
 * them (I26). Two distinct mechanisms put a tool in this class; both end the same way at the gate —
 * `federation/invoke-gate.ts` refuses the id before the grant is read, fail-closed and opaque — so
 * they share one predicate, but their reasons are documented apart because they do not generalise to
 * each other.
 *
 * (1) DIRECTORY EVALUATION. The tool takes a caller-supplied `workingDirectory` and hands it to a
 * program that EVALUATES the code it finds there. Planning a Terraform configuration loads it and
 * runs its provider plugins and any `external` data source program; a Pulumi preview runs the stack
 * program itself. So `iac_terraform_plan` and `iac_pulumi_preview` — registered as READS, because
 * they change no infrastructure — still let whoever names the directory decide what code runs. The
 * three iac WRITES that evaluate the same caller-named directory are listed too (the write predicate
 * refuses them first, so the gate audits them `write_forbidden`; naming them here keeps the
 * code-execution classification true on its own, whatever happens to the write list).
 *
 * (2) WINDOWS `.cmd`-WRAPPER ARGUMENT INJECTION. A read whose caller-supplied value reaches the argv
 * of a CLI that installs as a `.cmd` / batch wrapper on Windows — `az` (Azure CLI) and `gcloud`
 * (Google Cloud SDK) both do. Spawning the bare name resolves it through `PATHEXT` to `az.cmd` and
 * runs it through `cmd.exe`, which RE-PARSES the reconstructed command line: a value carrying `cmd`
 * metacharacters (`"`, `&`, `|`, `%`) escapes its argument slot and runs an arbitrary
 * command. `shared/safe-cli-arg.ts`'s `isSafeCliArg` rejects only a leading `-` and control
 * characters, not those metacharacters, so neither a flag VALUE nor an `isSafeCliArg`-guarded
 * positional is safe on Windows. These reads were long treated as "the caller picks a RESOURCE but
 * never the code"; that reasoning is POSIX-only. Every read of the `az`- and `gcloud`-backed
 * connectors (`azure`, `gcp`, `cloud-logging`, `vertex-ai`) that can carry a caller value into the
 * CLI is refused at the federated door — at connector-read granularity, so a later argv change
 * inside one of them cannot silently reopen the vector. (`bigquery` is `gcloud`-backed too, but its
 * only spawn is `gcloud auth print-access-token` with no caller input and its tools are REST, so no
 * caller value ever reaches a CLI argv; its reads stay reviewed.)
 *
 * NOT in the class, as reviewed in `connector-code-execution-sync.test.ts`: a read backed by `aws`
 * or `kubectl`, which install as native `.exe` on Windows — no `cmd.exe` re-parse occurs — whose
 * caller values ride flag-value slots or `isSafeCliArg`-guarded positionals; and remote execution (a
 * Lambda invoke, a CloudFormation deploy, a CI trigger), which runs on a cloud's machines, not this
 * one. The mutating tools among those are writes, already refused under I26 by
 * `isConnectorWriteToolId`. The `aws` / `kubectl` classification rests on those CLIs being native
 * executables; see that guard's review and SECURITY-INVARIANTS.md I26 for the stated residual.
 *
 * Kept honest by `connector-code-execution-sync.test.ts`, which reads the INSTALLED connectors
 * package: every id here must still be registered by a connector that can start a process, and every
 * tool such a connector registers must be refused here, refused as a write, or reviewed.
 */

/** (1) Reads and writes that evaluate the code under a caller-named directory (iac). */
export const DIRECTORY_EVALUATION_TOOL_IDS: ReadonlySet<string> = new Set([
  // Reads that evaluate the caller-named directory.
  "iac_terraform_plan",
  "iac_pulumi_preview",
  // Writes that evaluate it too — also refused by the I26 write predicate, which runs first.
  "iac_terraform_apply",
  "iac_terraform_destroy",
  "iac_pulumi_up",
]);

/**
 * (2) Reads whose caller value reaches an `az` / `gcloud` argv — a `.cmd` / batch wrapper on Windows
 * that re-parses its command line. Refused at connector-read granularity (every read of these four
 * connectors), so an argv change inside one cannot silently reopen the vector.
 */
export const WINDOWS_CLI_ARG_INJECTION_TOOL_IDS: ReadonlySet<string> = new Set([
  "azure_app_service_list", // az
  "gcp_cloud_run_service_list", // gcloud
  "cloud_logging_get", // gcloud
  "cloud_logging_list", // gcloud
  "cloud_logging_search", // gcloud
  "vertex_ai_get", // gcloud
  "vertex_ai_list", // gcloud
  "vertex_ai_search", // gcloud
]);

/**
 * The full set a federated peer is refused: the union of the two mechanisms above. One predicate and
 * one `code_execution_forbidden` audit decision cover both.
 */
export const CONNECTOR_CODE_EXECUTION_TOOL_IDS: ReadonlySet<string> = new Set([
  ...DIRECTORY_EVALUATION_TOOL_IDS,
  ...WINDOWS_CLI_ARG_INJECTION_TOOL_IDS,
]);

/** The longest listed id: no suffix longer than this can name one. */
const LONGEST_CODE_EXECUTION_TOOL_ID = Math.max(
  ...[...CONNECTOR_CODE_EXECUTION_TOOL_IDS].map((id) => id.length),
);

/**
 * I26: true for any connector tool that could run caller-directed code on the anchor — bare, or in
 * the `<server>_<tool>` form a federated session executes (`iac_iac_terraform_plan`,
 * `azure_azure_app_service_list`), matched exactly as `isConnectorWriteToolId` matches a write
 * (`matchesBareOrNamespacedToolId`). The federated peer invoke gate rejects these fail-closed; the
 * local owner's own paths do not consult it.
 */
export function isConnectorCodeExecutionToolId(toolId: string): boolean {
  return matchesBareOrNamespacedToolId(
    toolId,
    (id) => CONNECTOR_CODE_EXECUTION_TOOL_IDS.has(id),
    LONGEST_CODE_EXECUTION_TOOL_ID,
  );
}
