import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const answers: Record<string, { data: unknown; error: string | null }> = {};
vi.mock("../../src/hooks/useIpcQuery", () => ({
  useIpcQuery: (method: string) => ({
    ...(answers[method] ?? { data: null, error: null }),
    isLoading: false,
    refetch: () => undefined,
  }),
}));

import { useRolePacks } from "../../src/hooks/useRolePacks";
import { RolePacksProvider } from "../../src/providers/RolePacksProvider";

function Probe() {
  const s = useRolePacks();
  return (
    <div>
      <span data-testid="loaded">{String(s.loaded)}</span>
      <span data-testid="packError">{s.packError ?? "-"}</span>
      <span data-testid="catalogError">{s.catalogError ?? "-"}</span>
      <span data-testid="packs">{s.packs === null ? "null" : "set"}</span>
      <span data-testid="catalog">{s.catalog === null ? "null" : "set"}</span>
    </div>
  );
}

function mount() {
  render(
    <RolePacksProvider>
      <Probe />
    </RolePacksProvider>,
  );
}
const text = (id: string) => screen.getByTestId(id).textContent;

describe("RolePacksProvider", () => {
  beforeEach(() => {
    for (const k of Object.keys(answers)) delete answers[k];
  });

  it("is not loaded until both answers have the expected shape", () => {
    answers["pack.list"] = { data: { installed: [], skipped: [] }, error: null };
    mount();
    expect(text("loaded")).toBe("false");
    expect(text("packs")).toBe("set");
    expect(text("catalog")).toBe("null");
  });

  it("is loaded when both answers are usable", () => {
    answers["pack.list"] = { data: { installed: [], skipped: [], available: [] }, error: null };
    answers["catalog.list"] = { data: { agents: [], connectors: [] }, error: null };
    mount();
    expect(text("loaded")).toBe("true");
  });

  it("treats a malformed answer as nothing usable yet", () => {
    answers["pack.list"] = { data: { installed: "x", skipped: [] }, error: null };
    answers["catalog.list"] = { data: [1, 2], error: null };
    mount();
    expect(text("packs")).toBe("null");
    expect(text("catalog")).toBe("null");
    expect(text("loaded")).toBe("false");
  });

  it("surfaces the query errors, and the pack's own listError when the query is clean", () => {
    answers["pack.list"] = { data: null, error: "pack boom" };
    answers["catalog.list"] = { data: null, error: "catalog boom" };
    mount();
    expect(text("packError")).toBe("pack boom");
    expect(text("catalogError")).toBe("catalog boom");
  });

  it("falls back to listError carried in a clean pack.list answer", () => {
    answers["pack.list"] = {
      data: { installed: [], skipped: [], listError: "could not read packs" },
      error: null,
    };
    mount();
    expect(text("packError")).toBe("could not read packs");
  });
});
