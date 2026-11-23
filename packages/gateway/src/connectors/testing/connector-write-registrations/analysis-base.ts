import { posix } from "node:path";
import { escapeRe, type File, type RegistrarKind, type State } from "./analysis-state.ts";
import { topLevelWords } from "./file-index.ts";
import { IDENT, lineAt, skipWs, skipWsBack } from "./lexical.ts";
import { isExportedAt } from "./module-shapes.ts";
import type { ScanViolation, WriteToolRegistration } from "./package-sources.ts";

export class AnalysisBase {
  readonly registrations: WriteToolRegistration[] = [];
  readonly violations: ScanViolation[] = [];
  /** Per file: `[open, close]` of every recognised registrar call, for the `mutates` cross-check. */
  readonly callSpans = new Map<string, Array<readonly [number, number]>>();
  /** Per file: `[` offsets of the constant tables a registration resolved through. */
  readonly tablesUsed = new Map<string, Set<number>>();
  /**
   * Kit functions: functions a registration's id is built inside from an option EVERY CALLER
   * supplies (`registerEmailConnectorTools({ toolPrefix, registerWriteTool })`). The callers decide
   * the ids, so every use of a kit must be a call the scan reads.
   */
  readonly kits = new Set<string>();
  private readonly seen = new Set<string>();
  private readonly byRel: ReadonlyMap<string, File>;

  constructor(
    readonly state: State,
    readonly files: readonly File[],
  ) {
    this.byRel = new Map(files.map((f) => [f.p.rel, f]));
  }

  violation(f: File, offset: number, reason: string): void {
    const line = lineAt(f.p, offset);
    const key = `${f.p.rel}:${line}:${reason}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.violations.push({ file: f.p.rel, line, reason });
  }

  localsOf(f: File): Map<string, RegistrarKind> {
    let m = this.state.locals.get(f.p.rel);
    if (m === undefined) {
      m = new Map();
      this.state.locals.set(f.p.rel, m);
    }
    return m;
  }

  /** Every registrar callable in `f`: its own names plus every exported one. */
  registrarsIn(f: File): Map<string, RegistrarKind> {
    return new Map([...this.state.exported, ...this.localsOf(f)]);
  }

  /**
   * What a member access `.name` reaches: a registrar handed off under that key
   * (`opts.registerWriteTool`), or an exported registrar or forwarder read off its module — a
   * namespace or dynamic import (`kit.registerStatusTool`).
   */
  memberKind(name: string): RegistrarKind | undefined {
    return this.state.keys.has(name) ? "kit-alias" : this.state.exported.get(name);
  }

  /** Every name a member access can reach a registrar through. */
  memberNames(): Set<string> {
    return new Set([...this.state.keys, ...this.state.exported.keys()]);
  }

  // -- discovery ------------------------------------------------------------------------------

  /** Bind names to registrars: factory results, aliases, destructured or typed registrar keys. */
  discoverBindings(f: File): void {
    this.discoverTypedKeys(f);
    this.discoverDeclaredRegistrars(f);
    this.discoverDestructuredRegistrars(f);
    this.discoverHandOffKeys(f);
  }

  /** A property or parameter typed `*WriteToolRegistrar` names a registrar key, and a local. */
  discoverTypedKeys(f: File): void {
    const locals = this.localsOf(f);
    const typed = new RegExp(
      String.raw`(?<![\w$.])(${IDENT})\s*\??\s*:\s*(?:Readonly<\s*)?[A-Za-z_$]*WriteToolRegistrar\b`,
      "g",
    );
    for (const m of f.p.blank.matchAll(typed)) {
      const name = m[1] ?? "";
      this.state.keys.add(name);
      if (!locals.has(name)) locals.set(name, "kit-alias");
    }
  }

  /** `const name = <registrar-valued expression>`; an exported one is callable from any file. */
  discoverDeclaredRegistrars(f: File): void {
    for (const d of f.ix.declarations) {
      const kind = this.registrarValueKind(f, d.initStart, d.initEnd);
      if (kind === undefined) continue;
      const target = isExportedAt(f.p.blank, d.at) ? this.state.exported : this.localsOf(f);
      if (!target.has(d.name)) target.set(d.name, kind);
    }
  }

  /**
   * `const { registerWriteTool } = opts` and `({ registerWriteTool }) =>` take a registrar key;
   * `const { registerStatusTool: reopen } = await import("./status.ts")` takes an exported one.
   */
  discoverDestructuredRegistrars(f: File): void {
    const locals = this.localsOf(f);
    const patterns = [
      ...f.ix.destructurings.map((d) => d.bindings),
      ...f.ix.fns.flatMap((fn) => fn.params.map((p) => p.pattern)),
    ];
    for (const b of patterns.flat()) {
      const kind = this.memberKind(b.key);
      if (kind !== undefined && !locals.has(b.local)) locals.set(b.local, kind);
    }
  }

  /** Hand-offs: `{ registerWriteTool }` / `{ key: registerWriteTool }` make the key a registrar key. */
  discoverHandOffKeys(f: File): void {
    for (const name of this.registrarsIn(f).keys()) {
      const re = new RegExp(
        String.raw`(?:[{,]\s*${escapeRe(name)}\s*(?=[,}])|(?<![\w$.])(${IDENT})\s*:\s*${escapeRe(name)}\s*(?=[,}]))`,
        "g",
      );
      for (const m of f.p.blank.matchAll(re)) this.state.keys.add(m[1] ?? name);
    }
  }

  /**
   * The registrar kind an expression evaluates to at its top level: a factory call, a registrar
   * name, or a registrar key read off an object (`options.registerWriteTool ?? create...(...)`).
   */
  registrarValueKind(f: File, start: number, end: number): RegistrarKind | undefined {
    const registrars = this.registrarsIn(f);
    let found: RegistrarKind | undefined;
    for (const { at, word } of topLevelWords(f.p.blank, start, end)) {
      const hit = this.wordRegistrarKind(f.p.blank, at, word, registrars);
      if (hit?.call === true) return hit.kind; // a factory CALL decides it outright
      found ??= hit?.kind;
    }
    return found;
  }

  /**
   * What one top-level word contributes: a factory call (bare, or a member of a namespace or
   * dynamic import, `kit.createWriteToolRegistrar(...)`), a registrar value, or nothing.
   */
  wordRegistrarKind(
    s: string,
    at: number,
    word: string,
    registrars: ReadonlyMap<string, RegistrarKind>,
  ): { readonly call: boolean; readonly kind: RegistrarKind } | undefined {
    const next = s.charAt(skipWs(s, at + word.length));
    const factory = this.state.factories.get(word);
    if (factory !== undefined && (next === "(" || next === "<")) {
      return { call: true, kind: factory };
    }
    if (next === "(") return undefined; // calling a registrar yields no registrar
    const member = s.charAt(skipWsBack(s, at - 1)) === ".";
    const kind = member ? this.memberKind(word) : registrars.get(word);
    return kind === undefined ? undefined : { call: false, kind };
  }

  // -- registrations --------------------------------------------------------------------------

  /** The scanned file a relative specifier names, trying the extensions Bun would. */
  resolveModule(from: File, spec: string): File | undefined {
    const base = posix.normalize(posix.join(posix.dirname(from.p.rel), spec));
    const stem = base.replace(/\.[cm]?[jt]sx?$/, "");
    return (
      this.byRel.get(base) ?? this.byRel.get(`${stem}.ts`) ?? this.byRel.get(`${stem}/index.ts`)
    );
  }
}
