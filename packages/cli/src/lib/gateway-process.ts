// Re-export facade for the gateway state/process helpers.
//
// The real implementation lives in `./gateway-process-core.ts`. This thin facade
// is the module specifier that the 40+ CLI command modules import AND that
// `test/helpers/cli-mocks.ts` stubs via `mock.module(".../gateway-process.ts")`.
// Because Bun's `mock.module` is process-global, a command test that loads
// cli-mocks would otherwise clobber this module for `gateway-process.test.ts`
// in the combined `bun test packages/cli/src` run. Keeping the implementation in
// the un-mocked `-core` module lets that test exercise the real functions while
// command tests still receive the stub through this facade. Do NOT inline the
// implementation back here.
export * from "./gateway-process-core.ts";
