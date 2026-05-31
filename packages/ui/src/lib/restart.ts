import { invoke } from "@tauri-apps/api/core";

export async function restartApp(): Promise<void> {
  try {
    await invoke("plugin:app|restart");
  } catch {
    if (globalThis.location !== undefined) {
      globalThis.location.reload();
    }
  }
}
