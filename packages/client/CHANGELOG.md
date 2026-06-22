# @nimbus-dev/client Changelog

All notable changes to `@nimbus-dev/client` are documented in this file. release-please appends new entries between this header and the most recent version below when a release PR merges.

## [0.2.4](https://github.com/nimbus-agent/Nimbus/compare/client-v0.2.3...client-v0.2.4) (2026-06-22)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @nimbus-dev/sdk bumped to 1.2.0

## [0.2.3](https://github.com/nimbus-agent/Nimbus/compare/client-v0.2.2...client-v0.2.3) (2026-06-15)


### Bug Fixes

* **client:** bundle sdk via the "bun" condition so the publish build resolves ([#638](https://github.com/nimbus-agent/Nimbus/issues/638)) ([c1f36d2](https://github.com/nimbus-agent/Nimbus/commit/c1f36d2e1cee0f02430aab5f48e517a9882ccf4d))

## [0.2.2](https://github.com/nimbus-agent/Nimbus/compare/client-v0.2.1...client-v0.2.2) (2026-06-14)


### Bug Fixes

* add repository field to client, sdk, and root for npm provenance ([#633](https://github.com/nimbus-agent/Nimbus/issues/633)) ([f0e7f07](https://github.com/nimbus-agent/Nimbus/commit/f0e7f075d755c8b4a006911b513979f289fa192f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @nimbus-dev/sdk bumped to 1.1.2

## [0.2.1](https://github.com/nimbus-agent/Nimbus/compare/client-v0.2.0...client-v0.2.1) (2026-06-14)


### Bug Fixes

* **client:** widen node-compat askStream streamId poll to STREAM_TIMEOUT_MS ([#624](https://github.com/nimbus-agent/Nimbus/issues/624)) ([e86014f](https://github.com/nimbus-agent/Nimbus/commit/e86014f3ae3b2a865a0e589eda2eb997b33ca727))

## [0.2.0] - 2026-05-13

- Pre-automation snapshot. The `0.2.0` version was bumped in `package.json` ahead of the first automated release; no `client-v0.2.0` tag was published. The next release-please-managed entry will prepend above this line.
