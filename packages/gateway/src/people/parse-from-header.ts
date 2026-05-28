import { normalizeEmail } from "./person-store.ts";

function isBareMailboxShape(s: string): boolean {
  if (s === "") {
    return false;
  }
  for (const c of s) {
    if (c === " " || c === "\t" || c === "\n" || c === "<" || c === ">") {
      return false;
    }
  }
  const at = s.indexOf("@");
  if (at <= 0) {
    return false;
  }
  if (s.slice(at + 1).includes("@")) {
    return false;
  }
  const domain = s.slice(at + 1);
  const dot = domain.indexOf(".");
  return dot > 0 && dot < domain.length - 1;
}

function tryParseNamedAngleMailbox(trimmed: string): { displayName: string; email: string } | null {
  if (!trimmed.endsWith(">")) {
    return null;
  }
  const close = trimmed.length - 1;
  const open = trimmed.lastIndexOf("<", close - 1);
  if (open <= 0) {
    return null;
  }
  const inner = trimmed.slice(open + 1, close).trim();
  if (!isBareMailboxShape(inner)) {
    return null;
  }
  const displayName = trimmed.slice(0, open).trim();
  if (displayName === "") {
    return null;
  }
  return { displayName, email: inner };
}

function extractFirstAngleBracketEmail(trimmed: string): string | null {
  let searchFrom = 0;
  while (true) {
    const open = trimmed.indexOf("<", searchFrom);
    if (open === -1) {
      return null;
    }
    const close = trimmed.indexOf(">", open + 1);
    if (close === -1) {
      return null;
    }
    const inner = trimmed.slice(open + 1, close).trim();
    if (!inner.includes("<") && !inner.includes(">") && isBareMailboxShape(inner)) {
      return inner;
    }
    searchFrom = open + 1;
  }
}

export function parseFromHeaderForPerson(raw: string | null | undefined): {
  email?: string;
  displayName?: string;
} {
  if (raw === null || raw === undefined) {
    return {};
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return {};
  }
  const named = tryParseNamedAngleMailbox(trimmed);
  if (named !== null) {
    const email = normalizeEmail(named.email);
    let displayName = named.displayName.replaceAll(/^["']|["']$/g, "").trim();
    if (displayName === "") {
      displayName = email;
    }
    return { email, displayName };
  }
  const angleEmail = extractFirstAngleBracketEmail(trimmed);
  if (angleEmail !== null) {
    return { email: normalizeEmail(angleEmail) };
  }
  if (isBareMailboxShape(trimmed)) {
    const email = normalizeEmail(trimmed);
    return { email, displayName: email };
  }
  return {};
}
