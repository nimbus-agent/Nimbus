import { describe, expect, test } from "bun:test";
import { makeRouteId, parseRouteRef } from "./route-id.ts";

describe("makeRouteId", () => {
  test("joins provider and model on a slash", () => {
    expect(makeRouteId("ollama", "qwen3:8b")).toBe("ollama/qwen3:8b");
  });

  test("rejects a providerId containing a slash", () => {
    // The delimiter is only unambiguous because the LEFT side cannot contain it.
    expect(() => makeRouteId("bad/vendor", "m")).toThrow(/providerId/);
  });
});

describe("parseRouteRef", () => {
  test("splits on the FIRST slash, leaving the rest to the model name", () => {
    expect(parseRouteRef("ollama/hf.co/user/model")).toEqual({
      providerId: "ollama",
      modelName: "hf.co/user/model",
    });
  });

  test("keeps a Windows path intact as a model name", () => {
    expect(parseRouteRef("llamacpp/C:\\models\\Llama-3-8B.gguf")).toEqual({
      providerId: "llamacpp",
      modelName: "C:\\models\\Llama-3-8B.gguf",
    });
  });

  test("keeps a POSIX path intact as a model name", () => {
    expect(parseRouteRef("llamacpp//models/meta-llama/Llama-3-8B.gguf")).toEqual({
      providerId: "llamacpp",
      modelName: "/models/meta-llama/Llama-3-8B.gguf",
    });
  });

  test("throws on a ref with no slash", () => {
    expect(() => parseRouteRef("ollama")).toThrow(/expected "<provider>\/<model>"/);
  });

  test("throws on an empty provider or model half", () => {
    expect(() => parseRouteRef("/qwen3")).toThrow(/provider/);
    expect(() => parseRouteRef("ollama/")).toThrow(/model/);
  });

  test("round-trips a model name containing slashes", () => {
    const id = makeRouteId("ollama", "hf.co/user/model");
    expect(parseRouteRef(id)).toEqual({ providerId: "ollama", modelName: "hf.co/user/model" });
  });
});
