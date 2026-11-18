/**
 * Owner-authored runbooks (Phase 10 IC6, incident-engine spec § 5.6, invariant I57 (c)): the parsed and
 * validated shape `runbook-loader.ts` produces from `<configDir>/runbooks/*.toml`. Nothing here is read from
 * a provider, a pack, an extension or the network.
 */

/** A parameter value as a runbook declares it: plain data only. Strings may hold typed placeholders. */
export type RunbookParam =
  | string
  | number
  | boolean
  | readonly RunbookParam[]
  | { readonly [key: string]: RunbookParam };

export type RunbookParams = { readonly [key: string]: RunbookParam };

export type RunbookStep =
  | { readonly kind: "check"; readonly text: string }
  | {
      readonly kind: "read";
      /** The connector (mesh server) the read runs on. */
      readonly service: string;
      /** The read tool's id as the connector lists it. */
      readonly tool: string;
      readonly params: RunbookParams;
    }
  | {
      readonly kind: "action";
      /** A connector write row's tool id (`connectors/connector-writes/`). */
      readonly tool: string;
      readonly params: RunbookParams;
    };

export type RunbookMatch = {
  /** Bound service ids; empty means any service (a bound record is still required by `{service}`). */
  readonly services: readonly string[];
  /** Trigger sources (`pagerduty`, `jira`, `sentry`, ...); empty means any. */
  readonly sources: readonly string[];
  /** An owner regex over the record's capped trigger title; null means any. */
  readonly title: string | null;
};

export type Runbook = {
  readonly name: string;
  readonly description: string | null;
  /** The file it was loaded from (base name only). */
  readonly file: string;
  /** SHA-256 (hex) of the file's bytes: the step state is kept per hash. */
  readonly sha256: string;
  readonly match: RunbookMatch;
  readonly steps: readonly RunbookStep[];
};

/** A file the loader refused, by name, with the reason; the other runbooks still load. */
export type RunbookLoadError = { readonly file: string; readonly reason: string };

export type RunbookLoadResult = {
  readonly runbooks: readonly Runbook[];
  readonly errors: readonly RunbookLoadError[];
};
