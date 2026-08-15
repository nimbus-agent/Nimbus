import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  clearFixture,
  FAKE_SOCKET_PATH,
  type RecordedClientConstruction,
  setFixture,
} from "../../test/helpers/cli-mocks.ts";

const { BATCH_RPC_TIMEOUT_MS, INTERACTIVE_RPC_TIMEOUT_MS, createIpcClient } = await import(
  "./rpc-timeouts.ts"
);

describe("createIpcClient", () => {
  let constructions: RecordedClientConstruction[];

  beforeEach(() => {
    constructions = [];
    setFixture({ clientConstructions: constructions });
  });

  afterEach(() => {
    clearFixture();
  });

  it("passes NO options object when no timeout is supplied, leaving the transport default", () => {
    createIpcClient(FAKE_SOCKET_PATH);
    expect(constructions).toHaveLength(1);
    expect(constructions[0]?.opts).toBeUndefined();
  });

  it("passes requestTimeoutMs through when one is supplied", () => {
    createIpcClient(FAKE_SOCKET_PATH, 1234);
    expect(constructions[0]?.opts).toEqual({ requestTimeoutMs: 1234 });
  });

  it("omits the key rather than passing it as undefined", () => {
    // `exactOptionalPropertyTypes` makes `{ requestTimeoutMs: undefined }` a type
    // error, but the runtime distinction matters independently: the transport reads
    // `opts?.requestTimeoutMs ?? DEFAULT`, so a present-but-undefined key would still
    // fall back — while any future strict read (`"requestTimeoutMs" in opts`) would
    // not. Pin the shape, not just the resolved value.
    createIpcClient(FAKE_SOCKET_PATH, undefined);
    expect(constructions[0]?.opts).toBeUndefined();
  });

  it("forwards the socket path unchanged", () => {
    createIpcClient(FAKE_SOCKET_PATH, BATCH_RPC_TIMEOUT_MS);
    expect(constructions[0]?.socketPath).toBe(FAKE_SOCKET_PATH);
  });
});

describe("timeout budgets", () => {
  // The whole point of these constants is to be materially longer than the 30s
  // transport default that was cutting off work in progress. Pin that relationship
  // rather than the literals, so a future tuning change stays honest but a
  // regression to a ~30s value fails.
  const TRANSPORT_DEFAULT_MS = 30_000;

  it("are both far longer than the transport's 30s default", () => {
    expect(INTERACTIVE_RPC_TIMEOUT_MS).toBeGreaterThan(TRANSPORT_DEFAULT_MS * 10);
    expect(BATCH_RPC_TIMEOUT_MS).toBeGreaterThan(TRANSPORT_DEFAULT_MS * 10);
  });

  it("give machine-bound work a larger budget than human-bound work", () => {
    // Batch work is bounded by the user's data volume, which the CLI cannot predict;
    // an interactive run is bounded by a person's attention span. If these ever
    // invert, the rationale in the module docblock has stopped matching the values.
    expect(BATCH_RPC_TIMEOUT_MS).toBeGreaterThan(INTERACTIVE_RPC_TIMEOUT_MS);
  });

  it("stay finite — `0` would disable the timer and restore the hang-forever bug", () => {
    // The transport documents `0` as "disables the timeout (a wedged gateway then
    // hangs the call forever)". A dead socket is covered by `failAll`; an alive-but-
    // silent gateway is covered only by these timers, so neither may be 0.
    expect(BATCH_RPC_TIMEOUT_MS).toBeGreaterThan(0);
    expect(INTERACTIVE_RPC_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(BATCH_RPC_TIMEOUT_MS)).toBe(true);
    expect(Number.isFinite(INTERACTIVE_RPC_TIMEOUT_MS)).toBe(true);
  });
});
