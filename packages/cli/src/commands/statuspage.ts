import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { CliExit } from "../lib/cli-exit.ts";
import { stripControlChars } from "../lib/strip-control-chars.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { renderStatuspageHtml, type StatuspagePageModel } from "./statuspage-render.ts";

export const STATUSPAGE_USAGE =
  "Usage: nimbus statuspage draft [--out <file|->] [--force] [--service <id>]... [--title <text>] [--titles] [--links] [--json]";
export const STATUSPAGE_DEFAULT_FILE = "nimbus-status.html";

export interface StatuspageArgs {
  readonly out?: string;
  readonly force: boolean;
  readonly services: readonly string[];
  readonly title?: string;
  readonly titles: boolean;
  readonly links: boolean;
  readonly json: boolean;
}

export interface StatuspageIpc {
  call(method: string, params?: unknown): Promise<unknown>;
}
export interface StatuspageSink {
  out(s: string): void;
  err(s: string): void;
}
export interface StatuspageIo {
  /** The directory a relative `--out` and the default file name resolve against. */
  cwd: string;
  /** Writes `data`; with `overwrite` false it must fail if the file already exists. */
  writeFile(file: string, data: string, overwrite: boolean): Promise<void>;
}

const VALUE_FLAGS = new Set(["--out", "--service", "--title"]);

export function parseStatuspageArgs(argv: readonly string[]): StatuspageArgs | undefined {
  if (argv[0] !== "draft") return undefined;
  let out: string | undefined;
  let title: string | undefined;
  const services: string[] = [];
  const flags = { force: false, titles: false, links: false, json: false };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--force") flags.force = true;
    else if (a === "--titles") flags.titles = true;
    else if (a === "--links") flags.links = true;
    else if (a === "--json") flags.json = true;
    else {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a : a.slice(0, eq);
      if (!VALUE_FLAGS.has(name)) return undefined;
      let value: string | undefined;
      if (eq === -1) {
        i += 1;
        value = argv[i];
      } else {
        value = a.slice(eq + 1);
      }
      if (value === undefined || value.trim() === "") return undefined;
      // `--out -` is the one value that starts with a dash.
      if (value.startsWith("-") && !(name === "--out" && value === "-")) return undefined;
      if (name === "--out") {
        if (out !== undefined) return undefined;
        out = value;
      } else if (name === "--title") {
        if (title !== undefined) return undefined;
        title = value;
      } else {
        services.push(value.trim());
      }
    }
  }
  return {
    ...flags,
    services,
    ...(out === undefined ? {} : { out }),
    ...(title === undefined ? {} : { title }),
  };
}

const clean = (s: string): string => stripControlChars(s);

export async function runStatuspageWith(
  c: StatuspageIpc,
  a: StatuspageArgs,
  sink: StatuspageSink,
  io: StatuspageIo,
): Promise<number> {
  try {
    const model = (await c.call("statuspage.model", {
      ...(a.services.length === 0 ? {} : { services: [...a.services] }),
      titles: a.titles,
      links: a.links,
    })) as StatuspagePageModel;
    if (a.json) {
      sink.out(`${JSON.stringify(model)}\n`);
      return 0;
    }
    const html = renderStatuspageHtml(model, a.title === undefined ? {} : { title: a.title });
    const target = a.out ?? STATUSPAGE_DEFAULT_FILE;
    if (target === "-") {
      sink.out(html);
      sink.err("Draft written to stdout. Review it before publishing.\n");
      return 0;
    }
    const file = path.resolve(io.cwd, target);
    try {
      await io.writeFile(file, html, a.force);
    } catch (e) {
      if ((e as { code?: unknown }).code === "EEXIST") {
        sink.err(`${clean(file)} already exists; pass --force to overwrite it, or --out <file>.\n`);
        return 1;
      }
      throw e;
    }
    sink.out(`Draft written to ${clean(file)}\n`);
    sink.out("Review it, then publish it yourself: Nimbus does not upload anything.\n");
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (a.json) sink.out(`${JSON.stringify({ error: msg })}\n`);
    else sink.err(`${clean(msg)}\n`);
    return 1;
  }
}

async function writeLocalFile(file: string, data: string, overwrite: boolean): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
}

export async function runStatuspageCommand(argv: string[]): Promise<void> {
  const a = parseStatuspageArgs(argv);
  if (a === undefined) {
    process.stderr.write(`${STATUSPAGE_USAGE}\n`);
    throw new CliExit(1);
  }
  const code = await withGatewayIpc(
    (c) =>
      runStatuspageWith(
        c,
        a,
        { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) },
        { cwd: process.cwd(), writeFile: writeLocalFile },
      ),
    getCliPlatformPaths(),
  );
  if (code !== 0) throw new CliExit(code);
}
