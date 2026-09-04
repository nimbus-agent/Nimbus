import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_FRAMES,
  DEFAULT_VLM_BASE_URL,
  DEFAULT_VLM_MODEL,
  loadMultimodalConfig,
  MultimodalConfigError,
} from "./multimodal-config.ts";

function withToml(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-mm-cfg-"));
  writeFileSync(join(dir, "nimbus.toml"), body, "utf8");
  return dir;
}

describe("loadMultimodalConfig", () => {
  test("no configDir is OFF with defaults", () => {
    const cfg = loadMultimodalConfig(undefined);
    expect(cfg.enabled).toBe(false);
    expect(cfg.vlmBaseUrl).toBe(DEFAULT_VLM_BASE_URL);
    expect(cfg.vlmModel).toBe(DEFAULT_VLM_MODEL);
    expect(cfg.maxFrames).toBe(DEFAULT_MAX_FRAMES);
  });

  test("absent section is OFF", () => {
    expect(loadMultimodalConfig(withToml("[llm]\nprefer_local = true\n")).enabled).toBe(false);
  });

  test("reads all four keys, comments stripped", () => {
    const dir = withToml(
      [
        "[multimodal]",
        "enabled = true # on locally",
        // Loopback but distinct from DEFAULT_VLM_BASE_URL's port: proves the key is actually
        // read (not just defaulted through) without tripping the non-loopback refusal below —
        // a remote host cannot be used for this any more (see the describe block below).
        'vlm_base_url = "http://127.0.0.1:9999"',
        'vlm_model = "qwen2.5vl:7b"',
        "max_frames = 4",
      ].join("\n"),
    );
    const cfg = loadMultimodalConfig(dir);
    expect(cfg.enabled).toBe(true);
    expect(cfg.vlmBaseUrl).toBe("http://127.0.0.1:9999");
    expect(cfg.vlmModel).toBe("qwen2.5vl:7b");
    expect(cfg.maxFrames).toBe(4);
  });

  test("a later section ends the block", () => {
    const dir = withToml("[multimodal]\nenabled = true\n\n[llm]\nmax_frames = 99\n");
    const cfg = loadMultimodalConfig(dir);
    expect(cfg.enabled).toBe(true);
    expect(cfg.maxFrames).toBe(DEFAULT_MAX_FRAMES);
  });

  test("max_frames is clamped to a sane range, never zero or absurd", () => {
    expect(loadMultimodalConfig(withToml("[multimodal]\nmax_frames = 0\n")).maxFrames).toBe(1);
    expect(loadMultimodalConfig(withToml("[multimodal]\nmax_frames = 9999\n")).maxFrames).toBe(64);
    expect(loadMultimodalConfig(withToml("[multimodal]\nmax_frames = nonsense\n")).maxFrames).toBe(
      DEFAULT_MAX_FRAMES,
    );
  });

  test("a malformed file reads as OFF, never as on", () => {
    const dir = withToml("[multimodal\nenabled = true\n");
    expect(loadMultimodalConfig(dir).enabled).toBe(false);
  });

  test("malformed TOML INSIDE a valid section fails the whole load off, not just the one line", () => {
    // Pre-fix, a garbage line with no `=` was `continue`d past, silently, leaving the
    // already-parsed `enabled = true` above it in effect — verified empirically before this fix.
    const dir = withToml("[multimodal]\nenabled = true\nnot valid toml\n");
    const cfg = loadMultimodalConfig(dir);
    expect(cfg.enabled).toBe(false);
    expect(cfg.maxFrames).toBe(DEFAULT_MAX_FRAMES);
  });

  test("max_frames with trailing garbage does not parse as its numeric prefix", () => {
    // Pre-fix, `Number.parseInt("8junk", 10)` returned 8 — verified empirically before this fix.
    // Trailing garbage on a value is malformed TOML, so the whole load fails off, same as the
    // no-`=` case above.
    const dir = withToml("[multimodal]\nenabled = true\nmax_frames = 8junk\n");
    const cfg = loadMultimodalConfig(dir);
    expect(cfg.enabled).toBe(false);
    expect(cfg.maxFrames).toBe(DEFAULT_MAX_FRAMES);
  });

  test("an unrecognised but well-formed key is ignored (forward-compatibility), not a fail-off", () => {
    const dir = withToml("[multimodal]\nenabled = true\nfuture_key = 1\n");
    const cfg = loadMultimodalConfig(dir);
    expect(cfg.enabled).toBe(true);
    expect(cfg.maxFrames).toBe(DEFAULT_MAX_FRAMES);
  });

  test("a malformed line OUTSIDE the multimodal section never affects it", () => {
    const dir = withToml(
      "[llm]\nnot valid toml at all in this unrelated section\n\n[multimodal]\nenabled = true\n",
    );
    const cfg = loadMultimodalConfig(dir);
    expect(cfg.enabled).toBe(true);
  });

  test("parses fetch_budget_bytes and prefer_renditions", () => {
    const dir = withToml(
      "[multimodal]\nenabled = true\nfetch_budget_bytes = 4294967296\nprefer_renditions = true\n",
    );
    const cfg = loadMultimodalConfig(dir);
    expect(cfg.fetchBudgetBytes).toBe(4294967296);
    expect(cfg.preferRenditions).toBe(true);
  });

  test("defaults are 2 GiB and originals", () => {
    const cfg = loadMultimodalConfig(withToml("[multimodal]\nenabled = true\n"));
    expect(cfg.fetchBudgetBytes).toBe(2 * 1024 * 1024 * 1024);
    expect(cfg.preferRenditions).toBe(false);
  });

  test("a malformed budget fails the load off, matching enabled/max_frames", () => {
    const cfg = loadMultimodalConfig(
      withToml("[multimodal]\nenabled = true\nfetch_budget_bytes = lots\n"),
    );
    expect(cfg.enabled).toBe(false);
  });

  test("a negative budget fails the load off (semantically malformed)", () => {
    const cfg = loadMultimodalConfig(
      withToml("[multimodal]\nenabled = true\nfetch_budget_bytes = -1024\n"),
    );
    expect(cfg.enabled).toBe(false);
  });

  test("zero budget is accepted and means no cloud bytes may be fetched", () => {
    const cfg = loadMultimodalConfig(
      withToml("[multimodal]\nenabled = true\nfetch_budget_bytes = 0\n"),
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.fetchBudgetBytes).toBe(0);
  });

  test("a malformed prefer_renditions fails the load off", () => {
    const cfg = loadMultimodalConfig(
      withToml("[multimodal]\nenabled = true\nprefer_renditions = maybe\n"),
    );
    expect(cfg.enabled).toBe(false);
  });

  test("a configDir with no nimbus.toml at all is OFF with defaults", () => {
    // No writeFileSync here, deliberately: an empty dir exercises the
    // `!existsSync(tomlPath)` branch, distinct from every other test's withToml-created file.
    const dir = mkdtempSync(join(tmpdir(), "nimbus-mm-cfg-"));
    const cfg = loadMultimodalConfig(dir);
    expect(cfg.enabled).toBe(false);
    expect(cfg.vlmBaseUrl).toBe(DEFAULT_VLM_BASE_URL);
    expect(cfg.vlmModel).toBe(DEFAULT_VLM_MODEL);
    expect(cfg.maxFrames).toBe(DEFAULT_MAX_FRAMES);
  });

  test("the default (no vlm_base_url set) never triggers the refusal", () => {
    const dir = withToml("[multimodal]\nenabled = true\n");
    expect(() => loadMultimodalConfig(dir)).not.toThrow();
    expect(loadMultimodalConfig(dir).vlmBaseUrl).toBe(DEFAULT_VLM_BASE_URL);
  });

  test("an unquoted vlm_model value fails the whole load off, never accepted as the literal string", () => {
    // TOML requires string values to be quoted. `unquote` used to fall back to the raw trimmed
    // text for anything that wasn't a clean `"..."`/`'...'` pair, so this malformed line was
    // silently accepted as the model id `llava-unquoted` instead of failing the section off —
    // verified empirically before this fix.
    const dir = withToml("[multimodal]\nenabled = true\nvlm_model = llava-unquoted\n");
    const cfg = loadMultimodalConfig(dir);
    expect(cfg.enabled).toBe(false);
    expect(cfg.vlmModel).toBe(DEFAULT_VLM_MODEL);
  });

  test("an unquoted vlm_base_url value fails the whole load off", () => {
    const dir = withToml("[multimodal]\nenabled = true\nvlm_base_url = 127.0.0.1:11434\n");
    const cfg = loadMultimodalConfig(dir);
    expect(cfg.enabled).toBe(false);
    expect(cfg.vlmBaseUrl).toBe(DEFAULT_VLM_BASE_URL);
  });

  test("an unbalanced (never-closed) quote fails the whole load off", () => {
    const dir = withToml('[multimodal]\nenabled = true\nvlm_model = "unterminated\n');
    const cfg = loadMultimodalConfig(dir);
    expect(cfg.enabled).toBe(false);
    expect(cfg.vlmModel).toBe(DEFAULT_VLM_MODEL);
  });

  test("a mismatched quote pair (opens double, closes single) fails the whole load off", () => {
    const dir = withToml("[multimodal]\nenabled = true\nvlm_model = \"mismatched'\n");
    const cfg = loadMultimodalConfig(dir);
    expect(cfg.enabled).toBe(false);
    expect(cfg.vlmModel).toBe(DEFAULT_VLM_MODEL);
  });

  test("an explicitly empty quoted value fails the whole load off rather than keeping the default silently", () => {
    const dir = withToml('[multimodal]\nenabled = true\nvlm_model = ""\n');
    const cfg = loadMultimodalConfig(dir);
    expect(cfg.enabled).toBe(false);
    expect(cfg.vlmModel).toBe(DEFAULT_VLM_MODEL);
  });

  test("correctly double- or single-quoted values still parse", () => {
    const dblDir = withToml('[multimodal]\nenabled = true\nvlm_model = "llava-quoted"\n');
    expect(loadMultimodalConfig(dblDir).vlmModel).toBe("llava-quoted");
    expect(loadMultimodalConfig(dblDir).enabled).toBe(true);

    const sglDir = withToml("[multimodal]\nenabled = true\nvlm_model = 'llava-quoted'\n");
    expect(loadMultimodalConfig(sglDir).vlmModel).toBe("llava-quoted");
    expect(loadMultimodalConfig(sglDir).enabled).toBe(true);
  });
});

describe("loadMultimodalConfig — non-loopback vlm_base_url is refused LOUDLY", () => {
  test("a well-formed but non-loopback vlm_base_url throws, naming the value and the reason", () => {
    const dir = withToml('[multimodal]\nvlm_base_url = "http://gpu-box.lan:11434"\n');
    expect(() => loadMultimodalConfig(dir)).toThrow(MultimodalConfigError);
    let caught: unknown;
    try {
      loadMultimodalConfig(dir);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MultimodalConfigError);
    const message = caught instanceof Error ? caught.message : "";
    // Names the offending value verbatim...
    expect(message).toContain("http://gpu-box.lan:11434");
    // ...and the reason: no per-artifact grant exists in this release.
    expect(message).toContain("per-artifact grant");
    expect(message).toContain("this release");
  });

  test("never silently substitutes defaults() for a non-loopback value", () => {
    // The bug this fix closes: a caller that only checked `.enabled` or `.vlmBaseUrl` after a
    // catch-all would see the loopback default and never learn their setting was ignored. There
    // must be no return path here at all — only the throw.
    const dir = withToml('[multimodal]\nvlm_base_url = "http://10.0.0.5:11434"\n');
    expect(() => loadMultimodalConfig(dir)).toThrow();
  });

  test("rejects a bare IP outside 127.0.0.0/8, an unresolvable hostname, and an IPv4-mapped non-loopback address alike", () => {
    for (const url of [
      "http://8.8.8.8:11434",
      "http://vlm.example.com:11434",
      "http://[::ffff:8.8.8.8]:11434",
    ]) {
      const dir = withToml(`[multimodal]\nvlm_base_url = "${url}"\n`);
      expect(() => loadMultimodalConfig(dir)).toThrow(MultimodalConfigError);
    }
  });

  test("loopback forms are all still accepted: 127.0.0.1, the whole 127.0.0.0/8 block, localhost, and [::1]", () => {
    for (const url of [
      "http://127.0.0.1:11434",
      "http://127.5.5.5:11434",
      "http://localhost:11434",
      "http://[::1]:11434",
    ]) {
      const dir = withToml(`[multimodal]\nvlm_base_url = "${url}"\n`);
      expect(() => loadMultimodalConfig(dir)).not.toThrow();
      expect(loadMultimodalConfig(dir).vlmBaseUrl).toBe(url);
    }
  });

  test("a properly quoted non-loopback vlm_base_url still THROWS — the new quoting guard must not swallow it into a fail-off", () => {
    // The interaction most likely to break by this fix: `unquote` returning `undefined` for a
    // MALFORMED value must not be confused with a well-formed-but-refused value. A correctly
    // quoted non-loopback host parses fine (`unquote` returns its content) and must still reach
    // `requireLoopbackVlmBaseUrl`, which throws — never `defaults()`. Checked with both quote
    // styles since the quoting guard now accepts either.
    for (const dir of [
      withToml('[multimodal]\nvlm_base_url = "http://gpu-box.lan:11434"\n'),
      withToml("[multimodal]\nvlm_base_url = 'http://gpu-box.lan:11434'\n"),
    ]) {
      expect(() => loadMultimodalConfig(dir)).toThrow(MultimodalConfigError);
    }
  });

  test("malformed-config fail-off still wins when the same file also has a non-loopback vlm_base_url", () => {
    // The two rules must not collide: a line the parser cannot understand at all fails the WHOLE
    // section off to defaults() (per 0c169ea9), even when a later line in the same section names
    // a non-loopback vlm_base_url that would otherwise throw. Malformed-TOML detection happens
    // inside parseSection's try, before requireLoopbackVlmBaseUrl is ever reached.
    const dir = withToml(
      '[multimodal]\nenabled = true\nnot valid toml\nvlm_base_url = "http://gpu-box.lan:11434"\n',
    );
    expect(() => loadMultimodalConfig(dir)).not.toThrow();
    const cfg = loadMultimodalConfig(dir);
    expect(cfg.enabled).toBe(false);
    expect(cfg.vlmBaseUrl).toBe(DEFAULT_VLM_BASE_URL);
  });
});
