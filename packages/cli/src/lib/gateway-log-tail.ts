import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export class GatewayLogTailer {
  private offset: number;

  constructor(startOffset = 0) {
    this.offset = startOffset;
  }

  pollLatest(logPath: string): string | null {
    let fd: number;
    try {
      fd = openSync(logPath, "r");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
    try {
      const size = fstatSync(fd).size;
      if (size <= this.offset) {
        return null;
      }
      const len = size - this.offset;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, this.offset);
      const text = buf.toString("utf8");
      const lastNl = text.lastIndexOf("\n");
      if (lastNl < 0) {
        return null;
      }
      this.offset += lastNl + 1;
      const lines = text.slice(0, lastNl).split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim() ?? "";
        if (line.length === 0) {
          continue;
        }
        return extractLatestMessage(line);
      }
      return null;
    } finally {
      closeSync(fd);
    }
  }
}

export function extractLatestMessage(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object") {
        const msg = (parsed as Record<string, unknown>)["msg"];
        if (typeof msg === "string" && msg.length > 0) {
          return msg;
        }
      }
    } catch {
      /* not JSON, fall through */
    }
  }
  const gatewayPrefix = "[gateway] ";
  if (trimmed.startsWith(gatewayPrefix)) {
    return trimmed.slice(gatewayPrefix.length);
  }
  return trimmed;
}

export function truncatePreview(s: string, max = 80): string {
  if (s.length <= max) {
    return s;
  }
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}
