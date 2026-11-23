import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import type { Logger } from "pino";
import { deleteExtensionById } from "../../automation/extension-store.ts";
import { FORMAT_INVISIBLE_RANGES, rangesRegExp } from "../../util/invisible-text.ts";
import { clearDeps } from "../dependency-store.ts";
import type { CreatedPackage, RollbackFailure } from "./types.ts";

/** The rollback failures a plan install attached to the error it threw; empty when it attached none. */
export function rollbackFailuresOf(e: unknown): readonly RollbackFailure[] {
  if (typeof e !== "object" || e === null || !("rollbackFailures" in e)) return [];
  const failures: unknown = e.rollbackFailures;
  return Array.isArray(failures) ? (failures as RollbackFailure[]) : [];
}

/** C0 controls plus every invisible or bidi format character (`FORMAT_INVISIBLE_RANGES`, which covers DEL and C1). */
const NOTE_UNSAFE_RE = rangesRegExp([[0x0000, 0x001f], ...FORMAT_INVISIBLE_RANGES]);

/**
 * The rollback-incomplete note an install refusal carries to the owner: ` (rollback incomplete:
 * <path or id>, …)` naming what is left behind — the directory a failed `removeDirectory` left, else
 * the id whose row or edges remain — each once, control and invisible format characters stripped
 * (a path is owner-visible text, so a bidi override must not reorder it); `""` when the error
 * carries no rollback failure.
 */
export function rollbackIncompleteNote(e: unknown): string {
  const detail = rollbackIncompleteDetail(e);
  return detail === "" ? "" : ` (${detail})`;
}

/** The note without its leading space and parentheses, `rollback incomplete: <path or id>, …`; `""` when complete. */
export function rollbackIncompleteDetail(e: unknown): string {
  const failures = rollbackFailuresOf(e);
  if (failures.length === 0) return "";
  const left = failures.map((f) =>
    (f.step === "removeDirectory" ? f.dir : (f.id ?? f.dir)).replace(NOTE_UNSAFE_RE, ""),
  );
  return `rollback incomplete: ${[...new Set(left)].join(", ")}`;
}

/**
 * Where an install refusal is caught for the owner (an RPC result): a rollback that itself failed
 * is logged as a warning with every failed step, and the returned note (see
 * {@link rollbackIncompleteNote}) is appended to the message the owner sees. `""` (and no log)
 * when the rollback was complete.
 */
export function reportIncompleteRollback(
  logger: Pick<Logger, "warn">,
  installing: string,
  e: unknown,
): string {
  const note = rollbackIncompleteNote(e);
  if (note !== "") {
    logger.warn(
      {
        installing,
        rollbackFailures: rollbackFailuresOf(e).map((f) => ({
          step: f.step,
          id: f.id,
          dir: f.dir,
          error: f.error instanceof Error ? f.error.message : String(f.error),
        })),
      },
      "extension install refused, and its rollback left packages behind",
    );
  }
  return note;
}

/**
 * Undoes every package this plan created, newest first: its edges, its row (with any run grant,
 * `deleteExtensionById`) and its directory. Packages present before the plan are never touched;
 * audit and egress rows stay. Each step runs on its own, so one failing step never skips the
 * others, and every failure is RETURNED for the caller to report, never swallowed.
 */
export function rollbackCreatedPackages(
  db: Database,
  created: readonly CreatedPackage[],
): RollbackFailure[] {
  const failures: RollbackFailure[] = [];
  const attempt = (step: RollbackFailure["step"], pkg: CreatedPackage, run: () => void): void => {
    try {
      run();
    } catch (error) {
      failures.push({ step, id: pkg.id, dir: pkg.dir, error });
    }
  };
  for (const pkg of [...created].reverse()) {
    const id = pkg.id;
    if (id !== null) {
      attempt("clearDeps", pkg, () => clearDeps(db, id));
      attempt("deleteExtension", pkg, () => deleteExtensionById(db, id));
    }
    attempt("removeDirectory", pkg, () => rmSync(pkg.dir, { recursive: true, force: true }));
  }
  return failures;
}

/**
 * The ORIGINAL install failure, still the primary error (same class, code and message), carrying
 * any rollback step that failed: as `rollbackFailures`, and as its `cause` when it has none yet.
 */
export function withRollbackFailures(e: unknown, failures: readonly RollbackFailure[]): unknown {
  if (failures.length === 0 || !(e instanceof Error)) return e;
  Object.assign(e, { rollbackFailures: failures });
  if (e.cause === undefined) {
    const steps = failures.map((f) => `${f.step} ${f.id ?? f.dir}`).join(", ");
    e.cause = new AggregateError(
      failures.map((f) => f.error),
      `rollback incomplete: ${steps}`,
    );
  }
  return e;
}
