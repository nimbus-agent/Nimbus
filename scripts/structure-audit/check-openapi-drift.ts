#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { HTTP_ROUTES, type HttpRoute } from "../../packages/gateway/src/ipc/http-routes.ts";
import { REPO_ROOT } from "./lib.ts";

type DriftIssueKind = "schema_without_handler" | "handler_without_schema" | "yaml_unparseable";

export type DriftIssue = {
  kind: DriftIssueKind;
  method: string;
  path: string;
  reason: string;
};

const RESERVED_TAG = "x-nimbus-status";
const RESERVED_VALUE = "reserved";

const DEFAULT_SCHEMA_PATH = resolve(REPO_ROOT, "packages", "gateway", "openapi", "v1.yaml");

export function findOpenApiDrift(schemaFile: string, routes: readonly HttpRoute[]): DriftIssue[] {
  const issues: DriftIssue[] = [];
  let parsed: unknown;
  try {
    const raw = readFileSync(schemaFile, "utf8");
    parsed = yaml.load(raw, { filename: schemaFile });
  } catch (e) {
    return [
      {
        kind: "yaml_unparseable",
        method: "-",
        path: schemaFile,
        reason: e instanceof Error ? e.message : String(e),
      },
    ];
  }
  if (typeof parsed !== "object" || parsed === null) {
    return [
      {
        kind: "yaml_unparseable",
        method: "-",
        path: schemaFile,
        reason: "top-level value is not a YAML mapping",
      },
    ];
  }
  const paths = (parsed as Record<string, unknown>)["paths"];
  if (typeof paths !== "object" || paths === null) {
    return [
      {
        kind: "yaml_unparseable",
        method: "-",
        path: schemaFile,
        reason: "missing or non-object `paths` block",
      },
    ];
  }

  const schemaSet = new Set<string>();
  for (const [pathKey, pathValueRaw] of Object.entries(paths as Record<string, unknown>)) {
    if (typeof pathValueRaw !== "object" || pathValueRaw === null) {
      continue;
    }
    const pathValue = pathValueRaw as Record<string, unknown>;
    const status = pathValue[RESERVED_TAG];
    if (status === RESERVED_VALUE) {
      continue;
    }
    for (const verb of ["get", "post", "put", "patch", "delete", "head", "options"]) {
      if (pathValue[verb] !== undefined) {
        schemaSet.add(`${verb.toUpperCase()} ${pathKey}`);
      }
    }
  }

  const routeSet = new Set<string>();
  for (const r of routes) {
    routeSet.add(`${r.method} ${r.path}`);
  }

  for (const key of schemaSet) {
    if (!routeSet.has(key)) {
      const [method, ...rest] = key.split(" ");
      if (method === undefined) continue;
      issues.push({
        kind: "schema_without_handler",
        method,
        path: rest.join(" "),
        reason: "documented in v1.yaml but no entry in HTTP_ROUTES",
      });
    }
  }
  for (const key of routeSet) {
    if (!schemaSet.has(key)) {
      const [method, ...rest] = key.split(" ");
      if (method === undefined) continue;
      issues.push({
        kind: "handler_without_schema",
        method,
        path: rest.join(" "),
        reason: "in HTTP_ROUTES but not documented in v1.yaml",
      });
    }
  }
  return issues;
}

type Mode = "check" | "report";

function parseArgs(argv: readonly string[]): { mode: Mode } {
  let mode: Mode = "check";
  for (const a of argv.slice(2)) {
    if (a === "--check") mode = "check";
    else if (a === "--report") mode = "report";
    else {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return { mode };
}

async function run(): Promise<void> {
  const { mode } = parseArgs(Bun.argv);
  const issues = findOpenApiDrift(DEFAULT_SCHEMA_PATH, HTTP_ROUTES);

  if (mode === "report") {
    for (const i of issues) {
      console.log(`${i.kind.toUpperCase()}  ${i.method} ${i.path}  (${i.reason})`);
    }
    console.log(`${issues.length} drift items`);
    process.exit(issues.length === 0 ? 0 : 1);
  }
  if (issues.length === 0) {
    console.log(
      `OpenAPI drift check: schema and HTTP_ROUTES agree (${HTTP_ROUTES.length} routes).`,
    );
    return;
  }
  for (const i of issues) {
    console.error(
      `::error file=packages/gateway/openapi/v1.yaml::${i.kind} ${i.method} ${i.path}: ${i.reason}`,
    );
  }
  console.error(`\n${issues.length} OpenAPI drift items.`);
  process.exit(1);
}

if (import.meta.main) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
