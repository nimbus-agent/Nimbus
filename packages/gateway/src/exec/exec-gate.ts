import type { Database } from "bun:sqlite";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { NimbusCodeExecutionToml } from "../config/nimbus-toml.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import type { SandboxRunner } from "../platform/sandbox/sandbox-runner.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import type { ExecApprovalInput } from "./exec-consent-broker.ts";
import { buildExecPolicy, ExecPolicyError } from "./exec-policy.ts";
import type { ExecResult } from "./exec-result.ts";
import { runConfined } from "./exec-run.ts";
import {
  ExecRuntimeError,
  MAX_INLINE_CODE_UNITS,
  requireInstalled,
  resolveRuntimeById,
  resolveRuntimeForFile,
} from "./exec-runtimes.ts";

export class ExecGateError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ExecGateError";
  }
}

export interface RunExecutionRequest {
  readonly code?: string;
  readonly filePath?: string;
  readonly runtimeId?: string;
  readonly fsRead: readonly string[];
  readonly fsWrite: readonly string[];
  readonly network?: readonly string[];
  readonly timeoutMs?: number;
  readonly cwd: string;
}

export interface ExecGateDeps {
  readonly runner: SandboxRunner;
  readonly config: NimbusCodeExecutionToml;
  readonly enforced: Pick<EnforcedPolicy, "capabilitiesDisabled">;
  readonly requestApproval: (input: ExecApprovalInput) => Promise<boolean>;
  readonly db: Database;
  readonly readFile: (path: string) => string;
  readonly now: () => number;
  readonly newId: () => string;
}

export type ExecGateOutcome =
  | { readonly status: "ran"; readonly result: ExecResult }
  | { readonly status: "denied" }
  | { readonly status: "refused"; readonly code: string };

const CAPABILITY = "code_execution";

function digest(s: string): string {
  return bytesToHex(blake3(new TextEncoder().encode(s)));
}

/**
 * `audit_log.hitl_status` is CHECK-constrained to `approved` / `rejected` / `not_required`
 * (`index/schema-sql.ts`), so this capability's three real outcomes do not map one-to-one.
 *
 * Both a refusal-before-consent and an owner denial record `rejected`, with `outcome` in the
 * payload telling them apart. `not_required` is deliberately NOT used for a refusal even though no
 * consent was sought: every other caller uses it for actions that legitimately skip HITL (reindex,
 * retention, deploy annotation), so on a `code.execute` row it would read as "this ran without
 * needing approval" -- the single most dangerous thing an auditor could wrongly conclude here.
 */
type ExecOutcomeTag = "denied_by_owner" | "refused_before_consent" | "executed";

function audit(
  deps: ExecGateDeps,
  hitlStatus: "approved" | "rejected",
  outcome: ExecOutcomeTag,
  payload: Record<string, unknown>,
): void {
  appendAuditEntry(deps.db, {
    actionType: "code.execute",
    hitlStatus,
    actionJson: JSON.stringify({ outcome, ...payload }),
    timestamp: deps.now(),
  });
}

/**
 * The ONE path from user-supplied code to a running process (invariant I33, static rule D23).
 *
 * The ORDER is load-bearing. Every refusal that can be decided WITHOUT the owner happens before
 * the consent prompt, so a capability disabled by config or policy never advertises its own
 * existence by prompting; and the sandbox posture is asserted before consent too, so the owner is
 * never asked to approve something that could not have been confined anyway.
 */
export async function runExecution(
  req: RunExecutionRequest,
  deps: ExecGateDeps,
): Promise<ExecGateOutcome> {
  const executionId = deps.newId();

  try {
    // 1. Local kill-switch, then org policy. Both BEFORE consent.
    if (!deps.config.enabled) {
      throw new ExecGateError("ERR_EXEC_DISABLED", "code execution is disabled");
    }
    if (deps.enforced.capabilitiesDisabled.has(CAPABILITY)) {
      throw new ExecGateError("ERR_EXEC_POLICY_DISABLED", "disabled by org policy");
    }

    // 2. Resolve the runtime from the REGISTRY -- never a caller-supplied argv.
    const runtime =
      req.runtimeId !== undefined
        ? resolveRuntimeById(req.runtimeId)
        : req.filePath !== undefined
          ? resolveRuntimeForFile(req.filePath)
          : resolveRuntimeById("bun");
    if (!deps.config.allowedRuntimes.includes(runtime.id)) {
      throw new ExecGateError("ERR_EXEC_RUNTIME_NOT_ALLOWED", `runtime not allowed: ${runtime.id}`);
    }
    // Presence check only -- fails BEFORE consent so the owner is never asked to approve a run
    // that could not start. The command itself comes from argvFor() at step 7.
    requireInstalled(runtime);

    // 4. Read the script ONCE. The bytes shown to the owner are the bytes that execute; the file is
    // never re-read after approval, so a swap inside the consent window cannot change what runs.
    // Reading here also means a missing file fails before the human is ever prompted.
    const codeBody =
      req.code ??
      (req.filePath !== undefined
        ? deps.readFile(req.filePath)
        : (() => {
            throw new ExecGateError("ERR_EXEC_NO_CODE", "neither code nor filePath supplied");
          })());

    // 5. Bound the body. It travels as a command-line argument (see `argvFor`), so an oversized one
    // would be truncated by the Windows helper's buffer -- and running a PREFIX of someone's script
    // is far worse than refusing the whole of it. Refused before consent, like every other
    // caller-fixable error.
    if (codeBody.length > MAX_INLINE_CODE_UNITS) {
      throw new ExecGateError(
        "ERR_EXEC_CODE_TOO_LARGE",
        `code exceeds ${MAX_INLINE_CODE_UNITS} characters (${codeBody.length})`,
      );
    }

    const policy = buildExecPolicy(executionId, {
      // Two read sources: the caller's own grants, and the runtime's binary directory -- without
      // which the child cannot start at all. That second one is not an optimisation: on Windows the
      // AppContainer helper writes an ACE per granted path, so an ungranted interpreter is
      // unreadable and the child dies before executing a line (exit 68, no stdout, no stderr).
      // Linux hides this because bwrap binds the system tree by default.
      //
      // There is deliberately NO scratch-file grant: the body is passed inline, so no file exists.
      fsRead: [...req.fsRead, ...runtime.requiredReadPaths()],
      fsWrite: req.fsWrite,
      ...(req.network === undefined ? {} : { network: req.network }),
    });

    // 6. Confinement posture -- asserted AFTER the request has been validated, but BEFORE consent.
    //
    // Before-consent is the load-bearing half: the owner must never be asked to approve something
    // that could not have been confined anyway. After-validation is a deliberate ordering choice --
    // an argument error is the caller's to fix and is deterministic, whereas a degraded sandbox is
    // environmental, so reporting "your path was relative" beats reporting "the helper is missing"
    // on a machine where BOTH are true. Nothing above this line has an effect beyond a scratch file
    // the `finally` removes, so moving it here costs no safety.
    //
    // The predicate is `canConfine(policy)` -- "can you enforce THIS policy?" -- and deliberately
    // neither of the two obvious alternatives:
    //
    //   * `degradedReason() === null` is wrong on Windows, where it is non-null even when the
    //     runner is fully active (it reports the accepted per-host filtering caveat). Keying on it
    //     would refuse every Windows execution, forever.
    //   * `isFullyActive()` is wrong on Linux, where it reports the `nimbus-sandbox-helper` used
    //     ONLY for per-host network filtering. This slice grants no network, so `--unshare-net`
    //     plus bwrap's binds and seccomp confine it completely without that helper -- and CI
    //     installs bubblewrap but not the helper, so gating on it would make the capability
    //     unusable on Linux, including in CI, on a dependency it never uses.
    //
    // Asking the runner about the actual policy keeps that per-platform reasoning inside the PAL.
    const cannotConfine = deps.runner.canConfine(policy);
    if (cannotConfine !== null) {
      throw new ExecGateError(
        "ERR_EXEC_SANDBOX_DEGRADED",
        `refusing to execute unconfined: ${cannotConfine}`,
      );
    }

    const wallClockMs = Math.min(
      req.timeoutMs ?? deps.config.maxWallClockMs,
      deps.config.maxWallClockMs,
    );
    const grants = {
      fsRead: policy.permissions.filesystem.read,
      fsWrite: policy.permissions.filesystem.write,
      network: policy.permissions.network,
    };

    // 6. Owner consent on the exact body + the RESOLVED capability set.
    const approved = await deps.requestApproval({
      executionId,
      runtime: runtime.id,
      codeBody,
      grants,
      wallClockMs,
      cwd: req.cwd,
    });
    if (!approved) {
      audit(deps, "rejected", "denied_by_owner", {
        executionId,
        runtime: runtime.id,
        codeBody,
        grants,
      });
      return { status: "denied" };
    }

    // 7. Spawn. Both cmd and args come from the REGISTRY (never a caller-supplied argv, I33).
    const { cmd, args } = runtime.argvFor(codeBody);
    const result = await runConfined(deps.runner, cmd, args, {
      policy,
      cwd: req.cwd,
      maxOutputBytes: deps.config.maxOutputBytes,
      maxWallClockMs: wallClockMs,
      now: deps.now,
    });

    // Body in full, output hashed. The code is what was consented to; the output is unbounded prose
    // that would bloat every audit row.
    audit(deps, "approved", "executed", {
      executionId,
      runtime: runtime.id,
      codeBody,
      grants,
      exitCode: result.exitCode,
      stdoutDigest: digest(result.stdout),
      stderrDigest: digest(result.stderr),
      durationMs: result.durationMs,
      terminationReason: result.terminationReason,
      truncated: result.truncated,
    });
    return { status: "ran", result };
  } catch (e) {
    const code =
      e instanceof ExecGateError || e instanceof ExecPolicyError || e instanceof ExecRuntimeError
        ? e.code
        : "ERR_EXEC_FAILED";
    audit(deps, "rejected", "refused_before_consent", { executionId, code });
    return { status: "refused", code };
  }
  // No `finally` cleanup: the body is passed inline, so this gate writes no file anywhere. That is
  // the second benefit of the inline form -- there is nothing to leak on a denial, nothing to race
  // the spawn, and nothing another local user could read or swap between approval and execution.
}
