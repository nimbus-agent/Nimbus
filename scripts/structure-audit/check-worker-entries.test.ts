import { describe, expect, it } from "bun:test";

import { exportedWorkerPathNames, findWorkerViolations } from "./check-worker-entries.ts";

const ALLOWED = ["EMBEDDING_WORKER_PATH", "QUERY_GUARD_WORKER_PATH"];

describe("exportedWorkerPathNames", () => {
  it("reads the allowed names out of embedded-workers.ts rather than restating them", () => {
    const src = [
      'import a from "../../dist/workers/embedding-worker.js" with { type: "file" };',
      "export const EMBEDDING_WORKER_PATH: string = a;",
      "export const QUERY_GUARD_WORKER_PATH: string = b;",
    ].join("\n");
    expect(exportedWorkerPathNames(src)).toEqual(ALLOWED);
  });

  // The guard's own fail-closed direction: an empty allow-list must not silently permit
  // everything. `main()` exits 1 on this rather than scanning with nothing to match.
  it("returns nothing when the module exports no worker paths", () => {
    expect(exportedWorkerPathNames("export const NOT_A_PATH = 1;")).toEqual([]);
  });
});

describe("findWorkerViolations", () => {
  it("accepts a spawn from an allowed export", () => {
    const files = [{ path: "a.ts", source: "const w = new Worker(EMBEDDING_WORKER_PATH);" }];
    expect(findWorkerViolations(files, ALLOWED)).toEqual([]);
  });

  // The exact form that shipped two dead workers. This is the assertion that fails if anyone
  // reintroduces it, and it is the reason the guard is static rather than a runtime test — from
  // source this spawn works perfectly, so no test could catch it.
  it.each([
    ['new Worker(new URL("./w.ts", import.meta.url))', "runtime-resolved URL"],
    ['new Worker(new URL("./w.ts", import.meta.url).href)', "the .href spelling"],
    ['new Worker("./w.ts")', "a bare string literal"],
    ["new Worker(someLocalVariable)", "an unrelated identifier"],
  ])("rejects %s (%s)", (spawn) => {
    const files = [{ path: "a.ts", source: `const w = ${spawn};` }];
    expect(findWorkerViolations(files, ALLOWED)).toHaveLength(1);
  });

  it("finds every violation, not just the first", () => {
    const files = [
      { path: "a.ts", source: 'new Worker(new URL("./a.ts", import.meta.url));' },
      { path: "b.ts", source: 'new Worker("./b.ts");' },
    ];
    expect(findWorkerViolations(files, ALLOWED).map((v) => v.file)).toEqual(["a.ts", "b.ts"]);
  });

  // Several protected files EXPLAIN the banned form in prose. A guard that fires on its own
  // rationale gets deleted, so comments are stripped before scanning.
  it("ignores the banned form inside a block comment", () => {
    const files = [
      {
        path: "a.ts",
        source: [
          "/**",
          ' * Never write `new Worker(new URL("./w.ts", import.meta.url))` — it is not bundled.',
          " */",
          "const w = new Worker(QUERY_GUARD_WORKER_PATH);",
        ].join("\n"),
      },
    ];
    expect(findWorkerViolations(files, ALLOWED)).toEqual([]);
  });

  it("ignores the banned form inside a line comment", () => {
    const files = [
      {
        path: "a.ts",
        source: '// not this: new Worker(new URL("./w.ts", import.meta.url))\nconst w = 1;',
      },
    ];
    expect(findWorkerViolations(files, ALLOWED)).toEqual([]);
  });

  it("tolerates whitespace between `new Worker` and its argument", () => {
    const files = [{ path: "a.ts", source: "new  Worker (  EMBEDDING_WORKER_PATH  )" }];
    expect(findWorkerViolations(files, ALLOWED)).toEqual([]);
  });
});
