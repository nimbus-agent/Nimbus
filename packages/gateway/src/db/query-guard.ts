import { QUERY_GUARD_WORKER_PATH } from "../workers/embedded-workers.ts";

const FORBIDDEN =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|ATTACH|DETACH|REPLACE|CREATE|TRUNCATE|VACUUM)\b/i;

const ALLOWED_PRAGMA = new Set([
  "query_only",
  "table_info",
  "foreign_key_list",
  "index_list",
  "index_info",
  "function_list",
  "module_list",
  "collation_list",
  "database_list",
  "compile_options",
]);

const PRAGMA_RE = /\bPRAGMA\s+(\w+)/gi;

const DEFAULT_TIMEOUT_MS = 30_000;

export class SqlGuardError extends Error {
  override readonly name = "SqlGuardError";
}

export function assertReadOnlySelectSql(sql: string): void {
  const trimmed = sql.trim();
  if (trimmed === "") {
    throw new SqlGuardError("SQL statement is empty");
  }
  if (!/^\s*SELECT\b/i.test(trimmed) && !/^\s*WITH\b/i.test(trimmed)) {
    throw new SqlGuardError("Only SELECT (or WITH … SELECT) statements are allowed");
  }
  if (FORBIDDEN.test(trimmed)) {
    throw new SqlGuardError("Statement contains a forbidden keyword");
  }
  PRAGMA_RE.lastIndex = 0;
  while (true) {
    const match = PRAGMA_RE.exec(trimmed);
    if (match === null) break;
    const name = (match[1] ?? "").toLowerCase();
    if (!ALLOWED_PRAGMA.has(name)) {
      throw new SqlGuardError(`Disallowed PRAGMA in statement: ${name}`);
    }
  }
}

export async function runReadOnlySelect(
  dbPath: string,
  sql: string,
  options?: { timeoutMs?: number },
): Promise<Record<string, unknown>[]> {
  assertReadOnlySelectSql(sql);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // The path comes from `workers/embedded-workers.ts`, never from `new URL(..., import.meta.url)`:
  // that form resolves at runtime, so the bundler never sees the worker and `--compile` ships a
  // binary where this call throws `ModuleNotFound resolving "B:\~BUN\root\query-guard-worker.ts"`.
  // `nimbus query --sql` was dead in every packaged release for exactly that reason (F22).
  const worker = new Worker(QUERY_GUARD_WORKER_PATH);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      timer = setTimeout(() => {
        worker.terminate();
        reject(new SqlGuardError(`SQL query exceeded ${timeoutMs}ms timeout — aborted`));
      }, timeoutMs);
      worker.onmessage = (e: MessageEvent<unknown>): void => {
        const msg = e.data as {
          ok: boolean;
          rows?: Record<string, unknown>[];
          message?: string;
        };
        if (msg.ok) {
          resolve(msg.rows ?? []);
        } else {
          reject(new Error(msg.message ?? "worker query failed"));
        }
      };
      worker.onerror = (ev): void => {
        reject(new Error(ev.message));
      };
      worker.postMessage({ dbPath, sql });
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    worker.terminate();
  }
}
