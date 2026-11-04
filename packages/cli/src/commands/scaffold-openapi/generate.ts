/**
 * The operation model → the files of an extension. The plain extension scaffold is the base; the
 * manifest, the tools and the README are replaced and the operation table and request code are
 * added. Document text reaches `src/operations.json` (via `JSON.stringify`) and `README.md` (with
 * control characters stripped) only — the `.ts` files are the fixed templates.
 */
import { parseExtensionManifestForRegistry } from "@nimbus-dev/registry-format";
import { stripControlChars } from "../../lib/strip-control-chars.ts";
import {
  buildExtensionScaffoldFiles,
  extensionNamespaceNote,
  extensionReadmeSteps,
  resolveExtensionId,
  type ScaffoldFile,
} from "../scaffold-extension.ts";
import type { OperationDef, OperationModel } from "./model.ts";
import { OPENAPI_REQUEST_TS, OPENAPI_TOOLS_TEST_TS, OPENAPI_TOOLS_TS } from "./templates.ts";

const MANIFEST_PATH = "nimbus.extension.json";

function json(value: unknown): string {
  return `${JSON.stringify(value, undefined, 2)}\n`;
}

function contentOf(files: readonly ScaffoldFile[], path: string): string {
  const file = files.find((f) => f.path.join("/") === path);
  if (file === undefined) throw new Error(`the extension scaffold has no ${path}`);
  return file.content;
}

/** The plain manifest with the model's network hosts and credentials. */
function buildManifest(plain: string, model: OperationModel): Record<string, unknown> {
  const manifest = JSON.parse(plain) as Record<string, unknown>;
  const permissions = manifest["permissions"] as Record<string, unknown>;
  permissions["network"] = [...model.hosts];
  if (Object.keys(model.credentials).length > 0) {
    manifest["credentials"] = { ...model.credentials };
  }
  return manifest;
}

/**
 * The registry's own parser over the manifest. An unsigned `publisher` is left out of the check:
 * `nimbus extension sign` fills in its key and signature later, exactly as for the plain scaffold.
 */
function assertManifestParses(manifest: Record<string, unknown>): void {
  const { publisher: _publisher, ...checked } = manifest;
  try {
    parseExtensionManifestForRegistry(JSON.stringify(checked));
  } catch (e) {
    // The parser throws only Error.
    throw new Error(`bug: the generated manifest does not parse: ${(e as Error).message}`);
  }
}

/** One Markdown list line of document-derived text, control characters stripped. */
function item(text: string): string {
  return `- ${stripControlChars(text)}\n`;
}

function describeOp(op: OperationDef): string {
  return `\`${op.tool}\` — ${op.method} ${op.path}`;
}

function section(title: string, intro: string, lines: readonly string[]): string {
  if (lines.length === 0) return "";
  return `## ${title}\n\n${intro}\n\n${lines.map(item).join("")}\n`;
}

function credentialsSection(id: string, model: OperationModel): string {
  const entries = Object.entries(model.credentials);
  if (entries.length === 0) return "";
  const commands = entries.map(([n]) => `nimbus extension credential set ${id} ${n}`).join("\n");
  const envs = entries.map(([n, c]) => `\`${n}\` reaches the extension as \`${c.env}\``);
  return `## Credentials

Set each credential once the extension is installed and approved; a call that needs one refuses
until it is set.

\`\`\`
${commands}
\`\`\`

${envs.map(item).join("")}
`;
}

/** Every README section that lists what the model reports, in a fixed order. */
function modelSections(id: string, model: OperationModel): string {
  const unsupportedBodies = model.operations.filter((op) => op.body === "unsupported");
  return [
    section(
      "Operations",
      "One tool per operation. Each is a row of `src/operations.json`; edit that table to change what a tool sends.",
      model.operations.map(describeOp),
    ),
    credentialsSection(id, model),
    section(
      "Skipped operations",
      "These operations were not generated:",
      model.skipped.map((s) => `${s.operation}: ${s.reason}`),
    ),
    section(
      "Shortened tool names",
      "These names were cut to fit the tool-name limit:",
      model.cutNames.map((c) => `${c.from} → ${c.to}`),
    ),
    section(
      "Unsupported security schemes",
      "These schemes are not supported; an operation that offered only them was generated without a credential:",
      model.unsupportedSchemes,
    ),
    section(
      "Request bodies that are not JSON",
      "These tools are generated but refuse every call until `src/request.ts` is taught to send their body:",
      unsupportedBodies.map(describeOp),
    ),
    section("Warnings", "Generating the extension reported:", model.warnings),
  ].join("");
}

function buildOpenApiReadme(
  name: string,
  id: string,
  publisher: string | undefined,
  model: OperationModel,
): string {
  return `# ${id}

A Nimbus extension generated from an OpenAPI document: an MCP server with one tool per operation,
installed and run by the Gateway. It reaches only the hosts \`nimbus.extension.json\` declares.
${extensionNamespaceNote(name, id, publisher)}
${modelSections(id, model)}## Evaluate

No eval suite is generated: evals run with no network, so every call this extension makes would
fail there. Once you add tools that answer without the network, record a golden suite from their
replies with \`nimbus eval --package . --record <inputs.json>\`.

${extensionReadmeSteps(publisher)}`;
}

/** The plain extension scaffold's files with the OpenAPI-specific ones replaced and added. */
export function buildOpenApiScaffoldFiles(
  name: string,
  publisher: string | undefined,
  platform: NodeJS.Platform,
  absDir: string,
  model: OperationModel,
): readonly ScaffoldFile[] {
  const plain = buildExtensionScaffoldFiles(name, publisher, platform, absDir);
  const id = resolveExtensionId(name, publisher);
  const manifest = buildManifest(contentOf(plain, MANIFEST_PATH), model);
  assertManifestParses(manifest);
  return [
    { path: [MANIFEST_PATH], content: json(manifest) },
    { path: ["package.json"], content: contentOf(plain, "package.json") },
    { path: ["src", "server.ts"], content: contentOf(plain, "src/server.ts") },
    {
      path: ["src", "operations.json"],
      content: json({ hosts: model.hosts, operations: model.operations }),
    },
    { path: ["src", "request.ts"], content: OPENAPI_REQUEST_TS },
    { path: ["src", "tools.ts"], content: OPENAPI_TOOLS_TS.replaceAll("__NAME__", name) },
    { path: ["src", "tools.test.ts"], content: OPENAPI_TOOLS_TEST_TS.replaceAll("__NAME__", name) },
    { path: ["README.md"], content: buildOpenApiReadme(name, id, publisher, model) },
    { path: [".gitignore"], content: contentOf(plain, ".gitignore") },
  ];
}

/** The lines `runScaffold` prints after the summary: warnings, skipped operations, cut names. */
export function openApiReportLines(model: OperationModel): string[] {
  return [
    ...model.warnings.map((w) => `warning: ${w}`),
    ...model.skipped.map((s) => `skipped ${s.operation}: ${s.reason}`),
    ...model.cutNames.map((c) => `shortened tool name ${c.from} → ${c.to}`),
  ].map(stripControlChars);
}
