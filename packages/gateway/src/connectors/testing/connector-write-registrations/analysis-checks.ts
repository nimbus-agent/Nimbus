import { AnalysisResolve } from "./analysis-resolve.ts";
import { ENDS_IN_FUNCTION_KEYWORD, escapeRe, type File } from "./analysis-state.ts";
import { isSimplePattern } from "./file-index.ts";
import { CLOSE, matchForward, OPEN, skipWs, stringLiteralAt } from "./lexical.ts";
import {
  DECLARATION_LEAD,
  DEFAULT_EXPORTED_FUNCTION,
  dynamicImportsOf,
  dynamicImportValue,
  isDiscarded,
  isExportedAt,
  isKeyedValue,
  isKitUse,
  isMemberRead,
  isTrackedUse,
  isTypeofOperand,
  isWholeStringLiteral,
  NAMESPACE_IMPORT,
  NAMESPACE_REEXPORT,
  namedOutsideDeclaration,
} from "./module-shapes.ts";
import { CONNECTORS_PACKAGE } from "./package-sources.ts";

export class Analysis extends AnalysisResolve {
  /**
   * Whether `o` is at the TOP level of a declaration's initializer: the only position where a
   * registrar reference is an alias {@link registrarValueKind} binds. A reference nested inside the
   * initializer (`const x = wrap(registerWriteTool)`) is a hand-off the scan does not follow.
   */
  isTopLevelOfInit(f: File, o: number): boolean {
    const s = f.p.blank;
    const spans = [
      ...f.ix.declarations.map((d) => [d.initStart, d.initEnd] as const),
      ...f.ix.destructurings.map((d) => [d.rhsStart, d.rhsEnd] as const),
    ];
    return spans.some(([x, y]) => {
      if (o < x || o >= y) return false;
      let depth = 0;
      for (let i = x; i < o; i++) {
        const c = s.charAt(i);
        if (OPEN.includes(c)) depth++;
        else if (CLOSE.includes(c)) depth--;
      }
      return depth === 0;
    });
  }

  /** A registrar or factory used as a value somewhere the flow does not follow. */
  checkEscapes(f: File): void {
    this.checkRegistrarEscapes(f);
    this.checkMemberEscapes(f);
    this.checkFactoryEscapes(f);
    this.checkKitEscapes(f);
    this.checkNameStrings(f);
  }

  /** Every bare use of a registrar name is a tracked use or a top-level alias. */
  checkRegistrarEscapes(f: File): void {
    const s = f.p.blank;
    for (const name of this.registrarsIn(f).keys()) {
      for (const m of s.matchAll(
        new RegExp(String.raw`(?<![\w$.])${escapeRe(name)}(?![\w$])`, "g"),
      )) {
        const o = m.index ?? 0;
        if (!isTrackedUse(s, o, name.length) && !this.isTopLevelOfInit(f, o)) {
          this.violation(f, o, `registrar \`${name}\` is used as a value the scan does not follow`);
        }
      }
    }
  }

  /**
   * Every `.name` read of a registrar key or of an exported registrar (off a namespace or dynamic
   * import) is a call or a top-level alias.
   */
  checkMemberEscapes(f: File): void {
    const s = f.p.blank;
    for (const name of this.memberNames()) {
      for (const m of s.matchAll(new RegExp(String.raw`\.\s*${escapeRe(name)}(?![\w$])`, "g"))) {
        const o = (m.index ?? 0) + m[0].length - name.length;
        const next = s.charAt(skipWs(s, o + name.length));
        if (next !== "(" && next !== "<" && !this.isTopLevelOfInit(f, o)) {
          this.violation(
            f,
            o,
            `registrar property \`.${name}\` is read somewhere the scan does not follow`,
          );
        }
      }
    }
  }

  /**
   * A string spelling a registrar, forwarder, factory or registrar key is a computed member access
   * (`regs["registerWriteTool"]`, `kit["registerStatusTool"]`) the scan cannot follow. Only a
   * string that IS the name counts: a quote must open and close it in `blank` too.
   */
  checkNameStrings(f: File): void {
    const names = new Set([
      ...this.state.exported.keys(),
      ...this.state.factories.keys(),
      ...this.state.keys,
      ...this.kits,
    ]);
    for (const name of names) {
      for (const m of f.p.code.matchAll(new RegExp(`(["'\`])${escapeRe(name)}\\1`, "g"))) {
        const o = m.index ?? 0;
        if (isWholeStringLiteral(f.p, o, name.length)) {
          this.violation(f, o, `the string "${name}" names a registrar: a computed access`);
        }
      }
    }
  }

  /**
   * Every use of a kit function is a call the scan reads, its declaration, a plain (unaliased)
   * import of it, or a `typeof`. Its callers supply the ids it registers, so a caller reaching it
   * any other way — an aliased import, a hand-off as a value — would register ids nobody sees.
   */
  checkKitEscapes(f: File): void {
    for (const name of this.kits) {
      const re = new RegExp(String.raw`(?<![\w$])${escapeRe(name)}(?![\w$])`, "g");
      for (const m of f.p.blank.matchAll(re)) {
        const o = m.index ?? 0;
        if (!isKitUse(f, o, name)) {
          this.violation(
            f,
            o,
            `kit \`${name}\`, whose callers supply its write-tool ids, is used as a value the scan does not follow`,
          );
        }
      }
    }
  }

  /**
   * Every use of a registrar factory is a bound call, its definition, or a plain import — bare, or
   * read off a namespace or dynamic import (`kit.createWriteToolRegistrar`).
   */
  checkFactoryEscapes(f: File): void {
    for (const factory of this.state.factories.keys()) {
      const re = new RegExp(String.raw`(?<![\w$])${escapeRe(factory)}(?![\w$])`, "g");
      for (const m of f.p.blank.matchAll(re)) {
        const o = m.index ?? 0;
        const reason = this.factoryUseViolation(f, o, factory);
        if (reason !== undefined) this.violation(f, o, reason);
      }
    }
  }

  /** Why the factory name at `o` escapes the scan, or undefined when the use is followed. */
  factoryUseViolation(f: File, o: number, factory: string): string | undefined {
    const s = f.p.blank;
    const before = s.slice(Math.max(0, o - 40), o);
    const after = s.slice(o + factory.length, o + factory.length + 40);
    if (f.ix.imports.some(([x, y]) => x <= o && o < y)) {
      return /^\s+as\b/.test(after) ? `\`${factory}\` is imported under an alias` : undefined;
    }
    if (ENDS_IN_FUNCTION_KEYWORD.test(before) || /\btypeof\s+$/.test(before)) return undefined;
    if (!/^\s*[<(]/.test(after)) return `registrar factory \`${factory}\` is used as a value`;
    if (this.isTopLevelOfInit(f, o) || isKeyedValue(s, o)) return undefined;
    return `registrar factory \`${factory}\`'s result is not bound to a name`;
  }

  /** Every `mutates:` literal must sit in a recognised registration, a table one used, or a const one passed. */
  checkMutates(f: File): void {
    const s = f.p.blank;
    const spans = this.callSpans.get(f.p.rel) ?? [];
    const tables = this.tablesUsed.get(f.p.rel) ?? new Set<number>();
    const inSpan = (o: number): boolean => spans.some(([x, y]) => x < o && o < y);
    const inTable = (o: number): boolean =>
      [...tables].some((open) => open < o && o < matchForward(s, open));
    const inPassedConst = (o: number): boolean =>
      f.ix.declarations.some(
        (d) =>
          d.initStart <= o &&
          o < d.initEnd &&
          spans.some(([x, y]) =>
            new RegExp(String.raw`(?<![\w$.])${escapeRe(d.name)}(?![\w$])`).test(s.slice(x, y)),
          ),
      );
    for (const m of s.matchAll(/(?<![\w$.])mutates\s*:\s*/g)) {
      const o = m.index ?? 0;
      if (!"\"'`".includes(f.p.code.charAt(o + m[0].length))) continue;
      if (!inSpan(o) && !inTable(o) && !inPassedConst(o)) {
        this.violation(f, o, "a `mutates:` write declaration no recognised registration consumes");
      }
    }
  }

  // -- module shapes: how another file reaches an exported registrar --------------------------

  /** Default exports, namespace imports and re-exports, and dynamic imports. */
  checkModuleShapes(f: File): void {
    this.checkDefaultExports(f);
    this.checkNamespaceImports(f);
    this.checkDynamicImports(f);
  }

  /** An exported registrar or forwarder, a registrar factory, or a kit function. */
  isTrackedExport(name: string | null): boolean {
    return (
      name !== null &&
      (this.state.exported.has(name) || this.state.factories.has(name) || this.kits.has(name))
    );
  }

  /** `export default function NAME`: an importer calls NAME under a name of its own choosing. */
  checkDefaultExports(f: File): void {
    for (const m of f.p.blank.matchAll(DEFAULT_EXPORTED_FUNCTION)) {
      const name = m[1] ?? "";
      if (this.isTrackedExport(name)) {
        this.violation(
          f,
          m.index ?? 0,
          `registrar \`${name}\` is a default export, which an importer may bind under any name`,
        );
      }
    }
  }

  /**
   * `import * as kit from` a module that may export a registrar: `kit` may only be read as
   * `kit.member`, which the member flow follows. Re-exporting such a module as a namespace puts it
   * behind a name of the re-exporter's choosing, so that is refused outright.
   */
  checkNamespaceImports(f: File): void {
    const s = f.p.blank;
    for (const m of s.matchAll(NAMESPACE_IMPORT)) {
      const end = (m.index ?? 0) + m[0].length;
      if (this.mayExportRegistrar(f, stringLiteralAt(f.p, end)?.value ?? null)) {
        this.checkModuleObjectUses(f, m[1] ?? "", [m.index ?? 0, end]);
      }
    }
    for (const m of s.matchAll(NAMESPACE_REEXPORT)) {
      const end = (m.index ?? 0) + m[0].length;
      if (this.mayExportRegistrar(f, stringLiteralAt(f.p, end)?.value ?? null)) {
        this.violation(
          f,
          m.index ?? 0,
          `a module that may export a registrar is re-exported as the namespace \`${m[1] ?? ""}\``,
        );
      }
    }
  }

  /**
   * A runtime `import()` / `require()` of a module that may export a registrar must hand its module
   * object to a shape the member flow follows: a destructuring, a name read only as `m.member`, or
   * a `.member` taken on the spot. A discarded one, a side-effect import, reaches no export at all.
   */
  checkDynamicImports(f: File): void {
    const s = f.p.blank;
    for (const d of dynamicImportsOf(f.p)) {
      if (!this.mayExportRegistrar(f, d.spec)) continue;
      const v = dynamicImportValue(s, d);
      if ((v.module && isMemberRead(s, v.end)) || isDiscarded(s, v.start, v.end)) continue;
      const binding = v.module ? this.bindingOf(f, v.start, v.end) : undefined;
      if (binding === "destructuring") continue;
      if (binding === undefined) {
        this.violation(
          f,
          d.at,
          "a dynamic import of a module that may export a registrar is used in a shape the scan does not follow",
        );
      } else {
        this.checkModuleObjectUses(f, binding.name, binding.span);
      }
    }
  }

  /**
   * The declaration whose whole initializer is `[start, end)`: a name, or a destructuring whose
   * every element {@link discoverDestructuredRegistrars} reads. undefined for anything else — a
   * computed key or a rest element included.
   */
  bindingOf(
    f: File,
    start: number,
    end: number,
  ):
    | "destructuring"
    | { readonly name: string; readonly span: readonly [number, number] }
    | undefined {
    const s = f.p.blank;
    const isWhole = (x: number, y: number): boolean =>
      x <= start && end <= y && s.slice(x, start).trim() === "" && s.slice(end, y).trim() === "";
    const d = f.ix.declarations.find((x) => isWhole(x.initStart, x.initEnd));
    if (d !== undefined) return { name: d.name, span: [d.at, d.initStart] };
    const pattern = f.ix.destructurings.find((x) => isWhole(x.rhsStart, x.rhsEnd));
    return pattern !== undefined && isSimplePattern(s, pattern.open) ? "destructuring" : undefined;
  }

  /** Every read of the module object `ns` outside its binding `[from, to)` is `ns.member` or a `typeof`. */
  checkModuleObjectUses(f: File, ns: string, [from, to]: readonly [number, number]): void {
    const s = f.p.blank;
    for (const m of s.matchAll(new RegExp(String.raw`(?<![\w$.])${escapeRe(ns)}(?![\w$])`, "g"))) {
      const o = m.index ?? 0;
      const binding = o >= from && o < to;
      if (!binding && !isMemberRead(s, o + ns.length) && !isTypeofOperand(s, o)) {
        this.violation(
          f,
          o,
          `module object \`${ns}\` may hold a registrar and is used other than as \`${ns}.member\``,
        );
      }
    }
  }

  /**
   * Whether the module a specifier names may export a registrar: a package file that does, or one
   * the scan cannot resolve (a non-literal specifier, a relative path it does not read, a subpath
   * import, the package's own name). Another package (`zod`, `@nimbus-dev/sdk/...`) cannot: the
   * write registrar is this package's consent kit.
   */
  mayExportRegistrar(f: File, spec: string | null): boolean {
    if (spec === null) return true;
    if (spec.startsWith(".")) {
      const target = this.resolveModule(f, spec);
      return target === undefined || this.exportsRegistrar(target);
    }
    return (
      spec.startsWith("#") ||
      spec === CONNECTORS_PACKAGE ||
      spec.startsWith(`${CONNECTORS_PACKAGE}/`)
    );
  }

  /** Whether `f` declares, with `export`, a registrar, forwarder, registrar factory or kit. */
  exportsRegistrar(f: File): boolean {
    return (
      f.ix.fns.some((fn) => fn.exported && this.isTrackedExport(fn.name)) ||
      f.ix.declarations.some((d) => this.isTrackedExport(d.name) && isExportedAt(f.p.blank, d.at))
    );
  }

  /**
   * Every exported registrar, forwarder and registrar factory is NAMED by some file outside its own
   * declaration. One that nothing names is either reached in a shape the scan cannot see — the
   * default import or computed access the checks above refuse, or one nobody anticipated — or dead.
   */
  checkNamed(): void {
    const names = new Set([...this.state.exported.keys(), ...this.state.factories.keys()]);
    for (const name of names) {
      if (this.files.some((g) => namedOutsideDeclaration(g, name))) continue;
      const reason = `registrar \`${name}\` is named nowhere outside its declaration — reached in a shape the scan cannot see, or dead`;
      const site = this.declarationSite(name);
      if (site === undefined) this.violations.push({ file: "(package)", line: 0, reason });
      else this.violation(site.f, site.at, reason);
    }
  }

  /** Where `name` is declared: the first `function name` / `const name` the scan reads. */
  declarationSite(name: string): { readonly f: File; readonly at: number } | undefined {
    const re = new RegExp(String.raw`${DECLARATION_LEAD}${escapeRe(name)}(?![\w$])`);
    for (const f of this.files) {
      const m = re.exec(f.p.blank);
      if (m !== null) return { f, at: m.index };
    }
    return undefined;
  }
}
