/**
 * The tag-stripped forms a broadcast scan also matches (never rendered or sent anywhere). Each
 * stripper is applied until the text stops changing and every pass is kept, so a tag split by
 * another tag is seen whole before a later pass removes it. Two tokenisations: innermost-first
 * (`<[^<>]*>`) and greedy (`<[^>]*>`, where `<x<y>` is one tag).
 *
 * The B3r remote-content detectors do NOT reuse this: a strip-and-match form is the shape of an
 * incomplete sanitizer (a tag rebuilt by a strip passes it), so they read the tokens of the
 * structural tokenizer (`markup-tokens.ts`) instead. Here it only ADDS matching forms.
 */
const TAG_STRIPPERS: ReadonlyArray<(text: string) => string> = [
  stripInnermostTags,
  stripGreedyTags,
];

/**
 * Removes every `<...>` run that holds no `<` (`<x<y>` removes only `<y>`), left to right, in one
 * linear pass (the equivalent `/<[^<>]*>/g` rescans to the end of the text from every `<` that has
 * no `>`).
 */
function stripInnermostTags(text: string): string {
  let out = "";
  let from = 0;
  let at = text.indexOf("<");
  while (at !== -1) {
    let stop = at + 1;
    while (stop < text.length && text[stop] !== "<" && text[stop] !== ">") stop++;
    if (text[stop] !== ">") {
      // No run starts at `at`; the next candidate is the `<` that stopped the scan.
      at = text[stop] === "<" ? stop : -1;
      continue;
    }
    out += text.slice(from, at);
    from = stop + 1;
    at = text.indexOf("<", from);
  }
  return out + text.slice(from);
}

/**
 * Removes every `<...>` run to the first `>` (`<x<y>` is one tag), left to right, in one linear
 * pass (the equivalent `/<[^>]*>/g` rescans from every `<` that has no `>`).
 */
function stripGreedyTags(text: string): string {
  let out = "";
  let from = 0;
  let at = text.indexOf("<");
  while (at !== -1) {
    const close = text.indexOf(">", at + 1);
    if (close === -1) break;
    out += text.slice(from, at);
    from = close + 1;
    at = text.indexOf("<", from);
  }
  return out + text.slice(from);
}

export function tagStrippedForms(text: string): string[] {
  const out: string[] = [];
  for (const strip of TAG_STRIPPERS) {
    let prev = text;
    for (;;) {
      const next = strip(prev);
      if (next === prev) break;
      out.push(next);
      prev = next;
    }
  }
  return out;
}
