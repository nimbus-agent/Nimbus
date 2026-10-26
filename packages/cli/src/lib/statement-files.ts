/**
 * `--statement <file>` for the CLI's registry writers (`extension publish`, `registry maintain add`):
 * read each publisher-signed trust statement file and admit them into an index with the SAME
 * `admitPublisherStatements` the registry action's `check` and `sign` run. Unlike `sign`, which skips
 * what it cannot admit, these interactive commands refuse: a statement the registry would drop is a
 * mistake the publisher should see now.
 */
import { readFileSync } from "node:fs";
import {
  admitPublisherStatements,
  type StatementAdmission,
  type StatementIndex,
} from "@nimbus-dev/registry-format";

/** The parsed JSON of each file, in order. Throws an `Error` naming the file that cannot be read. */
export function readStatementArgs(paths: readonly string[]): unknown[] {
  return paths.map((path) => {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      throw new Error(
        `could not read statement file ${path}: ${(e as NodeJS.ErrnoException).code ?? "error"}`,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`statement file ${path} is not valid JSON`);
    }
  });
}

/**
 * Admit `values` into `index`; every statement must be admitted or already present. Throws an
 * `Error` listing each refusal otherwise.
 */
export function admitAllStatements<T extends StatementIndex>(
  index: T,
  values: readonly unknown[],
): StatementAdmission<T> {
  const admission = admitPublisherStatements(index, values);
  if (admission.skipped.length > 0) {
    const reasons = admission.skipped.map((s) =>
      s.id === undefined ? s.reason : `${s.id.slice(0, 12)}: ${s.reason}`,
    );
    throw new Error(`the registry would not admit these statements: ${reasons.join("; ")}`);
  }
  return admission;
}
