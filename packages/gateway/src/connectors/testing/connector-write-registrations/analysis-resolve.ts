import { AnalysisBase } from "./analysis-base.ts";
import {
  type CallSite,
  callsOf,
  escapeRe,
  type File,
  type IdentResolution,
  NO_CONSTANT,
  REBOUND,
  type RegistrarKind,
  type Resolution,
  type TableRef,
  type Valued,
} from "./analysis-state.ts";
import {
  arrayInitializer,
  bindingsSeenAt,
  blockHolds,
  isShadowed,
  stringInitializer,
} from "./binding-sites.ts";
import {
  enclosingFns,
  type FnInfo,
  type ForOf,
  type NamedImport,
  type Range,
} from "./file-index.ts";
import {
  IDENT_RE,
  innermostOpener,
  lineAt,
  matchForward,
  skipWs,
  splitGroup,
  stringLiteralAt,
} from "./lexical.ts";
import { isExportedAt } from "./module-shapes.ts";
import type { RegistrationTag } from "./package-sources.ts";

export class AnalysisResolve extends AnalysisBase {
  /** Resolve every call of every registrar in `f`; record registrations and new forwarders. */
  scanCalls(f: File): void {
    const s = f.p.blank;
    const spans: Array<readonly [number, number]> = [];
    const visit = (call: CallSite, kind: RegistrarKind): void => {
      const span = [call.open, matchForward(s, call.open)] as const;
      spans.push(span);
      const args = splitGroup(s, call.open);
      const first = args[0];
      if (first === undefined) {
        this.violation(f, call.at, "write-tool registration with no tool-id argument");
        return;
      }
      const r = this.resolveFirstArg(f, call.at, first);
      if (r.kind === "unresolved") {
        this.violation(f, call.at, r.reason);
      } else if (r.kind === "forward") {
        this.recordForwarder(f, call.at, r.fn);
      } else {
        const tags: RegistrationTag[] = [r.tag];
        if (kind !== "root") tags.push(kind);
        const line = lineAt(f.p, call.at);
        for (const { value, origin } of r.ids) {
          this.registrations.push({ id: value, file: f.p.rel, line, origin, tags, span });
        }
      }
    };
    for (const [name, kind] of this.registrarsIn(f)) {
      for (const call of callsOf(s, name, false)) visit(call, kind);
    }
    for (const name of this.memberNames()) {
      const kind = this.memberKind(name) ?? "kit-alias";
      for (const call of callsOf(s, name, true)) visit(call, kind);
    }
    this.callSpans.set(f.p.rel, spans);
  }

  recordForwarder(f: File, at: number, fn: FnInfo): void {
    if (fn.name !== null) {
      const target = fn.exported ? this.state.exported : this.localsOf(f);
      if (!target.has(fn.name)) target.set(fn.name, "forwarder");
      return;
    }
    if (fn.returned) {
      // An anonymous forwarder returned by a function: that function builds registrars.
      const outer = enclosingFns(f.ix, fn.bodyStart - 1).find((g) => g.name !== null);
      if (outer?.name !== undefined && outer.name !== null) {
        if (!this.state.factories.has(outer.name)) this.state.factories.set(outer.name, "factory");
        return;
      }
    }
    this.violation(f, at, "forwards its tool-id parameter from a function the scan cannot name");
  }

  resolveFirstArg(f: File, at: number, [a, b]: readonly [number, number]): Resolution {
    const s = f.p.blank;
    const start = skipWs(s, a);
    const text = f.p.code.slice(start, b).trim();
    const lit = stringLiteralAt(f.p, start);
    if (lit !== null && s.slice(lit.end, b).trim() === "") {
      return { kind: "ids", ids: [{ value: lit.value, origin: f.p.rel }], tag: "literal" };
    }
    if (f.p.code.charAt(start) === "`") return this.resolveTemplate(f, at, start, b);
    if (IDENT_RE.test(text)) {
      const forwarded = enclosingFns(f.ix, at)[0];
      if (forwarded !== undefined && this.forwardsParam(f, at, text, forwarded)) {
        return { kind: "forward", fn: forwarded };
      }
      const r = this.resolveIdent(f, at, text);
      if ("reason" in r) {
        return { kind: "unresolved", reason: `write-tool id \`${text}\` ${r.reason}` };
      }
      return { kind: "ids", ids: r.values, tag: r.tag };
    }
    return {
      kind: "unresolved",
      reason: `write-tool id \`${text.replace(/\s+/g, " ").slice(0, 60)}\` is not a shape the scan resolves`,
    };
  }

  resolveTemplate(f: File, at: number, start: number, end: number): Resolution {
    const s = f.p.blank;
    const close = s.lastIndexOf("`", end - 1);
    let combos: Valued[] = [{ value: "", origin: f.p.rel }];
    let i = start + 1;
    while (i < close) {
      const sub = s.indexOf("${", i);
      const chunkEnd = sub < 0 || sub > close ? close : sub;
      const chunk = f.p.code.slice(i, chunkEnd);
      if (chunk.includes("\\")) return { kind: "unresolved", reason: "template id with an escape" };
      combos = combos.map((c) => ({ value: c.value + chunk, origin: c.origin }));
      if (chunkEnd === close) break;
      const subClose = matchForward(s, sub + 1);
      const expr = s.slice(sub + 2, subClose).trim();
      const resolved = IDENT_RE.test(expr)
        ? this.resolveIdent(f, at, expr)
        : { reason: NO_CONSTANT };
      if ("reason" in resolved) {
        return {
          kind: "unresolved",
          reason: `template id substitution \`${expr}\` ${resolved.reason}`,
        };
      }
      combos = combos.flatMap((c) =>
        resolved.values.map((v) => ({ value: c.value + v.value, origin: v.origin })),
      );
      i = subClose + 1;
    }
    return { kind: "ids", ids: combos, tag: "template" };
  }

  /**
   * Whether `name` at `at` is `fn`'s first parameter, passed on with nothing inside `fn` rebinding
   * it there: the id a forwarder's callers supply.
   */
  forwardsParam(f: File, at: number, name: string, fn: FnInfo): boolean {
    if (fn.params[0]?.name !== name || this.isLoopVar(f, at, name)) return false;
    const read = { own: [fn.paramsAt, fn.bodyStart], scope: [fn.paramsAt, fn.bodyEnd] } as const;
    return !isShadowed(f.ix, name, at, read);
  }

  isLoopVar(f: File, at: number, name: string): boolean {
    return this.loopFor(f, at, name) !== undefined;
  }

  loopFor(f: File, at: number, name: string): { loop: ForOf; key: string | null } | undefined {
    for (const loop of f.ix.loops) {
      if (at < loop.bodyStart || at > loop.bodyEnd) continue;
      if (loop.ident === name) return { loop, key: null };
      const b = loop.pattern.find((x) => x.local === name);
      if (b !== undefined) return { loop, key: b.key };
    }
    return undefined;
  }

  /** The string values `name` takes at `at`: a loop table, kit call-site constants, or a const. */
  resolveIdent(f: File, at: number, name: string): IdentResolution {
    const loop = this.loopFor(f, at, name);
    if (loop !== undefined) return this.loopValues(f, at, name, loop);
    return this.kitOptionValues(f, at, name) ?? this.constantValue(f, at, name);
  }

  /** A loop variable's values — its table's — unless a binding inside the loop rebinds it at `at`. */
  loopValues(
    f: File,
    at: number,
    name: string,
    { loop, key }: { readonly loop: ForOf; readonly key: string | null },
  ): IdentResolution {
    const read = { own: [loop.at, loop.bodyStart], scope: [loop.at, loop.bodyEnd] } as const;
    if (isShadowed(f.ix, name, at, read)) return { reason: REBOUND };
    const values = this.tableValues(f, loop, key);
    return values === null ? { reason: NO_CONSTANT } : { values, tag: "loop" };
  }

  /** A string constant's value at `at`, as one id. */
  constantValue(f: File, at: number, name: string): IdentResolution {
    const value = this.constantString(f, at, name);
    return typeof value === "string"
      ? { values: [{ value, origin: f.p.rel }], tag: "const" }
      : value;
  }

  /**
   * The string `name` holds at `at`: the ONE binding of it a use there can see must be a `const`
   * holding exactly a string literal. Never the value of a same-named constant the use cannot see,
   * or one a parameter or inner declaration shadows.
   */
  constantString(f: File, at: number, name: string): string | { readonly reason: string } {
    const seen = bindingsSeenAt(f.ix, name, at);
    if (seen.length > 1) return { reason: REBOUND };
    const only = seen[0];
    const d = only === undefined ? undefined : f.ix.declarations.find((x) => x.nameAt === only.at);
    const value =
      d !== undefined && blockHolds(f.p.blank, d.at, at) ? stringInitializer(f.p, d) : null;
    return value ?? { reason: NO_CONSTANT };
  }

  /** Each element's `key` value (or each element itself, for `key === null`) of a constant table. */
  tableValues(f: File, loop: ForOf, key: string | null): Valued[] | null {
    const table = this.loopTable(f, loop);
    if (table === undefined || table.open < 0) return null;
    const { host, open } = table;
    let used = this.tablesUsed.get(host.p.rel);
    if (used === undefined) {
      used = new Set();
      this.tablesUsed.set(host.p.rel, used);
    }
    used.add(open);
    const values: Valued[] = [];
    for (const [a, b] of splitGroup(host.p.blank, open)) {
      const v = key === null ? this.literalSpan(host, a, b) : this.propertyLiteral(host, a, key);
      if (v === null) return null;
      values.push({ value: v, origin: host.p.rel });
    }
    return values.length === 0 ? null : values;
  }

  /** The table `loop` iterates — an inline array, or one it names — or undefined, with a violation. */
  loopTable(f: File, loop: ForOf): TableRef | undefined {
    if (loop.iterable === null) return { host: f, open: loop.inlineArray };
    const table = this.boundTable(f, loop, loop.iterable);
    if (typeof table !== "string") return table;
    this.violation(f, loop.at, `loop table \`${loop.iterable}\` ${table}`);
    return undefined;
  }

  /**
   * The constant array a loop names, read through the ONE binding of that name the loop can see: a
   * `const` array `f` declares there, or a named import of one. Never a same-named table another
   * file or another function declares — two connectors can each have an `ACTIONS`, and reading the
   * wrong one derives the wrong ids with no violation at all. Otherwise, why the table cannot be
   * read: no binding is visible at the loop, a second one is (an inner declaration, parameter, loop
   * variable or `catch` binding shadows the table), or the one visible is not a constant array.
   */
  boundTable(f: File, loop: ForOf, name: string): TableRef | string {
    const seen = bindingsSeenAt(f.ix, name, loop.at);
    const only = seen.length === 1 ? seen[0] : undefined;
    if (only === undefined) {
      return seen.length === 0
        ? "is not bound where the loop reads it"
        : "is bound more than once where the loop reads it";
    }
    const imported = f.ix.namedImports.find((i) => i.at === only.at);
    if (imported !== undefined) return this.importedTable(f, imported);
    const d = f.ix.declarations.find((x) => x.nameAt === only.at);
    const open =
      d !== undefined && blockHolds(f.p.blank, d.at, loop.at) ? arrayInitializer(f.p.blank, d) : -1;
    return open < 0
      ? "is not a constant array this file declares or imports by name"
      : { host: f, open };
  }

  /**
   * The array a named import binds. Its module must bind the name exactly once, by declaring it with
   * `export const` at its top level: the binding a module EXPORTS can differ from a same-named
   * private one beside it (`export { WRITES as ACTIONS }`, `export * from`), and a re-export is not
   * followed.
   */
  importedTable(f: File, imported: NamedImport): TableRef | string {
    const spec = imported.spec ?? "";
    const target = spec.startsWith(".") ? this.resolveModule(f, spec) : undefined;
    if (target === undefined) return "is imported from a module the scan does not read";
    const s = target.p.blank;
    const sites = target.ix.bindings.filter((b) => b.name === imported.imported);
    const only = sites.length === 1 ? sites[0] : undefined;
    const d =
      only === undefined ? undefined : target.ix.declarations.find((x) => x.nameAt === only.at);
    const exported = d !== undefined && isExportedAt(s, d.at) && innermostOpener(s, d.at) < 0;
    const open = exported ? arrayInitializer(s, d) : -1;
    return open < 0
      ? "is not one constant array its module declares and exports"
      : { host: target, open };
  }

  literalSpan(f: File, a: number, b: number): string | null {
    const start = skipWs(f.p.blank, a);
    const lit = stringLiteralAt(f.p, start);
    return lit !== null && f.p.blank.slice(lit.end, b).trim() === "" ? lit.value : null;
  }

  /** The literal value of `key` directly inside the object literal starting at/after `a`. */
  propertyLiteral(f: File, a: number, key: string): string | null {
    const s = f.p.blank;
    const open = skipWs(s, a);
    if (s.charAt(open) !== "{") return null;
    for (const [x, y] of splitGroup(s, open)) {
      const m = new RegExp(String.raw`^\s*${escapeRe(key)}\s*:\s*`).exec(s.slice(x, y));
      if (m !== null) return this.literalSpan(f, x + m[0].length, y);
      if (new RegExp(String.raw`^\s*${escapeRe(key)}\s*$`).test(s.slice(x, y))) {
        const value = this.constantString(f, x, key); // the constant the shorthand names there
        return typeof value === "string" ? value : null;
      }
    }
    return null;
  }

  /**
   * `name` destructured from a parameter of an enclosing named function: its values are that
   * property's literal at EVERY call site. `undefined` = not a kit option; a reason = it is one, and
   * a call site does not pin it to a literal, or a binding inside the kit rebinds it at `at`.
   */
  kitOptionValues(f: File, at: number, name: string): IdentResolution | undefined {
    for (const fn of enclosingFns(f.ix, at)) {
      const option = this.optionOf(f, fn, name, at);
      if (option === undefined) continue;
      if (fn.name === null) return { reason: NO_CONSTANT };
      if (isShadowed(f.ix, name, at, { own: option.own, scope: [fn.paramsAt, fn.bodyEnd] })) {
        return { reason: REBOUND };
      }
      this.kits.add(fn.name);
      return this.kitCallValues(f, fn, option);
    }
    return undefined;
  }

  /** A kit option's values: the property's literal at every call of the kit. */
  kitCallValues(
    f: File,
    fn: FnInfo,
    option: { readonly paramIndex: number; readonly key: string },
  ): IdentResolution {
    const calls = this.kitCalls(f, fn);
    if (calls.length === 0) return { reason: NO_CONSTANT };
    const values: Valued[] = [];
    for (const { g, c } of calls) {
      const arg = splitGroup(g.p.blank, c.open)[option.paramIndex];
      const v = arg === undefined ? null : this.propertyLiteral(g, arg[0], option.key);
      if (v === null) return { reason: NO_CONSTANT };
      values.push({ value: v, origin: g.p.rel });
    }
    return { values, tag: "const" };
  }

  /**
   * Every call of the kit function `fn` (declared in `f`): bare calls in its own file and, when it is
   * exported, bare or member calls in any file (`mailKit.registerEmailConnectorTools(...)` through
   * a namespace import).
   */
  kitCalls(f: File, fn: FnInfo): Array<{ readonly g: File; readonly c: CallSite }> {
    const name = fn.name ?? "";
    return this.files.flatMap((g) => {
      if (g !== f && !fn.exported) return [];
      const members = fn.exported ? callsOf(g.p.blank, name, true) : [];
      return [...callsOf(g.p.blank, name, false), ...members].map((c) => ({ g, c }));
    });
  }

  /**
   * How `fn` binds `name` from one of its parameters, as seen at `at`: which parameter, under which
   * key, and where the binding is written (`own`) — a pattern in the parameter list, or a
   * destructuring of the parameter whose block holds `at`.
   */
  optionOf(
    f: File,
    fn: FnInfo,
    name: string,
    at: number,
  ): { paramIndex: number; key: string; own: Range } | undefined {
    for (const [i, param] of fn.params.entries()) {
      const b = param.pattern.find((x) => x.local === name);
      if (b !== undefined) return { paramIndex: i, key: b.key, own: [fn.paramsAt, fn.bodyStart] };
    }
    const s = f.p.blank;
    for (const d of f.ix.destructurings) {
      if (d.at < fn.bodyStart || d.at > fn.bodyEnd || !blockHolds(s, d.at, at)) continue;
      const b = d.bindings.find((x) => x.local === name);
      const rhs = s.slice(d.rhsStart, d.rhsEnd).trim();
      const paramIndex = fn.params.findIndex((p) => p.name === rhs);
      if (b !== undefined && paramIndex >= 0) {
        return { paramIndex, key: b.key, own: [d.open, matchForward(s, d.open)] };
      }
    }
    return undefined;
  }

  // -- fail-closed checks ---------------------------------------------------------------------
}
