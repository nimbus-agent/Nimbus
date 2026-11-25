/**
 * The shared tail of a read-only CLI command that makes one gateway call: under `--json` the reply
 * (or the error) is printed as one JSON line and the exit code follows the reply's `status`; without
 * it the reply is rendered, and an error is one line on stderr after `clean` strips it.
 */

export interface StatusCallSink {
  out(s: string): void;
  err(s: string): void;
}

/** A failed gateway call: `{ error }` on stdout under `--json`, else one cleaned line on stderr. Exit 1. */
export function reportCallFailure(
  e: unknown,
  json: boolean,
  sink: StatusCallSink,
  clean: (s: string) => string,
): number {
  const msg = e instanceof Error ? e.message : String(e);
  if (json) sink.out(`${JSON.stringify({ error: msg })}\n`);
  else sink.err(`${clean(msg)}\n`);
  return 1;
}

export interface StatusCallOptions<R extends { readonly status: string }> {
  readonly json: boolean;
  readonly sink: StatusCallSink;
  readonly clean: (s: string) => string;
  /** The statuses that exit 0 under `--json`; every other status exits 1. */
  readonly okStatuses: readonly string[];
  readonly call: () => Promise<R>;
  /** The terminal rendering; its return value is the exit code. */
  readonly render: (r: R) => number;
}

export async function runStatusCall<R extends { readonly status: string }>(
  o: StatusCallOptions<R>,
): Promise<number> {
  try {
    const r = await o.call();
    if (o.json) {
      o.sink.out(`${JSON.stringify(r)}\n`);
      return o.okStatuses.includes(r.status) ? 0 : 1;
    }
    return o.render(r);
  } catch (e) {
    return reportCallFailure(e, o.json, o.sink, o.clean);
  }
}
