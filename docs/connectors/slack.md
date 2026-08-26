# Slack connector — quirks

Migrated from inline comments in `packages/gateway/src/connectors/slack-*.ts` and the `slack` connector in [nimbus-agent/nimbus-mcp-servers](https://github.com/nimbus-agent/nimbus-mcp-servers).

## Entries

### `done_list` → `history` phase transition occurs in the same sync call

**Source:** `packages/gateway/test/unit/connectors/slack-sync.test.ts:516` — added 2026-05-28
**Original comment (excerpt):** `NOTE: production falls from list → history in the same call when done_list returns with non-empty ids. So a single sync call runs both phases for the first channel. We assert the first history call hit C1 (alpha-first after dedup of [C2, C1, C1] -> [C1, C2]).`

The Slack sync state machine transitions from the `list` phase to the `history` phase within a single `sync()` invocation when `done_list` returns a non-empty channel list. This means the first sync call exercises both phases sequentially without requiring a second call. The deduplication step canonicalises channel IDs (so `[C2, C1, C1]` becomes `[C1, C2]` in alphabetical order), and the first history fetch is asserted against the alpha-first channel `C1`. Test harnesses that simulate this flow must prime both the `conversations.list` and the initial `conversations.history` mock responses before invoking a single sync.
