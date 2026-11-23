/**
 * Test support for the I26 connector-write sync guard (`../connector-write-sync.test.ts`).
 *
 * Reads the INSTALLED `@nimbus-dev/connectors` source as TEXT and derives every tool id the
 * connectors register through the consent kit's write registrar, so the gateway's I26 predicate
 * (`isConnectorWriteToolId`) can be checked against what the connectors actually treat as writes.
 * It never imports the package: the gateway's one import from it is `setConnectorMode`.
 *
 * Registrations are found by DATA FLOW from the consent kit's `createWriteToolRegistrar`, never by a
 * naming convention. connectors 0.2.2 already forwards writes through `registerStatusTool`,
 * `registerPipelineActionTool` and `registerFeedbackTool`, so a `register*WriteTool(` pattern would
 * miss every tool added through them.
 *
 * The flow it follows: a name bound to a registrar factory (`createWriteToolRegistrar`, or a kit
 * factory discovered by the forwarding arrow it returns) is a registrar; so is an alias of one, a
 * property it is handed off under (`{ registerWriteTool }`, `opts.registerWriteTool`), any property
 * or parameter typed `*WriteToolRegistrar`, and any function that forwards its FIRST parameter to a
 * registrar, whatever it is called. Calls of those names are registrations. A shared KIT — a
 * function that builds each registered id from an option its caller passes
 * (`registerEmailConnectorTools({ toolPrefix, registerWriteTool })`) — registers one id per call
 * site, read from that call. An EXPORTED registrar, forwarder, factory or kit is followed through
 * every import shape that keeps its name: a named import, a member of a namespace or dynamic import
 * (`kit.registerStatusTool(...)`, or an alias of that member), and a destructuring that takes it,
 * renamed or not (`const { registerStatusTool: reopen } = await import("./status.ts")`).
 *
 * Every identifier an id is read through — a loop's table, a string constant, a loop variable, a kit
 * option, a forwarded parameter — is read through the ONE binding of that name its use can see,
 * never by name alone: two connectors can each declare an `ACTIONS`, and a parameter can shadow a
 * module-level constant. Which bindings a use can see comes from a census of every way a file binds
 * a name (below), and a table or constant counts only when it is a `const` holding exactly an array
 * or string literal (`as const` allowed).
 *
 * Every shape the scan cannot follow is a VIOLATION rather than a silent skip:
 *
 *   - a registration whose tool id is not a literal, a template over constants, a loop over a
 *     constant table, or a string constant;
 *   - an identifier a second binding of its name may shadow where it is used, or whose one visible
 *     binding is not a value the scan reads. A loop table must be a `const` array declared where the
 *     loop can see it, or a named import of one its module declares once, with `export const`; an
 *     import from a module the scan does not read, a re-export, an `export { ... }` clause and a
 *     `let` are each refused;
 *   - a registrar used as a value anywhere the flow above does not follow: passed positionally,
 *     stored in an array, listed in an `export { ... }` clause or an aliased import, or read off an
 *     object and neither called nor bound;
 *   - a registrar factory whose result is not bound to a name or handed off under a property key;
 *   - a kit used other than by a call, its declaration or a plain (unaliased) import — its callers
 *     decide the ids it registers, so a caller reaching it any other way would go unseen;
 *   - a registrar, forwarder, factory or kit exported as the DEFAULT, which an importer binds under
 *     a name of its own choosing;
 *   - a namespace import of a module that exports one, used other than as `ns.member`; that module
 *     re-exported as a namespace; and a dynamic `import()` / `require()` of it that is not
 *     destructured, bound to a name used only as `m.member`, or dereferenced on the spot. A module
 *     specifier the scan cannot resolve (a non-literal, or a package path it does not read) counts
 *     as one that may export a registrar;
 *   - a string literal equal to a registrar, forwarder, factory or registrar-key name: a computed
 *     member access such as `regs["registerWriteTool"]`;
 *   - an exported registrar, forwarder or factory that no file names outside its own declaration,
 *     which is either reached in a shape the scan cannot see or dead;
 *   - a `mutates:` literal (the action type `WriteToolConfig` requires of every write) that no
 *     recognised registration consumes, which is how a registration in an unrecognised shape shows
 *     up even when nothing else about it does;
 *   - a file whose brackets do not balance after stripping, i.e. the stripper lost its place.
 *
 * STATED BOUND, what it still cannot see: an object a registrar was handed off into, read other than
 * by its key — a computed member access whose key is NOT a string literal (`regs[key](...)`), or
 * reflection over the object (`Object.values(regs)`). The `mutates:` check catches such a call only
 * when the call itself carries a `mutates:` literal, which a positional forwarder's call does not. A
 * tool that mutates while registered as a READ is outside the scan altogether. And a constant table
 * MUTATED after its declaration (`ACTIONS.push(...)`) is read as declared: the `mutates:` cross-check
 * catches the push only when the pushed element carries a `mutates:` literal.
 *
 * The binding census is a text scan. It records every declarator of a `const` / `let` / `var` /
 * `using` declaration (initialised or not, nested, rest and array patterns included), the parameters
 * of functions, arrows and methods, `catch` bindings, every form of import, and function, class,
 * enum and namespace names. Where a use can see each one is over-approximated — a block-scoped
 * declaration counts across its whole function — so the scan refuses some shadowing a type checker
 * would resolve rather than resolve any it cannot rule out.
 *
 * The implementation lives in `./connector-write-registrations/`: `package-sources.ts` (the public
 * types and the package reader), `lexical.ts`, `file-index.ts`, `binding-sites.ts` and
 * `analysis-state.ts` (the text and census helpers), `analysis-base.ts`, `analysis-resolve.ts` and
 * `analysis-checks.ts` (the analysis, one class split across three by inheritance), `module-shapes.ts`
 * and `scan.ts` (the entry point). This file only re-exports the public surface.
 */
export {
  CONNECTORS_PACKAGE,
  installedConnectorsPackageRoot,
  type PackageSource,
  type RegistrationTag,
  ROOT_REGISTRAR_FACTORY,
  readConnectorPackageSources,
  type ScanViolation,
  type WriteToolRegistration,
  type WriteToolScan,
} from "./connector-write-registrations/package-sources.ts";
export { scanWriteToolRegistrations } from "./connector-write-registrations/scan.ts";
