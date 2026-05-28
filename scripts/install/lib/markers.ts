export const BEGIN_MARKER = "# >>> nimbus PATH >>>";
export const END_MARKER = "# <<< nimbus PATH <<<";

export function buildMarkerBlock(installDir: string): string {
  if (installDir.includes('"')) {
    throw new Error("install dir must not contain a double-quote character");
  }
  return [BEGIN_MARKER, `export PATH="${installDir}:$PATH"`, END_MARKER].join("\n");
}

export function stripMarkerBlock(content: string): string {
  const beginIndex = content.indexOf(BEGIN_MARKER);
  if (beginIndex === -1) {
    return content;
  }
  const endIndex = content.indexOf(END_MARKER, beginIndex);
  if (endIndex === -1) {
    return content;
  }
  const beginLineStart = content.lastIndexOf("\n", beginIndex - 1) + 1;
  const endLineEnd = content.indexOf("\n", endIndex + END_MARKER.length);
  const cutEnd = endLineEnd === -1 ? content.length : endLineEnd + 1;
  return content.slice(0, beginLineStart) + content.slice(cutEnd);
}
