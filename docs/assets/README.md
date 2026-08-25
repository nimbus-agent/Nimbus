# `docs/assets/` — README asset regeneration

Every artifact here is a committed render — CI verifies the OG card stays in sync ([`.github/workflows/docs-quality.yml`](../../.github/workflows/docs-quality.yml) `og-card-render` job), and the hero cast SVGs are checked in alongside their source recording. Nothing here is regenerated on every build.

## Hero cast (`hero-cast-{light,dark}.svg`)

> **NOT EMBEDDED — pulled from `docs/README.md` on 2026-08-25.** The SVGs and the
> `.cast` they render from are still here, and `record-casts` still checks them, but
> nothing displays them.
>
> The recording is driven by a fake gateway, and the brief it replays was written by
> hand rather than captured: a `| Lane | Evidence |` table citing PR #214, ticket
> AUTH-88 and incident INC-31. None of that comes from the product — the string
> `Lane | Evidence` appears in exactly one file in this repository,
> `scripts/cast-driver/fixtures/zero-config/events.json`, and nowhere in production
> source. A real `nimbus why` emits `# Why` -> `## Authorship` -> `## Gaps`, and the
> recorded sequence itself fails on a real machine, because `nimbus init --no-sync`
> starts no gateway.
>
> Re-embed only after the fixture is rebuilt from output captured against a REAL
> gateway. The fake gateway is fine as a transport; the brief it replays is not fine
> as prose someone wrote.

Rendered from [`../demos/zero-config.cast`](../demos/zero-config.cast) (an [asciinema](https://asciinema.org/) recording) into two animated standalone SVGs. The README embeds them via `<picture>` with `prefers-color-scheme` to switch between solarized-light and solarized-dark palettes.

### Rerendering

Run [`scripts/render-hero-cast.ts`](../../scripts/render-hero-cast.ts):

```bash
bun run render:hero-cast
```

This reads the canonical `.cast` (does NOT modify it), pipes it through `termsvg`, and writes both the light + dark SVGs. Pass a demo name to render a different one — `bun run render:hero-cast incident-response`; the default is `zero-config`.

#### Prerequisite — install `termsvg`

We use [`termsvg`](https://github.com/MrMarble/termsvg) — a Go CLI that reads asciinema's `.cast` format and emits a standalone animated SVG. It replaces the unmaintained `svg-term-cli` we used during initial authoring (its transitive tree pulled in 11 unlicensed packages + 6 HIGH/CRITICAL CVEs).

Option 1 — release binary (recommended on Windows):

1. Download `termsvg-<version>-<os>-<arch>.zip` from [the releases page](https://github.com/MrMarble/termsvg/releases/latest).
2. Verify against `termsvg-<version>-checksums.txt` (also on the release page).
3. Extract and put `termsvg` (or `termsvg.exe`) on your `$PATH`.

Option 2 — Go install (requires Go on `$PATH`):

```bash
go install github.com/mrmarble/termsvg/cmd/termsvg@latest
```

#### Tuning the dwell schedule

Reading pauses normally come from the cast itself: the cast driver paces events at record time via `pacingSeconds` in the demo's YAML, because a captured cast has only a few hundred ms between events (it comes from a fake-gateway test run). A cast recorded that way needs no schedule and is rendered with its own timings.

`incident-response` predates `pacingSeconds` and is the one demo still re-timed at render time, by the `schedule` array in its `DEMOS` entry in [`scripts/render-hero-cast.ts`](../../scripts/render-hero-cast.ts). If you add or remove one of its cast events, update that array's length to match — the script fails fast if they disagree. Total animation length = last event time + `TRAILING_PAD_SECONDS`.

Sanity check the result by opening each SVG in a browser — it should play automatically, loop infinitely, and each text block should be readable. Each file should land in the 10–30 KiB range; significantly smaller means the cast didn't render properly.

### Licensing note

`termsvg` is GPL-3.0. It is a **build-time CLI tool** — not bundled, not redistributed, and the SVG output is data, not derivative work of the renderer (no GPL'd code from termsvg is copied into the output). The dual-license model documented in [`../license-policy.md`](../license-policy.md) governs npm/Bun dependencies in `node_modules/`; a Go binary on a maintainer's `$PATH` is outside that scope, the same way `git`, `bun`, or `bash` are.

## OG card (`og-card.svg` → `../og-card.png`)

Source SVG is hand-authored (1200×630, JetBrains Mono). The PNG is rendered deterministically by [`scripts/render-og-card.ts`](../../scripts/render-og-card.ts) using `@resvg/resvg-js` with `loadSystemFonts: false`, so the output is byte-identical across machines.

Regenerate after editing `og-card.svg`:

```bash
bun run render:og-card
```

The `og-card-render` CI job runs the same command and fails if the committed PNG drifts.

## Fonts (`fonts/`)

[JetBrains Mono](https://www.jetbrains.com/lp/mono/) v2.304 (Regular + Bold), [SIL OFL 1.1](./fonts/LICENSE-OFL-1.1.txt). Used only by the OG card renderer.

## Wordmarks (`nimbus-wordmark-{light,dark}.svg`) and architecture diagrams (`architecture-{light,dark}.svg`)

Hand-authored SVGs — no renderer, no regeneration step. Edit in place.

## Connector logos (`connectors/`)

Trimmed/normalised brand SVGs. See [`connectors/README.md`](./connectors/README.md) for source attribution.
