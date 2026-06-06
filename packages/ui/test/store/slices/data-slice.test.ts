import { beforeEach, describe, expect, it } from "vitest";
import { createDataSlice, type DataSlice } from "../../../src/store/slices/data";

function makeSlice(): DataSlice {
  const storeLike: { current: Partial<DataSlice> } = { current: {} };
  const set = (partial: Partial<DataSlice> | ((s: DataSlice) => Partial<DataSlice>)) => {
    const patch = typeof partial === "function" ? partial(storeLike.current as DataSlice) : partial;
    Object.assign(storeLike.current, patch);
  };
  const get = () => storeLike.current as DataSlice;
  const api = {
    setState: set,
    getState: get,
    subscribe: () => () => {},
    destroy: () => {},
  } as never;
  const slice = createDataSlice(set, get as never, api);
  Object.assign(storeLike.current, slice);
  return storeLike.current as DataSlice;
}

describe("data slice — initial state", () => {
  it("starts with all three flows idle and no preflight cache", () => {
    const s = makeSlice();
    expect(s.exportFlow.status).toBe("idle");
    expect(s.importFlow.status).toBe("idle");
    expect(s.deleteFlow.status).toBe("idle");
    expect(s.lastExportPreflight).toBeNull();
  });
});

describe("data slice — flow transitions", () => {
  let s: DataSlice;
  beforeEach(() => {
    s = makeSlice();
  });

  it("setExportFlow patches a subset of the running state", () => {
    s.setExportFlow({ status: "running" });
    expect(s.exportFlow.status).toBe("running");
    s.setExportFlow({ status: "error", errorKind: "rpc_failed", errorMessage: "boom" });
    expect(s.exportFlow.status).toBe("error");
    expect(s.exportFlow.errorKind).toBe("rpc_failed");
    expect(s.exportFlow.errorMessage).toBe("boom");
  });

  it("setExportProgress upserts the progress field without dropping status", () => {
    s.setExportFlow({ status: "running" });
    s.setExportProgress({ stage: "packing", bytesWritten: 128, totalBytes: 1024 });
    expect(s.exportFlow.status).toBe("running");
    expect(s.exportFlow.progress).toEqual({
      stage: "packing",
      bytesWritten: 128,
      totalBytes: 1024,
    });
  });

  it("setImportFlow + setImportProgress behave symmetrically", () => {
    s.setImportFlow({ status: "running" });
    s.setImportProgress({ stage: "unpacking", bytesRead: 64 });
    expect(s.importFlow.status).toBe("running");
    expect(s.importFlow.progress).toEqual({ stage: "unpacking", bytesRead: 64 });
  });

  it("setDeleteFlow tracks service across transitions", () => {
    s.setDeleteFlow({ status: "running", service: "github" });
    expect(s.deleteFlow.status).toBe("running");
    expect(s.deleteFlow.service).toBe("github");
  });
});

describe("data slice — preflight cache", () => {
  it("setLastExportPreflight stores and clears", () => {
    const s = makeSlice();
    s.setLastExportPreflight({ lastExportAt: 1000, estimatedSizeBytes: 2048, itemCount: 42 });
    expect(s.lastExportPreflight?.itemCount).toBe(42);
    s.setLastExportPreflight(null);
    expect(s.lastExportPreflight).toBeNull();
  });
});

describe("data slice — markDisconnected", () => {
  it("transitions a running export flow to error with kind=gateway_disconnected", () => {
    const s = makeSlice();
    s.setExportFlow({ status: "running" });
    s.setExportProgress({ stage: "packing", bytesWritten: 64, totalBytes: 512 });
    s.markDisconnected();
    expect(s.exportFlow.status).toBe("error");
    expect(s.exportFlow.errorKind).toBe("gateway_disconnected");
    expect(s.exportFlow.progress).toBeNull();
  });

  it("transitions a running import flow to error with kind=gateway_disconnected", () => {
    const s = makeSlice();
    s.setImportFlow({ status: "running" });
    s.setImportProgress({ stage: "unpacking", bytesRead: 32 });
    s.markDisconnected();
    expect(s.importFlow.status).toBe("error");
    expect(s.importFlow.errorKind).toBe("gateway_disconnected");
    expect(s.importFlow.progress).toBeNull();
  });

  it("leaves idle flows untouched", () => {
    const s = makeSlice();
    s.setExportFlow({ status: "running" });
    s.markDisconnected();
    expect(s.importFlow.status).toBe("idle");
    expect(s.deleteFlow.status).toBe("idle");
  });

  it("preserves service label on deleteFlow when transitioning", () => {
    const s = makeSlice();
    s.setDeleteFlow({ status: "running", service: "linear" });
    s.markDisconnected();
    expect(s.deleteFlow.status).toBe("error");
    expect(s.deleteFlow.errorKind).toBe("gateway_disconnected");
    expect(s.deleteFlow.service).toBe("linear");
  });

  it("is a no-op when nothing is running", () => {
    const s = makeSlice();
    s.markDisconnected();
    expect(s.exportFlow.status).toBe("idle");
    expect(s.importFlow.status).toBe("idle");
    expect(s.deleteFlow.status).toBe("idle");
  });
});

describe("data slice — resetDataTransients", () => {
  it("wipes all three flows and the preflight cache", () => {
    const s = makeSlice();
    s.setExportFlow({ status: "running" });
    s.setImportFlow({ status: "error", errorKind: "rpc_failed" });
    s.setDeleteFlow({ status: "running", service: "github" });
    s.setLastExportPreflight({ lastExportAt: 1, estimatedSizeBytes: 1, itemCount: 1 });
    s.resetDataTransients();
    expect(s.exportFlow.status).toBe("idle");
    expect(s.importFlow.status).toBe("idle");
    expect(s.deleteFlow.status).toBe("idle");
    expect(s.lastExportPreflight).toBeNull();
  });
});
