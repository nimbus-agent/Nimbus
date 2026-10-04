/**
 * One synthetic connector tree per registration shape the write-tool scan follows
 * (`./connector-write-registrations.ts`). Shared by the scan's own tests and by the I26 sync
 * guard, which proves with them that an unclassified write is reported in EVERY shape — not only
 * in the shapes the currently installed connectors package happens to use.
 *
 * Every fixture id is `fx_*` and ends in a verb no real connector uses, so it can never be
 * classified by the gateway's I26 predicate (not even as a `_`-suffix of a real write id).
 */
import type { PackageSource, RegistrationTag } from "./connector-write-registrations.ts";

export interface ShapeFixture {
  /** What the fixture exercises. */
  readonly shape: string;
  readonly sources: readonly PackageSource[];
  /** The write-tool ids the scan must derive, in any order. */
  readonly ids: readonly string[];
  /** Tags every derived registration must carry. */
  readonly tags: readonly RegistrationTag[];
}

const KIT_IMPORT = `import { createWriteToolRegistrar, type WriteToolRegistrar } from "../../../shared/consent-kit.ts";`;
const REGISTRAR = `const registerWriteTool = createWriteToolRegistrar(server, {
  connector: "fx",
  scopeEnv: "NIMBUS_MCP_FX_WRITE_SCOPE",
  scopeKinds: ["repo"],
});`;

/** A write config literal, as connectors write them. */
function cfg(mutates: string): string {
  return `{
    mutates: "${mutates}",
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "repo", value: p.repo }),
  }`;
}

function connector(id: string, body: string, file = "server.ts"): PackageSource {
  return { rel: `connectors/${id}/src/${file}`, text: `${KIT_IMPORT}\n${body}\n` };
}

/**
 * A module of connector `id` exporting a POSITIONAL forwarder — the tool id first, `mutates` passed
 * as a plain argument, so no `mutates:` literal ever sits at a call site. That is the shape
 * connectors 0.2.2 uses inside bigeye, gitlab and monte-carlo, here exported so another module can
 * reach it through an import.
 */
function statusModule(id: string): PackageSource {
  return connector(
    id,
    `${REGISTRAR}
export function registerStatusTool(name: string, mutates: string, description: string): void {
  registerWriteTool(name, { mutates, recoverable: true, scopeTargetOf: (p) => ({ kind: "issue", value: p.id }) }, description, schema, h);
}`,
    "status.ts",
  );
}

/** A shared kit that builds each write-tool id from the `toolPrefix` its CALLER passes. */
const MAIL_KIT: PackageSource = {
  rel: "shared/fx-mail-kit.ts",
  text: `import type { WriteToolRegistrar } from "./consent-kit.ts";
export function registerFxMailTools(opts: {
  toolPrefix: string;
  registerWriteTool: WriteToolRegistrar;
}): void {
  const { toolPrefix, registerWriteTool } = opts;
  registerWriteTool(
    \`\${toolPrefix}_mail_frobnicate\`,
    { mutates: \`\${toolPrefix}.mail.frobnicate\`, recoverable: true, scopeTargetOf: (p) => ({ kind: "recipient", value: p.to }) },
    "Send.",
    schema,
    h,
  );
}`,
};

export const SHAPE_FIXTURES: readonly ShapeFixture[] = [
  {
    shape: "a literal id on a multi-line registrar call",
    sources: [
      connector(
        "fx-literal",
        `${REGISTRAR}
registerWriteTool(
  "fx_literal_frobnicate",
  ${cfg("fx.literal.frobnicate")},
  "Frobnicate.",
  schema,
  async () => ok,
);`,
      ),
    ],
    ids: ["fx_literal_frobnicate"],
    tags: ["literal"],
  },
  {
    shape: "a call with explicit type arguments",
    sources: [
      connector(
        "fx-typed",
        `${REGISTRAR}
registerWriteTool<{ repo: string }>("fx_typed_frobnicate", ${cfg("fx.typed.frobnicate")}, "d", schema, h);`,
      ),
    ],
    ids: ["fx_typed_frobnicate"],
    tags: ["literal"],
  },
  {
    shape: "a forwarder declared as a function, under a name that says nothing about writes",
    sources: [
      connector(
        "fx-forwarder",
        `${REGISTRAR}
function registerStatusTool(name: string, mutates: string, description: string): void {
  registerWriteTool(name, { mutates, recoverable: true, scopeTargetOf: (p) => ({ kind: "repo", value: p.repo }) }, description, schema, h);
}
registerStatusTool("fx_forwarder_frobnicate", "fx.forwarder.frobnicate", "Frobnicate.");`,
      ),
    ],
    ids: ["fx_forwarder_frobnicate"],
    tags: ["literal", "forwarder"],
  },
  {
    shape: "a forwarder bound as a const arrow with an expression body",
    sources: [
      connector(
        "fx-arrow",
        `${REGISTRAR}
const addTool = (name: string, description: string) =>
  registerWriteTool(name, ${cfg("fx.arrow.frobnicate")}, description, schema, h);
addTool("fx_arrow_frobnicate", "Frobnicate.");`,
      ),
    ],
    ids: ["fx_arrow_frobnicate"],
    tags: ["literal", "forwarder"],
  },
  {
    shape: "a kit factory that returns a forwarding arrow, bound under a fresh name",
    sources: [
      {
        rel: "shared/fx-rest-kit.ts",
        text: `import type { WriteToolConfig, WriteToolRegistrar } from "./consent-kit.ts";
export function makeFxWriteRegistrar(cfg: { readonly registerWriteTool: WriteToolRegistrar }): FxRegistrar {
  return (name, toolCfg, description, schema) => {
    cfg.registerWriteTool(name, toolCfg, description, schema, async () => ok);
  };
}`,
      },
      connector(
        "fx-factory",
        `import { makeFxWriteRegistrar } from "../../../shared/fx-rest-kit.ts";
${REGISTRAR}
const registerFxWriteTool = makeFxWriteRegistrar({ registerWriteTool });
registerFxWriteTool("fx_factory_frobnicate", ${cfg("fx.factory.frobnicate")}, "d", schema);`,
      ),
    ],
    ids: ["fx_factory_frobnicate"],
    tags: ["literal", "factory"],
  },
  {
    shape: "a registrar handed to a shared kit that builds the id from each caller's constant",
    sources: [
      MAIL_KIT,
      connector(
        "fx-mail-a",
        `import { registerFxMailTools } from "../../../shared/fx-mail-kit.ts";
${REGISTRAR}
registerFxMailTools({ toolPrefix: "fx_kita", registerWriteTool });`,
        "tools.ts",
      ),
      connector(
        "fx-mail-b",
        `import { registerFxMailTools } from "../../../shared/fx-mail-kit.ts";
${REGISTRAR}
registerFxMailTools({ registerWriteTool, toolPrefix: "fx_kitb" });`,
        "tools.ts",
      ),
    ],
    ids: ["fx_kita_mail_frobnicate", "fx_kitb_mail_frobnicate"],
    tags: ["template", "kit-alias"],
  },
  {
    shape: "an id taken from a constant table by a for-of loop",
    sources: [
      connector(
        "fx-loop",
        `const RECONCILABLE = [
  { tool: "fx_loop_a_frobnicate", mutates: "fx.loop.a.frobnicate" },
  { tool: "fx_loop_b_frobnicate", mutates: "fx.loop.b.frobnicate" },
] as const;
export function registerFxTools(server: unknown): void {
  ${REGISTRAR}
  for (const { tool, mutates } of RECONCILABLE) {
    registerWriteTool(tool, { mutates, recoverable: true, scopeTargetOf: (p) => ({ kind: "repo", value: p.repo }) }, "d", schema, h);
  }
}`,
      ),
    ],
    ids: ["fx_loop_a_frobnicate", "fx_loop_b_frobnicate"],
    tags: ["loop"],
  },
  {
    shape: "a template id over a constant table's field",
    sources: [
      connector(
        "fx-loop-template",
        `const ACTIONS = [{ action: "frobnicate" }, { action: "defrobnicate" }];
${REGISTRAR}
for (const { action } of ACTIONS) {
  registerWriteTool(\`fx_incident_\${action}\`, { mutates: \`fx.incident.\${action}\`, recoverable: true, scopeTargetOf: (p) => ({ kind: "incident", value: p.id }) }, "d", schema, h);
}`,
      ),
    ],
    ids: ["fx_incident_frobnicate", "fx_incident_defrobnicate"],
    tags: ["template"],
  },
  {
    shape: "an id held in a string constant",
    sources: [
      connector(
        "fx-const",
        `const FROB_TOOL = "fx_const_frobnicate";
${REGISTRAR}
registerWriteTool(FROB_TOOL, ${cfg("fx.const.frobnicate")}, "d", schema, h);`,
      ),
    ],
    ids: ["fx_const_frobnicate"],
    tags: ["const"],
  },
  {
    shape: "a registrar exported from one module and called from another",
    sources: [
      {
        rel: "connectors/fx-exported/src/registrar.ts",
        text: `${KIT_IMPORT}\nexport const registerFxWriteTool = createWriteToolRegistrar(server, FX_WRITE_SCOPE);\n`,
      },
      connector(
        "fx-exported",
        `import { registerFxWriteTool } from "./registrar.ts";
registerFxWriteTool("fx_exported_frobnicate", ${cfg("fx.exported.frobnicate")}, "d", schema, h);`,
      ),
    ],
    ids: ["fx_exported_frobnicate"],
    tags: ["literal"],
  },
  {
    shape: "a registrar bound through `??` and then aliased",
    sources: [
      connector(
        "fx-alias",
        `export function registerFxCalendar(options: { registerWriteTool?: WriteToolRegistrar | undefined }): void {
  const registerWriteTool =
    options.registerWriteTool ?? createWriteToolRegistrar(server, FX_WRITE_SCOPE);
  const register = registerWriteTool;
  register("fx_alias_frobnicate", ${cfg("fx.alias.frobnicate")}, "d", schema, h);
}`,
      ),
    ],
    ids: ["fx_alias_frobnicate"],
    tags: ["literal"],
  },
  {
    shape: "an exported forwarder called through a namespace import",
    sources: [
      statusModule("fx-namespace"),
      connector(
        "fx-namespace",
        `import * as status from "./status.ts";
status.registerStatusTool("fx_namespace_frobnicate", "fx.namespace.frobnicate", "Frobnicate.");`,
      ),
    ],
    ids: ["fx_namespace_frobnicate"],
    tags: ["literal", "forwarder"],
  },
  {
    shape: "an exported forwarder aliased off a namespace import",
    sources: [
      statusModule("fx-ns-alias"),
      connector(
        "fx-ns-alias",
        `import * as status from "./status.ts";
const reopen = status.registerStatusTool;
reopen("fx_nsalias_frobnicate", "fx.nsalias.frobnicate", "Frobnicate.");`,
      ),
    ],
    ids: ["fx_nsalias_frobnicate"],
    tags: ["literal", "forwarder"],
  },
  {
    shape: "an exported forwarder destructured under a new name from a dynamic import",
    sources: [
      statusModule("fx-dynamic"),
      connector(
        "fx-dynamic",
        `export async function registerFxTools(): Promise<void> {
  const { registerStatusTool: reopen } = await import("./status.ts");
  reopen("fx_dynamic_frobnicate", "fx.dynamic.frobnicate", "Frobnicate.");
}`,
      ),
    ],
    ids: ["fx_dynamic_frobnicate"],
    tags: ["literal", "forwarder"],
  },
  {
    shape: "a dynamic import's module object, bound to a name or dereferenced on the spot",
    sources: [
      statusModule("fx-module"),
      connector(
        "fx-module",
        `export async function registerFxTools(): Promise<void> {
  const status = await import("./status.ts");
  status.registerStatusTool("fx_module_bound_frobnicate", "fx.module.bound", "Frobnicate.");
  (await import("./status.ts")).registerStatusTool("fx_module_spot_frobnicate", "fx.module.spot", "Frobnicate.");
}`,
      ),
    ],
    ids: ["fx_module_bound_frobnicate", "fx_module_spot_frobnicate"],
    tags: ["literal", "forwarder"],
  },
  {
    shape: "an exported registrar called through a namespace import",
    sources: [
      {
        rel: "connectors/fx-ns-registrar/src/registrar.ts",
        text: `${KIT_IMPORT}\nexport const registerFxWriteTool = createWriteToolRegistrar(server, FX_WRITE_SCOPE);\n`,
      },
      connector(
        "fx-ns-registrar",
        `import * as registrar from "./registrar.ts";
registrar.registerFxWriteTool("fx_nsregistrar_frobnicate", ${cfg("fx.nsregistrar.frobnicate")}, "d", schema, h);`,
      ),
    ],
    ids: ["fx_nsregistrar_frobnicate"],
    tags: ["literal"],
  },
  {
    shape: "the registrar constructor called through a namespace import of the consent kit",
    sources: [
      {
        rel: "connectors/fx-ns-consent/src/server.ts",
        text: `import * as consent from "../../../shared/consent-kit.ts";
const registerWriteTool = consent.createWriteToolRegistrar(server, FX_WRITE_SCOPE);
registerWriteTool("fx_nsconsent_frobnicate", ${cfg("fx.nsconsent.frobnicate")}, "d", schema, h);
`,
      },
    ],
    ids: ["fx_nsconsent_frobnicate"],
    tags: ["literal"],
  },
  {
    shape: "a shared kit called bare by one connector and through a namespace import by another",
    sources: [
      MAIL_KIT,
      connector(
        "fx-mail-c",
        `import { registerFxMailTools } from "../../../shared/fx-mail-kit.ts";
${REGISTRAR}
registerFxMailTools({ toolPrefix: "fx_kitc", registerWriteTool });`,
        "tools.ts",
      ),
      connector(
        "fx-mail-d",
        `import * as mailKit from "../../../shared/fx-mail-kit.ts";
${REGISTRAR}
mailKit.registerFxMailTools({ toolPrefix: "fx_kitd", registerWriteTool });`,
        "tools.ts",
      ),
    ],
    ids: ["fx_kitc_mail_frobnicate", "fx_kitd_mail_frobnicate"],
    tags: ["template", "kit-alias"],
  },
];
