/**
 * Test preload — a test gateway must not reap AppContainer profiles it does not own.
 *
 * Registered as `[test] preload` in bunfig.toml beside `hermetic-credentials.ts`, so it runs before
 * every test file, and the variable it sets is inherited by every gateway a test spawns.
 *
 * Why. On Windows every non-demo gateway boot runs `reapAppContainersAtBoot`
 * (`packages/gateway/src/platform/sandbox/win32-reap.ts`), which deletes each `nimbus-ext-*`
 * AppContainer profile its own index does not know. Profiles are per USER, so under
 * `bun test --parallel` one test's gateway boot deleted the profiles of other tests' in-flight tool
 * spawns and confinement probes on the same runner (the toolgen tests' intermittent
 * `ERR_TOOLGEN_SANDBOX_DEGRADED` refusals and timeouts on the Windows legs), and on a developer's
 * machine it would delete the real gateway's live profiles. Skipping the reap only removes
 * cleanup; the tests that exercise the reap itself inject their own environment.
 */

process.env["NIMBUS_SKIP_APPCONTAINER_REAP"] = "1";
