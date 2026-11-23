import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";

export const CONNECTORS_PACKAGE = "@nimbus-dev/connectors";

/** The consent kit's registrar constructor: the root every write registration flows from. */
export const ROOT_REGISTRAR_FACTORY = "createWriteToolRegistrar";

export interface PackageSource {
  /** Package-relative path, forward slashes. */
  readonly rel: string;
  readonly text: string;
}

/**
 * How a registration's tool id reached the registrar. The first four say how the ID was written;
 * the last three say which kind of registrar was CALLED (a direct call of a consent-kit registrar
 * carries none of them).
 */
export type RegistrationTag =
  | "literal"
  | "template"
  | "loop"
  | "const"
  | "forwarder"
  | "kit-alias"
  | "factory";

export interface WriteToolRegistration {
  readonly id: string;
  /** The file holding the registering call. */
  readonly file: string;
  readonly line: number;
  /**
   * The file the id's VALUE was written in. Usually `file`; for an id built inside a shared kit
   * from a caller's constant (`${toolPrefix}_mail_send`) it is the caller's file, which is what
   * attributes the registration to the connector it belongs to.
   */
  readonly origin: string;
  readonly tags: readonly RegistrationTag[];
  /**
   * `[open, close]` offsets of the registering call's parentheses in `stripComments(text)` of
   * `file` — the comment-free text the scanner reads. NOT offsets into the raw `text`:
   * `stripComments` removes comments outright, so it is not length-preserving.
   */
  readonly span: readonly [number, number];
}

export interface ScanViolation {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
}

export interface WriteToolScan {
  readonly registrations: readonly WriteToolRegistration[];
  readonly violations: readonly ScanViolation[];
}

/** The installed package's root directory, resolved from the gateway the way Bun resolves it. */
export function installedConnectorsPackageRoot(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve(`${CONNECTORS_PACKAGE}/package.json`));
}

/**
 * Every non-test `.ts` file a connector can register a tool from: `connectors/<id>/src/**` and
 * `shared/**`. A missing `connectors/` directory throws, so a moved package fails loudly instead of
 * yielding an empty (and therefore passing) scan.
 */
export function readConnectorPackageSources(root: string): PackageSource[] {
  const out: PackageSource[] = [];
  const connectorsDir = join(root, "connectors");
  for (const id of readdirSync(connectorsDir).sort((a, b) => a.localeCompare(b))) {
    walkTs(join(connectorsDir, id, "src"), root, out);
  }
  walkTs(join(root, "shared"), root, out);
  return out;
}

function walkTs(dir: string, root: string, out: PackageSource[]): void {
  let names: string[];
  try {
    names = readdirSync(dir).sort((a, b) => a.localeCompare(b));
  } catch {
    return; // a connector need not have every directory
  }
  for (const name of names) {
    const path = join(dir, name);
    if (name.endsWith(".ts")) {
      if (!name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
        out.push({
          rel: relative(root, path).split(sep).join("/"),
          text: readFileSync(path, "utf8"),
        });
      }
    } else if (name !== "node_modules" && !name.includes(".")) {
      walkTs(path, root, out);
    }
  }
}
