export function stripHtmlTagsToSpaces(input: string): string {
  let out = "";
  let inTag = false;
  for (const c of input) {
    if (inTag) {
      if (c === ">") {
        inTag = false;
        out += " ";
      }
      continue;
    }
    if (c === "<") {
      inTag = true;
      continue;
    }
    out += c;
  }
  return out;
}

export function collapseWhitespace(input: string): string {
  let out = "";
  let prevWasWs = false;
  for (const c of input) {
    const ws = /\s/u.test(c);
    if (ws) {
      if (!prevWasWs) {
        out += " ";
        prevWasWs = true;
      }
    } else {
      prevWasWs = false;
      out += c;
    }
  }
  return out.trim();
}

export function plainTextPreviewFromHtml(raw: string, maxLen: number): string {
  const plain = collapseWhitespace(stripHtmlTagsToSpaces(raw));
  return plain.length > maxLen ? plain.slice(0, maxLen) : plain;
}
