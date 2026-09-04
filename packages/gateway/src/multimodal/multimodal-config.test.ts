import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_FRAMES,
  DEFAULT_VLM_BASE_URL,
  DEFAULT_VLM_MODEL,
  loadMultimodalConfig,
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
        // Deliberately non-loopback and distinct from DEFAULT_VLM_BASE_URL: proves the key
        // is actually read (not just defaulted through), and documents that a remote VLM host
        // is accepted here — the later locality invariant derives isLocal from this resolved
        // URL, never from the vendor/model name.
        'vlm_base_url = "http://gpu-box.lan:11434"',
        'vlm_model = "qwen2.5vl:7b"',
        "max_frames = 4",
      ].join("\n"),
    );
    const cfg = loadMultimodalConfig(dir);
    expect(cfg.enabled).toBe(true);
    expect(cfg.vlmBaseUrl).toBe("http://gpu-box.lan:11434");
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
});
