# Storybook Connector

## What this is

Nimbus MCP connector for **Storybook** (the Tier-5 local connector class). It
indexes the story-level metadata from a local Storybook manifest — the
`index.json` (Storybook v7+) or legacy `stories.json` (v6) that `storybook build`
writes to disk — as `storybook:story` items. This gives design-system component
coverage and lets you recall *"which stories cover the Button component"* from
the local index.

By design this connector is a **pure, local filesystem read** of one JSON
manifest:

- **No browser** — it never launches a browser.
- **No dev-server connection** — it reads the static manifest only.
- **No code execution** — component/story code is never run.

Each indexed item carries the story id, component title, story name, import
path, tags, and entry type.

## Install

Bundled with Nimbus — no separate install required. No runtime dependencies
beyond the MCP SDK.

## Quickstart

Build your Storybook (`storybook build`) so it emits a manifest, then point the
connector at the output directory (e.g. `storybook-static`):

```bash
nimbus connector auth storybook
nimbus ask "which Storybook stories cover the Button component?"
```

The configured directory (`storybook.dir`) is added to the sandbox filesystem
read allow-list at spawn time; the connector has no network access.

## Tools

- `storybook_list` — list stories (id, component title, story name, import path, tags, type).
- `storybook_get` — fetch one story by its Storybook id.
- `storybook_search` — substring search over story id / title / name / tags.

## See also

- [Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
