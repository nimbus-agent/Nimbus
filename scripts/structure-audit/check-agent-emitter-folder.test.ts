import { expect, test } from "bun:test";
import { checkAgentEmitterImportConfinement } from "./invariants/actuation-embedding-registry.ts";

const EMITTER_IMPORT = 'import { emitWhyBrief } from "../../agents/why.ts";\n';

// D22(d): `ipc/agents-rpc.ts` stays the one dispatcher; its validators and handlers moved into the
// sibling folder `ipc/agents-rpc/`, which is therefore the one other place an emitter may be imported.
test("D22(d) allows an emitter import inside ipc/agents-rpc/ and nowhere else under ipc/", () => {
  expect(
    checkAgentEmitterImportConfinement([
      { relPath: "packages/gateway/src/ipc/agents-rpc/handlers-core.ts", contents: EMITTER_IMPORT },
    ]),
  ).toEqual([]);
  expect(
    checkAgentEmitterImportConfinement([
      { relPath: "packages/gateway/src/ipc/agents-rpc-extra.ts", contents: EMITTER_IMPORT },
      { relPath: "packages/gateway/src/ipc/other/handlers.ts", contents: EMITTER_IMPORT },
    ]).map((v) => v.file),
  ).toEqual([
    "packages/gateway/src/ipc/agents-rpc-extra.ts",
    "packages/gateway/src/ipc/other/handlers.ts",
  ]);
});
